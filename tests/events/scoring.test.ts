import { describe, expect, it } from 'vitest';
import type { VehicleSnapshot } from '../../contracts/runtime-contracts.js';
import { createDriftScorer } from '../../src/events/scoring.js';

const snapshot = (tick: number, yaw = 0): VehicleSnapshot => ({
  simulationTick: tick, carId: 'CAR-01', position: { x: 0, y: 0, z: 0 },
  rotation: { x: 0, y: Math.sin(yaw / 2), z: 0, w: Math.cos(yaw / 2) },
  linearVelocityMS: { x: -12 * Math.sin(yaw), y: 0, z: -12 * Math.cos(yaw) },
  angularVelocityRadS: { x: 0, y: 0, z: 0 }, engineRpm: 3000, gear: 2, driftAngleRad: 0.55,
  wheels: [0, 1, 2, 3].map(() => ({ contact: true, position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0, w: 1 }, compressionM: 0, normalLoadN: 1, angularVelocityRadS: 0, slipRatio: 0, slipAngleRad: 0, surfaceId: 'asphalt' })) as unknown as VehicleSnapshot['wheels'],
});
const evidence = (routeProgressM: number) => ({ routeProgressM, legalCorridor: true, checkpointValid: true, impactDeltaMS: 0, active: true, paused: false });

describe('route-aware drift scoring', () => {
  it('uses car heading for forward speed on rotated route segments', () => {
    const scorer = createDriftScorer({ rulesVersion: 'test', routeLengthM: 500 });
    expect(scorer.update(snapshot(1, Math.PI / 2), evidence(0.2), 1 / 60).validDrift).toBe(true);
  });

  it('banks a clean exit after 1.2 seconds and resets between runs', () => {
    const scorer = createDriftScorer({ rulesVersion: 'test', routeLengthM: 500 });
    for (let tick = 1; tick <= 3; tick++) scorer.update(snapshot(tick), evidence(tick * 0.2), 1 / 60);
    const gained = scorer.snapshot().unbanked;
    expect(gained).toBeGreaterThan(0);
    for (let tick = 4; tick < 76; tick++) {
      scorer.update({ ...snapshot(tick), driftAngleRad: 0 }, evidence(tick * 0.2), 1 / 60);
    }
    expect(scorer.snapshot().banked).toBeGreaterThan(0);
    expect(scorer.snapshot().unbanked).toBe(0);
    scorer.reset();
    expect(scorer.snapshot()).toMatchObject({ banked: 0, unbanked: 0, activeSeconds: 0, routeProgressM: 0 });
  });

  it('keeps the linked multiplier through 0.7 seconds of grip, then restarts the chain after 0.7 but before bank', () => {
    const continueChain = createDriftScorer({ rulesVersion: 'test', routeLengthM: 500 });
    for (let tick = 1; tick <= 126; tick++) continueChain.update(snapshot(tick), evidence(tick * 0.2), 1 / 60);
    expect(continueChain.snapshot().multiplier).toBe(2);
    for (let tick = 127; tick <= 168; tick++) continueChain.update({ ...snapshot(tick), driftAngleRad: 0 }, evidence(tick * 0.2), 1 / 60);
    expect(continueChain.snapshot().multiplier).toBe(2);
    continueChain.update(snapshot(169), evidence(169 * 0.2), 1 / 60);
    expect(continueChain.snapshot().multiplier).toBe(2);

    const restartChain = createDriftScorer({ rulesVersion: 'test', routeLengthM: 500 });
    for (let tick = 1; tick <= 126; tick++) restartChain.update(snapshot(tick), evidence(tick * 0.2), 1 / 60);
    const priorUnbanked = restartChain.snapshot().unbanked;
    for (let tick = 127; tick <= 171; tick++) restartChain.update({ ...snapshot(tick), driftAngleRad: 0 }, evidence(tick * 0.2), 1 / 60);
    expect(restartChain.snapshot()).toMatchObject({ multiplier: 1, banked: 0 });
    expect(restartChain.snapshot().unbanked).toBeGreaterThan(0);
    expect(restartChain.snapshot().unbanked).toBeLessThanOrEqual(priorUnbanked);
    restartChain.update(snapshot(172), evidence(172 * 0.2), 1 / 60);
    expect(restartChain.snapshot().multiplier).toBe(1);
  });

  it('applies a continuous authored clip-zone bonus once per pass with a one-second cap', () => {
    const config = { rulesVersion: 'test', routeLengthM: 500, pointsPerSecond: 6000 };
    const withZone = createDriftScorer({ ...config, clippingZones: [{ id: 'clip-a', progressM: 250, radiusM: 500, preferredOffsetM: 0.5, lateralToleranceM: 0.2, bonusFactor: 2 }] });
    const neutral = createDriftScorer(config);
    let bonusAtOneSecond = 0;
    for (let tick = 1; tick <= 120; tick++) {
      const routeProgressM = tick * 0.2;
      const evidenceWithOffset = { ...evidence(routeProgressM), routeLateralOffsetM: 0.5 };
      withZone.update(snapshot(tick), evidenceWithOffset, 1 / 60);
      neutral.update(snapshot(tick), evidenceWithOffset, 1 / 60);
      if (tick === 60) bonusAtOneSecond = withZone.snapshot().unbanked - neutral.snapshot().unbanked;
    }
    const bonus = withZone.snapshot().unbanked - neutral.snapshot().unbanked;
    expect(bonusAtOneSecond).toBeGreaterThan(500);
    expect(bonus).toBeGreaterThan(500);
    expect(bonus).toBeLessThan(800);
    expect(createDriftScorer(config).snapshot().unbanked).toBe(0);
  });

  it('does not activate clip bonuses on paused, invalid-line, or wall-contact frames, and reset allows a new pass', () => {
    const config = { rulesVersion: 'test', routeLengthM: 500, pointsPerSecond: 6000,
      clippingZones: [{ id: 'clip-a', progressM: 1.5, radiusM: 1.5, preferredOffsetM: 0.5, lateralToleranceM: 0.2, bonusFactor: 1.5 }] };
    const scorer = createDriftScorer(config);
    const neutral = createDriftScorer({ rulesVersion: 'test', routeLengthM: 500, pointsPerSecond: 6000 });
    scorer.update(snapshot(1), { ...evidence(0.2), routeLateralOffsetM: 0.5, paused: true }, 1 / 60);
    neutral.update(snapshot(1), { ...evidence(0.2), routeLateralOffsetM: 0.5, paused: true }, 1 / 60);
    scorer.update(snapshot(2), { ...evidence(0.4), routeLateralOffsetM: 3 }, 1 / 60);
    neutral.update(snapshot(2), { ...evidence(0.4), routeLateralOffsetM: 3 }, 1 / 60);
    expect(scorer.snapshot().unbanked).toBe(neutral.snapshot().unbanked);
    scorer.update(snapshot(3), { ...evidence(0.6), routeLateralOffsetM: 0.5, wallContact: true }, 1 / 60);
    neutral.update(snapshot(3), { ...evidence(0.6), routeLateralOffsetM: 0.5, wallContact: true }, 1 / 60);
    expect(scorer.snapshot().unbanked).toBe(neutral.snapshot().unbanked);
    const valid = { ...evidence(0.8), routeLateralOffsetM: 0.5 };
    scorer.update(snapshot(4), valid, 1 / 60);
    neutral.update(snapshot(4), valid, 1 / 60);
    expect(scorer.snapshot().unbanked).toBeGreaterThan(neutral.snapshot().unbanked);
    scorer.reset();
    neutral.reset();
    const newPass = { ...evidence(0.2), routeLateralOffsetM: 0.5 };
    scorer.update(snapshot(1), newPass, 1 / 60);
    neutral.update(snapshot(1), newPass, 1 / 60);
    expect(scorer.snapshot().unbanked).toBeGreaterThan(neutral.snapshot().unbanked);
  });

  it('does not reactivate a consumed clip zone after the car leaves and returns laterally', () => {
    const zone = { id: 'clip-a', progressM: 2, radiusM: 3, preferredOffsetM: 0.5, lateralToleranceM: 0.2, bonusFactor: 1.5 };
    const withZone = createDriftScorer({ rulesVersion: 'test', routeLengthM: 500, pointsPerSecond: 6000, clippingZones: [zone] });
    const neutral = createDriftScorer({ rulesVersion: 'test', routeLengthM: 500, pointsPerSecond: 6000 });
    for (let tick = 1; tick <= 20; tick++) {
      const routeProgressM = tick * 0.2;
      const routeLateralOffsetM = tick <= 5 || tick >= 9 ? 0.5 : 3;
      const ev = { ...evidence(routeProgressM), routeLateralOffsetM };
      withZone.update(snapshot(tick), ev, 1 / 60);
      neutral.update(snapshot(tick), ev, 1 / 60);
    }
    const onceOnlyBonus = withZone.snapshot().unbanked - neutral.snapshot().unbanked;
    expect(onceOnlyBonus).toBeGreaterThan(50);
    expect(onceOnlyBonus).toBeLessThan(150);
  });

  it('ends clip bonus continuity on an active grip tick while preserving the <=0.7s drift chain grace', () => {
    const zone = { id: 'clip-a', progressM: 250, radiusM: 500, preferredOffsetM: 0.5, lateralToleranceM: 0.2, bonusFactor: 1.5 };
    const withZone = createDriftScorer({ rulesVersion: 'test', routeLengthM: 500, pointsPerSecond: 6000, clippingZones: [zone] });
    const neutral = createDriftScorer({ rulesVersion: 'test', routeLengthM: 500, pointsPerSecond: 6000 });
    for (let tick = 1; tick <= 120; tick++) {
      const angle = tick === 2 ? 0 : 0.55;
      const ev = { ...evidence(tick * 0.2), routeLateralOffsetM: 0.5 };
      withZone.update({ ...snapshot(tick), driftAngleRad: angle }, ev, 1 / 60);
      neutral.update({ ...snapshot(tick), driftAngleRad: angle }, ev, 1 / 60);
    }
    const singleTickOnly = withZone.snapshot().unbanked - neutral.snapshot().unbanked;
    expect(singleTickOnly).toBeGreaterThan(0);
    expect(singleTickOnly).toBeLessThan(30);
  });

  it('discards a chain on impact, reverse travel, and airborne spin', () => {
    const scorer = createDriftScorer({ rulesVersion: 'test', routeLengthM: 500 });
    scorer.update(snapshot(1), evidence(0.2), 1 / 60);
    scorer.update(snapshot(2), { ...evidence(0.4), impactDeltaMS: 4 }, 1 / 60);
    expect(scorer.snapshot().unbanked).toBe(0);
    scorer.update(snapshot(3), evidence(0.6), 1 / 60);
    scorer.update({ ...snapshot(4), linearVelocityMS: { x: 0, y: 0, z: 12 } }, evidence(0.8), 1 / 60);
    expect(scorer.snapshot().unbanked).toBe(0);
    scorer.update(snapshot(5), evidence(1), 1 / 60);
    scorer.update({ ...snapshot(6), wheels: snapshot(6).wheels.map((w) => ({ ...w, contact: false })) as unknown as VehicleSnapshot['wheels'] }, evidence(1.2), 1 / 60);
    expect(scorer.snapshot().unbanked).toBe(0);
  });

  it('does not score while paused or when progress is repeated or excessive', () => {
    const scorer = createDriftScorer({ rulesVersion: 'test', routeLengthM: 500 });
    expect(scorer.update(snapshot(1), { ...evidence(0.2), paused: true }, 1 / 60).unbanked).toBe(0);
    expect(scorer.update(snapshot(2), evidence(0), 1 / 60).unbanked).toBe(0);
    expect(scorer.update(snapshot(3), evidence(10), 1 / 60).unbanked).toBe(0);
  });

  it('rejects wall riding and missing road contact evidence', () => {
    const scorer = createDriftScorer({ rulesVersion: 'test', routeLengthM: 500 });
    expect(scorer.update(snapshot(1), { ...evidence(0.2), wallContact: true }, 1 / 60).unbanked).toBe(0);
    expect(scorer.update(snapshot(2), { ...evidence(0.4), roadContact: false }, 1 / 60).unbanked).toBe(0);
  });

  it('rejects non-fixed scoring steps that could manipulate score rate', () => {
    const scorer = createDriftScorer({ rulesVersion: 'test', routeLengthM: 500 });
    expect(scorer.update(snapshot(1), evidence(0.2), 1 / 30).unbanked).toBe(0);
    for (let tick = 2; tick < 20; tick++) scorer.update(snapshot(tick), evidence((tick - 1) * 0.1), 1 / 60);
    expect(scorer.snapshot().unbanked).toBeGreaterThan(0);
  });
});
