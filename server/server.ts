/** Composition root: builds every service, the HTTP server and the WebSocket upgrade, and returns a handle to stop it. */
import { createServer, type Server } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import { AccessVerifier, httpsCertFetcher, type CertFetcher } from './access-jwt';
import { Accounts } from './accounts';
import { AdminAuth } from './admin-auth';
import { createApi, clientIp, type Ctx } from './api';
import { Collections } from './collections';
import { type Config } from './config';
import { openDb, type Db } from './db';
import { Gifts } from './gifts';
import { CLOSE, Hub, MAX_FRAME, type Sock } from './hub';
import type { MailTransport } from './mailer';
import { WalletService } from './wallet';
import { consoleLog, normIp, type Logger } from './util';

export interface Running {
  readonly ctx: Ctx;
  readonly db: Db;
  readonly servers: Server[];
  readonly hub: Hub;
  /** Ports the HTTP servers actually bound (one per host). */
  readonly ports: number[];
  /** Static files for the admin page in dev (see dev.mjs); absent in production. */
  close(): Promise<void>;
}
export interface StartOptions {
  readonly log?: Logger;
  readonly now?: () => number;
  readonly transport?: MailTransport | null;
  readonly certFetcher?: CertFetcher;
  readonly db?: Db;
  /** Skip the background timers (tests drive hub.tick themselves). */
  readonly manual?: boolean;
  /** Extra request handler tried before the API (dev admin page). Return true when handled. */
  readonly extra?: (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => boolean;
}

function originAllowed(cfg: Config, origin: string | undefined): boolean {
  if (!origin) return false;
  if (cfg.allowedOrigins.includes(origin)) return true;
  if (cfg.allowLocalOrigins && /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) return true;
  return false;
}

export async function startServer(cfg: Config, options: StartOptions = {}): Promise<Running> {
  const log = options.log ?? consoleLog;
  const now = options.now ?? Date.now;
  const db = options.db ?? openDb(cfg.dbPath);
  const accounts = new Accounts(db, cfg, log, now);
  const wallets = new WalletService(db, cfg, log, now);
  const gifts = new Gifts(db, cfg, accounts, wallets, log, now, options.transport ?? null);
  const colls = new Collections(db, cfg, wallets, now);
  const hub = new Hub(cfg, accounts, wallets, colls, log, now);
  const access = cfg.accessAud && cfg.accessTeamDomain
    ? new AccessVerifier({ teamDomain: cfg.accessTeamDomain, aud: cfg.accessAud, emails: cfg.adminEmails }, options.certFetcher ?? httpsCertFetcher, now) : null;
  const adminAuth = new AdminAuth(cfg, access, now);
  wallets.onChange = (id, version) => hub.walletChanged(id, version);
  gifts.onInbox = id => hub.walletChanged(id, wallets.get(id).version, true);
  const ctx: Ctx = { cfg, accounts, wallets, gifts, colls, hub, adminAuth, log, now, startedAt: now() };
  const api = createApi(ctx);

  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME, perMessageDeflate: false, clientTracking: false });
  const servers: Server[] = [];
  const handler: Server['listeners'] extends never ? never : (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => void = (req, res) => {
    if (options.extra?.(req, res)) return;
    void api(req, res);
  };

  const onUpgrade = (req: import('node:http').IncomingMessage, socket: import('node:stream').Duplex): void => {
    const reject = (status: number, text: string): void => { try { socket.write(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`); } catch { /* gone */ } socket.destroy(); };
    const path = (req.url ?? '').split('?')[0];
    if (path !== '/ws') return reject(404, 'Not Found');
    if (!originAllowed(cfg, req.headers.origin)) return reject(403, 'Forbidden');
    const ip = clientIp(cfg, req.headers, req.socket.remoteAddress);
    wss.handleUpgrade(req, socket, Buffer.alloc(0), ws => attach(ws, ip));
  };

  const sockets = new Set<WebSocket>();
  function attach(ws: WebSocket, ip: string): void {
    sockets.add(ws);
    ws.on('close', () => sockets.delete(ws));
    const sock: Sock = {
      send: data => { if (ws.readyState === ws.OPEN) ws.send(data); },
      close: (code, reason) => { try { ws.close(code, reason); } catch { ws.terminate(); } },
      get bufferedAmount() { return ws.bufferedAmount; },
    };
    const conn = hub.connect(sock, ip);
    if (!conn) { ws.close(CLOSE.full, 'full'); return; }
    ws.on('message', (data, isBinary) => {
      if (isBinary) { sock.close(CLOSE.badFrame, 'text only'); hub.disconnect(conn); return; }
      try {
        hub.receive(conn, Array.isArray(data) ? Buffer.concat(data).toString('utf8') : data.toString('utf8'));
      } catch (error) {
        // One bad frame must never take the process (and every other player) down.
        log('hub.receive-error', { err: String((error as Error)?.message ?? error).slice(0, 100) });
        sock.close(1011, 'error'); hub.disconnect(conn);
      }
    });
    ws.on('close', () => hub.disconnect(conn));
    ws.on('error', () => { hub.disconnect(conn); try { ws.terminate(); } catch { /* gone */ } });
  }

  const ports: number[] = [];
  for (const host of cfg.hosts) {
    const server = createServer({ maxHeaderSize: 8192, requestTimeout: 15_000, headersTimeout: 10_000, keepAliveTimeout: 65_000 }, handler);
    server.on('upgrade', onUpgrade);
    server.on('clientError', (_e, socket) => { try { socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n'); } catch { /* gone */ } });
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(cfg.port === 0 && ports.length ? ports[0]! : cfg.port, host, () => resolve()); });
    ports.push((server.address() as import('node:net').AddressInfo).port);
    servers.push(server);
  }

  const timers: NodeJS.Timeout[] = [];
  if (!options.manual) {
    timers.push(setInterval(() => { try { hub.tick(now()); } catch (error) { log('hub.tick-error', { err: String((error as Error)?.message ?? error).slice(0, 100) }); } }, cfg.tickMs));
    timers.push(setInterval(() => { try { colls.prune(); } catch { /* retry next hour */ } }, 3_600_000));
    for (const t of timers) t.unref();
  }
  log('server.start', { hosts: cfg.hosts, port: ports[0], version: cfg.version, email: cfg.emailEnabled, accessMode: Boolean(access) });

  return {
    ctx, db, servers, hub, ports,
    async close() {
      for (const t of timers) clearInterval(t);
      for (const c of sockets) c.terminate();
      await Promise.all(servers.map(s => new Promise<void>(resolve => { s.close(() => resolve()); s.closeAllConnections(); })));
      try { db.close(); } catch { /* already closed */ }
    },
  };
}

export { normIp };
