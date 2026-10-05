/**
 * Cloudflare Access JWT verification (RS256, node:crypto, no library). DORMANT in the shipped setup: admin.ts only
 * consults it when ACCESS_TEAM_DOMAIN and ACCESS_AUD are both set. Kept small and strict so it can not widen the attack surface.
 */
import { createPublicKey, createVerify, type KeyObject } from 'node:crypto';

type Jwk = { kid?: string; kty?: string; [key: string]: unknown };
import { safeEqual } from './util';

export interface AccessConfig {
  readonly teamDomain: string;
  readonly aud: string;
  readonly emails: readonly string[];
}
export type JwtResult = { readonly ok: true; readonly email: string } | { readonly ok: false; readonly reason: string };
export type CertFetcher = (url: string) => Promise<{ keys?: Jwk[] } | null>;

const LEEWAY_S = 60;
const MAX_TOKEN = 8192;

const b64json = (part: string): Record<string, unknown> | null => {
  try {
    const v = JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
    return v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null;
  } catch { return null; }
};

export class AccessVerifier {
  private keys = new Map<string, KeyObject>();
  private fetchedAt = 0;
  private lastRefresh = 0;

  constructor(private readonly cfg: AccessConfig, private readonly fetchCerts: CertFetcher, private readonly now: () => number = Date.now) {}

  get issuer(): string { return `https://${this.cfg.teamDomain}`; }

  private async refresh(force: boolean): Promise<void> {
    const t = this.now();
    if (force && t - this.lastRefresh < 60_000) return; // at most one forced refresh a minute
    this.lastRefresh = t;
    const body = await this.fetchCerts(`${this.issuer}/cdn-cgi/access/certs`).catch(() => null);
    if (!body || !Array.isArray(body.keys)) return;
    const next = new Map<string, KeyObject>();
    for (const jwk of body.keys) {
      if (!jwk || typeof jwk.kid !== 'string' || jwk.kty !== 'RSA') continue;
      try { next.set(jwk.kid, createPublicKey({ key: jwk as never, format: 'jwk' })); } catch { /* skip a malformed key */ }
    }
    if (next.size) { this.keys = next; this.fetchedAt = t; }
  }

  async verify(token: unknown): Promise<JwtResult> {
    if (typeof token !== 'string' || !token || token.length > MAX_TOKEN) return { ok: false, reason: 'missing' };
    const parts = token.split('.');
    if (parts.length !== 3 || parts.some(p => !/^[A-Za-z0-9_-]+$/.test(p))) return { ok: false, reason: 'malformed' };
    const header = b64json(parts[0]!), payload = b64json(parts[1]!);
    if (!header || !payload) return { ok: false, reason: 'malformed' };
    // Only RS256. "none" and HS256 (public key as HMAC secret) are refused before any key is touched.
    if (header.alg !== 'RS256') return { ok: false, reason: 'alg' };
    const kid = header.kid;
    if (typeof kid !== 'string' || kid.length > 128) return { ok: false, reason: 'kid' };
    if (this.now() - this.fetchedAt > 3_600_000 || this.keys.size === 0) await this.refresh(false);
    let key = this.keys.get(kid);
    if (!key) { await this.refresh(true); key = this.keys.get(kid); }
    if (!key) return { ok: false, reason: 'unknown-kid' };
    const verifier = createVerify('RSA-SHA256');
    verifier.update(`${parts[0]}.${parts[1]}`);
    let good: boolean;
    try { good = verifier.verify(key, Buffer.from(parts[2]!, 'base64url')); } catch { return { ok: false, reason: 'signature' }; }
    if (!good) return { ok: false, reason: 'signature' };
    const nowS = Math.floor(this.now() / 1000);
    if (typeof payload.exp !== 'number' || payload.exp + LEEWAY_S < nowS) return { ok: false, reason: 'expired' };
    if (payload.nbf !== undefined && (typeof payload.nbf !== 'number' || payload.nbf - LEEWAY_S > nowS)) return { ok: false, reason: 'not-yet' };
    if (typeof payload.iss !== 'string' || !safeEqual(payload.iss, this.issuer)) return { ok: false, reason: 'iss' };
    const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
    if (!aud.some(a => typeof a === 'string' && safeEqual(a, this.cfg.aud))) return { ok: false, reason: 'aud' };
    const email = typeof payload.email === 'string' ? payload.email.toLowerCase() : '';
    if (!email || !this.cfg.emails.some(e => safeEqual(e, email))) return { ok: false, reason: 'email' };
    return { ok: true, email };
  }
}

/** Default certificate fetcher (the only outbound request the server ever makes, and only when Access mode is on). */
export const httpsCertFetcher: CertFetcher = async url => {
  const res = await fetch(url, { signal: AbortSignal.timeout(5000), redirect: 'error' });
  if (!res.ok) return null;
  return await res.json() as { keys?: Jwk[] };
};
