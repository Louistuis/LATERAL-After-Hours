import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mountStarterGift } from '../../src/ui/starter-gift';
import { starterGiftItems } from '../../src/economy/welcome';
import type { Economy, EconomyView, GiftOpenResult, GiftView } from '../../src/economy/types';

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
  button(label: string): FakeEl | undefined { return this.find(el => el.tag === 'button' && el.textContent === label)[0]; }
  byClass(name: string): FakeEl | undefined { return this.find(el => el.className.split(' ').includes(name))[0]; }
}

const unopened: GiftView = { state: 'unopened', marks: 1500, items: starterGiftItems(), pending: false };
const opened: GiftView = { ...unopened, state: 'opened' };

function fakeEconomy(first: Partial<EconomyView> & { gift?: GiftView | null }) {
  let view = { ready: true, balance: 0, gift: unopened, ...first } as EconomyView;
  const listeners = new Set<(view: EconomyView) => void>();
  const set = (next: Partial<EconomyView>) => { view = { ...view, ...next } as EconomyView; for (const listener of [...listeners]) listener(view); };
  const openGift = vi.fn(async (): Promise<GiftOpenResult> => { set({ gift: opened, balance: 1500 }); return { ok: true, granted: 1500, pending: false }; });
  const economy = { view: () => view, subscribe: (listener: (view: EconomyView) => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; }, openGift } as unknown as Economy;
  return { economy, set, openGift };
}

describe('starter gift controller', () => {
  let body: FakeEl;
  beforeEach(() => {
    body = new FakeEl('body');
    vi.stubGlobal('document', { createElement: (tag: string) => new FakeEl(tag), head: new FakeEl('head'), body, getElementById: () => null, addEventListener: () => {}, removeEventListener: () => {}, activeElement: null });
  });
  afterEach(() => vi.unstubAllGlobals());

  const mount = (first: Parameters<typeof fakeEconomy>[0] = {}, extra: Record<string, unknown> = {}) => {
    const fake = fakeEconomy(first);
    let screen = 'pause', ready = true;
    const screenListeners = new Set<() => void>();
    const drive = vi.fn(), openShop = vi.fn(), onChange = vi.fn();
    const timers: { fn: () => void; ms: number }[] = [];
    const gift = mountStarterGift({
      economy: fake.economy, shell: body as unknown as HTMLElement, drive, openShop, onChange,
      screen: () => screen, menuReady: () => ready,
      subscribeScreen: listener => { screenListeners.add(listener); return () => screenListeners.delete(listener); },
      schedule: (fn, ms) => { timers.push({ fn, ms }); return timers.length; }, cancel: () => {},
      reveal: { reduced: () => true },
      ...extra,
    });
    return {
      ...fake, gift, drive, openShop, onChange,
      setScreen: (next: string) => { screen = next; for (const listener of screenListeners) listener(); },
      setMenuReady: (next: boolean) => { ready = next; for (const listener of screenListeners) listener(); },
      runTimers: () => { for (const timer of timers.splice(0)) timer.fn(); },
    };
  };
  const reveal = () => body.byClass('lp-gf');
  const tapOpen = () => body.byClass('lp-gf-box')!.click();

  it('shows the reveal by itself on the first menu visit, as a required step', () => {
    const f = mount();
    expect(reveal()).toBeDefined();
    expect(f.gift.isShowing).toBe(true);
    expect(f.gift.allowed()).toBe(false);
    expect(f.gift.state()).toBe('unopened');
    expect(f.gift.hint()).toBe(1500);
    expect(body.button('Later')).toBeUndefined();
  });

  it('never shows during a drive, and waits for the menu to be ready', () => {
    const f = mount({}, { screen: () => 'drive' });
    expect(reveal()).toBeUndefined();
    f.gift.dispose();
    const g = mount();
    g.gift.dispose();
    body.children = [];
    const h = mount();
    h.setScreen('drive');
    expect(h.gift.isShowing).toBe(true);
    h.gift.dispose();
    body.children = [];
    const waiting = (() => { const x = mount({}, { menuReady: () => false }); return x; })();
    expect(reveal()).toBeUndefined();
    waiting.gift.dispose();
  });

  it('waits for the wallet, then shows; a slow wallet does not hide it forever', () => {
    const f = mount({ ready: false });
    expect(f.gift.state()).toBe('loading');
    expect(reveal()).toBeUndefined();
    f.set({ ready: true });
    expect(reveal()).toBeDefined();
    f.gift.dispose();
    body.children = [];
    const slow = mount({ ready: false });
    expect(reveal()).toBeUndefined();
    slow.runTimers();
    expect(slow.gift.state()).toBe('unopened');
    expect(reveal()).toBeDefined();
  });

  it('never shows for an opened gift or a build without one, and never gates them', () => {
    for (const gift of [opened, null]) {
      body.children = [];
      const f = mount({ gift });
      expect(reveal()).toBeUndefined();
      expect(f.gift.allowed()).toBe(true);
      expect(f.gift.hint()).toBeNull();
    }
  });

  it('opens the gift on the tap, pays the Marks once, and "Let\'s drive" starts driving', async () => {
    const f = mount();
    tapOpen();
    await vi.waitFor(() => expect(f.gift.allowed()).toBe(true));
    expect(f.openGift).toHaveBeenCalledTimes(1);
    expect(f.gift.hint()).toBeNull();
    expect(f.onChange).toHaveBeenCalled();
    body.button("Let's drive")!.click();
    await vi.waitFor(() => expect(f.drive).toHaveBeenCalledTimes(1));
    expect(f.openShop).not.toHaveBeenCalled();
    expect(f.gift.isShowing).toBe(false);
  });

  it('"Open the shop" goes to the shop instead', async () => {
    const f = mount();
    tapOpen();
    await vi.waitFor(() => expect(f.gift.allowed()).toBe(true));
    body.button('Open the shop')!.click();
    await vi.waitFor(() => expect(f.openShop).toHaveBeenCalledTimes(1));
    expect(f.drive).not.toHaveBeenCalled();
  });

  it('is the play gate: require() shows the gift and lets the waiting action go on after "Let\'s drive"', async () => {
    const f = mount({}, { screen: () => 'drive' });
    expect(reveal()).toBeUndefined();
    const waiting = f.gift.require();
    expect(reveal()).toBeDefined();
    tapOpen();
    await vi.waitFor(() => expect(f.gift.allowed()).toBe(true));
    body.button("Let's drive")!.click();
    expect(await waiting).toBe(true);
    expect(f.drive).not.toHaveBeenCalled();
    expect(await f.gift.require()).toBe(true);
  });

  it('require() resolves false (and opens the shop) when the player picks the shop, and never hangs on dispose', async () => {
    const f = mount();
    const waiting = f.gift.require();
    tapOpen();
    await vi.waitFor(() => expect(f.gift.allowed()).toBe(true));
    body.button('Open the shop')!.click();
    expect(await waiting).toBe(false);
    expect(f.openShop).toHaveBeenCalledTimes(1);
    body.children = [];
    const g = mount();
    const pending = g.gift.require();
    g.gift.dispose();
    expect(await pending).toBe(false);
  });

  it('require() on a loading wallet waits for it, and returns true at once if the wallet says opened', async () => {
    const f = mount({ ready: false }, { screen: () => 'drive' });
    const waiting = f.gift.require();
    f.set({ ready: true, gift: opened });
    expect(await waiting).toBe(true);
    expect(reveal()).toBeUndefined();
  });

  it('does not soft-lock when the wallet is slow: the player opens it anyway and carries on', async () => {
    const slow = fakeEconomy({ ready: false });
    // openGift reports pending (the wallet pays later) but the gift is open on this device.
    slow.openGift.mockImplementation(async () => { slow.set({ gift: { ...opened, pending: true } }); return { ok: true, granted: 0, pending: true }; });
    let screen = 'pause';
    const drive = vi.fn();
    const timers: (() => void)[] = [];
    const gift = mountStarterGift({
      economy: slow.economy, shell: body as unknown as HTMLElement, drive, openShop: vi.fn(), screen: () => screen, subscribeScreen: () => () => {},
      schedule: fn => { timers.push(fn); return timers.length; }, cancel: () => {}, reveal: { reduced: () => true },
    });
    expect(reveal()).toBeUndefined();
    for (const fn of timers.splice(0)) fn();
    expect(reveal()).toBeDefined();
    tapOpen();
    await vi.waitFor(() => expect(gift.allowed()).toBe(true));
    expect(body.byClass('lp-gf-note')!.hidden).toBe(false);
    body.button("Let's drive")!.click();
    await vi.waitFor(() => expect(drive).toHaveBeenCalledTimes(1));
    expect(screen).toBe('pause');
  });
});
