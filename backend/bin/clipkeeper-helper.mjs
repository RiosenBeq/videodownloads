#!/usr/bin/env node
// Launches the helper through tsx so the TypeScript sources run directly.
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const tsxCli = require.resolve('tsx/cli');
const entry = path.join(here, '..', 'src', 'cli.ts');
const child = spawn(process.execPath, [tsxCli, entry, ...process.argv.slice(2)], { stdio: 'inherit' });
child.on('exit', (code, signal) => (signal ? process.kill(process.pid, signal) : process.exit(code ?? 0)));
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => child.kill(sig));
