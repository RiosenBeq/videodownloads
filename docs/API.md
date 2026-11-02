# Helper HTTP API

Base URL: `http://127.0.0.1:47321`. All bodies are JSON. Request schemas live in [`shared/src/api.ts`](../shared/src/api.ts) and are enforced with strict zod validation, so unknown fields are rejected. The typed client is [`extension/src/lib/api.ts`](../extension/src/lib/api.ts).

## Authentication

Every route except `GET /api/health` needs:

```
Authorization: Bearer <token>
```

The token is printed when the helper starts (`npm run token`). Requests are also rejected when:

- `Host` is not `127.0.0.1`, `localhost` or `[::1]` on the helper's port → `403 FORBIDDEN`;
- `Origin` is present and isn't `chrome-extension://<id>` (or isn't one of `allowedExtensionIds`, when that list is set) → `403 FORBIDDEN`;
- there have been more than 30 failed token attempts within a minute → `429 RATE_LIMITED`.

## Errors

```json
{ "error": { "code": "DUPLICATE", "message": "This video was already downloaded.", "details": { "inHistory": true } } }
```

| Code | HTTP | Meaning |
|---|---|---|
| `BAD_REQUEST` | 400 | Validation failed (`details` lists each field) |
| `UNAUTHORIZED` | 401 | Missing or invalid token |
| `FORBIDDEN` | 403 | Host/Origin rejected, or a system folder was chosen |
| `URL_NOT_ALLOWED` | 403 | Scheme, credentials, domain policy, or a private/reserved address (SSRF guard) |
| `YTDLP_DISABLED` | 403 | yt-dlp is off, or the domain isn't in its list |
| `NOT_FOUND` | 404 | Unknown job or history entry |
| `DUPLICATE` | 409 | Same job already active (`details.jobId`), or already downloaded (`details.inHistory`) |
| `INVALID_STATE` | 409 | The action isn't valid in the job's current state |
| `DRM_PROTECTED`, `LIVE_UNSUPPORTED`, `UNSUPPORTED`, `NOT_VIDEO` | 422 | Media can't be saved |
| `DEPENDENCY_MISSING` | 424 | FFmpeg or yt-dlp isn't installed |
| `RATE_LIMITED` | 429 | Too many failed auth attempts |
| `NETWORK` | 502 | The upstream server failed |

Job failures are reported in the job itself (`status: "failed"`, `errorCode`, `error`).

## Routes

### `GET /api/health` (no auth)
`{ "ok": true, "name": "clipkeeper-helper", "version": "1.0.0", "apiVersion": 1 }`

### `GET /api/status`
Returns the version, `dependencies` (`ffmpeg`, `ffprobe`, `ytDlp`, each `{found, path, version}`, plus `installHints`), current `settings` and `activeJobs`.

### `GET /api/dependencies[?refresh=1]`
Detects installed tools again.

### `GET /api/settings` · `PUT /api/settings`
Takes a partial update of:

| Field | Type |
|---|---|
| `downloadDir` | absolute path; must be writable and not a system folder |
| `maxConcurrent` | 1–6 |
| `segmentConcurrency` | 1–16 |
| `maxRetries` | 0–10 |
| `allowedDomains`, `blockedDomains`, `ytDlpDomains` | string[] of hostnames |
| `allowPrivateNetwork`, `ytDlpEnabled` | boolean |
| `allowedExtensionIds` | string[] of 32-character extension ids |

### `POST /api/settings/choose-folder`
Opens the operating system's folder picker and saves the chosen folder. Returns `{ path, settings }` or `{ canceled: true }`.

### `POST /api/probe`
```json
{ "url": "https://cdn.example.com/master.m3u8", "kind": "hls", "pageUrl": "https://example.com/watch" }
```
`kind` is one of `direct | hls | dash | page`. The response has `availability`, `reason`, `durationSec`, `sizeBytes` (with `sizeEstimated`), `isLive` and `variants[]` (`id`, `label`, `width`, `height`, `bandwidth`, `codecs`, `sizeBytes`, `formatId`).

### `GET /api/jobs` · `GET /api/jobs/:id`
Returns job objects with these fields: `id`, `engine`, `status` (`queued | downloading | merging | paused | completed | failed | canceled`), `bytesDownloaded`, `totalBytes`, `totalEstimated`, `progress` (0–1), `speedBps`, `etaSec`, `segmentsDone`, `segmentsTotal`, `phase`, `filename`, `filePath`, `error`, `errorCode` and `retryCount`.

### `POST /api/jobs` → `201 { job }`
```json
{
  "url": "https://cdn.example.com/master.m3u8",
  "kind": "hls",
  "title": "Product launch",
  "filename": "Launch 2026",
  "variantId": "h_1x2y3z",
  "quality": "1080",
  "container": "mp4",
  "pageUrl": "https://example.com/watch",
  "force": false
}
```
All fields except `url` and `kind` are optional. Without `variantId`, the helper picks the best variant within `quality` (default `highest`). `force: true` skips the already-downloaded check, but never the active-duplicate check.

### `POST /api/jobs/:id/{pause|resume|cancel|retry}` · `POST /api/jobs/:id/reveal` · `DELETE /api/jobs/:id`
`reveal` opens Finder or Explorer at the finished file. `DELETE` removes a finished job from the list; the file stays on disk.

### `GET /api/history[?limit=N]` · `DELETE /api/history/:id` · `DELETE /api/history` · `POST /api/history/:id/reveal`
