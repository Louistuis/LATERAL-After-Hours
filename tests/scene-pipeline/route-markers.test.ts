import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import type { RouteDefinition } from '../../contracts/world-contracts';
import { RouteMarkers, sampleClipTarget } from '../../src/scene-pipeline/route-markers';

const route: RouteDefinition = {
  id: 'HW-01', name: 'Foundry Eight', district: 'harbor', version: 'test',
  roadIds: ['road'], centerline: [], widthM: 10, closed: true, lengthM: 800,
  spawn: { position: { x: 0, y: 0.8, z: 0 }, rotation: { x: 0, y: 0, z: 0, w: 1 } },
  checkpoints: Array.from({ length: 24 }, (_, i) => ({
    id: `cp-${i}`, center: { x: i * 20, y: 0.1, z: 0 },
    forward: { x: 1, y: 0, z: 0 }, halfWidthM: 5,
  })),
};

describe('route markers', () => {
  it('keeps draw-bearing objects bounded over route switches', () => {
    const markers = new RouteMarkers();
    for (let i = 0; i < 20; i++) {
      markers.setRoute(route);
      expect(markers.root.children).toHaveLength(2);
      for (const child of markers.root.children) {
        expect(child).toBeInstanceOf(THREE.InstancedMesh);
        expect((child as THREE.InstancedMesh).count).toBe(48);
      }
      markers.setRoute(null);
      expect(markers.root.children).toHaveLength(0);
    }
    markers.dispose();
  });

  it('places clip cues at scorer polyline progress and positive route-right offset', () => {
    const straight: RouteDefinition = {
      ...route,
      centerline: [{ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: -100 }],
      lengthM: 100,
      checkpoints: route.checkpoints.slice(0, 1),
      clippingZones: [{ id: 'inside-right', progressM: 50, radiusM: 6,
        preferredOffsetM: 3, lateralToleranceM: 0.7, bonusFactor: 1.2 }],
    };
    const target = sampleClipTarget(straight, 50, 3);
    expect(target.toArray()).toEqual([3, 0, -50]);
    const markers = new RouteMarkers();
    markers.setRoute(straight);
    const rings = markers.root.getObjectByName('clip-zone-rings') as THREE.InstancedMesh;
    expect(rings).toBeInstanceOf(THREE.InstancedMesh);
    expect(rings.count).toBe(1);
    const matrix = new THREE.Matrix4();
    rings.getMatrixAt(0, matrix);
    const position = new THREE.Vector3().setFromMatrixPosition(matrix);
    expect(position.x).toBeCloseTo(3);
    expect(position.y).toBeCloseTo(0.12);
    expect(position.z).toBeCloseTo(-50);
    markers.setRoute(null);
    expect(markers.root.children).toHaveLength(0);
    markers.dispose();
  });
});
