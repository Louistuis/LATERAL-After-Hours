import type { PauseController, PauseReason } from '../../contracts/runtime-contracts';
export const FIXED_DT = 1 / 60;
/** Simulation time never derives from event/render frame counts. */
export class FixedClock {
  private accumulator = 0;
  droppedSeconds = 0;
  tick = 0;
  advance(wallDeltaSeconds: number, paused: boolean, step: () => void | false): number {
    if (paused) { this.accumulator = 0; return 0; }
    const delta = Number.isFinite(wallDeltaSeconds) ? Math.max(0, wallDeltaSeconds) : 0;
    this.droppedSeconds += Math.max(0, delta - 0.25);
    this.accumulator += Math.min(delta, 0.25);
    let steps = 0;
    while (this.accumulator + 1e-10 >= FIXED_DT && steps < 5) {
      // A pause raised during this render frame may cancel the next scheduled step.
      // It is neither a simulation tick nor dropped active time.
      if(step()===false){this.accumulator=0;return 0;}
      this.tick++; this.accumulator -= FIXED_DT; steps++;
    }
    if (this.accumulator >= FIXED_DT) {
      const discarded = Math.floor(this.accumulator / FIXED_DT) * FIXED_DT;
      this.droppedSeconds += discarded; this.accumulator -= discarded;
    }
    return Math.max(0, Math.min(1, this.accumulator / FIXED_DT));
  }
  reset(): void { this.accumulator = 0; }
}
export class PauseSet implements PauseController {
  private readonly values = new Set<PauseReason>();
  add(reason: PauseReason): void { this.values.add(reason); }
  remove(reason: PauseReason): void { this.values.delete(reason); }
  reasons(): ReadonlySet<PauseReason> { return new Set(this.values); }
  isPaused(): boolean { return this.values.size > 0; }
}
