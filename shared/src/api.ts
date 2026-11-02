/**
 * HTTP contract between the extension and the local helper. Request bodies are
 * validated on the helper with these zod schemas; the extension uses the
 * inferred types.
 */
import { z } from 'zod';
import { isHttpUrl } from './url';
import type {
  BackendSettings,
  DependencyStatus,
  DownloadJob,
  HistoryEntry,
  VideoVariant,
  Availability,
  MediaKind,
} from './types';

export type ApiErrorCode =
  | 'BAD_REQUEST'
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'DUPLICATE'
  | 'INVALID_STATE'
  | 'URL_NOT_ALLOWED'
  | 'DRM_PROTECTED'
  | 'LIVE_UNSUPPORTED'
  | 'UNSUPPORTED'
  | 'DEPENDENCY_MISSING'
  | 'YTDLP_DISABLED'
  | 'NETWORK'
  | 'NOT_VIDEO'
  | 'FILESYSTEM'
  | 'RATE_LIMITED'
  | 'INTERNAL';

export interface ApiErrorBody {
  error: { code: ApiErrorCode; message: string; details?: unknown };
}

const MAX_URL = 8192;

export const httpUrlSchema = z
  .string()
  .trim()
  .min(1)
  .max(MAX_URL)
  .refine(isHttpUrl, { message: 'Only http(s) URLs are supported' });

export const qualitySchema = z.enum(['highest', '2160', '1440', '1080', '720', '480', '360', 'lowest']);
export const containerPreferenceSchema = z.enum(['any', 'mp4', 'webm']);

/** Hostname-like domain entry; a leading "*." or "." is accepted and stripped. */
export const domainSchema = z
  .string()
  .trim()
  .toLowerCase()
  .transform((d) => d.replace(/^\*?\./, ''))
  .pipe(
    z
      .string()
      .min(1)
      .max(253)
      .regex(/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/, 'Invalid domain'),
  );

/** yt-dlp format selector: a conservative character set, never starting with "-". */
export const formatIdSchema = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9_][A-Za-z0-9_+\-/[\]<=>*.:,|!?^$ ]*$/, 'Invalid format selector');

export const probeRequestSchema = z
  .object({
    url: httpUrlSchema,
    kind: z.enum(['direct', 'hls', 'dash', 'page']),
    pageUrl: httpUrlSchema.optional(),
  })
  .strict();
export type ProbeRequest = z.infer<typeof probeRequestSchema>;

export interface ProbeResult {
  kind: MediaKind;
  availability: Availability;
  reason?: string;
  title?: string;
  durationSec?: number;
  sizeBytes?: number;
  sizeEstimated?: boolean;
  mimeType?: string;
  isLive?: boolean;
  width?: number;
  height?: number;
  variants: VideoVariant[];
}

export const createJobSchema = z
  .object({
    url: httpUrlSchema,
    kind: z.enum(['direct', 'hls', 'dash', 'page']),
    title: z.string().max(500).optional(),
    filename: z.string().max(255).optional(),
    variantId: z.string().max(300).optional(),
    formatId: formatIdSchema.optional(),
    variantLabel: z.string().max(100).optional(),
    quality: qualitySchema.optional(),
    container: containerPreferenceSchema.optional(),
    pageUrl: httpUrlSchema.optional(),
    force: z.boolean().optional(),
  })
  .strict();
export type CreateJobRequest = z.infer<typeof createJobSchema>;

export const jobIdParamsSchema = z.object({ id: z.string().regex(/^[A-Za-z0-9_-]{6,64}$/) }).strict();

export const jobActionSchema = z.enum(['pause', 'resume', 'cancel', 'retry']);
export type JobAction = z.infer<typeof jobActionSchema>;

export const settingsPatchSchema = z
  .object({
    downloadDir: z.string().trim().min(1).max(1024),
    maxConcurrent: z.number().int().min(1).max(6),
    segmentConcurrency: z.number().int().min(1).max(16),
    maxRetries: z.number().int().min(0).max(10),
    allowedDomains: z.array(domainSchema).max(500),
    blockedDomains: z.array(domainSchema).max(500),
    allowPrivateNetwork: z.boolean(),
    ytDlpEnabled: z.boolean(),
    ytDlpDomains: z.array(domainSchema).max(500),
    allowedExtensionIds: z.array(z.string().regex(/^[a-p]{32}$/, 'Invalid extension id')).max(20),
  })
  .partial()
  .strict();
export type SettingsPatch = z.infer<typeof settingsPatchSchema>;

export const historyQuerySchema = z
  .object({ limit: z.coerce.number().int().min(1).max(1000).optional() })
  .strict();

export interface HealthResponse {
  ok: true;
  name: 'clipkeeper-helper';
  version: string;
  apiVersion: number;
}

export interface StatusResponse {
  version: string;
  apiVersion: number;
  dependencies: DependencyStatus;
  settings: BackendSettings;
  activeJobs: number;
}

export interface JobResponse {
  job: DownloadJob;
}
export interface JobsResponse {
  jobs: DownloadJob[];
}
export interface HistoryResponse {
  entries: HistoryEntry[];
}
export interface SettingsResponse {
  settings: BackendSettings;
}
export interface ChooseFolderResponse {
  path?: string;
  canceled?: boolean;
  settings?: BackendSettings;
}
