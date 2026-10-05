export function summarizeFrames(samples: Array<{ frameIntervalMs: number | null }>): {
  frames: number;
  averageFps: number | null;
  frameIntervalP50Ms: number | null;
  frameIntervalP95Ms: number | null;
  frameIntervalP99Ms: number | null;
  onePercentLowFps: number | null;
  maxFrameIntervalMs: number | null;
  percentileMethod: string;
  onePercentLowMethod: string;
};
export function validateFrameSamples(samples: Array<Record<string, unknown>>, expectedQuality: string): {
  valid: boolean;
  missingCounters: string[];
  pausedFrames: number;
  qualities: unknown[];
  tickDelta: number;
  invalidIntervals: number;
};
export function validateRouteTelemetry(telemetry: Array<{ routeLegal: boolean; roadWheelContactCount: number; routeProgressM: number }>, routeLengthM: number): {
  valid: boolean;
  legalRatio: number;
  roadContactRatio: number;
  measuredProgressM: number;
  requiredProgressM: number;
};
