/**
 * The cosmetic catalog. Cosmetic only: nothing here changes physics, grip, power or scoring.
 * Stock items (price 0) are always owned: one paint, one wheel style, the stock horn and the starter car.
 * Everything else is bought with Marks. Copy rule: no em dashes in names or blurbs.
 */
import type { CarId } from '../../contracts/runtime-contracts';
import { STARTER_CAR } from '../vehicle/starter-car';
import { CUSTOM_PLATE_ID, cleanPlateText, decodePlateText, encodePlateText } from './plate';
import type { CarItem, CatalogItem, CosmeticItem, CosmeticSlot, ItemKind, Loadout, Rarity } from './types';

/**
 * Price ladder (Marks). 1 websim credit = 1 Mark (tip packs: 200 = 200, 500 = 590, 1000 = 1250, 2500 = 3550);
 * driving pays at most 25 Marks a day. Prices end in 50 or 90, like the packs, so a pack total reads cleanly:
 *   solid colours, basic horn and smoke   190-290   (the 200 pack buys one or two)
 *   rims, plates, wheel styles, horns     250-990
 *   metallic / matte / glow / rare finish 390-950
 *   pearls, chrome, spectrum glow         1190-1590
 *   legendary paints                      1890-2490
 *   cars (premium, above every cosmetic)  2990 (Lancia Delta), 4990 (Cybertruck), 7990 (Formula 1) and 8990 (Agera halo car)
 *   custom plate (type your own text)     9990, the most expensive item in the game
 */

export const SLOTS: readonly { readonly slot: CosmeticSlot; readonly label: string; readonly short: string }[] = [
  { slot: 'paint', label: 'Paint', short: 'Paint' },
  { slot: 'rim', label: 'Wheels', short: 'Wheels' },
  { slot: 'underglow', label: 'Underglow', short: 'Glow' },
  { slot: 'smoke', label: 'Tyre smoke', short: 'Smoke' },
  { slot: 'plate', label: 'Plates', short: 'Plates' },
  { slot: 'horn', label: 'Horns', short: 'Horns' },
];

export const RARITY: Readonly<Record<Rarity, { readonly label: string; readonly rank: number }>> = {
  stock: { label: 'Stock', rank: 0 },
  standard: { label: 'Standard', rank: 1 },
  rare: { label: 'Rare', rank: 2 },
  epic: { label: 'Epic', rank: 3 },
  legendary: { label: 'Legendary', rank: 4 },
};

const item = (slot: CosmeticSlot, id: string, name: string, rarity: Rarity, price: number, swatch: readonly string[], blurb: string,
  finish?: CosmeticItem['finish']): CosmeticItem => ({ id, slot, name, rarity, price, swatch, blurb, ...(finish ? { finish } : {}) });

/** The garage's base palette (src/world/index.ts PAINTS). Only Harbor Slate is free; the other solid colours are cheap purchases. */
const BASE_PAINTS: readonly CosmeticItem[] = [
  item('paint', 'harbor-slate', 'Harbor Slate', 'stock', 0, ['#435e69'], 'Factory finish. Cold steel blue from the quay.', 'gloss'),
  item('paint', 'oxide-copper', 'Oxide Copper', 'standard', 190, ['#a85e43'], 'Weathered bollard copper.', 'gloss'),
  item('paint', 'salt-white', 'Salt White', 'standard', 190, ['#d4d2c7'], 'Sea salt on a white hull.', 'gloss'),
  item('paint', 'deep-tide', 'Deep Tide', 'standard', 190, ['#25434b'], 'The water under the cranes.', 'gloss'),
  item('paint', 'signal-amber', 'Signal Amber', 'standard', 250, ['#d08a32'], 'Warning lamp amber.', 'gloss'),
  item('paint', 'kelp-green', 'Kelp Green', 'standard', 190, ['#496750'], 'Low tide green.', 'gloss'),
  item('paint', 'storm-blue', 'Storm Blue', 'standard', 250, ['#465a79'], 'Squall line blue.', 'gloss'),
  item('paint', 'carbon', 'Carbon', 'standard', 290, ['#25292a'], 'Near black.', 'gloss'),
];

const PREMIUM_PAINTS: readonly CosmeticItem[] = [
  item('paint', 'tidewater-metallic', 'Tidewater Metallic', 'standard', 450, ['#0f5a63', '#2a9aa1'], 'Teal base with a fine aluminium flake that sparkles under the sodium lamps.', 'metallic'),
  item('paint', 'midnight-flake', 'Midnight Flake', 'standard', 450, ['#121a36', '#34427a'], 'Ink blue with a coarse silver flake. Reads black until the light hits it.', 'metallic'),
  item('paint', 'dock-grey-matte', 'Dock Grey Matte', 'standard', 390, ['#555c5f', '#6b7376'], 'Flat primer grey. No clearcoat, no reflections, all business.', 'matte'),
  item('paint', 'sodium-flake', 'Sodium Flake', 'rare', 690, ['#b8560e', '#f39a2e'], 'Deep orange metallic tuned to glow under the harbor lamps.', 'metallic'),
  item('paint', 'stealth-matte', 'Stealth Matte', 'rare', 650, ['#141617', '#24282a'], 'Light swallowing satin black. Only the edges catch the lamps.', 'matte'),
  item('paint', 'signal-lime-satin', 'Signal Lime Satin', 'rare', 690, ['#9fc93a', '#d8fa72'], 'The Berth 07 lime, in a soft satin sheen.', 'satin'),
  item('paint', 'harbor-candy-red', 'Harbor Candy Red', 'rare', 850, ['#5c0410', '#c0182b'], 'Layered candy over silver. Glows red in the highlights, near black in the shade.', 'candy'),
  item('paint', 'salt-pearl', 'Salt Pearl', 'epic', 1190, ['#f2efe6', '#e7d9f0', '#d6eee9'], 'Triple pearl white. Soft pink and mint lift off every curve.', 'pearl'),
  item('paint', 'lagoon-pearl', 'Lagoon Pearl', 'epic', 1190, ['#2c8f8a', '#7fd6cf', '#c4b6ff'], 'Lagoon teal with a violet pearl that wakes up at shallow angles.', 'pearl'),
  item('paint', 'black-chrome', 'Black Chrome', 'epic', 1590, ['#0e1012', '#4a5056', '#141618'], 'Smoked mirror finish. Reflects the whole harbor, darkly.', 'chrome'),
  item('paint', 'afterglow-shift', 'Afterglow Shift', 'epic', 1390, ['#5b1fa6', '#e2531f', '#1fb3a0'], 'Colour shift: violet face, sunset orange flanks, teal at the edges.', 'chameleon'),
  item('paint', 'northern-shift', 'Northern Lights', 'legendary', 1890, ['#0fb39a', '#6a3cff', '#c8f25a'], 'Aurora colour shift that rolls from teal to violet to lime as you move.', 'chameleon'),
  item('paint', 'mirror-chrome', 'Mirror Chrome', 'legendary', 2190, ['#8d969c', '#f4f7f8', '#5d666c'], 'Full mirror chrome wrap. Every lamp on the quay in one panel.', 'chrome'),
  item('paint', 'gold-chrome', 'Gold Chrome', 'legendary', 2490, ['#8a5a12', '#ffd979', '#b07a1c'], 'Gold mirror wrap. The loudest car in the port.', 'chrome'),
];

/** Forged Five is the stock wheel style; the rest are purchases. */
const WHEEL_STYLES: readonly CosmeticItem[] = [
  item('wheelStyle', 'forged', 'Forged Five', 'stock', 0, ['#9aa3a6'], 'Five spoke forged wheel.'),
  item('wheelStyle', 'mesh', 'Harbor Mesh', 'standard', 390, ['#b88c38'], 'Cross spoke mesh wheel.'),
  item('wheelStyle', 'steel', 'Workshop Steel', 'standard', 290, ['#7c8285'], 'Plain steel wheel.'),
];

const RIMS: readonly CosmeticItem[] = [
  item('rim', 'rim-gloss-black', 'Gloss Black', 'standard', 250, ['#0b0c0d', '#3a3f42'], 'Piano black rims with a hard clearcoat.', 'gloss'),
  item('rim', 'rim-gunmetal', 'Gunmetal', 'standard', 250, ['#2f3538', '#5d676c'], 'Dark metallic grey. Hides brake dust, shows off the spokes.', 'metallic'),
  item('rim', 'rim-bronze', 'Satin Bronze', 'rare', 450, ['#6e4a20', '#b88a4a'], 'Classic satin bronze. Works on everything.', 'satin'),
  item('rim', 'rim-lime', 'Signal Lime', 'rare', 490, ['#9fc93a', '#d8fa72'], 'Berth 07 lime powder coat.', 'satin'),
  item('rim', 'rim-chrome', 'Polished Chrome', 'epic', 890, ['#7d868c', '#f3f6f7'], 'Mirror polished rims.', 'chrome'),
  item('rim', 'rim-gold', 'Gold Leaf', 'epic', 950, ['#8a5a12', '#ffd979'], 'Gold chrome rims.', 'chrome'),
];

const UNDERGLOW: readonly CosmeticItem[] = [
  item('underglow', 'glow-lime', 'Signal Lime', 'rare', 590, ['#d8fa72'], 'Lime underglow in the Berth 07 signal colour.'),
  item('underglow', 'glow-sodium', 'Sodium Orange', 'rare', 590, ['#ff8a1f'], 'Warm lamp orange spill under the sills.'),
  item('underglow', 'glow-teal', 'Harbor Teal', 'rare', 590, ['#2fe0cf'], 'Cool teal glow that matches the quay lights.'),
  item('underglow', 'glow-ice', 'Ice White', 'rare', 590, ['#e8f6ff'], 'Clean cold white.'),
  item('underglow', 'glow-ultraviolet', 'Ultraviolet', 'epic', 950, ['#8a4dff'], 'Deep blacklight violet.'),
  item('underglow', 'glow-magenta', 'Night Magenta', 'epic', 950, ['#ff2fa8'], 'Hot magenta neon.'),
  item('underglow', 'glow-cycle', 'Spectrum Cycle', 'legendary', 1490, ['#ff2fa8', '#ffd23f', '#2fe0cf', '#8a4dff'], 'Slow rolling colour cycle through the whole spectrum.'),
];

const SMOKE: readonly CosmeticItem[] = [
  item('smoke', 'smoke-sodium', 'Sodium Smoke', 'standard', 190, ['#ffb066'], 'Orange tinted tyre smoke.'),
  item('smoke', 'smoke-lime', 'Lime Smoke', 'rare', 390, ['#cff36a'], 'Signal lime smoke.'),
  item('smoke', 'smoke-teal', 'Teal Smoke', 'rare', 390, ['#5fe6d8'], 'Harbor teal smoke.'),
  item('smoke', 'smoke-crimson', 'Crimson Smoke', 'rare', 390, ['#ff4a5a'], 'Red competition smoke.'),
  item('smoke', 'smoke-violet', 'Violet Smoke', 'epic', 750, ['#b07cff'], 'Purple haze for long slides.'),
  item('smoke', 'smoke-black', 'Burnout Black', 'epic', 750, ['#2a2c30'], 'Thick dark smoke, like the tyres are on fire.'),
];

const PLATES: readonly CosmeticItem[] = [
  item('plate', 'plate-dock7', 'DOCK 07', 'standard', 290, ['#0f2b2d', '#2fe0cf'], 'Harbor issue plate with a teal neon frame.'),
  item('plate', 'plate-afterhours', 'AFTR HRS', 'rare', 490, ['#0d1505', '#d8fa72'], 'Black plate, lime neon lettering.'),
  item('plate', 'plate-lateral', 'LATERAL', 'rare', 490, ['#1a0f05', '#ff8a1f'], 'Sodium orange neon lettering.'),
  item('plate', 'plate-berth', 'BERTH 07', 'epic', 790, ['#1a0514', '#ff2fa8'], 'Magenta neon that flickers like a dockside sign.'),
  item('plate', CUSTOM_PLATE_ID, 'Custom Plate', 'legendary', 9990, ['#0b1114', '#bff0ff'], 'Your own text on the plate, 2 to 8 characters. Everyone online sees it. The rarest thing on the quay.'),
];

const HORNS: readonly CosmeticItem[] = [
  item('horn', 'horn-stock', 'Stock Horn', 'stock', 0, ['#7c8285'], 'Factory single tone.'),
  item('horn', 'horn-twotone', 'Two Tone', 'standard', 190, ['#465a79'], 'European two tone horn.'),
  item('horn', 'horn-foghorn', 'Harbor Foghorn', 'rare', 390, ['#25434b'], 'Low ship foghorn. Rattles the containers.'),
  item('horn', 'horn-airhorn', 'Freight Air Horn', 'rare', 390, ['#a85e43'], 'Triple chime freight train horn.'),
  item('horn', 'horn-chirp', 'Synth Chirp', 'epic', 650, ['#8a4dff'], 'Rising synth arpeggio.'),
  item('horn', 'horn-bell', 'Berth Bell', 'epic', 650, ['#ffd979'], 'Brass ship bell, two strikes.'),
];

const car = (id: string, carId: CarId, name: string, rarity: Rarity, price: number, swatch: readonly string[], blurb: string, hidden?: boolean): CarItem =>
  ({ id, kind: 'car', slot: 'car', carId, name, rarity, price, swatch, blurb, ...(hidden ? { hidden: true } : {}) });

/**
 * Cars. The starter (STARTER_CAR, src/vehicle/starter-car.ts) is free; every other car is a premium buy that costs more than any cosmetic.
 * Every CarId in the roster must appear exactly once (tests/economy enforces it). Set hidden: true to keep a car
 * out of shops and unbuyable (e.g. a model that is not ready). Cars are CosmeticItems in the 'car' slot with kind 'car'.
 */
export const CAR_CATALOG: readonly CarItem[] = [
  car('car-challenger', 'CAR-01', 'Challenger', 'stock', 0, ['#a85e43', '#25292a'], 'The garage starter. A rear drive muscle car with torque to spare and a tail that likes to step out.'),
  car('car-delta', 'CAR-05', 'Lancia Delta', 'epic', 2990, ['#f1f0ea', '#c8102e'], 'A rally legend. Light, four wheel drive and happy to slide, it flicks through mountain hairpins like nothing else.'),
  car('car-cybertruck', 'CAR-02', 'Cybertruck', 'epic', 4990, ['#9a9fa3', '#d4d2c7'], 'Stainless steel and a lot of mass. Heavy, brutal, and strangely good at holding a slide.'),
  car('car-f1', 'CAR-04', 'McLaren Formula 1', 'legendary', 7990, ['#f2f2ee', '#e2401c'], 'Barely any weight, savage power and downforce that glues it down harder the faster you go.'),
  car('car-agera', 'CAR-06', 'Koenigsegg Agera', 'legendary', 8990, ['#f4f4f2', '#1b1c1f'], 'The new halo. About 400 km/h flat out, grip just shy of the Formula 1 and a tail that bites back if you get greedy.'),
];

/** Cosmetics (what loadouts hold). Cars are in CAR_CATALOG; ITEMS has both. */
export const CATALOG: readonly CosmeticItem[] = [
  ...BASE_PAINTS, ...PREMIUM_PAINTS, ...WHEEL_STYLES, ...RIMS, ...UNDERGLOW, ...SMOKE, ...PLATES, ...HORNS,
];
/** Every purchasable thing: cosmetics and cars share one id space and one wallet. Narrow on `kind`. */
export const ITEMS: readonly CatalogItem[] = [...CATALOG, ...CAR_CATALOG];
const BY_ID = new Map<string, CatalogItem>(ITEMS.map(entry => [entry.id, entry]));
const COSMETIC_BY_ID = new Map(CATALOG.map(entry => [entry.id, entry]));
const CAR_BY_CAR_ID = new Map(CAR_CATALOG.map(entry => [entry.carId, entry]));

/** Cosmetic items only (what loadouts hold). Cars are not cosmetics: use catalogEntry for any id. */
export function catalogItem(id: string | null | undefined): CosmeticItem | undefined {
  return typeof id === 'string' ? COSMETIC_BY_ID.get(id) : undefined;
}
/** Any item, cosmetic or car. */
export function catalogEntry(id: string | null | undefined): CatalogItem | undefined {
  return typeof id === 'string' ? BY_ID.get(id) : undefined;
}
export function itemKind(id: string | null | undefined): ItemKind | undefined {
  const entry = catalogEntry(id);
  return entry ? (entry.kind === 'car' ? 'car' : 'cosmetic') : undefined;
}
export function isCarItem(entry: CatalogItem | undefined): entry is CarItem { return entry?.kind === 'car'; }
/** The shop item that unlocks a car, or undefined for an unknown car id. */
export function carItem(carId: CarId): CarItem | undefined { return CAR_BY_CAR_ID.get(carId); }
/** Cars the shop may show (hidden ones omitted). */
export function shopCars(): readonly CarItem[] { return CAR_CATALOG.filter(entry => !entry.hidden); }
/** Everything a brand new player owns: one paint, the Forged wheel style, the stock horn and the starter car. */
export const STARTER = {
  car: STARTER_CAR,
  loadout: { paint: 'harbor-slate', wheelStyle: 'forged', horn: 'horn-stock' } as Loadout,
} as const;

/** Catalog invariants: integer prices >= 0, unique ids, every car once, exactly one free car. Returns problems (empty = fine). */
export function auditCatalog(items: readonly CatalogItem[] = ITEMS): string[] {
  const problems: string[] = [], seen = new Set<string>();
  for (const entry of items) {
    if (seen.has(entry.id)) problems.push(`duplicate id ${entry.id}`);
    seen.add(entry.id);
    if (!Number.isSafeInteger(entry.price) || entry.price < 0) problems.push(`bad price on ${entry.id}`);
    if (entry.price === 0 && entry.rarity !== 'stock') problems.push(`free item ${entry.id} is not stock rarity`);
    if (entry.price > 0 && entry.rarity === 'stock') problems.push(`paid item ${entry.id} is stock rarity`);
  }
  return problems;
}

export function itemsForSlot(slot: CosmeticSlot): readonly CosmeticItem[] {
  return CATALOG.filter(entry => entry.slot === slot);
}
export function isStock(id: string): boolean {
  return catalogEntry(id)?.price === 0;
}
/** Sum of catalog prices for a set of ids (cosmetics and cars); unknown ids count 0. */
export function priceOf(ids: Iterable<string>): number {
  let total = 0;
  for (const id of ids) total += catalogEntry(id)?.price ?? 0;
  return total;
}

/** Keeps only known ids in their own slot. Untrusted input (remote presence, storage) goes through this. */
export function sanitizeLoadout(raw: unknown): Loadout {
  if (!raw || typeof raw !== 'object') return {};
  const out: Loadout = {};
  for (const { slot } of [...SLOTS, { slot: 'wheelStyle' as const }]) {
    const value = (raw as Record<string, unknown>)[slot];
    const entry = typeof value === 'string' ? catalogItem(value) : undefined;
    if (entry && entry.slot === slot) out[slot] = entry.id;
  }
  // Custom plate text: re-validated every time it crosses a trust boundary (storage, presence).
  const plateText = cleanPlateText((raw as Record<string, unknown>).plateText);
  if (plateText) out.plateText = plateText;
  return out;
}

/**
 * Compact loadout string for multiplayer presence (fits the existing paint field):
 * "~paint.rim.underglow.smoke.plate.horn.wheelStyle" with empty segments for stock.
 */
const WIRE_SLOTS: readonly CosmeticSlot[] = ['paint', 'rim', 'underglow', 'smoke', 'plate', 'horn', 'wheelStyle'];
export function encodeLoadout(loadout: Loadout): string {
  // Custom plate text rides as an eighth segment ("x" + hex), only while the custom plate is the fitted one.
  const text = loadout.plate === CUSTOM_PLATE_ID && loadout.plateText ? encodePlateText(loadout.plateText) : '';
  return `~${WIRE_SLOTS.map(slot => loadout[slot] ?? '').join('.')}${text ? `.${text}` : ''}`;
}
export function decodeLoadout(wire: string): Loadout | null {
  if (typeof wire !== 'string' || !wire.startsWith('~') || wire.length > 200) return null;
  const parts = wire.slice(1).split('.');
  const raw: Record<string, string> = {};
  WIRE_SLOTS.forEach((slot, index) => { if (parts[index]) raw[slot] = parts[index]!; });
  const text = parts.length === WIRE_SLOTS.length + 1 ? decodePlateText(parts[WIRE_SLOTS.length]) : null;
  if (text && raw.plate === CUSTOM_PLATE_ID) raw.plateText = text;
  return sanitizeLoadout(raw);
}
