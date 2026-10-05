import type { CarId } from '../../contracts/runtime-contracts';

/** Visual car state shared with other players. Never fed back into physics. */
export interface NetCarState {
  /** Sender clock in milliseconds (its own performance.now()). */
  t: number;
  px: number; py: number; pz: number;
  qx: number; qy: number; qz: number; qw: number;
  vx: number; vy: number; vz: number;
  /** Front wheel steer angle in radians. */
  steer: number;
  brake: boolean;
  reverse: boolean;
  handbrake: boolean;
}

export const NET_CARS: readonly CarId[] = ['CAR-01', 'CAR-02', 'CAR-04', 'CAR-05', 'CAR-06'];
const POS = 100; // centimetres
const ROT = 10000;
const VEL = 100; // cm/s
const STEER = 1000; // milliradians
const MAX_STEER = 1.2;
/** Hard bounds for anything received. A peer can say anything; the render loop only ever sees values inside these. */
export const MAX_POSITION_M = 20000;
export const MAX_SPEED_MS = 200;
const MAX_CLOCK_MS = 1e13;
const MAX_PACKET_LENGTH = 32;

export function emptyCarState(): NetCarState {
  return { t: 0, px: 0, py: 0, pz: 0, qx: 0, qy: 0, qz: 0, qw: 1, vx: 0, vy: 0, vz: 0, steer: 0, brake: false, reverse: false, handbrake: false };
}

function clamp(value: number, limit: number): number {
  return value > limit ? limit : value < -limit ? -limit : value;
}

/**
 * Packs a car state into a flat integer array: about 60 to 90 bytes of JSON.
 * Order: t, px, py, pz, qx, qy, qz, qw, vx, vy, vz, steer, flags.
 */
export function packCarState(s: NetCarState, out: number[] = []): number[] {
  out.length = 13;
  out[0] = Math.round(s.t);
  out[1] = Math.round(s.px * POS); out[2] = Math.round(s.py * POS); out[3] = Math.round(s.pz * POS);
  // Canonical hemisphere keeps the sign stable so slerp never flips through 360 degrees.
  const sign = s.qw < 0 ? -1 : 1;
  out[4] = Math.round(s.qx * sign * ROT); out[5] = Math.round(s.qy * sign * ROT);
  out[6] = Math.round(s.qz * sign * ROT); out[7] = Math.round(s.qw * sign * ROT);
  out[8] = Math.round(clamp(s.vx, 200) * VEL); out[9] = Math.round(clamp(s.vy, 200) * VEL); out[10] = Math.round(clamp(s.vz, 200) * VEL);
  out[11] = Math.round(clamp(s.steer, MAX_STEER) * STEER);
  out[12] = (s.brake ? 1 : 0) | (s.reverse ? 2 : 0) | (s.handbrake ? 4 : 0);
  return out;
}

/** Returns false for malformed payloads so a bad peer can never throw in the render loop. */
export function unpackCarState(data: unknown, out: NetCarState): boolean {
  if (!Array.isArray(data) || data.length < 13 || data.length > MAX_PACKET_LENGTH) return false;
  for (let i = 0; i < 13; i++) if (typeof data[i] !== 'number' || !Number.isFinite(data[i])) return false;
  const d = data as number[];
  if (Math.abs(d[0]!) > MAX_CLOCK_MS) return false;
  out.t = d[0]!;
  out.px = clamp(d[1]! / POS, MAX_POSITION_M); out.py = clamp(d[2]! / POS, MAX_POSITION_M); out.pz = clamp(d[3]! / POS, MAX_POSITION_M);
  let qx = d[4]! / ROT, qy = d[5]! / ROT, qz = d[6]! / ROT, qw = d[7]! / ROT;
  const len = Math.hypot(qx, qy, qz, qw);
  if (len < 1e-6) { qx = 0; qy = 0; qz = 0; qw = 1; } else { qx /= len; qy /= len; qz /= len; qw /= len; }
  out.qx = qx; out.qy = qy; out.qz = qz; out.qw = qw;
  out.vx = clamp(d[8]! / VEL, MAX_SPEED_MS); out.vy = clamp(d[9]! / VEL, MAX_SPEED_MS); out.vz = clamp(d[10]! / VEL, MAX_SPEED_MS);
  out.steer = clamp(d[11]! / STEER, MAX_STEER);
  const flags = d[12]! | 0;
  out.brake = (flags & 1) !== 0; out.reverse = (flags & 2) !== 0; out.handbrake = (flags & 4) !== 0;
  return true;
}

export function carIndex(car: CarId): number { const i = NET_CARS.indexOf(car); return i < 0 ? 0 : i; }
export function carFromIndex(index: unknown): CarId {
  return typeof index === 'number' && NET_CARS[index] ? NET_CARS[index]! : 'CAR-01';
}
