// mailcore: mail and calendar accounts (Exchange/EWS, IMAP+SMTP, JMAP, CalDAV,
// Google) with push, an encrypted cache, drafts and calendars. One entry
// point; configuration and secrets are always handed in by the caller.

import { Mailcore } from './core.js';

/** Build an instance. See README.md and index.d.ts for the options. */
export function createMailcore(options) {
  return new Mailcore(options);
}

export { Mailcore } from './core.js';
export { htmlToText, plainText } from './text.js';
export { AccountClient, splitId, idParts, isAuthError } from './client.js';
export { PROVIDERS, MAIL_PROVIDERS, CACHE_DEFAULTS, CALENDAR_DEFAULTS, ACCOUNT_DEFAULTS, normalizeAccount, normalizeAccounts, calendarProvider, hasMail, displayNameOf, jmapSessionUrl } from './accounts.js';
export { MailWatch } from './watch.js';
export { watchCalendar } from './calendar-watch.js';
export { EventLog, gapInfo, matchesFilter, QUEUED_TYPES, MAIL_TYPES } from './event-log.js';
export { ruleMatches, matchRule, accountOk, inQuietHours, splitList } from './rules.js';
export { parseWhen, parseDuration, dayStart } from './calendar.js';
export { normalizeSubject, askedSomething, unquoted, snippet, groupThreads, looksBulk } from './awaiting.js';
export { prepareBody, replaceAboveQuote, splitQuoted, splitBreaks, markdownToHtml, textToHtml, escapeHtml, BODY_FORMATS } from './body.js';
export { GOOGLE_SCOPES, GOOGLE_CONTACTS_SCOPES, GOOGLE_CONTACTS_WRITE_SCOPE, GOOGLE_CONTACTS_WRITE_SCOPES, contactsAllowed, grantedScopes, googleAccountAddress } from './google-auth.js';
export { googleContacts, googleCreateContact, contactOf as googleContactOf } from './google-contacts.js';
export { microsoftAuth, microsoftServers, idTokenClaims, MICROSOFT_MAIL_SCOPES, MICROSOFT_PERSONAL_TENANT } from './microsoft-auth.js';
export { jsonFileStore, memoryStore } from './store.js';
export { AUTH_HEADER_NAMES, OVERSIZED, authHeadersFrom, headerPairs } from './auth-headers.js';
export { isAutoReply, AUTO_REPLY_HEADERS } from './auto-reply.js';
