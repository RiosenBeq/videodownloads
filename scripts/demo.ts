/**
 * Opens a Chromium window with the built extension installed and paired with
 * the running helper, on a local sample page and the Clipkeeper popup.
 *
 *   npm run start:backend   (in another terminal)
 *   npm run demo
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { ConfigStore, resolveAppPaths } from '../backend/src/config';
import { ensureFixtures } from './make-fixtures.mjs';
import { startMediaServer } from '../tests/helpers/mediaServer';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const extension = path.join(root, 'extension', 'dist');
if (!fs.existsSync(path.join(extension, 'manifest.json'))) throw new Error('Run npm run build first.');

const config = await ConfigStore.load(resolveAppPaths());
const helperUrl = `http://127.0.0.1:${config.port}`;
const health = await fetch(`${helperUrl}/api/health`).catch(() => undefined);
if (!health?.ok) console.warn(`Helper not reachable at ${helperUrl} — start it with: npm run start:backend`);

const fixtures = ensureFixtures();
fs.cpSync(path.join(root, 'tests', 'e2e', 'site'), path.join(fixtures, 'e2e'), { recursive: true });
const media = await startMediaServer(fixtures);

const context = await chromium.launchPersistentContext(path.join(os.homedir(), '.clipkeeper-demo-profile'), {
  channel: 'chromium',
  headless: false,
  viewport: null,
  args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`, '--window-size=1400,900'],
});
const sw = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
const extensionId = new URL(sw.url()).host;
await sw.evaluate(
  async ({ helperUrl, token }) => {
    const current = (await chrome.storage.local.get('settings')).settings ?? {};
    await chrome.storage.local.set({ settings: { ...current, helperUrl, helperToken: token } });
  },
  { helperUrl, token: config.token },
);
// Close the settings tab the extension opens on first install.
for (const p of context.pages()) if (p.url().includes('options.html')) await p.close();

const page = context.pages()[0] ?? (await context.newPage());
await page.goto(`${media.url}/e2e/page.html`);
await page.waitForTimeout(2500);
const tabId = await sw.evaluate(async (url) => (await chrome.tabs.query({ url }))[0]?.id, `${media.url}/e2e/page.html`);
const popup = await context.newPage();
await popup.goto(`chrome-extension://${extensionId}/popup.html?tabId=${tabId}`);

console.log(`Chromium is open with Clipkeeper (${extensionId}). Sample page: ${media.url}/e2e/page.html`);
console.log('Browse to any site and click the Clipkeeper toolbar icon. Close the window to exit.');
await new Promise<void>((resolve) => context.on('close', () => resolve()));
await media.close();
