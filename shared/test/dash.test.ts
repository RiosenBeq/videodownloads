import { describe, expect, it } from 'vitest';
import { describeDash, fillTemplate, parseIsoDuration, parseMpd, pickDashAudio } from '../src';

const TEMPLATE_MPD = `<?xml version="1.0"?>
<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="static" mediaPresentationDuration="PT10S" minBufferTime="PT2S">
  <Period id="0">
    <AdaptationSet contentType="video" mimeType="video/mp4" segmentAlignment="true">
      <SegmentTemplate timescale="1000" duration="4000" startNumber="1"
        initialization="init-$RepresentationID$.m4s" media="chunk-$RepresentationID$-$Number%05d$.m4s"/>
      <Representation id="v720" bandwidth="2000000" width="1280" height="720" codecs="avc1.64001f"/>
      <Representation id="v360" bandwidth="600000" width="640" height="360" codecs="avc1.4d401e"/>
    </AdaptationSet>
    <AdaptationSet contentType="audio" mimeType="audio/mp4" lang="en">
      <SegmentTemplate timescale="48000" initialization="a/init.mp4" media="a/$Time$.m4s">
        <SegmentTimeline>
          <S t="0" d="192000" r="1"/>
          <S d="96000"/>
        </SegmentTimeline>
      </SegmentTemplate>
      <Representation id="a1" bandwidth="128000" codecs="mp4a.40.2"/>
    </AdaptationSet>
  </Period>
</MPD>`;

describe('DASH parser', () => {
  it('parses ISO durations', () => {
    expect(parseIsoDuration('PT10S')).toBe(10);
    expect(parseIsoDuration('PT1H2M3.5S')).toBe(3723.5);
    expect(parseIsoDuration('P1DT1S')).toBe(86401);
    expect(parseIsoDuration('garbage')).toBeUndefined();
  });

  it('fills templates', () => {
    expect(fillTemplate('$RepresentationID$/$Number%05d$.m4s', { RepresentationID: 'v1', Number: 42 })).toBe('v1/00042.m4s');
    expect(fillTemplate('t-$Time$-$Bandwidth$$$', { RepresentationID: 'x', Time: 9, Bandwidth: 5 })).toBe('t-9-5$');
  });

  it('expands SegmentTemplate with duration and timeline', () => {
    const m = parseMpd(TEMPLATE_MPD, 'https://cdn.example.com/show/manifest.mpd');
    expect(m.type).toBe('static');
    expect(m.durationSec).toBe(10);
    expect(m.protected).toBe(false);
    const v720 = m.representations.find((r) => r.id === 'v720')!;
    expect(v720.contentType).toBe('video');
    expect(v720.plan?.init?.url).toBe('https://cdn.example.com/show/init-v720.m4s');
    expect(v720.plan?.media.map((s) => s.url)).toEqual([
      'https://cdn.example.com/show/chunk-v720-00001.m4s',
      'https://cdn.example.com/show/chunk-v720-00002.m4s',
      'https://cdn.example.com/show/chunk-v720-00003.m4s',
    ]);
    const audio = m.representations.find((r) => r.id === 'a1')!;
    expect(audio.contentType).toBe('audio');
    expect(audio.plan?.media.map((s) => s.url)).toEqual([
      'https://cdn.example.com/show/a/0.m4s',
      'https://cdn.example.com/show/a/192000.m4s',
      'https://cdn.example.com/show/a/384000.m4s',
    ]);
    expect(pickDashAudio(m.representations, 'avc1.64001f')?.id).toBe('a1');
  });

  it('describes variants with estimated sizes', () => {
    const d = describeDash(parseMpd(TEMPLATE_MPD, 'https://cdn.example.com/show/manifest.mpd'));
    expect(d.availability).toBe('needs-backend');
    expect(d.variants.map((v) => v.id)).toEqual(['v720', 'v360']);
    expect(d.variants[0].sizeBytes).toBe(Math.round(((2_000_000 + 128_000) * 10) / 8));
  });

  it('handles SegmentList and BaseURL single files', () => {
    const xml = `<MPD type="static" mediaPresentationDuration="PT4S"><BaseURL>https://media.example.com/base/</BaseURL><Period>
      <AdaptationSet mimeType="video/mp4">
        <Representation id="list" bandwidth="1000" width="320" height="180">
          <SegmentList><Initialization sourceURL="init.mp4"/><SegmentURL media="s1.m4s"/><SegmentURL media="s2.m4s"/></SegmentList>
        </Representation>
        <Representation id="single" bandwidth="2000" width="640" height="360"><BaseURL>full.mp4</BaseURL><SegmentBase indexRange="0-100"/></Representation>
      </AdaptationSet></Period></MPD>`;
    const m = parseMpd(xml, 'https://example.com/m.mpd');
    const list = m.representations.find((r) => r.id === 'list')!;
    expect(list.plan?.init?.url).toBe('https://media.example.com/base/init.mp4');
    expect(list.plan?.media.map((s) => s.url)).toEqual([
      'https://media.example.com/base/s1.m4s',
      'https://media.example.com/base/s2.m4s',
    ]);
    const single = m.representations.find((r) => r.id === 'single')!;
    expect(single.plan?.media).toEqual([{ url: 'https://media.example.com/base/full.mp4' }]);
  });

  it('marks ContentProtection as DRM', () => {
    const xml = TEMPLATE_MPD.replace(
      '<AdaptationSet contentType="video"',
      '<AdaptationSet contentType="video"><ContentProtection schemeIdUri="urn:uuid:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed"/></AdaptationSet><AdaptationSet contentType="video"',
    );
    const m = parseMpd(xml, 'https://e.com/m.mpd');
    expect(m.protected).toBe(true);
    expect(describeDash(m).availability).toBe('drm');
  });

  it('marks dynamic manifests as live', () => {
    const m = parseMpd(TEMPLATE_MPD.replace('type="static"', 'type="dynamic"'), 'https://e.com/m.mpd');
    expect(describeDash(m).availability).toBe('live');
  });

  it('rejects non-MPD documents', () => {
    expect(() => parseMpd('<html><body/></html>', 'https://e.com/m.mpd')).toThrow(/MPD/);
  });
});
