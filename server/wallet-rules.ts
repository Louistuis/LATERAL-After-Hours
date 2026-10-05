/**
 * Server-side wallet rules. Pure functions: the judge of every `prev -> next` wallet transition, plus the
 * server-only credits (gifts, test grant). Shares the real catalog, mission catalog and wallet arithmetic with the
 * client by import (src/economy), so the rules cannot drift.
 *
 * Philosophy: reject, never repair. A record that is not exactly what the client engine would have produced is refused
 * with a reason code; the client then adopts the server's copy.
 */
import { catalogEntry, catalogItem, priceOf } from '../src/economy/catalog';
import { ALL_AVAILABLE, DAILY_SLOTS, WEEKLY_SLOTS, dailyFor, isAvailable, missionById, missionCeiling, weeklyFor, type MissionContext } from '../src/economy/mission-catalog';
import { dayIdOf, weekIdOf } from '../src/economy/mission-progress';
import { CUSTOM_PLATE_ID, validatePlateText } from '../src/economy/plate';
import { emptyWallet, MAX_RECEIPTS, MAX_WALLET_JSON, normalizeWallet, sumValues } from '../src/economy/wallet';
import { WELCOME_CLAIM, WELCOME_MARKS } from '../src/economy/welcome';
import { dailyChallengeCeiling } from '../src/economy/daily-challenge';
import { DAILY_MAX_MARKS, DAILY_TIERS, isDay } from '../src/events/daily';
import type { WalletRecord } from '../src/economy/types';
import { isRecord, jsonEqual } from './util';

/** The only earn sources in selfhost. `gift` and `testgrant` are written by the server alone. */
export const CLIENT_SOURCES = ['welcome', 'missions', 'daily'] as const;
export const SERVER_SOURCES = ['gift', 'testgrant'] as const;
export const ALL_SOURCES: readonly string[] = [...CLIENT_SOURCES, ...SERVER_SOURCES];
export const TESTGRANT_CLAIM = 'testgrant:test:grant';
export { MAX_WALLET_JSON };

const DAY_MS = 86_400_000;
/** After a UTC midnight (or Monday) the previous period is still accepted for this long (client clock skew, slow saves). */
export const PERIOD_GRACE_MS = 10 * 60_000;
const FUTURE_SKEW_MS = 10 * 60_000;
const TOP_KEYS = new Set(['version', 'spent', 'owned', 'equipped', 'earned', 'daily', 'receipts', 'updatedAt', 'createdAt', 'missions', 'claims']);

export interface RulesContext {
  readonly now: number;
  /** 'import': the account has no accepted client write yet (first write, or local progress arriving after a gift). */
  readonly mode: 'import' | 'steady';
  /** The earliest moment any wallet could legitimately exist (release of the selfhost build). */
  readonly launchAt: number;
  /** Server-side creation time of the wallet row (now for a brand new wallet). */
  readonly serverCreatedAt: number;
  /** Marks already earned from missions and the daily challenge in the last hour (ledger). */
  readonly hourlyEarned: number;
  readonly hourlyLimit: number;
}
export interface LedgerLine { readonly kind: string; readonly amount: number; readonly ref: string }
export type Reject = { readonly ok: false; readonly reason: string; readonly detail?: string; readonly flag?: boolean };
export type Accepted = { readonly ok: true; readonly record: WalletRecord; readonly unchanged: boolean; readonly ledger: readonly LedgerLine[] };

const bad = (reason: string, detail?: string, flag = false): Reject => ({ ok: false, reason, ...(detail ? { detail } : {}), ...(flag ? { flag: true } : {}) });

/* ------------------------------------------------------------------ periods and mission keys */

/** Day ids accepted for a period key right now: today, plus yesterday inside the grace window after midnight. */
export function dayCandidates(now: number): string[] {
  const out = [dayIdOf(now)];
  if (now % DAY_MS < PERIOD_GRACE_MS) out.push(dayIdOf(now - DAY_MS));
  return out;
}
export function weekCandidates(now: number): number[] {
  const week = weekIdOf(now);
  return weekIdOf(now - PERIOD_GRACE_MS) !== week ? [week, week - 1] : [week];
}

/** Mission contexts the server accepts a key for (the client may or may not offer online / every route). Reward amounts never depend on it. */
const SIX = ALL_AVAILABLE.routes;
const THREE = ['HW-01', 'RP-01', 'CL-01'];
const CONTEXTS: readonly MissionContext[] = [true, false].flatMap(online => [SIX, THREE, ['HW-01', 'RP-01']].map(routes => ({ routes, online, rival: true, cars: true })));
const dailyIds = new Map<string, Set<string>>();
const weeklyIds = new Map<number, Set<string>>();
function dailySet(day: string): Set<string> {
  let set = dailyIds.get(day);
  if (!set) {
    set = new Set(CONTEXTS.flatMap(ctx => dailyFor(day, ctx).map(m => m.id)));
    if (dailyIds.size > 400) dailyIds.clear();
    dailyIds.set(day, set);
  }
  return set;
}
function weeklySet(week: number): Set<string> {
  let set = weeklyIds.get(week);
  if (!set) {
    set = new Set(CONTEXTS.flatMap(ctx => weeklyFor(week, ctx).map(m => m.id)));
    if (weeklyIds.size > 400) weeklyIds.clear();
    weeklyIds.set(week, set);
  }
  return set;
}

type Parsed =
  | { kind: 'mission'; period: 'career' | 'day' | 'week'; id: string; day?: string; week?: number; reward: number }
  | { kind: 'welcome' }
  | { kind: 'daily'; day: string; tier: string; marks: number }
  | { kind: 'server' }
  | { kind: 'unknown' };

/** Classifies a claim or receipt key and (for missions) checks it against the catalog and the allowed periods. `periodOk` decides which days and weeks count. */
export function parseKey(key: string, periodOk: { day(day: string): boolean; week(week: number): boolean }): Parsed | { kind: 'invalid'; why: string } {
  if (key === WELCOME_CLAIM) return { kind: 'welcome' };
  if (key.startsWith('gift:') || key === TESTGRANT_CLAIM) return { kind: 'server' };
  const parts = key.split(':');
  if (parts[0] === 'missions') {
    if (parts[1] === 'c' && parts.length === 3) {
      const def = missionById(parts[2]!);
      if (!def || def.kind !== 'career' || !isAvailable(def, ALL_AVAILABLE)) return { kind: 'invalid', why: 'unknown-mission' };
      return { kind: 'mission', period: 'career', id: def.id, reward: def.reward };
    }
    if (parts[1] === 'd' && parts.length === 4) {
      const day = parts[2]!;
      if (!isDay(day)) return { kind: 'invalid', why: 'bad-day' };
      if (!periodOk.day(day)) return { kind: 'invalid', why: 'period-closed' };
      const def = missionById(parts[3]!);
      if (!def || def.kind !== 'daily' || !dailySet(day).has(def.id)) return { kind: 'invalid', why: 'not-in-rotation' };
      return { kind: 'mission', period: 'day', id: def.id, day, reward: def.reward };
    }
    if (parts[1] === 'w' && parts.length === 4) {
      const week = Number(parts[2]);
      if (!Number.isSafeInteger(week) || week < 0 || String(week) !== parts[2]) return { kind: 'invalid', why: 'bad-week' };
      if (!periodOk.week(week)) return { kind: 'invalid', why: 'period-closed' };
      const def = missionById(parts[3]!);
      if (!def || def.kind !== 'weekly' || !weeklySet(week).has(def.id)) return { kind: 'invalid', why: 'not-in-rotation' };
      return { kind: 'mission', period: 'week', id: def.id, week, reward: def.reward };
    }
    return { kind: 'invalid', why: 'bad-key' };
  }
  if (parts[0] === 'daily' && parts.length === 3) {
    const tier = DAILY_TIERS.find(t => t.id === parts[2]);
    if (!tier || !isDay(parts[1]!)) return { kind: 'invalid', why: 'bad-key' };
    if (!periodOk.day(parts[1]!)) return { kind: 'invalid', why: 'period-closed' };
    return { kind: 'daily', day: parts[1]!, tier: tier.id, marks: tier.marks };
  }
  return { kind: 'unknown' };
}

/** Keys that must never be forgotten (permanent claims) or are still redeemable right now. */
function isLive(key: string, now: number): boolean {
  if (key.startsWith('missions:c:') || key.startsWith('welcome:')) return true;
  const parts = key.split(':');
  if (parts[0] === 'missions' && parts[1] === 'd') return dayCandidates(now).includes(parts[2] ?? '');
  if (parts[0] === 'missions' && parts[1] === 'w') return weekCandidates(now).includes(Number(parts[2]));
  if (parts[0] === 'daily') return dayCandidates(now).includes(parts[1] ?? '');
  return false;
}

/* ------------------------------------------------------------------ the validator */

const earnedOf = (r: WalletRecord, s: string): number => r.earned[s] ?? 0;

/**
 * Validates `raw` as the next wallet record after `prev` (null = the account has no wallet yet).
 * Pure: no clock, no I/O; everything comes from `ctx`.
 */
export function validateTransition(prev: WalletRecord | null, raw: unknown, ctx: RulesContext): Reject | Accepted {
  const now = ctx.now;
  if (!isRecord(raw)) return bad('bad-shape', 'record is not an object');
  let text: string;
  try { text = JSON.stringify(raw); } catch { return bad('bad-shape', 'not json'); }
  if (text.length > MAX_WALLET_JSON) return bad('too-large');
  for (const key of Object.keys(raw)) if (!TOP_KEYS.has(key)) return bad('bad-shape', `unknown key ${key.slice(0, 20)}`);
  if (raw.version !== 1) return bad('bad-shape', 'version');
  const input: Record<string, unknown> = { ...raw };
  if (Array.isArray(input.claims) && input.claims.length === 0) delete input.claims;

  // Explicit checks first, for useful reason codes; the structural equality below is the catch-all.
  if (!Array.isArray(input.owned) || input.owned.length > 512) return bad('bad-shape', 'owned');
  const seenOwned = new Set<string>();
  for (const id of input.owned) {
    if (typeof id !== 'string') return bad('bad-shape', 'owned entry');
    const entry = catalogEntry(id);
    if (!entry || entry.hidden) return bad('unknown-item', id.slice(0, 40));
    if (entry.price <= 0) return bad('unknown-item', 'stock items are never listed');
    if (seenOwned.has(id)) return bad('bad-shape', 'duplicate owned');
    seenOwned.add(id);
  }
  if (input.spent !== priceOf(input.owned as string[])) return bad('spent-mismatch');
  if (!isRecord(input.earned)) return bad('bad-shape', 'earned');
  for (const [source, amount] of Object.entries(input.earned)) {
    if (!ALL_SOURCES.includes(source)) return bad('earned-source-unknown', source.slice(0, 20));
    if (typeof amount !== 'number' || !Number.isSafeInteger(amount) || amount < 0) return bad('bad-shape', 'earned amount');
  }
  const norm = normalizeWallet(input);
  if (!jsonEqual(norm, input)) return bad('bad-shape', 'record is not canonical');
  if (norm.updatedAt > now + FUTURE_SKEW_MS) return bad('bad-shape', 'updatedAt in the future');

  const base: WalletRecord = prev ?? emptyWallet(0);
  const imp = ctx.mode === 'import';

  // createdAt: set once, bounded by the launch date, never later.
  if (norm.createdAt !== undefined) {
    if (norm.createdAt < ctx.launchAt || norm.createdAt > now + FUTURE_SKEW_MS) return bad('created-at-invalid');
  }
  if (base.createdAt !== undefined) {
    if (norm.createdAt === undefined || (imp ? norm.createdAt > base.createdAt : norm.createdAt !== base.createdAt)) return bad('created-at-invalid', 'changed');
  } else if (!imp && norm.createdAt !== undefined) return bad('created-at-invalid', 'changed');

  // Owned only grows; spent follows from it (spent = sum of prices, checked by the canonical form).
  const prevOwned = new Set(base.owned);
  for (const id of base.owned) if (!seenOwned.has(id)) return bad('owned-removed', id.slice(0, 40));
  const added = norm.owned.filter(id => !prevOwned.has(id));
  if (norm.spent - base.spent !== priceOf(added)) return bad('spent-mismatch');

  // Earned sources.
  for (const source of SERVER_SOURCES) {
    if (earnedOf(norm, source) !== earnedOf(base, source)) return bad('server-only-source', source);
  }
  for (const source of ALL_SOURCES) if (earnedOf(norm, source) < earnedOf(base, source)) return bad('earned-decreased', source);

  // Claim and receipt keys.
  const paid = new Set([...(base.claims ?? []), ...base.receipts]);
  const nextKeys = new Set([...(norm.claims ?? []), ...norm.receipts]);
  const nextClaims = new Set(norm.claims ?? []);
  if (new Set(norm.receipts).size !== norm.receipts.length) return bad('receipts-invalid', 'duplicate');
  for (const key of paid) if (!nextKeys.has(key) && isLive(key, now)) return bad('claims-removed', key.slice(0, 60));
  for (const key of base.claims ?? []) if ((key.startsWith('missions:c:') || key.startsWith('welcome:')) && !nextClaims.has(key)) return bad('claims-removed', key.slice(0, 60));
  const fresh = [...nextKeys].filter(key => !paid.has(key));

  const today = dayCandidates(now);
  const launchDay = dayIdOf(ctx.launchAt), launchWeek = weekIdOf(ctx.launchAt), thisWeek = weekCandidates(now);
  const maxWeek = Math.max(...thisWeek);
  const periodOk = imp
    ? { day: (d: string) => d >= launchDay && d <= today[0]!, week: (w: number) => w >= launchWeek && w <= maxWeek }
    : { day: (d: string) => today.includes(d), week: (w: number) => thisWeek.includes(w) };

  let missionsDelta = 0, dailyDelta = 0, welcomeKey = false;
  const missionKeys: string[] = [], dailyKeys: string[] = [];
  const perDay = new Map<string, number>(), perWeek = new Map<number, number>();
  for (const key of (norm.claims ?? [])) {
    const p = parseKey(key, { day: () => true, week: () => true });
    if (p.kind === 'mission' && p.period === 'day') perDay.set(p.day!, (perDay.get(p.day!) ?? 0) + 1);
    if (p.kind === 'mission' && p.period === 'week') perWeek.set(p.week!, (perWeek.get(p.week!) ?? 0) + 1);
  }
  for (const key of fresh) {
    const parsed = parseKey(key, periodOk);
    if (parsed.kind === 'invalid') return bad(key.startsWith('daily:') ? 'daily-invalid' : 'mission-claim-invalid', `${parsed.why}: ${key.slice(0, 60)}`);
    if (parsed.kind === 'unknown') return bad('receipts-invalid', key.slice(0, 60));
    if (parsed.kind === 'server') return bad('server-only-source', key.slice(0, 40));
    if (parsed.kind === 'welcome') { welcomeKey = true; continue; }
    if (parsed.kind === 'daily') { dailyDelta += parsed.marks; dailyKeys.push(key); continue; }
    if (!nextClaims.has(key)) return bad('mission-claim-invalid', 'mission keys must be permanent claims');
    missionsDelta += parsed.reward;
    missionKeys.push(key);
  }
  for (const n of perDay.values()) if (n > DAILY_SLOTS) return bad('mission-claim-invalid', 'too many daily missions in one day');
  for (const n of perWeek.values()) if (n > WEEKLY_SLOTS) return bad('mission-claim-invalid', 'too many weekly missions in one week');

  // Welcome: exactly 1500, once, with its claim.
  const welcomeDelta = earnedOf(norm, 'welcome') - earnedOf(base, 'welcome');
  if (welcomeDelta !== 0 && welcomeDelta !== WELCOME_MARKS) return bad('welcome-invalid', 'amount');
  if ((welcomeDelta === WELCOME_MARKS) !== welcomeKey) return bad('welcome-invalid', 'claim');
  if (welcomeDelta === WELCOME_MARKS && earnedOf(base, 'welcome') !== 0) return bad('welcome-invalid', 'twice');

  const missionsGot = earnedOf(norm, 'missions') - earnedOf(base, 'missions');
  const dailyGot = earnedOf(norm, 'daily') - earnedOf(base, 'daily');
  const basis = Math.max(norm.createdAt ?? base.createdAt ?? ctx.serverCreatedAt, ctx.launchAt);
  if (imp) {
    // Local progress arriving once: bounded by what the release date allows, not reconstructed key by key.
    if (earnedOf(norm, 'missions') > missionCeiling(basis, now)) return bad('mission-claim-invalid', 'above the plausible ceiling', true);
    if (earnedOf(norm, 'daily') > dailyChallengeCeiling(basis, now)) return bad('daily-invalid', 'above the plausible ceiling', true);
  } else {
    if (missionsGot !== missionsDelta) return bad('mission-reward-mismatch', `${missionsGot} vs ${missionsDelta}`, missionsGot > missionsDelta);
    if (dailyGot !== dailyDelta) return bad('daily-invalid', `${dailyGot} vs ${dailyDelta}`, dailyGot > dailyDelta);
    if (earnedOf(norm, 'missions') > missionCeiling(basis, now)) return bad('mission-claim-invalid', 'above the plausible ceiling', true);
    if (earnedOf(norm, 'daily') > dailyChallengeCeiling(basis, now)) return bad('daily-invalid', 'above the plausible ceiling', true);
    // At most the full daily table per UTC day (each tier once, so this holds by construction; belt and braces).
    const byDay = new Map<string, number>();
    for (const key of dailyKeys) { const [, day, tier] = key.split(':'); byDay.set(day!, (byDay.get(day!) ?? 0) + (DAILY_TIERS.find(t => t.id === tier)?.marks ?? 0)); }
    for (const total of byDay.values()) if (total > DAILY_MAX_MARKS) return bad('daily-invalid', 'daily cap');
    if (ctx.hourlyEarned + missionsGot + dailyGot > ctx.hourlyLimit) return bad('rate-hour', `${ctx.hourlyEarned + missionsGot + dailyGot} Marks in an hour`, true);
  }

  // The per-source "granted today" tallies are the client's own cap bookkeeping.
  for (const [source, entry] of Object.entries(norm.daily)) {
    if (!ALL_SOURCES.includes(source) || entry.amount > earnedOf(norm, source) || entry.day > today[0]!) return bad('daily-invalid', 'tally');
  }

  // Equipped items must be owned (or stock) and in their own slot.
  for (const [slot, id] of Object.entries(norm.equipped)) {
    if (slot === 'plateText') {
      const check = validatePlateText(id);
      if (!check.ok || check.text !== id || !seenOwned.has(CUSTOM_PLATE_ID)) return bad('equipped-not-owned', 'plate text');
      continue;
    }
    const item = catalogItem(id as string);
    if (!item || item.slot !== slot) return bad('equipped-not-owned', slot);
    if (item.price > 0 && !seenOwned.has(item.id)) return bad('equipped-not-owned', item.id);
  }

  // Balance never negative.
  const earnedTotal = sumValues(norm.earned);
  if (earnedTotal - norm.spent < 0) return bad('negative-balance', `${earnedTotal - norm.spent}`);

  // Nothing but the timestamp changed: accepted, but not a new version.
  const unchanged = prev !== null && jsonEqual({ ...norm, updatedAt: 0 }, { ...prev, updatedAt: 0 });
  const ledger: LedgerLine[] = [];
  const ref = (keys: readonly string[]): string => (imp ? 'import' : keys.join(',')).slice(0, 200);
  if (welcomeDelta > 0) ledger.push({ kind: 'earn:welcome', amount: welcomeDelta, ref: imp ? 'import' : WELCOME_CLAIM });
  if (missionsGot > 0) ledger.push({ kind: 'earn:missions', amount: missionsGot, ref: ref(missionKeys) });
  if (dailyGot > 0) ledger.push({ kind: 'earn:daily', amount: dailyGot, ref: ref(dailyKeys) });
  for (const id of added) ledger.push({ kind: `spend:${id}`, amount: -(catalogEntry(id)?.price ?? 0), ref: '' });
  return { ok: true, record: norm, unchanged, ledger };
}

/* ------------------------------------------------------------------ server-only credits */

export interface CreditResult {
  readonly record: WalletRecord;
  /** Items newly added to the garage. */
  readonly gained: readonly string[];
  /** Items the player already owned (they convert to nothing). */
  readonly skipped: readonly string[];
  readonly ledger: readonly LedgerLine[];
}

function addReceipt(record: WalletRecord, key: string): WalletRecord {
  const receipts = record.receipts.includes(key) ? record.receipts : [...record.receipts, key].slice(-MAX_RECEIPTS);
  return { ...record, receipts };
}

/**
 * Credits a gift: `earned.gift` grows by the Marks plus the catalog price of every newly owned item (so a gifted item
 * leaves the balance untouched: the client computes balance = earned - sum of owned prices), and the items are appended to `owned`.
 */
export function applyGift(record: WalletRecord, gift: { id: string; marks: number; items: readonly string[] }, now: number): CreditResult {
  const owned = new Set(record.owned);
  const gained: string[] = [], skipped: string[] = [];
  for (const id of gift.items) {
    const entry = catalogEntry(id);
    if (!entry || entry.hidden || entry.price <= 0 || owned.has(id) || gained.includes(id)) { skipped.push(id); continue; }
    gained.push(id);
  }
  const itemValue = priceOf(gained);
  const nextOwned = [...record.owned, ...gained];
  const amount = gift.marks + itemValue;
  let next: WalletRecord = {
    ...record,
    owned: nextOwned,
    spent: priceOf(nextOwned),
    earned: amount > 0 ? { ...record.earned, gift: earnedOf(record, 'gift') + amount } : record.earned,
    updatedAt: now,
  };
  next = addReceipt(next, `gift:${gift.id}`);
  const ledger: LedgerLine[] = [];
  if (gift.marks > 0) ledger.push({ kind: `gift:${gift.id}`, amount: gift.marks, ref: 'marks' });
  for (const id of gained) ledger.push({ kind: `gift:${gift.id}`, amount: catalogEntry(id)?.price ?? 0, ref: `item:${id}` });
  return { record: next, gained, skipped, ledger };
}

export function applyTestGrant(record: WalletRecord, marks: number, now: number): CreditResult {
  const claims = [...new Set([...(record.claims ?? []), TESTGRANT_CLAIM])];
  const next = addReceipt({ ...record, earned: { ...record.earned, testgrant: earnedOf(record, 'testgrant') + marks }, claims, updatedAt: now }, TESTGRANT_CLAIM);
  return { record: next, gained: [], skipped: [], ledger: [{ kind: 'earn:testgrant', amount: marks, ref: 'test:grant' }] };
}
