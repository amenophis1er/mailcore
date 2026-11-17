// The encrypted cache (src/cache.js) as MailWatcher grew it: the HTML a mail
// does or does not have, flags, sent threads, differences applied, people.
// Each test gets a throwaway data directory and key.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createMailcore, memoryStore } from '../src/index.js';

const ACCOUNTS = { home: { provider: 'imap', email: 'me@home.invalid', imap: { host: '127.0.0.1' }, cache: { days: 30 } } };
const noCreds = { getPassword: async () => ({ password: 'secret' }) };

function cacheFor(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mailcore-cache-'));
  const state = memoryStore();
  const mc = createMailcore({ accounts: ACCOUNTS, credentials: noCreds, dataDir: dir, cacheKey: 'k'.repeat(64), state });
  t.after(() => { mc.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  let n = 0;
  const mail = (extra = {}) => {
    const item = { id: `home:INBOX/7/${++n}`, account: 'home', subject: `mail ${n}`, fromName: 'Ann', fromEmail: 'ann@example.com', received: new Date(Date.now() - 3600e3).toISOString(), isRead: false, isFlagged: false, conversationId: `T${n}`, messageId: `<${n}@x>`, ...extra };
    mc.cache.upsertItems('home', [item]);
    return item;
  };
  return { mc, cache: mc.cache, state, mail };
}

const shape = (m) => m && { bodyType: m.bodyType, body: m.body };

test('a mail whose text alone was read is not an answer for its HTML', (t) => {
  const { cache, mail } = cacheFor(t);
  const m = mail();
  assert.equal(cache.getCached(m.id, { bodyType: 'HTML' }), null); // no body yet
  cache.upsertBody('home', m, { text: 'Your code is 123456', html: null }); // read as text: whether it has HTML is not known
  assert.equal(cache.getCached(m.id, { bodyType: 'Text' }).body, 'Your code is 123456');
  assert.equal(cache.getCached(m.id, { bodyType: 'HTML' }), null); // so the server is asked, and the HTML shown
  cache.upsertBody('home', m, { text: 'Your code is 123456', html: '<p>Your code is <b>123456</b></p>' });
  assert.deepEqual(shape(cache.getCached(m.id, { bodyType: 'HTML' })), { bodyType: 'HTML', body: '<p>Your code is <b>123456</b></p>' });
  cache.upsertBody('home', m, { text: 'Your code is 123456', html: null }); // read as text again: the HTML stays
  assert.equal(cache.getCached(m.id, { bodyType: 'HTML' }).bodyType, 'HTML');
});

test('a mail known to have no HTML answers with its text', (t) => {
  const { cache, mail } = cacheFor(t);
  const m = mail();
  cache.upsertBody('home', m, { text: 'plain words', html: '' });
  assert.deepEqual(shape(cache.getCached(m.id, { bodyType: 'HTML' })), { bodyType: 'Text', body: 'plain words' });
  assert.equal(cache.getCached(m.id, { bodyType: 'Text' }).body, 'plain words');
});

test('a body for a message with no inbox row makes no row', (t) => {
  const { cache } = cacheFor(t);
  cache.upsertItems('home', []); // the database exists
  cache.upsertBody('home', { id: 'home:Sent/1/1', subject: 'mine', received: new Date().toISOString() }, { text: 'x' });
  assert.equal(cache.getCached('home:Sent/1/1'), null);
  assert.deepEqual(cache.idsOf('home'), []);
});

test('flagged mail only: the cache keeps the flagged rows, and never answers such a listing itself', (t) => {
  const { cache, state, mail } = cacheFor(t);
  const a = mail(); const b = mail();
  const report = {};
  cache.upsertItems('home', [{ ...a, isFlagged: true }, b], report);
  assert.equal(report.changed, 1);
  assert.deepEqual(cache.findCached(['home'], { flaggedOnly: true }).map((i) => i.id), [a.id]);
  assert.equal(cache.findCached(['home'], { flaggedOnly: true })[0].isFlagged, true);
  state.save({ lastPollAt: Date.now() });
  assert.equal(cache.cacheUsable(['home']), true);
  assert.equal(cache.cacheUsable(['home'], { flaggedOnly: true }), false); // older flagged mail is only on the server
  // a listing that does not say whether a mail is flagged leaves what is known
  cache.upsertItems('home', [{ ...a, isFlagged: undefined }]);
  assert.equal(cache.findCached(['home'], { flaggedOnly: true }).length, 1);
});

test('differences applied: read and flag state, messages gone; dropUnlisted and reconcile', (t) => {
  const { cache, mail } = cacheFor(t);
  const a = mail(); const b = mail(); const c = mail();
  assert.deepEqual(cache.applyChanges({ flags: [{ id: a.id, isRead: true, isFlagged: false }, { id: b.id, isRead: false, isFlagged: true }], gone: [c.id] }), { read: 1, flagged: 1, gone: 1 });
  assert.deepEqual(cache.idsOf('home').sort(), [a.id, b.id].sort());
  assert.equal(cache.dropUnlisted('home', [a], new Date(Date.now() - 86400e3).toISOString()), 1);
  assert.deepEqual(cache.idsOf('home'), [a.id]);
  const d = { ...b, id: 'home:INBOX/7/99' };
  assert.deepEqual(cache.reconcile('home', [d], new Date(Date.now() - 86400e3).toISOString()), { added: 1, removed: 1 });
  assert.deepEqual(cache.idsOf('home'), [d.id]);
  cache.setMeta('sync:home:inbox', '{"next":5}');
  assert.equal(cache.getMeta('sync:home:inbox'), '{"next":5}');
  assert.equal(cache.getMeta('nothing'), null);
});

test('sent threads count toward a thread, once per message', (t) => {
  const { cache, mail } = cacheFor(t);
  const a = mail({ conversationId: 'TX', messageId: '<a@x>' });
  const sent = [
    { id: 'home:Sent/1/1', conversationId: 'TX', messageId: '<s1@x>', received: new Date().toISOString() },
    { id: 'home:Sent/1/2', conversationId: 'TX', messageId: '<a@x>', received: new Date().toISOString() }, // mail to myself: also in the inbox
    { id: 'home:Sent/1/3', conversationId: '', received: new Date().toISOString() } // no thread id: skipped
  ];
  assert.deepEqual(cache.noteSent('home', sent), { added: 2, removed: 0 });
  assert.equal(cache.threadCounts([a]).get('home|TX'), 2);
  assert.deepEqual(cache.noteSent('home', [sent[0]], new Date(Date.now() - 86400e3).toISOString()), { added: 0, removed: 1 });
  assert.deepEqual(cache.idsOf('home', 'sent'), ['home:Sent/1/1']);
});

test('snippets and people come from what is cached', (t) => {
  const { mc, cache, mail } = cacheFor(t);
  const a = mail({ fromName: 'Ann Lee', fromEmail: 'ann@example.com' });
  mail({ fromName: 'Robot', fromEmail: 'no-reply@example.com' });
  cache.upsertBody('home', { ...a, to: [{ name: 'Bob', email: 'bob@example.com' }], cc: [] }, { text: '<p>Hello [https://x.example/track] there</p>', html: null });
  assert.equal(cache.snippets([a.id]).get(a.id), 'Hello there');
  assert.deepEqual(cache.texts([a.id]).get(a.id), '<p>Hello [https://x.example/track] there</p>');
  const people = mc.people('');
  assert.deepEqual(people.map((p) => p.email), ['ann@example.com', 'bob@example.com']);
  assert.deepEqual(mc.people('bo').map((p) => p.email), ['bob@example.com']);
  assert.equal(people[0].last, a.received, 'when they last wrote');
  assert.equal(people[1].last, a.received, 'when they were last written to');
});

test('Reply-To is kept with the body, an empty one too', (t) => {
  const { cache, mail } = cacheFor(t);
  const m = mail();
  cache.upsertBody('home', { ...m, to: [], cc: [], replyTo: [{ name: 'Ann at home', email: 'ann@home.example' }] }, { text: 'hi', html: '' });
  assert.deepEqual(cache.getCached(m.id).replyTo, [{ name: 'Ann at home', email: 'ann@home.example' }]);
  const none = mail();
  cache.upsertBody('home', { ...none, to: [], cc: [] }, { text: 'hi', html: '' });
  assert.deepEqual(cache.getCached(none.id).replyTo, []);
  assert.equal(cache.getCached(none.id, { stale: true }).body, 'hi');
});

test('findCached withAny: mail from, to or copied to any of the addresses; an underscore or a percent in an address is itself', (t) => {
  const { cache, mail } = cacheFor(t);
  const from = mail({ fromEmail: 'first_last@example.org', fromName: 'First Last' });
  const near = mail({ fromEmail: 'firstXlast@example.org', fromName: 'Near Miss' }); // (what "_" would also match, were it a wildcard)
  const to = mail({ fromEmail: 'boss@example.org', displayTo: 'first_last@example.org' });
  const cc = mail({ fromEmail: '100%real@example.org' });
  mail({ fromEmail: 'someone@else.example' });
  const ids = (opts) => cache.findCached(['home'], opts).map((i) => i.id).sort();
  assert.deepEqual(ids({ withAny: ['first_last@example.org'] }), [from.id, to.id].sort());
  assert.deepEqual(ids({ withAny: ['first_last@example.org', '100%real@example.org'] }), [from.id, to.id, cc.id].sort());
  assert.deepEqual(ids({ senderContains: 'first_last' }), [from.id]);
  assert.deepEqual(ids({ senderContains: 'firstXlast' }), [near.id]);
  assert.deepEqual(ids({ withAny: [] }).length, 5);
  // with toContains too: both hold
  assert.deepEqual(ids({ withAny: ['boss@example.org'], toContains: 'first_last@example.org' }), [to.id]);
});

