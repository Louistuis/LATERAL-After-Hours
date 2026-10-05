import { afterEach, describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import type { FrameSnapshot, VehicleSnapshot } from '../../contracts/runtime-contracts';
import type { GameScene } from '../../src/core/game-runtime';
import { PlayerCamera } from '../../src/camera/player-camera';

const cameras: PlayerCamera[] = [];
afterEach(() => { for (const camera of cameras.splice(0)) camera.dispose(); });

function vehicle(x = 0, y = 0, z = 0, speed = 0, drift = 0): VehicleSnapshot {
  return {
    simulationTick: 1, carId: 'CAR-01', position: { x, y, z }, rotation: { x: 0, y: 0, z: 0, w: 1 },
    linearVelocityMS: { x: 0, y: 0, z: -speed }, angularVelocityRadS: { x: 0, y: 0, z: 0 },
    wheels: [] as unknown as VehicleSnapshot['wheels'], engineRpm: 1000, gear: 1, driftAngleRad: drift,
  };
}
function frame(previous: VehicleSnapshot, current = previous, alpha = 1): FrameSnapshot {
  return { previous, current, interpolationAlpha: alpha, score: { banked: 0, unbanked: 0, multiplier: 1, validDrift: false, routeProgressM: 0, activeSeconds: 0 } };
}
function impactFrame(tick: number, speedDeltaMS = 8, impulseNs = 1200): FrameSnapshot {
  return { ...frame(vehicle()), impact: { simulationTick: tick, speedDeltaMS, impulseNs } };
}
function setup(cameraOccluders?: readonly THREE.Object3D[]) {
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(55, 16 / 9, .1, 500);
  const canvas = { addEventListener: vi.fn(), removeEventListener: vi.fn(), setPointerCapture: vi.fn() } as unknown as HTMLCanvasElement;
  const resetCamera = vi.fn();
  const gameScene = { scene, camera, renderer: { domElement: canvas }, resetCamera, ...(cameraOccluders === undefined ? {} : { cameraOccluders }) } as unknown as GameScene;
  const controller = new PlayerCamera(gameScene); cameras.push(controller);
  return { scene, camera, resetCamera, controller };
}

describe('PlayerCamera', () => {
  it.each([30, 60, 120])('uses time-based smoothing at %i Hz', fps => {
    const { camera, controller } = setup();
    controller.update(frame(vehicle()), 0, 'drive');
    const moved = frame(vehicle(4));
    for (let i = 0; i < fps; i++) controller.update(moved, 1 / fps, 'drive');
    expect(camera.position.x).toBeCloseTo(4 * (1 - Math.exp(-5.2)), 8);
  });

  it('uses interpolated visual position when snapshots are continuous', () => {
    const { camera, controller } = setup();
    controller.update(frame(vehicle(0), vehicle(2), .5), 0, 'drive');
    expect(camera.position.x).toBeCloseTo(1, 8);
  });

  it.each([[1280, 720], [640, 360]])('keeps the lower rear-body anchor off the bottom edge while retaining a visible road lookahead at %i×%i', (width, height) => {
    const { camera, controller } = setup();
    camera.aspect = width / height; camera.updateProjectionMatrix();
    controller.update(frame(vehicle(0, 0, 0, 8.7)), 0, 'drive');
    camera.updateMatrixWorld(true);
    // Lower anchor stands in for the long VELA rear bumper/wheel extent seen in the pinned capture.
    const rearBody = new THREE.Vector3(0, -0.2, 0).project(camera);
    const roadLookahead = new THREE.Vector3(0, 0, -12).project(camera);
    expect(rearBody.y).toBeGreaterThan(-0.9);
    expect(roadLookahead.y).toBeGreaterThan(-1);
    expect(roadLookahead.y).toBeLessThan(1);
  });

  it('bypasses interpolation across a reset-sized positional discontinuity', () => {
    const { camera, controller } = setup();
    controller.update(frame(vehicle(0), vehicle(20), .1), 0, 'drive');
    expect(camera.position.x).toBeCloseTo(20, 8);
  });

  it('resets camera history immediately for a small safe-point move', () => {
    const { camera, controller, resetCamera } = setup();
    controller.update(frame(vehicle()), 0, 'drive');
    controller.update(frame(vehicle(5)), 1 / 60, 'drive');
    expect(camera.position.x).toBeLessThan(5);
    controller.reset();
    controller.update(frame(vehicle(6)), 1 / 60, 'drive');
    expect(camera.position.x).toBeCloseTo(6, 8);
    expect(resetCamera).toHaveBeenCalledOnce();
  });

  it('pulls toward an explicitly designated solid prop', () => {
    const { scene, camera, controller } = setup();
    const wall = new THREE.Mesh(new THREE.BoxGeometry(6, 3, 1), new THREE.MeshBasicMaterial());
    wall.position.set(0, 2, 2.5); wall.userData.cameraCollision = true; scene.add(wall); scene.updateMatrixWorld(true);
    controller.update(frame(vehicle()), 0, 'drive');
    for (let i = 0; i < 45; i++) controller.update(frame(vehicle()), 1 / 60, 'drive');
    expect(camera.position.z).toBeLessThan(2.7);
  });

  it('uses cached designated candidates and releases pull-in when a candidate becomes hidden', () => {
    const wall = new THREE.Mesh(new THREE.BoxGeometry(6, 3, 1), new THREE.MeshBasicMaterial());
    wall.position.set(0, 2, 2.5); wall.userData.cameraCollision = true;
    const { scene, camera, controller } = setup([wall]);
    scene.add(wall); scene.updateMatrixWorld(true);
    for (let i = 0; i < 45; i++) controller.update(frame(vehicle()), 1 / 60, 'drive');
    expect(camera.position.z).toBeLessThan(2.7);
    wall.visible = false; scene.updateMatrixWorld(true);
    for (let i = 0; i < 90; i++) controller.update(frame(vehicle()), 1 / 60, 'drive');
    expect(camera.position.z).toBeGreaterThan(3.2);
  });

  it('ignores untagged props and designated props hidden by any parent', () => {
    const { scene, camera, controller } = setup();
    const hidden = new THREE.Group(); hidden.visible = false; hidden.userData.cameraCollision = true;
    const hiddenWall = new THREE.Mesh(new THREE.BoxGeometry(6, 3, 1), new THREE.MeshBasicMaterial());
    hiddenWall.position.set(0, 2, 2.5); hidden.add(hiddenWall); scene.add(hidden);
    const untagged = new THREE.Mesh(new THREE.BoxGeometry(6, 3, 1), new THREE.MeshBasicMaterial());
    untagged.position.set(0, 2, 3.5); scene.add(untagged); scene.updateMatrixWorld(true);
    controller.update(frame(vehicle()), 0, 'drive');
    for (let i = 0; i < 45; i++) controller.update(frame(vehicle()), 1 / 60, 'drive');
    expect(camera.position.z).toBeGreaterThan(3.5);
  });

  it('rechecks cached ancestor visibility and child false overrides at raycast time', () => {
    const hiddenParent = new THREE.Group(); hiddenParent.visible = false; hiddenParent.userData.cameraCollision = true;
    const hiddenWall = new THREE.Mesh(new THREE.BoxGeometry(6, 3, 1), new THREE.MeshBasicMaterial()); hiddenWall.position.set(0, 2, 2.5); hiddenParent.add(hiddenWall);
    const taggedParent = new THREE.Group(); taggedParent.userData.cameraCollision = true;
    const excludedChild = new THREE.Mesh(new THREE.BoxGeometry(6, 3, 1), new THREE.MeshBasicMaterial());
    excludedChild.position.set(0, 2, 3.5); excludedChild.userData.cameraCollision = false; taggedParent.add(excludedChild);
    const untagged = new THREE.Mesh(new THREE.BoxGeometry(6, 3, 1), new THREE.MeshBasicMaterial()); untagged.position.set(0, 2, 4.5);
    const { scene, camera, controller } = setup([hiddenWall, excludedChild, untagged]);
    scene.add(hiddenParent, taggedParent, untagged); scene.updateMatrixWorld(true);
    for (let i = 0; i < 45; i++) controller.update(frame(vehicle()), 1 / 60, 'drive');
    expect(camera.position.z).toBeGreaterThan(3.5);
  });

  it('treats a present empty candidate list as authoritative and performs no raycast', () => {
    const wall = new THREE.Mesh(new THREE.BoxGeometry(6, 3, 1), new THREE.MeshBasicMaterial());
    wall.position.set(0, 2, 2.5); wall.userData.cameraCollision = true;
    const { scene, camera, controller } = setup([]);
    scene.add(wall); scene.updateMatrixWorld(true);
    const raycaster = (controller as unknown as { raycaster: THREE.Raycaster }).raycaster;
    const intersect = vi.spyOn(raycaster, 'intersectObjects');
    for (let i = 0; i < 10; i++) controller.update(frame(vehicle()), 1 / 60, 'drive');
    expect(intersect).not.toHaveBeenCalled();
    expect(camera.position.z).toBeGreaterThan(3.5);
  });

  it('excludes road and vehicle ancestry even when the parent is tagged', () => {
    const { scene, camera, controller } = setup();
    const road = new THREE.Group(); road.name = 'road-collider'; road.userData.cameraCollision = true;
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(6, 3, 1), new THREE.MeshBasicMaterial());
    mesh.position.set(0, 2, 2.5); road.add(mesh); scene.add(road);
    const body = new THREE.Group(); body.name = 'body'; body.userData.cameraCollision = true;
    const bodyMesh = new THREE.Mesh(new THREE.BoxGeometry(6, 3, 1), new THREE.MeshBasicMaterial());
    bodyMesh.position.set(0, 2, 3.5); body.add(bodyMesh); scene.add(body); scene.updateMatrixWorld(true);
    controller.update(frame(vehicle()), 0, 'drive');
    for (let i = 0; i < 45; i++) controller.update(frame(vehicle()), 1 / 60, 'drive');
    expect(camera.position.z).toBeGreaterThan(3.5);
  });

  it('cycles distinct views and removes speed FOV response under reduced motion', () => {
    const { camera, controller } = setup();
    expect(controller.cycleView()).toBe('close');
    expect(controller.cycleView()).toBe('hood');
    expect(controller.cycleView()).toBe('chase');
    controller.setReducedMotion(true);
    controller.update(frame(vehicle(0, 0, 0, 20, .7)), 0, 'drive');
    expect(camera.fov).toBe(58);
  });

  it('clamps base FOV and bounds speed widening while reduced motion preserves the selected base', () => {
    const { camera, controller } = setup();
    controller.setPreferences({ baseFovDeg: 49, shakeEnabled: false, reducedMotion: false });
    controller.update(frame(vehicle()), 0, 'drive');
    expect(camera.fov).toBe(50);
    // Stage one: +8 degrees by 45 m/s for every car. Stage two: up to +7 more from ~55 to 100 m/s (hypercar speeds).
    controller.update(frame(vehicle(0, 0, 0, 45)), 0, 'drive');
    expect(camera.fov).toBe(58);
    controller.update(frame(vehicle(0, 0, 0, 100)), 0, 'drive');
    expect(camera.fov).toBe(65);
    controller.setPreferences({ baseFovDeg: 75, shakeEnabled: false, reducedMotion: false });
    controller.update(frame(vehicle(0, 0, 0, 100)), 0, 'drive');
    expect(camera.fov).toBe(90);
    controller.setPreferences({ baseFovDeg: 50, shakeEnabled: false, reducedMotion: true });
    controller.update(frame(vehicle(0, 0, 0, 100)), 0, 'drive');
    expect(camera.fov).toBe(50);
  });

  it('adds a tiny high-speed buzz only above ~200 km/h, and none with reduced motion', () => {
    const run = (speed: number, reducedMotion: boolean) => {
      const { camera, controller } = setup();
      controller.setPreferences({ baseFovDeg: 58, shakeEnabled: false, reducedMotion });
      const still = setup();
      still.controller.setPreferences({ baseFovDeg: 58, shakeEnabled: false, reducedMotion: true });
      let maxGap = 0;
      for (let i = 0; i < 30; i++) {
        controller.update(frame(vehicle(0, 0, 0, speed)), 1 / 60, 'drive');
        still.controller.update(frame(vehicle(0, 0, 0, speed)), 1 / 60, 'drive');
        maxGap = Math.max(maxGap, camera.position.distanceTo(still.camera.position));
      }
      return maxGap;
    };
    expect(run(40, false)).toBeLessThan(1e-9);
    const fast = run(100, false);
    expect(fast).toBeGreaterThan(0.002);
    expect(fast).toBeLessThan(0.03);
    expect(run(100, true)).toBeLessThan(1e-9);
  });

  it('applies bounded deterministic impact shake once per simulation tick and clears it outside drive', () => {
    const a = setup(), b = setup();
    a.controller.setPreferences({ baseFovDeg: 58, shakeEnabled: true, reducedMotion: false });
    b.controller.setPreferences({ baseFovDeg: 58, shakeEnabled: true, reducedMotion: false });
    a.controller.update(frame(vehicle()), 0, 'drive'); b.controller.update(frame(vehicle()), 0, 'drive');
    const hit = impactFrame(19, 40, 100_000);
    a.controller.update(hit, 1 / 60, 'drive'); b.controller.update(hit, 1 / 60, 'drive');
    expect(a.camera.position.distanceTo(b.camera.position)).toBeCloseTo(0, 10);
    const firstTickPosition = a.camera.position.clone();
    a.controller.update(hit, 1 / 60, 'drive');
    b.controller.update(frame(vehicle()), 1 / 60, 'drive');
    expect(a.camera.position.distanceTo(b.camera.position)).toBeLessThan(1e-8);
    expect(a.camera.position.distanceTo(firstTickPosition)).toBeLessThan(.2);
    const c = setup();
    c.controller.setPreferences({ baseFovDeg: 58, shakeEnabled: true, reducedMotion: false });
    c.controller.update(frame(vehicle()), 0, 'drive');
    c.controller.update(impactFrame(22), 1 / 60, 'photo');
    c.controller.reset();
    c.controller.update(frame(vehicle()), 1 / 60, 'drive');
    expect(c.camera.position.distanceTo(restingPosition())).toBeLessThan(.2);
  });

  it('does not shake when preference is off or reduced motion is enabled', () => {
    const { camera, controller } = setup();
    controller.update(frame(vehicle()), 0, 'drive'); const resting = camera.position.clone();
    controller.setPreferences({ baseFovDeg: 58, shakeEnabled: true, reducedMotion: true });
    controller.update(impactFrame(7), 1 / 60, 'drive');
    expect(camera.position.distanceTo(resting)).toBeLessThan(.15);
    controller.setPreferences({ baseFovDeg: 58, shakeEnabled: false, reducedMotion: false });
    controller.update(impactFrame(8), 1 / 60, 'drive');
    expect(camera.position.distanceTo(resting)).toBeLessThan(.15);
  });

  it('clears an active impact pulse while paused and does not resume it afterward', () => {
    const active = setup(), steady = setup();
    for (const camera of [active.controller, steady.controller]) camera.setPreferences({ baseFovDeg: 58, shakeEnabled: true, reducedMotion: false });
    active.controller.update(frame(vehicle()), 0, 'drive'); steady.controller.update(frame(vehicle()), 0, 'drive');
    active.controller.update(impactFrame(31), 1 / 60, 'drive');
    steady.controller.update(frame(vehicle()), 1 / 60, 'drive');
    active.controller.update(impactFrame(31), 1 / 60, 'drive', true);
    steady.controller.update(frame(vehicle()), 1 / 60, 'drive', true);
    expect(active.camera.position.distanceTo(steady.camera.position)).toBeLessThan(1e-8);
    active.controller.update(impactFrame(31), 1 / 60, 'drive');
    steady.controller.update(frame(vehicle()), 1 / 60, 'drive');
    expect(active.camera.position.distanceTo(steady.camera.position)).toBeLessThan(1e-8);
  });
});

function restingPosition(): THREE.Vector3 { return new THREE.Vector3(0, 2.8, 4); }
