/**
 * Controls page: keyboard, gamepad and touch diagrams with every action labelled, remapping with
 * conflict handling (rules in src/input/bindings.ts) and a short animated "how to drift".
 * Pure markup; player-ui.ts routes the clicks (data-remap, data-gamepad-remap, data-ctab, reset-bindings).
 */
import type { GamepadBindings, KeyboardAction, KeyboardBindings } from '../input/player-input';
import { ACTION_LABELS, ACTION_TAGS, GAMEPAD_ACTION_KEY, GAMEPAD_ACTION_ORDER, KEYBOARD_ACTION_ORDER, RESERVED_KEYS, keyLabel, keyboardConflicts } from '../input/bindings';
import { MENU_ICONS } from './main-menu';

export type ControlsTab = 'keyboard' | 'gamepad' | 'touch' | 'drift';
export interface ControlsContext {
  readonly tab: ControlsTab;
  readonly keyboard: KeyboardBindings | null;
  readonly gamepad: GamepadBindings | null;
  readonly mapping: string | null;
  /** Action waiting for a key or button. */
  readonly pending: string | null;
  /** Result of the last capture ("Space moved from Handbrake"). */
  readonly message: string;
  readonly touchSteer: 'buttons' | 'drag' | null;
}

const esc = (text: unknown) => String(text ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);
type Group = 'drive' | 'hb' | 'util' | 'sys' | 'horn';
const GROUP: Readonly<Record<KeyboardAction | 'steer' | 'horn', Group>> = {
  throttle: 'drive', brake: 'drive', steerLeft: 'drive', steerRight: 'drive', steer: 'drive', handbrake: 'hb',
  reset: 'util', camera: 'util', shiftUp: 'util', shiftDown: 'util', pause: 'sys', horn: 'horn',
};

/* ------------------------------------------------------------------ keyboard diagram */
const U = 44, GAP = 4;
const ROWS: readonly { readonly x: number; readonly keys: readonly string[] }[] = [
  { x: 0, keys: ['Escape', 'Digit1', 'Digit2', 'Digit3', 'Digit4', 'Digit5', 'Digit6', 'Digit7', 'Digit8', 'Digit9', 'Digit0'] },
  { x: .5, keys: ['KeyQ', 'KeyW', 'KeyE', 'KeyR', 'KeyT', 'KeyY', 'KeyU', 'KeyI', 'KeyO', 'KeyP'] },
  { x: .75, keys: ['KeyA', 'KeyS', 'KeyD', 'KeyF', 'KeyG', 'KeyH', 'KeyJ', 'KeyK', 'KeyL'] },
  { x: 1.25, keys: ['KeyZ', 'KeyX', 'KeyC', 'KeyV', 'KeyB', 'KeyN', 'KeyM'] },
];
function keyCap(code: string, x: number, y: number, w: number, owner: KeyboardAction | 'horn' | null, pending: boolean): string {
  const group = owner ? GROUP[owner] : '';
  const tag = owner === 'horn' ? 'HORN' : owner ? ACTION_TAGS[owner] : '';
  const cls = `kc${group ? ` g-${group}` : ''}${pending ? ' wait' : ''}`;
  return `<g class="${cls}" transform="translate(${x} ${y})"><rect width="${w}" height="${U}" rx="5"/><text class="kl" x="7" y="16">${esc(keyLabel(code))}</text>${tag ? `<text class="kt" x="${w / 2}" y="${U - 8}" text-anchor="middle">${tag}</text>` : ''}</g>`;
}
export function keyboardDiagram(bindings: KeyboardBindings, pendingAction: string | null): string {
  const owner = (code: string): KeyboardAction | 'horn' | null => RESERVED_KEYS[code] ? 'horn' : KEYBOARD_ACTION_ORDER.find(action => bindings[action].includes(code)) ?? null;
  const pendingCodes = new Set(pendingAction && pendingAction in bindings ? bindings[pendingAction as KeyboardAction] : []);
  let out = '';
  ROWS.forEach((row, r) => row.keys.forEach((code, i) => { out += keyCap(code, (row.x + i) * (U + GAP), r * (U + GAP), U, owner(code), pendingCodes.has(code)); }));
  out += keyCap('Space', 3 * (U + GAP), 4 * (U + GAP), 6 * U + 5 * GAP, owner('Space'), pendingCodes.has('Space'));
  const ax = 11.6 * (U + GAP);
  out += keyCap('ArrowUp', ax + (U + GAP), 3 * (U + GAP), U, owner('ArrowUp'), pendingCodes.has('ArrowUp'));
  ['ArrowLeft', 'ArrowDown', 'ArrowRight'].forEach((code, i) => { out += keyCap(code, ax + i * (U + GAP), 4 * (U + GAP), U, owner(code), pendingCodes.has(code)); });
  const width = ax + 3 * (U + GAP), height = 5 * (U + GAP);
  return `<svg class="cp-kb" viewBox="-2 -2 ${width + 2} ${height + 2}" role="img" aria-label="Keyboard layout with the current bindings">${out}</svg>`;
}

/* ------------------------------------------------------------------ gamepad diagram */
const PAD_SHORT: Readonly<Record<number, string>> = { 0: 'A', 1: 'B', 2: 'X', 3: 'Y', 4: 'LB', 5: 'RB', 6: 'LT', 7: 'RT', 8: 'View', 9: 'Menu', 10: 'L3', 11: 'R3', 12: 'D-pad up', 13: 'D-pad down', 14: 'D-pad left', 15: 'D-pad right' };
export function padButtonName(button: number, mapping: string | null): string { return mapping === 'standard' ? PAD_SHORT[button] ?? `Button ${button}` : `Button ${button}`; }
export function padAxisName(axis: number, mapping: string | null): string { return mapping === 'standard' && axis <= 1 ? 'Left stick' : mapping === 'standard' ? 'Right stick' : `Axis ${axis}`; }
// Standard mapping positions in a 560 x 300 box (controller centred at x 280).
const PAD_POS: Readonly<Record<number, readonly [number, number]>> = {
  6: [190, 36], 4: [196, 62], 7: [370, 36], 5: [364, 62], 10: [214, 128], 11: [326, 182], 12: [244, 168], 13: [244, 196], 14: [230, 182], 15: [258, 182],
  8: [258, 118], 9: [302, 118], 3: [356, 104], 2: [334, 126], 1: [378, 126], 0: [356, 148],
};
const AXIS_POS: Readonly<Record<number, readonly [number, number]>> = { 0: [214, 128], 1: [214, 128], 2: [326, 182], 3: [326, 182] };
const PAD_BODY = 'M200 74 C150 74 132 96 122 140 L104 226 C98 258 128 282 154 262 L204 214 H356 L406 262 C432 282 462 258 456 226 L438 140 C428 96 410 74 360 74 Z';
export function gamepadDiagram(bindings: GamepadBindings, mapping: string | null, pending: string | null): string {
  const labels: { x: number; y: number; side: 'l' | 'r'; text: string; group: Group; wait: boolean }[] = [];
  for (const action of GAMEPAD_ACTION_ORDER) {
    const key = GAMEPAD_ACTION_KEY[action];
    const label = key === 'steer' ? 'Steer' : ACTION_LABELS[key];
    const value = action === 'steerAxis' ? bindings.steerAxis : bindings[action];
    const pos = action === 'steerAxis' ? AXIS_POS[value] : PAD_POS[value];
    if (!pos) continue;
    const name = action === 'steerAxis' ? padAxisName(value, mapping) : padButtonName(value, mapping);
    labels.push({ x: pos[0], y: pos[1], side: pos[0] < 280 ? 'l' : 'r', text: `${name} · ${label}`, group: GROUP[key], wait: pending === action });
  }
  let out = `<path class="pb" d="${PAD_BODY}"/><path class="ps" d="M176 46 h46 a8 8 0 0 1 8 8 v14 h-62 v-14 a8 8 0 0 1 8 -8z M338 46 h46 a8 8 0 0 1 8 8 v14 h-62 v-14 a8 8 0 0 1 8 -8z"/>`;
  out += '<circle class="pk" cx="214" cy="128" r="22"/><circle class="pk" cx="326" cy="182" r="22"/><path class="pk" d="M236 160h16v14h14v16h-14v14h-16v-14h-14v-16h14z"/>';
  for (const [b, [x, y]] of Object.entries(PAD_POS)) if (Number(b) <= 3) out += `<circle class="pf" cx="${x}" cy="${y}" r="10"/><text class="pt" x="${x}" y="${y + 4}" text-anchor="middle">${PAD_SHORT[Number(b)]}</text>`;
  out += '<rect class="pf" x="250" y="112" width="16" height="10" rx="3"/><rect class="pf" x="294" y="112" width="16" height="10" rx="3"/>';
  for (const side of ['l', 'r'] as const) {
    const group = labels.filter(label => label.side === side).sort((a, b) => a.y - b.y);
    const step = Math.min(34, 250 / Math.max(1, group.length));
    const top = 150 - (group.length - 1) * step / 2;
    group.forEach((label, i) => {
      const ly = top + i * step, lx = side === 'l' ? 96 : 464;
      out += `<g class="cl g-${label.group}${label.wait ? ' wait' : ''}"><polyline points="${label.x},${label.y} ${side === 'l' ? lx + 14 : lx - 14},${ly} ${lx},${ly}"/><circle cx="${label.x}" cy="${label.y}" r="3.5"/><text x="${side === 'l' ? lx - 6 : lx + 6}" y="${ly + 4}" text-anchor="${side === 'l' ? 'end' : 'start'}">${esc(label.text)}</text></g>`;
    });
  }
  return `<svg class="cp-pad" viewBox="-80 0 720 300" role="img" aria-label="Gamepad layout with the current bindings">${out}</svg>`;
}

/* ------------------------------------------------------------------ touch diagram */
export function touchDiagram(steer: 'buttons' | 'drag'): string {
  const btn = (x: number, y: number, w: number, h: number, label: string, cls: string) => `<g class="tb ${cls}"><rect x="${x}" y="${y}" width="${w}" height="${h}"/><text x="${x + w / 2}" y="${y + h / 2 + 5}" text-anchor="middle">${label}</text></g>`;
  const steerMarkup = steer === 'drag'
    ? `<g class="tb g-drive"><rect class="dz" x="58" y="196" width="150" height="66"/><text x="133" y="226" text-anchor="middle">Drag to steer</text><text class="sm" x="133" y="246" text-anchor="middle">◀ slide your thumb ▶</text></g>`
    : btn(58, 196, 66, 66, '◀', 'g-drive') + btn(132, 196, 66, 66, '▶', 'g-drive');
  return `<svg class="cp-touch" viewBox="0 0 640 300" role="img" aria-label="Touch layout"><rect class="ph" x="20" y="14" width="600" height="272" rx="34"/><rect class="sc" x="44" y="30" width="552" height="240" rx="12"/>
${steerMarkup}${btn(392, 210, 58, 52, 'BRAKE', 'g-drive')}${btn(456, 210, 58, 52, 'HB', 'g-hb')}${btn(520, 186, 64, 76, 'GAS', 'g-gas')}${btn(486, 160, 98, 22, 'RECOVER', 'g-util')}${btn(530, 92, 54, 54, 'HORN', 'g-horn')}${btn(510, 40, 32, 32, 'II', 'g-sys')}${btn(548, 40, 38, 32, 'CAM', 'g-util')}
<g class="tn"><text x="58" y="186">Steer</text><text x="450" y="200" text-anchor="end">Hold brake to reverse</text><text x="456" y="82" text-anchor="middle">Pause · Camera</text></g></svg>`;
}

/* ------------------------------------------------------------------ how to drift */
const DRIFT_PATH = 'M30 150 C110 150 120 60 200 60 S290 150 370 150';
export function driftDiagram(): string {
  return `<svg class="cp-drift" viewBox="0 0 400 200" role="img" aria-label="A car sliding sideways through two corners"><path class="rd" d="${DRIFT_PATH}"/><path class="rl" d="${DRIFT_PATH}"/><path class="smoke" d="${DRIFT_PATH}"/>
<g class="car"><animateMotion dur="4.8s" repeatCount="indefinite" rotate="auto" path="${DRIFT_PATH}" keyPoints="0;.18;.5;.82;1" keyTimes="0;.2;.5;.8;1" calcMode="linear"/><g><animateTransform attributeName="transform" type="rotate" dur="4.8s" repeatCount="indefinite" values="0;0;-34;-30;0;32;30;0;0" keyTimes="0;.12;.24;.42;.5;.62;.78;.9;1"/><rect x="-15" y="-8" width="30" height="16" rx="3"/><rect class="ws" x="4" y="-6" width="6" height="12" rx="1.5"/><path class="hl" d="M15 -6 l22 -6 v24 l-22 -6z"/></g></g></svg>`;
}

/* ------------------------------------------------------------------ page */
const TABS: readonly [ControlsTab, string][] = [['keyboard', 'Keyboard'], ['gamepad', 'Gamepad'], ['touch', 'Touch'], ['drift', 'How to drift']];

function keyboardPanel(ctx: ControlsContext): string {
  const k = ctx.keyboard;
  if (!k) return '<p class="cp-note">Keyboard controls are not available here.</p>';
  const conflicts = keyboardConflicts(k);
  const rows = KEYBOARD_ACTION_ORDER.map(action => {
    const wait = ctx.pending === action;
    return `<li class="g-${GROUP[action]}${wait ? ' wait' : ''}"><span class="cp-act"><i></i>${ACTION_LABELS[action]}</span><span class="cp-keys">${wait ? '<em>Press a key. Esc cancels.</em>' : k[action].map(code => `<kbd>${esc(keyLabel(code))}</kbd>`).join('')}</span><button class="cp-change" data-remap="${action}" data-focus-key="kb-${action}" aria-label="Change ${ACTION_LABELS[action]}">${wait ? 'Waiting' : 'Change'}</button></li>`;
  }).join('');
  return `${keyboardDiagram(k, ctx.pending)}${legend()}${conflicts.length ? `<p class="cp-warn" role="alert">${conflicts.map(c => `${esc(keyLabel(c.code))} is on ${c.actions.map(a => ACTION_LABELS[a]).join(' and ')}`).join('. ')}. Change one of them.</p>` : ''}<ul class="cp-list">${rows}<li class="g-horn fixed"><span class="cp-act"><i></i>Horn</span><span class="cp-keys"><kbd>H</kbd></span><span class="cp-fixed">Fixed</span></li></ul>`;
}
function gamepadPanel(ctx: ControlsContext): string {
  const g = ctx.gamepad;
  if (!g) return '<p class="cp-note">Connect a gamepad and press any button.</p>';
  const rows = GAMEPAD_ACTION_ORDER.map(action => {
    const key = GAMEPAD_ACTION_KEY[action], wait = ctx.pending === action;
    const label = key === 'steer' ? 'Steer' : ACTION_LABELS[key];
    const value = action === 'steerAxis' ? padAxisName(g.steerAxis, ctx.mapping) : padButtonName(g[action], ctx.mapping);
    return `<li class="g-${GROUP[key]}${wait ? ' wait' : ''}"><span class="cp-act"><i></i>${label}</span><span class="cp-keys">${wait ? `<em>${action === 'steerAxis' ? 'Push a stick left or right.' : 'Press a button.'}</em>` : `<kbd>${esc(value)}</kbd>`}</span><button class="cp-change" data-gamepad-remap="${action}" data-focus-key="pad-${action}" aria-label="Change ${label}">${wait ? 'Waiting' : 'Change'}</button></li>`;
  }).join('');
  return `${gamepadDiagram(g, ctx.mapping, ctx.pending)}${ctx.mapping === 'standard' ? '' : '<p class="cp-note">This pad reports raw button numbers, so the diagram shows the standard layout.</p>'}<ul class="cp-list">${rows}</ul><p class="cp-note">Menus: D-pad or left stick to move, A to select, B to go back.</p>`;
}
function touchPanel(ctx: ControlsContext): string {
  const steer = ctx.touchSteer ?? 'buttons';
  return `${touchDiagram(steer)}${ctx.touchSteer ? `<h3>Steering style</h3><div class="cp-seg" role="group" aria-label="Touch steering"><button data-touch-steer-set="buttons" data-focus-key="ts-buttons" aria-pressed="${steer === 'buttons'}">Buttons</button><button data-touch-steer-set="drag" data-focus-key="ts-drag" aria-pressed="${steer === 'drag'}">Drag</button></div>` : ''}<ul class="cp-tips"><li><b>Gas</b> is the big lime pad. Hold it.</li><li><b>Brake</b> slows you down. Keep holding at a stop to reverse.</li><li><b>HB</b> is the handbrake. Tap it to start a slide.</li><li><b>Recover</b> puts you back on the road after a crash.</li></ul>`;
}
function driftPanel(ctx: ControlsContext): string {
  const k = ctx.keyboard, key = (action: KeyboardAction) => k ? `<kbd>${esc(keyLabel(k[action][0]!))}</kbd>` : '';
  return `<div class="cp-drift-wrap">${driftDiagram()}<ol class="cp-steps"><li><b>Turn in</b><span>Carry speed into the corner and turn ${key('steerLeft')}${key('steerRight')}.</span></li><li><b>Kick it</b><span>Tap the handbrake ${key('handbrake')} to break the rear loose.</span></li><li><b>Catch it</b><span>Countersteer. Point the front wheels where you want to go.</span></li><li><b>Balance</b><span>Throttle ${key('throttle')} holds the angle. More gas, more slide.</span></li><li><b>Link it</b><span>Chain slides to build the multiplier. Straighten up to bank the score. A wall or a spin loses the chain.</span></li></ol></div>`;
}
function legend(): string {
  const item = (group: Group, label: string) => `<span class="g-${group}"><i></i>${label}</span>`;
  return `<div class="cp-legend">${item('drive', 'Drive')}${item('hb', 'Handbrake')}${item('util', 'Car and camera')}${item('horn', 'Horn')}${item('sys', 'Pause')}</div>`;
}

export function renderControlsPage(input: ControlsContext): string {
  // No pad connected: label the diagram with standard names. A connected non-standard pad shows raw numbers.
  const ctx: ControlsContext = { ...input, mapping: input.mapping ?? 'standard' };
  const tabs = TABS.map(([id, label]) => `<button role="tab" class="cp-tab" data-ctab="${id}" data-focus-key="ctab-${id}" aria-selected="${ctx.tab === id}">${label}</button>`).join('');
  const body = ctx.tab === 'keyboard' ? keyboardPanel(ctx) : ctx.tab === 'gamepad' ? gamepadPanel(ctx) : ctx.tab === 'touch' ? touchPanel(ctx) : driftPanel(ctx);
  const canRemap = ctx.tab === 'keyboard' || ctx.tab === 'gamepad';
  return `<div class="lt-root cp-root" data-view="controls"><section class="cp-page lt-in" aria-label="Controls"><header class="cp-head"><button class="lt-back" data-menu="back" data-focus-key="cp-back" aria-label="Back">${MENU_ICONS.back}</button><div><p class="lt-kicker">Controls</p><h2>Know the car</h2></div>${canRemap ? '<button class="cp-reset" data-action="reset-bindings" data-focus-key="cp-reset">Reset to defaults</button>' : ''}</header><nav class="cp-tabs" role="tablist" aria-label="Control type">${tabs}</nav><div class="cp-body" role="tabpanel" data-tab="${ctx.tab}"><p class="cp-msg" role="status" aria-live="polite">${esc(ctx.message)}</p>${body}</div></section></div>`;
}

export const CONTROLS_CSS = `
.cp-root{display:flex!important;align-items:center;justify-content:center}
.cp-root::before{background:rgba(3,9,11,.86)!important;animation:lt-scrim .4s ease both}
.cp-page{pointer-events:auto;display:flex;flex-direction:column;width:min(980px,100%);max-height:100%;min-height:0;background:linear-gradient(170deg,rgba(8,19,21,.96),rgba(4,10,12,.96));border:1px solid var(--lp-line);border-top:3px solid var(--lp-accent);clip-path:polygon(0 0,calc(100% - 24px) 0,100% 24px,100% 100%,24px 100%,0 calc(100% - 24px))}
.cp-head{display:flex;align-items:center;gap:14px;padding:18px 22px 10px}
.cp-head>div{flex:1}
.cp-head h2{margin:0;font:800 2.2em/.9 var(--lp-stencil);font-style:italic;letter-spacing:.04em;text-transform:uppercase}
.lp-shell .lt-root .cp-reset{min-height:42px;font-size:.74em;letter-spacing:.14em}
.cp-tabs{display:flex;gap:4px;padding:0 22px;border-bottom:1px solid var(--lp-line);overflow-x:auto}
.lp-shell .lt-root .cp-tab{--cut:0px;clip-path:none;min-height:44px;padding:.5em 1em;background:transparent;border:0;border-bottom:3px solid transparent;font-size:.78em;letter-spacing:.16em;white-space:nowrap;color:var(--lp-dim)}
.lp-shell .lt-root .cp-tab[aria-selected=true]{color:var(--lp-accent);border-bottom-color:var(--lp-accent)}
.lp-shell .lt-root .cp-tab:hover:not(:disabled){transform:none;color:var(--lp-ink);background:rgba(255,255,255,.04)}
.cp-body{overflow:auto;min-height:0;padding:12px 22px 22px;-webkit-overflow-scrolling:touch;overscroll-behavior:contain;animation:lt-in .4s cubic-bezier(.16,.84,.24,1) both}
.cp-msg{min-height:1.3em;margin:0 0 8px;font-size:.84em;color:var(--lp-accent);letter-spacing:.04em}
.cp-body svg{display:block;width:100%;height:auto;max-height:42vh}
.cp-kb .kc rect{fill:rgba(255,255,255,.035);stroke:rgba(130,205,196,.28);stroke-width:1}
.cp-kb .kl{font:600 12px var(--lp-font);fill:var(--lp-faint)}
.cp-kb .kt{font:700 7.6px var(--lp-font);letter-spacing:.06em;fill:var(--lp-on-accent)}
.cp-kb .g-drive rect{fill:var(--lp-accent);stroke:none}.cp-kb .g-hb rect{fill:var(--lp-hot);stroke:none}.cp-kb .g-util rect{fill:var(--lp-teal);stroke:none}.cp-kb .g-sys rect{fill:#c9d4cf;stroke:none}.cp-kb .g-horn rect{fill:#ffc94d;stroke:none}
.cp-kb [class*=g-] .kl{fill:var(--lp-on-accent);font-weight:700}
.cp-kb .wait rect{stroke:#fff;stroke-width:2.5;animation:cp-blink .9s ease-in-out infinite}
@keyframes cp-blink{50%{opacity:.45}}
.cp-legend{display:flex;flex-wrap:wrap;gap:14px;margin:10px 0 4px;font-size:.74em;letter-spacing:.1em;text-transform:uppercase;color:var(--lp-dim)}
.cp-legend span{display:flex;align-items:center;gap:6px}
.cp-legend i,.cp-act i{width:10px;height:10px;display:inline-block;flex:none}
.g-drive>i,.g-drive .cp-act i{background:var(--lp-accent)}.g-hb>i,.g-hb .cp-act i{background:var(--lp-hot)}.g-util>i,.g-util .cp-act i{background:var(--lp-teal)}.g-sys>i,.g-sys .cp-act i{background:#c9d4cf}.g-horn>i,.g-horn .cp-act i{background:#ffc94d}
.cp-list{list-style:none;margin:12px 0 0;padding:0;display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:6px}
.cp-list li{display:flex;align-items:center;gap:10px;min-height:52px;padding:4px 4px 4px 12px;background:rgba(255,255,255,.03);border-left:2px solid transparent}
.cp-list li.wait{border-left-color:var(--lp-accent);background:rgba(216,250,114,.08)}
.cp-act{display:flex;align-items:center;gap:9px;flex:1;min-width:0;font-weight:600;font-size:.9em}
.cp-keys{display:flex;gap:5px;align-items:center}
.cp-keys em{font-style:normal;font-size:.8em;color:var(--lp-accent);animation:cp-blink .9s ease-in-out infinite}
.lt-root kbd,.cp-tips kbd,.cp-steps kbd{display:inline-block;min-width:28px;padding:5px 7px;font:700 .82em/1 var(--lp-font);text-align:center;color:var(--lp-ink);border:1px solid var(--lp-line-strong);border-bottom-width:3px;background:rgba(5,12,14,.8);border-radius:3px;margin:0 2px}
.lp-shell .lt-root .cp-change{min-height:44px;padding:.4em .9em;font-size:.72em;letter-spacing:.14em}
.cp-fixed{padding:0 12px;font-size:.7em;letter-spacing:.16em;text-transform:uppercase;color:var(--lp-faint)}
.cp-warn{margin:8px 0;padding:8px 12px;border-left:3px solid var(--lp-hot);background:rgba(255,138,31,.1);color:#ffd2a8;font-size:.86em}
.cp-note{color:var(--lp-dim);font-size:.84em}
.cp-pad .pb{fill:rgba(255,255,255,.04);stroke:rgba(170,230,222,.5);stroke-width:2}
.cp-pad .ps,.cp-pad .pk,.cp-pad .pf{fill:rgba(255,255,255,.06);stroke:rgba(170,230,222,.45);stroke-width:1.5}
.cp-pad .pt{font:700 10px var(--lp-font);fill:var(--lp-ink)}
.cp-pad .cl circle{r:2.5px}
.cp-pad .cl polyline{fill:none;stroke-width:1.4}.cp-pad .cl text{font:600 13px var(--lp-font);fill:var(--lp-ink)}
.cp-pad .g-drive polyline,.cp-pad .g-drive circle{stroke:var(--lp-accent);fill:var(--lp-accent)}.cp-pad .g-drive polyline{fill:none}
.cp-pad .g-hb polyline,.cp-pad .g-hb circle{stroke:var(--lp-hot);fill:var(--lp-hot)}.cp-pad .g-hb polyline{fill:none}
.cp-pad .g-util polyline,.cp-pad .g-util circle{stroke:var(--lp-teal);fill:var(--lp-teal)}.cp-pad .g-util polyline{fill:none}
.cp-pad .g-sys polyline,.cp-pad .g-sys circle{stroke:#c9d4cf;fill:#c9d4cf}.cp-pad .g-sys polyline{fill:none}
.cp-pad .wait text{fill:var(--lp-accent);animation:cp-blink .9s infinite}
.cp-touch .ph{fill:#0b1416;stroke:rgba(170,230,222,.45);stroke-width:2}.cp-touch .sc{fill:rgba(47,184,173,.08);stroke:rgba(130,205,196,.2)}
.cp-touch .tb rect{fill:rgba(5,11,13,.7);stroke:rgba(130,205,196,.6);stroke-width:1.5}
.cp-touch .tb text{font:700 13px var(--lp-font);letter-spacing:.08em;fill:var(--lp-ink)}.cp-touch .tb text.sm{font-size:10px;fill:var(--lp-dim)}
.cp-touch .g-gas rect{fill:var(--lp-accent);stroke:none}.cp-touch .g-gas text{fill:var(--lp-on-accent)}
.cp-touch .g-hb rect{stroke:#ffc94d}.cp-touch .g-hb text{fill:#ffc94d}.cp-touch .g-drive rect{stroke:var(--lp-accent)}
.cp-touch .g-horn rect{fill:var(--lp-accent);stroke:none}.cp-touch .g-horn text{fill:var(--lp-on-accent);font-size:11px}
.cp-touch .g-util text{font-size:10px}.cp-touch .g-sys text{font-size:11px}
.cp-touch .dz{stroke-dasharray:6 4}
.cp-touch .tn text{font:600 11px var(--lp-font);letter-spacing:.14em;text-transform:uppercase;fill:var(--lp-hot)}
.cp-seg{display:inline-flex;border:1px solid var(--lp-line)}
.lp-shell .lt-root .cp-seg button{--cut:0px;clip-path:none;border:0;min-height:44px;background:transparent;font-size:.78em}
.lp-shell .lt-root .cp-seg button[aria-pressed=true]{background:var(--lp-teal-deep);color:var(--lp-accent)}
.cp-body h3{margin:16px 0 8px;font-size:.68em;font-weight:700;letter-spacing:.3em;text-transform:uppercase;color:var(--lp-teal)}
.cp-tips{margin:14px 0 0;padding:0;list-style:none;display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:6px 18px;font-size:.88em;color:var(--lp-dim)}
.cp-tips b{color:var(--lp-ink)}
.cp-drift-wrap{display:grid;grid-template-columns:minmax(0,1.1fr) minmax(0,1fr);gap:22px;align-items:center}
.cp-drift .rd{fill:none;stroke:#1a2a2d;stroke-width:34;stroke-linecap:round}
.cp-drift .rl{fill:none;stroke:rgba(244,247,241,.35);stroke-width:1.5;stroke-dasharray:8 10}
.cp-drift .smoke{fill:none;stroke:rgba(230,240,236,.25);stroke-width:12;stroke-linecap:round;stroke-dasharray:60 600;animation:cp-smoke 4.8s linear infinite}
@keyframes cp-smoke{0%,15%{stroke-dashoffset:40;opacity:0}25%{opacity:1}100%{stroke-dashoffset:-560;opacity:.6}}
.cp-drift .car rect{fill:var(--lp-accent)}.cp-drift .car .ws{fill:#0d1505}.cp-drift .car .hl{fill:rgba(255,236,170,.35)}
.cp-steps{margin:0;padding:0;list-style:none;counter-reset:st;display:grid;gap:10px}
.cp-steps li{counter-increment:st;display:grid;grid-template-columns:auto 1fr;column-gap:12px;align-items:baseline}
.cp-steps li::before{content:counter(st,decimal-leading-zero);grid-row:1/3;font:800 1.8em/1 var(--lp-stencil);color:var(--lp-hot)}
.cp-steps b{font:800 1.2em/1.1 var(--lp-display);letter-spacing:.06em;text-transform:uppercase}
.cp-steps span{font-size:.88em;color:var(--lp-dim)}
.lp-shell[data-quality=low] .cp-page{background:#071012}
@media (orientation:portrait) and (max-width:900px){.cp-root{align-items:stretch}.cp-page{width:100%;clip-path:none}.cp-drift-wrap{grid-template-columns:1fr}.cp-list{grid-template-columns:1fr}.cp-head h2{font-size:1.7em}}
@media (max-width:560px){.cp-head{padding:12px 14px 8px;flex-wrap:wrap}.lp-shell .lt-root .cp-reset{order:3;width:100%}.cp-tabs{padding:0 14px}.cp-body{padding:10px 14px 18px}}
@media (max-height:520px) and (orientation:landscape){.cp-head{padding:8px 16px 4px}.cp-head h2{font-size:1.5em}.cp-body svg{max-height:52vh}.cp-drift-wrap{gap:12px}.cp-list li{min-height:44px}}
`;
