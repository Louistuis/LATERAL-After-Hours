import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer as netServer, type AddressInfo, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TLSSocket, createServer as tlsServer } from 'node:tls';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildGiftMessage } from '../../server/mailer';
import { buildMime, createSmtpTransport } from '../../server/smtp';

let key = '', cert = '', dir = '';
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'lat-smtp-'));
  const r = spawnSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(dir, 'k.pem'), '-out', join(dir, 'c.pem'), '-subj', '/CN=127.0.0.1', '-days', '1'], { stdio: 'ignore' });
  if (r.status === 0) { key = readFileSync(join(dir, 'k.pem'), 'utf8'); cert = readFileSync(join(dir, 'c.pem'), 'utf8'); }
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** A tiny scripted SMTP server. Records what it was sent. */
function handle(socket: Socket | TLSSocket, log: string[], opts: { starttls?: boolean; failRcpt?: boolean }): void {
  socket.setEncoding('utf8');
  let data = false, buf = '';
  const onData = (chunk: string): void => {
    buf += chunk;
    if (data) { const end = buf.indexOf('\r\n.\r\n'); if (end >= 0) { log.push(`DATA:${buf.slice(0, end)}`); buf = ''; data = false; socket.write('250 queued as 42\r\n'); } return; }
    while (buf.includes('\r\n')) {
      const line = buf.slice(0, buf.indexOf('\r\n')); buf = buf.slice(buf.indexOf('\r\n') + 2);
      log.push(line);
      if (line.startsWith('EHLO')) socket.write(opts.starttls && !(socket instanceof TLSSocket) ? '250-test\r\n250 STARTTLS\r\n' : '250-test\r\n250 AUTH PLAIN\r\n');
      else if (line === 'STARTTLS') {
        socket.write('220 go\r\n');
        socket.removeListener('data', onData);
        const secure = new TLSSocket(socket as Socket, { isServer: true, key, cert });
        handle(secure, log, { ...opts, starttls: false });
        return;
      } else if (line.startsWith('AUTH PLAIN')) socket.write('235 ok\r\n');
      else if (line.startsWith('MAIL FROM')) socket.write('250 ok\r\n');
      else if (line.startsWith('RCPT TO')) socket.write(opts.failRcpt ? '550 no such user\r\n' : '250 ok\r\n');
      else if (line === 'DATA') { socket.write('354 go\r\n'); data = true; if (buf) onData(''); }
      else if (line === 'QUIT') socket.end('221 bye\r\n');
    }
  };
  socket.on('data', onData);
  socket.on('error', () => {});
}
const msg = { from: 'LATERAL <gifts@example.test>', to: 'friend@example.com', subject: 'Louis sent you a gift in LATERAL', text: 'Hello\n.dot line\nline', html: '<p>Hello</p>' };

describe('smtp transport', () => {
  it('refuses to send credentials without TLS', async () => {
    const log: string[] = [];
    const srv = netServer(s => { s.write('220 test\r\n'); handle(s, log, {}); });
    await new Promise<void>(r => srv.listen(0, '127.0.0.1', () => r()));
    const t = createSmtpTransport({ host: '127.0.0.1', port: (srv.address() as AddressInfo).port, user: 'u', pass: 'p', secure: false });
    expect(await t.send(msg)).toEqual({ ok: false, error: 'server does not offer STARTTLS' });
    expect(log.some(l => l.startsWith('AUTH'))).toBe(false);
    srv.close();
  });
  it('delivers over STARTTLS with AUTH PLAIN, dot stuffing and a multipart body', async ctx => {
    if (!key) return ctx.skip();
    const log: string[] = [];
    const srv = netServer(s => { s.write('220 test\r\n'); handle(s, log, { starttls: true }); });
    await new Promise<void>(r => srv.listen(0, '127.0.0.1', () => r()));
    const t = createSmtpTransport({ host: '127.0.0.1', port: (srv.address() as AddressInfo).port, user: 'u', pass: 'p', secure: false, rejectUnauthorized: false });
    const out = await t.send(msg);
    expect(out.ok).toBe(true);
    expect(log).toContain('MAIL FROM:<gifts@example.test>');
    expect(log).toContain('RCPT TO:<friend@example.com>');
    expect(log.filter(l => l.startsWith('AUTH PLAIN'))).toHaveLength(1);
    const body = log.find(l => l.startsWith('DATA:'))!;
    expect(body).toContain('Subject: Louis sent you a gift in LATERAL');
    expect(body).toContain('multipart/alternative');
    expect(body).toContain('..dot line');
    srv.close();
  });
  it('delivers over implicit TLS and reports a rejected recipient', async ctx => {
    if (!key) return ctx.skip();
    const log: string[] = [];
    let fail = false;
    const srv = tlsServer({ key, cert }, s => { s.write('220 test\r\n'); handle(s, log, { failRcpt: fail }); });
    await new Promise<void>(r => srv.listen(0, '127.0.0.1', () => r()));
    const t = createSmtpTransport({ host: '127.0.0.1', port: (srv.address() as AddressInfo).port, user: '', pass: '', secure: true, rejectUnauthorized: false });
    expect((await t.send(msg)).ok).toBe(true);
    expect(log.some(l => l.startsWith('AUTH'))).toBe(false); // no credentials configured, none sent
    fail = true;
    expect(await t.send(msg)).toEqual({ ok: false, error: 'smtp 550 after RCPT' });
    srv.close();
  });
  it('rejects an untrusted certificate unless told otherwise, and reports connection errors', async ctx => {
    if (!key) return ctx.skip();
    const srv = tlsServer({ key, cert }, s => { s.write('220 test\r\n'); s.on('error', () => {}); });
    await new Promise<void>(r => srv.listen(0, '127.0.0.1', () => r()));
    const t = createSmtpTransport({ host: '127.0.0.1', port: (srv.address() as AddressInfo).port, user: '', pass: '', secure: true });
    expect((await t.send(msg)).ok).toBe(false);
    srv.close();
    const dead = createSmtpTransport({ host: '127.0.0.1', port: 1, user: '', pass: '', secure: false, timeoutMs: 500 });
    expect((await dead.send(msg)).ok).toBe(false);
  });
});

describe('mime builder', () => {
  it('builds a quoted-printable multipart message with encoded non-ASCII and no header injection', () => {
    const mime = buildMime({ ...msg, subject: 'Gift ø\r\nBcc: evil@example.com', to: 'a@example.com\r\nBcc: evil@example.com', text: 'Nordbø sent it', html: '<p>=ok</p>' }, new Date(Date.UTC(2026, 9, 5)));
    expect(mime).toContain('Subject: =?UTF-8?B?');
    expect(mime.split('\r\n').some(l => l.startsWith('Bcc:'))).toBe(false);
    expect(mime).toContain('Nordb=C3=B8 sent it');
    expect(mime).toContain('<p>=3Dok</p>');
    expect(mime).toContain('Content-Transfer-Encoding: quoted-printable');
    expect(mime).toContain('Date: Mon, 05 Oct 2026');
  });
  it('the gift email has no em dash, one link, the sender line, and names the maker properly', () => {
    const m = buildGiftMessage({ link: 'https://lateral.lou15.com/?gift=LATERAL-ABCD-EFGH', marks: 1500, itemCount: 2, message: 'Enjoy <b>this</b>', fromName: 'Louis' });
    for (const part of [m.subject, m.text, m.html]) expect(part).not.toContain('—');
    expect(m.text).toContain('Nordbø');
    expect(m.html).toContain('Nordb&oslash;');
    expect(m.html).toContain('Enjoy &lt;b&gt;this&lt;/b&gt;');
    expect((m.html.match(/href=/g) ?? []).length).toBe(1);
    expect(m.text).toContain('1,500 Marks and 2 new items');
  });
});
