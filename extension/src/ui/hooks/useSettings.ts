import { useCallback, useEffect, useMemo, useState } from 'react';
import { HelperClient, checkHelper, type HelperState } from '../../lib/api';
import { DEFAULT_SETTINGS, loadSettings, onSettingsChanged, saveSettings, type ExtensionSettings } from '../../lib/settings';

export function useSettings() {
  const [settings, setSettings] = useState<ExtensionSettings>(DEFAULT_SETTINGS);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let alive = true;
    void loadSettings().then((s) => {
      if (!alive) return;
      setSettings(s);
      setLoaded(true);
    });
    const off = onSettingsChanged(setSettings);
    return () => {
      alive = false;
      off();
    };
  }, []);

  const update = useCallback(async (patch: Partial<ExtensionSettings>) => {
    setSettings((s) => ({ ...s, ...patch }));
    setSettings(await saveSettings(patch));
  }, []);

  return { settings, loaded, update };
}

/** Applies the theme preference to <html> and follows the OS when set to "system". */
export function useTheme(theme: ExtensionSettings['theme']) {
  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const apply = () => {
      const dark = theme === 'dark' || (theme === 'system' && media.matches);
      document.documentElement.classList.toggle('dark', dark);
    };
    apply();
    media.addEventListener('change', apply);
    return () => media.removeEventListener('change', apply);
  }, [theme]);
}

export function useHelper(settings: ExtensionSettings, loaded: boolean) {
  const client = useMemo(() => new HelperClient({ baseUrl: settings.helperUrl, token: settings.helperToken }), [settings.helperUrl, settings.helperToken]);
  const [state, setState] = useState<HelperState | { state: 'checking' }>({ state: 'checking' });

  const refresh = useCallback(async () => {
    setState(await checkHelper(client));
  }, [client]);

  useEffect(() => {
    if (!loaded) return;
    void refresh();
    const timer = setInterval(() => void refresh(), 10_000);
    return () => clearInterval(timer);
  }, [loaded, refresh]);

  return { client, helper: state, refreshHelper: refresh, online: state.state === 'online' };
}
