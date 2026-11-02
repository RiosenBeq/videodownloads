/**
 * yt-dlp integration (opt-in). The argument vector is fixed apart from the
 * validated URL, format selector and output name; user/global yt-dlp config
 * files are ignored so options such as --exec or cookie files never apply.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  formatBitrate,
  resolutionLabel,
  sanitizeFilename,
  sortVariantsByQuality,
  type ContainerPreference,
  type QualityPreference,
  type VideoVariant,
} from '@clipkeeper/shared';
import { AppError } from '../errors';
import { exists } from '../fs/files';
import { runProcess } from '../process';
import type { Runner, RunnerContext } from './types';

const BASE_ARGS = ['--ignore-config', '--no-playlist', '--no-exec', '--no-cookies', '--newline'];

export function ytDlpFormatSelector(quality: QualityPreference = 'highest', container: ContainerPreference = 'any'): string {
  if (quality === 'lowest') return 'wv*+wa/w';
  const h = quality === 'highest' ? '' : `[height<=${quality}]`;
  const preferred =
    container === 'mp4'
      ? `bv*${h}[ext=mp4]+ba[ext=m4a]/b${h}[ext=mp4]/`
      : container === 'webm'
        ? `bv*${h}[ext=webm]+ba[ext=webm]/b${h}[ext=webm]/`
        : '';
  return `${preferred}bv*${h}+ba/b${h}/b`;
}

function classifyFailure(stderr: string): AppError {
  const line =
    stderr
      .split(/\r?\n/)
      .reverse()
      .find((l) => l.startsWith('ERROR')) ?? stderr.trim().split(/\r?\n/).pop() ?? 'yt-dlp failed';
  const message = line.replace(/^ERROR:\s*/, '').slice(0, 400);
  if (/drm/i.test(message)) return new AppError('DRM_PROTECTED', 'yt-dlp reports this video is DRM protected; it will not be downloaded.');
  if (/unsupported url/i.test(message)) return new AppError('UNSUPPORTED', 'yt-dlp does not support this page.');
  if (/is live|live event|premieres/i.test(message)) return new AppError('LIVE_UNSUPPORTED', 'Live streams are not supported.');
  if (/sign in|log ?in|private video|members|age/i.test(message)) {
    return new AppError('UNSUPPORTED', `${message} — the helper does not use your accounts or cookies.`);
  }
  return new AppError('NETWORK', `yt-dlp: ${message}`, undefined, /timed out|connection|reset|503|502/i.test(message));
}

interface YtFormat {
  format_id?: string;
  ext?: string;
  width?: number;
  height?: number;
  vcodec?: string;
  acodec?: string;
  tbr?: number;
  filesize?: number;
  filesize_approx?: number;
  has_drm?: boolean | string;
}

export interface YtDlpInfo {
  title?: string;
  duration?: number;
  is_live?: boolean;
  live_status?: string;
  width?: number;
  height?: number;
  formats?: YtFormat[];
}

export async function ytDlpProbe(bin: string, url: string, signal?: AbortSignal): Promise<YtDlpInfo> {
  const result = await runProcess(bin, [...BASE_ARGS, '-J', '--no-warnings', '--', url], { signal, timeoutMs: 60_000 });
  if (result.code !== 0) throw classifyFailure(result.stderrTail);
  try {
    return JSON.parse(result.stdout) as YtDlpInfo;
  } catch {
    throw new AppError('INTERNAL', 'yt-dlp returned unreadable metadata.');
  }
}

export function variantsFromYtDlp(info: YtDlpInfo): VideoVariant[] {
  const byHeight = new Map<number, YtFormat>();
  const bestAudio = (info.formats ?? [])
    .filter((f) => f.vcodec === 'none' && f.acodec && f.acodec !== 'none' && !f.has_drm)
    .sort((a, b) => (b.tbr ?? 0) - (a.tbr ?? 0))[0];
  for (const f of info.formats ?? []) {
    if (!f.format_id || !f.height || !f.vcodec || f.vcodec === 'none' || f.has_drm) continue;
    const current = byHeight.get(f.height);
    if (!current || (f.tbr ?? 0) > (current.tbr ?? 0)) byHeight.set(f.height, f);
  }
  const variants = [...byHeight.values()].map((f) => {
    const videoOnly = !f.acodec || f.acodec === 'none';
    const size = (f.filesize ?? f.filesize_approx ?? 0) + (videoOnly ? bestAudio?.filesize ?? bestAudio?.filesize_approx ?? 0 : 0);
    const bandwidth = f.tbr ? Math.round(f.tbr * 1000) : undefined;
    return {
      id: f.format_id!,
      label: [resolutionLabel(f.height, f.width), (f.ext ?? '').toUpperCase(), formatBitrate(bandwidth)].filter(Boolean).join(' · '),
      width: f.width,
      height: f.height,
      bandwidth,
      container: f.ext === 'webm' ? 'webm' : 'mp4',
      sizeBytes: size || undefined,
      sizeEstimated: !f.filesize,
      formatId: videoOnly ? `${f.format_id}+ba/${f.format_id}` : f.format_id,
    } satisfies VideoVariant;
  });
  return sortVariantsByQuality(variants);
}

async function uniqueBase(dir: string, base: string): Promise<string> {
  for (let i = 0; i < 1000; i++) {
    const candidate = i === 0 ? base : `${base} (${i})`;
    const taken = await Promise.all(['mp4', 'webm', 'mkv', 'm4a'].map((ext) => exists(path.join(dir, `${candidate}.${ext}`))));
    if (!taken.some(Boolean)) return candidate;
  }
  throw new AppError('FILESYSTEM', 'Could not find a free file name.');
}

export class YtDlpRunner implements Runner {
  private outputBase?: string;

  async run(ctx: RunnerContext): Promise<string> {
    const bin = ctx.deps.ytDlp.path;
    if (!ctx.deps.ytDlp.found || !bin) throw new AppError('DEPENDENCY_MISSING', 'yt-dlp is not installed.');
    const downloadDir = ctx.settings.downloadDir;
    await fs.mkdir(downloadDir, { recursive: true });

    const stem = sanitizeFilename(ctx.job.filename.replace(/\.[a-z0-9]{2,5}$/i, ''));
    this.outputBase ??= await uniqueBase(downloadDir, stem);
    const format = ctx.request.formatId ?? ytDlpFormatSelector(ctx.request.quality, ctx.request.container);

    const args = [
      ...BASE_ARGS,
      '--progress',
      '--no-simulate',
      '--no-mtime',
      '--print',
      'after_move:CKFILE %(filepath)s',
      '--progress-template',
      'download:CKPROG %(progress.downloaded_bytes)s %(progress.total_bytes)s %(progress.total_bytes_estimate)s %(progress.speed)s',
      '-f',
      format,
      '-P',
      downloadDir,
      '-P',
      `temp:${ctx.workDir}`,
      '-o',
      `${this.outputBase.replace(/%/g, '%%')}.%(ext)s`,
      ...(ctx.deps.ffmpeg.found && ctx.deps.ffmpeg.path ? ['--ffmpeg-location', ctx.deps.ffmpeg.path] : []),
      '--',
      ctx.request.url,
    ];

    let finalPath: string | undefined;
    let completedParts = 0;
    let partTotal = 0;
    let lastDownloaded = 0;
    const num = (v: string | undefined) => (v && v !== 'NA' && v !== 'None' ? Number(v) : undefined);

    const result = await runProcess(bin, args, {
      signal: ctx.signal,
      onStdoutLine: (line) => {
        if (line.startsWith('CKFILE ')) {
          finalPath = line.slice(7).trim();
          return;
        }
        if (line.startsWith('CKPROG ')) {
          const [, d, t, te] = line.split(' ');
          const downloaded = num(d) ?? 0;
          const total = num(t) ?? num(te);
          if (downloaded < lastDownloaded) completedParts += partTotal; // next format (e.g. audio) started
          lastDownloaded = downloaded;
          partTotal = total ?? partTotal;
          ctx.update({
            bytesDownloaded: completedParts + downloaded,
            totalBytes: total ? completedParts + total : undefined,
            totalEstimated: !num(t),
            phase: undefined,
          });
          return;
        }
        if (line.startsWith('[Merger]') || line.startsWith('[VideoRemuxer]') || line.startsWith('[FixupM3u8]')) {
          ctx.update({ status: 'merging', phase: 'Merging with FFmpeg' });
        }
      },
    });

    if (result.code !== 0) throw classifyFailure(result.stderrTail);
    if (!finalPath || !(await exists(finalPath))) throw new AppError('INTERNAL', 'yt-dlp finished but the output file was not found.');
    const rel = path.relative(downloadDir, finalPath);
    if (rel.startsWith('..') || path.isAbsolute(rel)) throw new AppError('FORBIDDEN', 'yt-dlp wrote outside the download folder.');
    ctx.update({ filename: path.basename(finalPath) });
    return finalPath;
  }
}
