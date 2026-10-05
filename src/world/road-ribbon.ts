import * as THREE from 'three';
import type { Quat, RouteId, Vec3 } from '../../contracts/runtime-contracts';
import type { CollisionMeshData, DistrictId, RouteClippingZone, RouteDefinition, WorldCheckpoint } from '../../contracts/world-contracts';

/**
 * Generic closed-loop road builder shared by the procedural districts (Ridge Pass, Coastline).
 * One source of truth: the same frames produce the carriageway collider, the barriers, the
 * route definition and every visual strip, so what the player sees is what the car drives on.
 */
export type RoadControl = readonly [x: number, y: number, z: number];

export interface RoadSpec {
  readonly id: RouteId;
  readonly name: string;
  readonly district: DistrictId;
  readonly version: string;
  /** Collision surface id of the carriageway (drivable road). */
  readonly roadId: string;
  readonly widthM: number;
  /** District offset added to every control point. */
  readonly origin: Vec3;
  readonly controls: readonly RoadControl[];
  /** Arc-length spacing of the frames, metres (default 2). */
  readonly spacingM?: number;
  /** Bank in radians per unit curvature (1/m); right-hand curves lower the right edge. Default 0. */
  readonly bankGain?: number;
  readonly maxBankRad?: number;
  /** Width of the curvature smoothing window, metres (default 24). */
  readonly bankSmoothM?: number;
  /** Fraction (0..1) of the loop where the spawn sits (ignored when spawnAt is given). */
  readonly spawnFraction?: number;
  /** Local (x, z) the spawn snaps to: the nearest frame. */
  readonly spawnAt?: readonly [number, number];
  /** Gate positions as fractions of the lap after the spawn; the finish gate is added automatically. */
  readonly gateFractions: readonly number[];
  readonly gatePrefix: string;
  /** Finish gate distance behind the spawn (default 12 m, behind the deepest online grid slot). */
  readonly finishBehindSpawnM?: number;
  readonly clippingZones?: readonly RouteClippingZone[];
}

export interface RoadFrame {
  /** Centre of the road surface. */
  readonly p: THREE.Vector3;
  /** Unit tangent in the driving direction. */
  readonly t: THREE.Vector3;
  /** Banked right vector along the road surface. */
  readonly r: THREE.Vector3;
  /** Road surface normal. */
  readonly n: THREE.Vector3;
  /** Horizontal (unbanked) right vector. */
  readonly h: THREE.Vector3;
  /** Arc length from frame 0. */
  readonly s: number;
  /** Signed horizontal curvature, 1/m; positive turns right. */
  readonly curvature: number;
  readonly bank: number;
}

export interface RoadRibbon {
  readonly spec: RoadSpec;
  readonly frames: readonly RoadFrame[];
  readonly lengthM: number;
  readonly spawnIndex: number;
  readonly route: RouteDefinition;
}

const UP = new THREE.Vector3(0, 1, 0);
const vec = (p: THREE.Vector3): Vec3 => ({ x: p.x, y: p.y, z: p.z });

export function yawQuatFromForward(forward: Readonly<{ x: number; z: number }>): Quat {
  const yaw = Math.atan2(-forward.x, -forward.z);
  return { x: 0, y: Math.sin(yaw / 2), z: 0, w: Math.cos(yaw / 2) };
}

/** Sample a closed centripetal Catmull-Rom loop at even arc length and frame it. */
export function buildRoadFrames(spec: RoadSpec): RoadFrame[] {
  const o = spec.origin;
  const curve = new THREE.CatmullRomCurve3(spec.controls.map(([x, y, z]) => new THREE.Vector3(x + o.x, y + o.y, z + o.z)), true, 'centripetal', 0.5);
  const spacing = spec.spacingM ?? 2;
  const count = Math.max(24, Math.round(curve.getLength() / spacing));
  const points = curve.getSpacedPoints(count).slice(0, -1);
  const n = points.length;
  const at = (i: number): THREE.Vector3 => points[((i % n) + n) % n]!;
  const tangents = points.map((_, i) => at(i + 1).clone().sub(at(i - 1)).normalize());
  const rawCurvature = points.map((_, i) => {
    const a = at(i - 1), b = at(i), c = at(i + 1);
    const ax = b.x - a.x, az = b.z - a.z, bx = c.x - b.x, bz = c.z - b.z;
    const la = Math.hypot(ax, az), lb = Math.hypot(bx, bz);
    if (la < 1e-6 || lb < 1e-6) return 0;
    const sin = (ax * bz - az * bx) / (la * lb), cos = (ax * bx + az * bz) / (la * lb);
    return Math.atan2(sin, cos) / ((la + lb) / 2);
  });
  const window = Math.max(1, Math.round((spec.bankSmoothM ?? 24) / spacing / 2));
  const curvature = rawCurvature.map((_, i) => {
    let sum = 0;
    for (let k = -window; k <= window; k++) sum += rawCurvature[((i + k) % n + n) % n]!;
    return sum / (2 * window + 1);
  });
  const gain = spec.bankGain ?? 0, maxBank = spec.maxBankRad ?? 0.08;
  let s = 0;
  return points.map((p, i) => {
    if (i > 0) s += p.distanceTo(points[i - 1]!);
    const t = tangents[i]!;
    const h = new THREE.Vector3(-t.z, 0, t.x).normalize();
    const bank = THREE.MathUtils.clamp(gain * curvature[i]!, -maxBank, maxBank);
    const tilted = h.clone().multiplyScalar(Math.cos(bank)).addScaledVector(UP, -Math.sin(bank));
    const normal = tilted.clone().cross(t).normalize();
    const r = t.clone().cross(normal).normalize();
    return { p: p.clone(), t: t.clone(), r, n: normal, h, s, curvature: curvature[i]!, bank };
  });
}

/** Loop length including the closing segment. */
export function loopLength(frames: readonly RoadFrame[]): number {
  return frames.at(-1)!.s + frames.at(-1)!.p.distanceTo(frames[0]!.p);
}

export function buildRoadRibbon(spec: RoadSpec): RoadRibbon {
  const frames = buildRoadFrames(spec);
  const n = frames.length;
  const lengthM = loopLength(frames);
  const spawnIndex = spec.spawnAt
    ? nearestFrame(frames, spec.spawnAt[0] + spec.origin.x, spec.spawnAt[1] + spec.origin.z).index
    : Math.round((spec.spawnFraction ?? 0) * n) % n;
  const frameAtDistance = (fromSpawnM: number): RoadFrame => {
    const target = ((frames[spawnIndex]!.s + fromSpawnM) % lengthM + lengthM) % lengthM;
    let best = 0;
    for (let i = 0; i < n; i++) if (Math.abs(frames[i]!.s - target) < Math.abs(frames[best]!.s - target)) best = i;
    return frames[best]!;
  };
  const gate = (frame: RoadFrame, id: string, finish: boolean): WorldCheckpoint => ({
    id, center: vec(frame.p.clone().addScaledVector(frame.n, 0.12)), forward: vec(frame.t),
    halfWidthM: spec.widthM / 2 + 1, ...(finish ? { finish: true } : {}),
  });
  const checkpoints = spec.gateFractions.map((fraction, index) =>
    gate(frameAtDistance(fraction * lengthM), `${spec.gatePrefix}-CP-${String(index + 1).padStart(2, '0')}`, false));
  checkpoints.push(gate(frameAtDistance(-(spec.finishBehindSpawnM ?? 12)),
    `${spec.gatePrefix}-CP-${String(spec.gateFractions.length + 1).padStart(2, '0')}`, true));
  const spawnFrame = frames[spawnIndex]!;
  const spawn = {
    position: vec(spawnFrame.p.clone().addScaledVector(spawnFrame.n, 0.85)),
    rotation: yawQuatFromForward(spawnFrame.t),
  };
  // Spawn-ordered centerline every ~8 m, closed by repeating the first point (as HW-01).
  const stride = Math.max(1, Math.round(8 / (spec.spacingM ?? 2)));
  const centerline: Vec3[] = [];
  for (let k = 0; k < n; k += stride) centerline.push(vec(frames[(spawnIndex + k) % n]!.p));
  centerline.push(centerline[0]!);
  const route: RouteDefinition = {
    id: spec.id, name: spec.name, district: spec.district, version: spec.version, roadIds: [spec.roadId],
    centerline, widthM: spec.widthM, closed: true, lengthM, spawn, checkpoints,
    ...(spec.clippingZones ? { clippingZones: spec.clippingZones } : {}),
  };
  return { spec, frames, lengthM, spawnIndex, route };
}

/** Point on the (banked) road plane: `lat` metres right of centre, `lift` metres along the normal. */
export function framePoint(frame: RoadFrame, lat: number, lift = 0, out = new THREE.Vector3()): THREE.Vector3 {
  return out.copy(frame.p).addScaledVector(frame.r, lat).addScaledVector(frame.n, lift);
}

/**
 * A strip that follows the road between two lateral offsets. Winding faces up; segments for which
 * `include(i)` is false (the segment from frame i to i+1) are skipped.
 */
export function ribbonStrip(frames: readonly RoadFrame[], fromLat: number, toLat: number, lift: number, surfaceId: string,
  drivableRoad: boolean, include: (index: number) => boolean = () => true): CollisionMeshData {
  const vertices: Vec3[] = [], indices: number[] = [];
  const n = frames.length;
  for (const frame of frames) vertices.push(vec(framePoint(frame, fromLat, lift)), vec(framePoint(frame, toLat, lift)));
  const up = (a: number, b: number, c: number): void => {
    const pa = vertices[a]!, pb = vertices[b]!, pc = vertices[c]!;
    const ny = (pb.z - pa.z) * (pc.x - pa.x) - (pb.x - pa.x) * (pc.z - pa.z);
    if (ny > 0) indices.push(a, b, c); else indices.push(a, c, b);
  };
  for (let i = 0; i < n; i++) {
    if (!include(i)) continue;
    const a = i * 2, b = ((i + 1) % n) * 2;
    up(a, a + 1, b); up(a + 1, b + 1, b);
  }
  return { vertices, indices, surfaceId, drivableRoad };
}

/**
 * A solid, vertical-walled barrier prism whose inner face sits `lat` metres from centre. Heights are
 * relative to the road edge at that frame. Obstacle role so wall telemetry sees contact.
 */
export function ribbonBarrier(frames: readonly RoadFrame[], side: -1 | 1, lat: number, bottom: number, top: number,
  thickness: number, surfaceId: string, include: (index: number) => boolean = () => true): CollisionMeshData {
  const vertices: Vec3[] = [], indices: number[] = [];
  const n = frames.length;
  const tmp = new THREE.Vector3();
  for (const frame of frames) {
    const edge = framePoint(frame, side * lat, 0, tmp).clone();
    for (const [across, height] of [[0, bottom], [thickness, bottom], [thickness, top], [0, top]] as const) {
      vertices.push(vec(edge.clone().addScaledVector(frame.h, side * across).add(new THREE.Vector3(0, height, 0))));
    }
  }
  const orient = (a: number, b: number, c: number, outward: THREE.Vector3): void => {
    const pa = vertices[a]!, pb = vertices[b]!, pc = vertices[c]!;
    const normal = new THREE.Vector3(pb.x - pa.x, pb.y - pa.y, pb.z - pa.z).cross(new THREE.Vector3(pc.x - pa.x, pc.y - pa.y, pc.z - pa.z));
    if (normal.dot(outward) >= 0) indices.push(a, b, c); else indices.push(a, c, b);
  };
  for (let i = 0; i < n; i++) {
    if (!include(i)) continue;
    const j = (i + 1) % n, frame = frames[i]!;
    // Faces: 0 bottom, 1 outer, 2 top, 3 inner (toward the road).
    const outward = [new THREE.Vector3(0, -1, 0), frame.h.clone().multiplyScalar(side), new THREE.Vector3(0, 1, 0), frame.h.clone().multiplyScalar(-side)];
    for (let edge = 0; edge < 4; edge++) {
      const next = (edge + 1) % 4;
      const a = i * 4 + edge, b = i * 4 + next, c = j * 4 + edge, d = j * 4 + next;
      orient(a, c, b, outward[edge]!); orient(b, c, d, outward[edge]!);
    }
  }
  return { vertices, indices, surfaceId, drivableRoad: false, role: 'obstacle' };
}

/** Horizontal distance and index of the nearest frame (brute force; callers cache where hot). */
export function nearestFrame(frames: readonly RoadFrame[], x: number, z: number): { index: number; distanceM: number } {
  let best = 0, bestD = Infinity;
  for (let i = 0; i < frames.length; i++) {
    const d = (frames[i]!.p.x - x) ** 2 + (frames[i]!.p.z - z) ** 2;
    if (d < bestD) { bestD = d; best = i; }
  }
  return { index: best, distanceM: Math.sqrt(bestD) };
}
