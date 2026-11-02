import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DownloadJob, JobEngine } from '@clipkeeper/shared';
import type { Runner, RunnerContext } from '../src/jobs/types';
import { createHelper, tokensMatch, type Helper } from '../src/server';

/** A controllable runner: progresses in steps and honours abort signals. */
class FakeRunner implements Runner {
  static runs = 0;
  constructor(private readonly behaviour: 'ok' | 'fail' | 'slow' = 'ok') {}

  async run(ctx: RunnerContext): Promise<string> {
    FakeRunner.runs++;
    if (this.behaviour === 'fail') throw new Error('boom');
    const steps = this.behaviour === 'slow' ? 200 : 3;
    for (let i = 1; i <= steps; i++) {
      if (ctx.signal.aborted) throw ctx.signal.reason;
      ctx.update({ bytesDownloaded: i * 100, totalBytes: steps * 100 });
      await new Promise((r) => setTimeout(r, 10));
    }
    const tmp = path.join(ctx.workDir, 'out.bin');
    fs.writeFileSync(tmp, Buffer.alloc(steps * 100));
    return ctx.finalize(tmp, 'mp4');
  }
}

let tmp: string;
let helper: Helper;
let behaviour: 'ok' | 'fail' | 'slow';
const host = () => ({ host: '127.0.0.1' });

async function makeHelper() {
  return createHelper({
    home: path.join(tmp, 'home'),
    overrides: { settings: { downloadDir: path.join(tmp, 'dl'), allowPrivateNetwork: false, maxConcurrent: 1 } },
    system: { chooseFolder: async () => null, reveal: async () => undefined },
    runnerFactory: (_engine: JobEngine) => new FakeRunner(behaviour),
  });
}

async function until(fn: () => boolean, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (!fn()) {
    if (Date.now() > deadline) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 10));
  }
}

beforeEach(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'clipkeeper-unit-'));
  behaviour = 'ok';
  helper = await makeHelper();
});

afterEach(async () => {
  await helper.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('security hooks', () => {
  const auth = () => ({ authorization: `Bearer ${helper.config.token}` });

  it('compares tokens in constant time', () => {
    expect(tokensMatch('abc', 'abc')).toBe(true);
    expect(tokensMatch('abc', 'abd')).toBe(false);
    expect(tokensMatch('short', 'a-much-longer-token')).toBe(false);
  });

  it('allows health without a token but nothing else', async () => {
    expect((await helper.app.inject({ url: '/api/health', headers: host() })).statusCode).toBe(200);
    const res = await helper.app.inject({ url: '/api/jobs', headers: host() });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: { code: 'UNAUTHORIZED', message: 'Missing helper token.' } });
    expect((await helper.app.inject({ url: '/api/jobs', headers: { ...host(), ...auth() } })).statusCode).toBe(200);
  });

  it('rejects non-loopback Host headers and foreign origins', async () => {
    expect((await helper.app.inject({ url: '/api/health', headers: { host: 'evil.com' } })).statusCode).toBe(403);
    expect((await helper.app.inject({ url: '/api/health', headers: { host: '127.0.0.1.nip.io' } })).statusCode).toBe(403);
    expect((await helper.app.inject({ url: '/api/jobs', headers: { ...host(), ...auth(), origin: 'https://site.example' } })).statusCode).toBe(403);
    expect((await helper.app.inject({ url: '/api/jobs', headers: { ...host(), ...auth(), origin: 'null' } })).statusCode).toBe(403);
  });

  it('answers CORS preflight for extension origins and can pin an extension id', async () => {
    const origin = `chrome-extension://${'b'.repeat(32)}`;
    const pre = await helper.app.inject({ method: 'OPTIONS', url: '/api/jobs', headers: { ...host(), origin } });
    expect(pre.statusCode).toBe(204);
    expect(pre.headers['access-control-allow-origin']).toBe(origin);

    await helper.config.updateSettings({ allowedExtensionIds: ['c'.repeat(32)] });
    expect((await helper.app.inject({ url: '/api/jobs', headers: { ...host(), ...auth(), origin } })).statusCode).toBe(403);
    expect((await helper.app.inject({ url: '/api/jobs', headers: { ...host(), ...auth(), origin: `chrome-extension://${'c'.repeat(32)}` } })).statusCode).toBe(200);
  });

  it('rate-limits repeated bad tokens without locking out the real token', async () => {
    for (let i = 0; i < 31; i++) await helper.app.inject({ url: '/api/jobs', headers: { ...host(), authorization: 'Bearer nope' } });
    expect((await helper.app.inject({ url: '/api/jobs', headers: { ...host(), authorization: 'Bearer nope' } })).statusCode).toBe(429);
    expect((await helper.app.inject({ url: '/api/jobs', headers: { ...host(), ...auth() } })).statusCode).toBe(200);
  });

  it('validates bodies strictly and caps their size', async () => {
    const post = (payload: unknown) =>
      helper.app.inject({ method: 'POST', url: '/api/jobs', headers: { ...host(), ...auth(), 'content-type': 'application/json' }, payload: JSON.stringify(payload) });
    const bad = await post({ url: 'https://e.com/a.mp4', kind: 'direct', command: 'rm -rf /' });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error.code).toBe('BAD_REQUEST');
    expect((await post({ url: 'https://e.com/' + 'a'.repeat(70_000), kind: 'direct' })).statusCode).toBe(413);
    expect((await helper.app.inject({ url: '/api/unknown', headers: { ...host(), ...auth() } })).statusCode).toBe(404);
  });
});

describe('job manager', () => {
  const create = (url = 'https://media.example.com/clip.mp4', extra: Record<string, unknown> = {}) =>
    helper.jobs.create({ url, kind: 'direct', title: 'Clip', ...extra });

  it('runs jobs to completion and records history', async () => {
    const job = await create();
    await until(() => helper.jobs.get(job.id).status === 'completed');
    const done = helper.jobs.get(job.id);
    expect(done.progress).toBe(1);
    expect(fs.existsSync(done.filePath!)).toBe(true);
    expect(helper.history.list()[0]).toMatchObject({ jobId: job.id, status: 'completed', siteName: 'media.example.com' });
  });

  it('honours the concurrency limit (queue)', async () => {
    behaviour = 'slow';
    const a = await create('https://media.example.com/a.mp4');
    const b = await create('https://media.example.com/b.mp4');
    await until(() => helper.jobs.get(a.id).status === 'downloading');
    expect(helper.jobs.get(b.id).status).toBe('queued');
    await helper.jobs.cancel(a.id);
    await until(() => helper.jobs.get(b.id).status === 'downloading');
    await helper.jobs.cancel(b.id);
  });

  it('pauses, resumes and cancels', async () => {
    behaviour = 'slow';
    const job = await create();
    await until(() => helper.jobs.get(job.id).bytesDownloaded > 0);
    helper.jobs.pause(job.id);
    await until(() => helper.jobs.get(job.id).status === 'paused');
    expect(() => helper.jobs.pause(job.id)).toThrow(/Cannot pause/);
    helper.jobs.resume(job.id);
    await until(() => helper.jobs.get(job.id).status === 'downloading');
    const canceled = await helper.jobs.cancel(job.id);
    expect(canceled.status).toBe('canceled');
    expect(() => helper.jobs.remove('missing')).toThrow(/not found/);
  });

  it('marks failures, keeps them in history and allows retry', async () => {
    behaviour = 'fail';
    const job = await create();
    await until(() => helper.jobs.get(job.id).status === 'failed');
    expect(helper.jobs.get(job.id).error).toBe('boom');
    expect(helper.history.list()[0].status).toBe('failed');
    behaviour = 'ok';
    helper.jobs.retry(job.id);
    await until(() => helper.jobs.get(job.id).status === 'completed');
  });

  it('rejects duplicates of active jobs and of completed downloads unless forced', async () => {
    behaviour = 'slow';
    const job = await create();
    await expect(create()).rejects.toMatchObject({ code: 'DUPLICATE' });
    await helper.jobs.cancel(job.id);
    behaviour = 'ok';
    const second = await create();
    await until(() => helper.jobs.get(second.id).status === 'completed');
    await expect(create()).rejects.toMatchObject({ code: 'DUPLICATE', details: { inHistory: true } });
    await expect(create(undefined, { force: true })).resolves.toMatchObject({ status: expect.stringMatching(/queued|downloading/) });
    // A different quality of the same video is not a duplicate.
    await expect(create(undefined, { variantId: 'v720' })).resolves.toBeTruthy();
  });

  it('restores unfinished jobs as paused after a restart', async () => {
    behaviour = 'slow';
    const job = await create();
    await until(() => helper.jobs.get(job.id).bytesDownloaded > 0);
    await helper.close();
    helper = await makeHelper();
    const restored: DownloadJob = helper.jobs.get(job.id);
    expect(restored.status).toBe('paused');
    expect(restored.bytesDownloaded).toBeGreaterThan(0);
  });
});
