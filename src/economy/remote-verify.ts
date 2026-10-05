/**
 * Verifies what OTHER players may show on their cars. A client controls its own presence paint string and its own
 * wallet record, so neither is believed on its own. What a client can NOT forge:
 *   - websim tip comments (author ids and credits_spent are set by websim, read through the comments API);
 *   - websim's record metadata on the wallet row: its `username` and `created_at` are set server-side.
 * A player's items are shown only if their verified budget could have paid for them:
 *
 *   budget = Marks from that user's tip comments + WELCOME_MARKS (the one-time welcome gift)
 *            + GAMEPLAY_DAILY_CAP x (UTC days since their wallet row was created)
 *   shown  = their wallet's purchase list, oldest first, while the cumulative price fits the budget
 *
 * Anything else renders as stock (and an unowned car as the starter car). Until verification has run, premium looks
 * are never shown (fail closed). One shared tip index covers every player, is cached, and is fetched at most once per
 * `minFetchGapMs`, so a room full of players (or a presence flood) can not hammer the API.
 */
import type { CarId } from '../../contracts/runtime-contracts';
import { STARTER_CAR } from '../vehicle/starter-car';
import { carItem, catalogItem, decodeLoadout, encodeLoadout, priceOf } from './catalog';
import { CUSTOM_PLATE_ID } from './plate';
import { CREATOR_GRANT_MARKS, LATERAL_CREATOR_USERNAME } from './creator';
import { GAMEPLAY_DAILY_CAP } from './gameplay';
import { fetchTipIndex, TIP_MAX_PAGES, type JsonFetcher, type TipIndex } from './tips';
import type { Loadout } from './types';
import { missionCeiling } from './mission-catalog';
import { WELCOME_MARKS } from './welcome';
import { dailyChallengeCeiling } from './daily-challenge';
import { allowanceDays, parseWalletJson, verifyOwned } from './wallet';

export interface RemoteWalletRow { readonly username?: unknown; readonly created_at?: unknown; readonly w?: unknown }

export interface RemoteVerifierOptions {
  readonly fetchJson: JsonFetcher;
  /** The websim project id, or null while unknown (premium looks stay hidden). */
  readonly projectId: () => string | null;
  /** Every wallet row in the `lateral_wallet_v1` collection (all users). */
  readonly wallets: () => readonly RemoteWalletRow[];
  readonly creatorId?: string | null;
  /** The creator's server-set websim username; that user's budget includes the creator grant. Default: LATERAL_CREATOR_USERNAME. */
  readonly creatorUsername?: string | null;
  readonly now?: () => number;
  /** Minimum time between two tip index fetch attempts. Default 45 s. */
  readonly minFetchGapMs?: number;
  /** Most the missions could have paid a wallet created at `createdAt` (default: missionCeiling). Tests pass () => 0 to isolate the other sources. */
  readonly missionAllowance?: (createdAt: number | null, now: number) => number;
  /** The welcome gift every wallet gets once (default WELCOME_MARKS, part of every player budget). Tests pass 0 to isolate the other sources. */
  readonly welcomeAllowance?: number;
  /** How long a fetched tip index is trusted before a refresh is allowed. Default 5 minutes. */
  readonly maxAgeMs?: number;
  readonly pageCap?: number;
}

export interface RemoteLook { readonly car: CarId; readonly paint: string }

export interface RemoteVerifier {
  /** What this client may draw for `username` who announced `car` and the presence paint string `paint`. Synchronous and cached. */
  look(username: string, car: CarId, paint: string): RemoteLook;
  /** The item ids of this user that verification currently allows (stock items are implicit), or null while unknown. */
  allowed(username: string): ReadonlySet<string> | null;
  /** Forces a tip index refresh (still rate limited). */
  refresh(): Promise<void>;
  /** Re-evaluate everything (the wallet collection changed). Notifies subscribers. */
  invalidate(): void;
  subscribe(listener: () => void): () => void;
  dispose(): void;
}

/** The slot entries of a loadout (plateText is not a slot and is handled separately). */
const slotsOf = (loadout: Loadout): [keyof Loadout, string][] =>
  (Object.entries(loadout) as [keyof Loadout, string][]).filter(([slot]) => slot !== 'plateText');

const STOCK_LOADOUT: Loadout = { paint: 'harbor-slate', wheelStyle: 'forged' };
const MAX_USERNAME = 64;

/** Plain stock paint ids from older clients and "~..." loadout strings both reduce to a Loadout of known ids. */
export function parsePresencePaint(paint: unknown): Loadout {
  if (typeof paint !== 'string' || paint.length > 200) return {};
  if (paint.startsWith('~')) return decodeLoadout(paint) ?? {};
  const entry = catalogItem(paint);
  return entry && entry.slot === 'paint' ? { paint: entry.id } : {};
}

export function createRemoteVerifier(options: RemoteVerifierOptions): RemoteVerifier {
  const now = options.now ?? (() => Date.now());
  const minGap = options.minFetchGapMs ?? 45_000;
  const maxAge = options.maxAgeMs ?? 5 * 60_000;
  const creatorLower = options.creatorUsername === null ? null : (options.creatorUsername ?? LATERAL_CREATOR_USERNAME).toLowerCase();
  const listeners = new Set<() => void>();
  let index: TipIndex | null = null, indexAt = -Infinity, lastAttempt = -Infinity, inflight: Promise<void> | null = null, disposed = false;
  let version = 0;
  const memo = new Map<string, { key: string; allowed: ReadonlySet<string> }>();
  const emit = (): void => { for (const listener of listeners) { try { listener(); } catch { /* A bad listener must not stop the rest. */ } } };

  const refresh = (): Promise<void> => {
    if (disposed) return Promise.resolve();
    if (inflight) return inflight;
    const project = options.projectId();
    const at = now();
    if (!project || at - lastAttempt < minGap) return Promise.resolve();
    if (index && at - indexAt < maxAge) return Promise.resolve();
    lastAttempt = at;
    inflight = (async () => {
      try {
        const next = await fetchTipIndex(options.fetchJson, project, options.pageCap ?? TIP_MAX_PAGES, { creatorId: options.creatorId ?? null });
        // A read that failed outright is not an answer: keep the previous index and try again after the gap.
        if (!next.complete && next.byId.size === 0) return;
        index = next; indexAt = now(); version++;
        emit();
      } catch { /* Stay fail closed; the next look() after the gap retries. */ }
    })().finally(() => { inflight = null; });
    return inflight;
  };

  const allowedFor = (username: string): ReadonlySet<string> | null => {
    if (!index) return null;
    const lower = username.toLowerCase();
    const rows = options.wallets().filter(row => typeof row.username === 'string' && row.username.length <= MAX_USERNAME && row.username.toLowerCase() === lower)
      .map(row => ({ w: typeof row.w === 'string' ? row.w : '', created: typeof row.created_at === 'string' ? Date.parse(row.created_at) : Number.NaN }))
      .sort((a, b) => (Number.isFinite(a.created) ? a.created : Infinity) - (Number.isFinite(b.created) ? b.created : Infinity));
    const key = `${version}|${rows.map(row => `${row.created}:${row.w}`).join('#')}`;
    const cached = memo.get(lower);
    if (cached && cached.key === key) return cached.allowed;
    const owned: string[] = [];
    for (const row of rows) {
      const wallet = parseWalletJson(row.w);
      if (wallet) for (const id of wallet.owned) if (!owned.includes(id)) owned.push(id);
    }
    const created = rows.map(row => row.created).filter(Number.isFinite);
    const earliest = created.length ? Math.min(...created) : null;
    // created_at is set by websim when the row is created; without it only one day of driving is plausible.
    const grant = creatorLower !== null && lower === creatorLower ? CREATOR_GRANT_MARKS : 0;
    // Missions: the most they could ever have paid a wallet of this age (career once, daily and weekly maximums per period).
    // Welcome gift: every wallet is paid it once, so every budget includes it.
    const welcome = options.welcomeAllowance ?? WELCOME_MARKS;
    const budget = (index.byName.get(lower)?.marks ?? 0) + grant + welcome + GAMEPLAY_DAILY_CAP * allowanceDays(earliest, now()) + (options.missionAllowance ?? missionCeiling)(earliest, now())
      // Daily challenge: at most one full daily (all tiers) per UTC day of wallet age.
      + dailyChallengeCeiling(earliest, now());
    const allowed = new Set(verifyOwned(owned, budget).valid);
    if (memo.size > 256) memo.clear();
    memo.set(lower, { key, allowed });
    return allowed;
  };

  const stockLook = (wanted: Loadout): RemoteLook => {
    const kept: Loadout = { ...STOCK_LOADOUT };
    for (const [slot, id] of slotsOf(wanted)) if (priceOf([id]) === 0) kept[slot] = id;
    return { car: STARTER_CAR, paint: encodeLoadout(kept) };
  };

  return {
    look(username, car, paint) {
      const wanted = parsePresencePaint(paint);
      const carEntry = carItem(car);
      const premiumItems = Object.values(wanted).filter(id => priceOf([id]) > 0);
      const needsCheck = premiumItems.length > 0 || Boolean(carEntry && carEntry.price > 0) || !carEntry;
      if (!needsCheck) {
        const kept: Loadout = { ...STOCK_LOADOUT };
        for (const [slot, id] of slotsOf(wanted)) kept[slot] = id;
        return { car: carEntry ? car : STARTER_CAR, paint: encodeLoadout(kept) };
      }
      void refresh();
      const name = typeof username === 'string' ? username : '';
      const allowed = name && name.length <= MAX_USERNAME ? allowedFor(name) : null;
      if (!allowed) return stockLook(wanted);
      const shown: Loadout = { ...STOCK_LOADOUT };
      for (const [slot, id] of slotsOf(wanted)) if (priceOf([id]) === 0 || allowed.has(id)) shown[slot] = id;
      // Custom plate text is shown only when the custom plate itself was verified for this player (could they afford it).
      if (shown.plate === CUSTOM_PLATE_ID && wanted.plateText) shown.plateText = wanted.plateText;
      const showCar = carEntry && (carEntry.price === 0 || allowed.has(carEntry.id)) ? car : STARTER_CAR;
      return { car: showCar, paint: encodeLoadout(shown) };
    },
    allowed: allowedFor,
    refresh,
    invalidate() { version++; if (!disposed) emit(); },
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    dispose() { disposed = true; listeners.clear(); memo.clear(); },
  };
}
