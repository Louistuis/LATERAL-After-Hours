import { describe, expect, it } from 'vitest';
import type { RuntimeView } from '../../src/core/game-runtime';
import { DrivingTutorial } from '../../src/experience/tutorial';

function view(tick: number, controls: { throttle?: number; steering?: number; handbrake?: number } = {}, motion: { forwardMS?: number; yawRadS?: number; driftAngleRad?: number; paused?: boolean } = {}): RuntimeView {
  const vehicle = {
    simulationTick: tick,
    rotation: { x: 0, y: 0, z: 0, w: 1 },
    linearVelocityMS: { x: 0, y: 0, z: -(motion.forwardMS ?? 6) },
    angularVelocityRadS: { x: 0, y: motion.yawRadS ?? .12, z: 0 },
    driftAngleRad: motion.driftAngleRad ?? -.2,
    wheels: Array.from({ length: 4 }, () => ({ contact: true })),
  };
  return {
    paused: motion.paused ?? false, presentation: 'drive', mode: 'free-drive',
    frame: { current: vehicle },
    input: { throttle: controls.throttle ?? 0, steering: controls.steering ?? 0, handbrake: controls.handbrake ?? 0 },
  } as unknown as RuntimeView;
}

describe('measured first-drive tutorial', () => {
  it('advances only from consumed controls plus real forward motion, yaw and a signed slide', () => {
    const tutorial = new DrivingTutorial(); tutorial.start();
    for (let tick = 1; tick <= 18; tick++) tutorial.observe(view(tick, { throttle: .8 }, { forwardMS: 0 }));
    expect(tutorial.state().step).toBe('accelerate');
    for (let tick = 19; tick <= 37; tick++) tutorial.observe(view(tick, { throttle: .8 }));
    expect(tutorial.state().step).toBe('turn');
    for (let tick = 38; tick <= 54; tick++) tutorial.observe(view(tick, { steering: .5 }, { yawRadS: 0 }));
    expect(tutorial.state().step).toBe('turn');
    for (let tick = 55; tick <= 70; tick++) tutorial.observe(view(tick, { steering: .5 }));
    expect(tutorial.state().step).toBe('handbrake');
    for (let tick = 71; tick <= 77; tick++) tutorial.observe(view(tick, { handbrake: .8 }));
    expect(tutorial.state().step).toBe('countersteer');
    for (let tick = 78; tick <= 88; tick++) tutorial.observe(view(tick, { steering: -.6 }));
    expect(tutorial.state().step).toBe('countersteer');
    for (let tick = 89; tick <= 101; tick++) tutorial.observe(view(tick, { steering: .6 }, { driftAngleRad: -.02 }));
    expect(tutorial.state().step).toBe('countersteer');
    for (let tick = 102; tick <= 112; tick++) tutorial.observe(view(tick, { steering: .6 }, { driftAngleRad: -.07 }));
    expect(tutorial.state()).toMatchObject({ status: 'completed', step: null });
  });

  it('does not count duplicate render frames or paused simulation and supports explicit skip/replay', () => {
    const tutorial = new DrivingTutorial(); tutorial.start();
    tutorial.observe(view(1, { throttle: 1 }));
    for (let i = 0; i < 30; i++) tutorial.observe(view(1, { throttle: 1 }));
    expect(tutorial.state().step).toBe('accelerate');
    for (let tick = 2; tick <= 40; tick++) tutorial.observe(view(tick, { throttle: 1 }, { paused: true }));
    expect(tutorial.state().step).toBe('accelerate');
    tutorial.skip(); expect(tutorial.state().status).toBe('skipped');
    tutorial.replay(); expect(tutorial.state()).toMatchObject({ status: 'active', step: 'accelerate', progress: 0 });
  });
});
