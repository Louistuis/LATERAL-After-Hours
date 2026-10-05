import type { RuntimeView } from '../core/game-runtime';

export type TutorialStep = 'accelerate' | 'turn' | 'handbrake' | 'countersteer';
export type TutorialStatus = 'not-started' | 'active' | 'completed' | 'skipped';
export interface TutorialState {
  readonly status: TutorialStatus;
  readonly step: TutorialStep | null;
  /** Fraction of the current measured action held, from 0 to 1. */
  readonly progress: number;
}

const STEPS: readonly TutorialStep[] = ['accelerate', 'turn', 'handbrake', 'countersteer'];
const REQUIRED_SECONDS: Readonly<Record<TutorialStep, number>> = {
  accelerate: .3, turn: .25, handbrake: .1, countersteer: .15,
};

/** Measures actions from controls consumed by the fixed simulation and its resulting motion. */
export class DrivingTutorial {
  private status: TutorialStatus = 'not-started';
  private stepIndex = 0;
  private heldSeconds = 0;
  private lastTick = -1;

  state(): TutorialState {
    const step = this.status === 'active' ? STEPS[this.stepIndex] ?? null : null;
    return { status: this.status, step, progress: step ? Math.min(1, this.heldSeconds / REQUIRED_SECONDS[step]) : 0 };
  }
  restore(status: 'not-started' | 'completed' | 'skipped'): void {
    this.status = status;
    this.stepIndex = 0;
    this.heldSeconds = 0;
    this.lastTick = -1;
  }
  start(): void {
    if (this.status !== 'not-started') return;
    this.replay();
  }
  replay(): void {
    this.status = 'active';
    this.stepIndex = 0;
    this.heldSeconds = 0;
    this.lastTick = -1;
  }
  skip(): void {
    this.status = 'skipped';
    this.heldSeconds = 0;
  }
  observe(view: RuntimeView): TutorialState {
    if (this.status !== 'active') return this.state();
    const vehicle = view.frame.current;
    if (vehicle.simulationTick <= this.lastTick) return this.state();
    const elapsed = this.lastTick < 0 ? 1 / 60 : Math.min(.1, (vehicle.simulationTick - this.lastTick) / 60);
    this.lastTick = vehicle.simulationTick;
    if (view.paused || view.presentation !== 'drive' || view.mode !== 'free-drive') return this.state();
    const step = STEPS[this.stepIndex];
    if (!step) return this.state();
    this.heldSeconds = qualifies(step, view) ? this.heldSeconds + elapsed : 0;
    if (this.heldSeconds >= REQUIRED_SECONDS[step]) {
      this.stepIndex += 1;
      this.heldSeconds = 0;
      if (this.stepIndex >= STEPS.length) this.status = 'completed';
    }
    return this.state();
  }
}

function qualifies(step: TutorialStep, view: RuntimeView): boolean {
  const vehicle = view.frame.current;
  const input = view.input;
  const forwardMS = forwardSpeed(vehicle.rotation, vehicle.linearVelocityMS);
  const grounded = vehicle.wheels.filter(wheel => wheel.contact).length >= 3;
  if (!grounded || forwardMS <= 5) return false;
  if (step === 'accelerate') return input.throttle >= .2;
  if (step === 'turn') return Math.abs(input.steering) > .2 && Math.abs(vehicle.angularVelocityRadS.y) > .06;
  if (step === 'handbrake') return input.handbrake > .1;
  // This is an opposite-steer attempt during a measurable signed slide, not
  // proof of a score-qualified drift. The latter has separate route rules.
  return Math.abs(vehicle.driftAngleRad) >= 3 * Math.PI / 180 && input.steering * vehicle.driftAngleRad < -.012;
}

function forwardSpeed(rotation: RuntimeView['frame']['current']['rotation'], velocity: RuntimeView['frame']['current']['linearVelocityMS']): number {
  const { x, y, z, w } = rotation;
  const forwardX = -2 * (x * z + w * y);
  const forwardY = -2 * (y * z - w * x);
  const forwardZ = -(1 - 2 * (x * x + y * y));
  return velocity.x * forwardX + velocity.y * forwardY + velocity.z * forwardZ;
}
