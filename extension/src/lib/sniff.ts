/** Pure classification of observed network responses (unit-testable without Chrome). */
import { classifyMediaUrl, looksLikeSegmentUrl } from '@clipkeeper/shared/url';
import type { NetworkHit } from './registry';

export interface ResponseDetails {
  tabId: number;
  url: string;
  type: string;
  statusCode: number;
  responseHeaders?: Array<{ name: string; value?: string }>;
}

/** Classify a webRequest response; returns a hit for complete files and manifests only. */
export function networkHitFromResponse(details: ResponseDetails): NetworkHit | null {
  if (details.tabId < 0 || details.statusCode >= 400) return null;
  const header = (name: string) => details.responseHeaders?.find((h) => h.name.toLowerCase() === name)?.value;
  const contentType = header('content-type');
  const classified = classifyMediaUrl(details.url, contentType);
  if (!classified) return null;
  if (classified.kind === 'direct') {
    // XHR/fetch video responses are MSE fragments, not standalone files.
    if (details.type === 'xmlhttprequest' || looksLikeSegmentUrl(details.url)) return null;
  }
  let sizeBytes: number | undefined;
  const range = /\/(\d+)\s*$/.exec(header('content-range') ?? '');
  if (range) sizeBytes = Number(range[1]);
  else if (details.statusCode === 200) sizeBytes = Number(header('content-length')) || undefined;
  return { url: details.url, contentType, sizeBytes };
}
