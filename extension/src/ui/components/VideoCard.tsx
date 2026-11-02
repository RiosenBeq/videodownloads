import { useMemo, useState, type ReactNode } from 'react';
import {
  ArrowDownToLine,
  Check,
  Copy,
  Film,
  Info,
  LoaderCircle,
  Pencil,
  Radio,
  ShieldAlert,
  TriangleAlert,
  Waves,
} from 'lucide-react';
import { applyFilenameTemplate } from '@clipkeeper/shared/filename';
import { formatBytes, formatDuration, resolutionLabel } from '@clipkeeper/shared/format';
import { pickVariant } from '@clipkeeper/shared/quality';
import type { DetectedVideo } from '@clipkeeper/shared/types';
import { displayUrl } from '@clipkeeper/shared/url';
import { sendRuntimeMessage, type StartDownloadResponse } from '../../lib/messages';
import type { ExtensionSettings } from '../../lib/settings';
import { Badge, Button, Input, Notice, Select, type Tone } from './ui';

function formatLabel(video: DetectedVideo): string {
  if (video.kind === 'hls') return 'HLS';
  if (video.kind === 'dash') return 'DASH';
  if (video.kind === 'blob') return 'MSE';
  return video.container && video.container !== 'unknown' ? video.container.toUpperCase() : 'VIDEO';
}

function availabilityBadge(video: DetectedVideo, helperOnline: boolean): { tone: Tone; label: string; icon?: ReactNode } {
  switch (video.availability) {
    case 'available':
      return { tone: 'success', label: 'Ready' };
    case 'needs-backend':
      return helperOnline ? { tone: 'accent', label: 'Stream', icon: <Waves size={10} /> } : { tone: 'warning', label: 'Needs helper' };
    case 'drm':
      return { tone: 'danger', label: 'Protected', icon: <ShieldAlert size={10} /> };
    case 'blob':
      return { tone: 'warning', label: 'Not directly saveable' };
    case 'live':
      return { tone: 'info', label: 'Live', icon: <Radio size={10} /> };
    case 'unsupported':
      return { tone: 'neutral', label: 'Unsupported' };
    default:
      return { tone: 'neutral', label: 'Checking' };
  }
}

function Thumbnail({ video }: { video: DetectedVideo }) {
  const [failed, setFailed] = useState(false);
  const duration = formatDuration(video.durationSec);
  return (
    <div className="relative h-[54px] w-[96px] shrink-0 overflow-hidden rounded-[9px] border border-line bg-panel-2">
      {video.posterUrl && !failed ? (
        <img src={video.posterUrl} alt="" className="h-full w-full object-cover" referrerPolicy="no-referrer" onError={() => setFailed(true)} />
      ) : (
        <div className="flex h-full w-full items-center justify-center bg-[linear-gradient(135deg,rgba(91,140,255,0.16),rgba(155,92,246,0.16))] text-ink-faint">
          <Film size={18} strokeWidth={1.6} />
        </div>
      )}
      {video.isLive ? (
        <span className="absolute right-1 bottom-1 rounded bg-danger px-1 text-[9.5px] font-bold text-white">LIVE</span>
      ) : (
        duration && <span className="absolute right-1 bottom-1 rounded bg-black/70 px-1 font-mono text-[9.5px] font-medium text-white">{duration}</span>
      )}
    </div>
  );
}

type Feedback =
  | { kind: 'success'; message: string }
  | { kind: 'error'; message: string }
  | { kind: 'duplicate'; message: string; inHistory: boolean };

export interface VideoCardProps {
  video: DetectedVideo;
  tabId: number;
  settings: ExtensionSettings;
  helperOnline: boolean;
  onStarted: () => void;
  onOpenSettings: () => void;
}

export function VideoCard({ video, tabId, settings, helperOnline, onStarted, onOpenSettings }: VideoCardProps) {
  const variants = video.variants ?? [];
  const preferred = useMemo(() => pickVariant(variants, settings.quality, settings.container), [variants, settings.quality, settings.container]);
  const [variantId, setVariantId] = useState<string | undefined>();
  const selected = variants.find((v) => v.id === (variantId ?? preferred?.id));
  const [editing, setEditing] = useState(false);
  const [filename, setFilename] = useState('');
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<Feedback>();
  const [copied, setCopied] = useState(false);

  const badge = availabilityBadge(video, helperOnline);
  const blocked = ['drm', 'blob', 'live', 'unsupported'].includes(video.availability);
  const needsHelper = video.availability === 'needs-backend' || (video.kind === 'direct' && settings.directEngine === 'helper');
  const helperMissing = needsHelper && !helperOnline && video.kind !== 'direct';
  const resolution = resolutionLabel(selected?.height ?? video.height, selected?.width ?? video.width);
  const size = selected?.sizeBytes ?? video.sizeBytes;
  const estimated = selected ? selected.sizeEstimated : video.sizeEstimated;
  const suggestedName = applyFilenameTemplate(settings.filenameTemplate, { title: video.title, site: video.siteName, resolution });

  const start = async (force = false) => {
    setBusy(true);
    setFeedback(undefined);
    try {
      const response = await sendRuntimeMessage<StartDownloadResponse>({
        type: 'download:start',
        tabId,
        videoId: video.id,
        variantId: selected?.id,
        filename: editing && filename.trim() ? filename.trim() : undefined,
        force,
      });
      if (response.ok) {
        setFeedback({ kind: 'success', message: response.engine === 'browser' ? 'Downloading with Chrome' : 'Sent to the Clipkeeper helper' });
        onStarted();
      } else if (response.error.code === 'DUPLICATE') {
        const details = response.error.details as { inHistory?: boolean } | undefined;
        setFeedback({ kind: 'duplicate', message: response.error.message, inHistory: !!details?.inHistory });
      } else {
        setFeedback({ kind: 'error', message: response.error.message });
      }
    } catch (error) {
      setFeedback({ kind: 'error', message: (error as Error).message });
    } finally {
      setBusy(false);
    }
  };

  const copyUrl = async () => {
    await navigator.clipboard.writeText(video.url);
    setCopied(true);
    setTimeout(() => setCopied(false), 1400);
  };

  const meta = [video.siteName || video.sourceHost, resolution, size ? `${estimated ? '~' : ''}${formatBytes(size)}` : ''].filter(Boolean);

  return (
    <article className="animate-in group rounded-[14px] border border-line bg-panel p-2.5 shadow-card transition-colors hover:border-line-strong" data-testid="video-card" data-kind={video.kind}>
      <div className="flex gap-2.5">
        <Thumbnail video={video} />
        <div className="min-w-0 flex-1">
          <h3 className="line-clamp-2 text-[12.5px] leading-[1.35] font-semibold text-ink" title={video.title}>
            {video.title}
          </h3>
          <div className="mt-1 flex flex-wrap items-center gap-1">
            <Badge tone={badge.tone} title={video.availabilityReason}>
              {badge.icon}
              {badge.label}
            </Badge>
            <Badge>{formatLabel(video)}</Badge>
            <span className="truncate text-[11px] text-ink-muted">{meta.join(' · ')}</span>
          </div>
        </div>
      </div>

      {!blocked && (
        <div className="mt-2.5 flex items-center gap-1.5">
          {variants.length > 1 ? (
            <Select
              aria-label="Quality"
              value={selected?.id}
              onChange={(e) => setVariantId(e.target.value)}
              className="max-w-[190px] flex-1"
              data-testid="quality-select"
            >
              {variants.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.label}
                  {v.sizeBytes ? `  —  ${v.sizeEstimated ? '~' : ''}${formatBytes(v.sizeBytes)}` : ''}
                </option>
              ))}
            </Select>
          ) : (
            <span className="flex-1 truncate pl-0.5 text-[11px] text-ink-faint" title={video.url}>
              {displayUrl(video.url, 42)}
            </span>
          )}
          <Button size="icon" variant="ghost" title="Copy media URL" aria-label="Copy media URL" onClick={() => void copyUrl()}>
            {copied ? <Check size={14} className="text-success" /> : <Copy size={14} />}
          </Button>
          <Button
            size="icon"
            variant={editing ? 'secondary' : 'ghost'}
            title="Custom file name"
            aria-label="Custom file name"
            onClick={() => {
              setEditing((e) => !e);
              if (!filename) setFilename(suggestedName);
            }}
          >
            <Pencil size={13} />
          </Button>
          <Button
            variant="primary"
            size="sm"
            disabled={busy || helperMissing}
            onClick={() => void start()}
            icon={busy ? <LoaderCircle size={13} className="animate-spin" /> : <ArrowDownToLine size={13} strokeWidth={2.4} />}
            data-testid="download-button"
          >
            Download
          </Button>
        </div>
      )}

      {editing && !blocked && (
        <div className="mt-2 flex items-center gap-1.5">
          <Input
            value={filename}
            onChange={(e) => setFilename(e.target.value)}
            placeholder={suggestedName}
            aria-label="File name"
            className="h-7 text-[12px]"
            maxLength={200}
          />
          <span className="text-[11px] text-ink-faint">.{video.kind === 'direct' ? (selected?.container ?? video.container).replace('unknown', 'mp4') : 'mp4'}</span>
        </div>
      )}

      {blocked && video.availabilityReason && (
        <div className="mt-2">
          <Notice tone={video.availability === 'drm' ? 'danger' : video.availability === 'live' ? 'info' : 'warning'} icon={<ShieldAlert size={12} />}>
            {video.availabilityReason}
          </Notice>
        </div>
      )}

      {helperMissing && !blocked && (
        <div className="mt-2">
          <Notice
            tone="warning"
            icon={<TriangleAlert size={12} />}
            action={
              <button className="shrink-0 font-semibold underline-offset-2 hover:underline" onClick={onOpenSettings}>
                Set up
              </button>
            }
          >
            Streams are saved by the local helper, which isn't connected.
          </Notice>
        </div>
      )}

      {video.probeError && !blocked && (
        <div className="mt-1.5 text-[11px] text-ink-faint">Couldn't inspect the stream ({video.probeError}); the helper will try when downloading.</div>
      )}

      {feedback && (
        <div className="mt-2">
          {feedback.kind === 'success' && (
            <Notice tone="success" icon={<Check size={12} />}>
              {feedback.message}
            </Notice>
          )}
          {feedback.kind === 'error' && (
            <Notice tone="danger" icon={<TriangleAlert size={12} />}>
              {feedback.message}
            </Notice>
          )}
          {feedback.kind === 'duplicate' && (
            <Notice
              tone="info"
              icon={<Info size={12} />}
              action={
                feedback.inHistory ? (
                  <button className="shrink-0 font-semibold underline-offset-2 hover:underline" onClick={() => void start(true)}>
                    Download again
                  </button>
                ) : undefined
              }
            >
              {feedback.message}
            </Notice>
          )}
        </div>
      )}
    </article>
  );
}
