import { describe, expect, it, vi } from 'vitest';
import { carIdOf, categoriesFor, ShowroomState } from '../../src/showroom/state';
import type { CatalogItem, CosmeticItem, CosmeticSlot, Economy, EconomyView, Loadout, PurchaseResult } from '../../src/economy/types';

const item = (slot: string, id: string, price: number, rarity: CosmeticItem['rarity'] = price ? 'rare' : 'stock'): CosmeticItem =>
  ({ id, slot: slot as CosmeticSlot, name: id, blurb: '', rarity, price, swatch: ['#fff'] });

const CATALOG: CosmeticItem[] = [
  item('paint', 'harbor-slate', 0), item('paint', 'carbon', 0), item('paint', 'sodium-flake', 650), item('paint', 'gold-chrome', 3000, 'legendary'),
  item('rim', 'rim-gold', 900), item('wheelStyle', 'forged', 0), item('wheelStyle', 'mesh', 0),
  item('underglow', 'glow-lime', 700), item('smoke', 'smoke-lime', 500), item('horn', 'horn-stock', 0), item('horn', 'horn-bell', 800),
];

function fakeEconomy(balance: number, options: { canEarn?: boolean; failWith?: PurchaseResult } = {}) {
  const owned = new Set<string>();
  let equipped: Loadout = {};
  let current = balance;
  const listeners = new Set<(view: EconomyView) => void>();
  const view = (): EconomyView => ({ ready: true, balance: current, earnedBySource: {}, spent: balance - current, owned, equipped, canEarn: options.canEarn ?? true, storeDurable: true, lastCredit: null, error: null });
  const priceOf = (id: string) => CATALOG.find(entry => entry.id === id)?.price ?? 0;
  const economy: Economy = {
    view, subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener); },
    sources: () => [], refresh: async () => {},
    purchase: vi.fn(async (id: string): Promise<PurchaseResult> => {
      if (options.failWith) return options.failWith;
      if (owned.has(id)) return { ok: false, reason: 'owned', message: 'Owned' };
      if (current < priceOf(id)) return { ok: false, reason: 'insufficient', message: 'Not enough' };
      current -= priceOf(id); owned.add(id);
      return { ok: true, balance: current };
    }),
    equip: vi.fn(async (slot: CosmeticSlot, id: string | null) => {
      const next = { ...equipped };
      if (id === null) delete next[slot]; else next[slot] = id;
      equipped = next;
    }),
    owns: (id: string) => priceOf(id) === 0 ? CATALOG.some(entry => entry.id === id) : owned.has(id),
    dispose: () => {},
  };
  return { economy, grant: (amount: number) => { current += amount; }, equipped: () => equipped };
}

function setup(balance: number, options?: Parameters<typeof fakeEconomy>[1]) {
  const fake = fakeEconomy(balance, options);
  let stock: Loadout = { paint: 'carbon', wheelStyle: 'forged' };
  const setStock = vi.fn(async (slot: 'paint' | 'wheelStyle', id: string) => { stock = { ...stock, [slot]: id }; });
  const state = new ShowroomState({
    economy: fake.economy, catalog: CATALOG,
    equipped: () => ({ ...stock, ...fake.equipped() }),
    currentCar: () => 'CAR-01', setStock,
  });
  return { state, fake, setStock };
}

describe('showroom categories', () => {
  it('builds tabs only for slots in the catalog, wheels merge rim and wheel style', () => {
    const ids = categoriesFor(CATALOG).map(category => category.id);
    expect(ids).toEqual(['paint', 'wheels', 'underglow', 'smoke', 'horn']);
    expect(categoriesFor(CATALOG).find(c => c.id === 'wheels')!.slots).toEqual(['rim', 'wheelStyle']);
  });
  it('supports a car kind and unknown future slots gracefully', () => {
    const car: CatalogItem = { id: 'car-cybertruck', kind: 'car', slot: 'car', carId: 'CAR-02', name: 'Cybertruck', blurb: '', rarity: 'epic', price: 2500, swatch: ['#999'] };
    const hidden = { ...car, id: 'car-hidden', carId: 'CAR-03', hidden: true } as CatalogItem;
    const withCars: CatalogItem[] = [...CATALOG, car, hidden, item('exhaust', 'pipe', 300)];
    const categories = categoriesFor(withCars);
    expect(categories[0]!.id).toBe('car');
    expect(categories.at(-1)).toMatchObject({ id: 'exhaust', label: 'Exhaust' });
    expect(carIdOf(car)).toBe('CAR-02');
    expect(carIdOf(CATALOG[0])).toBeNull();
    const state = new ShowroomState({ economy: fakeEconomy(0).economy, catalog: withCars, equipped: () => ({}), currentCar: () => 'CAR-01', setStock: async () => {} });
    expect(state.entries('car').map(entry => entry.id)).toEqual(['car-cybertruck']);
    expect(state.category().id).toBe('car');
    state.select('car-cybertruck');
    expect(state.previewCar()).toBe('CAR-02');
    state.cancel();
    expect(state.previewCar()).toBe('CAR-01');
    expect(state.status(state.entry('car-cybertruck')!)).toBe('short');
  });
});

describe('showroom preview and revert', () => {
  it('previews on the car without touching the real loadout, and cancel reverts', () => {
    const { state, fake } = setup(100);
    state.select('gold-chrome');
    state.select('glow-lime');
    expect(state.previewLoadout()).toMatchObject({ paint: 'gold-chrome', underglow: 'glow-lime' });
    expect(state.dirty()).toBe(true);
    expect(fake.economy.equip).not.toHaveBeenCalled();
    state.cancel();
    expect(state.dirty()).toBe(false);
    expect(state.previewLoadout()).toEqual({ paint: 'carbon', wheelStyle: 'forged' });
  });
  it('a "none" entry previews the slot as empty, selecting the fitted item clears that preview', () => {
    const { state } = setup(5000);
    state.select('none:underglow');
    expect(state.previewLoadout().underglow).toBeUndefined();
    state.select('sodium-flake');
    state.select('carbon');
    expect(state.previewedSlots()).not.toContain('paint');
  });
  it('reports equipped, owned, buy, short and locked states', async () => {
    const { state } = setup(700);
    expect(state.status(state.entry('carbon')!)).toBe('equipped');
    expect(state.status(state.entry('harbor-slate')!)).toBe('owned');
    expect(state.status(state.entry('sodium-flake')!)).toBe('buy');
    expect(state.status(state.entry('gold-chrome')!)).toBe('short');
    expect(state.shortfall(state.entry('gold-chrome'))).toBe(2300);
    const locked = setup(0, { canEarn: false }).state;
    expect(locked.status(locked.entry('gold-chrome')!)).toBe('locked');
  });
  it('steps through a category with wrap around', () => {
    const { state } = setup(0);
    state.selectCategory('horn');
    state.step(1);
    expect(state.selected()?.id).toBe('horn-bell');
    state.step(1);
    expect(state.selected()?.id).toBe('horn-stock');
  });
});

describe('showroom purchase flow', () => {
  it('confirm, buy, celebrate with a receipt, then the item is fitted', async () => {
    const { state, fake } = setup(1000);
    state.select('sodium-flake');
    state.requestPurchase();
    expect(state.phase).toBe('confirm');
    expect(state.confirmEntry()?.id).toBe('sodium-flake');
    const receipt = await state.confirmPurchase();
    expect(receipt).toMatchObject({ before: 1000, after: 350 });
    expect(state.phase).toBe('celebrate');
    expect(fake.economy.equip).toHaveBeenCalledWith('paint', 'sodium-flake');
    expect(state.status(state.entry('sodium-flake')!)).toBe('equipped');
    expect(state.dirty()).toBe(false);
    state.finishCelebrate();
    expect(state.phase).toBe('browse');
  });
  it('cancel in the confirm dialog buys nothing', () => {
    const { state, fake } = setup(1000);
    state.select('glow-lime');
    state.requestPurchase();
    state.cancel();
    expect(state.phase).toBe('browse');
    expect(fake.economy.purchase).not.toHaveBeenCalled();
    expect(state.previewLoadout().underglow).toBe('glow-lime');
  });
  it('not enough Marks routes to Get Marks with the exact shortfall and back once affordable', () => {
    const { state, fake } = setup(200);
    state.select('glow-lime');
    state.requestPurchase();
    expect(state.phase).toBe('earn');
    expect(state.earnTarget()?.id).toBe('glow-lime');
    expect(state.shortfall(state.earnTarget())).toBe(500);
    fake.grant(500);
    expect(state.shortfall(state.earnTarget())).toBe(0);
    state.requestPurchase(state.earnTarget()!.id);
    expect(state.phase).toBe('confirm');
  });
  it('a failed store write keeps browsing with the message', async () => {
    const { state } = setup(1000, { failWith: { ok: false, reason: 'store-failed', message: 'Nope' } });
    state.select('smoke-lime');
    state.requestPurchase();
    await state.confirmPurchase();
    expect(state.phase).toBe('browse');
    expect(state.note?.text).toBe('Nope');
  });
  it('fitting a free stock paint goes through the profile, a premium one through the economy', async () => {
    const { state, fake, setStock } = setup(1000);
    await state.equip('harbor-slate');
    expect(fake.economy.equip).toHaveBeenCalledWith('paint', null);
    expect(setStock).toHaveBeenCalledWith('paint', 'harbor-slate');
    expect(await state.equip('gold-chrome')).toBe(false);
  });
  it('a bought car waits for Drive this car before it is selected', async () => {
    const fake = fakeEconomy(9000);
    const priced: CatalogItem = { id: 'car-f1', kind: 'car', slot: 'car', carId: 'CAR-02', name: 'F1', blurb: '', rarity: 'legendary', price: 8000, swatch: ['#f80'] };
    const selectCar = vi.fn(async () => {});
    const purchase = fake.economy.purchase as ReturnType<typeof vi.fn>;
    purchase.mockImplementation(async () => ({ ok: true, balance: 1000 }));
    const state = new ShowroomState({ economy: { ...fake.economy, owns: id => id === 'car-f1' && purchase.mock.calls.length > 0 }, catalog: [...CATALOG, priced], equipped: () => ({}), currentCar: () => 'CAR-01', setStock: async () => {}, selectCar });
    state.select('car-f1');
    state.requestPurchase();
    expect(await state.confirmPurchase()).toMatchObject({ before: 9000, after: 1000 });
    expect(selectCar).not.toHaveBeenCalled();
    expect(state.previewCar()).toBe('CAR-02');
    expect(await state.equip('car-f1')).toBe(true);
    expect(selectCar).toHaveBeenCalledWith('CAR-02');
  });
  it('reset on close drops previews and dialogs', () => {
    const { state } = setup(1000);
    state.select('rim-gold');
    state.requestPurchase();
    state.reset();
    expect(state.phase).toBe('browse');
    expect(state.dirty()).toBe(false);
  });
});

describe('garage mode', () => {
  const virtual = (slot: string, id: string): CatalogItem => ({ ...item(slot, `${slot}:${id}`, 0), slot } as unknown as CatalogItem);
  function garage() {
    const fake = fakeEconomy(0);
    const current: Record<string, string> = { livery: 'livery:stock', tune: 'tune:Balanced', route: 'route:HW-01', lighting: 'lighting:golden-hour' };
    const equip = vi.fn(async (slot: string, id: string) => { current[slot] = id; });
    const state = new ShowroomState({
      economy: fake.economy, catalog: [...CATALOG, virtual('livery', 'stock'), virtual('livery', 'salt-line'), virtual('tune', 'Balanced'), virtual('tune', 'Drift'), virtual('route', 'HW-01')],
      equipped: () => ({ paint: 'carbon' }), currentCar: () => 'CAR-01', setStock: async () => {},
      extras: { equipped: slot => current[slot], equip },
    });
    return { state, equip, fake };
  }
  it('lists garage settings only in Garage mode', () => {
    const { state } = garage();
    expect(state.categories.map(c => c.id)).not.toContain('tune');
    state.setMode('garage');
    expect(state.categories.map(c => c.id)).toEqual(expect.arrayContaining(['livery', 'tune', 'track']));
  });
  it('settings are always owned and set through the extras port', async () => {
    const { state, equip } = garage();
    state.setMode('garage');
    expect(state.status(state.entry('tune:Balanced')!)).toBe('equipped');
    expect(state.status(state.entry('tune:Drift')!)).toBe('owned');
    expect(await state.equip('tune:Drift')).toBe(true);
    expect(equip).toHaveBeenCalledWith('tune', 'tune:Drift');
    expect(state.status(state.entry('tune:Drift')!)).toBe('equipped');
    expect(state.previewLoadout()).toEqual({ paint: 'carbon' });
  });
  it('a locked item tried in the garage carries into the shop', () => {
    const { state } = garage();
    state.setMode('garage');
    state.select('gold-chrome');
    expect(state.status(state.entry('gold-chrome')!)).toBe('short');
    state.setMode('shop', 'gold-chrome');
    expect(state.mode).toBe('shop');
    expect(state.selected()?.id).toBe('gold-chrome');
    expect(state.previewLoadout().paint).toBe('gold-chrome');
  });
});
