// CalDAV calendar backend (iCloud, Fastmail, Nextcloud, any RFC 4791 server),
// with the same methods as the Exchange calendar in ews-calendar.js:
//   findCalendars / findEvents / getEvent / createEvent / updateEvent /
//   deleteEvent / respondToEvent / getFreeBusy / selfEmail
//
// Discovery (well-known → principal → calendar home → calendars), time-range
// queries, ETag-guarded writes. Invitations and replies rely on the server's
// implicit scheduling (RFC 6638: iCloud and Fastmail send the iTIP mail when
// ORGANIZER/ATTENDEE lines are written); notify: false writes
// SCHEDULE-AGENT=CLIENT so nothing is sent. Free/busy for other people goes
// through the scheduling outbox when the server has one; our own is computed
// from our calendars.
//
// Ids: event = base64url(object href) [+ "@" + occurrence UTC stamp];
//      calendar = "cal:" + base64url(collection url).
// Ported from Amen's buddi calendar plugin (Apache-2.0) and extended.

import { randomUUID } from 'node:crypto';
import { APPLE, CALDAV, DAV, childOf, childrenOf, escapeXml, parseXml } from './dav-xml.js';
import { occurrences, readEvent, buildEvent, editEvent, excludeOccurrence, overrideOccurrence, markSilent, findOverride, valueInstant, uidsOf, buildFreeBusyRequest, parseFreeBusy, utcStamp, dateIn, addDays, zonedTime, scheduling, unfold, propName } from './ical.js';
import { b64url, unb64url, localZone, freeBusyRow, eventShape } from './cal-common.js';

const TIMEOUT_MS = 20000;
const MAX_REDIRECTS = 5;
const XML = { 'content-type': 'application/xml; charset=utf-8' };

export const CALDAV_SERVICES = {
  icloud: { label: 'iCloud', server: 'https://caldav.icloud.com/', hostPattern: '*.icloud.com' },
  fastmail: { label: 'Fastmail', server: 'https://caldav.fastmail.com/', hostPattern: 'caldav.fastmail.com' }
};

export function hostCovered(pattern, host) {
  const h = host.toLowerCase();
  const p = pattern.toLowerCase();
  if (p.startsWith('*.')) return h.endsWith(p.slice(1)) && h.length > p.length - 1;
  return h === p;
}

function authError(status) {
  const e = new Error(`the calendar server turned the sign-in down (${status}): check the user name, and that the password is an app-specific password`);
  e.code = 'MAIL_AUTH';
  return e;
}

export class CaldavCalendar {
  constructor({ server, service, username, password, email = '', hostPattern, timeZone, account }) {
    const preset = CALDAV_SERVICES[service];
    this.server = (server || preset?.server || '').replace(/\/?$/, '/');
    if (!this.server) throw new Error(`account "${account}": set "server" (or service: icloud | fastmail)`);
    this.hostPattern = hostPattern || preset?.hostPattern || new URL(this.server).hostname;
    this.username = username;
    this.password = password;
    this.self = String(email || '').toLowerCase();
    this.tz = localZone(timeZone);
    this.account = account;
    this.changeKeyIsId = true;
    this._discovery = null;
  }

  close() {}

  // --- transport ---------------------------------------------------------------
  async send({ method, url, headers = {}, body }) {
    for (let hop = 0; ; hop++) {
      const u = new URL(url);
      if (u.protocol !== 'https:') throw new Error('calendar servers are reached over HTTPS only');
      if (!hostCovered(this.hostPattern, u.hostname)) throw new Error(`the server sent us to ${u.hostname}, outside this account's server (${this.hostPattern})`);
      const res = await fetch(url, {
        method, body, redirect: 'manual',
        headers: { authorization: 'Basic ' + Buffer.from(`${this.username}:${this.password}`).toString('base64'), 'user-agent': 'mailcore', ...headers },
        signal: AbortSignal.timeout(TIMEOUT_MS)
      });
      const location = res.headers.get('location');
      if ([301, 302, 307, 308].includes(res.status) && location && hop < MAX_REDIRECTS) { url = new URL(location, url).toString(); continue; }
      if (res.status === 401) throw authError(res.status);
      const text = await res.text();
      if (res.status === 403) { // CalDAV says 403 for preconditions too (valid-calendar-data, read-only calendar…), not only for sign-in
        const why = /<[^>]*:?([a-z-]+)\/>/i.exec(text.replace(/<\/?(error|D:error|d:error)[^>]*>/gi, ''))?.[1] || text.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 160);
        throw new Error(`the calendar server refused ${method} (403${why ? ': ' + why : ''}) — a precondition failed, a read-only calendar, or a sign-in the server does not accept`);
      }
      return { status: res.status, url, etag: res.headers.get('etag'), body: text };
    }
  }

  async propfind(url, depth, props) {
    const body = `<?xml version="1.0" encoding="utf-8"?><d:propfind xmlns:d="DAV:" xmlns:c="${CALDAV}" xmlns:a="${APPLE}"><d:prop>${props}</d:prop></d:propfind>`;
    const res = await this.send({ method: 'PROPFIND', url, headers: { ...XML, depth }, body });
    if (res.status !== 207) throw new Error(`the server answered ${res.status} to PROPFIND ${url}`);
    return { items: multistatus(res.body, res.url), url: res.url };
  }

  // --- discovery ---------------------------------------------------------------
  async discover() {
    if (this._discovery) return this._discovery;
    const ask = '<d:current-user-principal/><c:calendar-home-set/>';
    let principal, home, found;
    for (const start of [this.server, new URL('/.well-known/caldav', this.server).toString()]) {
      try { found = await this.propfind(start, '0', ask); } catch (e) { if (e.code === 'MAIL_AUTH') throw e; continue; }
      const first = found.items[0];
      home = hrefIn(first?.props, CALDAV, 'calendar-home-set', found.url);
      principal = hrefIn(first?.props, DAV, 'current-user-principal', found.url);
      if (home || principal) break;
    }
    if (!principal && !home) throw new Error('that server did not say where the calendars are — check the CalDAV address');
    let outbox = null;
    let addresses = [];
    if (principal) {
      const p = await this.propfind(principal, '0', '<c:calendar-home-set/><c:schedule-outbox-URL/><c:calendar-user-address-set/>');
      const props = p.items[0]?.props;
      home = home || hrefIn(props, CALDAV, 'calendar-home-set', p.url);
      outbox = hrefIn(props, CALDAV, 'schedule-outbox-URL', p.url) || null;
      addresses = childrenOf(childOf(props, CALDAV, 'calendar-user-address-set'), DAV, 'href').map((h) => h.text.trim()).filter((h) => /^mailto:/i.test(h)).map((h) => h.replace(/^mailto:/i, '').toLowerCase());
    }
    if (!home) throw new Error('that account did not say where its calendars are kept');
    const listed = await this.propfind(home, '1', '<d:resourcetype/><d:displayname/><a:calendar-color/><c:supported-calendar-component-set/><d:current-user-privilege-set/><c:calendar-description/>');
    const calendars = [];
    for (const item of listed.items) {
      if (!childOf(childOf(item.props, DAV, 'resourcetype'), CALDAV, 'calendar')) continue;
      const comps = childrenOf(childOf(item.props, CALDAV, 'supported-calendar-component-set'), CALDAV, 'comp');
      const events = comps.length === 0 || comps.some((c) => (c.attrs.name || '').toUpperCase() === 'VEVENT');
      if (!events) continue;
      const privileges = childOf(item.props, DAV, 'current-user-privilege-set');
      const granted = new Set(childrenOf(privileges, DAV, 'privilege').flatMap((p) => p.children.map((c) => c.name)));
      const writable = privileges === undefined ? null : ['all', 'write', 'write-content', 'bind'].some((p) => granted.has(p));
      const name = childOf(item.props, DAV, 'displayname')?.text.trim() || decodeURIComponent(new URL(item.href).pathname.replace(/\/$/, '').split('/').pop() || 'Calendar');
      calendars.push({ url: item.href, name, color: childOf(item.props, APPLE, 'calendar-color')?.text.trim() || null, writable, shared: /\/(shared|subscribed)\//i.test(item.href) });
    }
    if (!this.self && addresses.length) this.self = addresses.find((a) => a.includes('@')) || '';
    this._discovery = { principal: principal || home, home, outbox, calendars, addresses };
    return this._discovery;
  }

  async selfEmail() {
    if (this.self) return this.self;
    await this.discover();
    if (!this.self) throw new Error(`cannot tell my own address on ${this.hostPattern} — set "email" on the account`);
    return this.self;
  }

  calendarId(url) { return 'cal:' + b64url(url); }
  calendarUrl(id) {
    const raw = String(id || '').replace(/^cal:/, '');
    return unb64url(raw);
  }

  async findCalendars({ mailbox } = {}) {
    if (mailbox) throw new Error('CalDAV accounts cannot open another person\'s calendar by address — ask them to share it, it then appears in the list');
    const d = await this.discover();
    const main = this.defaultCalendar(d.calendars);
    return d.calendars.map((c) => ({
      id: this.calendarId(c.url), changeKey: '', name: c.name, itemCount: null, isDefault: c === main, mailbox: null,
      shared: !!c.shared, owner: null, color: c.color, writable: c.writable, url: c.url
    }));
  }

  defaultCalendar(list) {
    return list.find((c) => /^(calendar|home|personal|default|calendrier)$/i.test(c.name) && c.writable !== false) || list.find((c) => c.writable !== false && !c.shared) || list[0];
  }

  async targetCalendars({ calendar, mailbox }) {
    if (mailbox) throw new Error('CalDAV accounts cannot read another person\'s calendar by address');
    const d = await this.discover();
    if (!calendar) return [this.defaultCalendar(d.calendars)].filter(Boolean);
    const url = this.calendarUrl(calendar);
    const hit = d.calendars.find((c) => c.url === url || c.url.replace(/\/$/, '') === url.replace(/\/$/, ''));
    if (!hit) throw new Error('unknown calendar id for this account');
    return [hit];
  }

  // --- events ------------------------------------------------------------------
  eventId(href, occurrence) { return b64url(href) + (occurrence ? '@' + utcStamp(new Date(occurrence)) : ''); }
  parseEventId(id) {
    const [h, occ] = String(id).split('@');
    return { href: unb64url(h), occurrence: occ ? new Date(occ.replace(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z?$/, '$1-$2-$3T$4:$5:$6Z')) : null };
  }

  async query(calendarUrl, from, to) {
    const body = `<?xml version="1.0" encoding="utf-8"?><c:calendar-query xmlns:d="DAV:" xmlns:c="${CALDAV}"><d:prop><d:getetag/><c:calendar-data/></d:prop>` +
      `<c:filter><c:comp-filter name="VCALENDAR"><c:comp-filter name="VEVENT"><c:time-range start="${utcStamp(from)}" end="${utcStamp(to)}"/></c:comp-filter></c:comp-filter></c:filter></c:calendar-query>`;
    const res = await this.send({ method: 'REPORT', url: calendarUrl, headers: { ...XML, depth: '1' }, body });
    if (res.status !== 207) throw new Error(`the server answered ${res.status} to a calendar query`);
    return objectsOf(res.body, res.url);
  }

  async findEvents({ start, end, calendar, mailbox, limit = 100 } = {}) {
    const from = start ? new Date(start) : new Date();
    const to = end ? new Date(end) : new Date(from.getTime() + 7 * 86400e3);
    const self = this.self || (await this.discover(), this.self);
    const out = [];
    for (const cal of await this.targetCalendars({ calendar, mailbox })) {
      const objects = await this.query(cal.url, from, to);
      for (const o of objects) {
        let evs = [];
        try { evs = occurrences(o.data, { from, to, timeZone: this.tz, self, calendarName: cal.name }); } catch { continue; }
        for (const e of evs) out.push({ ...eventShape({ ...e, id: this.eventId(o.href, e.occurrence), changeKey: o.etag || '', calendarId: this.calendarId(cal.url) }) });
      }
    }
    return out.sort((a, b) => new Date(a.start) - new Date(b.start)).slice(0, Math.max(1, limit));
  }

  async getObject(href) {
    const res = await this.send({ method: 'GET', url: href, headers: { accept: 'text/calendar' } });
    if (res.status === 404 || res.status === 410) throw new Error('that event is no longer in the calendar');
    if (res.status !== 200) throw new Error(`the server answered ${res.status} for that event`);
    return { href: res.url, etag: res.etag, data: res.body };
  }

  async getEvent(id) {
    const { href, occurrence } = this.parseEventId(id);
    const obj = await this.getObject(href);
    const uid = uidsOf(obj.data)[0];
    if (!uid) throw new Error('that object holds no event');
    const d = await this.discover();
    const cal = d.calendars.find((c) => href.startsWith(c.url));
    const self = this.self;
    const full = readEvent(obj.data, uid, { timeZone: this.tz, self, calendarName: cal?.name });
    let inst = null;
    if (occurrence) {
      // the instance as expanded (an override's own subject/time/attendees/status win over the master's)
      const lines = unfold(obj.data);
      const ov = findOverride(lines, uid, occurrence, this.tz);
      const at = ov ? valueInstant(lines.slice(ov.begin + 1, ov.end).find((l) => propName(l) === 'DTSTART'), this.tz) : occurrence; // an override may live far from its slot
      const lo = new Date(Math.min(at, occurrence) - 2 * 86400e3);
      const hi = new Date(Math.max(at, occurrence) + 2 * 86400e3);
      inst = occurrences(obj.data, { from: lo, to: hi, timeZone: this.tz, self, calendarName: cal?.name })
        .find((e) => e.occurrence && Math.abs(new Date(e.occurrence) - occurrence) < 60e3) || null;
    }
    const ev = inst ? { ...full, ...inst, type: 'Occurrence' } : full;
    return {
      ...eventShape({ ...ev, id, changeKey: obj.etag || '', calendarId: cal ? this.calendarId(cal.url) : undefined }),
      body: ev.body, attendees: ev.attendees, categories: ev.categories, importance: 'Normal', created: ev.created, uid, responseRequested: ev.responseRequested,
      tz: full.tz, rule: full.rule, href, occurrence: inst ? inst.occurrence : null
    };
  }

  timeOf({ start, end, allDay, timeZone }) {
    const tz = timeZone || this.tz;
    const s = new Date(start);
    let e = end ? new Date(end) : new Date(s.getTime() + (allDay ? 86400e3 : 1800e3));
    if (allDay) {
      // all-day: whole dates in the zone, DTEND exclusive — at least the day after the start (a 24h add is a day short on DST fallback)
      const startDate = dateIn(s, tz);
      let endDate = dateIn(e, tz);
      if (endDate <= startDate) endDate = addDays(startDate, 1);
      return { allDay: true, start: zonedTime(startDate, '00:00', tz), end: zonedTime(endDate, '00:00', tz), tz };
    }
    return { allDay: false, start: s, end: e, tz };
  }

  async createEvent({ subject, start, end, allDay = false, location, body, attendees = [], optionalAttendees = [], reminderMinutes, showAs, calendar, notify = true, timeZone }) {
    const [cal] = await this.targetCalendars({ calendar });
    if (!cal) throw new Error('no calendar to write to');
    const self = attendees.length || optionalAttendees.length ? await this.selfEmail() : null;
    const uid = randomUUID();
    const data = buildEvent({
      uid, subject, time: this.timeOf({ start, end, allDay, timeZone }), location, body, reminderMinutes, showAs,
      organizer: self ? { email: self } : null,
      attendees: attendees.map(mb), optionalAttendees: optionalAttendees.map(mb), schedule: notify
    });
    const href = new URL(`${encodeURIComponent(uid)}.ics`, cal.url.endsWith('/') ? cal.url : cal.url + '/').toString();
    const res = await this.send({ method: 'PUT', url: href, headers: { 'content-type': 'text/calendar; charset=utf-8', 'if-none-match': '*' }, body: data });
    if (res.status < 200 || res.status >= 300) throw new Error(`the server answered ${res.status} when saving the event`);
    return { id: this.eventId(href), changeKey: res.etag || '', invitationsSent: notify && !!(attendees.length || optionalAttendees.length) };
  }

  async updateEvent({ id, changeKey, subject, start, end, allDay, location, body, attendees, optionalAttendees, reminderMinutes, showAs, notify = true, timeZone }) {
    const { href, occurrence } = this.parseEventId(id);
    const obj = await this.getObject(href);
    const uid = uidsOf(obj.data)[0];
    const changes = { subject, location, body, reminderMinutes, showAs };
    if (start || end || allDay !== undefined) {
      const cur = occurrence ? await this.getEvent(id) : readEvent(obj.data, uid, { timeZone: this.tz, self: this.self });
      changes.time = this.timeOf({ start: start || cur.start, end: end || cur.end, allDay: allDay ?? cur.allDay, timeZone: timeZone || cur.tz });
    }
    if (attendees || optionalAttendees) {
      const self = await this.selfEmail();
      changes.organizer = { email: self };
      changes.attendees = (attendees || []).map(mb);
      changes.optionalAttendees = (optionalAttendees || []).map(mb);
    }
    // one occurrence of a series becomes its own VEVENT (RECURRENCE-ID); the series stays as it was
    const data = occurrence ? overrideOccurrence(obj.data, uid, occurrence, changes, { tz: this.tz, schedule: notify }) : editEvent(obj.data, uid, changes, { schedule: notify });
    const res = await this.send({ method: 'PUT', url: href, headers: { 'content-type': 'text/calendar; charset=utf-8', ...(changeKey || obj.etag ? { 'if-match': changeKey || obj.etag } : {}) }, body: data });
    if (res.status === 412) throw new Error('the event changed in the calendar since it was read — fetch it again');
    if (res.status < 200 || res.status >= 300) throw new Error(`the server answered ${res.status} when saving the change`);
    return { id, changeKey: res.etag || '' };
  }

  async deleteEvent(id, changeKey, { notify = true } = {}) {
    const { href, occurrence } = this.parseEventId(id);
    if (occurrence || !notify) {
      const obj = await this.getObject(href);
      const uid = uidsOf(obj.data)[0];
      const put = async (data) => {
        const r = await this.send({ method: 'PUT', url: href, headers: { 'content-type': 'text/calendar; charset=utf-8', ...(changeKey || obj.etag ? { 'if-match': changeKey || obj.etag } : {}) }, body: data });
        if (r.status === 412) throw new Error('the event changed in the calendar since it was read — fetch it again');
        if (r.status < 200 || r.status >= 300) throw new Error(`the server answered ${r.status} when saving the change`);
        return r.etag || '';
      };
      if (occurrence) { // one occurrence: an EXDATE on the series (attendees are told, or not, by the server as for any edit)
        await put(notify ? excludeOccurrence(obj.data, uid, occurrence, { tz: this.tz }) : editEvent(excludeOccurrence(obj.data, uid, occurrence, { tz: this.tz }), uid, {}, { schedule: false }));
        return true;
      }
      // a silent cancellation (RFC 6638 §3.2.1.3): mark every attendee SCHEDULE-AGENT=CLIENT, then delete
      if (/^ATTENDEE/im.test(obj.data)) changeKey = await put(markSilent(obj.data, uid));
    }
    const res = await this.send({ method: 'DELETE', url: href, headers: changeKey ? { 'if-match': changeKey } : {} });
    if (res.status === 412) throw new Error('the event changed in the calendar since it was read — fetch it again');
    if (res.status === 404 || res.status === 410) return true;
    if (res.status < 200 || res.status >= 300) throw new Error(`the server answered ${res.status} when deleting the event`);
    return true;
  }

  /** A reply to one occurrence's id answers the whole series (one PARTSTAT on the master, as most clients do). */
  async respondToEvent(id, changeKey, response, { notify = true } = {}) {
    const { href } = this.parseEventId(id);
    const obj = await this.getObject(href);
    const uid = uidsOf(obj.data)[0];
    const self = await this.selfEmail();
    const value = { accept: 'ACCEPTED', tentative: 'TENTATIVE', decline: 'DECLINED' }[response];
    if (!value) throw new Error('response must be accept, tentative or decline');
    // the ATTENDEE line that is me: the configured address or any address the server lists for this principal
    const mine = new Set([self, ...((await this.discover()).addresses || [])].map((a) => String(a).toLowerCase()));
    const lines = unfold(obj.data);
    const blocks = lines.reduce((acc, l, i) => { if (l.toUpperCase() === 'BEGIN:VEVENT') acc.push({ begin: i }); else if (l.toUpperCase() === 'END:VEVENT' && acc.length) acc[acc.length - 1].end = i; return acc; }, []);
    const master = blocks.find((b) => !lines.slice(b.begin + 1, b.end).some((l) => propName(l) === 'RECURRENCE-ID')) || blocks[0];
    const att = master ? scheduling(lines.slice(master.begin + 1, master.end)).attendees.find((a) => mine.has(a.email)) : null;
    if (!att) throw new Error('that event is not an invitation addressed to this account');
    const data = editEvent(obj.data, uid, { partstat: { email: att.email, value, scheduleAgent: notify ? undefined : 'CLIENT' } });
    const res = await this.send({ method: 'PUT', url: href, headers: { 'content-type': 'text/calendar; charset=utf-8', ...(changeKey || obj.etag ? { 'if-match': changeKey || obj.etag } : {}) }, body: data });
    if (res.status === 412) throw new Error('the event changed in the calendar since it was read — fetch it again');
    if (res.status < 200 || res.status >= 300) throw new Error(`the server answered ${res.status} when saving the reply`);
    return { ok: true, response, changeKey: res.etag || '' };
  }

  // --- free/busy ---------------------------------------------------------------
  async getFreeBusy({ emails, start, end, intervalMinutes = 30 }) {
    if (!emails || !emails.length) throw new Error('getFreeBusy: at least one email is required');
    const from = new Date(start || Date.now());
    const to = new Date(end || from.getTime() + 86400e3);
    const self = await this.selfEmail().catch(() => '');
    const d = await this.discover();
    const rows = [];
    const others = [];
    for (const email of emails) {
      if (self && email.toLowerCase() === self) {
        const periods = [];
        for (const cal of d.calendars.filter((c) => !c.shared)) {
          for (const e of await this.findEvents({ start: from, end: to, calendar: this.calendarId(cal.url), limit: 1000 })) {
            if (e.isCancelled || /free/i.test(e.showAs)) continue;
            periods.push({ start: e.start, end: e.end, status: e.myResponse === 'Tentative' ? 'Tentative' : 'Busy', subject: e.subject, location: e.location, isMeeting: e.isMeeting });
          }
        }
        rows.push(freeBusyRow({ email, periods, from, to, intervalMinutes }));
      } else others.push(email);
    }
    if (others.length) {
      if (!d.outbox) {
        for (const email of others) rows.push(freeBusyRow({ email, ok: false, error: 'this CalDAV server has no scheduling outbox (free/busy of other people unavailable)', from, to, intervalMinutes }));
      } else {
        const body = buildFreeBusyRequest({ uid: randomUUID(), organizer: self, attendees: others, start: from, end: to });
        const res = await this.send({ method: 'POST', url: d.outbox, headers: { 'content-type': 'text/calendar; charset=utf-8' }, body });
        const byEmail = new Map();
        if (res.status === 200) {
          try {
            const doc = parseXml(res.body);
            for (const r of childrenOf(doc, CALDAV, 'response')) {
              const who = childOf(childOf(r, CALDAV, 'recipient'), DAV, 'href')?.text.replace(/^mailto:/i, '').trim().toLowerCase();
              const status = childOf(r, CALDAV, 'request-status')?.text.trim() || '';
              const data = childOf(r, CALDAV, 'calendar-data')?.text || '';
              if (who) byEmail.set(who, { ok: /^2\./.test(status) && !!data, status, periods: data ? parseFreeBusy(data) : [] });
            }
          } catch {}
        }
        for (const email of others) {
          const r = byEmail.get(email.toLowerCase());
          rows.push(r && r.ok ? freeBusyRow({ email, periods: r.periods, from, to, intervalMinutes, view: 'FreeBusy' })
            : freeBusyRow({ email, ok: false, error: r ? `server said ${r.status}` : `no free/busy answer (HTTP ${res.status})`, from, to, intervalMinutes }));
        }
      }
    }
    return emails.map((e) => rows.find((r) => r.email === e));
  }
}

function mb(a) {
  if (typeof a === 'string') { const m = /^(.*)<([^>]+)>$/.exec(a.trim()); return m ? { name: m[1].trim(), email: m[2].trim() } : { email: a.trim() }; }
  return { name: a.name || '', email: a.email };
}

function multistatus(body, base) {
  const doc = parseXml(body);
  if (doc.ns !== DAV || doc.name !== 'multistatus') throw new Error('the server did not answer with a WebDAV multistatus');
  return childrenOf(doc, DAV, 'response').flatMap((response) => {
    const href = childOf(response, DAV, 'href')?.text.trim();
    if (!href) return [];
    const ok = childrenOf(response, DAV, 'propstat').find((ps) => /\s2\d\d\s/.test(` ${childOf(ps, DAV, 'status')?.text ?? ''} `));
    return [{ href: new URL(href, base).toString(), props: childOf(ok, DAV, 'prop') }];
  });
}
function hrefIn(props, ns, name, base) {
  const href = childOf(childOf(props, ns, name), DAV, 'href')?.text.trim();
  return href ? new URL(href, base).toString() : undefined;
}
function objectsOf(body, base) {
  return multistatus(body, base).flatMap((item) => {
    const data = childOf(item.props, CALDAV, 'calendar-data')?.text;
    if (!data) return [];
    return [{ href: item.href, etag: childOf(item.props, DAV, 'getetag')?.text.trim() || null, data }];
  });
}
export { escapeXml };
