import * as THREE from 'three';

/**
 * Analytic contact shadow under a car, on every tier: one transparent quad (one draw, one tiny program)
 * whose fragment shader evaluates a soft rounded rectangle. It grounds the car where the sun shadow map
 * is too coarse (Low's 1024 map, night with the sun down, the garage), and darkens the wet mirror under
 * the body so High/Ultra reflections do not show the road straight through the car.
 */
export interface ContactShadow {
  readonly mesh: THREE.Mesh;
  /** Measure the body footprint (body-local, forward = -z) and wheel radius. */
  fit(body: THREE.Object3D, wheels: readonly THREE.Object3D[]): void;
  /** World placement for the player car: flat on the ground under the wheels, yaw only. */
  place(bodyPosition: THREE.Vector3, bodyRotation: THREE.Quaternion, wheelPositions: readonly THREE.Vector3[], grounded: number): void;
  dispose(): void;
}

const VERTEX = /* glsl */`
  varying vec2 vL3Local;
  uniform vec2 uL3Extent;
  void main() {
    vL3Local = (uv - 0.5) * uL3Extent;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;
const FRAGMENT = /* glsl */`
  varying vec2 vL3Local;
  uniform vec2 uL3Half;
  uniform float uL3Opacity;
  float l3Box(vec2 p, vec2 b, float r) {
    vec2 q = abs(p) - b + r;
    return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r;
  }
  void main() {
    float d = l3Box(vL3Local, uL3Half, 0.42);
    // Tight umbra right under the sills plus a wide, faint penumbra.
    float core = 1.0 - smoothstep(-0.28, 0.12, d);
    float soft = 1.0 - smoothstep(-0.1, 0.75, d);
    float shade = uL3Opacity * (0.62 * core + 0.38 * soft * soft);
    if (shade < 0.002) discard;
    gl_FragColor = vec4(0.0, 0.0, 0.0, shade);
  }
`;

const MARGIN = 0.9;

export function createContactShadow(opacity = 0.78): ContactShadow {
  const geometry = new THREE.PlaneGeometry(1, 1);
  geometry.rotateX(-Math.PI / 2);
  const half = new THREE.Vector2(0.95, 2.3);
  const extent = new THREE.Vector2(1, 1);
  const material = new THREE.ShaderMaterial({
    name: 'contact-shadow',
    vertexShader: VERTEX,
    fragmentShader: FRAGMENT,
    uniforms: { uL3Half: { value: half }, uL3Extent: { value: extent }, uL3Opacity: { value: opacity } },
    transparent: true, depthWrite: false, toneMapped: false, fog: false,
    polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
  });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = 'contact-shadow';
  mesh.frustumCulled = false;
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  // Before other transparent effects (smoke, glows), after every opaque surface.
  mesh.renderOrder = -1;
  const center = new THREE.Vector3();
  let wheelRadius = 0.34;
  const box = new THREE.Box3();
  const meshBox = new THREE.Box3();
  const inverse = new THREE.Matrix4();
  const relative = new THREE.Matrix4();
  const forward = new THREE.Vector3();
  const offset = new THREE.Vector3();

  function setExtent(halfWidth: number, halfLength: number): void {
    half.set(halfWidth, halfLength);
    extent.set(2 * (halfWidth + MARGIN), 2 * (halfLength + MARGIN));
    mesh.scale.set(extent.x, 1, extent.y);
  }
  setExtent(0.95, 2.3);

  return {
    mesh,
    fit(body, wheels): void {
      body.updateMatrixWorld(true);
      inverse.copy(body.matrixWorld).invert();
      box.makeEmpty();
      body.traverse((node) => {
        if (!(node instanceof THREE.Mesh) || node === mesh || !node.visible) return;
        if (!node.geometry.boundingBox) node.geometry.computeBoundingBox();
        relative.multiplyMatrices(inverse, node.matrixWorld);
        box.union(meshBox.copy(node.geometry.boundingBox!).applyMatrix4(relative));
      });
      if (box.isEmpty()) return;
      box.getCenter(center);
      const size = box.getSize(new THREE.Vector3());
      setExtent(Math.max(0.5, size.x * 0.46), Math.max(1, size.z * 0.46));
      const wheel = wheels[0];
      if (wheel) {
        const wheelBox = new THREE.Box3().setFromObject(wheel);
        if (!wheelBox.isEmpty()) wheelRadius = Math.max(0.2, (wheelBox.max.y - wheelBox.min.y) / 2);
      }
    },
    place(bodyPosition, bodyRotation, wheelPositions, grounded): void {
      let groundY = bodyPosition.y - 0.6;
      if (wheelPositions.length > 0) {
        groundY = 0;
        for (const wheel of wheelPositions) groundY += wheel.y;
        groundY = groundY / wheelPositions.length - wheelRadius;
      }
      forward.set(0, 0, -1).applyQuaternion(bodyRotation);
      const yaw = Math.atan2(-forward.x, -forward.z);
      offset.set(center.x, 0, center.z).applyAxisAngle(THREE.Object3D.DEFAULT_UP, yaw);
      mesh.position.set(bodyPosition.x + offset.x, groundY + 0.015, bodyPosition.z + offset.z);
      mesh.rotation.set(0, yaw, 0);
      material.uniforms.uL3Opacity!.value = opacity * THREE.MathUtils.clamp(grounded, 0, 1);
      mesh.visible = grounded > 0.01;
    },
    dispose(): void {
      mesh.removeFromParent();
      geometry.dispose();
      material.dispose();
    },
  };
}

/**
 * Child contact shadow for cars the scene does not drive itself (online players): fixed under the body at
 * its rest wheel height, so it follows pitch and roll but costs nothing per frame.
 */
export function attachContactShadow(body: THREE.Object3D, wheels: readonly THREE.Object3D[]): ContactShadow {
  const shadow = createContactShadow(0.7);
  shadow.fit(body, wheels);
  const rest = wheels
    .map((wheel) => wheel.userData.restPosition as THREE.Vector3 | undefined)
    .filter((value): value is THREE.Vector3 => value instanceof THREE.Vector3);
  const wheelBox = wheels[0] ? new THREE.Box3().setFromObject(wheels[0]) : null;
  const radius = wheelBox && !wheelBox.isEmpty() ? (wheelBox.max.y - wheelBox.min.y) / 2 : 0.34;
  const restY = rest.length > 0 ? rest.reduce((sum, value) => sum + value.y, 0) / rest.length : -0.36;
  shadow.place(new THREE.Vector3(), new THREE.Quaternion(), [new THREE.Vector3(0, restY, 0)], 1);
  shadow.mesh.position.y = restY - radius + 0.02;
  body.add(shadow.mesh);
  return shadow;
}
