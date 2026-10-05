import { describe, expect, it } from 'vitest';
import { VEHICLE_CONFIGS } from '../../src/vehicle/configs';
import { STARTER_CAR } from '../../src/vehicle/starter-car';
import { CAR_CATALOG, CATALOG, ITEMS, STARTER, auditCatalog, carItem, catalogEntry, catalogItem, isCarItem, itemKind, priceOf, shopCars } from '../../src/economy/catalog';
import { TIP_PACKS, marksForTipCredits } from '../../src/economy/tips';

describe('stripped starting garage', () => {
  it('passes the catalog audit and has unique ids', () => {
    expect(auditCatalog()).toEqual([]);
    expect(new Set(ITEMS.map(item => item.id)).size).toBe(ITEMS.length);
  });
  it('gives a new player exactly one car, one paint, stock wheels and the stock horn', () => {
    const free = ITEMS.filter(item => item.price === 0).map(item => item.id).sort();
    expect(free).toEqual(['car-challenger', 'forged', 'harbor-slate', 'horn-stock']);
    expect(STARTER.car).toBe(STARTER_CAR);
    expect(carItem(STARTER_CAR)?.price).toBe(0);
    expect(STARTER.loadout).toEqual({ paint: 'harbor-slate', wheelStyle: 'forged', horn: 'horn-stock' });
    // No free underglow, rims, smoke or plate items: those slots start empty (basic smoke and plate, no glow).
    for (const slot of ['underglow', 'rim', 'smoke', 'plate'] as const) expect(CATALOG.filter(item => item.slot === slot && item.price === 0)).toEqual([]);
    expect(priceOf(['harbor-slate', 'forged', 'horn-stock', 'car-challenger'])).toBe(0);
  });
  it('prices cosmetics 190 to 2490 (the custom plate aside) and premium cars 2990 to 8990, all ending in 50 or 90', () => {
    for (const item of CATALOG.filter(entry => entry.price > 0 && entry.id !== 'plate-custom')) {
      expect(item.price, item.id).toBeGreaterThanOrEqual(190);
      expect(item.price, item.id).toBeLessThanOrEqual(2490);
      expect([50, 90], item.id).toContain(item.price % 100);
    }
    expect(STARTER_CAR).toBe('CAR-01');
    const truck = carItem('CAR-02')!;
    for (const premium of CAR_CATALOG.filter(entry => entry.price > 0)) {
      expect(premium.price).toBeGreaterThanOrEqual(2990);
      expect(premium.price).toBeLessThanOrEqual(8990);
      expect([50, 90]).toContain(premium.price % 100);
    }
    expect(truck.price).toBe(4990);
    // Cars are the most expensive things in the game: every premium car costs more than every cosmetic.
    const dearestCosmetic = Math.max(...CATALOG.filter(entry => entry.id !== 'plate-custom').map(entry => entry.price));
    for (const premium of CAR_CATALOG.filter(entry => entry.price > 0)) expect(premium.price).toBeGreaterThan(dearestCosmetic);
  });
  it('the custom plate is the most expensive item in the game: 9990, above every car and every cosmetic', () => {
    const custom = catalogItem('plate-custom')!;
    expect(custom).toMatchObject({ slot: 'plate', price: 9990, rarity: 'legendary' });
    expect([50, 90]).toContain(custom.price % 100);
    for (const entry of ITEMS.filter(item => item.id !== 'plate-custom')) expect(entry.price).toBeLessThan(custom.price);
    expect(auditCatalog()).toEqual([]);
  });
  it('the 200 credit pack buys real things, and the packs line up with the ladder', () => {
    const budget = marksForTipCredits(TIP_PACKS[0]!.credits);
    expect(budget).toBe(200);
    expect(CATALOG.filter(item => item.price === 190).length).toBeGreaterThanOrEqual(2);
    expect(marksForTipCredits(2500)).toBe(3550);
    expect(priceOf(['gold-chrome'])).toBeLessThanOrEqual(2490);
  });
  it('every roster car has exactly one catalog item; cars are kind car and slot car', () => {
    // CAR-03 (the removed procedural car) is deliberately not sold. Any other roster car without a catalog item fails here:
    // add its item to CAR_CATALOG (the Formula 1 halo car goes in at 7990 once its CarId exists).
    const unlisted = new Set(['CAR-03']);
    for (const carId of Object.keys(VEHICLE_CONFIGS)) expect(CAR_CATALOG.filter(item => item.carId === carId), carId).toHaveLength(unlisted.has(carId) ? 0 : 1);
    for (const entry of CAR_CATALOG) expect(Object.keys(VEHICLE_CONFIGS)).toContain(entry.carId);
    expect(CAR_CATALOG.filter(entry => entry.price === 0).map(entry => entry.carId)).toEqual([STARTER_CAR]);
    for (const car of CAR_CATALOG) { expect(car.kind).toBe('car'); expect(car.slot).toBe('car'); expect(isCarItem(catalogEntry(car.id))).toBe(true); expect(itemKind(car.id)).toBe('car'); }
    expect(itemKind('gold-chrome')).toBe('cosmetic');
    expect(itemKind('nope')).toBeUndefined();
    expect(catalogItem('car-cybertruck')).toBeUndefined();
    expect(shopCars().map(car => car.carId)).toEqual(expect.arrayContaining(['CAR-01', 'CAR-02']));
    expect(carItem('CAR-03' as never)).toBeUndefined();
  });
  it('has no em dashes in any copy', () => {
    for (const item of ITEMS) expect(`${item.name} ${item.blurb}`).not.toMatch(/—/);
  });
});
