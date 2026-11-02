/**
 * Outbound HTTP client used for every request the helper makes. Each hop
 * (including redirects) is validated by the UrlPolicy, and sockets connect
 * only to addresses approved by the policy's DNS lookup.
 */
import http from 'node:http';
import https from 'node:https';
import { normalizeMime } from '@clipkeeper/shared';
import { AppError, HttpStatusError, toAppError } from '../errors';
import type { UrlPolicy } from './policy';

export const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36 Clipkeeper/1.0';

export interface SafeRequestOptions {
  policy: UrlPolicy;
  method?: 'GET' | 'HEAD';
  /** Raw Range header value, e.g. "bytes=100-" or "bytes=0-999". */
  range?: string;
  referer?: string;
  signal?: AbortSignal;
  /** Socket inactivity timeout. */
  timeoutMs?: number;
  maxRedirects?: number;
}

export interface SafeResponse {
  statusCode: number;
  headers: http.IncomingHttpHeaders;
  /** Final URL after redirects. */
  url: string;
  body: http.IncomingMessage;
}

const REDIRECTS = new Set([301, 302, 303, 307, 308]);

function requestOnce(url: URL, options: SafeRequestOptions): Promise<http.IncomingMessage> {
  return new Promise((resolve, reject) => {
    const transport = url.protocol === 'https:' ? https : http;
    const headers: Record<string, string> = {
      'user-agent': USER_AGENT,
      accept: '*/*',
      'accept-encoding': 'identity',
    };
    if (options.range) headers.range = options.range;
    if (options.referer) headers.referer = options.referer;

    const req = transport.request(
      url,
      {
        method: options.method ?? 'GET',
        headers,
        lookup: options.policy.lookup as never,
        signal: options.signal,
      },
      resolve,
    );
    req.setTimeout(options.timeoutMs ?? 30_000, () => {
      req.destroy(new AppError('NETWORK', 'The connection timed out.', undefined, true));
    });
    req.on('error', reject);
    req.end();
  });
}

export async function safeRequest(input: string, options: SafeRequestOptions): Promise<SafeResponse> {
  const maxRedirects = options.maxRedirects ?? 5;
  let current = input;
  for (let hop = 0; hop <= maxRedirects; hop++) {
    const url = options.policy.assertUrl(current);
    let res: http.IncomingMessage;
    try {
      res = await requestOnce(url, options);
    } catch (error) {
      if (options.signal?.aborted) throw error;
      throw toAppError(error);
    }
    const status = res.statusCode ?? 0;
    if (REDIRECTS.has(status) && res.headers.location) {
      res.resume();
      current = new URL(res.headers.location, url).toString();
      continue;
    }
    return { statusCode: status, headers: res.headers, url: url.toString(), body: res };
  }
  throw new AppError('NETWORK', 'Too many redirects.');
}

/** GET a small text resource (playlist/manifest). */
export async function safeFetchText(
  input: string,
  options: SafeRequestOptions & { maxBytes?: number },
): Promise<{ text: string; url: string; contentType: string }> {
  const res = await safeRequest(input, { ...options, method: 'GET' });
  if (res.statusCode < 200 || res.statusCode >= 300) {
    res.body.resume();
    throw new HttpStatusError(res.statusCode, res.url);
  }
  const max = options.maxBytes ?? 20 * 1024 * 1024;
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of res.body) {
    size += (chunk as Buffer).length;
    if (size > max) {
      res.body.destroy();
      throw new AppError('UNSUPPORTED', 'The manifest is unexpectedly large.');
    }
    chunks.push(chunk as Buffer);
  }
  return { text: Buffer.concat(chunks).toString('utf8'), url: res.url, contentType: normalizeMime(res.headers['content-type']) };
}

/** Parse "bytes 100-199/1000" → { start, end, total }. */
export function parseContentRange(value: string | undefined): { start: number; end: number; total?: number } | null {
  const m = /^bytes\s+(\d+)-(\d+)\/(\d+|\*)$/i.exec(value?.trim() ?? '');
  if (!m) return null;
  return { start: Number(m[1]), end: Number(m[2]), total: m[3] === '*' ? undefined : Number(m[3]) };
}

/** Total size from a response: Content-Range total for 206, Content-Length for 200. */
export function responseTotalSize(res: Pick<SafeResponse, 'statusCode' | 'headers'>): number | undefined {
  if (res.statusCode === 206) return parseContentRange(res.headers['content-range'])?.total;
  const len = Number(res.headers['content-length']);
  return Number.isFinite(len) && len > 0 ? len : undefined;
}
