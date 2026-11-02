/**
 * Per-tab registry of detected videos. Pure functions build and merge
 * DetectedVideo records; TabRegistry persists them in chrome.storage.session
 * (survives service-worker restarts, cleared when the browser closes).
 */
import { REASONS } from '@clipkeeper/shared/describe';
import { formatBitrate, resolutionLabel } from '@clipkeeper/shared/format';
import { sortVariantsByQuality } from '@clipkeeper/shared/quality';
import type { ContainerFormat, DetectedVideo, DetectionOrigin, VideoVariant } from '@clipkeeper/shared/types';
import {
  classifyMediaUrl,
  containerFromMime,
  getSiteName,
  hashString,
  isBlobUrl,
  isHttpUrl,
  safeParseUrl,
  videoIdForUrl,
} from '@clipkeeper/shared/url';
import type { ContentVideo } from './messages';

export interface TabState {
  tabId: number;
  pageUrl: string;
  pageTitle: string;
  videos: Record<string, DetectedVideo>;
  /** Video ids last reported by each frame's content script. */
  frames: Record<string, string[]>;
  /** Variant/rendition playlist URL → id of the master playlist that lists it. */
  children: Record<string, string>;
  /** The page (some frame) uses EME/DRM. */
  drm: boolean;
  updatedAt: number;
}

export function emptyTabState(tabId: number, pageUrl = '', pageTitle = ''): TabState {
  return { tabId, pageUrl, pageTitle, videos: {}, frames: {}, children: {}, drm: false, updatedAt: Date.now() };
}

export const tabKey = (tabId: number) => `tab:${tabId}`;

function sourceHost(url: string): string {
  return isBlobUrl(url) ? getSiteName(url.slice(5)) : safeParseUrl(url)?.hostname ?? '';
}

function variantLabel(height: number | undefined, container: ContainerFormat | undefined, label?: string): string {
  const res = resolutionLabel(height);
  const fmt = container && container !== 'unknown' ? container.toUpperCase() : '';
  return [label && !/^\d+p?$/i.test(label) ? label : res, fmt].filter(Boolean).join(' · ') || 'Original';
}

/** Convert a content-script report entry into a DetectedVideo (or null to ignore). */
export function videoFromContent(item: ContentVideo, page: { pageUrl: string; pageTitle: string; frameUrl: string }): DetectedVideo | null {
  const url = item.url;
  if (!url || url.startsWith('data:')) return null;
  const now = Date.now();
  const base = {
    id: videoIdForUrl(url),
    url,
    title: item.title?.trim() || page.pageTitle || 'Untitled video',
    pageUrl: page.pageUrl,
    pageTitle: page.pageTitle,
    siteName: getSiteName(page.pageUrl),
    sourceHost: sourceHost(url),
    frameUrl: page.frameUrl !== page.pageUrl ? page.frameUrl : undefined,
    width: item.width || undefined,
    height: item.height || undefined,
    durationSec: item.durationSec && Number.isFinite(item.durationSec) ? item.durationSec : undefined,
    posterUrl: item.posterUrl && isHttpUrl(item.posterUrl) ? item.posterUrl : undefined,
    isLive: item.isLive || undefined,
    origins: [item.origin] as DetectionOrigin[],
    detectedAt: now,
  };

  if (isBlobUrl(url)) {
    return {
      ...base,
      kind: 'blob',
      container: 'unknown',
      availability: item.drm ? 'drm' : 'blob',
      availabilityReason: item.drm ? REASONS.drm : REASONS.blob,
    };
  }
  if (!isHttpUrl(url)) return null;

  const classified = classifyMediaUrl(url, item.type);
  // A <video src> without a recognisable extension is still a playable file.
  const kind = classified?.kind ?? (item.origin === 'dom' ? 'direct' : null);
  if (!kind) return null;
  const container = classified?.container ?? containerFromMime(item.type) ?? 'unknown';

  let variants: VideoVariant[] | undefined;
  if (kind === 'direct' && item.sources && item.sources.length > 1) {
    const seen = new Set<string>();
    variants = sortVariantsByQuality(
      item.sources
        .filter((s) => isHttpUrl(s.url) && classifyMediaUrl(s.url, s.type)?.kind !== 'hls' && !seen.has(s.url) && seen.add(s.url))
        .map((s) => {
          const c = classifyMediaUrl(s.url, s.type)?.container ?? containerFromMime(s.type) ?? 'unknown';
          return { id: `s_${hashString(s.url)}`, url: s.url, height: s.height, container: c, label: variantLabel(s.height, c, s.label) };
        }),
    );
    if (variants.length < 2) variants = undefined;
  }

  const live = item.isLive && kind !== 'direct';
  return {
    ...base,
    kind,
    container,
    variants,
    availability: item.drm ? 'drm' : live ? 'live' : kind === 'direct' ? 'available' : 'needs-backend',
    availabilityReason: item.drm ? REASONS.drm : live ? REASONS.live : kind === 'direct' ? undefined : REASONS.needsBackend,
  };
}

/** A media response observed by the network sniffer. */
export interface NetworkHit {
  url: string;
  contentType?: string;
  sizeBytes?: number;
}

export function videoFromNetwork(hit: NetworkHit, page: { pageUrl: string; pageTitle: string }): DetectedVideo | null {
  const classified = classifyMediaUrl(hit.url, hit.contentType);
  if (!classified || !isHttpUrl(hit.url)) return null;
  return {
    id: videoIdForUrl(hit.url),
    url: hit.url,
    kind: classified.kind,
    container: classified.container,
    title: page.pageTitle || getSiteName(page.pageUrl) || 'Untitled video',
    pageUrl: page.pageUrl,
    pageTitle: page.pageTitle,
    siteName: getSiteName(page.pageUrl),
    sourceHost: sourceHost(hit.url),
    mimeType: hit.contentType || undefined,
    sizeBytes: classified.kind === 'direct' ? hit.sizeBytes : undefined,
    availability: classified.kind === 'direct' ? 'available' : 'needs-backend',
    availabilityReason: classified.kind === 'direct' ? undefined : REASONS.needsBackend,
    origins: ['network'],
    detectedAt: Date.now(),
  };
}

const AVAILABILITY_RANK: Record<DetectedVideo['availability'], number> = {
  drm: 6,
  live: 5,
  unsupported: 4,
  blob: 3,
  'needs-backend': 2,
  available: 1,
  unknown: 0,
};

/** Merge a new observation into an existing record without losing probe results. */
export function mergeVideo(existing: DetectedVideo | undefined, incoming: DetectedVideo): DetectedVideo {
  if (!existing) return incoming;
  const origins = [...new Set([...existing.origins, ...incoming.origins])];
  const preferIncomingTitle = incoming.origins.includes('dom') && !existing.origins.includes('dom');
  const merged: DetectedVideo = {
    ...existing,
    title: preferIncomingTitle ? incoming.title : existing.title || incoming.title,
    posterUrl: existing.posterUrl ?? incoming.posterUrl,
    width: incoming.width ?? existing.width,
    height: incoming.height ?? existing.height,
    durationSec: existing.durationSec ?? incoming.durationSec,
    sizeBytes: existing.sizeBytes ?? incoming.sizeBytes,
    mimeType: existing.mimeType ?? incoming.mimeType,
    variants: existing.variants?.length ? existing.variants : incoming.variants,
    frameUrl: existing.frameUrl ?? incoming.frameUrl,
    isLive: existing.isLive || incoming.isLive,
    origins,
  };
  // Protection/live/blob verdicts are sticky: the most restrictive wins.
  if (AVAILABILITY_RANK[incoming.availability] > AVAILABILITY_RANK[existing.availability]) {
    merged.availability = incoming.availability;
    merged.availabilityReason = incoming.availabilityReason;
  }
  return merged;
}

/** Visible videos, best candidates first. */
export function visibleVideos(state: TabState | undefined): DetectedVideo[] {
  if (!state) return [];
  const rank = (v: DetectedVideo) => (v.availability === 'available' || v.availability === 'needs-backend' ? 0 : 1);
  const pixels = (v: DetectedVideo) => (v.height ?? v.variants?.[0]?.height ?? 0) * (v.width ?? v.variants?.[0]?.width ?? 0);
  return Object.values(state.videos)
    .filter((v) => !v.hiddenBy)
    .sort((a, b) => rank(a) - rank(b) || pixels(b) - pixels(a) || (b.sizeBytes ?? 0) - (a.sizeBytes ?? 0) || a.detectedAt - b.detectedAt);
}

export function describeVariantLabel(v: VideoVariant): string {
  return v.label || [resolutionLabel(v.height, v.width), formatBitrate(v.bandwidth)].filter(Boolean).join(' · ');
}

/**
 * Persistence with an in-memory cache and a per-tab write queue, so concurrent
 * webRequest/content events never overwrite each other.
 */
export class TabRegistry {
  private cache = new Map<number, TabState>();
  private queues = new Map<number, Promise<unknown>>();

  constructor(private readonly storage: chrome.storage.StorageArea = chrome.storage.session) {}

  async get(tabId: number): Promise<TabState | undefined> {
    const cached = this.cache.get(tabId);
    if (cached) return cached;
    const result = await this.storage.get(tabKey(tabId));
    const state = result[tabKey(tabId)] as TabState | undefined;
    if (state) this.cache.set(tabId, state);
    return state;
  }

  /** Serialized read-modify-write for one tab. */
  update(tabId: number, mutate: (state: TabState) => TabState | void): Promise<TabState> {
    const previous = this.queues.get(tabId) ?? Promise.resolve();
    const next = previous
      .catch(() => undefined)
      .then(async () => {
        const current = (await this.get(tabId)) ?? emptyTabState(tabId);
        const draft: TabState = structuredClone(current);
        const result = mutate(draft) ?? draft;
        result.updatedAt = Date.now();
        this.cache.set(tabId, result);
        await this.storage.set({ [tabKey(tabId)]: result });
        return result;
      });
    this.queues.set(tabId, next);
    return next;
  }

  async clear(tabId: number, pageUrl = '', pageTitle = ''): Promise<void> {
    await this.update(tabId, () => emptyTabState(tabId, pageUrl, pageTitle));
  }

  async remove(tabId: number): Promise<void> {
    this.cache.delete(tabId);
    this.queues.delete(tabId);
    await this.storage.remove(tabKey(tabId));
  }
}
