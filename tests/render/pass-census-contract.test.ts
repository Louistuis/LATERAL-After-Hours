import { describe, expect, it } from 'vitest';
import { validatePassCensusRecord } from '../../tools/benchmark/pass-census-contract.mjs';

function validRecord() {
  return {
    schemaVersion: 1,
    identity: {
      target: 'owner-review', buildId: 'checkpoint-a1b2c3d4', commit: 'a'.repeat(40),
      sourceHash: 'b'.repeat(64), contentHash: 'c'.repeat(64), workingTreeDirty: false,
    },
    quality: 'balanced', contextState: 'ready', paused: true,
    pose: {
      routeId: 'HW-01', routeLegal: true, roadWheelContactCount: 4,
      routeProgressM: 225, routeDistanceM: 1.1, tickBefore: 100, tickAfter: 100, samePoseAfter: true,
    },
    snapshotBracket: {
      beforeCensus: {
        tick: 100, position: { x: 1, y: 0.5, z: 225 }, rotation: { x: 0, y: 0, z: 0, w: 1 },
        paused: true, quality: 'balanced', contextState: 'ready', routeId: 'HW-01',
        routeProgressM: 225, routeDistanceM: 1.1, routeLegal: true, roadWheelContactCount: 4,
      },
      afterCensus: {
        tick: 100, position: { x: 1, y: 0.5, z: 225 }, rotation: { x: 0, y: 0, z: 0, w: 1 },
        paused: true, quality: 'balanced', contextState: 'ready',
      },
    },
    diagnosticFrame: {
      tick: 100, quality: 'balanced', contextState: 'ready',
      stageCounters: { drawCallsAllPasses: 168, trianglesAllPasses: 62000 },
      census: {
        main: {
          staticWorld: { submissions: 80, instances: 30 },
          car: { submissions: 50, instances: 0 },
          other: { submissions: 5, instances: 4 },
        },
        shadow: {
          staticWorld: { submissions: 25, instances: 12 },
          car: { submissions: 8, instances: 0 },
          other: { submissions: 0, instances: 0 },
        },
        rendererInfoCalls: 168,
        callbackAggregateDelta: 0,
      },
    },
    census: {
      main: {
        staticWorld: { submissions: 80, instances: 30 },
        car: { submissions: 50, instances: 0 },
        other: { submissions: 5, instances: 4 },
      },
      shadow: {
        staticWorld: { submissions: 25, instances: 12 },
        car: { submissions: 8, instances: 0 },
        other: { submissions: 0, instances: 0 },
      },
      rendererInfoCalls: 168,
      callbackAggregateDelta: 0,
    },
  };
}

describe('pass-census record contract', () => {
  it('accepts a clean paused legal-pose record with explicit aggregate agreement', () => {
    expect(validatePassCensusRecord(validRecord())).toEqual({ valid: true, errors: [] });
  });

  it('accepts and retains a nonzero callback-to-renderer delta when internally consistent', () => {
    const record = validRecord();
    record.census.callbackAggregateDelta = -3;
    record.census.rendererInfoCalls += 3;
    record.diagnosticFrame.census.callbackAggregateDelta = -3;
    record.diagnosticFrame.census.rendererInfoCalls += 3;
    record.diagnosticFrame.stageCounters.drawCallsAllPasses += 3;
    expect(validatePassCensusRecord(record).valid).toBe(true);
  });

  it('rejects dirty identity, moving/active pose, missing categories, and an incorrect delta', () => {
    const record = validRecord();
    record.identity.workingTreeDirty = true;
    record.paused = false;
    record.pose.tickAfter++;
    record.census.main.car.submissions = -1;
    record.census.callbackAggregateDelta = 1;
    const result = validatePassCensusRecord(record);
    expect(result.valid).toBe(false);
    expect(result.errors).toEqual(expect.arrayContaining([
      'identity.workingTreeDirty must be false',
      'the census frame must be paused',
      'pose tick must remain fixed across census',
      'census.main.car.submissions must be a nonnegative integer',
      'census.callbackAggregateDelta must equal callbacks minus rendererInfoCalls',
    ]));
  });
});
