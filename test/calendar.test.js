import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseWhen, parseDuration, dayStart } from '../src/index.js';
import { diff, pick } from '../src/calendar-watch.js';

const base = new Date(2026, 9, 21, 10, 15); // Wednesday 21 Oct 2026, 10:15 local

test('parseWhen understands relative and natural forms', () => {
  assert.equal(parseWhen('now', base).getTime(), base.getTime());
  assert.equal(parseWhen('+2d', base).getTime(), base.getTime() + 2 * 86400e3);
  assert.equal(parseWhen('-3h', base).getTime(), base.getTime() - 3 * 3600e3);
  assert.deepEqual(parseWhen('14:00', base), new Date(2026, 9, 21, 14, 0));
  assert.deepEqual(parseWhen('tomorrow 9am', base), new Date(2026, 9, 22, 9, 0));
  assert.deepEqual(parseWhen('fri 9:30', base), new Date(2026, 9, 23, 9, 30));
  assert.deepEqual(parseWhen('wednesday', base), new Date(2026, 9, 28), 'the same weekday means next week');
  assert.deepEqual(parseWhen('2026-11-02', base), new Date(2026, 10, 2));
  assert.deepEqual(parseWhen('2026-11-02 14:30', base), new Date(2026, 10, 2, 14, 30));
  assert.equal(parseWhen('2026-11-02T14:30:00Z', base).toISOString(), '2026-11-02T14:30:00.000Z');
  assert.throws(() => parseWhen('someday', base), /cannot understand the date/);
});

test('parseDuration', () => {
  assert.equal(parseDuration('45'), 45);
  assert.equal(parseDuration('1h30m'), 90);
  assert.equal(parseDuration('2d'), 2880);
  assert.equal(parseDuration('', 30), 30);
  assert.throws(() => parseDuration('soon'), /cannot understand the duration/);
});

test('dayStart', () => {
  assert.deepEqual(dayStart(base, 1), new Date(2026, 9, 22));
});

test('calendar diff reports created, updated (with previous), cancelled, deleted', () => {
  const a = pick({ id: 'w:1', subject: 'Sync', start: '2026-10-22T09:00:00Z', end: '2026-10-22T09:30:00Z', location: 'A' });
  const b = pick({ id: 'w:2', subject: 'Review', start: '2026-10-22T10:00:00Z', end: '2026-10-22T11:00:00Z' });
  const c = pick({ id: 'w:3', subject: 'Gone', start: '2026-10-22T12:00:00Z', end: '2026-10-22T13:00:00Z' });
  const before = { [a.id]: a, [b.id]: b, [c.id]: c };
  const after = {
    [a.id]: { ...a, start: '2026-10-22T09:30:00Z' },
    [b.id]: { ...b, isCancelled: true },
    'w:4': pick({ id: 'w:4', subject: 'New', start: '2026-10-23T09:00:00Z', end: '2026-10-23T10:00:00Z', isMeeting: true })
  };
  const out = diff(before, after);
  assert.deepEqual(out.map((x) => [x.action, x.event.id]), [['updated', 'w:1'], ['cancelled', 'w:2'], ['created', 'w:4'], ['deleted', 'w:3']]);
  assert.deepEqual(out[0].previous, { start: '2026-10-22T09:00:00Z', end: '2026-10-22T09:30:00Z', location: 'A', subject: 'Sync' });
});
