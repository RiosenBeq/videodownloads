# Security and compliance notes

## Scope

Clipkeeper helps people save videos they own or are allowed to keep. These are deliberately **not** goals:

- getting around DRM (Widevine/PlayReady/FairPlay/EME) or stream encryption (HLS AES-128 / SAMPLE-AES, CENC);
- getting around sign-ins, paywalls, geo-blocks or rate limits;
- recording live streams.

These checks are built in and covered by tests:

| Check | Where |
|---|---|
| EME players (`video.mediaKeys`, `encrypted` event) → **Protected** | `extension/src/content/detect.ts`, `content/index.ts` |
| A page with DRM marks all of its streams as protected | `extension/src/background/detection.ts` (`applyDrm`) |
| HLS `#EXT-X-KEY` / `#EXT-X-SESSION-KEY` with any method other than `NONE` → refused | `shared/src/hls.ts`, `backend/src/jobs/hls.ts` |
| DASH `ContentProtection` anywhere → refused | `shared/src/dash.ts`, `backend/src/jobs/dash.ts` |
| yt-dlp formats with `has_drm` are dropped; DRM errors are reported as such | `backend/src/jobs/ytdlp.ts` |
| Probes can never relax a page-level DRM verdict | `extension/src/background/detection.ts` (`probeOne`) |

## Threat model for the local helper

The helper listens on localhost and can write files. The main threats are web pages trying to use it (CSRF or DNS rebinding), other local users or processes, and hostile media URLs (SSRF or path traversal).

| Threat | Mitigation |
|---|---|
| A web page calls the API | No CORS headers for web origins; any non-extension `Origin` gets 403; a bearer token is required |
| DNS rebinding (`evil.com` → 127.0.0.1) | `Host` must be a loopback name on the helper's port |
| Token guessing | 256-bit random token, constant-time comparison, rate limit on failed attempts |
| Token theft from disk | Config file written `0600` inside a `0700` folder |
| Network exposure | Binds to `127.0.0.1` only |
| SSRF to internal services or cloud metadata | DNS lookup checked per connection, IP-literal checks, redirect and segment URLs re-checked, private ranges blocked by default |
| FFmpeg used as an SSRF or file-read tool | FFmpeg only reads files the helper downloaded (`-protocol_whitelist file,pipe`) |
| Path traversal through file names | Sanitizer plus a check that every resolved path stays inside the download folder; collision-free names |
| Download folder set to a system path | Absolute path required; system folders denied; write test before saving |
| Command injection | `spawn` without a shell and with fixed argument lists; yt-dlp gets `--ignore-config --no-exec` and `--` before the URL; format selectors are allow-listed |
| Resource exhaustion | 64 KB body limit, 10–20 MB manifest cap, segment-count cap, bounded concurrency, socket timeouts |
| Malicious extension messages | The service worker accepts download/probe messages only from its own extension pages; content scripts can only report detections |

## Privacy

- Nothing is sent to any server other than the media host itself (and the local helper).
- Detected media is kept in `chrome.storage.session` per tab and dropped when you navigate away.
- History is stored locally: `chrome.storage.local` for Chrome downloads, and the helper's `history.json`. It can be cleared from Settings.
- The extension asks for `<all_urls>` and `webRequest` so it can see media elements and manifest requests on the pages you visit. This data never leaves the browser.

## Reporting

If you find a way around one of these protections, please report it privately to the maintainers instead of opening a public issue.
