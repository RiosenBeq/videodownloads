import { isRetryable } from '../errors';

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export function backoffDelay(attempt: number, baseMs = 1000, maxMs = 15_000): number {
  const exp = Math.min(maxMs, baseMs * 2 ** (attempt - 1));
  return Math.round(exp * (0.75 + Math.random() * 0.5));
}

export interface RetryOptions {
  retries: number;
  signal?: AbortSignal;
  baseDelayMs?: number;
  onRetry?: (attempt: number, error: unknown) => void;
}

/** Run `fn`, retrying transient failures with exponential backoff and jitter. */
export async function withRetry<T>(fn: (attempt: number) => Promise<T>, options: RetryOptions): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn(attempt);
    } catch (error) {
      if (options.signal?.aborted || attempt >= options.retries || !isRetryable(error)) throw error;
      options.onRetry?.(attempt + 1, error);
      await sleep(backoffDelay(attempt + 1, options.baseDelayMs), options.signal);
    }
  }
}
