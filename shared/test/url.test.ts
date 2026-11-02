import { describe, expect, it } from 'vitest';
import {
  classifyMediaUrl,
  getSiteName,
  getUrlExtension,
  hashString,
  isHttpUrl,
  looksLikeSegmentUrl,
  matchesDomain,
  normalizeVideoUrl,
  videoIdForUrl,
} from '../src';

describe('url helpers', () => {
  it('accepts only http(s) URLs', () => {
    expect(isHttpUrl('https://example.com/a.mp4')).toBe(true);
    expect(isHttpUrl('http://example.com')).toBe(true);
    expect(isHttpUrl('file:///etc/passwd')).toBe(false);
    expect(isHttpUrl('javascript:alert(1)')).toBe(false);
    expect(isHttpUrl('blob:https://example.com/123')).toBe(false);
    expect(isHttpUrl('not a url')).toBe(false);
  });

  it('extracts extensions from the path only', () => {
    expect(getUrlExtension('https://cdn.example.com/v/clip.MP4?token=abc.m3u8')).toBe('mp4');
    expect(getUrlExtension('https://example.com/stream/master.m3u8#t=10')).toBe('m3u8');
    expect(getUrlExtension('https://example.com/video')).toBe('');
    expect(getUrlExtension('https://example.com/.hidden')).toBe('');
  });

  it('classifies direct files, manifests and segments', () => {
    expect(classifyMediaUrl('https://x.com/a.mp4')).toEqual({ kind: 'direct', container: 'mp4' });
    expect(classifyMediaUrl('https://x.com/a.webm')).toEqual({ kind: 'direct', container: 'webm' });
    expect(classifyMediaUrl('https://x.com/a.mov')).toEqual({ kind: 'direct', container: 'mov' });
    expect(classifyMediaUrl('https://x.com/master.m3u8')).toEqual({ kind: 'hls', container: 'hls' });
    expect(classifyMediaUrl('https://x.com/play', 'application/vnd.apple.mpegurl')).toEqual({ kind: 'hls', container: 'hls' });
    expect(classifyMediaUrl('https://x.com/manifest.mpd')).toEqual({ kind: 'dash', container: 'dash' });
    expect(classifyMediaUrl('https://x.com/m', 'application/dash+xml; charset=utf-8')).toEqual({ kind: 'dash', container: 'dash' });
    expect(classifyMediaUrl('https://x.com/stream', 'video/webm')).toEqual({ kind: 'direct', container: 'webm' });
    expect(classifyMediaUrl('https://x.com/seg001.ts')).toBeNull();
    expect(classifyMediaUrl('https://x.com/chunk.m4s')).toBeNull();
    expect(classifyMediaUrl('https://x.com/a', 'video/mp2t')).toBeNull();
    expect(classifyMediaUrl('https://x.com/page.html', 'text/html')).toBeNull();
  });

  it('detects segment-like URLs', () => {
    expect(looksLikeSegmentUrl('https://x.com/v/seg-12.mp4')).toBe(true);
    expect(looksLikeSegmentUrl('https://x.com/videoplayback?range=0-1000')).toBe(true);
    expect(looksLikeSegmentUrl('https://x.com/v/fragment_3.mp4')).toBe(true);
    expect(looksLikeSegmentUrl('https://x.com/movies/trailer.mp4')).toBe(false);
  });

  it('derives site names and dedupe keys', () => {
    expect(getSiteName('https://www.example.com/watch')).toBe('example.com');
    expect(getSiteName('https://media.example.co.uk/a')).toBe('media.example.co.uk');
    expect(normalizeVideoUrl('https://x.com/a.mp4?x=1#t=5')).toBe('https://x.com/a.mp4?x=1');
    expect(videoIdForUrl('https://x.com/a.mp4#a')).toBe(videoIdForUrl('https://x.com/a.mp4#b'));
    expect(hashString('abc')).toBe(hashString('abc'));
    expect(hashString('abc')).not.toBe(hashString('abd'));
  });

  it('matches domains and subdomains only', () => {
    expect(matchesDomain('cdn.example.com', 'example.com')).toBe(true);
    expect(matchesDomain('example.com', 'example.com')).toBe(true);
    expect(matchesDomain('example.com', '*.example.com')).toBe(true);
    expect(matchesDomain('badexample.com', 'example.com')).toBe(false);
    expect(matchesDomain('example.com.evil.net', 'example.com')).toBe(false);
  });
});
