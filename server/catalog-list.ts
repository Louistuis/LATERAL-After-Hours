/** The shop catalog as the admin page needs it (id, name, slot, price, rarity). No images, no copy. */
import { ITEMS } from '../src/economy/catalog';

export interface CatalogRow { id: string; name: string; slot: string; kind: string; price: number; rarity: string }
export function giftableItems(): CatalogRow[] {
  return ITEMS.filter(i => i.price > 0 && !i.hidden).map(i => ({ id: i.id, name: i.name, slot: i.slot, kind: i.kind ?? 'cosmetic', price: i.price, rarity: i.rarity }));
}
