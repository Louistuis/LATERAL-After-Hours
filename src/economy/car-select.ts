/**
 * The one way a UI switches cars: checks the economy first, then asks the garage to select. The coordinator enforces the
 * same rule again (setCarGate), so this is a friendly message and a shortcut, never the only line of defence.
 */
import type { CarId } from '../../contracts/runtime-contracts';
import { carItem } from './catalog';
import type { Economy } from './types';

export interface CarSelector { selectCar(car: CarId): Promise<void> }
export type CarSelectResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: 'unknown' | 'locked' | 'failed'; readonly message: string };

export async function selectOwnedCar(economy: Economy, selector: CarSelector, carId: CarId): Promise<CarSelectResult> {
  const entry = carItem(carId);
  if (!entry || entry.hidden) return { ok: false, reason: 'unknown', message: 'That car is not available.' };
  if (!(economy.carAllowed?.(carId) ?? economy.owns(entry.id))) {
    return { ok: false, reason: 'locked', message: `${entry.name} is locked. Buy it in the shop with Marks.` };
  }
  try { await selector.selectCar(carId); return { ok: true }; }
  catch (error) { return { ok: false, reason: 'failed', message: error instanceof Error ? error.message.slice(0, 160) : 'The car could not be selected.' }; }
}
