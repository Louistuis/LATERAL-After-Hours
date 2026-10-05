import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { copyText, openTipGuide } from '../../src/ui/tip-guide';
import type { EarnFlow, EarnSource } from '../../src/economy/types';

/** A tiny DOM: enough for tip-guide, which builds everything with createElement and textContent. */
class FakeEl {
  children: FakeEl[] = [];
  text = ''; className = ''; id = ''; value = ''; type = ''; readOnly = false; style: Record<string, string> = {};
  attrs: Record<string, string> = {};
  handlers: Record<string, (() => void)[]> = {};
  parent: FakeEl | null = null;
  constructor(readonly tag: string) {}
  set textContent(value: string) { this.text = value; this.children = []; }
  get textContent(): string { return this.text + this.children.map(child => child.textContent).join(''); }
  append(...nodes: (FakeEl | string)[]): void { for (const node of nodes) { if (typeof node === 'string') this.text += node; else { node.parent = this; this.children.push(node); } } }
  replaceChildren(...nodes: FakeEl[]): void { this.children = []; this.text = ''; this.append(...nodes); }
  setAttribute(name: string, value: string): void { this.attrs[name] = value; }
  addEventListener(name: string, fn: () => void): void { (this.handlers[name] ??= []).push(fn); }
  remove(): void { if (this.parent) this.parent.children = this.parent.children.filter(child => child !== this); this.parent = null; }
  focus(): void {} select(): void {} setSelectionRange(): void {}
  click(): void { for (const fn of this.handlers.click ?? []) fn(); }
  find(predicate: (el: FakeEl) => boolean): FakeEl[] { return [...(predicate(this) ? [this] : []), ...this.children.flatMap(child => child.find(predicate))]; }
  button(label: string): FakeEl | undefined { return this.find(el => el.tag === 'button' && el.textContent === label)[0]; }
}

function installDom() {
  const head = new FakeEl('head'), body = new FakeEl('body');
  const listeners = new Set<unknown>();
  vi.stubGlobal('document', {
    createElement: (tag: string) => new FakeEl(tag), head, body, getElementById: () => null,
    addEventListener: (_n: string, fn: unknown) => listeners.add(fn), removeEventListener: (_n: string, fn: unknown) => listeners.delete(fn),
    execCommand: vi.fn(() => false),
  });
  return { head, body };
}

function flowOf(over: Partial<EarnFlow> = {}): EarnFlow {
  return { phase: 'waiting', offerId: 'tip-500', credits: 500, marks: 590, composer: 'opened', notice: null, posted: false, apiError: false,
    copyText: 'Tipping the LATERAL garage. See you after hours.', steps: ['Open the comments under the game.', 'Tap the tip icon and choose 500 credits.'], confirmed: null, startedAt: 0, checkedAt: 0, ...over };
}
function fakeSource(initial: EarnFlow | null) {
  let flow = initial;
  const listeners = new Set<() => void>();
  const startFlow = vi.fn(async () => flow);
  const source = {
    id: 'tips', kind: 'derived', label: 'Tips', available: () => true, flow: () => flow, startFlow, checkFlow: vi.fn(async () => {}), cancelFlow: vi.fn(() => { flow = null; for (const l of listeners) l(); }),
    subscribe: (l: () => void) => { listeners.add(l); return () => listeners.delete(l); }, dispose() {},
  } as unknown as EarnSource;
  return { source, startFlow, set(next: EarnFlow | null) { flow = next; for (const l of listeners) l(); } };
}

describe('tip guide panel', () => {
  beforeEach(() => { installDom(); });
  afterEach(() => { vi.unstubAllGlobals(); });

  it('starts the flow immediately and shows the pack, the Marks it gives, the steps and the copy message', () => {
    const shell = new FakeEl('div');
    const { source, startFlow } = fakeSource(flowOf());
    const guide = openTipGuide(shell as unknown as HTMLElement, source, 'tip-500')!;
    expect(startFlow).toHaveBeenCalledWith('tip-500');
    const text = guide.element.textContent;
    expect(text).toContain('Tip 500 credits');
    expect(text).toContain('590 Marks');
    expect(text).toContain('Open the comments under the game.');
    expect(text).toContain('Waiting for your tip...');
    expect(text).not.toMatch(/confirmed|added/i);
    const field = (guide.element as unknown as FakeEl).find(el => el.tag === 'input')[0]!;
    expect(field.value).toContain('LATERAL');
    expect((guide.element as unknown as FakeEl).button('Copy message')).toBeDefined();
  });
  it('only celebrates after the flow reports a confirmed record, and Done closes it', () => {
    const shell = new FakeEl('div');
    const fake = fakeSource(flowOf({ posted: true }));
    const guide = openTipGuide(shell as unknown as HTMLElement, fake.source, 'tip-500')!;
    expect(guide.element.textContent).toContain('Waiting for websim to record your tip');
    expect(guide.element.textContent).not.toContain('Marks added');
    fake.set(flowOf({ phase: 'confirmed', confirmed: { credits: 500, marks: 590, count: 1 } }));
    expect(guide.element.textContent).toContain('+590');
    expect(guide.element.textContent).toContain('Marks added');
    (guide.element as unknown as FakeEl).button('Done')!.click();
    expect(shell.children).toHaveLength(0);
  });
  it('shows the composer notice, an API error state and the timeout state', () => {
    const shell = new FakeEl('div');
    const fake = fakeSource(flowOf({ composer: 'needs-interaction', notice: 'Tap anywhere in the game and try again.', apiError: true }));
    const guide = openTipGuide(shell as unknown as HTMLElement, fake.source, 'tip-500')!;
    const el = guide.element as unknown as FakeEl;
    expect(el.textContent).toContain('Tap anywhere in the game and try again.');
    expect(el.textContent).toContain('Can not reach websim');
    expect(el.find(node => node.className.includes('err')).length).toBe(1);
    fake.set(flowOf({ phase: 'timeout' }));
    expect(el.textContent).toContain('We have not seen your tip yet');
    el.button('Check again')!.click();
    expect((fake.source.checkFlow as ReturnType<typeof vi.fn>)).toHaveBeenCalled();
  });
  it('Cancel stops the flow and closes; text from the flow is never parsed as markup', () => {
    const shell = new FakeEl('div');
    const fake = fakeSource(flowOf({ notice: '<img src=x onerror=alert(1)>' }));
    const guide = openTipGuide(shell as unknown as HTMLElement, fake.source, 'tip-500')!;
    const el = guide.element as unknown as FakeEl;
    expect(el.find(node => node.tag === 'img')).toHaveLength(0);
    expect(el.textContent).toContain('<img src=x onerror=alert(1)>');
    el.button('Cancel')!.click();
    expect(fake.source.cancelFlow).toHaveBeenCalled();
    expect(shell.children).toHaveLength(0);
  });
  it('returns null for sources without a tip flow', () => {
    expect(openTipGuide(new FakeEl('div') as unknown as HTMLElement, { id: 'x' } as unknown as EarnSource, 'a')).toBeNull();
  });
  it('copyText uses the clipboard when it works and falls back to selecting the field when it does not', async () => {
    const writeText = vi.fn(async () => {});
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    expect(await copyText('hello')).toBe(true);
    expect(writeText).toHaveBeenCalledWith('hello');
    vi.stubGlobal('navigator', { clipboard: { writeText: async () => { throw new Error('blocked'); } } });
    const field = new FakeEl('input') as unknown as HTMLInputElement;
    expect(await copyText('hello', field)).toBe(false);
    (document.execCommand as ReturnType<typeof vi.fn>).mockReturnValue(true);
    expect(await copyText('hello', field)).toBe(true);
  });
});
