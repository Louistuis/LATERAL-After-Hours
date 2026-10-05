/** Entry point: `node dist/server.mjs`. Reads the environment, starts, and shuts down cleanly on SIGTERM/SIGINT. */
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { loadConfig } from './config';
import { startServer } from './server';
import { createSmtpTransport } from './smtp';
import { consoleLog } from './util';

process.on('warning', w => { if (w.name !== 'ExperimentalWarning') console.warn(w.message); });
process.on('unhandledRejection', reason => consoleLog('server.unhandled-rejection', { err: String((reason as Error)?.message ?? reason).slice(0, 120) }));
const cfg = loadConfig();
if (cfg.dbPath !== ':memory:') mkdirSync(dirname(cfg.dbPath), { recursive: true });
const transport = cfg.emailEnabled && cfg.smtp.host ? createSmtpTransport(cfg.smtp) : null;
if (cfg.emailEnabled && !transport) consoleLog('server.email-misconfigured', { note: 'EMAIL_ENABLED is set but SMTP_HOST is empty; email stays off' });
const running = await startServer(cfg, { transport });
let stopping = false;
const stop = (signal: string): void => {
  if (stopping) return;
  stopping = true;
  consoleLog('server.stop', { signal });
  const hard = setTimeout(() => process.exit(0), 3000);
  hard.unref();
  void running.close().finally(() => process.exit(0));
};
process.on('SIGTERM', () => stop('SIGTERM'));
process.on('SIGINT', () => stop('SIGINT'));
