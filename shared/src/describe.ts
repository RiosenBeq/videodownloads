/**
 * Turns parsed manifests into user-facing variants and availability. Shared so
 * the extension's quick probe and the helper's probe always agree.
 */
import type { DashManifest } from './dash';
import { formatBitrate, resolutionLabel } from './format';
import type { HlsMasterPlaylist, HlsMediaPlaylist } from './hls';
import { sortVariantsByQuality } from './quality';
import { hashString } from './url';
import type { Availability, ContainerFormat, VideoVariant } from './types';

export const REASONS = {
  drm: 'This video is protected by DRM. Clipkeeper does not download DRM-protected or encrypted content.',
  encrypted: 'This stream is encrypted. Clipkeeper does not download encrypted or DRM-protected streams.',
  live: 'This is a live stream. Live recording is not supported.',
  blob:
    'This video is streamed through Media Source Extensions (a blob: URL) and cannot be saved directly. ' +
    'If the page loads an HLS or DASH manifest, it is listed separately and can be saved with the local helper.',
  needsBackend: 'Streaming formats (HLS/DASH) are saved by the local helper, which merges segments with FFmpeg.',
  noSegments: 'The manifest does not describe downloadable segments.',
  multiPeriod: 'Multi-period DASH manifests are not supported.',
} as const;

export interface StreamDescription {
  availability: Availability;
  reason?: string;
  durationSec?: number;
  isLive?: boolean;
  variants: VideoVariant[];
}

function estimateSize(bandwidth: number | undefined, durationSec: number | undefined): number | undefined {
  if (!bandwidth || !durationSec) return undefined;
  return Math.round((bandwidth * durationSec) / 8);
}

function label(height: number | undefined, width: number | undefined, bandwidth: number | undefined): string {
  const res = resolutionLabel(height, width);
  const rate = formatBitrate(bandwidth);
  if (res && rate) return `${res} · ${rate}`;
  return res || rate || 'Default';
}

export function variantsFromHlsMaster(master: HlsMasterPlaylist, durationSec?: number): VideoVariant[] {
  const seen = new Set<string>();
  const variants: VideoVariant[] = [];
  for (const v of master.variants) {
    // Audio-only variants are skipped; we always pair video with its audio group.
    if (v.codecs && !/avc|hvc|hev|vp0?9|av01|dvh/i.test(v.codecs) && !v.height) continue;
    if (seen.has(v.uri)) continue;
    seen.add(v.uri);
    const bandwidth = v.averageBandwidth ?? v.bandwidth;
    variants.push({
      id: `h_${hashString(v.uri)}`,
      label: label(v.height, v.width, bandwidth),
      width: v.width,
      height: v.height,
      bandwidth,
      codecs: v.codecs,
      url: v.uri,
      container: 'mp4',
      sizeBytes: estimateSize(bandwidth, durationSec),
      sizeEstimated: true,
    });
  }
  return sortVariantsByQuality(variants);
}

export function describeHlsMedia(media: HlsMediaPlaylist): Omit<StreamDescription, 'variants'> {
  if (media.encrypted) return { availability: 'drm', reason: REASONS.encrypted };
  if (!media.endList) return { availability: 'live', reason: REASONS.live, isLive: true };
  if (!media.segments.length) return { availability: 'unsupported', reason: REASONS.noSegments };
  return { availability: 'needs-backend', reason: REASONS.needsBackend, durationSec: media.totalDuration };
}

export function containerForCodecs(videoCodecs?: string): ContainerFormat {
  return /vp0?9|vp8|av01/i.test(videoCodecs ?? '') ? 'webm' : 'mp4';
}

export function describeDash(manifest: DashManifest): StreamDescription {
  const durationSec = manifest.durationSec;
  if (manifest.protected) return { availability: 'drm', reason: REASONS.drm, variants: [], durationSec };
  if (manifest.type === 'dynamic') return { availability: 'live', reason: REASONS.live, isLive: true, variants: [], durationSec };
  if (manifest.periodCount > 1) return { availability: 'unsupported', reason: REASONS.multiPeriod, variants: [], durationSec };

  const audio = manifest.representations
    .filter((r) => r.contentType === 'audio' && r.plan)
    .sort((a, b) => (b.bandwidth ?? 0) - (a.bandwidth ?? 0))[0];
  const variants: VideoVariant[] = manifest.representations
    .filter((r) => r.contentType === 'video' && r.plan)
    .map((r) => {
      const total = (r.bandwidth ?? 0) + (audio?.bandwidth ?? 0);
      return {
        id: r.id,
        label: label(r.height, r.width, r.bandwidth),
        width: r.width,
        height: r.height,
        bandwidth: r.bandwidth,
        codecs: r.codecs,
        container: containerForCodecs(r.codecs),
        sizeBytes: estimateSize(total || undefined, durationSec),
        sizeEstimated: true,
      };
    });

  if (!variants.length) return { availability: 'unsupported', reason: REASONS.noSegments, variants, durationSec };
  return { availability: 'needs-backend', reason: REASONS.needsBackend, variants: sortVariantsByQuality(variants), durationSec };
}
