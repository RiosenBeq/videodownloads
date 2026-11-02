import {
  DASH_MIME_TYPES,
  DIRECT_VIDEO_EXTENSIONS,
  DIRECT_VIDEO_MIME,
  HLS_MIME_TYPES,
  SEGMENT_EXTENSIONS,
  SEGMENT_MIME_TYPES,
} from './constants';
import type { ContainerFormat, MediaKind } from './types';

export function safeParseUrl(input: string, base?: string): URL | null {
  try {
    return base ? new URL(input, base) : new URL(input);
  } catch {
    return null;
  }
}

export function isHttpUrl(input: string): boolean {
  const url = safeParseUrl(input);
  return !!url && (url.protocol === 'http:' || url.protocol === 'https:');
}

export function isBlobUrl(input: string): boolean {
  return input.startsWith('blob:');
}

/** Lower-case extension of the URL path, without the dot ("" if none). */
export function getUrlExtension(input: string): string {
  const url = safeParseUrl(input);
  const path = url ? url.pathname : input.split(/[?#]/)[0];
  const last = path.split('/').pop() ?? '';
  const dot = last.lastIndexOf('.');
  if (dot <= 0 || dot === last.length - 1) return '';
  return last.slice(dot + 1).toLowerCase();
}

/** Strip parameters from a content-type header: "video/mp4; codecs=..." → "video/mp4". */
export function normalizeMime(contentType?: string | null): string {
  return (contentType ?? '').split(';')[0].trim().toLowerCase();
}

export interface MediaClassification {
  kind: Exclude<MediaKind, 'blob' | 'page'>;
  container: ContainerFormat;
}

/**
 * Classify a URL (optionally with its response content-type) as a direct file,
 * HLS manifest or DASH manifest. Returns null for anything else, including
 * stream segments.
 */
export function classifyMediaUrl(input: string, contentType?: string | null): MediaClassification | null {
  const mime = normalizeMime(contentType);
  const ext = getUrlExtension(input);

  if (HLS_MIME_TYPES.includes(mime) || ext === 'm3u8') return { kind: 'hls', container: 'hls' };
  if (DASH_MIME_TYPES.includes(mime) || ext === 'mpd') return { kind: 'dash', container: 'dash' };
  if (SEGMENT_MIME_TYPES.includes(mime) || SEGMENT_EXTENSIONS.includes(ext)) return null;

  if (ext in DIRECT_VIDEO_EXTENSIONS) return { kind: 'direct', container: DIRECT_VIDEO_EXTENSIONS[ext] };
  if (mime in DIRECT_VIDEO_MIME) return { kind: 'direct', container: DIRECT_VIDEO_MIME[mime] };
  if (mime.startsWith('video/')) return { kind: 'direct', container: 'unknown' };
  return null;
}

/** Container for a `<source type="...">` attribute value. */
export function containerFromMime(type?: string | null): ContainerFormat | undefined {
  const mime = normalizeMime(type);
  if (!mime) return undefined;
  if (HLS_MIME_TYPES.includes(mime)) return 'hls';
  if (DASH_MIME_TYPES.includes(mime)) return 'dash';
  return DIRECT_VIDEO_MIME[mime];
}

/**
 * Heuristic for URLs that are fragments of an adaptive stream rather than a
 * complete file (MSE range fetches, numbered segments...).
 */
export function looksLikeSegmentUrl(input: string): boolean {
  const ext = getUrlExtension(input);
  if (SEGMENT_EXTENSIONS.includes(ext)) return true;
  const url = safeParseUrl(input);
  if (!url) return false;
  const params = url.searchParams;
  if (params.has('range') || params.has('bytes') || (params.has('rn') && params.has('rbuf'))) return true;
  return /\/(range|bytes)[/=]\d+-\d*/i.test(url.pathname) || /[/_-](seg|segment|frag|fragment|chunk)[-_]?\d+/i.test(url.pathname);
}

/** Hostname without a leading "www.". */
export function getSiteName(input: string): string {
  const url = safeParseUrl(input);
  if (!url) return '';
  return url.hostname.replace(/^www\./i, '');
}

/** URL without its fragment; used as a dedupe key. */
export function normalizeVideoUrl(input: string): string {
  const url = safeParseUrl(input);
  if (!url) return input;
  url.hash = '';
  return url.toString();
}

/** True when `host` is `domain` or a subdomain of it. */
export function matchesDomain(host: string, domain: string): boolean {
  const h = host.toLowerCase().replace(/\.$/, '');
  const d = domain.toLowerCase().replace(/^\*?\./, '').replace(/\.$/, '');
  if (!d) return false;
  return h === d || h.endsWith(`.${d}`);
}

export function matchesAnyDomain(host: string, domains: readonly string[]): boolean {
  return domains.some((d) => matchesDomain(host, d));
}

/** Small, fast, deterministic string hash (FNV-1a, 32-bit) rendered in base36. */
export function hashString(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

export function videoIdForUrl(input: string): string {
  return `v_${hashString(normalizeVideoUrl(input))}`;
}

/** Shorten a URL for display: host + truncated path. */
export function displayUrl(input: string, max = 60): string {
  const url = safeParseUrl(input);
  if (!url) return input.length > max ? `${input.slice(0, max - 1)}…` : input;
  const text = `${url.host}${url.pathname}${url.search}`;
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
