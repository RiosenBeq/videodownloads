/**
 * Extension preferences, persisted in chrome.storage.local (never synced: the
 * helper token is specific to this computer).
 */
import { DEFAULT_BACKEND_URL, DEFAULT_FILENAME_TEMPLATE } from '@clipkeeper/shared/constants';
import type { ContainerPreference, QualityPreference } from '@clipkeeper/shared/types';

export type ThemePreference = 'system' | 'dark' | 'light';
export type DirectEngine = 'browser' | 'helper';

export interface ExtensionSettings {
  theme: ThemePreference;
  helperUrl: string;
  helperToken: string;
  /** Who downloads plain video files: Chrome itself or the local helper. */
  directEngine: DirectEngine;
  quality: QualityPreference;
  container: ContainerPreference;
  filenameTemplate: string;
  /** Sub-folder inside Chrome's download folder (browser engine). */
  browserSubfolder: string;
  saveAs: boolean;
  notifications: boolean;
  showBadge: boolean;
  /** The user acknowledged downloading only content they may keep. */
  acknowledged: boolean;
}

export const DEFAULT_SETTINGS: ExtensionSettings = {
  theme: 'system',
  helperUrl: DEFAULT_BACKEND_URL,
  helperToken: '',
  directEngine: 'browser',
  quality: 'highest',
  container: 'any',
  filenameTemplate: DEFAULT_FILENAME_TEMPLATE,
  browserSubfolder: 'Clipkeeper',
  saveAs: false,
  notifications: true,
  showBadge: true,
  acknowledged: false,
};

const KEY = 'settings';

export function normalizeSettings(value: unknown): ExtensionSettings {
  const stored = (value && typeof value === 'object' ? value : {}) as Partial<ExtensionSettings>;
  const merged = { ...DEFAULT_SETTINGS, ...stored };
  // Only loopback helper URLs are accepted; anything else falls back to the default.
  if (!isLoopbackHttpUrl(merged.helperUrl)) merged.helperUrl = DEFAULT_SETTINGS.helperUrl;
  return merged;
}

export function isLoopbackHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) && !url.username && !url.password;
  } catch {
    return false;
  }
}

/** Clean a user-supplied sub-folder for chrome.downloads (relative, no traversal). */
export function sanitizeSubfolder(value: string): string {
  return value
    .split(/[\\/]+/)
    .map((part) => part.replace(/[<>:"|?*\u0000-\u001f]/g, '').trim().replace(/^\.+|\.+$/g, ''))
    .filter(Boolean)
    .slice(0, 4)
    .join('/');
}

export async function loadSettings(): Promise<ExtensionSettings> {
  const result = await chrome.storage.local.get(KEY);
  return normalizeSettings(result[KEY]);
}

export async function saveSettings(patch: Partial<ExtensionSettings>): Promise<ExtensionSettings> {
  const next = normalizeSettings({ ...(await loadSettings()), ...patch });
  await chrome.storage.local.set({ [KEY]: next });
  return next;
}

export function onSettingsChanged(callback: (settings: ExtensionSettings) => void): () => void {
  const listener = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
    if (area === 'local' && changes[KEY]) callback(normalizeSettings(changes[KEY].newValue));
  };
  chrome.storage.onChanged.addListener(listener);
  return () => chrome.storage.onChanged.removeListener(listener);
}
