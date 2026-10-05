/**
 * LATERAL economy contracts (stable). Platform-neutral: the wallet, catalog, shop and cosmetics never know
 * which platform they run on. Platforms differ only in the EarnSource adapters and the WalletStore chosen at
 * boot (see ./boot.ts):
 *   websim            tipSource (verified from project comments) + gameplaySource (capped), websim collection store
 *   poki / crazygames rewardedAdSource + missionSource (+ optional gameplaySource), local or platform data store
 *
 * Currency: "Marks" (integer). Every amount in these interfaces is in Marks unless the name says otherwise.
 * Keep this file additive: new optional members only, never rename or narrow existing ones.
 */
import type { CarId, RunResult } from '../../contracts/runtime-contracts';
import type { MissionProgress } from './mission-progress';

export const CURRENCY = { name: 'Marks', short: 'M', singular: 'Mark' } as const;

/* ------------------------------------------------------------------ catalog */

/** A cosmetic slot. Each slot holds at most one equipped item. */
/** A cosmetic slot. Each slot holds at most one equipped item. Cars are CarItems with slot 'car' (selected in the garage, never in a Loadout). */
export type CosmeticSlot = 'paint' | 'wheelStyle' | 'rim' | 'underglow' | 'smoke' | 'plate' | 'horn';
export type Rarity = 'stock' | 'standard' | 'rare' | 'epic' | 'legendary';

export interface CosmeticItem {
  readonly id: string;
  readonly slot: CosmeticSlot;
  readonly name: string;
  /** One line of shop copy. No em dashes. */
  readonly blurb: string;
  readonly rarity: Rarity;
  /** Marks. 0 = included with the game (always owned). */
  readonly price: number;
  /** CSS colours for the swatch chip, 1 to 3 stops. */
  readonly swatch: readonly string[];
  /** Finish family for paints and rims, used by the renderer. */
  readonly finish?: 'gloss' | 'metallic' | 'pearl' | 'chameleon' | 'matte' | 'chrome' | 'candy' | 'satin';
  /** Item kind. Absent = 'cosmetic'. */
  readonly kind?: 'cosmetic';
  /** True = not shown and not purchasable. */
  readonly hidden?: boolean;
}

/** What an item is. Cosmetics fill a loadout slot; cars are selected in the garage instead. */
export type ItemKind = 'cosmetic' | 'car';

/** A purchasable car. Same id space and wallet as cosmetics (see catalogEntry and CAR_CATALOG in ./catalog). */
export interface CarItem {
  readonly id: string;
  readonly kind: 'car';
  readonly slot: 'car';
  /** The roster id this item unlocks. */
  readonly carId: CarId;
  readonly name: string;
  readonly blurb: string;
  readonly rarity: Rarity;
  /** Marks. 0 = the starter car (always owned). */
  readonly price: number;
  readonly swatch: readonly string[];
  /** True = not shown and not purchasable. */
  readonly hidden?: boolean;
}
/** Anything purchasable: a cosmetic or a car. Narrow on `kind`. */
export type CatalogItem = CosmeticItem | CarItem;

/** Equipped item id per slot. Missing slot = stock. */
export type Loadout = Partial<Record<CosmeticSlot, string>> & {
  /** Text of the `plate-custom` plate (validated, see plate.ts). Only drawn while plate is 'plate-custom'. Not a slot. */
  plateText?: string;
};

/* ------------------------------------------------------------------ wallet */

/** Persisted per-user wallet state. Derived (verified) earnings are NOT stored here; they are recomputed. */
export interface WalletRecord {
  readonly version: 1;
  /** Total Marks ever spent. Never decreases. */
  readonly spent: number;
  /** Purchased item ids (stock items are implicitly owned and never listed). */
  readonly owned: readonly string[];
  readonly equipped: Loadout;
  /** Lifetime Marks granted by each accrued source id (gameplay, rewarded-ad, missions, ...). */
  readonly earned: Readonly<Record<string, number>>;
  /** Per accrued source: Marks granted on `day` (UTC YYYY-MM-DD), for daily caps. */
  readonly daily: Readonly<Record<string, { readonly day: string; readonly amount: number }>>;
  /** Recent grant idempotency keys (bounded, newest last). A key is only ever paid once. */
  readonly receipts: readonly string[];
  /** ms since epoch of the last write. */
  readonly updatedAt: number;
  /** ms since epoch the wallet was first created (optional; older records lack it). Bounds the plausible gameplay allowance. */
  readonly createdAt?: number;
  /** Mission progress (src/economy/mission-progress.ts). Bounded; counters only ever grow inside their period. */
  readonly missions?: MissionProgress;
  /** Permanent claim keys (missions): outlive the bounded receipt list so a one-time reward can never be paid twice. */
  readonly claims?: readonly string[];
}

/** Pluggable persistence. websim: a WebsimSocket collection; portals: localStorage or the platform data API. */
export interface WalletStore {
  /** e.g. 'websim-collection', 'local', 'poki-data'. */
  readonly id: string;
  /** True when writes survive a reload and are tied to the player (not a throwaway session). */
  readonly durable: boolean;
  load(): Promise<WalletRecord | null>;
  save(record: WalletRecord): Promise<void>;
  /** Optional: the record changed elsewhere (another tab or device). */
  subscribe?(listener: (record: WalletRecord) => void): () => void;
  /** Optional strict read used before a purchase: rejects when the remote store is unreachable (load() may fall back to a cache). */
  loadFresh?(): Promise<WalletRecord | null>;
  /** Optional: server-set creation time (ms) of this player's first stored record. Authoritative; a client can not backdate it. */
  serverCreatedAt?(): number | null;
  dispose?(): void;
}

export interface GrantRequest {
  /** Accrued source id; must match a registered EarnSource id. */
  readonly source: string;
  /** Idempotency key, unique per reward (e.g. `run:${runId}`, `ad:${placementId}:${nonce}`, `mission:${id}`). */
  readonly key: string;
  readonly amount: number;
  /** Short player-facing reason, e.g. "Drift attack finished". */
  readonly reason: string;
  /** Also remember the key in WalletRecord.claims (never evicted), for one-time rewards such as missions. */
  readonly permanent?: boolean;
}
export interface GrantResult {
  /** Marks actually credited after caps (0 when capped or a duplicate key). */
  readonly granted: number;
  readonly capped: boolean;
  readonly duplicate: boolean;
}
/** What accrued sources may do to the wallet. */
export interface WalletGrantPort {
  grant(request: GrantRequest): Promise<GrantResult>;
  /** Marks this source may still grant today (Infinity when uncapped). */
  remainingToday(source: string): number;
  /** Missions: this wallet's progress record, or null before it is loaded. */
  progress?(): MissionProgress | null;
  /** Missions: merges and saves progress (per counter maximum, so an old copy never takes progress back). */
  saveProgress?(progress: MissionProgress): Promise<void>;
  /** Missions: has this grant key (`${source}:${key}`) been paid? */
  claimed?(key: string): boolean;
  /** Missions: the purchased (and verified) item ids. */
  owned?(): readonly string[];
}

/* ------------------------------------------------------------------ earn sources */

/** Game events an accrued source can listen to. Provided by the shell. */
export interface EconomyGameEvents {
  onRunFinished(listener: (result: RunResult) => void): () => void;
  /** Optional (missions): one sample per rendered frame. */
  onFrame?(listener: (sample: FrameSample) => void): () => void;
  /** Optional (missions): your result in an online race, whenever the online view changes. */
  onOnlineRace?(listener: (sample: OnlineRaceSample) => void): () => void;
}
/** What the missions tracker needs from one frame. Built by the shell from the runtime view. */
export interface FrameSample {
  readonly tick: number;
  readonly paused: boolean;
  readonly x: number; readonly y: number; readonly z: number;
  readonly speedMS: number;
  /** Id of the event run in progress (or finished and showing results), else null. */
  readonly runId: string | null;
  /** True while the run clock is running. */
  readonly active: boolean;
  readonly unbanked: number;
  readonly validDrift: boolean;
  readonly recoveries: number;
  /** The run's route has medal targets for its mode (RuntimeView.medalTargets is set). Absent counts as true. */
  readonly hasMedalTargets?: boolean;
}
export interface OnlineRaceSample {
  readonly id: string;
  readonly participants: number;
  readonly position: number;
  readonly won: boolean;
}
export interface EarnSourceContext {
  readonly wallet: WalletGrantPort;
  readonly game: EconomyGameEvents;
  now(): number;
}

/** A card in the shop's "Get Marks" sheet: a tip pack, a rewarded ad, a mission. */
export interface EarnOffer {
  readonly id: string;
  readonly title: string;
  readonly detail: string;
  /** Marks the offer pays (approximate for tips; exact for ads and missions). */
  readonly marks: number;
  /** Button label, e.g. "Tip 50 credits", "Watch ad", "Claim". */
  readonly cta: string;
  /** Small corner label, e.g. "Best value", "+10%". */
  readonly badge?: string;
  /** Set when the offer cannot be taken right now; shown instead of the button. */
  readonly unavailable?: string | null;
  /** 0..1 for missions in progress. */
  readonly progress?: number;
  /** A sale pack: shown with the hot SALE treatment (glow, struck-through base worth, big save percentage). */
  readonly sale?: boolean;
  /** Marks the same price would give at the base rate (1 Mark per credit). With `marks` it gives the save percentage. */
  readonly worth?: number;
}
/**
 * A tip in progress (the websim tip flow). The game can not take payment itself: the player pays inside websim's own
 * comment box, and Marks are credited only when websim's record of the tip appears. `phase` never says 'confirmed'
 * before that record has been read back from websim.
 */
export interface EarnFlow {
  readonly phase: 'opening' | 'waiting' | 'confirmed' | 'timeout';
  readonly offerId: string;
  readonly credits: number;
  /** Marks the chosen pack pays (the confirmed amount can differ if the player tipped another amount). */
  readonly marks: number;
  /** How the websim composer call went. Whatever it says, the manual steps below always work. */
  readonly composer: 'pending' | 'opened' | 'needs-interaction' | 'needs-login' | 'unavailable' | 'error';
  /** Player-facing note about the composer result, or null. */
  readonly notice: string | null;
  /** The comment box reported a posted comment (a hint only; Marks wait for the record). */
  readonly posted: boolean;
  /** True when the last check could not reach websim. */
  readonly apiError: boolean;
  /** The message to paste into the comment box. */
  readonly copyText: string;
  /** Step by step instructions for tipping from the comments under the game. */
  readonly steps: readonly string[];
  /** Set only after websim's own record of a new tip was read. */
  readonly confirmed: { readonly credits: number; readonly marks: number; readonly count: number } | null;
  readonly startedAt: number;
  readonly checkedAt: number;
}

export interface RedeemResult {
  /** 'pending' = the platform UI is open and the result arrives later through subscribe/refresh. */
  readonly status: 'granted' | 'pending' | 'cancelled' | 'failed';
  readonly marks?: number;
  readonly message?: string;
}

/**
 * One way to earn Marks.
 *  - 'derived': the source owns its total, recomputed from a source of truth the client cannot forge
 *    (websim tips read from the comments API). Nothing is stored in the wallet for it.
 *  - 'accrued': the source grants Marks through WalletGrantPort.grant (gameplay, rewarded ads, missions);
 *    the wallet persists and caps them.
 */
export interface EarnSource {
  readonly id: string;
  readonly kind: 'derived' | 'accrued';
  /** Section title in the Get Marks sheet. */
  readonly label: string;
  /** One-paragraph disclosure shown under the section (e.g. "Tips go to the creator."). */
  readonly disclosure?: string;
  /** Accrued only: max Marks per UTC day; the wallet enforces it. */
  readonly dailyCap?: number;
  /** Accrued only: largest single grant (missions: 250). The wallet clamps every grant to it. */
  readonly maxGrant?: number;
  /** Accrued only: most this source can ever have paid a wallet created at `createdAt`, as of `now`. Stored earnings above it are ignored. */
  ceiling?(createdAt: number | null | undefined, now: number): number;
  /** Called after any wallet change (a purchase, a remote copy), so a source can look at the wallet again. */
  walletChanged?(): void;
  /** False hides the source entirely (wrong platform, signed out, SDK missing). Must never throw. */
  available(): boolean;
  /** Called once by the economy with the grant port and game events. Returns a detach function. */
  attach?(context: EarnSourceContext): () => void;
  /** Derived only: Marks currently credited. */
  total?(): number;
  /** Re-read the source of truth. Must not throw; failures keep the last total. */
  refresh?(): Promise<void>;
  offers?(): readonly EarnOffer[];
  redeem?(offerId: string): Promise<RedeemResult>;
  /**
   * Derived only (optional): true once total() is a complete read of the source of truth (or there is nothing to
   * read, e.g. signed out). False while loading, after a failed read and after a truncated (partial) read.
   * The economy refuses purchases and skips ownership locking while any derived source is not settled.
   */
  settled?(): boolean;
  /** Derived only (optional): why settled() is false. */
  status?(): 'loading' | 'ready' | 'partial' | 'error' | 'signed-out';
  /**
   * True = never listed in the Get Marks sheet (available() stays false), but the economy still
   * counts it (derived: total(); accrued: its stored earnings). Used by the creator grant and the welcome gift.
   */
  readonly silent?: boolean;
  /** Tip flow (optional, websim tips): the tip in progress, or null. */
  flow?(): EarnFlow | null;
  /** Starts a tip: opens websim's composer if it will, and begins waiting for the record. Call it straight from the click. */
  startFlow?(offerId: string): Promise<EarnFlow | null>;
  /** Check websim now for the tip (the "Check again" button). */
  checkFlow?(): Promise<void>;
  /** Stop waiting for the tip. */
  cancelFlow?(): void;
  /** Fires when total(), offers() or availability changes. */
  subscribe(listener: () => void): () => void;
  dispose(): void;
}

/* ------------------------------------------------------------------ economy facade */

export interface EconomyView {
  readonly ready: boolean;
  readonly balance: number;
  /** Per source id: derived totals and accrued lifetime grants. */
  readonly earnedBySource: Readonly<Record<string, number>>;
  readonly spent: number;
  readonly owned: ReadonlySet<string>;
  readonly equipped: Loadout;
  /** False when nothing can be earned on this platform (shop shows items as locked). */
  readonly canEarn: boolean;
  readonly storeDurable: boolean;
  /** Last earn event, for the counter animation. Increments `seq` on every credit. */
  readonly lastCredit: { readonly seq: number; readonly amount: number; readonly source: string; readonly reason: string } | null;
  readonly error: string | null;
  /* Additive (safe to ignore): ownership verification state. */
  /** True when every derived source (tips) was read completely, so ownership was checked against verified Marks. */
  readonly verified?: boolean;
  /** Per derived source: 'loading' | 'ready' | 'partial' | 'error' | 'signed-out'. */
  readonly ledger?: Readonly<Record<string, string>>;
  /** Owned ids that exceed verified Marks plus the plausible gameplay allowance. Locked: not usable, not in owned/equipped. */
  readonly locked?: ReadonlySet<string>;
  /** Verified budget: derived totals plus the capped accrued earnings. balance = budget - spent. */
  readonly budget?: number;
  /** True when purchase() would currently be accepted by the wallet (ready, ledger settled, store reachable as of the last check). */
  readonly purchasesOpen?: boolean;
  /** The starter gift (Marks plus the free starter items), or null in builds without one. Additive. */
  readonly gift?: GiftView | null;
}

/** The starter gift as the UI shows it. `items` are the free catalog ids it holds; they stay usable before it is opened. */
export interface GiftView {
  readonly state: 'unopened' | 'opened';
  /** Marks inside the gift (paid when it is opened). */
  readonly marks: number;
  readonly items: readonly string[];
  /** Opened on this device but the wallet has not paid the Marks yet (it keeps retrying in the background). */
  readonly pending: boolean;
}

export type GiftOpenResult =
  | { readonly ok: true; /** Marks paid by this call (0 when already opened or still pending). */ readonly granted: number; readonly pending: boolean; /** Optional line shown under the contents (a gift item the player already owned). */ readonly note?: string }
  | { readonly ok: false; readonly message: string };

export type PlateResult =
  | { readonly ok: true; readonly text: string }
  | { readonly ok: false; readonly reason: 'empty' | 'short' | 'long' | 'chars' | 'blocked' | 'locked' | 'not-ready'; readonly message: string };

export type PurchaseResult =
  | { readonly ok: true; readonly balance: number }
  | { readonly ok: false; readonly reason: 'unknown-item' | 'owned' | 'insufficient' | 'not-ready' | 'store-failed' | 'invalid' | 'unavailable'; readonly message: string };

/**
 * One item as the shop should present it.
 *   stock         price 0, always usable
 *   owned         bought and verified
 *   buyable       can be bought right now
 *   unaffordable  not enough Marks (shortfall says how many)
 *   locked        in the wallet record but not covered by verified Marks; unusable until it is (a tampered or stale record)
 *   unavailable   not purchasable right now (hidden item, or purchases paused while tips load / the store is down); see reason
 */
export type ItemStatus = 'stock' | 'owned' | 'buyable' | 'unaffordable' | 'locked' | 'unavailable';
export interface ItemState {
  readonly id: string;
  readonly kind: ItemKind;
  /** Loadout slot for cosmetics, 'car' for cars. */
  readonly slot: CosmeticSlot | 'car';
  /** Set for cars. */
  readonly carId?: CarId;
  readonly price: number;
  readonly status: ItemStatus;
  /** True when the player may use it right now (stock or owned and verified). */
  readonly usable: boolean;
  /** Marks still missing when status is 'unaffordable', else 0. */
  readonly shortfall: number;
  /** Player-facing explanation for locked / unavailable, else null. No em dashes. */
  readonly reason: string | null;
}

export interface Economy {
  view(): EconomyView;
  subscribe(listener: (view: EconomyView) => void): () => void;
  sources(): readonly EarnSource[];
  /** Re-read derived sources and the store. */
  refresh(): Promise<void>;
  purchase(itemId: string): Promise<PurchaseResult>;
  /** Equip an owned (or stock) item; null returns the slot to stock. */
  equip(slot: CosmeticSlot, itemId: string | null): Promise<void>;
  /**
   * Additive: sets the text of the custom plate (and fits that plate). Needs a verified purchase of `plate-custom`; the
   * text is validated here (2 to 8 characters of A-Z, 0-9, space, hyphen, word filter). An empty string resets it.
   */
  setPlateText?(text: string): Promise<PlateResult>;
  /** Additive: opens the starter gift (marks it opened, pays the Marks once). Safe to call twice. Resolves at once if the wallet is slow. */
  openGift?(): Promise<GiftOpenResult>;
  owns(itemId: string): boolean;
  /* Additive facade (always present on createEconomy results; optional here so other Economy implementations still compile). */
  /** One item's shop state, or null for an unknown id. Works for cosmetics and cars. */
  itemState?(itemId: string): ItemState | null;
  /** Every shop-visible item (hidden ones omitted) with its state; pass a kind to filter. */
  items?(kind?: ItemKind): readonly ItemState[];
  /** May the player drive this car right now (starter, or bought and verified)? Before the wallet loads only the starter is allowed. */
  carAllowed?(carId: CarId): boolean;
  /** Resolves true once the wallet is ready and ownership is verified, false after the timeout. */
  whenSettled?(timeoutMs?: number): Promise<boolean>;
  dispose(): void;
}
