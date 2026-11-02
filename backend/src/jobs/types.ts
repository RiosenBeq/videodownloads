import type { BackendSettings, CreateJobRequest, DependencyStatus, DownloadJob } from '@clipkeeper/shared';
import type { UrlPolicy } from '../net/policy';

/** The validated create request plus the resolved title. */
export interface JobRequest extends CreateJobRequest {
  title: string;
}

export interface RunnerContext {
  readonly job: Readonly<DownloadJob>;
  readonly request: JobRequest;
  readonly signal: AbortSignal;
  readonly policy: UrlPolicy;
  readonly settings: BackendSettings;
  readonly deps: DependencyStatus;
  /** Per-job scratch folder (inside the download folder, so finishing is a rename). */
  readonly workDir: string;
  update(patch: Partial<DownloadJob>): void;
  /** Move a finished temp file into the download folder under a unique name. Returns the final path. */
  finalize(tempFile: string, extension: string): Promise<string>;
}

export interface Runner {
  run(ctx: RunnerContext): Promise<string>;
}
