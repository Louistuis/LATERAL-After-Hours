import * as THREE from 'three';
import type { FrameSnapshot, QualityPreset } from '../../contracts/runtime-contracts';
import { VEHICLE_CONFIGS } from '../vehicle/configs';
import type { VisualVehicleState } from '../scene-pipeline/interpolate';
import type { AtmosphereRecipe } from '../scene-pipeline/atmosphere';
import { tyreSmokeTint } from '../economy/fx-state';

export interface TireEffectsStats {
  readonly visibleSmoke: number;
  readonly activeSkidSegments: number;
}

export interface TireEffects {
  /** Consume visual state synchronously; the interpolator reuses its storage next frame. */
  update(frame: FrameSnapshot, visual: VisualVehicleState, dtSeconds: number, simulationActive: boolean): void;
  reset(): void;
  setQuality(quality: QualityPreset): void;
  /** Tint smoke so puffs sit in the current dusk/night light. */
  setAtmosphere(recipe: AtmosphereRecipe): void;
  stats(): TireEffectsStats;
  dispose(): void;
}

const CAPS: Readonly<Record<QualityPreset, Readonly<{ smoke: number; skids: number; sparks: number }>>> = {
  low: { smoke: 100, skids: 144, sparks: 48 },
  balanced: { smoke: 300, skids: 384, sparks: 140 },
  high: { smoke: 600, skids: 768, sparks: 280 },
  ultra: { smoke: 900, skids: 1024, sparks: 400 },
};

const SMOKE_VERTEX = /* glsl */`
  attribute vec2 aCorner;
  attribute vec2 aSize;
  attribute float aOpacity;
  attribute float aSeed;
  attribute vec3 aTint;
  varying float vOpacity;
  varying float vSeed;
  varying vec3 vTint;
  varying vec2 vCorner;
  void main() {
    vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
    mvPosition.xy += aCorner * aSize;
    gl_Position = projectionMatrix * mvPosition;
    vOpacity = aOpacity;
    vSeed = aSeed;
    vTint = aTint;
    vCorner = aCorner;
  }
`;

// Billowy puffs: a soft falloff broken up by per-particle value noise, darker toward the
// core so overlapping particles read as volume rather than flat discs.
const SMOKE_FRAGMENT = /* glsl */`
  varying float vOpacity;
  varying float vSeed;
  varying vec3 vTint;
  varying vec2 vCorner;
  float h21(vec2 p) { p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
  float vn(vec2 p) {
    vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
    return mix(mix(h21(i), h21(i + vec2(1.0, 0.0)), f.x), mix(h21(i + vec2(0.0, 1.0)), h21(i + vec2(1.0, 1.0)), f.x), f.y);
  }
  void main() {
    float r = length(vCorner);
    if (r > 1.0) discard;
    float a = vSeed * 6.2831;
    mat2 rot = mat2(cos(a), -sin(a), sin(a), cos(a));
    vec2 q = rot * vCorner;
    float n = 0.6 * vn(q * 2.4 + vSeed * 31.0) + 0.4 * vn(q * 5.3 - vSeed * 17.0);
    float edge = 1.0 - smoothstep(0.35 + 0.3 * n, 1.0, r);
    float cloud = edge * edge * (0.45 + 0.85 * n);
    float shade = 0.72 + 0.4 * n - 0.22 * (1.0 - r);
    gl_FragColor = vec4(vTint * shade, vOpacity * cloud);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

const SPARK_VERTEX = /* glsl */`
  attribute float aLife;
  uniform float uScale;
  varying float vLife;
  void main() {
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    float dist = max(-mv.z, 0.5);
    gl_PointSize = clamp(uScale * 0.085 * (0.4 + aLife) / dist, 1.5, 10.0);
    vLife = aLife;
    gl_Position = projectionMatrix * mv;
  }
`;

const SPARK_FRAGMENT = /* glsl */`
  varying float vLife;
  void main() {
    vec2 p = gl_PointCoord * 2.0 - 1.0;
    float r2 = dot(p, p);
    if (r2 > 1.0) discard;
    float core = exp(-r2 * 4.0);
    vec3 hot = mix(vec3(2.6, 0.45, 0.08), vec3(3.4, 2.0, 0.85), smoothstep(0.25, 0.9, vLife));
    gl_FragColor = vec4(hot * core * smoothstep(0.0, 0.25, vLife), 1.0);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

interface Particle {
  readonly position: THREE.Vector3;
  readonly velocity: THREE.Vector3;
  age: number;
  life: number;
  size: number;
  opacity: number;
  tint: number;
  seed: number;
}

interface SkidSegment {
  readonly start: THREE.Vector3;
  readonly end: THREE.Vector3;
  age: number;
  life: number;
  active: boolean;
}

function smooth01(value: number): number {
  const t = THREE.MathUtils.clamp(value, 0, 1);
  return t * t * (3 - 2 * t);
}

function createTireEffects(scene: THREE.Scene, initialQuality: QualityPreset): TireEffects {
  const smokeMaterial = new THREE.ShaderMaterial({
    uniforms: {},
    vertexShader: SMOKE_VERTEX,
    fragmentShader: SMOKE_FRAGMENT,
    transparent: true,
    depthTest: true,
    depthWrite: false,
    blending: THREE.NormalBlending,
    toneMapped: true,
  });
  const sparkUniforms = { uScale: { value: 900 } };
  const sparkMaterial = new THREE.ShaderMaterial({
    uniforms: sparkUniforms, vertexShader: SPARK_VERTEX, fragmentShader: SPARK_FRAGMENT,
    transparent: true, depthTest: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false,
  });
  const skidMaterial = new THREE.MeshBasicMaterial({
    color: 0xffffff,
    vertexColors: true,
    // Rubber darkens whatever asphalt, puddle or lamp glow lies beneath it.
    transparent: true,
    blending: THREE.MultiplyBlending,
    premultipliedAlpha: true,
    depthTest: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    toneMapped: false,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
  });
  const smoke = new THREE.Mesh(new THREE.BufferGeometry(), smokeMaterial);
  smoke.frustumCulled = false;
  smoke.renderOrder = 4;
  const skidMesh = new THREE.Mesh(new THREE.BufferGeometry(), skidMaterial);
  skidMesh.frustumCulled = false;
  skidMesh.renderOrder = 2;
  const sparks = new THREE.Points(new THREE.BufferGeometry(), sparkMaterial);
  sparks.frustumCulled = false;
  sparks.renderOrder = 5;
  scene.add(skidMesh, smoke, sparks);

  let quality = initialQuality;
  let particles: Particle[] = [];
  let skidSegments: SkidSegment[] = [];
  let smokePositions = new Float32Array();
  let smokeSizes = new Float32Array();
  let smokeOpacities = new Float32Array();
  let smokeTints = new Float32Array();
  let smokeCorners = new Float32Array();
  let smokeSeeds = new Float32Array();
  let skidPositions = new Float32Array();
  let skidColors = new Float32Array();
  let skidHead = 0;
  let skidCount = 0;
  const emissionRemainder = [0, 0];
  const lastSkidPoint = [new THREE.Vector3(), new THREE.Vector3()];
  const hasLastSkidPoint = [false, false];
  const down = new THREE.Vector3(0, -1, 0);
  const worldUp = new THREE.Vector3(0, 1, 0);
  const direction = new THREE.Vector3();
  const lateral = new THREE.Vector3();
  const side = new THREE.Vector3();
  const tangent = new THREE.Vector3();
  const smokeWheelPoints = [new THREE.Vector3(), new THREE.Vector3()];
  const skidWheelPoints = [new THREE.Vector3(), new THREE.Vector3()];
  const smokeBase = new THREE.Color('#9a9aa6');
  const smokeWarm = new THREE.Color('#ffb37a');
  const smokeColor = new THREE.Color();
  let sparkPositions = new Float32Array();
  let sparkLives = new Float32Array();
  let sparkVelocities = new Float32Array();
  let sparkTtl = new Float32Array();
  let sparkGround = new Float32Array();
  let sparkCursor = 0;
  let lastImpactTick = -1;
  const sparkEmission = [0, 0];
  const statsState = { visibleSmoke: 0, activeSkidSegments: 0 };
  let randomState = 0x6d2b79f5;
  let lastTick = -1;
  let lastCarId = '';
  const lastVehiclePosition = new THREE.Vector3();
  let disposed = false;

  function random(): number {
    randomState ^= randomState << 13;
    randomState ^= randomState >>> 17;
    randomState ^= randomState << 5;
    return (randomState >>> 0) / 0x1_0000_0000;
  }

  function clearGeometry(geometry: THREE.BufferGeometry): void {
    geometry.dispose();
  }

  function allocatePools(preset: QualityPreset): void {
    const caps = CAPS[preset];
    particles = Array.from({ length: caps.smoke }, () => ({
      position: new THREE.Vector3(), velocity: new THREE.Vector3(),
      age: 1, life: 0, size: 0, opacity: 0, tint: 0, seed: 0,
    }));
    smokePositions = new Float32Array(caps.smoke * 6 * 3);
    smokeSizes = new Float32Array(caps.smoke * 6 * 2);
    smokeOpacities = new Float32Array(caps.smoke * 6);
    smokeTints = new Float32Array(caps.smoke * 6 * 3);
    smokeCorners = new Float32Array(caps.smoke * 6 * 2);
    smokeSeeds = new Float32Array(caps.smoke * 6);
    const quadCorners = [-1, -1, 1, -1, 1, 1, -1, -1, 1, 1, -1, 1];
    for (let vertex = 0; vertex < caps.smoke * 6; vertex++) {
      smokeCorners[vertex * 2] = quadCorners[(vertex % 6) * 2]!;
      smokeCorners[vertex * 2 + 1] = quadCorners[(vertex % 6) * 2 + 1]!;
    }
    const smokeGeometry = new THREE.BufferGeometry();
    smokeGeometry.setAttribute('position', new THREE.BufferAttribute(smokePositions, 3).setUsage(THREE.DynamicDrawUsage));
    smokeGeometry.setAttribute('aCorner', new THREE.BufferAttribute(smokeCorners, 2));
    smokeGeometry.setAttribute('aSize', new THREE.BufferAttribute(smokeSizes, 2).setUsage(THREE.DynamicDrawUsage));
    smokeGeometry.setAttribute('aOpacity', new THREE.BufferAttribute(smokeOpacities, 1).setUsage(THREE.DynamicDrawUsage));
    smokeGeometry.setAttribute('aSeed', new THREE.BufferAttribute(smokeSeeds, 1).setUsage(THREE.DynamicDrawUsage));
    smokeGeometry.setAttribute('aTint', new THREE.BufferAttribute(smokeTints, 3).setUsage(THREE.DynamicDrawUsage));
    const oldSmoke = smoke.geometry;
    smoke.geometry = smokeGeometry;
    clearGeometry(oldSmoke);

    skidSegments = Array.from({ length: caps.skids }, () => ({
      start: new THREE.Vector3(), end: new THREE.Vector3(), age: 0, life: 8, active: false,
    }));
    skidPositions = new Float32Array(caps.skids * 18);
    skidColors = new Float32Array(caps.skids * 18);
    const skidGeometry = new THREE.BufferGeometry();
    skidGeometry.setAttribute('position', new THREE.BufferAttribute(skidPositions, 3).setUsage(THREE.DynamicDrawUsage));
    skidGeometry.setAttribute('color', new THREE.BufferAttribute(skidColors, 3).setUsage(THREE.DynamicDrawUsage));
    skidGeometry.setDrawRange(0, 0);
    const oldSkid = skidMesh.geometry;
    skidMesh.geometry = skidGeometry;
    clearGeometry(oldSkid);
    sparkPositions = new Float32Array(caps.sparks * 3);
    sparkLives = new Float32Array(caps.sparks);
    sparkVelocities = new Float32Array(caps.sparks * 3);
    sparkTtl = new Float32Array(caps.sparks);
    sparkGround = new Float32Array(caps.sparks);
    sparkCursor = 0;
    const sparkGeometry = new THREE.BufferGeometry();
    sparkGeometry.setAttribute('position', new THREE.BufferAttribute(sparkPositions, 3).setUsage(THREE.DynamicDrawUsage));
    sparkGeometry.setAttribute('aLife', new THREE.BufferAttribute(sparkLives, 1).setUsage(THREE.DynamicDrawUsage));
    sparkGeometry.setDrawRange(0, 0);
    const oldSparks = sparks.geometry;
    sparks.geometry = sparkGeometry;
    clearGeometry(oldSparks);
    skidHead = 0;
    skidCount = 0;
    statsState.visibleSmoke = 0;
    statsState.activeSkidSegments = 0;
  }

  function clearEffects(): void {
    for (const particle of particles) particle.life = 0;
    for (const segment of skidSegments) segment.active = false;
    emissionRemainder[0] = 0;
    emissionRemainder[1] = 0;
    hasLastSkidPoint[0] = false;
    hasLastSkidPoint[1] = false;
    skidHead = 0;
    skidCount = 0;
    statsState.visibleSmoke = 0;
    statsState.activeSkidSegments = 0;
    smokeOpacities.fill(0);
    smoke.geometry.attributes.aOpacity.needsUpdate = true;
    smoke.geometry.setDrawRange(0, 0);
    skidMesh.geometry.setDrawRange(0, 0);
    sparkTtl.fill(0);
    sparkLives.fill(0);
    sparkEmission[0] = 0;
    sparkEmission[1] = 0;
    sparks.geometry.setDrawRange(0, 0);
  }

  function emitParticle(wheelIndex: number, position: THREE.Vector3, visual: VisualVehicleState, slip: number, load: number): void {
    let particle: Particle | undefined;
    for (let i = 0; i < particles.length; i++) {
      const candidate = particles[(i + wheelIndex * 37) % particles.length]!;
      if (candidate.life <= 0) { particle = candidate; break; }
    }
    if (!particle) return;

    direction.set(visual.velocity.x, 0, visual.velocity.z);
    const speed = direction.length();
    if (speed > 0.001) direction.multiplyScalar(-1 / speed);
    else direction.set(0, 0, 1).applyQuaternion(visual.rotation);
    lateral.set(-direction.z, 0, direction.x).multiplyScalar((wheelIndex === 0 ? -1 : 1) * THREE.MathUtils.clamp(slip, 0, 1) * 0.7);
    particle.position.copy(position).addScaledVector(down, 0.015);
    particle.position.x += (random() - 0.5) * 0.08;
    particle.position.z += (random() - 0.5) * 0.08;
    particle.velocity.copy(direction).multiplyScalar(0.8 + speed * 0.14)
      .add(lateral)
      .addScaledVector(worldUp, 0.24 + random() * 0.24);
    particle.velocity.x += (random() - 0.5) * 0.35;
    particle.velocity.z += (random() - 0.5) * 0.35;
    particle.age = 0;
    particle.life = 1.5 + random() * 0.7;
    particle.size = 0.78 + random() * 0.3 + slip * 0.2;
    particle.opacity = 0.24 + 0.2 * slip * Math.min(1, load);
    particle.tint = random();
    particle.seed = random();
  }

  function emitSkid(start: THREE.Vector3, end: THREE.Vector3): void {
    const segment = skidSegments[skidHead]!;
    segment.start.copy(start);
    segment.end.copy(end);
    segment.age = 0;
    segment.life = 7.5;
    segment.active = true;
    skidHead = (skidHead + 1) % skidSegments.length;
    skidCount = Math.min(skidCount + 1, skidSegments.length);
  }

  function updateSmoke(dt: number, frame: FrameSnapshot, visual: VisualVehicleState): void {
    const config = VEHICLE_CONFIGS[frame.current.carId];
    const speed = Math.hypot(visual.velocity.x, visual.velocity.z);
    const groundSpeed = THREE.MathUtils.clamp((speed - 2.2) / 7, 0, 1);
    for (let rear = 0; rear < 2; rear++) {
      const wheelIndex = rear + 2;
      const wheel = frame.current.wheels[wheelIndex]!;
      const slip = Math.max(
        THREE.MathUtils.clamp(Math.abs(wheel.slipAngleRad) / 0.42, 0, 1),
        THREE.MathUtils.clamp(Math.abs(wheel.slipRatio) / 0.72, 0, 1),
      );
      const load = THREE.MathUtils.clamp(wheel.normalLoadN / (config.massKg * 9.81 / 4), 0, 1.5);
      if (!wheel.contact || wheel.normalLoadN < 260 || groundSpeed <= 0 || slip < 0.34) {
        emissionRemainder[rear] = 0;
        continue;
      }
      const rate = (8 + 34 * slip) * Math.min(1, load) * groundSpeed;
      emissionRemainder[rear] += rate * dt;
      const wheelPoint = smokeWheelPoints[rear]!.copy(visual.wheels[wheelIndex]!.position);
      wheelPoint.addScaledVector(down, config.wheelRadiusM);
      while (emissionRemainder[rear] >= 1) {
        emitParticle(rear, wheelPoint, visual, slip, load);
        emissionRemainder[rear] -= 1;
      }
    }

    let output = 0;
    for (const particle of particles) {
      if (particle.life <= 0) continue;
      particle.age += dt;
      if (particle.age >= particle.life) { particle.life = 0; continue; }
      particle.position.addScaledVector(particle.velocity, dt);
      particle.velocity.y += 0.12 * dt;
      particle.velocity.multiplyScalar(1 - 0.25 * dt);
      const normalizedAge = particle.age / particle.life;
      const opacity = particle.opacity * smooth01(particle.age / 0.12) * (1 - smooth01((normalizedAge - 0.2) / 0.8));
      const index = output++;
      const width = particle.size * (0.78 + 0.85 * normalizedAge);
      const height = particle.size * (0.52 + 0.8 * normalizedAge);
      // Lit from below by headlights while young, then settles into the ambient haze colour.
      const glow = Math.max(0, 1 - normalizedAge * 2.2);
      const brightness = 0.5 + particle.tint * 0.2 + glow * 0.35;
      smokeColor.copy(tyreSmokeTint() ?? smokeBase).lerp(smokeWarm, 0.1 + 0.3 * glow * particle.tint).multiplyScalar(brightness);
      for (let vertex = 0; vertex < 6; vertex++) {
        const attributeIndex = index * 6 + vertex;
        const p3 = attributeIndex * 3;
        const p2 = attributeIndex * 2;
        smokePositions[p3] = particle.position.x;
        smokePositions[p3 + 1] = particle.position.y;
        smokePositions[p3 + 2] = particle.position.z;
        smokeSizes[p2] = width;
        smokeSizes[p2 + 1] = height;
        smokeOpacities[attributeIndex] = opacity;
        smokeSeeds[attributeIndex] = particle.seed;
        smokeTints[p3] = smokeColor.r;
        smokeTints[p3 + 1] = smokeColor.g;
        smokeTints[p3 + 2] = smokeColor.b;
      }
    }
    statsState.visibleSmoke = output;
    const geometry = smoke.geometry;
    geometry.setDrawRange(0, output * 6);
    (geometry.attributes.position as THREE.BufferAttribute).needsUpdate = true;
    (geometry.attributes.aSize as THREE.BufferAttribute).needsUpdate = true;
    (geometry.attributes.aOpacity as THREE.BufferAttribute).needsUpdate = true;
    (geometry.attributes.aTint as THREE.BufferAttribute).needsUpdate = true;
    (geometry.attributes.aSeed as THREE.BufferAttribute).needsUpdate = true;
  }

  function updateSkids(dt: number, frame: FrameSnapshot, visual: VisualVehicleState): void {
    const config = VEHICLE_CONFIGS[frame.current.carId];
    const speed = Math.hypot(visual.velocity.x, visual.velocity.z);
    for (let rear = 0; rear < 2; rear++) {
      const wheelIndex = rear + 2;
      const wheel = frame.current.wheels[wheelIndex]!;
      const slip = Math.max(Math.abs(wheel.slipAngleRad), Math.abs(wheel.slipRatio) * 0.28);
      const contact = wheel.contact && wheel.normalLoadN > 700 && speed > 4.2 && slip > 0.105;
      const point = skidWheelPoints[rear]!.copy(visual.wheels[wheelIndex]!.position);
      point.addScaledVector(down, config.wheelRadiusM + 0.012);
      if (!contact) { hasLastSkidPoint[rear] = false; continue; }
      if (!hasLastSkidPoint[rear]) {
        lastSkidPoint[rear].copy(point);
        hasLastSkidPoint[rear] = true;
        continue;
      }
      const distance = lastSkidPoint[rear].distanceTo(point);
      if (distance >= 0.22) {
        emitSkid(lastSkidPoint[rear], point);
        lastSkidPoint[rear].copy(point);
      }
    }

    let vertexCount = 0;
    let active = 0;
    // Traverse insertion order so overlapping marks draw consistently.
    const first = (skidHead - skidCount + skidSegments.length) % skidSegments.length;
    for (let i = 0; i < skidCount; i++) {
      const segment = skidSegments[(first + i) % skidSegments.length]!;
      if (!segment.active) continue;
      segment.age += dt;
      if (segment.age >= segment.life) { segment.active = false; continue; }
      tangent.subVectors(segment.end, segment.start);
      tangent.y = 0;
      const length = tangent.length();
      if (length < 1e-4) continue;
      tangent.multiplyScalar(1 / length);
      side.crossVectors(tangent, worldUp).normalize().multiplyScalar(0.085);
      const fade = 1 - smooth01(segment.age / segment.life);
      // Vertex colors fade the mark into the authored asphalt without a second transparent pass.
      const shade = 1 - 0.74 * fade;
      for (let vertex = 0; vertex < 6; vertex++) {
        const source = vertex === 0 || vertex === 1 || vertex === 3 ? segment.start : segment.end;
        const sign = vertex === 0 || vertex === 3 || vertex === 5 ? 1 : -1;
        const p3 = vertexCount * 3;
        skidPositions[p3] = source.x + side.x * sign;
        skidPositions[p3 + 1] = source.y + side.y * sign;
        skidPositions[p3 + 2] = source.z + side.z * sign;
        skidColors[p3] = shade;
        skidColors[p3 + 1] = shade * 0.98;
        skidColors[p3 + 2] = shade;
        vertexCount++;
      }
      active++;
    }
    statsState.activeSkidSegments = active;
    const geometry = skidMesh.geometry;
    geometry.setDrawRange(0, vertexCount);
    (geometry.attributes.position as THREE.BufferAttribute).needsUpdate = true;
    (geometry.attributes.color as THREE.BufferAttribute).needsUpdate = true;
  }

  function spawnSpark(position: THREE.Vector3, vx: number, vy: number, vz: number, groundY: number, ttl: number): void {
    const count = sparkTtl.length;
    if (count === 0) return;
    const i = sparkCursor;
    sparkCursor = (sparkCursor + 1) % count;
    sparkPositions[i * 3] = position.x; sparkPositions[i * 3 + 1] = position.y; sparkPositions[i * 3 + 2] = position.z;
    sparkVelocities[i * 3] = vx; sparkVelocities[i * 3 + 1] = vy; sparkVelocities[i * 3 + 2] = vz;
    sparkTtl[i] = ttl; sparkLives[i] = 1; sparkGround[i] = groundY;
  }

  function updateSparks(dt: number, frame: FrameSnapshot, visual: VisualVehicleState): void {
    const config = VEHICLE_CONFIGS[frame.current.carId];
    const speed = Math.hypot(visual.velocity.x, visual.velocity.z);
    // Hard sideways drifts throw a thin trail of sparks from the rear tyres.
    for (let rear = 0; rear < 2; rear++) {
      const wheelIndex = rear + 2;
      const wheel = frame.current.wheels[wheelIndex]!;
      const slip = THREE.MathUtils.clamp(Math.abs(wheel.slipAngleRad) / 0.5, 0, 1);
      if (!wheel.contact || wheel.normalLoadN < 600 || speed < 8 || slip < 0.62) { sparkEmission[rear] = 0; continue; }
      sparkEmission[rear] += (10 + 26 * slip) * dt * Math.min(1, speed / 18);
      const point = smokeWheelPoints[rear]!.copy(visual.wheels[wheelIndex]!.position);
      point.y -= config.wheelRadiusM - 0.03;
      while (sparkEmission[rear] >= 1) {
        sparkEmission[rear] -= 1;
        const back = -1 / Math.max(speed, 0.001);
        spawnSpark(point, visual.velocity.x * back * (1.5 + random() * 3) + (random() - 0.5) * 2.6,
          0.8 + random() * 2.4, visual.velocity.z * back * (1.5 + random() * 3) + (random() - 0.5) * 2.6,
          point.y - 0.02, 0.35 + random() * 0.45);
      }
    }
    const impact = frame.impact;
    if (impact && impact.simulationTick !== lastImpactTick) {
      lastImpactTick = impact.simulationTick;
      const origin = smokeWheelPoints[0]!.copy(visual.position);
      origin.y -= 0.25;
      // A light, repeated contact is a wall scrape (walls deflect rather than stop the car): a short trail of sparks
      // thrown back along the car's path each contact step, instead of a full radial crash burst.
      const scrape = impact.speedDeltaMS < 1.5 && speed > 6;
      const burst = scrape ? 4 : THREE.MathUtils.clamp(Math.round(impact.impulseNs / 650), 10, 70);
      for (let i = 0; i < burst && scrape; i++) {
        const back = -(0.25 + random() * 0.35);
        spawnSpark(origin, visual.velocity.x * back + (random() - 0.5) * 2, 0.6 + random() * 2,
          visual.velocity.z * back + (random() - 0.5) * 2, origin.y - 0.4, 0.25 + random() * 0.35);
      }
      for (let i = 0; i < burst && !scrape; i++) {
        const angle = random() * Math.PI * 2;
        const power = 2 + random() * 6.5 + Math.min(5, impact.speedDeltaMS * 0.3);
        spawnSpark(origin, Math.cos(angle) * power + visual.velocity.x * 0.25, 1.5 + random() * 4.5,
          Math.sin(angle) * power + visual.velocity.z * 0.25, origin.y - 0.4, 0.4 + random() * 0.7);
      }
    }
    let alive = 0;
    for (let i = 0; i < sparkTtl.length; i++) {
      if (sparkTtl[i]! <= 0) { sparkLives[i] = 0; continue; }
      sparkTtl[i] = sparkTtl[i]! - dt;
      const k = i * 3;
      sparkVelocities[k + 1] = sparkVelocities[k + 1]! - 9.8 * dt;
      sparkPositions[k] = sparkPositions[k]! + sparkVelocities[k]! * dt;
      sparkPositions[k + 1] = sparkPositions[k + 1]! + sparkVelocities[k + 1]! * dt;
      sparkPositions[k + 2] = sparkPositions[k + 2]! + sparkVelocities[k + 2]! * dt;
      if (sparkPositions[k + 1]! < sparkGround[i]!) {
        sparkPositions[k + 1] = sparkGround[i]!;
        sparkVelocities[k + 1] = Math.abs(sparkVelocities[k + 1]!) * 0.32;
        sparkVelocities[k] = sparkVelocities[k]! * 0.6; sparkVelocities[k + 2] = sparkVelocities[k + 2]! * 0.6;
      }
      sparkLives[i] = THREE.MathUtils.clamp(sparkTtl[i]! / 0.5, 0, 1);
      alive++;
    }
    // The pool is small; drawing all of it (dead points have life 0 and are discarded) avoids compaction.
    sparks.geometry.setDrawRange(0, alive > 0 ? sparkTtl.length : 0);
    (sparks.geometry.attributes.position as THREE.BufferAttribute).needsUpdate = true;
    (sparks.geometry.attributes.aLife as THREE.BufferAttribute).needsUpdate = true;
  }

  allocatePools(quality);

  return {
    update(frame, visual, dtSeconds, simulationActive): void {
      if (disposed) throw new Error('TireEffects is disposed');
      const frameJumped = lastTick > frame.current.simulationTick ||
        (lastCarId !== '' && lastCarId !== frame.current.carId) ||
        (lastTick >= 0 && lastVehiclePosition.distanceTo(visual.position) > 12);
      if (frameJumped) clearEffects();
      lastTick = frame.current.simulationTick;
      lastCarId = frame.current.carId;
      lastVehiclePosition.copy(visual.position);
      if (!simulationActive) return;
      const dt = THREE.MathUtils.clamp(Number.isFinite(dtSeconds) ? dtSeconds : 0, 0, 0.05);
      if (dt === 0) return;
      updateSmoke(dt, frame, visual);
      updateSkids(dt, frame, visual);
      updateSparks(dt, frame, visual);
    },
    reset(): void {
      if (disposed) return;
      clearEffects();
      lastTick = -1;
      lastCarId = '';
    },
    setQuality(preset): void {
      if (disposed || preset === quality) return;
      quality = preset;
      allocatePools(preset);
      clearEffects();
    },
    setAtmosphere(recipe): void {
      smokeBase.set(recipe.smokeLight);
      smokeWarm.set(recipe.smokeWarm);
    },
    stats(): TireEffectsStats { return statsState; },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      scene.remove(skidMesh, smoke, sparks);
      clearGeometry(skidMesh.geometry);
      clearGeometry(smoke.geometry);
      clearGeometry(sparks.geometry);
      skidMaterial.dispose();
      smokeMaterial.dispose();
      sparkMaterial.dispose();
      particles = [];
      skidSegments = [];
    },
  };
}

export { createTireEffects };
