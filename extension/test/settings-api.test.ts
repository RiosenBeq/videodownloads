import { describe, expect, it, vi } from 'vitest';
import { checkHelper, HelperClient, HelperError } from '../src/lib/api';
import { describeInterrupt, itemToJob } from '../src/lib/browserDownloads';
import { DEFAULT_SETTINGS, isLoopbackHttpUrl, normalizeSettings, sanitizeSubfolder } from '../src/lib/settings';

describe('settings', () => {
  it('only accepts loopback helper URLs', () => {
    expect(isLoopbackHttpUrl('http://127.0.0.1:47321')).toBe(true);
    expect(isLoopbackHttpUrl('http://localhost:9000')).toBe(true);
    expect(isLoopbackHttpUrl('https://127.0.0.1:47321')).toBe(false);
    expect(isLoopbackHttpUrl('http://evil.com')).toBe(false);
    expect(isLoopbackHttpUrl('http://user:pw@127.0.0.1')).toBe(false);
    expect(normalizeSettings({ helperUrl: 'http://attacker.example' }).helperUrl).toBe(DEFAULT_SETTINGS.helperUrl);
    expect(normalizeSettings(undefined)).toEqual(DEFAULT_SETTINGS);
  });

  it('sanitizes Chrome download sub-folders', () => {
    expect(sanitizeSubfolder('../../etc')).toBe('etc');
    expect(sanitizeSubfolder('Videos/Clipkeeper')).toBe('Videos/Clipkeeper');
    expect(sanitizeSubfolder('a\\b:c?/..')).toBe('a/bc');
    expect(sanitizeSubfolder('')).toBe('');
  });
});

describe('HelperClient', () => {
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

  it('sends the bearer token and JSON bodies only when needed', async () => {
    const fetch = vi.fn(async () => json(201, { job: { id: 'j_123456' } }));
    const client = new HelperClient({ baseUrl: 'http://127.0.0.1:1/', token: 'secret', fetch });
    await client.createJob({ url: 'https://e.com/a.mp4', kind: 'direct' });
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('http://127.0.0.1:1/api/jobs');
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer secret');
    expect((init.headers as Record<string, string>)['content-type']).toBe('application/json');
    expect(init.credentials).toBe('omit');

    await client.jobAction('j_123456', 'pause');
    const [, init2] = fetch.mock.calls[1] as unknown as [string, RequestInit];
    expect((init2.headers as Record<string, string>)['content-type']).toBeUndefined();
  });

  it('maps helper errors and connection failures', async () => {
    const err = new HelperClient({
      baseUrl: 'http://127.0.0.1:1',
      token: 't',
      fetch: async () => json(409, { error: { code: 'DUPLICATE', message: 'Already', details: { jobId: 'x' } } }),
    });
    await expect(err.listJobs()).rejects.toMatchObject({ code: 'DUPLICATE', status: 409, details: { jobId: 'x' } });

    const offline = new HelperClient({ baseUrl: 'http://127.0.0.1:1', token: 't', fetch: async () => Promise.reject(new TypeError('Failed to fetch')) });
    const error = await offline.listJobs().catch((e) => e);
    expect(error).toBeInstanceOf(HelperError);
    expect(error.code).toBe('OFFLINE');
  });

  it('derives the connection state', async () => {
    const make = (handler: (url: string) => Response, token = 't') => new HelperClient({ baseUrl: 'http://127.0.0.1:1', token, fetch: async (u) => handler(String(u)) });
    expect((await checkHelper(make(() => json(200, { ok: true }), ''))).state).toBe('not-configured');
    expect((await checkHelper(make((u) => (u.endsWith('/health') ? json(200, {}) : json(401, { error: { code: 'UNAUTHORIZED', message: 'no' } }))))).state).toBe(
      'unauthorized',
    );
    expect((await checkHelper(make(() => json(200, { version: '1.0.0' })))).state).toBe('online');
  });
});

describe('browser download mapping', () => {
  const meta = { downloadId: 5, url: 'https://e.com/a.mp4', title: 'A', filename: 'A.mp4', key: 'k', createdAt: 1 };
  const item = (patch: Partial<chrome.downloads.DownloadItem>) =>
    ({
      id: 5,
      state: 'in_progress',
      paused: false,
      bytesReceived: 50,
      totalBytes: 200,
      fileSize: 0,
      filename: '/Users/me/Downloads/Clipkeeper/A.mp4',
      canResume: true,
      ...patch,
    }) as chrome.downloads.DownloadItem;

  it('maps Chrome download states to jobs', () => {
    expect(itemToJob(item({}), meta, 1000)).toMatchObject({ id: 'b_5', status: 'downloading', progress: 0.25, speedBps: 1000, filename: 'A.mp4' });
    expect(itemToJob(item({ paused: true }), meta).status).toBe('paused');
    expect(itemToJob(item({ state: 'complete', bytesReceived: 200 }), meta)).toMatchObject({ status: 'completed', progress: 1 });
    expect(itemToJob(item({ state: 'interrupted', error: 'USER_CANCELED' }), meta).status).toBe('canceled');
    expect(itemToJob(item({ state: 'interrupted', error: 'SERVER_FORBIDDEN' }), meta)).toMatchObject({ status: 'failed', error: describeInterrupt('SERVER_FORBIDDEN') });
  });
});
