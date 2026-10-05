/**
 * Full screen pages for the feature hub: Daily challenge, Leaderboards and ghosts, Driver profile. Pure DOM over plain
 * data (every string via textContent). The hub owns the data and the actions; pages re-render on refresh().
 */
import type { DailySpec, DailyTier } from '../events/daily';
import { DAILY_TIERS, formatCountdown } from '../events/daily';
import type { MedalTargets } from '../events/medal-targets';
import type { DailyBoardEntry } from '../net/daily-board';
import { formatValue, type LeaderboardEntry } from '../net/leaderboard';
import type { RemoteGhostRef } from '../ghosts/remote-ghosts';
import type { AchievementView, Achievement, FeatStats } from '../progression/achievements';
import { button, h } from './feature-css';
import { SELFHOST } from '../core/target';

export interface Page { readonly root: HTMLElement; refresh(): void; close(): void }
interface Frame { root: HTMLElement; card: HTMLElement; body: HTMLElement; foot: HTMLElement; title: HTMLElement; sub: HTMLElement; kicker: HTMLElement }

function frame(shell: HTMLElement, label: string, onClose: () => void): Frame {
  const root = h('div', 'lf-layer'); root.setAttribute('role', 'dialog'); root.setAttribute('aria-modal', 'true'); root.setAttribute('aria-label', label);
  const card = h('section', 'lf-card'); card.tabIndex = -1;
  const head = h('header', 'lf-head'); const text = h('div');
  const kicker = h('p', 'lf-kicker'), title = h('h3', 'lf-title'), sub = h('p', 'lf-sub');
  text.append(kicker, title, sub);
  head.append(text, button('lf-close', '×', onClose, `Close ${label}`));
  const body = h('div', 'lf-body'); const foot = h('footer', 'lf-foot');
  card.append(head, body, foot); root.append(card);
  root.addEventListener('pointerdown', event => { if (event.target === root) onClose(); });
  shell.append(root);
  return { root, card, body, foot, title, sub, kicker };
}

export function badgeNode(def: Pick<Achievement, 'badge' | 'tier' | 'name'>, off = false): HTMLElement {
  const node = h('span', `lf-badge${off ? ' off' : ''}`, def.badge);
  node.dataset.tier = def.tier; node.title = def.name; node.setAttribute('aria-label', def.name);
  return node;
}

function boardRows(list: HTMLElement, entries: readonly (LeaderboardEntry & { rank?: number })[], mode: 'time-trial' | 'drift-attack', self: string, action?: (entry: LeaderboardEntry) => HTMLButtonElement | null): void {
  list.replaceChildren();
  entries.forEach((entry, index) => {
    const rank = entry.rank ?? index + 1;
    const row = h('li', `lf-row${rank <= 3 ? ` p${rank}` : ''}${self && entry.username.toLowerCase() === self.toLowerCase() ? ' me' : ''}`);
    const name = h('span', 'lf-name', entry.username);
    if (entry.assist && entry.assist !== 'off') name.append(h('small', '', entry.assist === 'high' ? 'Assist high' : 'Assist'));
    row.append(h('span', 'lf-rank', String(rank)), name, h('span', 'lf-val', formatValue(mode, entry.value)));
    const extra = action?.(entry);
    if (extra) row.append(extra); else row.append(h('span'));
    list.append(row);
  });
}

/* ------------------------------------------------------------------ daily */

export interface DailyPageData {
  readonly spec: DailySpec;
  readonly endsAt: number;
  readonly streak: number;
  readonly tiersDone: readonly DailyTier[];
  readonly targets: MedalTargets | null;
  /** null = no online board here (off websim or still connecting). */
  readonly board: readonly DailyBoardEntry[] | null;
  readonly mine: DailyBoardEntry | null;
  readonly localBest: number | null;
  readonly loaner: boolean;
  readonly online: 'off' | 'connecting' | 'ready';
  readonly self: string;
  readonly busy: boolean;
}

export function openDailyPage(shell: HTMLElement, data: () => DailyPageData, actions: { start(): void; close(): void }): Page {
  const f = frame(shell, 'Daily challenge', actions.close);
  const chips = h('div', 'lf-chips');
  const clock = h('div', 'lf-clock'); const clockValue = h('b');
  clock.append(h('span', '', 'New challenge in'), clockValue);
  const tiers = h('div', 'lf-tiers');
  const targetsLine = h('p', 'lf-note');
  const youLine = h('p', 'lf-note');
  const list = h('ol', 'lf-board');
  const empty = h('p', 'lf-empty');
  const startButton = button('lf-go', 'Start daily', actions.start);
  f.foot.append(button('', 'Close', actions.close), startButton);
  f.body.append(chips, clock, h('h4', '', 'Rewards today'), tiers, targetsLine, h('h4', '', 'Today\'s board'), youLine, list, empty);
  const tick = (): void => { clockValue.textContent = formatCountdown(data().endsAt - Date.now()); };
  const timer = setInterval(tick, 1000);
  const refresh = (): void => {
    const d = data();
    f.kicker.textContent = `Daily challenge · ${d.spec.day}`;
    f.title.textContent = d.spec.routeName;
    f.sub.textContent = `${d.spec.modeName} in the ${d.spec.carName}`;
    chips.replaceChildren(h('span', 'lf-chip', d.spec.lighting === 'blue-hour' ? 'Blue hour' : 'Golden hour'), h('span', 'lf-chip', d.spec.modeName));
    if (d.spec.rule === 'no-reset') chips.append(h('span', 'lf-chip hot', 'No resets'));
    if (d.loaner) chips.append(h('span', 'lf-chip ok', 'Loaner car for today'));
    if (d.streak > 0) chips.append(h('span', 'lf-chip ok', `Streak ${d.streak} ${d.streak === 1 ? 'day' : 'days'}`));
    tiers.replaceChildren(...DAILY_TIERS.map(tier => {
      const node = h('div', `lf-tier${d.tiersDone.includes(tier.id) ? ' done' : ''}`);
      node.append(h('b', '', `+${tier.marks}`), h('small', '', tier.label));
      return node;
    }));
    const t = d.targets;
    targetsLine.textContent = t ? `Medals: gold ${formatTarget(d.spec.mode, t.gold)}, silver ${formatTarget(d.spec.mode, t.silver)}, bronze ${formatTarget(d.spec.mode, t.bronze)}. One payout per tier per day.` : 'One payout per tier per day.';
    const best = d.mine?.value ?? d.localBest;
    youLine.textContent = best !== null && best !== undefined
      ? `Your best today: ${formatValue(d.spec.mode, best)}${d.mine ? `, rank ${d.mine.rank} of ${d.board?.length ?? d.mine.rank}` : ''}.`
      : 'No counted run yet today.';
    if (d.board) {
      boardRows(list, d.board.slice(0, 10), d.spec.mode, d.self);
      empty.textContent = d.board.length ? '' : 'Nobody has set a time yet. Be the first.';
    } else {
      list.replaceChildren();
      empty.textContent = d.online === 'connecting' ? 'Connecting to the board...' : 'The global board is online only. Your runs still earn Marks here.';
    }
    startButton.disabled = d.busy;
    tick();
  };
  refresh();
  startButton.focus({ preventScroll: true });
  return { root: f.root, refresh, close: () => { clearInterval(timer); f.root.remove(); } };
}

function formatTarget(mode: 'time-trial' | 'drift-attack', value: number): string {
  return mode === 'time-trial' ? formatValue('time-trial', Math.round(value * 1000)) : formatValue('drift-attack', value);
}

/* ------------------------------------------------------------------ leaderboards and ghosts */

export interface BoardsPageData {
  readonly routes: readonly { readonly id: string; readonly name: string }[];
  readonly online: 'off' | 'connecting' | 'ready';
  readonly self: string;
  readonly ghostsVisible: boolean;
  times(route: string): readonly LeaderboardEntry[];
  drifts(route: string): readonly LeaderboardEntry[];
  ghosts(route: string): readonly RemoteGhostRef[];
}

export function openBoardsPage(shell: HTMLElement, data: () => BoardsPageData, initialRoute: string, actions: { race(route: string, ghost: RemoteGhostRef): void; close(): void }): Page {
  const f = frame(shell, 'Leaderboards and ghosts', actions.close);
  f.kicker.textContent = 'Leaderboards';
  f.title.textContent = 'Ghosts';
  f.sub.textContent = 'Race the fastest lap on the board, or pick any driver with a ghost.';
  let route = initialRoute;
  const tabs = h('div', 'lf-tabs'); tabs.setAttribute('role', 'tablist');
  const hero = h('div');
  const cols = h('div', 'lf-cols');
  const timeCol = h('div'), driftCol = h('div');
  const timeList = h('ol', 'lf-board'), driftList = h('ol', 'lf-board');
  const timeEmpty = h('p', 'lf-empty'), driftEmpty = h('p', 'lf-empty');
  timeCol.append(h('h4', '', 'Time trial'), timeList, timeEmpty);
  driftCol.append(h('h4', '', 'Drift attack'), driftList, driftEmpty);
  cols.append(timeCol, driftCol);
  const note = h('p', 'lf-note');
  f.body.append(tabs, hero, cols, note);
  f.foot.append(button('', 'Close', actions.close));
  const refresh = (): void => {
    const d = data();
    if (!d.routes.some(entry => entry.id === route)) route = d.routes[0]?.id ?? route;
    tabs.replaceChildren(...d.routes.map(entry => {
      const tab = button('', entry.name, () => { route = entry.id; refresh(); });
      tab.setAttribute('role', 'tab'); tab.setAttribute('aria-selected', String(entry.id === route));
      return tab;
    }));
    if (d.online !== 'ready') {
      hero.replaceChildren(); timeList.replaceChildren(); driftList.replaceChildren();
      timeEmpty.textContent = d.online === 'connecting' ? 'Connecting...' : SELFHOST ? 'The leaderboards could not be reached. Check your connection and try again.' : 'Leaderboards and ghosts are online only (play on websim).';
      driftEmpty.textContent = '';
      note.textContent = '';
      return;
    }
    const ghosts = d.ghosts(route);
    const byName = new Map(ghosts.map(ghost => [ghost.username.toLowerCase(), ghost] as const));
    const fastest = ghosts[0];
    hero.replaceChildren();
    if (fastest) {
      const go = button('lf-hero-ghost', '', () => actions.race(route, fastest));
      const text = h('span'); text.append(h('b', '', 'Race the #1 ghost'), h('small', '', `${fastest.username} · ${carLabel(fastest.car)}`));
      go.append(h('i', '', '1'), text, h('em', '', formatValue('time-trial', fastest.value)));
      hero.append(go);
    }
    const times = d.times(route);
    boardRows(timeList, times, 'time-trial', d.self, entry => {
      const ghost = byName.get(entry.username.toLowerCase());
      if (!ghost || entry.username.toLowerCase() === d.self.toLowerCase()) return null;
      return button('', 'Race ghost', () => actions.race(route, ghost), `Race ${entry.username}'s ghost`);
    });
    timeEmpty.textContent = times.length ? '' : 'No times yet. Set the first.';
    const drifts = d.drifts(route);
    boardRows(driftList, drifts, 'drift-attack', d.self);
    driftEmpty.textContent = drifts.length ? '' : 'No drift scores yet.';
    note.textContent = `${ghosts.length ? '' : 'No ghosts on this route yet. '}Set a top 20 time trial and your ghost is shared for others to race.${d.ghostsVisible ? '' : ' Ghosts are hidden in Settings; racing one turns them back on.'}`;
  };
  refresh();
  return { root: f.root, refresh, close: () => f.root.remove() };
}

const CAR_LABELS: Readonly<Record<string, string>> = { 'CAR-01': 'Challenger', 'CAR-02': 'Cybertruck', 'CAR-04': 'McLaren F1', 'CAR-05': 'Lancia Delta', 'CAR-06': 'Agera' };
function carLabel(car: string): string { return CAR_LABELS[car] ?? 'Car'; }

/* ------------------------------------------------------------------ profile */

export interface ProfilePageData {
  readonly name: string;
  readonly avatarUrl: string;
  readonly stats: FeatStats;
  readonly views: readonly AchievementView[];
  readonly top: readonly Achievement[];
  readonly streak: number;
}

export function openProfilePage(shell: HTMLElement, data: () => ProfilePageData, actions: { close(): void }, accountBlock?: () => { element: HTMLElement; refresh(): void }): Page {
  const f = frame(shell, 'Driver profile', actions.close);
  f.kicker.textContent = 'Driver profile';
  const head = h('div', 'lf-profile-head');
  const stats = h('div', 'lf-stats');
  const list = h('ul', 'lf-ach');
  const account = accountBlock?.() ?? null;
  f.body.append(head, ...(account ? [account.element] : []), h('h4', '', 'Stats'), stats, h('h4', '', 'Achievements'), list);
  f.foot.append(button('', 'Close', actions.close));
  const stat = (value: string, label: string): HTMLElement => { const node = h('div', 'lf-stat'); node.append(h('b', '', value), h('small', '', label)); return node; };
  const refresh = (): void => {
    const d = data();
    f.title.textContent = d.name;
    const unlocked = d.views.filter(view => view.unlocked).length;
    f.sub.textContent = `${unlocked} of ${d.views.length} achievements`;
    let avatar: HTMLElement;
    if (d.avatarUrl) { const img = h('img', 'lf-avatar'); img.src = d.avatarUrl; img.alt = ''; img.referrerPolicy = 'no-referrer'; avatar = img; }
    else avatar = h('span', 'lf-avatar', (d.name || 'D').slice(0, 1).toUpperCase());
    const side = h('div');
    const badges = h('div', 'lf-badges');
    if (d.top.length) badges.append(...d.top.map(def => badgeNode(def))); else badges.append(h('span', 'lf-note', 'Finish runs to earn badges.'));
    side.append(h('p', 'lf-kicker', 'Top badges'), badges);
    head.replaceChildren(avatar, side);
    const s = d.stats;
    stats.replaceChildren(
      stat(String(s.runs), 'Runs'), stat(String(s.validRuns), 'Clean runs'), stat(String(s.gold), 'Golds'), stat(s.bestDrift.toLocaleString('en-US'), 'Best drift'),
      stat(String(d.streak), 'Daily streak'), stat(String(s.bestStreak), 'Best streak'), stat(String(s.ghostWins), 'Ghosts beaten'), stat(String(s.onlineWins), 'Online wins'),
    );
    list.replaceChildren(...d.views.map(view => {
      const row = h('li', view.unlocked ? 'got' : '');
      const text = h('div'); text.append(h('b', '', view.name), h('br'), h('small', '', view.unlocked ? `${view.line} Unlocked.` : `${view.line} ${view.current.toLocaleString('en-US')} of ${view.target.toLocaleString('en-US')}.`));
      const barNode = h('span', 'lf-bar'); const fill = h('i'); fill.style.width = `${Math.round(Math.min(1, view.current / Math.max(1, view.target)) * 100)}%`; barNode.append(fill);
      row.append(badgeNode(view, !view.unlocked), text, barNode);
      return row;
    }));
  };
  refresh();
  return { root: f.root, refresh: () => { refresh(); account?.refresh(); }, close: () => f.root.remove() };
}
