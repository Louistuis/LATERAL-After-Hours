import * as THREE from 'three';
import type { LightSpriteUniforms } from './light-sprites';

/**
 * Moving point lights (traffic on distant roads, aircraft, cable cars): one instanced draw where each
 * instance slides from `from` to `to` and wraps, driven only by the shared time uniform.
 */
export interface MovingLight {
  readonly from: THREE.Vector3;
  readonly to: THREE.Vector3;
  /** Linear HDR colour. */
  readonly color: THREE.Color;
  /** Minimum world radius of the halo, metres. */
  readonly size: number;
  /** Metres per second along the segment. */
  readonly speed: number;
  /** 0..1 start offset along the segment. */
  readonly phase: number;
}

const VERTEX = /* glsl */`
  attribute vec3 iFrom;
  attribute vec3 iTo;
  attribute vec3 iColor;
  attribute vec3 iParams; // size, speed, phase
  uniform float uTime;
  uniform float uScale;
  uniform float uFogDensity;
  varying vec2 vUv;
  varying vec3 vColor;
  void main() {
    float len = max(distance(iFrom, iTo), 1.0);
    float t = fract(iParams.z + uTime * iParams.y / len);
    vec4 mv = modelViewMatrix * vec4(mix(iFrom, iTo, t), 1.0);
    float dist = max(-mv.z, 0.01);
    float size = max(iParams.x, dist * 0.0055);
    mv.xy += position.xy * size * 2.0;
    float ends = smoothstep(0.0, 0.03, t) * smoothstep(1.0, 0.97, t);
    vColor = iColor * uScale * ends * exp(-dist * uFogDensity * 0.5) * clamp(iParams.x / size, 0.35, 1.0);
    vUv = uv;
    gl_Position = projectionMatrix * mv;
  }
`;
const FRAGMENT = /* glsl */`
  varying vec2 vUv;
  varying vec3 vColor;
  void main() {
    vec2 p = vUv * 2.0 - 1.0;
    float r2 = dot(p, p);
    if (r2 >= 1.0) discard;
    float glow = exp(-r2 * 30.0) * 1.6 + pow(1.0 - sqrt(r2), 2.5) * 0.4;
    gl_FragColor = vec4(vColor * glow, 1.0);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

export function createMovingLights(name: string, lights: readonly MovingLight[], uniforms: LightSpriteUniforms): THREE.Mesh {
  const base = new THREE.PlaneGeometry(1, 1);
  const geometry = new THREE.InstancedBufferGeometry();
  geometry.index = base.index;
  geometry.setAttribute('position', base.getAttribute('position'));
  geometry.setAttribute('uv', base.getAttribute('uv'));
  geometry.instanceCount = lights.length;
  const count = Math.max(1, lights.length);
  const from = new Float32Array(count * 3), to = new Float32Array(count * 3), color = new Float32Array(count * 3), params = new Float32Array(count * 3);
  lights.forEach((light, i) => {
    from.set([light.from.x, light.from.y, light.from.z], i * 3);
    to.set([light.to.x, light.to.y, light.to.z], i * 3);
    color.set([light.color.r, light.color.g, light.color.b], i * 3);
    params.set([light.size, light.speed, light.phase], i * 3);
  });
  geometry.setAttribute('iFrom', new THREE.InstancedBufferAttribute(from, 3));
  geometry.setAttribute('iTo', new THREE.InstancedBufferAttribute(to, 3));
  geometry.setAttribute('iColor', new THREE.InstancedBufferAttribute(color, 3));
  geometry.setAttribute('iParams', new THREE.InstancedBufferAttribute(params, 3));
  const material = new THREE.ShaderMaterial({
    name: `${name}-material`, vertexShader: VERTEX, fragmentShader: FRAGMENT,
    uniforms: { uTime: uniforms.time, uScale: uniforms.scale, uFogDensity: uniforms.fogDensity },
    transparent: true, depthWrite: false, depthTest: true, blending: THREE.AdditiveBlending, fog: false,
  });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = name;
  mesh.frustumCulled = false;
  mesh.renderOrder = 6;
  return mesh;
}
