import { describe, expect, it, vi } from 'vitest';
import { decodeLoadout, encodeLoadout, sanitizeLoadout } from '../../src/economy/catalog';
import { drawPlateFace } from '../../src/economy/car-cosmetics';
import { createEconomy } from '../../src/economy/economy';
import {
  CUSTOM_PLATE_ID, DEFAULT_PLATE_TEXT, cleanPlateText, decodePlateText, encodePlateText, isBlockedPlate, validatePlateText,
} from '../../src/economy/plate';
import { createRemoteVerifier, parsePresencePaint, type RemoteWalletRow } from '../../src/economy/remote-verify';
import type { EarnSource, WalletRecord, WalletStore } from '../../src/economy/types';
import { MAX_PAINT, sanitizeText } from '../../src/net/sanitize';
import { applyPlateText, emptyWallet, normalizeWallet } from '../../src/economy/wallet';

const NOW = Date.UTC(2026, 9, 2, 12);
const DAY = 86_400_000;

describe('plate text validation', () => {
  it('accepts A-Z, 0-9, space and hyphen, trims, collapses spaces and uppercases', () => {
    expect(validatePlateText('dock 07')).toMatchObject({ ok: true, text: 'DOCK 07' });
    expect(validatePlateText('  a   b  ')).toMatchObject({ ok: true, text: 'A B' });
    expect(validatePlateText('ab-12')).toMatchObject({ ok: true, text: 'AB-12' });
    expect(validatePlateText('LATERAL')).toMatchObject({ ok: true, text: 'LATERAL' });
    expect(validatePlateText('12345678')).toMatchObject({ ok: true, text: '12345678' });
    expect(validatePlateText('ab')).toMatchObject({ ok: true, text: 'AB' });
  });
  it('rejects too short, too long, empty and not enough letters or digits, with a message', () => {
    expect(validatePlateText('a')).toMatchObject({ ok: false, reason: 'short' });
    expect(validatePlateText('-')).toMatchObject({ ok: false, reason: 'short' });
    expect(validatePlateText('a-')).toMatchObject({ ok: false, reason: 'short' });
    expect(validatePlateText('123456789')).toMatchObject({ ok: false, reason: 'long' });
    expect(validatePlateText('a'.repeat(500))).toMatchObject({ ok: false, reason: 'long' });
    expect(validatePlateText('')).toMatchObject({ ok: false, reason: 'empty' });
    expect(validatePlateText('   ')).toMatchObject({ ok: false, reason: 'empty' });
    for (const bad of ['a', '123456789', '', '_', 'x_y', 'a.b', 'a~b']) {
      const result = validatePlateText(bad);
      expect(result.ok).toBe(false);
      expect(result.message.length).toBeGreaterThan(0);
      expect(result.message).not.toMatch(/—|–/);
    }
  });
  it('rejects every other character, including Unicode that upper-cases into ASCII', () => {
    for (const bad of ['AB<C', 'a\tb', 'a\nb', 'ABß', 'ABı', 'ABſ', 'ＡＢ', 'AB\u{1F600}', 'ÁB', 'AB;', 'A/B', "A'B", '<b>']) expect(validatePlateText(bad), bad).toMatchObject({ ok: false, reason: 'chars' });
    for (const notString of [null, undefined, 12, {}, [], ['AB'], true]) expect(validatePlateText(notString)).toMatchObject({ ok: false, reason: 'empty' });
    expect(cleanPlateText('ok 1')).toBe('OK 1');
    expect(cleanPlateText('x')).toBeNull();
  });
});

describe('plate word filter', () => {
  it('blocks words as substrings, in any case and with spaces and hyphens in between', () => {
    for (const bad of ['FUCK', 'fuck', 'FUCKER', 'F U C K', 'F-U-C-K', 'f u-c k', 'SHIT', 'XSHITX', 'BITCH', 'NAZI', 'HITLER', 'RAPIST', 'NIGGER']) expect(validatePlateText(bad), bad).toMatchObject({ ok: false, reason: 'blocked' });
  });
  it('normalises leetspeak 0 1 3 4 5 7 before matching', () => {
    for (const bad of ['5H1T', 'SH1T', 'FUCK1NG', 'PORN', 'P0RN', 'B1TCH', 'N4Z1', 'H1TL3R', 'C0CK', 'WH0R3', '5LUT', 'PU55Y', 'D1CK', 'SLU7', 'FUC-K']) expect(validatePlateText(bad), bad).toMatchObject({ ok: false, reason: 'blocked' });
    expect(isBlockedPlate('5H1T')).toBe(true);
    expect(isBlockedPlate('LATERAL')).toBe(false);
  });
  // Like every substring filter this has the Scunthorpe problem for the long words (SCUNTHORPE contains one); that is the accepted trade.
  it('short words only match as a whole plate or a separate word, so ordinary words stay fine', () => {
    for (const ok of ['CLASS', 'PASS', 'PEACOCK', 'GRAPE', 'SPICE', 'PAKISTAN', 'ASSET', 'TITAN', 'SEXTON', 'COCKPIT', 'MASSIVE', 'LATERAL', 'DRIFT 07', 'KING', 'BERTH 9']) expect(validatePlateText(ok), ok).toMatchObject({ ok: true });
    for (const bad of ['ASS', 'BIG ASS', 'TIT-X', 'BIG COCK', 'SEX', 'A55', 'S3X']) expect(validatePlateText(bad), bad).toMatchObject({ ok: false, reason: 'blocked' });
  });
});

describe('plate wire encoding', () => {
  it('round trips every valid text and can not contain the loadout separators', () => {
    for (const text of ['DOCK 07', 'AB', 'AB-12', 'A B C', '12345678', 'LATERAL', '-AB-', '0-0']) {
      const wire = encodePlateText(text);
      expect(wire).toMatch(/^x[0-9A-F]+$/);
      expect(wire).not.toContain('.');
      expect(wire).not.toContain('~');
      expect(decodePlateText(wire)).toBe(validatePlateText(text).text);
    }
    expect(encodePlateText('dock 07')).toBe(encodePlateText('DOCK 07'));
    expect(encodePlateText('x')).toBe('');
    expect(encodePlateText('FUCK')).toBe('');
  });
  it('decoding re-validates, so a forged segment can not smuggle text in', () => {
    const hex = (text: string): string => `x${[...text].map(ch => ch.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')).join('')}`;
    expect(decodePlateText(hex('FUCK'))).toBeNull();
    expect(decodePlateText(hex('AB<C'))).toBeNull();
    expect(decodePlateText(hex('A'))).toBeNull();
    expect(decodePlateText(hex('ABCDEFGHI'))).toBeNull();
    for (const bad of ['', 'x', 'x4', 'x4G', 'x414', 'X4142', 'x4142z', 'x41.42', 'x41~42', null, undefined, 5, 'y4142']) expect(decodePlateText(bad as never), String(bad)).toBeNull();
    expect(decodePlateText('x4142')).toBe('AB');
  });
  it('rides in an eighth loadout segment only while the custom plate is fitted, and round trips through the loadout wire', () => {
    const loadout = { paint: 'carbon', plate: CUSTOM_PLATE_ID, horn: 'horn-bell', plateText: 'DOCK 07' };
    const wire = encodeLoadout(loadout);
    expect(wire.startsWith('~carbon.')).toBe(true);
    expect(wire.split('.')).toHaveLength(8);
    expect(wire.split('.').slice(0, 7).join('.')).toBe(encodeLoadout({ ...loadout, plateText: undefined }));
    expect(decodeLoadout(wire)).toEqual({ ...loadout });
    // Without the custom plate the text is never written, and never read.
    expect(encodeLoadout({ paint: 'carbon', plate: 'plate-dock7', plateText: 'DOCK 07' })).toBe(encodeLoadout({ paint: 'carbon', plate: 'plate-dock7' }));
    expect(decodeLoadout(`${encodeLoadout({ plate: 'plate-dock7' })}.${encodePlateText('DOCK 07')}`)?.plateText).toBeUndefined();
    // Old readers split on "." and only read seven segments; a text with spaces and hyphens still has no extra separator.
    expect(encodeLoadout({ plate: CUSTOM_PLATE_ID, plateText: 'A-B C' }).split('.')).toHaveLength(8);
    // Bad segments drop the text but keep the rest.
    expect(decodeLoadout(`~carbon....${CUSTOM_PLATE_ID}...x4655434B`)).toEqual({ paint: 'carbon', plate: CUSTOM_PLATE_ID });
    expect(encodeLoadout({ plate: CUSTOM_PLATE_ID, plateText: 'FUCK' })).toBe(encodeLoadout({ plate: CUSTOM_PLATE_ID }));
    expect(decodeLoadout(`${wire}.extra`)?.plateText).toBeUndefined();
  });
  it('survives the net sanitize layer unchanged and always fits the presence paint limit', () => {
    const longest = encodeLoadout({ paint: 'signal-lime-satin', rim: 'rim-gloss-black', underglow: 'glow-ultraviolet', smoke: 'smoke-crimson', plate: CUSTOM_PLATE_ID, horn: 'horn-foghorn', wheelStyle: 'forged', plateText: '88888888' });
    expect(longest.length).toBeLessThan(MAX_PAINT);
    expect(sanitizeText(longest, MAX_PAINT)).toBe(longest);
    const text = encodeLoadout({ plate: CUSTOM_PLATE_ID, plateText: 'A-B C 1' });
    expect(sanitizeText(text, MAX_PAINT)).toBe(text);
    expect(decodeLoadout(sanitizeText(longest, MAX_PAINT))?.plateText).toBe('88888888');
  });
  it('sanitizeLoadout keeps only valid text', () => {
    expect(sanitizeLoadout({ plate: CUSTOM_PLATE_ID, plateText: 'ok 12' })).toEqual({ plate: CUSTOM_PLATE_ID, plateText: 'OK 12' });
    expect(sanitizeLoadout({ plate: CUSTOM_PLATE_ID, plateText: 'FUCK' })).toEqual({ plate: CUSTOM_PLATE_ID });
    expect(sanitizeLoadout({ plateText: '<img src=x>' })).toEqual({});
    expect(sanitizeLoadout({ plateText: { toString: () => 'AB' } })).toEqual({});
  });
});

/* ------------------------------------------------------------------ the wallet and the economy */

const derived = (marks: number): EarnSource => ({ id: 'tips', kind: 'derived', label: 'Tips', available: () => true, total: () => marks, settled: () => true, subscribe: () => () => {}, dispose() {} }) as unknown as EarnSource;
const memory = (record: WalletRecord | null = null): WalletStore & { current: WalletRecord | null } => {
  const store = { current: record, id: 'm', durable: true, load: async () => store.current, save: async (next: WalletRecord) => { store.current = next; } };
  return store;
};
const noGame = { onRunFinished: () => () => {} };

describe('custom plate in the wallet and the economy', () => {
  it('applyPlateText needs a usable custom plate, validates, fits the plate and resets on empty', () => {
    const wallet = emptyWallet(NOW);
    expect(applyPlateText(wallet, 'ABC', NOW, () => false)).toMatchObject({ ok: false, reason: 'locked' });
    const ok = applyPlateText(wallet, ' dock 07 ', NOW, () => true);
    expect(ok.ok && ok.record.equipped).toEqual({ plate: CUSTOM_PLATE_ID, plateText: 'DOCK 07' });
    expect(applyPlateText(wallet, 'FUCK', NOW, () => true)).toMatchObject({ ok: false, reason: 'blocked' });
    expect(applyPlateText(wallet, 'x', NOW, () => true)).toMatchObject({ ok: false, reason: 'short' });
    expect(applyPlateText(wallet, 42, NOW, () => true)).toMatchObject({ ok: false });
    const reset = applyPlateText(ok.ok ? ok.record : wallet, '  ', NOW, () => true);
    expect(reset.ok && reset.record.equipped).toEqual({ plate: CUSTOM_PLATE_ID });
  });
  it('normalizeWallet keeps valid stored text and drops blocked or junk text', () => {
    expect(normalizeWallet({ equipped: { plate: CUSTOM_PLATE_ID, plateText: 'OK 1' } }).equipped).toEqual({ plate: CUSTOM_PLATE_ID, plateText: 'OK 1' });
    expect(normalizeWallet({ equipped: { plate: CUSTOM_PLATE_ID, plateText: 'SH1T' } }).equipped).toEqual({ plate: CUSTOM_PLATE_ID });
    expect(normalizeWallet({ equipped: { plateText: 'A'.repeat(3000) } }).equipped).toEqual({});
  });
  it('is locked until bought: setPlateText refuses, and a purchase at 9990 then unlocks it', async () => {
    const store = memory();
    const economy = createEconomy({ store, sources: [derived(9000)], game: noGame, now: () => NOW });
    await economy.refresh();
    expect(economy.itemState!(CUSTOM_PLATE_ID)).toMatchObject({ price: 9990, status: 'unaffordable', shortfall: 990 });
    expect(await economy.setPlateText!('DOCK 07')).toMatchObject({ ok: false, reason: 'locked' });
    expect(economy.view().equipped.plateText).toBeUndefined();
    const rich = createEconomy({ store: memory(), sources: [derived(20000)], game: noGame, now: () => NOW });
    await rich.refresh();
    expect(rich.itemState!(CUSTOM_PLATE_ID)).toMatchObject({ status: 'buyable' });
    expect((await rich.purchase(CUSTOM_PLATE_ID)).ok).toBe(true);
    expect(rich.view().balance).toBe(20000 - 9990);
    expect(await rich.setPlateText!('dock 07')).toEqual({ ok: true, text: 'DOCK 07' });
    expect(rich.view().equipped).toEqual({ plate: CUSTOM_PLATE_ID, plateText: 'DOCK 07' });
    expect(await rich.setPlateText!('FUCK')).toMatchObject({ ok: false, reason: 'blocked' });
    expect(rich.view().equipped.plateText).toBe('DOCK 07');
    expect(await rich.setPlateText!('')).toEqual({ ok: true, text: '' });
    expect(rich.view().equipped.plateText).toBeUndefined();
  });
  it('a tampered record that stores the plate and text without paying shows neither', async () => {
    const record: WalletRecord = { ...emptyWallet(NOW), owned: [CUSTOM_PLATE_ID], equipped: { plate: CUSTOM_PLATE_ID, plateText: 'FREE 1' } };
    const economy = createEconomy({ store: memory(record), sources: [derived(100)], game: noGame, now: () => NOW });
    await economy.refresh();
    expect(economy.view().locked!.has(CUSTOM_PLATE_ID)).toBe(true);
    expect(economy.view().equipped).toEqual({});
    expect(await economy.setPlateText!('ABC')).toMatchObject({ ok: false, reason: 'locked' });
  });
  it('the text only shows while the custom plate is the fitted one, and survives a reload', async () => {
    const store = memory();
    const economy = createEconomy({ store, sources: [derived(20000)], game: noGame, now: () => NOW });
    await economy.refresh();
    await economy.purchase(CUSTOM_PLATE_ID);
    await economy.purchase('plate-dock7');
    await economy.setPlateText!('MINE 1');
    await economy.equip('plate', 'plate-dock7');
    expect(economy.view().equipped).toEqual({ plate: 'plate-dock7' });
    await economy.equip('plate', CUSTOM_PLATE_ID);
    expect(economy.view().equipped).toEqual({ plate: CUSTOM_PLATE_ID, plateText: 'MINE 1' });
    const again = createEconomy({ store: memory(store.current), sources: [derived(20000)], game: noGame, now: () => NOW });
    await again.refresh();
    expect(again.view().equipped).toEqual({ plate: CUSTOM_PLATE_ID, plateText: 'MINE 1' });
  });
});

/* ------------------------------------------------------------------ other players */

const tip = (id: string, author: string, credits: number) => ({ comment: { id, author: { id: `id-${author}`, username: author }, card_data: { type: 'tip_comment', credits_spent: credits } } });
const page = (rows: unknown[]) => ({ comments: { data: rows, meta: { has_next_page: false, end_cursor: null } } });
const row = (username: string, owned: string[], ageDays = 0): RemoteWalletRow => ({ username, w: JSON.stringify({ version: 1, owned }), created_at: new Date(NOW - ageDays * DAY).toISOString() });

function remote(tips: unknown[], rows: RemoteWalletRow[], missionAllowance?: (c: number | null, n: number) => number) {
  const verifier = createRemoteVerifier({ fetchJson: vi.fn(async () => page(tips)), projectId: () => 'p', now: () => NOW, wallets: () => rows, ...(missionAllowance ? { missionAllowance } : {}) });
  return verifier;
}
const wire = (over: Record<string, string> = {}): string => encodeLoadout({ paint: 'harbor-slate', wheelStyle: 'forged', plate: CUSTOM_PLATE_ID, plateText: 'DOCK 07', ...over });

describe('remote players see custom text only when they could afford the plate', () => {
  it('shows the text when the verified budget covers plate-custom', async () => {
    const tips = [tip('a', 'bob', 2500), tip('b', 'bob', 2500), tip('c', 'bob', 2500), tip('d', 'bob', 2500)];
    const verifier = remote(tips, [row('bob', [CUSTOM_PLATE_ID])], () => 0);
    await verifier.refresh();
    const look = verifier.look('bob', 'CAR-01', wire());
    expect(decodeLoadout(look.paint)).toMatchObject({ plate: CUSTOM_PLATE_ID, plateText: 'DOCK 07' });
  });
  it('shows the default plate (no custom plate, no text) when the wallet could not afford it', async () => {
    const verifier = remote([tip('a', 'bob', 2500)], [row('bob', [CUSTOM_PLATE_ID])], () => 0);
    await verifier.refresh();
    const look = decodeLoadout(verifier.look('bob', 'CAR-01', wire()).paint)!;
    expect(look.plate).toBeUndefined();
    expect(look.plateText).toBeUndefined();
    expect(verifier.look('bob', 'CAR-01', wire()).paint).not.toContain('.x');
  });
  it('shows no text before the tip index has loaded, for strangers and for a forged plate-only claim', async () => {
    const verifier = remote([], [row('bob', [CUSTOM_PLATE_ID])], () => 0);
    expect(decodeLoadout(verifier.look('bob', 'CAR-01', wire()).paint)?.plateText).toBeUndefined();
    await verifier.refresh();
    for (const name of ['bob', 'stranger', 'mallory']) {
      const look = decodeLoadout(verifier.look(name, 'CAR-01', wire()).paint)!;
      expect(look.plateText, name).toBeUndefined();
      expect(look.plate, name).toBeUndefined();
    }
  });
  it('a brand new wallet can not reach 9990 on the daily and mission allowance alone', async () => {
    const verifier = remote([], [row('bob', [CUSTOM_PLATE_ID], 0)]);
    await verifier.refresh();
    expect(decodeLoadout(verifier.look('bob', 'CAR-01', wire()).paint)?.plateText).toBeUndefined();
  });
  it('the creator (server-set username Louis) is covered by the creator grant', async () => {
    const verifier = remote([], [row('Louis', [CUSTOM_PLATE_ID])], () => 0);
    await verifier.refresh();
    expect(decodeLoadout(verifier.look('Louis', 'CAR-01', wire()).paint)).toMatchObject({ plate: CUSTOM_PLATE_ID, plateText: 'DOCK 07' });
  });
  it('re-validates text that arrives over presence, whatever the sender claims', async () => {
    const tips = [tip('a', 'bob', 2500), tip('b', 'bob', 2500), tip('c', 'bob', 2500), tip('d', 'bob', 2500)];
    const verifier = remote(tips, [row('bob', [CUSTOM_PLATE_ID])], () => 0);
    await verifier.refresh();
    const forged = `${encodeLoadout({ plate: CUSTOM_PLATE_ID })}.x4655434B`;
    expect(decodeLoadout(verifier.look('bob', 'CAR-01', forged).paint)).toMatchObject({ plate: CUSTOM_PLATE_ID });
    expect(decodeLoadout(verifier.look('bob', 'CAR-01', forged).paint)?.plateText).toBeUndefined();
    expect(parsePresencePaint(`${encodeLoadout({ plate: CUSTOM_PLATE_ID })}.x${'41'.repeat(40)}`).plateText).toBeUndefined();
    expect(parsePresencePaint(`${'~'.repeat(300)}`)).toEqual({});
  });
  it('without the custom plate, text on the wire is ignored even for a rich player', async () => {
    const tips = [tip('a', 'bob', 2500), tip('b', 'bob', 2500), tip('c', 'bob', 2500), tip('d', 'bob', 2500)];
    const verifier = remote(tips, [row('bob', [CUSTOM_PLATE_ID])], () => 0);
    await verifier.refresh();
    const sneaky = `${encodeLoadout({ plate: 'plate-dock7' })}.${encodePlateText('DOCK 07')}`;
    expect(decodeLoadout(verifier.look('bob', 'CAR-01', sneaky).paint)?.plateText).toBeUndefined();
  });
});

/* ------------------------------------------------------------------ drawing */

describe('plate drawing', () => {
  const fake = (widthPerChar: number) => {
    const calls: { fill: string[]; fonts: string[] } = { fill: [], fonts: [] };
    const context = {
      clearRect() {}, fillRect() {}, strokeRect() {}, fillText: (text: string) => { calls.fill.push(text); },
      measureText: (text: string) => ({ width: text.length * widthPerChar }),
      set font(value: string) { calls.fonts.push(value); },
    } as unknown as CanvasRenderingContext2D;
    return { context, calls };
  };
  it('draws the text with fillText only, twice (neon and highlight), at full size when it fits', () => {
    const { context, calls } = fake(40);
    drawPlateFace(context, 'DOCK 07', '#bff0ff');
    expect(calls.fill).toEqual(['DOCK 07', 'DOCK 07']);
    expect(calls.fonts).toHaveLength(1);
    expect(calls.fonts[0]).toContain('70px');
  });
  it('shrinks the font so the longest text still fits inside the frame', () => {
    const { context, calls } = fake(80);
    drawPlateFace(context, 'WWWWWWWW', '#bff0ff');
    const size = Number(/(\d+)px/.exec(calls.fonts[calls.fonts.length - 1]!)![1]);
    expect(size).toBeLessThan(70);
    expect(size).toBeGreaterThanOrEqual(36);
  });
  it('has a default text for a custom plate with none yet', () => {
    expect(DEFAULT_PLATE_TEXT).toBe('LATERAL');
  });
});
