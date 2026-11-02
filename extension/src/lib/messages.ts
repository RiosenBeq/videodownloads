/** Message protocol between content scripts, the service worker and UI pages. */
import type { DownloadJob } from '@clipkeeper/shared/types';

/** What the content script reports for each video it sees. */
export interface ContentVideo {
  url: string;
  origin: 'dom' | 'link' | 'meta';
  /** Mime type from a <source type> attribute. */
  type?: string;
  /** Alternative <source> elements of the same <video>. */
  sources?: Array<{ url: string; type?: string; label?: string; height?: number }>;
  title?: string;
  posterUrl?: string;
  width?: number;
  height?: number;
  durationSec?: number;
  isLive?: boolean;
  /** The element uses Encrypted Media Extensions (DRM). */
  drm?: boolean;
}

export interface ContentReport {
  type: 'content:report';
  frameUrl: string;
  pageTitle: string;
  isTop: boolean;
  videos: ContentVideo[];
}

export interface StartDownloadRequest {
  type: 'download:start';
  tabId: number;
  videoId: string;
  variantId?: string;
  filename?: string;
  force?: boolean;
}

export type DownloadErrorCode =
  | 'NOT_FOUND'
  | 'DRM_PROTECTED'
  | 'BLOB'
  | 'LIVE_UNSUPPORTED'
  | 'UNSUPPORTED'
  | 'HELPER_REQUIRED'
  | 'DUPLICATE'
  | 'FAILED'
  | string;

export type StartDownloadResponse =
  | { ok: true; engine: 'browser' | 'helper'; job: DownloadJob }
  | { ok: false; error: { code: DownloadErrorCode; message: string; details?: unknown } };

export type RuntimeMessage =
  | ContentReport
  | StartDownloadRequest
  | { type: 'videos:probe'; tabId: number; videoId?: string }
  | { type: 'videos:rescan'; tabId: number }
  | { type: 'jobs:watch'; jobId: string }
  | { type: 'content:rescan' };

export function sendRuntimeMessage<T = unknown>(message: RuntimeMessage): Promise<T> {
  return chrome.runtime.sendMessage(message) as Promise<T>;
}
