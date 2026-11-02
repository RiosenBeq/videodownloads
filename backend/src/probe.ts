/**
 * Inspect a media URL without downloading it: size and type for direct files,
 * variants/duration/protection for HLS and DASH, formats via yt-dlp for pages.
 */
import {
  REASONS,
  describeDash,
  describeHlsMedia,
  matchesAnyDomain,
  normalizeMime,
  parseM3u8,
  parseMpd,
  variantsFromHlsMaster,
  type BackendSettings,
  type DependencyStatus,
  type ProbeRequest,
  type ProbeResult,
} from '@clipkeeper/shared';
import { AppError, HttpStatusError } from './errors';
import type { UrlPolicy } from './net/policy';
import { responseTotalSize, safeFetchText, safeRequest } from './net/safeRequest';
import { variantsFromYtDlp, ytDlpProbe } from './jobs/ytdlp';

export interface ProbeContext {
  policy: UrlPolicy;
  settings: BackendSettings;
  deps: DependencyStatus;
  signal?: AbortSignal;
}

async function probeDirect(req: ProbeRequest, ctx: ProbeContext): Promise<ProbeResult> {
  let res = await safeRequest(req.url, { policy: ctx.policy, method: 'HEAD', referer: req.pageUrl, signal: ctx.signal, timeoutMs: 15_000 });
  res.body.resume();
  if (res.statusCode === 405 || res.statusCode === 501) {
    res = await safeRequest(req.url, { policy: ctx.policy, range: 'bytes=0-0', referer: req.pageUrl, signal: ctx.signal, timeoutMs: 15_000 });
    res.body.destroy();
  }
  if (res.statusCode >= 400) throw new HttpStatusError(res.statusCode, res.url);
  const mime = normalizeMime(res.headers['content-type']);
  if (/^text\/html/.test(mime)) {
    return { kind: 'direct', availability: 'unsupported', reason: 'The link points to a web page, not a video file.', variants: [] };
  }
  return { kind: 'direct', availability: 'available', sizeBytes: responseTotalSize(res), mimeType: mime || undefined, variants: [] };
}

async function probeHls(req: ProbeRequest, ctx: ProbeContext): Promise<ProbeResult> {
  const fetchOpts = { policy: ctx.policy, referer: req.pageUrl, signal: ctx.signal };
  const { text, url } = await safeFetchText(req.url, fetchOpts);
  const playlist = parseM3u8(text, url);
  if (playlist.type === 'media') {
    const d = describeHlsMedia(playlist);
    return { kind: 'hls', ...d, variants: [] };
  }
  if (playlist.encrypted) return { kind: 'hls', availability: 'drm', reason: REASONS.encrypted, variants: [] };
  const variants = variantsFromHlsMaster(playlist);
  if (!variants.length) return { kind: 'hls', availability: 'unsupported', reason: 'No video variants found.', variants };
  // Inspect the best variant: encryption and live state are declared per media playlist.
  const media = parseM3u8((await safeFetchText(variants[0].url!, fetchOpts)).text, variants[0].url!);
  if (media.type !== 'media') return { kind: 'hls', availability: 'unsupported', reason: 'Nested master playlists are not supported.', variants: [] };
  const d = describeHlsMedia(media);
  const withSizes = variantsFromHlsMaster(playlist, d.durationSec);
  return {
    kind: 'hls',
    ...d,
    variants: withSizes,
    width: withSizes[0]?.width,
    height: withSizes[0]?.height,
    sizeBytes: withSizes[0]?.sizeBytes,
    sizeEstimated: true,
  };
}

async function probeDash(req: ProbeRequest, ctx: ProbeContext): Promise<ProbeResult> {
  const { text, url } = await safeFetchText(req.url, { policy: ctx.policy, referer: req.pageUrl, signal: ctx.signal });
  const d = describeDash(parseMpd(text, url));
  return {
    kind: 'dash',
    ...d,
    width: d.variants[0]?.width,
    height: d.variants[0]?.height,
    sizeBytes: d.variants[0]?.sizeBytes,
    sizeEstimated: true,
  };
}

async function probePage(req: ProbeRequest, ctx: ProbeContext): Promise<ProbeResult> {
  if (!ctx.settings.ytDlpEnabled) throw new AppError('YTDLP_DISABLED', 'yt-dlp support is turned off in settings.');
  const host = new URL(req.url).hostname;
  if (!matchesAnyDomain(host, ctx.settings.ytDlpDomains)) {
    throw new AppError('YTDLP_DISABLED', `${host} is not in your list of domains allowed for yt-dlp.`);
  }
  if (!ctx.deps.ytDlp.found || !ctx.deps.ytDlp.path) throw new AppError('DEPENDENCY_MISSING', 'yt-dlp is not installed.');
  const info = await ytDlpProbe(ctx.deps.ytDlp.path, req.url, ctx.signal);
  const live = info.is_live || info.live_status === 'is_live';
  const variants = variantsFromYtDlp(info);
  const drmOnly = !variants.length && (info.formats ?? []).some((f) => f.has_drm);
  return {
    kind: 'page',
    availability: live ? 'live' : drmOnly ? 'drm' : variants.length ? 'needs-backend' : 'unsupported',
    reason: live ? REASONS.live : drmOnly ? REASONS.drm : undefined,
    title: info.title,
    durationSec: info.duration,
    isLive: live,
    width: variants[0]?.width,
    height: variants[0]?.height,
    sizeBytes: variants[0]?.sizeBytes,
    sizeEstimated: variants[0]?.sizeEstimated,
    variants,
  };
}

export async function probeMedia(req: ProbeRequest, ctx: ProbeContext): Promise<ProbeResult> {
  ctx.policy.assertUrl(req.url);
  switch (req.kind) {
    case 'direct':
      return probeDirect(req, ctx);
    case 'hls':
      return probeHls(req, ctx);
    case 'dash':
      return probeDash(req, ctx);
    case 'page':
      return probePage(req, ctx);
  }
}
