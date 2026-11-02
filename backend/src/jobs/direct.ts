/**
 * Direct file download with HTTP Range resume. Pausing keeps the partial file;
 * resuming (or retrying after a network error) continues from its size.
 */
import { createWriteStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { DIRECT_VIDEO_EXTENSIONS, DIRECT_VIDEO_MIME, getUrlExtension, normalizeMime } from '@clipkeeper/shared';
import { AppError, HttpStatusError, isRetryable } from '../errors';
import { fileSize } from '../fs/files';
import { parseContentRange, responseTotalSize, safeRequest } from '../net/safeRequest';
import { backoffDelay, sleep } from './retry';
import { countingStream } from './segments';
import type { Runner, RunnerContext } from './types';

const NON_VIDEO_TYPES = /^(text\/|application\/(json|xml|xhtml\+xml|javascript))/;

export function extensionFor(url: string, contentType: string | undefined): string {
  const ext = getUrlExtension(url);
  if (ext && ext in DIRECT_VIDEO_EXTENSIONS) return ext === 'ogv' ? 'ogv' : ext;
  const container = DIRECT_VIDEO_MIME[normalizeMime(contentType)];
  if (container && container !== 'unknown') return container === 'ogg' ? 'ogv' : container;
  return 'mp4';
}

export class DirectRunner implements Runner {
  async run(ctx: RunnerContext): Promise<string> {
    const part = path.join(ctx.workDir, 'download.part');
    let extension = 'mp4';
    let attempt = 0;
    let knownTotal = ctx.job.totalBytes;

    for (;;) {
      try {
        let offset = await fileSize(part);
        const res = await safeRequest(ctx.request.url, {
          policy: ctx.policy,
          range: offset > 0 ? `bytes=${offset}-` : undefined,
          referer: ctx.request.pageUrl,
          signal: ctx.signal,
        });

        if (res.statusCode === 416 && offset > 0) {
          res.body.resume();
          if (knownTotal && offset >= knownTotal) break;
          await fs.rm(part, { force: true });
          continue;
        }
        if (res.statusCode < 200 || res.statusCode >= 300) {
          res.body.resume();
          throw new HttpStatusError(res.statusCode, res.url);
        }
        const contentType = normalizeMime(res.headers['content-type']);
        if (NON_VIDEO_TYPES.test(contentType)) {
          res.body.resume();
          throw new AppError(
            'NOT_VIDEO',
            'The server returned a web page instead of a video file. The link may have expired or may require signing in.',
          );
        }
        extension = extensionFor(res.url, contentType);

        if (res.statusCode === 206) {
          const range = parseContentRange(res.headers['content-range']);
          if (!range || range.start !== offset) {
            res.body.resume();
            await fs.rm(part, { force: true });
            throw new AppError('NETWORK', 'The server returned an unexpected byte range.', undefined, true);
          }
        } else if (offset > 0) {
          // Server does not support resume: start over.
          offset = 0;
        }
        knownTotal = responseTotalSize(res) ?? knownTotal;
        ctx.update({ totalBytes: knownTotal, totalEstimated: false, bytesDownloaded: offset, phase: undefined });

        let downloaded = offset;
        await pipeline(
          res.body,
          countingStream((n) => {
            downloaded += n;
            ctx.update({ bytesDownloaded: downloaded });
          }),
          createWriteStream(part, { flags: offset > 0 ? 'a' : 'w' }),
          { signal: ctx.signal },
        );

        const size = await fileSize(part);
        if (knownTotal && size < knownTotal) {
          throw new AppError('NETWORK', 'The connection closed before the file finished.', undefined, true);
        }
        break;
      } catch (error) {
        if (ctx.signal.aborted) throw ctx.signal.reason ?? error;
        if (!isRetryable(error) || attempt >= ctx.settings.maxRetries) throw error;
        attempt++;
        ctx.update({ retryCount: ctx.job.retryCount + 1, phase: `Connection lost — retrying (${attempt}/${ctx.settings.maxRetries})` });
        await sleep(backoffDelay(attempt), ctx.signal);
      }
    }

    return ctx.finalize(part, extension);
  }
}
