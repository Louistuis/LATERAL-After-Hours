/** Minimal multiplayer port. The websim adapter is the only real implementation. */
export interface NetPeer { readonly username: string; readonly avatarUrl: string }
export type PresenceMap = Readonly<Record<string, Readonly<Record<string, unknown>>>>;
export type RoomState = Readonly<Record<string, unknown>>;
export interface NetRecord { readonly id: string; readonly username?: string; readonly created_at?: string; readonly [key: string]: unknown }
export interface NetCollection {
  create(data: Record<string, unknown>): Promise<unknown>;
  /** Updates a record this player created (websim allows only the owner). Optional: absent on older adapters. */
  update?(id: string, data: Record<string, unknown>): Promise<unknown>;
  getList(): readonly NetRecord[];
  /** Optional: one full row by id (lists may carry shortened payloads, e.g. ghost laps). */
  fetchRow?(id: string): Promise<NetRecord | null>;
  subscribe(callback: (records: readonly NetRecord[]) => void): () => void;
}

export interface NetTransport {
  readonly available: boolean;
  readonly selfId: string;
  peers(): Readonly<Record<string, NetPeer>>;
  presence(): PresenceMap;
  roomState(): RoomState;
  updatePresence(patch: Record<string, unknown>): void;
  /** Deep merge; a null value deletes the key. */
  updateRoomState(patch: Record<string, unknown>): void;
  send(message: Record<string, unknown>): void;
  onMessage(callback: (data: Record<string, unknown>) => void): () => void;
  onPresence(callback: (presence: PresenceMap) => void): () => void;
  onRoomState(callback: (state: RoomState) => void): () => void;
  collection(name: string): NetCollection | null;
  dispose(): void;
}

export function createOfflineTransport(): NetTransport {
  const none = () => () => {};
  return {
    available: false, selfId: '',
    peers: () => ({}), presence: () => ({}), roomState: () => ({}),
    updatePresence() {}, updateRoomState() {}, send() {},
    onMessage: none, onPresence: none, onRoomState: none,
    collection: () => null, dispose() {},
  };
}

interface WebsimRoom {
  clientId: string;
  peers: Record<string, NetPeer>;
  presence: Record<string, Record<string, unknown>>;
  roomState: Record<string, unknown>;
  initialize(): Promise<void>;
  updatePresence(patch: Record<string, unknown>): void;
  updateRoomState(patch: Record<string, unknown>): unknown;
  subscribePresence(cb: (p: Record<string, Record<string, unknown>>) => void): (() => void) | void;
  subscribeRoomState(cb: (s: Record<string, unknown>) => void): (() => void) | void;
  send(message: Record<string, unknown>): void;
  addEventListener(type: 'message', cb: (event: MessageEvent) => void): void;
  removeEventListener(type: 'message', cb: (event: MessageEvent) => void): void;
  collection(name: string): {
    create(data: Record<string, unknown>): Promise<unknown>;
    update?(id: string, data: Record<string, unknown>): Promise<unknown>;
    getList(): NetRecord[];
    subscribe(cb: (records: NetRecord[]) => void): (() => void) | void;
  };
}
type WebsimSocketCtor = new () => WebsimRoom;

/** True only inside the websim host, which injects a global WebsimSocket. */
export function websimSocketAvailable(): boolean {
  return typeof globalThis !== 'undefined' && typeof (globalThis as { WebsimSocket?: unknown }).WebsimSocket === 'function';
}

/** Resolves to the offline adapter when the platform socket is missing or fails to connect. */
export async function connectTransport(timeoutMs = 8000): Promise<NetTransport> {
  if (!websimSocketAvailable()) return createOfflineTransport();
  try {
    const Ctor = (globalThis as unknown as { WebsimSocket: WebsimSocketCtor }).WebsimSocket;
    const room = new Ctor();
    let timer = 0;
    await Promise.race([
      room.initialize(),
      new Promise<void>((_resolve, reject) => { timer = window.setTimeout(() => reject(new Error('Online service timed out')), timeoutMs); }),
    ]).finally(() => window.clearTimeout(timer));
    // initialize() swallows connection errors and leaves an empty client id.
    if (!room.clientId) return createOfflineTransport();
    return wrapWebsimRoom(room);
  } catch (error) {
    console.warn('LATERAL online unavailable', error);
    return createOfflineTransport();
  }
}

function safe(fn: () => unknown): void {
  try { const result = fn(); if (result && typeof (result as Promise<unknown>).catch === 'function') (result as Promise<unknown>).catch(() => {}); }
  catch (error) { console.warn('LATERAL online call failed', error); }
}

export function wrapWebsimRoom(room: WebsimRoom): NetTransport {
  const detachers: (() => void)[] = [];
  const track = (off: (() => void) | void): (() => void) => {
    const detach = typeof off === 'function' ? off : () => {};
    detachers.push(detach);
    return detach;
  };
  return {
    available: true,
    get selfId() { return room.clientId; },
    peers: () => room.peers ?? {},
    presence: () => room.presence ?? {},
    roomState: () => room.roomState ?? {},
    updatePresence: patch => safe(() => room.updatePresence(patch)),
    updateRoomState: patch => safe(() => room.updateRoomState(patch)),
    send: message => safe(() => room.send(message)),
    onMessage(callback) {
      const listener = (event: MessageEvent): void => {
        const data = event.data as unknown;
        if (data && typeof data === 'object') callback(data as Record<string, unknown>);
      };
      room.addEventListener('message', listener);
      return track(() => room.removeEventListener('message', listener));
    },
    onPresence: callback => track(room.subscribePresence(p => callback(p))),
    onRoomState: callback => track(room.subscribeRoomState(s => callback(s))),
    collection(name) {
      try {
        const collection = room.collection(name);
        return {
          create: data => collection.create(data),
          ...(typeof collection.update === "function" ? { update: (id: string, data: Record<string, unknown>) => collection.update!(id, data) } : {}),
          getList: () => collection.getList() ?? [],
          subscribe: callback => track(collection.subscribe(records => callback(records ?? []))),
        };
      } catch { return null; }
    },
    dispose() { for (const detach of detachers.splice(0)) safe(detach); },
  };
}
