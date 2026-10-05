/**
 * Title, solo and pause menus. Pure markup builders over the live 3D scene: the camera orbits the
 * player's car behind a gradient scrim (no blur, no second render loop). player-ui.ts owns state and
 * events; this module only turns a MenuContext into HTML.
 */
import type { RouteDefinition } from '../../contracts/world-contracts';
import type { InputDevice } from '../input/player-input';
import { EVENTS } from '../../content/events/catalog';
import { isPlayableRoute, ROUTE_LOCATIONS } from '../world/route-registry';

export type MenuView = 'home' | 'solo' | 'controls';
export type SoloMode = 'drift-attack' | 'time-trial' | 'rival-ghost' | 'free-drive';
export interface MenuProfile { readonly name: string; readonly avatarUrl: string }
export interface MenuContext {
  readonly paused: boolean;
  readonly view: MenuView;
  readonly soloMode: SoloMode;
  readonly device: InputDevice;
  readonly route: string;
  readonly routes: readonly RouteDefinition[];
  readonly lighting: string;
  readonly carName: string;
  readonly runMode: string;
  readonly rivalAvailable: boolean;
  readonly profile: MenuProfile | null;
  readonly balance: string;
  readonly shop: boolean;
  /** Marks waiting inside the unopened starter gift (security agent): adds a glowing gift button and a balance hint. null/absent = nothing to show. */
  readonly gift?: number | null;
  /** Self-hosted build: gifts waiting in the inbox; adds a badge button that opens the first one. */
  readonly inbox?: number;
  /** Missions page (security agent); adds a tile when present. */
  readonly missions?: boolean;
  /** 'off' hides online entirely (no websim), 'connecting' shows a disabled button. */
  readonly online: 'off' | 'connecting' | 'ready';
  readonly onlineCount: number;
  readonly busy: boolean;
  readonly lessonReplay: boolean;
  readonly logo: string;
  /** Feature hub (src/ui/feature-hub.ts): daily card, leaderboards and ghosts, driver profile, last-run replay. */
  readonly features?: MenuFeatures | null;
}
export interface MenuFeatures {
  readonly daily: { readonly title: string; readonly line: string; readonly done: boolean; readonly reward: string } | null;
  readonly lastReplay: boolean;
  readonly boards: boolean;
}

const esc = (text: unknown) => String(text ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);
const svg = (body: string) => `<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">${body}</svg>`;
const S = 'fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"';
export const MENU_ICONS = {
  arrow: svg(`<path d="M4 12h15m-6-6 6 6-6 6" ${S} stroke-width="2.4"/>`),
  back: svg(`<path d="M20 12H5m6-6-6 6 6 6" ${S} stroke-width="2.2"/>`),
  garage: svg(`<path d="M3 20V9l9-5 9 5v11" ${S}/><path d="M7 20v-6h10v6M7 17h10" ${S}/>`),
  shop: svg(`<path d="M4 8h16l-1.4 12H5.4z" ${S}/><path d="M9 8V6a3 3 0 0 1 6 0v2" ${S}/>`),
  controls: svg(`<path d="M7 8h10a5 5 0 0 1 4.6 7l-.7 1.6a2.4 2.4 0 0 1-4 .6L15 15H9l-1.9 2.2a2.4 2.4 0 0 1-4-.6L2.4 15A5 5 0 0 1 7 8z" ${S}/><path d="M7.5 10.5v3M6 12h3" ${S}/><circle cx="16" cy="11" r=".9" fill="currentColor"/><circle cx="17.6" cy="13" r=".9" fill="currentColor"/>`),
  settings: svg(`<circle cx="12" cy="12" r="3.2" ${S}/><path d="M12 2.8v2.6M12 18.6v2.6M21.2 12h-2.6M5.4 12H2.8M18.5 5.5l-1.8 1.8M7.3 16.7l-1.8 1.8M18.5 18.5l-1.8-1.8M7.3 7.3 5.5 5.5" ${S}/>`),
  online: svg(`<circle cx="12" cy="12" r="2.2" fill="currentColor"/><path d="M7.8 7.8a6 6 0 0 0 0 8.4M16.2 7.8a6 6 0 0 1 0 8.4M5 5a10 10 0 0 0 0 14M19 5a10 10 0 0 1 0 14" ${S}/>`),
  restart: svg(`<path d="M4 12a8 8 0 1 0 2.4-5.7M4 4v4.5h4.5" ${S}/>`),
  home: svg(`<path d="M3 11 12 4l9 7M6 9.5V20h12V9.5" ${S}/>`),
  missions: svg(`<path d="M5 21V4m0 1h11l-2 4 2 4H5" ${S}/>`),
  play: svg('<path d="M7 4.5v15l12-7.5z" fill="currentColor"/>'),
  replay: svg(`<path d="M3 6h18v12H3z" ${S}/><path d="M10 9.5v5l4.5-2.5z" fill="currentColor"/>`),
  photo: svg(`<path d="M3 7h4l2-3h6l2 3h4v13H3z" ${S}/><circle cx="12" cy="13.5" r="3.6" ${S}/>`),
};

export const SOLO_MODES: readonly { readonly id: SoloMode; readonly name: string; readonly line: string }[] = [
  { id: 'drift-attack', name: 'Drift attack', line: 'Chain slides. Bank the score.' },
  { id: 'time-trial', name: 'Time trial', line: 'One clean lap. Beat the clock.' },
  { id: 'rival-ghost', name: 'Rival run', line: 'Hunt down the recorded ghost.' },
  { id: 'free-drive', name: 'Free drive', line: 'No clock. Just you and the quay.' },
];
const MODE_NAMES: Readonly<Record<string, string>> = { 'drift-attack': 'Drift attack', 'time-trial': 'Time trial', 'rival-ghost': 'Rival run', 'free-drive': 'Free drive' };

/** Modes that can actually start on this route in this build. Dead tiles are never shown. */
export function availableSoloModes(route: string, rivalAvailable: boolean): SoloMode[] {
  return SOLO_MODES.map(mode => mode.id).filter(id => id === 'free-drive'
    || (EVENTS.some(event => event.routeId === route && event.mode === id) && (id !== 'rival-ghost' || rivalAvailable)));
}

const outlines = new WeakMap<RouteDefinition, string>();
/** Route centreline as a 100x100 SVG path, cached per route. */
export function routeOutline(route: RouteDefinition): string {
  const cached = outlines.get(route); if (cached) return cached;
  const points = route.centerline ?? [];
  if (points.length < 2) return '';
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const p of points) { minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x); minZ = Math.min(minZ, p.z); maxZ = Math.max(maxZ, p.z); }
  const scale = 80 / Math.max(maxX - minX, maxZ - minZ, 1), cx = (minX + maxX) / 2, cz = (minZ + maxZ) / 2;
  const path = points.map((p, i) => `${i ? 'L' : 'M'}${(50 + (p.x - cx) * scale).toFixed(1)},${(50 + (p.z - cz) * scale).toFixed(1)}`).join('') + (route.closed ? 'Z' : '');
  outlines.set(route, path); return path;
}
const place = (id: string) => isPlayableRoute(id) ? ROUTE_LOCATIONS[id].place : '';
const routeName = (ctx: MenuContext) => ctx.routes.find(route => route.id === ctx.route)?.name ?? ctx.route;

function hints(device: InputDevice): string {
  const k = (key: string, label: string) => `<span><kbd>${key}</kbd>${label}</span>`;
  if (device === 'gamepad') return `${k('✥', 'Move')}${k('A', 'Select')}${k('B', 'Back')}`;
  if (device === 'touch') return '';
  return `${k('↑↓', 'Move')}${k('Enter', 'Select')}${k('Esc', 'Back')}`;
}

function topBar(ctx: MenuContext, compactBrand: boolean): string {
  const giftMarks = typeof ctx.gift === 'number' && ctx.gift > 0 ? ctx.gift : 0;
  const wallet = ctx.shop ? `<button class="lt-wallet" data-action="shop" data-focus-key="wallet" aria-label="Marks balance ${esc(ctx.balance || '0')}, open shop${giftMarks ? `, ${giftMarks.toLocaleString('en-US')} more Marks in your starter gift` : ''}"><i aria-hidden="true">M</i><b>${esc(ctx.balance || '0')}</b><small>Marks</small>${giftMarks ? `<em class="lt-wallet-gift">+${esc(giftMarks.toLocaleString('en-US'))} in gift</em>` : ''}</button>` : '';
  const gift = giftMarks ? `<button class="lt-gift" data-action="gift" data-focus-key="gift" aria-label="Open your starter gift"><span class="lt-gi" aria-hidden="true"></span><b>Open your gift</b><span class="lt-gt" aria-hidden="true">Gift</span><em aria-hidden="true">1</em></button>` : '';
  const inboxCount = typeof ctx.inbox === 'number' && ctx.inbox > 0 ? ctx.inbox : 0;
  const inbox = inboxCount ? `<button class="lt-inbox" data-action="inbox" data-focus-key="inbox" aria-label="${inboxCount} gift${inboxCount === 1 ? '' : 's'} waiting, open"><b>${inboxCount === 1 ? 'A gift is waiting' : 'Gifts waiting'}</b><em aria-hidden="true">${inboxCount}</em></button>` : '';
  const avatar = ctx.profile?.avatarUrl ? `<img src="${esc(ctx.profile.avatarUrl)}" alt="" referrerpolicy="no-referrer" loading="lazy">` : `<i aria-hidden="true">${esc((ctx.profile?.name ?? 'D').slice(0, 1).toUpperCase())}</i>`;
  // With the feature hub the chip opens the driver profile (badges and stats); without a websim name it reads Profile.
  const profile = ctx.features
    ? `<button class="lt-profile lt-profile-btn" data-action="feat-driver-profile" data-focus-key="profile" aria-label="Driver profile${ctx.profile ? `, ${esc(ctx.profile.name)}` : ''}">${avatar}<span>${esc(ctx.profile?.name ?? 'Profile')}</span></button>`
    : ctx.profile ? `<div class="lt-profile">${avatar}<span>${esc(ctx.profile.name)}</span></div>` : '';
  return `<header class="lt-top lt-in" style="--d:0ms"><div class="lt-brand${compactBrand ? ' on' : ''}" aria-hidden="${compactBrand ? 'false' : 'true'}"><span class="lt-mark">${ctx.logo}</span><b>LATERAL</b></div><div class="lt-chips">${inbox}${gift}${wallet}${profile}</div></header>`;
}

function footer(ctx: MenuContext): string {
  const where = [routeName(ctx), place(ctx.route)].filter(Boolean).join(' · ');
  return `<footer class="lt-foot lt-in" style="--d:420ms"><div class="lt-now"><small>${ctx.paused ? 'Your car' : 'On the quay'}</small><b>${esc(ctx.carName)}</b><span>${esc(where)}</span></div><div class="lt-hints" aria-hidden="true">${hints(ctx.device)}</div></footer>`;
}

function lockup(small = false): string {
  return `<h1 class="lt-lockup${small ? ' small' : ''}" aria-label="Lateral, After Hours"><span class="lt-word" data-text="LATERAL" aria-hidden="true">LATERAL</span><span class="lt-sub" aria-hidden="true"><i></i>After hours</span></h1>`;
}

function tiles(ctx: MenuContext): string {
  const tile = (attr: string, icon: string, label: string, key: string) => `<button class="lt-tile" ${attr} data-focus-key="${key}">${icon}<span>${label}</span></button>`;
  return `<div class="lt-tiles">${tile('data-action="garage"', MENU_ICONS.garage, 'Garage', 'tile-garage')}${ctx.shop ? tile('data-action="shop"', MENU_ICONS.shop, 'Shop', 'tile-shop') : ''}${ctx.missions ? tile('data-action="missions"', MENU_ICONS.missions, 'Missions', 'tile-missions') : ''}${tile('data-menu="controls"', MENU_ICONS.controls, 'Controls', 'tile-controls')}${tile('data-action="settings"', MENU_ICONS.settings, 'Settings', 'tile-settings')}</div>`;
}

export function renderTitle(ctx: MenuContext): string {
  const others = Math.max(0, ctx.onlineCount - 1);
  const onlineButton = ctx.online === 'off' ? '' : ctx.online === 'connecting'
    ? `<button class="lt-play" data-focus-key="play-online" disabled><span class="lt-play-main">${MENU_ICONS.online}<b>Play online</b></span><small>Finding the harbor</small></button>`
    : `<button class="lt-play" data-action="online" data-focus-key="play-online"><span class="lt-play-main">${MENU_ICONS.online}<b>Play online</b>${MENU_ICONS.arrow}</span><small><i class="lt-live" aria-hidden="true"></i>${others ? `${others} ${others === 1 ? 'driver' : 'drivers'} in the harbor` : 'Open lobby. Race anyone.'}</small></button>`;
  const soloPrimary = ctx.online === 'off';
  const solo = `<button class="${soloPrimary ? 'lt-play' : 'lt-solo'}" data-menu="solo" data-focus-key="solo"><span class="lt-play-main">${MENU_ICONS.play}<b>${soloPrimary ? 'Play' : 'Solo'}</b>${MENU_ICONS.arrow}</span><small>Drift attack, time trial, free drive</small></button>`;
  return `<div class="lt-root" data-view="home">${topBar(ctx, false)}<main class="lt-main"><div class="lt-hero lt-in" style="--d:60ms">${lockup()}<p class="lt-tag">Closed docks. Open throttle.</p></div><nav class="lt-nav lt-in" style="--d:200ms" aria-label="Main menu">${onlineButton}${solo}${dailyCard(ctx)}${tiles(ctx)}${ctx.lessonReplay ? '<button class="lt-link" data-action="replay-tutorial" data-focus-key="lesson">Replay driving lesson</button>' : ''}</nav></main>${footer(ctx)}</div>`;
}

/** Daily challenge card on the title screen. The countdown text is filled in by the feature hub ([data-lf-countdown]). */
function dailyCard(ctx: MenuContext): string {
  const daily = ctx.features?.daily;
  if (!daily) return '';
  return `<button class="lt-daily${daily.done ? ' done' : ''}" data-action="feat-daily" data-focus-key="daily" aria-label="Daily challenge: ${esc(daily.title)}, ${esc(daily.line)}. ${esc(daily.reward)}"><span class="lt-daily-k" aria-hidden="true"><i></i>Daily challenge<em data-lf-countdown></em></span><b aria-hidden="true">${esc(daily.title)}</b><small aria-hidden="true">${esc(daily.line)}</small><strong aria-hidden="true">${daily.done ? '&#10003; ' : ''}${esc(daily.reward)}</strong></button>`;
}

export function renderSolo(ctx: MenuContext): string {
  const modes = availableSoloModes(ctx.route, ctx.rivalAvailable);
  const chosen = modes.includes(ctx.soloMode) ? ctx.soloMode : modes[0]!;
  const modeCards = SOLO_MODES.filter(mode => modes.includes(mode.id)).map((mode, i) => `<button class="lt-mode" data-solo-mode="${mode.id}" data-focus-key="mode-${mode.id}" aria-pressed="${mode.id === chosen}"><em>${String(i + 1).padStart(2, '0')}</em><b>${mode.name}</b><small>${mode.line}</small></button>`).join('');
  const routeCards = ctx.routes.map(route => {
    const path = routeOutline(route);
    return `<button class="lt-route" data-route="${esc(route.id)}" data-focus-key="route-${esc(route.id)}" aria-pressed="${route.id === ctx.route}"${ctx.busy ? ' disabled' : ''}><svg viewBox="0 0 100 100" aria-hidden="true" focusable="false"><path d="${path}"/><path class="hi" d="${path}"/></svg><b>${esc(route.name ?? route.id)}</b><small>${esc(place(route.id) || route.id)}</small></button>`;
  }).join('');
  const light = (id: string, label: string) => `<button class="lt-seg-btn" data-lighting="${id}" data-focus-key="light-${id}" aria-pressed="${ctx.lighting === id}"${ctx.busy ? ' disabled' : ''}>${label}</button>`;
  const startLabel = chosen === 'free-drive' ? 'Drive' : 'Start';
  return `<div class="lt-root" data-view="solo">${topBar(ctx, true)}<main class="lt-main"><section class="lt-sheet lt-in" style="--d:40ms" aria-label="Solo"><header class="lt-sheet-head"><button class="lt-back" data-menu="home" data-focus-key="back" aria-label="Back to main menu">${MENU_ICONS.back}</button><div><p class="lt-kicker">Solo</p><h2>Pick your run</h2></div></header><div class="lt-sheet-body"><h3>Mode</h3><div class="lt-modes">${modeCards}</div>${ctx.routes.length > 1 ? `<h3>Route</h3><div class="lt-routes">${routeCards}</div>` : ''}<h3>Time of night</h3><div class="lt-seg">${light('golden-hour', 'Golden hour')}${light('blue-hour', 'Blue hour')}</div>${ctx.features?.boards ? '<h3>Ghosts</h3><button class="lt-ghostlink" data-action="feat-boards" data-focus-key="boards"><b>Leaderboards and ghosts</b><small>Race the #1 lap or any driver on the board</small></button>' : ''}</div><button class="lt-start" data-action="solo-start" data-focus-key="solo-start"${ctx.busy ? ' disabled' : ''}><span><small>${esc(MODE_NAMES[chosen] ?? '')} · ${esc(routeName(ctx))}</small><b>${startLabel}</b></span>${MENU_ICONS.arrow}</button></section></main>${footer(ctx)}</div>`;
}

export function renderPause(ctx: MenuContext): string {
  const inEvent = ctx.runMode !== 'free-drive';
  const item = (attr: string, icon: string, label: string, key: string, cls = '') => `<button class="lt-row${cls}" ${attr} data-focus-key="${key}">${icon}<span>${label}</span></button>`;
  return `<div class="lt-root" data-view="pause">${topBar(ctx, true)}<main class="lt-main"><section class="lt-pause lt-in" style="--d:30ms" aria-label="Paused"><p class="lt-kicker">${esc(MODE_NAMES[ctx.runMode] ?? 'Free drive')} · ${esc(routeName(ctx))}</p><h2 class="lt-paused">Paused</h2><nav class="lt-list" aria-label="Pause menu"><button class="lt-play lt-resume" data-action="drive" data-focus-key="resume"><span class="lt-play-main">${MENU_ICONS.play}<b>Resume</b>${MENU_ICONS.arrow}</span></button>${inEvent ? item('data-action="retry"', MENU_ICONS.restart, 'Restart run', 'restart') : ''}${ctx.features?.lastReplay ? item('data-action="feat-last-replay"', MENU_ICONS.replay, 'Watch last run', 'p-replay') : ''}${ctx.features ? item('data-action="photo"', MENU_ICONS.photo, 'Photo mode', 'p-photo') : ''}${item('data-menu="controls"', MENU_ICONS.controls, 'Controls', 'p-controls')}${item('data-action="settings"', MENU_ICONS.settings, 'Settings', 'p-settings')}${item('data-action="garage"', MENU_ICONS.garage, 'Garage', 'p-garage')}${item('data-action="main-menu"', MENU_ICONS.home, 'Main menu', 'p-home', ' dim')}</nav></section></main>${footer(ctx)}</div>`;
}

export function renderMainMenu(ctx: MenuContext, controls: () => string): string {
  if (ctx.view === 'controls') return controls();
  if (ctx.view === 'solo') return renderSolo(ctx);
  return ctx.paused ? renderPause(ctx) : renderTitle(ctx);
}

export const MAIN_MENU_CSS = `
.lp-shell[data-menu]::before,.lp-shell[data-menu]::after{display:none}
.lp-shell .lt-root{position:absolute;inset:0;display:grid;grid-template-rows:auto minmax(0,1fr) auto;grid-template-columns:minmax(0,1fr);padding:max(18px,env(safe-area-inset-top)) max(clamp(18px,4.6vw,72px),env(safe-area-inset-right)) max(16px,env(safe-area-inset-bottom)) max(clamp(18px,4.6vw,72px),env(safe-area-inset-left));pointer-events:none;overflow:hidden}
.lt-root::before{content:"";position:absolute;inset:0;z-index:-1;pointer-events:none;background:
linear-gradient(90deg,rgba(2,7,9,.9) 0%,rgba(3,10,12,.62) 30%,rgba(3,10,12,.12) 58%,rgba(3,10,12,0) 72%),
linear-gradient(0deg,rgba(2,7,9,.88) 0%,rgba(2,7,9,0) 32%),linear-gradient(180deg,rgba(2,7,9,.6) 0%,rgba(2,7,9,0) 18%),
repeating-linear-gradient(0deg,rgba(255,255,255,.018) 0 1px,transparent 1px 3px);animation:lt-scrim .9s ease both}
.lt-root[data-view=pause]::before{background:linear-gradient(90deg,rgba(2,7,9,.94) 0%,rgba(3,10,12,.7) 34%,rgba(3,10,12,.25) 64%,rgba(3,10,12,.1) 100%),linear-gradient(0deg,rgba(2,7,9,.8),rgba(2,7,9,0) 36%)}
.lt-root::after{content:"";position:absolute;left:0;top:0;bottom:0;width:4px;background:linear-gradient(180deg,transparent,var(--lp-accent) 30%,var(--lp-hot) 70%,transparent);opacity:.75;pointer-events:none}
.lt-in{animation:lt-in .62s cubic-bezier(.16,.84,.24,1) both;animation-delay:var(--d,0ms)}
.lt-root.lt-out .lt-in{animation:lt-out .2s ease-in both}
@keyframes lt-in{from{opacity:0;transform:translate3d(-26px,0,0)}to{opacity:1;transform:none}}
@keyframes lt-out{to{opacity:0;transform:translate3d(-18px,0,0)}}
@keyframes lt-scrim{from{opacity:0}to{opacity:1}}
@keyframes lt-reveal{from{clip-path:inset(0 100% 0 0);transform:skewX(-14deg) translateX(-30px)}to{clip-path:inset(0 0 0 0);transform:none}}
@keyframes lt-trail{0%{opacity:0;transform:translateX(-40px)}40%{opacity:.85}100%{opacity:.5;transform:translateX(9px)}}
@keyframes lt-pulse{0%,100%{box-shadow:0 0 0 0 rgba(216,250,114,.55)}60%{box-shadow:0 0 0 7px rgba(216,250,114,0)}}
@keyframes lt-sweep{from{transform:translateX(-120%) skewX(-20deg)}to{transform:translateX(320%) skewX(-20deg)}}

/* top bar */
.lt-top{display:flex;align-items:center;justify-content:space-between;gap:12px;min-height:44px}
.lt-brand{display:flex;align-items:center;gap:10px;opacity:0;transition:opacity .3s}
.lt-brand.on{opacity:1}
.lt-brand .lt-mark{width:30px;height:30px;color:var(--lp-accent);display:block}
.lt-brand .lt-mark svg{width:100%;height:100%}
.lt-brand b{font:800 1.5em/1 var(--lp-stencil);font-style:italic;letter-spacing:.08em}
.lt-chips{display:flex;align-items:center;gap:10px;margin-left:auto}
.lp-shell .lt-root button{--cut:10px;background-image:none;text-shadow:none}
.lp-shell .lt-root .lt-wallet{display:flex;align-items:center;gap:8px;min-height:40px;padding:.35em .9em .35em .45em;background:rgba(5,12,14,.62);border:1px solid rgba(255,138,31,.45);letter-spacing:.06em}
.lt-wallet i{display:grid;place-items:center;width:26px;height:26px;font:800 .8em/1 var(--lp-font);font-style:normal;color:#1b0e02;background:linear-gradient(135deg,#ffc06b,var(--lp-hot));clip-path:polygon(50% 0,100% 50%,50% 100%,0 50%)}
.lt-wallet b{font:700 1.35em/1 var(--lp-display);letter-spacing:.03em;color:var(--lp-ink)}
.lt-wallet small{font-size:.66em;color:var(--lp-dim);letter-spacing:.2em}
.lp-shell .lt-root .lt-wallet:hover:not(:disabled){border-color:var(--lp-hot);color:var(--lp-ink);transform:none;background-color:rgba(255,138,31,.14)}
.lt-profile{display:flex;align-items:center;gap:8px;min-height:40px;padding:4px 12px 4px 4px;background:rgba(5,12,14,.62);border:1px solid var(--lp-line);pointer-events:auto;max-width:42vw}
.lt-profile img,.lt-profile i{width:32px;height:32px;border-radius:50%;object-fit:cover;flex:none;display:grid;place-items:center;font:700 .9em/1 var(--lp-font);font-style:normal;background:var(--lp-teal-deep);color:var(--lp-ink);box-shadow:0 0 0 2px rgba(216,250,114,.6)}
.lt-profile span{font-weight:600;font-size:.88em;letter-spacing:.04em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}

/* hero */
.lt-main{position:relative;display:flex;flex-direction:column;justify-content:flex-end;gap:clamp(14px,3vh,30px);min-height:0;padding-bottom:clamp(8px,2vh,22px)}
.lt-lockup{margin:0;display:flex;flex-direction:column;align-items:flex-start;gap:.55em;font-size:1rem;text-shadow:none}
.lt-word{position:relative;display:block;font:800 clamp(4.4rem,11.5vw,11rem)/.78 var(--lp-stencil);font-style:italic;letter-spacing:.015em;text-transform:uppercase;color:var(--lp-ink);animation:lt-reveal .9s .15s cubic-bezier(.16,.84,.24,1) both;filter:drop-shadow(0 6px 30px rgba(0,0,0,.55))}
.lt-word::before{content:attr(data-text);position:absolute;left:0;top:0;z-index:-1;color:transparent;-webkit-text-stroke:1.5px rgba(216,250,114,.8);opacity:.5;transform:translateX(9px);animation:lt-trail 1.3s .25s cubic-bezier(.16,.84,.24,1) both}
.lt-word::after{content:"";position:absolute;top:-10%;bottom:-10%;left:0;width:22%;background:linear-gradient(90deg,transparent,rgba(255,255,255,.35),transparent);mix-blend-mode:overlay;opacity:0;animation:lt-glint 1.6s 1s ease-out both;pointer-events:none}
@keyframes lt-glint{0%{opacity:0;transform:translateX(0) skewX(-20deg)}12%,85%{opacity:1}100%{opacity:0;transform:translateX(420%) skewX(-20deg)}}
/* Same page re-rendering (balance, online count): no entrance replay. */
.lp-overlay.lp-still .lt-root:not(.lt-out) :is(.lt-in,.lt-word,.lt-route path.hi,.cp-body),.lp-overlay.lp-still .lt-word::before,.lp-overlay.lp-still .lt-word::after,.lp-overlay.lp-still .lt-root::before{animation:none!important}
.lt-sub{display:flex;align-items:center;gap:.9em;font:700 clamp(.8rem,1.15vw,1.05rem)/1 var(--lp-font);letter-spacing:.62em;text-transform:uppercase;color:var(--lp-hot);padding-left:.3em}
.lt-sub i{width:3.2em;height:7px;background:var(--lp-hazard);animation:lp-hazard 1.4s linear infinite}
.lt-tag{margin:.9em 0 0;font-size:clamp(.95rem,1.2vw,1.12rem);font-weight:500;letter-spacing:.06em;color:var(--lp-dim)}
.lt-lockup.small .lt-word{font-size:clamp(2.6rem,5vw,4.4rem)}

/* nav */
.lt-nav{display:grid;gap:10px;width:min(520px,100%)}
.lp-shell .lt-root .lt-play,.lp-shell .lt-root .lt-solo,.lp-shell .lt-root .lt-start{--cut:16px;display:flex;flex-direction:column;align-items:stretch;gap:6px;min-height:76px;padding:.75em 1.3em .8em;text-align:left;text-transform:none;letter-spacing:.02em;overflow:hidden}
.lp-shell .lt-root .lt-play{background-color:var(--lp-accent);color:var(--lp-on-accent);border-color:transparent}
.lp-shell .lt-root .lt-play::after{content:"";position:absolute;top:0;bottom:0;left:0;width:30%;background:linear-gradient(90deg,transparent,rgba(255,255,255,.55),transparent);transform:translateX(-120%) skewX(-20deg);pointer-events:none}
.lp-shell .lt-root .lt-play:hover:not(:disabled)::after,.lp-shell .lt-root .lt-play:focus-visible::after{animation:lt-sweep .8s ease-out}
.lp-shell .lt-root .lt-play:hover:not(:disabled){background-color:#ecffab;color:var(--lp-on-accent);border-color:transparent;transform:translateX(4px)}
.lp-shell .lt-root .lt-play:disabled{opacity:.7;border-style:solid;background-color:rgba(216,250,114,.35)}
.lp-shell .lt-root .lt-solo{background-color:rgba(5,14,16,.7);border:1px solid var(--lp-line-strong)}
.lp-shell .lt-root .lt-solo:hover:not(:disabled){background-color:rgba(216,250,114,.1);border-color:var(--lp-accent);color:var(--lp-ink)}
.lt-play-main{display:flex;align-items:center;gap:.55em}
.lt-play-main b{flex:1;font:800 2.05em/1 var(--lp-stencil);font-style:italic;letter-spacing:.08em;text-transform:uppercase}
.lt-play-main svg{width:1.45em;height:1.45em;flex:none}
.lt-play-main svg:last-child{transition:transform .2s cubic-bezier(.2,.8,.2,1)}
.lt-root button:hover .lt-play-main svg:last-child,.lt-root button:focus-visible .lt-play-main svg:last-child{transform:translateX(6px)}
.lt-root .lt-play small,.lt-root .lt-solo small{display:flex;align-items:center;gap:.6em;font-size:.82em;font-weight:600;letter-spacing:.06em;padding-left:2.1em;opacity:.82}
.lt-live{width:8px;height:8px;border-radius:50%;background:#1d6b1d;box-shadow:0 0 0 0 rgba(29,107,29,.6);animation:lt-pulse 1.8s ease-out infinite}
.lt-tiles{display:grid;grid-auto-flow:column;grid-auto-columns:minmax(0,1fr);gap:8px}
.lp-shell .lt-root .lt-tile{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:6px;min-height:68px;padding:.6em .4em;background-color:rgba(5,14,16,.62);font-size:.78em;letter-spacing:.16em}
.lt-tile svg{width:22px;height:22px;color:var(--lp-teal);transition:color .16s,transform .2s}
.lt-tile span{max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.lp-shell .lt-root .lt-tile:hover:not(:disabled){transform:translateY(-2px)}
.lt-tile:hover svg,.lt-tile:focus-visible svg{color:var(--lp-accent);transform:scale(1.12)}
.lp-shell .lt-root .lt-link{justify-self:start;min-height:36px;padding:.3em 0;background:none;border:0;clip-path:none;font-size:.78em;letter-spacing:.14em;color:var(--lp-dim);text-decoration:underline;text-underline-offset:4px}
.lp-shell .lt-root .lt-link:hover{color:var(--lp-accent);background:none;transform:none}
.lp-shell[data-nav=pad] .lt-root button:focus{outline:2px solid var(--lp-accent);outline-offset:-5px}

/* footer */
.lt-foot{display:flex;align-items:flex-end;justify-content:space-between;gap:16px;min-height:40px}
.lt-now{display:grid;gap:2px;padding-left:12px;border-left:3px solid var(--lp-hot)}
.lt-now small{font-size:.64em;font-weight:700;letter-spacing:.32em;text-transform:uppercase;color:var(--lp-hot)}
.lt-now b{font:800 1.5em/1 var(--lp-display);letter-spacing:.04em;text-transform:uppercase}
.lt-now span{font-size:.76em;color:var(--lp-dim);letter-spacing:.08em}
.lt-hints{display:flex;gap:16px;font-size:.74em;letter-spacing:.1em;text-transform:uppercase;color:var(--lp-dim)}
.lt-hints span{display:flex;align-items:center;gap:7px}
.lt-hints kbd{min-width:26px;padding:3px 6px;font:700 .95em/1 var(--lp-font);text-align:center;color:var(--lp-ink);border:1px solid var(--lp-line-strong);border-bottom-width:2px;background:rgba(5,12,14,.6)}

/* solo sheet */
.lt-root[data-view=solo] .lt-main{justify-content:center}
.lt-sheet{pointer-events:auto;display:flex;flex-direction:column;min-width:0;width:min(640px,100%);max-height:100%;min-height:0;background:linear-gradient(160deg,rgba(7,17,19,.9),rgba(4,10,12,.82));border:1px solid var(--lp-line);border-left:3px solid var(--lp-accent);clip-path:polygon(0 0,calc(100% - 22px) 0,100% 22px,100% 100%,0 100%)}
.lt-sheet-head{display:flex;align-items:center;gap:14px;padding:18px 22px 6px}
.lt-kicker{margin:0 0 4px;font-size:.7em;font-weight:700;letter-spacing:.34em;text-transform:uppercase;color:var(--lp-hot)}
.lt-sheet h2,.lt-pause h2{margin:0;font:800 2.3em/.9 var(--lp-stencil);font-style:italic;letter-spacing:.04em;text-transform:uppercase}
.lt-sheet-body{overflow:auto;padding:4px 22px 14px;min-height:0;-webkit-overflow-scrolling:touch;overscroll-behavior:contain}
.lt-sheet h3{margin:16px 0 8px;font-size:.68em;font-weight:700;letter-spacing:.3em;text-transform:uppercase;color:var(--lp-teal)}
.lp-shell .lt-root .lt-back{--cut:8px;width:46px;height:46px;min-height:46px;padding:0;display:grid;place-items:center;flex:none}
.lt-back svg{width:22px;height:22px}
.lt-modes{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px}
.lp-shell .lt-root .lt-mode{display:grid;grid-template-columns:auto 1fr;grid-template-rows:auto auto;column-gap:10px;row-gap:3px;align-items:baseline;min-height:70px;padding:.75em .9em;text-align:left;text-transform:none;letter-spacing:.02em;background-color:rgba(255,255,255,.03)}
.lt-mode em{grid-row:1/3;align-self:center;font:800 1.9em/1 var(--lp-stencil);font-style:normal;color:rgba(130,205,196,.35)}
.lt-mode b{font:800 1.3em/1 var(--lp-display);letter-spacing:.06em;text-transform:uppercase}
.lt-mode small{font-size:.8em;font-weight:500;color:var(--lp-dim)}
.lp-shell .lt-root .lt-mode[aria-pressed=true]{background-color:rgba(216,250,114,.13);border-color:var(--lp-accent);box-shadow:inset 3px 0 0 var(--lp-accent)}
.lt-mode[aria-pressed=true] em{color:var(--lp-accent)}
.lt-routes{display:grid;grid-auto-flow:column;grid-auto-columns:minmax(132px,1fr);gap:8px;overflow-x:auto;padding-bottom:4px;scroll-snap-type:x mandatory;-webkit-overflow-scrolling:touch}
.lp-shell .lt-root .lt-route{display:grid;justify-items:start;gap:3px;min-height:0;padding:.7em .8em;text-align:left;text-transform:none;letter-spacing:.02em;scroll-snap-align:start;background-color:rgba(255,255,255,.03)}
.lt-route svg{width:100%;height:64px;margin-bottom:4px}
.lt-route svg path{fill:none;stroke:rgba(130,205,196,.35);stroke-width:7;stroke-linecap:round;stroke-linejoin:round}
.lt-route svg path.hi{stroke:var(--lp-ink);stroke-width:2.5;stroke-dasharray:400;stroke-dashoffset:0}
.lt-route[aria-pressed=true] svg path.hi{stroke:var(--lp-accent);animation:lt-draw 1.4s ease both}
@keyframes lt-draw{from{stroke-dashoffset:400}to{stroke-dashoffset:0}}
.lt-route b{font:800 1.12em/1.05 var(--lp-display);letter-spacing:.05em;text-transform:uppercase}
.lt-route small{font-size:.74em;color:var(--lp-dim)}
.lp-shell .lt-root .lt-route[aria-pressed=true]{background-color:rgba(216,250,114,.1);border-color:var(--lp-accent)}
.lt-seg{display:inline-flex;gap:0;border:1px solid var(--lp-line)}
.lp-shell .lt-root .lt-seg-btn{--cut:0px;clip-path:none;border:0;min-height:42px;padding:.5em 1.1em;font-size:.78em;background-color:transparent}
.lp-shell .lt-root .lt-seg-btn[aria-pressed=true]{background-color:var(--lp-teal-deep);color:var(--lp-accent)}
.lp-shell .lt-root .lt-seg-btn:hover:not(:disabled){transform:none}
.lp-shell .lt-root .lt-start{--cut:0px;clip-path:none;flex-direction:row;align-items:center;justify-content:space-between;min-height:68px;margin:0;background-color:var(--lp-accent);color:var(--lp-on-accent);border:0;border-top:1px solid rgba(0,0,0,.2)}
.lt-start span{display:grid;gap:4px}
.lt-start small{font-size:.74em;font-weight:700;letter-spacing:.18em;text-transform:uppercase;opacity:.75}
.lt-start b{font:800 2em/1 var(--lp-stencil);font-style:italic;letter-spacing:.1em;text-transform:uppercase}
.lt-start svg{width:1.8em;height:1.8em;transition:transform .2s}
.lp-shell .lt-root .lt-start:hover:not(:disabled){background-color:#ecffab;color:var(--lp-on-accent);transform:none}
.lt-start:hover svg{transform:translateX(6px)}

/* pause */
.lt-root[data-view=pause] .lt-main{justify-content:center}
.lt-pause{pointer-events:auto;width:min(440px,100%)}
.lt-paused{font-size:clamp(3.6rem,8vw,6.4rem)!important;margin:.05em 0 .3em!important}
.lt-list{display:grid;gap:6px}
.lp-shell .lt-root .lt-resume{min-height:64px;margin-bottom:6px}
.lp-shell .lt-root .lt-row{display:flex;align-items:center;gap:14px;min-height:52px;padding:.6em 1.1em;background-color:rgba(5,14,16,.6);font-size:.86em;letter-spacing:.16em}
.lt-row svg{width:20px;height:20px;color:var(--lp-teal)}
.lt-row:hover svg,.lt-row:focus-visible svg{color:var(--lp-accent)}
.lp-shell .lt-root .lt-row.dim{background-color:transparent;color:var(--lp-dim)}

/* quality tiers: no blur, flatter panels on low */
.lp-shell[data-quality=low] .lt-sheet{background:rgba(6,14,16,.96)}
.lp-shell[data-quality=low] .lt-word::after,.lp-shell[data-quality=low] .lt-root::before{animation:none}

/* tablets and narrow desktops */
@media (max-width:1100px){.lt-root::before{background:linear-gradient(90deg,rgba(2,7,9,.9) 0%,rgba(3,10,12,.6) 42%,rgba(3,10,12,.1) 80%),linear-gradient(0deg,rgba(2,7,9,.9) 0%,rgba(2,7,9,0) 38%),linear-gradient(180deg,rgba(2,7,9,.6),rgba(2,7,9,0) 18%)}}
/* portrait phones and tablets: hero on top, car in the middle, controls at the thumb */
@media (orientation:portrait) and (max-width:900px){
.lp-shell .lt-root{padding-left:max(16px,env(safe-area-inset-left));padding-right:max(16px,env(safe-area-inset-right))}
.lt-root::before{background:linear-gradient(180deg,rgba(2,7,9,.82) 0%,rgba(2,7,9,.2) 26%,rgba(2,7,9,0) 40%,rgba(2,7,9,.55) 58%,rgba(2,7,9,.94) 78%)}
.lt-root[data-view=home] .lt-main{justify-content:space-between}
.lt-hero{align-self:center;text-align:center;margin-top:2vh}
.lt-lockup{align-items:center}
.lt-word{font-size:clamp(3.6rem,19vw,7rem)}
.lt-sub{letter-spacing:.5em;font-size:.78rem}
.lt-tag{text-align:center;font-size:.9rem}
.lt-nav{width:100%;max-width:560px;align-self:center}
.lp-shell .lt-root .lt-play,.lp-shell .lt-root .lt-solo{min-height:66px}
.lt-play-main b{font-size:1.75em}
.lt-foot{display:none}
.lt-root[data-view=solo] .lt-main,.lt-root[data-view=pause] .lt-main{justify-content:flex-end}
.lt-sheet{width:100%;max-height:78%;align-self:center}
.lt-pause{width:100%;align-self:center}
.lt-paused{text-align:center}
.lt-pause .lt-kicker{text-align:center}
}
@media (max-width:560px),(max-height:520px) and (orientation:landscape){.lp-shell .lt-root .lt-tile{letter-spacing:.06em}}
@media (max-width:420px){.lt-modes{grid-template-columns:1fr}.lp-shell .lt-root .lt-mode{min-height:56px}.lt-tiles{gap:6px}.lp-shell .lt-root .lt-tile{min-height:60px;font-size:.66em;letter-spacing:.1em}.lt-profile span{display:none}.lt-profile{padding:4px}.lt-sheet-head{padding:14px 16px 4px}.lt-sheet-body{padding:4px 16px 12px}}
/* short landscape phones */
@media (max-height:520px) and (orientation:landscape){
.lp-shell .lt-root{padding-top:max(10px,env(safe-area-inset-top));padding-bottom:max(8px,env(safe-area-inset-bottom))}
.lt-word{font-size:clamp(2.8rem,10vh + 1.4rem,4.6rem)}
.lt-sub{font-size:.66rem}
.lt-tag{display:none}
.lt-main{gap:10px;padding-bottom:0}
.lt-nav{width:min(420px,52vw);gap:6px}
.lp-shell .lt-root .lt-play,.lp-shell .lt-root .lt-solo{min-height:52px;padding:.5em 1em}
.lt-play-main b{font-size:1.5em}
.lt-root .lt-play small,.lt-root .lt-solo small{display:none}
.lp-shell .lt-root .lt-tile{min-height:46px;flex-direction:row;font-size:.66em}
.lt-tile svg{width:18px;height:18px}
.lt-foot{display:none}
.lt-root[data-view=solo] .lt-main{justify-content:stretch}
.lt-sheet{width:min(620px,70vw);max-height:100%}
.lt-sheet-head{padding:10px 16px 2px}.lt-sheet h2{font-size:1.6em}.lt-sheet-body{padding:2px 16px 8px}.lt-sheet h3{margin:8px 0 6px}
.lp-shell .lt-root .lt-mode{min-height:50px;padding:.5em .7em}.lt-mode small{display:none}
.lt-route svg{height:40px}
.lp-shell .lt-root .lt-start{min-height:52px}.lt-start b{font-size:1.5em}
.lt-paused{font-size:3rem!important;margin:0 0 .2em!important}
.lp-shell .lt-root .lt-row{min-height:42px}
.lp-shell .lt-root .lt-resume{min-height:50px}
/* six pause rows do not fit 390 px of height in one column: two columns, Resume across both */
.lt-pause{width:min(600px,72vw)}
.lt-pause .lt-list{grid-template-columns:1fr 1fr}
.lp-shell .lt-root .lt-pause .lt-resume{grid-column:1/-1;margin-bottom:0}
}
@media (pointer:coarse){.lt-hints{display:none}}
.lt-chips .lt-gift{position:relative;display:flex;align-items:center;gap:8px;min-height:40px;padding:.35em .9em .35em .55em;color:var(--lp-ink);background:rgba(255,138,31,.16);border:1px solid var(--lp-hot);clip-path:polygon(0 0,calc(100% - 9px) 0,100% 9px,100% 100%,9px 100%,0 calc(100% - 9px));cursor:pointer;animation:lt-gift 1.8s ease-in-out infinite}
.lp-shell .lt-root .lt-gift:hover{background-color:rgba(255,138,31,.32);border-color:#ffc15a;transform:none}
.lt-gift b{font:700 .78em var(--lp-font);letter-spacing:.14em;text-transform:uppercase}
.lt-gift .lt-gt{display:none;font:700 .78em var(--lp-font);letter-spacing:.12em;text-transform:uppercase}
.lt-gi{position:relative;flex:none;width:24px;height:22px;background:linear-gradient(180deg,#ffc15a,var(--lp-hot));border:1px solid #fff3;box-shadow:inset 0 -8px 0 rgba(0,0,0,.14)}
.lt-gi::before{content:"";position:absolute;left:50%;top:-1px;bottom:-1px;width:6px;margin-left:-3px;background:var(--lp-accent)}
.lt-gi::after{content:"";position:absolute;left:-1px;right:-1px;top:7px;height:6px;background:var(--lp-accent)}
.lt-gift em{position:absolute;right:-5px;top:-8px;display:grid;place-items:center;min-width:19px;height:19px;padding:0 5px;font:800 11px/1 var(--lp-display);font-style:normal;color:#fff;background:#e5362b;border-radius:10px;box-shadow:0 0 10px rgba(229,54,43,.7)}
@keyframes lt-gift{0%,100%{box-shadow:0 0 0 0 rgba(255,138,31,.55)}50%{box-shadow:0 0 16px 3px rgba(255,138,31,.6)}}
.lt-wallet{position:relative}
.lt-wallet .lt-wallet-gift{flex:none;margin:0 0 0 2px;padding:2px 7px;font:700 10px/1.4 var(--lp-font);font-style:normal;letter-spacing:.1em;text-transform:uppercase;color:#1a0d00;background:linear-gradient(90deg,var(--lp-hot),#ffc15a);white-space:nowrap;pointer-events:none}
@media (max-width:560px){.lt-gift b{display:none}.lt-gift .lt-gt{display:inline}.lt-chips{gap:8px}.lt-wallet:has(.lt-wallet-gift)>small{display:none}}
@media (prefers-reduced-motion:reduce){.lt-chips .lt-gift{animation:none}}
`;

/** Race start 3-2-1-GO (player-ui .lp-count). Each digit is a fresh node, so its pop animation replays. */
export const RACE_COUNTDOWN_CSS = `
.lp-count{position:absolute;left:50%;top:36%;transform:translate(-50%,-50%);z-index:12;pointer-events:none;text-align:center}
.lp-count b{position:relative;display:block;font:800 clamp(6rem,24vh,14rem)/.9 var(--lp-stencil);font-style:italic;letter-spacing:.02em;color:var(--lp-ink);text-shadow:0 8px 44px rgba(0,0,0,.65);animation:lp-count-pop .95s cubic-bezier(.2,.8,.2,1) both}
.lp-count b::after{content:"";position:absolute;left:50%;top:50%;width:1.1em;height:1.1em;border:4px solid currentColor;border-radius:50%;transform:translate(-50%,-50%) scale(.4);opacity:0;animation:lp-count-ring .8s ease-out both}
.lp-count b[data-v="3"]{color:var(--lp-hot)}.lp-count b[data-v="2"]{color:#ffc94d}.lp-count b[data-v="1"]{color:#f4f7f1}
.lp-count b[data-v=GO]{color:var(--lp-accent);letter-spacing:.08em;animation-name:lp-count-go;animation-duration:.9s;text-shadow:0 0 50px rgba(216,250,114,.45),0 8px 44px rgba(0,0,0,.6)}
@keyframes lp-count-pop{0%{opacity:0;transform:scale(2.3) skewX(-10deg)}22%{opacity:1;transform:scale(.92) skewX(0)}40%,100%{opacity:1;transform:scale(1)}}
@keyframes lp-count-go{0%{opacity:0;transform:scale(2.3) skewX(-10deg)}22%{opacity:1;transform:scale(.92) skewX(0)}40%{transform:scale(1)}75%{opacity:1}100%{opacity:0;transform:scale(1.25)}}
@keyframes lp-count-ring{0%{opacity:.7;transform:translate(-50%,-50%) scale(.4)}100%{opacity:0;transform:translate(-50%,-50%) scale(1.6)}}
`;
