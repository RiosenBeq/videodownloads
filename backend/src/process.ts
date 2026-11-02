/**
 * Child-process helper. Always spawns a fixed executable with an argument
 * vector (never a shell), supports cancellation and line-based output.
 */
import { spawn } from 'node:child_process';
import { AppError } from './errors';

export interface RunOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  onStdoutLine?: (line: string) => void;
  onStderrLine?: (line: string) => void;
  /** Max stdout bytes kept in memory for the result. */
  maxBuffer?: number;
}

export interface RunResult {
  code: number | null;
  stdout: string;
  stderrTail: string;
}

function lineSplitter(onLine?: (line: string) => void) {
  let rest = '';
  return {
    push(chunk: string) {
      if (!onLine) return;
      rest += chunk;
      const lines = rest.split(/\r?\n|\r/);
      rest = lines.pop() ?? '';
      for (const line of lines) if (line) onLine(line);
    },
    flush() {
      if (onLine && rest) onLine(rest);
      rest = '';
    },
  };
}

export function runProcess(bin: string, args: string[], options: RunOptions = {}): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    if (options.signal?.aborted) return reject(options.signal.reason ?? new Error('aborted'));
    const child = spawn(bin, args, { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const maxBuffer = options.maxBuffer ?? 32 * 1024 * 1024;
    let stdout = '';
    let stderrTail = '';
    let settled = false;
    const out = lineSplitter(options.onStdoutLine);
    const err = lineSplitter(options.onStderrLine);

    const kill = () => {
      if (child.exitCode !== null || child.killed) return;
      child.kill('SIGTERM');
      setTimeout(() => child.exitCode === null && child.kill('SIGKILL'), 3000).unref();
    };
    const onAbort = () => kill();
    options.signal?.addEventListener('abort', onAbort, { once: true });
    const timer = options.timeoutMs
      ? setTimeout(() => {
          kill();
          finish(() => reject(new AppError('INTERNAL', `${bin} timed out`)));
        }, options.timeoutMs)
      : undefined;

    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
      fn();
    };

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      if (stdout.length < maxBuffer) stdout += chunk;
      out.push(chunk);
    });
    child.stderr.on('data', (chunk: string) => {
      stderrTail = (stderrTail + chunk).slice(-4000);
      err.push(chunk);
    });
    child.on('error', (error) => finish(() => reject(error)));
    child.on('close', (code) => {
      out.flush();
      err.flush();
      finish(() => {
        if (options.signal?.aborted) reject(options.signal.reason ?? new Error('aborted'));
        else resolve({ code, stdout, stderrTail });
      });
    });
  });
}
