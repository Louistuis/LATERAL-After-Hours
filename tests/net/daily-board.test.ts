import { describe, expect, it, vi } from 'vitest';
import type { NetCollection, NetRecord } from '../../src/net/transport';
import { dailySpec } from '../../src/events/daily';
import { dailyBoard, dailyCollection, dailyMine, dailyRow, dailyTop, isDailyImprovement, ownDailyRowId, submitDaily } from '../../src/net/daily-board';
import { VEHICLE_PHYSICS_VERSION } from '../../src/vehicle/tune-identity';

const spec = { ...dailySpec('2026-10-03'), route: 'HW-01' as const, mode: 'drift-attack' as const, car: 'CAR-02' as const, rule: 'none' as const };
let seq = 0;
const row = (username: unknown, value: unknown, patch: Record<string, unknown> = {}): NetRecord => ({ id: `r${++seq}`, username: username as string, ...dailyRow(spec, value as number), ...patch });

describe('daily board', () => {
  it('uses one collection per UTC day', () => {
    expect(dailyCollection('2026-10-03')).toBe('lateral_daily_v1_20261003');
    expect(dailyCollection('../etc')).toBe('lateral_daily_v1_19700101');
  });

  it('keeps only today, the daily car and condition, this physics version and sane values', () => {
    const rows = [
      row('ana', 900), row('ben', 700),
      row('old', 5000, { day: '2026-10-02' }), row('car', 5000, { car: 'CAR-01' }), row('rule', 5000, { rule: 'no-reset' }),
      row('pv', 5000, { pv: 'other-physics' }), row('nan', Number.NaN), row('frac', 500.5), row('huge', 1e12), row('route', 5000, { route: 'RP-01' }),
      row('', 5000), row(42, 5000),
    ];
    const board = dailyBoard(rows, spec);
    expect(board.map(entry => entry.username)).toEqual(['ana', 'ben']);
    expect(board.map(entry => entry.rank)).toEqual([1, 2]);
  });

  it('sanitizes names and keeps one best per player (case-insensitive)', () => {
    const rows = [row('Ana', 300), row('ana', 900), row('e‮vil​', 400)];
    const board = dailyBoard(rows, spec);
    expect(board).toHaveLength(2);
    expect(board[0]).toMatchObject({ username: 'ana', value: 900 });
    expect(board[1]!.username).toBe('evil');
  });

  it('ranks time trials lowest first', () => {
    const tt = { ...spec, mode: 'time-trial' as const };
    const rows = [{ id: 'a', username: 'slow', ...dailyRow(tt, 70000) }, { id: 'b', username: 'fast', ...dailyRow(tt, 52000) }, { id: 'c', username: 'cheat', ...dailyRow(tt, 1000) }];
    expect(dailyTop(rows, tt).map(entry => entry.username)).toEqual(['fast', 'slow']);
    expect(dailyMine(rows, tt, 'SLOW')?.rank).toBe(2);
    expect(isDailyImprovement(rows, tt, 'slow', 69000)).toBe(true);
    expect(isDailyImprovement(rows, tt, 'slow', 71000)).toBe(false);
    expect(isDailyImprovement(rows, tt, 'newbie', 99000)).toBe(true);
  });

  it('writes rows without a username and with the physics version', () => {
    const data = dailyRow(spec, 1234, 'medium');
    expect(data).toEqual({ day: '2026-10-03', route: 'HW-01', mode: 'drift-attack', car: 'CAR-02', rule: 'none', value: 1234, pv: VEHICLE_PHYSICS_VERSION, assist: 'medium' });
    expect('username' in data).toBe(false);
  });

  it('updates the player own row when it can, creates otherwise, keeps worse runs', async () => {
    const records: NetRecord[] = [{ id: 'mine', username: 'Ana', ...dailyRow(spec, 500) }];
    const board: NetCollection = { create: vi.fn(async () => ({})), update: vi.fn(async () => ({})), getList: () => records, subscribe: () => () => {} };
    expect(ownDailyRowId(records, spec, 'ana')).toBe('mine');
    expect(await submitDaily(board, spec, 'ana', 400)).toBe('kept');
    expect(await submitDaily(board, spec, 'ana', 800)).toBe('saved');
    expect(board.update).toHaveBeenCalledWith('mine', expect.objectContaining({ value: 800 }));
    expect(await submitDaily(board, spec, 'zed', 100)).toBe('saved');
    expect(board.create).toHaveBeenCalledTimes(1);
    const noUpdate: NetCollection = { create: vi.fn(async () => ({})), getList: () => records, subscribe: () => () => {} };
    expect(await submitDaily(noUpdate, spec, 'ana', 900)).toBe('saved');
    expect(noUpdate.create).toHaveBeenCalled();
    const failing: NetCollection = { create: vi.fn(async () => { throw new Error('down'); }), getList: () => [], subscribe: () => () => {} };
    expect(await submitDaily(failing, spec, 'ana', 900)).toBe('failed');
  });
});
