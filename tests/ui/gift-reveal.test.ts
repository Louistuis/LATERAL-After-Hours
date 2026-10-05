import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { describeGiftItems, openGiftReveal, type GiftOutcome } from '../../src/ui/gift-reveal';
import { starterGiftItems } from '../../src/economy/welcome';
import type { GiftOpenResult } from '../../src/economy/types';

/** A tiny DOM: enough for the reveal, which builds everything with createElement and textContent. */
class FakeEl {
  children: FakeEl[] = [];
  text = ''; className = ''; id = ''; type = ''; tabIndex = 0; hidden = false; disabled = false;
  style = { setProperty: (_name: string, _value: string) => {} };
  attrs: Record<string, string> = {};
  handlers: Record<string, ((event: unknown) => void)[]> = {};
  parent: FakeEl | null = null;
  constructor(readonly tag: string) {}
  set textContent(value: string) { this.text = value; this.children = []; }
  get textContent(): string { return this.text + this.children.map(child => child.textContent).join(''); }
  get classList() {
    const set = () => new Set(this.className.split(' ').filter(Boolean));
    return { add: (name: string) => { const next = set(); next.add(name); this.className = [...next].join(' '); }, remove: (name: string) => { const next = set(); next.delete(name); this.className = [...next].join(' '); } };
  }
  append(...nodes: (FakeEl | string)[]): void { for (const node of nodes) { if (typeof node === 'string') this.text += node; else { node.parent = this; this.children.push(node); } } }
  replaceChildren(...nodes: FakeEl[]): void { this.children = []; this.text = ''; this.append(...nodes); }
  setAttribute(name: string, value: string): void { this.attrs[name] = value; }
  addEventListener(name: string, fn: (event: unknown) => void): void { (this.handlers[name] ??= []).push(fn); }
  remove(): void { if (this.parent) this.parent.children = this.parent.children.filter(child => child !== this); this.parent = null; }
  focus(): void { focused = this; }
  contains(node: unknown): boolean { return node === this || this.children.some(child => child.contains(node)); }
  click(target: unknown = this): void { if (this.disabled) return; for (const fn of this.handlers.click ?? []) fn({ target }); }
  closest(selector: string): FakeEl | null { return selector === 'button' && this.tag === 'button' ? this : this.parent?.closest(selector) ?? null; }
  find(predicate: (el: FakeEl) => boolean): FakeEl[] { return [...(predicate(this) ? [this] : []), ...this.children.flatMap(child => child.find(predicate))]; }
  button(label: string): FakeEl | undefined { return this.find(el => el.tag === 'button' && el.textContent === label)[0]; }
  byClass(name: string): FakeEl | undefined { return this.find(el => el.className.split(' ').includes(name))[0]; }
  allByClass(name: string): FakeEl[] { return this.find(el => el.className.split(' ').includes(name)); }
}

let keys = new Set<(event: { key: string; target?: unknown; stopPropagation(): void; preventDefault(): void }) => void>();
let focused: FakeEl | null = null;
function installDom() {
  const head = new FakeEl('head'), body = new FakeEl('body');
  keys = new Set();
  vi.stubGlobal('document', {
    createElement: (tag: string) => new FakeEl(tag), head, body, getElementById: () => null,
    addEventListener: (_name: string, fn: never) => keys.add(fn), removeEventListener: (_name: string, fn: never) => keys.delete(fn),
    get activeElement() { return focused; },
  });
  return { head, body };
}
function press(key: string, extra: Record<string, unknown> = {}) {
  const event = { key, stopPropagation: vi.fn(), preventDefault: vi.fn(), ...extra };
  for (const fn of keys) fn(event as never);
  return event;
}

/** Manual clock: timers and animation frames only run when the test advances time. */
function clock() {
  let time = 0, id = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  let frames: (() => void)[] = [];
  return {
    schedule: (fn: () => void, ms: number) => { timers.set(++id, { at: time + ms, fn }); return id; },
    cancel: (handle: unknown) => { timers.delete(handle as number); },
    raf: (callback: () => void) => frames.push(callback),
    cancelRaf: () => { frames = []; },
    now: () => time,
    advance(ms: number) {
      const end = time + ms;
      for (;;) {
        const due = [...timers.entries()].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        timers.delete(due[0]); time = Math.max(time, due[1].at); due[1].fn();
      }
      time = end;
      const run = frames; frames = [];
      for (const frame of run) frame();
    },
  };
}

const GIFT = { marks: 1500, items: describeGiftItems(starterGiftItems()) };
const okResult: GiftOpenResult = { ok: true, granted: 1500, pending: false };
const names = (root: FakeEl) => root.allByClass('lp-gf-item').map(node => node.textContent);

describe('gift items', () => {
  it('describes the starter items: the car first, then paint, wheels and horn', () => {
    expect(describeGiftItems(starterGiftItems()).map(item => [item.label, item.name, item.kind])).toEqual([
      ['Starter car', 'Challenger', 'car'], ['Paint', 'Harbor Slate', 'paint'], ['Wheels', 'Forged Five', 'wheels'], ['Horn', 'Stock Horn', 'horn'],
    ]);
    expect(describeGiftItems(['nope'])).toEqual([]);
  });
  it('builds its text through textContent only', () => {
    const source = readFileSync('src/ui/gift-reveal.ts', 'utf8') + readFileSync('src/ui/starter-gift.ts', 'utf8');
    expect(source).not.toMatch(/innerHTML|insertAdjacentHTML|outerHTML/);
  });
});

describe('gift reveal', () => {
  let dom: ReturnType<typeof installDom>;
  beforeEach(() => { dom = installDom(); focused = null; });
  afterEach(() => vi.unstubAllGlobals());
  const shell = () => dom.body as unknown as HTMLElement;
  const open = (extra: Record<string, unknown> = {}, open: () => Promise<GiftOpenResult> = async () => okResult) => {
    const timing = clock();
    const hooks = { open: vi.fn(open), reduced: () => false, stepMs: 500, tickMs: 1000, ...timing, ...extra };
    const reveal = openGiftReveal(shell(), GIFT, hooks);
    return { reveal, hooks, timing, root: reveal.element as unknown as FakeEl };
  };

  it('starts as a wrapped box with no way to skip it: no Later button and Escape does nothing', () => {
    const { reveal, root, hooks } = open();
    expect(root.textContent).toContain('A gift from Louis');
    expect(root.find(node => node.attrs.role === 'dialog')).toHaveLength(1);
    expect(root.byClass('lp-gf-box')!.attrs['aria-label']).toBe('Open your starter gift');
    expect(root.find(node => node.tag === 'button').map(node => node.textContent)).toEqual(['']);
    expect(root.button('Later')).toBeUndefined();
    const escape = press('Escape');
    expect(escape.stopPropagation).toHaveBeenCalled();
    expect(reveal.stage()).toBe('box');
    expect(dom.body.children).toHaveLength(1);
    expect(hooks.open).not.toHaveBeenCalled();
    // Other keys never reach the menu behind it.
    expect(press('ArrowDown').stopPropagation).toHaveBeenCalled();
    expect(press('Enter', { target: {} }).preventDefault).toHaveBeenCalled();
  });

  it('opens on one tap: burst, then the car, paint, wheels, horn and a Marks counter that ticks up, then the two buttons', () => {
    const { reveal, root, hooks, timing } = open();
    root.byClass('lp-gf-box')!.click();
    expect(hooks.open).toHaveBeenCalledTimes(1);
    expect(reveal.stage()).toBe('bursting');
    expect(root.className).toContain('lp-gf-burst');
    timing.advance(800);
    expect(reveal.stage()).toBe('revealing');
    expect(names(root)).toEqual([expect.stringContaining('Challenger')]);
    timing.advance(500);
    expect(names(root)).toHaveLength(2);
    timing.advance(500); timing.advance(500);
    expect(names(root).map(text => text.replace(/^(Starter car|Paint|Wheels|Horn)/, '$1|'))).toEqual(['Starter car|Challenger', 'Paint|Harbor Slate', 'Wheels|Forged Five', 'Horn|Stock Horn']);
    expect(root.byClass('lp-gf-marks')).toBeUndefined();
    timing.advance(500);
    const number = root.byClass('lp-gf-num')!;
    expect(number.textContent).toBe('0');
    timing.advance(400);
    const mid = Number(number.textContent.replace(/,/g, ''));
    expect(mid).toBeGreaterThan(0); expect(mid).toBeLessThan(1500);
    expect(reveal.stage()).toBe('revealing');
    timing.advance(1200);
    expect(number.textContent).toBe('1,500');
    expect(reveal.stage()).toBe('done');
    expect(root.find(node => node.tag === 'button' && node.parent?.className === 'lp-gf-actions').map(node => node.textContent)).toEqual(['Open the shop', "Let's drive"]);
    expect(root.textContent).toContain('1,500');
  });

  it('can be fast-forwarded by a tap once it is open, and Escape then skips too', () => {
    const one = open();
    one.root.byClass('lp-gf-box')!.click();
    one.timing.advance(900);
    one.root.click({ closest: () => null });
    expect(one.reveal.stage()).toBe('done');
    expect(names(one.root)).toHaveLength(4);
    expect(one.root.byClass('lp-gf-num')!.textContent).toBe('1,500');
    const two = open();
    two.root.byClass('lp-gf-box')!.click();
    press('Escape');
    expect(two.reveal.stage()).toBe('done');
    expect(two.root.button("Let's drive")).toBeDefined();
  });

  it('shows everything at once with reduced motion', () => {
    const { reveal, root } = open({ reduced: () => true });
    root.byClass('lp-gf-box')!.click();
    expect(reveal.stage()).toBe('done');
    expect(names(root)).toHaveLength(4);
    expect(root.byClass('lp-gf-num')!.textContent).toBe('1,500');
  });

  it('closes with what the player chose', async () => {
    const outcomes: GiftOutcome[] = [];
    for (const choice of ["Let's drive", 'Open the shop', 'escape'] as const) {
      const { reveal, root } = open({ reduced: () => true });
      root.byClass('lp-gf-box')!.click();
      if (choice === 'escape') press('Escape'); else root.button(choice)!.click();
      outcomes.push(await reveal.done);
    }
    expect(outcomes).toEqual(['drive', 'shop', 'closed']);
    expect(dom.body.children).toHaveLength(0);
    expect(keys.size).toBe(0);
  });

  it('lets the player carry on when the Marks are still being saved, and says so', async () => {
    const { reveal, root } = open({ reduced: () => true }, async () => ({ ok: true, granted: 0, pending: true }));
    root.byClass('lp-gf-box')!.click();
    await vi.waitFor(() => expect(root.byClass('lp-gf-note')!.textContent).toContain('Saving your Marks'));
    expect(root.byClass('lp-gf-note')!.hidden).toBe(false);
    root.button("Let's drive")!.click();
    expect(await reveal.done).toBe('drive');
  });

  it('goes back to the box with a message when opening fails, so it can be tapped again', async () => {
    let attempts = 0;
    const { reveal, root, timing } = open({}, async () => (++attempts === 1 ? { ok: false, message: 'The gift did not open. Tap it to try again.' } : okResult));
    root.byClass('lp-gf-box')!.click();
    await vi.waitFor(() => expect(reveal.stage()).toBe('box'));
    expect(root.byClass('lp-gf-note')!.textContent).toContain('Tap it to try again');
    root.byClass('lp-gf-box')!.click();
    timing.advance(900);
    expect(attempts).toBe(2);
    expect(reveal.stage()).toBe('revealing');
  });
});
