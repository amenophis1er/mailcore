import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMailcore, watchCalendar } from '../src/index.js';

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };

/** A mailcore whose clients and streams are fakes (no network). */
function fakeCore({ state, accounts = { work: { provider: 'ews', host: 'https://x', email: 'me@x', calendar: { watch: false } } } } = {}) {
  const saves = [];
  const mc = createMailcore({ accounts, credentials: { getPassword: async () => ({ password: 'x' }) }, state: state || { load: () => ({}), save: (o) => saves.push(o) } });
  const calls = { findInbox: 0, findEvents: 0, streamStarted: 0 };
  let inbox = async () => [{ id: 'work:1', subject: 's', isRead: false, received: '2026-10-25T00:00:00Z' }];
  mc.withClient = async (name, fn) => fn({
    findInbox: (o) => { calls.findInbox++; return inbox(o); },
    findEvents: async () => { calls.findEvents++; return []; },
    getMessage: async (id) => ({ id, body: '', bodyType: 'Text' })
  });
  let streamGate = null;
  mc.stream = async (name, hooks) => {
    calls.hooks = hooks;
    if (streamGate) await streamGate;
    return { start: () => { calls.streamStarted++; }, stop: () => {} };
  };
  return { mc, calls, saves, setInbox: (f) => { inbox = f; }, gateStream: (p) => { streamGate = p; } };
}

test('stop() during the first poll installs nothing afterwards', async () => {
  const { mc, calls, saves, setInbox } = fakeCore();
  const gate = deferred();
  setInbox(() => gate.promise.then(() => []));
  const w = await mc.watch({ cache: false });
  const started = w.start();
  await tick();
  w.stop();
  gate.resolve();
  await started;
  await tick(5);
  assert.equal(w.timers.length, 0, 'no poll interval');
  assert.equal(w.streams.length, 0, 'no stream');
  assert.equal(calls.streamStarted, 0);
  assert.equal(saves.length, 0, 'the stale poll saved no state');
});

test('a stream that connects after stop() is never started', async () => {
  const { mc, calls, gateStream } = fakeCore();
  const gate = deferred();
  gateStream(gate.promise);
  const w = await mc.watch({ cache: false });
  const started = w.start();
  await tick(5);
  assert.equal(w.timers.length, 1, 'the poll interval is on while running');
  w.stop();
  gate.resolve();
  await started;
  assert.equal(calls.streamStarted, 0);
  assert.equal(w.streams.length, 0);
  assert.equal(w.timers.length, 0);
});

test('a push or retry scheduled before stop() does not poll after it', async () => {
  const { mc, calls } = fakeCore();
  const w = await mc.watch({ cache: false });
  await w.start();
  assert.equal(calls.streamStarted, 1);
  const before = calls.findInbox;
  calls.hooks.onNewMail(); // schedules a check in 500 ms
  assert.equal(w.timeouts.size, 1);
  w.stop();
  assert.equal(w.timeouts.size, 0);
  await tick(600);
  assert.equal(calls.findInbox, before);
});

test('a state store that loads null is treated as empty', async () => {
  let saved = null;
  const { mc } = fakeCore({ state: { load: () => (saved ? structuredClone(saved) : null), save: (o) => { saved = o; } } });
  const w = await mc.watch({ cache: false, push: false });
  const failures = [];
  const baselines = [];
  w.on('failure', (f) => failures.push(f.error.message));
  w.on('baseline', (b) => baselines.push(b.account));
  await w.start();
  w.stop();
  assert.deepEqual(failures, []);
  assert.deepEqual(baselines, ['work']);
  assert.deepEqual(saved.seenIds, ['work:1']);
});

test('a calendar watcher stopped right after creation never runs', async () => {
  const { mc, calls } = fakeCore();
  const cw = watchCalendar(mc, { account: 'work' }); // queues start on the next tick
  cw.stop();
  await tick(5);
  assert.equal(calls.findEvents, 0);
});

test('a calendar refresh in flight at stop() emits nothing and schedules nothing', async () => {
  const { mc } = fakeCore();
  const gate = deferred();
  let n = 0;
  mc.withClient = async (name, fn) => fn({ findEvents: async () => { n++; await gate.promise; return [{ id: 'work:e', subject: 'x', start: '2026-10-26T09:00:00Z' }]; } });
  const cw = watchCalendar(mc, { account: 'work', start: false, snapshot: { load: () => ({ baselined: true, events: {}, fired: {} }), save: () => {} } });
  const changes = [];
  cw.on('changes', (c) => changes.push(c));
  cw.start();
  cw.refreshNow(); // a second request while the first runs: would queue a retry
  cw.stop();
  gate.resolve();
  await tick(1100);
  assert.deepEqual(changes, []);
  assert.equal(n, 1);
});
