// iCalendar for the CalDAV backend: reading objects into MailWatcher events
// (recurrences expanded by node-ical, attendees and the owner's response
// read from ATTENDEE lines), and writing them — a new event as a whole
// VCALENDAR, a change made line by line so whatever we do not touch (alarms,
// a rule's exceptions, a client's own properties) stays as it was.
//
// Ported from Amen's buddi calendar plugin (Apache-2.0) and extended with
// scheduling properties (ORGANIZER, ATTENDEE, PARTSTAT, STATUS).

import ical from 'node-ical';

export const PRODID = '-//mailcore//calendar//EN';

// --- time helpers -------------------------------------------------------------

export function dateIn(d, tz) {
  const p = parts(d, tz);
  return `${p.year}-${p.month}-${p.day}`;
}
export function timeIn(d, tz) {
  const p = parts(d, tz);
  return `${p.hour}:${p.minute}`;
}
function parts(d, tz) {
  return Object.fromEntries(
    new Intl.DateTimeFormat('en-GB', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' })
      .formatToParts(d).map((x) => [x.type, x.value])
  );
}
/** The instant that reads `date clock` in `tz` (first occurrence on a repeated hour). */
export function zonedTime(date, clock, tz) {
  const [y, m, d] = date.split('-').map(Number);
  const [hh, mm] = clock.split(':').map(Number);
  const guess = Date.UTC(y, m - 1, d, hh, mm);
  const off = offsetMinutes(new Date(guess), tz);
  const candidates = [-off, -offsetMinutes(new Date(guess - off * 60e3), tz), -offsetMinutes(new Date(guess - (off + 60) * 60e3), tz), -offsetMinutes(new Date(guess - (off - 60) * 60e3), tz)]
    .map((o) => new Date(guess + o * 60e3))
    .filter((at) => dateIn(at, tz) === date && timeIn(at, tz) === clock);
  if (!candidates.length) { // a skipped hour: shifted forward past the gap (02:30 on the spring-forward night → 03:30)
    const offs = [off, offsetMinutes(new Date(guess - off * 60e3), tz), offsetMinutes(new Date(guess - (off + 60) * 60e3), tz), offsetMinutes(new Date(guess - (off - 60) * 60e3), tz)];
    return new Date(guess - Math.min(...offs) * 60e3);
  }
  return candidates.reduce((a, b) => (a <= b ? a : b)); // a repeated hour: its first occurrence
}
export function addDays(date, days) {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}
export function knownZone(tz) {
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch { return false; }
}
const pad = (n, w = 2) => String(n).padStart(w, '0');
export function localStamp(d, tz) {
  const p = parts(d, tz);
  return `${p.year}${p.month}${p.day}T${p.hour}${p.minute}${p.second}`;
}
export function utcStamp(d) {
  return new Date(d).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}
const dateStamp = (date) => date.replace(/-/g, '');
export function offsetMinutes(d, tz) {
  const local = localStamp(d, tz);
  const asUtc = Date.UTC(Number(local.slice(0, 4)), Number(local.slice(4, 6)) - 1, Number(local.slice(6, 8)), Number(local.slice(9, 11)), Number(local.slice(11, 13)), Number(local.slice(13, 15)));
  return Math.round((asUtc - Math.floor(d.getTime() / 1000) * 1000) / 60e3);
}
const offsetText = (minutes) => `${minutes < 0 ? '-' : '+'}${pad(Math.floor(Math.abs(minutes) / 60))}${pad(Math.abs(minutes) % 60)}`;

/** A VTIMEZONE from the zone's real transitions, the year before the event to the year after. */
export function vtimezone(tz, around) {
  const year = around.getUTCFullYear();
  const from = Date.UTC(year - 1, 0, 1);
  const to = Date.UTC(year + 2, 0, 1);
  const transitions = [];
  const DAY = 86400e3;
  let prev = offsetMinutes(new Date(from), tz);
  for (let t = from + DAY; t <= to; t += DAY) {
    const now = offsetMinutes(new Date(t), tz);
    if (now !== prev) {
      let lo = t - DAY;
      let hi = t;
      while (hi - lo > 60e3) {
        const mid = lo + Math.floor((hi - lo) / 120e3) * 60e3;
        if (offsetMinutes(new Date(mid), tz) === prev) lo = mid; else hi = mid;
      }
      transitions.push({ at: hi, before: prev, after: now });
      prev = now;
    }
  }
  const lines = ['BEGIN:VTIMEZONE', `TZID:${tz}`];
  if (!transitions.length) {
    const off = offsetText(prev);
    lines.push('BEGIN:STANDARD', 'DTSTART:19700101T000000', `TZOFFSETFROM:${off}`, `TZOFFSETTO:${off}`, 'END:STANDARD');
  } else {
    for (const tr of transitions) {
      const kind = tr.after > tr.before ? 'DAYLIGHT' : 'STANDARD';
      const wall = new Date(tr.at + tr.before * 60e3).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, '');
      lines.push(`BEGIN:${kind}`, `DTSTART:${wall}`, `TZOFFSETFROM:${offsetText(tr.before)}`, `TZOFFSETTO:${offsetText(tr.after)}`, `END:${kind}`);
    }
  }
  lines.push('END:VTIMEZONE');
  return lines;
}

// --- lines --------------------------------------------------------------------

export function escapeText(text) {
  return String(text ?? '').replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r\n|\r|\n/g, '\\n');
}
export function unescapeText(text) {
  return String(text ?? '').replace(/\\n/gi, '\n').replace(/\\([\\;,])/g, '$1');
}
export function foldLine(line) {
  const out = [];
  let current = '';
  let bytes = 0;
  for (const ch of line) {
    const size = Buffer.byteLength(ch);
    const limit = out.length === 0 ? 75 : 74;
    if (bytes + size > limit) { out.push(current); current = ''; bytes = 0; }
    current += ch;
    bytes += size;
  }
  out.push(current);
  return out.join('\r\n ');
}
export function unfold(text) {
  return String(text).replace(/\r?\n[ \t]/g, '').split(/\r?\n/).filter((l) => l.length > 0);
}
export function propName(line) {
  const m = /^([A-Za-z0-9-]+)[;:]/.exec(line);
  return m ? m[1].toUpperCase() : '';
}
/** `NAME;P1=a;P2="b c":value` → { params: {P1:'a', P2:'b c'}, value }. */
export function splitLine(line) {
  const name = propName(line);
  let i = name.length;
  const params = {}; // decoded (quotes removed, list items joined by ',')
  const raw = {};    // exactly as written, for re-serialisation
  while (i < line.length && line[i] === ';') {
    const eq = line.indexOf('=', i);
    if (eq < 0) break;
    const key = line.slice(i + 1, eq).toUpperCase();
    let j = eq + 1;
    const items = [];
    for (;;) { // a value is a list of items, each quoted or bare, separated by commas (RFC 5545 §3.2)
      if (line[j] === '"') { const q = line.indexOf('"', j + 1); items.push(line.slice(j + 1, q < 0 ? undefined : q)); j = q < 0 ? line.length : q + 1; }
      else { const k = j; while (j < line.length && line[j] !== ';' && line[j] !== ':' && line[j] !== ',') j++; items.push(line.slice(k, j)); }
      if (line[j] === ',') { j++; continue; }
      break;
    }
    params[key] = items.join(',');
    raw[key] = line.slice(eq + 1, j);
    i = j;
  }
  return { name, params, raw, value: line[i] === ':' ? line.slice(i + 1) : '' };
}
const join = (lines) => `${lines.map(foldLine).join('\r\n')}\r\n`;
/** The line with one parameter set (replacing it when present). */
export function withoutParam(line, key) {
  const { name, raw, value } = splitLine(line);
  const p = { ...raw };
  delete p[key.toUpperCase()];
  return `${name}${Object.entries(p).map(([k, v]) => `;${k}=${v}`).join('')}:${value}`;
}
export function withParam(line, key, val) {
  const { name, raw, value } = splitLine(line);
  const p = { ...raw, [key.toUpperCase()]: /[;:,]/.test(val) && !/^".*"$/.test(val) ? quote(val) : val };
  return `${name}${Object.entries(p).map(([k, v]) => `;${k}=${v}`).join('')}:${value}`;
}

/** The VEVENT blocks of an object: the master (no RECURRENCE-ID) and the overrides, for one UID. */
function veventBlocks(lines, uid) {
  const blocks = [];
  let begin = -1;
  let depth = 0;
  lines.forEach((line, i) => {
    const upper = line.toUpperCase();
    if (upper === 'BEGIN:VEVENT') { begin = i; depth = 1; }
    else if (begin >= 0 && upper.startsWith('BEGIN:')) depth++;
    else if (begin >= 0 && upper.startsWith('END:')) {
      depth--;
      if (upper === 'END:VEVENT' && depth === 0) {
        const own = topLevel(lines.slice(begin + 1, i));
        const u = (own.find((l) => propName(l) === 'UID') || '').replace(/^UID[^:]*:/i, '').trim();
        blocks.push({ begin, end: i, uid: u, override: own.some((l) => propName(l) === 'RECURRENCE-ID') });
        begin = -1;
      }
    }
  });
  const mine = uid ? blocks.filter((b) => b.uid === uid) : blocks;
  return { master: mine.find((b) => !b.override), overrides: mine.filter((b) => b.override), all: blocks };
}
function topLevel(inner) {
  const out = [];
  let depth = 0;
  for (const line of inner) {
    const upper = line.toUpperCase();
    if (upper.startsWith('BEGIN:')) depth++;
    else if (upper.startsWith('END:')) depth--;
    else if (depth === 0) out.push(line);
  }
  return out;
}

// --- reading ------------------------------------------------------------------

const mailto = (v) => String(v || '').replace(/^mailto:/i, '').trim().toLowerCase();
const PARTSTAT_TO_RESPONSE = { ACCEPTED: 'Accept', TENTATIVE: 'Tentative', DECLINED: 'Decline', 'NEEDS-ACTION': 'NoResponseReceived', DELEGATED: 'Delegated' };

/** ORGANIZER and ATTENDEE lines of a VEVENT block → { organizer, attendees }. */
export function scheduling(own) {
  let organizer = null;
  const attendees = [];
  for (const line of own) {
    const { name, params, value } = splitLine(line);
    if (name === 'ORGANIZER') organizer = { name: params.CN || '', email: mailto(value) };
    else if (name === 'ATTENDEE') {
      const role = params.ROLE === 'OPT-PARTICIPANT' ? 'optional' : params.CUTYPE === 'RESOURCE' || params.CUTYPE === 'ROOM' ? 'resource' : 'required';
      attendees.push({ name: params.CN || '', email: mailto(value), role, response: PARTSTAT_TO_RESPONSE[(params.PARTSTAT || 'NEEDS-ACTION').toUpperCase()] || 'Unknown', rsvp: /true/i.test(params.RSVP || '') });
    }
  }
  return { organizer, attendees };
}

const textOf = (v) => { const s = typeof v === 'string' ? v : v && typeof v === 'object' && 'val' in v ? v.val : ''; return String(s ?? '').trim(); };
function localDate(d) { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }

/**
 * Every occurrence of the VEVENTs in `data` overlapping [from, to), as
 * MailWatcher events (without ids — the caller adds them). `self` is the
 * account's address, for myResponse.
 */
export function occurrences(data, { from, to, timeZone, self, calendarName }) {
  const lines = unfold(data);
  const parsed = ical.sync.parseICS(data);
  const events = Object.values(parsed).filter((c) => c && c.type === 'VEVENT');
  const out = [];
  const wideFrom = new Date(from.getTime() - 86400e3);
  const wideTo = new Date(to.getTime() + 86400e3);
  for (const event of events) {
    if (!(event.start instanceof Date)) continue;
    if (event.recurrenceid && events.some((e) => e !== event && e.uid === event.uid && e.rrule)) continue; // handled by the master's expansion
    let instances;
    try { instances = ical.expandRecurringEvent(event, { from: wideFrom, to: wideTo, expandOngoing: true }); } catch { continue; }
    const uid = String(event.uid || '');
    const { master, overrides } = veventBlocks(lines, uid);
    const own = master ? topLevel(lines.slice(master.begin + 1, master.end)) : [];
    const sched = scheduling(own);
    // an overridden occurrence (RECURRENCE-ID) carries its own ATTENDEE/STATUS lines
    const overrideSched = new Map();
    for (const b of overrides) {
      const blockOwn = topLevel(lines.slice(b.begin + 1, b.end));
      const rid = blockOwn.find((l) => propName(l) === 'RECURRENCE-ID');
      if (!rid) continue;
      try {
        const parsedBlock = Object.values(ical.sync.parseICS(['BEGIN:VCALENDAR', ...lines.slice(0, lines.findIndex((l) => l.toUpperCase() === 'BEGIN:VEVENT')).filter((l) => !/^(BEGIN|END):VCALENDAR$/i.test(l)), ...lines.slice(b.begin, b.end + 1), 'END:VCALENDAR'].join('\r\n'))).find((c) => c && c.type === 'VEVENT');
        if (parsedBlock?.recurrenceid instanceof Date) overrideSched.set(parsedBlock.recurrenceid.getTime(), scheduling(blockOwn));
      } catch {}
    }
    for (const instance of instances) {
      const source = instance.event || event;
      const instSched = source.recurrenceid instanceof Date ? overrideSched.get(source.recurrenceid.getTime()) || sched : sched;
      const allDay = instance.isFullDay === true || source.datetype === 'date';
      let start, end;
      if (allDay) {
        const startDate = localDate(instance.start);
        const lastExclusive = instance.end instanceof Date ? localDate(instance.end) : addDays(startDate, 1);
        const endDate = lastExclusive > startDate ? lastExclusive : addDays(startDate, 1);
        start = zonedTime(startDate, '00:00', timeZone);
        end = zonedTime(endDate, '00:00', timeZone);
      } else {
        start = instance.start;
        end = instance.end instanceof Date && instance.end > start ? instance.end : start;
      }
      const overlaps = end > from && start < to;
      const instant = end.getTime() === start.getTime() && start >= from && start < to;
      if (!overlaps && !instant) continue;
      let occurrence = null;
      if (event.rrule) {
        const raw = source.recurrenceid instanceof Date ? source.recurrenceid : instance.start;
        occurrence = allDay ? new Date(`${localDate(raw)}T00:00:00Z`) : raw; // all-day: midnight UTC of the date (zone-independent id)
      }
      out.push(toEvent(source, { start, end, allDay, uid, sched: instSched, self, recurring: !!event.rrule, occurrence, calendarName }));
    }
  }
  return out.sort((a, b) => new Date(a.start) - new Date(b.start));
}

function toEvent(source, { start, end, allDay, uid, sched, self, recurring, occurrence, calendarName }) {
  const me = self ? sched.attendees.find((a) => a.email === String(self).toLowerCase()) : null;
  const isOrganizer = !!(sched.organizer && self && sched.organizer.email === String(self).toLowerCase());
  const isMeeting = sched.attendees.length > 0;
  const status = String(source.status || '').toUpperCase();
  const alarm = Array.isArray(source.alarms) ? source.alarms.find((a) => a && typeof a.trigger !== 'undefined') : null;
  return {
    uid,
    changeKey: '',
    subject: textOf(source.summary),
    start: start.toISOString(),
    end: end.toISOString(),
    allDay,
    location: textOf(source.location),
    organizerName: sched.organizer?.name || '',
    organizerEmail: sched.organizer?.email || '',
    showAs: String(source.transparency || '').toUpperCase() === 'TRANSPARENT' ? 'Free' : 'Busy',
    myResponse: isOrganizer ? 'Organizer' : me ? me.response : isMeeting ? 'Unknown' : 'Unknown',
    isMeeting,
    isCancelled: status === 'CANCELLED',
    isRecurring: recurring,
    type: recurring ? 'Occurrence' : 'Single',
    private: /^(PRIVATE|CONFIDENTIAL)$/i.test(String(source.class || '')),
    hasAttachments: false,
    reminderMinutes: alarmMinutes(alarm),
    modified: source.lastmodified instanceof Date ? source.lastmodified.toISOString() : '',
    occurrence: occurrence ? occurrence.toISOString() : null,
    calendarName: calendarName || '',
    attendees: sched.attendees.map(({ rsvp, ...a }) => a),
    body: unescapeText(textOf(source.description)).replace(/\r\n?/g, '\n'),
    categories: Array.isArray(source.categories) ? source.categories.map(String) : [],
    created: source.created instanceof Date ? source.created.toISOString() : '',
    responseRequested: sched.attendees.some((a) => a.rsvp)
  };
}

function alarmMinutes(alarm) {
  if (!alarm) return null;
  const t = alarm.trigger;
  if (typeof t === 'number') return Math.round(-t / 60);
  const m = /^-?P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?/i.exec(String(t?.val ?? t ?? ''));
  if (!m) return null;
  return (Number(m[1] || 0) * 1440) + (Number(m[2] || 0) * 60) + Number(m[3] || 0);
}

/** The master event of `uid` in an object, as one MailWatcher event (full). */
export function readEvent(data, uid, { timeZone, self, calendarName }) {
  const lines = unfold(data);
  const { master, overrides } = veventBlocks(lines, uid);
  if (!master) throw new Error('that event is not in the object the calendar returned');
  const parsed = Object.values(ical.sync.parseICS(data)).find((c) => c && c.type === 'VEVENT' && c.uid === uid && !c.recurrenceid);
  if (!parsed || !(parsed.start instanceof Date)) throw new Error('cannot read that event\'s time');
  const own = topLevel(lines.slice(master.begin + 1, master.end));
  const allDay = parsed.datetype === 'date';
  let start = parsed.start;
  let end = parsed.end instanceof Date ? parsed.end : start;
  if (allDay) {
    const startDate = localDate(parsed.start);
    let endDate = parsed.end instanceof Date ? localDate(parsed.end) : addDays(startDate, 1);
    if (endDate <= startDate) endDate = addDays(startDate, 1);
    start = zonedTime(startDate, '00:00', timeZone);
    end = zonedTime(endDate, '00:00', timeZone);
  }
  const tzid = /;TZID=("?)([^;:"]+)\1/i.exec(own.find((l) => propName(l) === 'DTSTART') || '')?.[2];
  const ev = toEvent(parsed, { start, end, allDay, uid, sched: scheduling(own), self, recurring: !!parsed.rrule, occurrence: null, calendarName });
  const rule = own.find((l) => propName(l) === 'RRULE');
  return { ...ev, tz: tzid && knownZone(tzid) ? tzid : undefined, rule: rule ? rule.slice(rule.indexOf(':') + 1).trim() : undefined, hasOverrides: overrides.length > 0, sequence: Number((own.find((l) => propName(l) === 'SEQUENCE') || '').split(':')[1]) || 0 };
}

export function uidsOf(data) {
  return [...String(data).replace(/\r?\n[ \t]/g, '').matchAll(/^UID(?:;[^:]*)?:(.*)$/gim)].map((m) => m[1].trim());
}

// --- writing ------------------------------------------------------------------

function timeLines({ allDay, start, end, tz }) {
  if (allDay) return [`DTSTART;VALUE=DATE:${dateStamp(dateIn(start, tz))}`, `DTEND;VALUE=DATE:${dateStamp(dateIn(end, tz))}`];
  if (tz === 'UTC' || tz === 'Etc/UTC') return [`DTSTART:${utcStamp(start)}`, `DTEND:${utcStamp(end)}`];
  return [`DTSTART;TZID=${tz}:${localStamp(start, tz)}`, `DTEND;TZID=${tz}:${localStamp(end, tz)}`];
}
const needsZone = (t) => !t.allDay && t.tz !== 'UTC' && t.tz !== 'Etc/UTC';

function attendeeLines({ organizer, attendees = [], optionalAttendees = [], schedule = true }) {
  const lines = [];
  if (!attendees.length && !optionalAttendees.length) return lines;
  const agent = schedule ? '' : ';SCHEDULE-AGENT=CLIENT';
  if (organizer) lines.push(`ORGANIZER${organizer.name ? `;CN=${quote(organizer.name)}` : ''}:mailto:${organizer.email}`);
  for (const a of attendees) lines.push(`ATTENDEE;CUTYPE=INDIVIDUAL;ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=TRUE${agent}${a.name ? `;CN=${quote(a.name)}` : ''}:mailto:${a.email}`);
  for (const a of optionalAttendees) lines.push(`ATTENDEE;CUTYPE=INDIVIDUAL;ROLE=OPT-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=TRUE${agent}${a.name ? `;CN=${quote(a.name)}` : ''}:mailto:${a.email}`);
  return lines;
}
const quote = (s) => `"${String(s).replace(/"/g, '')}"`;

/**
 * A new event as a whole calendar object. time: { allDay, start, end, tz }
 * (Dates; all-day uses the dates of start/end in tz, end exclusive).
 */
export function buildEvent({ uid, subject, time, location, body, organizer, attendees = [], optionalAttendees = [], reminderMinutes, showAs, schedule = true, now = new Date() }) {
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', `PRODID:${PRODID}`, 'CALSCALE:GREGORIAN'];
  if (needsZone(time)) lines.push(...vtimezone(time.tz, time.start));
  lines.push('BEGIN:VEVENT', `UID:${uid}`, `DTSTAMP:${utcStamp(now)}`, `CREATED:${utcStamp(now)}`, `LAST-MODIFIED:${utcStamp(now)}`, 'SEQUENCE:0', ...timeLines(time), `SUMMARY:${escapeText(subject || '')}`);
  if (location) lines.push(`LOCATION:${escapeText(location)}`);
  if (body) lines.push(`DESCRIPTION:${escapeText(body)}`);
  if (showAs && /free/i.test(showAs)) lines.push('TRANSP:TRANSPARENT');
  lines.push(...attendeeLines({ organizer, attendees, optionalAttendees, schedule }));
  if (reminderMinutes != null && reminderMinutes >= 0) lines.push('BEGIN:VALARM', 'ACTION:DISPLAY', 'DESCRIPTION:Reminder', `TRIGGER:-PT${Math.round(reminderMinutes)}M`, 'END:VALARM');
  lines.push('END:VEVENT', 'END:VCALENDAR');
  return join(lines);
}

/**
 * The object with changes applied to the master VEVENT of `uid`: named
 * properties replaced, DTSTAMP/LAST-MODIFIED/SEQUENCE moved on, a VTIMEZONE
 * added when a new zone appears, every other line kept.
 * changes: { subject, location (null removes), body (null removes), time, attendees (full list), reminderMinutes, showAs, status, partstat: { email, value } }
 */
export function editEvent(data, uid, changes, { now = new Date(), schedule = true } = {}) {
  const lines = unfold(data);
  const { master } = veventBlocks(lines, uid);
  if (!master) throw new Error('that event is not in the object the calendar returned');
  const replace = new Map();
  if (changes.subject !== undefined) replace.set('SUMMARY', [`SUMMARY:${escapeText(changes.subject)}`]);
  if (changes.location !== undefined) replace.set('LOCATION', changes.location ? [`LOCATION:${escapeText(changes.location)}`] : null);
  if (changes.body !== undefined) replace.set('DESCRIPTION', changes.body ? [`DESCRIPTION:${escapeText(changes.body)}`] : null);
  if (changes.showAs !== undefined) replace.set('TRANSP', /free/i.test(changes.showAs) ? ['TRANSP:TRANSPARENT'] : null);
  if (changes.status !== undefined) replace.set('STATUS', changes.status ? [`STATUS:${String(changes.status).toUpperCase()}`] : null);
  if (changes.time) {
    const [start, end] = timeLines(changes.time);
    replace.set('DTSTART', [start]); replace.set('DTEND', [end]); replace.set('DURATION', null);
  }
  if (changes.attendees) {
    const al = attendeeLines({ organizer: changes.organizer, attendees: changes.attendees, optionalAttendees: changes.optionalAttendees || [], schedule });
    replace.set('ATTENDEE', al.filter((l) => propName(l) === 'ATTENDEE'));
    if (changes.organizer) replace.set('ORGANIZER', al.filter((l) => propName(l) === 'ORGANIZER'));
  }
  const inner = lines.slice(master.begin + 1, master.end);
  const kept = [];
  let depth = 0;
  const seen = new Set();
  let sequence = -1;
  let alarmDone = changes.reminderMinutes === undefined;
  for (let k = 0; k < inner.length; k++) {
    const line = inner[k];
    const upper = line.toUpperCase();
    if (upper === 'BEGIN:VALARM' && !alarmDone) { // drop every alarm; one new alarm is added below
      while (k < inner.length && inner[k].toUpperCase() !== 'END:VALARM') k++;
      continue;
    }
    if (upper.startsWith('BEGIN:')) depth++;
    if (depth > 0) { kept.push(line); if (upper.startsWith('END:')) depth--; continue; }
    const name = propName(line);
    if (name === 'SEQUENCE') { sequence = Number(line.slice(line.indexOf(':') + 1)) || 0; continue; }
    if (name === 'DTSTAMP' || name === 'LAST-MODIFIED') continue;
    if (changes.partstat && name === 'ATTENDEE') {
      const { params, value } = splitLine(line);
      if (mailto(value) === String(changes.partstat.email).toLowerCase()) {
        kept.push(withParam(withParam(line, 'PARTSTAT', changes.partstat.value), 'RSVP', 'FALSE'));
        continue;
      }
    }
    // a reply (RFC 6638 §3.2.2.3): SCHEDULE-AGENT=CLIENT on the ORGANIZER keeps it to ourselves; a notifying reply clears a leftover one
    if (changes.partstat && name === 'ORGANIZER') { kept.push(changes.partstat.scheduleAgent ? withParam(line, 'SCHEDULE-AGENT', changes.partstat.scheduleAgent) : withoutParam(line, 'SCHEDULE-AGENT')); continue; }
    // an organizer's edit (RFC 6638 §3.2.1): silent → SCHEDULE-AGENT=CLIENT on every attendee; notifying → the parameter goes (server scheduling again)
    if (!changes.partstat && name === 'ATTENDEE' && !replace.has('ATTENDEE')) { kept.push(schedule ? withoutParam(line, 'SCHEDULE-AGENT') : withParam(line, 'SCHEDULE-AGENT', 'CLIENT')); continue; }
    if (replace.has(name)) { if (!seen.has(name)) kept.push(...(replace.get(name) || [])); seen.add(name); continue; }
    kept.push(line);
  }
  const extra = [];
  for (const [name, value] of replace) if (!seen.has(name) && value) extra.push(...value);
  if (!alarmDone && changes.reminderMinutes != null && changes.reminderMinutes >= 0) extra.push('BEGIN:VALARM', 'ACTION:DISPLAY', 'DESCRIPTION:Reminder', `TRIGGER:-PT${Math.round(changes.reminderMinutes)}M`, 'END:VALARM');
  const uidAt = Math.max(0, kept.findIndex((l) => propName(l) === 'UID'));
  const bump = changes.partstat ? 0 : 1; // a reply does not move the organizer's sequence
  kept.splice(uidAt + 1, 0, `DTSTAMP:${utcStamp(now)}`, `LAST-MODIFIED:${utcStamp(now)}`, `SEQUENCE:${Math.max(0, sequence) + bump}`);
  // new properties go after the last property, before any sub-component (RFC 5545: eventc = eventprop *alarmc)
  const firstSub = kept.findIndex((l) => l.toUpperCase().startsWith('BEGIN:'));
  kept.splice(firstSub < 0 ? kept.length : firstSub, 0, ...extra);
  let out = applySchedulingAcross([...lines.slice(0, master.begin + 1), ...kept, ...lines.slice(master.end)], uid, { schedule, partstat: changes.partstat });
  if (changes.time && needsZone(changes.time)) {
    const tz = changes.time.tz;
    const has = out.some((l) => propName(l) === 'TZID' && l.slice(l.indexOf(':') + 1).trim() === tz);
    if (!has) { const at = out.findIndex((l) => l.toUpperCase() === 'BEGIN:VEVENT'); out.splice(at, 0, ...vtimezone(tz, changes.time.start)); }
  }
  return join(out);
}

/** A VFREEBUSY request object for a scheduling outbox (RFC 6638 §5). */
export function buildFreeBusyRequest({ uid, organizer, attendees, start, end, now = new Date() }) {
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', `PRODID:${PRODID}`, 'METHOD:REQUEST', 'BEGIN:VFREEBUSY', `UID:${uid}`, `DTSTAMP:${utcStamp(now)}`, `DTSTART:${utcStamp(start)}`, `DTEND:${utcStamp(end)}`, `ORGANIZER:mailto:${organizer}`];
  for (const a of attendees) lines.push(`ATTENDEE:mailto:${a}`);
  lines.push('END:VFREEBUSY', 'END:VCALENDAR');
  return join(lines);
}

/** FREEBUSY periods of a VFREEBUSY reply → [{ start, end, status }]. */
export function parseFreeBusy(data) {
  const out = [];
  for (const line of unfold(data)) {
    if (propName(line) !== 'FREEBUSY') continue;
    const { params, value } = splitLine(line);
    const type = (params.FBTYPE || 'BUSY').toUpperCase();
    const status = type === 'FREE' ? 'Free' : type === 'BUSY-TENTATIVE' ? 'Tentative' : type === 'BUSY-UNAVAILABLE' ? 'OOF' : 'Busy';
    for (const period of value.split(',')) {
      const [s, e] = period.split('/');
      if (!s || !e) continue;
      const start = icalInstant(s);
      const end = e.startsWith('P') ? new Date(start.getTime() + durationMs(e)) : icalInstant(e);
      if (!isNaN(start) && !isNaN(end)) out.push({ start: start.toISOString(), end: end.toISOString(), status });
    }
  }
  return out;
}
function icalInstant(s) {
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z?$/.exec(s.trim());
  return m ? new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6])) : new Date(NaN);
}
function durationMs(p) {
  const m = /^P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(p);
  if (!m) return 0;
  return ((+m[1] || 0) * 7 * 86400 + (+m[2] || 0) * 86400 + (+m[3] || 0) * 3600 + (+m[4] || 0) * 60 + (+m[5] || 0)) * 1000;
}

/**
 * The scheduling policy of one write, applied to every VEVENT of the UID
 * (master and overrides alike): an organizer's silent edit marks every
 * ATTENDEE SCHEDULE-AGENT=CLIENT, a notifying one clears it; a notifying
 * reply clears it on ORGANIZER. A leftover flag in one block would otherwise
 * keep that occurrence silent (or loud) on its own.
 */
export function applySchedulingAcross(lines, uid, { schedule = true, partstat } = {}) {
  const blocks = veventBlocks(lines, uid).all.filter((b) => b.uid === uid);
  const inBlock = (i) => blocks.some((b) => i > b.begin && i < b.end);
  return lines.map((l, i) => {
    if (!inBlock(i)) return l;
    const name = propName(l);
    if (partstat) return name === 'ORGANIZER' && !partstat.scheduleAgent ? withoutParam(l, 'SCHEDULE-AGENT') : l;
    if (name !== 'ATTENDEE') return l;
    return schedule ? withoutParam(l, 'SCHEDULE-AGENT') : withParam(l, 'SCHEDULE-AGENT', 'CLIENT');
  });
}

/** The whole object marked for a silent write (every attendee SCHEDULE-AGENT=CLIENT), e.g. before a silent DELETE. */
export function markSilent(data, uid) {
  return join(applySchedulingAcross(unfold(data), uid, { schedule: false }));
}

// --- one occurrence of a series -------------------------------------------------

/** The instant a DTSTART / RECURRENCE-ID / EXDATE value names (DATE values → midnight UTC of that date, our convention for all-day occurrences). */
export function valueInstant(line, tz) {
  const { params, value } = splitLine(line || '');
  const v = value.trim();
  if ((params.VALUE || '').toUpperCase() === 'DATE' || /^\d{8}$/.test(v)) return new Date(Date.UTC(+v.slice(0, 4), +v.slice(4, 6) - 1, +v.slice(6, 8)));
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/.exec(v);
  if (!m) return new Date(NaN);
  if (m[7]) return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]));
  const zone = params.TZID && knownZone(params.TZID) ? params.TZID : tz;
  return new Date(zonedTime(`${m[1]}-${m[2]}-${m[3]}`, `${m[4]}:${m[5]}`, zone).getTime() + Number(m[6]) * 1000);
}

/** The override block (RECURRENCE-ID) of `uid` for this occurrence instant, if any. */
export function findOverride(lines, uid, at, tz) {
  const { overrides } = veventBlocks(lines, uid);
  const t = new Date(at).getTime();
  return overrides.find((b) => {
    const rid = topLevel(lines.slice(b.begin + 1, b.end)).find((l) => propName(l) === 'RECURRENCE-ID');
    return rid && Math.abs(valueInstant(rid, tz).getTime() - t) < 60e3;
  }) || null;
}

/** The DTSTART form of the master (VALUE=DATE, TZID=…, or UTC) applied to an instant: the matching EXDATE / RECURRENCE-ID value. */
function stampLike(dtstartLine, at, tz) {
  const { params } = splitLine(dtstartLine || '');
  if ((params.VALUE || '').toUpperCase() === 'DATE') return { params: ';VALUE=DATE', value: at.toISOString().slice(0, 10).replace(/-/g, '') }; // all-day occurrences are midnight UTC of their date
  if (params.TZID && knownZone(params.TZID)) return { params: `;TZID=${params.TZID}`, value: localStamp(at, params.TZID) };
  return { params: '', value: utcStamp(at) };
}

/** The object with one occurrence removed from the series (an EXDATE on the master). */
export function excludeOccurrence(data, uid, occurrence, { tz, now = new Date() } = {}) {
  const lines = unfold(data);
  const { master } = veventBlocks(lines, uid);
  if (!master) throw new Error('that event is not in the object the calendar returned');
  const own = topLevel(lines.slice(master.begin + 1, master.end));
  const ex = stampLike(own.find((l) => propName(l) === 'DTSTART'), new Date(occurrence), tz);
  let out = [...lines];
  const ov = findOverride(lines, uid, occurrence, tz); // an overridden occurrence goes with its override block
  if (ov) out.splice(ov.begin, ov.end - ov.begin + 1);
  const firstSub = lines.slice(master.begin + 1, master.end).findIndex((l) => l.toUpperCase().startsWith('BEGIN:'));
  out.splice(firstSub < 0 ? master.end : master.begin + 1 + firstSub, 0, `EXDATE${ex.params}:${ex.value}`); // a property, before any VALARM
  return editEvent(join(out), uid, {}, { now });
}

/**
 * The object with one occurrence changed on its own: a VEVENT carrying
 * RECURRENCE-ID, copied from the master (alarms included, rule left out),
 * with `changes` applied (editEvent's shape). Replaces an existing override
 * of the same occurrence.
 */
export function overrideOccurrence(data, uid, occurrence, changes, { tz, now = new Date(), schedule = true } = {}) {
  const lines = unfold(data);
  const { master, overrides } = veventBlocks(lines, uid);
  if (!master) throw new Error('that event is not in the object the calendar returned');
  const own = topLevel(lines.slice(master.begin + 1, master.end));
  const at = new Date(occurrence);
  const rid = stampLike(own.find((l) => propName(l) === 'DTSTART'), at, tz);
  const ridLine = `RECURRENCE-ID${rid.params}:${rid.value}`;
  // an existing override of this occurrence (whatever form its RECURRENCE-ID takes) is the base; else the master, minus what belongs to the series
  const existing = findOverride(lines, uid, at, tz);
  let block;
  if (existing) block = lines.slice(existing.begin, existing.end + 1);
  else {
    block = ['BEGIN:VEVENT', ...lines.slice(master.begin + 1, master.end).filter((l) => !['RRULE', 'RDATE', 'EXDATE', 'RECURRENCE-ID'].includes(propName(l))), 'END:VEVENT'];
    // the occurrence's own times: the master's duration from the occurrence start (all-day: whole dates, DTEND exclusive)
    const dtstart = own.find((l) => propName(l) === 'DTSTART') || '';
    const dtend = own.find((l) => propName(l) === 'DTEND');
    const allDay = (splitLine(dtstart).params.VALUE || '').toUpperCase() === 'DATE';
    if (allDay) {
      const days = dtend ? Math.max(1, Math.round((valueInstant(dtend, tz) - valueInstant(dtstart, tz)) / 86400e3)) : 1;
      const startDate = at.toISOString().slice(0, 10);
      if (!changes.time) changes = { ...changes, time: { allDay: true, start: zonedTime(startDate, '00:00', 'UTC'), end: zonedTime(addDays(startDate, days), '00:00', 'UTC'), tz: 'UTC' } };
    } else {
      const dur = dtend ? Math.max(0, valueInstant(dtend, tz) - valueInstant(dtstart, tz)) : 0;
      if (!changes.time) changes = { ...changes, time: { allDay: false, start: at, end: new Date(at.getTime() + (dur || 1800e3)), tz: splitLine(dtstart).params.TZID || tz } };
    }
  }
  const head = lines.slice(0, lines.findIndex((l) => l.toUpperCase() === 'BEGIN:VEVENT'));
  const temp = editEvent(join([...head, ...block.filter((l) => propName(l) !== 'RECURRENCE-ID'), 'END:VCALENDAR']), uid, changes, { now, schedule });
  const tempLines = unfold(temp);
  const b = veventBlocks(tempLines, uid).master;
  const edited = tempLines.slice(b.begin, b.end + 1);
  const uidAt = edited.findIndex((l) => propName(l) === 'UID');
  edited.splice(uidAt + 1, 0, ridLine);
  let out = existing ? [...lines.slice(0, existing.begin), ...edited, ...lines.slice(existing.end + 1)] : [...lines.slice(0, lines.length - 1), ...edited, lines[lines.length - 1]];
  // a VTIMEZONE the edit added (a zone new to this object) comes along
  const have = new Set(out.filter((l) => propName(l) === 'TZID').map((l) => l.slice(l.indexOf(':') + 1).trim()));
  const tzBlocks = [];
  for (let i = 0; i < tempLines.length; i++) {
    if (tempLines[i].toUpperCase() !== 'BEGIN:VTIMEZONE') continue;
    const end = tempLines.findIndex((l, k) => k > i && l.toUpperCase() === 'END:VTIMEZONE');
    const tzid = (tempLines.slice(i, end).find((l) => propName(l) === 'TZID') || '').split(':').slice(1).join(':').trim();
    if (tzid && !have.has(tzid)) tzBlocks.push(...tempLines.slice(i, end + 1));
    i = end;
  }
  if (tzBlocks.length) out.splice(out.findIndex((l) => l.toUpperCase() === 'BEGIN:VEVENT'), 0, ...tzBlocks);
  return join(applySchedulingAcross(out, uid, { schedule, partstat: changes.partstat }));
}
