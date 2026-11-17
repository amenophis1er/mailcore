// The IMAP backend's moves and its push stream's auth gate, against a stand-in
// for imapflow's connection (no network).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { Readable } from 'node:stream';
import { ImapClient, withMessageId, newMessageId } from '../src/imap.js';
import { simpleParser } from 'mailparser';
import { ImapStream } from '../src/imap-stream.js';

const ACCT = { name: 'home', provider: 'imap', email: 'me@home.invalid', imap: { host: '127.0.0.1' } };

/** An ImapClient whose connection is a fake: folders and their UIDVALIDITY, and what MOVE does. */
function fakeClient({ validity = { INBOX: '999', Spam: '5' }, move }) {
  const c = new ImapClient(ACCT, { username: 'me', password: 'x' });
  const moves = [];
  const conn = {
    usable: true,
    mailbox: null,
    async getMailboxLock(path) { conn.mailbox = { path, uidValidity: BigInt(validity[path]) }; return { release() { conn.mailbox = null; } }; },
    async messageMove(range, dest) { moves.push([conn.mailbox.path, range, dest]); return move(conn.mailbox.path, range); }
  };
  c.client = conn;
  c.folderMap = { inbox: 'INBOX', archive: 'Archive', junk: 'Spam', sent: 'Sent', drafts: 'Drafts', trash: 'Trash' };
  return { c, moves };
}

test('moveItems: an id of an earlier generation of the mailbox is gone, and its number is not moved', async () => {
  const { c, moves } = fakeClient({ move: (path, range) => ({ uidValidity: 77n, uidMap: new Map(range.split(',').map((u) => [Number(u), Number(u) + 100])) }) });
  const out = await c.moveItems(['INBOX/111/7', 'INBOX/999/8'], 'archive');
  assert.deepEqual(moves, [['INBOX', '8', 'Archive']]); // never UID 7 of generation 999
  assert.deepEqual([...out], [['INBOX/111/7', null], ['INBOX/999/8', 'Archive/77/108']]);
});

test('moveItems: a folder whose move fails does not lose what another folder moved', async () => {
  const fail = new Error('NO [CANNOT] move refused');
  const { c } = fakeClient({ move: (path) => { if (path === 'Spam') throw fail; return { uidValidity: 77n, uidMap: new Map([[8, 108]]) }; } });
  const out = await c.moveItems(['INBOX/999/8', 'Spam/5/3'], 'archive');
  assert.deepEqual([...out], [['INBOX/999/8', 'Archive/77/108']]); // Spam/5/3 left out: not moved
  await assert.rejects(c.moveItems(['Spam/5/3'], 'archive'), (e) => e === fail); // nothing moved: the error is the answer
});

test('close: a server that never answers LOGOUT is hung up on, not waited for', async () => {
  const c = new ImapClient(ACCT, { username: 'me', password: 'x' });
  c.logoutMs = 20;
  let hungUp = false;
  c.client = { logout: () => new Promise(() => {}), close() { hungUp = true; } };
  const started = Date.now();
  await c.close();
  assert.ok(Date.now() - started < 1000, 'close() came back');
  assert.ok(hungUp, 'the connection was closed');
  assert.equal(c.client, null);
  // one that answers is signed out properly, and not closed under it
  let closed = false;
  c.client = { logout: async () => {}, close() { closed = true; } };
  await c.close();
  assert.equal(closed, false);
});

test('the IDLE loop waits while the auth gate is blocked, then signs in with fresh credentials and says how it went', async () => {
  let blocked = true;
  const heard = [];
  const gate = { blocked: () => blocked, ok: () => heard.push('ok'), failed: (e) => heard.push('failed:' + e.code) };
  let refreshed = 0;
  const s = new ImapStream({ account: { ...ACCT, imap: { ...ACCT.imap, askSeconds: 0 } }, creds: {}, onNewMail() {}, refreshCreds: async () => { refreshed++; return { password: 'new' }; }, authGate: gate });
  s.pauseMs = 5;
  let holds = 0;
  s.holdOnce = async (onConnected) => {
    holds++;
    if (holds === 1) { onConnected(); s.stopped = true; return; } // connected once, then stopped
  };
  s.start();
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(holds, 0, 'nothing signs in while blocked');
  blocked = false;
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(holds, 1);
  assert.equal(refreshed, 1, 'the pause ended: the stored credentials are read again');
  assert.deepEqual(heard, ['ok']);
  s.stop();

  // rejected, refreshed, rejected again: the gate hears of it
  const s2 = new ImapStream({ account: { ...ACCT, imap: { ...ACCT.imap, askSeconds: 0 } }, creds: {}, onNewMail() {}, refreshCreds: async () => ({ password: 'x' }), authGate: { blocked: () => false, ok() {}, failed: (e) => { heard.push('failed:' + e.code); s2.stop(); } }, log() {} });
  s2.holdOnce = async () => { throw Object.assign(new Error('AUTHENTICATIONFAILED'), { code: 'MAIL_AUTH' }); };
  const realSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (fn, ms) => realSetTimeout(fn, Math.min(ms, 1)); // the retry delay, made short
  try {
    s2.start();
    await new Promise((r) => realSetTimeout(r, 30));
  } finally { globalThis.setTimeout = realSetTimeout; }
  assert.deepEqual(heard, ['ok', 'failed:MAIL_AUTH']);
});

// --- a draft is sent under a Message-ID of its own -----------------------------------------------------------------

/** A mail server on this machine that takes one mail and keeps what it was given (no network beyond 127.0.0.1). */
function smtpStandIn() {
  const got = { from: '', to: [], data: '', mails: 0 };
  const server = net.createServer((sock) => {
    let inData = false;
    let buf = '';
    sock.write('220 stand-in ESMTP\r\n');
    sock.on('data', (chunk) => {
      buf += chunk.toString('latin1');
      for (;;) {
        if (inData) {
          const end = buf.indexOf('\r\n.\r\n');
          if (end < 0) return;
          got.data = buf.slice(0, end + 2);
          got.mails++;
          buf = buf.slice(end + 5);
          inData = false;
          sock.write('250 kept\r\n');
          continue;
        }
        const nl = buf.indexOf('\r\n');
        if (nl < 0) return;
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 2);
        if (/^EHLO|^HELO/i.test(line)) sock.write('250-stand-in\r\n250 AUTH PLAIN LOGIN\r\n');
        else if (/^AUTH/i.test(line)) sock.write('235 in\r\n');
        else if (/^MAIL FROM:/i.test(line)) { got.from = /<([^>]*)>/.exec(line)?.[1] || ''; sock.write('250 ok\r\n'); }
        else if (/^RCPT TO:/i.test(line)) { got.to.push(/<([^>]*)>/.exec(line)?.[1] || ''); sock.write('250 ok\r\n'); }
        else if (/^DATA/i.test(line)) { inData = true; sock.write('354 go\r\n'); }
        else if (/^QUIT/i.test(line)) { sock.write('221 bye\r\n'); sock.end(); }
        else sock.write('250 ok\r\n');
      }
    });
    sock.on('error', () => {});
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ got, port: server.address().port, close: () => new Promise((r) => server.close(r)) })));
}

const DRAFT = [
  'From: Me <me@home.invalid>', 'To: you@example.invalid', 'Bcc: quiet@example.invalid', 'Subject: Fwd: an order',
  'Message-ID: <the-drafts-own-id-which-is-long-enough-to-be-folded-by-a-composer',
  ' @home.invalid>', 'Date: Mon, 16 Nov 2026 00:13:02 +0000', 'MIME-Version: 1.0', 'Content-Type: text/plain; charset=utf-8', '',
  'Here it is.', 'Message-ID: <not-a-header@home.invalid> stays in the text', ''
].join('\r\n');

test('sendItem: the mail leaves, and is kept in Sent, under a Message-ID of its own; the draft is then removed', async () => {
  const smtp = await smtpStandIn();
  try {
    const c = new ImapClient({ ...ACCT, smtp: { host: '127.0.0.1', port: smtp.port } }, { username: 'me', password: 'x' });
    const done = [];
    c.client = {
      usable: true,
      mailbox: null,
      async getMailboxLock(path) { this.mailbox = { path, uidValidity: 7n }; return { release: () => {} }; },
      async fetchOne(uid, q) { return q?.source ? { uid: 9, source: Buffer.from(DRAFT) } : { uid: 9, flags: new Set(['\\Draft']), internalDate: new Date('2026-11-16T00:13:02Z'), envelope: { subject: 'Fwd: an order', from: [{ name: 'Me', address: 'me@home.invalid' }], to: [{ address: 'you@example.invalid' }] } }; },
      async append(path, raw, flags) { done.push(['append', path, flags, Buffer.from(raw).toString('latin1')]); return { uid: 40, uidValidity: 4n }; },
      async messageDelete(uid) { done.push(['delete', this.mailbox.path, uid]); return true; }
    };
    c.folderMap = { inbox: 'INBOX', archive: 'Archive', junk: 'Spam', sent: 'Sent', drafts: 'Drafts', trash: 'Trash' };
    assert.equal(await c.sendItem('Drafts/7/9'), true);

    const idOf = (raw) => /^Message-ID: (<[^>]+>)\r$/m.exec(raw.slice(0, raw.indexOf('\r\n\r\n') + 2))?.[1];
    const sent = idOf(smtp.got.data);
    assert.match(sent, /^<[0-9a-f-]{36}@home\.invalid>$/); // its own, at the sender's domain
    assert.equal(/the-drafts-own-id/.test(smtp.got.data), false); // the draft's is nowhere in what left
    const headers = smtp.got.data.slice(0, smtp.got.data.indexOf('\r\n\r\n'));
    assert.equal(headers.match(/^message-id/gim).length, 1);
    assert.equal(/^[ \t]/m.test(headers), false); // nor the second line of its folded id, which would have joined the header above
    assert.equal(/^Bcc:/im.test(smtp.got.data), false);
    assert.deepEqual([smtp.got.from, smtp.got.to], ['me@home.invalid', ['you@example.invalid', 'quiet@example.invalid']]);
    assert.match(smtp.got.data, /Here it is\.\r\nMessage-ID: <not-a-header@home\.invalid> stays in the text/); // the text is untouched

    // the copy kept in Sent is the mail as sent (the same id), Bcc remembered
    assert.deepEqual(done.map((d) => d.slice(0, 3)), [['append', 'Sent', ['\\Seen']], ['delete', 'Drafts', 9]]);
    assert.equal(idOf(done[0][3]), sent);
    assert.match(done[0][3], /^Bcc: quiet@example\.invalid\r$/m);
  } finally {
    await smtp.close();
  }
});

test('sendItem: once the mail has left, a mailbox that fails does not make it a send that failed (it would be sent again)', async () => {
  const smtp = await smtpStandIn();
  try {
    const client = (failures) => {
      const c = new ImapClient({ ...ACCT, smtp: { host: '127.0.0.1', port: smtp.port } }, { username: 'me', password: 'x' });
      const done = [];
      let fails = failures;
      c.client = {
        usable: true,
        mailbox: null,
        async getMailboxLock(path) { this.mailbox = { path, uidValidity: 7n }; return { release: () => {} }; },
        async fetchOne(uid, q) { return q?.source ? { uid: 9, source: Buffer.from(DRAFT) } : { uid: 9, flags: new Set(['\\Draft']), internalDate: new Date('2026-11-16T00:13:02Z'), envelope: { subject: 'Fwd: an order', from: [{ address: 'me@home.invalid' }], to: [{ address: 'you@example.invalid' }] } }; },
        async append(path) { if (fails-- > 0) throw Object.assign(new Error('signing in failed'), { code: 'MAIL_AUTH' }); done.push(['append', path]); return {}; }, // (and no number given back)
        async messageDelete(uid) { done.push(['delete', this.mailbox.path, uid]); return true; }
      };
      c.folderMap = { inbox: 'INBOX', archive: 'Archive', junk: 'Spam', sent: 'Sent', drafts: 'Drafts', trash: 'Trash' };
      return { c, done };
    };
    // the copy in Sent fails once: tried again, kept once, the draft removed; one mail left
    const once = client(1);
    assert.equal(await once.c.sendItem('Drafts/7/9'), true);
    assert.deepEqual(once.done, [['append', 'Sent'], ['delete', 'Drafts', 9]]);
    assert.equal(smtp.got.mails, 1);
    // it keeps failing: the mail is sent all the same, and its draft is left where it is (nothing else holds the mail)
    const always = client(9);
    assert.equal(await always.c.sendItem('Drafts/7/9'), true);
    assert.deepEqual(always.done, []);
    assert.equal(smtp.got.mails, 2);
    // an account with no Sent folder sends nothing
    const none = client(0);
    none.c.folderMap = { inbox: 'INBOX', drafts: 'Drafts' };
    none.c.client.list = async () => [{ path: 'INBOX', flags: new Set() }, { path: 'Drafts', specialUse: '\\Drafts', flags: new Set() }];
    await assert.rejects(none.c.sendItem('Drafts/7/9'));
    assert.equal(smtp.got.mails, 2);
  } finally {
    await smtp.close();
  }
});

test('withMessageId: one Message-ID, in the headers only, whatever the line ends; newMessageId is random at the domain', () => {
  const lf = withMessageId('Subject: a\nmessage-id: <old@x>\nMessage-Id: <older@x>\nTo: b@x\n\nbody\nMessage-ID: <text@x>\n', '<new@x>').toString();
  assert.equal(lf, 'Subject: a\nTo: b@x\nMessage-ID: <new@x>\n\nbody\nMessage-ID: <text@x>\n');
  assert.equal(withMessageId('Subject: a\r\n\r\nbody', '<new@x>').toString(), 'Subject: a\r\nMessage-ID: <new@x>\r\n\r\nbody'); // none before: one is added
  assert.equal(withMessageId('no headers end here', '<new@x>').toString(), 'no headers end here');
  assert.equal(withMessageId('Message-ID :\r\n <folded@x>\r\nSubject: a\r\n\r\nbody', '<new@x>').toString(), 'Subject: a\r\nMessage-ID: <new@x>\r\n\r\nbody');
  assert.match(newMessageId('me@münchen.de'), /@xn--mnchen-3ya\.de>$/);
  assert.match(newMessageId('me@[127.0.0.1]'), /@localhost>$/);
  assert.notEqual(newMessageId('me@Home.Invalid'), newMessageId('me@Home.Invalid'));
  assert.match(newMessageId('me@Home.Invalid'), /^<[0-9a-f-]{36}@home\.invalid>$/);
  assert.match(newMessageId(''), /@localhost>$/);
});

// A message written once as a tree: its source, its BODYSTRUCTURE and its parts (BODY[n.MIME], BODY[n]) all come from it.
const leafOf = (headers, body) => ({ headers, body });
const multi = (type, boundary, headers, children) => ({ type, boundary, headers, children });
const MESSAGE = multi('multipart/mixed', 'MIX', 'From: A <a@x.example>\r\nTo: me@home.invalid\r\nSubject: Big one\r\nList-Unsubscribe: <mailto:u@x.example>\r\nMIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary="MIX"', [
  multi('multipart/alternative', 'ALT', 'Content-Type: multipart/alternative; boundary="ALT"', [
    leafOf('Content-Type: text/plain; charset=utf-8', 'Hello there'),
    multi('multipart/related', 'REL', 'Content-Type: multipart/related; boundary="REL"', [
      leafOf('Content-Type: text/html; charset=utf-8', '<p>Hello <img src="cid:logo@x"></p>'),
      leafOf('Content-Type: image/png\r\nContent-Transfer-Encoding: base64\r\nContent-ID: <logo@x>', 'iVBORw0KGgo=')
    ])
  ]),
  leafOf('Content-Type: text/plain; charset=utf-8; name="footer.txt"\r\nContent-Disposition: inline; filename="footer.txt"', 'Footer text'),
  leafOf('Content-Type: application/pdf; name="Big.pdf"\r\nContent-Disposition: attachment; filename="Big.pdf"\r\nContent-Transfer-Encoding: base64', 'JVBERi0xLjcgYmln'),
  multi('multipart/alternative', 'ALT2', 'Content-Type: multipart/alternative; boundary="ALT2"', [
    leafOf('Content-Type: text/plain', 'Second part'),
    leafOf('Content-Type: text/html', '<p>Second part</p>')
  ])
]);
function served(root) {
  const parts = new Map();
  const render = (n) => `${n.headers}\r\n\r\n${n.children ? n.children.map((c) => `--${n.boundary}\r\n${render(c)}\r\n`).join('') + `--${n.boundary}--\r\n` : n.body}`;
  const structure = (n, part) => {
    if (part) { parts.set(`${part}.MIME`, `${n.headers}\r\n\r\n`); parts.set(part, n.children ? '' : n.body); }
    if (!part && !n.children) parts.set('1', n.body); // (a message of one part: BODY[1] is its body)
    const type = /Content-Type: ([^;\r]+)/.exec(n.headers)[1].toLowerCase();
    const enc = /Content-Transfer-Encoding: (\w+)/.exec(n.headers)?.[1];
    const id = /Content-ID: (\S+)/.exec(n.headers)?.[1];
    if (n.children) return { type, ...(part ? { part } : {}), parameters: { boundary: n.boundary }, childNodes: n.children.map((c, i) => structure(c, part ? `${part}.${i + 1}` : String(i + 1))) };
    return { type, part, size: n.body.length, ...(enc ? { encoding: enc } : {}), ...(id ? { id } : {}) };
  };
  return { source: Buffer.from(render(root)), structure: structure(root, ''), parts, headers: Buffer.from(`${root.headers}\r\n\r\n`) };
}
function serving(root, size) {
  const m = served(root);
  const asked = [];
  const c = new ImapClient(ACCT, { username: 'me', password: 'x' });
  const conn = {
    usable: true,
    mailbox: null,
    async getMailboxLock(path) { conn.mailbox = { path, uidValidity: 999n }; return { release() { conn.mailbox = null; } }; },
    async fetchOne(uid, query) {
      if (query.source) { asked.push('whole'); return { uid, source: m.source }; }
      if (query.bodyParts) { asked.push(...query.bodyParts); return { uid, bodyParts: new Map(query.bodyParts.filter((k) => m.parts.has(k)).map((k) => [k, Buffer.from(m.parts.get(k))])) }; }
      return { uid, size, flags: new Set(), envelope: { subject: 'Big one', from: [{ name: 'A', address: 'a@x.example' }] }, internalDate: new Date('2026-11-16T10:00:00Z'), bodyStructure: m.structure, ...(query.headers ? { headers: m.headers } : {}) };
    }
  };
  c.client = conn;
  return { c, asked, source: m.source };
}

test('a large message is read without its attachments\' bytes, as the whole read reads it; one attachment is fetched by itself', async () => {
  const big = serving(MESSAGE, 9_000_000);
  const small = serving(MESSAGE, 2_000);
  const light = await big.c.getMessage('INBOX/999/42', { bodyType: 'HTML' });
  const whole = await small.c.getMessage('INBOX/999/42', { bodyType: 'HTML' });
  assert.ok(!big.asked.includes('whole') && !big.asked.includes('3'), 'never the whole message, never the PDF');
  assert.deepEqual(small.asked, ['whole']);
  // the same texts: the second alternative and the named inline footer are in, as in the whole read
  const plain = async (b) => (await b.c.getMessage('INBOX/999/42')).body;
  assert.equal(await plain(big), await plain(small));
  assert.match(light.body, /Second part/);
  assert.match(light.body, /Footer text/);
  assert.match(light.body, /cid:logo@x/); // its picture fetched when shown
  assert.equal(light.isBulk, true);
  // the same attachments, by the same ids, whichever way read
  assert.deepEqual(light.attachments.map((x) => [x.id, x.name, x.inline]), whole.attachments.map((x) => [x.id, x.name, x.inline]));
  assert.deepEqual(light.attachments.map((x) => x.id), ['p1.2.2', 'p3']);
  const pdf = await big.c.getAttachment('p3', 'INBOX/999/42');
  assert.equal(pdf.name, 'Big.pdf');
  assert.equal(pdf.content.toString(), '%PDF-1.7 big');
  assert.equal((await big.c.getAttachment('p1.2.2', 'INBOX/999/42')).contentId, 'logo@x');
  await assert.rejects(big.c.getAttachment('p9', 'INBOX/999/42'), /not found/);
  // an id of before (by checksum) still finds its attachment
  const parsed = await simpleParser(big.source);
  const old = `${parsed.attachments.findIndex((x) => x.filename === 'Big.pdf') + 1}-${parsed.attachments.find((x) => x.filename === 'Big.pdf').checksum}`;
  assert.equal((await big.c.getAttachment(old, 'INBOX/999/42')).name, 'Big.pdf');
});

test('a message that is one attachment, large: listed as part 1, fetched by itself', async () => {
  const one = { headers: 'From: A <a@x.example>\r\nSubject: Scan\r\nMIME-Version: 1.0\r\nContent-Type: application/pdf; name="scan.pdf"\r\nContent-Disposition: attachment; filename="scan.pdf"\r\nContent-Transfer-Encoding: base64', body: 'JVBERi0xLjcgYmln' };
  const big = serving(one, 9_000_000);
  const m = await big.c.getMessage('INBOX/999/7');
  assert.deepEqual(m.attachments.map((x) => [x.id, x.name]), [['p1', 'scan.pdf']]);
  assert.ok(!big.asked.includes('whole'));
  assert.equal((await big.c.getAttachment('p1', 'INBOX/999/7')).content.toString(), '%PDF-1.7 big');
});

test('a part the server does not give: the message is read whole instead, never shown empty', async () => {
  const big = serving(MESSAGE, 9_000_000);
  const fetchOne = big.c.client.fetchOne;
  big.c.client.fetchOne = async (uid, q) => { const r = await fetchOne(uid, q); if (q.bodyParts) r.bodyParts.delete('1.1'); return r; };
  const m = await big.c.getMessage('INBOX/999/42');
  assert.ok(big.asked.includes('whole'));
  assert.match(m.body, /Hello there/);
});

test('a large text body is read whatever its size; a forwarded message as the whole message is one attachment, part 1', async () => {
  const long = 'x'.repeat(5 * 1024 * 1024);
  const big = serving(multi('multipart/mixed', 'M', 'From: A <a@x.example>\r\nSubject: Long\r\nMIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary="M"', [
    leafOf('Content-Type: text/plain', long),
    leafOf('Content-Type: application/pdf; name="a.pdf"\r\nContent-Disposition: attachment; filename="a.pdf"\r\nContent-Transfer-Encoding: base64', 'JVBERi0=')
  ]), 9_000_000);
  assert.equal((await big.c.getMessage('INBOX/999/1')).body.length, long.length);
  const fwd = { headers: 'From: A <a@x.example>\r\nSubject: Fwd\r\nMIME-Version: 1.0\r\nContent-Type: message/rfc822', body: 'From: B <b@x.example>\r\nSubject: Inner\r\n\r\nInner text' };
  const one = serving(fwd, 9_000_000);
  // (imapflow nests the forwarded message's own structure under it)
  const inner = { type: 'text/plain', part: '1.1', size: 10 };
  const fetchOne = one.c.client.fetchOne;
  one.c.client.fetchOne = async (uid, q) => { const r = await fetchOne(uid, q); if (r.bodyStructure) r.bodyStructure = { ...r.bodyStructure, childNodes: [inner] }; return r; };
  const m = await one.c.getMessage('INBOX/999/2');
  assert.deepEqual(m.attachments.map((x) => x.id), ['p1']);
  assert.match((await one.c.getAttachment('p1', 'INBOX/999/2')).content.toString(), /Inner text/);
});

