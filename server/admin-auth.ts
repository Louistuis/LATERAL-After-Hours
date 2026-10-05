/**
 * Who may call the admin API, and how. Three modes, checked in this order:
 *   proxy  Requests that came through nc1 (files.nordcore.site, after NordDrop's admin gate): socket IP must be the mesh
 *          address of nc1, X-Lateral-Proxy-Key must equal PROXY_KEY, X-Lateral-Admin-Email must be in ADMIN_EMAILS.
 *          nginx blanks client copies of these headers; the server never trusts them from any other source IP.
 *   cli    The admin CLI on nc2: loopback socket only, no proxy headers, X-Admin-Key must equal ADMIN_KEY.
 *   access Dormant Cloudflare Access JWT mode (only when ACCESS_TEAM_DOMAIN and ACCESS_AUD are set), also only from the mesh IP.
 * Every non-GET call from the proxy or Access path also passes the CSRF guard (JSON, X-Lateral-Admin: 1, exact Origin).
 * Ten failed authentications per source IP per hour answer 429.
 */
import type { IncomingHttpHeaders } from 'node:http';
import type { Config } from './config';
import type { AccessVerifier } from './access-jwt';
import { ApiError, WindowLimiter, normIp, safeEqual } from './util';

export type AdminVia = 'proxy' | 'cli' | 'access';
export interface AdminIdentity { readonly via: AdminVia; readonly who: string }

const LOOPBACK = new Set(['127.0.0.1', '::1']);
const hdr = (h: IncomingHttpHeaders, name: string): string => {
  const v = h[name];
  return typeof v === 'string' ? v : Array.isArray(v) ? v[0] ?? '' : '';
};
const PROXY_HEADERS = ['x-forwarded-for', 'x-real-ip', 'forwarded', 'x-lateral-proxy-key', 'x-lateral-admin-email', 'cf-connecting-ip', 'cf-access-jwt-assertion', 'x-forwarded-host'];

export class AdminAuth {
  readonly bad = new WindowLimiter(10, 3_600_000);
  constructor(private readonly cfg: Config, private readonly access: AccessVerifier | null, private readonly now: () => number = Date.now) {}

  /** Throws ApiError (401, 403 or 429). */
  async authenticate(method: string, headers: IncomingHttpHeaders, remote: string | undefined): Promise<AdminIdentity> {
    const ip = normIp(remote);
    const now = this.now();
    if (this.bad.full(ip, now)) throw new ApiError(429, 'rate-limited', 'Too many failed attempts.');
    const fail = (status: number, code: string, msg: string): never => {
      this.bad.add(ip, now);
      throw new ApiError(status, code, msg);
    };
    const meshOk = this.cfg.adminProxyIps.includes(ip);
    const proxyKey = hdr(headers, 'x-lateral-proxy-key');
    const adminKey = hdr(headers, 'x-admin-key');
    const jwt = hdr(headers, 'cf-access-jwt-assertion');

    let identity: AdminIdentity | null = null;
    if (proxyKey || hdr(headers, 'x-lateral-admin-email')) {
      if (!meshOk) return fail(403, 'forbidden', 'Not allowed from this address.');
      if (!this.cfg.proxyKey || !safeEqual(proxyKey, this.cfg.proxyKey)) return fail(401, 'unauthorized', 'Admin sign in required.');
      const email = hdr(headers, 'x-lateral-admin-email').trim().toLowerCase();
      if (!email || !this.cfg.adminEmails.some(e => safeEqual(e, email))) return fail(403, 'forbidden', 'This account is not an admin.');
      identity = { via: 'proxy', who: email };
    } else if (adminKey) {
      const loop = LOOPBACK.has(ip);
      const proxied = PROXY_HEADERS.some(name => hdr(headers, name) !== '');
      if (!loop || proxied) return fail(403, 'forbidden', 'The admin key only works locally.');
      if (!this.cfg.adminKey || !safeEqual(adminKey, this.cfg.adminKey)) return fail(401, 'unauthorized', 'Wrong admin key.');
      identity = { via: 'cli', who: 'cli' };
    } else if (jwt && this.access) {
      if (!meshOk) return fail(403, 'forbidden', 'Not allowed from this address.');
      const verdict = await this.access.verify(jwt);
      if (!verdict.ok) return fail(401, 'unauthorized', 'Admin sign in required.');
      identity = { via: 'access', who: verdict.email };
    }
    if (!identity) return fail(401, 'unauthorized', 'Admin sign in required.');

    if (method !== 'GET' && method !== 'HEAD') this.csrf(identity, headers);
    return identity;
  }

  /** Non-GET guard. Browsers can not forge a JSON content type, a custom header and a foreign Origin together. */
  private csrf(identity: AdminIdentity, headers: IncomingHttpHeaders): void {
    const type = hdr(headers, 'content-type').toLowerCase();
    if (!type.startsWith('application/json')) throw new ApiError(403, 'csrf', 'Expected application/json.');
    if (identity.via === 'cli') return;
    if (hdr(headers, 'x-lateral-admin') !== '1') throw new ApiError(403, 'csrf', 'Missing admin header.');
    const origin = hdr(headers, 'origin');
    const referer = hdr(headers, 'referer');
    const okOrigin = origin ? origin === this.cfg.adminOrigin : (referer === this.cfg.adminOrigin || referer.startsWith(`${this.cfg.adminOrigin}/`));
    if (!okOrigin) throw new ApiError(403, 'csrf', 'Wrong origin.');
  }
}
