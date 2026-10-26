// Account-level calendar helpers shared by the CLI, the MCP server and the
// daemon: which accounts have a calendar, how a "calendar" argument resolves
// (own folder by name/id, or someone else's mailbox by email), listings
// merged across accounts, human date/duration parsing, and free-slot search.

import { loadConfig, getAccount, accountNames, calendarProvider } from './config.js';
import { withAuthRetry, splitId } from './client.js';

/** Names of accounts with a calendar: the one given, else every one (Exchange, CalDAV, Google). */
export function calendarAccounts(account) {
  const config = loadConfig();
  if (account) {
    const acct = getAccount(config, account);
    if (!calendarProvider(acct)) throw new Error(`account "${acct.name}" (${acct.provider}) has no calendar — Exchange, CalDAV and Google accounts do`);
    return [acct.name];
  }
  const names = accountNames(config).filter((n) => calendarProvider(config.accounts[n]));
  if (names.length === 0) throw new Error('no calendar account configured (Exchange, CalDAV or Google)');
  return names;
}

/** Same, but with several EWS accounts and none named, prefer defaultAccount. */
export function oneCalendarAccount(account) {
  const names = calendarAccounts(account);
  if (names.length === 1) return names[0];
  const config = loadConfig();
  if (config.defaultAccount && names.includes(config.defaultAccount)) return config.defaultAccount;
  throw new Error(`several calendar accounts (${names.join(', ')}) — pass --account / account`);
}

/**
 * "calendar" argument → { calendar: folderId } | { mailbox: email } | {}.
 *   undefined / "" / "default"  own default calendar
 *   a@b.c                       that person's (shared) default calendar
 *   <account>:<folder id>       a folder id from list_calendars
 *   Team, "Out of office", …    one of my calendars by name (case-insensitive),
 *                               including shared ones opened in Outlook/OWA
 * Returns the account too, so ids and the lookup stay on one account.
 */
export async function resolveCalendar(spec, account) {
  if (!spec || /^default$/i.test(spec)) return { account: account ? oneCalendarAccount(account) : null };
  if (spec.includes('@') && !spec.includes(':')) return { account: account ? oneCalendarAccount(account) : null, mailbox: spec.trim() };
  const { account: idAccount, rawId } = splitId(spec);
  // an id from list_calendars: "<account>:<long Exchange id>", "<account>:cal:<base64 url>" (CalDAV) or "<account>:<calendar id / email>" (Google)
  if (idAccount && calendarAccounts().includes(idAccount) && (rawId.length > 40 || /^cal:/.test(rawId) || rawId.includes('@'))) return { account: idAccount, calendar: spec };
  const name = oneCalendarAccount(account);
  const cals = await withAuthRetry((c) => c.findCalendars(), null, name);
  const hit = cals.find((c) => c.name.toLowerCase() === spec.toLowerCase()) || cals.find((c) => c.name.toLowerCase().includes(spec.toLowerCase()));
  if (!hit) throw new Error(`no calendar named "${spec}" on ${name} — have: ${cals.map((c) => c.name).join(', ')}`);
  // an Exchange shared calendar ("Other calendars") is someone else's mailbox; elsewhere a shared calendar is just a calendar
  if (hit.shared && hit.mailbox) return { account: name, mailbox: hit.mailbox };
  return { account: name, calendar: hit.id };
}

export async function listCalendars(account, { mailbox, onError } = {}) {
  const names = mailbox ? [oneCalendarAccount(account)] : calendarAccounts(account);
  const lists = await Promise.all(names.map((n) => withAuthRetry((c) => c.findCalendars({ mailbox }), null, n).catch((e) => {
    if (onError && names.length > 1) { onError(n, e); return []; }
    throw e;
  })));
  return lists.flat();
}

/**
 * Events in [start, end] — across every Exchange account when no calendar
 * is named, soonest first. opts.calendar as in resolveCalendar.
 */
export async function listEvents({ account, start, end, calendar, limit = 100, onError } = {}) {
  const target = await resolveCalendar(calendar, account);
  const names = target.calendar || target.mailbox ? [target.account || oneCalendarAccount(account)] : calendarAccounts(account);
  const lists = await Promise.all(
    names.map((n) =>
      withAuthRetry((c) => c.findEvents({ start, end, calendar: target.calendar, mailbox: target.mailbox, limit }), null, n).catch((e) => {
        if (onError) { onError(n, e); return []; }
        throw e;
      })
    )
  );
  return lists.flat().sort((a, b) => new Date(a.start) - new Date(b.start)).slice(0, limit);
}

export function readEvent(id) {
  return withAuthRetry((c) => c.getEvent(id), null, id);
}

export async function createEvent({ account, calendar, ...fields }) {
  const target = await resolveCalendar(calendar, account);
  if (target.mailbox) throw new Error('events can only be created in your own calendars — invite that person instead');
  const name = target.account || oneCalendarAccount(account);
  return withAuthRetry((c) => c.createEvent({ ...fields, calendar: target.calendar, timeZone: loadConfig().timeZone }), null, name);
}

/** Update with the item's current changeKey fetched when not supplied; refuses silent meeting edits unless allowed. */
export async function updateEvent({ id, changeKey, notify = true, ...fields }) {
  return withAuthRetry(async (c) => {
    const cur = await c.getEvent(id);
    return c.updateEvent({ ...fields, id, changeKey: changeKey || cur.changeKey, notify: notify && cur.isMeeting, timeZone: loadConfig().timeZone });
  }, null, id);
}

export async function deleteEvent(id, { changeKey, notify = true } = {}) {
  return withAuthRetry(async (c) => {
    const cur = await c.getEvent(id);
    return c.deleteEvent(id, changeKey || cur.changeKey, { notify: notify && cur.isMeeting });
  }, null, id);
}

export async function respondToEvent(id, response, { changeKey, message, notify = true } = {}) {
  return withAuthRetry(async (c) => {
    const cur = await c.getEvent(id);
    if (!cur.isMeeting) throw new Error('that event is not a meeting invitation');
    return c.respondToEvent(id, changeKey || cur.changeKey, response, { message, notify });
  }, null, id);
}

export function freeBusy({ account, emails, start, end, intervalMinutes = 30 }) {
  const name = oneCalendarAccount(account);
  return withAuthRetry((c) => c.getFreeBusy({ emails, start, end, intervalMinutes }), null, name);
}

/**
 * Common free windows for everyone in `emails`: scans the merged free/busy
 * grids and returns up to `max` slots of `durationMinutes`, inside the local
 * hours window [hoursFrom, hoursTo) on weekdays (unless weekends: true).
 * Tentative counts as free when `tentativeOk`.
 */
export async function findFreeSlots({ account, emails, start, end, durationMinutes = 30, intervalMinutes = 30, hoursFrom = 9, hoursTo = 18, weekends = false, tentativeOk = false, max = 10 }) {
  intervalMinutes = Math.max(5, Number(intervalMinutes) || 30); // the grids are built at 5-minute granularity at best
  // align the grid to the interval (a 10:02 start would offer 10:02 slots)
  const step = intervalMinutes * 60e3;
  const from = new Date(Math.floor(new Date(start || Date.now()).getTime() / step) * step);
  const to = new Date(end || from.getTime() + 5 * 86400e3);
  const fb = await freeBusy({ account, emails, start: from, end: to, intervalMinutes });
  const failed = fb.filter((r) => !r.ok);
  if (failed.length) throw new Error('no availability for ' + failed.map((r) => `${r.email} (${r.error})`).join(', '));
  const n = Math.min(...fb.map((r) => r.merged.length));
  if (!n) throw new Error('the server returned no availability grid');
  const need = Math.max(1, Math.ceil(durationMinutes / intervalMinutes));
  const okChar = (ch) => ch === '0' || (tentativeOk && ch === '1');
  const slotFree = (i) => fb.every((r) => okChar(r.merged[i]));
  const inHours = (i) => {
    const t = new Date(from.getTime() + i * intervalMinutes * 60e3);
    const day = t.getDay();
    if (!weekends && (day === 0 || day === 6)) return false;
    const h = t.getHours() + t.getMinutes() / 60;
    return h >= hoursFrom && h + intervalMinutes / 60 <= hoursTo;
  };
  const slots = [];
  let run = 0;
  for (let i = 0; i < n && slots.length < max; i++) {
    const good = slotFree(i) && inHours(i) && from.getTime() + i * intervalMinutes * 60e3 >= Date.now();
    run = good ? run + 1 : 0;
    if (run >= need) {
      const s = new Date(from.getTime() + (i - need + 1) * intervalMinutes * 60e3);
      slots.push({ start: s.toISOString(), end: new Date(s.getTime() + durationMinutes * 60e3).toISOString() });
      run = 0; // next slot starts after this one (no overlapping suggestions)
    }
  }
  return { emails, durationMinutes, window: { start: from.toISOString(), end: to.toISOString() }, slots, people: fb.map((r) => ({ email: r.email, view: r.view })) };
}

// --- human dates --------------------------------------------------------------

const DAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

/**
 * "now", "today", "tomorrow", "yesterday", "monday" (next one), "+2d", "-1w", "+3h",
 * "14:00", "today 14:00", "fri 9:30", "2026-10-22", "2026-10-22 14:00",
 * "2026-10-22T14:00:00Z" → Date (local time unless an offset is given).
 * Date-only forms start at local midnight.
 */
export function parseWhen(input, base = new Date()) {
  if (input instanceof Date) return input;
  const s = String(input || '').trim().toLowerCase();
  if (!s || s === 'now') return new Date(base);
  const at = (d, hm) => {
    const r = new Date(d);
    if (hm) {
      const [, h, m, ap] = hm;
      let hh = Number(h);
      if (ap === 'pm' && hh < 12) hh += 12;
      if (ap === 'am' && hh === 12) hh = 0;
      r.setHours(hh, Number(m || 0), 0, 0);
    } else r.setHours(0, 0, 0, 0);
    return r;
  };
  const TIME = /^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/;
  const rel = s.match(/^([+-])(\d+)\s*([dhmw])$/);
  if (rel) {
    const n = Number(rel[2]) * (rel[1] === '-' ? -1 : 1);
    const ms = { m: 60e3, h: 3600e3, d: 86400e3, w: 7 * 86400e3 }[rel[3]];
    return new Date(base.getTime() + n * ms);
  }
  const [dayWord, ...rest] = s.split(/\s+/);
  const timePart = rest.join(' ') || null;
  const hm = timePart ? timePart.match(TIME) : s.match(TIME);
  if (!timePart && hm) return at(base, hm); // "14:00" = today
  const d = new Date(base);
  if (dayWord === 'today') return at(d, hm);
  if (dayWord === 'tomorrow') { d.setDate(d.getDate() + 1); return at(d, hm); }
  if (dayWord === 'yesterday') { d.setDate(d.getDate() - 1); return at(d, hm); }
  const di = DAYS.findIndex((x) => x.startsWith(dayWord) && dayWord.length >= 3);
  if (di >= 0) {
    let delta = (di - d.getDay() + 7) % 7;
    if (delta === 0) delta = 7;
    d.setDate(d.getDate() + delta);
    return at(d, hm);
  }
  if (timePart && hm && /^\d{4}-\d{2}-\d{2}$/.test(dayWord)) {
    const [y, mo, da] = dayWord.split('-').map(Number);
    return at(new Date(y, mo - 1, da), hm);
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    const [y, mo, da] = s.split('-').map(Number);
    return new Date(y, mo - 1, da);
  }
  const parsed = new Date(input);
  if (!isNaN(parsed)) return parsed;
  throw new Error(`cannot understand the date "${input}" — try 2026-10-22 14:00, tomorrow 9am, friday, +2d`);
}

/** "30", "30m", "1h", "1h30m", "2d" → minutes. */
export function parseDuration(input, fallback = 30) {
  if (input == null || input === '') return fallback;
  const s = String(input).trim().toLowerCase();
  if (/^\d+$/.test(s)) return Number(s);
  let total = 0;
  let matched = false;
  for (const m of s.matchAll(/(\d+(?:\.\d+)?)\s*(d|h|m|min|mins|hr|hrs|hour|hours|day|days)/g)) {
    matched = true;
    const n = Number(m[1]);
    const u = m[2][0];
    total += u === 'd' ? n * 1440 : u === 'h' ? n * 60 : n;
  }
  if (!matched) throw new Error(`cannot understand the duration "${input}" — try 30m, 1h, 1h30m`);
  return Math.round(total);
}

/** Start of the local day of d, plus `days` days. */
export function dayStart(d = new Date(), days = 0) {
  const r = new Date(d);
  r.setHours(0, 0, 0, 0);
  r.setDate(r.getDate() + days);
  return r;
}
