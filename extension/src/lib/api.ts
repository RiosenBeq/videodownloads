/**
 * Typed client for the local helper API. Used by the service worker, popup and
 * options page — and by the integration tests against a real helper.
 */
import type {
  ApiErrorBody,
  ApiErrorCode,
  ChooseFolderResponse,
  CreateJobRequest,
  HealthResponse,
  HistoryResponse,
  JobAction,
  JobResponse,
  JobsResponse,
  ProbeRequest,
  ProbeResult,
  SettingsPatch,
  SettingsResponse,
  StatusResponse,
} from '@clipkeeper/shared/api';
import type { DependencyStatus } from '@clipkeeper/shared/types';

export type HelperErrorCode = ApiErrorCode | 'OFFLINE' | 'TIMEOUT' | 'NOT_CONFIGURED' | 'BAD_RESPONSE';

export class HelperError extends Error {
  constructor(
    readonly code: HelperErrorCode,
    message: string,
    readonly status = 0,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'HelperError';
  }
}

export interface HelperClientOptions {
  baseUrl: string;
  token: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

export class HelperClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: HelperClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.fetchImpl = options.fetch ?? fetch.bind(globalThis);
  }

  get configured(): boolean {
    return !!this.options.token;
  }

  private async request<T>(method: string, path: string, body?: unknown, timeoutMs = this.options.timeoutMs ?? 15_000): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const headers: Record<string, string> = { accept: 'application/json' };
    if (this.options.token) headers.authorization = `Bearer ${this.options.token}`;
    if (body !== undefined) headers['content-type'] = 'application/json';
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
        credentials: 'omit',
        cache: 'no-store',
      });
    } catch (error) {
      if (controller.signal.aborted) throw new HelperError('TIMEOUT', 'The local helper did not respond in time.');
      throw new HelperError('OFFLINE', 'The local helper is not running.', 0, String(error));
    } finally {
      clearTimeout(timer);
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new HelperError('BAD_RESPONSE', `Unexpected response from the helper (HTTP ${response.status}).`, response.status);
    }
    if (!response.ok) {
      const err = (payload as ApiErrorBody)?.error;
      throw new HelperError(err?.code ?? 'INTERNAL', err?.message ?? `Helper error (HTTP ${response.status})`, response.status, err?.details);
    }
    return payload as T;
  }

  health(): Promise<HealthResponse> {
    return this.request('GET', '/api/health', undefined, 4000);
  }
  status(): Promise<StatusResponse> {
    return this.request('GET', '/api/status', undefined, 20_000);
  }
  dependencies(refresh = false): Promise<{ dependencies: DependencyStatus }> {
    return this.request('GET', `/api/dependencies${refresh ? '?refresh=1' : ''}`, undefined, 30_000);
  }
  getSettings(): Promise<SettingsResponse> {
    return this.request('GET', '/api/settings');
  }
  updateSettings(patch: SettingsPatch): Promise<SettingsResponse> {
    return this.request('PUT', '/api/settings', patch);
  }
  chooseFolder(): Promise<ChooseFolderResponse> {
    return this.request('POST', '/api/settings/choose-folder', undefined, 10 * 60_000);
  }
  probe(request: ProbeRequest): Promise<ProbeResult> {
    return this.request('POST', '/api/probe', request, 70_000);
  }
  listJobs(): Promise<JobsResponse> {
    return this.request('GET', '/api/jobs');
  }
  getJob(id: string): Promise<JobResponse> {
    return this.request('GET', `/api/jobs/${encodeURIComponent(id)}`);
  }
  createJob(request: CreateJobRequest): Promise<JobResponse> {
    return this.request('POST', '/api/jobs', request);
  }
  jobAction(id: string, action: JobAction): Promise<JobResponse> {
    return this.request('POST', `/api/jobs/${encodeURIComponent(id)}/${action}`, undefined, 30_000);
  }
  removeJob(id: string): Promise<{ ok: true }> {
    return this.request('DELETE', `/api/jobs/${encodeURIComponent(id)}`);
  }
  revealJob(id: string): Promise<{ ok: true }> {
    return this.request('POST', `/api/jobs/${encodeURIComponent(id)}/reveal`);
  }
  history(limit?: number): Promise<HistoryResponse> {
    return this.request('GET', `/api/history${limit ? `?limit=${limit}` : ''}`);
  }
  removeHistory(id: string): Promise<{ ok: true }> {
    return this.request('DELETE', `/api/history/${encodeURIComponent(id)}`);
  }
  revealHistory(id: string): Promise<{ ok: true }> {
    return this.request('POST', `/api/history/${encodeURIComponent(id)}/reveal`);
  }
  clearHistory(): Promise<{ ok: true }> {
    return this.request('DELETE', '/api/history');
  }
}

export type HelperState =
  | { state: 'not-configured' }
  | { state: 'offline'; message: string }
  | { state: 'unauthorized'; message: string }
  | { state: 'online'; status: StatusResponse };

/** Connection check used by the UI to show the helper status pill. */
export async function checkHelper(client: HelperClient): Promise<HelperState> {
  try {
    await client.health();
  } catch (error) {
    return { state: 'offline', message: (error as Error).message };
  }
  if (!client.configured) return { state: 'not-configured' };
  try {
    return { state: 'online', status: await client.status() };
  } catch (error) {
    const e = error as HelperError;
    if (e.code === 'UNAUTHORIZED' || e.code === 'FORBIDDEN' || e.code === 'RATE_LIMITED') return { state: 'unauthorized', message: e.message };
    return { state: 'offline', message: e.message };
  }
}
