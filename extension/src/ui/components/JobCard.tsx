import { useState } from 'react';
import { CircleCheck, CircleX, Clock, FolderOpen, LoaderCircle, Pause, Play, RotateCw, Trash2, X } from 'lucide-react';
import { formatBytes, formatEta, formatSpeed } from '@clipkeeper/shared/format';
import type { DownloadJob } from '@clipkeeper/shared/types';
import type { JobCommand } from '../hooks/useJobs';
import { Badge, Button, ProgressBar, cx } from './ui';

function StatusIcon({ job }: { job: DownloadJob }) {
  const base = 'flex h-7 w-7 shrink-0 items-center justify-center rounded-[9px]';
  switch (job.status) {
    case 'completed':
      return (
        <span className={cx(base, 'bg-success-soft text-success')}>
          <CircleCheck size={15} />
        </span>
      );
    case 'failed':
      return (
        <span className={cx(base, 'bg-danger-soft text-danger')}>
          <CircleX size={15} />
        </span>
      );
    case 'paused':
    case 'canceled':
      return (
        <span className={cx(base, 'bg-panel-2 text-ink-muted')}>
          {job.status === 'paused' ? <Pause size={14} /> : <X size={14} />}
        </span>
      );
    case 'queued':
      return (
        <span className={cx(base, 'bg-panel-2 text-ink-muted')}>
          <Clock size={14} />
        </span>
      );
    default:
      return (
        <span className={cx(base, 'bg-accent-soft text-accent-ink')}>
          <LoaderCircle size={15} className="animate-spin [animation-duration:1.6s]" />
        </span>
      );
  }
}

function statusLine(job: DownloadJob): string {
  const pct = job.progress !== undefined ? `${Math.floor(job.progress * 100)}%` : '';
  const bytes = job.totalBytes
    ? `${formatBytes(job.bytesDownloaded)} of ${job.totalEstimated ? '~' : ''}${formatBytes(job.totalBytes)}`
    : job.bytesDownloaded
      ? formatBytes(job.bytesDownloaded)
      : '';
  switch (job.status) {
    case 'downloading': {
      if (job.phase) return job.phase;
      const parts = [pct, formatSpeed(job.speedBps) !== '—' ? formatSpeed(job.speedBps) : '', job.etaSec !== undefined ? `${formatEta(job.etaSec)} left` : ''];
      return parts.filter(Boolean).join(' · ') || 'Starting…';
    }
    case 'merging':
      return job.phase ?? 'Merging with FFmpeg';
    case 'queued':
      return 'Waiting in queue';
    case 'paused':
      return [`Paused`, pct, bytes].filter(Boolean).join(' · ');
    case 'completed':
      return [formatBytes(job.totalBytes ?? job.bytesDownloaded), 'Saved'].join(' · ');
    case 'canceled':
      return 'Canceled';
    case 'failed':
      return job.error ?? 'Failed';
  }
}

export function JobCard({ job, onCommand }: { job: DownloadJob; onCommand: (job: DownloadJob, action: JobCommand) => Promise<void> }) {
  const [busy, setBusy] = useState<JobCommand>();
  const [error, setError] = useState<string>();
  const run = async (action: JobCommand) => {
    setBusy(action);
    setError(undefined);
    try {
      await onCommand(job, action);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(undefined);
    }
  };

  const active = job.status === 'downloading' || job.status === 'merging' || job.status === 'queued';
  const showBar = job.status !== 'completed' && job.status !== 'canceled';
  const indeterminate = job.status === 'merging' || job.status === 'queued' || (job.status === 'downloading' && job.progress === undefined);
  const bytes =
    job.totalBytes && job.status === 'downloading'
      ? `${formatBytes(job.bytesDownloaded)} / ${job.totalEstimated ? '~' : ''}${formatBytes(job.totalBytes)}`
      : job.segmentsTotal && job.status === 'downloading'
        ? `${job.segmentsDone ?? 0}/${job.segmentsTotal} segments`
        : '';

  return (
    <article className="animate-in rounded-[14px] border border-line bg-panel p-2.5 shadow-card" data-testid="job-card" data-status={job.status} data-engine={job.engine}>
      <div className="flex items-start gap-2.5">
        <StatusIcon job={job} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <h3 className="min-w-0 flex-1 truncate text-[12.5px] font-semibold text-ink" title={job.title}>
              {job.title}
            </h3>
            <div className="-my-1 flex shrink-0 items-center">
              {(job.status === 'downloading' || job.status === 'queued' || job.status === 'merging') && job.canPause && (
                <Button size="icon" variant="ghost" title="Pause" aria-label="Pause" disabled={!!busy} onClick={() => void run('pause')}>
                  <Pause size={13} />
                </Button>
              )}
              {job.status === 'paused' && (
                <Button size="icon" variant="ghost" title="Resume" aria-label="Resume" disabled={!!busy} onClick={() => void run('resume')}>
                  <Play size={13} />
                </Button>
              )}
              {(job.status === 'failed' || (job.status === 'canceled' && job.engine !== 'browser')) && (
                <Button size="icon" variant="ghost" title="Retry" aria-label="Retry" disabled={!!busy} onClick={() => void run('retry')}>
                  <RotateCw size={13} />
                </Button>
              )}
              {job.status === 'completed' && (
                <Button size="icon" variant="ghost" title="Show in folder" aria-label="Show in folder" onClick={() => void run('reveal')}>
                  <FolderOpen size={13} />
                </Button>
              )}
              {active || job.status === 'paused' ? (
                <Button size="icon" variant="ghost" title="Cancel" aria-label="Cancel" disabled={!!busy} onClick={() => void run('cancel')}>
                  <X size={14} />
                </Button>
              ) : (
                <Button size="icon" variant="ghost" title="Remove from list" aria-label="Remove from list" disabled={!!busy} onClick={() => void run('remove')}>
                  <Trash2 size={12.5} />
                </Button>
              )}
            </div>
          </div>
          <div className="mt-0.5 flex items-center gap-1.5 text-[11px] text-ink-muted">
            <span className="truncate" title={job.filePath ?? job.filename}>
              {job.filename}
            </span>
            {job.variantLabel && <span className="shrink-0 text-ink-faint">· {job.variantLabel.split(' · ')[0]}</span>}
            <Badge className="ml-auto shrink-0" tone={job.engine === 'browser' ? 'neutral' : 'accent'}>
              {job.engine === 'browser' ? 'Chrome' : 'Helper'}
            </Badge>
          </div>
        </div>
      </div>

      {showBar && (
        <ProgressBar
          className="mt-2.5"
          value={indeterminate ? undefined : job.progress}
          tone={job.status === 'failed' ? 'danger' : job.status === 'paused' ? 'muted' : 'accent'}
        />
      )}
      <div className={cx('mt-1.5 flex items-center gap-2 text-[11px]', job.status === 'failed' ? 'text-danger' : 'text-ink-muted')}>
        <span className="min-w-0 flex-1 truncate" title={statusLine(job)} data-testid="job-status-line">
          {statusLine(job)}
        </span>
        {bytes && <span className="shrink-0 font-mono text-[10.5px] text-ink-faint">{bytes}</span>}
      </div>
      {error && <div className="mt-1 text-[11px] text-danger">{error}</div>}
    </article>
  );
}
