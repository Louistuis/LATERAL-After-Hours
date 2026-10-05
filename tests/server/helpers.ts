import { Accounts } from '../../server/accounts';
import { AdminAuth } from '../../server/admin-auth';
import { Collections } from '../../server/collections';
import { loadConfig, type Config } from '../../server/config';
import { openDb, type Db } from '../../server/db';
import { Gifts } from '../../server/gifts';
import { Hub, type Sock, type Conn } from '../../server/hub';
import { FakeTransport } from '../../server/mailer';
import { WalletService } from '../../server/wallet';
import { silentLog } from '../../server/util';

export const T0 = Date.UTC(2026, 9, 5, 12, 0, 0);

export interface App {
  clock: { t: number };
  now: () => number;
  cfg: Config;
  db: Db;
  accounts: Accounts;
  wallets: WalletService;
  gifts: Gifts;
  colls: Collections;
  hub: Hub;
  adminAuth: AdminAuth;
  transport: FakeTransport;
}

export function makeApp(env: Record<string, string> = {}): App {
  const clock = { t: T0 };
  const now = (): number => clock.t;
  const cfg = loadConfig({ DB_PATH: ':memory:', PUBLIC_URL: 'https://lateral.example.test', PROXY_KEY: 'proxy-key-for-tests', ADMIN_KEY: 'cli-key-for-tests', ADMIN_EMAILS: 'louis@example.test', ...env });
  const db = openDb(':memory:');
  const accounts = new Accounts(db, cfg, silentLog, now);
  const wallets = new WalletService(db, cfg, silentLog, now);
  const transport = new FakeTransport();
  const gifts = new Gifts(db, cfg, accounts, wallets, silentLog, now, transport);
  const colls = new Collections(db, cfg, wallets, now);
  const hub = new Hub(cfg, accounts, wallets, colls, silentLog, now);
  const adminAuth = new AdminAuth(cfg, null, now);
  wallets.onChange = (id, v) => hub.walletChanged(id, v);
  gifts.onInbox = id => hub.walletChanged(id, wallets.get(id).version, true);
  return { clock, now, cfg, db, accounts, wallets, gifts, colls, hub, adminAuth, transport };
}

let ipSeq = 1;
export async function newAccount(app: App, name: string): Promise<{ id: string; name: string; token: string; account: ReturnType<Accounts['byName']> & object; recoveryCode: string }> {
  const out = await app.accounts.create(name, `10.0.${Math.floor(ipSeq / 250)}.${ipSeq++ % 250}`);
  return { id: out.account.id, name: out.account.name, token: out.token, account: out.account, recoveryCode: out.recoveryCode };
}

export class FakeSock implements Sock {
  readonly frames: any[] = []; // eslint-disable-line @typescript-eslint/no-explicit-any
  closed: { code: number; reason?: string } | null = null;
  bufferedAmount = 0;
  send(data: string): void { this.frames.push(JSON.parse(data)); }
  close(code: number, reason?: string): void { this.closed = { code, reason }; }
  /** Frames of one kind, flattened for batched messages. */
  ofType(t: string): any[] { return this.frames.filter(f => f.t === t); } // eslint-disable-line @typescript-eslint/no-explicit-any
  clear(): void { this.frames.length = 0; }
}

export interface Client { sock: FakeSock; conn: Conn; id: string; name: string; send(obj: unknown): void }
export function connectClient(app: App, token: string, name: string, ip = '10.9.9.9'): Client {
  const sock = new FakeSock();
  const conn = app.hub.connect(sock, ip)!;
  const client: Client = { sock, conn, id: '', name, send: obj => app.hub.receive(conn, JSON.stringify(obj)) };
  client.send({ t: 'h', token, v: 1 });
  client.id = conn.id;
  return client;
}

/** Runs ticks until `ms` of fake time has passed, 50 ms at a time. */
export function advance(app: App, ms: number, step = 50): void {
  for (let spent = 0; spent < ms; spent += step) { app.clock.t += step; app.hub.tick(app.clock.t); }
}
