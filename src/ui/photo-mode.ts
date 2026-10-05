/**
 * Photo mode: a free camera over the paused game (or a held replay frame) with FOV, roll, colour filters, vignette and a
 * focus band depth of field, a hide-UI toggle, PNG capture at the screen's resolution and an opt-in "Share to comments".
 *
 * Sharing only ever happens from the Post button of the share sheet (a click by the player). Nothing is posted
 * automatically, and the caption is plain text the player can edit.
 * The capture is taken right after a render (afterRender, called from the runtime frame callback), so the WebGL buffer
 * is still valid without preserveDrawingBuffer.
 */
import type * as THREE from 'three';
import type { Vec3 } from '../../contracts/runtime-contracts';
import { PhotoCamera, PHOTO_FOV_RANGE, PHOTO_ROLL_RANGE, type PhotoCameraMode } from '../camera/photo-camera';
import { composePhoto, DEFAULT_LOOK, focusMaskCss, isIdentity, matrixFor, matrixValues, MAX_BLUR_CSS_PX, PHOTO_FILTERS, photoSize, vignetteCss, type PhotoLook } from './photo-filters';
import { button, h } from './feature-css';
import { SELFHOST } from '../core/target';

export interface PhotoModeDeps {
  readonly camera: THREE.PerspectiveCamera;
  readonly canvas: HTMLCanvasElement;
  /** Leaves photo mode (the hub decides where to: results, menu or back to the replay). */
  exit(): void;
  /** Default caption for a shared photo. */
  caption(): string;
  /** File name stem, e.g. "lateral-seven-bends". */
  fileStem(): string;
  /** Posts the image with the caption. Only called from the Post button. */
  share?: (blob: Blob, caption: string) => Promise<{ ok: boolean; message: string }>;
  canShare(): boolean;
  /** Puts the image on the clipboard (the self-hosted build offers Save and Copy instead of sharing to comments). */
  copy?: (blob: Blob) => Promise<{ ok: boolean; message: string }>;
  onSaved(): void;
  resetCamera(): void;
}
export interface PhotoMode {
  readonly active: boolean;
  open(car: Vec3): void;
  close(): void;
  /** Writes the photo camera (true while photo mode owns the camera). */
  cameraOverride(car: Vec3, dt: number): boolean;
  /** Call right after each render. Takes a pending capture. */
  afterRender(): void;
  /** Escape / gamepad back. True when consumed. */
  back(): boolean;
  dispose(): void;
}

export const MAX_CAPTION = 200;
// eslint-disable-next-line no-control-regex
const CONTROL = new RegExp('[\\u0000-\\u001f\\u007f-\\u009f\\u200b-\\u200f\\u2028-\\u202e\\u2060-\\u206f\\ufeff]', 'g');
/** Plain single-paragraph caption: no control or bidi characters, collapsed spaces, at most MAX_CAPTION characters. */
export function cleanCaption(text: unknown): string {
  if (typeof text !== 'string') return '';
  return Array.from(text.replace(CONTROL, ' ').replace(/\s+/g, ' ').trim()).slice(0, MAX_CAPTION).join('').trim();
}

const SVG_NS = 'http://www.w3.org/2000/svg';
const FILTER_ID = 'lf-photo-matrix';

export function mountPhotoMode(shell: HTMLElement, deps: PhotoModeDeps): PhotoMode {
  const cam = new PhotoCamera();
  let look: PhotoLook = { ...DEFAULT_LOOK };
  let active = false;
  let pending: 'save' | 'share' | 'copy' | null = null;
  let shareCaption = '';
  let busy = false;
  const keys = new Set<string>();
  const pointers = new Map<number, { x: number; y: number; button: number }>();
  let pinch = 0, mid = { x: 0, y: 0 };
  let carAt: Vec3 = { x: 0, y: 0, z: 0 };

  // SVG colour matrix for the live preview (same numbers as the capture pass).
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('width', '0'); svg.setAttribute('height', '0'); svg.setAttribute('aria-hidden', 'true');
  svg.style.position = 'absolute';
  const filter = document.createElementNS(SVG_NS, 'filter');
  filter.setAttribute('id', FILTER_ID); filter.setAttribute('color-interpolation-filters', 'sRGB');
  const matrixNode = document.createElementNS(SVG_NS, 'feColorMatrix');
  matrixNode.setAttribute('type', 'matrix');
  filter.append(matrixNode); svg.append(filter);

  const root = h('div', 'lf-photo'); root.hidden = true;
  root.setAttribute('role', 'dialog'); root.setAttribute('aria-label', 'Photo mode');
  const capture = h('div', 'lf-capture');
  const dof = h('div', 'lf-dof'); const vig = h('div', 'lf-vig'); const flash = h('div', 'lf-flash');
  const panel = h('section', 'lf-panel');
  const head = h('header', 'lf-head');
  const headText = h('div');
  headText.append(h('p', 'lf-kicker', 'Photo mode'), h('h3', 'lf-title', 'Frame it'));
  head.append(headText, button('lf-close', '×', () => deps.exit(), 'Leave photo mode'));
  const body = h('div', 'lf-body');
  const message = h('p', 'lf-msg'); message.setAttribute('role', 'status'); message.setAttribute('aria-live', 'polite');
  const showButton = button('lf-show', 'Show controls', () => setBare(false));

  /* ---------- controls ---------- */
  const modeSeg = h('div', 'lf-seg');
  const modeButtons = (['orbit', 'free'] as const).map(mode => {
    const node = button('', mode === 'orbit' ? 'Orbit' : 'Free', () => { cam.setMode(mode); syncControls(); });
    modeSeg.append(node); return [mode, node] as const;
  });
  const slider = (label: string, min: number, max: number, step: number, read: () => number, write: (value: number) => void, unit = ''): { row: HTMLLabelElement; sync(): void } => {
    const row = h('label', 'lf-ctl'); const name = h('span', '', label);
    const input = h('input'); input.type = 'range'; input.min = String(min); input.max = String(max); input.step = String(step);
    const out = h('output');
    const sync = (): void => { const value = read(); input.value = String(value); input.style.setProperty('--v', (Math.max(0, Math.min(1, (value - Number(input.min)) / (Number(input.max) - Number(input.min) || 1))) * 100).toFixed(1)); out.textContent = `${Math.round(value)}${unit}`; };
    input.addEventListener('input', () => { write(Number(input.value)); sync(); applyLook(); });
    input.addEventListener('pointerdown', event => event.stopPropagation());
    row.append(name, input, out); return { row, sync };
  };
  const fov = slider('FOV', PHOTO_FOV_RANGE[0], PHOTO_FOV_RANGE[1], 1, () => cam.fov, value => cam.setFov(value), '°');
  const roll = slider('Roll', PHOTO_ROLL_RANGE[0], PHOTO_ROLL_RANGE[1], 1, () => cam.roll, value => cam.setRoll(value), '°');
  const vignette = slider('Vignette', 0, 100, 1, () => look.vignette * 100, value => { look = { ...look, vignette: value / 100 }; });
  const blur = slider('Focus', 0, 100, 1, () => look.blur * 100, value => { look = { ...look, blur: value / 100 }; });
  const focus = slider('Band', 10, 90, 1, () => look.focus * 100, value => { look = { ...look, focus: value / 100 }; });
  const filterSeg = h('div', 'lf-seg');
  const filterButtons = PHOTO_FILTERS.map(entry => {
    const node = button('', entry.name, () => { look = { ...look, filter: entry.id }; applyLook(); syncControls(); });
    filterSeg.append(node); return [entry.id, node] as const;
  });
  const hint = h('p', 'lf-hint');
  body.append(h('h4', '', 'Camera'), modeSeg, fov.row, roll.row, h('h4', '', 'Look'), filterSeg, vignette.row, h('h4', '', 'Depth of field'), blur.row, focus.row, hint, message);

  const actions = h('div', 'lf-actions');
  const saveButton = button('lf-go', 'Save photo', () => request('save'));
  const shareButton = SELFHOST ? button('', 'Copy photo', () => request('copy')) : button('', 'Share to comments', () => openShare());
  const hideButton = button('', 'Hide UI', () => setBare(true));
  const resetButton = button('', 'Reset look', () => { look = { ...DEFAULT_LOOK }; cam.setFov(50); cam.setRoll(0); applyLook(); syncControls(); });
  actions.append(saveButton, hideButton, resetButton, shareButton);
  const shareSheet = h('div', 'lf-share'); shareSheet.hidden = true;
  const shareText = h('textarea'); shareText.maxLength = MAX_CAPTION; shareText.setAttribute('aria-label', 'Caption');
  const shareRow = h('div');
  shareRow.append(button('', 'Cancel', () => { shareSheet.hidden = true; }), button('lf-go', 'Post', () => { shareCaption = cleanCaption(shareText.value) || cleanCaption(deps.caption()); request('share'); }));
  shareSheet.append(h('p', 'lf-hint', SELFHOST ? '' : 'Posts this photo and your caption to the game comments. Nothing is posted until you press Post.'), shareText, shareRow);
  body.append(shareSheet);
  panel.append(head, body, actions);
  root.append(capture, dof, vig, flash, panel, showButton);
  shell.append(root);
  shell.append(svg);

  function setBare(bare: boolean): void { root.classList.toggle('bare', bare); if (!bare) saveButton.focus({ preventScroll: true }); }
  function say(text: string, error = false): void { message.textContent = text; message.classList.toggle('err', error); }
  function syncControls(): void {
    for (const [mode, node] of modeButtons) node.setAttribute('aria-pressed', String(cam.mode === mode));
    for (const [id, node] of filterButtons) node.setAttribute('aria-pressed', String(look.filter === id));
    fov.sync(); roll.sync(); vignette.sync(); blur.sync(); focus.sync();
    focus.row.hidden = look.blur <= 0.01;
    shareButton.hidden = SELFHOST ? !deps.copy : !deps.canShare();
    const touch = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
    hint.textContent = cam.mode === 'orbit'
      ? (touch ? 'Drag to swing around the car. Pinch to zoom, two fingers to slide.' : 'Drag to swing around the car. Scroll to zoom, right drag to slide. H hides the UI.')
      : (touch ? 'Drag to look. Pinch to fly forward, two fingers to slide.' : 'Drag to look. WASD or arrows to fly, Q and E for height, Shift for speed. H hides the UI.');
  }
  function applyLook(): void {
    const matrix = matrixFor(look.filter);
    matrixNode.setAttribute('values', matrixValues(matrix));
    deps.canvas.style.filter = active && !isIdentity(matrix) ? `url(#${FILTER_ID})` : '';
    vig.style.background = look.vignette > 0.01 ? vignetteCss(look.vignette) : 'none';
    const on = look.blur > 0.01;
    dof.hidden = !on;
    if (on) {
      dof.style.setProperty('--lf-blur', `${(look.blur * MAX_BLUR_CSS_PX).toFixed(1)}px`);
      const mask = focusMaskCss(look.focus);
      dof.style.setProperty('mask-image', mask); dof.style.setProperty('-webkit-mask-image', mask);
    }
  }
  function openShare(): void {
    if (!deps.canShare()) return;
    shareText.value = cleanCaption(deps.caption());
    shareSheet.hidden = false;
    // The sheet sits under the scrolling controls: bring it above the sticky action bar.
    shareSheet.scrollIntoView?.({ block: 'nearest' });
    shareText.focus({ preventScroll: true });
  }
  function request(kind: 'save' | 'share' | 'copy'): void {
    if (busy) return;
    busy = true; pending = kind;
    say(kind === 'save' ? 'Developing...' : kind === 'copy' ? 'Copying...' : 'Uploading...');
  }

  /* ---------- input ---------- */
  const onPointerDown = (event: PointerEvent): void => {
    capture.setPointerCapture?.(event.pointerId);
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY, button: event.button });
    if (pointers.size === 2) { const [a, b] = [...pointers.values()]; pinch = Math.hypot(a!.x - b!.x, a!.y - b!.y); mid = { x: (a!.x + b!.x) / 2, y: (a!.y + b!.y) / 2 }; }
    event.preventDefault();
  };
  const onPointerMove = (event: PointerEvent): void => {
    const p = pointers.get(event.pointerId); if (!p) return;
    const dx = event.clientX - p.x, dy = event.clientY - p.y;
    p.x = event.clientX; p.y = event.clientY;
    if (pointers.size >= 2) {
      const [a, b] = [...pointers.values()];
      const distance = Math.hypot(a!.x - b!.x, a!.y - b!.y), center = { x: (a!.x + b!.x) / 2, y: (a!.y + b!.y) / 2 };
      if (pinch > 0) cam.zoom((pinch - distance) * 4);
      cam.pan(center.x - mid.x, center.y - mid.y);
      pinch = distance; mid = center;
    } else if (p.button === 2 || event.ctrlKey) cam.pan(dx, dy);
    else cam.drag(dx, dy);
  };
  const onPointerUp = (event: PointerEvent): void => { pointers.delete(event.pointerId); if (pointers.size < 2) pinch = 0; };
  const onWheel = (event: WheelEvent): void => { cam.zoom(event.deltaY); event.preventDefault(); };
  const onContext = (event: Event): void => event.preventDefault();
  capture.addEventListener('pointerdown', onPointerDown);
  capture.addEventListener('pointermove', onPointerMove);
  capture.addEventListener('pointerup', onPointerUp);
  capture.addEventListener('pointercancel', onPointerUp);
  capture.addEventListener('wheel', onWheel, { passive: false });
  capture.addEventListener('contextmenu', onContext);
  const typing = (target: EventTarget | null): boolean => target instanceof HTMLElement && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) && !(target instanceof HTMLInputElement && target.type === 'range');
  const onKeyDown = (event: KeyboardEvent): void => {
    if (!active) return;
    if (event.key === 'Escape') { event.preventDefault(); event.stopImmediatePropagation(); back(); return; }
    if (typing(event.target)) return;
    if (event.code === 'KeyH' && !event.repeat) { setBare(!root.classList.contains('bare')); event.preventDefault(); event.stopImmediatePropagation(); return; }
    keys.add(event.code);
    if (/^(Key[WASDQE]|Arrow\w+|Space)$/.test(event.code)) { event.preventDefault(); event.stopImmediatePropagation(); }
  };
  const onKeyUp = (event: KeyboardEvent): void => { keys.delete(event.code); };
  window.addEventListener('keydown', onKeyDown, true);
  window.addEventListener('keyup', onKeyUp, true);

  function back(): boolean {
    if (!active) return false;
    if (!shareSheet.hidden) { shareSheet.hidden = true; return true; }
    if (root.classList.contains('bare')) { setBare(false); return true; }
    deps.exit();
    return true;
  }

  async function deliver(kind: 'save' | 'share' | 'copy', canvas: HTMLCanvasElement): Promise<void> {
    try {
      const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob(result => result ? resolve(result) : reject(new Error('empty')), 'image/png'));
      if (kind === 'save') {
        const url = URL.createObjectURL(blob);
        const link = h('a'); link.href = url; link.download = `${deps.fileStem()}-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.png`;
        document.body.append(link); link.click(); link.remove();
        setTimeout(() => URL.revokeObjectURL(url), 4000);
        say(`Saved ${canvas.width} x ${canvas.height} PNG.`);
        deps.onSaved();
      } else if (kind === 'copy') {
        const result = deps.copy ? await deps.copy(blob) : { ok: false, message: 'Copying is not available here. Use Save photo.' };
        say(result.message, !result.ok);
        if (result.ok) deps.onSaved();
      } else if (deps.share) {
        const result = await deps.share(blob, shareCaption);
        say(result.message, !result.ok);
        if (result.ok) { shareSheet.hidden = true; deps.onSaved(); }
      }
    } catch { say(kind === 'save' ? 'The photo could not be saved.' : kind === 'copy' ? 'The photo could not be copied. Use Save photo.' : 'The photo could not be shared.', true); }
    finally { busy = false; }
  }

  return {
    get active() { return active; },
    open(car) {
      if (active) return;
      active = true; carAt = car;
      cam.begin(deps.camera, car);
      root.hidden = false; root.classList.remove('bare'); shareSheet.hidden = true; say('');
      shell.dataset.lfPhoto = '';
      syncControls(); applyLook();
      saveButton.focus({ preventScroll: true });
    },
    close() {
      if (!active) return;
      active = false; pending = null; busy = false; keys.clear(); pointers.clear();
      root.hidden = true; delete shell.dataset.lfPhoto;
      deps.canvas.style.filter = '';
      deps.resetCamera();
    },
    cameraOverride(car, dt) {
      if (!active) return false;
      carAt = car;
      if (cam.mode === 'free' && keys.size) {
        const speed = (keys.has('ShiftLeft') || keys.has('ShiftRight') ? 24 : 8) * Math.min(0.1, Math.max(0, dt));
        const f = (keys.has('KeyW') || keys.has('ArrowUp') ? 1 : 0) - (keys.has('KeyS') || keys.has('ArrowDown') ? 1 : 0);
        const r = (keys.has('KeyD') || keys.has('ArrowRight') ? 1 : 0) - (keys.has('KeyA') || keys.has('ArrowLeft') ? 1 : 0);
        const u = (keys.has('KeyE') || keys.has('Space') ? 1 : 0) - (keys.has('KeyQ') ? 1 : 0);
        if (f || r || u) cam.move(f * speed, r * speed, u * speed);
      }
      cam.apply(deps.camera, carAt);
      return true;
    },
    afterRender() {
      if (!active || !pending) return;
      const kind = pending; pending = null;
      const canvas = deps.canvas;
      const rect = canvas.getBoundingClientRect();
      const size = photoSize(rect.width || canvas.width, rect.height || canvas.height, typeof devicePixelRatio === 'number' ? devicePixelRatio : 1);
      let composed: HTMLCanvasElement;
      try { composed = composePhoto(canvas, canvas.width, canvas.height, size, look, rect.width || canvas.width); }
      catch { say('The photo could not be captured.', true); busy = false; return; }
      flash.classList.remove('on'); void flash.offsetWidth; flash.classList.add('on');
      void deliver(kind, composed);
    },
    back,
    dispose() {
      window.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('keyup', onKeyUp, true);
      if (active) deps.canvas.style.filter = '';
      root.remove(); svg.remove();
    },
  };
}

export type { PhotoCameraMode };
