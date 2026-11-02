import { useCallback, useEffect, useState, type ReactNode } from 'react';
import {
  ArrowDownToLine,
  Check,
  CircleAlert,
  CircleCheck,
  Copy,
  Eye,
  EyeOff,
  FolderOpen,
  HardDrive,
  KeyRound,
  LoaderCircle,
  Monitor,
  Moon,
  Palette,
  Plug,
  RefreshCw,
  ShieldCheck,
  Sun,
  Trash2,
} from 'lucide-react';
import { APP_VERSION } from '@clipkeeper/shared/constants';
import type { BackendSettings } from '@clipkeeper/shared/types';
import { HelperError, type HelperState } from '../../lib/api';
import { removeBrowserHistory } from '../../lib/browserDownloads';
import { DEFAULT_SETTINGS, isLoopbackHttpUrl, sanitizeSubfolder, type ExtensionSettings } from '../../lib/settings';
import { Badge, Button, Card, Input, Notice, Segmented, Select, Toggle, cx } from '../components/ui';
import { useHelper, useSettings, useTheme } from '../hooks/useSettings';

function Section({ id, icon, title, description, children }: { id: string; icon: ReactNode; title: string; description?: string; children: ReactNode }) {
  return (
    <section id={id} className="scroll-mt-6">
      <div className="mb-3 flex items-center gap-2.5 px-1">
        <span className="flex h-7 w-7 items-center justify-center rounded-[9px] bg-accent-soft text-accent-ink">{icon}</span>
        <div>
          <h2 className="text-[14px] font-semibold text-ink">{title}</h2>
          {description && <p className="text-[12px] text-ink-muted">{description}</p>}
        </div>
      </div>
      <Card className="divide-y divide-line">{children}</Card>
    </section>
  );
}

function Row({ label, hint, children, stacked }: { label: string; hint?: ReactNode; children: ReactNode; stacked?: boolean }) {
  return (
    <div className={cx('px-4 py-3.5', stacked ? 'space-y-2' : 'flex items-center gap-6')}>
      <div className={cx('min-w-0', !stacked && 'flex-1')}>
        <div className="text-[13px] font-medium text-ink">{label}</div>
        {hint && <div className="mt-0.5 text-[12px] leading-relaxed text-ink-muted">{hint}</div>}
      </div>
      <div className={cx(!stacked && 'shrink-0')}>{children}</div>
    </div>
  );
}

function CopyCommand({ command }: { command: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex items-center gap-2 rounded-[9px] border border-line bg-panel-2 py-1 pr-1 pl-3 font-mono text-[12px] text-ink">
      <span className="flex-1 truncate select-all">{command}</span>
      <Button
        size="icon"
        variant="ghost"
        aria-label="Copy command"
        onClick={() => {
          void navigator.clipboard.writeText(command);
          setCopied(true);
          setTimeout(() => setCopied(false), 1200);
        }}
      >
        {copied ? <Check size={13} className="text-success" /> : <Copy size={13} />}
      </Button>
    </div>
  );
}

function DomainList({ value, onSave, placeholder, disabled }: { value: string[]; onSave: (domains: string[]) => Promise<void>; placeholder: string; disabled?: boolean }) {
  const [text, setText] = useState(value.join('\n'));
  const [status, setStatus] = useState<{ ok: boolean; message: string }>();
  useEffect(() => setText(value.join('\n')), [value]);
  const dirty = text.trim() !== value.join('\n');
  return (
    <div className="space-y-2">
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder={placeholder}
        disabled={disabled}
        rows={3}
        spellCheck={false}
        className="w-full resize-y rounded-[9px] border border-line bg-panel px-2.5 py-2 font-mono text-[12px] text-ink outline-none placeholder:text-ink-faint focus:border-accent disabled:opacity-50"
      />
      <div className="flex items-center gap-2">
        <Button
          size="sm"
          disabled={!dirty || disabled}
          onClick={async () => {
            try {
              await onSave(text.split(/[\s,]+/).map((d) => d.trim()).filter(Boolean));
              setStatus({ ok: true, message: 'Saved' });
            } catch (e) {
              setStatus({ ok: false, message: (e as Error).message });
            }
          }}
        >
          Save list
        </Button>
        {status && <span className={cx('text-[12px]', status.ok ? 'text-success' : 'text-danger')}>{status.message}</span>}
      </div>
    </div>
  );
}

function HelperStatus({ helper, onRefresh }: { helper: HelperState | { state: 'checking' }; onRefresh: () => void }) {
  if (helper.state === 'checking') {
    return (
      <Notice tone="neutral" icon={<LoaderCircle size={13} className="animate-spin" />}>
        Checking for the local helper…
      </Notice>
    );
  }
  if (helper.state === 'online') {
    const deps = helper.status.dependencies;
    return (
      <div className="space-y-2.5">
        <Notice tone="success" icon={<CircleCheck size={13} />} action={<button className="font-semibold hover:underline" onClick={onRefresh}>Refresh</button>}>
          Connected to helper {helper.status.version}. {helper.status.activeJobs ? `${helper.status.activeJobs} active download(s).` : ''}
        </Notice>
        <div className="grid grid-cols-2 gap-2">
          {(
            [
              ['FFmpeg', deps.ffmpeg, deps.installHints.ffmpeg, 'Required to merge HLS/DASH streams'],
              ['yt-dlp', deps.ytDlp, deps.installHints.ytDlp, 'Optional, for supported sites'],
            ] as const
          ).map(([name, info, hint, note]) => (
            <div key={name} className="rounded-[10px] border border-line bg-panel-2 p-2.5">
              <div className="flex items-center gap-1.5 text-[12.5px] font-semibold text-ink">
                {name}
                {info.found ? <Badge tone="success">{info.version ?? 'found'}</Badge> : <Badge tone="warning">missing</Badge>}
              </div>
              <div className="mt-0.5 text-[11.5px] text-ink-muted">{info.found ? info.path : note}</div>
              {!info.found && <div className="mt-2"><CopyCommand command={hint} /></div>}
            </div>
          ))}
        </div>
      </div>
    );
  }
  const message =
    helper.state === 'offline'
      ? 'The helper is not running. Direct video files still download through Chrome; streams need the helper.'
      : helper.state === 'unauthorized'
        ? 'The helper is running but rejected the token. Paste the token it printed at startup.'
        : 'The helper is running. Paste its token below to pair this browser.';
  return (
    <Notice tone="warning" icon={<CircleAlert size={13} />} action={<button className="font-semibold hover:underline" onClick={onRefresh}>Retry</button>}>
      {message}
    </Notice>
  );
}

export function Options() {
  const { settings, loaded, update } = useSettings();
  useTheme(settings.theme);
  const { client, helper, online, refreshHelper } = useHelper(settings, loaded);
  const [helperSettings, setHelperSettings] = useState<BackendSettings>();
  const [helperError, setHelperError] = useState<string>();
  const [token, setToken] = useState('');
  const [helperUrl, setHelperUrl] = useState('');
  const [showToken, setShowToken] = useState(false);
  const [saving, setSaving] = useState(false);
  const [folderInput, setFolderInput] = useState('');
  const [choosing, setChoosing] = useState(false);
  const [cleared, setCleared] = useState(false);

  useEffect(() => {
    if (!loaded) return;
    setToken(settings.helperToken);
    setHelperUrl(settings.helperUrl);
  }, [loaded, settings.helperToken, settings.helperUrl]);

  const loadHelperSettings = useCallback(async () => {
    if (!online) return setHelperSettings(undefined);
    try {
      const { settings: s } = await client.getSettings();
      setHelperSettings(s);
      setFolderInput(s.downloadDir);
    } catch (e) {
      setHelperError((e as Error).message);
    }
  }, [client, online]);

  useEffect(() => {
    void loadHelperSettings();
  }, [loadHelperSettings]);

  useEffect(() => {
    if (location.hash) document.getElementById(location.hash.slice(1))?.scrollIntoView();
  }, [loaded]);

  const patchHelper = async (patch: Partial<BackendSettings>) => {
    setHelperError(undefined);
    try {
      const { settings: s } = await client.updateSettings(patch);
      setHelperSettings(s);
      setFolderInput(s.downloadDir);
    } catch (e) {
      const message = e instanceof HelperError ? e.message : String(e);
      setHelperError(message);
      throw new Error(message);
    }
  };

  const saveConnection = async () => {
    setSaving(true);
    try {
      await update({ helperToken: token.trim(), helperUrl: isLoopbackHttpUrl(helperUrl.trim()) ? helperUrl.trim() : DEFAULT_SETTINGS.helperUrl });
      setTimeout(() => void refreshHelper(), 50);
    } finally {
      setSaving(false);
    }
  };

  const chooseFolder = async () => {
    setChoosing(true);
    setHelperError(undefined);
    try {
      const result = await client.chooseFolder();
      if (result.settings) {
        setHelperSettings(result.settings);
        setFolderInput(result.settings.downloadDir);
      }
    } catch (e) {
      setHelperError((e as Error).message);
    } finally {
      setChoosing(false);
    }
  };

  const set = <K extends keyof ExtensionSettings>(key: K) => (value: ExtensionSettings[K]) => void update({ [key]: value } as Partial<ExtensionSettings>);

  return (
    <div className="mx-auto max-w-[760px] px-6 py-10">
      <header className="mb-8 flex items-center gap-3.5">
        <div className="gradient-accent flex h-11 w-11 items-center justify-center rounded-[13px] text-white shadow-[0_10px_24px_-10px_rgba(109,94,246,0.9),inset_0_1px_0_rgba(255,255,255,0.3)]">
          <ArrowDownToLine size={21} strokeWidth={2.3} />
        </div>
        <div className="flex-1">
          <h1 className="text-[20px] font-semibold tracking-[-0.02em] text-ink">Clipkeeper Settings</h1>
          <p className="text-[12.5px] text-ink-muted">Version {APP_VERSION} · Everything stays on this computer.</p>
        </div>
        <nav className="hidden gap-1 sm:flex">
          {[
            ['helper', 'Helper'],
            ['downloads', 'Downloads'],
            ['sources', 'Safety'],
            ['appearance', 'Appearance'],
          ].map(([id, label]) => (
            <a key={id} href={`#${id}`} className="rounded-lg px-2.5 py-1.5 text-[12.5px] font-medium text-ink-muted transition-colors hover:bg-panel-2 hover:text-ink">
              {label}
            </a>
          ))}
        </nav>
      </header>

      <div className="space-y-9">
        <Section id="helper" icon={<Plug size={15} />} title="Local helper" description="Saves HLS/DASH streams and can save files to any folder.">
          <div className="px-4 py-3.5">
            <HelperStatus helper={helper} onRefresh={() => void refreshHelper()} />
          </div>
          <Row
            stacked
            label="Pairing token"
            hint={
              <>
                Start the helper from the project folder and copy the token it prints. You can print it again any time with <code className="font-mono">npm run token</code>.
              </>
            }
          >
            <div className="space-y-2">
              <CopyCommand command="npm run start:backend" />
              <div className="flex gap-2">
                <div className="relative min-w-0 flex-1">
                  <KeyRound size={13} className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-ink-faint" />
                  <Input
                    type={showToken ? 'text' : 'password'}
                    value={token}
                    onChange={(e) => setToken(e.target.value)}
                    placeholder="Paste the helper token"
                    className="pl-8 font-mono"
                    autoComplete="off"
                    spellCheck={false}
                    data-testid="token-input"
                  />
                  <button
                    className="absolute top-1/2 right-2 -translate-y-1/2 text-ink-faint hover:text-ink"
                    onClick={() => setShowToken((v) => !v)}
                    aria-label={showToken ? 'Hide token' : 'Show token'}
                  >
                    {showToken ? <EyeOff size={14} /> : <Eye size={14} />}
                  </button>
                </div>
                <div className="w-[190px] shrink-0">
                  <Input value={helperUrl} onChange={(e) => setHelperUrl(e.target.value)} className="font-mono" aria-label="Helper URL" data-testid="helper-url-input" />
                </div>
                <Button variant="primary" onClick={() => void saveConnection()} disabled={saving} data-testid="save-connection">
                  {saving ? <LoaderCircle size={13} className="animate-spin" /> : 'Save & connect'}
                </Button>
              </div>
              <p className="text-[11.5px] text-ink-faint">The helper only listens on 127.0.0.1 and rejects requests without this token.</p>
            </div>
          </Row>
        </Section>

        <Section id="downloads" icon={<HardDrive size={15} />} title="Downloads">
          <Row label="Default quality" hint="Picked automatically when a video offers several resolutions.">
            <Select value={settings.quality} onChange={(e) => set('quality')(e.target.value as ExtensionSettings['quality'])} className="w-[150px]">
              <option value="highest">Highest available</option>
              <option value="2160">Up to 4K</option>
              <option value="1440">Up to 1440p</option>
              <option value="1080">Up to 1080p</option>
              <option value="720">Up to 720p</option>
              <option value="480">Up to 480p</option>
              <option value="360">Up to 360p</option>
              <option value="lowest">Smallest file</option>
            </Select>
          </Row>
          <Row label="Preferred format" hint="Used when the same quality exists in several formats.">
            <Select value={settings.container} onChange={(e) => set('container')(e.target.value as ExtensionSettings['container'])} className="w-[150px]">
              <option value="any">No preference</option>
              <option value="mp4">MP4</option>
              <option value="webm">WebM</option>
            </Select>
          </Row>
          <Row stacked label="File name template" hint={<>Tokens: <code className="font-mono">{'{title} {site} {resolution} {date}'}</code>. Unsafe characters are removed automatically.</>}>
            <Input value={settings.filenameTemplate} onChange={(e) => set('filenameTemplate')(e.target.value)} placeholder="{title}" className="font-mono" maxLength={120} />
          </Row>
          <Row label="Save direct video files with" hint="Chrome supports pause/resume and uses your session like “Save video as…”. The helper saves into its own folder.">
            <Segmented
              value={settings.directEngine}
              onChange={set('directEngine')}
              options={[
                { value: 'browser', label: 'Chrome' },
                { value: 'helper', label: 'Helper' },
              ]}
              className="w-[180px]"
            />
          </Row>
          <Row label="Chrome sub-folder" hint="Inside your Chrome downloads folder. Leave empty for the folder itself.">
            <div className="w-[180px]">
              <Input
                value={settings.browserSubfolder}
                onChange={(e) => set('browserSubfolder')(e.target.value)}
                onBlur={(e) => set('browserSubfolder')(sanitizeSubfolder(e.target.value))}
              />
            </div>
          </Row>
          <Row label="Ask where to save each file" hint="Shows Chrome's Save dialog for direct downloads.">
            <Toggle checked={settings.saveAs} onChange={set('saveAs')} label="Ask where to save" />
          </Row>
          <Row stacked label="Helper download folder" hint={online ? 'Streams and helper downloads are saved here.' : 'Connect the helper to change its folder.'}>
            <div className="flex gap-2">
              <Input value={folderInput} onChange={(e) => setFolderInput(e.target.value)} disabled={!online} className="font-mono" placeholder="/Users/you/Movies" />
              <Button disabled={!online || choosing} onClick={() => void chooseFolder()} icon={choosing ? <LoaderCircle size={13} className="animate-spin" /> : <FolderOpen size={13} />}>
                Choose…
              </Button>
              <Button
                disabled={!online || !folderInput.trim() || folderInput === helperSettings?.downloadDir}
                onClick={() => void patchHelper({ downloadDir: folderInput.trim() }).catch(() => undefined)}
              >
                Save
              </Button>
            </div>
          </Row>
          <Row label="Simultaneous helper downloads">
            <Select
              disabled={!online || !helperSettings}
              value={helperSettings?.maxConcurrent ?? 2}
              onChange={(e) => void patchHelper({ maxConcurrent: Number(e.target.value) }).catch(() => undefined)}
              className="w-[80px]"
            >
              {[1, 2, 3, 4, 5, 6].map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </Select>
          </Row>
          {helperError && (
            <div className="px-4 py-3">
              <Notice tone="danger" icon={<CircleAlert size={13} />}>
                {helperError}
              </Notice>
            </div>
          )}
        </Section>

        <Section id="sources" icon={<ShieldCheck size={15} />} title="Sources & safety" description="Enforced by the helper on every request it makes.">
          <div className="px-4 py-3.5">
            <Notice tone="accent" icon={<ShieldCheck size={13} />}>
              Clipkeeper only saves content you own or have permission to download. It refuses DRM-protected and encrypted streams, never uses your cookies in the
              helper, and never sends browsing data anywhere.
            </Notice>
          </div>
          <Row stacked label="Allowed download domains" hint="When the list is not empty, the helper only downloads from these domains (and their subdomains).">
            <DomainList value={helperSettings?.allowedDomains ?? []} disabled={!online} placeholder={'media.example.com\ncdn.example.org'} onSave={(d) => patchHelper({ allowedDomains: d })} />
          </Row>
          <Row stacked label="Blocked domains">
            <DomainList value={helperSettings?.blockedDomains ?? []} disabled={!online} placeholder="ads.example.com" onSave={(d) => patchHelper({ blockedDomains: d })} />
          </Row>
          <Row label="Allow local network sources" hint="Lets the helper fetch from localhost and private IP ranges (e.g. your NAS or a dev server). Off by default to prevent SSRF.">
            <Toggle
              checked={!!helperSettings?.allowPrivateNetwork}
              disabled={!online}
              onChange={(v) => void patchHelper({ allowPrivateNetwork: v }).catch(() => undefined)}
              label="Allow local network sources"
            />
          </Row>
          <Row label="Enable yt-dlp" hint="Opt-in. Only for sites whose terms allow downloading and only for public content; never uses your accounts.">
            <Toggle checked={!!helperSettings?.ytDlpEnabled} disabled={!online} onChange={(v) => void patchHelper({ ytDlpEnabled: v }).catch(() => undefined)} label="Enable yt-dlp" />
          </Row>
          {helperSettings?.ytDlpEnabled && (
            <Row stacked label="Domains allowed for yt-dlp" hint="yt-dlp is used only for these sites.">
              <DomainList value={helperSettings.ytDlpDomains} placeholder="example.com" onSave={(d) => patchHelper({ ytDlpDomains: d })} />
            </Row>
          )}
        </Section>

        <Section id="appearance" icon={<Palette size={15} />} title="Appearance & notifications">
          <Row label="Theme">
            <Segmented
              value={settings.theme}
              onChange={set('theme')}
              options={[
                { value: 'system', label: <><Monitor size={12} /> System</> },
                { value: 'dark', label: <><Moon size={12} /> Dark</> },
                { value: 'light', label: <><Sun size={12} /> Light</> },
              ]}
              className="w-[260px]"
            />
          </Row>
          <Row label="Notify when a download finishes">
            <Toggle checked={settings.notifications} onChange={set('notifications')} label="Notifications" />
          </Row>
          <Row label="Show video count on the toolbar icon">
            <Toggle checked={settings.showBadge} onChange={set('showBadge')} label="Badge" />
          </Row>
        </Section>

        <Section id="data" icon={<Trash2 size={15} />} title="Data">
          <Row label="Clear download history" hint="Removes history in Chrome and in the helper. Downloaded files are not deleted.">
            <Button
              variant="danger"
              size="sm"
              onClick={async () => {
                await removeBrowserHistory();
                if (online) await client.clearHistory().catch(() => undefined);
                setCleared(true);
                setTimeout(() => setCleared(false), 1500);
              }}
            >
              {cleared ? 'Cleared' : 'Clear history'}
            </Button>
          </Row>
          <Row label="Reset preferences" hint="Restores defaults. The helper token is kept.">
            <Button size="sm" icon={<RefreshCw size={12} />} onClick={() => void update({ ...DEFAULT_SETTINGS, helperToken: settings.helperToken, helperUrl: settings.helperUrl, acknowledged: true })}>
              Reset
            </Button>
          </Row>
        </Section>
      </div>
      <footer className="mt-10 text-center text-[11.5px] text-ink-faint">
        Clipkeeper never collects browsing history or sends video URLs to external servers.
      </footer>
    </div>
  );
}
