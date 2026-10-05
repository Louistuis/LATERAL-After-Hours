import { describe, expect, it, vi } from 'vitest';
import { CREATOR_GRANT_MARKS, LATERAL_CREATOR_USERNAME, createCreatorSource } from '../../src/economy/creator';
import { createEconomy } from '../../src/economy/economy';
import { createRemoteVerifier } from '../../src/economy/remote-verify';
import type { WalletRecord, WalletStore } from '../../src/economy/types';
import { emptyWallet } from '../../src/economy/wallet';
import type { WebsimHost } from '../../src/economy/websim-host';

const CREATOR = '47085852-a3b9-4326-88a0-d06f5f891aba';
const NOW = Date.UTC(2026, 9, 2, 12);
const noGame = { onRunFinished: () => () => {} };
const host = (user: unknown): WebsimHost => ({
  getCurrentUser: async () => user as never, getCurrentProject: async () => ({ id: 'p' }), postComment: async () => ({}), addEventListener: () => () => {},
});
const memory = (record: WalletRecord | null = null): WalletStore => {
  let current = record;
  return { id: 'm', durable: true, load: async () => current, save: async r => { current = r; } };
};
const money = (source: ReturnType<typeof createCreatorSource>) => createEconomy({ store: memory(), sources: [source], game: noGame, now: () => NOW });

describe('creator grant', () => {
  it('pays exactly 100000 Marks to the configured creator id and shows it in earnedBySource', async () => {
    const economy = money(createCreatorSource({ host: host({ id: CREATOR, username: 'Louis' }), creatorId: CREATOR }));
    await economy.refresh();
    expect(CREATOR_GRANT_MARKS).toBe(100000);
    expect(economy.view().earnedBySource.creator).toBe(100000);
    expect(economy.view().balance).toBe(100000);
    expect(economy.view().lastCredit).toBeNull();
  });
  it('pays nothing to anyone else, including a spoofed username on a different id, anonymous users and no configured creator', async () => {
    for (const user of [{ id: 'someone-else', username: 'Louis' }, { id: 'x', username: 'louis' }, { id: CREATOR.toUpperCase(), username: 'Louis' }, { id: CREATOR, username: 'Louis', is_anonymous: true }, null, {}]) {
      const economy = money(createCreatorSource({ host: host(user), creatorId: CREATOR }));
      await economy.refresh();
      expect(economy.view().balance).toBe(0);
      expect(economy.view().earnedBySource.creator ?? 0).toBe(0);
    }
    const unset = money(createCreatorSource({ host: host({ id: CREATOR, username: 'Louis' }), creatorId: null }));
    await unset.refresh();
    expect(unset.view().balance).toBe(0);
  });
  it('is silent: never listed in Get Marks and has no offers', () => {
    const source = createCreatorSource({ host: host({ id: CREATOR }), creatorId: CREATOR });
    expect(source.silent).toBe(true);
    expect(source.available()).toBe(false);
    expect(source.offers!()).toEqual([]);
    expect(source.kind).toBe('derived');
  });
  it('covers the creator\'s purchases so they are not locked, and a non-creator with the same record is locked', async () => {
    const owned = ['car-cybertruck', 'gold-chrome', 'rim-gold'];
    const record = { ...emptyWallet(NOW), owned };
    const creator = createEconomy({ store: memory(record), sources: [createCreatorSource({ host: host({ id: CREATOR, username: 'Louis' }), creatorId: CREATOR })], game: noGame, now: () => NOW });
    await creator.refresh();
    expect(creator.view().locked!.size).toBe(0);
    expect([...creator.view().owned].sort()).toEqual([...owned].sort());
    expect(creator.carAllowed!('CAR-02')).toBe(true);
    expect(await creator.purchase('plate-berth')).toMatchObject({ ok: true });
    const other = createEconomy({ store: memory(record), sources: [createCreatorSource({ host: host({ id: 'other', username: 'Louis' }), creatorId: CREATOR })], game: noGame, now: () => NOW });
    await other.refresh();
    expect(other.view().locked!.size).toBe(3);
    expect(other.carAllowed!('CAR-02')).toBe(false);
  });
  it('an identity failure is not settled (purchases refused) and recovers on retry', async () => {
    let fail = true;
    const scheduled: (() => void)[] = [];
    const source = createCreatorSource({
      host: { ...host({ id: CREATOR }), getCurrentUser: async () => { if (fail) throw new Error('rpc'); return { id: CREATOR, username: 'Louis' }; } },
      creatorId: CREATOR, schedule: fn => { scheduled.push(fn); return 0; },
    });
    await source.refresh!();
    expect(source.settled!()).toBe(false);
    expect(source.status!()).toBe('error');
    expect(scheduled.length).toBeGreaterThan(0);
    fail = false;
    await source.refresh!();
    expect(source.settled!()).toBe(true);
    expect(source.total!()).toBe(100000);
  });
});

describe('creator grant for remote players', () => {
  const page = { comments: { data: [] as unknown[], meta: { has_next_page: false, end_cursor: null } } };
  const make = (rows: { username: string; owned: string[] }[]) => {
    const verifier = createRemoteVerifier({
      fetchJson: vi.fn(async () => ({ ...page, comments: { ...page.comments, data: [{ comment: { id: 'x', author: { id: 'u', username: 'someone' }, card_data: { type: 'tip_comment', credits_spent: 200 } } }] } })),
      projectId: () => "p", now: () => NOW, missionAllowance: () => 0, welcomeAllowance: 0,
      wallets: () => rows.map(row => ({ username: row.username, created_at: new Date(NOW).toISOString(), w: JSON.stringify({ owned: row.owned }) })),
    });
    return verifier;
  };
  it('counts the 100000 for the creator\'s server-set username (any case) and for nobody else', async () => {
    const owned = ['car-cybertruck', 'gold-chrome', 'rim-gold'];
    const verifier = make([{ username: LATERAL_CREATOR_USERNAME, owned }, { username: 'LOUIS', owned }, { username: 'Louis2', owned }, { username: 'mallory', owned }]);
    await verifier.refresh();
    expect([...verifier.allowed('Louis')!].sort()).toEqual([...owned].sort());
    expect(verifier.allowed('louis')!.size).toBe(3);
    expect(verifier.allowed('Louis2')!.size).toBe(0);
    expect(verifier.allowed('mallory')!.size).toBe(0);
    expect(verifier.look('Louis', 'CAR-02', '~gold-chrome......').car).toBe('CAR-02');
    expect(verifier.look('mallory', 'CAR-02', '~gold-chrome......').car).toBe('CAR-01');
  });
  it('the grant is a budget, not a free pass: purchases beyond it are still locked', async () => {
    const rows = [{ username: 'Louis', owned: Array.from({ length: 30 }, () => 'car-cybertruck') }];
    const verifier = make(rows);
    await verifier.refresh();
    expect(verifier.allowed('Louis')!.size).toBe(1);
  });
});
