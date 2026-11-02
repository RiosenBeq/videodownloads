import { useState } from 'react';
import { Check, CircleCheck, CircleX, Copy, FolderOpen, Trash2, X } from 'lucide-react';
import { formatBytes, formatRelativeTime } from '@clipkeeper/shared/format';
import type { HistoryEntry } from '@clipkeeper/shared/types';
import { Button, cx } from './ui';

export interface HistoryRowProps {
  entry: HistoryEntry;
  onReveal: (entry: HistoryEntry) => Promise<void>;
  onRemove: (entry: HistoryEntry) => Promise<void>;
}

export function HistoryRow({ entry, onReveal, onRemove }: HistoryRowProps) {
  const [copied, setCopied] = useState(false);
  const icon =
    entry.status === 'completed' ? (
      <CircleCheck size={14} className="text-success" />
    ) : entry.status === 'failed' ? (
      <CircleX size={14} className="text-danger" />
    ) : (
      <X size={14} className="text-ink-faint" />
    );
  const meta = [
    entry.status === 'completed' ? formatBytes(entry.sizeBytes) : entry.status === 'failed' ? 'Failed' : 'Canceled',
    entry.siteName,
    formatRelativeTime(entry.completedAt),
  ].filter((v) => v && v !== '—');

  const copy = async () => {
    await navigator.clipboard.writeText(entry.url);
    setCopied(true);
    setTimeout(() => setCopied(false), 1200);
  };

  return (
    <div className="group flex items-center gap-2.5 rounded-[11px] px-2 py-2 transition-colors hover:bg-panel-hover" data-testid="history-row">
      <span className={cx('flex h-7 w-7 shrink-0 items-center justify-center rounded-[9px] border border-line bg-panel')}>{icon}</span>
      <div className="min-w-0 flex-1">
        <div className="truncate text-[12.5px] font-medium text-ink" title={entry.title}>
          {entry.title}
        </div>
        <div className="truncate text-[11px] text-ink-muted" title={entry.error ?? entry.filePath ?? entry.filename}>
          {entry.status === 'failed' && entry.error ? entry.error : `${entry.filename} · ${meta.join(' · ')}`}
        </div>
      </div>
      <div className="hidden shrink-0 items-center group-focus-within:flex group-hover:flex">
        {entry.status === 'completed' && (
          <Button size="icon" variant="ghost" title="Show in folder" aria-label="Show in folder" onClick={() => void onReveal(entry).catch(() => undefined)}>
            <FolderOpen size={13} />
          </Button>
        )}
        <Button size="icon" variant="ghost" title="Copy source URL" aria-label="Copy source URL" onClick={() => void copy()}>
          {copied ? <Check size={13} className="text-success" /> : <Copy size={13} />}
        </Button>
        <Button size="icon" variant="ghost" title="Remove from history" aria-label="Remove from history" onClick={() => void onRemove(entry)}>
          <Trash2 size={12.5} />
        </Button>
      </div>
    </div>
  );
}
