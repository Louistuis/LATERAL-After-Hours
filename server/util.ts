/** Small shared helpers: crypto, limiters, logging. No I/O beyond console. */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

export const sha256hex = (text: string | Buffer): string => createHash('sha256').update(text).digest('hex');
export const b64url = (bytes: Buffer): string => bytes.toString('base64url');
export const randomToken = (bytes = 32): string => b64url(randomBytes(bytes));

/** Unambiguous alphabet (no I, O, 0, 1) for recovery and gift codes. */
export const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export function randomCode(length: number): string {
  // Rejection-free: 256 is a multiple of 32, so a byte maps to the alphabet without bias.
  const bytes = randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i++) out += CODE_ALPHABET[bytes[i]! & 31];
  return out;
}

/** Constant-time string comparison (both sides hashed first, so lengths do not leak). */
export function safeEqual(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a).digest(), hb = createHash('sha256').update(b).digest();
  return timingSafeEqual(ha, hb) && a.length === b.length;
}

/** Sliding window counter keyed by string. `hit` returns false when the key is over its limit. */
export class WindowLimiter {
  private readonly hits = new Map<string, number[]>();
  constructor(readonly limit: number, readonly windowMs: number, private readonly maxKeys = 50_000) {}
  /** Records an attempt. true = allowed. */
  hit(key: string, now: number): boolean {
    const list = this.prune(key, now);
    if (list.length >= this.limit) return false;
    list.push(now);
    this.hits.set(key, list);
    if (this.hits.size > this.maxKeys) this.sweep(now);
    return true;
  }
  /** Current count without recording. */
  count(key: string, now: number): number { return this.prune(key, now).length; }
  /** true when the key has reached its limit (no recording). */
  full(key: string, now: number): boolean { return this.count(key, now) >= this.limit; }
  /** Records without checking (for failure counters). */
  add(key: string, now: number): number {
    const list = this.prune(key, now);
    list.push(now);
    this.hits.set(key, list);
    return list.length;
  }
  reset(key: string): void { this.hits.delete(key); }
  private prune(key: string, now: number): number[] {
    const list = this.hits.get(key) ?? [];
    const cut = now - this.windowMs;
    let i = 0;
    while (i < list.length && list[i]! <= cut) i++;
    if (i) list.splice(0, i);
    return list;
  }
  sweep(now: number): void {
    const cut = now - this.windowMs;
    for (const [key, list] of this.hits) if (!list.length || list[list.length - 1]! <= cut) this.hits.delete(key);
  }
  size(): number { return this.hits.size; }
}

/** Lockout after repeated failures: `fail` counts, `locked` says whether the key is currently blocked. */
export class Lockout {
  private readonly fails = new Map<string, { at: number[]; until: number }>();
  constructor(readonly maxFails: number, readonly windowMs: number, readonly lockMs: number) {}
  locked(key: string, now: number): boolean { const e = this.fails.get(key); return !!e && e.until > now; }
  fail(key: string, now: number): boolean {
    const e = this.fails.get(key) ?? { at: [], until: 0 };
    e.at = e.at.filter(t => t > now - this.windowMs);
    e.at.push(now);
    if (e.at.length >= this.maxFails) { e.until = now + this.lockMs; e.at = []; }
    this.fails.set(key, e);
    if (this.fails.size > 20_000) this.sweep(now);
    return e.until > now;
  }
  success(key: string): void { this.fails.delete(key); }
  sweep(now: number): void { for (const [k, e] of this.fails) if (e.until <= now && (!e.at.length || e.at[e.at.length - 1]! < now - this.windowMs)) this.fails.delete(k); }
}

/** Token bucket: `rate` tokens per second up to `burst`. */
export class Bucket {
  private tokens: number;
  private last: number;
  constructor(readonly rate: number, readonly burst: number, now: number) { this.tokens = burst; this.last = now; }
  take(now: number): boolean {
    this.tokens = Math.min(this.burst, this.tokens + (now - this.last) * this.rate / 1000);
    this.last = now;
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }
}

/** Structured one-line log. Never pass addresses, tokens or codes. */
export type Logger = (event: string, fields?: Record<string, unknown>) => void;
export const consoleLog: Logger = (event, fields) => {
  try { console.log(JSON.stringify({ ts: new Date().toISOString(), ev: event, ...fields })); } catch { /* never throw from logging */ }
};
export const silentLog: Logger = () => {};

export const dayOf = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

/** Plain single-line text: control, bidi and zero-width characters removed, spaces collapsed, capped by code points. */
// eslint-disable-next-line no-control-regex
const UNSAFE_TEXT = new RegExp('[\\u0000-\\u001f\\u007f-\\u009f\\u200b-\\u200f\\u2028-\\u202e\\u2060-\\u206f\\ufeff]', 'g');
export function cleanText(value: unknown, max: number): string {
  if (typeof value !== 'string') return '';
  const clean = value.slice(0, max * 4).replace(UNSAFE_TEXT, ' ').replace(/\s+/g, ' ').trim();
  const points = Array.from(clean);
  return points.length > max ? points.slice(0, max).join('').trimEnd() : clean;
}

export const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** Order-insensitive deep equality for JSON values. */
export function jsonEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null || typeof a !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    const bb = b as unknown[];
    return a.length === bb.length && a.every((v, i) => jsonEqual(v, bb[i]));
  }
  const ka = Object.keys(a as object), kb = Object.keys(b as object);
  if (ka.length !== kb.length) return false;
  for (const k of ka) {
    if (!Object.prototype.hasOwnProperty.call(b, k)) return false;
    if (!jsonEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k])) return false;
  }
  return true;
}

/** Normalises ::ffff:1.2.3.4 style socket addresses. */
export function normIp(addr: string | undefined | null): string {
  if (!addr) return '';
  return addr.startsWith('::ffff:') ? addr.slice(7) : addr;
}

/** An error that maps to an HTTP status and a machine readable code. */
export class ApiError extends Error {
  constructor(readonly status: number, readonly code: string, message?: string, readonly extra?: Record<string, unknown>) {
    super(message ?? code);
  }
}
