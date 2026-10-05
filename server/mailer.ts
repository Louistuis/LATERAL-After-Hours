/**
 * Gift emails. A pluggable transport (interface, a fake for tests, and the real adapter chosen at boot) plus the
 * message builder. Addresses are never logged and never stored in the clear: callers keep only a hash and the masked form.
 */
import { cleanText } from './util';

export interface MailMessage {
  readonly from: string;
  readonly to: string;
  readonly subject: string;
  readonly text: string;
  readonly html: string;
}
export type MailResult = { readonly ok: true; readonly id?: string } | { readonly ok: false; readonly error: string };
export interface MailTransport {
  readonly name: string;
  send(message: MailMessage): Promise<MailResult>;
}

/** Collects messages in memory. Used by the tests and by dev.mjs; it never touches the network. */
export class FakeTransport implements MailTransport {
  readonly name = 'fake';
  readonly sent: MailMessage[] = [];
  failWith: string | null = null;
  async send(message: MailMessage): Promise<MailResult> {
    if (this.failWith) return { ok: false, error: this.failWith };
    this.sent.push(message);
    return { ok: true, id: `fake-${this.sent.length}` };
  }
}

/** Simple, strict address check (no display names, no comments, no quoted locals). */
export function validEmail(raw: unknown): raw is string {
  return typeof raw === 'string' && raw.length >= 5 && raw.length <= 254
    && /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]{1,64}@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/.test(raw);
}
export const normalizeEmail = (email: string): string => email.trim().toLowerCase();
/** `j***@gmail.com`: first letter and the domain only. */
export function maskEmail(email: string): string {
  const at = email.lastIndexOf('@');
  return `${email.slice(0, 1).toLowerCase()}***@${email.slice(at + 1).toLowerCase()}`;
}

const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export interface GiftMailInput {
  readonly link: string;
  readonly marks: number;
  readonly itemCount: number;
  readonly message: string;
  readonly fromName?: string;
}
/** The email: plain text first, a minimal HTML part second. The gift link is the only link. No em dashes, no tracking. */
export function buildGiftMessage(input: GiftMailInput): { subject: string; text: string; html: string } {
  const from = cleanText(input.fromName ?? 'Louis', 24) || 'Louis';
  const subject = `${from} sent you a gift in LATERAL`;
  const bits: string[] = [];
  if (input.marks > 0) bits.push(`${input.marks.toLocaleString('en-US')} Marks`);
  if (input.itemCount > 0) bits.push(input.itemCount === 1 ? 'a new item for your garage' : `${input.itemCount} new items for your garage`);
  const what = bits.length ? `Inside: ${bits.join(' and ')}.` : '';
  const note = cleanText(input.message, 140);
  const lines = [
    'Hi,',
    '',
    `${from} sent you a gift in LATERAL: After Hours, a free browser drift game.`,
    ...(note ? ['', `"${note}"`] : []),
    ...(what ? ['', what] : []),
    '',
    'Open it here. Pick a driver name and the gift opens right away:',
    input.link,
    '',
    'The link works once, for one player.',
    '',
    '--',
    `You are getting this one message because ${from} (Louis Nordb\u00f8, the maker of LATERAL) chose to send you a gift. Your address was used only to send it and is not stored.`,
  ];
  const text = lines.join('\n');
  const html = [
    '<!doctype html><html><body style="font-family:-apple-system,BlinkMacSystemFont,\'Segoe UI\',sans-serif;line-height:1.5;color:#111;max-width:34em">',
    '<p>Hi,</p>',
    `<p>${esc(from)} sent you a gift in <strong>LATERAL: After Hours</strong>, a free browser drift game.</p>`,
    note ? `<p><em>&ldquo;${esc(note)}&rdquo;</em></p>` : '',
    what ? `<p>${esc(what)}</p>` : '',
    `<p>Open it here. Pick a driver name and the gift opens right away:<br><a href="${esc(input.link)}">${esc(input.link)}</a></p>`,
    '<p>The link works once, for one player.</p>',
    `<p style="color:#666;font-size:12px">You are getting this one message because ${esc(from)} (Louis Nordb&oslash;, the maker of LATERAL) chose to send you a gift. Your address was used only to send it and is not stored.</p>`,
    '</body></html>',
  ].join('');
  return { subject, text, html };
}
