import test from 'node:test';
import assert from 'node:assert/strict';
import { GoogleCalendar } from '../src/cal-google.js';

function calendar(cur) {
  const cal = new GoogleCalendar({ account: 'g', email: 'me@example.com', timeZone: 'Europe/Paris', accessToken: async () => 'tok' });
  const sent = [];
  cal.getEvent = async () => cur;
  cal.send = async (req) => { sent.push(req); return { status: 200, data: {}, etag: '"2"' }; };
  return { cal, sent };
}

test('an all-day event made timed: the PATCH nulls the date, or Google keeps both and refuses the start', async () => {
  const { cal, sent } = calendar({ start: '2026-11-24T23:00:00.000Z', end: '2026-11-25T23:00:00.000Z', allDay: true });
  await cal.updateEvent({ id: cal.eventId('primary', 'abc'), start: '2026-11-25T09:00:00.000Z', end: '2026-11-25T10:00:00.000Z', allDay: false });
  const { start, end } = sent[0].body;
  assert.deepEqual(start, { dateTime: '2026-11-25T09:00:00.000Z', timeZone: 'Europe/Paris', date: null });
  assert.deepEqual(end, { dateTime: '2026-11-25T10:00:00.000Z', timeZone: 'Europe/Paris', date: null });
});

test('a timed event made all-day: the PATCH nulls the time and its zone', async () => {
  const { cal, sent } = calendar({ start: '2026-11-25T09:00:00.000Z', end: '2026-11-25T10:00:00.000Z', allDay: false });
  await cal.updateEvent({ id: cal.eventId('primary', 'abc'), allDay: true });
  const { start, end } = sent[0].body;
  assert.deepEqual(start, { date: '2026-11-25', dateTime: null, timeZone: null });
  assert.deepEqual(end, { date: '2026-11-26', dateTime: null, timeZone: null });
});

test('a new event sends no nulls', () => {
  const { cal } = calendar(null);
  assert.deepEqual(cal.time({ start: '2026-11-25T09:00:00.000Z', end: '2026-11-25T10:00:00.000Z', allDay: false }).start, { dateTime: '2026-11-25T09:00:00.000Z', timeZone: 'Europe/Paris' });
});
