import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { concatFiles, isSystemPath, readJson, resolveInside, uniqueOutputPath, validateDownloadDir, writeJsonAtomic } from '../src/fs/files';
import { buildRemuxArgs } from '../src/jobs/ffmpeg';
import { variantsFromYtDlp, ytDlpFormatSelector } from '../src/jobs/ytdlp';
import { extensionFor } from '../src/jobs/direct';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'clipkeeper-files-'));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe('path safety', () => {
  it('keeps resolved paths inside the folder', () => {
    expect(resolveInside(tmp, 'video.mp4')).toBe(path.join(tmp, 'video.mp4'));
    expect(() => resolveInside(tmp, '../escape.mp4')).toThrow(/outside/);
    expect(() => resolveInside(tmp, '/etc/passwd')).toThrow(/outside/);
    expect(() => resolveInside(tmp, '')).toThrow(/outside/);
  });

  it('detects system folders', () => {
    if (process.platform === 'win32') {
      expect(isSystemPath('C:\\Windows\\System32')).toBe(true);
    } else {
      expect(isSystemPath('/')).toBe(true);
      expect(isSystemPath('/etc')).toBe(true);
      expect(isSystemPath('/usr/local/bin')).toBe(true);
      expect(isSystemPath('/etcetera')).toBe(false);
    }
    expect(isSystemPath(os.homedir() + '/Downloads')).toBe(false);
  });

  it('validates and creates download folders', async () => {
    const dir = path.join(tmp, 'nested', 'downloads');
    expect(await validateDownloadDir(dir)).toBe(fs.realpathSync(dir));
    await expect(validateDownloadDir('relative/dir')).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(validateDownloadDir(process.platform === 'win32' ? 'C:\\Windows' : '/etc')).rejects.toMatchObject({ code: 'FORBIDDEN' });
    const file = path.join(tmp, 'a-file');
    fs.writeFileSync(file, 'x');
    await expect(validateDownloadDir(file)).rejects.toBeTruthy();
  });

  it('finds collision-free names, honouring reserved paths', async () => {
    fs.writeFileSync(path.join(tmp, 'clip.mp4'), '');
    expect(await uniqueOutputPath(tmp, 'clip.mp4')).toBe(path.join(tmp, 'clip (1).mp4'));
    expect(await uniqueOutputPath(tmp, 'clip.mp4', new Set([path.join(tmp, 'clip (1).mp4')]))).toBe(path.join(tmp, 'clip (2).mp4'));
  });
});

describe('persistence', () => {
  it('writes JSON atomically and recovers from corrupt files', async () => {
    const file = path.join(tmp, 'state.json');
    await writeJsonAtomic(file, { a: 1 });
    expect(await readJson(file)).toEqual({ a: 1 });
    if (process.platform !== 'win32') expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    fs.writeFileSync(file, '{not json');
    expect(await readJson(file)).toBeUndefined();
    expect(fs.readdirSync(tmp).some((f) => f.startsWith('state.json.corrupt-'))).toBe(true);
  });

  it('concatenates files in order', async () => {
    const parts = ['a', 'b', 'c'].map((n) => {
      const p = path.join(tmp, `part-${n}`);
      fs.writeFileSync(p, n.repeat(3));
      return p;
    });
    const out = path.join(tmp, 'joined');
    await concatFiles(parts, out);
    expect(fs.readFileSync(out, 'utf8')).toBe('aaabbbccc');
  });
});

describe('external tool arguments', () => {
  it('restricts FFmpeg to local files and copies streams', () => {
    const args = buildRemuxArgs({ inputs: ['/w/video.ts', '/w/audio.ts'], output: '/w/out.mp4', container: 'mp4' });
    expect(args.filter((a) => a === '-protocol_whitelist')).toHaveLength(2);
    expect(args[args.indexOf('-protocol_whitelist') + 1]).toBe('file,pipe');
    expect(args).toContain('copy');
    expect(args.slice(-1)[0]).toBe('/w/out.mp4');
    expect(args).toEqual(expect.arrayContaining(['-map', '0:v:0?', '1:a:0?']));
  });

  it('builds yt-dlp format selectors', () => {
    expect(ytDlpFormatSelector('highest')).toBe('bv*+ba/b/b');
    expect(ytDlpFormatSelector('720')).toBe('bv*[height<=720]+ba/b[height<=720]/b');
    expect(ytDlpFormatSelector('1080', 'mp4')).toContain('[ext=mp4]');
  });

  it('maps yt-dlp formats to variants and skips DRM formats', () => {
    const variants = variantsFromYtDlp({
      formats: [
        { format_id: '137', ext: 'mp4', height: 1080, width: 1920, vcodec: 'avc1', acodec: 'none', tbr: 4000, filesize: 1000 },
        { format_id: '22', ext: 'mp4', height: 720, width: 1280, vcodec: 'avc1', acodec: 'mp4a', tbr: 2000 },
        { format_id: 'drm', ext: 'mp4', height: 2160, vcodec: 'avc1', acodec: 'none', has_drm: true },
        { format_id: '140', ext: 'm4a', vcodec: 'none', acodec: 'mp4a', tbr: 128, filesize: 100 },
      ],
    });
    expect(variants.map((v) => v.id)).toEqual(['137', '22']);
    expect(variants[0].formatId).toBe('137+ba/137');
    expect(variants[0].sizeBytes).toBe(1100);
    expect(variants[1].formatId).toBe('22');
  });

  it('picks file extensions for direct downloads', () => {
    expect(extensionFor('https://e.com/a.webm', undefined)).toBe('webm');
    expect(extensionFor('https://e.com/stream', 'video/quicktime')).toBe('mov');
    expect(extensionFor('https://e.com/stream', 'application/octet-stream')).toBe('mp4');
  });
});
