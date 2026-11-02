/**
 * Download orchestration: decides between Chrome's own downloader (direct
 * files) and the local helper (streams, or files when the user prefers it),
 * prevents duplicates, and notifies when downloads finish.
 */
import { REASONS } from '@clipkeeper/shared/describe';
import { buildFilename, finalizeFilename } from '@clipkeeper/shared/filename';
import { resolutionLabel } from '@clipkeeper/shared/format';
import type { DownloadJob, VideoVariant } from '@clipkeeper/shared/types';
import { getUrlExtension, isHttpUrl, normalizeVideoUrl } from '@clipkeeper/shared/url';
import { HelperClient, HelperError } from '../lib/api';
import {
  addBrowserHistory,
  browserJobId,
  describeInterrupt,
  getBrowserHistory,
  getBrowserMeta,
  itemToJob,
  putBrowserMeta,
  searchDownload,
  type BrowserJobMeta,
} from '../lib/browserDownloads';
import type { StartDownloadRequest, StartDownloadResponse } from '../lib/messages';
import { loadSettings, sanitizeSubfolder, type ExtensionSettings } from '../lib/settings';
import { registry } from './detection';

const WATCH_KEY = 'watchedHelperJobs';
let pollTimer: ReturnType<typeof setTimeout> | undefined;
let polling = false;

const fail = (code: string, message: string, details?: unknown): StartDownloadResponse => ({ ok: false, error: { code, message, details } });

export function helperClient(settings: ExtensionSettings): HelperClient {
  return new HelperClient({ baseUrl: settings.helperUrl, token: settings.helperToken });
}

function extensionFor(url: string, container: string | undefined): string {
  if (container && !['unknown', 'hls', 'dash', 'ogg'].includes(container)) return container;
  if (container === 'ogg') return 'ogv';
  const ext = getUrlExtension(url);
  return ['mp4', 'm4v', 'webm', 'mov', 'mkv', 'ogv', '3gp'].includes(ext) ? ext : 'mp4';
}

function helperFailure(error: unknown): StartDownloadResponse {
  if (error instanceof HelperError) {
    if (error.code === 'OFFLINE' || error.code === 'TIMEOUT') {
      return fail('HELPER_REQUIRED', 'The Clipkeeper helper is not running. Start it with “npm run start:backend”, then try again.');
    }
    if (error.code === 'UNAUTHORIZED') return fail('HELPER_REQUIRED', 'The helper rejected the token. Paste the current token in Settings.');
    return fail(error.code, error.message, error.details);
  }
  return fail('FAILED', (error as Error)?.message ?? 'Download failed.');
}

async function startHelperJob(settings: ExtensionSettings, request: Parameters<HelperClient['createJob']>[0]): Promise<StartDownloadResponse> {
  try {
    const { job } = await helperClient(settings).createJob(request);
    await watchHelperJob(job.id);
    return { ok: true, engine: 'helper', job };
  } catch (error) {
    return helperFailure(error);
  }
}

async function startBrowserJob(
  settings: ExtensionSettings,
  input: { url: string; filename: string; title: string; pageUrl?: string; variantLabel?: string; force?: boolean },
): Promise<StartDownloadResponse> {
  const key = `browser|${normalizeVideoUrl(input.url)}`;
  const metas = Object.values(await getBrowserMeta()).filter((m) => m.key === key);
  for (const meta of metas) {
    const item = await searchDownload(meta.downloadId);
    if (item?.state === 'in_progress') return fail('DUPLICATE', 'This video is already downloading.', { jobId: browserJobId(item.id) });
  }
  if (!input.force) {
    for (const entry of await getBrowserHistory()) {
      if (entry.key !== key || entry.status !== 'completed') continue;
      const id = Number(entry.id.slice(2));
      const item = Number.isFinite(id) ? await searchDownload(id) : undefined;
      if (item?.exists) return fail('DUPLICATE', 'This video was already downloaded.', { inHistory: true, historyId: entry.id });
    }
  }

  const subfolder = sanitizeSubfolder(settings.browserSubfolder);
  const relativePath = subfolder ? `${subfolder}/${input.filename}` : input.filename;
  let downloadId: number;
  try {
    downloadId = await chrome.downloads.download({
      url: input.url,
      filename: relativePath,
      saveAs: settings.saveAs,
      conflictAction: 'uniquify',
    });
  } catch (error) {
    return fail('FAILED', `Chrome could not start the download: ${(error as Error).message}`);
  }
  const meta: BrowserJobMeta = {
    downloadId,
    url: input.url,
    title: input.title,
    filename: input.filename,
    relativePath,
    pageUrl: input.pageUrl,
    variantLabel: input.variantLabel,
    key,
    createdAt: Date.now(),
  };
  await putBrowserMeta(meta);
  const item = await searchDownload(downloadId);
  const job: DownloadJob = item
    ? itemToJob(item, meta)
    : {
        id: browserJobId(downloadId),
        engine: 'browser',
        url: input.url,
        title: input.title,
        filename: input.filename,
        status: 'downloading',
        bytesDownloaded: 0,
        retryCount: 0,
        canPause: true,
        createdAt: meta.createdAt,
        updatedAt: meta.createdAt,
      };
  return { ok: true, engine: 'browser', job };
}

export async function startDownload(request: StartDownloadRequest): Promise<StartDownloadResponse> {
  const state = await registry.get(request.tabId);
  const video = state?.videos[request.videoId];
  if (!video) return fail('NOT_FOUND', 'This video is no longer on the page. Reload the page and try again.');

  switch (video.availability) {
    case 'drm':
      return fail('DRM_PROTECTED', video.availabilityReason ?? REASONS.drm);
    case 'blob':
      return fail('BLOB', REASONS.blob);
    case 'live':
      return fail('LIVE_UNSUPPORTED', REASONS.live);
    case 'unsupported':
      return fail('UNSUPPORTED', video.availabilityReason ?? 'This video cannot be downloaded.');
  }

  const settings = await loadSettings();
  const variant: VideoVariant | undefined = request.variantId ? video.variants?.find((v) => v.id === request.variantId) : undefined;
  const pageUrl = isHttpUrl(video.pageUrl) ? video.pageUrl : undefined;
  const vars = {
    title: video.title,
    site: video.siteName,
    resolution: resolutionLabel(variant?.height ?? video.height, variant?.width ?? video.width),
  };
  const customName = request.filename?.trim();

  if (video.kind === 'direct') {
    const url = variant?.url ?? video.url;
    const ext = extensionFor(url, variant?.container ?? video.container);
    const filename = customName ? finalizeFilename(customName, ext) : buildFilename(settings.filenameTemplate, vars, ext);
    if (settings.directEngine === 'helper' && settings.helperToken) {
      return startHelperJob(settings, {
        url,
        kind: 'direct',
        title: video.title,
        filename,
        pageUrl,
        variantLabel: variant?.label,
        force: request.force,
      });
    }
    return startBrowserJob(settings, { url, filename, title: video.title, pageUrl, variantLabel: variant?.label, force: request.force });
  }

  if (video.kind !== 'hls' && video.kind !== 'dash') return fail('UNSUPPORTED', 'This video type cannot be downloaded.');
  if (!settings.helperToken) {
    return fail(
      'HELPER_REQUIRED',
      'HLS and DASH streams are saved by the Clipkeeper helper. Start it (npm run start:backend) and paste its token in Settings.',
    );
  }
  return startHelperJob(settings, {
    url: video.url,
    kind: video.kind,
    variantId: variant?.id,
    variantLabel: variant?.label,
    quality: settings.quality,
    container: settings.container,
    title: video.title,
    filename: customName ? finalizeFilename(customName, 'mp4') : buildFilename(settings.filenameTemplate, vars, 'mp4'),
    pageUrl,
    force: request.force,
  });
}

// ---- notifications -------------------------------------------------------

export async function notify(id: string, title: string, message: string): Promise<void> {
  const settings = await loadSettings();
  if (!settings.notifications) return;
  try {
    await chrome.notifications.create(id, {
      type: 'basic',
      iconUrl: chrome.runtime.getURL('icons/icon-128.png'),
      title,
      message,
      priority: 0,
    });
  } catch {
    /* notifications unavailable */
  }
}

export async function onNotificationClicked(notificationId: string): Promise<void> {
  const [, engine, id] = notificationId.split(':');
  try {
    if (engine === 'browser') chrome.downloads.show(Number(id));
    else if (engine === 'helper') await helperClient(await loadSettings()).revealJob(id);
  } catch {
    /* file moved or helper offline */
  }
  chrome.notifications.clear(notificationId);
}

/** Chrome-engine downloads: record history and notify when they end. */
export async function onBrowserDownloadChanged(delta: chrome.downloads.DownloadDelta): Promise<void> {
  const state = delta.state?.current;
  if (!state || state === 'in_progress') return;
  const meta = (await getBrowserMeta())[String(delta.id)];
  if (!meta) return;
  const item = await searchDownload(delta.id);
  if (!item) return;
  await addBrowserHistory(meta, item);
  if (item.state === 'complete') await notify(`ck:browser:${item.id}`, 'Download complete', `Saved “${meta.title}”`);
  else if (item.error !== 'USER_CANCELED') await notify(`ck:browser-failed:${item.id}`, 'Download failed', `${meta.title}: ${describeInterrupt(item.error)}`);
}

// ---- helper job watching -------------------------------------------------

async function getWatched(): Promise<string[]> {
  const result = await chrome.storage.session.get(WATCH_KEY);
  return (result[WATCH_KEY] as string[]) ?? [];
}

async function setWatched(ids: string[]): Promise<void> {
  await chrome.storage.session.set({ [WATCH_KEY]: [...new Set(ids)] });
}

export async function watchHelperJob(jobId: string): Promise<void> {
  await setWatched([...(await getWatched()), jobId]);
  void pollHelperJobs();
}

/** Poll the helper while jobs we started are running; notify on completion. */
export async function pollHelperJobs(): Promise<void> {
  if (polling) return;
  polling = true;
  if (pollTimer) clearTimeout(pollTimer);
  try {
    const watched = await getWatched();
    if (!watched.length) return;
    const settings = await loadSettings();
    if (!settings.helperToken) return setWatched([]);
    let jobs: DownloadJob[];
    try {
      jobs = (await helperClient(settings).listJobs()).jobs;
    } catch {
      pollTimer = setTimeout(() => void pollHelperJobs(), 5000);
      return;
    }
    const remaining: string[] = [];
    for (const id of watched) {
      const job = jobs.find((j) => j.id === id);
      if (!job) continue;
      if (job.status === 'completed') await notify(`ck:helper:${job.id}`, 'Download complete', `Saved “${job.title}”`);
      else if (job.status === 'failed') await notify(`ck:helper-failed:${job.id}`, 'Download failed', `${job.title}: ${job.error ?? 'Unknown error'}`);
      else if (job.status !== 'canceled') remaining.push(id);
    }
    await setWatched(remaining);
    if (remaining.length) pollTimer = setTimeout(() => void pollHelperJobs(), 2000);
  } finally {
    polling = false;
  }
}
