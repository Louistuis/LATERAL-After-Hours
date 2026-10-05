/**
 * Showroom navigation: state that must survive closing mid-await, the Garage to Shop jump, and the spatial picker the
 * gamepad and dialog arrow keys use (AGENT-nav N-bugs).
 */
import { describe, expect, it, vi } from 'vitest';
import { ShowroomState } from '../../src/showroom/state';
import { spatialPick } from '../../src/showroom/ui';
import type { CosmeticItem, CosmeticSlot, Economy, EconomyView, Loadout, PurchaseResult } from '../../src/economy/types';

const item = (slot: string, id: string, price: number): CosmeticItem =>
  ({ id, slot: slot as CosmeticSlot, name: id, blurb: '', rarity: price ? 'rare' : 'stock', price, swatch: ['#fff'] });
const CATALOG: CosmeticItem[] = [item('paint', 'harbor-slate', 0), item('paint', 'sodium-flake', 650), item('underglow', 'glow-lime', 700), item('horn', 'horn-stock', 0)];

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(r => { resolve = r; });
  return { promise, resolve };
}

function setup(balance = 5000) {
  const owned = new Set<string>();
  let equipped: Loadout = {};
  const purchase = deferred<PurchaseResult>();
  const equipGate = { next: null as ReturnType<typeof deferred<void>> | null };
  const view = (): EconomyView => ({ ready: true, balance, earnedBySource: {}, spent: 0, owned, equipped, canEarn: true, storeDurable: true, lastCredit: null, error: null });
  const economy: Economy = {
    view, subscribe: () => () => {}, sources: () => [], refresh: async () => {},
    purchase: vi.fn(() => purchase.promise),
    equip: vi.fn(async (slot: CosmeticSlot, id: string | null) => {
      if (equipGate.next) await equipGate.next.promise;
      equipped = id === null ? {} : { ...equipped, [slot]: id };
    }),
    owns: (id: string) => owned.has(id) || CATALOG.some(entry => entry.id === id && entry.price === 0),
    dispose: () => {},
  };
  const state = new ShowroomState({ economy, catalog: CATALOG, equipped: () => ({ paint: 'harbor-slate', ...equipped }), currentCar: () => 'CAR-01', setStock: async () => {} });
  return { state, purchase, owned, equipGate };
}

describe('showroom state across a close', () => {
  it('a purchase that lands after the page closed does not bring the unlock sequence into the next visit', async () => {
    const { state, purchase, owned } = setup();
    state.select('sodium-flake');
    state.requestPurchase();
    expect(state.phase).toBe('confirm');
    const pending = state.confirmPurchase();
    expect(state.phase).toBe('buying');
    state.reset('garage'); // closed (and reopened) while the store was still working
    owned.add('sodium-flake');
    purchase.resolve({ ok: true, balance: 4350 });
    expect(await pending).toBeNull();
    expect(state.phase).toBe('browse');
    expect(state.receipt).toBeNull();
    expect(state.busy).toBe(false);
    expect(state.mode).toBe('garage');
  });

  it('an equip that finishes after the page closed does not clear the busy flag of the next visit', async () => {
    const { state, owned, equipGate } = setup();
    owned.add('glow-lime');
    const first = deferred<void>(), second = deferred<void>();
    equipGate.next = first;
    const old = state.equip('glow-lime');
    state.reset(); // closed and reopened while fitting
    equipGate.next = second;
    const fresh = state.equip('horn-stock');
    expect(state.busy).toBe(true);
    first.resolve();
    expect(await old).toBe(true);
    expect(state.busy).toBe(true); // the new fitting is still running
    second.resolve();
    expect(await fresh).toBe(true);
    expect(state.busy).toBe(false);
  });
});

describe('Garage to Shop', () => {
  it('Get in Shop lands on the same item, previewed, with no dialog open', () => {
    const { state } = setup();
    state.reset('garage');
    state.selectCategory('underglow');
    state.select('glow-lime');
    expect(state.status(state.entry('glow-lime')!)).toBe('buy');
    state.setMode('shop', 'glow-lime');
    expect(state.mode).toBe('shop');
    expect(state.category().id).toBe('underglow');
    expect(state.selected()?.id).toBe('glow-lime');
    expect(state.shownId('underglow')).toBe('glow-lime');
    expect(state.phase).toBe('browse');
  });

  it('switching modes closes an open confirm dialog', () => {
    const { state } = setup();
    state.select('sodium-flake');
    state.requestPurchase();
    expect(state.phase).toBe('confirm');
    state.setMode('garage');
    expect(state.phase).toBe('browse');
    expect(state.confirmEntry()).toBeNull();
  });
});

describe('spatialPick (gamepad and dialog arrows)', () => {
  const box = (name: string, left: number, top: number, width = 100, height = 80) =>
    ({ name, getBoundingClientRect: () => ({ left, top, width, height, right: left + width, bottom: top + height }) }) as unknown as HTMLElement & { name: string };
  // A rail of three cards, the selected middle one lifted 6px, and a card button above.
  const left = box('left', 0, 600), middle = box('middle', 110, 594), right = box('right', 220, 600), above = box('button', 120, 400, 160, 40);
  const all = [left, middle, right, above];
  const pick = (from: HTMLElement, direction: 'up' | 'down' | 'left' | 'right') => (spatialPick(all, from, direction) as (HTMLElement & { name: string }) | null)?.name ?? null;

  it('moves along the row and up out of it', () => {
    expect(pick(middle, 'right')).toBe('right');
    expect(pick(middle, 'left')).toBe('left');
    expect(pick(middle, 'up')).toBe('button');
    expect(pick(above, 'down')).toBe('middle');
  });
  it('does not treat a lower neighbour in the same row as "down"', () => {
    expect(pick(middle, 'down')).toBeNull();
    expect(pick(right, 'down')).toBeNull();
  });
  it('returns null at an edge', () => {
    expect(pick(right, 'right')).toBeNull();
    expect(pick(above, 'up')).toBeNull();
  });
});
