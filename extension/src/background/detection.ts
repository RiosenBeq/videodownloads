/**
 * Service-worker side of detection: merges content-script reports and network
 * observations into the per-tab registry, probes manifests, keeps the badge
 * up to date and forgets everything when the tab navigates or closes.
 */
import { REASONS } from '@clipkeeper/shared/describe';
import type { DetectedVideo } from '@clipkeeper/shared/types';
import { normalizeVideoUrl } from '@clipkeeper/shared/url';
import type { ContentReport } from '../lib/messages';
import { probeVideo } from '../lib/probe';
import { TabRegistry, mergeVideo, videoFromContent, videoFromNetwork, visibleVideos, type NetworkHit, type TabState } from '../lib/registry';
import { loadSettings } from '../lib/settings';

export const registry = new TabRegistry();
const probing = new Set<string>();

function stripHash(url: string): string {
  return url.split('#')[0];
}

function applyDrm(state: TabState): void {
  if (!state.drm) return;
  for (const video of Object.values(state.videos)) {
    if ((video.kind === 'hls' || video.kind === 'dash' || video.kind === 'blob') && video.availability !== 'drm') {
      video.availability = 'drm';
      video.availabilityReason = REASONS.drm;
    }
  }
}

function applyChildren(state: TabState): void {
  for (const video of Object.values(state.videos)) {
    const master = state.children[normalizeVideoUrl(video.url)];
    if (master && master !== video.id && state.videos[master]) video.hiddenBy = master;
  }
}

export async function updateBadge(tabId: number, state?: TabState): Promise<void> {
  try {
    const settings = await loadSettings();
    const count = settings.showBadge ? visibleVideos(state ?? (await registry.get(tabId))).length : 0;
    await chrome.action.setBadgeBackgroundColor({ tabId, color: '#6d5ef6' });
    await chrome.action.setBadgeText({ tabId, text: count ? String(Math.min(count, 99)) : '' });
  } catch {
    /* tab closed */
  }
}

export async function handleContentReport(tabId: number, frameId: number, report: ContentReport, tab?: chrome.tabs.Tab): Promise<void> {
  const state = await registry.update(tabId, (draft) => {
    if (report.isTop) {
      // A different document in the top frame (SPA route change): drop entries from the previous page.
      if (draft.pageUrl && stripHash(draft.pageUrl) !== stripHash(report.frameUrl)) {
        for (const [id, video] of Object.entries(draft.videos)) {
          if (stripHash(video.pageUrl) !== stripHash(report.frameUrl)) delete draft.videos[id];
        }
        draft.frames = {};
        draft.drm = false;
      }
      draft.pageUrl = report.frameUrl;
      draft.pageTitle = report.pageTitle;
    }
    const pageUrl = draft.pageUrl || tab?.url || report.frameUrl;
    const pageTitle = draft.pageTitle || tab?.title || '';
    const frameKey = String(frameId);
    const ids: string[] = [];
    for (const item of report.videos) {
      const video = videoFromContent(item, { pageUrl, pageTitle, frameUrl: report.frameUrl });
      if (!video) continue;
      draft.videos[video.id] = mergeVideo(draft.videos[video.id], video);
      ids.push(video.id);
      if (item.drm) draft.drm = true;
    }
    // Remove DOM-only videos this frame no longer shows.
    const otherFrames = new Set(Object.entries(draft.frames).filter(([k]) => k !== frameKey).flatMap(([, v]) => v));
    for (const id of draft.frames[frameKey] ?? []) {
      const video = draft.videos[id];
      if (video && !ids.includes(id) && !otherFrames.has(id) && !video.origins.includes('network')) delete draft.videos[id];
    }
    draft.frames[frameKey] = ids;
    applyDrm(draft);
    applyChildren(draft);
  });
  await updateBadge(tabId, state);
  void autoProbe(tabId, state);
}

export async function handleNetworkHit(tabId: number, hit: NetworkHit): Promise<void> {
  const tab = await chrome.tabs.get(tabId).catch(() => undefined);
  if (!tab) return;
  const state = await registry.update(tabId, (draft) => {
    const video = videoFromNetwork(hit, { pageUrl: tab.url ?? draft.pageUrl, pageTitle: draft.pageTitle || tab.title || '' });
    if (!video) return;
    if (!draft.pageUrl) draft.pageUrl = tab.url ?? '';
    draft.videos[video.id] = mergeVideo(draft.videos[video.id], video);
    applyDrm(draft);
    applyChildren(draft);
  });
  await updateBadge(tabId, state);
  void autoProbe(tabId, state);
}

async function probeOne(tabId: number, video: DetectedVideo): Promise<void> {
  const key = `${tabId}:${video.id}`;
  if (probing.has(key)) return;
  probing.add(key);
  try {
    const { patch, childUrls } = await probeVideo(video);
    const state = await registry.update(tabId, (draft) => {
      const current = draft.videos[video.id];
      if (!current) return;
      // Never let a probe relax a DRM verdict from the page.
      const next = { ...current, ...patch };
      if (current.availability === 'drm') {
        next.availability = 'drm';
        next.availabilityReason = current.availabilityReason;
      }
      draft.videos[video.id] = next;
      for (const url of childUrls) draft.children[normalizeVideoUrl(url)] = video.id;
      applyDrm(draft);
      applyChildren(draft);
    });
    await updateBadge(tabId, state);
  } finally {
    probing.delete(key);
  }
}

/** Manifests are probed as soon as they are seen so variant playlists collapse into their master. */
async function autoProbe(tabId: number, state: TabState): Promise<void> {
  const pending = Object.values(state.videos).filter((v) => (v.kind === 'hls' || v.kind === 'dash') && !v.probed && !v.hiddenBy);
  await Promise.all(pending.map((v) => probeOne(tabId, v)));
}

/** Probe on demand (popup open): manifests plus direct files without a known size. */
export async function probeTab(tabId: number, videoId?: string): Promise<void> {
  const state = await registry.get(tabId);
  if (!state) return;
  const targets = Object.values(state.videos).filter(
    (v) => (!videoId || v.id === videoId) && !v.hiddenBy && (!v.probed || (videoId && v.probeError)) && v.kind !== 'blob',
  );
  await Promise.all(targets.map((v) => probeOne(tabId, v)));
}

export async function resetTab(tabId: number, pageUrl = ''): Promise<void> {
  await registry.clear(tabId, pageUrl);
  await updateBadge(tabId);
}
