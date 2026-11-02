import { describe, expect, it } from 'vitest';
import type { DetectedVideo } from '@clipkeeper/shared/types';
import { emptyTabState, mergeVideo, TabRegistry, videoFromContent, videoFromNetwork, visibleVideos } from '../src/lib/registry';
import { networkHitFromResponse } from '../src/lib/sniff';

const page = { pageUrl: 'https://www.example.com/watch', pageTitle: 'Example page', frameUrl: 'https://www.example.com/watch' };

describe('videoFromContent', () => {
  it('builds direct videos with source variants', () => {
    const v = videoFromContent(
      {
        url: 'https://cdn.example.com/a-1080.mp4',
        origin: 'dom',
        title: 'Clip',
        sources: [
          { url: 'https://cdn.example.com/a-1080.mp4', type: 'video/mp4', height: 1080 },
          { url: 'https://cdn.example.com/a-480.webm', type: 'video/webm', height: 480 },
        ],
      },
      page,
    )!;
    expect(v).toMatchObject({ kind: 'direct', container: 'mp4', availability: 'available', siteName: 'example.com', sourceHost: 'cdn.example.com' });
    expect(v.variants?.map((x) => x.label)).toEqual(['1080p · MP4', '480p · WEBM']);
  });

  it('explains blob URLs and flags DRM', () => {
    const blob = videoFromContent({ url: 'blob:https://www.example.com/abc', origin: 'dom' }, page)!;
    expect(blob.kind).toBe('blob');
    expect(blob.availability).toBe('blob');
    expect(blob.availabilityReason).toMatch(/Media Source/);
    const drm = videoFromContent({ url: 'blob:https://www.example.com/abc', origin: 'dom', drm: true }, page)!;
    expect(drm.availability).toBe('drm');
  });

  it('marks manifests as needing the helper and ignores unknown links', () => {
    expect(videoFromContent({ url: 'https://e.com/master.m3u8', origin: 'link' }, page)?.availability).toBe('needs-backend');
    expect(videoFromContent({ url: 'https://e.com/page', origin: 'link' }, page)).toBeNull();
    // An extension-less <video src> is still a playable file.
    expect(videoFromContent({ url: 'https://e.com/stream?id=4', origin: 'dom' }, page)?.kind).toBe('direct');
    expect(videoFromContent({ url: 'data:video/mp4;base64,AA', origin: 'dom' }, page)).toBeNull();
  });
});

describe('mergeVideo', () => {
  it('combines DOM and network observations without relaxing restrictions', () => {
    const net = videoFromNetwork({ url: 'https://cdn.example.com/a.mp4', contentType: 'video/mp4', sizeBytes: 1234 }, page)!;
    const dom = videoFromContent({ url: 'https://cdn.example.com/a.mp4', origin: 'dom', title: 'Nice title', width: 1280, height: 720 }, page)!;
    const merged = mergeVideo(net, dom);
    expect(merged).toMatchObject({ title: 'Nice title', sizeBytes: 1234, height: 720, availability: 'available' });
    expect(merged.origins.sort()).toEqual(['dom', 'network']);

    const drm = mergeVideo(merged, { ...dom, availability: 'drm', availabilityReason: 'DRM' });
    expect(drm.availability).toBe('drm');
    expect(mergeVideo(drm, dom).availability).toBe('drm');
  });
});

describe('visibleVideos', () => {
  it('hides variant playlists and sorts downloadable, larger videos first', () => {
    const state = emptyTabState(1);
    const mk = (id: string, patch: Partial<DetectedVideo>): DetectedVideo => ({
      id,
      url: `https://e.com/${id}`,
      kind: 'direct',
      container: 'mp4',
      title: id,
      pageUrl: page.pageUrl,
      siteName: 'e.com',
      sourceHost: 'e.com',
      availability: 'available',
      origins: ['dom'],
      detectedAt: 1,
      ...patch,
    });
    state.videos = {
      small: mk('small', { width: 320, height: 180 }),
      big: mk('big', { width: 1920, height: 1080 }),
      drm: mk('drm', { availability: 'drm', width: 3840, height: 2160 }),
      child: mk('child', { hiddenBy: 'big' }),
    };
    expect(visibleVideos(state).map((v) => v.id)).toEqual(['big', 'small', 'drm']);
  });
});

describe('networkHitFromResponse', () => {
  const base = { tabId: 3, statusCode: 200, type: 'media' };
  const headers = (h: Record<string, string>) => Object.entries(h).map(([name, value]) => ({ name, value }));

  it('records direct media files and manifests', () => {
    expect(networkHitFromResponse({ ...base, url: 'https://e.com/a.mp4', responseHeaders: headers({ 'Content-Type': 'video/mp4', 'Content-Length': '500' }) })).toEqual({
      url: 'https://e.com/a.mp4',
      contentType: 'video/mp4',
      sizeBytes: 500,
    });
    expect(
      networkHitFromResponse({ ...base, statusCode: 206, url: 'https://e.com/a.webm', responseHeaders: headers({ 'content-range': 'bytes 0-99/7777' }) })?.sizeBytes,
    ).toBe(7777);
    expect(networkHitFromResponse({ ...base, type: 'xmlhttprequest', url: 'https://e.com/play', responseHeaders: headers({ 'content-type': 'application/x-mpegURL' }) })).toMatchObject({
      url: 'https://e.com/play',
    });
  });

  it('ignores segments, MSE fragments, errors and background requests', () => {
    expect(networkHitFromResponse({ ...base, url: 'https://e.com/seg1.ts' })).toBeNull();
    expect(networkHitFromResponse({ ...base, type: 'xmlhttprequest', url: 'https://e.com/v.mp4', responseHeaders: headers({ 'content-type': 'video/mp4' }) })).toBeNull();
    expect(networkHitFromResponse({ ...base, url: 'https://e.com/videoplayback?range=0-500', responseHeaders: headers({ 'content-type': 'video/mp4' }) })).toBeNull();
    expect(networkHitFromResponse({ ...base, statusCode: 404, url: 'https://e.com/a.mp4' })).toBeNull();
    expect(networkHitFromResponse({ ...base, tabId: -1, url: 'https://e.com/a.mp4' })).toBeNull();
  });
});

describe('TabRegistry', () => {
  function memoryStorage() {
    const data: Record<string, unknown> = {};
    return {
      data,
      get: async (key: string) => (key in data ? { [key]: structuredClone(data[key]) } : {}),
      set: async (items: Record<string, unknown>) => void Object.assign(data, structuredClone(items)),
      remove: async (key: string) => void delete data[key],
    } as unknown as chrome.storage.StorageArea & { data: Record<string, unknown> };
  }

  it('serializes concurrent updates per tab', async () => {
    const storage = memoryStorage();
    const registry = new TabRegistry(storage);
    await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        registry.update(7, (s) => {
          const v = videoFromNetwork({ url: `https://e.com/${i}.mp4` }, page)!;
          s.videos[v.id] = v;
        }),
      ),
    );
    const state = await registry.get(7);
    expect(Object.keys(state!.videos)).toHaveLength(20);
    expect(Object.keys((storage.data['tab:7'] as { videos: object }).videos)).toHaveLength(20);
    await registry.clear(7, 'https://next.example');
    expect((await registry.get(7))?.pageUrl).toBe('https://next.example');
    await registry.remove(7);
    expect(storage.data['tab:7']).toBeUndefined();
  });
});
