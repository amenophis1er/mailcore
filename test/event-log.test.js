import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventLog, gapInfo, matchesFilter, memoryStore } from '../src/index.js';

test('queued events get monotonic cursors; others are live only', () => {
  const log = new EventLog();
  const live = [];
  log.on('event', (e) => live.push(e.type));
  const a = log.append('newmail', { account: 'work', rule: 'boss' });
  const s = log.append('stream', { account: 'work', state: 'connected' });
  const b = log.append('reminder', { account: 'work', minutes: 10 });
  assert.equal(a.seq, 1);
  assert.equal(s.seq, undefined);
  assert.equal(b.seq, 2);
  assert.equal(log.cursor, 2);
  assert.deepEqual(live, ['newmail', 'stream', 'reminder']);
});

test('filters: rules by default, calendar types only when asked', () => {
  const ruleMail = { type: 'newmail', account: 'work', rule: 'boss' };
  const plainMail = { type: 'newmail', account: 'home', rule: null };
  const reminder = { type: 'reminder', account: 'work' };
  assert.equal(matchesFilter(ruleMail, {}), true);
  assert.equal(matchesFilter(plainMail, {}), false);
  assert.equal(matchesFilter(plainMail, { match: 'all' }), true);
  assert.equal(matchesFilter(ruleMail, { rule: 'other' }), false);
  assert.equal(matchesFilter(ruleMail, { account: 'home' }), false);
  assert.equal(matchesFilter(reminder, { match: 'all' }), false);
  assert.equal(matchesFilter(reminder, { types: ['reminder'] }), true);
  assert.equal(matchesFilter(ruleMail, { types: ['reminder'] }), false);
});

test('wait returns what is past the cursor at once, else the next match', async () => {
  const log = new EventLog();
  log.append('newmail', { account: 'a', rule: 'r' });
  log.append('newmail', { account: 'a', rule: null });
  let r = await log.wait({ after: 0, filter: { match: 'all' } });
  assert.deepEqual(r.events.map((e) => e.seq), [1, 2]);
  assert.equal(r.cursor, 2);
  r = await log.wait({ after: 2, timeout: 0 });
  assert.deepEqual(r, { events: [], cursor: 2 });
  const pending = log.wait({ after: 'now', timeout: 5 });
  log.append('newmail', { account: 'a', rule: null }); // not a rule match: keeps waiting
  log.append('newmail', { account: 'a', rule: 'r' });
  r = await pending;
  assert.deepEqual(r.events.map((e) => e.seq), [4]);
  assert.equal(r.cursor, 4);
});

test('wait times out empty, and an abort ends it', async () => {
  const log = new EventLog();
  const r = await log.wait({ timeout: 0.05 });
  assert.deepEqual(r, { events: [], cursor: 0 });
  const ac = new AbortController();
  const p = log.wait({ timeout: 60, signal: ac.signal });
  ac.abort();
  assert.deepEqual(await p, { events: [], cursor: 0 });
  assert.equal(log.waiters.size, 0);
});

test('a bounded queue reports a gap for an old cursor', () => {
  const log = new EventLog({ max: 3 });
  for (let i = 0; i < 5; i++) log.append('newmail', { account: 'a', rule: 'r' });
  assert.deepEqual(log.queue.map((e) => e.seq), [3, 4, 5]);
  assert.deepEqual(gapInfo(1, log.queue, log.seq), { gap: true, oldest: 3, lost: 1 });
  assert.deepEqual(gapInfo(2, log.queue, log.seq), {});
  assert.deepEqual(gapInfo(0, [], 7), { gap: true, oldest: null, lost: 7 });
});

test('a persisted log resumes its cursor', async () => {
  const store = memoryStore();
  const one = new EventLog({ store });
  one.append('newmail', { account: 'a', rule: 'r' });
  one.append('wake', { account: 'a', rule: 'r' });
  const two = new EventLog({ store });
  assert.equal(two.cursor, 2);
  const r = await two.wait({ after: 1 });
  assert.deepEqual(r.events.map((e) => e.type), ['wake']);
});

test('events() iterates matches in order', async () => {
  const log = new EventLog();
  const ac = new AbortController();
  const seen = [];
  const done = (async () => { for await (const e of log.events({ after: 0, signal: ac.signal })) { seen.push(e.seq); if (seen.length === 2) ac.abort(); } })();
  log.append('newmail', { account: 'a', rule: 'r' });
  await new Promise((r) => setTimeout(r, 5));
  log.append('newmail', { account: 'a', rule: 'r' });
  await done;
  assert.deepEqual(seen, [1, 2]);
});

test('wait with an already-aborted signal resolves at once', async () => {
  const log = new EventLog();
  const ac = new AbortController();
  ac.abort();
  const r = await Promise.race([log.wait({ timeout: 60, signal: ac.signal }), new Promise((res) => setTimeout(() => res('hung'), 100))]);
  assert.deepEqual(r, { events: [], cursor: 0 });
  assert.equal(log.waiters.size, 0);
});

test('waits on a reused signal leave no abort listeners behind', async () => {
  const { getEventListeners } = await import('node:events');
  const log = new EventLog();
  const ac = new AbortController();
  const a = log.wait({ timeout: 60, signal: ac.signal });
  log.append('newmail', { account: 'a', rule: 'r' }); // settles by a match
  await a;
  await log.wait({ timeout: 0.01, signal: ac.signal }); // settles by timeout
  const c = log.wait({ timeout: 60, signal: ac.signal });
  log.close(); // settles by close
  await c;
  assert.equal(getEventListeners(ac.signal, 'abort').length, 0);
  assert.equal(log.waiters.size, 0);
});

test('events() reports a gap first, and ends when the log closes', async () => {
  const log = new EventLog({ max: 2 });
  for (let i = 0; i < 4; i++) log.append('newmail', { account: 'a', rule: 'r' });
  const seen = [];
  const done = (async () => { for await (const e of log.events({ after: 0 })) seen.push(e.gap ? `gap:${e.lost}` : e.seq); })();
  await new Promise((r) => setTimeout(r, 5));
  log.close();
  await done; // would hang without the closed flag
  assert.deepEqual(seen, ['gap:2', 3, 4]);
  assert.equal(log.closed, true);
  assert.deepEqual(await log.wait({ timeout: 60 }), { events: [], cursor: 4 }, 'a closed log answers at once');
});
