import { describe, expect, it } from 'vitest';
import { describeHlsMedia, parseAttributeList, parseM3u8, pickAudioRendition, variantsFromHlsMaster } from '../src';

const MASTER = `#EXTM3U
#EXT-X-VERSION:6
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="English",LANGUAGE="en",DEFAULT=YES,AUTOSELECT=YES,URI="audio/en.m3u8"
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="Deutsch",LANGUAGE="de",DEFAULT=NO,URI="audio/de.m3u8"
#EXT-X-STREAM-INF:BANDWIDTH=800000,AVERAGE-BANDWIDTH=700000,RESOLUTION=640x360,CODECS="avc1.4d401e,mp4a.40.2",AUDIO="aud"
360p/index.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=5000000,RESOLUTION=1920x1080,CODECS="avc1.640028,mp4a.40.2",FRAME-RATE=29.97,AUDIO="aud"
https://cdn.example.com/1080p/index.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=2500000,RESOLUTION=1280x720,CODECS="avc1.64001f,mp4a.40.2",AUDIO="aud"
720p/index.m3u8
`;

const MEDIA = `#EXTM3U
#EXT-X-VERSION:7
#EXT-X-TARGETDURATION:4
#EXT-X-MEDIA-SEQUENCE:0
#EXT-X-PLAYLIST-TYPE:VOD
#EXT-X-MAP:URI="init.mp4"
#EXTINF:4.0,
seg0.m4s
#EXTINF:4.0,
seg1.m4s
#EXT-X-DISCONTINUITY
#EXTINF:2.5,
seg2.m4s
#EXT-X-ENDLIST
`;

describe('HLS parser', () => {
  it('parses attribute lists with quoted commas', () => {
    expect(parseAttributeList('BANDWIDTH=1,CODECS="avc1.4d401e,mp4a.40.2",NAME=x')).toEqual({
      BANDWIDTH: '1',
      CODECS: 'avc1.4d401e,mp4a.40.2',
      NAME: 'x',
    });
  });

  it('parses master playlists and resolves URIs', () => {
    const p = parseM3u8(MASTER, 'https://example.com/v/master.m3u8');
    expect(p.type).toBe('master');
    if (p.type !== 'master') return;
    expect(p.variants).toHaveLength(3);
    expect(p.variants[0]).toMatchObject({
      uri: 'https://example.com/v/360p/index.m3u8',
      bandwidth: 800000,
      averageBandwidth: 700000,
      width: 640,
      height: 360,
      codecs: 'avc1.4d401e,mp4a.40.2',
      audioGroup: 'aud',
    });
    expect(p.variants[1].uri).toBe('https://cdn.example.com/1080p/index.m3u8');
    expect(p.renditions).toHaveLength(2);
    expect(pickAudioRendition(p, p.variants[0])?.language).toBe('en');
    expect(p.encrypted).toBe(false);
  });

  it('builds variants sorted best-first with size estimates', () => {
    const p = parseM3u8(MASTER, 'https://example.com/v/master.m3u8');
    if (p.type !== 'master') throw new Error('expected master');
    const variants = variantsFromHlsMaster(p, 100);
    expect(variants.map((v) => v.height)).toEqual([1080, 720, 360]);
    expect(variants[0].label).toBe('1080p · 5.0 Mbps');
    expect(variants[0].sizeBytes).toBe(62_500_000);
    expect(variants[2].sizeBytes).toBe(8_750_000);
  });

  it('parses media playlists with init segments', () => {
    const p = parseM3u8(MEDIA, 'https://example.com/v/720p/index.m3u8');
    expect(p.type).toBe('media');
    if (p.type !== 'media') return;
    expect(p.segments).toHaveLength(3);
    expect(p.totalDuration).toBeCloseTo(10.5);
    expect(p.endList).toBe(true);
    expect(p.segments[0].map?.uri).toBe('https://example.com/v/720p/init.mp4');
    expect(p.segments[2].discontinuity).toBe(true);
    expect(describeHlsMedia(p)).toMatchObject({ availability: 'needs-backend', durationSec: 10.5 });
  });

  it('tracks byte ranges with implicit offsets', () => {
    const text = `#EXTM3U
#EXT-X-TARGETDURATION:4
#EXTINF:4,
#EXT-X-BYTERANGE:1000@0
all.ts
#EXTINF:4,
#EXT-X-BYTERANGE:500
all.ts
#EXT-X-ENDLIST`;
    const p = parseM3u8(text, 'https://e.com/a.m3u8');
    if (p.type !== 'media') throw new Error('expected media');
    expect(p.segments[0].byteRange).toEqual({ length: 1000, offset: 0 });
    expect(p.segments[1].byteRange).toEqual({ length: 500, offset: 1000 });
  });

  it('flags encrypted playlists as protected', () => {
    const text = `#EXTM3U
#EXT-X-TARGETDURATION:4
#EXT-X-KEY:METHOD=AES-128,URI="https://keys.example.com/k"
#EXTINF:4,
a.ts
#EXT-X-ENDLIST`;
    const p = parseM3u8(text, 'https://e.com/a.m3u8');
    if (p.type !== 'media') throw new Error('expected media');
    expect(p.encrypted).toBe(true);
    expect(describeHlsMedia(p).availability).toBe('drm');

    const sample = parseM3u8(text.replace('AES-128', 'SAMPLE-AES'), 'https://e.com/a.m3u8');
    expect(sample.encrypted).toBe(true);
    const none = parseM3u8(text.replace('METHOD=AES-128,URI="https://keys.example.com/k"', 'METHOD=NONE'), 'https://e.com/a.m3u8');
    expect(none.encrypted).toBe(false);
  });

  it('flags session keys in master playlists', () => {
    const text = `${MASTER}#EXT-X-SESSION-KEY:METHOD=SAMPLE-AES,URI="skd://x",KEYFORMAT="com.apple.streamingkeydelivery"\n`;
    const p = parseM3u8(text, 'https://e.com/m.m3u8');
    expect(p.encrypted).toBe(true);
  });

  it('reports live playlists', () => {
    const live = parseM3u8('#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXTINF:2,\na.ts\n', 'https://e.com/l.m3u8');
    if (live.type !== 'media') throw new Error('expected media');
    expect(describeHlsMedia(live).availability).toBe('live');
  });

  it('rejects non-playlists', () => {
    expect(() => parseM3u8('<html></html>', 'https://e.com/a.m3u8')).toThrow(/EXTM3U/);
  });
});
