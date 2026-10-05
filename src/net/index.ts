import * as THREE from 'three';
import type { CarId } from '../../contracts/runtime-contracts';
import { EVENTS } from '../../content/events/catalog';
import type { GameRuntime } from '../core/game-runtime';
import type { ExperienceCoordinator } from '../experience/coordinator';
import type { CarPresentation } from '../scene-pipeline/ports';
import { playLocalHorn, presencePaint } from '../economy/loadout-bridge';
import { createRemoteVerifier } from '../economy/remote-verify';
import { WALLET_COLLECTION } from '../economy/stores';
import { websimHost, withTimeout } from '../economy/websim-host';
import { HornAudio } from './horn';
import { gridOffset, type RaceMode } from './lobby';
import { NetLoopback } from './loopback';
import { RemoteCars } from './remote-cars';
import { NetSession, type OnlineView } from './session';
import { connectTransport, websimSocketAvailable, type NetCollection, type NetTransport } from './transport';
import { SELFHOST } from '../core/target';
import { startSelfhostOnline } from '../selfhost/online';

export type { OnlineView, NetSession, NetToast } from './session';
export type { RaceMode } from './lobby';

export interface OnlineFeature {
  /** True once the platform socket is connected. Always false off websim. */
  available(): boolean;
  playersOnline(): number;
  /** 'off' off websim or after a failed connect, 'connecting' while the socket comes up, 'ready' once connected. */
  status(): 'off' | 'connecting' | 'ready';
  session(): NetSession | null;
  /** A websim collection on the connected socket (daily board, shared ghosts), or null offline. */
  collection(name: string): NetCollection | null;
  /** Self-hosted build: a read only view of a board over HTTP, for players without an account or while the socket is down. */
  readCollection?(name: string): NetCollection | null;
  subscribe(listener: (view: OnlineView | null) => void): () => void;
  dispose(): void;
}

type GridRuntime = GameRuntime & { armGridOffset?(offset: { rightM: number; backM: number } | null): void };

/**
 * Connects to websim multiplayer in the background. Off websim (nordcore.site,
 * Poki, CrazyGames, tests) this resolves to nothing and the menu never shows Online.
 */
export function createOnlineFeature(runtime: GameRuntime, coordinator: ExperienceCoordinator, hooks: {
  beforeRace(): void;
  focusDrive(): void;
}): OnlineFeature {
  let session: NetSession | null = null;
  let disposed = false;
  let connecting = false;
  const cleanup: (() => void)[] = [];
  const listeners = new Set<(view: OnlineView | null) => void>();
  const loadCarModel = (runtime.scene as { loadCarModel?: (carId: CarId) => Promise<CarPresentation> }).loadCarModel;
  // Shop loadout rides in the paint string ("~..."); older clients ignore it and keep their default paint.
  const paint = (): string => presencePaint(coordinator.state().cosmetics?.paint ?? '', coordinator.state().cosmetics?.wheelStyle);

  // Owner-review only: ?netloopback renders the local car again as a remote car 3 m to the right.
  if (typeof __OWNER_REVIEW__ !== 'undefined' && __OWNER_REVIEW__ && loadCarModel
    && typeof location !== 'undefined' && new URLSearchParams(location.search).has('netloopback')) {
    const loopback = new NetLoopback(new RemoteCars(runtime.scene.scene, carId => loadCarModel(carId)), paint);
    const off = runtime.subscribe(view => loopback.tick(view, performance.now()));
    cleanup.push(() => { off(); loopback.dispose(); });
  }

  let readOnly: ((name: string) => NetCollection | null) | undefined;
  if ((SELFHOST || websimSocketAvailable()) && loadCarModel) {
    const adopt = (transport: NetTransport): void => {
      connecting = false;
      if (disposed || !transport.available) { transport.dispose(); return; }
      const remote = new RemoteCars(runtime.scene.scene, carId => loadCarModel(carId));
      // Other players' cosmetics and cars are only shown when their verified tips and wallet could have paid for them.
      // Self-hosted: the server stamps every driver's name and verified loadout into presence, so there is nothing to verify here.
      let verifier: ReturnType<typeof createRemoteVerifier> | null = null;
      if (!SELFHOST) {
        let projectId: string | null = null;
        const host = websimHost();
        const walletRows = transport.collection(WALLET_COLLECTION);
        const checker = createRemoteVerifier({
          projectId: () => projectId,
          wallets: () => walletRows?.getList() ?? [],
          fetchJson: async url => {
            const response = await fetch(url, { credentials: 'include' });
            if (!response.ok) throw new Error(`Comments request failed (${response.status})`);
            return response.json();
          },
        });
        verifier = checker;
        if (host) void withTimeout(host.getCurrentProject(), 6000).then(project => {
          if (project && typeof project.id === 'string' && project.id) { projectId = project.id; void checker.refresh(); }
        });
        const offWallets = walletRows?.subscribe(() => checker.invalidate());
        cleanup.push(() => { offWallets?.(); checker.dispose(); });
      }
      const horn = new HornAudio(() => {
        const settings = coordinator.state().settings;
        return settings.muted ? 0 : settings.masterVolume * settings.sfxVolume;
      });
      const hornAt = new THREE.Vector3(), cameraRight = new THREE.Vector3();
      const net = new NetSession(transport, {
        async beginRace(mode: RaceMode, route: string, slot: number) {
          hooks.beforeRace();
          const event = EVENTS.find(item => item.routeId === route && item.mode === mode);
          if (!event) throw new Error('This race is not available right now');
          if (coordinator.state().selection.route !== route) await coordinator.selectRoute(event.routeId);
          const gridRuntime = runtime as GridRuntime;
          gridRuntime.armGridOffset?.(gridOffset(slot));
          try { await coordinator.beginEvent({ mode: event.mode, rulesVersion: event.rulesVersion }); }
          finally { gridRuntime.armGridOffset?.(null); }
          hooks.focusDrive();
        },
        paint,
        selectedRoute: () => coordinator.state().selection.route,
        ...(verifier ? { verifyLook: (username: string, car: CarId, paintString: string) => verifier.look(username, car, paintString), onLooksChanged: (listener: () => void) => verifier.subscribe(listener) } : {}),
        carAllowed: car => coordinator.carAllowed(car),
        horn(fromId) {
          if (fromId === null) { if (!playLocalHorn()) horn.play(0, 0.75); return; }
          if (!remote.positionOf(fromId, hornAt)) return;
          const camera = runtime.scene.camera;
          hornAt.sub(camera.position);
          const distance = hornAt.length();
          if (distance > 220) return;
          cameraRight.setFromMatrixColumn(camera.matrixWorld, 0);
          horn.play(distance > 0.01 ? hornAt.dot(cameraRight) / distance * 0.85 : 0, 1 / (1 + distance / 18));
        },
      }, remote);
      session = net;
      net.subscribe(view => { for (const listener of listeners) listener(view); });
      const offFrame = runtime.subscribe(view => net.tick(view));
      const idleTimer = setInterval(() => net.idle(), 500);
      const onKey = (event: KeyboardEvent): void => {
        if (event.code !== 'KeyH' || event.repeat || event.metaKey || event.ctrlKey || event.altKey) return;
        const target = event.target as HTMLElement | null;
        if (target && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))) return;
        if (net.horn()) event.preventDefault();
      };
      const onOnline = (): void => net.setConnected(true);
      const onOffline = (): void => net.setConnected(false);
      const onHostMessage = SELFHOST ? (): void => {} : (event: MessageEvent): void => {
        const data = event.data as { type?: unknown } | null;
        if (data && typeof data === 'object' && data.type === 'websim_socket_reconnected') net.setConnected(true);
      };
      window.addEventListener('keydown', onKey);
      window.addEventListener('online', onOnline);
      window.addEventListener('offline', onOffline);
      if (!SELFHOST) window.addEventListener('message', onHostMessage);
      cleanup.push(() => {
        offFrame(); clearInterval(idleTimer);
        window.removeEventListener('keydown', onKey);
        window.removeEventListener('online', onOnline);
        window.removeEventListener('offline', onOffline);
        if (!SELFHOST) window.removeEventListener('message', onHostMessage);
        net.dispose(); net.transport.dispose(); horn.dispose();
      });
      for (const listener of listeners) listener(net.view());
    };
    if (SELFHOST) {
      const online = startSelfhostOnline({
        adopt: transport => { try { adopt(transport); } catch (error) { console.warn('LATERAL online unavailable', error); } },
        connecting: value => { connecting = value; for (const listener of listeners) listener(session?.view() ?? null); },
        isDisposed: () => disposed,
      });
      readOnly = online.readCollection;
      cleanup.push(() => online.dispose());
    } else {
      connecting = true;
      void connectTransport().then(adopt).catch(error => { connecting = false; console.warn('LATERAL online unavailable', error); });
    }
  } else if (SELFHOST) readOnly = startSelfhostOnline(null).readCollection;
  return {
    available: () => Boolean(session?.available),
    status: () => session?.available ? 'ready' : connecting && !disposed ? 'connecting' : 'off',
    playersOnline: () => {
      if (!session) return 0;
      // Always counts this player once: they only appear in presence after opening the lobby, and the menu shows count - 1.
      const presence = session.transport.presence(), self = session.transport.selfId;
      return Object.keys(presence).filter(id => id !== self && presence[id]?.on === 1).length + 1;
    },
    session: () => session,
    collection: name => (session?.available ? session.transport.collection(name) : null),
    readCollection: name => readOnly?.(name) ?? null,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const off of cleanup.splice(0)) off();
      listeners.clear();
    },
  };
}
