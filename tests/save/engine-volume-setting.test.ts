import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DataStore } from '../../contracts/runtime-contracts';
import type { ProfileRecord } from '../../src/experience/coordinator';
import { createProfileRepository } from '../../src/save/profile-repository';
import { DEFAULT_ENGINE_VOLUME } from '../../src/audio';

beforeEach(() => vi.stubGlobal('__OWNER_REVIEW__', true));
afterEach(() => vi.unstubAllGlobals());

function memoryStore() {
  const values = new Map<string, string>();
  const store: DataStore = {
    async initialize() {},
    async read(key) { return values.has(key) ? { status: 'found', serialized: values.get(key)! } : { status: 'missing' }; },
    async write(key, serialized) { values.set(key, serialized); return { status: 'written' }; },
    async flushPending() {},
  };
  return { store, values };
}

const KEY = 'lateral:owner-review:career:v1';
const record = (engineVolume?: number): ProfileRecord => ({
  profile: 'career', selection: { car: 'CAR-01', route: 'HW-01', tune: 'Balanced', lighting: 'golden-hour', quality: 'balanced' },
  settings: { masterVolume: .8, musicVolume: .4, sfxVolume: .7, muted: false, reducedMotion: false, uiScale: 1, ghostVisible: true, ...(engineVolume === undefined ? {} : { engineVolume }) },
});

describe('engine volume setting', () => {
  it('defaults to the quieter engine level, which matches the audio default', async () => {
    const { store } = memoryStore();
    const repository = createProfileRepository(store, 'owner-review');
    await repository.save(record());
    expect((await createProfileRepository(store, 'owner-review').load('career'))?.settings?.engineVolume).toBe(DEFAULT_ENGINE_VOLUME);
    expect(DEFAULT_ENGINE_VOLUME).toBeLessThan(0.6);
  });

  it('persists 0 (engine off) and other levels independently of the SFX volume', async () => {
    const { store, values } = memoryStore();
    const repository = createProfileRepository(store, 'owner-review');
    await repository.save(record(0));
    expect(JSON.parse(values.get(KEY)!).settings).toMatchObject({ 'experience.engineVolume': 0, 'experience.sfxVolume': 0.7 });
    expect((await createProfileRepository(store, 'owner-review').load('career'))?.settings).toMatchObject({ engineVolume: 0, sfxVolume: 0.7 });
    await repository.save(record(0.85));
    expect((await createProfileRepository(store, 'owner-review').load('career'))?.settings?.engineVolume).toBe(0.85);
  });

  it('migrates saves from before the engine slider to the default without rewriting them', async () => {
    const { store, values } = memoryStore();
    await createProfileRepository(store, 'owner-review').save(record(0.2));
    const legacy = JSON.parse(values.get(KEY)!) as { settings: Record<string, unknown> };
    delete legacy.settings['experience.engineVolume'];
    const serialized = JSON.stringify(legacy);
    values.set(KEY, serialized);
    const loaded = await createProfileRepository(store, 'owner-review').load('career');
    expect(loaded?.settings).toMatchObject({ engineVolume: DEFAULT_ENGINE_VOLUME, masterVolume: 0.8, sfxVolume: 0.7 });
    expect(values.get(KEY)).toBe(serialized);
  });

  it.each([['below zero', -0.01], ['above one', 1.01], ['non-finite', Number.NaN], ['infinite', Infinity]])('rejects an engine volume that is %s on save', async (_label, engineVolume) => {
    const repository = createProfileRepository(memoryStore().store, 'owner-review');
    await expect(repository.save(record(engineVolume))).rejects.toThrow(/settings/);
  });

  it('rejects a tampered stored engine volume like the other volumes', async () => {
    const { store, values } = memoryStore();
    await createProfileRepository(store, 'owner-review').save(record(0.5));
    for (const bad of [3, 'loud', true]) {
      const tampered = JSON.parse(values.get(KEY)!) as { settings: Record<string, unknown> };
      tampered.settings['experience.engineVolume'] = bad;
      values.set(KEY, JSON.stringify(tampered));
      await expect(createProfileRepository(store, 'owner-review').load('career')).rejects.toThrow();
    }
  });
});
