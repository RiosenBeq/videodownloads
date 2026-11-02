/**
 * Job queue: creation with validation and duplicate detection, bounded
 * concurrency, pause/resume/cancel/retry, progress/speed/ETA bookkeeping,
 * history recording and persistence across helper restarts.
 */
import { randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  SpeedMeter,
  finalizeFilename,
  getSiteName,
  isJobActive,
  matchesAnyDomain,
  normalizeVideoUrl,
  safeParseUrl,
  type CreateJobRequest,
  type DownloadJob,
  type JobEngine,
} from '@clipkeeper/shared';
import type { ConfigStore } from '../config';
import type { DependencyManager } from '../deps';
import { AppError, toAppError } from '../errors';
import { fileSize, moveFile, readJson, uniqueOutputPath, writeJsonAtomic } from '../fs/files';
import type { HistoryStore } from '../history';
import { UrlPolicy } from '../net/policy';
import { DashRunner } from './dash';
import { DirectRunner, extensionFor } from './direct';
import { HlsRunner } from './hls';
import type { JobRequest, Runner, RunnerContext } from './types';
import { YtDlpRunner } from './ytdlp';

type StopReason = 'pause' | 'cancel' | 'shutdown';

interface Entry {
  job: DownloadJob;
  request: JobRequest;
  key: string;
  downloadDir: string;
  workDir: string;
  controller?: AbortController;
  stopReason?: StopReason;
  running?: Promise<void>;
  runner?: Runner;
  meter: SpeedMeter;
  reservedPath?: string;
}

interface PersistedEntry {
  job: DownloadJob;
  request: JobRequest;
  key: string;
  downloadDir: string;
  workDir: string;
}

export interface JobManagerOptions {
  config: ConfigStore;
  history: HistoryStore;
  deps: DependencyManager;
  jobsFile: string;
  /** Override runner construction (tests). */
  runnerFactory?: (engine: JobEngine) => Runner;
}

const PARTIAL_DIR = '.clipkeeper-partial';
const KEEP_FINISHED = 50;

export function engineForKind(kind: CreateJobRequest['kind']): JobEngine {
  return kind === 'page' ? 'ytdlp' : kind;
}

export function dedupeKey(engine: JobEngine, url: string, variant?: string): string {
  return `${engine}|${normalizeVideoUrl(url)}|${variant ?? ''}`;
}

function defaultRunner(engine: JobEngine): Runner {
  switch (engine) {
    case 'direct':
      return new DirectRunner();
    case 'hls':
      return new HlsRunner();
    case 'dash':
      return new DashRunner();
    case 'ytdlp':
      return new YtDlpRunner();
    default:
      throw new AppError('UNSUPPORTED', `Engine ${engine} is not handled by the helper.`);
  }
}

function titleFromUrl(url: string): string {
  const parsed = safeParseUrl(url);
  const last = decodeURIComponent(parsed?.pathname.split('/').filter(Boolean).pop() ?? '');
  return last.replace(/\.[a-z0-9]{2,5}$/i, '') || 'video';
}

export class JobManager extends EventEmitter {
  private readonly entries = new Map<string, Entry>();
  private readonly reserved = new Set<string>();
  private saveTimer?: NodeJS.Timeout;
  private saving: Promise<void> = Promise.resolve();
  private closed = false;

  constructor(private readonly options: JobManagerOptions) {
    super();
  }

  async init(): Promise<void> {
    const stored = await readJson<{ version: number; jobs: PersistedEntry[] }>(this.options.jobsFile);
    for (const p of stored?.jobs ?? []) {
      if (!p?.job?.id) continue;
      const job = { ...p.job };
      if (job.status === 'downloading' || job.status === 'merging') {
        job.status = 'paused';
        job.phase = 'Paused when the helper stopped';
      }
      job.speedBps = undefined;
      job.etaSec = undefined;
      this.entries.set(job.id, { ...p, job, meter: new SpeedMeter() });
    }
    this.pump();
  }

  list(): DownloadJob[] {
    return [...this.entries.values()].map((e) => ({ ...e.job })).sort((a, b) => b.createdAt - a.createdAt);
  }

  get(id: string): DownloadJob {
    return { ...this.require(id).job };
  }

  activeCount(): number {
    return [...this.entries.values()].filter((e) => isJobActive(e.job.status)).length;
  }

  async create(input: CreateJobRequest): Promise<DownloadJob> {
    if (this.closed) throw new AppError('INVALID_STATE', 'The helper is shutting down.');
    const settings = this.options.config.settings;
    const policy = new UrlPolicy(settings);
    const url = policy.assertUrl(input.url).toString();
    const engine = engineForKind(input.kind);

    if (engine === 'ytdlp') {
      if (!settings.ytDlpEnabled) {
        throw new AppError('YTDLP_DISABLED', 'yt-dlp downloads are turned off. Enable them in the extension settings under "Sources & safety".');
      }
      const host = new URL(url).hostname;
      if (!matchesAnyDomain(host, settings.ytDlpDomains)) {
        throw new AppError('YTDLP_DISABLED', `${host} is not in your list of domains allowed for yt-dlp.`);
      }
      const deps = await this.options.deps.detect();
      if (!deps.ytDlp.found) throw new AppError('DEPENDENCY_MISSING', `yt-dlp is not installed. Install it with: ${deps.installHints.ytDlp}`);
    }

    const key = dedupeKey(engine, url, input.variantId ?? input.formatId ?? input.quality);
    const active = [...this.entries.values()].find((e) => e.key === key && isJobActive(e.job.status));
    if (active) throw new AppError('DUPLICATE', 'This video is already in the download queue.', { jobId: active.job.id });
    if (!input.force) {
      const previous = await this.options.history.findCompleted(key);
      if (previous) {
        throw new AppError('DUPLICATE', 'This video was already downloaded.', {
          inHistory: true,
          historyId: previous.id,
          filePath: previous.filePath,
        });
      }
    }

    const title = (input.title ?? '').replace(/\s+/g, ' ').trim().slice(0, 300) || titleFromUrl(url);
    const ext = engine === 'direct' ? extensionFor(url, undefined) : 'mp4';
    const id = `j_${randomBytes(12).toString('base64url')}`;
    const now = Date.now();
    const downloadDir = settings.downloadDir;
    const entry: Entry = {
      key,
      downloadDir,
      workDir: path.join(downloadDir, PARTIAL_DIR, id),
      request: { ...input, url, title },
      meter: new SpeedMeter(),
      job: {
        id,
        engine,
        url,
        pageUrl: input.pageUrl,
        title,
        filename: finalizeFilename(input.filename?.trim() || title, ext),
        variantLabel: input.variantLabel,
        status: 'queued',
        bytesDownloaded: 0,
        retryCount: 0,
        canPause: true,
        createdAt: now,
        updatedAt: now,
      },
    };
    this.entries.set(id, entry);
    this.emit('update', { ...entry.job });
    this.scheduleSave();
    this.pump();
    return { ...entry.job };
  }

  pause(id: string): DownloadJob {
    const entry = this.require(id);
    const { status } = entry.job;
    if (status === 'queued') {
      this.patch(entry, { status: 'paused', phase: undefined });
    } else if ((status === 'downloading' || status === 'merging') && entry.controller) {
      entry.stopReason = 'pause';
      entry.controller.abort(new DOMException('Paused', 'AbortError'));
    } else {
      throw new AppError('INVALID_STATE', `Cannot pause a ${status} download.`);
    }
    return this.get(id);
  }

  resume(id: string): DownloadJob {
    const entry = this.require(id);
    if (entry.job.status !== 'paused') throw new AppError('INVALID_STATE', `Cannot resume a ${entry.job.status} download.`);
    this.patch(entry, { status: 'queued', phase: undefined, error: undefined });
    this.pump();
    return this.get(id);
  }

  async cancel(id: string): Promise<DownloadJob> {
    const entry = this.require(id);
    const { status } = entry.job;
    if ((status === 'downloading' || status === 'merging') && entry.controller) {
      entry.stopReason = 'cancel';
      entry.controller.abort(new DOMException('Canceled', 'AbortError'));
      await entry.running;
    } else if (status === 'queued' || status === 'paused') {
      this.patch(entry, { status: 'canceled', speedBps: undefined, etaSec: undefined, phase: undefined });
      await fs.rm(entry.workDir, { recursive: true, force: true });
    } else {
      throw new AppError('INVALID_STATE', `Cannot cancel a ${status} download.`);
    }
    return this.get(id);
  }

  retry(id: string): DownloadJob {
    const entry = this.require(id);
    if (entry.job.status !== 'failed' && entry.job.status !== 'canceled') {
      throw new AppError('INVALID_STATE', `Only failed or canceled downloads can be retried.`);
    }
    entry.runner = undefined;
    this.patch(entry, { status: 'queued', error: undefined, errorCode: undefined, phase: undefined, retryCount: 0, completedAt: undefined });
    this.pump();
    return this.get(id);
  }

  remove(id: string): void {
    const entry = this.require(id);
    if (isJobActive(entry.job.status)) throw new AppError('INVALID_STATE', 'Cancel the download before removing it.');
    this.entries.delete(id);
    this.emit('removed', id);
    this.scheduleSave();
  }

  async shutdown(): Promise<void> {
    this.closed = true;
    const running = [...this.entries.values()].filter((e) => e.controller);
    for (const entry of running) {
      entry.stopReason = 'shutdown';
      entry.controller?.abort(new DOMException('Shutdown', 'AbortError'));
    }
    await Promise.race([
      Promise.allSettled(running.map((e) => e.running)),
      new Promise((resolve) => setTimeout(resolve, 5000).unref()),
    ]);
    if (this.saveTimer) clearTimeout(this.saveTimer);
    await this.save();
  }

  private require(id: string): Entry {
    const entry = this.entries.get(id);
    if (!entry) throw new AppError('NOT_FOUND', 'Download not found.');
    return entry;
  }

  private pump(): void {
    if (this.closed) return;
    const all = [...this.entries.values()];
    let running = all.filter((e) => e.controller).length;
    const queued = all.filter((e) => e.job.status === 'queued' && !e.controller).sort((a, b) => a.job.createdAt - b.job.createdAt);
    const max = this.options.config.settings.maxConcurrent;
    for (const entry of queued) {
      if (running >= max) break;
      running++;
      this.start(entry);
    }
  }

  private start(entry: Entry): void {
    const controller = new AbortController();
    entry.controller = controller;
    entry.stopReason = undefined;
    entry.meter.reset();
    this.patch(entry, { status: 'downloading', error: undefined, errorCode: undefined, phase: 'Starting' });

    const manager = this;
    entry.running = (async () => {
      const settings = this.options.config.settings;
      const deps = await this.options.deps.detect();
      await fs.mkdir(entry.workDir, { recursive: true });
      const ctx: RunnerContext = {
        get job() {
          return entry.job;
        },
        request: entry.request,
        signal: controller.signal,
        policy: new UrlPolicy(settings),
        settings: { ...settings, downloadDir: entry.downloadDir },
        deps,
        workDir: entry.workDir,
        update: (patch) => {
          if (!controller.signal.aborted) manager.patch(entry, patch);
        },
        finalize: (tmp, ext) => manager.finalizeFile(entry, tmp, ext),
      };
      // The runner instance is kept across pause/resume (yt-dlp keeps its output name).
      entry.runner ??= (this.options.runnerFactory ?? defaultRunner)(entry.job.engine);
      return entry.runner.run(ctx);
    })()
      .then(async (filePath) => {
        const size = await fileSize(filePath);
        this.patch(entry, {
          status: 'completed',
          filePath,
          filename: path.basename(filePath),
          bytesDownloaded: size,
          totalBytes: size,
          totalEstimated: false,
          progress: 1,
          speedBps: undefined,
          etaSec: undefined,
          phase: undefined,
          completedAt: Date.now(),
        });
        await fs.rm(entry.workDir, { recursive: true, force: true });
        await this.recordHistory(entry);
      })
      .catch(async (error: unknown) => {
        const reason = entry.stopReason;
        if (reason === 'pause' || reason === 'shutdown') {
          this.patch(entry, { status: 'paused', speedBps: undefined, etaSec: undefined, phase: undefined });
        } else if (reason === 'cancel') {
          this.patch(entry, { status: 'canceled', speedBps: undefined, etaSec: undefined, phase: undefined });
          await fs.rm(entry.workDir, { recursive: true, force: true });
        } else {
          const appError = toAppError(error);
          this.patch(entry, {
            status: 'failed',
            error: appError.message,
            errorCode: appError.code,
            speedBps: undefined,
            etaSec: undefined,
            phase: undefined,
          });
          await this.recordHistory(entry);
        }
      })
      .finally(() => {
        entry.controller = undefined;
        entry.running = undefined;
        if (entry.reservedPath) this.reserved.delete(entry.reservedPath);
        entry.reservedPath = undefined;
        this.scheduleSave();
        this.pump();
      });
  }

  private async finalizeFile(entry: Entry, tempFile: string, extension: string): Promise<string> {
    await fs.mkdir(entry.downloadDir, { recursive: true });
    const name = finalizeFilename(entry.job.filename, extension);
    const target = await uniqueOutputPath(entry.downloadDir, name, this.reserved);
    this.reserved.add(target);
    entry.reservedPath = target;
    await moveFile(tempFile, target);
    return target;
  }

  private async recordHistory(entry: Entry): Promise<void> {
    const job = entry.job;
    if (job.status !== 'completed' && job.status !== 'failed') return;
    await this.options.history.add({
      jobId: job.id,
      key: entry.key,
      title: job.title,
      url: job.url,
      pageUrl: job.pageUrl,
      siteName: getSiteName(job.pageUrl ?? job.url),
      filename: job.filename,
      filePath: job.filePath,
      sizeBytes: job.status === 'completed' ? job.totalBytes : undefined,
      engine: job.engine,
      status: job.status,
      variantLabel: job.variantLabel,
      error: job.error,
      completedAt: Date.now(),
    });
  }

  private patch(entry: Entry, patch: Partial<DownloadJob>): void {
    const before = entry.job;
    const job: DownloadJob = { ...before, ...patch, updatedAt: Date.now() };
    if (patch.bytesDownloaded !== undefined && job.status === 'downloading') {
      entry.meter.push(job.bytesDownloaded);
      job.speedBps = entry.meter.speed();
      job.etaSec = job.totalBytes ? entry.meter.eta(job.totalBytes, job.bytesDownloaded) : undefined;
    }
    if (job.status === 'completed') {
      job.progress = 1;
    } else if (job.totalBytes && job.totalBytes > 0) {
      job.progress = Math.min(0.999, job.bytesDownloaded / job.totalBytes);
    } else if (job.segmentsTotal) {
      job.progress = Math.min(0.999, (job.segmentsDone ?? 0) / job.segmentsTotal);
    }
    entry.job = job;
    this.emit('update', { ...job });
    if (before.status !== job.status) this.scheduleSave(0);
    else this.scheduleSave();
  }

  private scheduleSave(delay = 1000): void {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => void this.save(), delay);
    this.saveTimer.unref();
  }

  private save(): Promise<void> {
    const all = [...this.entries.values()];
    const finished = all.filter((e) => !isJobActive(e.job.status)).sort((a, b) => b.job.updatedAt - a.job.updatedAt);
    const keep = [...all.filter((e) => isJobActive(e.job.status)), ...finished.slice(0, KEEP_FINISHED)];
    const data = {
      version: 1,
      jobs: keep.map(({ job, request, key, downloadDir, workDir }): PersistedEntry => ({ job, request, key, downloadDir, workDir })),
    };
    this.saving = this.saving.then(() => writeJsonAtomic(this.options.jobsFile, data)).catch(() => undefined);
    return this.saving;
  }
}
