import type { CarId, LightingPreset, QualitySelection, RouteId } from '../../contracts/runtime-contracts';
import { ASSIST_LABELS, ASSIST_LEVELS, isAssistLevel, type AssistLevel } from '../physics/assists';
import { medalModeOf, nextMedalTarget, type MedalTargets } from '../events/medal-targets';
import type { RouteDefinition } from '../../contracts/world-contracts';
import type { ExperienceCoordinator, ExperienceSettings, ExperienceState } from '../experience/coordinator';
import type { TunePresetId } from '../physics';
import type { GamepadBindingAction, GamepadBindings, GamepadMenuAction, InputDevice, KeyboardAction, KeyboardBindings } from '../input/player-input';
import { EVENTS } from '../../content/events/catalog';
import { PLAYER_CSS } from './player-ui-css';
import type { RemapEvent } from '../input/player-input';
import { ACTION_LABELS, GAMEPAD_ACTION_KEY } from '../input/bindings';
import { availableSoloModes, MAIN_MENU_CSS, RACE_COUNTDOWN_CSS, renderMainMenu, type MenuContext, type MenuFeatures, type MenuProfile, type MenuView, type SoloMode } from './main-menu';
import { CONTROLS_CSS, renderControlsPage, type ControlsTab } from './controls-page';
import { HUD_SLOTS_CSS, mountHudSlots } from './hud-slots';

export interface CosmeticChoice { readonly id: string; readonly label: string; readonly kind: 'paint' | 'wheelStyle' | 'livery' }
export interface PlayerUIOptions { readonly touchSteerMode?: () => 'buttons' | 'drag'; readonly onTouchSteerMode?: (mode: 'buttons' | 'drag') => void; readonly cosmetics?: readonly CosmeticChoice[] | (() => readonly CosmeticChoice[]); readonly routes?: readonly RouteDefinition[]; readonly title?: string; readonly onCameraCycle?: () => void; readonly onDriveFocus?: () => void; readonly activeDevice?: () => InputDevice; readonly gamepadMapping?: () => string | null; readonly keyboardBindings?: () => KeyboardBindings; readonly gamepadBindings?: () => GamepadBindings; readonly onBeginKeyboardRemap?: (action: KeyboardAction) => void; readonly onBeginGamepadRemap?: (action: GamepadBindingAction) => void; readonly onRestoreDefaultBindings?: () => void; readonly online?: { available(): boolean; count(): number; open(): void; status?(): 'off' | 'connecting' | 'ready'; isOpen?(): boolean; close?(): void }; readonly shop?: { available(): boolean; open(): void; balance(): string; /** Marks in the unopened starter gift, or null. */ gift?(): number | null; /** Shows the starter gift reveal. */ openGift?(): void; /** Self-hosted build: gifts waiting in the inbox. */ inbox?(): number; openInbox?(): void }; readonly garage?: { open(): void }; readonly missions?: { available(): boolean; open(): void }; readonly profile?: () => MenuProfile | null; readonly quality?: () => string; readonly remap?: { pending(): string | null; cancel(): void; subscribe(listener: (event: RemapEvent) => void): () => void }; readonly onMenuMode?: (mode: 'title' | 'pause' | null) => void; /** Feature hub (src/ui/feature-hub.ts): daily card, leaderboards, profile, last-run replay. */ readonly features?: { menu(): MenuFeatures | null; open(action: string): void } }
export interface PlayerUI { dispose(): void; announce(message: string): void; handleMenuAction(action: GamepadMenuAction): void; /** Esc / B: true when the UI consumed it (closed a page); false means resume driving. */ handleBack(): boolean; openControls(): void }

const carNames: Readonly<Record<CarId, string>> = { 'CAR-01': 'Challenger', 'CAR-02': 'Cybertruck', 'CAR-04': 'McLaren F1', 'CAR-05': 'Lancia Delta', 'CAR-06': 'Agera' };
const esc = (text: unknown) => String(text ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);
const polar = (cx: number, cy: number, r: number, deg: number): string => { const a = deg * Math.PI / 180; return `${(cx + r * Math.sin(a)).toFixed(1)},${(cy - r * Math.cos(a)).toFixed(1)}`; };
/** Tachometer: 240 degree open-bottom arc, radius 92 in a 220 box. Fill is the live engine rpm, the last 15 percent is the redline zone. */
const TACH_PATH = `M${polar(110, 110, 92, -120)} A92,92 0 1 1 ${polar(110, 110, 92, 120)}`;
const TACH_TICKS = Array.from({ length: 21 }, (_, i) => { const a = -120 + i * 12, major = i % 5 === 0; const [x1, y1] = polar(110, 110, major ? 70 : 75, a).split(','), [x2, y2] = polar(110, 110, 82, a).split(','); return `<line class="tk${major ? ' m' : ''}" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}"/>`; }).join('');
const TACH_SVG = `<svg class="lp-tach" viewBox="0 0 220 220" aria-hidden="true" focusable="false"><path class="tr" d="${TACH_PATH}"/><path class="tt" d="${TACH_PATH}" transform="translate(110 110) scale(1.12) translate(-110 -110)"/><path class="tz" pathLength="100" stroke-dasharray="0 85 15 101" d="${TACH_PATH}" transform="translate(110 110) scale(1.12) translate(-110 -110)"/><path class="tf" pathLength="100" d="${TACH_PATH}"/>${TACH_TICKS}</svg>`;
/** Drift angle arch: 140 degrees total, live arc grows from the centre line to whichever side the car slides. */
const ARC_END_R = polar(120, 120, 100, 70), ARC_END_L = polar(120, 120, 100, -70);
const ARC_TICKS = Array.from({ length: 15 }, (_, i) => { const a = -70 + i * 10, abs = Math.abs(a); const [x1, y1] = polar(120, 120, 83, a).split(','), [x2, y2] = polar(120, 120, 91, a).split(','); return `<line class="ar-k${abs === 0 ? ' c' : abs >= 50 ? ' h' : abs >= 30 ? ' w' : ''}" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}"/>`; }).join('');
const ARC_SVG = `<svg class="lp-arc" viewBox="0 8 240 88" aria-hidden="true" focusable="false"><path class="ar-t" d="M${ARC_END_L} A100,100 0 0 1 ${ARC_END_R}"/><path class="ar-h" d="M${polar(120, 120, 108, -70)} A108,108 0 0 1 ${polar(120, 120, 108, 70)}"/><path class="ar-f l" pathLength="1" d="M120,20 A100,100 0 0 0 ${ARC_END_L}"/><path class="ar-f r" pathLength="1" d="M120,20 A100,100 0 0 1 ${ARC_END_R}"/>${ARC_TICKS}</svg>`;
const HUD_MARKUP = `<div class="lp-hud" role="group" aria-label="Driving information"><div class="lp-speed" data-redline="false">${TACH_SVG}<strong>0</strong><small>km/h</small></div><div class="lp-gear"><strong>N</strong><small>gear</small></div><div class="lp-event" hidden><strong>0.0s</strong><small>event</small></div><div class="lp-score" data-live="false"><strong class="lp-banked">0</strong><small>banked</small><div class="lp-chain">chain <b>0</b><i>x1</i></div></div><div class="lp-angle" data-level="low" data-drift="false">${ARC_SVG}<div class="lp-angle-read"><strong>0°</strong><small>slide</small></div></div><div class="lp-invalid" role="status" aria-live="polite" hidden></div></div>`;
const LOGO_MARK = '<svg viewBox="0 0 48 48" focusable="false"><path d="M6 5h31l6 6v32H11l-6-6z" fill="none" stroke="currentColor" stroke-width="2.4"/><path d="M19 11h8l-5 20h14l-2 7H12z" fill="currentColor"/><path d="M1 27h9M3 32h8M0 37h7" stroke="currentColor" stroke-width="2.2"/></svg>';
const ICON_PAUSE = '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M6 4h4.5v16H6zM13.5 4H18v16h-4.5z" fill="currentColor"/></svg>';
const ICON_CAMERA = '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M3 7h4l2-3h6l2 3h4v13H3z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="miter"/><circle cx="12" cy="13.5" r="3.6" fill="none" stroke="currentColor" stroke-width="2"/></svg>';
const GRADES = { gold: 'S', silver: 'A', bronze: 'B', none: '-' } as const;
const MODE_LABELS: Readonly<Record<string, string>> = { 'drift-attack': 'Drift attack', 'time-trial': 'Time trial', 'rival-ghost': 'Rival run' };
const pct = (value: number, min: number, max: number): string => (Math.max(0, Math.min(1, (value - min) / (max - min))) * 100).toFixed(1);
/** Key names in a hint ("WASD or arrows: drive") become keycaps; textContent stays identical to the plain hint. */
function hintMarkup(text: string): string {
  return text.split(' · ').map(segment => { const at = segment.indexOf(': '); if (at < 0) return esc(segment);
    const keys = segment.slice(0, at), label = segment.slice(at + 2);
    return `${keys.split(/( or | \/ )/).map(part => part === ' or ' || part === ' / ' ? esc(part) : `<kbd>${esc(part)}</kbd>`).join('')}: <em>${esc(label)}</em>`; }).join(' · ');
}
/** Wraps the first panel body in a scroller so the cut-corner frame and hairline never scroll away. */
const framePanel = (markup: string): string => markup.replace(/(<section class="lp-panel[^>]*>)([\s\S]*?)(<\/section>)/, '$1<div class="lp-scroll">$2</div>$3');
/** Scoreboard numbers tick up from zero; reduced motion or a missing rAF leaves the final value in place. */
function countUp(root: HTMLElement, reduced: boolean): void {
  if (reduced || typeof requestAnimationFrame !== 'function') return;
  root.querySelectorAll<HTMLElement>('[data-count]').forEach((node, index) => {
    const to = Number(node.dataset.count), decimals = Number(node.dataset.decimals ?? 0), delay = 250 + index * 160, length = 1100;
    const format = (value: number) => value.toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
    node.textContent = format(0); let start = 0;
    const tick = (time: number) => { if (!node.isConnected) return; start ||= time; const t = Math.max(0, Math.min(1, (time - start - delay) / length)); node.textContent = format(to * (1 - Math.pow(1 - t, 3))); if (t < 1) requestAnimationFrame(tick); };
    requestAnimationFrame(tick);
  });
}
const speedKmh = (v: { x: number; z: number }) => Math.round(Math.hypot(v.x, v.z) * 3.6);

/** Accessible DOM shell over the single authoritative ExperienceCoordinator state. */
export function createPlayerUI(host: HTMLElement, coordinator: ExperienceCoordinator, options: PlayerUIOptions = {}): PlayerUI {
  const style = document.createElement('style'); style.textContent = `${PLAYER_CSS}${COMPACT_TUTORIAL_LAYOUT_CSS}${MAIN_MENU_CSS}${CONTROLS_CSS}${RACE_COUNTDOWN_CSS}${HUD_SLOTS_CSS}`; document.head.append(style);
  const blockGesture = (event: Event): void => { if (document.documentElement.dataset.lateralScreen === 'drive') event.preventDefault(); };
  document.addEventListener('gesturestart', blockGesture, { passive: false });
  // Menu state that the coordinator does not model: which menu page shows, and whether a drive has started (title vs pause).
  let menuView: MenuView = 'home', hasDriven = false, soloMode: SoloMode = 'drift-attack', controlsTab: ControlsTab | null = null, controlsReturn: 'menu' | 'settings' = 'menu', remapMessage = '', menuMode: 'title' | 'pause' | null = null, viewTimer = 0;
  const shell = document.createElement('section'); shell.className = 'lp-shell'; shell.setAttribute('aria-label', 'Lateral game interface'); host.append(shell);
  let current: ExperienceState | null = null; let lastRender = 0; let timer = 0; let disposed = false; let tutorialDismissed = false; let tutorialCardDismissed = false; let lastTutorialKey = ''; let wasDriving = false; let lastOverlayMarkup: string | null = null; let lastOverlayScreen = ''; let lastInputHintChange = performance.now();
  shell.innerHTML = '<div class="lp-fx" aria-hidden="true" hidden><div class="lp-fx-vignette"></div><div class="lp-fx-lines"></div><div class="lp-fx-brake"></div><div class="lp-fx-hb"></div><div class="lp-fx-hit"></div><div class="lp-popups"></div></div><div class="lp-telemetry"><div class="lp-hud-data"></div><div class="lp-hud-controls"></div></div><div class="lp-route-guide" role="img" aria-label="Route guide"></div><div class="lp-input-hint" role="status" aria-live="polite"><span></span><button data-action="tutorial-dismiss" aria-label="Dismiss driving tips">×</button></div><div class="lp-tutorial" aria-live="polite"></div><div class="lp-count" role="status" aria-live="assertive" hidden></div><div class="lp-overlay"></div><div class="lp-error" role="alert"></div><div class="lp-storage-warning" role="status" aria-live="polite"></div><div class="lp-live" aria-live="polite" aria-atomic="true"></div>';
  const hudData = shell.querySelector<HTMLElement>('.lp-hud-data')!;
  let detachSlots: () => void = () => {};
  const hudControls = shell.querySelector<HTMLElement>('.lp-hud-controls')!;
  hudData.innerHTML = HUD_MARKUP; hudData.hidden = true;
  const hudRef = {
    speed: hudData.querySelector<HTMLElement>('.lp-speed strong')!, gear: hudData.querySelector<HTMLElement>('.lp-gear strong')!,
    event: hudData.querySelector<HTMLElement>('.lp-event')!, eventValue: hudData.querySelector<HTMLElement>('.lp-event strong')!, eventLabel: hudData.querySelector<HTMLElement>('.lp-event small')!,
    score: hudData.querySelector<HTMLElement>('.lp-score')!, banked: hudData.querySelector<HTMLElement>('.lp-banked')!,
    chain: hudData.querySelector<HTMLElement>('.lp-chain b')!, multiplier: hudData.querySelector<HTMLElement>('.lp-chain i')!,
    angle: hudData.querySelector<HTMLElement>('.lp-angle')!, angleValue: hudData.querySelector<HTMLElement>('.lp-angle strong')!,
    left: hudData.querySelector<SVGElement>('.ar-f.l')!, right: hudData.querySelector<SVGElement>('.ar-f.r')!,
    tach: hudData.querySelector<SVGElement>('.tf')!, speedBox: hudData.querySelector<HTMLElement>('.lp-speed')!,
    invalid: hudData.querySelector<HTMLElement>('.lp-invalid')!,
  };
  const fx = shell.querySelector<HTMLElement>('.lp-fx')!;
  const fxHit = fx.querySelector<HTMLElement>('.lp-fx-hit')!;
  const popups = fx.querySelector<HTMLElement>('.lp-popups')!;
  let lastRpm = -1; let lastBanked = -1; let lastHudUpdate = 0; let lastChain = 0; let lastMultiplier = 1; let lastImpactTick = -1; let lastRecoveryCount = -1; let lastSpeedK = -1; let lastHyperK = -1; let lastBrake = -1; let lastHandbrake = -1;
  const setVar = (name: string, value: number, previous: number): number => { if (value === previous) return previous; shell.style.setProperty(name, String(value)); return value; };
  /** Floating score callouts for drift chains. Removed on animation end so the DOM never grows. */
  function popup(text: string, kind = '', chip = ''): void {
    if (shell.dataset.reducedMotion === 'true') return;
    while (popups.childElementCount >= 3) popups.firstElementChild?.remove();
    const node = document.createElement('div'); node.className = `lp-popup ${kind}`.trim(); node.textContent = text;
    if (chip) { const tag = document.createElement('i'); tag.textContent = chip; node.append(tag); }
    node.addEventListener('animationend', () => node.remove(), { once: true }); popups.append(node);
  }
  const setText = (element: HTMLElement, text: string): void => { if (element.textContent !== text) element.textContent = text; };
  /** Big 3-2-1-GO over the run's start countdown (solo events and online races alike), timed by simulation ticks so it matches the sim exactly. */
  const countBox = shell.querySelector<HTMLElement>('.lp-count')!;
  let countRun = '', countStartTick = 0, countArmed = false, goUntil = 0, countText = '';
  function updateCountdown(state: ExperienceState): void {
    const run = state.runtime.run, now = performance.now(), tick = state.runtime.frame.current.simulationTick;
    let text = '';
    if (state.screen === 'drive' && run?.state === 'COUNTDOWN') {
      if (countRun !== run.runId) { countRun = run.runId; countStartTick = tick; countArmed = true; }
      goUntil = 0;
      text = String(Math.max(1, Math.ceil(3 - (tick - countStartTick) / 60)));
    } else if (run?.state === 'ACTIVE' && countRun === run.runId && countArmed) { countArmed = false; goUntil = now + 900; }
    if (!text && state.screen === 'drive' && now < goUntil) text = 'GO';
    if (text === countText) return;
    countText = text; countBox.hidden = !text;
    countBox.innerHTML = text ? `<b data-v="${text}">${text}</b>` : '';
  }
  /** Updates the persistent HUD nodes in place so meters can animate between coordinator frames. */
  function updateHud(state: ExperienceState): void {
    const visible = state.screen === 'drive' || state.screen === 'replay';
    hudData.hidden = !visible; fx.hidden = state.screen !== 'drive';
    updateCountdown(state);
    if (!visible) { lastBanked = -1; lastChain = 0; lastMultiplier = 1; return; }
    const runtime = state.runtime, view = runtime.frame.current, score = runtime.frame.score;
    const horizontalSpeedMS = Math.hypot(view.linearVelocityMS.x, view.linearVelocityMS.z);
    const kmh = speedKmh(view.linearVelocityMS);
    setText(hudRef.speed, String(kmh));
    const rpmK = Math.round(Math.max(0, Math.min(1, (view.engineRpm || 0) / 7600)) * 200) / 200;
    if (rpmK !== lastRpm) { lastRpm = rpmK; hudRef.tach.style.strokeDasharray = `${(rpmK * 100).toFixed(1)} 101`; hudRef.speedBox.dataset.redline = String(rpmK > .88); }
    const driving = state.screen === 'drive' && !runtime.paused;
    const speedK = driving ? Math.round(Math.min(1, Math.max(0, (kmh - 40) / 140)) * 20) / 20 : 0;
    lastSpeedK = setVar('--lp-speed-k', speedK, lastSpeedK);
    // Second stage for very high speed (200 to 360 km/h): denser, tighter speed lines.
    const hyperK = driving ? Math.round(Math.min(1, Math.max(0, (kmh - 200) / 160)) * 20) / 20 : 0;
    lastHyperK = setVar('--lp-hyper-k', hyperK, lastHyperK);
    const input = runtime.input;
    const brake = driving && input && view.gear > 0 && input.brake > 0.2 && kmh > 8 ? Math.round(input.brake * 10) / 10 : 0;
    lastBrake = setVar('--lp-brake', brake, lastBrake);
    const handbrake = driving && input && input.handbrake > 0.2 && kmh > 8 ? Math.round(input.handbrake * 10) / 10 : 0;
    lastHandbrake = setVar('--lp-hb', handbrake, lastHandbrake);
    const impact = runtime.frame.impact;
    if (driving && impact && impact.simulationTick !== lastImpactTick && impact.speedDeltaMS > 2 && state.settings.reducedMotion !== true) { lastImpactTick = impact.simulationTick; fxHit.classList.remove('go'); void fxHit.offsetWidth; fxHit.classList.add('go'); }
    setText(hudRef.gear, view.gear < 0 ? 'R' : String(view.gear));
    const inEvent = runtime.mode !== 'free-drive';
    hudRef.event.hidden = !inEvent;
    if (inEvent) {
      const elapsed = Math.max(0, runtime.run?.elapsedActiveSeconds ?? score.activeSeconds);
      setText(hudRef.eventValue, `${elapsed.toFixed(1)}s`);
      // Medal pace: the best medal still in reach on time, or the next score medal to beat in drift attack.
      const targets = runtime.medalTargets;
      const pace = targets
        ? nextMedalTarget(runtime.mode, targets, medalModeOf(runtime.mode) === 'time-trial' ? elapsed : Math.floor(score.banked)) : null;
      setText(hudRef.eventLabel, pace ? `${MEDAL_NAMES[pace.medal]} ${formatMedalTarget(runtime.mode, pace.target)}` : 'event');
      if (hudRef.event.dataset.medal !== (pace?.medal ?? '')) hudRef.event.dataset.medal = pace?.medal ?? '';
    }
    const banked = Math.floor(score.banked), chain = Math.floor(score.unbanked);
    setText(hudRef.banked, String(banked));
    if (lastBanked >= 0 && banked > lastBanked && state.settings.reducedMotion !== true) { hudRef.banked.classList.remove('pop'); void hudRef.banked.offsetWidth; hudRef.banked.classList.add('pop'); }
    if (lastBanked >= 0 && banked > lastBanked) popup(`+${(banked - lastBanked).toLocaleString('en-US')}`, '', 'banked');
    else if (lastBanked >= 0 && lastChain >= 25 && chain === 0 && banked === lastBanked) popup('Chain lost', 'lost');
    else if (chain > 0 && (score.multiplier || 1) > lastMultiplier && lastMultiplier >= 1) popup(`x${Number.isInteger(score.multiplier) ? score.multiplier : score.multiplier.toFixed(1)}`, 'mult');
    const recovery = runtime.recovery;
    if (recovery && recovery.count !== lastRecoveryCount) {
      if (lastRecoveryCount >= 0 && recovery.count > lastRecoveryCount) popup(recovery.penaltySeconds > 0 ? `Recovered +${recovery.penaltySeconds.toFixed(1)}s` : 'Recovered', 'lost');
      lastRecoveryCount = recovery.count;
    }
    lastBanked = banked; lastChain = chain; lastMultiplier = chain > 0 ? (score.multiplier || 1) : 1;
    const live = chain > 0;
    hudRef.score.dataset.live = String(live);
    hudRef.score.style.setProperty('--lp-heat', Math.max(0, Math.min(1, ((score.multiplier || 1) - 1) / 4)).toFixed(2));
    setText(hudRef.chain, String(chain));
    const multiplier = Number.isInteger(score.multiplier) ? String(score.multiplier) : (score.multiplier || 1).toFixed(1);
    setText(hudRef.multiplier, `x${multiplier}`);
    const degrees = horizontalSpeedMS < 1.5 ? 0 : Math.abs(view.driftAngleRad) * 57.2958;
    setText(hudRef.angleValue, `${Math.round(degrees)}°`);
    const fill = Math.min(1, degrees / 70);
    hudRef.left.style.strokeDasharray = `${view.driftAngleRad < 0 ? fill.toFixed(3) : 0} 2`;
    hudRef.right.style.strokeDasharray = `${view.driftAngleRad >= 0 ? fill.toFixed(3) : 0} 2`;
    hudRef.angle.dataset.level = degrees < 25 ? 'low' : degrees < 50 ? 'mid' : 'high';
    hudRef.angle.dataset.drift = String(score.validDrift === true);
    const invalidReason = runtime.run?.invalidReason;
    const invalidMessage = invalidReason ? `Run invalid: ${invalidText(invalidReason)}` : '';
    hudRef.invalid.hidden = !invalidMessage; setText(hudRef.invalid, invalidMessage);
  }
  const routeGuide = shell.querySelector<HTMLElement>('.lp-route-guide')!;
  const inputHint = shell.querySelector<HTMLElement>('.lp-input-hint')!;
  // One-line first-run assist hint. Shown once, the first time a player drives with assists on.
  const assistHint = document.createElement('p');
  assistHint.className = 'lp-assist-hint'; assistHint.hidden = true; assistHint.setAttribute('role', 'status');
  assistHint.textContent = ASSIST_HINT_TEXT;
  shell.append(assistHint);
  let assistHintShownAt = 0;
  const inputHintText = inputHint.querySelector<HTMLElement>('span')!;
  const tutorialPanel = shell.querySelector<HTMLElement>('.lp-tutorial')!;
  const overlay = shell.querySelector<HTMLElement>('.lp-overlay')!;
  const errorBox = shell.querySelector<HTMLElement>('.lp-error')!;
  const storageWarning = shell.querySelector<HTMLElement>('.lp-storage-warning')!;
  shell.addEventListener('click', event => { const target = (event.target as Element).closest<HTMLElement>('[data-action],[data-event],[data-remap],[data-gamepad-remap],[data-menu],[data-solo-mode],[data-route],[data-lighting],[data-ctab],[data-touch-steer-set]'); const state = current; if (!target || !state) return;
    if (target.dataset.menu) { const next = target.dataset.menu; if (next === 'back') { handleBack(); return; } if (next === 'controls') { openControls(); return; } setView(next === 'solo' ? 'solo' : 'home'); return; }
    if (target.dataset.soloMode) { soloMode = target.dataset.soloMode as SoloMode; redraw(); return; }
    if (target.dataset.route) { void selectValue('route', target.dataset.route, state).catch(() => {}); return; }
    if (target.dataset.lighting) { void selectValue('lighting', target.dataset.lighting, state).catch(() => {}); return; }
    if (target.dataset.ctab) { options.remap?.cancel(); controlsTab = target.dataset.ctab as ControlsTab; remapMessage = ''; redraw(); return; }
    if (target.dataset.touchSteerSet) { options.onTouchSteerMode?.(target.dataset.touchSteerSet === 'drag' ? 'drag' : 'buttons'); redraw(); return; }
    if (target.dataset.event) { const selectedEvent = EVENTS.find(item => item.routeId === state.selection.route && item.mode === target.dataset.event); if (selectedEvent) void coordinator.beginEvent({ mode: selectedEvent.mode, rulesVersion: selectedEvent.rulesVersion }).then(() => options.onDriveFocus?.()).catch(() => {}); return; }
    if (target.dataset.remap) { const action = target.dataset.remap as KeyboardAction; if (options.remap?.pending() === action) { options.remap.cancel(); return; } options.onBeginKeyboardRemap?.(action); remapMessage = ''; announce(`Press a key for ${ACTION_LABELS[action] ?? action}. Escape cancels.`); redraw(); return; }
    if (target.dataset.gamepadRemap) { const action = target.dataset.gamepadRemap as GamepadBindingAction; if (options.remap?.pending() === action) { options.remap.cancel(); return; } options.onBeginGamepadRemap?.(action); remapMessage = ''; announce('Press a gamepad control.'); redraw(); return; }
    if (target.dataset.action === 'reset-bindings') { options.remap?.cancel(); options.onRestoreDefaultBindings?.(); remapMessage = 'Controls reset to defaults.'; announce(remapMessage); redraw(); return; }
    void activate(target.dataset.action ?? '', state).catch(() => {});
  });
  shell.addEventListener('change', event => { const target = event.target as HTMLInputElement | HTMLSelectElement; if (!current) return;
    if (target.matches('[data-setting]')) { const key = target.dataset.setting!; const value = target instanceof HTMLInputElement && target.type === 'checkbox' ? target.checked : Number(target.value); void coordinator.setSettings({ [key]: value } as never).catch(() => {}); }
    else if (target.matches('[data-touch-steer]')) { options.onTouchSteerMode?.(target.value === 'drag' ? 'drag' : 'buttons'); lastOverlayMarkup = ''; draw(current); }
    else if (target.matches('[data-select]')) void selectValue(target.dataset.select!, target.value, current).catch(() => {});
    else if (target.matches('[data-assist]') && isAssistLevel(target.value)) void coordinator.setSettings({ assistLevel: target.value }).catch(() => {});
  });
  shell.addEventListener('input', event => {
    const target = event.target;
    if (!(target instanceof HTMLInputElement) || target.type !== 'range') return;
    const output = target.closest('label')?.querySelector('output');
    if (!output) return;
    target.style.setProperty('--v', pct(Number(target.value), Number(target.min), Number(target.max)));
    if (target.dataset.setting === 'cameraFovDeg') output.textContent = `${target.value}°`;
    else if (target.dataset.setting) output.textContent = target.dataset.setting === 'engineVolume' && Number(target.value) <= 0 ? 'Off' : `${Math.round(Number(target.value) * 100)}%`;
    if (target.hasAttribute('aria-valuetext')) target.setAttribute('aria-valuetext', output.textContent ?? '');
  });
  const detach = coordinator.subscribe(state => {
    current = state;
    const now = performance.now();
    if (now - lastHudUpdate >= 32) { lastHudUpdate = now; updateHud(state); }
    if (now - lastRender >= 120) { draw(state); lastRender = now; }
    else { window.clearTimeout(timer); timer = window.setTimeout(() => { if (current) { draw(current); lastRender = performance.now(); } }, 120 - (now - lastRender)); }
  });

  const remapLabelOf = (action: string): string => action in ACTION_LABELS ? ACTION_LABELS[action as KeyboardAction] : action === 'steerAxis' ? 'Steer' : ACTION_LABELS[GAMEPAD_ACTION_KEY[action as GamepadBindingAction] as KeyboardAction] ?? action;
  const detachRemap = options.remap?.subscribe(event => {
    remapMessage = event.status === 'refused' ? `${event.message ?? 'That control is not available'}. Try another.` : event.status === 'cancelled' ? '' : event.movedFrom ? `${remapLabelOf(event.action)} set. Taken from ${remapLabelOf(event.movedFrom)}.` : `${remapLabelOf(event.action)} set.`;
    if (remapMessage) announce(remapMessage);
    window.setTimeout(redraw, 30);
  });
  // Balance, online count and profile change outside coordinator state: refresh menus once a second (string diffed, so cheap).
  const menuPoll = window.setInterval(() => { if (current && current.screen !== 'drive') draw(current); }, 1000);
  function redraw(): void { lastOverlayMarkup = null; if (current) draw(current); }
  function setView(next: MenuView): void {
    if (next === menuView) return;
    window.clearTimeout(viewTimer);
    const root = overlay.querySelector('.lt-root');
    const apply = (): void => { menuView = next; if (next !== 'controls') options.remap?.cancel(); redraw(); focusPrimary(); };
    if (!root || current?.settings.reducedMotion || shell.dataset.reducedMotion === 'true') { apply(); return; }
    root.classList.add('lt-out'); viewTimer = window.setTimeout(apply, 170);
  }
  function focusPrimary(): void {
    if (options.activeDevice?.() === 'touch') return;
    overlay.querySelector<HTMLElement>('.lt-play:not(:disabled),.lt-solo,.lt-start:not(:disabled),.lt-resume,.cp-tab[aria-selected=true],.lp-primary,.lp-panel [data-action=back],.lp-panel button')?.focus({ preventScroll: true });
  }
  function openControls(): void {
    const state = current; if (!state) return;
    controlsReturn = state.screen === 'settings' ? 'settings' : 'menu';
    if (state.screen !== 'pause') { try { coordinator.open('pause'); } catch { return; } }
    const device = options.activeDevice?.() ?? 'keyboard';
    controlsTab ??= device === 'gamepad' ? 'gamepad' : device === 'touch' ? 'touch' : 'keyboard';
    remapMessage = ''; setView('controls');
  }
  function handleBack(): boolean {
    const state = current; if (!state) return false;
    if (options.online?.isOpen?.()) { options.online.close?.(); return true; }
    if (options.remap?.pending()) { options.remap.cancel(); return true; }
    if (state.screen === 'settings' || state.screen === 'garage') { try { coordinator.open('pause'); } catch { /* busy */ } return true; }
    // Replay and photo mode step back to where they were opened from (results or the menu); results step back to the menu.
    if (state.screen === 'replay' || state.screen === 'photo') { try { coordinator.leavePresentation(); } catch { /* busy */ } return true; }
    if (state.screen === 'results') { try { coordinator.open('pause'); } catch { /* busy */ } return true; }
    if (state.screen !== 'pause') return false;
    if (menuView === 'controls') { if (controlsReturn === 'settings') { menuView = 'home'; try { coordinator.open('settings'); } catch { /* busy */ } } else setView('home'); return true; }
    if (menuView === 'solo') { setView('home'); return true; }
    return !hasDriven;
  }
  function menuContext(state: ExperienceState): MenuContext {
    const online = options.online?.status?.() ?? (options.online?.available() ? 'ready' : 'off');
    return {
      paused: hasDriven, view: menuView, soloMode, device: options.activeDevice?.() ?? 'keyboard', route: state.selection.route,
      routes: getRoutes(state, options), lighting: state.selection.lighting, carName: carNames[state.selection.car] ?? state.selection.car,
      runMode: state.runtime.mode, rivalAvailable: state.rivalAvailable, profile: options.profile?.() ?? null,
      balance: options.shop?.available() ? options.shop.balance() : '', shop: options.shop?.available() ?? false, gift: options.shop?.available() ? options.shop.gift?.() ?? null : null, inbox: options.shop?.available() ? options.shop.inbox?.() ?? 0 : 0, missions: options.missions?.available() ?? false, features: options.features?.menu() ?? null,
      online, onlineCount: online === 'ready' ? options.online?.count() ?? 0 : 0, busy: state.busy, lessonReplay: tutorialReplayAvailable(state), logo: LOGO_MARK,
    };
  }
  function pauseMarkup(state: ExperienceState): string {
    return renderMainMenu(menuContext(state), () => {
      const device = options.activeDevice?.() ?? 'keyboard';
      return renderControlsPage({
        tab: controlsTab ?? (device === 'gamepad' ? 'gamepad' : device === 'touch' ? 'touch' : 'keyboard'),
        keyboard: options.keyboardBindings?.() ?? null, gamepad: options.gamepadBindings?.() ?? null, mapping: options.gamepadMapping?.() ?? null,
        pending: options.remap?.pending() ?? null, message: remapMessage, touchSteer: options.onTouchSteerMode ? options.touchSteerMode?.() ?? 'buttons' : null,
      });
    });
  }

  function draw(state: ExperienceState): void {
    if (disposed) return;
    if (state.screen === 'drive') { hasDriven = true; if (menuView !== 'home') { menuView = 'home'; options.remap?.cancel(); } }
    const nextMenuMode = state.screen === 'drive' || state.screen === 'replay' || state.screen === 'photo' || state.screen === 'results' ? null : hasDriven ? 'pause' : 'title';
    if (nextMenuMode !== menuMode) { menuMode = nextMenuMode; options.onMenuMode?.(menuMode); }
    if (state.screen === 'pause') shell.dataset.menu = menuView === 'home' ? (hasDriven ? 'pause' : 'title') : menuView; else delete shell.dataset.menu;
    const quality = options.quality?.(); if (quality && shell.dataset.quality !== quality) shell.dataset.quality = quality;
    const runtime = state.runtime, view = runtime.frame.current;
    const now = performance.now();
    shell.style.setProperty('--lp-scale', String(state.settings.uiScale));
    shell.dataset.reducedMotion = String(state.settings.reducedMotion);
    shell.dataset.screen = state.screen;
    document.documentElement.dataset.lateralScreen = state.screen;
    updateHud(state); lastHudUpdate = now;
    const driveControls = `<button class="lp-icon" data-action="pause" aria-label="Pause game">${ICON_PAUSE}</button><button class="lp-icon" data-action="camera" aria-label="Change camera view">${ICON_CAMERA}Camera</button>`;
    const desiredControls = state.screen === 'drive' ? driveControls : '';
    if (hudControls.dataset.markup !== desiredControls) { hudControls.innerHTML = desiredControls; hudControls.dataset.markup = desiredControls; }
    const device = options.activeDevice?.() ?? 'keyboard';
    const hintText = deviceHint(device, options);
    if (inputHintText.textContent !== hintText) inputHintText.innerHTML = hintMarkup(hintText);
    if (state.screen === 'drive' && !wasDriving) lastInputHintChange = now;
    wasDriving = state.screen === 'drive';
    if (inputHint.dataset.device !== device) { inputHint.dataset.device = device; lastInputHintChange = now; }
    const hintAge = Math.max(0, now - lastInputHintChange);
    inputHint.hidden = state.screen !== 'drive' || tutorialDismissed;
    if (!assistHintShownAt && state.screen === 'drive' && !state.settings.assistHintSeen && state.settings.assistLevel !== 'off') {
      assistHintShownAt = now; assistHint.hidden = false;
      void coordinator.setSettings({ assistHintSeen: true }).catch(() => {});
    }
    if (assistHintShownAt && !assistHint.hidden) {
      const age = now - assistHintShownAt;
      assistHint.style.opacity = String(Math.max(0, 1 - Math.max(0, age - 6000) / 1500));
      if (age > 7500 || state.screen !== 'drive') assistHint.hidden = true;
    }
    const hintOpacity = Math.max(0, 1 - Math.max(0, hintAge - 3500) / 2500);
    inputHint.style.opacity = String(hintOpacity);
    inputHint.style.pointerEvents = inputHint.hidden || hintOpacity === 0 ? 'none' : 'auto';
    routeGuide.hidden = state.screen !== 'drive' && state.screen !== 'replay';
    if (!routeGuide.hidden) {
      const nextCheckpoint = runtime.run?.expectedCheckpointId ?? null;
      routeGuide.setAttribute('aria-label', `${runtime.route.name} route guide${nextCheckpoint ? `, next checkpoint ${nextCheckpoint}` : ''}`);
      // The route outline only changes with the route or the next gate; between those, move just the car marker.
      const guideKey = `${runtime.route.id}|${nextCheckpoint ?? ''}`;
      if (routeGuide.dataset.key !== guideKey || !updateRouteGuideMarker(routeGuide, runtime.route, view)) {
        routeGuide.innerHTML = renderRouteGuide(runtime.route, view, nextCheckpoint);
        routeGuide.dataset.key = guideKey;
      }
    }
    const tutorial = state.tutorial;
    const tutorialKey = `${tutorial.status}:${tutorial.step ?? ''}`;
    if (tutorialKey !== lastTutorialKey) { lastTutorialKey = tutorialKey; tutorialCardDismissed = false; }
    // Lesson cards belong to free drive only: never over an event or an online race.
    const tutorialMarkup = state.screen !== 'drive' || tutorialCardDismissed || runtime.mode !== 'free-drive' ? '' : tutorial.status === 'active' && tutorial.step
      ? renderTutorialCard(tutorial.step, device, options)
      : tutorial.status === 'completed' || tutorial.status === 'skipped'
        ? renderTutorialCompletion(tutorial.status) : '';
    if (tutorialPanel.dataset.markup !== tutorialMarkup) {
      const focusedAction = tutorialPanel.contains(document.activeElement) ? (document.activeElement as HTMLElement).dataset.action : undefined;
      tutorialPanel.innerHTML = tutorialMarkup; tutorialPanel.dataset.markup = tutorialMarkup;
      if (focusedAction) {
        const replacement = tutorialPanel.querySelector<HTMLElement>(`[data-action="${CSS.escape(focusedAction)}"]`) ?? tutorialPanel.querySelector<HTMLElement>('button');
        replacement?.focus({ preventScroll: true });
      }
    }
    const lessonProgress = tutorialPanel.querySelector<HTMLProgressElement>('progress[aria-label="Measured lesson progress"]');
    if (lessonProgress) lessonProgress.value = Math.max(0, Math.min(1, tutorial.progress));
    const nextOverlay = framePanel(renderScreen(state, options, () => pauseMarkup(state)));
    const screenKey = state.screen === 'pause' ? `pause:${shell.dataset.menu ?? ''}` : state.screen;
    if (lastOverlayMarkup !== nextOverlay) {
      const focused = overlay.contains(document.activeElement) ? (document.activeElement as HTMLElement).dataset.focusKey : undefined;
      // Same screen re-rendering (a slider moved, a chip toggled): keep scroll and skip the entrance animation.
      const sameScreen = lastOverlayScreen === screenKey;
      const scrollTop = sameScreen ? overlay.querySelector<HTMLElement>('.lp-scroll')?.scrollTop ?? 0 : 0;
      overlay.classList.toggle('lp-still', sameScreen);
      overlay.innerHTML = nextOverlay; lastOverlayMarkup = nextOverlay; lastOverlayScreen = screenKey;
      if (!sameScreen && state.screen === 'results') countUp(overlay, state.settings.reducedMotion === true);
      if (scrollTop) { const panel = overlay.querySelector<HTMLElement>('.lp-scroll'); if (panel) panel.scrollTop = scrollTop; }
      if (focused) overlay.querySelector<HTMLElement>(`[data-focus-key="${CSS.escape(focused)}"]`)?.focus({ preventScroll: true });
      // A screen change that dropped focus on the page body (Esc out of Settings) leaves arrows and Enter dead: refocus.
      if (!sameScreen && state.screen !== 'drive' && (!document.activeElement || document.activeElement === document.body)) focusPrimary();
    }
    errorBox.textContent = state.error ?? '';
    storageWarning.textContent = state.persistence.state === 'session-only' ? (state.persistence.warning ?? 'Changes are temporary and will be lost when this session ends.') : '';
  }

  async function activate(action: string, state: ExperienceState): Promise<void> {
    try {
      if (action === 'drive') { await coordinator.drive(); options.onDriveFocus?.(); }
      else if (action === 'pause') coordinator.open('pause');
      else if (action === 'garage') { if (options.garage) options.garage.open(); else coordinator.open('garage'); }
      else if (action === 'missions') options.missions?.open();
      else if (action === 'settings') coordinator.open('settings');
      else if (action === 'online') options.online?.open();
      else if (action === 'main-menu') { hasDriven = false; menuView = 'home'; coordinator.freeDrive(); }
      else if (action === 'solo-start') {
        const modes = availableSoloModes(state.selection.route, state.rivalAvailable), mode = modes.includes(soloMode) ? soloMode : modes[0]!;
        if (mode === 'free-drive') { coordinator.freeDrive(); await coordinator.drive(); options.onDriveFocus?.(); }
        else { const selected = EVENTS.find(item => item.routeId === state.selection.route && item.mode === mode); if (selected) { await coordinator.beginEvent({ mode: selected.mode, rulesVersion: selected.rulesVersion }); options.onDriveFocus?.(); } }
      }
      else if (action === 'shop') options.shop?.open();
      else if (action === 'gift') options.shop?.openGift?.();
      else if (action === 'inbox') options.shop?.openInbox?.();
      else if (action === 'events') setView('solo');
      else if (action === 'free-drive') { coordinator.freeDrive(); await coordinator.drive(); options.onDriveFocus?.(); }
      else if (action === 'replay') coordinator.replay();
      else if (action === 'photo') coordinator.photo();
      else if (action === 'screenshot') { const blob = await coordinator.screenshot(); const url = URL.createObjectURL(blob); const link = document.createElement('a'); link.href = url; link.download = 'lateral-photo.png'; link.click(); URL.revokeObjectURL(url); }
      else if (action.startsWith('feat-')) options.features?.open(action.slice(5));
      else if (action === 'profile' && __OWNER_REVIEW__) await coordinator.switchProfile(state.profile === 'career' ? 'sandbox' : 'career');
      else if (action === 'retry') { await coordinator.retry(); options.onDriveFocus?.(); }
      else if (action === 'return-drive') { await coordinator.drive(); options.onDriveFocus?.(); }
      else if (action === 'camera') options.onCameraCycle?.();
      else if (action === 'tutorial-dismiss') { tutorialDismissed = true; if (current) draw(current); }
      else if (action === 'skip-tutorial') await coordinator.skipTutorial();
      else if (action === 'replay-tutorial') { await coordinator.startTutorial(); options.onDriveFocus?.(); }
      else if (action === 'dismiss-tutorial-card') { tutorialCardDismissed = true; if (current) draw(current); }
      else if (action === 'back') { if (state.screen === 'settings' || state.screen === 'garage') coordinator.open('pause'); else { await coordinator.drive(); options.onDriveFocus?.(); } }
    } catch { /* Coordinator publishes recoverable errors in ExperienceState. */ }
  }

  async function selectValue(kind: string, value: string, state: ExperienceState): Promise<void> {
    try {
      if (kind === 'car') await coordinator.selectCar(value as CarId);
      else if (kind === 'route') await coordinator.selectRoute(value as RouteId);
      else if (kind === 'tune') await coordinator.selectTune(value as TunePresetId);
      else if (kind === 'lighting') await coordinator.setPresentation(value as LightingPreset, state.selection.quality);
      else if (kind === 'quality') await coordinator.setPresentation(state.selection.lighting, value as QualitySelection);
    } catch { /* Error is shown from coordinator state. */ }
  }

  function announce(message: string): void { const live = shell.querySelector<HTMLElement>('.lp-live'); if (live) live.textContent = message; }
  function handleMenuAction(action: GamepadMenuAction): void {
    const state = current; if (!state) return;
    shell.dataset.nav = 'pad';
    if (action === 'back') { if (!handleBack()) void activate('back', state); return; }
    // The topmost open layer gets navigation: the online lobby when it is up, otherwise the menu overlay.
    const layer = [...shell.querySelectorAll<HTMLElement>('.lp-net:not([hidden]),.lp-net-card:not([hidden])')][0] ?? overlay;
    const items = [...layer.querySelectorAll<HTMLElement>('button:not(:disabled),select:not(:disabled),input:not(:disabled),[tabindex="0"]')].filter(node => node.offsetParent !== null || getComputedStyle(node).position === 'fixed');
    if (!items.length) return;
    const active = document.activeElement as HTMLElement;
    const index = items.indexOf(active);
    if (action === 'accept') {
      if (index < 0) { (layer.querySelector<HTMLElement>('.lt-play:not(:disabled),.lt-start:not(:disabled),.lt-resume,.lp-net-go,.lp-primary') ?? items[0]!).focus(); return; }
      const item = items[index]!; item.focus(); if (item instanceof HTMLButtonElement) item.click(); return;
    }
    const focused = items[index];
    if ((action === 'left' || action === 'right') && focused) {
      if (focused instanceof HTMLSelectElement) { focused.selectedIndex = Math.max(0, Math.min(focused.options.length - 1, focused.selectedIndex + (action === 'right' ? 1 : -1))); focused.dispatchEvent(new Event('change', { bubbles: true })); return; }
      if (focused instanceof HTMLInputElement && focused.type === 'range') { const step = Number(focused.step) || .05; focused.value = String(Math.max(Number(focused.min), Math.min(Number(focused.max), Number(focused.value) + step * (action === 'right' ? 1 : -1)))); focused.dispatchEvent(new Event('change', { bubbles: true })); return; }
    }
    if (!focused) { (layer.querySelector<HTMLElement>('.lt-play:not(:disabled),.lt-start:not(:disabled),.lt-resume,.lp-net-go') ?? items[0]!).focus({ preventScroll: false }); return; }
    const next = spatialNext(items, focused, action);
    if (next) { next.focus({ preventScroll: true }); next.scrollIntoView({ block: 'nearest', inline: 'nearest' }); }
  }
  shell.addEventListener('pointerdown', () => { shell.dataset.nav = 'pointer'; });
  detachSlots = mountHudSlots(shell);
  return { announce, handleMenuAction, handleBack, openControls, dispose() { disposed = true; detach(); detachSlots(); detachRemap?.(); clearInterval(menuPoll); clearTimeout(viewTimer); clearTimeout(timer); shell.remove(); style.remove(); document.removeEventListener('gesturestart', blockGesture); delete document.documentElement.dataset.lateralScreen; } };
}


/** Nearest focusable in a direction, by on-screen geometry (works for lists, tile rows and grids). */
function spatialNext(items: readonly HTMLElement[], from: HTMLElement, direction: 'up' | 'down' | 'left' | 'right'): HTMLElement | null {
  const a = from.getBoundingClientRect(), ax = a.left + a.width / 2, ay = a.top + a.height / 2;
  let best: HTMLElement | null = null, bestScore = Infinity;
  for (const item of items) {
    if (item === from) continue;
    const b = item.getBoundingClientRect(), bx = b.left + b.width / 2, by = b.top + b.height / 2, dx = bx - ax, dy = by - ay;
    const along = direction === 'down' ? dy : direction === 'up' ? -dy : direction === 'right' ? dx : -dx;
    const across = direction === 'down' || direction === 'up' ? Math.abs(dx) : Math.abs(dy);
    if (along <= 4) continue;
    const score = along + across * 2.2;
    if (score < bestScore) { bestScore = score; best = item; }
  }
  if (best || direction === 'left' || direction === 'right') return best;
  // Wrap vertically: from the bottom go to the top item (and back).
  const sorted = [...items].sort((x, y) => x.getBoundingClientRect().top - y.getBoundingClientRect().top);
  return direction === 'down' ? sorted[0] ?? null : sorted[sorted.length - 1] ?? null;
}

function renderScreen(state: ExperienceState, options: PlayerUIOptions, pauseMarkup: () => string): string {
  if (state.screen === 'drive') return `<div class="lp-driving-tools"><button data-action="garage">Garage</button><button data-action="settings">Settings</button></div>`;
  if (state.screen === 'replay' || state.screen === 'photo') return `<section class="lp-panel lp-presentation" aria-label="${state.screen === 'replay' ? 'Replay controls' : 'Photo mode'}"><h2>${state.screen === 'replay' ? 'Replay' : 'Photo mode'}</h2>${state.screen === 'replay' ? `<label>Replay position <progress max="1" value="${state.runtime.replayProgress}">${Math.round(state.runtime.replayProgress * 100)}%</progress></label>` : ''}<div class="lp-actions">${state.screen === 'photo' ? '<button data-action="screenshot">Save photo</button>' : ''}<button data-action="return-drive">Return to drive</button><button data-action="garage">Garage</button></div></section>`;
  if (state.screen === 'settings') return renderSettings(state);
  // The garage is the full-screen showroom (src/showroom), opened through ShopFeature.openGarage(); nothing renders here.
  if (state.screen === 'garage') return '';
  if (state.screen === 'results') { const result = state.runtime.result; const status = state.runtime.run; const invalid = result?.valid === false || Boolean(status?.invalidReason); const medal = result?.medal ?? 'none'; const grade = GRADES[medal] ?? '-'; return `<section class="lp-panel lp-side lp-results" aria-label="Event results" role="${invalid ? 'alert' : 'region'}"><header><div><p class="lp-kicker">${esc(MODE_LABELS[result?.mode ?? ''] ?? 'Event')} · ${esc(result?.routeId ?? state.selection.route)}</p><h2>${invalid ? 'Run not recorded' : 'Run complete'}</h2></div></header>${invalid ? `<p class="lp-invalid">${invalidText(status?.invalidReason ?? 'shortcut')}. This score does not count toward your results.</p>` : `<div class="lp-board"><div class="lp-result-score"><span data-count="${result?.bankedScore ?? 0}">${(result?.bankedScore ?? 0).toLocaleString('en-US')}</span><small>points</small></div><div class="lp-grade" data-grade="${grade}" role="img" aria-label="Grade ${grade === '-' ? 'not awarded' : grade}"><span aria-hidden="true">${grade === '-' ? '–' : grade}</span><small aria-hidden="true">Grade</small></div></div><dl class="lp-board-rows"><div><dt>Time</dt><dd><span data-count="${(result?.elapsedActiveSeconds ?? 0).toFixed(1)}" data-decimals="1">${result?.elapsedActiveSeconds.toFixed(1) ?? '0.0'}</span><small>s</small></dd></div><div><dt>Medal</dt><dd data-medal="${medal}">${medal === 'none' ? 'Unranked' : MEDAL_NAMES[medal]}</dd></div>${state.runtime.medalTargets && result ? `<div><dt>Targets</dt><dd class="lp-medal-targets">${renderMedalTargets(result.mode, state.runtime.medalTargets)}</dd></div>` : ''}</dl>`}<div class="lp-actions"><button class="lp-primary" data-action="retry">Race again</button><button data-action="replay">Watch replay</button><button data-action="photo">Photo mode</button><button data-action="garage">Garage</button></div></section>`; }
  if (state.screen === 'pause') return pauseMarkup();
  return '';
}

/** "Seven Bends · Ridge Pass": route name with its location. */
function getRoutes(state: ExperienceState, options: PlayerUIOptions): readonly RouteDefinition[] {
  return options.routes?.length ? options.routes : [state.runtime.route];
}
function deviceHint(device: InputDevice, options: PlayerUIOptions): string {
  if (device === 'gamepad') {
    const pad = options.gamepadBindings?.();
    const mapping = options.gamepadMapping?.() ?? null;
    const steer = pad ? gamepadAxisLabel(pad.steerAxis, mapping) : 'gamepad steering axis';
    const throttle = pad ? gamepadButtonLabel(pad.throttleButton, mapping) : 'gamepad throttle';
    const handbrake = pad ? gamepadButtonLabel(pad.handbrakeButton, mapping) : 'gamepad handbrake';
    return `${steer}: steer · ${throttle}: accelerate · ${handbrake}: handbrake`;
  }
  if (device === 'touch') return 'Hold Gas · use ← / → to steer · Handbrake to slide';
  if (device === 'keyboard') return 'WASD or arrows: drive · Space: handbrake · Esc: pause';
  return 'Choose a control to start driving';
}
export function tutorialTitle(step: ExperienceState['tutorial']['step']): string {
  return step === 'accelerate' ? '1 · Get moving' : step === 'turn' ? '2 · Find a turn' : step === 'handbrake' ? '3 · Try the handbrake' : step === 'countersteer' ? '4 · Try countersteering' : 'Driving lesson';
}
export function tutorialInstruction(step: ExperienceState['tutorial']['step'], device: InputDevice, options: PlayerUIOptions): string {
  const keyboard = options.keyboardBindings?.(), pad = options.gamepadBindings?.(), mapping = options.gamepadMapping?.() ?? null;
  if (step === 'accelerate') return device === 'touch' ? 'Hold Gas until the car is moving.' : device === 'gamepad' ? `Hold ${pad ? gamepadButtonLabel(pad.throttleButton, mapping) : 'gamepad throttle'} until the car is moving.` : `Hold ${keyboard ? keyboard.throttle.map(keyName).join(' / ') : 'accelerate'} until the car is moving.`;
  if (step === 'turn') return device === 'touch' ? 'While moving, hold ← or → through a turn.' : device === 'gamepad' ? `While moving, steer with ${pad ? gamepadAxisLabel(pad.steerAxis, mapping) : 'the gamepad steering axis'}.` : `While moving, steer with ${keyboard ? `${keyboard.steerLeft.map(keyName).join('/')} and ${keyboard.steerRight.map(keyName).join('/')}` : 'left/right'} through a turn.`;
  if (step === 'handbrake') return device === 'touch' ? 'While moving, press Handbrake to try it.' : device === 'gamepad' ? `While moving, press ${pad ? gamepadButtonLabel(pad.handbrakeButton, mapping) : 'gamepad handbrake'} to try it.` : `While moving, press ${keyboard ? keyboard.handbrake.map(keyName).join(' / ') : 'the handbrake control'} to try it.`;
  if (step === 'countersteer') return 'During a slide, try steering against its direction.';
  return '';
}
export function gamepadButtonLabel(button: number, mapping: string | null = null): string {
  if (mapping !== 'standard') return `gamepad button ${button}`;
  const labels: Readonly<Record<number, string>> = { 0:'A / Cross', 1:'B / Circle', 2:'X / Square', 3:'Y / Triangle', 4:'Left bumper', 5:'Right bumper', 6:'Left trigger', 7:'Right trigger', 8:'View / Share', 9:'Menu / Options' };
  return labels[button] ?? `gamepad button ${button}`;
}
export function gamepadAxisLabel(axis: number, mapping: string | null = null): string {
  if (mapping === 'standard' && axis === 0) return 'left stick';
  if (mapping === 'standard' && axis === 2) return 'right stick';
  return `axis ${axis}`;
}
export function renderTutorialCard(step: NonNullable<ExperienceState['tutorial']['step']>, device: InputDevice, options: PlayerUIOptions): string {
  const title = tutorialTitle(step);
  const attemptNote = step === 'handbrake' || step === 'countersteer' ? '<small>Practice only. No score.</small>' : '';
  return `<section class="lp-tutorial-card" aria-label="Driving lesson"><strong>${title}</strong><p>${tutorialInstruction(step, device, options)}</p><progress max="1" value="0" aria-label="Measured lesson progress"></progress>${attemptNote}<button data-focus-key="tutorial-skip" data-action="skip-tutorial">Skip</button></section>`;
}
export function renderTutorialCompletion(status: 'completed' | 'skipped'): string {
  return `<section class="lp-tutorial-card" aria-label="Driving lesson"><strong>${status === 'completed' ? 'Lesson complete' : 'Lesson skipped'}</strong><p>${status === 'completed' ? 'You have the basics. Go find a line.' : 'Practice is ready when you are.'}</p><button data-focus-key="tutorial-replay" data-action="replay-tutorial">Replay lesson</button><button data-focus-key="tutorial-dismiss-card" data-action="dismiss-tutorial-card">Dismiss</button></section>`;
}
function keyName(code: string): string { if (code === 'Space') return 'Space'; if (code.startsWith('Arrow')) return code.slice(5); if (code.startsWith('Key')) return code.slice(3); if (code.startsWith('Digit')) return code.slice(5); return code; }
interface RouteGuideFrame { readonly scale: number; readonly centerX: number; readonly centerZ: number; readonly path: string }
const routeGuideFrames = new WeakMap<RouteDefinition, RouteGuideFrame>();
function routeGuideFrame(route: RouteDefinition): RouteGuideFrame {
  const cached = routeGuideFrames.get(route);
  if (cached) return cached;
  const points = route.centerline;
  const minX = Math.min(...points.map(point => point.x)), maxX = Math.max(...points.map(point => point.x));
  const minZ = Math.min(...points.map(point => point.z)), maxZ = Math.max(...points.map(point => point.z));
  const span = Math.max(maxX - minX, maxZ - minZ, 1);
  const scale = 80 / span, centerX = (minX + maxX) / 2, centerZ = (minZ + maxZ) / 2;
  const path = points.map((point, index) => `${index === 0 ? 'M' : 'L'}${(50 + (point.x - centerX) * scale).toFixed(1)},${(50 + (point.z - centerZ) * scale).toFixed(1)}`).join(' ') + (route.closed ? ' Z' : '');
  const frame = { scale, centerX, centerZ, path };
  routeGuideFrames.set(route, frame);
  return frame;
}
function routeGuideMarker(route: RouteDefinition, view: ExperienceState['runtime']['frame']['current']): { x: string; y: string; noseX: string; noseY: string } {
  const { scale, centerX, centerZ } = routeGuideFrame(route);
  const x = 50 + (view.position.x - centerX) * scale, y = 50 + (view.position.z - centerZ) * scale;
  const rotation = view.rotation;
  const yaw = Math.atan2(2 * (rotation.w * rotation.y + rotation.x * rotation.z), 1 - 2 * (rotation.y * rotation.y + rotation.x * rotation.x));
  return { x: x.toFixed(1), y: y.toFixed(1), noseX: (x - Math.sin(yaw) * 5).toFixed(1), noseY: (y - Math.cos(yaw) * 5).toFixed(1) };
}
/** Moves the car marker of an already rendered guide in place; false when there is no marker to move. */
function updateRouteGuideMarker(guide: HTMLElement, route: RouteDefinition, view: ExperienceState['runtime']['frame']['current']): boolean {
  const nose = guide.querySelector<SVGPathElement>('.lp-route-nose'), car = guide.querySelector<SVGCircleElement>('.lp-route-car');
  if (!nose || !car) return false;
  const marker = routeGuideMarker(route, view);
  const d = `M${marker.x},${marker.y} L${marker.noseX},${marker.noseY}`;
  if (nose.getAttribute('d') !== d) {
    nose.setAttribute('d', d);
    car.setAttribute('cx', marker.x);
    car.setAttribute('cy', marker.y);
  }
  return true;
}
function renderRouteGuide(route: RouteDefinition, view: ExperienceState['runtime']['frame']['current'], expectedCheckpointId: string | null): string {
  const points = route.centerline;
  if (points.length < 2) return `<span>${esc(route.id)} · route guide unavailable</span>`;
  const { scale, centerX, centerZ, path } = routeGuideFrame(route);
  const project = (point: { x: number; z: number }) => ({ x: 50 + (point.x - centerX) * scale, y: 50 + (point.z - centerZ) * scale });
  const gates = route.checkpoints.map(checkpoint => { const point = project(checkpoint.center); const active = checkpoint.id === expectedCheckpointId; return `<circle cx="${point.x.toFixed(1)}" cy="${point.y.toFixed(1)}" r="${active ? 3.2 : 1.6}" fill="${active ? '#ff8a1f' : '#5fb3aa'}"/>`; }).join('');
  const marker = routeGuideMarker(route, view);
  const targetLabel = expectedCheckpointId ? ` · next ${esc(expectedCheckpointId)}` : '';
  return `<svg viewBox="0 0 100 100" role="presentation" aria-hidden="true"><title>${esc(route.name)} route guide${targetLabel}</title><path d="${path}" fill="none" stroke="#0b1214" stroke-opacity=".85" stroke-width="10" stroke-linecap="round" stroke-linejoin="round"/><path d="${path}" fill="none" stroke="#cfe9e4" stroke-opacity=".9" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"/>${gates}<path class="lp-route-nose" d="M${marker.x},${marker.y} L${marker.noseX},${marker.noseY}" stroke="#d8fa72" stroke-width="2.4" stroke-linecap="round"/><circle class="lp-route-car" cx="${marker.x}" cy="${marker.y}" r="3.2" fill="#d8fa72" stroke="#0b1214" stroke-width="1.5"/></svg><span class="lp-route-label">${esc(route.id)}</span>`;
}
/** Low, Balanced, High, Ultra and Auto, shared by the garage and Settings. */
function graphicsOptions(current: QualitySelection): string {
  return (['low','balanced','high','ultra','auto'] as const satisfies readonly QualitySelection[]).map(v => option(v, v === 'auto' ? 'Auto' : v[0]!.toUpperCase()+v.slice(1), current)).join('');
}
function renderSettings(state: ExperienceState): string {
  return `<section class="lp-panel lp-side" aria-label="Settings"><header><h2>Settings</h2><button data-action="back">Back</button></header>${tutorialReplayAvailable(state) ? '<button class="lp-secondary" data-action="replay-tutorial">Replay lesson</button>' : ''}<div class="lp-settings">${renderAssistSetting(state.settings.assistLevel)}<h3>Sound</h3>${slider('masterVolume','Master volume',state.settings.masterVolume)}${slider('musicVolume','Music volume',state.settings.musicVolume)}${slider('sfxVolume','Sound effects',state.settings.sfxVolume)}${slider('engineVolume','Engine sound',state.settings.engineVolume ?? 0.45,true)}${check('muted','Mute sound',state.settings.muted)}<h3>Comfort and display</h3><label>Graphics<select data-focus-key="settings-quality" data-select="quality">${graphicsOptions(state.selection.quality)}</select></label>${check('reducedMotion','Reduced motion',state.settings.reducedMotion)}${renderCameraSettings(state.settings)}${check('ghostVisible','Show rival ghost',state.settings.ghostVisible)}<label>Interface size <input data-focus-key="uiscale" data-setting="uiScale" style="--v:${pct(state.settings.uiScale, .8, 1.5)}" type="range" min="0.8" max="1.5" step="0.05" value="${state.settings.uiScale}"><output>${Math.round(state.settings.uiScale * 100)}%</output></label><h3>Controls</h3><p>Keys, gamepad, touch layout and a quick drift guide.</p><button class="lp-secondary" data-menu="controls" data-focus-key="open-controls">Open controls</button><p class="lp-local-only">${state.persistence.state === 'persistent' ? 'Progress and settings are stored on this device.' : esc(state.persistence.warning ?? 'Changes are temporary and will be lost when this session ends.')}</p></div></section>`;
}
const MEDAL_NAMES = { gold: 'Gold', silver: 'Silver', bronze: 'Bronze' } as const;
function formatMedalTarget(mode: string, value: number): string {
  return medalModeOf(mode as never) === 'time-trial' ? `${value.toFixed(1)}s` : value.toLocaleString('en-US');
}
function renderMedalTargets(mode: string, targets: MedalTargets): string {
  return (['gold', 'silver', 'bronze'] as const).map(medal => `<span data-medal="${medal}">${MEDAL_NAMES[medal]} ${formatMedalTarget(mode, targets[medal])}</span>`).join(' ');
}
export const ASSIST_HINT_TEXT = 'Drift assist on: slides are yours, it only catches a spin. Change it in Settings.';
const ASSIST_DESCRIPTIONS: Readonly<Record<AssistLevel, string>> = {
  medium: 'Drift (recommended). Full steering and throttle, any way into a slide, angles up to about 50 degrees. It only steps in to catch a real spin.',
  high: 'Beginner. Planted and forgiving: catches every slide, calms steering at speed and eases off when you overcook a corner. Pull the handbrake to drift.',
  off: 'Raw physics with no help at all. Leaderboard times show which assist level was used.',
};
export function renderAssistSetting(level: AssistLevel): string {
  return `<h3>Driving</h3><label>Driving assists<select data-focus-key="assist" data-assist>${ASSIST_LEVELS.map(value => option(value, ASSIST_LABELS[value], level)).join('')}</select></label><p class="lp-assist-note">${esc(ASSIST_DESCRIPTIONS[level])}</p>`;
}
export function renderCameraSettings(settings: Pick<ExperienceSettings, 'cameraFovDeg' | 'cameraShakeEnabled' | 'reducedMotion'>): string {
  return `${rangeSetting('cameraFovDeg','Base field of view',settings.cameraFovDeg,50,75,1,'°')}${check('cameraShakeEnabled','Impact camera shake',settings.cameraShakeEnabled)}<p>Reduced motion suppresses speed-based field-of-view widening and impact shake without changing your selected settings.</p>`;
}
function tutorialReplayAvailable(state: ExperienceState): boolean { return state.tutorial.status === 'completed' || state.tutorial.status === 'skipped'; }
function option(value: string, label: string, selected: string, disabled = false): string { return `<option value="${esc(value)}" ${value === selected ? 'selected' : ''} ${disabled ? 'disabled' : ''}>${esc(label)}</option>`; }
/** Volume slider; `offAtZero` labels 0 as Off (the engine slider turns the engine sound fully off there). */
function slider(key: string, label: string, value: number, offAtZero = false): string { const shown = offAtZero && value <= 0 ? 'Off' : `${Math.round(value * 100)}%`; return `<label>${label}<input data-focus-key="${key}" data-setting="${key}" aria-label="${label}" aria-valuetext="${shown}" style="--v:${pct(value, 0, 1)}" type="range" min="0" max="1" step="0.05" value="${value}"><output>${shown}</output></label>`; }
function rangeSetting(key: string, label: string, value: number, min: number, max: number, step: number, unit: string): string { return `<label>${label}<input data-focus-key="${key}" data-setting="${key}" aria-label="${label}" style="--v:${pct(value, min, max)}" type="range" min="${min}" max="${max}" step="${step}" value="${value}"><output aria-live="polite">${value}${unit}</output></label>`; }
function check(key: string, label: string, checked: boolean): string { return `<label class="lp-check"><input data-focus-key="${key}" data-setting="${key}" type="checkbox" ${checked ? 'checked' : ''}>${label}</label>`; }
function invalidText(reason: string): string { return reason === 'wrong-way' ? 'Wrong way' : 'Shortcut detected'; }

export const COMPACT_TUTORIAL_LAYOUT_CSS = '@media(max-width:640px){.lp-tutorial{top:118px;left:8px;max-width:min(232px,37vw);font-size:.76em}.lp-tutorial-card{padding:6px 8px}.lp-tutorial-card p{margin:2px 0}.lp-tutorial-card progress{height:6px;margin:4px 0}.lp-tutorial-card small{font-size:.85em}.lp-tutorial-card button{min-height:30px;margin-top:2px}.lp-route-guide{top:112px;right:8px;width:76px}.lp-icon+[data-action=camera]{top:60px;right:8px}}';
