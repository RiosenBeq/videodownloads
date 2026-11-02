# Clipkeeper — Implementation Plan

Clipkeeper is a Manifest V3 Chrome extension plus an optional local helper
service that detects videos on the active tab and saves the ones the user is
allowed to keep. This document is the plan the code was built from; it is kept
in the repo so future changes can be checked against the original intent.

## 1. Goals and non-goals

**Goals**

- Detect every video a page exposes: `<video>`/`<source>` elements, video links,
  `og:video` metadata, HLS/DASH manifests the player requests, and videos that
  are injected later (MutationObserver) or live in accessible iframes.
- Download direct files (MP4, WebM, MOV, …) with no extra software, via the
  Chrome Downloads API.
- Download unencrypted HLS and DASH streams through the local helper, which
  fetches segments itself and remuxes them with FFmpeg.
- Optional yt-dlp integration, off by default and restricted to domains the
  user explicitly lists.
- Progress, speed, ETA, pause/resume/cancel, retries, duplicate prevention,
  history, notifications, folder selection, custom file names, remembered
  preferences, dark/light themes.

**Non-goals (by design)**

- No DRM circumvention. Pages using Encrypted Media Extensions, HLS streams with
  `#EXT-X-KEY` (any method other than `NONE`) and DASH manifests with
  `ContentProtection` are reported as *Protected* and are never downloaded.
- No authentication bypass. The helper never receives cookies; it can only
  fetch what is publicly reachable. Browser-engine downloads use the user's own
  session exactly like "Save video as…".
- Live streams are reported but not recorded.
- No telemetry. Nothing leaves the machine except the media requests the user
  initiates.

## 2. Architecture

```
┌──────────────────── Chrome ────────────────────┐        ┌──────── Local helper (Node) ────────┐
│ content script (all frames)                    │        │ Fastify on 127.0.0.1:47321           │
│   DOM scan + MutationObserver + EME detection  │        │  auth: Host check, Origin check,     │
│            │ runtime message                   │        │        Bearer token (timing-safe)    │
│ service worker                                 │  HTTP  │  zod-validated routes                │
│   per-tab registry (storage.session)           │◀──────▶│  JobManager (queue, dedupe, persist) │
│   webRequest sniffer (manifests, media)        │ token  │   ├ DirectRunner (Range resume)      │
│   manifest probe (HLS/DASH parse)              │        │   ├ HlsRunner  (segments → FFmpeg)   │
│   download orchestration + notifications       │        │   ├ DashRunner (segments → FFmpeg)   │
│ popup (React)  options page (React)            │        │   └ YtDlpRunner (opt-in, allowlist)  │
│ chrome.downloads for direct files              │        │  safeRequest: DNS-pinned SSRF guard  │
└────────────────────────────────────────────────┘        └──────────────────────────────────────┘
                     shared/: types, zod schemas, URL classification,
                     HLS/DASH parsers, filename sanitizer, quality picker
```

### Packages

| Path         | Purpose |
|--------------|---------|
| `shared/`    | Types, API contract, zod schemas, HLS/DASH parsers, filename + URL utilities. Used by both sides. |
| `backend/`   | Fastify helper service, downloaders, SSRF guard, dependency detection, CLI. |
| `extension/` | MV3 extension: content script, service worker, React popup + options page. |
| `tests/`     | Cross-package integration tests (extension client ↔ real backend ↔ local media server) and the Playwright end-to-end run. |
| `docs/`      | This plan, architecture/security notes, API reference, install guides. |

## 3. Detection pipeline

1. **Content script** (`all_frames`, `match_about_blank`) scans the DOM, including
   open shadow roots, for `<video>`, `<source>`, `<a href="*.mp4">` and
   `og:video` meta tags. It records `currentSrc`, every `<source>` (with
   `size`/`label`/`res` hints), poster, intrinsic resolution, duration, live
   state and whether the element has `mediaKeys` or fired `encrypted` (EME/DRM).
   A debounced MutationObserver plus `loadedmetadata` listeners re-report.
2. **Service worker sniffer** watches `webRequest.onHeadersReceived` for manifests
   (`.m3u8`, `.mpd`, mpegurl / dash+xml content types) and media responses.
   Segment requests (`.ts`, `.m4s`, MSE range fetches) are ignored.
3. **Registry** merges both sources by URL hash per tab, stored in
   `chrome.storage.session` so it survives service-worker restarts, and is
   cleared on navigation/tab close. The action badge shows the count.
4. **Probe**: manifests are fetched by the service worker and parsed with the
   shared parsers → variants (resolution, bitrate, codecs, estimated size),
   duration, live and encryption status. Variant playlists of a known master
   are hidden. Direct files get a `HEAD` for size when unknown.

## 4. Download pipeline

| Source           | Engine                       | Notes |
|------------------|------------------------------|-------|
| Direct file      | `chrome.downloads` (default) or helper | Browser engine supports pause/resume/cancel natively and works without the helper. |
| HLS (`.m3u8`)    | Helper `HlsRunner`           | Master → variant + audio rendition, segments with byte ranges and `EXT-X-MAP`, concurrent fetch, concat, FFmpeg remux to MP4. |
| DASH (`.mpd`)    | Helper `DashRunner`          | `SegmentTemplate` (`$Number$`/`$Time$`, `SegmentTimeline`), `SegmentList`, `SegmentBase`; video + audio merged by FFmpeg. |
| Page URL         | Helper `YtDlpRunner`         | Disabled by default; domain allowlist; no cookies; `--` before URL. |
| Blob / MSE       | —                            | Explained to the user; the stream manifest is offered instead when visible. |
| DRM / encrypted  | —                            | Refused, with an explanation. |

Job lifecycle: `queued → downloading → (merging) → completed | failed | canceled`,
with `paused` reachable from `queued`/`downloading`. Pause aborts the runner but
keeps partial data (`.part` file or downloaded segments); resume restarts the
runner, which skips finished work. Transient errors (network resets, 5xx, 429)
are retried with exponential backoff. Duplicate requests for an active job
return `409 DUPLICATE`. Finished jobs are written to history; active jobs are
persisted so they survive a helper restart (resumed as `paused`).

## 5. Security model

- Helper binds to `127.0.0.1` only.
- Every `/api/*` route except `/api/health` requires `Authorization: Bearer
  <token>`; the 256-bit token is generated on first run, stored with `0600`
  permissions and compared with `crypto.timingSafeEqual`.
- `Host` must be `127.0.0.1|localhost|[::1]:<port>` (DNS-rebinding defence);
  any `Origin` must be `chrome-extension://…` (optionally pinned to an ID).
- Repeated auth failures are rate-limited.
- All bodies are validated with strict zod schemas; bodies are capped at 64 KB.
- **SSRF**: only `http(s)`, no URL credentials; the DNS lookup used for the
  actual socket rejects loopback/private/link-local/CGNAT/multicast/reserved
  ranges (IPv4, IPv6, IPv4-mapped, NAT64, 6to4); every redirect hop and every
  segment URL is re-validated; optional domain allow/block lists.
- FFmpeg only ever reads local files (`-protocol_whitelist file,pipe`); segments
  are downloaded by the guarded client, not by FFmpeg.
- **Filesystem**: download folder must be an absolute, writable, non-system
  directory; file names are sanitized (reserved names, control characters,
  separators, length); final paths are verified to stay inside the folder.
- No endpoint executes caller-supplied commands. The only processes spawned are
  FFmpeg, yt-dlp, the native folder picker and the file-manager "reveal", all
  with fixed argument vectors and no shell.

## 6. UI

Popup (400 px): header with backend status, segmented tabs *Videos / Downloads
/ History*. Video cards show poster, title, site, format, resolution, size,
duration, availability badge, quality selector, editable file name and a
download button. Download cards show a progress bar, percentage, speed, ETA,
bytes, and pause/resume/cancel/retry/show-in-folder. The options page covers
helper pairing, dependency status with install commands, quality/container
defaults, file-name template, engine choice, folders, notifications, domain
policy, yt-dlp opt-in, theme and data management.

## 7. Testing

- **Unit (Vitest)**: filename sanitizer, URL classification, HLS/DASH parsers,
  quality picker, formatters, IP range checks, URL policy, path containment,
  auth hook, job manager (dedupe, pause/resume/cancel), DOM detector (jsdom),
  registry merge logic.
- **Integration**: real helper (in-process, temp config dir) + local media
  server serving FFmpeg-generated MP4/WebM/HLS/DASH fixtures, driven through
  the extension's `BackendClient`: auth rejection, probe, direct/HLS/DASH
  downloads verified with `ffprobe`, pause/resume, cancel, duplicates, SSRF
  refusal, encrypted-stream refusal, history.
- **End-to-end (Playwright + Chromium)**: loads the built extension, opens a
  local test page (direct MP4, WebM sources, injected video, iframe video, blob
  video, HLS/DASH manifests), checks the popup's detection list and completes
  a browser-engine download and a helper HLS download.
