/**
 * Feature hub: daily challenge, leaderboard ghosts, photo mode, last-run replay, achievements and badges. The shell
 * mounts it with one call (like the shop feature); it listens to the coordinator and the runtime and only uses their
 * public methods. Pure rules live elsewhere:
 *   src/events/daily.ts            daily spec, outcome, tiers, streak
 *   src/net/daily-board.ts         daily leaderboard rows and checks
 *   src/economy/daily-challenge.ts daily Marks (earn source with a ceiling)
 *   src/ghosts/remote-ghosts.ts    shared ghost rows, sanitizing and decoding
 *   src/progression/achievements.ts stats, achievements, presence badge mask
 *   src/camera/{photo-camera,replay-director}.ts cameras
 */
import type { CarId, FrameSnapshot, RouteId, RunResult } from '../../contracts/runtime-contracts';
import type { GameRuntime, RuntimeView } from '../core/game-runtime';
import type { ExperienceCoordinator, ExperienceState } from '../experience/coordinator';
import type { OnlineFeature } from '../net';
import type { ShopFeature } from './shop-feature';
import { EVENTS } from '../../content/events/catalog';
import { DAILY_MAX_MARKS, DAILY_TIERS, dailyOutcome, dailySpec, dailyStreak, dailyTiersFor, isDay, msUntilReset, utcDay, type DailySpec, type DailyTier } from '../events/daily';
import { medalTargetsFor } from '../events/medal-targets';
import { dailyBoard, dailyCollection, dailyMine, submitDaily } from '../net/daily-board';
import { LEADERBOARD_COLLECTION, formatValue, topEntries } from '../net/leaderboard';
import { ownEntry } from '../net/sanitize';
import type { NetCollection, NetRecord } from '../net/transport';
import { DAILY_CHALLENGE_SOURCE, type DailyChallengeSource } from '../economy/daily-challenge';
import { onlineOutcome } from '../economy/missions';
import { withTimeout } from '../economy/timeout';
import { SELFHOST } from '../core/target';
import { GHOST_COLLECTION, ghostRow, listGhosts, loadGhost, qualifiesForTable, shareGhost, type RemoteGhostRef } from '../ghosts/remote-ghosts';
import { DEFAULT_MAX_GHOST_BYTES, type GhostTransform } from '../ghosts/recording';
import { achievementViews, applyStat, badgeMask, decodeBadgeMask, normalizeStats, topBadges, unlockReached, type Achievement, type FeatStats, type StatEvent } from '../progression/achievements';
import { VEHICLE_PHYSICS_VERSION } from '../vehicle/tune-identity';
import { isPlayableRoute, PLAYABLE_ROUTE_IDS } from '../world/route-registry';
import { focusablesIn, spatialPick } from '../showroom/ui';
import { FEATURE_CSS, ensureStyle, h } from './feature-css';
import { badgeNode, openBoardsPage, openDailyPage, openProfilePage, type Page } from './feature-panels';
import { mountPhotoMode } from './photo-mode';
import { mountReplayMode } from './replay-mode';

export interface MenuDaily { readonly title: string; readonly line: string; readonly done: boolean; readonly reward: string }
export interface FeatureMenu { readonly daily: MenuDaily | null; readonly lastReplay: boolean; readonly boards: boolean }
export type FeatureAction = 'daily' | 'boards' | 'driver-profile' | 'last-replay';
export type FeatureMenuAction = 'up' | 'down' | 'left' | 'right' | 'accept' | 'back';
export interface FeatureHub {
  menu(): FeatureMenu;
  open(action: string): void;
  /** Camera for this frame while photo mode or the replay director own it; false lets the game camera run. */
  cameraOverride(frame: FrameSnapshot, dt: number, presentation: RuntimeView['presentation']): boolean;
  /** Gamepad / Escape for the feature layers. True when consumed. */
  menuAction(action: FeatureMenuAction): boolean;
  /** Badges another lobby member shows (from their presence, sanitized). */
  badges(memberId: string): readonly Achievement[];
  dispose(): void;
}
export interface FeatureHubDeps {
  readonly runtime: GameRuntime;
  readonly coordinator: ExperienceCoordinator;
  readonly online: OnlineFeature;
  shop(): ShopFeature | null;
  /** Self-hosted build: the Account block of the driver profile (name, recovery code, sign out, gift code). */
  accountBlock?(): { element: HTMLElement; refresh(): void };
  profile(): { name: string; avatarUrl: string } | null;
  resetCamera(): void;
  focusDrive(): void;
}

interface FeatRecord { stats: FeatStats; daily: { day: string; tiers: DailyTier[]; best: number | null } }
const STORE_KEY = 'lateral:feat:v1';
const STORE_MAX = 16_384;
const CAR_NAMES: Readonly<Record<string, string>> = { 'CAR-01': 'Challenger', 'CAR-02': 'Cybertruck', 'CAR-04': 'McLaren F1', 'CAR-05': 'Lancia Delta', 'CAR-06': 'Agera' };

/** Reads the local feature record defensively (bounded, normalized). */
export function parseFeatRecord(text: unknown, today: string): FeatRecord {
  let raw: Record<string, unknown> = {};
  if (typeof text === 'string' && text.length <= STORE_MAX) { try { const parsed: unknown = JSON.parse(text); if (parsed && typeof parsed === 'object') raw = parsed as Record<string, unknown>; } catch { /* fresh record */ } }
  const daily = raw.daily && typeof raw.daily === 'object' ? raw.daily as Record<string, unknown> : {};
  const day = isDay(daily.day) ? daily.day : today;
  const fresh = day === today;
  const tiers = fresh && Array.isArray(daily.tiers) ? DAILY_TIERS.map(tier => tier.id).filter(id => (daily.tiers as unknown[]).includes(id)) : [];
  const best = fresh && typeof daily.best === 'number' && Number.isSafeInteger(daily.best) && daily.best > 0 ? daily.best : null;
  return { stats: normalizeStats(raw.stats), daily: { day: today, tiers, best } };
}

type WebsimShare = { upload?: (file: File) => Promise<unknown>; postComment?: (input: { content: string; images?: string[] }) => Promise<unknown> };
function shareHost(): WebsimShare | null {
  if (SELFHOST) return null;
  try { const host = (globalThis as { websim?: WebsimShare }).websim; return host && typeof host.upload === 'function' && typeof host.postComment === 'function' ? host : null; } catch { return null; }
}

export function mountFeatureHub(shell: HTMLElement, deps: FeatureHubDeps): FeatureHub {
  ensureStyle('lf-feature-style', FEATURE_CSS);
  const { runtime, coordinator, online } = deps;
  const offs: (() => void)[] = [];
  let disposed = false;

  /* ---------------------------------------------------------------- local record */
  const storage = ((): Storage | null => { try { return typeof localStorage === 'undefined' ? null : localStorage; } catch { return null; } })();
  let record = parseFeatRecord((() => { try { return storage?.getItem(STORE_KEY); } catch { return null; } })(), utcDay(Date.now()));
  const save = (): void => { try { storage?.setItem(STORE_KEY, JSON.stringify(record)); } catch { /* storage full or blocked: keep in memory */ } };
  const rollDay = (): void => { const today = utcDay(Date.now()); if (record.daily.day !== today) record = { ...record, daily: { day: today, tiers: [], best: null } }; };

  /* ---------------------------------------------------------------- toasts and chip */
  const toasts = h('div', 'lf-toasts'); toasts.setAttribute('role', 'status'); toasts.setAttribute('aria-live', 'polite');
  const chip = h('div', 'lf-ghost-chip'); chip.hidden = true;
  const chipName = h('span'), chipTime = h('b');
  chip.append(h('span', '', 'Ghost'), chipName, chipTime);
  shell.append(toasts, chip);
  function toast(kicker: string, title: string, right = '', badge: Achievement | string = 'LF'): void {
    while (toasts.childElementCount >= 3) toasts.firstElementChild?.remove();
    const node = h('div', 'lf-toast');
    const icon = typeof badge === 'string' ? h('span', 'lf-badge', badge) : badgeNode(badge);
    if (typeof badge === 'string') icon.dataset.tier = 'silver';
    const text = h('div'); text.append(h('p', '', kicker), h('strong', '', title));
    node.append(icon, text, h('em', '', right));
    toasts.append(node);
    setTimeout(() => { node.classList.add('out'); setTimeout(() => node.remove(), 320); }, 4800);
  }

  /* ---------------------------------------------------------------- stats and badges */
  let publishedMask = -1;
  const publishBadges = (): void => {
    const session = online.session();
    if (!session?.available) return;
    const mask = badgeMask(record.stats);
    if (mask === publishedMask) return;
    publishedMask = mask;
    session.transport.updatePresence({ ab: mask });
  };
  function stat(event: StatEvent): void {
    const next = unlockReached(applyStat(record.stats, event), Date.now());
    record = { ...record, stats: next.stats };
    save();
    for (const def of next.fresh) toast('Achievement unlocked', def.name, '', def);
    if (next.fresh.length) { publishBadges(); pages.profile?.refresh(); }
  }
  const raceSeen = new Set<string>(), winSeen = new Set<string>();
  offs.push(online.subscribe(view => {
    publishBadges();
    const outcome = onlineOutcome(view);
    if (!outcome) return;
    const race = !raceSeen.has(outcome.id), won = outcome.won && !winSeen.has(outcome.id);
    if (race) raceSeen.add(outcome.id);
    if (won) winSeen.add(outcome.id);
    if (race || won) stat({ type: 'online', race, won });
  }));

  /* ---------------------------------------------------------------- collections */
  const collection = (name: string): NetCollection | null => (online.status() === 'ready' ? online.collection(name) : SELFHOST ? online.readCollection?.(name) ?? null : null);
  const records = (name: string): readonly NetRecord[] => { try { return collection(name)?.getList() ?? []; } catch { return []; } };
  const selfName = (): string => deps.profile()?.name ?? '';
  const routeName = (id: string): string => { const route = runtime.routes().find(entry => entry.id === id) as { name?: string } | undefined; return route?.name ?? id; };
  const dailySource = (): DailyChallengeSource | null => (deps.shop()?.economy.sources().find(source => source.id === DAILY_CHALLENGE_SOURCE) as DailyChallengeSource | undefined) ?? null;

  /* ---------------------------------------------------------------- pages */
  const pages: { daily?: Page | null; boards?: Page | null; profile?: Page | null } = {};
  let pageReturnFocus: HTMLElement | null = null;
  let collectionOff: (() => void) | null = null;
  // websim collections only fill their local list once subscribed. A collection is subscribed the first time it is
  // needed (a page opens or a row is about to be written) and stays subscribed for the session; writers wait for the
  // first sync (bounded), so "update my own row" never sees an empty list and duplicates rows.
  const synced = new Map<string, { off: () => void; ready: Promise<void> }>();
  let pageRefresh: (() => void) | null = null;
  function sync(name: string, timeoutMs = 2500): Promise<void> {
    const existing = synced.get(name);
    if (existing) return existing.ready;
    const target = collection(name);
    if (!target) return Promise.resolve();
    let done!: () => void;
    const ready = new Promise<void>(resolve => { done = resolve; });
    const timer = setTimeout(() => done(), timeoutMs);
    const off = target.subscribe(() => { clearTimeout(timer); done(); pageRefresh?.(); });
    try { if (target.getList().length) { clearTimeout(timer); done(); } } catch { /* wait for the subscription */ }
    synced.set(name, { off, ready });
    return ready;
  }
  offs.push(() => { for (const entry of synced.values()) entry.off(); synced.clear(); });
  const anyPage = (): Page | null => pages.daily ?? pages.boards ?? pages.profile ?? null;
  function closePages(): void {
    for (const key of ['daily', 'boards', 'profile'] as const) { pages[key]?.close(); pages[key] = null; }
    collectionOff?.(); collectionOff = null; pageRefresh = null;
    if (pageReturnFocus?.isConnected) pageReturnFocus.focus({ preventScroll: true });
    pageReturnFocus = null;
  }
  function watch(names: readonly string[], page: () => Page | null | undefined): void {
    collectionOff?.();
    pageRefresh = () => page()?.refresh();
    for (const name of names) void sync(name).then(() => page()?.refresh());
    // The socket may connect after the page opened: subscribe and refresh once it is ready.
    let wasReady = online.status() === 'ready';
    const offStatus = online.subscribe(() => {
      const ready = online.status() === 'ready';
      if (ready && !wasReady) for (const name of names) void sync(name).then(() => page()?.refresh());
      wasReady = ready;
    });
    collectionOff = () => { offStatus(); };
  }
  const leaveDrive = (): void => { if (coordinator.state().screen === 'drive') coordinator.open('pause'); };

  function openDaily(): void {
    leaveDrive(); closePages(); rollDay();
    pageReturnFocus = document.activeElement as HTMLElement | null;
    pages.daily = openDailyPage(shell, () => {
      rollDay();
      const spec = todaySpec();
      const route = runtime.routes().find(entry => entry.id === spec.route);
      const rows = records(dailyCollection(spec.day));
      const board = online.status() === 'ready' && collection(dailyCollection(spec.day)) ? dailyBoard(rows, spec) : null;
      return {
        spec, endsAt: Date.now() + msUntilReset(Date.now()), streak: dailyStreak(record.stats.dailyDays, spec.day), tiersDone: record.daily.tiers,
        targets: route ? medalTargetsFor(route, spec.mode, spec.car) ?? null : null, board, mine: board ? dailyMine(rows, spec, selfName()) : null,
        localBest: record.daily.best, loaner: !coordinator.carAllowed(spec.car) || coordinator.carLoaned() === spec.car, online: online.status(), self: selfName(),
        busy: coordinator.state().busy,
      };
    }, { start: () => { void startDaily(); }, close: closePages });
    watch([dailyCollection(todaySpec().day)], () => pages.daily);
  }
  function openBoards(): void {
    leaveDrive(); closePages();
    pageReturnFocus = document.activeElement as HTMLElement | null;
    const current = coordinator.state().selection.route;
    pages.boards = openBoardsPage(shell, () => ({
      routes: runtime.routes().filter(route => isPlayableRoute(route.id)).map(route => ({ id: route.id, name: routeName(route.id) })),
      online: online.status(), self: selfName(), ghostsVisible: coordinator.state().settings.ghostVisible,
      times: route => topEntries(records(LEADERBOARD_COLLECTION), route, 'time-trial', 10),
      drifts: route => topEntries(records(LEADERBOARD_COLLECTION), route, 'drift-attack', 10),
      ghosts: route => { const def = runtime.routes().find(entry => entry.id === route); return def ? listGhosts(records(GHOST_COLLECTION), route, def.version) : []; },
    }), isPlayableRoute(current) ? current : PLAYABLE_ROUTE_IDS[0], { race: (route, ghost) => { void raceGhost(route, ghost); }, close: closePages });
    watch([LEADERBOARD_COLLECTION, GHOST_COLLECTION], () => pages.boards);
  }
  function openProfile(): void {
    leaveDrive(); closePages();
    pageReturnFocus = document.activeElement as HTMLElement | null;
    pages.profile = openProfilePage(shell, () => {
      const profile = deps.profile();
      return { name: profile?.name || 'Driver', avatarUrl: profile?.avatarUrl ?? '', stats: record.stats, views: achievementViews(record.stats), top: topBadges(record.stats, 5), streak: dailyStreak(record.stats.dailyDays, utcDay(Date.now())) };
    }, { close: closePages }, deps.accountBlock);
  }

  /* ---------------------------------------------------------------- daily challenge */
  let specCache: DailySpec | null = null;
  const todaySpec = (): DailySpec => { const day = utcDay(Date.now()); if (specCache?.day !== day) specCache = dailySpec(day); return specCache; };
  let dailyRun: { day: string; spec: DailySpec; prevCar: CarId; loaned: boolean } | null = null;
  let dailyStarting = false;
  let restoreCar: CarId | null = null;

  async function startDaily(): Promise<void> {
    if (dailyStarting || coordinator.state().busy) return;
    if (!coordinator.playAllowed()) { closePages(); deps.shop()?.openGift(); return; }
    const spec = todaySpec();
    const event = EVENTS.find(item => item.routeId === spec.route && item.mode === spec.mode);
    if (!event) { toast('Daily challenge', 'Today\'s route is not available in this build.'); return; }
    dailyStarting = true;
    const before = coordinator.state();
    const prevCar = dailyRun?.prevCar ?? before.selection.car;
    let loaned = false;
    try {
      if (before.screen === 'drive') coordinator.open('pause');
      if (!coordinator.carAllowed(spec.car)) { coordinator.setCarLoan(spec.car); loaned = true; }
      if (coordinator.state().selection.route !== spec.route) await coordinator.selectRoute(spec.route);
      if (coordinator.state().selection.car !== spec.car) await coordinator.selectCar(spec.car);
      const state = coordinator.state();
      if (state.selection.lighting !== spec.lighting) await coordinator.setPresentation(spec.lighting, state.selection.quality);
      dailyRun = { day: spec.day, spec, prevCar, loaned: loaned || coordinator.carLoaned() === spec.car };
      closePages();
      await coordinator.beginEvent({ mode: spec.mode, rulesVersion: event.rulesVersion });
      deps.focusDrive();
    } catch (error) {
      if (loaned) coordinator.setCarLoan(null);
      dailyRun = null;
      toast('Daily challenge', error instanceof Error ? error.message.slice(0, 90) : 'The daily could not start.');
    } finally { dailyStarting = false; }
  }
  const inDaily = (view: RuntimeView, spec: DailySpec): boolean =>
    view.mode === spec.mode && view.route.id === spec.route && view.carId === spec.car && (view.run !== null || view.result !== null);
  function endDaily(): void {
    const run = dailyRun;
    if (!run) return;
    // Clear first: setCarLoan emits synchronously and re-enters the coordinator subscriber below.
    dailyRun = null;
    if (run.prevCar !== run.spec.car) restoreCar = run.prevCar;
    if (run.loaned) coordinator.setCarLoan(null);
  }
  async function onDailyResult(result: RunResult, state: ExperienceState): Promise<void> {
    rollDay();
    // A solo run on today's route, mode and car counts too, even when it was not started from the daily card.
    const today = todaySpec();
    const run = dailyRun ?? (result.routeId === today.route && result.mode === today.mode && result.carId === today.car && !online.session()?.view().lobbyId
      ? { day: today.day, spec: today, prevCar: result.carId, loaned: false } : null);
    if (!run) return;
    const outcome = dailyOutcome(run.spec, result, { startedDay: run.day, finishedDay: utcDay(Date.now()), recoveries: state.runtime.recovery?.count ?? 0 });
    if (!outcome.counts) { toast('Daily challenge', outcome.reason ?? 'Run not counted.'); return; }
    const lower = run.spec.mode === 'time-trial';
    const improved = record.daily.best === null || (lower ? outcome.value < record.daily.best : outcome.value > record.daily.best);
    if (improved) record = { ...record, daily: { ...record.daily, best: outcome.value } };
    const firstToday = !record.stats.dailyDays.includes(run.day);
    const days = firstToday ? [...record.stats.dailyDays, run.day] : record.stats.dailyDays;
    stat({ type: 'daily', day: run.day, streak: dailyStreak(days, run.day) });
    const wanted = dailyTiersFor(result.medal).filter(tier => !record.daily.tiers.includes(tier));
    const source = dailySource();
    let paid = 0;
    if (wanted.length && source) {
      const awards = await source.award(run.day, wanted);
      paid = awards.reduce((sum, award) => sum + award.granted, 0);
      // A tier the wallet refused as a duplicate was already paid on another device: count it as done too.
      record = { ...record, daily: { ...record.daily, tiers: DAILY_TIERS.map(tier => tier.id).filter(id => record.daily.tiers.includes(id) || awards.some(a => a.tier === id) || (wanted.includes(id) && source.remainingToday() === 0)) } };
    } else if (wanted.length && !source) record = { ...record, daily: { ...record.daily, tiers: [...new Set([...record.daily.tiers, ...wanted])] } };
    save();
    toast('Daily challenge', improved ? `New best: ${formatValue(run.spec.mode, outcome.value)}` : `Counted: ${formatValue(run.spec.mode, outcome.value)}`, paid ? `+${paid}` : '');
    const board = collection(dailyCollection(run.day));
    if (board && improved) {
      await sync(dailyCollection(run.day));
      const status = await submitDaily(board, run.spec, selfName(), outcome.value, result.assist);
      if (status === 'saved') {
        const mine = dailyMine(board.getList(), run.spec, selfName());
        if (mine) toast('Daily board', `Rank ${mine.rank} today`, '');
      }
    }
    pages.daily?.refresh();
  }

  /* ---------------------------------------------------------------- ghosts */
  let ghostRace: { route: string; username: string; value: number } | null = null;
  async function raceGhost(route: string, ref: RemoteGhostRef): Promise<void> {
    const def = runtime.routes().find(entry => entry.id === route);
    // The list carries shortened ghost laps (self-hosted): fetch the one the player picked in full.
    const full = await collection(GHOST_COLLECTION)?.fetchRow?.(ref.id).catch(() => null);
    const ghost = def ? loadGhost(full ? [full] : records(GHOST_COLLECTION), ref.id, route, def.version) : null;
    if (!ghost) { toast('Ghost', 'That ghost could not be loaded. Try another.'); return; }
    const event = EVENTS.find(item => item.routeId === route && item.mode === 'time-trial');
    if (!event) return;
    try {
      leaveDrive();
      closePages();
      if (coordinator.state().selection.route !== route) await coordinator.selectRoute(route as RouteId);
      if (!coordinator.state().settings.ghostVisible) await coordinator.setSettings({ ghostVisible: true });
      coordinator.setNextRival(ghost.samples);
      ghostRace = { route, username: ghost.username, value: ghost.value };
      chipName.textContent = ghost.username; chipTime.textContent = formatValue('time-trial', ghost.value);
      await coordinator.beginEvent({ mode: 'time-trial', rulesVersion: event.rulesVersion });
      deps.focusDrive();
    } catch (error) {
      coordinator.setNextRival(null); ghostRace = null;
      toast('Ghost', error instanceof Error ? error.message.slice(0, 90) : 'The ghost race could not start.');
    }
  }
  function onGhostResult(result: RunResult): void {
    const race = ghostRace;
    if (!race || result.mode !== 'time-trial' || result.routeId !== race.route) return;
    ghostRace = null;
    if (!result.valid) return;
    const ms = Math.round(result.elapsedActiveSeconds * 1000), gap = Math.abs(ms - race.value) / 1000;
    if (ms < race.value) { toast('Ghost beaten', `${race.username} by ${gap.toFixed(2)} s`, '', 'GH'); stat({ type: 'ghost-win' }); }
    else toast('Ghost', `${race.username} was ${gap.toFixed(2)} s faster`);
  }
  async function maybeShareGhost(result: RunResult): Promise<void> {
    if (result.mode !== 'time-trial' || !result.valid || !result.tuneHash || online.session()?.view().lobbyId) return;
    const ghosts = collection(GHOST_COLLECTION), board = collection(LEADERBOARD_COLLECTION), name = selfName();
    if (!ghosts || !board || !name) return;
    await sync(GHOST_COLLECTION, 4000);
    const route = runtime.routes().find(entry => entry.id === result.routeId);
    if (!route || result.routeVersion !== route.version || (result.physicsVersion ?? '') !== VEHICLE_PHYSICS_VERSION) return;
    const ms = Math.round(result.elapsedActiveSeconds * 1000);
    if (!qualifiesForTable(board.getList(), result.routeId, ms)) return;
    const saved = runtime.ghostRecording().toSavedGhost({ routeId: result.routeId, routeVersion: route.version, rulesVersion: result.rulesVersion, physicsVersion: VEHICLE_PHYSICS_VERSION, carId: result.carId, tuneHash: result.tuneHash }, DEFAULT_MAX_GHOST_BYTES);
    const row = ghostRow(saved, result);
    if (!row) return;
    if (await shareGhost(ghosts, row, name) === 'saved') toast('Ghost shared', 'Others can now race your lap.');
  }

  /* ---------------------------------------------------------------- replay and photo */
  let lastRun: { runId: string; samples: readonly GhostTransform[]; label: string } | null = null;
  let playing: { samples: readonly GhostTransform[]; label: string } | null = null;
  let photoFrom: 'photo' | 'replay' | null = null;
  let lastCar = runtime.view().frame.current.position;
  let overriding = false;
  const scene = runtime.scene;
  const replay = mountReplayMode(shell, {
    camera: scene.camera,
    controls: {
      clock: () => runtime.replayClock?.() ?? { time: 0, duration: 0, speed: 1 },
      setSpeed: speed => runtime.setReplaySpeed?.(speed),
      seek: progress => runtime.seekReplay?.(progress),
    },
    exit: () => { try { coordinator.leavePresentation(); } catch { /* busy */ } },
    photo: () => { replay.hold(true); photoFrom = 'replay'; photo.open(lastCar); },
    resetCamera: deps.resetCamera,
    onWatched: () => stat({ type: 'replay' }),
  });
  const photo = mountPhotoMode(shell, {
    camera: scene.camera, canvas: scene.renderer.domElement,
    exit: () => {
      if (photoFrom === 'replay') { photo.close(); photoFrom = null; replay.hold(false); return; }
      try { coordinator.leavePresentation(); } catch { /* busy */ }
    },
    caption: () => {
      const state = coordinator.state();
      return `Shot in LATERAL: After Hours. ${routeName(state.runtime.route.id)} in the ${CAR_NAMES[state.runtime.carId] ?? 'car'}, ${state.selection.lighting === 'blue-hour' ? 'blue hour' : 'golden hour'}.`;
    },
    fileStem: () => `lateral-${routeName(coordinator.state().runtime.route.id).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'photo'}`,
    canShare: () => shareHost() !== null,
    copy: SELFHOST ? async blob => {
      try {
        const Item = (globalThis as { ClipboardItem?: new (items: Record<string, Blob>) => unknown }).ClipboardItem;
        const clipboard = (typeof navigator !== 'undefined' ? navigator.clipboard : undefined) as { write?: (items: unknown[]) => Promise<void> } | undefined;
        if (!Item || !clipboard?.write) return { ok: false, message: 'Copying images is not supported in this browser. Use Save photo.' };
        await clipboard.write([new Item({ 'image/png': blob })]);
        return { ok: true, message: 'Photo copied. Paste it anywhere.' };
      } catch { return { ok: false, message: 'The browser did not allow copying. Use Save photo.' }; }
    } : undefined,
    share: SELFHOST ? undefined : async (blob, caption) => {
      const host = shareHost();
      if (!host) return { ok: false, message: 'Sharing works on websim only.' };
      try {
        const file = new File([blob], 'lateral-photo.png', { type: 'image/png' });
        const uploaded = await withTimeout(host.upload!(file), 45_000);
        const url = typeof uploaded === 'string' ? uploaded : (uploaded as { url?: unknown } | null)?.url;
        if (typeof url !== 'string' || !/^https:\/\/[^\s"'<>]+$/.test(url) || url.length > 600) return { ok: false, message: 'The upload did not finish. Try again.' };
        const posted = await withTimeout(host.postComment!({ content: caption, images: [url] }), 20_000) as { error?: unknown } | null;
        if (posted && typeof posted === 'object' && posted.error) return { ok: false, message: `Not posted: ${String(posted.error).slice(0, 90)}` };
        return { ok: true, message: 'Posted to the comments.' };
      } catch { return { ok: false, message: 'Not posted. Try again in a minute.' }; }
    },
    onSaved: () => stat({ type: 'photo' }),
    resetCamera: deps.resetCamera,
  });

  function onScreen(state: ExperienceState): void {
    if (state.screen === 'photo' && !photo.active) { photoFrom = 'photo'; photo.open(state.runtime.frame.current.position); }
    if (state.screen !== 'photo' && photo.active && photoFrom === 'photo') { photo.close(); photoFrom = null; }
    if (state.screen === 'replay' && !replay.active) {
      const result = state.runtime.result;
      let samples = playing?.samples ?? null, label = playing?.label ?? '';
      if (!samples && result && lastRun?.runId === result.runId) {
        // Upgrade the 12 s ring replay to the whole run.
        if (runtime.enterReplayWith?.(lastRun.samples)) { samples = lastRun.samples; label = lastRun.label; }
      }
      playing = null;
      const route = state.runtime.route;
      replay.open(samples ?? [], { centerline: route.centerline, widthM: route.widthM, closed: route.closed }, label);
    }
    if (state.screen !== 'replay' && replay.active) {
      if (photoFrom === 'replay') { photo.close(); photoFrom = null; }
      replay.close();
    }
  }
  function openLastReplay(): void {
    if (!lastRun) { toast('Replay', 'Finish a run to watch it back.'); return; }
    closePages();
    try {
      if (coordinator.state().screen === 'drive') coordinator.open('pause');
      playing = { samples: lastRun.samples, label: lastRun.label };
      if (!coordinator.replayRun(lastRun.samples)) { playing = null; toast('Replay', 'That run can not be replayed.'); }
    } catch { playing = null; }
  }

  /* ---------------------------------------------------------------- coordinator wiring */
  let lastRunId = coordinator.state().runtime.result?.runId ?? null;
  offs.push(coordinator.subscribe(state => {
    if (disposed) return;
    onScreen(state);
    const result = state.runtime.result;
    if (result && result.runId !== lastRunId) {
      lastRunId = result.runId;
      const samples = runtime.ghostRecording().samples();
      if (samples.length > 1) lastRun = { runId: result.runId, samples, label: `${routeName(result.routeId)} · ${result.mode === 'time-trial' ? 'Time trial' : result.mode === 'drift-attack' ? 'Drift attack' : 'Run'}` };
      stat({ type: 'run', result });
      onGhostResult(result);
      void onDailyResult(result, state);
      void maybeShareGhost(result).catch(() => {});
    }
    if (dailyRun && !dailyStarting && !state.busy && !inDaily(state.runtime, dailyRun.spec)) endDaily();
    if (restoreCar && !dailyRun && !state.busy && state.screen === 'pause') {
      const car = restoreCar; restoreCar = null;
      // Outside this emit: selectCar starts a transition that emits again.
      if (state.selection.car !== car && coordinator.carAllowed(car)) queueMicrotask(() => { void coordinator.selectCar(car).catch(() => {}); });
    }
    if (ghostRace && !state.busy && state.runtime.mode !== 'time-trial') ghostRace = null;
    const showChip = Boolean(ghostRace) && state.screen === 'drive';
    if (chip.hidden === showChip) chip.hidden = !showChip;
  }));
  offs.push(runtime.subscribe(() => photo.afterRender()));

  /* ---------------------------------------------------------------- keys */
  const onKey = (event: KeyboardEvent): void => {
    if (event.key !== 'Escape' || !anyPage()) return;
    event.preventDefault(); event.stopImmediatePropagation();
    closePages();
  };
  window.addEventListener('keydown', onKey, true);
  offs.push(() => window.removeEventListener('keydown', onKey, true));

  // Menu countdown: the menu markup carries an empty [data-lf-countdown]; it is filled here so the menu does not re-render every second.
  const fillCountdown = (): void => {
    const node = shell.querySelector<HTMLElement>('[data-lf-countdown]');
    if (node) { const text = formatCountdownShort(msUntilReset(Date.now())); if (node.textContent !== text) node.textContent = text; }
  };
  const countdownTimer = setInterval(fillCountdown, 1000);
  const overlay = shell.querySelector('.lp-overlay');
  const observer = typeof MutationObserver === 'function' && overlay ? new MutationObserver(fillCountdown) : null;
  if (observer && overlay) observer.observe(overlay, { childList: true });
  offs.push(() => { clearInterval(countdownTimer); observer?.disconnect(); });

  function navigate(layer: Element, action: FeatureMenuAction): void {
    const items = focusablesIn(layer);
    const current = items.find(item => item === document.activeElement) ?? null;
    if (action === 'accept') { if (current) current.click(); else items[0]?.focus(); return; }
    if (action === 'back') return;
    const next = current ? spatialPick(items, current, action) : items[0];
    next?.focus();
  }

  return {
    menu() {
      rollDay();
      const spec = todaySpec();
      const done = record.daily.tiers.includes('finish');
      const left = DAILY_MAX_MARKS - DAILY_TIERS.filter(tier => record.daily.tiers.includes(tier.id)).reduce((sum, tier) => sum + tier.marks, 0);
      const economy = deps.shop()?.available() ?? false;
      return {
        daily: { title: spec.routeName, line: `${spec.modeName} · ${spec.carName} · ${spec.lighting === 'blue-hour' ? 'Blue hour' : 'Golden hour'}${spec.rule === 'no-reset' ? ' · No resets' : ''}`, done, reward: economy ? (left > 0 ? `Up to ${left} Marks` : 'All rewards earned') : (done ? 'Done today' : 'Global board') },
        lastReplay: lastRun !== null,
        boards: true,
      };
    },
    open(action) {
      try {
        if (action === 'daily') openDaily();
        else if (action === 'boards') openBoards();
        else if (action === 'driver-profile') openProfile();
        else if (action === 'last-replay') openLastReplay();
      } catch { /* busy coordinator: ignore the click */ }
    },
    cameraOverride(frame, dt, presentation) {
      lastCar = frame.current.position;
      let took = false;
      if (photo.active) took = photo.cameraOverride(frame.current.position, dt);
      else if (replay.active && presentation === 'replay') took = replay.cameraOverride(frame.current.position, frame.current.rotation, dt);
      if (!took && overriding) deps.resetCamera();
      overriding = took;
      return took;
    },
    menuAction(action) {
      const page = anyPage();
      if (page) { if (action === 'back') closePages(); else navigate(page.root, action); return true; }
      if (photo.active) { if (action === 'back') return photo.back(); navigate(shell.querySelector('.lf-photo .lf-panel') ?? shell, action); return true; }
      if (replay.active) { if (action === 'back') return replay.back(); const bar = shell.querySelector('.lf-replay .lf-rbar'); if (bar) navigate(bar, action); return true; }
      return false;
    },
    badges(memberId) {
      const presence = online.session()?.transport.presence();
      return decodeBadgeMask(ownEntry(presence, memberId)?.ab);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      closePages();
      for (const off of offs.splice(0)) off();
      photo.dispose(); replay.dispose();
      toasts.remove(); chip.remove();
      if (dailyRun?.loaned) coordinator.setCarLoan(null);
    },
  };
}

/** Menu tile countdown: "5h 12m 33s" style without the hours when under one. */
export function formatCountdownShort(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(total / 3600), minutes = Math.floor((total % 3600) / 60), seconds = total % 60;
  return hours > 0 ? `${hours}h ${String(minutes).padStart(2, '0')}m ${String(seconds).padStart(2, '0')}s` : `${minutes}m ${String(seconds).padStart(2, '0')}s`;
}

