/**
 * The starter gift reveal: a wrapped gift box the player taps or clicks to open, a burst, then the contents one by one
 * (the starter car, paint, wheels, horn and the Marks counting up), then "Open the shop" / "Let's drive".
 *
 * It is a required step: there is no Later button and Escape does not close it before the gift is open. Once the box is
 * open the reveal is skippable (tap anywhere, or Escape) so it never holds anyone for long. Reduced motion shows the
 * whole reveal at once. Fonts and palette come from the game shell (.lp-shell variables). All text goes in through
 * textContent: nothing is ever parsed as HTML.
 */
import { catalogEntry } from '../economy/catalog';
import type { GiftOpenResult } from '../economy/types';

export type GiftOutcome = 'drive' | 'shop' | 'closed';
export type GiftStage = 'box' | 'bursting' | 'revealing' | 'done';

export interface GiftRevealItem {
  readonly id: string;
  /** Small caption, e.g. "Starter car", "Paint". */
  readonly label: string;
  readonly name: string;
  readonly kind: 'car' | 'paint' | 'wheels' | 'horn' | 'other';
  readonly swatch: readonly string[];
}

export interface GiftRevealHooks {
  /** Opens the gift in the economy (pays the Marks). Called once, on the tap. */
  open(): Promise<GiftOpenResult>;
  /** Whose gift it is. Default "Louis". */
  from?: string;
  /** Replacement texts (a gift from Louis that is not the starter gift). Each one falls back to the starter gift text. */
  copy?: {
    kicker?: string; title?: string; sub?: string; boxLabel?: string; hint?: string;
    revealKicker?: string; revealTitle?: string; revealSub?: string;
  };
  /** A short personal message shown under the title (plain text). */
  message?: string;
  /** Open the box at once instead of waiting for the tap (the player already chose to open it). */
  autoOpen?: boolean;
  /** True for reduced motion: the reveal shows everything at once. Default: the media query. */
  reduced?(): boolean;
  /** Time between two revealed cards. Default 520 ms. */
  stepMs?: number;
  /** The Marks counter duration. Default 1500 ms. */
  tickMs?: number;
  readonly schedule?: (fn: () => void, ms: number) => unknown;
  readonly cancel?: (handle: unknown) => void;
  readonly raf?: (callback: () => void) => number;
  readonly cancelRaf?: (id: number) => void;
  readonly now?: () => number;
}

export interface GiftReveal {
  readonly element: HTMLElement;
  readonly stage: () => GiftStage;
  /** Fast-forwards the burst and the reveal to the end. Does nothing before the box is open. */
  skip(): void;
  /** Resolves when the reveal closes, with what the player chose. */
  readonly done: Promise<GiftOutcome>;
  close(outcome?: GiftOutcome): void;
}

const CAPTION: Readonly<Record<string, string>> = { car: 'Starter car', paint: 'Paint', wheelStyle: 'Wheels', horn: 'Horn', rim: 'Rims', underglow: 'Underglow', smoke: 'Smoke', plate: 'Plate' };

/** The catalog items of a gift as the reveal presents them (car first). Unknown ids are skipped. */
export function describeGiftItems(ids: readonly string[]): GiftRevealItem[] {
  const out: GiftRevealItem[] = [];
  for (const id of ids) {
    const entry = catalogEntry(id);
    if (!entry) continue;
    const isCar = entry.kind === 'car';
    const slot = isCar ? 'car' : entry.slot;
    out.push({
      id, name: entry.name, swatch: entry.swatch ?? [], label: CAPTION[slot] ?? 'Starter part',
      kind: isCar ? 'car' : slot === 'paint' ? 'paint' : slot === 'wheelStyle' ? 'wheels' : slot === 'horn' ? 'horn' : 'other',
    });
  }
  return out;
}

const STYLE_ID = 'lp-gift-style';
const CSS = `
.lp-gf{position:absolute;inset:0;z-index:74;display:grid;grid-template-rows:minmax(0,1fr);place-items:center;padding:max(14px,env(safe-area-inset-top)) max(14px,env(safe-area-inset-right)) max(14px,env(safe-area-inset-bottom)) max(14px,env(safe-area-inset-left));background:radial-gradient(ellipse at 50% 40%,rgba(216,250,114,.2),rgba(2,7,9,.9) 64%);backdrop-filter:blur(7px);-webkit-backdrop-filter:blur(7px);pointer-events:auto;font-family:var(--lp-font,system-ui);color:var(--lp-ink,#f4f7f1);animation:lp-gf-fade .4s ease-out both;-webkit-user-select:none;user-select:none}
.lp-gf [hidden]{display:none!important}
.lp-gf-card{position:relative;display:flex;flex-direction:column;align-items:center;width:min(500px,100%);max-height:100%;min-height:0;overflow:auto;padding:22px 20px 18px;text-align:center;background:rgba(6,13,15,.97);border:1px solid var(--lp-accent,#d8fa72);box-shadow:0 0 0 1px rgba(216,250,114,.25),0 0 50px rgba(216,250,114,.22);clip-path:polygon(0 0,calc(100% - 20px) 0,100% 20px,100% 100%,20px 100%,0 calc(100% - 20px));outline:none;animation:lp-gf-rise .5s cubic-bezier(.2,1.1,.4,1) both}
.lp-gf-kicker{margin:0;font-size:.72em;font-weight:600;letter-spacing:.26em;text-transform:uppercase;color:var(--lp-teal,#2fb8ad)}
.lp-gf-card h3{margin:.2em 0 0;font:700 clamp(30px,7.5vw,44px)/.95 var(--lp-stencil,var(--lp-display,system-ui));letter-spacing:.02em;text-transform:uppercase}
.lp-gf-sub{margin:.5em 0 0;font-size:.95em;line-height:1.35;color:var(--lp-dim,#b7c5bf)}
.lp-gf-message{margin:.7em 0 0;padding:.55em .9em;max-width:100%;font-size:.95em;line-height:1.4;font-style:italic;color:var(--lp-ink,#f4f7f1);border-left:3px solid var(--lp-accent,#d8fa72);background:rgba(216,250,114,.07);text-align:left;overflow-wrap:anywhere}
.lp-gf-stage{position:relative;display:grid;place-items:center;width:100%;min-height:200px;margin:8px 0 4px}
.lp-gf-box{position:relative;display:block;width:150px;height:150px;padding:0;margin:0;background:none;border:0;border-radius:0;clip-path:none;cursor:pointer;color:inherit;filter:drop-shadow(0 0 22px rgba(216,250,114,.45));animation:lp-gf-bob 2.2s ease-in-out infinite}
.lp-shell .lp-gf-box:hover:not(:disabled){transform:none;background:none;border:0;filter:drop-shadow(0 0 30px rgba(216,250,114,.8))}
.lp-shell .lp-gf-box:active:not(:disabled){transform:scale(.96);background:none}
.lp-gf-box:focus-visible{outline:3px solid var(--lp-accent,#d8fa72);outline-offset:8px}
.lp-gf-base{position:absolute;left:12px;right:12px;bottom:0;height:98px;background:linear-gradient(180deg,#26413f,#14272a);border:2px solid var(--lp-teal,#2fb8ad)}
.lp-gf-lid{position:absolute;left:4px;right:4px;top:26px;height:40px;background:linear-gradient(180deg,#34605c,#1d3a38);border:2px solid var(--lp-teal,#2fb8ad);transition:transform .6s cubic-bezier(.2,1.2,.3,1),opacity .6s;transform-origin:20% 100%}
.lp-gf-ribbon{position:absolute;left:50%;bottom:0;width:26px;height:140px;margin-left:-13px;background:linear-gradient(90deg,#b8d94d,var(--lp-accent,#d8fa72) 50%,#b8d94d)}
.lp-gf-lid::before{content:"";position:absolute;left:50%;top:-2px;width:26px;height:calc(100% + 4px);margin-left:-13px;background:linear-gradient(90deg,#b8d94d,var(--lp-accent,#d8fa72) 50%,#b8d94d)}
.lp-gf-bow{position:absolute;left:50%;top:-24px;width:46px;height:30px;margin-left:-23px}
.lp-gf-bow::before,.lp-gf-bow::after{content:"";position:absolute;top:0;width:24px;height:26px;border:5px solid var(--lp-accent,#d8fa72);border-radius:60% 60% 8% 60%}
.lp-gf-bow::before{left:-2px;transform:rotate(-14deg)}
.lp-gf-bow::after{right:-2px;transform:scaleX(-1) rotate(-14deg)}
.lp-gf-burst .lp-gf-box{animation:lp-gf-pop .7s ease-out both;pointer-events:none}
.lp-gf-burst .lp-gf-lid{transform:translate(34px,-120px) rotate(24deg);opacity:0}
.lp-gf-ring,.lp-gf-spark{position:absolute;left:50%;top:50%;pointer-events:none;opacity:0}
.lp-gf-ring{width:60px;height:60px;margin:-30px;border:3px solid var(--lp-accent,#d8fa72);border-radius:50%}
.lp-gf-burst .lp-gf-ring{animation:lp-gf-ring 1.2s ease-out forwards}
.lp-gf-burst .lp-gf-ring.two{animation-delay:.2s}
.lp-gf-spark{width:8px;height:8px;margin:-4px;background:var(--lp-accent,#d8fa72);clip-path:polygon(50% 0,100% 50%,50% 100%,0 50%)}
.lp-gf-spark:nth-of-type(3n){background:var(--lp-hot,#ff8a1f)}
.lp-gf-spark:nth-of-type(3n+1){background:var(--lp-teal,#2fb8ad)}
.lp-gf-burst .lp-gf-spark{animation:lp-gf-spark 1s cubic-bezier(.1,.8,.3,1) forwards}
.lp-gf-hint{margin:6px 0 0;font-size:.82em;font-weight:600;letter-spacing:.2em;text-transform:uppercase;color:var(--lp-accent,#d8fa72);animation:lp-gf-blink 1.6s ease-in-out infinite}
.lp-gf-list{display:grid;gap:8px;width:100%;margin:10px 0 0}
.lp-gf-tiles{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px}
.lp-gf-item{position:relative;display:grid;grid-template-columns:auto 1fr;gap:4px 12px;align-items:center;padding:10px 12px;text-align:left;background:rgba(255,255,255,.05);border:1px solid var(--lp-line,rgba(130,205,196,.3));border-left:4px solid var(--lp-accent,#d8fa72);animation:lp-gf-item .5s cubic-bezier(.2,1.2,.4,1) both}
.lp-gf-item small{grid-column:2;display:block;font-size:.66em;font-weight:600;letter-spacing:.2em;text-transform:uppercase;color:var(--lp-teal,#2fb8ad)}
.lp-gf-item b{grid-column:2;font:700 1.02em var(--lp-font,system-ui);letter-spacing:.02em}
.lp-gf-item .lp-gf-ic{grid-column:1;grid-row:1/span 2}
.lp-gf-item.car{padding:12px 14px;border-left-color:var(--lp-hot,#ff8a1f)}
.lp-gf-item.car b{font:700 1.5em/1 var(--lp-display,system-ui);letter-spacing:.04em;text-transform:uppercase}
.lp-gf-tiles .lp-gf-item{grid-template-columns:1fr;justify-items:start;padding:9px 10px}
.lp-gf-tiles .lp-gf-item small,.lp-gf-tiles .lp-gf-item b,.lp-gf-tiles .lp-gf-item .lp-gf-ic{grid-column:1;grid-row:auto}
.lp-gf-ic{display:block;width:34px;height:22px;background:linear-gradient(135deg,var(--a,#8fa19a),var(--b,var(--a,#8fa19a)));border:1px solid rgba(255,255,255,.3)}
.lp-gf-ic.car{width:54px;height:24px;background:var(--lp-hot,#ff8a1f);border:0;clip-path:polygon(0 80%,6% 50%,22% 36%,34% 8%,66% 8%,80% 38%,96% 50%,100% 80%,86% 80%,82% 94%,68% 94%,64% 80%,36% 80%,32% 94%,18% 94%,14% 80%)}
.lp-gf-ic.wheels{width:26px;height:26px;border-radius:50%;background:radial-gradient(circle,#10181a 28%,#cfd8d5 30% 44%,#10181a 46% 100%);border:2px solid #cfd8d5}
.lp-gf-ic.horn{width:30px;height:22px;background:var(--lp-teal,#2fb8ad);border:0;clip-path:polygon(0 36%,30% 36%,100% 0,100% 100%,30% 64%,0 64%)}
.lp-gf-marks{display:flex;align-items:baseline;justify-content:center;gap:.35em;padding:12px;border:1px solid var(--lp-accent,#d8fa72);background:rgba(216,250,114,.09);animation:lp-gf-item .5s cubic-bezier(.2,1.2,.4,1) both;box-shadow:0 0 22px rgba(216,250,114,.2)}
.lp-gf-num{font:800 clamp(40px,12vw,58px)/1 var(--lp-display,system-ui);color:var(--lp-accent,#d8fa72);font-variant-numeric:tabular-nums;text-shadow:0 0 26px rgba(216,250,114,.55)}
.lp-gf-unit{font:700 1.05em var(--lp-display,system-ui);letter-spacing:.14em;text-transform:uppercase}
.lp-gf-note{margin:8px 0 0;padding:.5em .8em;font-size:.84em;line-height:1.35;border-left:3px solid var(--lp-hot,#ff8a1f);background:rgba(255,138,31,.1);text-align:left}
.lp-gf-actions{display:flex;flex-wrap:wrap;gap:8px;justify-content:center;margin:14px 0 0;animation:lp-gf-item .5s ease-out both}
.lp-gf-actions .go{padding:.7em 1.5em}
.lp-gf-skip{margin:8px 0 0;font-size:.74em;letter-spacing:.16em;text-transform:uppercase;color:var(--lp-faint,#8fa19a)}
@keyframes lp-gf-fade{0%{opacity:0}100%{opacity:1}}
@keyframes lp-gf-rise{0%{opacity:0;transform:translateY(18px) scale(.95)}100%{opacity:1;transform:none}}
@keyframes lp-gf-bob{0%,100%{transform:translateY(0) rotate(-1.5deg)}50%{transform:translateY(-8px) rotate(1.5deg)}}
@keyframes lp-gf-pop{0%{transform:scale(1)}30%{transform:scale(1.18)}100%{transform:scale(.9);opacity:.0}}
@keyframes lp-gf-ring{0%{opacity:.95;transform:scale(.4)}100%{opacity:0;transform:scale(5)}}
@keyframes lp-gf-spark{0%{opacity:1;transform:translate(0,0) scale(1)}100%{opacity:0;transform:translate(var(--dx),var(--dy)) scale(.4)}}
@keyframes lp-gf-blink{0%,100%{opacity:.55}50%{opacity:1}}
@keyframes lp-gf-item{0%{opacity:0;transform:translateY(14px) scale(.94)}100%{opacity:1;transform:none}}
@media (max-height:640px){.lp-gf-stage{min-height:150px}.lp-gf-box{transform:scale(.8)}}
@media (prefers-reduced-motion:reduce){.lp-gf,.lp-gf-card,.lp-gf-box,.lp-gf-item,.lp-gf-marks,.lp-gf-actions,.lp-gf-hint,.lp-gf-ring,.lp-gf-spark{animation:none!important}.lp-gf-ring,.lp-gf-spark{display:none}}
`;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text = ''): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}
const fmt = (n: number): string => Math.round(n).toLocaleString('en-US');
const cssVar = (node: HTMLElement, name: string, value: string): void => { node.style.setProperty(name, value); };

function ensureStyle(): void {
  if (document.getElementById(STYLE_ID)) return;
  const style = el('style');
  style.id = STYLE_ID;
  style.textContent = CSS;
  document.head.append(style);
}

/** Shows the reveal inside `shell`. The Marks and items come from the caller (economy.view().gift). */
export function openGiftReveal(shell: HTMLElement, gift: { readonly marks: number; readonly items: readonly GiftRevealItem[] }, hooks: GiftRevealHooks): GiftReveal {
  ensureStyle();
  const schedule = hooks.schedule ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  const cancel = hooks.cancel ?? ((handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  const raf = hooks.raf ?? ((callback: () => void) => requestAnimationFrame(callback));
  const cancelRaf = hooks.cancelRaf ?? ((id: number) => cancelAnimationFrame(id));
  const now = hooks.now ?? (() => (typeof performance !== 'undefined' ? performance.now() : Date.now()));
  const reduced = (): boolean => (hooks.reduced ? hooks.reduced() : typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches);
  const stepMs = hooks.stepMs ?? 520, tickMs = hooks.tickMs ?? 1500;
  const from = hooks.from ?? 'Louis';

  let stage: GiftStage = 'box', closed = false, frame = 0, pending = false, extraNote = '';
  const timers = new Set<unknown>();
  const later = (fn: () => void, ms: number): void => {
    const handle = schedule(() => { timers.delete(handle); if (!closed) fn(); }, ms);
    timers.add(handle);
  };
  let finish!: (outcome: GiftOutcome) => void;
  const done = new Promise<GiftOutcome>(resolve => { finish = resolve; });

  const root = el('div', 'lp-gf');
  const card = el('div', 'lp-gf-card');
  card.setAttribute('role', 'dialog'); card.setAttribute('aria-modal', 'true'); card.setAttribute('aria-labelledby', 'lp-gf-title');
  card.tabIndex = -1;
  const copy = hooks.copy ?? {};
  const kicker = el('p', 'lp-gf-kicker', copy.kicker ?? 'Starter gift');
  const title = el('h3', '', copy.title ?? `A gift from ${from}`);
  title.id = 'lp-gf-title';
  const sub = el('p', 'lp-gf-sub', copy.sub ?? 'Everything you need to start driving.');
  const message = hooks.message ? el('p', 'lp-gf-message', hooks.message) : null;
  const stageEl = el('div', 'lp-gf-stage');
  const box = el('button', 'lp-gf-box');
  box.type = 'button';
  box.setAttribute('aria-label', copy.boxLabel ?? 'Open your starter gift');
  const base = el('span', 'lp-gf-base'), ribbon = el('span', 'lp-gf-ribbon'), lid = el('span', 'lp-gf-lid'), bow = el('i', 'lp-gf-bow');
  base.setAttribute('aria-hidden', 'true'); ribbon.setAttribute('aria-hidden', 'true'); lid.setAttribute('aria-hidden', 'true');
  lid.append(bow);
  box.append(base, ribbon, lid);
  stageEl.append(box, el('span', 'lp-gf-ring'), el('span', 'lp-gf-ring two'));
  for (let i = 0; i < 12; i++) {
    const spark = el('span', 'lp-gf-spark');
    const angle = (i / 12) * Math.PI * 2 + (i % 2 ? 0.2 : 0), radius = 90 + (i % 3) * 34;
    cssVar(spark, '--dx', `${Math.round(Math.cos(angle) * radius)}px`);
    cssVar(spark, '--dy', `${Math.round(Math.sin(angle) * radius)}px`);
    spark.setAttribute('aria-hidden', 'true');
    stageEl.append(spark);
  }
  const hint = el('p', 'lp-gf-hint', copy.hint ?? 'Tap the box to open it');
  const live = el('p', 'lp-gf-sub');
  live.setAttribute('role', 'status');
  live.hidden = true;
  const list = el('div', 'lp-gf-list');
  const note = el('p', 'lp-gf-note');
  note.hidden = true;
  note.setAttribute('role', 'status');
  const actions = el('div', 'lp-gf-actions');
  const skipHint = el('p', 'lp-gf-skip', 'Tap to skip');
  skipHint.hidden = true;
  card.append(...(message ? [kicker, title, sub, message] : [kicker, title, sub]), stageEl, hint, note, live, list, skipHint, actions);
  root.append(card);
  shell.append(root);
  box.focus();

  const close = (outcome: GiftOutcome = 'closed'): void => {
    if (closed) return;
    closed = true;
    for (const handle of timers) cancel(handle);
    timers.clear();
    if (frame) cancelRaf(frame);
    document.removeEventListener('keydown', onKey, true);
    root.remove();
    finish(outcome);
  };

  /* ------------------------------------------------------------------ the contents */
  const cards: { build(): HTMLElement }[] = [];
  const items = gift.items;
  const car = items.find(item => item.kind === 'car');
  const others = items.filter(item => item !== car);
  const itemCard = (item: GiftRevealItem, className = 'lp-gf-item'): HTMLElement => {
    const node = el('div', className + (item.kind === 'car' ? ' car' : ''));
    const icon = el('i', `lp-gf-ic ${item.kind}`);
    const [a = '#8fa19a', b = a] = item.swatch;
    cssVar(icon, '--a', a); cssVar(icon, '--b', b);
    icon.setAttribute('aria-hidden', 'true');
    node.append(icon, el('small', '', item.label), el('b', '', item.name));
    return node;
  };
  let tiles: HTMLElement | null = null;
  if (car) cards.push({ build: () => itemCard(car) });
  others.forEach(item => cards.push({
    build: () => {
      if (!tiles) { tiles = el('div', 'lp-gf-tiles'); }
      const node = itemCard(item);
      tiles.append(node);
      return tiles;
    },
  }));
  const number = el('b', 'lp-gf-num', '0');
  const marksCard = (): HTMLElement => {
    const node = el('div', 'lp-gf-marks');
    const unit = el('span', 'lp-gf-unit', 'Marks');
    number.setAttribute('aria-hidden', 'true');
    node.append(number, unit);
    return node;
  };
  if (gift.marks > 0) cards.push({ build: marksCard });

  let shownCards = 0;
  const mounted = new Set<HTMLElement>();
  const showNext = (): void => {
    const next = cards[shownCards++];
    if (!next) return;
    const node = next.build();
    if (!mounted.has(node)) { mounted.add(node); list.append(node); }
  };
  const tickTo = (target: number, ms: number): void => {
    const start = now();
    const step = (): void => {
      if (closed) return;
      const t = ms <= 0 ? 1 : Math.min(1, (now() - start) / ms);
      number.textContent = fmt(target * (1 - Math.pow(1 - t, 3)));
      frame = t < 1 ? raf(step) : 0;
    };
    if (frame) cancelRaf(frame);
    frame = raf(step);
  };

  const showActions = (): void => {
    stage = 'done';
    skipHint.hidden = true;
    const names = items.map(item => item.name).join(', ');
    live.textContent = gift.marks > 0 ? `Your gift: ${names}${names ? ' and ' : ''}${fmt(gift.marks)} Marks.` : `Your gift: ${names}.`;
    live.hidden = false;
    if (pending) { note.textContent = 'Saving your Marks. If the connection is slow we keep trying in the background, and you can carry on.'; note.hidden = false; }
    else if (extraNote) { note.textContent = extraNote; note.hidden = false; }
    const shop = el('button', '', 'Open the shop');
    shop.type = 'button';
    shop.addEventListener('click', () => close('shop'));
    const drive = el('button', 'go', "Let's drive");
    drive.type = 'button';
    drive.addEventListener('click', () => close('drive'));
    actions.replaceChildren(shop, drive);
    drive.focus();
  };

  const skip = (): void => {
    if (closed || stage === 'box' || stage === 'done') return;
    for (const handle of timers) cancel(handle);
    timers.clear();
    if (stage === 'bursting') root.classList.add('lp-gf-burst');
    stageEl.hidden = true; hint.hidden = true;
    while (shownCards < cards.length) showNext();
    if (frame) cancelRaf(frame);
    frame = 0;
    number.textContent = fmt(gift.marks);
    showActions();
  };

  const startReveal = (): void => {
    stage = 'revealing';
    stageEl.hidden = true;
    kicker.textContent = copy.revealKicker ?? `From ${from}`;
    title.textContent = copy.revealTitle ?? 'Your starter gift';
    sub.textContent = copy.revealSub ?? 'Yours to keep.';
    skipHint.hidden = false;
    if (reduced()) { skip(); return; }
    const reveal = (): void => {
      if (shownCards >= cards.length) return;
      showNext();
      if (shownCards >= cards.length) {
        if (gift.marks > 0) tickTo(gift.marks, tickMs);
        later(showActions, (gift.marks > 0 ? tickMs : 0) + 250);
      } else later(reveal, stepMs);
    };
    reveal();
  };

  const open = (): void => {
    if (stage !== 'box' || closed) return;
    stage = 'bursting';
    hint.hidden = true;
    note.hidden = true;
    root.classList.add('lp-gf-burst');
    box.disabled = true;
    // The Marks are paid by this call. It never blocks the reveal: if the wallet is slow it reports `pending` and keeps trying.
    void hooks.open().then(result => {
      if (closed) return;
      if (!result.ok) {
        // Could not open at all: back to the box so the player can tap again (never stuck).
        for (const handle of timers) cancel(handle);
        timers.clear();
        stage = 'box'; box.disabled = false; root.classList.remove('lp-gf-burst'); hint.hidden = false;
        note.textContent = result.message || 'The gift did not open. Tap it to try again.'; note.hidden = false;
        box.focus();
        return;
      }
      pending = result.pending;
      extraNote = result.note ?? '';
      if (stage === 'done') showActions();
    }, () => { pending = true; });
    if (reduced()) { startReveal(); return; }
    later(startReveal, 800);
  };
  box.addEventListener('click', open);
  if (hooks.autoOpen) later(open, 0);
  root.addEventListener('click', event => {
    const target = event.target as HTMLElement | null;
    if (target && target.closest('button')) return;
    skip();
  });

  /* ------------------------------------------------------------------ keyboard: a required step, no way around it */
  function onKey(event: KeyboardEvent): void {
    if (closed) return;
    if (event.key === 'Escape') {
      event.stopPropagation(); event.preventDefault();
      if (stage === 'done') close('closed'); else skip();
      return;
    }
    if (event.key === 'Tab') {
      const focusable = Array.from(card.querySelectorAll?.<HTMLButtonElement>('button:not(:disabled)') ?? []);
      event.stopPropagation();
      if (!focusable.length) { event.preventDefault(); return; }
      const index = focusable.indexOf(document.activeElement as HTMLButtonElement);
      const next = event.shiftKey ? (index <= 0 ? focusable.length - 1 : index - 1) : (index === focusable.length - 1 ? 0 : index + 1);
      event.preventDefault();
      focusable[next]!.focus();
      return;
    }
    // Nothing else reaches the menu behind the gift (Enter and Space still press the focused button).
    event.stopPropagation();
    const target = event.target as Node | null;
    if (!target || !card.contains?.(target)) {
      if (event.key === 'Enter' || event.key === ' ') event.preventDefault();
      (stage === 'done' ? (actions.querySelector?.('button.go') as HTMLElement | null) : box)?.focus();
    }
  }
  document.addEventListener('keydown', onKey, true);

  return { element: root, stage: () => stage, skip, done, close };
}
