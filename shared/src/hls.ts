/**
 * HLS (RFC 8216) playlist parser. Handles master and media playlists,
 * alternative renditions, byte ranges, EXT-X-MAP init segments and key
 * detection. Pure and environment-agnostic (browser + Node).
 */

export interface ByteRange {
  length: number;
  offset: number;
}

export interface HlsKey {
  method: string;
  uri?: string;
  keyFormat?: string;
}

export interface HlsVariant {
  uri: string;
  bandwidth?: number;
  averageBandwidth?: number;
  width?: number;
  height?: number;
  codecs?: string;
  frameRate?: number;
  audioGroup?: string;
}

export interface HlsRendition {
  type: string;
  groupId: string;
  name?: string;
  language?: string;
  uri?: string;
  isDefault: boolean;
  autoselect: boolean;
}

export interface HlsSegment {
  uri: string;
  duration: number;
  byteRange?: ByteRange;
  /** Init segment (EXT-X-MAP) in effect for this segment. */
  map?: { uri: string; byteRange?: ByteRange };
  key?: HlsKey;
  discontinuity?: boolean;
}

export interface HlsMasterPlaylist {
  type: 'master';
  variants: HlsVariant[];
  renditions: HlsRendition[];
  sessionKeys: HlsKey[];
  encrypted: boolean;
}

export interface HlsMediaPlaylist {
  type: 'media';
  segments: HlsSegment[];
  targetDuration?: number;
  mediaSequence: number;
  endList: boolean;
  playlistType?: string;
  totalDuration: number;
  keys: HlsKey[];
  encrypted: boolean;
}

export type HlsPlaylist = HlsMasterPlaylist | HlsMediaPlaylist;

export class PlaylistParseError extends Error {}

/** Parse an HLS attribute list (`KEY=value,KEY2="quoted, value"`). */
export function parseAttributeList(input: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const re = /([A-Z0-9-]+)=("[^"]*"|[^,]*)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(input))) {
    let value = match[2].trim();
    if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
    attrs[match[1]] = value;
  }
  return attrs;
}

function parseByteRange(value: string, previousEnd: number): ByteRange | undefined {
  const m = /^(\d+)(?:@(\d+))?$/.exec(value.trim());
  if (!m) return undefined;
  const length = Number(m[1]);
  const offset = m[2] !== undefined ? Number(m[2]) : previousEnd;
  return { length, offset };
}

function resolve(uri: string, baseUrl: string): string {
  try {
    return new URL(uri, baseUrl).toString();
  } catch {
    throw new PlaylistParseError(`Invalid URI in playlist: ${uri.slice(0, 100)}`);
  }
}

/** Any key method other than NONE means the media is encrypted. */
export function isEncryptedKey(key: HlsKey | undefined): boolean {
  return !!key && key.method.toUpperCase() !== 'NONE';
}

function toNumber(value: string | undefined): number | undefined {
  if (value === undefined || value === '') return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

export function parseM3u8(text: string, baseUrl: string): HlsPlaylist {
  const lines = text.replace(/^﻿/, '').split(/\r?\n/).map((l) => l.trim());
  if (!lines[0]?.startsWith('#EXTM3U')) throw new PlaylistParseError('Not an HLS playlist (missing #EXTM3U)');

  const isMaster = lines.some((l) => l.startsWith('#EXT-X-STREAM-INF'));
  return isMaster ? parseMaster(lines, baseUrl) : parseMedia(lines, baseUrl);
}

function parseMaster(lines: string[], baseUrl: string): HlsMasterPlaylist {
  const variants: HlsVariant[] = [];
  const renditions: HlsRendition[] = [];
  const sessionKeys: HlsKey[] = [];
  let pending: Record<string, string> | null = null;

  for (const line of lines) {
    if (!line) continue;
    if (line.startsWith('#EXT-X-STREAM-INF:')) {
      pending = parseAttributeList(line.slice('#EXT-X-STREAM-INF:'.length));
      continue;
    }
    if (line.startsWith('#EXT-X-MEDIA:')) {
      const a = parseAttributeList(line.slice('#EXT-X-MEDIA:'.length));
      renditions.push({
        type: (a.TYPE ?? '').toUpperCase(),
        groupId: a['GROUP-ID'] ?? '',
        name: a.NAME,
        language: a.LANGUAGE,
        uri: a.URI ? resolve(a.URI, baseUrl) : undefined,
        isDefault: a.DEFAULT === 'YES',
        autoselect: a.AUTOSELECT === 'YES',
      });
      continue;
    }
    if (line.startsWith('#EXT-X-SESSION-KEY:')) {
      const a = parseAttributeList(line.slice('#EXT-X-SESSION-KEY:'.length));
      sessionKeys.push({ method: a.METHOD ?? 'NONE', uri: a.URI, keyFormat: a.KEYFORMAT });
      continue;
    }
    if (line.startsWith('#')) continue;
    if (pending) {
      const [w, h] = (pending.RESOLUTION ?? '').split('x').map((n) => Number(n));
      variants.push({
        uri: resolve(line, baseUrl),
        bandwidth: toNumber(pending.BANDWIDTH),
        averageBandwidth: toNumber(pending['AVERAGE-BANDWIDTH']),
        width: Number.isFinite(w) && w > 0 ? w : undefined,
        height: Number.isFinite(h) && h > 0 ? h : undefined,
        codecs: pending.CODECS,
        frameRate: toNumber(pending['FRAME-RATE']),
        audioGroup: pending.AUDIO,
      });
      pending = null;
    }
  }

  return { type: 'master', variants, renditions, sessionKeys, encrypted: sessionKeys.some(isEncryptedKey) };
}

function parseMedia(lines: string[], baseUrl: string): HlsMediaPlaylist {
  const segments: HlsSegment[] = [];
  const keys: HlsKey[] = [];
  let targetDuration: number | undefined;
  let mediaSequence = 0;
  let endList = false;
  let playlistType: string | undefined;
  let currentKey: HlsKey | undefined;
  let currentMap: HlsSegment['map'];
  let duration: number | null = null;
  let byteRange: ByteRange | undefined;
  let lastRangeEnd = 0;
  let discontinuity = false;

  for (const line of lines) {
    if (!line) continue;
    if (line.startsWith('#EXTINF:')) {
      duration = Number.parseFloat(line.slice(8).split(',')[0]) || 0;
    } else if (line.startsWith('#EXT-X-TARGETDURATION:')) {
      targetDuration = toNumber(line.slice(22));
    } else if (line.startsWith('#EXT-X-MEDIA-SEQUENCE:')) {
      mediaSequence = toNumber(line.slice(22)) ?? 0;
    } else if (line === '#EXT-X-ENDLIST') {
      endList = true;
    } else if (line.startsWith('#EXT-X-PLAYLIST-TYPE:')) {
      playlistType = line.slice(21).trim().toUpperCase();
    } else if (line.startsWith('#EXT-X-KEY:')) {
      const a = parseAttributeList(line.slice(11));
      currentKey = { method: (a.METHOD ?? 'NONE').toUpperCase(), uri: a.URI, keyFormat: a.KEYFORMAT };
      keys.push(currentKey);
    } else if (line.startsWith('#EXT-X-MAP:')) {
      const a = parseAttributeList(line.slice(11));
      if (a.URI) {
        currentMap = {
          uri: resolve(a.URI, baseUrl),
          byteRange: a.BYTERANGE ? parseByteRange(a.BYTERANGE, 0) : undefined,
        };
      }
    } else if (line.startsWith('#EXT-X-BYTERANGE:')) {
      byteRange = parseByteRange(line.slice(17), lastRangeEnd);
    } else if (line === '#EXT-X-DISCONTINUITY') {
      discontinuity = true;
    } else if (!line.startsWith('#')) {
      const uri = resolve(line, baseUrl);
      const segment: HlsSegment = { uri, duration: duration ?? 0 };
      if (byteRange) {
        segment.byteRange = byteRange;
        lastRangeEnd = byteRange.offset + byteRange.length;
      }
      if (currentMap) segment.map = currentMap;
      if (currentKey && isEncryptedKey(currentKey)) segment.key = currentKey;
      if (discontinuity) segment.discontinuity = true;
      segments.push(segment);
      duration = null;
      byteRange = undefined;
      discontinuity = false;
    }
  }

  const totalDuration = segments.reduce((sum, s) => sum + s.duration, 0);
  if (playlistType === 'VOD') endList = true;
  return {
    type: 'media',
    segments,
    targetDuration,
    mediaSequence,
    endList,
    playlistType,
    totalDuration,
    keys,
    encrypted: keys.some(isEncryptedKey),
  };
}

/** Pick the audio rendition for a variant: default → autoselect → first with a URI. */
export function pickAudioRendition(master: HlsMasterPlaylist, variant: HlsVariant): HlsRendition | undefined {
  if (!variant.audioGroup) return undefined;
  const group = master.renditions.filter((r) => r.type === 'AUDIO' && r.groupId === variant.audioGroup && r.uri);
  return group.find((r) => r.isDefault) ?? group.find((r) => r.autoselect) ?? group[0];
}
