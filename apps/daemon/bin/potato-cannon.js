#!/usr/bin/env node

import { program } from 'commander';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { readFileSync } from 'fs';
import { DEFAULT_PORT, DEFAULT_HOST } from '@potato-cannon/shared';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf-8'));

program
  .name('potato-cannon')
  .description('Multi-agent software engineering daemon')
  .version(pkg.version);

program
  .command('start')
  .description('Start the daemon')
  .option('-d, --daemon', 'Run in background')
  .option('-p, --port <port>', 'Port to listen on', String(DEFAULT_PORT))
  .option('-H, --host <host>', 'Address to bind to (use 0.0.0.0 to expose beyond localhost)', DEFAULT_HOST)
  .action(async (options) => {
    const { startServer } = await import('../dist/index.js');
    await startServer(options);
  });

program
  .command('stop')
  .description('Stop the daemon')
  .action(async () => {
    const { stopServer } = await import('../dist/index.js');
    await stopServer();
  });

program
  .command('status')
  .description('Check daemon status')
  .action(async () => {
    const { getStatus } = await import('../dist/index.js');
    const status = await getStatus();
    console.log(JSON.stringify(status, null, 2));
  });

program.parse(process.argv, { from: 'node' });
