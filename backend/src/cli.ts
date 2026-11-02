/**
 * Command line entry point.
 *
 *   clipkeeper-helper start [--port N] [--download-dir PATH] [--verbose]
 *   clipkeeper-helper token          print the pairing token
 *   clipkeeper-helper rotate-token   generate a new token (re-pair the extension)
 *   clipkeeper-helper doctor         check FFmpeg / yt-dlp and show paths
 */
import { APP_NAME, APP_VERSION } from '@clipkeeper/shared';
import { ConfigStore, resolveAppPaths } from './config';
import { DependencyManager } from './deps';
import { createHelper } from './server';

interface Flags {
  command: string;
  port?: number;
  downloadDir?: string;
  verbose: boolean;
}

function parseArgs(argv: string[]): Flags {
  const flags: Flags = { command: 'start', verbose: false };
  const rest = [...argv];
  if (rest[0] && !rest[0].startsWith('-')) flags.command = rest.shift()!;
  while (rest.length) {
    const arg = rest.shift()!;
    if (arg === '--port') flags.port = Number(rest.shift());
    else if (arg === '--download-dir') flags.downloadDir = rest.shift();
    else if (arg === '--verbose' || arg === '-v') flags.verbose = true;
    else if (arg === '--help' || arg === '-h') flags.command = 'help';
    else throw new Error(`Unknown option: ${arg}`);
  }
  if (flags.port !== undefined && (!Number.isInteger(flags.port) || flags.port < 1024 || flags.port > 65535)) {
    throw new Error('--port must be an integer between 1024 and 65535');
  }
  return flags;
}

const dim = (s: string) => (process.stdout.isTTY ? `\x1b[2m${s}\x1b[0m` : s);
const bold = (s: string) => (process.stdout.isTTY ? `\x1b[1m${s}\x1b[0m` : s);
const green = (s: string) => (process.stdout.isTTY ? `\x1b[32m${s}\x1b[0m` : s);
const yellow = (s: string) => (process.stdout.isTTY ? `\x1b[33m${s}\x1b[0m` : s);

async function doctor(): Promise<void> {
  const paths = resolveAppPaths();
  const config = await ConfigStore.load(paths);
  const deps = await new DependencyManager().detect(true);
  console.log(bold(`${APP_NAME} helper ${APP_VERSION} — doctor`));
  console.log(`  Config:          ${paths.configFile}`);
  console.log(`  Download folder: ${config.settings.downloadDir}`);
  console.log(`  Port:            ${config.port}`);
  for (const [label, info, hint] of [
    ['FFmpeg ', deps.ffmpeg, deps.installHints.ffmpeg],
    ['FFprobe', deps.ffprobe, deps.installHints.ffmpeg],
    ['yt-dlp ', deps.ytDlp, deps.installHints.ytDlp],
  ] as const) {
    console.log(
      info.found
        ? `  ${green('✓')} ${label}  ${info.version ?? ''} ${dim(info.path ?? '')}`
        : `  ${yellow('✗')} ${label}  not found — install with: ${bold(hint)}`,
    );
  }
  if (!deps.ffmpeg.found) console.log(yellow('\n  FFmpeg is needed to save HLS/DASH streams with separate audio and video.'));
}

async function start(flags: Flags): Promise<void> {
  const helper = await createHelper({
    logger: flags.verbose,
    overrides: { port: flags.port },
  });
  if (flags.downloadDir) await helper.config.updateSettings({ downloadDir: flags.downloadDir });

  try {
    const { url } = await helper.listen('127.0.0.1');
    const deps = await helper.deps.detect();
    console.log('');
    console.log(bold(`  ${APP_NAME} helper ${APP_VERSION}`) + dim('  — listening on ') + url);
    console.log('');
    console.log(`  ${bold('Pairing token')}  ${helper.config.token}`);
    console.log(dim('  Paste it in the extension: Settings → Local helper → Token.'));
    console.log('');
    console.log(`  Download folder  ${helper.config.settings.downloadDir}`);
    console.log(`  FFmpeg           ${deps.ffmpeg.found ? green(deps.ffmpeg.version ?? 'found') : yellow(`missing — ${deps.installHints.ffmpeg}`)}`);
    console.log(`  yt-dlp           ${deps.ytDlp.found ? green(deps.ytDlp.version ?? 'found') : dim(`not installed (optional) — ${deps.installHints.ytDlp}`)}`);
    console.log('');
    console.log(dim('  Only accessible from this computer. Press Ctrl+C to stop.'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EADDRINUSE') {
      console.error(`Port ${helper.config.port} is already in use. Is the helper already running? Use --port to pick another port.`);
      process.exit(1);
    }
    throw error;
  }

  let stopping = false;
  const stop = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    console.log(dim(`\n  ${signal} received — pausing active downloads and shutting down…`));
    await helper.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void stop('SIGINT'));
  process.on('SIGTERM', () => void stop('SIGTERM'));
}

async function main(): Promise<void> {
  const flags = parseArgs(process.argv.slice(2));
  switch (flags.command) {
    case 'start':
      return start(flags);
    case 'token': {
      const config = await ConfigStore.load(resolveAppPaths());
      console.log(config.token);
      return;
    }
    case 'rotate-token': {
      const config = await ConfigStore.load(resolveAppPaths());
      console.log(await config.rotateToken());
      console.error(dim('Token rotated. Restart the helper and paste the new token into the extension settings.'));
      return;
    }
    case 'doctor':
      return doctor();
    default:
      console.log(`Usage: clipkeeper-helper [start|token|rotate-token|doctor] [--port N] [--download-dir PATH] [--verbose]`);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
