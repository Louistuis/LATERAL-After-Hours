import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { createArcS } from '../../assets-source/3d/arc-s-source';
import { createVelaGt, disposeVelaGt, VELA_GT_BODY_SECTIONS, VELA_GT_PROFILE } from '../../assets-source/3d/vela-gt-source';

const dispose = (root: THREE.Object3D): void => {
  root.traverse((node) => {
    if (!(node instanceof THREE.Mesh)) return;
    node.geometry.dispose();
    for (const material of Array.isArray(node.material) ? node.material : [node.material]) material.dispose();
  });
};

describe('VELA-GT original source profile', () => {
  it('aligns all wheel groups and tire radii to CAR-02 physics dimensions', () => {
    const car = createVelaGt();
    const expected = new Map(VELA_GT_PROFILE.wheelCenters.map((wheel) => [wheel.id, wheel]));
    for (const [id, anchor] of expected) {
      const wheel = car.getObjectByName(id);
      expect(wheel).toBeInstanceOf(THREE.Group);
      expect(wheel!.position.x).toBeCloseTo(anchor.x, 6);
      expect(wheel!.position.y).toBeCloseTo(anchor.y, 6);
      expect(wheel!.position.z).toBeCloseTo(anchor.z, 6);
      const tire = wheel!.getObjectByName('tire-sidewall') as THREE.Mesh;
      expect(tire.geometry).toBeInstanceOf(THREE.CylinderGeometry);
      expect((tire.geometry as THREE.CylinderGeometry).parameters.radiusTop).toBeCloseTo(.33, 6);
      expect((tire.geometry as THREE.CylinderGeometry).parameters.height).toBeCloseTo(.245, 6);
    }
    expect(VELA_GT_PROFILE.wheelCenters[0]!.z - VELA_GT_PROFILE.wheelCenters[2]!.z).toBeCloseTo(-2.72, 6);
    expect(VELA_GT_PROFILE.wheelCenters[1]!.x - VELA_GT_PROFILE.wheelCenters[0]!.x).toBeCloseTo(1.64, 6);
    disposeVelaGt(car);
  });

  it('builds an outward-facing body with a long fastback profile and broader rear quarter than ARC-S', () => {
    const vela = createVelaGt();
    const arc = createArcS();
    const shell = vela.getObjectByName('vela-gt-profile-shell') as THREE.Mesh;
    const positions = shell.geometry.getAttribute('position');
    const normals = shell.geometry.getAttribute('normal');
    for (let i = 0; i < normals.count; i++) {
      expect(Number.isFinite(normals.getX(i))).toBe(true);
      expect(Number.isFinite(normals.getY(i))).toBe(true);
      expect(Number.isFinite(normals.getZ(i))).toBe(true);
    }
    const points = positions;
    const closest = (x: number, y: number, z: number): number => {
      let best = 0, error = Number.POSITIVE_INFINITY;
      for (let i = 0; i < points.count; i++) {
        const d = (points.getX(i) - x) ** 2 + (points.getY(i) - y) ** 2 + (points.getZ(i) - z) ** 2;
        if (d < error) { error = d; best = i; }
      }
      return best;
    };
    expect(normals.getY(closest(0, .96, .15))).toBeGreaterThan(.6);
    expect(normals.getX(closest(-.89, .4, -.4))).toBeLessThan(-.35);
    expect(normals.getX(closest(.99, .4, 1.15))).toBeGreaterThan(.35);
    expect(shell.geometry.boundingBox).toBeTruthy();
    const velaBounds = new THREE.Box3().setFromObject(vela).getSize(new THREE.Vector3());
    const arcBounds = new THREE.Box3().setFromObject(arc).getSize(new THREE.Vector3());
    const velaBodyBounds = new THREE.Box3().setFromObject(shell).getSize(new THREE.Vector3());
    const arcShell = arc.getObjectByName('arc-s-profile-shell');
    expect(arcShell).toBeInstanceOf(THREE.Mesh);
    const arcBodyBounds = new THREE.Box3().setFromObject(arcShell!).getSize(new THREE.Vector3());
    expect(velaBounds.z).toBeGreaterThan(4.25);
    expect(velaBounds.z).toBeGreaterThan(arcBounds.z + .65);
    expect(velaBodyBounds.x).toBeGreaterThan(arcBodyBounds.x + .2);
    expect(vela.getObjectByName('vela-roof-panel')).toBeTruthy();
    expect(vela.getObjectByName('lamp-rear')!.children).toHaveLength(4);
    expect(VELA_GT_BODY_SECTIONS.every((section) => section.sillY < section.shoulderY)).toBe(true);
    for (const axle of [-1.36, 1.36]) {
      const section = VELA_GT_BODY_SECTIONS.find((candidate) => Math.abs(candidate.z - axle) < 1e-6);
      expect(section).toBeTruthy();
      expect(section!.sillY).toBeGreaterThan(VELA_GT_PROFILE.wheelCenters[0]!.y + VELA_GT_PROFILE.wheelRadiusM + .04);
      expect(section!.sillY).toBeLessThan(VELA_GT_PROFILE.wheelCenters[0]!.y + VELA_GT_PROFILE.wheelRadiusM + .09);
      expect(section!.halfWidth).toBeGreaterThan(.82 + .1225 + .03);
      for (const dz of [-.264, -.132, 0, .132, .264]) {
        const archSection = VELA_GT_BODY_SECTIONS.find((candidate) => Math.abs(candidate.z - (axle + dz)) < .002);
        expect(archSection).toBeTruthy();
        const tireTop = VELA_GT_PROFILE.wheelCenters[0]!.y
          + Math.sqrt(VELA_GT_PROFILE.wheelRadiusM ** 2 - dz ** 2);
        expect(archSection!.sillY).toBeGreaterThanOrEqual(tireTop + .044);
      }
    }
    disposeVelaGt(vela);
    dispose(arc);
  });

  it('keeps windshield, side and fastback glazing visible with a distinct opaque roof', () => {
    const car = createVelaGt();
    car.updateMatrixWorld(true);
    const rays = [
      { object: 'windscreen-glazing', ray: new THREE.Raycaster(new THREE.Vector3(0, 1.4, -1.8), new THREE.Vector3(0, .58, -.5).sub(new THREE.Vector3(0, 1.4, -1.8)).normalize()) },
      { object: 'rear-fastback-glazing', ray: new THREE.Raycaster(new THREE.Vector3(0, 1.4, 2.65), new THREE.Vector3(0, .62, .91).sub(new THREE.Vector3(0, 1.4, 2.65)).normalize()) },
      { object: 'side-front-glazing-1', ray: new THREE.Raycaster(new THREE.Vector3(1.45, .53, -.4), new THREE.Vector3(-1, 0, 0)) },
    ];
    for (const { object, ray } of rays) expect(ray.intersectObject(car, true)[0]?.object.name).toBe(object);
    for (const z of [.6, .8, 1.0, 1.2, 1.4]) {
      const y = .88 - (z - .53) * .45 / .97;
      const origin = new THREE.Vector3(0, 1.4, 3);
      const target = new THREE.Vector3(0, y, z);
      const chaseRay = new THREE.Raycaster(origin, target.clone().sub(origin).normalize());
      expect(chaseRay.intersectObject(car, true)[0]?.object.name, `rear chase z=${z}`).toBe('rear-fastback-glazing');
    }
    const roofRay = new THREE.Raycaster(new THREE.Vector3(0, 1.3, .14), new THREE.Vector3(0, -1, 0));
    expect(roofRay.intersectObject(car, true)[0]?.object.name).toBe('vela-roof-panel');
    const glass = car.getObjectByName('windscreen-glazing') as THREE.Mesh;
    expect(glass.material).toBeInstanceOf(THREE.MeshStandardMaterial);
    expect((glass.material as THREE.MeshStandardMaterial).transparent).toBe(true);
    const checkPaneNearCorners = (name: string): void => {
      const pane = car.getObjectByName(name) as THREE.Mesh;
      const vertices = pane.geometry.getAttribute('position');
      const a = new THREE.Vector3().fromBufferAttribute(vertices, 0);
      const b = new THREE.Vector3().fromBufferAttribute(vertices, 1);
      const c = new THREE.Vector3().fromBufferAttribute(vertices, 2);
      const normal = b.clone().sub(a).cross(c.clone().sub(a)).normalize();
      for (const weights of [[.72, .14, .14], [.14, .72, .14]] as const) {
        const target = a.clone().multiplyScalar(weights[0]).addScaledVector(b, weights[1]).addScaledVector(c, weights[2]);
        const ray = new THREE.Raycaster(target.clone().addScaledVector(normal, .08), normal.clone().negate());
        expect(ray.intersectObject(car, true)[0]?.object.name).toBe(name);
      }
    };
    checkPaneNearCorners('windscreen-glazing');
    checkPaneNearCorners('rear-fastback-glazing');
    checkPaneNearCorners('side-front-glazing-1');
    checkPaneNearCorners('side-rear-glazing-1');
    expect(car.getObjectByName('brake-lights')).toBeTruthy();
    expect(car.getObjectByName('reverse-lights')).toBeTruthy();
    disposeVelaGt(car);
  });

  it('stays within geometry budget and disposes shared resources once', () => {
    const car = createVelaGt();
    const lod = createVelaGt({ lod: 1 });
    const geometries = new Set<THREE.BufferGeometry>();
    const materials = new Set<THREE.Material>();
    let triangles = 0, highVertices = 0, lowVertices = 0;
    car.traverse((node) => {
      if (!(node instanceof THREE.Mesh)) return;
      geometries.add(node.geometry);
      triangles += (node.geometry.index?.count ?? node.geometry.getAttribute('position').count) / 3;
      highVertices += node.geometry.getAttribute('position').count;
      for (const material of Array.isArray(node.material) ? node.material : [node.material]) materials.add(material);
    });
    lod.traverse((node) => { if (node instanceof THREE.Mesh) lowVertices += node.geometry.getAttribute('position').count; });
    expect(triangles).toBeLessThan(12_000);
    expect(lowVertices).toBeLessThan(highVertices);
    expect(geometries.size).toBeGreaterThan(20);
    const disposedGeometry = new Set<THREE.BufferGeometry>();
    const disposedMaterial = new Set<THREE.Material>();
    geometries.forEach((geometry) => geometry.addEventListener('dispose', () => disposedGeometry.add(geometry)));
    materials.forEach((material) => material.addEventListener('dispose', () => disposedMaterial.add(material)));
    disposeVelaGt(car);
    expect(disposedGeometry.size).toBe(geometries.size);
    expect(disposedMaterial.size).toBe(materials.size);
    disposeVelaGt(lod);
  });
});
