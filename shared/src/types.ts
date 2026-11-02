/**
 * Core domain types shared by the extension and the local helper.
 */

/** How a video is delivered. `page` means "a web page URL handed to yt-dlp". */
export type MediaKind = 'direct' | 'hls' | 'dash' | 'blob' | 'page';

export type ContainerFormat =
  | 'mp4'
  | 'm4v'
  | 'webm'
  | 'mov'
  | 'mkv'
  | 'ogg'
  | '3gp'
  | 'ts'
  | 'hls'
  | 'dash'
  | 'unknown';

/**
 * Whether (and how) a detected video can be saved.
 * - available:     direct file, downloadable right away
 * - needs-backend: stream that the local helper can save (HLS/DASH/yt-dlp)
 * - drm:           protected by DRM or encryption — never downloaded
 * - blob:          Media Source blob URL without an accessible manifest
 * - live:          live stream — not recorded
 * - unsupported:   recognised but cannot be handled
 * - unknown:       not probed yet
 */
export type Availability =
  | 'available'
  | 'needs-backend'
  | 'drm'
  | 'blob'
  | 'live'
  | 'unsupported'
  | 'unknown';

export type DetectionOrigin = 'dom' | 'link' | 'meta' | 'network';

export interface VideoVariant {
  /** Stable id within its video (direct source URL hash, HLS URI hash, DASH representation id, yt-dlp format id). */
  id: string;
  label: string;
  width?: number;
  height?: number;
  /** Bits per second. */
  bandwidth?: number;
  codecs?: string;
  /** Variant URL for direct sources / HLS variant playlists. */
  url?: string;
  container?: ContainerFormat;
  sizeBytes?: number;
  sizeEstimated?: boolean;
  /** yt-dlp format selector, when the variant came from yt-dlp. */
  formatId?: string;
}

export interface DetectedVideo {
  id: string;
  url: string;
  kind: MediaKind;
  container: ContainerFormat;
  title: string;
  pageUrl: string;
  pageTitle?: string;
  /** Hostname of the page, without `www.`. */
  siteName: string;
  /** Hostname of the media URL. */
  sourceHost: string;
  frameUrl?: string;
  mimeType?: string;
  width?: number;
  height?: number;
  durationSec?: number;
  sizeBytes?: number;
  sizeEstimated?: boolean;
  posterUrl?: string;
  variants?: VideoVariant[];
  availability: Availability;
  availabilityReason?: string;
  origins: DetectionOrigin[];
  isLive?: boolean;
  probed?: boolean;
  probeError?: string;
  /** Set when this entry is a variant playlist of another detected master playlist. */
  hiddenBy?: string;
  detectedAt: number;
}

export type JobEngine = 'browser' | 'direct' | 'hls' | 'dash' | 'ytdlp';

export type JobStatus =
  | 'queued'
  | 'downloading'
  | 'merging'
  | 'paused'
  | 'completed'
  | 'failed'
  | 'canceled';

export interface DownloadJob {
  id: string;
  engine: JobEngine;
  url: string;
  pageUrl?: string;
  title: string;
  /** File name (no directory). */
  filename: string;
  /** Absolute path, once known (helper jobs only). */
  filePath?: string;
  variantLabel?: string;
  status: JobStatus;
  bytesDownloaded: number;
  totalBytes?: number;
  totalEstimated?: boolean;
  /** 0..1 */
  progress?: number;
  speedBps?: number;
  etaSec?: number;
  segmentsDone?: number;
  segmentsTotal?: number;
  /** Human readable phase, e.g. "Merging audio and video". */
  phase?: string;
  error?: string;
  errorCode?: string;
  retryCount: number;
  canPause: boolean;
  createdAt: number;
  updatedAt: number;
  completedAt?: number;
}

export const ACTIVE_JOB_STATUSES: readonly JobStatus[] = ['queued', 'downloading', 'merging', 'paused'];
export const FINISHED_JOB_STATUSES: readonly JobStatus[] = ['completed', 'failed', 'canceled'];

export function isJobActive(status: JobStatus): boolean {
  return ACTIVE_JOB_STATUSES.includes(status);
}

export interface HistoryEntry {
  id: string;
  jobId?: string;
  title: string;
  url: string;
  pageUrl?: string;
  siteName: string;
  filename: string;
  filePath?: string;
  sizeBytes?: number;
  engine: JobEngine;
  status: 'completed' | 'failed' | 'canceled';
  variantLabel?: string;
  error?: string;
  completedAt: number;
  /** Dedupe key (normalized URL + variant) used to warn about repeat downloads. */
  key?: string;
}

export type QualityPreference = 'highest' | '2160' | '1440' | '1080' | '720' | '480' | '360' | 'lowest';
export type ContainerPreference = 'any' | 'mp4' | 'webm';

export interface BackendSettings {
  /** Absolute folder where the helper saves files. */
  downloadDir: string;
  maxConcurrent: number;
  segmentConcurrency: number;
  maxRetries: number;
  /** When non-empty, only these domains (and subdomains) may be downloaded from. */
  allowedDomains: string[];
  blockedDomains: string[];
  /** Allow sources on loopback / private networks (off by default; useful for testing). */
  allowPrivateNetwork: boolean;
  /** yt-dlp is opt-in. */
  ytDlpEnabled: boolean;
  /** Domains where yt-dlp may be used. Empty means none. */
  ytDlpDomains: string[];
  /** Optional: only accept requests from this extension id. */
  allowedExtensionIds: string[];
}

export interface DependencyInfo {
  found: boolean;
  path?: string;
  version?: string;
}

export interface DependencyStatus {
  platform: string;
  ffmpeg: DependencyInfo;
  ffprobe: DependencyInfo;
  ytDlp: DependencyInfo;
  installHints: { ffmpeg: string; ytDlp: string };
}
