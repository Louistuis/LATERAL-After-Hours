import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ALL_AVAILABLE, missionViews, type MissionView } from '../../src/economy/mission-catalog';
import { applyStats, emptyProgress, type MissionProgress } from '../../src/economy/mission-progress';
import type { ClaimResult, MissionsSource } from '../../src/economy/missions';
import { formatLeft, mountMissionToasts, openMissions, sortViews } from '../../src/ui/missions-panel';

/** A tiny DOM: enough for missions-panel, which builds everything with createElement and textContent. */
class FakeEl {
  children: FakeEl[] = [];
  text = ''; className = ''; id = ''; type = ''; style: Record<string, string> = {};
  attrs: Record<string, string> = {};
  handlers: Record<string, ((event?: unknown) => void)[]> = {};
  parent: FakeEl | null = null;
  constructor(readonly tag: string) {}
  set textContent(value: string) { this.text = value; this.children = []; }
  get textContent(): string { return this.text + this.children.map(child => child.textContent).join(''); }
  append(...nodes: (FakeEl | string)[]): void { for (const node of nodes) { if (typeof node === 'string') this.text += node; else { node.parent = this; this.children.push(node); } } }
  replaceChildren(...nodes: FakeEl[]): void { this.children = []; this.text = ''; this.append(...nodes); }
  setAttribute(name: string, value: string): void { this.attrs[name] = value; }
  addEventListener(name: string, fn: (event?: unknown) => void): void { (this.handlers[name] ??= []).push(fn); }
  remove(): void { if (this.parent) this.parent.children = this.parent.children.filter(child => child !== this); this.parent = null; }
  focus(): void {}
  click(): void { for (const fn of this.handlers.click ?? []) fn(); }
  find(predicate: (el: FakeEl) => boolean): FakeEl[] { return [...(predicate(this) ? [this] : []), ...this.children.flatMap(child => child.find(predicate))]; }
  buttons(prefix: string): FakeEl[] { return this.find(el => el.tag === 'button' && el.textContent.startsWith(prefix)); }
  claimButtons(): FakeEl[] { return this.find(el => el.tag === 'button' && el.textContent === 'Claim'); }
  byClass(name: string): FakeEl[] { return this.find(el => el.className.split(' ').includes(name)); }
}

let keyHandlers: ((event: { key: string; stopPropagation(): void }) => void)[] = [];
function installDom() {
  const head = new FakeEl('head'), body = new FakeEl('body');
  keyHandlers = [];
  vi.stubGlobal('document', {
    createElement: (tag: string) => new FakeEl(tag), head, body, getElementById: () => null,
    addEventListener: (_n: string, fn: never) => keyHandlers.push(fn), removeEventListener: (_n: string, fn: never) => { keyHandlers = keyHandlers.filter(h => h !== fn); },
  });
}

const NOW = Date.UTC(2026, 9, 2, 12);
const ROUTES = ['HW-01', 'HW-02', 'RP-01', 'RP-02', 'CL-01', 'CL-02'];

function fakeSource(progress: MissionProgress = emptyProgress(NOW), claimResult?: (view: MissionView) => ClaimResult) {
  let claimed = new Set<string>();
  const listeners = new Set<() => void>(), completes = new Set<(view: MissionView) => void>();
  const views = (): MissionView[] => missionViews(progress, ALL_AVAILABLE, key => claimed.has(key), NOW);
  const claim = vi.fn(async (key: string): Promise<ClaimResult> => {
    const view = views().find(entry => entry.key === key)!;
    const result = claimResult?.(view) ?? { status: 'claimed' as const, marks: view.def.reward, message: `+${view.def.reward} Marks` };
    if (result.status === 'claimed') { claimed = new Set([...claimed, key]); for (const l of listeners) l(); }
    return result;
  });
  const source = {
    id: 'missions', kind: 'accrued', label: 'Missions', available: () => false, views, claim,
    claimable: () => views().filter(view => view.complete && !view.claimed).length,
    onComplete: (l: (view: MissionView) => void) => { completes.add(l); return () => completes.delete(l); },
    resets: () => ({ dayMs: 5 * 3_600_000 + 12 * 60_000, weekMs: 3 * 86_400_000 + 3_600_000 }),
    subscribe: (l: () => void) => { listeners.add(l); return () => listeners.delete(l); }, dispose() {},
  } as unknown as MissionsSource;
  return { source, claim, complete: (view: MissionView) => { for (const l of completes) l(view); }, set: (next: MissionProgress) => { progress = next; for (const l of listeners) l(); }, listeners, completes };
}
const withRun = (): MissionProgress => applyStats(emptyProgress(NOW), NOW, [{ key: 'runs', add: 5 }, { key: 'runs.da', add: 3 }, { key: 'dist.m', add: 6000 }]);

describe('missions screen', () => {
  beforeEach(() => { installDom(); vi.useFakeTimers(); vi.setSystemTime(NOW); });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

  it('shows three daily missions with progress bars, rewards and the reset timer', () => {
    const shell = new FakeEl('div');
    const { source } = fakeSource(withRun());
    const panel = openMissions(shell as unknown as HTMLElement, source);
    const root = panel.element as unknown as FakeEl;
    expect(root.attrs.role).toBe('dialog');
    expect(root.textContent).toContain('Missions');
    expect(root.byClass('lp-ms-row')).toHaveLength(3);
    expect(root.find(el => el.attrs.role === 'progressbar')).toHaveLength(3);
    expect(root.textContent).toContain('New daily missions in 5h 12m');
    for (const reward of root.byClass('lp-ms-reward')) expect(reward.textContent).toMatch(/^\+\d+Marks$/);
  });
  it('has Daily, Weekly and Career tabs, career lists every mission, weekly shows its own timer', () => {
    const shell = new FakeEl('div');
    const { source } = fakeSource();
    const root = openMissions(shell as unknown as HTMLElement, source).element as unknown as FakeEl;
    expect(root.buttons('Daily')).toHaveLength(1);
    root.buttons('Weekly')[0]!.click();
    expect(root.byClass('lp-ms-row')).toHaveLength(2);
    expect(root.textContent).toContain('New weekly challenges in 3d 1h');
    root.buttons('Career')[0]!.click();
    expect(root.byClass('lp-ms-row').length).toBeGreaterThanOrEqual(30);
    expect(root.textContent).toMatch(/0 of \d+ claimed/);
    expect(root.find(el => el.attrs['aria-selected'] === 'true').map(el => el.textContent)).toEqual(['Career']);
  });
  it('a ready mission shows a Claim button; clicking it calls claim with the mission key and plays the reward animation', async () => {
    const shell = new FakeEl('div');
    const fake = fakeSource(withRun());
    const root = openMissions(shell as unknown as HTMLElement, fake.source, { initialTab: 'career' }).element as unknown as FakeEl;
    const buttons = root.claimButtons();
    expect(buttons.length).toBeGreaterThanOrEqual(2);
    expect(root.textContent).toContain('Marks waiting');
    const first = fake.source.views().find(view => view.def.id === 'first-finish')!;
    // Ready rows sort first; the first Claim button belongs to the first ready row.
    buttons[0]!.click();
    expect(fake.claim).toHaveBeenCalledTimes(1);
    expect(root.textContent).toContain('Claiming...');
    await vi.advanceTimersByTimeAsync(300);
    const claimedKey = fake.claim.mock.calls[0]![0] as string;
    expect(fake.source.views().find(view => view.key === claimedKey)!.claimed).toBe(true);
    expect(root.byClass('lp-ms-fly')).toHaveLength(1);
    expect(root.byClass('lp-ms-fly')[0]!.textContent).toMatch(/^\+\d+$/);
    expect(root.byClass('just')).toHaveLength(1);
    expect(root.textContent).toContain('Claimed');
    expect(first.def.reward).toBeGreaterThan(0);
    await vi.advanceTimersByTimeAsync(1600);
    // Next render drops the animation.
    fake.set(withRun());
    await vi.advanceTimersByTimeAsync(300);
    expect(root.byClass('lp-ms-fly')).toHaveLength(0);
  });
  it('double clicking claims once, and a refused claim shows its message without a celebration', async () => {
    const shell = new FakeEl('div');
    const fake = fakeSource(withRun(), () => ({ status: 'unavailable', marks: 0, message: 'The wallet could not pay this one yet. Try again later.' }));
    const root = openMissions(shell as unknown as HTMLElement, fake.source, { initialTab: 'career' }).element as unknown as FakeEl;
    const button = root.claimButtons()[0]!;
    button.click(); button.click();
    expect(fake.claim).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(300);
    expect(root.textContent).toContain('The wallet could not pay this one yet');
    expect(root.byClass('lp-ms-fly')).toHaveLength(0);
    expect(root.textContent).not.toMatch(/Claimed/);
  });
  it('Claim all claims every ready mission in turn', async () => {
    const shell = new FakeEl('div');
    const fake = fakeSource(withRun());
    const root = openMissions(shell as unknown as HTMLElement, fake.source, { initialTab: 'career' }).element as unknown as FakeEl;
    const ready = root.claimButtons().length;
    expect(ready).toBeGreaterThanOrEqual(2);
    root.buttons('Claim all')[0]!.click();
    await vi.advanceTimersByTimeAsync(2000);
    expect(fake.claim).toHaveBeenCalledTimes(ready);
    expect(root.claimButtons()).toHaveLength(0);
    expect(root.buttons('Claim all')).toHaveLength(0);
  });
  it('Escape and Close both close it, remove the listeners and call onClose once', () => {
    const shell = new FakeEl('div');
    const fake = fakeSource();
    const onClose = vi.fn();
    const panel = openMissions(shell as unknown as HTMLElement, fake.source, { onClose });
    expect(shell.children).toHaveLength(1);
    expect(fake.listeners.size).toBe(1);
    keyHandlers[0]!({ key: 'Escape', stopPropagation() {} });
    expect(shell.children).toHaveLength(0);
    expect(fake.listeners.size).toBe(0);
    expect(keyHandlers).toHaveLength(0);
    panel.close();
    expect(onClose).toHaveBeenCalledTimes(1);
    const again = openMissions(shell as unknown as HTMLElement, fake.source, { onClose });
    (again.element as unknown as FakeEl).buttons('Close')[0]!.click();
    expect(shell.children).toHaveLength(0);
    expect(onClose).toHaveBeenCalledTimes(2);
  });
  it('re-renders when the source changes, and never parses mission text as markup', async () => {
    const shell = new FakeEl('div');
    const fake = fakeSource();
    const root = openMissions(shell as unknown as HTMLElement, fake.source, { initialTab: 'career' }).element as unknown as FakeEl;
    expect(root.claimButtons()).toHaveLength(0);
    fake.set(withRun());
    await vi.advanceTimersByTimeAsync(300);
    expect(root.claimButtons().length).toBeGreaterThan(0);
    expect(root.find(el => el.tag === 'img' || el.tag === 'script')).toHaveLength(0);
  });
  it('formats timers and sorts ready missions first, claimed last', () => {
    expect(formatLeft(30_000)).toBe('less than a minute');
    expect(formatLeft(9 * 60_000)).toBe('9m');
    expect(formatLeft(5 * 3_600_000 + 12 * 60_000)).toBe('5h 12m');
    expect(formatLeft(2 * 86_400_000 + 4 * 3_600_000)).toBe('2d 4h');
    expect(formatLeft(Number.NaN)).toBe('less than a minute');
    const { source } = fakeSource(withRun());
    const career = source.views().filter(view => view.kind === 'career');
    const sorted = sortViews(career.map((view, index) => (index === 0 ? { ...view, claimed: true } : view)));
    expect(sorted[0]!.complete && !sorted[0]!.claimed).toBe(true);
    expect(sorted[sorted.length - 1]!.claimed).toBe(true);
  });
});

describe('mission toasts', () => {
  beforeEach(() => { installDom(); vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

  it('shows a toast when a mission completes, with the title and reward, and removes it after a while', async () => {
    const shell = new FakeEl('div');
    const fake = fakeSource();
    const off = mountMissionToasts(shell as unknown as HTMLElement, fake.source, { ms: 1000 });
    const view = fake.source.views().find(entry => entry.def.id === 'first-finish')!;
    fake.complete(view);
    const layer = shell.children[0]!;
    expect(layer.attrs['aria-live']).toBe('polite');
    expect(layer.textContent).toContain('Mission complete');
    expect(layer.textContent).toContain('First finish');
    expect(layer.textContent).toContain('+50');
    expect(layer.byClass('lp-mt-item')).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1100);
    expect(layer.byClass('out')).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(400);
    expect(layer.byClass('lp-mt-item')).toHaveLength(0);
    off();
    expect(shell.children).toHaveLength(0);
    expect(fake.completes.size).toBe(0);
  });
  it('labels daily and weekly ones and keeps at most three toasts', () => {
    const shell = new FakeEl('div');
    const fake = fakeSource();
    mountMissionToasts(shell as unknown as HTMLElement, fake.source, { ms: 60_000, max: 3 });
    const views = fake.source.views();
    fake.complete(views.find(view => view.kind === 'daily')!);
    fake.complete(views.find(view => view.kind === 'weekly')!);
    const layer = shell.children[0]!;
    expect(layer.textContent).toContain('Daily mission complete');
    expect(layer.textContent).toContain('Weekly challenge complete');
    for (let i = 0; i < 5; i++) fake.complete(views[5 + i]!);
    expect(layer.byClass('lp-mt-item')).toHaveLength(3);
  });
});
