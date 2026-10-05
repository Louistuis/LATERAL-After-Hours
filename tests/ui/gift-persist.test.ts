/**
 * Regression: "I don't want the gift every time I open the site." Once the starter gift is opened on a device or account
 * it must never show again: not after a reload, not while the wallet is slow, not when the remote save failed, not for
 * the creator account. Real economy + real welcome source + real controller; only the DOM and the stores are fakes.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createCreatorSource } from '../../src/economy/creator';
import { createEconomy } from '../../src/economy/economy';
import { createGameplaySource } from '../../src/economy/gameplay';
import { createLayeredStore } from '../../src/economy/stores';
import type { WalletRecord, WalletStore } from '../../src/economy/types';
import { createWelcomeSource, WELCOME_CLAIM } from '../../src/economy/welcome';
import { emptyWallet } from '../../src/economy/wallet';
import { mountStarterGift } from '../../src/ui/starter-gift';

class FakeEl {
  children: FakeEl[] = [];
  text = ''; className = ''; id = ''; type = ''; tabIndex = 0; hidden = false; disabled = false;
  style = { setProperty: (_n: string, _v: string) => {} };
  attrs: Record<string, string> = {};
  handlers: Record<string, ((event: unknown) => void)[]> = {};
  parent: FakeEl | null = null;
  constructor(readonly tag: string) {}
  set textContent(value: string) { this.text = value; this.children = []; }
  get textContent(): string { return this.text + this.children.map(child => child.textContent).join(''); }
  get classList() { return { add: (n: string) => { this.className += ` ${n}`; }, remove: (n: string) => { this.className = this.className.split(' ').filter(c => c !== n).join(' '); } }; }
  append(...nodes: (FakeEl | string)[]): void { for (const node of nodes) { if (typeof node === 'string') this.text += node; else { node.parent = this; this.children.push(node); } } }
  replaceChildren(...nodes: FakeEl[]): void { this.children = []; this.text = ''; this.append(...nodes); }
  setAttribute(name: string, value: string): void { this.attrs[name] = value; }
  addEventListener(name: string, fn: (event: unknown) => void): void { (this.handlers[name] ??= []).push(fn); }
  remove(): void { if (this.parent) this.parent.children = this.parent.children.filter(child => child !== this); this.parent = null; }
  focus(): void {} contains(node: unknown): boolean { return node === this || this.children.some(child => child.contains(node)); }
  click(): void { for (const fn of this.handlers.click ?? []) fn({ target: this }); }
  find(predicate: (el: FakeEl) => boolean): FakeEl[] { return [...(predicate(this) ? [this] : []), ...this.children.flatMap(child => child.find(predicate))]; }
  byClass(name: string): FakeEl | undefined { return this.find(el => el.className.split(' ').includes(name))[0]; }
}

const NOW = Date.UTC(2026, 9, 3, 12);
const noGame = { onRunFinished: () => () => {} };
const memoryStore = (record: WalletRecord | null = null): WalletStore & { current(): WalletRecord | null } => {
  let current = record;
  return { id: 'm', durable: true, load: async () => (current ? structuredClone(current) : null), save: async r => { current = structuredClone(r); }, current: () => current };
};
/** localStorage stand-in shared by two "page loads" (a reload keeps it). */
const device = () => { const data = new Map<string, string>(); return { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => { data.set(k, v); } }; };

describe('the starter gift never comes back once it was opened', () => {
  let body: FakeEl;
  beforeEach(() => {
    body = new FakeEl('body');
    vi.stubGlobal('document', { createElement: (tag: string) => new FakeEl(tag), head: new FakeEl('head'), body, getElementById: () => null, addEventListener: () => {}, removeEventListener: () => {}, activeElement: null });
  });
  afterEach(() => vi.unstubAllGlobals());

  const reveal = () => body.byClass('lp-gf');
  /** One page load: a fresh economy over `store`, the controller, and a manual clock for the 5 s wait. */
  const load = (store: WalletStore, storage: ReturnType<typeof device>, extra: { sources?: unknown[] } = {}) => {
    const welcome = createWelcomeSource({ storage });
    const economy = createEconomy({ store, sources: [...((extra.sources ?? []) as never[]), createGameplaySource(), welcome], game: noGame, now: () => NOW });
    const timers: (() => void)[] = [];
    const drive = vi.fn(), openShop = vi.fn();
    const gift = mountStarterGift({
      economy, shell: body as unknown as HTMLElement, drive, openShop, screen: () => 'pause', menuReady: () => true,
      subscribeScreen: () => () => {}, schedule: fn => { timers.push(fn); return timers.length; }, cancel: () => {}, reveal: { reduced: () => true },
    });
    return { economy, gift, welcome, fallback: () => { for (const fn of timers.splice(0)) fn(); } };
  };
  const settle = async (economy: { view(): { ready: boolean } }) => { await vi.waitFor(() => expect(economy.view().ready).toBe(true)); await new Promise(resolve => setTimeout(resolve, 30)); };
  const openFirstVisit = async (store: WalletStore, storage: ReturnType<typeof device>) => {
    const first = load(store, storage);
    await vi.waitFor(() => expect(reveal()).toBeDefined());
    body.byClass('lp-gf-box')!.click();
    await vi.waitFor(() => expect(first.economy.view().gift?.state).toBe('opened'));
    await vi.waitFor(() => expect(first.economy.view().balance).toBe(1500));
    first.gift.dispose(); first.economy.dispose();
    body.children = [];
  };

  it('does not show it again after a reload (wallet holds the claim)', async () => {
    const store = memoryStore(), storage = device();
    await openFirstVisit(store, storage);
    expect(store.current()!.claims).toContain(WELCOME_CLAIM);
    const second = load(store, storage);
    await settle(second.economy);
    expect(reveal()).toBeUndefined();
    expect(second.gift.allowed()).toBe(true);
    expect(second.economy.view().gift!.state).toBe('opened');
    expect(second.economy.view().balance).toBe(1500);
  });

  it('does not show it on the first frame the wallet is ready (the claim is read from the wallet, not from a later attach)', async () => {
    // A wallet that already holds the claim and NO device flag: the reveal must not flash while sources attach.
    const record: WalletRecord = { ...emptyWallet(NOW), earned: { welcome: 1500 }, claims: [WELCOME_CLAIM], createdAt: NOW - 86_400_000 };
    const states: string[] = [];
    const storage = device();
    const welcome = createWelcomeSource({ storage });
    const economy = createEconomy({ store: memoryStore(record), sources: [welcome], game: noGame, now: () => NOW });
    economy.subscribe(view => { if (view.ready) states.push(view.gift!.state); });
    await settle(economy);
    expect(states.length).toBeGreaterThan(0);
    expect(new Set(states)).toEqual(new Set(['opened']));
    const second = load(memoryStore(record), device());
    await settle(second.economy);
    expect(reveal()).toBeUndefined();
  });

  it('does not show it while the wallet is slow, once it was opened on this device (the 5 s fallback checks the local flag)', async () => {
    const store = memoryStore(), storage = device();
    await openFirstVisit(store, storage);
    let release!: (record: WalletRecord | null) => void;
    const slow: WalletStore = { id: 'slow', durable: true, load: () => new Promise(resolve => { release = resolve; }), save: async () => {} };
    const second = load(slow, storage);
    expect(second.economy.view().ready).toBe(false);
    expect(second.economy.view().gift!.state).toBe('opened');
    second.fallback();
    expect(reveal()).toBeUndefined();
    expect(second.gift.allowed()).toBe(true);
    release(store.current());
    await settle(second.economy);
    expect(reveal()).toBeUndefined();
  });

  it('on a device that never saw the gift, a slow wallet shows it after 5 s but it goes away by itself when the wallet says it was opened', async () => {
    const store = memoryStore(), storage = device();
    await openFirstVisit(store, storage);
    let release!: (record: WalletRecord | null) => void;
    const slow: WalletStore = { id: 'slow', durable: true, load: () => new Promise(resolve => { release = resolve; }), save: async () => {} };
    const newDevice = load(slow, device());
    newDevice.fallback();
    expect(reveal()).toBeDefined();
    release(store.current());
    await vi.waitFor(() => expect(reveal()).toBeUndefined());
    expect(newDevice.gift.allowed()).toBe(true);
    expect(newDevice.economy.view().balance).toBe(1500);
  });

  it('does not show it after a reload when the remote save failed (the local copy and the device flag keep it)', async () => {
    const cache = memoryStore(), storage = device();
    const failingRemote = (): WalletStore => ({ id: 'remote', durable: true, load: async () => null, save: async () => { throw new Error('websim is down'); } });
    const layered = () => createLayeredStore(failingRemote(), cache);
    await openFirstVisit(layered(), storage);
    expect(cache.current()!.claims).toContain(WELCOME_CLAIM);
    const second = load(layered(), storage);
    await settle(second.economy);
    expect(reveal()).toBeUndefined();
    expect(second.economy.view().gift!.state).toBe('opened');
    // Even with the local wallet copy gone, the device flag alone keeps the reveal away (the Marks are paid again in the background).
    const third = load(createLayeredStore(failingRemote(), memoryStore()), storage);
    await settle(third.economy);
    expect(reveal()).toBeUndefined();
    expect(third.gift.allowed()).toBe(true);
    await vi.waitFor(() => expect(third.economy.view().balance).toBe(1500));
  });

  it('does not show it again when the wallet can not be read at all, once opened on this device', async () => {
    const store = memoryStore(), storage = device();
    await openFirstVisit(store, storage);
    const offline: WalletStore = { id: 'offline', durable: false, load: async () => { throw new Error('offline'); }, save: async () => { throw new Error('offline'); } };
    const second = load(offline, storage);
    await vi.waitFor(() => expect(second.economy.view().error).not.toBeNull());
    second.fallback();
    expect(reveal()).toBeUndefined();
    expect(second.gift.allowed()).toBe(true);
  });

  it('behaves the same for the creator account (a derived source is settling while the wallet loads)', async () => {
    const CREATOR = '47085852-a3b9-4326-88a0-d06f5f891aba';
    let answer!: (user: unknown) => void;
    const host = (slow: boolean) => ({
      getCurrentUser: () => (slow ? new Promise(resolve => { answer = resolve; }) : Promise.resolve({ id: CREATOR, username: 'Louis' })),
      getCurrentProject: async () => ({ id: 'p' }), postComment: async () => ({}), addEventListener: () => () => {},
    });
    const store = memoryStore(), storage = device();
    const first = load(store, storage, { sources: [createCreatorSource({ host: host(false) as never, creatorId: CREATOR })] });
    await vi.waitFor(() => expect(reveal()).toBeDefined());
    body.byClass('lp-gf-box')!.click();
    await vi.waitFor(() => expect(first.economy.view().gift?.state).toBe('opened'));
    await vi.waitFor(() => expect(store.current()?.claims ?? []).toContain(WELCOME_CLAIM));
    first.gift.dispose(); first.economy.dispose(); body.children = [];
    const second = load(store, storage, { sources: [createCreatorSource({ host: host(true) as never, creatorId: CREATOR })] });
    // The creator's identity read is pending, so the wallet is not "ready" yet: the device flag alone keeps the reveal away.
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(second.economy.view().ready).toBe(false);
    second.fallback();
    expect(reveal()).toBeUndefined();
    expect(second.gift.allowed()).toBe(true);
    answer({ id: CREATOR, username: 'Louis' });
    await settle(second.economy);
    expect(reveal()).toBeUndefined();
    expect(second.economy.view().gift!.state).toBe('opened');
  });

  it('opening is remembered on the device immediately, before the wallet answers', async () => {
    const storage = device();
    let release!: (record: WalletRecord | null) => void;
    const slow: WalletStore = { id: 'slow', durable: true, load: () => new Promise(resolve => { release = resolve; }), save: async () => {} };
    const first = load(slow, storage);
    first.fallback();
    expect(reveal()).toBeDefined();
    body.byClass('lp-gf-box')!.click();
    expect(storage.getItem('lateral:starter-gift:v1')).toBe('1');
    first.gift.dispose(); first.economy.dispose(); body.children = [];
    const second = load(memoryStore(), storage);
    await settle(second.economy);
    expect(reveal()).toBeUndefined();
    void release;
  });
});
