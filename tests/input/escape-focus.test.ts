import { describe, expect, it } from 'vitest';
import { escapeReachesMenus } from '../../src/input/player-input';

const body = { tagName: 'BODY' }, html = { tagName: 'HTML' };
const page = { body, documentElement: html };
const inside = new Set<object>();
const root = { contains: (node: never) => inside.has(node as object) };
const el = (tagName: string, extra: { type?: string; isContentEditable?: boolean } = {}, inGame = true) => {
  const node = { tagName, ...extra };
  if (inGame) inside.add(node);
  return node;
};

describe('Esc reaches the menus wherever focus sits in a panel', () => {
  it('works with nothing focused (the focused button was re-rendered away)', () => {
    expect(escapeReachesMenus(null, page, root)).toBe(true);
    expect(escapeReachesMenus(body, page, root)).toBe(true);
    expect(escapeReachesMenus(html, page, root)).toBe(true);
  });

  it('works from Settings sliders, checkboxes, selects and buttons', () => {
    expect(escapeReachesMenus(el('input', { type: 'range' }), page, root)).toBe(true);
    expect(escapeReachesMenus(el('input', { type: 'checkbox' }), page, root)).toBe(true);
    expect(escapeReachesMenus(el('select'), page, root)).toBe(true);
    expect(escapeReachesMenus(el('button'), page, root)).toBe(true);
  });

  it('leaves Esc to text fields and to anything outside the game', () => {
    expect(escapeReachesMenus(el('input', { type: 'text' }), page, root)).toBe(false);
    expect(escapeReachesMenus(el('input'), page, root)).toBe(false);
    expect(escapeReachesMenus(el('textarea'), page, root)).toBe(false);
    expect(escapeReachesMenus(el('div', { isContentEditable: true }), page, root)).toBe(false);
    expect(escapeReachesMenus(el('button', {}, false), page, root)).toBe(false);
    expect(escapeReachesMenus(el('input', { type: 'range' }), page, null)).toBe(false);
  });
});
