import type { CarId, GhostHeader, RouteId, SavedGhost, Vec3, Quat, VehicleSnapshot } from '../../contracts/runtime-contracts.js';

export interface GhostCompatibility {
  readonly routeId: RouteId;
  readonly routeVersion: string;
  readonly rulesVersion: string;
  readonly physicsVersion: string;
  readonly carId: CarId;
  readonly tuneHash: string;
}

export interface GhostTransform {
  readonly timeSeconds: number;
  readonly position: Vec3;
  readonly rotation: Quat;
  readonly driftAngleRad: number;
  readonly gear: number;
}

export interface GhostValidation { readonly compatible: boolean; readonly reason: string | null; readonly samples: readonly GhostTransform[]; }

export interface GhostRecorder {
  readonly sampleCount: number;
  update(snapshot: VehicleSnapshot, activeTimeSeconds: number): void;
  samples(): readonly GhostTransform[];
  toSavedGhost(metadata: GhostCompatibility, maxUtf8Bytes: number): SavedGhost | null;
}

export const REPLAY_SECONDS = 12;
export const REPLAY_HZ = 30;
export const GHOST_HZ = 15;
export const MAX_GHOST_DURATION_SECONDS = 600;
export const DEFAULT_MAX_GHOST_BYTES = 128 * 1024;

/** Bounded 12-second visual replay ring. Capacity is fixed at 360 samples. */
export class ReplayBuffer {
  private readonly capacity = REPLAY_SECONDS * REPLAY_HZ;
  private frames: GhostTransform[] = [];
  private lastSampleTime = -Infinity;

  push(snapshot: VehicleSnapshot, activeTimeSeconds: number): void {
    if (!Number.isFinite(activeTimeSeconds) || activeTimeSeconds < 0 || activeTimeSeconds - this.lastSampleTime < 1 / REPLAY_HZ - 1e-6) return;
    this.lastSampleTime = activeTimeSeconds;
    this.frames.push(toTransform(snapshot, activeTimeSeconds));
    while (this.frames.length && this.frames[0]!.timeSeconds < activeTimeSeconds - REPLAY_SECONDS) this.frames.shift();
    if (this.frames.length > this.capacity) this.frames.shift();
  }

  freeze(): readonly GhostTransform[] {
    return Object.freeze(this.frames.map((frame) => Object.freeze({
      ...frame,
      position: Object.freeze({ ...frame.position }),
      rotation: Object.freeze({ ...frame.rotation }),
    })));
  }
  clear(): void { this.frames = []; this.lastSampleTime = -Infinity; }
  get size(): number { return this.frames.length; }
}

/** Full-run ghost recorder; call each fixed step and it retains at most 15 Hz samples. */
export function createGhostRecorder(): GhostRecorder {
  const frames: GhostTransform[] = [];
  let lastSampleTime = -Infinity;
  return {
    get sampleCount() { return frames.length; },
    update(snapshot, activeTimeSeconds) {
      if (!Number.isFinite(activeTimeSeconds) || activeTimeSeconds < 0 || activeTimeSeconds > MAX_GHOST_DURATION_SECONDS ||
        activeTimeSeconds - lastSampleTime < 1 / GHOST_HZ - 1e-6 || frames.length >= MAX_GHOST_DURATION_SECONDS * GHOST_HZ + 1) return;
      lastSampleTime = activeTimeSeconds;
      frames.push(toTransform(snapshot, activeTimeSeconds));
    },
    samples() { return Object.freeze(frames.slice()); },
    toSavedGhost(metadata, maxUtf8Bytes = DEFAULT_MAX_GHOST_BYTES) {
      if (frames.length < 2 || maxUtf8Bytes <= 0) return null;
      const header: GhostHeader = {
        formatVersion: 1, ...metadata, sampleHz: GHOST_HZ, sampleCount: frames.length,
        durationSeconds: frames[frames.length - 1]!.timeSeconds - frames[0]!.timeSeconds,
      };
      const compressedSnapshots = encodeCompactGhost(frames);
      if (!compressedSnapshots) return null;
      const candidate: SavedGhost = { header, compressedSnapshots };
      return utf8ByteLength(JSON.stringify(candidate)) <= maxUtf8Bytes ? candidate : null;
    },
  };
}

export function validateSavedGhost(saved: SavedGhost, expected: GhostCompatibility): GhostValidation {
  if (!saved || typeof saved !== 'object' || !saved.header || typeof saved.header !== 'object' || typeof saved.compressedSnapshots !== 'string') {
    return { compatible: false, reason: 'corrupt header', samples: [] };
  }
  const h = saved.header;
  if ((h as { formatVersion: number }).formatVersion !== 1) return { compatible: false, reason: 'unsupported format version', samples: [] };
  if (h.sampleHz !== GHOST_HZ || !Number.isInteger(h.sampleCount) || h.sampleCount < 2 || h.sampleCount > MAX_GHOST_DURATION_SECONDS * GHOST_HZ + 1 ||
    !Number.isFinite(h.durationSeconds) || h.durationSeconds <= 0 || h.durationSeconds > MAX_GHOST_DURATION_SECONDS) {
    return { compatible: false, reason: 'invalid ghost header', samples: [] };
  }
  const mismatches: string[] = [];
  for (const key of ['routeId', 'routeVersion', 'rulesVersion', 'physicsVersion', 'carId', 'tuneHash'] as const) {
    if (h[key] !== expected[key]) mismatches.push(key);
  }
  if (h.formatVersion !== 1 || h.sampleHz !== GHOST_HZ) mismatches.push('format');
  if (mismatches.length) return { compatible: false, reason: `incompatible ${mismatches.join(', ')}`, samples: [] };
  try {
    const isCompact = saved.compressedSnapshots.startsWith('g2:');
    const decoded: unknown = isCompact
      ? decodeCompactGhost(saved.compressedSnapshots)
      : JSON.parse(decodeBase64Utf8(saved.compressedSnapshots));
    if (!Array.isArray(decoded) || decoded.length !== h.sampleCount || decoded.length < 2 || decoded.length > 100_000) {
      return { compatible: false, reason: 'invalid sample count', samples: [] };
    }
    const rawSamples = decoded as GhostTransform[];
    const legacyBaseTime = isCompact ? 0 : rawSamples[0]!.timeSeconds;
    const samples = isCompact ? rawSamples : rawSamples.map((sample) => ({ ...sample, timeSeconds: sample.timeSeconds - legacyBaseTime }));
    let previous = -Infinity;
    for (const sample of samples) {
      if (!Number.isFinite(sample.timeSeconds) || sample.timeSeconds <= previous || !finiteVec(sample.position) || !finiteQuat(sample.rotation) ||
        !Number.isFinite(sample.driftAngleRad) || !Number.isFinite(sample.gear)) return { compatible: false, reason: 'invalid sample data', samples: [] };
      previous = sample.timeSeconds;
    }
    if (Math.abs(previous - h.durationSeconds) > 0.01) return { compatible: false, reason: 'duration mismatch', samples: [] };
    return { compatible: true, reason: null, samples: Object.freeze(samples) };
  } catch {
    return { compatible: false, reason: 'corrupt recording', samples: [] };
  }
}

export function interpolateGhost(samples: readonly GhostTransform[], timeSeconds: number): GhostTransform | null {
  if (samples.length === 0 || !Number.isFinite(timeSeconds)) return null;
  if (timeSeconds <= samples[0]!.timeSeconds) return samples[0]!;
  const last = samples[samples.length - 1]!;
  if (timeSeconds >= last.timeSeconds) return last;
  let hi = 1;
  while (hi < samples.length && samples[hi]!.timeSeconds < timeSeconds) hi++;
  const a = samples[hi - 1]!;
  const b = samples[hi]!;
  const t = (timeSeconds - a.timeSeconds) / (b.timeSeconds - a.timeSeconds);
  return {
    timeSeconds,
    position: { x: lerp(a.position.x, b.position.x, t), y: lerp(a.position.y, b.position.y, t), z: lerp(a.position.z, b.position.z, t) },
    rotation: slerp(a.rotation, b.rotation, t),
    driftAngleRad: lerp(a.driftAngleRad, b.driftAngleRad, t),
    gear: t < 0.5 ? a.gear : b.gear,
  };
}

export function utf8ByteLength(value: string): number { return new TextEncoder().encode(value).byteLength; }

function toTransform(snapshot: VehicleSnapshot, timeSeconds: number): GhostTransform {
  return { timeSeconds, position: { ...snapshot.position }, rotation: { ...snapshot.rotation }, driftAngleRad: snapshot.driftAngleRad, gear: snapshot.gear };
}
function lerp(a: number, b: number, t: number): number { return a + (b - a) * t; }
function finiteVec(v: Vec3): boolean { return !!v && Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.z); }
function finiteQuat(q: Quat): boolean { return !!q && Number.isFinite(q.x) && Number.isFinite(q.y) && Number.isFinite(q.z) && Number.isFinite(q.w); }
function slerp(a: Quat, b: Quat, t: number): Quat {
  let dot = a.x * b.x + a.y * b.y + a.z * b.z + a.w * b.w;
  let bx = b.x, by = b.y, bz = b.z, bw = b.w;
  if (dot < 0) { dot = -dot; bx = -bx; by = -by; bz = -bz; bw = -bw; }
  if (dot > 0.9995) {
    const q = { x: lerp(a.x, bx, t), y: lerp(a.y, by, t), z: lerp(a.z, bz, t), w: lerp(a.w, bw, t) };
    const n = Math.hypot(q.x, q.y, q.z, q.w) || 1;
    return { x: q.x / n, y: q.y / n, z: q.z / n, w: q.w / n };
  }
  const theta = Math.acos(Math.max(-1, Math.min(1, dot)));
  const sinTheta = Math.sin(theta);
  const wa = Math.sin((1 - t) * theta) / sinTheta;
  const wb = Math.sin(t * theta) / sinTheta;
  return { x: a.x * wa + bx * wb, y: a.y * wa + by * wb, z: a.z * wa + bz * wb, w: a.w * wa + bw * wb };
}
function decodeBase64Utf8(value: string): string {
  if (value.length > 700_000) throw new Error('legacy ghost exceeds decode limit');
  const binary = atob(value);
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

/** Compact quantized payload: millisecond time, millimeter position deltas, int16 quaternion/angle. */
function encodeCompactGhost(frames: readonly GhostTransform[]): string | null {
  if (frames.length < 2 || frames.length > MAX_GHOST_DURATION_SECONDS * GHOST_HZ + 1) return null;
  const anchors = Math.floor((frames.length - 1) / 30);
  const headerBytes = 3 + 4 + 12 + 11;
  const byteLength = headerBytes + (frames.length - 1) * 21 + anchors * 6 + 4;
  const bytes = new Uint8Array(byteLength);
  const view = new DataView(bytes.buffer);
  bytes.set([0x4c, 0x47, 0x32], 0); // "LG2"
  let offset = 3;
  view.setUint32(offset, frames.length, true); offset += 4;
  const first = frames[0]!;
  let previousPosition = first.position;
  for (const axis of ['x', 'y', 'z'] as const) { if (!Number.isFinite(first.position[axis])) return null; view.setFloat32(offset, first.position[axis], true); offset += 4; }
  if (!writePose(view, first, offset)) return null;
  offset += 11;
  const baseTime = first.timeSeconds;
  for (let i = 1; i < frames.length; i++) {
    const frame = frames[i]!;
    const elapsedMs = Math.round((frame.timeSeconds - baseTime) * 1000);
    if (!Number.isSafeInteger(elapsedMs) || elapsedMs < 1 || elapsedMs > MAX_GHOST_DURATION_SECONDS * 1000) return null;
    view.setUint32(offset, elapsedMs, true); offset += 4;
    if (i % 30 === 0) {
      for (const axis of ['x', 'y', 'z'] as const) {
        if (!Number.isFinite(frame.position[axis])) return null;
        view.setFloat32(offset, frame.position[axis], true); offset += 4;
      }
    } else {
      for (const axis of ['x', 'y', 'z'] as const) {
        const deltaMm = Math.round((frame.position[axis] - previousPosition[axis]) * 1000);
        if (!Number.isInteger(deltaMm) || deltaMm < -32768 || deltaMm > 32767) return null;
        view.setInt16(offset, deltaMm, true); offset += 2;
      }
    }
    if (!writePose(view, frame, offset)) return null;
    offset += 11;
    previousPosition = frame.position;
  }
  const checksum = crc32(bytes.subarray(0, offset));
  view.setUint32(offset, checksum, true);
  return `g2:${encodeBase64Bytes(bytes)}`;
}

function decodeCompactGhost(payload: string): GhostTransform[] {
  const bytes = decodeBase64Bytes(payload.slice(3));
  if (bytes.length < 30 + 21 + 4 || bytes[0] !== 0x4c || bytes[1] !== 0x47 || bytes[2] !== 0x32) throw new Error('invalid compact ghost magic');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const count = view.getUint32(3, true);
  if (count < 2 || count > MAX_GHOST_DURATION_SECONDS * GHOST_HZ + 1) throw new Error('invalid compact ghost count');
  const anchors = Math.floor((count - 1) / 30);
  const expectedSize = 30 + (count - 1) * 21 + anchors * 6 + 4;
  if (bytes.length !== expectedSize) throw new Error('invalid compact ghost length');
  const storedChecksum = view.getUint32(bytes.length - 4, true);
  if (storedChecksum !== crc32(bytes.subarray(0, bytes.length - 4))) throw new Error('compact ghost checksum mismatch');
  let offset = 7;
  let position: Vec3 = { x: view.getFloat32(offset, true), y: view.getFloat32(offset + 4, true), z: view.getFloat32(offset + 8, true) };
  offset += 12;
  const firstPose = readPose(view, offset); offset += 11;
  const samples: GhostTransform[] = [{ timeSeconds: 0, position, ...firstPose }];
  let previousTimeMs = 0;
  for (let i = 1; i < count; i++) {
    const timeMs = view.getUint32(offset, true); offset += 4;
    if (timeMs <= previousTimeMs) throw new Error('non-monotonic compact ghost time');
    previousTimeMs = timeMs;
    if (i % 30 === 0) {
      position = { x: view.getFloat32(offset, true), y: view.getFloat32(offset + 4, true), z: view.getFloat32(offset + 8, true) };
      offset += 12;
    } else {
      position = {
        x: position.x + view.getInt16(offset, true) / 1000,
        y: position.y + view.getInt16(offset + 2, true) / 1000,
        z: position.z + view.getInt16(offset + 4, true) / 1000,
      };
      offset += 6;
    }
    const pose = readPose(view, offset); offset += 11;
    samples.push({ timeSeconds: timeMs / 1000, position, ...pose });
  }
  return samples;
}

function writePose(view: DataView, frame: GhostTransform, offset: number): boolean {
  const q = frame.rotation;
  const magnitude = Math.hypot(q.x, q.y, q.z, q.w);
  if (!Number.isFinite(magnitude) || magnitude < 1e-6 || !Number.isFinite(frame.driftAngleRad) || !Number.isInteger(frame.gear) || frame.gear < -128 || frame.gear > 127) return false;
  for (const value of [q.x / magnitude, q.y / magnitude, q.z / magnitude, q.w / magnitude]) {
    view.setInt16(offset, Math.round(Math.max(-1, Math.min(1, value)) * 32767), true); offset += 2;
  }
  const angle = Math.round(frame.driftAngleRad * 10000);
  if (angle < -32768 || angle > 32767) return false;
  view.setInt16(offset, angle, true); offset += 2;
  view.setInt8(offset, frame.gear);
  return true;
}

function readPose(view: DataView, offset: number): Pick<GhostTransform, 'rotation' | 'driftAngleRad' | 'gear'> {
  const q = { x: view.getInt16(offset, true) / 32767, y: view.getInt16(offset + 2, true) / 32767,
    z: view.getInt16(offset + 4, true) / 32767, w: view.getInt16(offset + 6, true) / 32767 };
  const magnitude = Math.hypot(q.x, q.y, q.z, q.w) || 1;
  return {
    rotation: { x: q.x / magnitude, y: q.y / magnitude, z: q.z / magnitude, w: q.w / magnitude },
    driftAngleRad: view.getInt16(offset + 8, true) / 10000,
    gear: view.getInt8(offset + 10),
  };
}

function encodeBase64Bytes(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}
function decodeBase64Bytes(value: string): Uint8Array {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(value) || value.length > 700_000) throw new Error('invalid base64 payload');
  const binary = atob(value);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}
function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
