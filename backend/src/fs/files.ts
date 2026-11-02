/**
 * Filesystem helpers: atomic JSON persistence, download-folder validation,
 * path containment and collision-free output names.
 */
import { randomBytes } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { splitExtension } from '@clipkeeper/shared';
import { AppError } from '../errors';

export async function readJson<T>(file: string): Promise<T | undefined> {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8')) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    // A corrupt file is moved aside rather than crashing the helper.
    if (error instanceof SyntaxError) {
      await fs.rename(file, `${file}.corrupt-${Date.now()}`).catch(() => undefined);
      return undefined;
    }
    throw error;
  }
}

/** Write JSON via temp file + rename so readers never see a partial file. */
export async function writeJsonAtomic(file: string, data: unknown, mode = 0o600): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(data, null, 2), { mode });
  try {
    await fs.rename(tmp, file);
  } catch (error) {
    await fs.rm(tmp, { force: true });
    throw error;
  }
}

export async function fileSize(file: string): Promise<number> {
  try {
    return (await fs.stat(file)).size;
  } catch {
    return 0;
  }
}

export async function exists(file: string): Promise<boolean> {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

function systemDirectories(): string[] {
  if (process.platform === 'win32') {
    const sysRoot = process.env.SystemRoot ?? 'C:\\Windows';
    return [
      sysRoot,
      process.env.ProgramFiles ?? 'C:\\Program Files',
      process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)',
      process.env.ProgramData ?? 'C:\\ProgramData',
    ];
  }
  return ['/bin', '/sbin', '/usr', '/etc', '/dev', '/proc', '/sys', '/boot', '/System', '/Library', '/Applications', '/private/etc', '/cores'];
}

export function isSystemPath(target: string): boolean {
  const resolved = path.resolve(target);
  if (resolved === path.parse(resolved).root) return true;
  const norm = process.platform === 'win32' || process.platform === 'darwin' ? resolved.toLowerCase() : resolved;
  return systemDirectories().some((dir) => {
    const d = process.platform === 'win32' || process.platform === 'darwin' ? dir.toLowerCase() : dir;
    return norm === d || norm.startsWith(d + path.sep);
  });
}

/**
 * Validate (and create) a download folder: absolute, not a system location,
 * a directory, and writable. Returns the real path.
 */
export async function validateDownloadDir(input: string): Promise<string> {
  const expanded = input.startsWith('~') ? path.join(os.homedir(), input.slice(1)) : input;
  if (!path.isAbsolute(expanded)) throw new AppError('BAD_REQUEST', 'The download folder must be an absolute path.');
  const resolved = path.resolve(expanded);
  if (isSystemPath(resolved)) throw new AppError('FORBIDDEN', 'System folders cannot be used as the download folder.');
  try {
    await fs.mkdir(resolved, { recursive: true });
    const stat = await fs.stat(resolved);
    if (!stat.isDirectory()) throw new AppError('BAD_REQUEST', 'The download location is not a folder.');
    const probe = path.join(resolved, `.clipkeeper-write-test-${randomBytes(4).toString('hex')}`);
    await fs.writeFile(probe, '');
    await fs.rm(probe, { force: true });
    const real = await fs.realpath(resolved);
    if (isSystemPath(real)) throw new AppError('FORBIDDEN', 'System folders cannot be used as the download folder.');
    return real;
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError('FILESYSTEM', `The download folder is not writable: ${(error as Error).message}`);
  }
}

/** Resolve `name` inside `dir`, refusing anything that would escape it. */
export function resolveInside(dir: string, name: string): string {
  const base = path.resolve(dir);
  const full = path.resolve(base, name);
  const rel = path.relative(base, full);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new AppError('FORBIDDEN', 'Refusing to write outside the download folder.');
  }
  return full;
}

/**
 * First free path for `filename` in `dir`: "name.mp4", "name (1).mp4", ...
 * `reserved` holds paths claimed by other in-flight jobs.
 */
export async function uniqueOutputPath(dir: string, filename: string, reserved: ReadonlySet<string> = new Set()): Promise<string> {
  const { base, ext } = splitExtension(filename);
  for (let i = 0; i < 10_000; i++) {
    const candidate = resolveInside(dir, i === 0 ? filename : `${base} (${i})${ext ? `.${ext}` : ''}`);
    if (!reserved.has(candidate) && !(await exists(candidate))) return candidate;
  }
  throw new AppError('FILESYSTEM', 'Could not find a free file name.');
}

/** Move a file, falling back to copy+delete across volumes. */
export async function moveFile(from: string, to: string): Promise<void> {
  try {
    await fs.rename(from, to);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error;
    await pipeline(createReadStream(from), createWriteStream(to, { flags: 'wx' }));
    await fs.rm(from, { force: true });
  }
}

/** Concatenate files in order into `output`. */
export async function concatFiles(inputs: string[], output: string, signal?: AbortSignal): Promise<void> {
  const out = await fs.open(output, 'w');
  try {
    for (const input of inputs) {
      if (signal?.aborted) throw signal.reason;
      for await (const chunk of createReadStream(input, { highWaterMark: 1 << 20 })) {
        await out.write(chunk as Buffer);
      }
    }
  } finally {
    await out.close();
  }
}
