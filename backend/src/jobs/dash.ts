/**
 * DASH downloader: picks a video representation and the best matching audio
 * representation, refuses protected/live/multi-period manifests, downloads
 * segments through the guarded client and merges with FFmpeg.
 */
import path from 'node:path';
import {
  REASONS,
  containerForCodecs,
  describeDash,
  parseMpd,
  pickDashAudio,
  pickVariant,
  type DashRepresentation,
} from '@clipkeeper/shared';
import { AppError } from '../errors';
import { concatFiles } from '../fs/files';
import { safeFetchText } from '../net/safeRequest';
import { remux } from './ffmpeg';
import { downloadSegments, type SegmentTask } from './segments';
import type { Runner, RunnerContext } from './types';

function planRepresentation(name: string, rep: DashRepresentation, workDir: string): { tasks: SegmentTask[]; order: string[] } {
  const plan = rep.plan;
  if (!plan) throw new AppError('UNSUPPORTED', rep.planError ?? REASONS.noSegments);
  const tasks: SegmentTask[] = [];
  if (plan.init) {
    tasks.push({ url: plan.init.url, range: plan.init.range ? `bytes=${plan.init.range}` : undefined, file: path.join(workDir, `${name}-init.bin`) });
  }
  plan.media.forEach((seg, i) => {
    tasks.push({
      url: seg.url,
      range: seg.range ? `bytes=${seg.range}` : undefined,
      file: path.join(workDir, `${name}-${String(i).padStart(6, '0')}.seg`),
    });
  });
  return { tasks, order: tasks.map((t) => t.file) };
}

export class DashRunner implements Runner {
  async run(ctx: RunnerContext): Promise<string> {
    ctx.update({ phase: 'Reading manifest' });
    const { text, url: finalUrl } = await safeFetchText(ctx.request.url, {
      policy: ctx.policy,
      referer: ctx.request.pageUrl,
      signal: ctx.signal,
    });
    const manifest = parseMpd(text, finalUrl);
    const description = describeDash(manifest);
    if (description.availability === 'drm') throw new AppError('DRM_PROTECTED', REASONS.drm);
    if (description.availability === 'live') throw new AppError('LIVE_UNSUPPORTED', REASONS.live);
    if (description.availability !== 'needs-backend') throw new AppError('UNSUPPORTED', description.reason ?? REASONS.noSegments);

    const chosen =
      description.variants.find((v) => v.id === ctx.request.variantId) ??
      pickVariant(description.variants, ctx.request.quality ?? 'highest', ctx.request.container ?? 'any');
    const videoRep = manifest.representations.find((r) => r.id === chosen?.id && r.contentType === 'video');
    if (!chosen || !videoRep) throw new AppError('UNSUPPORTED', 'The manifest has no downloadable video representation.');
    const audioRep = pickDashAudio(manifest.representations, videoRep.codecs);
    ctx.update({ variantLabel: chosen.label });

    const video = planRepresentation('video', videoRep, ctx.workDir);
    const audio = audioRep ? planRepresentation('audio', audioRep, ctx.workDir) : undefined;
    const allTasks = [...video.tasks, ...(audio?.tasks ?? [])];
    const initialEstimate = chosen.sizeBytes;

    ctx.update({ phase: undefined, segmentsTotal: allTasks.length, totalBytes: initialEstimate, totalEstimated: true });
    await downloadSegments(ctx, allTasks, ({ bytes, done, total }) => {
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
    const videoContainer = containerForCodecs(videoRep.codecs);
    const videoFile = path.join(ctx.workDir, `video.${videoContainer}`);
    await concatFiles(video.order, videoFile, ctx.signal);
    let audioFile: string | undefined;
    if (audio && audioRep) {
      audioFile = path.join(ctx.workDir, `audio.${/opus|vorbis/i.test(audioRep.codecs ?? '') ? 'webm' : 'm4a'}`);
      await concatFiles(audio.order, audioFile, ctx.signal);
    }

    const ffmpeg = ctx.deps.ffmpeg;
    if (!ffmpeg.found || !ffmpeg.path) {
      if (audioFile) throw new AppError('DEPENDENCY_MISSING', 'FFmpeg is required to merge the separate audio and video tracks of this stream.');
      return ctx.finalize(videoFile, videoContainer);
    }

    // WebM only holds VP8/VP9/AV1 with Opus/Vorbis; anything else goes to MP4 (or MKV as a fallback).
    const audioIsWebm = !audioRep || /opus|vorbis/i.test(audioRep.codecs ?? '');
    const target = videoContainer === 'webm' ? (audioIsWebm ? 'webm' : 'mkv') : 'mp4';
    ctx.update({ phase: 'Merging with FFmpeg', status: 'merging' });
    const result = await remux({
      ffmpeg: ffmpeg.path,
      inputs: audioFile ? [videoFile, audioFile] : [videoFile],
      output: path.join(ctx.workDir, `output.${target}`),
      container: target,
      signal: ctx.signal,
      durationSec: manifest.durationSec,
      onProgress: (ratio) => ctx.update({ phase: `Merging with FFmpeg · ${Math.round(ratio * 100)}%` }),
    });
    return ctx.finalize(result.output, result.container);
  }
}
