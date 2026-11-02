/**
 * Service worker entry: wires browser events to detection and downloads.
 * All listeners are registered synchronously at top level, as MV3 requires.
 */
import type { RuntimeMessage } from '../lib/messages';
import { onSettingsChanged } from '../lib/settings';
import { networkHitFromResponse } from '../lib/sniff';
import { handleContentReport, handleNetworkHit, probeTab, registry, resetTab, updateBadge } from './detection';
import { onBrowserDownloadChanged, onNotificationClicked, pollHelperJobs, startDownload, watchHelperJob } from './downloads';

const EXTENSION_ORIGIN = chrome.runtime.getURL('');

/** Messages that trigger downloads or probes must come from our own pages, not content scripts. */
function fromExtensionPage(sender: chrome.runtime.MessageSender): boolean {
  return sender.id === chrome.runtime.id && !!sender.url?.startsWith(EXTENSION_ORIGIN);
}

chrome.runtime.onMessage.addListener((message: RuntimeMessage, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id || !message || typeof message !== 'object') return false;

  if (message.type === 'content:report') {
    if (sender.tab?.id !== undefined && Array.isArray(message.videos)) {
      void handleContentReport(sender.tab.id, sender.frameId ?? 0, { ...message, videos: message.videos.slice(0, 300) }, sender.tab);
    }
    return false;
  }
  if (!fromExtensionPage(sender)) return false;

  switch (message.type) {
    case 'download:start':
      startDownload(message).then(sendResponse, (error: Error) =>
        sendResponse({ ok: false, error: { code: 'FAILED', message: error.message } }),
      );
      return true;
    case 'videos:probe':
      probeTab(message.tabId, message.videoId).then(
        () => sendResponse({ ok: true }),
        () => sendResponse({ ok: false }),
      );
      return true;
    case 'videos:rescan':
      chrome.tabs
        .sendMessage(message.tabId, { type: 'content:rescan' } satisfies RuntimeMessage)
        .then(() => sendResponse({ ok: true }))
        .catch(() => sendResponse({ ok: false }));
      return true;
    case 'jobs:watch':
      void watchHelperJob(message.jobId);
      return false;
    default:
      return false;
  }
});

chrome.webRequest.onHeadersReceived.addListener(
  (details) => {
    const hit = networkHitFromResponse(details);
    if (hit) void handleNetworkHit(details.tabId, hit);
    return undefined;
  },
  { urls: ['<all_urls>'], types: ['media', 'xmlhttprequest', 'other', 'object', 'main_frame', 'sub_frame'] },
  ['responseHeaders'],
);

// A new top-level document starts: forget the previous page's videos.
chrome.webRequest.onBeforeRequest.addListener(
  (details) => {
    if (details.tabId >= 0 && details.frameId === 0) void resetTab(details.tabId, details.url);
    return undefined;
  },
  { urls: ['<all_urls>'], types: ['main_frame'] },
);

chrome.tabs.onRemoved.addListener((tabId) => void registry.remove(tabId));

chrome.downloads.onChanged.addListener((delta) => void onBrowserDownloadChanged(delta));
chrome.notifications.onClicked.addListener((id) => void onNotificationClicked(id));

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'clipkeeper-poll') void pollHelperJobs();
});

chrome.runtime.onInstalled.addListener((details) => {
  void chrome.alarms.create('clipkeeper-poll', { periodInMinutes: 0.5 });
  if (details.reason === 'install') void chrome.runtime.openOptionsPage();
});

chrome.runtime.onStartup.addListener(() => {
  void chrome.alarms.create('clipkeeper-poll', { periodInMinutes: 0.5 });
});

onSettingsChanged(async () => {
  const tabs = await chrome.tabs.query({});
  for (const tab of tabs) if (tab.id !== undefined) void updateBadge(tab.id);
});

// Resume watching helper jobs after a service-worker restart.
void pollHelperJobs();
