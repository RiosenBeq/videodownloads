/**
 * MPEG-DASH MPD parser. Produces, per representation, a concrete list of
 * segment URLs for the common addressing schemes:
 *   - SegmentTemplate with $Number$ / $Time$ (with or without SegmentTimeline)
 *   - SegmentList
 *   - SegmentBase / plain BaseURL (single file)
 * Any ContentProtection element marks the manifest as protected.
 */
import { XMLParser } from 'fast-xml-parser';

export interface DashSegmentRef {
  url: string;
  /** Inclusive byte range "start-end" when the segment is part of a larger file. */
  range?: string;
}

export interface DashSegmentPlan {
  init?: DashSegmentRef;
  media: DashSegmentRef[];
}

export type DashContentType = 'video' | 'audio' | 'text' | 'other';

export interface DashRepresentation {
  id: string;
  contentType: DashContentType;
  mimeType?: string;
  codecs?: string;
  bandwidth?: number;
  width?: number;
  height?: number;
  frameRate?: string;
  lang?: string;
  plan?: DashSegmentPlan;
  planError?: string;
}

export interface DashManifest {
  type: 'static' | 'dynamic';
  durationSec?: number;
  protected: boolean;
  periodCount: number;
  representations: DashRepresentation[];
}

export class ManifestParseError extends Error {}

type XmlNode = Record<string, unknown>;

const ARRAY_TAGS = new Set([
  'Period',
  'AdaptationSet',
  'Representation',
  'S',
  'SegmentURL',
  'ContentProtection',
  'BaseURL',
]);

const MAX_SEGMENTS = 200_000;

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  removeNSPrefix: true,
  parseAttributeValue: false,
  parseTagValue: false,
  trimValues: true,
  isArray: (name) => ARRAY_TAGS.has(name),
});

function attr(node: XmlNode | undefined, name: string): string | undefined {
  const value = node?.[`@_${name}`];
  return value == null ? undefined : String(value);
}

function num(node: XmlNode | undefined, name: string): number | undefined {
  const value = attr(node, name);
  if (value === undefined) return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

function children(node: XmlNode | undefined, name: string): XmlNode[] {
  const value = node?.[name];
  if (value == null) return [];
  return (Array.isArray(value) ? value : [value]).map((v) => (typeof v === 'object' ? (v as XmlNode) : { '#text': v }));
}

function child(node: XmlNode | undefined, name: string): XmlNode | undefined {
  return children(node, name)[0];
}

function text(node: XmlNode | undefined): string {
  if (!node) return '';
  const t = node['#text'];
  return t == null ? '' : String(t).trim();
}

/** ISO-8601 duration ("PT1H2M3.5S", "P1DT2H") → seconds. */
export function parseIsoDuration(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const m = /^P(?:(\d+(?:\.\d+)?)Y)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)D)?(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?)?$/.exec(
    value.trim(),
  );
  if (!m) return undefined;
  const [, y, mo, d, h, mi, s] = m.map((v) => (v ? Number(v) : 0));
  return y * 31_536_000 + mo * 2_592_000 + d * 86_400 + h * 3600 + mi * 60 + s;
}

/** Expand $RepresentationID$, $Number%05d$, $Time$, $Bandwidth$ and $$. */
export function fillTemplate(
  template: string,
  vars: { RepresentationID: string; Number?: number; Time?: number; Bandwidth?: number },
): string {
  return template.replace(/\$(RepresentationID|Number|Time|Bandwidth|)(?:%0(\d+)d)?\$/g, (_m, name: string, width?: string) => {
    if (name === '') return '$';
    const value = vars[name as keyof typeof vars];
    if (value === undefined) return '';
    const str = String(value);
    return width ? str.padStart(Number(width), '0') : str;
  });
}

function resolveUrl(relative: string, base: string): string {
  try {
    return new URL(relative, base).toString();
  } catch {
    throw new ManifestParseError(`Invalid URL in manifest: ${relative.slice(0, 100)}`);
  }
}

function applyBase(node: XmlNode | undefined, base: string): { url: string; explicit: boolean } {
  const b = text(child(node, 'BaseURL'));
  return b ? { url: resolveUrl(b, base), explicit: true } : { url: base, explicit: false };
}

function mergeTemplate(...nodes: (XmlNode | undefined)[]): XmlNode | undefined {
  const present = nodes.filter(Boolean) as XmlNode[];
  if (!present.length) return undefined;
  const merged: XmlNode = {};
  for (const node of present) {
    for (const [k, v] of Object.entries(node)) {
      if (k.startsWith('@_') || k === 'SegmentTimeline' || k === 'Initialization') merged[k] = v;
    }
  }
  return merged;
}

function contentTypeOf(as: XmlNode, rep: XmlNode): DashContentType {
  const hints = [attr(as, 'contentType'), attr(rep, 'mimeType'), attr(as, 'mimeType')].filter(Boolean).join(' ');
  if (/video/i.test(hints)) return 'video';
  if (/audio/i.test(hints)) return 'audio';
  if (/text|ttml|vtt|stpp|wvtt/i.test(hints)) return 'text';
  const codecs = attr(rep, 'codecs') ?? attr(as, 'codecs') ?? '';
  if (/avc|hvc|hev|vp0?9|vp8|av01|dvh/i.test(codecs)) return 'video';
  if (/mp4a|opus|vorbis|ac-3|ec-3|flac/i.test(codecs)) return 'audio';
  return 'other';
}

function planFromTemplate(
  template: XmlNode,
  baseUrl: string,
  repId: string,
  bandwidth: number | undefined,
  periodDurationSec: number | undefined,
): DashSegmentPlan {
  const timescale = num(template, 'timescale') ?? 1;
  const startNumber = num(template, 'startNumber') ?? 1;
  const pto = num(template, 'presentationTimeOffset') ?? 0;
  const media = attr(template, 'media');
  const initTpl = attr(template, 'initialization') ?? attr(child(template, 'Initialization'), 'sourceURL');
  if (!media) throw new ManifestParseError('SegmentTemplate without @media');

  const vars = { RepresentationID: repId, Bandwidth: bandwidth };
  const plan: DashSegmentPlan = { media: [] };
  if (initTpl) plan.init = { url: resolveUrl(fillTemplate(initTpl, vars), baseUrl) };

  const timeline = children(child(template, 'SegmentTimeline'), 'S');
  if (timeline.length) {
    let time = 0;
    let number = startNumber;
    const periodEnd = periodDurationSec !== undefined ? pto + periodDurationSec * timescale : undefined;
    timeline.forEach((s, index) => {
      const d = num(s, 'd');
      if (!d || d <= 0) throw new ManifestParseError('SegmentTimeline entry without @d');
      let t = num(s, 't') ?? time;
      let repeat = num(s, 'r') ?? 0;
      if (repeat < 0) {
        const nextT = num(timeline[index + 1], 't') ?? periodEnd;
        if (nextT === undefined) throw new ManifestParseError('Open-ended SegmentTimeline repeat without a known period end');
        repeat = Math.ceil((nextT - t) / d) - 1;
      }
      for (let k = 0; k <= repeat; k++) {
        plan.media.push({ url: resolveUrl(fillTemplate(media, { ...vars, Number: number, Time: t }), baseUrl) });
        t += d;
        number++;
        if (plan.media.length > MAX_SEGMENTS) throw new ManifestParseError('Too many segments');
      }
      time = t;
    });
    return plan;
  }

  const duration = num(template, 'duration');
  if (!duration) throw new ManifestParseError('SegmentTemplate has neither SegmentTimeline nor @duration');
  if (periodDurationSec === undefined) throw new ManifestParseError('Cannot compute segment count without a period duration');
  const endNumber = num(template, 'endNumber');
  const count = endNumber !== undefined ? endNumber - startNumber + 1 : Math.ceil((periodDurationSec * timescale) / duration - 1e-9);
  if (count > MAX_SEGMENTS) throw new ManifestParseError('Too many segments');
  for (let i = 0; i < count; i++) {
    const number = startNumber + i;
    plan.media.push({
      url: resolveUrl(fillTemplate(media, { ...vars, Number: number, Time: pto + i * duration }), baseUrl),
    });
  }
  return plan;
}

function planFromList(list: XmlNode, baseUrl: string): DashSegmentPlan {
  const plan: DashSegmentPlan = { media: [] };
  const init = child(list, 'Initialization');
  if (init) {
    const source = attr(init, 'sourceURL');
    plan.init = { url: source ? resolveUrl(source, baseUrl) : baseUrl, range: attr(init, 'range') };
  }
  for (const seg of children(list, 'SegmentURL')) {
    const media = attr(seg, 'media');
    plan.media.push({ url: media ? resolveUrl(media, baseUrl) : baseUrl, range: attr(seg, 'mediaRange') });
  }
  if (!plan.media.length) throw new ManifestParseError('Empty SegmentList');
  return plan;
}

export function parseMpd(xml: string, manifestUrl: string): DashManifest {
  let doc: XmlNode;
  try {
    doc = parser.parse(xml) as XmlNode;
  } catch (error) {
    throw new ManifestParseError(`Invalid MPD XML: ${(error as Error).message}`);
  }
  const mpd = child(doc, 'MPD');
  if (!mpd) throw new ManifestParseError('Not a DASH manifest (missing <MPD>)');

  const type = attr(mpd, 'type') === 'dynamic' ? 'dynamic' : 'static';
  const mpdDuration = parseIsoDuration(attr(mpd, 'mediaPresentationDuration'));
  const periods = children(mpd, 'Period');
  const mpdBase = applyBase(mpd, manifestUrl);
  let isProtected = /<(?:\w+:)?ContentProtection[\s>/]/.test(xml);

  const representations: DashRepresentation[] = [];
  const period = periods[0];
  if (period) {
    const periodStart = parseIsoDuration(attr(period, 'start')) ?? 0;
    const periodDuration =
      parseIsoDuration(attr(period, 'duration')) ?? (mpdDuration !== undefined ? mpdDuration - periodStart : undefined);
    const periodBase = applyBase(period, mpdBase.url);

    for (const as of children(period, 'AdaptationSet')) {
      if (children(as, 'ContentProtection').length) isProtected = true;
      const asBase = applyBase(as, periodBase.url);
      for (const rep of children(as, 'Representation')) {
        if (children(rep, 'ContentProtection').length) isProtected = true;
        const repBase = applyBase(rep, asBase.url);
        const id = attr(rep, 'id') ?? String(representations.length);
        const bandwidth = num(rep, 'bandwidth');
        const representation: DashRepresentation = {
          id,
          contentType: contentTypeOf(as, rep),
          mimeType: attr(rep, 'mimeType') ?? attr(as, 'mimeType'),
          codecs: attr(rep, 'codecs') ?? attr(as, 'codecs'),
          bandwidth,
          width: num(rep, 'width') ?? num(as, 'width'),
          height: num(rep, 'height') ?? num(as, 'height'),
          frameRate: attr(rep, 'frameRate') ?? attr(as, 'frameRate'),
          lang: attr(as, 'lang') ?? attr(rep, 'lang'),
        };

        try {
          const template = mergeTemplate(
            child(period, 'SegmentTemplate'),
            child(as, 'SegmentTemplate'),
            child(rep, 'SegmentTemplate'),
          );
          const list = child(rep, 'SegmentList') ?? child(as, 'SegmentList');
          if (template) {
            representation.plan = planFromTemplate(template, repBase.url, id, bandwidth, periodDuration);
          } else if (list) {
            representation.plan = planFromList(list, repBase.url);
          } else if (repBase.explicit || asBase.explicit) {
            representation.plan = { media: [{ url: repBase.url }] };
          } else {
            representation.planError = 'No segment information for representation';
          }
        } catch (error) {
          representation.planError = (error as Error).message;
        }
        representations.push(representation);
      }
    }
  }

  return {
    type,
    durationSec: mpdDuration,
    protected: isProtected,
    periodCount: periods.length,
    representations,
  };
}

/** Best audio track: prefers codecs compatible with the target container, then bitrate. */
export function pickDashAudio(reps: DashRepresentation[], videoCodecs?: string): DashRepresentation | undefined {
  const audio = reps.filter((r) => r.contentType === 'audio' && r.plan);
  if (!audio.length) return undefined;
  const wantsWebm = /vp0?9|vp8|av01/i.test(videoCodecs ?? '');
  const compatible = audio.filter((r) => (wantsWebm ? /opus|vorbis/i.test(r.codecs ?? '') : /mp4a|ac-3|ec-3/i.test(r.codecs ?? '')));
  const pool = compatible.length ? compatible : audio;
  return [...pool].sort((a, b) => (b.bandwidth ?? 0) - (a.bandwidth ?? 0))[0];
}
