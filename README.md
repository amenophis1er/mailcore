# mailcore

Mail and calendar accounts for Node: Exchange (EWS over NTLM), IMAP + SMTP, JMAP (Fastmail, Mailflare, any
RFC 8621 server), CalDAV (iCloud, Fastmail, any RFC 4791 server) and Google Calendar. Push (EWS streaming
notifications, IMAP IDLE, JMAP event source), an encrypted local cache
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
| `find(account?, opts?, onError?)` | listing/search across accounts, newest first: `limit offset unreadOnly flaggedOnly senderContains subjectContains toContains text fromMe hasAttachments sinceIso untilIso folder live` |
| `read(id, { bodyType?, live? })` | one message with body, recipients and attachment list |
| `getThread({ id?, subject?, days?, account?, limit? })` | a thread across Inbox and Sent, oldest first |
| `awaitingReply({ account?, days?, limit?, includeCc?, since? })` | threads whose last message is theirs, unanswered |
| `awaitingThem({ account?, days?, limit?, olderThanHours? })` | threads whose last message is mine, to someone else, unanswered (`memo` shares the gathering with `awaitingReply`) |
| `getAttachment(id, attachmentId)`, `saveAttachments(id, dir, { only? })` | attachments |
| `reply(id, body, { all?, send?, bodyType? })`, `forward(id, body, { to?, cc?, bcc? })`, `compose({ account, to, cc, bcc, subject, body, bodyType, send? })` | drafts and send |
| `updateDraft({ id, …, keepQuoted? })`, `addAttachment(id, ck, att)`, `removeAttachment(id, ck, attId)`, `deleteItem(id)`, `markRead(id, isRead?)`, `setFlag(id, flagged?)`, `send(id)` | draft and message changes |
| `moveItems(ids, folder, { onError? })` | move across accounts: old id → new id (null: no longer there); ids missing were not moved |
| `people(q, { accounts?, limit? })` | people of the cached mail (senders and fellow recipients, newsletters and robots out) |
| `client(name)`, `withClient(account, fn)` | an `AccountClient` for anything else, with the auth-retry policy |
| `calendar.*` | `calendarAccounts listCalendars listEvents listAllEvents readEvent createEvent updateEvent deleteEvent respondToEvent freeBusy findFreeSlots resolveCalendar` |
| `watch(opts)` → `MailWatch` | polling + push per account; events `mail baseline poll failure stream calendar reminder` |
| `watchCalendar(account, opts)` | one calendar's changes and reminders |
| `stream(name, hooks)` | the raw push stream of one account |
| `cache.*` | `cachedAccounts cacheUsable findCached getCached cacheStats prune clearCache`, and for a watcher of its own `upsertItems dropUnlisted reconcile noteSent applyChanges getMeta setMeta idsOf threadCounts snippets texts people …` |
| `google.login(account, { openUrl })`, `google.beginLogin(account)`, `google.signedIn(account)`, `google.tokens(account)` | Google sign-in (PKCE, loopback): blocking, or started and settled later (`{ url, done, cancel }`); what was granted |
| `google.contacts(account, { lists })` | a Google account's contacts (People API, read only, paged): `{ saved, other, errors }`, nothing kept |

Also exported: `EventLog` (a cursor-backed, bounded, optionally persisted event queue with long-poll `wait()` and
an async iterator `events()`), rule matching (`ruleMatches`, `matchRule`, `accountOk`, `inQuietHours`), date
helpers (`parseWhen`, `parseDuration`, `dayStart`), body helpers (`prepareBody`, `replaceAboveQuote`,
`htmlToText`, …), thread helpers, and account normalization.

### JMAP accounts

```js
fm: { provider: 'jmap', email: 'me@example.org', jmap: { session: 'https://api.fastmail.com/jmap/session' } }
```

- The API key is the account's password: `getPassword` returns `{ password: '<api key>' }`, sent as
  `Authorization: Bearer <api key>`. A sign-in token works too (`{ oauth: async () => token }`, asked at each request).
- `jmap.session` is the session URL. A bare host (`mail.example.org`) means `https://mail.example.org/.well-known/jmap`;
  none at all means the email domain's `/.well-known/jmap`. A redirect is followed with the key only on the same
  origin; one to another host (or to http) is refused (`JMAP_UNSAFE`): set `jmap.session` to the session URL itself. `jmap.folders` names a mailbox for a folder the server gives no role (as `imap.folders`).
- Written to RFC 8620/8621 only: folders by mailbox role, sending by `EmailSubmission/set` (the identity of the From
  address, else the account's), drafts imported as raw messages, so they read and reply exactly as on IMAP.
- Push holds the session's `eventSourceUrl` (Server-Sent Events); a server without one is polled. No
  `changesIn`/`newSince` (those are IMAP UID marks): a watcher keeps a JMAP account in step by listing it, as Exchange.
- Where the key goes: the session's `apiUrl`, `uploadUrl` and `eventSourceUrl` must be https on the session's host;
  `downloadUrl` https, on another host only when that is a public DNS name (Fastmail's is on
  www.fastmailusercontent.com). Every host is resolved before the first request to it and refused when any of its
  addresses is private, loopback or link-local; IP-literal hosts are refused. A refusal is `JMAP_UNSAFE`, nothing
  sent. `jmap.allowPrivate: true` lifts these for tests against a local server only: never set it for a real account.
- A 401 (and a 403 to the session fetch) is `MAIL_AUTH`; an unreachable server is `MAIL_NETWORK`; any other 403 or
  a 5xx carries its `status` and is not an auth error.
- Sending: a submission the server refuses removes the copy made for it; one whose answer never came (the line cut,
  a timeout, a 5xx) is `SEND_UNKNOWN` ("the server may have sent it: check Sent before sending again") and the draft
  is kept. The copy kept in Sent has the Bcc header, as on IMAP.

### Credentials and the cache key

- `credentials.getPassword(account, { refresh })` returns `{ username?, domain?, password }`. On an auth failure
  mailcore retries once with the same credentials (NTLM 401s are sometimes transient), then once with
  `refresh: true`. For the CalDAV calendar of an IMAP account, `account.name` is `"<account>/calendar"`.
- `credentials.google` stores Google tokens (`{ refresh_token, access_token, expires_at, scope, … }`, or a JSON string).
  `scope` is what Google granted (`grantedScopes(tokens)` lists it); `refused_at` is set when Google refused a renewal.
- A sign-in asks for the calendar (`GOOGLE_SCOPES`) unless told otherwise: `scopes`, `extraScopes`
  (`GOOGLE_CONTACTS_SCOPES` for contacts), `loginHint`, `timeoutMs`, `appName` (named on the page the browser tab
  shows at the end). Its loopback server answers one request, a GET of `/` with Host `127.0.0.1:<port>` and the
  state sent; another path, Host or state is refused without ending it.
  `accept(tokens, { signal })` is asked after the code exchange and before anything is stored (true, a reason to
  refuse, or fields to keep beside the tokens — `googleAccountAddress(accessToken)` says which Google account
  signed in). `cancel()` returns whether it ended the sign-in: during the exchange and `accept` it aborts them and
  nothing is stored; once storing has begun it returns false and `done` gives the outcome. A renewal writes only
  over the sign-in it renewed, never over a newer one.
- `google.contacts(account)` (also `googleContacts(account, { accessToken })`) reads the People API with the
  `GOOGLE_CONTACTS_SCOPES`: `saved` (people/me/connections) and `other` (otherContacts), each a list of
  `{ name, email, emails, kind, photo?, company?, title? }` (only contacts with an address; `photo` only when it is
  not Google's placeholder), or null when Google refused that list, its reason in `errors` (`GOOGLE_SCOPE`,
  `GOOGLE_API_DISABLED`, `GOOGLE_RATE`, `GOOGLE_API`). A 401 is retried once with a renewed token, then throws
  `MAIL_AUTH`; every list failing throws. Nothing is kept: where contacts go is the caller's choice.
- `google` is the OAuth client, `{ clientId, clientSecret, signInHint? }`, or a function returning it (asked each
  time one is needed, so a changed setting is seen). `signInHint(account)` is what a Google auth error tells the
  user to do (default "sign in to Google again").
- A client's `close()` starts the sign-out without waiting for it (an IMAP LOGOUT is waited for at most 5 s even
  then); `close({ wait: true })` resolves once it is done.
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

The first poll of an account sets a baseline and reports nothing. Seen ids, and seen Message-IDs (so a mail moved
out of the inbox and back is not new), live in the `state` store (default `<dataDir>/state.json`), so a restart
does not re-announce mail. The Message-IDs are shared by all accounts on purpose: a mail delivered to two of your
accounts emits one `mail` event, from whichever account polls first.

`authGate: (account) => ({ blocked(), ok(), failed(err) })` lets the caller pause an account whose sign-in is
rejected: its poll, push stream and calendar refresh all wait while `blocked()`, and each tells the gate how
sign-in went.

## Tools (`mailcore/tools`)

MailWatcher's MCP mail and calendar tools, as plain objects any agent host can serve in-process, under the same
names, descriptions, schemas and outputs. They are static, so a manifest can declare them before any instance
exists; the instance comes with each call. zod (^4) is a peer dependency: the schemas are your zod.

```js
import { mailTools, mailInstructions, MAIL_INSTRUCTIONS } from 'mailcore/tools';

const tools = mailTools({ allowSend: false });    // [{ name, description, input: z.object, effect, effectFor?, run }]
const out = await tools[0].run(mc, { limit: 5 }, { signal });   // the data an MCP server sends as JSON text
```

`effect`, strictest first: `others` (sends mail to someone, or changes a meeting that has other attendees:
send_draft, create/update/delete_event, respond_to_event), `own-calendar` (an appointment with nobody else),
`draft`, `local` (mark_read, save_attachments), `read`. For create/update/delete_event, `effect` is the worst case
and `effectFor(core, args)` gives the effect of one call. Without `allowSend`, send_draft is absent and calendar
calls that would mail someone throw before doing anything. MailWatcher adds `next_event`, `wait_for_mail` and the
rule tools on top, as they need its daemon and its rules file.

## Tests

`npm test` runs `node --test` over the parts that need no network (the tool table against MailWatcher's tools/list, bodies, iCalendar, DAV XML, EWS request
building and parsing, rules, the event log, thread heuristics, the encrypted cache, the auth-retry policy).
`npm run typecheck` compiles a strict NodeNext consumer against `index.d.ts`.
