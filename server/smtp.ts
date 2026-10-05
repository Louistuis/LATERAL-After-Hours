/**
 * A minimal SMTP client for the gift email: implicit TLS (465) or STARTTLS (587), AUTH PLAIN, one message per connection.
 * Configured only through SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_SECURE and MAIL_FROM. Credentials never reach logs.
 */
import { connect as netConnect, type Socket } from 'node:net';
import { connect as tlsConnect, type TLSSocket } from 'node:tls';
import { randomBytes } from 'node:crypto';
import type { MailMessage, MailResult, MailTransport } from './mailer';

export interface SmtpConfig { readonly host: string; readonly port: number; readonly user: string; readonly pass: string; readonly secure: boolean; readonly rejectUnauthorized?: boolean; readonly timeoutMs?: number }

const addrOnly = (s: string): string => { const m = /<([^>]+)>/.exec(s); return (m ? m[1]! : s).trim(); };
const clean = (s: string): string => s.replace(/[\r\n]+/g, ' ');
/** RFC 2047 for non-ASCII subjects. */
const encodeHeader = (s: string): string => (/^[\x20-\x7e]*$/.test(s) ? clean(s) : `=?UTF-8?B?${Buffer.from(clean(s), 'utf8').toString('base64')}?=`);
const qp = (s: string): string => s.replace(/\r?\n/g, '\r\n').split('\r\n').map(line => {
  let out = '';
  for (const byte of Buffer.from(line, 'utf8')) out += (byte >= 33 && byte <= 126 && byte !== 61) || byte === 32 ? String.fromCharCode(byte) : `=${byte.toString(16).toUpperCase().padStart(2, '0')}`;
  return out.replace(/ $/, '=20').replace(/(.{70}[^=]{0,2})(?=.)/g, '$1=\r\n');
}).join('\r\n');

export function buildMime(m: MailMessage, now = new Date()): string {
  const boundary = `lat-${randomBytes(12).toString('hex')}`;
  const domain = (addrOnly(m.from).split('@')[1] ?? 'localhost').replace(/[^A-Za-z0-9.-]/g, '');
  const head = [
    `From: ${clean(m.from)}`, `To: ${clean(m.to)}`, `Subject: ${encodeHeader(m.subject)}`, `Date: ${now.toUTCString()}`,
    `Message-ID: <${randomBytes(12).toString('hex')}@${domain}>`, 'MIME-Version: 1.0', `Content-Type: multipart/alternative; boundary="${boundary}"`,
  ].join('\r\n');
  const part = (type: string, body: string): string => `--${boundary}\r\nContent-Type: ${type}; charset=UTF-8\r\nContent-Transfer-Encoding: quoted-printable\r\n\r\n${qp(body)}\r\n`;
  return `${head}\r\n\r\n${part('text/plain', m.text)}${part('text/html', m.html)}--${boundary}--\r\n`;
}

class Session {
  private buf = '';
  private waiters: Array<(line: { code: number; lines: string[] }) => void> = [];
  private failed: Error | null = null;
  private pending: string[] = [];
  constructor(public sock: Socket | TLSSocket, private readonly timeoutMs: number) { this.hook(sock); }
  private hook(sock: Socket): void {
    sock.setEncoding('utf8');
    sock.on('data', (d: string) => { this.buf += d; this.pump(); });
    sock.on('error', e => this.fail(e));
    sock.on('close', () => this.fail(new Error('connection closed')));
    sock.setTimeout(this.timeoutMs, () => this.fail(new Error('timeout')));
  }
  rehook(sock: TLSSocket): void { this.sock = sock; this.buf = ''; this.hook(sock); }
  private fail(e: Error): void { this.failed ??= e; for (const w of this.waiters.splice(0)) w({ code: 0, lines: [e.message] }); }
  private pump(): void {
    for (;;) {
      const lines = this.buf.split('\r\n');
      if (lines.length < 2) return;
      let end = -1;
      for (let i = 0; i < lines.length - 1; i++) if (/^\d{3} /.test(lines[i]!) || /^\d{3}$/.test(lines[i]!)) { end = i; break; }
      if (end < 0) return;
      const group = lines.slice(0, end + 1);
      this.buf = lines.slice(end + 1).join('\r\n');
      const w = this.waiters.shift();
      if (w) w({ code: Number(group[end]!.slice(0, 3)), lines: group }); else this.pending.push(group.join('\n'));
    }
  }
  read(): Promise<{ code: number; lines: string[] }> {
    if (this.failed) return Promise.resolve({ code: 0, lines: [this.failed.message] });
    return new Promise(resolve => { this.waiters.push(resolve); this.pump(); });
  }
  async cmd(line: string, expect: number[]): Promise<{ code: number; lines: string[] }> {
    this.sock.write(`${line}\r\n`);
    const r = await this.read();
    if (!expect.includes(r.code)) throw new Error(`smtp ${r.code || 'error'} after ${line.split(' ')[0]}`);
    return r;
  }
}

export function createSmtpTransport(cfg: SmtpConfig): MailTransport {
  return {
    name: 'smtp',
    async send(message: MailMessage): Promise<MailResult> {
      const timeoutMs = cfg.timeoutMs ?? 15_000;
      let session: Session | null = null;
      try {
        const sock: Socket | TLSSocket = cfg.secure
          ? tlsConnect({ host: cfg.host, port: cfg.port, servername: cfg.host, rejectUnauthorized: cfg.rejectUnauthorized !== false })
          : netConnect({ host: cfg.host, port: cfg.port });
        session = new Session(sock, timeoutMs);
        const hello = await session.read();
        if (hello.code !== 220) throw new Error(`smtp greeting ${hello.code}`);
        const ehlo = 'EHLO lateral.local';
        let caps = await session.cmd(ehlo, [250]);
        if (!cfg.secure) {
          if (!caps.lines.some(l => /STARTTLS/i.test(l))) throw new Error('server does not offer STARTTLS');
          await session.cmd('STARTTLS', [220]);
          const tls = tlsConnect({ socket: session.sock as Socket, servername: cfg.host, rejectUnauthorized: cfg.rejectUnauthorized !== false });
          await new Promise<void>((resolve, reject) => { tls.once('secureConnect', () => resolve()); tls.once('error', reject); });
          session.rehook(tls);
          caps = await session.cmd(ehlo, [250]);
        }
        if (cfg.user) {
          const plain = Buffer.from(`\u0000${cfg.user}\u0000${cfg.pass}`, 'utf8').toString('base64');
          await session.cmd(`AUTH PLAIN ${plain}`, [235]);
        }
        await session.cmd(`MAIL FROM:<${addrOnly(message.from)}>`, [250]);
        await session.cmd(`RCPT TO:<${addrOnly(message.to)}>`, [250, 251]);
        await session.cmd('DATA', [354]);
        const body = buildMime(message).replace(/^\./gm, '..');
        session.sock.write(`${body}\r\n.\r\n`);
        const done = await session.read();
        if (done.code !== 250) throw new Error(`smtp ${done.code || 'error'} after DATA`);
        try { session.sock.write('QUIT\r\n'); } catch { /* ignore */ }
        return { ok: true, id: done.lines[done.lines.length - 1]?.slice(4, 60) };
      } catch (error) {
        return { ok: false, error: String((error as Error)?.message ?? error).slice(0, 120) };
      } finally {
        try { session?.sock.destroy(); } catch { /* ignore */ }
      }
    },
  };
}
