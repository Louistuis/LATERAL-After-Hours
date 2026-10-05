export function percentile(values, p) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)] ?? null;
}

export function summarizeFrames(samples) {
  const intervals = samples.map((sample) => sample.frameIntervalMs).filter((sample) => sample !== null);
  const total = intervals.reduce((sum, interval) => sum + interval, 0);
  const slowCount = Math.max(1, Math.ceil(intervals.length * 0.01));
  const slowest = [...intervals].sort((a, b) => b - a).slice(0, slowCount);
  const slowMean = slowest.reduce((sum, interval) => sum + interval, 0) / slowest.length;
  return {
    frames: samples.length,
    averageFps: total > 0 ? intervals.length * 1000 / total : null,
    frameIntervalP50Ms: percentile(intervals, 0.50),
    frameIntervalP95Ms: percentile(intervals, 0.95),
    frameIntervalP99Ms: percentile(intervals, 0.99),
    onePercentLowFps: slowMean > 0 ? 1000 / slowMean : null,
    maxFrameIntervalMs: intervals.length ? Math.max(...intervals) : null,
    percentileMethod: 'nearest rank: sorted[Math.ceil(p*N)-1]',
    onePercentLowMethod: '1000 divided by the mean of the slowest ceil(1% of frame intervals)',
  };
}

export function validateFrameSamples(samples, expectedQuality) {
  const missingCounters = ['drawCallsAllPasses', 'trianglesAllPasses'].filter((field) => samples.some((sample) => !Number.isFinite(sample[field])));
  const pausedFrames = samples.filter((sample) => sample.paused !== false).length;
  const qualities = new Set(samples.map((sample) => sample.quality));
  const firstTick = samples[0]?.simulationTick;
  const lastTick = samples.at(-1)?.simulationTick;
  const tickDelta = lastTick - firstTick;
  const invalidIntervals = samples.slice(1).filter((sample) => !Number.isFinite(sample.frameIntervalMs) || sample.frameIntervalMs <= 0).length;
  return {
    valid: samples.length > 1 && !missingCounters.length && pausedFrames === 0 && qualities.size === 1 && qualities.has(expectedQuality) && Number.isFinite(tickDelta) && tickDelta > 0 && invalidIntervals === 0,
    missingCounters,
    pausedFrames,
    qualities: [...qualities],
    tickDelta,
    invalidIntervals,
  };
}

export function validateRouteTelemetry(telemetry, routeLengthM) {
  const legalRatio = telemetry.length ? telemetry.filter((entry) => entry.routeLegal).length / telemetry.length : 0;
  const roadContactRatio = telemetry.length ? telemetry.filter((entry) => entry.roadWheelContactCount >= 2).length / telemetry.length : 0;
  const measuredProgressM = telemetry.at(-1)?.routeProgressM ?? 0;
  const requiredProgressM = Math.min(300, routeLengthM * 0.65);
  return {
    valid: telemetry.length > 1 && legalRatio >= 0.9 && roadContactRatio >= 0.9 && measuredProgressM >= requiredProgressM,
    legalRatio,
    roadContactRatio,
    measuredProgressM,
    requiredProgressM,
  };
}
