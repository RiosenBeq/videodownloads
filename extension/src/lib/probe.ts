/**
 * Quick, local inspection of detected media from the service worker: manifest
 * variants, duration, live/encryption status and file sizes. Runs entirely in
 * the browser; nothing is sent anywhere except the media host itself.
 */
import { describeDash, describeHlsMedia, REASONS, variantsFromHlsMaster } from '@clipkeeper/shared/describe';
import { parseMpd } from '@clipkeeper/shared/dash';
import { parseM3u8 } from '@clipkeeper/shared/hls';
import type { DetectedVideo } from '@clipkeeper/shared/types';

export interface ProbeOutcome {
  patch: Partial<DetectedVideo>;
  /** URLs of variant/rendition playlists that belong to this master. */
  childUrls: string[];
}

const MAX_MANIFEST_BYTES = 10 * 1024 * 1024;

async function fetchText(url: string, signal: AbortSignal): Promise<{ text: string; url: string }> {
  const res = await fetch(url, { credentials: 'include', cache: 'no-store', signal });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const length = Number(res.headers.get('content-length'));
  if (length > MAX_MANIFEST_BYTES) throw new Error('Manifest too large');
  const text = await res.text();
  if (text.length > MAX_MANIFEST_BYTES) throw new Error('Manifest too large');
  return { text, url: res.url || url };
}

async function probeHls(video: DetectedVideo, signal: AbortSignal): Promise<ProbeOutcome> {
  const { text, url } = await fetchText(video.url, signal);
  const playlist = parseM3u8(text, url);
  if (playlist.type === 'media') {
    const d = describeHlsMedia(playlist);
    return { patch: { availability: d.availability, availabilityReason: d.reason, durationSec: d.durationSec, isLive: d.isLive }, childUrls: [] };
  }
  const childUrls = [...playlist.variants.map((v) => v.uri), ...playlist.renditions.flatMap((r) => (r.uri ? [r.uri] : []))];
  if (playlist.encrypted) return { patch: { availability: 'drm', availabilityReason: REASONS.encrypted }, childUrls };
  let variants = variantsFromHlsMaster(playlist);
  if (!variants.length) return { patch: { availability: 'unsupported', availabilityReason: 'No video variants found.' }, childUrls };

  const best = variants[0];
  const media = parseM3u8((await fetchText(best.url!, signal)).text, best.url!);
  if (media.type !== 'media') return { patch: { variants }, childUrls };
  const d = describeHlsMedia(media);
  variants = variantsFromHlsMaster(playlist, d.durationSec);
  return {
    patch: {
      availability: d.availability,
      availabilityReason: d.reason,
      durationSec: d.durationSec,
      isLive: d.isLive,
      variants,
      width: variants[0].width,
      height: variants[0].height,
      sizeBytes: variants[0].sizeBytes,
      sizeEstimated: true,
    },
    childUrls,
  };
}

async function probeDash(video: DetectedVideo, signal: AbortSignal): Promise<ProbeOutcome> {
  const { text, url } = await fetchText(video.url, signal);
  const d = describeDash(parseMpd(text, url));
  return {
    patch: {
      availability: d.availability,
      availabilityReason: d.reason,
      durationSec: d.durationSec,
      isLive: d.isLive,
      variants: d.variants,
      width: d.variants[0]?.width,
      height: d.variants[0]?.height,
      sizeBytes: d.variants[0]?.sizeBytes,
      sizeEstimated: true,
    },
    childUrls: [],
  };
}

async function probeDirect(video: DetectedVideo, signal: AbortSignal): Promise<ProbeOutcome> {
  if (video.sizeBytes) return { patch: {}, childUrls: [] };
  const res = await fetch(video.url, { method: 'HEAD', credentials: 'include', cache: 'no-store', signal });
  const size = Number(res.headers.get('content-length'));
  const type = res.headers.get('content-type') ?? undefined;
  return {
    patch: { sizeBytes: res.ok && size > 0 ? size : undefined, mimeType: video.mimeType ?? type },
    childUrls: [],
  };
}

export async function probeVideo(video: DetectedVideo, timeoutMs = 15_000): Promise<ProbeOutcome> {
  const signal = AbortSignal.timeout(timeoutMs);
  try {
    let outcome: ProbeOutcome;
    if (video.kind === 'hls') outcome = await probeHls(video, signal);
    else if (video.kind === 'dash') outcome = await probeDash(video, signal);
    else if (video.kind === 'direct') outcome = await probeDirect(video, signal);
    else outcome = { patch: {}, childUrls: [] };
    outcome.patch.probed = true;
    outcome.patch.probeError = undefined;
    return outcome;
  } catch (error) {
    return { patch: { probed: true, probeError: (error as Error).message || 'Could not inspect this stream' }, childUrls: [] };
  }
}
