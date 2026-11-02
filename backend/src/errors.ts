import type { ApiErrorCode } from '@clipkeeper/shared';

const STATUS: Record<ApiErrorCode, number> = {
  BAD_REQUEST: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  DUPLICATE: 409,
  INVALID_STATE: 409,
  URL_NOT_ALLOWED: 403,
  DRM_PROTECTED: 422,
  LIVE_UNSUPPORTED: 422,
  UNSUPPORTED: 422,
  NOT_VIDEO: 422,
  DEPENDENCY_MISSING: 424,
  YTDLP_DISABLED: 403,
  NETWORK: 502,
  FILESYSTEM: 500,
  RATE_LIMITED: 429,
  INTERNAL: 500,
};

export class AppError extends Error {
  readonly status: number;

  constructor(
    readonly code: ApiErrorCode,
    message: string,
    readonly details?: unknown,
    /** Whether retrying the same operation may succeed (network blips, 5xx). */
    readonly retryable = false,
  ) {
    super(message);
    this.name = 'AppError';
    this.status = STATUS[code] ?? 500;
  }
}

export class HttpStatusError extends AppError {
  constructor(readonly httpStatus: number, url: string) {
    super('NETWORK', describeHttpStatus(httpStatus, url), { httpStatus }, httpStatus >= 500 || httpStatus === 429 || httpStatus === 408);
  }
}

function describeHttpStatus(status: number, url: string): string {
  let host = '';
  try {
    host = new URL(url).host;
  } catch {
    /* ignore */
  }
  if (status === 401 || status === 403) {
    return `${host} refused access (HTTP ${status}). The video may require signing in or may have expired; the helper never bypasses access controls.`;
  }
  if (status === 404 || status === 410) return `The video is no longer available at ${host} (HTTP ${status}).`;
  if (status === 429) return `${host} is rate limiting requests (HTTP 429).`;
  return `${host} responded with HTTP ${status}.`;
}

const RETRYABLE_CODES = new Set([
  'ECONNRESET',
  'ETIMEDOUT',
  'ESOCKETTIMEDOUT',
  'EPIPE',
  'EAI_AGAIN',
  'ECONNREFUSED',
  'ENETUNREACH',
  'EHOSTUNREACH',
  'UND_ERR_SOCKET',
  'ERR_STREAM_PREMATURE_CLOSE',
]);

export function isRetryable(error: unknown): boolean {
  if (error instanceof AppError) return error.retryable;
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  if (code && RETRYABLE_CODES.has(code)) return true;
  const message = String((error as Error | undefined)?.message ?? '');
  return /socket hang up|aborted|premature close|timed out/i.test(message);
}

export function isAbortError(error: unknown): boolean {
  const e = error as { name?: string; code?: string } | undefined;
  return e?.name === 'AbortError' || e?.code === 'ABORT_ERR';
}

/** Convert anything thrown into an AppError suitable for users. */
export function toAppError(error: unknown): AppError {
  if (error instanceof AppError) return error;
  const err = error as NodeJS.ErrnoException;
  if (err?.code === 'ENOSPC') return new AppError('FILESYSTEM', 'The disk is full.');
  if (err?.code === 'EACCES' || err?.code === 'EPERM') return new AppError('FILESYSTEM', 'Permission denied while writing the file.');
  if (err?.code === 'ENOTFOUND') return new AppError('NETWORK', 'The video host could not be found (DNS lookup failed).', undefined, false);
  if (isRetryable(err)) return new AppError('NETWORK', `Network error: ${err?.message ?? 'connection failed'}`, undefined, true);
  return new AppError('INTERNAL', err?.message ? String(err.message) : 'Unexpected error');
}
