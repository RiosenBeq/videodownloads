import { describe, expect, it } from 'vitest';
import { applyFilenameTemplate, buildFilename, finalizeFilename, sanitizeFilename, splitExtension } from '../src';

describe('sanitizeFilename', () => {
  it('removes path separators and traversal', () => {
    expect(sanitizeFilename('../../etc/passwd')).toBe('-..-etc-passwd');
    expect(sanitizeFilename('..')).toBe('video');
    expect(sanitizeFilename('a\\b/c')).toBe('a-b-c');
  });

  it('strips characters invalid on Windows and control characters', () => {
    expect(sanitizeFilename('Title: The <Best> "Clip"?*')).toBe('Title - The Best Clip');
    expect(sanitizeFilename('line\nbreak\ttab\u0000nul')).toBe('line break tab nul');
  });

  it('removes bidi overrides that could disguise extensions', () => {
    expect(sanitizeFilename('evil‮gpj.exe')).toBe('evilgpj.exe');
  });

  it('protects Windows reserved device names', () => {
    expect(sanitizeFilename('CON')).toBe('_CON');
    expect(sanitizeFilename('lpt1.mp4')).toBe('_lpt1.mp4');
    expect(sanitizeFilename('console')).toBe('console');
  });

  it('trims dots and spaces and falls back when empty', () => {
    expect(sanitizeFilename('  .hidden.  ')).toBe('hidden');
    expect(sanitizeFilename('   ')).toBe('video');
    expect(sanitizeFilename('', { fallback: 'clip' })).toBe('clip');
  });

  it('limits length without splitting surrogate pairs', () => {
    const long = '😀'.repeat(200);
    const out = sanitizeFilename(long, { maxLength: 51 });
    expect(out.length).toBeLessThanOrEqual(51);
    expect(() => encodeURIComponent(out)).not.toThrow();
  });

  it('keeps unicode titles', () => {
    expect(sanitizeFilename('Gün batımı — İstanbul')).toBe('Gün batımı — İstanbul');
  });
});

describe('finalizeFilename', () => {
  it('replaces media extensions and adds the target one', () => {
    expect(finalizeFilename('My clip.webm', 'mp4')).toBe('My clip.mp4');
    expect(finalizeFilename('My clip.mp4', 'mp4')).toBe('My clip.mp4');
    expect(finalizeFilename('report.v2', 'mp4')).toBe('report.v2.mp4');
    expect(finalizeFilename('x', '../exe')).toBe('x.mp4');
  });

  it('splits extensions', () => {
    expect(splitExtension('a.b.MP4')).toEqual({ base: 'a.b', ext: 'mp4' });
    expect(splitExtension('noext')).toEqual({ base: 'noext', ext: '' });
  });
});

describe('templates', () => {
  it('expands tokens and collapses empty brackets', () => {
    const date = new Date(2026, 0, 5);
    expect(applyFilenameTemplate('{site} - {title} ({resolution})', { title: 'Demo', site: 'example.com', resolution: '1080p', date })).toBe(
      'example.com - Demo (1080p)',
    );
    expect(applyFilenameTemplate('{title} ({resolution})', { title: 'Demo', date })).toBe('Demo');
    expect(applyFilenameTemplate('{date} {title}', { title: 'Demo', date })).toBe('2026-01-05 Demo');
  });

  it('builds a safe final file name', () => {
    expect(buildFilename('{title}', { title: 'A/B: C' }, 'webm')).toBe('A-B - C.webm');
  });
});
