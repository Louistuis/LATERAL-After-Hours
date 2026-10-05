import type { PauseReason } from '../../contracts/runtime-contracts';

export interface RecoverableRuntime {
  pause(reason: PauseReason): void;
  resume(reason: PauseReason): void;
  onRenderFailure(callback: (error: Error) => void): void;
}
export type GraphicsRecoveryState = 'lost' | 'restoring' | 'ready' | 'failed';

/** A context pause composes with menu, hidden and ad pauses; it never resets progress. */
export function attachCanvasRecovery(
  canvas: EventTarget,
  runtime: RecoverableRuntime,
  notify: (state: GraphicsRecoveryState, detail?: string) => void,
): () => void {
  let disposed = false;
  let recoveryFrame = 0;
  let generation = 0;
  const cancelPending = () => { generation++; cancelAnimationFrame(recoveryFrame); recoveryFrame = 0; };
  const lost = (event: Event) => {
    event.preventDefault();
    cancelPending();
    runtime.pause('context-lost');
    notify('lost');
  };
  const restored = () => {
    cancelPending();
    const operation = generation;
    notify('restoring');
    // Three and the stage rebuild their context resources in their restoration handlers.
    recoveryFrame = requestAnimationFrame(() => {
      if (disposed || operation !== generation) return;
      runtime.resume('context-lost');
      notify('ready');
    });
  };
  runtime.onRenderFailure(error => {
    if (disposed) return;
    cancelPending();
    runtime.pause('context-lost');
    notify('failed', error.message);
  });
  canvas.addEventListener('webglcontextlost', lost);
  canvas.addEventListener('webglcontextrestored', restored);
  return () => {
    disposed = true;
    cancelPending();
    canvas.removeEventListener('webglcontextlost', lost);
    canvas.removeEventListener('webglcontextrestored', restored);
  };
}
