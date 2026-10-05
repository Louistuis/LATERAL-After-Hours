import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { offsetSpawn } from '../../src/core/game-runtime';
import { gridOffset, gridOrder, gridSlotOf, newLobby, type MemberState } from '../../src/net/lobby';
import { emptyCarState, packCarState, unpackCarState } from '../../src/net/quantize';
import { RemoteCars } from '../../src/net/remote-cars';
import { fillCarState, median, NetSession, wheelSteerYaw, type NetLocalView } from '../../src/net/session';
import { createVehicleSimulation } from '../../src/physics';
import { fakeRemote, fakeRoom, localView } from './helpers';

const yawQuat = (yaw: number) => ({ x: 0, y: Math.sin(yaw / 2), z: 0, w: Math.cos(yaw / 2) });

describe('starting grid', () => {
  it('orders ready drivers first and gives late joiners the next slots', () => {
    const members: MemberState[] = [{ id: 'a', rd: -1 }, { id: 'b', rd: 3 }, { id: 'c', rd: 3 }];
    expect(gridOrder(members, 3)).toBe('b,c,a');
    const lobby = { ...newLobby('time-trial', 'HW-01', 0), race: 3, g: 'b,c,a' };
    expect(['a', 'b', 'c'].map(id => gridSlotOf(lobby, id, members))).toEqual([2, 0, 1]);
    expect(gridSlotOf(lobby, 'd', [...members, { id: 'd' }])).toBe(3);
  });

  it('staggers eight slots behind the line, clear of the finish gate 8.3 m back', () => {
    const slots = Array.from({ length: 8 }, (_, i) => gridOffset(i));
    expect(slots[0]).toEqual({ rightM: -1.7, backM: 0 });
    for (const s of slots) { expect(s.backM).toBeGreaterThanOrEqual(0); expect(s.backM).toBeLessThan(7.5); expect(Math.abs(s.rightM)).toBeLessThanOrEqual(5); }
    // Same lane, next row: at least a car length behind.
    for (let i = 0; i < 4; i++) expect(slots[i + 4]!.backM - slots[i]!.backM).toBeGreaterThan(5);
    expect(new Set(slots.map(s => `${s.rightM},${s.backM}`)).size).toBe(8);
  });

  it('moves the spawn along its own heading (local -Z forward, +X right)', () => {
    const spawn = { position: { x: 10, y: 1, z: 20 }, rotation: yawQuat(Math.PI / 2) };
    // Yaw +90 deg turns forward (-Z) into -X, right (+X) into -Z.
    const placed = offsetSpawn(spawn, { rightM: 2, backM: 5 });
    expect(placed.position.x).toBeCloseTo(15, 5);
    expect(placed.position.z).toBeCloseTo(18, 5);
    expect(placed.rotation).toEqual(spawn.rotation);
    expect(offsetSpawn(spawn, null).position).toEqual(spawn.position);
  });
});

describe('clock sync and race start on host time', () => {
  it('estimates the host clock offset from ping/pong and starts on the host clock', async () => {
    const room = fakeRoom();
    let now = 50_000;
    const skew = 7_000; // b's wall clock runs 7 s behind the host's
    const starts: [string, number][] = [];
    const make = (id: string, offset: number) => new NetSession(room.connect(id), {
      beginRace: async (_mode, _route, slot) => { starts.push([id, slot]); }, paint: () => '',
    }, fakeRemote(), { now: () => now, wall: () => 1_000_000 + now + offset });
    const a = make('a', 0), b = make('b', -skew);
    for (const s of [a, b]) s.goOnline('CAR-01');
    a.tick(localView(), now); b.tick(localView(), now);
    const id = a.quickRace('time-trial')!;
    expect(b.quickRace('time-trial')).toBe(id);
    for (let i = 0; i < 8; i++) { now += 400; a.tick(localView(), now); b.tick(localView(), now); }
    expect(b.view().clockOffsetMs).toBe(skew);
    expect(a.view().clockOffsetMs).toBe(0);
    a.setReady(true); b.setReady(true);
    now += 300; a.tick(localView(), now); b.tick(localView(), now);
    const lobby = a.view().lobby!;
    expect(lobby.ph).toBe('s');
    expect(lobby.g).toBe('a,b');
    // Both see the same countdown despite b's clock being 7 s off.
    expect(b.view().startInMs).toBe(a.view().startInMs);
    // Just before the countdown: nobody starts. Then the frame tick starts both on time.
    now += lobby.at - a.hostNow() - 3000 - 100; a.tick(localView(), now); b.tick(localView(), now);
    expect(starts).toEqual([]);
    now += 120; a.tick(localView(), now); b.tick(localView(), now);
    await Promise.resolve();
    expect(starts.sort()).toEqual([['a', 0], ['b', 1]]);
  });

  it('median ignores one outlier sample', () => {
    expect(median([10, 12, 11, 400, 9])).toBe(11);
    expect(median([])).toBe(0);
  });
});

describe('toasts and horn', () => {
  it('announces a host that left and the new host, and relays horns', () => {
    const room = fakeRoom();
    let now = 10_000;
    const clock = { now: () => now, wall: () => now };
    const horns: (string | null)[] = [];
    const make = (id: string) => new NetSession(room.connect(id), { beginRace: async () => {}, paint: () => '', horn: from => { if (id === 'c') horns.push(from); } }, fakeRemote(), clock);
    const a = make('a'), b = make('b'), c = make('c');
    for (const s of [a, b, c]) s.goOnline('CAR-01');
    a.quickRace('drift-attack'); b.quickRace('drift-attack'); c.quickRace('drift-attack');
    now += 300; c.tick(localView(), now);
    a.leaveLobby(); room.disconnect('a');
    now += 300; c.tick(localView(), now);
    expect(c.view().toasts.map(t => t.text)).toContain('user-a left. user-b is now the host.');
    // Toasts expire.
    now += 5000; c.tick(localView(), now);
    expect(c.view().toasts).toEqual([]);
    expect(b.horn()).toBe(true);
    expect(b.horn()).toBe(false); // cooldown
    now += 800;
    expect(b.horn()).toBe(true);
    expect(horns).toEqual(['b', 'b']);
  });

  it('reports a lost connection once and the reconnect once', () => {
    const room = fakeRoom();
    const session = new NetSession(room.connect('x'), { beginRace: async () => {}, paint: () => '' }, fakeRemote());
    session.goOnline('CAR-01');
    session.setConnected(false); session.setConnected(false);
    session.setConnected(true);
    expect(session.view().toasts.map(t => t.text)).toEqual(['Connection lost. Trying to reconnect.', 'Reconnected. You are back in the harbor.']);
  });
});

describe('remote car steer and wheel spin match the local car', () => {
  it('renders the same front wheel steer and forward wheel roll as the physics snapshot', async () => {
    const sim = await createVehicleSimulation({ carId: 'CAR-01' });
    const rest = [new THREE.Vector3(-0.8, -0.3, -1.3), new THREE.Vector3(0.8, -0.3, -1.3), new THREE.Vector3(-0.8, -0.3, 1.3), new THREE.Vector3(0.8, -0.3, 1.3)];
    const body = new THREE.Object3D();
    const wheels = rest.map(r => { const w = new THREE.Object3D(); w.userData.restPosition = r; return w; });
    const presentation = { body, wheels, setCosmetics() {}, setLights() {}, dispose() {} };
    const remote = new RemoteCars(new THREE.Scene(), async () => presentation as never);
    remote.upsert('loop', 'CAR-01', '', 'Loopback');
    await Promise.resolve(); await Promise.resolve();
    const state = emptyCarState(), echo = emptyCarState(), packed: number[] = [];
    const tick = (n: number, steering: number) => sim.step({ simulationTick: n, throttle: 1, brake: 0, steering, handbrake: 0, shift: 0, resetPressed: false } as never);
    let n = 0;
    for (; n < 120; n++) tick(n + 1, 0); // roll forward
    const rollOf = (bodyQ: THREE.Quaternion, wheelQ: THREE.Quaternion, yaw: number): number => {
      const rel = bodyQ.clone().multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw)).invert().multiply(wheelQ);
      return 2 * Math.atan2(rel.x, rel.w);
    };
    let ms = 0, lastRemoteRoll = 0, lastLocalRoll = 0, remoteForward = 0, localForward = 0;
    const steerPairs: [number, number][] = [];
    for (let frame = 0; frame < 90; frame++) {
      tick(++n, 0.6); // steer right
      ms += 1000 / 60;
      const snap = sim.snapshot();
      const view = { carId: 'CAR-01', frame: { current: snap, score: { banked: 0 } }, input: { steering: 0.6, brake: 0, handbrake: 0 }, run: null, result: null } as unknown as NetLocalView;
      if (frame % 5 === 0) { fillCarState(view, ms, state); packCarState(state, packed); unpackCarState(packed, echo); remote.push('loop', echo, ms); }
      remote.update(ms, 1 / 60);
      if (frame < 30) continue;
      const q = new THREE.Quaternion(snap.rotation.x, snap.rotation.y, snap.rotation.z, snap.rotation.w);
      const localYaw = wheelSteerYaw(snap.rotation, snap.wheels[0]!.rotation);
      const remoteYaw = wheelSteerYaw(body.quaternion, wheels[0]!.quaternion);
      steerPairs.push([localYaw, remoteYaw]);
      const lw = snap.wheels[2]!.rotation; // rear wheel: no steer
      const localRoll = rollOf(q, new THREE.Quaternion(lw.x, lw.y, lw.z, lw.w), 0);
      const remoteRoll = rollOf(body.quaternion, wheels[2]!.quaternion, 0);
      const wrap = (d: number) => Math.atan2(Math.sin(d), Math.cos(d));
      if (frame > 30) { localForward += wrap(localRoll - lastLocalRoll); remoteForward += wrap(remoteRoll - lastRemoteRoll); }
      lastLocalRoll = localRoll; lastRemoteRoll = remoteRoll;
    }
    // Steering right turns the wheel to negative yaw (right, seen from above) on both cars.
    for (const [local, remoteYaw] of steerPairs) { expect(Math.sign(remoteYaw)).toBe(Math.sign(local)); expect(Math.abs(remoteYaw - local)).toBeLessThan(0.12); }
    expect(steerPairs[steerPairs.length - 1]![0]).toBeLessThan(-0.05);
    // Both wheels roll forward (positive about +X), at a similar rate.
    expect(localForward).toBeGreaterThan(1);
    expect(remoteForward).toBeGreaterThan(1);
    expect(remoteForward / localForward).toBeGreaterThan(0.6);
    expect(remoteForward / localForward).toBeLessThan(1.6);
    sim.dispose?.();
  });
});
