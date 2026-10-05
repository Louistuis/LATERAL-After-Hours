import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import type { InputFrame } from '../../contracts/runtime-contracts';
import type { CollisionMeshData, RouteDefinition } from '../../contracts/world-contracts';
import { GameRuntime, type GameScene } from '../../src/core/game-runtime';

const routes: RouteDefinition[] = ['HW-01', 'HW-02'].map((id, index) => ({
  id: id as RouteDefinition['id'], name: id, district: 'harbor', version: 'test-v1',
  roadIds: ['test-road'], widthM: 8, closed: false, lengthM: 60,
  centerline: [{ x: index * 20, y: 0, z: 0 }, { x: index * 20, y: 0, z: -60 }],
  spawn: { position: { x: index * 20, y: 1, z: 2 }, rotation: { x: 0, y: 0, z: 0, w: 1 } },
  checkpoints: [
    { id: 'start', center: { x: index * 20, y: 0, z: 0 }, forward: { x: 0, y: 0, z: -1 }, halfWidthM: 4 },
    { id: 'finish', center: { x: index * 20, y: 0, z: -60 }, forward: { x: 0, y: 0, z: -1 }, halfWidthM: 4, finish: true },
  ],
}));

function makeScene(): GameScene {
  return {
    renderer: {} as THREE.WebGLRenderer, camera: new THREE.PerspectiveCamera(), scene: new THREE.Scene(),
    world: { routes, spawn: routes[0].spawn, collisionMeshes: [{
      vertices: [{x:-100,y:0,z:-100},{x:100,y:0,z:-100},{x:100,y:0,z:100},{x:-100,y:0,z:100}],
      indices: [0,2,1,0,3,2], surfaceId: 'road:test', drivableRoad: true,
    }] },
    render: vi.fn(), resize: vi.fn(), resetCamera: vi.fn(), setLighting: vi.fn(), setQuality: vi.fn(),
    setCar: vi.fn(async () => {}), setCosmetics: vi.fn(), setRoute: vi.fn(), setGhost: vi.fn(), dispose: vi.fn(),
  };
}

describe('GameRuntime integration boundaries', () => {
  let callbacks: Map<number, FrameRequestCallback>;
  let frameId: number;
  let runtime: GameRuntime | undefined;
  let now: number;
  beforeEach(() => {
    const documentFixture = Object.assign(new EventTarget(), { hidden: false });
    vi.stubGlobal('document', documentFixture);
    callbacks = new Map(); frameId = 0; now = performance.now();
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { callbacks.set(++frameId, callback); return frameId; });
    vi.stubGlobal('cancelAnimationFrame', (id: number) => { callbacks.delete(id); });
  });
  afterEach(() => { runtime?.dispose(); runtime = undefined; vi.unstubAllGlobals(); });
  async function fixture(extraColliders: readonly CollisionMeshData[] = []) {
    const base = makeScene();
    const scene = { ...base, world: { ...base.world, collisionMeshes: [...base.world.collisionMeshes, ...extraColliders] } };
    const input = { read: (simulationTick: number): InputFrame => ({ simulationTick, throttle: 1, brake: 0, steering: 0, handbrake: 0, shift: 0, resetPressed: false }), clear: vi.fn() };
    runtime = await GameRuntime.create(scene, input);
    return { scene, input, runtime };
  }
  function advance(frames: number,intervalMs=1000/60) {
    for (let i = 0; i < frames; i++) {
      now += intervalMs;
      const pending = [...callbacks.values()]; callbacks.clear();
      for (const callback of pending) callback(now);
    }
  }
  it('keeps route and physics unchanged when scene rejects a route', async () => {
    const f = await fixture();
    const initial = f.runtime.view().frame.current.position;
    vi.mocked(f.scene.setRoute).mockImplementation(() => { throw new Error('route asset unavailable'); });
    expect(() => f.runtime.selectRoute('HW-02')).toThrow('unavailable');
    expect(f.runtime.view().route.id).toBe('HW-01');
    expect(f.runtime.view().frame.current.position).toEqual(initial);
  });
  it('ignores an older car load that finishes after the newer selection', async () => {
    const f = await fixture();
    let releaseFirst!: () => void;
    vi.mocked(f.scene.setCar).mockImplementationOnce(() => new Promise<void>(resolve => { releaseFirst = resolve; }));
    const old = f.runtime.selectCar('CAR-02');
    await f.runtime.selectCar('CAR-04');
    releaseFirst(); await old;
    expect(f.runtime.view().carId).toBe('CAR-04');
    expect(f.runtime.view().frame.current.carId).toBe('CAR-04');
  });
  it('preserves hidden/context pauses across event and free-drive transitions', async () => {
    const f = await fixture(); f.runtime.start();
    f.runtime.pause('hidden');
    f.runtime.beginEvent({ mode: 'time-trial', rulesVersion: 'test-v1' });
    advance(5);
    expect(f.runtime.view().run?.elapsedActiveSeconds).toBe(0);
    const tick = f.runtime.view().frame.current.simulationTick;
    f.runtime.pause('context-lost'); f.runtime.resume('hidden'); f.runtime.freeDrive();
    advance(5);
    expect(f.runtime.view().frame.current.simulationTick).toBe(tick);
    expect(f.scene.render).toHaveBeenCalledTimes(5);
    f.runtime.resume('context-lost'); advance(2);
    expect(f.runtime.view().frame.current.simulationTick).toBeGreaterThan(tick);
  });
  it('free-drive clears stale retry state and photo mode never advances physics', async () => {
    const f = await fixture(); f.runtime.start(); advance(5);
    f.runtime.beginEvent({ mode: 'time-trial', rulesVersion: 'test-v1' });
    f.runtime.freeDrive(); f.runtime.retry();
    expect(f.runtime.view().run).toBeNull();
    const tick = f.runtime.view().frame.current.simulationTick;
    f.runtime.enterPhoto(); advance(10);
    expect(f.runtime.view().frame.current.simulationTick).toBe(tick);
    f.runtime.leavePresentation(); advance(2);
    expect(f.runtime.view().frame.current.simulationTick).toBeGreaterThan(tick);
  });
  it('reports a renderer failure once and stops drawing until recovered', async () => {
    const f = await fixture(); const failed = vi.fn();
    f.runtime.onRenderFailure(failed);
    vi.mocked(f.scene.render).mockImplementationOnce(() => { throw new Error('context failed'); });
    f.runtime.start(); advance(3);
    expect(failed).toHaveBeenCalledOnce();
    expect(f.scene.render).toHaveBeenCalledOnce();
    expect(f.runtime.view().paused).toBe(true);
    f.runtime.resume('context-lost'); advance(1);
    expect(f.scene.render).toHaveBeenCalledTimes(2);
  });
  it('passes composed pause state to the external camera even while presentation remains drive', async () => {
    const f = await fixture(); const camera = vi.fn();
    f.runtime.setCameraController(camera); f.runtime.start(); advance(1);
    expect(camera.mock.lastCall?.slice(2)).toEqual(['drive', false]);
    f.runtime.pause('menu'); f.runtime.pause('ad'); advance(1);
    expect(camera.mock.lastCall?.slice(2)).toEqual(['drive', true]);
    f.runtime.resume('menu'); advance(1);
    expect(camera.mock.lastCall?.slice(2)).toEqual(['drive', true]);
    f.runtime.resume('ad'); advance(1);
    expect(camera.mock.lastCall?.slice(2)).toEqual(['drive', false]);
  });
  it('renders the paused menu showcase at about 30 fps and drive frames at the display rate', async () => {
    const f = await fixture(); f.runtime.start(); advance(1);
    vi.mocked(f.scene.render).mockClear();
    f.runtime.pause('menu'); advance(7);
    // First paused frame renders at once, then every second 60 Hz frame.
    expect(f.scene.render).toHaveBeenCalledTimes(4);
    expect(vi.mocked(f.scene.render).mock.lastCall?.[1]).toBeCloseTo(2 / 60);
    vi.mocked(f.scene.render).mockClear();
    f.runtime.resume('menu'); advance(4);
    expect(f.scene.render).toHaveBeenCalledTimes(4);
  });
  it('changes ghost compatibility when actual tuning changes and restores it with the factory preset', async () => {
    const f = await fixture();const factory=f.runtime.tuneHash();
    f.runtime.selectCustomTune({...f.runtime.tuning(),rearMuScale:0.8});
    expect(f.runtime.tuneHash()).not.toBe(factory);
    expect(f.runtime.tuning().id).toBe('Custom');
    expect(()=>f.runtime.selectCustomTune({...f.runtime.tuning(),engineScale:NaN})).toThrow();
    f.runtime.restoreFactoryTune();expect(f.runtime.tuneHash()).toBe(factory);
    expect(f.runtime.tuning().id).toBe('Balanced');
  });
  it('rejects invalid event metadata before moving the active car or changing mode', async () => {
    const f=await fixture();f.runtime.start();advance(30);
    const before=f.runtime.view();
    expect(()=>f.runtime.beginEvent({mode:'time-trial',rulesVersion:''})).toThrow();
    expect(f.runtime.view().frame.current.position).toEqual(before.frame.current.position);
    expect(f.runtime.view().mode).toBe('free-drive');
  });
  it('applies ghost visibility to rendered rivals without affecting simulation or recording', async () => {
    const f=await fixture();f.runtime.start();
    const base={position:{x:0,y:1,z:0},rotation:{x:0,y:0,z:0,w:1},driftAngleRad:0,gear:1};
    f.runtime.setRival([{...base,timeSeconds:0},{...base,timeSeconds:1}]);
    advance(1);expect(f.scene.setGhost).toHaveBeenLastCalledWith(expect.objectContaining({position:base.position}));
    f.runtime.setGhostVisible(false);advance(1);expect(f.scene.setGhost).toHaveBeenLastCalledWith(null);
    f.runtime.setGhostVisible(true);advance(1);expect(f.scene.setGhost).toHaveBeenLastCalledWith(expect.objectContaining({position:base.position}));
  });
  it('exposes consumed controls without sharing writable input state and clears them on pause/reset', async () => {
    const f=await fixture();
    expect(f.runtime.view().input.throttle).toBe(0);
    f.runtime.start();advance(3);
    const observed=f.runtime.view().input;
    expect(observed.throttle).toBe(1);
    expect(observed.simulationTick).toBeGreaterThan(0);
    (observed as {throttle:number}).throttle=.4;
    expect(f.runtime.view().input.throttle).toBe(1);
    f.runtime.pause('manual');
    expect(f.runtime.view().input).toMatchObject({throttle:0,brake:0,steering:0,handbrake:0,shift:0,resetPressed:false});
    f.runtime.resume('manual');advance(2);
    expect(f.runtime.view().input.throttle).toBe(1);
    f.runtime.resetVehicle();expect(f.runtime.view().input.throttle).toBe(0);
  });
  it('uses Auto for active cadence while explicit fixed quality stays locked',async()=>{
    const f=await fixture();const tune=f.runtime.tuneHash();
    f.runtime.setQuality('auto');f.runtime.start();
    // Auto spends resolution (1 to 0.6) before it drops Balanced to Low.
    advance(300,25);
    expect(f.runtime.quality()).toEqual({selection:'auto',effective:'low'});
    expect(f.scene.setQuality).toHaveBeenLastCalledWith('low');
    expect(f.runtime.tuneHash()).toBe(tune);
    f.runtime.setQuality('high');advance(60,50);
    expect(f.runtime.quality()).toEqual({selection:'high',effective:'high'});
    expect(()=>f.runtime.setQuality('unknown' as never)).toThrow('graphics');
  });
  it('clears an external camera history on near-spawn manual and consumed-input resets',async()=>{
    const f=await fixture();const resetCamera=vi.fn();const updateCamera=vi.fn();
    f.runtime.setCameraController(updateCamera,resetCamera);f.runtime.start();advance(5);
    const position=f.runtime.view().frame.current.position;
    expect(Math.hypot(position.x-routes[0].spawn.position.x,position.y-routes[0].spawn.position.y,position.z-routes[0].spawn.position.z)).toBeLessThan(10);
    expect(updateCamera).toHaveBeenCalled();
    f.runtime.resetVehicle();expect(resetCamera).toHaveBeenCalledOnce();
    const normalRead=f.input.read;
    vi.spyOn(f.input,'read').mockImplementationOnce(tick=>({...normalRead(tick),resetPressed:true}));
    advance(2);expect(resetCamera).toHaveBeenCalledTimes(2);
    f.runtime.enterPhoto();f.runtime.leavePresentation();
    expect(resetCamera).toHaveBeenCalledTimes(3);
    f.runtime.setCameraController(null);f.runtime.resetVehicle();
    expect(resetCamera).toHaveBeenCalledTimes(3);
    expect(f.scene.resetCamera).toHaveBeenCalled();
  });
  it('forwards authored obstacle collision roles into real chassis impact telemetry',async()=>{
    const f=await fixture([{
      vertices:[{x:-10,y:0,z:-8},{x:10,y:0,z:-8},{x:10,y:3,z:-8},{x:-10,y:3,z:-8}],
      indices:[0,1,2,0,2,3],surfaceId:'wall:harbor-test',role:'obstacle',drivableRoad:false,
    }]);
    f.runtime.start();
    const hitIds=new Set<string>();let strongestImpact=0;
    for(let frame=0;frame<240;frame++){
      advance(1);
      const impact=f.runtime.simulation.collisionTelemetry();
      impact.colliderIds.forEach(id=>hitIds.add(id));
      strongestImpact=Math.max(strongestImpact,impact.speedDeltaMS);
    }
    console.info('ROOT_WALL_IMPACT', {hitIds:[...hitIds],strongestImpact,position:f.runtime.view().frame.current.position,tick:f.runtime.view().frame.current.simulationTick});
    expect(hitIds.has('wall:harbor-test')).toBe(true);
    expect(strongestImpact).toBeGreaterThan(0);
    expect(f.runtime.view().frame.current.position.z).toBeGreaterThan(-8);
  });
});
