// Account definitions: providers, defaults and normalization. The caller
// hands mailcore its accounts (from a config file, a settings store, …);
// nothing here reads a file.
//
//   { provider: 'ews',    host, username, domain, email, cache, calendar, streaming }
//   { provider: 'imap',   email, username, imap: { host, port, secure }, smtp: { … }, cache,
//                         calendar?: { provider: 'google' | 'caldav', … } }
//   { provider: 'caldav', service, server, username, email, calendar }   (calendar only)
//   { provider: 'google', email, calendar }                               (calendar only)
//
//   displayName (optional, ews and imap): the name mail is written as — on
//   IMAP the name in the From of what is sent and drafted (see displayNameOf).
//
// Unknown fields are kept as they are (front ends carry their own, such as
// where the password comes from).

export const PROVIDERS = ['ews', 'imap', 'caldav', 'google'];
/** Providers that hold mail (the others are calendar-only accounts). */
export const MAIL_PROVIDERS = ['ews', 'imap'];

// cache: encrypted local copy of the inbox (headers always, bodies of new
// mail) for the last `days` days — on by default, see cache.js.
export const CACHE_DEFAULTS = { enabled: true, days: 30, bodies: true };

// calendar: a watcher keeps a snapshot of the next lookaheadDays (push + a
// poll every pollMinutes) and reports reminders remindMinutes before each
// event starts. notify/sound are hints for the front end.
export const CALENDAR_DEFAULTS = { watch: true, remindMinutes: [10], notify: true, sound: 'ding', lookaheadDays: 7, pollMinutes: 5 };

export const ACCOUNT_DEFAULTS = {
  ews: { provider: 'ews', host: '', username: '', domain: '', email: '', cache: { ...CACHE_DEFAULTS }, calendar: { ...CALENDAR_DEFAULTS } },
  caldav: { provider: 'caldav', service: 'other', server: '', username: '', email: '', calendar: { ...CALENDAR_DEFAULTS } },
  google: { provider: 'google', email: '', calendar: { ...CALENDAR_DEFAULTS } },
  imap: {
    provider: 'imap',
    email: '',
    username: '',
    imap: { host: '', port: 993, secure: true },
    smtp: { host: '', port: 587, secure: false },
    cache: { ...CACHE_DEFAULTS }
  }
};

/** One account definition with its defaults filled in (idempotent). */
export function normalizeAccount(name, acct = {}) {
  const provider = PROVIDERS.includes(acct.provider) ? acct.provider : 'ews';
  const base = ACCOUNT_DEFAULTS[provider];
  return {
    ...base,
    ...acct,
    provider,
    name,
    cache: { ...CACHE_DEFAULTS, ...(acct.cache || {}) },
    ...(provider === 'imap'
      ? { imap: { ...base.imap, ...(acct.imap || {}) }, smtp: { ...base.smtp, ...(acct.smtp || {}) },
          // an IMAP mailbox may carry a calendar of its own: calendar: { provider: 'google' | 'caldav', … }
          ...(acct.calendar && acct.calendar.provider ? { calendar: { ...CALENDAR_DEFAULTS, ...acct.calendar } } : {}) }
      : { calendar: { ...CALENDAR_DEFAULTS, ...(acct.calendar === false ? { watch: false } : acct.calendar || {}) } })
  };
}

/** { name: def } or [{ name, … }] → { name: normalized def }. */
export function normalizeAccounts(accounts) {
  const out = {};
  const entries = Array.isArray(accounts) ? accounts.map((a) => [a && a.name, a]) : Object.entries(accounts || {});
  for (const [name, acct] of entries) {
    if (!name) throw new TypeError('mailcore: every account needs a name');
    out[name] = normalizeAccount(name, acct);
  }
  return out;
}

/** Which calendar backend an account has: 'ews' | 'caldav' | 'google' | null. */
export function calendarProvider(acct) {
  if (!acct) return null;
  if (acct.provider === 'ews') return 'ews';
  if (acct.provider === 'caldav' || acct.provider === 'google') return acct.provider;
  if (acct.provider === 'imap' && acct.calendar && ['google', 'caldav'].includes(acct.calendar.provider)) return acct.calendar.provider;
  return null;
}

export function hasMail(acct) { return !!acct && MAIL_PROVIDERS.includes(acct.provider); }

/** The name an account writes as (`displayName`): one line, control characters out, at most 100 characters; '' when none. */
export function displayNameOf(acct) {
  const v = typeof acct?.displayName === 'string' ? acct.displayName : '';
  return v.replace(/[\x00-\x1f\x7f\u2028\u2029]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 100);
}
