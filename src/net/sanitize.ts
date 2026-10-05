/**
 * Input hardening for everything that arrives from other players or the room host: presence, room state,
 * messages and collection rows are all attacker-controlled. Nothing here trusts a type, a length or a number.
 */
export const MAX_NAME = 32;
export const MAX_TOAST = 120;
export const MAX_PAINT = 200;
export const MAX_ID = 64;
export const MAX_REMOTE_CARS = 16;
export const MAX_PRESENCE_ENTRIES = 256;
export const MAX_AVATAR = 300;

// Control characters, zero-width and bidirectional override characters (they can reorder or hide text).
// eslint-disable-next-line no-control-regex
const UNSAFE = new RegExp('[\\u0000-\\u001f\\u007f-\\u009f\\u200b-\\u200f\\u2028-\\u202e\\u2060-\\u206f\\ufeff]', 'g');

/** A short single-line string safe to draw: no control or bidi characters, collapsed spaces, capped by code points. */
export function sanitizeText(value: unknown, max: number, fallback = ''): string {
  if (typeof value !== 'string') return fallback;
  const clean = value.slice(0, max * 4).replace(UNSAFE, '').replace(/\s+/g, ' ').trim();
  const points = Array.from(clean);
  const out = points.length > max ? points.slice(0, max).join('').trimEnd() : clean;
  return out || fallback;
}

/** A client id: 1 to 64 plain characters. Anything else (including '__proto__') is rejected. */
export function isPeerId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,64}$/.test(value) && value !== '__proto__' && value !== 'constructor' && value !== 'prototype';
}

export function clampNumber(value: unknown, lo: number, hi: number, fallback = lo): number {
  return typeof value === 'number' && Number.isFinite(value) ? (value < lo ? lo : value > hi ? hi : value) : fallback;
}

/** Whole numbers only: NaN, Infinity and fractions fall back. */
export function clampInt(value: unknown, lo: number, hi: number, fallback = lo): number {
  return typeof value === 'number' && Number.isFinite(value) ? clampNumber(Math.trunc(value), lo, hi, fallback) : fallback;
}

/** Avatar URLs are only ever https and short; everything else renders as no avatar. */
export function safeAvatarUrl(value: unknown): string {
  return typeof value === 'string' && value.length <= MAX_AVATAR && /^https:\/\/[^\s"'<>]+$/.test(value) ? value : '';
}

/** Own-property read that can not hit the prototype chain. */
export function ownEntry<T>(map: Readonly<Record<string, T>> | null | undefined, key: string): T | undefined {
  return map && Object.prototype.hasOwnProperty.call(map, key) ? map[key] : undefined;
}

/** At most `limit` own entries of an untrusted object, as [key, value] pairs. */
export function boundedEntries<T = unknown>(raw: unknown, limit: number): [string, T][] {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return [];
  const out: [string, T][] = [];
  for (const key in raw as Record<string, T>) {
    if (!Object.prototype.hasOwnProperty.call(raw, key)) continue;
    out.push([key, (raw as Record<string, T>)[key]!]);
    if (out.length >= limit) break;
  }
  return out;
}
