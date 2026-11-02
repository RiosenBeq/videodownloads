/**
 * Detects FFmpeg, FFprobe and yt-dlp. Looks at explicit environment overrides,
 * PATH and the usual package-manager locations on macOS, Windows and Linux.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { DependencyInfo, DependencyStatus } from '@clipkeeper/shared';
import { runProcess } from './process';

interface BinarySpec {
  name: string;
  env: string;
  versionArgs: string[];
  parse: (output: string) => string | undefined;
}

const SPECS = {
  ffmpeg: {
    name: 'ffmpeg',
    env: 'CLIPKEEPER_FFMPEG',
    versionArgs: ['-hide_banner', '-version'],
    parse: (o: string) => /ffmpeg version (\S+)/.exec(o)?.[1],
  },
  ffprobe: {
    name: 'ffprobe',
    env: 'CLIPKEEPER_FFPROBE',
    versionArgs: ['-hide_banner', '-version'],
    parse: (o: string) => /ffprobe version (\S+)/.exec(o)?.[1],
  },
  ytDlp: {
    name: 'yt-dlp',
    env: 'CLIPKEEPER_YTDLP',
    versionArgs: ['--version'],
    parse: (o: string) => o.trim().split(/\s+/)[0] || undefined,
  },
} satisfies Record<string, BinarySpec>;

function extraDirs(): string[] {
  const home = os.homedir();
  if (process.platform === 'win32') {
    const local = process.env.LOCALAPPDATA ?? path.join(home, 'AppData', 'Local');
    return [
      path.join(local, 'Microsoft', 'WinGet', 'Links'),
      path.join(home, 'scoop', 'shims'),
      'C:\\ProgramData\\chocolatey\\bin',
      'C:\\ffmpeg\\bin',
      path.join(local, 'Programs', 'Python', 'Scripts'),
    ];
  }
  return ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/snap/bin', path.join(home, '.local', 'bin'), '/opt/local/bin'];
}

async function isExecutable(file: string): Promise<boolean> {
  try {
    const stat = await fs.stat(file);
    if (!stat.isFile()) return false;
    if (process.platform !== 'win32') await fs.access(file, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function findBinary(spec: BinarySpec): Promise<DependencyInfo> {
  const exe = process.platform === 'win32' ? `${spec.name}.exe` : spec.name;
  const candidates: string[] = [];
  const override = process.env[spec.env];
  if (override) candidates.push(override);
  const dirs = [...(process.env.PATH ?? '').split(path.delimiter).filter(Boolean), ...extraDirs()];
  for (const dir of dirs) candidates.push(path.join(dir, exe));

  const seen = new Set<string>();
  for (const candidate of candidates) {
    if (seen.has(candidate)) continue;
    seen.add(candidate);
    if (!(await isExecutable(candidate))) continue;
    try {
      const result = await runProcess(candidate, spec.versionArgs, { timeoutMs: 15_000 });
      if (result.code === 0) return { found: true, path: candidate, version: spec.parse(result.stdout) };
    } catch {
      /* try next candidate */
    }
  }
  return { found: false };
}

export function installHints(platform = process.platform): DependencyStatus['installHints'] {
  if (platform === 'darwin') {
    return { ffmpeg: 'brew install ffmpeg', ytDlp: 'brew install yt-dlp' };
  }
  if (platform === 'win32') {
    return { ffmpeg: 'winget install --id Gyan.FFmpeg -e', ytDlp: 'winget install --id yt-dlp.yt-dlp -e' };
  }
  return { ffmpeg: 'sudo apt install ffmpeg  (or your distribution\'s package manager)', ytDlp: 'pipx install yt-dlp' };
}

export class DependencyManager {
  private status?: DependencyStatus;
  private pending?: Promise<DependencyStatus>;

  async detect(force = false): Promise<DependencyStatus> {
    if (this.status && !force) return this.status;
    if (!this.pending) {
      this.pending = (async () => {
        const [ffmpeg, ffprobe, ytDlp] = await Promise.all([
          findBinary(SPECS.ffmpeg),
          findBinary(SPECS.ffprobe),
          findBinary(SPECS.ytDlp),
        ]);
        this.status = { platform: process.platform, ffmpeg, ffprobe, ytDlp, installHints: installHints() };
        return this.status;
      })().finally(() => {
        this.pending = undefined;
      });
    }
    return this.pending;
  }

  get current(): DependencyStatus | undefined {
    return this.status;
  }
}
