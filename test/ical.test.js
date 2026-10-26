import { test } from 'node:test';
import assert from 'node:assert/strict';
import { occurrences, readEvent, buildEvent, editEvent, uidsOf, unfold, foldLine, escapeText, unescapeText, parseFreeBusy, zonedTime } from '../src/ical.js';

const ICS = [
  'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:test',
  'BEGIN:VEVENT', 'UID:u1', 'DTSTAMP:20261001T000000Z',
  'DTSTART:20261026T090000Z', 'DTEND:20261026T100000Z', 'RRULE:FREQ=WEEKLY;COUNT=3',
  'SUMMARY:Standup', 'ORGANIZER;CN=Al:mailto:al@x.org', 'ATTENDEE;PARTSTAT=ACCEPTED;CN=Me:mailto:me@x.org',
  'END:VEVENT', 'END:VCALENDAR', ''
].join('\r\n');

test('occurrences expands a weekly rule inside the window', () => {
  const occ = occurrences(ICS, { from: new Date('2026-10-25T00:00:00Z'), to: new Date('2026-11-05T00:00:00Z'), timeZone: 'UTC', self: 'me@x.org', calendarName: 'Cal' });
  assert.deepEqual(occ.map((e) => e.start), ['2026-10-26T09:00:00.000Z', '2026-11-02T09:00:00.000Z']);
  const e = occ[0];
  assert.equal(e.subject, 'Standup');
  assert.equal(e.organizerEmail, 'al@x.org');
  assert.equal(e.myResponse, 'Accept');
  assert.equal(e.isMeeting, true);
  assert.equal(e.isRecurring, true);
  assert.equal(e.calendarName, 'Cal');
});

test('readEvent reads the master with its rule', () => {
  const ev = readEvent(ICS, 'u1', { timeZone: 'UTC', self: 'me@x.org', calendarName: 'Cal' });
  assert.equal(ev.subject, 'Standup');
  assert.equal(ev.rule, 'FREQ=WEEKLY;COUNT=3');
  assert.equal(ev.start, '2026-10-26T09:00:00.000Z');
});

test('buildEvent writes escaped text and reads back', () => {
  const now = new Date('2026-10-20T08:00:00Z');
  const data = buildEvent({ uid: 'u2', subject: 'Lunch, with; friends', time: { start: new Date('2026-10-27T12:00:00Z'), end: new Date('2026-10-27T13:00:00Z'), tz: 'UTC' }, location: 'Cafe', organizer: { email: 'me@x.org' }, now });
  assert.match(data, /SUMMARY:Lunch\\, with\\; friends/);
  assert.match(data, /DTSTAMP:20261020T080000Z/);
  assert.deepEqual(uidsOf(data), ['u2']);
  const ev = readEvent(data, 'u2', { timeZone: 'UTC', self: 'me@x.org' });
  assert.equal(ev.subject, 'Lunch, with; friends');
  assert.equal(ev.location, 'Cafe');
});

test('editEvent changes only what it is given', () => {
  const edited = editEvent(ICS, 'u1', { subject: 'Daily' }, { now: new Date('2026-10-21T00:00:00Z') });
  assert.match(edited, /SUMMARY:Daily/);
  assert.match(edited, /RRULE:FREQ=WEEKLY;COUNT=3/);
  assert.match(edited, /ATTENDEE;PARTSTAT=ACCEPTED/);
});

test('folding and text escapes round-trip', () => {
  const long = 'DESCRIPTION:' + 'x'.repeat(200);
  const folded = foldLine(long);
  assert.ok(folded.split('\r\n').every((l) => Buffer.byteLength(l) <= 75));
  assert.deepEqual(unfold(folded + '\r\n'), [long]);
  assert.equal(unescapeText(escapeText('a,b;c\\d\ne')), 'a,b;c\\d\ne');
});

test('zonedTime turns a local clock in a zone into an instant', () => {
  assert.equal(zonedTime('2026-07-01', '09:00', 'Europe/Paris').toISOString(), '2026-07-01T07:00:00.000Z');
  assert.equal(zonedTime('2026-12-01', '09:00', 'Europe/Paris').toISOString(), '2026-12-01T08:00:00.000Z');
});

test('parseFreeBusy reads a VFREEBUSY reply', () => {
  const data = ['BEGIN:VCALENDAR', 'METHOD:REPLY', 'BEGIN:VFREEBUSY', 'ATTENDEE:mailto:bob@x.org',
    'FREEBUSY;FBTYPE=BUSY:20261026T090000Z/20261026T100000Z', 'END:VFREEBUSY', 'END:VCALENDAR', ''].join('\r\n');
  const r = parseFreeBusy(data);
  assert.ok(r);
  assert.match(JSON.stringify(r), /2026-10-26T09:00:00/);
});
