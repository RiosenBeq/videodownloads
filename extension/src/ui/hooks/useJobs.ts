import { useCallback, useEffect, useRef, useState } from 'react';
import { SpeedMeter } from '@clipkeeper/shared/speed';
import type { DownloadJob, HistoryEntry, JobStatus } from '@clipkeeper/shared/types';
import type { HelperClient } from '../../lib/api';
import {
  deleteBrowserMeta,
  getBrowserHistory,
  getBrowserMeta,
  itemToJob,
  removeBrowserHistory,
  retryBrowserDownload,
  searchDownload,
} from '../../lib/browserDownloads';
import { sendRuntimeMessage } from '../../lib/messages';

export type JobCommand = 'pause' | 'resume' | 'cancel' | 'retry' | 'remove' | 'reveal';

const ORDER: Record<JobStatus, number> = { downloading: 0, merging: 0, queued: 1, paused: 2, failed: 3, completed: 4, canceled: 5 };

/** Unified list of helper jobs and Chrome downloads, refreshed every second. */
export function useJobs(client: HelperClient, helperOnline: boolean) {
  const [jobs, setJobs] = useState<DownloadJob[]>([]);
  const [error, setError] = useState<string>();
  const meters = useRef(new Map<number, SpeedMeter>());

  const refresh = useCallback(async () => {
    const browserJobs: DownloadJob[] = [];
    const metas = await getBrowserMeta();
    const dayAgo = Date.now() - 24 * 3600_000;
    for (const meta of Object.values(metas)) {
      const item = await searchDownload(meta.downloadId);
      if (!item) continue;
      // Show finished Chrome downloads for a day; history keeps the rest.
      if (item.state !== 'in_progress' && meta.createdAt < dayAgo) continue;
      let meter = meters.current.get(item.id);
      if (!meter) meters.current.set(item.id, (meter = new SpeedMeter(4000)));
      meter.push(item.bytesReceived);
      browserJobs.push(itemToJob(item, meta, meter.speed()));
    }
    let helperJobs: DownloadJob[] = [];
    if (helperOnline) {
      try {
        helperJobs = (await client.listJobs()).jobs;
        setError(undefined);
      } catch (e) {
        setError((e as Error).message);
      }
    }
    const all = [...helperJobs, ...browserJobs].sort((a, b) => ORDER[a.status] - ORDER[b.status] || b.createdAt - a.createdAt);
    setJobs(all);
  }, [client, helperOnline]);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), 1000);
    return () => clearInterval(timer);
  }, [refresh]);

  const command = useCallback(
    async (job: DownloadJob, action: JobCommand) => {
      if (job.engine === 'browser') {
        const id = Number(job.id.slice(2));
        if (action === 'pause') await chrome.downloads.pause(id);
        else if (action === 'resume') await chrome.downloads.resume(id);
        else if (action === 'cancel') await chrome.downloads.cancel(id);
        else if (action === 'reveal') chrome.downloads.show(id);
        else if (action === 'retry') await retryBrowserDownload(id);
        else if (action === 'remove') {
          await chrome.downloads.erase({ id });
          await deleteBrowserMeta(id);
        }
      } else if (action === 'remove') {
        await client.removeJob(job.id);
      } else if (action === 'reveal') {
        await client.revealJob(job.id);
      } else {
        await client.jobAction(job.id, action);
        if (action === 'resume' || action === 'retry') void sendRuntimeMessage({ type: 'jobs:watch', jobId: job.id });
      }
      await refresh();
    },
    [client, refresh],
  );

  return { jobs, error, refresh, command };
}

/** Download history from the helper and from Chrome-engine downloads, newest first. */
export function useHistory(client: HelperClient, helperOnline: boolean, active: boolean) {
  const [entries, setEntries] = useState<HistoryEntry[]>([]);
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const browser = await getBrowserHistory();
      let helper: HistoryEntry[] = [];
      if (helperOnline) helper = await client.history(300).then((r) => r.entries).catch(() => []);
      setEntries([...helper, ...browser].sort((a, b) => b.completedAt - a.completedAt));
    } finally {
      setLoading(false);
    }
  }, [client, helperOnline]);

  useEffect(() => {
    if (active) void refresh();
  }, [active, refresh]);

  const remove = async (entry: HistoryEntry) => {
    if (entry.engine === 'browser') await removeBrowserHistory(entry.id);
    else await client.removeHistory(entry.id);
    await refresh();
  };

  const clear = async () => {
    await removeBrowserHistory();
    if (helperOnline) await client.clearHistory().catch(() => undefined);
    await refresh();
  };

  const reveal = async (entry: HistoryEntry) => {
    if (entry.engine === 'browser') {
      const id = Number(entry.id.slice(2));
      const item = Number.isFinite(id) ? await searchDownload(id) : undefined;
      if (item?.exists) chrome.downloads.show(id);
      else chrome.downloads.showDefaultFolder();
    } else {
      await client.revealHistory(entry.id);
    }
  };

  return { entries, loading, refresh, remove, clear, reveal };
}
