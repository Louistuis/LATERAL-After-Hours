/**
 * Tip guide: the in-game walk through of buying Marks with websim credits. Self-contained (DOM + CSS), mounted inside
 * the game shell so it inherits the game's fonts and palette (.lp-shell variables).
 *
 * The game never takes payment itself. websim's comment box does, and Marks are credited only when websim's own record
 * of the tip is read back. So this panel has exactly one success state, and it is driven by `EarnFlow.confirmed`
 * (set by src/economy/tips.ts after the API returned a NEW tip). Until then it says "waiting", never "done".
 *
 * All text goes in through textContent: nothing from websim or the player is ever parsed as HTML.
 */
import type { EarnFlow, EarnSource } from '../economy/types';

export interface TipGuide { close(): void; readonly element: HTMLElement }

const STYLE_ID = 'lp-tipguide-style';
const CSS = `
.lp-tg{position:absolute;inset:0;z-index:60;display:grid;grid-template-rows:minmax(0,1fr);place-items:center;padding:max(16px,env(safe-area-inset-top)) max(16px,env(safe-area-inset-right)) max(16px,env(safe-area-inset-bottom)) max(16px,env(safe-area-inset-left));background:rgba(2,5,6,.78);pointer-events:auto;overflow:auto;-webkit-user-select:text;user-select:text}
.lp-tg-card{position:relative;width:min(520px,100%);max-height:100%;overflow:auto;padding:22px 22px 18px;background:rgba(6,13,15,.96);border:1px solid var(--lp-line-strong,rgba(130,205,196,.5));clip-path:polygon(0 0,calc(100% - 18px) 0,100% 18px,100% 100%,18px 100%,0 calc(100% - 18px));color:var(--lp-ink,#f4f7f1);font-family:var(--lp-font,system-ui,sans-serif)}
.lp-tg-kicker{margin:0;font-size:.72em;font-weight:600;letter-spacing:.24em;text-transform:uppercase;color:var(--lp-teal,#2fb8ad)}
.lp-tg-card h3{margin:.2em 0 .1em;font:700 clamp(30px,6vw,44px)/.95 var(--lp-stencil,var(--lp-display,system-ui));letter-spacing:.02em;text-transform:uppercase}
.lp-tg-gives{margin:0 0 12px;font-size:.95em;color:var(--lp-faint,#9fb2ad)}
.lp-tg-gives b{color:var(--lp-accent,#d8fa72);font-variant-numeric:tabular-nums}
.lp-tg-gives s{color:var(--lp-faint,#9fb2ad);text-decoration-color:var(--lp-hot,#ff8a1f);text-decoration-thickness:2px;font-variant-numeric:tabular-nums}
.lp-tg-sale{display:inline-block;margin:0 0 8px;padding:3px 10px;font:800 .78em var(--lp-font,system-ui);letter-spacing:.16em;text-transform:uppercase;color:#1a0d00;background:linear-gradient(90deg,var(--lp-hot,#ff8a1f),#ffc15a);box-shadow:0 0 18px rgba(255,138,31,.5)}
.lp-tg-card.sale{border-color:var(--lp-hot,#ff8a1f);box-shadow:0 0 0 1px rgba(255,138,31,.5),0 0 28px rgba(255,138,31,.3)}
.lp-tg-steps{margin:0 0 12px;padding:0;list-style:none;counter-reset:s;display:grid;gap:7px}
.lp-tg-steps li{counter-increment:s;display:grid;grid-template-columns:26px 1fr;gap:10px;align-items:start;font-size:.95em;line-height:1.35}
.lp-tg-steps li::before{content:counter(s);display:grid;place-items:center;width:24px;height:24px;font:700 14px/1 var(--lp-display,system-ui);color:var(--lp-on-accent,#0d1505);background:var(--lp-accent,#d8fa72);clip-path:polygon(50% 0,100% 50%,50% 100%,0 50%)}
.lp-tg-copy{display:grid;grid-template-columns:1fr auto;gap:8px;margin:0 0 12px}
.lp-tg-copy input{min-width:0;padding:.6em .8em;font:inherit;font-size:.9em;color:var(--lp-ink,#f4f7f1);background:rgba(255,255,255,.06);border:1px solid var(--lp-line,rgba(130,205,196,.3));border-radius:0}
.lp-tg-note{margin:0 0 10px;padding:.55em .8em;font-size:.88em;line-height:1.35;border-left:3px solid var(--lp-hot,#ff8a1f);background:rgba(255,138,31,.1)}
.lp-tg-note.err{border-left-color:#ff5a5a;background:rgba(255,90,90,.12)}
.lp-tg-wait{display:flex;align-items:center;gap:10px;margin:0 0 12px;font-size:.95em;letter-spacing:.04em}
.lp-tg-wait i{flex:none;width:14px;height:14px;border:2px solid var(--lp-line,rgba(130,205,196,.3));border-top-color:var(--lp-accent,#d8fa72);border-radius:50%;animation:lp-tg-spin 1s linear infinite}
@keyframes lp-tg-spin{to{transform:rotate(360deg)}}
.lp-tg-actions{display:flex;flex-wrap:wrap;gap:8px;justify-content:flex-end}
.lp-tg-burst{position:relative;display:grid;place-items:center;min-height:150px;margin:0 0 8px;text-align:center}
.lp-tg-burst::before,.lp-tg-burst::after{content:"";position:absolute;left:50%;top:50%;width:40px;height:40px;margin:-20px;border:2px solid var(--lp-accent,#d8fa72);border-radius:50%;opacity:0;animation:lp-tg-ring 1.4s ease-out forwards}
.lp-tg-burst::after{animation-delay:.25s}
@keyframes lp-tg-ring{0%{opacity:.9;transform:scale(.4)}100%{opacity:0;transform:scale(5.5)}}
.lp-tg-burst b{font:800 clamp(44px,12vw,72px)/1 var(--lp-display,system-ui);color:var(--lp-accent,#d8fa72);text-shadow:0 0 28px rgba(216,250,114,.55);animation:lp-tg-pop .7s cubic-bezier(.2,1.4,.4,1) both}
@keyframes lp-tg-pop{0%{opacity:0;transform:scale(.4)}100%{opacity:1;transform:none}}
.lp-tg-burst span{display:block;margin-top:.3em;font-size:.95em;letter-spacing:.14em;text-transform:uppercase;color:var(--lp-faint,#9fb2ad)}
@media (prefers-reduced-motion:reduce){.lp-tg-wait i,.lp-tg-burst::before,.lp-tg-burst::after,.lp-tg-burst b{animation:none}.lp-tg-burst b{opacity:1}}
`;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text = ''): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}
const fmt = (n: number): string => Math.round(n).toLocaleString('en-US');

/** Copies text. The clipboard API is often blocked inside the websim iframe, so it falls back to a selected input. */
export async function copyText(text: string, field?: HTMLInputElement | null): Promise<boolean> {
  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch { /* Fall through to the selection fallback. */ }
  try {
    const input = field ?? el('input');
    if (!field) { input.value = text; input.style.position = 'fixed'; input.style.opacity = '0'; document.body.append(input); }
    input.focus(); input.select(); input.setSelectionRange(0, text.length);
    const ok = typeof document.execCommand === 'function' && document.execCommand('copy');
    if (!field) input.remove();
    return Boolean(ok);
  } catch { return false; }
}

/**
 * Opens the guide for one tip pack and starts the flow. Call it from the click handler: the flow calls websim's
 * postComment before any await, which websim requires to happen during a user gesture.
 */
export function openTipGuide(shell: HTMLElement, source: EarnSource, offerId: string, hooks: { onClose?(): void } = {}): TipGuide | null {
  if (!source.startFlow || !source.flow) return null;
  if (!document.getElementById(STYLE_ID)) { const style = el('style'); style.id = STYLE_ID; style.textContent = CSS; document.head.append(style); }
  const root = el('div', 'lp-tg');
  root.setAttribute('role', 'dialog'); root.setAttribute('aria-modal', 'true'); root.setAttribute('aria-labelledby', 'lp-tg-title');
  const card = el('div', 'lp-tg-card');
  root.append(card);
  shell.append(root);
  let offRef: (() => void) | null = null;
  let closed = false, copied: 'idle' | 'ok' | 'manual' = 'idle', lastKey = '';
  const input = el('input');
  input.type = 'text'; input.readOnly = true; input.setAttribute('aria-label', 'Tip message');

  const close = (): void => {
    if (closed) return;
    closed = true; offRef?.(); root.remove(); document.removeEventListener('keydown', onKey, true);
    hooks.onClose?.();
  };
  const onKey = (event: KeyboardEvent): void => { if (event.key === 'Escape') { event.stopPropagation(); close(); } };
  document.addEventListener('keydown', onKey, true);

  const button = (label: string, onClick: () => void, primary = false): HTMLButtonElement => {
    const b = el('button', primary ? 'go' : '', label);
    b.type = 'button'; b.addEventListener('click', onClick);
    return b;
  };

  // The card is rebuilt on every visible change (polling): keep keyboard and gamepad focus on the same button.
  const render = (): void => {
    if (closed) return;
    const active = typeof document !== 'undefined' ? document.activeElement : null;
    const before = Array.from(card.querySelectorAll?.<HTMLElement>('button,input') ?? []);
    const index = before.indexOf(active as HTMLElement), label = index >= 0 ? before[index]!.textContent : null;
    const first = lastKey === '';
    build();
    if (closed || !card.querySelectorAll || (!first && (index < 0 || card.contains?.(document.activeElement)))) return;
    if (active === input && card.contains?.(input)) { input.focus?.({ preventScroll: true }); return; }
    const buttons = Array.from(card.querySelectorAll<HTMLButtonElement>('button'));
    (buttons.find(b => label !== null && b.textContent === label) ?? buttons[index] ?? buttons.find(b => b.classList?.contains('go')) ?? buttons[0])?.focus?.({ preventScroll: true });
  };
  const build = (): void => {
    const flow: EarnFlow | null = source.flow?.() ?? null;
    if (!flow) { close(); return; }
    // Re-render only when something visible changed, so a text selection in the copy field survives polling.
    const key = [flow.phase, flow.composer, flow.notice, flow.posted, flow.apiError, flow.confirmed?.marks, copied].join('|');
    if (key === lastKey) return;
    lastKey = key;
    card.replaceChildren();
    if (flow.phase === 'confirmed' && flow.confirmed) {
      const burst = el('div', 'lp-tg-burst');
      const inner = el('div');
      inner.append(el('b', '', `+${fmt(flow.confirmed.marks)}`), el('span', '', 'Marks added'));
      burst.append(inner);
      card.append(el('p', 'lp-tg-kicker', 'Tip confirmed'), burst);
      const thanks = el('p', 'lp-tg-gives', `websim recorded ${fmt(flow.confirmed.credits)} credits. Thank you for supporting the garage.`);
      thanks.setAttribute('role', 'status');
      const actions = el('div', 'lp-tg-actions');
      actions.append(button('Done', () => { source.cancelFlow?.(); close(); }, true));
      card.append(thanks, actions);
      return;
    }
    const title = el('h3', '', `Tip ${fmt(flow.credits)} credits`);
    title.id = 'lp-tg-title';
    const gives = el('p', 'lp-tg-gives');
    const offer = source.offers?.().find(entry => entry.id === flow.offerId);
    const onSale = offer?.sale === true && typeof offer.worth === 'number' && offer.worth < flow.marks;
    card.className = onSale ? 'lp-tg-card sale' : 'lp-tg-card';
    gives.append('That gives you ', el('b', '', `${fmt(flow.marks)} Marks`));
    if (onSale && offer?.worth) gives.append(' ', el('s', '', fmt(offer.worth)), ' once websim records it.');
    else gives.append(' once websim records it.');
    card.append(el('p', 'lp-tg-kicker', 'Get Marks'), title);
    if (onSale && offer) card.append(el('span', 'lp-tg-sale', offer.badge ?? 'Sale'));
    card.append(gives);
    if (flow.notice) { const note = el('p', 'lp-tg-note', flow.notice); note.setAttribute('role', 'status'); card.append(note); }
    if (flow.composer === 'opened') {
      const note = el('p', 'lp-tg-note', 'websim opened its comment box next to the game. If you can not see it, use the steps below.');
      note.style.borderLeftColor = 'var(--lp-teal,#2fb8ad)'; note.style.background = 'rgba(47,184,173,.1)';
      card.append(note);
    }
    const steps = el('ol', 'lp-tg-steps');
    for (const step of flow.steps) steps.append(el('li', '', step));
    card.append(steps);
    input.value = flow.copyText;
    const copy = el('div', 'lp-tg-copy');
    const copyButton = button(copied === 'ok' ? 'Copied' : copied === 'manual' ? 'Select and copy' : 'Copy message', () => {
      void copyText(flow.copyText, input).then(ok => { copied = ok ? 'ok' : 'manual'; if (!ok) { input.focus(); input.select(); } lastKey = ''; render(); });
    });
    copy.append(input, copyButton);
    card.append(copy);
    if (flow.apiError) {
      const err = el('p', 'lp-tg-note err', 'Can not reach websim to check your tip right now. If you already tipped, it is safe: your Marks arrive as soon as we can read it. We keep trying.');
      err.setAttribute('role', 'alert'); card.append(err);
    }
    const wait = el('p', 'lp-tg-wait');
    wait.setAttribute('role', 'status');
    if (flow.phase === 'timeout') wait.append(el('span', '', 'We have not seen your tip yet. If you posted it, give websim a moment and check again.'));
    else wait.append(el('i'), el('span', '', flow.posted ? 'Comment posted. Waiting for websim to record your tip...' : 'Waiting for your tip...'));
    card.append(wait);
    const actions = el('div', 'lp-tg-actions');
    actions.append(
      button('Check again', () => { void source.checkFlow?.(); }),
      button('Cancel', () => { source.cancelFlow?.(); close(); }),
      button('Hide', close),
    );
    card.append(actions);
  };

  // startFlow runs websim's postComment synchronously (inside the click gesture) and sets the flow to 'opening'.
  const started = source.startFlow(offerId);
  const off = source.subscribe(render);
  offRef = off;
  render();
  void started.then(flow => { if (!flow) close(); else render(); });
  return { close, element: root };
}
