/**
 * Content script (all frames). Scans the DOM for videos, watches for videos
 * added later, notes EME/DRM usage, and reports to the service worker. It
 * never reads page data beyond media elements, links to media and og:video.
 */
import type { ContentReport, RuntimeMessage } from '../lib/messages';
import { collectVideos } from './detect';

const drmElements = new WeakSet<Element>();
const isTop = window === window.top;
let timer: ReturnType<typeof setTimeout> | undefined;
let lastSignature = '';

function report(force = false): void {
  let videos;
  try {
    videos = collectVideos(document, { drmElements });
  } catch {
    return;
  }
  const signature = JSON.stringify(videos);
  if (!force && signature === lastSignature) return;
  // Sub-frames without videos stay silent unless they previously reported some.
  if (!isTop && !videos.length && !lastSignature) return;
  lastSignature = signature;
  const message: ContentReport = {
    type: 'content:report',
    frameUrl: location.href,
    pageTitle: document.title,
    isTop,
    videos,
  };
  chrome.runtime.sendMessage(message).catch(() => {
    /* extension reloaded or service worker unavailable */
  });
}

function schedule(delay = 400): void {
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => report(), delay);
}

// EME: the `encrypted` event fires when protected media starts. It does not bubble, so capture it.
document.addEventListener(
  'encrypted',
  (event) => {
    if (event.target instanceof Element) drmElements.add(event.target);
    schedule(50);
  },
  true,
);

for (const type of ['loadedmetadata', 'durationchange', 'emptied', 'loadstart', 'play']) {
  document.addEventListener(type, (event) => event.target instanceof HTMLMediaElement && schedule(200), true);
}

const isMediaNode = (node: Node): boolean =>
  node instanceof Element && (node.nodeName === 'VIDEO' || node.nodeName === 'SOURCE' || !!node.querySelector?.('video, source'));

new MutationObserver((mutations) => {
  for (const m of mutations) {
    if (m.type === 'attributes' && (m.target.nodeName === 'VIDEO' || m.target.nodeName === 'SOURCE')) return schedule();
    if (m.type === 'childList' && [...m.addedNodes, ...m.removedNodes].some(isMediaNode)) return schedule();
  }
}).observe(document.documentElement ?? document, { childList: true, subtree: true, attributes: true, attributeFilter: ['src'] });

if (isTop) {
  // Titles often change after load (SPAs); keep the reported page title current.
  const titleEl = document.querySelector('title');
  if (titleEl) new MutationObserver(() => schedule(600)).observe(titleEl, { childList: true, characterData: true, subtree: true });
}

chrome.runtime.onMessage.addListener((message: RuntimeMessage, _sender, sendResponse) => {
  if (message?.type === 'content:rescan') {
    report(true);
    sendResponse({ ok: true });
  }
  return false;
});

report(true);
// Late players (lazy-loaded, shadow DOM) — a few follow-up scans after load.
for (const delay of [1500, 4000, 10000]) setTimeout(() => report(), delay);
