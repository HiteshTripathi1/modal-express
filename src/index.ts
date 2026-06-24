/**
 * Entry point. Starts the HTTP server and, on SIGINT/SIGTERM, terminates every
 * tracked sandbox before exiting (no orphaned, billable sandboxes).
 */
import { createApp } from './app.js';
import { config } from './config.js';
import * as registry from './modal/registry.js';

const app = createApp();

const server = app.listen(config.port, () => {
  const prefix = config.apiPrefix ? `/${config.apiPrefix}` : '';
  console.log(`🚀 Modal Sandbox API on http://localhost:${config.port}${prefix}`);
});

let shuttingDown = false;
async function shutdown(signal: string) {
  if (shuttingDown) process.exit(1); // a second signal force-quits
  shuttingDown = true;
  console.log(`${signal} received — terminating tracked sandboxes...`);
  server.close();
  await registry.terminateAll();
  process.exit(0);
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
