/** Server configuration, read once from the environment. Every limit has a default from the contract. */
export interface Config {
  readonly version: string;
  readonly hosts: readonly string[];
  readonly port: number;
  readonly dbPath: string;
  readonly publicUrl: string;
  readonly allowedOrigins: readonly string[];
  /** Allow http://localhost and http://127.0.0.1 origins on /ws (dev builds only). */
  readonly allowLocalOrigins: boolean;
  /** Sockets from these addresses may supply X-Real-IP. */
  readonly trustedProxies: readonly string[];
  /** Admin via the files proxy path: the socket must come from one of these (never loopback by default). */
  readonly adminProxyIps: readonly string[];
  readonly proxyKey: string;
  readonly adminEmails: readonly string[];
  readonly adminOrigin: string;
  readonly adminKey: string;
  /** Dormant Cloudflare Access verification: only active when both are set. */
  readonly accessTeamDomain: string;
  readonly accessAud: string;
  readonly testGrantMarks: number;
  readonly testGrantUntil: number | null;
  readonly launchAt: number;
  readonly earnHourlyLimit: number;
  readonly emailEnabled: boolean;
  readonly emailFrom: string;
  readonly smtp: { readonly host: string; readonly port: number; readonly user: string; readonly pass: string; readonly secure: boolean };
  readonly emailDailyMax: number;
  readonly emailPerAddressDay: number;
  readonly maxConnPerIp: number;
  readonly maxConnTotal: number;
  readonly maxConnPerAccount: number;
  readonly maxLobbies: number;
  readonly accountsPerIpHour: number;
  readonly accountsGlobalHour: number;
  readonly giftMaxMarks: number;
  readonly giftMaxItems: number;
  readonly giftMaxAllActive: number;
  readonly walletWritesPerMin: number;
  readonly collectionWritesPerMin: number;
  readonly tickMs: number;
  readonly dev: boolean;
}

const num = (v: string | undefined, d: number, min = 0, max = Number.MAX_SAFE_INTEGER): number => {
  if (v === undefined || v.trim() === '') return d;
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.floor(n))) : d;
};
const list = (v: string | undefined, d: readonly string[]): string[] =>
  v === undefined ? [...d] : v.split(',').map(s => s.trim()).filter(Boolean);
const flag = (v: string | undefined, d: boolean): boolean => (v === undefined || v === '' ? d : v === '1' || v.toLowerCase() === 'true');

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const until = env.TEST_GRANT_UNTIL ? Date.parse(env.TEST_GRANT_UNTIL) : NaN;
  const launch = env.LAUNCH_AT ? Date.parse(env.LAUNCH_AT) : NaN;
  const publicUrl = (env.PUBLIC_URL || 'https://lateral.lou15.com').replace(/\/+$/, '');
  return {
    version: '1.0.0',
    hosts: list(env.HOSTS, ['127.0.0.1', '192.168.100.100']),
    port: num(env.PORT, 4416, 0, 65535),
    dbPath: env.DB_PATH || '/var/lib/lateral/lateral.db',
    publicUrl,
    allowedOrigins: list(env.ALLOWED_ORIGINS, [publicUrl]),
    allowLocalOrigins: flag(env.ALLOW_LOCAL_ORIGINS, false),
    trustedProxies: list(env.TRUSTED_PROXIES, ['192.168.100.1', '127.0.0.1']),
    adminProxyIps: list(env.ADMIN_PROXY_IPS, ['192.168.100.1']),
    proxyKey: env.PROXY_KEY || env.LATERAL_PROXY_KEY || '',
    adminEmails: list(env.ADMIN_EMAILS, ['admin@example.com']).map(s => s.toLowerCase()),
    adminOrigin: (env.ADMIN_ORIGIN || 'https://files.nordcore.site').replace(/\/+$/, ''),
    adminKey: env.ADMIN_KEY || '',
    accessTeamDomain: env.ACCESS_TEAM_DOMAIN || '',
    accessAud: env.ACCESS_AUD || '',
    testGrantMarks: num(env.TEST_GRANT_MARKS, 20000, 0, 100000),
    testGrantUntil: Number.isFinite(until) ? until : null,
    launchAt: Number.isFinite(launch) ? launch : Date.parse('2026-10-04T00:00:00Z'),
    earnHourlyLimit: num(env.EARN_HOURLY_LIMIT, 600, 1),
    emailEnabled: flag(env.EMAIL_ENABLED, false),
    emailFrom: env.MAIL_FROM || env.EMAIL_FROM || '',
    smtp: { host: env.SMTP_HOST || '', port: num(env.SMTP_PORT, 587, 1, 65535), user: env.SMTP_USER || '', pass: env.SMTP_PASS || env.SMTP_PASSWORD || '', secure: flag(env.SMTP_SECURE, false) },
    emailDailyMax: num(env.EMAIL_DAILY_MAX, 30, 0),
    emailPerAddressDay: num(env.EMAIL_PER_ADDRESS_DAY, 3, 0),
    maxConnPerIp: num(env.MAX_CONN_PER_IP, 3, 1),
    maxConnTotal: num(env.MAX_CONN_TOTAL, 400, 1),
    maxConnPerAccount: num(env.MAX_CONN_PER_ACCOUNT, 3, 1),
    maxLobbies: num(env.MAX_LOBBIES, 40, 1),
    accountsPerIpHour: num(env.ACCOUNTS_PER_IP_HOUR, 5, 1),
    accountsGlobalHour: num(env.ACCOUNTS_GLOBAL_HOUR, 200, 1),
    giftMaxMarks: num(env.GIFT_MAX_MARKS, 100000, 1),
    giftMaxItems: num(env.GIFT_MAX_ITEMS, 20, 1),
    giftMaxAllActive: num(env.GIFT_MAX_ALL_ACTIVE, 5000, 1),
    walletWritesPerMin: num(env.WALLET_WRITES_PER_MIN, 30, 1),
    collectionWritesPerMin: num(env.COLLECTION_WRITES_PER_MIN, 12, 1),
    tickMs: num(env.TICK_MS, 50, 10, 1000),
    dev: flag(env.DEV, false),
  };
}
