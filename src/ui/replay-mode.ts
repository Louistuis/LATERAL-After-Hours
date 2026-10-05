/**
 * Replay of the last run with cinematic cameras. The runtime plays the recorded poses (GameRuntime.enterReplayWith);
 * this layer owns the controls (play, pause, scrub, speed, camera) and drives the ReplayDirector. Photo grabs the held
 * frame into photo mode. Letterbox bars and a small telemetry readout (speed and slide angle from the recording).
 */
import type * as THREE from 'three';
import type { Quat, Vec3 } from '../../contracts/runtime-contracts';
import type { GhostTransform } from '../ghosts/recording';
import { ReplayDirector, SHOT_NAMES, type DirectorMode, type RouteLine } from '../camera/replay-director';
import { button, h } from './feature-css';

export interface ReplayControls {
  clock(): { readonly time: number; readonly duration: number; readonly speed: number };
  setSpeed(speed: number): void;
  seek(progress: number): void;
}
export interface ReplayModeDeps {
  readonly camera: THREE.PerspectiveCamera;
  readonly controls: ReplayControls;
  exit(): void;
  /** Opens photo mode on the held frame. */
  photo(): void;
  resetCamera(): void;
  /** Called once per replay when it was watched for a while (achievement). */
  onWatched(): void;
}
export interface ReplayMode {
  readonly active: boolean;
  open(samples: readonly GhostTransform[], route: RouteLine | null, label: string): void;
  close(): void;
  /** Pauses playback and hides the bar (photo mode on the held frame). */
  hold(held: boolean): void;
  cameraOverride(position: Vec3, rotation: Quat, dt: number): boolean;
  back(): boolean;
  dispose(): void;
}

export const REPLAY_SPEEDS: readonly number[] = [0.25, 0.5, 1, 2];
const MODES: readonly DirectorMode[] = ['auto', 'chase', 'trackside', 'heli', 'side', 'bumper', 'orbit'];

export function formatClock(seconds: number): string {
  const s = Math.max(0, Number.isFinite(seconds) ? seconds : 0);
  const m = Math.floor(s / 60), rest = s - m * 60;
  return `${m}:${rest.toFixed(1).padStart(4, '0')}`;
}

/** Speed in km/h and slide angle in degrees at time t, from 15 Hz samples (search starts at `hint`). */
export function sampleTelemetry(samples: readonly GhostTransform[], t: number, hint = 0): { kmh: number; angle: number; index: number } {
  if (samples.length < 2) return { kmh: 0, angle: 0, index: 0 };
  let i = Math.max(1, Math.min(samples.length - 1, hint));
  while (i > 1 && samples[i - 1]!.timeSeconds > t) i--;
  while (i < samples.length - 1 && samples[i]!.timeSeconds < t) i++;
  const a = samples[i - 1]!, b = samples[i]!;
  const dt = b.timeSeconds - a.timeSeconds;
  const kmh = dt > 0 ? Math.hypot(b.position.x - a.position.x, b.position.z - a.position.z) / dt * 3.6 : 0;
  return { kmh: Math.round(Math.min(kmh, 600)), angle: Math.round(Math.abs(b.driftAngleRad) * 180 / Math.PI), index: i };
}

export function mountReplayMode(shell: HTMLElement, deps: ReplayModeDeps): ReplayMode {
  const director = new ReplayDirector();
  let active = false, held = false, playing = true, speed = 1, watched = false, watchTime = 0;
  let samples: readonly GhostTransform[] = [];
  let teleIndex = 1, teleTimer = 0, scrubbing = false;

  const root = h('div', 'lf-replay lf-bars'); root.hidden = true;
  root.setAttribute('role', 'region'); root.setAttribute('aria-label', 'Replay');
  const top = h('div', 'lf-rtop');
  const rec = h('span', 'lf-rec'); rec.append(h('i'), h('span', '', 'Replay'));
  const shot = h('span', 'lf-shot');
  const tele = h('span', 'lf-tele');
  const kmhNode = h('b', '', '0'), angleNode = h('b', '', '0');
  const kmhWrap = h('span'); kmhWrap.append(kmhNode, 'km/h');
  const angleWrap = h('span'); angleWrap.append(angleNode, 'deg slide');
  tele.append(kmhWrap, angleWrap);
  top.append(rec, shot, tele);
  const bar = h('div', 'lf-rbar');
  const scrub = h('div', 'lf-scrub');
  const playButton = button('lf-play', 'II', () => setPlaying(!playing), 'Pause');
  const range = h('input'); range.type = 'range'; range.min = '0'; range.max = '1000'; range.step = '1'; range.value = '0';
  range.setAttribute('aria-label', 'Replay position');
  const time = h('output', '', '0:00.0 / 0:00.0');
  scrub.append(playButton, range, time);
  const row = h('div', 'lf-rrow');
  const speedSeg = h('div', 'lf-seg'); speedSeg.setAttribute('aria-label', 'Speed');
  const speedButtons = REPLAY_SPEEDS.map(value => { const node = button('', `${value}x`, () => setSpeed(value)); speedSeg.append(node); return [value, node] as const; });
  const camSeg = h('div', 'lf-seg'); camSeg.setAttribute('aria-label', 'Camera');
  const camButtons = MODES.map(mode => { const node = button('', mode === 'auto' ? 'Auto' : SHOT_NAMES[mode], () => { director.setMode(mode); sync(); }); camSeg.append(node); return [mode, node] as const; });
  const side = h('div');
  side.append(
    button('', 'Photo', () => deps.photo()),
    button('', 'Hide UI', () => root.classList.add('bare')),
    button('lf-go', 'Done', () => deps.exit()),
  );
  row.append(speedSeg, camSeg, side);
  bar.append(scrub, row);
  const show = button('lf-show', 'Show controls', () => root.classList.remove('bare'));
  root.append(top, bar, show);
  shell.append(root);

  // The game styles every range by its --v fill (0-100); programmatic updates must set it too.
  let rangeAt = -1;
  const setRange = (value: number): void => { if (value === rangeAt) return; rangeAt = value; range.value = String(value); range.style.setProperty('--v', (value / 10).toFixed(1)); };
  setRange(0);
  range.addEventListener('input', () => { rangeAt = Number(range.value); range.style.setProperty('--v', (rangeAt / 10).toFixed(1)); scrubbing = true; deps.controls.seek(Number(range.value) / 1000); director.cut(); teleIndex = 1; });
  range.addEventListener('change', () => { scrubbing = false; });
  range.addEventListener('pointerdown', event => event.stopPropagation());

  function setPlaying(next: boolean): void {
    playing = next;
    deps.controls.setSpeed(playing && !held ? speed : 0);
    playButton.textContent = playing ? 'II' : '▶';
    playButton.setAttribute('aria-label', playing ? 'Pause' : 'Play');
  }
  function setSpeed(value: number): void { speed = value; if (playing && !held) deps.controls.setSpeed(speed); sync(); }
  function sync(): void {
    for (const [value, node] of speedButtons) node.setAttribute('aria-pressed', String(value === speed));
    for (const [mode, node] of camButtons) node.setAttribute('aria-pressed', String(director.mode === mode));
  }
  const onKeyDown = (event: KeyboardEvent): void => {
    if (!active || held) return;
    if (event.key === 'Escape') { event.preventDefault(); event.stopImmediatePropagation(); back(); return; }
    const target = event.target as HTMLElement | null;
    if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName) && !(target instanceof HTMLInputElement && target.type === 'range')) return;
    if (event.code === 'Space' || event.code === 'KeyK') { setPlaying(!playing); event.preventDefault(); event.stopImmediatePropagation(); }
    else if (event.code === 'KeyH') { root.classList.toggle('bare'); event.stopImmediatePropagation(); }
    else if (event.code === 'KeyC') { const next = MODES[(MODES.indexOf(director.mode) + 1) % MODES.length]!; director.setMode(next); sync(); event.stopImmediatePropagation(); }
    else if (event.code === 'ArrowLeft' || event.code === 'ArrowRight') {
      const clock = deps.controls.clock();
      if (clock.duration > 0) { deps.controls.seek((clock.time + (event.code === 'ArrowLeft' ? -5 : 5)) / clock.duration); director.cut(); teleIndex = 1; }
      event.preventDefault(); event.stopImmediatePropagation();
    }
  };
  window.addEventListener('keydown', onKeyDown, true);

  function back(): boolean {
    if (!active) return false;
    if (root.classList.contains('bare')) { root.classList.remove('bare'); return true; }
    deps.exit();
    return true;
  }

  return {
    get active() { return active; },
    open(next, route, label) {
      samples = next; active = true; held = false; watched = false; watchTime = 0; teleIndex = 1; teleTimer = 0;
      director.setRoute(route); director.mode = 'auto'; director.reset();
      root.hidden = false; root.classList.remove('bare'); root.hidden = false;
      shell.dataset.lfReplay = '';
      rec.lastChild!.textContent = label ? `Replay · ${label}` : 'Replay';
      speed = 1; setPlaying(true); sync();
      playButton.focus({ preventScroll: true });
    },
    close() {
      if (!active) return;
      active = false; held = false; samples = [];
      root.hidden = true; delete shell.dataset.lfReplay;
      deps.resetCamera();
    },
    hold(next) {
      held = next;
      root.hidden = held || !active;
      deps.controls.setSpeed(!held && playing ? speed : 0);
      if (!held) director.cut();
    },
    cameraOverride(position, rotation, dt) {
      if (!active || held) return false;
      const out = director.update(dt, position, rotation);
      director.apply(deps.camera, out);
      // Light DOM work at 10 Hz: clock, scrubber, shot name and telemetry.
      teleTimer += dt;
      if (teleTimer >= 0.1) {
        teleTimer = 0;
        const clock = deps.controls.clock();
        if (!scrubbing && clock.duration > 0) setRange(Math.round(clock.time / clock.duration * 1000));
        time.textContent = `${formatClock(clock.time)} / ${formatClock(clock.duration)}`;
        const name = SHOT_NAMES[director.shot()];
        if (shot.textContent !== name) shot.textContent = name;
        const t = sampleTelemetry(samples, clock.time + (samples[0]?.timeSeconds ?? 0), teleIndex);
        teleIndex = t.index;
        kmhNode.textContent = String(t.kmh); angleNode.textContent = String(t.angle);
        if (playing && !watched) { watchTime += 0.1 * Math.max(0.25, speed); if (watchTime >= Math.min(8, clock.duration * 0.5)) { watched = true; deps.onWatched(); } }
      }
      return true;
    },
    back,
    dispose() { window.removeEventListener('keydown', onKeyDown, true); root.remove(); },
  };
}
