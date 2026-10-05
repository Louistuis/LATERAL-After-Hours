import { describe, expect, it } from 'vitest';
import { ACCOUNT_KEY, EXPIRED_KEY, GUEST_KEY, NAME_RULES, createAccountService, explainFailure, validateDriverName } from '../../src/selfhost/account';
import { FakeServer, memoryStorage } from './helpers';

describe('driver names', () => {
  it('checks the rules before any request', () => {
    expect(validateDriverName('')).toMatch(/Pick/);
    expect(validateDriverName('ab')).toMatch(/at least 3/);
    expect(validateDriverName('x'.repeat(17))).toMatch(/at most 16/);
    expect(validateDriverName('has space')).toMatch(/No spaces/);
    expect(validateDriverName('Nord_bo-1')).toBeNull();
    expect(validateDriverName('  Louis  ')).toBeNull();
  });
  it('writes plain text without em dashes', () => {
    for (const text of [NAME_RULES, explainFailure({ status: 409, code: 'name-taken', message: '', network: false }, 'create'), explainFailure({ status: 0, code: '', message: '', network: true }, 'create'), explainFailure({ status: 401, code: 'bad-recovery', message: '', network: false }, 'recover')]) expect(text).not.toMatch(/—|–/);
  });
});

describe('account service', () => {
  it('creates an account, keeps the token in localStorage and returns the recovery code once', async () => {
    const server = new FakeServer(), storage = memoryStorage();
    const service = createAccountService({ storage, fetch: server.fetch });
    expect(service.needsChoice()).toBe(true);
    const result = await service.create('Louis');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.recoveryCode).toMatch(/^[A-Z]{4}-[A-Z]{4}-[A-Z]{4}-\d{4}$/);
    expect(service.current()?.name).toBe('Louis');
    expect(service.needsChoice()).toBe(false);
    const stored = JSON.parse(storage.getItem(ACCOUNT_KEY)!);
    expect(stored.token).toBe(service.token());
    // The recovery code is never stored by the client.
    expect(JSON.stringify(storage.dump())).not.toContain(result.recoveryCode);
  });

  it('never puts the token in a URL, and sends it as a bearer header', async () => {
    const server = new FakeServer();
    const service = createAccountService({ storage: memoryStorage(), fetch: server.fetch });
    await service.create('Driver1');
    await service.refresh();
    for (const call of server.calls) expect(call.url).not.toContain(service.token()!);
    expect(server.calls.at(-1)!.auth).toBe(`Bearer ${service.token()}`);
  });

  it('says plainly when a name is taken or invalid and stays signed out', async () => {
    const server = new FakeServer();
    await createAccountService({ storage: memoryStorage(), fetch: server.fetch }).create('Taken');
    const service = createAccountService({ storage: memoryStorage(), fetch: server.fetch });
    const taken = await service.create('taken');
    expect(taken).toMatchObject({ ok: false, message: 'That name is taken. Try another.' });
    const invalid = await service.create('no');
    expect(invalid.ok).toBe(false);
    expect(service.current()).toBeNull();
  });

  it('reports a network failure as retryable', async () => {
    const server = new FakeServer(); server.down = true;
    const service = createAccountService({ storage: memoryStorage(), fetch: server.fetch });
    const result = await service.create('Offline1');
    expect(result).toMatchObject({ ok: false, retry: true });
  });

  it('recovers on another device with the name and code (case and spacing tolerant)', async () => {
    const server = new FakeServer();
    const first = createAccountService({ storage: memoryStorage(), fetch: server.fetch });
    const made = await first.create('Louis');
    if (!made.ok) throw new Error('create failed');
    const other = createAccountService({ storage: memoryStorage(), fetch: server.fetch });
    const wrong = await other.recover('Louis', 'WRONG-CODE');
    expect(wrong).toMatchObject({ ok: false, message: 'That name and recovery code do not match. Check both and try again.' });
    const good = await other.recover(' louis ', made.recoveryCode.toLowerCase());
    expect(good.ok).toBe(true);
    expect(other.current()?.accountId).toBe(made.account.accountId);
    expect(other.token()).not.toBe(first.token());
  });

  it('regenerates the recovery code and signs out on request', async () => {
    const server = new FakeServer(), storage = memoryStorage();
    const service = createAccountService({ storage, fetch: server.fetch });
    const made = await service.create('Louis');
    if (!made.ok) throw new Error('create failed');
    const next = await service.regenerate();
    expect(next.ok && next.recoveryCode).not.toBe(made.recoveryCode);
    const token = service.token()!;
    service.signOut();
    await Promise.resolve();
    expect(server.calls.at(-1)).toMatchObject({ method: 'POST', url: '/api/v1/logout', auth: `Bearer ${token}` });
    expect(service.current()).toBeNull();
    expect(storage.getItem(ACCOUNT_KEY)).toBeNull();
    expect(service.needsChoice()).toBe(true);
  });

  it('signs out in the background when the server stops accepting the token, and tells the player once', async () => {
    const server = new FakeServer(), storage = memoryStorage();
    const service = createAccountService({ storage, fetch: server.fetch });
    await service.create('Louis');
    server.accounts.clear();
    expect(await service.refresh()).toBe('signed-out');
    expect(service.current()).toBeNull();
    expect(storage.getItem(EXPIRED_KEY)).toBe('1');
    expect(service.takeExpiredNotice()).toBe(true);
    expect(service.takeExpiredNotice()).toBe(false);
  });

  it('keeps the account when the server is merely unreachable', async () => {
    const server = new FakeServer();
    const service = createAccountService({ storage: memoryStorage(), fetch: server.fetch });
    await service.create('Louis');
    server.down = true;
    expect(await service.refresh()).toBe('offline');
    expect(service.current()?.name).toBe('Louis');
  });

  it('remembers playing without an account', () => {
    const storage = memoryStorage();
    const service = createAccountService({ storage, fetch: new FakeServer().fetch });
    service.setGuest(true);
    expect(service.isGuest()).toBe(true);
    expect(service.needsChoice()).toBe(false);
    expect(createAccountService({ storage, fetch: new FakeServer().fetch }).needsChoice()).toBe(false);
    service.setGuest(false);
    expect(storage.getItem(GUEST_KEY)).toBeNull();
  });

  it('survives blocked storage', async () => {
    const server = new FakeServer();
    const broken = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); }, removeItem() { throw new Error('blocked'); } };
    const service = createAccountService({ storage: broken, fetch: server.fetch });
    const made = await service.create('Louis');
    expect(made.ok).toBe(true);
    expect(service.current()?.name).toBe('Louis');
  });
});
