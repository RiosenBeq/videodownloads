/**
 * Builds the extension into dist/:
 *   - popup.html / options.html (React, code-split)
 *   - background.js (service worker) and content.js as self-contained IIFE
 *     bundles, because content scripts cannot be ES modules.
 * Cross-platform (no shell env vars). Pass --watch to rebuild on change.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import tailwind from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { build } from 'vite';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(root, 'dist');
const watch = process.argv.includes('--watch') ? {} : null;
const target = 'chrome120';
const define = { 'process.env.NODE_ENV': JSON.stringify('production') };

await build({
  root,
  configFile: false,
  logLevel: 'warn',
  base: './',
  plugins: [react(), tailwind()],
  publicDir: path.join(root, 'public'),
  define,
  build: {
    outDir,
    emptyOutDir: true,
    target,
    modulePreload: { polyfill: false },
    rollupOptions: {
      input: {
        popup: path.join(root, 'popup.html'),
        options: path.join(root, 'options.html'),
      },
    },
    watch,
  },
});

for (const [entry, file, name] of [
  ['src/background/index.ts', 'background.js', 'ClipkeeperBackground'],
  ['src/content/index.ts', 'content.js', 'ClipkeeperContent'],
]) {
  await build({
    root,
    configFile: false,
    logLevel: 'warn',
    publicDir: false,
    define,
    build: {
      outDir,
      emptyOutDir: false,
      target,
      lib: { entry: path.join(root, entry), formats: ['iife'], name, fileName: () => file },
      watch,
    },
  });
}

console.log(`Extension built → ${path.relative(process.cwd(), outDir) || outDir}`);
