/**
 * DOM video discovery. Pure functions over a Document so they can be unit
 * tested with jsdom. Finds <video>/<source> elements (including inside open
 * shadow roots), links to video files and og:video metadata.
 */
import { DIRECT_VIDEO_EXTENSIONS } from '@clipkeeper/shared/constants';
import { getUrlExtension, isBlobUrl, isHttpUrl } from '@clipkeeper/shared/url';
import type { ContentVideo } from '../lib/messages';

const MAX_ELEMENTS_FOR_SHADOW_SCAN = 25_000;
const MAX_LINKS = 200;

export interface DetectOptions {
  /** Elements that fired an `encrypted` event (EME). */
  drmElements?: WeakSet<Element>;
}

function clean(text: string | null | undefined, max = 200): string | undefined {
  const value = (text ?? '').replace(/\s+/g, ' ').trim();
  return value ? value.slice(0, max) : undefined;
}

/** querySelectorAll that also descends into open shadow roots. */
export function deepQueryAll<T extends Element>(root: Document | ShadowRoot, selector: string): T[] {
  const results = [...root.querySelectorAll<T>(selector)];
  const all = root.querySelectorAll('*');
  if (all.length > MAX_ELEMENTS_FOR_SHADOW_SCAN) return results;
  for (const el of all) {
    if (el.shadowRoot) results.push(...deepQueryAll<T>(el.shadowRoot, selector));
  }
  return results;
}

/** "1080", "1080p", "720P HD", "4K" → height in pixels. */
export function parseHeightHint(value: string | null | undefined): number | undefined {
  if (!value) return undefined;
  if (/\b4k\b|2160/i.test(value)) return 2160;
  if (/\b8k\b|4320/i.test(value)) return 4320;
  const m = /(\d{3,4})\s*p?\b/i.exec(value);
  const n = m ? Number(m[1]) : NaN;
  return n >= 120 && n <= 4320 ? n : undefined;
}

function documentTitle(doc: Document): string | undefined {
  return clean(doc.querySelector('meta[property="og:title"]')?.getAttribute('content')) ?? clean(doc.title);
}

export function elementTitle(el: Element, doc: Document): string | undefined {
  const direct = clean(el.getAttribute('title')) ?? clean(el.getAttribute('aria-label')) ?? clean(el.getAttribute('data-title'));
  if (direct) return direct;
  const labelledBy = el.getAttribute('aria-labelledby');
  if (labelledBy) {
    const label = clean(doc.getElementById(labelledBy)?.textContent);
    if (label) return label;
  }
  const caption = clean(el.closest('figure')?.querySelector('figcaption')?.textContent);
  if (caption) return caption;
  return documentTitle(doc);
}

function sourceHeight(source: Element): number | undefined {
  for (const attr of ['size', 'res', 'data-res', 'data-quality', 'label', 'title', 'data-label', 'height']) {
    const h = parseHeightHint(source.getAttribute(attr));
    if (h) return h;
  }
  return parseHeightHint(source.getAttribute('src'));
}

export function describeVideoElement(video: HTMLVideoElement, doc: Document, options: DetectOptions = {}): ContentVideo | null {
  const sources = [...video.querySelectorAll('source')]
    .map((s) => ({
      url: s.src,
      type: s.type || undefined,
      label: clean(s.getAttribute('label') ?? s.getAttribute('title') ?? s.getAttribute('data-quality')),
      height: sourceHeight(s),
    }))
    .filter((s) => s.url);

  const url = video.currentSrc || video.src || sources[0]?.url;
  if (!url) return null;
  if (!isHttpUrl(url) && !isBlobUrl(url)) return null;

  const active = sources.find((s) => s.url === url);
  const duration = video.duration;
  const drm = !!(video as HTMLVideoElement & { mediaKeys?: unknown }).mediaKeys || !!options.drmElements?.has(video);

  return {
    url,
    origin: 'dom',
    type: active?.type,
    sources: sources.length > 1 ? sources : undefined,
    title: elementTitle(video, doc),
    posterUrl: video.poster || undefined,
    width: video.videoWidth || undefined,
    height: video.videoHeight || active?.height || undefined,
    durationSec: Number.isFinite(duration) && duration > 0 ? duration : undefined,
    isLive: duration === Infinity || undefined,
    drm: drm || undefined,
  };
}

const LINK_EXTENSIONS = new Set([...Object.keys(DIRECT_VIDEO_EXTENSIONS), 'm3u8', 'mpd']);

function linkVideo(anchor: HTMLAnchorElement, doc: Document): ContentVideo | null {
  const href = anchor.href;
  if (!isHttpUrl(href) || !LINK_EXTENSIONS.has(getUrlExtension(href))) return null;
  return {
    url: href,
    origin: 'link',
    title:
      clean(anchor.getAttribute('download')) ??
      clean(anchor.getAttribute('title')) ??
      clean(anchor.textContent, 120) ??
      documentTitle(doc),
  };
}

function metaVideos(doc: Document): ContentVideo[] {
  const out: ContentVideo[] = [];
  const title = documentTitle(doc);
  const image = doc.querySelector('meta[property="og:image"]')?.getAttribute('content') ?? undefined;
  for (const meta of doc.querySelectorAll('meta[property^="og:video"], meta[name="twitter:player:stream"]')) {
    const prop = meta.getAttribute('property') ?? meta.getAttribute('name') ?? '';
    if (/:(type|width|height|duration|tag|release_date|series|actor|director|writer)$/.test(prop)) continue;
    const content = meta.getAttribute('content') ?? '';
    let url: string;
    try {
      url = new URL(content, doc.baseURI).toString();
    } catch {
      continue;
    }
    const ext = getUrlExtension(url);
    if (!isHttpUrl(url) || !LINK_EXTENSIONS.has(ext)) continue;
    const width = Number(doc.querySelector('meta[property="og:video:width"]')?.getAttribute('content')) || undefined;
    const height = Number(doc.querySelector('meta[property="og:video:height"]')?.getAttribute('content')) || undefined;
    out.push({ url, origin: 'meta', title, posterUrl: image, width, height });
  }
  return out;
}

/** Collect every video the document exposes, deduplicated by URL. */
export function collectVideos(doc: Document, options: DetectOptions = {}): ContentVideo[] {
  const byUrl = new Map<string, ContentVideo>();
  const add = (v: ContentVideo | null) => {
    if (!v) return;
    const existing = byUrl.get(v.url);
    // DOM elements carry the richest metadata; they win over links/meta.
    if (!existing || (existing.origin !== 'dom' && v.origin === 'dom')) byUrl.set(v.url, { ...existing, ...v });
  };

  for (const video of deepQueryAll<HTMLVideoElement>(doc, 'video')) add(describeVideoElement(video, doc, options));
  let links = 0;
  for (const anchor of doc.querySelectorAll<HTMLAnchorElement>('a[href]')) {
    const v = linkVideo(anchor, doc);
    if (v) {
      add(v);
      if (++links >= MAX_LINKS) break;
    }
  }
  for (const v of metaVideos(doc)) add(v);
  return [...byUrl.values()];
}
