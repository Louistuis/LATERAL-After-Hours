import * as THREE from 'three';
import { describe, expect, it, vi } from 'vitest';
import { ATMOSPHERES } from '../../src/scene-pipeline/atmosphere';
import { createSkyDome } from '../../src/scene-pipeline/sky-dome';

describe('after-hours sky dome', () => {
  it('drives one shader from each lighting recipe and releases its resources', () => {
    const sky = createSkyDome();
    const uniforms = sky.mesh.material.uniforms as Record<string, THREE.IUniform>;
    const dusk = ATMOSPHERES['golden-hour'];
    const night = ATMOSPHERES['blue-hour'];
    sky.setAtmosphere(dusk);
    const duskHorizon = (uniforms.uHorizon!.value as THREE.Color).clone();
    const duskZenith = (uniforms.uZenith!.value as THREE.Color).clone();
    expect(uniforms.uSunDisc!.value).toBe(dusk.sunDisc);
    expect(uniforms.uStars!.value).toBe(dusk.stars);
    // The gradient has real range: a warm horizon against a deep zenith.
    expect(duskHorizon.r + duskHorizon.g + duskHorizon.b).toBeGreaterThan((duskZenith.r + duskZenith.g + duskZenith.b) * 3);
    sky.setAtmosphere(night);
    expect(uniforms.uStars!.value).toBe(night.stars);
    expect(uniforms.uMoonSize!.value).toBe(night.moonSize);
    expect((uniforms.uHorizon!.value as THREE.Color).equals(duskHorizon)).toBe(false);
    expect(sky.mesh.material.depthWrite).toBe(false);
    expect(sky.mesh.material.fog).toBe(false);

    const probe = sky.createProbeMesh(40);
    const probeGeometryDisposed = vi.fn();
    probe.geometry.addEventListener('dispose', probeGeometryDisposed);
    const geometryDisposed = vi.fn(), materialDisposed = vi.fn();
    sky.mesh.geometry.addEventListener('dispose', geometryDisposed);
    sky.mesh.material.addEventListener('dispose', materialDisposed);
    sky.dispose();
    expect(geometryDisposed).toHaveBeenCalledOnce();
    expect(materialDisposed).toHaveBeenCalledOnce();
    expect(probeGeometryDisposed).toHaveBeenCalledOnce();
  });
});
