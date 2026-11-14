import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createMailcore, AccountClient, splitId, idParts, displayNameOf, normalizeAccount, memoryStore } from '../src/index.js';

const ACCOUNTS = {
  work: { provider: 'ews', host: 'https://mail.example.org', username: 'me', email: 'me@example.org' },
  home: { provider: 'imap', email: 'me@home.example', imap: { host: 'imap.home.example' }, smtp: { host: 'smtp.home.example' } },
  cal: { provider: 'caldav', service: 'fastmail', username: 'me@fm.example' }
};
const noCreds = { getPassword: async () => ({ password: 'secret' }) };

test('credentials are required', () => {
  assert.throws(() => createMailcore({ accounts: ACCOUNTS }), /credentials\.getPassword/);
});

test('accounts: normalized, resolved, listed', () => {
  const mc = createMailcore({ accounts: ACCOUNTS, credentials: noCreds });
  assert.deepEqual(mc.accountNames(), ['work', 'home', 'cal']);
  assert.deepEqual(mc.mailAccountNames(), ['work', 'home']);
  assert.deepEqual(mc.selectAccounts(), ['work', 'home']);
  assert.equal(mc.account('home').imap.port, 993);
  assert.equal(mc.account('home').cache.days, 30);
  assert.throws(() => mc.account(), /several accounts configured/);
  assert.throws(() => mc.account('nope'), /unknown account "nope"/);
  assert.deepEqual(mc.listAccounts().map((a) => [a.name, a.mail, a.calendar, a.cached]), [['work', true, 'ews', false], ['home', true, null, false], ['cal', false, 'caldav', false]]);
  const withDefault = createMailcore({ accounts: ACCOUNTS, defaultAccount: () => 'home', credentials: noCreds });
  assert.equal(withDefault.account().name, 'home');
  assert.deepEqual(normalizeAccount('x', normalizeAccount('x', ACCOUNTS.home)), normalizeAccount('x', ACCOUNTS.home), 'normalization is idempotent');
});

test('accounts may be a function, read on each use', () => {
  let accounts = { work: ACCOUNTS.work };
  const mc = createMailcore({ accounts: () => accounts, credentials: noCreds });
  assert.equal(mc.account().name, 'work');
  accounts = { home: ACCOUNTS.home };
  assert.equal(mc.account().name, 'home');
});

test('withClient retries an auth failure, then asks for fresh credentials', async () => {
  const asked = [];
  const mc = createMailcore({ accounts: ACCOUNTS, credentials: { getPassword: async (acct, o) => { asked.push([acct.name, o.refresh]); return { username: 'me', password: 'pw' + asked.length }; } } });
  let calls = 0;
  let refreshed = 0;
  const result = await mc.withClient('work:AAMk123', async (c) => {
    calls++;
    assert.equal(c.account, 'work');
    if (calls < 3) throw Object.assign(new Error('401'), { code: 'EWS_AUTH' });
    return c.backend.password;
  }, { onRefresh: () => refreshed++ });
  assert.equal(result, 'pw3');
  assert.deepEqual(asked, [['work', false], ['work', false], ['work', true]]);
  assert.equal(refreshed, 1);
  await assert.rejects(mc.withClient('work', async () => { throw new Error('boom'); }), /boom/);
});

test('a calendar-only account builds its calendar lazily with its own credentials', async () => {
  const asked = [];
  const mc = createMailcore({ accounts: ACCOUNTS, credentials: { getPassword: async (acct, o) => { asked.push(acct.name); return { password: 'pw' }; } } });
  const c = await mc.client('cal');
  assert.equal(c.hasMail, false);
  await assert.rejects(c.findInbox(), /holds no mail/);
  assert.deepEqual(asked, ['cal']);
});

test('AccountClient prefixes ids out and strips them in', async () => {
  const seen = [];
  const backend = {
    findInbox: async () => [{ id: 'RAW1', subject: 's' }],
    getMessage: async (id) => { seen.push(id); return { id, subject: 's' }; },
    markRead: async (id, ck, r) => { seen.push([id, ck, r]); return true; }
  };
  const c = new AccountClient('work', backend);
  assert.deepEqual(await c.findInbox({}), [{ id: 'work:RAW1', subject: 's', account: 'work' }]);
  assert.equal((await c.getMessage('work:RAW1')).id, 'work:RAW1');
  await c.markRead('work:RAW1', 'CK', true);
  assert.deepEqual(seen, ['RAW1', ['RAW1', 'CK', true]]);
  await assert.rejects(c.getMessage('home:RAW1'), /belongs to account "home"/);
  assert.deepEqual(splitId('home:INBOX/1/2'), { account: 'home', rawId: 'INBOX/1/2' });
  assert.deepEqual(splitId('AAMk'), { account: null, rawId: 'AAMk' });
});

test('no cache key, no cache', () => {
  const mc = createMailcore({ accounts: ACCOUNTS, credentials: noCreds, dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'mailcore-')) });
  assert.deepEqual(mc.cache.cachedAccounts(), []);
  assert.equal(mc.cache.openCache({ create: true }), null);
});

test('the encrypted cache serves listings and bodies while a watcher is alive', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mailcore-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const keyCalls = [];
  let stored = null;
  const cacheKey = ({ create }) => { keyCalls.push(create); if (!stored && create) stored = 'k'.repeat(64); return stored; };
  const state = memoryStore();
  const mc = createMailcore({ accounts: { work: ACCOUNTS.work }, credentials: noCreds, dataDir: dir, cacheKey, state });

  assert.equal(mc.cache.openCache(), null, 'a reader never creates the cache');
  const items = [
    { id: 'work:A', subject: 'Invoice 42', fromName: 'Ann', fromEmail: 'ann@x.org', received: '2026-10-24T08:00:00Z', isRead: false },
    { id: 'work:B', subject: 'Lunch', fromName: 'Bob', fromEmail: 'bob@x.org', received: '2026-10-23T08:00:00Z', isRead: true }
  ];
  assert.deepEqual(mc.cache.upsertItems('work', items), ['work:A', 'work:B']);
  mc.cache.upsertBody('work', { ...items[0], to: [{ name: 'Me', email: 'me@example.org' }], cc: [], attachments: [] }, { text: 'Please pay the invoice', html: '<p>Please pay</p>' });
  assert.ok(fs.existsSync(path.join(dir, 'cache.db')));
  assert.ok(!fs.readFileSync(path.join(dir, 'cache.db')).includes('Invoice'), 'the file is encrypted');

  assert.equal(mc.cache.cacheUsable(['work']), false, 'no watcher has polled');
  state.save({ lastPollAt: Date.now() });
  assert.equal(mc.cache.cacheUsable(['work']), true);
  assert.equal(mc.cache.cacheUsable(['work'], { live: true }), false);
  assert.equal(mc.cache.cacheUsable(['work'], { folder: 'sent' }), false);

  const unread = await mc.find(undefined, { unreadOnly: true });
  assert.deepEqual(unread.map((i) => i.id), ['work:A']);
  assert.ok(unread[0].cached);
  assert.deepEqual((await mc.find('work', { text: 'pay' })).map((i) => i.id), ['work:A']);
  const msg = await mc.read('work:A');
  assert.equal(msg.body, 'Please pay the invoice');
  assert.equal((await mc.read('work:A', { bodyType: 'HTML' })).body, '<p>Please pay</p>');

  mc.noteRead('work:A', true);
  assert.equal((await mc.find('work', { unreadOnly: true })).length, 0);
  mc.noteRemoved('work:B');
  assert.equal(mc.cache.cacheStats().accounts[0].n, 1);
  mc.close();

  // the wrong key is a clear error, not garbage
  const wrong = createMailcore({ accounts: { work: ACCOUNTS.work }, credentials: noCreds, dataDir: dir, cacheKey: 'x'.repeat(64), state });
  assert.throws(() => wrong.cache.openCache(), (e) => e.code === 'CACHE_KEY');
});

test('AccountClient.close() starts the sign-out without waiting for it; wait: true waits; never rejects', async () => {
  const order = [];
  const started = [];
  const slow = (name) => ({ close: () => { started.push(name); return new Promise((r) => setTimeout(() => { order.push(name); r(); }, 30)); } });
  const c = new AccountClient('home', slow('mail'), slow('calendar'));
  const p = c.close();
  assert.ok(p instanceof Promise);
  await p;
  assert.deepEqual(started.sort(), ['calendar', 'mail'], 'both closes were started');
  assert.deepEqual(order, [], 'and not waited for: no LOGOUT round trip on the way out');
  const w = new AccountClient('home', slow('mail2'), slow('cal2'));
  await w.close({ wait: true });
  assert.deepEqual(order.filter((n) => n.endsWith('2')).sort(), ['cal2', 'mail2']);
  let unhandled = 0;
  const onUnhandled = () => unhandled++;
  process.on('unhandledRejection', onUnhandled);
  try {
    const failing = new AccountClient('x', { close: async () => { throw new Error('logout failed'); } });
    await failing.close(); // never rejects
    await failing.close({ wait: true });
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(unhandled, 0);
  } finally { process.off('unhandledRejection', onUnhandled); }
});

test('displayNameOf and idParts', () => {
  assert.equal(displayNameOf({ displayName: ' Ann \n Lee  ' }), 'Ann Lee');
  assert.equal(displayNameOf({ displayName: 'x'.repeat(150) }).length, 100);
  assert.equal(displayNameOf({}), '');
  assert.deepEqual(idParts('INBOX%2FWork/12/34'), { path: 'INBOX/Work', validity: '12', uid: 34 });
  assert.equal(idParts('AAMk'), null);
});

test('moveItems: per account, partial, the cache told; setFlag keeps the cache in step', async () => {
  const mc = createMailcore({ accounts: ACCOUNTS, credentials: noCreds });
  const backends = {
    work: { moveItems: async (ids) => new Map(ids.map((id) => [id, id === 'GONE' ? null : 'N' + id])), setFlag: async (id, ck, f) => [id, ck, f] },
    home: { moveItems: async () => { throw new Error('server down'); } }
  };
  mc.withClient = async (id, fn) => { const name = splitId(id).account || id; return fn(new AccountClient(name, backends[name])); };
  const removed = [];
  const flagged = [];
  mc.noteRemoved = (id) => removed.push(id);
  mc.noteFlagged = (id, f) => flagged.push([id, f]);
  const errors = [];
  const out = await mc.moveItems(['work:A', 'work:GONE', 'home:INBOX/1/2'], 'archive', { onError: (name, e) => errors.push([name, e.message]) });
  assert.deepEqual([...out], [['work:A', 'work:NA'], ['work:GONE', null]]);
  assert.deepEqual(removed, ['work:A', 'work:GONE']);
  assert.deepEqual(errors, [['home', 'server down']]);
  await assert.rejects(mc.moveItems(['home:INBOX/1/2'], 'trash'), /server down/); // nothing moved: the error is the answer
  assert.deepEqual(await mc.setFlag('work:A', false, 'CK'), ['A', 'CK', false]);
  assert.deepEqual(flagged, [['work:A', false]]);
});

test('calendar: every calendar listed once, a failing secondary marked; a shared calendar written to only when allowed', async () => {
  const mc = createMailcore({ accounts: { work: ACCOUNTS.work }, credentials: noCreds });
  const asked = [];
  const created = [];
  mc.withClient = async (id, fn) => fn({
    findCalendars: async () => { asked.push('calendars'); return [{ id: 'work:C1', name: 'Team', shared: true, mailbox: 'Team@x.org' }, { id: 'work:C2', name: 'Broken' }]; },
    findEvents: async (o) => {
      if (o.calendar === 'work:C2') throw new Error('no access');
      return [{ id: o.mailbox ? 'work:T' : 'work:D', subject: o.mailbox ? 'team' : 'mine', start: o.mailbox ? '2026-11-02T09:00:00Z' : '2026-11-01T09:00:00Z' }];
    },
    createEvent: async (o) => { created.push(o); return { id: 'work:new', account: 'work' }; }
  });
  const r = await mc.calendar.listAllEvents({ start: new Date(), end: new Date() });
  assert.deepEqual(r.items.map((e) => [e.id, e.calendarKey, e.shared]), [['work:D', 'work|default', false], ['work:T', 'work|mailbox:team@x.org', true]]);
  assert.deepEqual(r.calendars.map((c) => [c.name, c.isDefault, c.failed || null]), [['Calendar', true, null], ['Team', false, null], ['Broken', false, 'no access']]);
  await mc.calendar.listAllEvents({ start: new Date(), end: new Date() });
  assert.equal(asked.length, 1, 'which calendars there are is asked once in a while, not every time');
  await assert.rejects(mc.calendar.createEvent({ calendar: 'Team', subject: 'x' }), /only be created in your own calendars/);
  await mc.calendar.createEvent({ calendar: 'Team', subject: 'x', allowShared: true });
  assert.equal(created[0].mailbox, 'Team@x.org');
});

test('a username "DOMAIN\\user" is split, so NTLM does not get the domain twice', async () => {
  const mc = createMailcore({ accounts: ACCOUNTS, credentials: { getPassword: async () => ({ username: 'CORP\\me', domain: 'OTHER', password: 'pw' }) } });
  const got = await mc.withClient('work', (c) => [c.backend.domain, c.backend.username]);
  assert.deepEqual(got, ['CORP', 'me']);
});

test('moveItems: unprefixed ids go to the default account; moving nothing is an error; mail moved back to the inbox is cached at once', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mailcore-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const mc = createMailcore({ accounts: { work: ACCOUNTS.work, home: ACCOUNTS.home }, defaultAccount: 'work', credentials: noCreds, dataDir: dir, cacheKey: 'k'.repeat(64) });
  t.after(() => mc.close());
  const backend = {
    moveItems: async (ids) => new Map(ids.filter((id) => id !== 'REFUSED').map((id) => [id, 'N' + id])),
    getMessage: async (id) => ({ id, subject: 'back', fromEmail: 'ann@x.org', received: new Date().toISOString(), isRead: true })
  };
  const used = [];
  mc.withClient = async (name, fn) => { used.push(name); return fn(new AccountClient(name, backend)); };
  const errors = [];
  const out = await mc.moveItems(['A'], 'inbox', { onError: (name, e) => errors.push(name) });
  assert.deepEqual(used, ['work']);
  assert.deepEqual([...out], [['work:A', 'work:NA']]); // keyed by the full id
  assert.deepEqual(mc.cache.idsOf('work'), ['work:NA'], 'restored mail is in the cached inbox now');
  await assert.rejects(mc.moveItems(['work:REFUSED'], 'archive'), /none of these messages could be moved/);
  assert.deepEqual(errors, []);
});

test('calendar: a Google calendar one may only read (holidays, subscriptions) is not offered for new events', async () => {
  const mc = createMailcore({ accounts: { work: ACCOUNTS.work }, credentials: noCreds });
  mc.withClient = async (id, fn) => fn({
    findCalendars: async () => [{ id: 'work:H', name: 'Holidays', writable: false }, { id: 'work:F', name: 'Family', writable: true }],
    findEvents: async () => []
  });
  const r = await mc.calendar.listAllEvents({ start: new Date(), end: new Date() });
  assert.deepEqual(r.calendars.map((c) => [c.name, c.writable]), [['Calendar', true], ['Holidays', false], ['Family', true]]);
});
