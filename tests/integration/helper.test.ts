/**
 * Extension ↔ helper integration: the extension's HelperClient talks to a real
 * helper over HTTP, which downloads from a local media server. Outputs are
 * verified with ffprobe.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { DownloadJob, JobStatus } from '@clipkeeper/shared';
import { createHelper, type Helper } from '../../backend/src/server';
import { HelperClient, HelperError } from '../../extension/src/lib/api';
import { ensureFixtures } from '../../scripts/make-fixtures.mjs';
import { startMediaServer, type MediaServer } from '../helpers/mediaServer';

let fixtures: string;
let media: MediaServer;
let helper: Helper;
let client: HelperClient;
let baseUrl: string;
let tmp: string;
let downloadDir: string;

function ffprobe(file: string): { streams: Array<{ codec_type: string; codec_name: string }>; duration: number } {
  const out = execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type,codec_name:format=duration', '-of', 'json', file], {
    encoding: 'utf8',
  });
  const json = JSON.parse(out) as { streams: Array<{ codec_type: string; codec_name: string }>; format: { duration: string } };
  return { streams: json.streams, duration: Number(json.format.duration) };
}

async function waitFor(id: string, predicate: (job: DownloadJob) => boolean, timeoutMs = 45_000): Promise<DownloadJob> {
  const deadline = Date.now() + timeoutMs;
  let job: DownloadJob | undefined;
  while (Date.now() < deadline) {
    job = (await client.getJob(id)).job;
    if (predicate(job)) return job;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`Timed out waiting for job ${id}; last state: ${JSON.stringify(job)}`);
}

const finished = (job: DownloadJob) => (['completed', 'failed', 'canceled'] as JobStatus[]).includes(job.status);

async function expectHelperError(promise: Promise<unknown>, code: string): Promise<HelperError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(HelperError);
    expect((error as HelperError).code).toBe(code);
    return error as HelperError;
  }
  throw new Error(`Expected HelperError ${code}`);
}

beforeAll(async () => {
  fixtures = ensureFixtures();
  media = await startMediaServer(fixtures);
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'clipkeeper-it-'));
  downloadDir = path.join(tmp, 'downloads');
  helper = await createHelper({
    home: path.join(tmp, 'home'),
    overrides: { port: 0, settings: { downloadDir, allowPrivateNetwork: true } },
    system: { chooseFolder: async () => path.join(tmp, 'chosen'), reveal: async () => undefined },
  });
  baseUrl = (await helper.listen()).url;
  client = new HelperClient({ baseUrl, token: helper.config.token });
});

afterAll(async () => {
  await helper?.close();
  await media?.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

beforeEach(async () => {
  await helper.config.updateSettings({ allowedDomains: [], blockedDomains: [], allowPrivateNetwork: true });
});

describe('connection and authentication', () => {
  it('reports health without a token', async () => {
    const health = await new HelperClient({ baseUrl, token: '' }).health();
    expect(health).toMatchObject({ ok: true, name: 'clipkeeper-helper', apiVersion: 1 });
  });

  it('rejects missing and wrong tokens', async () => {
    await expectHelperError(new HelperClient({ baseUrl, token: '' }).listJobs(), 'UNAUTHORIZED');
    await expectHelperError(new HelperClient({ baseUrl, token: 'x'.repeat(43) }).listJobs(), 'UNAUTHORIZED');
  });

  it('rejects requests from web page origins and foreign Host headers', async () => {
    const request = (headers: Record<string, string>) =>
      new Promise<number>((resolve, reject) => {
        const req = http.request(`${baseUrl}/api/jobs`, { headers: { authorization: `Bearer ${helper.config.token}`, ...headers } }, (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        });
        req.on('error', reject);
        req.end();
      });
    expect(await request({ origin: 'https://evil.example' })).toBe(403);
    expect(await request({ host: 'attacker.example:80' })).toBe(403);
    expect(await request({ origin: `chrome-extension://${'a'.repeat(32)}` })).toBe(200);
  });

  it('returns status with dependency detection', async () => {
    const status = await client.status();
    expect(status.dependencies.ffmpeg.found).toBe(true);
    expect(status.settings.downloadDir).toBe(downloadDir);
  });
});

describe('probing', () => {
  it('probes a direct MP4', async () => {
    const result = await client.probe({ url: `${media.url}/sample.mp4`, kind: 'direct' });
    expect(result.availability).toBe('available');
    expect(result.sizeBytes).toBe(fs.statSync(path.join(fixtures, 'sample.mp4')).size);
    expect(result.mimeType).toBe('video/mp4');
  });

  it('probes an HLS master playlist', async () => {
    const result = await client.probe({ url: `${media.url}/hls-ts/master.m3u8`, kind: 'hls' });
    expect(result.availability).toBe('needs-backend');
    expect(result.variants.map((v) => v.height)).toEqual([720, 360]);
    expect(result.durationSec).toBeCloseTo(6, 0);
    expect(result.variants[0].sizeBytes).toBeGreaterThan(0);
  });

  it('probes a DASH manifest', async () => {
    const result = await client.probe({ url: `${media.url}/dash/manifest.mpd`, kind: 'dash' });
    expect(result.availability).toBe('needs-backend');
    expect(result.variants.map((v) => v.height)).toEqual([720, 360]);
  });

  it('flags encrypted HLS as protected and live playlists as live', async () => {
    expect((await client.probe({ url: `${media.url}/hls-enc/index.m3u8`, kind: 'hls' })).availability).toBe('drm');
    expect((await client.probe({ url: `${media.url}/live/index.m3u8`, kind: 'hls' })).availability).toBe('live');
  });
});

describe('downloads', () => {
  it('downloads a direct MP4 and records history', async () => {
    const { job } = await client.createJob({ url: `${media.url}/sample.mp4`, kind: 'direct', title: 'Direct sample' });
    expect(job.status).toMatch(/queued|downloading/);
    const done = await waitFor(job.id, finished);
    expect(done.status).toBe('completed');
    expect(done.filename).toBe('Direct sample.mp4');
    expect(fs.statSync(done.filePath!).size).toBe(fs.statSync(path.join(fixtures, 'sample.mp4')).size);
    expect(fs.realpathSync(path.dirname(done.filePath!))).toBe(fs.realpathSync(downloadDir));
    const { entries } = await client.history();
    expect(entries.find((e) => e.jobId === job.id)).toMatchObject({ status: 'completed', title: 'Direct sample' });
  });

  it('downloads a WebM with the right extension', async () => {
    const { job } = await client.createJob({ url: `${media.url}/sample.webm`, kind: 'direct', title: 'Webm sample' });
    const done = await waitFor(job.id, finished);
    expect(done.status).toBe('completed');
    expect(done.filename).toBe('Webm sample.webm');
    expect(ffprobe(done.filePath!).streams.map((s) => s.codec_name).sort()).toEqual(['opus', 'vp9']);
  });

  it('downloads an HLS (MPEG-TS) stream at the requested quality and remuxes to MP4', async () => {
    const { variants } = await client.probe({ url: `${media.url}/hls-ts/master.m3u8`, kind: 'hls' });
    const low = variants.find((v) => v.height === 360)!;
    const { job } = await client.createJob({ url: `${media.url}/hls-ts/master.m3u8`, kind: 'hls', variantId: low.id, title: 'HLS TS' });
    const done = await waitFor(job.id, finished);
    expect(done.status).toBe('completed');
    expect(done.filename).toBe('HLS TS.mp4');
    expect(done.segmentsTotal).toBe(3);
    const probe = ffprobe(done.filePath!);
    expect(probe.streams.map((s) => s.codec_type).sort()).toEqual(['audio', 'video']);
    expect(probe.duration).toBeGreaterThan(5);
    expect(done.variantLabel).toMatch(/^360p/);
  });

  it('downloads fMP4 HLS with a separate audio rendition and merges both tracks', async () => {
    const { job } = await client.createJob({ url: `${media.url}/hls-fmp4/master.m3u8`, kind: 'hls', quality: 'highest', title: 'HLS fMP4' });
    const done = await waitFor(job.id, finished);
    expect(done.status, done.error).toBe('completed');
    const probe = ffprobe(done.filePath!);
    expect(probe.streams.map((s) => s.codec_name).sort()).toEqual(['aac', 'h264']);
    expect(done.variantLabel).toMatch(/^720p/);
  });

  it('downloads a DASH stream and merges video with audio', async () => {
    const { job } = await client.createJob({ url: `${media.url}/dash/manifest.mpd`, kind: 'dash', quality: '1080', title: 'DASH sample' });
    const done = await waitFor(job.id, finished);
    expect(done.status, done.error).toBe('completed');
    const probe = ffprobe(done.filePath!);
    expect(probe.streams.map((s) => s.codec_type).sort()).toEqual(['audio', 'video']);
    expect(probe.duration).toBeGreaterThan(5);
  });

  it('refuses encrypted streams', async () => {
    const { job } = await client.createJob({ url: `${media.url}/hls-enc/index.m3u8`, kind: 'hls', title: 'Encrypted' });
    const done = await waitFor(job.id, finished);
    expect(done.status).toBe('failed');
    expect(done.errorCode).toBe('DRM_PROTECTED');
    expect(done.error).toMatch(/encrypted/i);
  });

  it('refuses live streams', async () => {
    const { job } = await client.createJob({ url: `${media.url}/live/index.m3u8`, kind: 'hls', title: 'Live' });
    const done = await waitFor(job.id, finished);
    expect(done.errorCode).toBe('LIVE_UNSUPPORTED');
  });

  it('reports a clear error when a link returns a web page', async () => {
    const { job } = await client.createJob({ url: `${media.url}/html-instead.mp4`, kind: 'direct', title: 'Expired' });
    const done = await waitFor(job.id, finished);
    expect(done.status).toBe('failed');
    expect(done.errorCode).toBe('NOT_VIDEO');
  });

  it('retries after a dropped connection and resumes with a Range request', async () => {
    const { job } = await client.createJob({ url: `${media.url}/flaky/large.mp4`, kind: 'direct', title: 'Flaky' });
    const done = await waitFor(job.id, finished);
    expect(done.status, done.error).toBe('completed');
    expect(done.retryCount).toBeGreaterThanOrEqual(1);
    expect(fs.statSync(done.filePath!).size).toBe(fs.statSync(path.join(fixtures, 'large.mp4')).size);
    expect(media.requests.some((r) => r.includes('/flaky/large.mp4') && /\[bytes=\d+-\]/.test(r))).toBe(true);
  });

  it('pauses, resumes from the partial file and completes; reports speed and ETA while running', async () => {
    const url = `${media.url}/large.mp4?throttle=1500000`;
    const { job } = await client.createJob({ url, kind: 'direct', title: 'Pausable' });
    const running = await waitFor(job.id, (j) => j.bytesDownloaded > 1_000_000 && j.speedBps !== undefined);
    expect(running.status).toBe('downloading');
    expect(running.totalBytes).toBe(fs.statSync(path.join(fixtures, 'large.mp4')).size);
    expect(running.etaSec).toBeGreaterThan(0);
    expect(running.progress).toBeGreaterThan(0);

    await client.jobAction(job.id, 'pause');
    const paused = await waitFor(job.id, (j) => j.status === 'paused');
    const partial = path.join(downloadDir, '.clipkeeper-partial', job.id, 'download.part');
    expect(fs.statSync(partial).size).toBeGreaterThan(0);

    await expectHelperError(client.jobAction(job.id, 'pause'), 'INVALID_STATE');
    await client.jobAction(job.id, 'resume');
    const done = await waitFor(job.id, finished);
    expect(done.status).toBe('completed');
    expect(fs.statSync(done.filePath!).size).toBe(fs.statSync(path.join(fixtures, 'large.mp4')).size);
    expect(paused.bytesDownloaded).toBeGreaterThan(0);
    expect(media.requests.some((r) => r.startsWith('GET /large.mp4?throttle') && /\[bytes=[1-9]\d*-\]/.test(r))).toBe(true);
  });

  it('cancels a running download and cleans up partial data', async () => {
    const { job } = await client.createJob({ url: `${media.url}/large.mp4?throttle=800000`, kind: 'direct', title: 'Cancel me' });
    await waitFor(job.id, (j) => j.bytesDownloaded > 0);
    const { job: canceled } = await client.jobAction(job.id, 'cancel');
    expect(canceled.status).toBe('canceled');
    expect(fs.existsSync(path.join(downloadDir, '.clipkeeper-partial', job.id))).toBe(false);
    expect(fs.existsSync(path.join(downloadDir, 'Cancel me.mp4'))).toBe(false);
    await client.removeJob(job.id);
    await expectHelperError(client.getJob(job.id), 'NOT_FOUND');
  });

  it('prevents duplicate downloads (active and already downloaded)', async () => {
    const url = `${media.url}/sample.webm?throttle=200000`;
    const { job } = await client.createJob({ url, kind: 'direct', title: 'Dup' });
    const active = await expectHelperError(client.createJob({ url, kind: 'direct', title: 'Dup' }), 'DUPLICATE');
    expect((active.details as { jobId: string }).jobId).toBe(job.id);
    await waitFor(job.id, finished);

    const again = await expectHelperError(client.createJob({ url, kind: 'direct', title: 'Dup' }), 'DUPLICATE');
    expect((again.details as { inHistory: boolean }).inHistory).toBe(true);

    const { job: forced } = await client.createJob({ url, kind: 'direct', title: 'Dup', force: true });
    const done = await waitFor(forced.id, finished);
    expect(done.filename).toBe('Dup (1).webm');
  });

  it('sanitizes hostile file names and keeps files inside the download folder', async () => {
    const { job } = await client.createJob({ url: `${media.url}/sample.mp4`, kind: 'direct', filename: '../../../etc/evil:name?.mp4', force: true });
    const done = await waitFor(job.id, finished);
    expect(done.status).toBe('completed');
    expect(fs.realpathSync(path.dirname(done.filePath!))).toBe(fs.realpathSync(downloadDir));
    expect(done.filename).not.toMatch(/[/\\:?]/);
  });
});

describe('policy and settings', () => {
  it('blocks private-network sources unless explicitly allowed (SSRF guard)', async () => {
    await helper.config.updateSettings({ allowPrivateNetwork: false });
    await expectHelperError(client.createJob({ url: `${media.url}/sample.mp4`, kind: 'direct' }), 'URL_NOT_ALLOWED');
    await expectHelperError(client.createJob({ url: 'http://169.254.169.254/latest/meta-data', kind: 'direct' }), 'URL_NOT_ALLOWED');
    await expectHelperError(client.probe({ url: `${media.url}/hls-ts/master.m3u8`, kind: 'hls' }), 'URL_NOT_ALLOWED');
  });

  it('re-validates redirects', async () => {
    await helper.config.updateSettings({ allowPrivateNetwork: true, blockedDomains: ['localhost'] });
    const target = `http://localhost:${media.port}/sample.mp4`;
    const { job } = await client.createJob({ url: `${media.url}/redirect?to=${encodeURIComponent(target)}`, kind: 'direct', title: 'Redirected', force: true });
    const done = await waitFor(job.id, finished);
    expect(done.status).toBe('failed');
    expect(done.errorCode).toBe('URL_NOT_ALLOWED');
  });

  it('enforces the allowed-domain list', async () => {
    await client.updateSettings({ allowedDomains: ['media.example.com'] });
    await expectHelperError(client.createJob({ url: `${media.url}/sample.mp4`, kind: 'direct' }), 'URL_NOT_ALLOWED');
  });

  it('keeps yt-dlp disabled by default', async () => {
    await expectHelperError(client.createJob({ url: 'https://example.com/watch?v=1', kind: 'page' }), 'YTDLP_DISABLED');
  });

  it('validates settings', async () => {
    await expectHelperError(client.updateSettings({ downloadDir: 'relative/path' }), 'BAD_REQUEST');
    await expectHelperError(client.updateSettings({ downloadDir: '/etc' }), 'FORBIDDEN');
    await expectHelperError(client.updateSettings({ maxConcurrent: 50 } as never), 'BAD_REQUEST');
    await expectHelperError(client.updateSettings({ allowedDomains: ['not a domain'] }), 'BAD_REQUEST');
    const { settings } = await client.updateSettings({ maxConcurrent: 3 });
    expect(settings.maxConcurrent).toBe(3);
  });

  it('chooses a folder through the native picker integration', async () => {
    const result = await client.chooseFolder();
    expect(result.path).toBe(fs.realpathSync(path.join(tmp, 'chosen')));
    await client.updateSettings({ downloadDir });
  });

  it('rejects malformed requests with a clear error', async () => {
    await expectHelperError(client.createJob({ url: 'file:///etc/passwd', kind: 'direct' }), 'BAD_REQUEST');
    await expectHelperError(client.createJob({ url: 'https://e.com/a', kind: 'shell' } as never), 'BAD_REQUEST');
    await expectHelperError(client.jobAction('j_doesnotexist', 'pause'), 'NOT_FOUND');
  });

  it('removes history entries', async () => {
    const { entries } = await client.history();
    expect(entries.length).toBeGreaterThan(0);
    await client.removeHistory(entries[0].id);
    expect((await client.history()).entries.find((e) => e.id === entries[0].id)).toBeUndefined();
  });
});
