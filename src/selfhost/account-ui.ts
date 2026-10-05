/**
 * Account screens of the self-hosted build, all plain DOM (every string goes in through textContent):
 *   - first run: "Choose your driver name" (rules inline, errors inline), "I already have an account", "Play without one";
 *   - the one-time "Save your recovery code" card (copy button, an "I saved it" tick is required to go on);
 *   - the Account block of the driver profile: name, new recovery code, use another device, sign out (with a confirm);
 *   - the "Redeem a code" box.
 * Plain language throughout, no em dashes.
 */
import { button, ensureStyle, h, FEATURE_CSS } from '../ui/feature-css';
import { NAME_MAX, NAME_RULES, validateDriverName } from './account';
import type { SelfhostServices } from './boot';
import { SELFHOST_CSS } from './css';
import type { ActionResult } from './wallet-store';

export const RECOVERY_PENDING_KEY = 'lateral:account:recovery-pending:v1';

function store(): Storage | null { try { return typeof localStorage === 'undefined' ? null : localStorage; } catch { return null; } }
const recoveryPending = (): boolean => { try { return store()?.getItem(RECOVERY_PENDING_KEY) === '1'; } catch { return false; } };
const setRecoveryPending = (on: boolean): void => { try { if (on) store()?.setItem(RECOVERY_PENDING_KEY, '1'); else store()?.removeItem(RECOVERY_PENDING_KEY); } catch { /* Not remembered. */ } };

export function ensureSelfhostStyles(): void {
  ensureStyle('lf-feature-style', FEATURE_CSS);
  ensureStyle('sh-style', SELFHOST_CSS);
}

interface Card { readonly layer: HTMLElement; readonly card: HTMLElement; readonly body: HTMLElement; kicker(text: string): void; title(text: string): void; sub(text: string): void; close(): void }

/** A modal card on the feature layer plates. `dismissible` adds a close button, Escape and a click outside. */
function makeCard(shell: HTMLElement, label: string, dismissible: boolean, onClose: () => void, z?: number): Card {
  ensureSelfhostStyles();
  const layer = h('div', 'lf-layer sh-layer');
  layer.setAttribute('role', 'dialog'); layer.setAttribute('aria-modal', 'true'); layer.setAttribute('aria-label', label);
  if (z) layer.style.zIndex = String(z);
  const card = h('section', 'lf-card sh-card'); card.tabIndex = -1;
  const head = h('header', 'lf-head'); const text = h('div');
  const kicker = h('p', 'lf-kicker'), title = h('h3', 'lf-title'), sub = h('p', 'lf-sub');
  text.append(kicker, title, sub);
  head.append(text);
  const body = h('div', 'lf-body');
  card.append(head, body); layer.append(card);
  let closed = false;
  const close = (): void => {
    if (closed) return;
    closed = true;
    window.removeEventListener('keydown', onKey, true);
    layer.remove();
    onClose();
  };
  function onKey(event: KeyboardEvent): void {
    if (event.key === 'Escape' && dismissible) { event.preventDefault(); close(); }
  }
  if (dismissible) {
    head.append(button('lf-close', '×', close, 'Close'));
    layer.addEventListener('pointerdown', event => { if (event.target === layer) close(); });
    window.addEventListener('keydown', onKey, true);
  }
  shell.append(layer);
  return {
    layer, card, body, close,
    kicker: t => { kicker.textContent = t; }, title: t => { title.textContent = t; }, sub: t => { sub.textContent = t; },
  };
}

function field(labelText: string, input: HTMLInputElement, id: string): HTMLElement {
  const wrap = h('div', 'sh-field');
  const label = h('label', '', labelText); label.htmlFor = id; input.id = id;
  wrap.append(label, input);
  return wrap;
}
function textInput(className: string, placeholder = '', max = 40): HTMLInputElement {
  const input = h('input', `sh-input ${className}`.trim());
  input.type = 'text'; input.maxLength = max; input.placeholder = placeholder;
  input.autocomplete = 'off'; input.spellcheck = false;
  input.setAttribute('autocapitalize', 'none'); input.setAttribute('autocorrect', 'off'); input.setAttribute('data-lpignore', 'true');
  return input;
}
const primary = (text: string, onClick: () => void): HTMLButtonElement => button('lf-go', text, onClick);
const link = (text: string, onClick: () => void): HTMLButtonElement => button('sh-link', text, onClick);

/** Copies text to the clipboard. Resolves false when the browser says no (the player then copies by hand). */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) { await navigator.clipboard.writeText(text); return true; }
  } catch { /* fall back to a selection copy */ }
  try {
    const area = h('textarea'); area.value = text; area.setAttribute('readonly', ''); area.style.position = 'fixed'; area.style.opacity = '0';
    document.body.append(area); area.select();
    const ok = document.execCommand?.('copy') ?? false;
    area.remove();
    return ok;
  } catch { return false; }
}

/** Formats typed text as XXXX-XXXX-XXXX-XXXX (letters and digits only, upper case). */
export function formatRecoveryInput(raw: string): string {
  const clean = raw.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 16);
  return (clean.match(/.{1,4}/g) ?? []).join('-');
}

/** The one-time recovery code card. Going on needs the tick. Resolves when the player has saved it. */
export function openRecoveryCard(shell: HTMLElement, code: string, options: { regenerated?: boolean } = {}): Promise<void> {
  return new Promise(resolve => {
    const c = makeCard(shell, 'Save your recovery code', false, () => resolve());
    c.kicker(options.regenerated ? 'New recovery code' : 'One more step');
    c.title('Save your recovery code');
    c.sub('This is the only way back into your account.');
    const shown = h('p', 'sh-code', code); shown.setAttribute('aria-label', `Your recovery code is ${code.split('').join(' ')}`);
    const warn = h('p', 'sh-warn', options.regenerated
      ? 'Your old code no longer works. Write the new one down or keep it in a password manager. It is shown only once.'
      : 'If you play on another device, or clear this browser, this code is the only way back into your account. We cannot look it up or show it again. Write it down or keep it in a password manager.');
    const note = h('p', 'sh-ok'); note.setAttribute('role', 'status');
    const copy = button('', 'Copy code', () => { void copyText(code).then(ok => { note.textContent = ok ? 'Copied. Paste it somewhere safe.' : 'Could not copy. Select the code above and copy it by hand.'; }); });
    const tickLabel = h('label', 'sh-tick'); const tick = h('input'); tick.type = 'checkbox';
    tickLabel.append(tick, h('span', '', 'I saved it'));
    const go = primary('Continue', () => c.close()); go.disabled = true;
    tick.addEventListener('change', () => { go.disabled = !tick.checked; });
    const row = h('div', 'sh-actions'); row.append(copy, go);
    c.body.append(shown, warn, note, tickLabel, row);
    copy.focus();
  });
}

export interface FlowOptions {
  readonly shell: HTMLElement;
  readonly services: SelfhostServices;
  /** Which screen to start on. */
  readonly start: 'name' | 'recover' | 'code';
  /** A gift link is waiting: the name step says so. */
  readonly pendingGift?: boolean;
  /** First run: no close button, and "Play without an account" is offered. */
  readonly firstRun?: boolean;
  /** An account exists now (created or signed in). `created` tells which. */
  onSignedIn(info: { created: boolean }): void;
  /** The player chose to play without an account (first run only). */
  onGuest?(): void;
  /** The flow was dismissed without a result (not first run). */
  onCancel?(): void;
}

/** The account steps as one flow: name -> recovery code, or recover. Returns a function that closes it. */
export function runAccountFlow(options: FlowOptions): { close(): void } {
  const { shell, services } = options;
  const account = services.account;
  let current: Card | null = null;
  let finished = false;
  const dismiss = (): void => { if (!finished) { finished = true; options.onCancel?.(); } };
  const swap = (next: Card | null): void => { const old = current; current = next; old?.layer.remove(); };

  function showName(): void {
    const c = makeCard(shell, 'Choose your driver name', !options.firstRun, dismiss);
    swap(c);
    c.kicker(options.firstRun ? 'Welcome to the harbor' : 'Create an account');
    c.title('Choose your driver name');
    c.sub(options.pendingGift ? 'You have a gift from Louis waiting. Choose a driver name to open it.' : 'This is the name other drivers see in the lobby and on the leaderboards.');
    const form = h('form', 'sh-form'); form.noValidate = true;
    const input = textInput('', 'Driver name', NAME_MAX + 8);
    input.setAttribute('aria-describedby', 'sh-rules sh-name-err');
    const rules = h('p', 'sh-rules', `${NAME_RULES[0]!.toUpperCase()}${NAME_RULES.slice(1)}. Your name is permanent, so choose one you like.`); rules.id = 'sh-rules';
    const err = h('p', 'sh-err'); err.id = 'sh-name-err'; err.setAttribute('role', 'alert');
    const submit = primary('Create driver', () => { void go(); });
    submit.type = 'submit';
    form.append(field('Driver name', input, 'sh-name'), rules, err, submit);
    c.body.append(form);
    if (options.pendingGift) c.body.append(h('p', 'sh-gift', 'Your gift is kept safe while you choose. It opens as soon as your driver exists.'));
    const or = h('div', 'sh-or');
    or.append(link('I already have an account', () => showRecover()));
    if (options.firstRun && options.onGuest) {
      or.append(link('Play without an account', () => { finished = true; swap(null); options.onGuest!(); }));
      or.append(h('small', '', 'You can drive and earn Marks on this device. There is no online racing and the leaderboards are read only. You can make an account later from your profile.'));
    }
    c.body.append(or);
    const show = (text: string): void => { err.textContent = text; input.setAttribute('aria-invalid', text ? 'true' : 'false'); };
    input.addEventListener('input', () => { if (err.textContent) show(validateDriverName(input.value) ?? ''); });
    let busy = false;
    async function go(): Promise<void> {
      if (busy) return;
      const problem = validateDriverName(input.value);
      if (problem) { show(problem); input.focus(); return; }
      busy = true; submit.disabled = true; show('');
      const result = await account.create(input.value);
      busy = false; submit.disabled = false;
      if (!result.ok) { show(result.message); input.focus(); return; }
      setRecoveryPending(true);
      swap(null);
      await openRecoveryCard(shell, result.recoveryCode);
      setRecoveryPending(false);
      finished = true;
      options.onSignedIn({ created: true });
    }
    form.addEventListener('submit', event => { event.preventDefault(); void go(); });
    input.focus();
  }

  function showRecover(): void {
    const c = makeCard(shell, 'Use your account on this device', !options.firstRun, dismiss);
    swap(c);
    c.kicker('Use another device');
    c.title('Welcome back');
    c.sub('Enter the driver name and the recovery code you saved when you made your account.');
    const form = h('form', 'sh-form'); form.noValidate = true;
    const name = textInput('', 'Driver name', NAME_MAX + 8);
    const code = textInput('code', 'XXXX-XXXX-XXXX-XXXX', 19);
    code.addEventListener('input', () => { const formatted = formatRecoveryInput(code.value); if (formatted !== code.value) code.value = formatted; });
    const err = h('p', 'sh-err'); err.setAttribute('role', 'alert');
    const submit = primary('Sign in', () => { void go(); }); submit.type = 'submit';
    form.append(field('Driver name', name, 'sh-rname'), field('Recovery code', code, 'sh-rcode'), err, submit);
    c.body.append(form);
    const or = h('div', 'sh-or');
    or.append(link(options.firstRun ? 'Back' : 'Make a new account instead', () => showName()));
    c.body.append(or);
    let busy = false;
    async function go(): Promise<void> {
      if (busy) return;
      if (!name.value.trim() || formatRecoveryInput(code.value).length < 19) { err.textContent = 'Enter your driver name and all 16 characters of the recovery code.'; return; }
      busy = true; submit.disabled = true; err.textContent = '';
      const result = await account.recover(name.value, code.value);
      busy = false; submit.disabled = false;
      if (!result.ok) { err.textContent = result.message; return; }
      setRecoveryPending(false);
      swap(null); finished = true;
      options.onSignedIn({ created: false });
    }
    form.addEventListener('submit', event => { event.preventDefault(); void go(); });
    name.focus();
  }

  function showUnsaved(): void {
    const c = makeCard(shell, 'Recovery code not saved', false, () => {});
    swap(c);
    c.kicker('One more step');
    c.title('Save your recovery code');
    c.sub('Last time you did not confirm that you saved it.');
    const err = h('p', 'sh-err'); err.setAttribute('role', 'alert');
    const make = primary('Get a new recovery code', () => { void renew(); });
    c.body.append(h('p', 'sh-warn', 'We cannot show the first code again. Get a new one now, and keep it somewhere safe. It is the only way back into your account on another device.'), err, h('div', 'sh-actions'));
    c.body.lastElementChild!.append(make);
    let busy = false;
    async function renew(): Promise<void> {
      if (busy) return;
      busy = true; make.disabled = true;
      const result = await account.regenerate();
      busy = false; make.disabled = false;
      if (!result.ok) { err.textContent = result.message; return; }
      swap(null);
      await openRecoveryCard(shell, result.recoveryCode, { regenerated: true });
      setRecoveryPending(false);
      finished = true;
      options.onSignedIn({ created: false });
    }
  }

  if (options.start === 'code') showUnsaved(); else if (options.start === 'recover') showRecover(); else showName();
  return { close() { finished = true; swap(null); } };
}

/** First run: the choice screen when there is neither an account nor a guest choice, or the unsaved recovery code card. */
export function mountAccountGate(shell: HTMLElement, services: SelfhostServices, hooks: { pendingGift(): boolean; onReady(): void }): { dispose(): void } | null {
  const account = services.account;
  const unsaved = account.current() !== null && recoveryPending();
  if (!account.needsChoice() && !unsaved) return null;
  const flow = runAccountFlow({
    shell, services, start: unsaved ? 'code' : 'name', firstRun: true, pendingGift: hooks.pendingGift(),
    onSignedIn: () => { services.decide(); hooks.onReady(); },
    onGuest: () => { account.setGuest(true); services.decide(); hooks.onReady(); },
  });
  return { dispose: () => flow.close() };
}

/** A small yes/no confirmation. Resolves true on yes. */
export function confirmDialog(shell: HTMLElement, options: { title: string; text: string; yes: string; no?: string }): Promise<boolean> {
  return new Promise(resolve => {
    let answer = false;
    const c = makeCard(shell, options.title, true, () => resolve(answer), 90);
    c.kicker('Please confirm'); c.title(options.title);
    c.body.append(h('p', 'sh-warn', options.text));
    const row = h('div', 'sh-actions');
    const no = button('', options.no ?? 'Cancel', () => c.close());
    const yes = primary(options.yes, () => { answer = true; c.close(); });
    row.append(no, yes); c.body.append(row);
    no.focus();
  });
}

/** A short message card with one button. */
export function noticeDialog(shell: HTMLElement, options: { kicker?: string; title: string; text: string; ok?: string }): Promise<void> {
  return new Promise(resolve => {
    const c = makeCard(shell, options.title, true, () => resolve(), 90);
    c.kicker(options.kicker ?? 'Heads up'); c.title(options.title);
    c.body.append(h('p', 'sh-warn', options.text));
    const row = h('div', 'sh-actions'); const ok = primary(options.ok ?? 'OK', () => c.close());
    row.append(ok); c.body.append(row);
    ok.focus();
  });
}

export interface AccountBlockDeps {
  readonly shell: HTMLElement;
  readonly services: SelfhostServices;
  /** Page reload after the signed in account changed (sign in, sign out, first account). */
  reload(): void;
  /** Redeems a gift code through the gifts UI (plays the reveal). */
  redeem(code: string): Promise<ActionResult>;
}

/** The Account block of the driver profile page. Re-renders itself (call refresh() when the account changed). */
export function createAccountBlock(deps: AccountBlockDeps): { element: HTMLElement; refresh(): void } {
  ensureSelfhostStyles();
  const { shell, services } = deps;
  const account = services.account;
  const root = h('section', 'sh-account');
  const render = (): void => {
    root.replaceChildren();
    root.append(h('h4', '', 'Account'));
    const current = account.current();
    const box = h('div', 'sh-block');
    const row = h('div', 'sh-row');
    if (current) {
      box.append(h('p', 'sh-name', current.name), h('p', '', 'Your Marks, cosmetics and best times follow this account. To play on another device you need your recovery code.'));
      row.append(
        button('', 'New recovery code', () => { void renewCode(); }),
        button('', 'Use another device', () => { runAccountFlow({ shell, services, start: 'recover', onSignedIn: () => deps.reload() }); }),
        button('', 'Sign out', () => { void signOut(); }),
      );
      box.append(row);
      const redeem = h('div', 'sh-block');
      redeem.append(h('h4', '', 'Redeem a code'), h('p', '', 'Got a gift code from Louis? Enter it here. Each code works once per account.'));
      const form = h('form', 'sh-redeem'); form.noValidate = true;
      const input = textInput('code', 'LATERAL-XXXX-XXXX', 32);
      input.setAttribute('aria-label', 'Gift code');
      const submit = button('lf-go', 'Redeem', () => {}); submit.type = 'submit';
      form.append(input, submit);
      const msg = h('p', 'sh-err'); msg.setAttribute('role', 'status');
      form.addEventListener('submit', event => {
        event.preventDefault();
        const code = input.value.trim();
        if (!code) { msg.textContent = 'Enter your gift code.'; return; }
        submit.disabled = true; msg.textContent = '';
        void deps.redeem(code).then(result => {
          submit.disabled = false;
          if (result.ok) { input.value = ''; msg.className = 'sh-ok'; msg.textContent = 'Gift opened.'; } else { msg.className = 'sh-err'; msg.textContent = result.message; }
        });
      });
      redeem.append(form, msg);
      root.append(box, redeem);
    } else {
      box.append(h('p', 'sh-name', 'Playing without an account'),
        h('p', '', 'Your progress lives on this device only. With an account you can race online, post leaderboard times, receive gifts and keep your Marks if you switch devices. We will offer to bring your progress with you.'));
      row.append(
        button('lf-go', 'Create an account', () => { runAccountFlow({ shell, services, start: 'name', onSignedIn: () => deps.reload() }); }),
        button('', 'I already have an account', () => { runAccountFlow({ shell, services, start: 'recover', onSignedIn: () => deps.reload() }); }),
      );
      box.append(row);
      root.append(box);
    }
  };
  async function renewCode(): Promise<void> {
    const yes = await confirmDialog(shell, { title: 'Make a new recovery code?', text: 'Your current code stops working the moment you get a new one. Make sure you can write the new one down.', yes: 'Make a new code' });
    if (!yes) return;
    const result = await account.regenerate();
    if (!result.ok) { await noticeDialog(shell, { title: 'No new code', text: result.message }); return; }
    await openRecoveryCard(shell, result.recoveryCode, { regenerated: true });
  }
  async function signOut(): Promise<void> {
    const name = account.current()?.name ?? 'this account';
    const yes = await confirmDialog(shell, { title: `Sign out of ${name}?`, text: 'Your Marks and cosmetics stay safe on the server. To come back on this or any device you need your driver name and your recovery code.', yes: 'Sign out' });
    if (!yes) return;
    account.signOut();
    deps.reload();
  }
  render();
  return { element: root, refresh: render };
}
