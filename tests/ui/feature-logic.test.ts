import { describe, expect, it } from 'vitest';
import { applyColorMatrix, focusMaskCss, focusStops, isIdentity, matrixFor, PHOTO_FILTERS, photoSize, vignetteCss } from '../../src/ui/photo-filters';
import { cleanCaption, MAX_CAPTION } from '../../src/ui/photo-mode';
import { formatClock, sampleTelemetry } from '../../src/ui/replay-mode';
import { formatCountdownShort, parseFeatRecord } from '../../src/ui/feature-hub';

describe('photo filters', () => {
  it('natural is the identity and leaves pixels alone', () => {
    const data = new Uint8ClampedArray([10, 20, 30, 255]);
    applyColorMatrix(data, matrixFor('none'));
    expect([...data]).toEqual([10, 20, 30, 255]);
    expect(isIdentity(matrixFor('none'))).toBe(true);
    expect(matrixFor('bogus' as never)).toBe(matrixFor('none'));
  });
  it('noir is grey, every matrix has 20 finite entries', () => {
    const data = new Uint8ClampedArray([200, 40, 90, 255]);
    applyColorMatrix(data, matrixFor('noir'));
    expect(data[0]).toBe(data[1]); expect(data[1]).toBe(data[2]); expect(data[3]).toBe(255);
    for (const filter of PHOTO_FILTERS) { expect(filter.matrix).toHaveLength(20); expect(filter.matrix.every(Number.isFinite)).toBe(true); expect(filter.name).not.toMatch(/—/); }
  });
  it('focus band stops are ordered and clamped', () => {
    for (const focus of [-1, 0, 0.3, 0.58, 1, 2, Number.NaN]) {
      const stops = focusStops(focus);
      for (let i = 1; i < 4; i++) expect(stops[i]!).toBeGreaterThanOrEqual(stops[i - 1]!);
      expect(stops[0]).toBeGreaterThanOrEqual(0); expect(stops[3]).toBeLessThanOrEqual(1);
    }
    expect(focusMaskCss(0.5)).toMatch(/^linear-gradient\(to bottom/);
    expect(vignetteCss(0.5)).toMatch(/^radial-gradient/);
  });
  it('saves at the screen resolution, capped at 4096 on the long side', () => {
    expect(photoSize(1280, 720, 2)).toEqual({ width: 2560, height: 1440 });
    expect(photoSize(390, 844, 3)).toEqual({ width: 1170, height: 2532 });
    expect(photoSize(3000, 1000, 2)).toEqual({ width: 4096, height: 1365 });
    expect(photoSize(800, 600, Number.NaN)).toEqual({ width: 800, height: 600 });
  });
});

describe('share caption', () => {
  it('is plain, single line and bounded', () => {
    expect(cleanCaption('  Hello\n\tharbor ‮​ night ')).toBe('Hello harbor night');
    expect(cleanCaption(42)).toBe('');
    expect(Array.from(cleanCaption('x'.repeat(500)))).toHaveLength(MAX_CAPTION);
  });
});

describe('replay helpers', () => {
  it('formats the clock', () => {
    expect(formatClock(0)).toBe('0:00.0');
    expect(formatClock(65.25)).toBe('1:05.3');
    expect(formatClock(Number.NaN)).toBe('0:00.0');
  });
  it('reads speed and slide from the recording', () => {
    const samples = Array.from({ length: 31 }, (_, i) => ({ timeSeconds: i / 15, position: { x: i * 2, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0, w: 1 }, driftAngleRad: 0.5, gear: 3 }));
    const t = sampleTelemetry(samples, 1);
    expect(t.kmh).toBe(108); // 2 m per 1/15 s = 30 m/s
    expect(t.angle).toBe(29);
    expect(sampleTelemetry(samples, 0.2, t.index).kmh).toBe(108);
    expect(sampleTelemetry([], 1)).toEqual({ kmh: 0, angle: 0, index: 0 });
  });
});

describe('feature record', () => {
  it('keeps today and drops other days and junk', () => {
    const today = '2026-10-03';
    const fresh = parseFeatRecord(JSON.stringify({ daily: { day: today, tiers: ['finish', 'gold', 'bogus'], best: 900 }, stats: { runs: 3 } }), today);
    expect(fresh.daily).toEqual({ day: today, tiers: ['finish', 'gold'], best: 900 });
    expect(fresh.stats.runs).toBe(3);
    const stale = parseFeatRecord(JSON.stringify({ daily: { day: '2026-10-02', tiers: ['finish'], best: 900 } }), today);
    expect(stale.daily).toEqual({ day: today, tiers: [], best: null });
    expect(parseFeatRecord('{oops', today).daily.tiers).toEqual([]);
    expect(parseFeatRecord('x'.repeat(20_000), today).stats.runs).toBe(0);
    expect(parseFeatRecord(JSON.stringify({ daily: { day: today, best: 1.5 } }), today).daily.best).toBeNull();
  });
  it('formats the menu countdown', () => {
    expect(formatCountdownShort(5 * 3_600_000 + 12 * 60_000 + 33_000)).toBe('5h 12m 33s');
    expect(formatCountdownShort(59_000)).toBe('0m 59s');
  });
});
