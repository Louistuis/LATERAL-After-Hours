import { describe, expect, it } from 'vitest';
import { giftPresence } from '../../src/showroom/ui';
import { renderTitle, type MenuContext } from '../../src/ui/main-menu';
import { starterGiftItems } from '../../src/economy/welcome';
import type { GiftView } from '../../src/economy/types';

const unopened: GiftView = { state: 'unopened', marks: 1500, items: starterGiftItems(), pending: false };
const opened: GiftView = { ...unopened, state: 'opened' };

describe('starter gift badges in the shop and garage', () => {
  it('marks every starter item as in the gift while it is unopened, and as from it afterwards', () => {
    for (const id of starterGiftItems()) {
      expect(giftPresence(unopened, id)).toBe('in-gift');
      expect(giftPresence(opened, id)).toBe('from-gift');
    }
  });
  it('leaves everything else alone: bought items, garage settings, no gift, an unknown id', () => {
    expect(giftPresence(unopened, 'gold-chrome')).toBeNull();
    expect(giftPresence(unopened, 'livery:stock')).toBeNull();
    expect(giftPresence(null, 'harbor-slate')).toBeNull();
    expect(giftPresence(undefined, 'harbor-slate')).toBeNull();
    expect(giftPresence(opened, 'plate-berth')).toBeNull();
  });
});

const ctx = (extra: Partial<MenuContext> = {}): MenuContext => ({
  paused: false, view: 'home', soloMode: 'drift-attack', device: 'keyboard', route: 'HW-01', routes: [], lighting: 'golden-hour', carName: 'Challenger', runMode: 'free-drive',
  rivalAvailable: false, profile: null, balance: '0', shop: true, online: 'off', onlineCount: 0, busy: false, lessonReplay: false, logo: '', ...extra,
});

describe('starter gift in the main menu', () => {
  it('shows a glowing "Open your gift" button with a badge and a "+1,500 in gift" hint on the Marks chip while it is unopened', () => {
    const html = renderTitle(ctx({ gift: 1500 }));
    expect(html).toContain('data-action="gift"');
    expect(html).toContain('Open your gift');
    expect(html).toContain('lt-gift');
    expect(html).toContain('+1,500 in gift');
    expect(html).toContain('1,500 more Marks in your starter gift');
  });
  it('shows nothing once the gift is opened, in a build without one, or without a shop', () => {
    for (const extra of [{ gift: null }, { gift: 0 }, {}]) {
      const html = renderTitle(ctx(extra));
      expect(html).not.toContain('data-action="gift"');
      expect(html).not.toContain('in gift');
    }
    expect(renderTitle(ctx({ gift: 1500, shop: false }))).toContain('data-action="gift"');
  });
});
