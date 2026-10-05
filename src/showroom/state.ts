/**
 * Showroom state: categories, live preview on the turntable car, revert, and the purchase flow
 * (confirm, buying, celebrate, get Marks). Pure logic over the Economy facade: no DOM, no three.js,
 * so tests drive it with a fake economy. The view (src/showroom/ui.ts) renders whatever this says.
 *
 * Preview rule: selecting anything shows it on the showroom car at once. Nothing reaches the player's
 * real loadout until it is owned and fitted (Equip, or automatically right after a purchase).
 * Cancel, closing the showroom or switching cars drops every preview.
 */
import { RARITY } from '../economy/catalog';
import { SELFHOST } from '../core/target';
import type { CatalogItem, CosmeticSlot, Economy, EconomyView, Loadout, Rarity } from '../economy/types';

/** Camera shot per category (see stage.ts). */
export type ShotId = 'car' | 'paint' | 'wheels' | 'underglow' | 'smoke' | 'plate' | 'horn' | 'earn';
/** Shop sells; Garage sets up what you own. Same stage, same state. */
export type ShowroomMode = 'shop' | 'garage';
/** Garage-only settings rendered as entries (synthetic catalog items, always owned, never sold). */
export const VIRTUAL_SLOTS: ReadonlySet<string> = new Set(['livery', 'tune', 'route', 'lighting']);

export interface ShowroomCategory {
  readonly id: string;
  readonly label: string;
  /** Catalog slots listed in this category, in display order. */
  readonly slots: readonly string[];
  readonly shot: ShotId;
}

export interface ShowroomEntry {
  /** Catalog id, or `none:<slot>` for "back to stock". */
  readonly id: string;
  readonly slot: string;
  readonly item: CatalogItem | null;
  readonly name: string;
  readonly price: number;
  readonly rarity: Rarity;
  /** Car items only: the CarId the item unlocks. */
  readonly carId: string | null;
}

export type EntryStatus = 'equipped' | 'owned' | 'buy' | 'short' | 'locked' | 'loading';
export type ShowroomPhase = 'browse' | 'confirm' | 'buying' | 'celebrate' | 'earn';

export interface PurchaseReceipt {
  readonly entry: ShowroomEntry;
  readonly before: number;
  readonly after: number;
  readonly seq: number;
}

export interface ShowroomDeps {
  readonly economy: Economy;
  /** Cosmetics and cars (kind 'car'); hidden entries are skipped. */
  readonly catalog: readonly CatalogItem[];
  /** The player's effective equipped loadout (premium equips plus the profile's stock paint and wheel style). */
  equipped(): Loadout;
  /** CarId the player drives now. */
  currentCar(): string | null;
  /** Writes a stock (free) paint or wheel style to the profile. */
  setStock(slot: 'paint' | 'wheelStyle', id: string): Promise<void>;
  /** Selects a car in the garage (car items). */
  selectCar?(carId: string): Promise<void>;
  /** Garage settings (VIRTUAL_SLOTS): what is set now and how to set it. */
  readonly extras?: { equipped(slot: string): string | undefined; equip(slot: string, id: string): Promise<void> };
}

const KNOWN: readonly ShowroomCategory[] = [
  { id: 'car', label: 'Cars', slots: ['car'], shot: 'car' },
  { id: 'paint', label: 'Paint', slots: ['paint'], shot: 'paint' },
  { id: 'wheels', label: 'Wheels', slots: ['rim', 'wheelStyle'], shot: 'wheels' },
  { id: 'underglow', label: 'Underglow', slots: ['underglow'], shot: 'underglow' },
  { id: 'smoke', label: 'Smoke', slots: ['smoke'], shot: 'smoke' },
  { id: 'plate', label: 'Plates', slots: ['plate'], shot: 'plate' },
  { id: 'horn', label: 'Horns', slots: ['horn'], shot: 'horn' },
  { id: 'livery', label: 'Livery', slots: ['livery'], shot: 'paint' },
  { id: 'tune', label: 'Tune', slots: ['tune'], shot: 'car' },
  { id: 'track', label: 'Track', slots: ['route', 'lighting'], shot: 'earn' },
];
/** Slots with a free "nothing fitted" option. */
const NONE_SLOTS = new Set(['rim', 'underglow', 'smoke', 'plate']);
export const NONE_LABEL: Readonly<Record<string, string>> = { rim: 'Factory finish', underglow: 'No glow', smoke: 'Stock smoke', plate: 'Stock plate' };
/** What a slot shows when nothing is equipped. */
const STOCK_DEFAULT: Readonly<Record<string, string>> = { paint: 'harbor-slate', wheelStyle: 'forged', horn: 'horn-stock' };

const titleCase = (value: string): string => value.replace(/([A-Z])/g, ' $1').replace(/^./, c => c.toUpperCase());

/** CarId for a car catalog item, null for cosmetics. */
export function carIdOf(item: CatalogItem | null | undefined): string | null {
  return item && item.kind === 'car' ? item.carId : null;
}

export function categoriesFor(catalog: readonly CatalogItem[]): ShowroomCategory[] {
  const present = new Set(catalog.filter(item => !item.hidden).map(item => item.slot as string));
  const out = KNOWN.filter(category => category.slots.some(slot => present.has(slot)))
    .map(category => ({ ...category, slots: category.slots.filter(slot => present.has(slot)) }));
  const covered = new Set(out.flatMap(category => category.slots));
  for (const slot of present) if (!covered.has(slot)) out.push({ id: slot, label: titleCase(slot), slots: [slot], shot: 'paint' });
  return out;
}

export function entryFor(item: CatalogItem): ShowroomEntry {
  return { id: item.id, slot: item.slot, item, name: item.name, price: item.price, rarity: item.rarity, carId: carIdOf(item) };
}
export function noneEntry(slot: string): ShowroomEntry {
  return { id: `none:${slot}`, slot, item: null, name: NONE_LABEL[slot] ?? 'None', price: 0, rarity: 'stock', carId: null };
}

const byRarity = (a: CatalogItem, b: CatalogItem): number => RARITY[a.rarity].rank - RARITY[b.rarity].rank || a.price - b.price;

export class ShowroomState {
  private readonly allCategories: readonly ShowroomCategory[];
  private modeValue: ShowroomMode = 'shop';
  private categoryId: string;
  /** Preview per slot: an entry id that differs from what is equipped. */
  private previews = new Map<string, string>();
  /** Last entry looked at per category. */
  private focus = new Map<string, string>();
  private phaseValue: ShowroomPhase = 'browse';
  private confirmId: string | null = null;
  private earnTargetId: string | null = null;
  private receiptValue: PurchaseReceipt | null = null;
  private noteValue: { text: string; calm: boolean } | null = null;
  private busyValue = false;
  private seq = 0;
  /** Bumped by reset(): an await that started before the page closed must not write into the next visit. */
  private epoch = 0;
  private readonly listeners = new Set<() => void>();
  private readonly byId: Map<string, ShowroomEntry>;

  constructor(private readonly deps: ShowroomDeps) {
    this.allCategories = categoriesFor(deps.catalog);
    // Cars are the headline category when the catalog sells them.
    this.categoryId = this.categories[0]?.id ?? 'paint';
    this.byId = new Map(deps.catalog.map(item => [item.id, entryFor(item)]));
  }

  /* ------------------------------------------------------------------ reading */

  get phase(): ShowroomPhase { return this.phaseValue; }
  get mode(): ShowroomMode { return this.modeValue; }
  /** Tabs for the current mode: the shop never lists garage settings. */
  get categories(): readonly ShowroomCategory[] {
    return this.modeValue === 'garage' ? this.allCategories : this.allCategories.filter(c => !c.slots.every(slot => VIRTUAL_SLOTS.has(slot)));
  }
  get busy(): boolean { return this.busyValue; }
  get note(): { text: string; calm: boolean } | null { return this.noteValue; }
  get receipt(): PurchaseReceipt | null { return this.receiptValue; }
  view(): EconomyView { return this.deps.economy.view(); }
  category(): ShowroomCategory { return this.categories.find(c => c.id === this.categoryId) ?? this.categories[0]!; }

  entry(id: string | null | undefined): ShowroomEntry | null {
    if (!id) return null;
    if (id.startsWith('none:')) return noneEntry(id.slice(5));
    return this.byId.get(id) ?? null;
  }
  /** Entries of a category, grouped per slot, cheapest rarity first, "none" first where it exists. */
  entries(categoryId = this.categoryId): ShowroomEntry[] {
    const category = this.allCategories.find(c => c.id === categoryId);
    if (!category) return [];
    return category.slots.flatMap(slot => [
      ...(NONE_SLOTS.has(slot) ? [noneEntry(slot)] : []),
      ...this.deps.catalog.filter(item => item.slot === slot && !item.hidden).sort(byRarity).map(item => this.byId.get(item.id)!),
    ]);
  }
  equippedId(slot: string): string {
    if (slot === 'car') {
      const car = this.deps.currentCar();
      const match = this.deps.catalog.find(item => item.slot === slot && carIdOf(item) === car);
      return match?.id ?? `car:${car ?? ''}`;
    }
    if (VIRTUAL_SLOTS.has(slot)) return this.deps.extras?.equipped(slot) ?? `none:${slot}`;
    const equipped = this.deps.equipped() as Record<string, string | undefined>;
    return equipped[slot] ?? STOCK_DEFAULT[slot] ?? `none:${slot}`;
  }
  /** What the turntable car shows for a slot (preview first). */
  shownId(slot: string): string { return this.previews.get(slot) ?? this.equippedId(slot); }
  /** The entry the detail card describes. */
  selected(): ShowroomEntry | null {
    const category = this.category();
    const focused = this.entry(this.focus.get(category.id));
    if (focused) return focused;
    for (const slot of category.slots) {
      const shown = this.entry(this.shownId(slot));
      if (shown) return shown;
    }
    return this.entries()[0] ?? null;
  }
  owned(entry: ShowroomEntry): boolean {
    return !entry.item || VIRTUAL_SLOTS.has(entry.slot) || this.deps.economy.owns(entry.id) || this.view().owned.has(entry.id);
  }
  status(entry: ShowroomEntry): EntryStatus {
    if (this.equippedId(entry.slot) === entry.id) return 'equipped';
    if (this.owned(entry)) return 'owned';
    const view = this.view();
    if (!view.ready) return 'loading';
    if (view.balance >= entry.price) return 'buy';
    return view.canEarn ? 'short' : 'locked';
  }
  shortfall(entry: ShowroomEntry | null): number {
    if (!entry || this.owned(entry)) return 0;
    return Math.max(0, entry.price - this.view().balance);
  }
  /** Loadout the showroom car should wear: equipped plus every preview. */
  previewLoadout(): Loadout {
    const out = { ...this.deps.equipped() } as Record<string, string>;
    for (const [slot, id] of this.previews) {
      if (slot === 'car' || VIRTUAL_SLOTS.has(slot)) continue;
      if (id.startsWith('none:')) delete out[slot]; else out[slot] = id;
    }
    return out as Loadout;
  }
  /** CarId on the turntable. */
  previewCar(): string | null {
    const id = this.previews.get('car');
    return (id ? this.entry(id)?.carId : null) ?? this.deps.currentCar();
  }
  /** True when the car shows anything the player has not fitted. */
  dirty(): boolean { return this.previews.size > 0; }
  previewedSlots(): string[] { return [...this.previews.keys()]; }
  confirmEntry(): ShowroomEntry | null { return this.entry(this.confirmId); }
  earnTarget(): ShowroomEntry | null { return this.entry(this.earnTargetId); }

  /* ------------------------------------------------------------------ actions */

  subscribe(listener: () => void): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  private emit(): void { for (const listener of this.listeners) listener(); }

  selectCategory(id: string): void {
    if (!this.categories.some(c => c.id === id) || id === this.categoryId) return;
    this.categoryId = id; this.noteValue = null;
    if (this.phaseValue === 'earn') this.phaseValue = 'browse';
    this.emit();
  }
  /** Try an entry on the car. */
  select(id: string): void {
    const entry = this.entry(id);
    if (!entry || this.phaseValue === 'buying' || this.phaseValue === 'celebrate') return;
    const category = this.categories.find(c => c.slots.includes(entry.slot));
    if (category) { this.categoryId = category.id; this.focus.set(category.id, id); }
    if (this.equippedId(entry.slot) === id) this.previews.delete(entry.slot);
    else this.previews.set(entry.slot, id);
    this.noteValue = null;
    if (this.phaseValue === 'confirm') { this.phaseValue = 'browse'; this.confirmId = null; }
    this.emit();
  }
  /** Moves the selection by `step` inside the current category (keyboard and swipe). */
  step(step: number): void {
    const list = this.entries();
    if (!list.length) return;
    const index = Math.max(0, list.findIndex(entry => entry.id === this.selected()?.id));
    this.select(list[(index + step + list.length) % list.length]!.id);
  }
  /** Drops previews (one slot, or all) and puts the car back to what is fitted. */
  revert(slot?: string): void {
    if (slot) { this.previews.delete(slot); this.focus.delete(this.categories.find(c => c.slots.includes(slot))?.id ?? ''); }
    else { this.previews.clear(); this.focus.clear(); }
    this.noteValue = null;
    this.emit();
  }
  /** Buy button: confirm when affordable, otherwise the Get Marks sheet with the exact shortfall. */
  requestPurchase(id = this.selected()?.id): void {
    const entry = this.entry(id);
    if (!entry || this.busyValue) return;
    const status = this.status(entry);
    if (status === 'buy') { this.confirmId = entry.id; this.phaseValue = 'confirm'; }
    else if (status === 'short') { this.earnTargetId = entry.id; this.phaseValue = 'earn'; }
    else if (status === 'locked') this.noteValue = { text: SELFHOST ? 'Your Marks do not cover this item yet. It unlocks when they do.' : 'Marks are earned in the websim edition. This stays locked here.', calm: true };
    this.emit();
  }
  cancel(): void {
    if (this.phaseValue === 'confirm') { this.confirmId = null; this.phaseValue = 'browse'; }
    else if (this.phaseValue === 'earn') { this.phaseValue = 'browse'; }
    else if (this.phaseValue === 'celebrate') { this.receiptValue = null; this.phaseValue = 'browse'; }
    else this.revert();
    this.emit();
  }
  openEarn(targetId: string | null = null): void {
    this.earnTargetId = targetId; this.phaseValue = 'earn'; this.noteValue = null; this.emit();
  }
  async confirmPurchase(): Promise<PurchaseReceipt | null> {
    const entry = this.confirmEntry();
    if (!entry || this.phaseValue !== 'confirm' || this.busyValue) return null;
    const before = this.view().balance, epoch = this.epoch;
    this.busyValue = true; this.phaseValue = 'buying'; this.emit();
    const result = await this.deps.economy.purchase(entry.id)
      .catch(() => ({ ok: false as const, reason: 'store-failed' as const, message: 'The purchase did not go through.' }));
    // Closed (or reopened) while buying: the item is bought, but this visit's dialogs and previews are gone.
    if (epoch !== this.epoch) return null;
    this.busyValue = false; this.confirmId = null;
    if (!result.ok) {
      if (result.reason === 'insufficient') { this.earnTargetId = entry.id; this.phaseValue = 'earn'; }
      else { this.phaseValue = 'browse'; this.noteValue = { text: result.message, calm: false }; }
      this.emit();
      return null;
    }
    const receipt: PurchaseReceipt = { entry, before, after: result.balance, seq: ++this.seq };
    this.receiptValue = receipt; this.phaseValue = 'celebrate'; this.emit();
    // Cosmetics are fitted at once; a new car waits for "Drive this car".
    if (!entry.carId) await this.equip(entry.id);
    else { this.previews.delete('car'); this.focus.set('car', entry.id); this.previews.set('car', entry.id); }
    return receipt;
  }
  /** Ends the unlock sequence. */
  finishCelebrate(): void {
    if (this.phaseValue !== 'celebrate') return;
    this.receiptValue = null; this.phaseValue = 'browse'; this.emit();
  }
  /** Fits an owned entry to the player's car. */
  async equip(id = this.selected()?.id): Promise<boolean> {
    const entry = this.entry(id);
    if (!entry || !this.owned(entry)) return false;
    const economy = this.deps.economy;
    const slot = entry.slot as CosmeticSlot;
    this.busyValue = true; this.emit();
    let ok = true;
    const epoch = this.epoch;
    try {
      if (VIRTUAL_SLOTS.has(entry.slot)) await this.deps.extras?.equip(entry.slot, entry.id);
      else if (entry.carId) {
        await this.deps.selectCar?.(entry.carId);
      } else if ((slot === 'paint' || slot === 'wheelStyle') && entry.item && entry.price === 0) {
        await economy.equip(slot, null);
        await this.deps.setStock(slot, entry.id);
      } else await economy.equip(slot, entry.item ? entry.id : null);
    } catch {
      ok = false;
      this.noteValue = { text: 'Could not fit that part. Try again.', calm: false };
    }
    if (epoch !== this.epoch) return ok;
    if (ok) this.previews.delete(entry.slot);
    this.busyValue = false;
    this.emit();
    return ok;
  }
  /** Switch between Shop and Garage. Previews stay, so a locked item tried in the garage carries into the shop. */
  setMode(mode: ShowroomMode, focusId?: string): void {
    this.modeValue = mode;
    if (this.phaseValue !== 'browse' && this.phaseValue !== 'celebrate') { this.phaseValue = 'browse'; this.confirmId = null; }
    if (!this.categories.some(c => c.id === this.categoryId)) this.categoryId = this.categories[0]?.id ?? this.categoryId;
    this.noteValue = null;
    const entry = this.entry(focusId);
    if (entry) this.select(entry.id); else this.emit();
  }
  /** Owner-review only: plays the unlock sequence for an entry without buying it. */
  demoCelebrate(id: string): void {
    const entry = this.entry(id);
    if (!entry) return;
    const before = Math.max(this.view().balance, entry.price);
    this.receiptValue = { entry, before, after: before - entry.price, seq: ++this.seq };
    this.phaseValue = 'celebrate'; this.emit();
  }
  setNote(text: string | null, calm = true): void { this.noteValue = text ? { text, calm } : null; this.emit(); }
  /** Closing the showroom: drop previews and any open dialog. */
  reset(mode: ShowroomMode = this.modeValue): void {
    this.modeValue = mode; this.epoch++;
    this.categoryId = this.categories[0]?.id ?? this.categoryId;
    this.previews.clear(); this.focus.clear(); this.confirmId = null; this.earnTargetId = null;
    this.receiptValue = null; this.noteValue = null; this.phaseValue = 'browse'; this.busyValue = false;
    this.emit();
  }
}
