/**
 * Custom plate text field for the showroom (Plates tab, Shop and Garage modes). Self-contained DOM + CSS; the showroom
 * only mounts it, shows it while the Custom Plate is selected, and feeds its draft text to the preview car.
 *
 *   locked  : the player does not own `plate-custom`. Shows the price and what it does. No text can be entered.
 *   open    : a text field with a counter, the validation message for rejected text, a flat preview of the plate
 *             and a Save button. Every keystroke is validated with the same code that guards the wallet and the wire
 *             (src/economy/plate.ts); the economy validates again on save.
 *
 * All text goes in through textContent / value and the preview is drawn on a canvas: nothing is ever parsed as HTML.
 */
import { drawPlateFace } from '../economy/car-cosmetics';
import { catalogItem } from '../economy/catalog';
import { CUSTOM_PLATE_ID, DEFAULT_PLATE_TEXT, PLATE_MAX, validatePlateText } from '../economy/plate';
import type { Economy } from '../economy/types';

export interface PlateFieldHooks {
  /** Live preview: the valid draft text, or null while the field is empty or invalid (the car then shows what is fitted). */
  onDraft(text: string | null): void;
  onSaved?(text: string): void;
}
export interface PlateField {
  readonly element: HTMLElement;
  /** Show it (the Custom Plate is the selected entry) or hide it; hiding clears the draft preview. */
  show(visible: boolean): void;
  /** The valid draft text, or null. */
  draft(): string | null;
  /** Puts the field into `parent` (again), keeping focus and the caret if the player is typing. */
  attachTo(parent: HTMLElement): void;
  dispose(): void;
}

const STYLE_ID = 'lp-platefield-style';
const CSS = `
.lp-pf{--cut:14px;position:relative;margin-top:10px;padding:14px 16px 14px;background:linear-gradient(160deg,rgba(9,19,21,.92),rgba(4,9,10,.86));border:1px solid var(--lp-line,rgba(130,205,196,.26));border-top:3px solid #ff8a1f;color:var(--lp-ink,#f4f7f1);font-family:var(--lp-font,system-ui);clip-path:polygon(0 0,calc(100% - var(--cut)) 0,100% var(--cut),100% 100%,var(--cut) 100%,0 calc(100% - var(--cut)));pointer-events:auto}
.lp-pf[hidden]{display:none}
.lp-pf-kicker{margin:0 0 6px;font-size:.7em;font-weight:600;letter-spacing:.22em;text-transform:uppercase;color:var(--lp-teal,#2fb8ad)}
.lp-pf label{display:block;margin:0 0 4px;font-size:.85em;color:var(--lp-dim,#b7c5bf)}
.lp-pf-row{display:grid;grid-template-columns:1fr auto;gap:8px;align-items:center}
.lp-pf input{min-width:0;padding:.55em .7em;font:700 1.15em/1 var(--lp-display,system-ui);letter-spacing:.14em;text-transform:uppercase;color:var(--lp-ink,#f4f7f1);background:rgba(255,255,255,.06);border:1px solid var(--lp-line-strong,rgba(130,205,196,.5));border-radius:0}
.lp-pf input[aria-invalid=true]{border-color:#ff5a5a}
.lp-pf input:disabled{opacity:.5}
.lp-pf-count{font-size:.8em;color:var(--lp-faint,#8fa19a);font-variant-numeric:tabular-nums}
.lp-pf canvas{display:block;width:100%;height:auto;aspect-ratio:512/112;margin:10px 0 6px;background:#07090a}
.lp-pf-msg{min-height:1.3em;margin:0 0 8px;font-size:.84em;line-height:1.3;color:var(--lp-faint,#8fa19a)}
.lp-pf-msg.err{color:#ff7a7a}
.lp-pf-msg.ok{color:var(--lp-accent,#d8fa72)}
.lp-pf-actions{display:flex;justify-content:flex-end;gap:8px}
.lp-pf-lock{display:flex;align-items:baseline;justify-content:space-between;gap:12px;margin:0 0 6px;font:700 1.05em var(--lp-font,system-ui);letter-spacing:.06em;text-transform:uppercase}
.lp-pf-lock b{font:800 1.5em/1 var(--lp-display,system-ui);color:var(--lp-hot,#ff8a1f);font-variant-numeric:tabular-nums}
.lp-pf-hint{margin:0;font-size:.84em;line-height:1.35;color:var(--lp-dim,#b7c5bf)}
`;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text = ''): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}
const fmt = (n: number): string => Math.max(0, Math.round(n)).toLocaleString('en-US');

export function createPlateField(economy: Economy, hooks: PlateFieldHooks): PlateField {
  if (!document.getElementById(STYLE_ID)) { const style = el('style'); style.id = STYLE_ID; style.textContent = CSS; document.head.append(style); }
  const root = el('div', 'lp-pf');
  root.hidden = true;
  root.setAttribute('role', 'group'); root.setAttribute('aria-label', 'Custom plate');
  const body = el('div');
  root.append(body);

  const input = el('input');
  input.type = 'text'; input.id = 'lp-pf-input'; input.maxLength = 16;
  input.setAttribute('autocomplete', 'off'); input.setAttribute('autocapitalize', 'characters'); input.setAttribute('spellcheck', 'false');
  input.setAttribute('aria-describedby', 'lp-pf-msg'); input.setAttribute('placeholder', DEFAULT_PLATE_TEXT);
  const count = el('span', 'lp-pf-count', `0/${PLATE_MAX}`);
  const canvas = el('canvas');
  canvas.width = 512; canvas.height = 112;
  canvas.setAttribute('aria-hidden', 'true');
  const message = el('p', 'lp-pf-msg');
  message.id = 'lp-pf-msg'; message.setAttribute('role', 'status');
  const save = el('button', 'go', 'Save plate');
  save.type = 'button';

  let visible = false, saved = '', busy = false, draft: string | null = null, lastKey = '', disposed = false;
  let note: { text: string; kind: 'err' | 'ok' | '' } = { text: '', kind: '' };
  const itemState = (): ReturnType<NonNullable<Economy['itemState']>> => economy.itemState?.(CUSTOM_PLATE_ID) ?? null;
  const usable = (): boolean => itemState()?.usable === true;

  const drawPreview = (text: string): void => {
    try {
      const context = typeof canvas.getContext === 'function' ? canvas.getContext('2d') : null;
      if (context) drawPlateFace(context, text, catalogItem(CUSTOM_PLATE_ID)?.swatch[1] ?? '#bff0ff');
    } catch { /* The preview is a nicety; the car preview still works. */ }
  };

  const setDraft = (next: string | null): void => {
    if (next === draft) return;
    draft = next;
    hooks.onDraft(next);
  };

  /** Validates what is typed: updates the counter, message, preview and the car preview. */
  const check = (): void => {
    const raw = input.value;
    count.textContent = `${Math.min(raw.trim().length, 99)}/${PLATE_MAX}`;
    const result = validatePlateText(raw);
    const empty = !raw.trim();
    input.setAttribute('aria-invalid', String(!result.ok && !empty));
    if (!busy) note = result.ok || empty ? { text: empty ? 'Leave it empty to use the LATERAL plate.' : '', kind: '' } : { text: result.message, kind: 'err' };
    setDraft(result.ok ? result.text : null);
    drawPreview(result.ok ? result.text : empty ? (saved || DEFAULT_PLATE_TEXT) : DEFAULT_PLATE_TEXT);
    save.disabled = busy || !(result.ok ? result.text !== saved : empty && saved !== '');
    message.textContent = note.text;
    message.className = `lp-pf-msg${note.kind ? ` ${note.kind}` : ''}`;
  };

  const render = (): void => {
    if (!visible || disposed) return;
    const state = itemState();
    const open = usable();
    const key = `${open}|${state?.status}|${state?.price}|${state?.reason}`;
    if (key !== lastKey) {
      lastKey = key;
      body.replaceChildren();
      body.append(el('p', 'lp-pf-kicker', 'Custom plate'));
      if (!open) {
        const price = state?.price ?? catalogItem(CUSTOM_PLATE_ID)?.price ?? 0;
        const lock = el('p', 'lp-pf-lock', 'Locked');
        lock.append(el('b', '', `${fmt(price)} M`));
        body.append(lock, el('p', 'lp-pf-hint', state?.status === 'locked' && state.reason ? state.reason : 'Unlock the Custom Plate to type your own text, 2 to 8 characters. Everyone online sees it.'));
        setDraft(null);
        return;
      }
      const label = el('label', '', 'Your plate text');
      label.setAttribute('for', 'lp-pf-input');
      const row = el('div', 'lp-pf-row');
      row.append(input, count);
      const actions = el('div', 'lp-pf-actions');
      actions.append(save);
      body.append(label, row, canvas, message, actions);
      input.disabled = false;
      if (!input.value && saved) input.value = saved;
      check();
    }
  };

  const onInput = (): void => { if (!busy) check(); };
  const doSave = async (): Promise<void> => {
    if (busy || !economy.setPlateText) return;
    const raw = input.value;
    const result = validatePlateText(raw);
    if (!result.ok && raw.trim()) { check(); return; }
    busy = true; save.disabled = true; note = { text: 'Saving...', kind: '' }; message.textContent = note.text;
    const outcome = await economy.setPlateText(raw).catch(() => ({ ok: false as const, reason: 'not-ready' as const, message: 'That did not save. Try again.' }));
    busy = false;
    if (outcome.ok) saved = outcome.text;
    check();
    // check() resets the message from what is typed; the save result wins until the next keystroke.
    if (outcome.ok) {
      note = { text: outcome.text ? 'Plate saved. It is on your car now.' : 'Back to the LATERAL plate.', kind: 'ok' };
      hooks.onSaved?.(outcome.text);
    } else note = { text: outcome.message, kind: 'err' };
    message.textContent = note.text; message.className = `lp-pf-msg${note.kind ? ` ${note.kind}` : ''}`;
  };
  input.addEventListener('input', onInput);
  input.addEventListener('keydown', (event: KeyboardEvent) => {
    // Typing must never reach the showroom shortcuts or the game's driving keys.
    event.stopPropagation();
    if (event.key === 'Enter') { event.preventDefault(); void doSave(); }
    else if (event.key === 'Escape') input.blur?.();
  });
  input.addEventListener('keyup', (event: KeyboardEvent) => event.stopPropagation());
  save.addEventListener('click', () => { void doSave(); });

  const readSaved = (): void => { saved = economy.view().equipped.plateText ?? saved; };
  const off = economy.subscribe(() => { readSaved(); render(); if (visible && usable()) check(); });
  readSaved();

  return {
    element: root,
    show(next) {
      if (next === visible) return;
      visible = next;
      root.hidden = !next;
      lastKey = '';
      if (next) { readSaved(); render(); } else { setDraft(null); }
    },
    draft: () => draft,
    attachTo(parent) {
      if (root.parentElement === parent && parent.lastElementChild === root) return;
      const active = typeof document !== 'undefined' && document.activeElement === input;
      const start = active ? input.selectionStart : null, end = active ? input.selectionEnd : null;
      parent.append(root);
      if (active) { input.focus({ preventScroll: true }); try { input.setSelectionRange(start ?? input.value.length, end ?? input.value.length); } catch { /* Not all input types support it. */ } }
    },
    dispose() { disposed = true; off(); root.remove(); },
  };
}
