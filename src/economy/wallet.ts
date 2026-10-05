/**
 * Pure wallet arithmetic. No I/O, no platform knowledge: every function takes a record and returns a new one.
 *
 *   budget  = sum(derived source totals) + sum(accrued earnings, capped to what the daily caps allow)
 *   spent   = sum of catalog prices of the owned (and verified) non-stock items. RECOMPUTED, never trusted.
 *   balance = budget - spent
 *
 * Derived totals (websim tips) are recomputed from their source of truth on every load and are never stored,
 * so a tampered record can not mint tip Marks. Accrued earnings are client-claimed and therefore capped per day.
 * `owned` is an append-only purchase list (oldest first). Anything in it that the verified budget can not pay
 * for is "locked": kept in the record (so it unlocks again if the tips arrive later) but never usable.
 */
import { catalogEntry, catalogItem, priceOf, sanitizeLoadout } from './catalog';
import { mergeProgress, normalizeProgress } from './mission-progress';
import { CUSTOM_PLATE_ID, validatePlateText, type PlateReason } from './plate';
import type { CatalogItem, CosmeticSlot, GrantRequest, GrantResult, WalletRecord } from './types';

export const MAX_RECEIPTS = 300;
const MAX_GRANT = 10_000;
const MAX_TOTAL = 1e9;
/** Hard bound on a stored wallet's JSON text. Real records are under 4 KB; anything bigger is junk and is ignored unparsed. */
export const MAX_WALLET_JSON = 32_768;
const MAX_SOURCES = 16;
const DAY_MS = 86_400_000;
/** Permanent claims: every one-time (career) key is always kept; daily and weekly keys keep only the newest ones. */
const MAX_PERIOD_CLAIMS = 150;
const MAX_CLAIM_KEYS = 400;

export function emptyWallet(now = 0): WalletRecord {
  return { version: 1, spent: 0, owned: [], equipped: {}, earned: {}, daily: {}, receipts: [], updatedAt: now, ...(now > 0 ? { createdAt: now } : {}) };
}

const finiteInt = (value: unknown, max = MAX_TOTAL): number =>
  typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.min(max, Math.floor(value))) : 0;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** Ids a record may legitimately list as owned: known, priced, not hidden. Hidden items are never ownable. */
const ownable = (id: unknown): id is string => {
  if (typeof id !== 'string') return false;
  const entry = catalogEntry(id);
  return Boolean(entry && entry.price > 0 && !entry.hidden);
};

/** Parses stored JSON text defensively. Returns null for oversized, non-string or unparsable input. */
export function parseWalletJson(text: unknown): WalletRecord | null {
  if (typeof text !== 'string' || text.length > MAX_WALLET_JSON) return null;
  try { return normalizeWallet(JSON.parse(text)); } catch { return null; }
}

/**
 * Validates untrusted storage. Unknown, free and hidden items are dropped, lists and maps are bounded,
 * and `spent` is recomputed from the owned items (a stored number is never trusted).
 */
export function normalizeWallet(raw: unknown): WalletRecord {
  if (!raw || typeof raw !== 'object') return emptyWallet();
  const value = raw as Record<string, unknown>;
  const owned = Array.isArray(value.owned)
    ? [...new Set(value.owned.slice(0, 512).filter(ownable))]
    : [];
  const earned: Record<string, number> = {};
  if (value.earned && typeof value.earned === 'object') {
    for (const [key, amount] of Object.entries(value.earned as Record<string, unknown>).slice(0, MAX_SOURCES)) if (key.length <= 40) earned[key] = finiteInt(amount);
  }
  const daily: Record<string, { day: string; amount: number }> = {};
  if (value.daily && typeof value.daily === 'object') {
    for (const [key, entry] of Object.entries(value.daily as Record<string, unknown>).slice(0, MAX_SOURCES)) {
      const day = (entry as { day?: unknown })?.day, amount = (entry as { amount?: unknown })?.amount;
      if (key.length <= 40 && typeof day === 'string' && DAY.test(day)) daily[key] = { day, amount: finiteInt(amount) };
    }
  }
  const receipts = Array.isArray(value.receipts)
    ? value.receipts.filter((key): key is string => typeof key === 'string' && key.length <= 120).slice(-MAX_RECEIPTS)
    : [];
  const equipped = sanitizeLoadout(value.equipped);
  const createdAt = finiteInt(value.createdAt, Number.MAX_SAFE_INTEGER);
  const claims = Array.isArray(value.claims) ? trimClaims(value.claims.filter((key): key is string => typeof key === 'string' && key.length <= 120)) : [];
  const missions = value.missions && typeof value.missions === 'object' ? normalizeProgress(value.missions) : undefined;
  return {
    version: 1,
    spent: priceOf(owned),
    owned, equipped, earned, daily, receipts,
    updatedAt: finiteInt(value.updatedAt, Number.MAX_SAFE_INTEGER),
    ...(createdAt > 0 ? { createdAt } : {}),
    ...(claims.length ? { claims } : {}),
    ...(missions ? { missions } : {}),
  };
}

/** Keeps every career claim and the welcome gift claim (they must never be forgotten) and only the newest daily and weekly ones. */
export function trimClaims(keys: readonly string[]): string[] {
  const unique = [...new Set(keys)];
  const forever = (key: string): boolean => key.startsWith('missions:c:') || key.startsWith('welcome:');
  const career = unique.filter(forever);
  const rest = unique.filter(key => !forever(key)).slice(-MAX_PERIOD_CLAIMS);
  return [...career, ...rest].slice(-MAX_CLAIM_KEYS);
}

export function sumValues(values: Readonly<Record<string, number>>): number {
  let total = 0;
  for (const amount of Object.values(values)) total += Number.isFinite(amount) ? Math.max(0, amount) : 0;
  return total;
}

/** Total spent according to the purchase list (the only spent figure the economy believes). */
export function spentOf(record: Pick<WalletRecord, 'owned'>): number {
  return priceOf(record.owned);
}

export function balanceOf(record: WalletRecord, derived: Readonly<Record<string, number>>): number {
  return Math.floor(sumValues(derived) + sumValues(record.earned) - spentOf(record));
}

export function ownsItem(record: WalletRecord, id: string): boolean {
  const entry = catalogEntry(id);
  return Boolean(entry && !entry.hidden && (entry.price === 0 || record.owned.includes(id)));
}

/**
 * UTC calendar days from `createdAt` to `now`, inclusive: the number of daily caps a wallet of that age could have collected.
 * Unknown or future creation times count as one day (the strictest plausible value).
 */
export function allowanceDays(createdAt: number | null | undefined, now: number): number {
  if (typeof createdAt !== 'number' || !Number.isFinite(createdAt) || createdAt <= 0 || createdAt > now) return 1;
  return Math.floor(now / DAY_MS) - Math.floor(createdAt / DAY_MS) + 1;
}

/**
 * Caps accrued (client-claimed) earnings to what the daily caps allow for a wallet of this age.
 * `caps` maps an accrued source id to its daily cap; sources without a cap (platform verified) pass through.
 */
export function plausibleAccrued(earned: Readonly<Record<string, number>>, caps: Readonly<Record<string, number>>, createdAt: number | null | undefined, now: number, ceilings: Readonly<Record<string, number>> = {}): Record<string, number> {
  const days = allowanceDays(createdAt, now), out: Record<string, number> = {};
  for (const [id, amount] of Object.entries(earned)) {
    if (!Number.isFinite(amount) || amount <= 0) continue;
    const cap = caps[id], ceiling = ceilings[id];
    // A source with a lifetime ceiling (missions) is bounded by it; one with a daily cap by cap x days.
    if (ceiling !== undefined && Number.isFinite(ceiling)) out[id] = Math.min(Math.floor(amount), Math.max(0, Math.floor(ceiling)));
    else out[id] = cap === undefined || !Number.isFinite(cap) ? Math.floor(amount) : Math.min(Math.floor(amount), Math.floor(cap) * days);
  }
  return out;
}

/**
 * Ownership verification against a budget. `owned` is the append-only purchase list, oldest first: items stay
 * valid while their cumulative price fits the budget; the first item that does not fit, and everything after it,
 * is locked. Nothing is deleted, so a later (larger) budget unlocks them again.
 */
export function verifyOwned(owned: readonly string[], budget: number): { valid: string[]; locked: string[] } {
  const valid: string[] = [], locked: string[] = [];
  let spent = 0, over = false;
  for (const id of owned) {
    const price = catalogEntry(id)?.price ?? 0;
    if (!ownable(id)) continue;
    if (!over && Number.isFinite(budget) && spent + price <= budget) { spent += price; valid.push(id); }
    else { over = true; locked.push(id); }
  }
  return { valid, locked };
}

export type PurchaseCheck =
  | { readonly ok: true; readonly record: WalletRecord; readonly item: CatalogItem }
  | { readonly ok: false; readonly reason: 'unknown-item' | 'owned' | 'insufficient' | 'invalid' | 'unavailable'; readonly message: string };

/**
 * Validates and applies one purchase. Rejects non-string or unknown ids, hidden items, bad prices
 * (NaN, negative, non-integer), bad balances and owned items. The balance can never go below zero:
 * the price must fit inside it.
 */
export function applyPurchase(record: WalletRecord, itemId: unknown, balance: number, now: number): PurchaseCheck {
  if (typeof itemId !== 'string' || !itemId || itemId.length > 80) return { ok: false, reason: 'invalid', message: 'That is not a valid item.' };
  const entry = catalogEntry(itemId);
  if (!entry) return { ok: false, reason: 'unknown-item', message: 'That item is not in the shop.' };
  if (entry.hidden) return { ok: false, reason: 'unavailable', message: 'That item is not for sale.' };
  if (!Number.isSafeInteger(entry.price) || entry.price < 0) return { ok: false, reason: 'invalid', message: 'That item has no valid price.' };
  if (ownsItem(record, itemId)) return { ok: false, reason: 'owned', message: entry.price === 0 ? 'Already yours.' : 'Already in your garage.' };
  if (typeof balance !== 'number' || !Number.isFinite(balance) || balance < entry.price) {
    const short = Number.isFinite(balance) ? entry.price - Math.max(0, balance) : entry.price;
    return { ok: false, reason: 'insufficient', message: `You need ${Math.max(0, short).toLocaleString('en-US')} more Marks.` };
  }
  const owned = [...record.owned, entry.id];
  return { ok: true, item: entry, record: { ...record, spent: spentOf({ owned }), owned, updatedAt: now } };
}

export function applyEquip(record: WalletRecord, slot: CosmeticSlot, itemId: string | null, now: number, usable: (id: string) => boolean = id => ownsItem(record, id)): WalletRecord {
  const equipped = { ...record.equipped };
  if (itemId === null) delete equipped[slot];
  else {
    const entry = catalogItem(itemId);
    if (!entry || entry.slot !== slot || !usable(itemId)) return record;
    equipped[slot] = itemId;
  }
  return { ...record, equipped, updatedAt: now };
}

export type PlateEdit =
  | { readonly ok: true; readonly record: WalletRecord; readonly text: string }
  | { readonly ok: false; readonly reason: PlateReason | 'locked'; readonly message: string };

/**
 * Sets the custom plate text and fits the custom plate. Needs `plate-custom` to be usable (a verified purchase).
 * An empty text resets it to the default plate text. The text is validated here, never trusted from the caller.
 */
export function applyPlateText(record: WalletRecord, raw: unknown, now: number, usable: (id: string) => boolean = id => ownsItem(record, id)): PlateEdit {
  if (!usable(CUSTOM_PLATE_ID)) return { ok: false, reason: 'locked', message: 'Unlock the Custom Plate first.' };
  if (typeof raw === 'string' && !raw.trim()) {
    const { plateText: _dropped, ...rest } = record.equipped;
    return { ok: true, text: '', record: { ...record, equipped: { ...rest, plate: CUSTOM_PLATE_ID }, updatedAt: now } };
  }
  const check = validatePlateText(raw);
  if (!check.ok) return { ok: false, reason: check.reason!, message: check.message };
  return { ok: true, text: check.text, record: { ...record, equipped: { ...record.equipped, plate: CUSTOM_PLATE_ID, plateText: check.text }, updatedAt: now } };
}

export function utcDay(nowMs: number): string {
  return new Date(nowMs).toISOString().slice(0, 10);
}

export function grantedToday(record: WalletRecord, source: string, nowMs: number): number {
  const entry = record.daily[source];
  return entry && entry.day === utcDay(nowMs) ? entry.amount : 0;
}

/** Credits an accrued grant, enforcing idempotency and the source's daily cap. */
export interface GrantLimits {
  /** Largest single grant this source may make. */
  readonly maxGrant?: number;
  /** Most this source may have earned in the wallet's lifetime (missions). */
  readonly ceiling?: number;
}

export function applyGrant(record: WalletRecord, request: GrantRequest, dailyCap: number | undefined, nowMs: number, limits: GrantLimits = {}): { record: WalletRecord; result: GrantResult } {
  const key = `${request.source}:${request.key}`.slice(0, 120);
  if (record.receipts.includes(key) || record.claims?.includes(key)) return { record, result: { granted: 0, capped: false, duplicate: true } };
  const maxGrant = limits.maxGrant !== undefined && Number.isFinite(limits.maxGrant) ? Math.max(0, Math.floor(limits.maxGrant)) : MAX_GRANT;
  const asked = Math.min(finiteInt(request.amount, MAX_GRANT), maxGrant);
  const today = grantedToday(record, request.source, nowMs);
  let room = dailyCap === undefined || !Number.isFinite(dailyCap) ? asked : Math.max(0, Math.floor(dailyCap) - today);
  if (limits.ceiling !== undefined && Number.isFinite(limits.ceiling)) room = Math.min(room, Math.max(0, Math.floor(limits.ceiling) - (record.earned[request.source] ?? 0)));
  const granted = Math.min(asked, room);
  const capped = granted < asked;
  // A one-time reward that could not be paid yet (ceiling reached) is not consumed: it can be claimed again later.
  if (granted <= 0 && request.permanent) return { record, result: { granted: 0, capped: true, duplicate: false } };
  const receipts = [...record.receipts, key].slice(-MAX_RECEIPTS);
  const claims = request.permanent ? trimClaims([...(record.claims ?? []), key]) : record.claims;
  const withClaims = claims && claims.length ? { claims } : {};
  if (granted <= 0) return { record: { ...record, receipts, ...withClaims, updatedAt: nowMs }, result: { granted: 0, capped, duplicate: false } };
  return {
    record: {
      ...record,
      earned: { ...record.earned, [request.source]: (record.earned[request.source] ?? 0) + granted },
      daily: { ...record.daily, [request.source]: { day: utcDay(nowMs), amount: today + granted } },
      receipts, ...withClaims, updatedAt: nowMs,
    },
    result: { granted, capped, duplicate: false },
  };
}

/**
 * Conflict-free merge of two copies of the same player's wallet (local cache vs remote, two tabs).
 * `owned` is the union (a's order first, then b's new items), so no purchase is ever lost; `spent` is recomputed
 * from that union, never merged as a number, so a copy that "owns" items without paying can not hide the cost.
 * Monotonic fields take the max, the equipped loadout follows the newer write, createdAt takes the older time.
 */
export function mergeWallets(a: WalletRecord, b: WalletRecord): WalletRecord {
  const owned = [...new Set([...a.owned, ...b.owned])].filter(ownable);
  const earned: Record<string, number> = { ...a.earned };
  for (const [key, amount] of Object.entries(b.earned)) earned[key] = Math.max(earned[key] ?? 0, amount);
  const daily: Record<string, { day: string; amount: number }> = { ...a.daily };
  for (const [key, entry] of Object.entries(b.daily)) {
    const mine = daily[key];
    daily[key] = !mine || entry.day > mine.day ? entry : entry.day < mine.day ? mine : { day: mine.day, amount: Math.max(mine.amount, entry.amount) };
  }
  const receipts = [...new Set([...a.receipts, ...b.receipts])].slice(-MAX_RECEIPTS);
  const newer = b.updatedAt > a.updatedAt ? b : a;
  const times = [a.createdAt, b.createdAt].filter((t): t is number => typeof t === 'number' && t > 0);
  const claims = trimClaims([...(a.claims ?? []), ...(b.claims ?? [])]);
  const missions = a.missions && b.missions ? mergeProgress(a.missions, b.missions) : a.missions ?? b.missions;
  return {
    version: 1,
    spent: spentOf({ owned }),
    owned, earned, daily, receipts,
    equipped: newer.equipped,
    updatedAt: Math.max(a.updatedAt, b.updatedAt),
    ...(times.length ? { createdAt: Math.min(...times) } : {}),
    ...(claims.length ? { claims } : {}),
    ...(missions ? { missions } : {}),
  };
}

export function sameWallet(a: WalletRecord, b: WalletRecord): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
