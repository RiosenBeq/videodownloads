/**
 * Native OS integrations with fixed command lines: a folder picker and
 * "show in Finder/Explorer". No caller-controlled text reaches a shell.
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { AppError } from './errors';
import { runProcess } from './process';

export interface SystemIntegration {
  chooseFolder(): Promise<string | null>;
  reveal(filePath: string): Promise<void>;
}

const PROMPT = 'Choose where Clipkeeper saves videos';

async function chooseFolderMac(): Promise<string | null> {
  const result = await runProcess('/usr/bin/osascript', ['-e', 'activate', '-e', `POSIX path of (choose folder with prompt "${PROMPT}")`], {
    timeoutMs: 10 * 60_000,
  });
  if (result.code !== 0) return null; // user canceled (error -128)
  return result.stdout.trim().replace(/\/$/, '') || null;
}

async function chooseFolderWindows(): Promise<string | null> {
  const script = [
    'Add-Type -AssemblyName System.Windows.Forms',
    '$d = New-Object System.Windows.Forms.FolderBrowserDialog',
    `$d.Description = '${PROMPT}'`,
    '$d.ShowNewFolderButton = $true',
    "if ($d.ShowDialog() -eq 'OK') { [Console]::Out.Write($d.SelectedPath) }",
  ].join('; ');
  const result = await runProcess('powershell.exe', ['-NoProfile', '-NonInteractive', '-STA', '-Command', script], {
    timeoutMs: 10 * 60_000,
  });
  return result.stdout.trim() || null;
}

async function chooseFolderLinux(): Promise<string | null> {
  try {
    const result = await runProcess('zenity', ['--file-selection', '--directory', `--title=${PROMPT}`], { timeoutMs: 10 * 60_000 });
    return result.code === 0 ? result.stdout.trim() || null : null;
  } catch {
    throw new AppError('UNSUPPORTED', 'No folder picker is available. Type the folder path in settings instead.');
  }
}

function detached(bin: string, args: string[], extra: { windowsVerbatimArguments?: boolean } = {}): void {
  const child = spawn(bin, args, { detached: true, stdio: 'ignore', shell: false, windowsHide: false, ...extra });
  child.on('error', () => undefined);
  child.unref();
}

export const nativeSystem: SystemIntegration = {
  async chooseFolder() {
    if (process.platform === 'darwin') return chooseFolderMac();
    if (process.platform === 'win32') return chooseFolderWindows();
    return chooseFolderLinux();
  },
  async reveal(filePath: string) {
    const resolved = path.resolve(filePath);
    if (process.platform === 'darwin') return detached('/usr/bin/open', ['-R', resolved]);
    // explorer.exe needs `/select,"path"` verbatim; Windows paths cannot contain quotes.
    if (process.platform === 'win32') return detached('explorer.exe', [`/select,"${resolved}"`], { windowsVerbatimArguments: true });
    return detached('xdg-open', [path.dirname(resolved)]);
  },
};
