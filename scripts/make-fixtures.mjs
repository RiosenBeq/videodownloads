/**
 * Generates local sample media with FFmpeg for the integration and end-to-end
 * tests (all synthetic: test patterns and sine tones). Idempotent: existing
 * outputs are kept. Run directly with `npm run fixtures`.
 *
 *   sample.mp4      H.264 + AAC, 6 s, 640x360
 *   large.mp4       H.264 + AAC, ~8 MB (pause/resume tests)
 *   sample.webm     VP9 + Opus, 4 s
 *   hls-ts/         master + 2 variants (720p/360p), MPEG-TS, muxed audio
 *   hls-fmp4/       master + 2 video variants + separate audio rendition, fMP4
 *   dash/           MPD with 2 video representations + 1 audio, SegmentTimeline
 *   hls-enc/        AES-128 encrypted HLS (must be refused)
 *   live/           playlist without EXT-X-ENDLIST (must be refused)
 */
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const FIXTURES_DIR = path.resolve(here, '..', 'tests', '.fixtures');

function ffmpeg(args, cwd) {
  execFileSync(process.env.CLIPKEEPER_FFMPEG || 'ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], { cwd, stdio: 'inherit' });
}

const SRC_720 = ['-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=30', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000'];
const H264 = ['-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-g', '60', '-keyint_min', '60', '-sc_threshold', '0'];
const LADDER = ['-filter_complex', '[0:v]split=2[v1][v2];[v2]scale=640:360[v2o]'];

const steps = [
  {
    out: 'sample.mp4',
    run: (dir) =>
      ffmpeg(
        ['-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=30', '-f', 'lavfi', '-i', 'sine=frequency=440', '-t', '6', ...H264, '-c:a', 'aac', '-b:a', '96k', '-movflags', '+faststart', 'sample.mp4'],
        dir,
      ),
  },
  {
    out: 'large.mp4',
    run: (dir) =>
      ffmpeg(
        [
          '-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=30,noise=alls=30:allf=t',
          '-f', 'lavfi', '-i', 'sine=frequency=330',
          '-t', '8', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-b:v', '8M', '-maxrate', '8M', '-bufsize', '4M',
          '-c:a', 'aac', 'large.mp4',
        ],
        dir,
      ),
  },
  {
    out: 'sample.webm',
    run: (dir) =>
      ffmpeg(
        [
          '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=30', '-f', 'lavfi', '-i', 'sine=frequency=660:sample_rate=48000',
          '-t', '4', '-c:v', 'libvpx-vp9', '-deadline', 'realtime', '-cpu-used', '8', '-b:v', '600k', '-c:a', 'libopus', 'sample.webm',
        ],
        dir,
      ),
  },
  {
    out: 'hls-ts/master.m3u8',
    run: (dir) =>
      ffmpeg(
        [
          ...SRC_720, '-t', '6', ...LADDER,
          '-map', '[v1]', '-map', '[v2o]', '-map', '1:a', '-map', '1:a',
          ...H264, '-b:v:0', '2500k', '-b:v:1', '800k', '-c:a', 'aac', '-b:a', '96k',
          '-f', 'hls', '-hls_time', '2', '-hls_playlist_type', 'vod',
          '-hls_segment_filename', 'hls-ts/v%v/seg%03d.ts', '-master_pl_name', 'master.m3u8',
          '-var_stream_map', 'v:0,a:0 v:1,a:1', 'hls-ts/v%v/index.m3u8',
        ],
        dir,
      ),
  },
  {
    out: 'hls-fmp4/master.m3u8',
    run: (dir) =>
      ffmpeg(
        [
          ...SRC_720, '-t', '6', ...LADDER,
          '-map', '[v1]', '-map', '[v2o]', '-map', '1:a',
          ...H264, '-b:v:0', '2500k', '-b:v:1', '800k', '-c:a', 'aac', '-b:a', '128k',
          '-f', 'hls', '-hls_time', '2', '-hls_playlist_type', 'vod', '-hls_segment_type', 'fmp4',
          '-hls_fmp4_init_filename', 'init.mp4', '-hls_segment_filename', 'hls-fmp4/s%v/seg%03d.m4s',
          '-master_pl_name', 'master.m3u8',
          '-var_stream_map', 'v:0,agroup:aud v:1,agroup:aud a:0,agroup:aud,default:yes', 'hls-fmp4/s%v/index.m3u8',
        ],
        dir,
      ),
  },
  {
    out: 'dash/manifest.mpd',
    run: (dir) =>
      ffmpeg(
        [
          ...SRC_720, '-t', '6', ...LADDER,
          '-map', '[v1]', '-map', '[v2o]', '-map', '1:a',
          ...H264, '-b:v:0', '2500k', '-b:v:1', '800k', '-c:a', 'aac', '-b:a', '128k',
          '-f', 'dash', '-seg_duration', '2', '-use_template', '1', '-use_timeline', '1',
          '-adaptation_sets', 'id=0,streams=v id=1,streams=a', 'dash/manifest.mpd',
        ],
        dir,
      ),
  },
  {
    out: 'hls-enc/index.m3u8',
    run: (dir) => {
      const encDir = path.join(dir, 'hls-enc');
      fs.writeFileSync(path.join(encDir, 'enc.key'), randomBytes(16));
      fs.writeFileSync(path.join(encDir, 'keyinfo'), `enc.key\n${path.join(encDir, 'enc.key')}\n`);
      ffmpeg(
        [
          '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=30', '-f', 'lavfi', '-i', 'sine', '-t', '4', ...H264, '-c:a', 'aac',
          '-f', 'hls', '-hls_time', '2', '-hls_playlist_type', 'vod', '-hls_key_info_file', path.join(encDir, 'keyinfo'),
          '-hls_segment_filename', 'hls-enc/seg%03d.ts', 'hls-enc/index.m3u8',
        ],
        dir,
      );
    },
  },
  {
    out: 'live/index.m3u8',
    run: (dir) => {
      // A rolling live window: no #EXT-X-ENDLIST and no VOD playlist type.
      const segs = fs.readdirSync(path.join(dir, 'hls-ts', 'v1')).filter((f) => f.endsWith('.ts')).slice(0, 2);
      const body = ['#EXTM3U', '#EXT-X-VERSION:3', '#EXT-X-TARGETDURATION:2', '#EXT-X-MEDIA-SEQUENCE:120'];
      for (const s of segs) body.push('#EXTINF:2.0,', `../hls-ts/v1/${s}`);
      fs.writeFileSync(path.join(dir, 'live', 'index.m3u8'), `${body.join('\n')}\n`);
    },
  },
];

export function ensureFixtures(dir = FIXTURES_DIR) {
  for (const sub of ['hls-ts', 'hls-fmp4', 'dash', 'hls-enc', 'live']) fs.mkdirSync(path.join(dir, sub), { recursive: true });
  for (const step of steps) {
    if (fs.existsSync(path.join(dir, step.out))) continue;
    step.run(dir);
  }
  return dir;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const dir = ensureFixtures();
  console.log(`Fixtures ready in ${dir}`);
}
