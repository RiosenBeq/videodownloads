/**
 * End-to-end test: the built extension in Chromium + the real helper + a
 * local media server. Verifies detection on a real page, the popup UI, a
 * Chrome-engine download, a helper HLS download, duplicate prevention and
 * the options page. Screenshots go to tests/e2e/.artifacts/.
 *
 *   npm run test:e2e            (builds the extension first)
 *   HEADED=1 npm run test:e2e   (watch it run)
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type BrowserContext, type Page, type Worker } from 'playwright';
import { createHelper, type Helper } from '../../backend/src/server';
import { ensureFixtures } from '../../scripts/make-fixtures.mjs';
import { startMediaServer, type MediaServer } from '../helpers/mediaServer';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '..', '..');
const EXTENSION = path.join(ROOT, 'extension', 'dist');
const ARTIFACTS = path.join(here, '.artifacts');

let passed = 0;
function check(condition: unknown, message: string): void {
  if (!condition) throw new Error(`✗ ${message}`);
  passed++;
  console.log(`  ✓ ${message}`);
}

async function poll<T>(fn: () => Promise<T | undefined | false>, what: string, timeoutMs = 20_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 200));
  }
}

interface CardInfo {
  title: string;
  kind: string;
  text: string;
  hasButton: boolean;
  options: string[];
}

/** Let fade-in animations and theme color transitions finish before capturing. */
async function shot(page: Page, name: string, fullPage = false): Promise<void> {
  await page.waitForTimeout(450);
  await page.screenshot({ path: path.join(ARTIFACTS, name), fullPage });
}

async function readCards(popup: Page): Promise<CardInfo[]> {
  return popup.$$eval('[data-testid=video-card]', (cards) =>
    cards.map((card) => ({
      title: card.querySelector('h3')?.textContent ?? '',
      kind: card.getAttribute('data-kind') ?? '',
      text: (card as HTMLElement).innerText,
      hasButton: !!card.querySelector('[data-testid=download-button]'),
      options: [...card.querySelectorAll('option')].map((o) => o.textContent ?? ''),
    })),
  );
}

async function main(): Promise<void> {
  if (!fs.existsSync(path.join(EXTENSION, 'manifest.json'))) throw new Error('Build the extension first: npm run build');
  fs.rmSync(ARTIFACTS, { recursive: true, force: true });
  fs.mkdirSync(ARTIFACTS, { recursive: true });

  const fixtures = ensureFixtures();
  fs.cpSync(path.join(here, 'site'), path.join(fixtures, 'e2e'), { recursive: true });

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'clipkeeper-e2e-'));
  const downloadDir = path.join(tmp, 'helper-downloads');
  let media: MediaServer | undefined;
  let helper: Helper | undefined;
  let context: BrowserContext | undefined;

  try {
    media = await startMediaServer(fixtures);
    helper = await createHelper({
      home: path.join(tmp, 'helper-home'),
      overrides: { port: 0, settings: { downloadDir, allowPrivateNetwork: true } },
      system: { chooseFolder: async () => null, reveal: async () => undefined },
    });
    const { url: helperUrl } = await helper.listen();
    console.log(`Media server ${media.url} · helper ${helperUrl}`);

    context = await chromium.launchPersistentContext(path.join(tmp, 'profile'), {
      channel: 'chromium',
      headless: !process.env.HEADED,
      viewport: { width: 1100, height: 760 },
      args: [`--disable-extensions-except=${EXTENSION}`, `--load-extension=${EXTENSION}`],
    });
    const sw: Worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
    const extensionId = new URL(sw.url()).host;
    console.log(`Extension loaded: ${extensionId}`);

    console.log('\nSetup');
    await sw.evaluate(
      async ({ helperUrl, token }) => {
        await chrome.storage.local.set({
          settings: { helperUrl, helperToken: token, acknowledged: true, browserSubfolder: 'Clipkeeper-e2e', notifications: true },
        });
      },
      { helperUrl, token: helper.config.token },
    );
    check(true, 'extension paired with the helper token');

    console.log('\nDetection on a real page');
    const page = await context.newPage();
    await page.goto(`${media.url}/e2e/page.html`);
    await page.waitForTimeout(2500); // injected video + manifest probes
    const tabId = await sw.evaluate(async (url) => (await chrome.tabs.query({ url }))[0]?.id, `${media.url}/e2e/page.html`);
    check(typeof tabId === 'number', `test page open in tab ${tabId}`);

    const popup = await context.newPage();
    await popup.setViewportSize({ width: 400, height: 600 });
    const errors: string[] = [];
    popup.on('pageerror', (e) => errors.push(e.message));
    await popup.emulateMedia({ colorScheme: 'dark' });
    await popup.goto(`chrome-extension://${extensionId}/popup.html?tabId=${tabId}`);
    await popup.waitForSelector('[data-testid=helper-pill][data-state=online]', { timeout: 15_000 });
    check(true, 'popup shows the helper as connected');

    const cards = await poll(async () => {
      const c = await readCards(popup);
      return c.length >= 9 && c.some((x) => x.kind === 'hls' && x.options.length >= 2) && c;
    }, 'all detected videos');
    const find = (pred: (c: CardInfo) => boolean) => cards.find(pred);
    console.log(`  (${cards.length} cards: ${cards.map((c) => `${c.kind}:${c.title}`).join(' | ')})`);

    check(find((c) => c.title === 'Direct MP4 sample' && /Ready/.test(c.text) && c.hasButton), '<video src> MP4 detected and ready');
    check(find((c) => c.title === 'Multi-source clip' && c.options.length === 2), '<source> alternatives offered as a quality selector');
    check(find((c) => c.title === 'Iframe video'), 'video inside an iframe detected');
    check(find((c) => c.title === 'Injected later'), 'video injected after load detected (MutationObserver)');
    check(find((c) => /large sample/i.test(c.title)), 'link to a video file detected');
    const hls = find((c) => c.kind === 'hls' && /Stream/.test(c.text));
    check(hls && hls.options.some((o) => o.startsWith('720p')) && hls.options.some((o) => o.startsWith('360p')), 'HLS manifest sniffed from the network with 720p/360p variants');
    check(find((c) => c.kind === 'dash' && c.options.length === 2), 'DASH manifest sniffed with its representations');
    check(find((c) => c.kind === 'hls' && /Protected/.test(c.text) && !c.hasButton), 'encrypted HLS marked Protected with no download button');
    check(find((c) => c.kind === 'blob' && /Not directly saveable/.test(c.text) && /Media Source/.test(c.text)), 'MSE blob player explained');

    const badge = await sw.evaluate((id) => chrome.action.getBadgeText({ tabId: id }), tabId!);
    check(Number(badge) === cards.length, `toolbar badge shows ${badge}`);
    await shot(popup, 'popup-videos-dark.png');
    await popup.emulateMedia({ colorScheme: 'light' });
    await shot(popup, 'popup-videos-light.png');
    await popup.emulateMedia({ colorScheme: 'dark' });

    console.log('\nChrome-engine download (direct MP4)');
    const directCard = popup.locator('[data-testid=video-card]', { has: popup.locator('h3', { hasText: 'Direct MP4 sample' }) });
    await directCard.getByTestId('download-button').click();
    await directCard.getByText('Downloading with Chrome').waitFor();
    const item = await poll(
      () =>
        sw.evaluate(async () => (await chrome.downloads.search({ state: 'complete' })).find((d) => d.url.includes('/sample.mp4') && !d.url.includes('?'))),
      'Chrome download to complete',
    );
    const expectedSize = fs.statSync(path.join(fixtures, 'sample.mp4')).size;
    check(item.fileSize === expectedSize || item.totalBytes === expectedSize, `Chrome saved the file (${item.totalBytes} bytes)`);
    const history = await poll(
      () => sw.evaluate(async () => ((await chrome.storage.local.get('browserHistory')).browserHistory as Array<{ status: string }> | undefined)?.[0]),
      'browser history entry',
    );
    check(history.status === 'completed', 'completed Chrome download recorded in history');
    const notes = await sw.evaluate(() => chrome.notifications.getAll());
    check(Object.keys(notes).some((id) => id.startsWith('ck:browser:')), 'completion notification created');

    await directCard.getByTestId('download-button').click();
    await directCard.getByText('already downloaded').waitFor();
    check(await directCard.getByText('Download again').isVisible(), 'duplicate download prevented, with "Download again" option');

    console.log('\nHelper download (HLS, 360p)');
    const hlsCard = popup.locator('[data-testid=video-card][data-kind=hls]', { has: popup.getByTestId('quality-select') });
    const lowLabel = (await hlsCard.locator('option').allTextContents()).find((o) => o.startsWith('360p'))!;
    await hlsCard.getByTestId('quality-select').selectOption({ label: lowLabel });
    await hlsCard.getByTestId('download-button').click();
    await hlsCard.getByText('Sent to the Clipkeeper helper').waitFor();
    const job = await poll(async () => helper!.jobs.list().find((j) => j.engine === 'hls' && j.status === 'completed'), 'helper HLS job', 45_000);
    const probe = JSON.parse(
      execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type,height', '-of', 'json', job.filePath!], { encoding: 'utf8' }),
    ) as { streams: Array<{ codec_type: string; height?: number }> };
    check(probe.streams.some((s) => s.codec_type === 'video' && s.height === 360) && probe.streams.some((s) => s.codec_type === 'audio'), `helper saved ${path.basename(job.filePath!)} (360p video + audio)`);

    console.log('\nDownloads and history views');
    await popup.getByRole('tab', { name: /Downloads/ }).click();
    await poll(async () => (await popup.locator('[data-testid=job-card][data-status=completed]').count()) >= 2 || undefined, 'completed job cards');
    check(await popup.locator('[data-testid=job-card][data-engine=browser][data-status=completed]').count(), 'Chrome download card shows completed');
    check(await popup.locator('[data-testid=job-card][data-engine=hls][data-status=completed]').count(), 'helper download card shows completed');
    await shot(popup, 'popup-downloads-dark.png');

    // A throttled helper download to capture live progress (speed, ETA) and pause/resume through the UI.
    const { job: slow } = await (async () => {
      const res = await fetch(`${helperUrl}/api/jobs`, {
        method: 'POST',
        headers: { authorization: `Bearer ${helper!.config.token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ url: `${media!.url}/large.mp4?throttle=900000`, kind: 'direct', title: 'Large sample (throttled)' }),
      });
      return (await res.json()) as { job: { id: string } };
    })();
    const slowCard = popup.locator(`[data-testid=job-card][data-engine=direct]`);
    await poll(async () => /\d+%.*\/s.*left/.test((await slowCard.getByTestId('job-status-line').textContent()) ?? '') || undefined, 'live progress line');
    check(true, `progress card shows percentage, speed and ETA ("${await slowCard.getByTestId('job-status-line').textContent()}")`);
    await shot(popup, 'popup-progress-dark.png');
    await slowCard.getByRole('button', { name: 'Pause' }).click();
    await poll(async () => (await slowCard.getAttribute('data-status')) === 'paused' || undefined, 'paused state');
    check(true, 'paused from the popup');
    await slowCard.getByRole('button', { name: 'Resume' }).click();
    await poll(async () => helper!.jobs.get(slow.id).status === 'completed' || undefined, 'resumed job to finish', 30_000);
    check(fs.statSync(helper.jobs.get(slow.id).filePath!).size === fs.statSync(path.join(fixtures, 'large.mp4')).size, 'resumed from the popup and completed intact');

    await popup.getByRole('tab', { name: /History/ }).click();
    await popup.locator('[data-testid=history-row]').first().waitFor();
    check((await popup.locator('[data-testid=history-row]').count()) >= 3, 'history lists Chrome and helper downloads');
    await shot(popup, 'popup-history-dark.png');
    await popup.emulateMedia({ colorScheme: 'light' });
    await shot(popup, 'popup-history-light.png');
    check(errors.length === 0, `no runtime errors in the popup${errors.length ? `: ${errors.join('; ')}` : ''}`);

    console.log('\nOptions page');
    const options = await context.newPage();
    await options.setViewportSize({ width: 1000, height: 1400 });
    await options.emulateMedia({ colorScheme: 'dark' });
    await options.goto(`chrome-extension://${extensionId}/options.html`);
    await options.getByText(/Connected to helper/).waitFor();
    check(await options.getByText('FFmpeg').first().isVisible(), 'options page shows the helper connection and dependencies');
    await shot(options, 'options-dark.png', true);
    await options.emulateMedia({ colorScheme: 'light' });
    await shot(options, 'options-light.png', true);

    console.log(`\nE2E passed: ${passed} checks. Screenshots in ${path.relative(ROOT, ARTIFACTS)}/`);
  } finally {
    await context?.close();
    await helper?.close();
    await media?.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(`\n${error instanceof Error ? error.message : error}`);
  process.exit(1);
});
