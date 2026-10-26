// Google Calendar backend over the REST API, same methods as the Exchange
// calendar (ews-calendar.js): findCalendars / findEvents / getEvent /
// createEvent / updateEvent / deleteEvent / respondToEvent / getFreeBusy /
// selfEmail. Tokens come from google-auth.js (keychain).
//
// Ids: event = "<calendarId>/<eventId>" (Google expands recurrences into
// instances with their own ids, so an occurrence id works for every call);
// calendar = the Google calendar id (the primary one is the account's email).
// Shared calendars and other people's calendars are the same thing here:
// anything in calendarList, or any calendar id (an email) the account can read.
// Ported from Amen's buddi calendar plugin (Apache-2.0) and extended with
// attendees, invitations, replies and free/busy.

import { accessToken } from './google-auth.js';
import { localZone, freeBusyRow, eventShape } from './cal-common.js';
import { zonedTime, addDays, dateIn } from './ical.js';

const API = 'https://www.googleapis.com/calendar/v3';
const TIMEOUT_MS = 20000;
const enc = encodeURIComponent;
const RESPONSE = { accepted: 'Accept', tentative: 'Tentative', declined: 'Decline', needsAction: 'NoResponseReceived' };

export class GoogleCalendar {
  constructor({ account, email = '', timeZone }) {
    this.account = account;
    this.self = String(email || '').toLowerCase();
    this.tz = localZone(timeZone);
    this.changeKeyIsId = true;
    this._calendars = null;
  }

  close() {}

  async send({ method, path, query = {}, body, headers = {} }, retry = true) {
    const url = new URL(`${API}${path}`);
    for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    const token = await accessToken(this.account, { force: !retry });
    const res = await fetch(url, {
      method, body: body === undefined ? undefined : JSON.stringify(body),
      headers: { authorization: `Bearer ${token}`, accept: 'application/json', ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
      signal: AbortSignal.timeout(TIMEOUT_MS)
    });
    if (res.status === 401 && retry) return this.send({ method, path, query, body, headers }, false);
    const text = await res.text();
    let data = null;
    try { data = text.trim() ? JSON.parse(text) : null; } catch {}
    if (res.status === 401) { const e = new Error(`Google no longer accepts the sign-in for "${this.account}" — run: mailwatcher google-login ${this.account}`); e.code = 'MAIL_AUTH'; throw e; }
    return { status: res.status, etag: res.headers.get('etag') || data?.etag || null, data };
  }

  fail(res, what) {
    const reason = res.data?.error?.errors?.[0]?.reason || res.data?.error?.status || '';
    const msg = res.data?.error?.message || '';
    if (res.status === 403 && /rate|quota|limit/i.test(reason)) return new Error(`Google is rate-limiting ${what} — try again shortly`);
    if (res.status === 404) return new Error(`Google has no ${what} (404)`);
    if (res.status === 412) return new Error('the event changed on Google since it was read — fetch it again');
    return new Error(`Google answered ${res.status} for ${what}${reason ? ` (${reason})` : ''}${msg ? `: ${msg}` : ''}`);
  }

  // --- calendars ---------------------------------------------------------------
  async calendarList() {
    if (this._calendars) return this._calendars;
    const out = [];
    let pageToken;
    for (let page = 0; page < 20; page++) {
      const res = await this.send({ method: 'GET', path: '/users/me/calendarList', query: { maxResults: 250, pageToken } });
      if (res.status !== 200) throw this.fail(res, 'the calendar list');
      for (const item of res.data?.items || []) {
        if (typeof item.id !== 'string' || item.deleted) continue;
        out.push({ id: item.id, name: String(item.summaryOverride || item.summary || item.id).trim(), color: item.backgroundColor || null, writable: item.accessRole === 'owner' || item.accessRole === 'writer', role: item.accessRole, primary: !!item.primary });
      }
      pageToken = res.data?.nextPageToken;
      if (!pageToken) break;
    }
    out.sort((a, b) => Number(b.primary) - Number(a.primary));
    if (!this.self) this.self = (out.find((c) => c.primary)?.id || '').toLowerCase();
    this._calendars = out;
    return out;
  }

  async selfEmail() {
    if (this.self) return this.self;
    await this.calendarList();
    if (!this.self) throw new Error(`cannot tell the Google address of "${this.account}" — set "email" on the account`);
    return this.self;
  }

  async findCalendars({ mailbox } = {}) {
    if (mailbox) {
      const res = await this.send({ method: 'GET', path: `/calendars/${enc(mailbox)}` });
      if (res.status !== 200) throw this.fail(res, `a calendar shared by ${mailbox}`);
      return [{ id: res.data.id, changeKey: '', name: res.data.summary || mailbox, itemCount: null, isDefault: true, mailbox, shared: true, owner: mailbox }];
    }
    const list = await this.calendarList();
    return list.map((c) => ({ id: c.id, changeKey: '', name: c.name, itemCount: null, isDefault: c.primary, mailbox: null, shared: !c.writable && !c.primary, owner: c.primary ? null : c.id.includes('@') ? c.id : null, color: c.color, writable: c.writable, role: c.role }));
  }

  async targetCalendar({ calendar, mailbox }) {
    if (mailbox) return mailbox;
    if (calendar) return calendar;
    const list = await this.calendarList();
    return (list.find((c) => c.primary) || list[0])?.id || 'primary';
  }

  // --- events ------------------------------------------------------------------
  eventId(calendarId, eventId) { return `${enc(calendarId)}/${eventId}`; }
  parseEventId(id) {
    const i = String(id).lastIndexOf('/');
    if (i < 0) throw new Error('not a Google event id');
    return { calendarId: decodeURIComponent(id.slice(0, i)), eventId: id.slice(i + 1) };
  }

  toEvent(e, calendarId, calendarName) {
    const allDay = typeof e.start?.date === 'string';
    // all-day dates are placed at midnight in the configured zone, DTEND exclusive
    const start = allDay ? zonedTime(e.start.date, '00:00', this.tz) : new Date(e.start?.dateTime || '');
    let end = allDay ? zonedTime(e.end?.date && e.end.date > e.start.date ? e.end.date : addDays(e.start.date, 1), '00:00', this.tz) : new Date(e.end?.dateTime || e.start?.dateTime || '');
    const me = (e.attendees || []).find((a) => a.self) || null;
    const organizer = e.organizer || {};
    const isOrganizer = !!organizer.self || (this.self && String(organizer.email || '').toLowerCase() === this.self);
    const others = (e.attendees || []).filter((a) => !a.self && !a.resource);
    // an invitation: other attendees, or an organizer who is not me (the attendee list may hold only me)
    const isMeeting = others.length > 0 || (!!me && !isOrganizer && !!organizer.email); // an invitation to me, or a meeting with others; a shared calendar's own events are not
    const reminder = e.reminders?.useDefault ? 10 : (e.reminders?.overrides || []).find((r) => r.method === 'popup')?.minutes ?? null;
    return eventShape({
      id: this.eventId(calendarId, e.id), changeKey: e.etag || '', subject: e.summary || '', start: start.toISOString(), end: end.toISOString(), allDay,
      location: e.location || '', organizerName: organizer.displayName || '', organizerEmail: organizer.email || '',
      showAs: e.transparency === 'transparent' ? 'Free' : 'Busy',
      myResponse: isOrganizer ? 'Organizer' : me ? RESPONSE[me.responseStatus] || 'Unknown' : 'Unknown',
      isMeeting, isCancelled: e.status === 'cancelled', isRecurring: !!(e.recurringEventId || e.recurrence), type: e.recurringEventId ? 'Occurrence' : e.recurrence ? 'RecurringMaster' : 'Single',
      private: e.visibility === 'private' || e.visibility === 'confidential', hasAttachments: !!(e.attachments || []).length, reminderMinutes: reminder, modified: e.updated || '',
      calendarName, calendarId, link: e.htmlLink || undefined
    });
  }

  full(e, calendarId, calendarName) {
    return {
      ...this.toEvent(e, calendarId, calendarName),
      body: String(e.description || '').replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, ''),
      attendees: (e.attendees || []).map((a) => ({ name: a.displayName || '', email: a.email || '', role: a.resource ? 'resource' : a.optional ? 'optional' : 'required', response: RESPONSE[a.responseStatus] || 'Unknown', self: !!a.self })),
      categories: [], importance: 'Normal', created: e.created || '', uid: e.iCalUID || e.id, responseRequested: (e.attendees || []).length > 0, recurrence: e.recurrence || undefined, conference: e.hangoutLink || undefined
    };
  }

  async findEvents({ start, end, calendar, mailbox, limit = 100 } = {}) {
    const from = start ? new Date(start) : new Date();
    const to = end ? new Date(end) : new Date(from.getTime() + 7 * 86400e3);
    const calendarId = await this.targetCalendar({ calendar, mailbox });
    const name = (await this.calendarList().catch(() => []))?.find((c) => c.id === calendarId)?.name;
    const out = [];
    let pageToken;
    for (let page = 0; page < 20 && out.length < limit; page++) {
      const res = await this.send({ method: 'GET', path: `/calendars/${enc(calendarId)}/events`, query: { timeMin: from.toISOString(), timeMax: to.toISOString(), singleEvents: 'true', orderBy: 'startTime', maxResults: Math.min(2500, limit), timeZone: this.tz, pageToken } });
      if (res.status !== 200) throw this.fail(res, 'events');
      for (const e of res.data?.items || []) if (e?.id && e.start && e.end) out.push(this.toEvent(e, calendarId, name));
      pageToken = res.data?.nextPageToken;
      if (!pageToken) break;
    }
    return out.sort((a, b) => new Date(a.start) - new Date(b.start)).slice(0, Math.max(1, limit));
  }

  async getEvent(id) {
    const { calendarId, eventId } = this.parseEventId(id);
    const res = await this.send({ method: 'GET', path: `/calendars/${enc(calendarId)}/events/${enc(eventId)}` });
    if (res.status !== 200) throw this.fail(res, 'that event');
    const name = (await this.calendarList().catch(() => []))?.find((c) => c.id === calendarId)?.name;
    return this.full({ ...res.data, etag: res.etag || res.data.etag }, calendarId, name);
  }

  time({ start, end, allDay, timeZone }) {
    const tz = timeZone || this.tz;
    const s = new Date(start);
    const e = end ? new Date(end) : new Date(s.getTime() + (allDay ? 86400e3 : 1800e3));
    if (allDay) {
      const startDate = dateIn(s, tz);
      let endDate = dateIn(e, tz);
      if (endDate <= startDate) endDate = addDays(startDate, 1); // DTEND exclusive; a 24h add is a day short on DST fallback
      return { start: { date: startDate }, end: { date: endDate } };
    }
    return { start: { dateTime: s.toISOString(), timeZone: tz }, end: { dateTime: e.toISOString(), timeZone: tz } };
  }

  async createEvent({ subject, start, end, allDay = false, location, body, attendees = [], optionalAttendees = [], reminderMinutes, showAs, calendar, notify = true, timeZone }) {
    const calendarId = await this.targetCalendar({ calendar });
    const people = [...attendees.map((a) => ({ ...mb(a) })), ...optionalAttendees.map((a) => ({ ...mb(a), optional: true }))];
    const event = {
      summary: subject || '', location: location || undefined, description: body || undefined, ...this.time({ start, end, allDay, timeZone }),
      attendees: people.length ? people : undefined, transparency: showAs && /free/i.test(showAs) ? 'transparent' : undefined,
      reminders: reminderMinutes != null ? (reminderMinutes < 0 ? { useDefault: false, overrides: [] } : { useDefault: false, overrides: [{ method: 'popup', minutes: Math.round(reminderMinutes) }] }) : undefined
    };
    const res = await this.send({ method: 'POST', path: `/calendars/${enc(calendarId)}/events`, query: { sendUpdates: notify && people.length ? 'all' : 'none' }, body: event });
    if (res.status !== 200 && res.status !== 201) throw this.fail(res, 'the new event');
    return { id: this.eventId(calendarId, res.data.id), changeKey: res.etag || '', invitationsSent: notify && people.length > 0, link: res.data.htmlLink };
  }

  async updateEvent({ id, changeKey, subject, start, end, allDay, location, body, attendees, optionalAttendees, reminderMinutes, showAs, notify = true, timeZone }) {
    const { calendarId, eventId } = this.parseEventId(id);
    const patch = {};
    if (subject !== undefined) patch.summary = subject;
    if (location !== undefined) patch.location = location || '';
    if (body !== undefined) patch.description = body || '';
    if (showAs !== undefined) patch.transparency = /free/i.test(showAs) ? 'transparent' : 'opaque';
    if (reminderMinutes !== undefined) patch.reminders = reminderMinutes == null ? { useDefault: true } : reminderMinutes < 0 ? { useDefault: false, overrides: [] } : { useDefault: false, overrides: [{ method: 'popup', minutes: Math.round(reminderMinutes) }] };
    if (start || end || allDay !== undefined) {
      const cur = await this.getEvent(id);
      Object.assign(patch, this.time({ start: start || cur.start, end: end || cur.end, allDay: allDay ?? cur.allDay, timeZone }));
    }
    if (attendees || optionalAttendees) patch.attendees = [...(attendees || []).map(mb), ...(optionalAttendees || []).map((a) => ({ ...mb(a), optional: true }))];
    if (!Object.keys(patch).length) throw new Error('updateEvent: nothing to change');
    const res = await this.send({ method: 'PATCH', path: `/calendars/${enc(calendarId)}/events/${enc(eventId)}`, query: { sendUpdates: notify ? 'all' : 'none' }, body: patch, headers: changeKey ? { 'if-match': changeKey } : {} });
    if (res.status !== 200) throw this.fail(res, 'that change');
    return { id, changeKey: res.etag || '' };
  }

  async deleteEvent(id, changeKey, { notify = true } = {}) {
    const { calendarId, eventId } = this.parseEventId(id);
    const res = await this.send({ method: 'DELETE', path: `/calendars/${enc(calendarId)}/events/${enc(eventId)}`, query: { sendUpdates: notify ? 'all' : 'none' }, headers: changeKey ? { 'if-match': changeKey } : {} });
    if (res.status === 404 || res.status === 410 || res.status === 204 || res.status === 200) return true;
    throw this.fail(res, 'that deletion');
  }

  async respondToEvent(id, changeKey, response, { notify = true } = {}) {
    const { calendarId, eventId } = this.parseEventId(id);
    const status = { accept: 'accepted', tentative: 'tentative', decline: 'declined' }[response];
    if (!status) throw new Error('response must be accept, tentative or decline');
    const cur = await this.send({ method: 'GET', path: `/calendars/${enc(calendarId)}/events/${enc(eventId)}` });
    if (cur.status !== 200) throw this.fail(cur, 'that event');
    const self = await this.selfEmail();
    const attendees = (cur.data.attendees || []).map((a) => (a.self || String(a.email || '').toLowerCase() === self ? { ...a, responseStatus: status } : a));
    if (!attendees.some((a) => a.responseStatus === status && (a.self || String(a.email || '').toLowerCase() === self))) throw new Error('that event is not an invitation addressed to this account');
    const res = await this.send({ method: 'PATCH', path: `/calendars/${enc(calendarId)}/events/${enc(eventId)}`, query: { sendUpdates: notify ? 'all' : 'none' }, body: { attendees }, headers: changeKey ? { 'if-match': changeKey } : {} });
    if (res.status !== 200) throw this.fail(res, 'that reply');
    return { ok: true, response, changeKey: res.etag || '' };
  }

  // --- free/busy ---------------------------------------------------------------
  async getFreeBusy({ emails, start, end, intervalMinutes = 30 }) {
    if (!emails || !emails.length) throw new Error('getFreeBusy: at least one email is required');
    const from = new Date(start || Date.now());
    const to = new Date(end || from.getTime() + 86400e3);
    const res = await this.send({ method: 'POST', path: '/freeBusy', body: { timeMin: from.toISOString(), timeMax: to.toISOString(), timeZone: this.tz, items: emails.map((id) => ({ id })) } });
    if (res.status !== 200) throw this.fail(res, 'free/busy');
    return emails.map((email) => {
      const c = res.data?.calendars?.[email] || res.data?.calendars?.[email.toLowerCase()] || {};
      const err = (c.errors || [])[0];
      if (err) return freeBusyRow({ email, ok: false, error: err.reason === 'notFound' ? 'no free/busy visible for that address (not shared with this account)' : err.reason || 'error', from, to, intervalMinutes });
      return freeBusyRow({ email, periods: (c.busy || []).map((b) => ({ start: b.start, end: b.end, status: 'Busy' })), from, to, intervalMinutes, view: 'FreeBusy' });
    });
  }
}

function mb(a) {
  if (typeof a === 'string') { const m = /^(.*)<([^>]+)>$/.exec(a.trim()); return m ? { displayName: m[1].trim(), email: m[2].trim() } : { email: a.trim() }; }
  return { ...(a.name ? { displayName: a.name } : {}), email: a.email };
}
