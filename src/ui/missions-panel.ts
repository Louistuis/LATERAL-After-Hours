/**
 * Missions screen and mid-drive toasts. Self-contained (DOM + CSS), mounted inside the game shell so it inherits the
 * game's fonts and palette (.lp-shell variables). Data and rules live in src/economy/missions.ts; this file only draws
 * a MissionsSource and calls source.claim(). It never computes a reward.
 *
 *   openMissions(shell, source, hooks)  full screen list: Daily, Weekly and Career tabs, progress bars, claim buttons,
 *                                        reset timers and a reward animation on every claim
 *   mountMissionToasts(shell, source)   a small toast at the top centre when a mission completes while driving
 *
 * All text goes in through textContent: nothing from the game or the player is ever parsed as HTML.
 */
import { progressText, type MissionView } from '../economy/mission-catalog';
import type { MissionsSource } from '../economy/missions';

export interface MissionsPanel { close(): void; readonly element: HTMLElement }

type TabId = 'daily' | 'weekly' | 'career';
const TABS: readonly { readonly id: TabId; readonly label: string }[] = [
  { id: 'daily', label: 'Daily' }, { id: 'weekly', label: 'Weekly' }, { id: 'career', label: 'Career' },
];

const STYLE_ID = 'lp-missions-style';
const CSS = `
.lp-ms{position:absolute;inset:0;z-index:58;display:grid;grid-template-rows:minmax(0,1fr);place-items:center;padding:max(14px,env(safe-area-inset-top)) max(14px,env(safe-area-inset-right)) max(14px,env(safe-area-inset-bottom)) max(14px,env(safe-area-inset-left));background:rgba(2,7,9,.78);backdrop-filter:blur(6px);-webkit-backdrop-filter:blur(6px);pointer-events:auto;font-family:var(--lp-font,system-ui);color:var(--lp-ink,#f4f7f1)}
.lp-ms-card{position:relative;display:flex;flex-direction:column;width:min(780px,100%);max-height:100%;min-height:0;padding:20px 22px 16px;background:rgba(6,13,15,.97);border:1px solid var(--lp-line-strong,rgba(130,205,196,.5));clip-path:polygon(0 0,calc(100% - 18px) 0,100% 18px,100% 100%,18px 100%,0 calc(100% - 18px));outline:none}
.lp-ms-head{display:flex;flex-wrap:wrap;align-items:flex-end;justify-content:space-between;gap:10px 18px;margin:0 0 12px}
.lp-ms-kicker{margin:0;font-size:.72em;font-weight:600;letter-spacing:.24em;text-transform:uppercase;color:var(--lp-teal,#2fb8ad)}
.lp-ms-card h3{margin:.1em 0 0;font:700 clamp(32px,6vw,48px)/.92 var(--lp-stencil,var(--lp-display,system-ui));letter-spacing:.02em;text-transform:uppercase}
.lp-ms-wait{margin:0;font-size:.9em;color:var(--lp-faint,#8fa19a);text-align:right}
.lp-ms-wait b{color:var(--lp-accent,#d8fa72);font-variant-numeric:tabular-nums}
.lp-ms-tabs{display:flex;gap:6px;margin:0 0 6px;border-bottom:1px solid var(--lp-line,rgba(130,205,196,.26))}
.lp-ms-tabs button{position:relative;padding:.55em 1em .6em;font:600 .9em var(--lp-font,system-ui);letter-spacing:.1em;text-transform:uppercase;color:var(--lp-dim,#b7c5bf);background:none;border:0;border-bottom:3px solid transparent;border-radius:0;cursor:pointer}
.lp-ms-tabs button[aria-selected=true]{color:var(--lp-ink,#f4f7f1);border-bottom-color:var(--lp-accent,#d8fa72)}
.lp-ms-tabs button i{display:inline-block;min-width:1.5em;margin-left:.5em;padding:0 .4em;font:800 .85em/1.5 var(--lp-display,system-ui);font-style:normal;text-align:center;color:var(--lp-on-accent,#0d1505);background:var(--lp-accent,#d8fa72);border-radius:9px}
.lp-ms-sub{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:8px;margin:0 0 8px;font-size:.85em;color:var(--lp-faint,#8fa19a);letter-spacing:.04em}
.lp-ms-sub button{padding:.35em .9em;font-size:.95em}
.lp-ms-list{display:flex;flex-direction:column;gap:8px;margin:0;padding:0 2px 2px 0;list-style:none;overflow:auto;min-height:0}
.lp-ms-row{position:relative;flex:none;display:grid;grid-template-columns:1fr auto;gap:4px 14px;align-items:center;padding:10px 12px;background:rgba(255,255,255,.04);border:1px solid var(--lp-line,rgba(130,205,196,.26));border-left:4px solid var(--lp-line-strong,rgba(130,205,196,.5));overflow:hidden}
.lp-ms-row.ready{border-left-color:var(--lp-accent,#d8fa72);background:rgba(216,250,114,.07)}
.lp-ms-row.done{opacity:.55;border-left-color:var(--lp-teal,#2fb8ad)}
.lp-ms-title{margin:0;font:700 1.05em var(--lp-font,system-ui);letter-spacing:.03em}
.lp-ms-text{margin:.15em 0 0;font-size:.86em;line-height:1.35;color:var(--lp-dim,#b7c5bf)}

.lp-ms-reward{font:800 1.5em/1 var(--lp-display,system-ui);color:var(--lp-accent,#d8fa72);font-variant-numeric:tabular-nums;text-align:right}
.lp-ms-reward small{display:block;margin-top:.2em;font:600 .5em var(--lp-font,system-ui);letter-spacing:.14em;text-transform:uppercase;color:var(--lp-faint,#8fa19a)}
.lp-ms-bar{grid-column:1/-1;display:grid;grid-template-columns:1fr auto;gap:10px;align-items:center}
.lp-ms-track{position:relative;height:8px;background:rgba(255,255,255,.09);overflow:hidden}
.lp-ms-fill{display:block;height:100%;width:0;background:linear-gradient(90deg,var(--lp-teal,#2fb8ad),var(--lp-accent,#d8fa72));transition:width .5s cubic-bezier(.2,.8,.2,1)}
.lp-ms-row.ready .lp-ms-fill{box-shadow:0 0 12px rgba(216,250,114,.7)}
.lp-ms-num{font-size:.8em;color:var(--lp-faint,#8fa19a);font-variant-numeric:tabular-nums;min-width:5.5em;text-align:right}
.lp-ms-claim{display:grid;gap:6px;justify-items:end;grid-column:2;grid-row:1}
.lp-ms-row button.go{padding:.5em 1.2em}
.lp-ms-state{font-size:.8em;letter-spacing:.12em;text-transform:uppercase;color:var(--lp-teal,#2fb8ad)}
.lp-ms-msg{grid-column:1/-1;margin:0;font-size:.82em;color:var(--lp-hot,#ff8a1f)}
.lp-ms-empty{margin:18px 0;text-align:center;color:var(--lp-faint,#8fa19a)}
.lp-ms-actions{display:flex;justify-content:flex-end;gap:8px;margin:12px 0 0}
.lp-ms-row.just{animation:lp-ms-flash 1.1s ease-out}
@keyframes lp-ms-flash{0%{background:rgba(216,250,114,.45);transform:scale(1.015)}100%{background:rgba(255,255,255,.04);transform:none}}
.lp-ms-fly{position:absolute;right:14px;top:50%;z-index:2;font:800 2em/1 var(--lp-display,system-ui);color:var(--lp-accent,#d8fa72);text-shadow:0 0 18px rgba(216,250,114,.8);pointer-events:none;animation:lp-ms-fly 1.3s cubic-bezier(.2,.9,.3,1) both}
@keyframes lp-ms-fly{0%{opacity:0;transform:translateY(14px) scale(.5)}20%{opacity:1;transform:translateY(-6px) scale(1.25)}100%{opacity:0;transform:translateY(-46px) scale(1)}}
.lp-mt{position:absolute;left:50%;top:max(12px,env(safe-area-inset-top));z-index:46;display:grid;gap:6px;width:min(420px,calc(100% - 24px));transform:translateX(-50%);pointer-events:none;font-family:var(--lp-font,system-ui)}
.lp-mt-item{display:grid;grid-template-columns:auto 1fr auto;gap:10px;align-items:center;padding:9px 14px 9px 10px;color:var(--lp-ink,#f4f7f1);background:rgba(4,10,12,.94);border:1px solid rgba(216,250,114,.45);border-left:4px solid var(--lp-accent,#d8fa72);animation:lp-mt-in .35s cubic-bezier(.2,1.2,.4,1) both}
.lp-mt-item.out{animation:lp-mt-out .3s ease-in both}
.lp-mt-icon{display:grid;place-items:center;width:26px;height:26px;font:800 15px/1 var(--lp-display,system-ui);color:var(--lp-on-accent,#0d1505);background:var(--lp-accent,#d8fa72);clip-path:polygon(0 0,calc(100% - 6px) 0,100% 6px,100% 100%,6px 100%,0 calc(100% - 6px))}
.lp-mt-kicker{margin:0;font-size:.66em;font-weight:600;letter-spacing:.22em;text-transform:uppercase;color:var(--lp-teal,#2fb8ad)}
.lp-mt-title{margin:0;font:700 .98em var(--lp-font,system-ui);letter-spacing:.03em}
.lp-mt-marks{font:800 1.3em/1 var(--lp-display,system-ui);color:var(--lp-accent,#d8fa72);font-variant-numeric:tabular-nums}
@keyframes lp-mt-in{0%{opacity:0;transform:translateY(-16px) scale(.94)}100%{opacity:1;transform:none}}
@keyframes lp-mt-out{to{opacity:0;transform:translateY(-10px)}}
@media (max-width:560px){.lp-ms-card{padding:16px 14px 12px}.lp-ms-row{grid-template-columns:1fr}.lp-ms-reward{text-align:left}.lp-ms-claim{grid-column:1;grid-row:auto;grid-auto-flow:column;justify-content:space-between;justify-items:start;align-items:center}.lp-ms-wait{text-align:left}}
@media (prefers-reduced-motion:reduce){.lp-ms-row.just,.lp-ms-fly,.lp-mt-item,.lp-mt-item.out{animation:none}.lp-ms-fill{transition:none}}
`;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text = ''): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}
function ensureStyle(): void {
  if (document.getElementById(STYLE_ID)) return;
  const style = el('style');
  style.id = STYLE_ID; style.textContent = CSS; document.head.append(style);
}
const fmt = (n: number): string => Math.round(n).toLocaleString('en-US');

/** "2d 4h", "5h 12m", "9m", "less than a minute". */
export function formatLeft(ms: number): string {
  if (!Number.isFinite(ms) || ms < 60_000) return 'less than a minute';
  const minutes = Math.floor(ms / 60_000), hours = Math.floor(minutes / 60), days = Math.floor(hours / 24);
  if (days >= 1) return `${days}d ${hours % 24}h`;
  if (hours >= 1) return `${hours}h ${minutes % 60}m`;
  return `${minutes}m`;
}

/** Sorts a tab's missions: ready to claim first, then closest to done, claimed last. */
export function sortViews(views: readonly MissionView[]): MissionView[] {
  const rank = (view: MissionView): number => (view.complete && !view.claimed ? 0 : view.claimed ? 2 : 1);
  return [...views].sort((a, b) => rank(a) - rank(b) || b.fraction - a.fraction || b.def.reward - a.def.reward);
}

export function openMissions(shell: HTMLElement, source: MissionsSource, hooks: { onClose?(): void; initialTab?: TabId } = {}): MissionsPanel {
  ensureStyle();
  const root = el('div', 'lp-ms');
  root.setAttribute('role', 'dialog'); root.setAttribute('aria-modal', 'true'); root.setAttribute('aria-labelledby', 'lp-ms-title');
  const card = el('div', 'lp-ms-card');
  card.setAttribute('tabindex', '-1');
  root.append(card);
  shell.append(root);

  let tab: TabId = hooks.initialTab ?? 'daily';
  let closed = false;
  const recent = new Map<string, { at: number; marks: number }>();
  const pending = new Set<string>();
  const messages = new Map<string, string>();
  let renderTimer: ReturnType<typeof setTimeout> | null = null;
  let tickTimer: ReturnType<typeof setInterval> | null = null;
  let timerLabel: HTMLElement | null = null;

  const close = (): void => {
    if (closed) return;
    closed = true;
    if (renderTimer) clearTimeout(renderTimer);
    if (tickTimer) clearInterval(tickTimer);
    off(); root.remove(); document.removeEventListener('keydown', onKey, true);
    hooks.onClose?.();
  };
  const onKey = (event: KeyboardEvent): void => { if (event.key === 'Escape') { event.stopPropagation(); close(); } };
  document.addEventListener('keydown', onKey, true);

  const button = (label: string, onClick: () => void, primary = false): HTMLButtonElement => {
    const b = el('button', primary ? 'go' : '', label);
    b.type = 'button'; b.addEventListener('click', onClick);
    return b;
  };

  const claim = async (view: MissionView): Promise<void> => {
    if (pending.has(view.key)) return;
    pending.add(view.key); messages.delete(view.key);
    render();
    const result = await source.claim(view.key);
    pending.delete(view.key);
    if (result.status === 'claimed') recent.set(view.key, { at: Date.now(), marks: result.marks });
    else if (result.status !== 'already') messages.set(view.key, result.message);
    if (!closed) render();
  };
  const claimAll = async (views: readonly MissionView[]): Promise<void> => {
    for (const view of views) { if (closed) return; await claim(view); }
  };

  const row = (view: MissionView): HTMLElement => {
    const ready = view.complete && !view.claimed;
    const just = recent.get(view.key);
    const item = el('li', `lp-ms-row${ready ? ' ready' : ''}${view.claimed ? ' done' : ''}${just && Date.now() - just.at < 1400 ? ' just' : ''}`);
    const info = el('div');
    info.append(el('p', 'lp-ms-title', view.def.title), el('p', 'lp-ms-text', view.def.text));
    const reward = el('div', 'lp-ms-reward', `+${fmt(view.def.reward)}`);
    reward.append(el('small', '', 'Marks'));
    const side = el('div', 'lp-ms-claim');
    side.append(reward);
    if (ready) side.append(button(pending.has(view.key) ? 'Claiming...' : 'Claim', () => { void claim(view); }, true));
    else if (view.claimed) side.append(el('span', 'lp-ms-state', 'Claimed'));
    item.append(info, side);
    const bar = el('div', 'lp-ms-bar');
    const track = el('div', 'lp-ms-track');
    track.setAttribute('role', 'progressbar');
    track.setAttribute('aria-label', view.def.title);
    track.setAttribute('aria-valuemin', '0'); track.setAttribute('aria-valuemax', '100');
    track.setAttribute('aria-valuenow', String(Math.round(view.fraction * 100)));
    const fill = el('span', 'lp-ms-fill');
    fill.style.width = `${Math.round(view.fraction * 100)}%`;
    track.append(fill);
    bar.append(track, el('span', 'lp-ms-num', view.claimed ? 'Done' : progressText(view)));
    item.append(bar);
    const message = messages.get(view.key);
    if (message) { const note = el('p', 'lp-ms-msg', message); note.setAttribute('role', 'status'); item.append(note); }
    if (just && Date.now() - just.at < 1400) item.append(el('span', 'lp-ms-fly', `+${fmt(just.marks)}`));
    return item;
  };

  const render = (): void => {
    if (closed) return;
    const all = source.views();
    const byTab = (id: TabId): MissionView[] => all.filter(view => view.kind === id);
    const waiting = all.filter(view => view.complete && !view.claimed);
    const waitingMarks = waiting.reduce((sum, view) => sum + view.def.reward, 0);
    card.replaceChildren();
    const head = el('div', 'lp-ms-head');
    const titleBox = el('div');
    const title = el('h3', '', 'Missions');
    title.id = 'lp-ms-title';
    titleBox.append(el('p', 'lp-ms-kicker', 'After hours'), title);
    const wait = el('p', 'lp-ms-wait');
    if (waiting.length) { wait.append(el('b', '', fmt(waitingMarks)), ` Marks waiting in ${waiting.length} mission${waiting.length === 1 ? '' : 's'}`); }
    else wait.textContent = 'Finish missions, then claim the Marks here.';
    head.append(titleBox, wait);
    card.append(head);

    const tabs = el('div', 'lp-ms-tabs');
    tabs.setAttribute('role', 'tablist');
    for (const entry of TABS) {
      const b = el('button', '', entry.label);
      b.type = 'button'; b.setAttribute('role', 'tab'); b.setAttribute('aria-selected', String(entry.id === tab));
      const count = byTab(entry.id).filter(view => view.complete && !view.claimed).length;
      if (count > 0) b.append(el('i', '', String(count)));
      b.addEventListener('click', () => { tab = entry.id; render(); });
      tabs.append(b);
    }
    card.append(tabs);

    const views = sortViews(byTab(tab));
    const sub = el('div', 'lp-ms-sub');
    timerLabel = el('span', '', '');
    const setTimerText = (): void => {
      if (!timerLabel) return;
      const left = source.resets();
      timerLabel.textContent = tab === 'daily' ? `New daily missions in ${formatLeft(left.dayMs)}`
        : tab === 'weekly' ? `New weekly challenges in ${formatLeft(left.weekMs)}`
        : `${views.filter(view => view.claimed).length} of ${views.length} claimed`;
    };
    setTimerText();
    sub.append(timerLabel);
    const ready = views.filter(view => view.complete && !view.claimed);
    if (ready.length >= 2) sub.append(button(`Claim all (${ready.length})`, () => { void claimAll(ready); }, true));
    card.append(sub);

    const list = el('ul', 'lp-ms-list');
    list.setAttribute('aria-label', `${tab} missions`);
    for (const view of views) list.append(row(view));
    if (!views.length) list.append(el('li', 'lp-ms-empty', 'Nothing here right now.'));
    card.append(list);
    const actions = el('div', 'lp-ms-actions');
    actions.append(button('Close', close));
    card.append(actions);

    if (tickTimer) clearInterval(tickTimer);
    tickTimer = setInterval(setTimerText, 15_000);
  };

  const schedule = (): void => {
    if (closed || renderTimer) return;
    renderTimer = setTimeout(() => { renderTimer = null; render(); }, 120);
  };
  const off = source.subscribe(schedule);
  render();
  card.focus();
  return { close, element: root };
}

/**
 * Toasts for missions that complete while the player is driving. Not interactive (never steals a click from the
 * drive controls). Returns a function that removes the toast layer and detaches from the source.
 */
export function mountMissionToasts(shell: HTMLElement, source: MissionsSource, options: { ms?: number; max?: number } = {}): () => void {
  ensureStyle();
  const layer = el('div', 'lp-mt');
  layer.setAttribute('aria-live', 'polite');
  shell.append(layer);
  const ms = options.ms ?? 5200, max = options.max ?? 3;
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const off = source.onComplete(view => {
    const item = el('div', 'lp-mt-item');
    const icon = el('span', 'lp-mt-icon', '✓');
    icon.setAttribute('aria-hidden', 'true');
    const text = el('div');
    text.append(el('p', 'lp-mt-kicker', `${view.kind === 'career' ? 'Mission' : view.kind === 'daily' ? 'Daily mission' : 'Weekly challenge'} complete`), el('p', 'lp-mt-title', view.def.title));
    item.append(icon, text, el('span', 'lp-mt-marks', `+${fmt(view.def.reward)}`));
    layer.append(item);
    while (layer.children.length > max) layer.children[0]!.remove();
    const hide = setTimeout(() => { item.className = 'lp-mt-item out'; const gone = setTimeout(() => { item.remove(); timers.delete(gone); }, 320); timers.add(gone); timers.delete(hide); }, ms);
    timers.add(hide);
  });
  return () => { off(); for (const timer of timers) clearTimeout(timer); timers.clear(); layer.remove(); };
}
