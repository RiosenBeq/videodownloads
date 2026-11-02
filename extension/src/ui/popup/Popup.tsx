import { useMemo, useState } from 'react';
import { ArrowDownToLine, Clapperboard, Globe, History, RefreshCw, ScanSearch, Settings, ShieldCheck, Trash2 } from 'lucide-react';
import { useJobs, useHistory } from '../hooks/useJobs';
import { useHelper, useSettings, useTheme } from '../hooks/useSettings';
import { useActiveTab, useTabVideos } from '../hooks/useTabVideos';
import { HistoryRow } from '../components/HistoryRow';
import { JobCard } from '../components/JobCard';
import { VideoCard } from '../components/VideoCard';
import { Button, EmptyState, Segmented, cx } from '../components/ui';
import type { HelperState } from '../../lib/api';

type Tab = 'videos' | 'downloads' | 'history';

function openSettings(section?: string) {
  const url = chrome.runtime.getURL(`options.html${section ? `#${section}` : ''}`);
  void chrome.tabs.create({ url });
}

function HelperPill({ helper, onClick }: { helper: HelperState | { state: 'checking' }; onClick: () => void }) {
  const map = {
    online: { dot: 'bg-success shadow-[0_0_0_3px_var(--success-soft)]', label: 'Helper', title: 'Local helper connected' },
    offline: { dot: 'bg-ink-faint', label: 'Browser only', title: 'Local helper not running — direct files still work' },
    'not-configured': { dot: 'bg-warning', label: 'Pair helper', title: 'Helper running but not paired — add its token in Settings' },
    unauthorized: { dot: 'bg-warning', label: 'Token?', title: 'The helper rejected the token' },
    checking: { dot: 'bg-ink-faint animate-pulse', label: 'Checking', title: 'Checking the local helper' },
  }[helper.state];
  return (
    <button
      onClick={onClick}
      title={map.title}
      className="flex h-7 items-center gap-1.5 rounded-full border border-line bg-panel px-2.5 text-[11px] font-medium text-ink-muted transition-colors hover:border-line-strong hover:text-ink"
      data-testid="helper-pill"
      data-state={helper.state}
    >
      <span className={cx('h-1.5 w-1.5 rounded-full', map.dot)} />
      {map.label}
    </button>
  );
}

function Logo() {
  return (
    <div className="gradient-accent flex h-8 w-8 items-center justify-center rounded-[10px] text-white shadow-[0_6px_16px_-6px_rgba(109,94,246,0.8),inset_0_1px_0_rgba(255,255,255,0.3)]">
      <ArrowDownToLine size={16} strokeWidth={2.4} />
    </div>
  );
}

export function Popup() {
  const { settings, loaded, update } = useSettings();
  useTheme(settings.theme);
  const { client, helper, online, refreshHelper } = useHelper(settings, loaded);
  const { tabId, tab, ready } = useActiveTab();
  const { state, videos, scanning, rescan } = useTabVideos(tabId);
  const [view, setView] = useState<Tab>('videos');
  const [confirmClear, setConfirmClear] = useState(false);
  const { jobs, command } = useJobs(client, online);
  const history = useHistory(client, online, view === 'history');

  const activeCount = jobs.filter((j) => j.status === 'downloading' || j.status === 'merging' || j.status === 'queued').length;
  const pageUrl = state?.pageUrl || tab?.url || '';
  const host = useMemo(() => {
    try {
      return new URL(pageUrl).hostname.replace(/^www\./, '');
    } catch {
      return '';
    }
  }, [pageUrl]);
  const restricted = /^(chrome|edge|about|chrome-extension|devtools|view-source):/.test(tab?.url ?? '') || /chromewebstore\.google\.com|chrome\.google\.com\/webstore/.test(tab?.url ?? '');

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center gap-2.5 px-3.5 pt-3.5 pb-3">
        <Logo />
        <div className="min-w-0 flex-1">
          <div className="text-[14px] leading-tight font-semibold tracking-[-0.01em] text-ink">Clipkeeper</div>
          <div className="flex items-center gap-1 truncate text-[11px] text-ink-muted">
            <Globe size={10} className="shrink-0" />
            <span className="truncate">{host || 'No page'}</span>
          </div>
        </div>
        <HelperPill helper={helper} onClick={() => (online ? void refreshHelper() : openSettings('helper'))} />
        <Button size="icon" variant="ghost" title="Settings" aria-label="Settings" onClick={() => openSettings()}>
          <Settings size={15} />
        </Button>
      </header>

      <div className="px-3.5 pb-2.5">
        <Segmented<Tab>
          value={view}
          onChange={setView}
          options={[
            {
              value: 'videos',
              label: (
                <>
                  Videos
                  {videos.length > 0 && <span className="rounded-full bg-accent-soft px-1.5 text-[10px] font-semibold text-accent-ink">{videos.length}</span>}
                </>
              ),
            },
            {
              value: 'downloads',
              label: (
                <>
                  Downloads
                  {activeCount > 0 && <span className="gradient-accent rounded-full px-1.5 text-[10px] font-semibold text-white">{activeCount}</span>}
                </>
              ),
            },
            { value: 'history', label: 'History' },
          ]}
        />
      </div>

      <main className="scroll-area min-h-0 flex-1 overflow-y-auto px-3.5 pb-3.5">
        {view === 'videos' && (
          <section className="space-y-2" data-testid="videos-view">
            {loaded && !settings.acknowledged && (
              <div className="animate-in flex items-start gap-2.5 rounded-[12px] border border-line bg-panel p-2.5 text-[11.5px] leading-snug text-ink-muted">
                <ShieldCheck size={15} className="mt-px shrink-0 text-accent" />
                <div className="flex-1">
                  Save only videos you own or have permission to download. Clipkeeper never bypasses DRM, paywalls or sign-ins.
                </div>
                <button className="shrink-0 font-semibold text-accent-ink hover:underline" onClick={() => void update({ acknowledged: true })}>
                  Got it
                </button>
              </div>
            )}

            {ready && restricted ? (
              <EmptyState icon={<ShieldCheck size={20} />} title="Not available on this page">
                Chrome doesn't allow extensions to read browser pages or the Web Store.
              </EmptyState>
            ) : videos.length === 0 ? (
              <EmptyState
                icon={scanning ? <RefreshCw size={20} className="animate-spin" /> : <ScanSearch size={20} />}
                title={scanning ? 'Looking for videos…' : 'No videos found on this page'}
                action={
                  <Button size="sm" icon={<RefreshCw size={12} />} onClick={() => void rescan()} disabled={scanning}>
                    Scan again
                  </Button>
                }
              >
                Start playing the video — streaming players load their sources on play, and Clipkeeper picks them up automatically.
              </EmptyState>
            ) : (
              <>
                <div className="flex items-center justify-between px-0.5 pt-0.5">
                  <span className="text-[11px] font-medium text-ink-faint">
                    {videos.length} {videos.length === 1 ? 'video' : 'videos'} detected
                  </span>
                  <button
                    className="flex items-center gap-1 text-[11px] font-medium text-ink-muted transition-colors hover:text-ink"
                    onClick={() => void rescan()}
                    disabled={scanning}
                  >
                    <RefreshCw size={11} className={cx(scanning && 'animate-spin')} /> Rescan
                  </button>
                </div>
                {videos.map((video) => (
                  <VideoCard
                    key={video.id}
                    video={video}
                    tabId={tabId!}
                    settings={settings}
                    helperOnline={online}
                    onStarted={() => undefined}
                    onOpenSettings={() => openSettings('helper')}
                  />
                ))}
              </>
            )}
          </section>
        )}

        {view === 'downloads' && (
          <section className="space-y-2" data-testid="downloads-view">
            {jobs.length === 0 ? (
              <EmptyState icon={<Clapperboard size={20} />} title="No downloads yet">
                Downloads you start appear here with live progress.
              </EmptyState>
            ) : (
              jobs.map((job) => <JobCard key={job.id} job={job} onCommand={command} />)
            )}
          </section>
        )}

        {view === 'history' && (
          <section data-testid="history-view">
            {history.entries.length === 0 ? (
              <EmptyState icon={<History size={20} />} title={history.loading ? 'Loading…' : 'History is empty'}>
                Finished downloads are listed here. History never leaves this computer.
              </EmptyState>
            ) : (
              <>
                <div className="flex items-center justify-between px-0.5 pb-1">
                  <span className="text-[11px] font-medium text-ink-faint">{history.entries.length} downloads</span>
                  <button
                    className={cx(
                      'flex items-center gap-1 text-[11px] font-medium transition-colors hover:text-danger',
                      confirmClear ? 'text-danger' : 'text-ink-muted',
                    )}
                    title="Files stay on disk"
                    onBlur={() => setConfirmClear(false)}
                    onClick={() => {
                      if (!confirmClear) return setConfirmClear(true);
                      setConfirmClear(false);
                      void history.clear();
                    }}
                  >
                    <Trash2 size={11} /> {confirmClear ? 'Click to confirm' : 'Clear'}
                  </button>
                </div>
                <div className="-mx-1">
                  {history.entries.map((entry) => (
                    <HistoryRow key={`${entry.engine}:${entry.id}`} entry={entry} onReveal={history.reveal} onRemove={history.remove} />
                  ))}
                </div>
              </>
            )}
          </section>
        )}
      </main>
    </div>
  );
}
