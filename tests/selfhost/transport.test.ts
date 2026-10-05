import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { connectSelfhostTransport, createReadOnlyCollection, createSelfhostTransport, mergeRoom, type SelfhostTransportOptions } from '../../src/selfhost/transport';
import { createApi } from '../../src/selfhost/api';

class FakeSocket {
  static all: FakeSocket[] = [];
  readyState = 0;
  sent: Record<string, unknown>[] = [];
  onopen: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  constructor(readonly url: string) { FakeSocket.all.push(this); }
  send(data: string): void { this.sent.push(JSON.parse(data)); }
  close(code = 1000): void { if (this.readyState === 3) return; this.readyState = 3; this.onclose?.({ code }); }
  // test helpers
  open(): void { this.readyState = 1; this.onopen?.({}); }
  say(frame: unknown): void { this.onmessage?.({ data: JSON.stringify(frame) }); }
  drop(code = 1006): void { this.readyState = 3; this.onclose?.({ code }); }
}
const welcome = (id = 'me', extra: Record<string, unknown> = {}) => ({ t: 'w', v: 1, id, name: 'Louis', serverTime: Date.now(), presence: { [id]: { u: 'Louis' } }, room: { lobbies: {} }, ...extra });

function make(overrides: Partial<SelfhostTransportOptions> = {}) {
  const stopped: string[] = [], states: string[] = [];
  const transport = createSelfhostTransport({
    url: 'ws://test/ws', token: () => 'secret-token-1234567890', api: createApi({ fetch: (async () => new Response('{}')) as typeof fetch }),
    WebSocket: FakeSocket as unknown as SelfhostTransportOptions['WebSocket'], random: () => 0.5,
    onStopped: reason => stopped.push(reason), onState: state => states.push(state), ...overrides,
  });
  return { transport, stopped, states };
}
const live = (): FakeSocket => FakeSocket.all.at(-1)!;
function connect(id = 'me'): FakeSocket { const socket = live(); socket.open(); socket.say(welcome(id)); return socket; }

beforeEach(() => { FakeSocket.all = []; vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe('selfhost transport', () => {
  it('sends the token in the hello frame and never in the URL', () => {
    make();
    const socket = live();
    expect(socket.url).toBe('ws://test/ws');
    expect(socket.url).not.toContain('secret');
    socket.open();
    expect(socket.sent[0]).toEqual({ t: 'h', token: 'secret-token-1234567890', v: 1 });
  });

  it('takes the id and presence from the welcome and applies its own presence at once', () => {
    const { transport } = make();
    connect('me');
    expect(transport.selfId).toBe('me');
    expect(transport.peers().me?.username).toBe('Louis');
    transport.updatePresence({ on: 1, car: 2 });
    expect(transport.presence().me).toMatchObject({ u: 'Louis', on: 1, car: 2 });
  });

  it('coalesces presence into one frame and never sends the server only fields', () => {
    const { transport } = make();
    const socket = connect();
    transport.updatePresence({ on: 1 });
    transport.updatePresence({ car: 3, u: 'Mallory', pt: 'forged' });
    vi.advanceTimersByTime(300);
    const frames = socket.sent.filter(frame => frame.t === 'p');
    expect(frames).toHaveLength(1);
    expect(frames[0]!.d).toEqual({ on: 1, car: 3 });
    // The same value again is not sent twice.
    transport.updatePresence({ car: 3 });
    vi.advanceTimersByTime(300);
    expect(socket.sent.filter(frame => frame.t === 'p')).toHaveLength(1);
  });

  it('merges room patches the websim way: objects merge and null deletes', () => {
    const { transport } = make();
    const socket = connect();
    transport.updateRoomState({ lobbies: { a: { host: 'me', route: 'r1' } } });
    transport.updateRoomState({ lobbies: { a: { route: 'r2' } } });
    expect((transport.roomState().lobbies as Record<string, unknown>).a).toEqual({ host: 'me', route: 'r2' });
    transport.updateRoomState({ lobbies: { a: null } });
    expect((transport.roomState().lobbies as Record<string, unknown>).a).toBeUndefined();
    vi.advanceTimersByTime(500);
    expect(socket.sent.some(frame => frame.t === 'r')).toBe(true);
    expect(mergeRoom({ a: { b: 1 } }, { a: { c: 2 }, d: null })).toEqual({ a: { b: 1, c: 2 } });
  });

  it('delivers broadcasts with the sender id and ignores junk', () => {
    const { transport } = make();
    const socket = connect();
    const got: Record<string, unknown>[] = [];
    transport.onMessage(data => got.push(data));
    socket.say({ t: 'M', f: 'peer', d: { type: 'h' } });
    socket.say({ t: 'M', b: [['p1', { type: 's', d: [1] }], ['p2', { type: 's', d: [2] }]] });
    socket.onmessage?.({ data: 'not json' });
    socket.say({ t: 'M', f: 'x', d: 'not an object' });
    expect(got.map(item => item.f)).toEqual(['peer', 'p1', 'p2']);
    expect(got[0]).toMatchObject({ clientId: 'peer', type: 'h' });
  });

  it('reconnects with backoff and jitter, then re-sends presence and the lobby it hosts', () => {
    const { transport, states } = make();
    const first = connect();
    transport.updateRoomState({ lobbies: { lob1: { host: 'me', route: 'r1' } } });
    transport.updatePresence({ on: 1, lb: 'lob1', car: 2 });
    vi.advanceTimersByTime(500);
    first.drop(1006);
    expect(states.at(-1)).toBe('closed');
    expect(FakeSocket.all).toHaveLength(1);
    // random() = 0.5 gives the plain 500 ms step.
    vi.advanceTimersByTime(499);
    expect(FakeSocket.all).toHaveLength(1);
    vi.advanceTimersByTime(2);
    expect(FakeSocket.all).toHaveLength(2);
    const second = live();
    second.open();
    expect(second.sent[0]).toMatchObject({ t: 'h' });
    // The server restarted: no lobbies, no presence. The welcome says so, and the client puts both back.
    second.say(welcome('me2'));
    const lobby = second.sent.find(frame => frame.t === 'r');
    expect(lobby).toEqual({ t: 'r', d: { lobbies: { lob1: { host: 'me', route: 'r1' } } } });
    const presence = second.sent.find(frame => frame.t === 'p');
    expect(presence?.d).toMatchObject({ on: 1, lb: 'lob1', car: 2 });
    expect(transport.state()).toBe('open');
    expect(second.sent.indexOf(lobby!)).toBeLessThan(second.sent.indexOf(presence!));
  });

  it('does not re-create a lobby the server still has', () => {
    const { transport } = make();
    const first = connect();
    transport.updateRoomState({ lobbies: { lob1: { host: 'me' } } });
    transport.updatePresence({ lb: 'lob1' });
    vi.advanceTimersByTime(500);
    first.drop();
    vi.advanceTimersByTime(600);
    const second = live();
    second.open();
    second.say(welcome('me', { room: { lobbies: { lob1: { host: 'me' } } } }));
    expect(second.sent.filter(frame => frame.t === 'r')).toHaveLength(0);
  });

  it('grows the delay on repeated failures with jitter inside +-30 percent', () => {
    let roll = 0;
    const rolls = [0, 1];
    make({ random: () => rolls[roll++ % 2]! });
    live().drop();
    // first step: 500 * 0.7 = 350
    vi.advanceTimersByTime(349); expect(FakeSocket.all).toHaveLength(1);
    vi.advanceTimersByTime(2); expect(FakeSocket.all).toHaveLength(2);
    live().drop();
    // second step: 1000 * 1.3 = 1300
    vi.advanceTimersByTime(1299); expect(FakeSocket.all).toHaveLength(2);
    vi.advanceTimersByTime(2); expect(FakeSocket.all).toHaveLength(3);
  });

  it('stops for good when the server rejects the token', () => {
    const { stopped, transport } = make();
    const socket = connect();
    socket.drop(4401);
    expect(stopped).toEqual(['auth']);
    expect(transport.state()).toBe('stopped');
    vi.advanceTimersByTime(120_000);
    expect(FakeSocket.all).toHaveLength(1);
  });

  it('reports banned and replaced sessions', () => {
    const a = make(); connect(); live().drop(4403); expect(a.stopped).toEqual(['banned']);
    FakeSocket.all = [];
    const b = make(); connect(); live().drop(4409); expect(b.stopped).toEqual(['replaced']);
  });

  it('answers server pings and passes wallet pushes on', () => {
    const pushes: [number, boolean][] = [];
    make({ onWallet: (version, inbox) => pushes.push([version, inbox]) });
    const socket = connect();
    socket.say({ t: 'ping', ts: 1 });
    expect(socket.sent.some(frame => frame.t === 'pong')).toBe(true);
    socket.say({ t: 'wallet', version: 7, inbox: true });
    expect(pushes).toEqual([[7, true]]);
  });

  it('feeds its own liveness echo so the session does not time out', () => {
    const { transport } = make();
    const socket = connect('me');
    const got: Record<string, unknown>[] = [];
    transport.onMessage(data => got.push(data));
    socket.say({ t: 'ping', ts: 1 });
    vi.advanceTimersByTime(2100);
    expect(got.some(item => item.f === 'me')).toBe(true);
  });

  it('drops a socket that went silent and reconnects', () => {
    make();
    connect();
    vi.advanceTimersByTime(61_000);
    expect(FakeSocket.all.length).toBeGreaterThanOrEqual(2);
  });

  it('does not send frames over the 2 KB limit', () => {
    const { transport } = make();
    const socket = connect();
    transport.send({ type: 's', blob: 'x'.repeat(3000) });
    expect(socket.sent.filter(frame => frame.t === 'm')).toHaveLength(0);
    transport.send({ type: 'h' });
    expect(socket.sent.filter(frame => frame.t === 'm')).toHaveLength(1);
  });

  it('subscribes to a collection after a reconnect again', () => {
    const { transport } = make();
    const first = connect();
    const seen: number[] = [];
    transport.collection('lateral_best_v1')!.subscribe(rows => seen.push(rows.length));
    expect(first.sent.some(frame => frame.t === 'c' && frame.op === 'sub')).toBe(true);
    first.say({ t: 'C', n: 'lateral_best_v1', r: 1, ok: true, full: true, rows: [{ id: 'a' }] });
    expect(seen).toEqual([1]);
    first.drop();
    vi.advanceTimersByTime(600);
    const second = live();
    second.open(); second.say(welcome());
    expect(second.sent.some(frame => frame.t === 'c' && frame.op === 'sub')).toBe(true);
  });

  it('writes rows over HTTP, not the socket', async () => {
    const calls: { url: string; body: unknown }[] = [];
    const fetcher = (async (url: string, init?: RequestInit) => { calls.push({ url, body: JSON.parse(String(init?.body)) }); return new Response(JSON.stringify({ ok: true, id: 'row1' })); }) as unknown as typeof fetch;
    const { transport } = make({ api: createApi({ fetch: fetcher, token: () => 't' }) });
    const socket = connect();
    const result = await transport.collection('lateral_ghost_v1')!.create({ value: 1 });
    expect(result).toEqual({ id: 'row1' });
    expect(calls[0]!.url).toBe('/api/v1/collections/lateral_ghost_v1');
    expect(socket.sent.some(frame => frame.t === 'c' && frame.op === 'create')).toBe(false);
  });

  it('falls back to the offline transport when the first connection never comes up', async () => {
    const pending = connectSelfhostTransport({ url: 'ws://test/ws', token: () => 'secret-token-1234567890', api: createApi({ fetch: (async () => new Response('{}')) as typeof fetch }), WebSocket: FakeSocket as unknown as SelfhostTransportOptions['WebSocket'] }, 3000);
    await vi.advanceTimersByTimeAsync(3100);
    const transport = await pending;
    expect(transport.available).toBe(false);
  });

  it('is offline at once without an account', async () => {
    const transport = await connectSelfhostTransport({ token: () => null, api: createApi({ fetch: (async () => new Response('{}')) as typeof fetch }), WebSocket: FakeSocket as unknown as SelfhostTransportOptions['WebSocket'] });
    expect(transport.available).toBe(false);
    expect(FakeSocket.all).toHaveLength(0);
  });

  it('stops everything on dispose', () => {
    const { transport } = make();
    connect();
    transport.dispose();
    vi.advanceTimersByTime(120_000);
    expect(FakeSocket.all).toHaveLength(1);
  });
});

describe('read only collections for players without an account', () => {
  it('lists over HTTP, polls while someone listens, and refuses writes', async () => {
    let served = 0;
    const fetcher = (async () => { served++; return new Response(JSON.stringify({ rows: [{ id: `r${served}` }] })); }) as unknown as typeof fetch;
    const collection = createReadOnlyCollection(createApi({ fetch: fetcher }), 'lateral_best_v1', { pollMs: 1000 });
    const seen: string[] = [];
    const off = collection.subscribe(rows => seen.push(rows[0]!.id));
    await vi.advanceTimersByTimeAsync(10);
    await vi.advanceTimersByTimeAsync(1100);
    expect(seen).toEqual(['r1', 'r2']);
    off();
    await vi.advanceTimersByTimeAsync(5000);
    expect(served).toBe(2);
    await expect(collection.create({})).rejects.toThrow(/account/);
  });
});
