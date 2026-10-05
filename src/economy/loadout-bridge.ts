/**
 * Carries the full cosmetic loadout through the existing single `paint` string, so neither the scene
 * pipeline nor the multiplayer presence needs a new field:
 *   - the local scene: installLoadoutOverlay() wraps scene.setCosmetics and folds the economy loadout in;
 *   - multiplayer: presencePaint() is what the net module sends as `pt`; remote cars decode it.
 * Car presentations decode "~..." strings with decodeLoadout (catalog.ts); plain stock ids still work,
 * so clients without the shop keep rendering everyone with their stock paint.
 */
import { encodeLoadout } from './catalog';
import type { Loadout } from './types';

export interface CosmeticsLike { readonly paint?: string; readonly wheelStyle?: string; readonly livery?: string }
export interface CosmeticsScene { setCosmetics(cosmetics: CosmeticsLike): void }

let provider: ((base: CosmeticsLike) => Loadout) | null = null;
let memoKey = '', memoWire = '';

/** The shell registers how to build the effective loadout from the profile's stock cosmetics. */
export function setLoadoutProvider(next: ((base: CosmeticsLike) => Loadout) | null): void {
  provider = next;
  memoKey = '';
}

export function effectiveLoadout(base: CosmeticsLike): Loadout {
  return provider ? provider(base) : { ...(base.paint ? { paint: base.paint } : {}), ...(base.wheelStyle ? { wheelStyle: base.wheelStyle } : {}) };
}

/** Paint string for multiplayer presence. Called every frame by the net session, so it is memoized. */
export function presencePaint(basePaint: string, baseWheelStyle?: string): string {
  if (!provider) return basePaint;
  const loadout = provider({ paint: basePaint, wheelStyle: baseWheelStyle });
  const key = JSON.stringify(loadout);
  if (key !== memoKey) { memoKey = key; memoWire = encodeLoadout(loadout); }
  return memoWire;
}

/** Wraps scene.setCosmetics so every call (garage chips, profile restore, car swap) carries the loadout. */
export function installLoadoutOverlay(scene: CosmeticsScene, initial: CosmeticsLike = {}): { reapply(): void; dispose(): void } {
  const original = scene.setCosmetics.bind(scene);
  let base: CosmeticsLike = { ...initial };
  const compose = (value: CosmeticsLike): CosmeticsLike => ({ ...value, paint: encodeLoadout(effectiveLoadout(value)) });
  const wrapped = (value: CosmeticsLike): void => { base = { ...value }; original(compose(base)); };
  scene.setCosmetics = wrapped;
  return {
    reapply: () => original(compose(base)),
    dispose: () => { if (scene.setCosmetics === wrapped) scene.setCosmetics = original; },
  };
}

let localHorn: (() => boolean) | null = null;
/** The shop registers the player's equipped horn; the multiplayer horn uses it for the local car. */
export function setLocalHornPlayer(next: (() => boolean) | null): void {
  localHorn = next;
}
/** Plays the equipped horn for the local car. False when no shop is mounted (caller plays its default). */
export function playLocalHorn(): boolean {
  try { return localHorn ? localHorn() : false; } catch { return false; }
}
