/**
 * HLS downloader: resolves master → variant (+ audio rendition), refuses
 * encrypted or live playlists, downloads segments through the guarded client,
 * concatenates them and remuxes with FFmpeg.
 */
import path from 'node:path';
import {
  REASONS,
  parseM3u8,
  pickAudioRendition,
  pickVariant,
  variantsFromHlsMaster,
  type HlsMediaPlaylist,
  type HlsSegment,
} from '@clipkeeper/shared';
import { AppError } from '../errors';
import { concatFiles } from '../fs/files';
import { safeFetchText } from '../net/safeRequest';
import { remux } from './ffmpeg';
import { byteRangeHeader, downloadSegments, type SegmentTask } from './segments';
import type { Runner, RunnerContext } from './types';

interface Track {
  name: 'video' | 'audio';
  playlist: HlsMediaPlaylist;
  tasks: SegmentTask[];
  /** Files in playback order (init segments interleaved where the map changes). */
  order: string[];
  fragmented: boolean;
}

async function fetchMedia(ctx: RunnerContext, url: string): Promise<HlsMediaPlaylist> {
  const { text, url: finalUrl } = await safeFetchText(url, { policy: ctx.policy, referer: ctx.request.pageUrl, signal: ctx.signal });
  const playlist = parseM3u8(text, finalUrl);
  if (playlist.type !== 'media') throw new AppError('UNSUPPORTED', 'Expected a media playlist but found a master playlist.');
  return playlist;
}

export function assertDownloadable(playlist: HlsMediaPlaylist): void {
  if (playlist.encrypted) throw new AppError('DRM_PROTECTED', REASONS.encrypted);
  if (!playlist.endList) throw new AppError('LIVE_UNSUPPORTED', REASONS.live);
  if (!playlist.segments.length) throw new AppError('UNSUPPORTED', REASONS.noSegments);
}

function planTrack(name: Track['name'], playlist: HlsMediaPlaylist, workDir: string): Track {
  const tasks: SegmentTask[] = [];
  const order: string[] = [];
  const maps = new Map<string, string>();
  let currentMap = '';
  playlist.segments.forEach((segment: HlsSegment, index) => {
    if (segment.map) {
      const key = `${segment.map.uri}|${segment.map.byteRange?.offset ?? ''}`;
      let file = maps.get(key);
      if (!file) {
        file = path.join(workDir, `${name}-init-${maps.size}.bin`);
        maps.set(key, file);
        tasks.push({
          url: segment.map.uri,
          range: segment.map.byteRange ? byteRangeHeader(segment.map.byteRange.offset, segment.map.byteRange.length) : undefined,
          file,
        });
      }
      if (key !== currentMap) {
        order.push(file);
        currentMap = key;
      }
    }
    const file = path.join(workDir, `${name}-${String(index).padStart(6, '0')}.seg`);
    tasks.push({
      url: segment.uri,
      range: segment.byteRange ? byteRangeHeader(segment.byteRange.offset, segment.byteRange.length) : undefined,
      file,
    });
    order.push(file);
  });
  return { name, playlist, tasks, order, fragmented: maps.size > 0 };
}

export class HlsRunner implements Runner {
  async run(ctx: RunnerContext): Promise<string> {
    ctx.update({ phase: 'Reading playlist' });
    const { text, url: finalUrl } = await safeFetchText(ctx.request.url, {
      policy: ctx.policy,
      referer: ctx.request.pageUrl,
      signal: ctx.signal,
    });
    const root = parseM3u8(text, finalUrl);

    let video: HlsMediaPlaylist;
    let audio: HlsMediaPlaylist | undefined;
    let bandwidth: number | undefined;
    if (root.type === 'master') {
      if (root.encrypted) throw new AppError('DRM_PROTECTED', REASONS.encrypted);
      const variants = variantsFromHlsMaster(root);
      const chosen =
        variants.find((v) => v.id === ctx.request.variantId) ?? pickVariant(variants, ctx.request.quality ?? 'highest', ctx.request.container ?? 'any');
      if (!chosen?.url) throw new AppError('UNSUPPORTED', 'The playlist has no video variants.');
      const source = root.variants.find((v) => v.uri === chosen.url)!;
      bandwidth = chosen.bandwidth;
      ctx.update({ variantLabel: chosen.label });
      video = await fetchMedia(ctx, chosen.url);
      const rendition = pickAudioRendition(root, source);
      if (rendition?.uri) audio = await fetchMedia(ctx, rendition.uri);
    } else {
      video = root;
    }
    assertDownloadable(video);
    if (audio) assertDownloadable(audio);

    const tracks = [planTrack('video', video, ctx.workDir), ...(audio ? [planTrack('audio', audio, ctx.workDir)] : [])];
    const allTasks = tracks.flatMap((t) => t.tasks);
    const durationSec = video.totalDuration;
    const initialEstimate = bandwidth ? Math.round((bandwidth * durationSec) / 8) : undefined;

    ctx.update({ phase: undefined, segmentsTotal: allTasks.length, totalBytes: initialEstimate, totalEstimated: true });
    await downloadSegments(ctx, allTasks, ({ bytes, done, total }) => {
      // Extrapolate the final size from finished segments once a few are in.
      const estimate = done >= 3 ? Math.round((bytes / done) * total) : initialEstimate;
      ctx.update({
        bytesDownloaded: bytes,
        segmentsDone: done,
        segmentsTotal: total,
        totalBytes: estimate && estimate >= bytes ? estimate : undefined,
        totalEstimated: done < total,
      });
    });

    ctx.update({ phase: 'Joining segments' });
    const joined: string[] = [];
    for (const track of tracks) {
      const out = path.join(ctx.workDir, `${track.name}.${track.fragmented ? 'mp4' : 'ts'}`);
      await concatFiles(track.order, out, ctx.signal);
      joined.push(out);
    }

    const ffmpeg = ctx.deps.ffmpeg;
    if (!ffmpeg.found || !ffmpeg.path) {
      if (joined.length > 1) {
        throw new AppError('DEPENDENCY_MISSING', 'FFmpeg is required to merge the separate audio and video tracks of this stream.');
      }
      // Single track without FFmpeg: deliver the joined stream as-is.
      return ctx.finalize(joined[0], tracks[0].fragmented ? 'mp4' : 'ts');
    }

    ctx.update({ phase: 'Merging with FFmpeg', status: 'merging' });
    const result = await remux({
      ffmpeg: ffmpeg.path,
      inputs: joined,
      output: path.join(ctx.workDir, 'output.mp4'),
      container: 'mp4',
      signal: ctx.signal,
      durationSec,
      onProgress: (ratio) => ctx.update({ phase: `Merging with FFmpeg · ${Math.round(ratio * 100)}%` }),
    });
    return ctx.finalize(result.output, result.container);
  }
}
