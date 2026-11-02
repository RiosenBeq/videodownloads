/**
 * FFmpeg remux/merge of locally downloaded streams. FFmpeg is restricted to the
 * file protocol, so it can never be used to reach the network.
 */
import fs from 'node:fs/promises';
import { AppError } from '../errors';
import { runProcess } from '../process';

export interface RemuxOptions {
  ffmpeg: string;
  /** First input is the video (may also carry audio); optional second input is audio. */
  inputs: string[];
  output: string;
  container: 'mp4' | 'webm' | 'mkv';
  signal?: AbortSignal;
  durationSec?: number;
  onProgress?: (ratio: number) => void;
}

export function buildRemuxArgs(options: Pick<RemuxOptions, 'inputs' | 'output' | 'container'>): string[] {
  const args = ['-hide_banner', '-nostdin', '-loglevel', 'error', '-y'];
  for (const input of options.inputs) args.push('-protocol_whitelist', 'file,pipe', '-i', input);
  if (options.inputs.length > 1) {
    args.push('-map', '0:v:0?', '-map', '1:a:0?');
  } else {
    args.push('-map', '0:v?', '-map', '0:a?');
  }
  args.push('-c', 'copy');
  if (options.container === 'mp4') args.push('-movflags', '+faststart');
  args.push('-progress', 'pipe:1', '-nostats', options.output);
  return args;
}

async function runRemux(options: RemuxOptions): Promise<void> {
  const result = await runProcess(options.ffmpeg, buildRemuxArgs(options), {
    signal: options.signal,
    onStdoutLine: (line) => {
      const m = /^out_time_us=(\d+)/.exec(line);
      if (m && options.durationSec) options.onProgress?.(Math.min(1, Number(m[1]) / 1e6 / options.durationSec));
    },
  });
  if (result.code !== 0) {
    const detail = result.stderrTail.trim().split(/\r?\n/).slice(-2).join(' ');
    throw new AppError('INTERNAL', `FFmpeg could not merge the stream${detail ? `: ${detail}` : '.'}`);
  }
}

/**
 * Remux into the requested container, falling back to Matroska when the codecs
 * do not fit (e.g. VP9 video with AAC audio). Returns the file and container used.
 */
export async function remux(options: RemuxOptions): Promise<{ output: string; container: RemuxOptions['container'] }> {
  try {
    await runRemux(options);
    return { output: options.output, container: options.container };
  } catch (error) {
    if (options.signal?.aborted || options.container === 'mkv') throw error;
    await fs.rm(options.output, { force: true });
    const output = options.output.replace(/\.[a-z0-9]+$/i, '.mkv');
    await runRemux({ ...options, output, container: 'mkv' });
    return { output, container: 'mkv' };
  }
}
