/**
 * Helper configuration: where state lives, the pairing token, the port and
 * user-adjustable settings. Persisted as JSON with owner-only permissions.
 */
import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  DEFAULT_BACKEND_PORT,
  DEFAULT_BACKEND_SETTINGS,
  settingsPatchSchema,
  type BackendSettings,
  type SettingsPatch,
} from '@clipkeeper/shared';
import { readJson, validateDownloadDir, writeJsonAtomic } from './fs/files';

export interface AppPaths {
  home: string;
  configFile: string;
  historyFile: string;
  jobsFile: string;
}

export function defaultHome(): string {
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support', 'Clipkeeper');
  if (process.platform === 'win32') {
    return path.join(process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming'), 'Clipkeeper');
  }
  return path.join(process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), '.config'), 'clipkeeper');
}

export function resolveAppPaths(home = process.env.CLIPKEEPER_HOME || defaultHome()): AppPaths {
  return {
    home,
    configFile: path.join(home, 'config.json'),
    historyFile: path.join(home, 'history.json'),
    jobsFile: path.join(home, 'jobs.json'),
  };
}

export function defaultDownloadDir(): string {
  return path.join(os.homedir(), 'Downloads', 'Clipkeeper Videos');
}

export function generateToken(): string {
  return randomBytes(32).toString('base64url');
}

interface StoredConfig {
  version: 1;
  token: string;
  port: number;
  settings: BackendSettings;
}

export interface ConfigOverrides {
  port?: number;
  token?: string;
  settings?: Partial<BackendSettings>;
}

export class ConfigStore {
  private constructor(
    private readonly paths: AppPaths,
    private data: StoredConfig,
    private readonly overrides: ConfigOverrides,
  ) {}

  static async load(paths: AppPaths, overrides: ConfigOverrides = {}): Promise<ConfigStore> {
    await fs.mkdir(paths.home, { recursive: true, mode: 0o700 });
    const stored = await readJson<Partial<StoredConfig>>(paths.configFile);
    const settings: BackendSettings = {
      downloadDir: defaultDownloadDir(),
      ...DEFAULT_BACKEND_SETTINGS,
      ...(stored?.settings ?? {}),
    };
    // Re-validate persisted settings; drop anything that no longer parses.
    const { downloadDir: _dir, ...rest } = settings;
    const parsed = settingsPatchSchema.omit({ downloadDir: true }).safeParse(rest);
    const data: StoredConfig = {
      version: 1,
      token: typeof stored?.token === 'string' && stored.token.length >= 32 ? stored.token : generateToken(),
      port: Number.isInteger(stored?.port) ? (stored!.port as number) : DEFAULT_BACKEND_PORT,
      settings: parsed.success ? { ...settings, ...parsed.data } : { downloadDir: settings.downloadDir, ...DEFAULT_BACKEND_SETTINGS },
    };
    // Settings overrides seed the stored settings (later updates win); port/token overrides stay in effect.
    if (overrides.settings) data.settings = { ...data.settings, ...overrides.settings };
    const store = new ConfigStore(paths, data, overrides);
    await store.save();
    return store;
  }

  get token(): string {
    return this.overrides.token ?? this.data.token;
  }

  get port(): number {
    return this.overrides.port ?? this.data.port;
  }

  get settings(): BackendSettings {
    return { ...this.data.settings };
  }

  get configFile(): string {
    return this.paths.configFile;
  }

  async updateSettings(patch: SettingsPatch): Promise<BackendSettings> {
    const next = { ...this.data.settings, ...patch };
    if (patch.downloadDir !== undefined) next.downloadDir = await validateDownloadDir(patch.downloadDir);
    for (const key of ['allowedDomains', 'blockedDomains', 'ytDlpDomains', 'allowedExtensionIds'] as const) {
      if (patch[key]) next[key] = [...new Set(patch[key])];
    }
    this.data = { ...this.data, settings: next };
    await this.save();
    return this.settings;
  }

  async rotateToken(): Promise<string> {
    this.data = { ...this.data, token: generateToken() };
    await this.save();
    return this.data.token;
  }

  private async save(): Promise<void> {
    await writeJsonAtomic(this.paths.configFile, this.data, 0o600);
  }
}
