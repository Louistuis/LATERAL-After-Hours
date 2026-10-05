import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { AUTO_SEQUENCE, ReplayDirector } from '../../src/camera/replay-director';
import { PhotoCamera, PHOTO_FOV_RANGE } from '../../src/camera/photo-camera';

const finite = (v: THREE.Vector3): boolean => [v.x, v.y, v.z].every(Number.isFinite);
// A straight 400 m road along -Z, 12 m wide.
const centerline = Array.from({ length: 41 }, (_, i) => ({ x: 0, y: 0, z: -i * 10 }));
const identity = { x: 0, y: 0, z: 0, w: 1 };

describe('replay director', () => {
  it('cuts through the auto sequence and always produces a finite camera', () => {
    const director = new ReplayDirector();
    director.setRoute({ centerline, widthM: 12 });
    director.reset();
    const seen = new Set<string>();
    for (let t = 0; t < 60; t += 1 / 30) {
      const out = director.update(1 / 30, { x: 0, y: 0, z: -t * 6 }, identity);
      expect(finite(out.position) && finite(out.target)).toBe(true);
      expect(out.fov).toBeGreaterThan(10); expect(out.fov).toBeLessThan(90);
      seen.add(director.shot());
    }
    expect(seen).toEqual(new Set(AUTO_SEQUENCE.map(([kind]) => kind)));
  });

  it('puts trackside cameras on the shoulder, ahead of the car', () => {
    const director = new ReplayDirector();
    director.setRoute({ centerline, widthM: 12 });
    director.setMode('trackside');
    const out = director.update(1 / 60, { x: 0, y: 0, z: -20 }, identity);
    expect(Math.abs(out.position.x)).toBeGreaterThanOrEqual(6);
    expect(out.position.z).toBeLessThan(-20);
    expect(out.position.y).toBeGreaterThan(1);
  });

  it('holds a fixed shot and applies it to a camera', () => {
    const director = new ReplayDirector();
    director.setMode('bumper');
    const camera = new THREE.PerspectiveCamera(50, 1.5, 0.1, 1000);
    for (let i = 0; i < 100; i++) director.apply(camera, director.update(0.05, { x: 5, y: 0, z: 5 }, identity));
    expect(director.shot()).toBe('bumper');
    expect(camera.fov).toBe(72);
    expect(finite(camera.position)).toBe(true);
  });
});

describe('photo camera', () => {
  it('starts where the game camera was', () => {
    const camera = new THREE.PerspectiveCamera(58, 1.5, 0.1, 1000);
    camera.position.set(6, 3, 6);
    const photo = new PhotoCamera();
    photo.begin(camera, { x: 0, y: 0, z: 0 });
    const before = camera.position.clone();
    photo.apply(camera, { x: 0, y: 0, z: 0 });
    expect(camera.position.distanceTo(before)).toBeLessThan(0.05);
    expect(photo.fov).toBe(58);
  });

  it('clamps FOV and roll and keeps the free camera near the car', () => {
    const photo = new PhotoCamera();
    photo.setFov(500); expect(photo.fov).toBe(PHOTO_FOV_RANGE[1]);
    photo.setFov(Number.NaN); expect(photo.fov).toBe(PHOTO_FOV_RANGE[0]);
    photo.setRoll(-90); expect(photo.roll).toBe(-35);
    const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 1000);
    camera.position.set(0, 2, 8);
    photo.begin(camera, { x: 0, y: 0, z: 0 });
    photo.setMode('free');
    for (let i = 0; i < 200; i++) photo.move(5, 0, 0);
    photo.apply(camera, { x: 0, y: 0, z: 0 });
    expect(camera.position.length()).toBeLessThanOrEqual(60.01);
    photo.setRoll(20); photo.apply(camera, { x: 0, y: 0, z: 0 });
    expect(finite(camera.position)).toBe(true);
  });

  it('orbit drag and zoom stay in range', () => {
    const photo = new PhotoCamera();
    const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 1000);
    camera.position.set(0, 2, 8);
    photo.begin(camera, { x: 0, y: 0, z: 0 });
    photo.drag(0, 10_000); photo.zoom(1e6); photo.pan(1e4, 1e4); photo.drag(Number.NaN, 1);
    photo.apply(camera, { x: 0, y: 0, z: 0 });
    expect(camera.position.length()).toBeLessThan(40);
    expect(finite(camera.position)).toBe(true);
  });
});
