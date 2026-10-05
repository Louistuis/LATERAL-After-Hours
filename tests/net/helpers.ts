import type { NetLocalView, RemoteCarSink } from '../../src/net/session';
import type { NetTransport, PresenceMap, RoomState } from '../../src/net/transport';

/** In-memory websim room: shared presence and roomState, broadcast send. */
export function fakeRoom() {
  const presence: Record<string, Record<string, unknown>> = {};
  let roomState: Record<string, unknown> = {};
  const clients = new Map<string, { msg: Set<(d: Record<string, unknown>) => void>; pres: Set<(p: PresenceMap) => void>; room: Set<(s: RoomState) => void> }>();
  const merge = (target: Record<string, unknown>, patch: Record<string, unknown>): Record<string, unknown> => {
    const out = { ...target };
    for (const [k, v] of Object.entries(patch)) {
      if (v === null) delete out[k];
      else if (typeof v === 'object' && !Array.isArray(v)) out[k] = merge((out[k] as Record<string, unknown>) ?? {}, v as Record<string, unknown>);
      else out[k] = v;
    }
    return out;
  };
  const emitPresence = () => { for (const c of clients.values()) for (const cb of c.pres) cb({ ...presence }); };
  return {
    presence,
    connect(id: string): NetTransport {
      const listeners = { msg: new Set<(d: Record<string, unknown>) => void>(), pres: new Set<(p: PresenceMap) => void>(), room: new Set<(s: RoomState) => void>() };
      clients.set(id, listeners);
      presence[id] = {};
      const sub = <T>(set: Set<T>, cb: T) => { set.add(cb); return () => set.delete(cb); };
      return {
        available: true, selfId: id,
        peers: () => Object.fromEntries([...clients.keys()].map(k => [k, { username: `user-${k}`, avatarUrl: '' }])),
        presence: () => presence, roomState: () => roomState,
        updatePresence(patch) { presence[id] = { ...presence[id], ...patch }; emitPresence(); },
        updateRoomState(patch) { roomState = merge(roomState, patch); for (const c of clients.values()) for (const cb of c.room) cb(roomState); },
        send(message) { const copy = JSON.parse(JSON.stringify(message)); for (const [k, c] of clients) if (k !== id) for (const cb of c.msg) cb(copy); },
        onMessage: cb => sub(listeners.msg, cb), onPresence: cb => sub(listeners.pres, cb), onRoomState: cb => sub(listeners.room, cb),
        collection: () => null,
        dispose() {},
      };
    },
    disconnect(id: string) { clients.delete(id); delete presence[id]; emitPresence(); },
  };
}

export function fakeRemote(): RemoteCarSink & { pushes: string[]; cars: Set<string> } {
  const cars = new Set<string>(), pushes: string[] = [];
  return { cars, pushes, upsert: id => { cars.add(id); }, push: id => { pushes.push(id); }, remove: id => { cars.delete(id); }, ids: () => cars.values(), update() {}, dispose() { cars.clear(); } };
}

export function localView(run: NetLocalView['run'] = null, result: NetLocalView['result'] = null): NetLocalView {
  return {
    carId: 'CAR-02',
    frame: { current: { position: { x: 1, y: 2, z: 3 }, rotation: { x: 0, y: 0, z: 0, w: 1 }, linearVelocityMS: { x: 0, y: 0, z: 5 }, gear: 2 }, score: { banked: 0 } },
    input: { steering: 0.5, brake: 0, handbrake: 0 }, run, result,
  };
}

