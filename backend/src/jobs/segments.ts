/**
 * Concurrent, resumable segment downloader shared by the HLS and DASH runners.
 * Each segment is written to "<file>.tmp" and renamed when complete, so a
 * paused or interrupted job resumes by skipping files that already exist.
 */
import { createWriteStream } from 'node:fs';
import fs from 'node:fs/promises';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { AppError, HttpStatusError } from '../errors';
import { fileSize } from '../fs/files';
import { safeRequest } from '../net/safeRequest';
import { withRetry } from './retry';
import type { RunnerContext } from './types';

export interface SegmentTask {
  url: string;
  /** Range header value, e.g. "bytes=0-999". */
  range?: string;
  file: string;
}

export function byteRangeHeader(offset: number, length: number): string {
  return `bytes=${offset}-${offset + length - 1}`;
}

export function countingStream(onBytes: (n: number) => void): Transform {
  return new Transform({
    transform(chunk: Buffer, _enc, callback) {
      onBytes(chunk.length);
      callback(null, chunk);
    },
  });
}

async function downloadOne(ctx: RunnerContext, task: SegmentTask, signal: AbortSignal, onBytes: (n: number) => void): Promise<number> {
  const res = await safeRequest(task.url, {
    policy: ctx.policy,
    range: task.range,
    referer: ctx.request.pageUrl,
    signal,
  });
  if (res.statusCode < 200 || res.statusCode >= 300) {
    res.body.resume();
    throw new HttpStatusError(res.statusCode, res.url);
  }
  if (task.range && res.statusCode !== 206) {
    res.body.resume();
    throw new AppError('UNSUPPORTED', 'The server ignored a byte-range request needed for this stream.');
  }
  const tmp = `${task.file}.tmp`;
  let received = 0;
  try {
    await pipeline(
      res.body,
      countingStream((n) => {
        received += n;
        onBytes(n);
      }),
      createWriteStream(tmp),
      { signal },
    );
  } catch (error) {
    onBytes(-received);
    throw error;
  }
  const expected = Number(res.headers['content-length']);
  if (Number.isFinite(expected) && expected > 0 && received < expected) {
    onBytes(-received);
    throw new AppError('NETWORK', 'Segment download was truncated.', undefined, true);
  }
  await fs.rename(tmp, task.file);
  return received;
}

export interface SegmentProgress {
  bytes: number;
  done: number;
  total: number;
}

/**
 * Download all tasks with bounded concurrency. Progress is reported as
 * cumulative bytes (including segments finished in a previous run).
 */
export async function downloadSegments(
  ctx: RunnerContext,
  tasks: SegmentTask[],
  onProgress: (p: SegmentProgress) => void,
): Promise<void> {
  let bytes = 0;
  let done = 0;
  const pending: SegmentTask[] = [];
  for (const task of tasks) {
    const size = await fileSize(task.file);
    if (size > 0) {
      bytes += size;
      done++;
    } else {
      pending.push(task);
    }
  }
  onProgress({ bytes, done, total: tasks.length });

  const failure = new AbortController();
  const signal = AbortSignal.any([ctx.signal, failure.signal]);
  let cursor = 0;
  let firstError: unknown;
  const concurrency = Math.max(1, Math.min(ctx.settings.segmentConcurrency, pending.length));

  const worker = async () => {
    while (cursor < pending.length && !signal.aborted) {
      const task = pending[cursor++];
      try {
        await withRetry(
          () =>
            downloadOne(ctx, task, signal, (n) => {
              bytes += n;
              onProgress({ bytes, done, total: tasks.length });
            }),
          {
            retries: ctx.settings.maxRetries,
            signal,
            onRetry: (attempt) => ctx.update({ retryCount: ctx.job.retryCount + 1, phase: `Retrying a segment (attempt ${attempt})` }),
          },
        );
        done++;
        onProgress({ bytes, done, total: tasks.length });
      } catch (error) {
        firstError ??= error;
        failure.abort(error);
        return;
      }
    }
  };

  await Promise.allSettled(Array.from({ length: concurrency }, worker));
  if (ctx.signal.aborted) throw ctx.signal.reason;
  if (firstError) throw firstError;
}
