import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPlateField } from '../../src/ui/plate-field';
import type { Economy, ItemState, PlateResult } from '../../src/economy/types';

/** A tiny DOM: enough for plate-field, which builds everything with createElement, textContent and value. */
class FakeEl {
  children: FakeEl[] = [];
  text = ''; className = ''; id = ''; value = ''; type = ''; disabled = false; hidden = false; maxLength = -1; width = 0; height = 0;
  attrs: Record<string, string> = {};
  handlers: Record<string, ((event: unknown) => void)[]> = {};
  parent: FakeEl | null = null;
  constructor(readonly tag: string) {}
  set textContent(value: string) { this.text = value; this.children = []; }
  get textContent(): string { return this.text + this.children.map(child => child.textContent).join(''); }
  get parentElement(): FakeEl | null { return this.parent; }
  get lastElementChild(): FakeEl | null { return this.children[this.children.length - 1] ?? null; }
  append(...nodes: (FakeEl | string)[]): void { for (const node of nodes) { if (typeof node === 'string') this.text += node; else { node.remove(); node.parent = this; this.children.push(node); } } }
  replaceChildren(...nodes: FakeEl[]): void { for (const child of this.children) child.parent = null; this.children = []; this.text = ''; this.append(...nodes); }
  setAttribute(name: string, value: string): void { this.attrs[name] = value; }
  addEventListener(name: string, fn: (event: unknown) => void): void { (this.handlers[name] ??= []).push(fn); }
  remove(): void { if (this.parent) this.parent.children = this.parent.children.filter(child => child !== this); this.parent = null; }
  focus(): void { focused = this; }
  blur(): void { if (focused === this) focused = null; }
  setSelectionRange(): void {}
  fire(name: string, event: Record<string, unknown> = {}): void { for (const fn of this.handlers[name] ?? []) fn({ stopPropagation() {}, preventDefault() {}, ...event }); }
  type_(text: string): void { this.value = text; this.fire('input'); }
  find(predicate: (el: FakeEl) => boolean): FakeEl[] { return [...(predicate(this) ? [this] : []), ...this.children.flatMap(child => child.find(predicate))]; }
  byClass(name: string): FakeEl[] { return this.find(el => el.className.split(' ').includes(name)); }
  button(label: string): FakeEl | undefined { return this.find(el => el.tag === 'button' && el.textContent === label)[0]; }
}
let focused: FakeEl | null = null;
function installDom() {
  const head = new FakeEl('head'), body = new FakeEl('body');
  focused = null;
  vi.stubGlobal('document', { createElement: (tag: string) => new FakeEl(tag), head, body, getElementById: () => null, get activeElement() { return focused; } });
}

function fakeEconomy(initial: { usable: boolean; status?: ItemState['status']; plateText?: string } = { usable: false }) {
  let usable = initial.usable, status: ItemState['status'] = initial.status ?? (initial.usable ? 'owned' : 'unaffordable'), plateText = initial.plateText;
  const listeners = new Set<() => void>();
  const setPlateText = vi.fn(async (text: string): Promise<PlateResult> => {
    const trimmed = text.trim();
    if (!usable) return { ok: false, reason: 'locked', message: 'Unlock the Custom Plate first.' };
    plateText = trimmed ? trimmed.toUpperCase() : undefined;
    for (const l of listeners) l();
    return { ok: true, text: trimmed.toUpperCase() };
  });
  const economy = {
    itemState: () => ({ id: 'plate-custom', kind: 'cosmetic', slot: 'plate', price: 9990, status, usable, shortfall: 0, reason: status === 'locked' ? 'Your verified Marks do not cover this item yet.' : null }),
    view: () => ({ equipped: plateText ? { plate: 'plate-custom', plateText } : {} }),
    subscribe: (l: () => void) => { listeners.add(l); return () => listeners.delete(l); },
    setPlateText,
  } as unknown as Economy;
  return { economy, setPlateText, unlock() { usable = true; status = 'owned'; for (const l of listeners) l(); }, listeners };
}

describe('custom plate field', () => {
  beforeEach(() => installDom());
  afterEach(() => vi.unstubAllGlobals());

  it('is hidden until shown, and hiding it clears the draft preview', () => {
    const fake = fakeEconomy({ usable: true });
    const drafts: (string | null)[] = [];
    const field = createPlateField(fake.economy, { onDraft: text => drafts.push(text) });
    const root = field.element as unknown as FakeEl;
    expect(root.hidden).toBe(true);
    field.show(true);
    expect(root.hidden).toBe(false);
    const input = root.find(el => el.tag === 'input')[0]!;
    input.type_('dock 07');
    expect(field.draft()).toBe('DOCK 07');
    field.show(false);
    expect(root.hidden).toBe(true);
    expect(field.draft()).toBeNull();
    expect(drafts).toEqual(['DOCK 07', null]);
  });
  it('locked: shows the price and no text field', () => {
    const fake = fakeEconomy({ usable: false });
    const field = createPlateField(fake.economy, { onDraft: () => {} });
    field.show(true);
    const root = field.element as unknown as FakeEl;
    expect(root.textContent).toContain('Locked');
    expect(root.textContent).toContain('9,990 M');
    expect(root.find(el => el.tag === 'input')).toHaveLength(0);
    expect(root.button('Save plate')).toBeUndefined();
    expect(field.draft()).toBeNull();
  });
  it('locked by verification shows the economy reason, and unlocking swaps in the field by itself', () => {
    const fake = fakeEconomy({ usable: false, status: 'locked' });
    const field = createPlateField(fake.economy, { onDraft: () => {} });
    field.show(true);
    const root = field.element as unknown as FakeEl;
    expect(root.textContent).toContain('verified Marks do not cover');
    fake.unlock();
    expect(root.find(el => el.tag === 'input')).toHaveLength(1);
    expect(root.textContent).not.toContain('Locked');
  });
  it('validates as you type: counter, message for rejected text, live draft only for valid text', () => {
    const fake = fakeEconomy({ usable: true });
    const drafts: (string | null)[] = [];
    const field = createPlateField(fake.economy, { onDraft: text => drafts.push(text) });
    field.show(true);
    const root = field.element as unknown as FakeEl;
    const input = root.find(el => el.tag === 'input')[0]!;
    const message = () => root.byClass('lp-pf-msg')[0]!;
    const save = root.button('Save plate')!;
    expect(save.disabled).toBe(true);
    input.type_('a');
    expect(message().textContent).toContain('Too short');
    expect(message().className).toContain('err');
    expect(input.attrs['aria-invalid']).toBe('true');
    expect(root.byClass('lp-pf-count')[0]!.textContent).toBe('1/8');
    expect(save.disabled).toBe(true);
    input.type_('toolongtext');
    expect(message().textContent).toContain('8 characters at most');
    input.type_('ab_c');
    expect(message().textContent).toContain('letters A to Z');
    input.type_('FUCK');
    expect(message().textContent).toContain('not allowed');
    expect(field.draft()).toBeNull();
    input.type_('f-u-c-k');
    expect(message().textContent).toContain('not allowed');
    input.type_('drift 1');
    expect(message().textContent).toBe('');
    expect(input.attrs['aria-invalid']).toBe('false');
    expect(field.draft()).toBe('DRIFT 1');
    expect(save.disabled).toBe(false);
    expect(drafts[drafts.length - 1]).toBe('DRIFT 1');
    for (const text of ['a', 'ab_c', 'FUCK']) { input.type_(text); expect(field.draft()).toBeNull(); expect(message().textContent).not.toMatch(/—|–/); }
  });
  it('Save calls the economy with the typed text, shows the result and marks it saved; Enter saves too', async () => {
    const fake = fakeEconomy({ usable: true });
    const saved = vi.fn();
    const field = createPlateField(fake.economy, { onDraft: () => {}, onSaved: saved });
    field.show(true);
    const root = field.element as unknown as FakeEl;
    const input = root.find(el => el.tag === 'input')[0]!;
    input.type_('dock 07');
    root.button('Save plate')!.fire('click');
    await vi.waitFor(() => expect(saved).toHaveBeenCalledWith('DOCK 07'));
    expect(fake.setPlateText).toHaveBeenCalledWith('dock 07');
    expect(root.byClass('lp-pf-msg')[0]!.textContent).toContain('Plate saved');
    expect(root.byClass('lp-pf-msg')[0]!.className).toContain('ok');
    expect(root.button('Save plate')!.disabled).toBe(true);
    input.type_('dock 08');
    input.fire('keydown', { key: 'Enter' });
    await vi.waitFor(() => expect(saved).toHaveBeenCalledWith('DOCK 08'));
  });
  it('an invalid text is never sent, and a refused save shows the economy message', async () => {
    const fake = fakeEconomy({ usable: true });
    const field = createPlateField(fake.economy, { onDraft: () => {} });
    field.show(true);
    const root = field.element as unknown as FakeEl;
    const input = root.find(el => el.tag === 'input')[0]!;
    input.type_('FUCK');
    input.fire('keydown', { key: 'Enter' });
    await Promise.resolve();
    expect(fake.setPlateText).not.toHaveBeenCalled();
    const failing = fakeEconomy({ usable: true });
    failing.setPlateText.mockResolvedValueOnce({ ok: false, reason: 'not-ready', message: 'The wallet is still loading.' });
    const second = createPlateField(failing.economy, { onDraft: () => {} });
    second.show(true);
    const root2 = second.element as unknown as FakeEl;
    root2.find(el => el.tag === 'input')[0]!.type_('ok 12');
    root2.button('Save plate')!.fire('click');
    await vi.waitFor(() => expect(root2.byClass('lp-pf-msg')[0]!.textContent).toContain('still loading'));
    expect(root2.byClass('lp-pf-msg')[0]!.className).toContain('err');
  });
  it('prefills the saved text, and an empty field offers to go back to the LATERAL plate', async () => {
    const fake = fakeEconomy({ usable: true, plateText: 'MINE 1' });
    const field = createPlateField(fake.economy, { onDraft: () => {} });
    field.show(true);
    const root = field.element as unknown as FakeEl;
    const input = root.find(el => el.tag === 'input')[0]!;
    expect(input.value).toBe('MINE 1');
    input.type_('');
    expect(root.byClass('lp-pf-msg')[0]!.textContent).toContain('LATERAL');
    const save = root.button('Save plate')!;
    expect(save.disabled).toBe(false);
    save.fire('click');
    await vi.waitFor(() => expect(fake.setPlateText).toHaveBeenCalledWith(''));
  });
  it('typing never reaches the showroom or the game: keydown and keyup stop propagating; text is never markup', () => {
    const fake = fakeEconomy({ usable: true });
    const field = createPlateField(fake.economy, { onDraft: () => {} });
    field.show(true);
    const root = field.element as unknown as FakeEl;
    const input = root.find(el => el.tag === 'input')[0]!;
    const stop = vi.fn();
    input.fire('keydown', { key: 'w', stopPropagation: stop });
    input.fire('keyup', { key: 'w', stopPropagation: stop });
    expect(stop).toHaveBeenCalledTimes(2);
    input.type_('<img src=x>');
    expect(root.find(el => el.tag === 'img')).toHaveLength(0);
    expect(root.byClass('lp-pf-msg')[0]!.textContent).toContain('letters A to Z');
  });
  it('re-attaching under a rebuilt card keeps focus on the input, and dispose detaches everything', () => {
    const fake = fakeEconomy({ usable: true });
    const field = createPlateField(fake.economy, { onDraft: () => {} });
    field.show(true);
    const root = field.element as unknown as FakeEl;
    const card = new FakeEl('aside');
    field.attachTo(card as unknown as HTMLElement);
    const input = root.find(el => el.tag === 'input')[0]!;
    input.focus();
    card.replaceChildren(new FakeEl('div'));
    expect(root.parent).toBeNull();
    field.attachTo(card as unknown as HTMLElement);
    expect(root.parent).toBe(card);
    expect(focused).toBe(input);
    field.dispose();
    expect(root.parent).toBeNull();
    expect(fake.listeners.size).toBe(0);
  });
});
