import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { collectCameraOccluders } from '../../src/scene-pipeline/camera-occluders';

describe('static camera occlusion candidates', () => {
  it('honors explicit ancestor tags and child opt-outs without searching vehicle or road meshes', () => {
    const world = new THREE.Group();
    const building = new THREE.Group();
    building.userData.cameraCollision = true;
    const facade = new THREE.Mesh();
    const glass = new THREE.Mesh();
    glass.userData.cameraCollision = false;
    building.add(facade, glass);
    const road = new THREE.Mesh();
    road.userData.cameraCollision = false;
    world.add(building, road);
    const car = new THREE.Mesh();
    const candidates = collectCameraOccluders([world]);
    expect(candidates).toEqual([facade]);
    expect(candidates).not.toContain(car);
    expect(Object.isFrozen(candidates)).toBe(true);
  });
});
