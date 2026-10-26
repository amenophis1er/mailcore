# mailcore

Mail and calendar accounts for Node: Exchange (EWS over NTLM), IMAP + SMTP, CalDAV (iCloud, Fastmail, any
RFC 4791 server) and Google Calendar. Push (EWS streaming notifications, IMAP IDLE), an encrypted local cache
(SQLCipher), search, plain-text reads, threads, attachments, drafts and send, and calendars (list, events,
free/busy, free slots, create/update/delete/respond).

Taken out of MailWatcher, which now runs on it. Plain JS ESM, with types in `index.d.ts`.

**mailcore never reads a config file, a keychain, a password manager or the environment.** The caller hands in
the accounts, a credentials provider, the cache key and a data directory.

## Use

```js
import { createMailcore } from 'mailcore';

const mc = createMailcore({
  accounts: {
    work: { provider: 'ews', host: 'https://mail.example.org', username: 'me', domain: 'CORP', email: 'me@example.org' },
    home: { provider: 'imap', email: 'me@home.example', imap: { host: 'imap.home.example' }, smtp: { host: 'smtp.home.example' } },
    cal:  { provider: 'caldav', service: 'fastmail', username: 'me@fastmail.example' },
    g:    { provider: 'google', email: 'me@gmail.example' }
  },
  defaultAccount: 'work',
  credentials: {
    // refresh: true after the server rejected the last password
    getPassword: async (account, { refresh }) => ({ username: account.username, password: await myStore.get(account.name, { refresh }) }),
    google: { get: (account) => myStore.getJson(`google:${account}`), set: (account, tokens) => myStore.setJson(`google:${account}`, tokens) }
  },
  dataDir: '/path/to/data',            // cache.db, state.json, calendar-<account>.json
  cacheKey: ({ create }) => myStore.cacheKey({ create }),   // or a string; none = no cache
  google: { clientId, clientSecret },  // a Google Cloud Desktop OAuth client, for Google calendars
  timeZone: 'Europe/Paris',
  log: (line) => console.log(line)
});

const unread = await mc.find(undefined, { unreadOnly: true, limit: 20 });
const msg = await mc.read(unread[0].id);                 // plain text; { bodyType: 'HTML' } for HTML
const draft = await mc.reply(msg.id, 'Thanks — will do.'); // a draft; { send: true } sends
const week = await mc.calendar.listEvents({ start: new Date(), end: '+7d' });
```

`accounts`, `defaultAccount`, `timeZone` and `pollSeconds` may also be functions, read on each use, so settings
can change while the instance lives.

## API

Ids are `"<account>:<id>"` everywhere, so any id routes back to its account.

| | |
|---|---|
| `createMailcore(options)` | the instance (`options` in `index.d.ts`: `MailcoreOptions`) |
| `accountNames()`, `mailAccountNames()`, `account(name?)`, `listAccounts()`, `selectAccounts(name?)` | accounts |
| `find(account?, opts?, onError?)` | listing/search across accounts, newest first: `limit offset unreadOnly senderContains subjectContains toContains text fromMe hasAttachments sinceIso untilIso folder live` |
| `read(id, { bodyType?, live? })` | one message with body, recipients and attachment list |
| `getThread({ id?, subject?, days?, account?, limit? })` | a thread across Inbox and Sent, oldest first |
| `awaitingReply({ account?, days?, limit?, includeCc?, since? })` | threads whose last message is theirs, unanswered |
| `getAttachment(id, attachmentId)`, `saveAttachments(id, dir, { only? })` | attachments |
| `reply(id, body, { all?, send?, bodyType? })`, `compose({ account, to, cc, subject, body, bodyType, send? })` | drafts and send |
| `updateDraft({ id, …, keepQuoted? })`, `addAttachment(id, ck, att)`, `deleteItem(id)`, `markRead(id, isRead?)`, `send(id)` | draft and message changes |
| `client(name)`, `withClient(account, fn)` | an `AccountClient` for anything else, with the auth-retry policy |
| `calendar.*` | `calendarAccounts listCalendars listEvents readEvent createEvent updateEvent deleteEvent respondToEvent freeBusy findFreeSlots resolveCalendar` |
| `watch(opts)` → `MailWatch` | polling + push per account; events `mail baseline poll failure stream calendar reminder` |
| `watchCalendar(account, opts)` | one calendar's changes and reminders |
| `stream(name, hooks)` | the raw push stream of one account |
| `cache.*` | `cachedAccounts cacheUsable findCached getCached cacheStats prune clearCache …` |
| `google.login(account, { openUrl })`, `google.signedIn(account)` | Google sign-in (PKCE, loopback) |

Also exported: `EventLog` (a cursor-backed, bounded, optionally persisted event queue with long-poll `wait()` and
an async iterator `events()`), rule matching (`ruleMatches`, `matchRule`, `accountOk`, `inQuietHours`), date
helpers (`parseWhen`, `parseDuration`, `dayStart`), body helpers (`prepareBody`, `replaceAboveQuote`,
`htmlToText`, …), thread helpers, and account normalization.

### Credentials and the cache key

- `credentials.getPassword(account, { refresh })` returns `{ username?, domain?, password }`. On an auth failure
  mailcore retries once with the same credentials (NTLM 401s are sometimes transient), then once with
  `refresh: true`. For the CalDAV calendar of an IMAP account, `account.name` is `"<account>/calendar"`.
- `credentials.google` stores Google tokens (`{ refresh_token, access_token, expires_at, … }`, or a JSON string).
- `cacheKey` is the SQLCipher key: a string, or `({ create }) => key | null`. Readers ask with `create: false` and
  never make a cache; the watcher asks with `create: true` the first time. mailcore never stores the key.
- The cache serves inbox listings only while a watcher has polled within 3× `pollSeconds` (the watcher writes
  `lastPollAt` to the `state` store); `cacheFresh(accounts)` replaces that test.

### Watching

```js
const w = await mc.watch({ pollSeconds: 30 });
w.on('mail', ({ account, items }) => { /* new unread mail of one poll */ });
w.on('calendar', ({ account, changes }) => { /* created / updated / cancelled / deleted, `loud` for invitations */ });
w.on('reminder', (event) => { /* remindMinutes before start */ });
await w.start();
```

The first poll of an account sets a baseline and reports nothing. Seen ids live in the `state` store (default
`<dataDir>/state.json`), so a restart does not re-announce mail.

## Tests

`npm test` runs `node --test` over the parts that need no network (bodies, iCalendar, DAV XML, EWS request
building and parsing, rules, the event log, thread heuristics, the encrypted cache, the auth-retry policy).
`npm run typecheck` compiles a strict NodeNext consumer against `index.d.ts`.
