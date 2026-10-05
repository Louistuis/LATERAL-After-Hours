import * as THREE from 'three';

/**
 * Cheap, bloom-free glow for practical lights. Each family is one instanced draw:
 * billboard halos, wet-road reflection streaks, and reflective road studs. They are
 * additive, depth-tested, unlit, and animated by uniforms only (no per-frame CPU
 * work per light), so a whole harbour of lamps costs three draw calls.
 */

export interface GlowInstance {
  readonly position: THREE.Vector3;
  /** Linear HDR colour; values above 1 burn to a hot core after tone mapping. */
  readonly color: THREE.Color;
  /** World radius of the halo in metres. */
  readonly size: number;
  readonly pulseSpeed?: number;
  readonly pulseAmount?: number;
  readonly phase?: number;
}

export interface LightSpriteUniforms {
  time: THREE.IUniform<number>;
  scale: THREE.IUniform<number>;
  fogDensity: THREE.IUniform<number>;
  cameraPosition: THREE.IUniform<THREE.Vector3>;
}

export function createLightUniforms(): LightSpriteUniforms {
  return {
    time: { value: 0 }, scale: { value: 1 }, fogDensity: { value: 0.004 },
    cameraPosition: { value: new THREE.Vector3() },
  };
}

function instancedQuad(count: number): THREE.InstancedBufferGeometry {
  const base = new THREE.PlaneGeometry(1, 1);
  const geometry = new THREE.InstancedBufferGeometry();
  geometry.index = base.index;
  geometry.setAttribute('position', base.getAttribute('position'));
  geometry.setAttribute('uv', base.getAttribute('uv'));
  geometry.instanceCount = count;
  return geometry;
}

const GLOW_VERTEX = /* glsl */`
  attribute vec3 iPos;
  attribute vec3 iColor;
  attribute vec4 iParams; // size, pulse speed, pulse amount, phase
  uniform float uTime;
  uniform float uScale;
  uniform float uFogDensity;
  varying vec2 vUv;
  varying vec3 vColor;
  void main() {
    vec4 mv = modelViewMatrix * vec4(iPos, 1.0);
    float dist = max(-mv.z, 0.01);
    float size = max(iParams.x, dist * 0.0085);
    mv.xy += position.xy * size * 2.0;
    mv.z += min(0.7, dist * 0.02);
    float pulse = 1.0 - iParams.z * (0.5 + 0.5 * sin(uTime * iParams.y + iParams.w));
    float nearFade = smoothstep(1.2, 8.0, dist);
    float haze = exp(-dist * uFogDensity * 0.5);
    float compensation = clamp(iParams.x / size, 0.3, 1.0);
    vColor = iColor * uScale * pulse * nearFade * haze * compensation;
    vUv = uv;
    gl_Position = projectionMatrix * mv;
  }
`;

const GLOW_FRAGMENT = /* glsl */`
  varying vec2 vUv;
  varying vec3 vColor;
  void main() {
    vec2 p = vUv * 2.0 - 1.0;
    float r2 = dot(p, p);
    if (r2 >= 1.0) discard;
    float r = sqrt(r2);
    float core = exp(-r2 * 44.0) * 1.7;
    float halo = pow(1.0 - r, 2.7) * 0.5;
    float streak = exp(-abs(p.y) * 26.0) * pow(1.0 - r, 1.4) * 0.22;
    gl_FragColor = vec4(vColor * (core + halo + streak), 1.0);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

export interface GlowSprites {
  readonly mesh: THREE.Mesh<THREE.InstancedBufferGeometry, THREE.ShaderMaterial>;
}

export function createGlowSprites(name: string, instances: readonly GlowInstance[], uniforms: LightSpriteUniforms): GlowSprites {
  const count = Math.max(1, instances.length);
  const geometry = instancedQuad(instances.length);
  const positions = new Float32Array(count * 3);
  const colors = new Float32Array(count * 3);
  const params = new Float32Array(count * 4);
  instances.forEach((instance, index) => {
    positions.set([instance.position.x, instance.position.y, instance.position.z], index * 3);
    colors.set([instance.color.r, instance.color.g, instance.color.b], index * 3);
    params.set([instance.size, instance.pulseSpeed ?? 0, instance.pulseAmount ?? 0, instance.phase ?? 0], index * 4);
  });
  geometry.setAttribute('iPos', new THREE.InstancedBufferAttribute(positions, 3));
  geometry.setAttribute('iColor', new THREE.InstancedBufferAttribute(colors, 3));
  geometry.setAttribute('iParams', new THREE.InstancedBufferAttribute(params, 4));
  const material = new THREE.ShaderMaterial({
    name: `${name}-material`,
    uniforms: { uTime: uniforms.time, uScale: uniforms.scale, uFogDensity: uniforms.fogDensity },
    vertexShader: GLOW_VERTEX, fragmentShader: GLOW_FRAGMENT,
    transparent: true, depthWrite: false, depthTest: true, blending: THREE.AdditiveBlending, fog: false,
  });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = name;
  mesh.frustumCulled = false;
  mesh.renderOrder = 6;
  return { mesh };
}

const STREAK_VERTEX = /* glsl */`
  attribute vec3 iPos;   // lamp head position; the streak lies on the ground beneath it
  attribute vec3 iColor;
  attribute vec2 iGround; // ground height, unused slot for future tint
  uniform vec3 uCamera;
  uniform float uScale;
  uniform float uFogDensity;
  varying vec2 vUv;
  varying vec3 vColor;
  void main() {
    vec3 ground = vec3(iPos.x, iGround.x, iPos.z);
    vec2 toCamera = uCamera.xz - ground.xz;
    float dist = max(length(toCamera), 0.001);
    vec2 dir = toCamera / dist;
    vec2 across = vec2(-dir.y, dir.x);
    float reach = min(dist, 120.0);
    // The mirror image of a lamp at height h seen from height c lands at c/(c+h) of the way
    // from the viewer; roughness smears it back toward the lamp.
    float start = reach * 0.50;
    float end = reach * 0.97;
    float along = mix(start, end, uv.y);
    float width = (0.55 + 0.028 * reach) * (uv.x * 2.0 - 1.0);
    vec3 world = ground + vec3(dir.x, 0.0, dir.y) * along + vec3(across.x, 0.0, across.y) * width;
    world.y = ground.y + 0.06;
    vUv = uv;
    float nearFade = smoothstep(4.0, 14.0, dist);
    float haze = exp(-dist * uFogDensity * 0.8);
    vColor = iColor * uScale * haze * nearFade * (0.35 + 0.65 * smoothstep(120.0, 30.0, dist));
    gl_Position = projectionMatrix * viewMatrix * vec4(world, 1.0);
  }
`;

const STREAK_FRAGMENT = /* glsl */`
  varying vec2 vUv;
  varying vec3 vColor;
  void main() {
    float across = max(1.0 - abs(vUv.x * 2.0 - 1.0), 0.0);
    float lengthwise = max(sin(vUv.y * 3.14159265), 0.0);
    float a = pow(across, 1.8) * pow(lengthwise, 0.9);
    gl_FragColor = vec4(vColor * a * 0.22, 1.0);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

export interface WetStreakInstance {
  readonly position: THREE.Vector3;
  readonly groundY: number;
  readonly color: THREE.Color;
}

/** Streaks of lamp light lying on the wet ground, always stretched toward the viewer. */
export function createWetStreaks(name: string, instances: readonly WetStreakInstance[], uniforms: LightSpriteUniforms): GlowSprites {
  const count = Math.max(1, instances.length);
  const geometry = instancedQuad(instances.length);
  const positions = new Float32Array(count * 3);
  const colors = new Float32Array(count * 3);
  const ground = new Float32Array(count * 2);
  instances.forEach((instance, index) => {
    positions.set([instance.position.x, instance.position.y, instance.position.z], index * 3);
    colors.set([instance.color.r, instance.color.g, instance.color.b], index * 3);
    ground.set([instance.groundY, 0], index * 2);
  });
  geometry.setAttribute('iPos', new THREE.InstancedBufferAttribute(positions, 3));
  geometry.setAttribute('iColor', new THREE.InstancedBufferAttribute(colors, 3));
  geometry.setAttribute('iGround', new THREE.InstancedBufferAttribute(ground, 2));
  const material = new THREE.ShaderMaterial({
    name: `${name}-material`,
    uniforms: { uCamera: uniforms.cameraPosition, uScale: uniforms.scale, uFogDensity: uniforms.fogDensity },
    vertexShader: STREAK_VERTEX, fragmentShader: STREAK_FRAGMENT,
    transparent: true, depthWrite: false, depthTest: true, blending: THREE.AdditiveBlending, fog: false,
    side: THREE.DoubleSide,
    polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
  });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = name;
  mesh.frustumCulled = false;
  mesh.renderOrder = 3;
  return { mesh };
}

const STUD_VERTEX = /* glsl */`
  attribute vec3 iColor;
  uniform float uScale;
  uniform float uFogDensity;
  uniform float uPixelScale;
  varying vec3 vColor;
  void main() {
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    float dist = max(-mv.z, 0.01);
    gl_PointSize = clamp(uPixelScale * 0.16 / dist + 1.6, 1.6, 7.0);
    vColor = iColor * (0.55 + 0.45 * uScale) * exp(-dist * uFogDensity * 0.6) * smoothstep(0.6, 3.0, dist);
    gl_Position = projectionMatrix * mv;
  }
`;

const STUD_FRAGMENT = /* glsl */`
  varying vec3 vColor;
  void main() {
    vec2 p = gl_PointCoord * 2.0 - 1.0;
    float r2 = dot(p, p);
    if (r2 > 1.0) discard;
    float a = exp(-r2 * 3.2);
    gl_FragColor = vec4(vColor * a, 1.0);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

export interface StudInstance { readonly position: THREE.Vector3; readonly color: THREE.Color }

/** Reflective cat-eyes that define the road edge and apex at night. One Points draw. */
export function createRoadStuds(name: string, instances: readonly StudInstance[], uniforms: LightSpriteUniforms,
  pixelScale: THREE.IUniform<number>): THREE.Points<THREE.BufferGeometry, THREE.ShaderMaterial> {
  const geometry = new THREE.BufferGeometry();
  const positions = new Float32Array(instances.length * 3);
  const colors = new Float32Array(instances.length * 3);
  instances.forEach((instance, index) => {
    positions.set([instance.position.x, instance.position.y, instance.position.z], index * 3);
    colors.set([instance.color.r, instance.color.g, instance.color.b], index * 3);
  });
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('iColor', new THREE.BufferAttribute(colors, 3));
  const material = new THREE.ShaderMaterial({
    name: `${name}-material`,
    uniforms: { uScale: uniforms.scale, uFogDensity: uniforms.fogDensity, uPixelScale: pixelScale },
    vertexShader: STUD_VERTEX, fragmentShader: STUD_FRAGMENT,
    transparent: true, depthWrite: false, depthTest: true, blending: THREE.AdditiveBlending, fog: false,
  });
  const points = new THREE.Points(geometry, material);
  points.name = name;
  points.frustumCulled = false;
  points.renderOrder = 5;
  return points;
}
