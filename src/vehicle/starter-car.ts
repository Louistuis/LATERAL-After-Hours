import type { CarId } from '../../contracts/runtime-contracts';

/**
 * The one car every new player owns. It is the Challenger; every other car (CAR-02 Cybertruck, the Formula 1 halo car) is a
 * premium purchase. Single source of truth: src/economy/catalog.ts prices it at 0
 * and everything that needs a safe fallback car (locked car, unverified remote driver) uses this id.
 */
export const STARTER_CAR: CarId = 'CAR-01';
