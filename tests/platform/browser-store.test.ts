import { afterEach, describe, expect, it, vi } from 'vitest';
import { createGuardedBrowserDataStore } from '../../src/platform/browser-store';

afterEach(() => vi.unstubAllGlobals());

describe('guarded browser data store', () => {
  it('uses a target-scoped key and reads/writes only local browser storage', async () => {
    const values = new Map<string, string>();
    const localStorage = {
      get length() { return values.size; },
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value); },
    };
    vi.stubGlobal('window', { localStorage });
    const store = createGuardedBrowserDataStore('owner-review');
    await store.initialize();
    expect(await store.read('lateral:owner-review:career:v1')).toEqual({ status: 'missing' });
    expect(await store.write('lateral:owner-review:career:v1', '{"ok":true}')).toEqual({ status: 'written' });
    expect([...values.keys()]).toEqual(['lateral:save:v1:owner-review:lateral:owner-review:career:v1']);
    expect(await store.read('lateral:owner-review:career:v1')).toEqual({ status: 'found', serialized: '{"ok":true}' });
    expect(await store.read('../career')).toMatchObject({ status: 'unavailable', reason: 'Invalid save key' });
  });

  it('reports denied storage as unavailable and keeps the normal offline game path usable', async () => {
    const denied = Object.defineProperty({}, 'localStorage', { get() { throw new DOMException('blocked', 'SecurityError'); } });
    vi.stubGlobal('window', denied);
    const store = createGuardedBrowserDataStore('standalone');
    await store.initialize();
    expect(await store.read('lateral:standalone:career:v1')).toMatchObject({ status: 'unavailable' });
    expect(await store.write('lateral:standalone:career:v1', '{}')).toMatchObject({ status: 'unavailable' });
  });
});
