import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createMailcore, AccountClient, splitId, normalizeAccount, memoryStore } from '../src/index.js';

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

test('AccountClient.close() waits for the backends to close', async () => {
  const order = [];
  const slow = (name) => ({ close: () => new Promise((r) => setTimeout(() => { order.push(name); r(); }, 10)) });
  const c = new AccountClient('home', slow('mail'), slow('calendar'));
  const p = c.close();
  assert.ok(p instanceof Promise);
  await p;
  assert.deepEqual(order.sort(), ['calendar', 'mail']);
  const failing = new AccountClient('x', { close: async () => { throw new Error('logout failed'); } });
  await failing.close(); // never rejects
});
