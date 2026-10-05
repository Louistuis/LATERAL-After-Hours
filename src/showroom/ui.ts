/**
 * The showroom page: a full-screen studio over the game canvas. Category tabs, an item rail with price
 * tags and lock badges, a detail card with the primary action, live preview on the turntable car,
 * confirm dialog, the unlock sequence and a Get Marks sheet built from the platform's earn sources.
 *
 * Rendering: the studio draws into the game's renderer; while the showroom is open the harbor scene's
 * render() is swapped for a no-op so the GPU only pays for one scene.
 */
import type { CarId, QualityPreset } from '../../contracts/runtime-contracts';
import type { EconomyAudio } from '../economy/audio';
import * as catalogModule from '../economy/catalog';
import { RARITY, encodeLoadout } from '../economy/catalog';
import type { CatalogItem, EarnOffer, EarnSource, Economy, EconomyView, GiftView, Loadout } from '../economy/types';
import type { CarPresentation } from '../scene-pipeline/ports';
import { loadCarModel } from '../world';
import { SHOWROOM_CSS } from './css';
import { createShowroomSfx } from './sfx';
import { VEHICLE_CONFIGS, VEHICLE_TUNES } from '../vehicle/configs';
import type { VehicleConfig, VehicleTune } from '../vehicle/types';
import { openTipGuide, type TipGuide } from '../ui/tip-guide';
import { SELFHOST } from '../core/target';
import { createPlateField } from '../ui/plate-field';
import { carSpec, TUNE_COPY, tunedConfig, type CarSpec } from './spec';
import { createShowroomStage, type ShowroomStage } from './stage';
import { ShowroomState, VIRTUAL_SLOTS, type ShowroomEntry, type ShowroomMode } from './state';

export interface ShowroomHooks {
  /** Effective equipped loadout (premium equips plus profile stock paint and wheel style). */
  equipped(): Loadout;
  /** Profile livery, kept on the showroom car. */
  livery(): string | undefined;
  setStock(slot: 'paint' | 'wheelStyle', id: string): Promise<void>;
  currentCar(): string;
  selectCar(carId: string): Promise<void>;
  /** Leaves to drive (gameplay earn offers). */
  drive(): void;
  screen(): string;
  volume(): number;
  quality(): QualityPreset;
  /** Garage settings. Each is optional: a missing one hides its tab. */
  readonly garage?: {
    liveries(): readonly { id: string; name: string }[];
    tunes(): readonly string[];
    routes(): readonly { id: string; name: string }[];
    lightings(): readonly { id: string; name: string }[];
    current(slot: 'livery' | 'tune' | 'route' | 'lighting'): string | undefined;
    set(slot: 'livery' | 'tune' | 'route' | 'lighting', id: string): Promise<void>;
  };
  /** Opens the Missions page (the self-hosted Earn Marks sheet offers it). Optional: without it the button hides. */
  openMissions?(): void;
  /** Shows the starter gift reveal (the gift button and the Open gift buttons). Optional: without it the gift UI hides. */
  openGift?(): void;
  /** The page closed (the shell returns to the menu when it came from the garage screen). */
  onClose?(mode: ShowroomMode): void;
}
export interface ShowroomOpenOptions { readonly mode?: ShowroomMode; readonly category?: string; readonly item?: string }
/** Menu navigation from the gamepad (same shape as the input layer's GamepadMenuAction). */
export type ShowroomMenuAction = 'up' | 'down' | 'left' | 'right' | 'accept' | 'back';
export interface Showroom {
  /** Opens the page. A string is a category id (or 'earn' for the Get Marks sheet) in Shop mode. */
  open(options?: ShowroomOpenOptions | string): void;
  readonly mode: ShowroomMode;
  close(): void;
  /** Gamepad navigation while the page is open. Returns false when closed (the menu handles it then). */
  menuAction(action: ShowroomMenuAction): boolean;
  readonly isOpen: boolean;
  balanceText(): string;
  dispose(): void;
}
interface RenderableScene { readonly renderer: import('three').WebGLRenderer; render: (...args: never[]) => unknown }

const RARITY_COLOR: Readonly<Record<string, string>> = { stock: '#8fa19a', standard: '#2fb8ad', rare: '#5aa9ff', epic: '#b07cff', legendary: '#ff8a1f' };
const DEFAULT_SMOKE = '#d9dde0';
const fmt = (value: number): string => Math.max(0, Math.round(value)).toLocaleString('en-US');
const esc = (value: string): string => value.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const LOCK = '<svg viewBox="0 0 12 14" aria-hidden="true"><path d="M3 6V4a3 3 0 0 1 6 0v2" fill="none" stroke="currentColor" stroke-width="1.6"/><rect x="1.5" y="6" width="9" height="7" fill="currentColor"/></svg>';
const CHECK = '<svg viewBox="0 0 12 12" aria-hidden="true"><path d="M2 6.5l2.6 2.6L10 3.4" fill="none" stroke="currentColor" stroke-width="2"/></svg>';

/** Every catalog entry the showroom can sell: cosmetics plus any car list the catalog exports. */
export function showroomCatalog(): CatalogItem[] {
  const out = new Map<string, CatalogItem>();
  for (const item of catalogModule.CATALOG as readonly CatalogItem[]) out.set(item.id, item);
  for (const value of Object.values(catalogModule as unknown as Record<string, unknown>)) {
    if (!Array.isArray(value)) continue;
    for (const entry of value as unknown[]) {
      const item = entry as Partial<CatalogItem> | null;
      if (item && typeof item === 'object' && item.kind === 'car' && typeof item.id === 'string' && !out.has(item.id)) out.set(item.id, item as CatalogItem);
    }
  }
  return [...out.values()];
}

/** How an item of the starter gift is presented: still wrapped ('in-gift'), or opened and marked as coming from it. */
export type GiftPresence = 'in-gift' | 'from-gift' | null;
export function giftPresence(gift: GiftView | null | undefined, id: string): GiftPresence {
  if (!gift || !gift.items.includes(id)) return null;
  return gift.state === 'unopened' ? 'in-gift' : 'from-gift';
}

/** Picks the smallest offer that covers the gap, else the biggest one. */
/** Percent saved by a sale pack: what the same price buys at the base rate against what the pack gives. */
export function salePercent(offer: Pick<EarnOffer, 'marks' | 'worth'>): number {
  if (!offer.worth || !(offer.marks > offer.worth)) return 0;
  return Math.max(0, Math.min(99, Math.round((1 - offer.worth / offer.marks) * 100)));
}
export function coveringOffer(offers: readonly EarnOffer[], shortfall: number): EarnOffer | null {
  const open = offers.filter(offer => !offer.unavailable);
  if (!open.length || shortfall <= 0) return null;
  const covering = open.filter(offer => offer.marks >= shortfall).sort((a, b) => a.marks - b.marks)[0];
  return covering ?? [...open].sort((a, b) => b.marks - a.marks)[0]!;
}

const VIRTUAL_SWATCH: Readonly<Record<string, readonly string[]>> = { livery: ['#d8fa72', '#25292a'], tune: ['#2fb8ad'], route: ['#ff8a1f'], lighting: ['#ffb066', '#465a79'] };
/** Garage settings as synthetic catalog entries (`<slot>:<id>`), always owned, never sold. */
export function garageItems(garage: ShowroomHooks['garage']): CatalogItem[] {
  if (!garage) return [];
  const make = (slot: string, id: string, name: string, blurb: string): CatalogItem =>
    ({ id: `${slot}:${id}`, slot, name, blurb, rarity: 'stock', price: 0, swatch: VIRTUAL_SWATCH[slot] ?? ['#888'] }) as unknown as CatalogItem;
  return [
    ...garage.liveries().map(item => make('livery', item.id, item.name, 'Livery panels for this car.')),
    ...garage.tunes().map(id => make('tune', id, TUNE_COPY[id]?.title ?? id, TUNE_COPY[id]?.line ?? 'Handling preset.')),
    ...garage.routes().map(item => make('route', item.id, item.name, 'Where your next run starts.')),
    ...garage.lightings().map(item => make('lighting', item.id, item.name, 'Time of day for the harbor.')),
  ];
}
const virtualId = (id: string | undefined): string | undefined => (id && id.includes(':') ? id.slice(id.indexOf(':') + 1) : undefined);

/** Buttons and fields of a layer that can take focus right now (rendered, enabled, not hidden). */
export function focusablesIn(layer: Element): HTMLElement[] {
  return [...layer.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled)')].filter(node => {
    if (node.closest('[hidden]') || !node.getClientRects().length) return false;
    const style = getComputedStyle(node);
    return style.visibility !== 'hidden' && style.display !== 'none';
  });
}
/** Nearest item in a direction by on-screen geometry (gamepad and arrow keys in dialogs); null when nothing lies that way. */
export function spatialPick(items: readonly HTMLElement[], from: HTMLElement, direction: 'up' | 'down' | 'left' | 'right'): HTMLElement | null {
  const a = from.getBoundingClientRect(), ax = a.left + a.width / 2, ay = a.top + a.height / 2;
  let best: HTMLElement | null = null, bestScore = Infinity;
  for (const item of items) {
    if (item === from) continue;
    const b = item.getBoundingClientRect(), dx = b.left + b.width / 2 - ax, dy = b.top + b.height / 2 - ay;
    // Only items that really lie that way: a raised neighbour in the same row (the selected card lifts 6px) is not "down".
    const beyond = direction === 'down' ? b.top >= ay : direction === 'up' ? b.bottom <= ay : direction === 'right' ? b.left >= ax : b.right <= ax;
    if (!beyond) continue;
    const along = direction === 'down' ? dy : direction === 'up' ? -dy : direction === 'right' ? dx : -dx;
    const across = direction === 'down' || direction === 'up' ? Math.abs(dx) : Math.abs(dy);
    const score = along + across * 2.2;
    if (score < bestScore) { bestScore = score; best = item; }
  }
  return best;
}
/** CSS selector that finds the same control again after a re-render (they are rebuilt from markup). */
function focusKey(node: Element | null): string | null {
  if (!node) return null;
  for (const attr of ['data-sr-item', 'data-sr-tab', 'data-sr-mode', 'data-sr-offer', 'data-sr']) {
    const value = node.getAttribute(attr);
    if (value !== null) return `[${attr}="${value.replace(/["\\]/g, '\\$&')}"]`;
  }
  return null;
}

export function mountShowroom(shell: HTMLElement, scene: RenderableScene, economy: Economy, audio: EconomyAudio, hooks: ShowroomHooks): Showroom {
  const garage = hooks.garage;
  const state = new ShowroomState({
    economy, catalog: [...showroomCatalog(), ...garageItems(garage)],
    extras: garage ? {
      equipped: slot => { const id = garage.current(slot as 'livery'); return id ? `${slot}:${id}` : undefined; },
      equip: (slot, id) => garage.set(slot as 'livery', virtualId(id) ?? id),
    } : undefined, equipped: () => hooks.equipped(), currentCar: () => hooks.currentCar(),
    setStock: (slot, id) => hooks.setStock(slot, id), selectCar: carId => hooks.selectCar(carId),
  });
  const sfx = createShowroomSfx(() => hooks.volume());
  const style = document.createElement('style'); style.textContent = SHOWROOM_CSS; document.head.append(style);
  const root = document.createElement('div');
  root.className = 'lp-sr'; root.hidden = true;
  root.setAttribute('role', 'dialog'); root.setAttribute('aria-modal', 'true'); root.setAttribute('aria-label', 'Showroom');
  root.innerHTML = `<div class="lp-sr-drag" data-sr-drag></div><div class="lp-sr-shade" aria-hidden="true"></div>
<header class="lp-sr-top"><div class="lp-sr-brand"><span class="lp-sr-kicker">Harbor Works <i>/</i> <span data-sr-kicker>Showroom</span></span><h2 data-sr-title>Showroom</h2></div><div class="lp-sr-modes" role="tablist" aria-label="Garage or Shop"><button type="button" role="tab" data-sr-mode="garage">Garage</button><button type="button" role="tab" data-sr-mode="shop">Shop</button></div>
<div class="lp-sr-wallet"><button type="button" class="lp-sr-bal" data-sr="earn" aria-label="Marks balance. ${SELFHOST ? 'Earn Marks' : 'Get Marks'}"><i aria-hidden="true">M</i><b data-sr-balance>0</b><span class="lp-sr-plus" aria-hidden="true">+</span></button><span class="lp-sr-delta" data-sr-delta aria-live="polite"></span><small class="lp-sr-giftnote" data-sr-giftnote hidden></small><button type="button" class="lp-sr-gift" data-sr="gift" hidden aria-label="Open your starter gift"><span class="lp-sr-gi" aria-hidden="true"></span><span class="lp-sr-gt">Open your gift</span><em aria-hidden="true">1</em></button></div>
<button type="button" class="lp-sr-close" data-sr="close" aria-label="Close showroom">×</button></header>
<nav class="lp-sr-tabs" role="tablist" aria-label="Categories"></nav>
<aside class="lp-sr-card" aria-live="polite"></aside>
<div class="lp-sr-rail" role="listbox" aria-label="Items"></div>
<p class="lp-sr-hint" aria-hidden="true">Drag to orbit <i>/</i> pinch or scroll to zoom</p>
<div class="lp-sr-loading" aria-hidden="true"><span></span>Rolling it in</div>
<div class="lp-sr-modal" hidden></div>
<div class="lp-sr-fx" hidden></div>`;
  shell.append(root);
  const $ = <T extends HTMLElement>(selector: string): T => root.querySelector<T>(selector)!;
  const tabsEl = $('.lp-sr-tabs'), cardEl = $('.lp-sr-card'), railEl = $('.lp-sr-rail'), modalEl = $('.lp-sr-modal'), fxEl = $('.lp-sr-fx');
  const kickerEl = $('[data-sr-kicker]'), modesEl = $('.lp-sr-modes');
  const giftBtn = $('[data-sr=gift]'), giftNoteEl = $('[data-sr-giftnote]');
  const titleEl = $('[data-sr-title]'), balanceEl = $('[data-sr-balance]'), deltaEl = $('[data-sr-delta]'), dragEl = $('[data-sr-drag]');

  let open = false;
  let stage: ShowroomStage | null = null;
  // Custom Plate text field (src/ui/plate-field.ts): lives under the item card; its draft text previews on the car.
  const plateField = createPlateField(economy, { onDraft: () => { if (open) applyLoadout(); }, onSaved: () => { if (open) { appliedKey = ''; applyLoadout(true); paint(); } } });
  let car: CarPresentation | null = null, carId: string | null = null, carToken = 0, appliedKey = '';
  let raf = 0, watch = 0, originalRender: RenderableScene['render'] | null = null;
  let view: EconomyView = economy.view();
  let shown = view.balance, lastSeq = view.lastCredit?.seq ?? 0, counterFrame = 0;
  let celebrated = 0, celebrateTimers: number[] = [];
  let busyOffer = false, earnNote: string | null = null;
  const last = { tabs: '', card: '', rail: '', modal: '', fx: '' };
  let lastCategory = '', lastSelected = '';
  // Keyboard and gamepad focus: what opened the page (focus goes back there on close), what opened a dialog, the tip guide.
  let opener: HTMLElement | null = null, modalOpener: string | null = null, tipGuide: TipGuide | null = null, carShown: string | null = null;

  /* ------------------------------------------------------------------ markup */

  const rarityColor = (entry: ShowroomEntry | null): string => RARITY_COLOR[entry?.rarity ?? 'stock'] ?? RARITY_COLOR.stock!;
  const swatch = (entry: ShowroomEntry): string => {
    const item = entry.item;
    if (!item) return '<span class="lp-sr-sw k-none" aria-hidden="true"></span>';
    const [a = '#888', b = a, c = b] = item.swatch;
    const vars = `--a:${a};--b:${b};--c:${c}`;
    if (VIRTUAL_SLOTS.has(item.slot)) return `<span class="lp-sr-sw k-v k-${item.slot}" style="${vars}" aria-hidden="true">${entry.slot === 'tune' ? esc(entry.name.slice(0, 1)) : ''}</span>`;
    if (item.kind === 'car') return `<span class="lp-sr-sw k-car" style="${vars}" aria-hidden="true"><svg viewBox="0 0 40 16"><path d="M2 12l3-5 9-3h10l8 4 6 1v3z" fill="currentColor"/><circle cx="10" cy="13" r="2.6" fill="#050b0d"/><circle cx="30" cy="13" r="2.6" fill="#050b0d"/></svg></span>`;
    if (item.slot === 'plate') return `<span class="lp-sr-sw k-plate" style="${vars}" aria-hidden="true"><span>${esc(item.name)}</span></span>`;
    if (item.slot === 'horn') return `<span class="lp-sr-sw k-horn" style="--a:${rarityColor(entry)}" aria-hidden="true"><i></i><i></i><i></i></span>`;
    if (item.slot === 'wheelStyle') return `<span class="lp-sr-sw k-style" aria-hidden="true">${esc(item.name.slice(0, 1))}</span>`;
    return `<span class="lp-sr-sw k-${item.slot} f-${item.finish ?? 'gloss'}" style="${vars}" aria-hidden="true"></span>`;
  };
  const presence = (entry: ShowroomEntry): GiftPresence => (entry.item ? giftPresence(view.gift, entry.id) : null);
  const tag = (entry: ShowroomEntry): string => {
    // A starter item still wrapped in the unopened gift shows the gift badge instead of Owned / Fitted.
    if (presence(entry) === 'in-gift') return '<b class="t-gift">IN YOUR GIFT</b>';
    switch (state.status(entry)) {
      case 'equipped': return `<b class="t-eq">${CHECK}${VIRTUAL_SLOTS.has(entry.slot) ? 'Set' : 'Fitted'}</b>`;
      case 'owned': return `<b class="t-own">${VIRTUAL_SLOTS.has(entry.slot) ? '' : entry.price ? 'Owned' : presence(entry) === 'from-gift' ? 'Gift' : 'Free'}</b>`;
      case 'buy': return `<b class="t-buy">${fmt(entry.price)} M</b>`;
      default: return state.mode === 'garage' ? `<b class="t-lock">${LOCK}Shop</b>` : `<b class="t-lock">${LOCK}${fmt(entry.price)} M</b>`;
    }
  };
  const renderTabs = (): string => state.categories.map(category => {
    const entries = state.entries(category.id).filter(entry => entry.item);
    const owned = entries.filter(entry => state.owned(entry)).length;
    return `<button type="button" role="tab" data-sr-tab="${esc(category.id)}" aria-selected="${category.id === state.category().id}"><span>${esc(category.label)}</span><small>${owned}/${entries.length}</small></button>`;
  }).join('');
  const renderRail = (): string => {
    const selected = state.selected()?.id;
    const category = state.category();
    let previousSlot = '';
    return state.entries().map(entry => {
      const head = category.slots.length > 1 && entry.slot !== previousSlot ? `<span class="lp-sr-group">${({ wheelStyle: 'Style', rim: 'Finish', route: 'Route', lighting: 'Light' } as Record<string, string>)[entry.slot] ?? ''}</span>` : '';
      previousSlot = entry.slot;
      const status = state.status(entry);
      const label = `${entry.name}, ${RARITY[entry.rarity].label}, ${presence(entry) === 'in-gift' ? 'in your starter gift' : status === 'equipped' ? 'fitted' : state.owned(entry) ? (presence(entry) === 'from-gift' ? 'from your starter gift' : 'owned') : `${fmt(entry.price)} Marks${status === 'buy' ? '' : ', locked'}`}`;
      return `${head}<button type="button" role="option" class="lp-sr-item s-${status}" data-sr-item="${esc(entry.id)}" aria-selected="${entry.id === selected}" aria-label="${esc(label)}" style="--rar:${rarityColor(entry)}">${swatch(entry)}<span class="lp-sr-name">${esc(entry.name)}</span>${tag(entry)}${state.shownId(entry.slot) === entry.id ? '<i class="lp-sr-on" aria-hidden="true"></i>' : ''}</button>`;
    }).join('');
  };
  const configOf = (id: string): VehicleConfig | undefined => (VEHICLE_CONFIGS as Partial<Record<string, VehicleConfig>>)[id];
  const tuneOf = (carId: string, preset: string): VehicleTune | undefined => (VEHICLE_TUNES as Partial<Record<string, Partial<Record<string, VehicleTune>>>>)[carId]?.[preset];
  const bars = (spec: CarSpec, base?: CarSpec | null): string => ([['Power', 'power'], ['Grip', 'grip'], ['Agility', 'agility'], ['Slide', 'slide']] as const).map(([label, key]) => {
    const value = spec[key], delta = base ? value - base[key] : 0;
    const diff = delta ? `<small class="${delta > 0 ? 'up' : 'down'}">${delta > 0 ? '+' : ''}${delta}</small>` : '';
    return `<div class="lp-sr-bar"><span>${label}</span><i>${base ? `<s style="width:${base[key]}%"></s>` : ''}<em style="width:${value}%"></em></i><b>${value}${diff}</b></div>`;
  }).join('');
  const tuneSheet = (preset: string): string => {
    const carId = state.previewCar() ?? hooks.currentCar();
    const config = configOf(carId), tune = tuneOf(carId, preset);
    if (!config || !tune) return '';
    const spec = carSpec(tunedConfig(config, tune));
    const currentPreset = virtualId(state.equippedId('tune'));
    const currentTune = currentPreset ? tuneOf(carId, currentPreset) : undefined;
    const base = currentTune && currentPreset !== preset ? carSpec(tunedConfig(config, currentTune)) : null;
    if (!spec) return '';
    return `<div class="lp-sr-spec"><div class="lp-sr-figs"><span><b>${fmt(spec.powerHp)}</b><small>hp</small></span><span><b>${esc(spec.character)}</b><small>Drift</small></span></div>${bars(spec, base)}${base ? `<p>Compared with ${esc(currentPreset ?? '')}.</p>` : ''}</div>`;
  };
  const specSheet = (id: string): string => {
    const spec = carSpec(configOf(id));
    if (!spec) return '';
    const barsHtml = bars(spec);
    return `<div class="lp-sr-spec"><div class="lp-sr-figs"><span><b>${fmt(spec.powerHp)}</b><small>hp</small></span><span><b>${fmt(spec.massKg)}</b><small>kg</small></span><span><b>${esc(spec.character)}</b><small>Drift</small></span></div>${barsHtml}<p>${esc(spec.line)}</p></div>`;
  };
  const renderCard = (): string => {
    const entry = state.selected();
    if (!entry) return '';
    const status = state.status(entry);
    const item = entry.item;
    const blurb = item ? item.blurb : 'Back to how it left the factory.';
    const hint = entry.slot === 'horn' ? ' Press H or tap Horn while driving.' : entry.slot === 'smoke' ? ' Shows when you slide.' : '';
    const buttons: string[] = [];
    const busy = state.busy ? 'disabled' : '';
    const wrapped = presence(entry) === 'in-gift' && Boolean(hooks.openGift);
    if (wrapped) buttons.push('<button type="button" class="go gift" data-sr="open-gift">Open gift</button>');
    else if (entry.carId && status === 'equipped') buttons.push(`<button type="button" class="go" data-sr="drive-car" ${busy}>Drive it</button>`);
    else if (entry.carId && status === 'owned') buttons.push(`<button type="button" class="go" data-sr="drive-car" ${busy}>Drive this car</button>`, `<button type="button" data-sr="equip" ${busy}>Select</button>`);
    else if (status === 'equipped') buttons.push(`<button type="button" class="go" disabled>${CHECK} ${VIRTUAL_SLOTS.has(entry.slot) ? 'Selected' : 'Fitted'}</button>`);
    else if (status === 'owned') buttons.push(`<button type="button" class="go" data-sr="equip" ${busy}>Fit it</button>`);
    else if (state.mode === 'garage' && !state.owned(entry)) buttons.push(`<button type="button" class="go" data-sr="to-shop">Get in Shop <b>${fmt(entry.price)} M</b></button>`);
    else if (status === 'buy') buttons.push(`<button type="button" class="go buy" data-sr="buy">Unlock <b>${fmt(entry.price)} M</b></button>`);
    else if (status === 'short') buttons.push(`<button type="button" class="hot" data-sr="buy">Need ${fmt(state.shortfall(entry))} more M</button>`);
    else if (status === 'locked') buttons.push(`<button type="button" disabled>${LOCK} Locked</button>`);
    else buttons.push('<button type="button" disabled>Opening wallet</button>');
    if (entry.slot === 'horn' && item) buttons.push('<button type="button" data-sr="play">Play</button>');
    if (state.dirty()) buttons.push('<button type="button" class="ghost" data-sr="revert">Revert</button>');
    const giftLine = wrapped ? '<p class="lp-sr-ingift"><b>IN YOUR GIFT</b><span>Open your starter gift to make it yours.</span></p>'
      : presence(entry) === 'from-gift' ? '<p class="lp-sr-from">From your starter gift</p>' : '';
    const price = item && entry.price && !state.owned(entry) ? `<span class="lp-sr-price">${fmt(entry.price)}<i>M</i></span>` : '';
    const notes: string[] = [];
    if (state.note) notes.push(`<p class="lp-sr-note${state.note.calm ? ' calm' : ''}" role="status">${esc(state.note.text)}</p>`);
    if (view.error) notes.push(`<p class="lp-sr-note" role="alert">${esc(view.error)}</p>`);
    if (status !== 'equipped' && state.shownId(entry.slot) === entry.id && !state.owned(entry)) notes.push('<p class="lp-sr-note calm">Preview only. Unlock it to keep it.</p>');
    return `<div class="lp-sr-card-in${entry.carId ? ' is-car' : ''}" style="--rar:${rarityColor(entry)}"><p class="lp-sr-rar"><span>${esc(RARITY[entry.rarity].label)}</span>${esc(entry.carId && status === 'equipped' ? 'Your car' : state.category().label)}</p><h3>${esc(entry.name)}</h3>${giftLine}${price}<p class="lp-sr-blurb">${esc(blurb + hint)}</p>${entry.carId ? specSheet(entry.carId) : entry.slot === 'tune' ? tuneSheet(virtualId(entry.id) ?? '') : ''}${notes.join('')}<div class="lp-sr-actions">${buttons.join('')}</div></div>`;
  };
  const earnSources = (): EarnSource[] => economy.sources().filter(source => {
    try { return source.available() || Boolean(source.offers?.().some(offer => offer.unavailable)); } catch { return false; }
  });
  const renderEarn = (): string => {
    const target = state.earnTarget();
    const shortfall = state.shortfall(target);
    const sources = earnSources();
    const lead = target
      ? shortfall > 0
        ? `<p class="lp-sr-gap"><b>${esc(target.name)}</b> needs <strong>${fmt(shortfall)} more M</strong>.</p>`
        : `<p class="lp-sr-gap ok">You have enough for <b>${esc(target.name)}</b>.</p><div class="lp-sr-actions"><button type="button" class="go" data-sr="retry">Unlock it</button></div>`
      : '<p class="lp-sr-gap">Marks unlock paint, wheels, glow, smoke, plates and horns.</p>';
    const body = sources.length ? sources.map(source => {
      const offers = source.offers?.() ?? [];
      const pick = coveringOffer(offers, shortfall);
      const card = (offer: EarnOffer): string => {
        const unavailable = offer.unavailable ?? null;
        const best = pick?.id === offer.id;
        const sale = offer.sale === true;
        const badge = best ? (offer.marks >= shortfall ? 'Covers it' : 'Biggest pack') : sale ? '' : offer.badge;
        const save = sale ? salePercent(offer) : 0;
        const worth = sale && offer.worth && offer.worth < offer.marks ? `<s>${fmt(offer.worth)}</s> <b aria-hidden="true">\u2192</b> ${fmt(offer.marks)} Marks` : '';
        const sub = sale ? `<em class="lp-sr-worth">${worth || esc(offer.detail)}</em>` : `<em>${esc(offer.detail)}</em>`;
        const label = `${offer.cta}: ${offer.title}, ${offer.detail}${sale && save ? `, sale, save ${save} percent` : ''}${best ? ', covers what you need' : ''}`;
        return `<button type="button" class="lp-sr-offer${best ? ' best' : ''}${sale ? ' sale' : ''}" data-sr-offer="${esc(source.id)}|${esc(offer.id)}" ${unavailable || busyOffer ? 'disabled' : ''} aria-label="${esc(label)}">${badge ? `<i>${esc(badge)}</i>` : ''}${sale ? `<b class="lp-sr-sale-tag">${esc(offer.badge ?? 'Sale')}</b>` : ''}<span>${esc(offer.title)}</span><strong>${source.kind === 'derived' ? '+' : ''}${fmt(offer.marks)}<small>M</small></strong>${sale && save ? `<span class="lp-sr-save"><b>${save}%</b> off</span>` : ''}${sub}<u>${esc(unavailable ?? offer.cta)}</u></button>`;
      };
      const regular = offers.filter(offer => !offer.sale), sales = offers.filter(offer => offer.sale);
      return `<section class="lp-sr-earn"><h4>${esc(source.label)}</h4><div class="lp-sr-offers">${regular.map(card).join('')}</div>${sales.length ? `<h5 class="lp-sr-saleh"><span>Big packs on sale</span></h5><div class="lp-sr-offers sale">${sales.map(card).join('')}</div>` : ''}${source.disclosure ? `<p class="lp-sr-disclosure">${esc(source.disclosure)}</p>` : ''}</section>`;
    }).join('') : SELFHOST ? '' : '<p class="lp-sr-note calm">There is no way to earn Marks in this build.</p>';
    // Self-hosted: Marks come from missions and gifts. The sheet says so, and opens the Missions page.
    const missionsBlock = SELFHOST ? `<p class="lp-sr-note calm">Marks come from missions and gifts.</p>${hooks.openMissions ? '<div class="lp-sr-actions"><button type="button" class="go" data-sr="missions">Earn Marks with missions</button></div>' : ''}` : '';
    return `<div class="lp-sr-sheet" role="dialog" aria-modal="true" aria-labelledby="lp-sr-earn-title"><header><h3 id="lp-sr-earn-title">${SELFHOST ? 'Earn Marks' : 'Get Marks'}</h3><button type="button" class="lp-sr-x" data-sr="cancel" aria-label="Back">×</button></header>${lead}${earnNote ? `<p class="lp-sr-note calm" role="status">${esc(earnNote)}</p>` : ''}${body}${missionsBlock}</div>`;
  };
  const renderModal = (): string => {
    if (state.phase === 'earn') return renderEarn();
    const entry = state.confirmEntry();
    if ((state.phase !== 'confirm' && state.phase !== 'buying') || !entry) return '';
    const after = view.balance - entry.price;
    return `<div class="lp-sr-confirm" role="alertdialog" aria-modal="true" aria-labelledby="lp-sr-confirm-title" style="--rar:${rarityColor(entry)}"><p class="lp-sr-rar"><span>${esc(RARITY[entry.rarity].label)}</span>Unlock</p><h3 id="lp-sr-confirm-title">${esc(entry.name)}</h3><dl><dt>Price</dt><dd>${fmt(entry.price)} M</dd><dt>Balance after</dt><dd>${fmt(after)} M</dd></dl><p>${entry.carId ? 'Yours to drive, paint and keep.' : 'Cosmetic only. No effect on handling.'}</p><div class="lp-sr-actions"><button type="button" data-sr="cancel" ${state.busy ? 'disabled' : ''}>Cancel</button><button type="button" class="go buy" data-sr="confirm" ${state.busy ? 'disabled' : ''}>${state.busy ? 'Unlocking' : `Unlock for ${fmt(entry.price)} M`}</button></div></div>`;
  };
  const renderFx = (): string => {
    const receipt = state.phase === 'celebrate' ? state.receipt : null;
    if (!receipt) return '';
    return `<div class="lp-sr-fx-in" style="--rar:${rarityColor(receipt.entry)}"><i class="lp-sr-sweep"></i><i class="lp-sr-flare"></i><div class="lp-sr-stamp"><small>Unlocked</small><strong>${esc(receipt.entry.name)}</strong><em>-${fmt(receipt.before - receipt.after)} M</em><span><b data-sr-fx-count>${fmt(receipt.before)}</b> M left</span></div><div class="lp-sr-fx-actions">${receipt.entry.carId ? '<button type="button" class="go" data-sr="drive-car">Drive this car</button><button type="button" data-sr="done">Later</button>' : '<button type="button" class="go" data-sr="done">Sweet</button>'}</div></div>`;
  };

  /** A layer above the page owns input: the starter gift reveal (in the shell) or the tip guide (in the page). */
  const overlayLayer = (): HTMLElement | null => shell.querySelector<HTMLElement>('.lp-gf') ?? root.querySelector<HTMLElement>('.lp-tg');
  /** Where keyboard and gamepad focus lives now: the top dialog, the unlock buttons, or the page. */
  const activeLayer = (): HTMLElement => overlayLayer() ?? (!modalEl.hidden ? modalEl : !fxEl.hidden ? fxEl : root);
  /** Scrolls only the given strip (never the page) so a child is in view. */
  const reveal = (strip: HTMLElement, child: Element | null): void => {
    if (!(child instanceof HTMLElement)) return;
    const s = strip.getBoundingClientRect(), c = child.getBoundingClientRect();
    if (c.top < s.top) strip.scrollTop -= s.top - c.top + 4; else if (c.bottom > s.bottom) strip.scrollTop += c.bottom - s.bottom + 4;
    if (c.left < s.left) strip.scrollLeft -= s.left - c.left + 12; else if (c.right > s.right) strip.scrollLeft += c.right - s.right + 12;
  };
  const focusEl = (node: HTMLElement | null | undefined): boolean => {
    if (!node || (node as HTMLButtonElement).disabled) return false;
    node.focus({ preventScroll: true });
    if (node.closest('.lp-sr-rail')) reveal(railEl, node); else if (node.closest('.lp-sr-tabs')) reveal(tabsEl, node); else if (cardEl.contains(node)) reveal(cardEl, node);
    return document.activeElement === node;
  };
  const selectedItemEl = (): HTMLElement | null => railEl.querySelector<HTMLElement>('[data-sr-item][aria-selected=true]') ?? railEl.querySelector<HTMLElement>('[data-sr-item]');
  /** Default focus: the dialog's main button, back to what opened the dialog, else the selected item. */
  const focusDefault = (): void => {
    const layer = activeLayer();
    // In priority order (one querySelector with a list would return the first in document order: Cancel).
    if (layer === modalEl) { for (const pick of ['[data-sr=confirm]:not(:disabled)', '[data-sr=retry]', '.lp-sr-offer.best:not(:disabled)', '.lp-sr-offer:not(:disabled)', '[data-sr=missions]', '[data-sr=cancel]']) if (focusEl(modalEl.querySelector<HTMLElement>(pick))) return; return; }
    if (layer === fxEl) { focusEl(fxEl.querySelector<HTMLElement>('button.go') ?? fxEl.querySelector<HTMLElement>('button')); return; }
    if (layer !== root) { focusEl(focusablesIn(layer)[0]); return; }
    const back = modalOpener ? root.querySelector<HTMLElement>(modalOpener) : null;
    modalOpener = null;
    if (!focusEl(back)) focusEl(selectedItemEl());
  };

  const paint = (): void => {
    if (!open) return;
    // Rail, tabs and card are rebuilt from markup: keep keyboard and gamepad focus on the same control.
    const before = document.activeElement instanceof HTMLElement && root.contains(document.activeElement) ? document.activeElement : null;
    const beforeKey = focusKey(before);
    const modalWas = !modalEl.hidden || !fxEl.hidden;
    paintNow();
    const modalIs = !modalEl.hidden || !fxEl.hidden;
    if (!modalWas && modalIs && before && !modalEl.contains(before) && !fxEl.contains(before)) modalOpener = beforeKey;
    const lost = !document.activeElement || document.activeElement === document.body || !root.contains(document.activeElement);
    if (before && lost && !overlayLayer()) {
      if (before.isConnected && root.contains(before) && focusEl(before)) return;
      const again = beforeKey && !(modalWas && !modalIs) ? activeLayer().querySelector<HTMLElement>(beforeKey) : null;
      if (!focusEl(again)) focusDefault();
    } else if (modalIs && !overlayLayer() && !activeLayer().contains(document.activeElement)) focusDefault();
  };
  const paintNow = (): void => {
    const category = state.category();
    titleEl.textContent = state.phase === 'earn' ? (SELFHOST ? 'Earn Marks' : 'Get Marks') : category.label;
    kickerEl.textContent = state.mode === 'garage' ? 'Garage' : 'Showroom';
    root.dataset.mode = state.mode;
    for (const button of modesEl.querySelectorAll<HTMLElement>('[data-sr-mode]')) button.setAttribute('aria-selected', String(button.dataset.srMode === state.mode));
    modesEl.hidden = !garage;
    const set = (key: keyof typeof last, el: HTMLElement, markup: string): boolean => {
      if (last[key] === markup) return false;
      last[key] = markup;
      const scroll = el.scrollLeft, scrollTop = el.scrollTop;
      el.innerHTML = markup; el.scrollLeft = scroll; el.scrollTop = scrollTop;
      return true;
    };
    // The starter gift (unopened): a glowing gift button in the header and a hint on the balance chip.
    const giftOpen = view.gift?.state === 'unopened' && Boolean(hooks.openGift);
    giftBtn.hidden = !giftOpen; giftNoteEl.hidden = !giftOpen;
    if (giftOpen && view.gift) giftNoteEl.textContent = `+${fmt(view.gift.marks)} in gift`;
    // Selected tab and item scroll into their own strip only (scrollIntoView would also shift the page).
    if (set('tabs', tabsEl, renderTabs())) reveal(tabsEl, tabsEl.querySelector('[aria-selected=true]'));
    if (set('rail', railEl, renderRail())) {
      const chosen = railEl.querySelector<HTMLElement>('[aria-selected=true]');
      if (chosen) railEl.scrollTo({ left: chosen.offsetLeft - (railEl.clientWidth - chosen.offsetWidth) / 2, behavior: 'smooth' });
    }
    set('card', cardEl, renderCard());
    const plateSelected = state.selected()?.id === 'plate-custom' && state.phase !== 'earn';
    plateField.show(plateSelected);
    if (plateSelected) plateField.attachTo(cardEl);
    const modal = renderModal();
    // Focus moves into a dialog when it appears (paint() above); re-renders keep focus where it is.
    if (set('modal', modalEl, modal)) modalEl.hidden = !modal;
    const fx = renderFx();
    if (set('fx', fxEl, fx)) fxEl.hidden = !fx;
    root.classList.toggle('is-modal', Boolean(modal) || Boolean(fx));
  };

  /* ------------------------------------------------------------------ studio sync */

  const shownLivery = (): string | undefined => virtualId(state.shownId('livery')) ?? hooks.livery();
  /** What the turntable car wears: the preview loadout, plus the plate text being typed while the Custom Plate is shown. */
  const shownLoadout = (): Loadout => {
    const base = state.previewLoadout();
    const text = plateField.draft();
    return text && base.plate === 'plate-custom' ? { ...base, plateText: text } : base;
  };
  const loadoutKey = (): string => JSON.stringify([shownLoadout(), shownLivery()]);
  const applyLoadout = (force = false): void => {
    if (!car) return;
    const key = loadoutKey();
    if (!force && key === appliedKey) return;
    appliedKey = key;
    const loadout = shownLoadout();
    car.setCosmetics({ paint: encodeLoadout(loadout), wheelStyle: loadout.wheelStyle, livery: shownLivery() });
  };
  const syncCar = (): void => {
    const wanted = state.previewCar();
    if (!wanted || wanted === carId) { applyLoadout(); return; }
    carId = wanted;
    const token = ++carToken;
    root.classList.add('is-loading');
    loadCarModel(wanted as CarId).then(next => {
      if (token !== carToken || !open || !stage) { next.dispose(); return; }
      const swap = car !== null;
      car = next; carShown = wanted; appliedKey = '';
      applyLoadout(true);
      // First car: placed at once (the entry curtain covers it). Swaps get the full reveal.
      stage.setCar(next, swap);
      if (swap) { sfx.whoosh(); window.setTimeout(() => { if (open) sfx.impact(); }, 520); }
      root.classList.remove('is-loading');
    }).catch(error => {
      console.warn('LATERAL showroom car failed', error);
      // Back to the car on the table, so picking the same car again retries the load.
      if (token === carToken) { carId = carShown; root.classList.remove('is-loading'); state.setNote('That car could not load. Try again.', false); }
    });
  };
  const syncStage = (): void => {
    if (!stage) return;
    const category = state.category();
    const selected = state.selected();
    stage.setShot(state.phase === 'earn' ? 'earn' : category.shot);
    stage.setMood(category.id === 'underglow' && state.phase !== 'earn' ? 0.85 : 0);
    const smoke = state.entry(state.shownId('smoke'));
    stage.setSmoke(category.id === 'smoke' && state.phase !== 'earn' ? smoke?.item?.swatch[0] ?? DEFAULT_SMOKE : null);
    if (state.phase !== 'celebrate') stage.setAccent(selected?.item?.slot === 'underglow' ? selected.item.swatch[0] ?? '#d8fa72' : rarityColor(selected) === RARITY_COLOR.stock ? '#d8fa72' : rarityColor(selected));
    if (category.id !== lastCategory) { if (lastCategory) sfx.whoosh(); lastCategory = category.id; }
    const selectedId = selected?.id ?? '';
    if (selectedId !== lastSelected) {
      const fresh = lastSelected !== '';
      lastSelected = selectedId;
      if (fresh && selected?.slot === 'paint') stage.pulse('paint');
    }
  };

  /* ------------------------------------------------------------------ balance + unlock sequence */

  const countTo = (target: number, ticking: boolean, el: HTMLElement | null = null, duration = 0): void => {
    cancelAnimationFrame(counterFrame);
    const start = shown, began = performance.now();
    const span = duration || Math.min(1500, 350 + Math.abs(target - start) * 0.5);
    const step = (now: number): void => {
      const k = Math.min(1, (now - began) / span);
      const next = Math.round(start + (target - start) * (1 - Math.pow(1 - k, 3)));
      if (ticking && next !== shown) audio.tick();
      shown = next;
      balanceEl.textContent = fmt(shown);
      const fx = el ?? fxEl.querySelector<HTMLElement>('[data-sr-fx-count]');
      if (fx) fx.textContent = fmt(shown);
      if (k < 1) counterFrame = requestAnimationFrame(step);
    };
    counterFrame = requestAnimationFrame(step);
  };
  const clearCelebrate = (): void => { celebrateTimers.forEach(clearTimeout); celebrateTimers = []; };
  const runCelebrate = (): void => {
    const receipt = state.receipt;
    if (!receipt || receipt.seq === celebrated) return;
    celebrated = receipt.seq;
    clearCelebrate();
    const color = rarityColor(receipt.entry);
    shown = receipt.before; balanceEl.textContent = fmt(shown);
    root.classList.remove('is-burst'); root.classList.add('is-charging');
    sfx.riser(0.85);
    stage?.setShot(state.category().shot);
    celebrateTimers.push(window.setTimeout(() => {
      root.classList.remove('is-charging'); void root.offsetWidth; root.classList.add('is-burst');
      stage?.celebrate(color);
      sfx.impact(); audio.purchase();
      celebrateTimers.push(window.setTimeout(() => sfx.chime(), 180));
      countTo(receipt.after, true, null, 1300);
    }, 850));
    celebrateTimers.push(window.setTimeout(() => { root.classList.remove('is-burst'); state.finishCelebrate(); }, 4600));
  };

  const onView = (next: EconomyView): void => {
    view = next;
    const credit = next.lastCredit;
    if (credit && credit.seq !== lastSeq) {
      lastSeq = credit.seq;
      if (open) {
        audio.credit();
        deltaEl.textContent = `+${fmt(credit.amount)}`;
        deltaEl.classList.remove('pop'); void deltaEl.offsetWidth; deltaEl.classList.add('pop');
        if (credit.source === 'tips') earnNote = `Tip received. ${fmt(credit.amount)} Marks added. Thank you.`;
        countTo(next.balance, true);
      } else { shown = next.balance; balanceEl.textContent = fmt(shown); }
    } else if (state.phase !== 'celebrate' && next.balance !== shown) {
      if (open) countTo(next.balance, false); else { shown = next.balance; balanceEl.textContent = fmt(shown); }
    }
    paint();
  };
  const offView = economy.subscribe(onView);
  const offSources = economy.sources().map(source => source.subscribe(() => paint()));
  const offState = state.subscribe(() => {
    if (!open) return;
    if (state.phase === 'celebrate') runCelebrate();
    syncCar(); syncStage(); paint();
  });

  /* ------------------------------------------------------------------ input */

  const redeem = async (sourceId: string, offerId: string): Promise<void> => {
    const source = economy.sources().find(entry => entry.id === sourceId);
    if (!source) return;
    if (source.kind === 'accrued' && !source.redeem) { api.close(); hooks.drive(); return; }
    // Tips run through the guided flow (steps, copyable message, live waiting state). It starts websim's own tip box
    // synchronously, inside this click, and only reports success once websim's record of the tip has been read back.
    if (!SELFHOST && source.startFlow) {
      tipGuide?.close();
      // onClose can run inside openTipGuide (a flow that ends at once), before the guide is returned.
      let ended = false;
      const guide = openTipGuide(root, source, offerId, { onClose: () => { ended = true; tipGuide = null; paint(); if (open && !root.contains(document.activeElement)) focusDefault(); } });
      // The guide moves focus to its own first button.
      if (guide) { if (!ended) tipGuide = guide; earnNote = null; return; }
    }
    if (!source.redeem) return;
    busyOffer = true; earnNote = null; paint();
    const result = await source.redeem(offerId).catch(() => ({ status: 'failed' as const, message: 'That did not work. Try again.' }));
    busyOffer = false;
    if (result.status === 'pending') earnNote = result.message ?? 'Finish in the window that opened.';
    else if (result.status === 'failed') { audio.deny(); earnNote = result.message ?? 'That did not work. Try again.'; }
    else if (result.status === 'granted') earnNote = result.message ?? 'Marks added.';
    paint();
    void economy.refresh();
  };
  const driveCar = async (id: string | undefined): Promise<void> => {
    const entry = state.entry(id);
    if (!entry?.carId) return;
    clearCelebrate(); root.classList.remove('is-burst', 'is-charging');
    state.finishCelebrate();
    if (await state.equip(entry.id)) { api.close(); hooks.drive(); }
  };
  const primary = (): void => {
    const entry = state.selected();
    if (!entry) return;
    const status = state.status(entry);
    if (presence(entry) === 'in-gift' && hooks.openGift) hooks.openGift();
    else if (state.mode === 'garage' && !state.owned(entry)) { sfx.whoosh(); state.setMode('shop', entry.id); }
    else if (entry.carId && (status === 'owned' || status === 'equipped')) void driveCar(entry.id);
    else if (status === 'owned') void state.equip(entry.id);
    else if (status === 'buy' || status === 'short' || status === 'locked') { if (status !== 'buy') audio.deny(); state.requestPurchase(entry.id); }
  };
  const onClick = (event: Event): void => {
    const el = (event.target as Element).closest<HTMLElement>('[data-sr],[data-sr-mode],[data-sr-tab],[data-sr-item],[data-sr-offer]');
    if (!el || !open || !root.contains(el)) return;
    if (el.dataset.srMode) { if (el.dataset.srMode !== state.mode) { sfx.whoosh(); state.setMode(el.dataset.srMode as ShowroomMode); } return; }
    if (el.dataset.srTab) { state.selectCategory(el.dataset.srTab); return; }
    if (el.dataset.srItem) {
      sfx.select();
      state.select(el.dataset.srItem);
      const entry = state.entry(el.dataset.srItem);
      // Garage: what you own goes straight onto the car.
      if (state.mode === 'garage' && entry && state.owned(entry) && state.status(entry) !== 'equipped' && presence(entry) !== 'in-gift') void state.equip(entry.id);
      if (entry?.slot === 'horn' && entry.item) { audio.horn(entry.item.id); stage?.pulse('horn'); }
      return;
    }
    if (el.dataset.srOffer) { const [sourceId, offerId] = el.dataset.srOffer.split('|'); void redeem(sourceId!, offerId!); return; }
    const entry = state.selected();
    switch (el.dataset.sr) {
      case 'close': api.close(); break;
      case 'missions': api.close(); hooks.openMissions?.(); break;
      case 'to-shop': sfx.whoosh(); state.setMode('shop', entry?.id); break;
      case 'gift': case 'open-gift': hooks.openGift?.(); break;
      case 'earn': earnNote = null; state.openEarn(state.phase === 'earn' ? state.earnTarget()?.id ?? null : null); void economy.refresh(); break;
      case 'equip': void state.equip(); break;
      case 'drive-car': void driveCar(state.receipt?.entry.id ?? entry?.id); break;
      case 'buy': primary(); break;
      case 'retry': state.requestPurchase(state.earnTarget()?.id); break;
      case 'play': if (entry?.item) { audio.horn(entry.item.id); stage?.pulse('horn'); } break;
      case 'revert': state.revert(); break;
      case 'cancel': state.cancel(); break;
      case 'confirm': void state.confirmPurchase(); break;
      case 'done': clearCelebrate(); root.classList.remove('is-burst', 'is-charging'); cancelAnimationFrame(counterFrame); shown = view.balance; balanceEl.textContent = fmt(shown); state.finishCelebrate(); break;
    }
  };
  root.addEventListener('click', onClick);

  /** Esc and the gamepad's B: closes the top layer (tip guide, dialog, unlock sequence), then the page. */
  const back = (): void => {
    if (tipGuide) { tipGuide.close(); return; }
    if (state.phase === 'celebrate') root.querySelector<HTMLElement>('[data-sr=done]')?.click();
    else if (state.phase !== 'browse') state.cancel();
    else api.close();
  };
  const focusedIn = (layer: HTMLElement): HTMLElement | null => (document.activeElement instanceof HTMLElement && document.activeElement !== layer && layer.contains(document.activeElement) ? document.activeElement : null);
  /** Moves focus to the nearest control that way. On the page itself a rail item or tab it lands on is selected (gamepad browsing). */
  const moveFocus = (direction: 'up' | 'down' | 'left' | 'right'): void => {
    const layer = activeLayer(), current = focusedIn(layer);
    if (!current) { focusDefault(); return; }
    const next = spatialPick(focusablesIn(layer), current, direction);
    if (!next || !focusEl(next)) return;
    if (layer !== root || state.phase !== 'browse') return;
    if (next.dataset.srItem && next.getAttribute('aria-selected') !== 'true') { sfx.select(); state.select(next.dataset.srItem); }
    else if (next.dataset.srTab) state.selectCategory(next.dataset.srTab);
  };
  /** Enter on nothing in particular and the gamepad's A: press the focused control. A on the selected item runs its main action. */
  const accept = (): void => {
    const layer = activeLayer(), current = focusedIn(layer);
    if (!current) { focusDefault(); return; }
    if (layer === root && state.phase === 'browse' && current.dataset.srItem && current.getAttribute('aria-selected') === 'true') { primary(); return; }
    current.click();
  };
  const ARROWS: Readonly<Record<string, 'up' | 'down' | 'left' | 'right'>> = { ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right' };
  const onKey = (event: KeyboardEvent): void => {
    // The starter gift reveal above the page handles its own keys.
    if (!open || shell.querySelector('.lp-gf')) return;
    const target = event.target as HTMLElement | null;
    if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
    const handled = (): void => { event.preventDefault(); event.stopImmediatePropagation(); };
    if (event.key === 'Escape') { handled(); back(); return; }
    const layer = activeLayer();
    if (event.key === 'Tab') {
      // Dialogs keep Tab inside them.
      if (layer === root) return;
      handled();
      const items = focusablesIn(layer);
      const index = items.indexOf(document.activeElement as HTMLElement);
      if (items.length) focusEl(items[event.shiftKey ? (index <= 0 ? items.length - 1 : index - 1) : (index + 1) % items.length]);
      return;
    }
    if (event.key === 'Enter' || event.key === ' ') {
      if (target && root.contains(target) && target.closest('button')) {
        // The focused button clicks itself; the game's menu keys (which cancel that click) must not see the key.
        event.stopImmediatePropagation();
        if (layer === root && state.phase === 'browse' && target.closest('[data-sr-item]')?.getAttribute('aria-selected') === 'true') { event.preventDefault(); primary(); }
        return;
      }
      handled();
      if (layer === root && state.phase === 'browse') primary(); else focusDefault();
      return;
    }
    const arrow = ARROWS[event.key];
    if (!arrow) return;
    handled();
    if (layer !== root || state.phase !== 'browse') { moveFocus(arrow); return; }
    // On the page: left and right step through the items, up and down through the categories. Focus follows when it was on them.
    const inRail = railEl.contains(document.activeElement), inTabs = tabsEl.contains(document.activeElement);
    if (arrow === 'left' || arrow === 'right') { sfx.select(); state.step(arrow === 'right' ? 1 : -1); }
    else {
      const categories = state.categories, index = categories.findIndex(c => c.id === state.category().id);
      state.selectCategory(categories[(index + (arrow === 'down' ? 1 : -1) + categories.length) % categories.length]!.id);
    }
    if (inRail) focusEl(selectedItemEl()); else if (inTabs) focusEl(tabsEl.querySelector<HTMLElement>('[aria-selected=true]'));
  };
  window.addEventListener('keydown', onKey, true);

  // Orbit: one finger or the mouse turns the camera, two fingers pinch, the wheel zooms.
  const pointers = new Map<number, { x: number; y: number }>();
  let pinch = 0, flick = { vx: 0, vy: 0, t: 0 };
  const onDown = (event: PointerEvent): void => {
    if (!stage) return;
    dragEl.setPointerCapture(event.pointerId);
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    flick = { vx: 0, vy: 0, t: performance.now() };
    root.classList.add('is-orbiting');
    if (pointers.size === 2) { const [a, b] = [...pointers.values()]; pinch = Math.hypot(a!.x - b!.x, a!.y - b!.y); }
  };
  const onMove = (event: PointerEvent): void => {
    const previous = pointers.get(event.pointerId);
    if (!previous || !stage) return;
    const next = { x: event.clientX, y: event.clientY };
    pointers.set(event.pointerId, next);
    if (pointers.size >= 2) {
      const [a, b] = [...pointers.values()];
      const distance = Math.hypot(a!.x - b!.x, a!.y - b!.y);
      if (pinch > 0) stage.zoom(pinch / Math.max(1, distance));
      pinch = distance;
      return;
    }
    const dx = next.x - previous.x, dy = next.y - previous.y, now = performance.now(), dt = Math.max(1, now - flick.t);
    flick = { vx: dx / dt, vy: dy / dt, t: now };
    stage.orbit(dx, dy);
  };
  const onUp = (event: PointerEvent): void => {
    if (!pointers.delete(event.pointerId)) return;
    if (!pointers.size) {
      root.classList.remove('is-orbiting');
      if (performance.now() - flick.t < 80) stage?.fling(flick.vx, flick.vy);
    }
    pinch = 0;
  };
  const onWheel = (event: WheelEvent): void => { event.preventDefault(); stage?.zoom(Math.exp(event.deltaY * 0.0012)); };
  dragEl.addEventListener('pointerdown', onDown);
  dragEl.addEventListener('pointermove', onMove);
  dragEl.addEventListener('pointerup', onUp);
  dragEl.addEventListener('pointercancel', onUp);
  dragEl.addEventListener('wheel', onWheel, { passive: false });

  /* ------------------------------------------------------------------ lifecycle */

  let frames = 0;
  const loop = (now: number): void => {
    if (!open) return;
    frames++;
    try {
      stage?.render(now);
    } catch (error) { console.warn('LATERAL showroom frame failed', error); }
    raf = requestAnimationFrame(loop);
  };
  const statsTimer = (): void => {
    if (!stage) return;
    const s = stage.stats();
    root.dataset.calls = String(s.calls); root.dataset.tris = String(s.triangles); root.dataset.reflection = String(s.reflection); root.dataset.lights = String(s.lights); root.dataset.frames = String(frames);
  };

  if (__OWNER_REVIEW__) (window as unknown as Record<string, unknown>).__lateralShowroom = { state, stats: () => stage?.stats() ?? null, demoUnlock: (id: string) => state.demoCelebrate(id) };

  const api: Showroom = {
    get isOpen() { return open; },
    get mode() { return state.mode; },
    open(options) {
      const opts: ShowroomOpenOptions = typeof options === 'string' ? (options === 'earn' ? { mode: 'shop' } : { mode: 'shop', category: options }) : options ?? {};
      const category = typeof options === 'string' ? options : undefined;
      if (open) {
        if (opts.mode && opts.mode !== state.mode) state.setMode(opts.mode, opts.item);
        else if (opts.item) state.select(opts.item);
        if (opts.category) state.selectCategory(opts.category);
        if (category === 'earn') state.openEarn();
        if (!root.contains(document.activeElement)) focusDefault();
        return;
      }
      // State first, while still closed: its emits must not start a car load before the stage exists.
      state.reset(opts.mode ?? 'shop');
      if (opts.category) state.selectCategory(opts.category);
      if (opts.item) state.select(opts.item);
      open = true;
      const active = document.activeElement;
      opener = active instanceof HTMLElement && active !== document.body && !root.contains(active) ? active : null;
      modalOpener = null;
      root.hidden = false; root.classList.add('is-loading', 'is-entering');
      shell.classList.add('lp-showroom-open');
      view = economy.view(); shown = view.balance; balanceEl.textContent = fmt(shown); deltaEl.textContent = '';
      for (const key of Object.keys(last) as (keyof typeof last)[]) last[key] = '';
      lastCategory = state.category().id; lastSelected = ''; earnNote = null;
      const target = scene as unknown as { render: RenderableScene['render'] };
      originalRender = target.render;
      target.render = (() => undefined) as RenderableScene['render'];
      try {
        stage = createShowroomStage(scene.renderer, hooks.quality(), released => released.dispose());
        stage.setShot(state.category().shot, true);
      } catch (error) {
        console.warn('LATERAL showroom stage failed', error);
        stage = null;
      }
      carId = null; car = null; appliedKey = '';
      syncCar(); syncStage(); paint();
      if (category === 'earn') state.openEarn();
      void economy.refresh();
      raf = requestAnimationFrame(loop);
      watch = window.setInterval(() => { statsTimer(); if (open && hooks.screen() === 'drive') api.close(); }, 500);
      window.setTimeout(() => root.classList.remove('is-entering'), 900);
      // Keyboard and gamepad start on the selected item (not on Close, where one press of A or Enter would leave again).
      focusDefault();
    },
    close() {
      if (!open) return;
      open = false;
      clearCelebrate(); cancelAnimationFrame(raf); cancelAnimationFrame(counterFrame); clearInterval(watch);
      tipGuide?.close(); tipGuide = null;
      carToken++;
      plateField.show(false);
      state.reset();
      root.hidden = true; root.classList.remove('is-loading', 'is-modal', 'is-burst', 'is-charging', 'is-orbiting');
      shell.classList.remove('lp-showroom-open');
      stage?.setCar(null); stage?.dispose(); stage = null;
      car = null; carId = null; carShown = null;
      if (originalRender) (scene as unknown as { render: RenderableScene['render'] }).render = originalRender;
      originalRender = null;
      pointers.clear();
      const focusWasInside = root.contains(document.activeElement) || document.activeElement === document.body;
      hooks.onClose?.(state.mode);
      // Back to the control that opened the page (the menu may have redrawn it: then the same menu entry), unless a drive started.
      // Only a menu control counts as the opener: opened from driving (focus on the game canvas) it is the menu entry.
      const back = opener?.isConnected && shell.contains(opener) ? opener : [...shell.querySelectorAll<HTMLElement>(`[data-action="${state.mode === 'garage' ? 'garage' : 'shop'}"]`)].find(node => node.getClientRects().length > 0) ?? null;
      opener = null;
      if (focusWasInside && back && hooks.screen() !== 'drive') back.focus({ preventScroll: true });
    },
    menuAction(action) {
      // Closed, or the starter gift reveal is on top (shop-feature routes the gamepad to it): the menu handles it.
      if (!open || shell.querySelector('.lp-gf')) return false;
      if (action === 'back') back(); else if (action === 'accept') accept(); else moveFocus(action);
      return true;
    },
    balanceText: () => (view.ready ? fmt(view.balance) : ''),
    dispose() {
      api.close();
      plateField.dispose();
      offView(); offState(); for (const off of offSources) off();
      root.removeEventListener('click', onClick);
      window.removeEventListener('keydown', onKey, true);
      root.remove(); style.remove(); sfx.dispose();
    },
  };
  return api;
}
