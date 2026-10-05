/**
 * Starts the multiplayer side of the self-hosted build: waits for the account choice, connects with the account token,
 * hands the connected transport to the online feature (src/net/index.ts) and keeps trying while the server is away.
 * Players without an account get no socket, only read-only boards over HTTP.
 */
import type { NetCollection, NetTransport } from '../net/transport';
import { selfhostServices } from './boot';
import { createReadOnlyCollection, createSelfhostTransport, type SelfhostTransport } from './transport';

const RETRY_MS = 30_000;
const CONNECT_MS = 8000;

export interface SelfhostOnlineHooks {
  adopt(transport: NetTransport): void;
  connecting(value: boolean): void;
  isDisposed(): boolean;
}

export function startSelfhostOnline(hooks: SelfhostOnlineHooks | null): { readCollection(name: string): NetCollection | null; dispose(): void } {
  const services = selfhostServices();
  const readers = new Map<string, NetCollection>();
  let disposed = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let live: SelfhostTransport | null = null;
  const readCollection = (name: string): NetCollection | null => {
    if (!/^[A-Za-z0-9_]{3,40}$/.test(name)) return null;
    let reader = readers.get(name);
    if (!reader) { reader = createReadOnlyCollection(services.account.api, name); readers.set(name, reader); }
    return reader;
  };
  const onBack = (): void => { live?.reconnectNow(); };
  const run = async (): Promise<void> => {
    if (!hooks) return;
    await services.decided;
    if (disposed || hooks.isDisposed()) return;
    if (!services.account.current()) { hooks.connecting(false); return; }
    hooks.connecting(true);
    const transport = createSelfhostTransport({
      token: () => services.account.token(),
      api: services.account.api,
      onWallet: (version, inbox) => { if (inbox) void services.wallet.refresh(); else services.wallet.pushed(version); },
      // The server did not accept the token any more: let the account service find out and sign this device out.
      onStopped: reason => { if (reason === 'auth') void services.account.refresh(); },
    });
    const ok = await transport.whenWelcome(CONNECT_MS);
    if (disposed || hooks.isDisposed()) { transport.dispose(); return; }
    if (!ok) {
      transport.dispose();
      hooks.connecting(false);
      timer = setTimeout(() => { timer = null; void run(); }, RETRY_MS);
      return;
    }
    live = transport;
    hooks.connecting(false);
    hooks.adopt(transport);
  };
  if (typeof window !== 'undefined') window.addEventListener('online', onBack);
  void run();
  return {
    readCollection,
    dispose() {
      disposed = true;
      if (timer) clearTimeout(timer);
      if (typeof window !== 'undefined') window.removeEventListener('online', onBack);
    },
  };
}
