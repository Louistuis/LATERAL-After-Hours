import { describe, expect, it, vi } from 'vitest';
import type { RunResult, VehicleSnapshot } from '../../contracts/runtime-contracts';
import { createGhostRecorder } from '../../src/ghosts/recording';
import { ghostRef, ghostRow, listGhosts, loadGhost, MAX_REMOTE_GHOST_CHARS, ownGhostRow, qualifiesForTable, shareGhost } from '../../src/ghosts/remote-ghosts';
import type { NetCollection, NetRecord } from '../../src/net/transport';
import { VEHICLE_PHYSICS_VERSION } from '../../src/vehicle/tune-identity';

const RV = '1.0.3';
function recording(seconds: number, offset = { x: 0, y: 0, z: 0 }) {
  const recorder = createGhostRecorder();
  for (let t = 0; t <= seconds + 1e-9; t += 1 / 60) {
    recorder.update({ position: { x: offset.x + t * 12, y: offset.y + 0.5, z: offset.z + Math.sin(t) * 3 }, rotation: { x: 0, y: Math.sin(t / 4), z: 0, w: Math.cos(t / 4) }, driftAngleRad: 0.2, gear: 3 } as unknown as VehicleSnapshot, t);
  }
  return recorder.toSavedGhost({ routeId: 'HW-01', routeVersion: RV, rulesVersion: 'drift-score-v3-provisional', physicsVersion: VEHICLE_PHYSICS_VERSION, carId: 'CAR-02', tuneHash: 'tune-abc' }, 128 * 1024)!;
}
const result = (seconds: number, patch: Partial<RunResult> = {}): RunResult => ({ runId: 'r', routeId: 'HW-01', mode: 'time-trial', rulesVersion: 'drift-score-v3-provisional', routeVersion: RV, physicsVersion: VEHICLE_PHYSICS_VERSION, tuneHash: 'tune-abc', carId: 'CAR-02', elapsedActiveSeconds: seconds, bankedScore: 0, medal: 'none', valid: true, assist: 'off', ...patch });

describe('shared ghost rows', () => {
  const saved = recording(25);
  const row = ghostRow(saved, result(saved.header.durationSeconds))!;
  const record = (username: string, patch: Record<string, unknown> = {}, id = `id-${username}`): NetRecord => ({ id, username, ...row, ...patch });

  it('builds a row from a valid time trial and refuses anything else', () => {
    expect(row).toMatchObject({ route: 'HW-01', mode: 'time-trial', car: 'CAR-02', pv: VEHICLE_PHYSICS_VERSION, rv: RV, tune: 'tune-abc', assist: 'off' });
    expect('username' in row).toBe(false);
    expect(ghostRow(saved, result(25, { mode: 'drift-attack' }))).toBeNull();
    expect(ghostRow(saved, result(25, { valid: false }))).toBeNull();
    expect(ghostRow(saved, result(25, { carId: 'CAR-01' }))).toBeNull();
    expect(ghostRow(saved, result(40))).toBeNull();
    expect(ghostRow({ ...saved, compressedSnapshots: `g2:${'A'.repeat(MAX_REMOTE_GHOST_CHARS)}` }, result(25))).toBeNull();
    expect(ghostRow(null, result(25))).toBeNull();
  });

  it('decodes a downloaded ghost with the same samples', () => {
    const ghost = loadGhost([record('ana')], 'id-ana', 'HW-01', RV)!;
    expect(ghost.username).toBe('ana');
    expect(ghost.samples.length).toBe(saved.header.sampleCount);
    expect(ghost.samples.at(-1)!.timeSeconds).toBeCloseTo(saved.header.durationSeconds, 2);
  });

  it('rejects tampered, foreign and implausible rows', () => {
    const rows = [
      record('crc', { g: row.g!.toString().slice(0, -8) + 'AAAAAAA=' }, 'crc'),
      record('pv', { pv: 'old-physics' }, 'pv'),
      record('rv', { rv: 'hw01-v0' }, 'rv'),
      record('fast', { value: 1000 }, 'fast'),
      record('dur', { value: 60_000 }, 'dur'),
      record('n', { n: 1 }, 'n'),
      record('big', { g: `g2:${'A'.repeat(MAX_REMOTE_GHOST_CHARS)}` }, 'big'),
      record('bad id', { tune: '<script>' }, 'tune'),
      record('route', { route: 'CL-01' }, 'route'),
      record('car', { car: 'CAR-99' }, 'car'),
    ];
    for (const bad of rows) expect(loadGhost(rows, bad.id, 'HW-01', RV), bad.id).toBeNull();
    expect(loadGhost(rows, 'missing', 'HW-01', RV)).toBeNull();
  });

  it('rejects ghosts that leave the world bounds', () => {
    const far = recording(25, { x: 50_000, y: 0, z: 0 });
    const farRow = ghostRow(far, result(far.header.durationSeconds))!;
    expect(loadGhost([{ id: 'far', username: 'far', ...farRow }], 'far', 'HW-01', RV)).toBeNull();
  });

  it('lists the fastest ghost per driver, fastest first, without decoding', () => {
    const slow = record('ana', { value: Math.round(saved.header.durationSeconds * 1000) + 300 }, 'a1');
    const quick = record('ANA', {}, 'a2');
    const other = record('ben', { value: Math.round(saved.header.durationSeconds * 1000) + 100 }, 'b1');
    const list = listGhosts([slow, quick, other, { id: 'junk' }], 'HW-01', RV);
    expect(list.map(ref => ref.id)).toEqual(['a2', 'b1']);
    expect(ghostRef({ id: 'x', username: 'x' }, 'HW-01', RV)).toBeNull();
  });

  it('only shares times that would sit in the top table', () => {
    const board = Array.from({ length: 20 }, (_, i): NetRecord => ({ id: `t${i}`, username: `p${i}`, route: 'HW-01', mode: 'time-trial', value: 50_000 + i * 100, car: 'CAR-01', pv: VEHICLE_PHYSICS_VERSION }));
    expect(qualifiesForTable(board, 'HW-01', 51_000)).toBe(true);
    expect(qualifiesForTable(board, 'HW-01', 60_000)).toBe(false);
    expect(qualifiesForTable(board.slice(0, 5), 'HW-01', 60_000)).toBe(true);
  });

  it('keeps one row per player and route, updated in place', async () => {
    const records: NetRecord[] = [record('ana', {}, 'mine')];
    const collection: NetCollection = { create: vi.fn(async () => ({})), update: vi.fn(async () => ({})), getList: () => records, subscribe: () => () => {} };
    expect(ownGhostRow(records, 'HW-01', 'Ana')?.id).toBe('mine');
    expect(await shareGhost(collection, { ...row, value: (row.value as number) + 50 }, 'ana')).toBe('kept');
    expect(await shareGhost(collection, { ...row, value: (row.value as number) - 50 }, 'ana')).toBe('saved');
    expect(collection.update).toHaveBeenCalledWith('mine', expect.anything());
    expect(await shareGhost(collection, row, 'ben')).toBe('saved');
    expect(collection.create).toHaveBeenCalledTimes(1);
  });
});
