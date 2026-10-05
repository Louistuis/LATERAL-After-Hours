import type { CueKind } from './synth-buffers';

export interface CueSink { playCue(kind: CueKind): boolean }

const CONTROL = 'button, [role="button"], [role="tab"], [data-action], [data-menu], select, input[type="checkbox"], input[type="range"], a[href]';

/**
 * Soft menu ticks through the audio facade: a tiny hover tick when the pointer (or keyboard/gamepad focus) moves
 * to a new control, a select click on activation and a lower click for Back. Nothing plays while driving, on
 * touch hover, or inside the showroom (it has its own sounds). Spacing is enforced by PlayerAudio.playCue.
 */
export function attachMenuSounds(root: HTMLElement, cues: CueSink, driving: () => boolean): () => void {
  let hovered: Element | null = null;
  let lastPointerMs = Number.NEGATIVE_INFINITY;
  const now = (): number => (typeof performance !== 'undefined' ? performance.now() : Date.now());
  const control = (target: EventTarget | null): HTMLElement | null =>
    target && typeof (target as Element).closest === 'function' ? (target as Element).closest<HTMLElement>(CONTROL) : null;
  const silent = (element: HTMLElement): boolean =>
    driving() || element.closest('.lp-sr') !== null || (element as HTMLButtonElement).disabled === true || element.getAttribute('aria-disabled') === 'true';
  const onOver = (event: PointerEvent): void => {
    if (event.pointerType === 'touch') return;
    lastPointerMs = now();
    const element = control(event.target);
    if (element === hovered) return;
    hovered = element;
    if (element && !silent(element)) cues.playCue('hover');
  };
  const onFocus = (event: FocusEvent): void => {
    // Pointer clicks also move focus; only keyboard and gamepad navigation should tick here.
    if (now() - lastPointerMs < 500) return;
    const element = control(event.target);
    if (!element || element === hovered) return;
    hovered = element;
    if (!silent(element)) cues.playCue('hover');
  };
  const onClick = (event: MouseEvent): void => {
    const element = control(event.target);
    if (!element || silent(element) || element.matches('input[type="range"]')) return;
    const action = element.dataset.action ?? '';
    const back = action === 'back' || action === 'close' || /^back\b/i.test(element.textContent?.trim() ?? '');
    cues.playCue(back ? 'back' : 'select');
  };
  root.addEventListener('pointerover', onOver, { passive: true });
  root.addEventListener('focusin', onFocus);
  root.addEventListener('click', onClick, { passive: true });
  return () => {
    root.removeEventListener('pointerover', onOver);
    root.removeEventListener('focusin', onFocus);
    root.removeEventListener('click', onClick);
  };
}
