import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeSubject, askedSomething, unquoted, snippet, groupThreads, looksBulk } from '../src/index.js';

test('normalizeSubject strips reply/forward prefixes in several languages', () => {
  assert.equal(normalizeSubject('RE: Fwd: TR:  Budget   2027'), 'budget 2027');
  assert.equal(normalizeSubject('AW: WG: Hallo'), 'hallo');
});

test('unquoted drops the quoted thread and signature', () => {
  const t = 'Can you send it?\n\nOn Tue, Oct 20, 2026 at 9:00 Bob wrote:\n> earlier';
  assert.equal(unquoted(t), 'Can you send it?');
  assert.equal(unquoted('Hi\n-- \nAnn'), 'Hi');
  assert.equal(unquoted('Merci\nDe : Paul <p@x.fr>\nold'), 'Merci');
});

test('askedSomething looks only above the quote', () => {
  assert.equal(askedSomething('Could you review this'), true);
  assert.equal(askedSomething('Merci de valider'), true);
  assert.equal(askedSomething('Thanks, done.\n\nOn Mon, Bob wrote:\n> can you do it?'), false);
});

test('snippet is one line, bounded', () => {
  assert.equal(snippet('a\n\nb  c', 200), 'a b c');
  assert.equal(snippet('x'.repeat(300), 10), 'x'.repeat(9) + '…');
});

test('looksBulk: header flag, sender patterns, unsubscribe footers', () => {
  assert.equal(looksBulk({ isBulk: true, fromEmail: 'ann@x.org' }), true);
  assert.equal(looksBulk({ fromEmail: 'no-reply@shop.example' }), true);
  assert.equal(looksBulk({ fromEmail: 'ann@news.example.com' }), true);
  assert.equal(looksBulk({ fromEmail: 'ann@x.org', bodyText: 'Click here to unsubscribe' }), true);
  assert.equal(looksBulk({ fromEmail: 'ann@x.org', bodyText: 'See you tomorrow' }), false);
});

test('groupThreads: conversation id, then the In-Reply-To chain, then the subject', () => {
  const m = (o) => ({ received: '2026-10-20T10:00:00Z', ...o });
  const msgs = [
    m({ id: '1', conversationId: 'C', subject: 'A' }),
    m({ id: '2', conversationId: 'C', subject: 'Re: A', received: '2026-10-21T10:00:00Z' }),
    m({ id: '3', messageId: '<r@x>', subject: 'Plan' }),
    m({ id: '4', messageId: '<s@x>', inReplyTo: '<r@x>', subject: 'Re: Plan', received: '2026-10-22T10:00:00Z' }),
    m({ id: '5', subject: 'Lunch' }),
    m({ id: '6', subject: 'RE: lunch', received: '2026-10-23T10:00:00Z' })
  ];
  const threads = [...groupThreads(msgs).values()].map((l) => l.map((x) => x.id));
  assert.deepEqual(threads.sort(), [['1', '2'], ['3', '4'], ['5', '6']]);
});

const at = (h) => new Date(Date.UTC(2026, 10, 10, h)).toISOString();

test('my answer to a mail older than the window, and the answer to mine: one thread', () => {
  // <bob1> is not here (older than the window); mine answers it, and Bob's answers mine
  const mine = { id: 's1', subject: 'Re: Contract', messageId: '<me2@x>', inReplyTo: '<bob1@x>', received: at(9), fromMe: true };
  const bob = { id: 'i1', subject: 'Re: Contract', messageId: '<bob3@x>', inReplyTo: '<me2@x>', received: at(11), fromMe: false };
  for (const order of [[bob, mine], [mine, bob]]) {
    const threads = [...groupThreads(order).values()];
    assert.equal(threads.length, 1);
    assert.deepEqual(threads[0].map((m) => m.id), ['s1', 'i1']); // oldest first: the last is Bob's, so nobody waits on Bob
  }
});

test('the server\'s own thread id wins; unrelated mail with the same subject stays apart only without one', () => {
  const a = { id: 'a', subject: 'Hello', conversationId: 'T1', received: at(1) };
  const b = { id: 'b', subject: 'Re: Hello', conversationId: 'T1', received: at(2) };
  const c = { id: 'c', subject: 'Hello', conversationId: 'T2', received: at(3) };
  const threads = [...groupThreads([a, b, c]).values()].map((l) => l.map((m) => m.id));
  assert.deepEqual(threads.sort(), [['a', 'b'], ['c']]);
});
