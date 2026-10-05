import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { createShadowBudgetPolicy } from '../../src/render';

const mesh = (name: string, castShadow = true): THREE.Mesh => {
  const result = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial());
  result.name = name;
  result.castShadow = castShadow;
  return result;
};

describe('Low shadow budget policy', () => {
  it('keeps primary environment silhouettes and prunes secondary detail shadows only in Low', () => {
    const world = new THREE.Group();
    const rail = mesh('road-hw01-guardrail-left');
    const shed = mesh('loading-shed-main');
    const shedDoorRib = mesh('shed-road-door-rib-0-0');
    const crane = new THREE.Group();
    crane.name = 'dock-crane-1';
    const craneLeg = mesh('crane-leg');
    const craneBeacon = mesh('crane-beacon');
    crane.add(craneLeg, craneBeacon);
    const tank = mesh('salt-tank-1');
    const tankLadder = mesh('salt-tank-1-ladder-rail-1');
    const pole = mesh('quay-lamp-pole-1');
    const roadSurface = mesh('road-hw01-asphalt', false);
    world.add(rail, shed, shedDoorRib, crane, tank, tankLadder, pole, roadSurface);
    const heroCar = mesh('car-body');
    const cameraCollision = mesh('yard-cargo-container-shells');
    cameraCollision.userData.cameraCollision = true;
    world.add(cameraCollision);
    const beforeVisibility = [rail, shedDoorRib, pole, cameraCollision].map((item) => item.visible);

    const policy = createShadowBudgetPolicy([world]);
    policy.setQuality('low');

    expect(rail.castShadow).toBe(true);
    expect(shed.castShadow).toBe(true);
    expect(craneLeg.castShadow).toBe(true);
    expect(tank.castShadow).toBe(true);
    expect(shedDoorRib.castShadow).toBe(false);
    expect(craneBeacon.castShadow).toBe(false);
    expect(tankLadder.castShadow).toBe(false);
    expect(pole.castShadow).toBe(false);
    expect(roadSurface.castShadow).toBe(false);
    expect(heroCar.castShadow).toBe(true);
    expect(cameraCollision.castShadow).toBe(true);
    expect(cameraCollision.userData.cameraCollision).toBe(true);
    expect([rail, shedDoorRib, pole, cameraCollision].map((item) => item.visible)).toEqual(beforeVisibility);

    policy.setQuality('balanced');
    expect(shedDoorRib.castShadow).toBe(false);
    expect(craneBeacon.castShadow).toBe(false);
    expect(tankLadder.castShadow).toBe(false);
    expect(pole.castShadow).toBe(false);
    expect(roadSurface.castShadow).toBe(false);
    policy.setQuality('low');
    policy.setQuality('high');
    expect(pole.castShadow).toBe(true);
    expect(shedDoorRib.castShadow).toBe(true);

    policy.dispose();
    expect(pole.castShadow).toBe(true);
    expect(shedDoorRib.castShadow).toBe(true);
    policy.setQuality('low');
    expect(pole.castShadow).toBe(true);

    world.traverse((node) => {
      if (!(node instanceof THREE.Mesh)) return;
      node.geometry.dispose();
      (Array.isArray(node.material) ? node.material : [node.material]).forEach((material) => material.dispose());
    });
    heroCar.geometry.dispose();
    (heroCar.material as THREE.Material).dispose();
  });

  it('deduplicates overlapping roots and disposal restores original false flags', () => {
    const root = new THREE.Group();
    const detail = mesh('quay-lamp-pole-1');
    const authoredOff = mesh('quay-lamp-head-1', false);
    root.add(detail, authoredOff);
    const policy = createShadowBudgetPolicy([root, detail]);
    policy.setQuality('low');
    expect(detail.castShadow).toBe(false);
    expect(authoredOff.castShadow).toBe(false);
    policy.dispose();
    expect(detail.castShadow).toBe(true);
    expect(authoredOff.castShadow).toBe(false);
    detail.geometry.dispose(); authoredOff.geometry.dispose();
    (detail.material as THREE.Material).dispose(); (authoredOff.material as THREE.Material).dispose();
  });
});
