// The JMAP backend and its push stream against an in-process JMAP server (node:http on 127.0.0.1): session
// discovery, listing and searching, reading, drafts, sending, moves, flags, attachments, errors, and push.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { simpleParser } from 'mailparser';
import MailComposer from 'nodemailer/lib/mail-composer/index.js';
import { JmapClient } from '../src/jmap.js';
import { JmapStream, sseEvents } from '../src/jmap-stream.js';
import { normalizeAccount, jmapSessionUrl, hasMail } from '../src/accounts.js';
import { AccountClient, idParts, splitId } from '../src/client.js';

const KEY = 'api-key-123';
const ACCOUNT = 'A1';

// --- a JMAP server, in memory ---------------------------------------------------

async function mockServer({ eventSource = true } = {}) {
  const mailboxes = [
    { id: 'mb-in', name: 'Inbox', role: 'inbox', parentId: null },
    { id: 'mb-sent', name: 'Sent', role: 'sent', parentId: null },
    { id: 'mb-drafts', name: 'Drafts', role: 'drafts', parentId: null },
    { id: 'mb-trash', name: 'Trash', role: 'trash', parentId: null },
    { id: 'mb-junk', name: 'Spam', role: 'junk', parentId: null },
    { id: 'mb-arch', name: 'Archive', role: 'archive', parentId: null },
    { id: 'mb-proj', name: 'Projects', role: null, parentId: null },
    { id: 'mb-2026', name: '2026', role: null, parentId: 'mb-proj' }
  ];
  const emails = new Map();
  const blobs = new Map();
  const srv = {
    emails, blobs, requests: [], submissions: [], failNext: [], sse: new Set(), sseOpened: 0,
    state: 1, next: 1, url: '',
    bump() {
      srv.state++;
      for (const res of srv.sse) res.write(`event: state\ndata: ${JSON.stringify({ '@type': 'StateChange', changed: { [ACCOUNT]: { Email: String(srv.state) } } })}\n\n`);
    },
    async add(mail, { mailbox = 'mb-in', keywords = {}, receivedAt = new Date().toISOString(), threadId } = {}) {
      const raw = await new MailComposer(mail).compile().build();
      return srv.store(raw, { mailboxIds: { [mailbox]: true }, keywords, receivedAt, threadId });
    },
    async store(raw, { mailboxIds, keywords = {}, receivedAt = new Date().toISOString(), threadId }) {
      const blobId = `B${srv.next++}`;
      blobs.set(blobId, { buf: raw, type: 'message/rfc822' });
      const p = await simpleParser(raw);
      const id = `M${srv.next++}`;
      const ids = (v) => (v ? String(v).split(/\s+/).map((x) => x.replace(/^<|>$/g, '')).filter(Boolean) : null);
      const people = (a) => (a ? a.value.map((x) => ({ name: x.name || null, email: x.address })) : null);
      const replyOf = p.inReplyTo && [...emails.values()].find((e) => e.messageId?.includes(ids(p.inReplyTo)[0]));
      emails.set(id, {
        id, blobId, mailboxIds, keywords, receivedAt, size: raw.length,
        threadId: threadId || replyOf?.threadId || `T${id}`,
        messageId: ids(p.messageId), inReplyTo: ids(p.inReplyTo), from: people(p.from), sender: null, to: people(p.to), cc: people(p.cc),
        subject: p.subject || '', sentAt: p.date?.toISOString(), hasAttachment: (p.attachments || []).length > 0,
        text: `${p.subject} ${p.text || ''}`, headerLines: p.headerLines
      });
      srv.bump();
      return id;
    }
  };

  const header = (e, prop) => {
    const [, name, ...rest] = prop.split(':');
    const all = rest.includes('all');
    const asText = rest.includes('asText');
    const vals = e.headerLines.filter((h) => h.key === name.toLowerCase()).map((h) => h.line.slice(h.line.indexOf(':') + 1)).map((v) => (asText ? v.replace(/\r?\n[ \t]+/g, ' ').trim() : v));
    return all ? vals : vals.length ? vals[vals.length - 1] : null;
  };
  const matches = (e, f) => {
    if (f.operator === 'AND') return f.conditions.every((c) => matches(e, c));
    if (f.operator === 'OR') return f.conditions.some((c) => matches(e, c));
    if (f.operator === 'NOT') return !f.conditions.some((c) => matches(e, c));
    const has = (list, s) => (list || []).some((a) => `${a.name || ''} ${a.email}`.toLowerCase().includes(s.toLowerCase()));
    if (f.inMailbox && !e.mailboxIds[f.inMailbox]) return false;
    if (f.notKeyword && e.keywords[f.notKeyword]) return false;
    if (f.hasKeyword && !e.keywords[f.hasKeyword]) return false;
    if (f.from && !has(e.from, f.from)) return false;
    if (f.to && !has(e.to, f.to)) return false;
    if (f.cc && !has(e.cc, f.cc)) return false;
    if (f.subject && !e.subject.toLowerCase().includes(f.subject.toLowerCase())) return false;
    if (f.text && !e.text.toLowerCase().includes(f.text.toLowerCase())) return false;
    if (f.hasAttachment !== undefined && e.hasAttachment !== f.hasAttachment) return false;
    if (f.after && !(e.receivedAt >= f.after)) return false;
    if (f.before && !(e.receivedAt < f.before)) return false;
    return true;
  };
  const resolve = (args, results) => {
    const out = { ...args };
    for (const k of Object.keys(args)) {
      if (!k.startsWith('#')) continue;
      const ref = args[k];
      const r = results.find(([n, , t]) => t === ref.resultOf && n === ref.name)?.[1];
      if (!r) return null;
      out[k.slice(1)] = ref.path === '/ids' ? r.ids : r.list.flatMap((x) => x.emailIds);
      delete out[k];
    }
    return out;
  };
  const patch = (e, p) => {
    for (const [k, v] of Object.entries(p)) {
      if (k === 'mailboxIds') e.mailboxIds = { ...v };
      else if (k.startsWith('keywords/')) { if (v) e.keywords[k.slice(9)] = true; else delete e.keywords[k.slice(9)]; }
      else throw new Error('bad patch ' + k);
    }
  };
  const emailSet = (a) => {
    const r = { accountId: ACCOUNT, updated: {}, notUpdated: {}, destroyed: [], notDestroyed: {} };
    for (const [id, p] of Object.entries(a.update || {})) {
      const e = emails.get(id);
      if (!e) { r.notUpdated[id] = { type: 'notFound' }; continue; }
      patch(e, p);
      r.updated[id] = null;
    }
    for (const id of a.destroy || []) {
      if (emails.delete(id)) r.destroyed.push(id); else r.notDestroyed[id] = { type: 'notFound' };
    }
    if (Object.keys(r.updated).length || r.destroyed.length) srv.bump();
    return r;
  };
  const methods = {
    'Mailbox/get': () => ({ accountId: ACCOUNT, state: '1', list: mailboxes, notFound: [] }),
    'Email/query': (a) => {
      const list = [...emails.values()].filter((e) => matches(e, a.filter || {})).sort((x, y) => (x.receivedAt < y.receivedAt ? 1 : -1));
      const pos = a.position || 0;
      return { accountId: ACCOUNT, ids: list.slice(pos, pos + (a.limit || 256)).map((e) => e.id), position: pos, total: list.length, queryState: String(srv.state) };
    },
    'Email/get': (a) => {
      const list = [];
      const notFound = [];
      for (const id of a.ids || []) {
        const e = emails.get(id);
        if (!e) { notFound.push(id); continue; }
        const o = {};
        for (const p of a.properties) o[p] = p.startsWith('header:') ? header(e, p) : e[p] ?? null;
        o.id = e.id;
        list.push(o);
      }
      return { accountId: ACCOUNT, state: String(srv.state), list, notFound };
    },
    'Thread/get': (a) => ({ accountId: ACCOUNT, list: a.ids.map((t) => ({ id: t, emailIds: [...emails.values()].filter((e) => e.threadId === t).map((e) => e.id) })).filter((t) => t.emailIds.length), notFound: [] }),
    'Email/set': emailSet,
    'Email/import': async (a) => {
      const created = {};
      for (const [cid, x] of Object.entries(a.emails)) {
        const id = await srv.store(blobs.get(x.blobId).buf, { mailboxIds: x.mailboxIds, keywords: { ...x.keywords } });
        created[cid] = { id, blobId: emails.get(id).blobId, threadId: emails.get(id).threadId, size: 1 };
      }
      return { accountId: ACCOUNT, created, notCreated: {} };
    },
    'Identity/get': () => ({ accountId: ACCOUNT, list: [{ id: 'I-other', email: 'other@example.org', name: '' }, { id: 'I-me', email: 'me@example.org', name: 'Me' }] }),
    'EmailSubmission/set': (a, out) => {
      const created = {};
      for (const [cid, x] of Object.entries(a.create)) {
        if (!emails.has(x.emailId)) return { accountId: ACCOUNT, created: {}, notCreated: { [cid]: { type: 'invalidProperties', description: 'no such email' } } };
        srv.submissions.push({ ...x, raw: blobs.get(emails.get(x.emailId).blobId).buf.toString() });
        created[cid] = { id: `S${srv.next++}` };
      }
      const update = {};
      for (const [ref, p] of Object.entries(a.onSuccessUpdateEmail || {})) update[a.create[ref.slice(1)].emailId] = p;
      out.push(['Email/set', emailSet({ update }), null]);
      return { accountId: ACCOUNT, created, notCreated: {} };
    }
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, srv.url);
    srv.requests.push(`${req.method} ${url.pathname}`);
    const body = await new Promise((r) => { const c = []; req.on('data', (d) => c.push(d)); req.on('end', () => r(Buffer.concat(c))); });
    if (url.pathname === '/.well-known/jmap') { res.writeHead(307, { Location: '/jmap/session' }); return res.end(); }
    if (req.headers.authorization !== `Bearer ${KEY}`) { res.writeHead(401); return res.end('unauthorized'); }
    const fail = srv.failNext.shift();
    if (fail) { res.writeHead(fail, { 'Content-Type': 'application/problem+json' }); return res.end(JSON.stringify({ type: 'about:blank', detail: 'down for a moment' })); }
    const json = (o) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
    if (url.pathname === '/jmap/session') {
      return json({
        capabilities: { 'urn:ietf:params:jmap:core': { maxObjectsInGet: 500 }, 'urn:ietf:params:jmap:mail': {}, 'urn:ietf:params:jmap:submission': {} },
        accounts: { [ACCOUNT]: { name: 'me@example.org', isPersonal: true, isReadOnly: false, accountCapabilities: {} } },
        primaryAccounts: { 'urn:ietf:params:jmap:mail': ACCOUNT, 'urn:ietf:params:jmap:submission': ACCOUNT },
        username: 'me@example.org',
        apiUrl: '/jmap/api/',
        downloadUrl: `${srv.url}/jmap/download/{accountId}/{blobId}/{name}?accept={type}`,
        uploadUrl: `${srv.url}/jmap/upload/{accountId}/`,
        eventSourceUrl: eventSource ? `${srv.url}/jmap/events/?types={types}&closeafter={closeafter}&ping={ping}` : undefined,
        state: 's1'
      });
    }
    if (url.pathname === '/jmap/api/') {
      const { using, methodCalls } = JSON.parse(body);
      srv.calls = methodCalls;
      const out = [];
      for (const [name, args, tag] of methodCalls) {
        if (/^(EmailSubmission|Identity)\//.test(name) && !using.includes('urn:ietf:params:jmap:submission')) { out.push(['error', { type: 'unknownMethod' }, tag]); continue; }
        const fn = methods[name];
        if (!fn) { out.push(['error', { type: 'unknownMethod' }, tag]); continue; }
        if (args.accountId !== ACCOUNT) { out.push(['error', { type: 'accountNotFound' }, tag]); continue; }
        if (srv.methodError === name) { out.push(['error', { type: 'invalidArguments', description: 'that filter is not supported' }, tag]); continue; }
        const extra = [];
        const resolved = resolve(args, out);
        if (!resolved) { out.push(['error', { type: 'invalidResultReference' }, tag]); continue; }
        out.push([name, await fn(resolved, extra), tag]);
        for (const x of extra) out.push([x[0], x[1], tag]);
      }
      return json({ methodResponses: out, sessionState: 's1' });
    }
    const up = /^\/jmap\/upload\/A1\/$/.exec(url.pathname);
    if (up && req.method === 'POST') {
      const blobId = `B${srv.next++}`;
      blobs.set(blobId, { buf: body, type: req.headers['content-type'] });
      return json({ accountId: ACCOUNT, blobId, type: req.headers['content-type'], size: body.length });
    }
    const down = /^\/jmap\/download\/A1\/([^/]+)\/([^/]+)$/.exec(url.pathname);
    if (down) {
      const b = blobs.get(down[1]);
      if (!b) { res.writeHead(404); return res.end(); }
      res.writeHead(200, { 'Content-Type': url.searchParams.get('accept') || b.type });
      return res.end(b.buf);
    }
    if (url.pathname === '/jmap/events/') {
      if (srv.sseDown) { res.writeHead(503); return res.end(); }
      srv.sseOpened++;
      srv.eventQuery = Object.fromEntries(url.searchParams);
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
      res.write(': hello\n\n');
      srv.sse.add(res);
      res.on('close', () => srv.sse.delete(res));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  srv.url = `http://127.0.0.1:${server.address().port}`;
  srv.close = () => { for (const r of srv.sse) r.destroy(); server.closeAllConnections?.(); return new Promise((r) => server.close(r)); };
  return srv;
}

const acctOf = (srv, extra = {}) => normalizeAccount('fm', { provider: 'jmap', email: 'me@example.org', jmap: { session: `${srv.url}/.well-known/jmap` }, ...extra });
const clientOf = (srv, key = KEY) => new JmapClient(acctOf(srv), { username: 'me@example.org', password: key });
const until = async (fn, ms = 3000) => { const end = Date.now() + ms; while (!(await fn())) { if (Date.now() > end) throw new Error(`timed out: ${fn}`); await new Promise((r) => setTimeout(r, 10)); } };

// --- tests ---------------------------------------------------------------------

test('account: jmap is a mail provider; the session URL is given, a bare host, or the email domain', () => {
  const a = normalizeAccount('x', { provider: 'jmap', email: 'me@Mailflare.example' });
  assert.equal(a.provider, 'jmap');
  assert.deepEqual(a.jmap, { session: '' });
  assert.equal(a.cache.enabled, true);
  assert.ok(hasMail(a));
  assert.equal(jmapSessionUrl(a), 'https://mailflare.example/.well-known/jmap');
  assert.equal(jmapSessionUrl({ ...a, jmap: { session: 'mail.example.net' } }), 'https://mail.example.net/.well-known/jmap');
  assert.equal(jmapSessionUrl({ ...a, jmap: { session: 'https://api.fastmail.com/jmap/session' } }), 'https://api.fastmail.com/jmap/session');
  assert.throws(() => jmapSessionUrl({ name: 'n', jmap: { session: '' } }), /jmap.session/);
});

test('ids: a JMAP id is never taken for an IMAP one, and routes back to its account', () => {
  assert.equal(idParts('M1a2b_c-3'), null);
  assert.deepEqual(splitId('fm:M1a2b_c-3'), { account: 'fm', rawId: 'M1a2b_c-3' });
});

test('session: discovered through the well-known redirect (the key sent again), relative URLs made whole', async () => {
  const srv = await mockServer();
  try {
    const s = await clientOf(srv).session();
    assert.equal(s.apiUrl, `${srv.url}/jmap/api/`);
    assert.equal(s.accountId, ACCOUNT);
    assert.equal(s.submissionAccountId, ACCOUNT);
    assert.match(s.downloadUrl, /\{blobId\}/);
    assert.deepEqual(srv.requests.slice(0, 2), ['GET /.well-known/jmap', 'GET /jmap/session']);
  } finally { await srv.close(); }
});

test('findInbox: newest first, in the shape of an IMAP listing; searches become JMAP filters', async () => {
  const srv = await mockServer();
  try {
    await srv.add({ from: 'Ann <ann@example.com>', to: 'Me <me@example.org>', cc: 'bob@example.com', subject: 'Old', text: 'hello' }, { receivedAt: '2026-11-01T10:00:00Z', keywords: { $seen: true } });
    const id = await srv.add({ from: 'Zed <zed@example.com>', to: 'me@example.org', subject: 'New invoice', text: 'pay', messageId: '<n1@example.com>', attachments: [{ filename: 'a.pdf', content: 'x' }] }, { receivedAt: '2026-11-02T10:00:00Z', keywords: { $flagged: true } });
    await srv.add({ from: 'x@example.com', to: 'me@example.org', subject: 'Elsewhere' }, { mailbox: 'mb-2026', receivedAt: '2026-11-03T10:00:00Z' });
    const c = clientOf(srv);
    const all = await c.findInbox({ limit: 10 });
    assert.deepEqual(all.map((i) => i.subject), ['New invoice', 'Old']);
    const n = all[0];
    assert.equal(n.id, id);
    assert.equal(n.fromName, 'Zed');
    assert.equal(n.fromEmail, 'zed@example.com');
    assert.equal(n.isRead, false);
    assert.equal(n.isFlagged, true);
    assert.equal(n.hasAttachments, true);
    assert.equal(n.received, '2026-11-02T10:00:00.000Z');
    assert.equal(n.messageId, '<n1@example.com>');
    assert.equal(n.changeKey, '');
    assert.ok(n.conversationId);
    assert.deepEqual(all[1].toPeople, [{ name: 'Me', email: 'me@example.org' }, { name: '', email: 'bob@example.com' }]);
    assert.deepEqual((await c.findInbox({ unreadOnly: true })).map((i) => i.subject), ['New invoice']);
    assert.deepEqual((await c.findInbox({ senderContains: 'ann' })).map((i) => i.subject), ['Old']);
    assert.deepEqual((await c.findInbox({ subjectContains: 'invoice', flaggedOnly: true, hasAttachments: true })).map((i) => i.subject), ['New invoice']);
    assert.deepEqual((await c.findInbox({ sinceIso: '2026-11-02T00:00:00Z' })).map((i) => i.subject), ['New invoice']);
    assert.deepEqual((await c.findInbox({ untilIso: '2026-11-01T10:00:00.000Z' })).map((i) => i.subject), ['Old']);
    assert.deepEqual((await c.findInbox({ withAny: ['bob@example.com'] })).map((i) => i.subject), ['Old']);
    assert.deepEqual((await c.findInbox({ text: ['pay', 'invoice'] })).map((i) => i.subject), ['New invoice']);
    assert.deepEqual((await c.findInbox({ limit: 1, offset: 1 })).map((i) => i.subject), ['Old']);
    assert.deepEqual((await c.findInbox({ folder: 'Projects/2026' })).map((i) => i.subject), ['Elsewhere']);
    await assert.rejects(c.findInbox({ folder: 'nowhere' }), /unknown folder/);
    const q = srv.calls.find(([n]) => n === 'Email/query')[1];
    assert.deepEqual(q.sort, [{ property: 'receivedAt', isAscending: false }]);
  } finally { await srv.close(); }
});

test('getMessage: text and HTML bodies, people, threading, bulk and authentication headers', async () => {
  const srv = await mockServer();
  try {
    const id = await srv.add({
      from: 'News <news@example.com>', to: 'me@example.org', cc: 'c@example.com', replyTo: 'r@example.com', subject: 'Weekly',
      text: 'plain words', html: '<p>rich <b>words</b></p>', messageId: '<w1@example.com>', references: '<a@x> <b@x>',
      headers: { 'List-Id': '<weekly.example.com>', 'Authentication-Results': 'mx.example.org; dkim=pass header.d=example.com' }
    });
    const c = clientOf(srv);
    const t = await c.getMessage(id, { bodyType: 'Text' });
    assert.equal(t.bodyType, 'Text');
    assert.equal(t.body.trim(), 'plain words');
    assert.deepEqual(t.to, [{ name: '', email: 'me@example.org' }]);
    assert.deepEqual(t.cc, [{ name: '', email: 'c@example.com' }]);
    assert.deepEqual(t.replyTo, [{ name: '', email: 'r@example.com' }]);
    assert.equal(t.references, '<a@x> <b@x>');
    assert.equal(t.isBulk, true);
    assert.deepEqual(t.authHeaders.results, ['mx.example.org; dkim=pass header.d=example.com']);
    const h = await c.getMessage(id, { bodyType: 'HTML' });
    assert.equal(h.bodyType, 'HTML');
    assert.match(h.body, /<b>words<\/b>/);
    assert.deepEqual([...await c.bulkFlags([id, 'not/an/id'])], [[id, true]]);
    const auth = await c.authHeadersOf([id]);
    assert.deepEqual(auth.get(id).results, ['mx.example.org; dkim=pass header.d=example.com']);
    assert.equal(auth.get(id).fromEmail, 'news@example.com');
    await assert.rejects(c.getMessage('Mnope'), /not found/);
  } finally { await srv.close(); }
});

test('draftReply: a draft in Drafts ($draft, $seen) to the sender, Re:, In-Reply-To and References, the original quoted', async () => {
  const srv = await mockServer();
  try {
    const id = await srv.add({ from: 'Ann <ann@example.com>', to: 'me@example.org, carl@example.com', subject: 'Plans', text: 'Shall we?', messageId: '<p1@example.com>', references: '<p0@example.com>' });
    const ac = new AccountClient('fm', clientOf(srv));
    const r = await ac.draftReply(`fm:${id}`, '', 'Yes.');
    assert.match(r.draftId, /^fm:M/);
    assert.equal(r.changeKey, r.draftId);
    const raw = splitId(r.draftId).rawId;
    const e = srv.emails.get(raw);
    assert.deepEqual(e.mailboxIds, { 'mb-drafts': true });
    assert.deepEqual(e.keywords, { $draft: true, $seen: true });
    const p = await simpleParser(srv.blobs.get(e.blobId).buf);
    assert.equal(p.subject, 'Re: Plans');
    assert.equal(p.inReplyTo, '<p1@example.com>');
    assert.deepEqual([].concat(p.references), ['<p0@example.com>', '<p1@example.com>']);
    assert.deepEqual(p.to.value.map((a) => a.address), ['ann@example.com']);
    assert.equal(p.from.value[0].address, 'me@example.org');
    assert.match(p.text, /^Yes\.[\s\S]*> Shall we\?/);
    const all = await ac.draftReplyAll(`fm:${id}`, '', 'All of you.');
    const pa = await simpleParser(srv.blobs.get(srv.emails.get(splitId(all.draftId).rawId).blobId).buf);
    assert.deepEqual(pa.to.value.map((a) => a.address), ['ann@example.com', 'carl@example.com']); // not me
    const fwd = await ac.draftForward(`fm:${id}`, '', 'FYI', { to: ['dan@example.com'] });
    const pf = await simpleParser(srv.blobs.get(srv.emails.get(splitId(fwd.draftId).rawId).blobId).buf);
    assert.equal(pf.subject, 'Fwd: Plans');
  } finally { await srv.close(); }
});

test('updateDraft: a new draft with a new id, the old one destroyed; keepQuoted keeps the quote', async () => {
  const srv = await mockServer();
  try {
    const id = await srv.add({ from: 'ann@example.com', to: 'me@example.org', subject: 'Q', text: 'Question?', messageId: '<q@example.com>' });
    const ac = new AccountClient('fm', clientOf(srv));
    const d = await ac.draftReply(`fm:${id}`, '', 'first answer');
    const u = await ac.updateDraft({ id: d.draftId, changeKey: d.changeKey, body: 'second answer', keepQuoted: true });
    assert.notEqual(u.draftId, d.draftId);
    assert.equal(srv.emails.has(splitId(d.draftId).rawId), false);
    const m = await ac.getMessage(u.draftId);
    assert.match(m.body, /^second answer/);
    assert.match(m.body, /> Question\?/);
    assert.doesNotMatch(m.body, /first answer/);
    assert.equal(m.inReplyTo, '<q@example.com>');
    assert.equal(m.subject, 'Re: Q');
    await assert.rejects(ac.updateDraft({ id: u.draftId }), /nothing to change/);
  } finally { await srv.close(); }
});

test('attachments: added through an upload (a new draft), listed, downloaded, removed', async () => {
  const srv = await mockServer();
  try {
    const ac = new AccountClient('fm', clientOf(srv));
    const d = await ac.createMessage({ to: ['x@example.com'], subject: 'Files', body: 'see attached' });
    assert.equal(d.sent, false);
    const a = await ac.addAttachment(d.draftId, d.changeKey, { name: 'notes.txt', contentBase64: Buffer.from('the notes').toString('base64'), contentType: 'text/plain' });
    assert.notEqual(a.draftId, d.draftId);
    assert.ok(srv.requests.includes('POST /jmap/upload/A1/'));
    const m = await ac.getMessage(a.draftId);
    assert.equal(m.attachments.length, 1);
    assert.equal(m.attachments[0].name, 'notes.txt');
    const got = await ac.getAttachment(m.attachments[0].id, a.draftId);
    assert.equal(got.content.toString(), 'the notes');
    assert.equal(got.name, 'notes.txt');
    const r = await ac.removeAttachment(a.draftId, a.changeKey, m.attachments[0].id);
    assert.equal((await ac.getMessage(r.draftId)).attachments.length, 0);
    assert.equal(srv.emails.has(splitId(a.draftId).rawId), false);
  } finally { await srv.close(); }
});

test('sendItem: an EmailSubmission with the account\'s identity, Bcc in the envelope only; the sent copy is moved to Sent, the draft goes', async () => {
  const srv = await mockServer();
  try {
    const ac = new AccountClient('fm', clientOf(srv));
    const d = await ac.createMessage({ to: ['x@example.com'], bcc: ['hidden@example.com'], subject: 'Hi', body: 'hello' });
    const draftRaw = splitId(d.draftId).rawId;
    assert.match(srv.blobs.get(srv.emails.get(draftRaw).blobId).buf.toString(), /^Bcc: hidden@example.com/m); // a draft keeps its Bcc
    assert.equal(await ac.sendItem(d.draftId, d.changeKey), true);
    assert.equal(srv.submissions.length, 1);
    const sub = srv.submissions[0];
    assert.equal(sub.identityId, 'I-me');
    assert.deepEqual(sub.envelope, { mailFrom: { email: 'me@example.org' }, rcptTo: [{ email: 'x@example.com' }, { email: 'hidden@example.com' }] });
    assert.doesNotMatch(sub.raw, /^Bcc:/im);
    const sent = srv.emails.get(sub.emailId);
    assert.deepEqual(sent.mailboxIds, { 'mb-sent': true });
    assert.deepEqual(sent.keywords, { $seen: true });
    assert.notDeepEqual(sent.messageId, srv.emails.get(draftRaw)?.messageId);
    assert.equal(srv.emails.has(draftRaw), false);
    const now = await ac.createMessage({ to: ['y@example.com'], subject: 'Direct', body: 'b', send: true });
    assert.equal(now.sent, true);
    assert.deepEqual(srv.emails.get(splitId(now.draftId).rawId).mailboxIds, { 'mb-sent': true });
    assert.deepEqual((await ac.sentTo()).map((s) => s.to), [['x@example.com'], ['y@example.com']]);
  } finally { await srv.close(); }
});

test('a submission the server refuses: an error, and the copy made for it is gone', async () => {
  const srv = await mockServer();
  try {
    const c = clientOf(srv);
    srv.methodError = 'EmailSubmission/set';
    const before = srv.emails.size;
    await assert.rejects(c.createMessage({ to: ['y@example.com'], subject: 's', body: 'b', send: true }), /refused EmailSubmission\/set: invalidArguments \(that filter is not supported\)/);
    assert.equal(srv.emails.size, before);
  } finally { await srv.close(); }
});

test('move, delete (to the trash, then for good), read and flag', async () => {
  const srv = await mockServer();
  try {
    const a = await srv.add({ from: 'a@example.com', to: 'me@example.org', subject: 'A' });
    const b = await srv.add({ from: 'b@example.com', to: 'me@example.org', subject: 'B' });
    const ac = new AccountClient('fm', clientOf(srv));
    const moved = await ac.moveItems([`fm:${a}`, 'fm:Mgone'], 'archive');
    assert.deepEqual([...moved], [[`fm:${a}`, `fm:${a}`], ['fm:Mgone', null]]);
    assert.deepEqual(srv.emails.get(a).mailboxIds, { 'mb-arch': true });
    await ac.markRead(`fm:${b}`, '', true);
    assert.equal(srv.emails.get(b).keywords.$seen, true);
    await ac.markRead(`fm:${b}`, '', false);
    assert.equal(srv.emails.get(b).keywords.$seen, undefined);
    await ac.setFlag(`fm:${b}`, '', true);
    assert.equal(srv.emails.get(b).keywords.$flagged, true);
    await assert.rejects(ac.setFlag('fm:Mgone', '', true), /not found/);
    await ac.deleteItem(`fm:${b}`, '');
    assert.deepEqual(srv.emails.get(b).mailboxIds, { 'mb-trash': true });
    await ac.deleteItem(`fm:${b}`, '');
    assert.equal(srv.emails.has(b), false);
  } finally { await srv.close(); }
});

test('findThread: the thread\'s messages in one folder, by Thread/get', async () => {
  const srv = await mockServer();
  try {
    const a = await srv.add({ from: 'a@example.com', to: 'me@example.org', subject: 'T', messageId: '<t1@x>' }, { receivedAt: '2026-11-01T00:00:00Z' });
    await srv.add({ from: 'a@example.com', to: 'me@example.org', subject: 'Re: T', inReplyTo: '<t1@x>', messageId: '<t2@x>' }, { receivedAt: '2026-11-02T00:00:00Z' });
    await srv.add({ from: 'me@example.org', to: 'a@example.com', subject: 'Re: T', inReplyTo: '<t1@x>' }, { mailbox: 'mb-sent' });
    const c = clientOf(srv);
    const thread = srv.emails.get(a).threadId;
    assert.deepEqual((await c.findThread({ folder: 'inbox', threadId: thread })).map((i) => i.messageId), ['<t2@x>', '<t1@x>']);
    assert.equal((await c.findThread({ folder: 'sent', threadId: thread })).length, 1);
    assert.deepEqual(await c.findThread({ folder: 'inbox', threadId: 'Tnone' }), []);
    assert.equal(await c.findThread({ folder: 'inbox' }), null);
  } finally { await srv.close(); }
});

test('errors: a refused key is MAIL_AUTH; a 5xx, an unreachable server and a method error are not', async () => {
  const srv = await mockServer();
  try {
    await assert.rejects(clientOf(srv, 'wrong').findInbox(), (e) => e.code === 'MAIL_AUTH' && e.status === 401);
    const c = clientOf(srv);
    await c.session();
    srv.failNext.push(503);
    await assert.rejects(c.findInbox(), (e) => e.code !== 'MAIL_AUTH' && e.status === 503 && /HTTP 503: down for a moment/.test(e.message));
    assert.equal((await c.findInbox()).length, 0); // passes: tried again, it works
    srv.methodError = 'Email/query';
    await assert.rejects(c.findInbox(), (e) => e.code !== 'MAIL_AUTH' && /refused Email\/query: invalidArguments/.test(e.message));
  } finally { await srv.close(); }
  const gone = new JmapClient(normalizeAccount('x', { provider: 'jmap', email: 'me@example.org', jmap: { session: srv.url + '/.well-known/jmap' } }), { password: KEY });
  await assert.rejects(gone.findInbox(), (e) => e.code === 'MAIL_NETWORK');
});

test('a sign-in token (creds.oauth) is asked for at each request and sent as the Bearer', async () => {
  const srv = await mockServer();
  try {
    let asked = 0;
    const c = new JmapClient(acctOf(srv), { oauth: async () => { asked++; return KEY; } });
    await c.findInbox();
    assert.ok(asked >= 2);
  } finally { await srv.close(); }
});

test('sse parser: events across chunks, CRLF split between chunks, comments and pings', () => {
  const got = [];
  const feed = sseEvents((e) => got.push(e));
  feed(': hi\r\n\r\nevent: state\r');
  feed('\ndata: {"a":');
  feed('1}\r\n\r\nevent: ping\ndata: {}\n\n');
  assert.deepEqual(got, [{ event: 'state', data: '{"a":1}', id: '' }, { event: 'ping', data: '{}', id: '' }]);
});

test('stream: a state change is new mail; a dropped connection is reconnected, and what changed meanwhile is told', async () => {
  const srv = await mockServer();
  const states = [];
  let told = 0;
  const stream = new JmapStream({ account: acctOf(srv), creds: { password: KEY }, onNewMail: () => told++, onState: (s) => states.push(s), retryMs: 20, log: (m) => process.env.DEBUG_JMAP && console.log(m) });
  try {
    stream.start();
    await until(() => stream.emailState != null); // listening, and where the Emails stand known
    assert.deepEqual(srv.eventQuery, { types: 'Email,Mailbox', closeafter: 'no', ping: '30' });
    assert.deepEqual(states, ['connected']);
    await srv.add({ from: 'a@example.com', to: 'me@example.org', subject: 'pushed' });
    await until(() => told === 1);
    // the server hangs up; mail comes while nobody listens
    srv.sseDown = true;
    for (const r of srv.sse) r.destroy();
    await until(() => srv.sse.size === 0);
    await srv.add({ from: 'a@example.com', to: 'me@example.org', subject: 'while away' });
    assert.equal(told, 1);
    srv.sseDown = false;
    await until(() => srv.sseOpened === 2 && srv.sse.size === 1);
    await until(() => told === 2);
    assert.ok(states.includes('reconnecting'));
    assert.equal(states.at(-1), 'connected');
  } finally {
    stream.stop();
    await srv.close();
  }
  await until(() => states.at(-1) === 'off');
});

test('stream: a refused key reaches the auth gate after a refresh; no eventSourceUrl is off at once', async () => {
  const srv = await mockServer();
  let failed = null;
  const states = [];
  const stream = new JmapStream({ account: acctOf(srv), creds: { password: 'bad' }, refreshCreds: async () => ({ password: 'still-bad' }), authGate: { blocked: () => !!failed, failed: (e) => { failed = e; }, ok() {} }, onState: (s) => states.push(s), retryMs: 10, pauseMs: 10 });
  try {
    stream.start();
    await until(() => failed);
    assert.equal(failed.code, 'MAIL_AUTH');
  } finally { stream.stop(); await srv.close(); }

  const quiet = await mockServer({ eventSource: false });
  const off = [];
  try {
    const s2 = new JmapStream({ account: acctOf(quiet), creds: { password: KEY }, onState: (s) => off.push(s) });
    s2.start();
    await until(() => off.length > 0);
    assert.deepEqual(off, ['off']);
  } finally { await quiet.close(); }
});
