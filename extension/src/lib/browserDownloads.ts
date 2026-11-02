/**
 * Bookkeeping for downloads performed by Chrome itself (direct files). The
 * Downloads API provides progress, pause/resume and cancel; we keep a little
 * metadata (title, page, dedupe key) and a local history.
 */
import { getSiteName } from '@clipkeeper/shared/url';
import type { DownloadJob, HistoryEntry } from '@clipkeeper/shared/types';

export interface BrowserJobMeta {
  downloadId: number;
  url: string;
  title: string;
  filename: string;
  /** Path passed to chrome.downloads (sub-folder + file name), reused for retries. */
  relativePath?: string;
  pageUrl?: string;
  variantLabel?: string;
  key: string;
  createdAt: number;
}

const JOBS_KEY = 'browserJobs';
const HISTORY_KEY = 'browserHistory';
const MAX_HISTORY = 500;

export const browserJobId = (downloadId: number) => `b_${downloadId}`;

export async function getBrowserMeta(): Promise<Record<string, BrowserJobMeta>> {
  const result = await chrome.storage.local.get(JOBS_KEY);
  return (result[JOBS_KEY] as Record<string, BrowserJobMeta>) ?? {};
}

export async function putBrowserMeta(meta: BrowserJobMeta): Promise<void> {
  const all = await getBrowserMeta();
  all[String(meta.downloadId)] = meta;
  // Keep the store small: drop the oldest finished records beyond 100.
  const entries = Object.values(all).sort((a, b) => b.createdAt - a.createdAt).slice(0, 100);
  await chrome.storage.local.set({ [JOBS_KEY]: Object.fromEntries(entries.map((e) => [String(e.downloadId), e])) });
}

export async function deleteBrowserMeta(downloadId: number): Promise<void> {
  const all = await getBrowserMeta();
  delete all[String(downloadId)];
  await chrome.storage.local.set({ [JOBS_KEY]: all });
}

const INTERRUPT_MESSAGES: Record<string, string> = {
  NETWORK_FAILED: 'Network error — the connection was lost.',
  NETWORK_TIMEOUT: 'The connection timed out.',
  NETWORK_DISCONNECTED: 'You appear to be offline.',
  NETWORK_SERVER_DOWN: 'The server is not responding.',
  SERVER_FAILED: 'The server reported an error.',
  SERVER_FORBIDDEN: 'The server refused access to this file.',
  SERVER_UNAUTHORIZED: 'This file requires signing in.',
  SERVER_BAD_CONTENT: 'The server did not return the expected file.',
  SERVER_NO_RANGE: 'The server does not support resuming.',
  FILE_NO_SPACE: 'The disk is full.',
  FILE_ACCESS_DENIED: 'Permission denied while saving the file.',
  FILE_NAME_TOO_LONG: 'The file name is too long.',
  FILE_TOO_LARGE: 'The file is too large for the destination.',
  FILE_BLOCKED: 'The download was blocked by your system or browser policy.',
  FILE_VIRUS_INFECTED: 'The file was flagged by your antivirus software.',
  USER_CANCELED: 'Canceled.',
};

export function describeInterrupt(reason?: string): string {
  if (!reason) return 'The download was interrupted.';
  return INTERRUPT_MESSAGES[reason] ?? `The download was interrupted (${reason.toLowerCase().replace(/_/g, ' ')}).`;
}

function basename(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

/** Name Chrome actually used (it may have added " (1)"), unless it is a temporary extension-less name. */
function savedName(item: chrome.downloads.DownloadItem, meta: BrowserJobMeta): string {
  const name = item.filename ? basename(item.filename) : '';
  return /\.[a-z0-9]{2,5}$/i.test(name) ? name : meta.filename;
}

export function itemToJob(item: chrome.downloads.DownloadItem, meta: BrowserJobMeta, speedBps?: number): DownloadJob {
  const state = item.state;
  const canceled = state === 'interrupted' && item.error === 'USER_CANCELED';
  const status: DownloadJob['status'] =
    state === 'complete' ? 'completed' : state === 'interrupted' ? (canceled ? 'canceled' : 'failed') : item.paused ? 'paused' : 'downloading';
  const total = item.totalBytes > 0 ? item.totalBytes : item.fileSize > 0 ? item.fileSize : undefined;
  const endTime = item.estimatedEndTime ? Date.parse(item.estimatedEndTime) : NaN;
  const eta = Number.isFinite(endTime) ? Math.max(0, (endTime - Date.now()) / 1000) : undefined;
  return {
    id: browserJobId(item.id),
    engine: 'browser',
    url: meta.url,
    pageUrl: meta.pageUrl,
    title: meta.title,
    filename: savedName(item, meta),
    filePath: item.filename || undefined,
    variantLabel: meta.variantLabel,
    status,
    bytesDownloaded: item.bytesReceived,
    totalBytes: total,
    progress: status === 'completed' ? 1 : total ? Math.min(0.999, item.bytesReceived / total) : undefined,
    speedBps: status === 'downloading' ? speedBps : undefined,
    etaSec: status === 'downloading' ? eta : undefined,
    error: state === 'interrupted' && !canceled ? describeInterrupt(item.error) : undefined,
    errorCode: state === 'interrupted' ? item.error : undefined,
    retryCount: 0,
    canPause: state === 'in_progress' && (item.canResume || !item.paused),
    createdAt: meta.createdAt,
    updatedAt: Date.now(),
    completedAt: item.endTime ? Date.parse(item.endTime) : undefined,
  };
}

export async function getBrowserHistory(): Promise<HistoryEntry[]> {
  const result = await chrome.storage.local.get(HISTORY_KEY);
  return (result[HISTORY_KEY] as HistoryEntry[]) ?? [];
}

export async function addBrowserHistory(meta: BrowserJobMeta, item: chrome.downloads.DownloadItem): Promise<HistoryEntry> {
  const status = item.state === 'complete' ? 'completed' : item.error === 'USER_CANCELED' ? 'canceled' : 'failed';
  const entry: HistoryEntry = {
    id: browserJobId(item.id),
    jobId: browserJobId(item.id),
    key: meta.key,
    title: meta.title,
    url: meta.url,
    pageUrl: meta.pageUrl,
    siteName: getSiteName(meta.pageUrl ?? meta.url),
    filename: savedName(item, meta),
    filePath: item.filename || undefined,
    sizeBytes: status === 'completed' ? item.fileSize || item.totalBytes || undefined : undefined,
    engine: 'browser',
    status,
    variantLabel: meta.variantLabel,
    error: status === 'failed' ? describeInterrupt(item.error) : undefined,
    completedAt: Date.now(),
  };
  const all = await getBrowserHistory();
  const next = [entry, ...all.filter((e) => e.id !== entry.id)].slice(0, MAX_HISTORY);
  await chrome.storage.local.set({ [HISTORY_KEY]: next });
  return entry;
}

export async function removeBrowserHistory(id?: string): Promise<void> {
  const next = id ? (await getBrowserHistory()).filter((e) => e.id !== id) : [];
  await chrome.storage.local.set({ [HISTORY_KEY]: next });
}

/** Restart a failed Chrome download: resume when possible, otherwise download again under the same metadata. */
export async function retryBrowserDownload(downloadId: number): Promise<void> {
  const item = await searchDownload(downloadId);
  if (item?.canResume) return chrome.downloads.resume(downloadId);
  const meta = (await getBrowserMeta())[String(downloadId)];
  if (!meta) throw new Error('Nothing to retry.');
  const newId = await chrome.downloads.download({ url: meta.url, filename: meta.relativePath ?? meta.filename, conflictAction: 'uniquify' });
  await putBrowserMeta({ ...meta, downloadId: newId, createdAt: Date.now() });
  await deleteBrowserMeta(downloadId);
}

export function searchDownload(id: number): Promise<chrome.downloads.DownloadItem | undefined> {
  return chrome.downloads.search({ id }).then((items) => items[0]);
}
