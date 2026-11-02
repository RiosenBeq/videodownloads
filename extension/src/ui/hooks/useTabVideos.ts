import { useEffect, useState } from 'react';
import type { DetectedVideo } from '@clipkeeper/shared/types';
import { sendRuntimeMessage } from '../../lib/messages';
import { tabKey, visibleVideos, type TabState } from '../../lib/registry';

/** The tab the popup belongs to; `?tabId=` overrides it (used when opened as a page). */
export function useActiveTab(): { tabId?: number; tab?: chrome.tabs.Tab; ready: boolean } {
  const [value, setValue] = useState<{ tabId?: number; tab?: chrome.tabs.Tab; ready: boolean }>({ ready: false });
  useEffect(() => {
    const param = Number(new URLSearchParams(location.search).get('tabId'));
    const query = Number.isInteger(param) && param > 0 ? chrome.tabs.get(param).then((t) => [t]) : chrome.tabs.query({ active: true, currentWindow: true });
    query
      .then(([tab]) => setValue({ tabId: tab?.id, tab, ready: true }))
      .catch(() => setValue({ ready: true }));
  }, []);
  return value;
}

/** Live list of detected videos for a tab, straight from session storage. */
export function useTabVideos(tabId: number | undefined) {
  const [state, setState] = useState<TabState | undefined>();
  const [scanning, setScanning] = useState(false);

  useEffect(() => {
    if (tabId === undefined) return;
    const key = tabKey(tabId);
    let alive = true;
    void chrome.storage.session.get(key).then((r) => alive && setState(r[key] as TabState | undefined));
    const listener = (changes: Record<string, chrome.storage.StorageChange>) => {
      if (changes[key]) setState(changes[key].newValue as TabState | undefined);
    };
    chrome.storage.session.onChanged.addListener(listener);

    // Ask frames to rescan (catches shadow DOM/late players) and probe anything new.
    setScanning(true);
    void sendRuntimeMessage({ type: 'videos:rescan', tabId })
      .catch(() => undefined)
      .then(() => new Promise((r) => setTimeout(r, 350)))
      .then(() => sendRuntimeMessage({ type: 'videos:probe', tabId }))
      .catch(() => undefined)
      .finally(() => alive && setScanning(false));

    return () => {
      alive = false;
      chrome.storage.session.onChanged.removeListener(listener);
    };
  }, [tabId]);

  const rescan = async () => {
    if (tabId === undefined) return;
    setScanning(true);
    try {
      await sendRuntimeMessage({ type: 'videos:rescan', tabId }).catch(() => undefined);
      await new Promise((r) => setTimeout(r, 450));
      await sendRuntimeMessage({ type: 'videos:probe', tabId });
    } finally {
      setScanning(false);
    }
  };

  const videos: DetectedVideo[] = visibleVideos(state);
  return { state, videos, scanning, rescan };
}
