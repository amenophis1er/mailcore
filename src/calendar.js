// Account-level calendar helpers shared by the CLI, the MCP server and the
// daemon: which accounts have a calendar, how a "calendar" argument resolves
// (own folder by name/id, or someone else's mailbox by email), listings
// merged across accounts, human date/duration parsing, and free-slot search.

import { calendarProvider } from './accounts.js';
import { splitId } from './client.js';

/**
 * The account-level calendar operations of one mailcore instance. `core`
 * supplies accounts (core.config, core.account), the default account, the
 * time zone and withAuthRetry.
 */
export function calendarApi(core) {
  const withAuthRetry = (fn, onRefresh, account) => core.withAuthRetry(fn, onRefresh, account);

  /** Names of accounts with a calendar: the one given, else every one (Exchange, CalDAV, Google). */
  function calendarAccounts(account) {
    const config = core.config;
    if (account) {
      const acct = core.account(account);
      if (!calendarProvider(acct)) throw new Error(`account "${acct.name}" (${acct.provider}) has no calendar — Exchange, CalDAV and Google accounts do`);
      return [acct.name];
    }
    const names = Object.keys(config.accounts).filter((n) => calendarProvider(config.accounts[n]));
    if (names.length === 0) throw new Error('no calendar account configured (Exchange, CalDAV or Google)');
    return names;
  }

  /** Same, but with several EWS accounts and none named, prefer defaultAccount. */
  function oneCalendarAccount(account) {
    const names = calendarAccounts(account);
    if (names.length === 1) return names[0];
    const def = core.defaultAccount;
    if (def && names.includes(def)) return def;
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
  async function resolveCalendar(spec, account) {
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

  async function listCalendars(account, { mailbox, onError } = {}) {
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
  async function listEvents({ account, start, end, calendar, limit = 100, onError } = {}) {
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

  // which calendars an account has changes rarely: asked once every few minutes, not with every agenda
  const CALENDARS_TTL_MS = 5 * 60e3;
  const knownCalendars = new Map(); // account → { at, list }

  /**
   * Events in [start, end] of EVERY calendar the accounts can see: the default
   * one, the other calendars of the mailbox, and the shared calendars opened
   * in Outlook/OWA (other people's, a team's). Each event carries `calendarKey`,
   * `calendarName` and `shared`.
   * { items, calendars: [{ key, name, account, isDefault, shared, writable, failed? }] }
   * (`writable`: new events may go there)
   * A secondary calendar that cannot be read is marked `failed` and left out;
   * an account whose own calendar cannot be read goes to onError (or throws).
   */
  async function listAllEvents({ account, start, end, limit = 200, onError } = {}) {
    const names = calendarAccounts(account);
    const perAccount = await Promise.all(names.map((n) => withAuthRetry(async (c) => {
      const hit = knownCalendars.get(n);
      let list = hit && Date.now() - hit.at < CALENDARS_TTL_MS ? hit.list : null;
      if (!list) {
        list = await c.findCalendars();
        if (!list.some((k) => k.isDefault)) list = [{ id: '', name: 'Calendar', isDefault: true }, ...list];
        knownCalendars.set(n, { at: Date.now(), list });
      }
      const read = await Promise.all(list.map(async (k) => {
        const shared = !!(k.shared && k.mailbox);
        const info = { key: `${n}|${k.isDefault ? 'default' : shared ? 'mailbox:' + String(k.mailbox).toLowerCase() : k.id}`, name: k.name || (shared ? k.mailbox : 'Calendar'), account: n, isDefault: !!k.isDefault, shared, writable: !k.readOnly };
        try {
          const events = await c.findEvents({ start, end, limit, ...(k.isDefault ? {} : shared ? { mailbox: k.mailbox } : { calendar: k.id }) });
          return { info, events: events.map((e) => ({ ...e, calendarKey: info.key, calendarName: info.name, shared })) };
        } catch (e) {
          if (k.isDefault) throw e; // the account itself is in trouble: let the sign-in retry see it
          return { info: { ...info, failed: e.message }, events: [] };
        }
      }));
      return read;
    }, null, n).catch((e) => {
      if (onError) { onError(n, e); return []; }
      throw e;
    })));
    const read = perAccount.flat();
    return {
      items: read.flatMap((r) => r.events).sort((a, b) => new Date(a.start) - new Date(b.start)).slice(0, limit * 3),
      calendars: read.map((r) => r.info)
    };
  }

  function readEvent(id) {
    return withAuthRetry((c) => c.getEvent(id), null, id);
  }

  /** `allowShared`: the event may go into a calendar shared with me (a team's), when its owner lets me write there. */
  async function createEvent({ account, calendar, allowShared = false, ...fields }) {
    const target = await resolveCalendar(calendar, account);
    if (target.mailbox && !allowShared) throw new Error('events can only be created in your own calendars — invite that person instead');
    const name = target.account || oneCalendarAccount(account);
    return withAuthRetry((c) => c.createEvent({ ...fields, calendar: target.calendar, ...(target.mailbox ? { mailbox: target.mailbox } : {}), timeZone: core.timeZone }), null, name);
  }

  /** Update with the item's current changeKey fetched when not supplied; refuses silent meeting edits unless allowed. */
  async function updateEvent({ id, changeKey, notify = true, ...fields }) {
    return withAuthRetry(async (c) => {
      const cur = await c.getEvent(id);
      return c.updateEvent({ ...fields, id, changeKey: changeKey || cur.changeKey, notify: notify && cur.isMeeting, timeZone: core.timeZone });
    }, null, id);
  }

  async function deleteEvent(id, { changeKey, notify = true } = {}) {
    return withAuthRetry(async (c) => {
      const cur = await c.getEvent(id);
      return c.deleteEvent(id, changeKey || cur.changeKey, { notify: notify && cur.isMeeting });
    }, null, id);
  }

  async function respondToEvent(id, response, { changeKey, message, notify = true } = {}) {
    return withAuthRetry(async (c) => {
      const cur = await c.getEvent(id);
      if (!cur.isMeeting) throw new Error('that event is not a meeting invitation');
      return c.respondToEvent(id, changeKey || cur.changeKey, response, { message, notify });
    }, null, id);
  }

  function freeBusy({ account, emails, start, end, intervalMinutes = 30 }) {
    const name = oneCalendarAccount(account);
    return withAuthRetry((c) => c.getFreeBusy({ emails, start, end, intervalMinutes }), null, name);
  }

  /**
   * Common free windows for everyone in `emails`: scans the merged free/busy
   * grids and returns up to `max` slots of `durationMinutes`, inside the local
   * hours window [hoursFrom, hoursTo) on weekdays (unless weekends: true).
   * Tentative counts as free when `tentativeOk`.
   */
  async function findFreeSlots({ account, emails, start, end, durationMinutes = 30, intervalMinutes = 30, hoursFrom = 9, hoursTo = 18, weekends = false, tentativeOk = false, max = 10 }) {
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

  return { calendarAccounts, oneCalendarAccount, resolveCalendar, listCalendars, listEvents, listAllEvents, readEvent, createEvent, updateEvent, deleteEvent, respondToEvent, freeBusy, findFreeSlots };
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
