# @amenophis1er/mailcore

Mail and calendar accounts for Node: Exchange (EWS over NTLM), IMAP + SMTP, JMAP (any RFC 8621 server, such as
Fastmail), CalDAV (iCloud, Fastmail, any RFC 4791 server), Google Calendar, and Microsoft 365 / Outlook.com
mailboxes signed in with OAuth. Push (EWS streaming notifications, IMAP IDLE, JMAP event source), an encrypted
local cache (SQLCipher), search, plain-text reads, threads, attachments, drafts and send, calendars (list, events,
free/busy, free slots, create/update/delete/respond), and MCP-ready tools for agents.

Plain JS ESM, with types in `index.d.ts`. Node 20 or later.

**mailcore never reads a config file, a keychain, a password manager or the environment.** The caller hands in
the accounts, a credentials provider, the cache key and a data directory.

## Install

```sh
npm install @amenophis1er/mailcore
```

`zod` (^4) is a peer dependency, needed only for the tools (`@amenophis1er/mailcore/tools`).

## Quick start

```js
import { createMailcore } from '@amenophis1er/mailcore';

const mc = createMailcore({
  accounts: {
    work: { provider: 'ews', host: 'https://mail.example.org', username: 'me', domain: 'CORP', email: 'me@example.org' },
    home: { provider: 'imap', email: 'me@home.example', imap: { host: 'imap.home.example' }, smtp: { host: 'smtp.home.example' } }
  },
  defaultAccount: 'work',
  credentials: {
    // refresh: true after the server rejected the last password
    getPassword: async (account, { refresh }) => ({ username: account.username, password: await myStore.get(account.name, { refresh }) })
  },
  dataDir: '/path/to/data',                                  // cache.db, state.json, calendar-<account>.json
  cacheKey: ({ create }) => myStore.cacheKey({ create }),   // or a string; none = no cache
  timeZone: 'Europe/Paris',
  log: (line) => console.log(line)
});

const unread = await mc.find(undefined, { unreadOnly: true, limit: 20 });   // all accounts, newest first
const msg = await mc.read(unread[0].id);                    // plain text; { bodyType: 'HTML' } for HTML
const draft = await mc.reply(msg.id, 'Thanks, will do.');   // a draft; { send: true } sends
const week = await mc.calendar.listEvents({ start: new Date(), end: '+7d' });
```

`accounts`, `defaultAccount`, `timeZone` and `pollSeconds` may also be functions, read on each use, so settings
can change while the instance lives. `accounts` is a map by name, or an array of definitions with `name`.

## Providers

`provider` is one of `ews`, `imap`, `jmap` (mail, and calendar on EWS), `caldav`, `google` (calendar only).

### Exchange (EWS)

```js
work: { provider: 'ews', host: 'https://mail.example.org', username: 'me', domain: 'CORP', email: 'me@example.org' }
```

NTLM over EWS, with its calendar. `host` is the server root; `streaming: false` turns push off. A sign-in
redirected to another origin is refused (`EWS_REDIRECT`).

### IMAP + SMTP

```js
home: { provider: 'imap', email: 'me@home.example', imap: { host: 'imap.home.example' }, smtp: { host: 'smtp.home.example' } }
```

`imap` and `smtp` take `{ host, port?, secure?, rejectUnauthorized? }`; `smtp.requireTLS` with `secure: false`
means STARTTLS or nothing is sent. `imap.folders` names a folder (`inbox junk sent drafts trash archive`) the
server does not mark. An IMAP account may carry a calendar of its own: `calendar: { provider: 'caldav' | 'google', … }`.

### JMAP

```js
fm: { provider: 'jmap', email: 'me@example.org', jmap: { session: 'https://api.fastmail.com/jmap/session' } }
```

- The API key is the account's password: `getPassword` returns `{ password: '<api key>' }`, sent as
  `Authorization: Bearer <api key>`. A sign-in token works too (`{ oauth: async () => token }`, asked at each request).
- `jmap.session` is the session URL. A bare host (`mail.example.org`) means `https://mail.example.org/.well-known/jmap`;
  none at all means the email domain's `/.well-known/jmap`. A redirect is followed with the key only on the same
  origin; one to another host (or to http) is refused (`JMAP_UNSAFE`): set `jmap.session` to the session URL itself.
  `jmap.folders` names a mailbox for a folder the server gives no role (as `imap.folders`).
- Written to RFC 8620/8621 only: folders by mailbox role, sending by `EmailSubmission/set` (the identity of the From
  address, else the account's), drafts imported as raw messages, so they read and reply exactly as on IMAP.
- Push holds the session's `eventSourceUrl` (Server-Sent Events); a server without one is polled.
- Where the key goes: the session's `apiUrl`, `uploadUrl` and `eventSourceUrl` must be https on the session's host;
  `downloadUrl` https, on another host only when that is a public DNS name. Every host is resolved before the first
  request to it and refused when any of its addresses is private, loopback or link-local; IP-literal hosts are
  refused. A refusal is `JMAP_UNSAFE`, nothing sent. `jmap.allowPrivate: true` lifts these for tests against a
  local server only: never set it for a real account.
- Sending: a submission the server refuses removes the copy made for it; one whose answer never came (the line cut,
  a timeout, a 5xx) is `SEND_UNKNOWN` and the draft is kept. The copy kept in Sent has the Bcc header, as on IMAP.

### CalDAV

```js
cal: { provider: 'caldav', service: 'fastmail', username: 'me@fastmail.example' }
```

`service` is `icloud`, `fastmail` or `other` (then `server` is the CalDAV URL). The password comes from
`getPassword`; for the CalDAV calendar of an IMAP account, `account.name` is `"<account>/calendar"`. Changes are
made with SCHEDULE-AGENT=CLIENT (nothing is sent by the server), and free/busy for other people goes through the
server's scheduling outbox when it has one.

### Google Calendar (OAuth)

```js
const mc = createMailcore({
  accounts: { g: { provider: 'google', email: 'me@gmail.example' } },
  credentials: {
    getPassword,   // as above, for the other accounts
    google: { get: (account) => myStore.getJson(`google:${account}`), set: (account, tokens) => myStore.setJson(`google:${account}`, tokens) }
  },
  google: { clientId, clientSecret }   // a Google Cloud Desktop OAuth client
});

await mc.google.login('g', { openUrl: (url) => openInBrowser(url) });   // PKCE, loopback redirect
```

- `credentials.google` stores Google tokens (`{ refresh_token, access_token, expires_at, scope, … }`, or a JSON
  string). `scope` is what Google granted (`grantedScopes(tokens)` lists it); `refused_at` is set when Google
  refused a renewal. A renewal writes only over the sign-in it renewed, never over a newer one.
- `google.login(account, { openUrl })` blocks until done; `google.beginLogin(account)` returns
  `{ url, done, cancel }` to settle later. Options: `scopes`, `extraScopes` (`GOOGLE_CONTACTS_SCOPES` for contacts),
  `loginHint`, `timeoutMs`, `appName` (named on the page the browser tab shows at the end), and
  `accept(tokens, { signal })`, asked after the code exchange and before anything is stored (true, a reason to
  refuse, or fields to keep beside the tokens; `googleAccountAddress(accessToken)` says which Google account signed
  in). The loopback server answers one request, a GET of `/` with Host `127.0.0.1:<port>` and the state sent.
  `cancel()` returns whether it ended the sign-in.
- `google` is `{ clientId, clientSecret, signInHint? }` or a function returning it (asked each time).
  `signInHint(account)` is what a Google auth error tells the user to do (default "sign in to Google again").
- `google.contacts(account, { lists })` (also `googleContacts(account, { accessToken })`) reads the People API:
  `{ saved, other, errors }`, each list `{ name, email, emails, kind, photo?, company?, title? }`, or null when
  Google refused it, its reason in `errors`. Nothing is kept: where contacts go is the caller's choice.

### Microsoft 365 and Outlook.com (OAuth)

Microsoft mailboxes are IMAP + SMTP accounts signed in with OAuth (Microsoft has turned basic authentication off).
`microsoftAuth` runs the sign-in (PKCE, loopback redirect, a public client: no secret) and renews tokens; the
caller keeps them.

```js
import { createMailcore, microsoftAuth, microsoftServers } from '@amenophis1er/mailcore';

const ms = microsoftAuth({
  clientId: '<app id registered in Microsoft Entra>',   // or client: () => ({ clientId })
  store: { get: (account) => myStore.getJson(`ms:${account}`), set: (account, tokens) => myStore.setJson(`ms:${account}`, tokens) }
});

const flow = await ms.beginLogin('outlook', { appName: 'My app' });
openInBrowser(flow.url);
const signedIn = await flow.done;            // what was stored, with email, name and personal from the ID token

const mc = createMailcore({
  accounts: { outlook: { provider: 'imap', email: signedIn.email, ...microsoftServers(signedIn.personal) } },
  credentials: { getPassword: async (account) => ({ username: account.email, oauth: () => ms.accessToken(account.name) }) }
});
```

- `microsoftServers(personal)` gives Outlook's IMAP and SMTP settings (personal accounts send through
  `smtp-mail.outlook.com`, work and school ones through `smtp.office365.com`).
- `beginLogin(account, opts)` options: `loginHint`, `timeoutMs`, `appName`, `accept(tokens, { signal })`, and
  `redirectUri` (an https address of your own instead of the loopback; then `flow.complete({ state, code })`).
- `accessToken(account, { force? })` renews as needed (Microsoft rotates the refresh token; the new one is kept);
  `signedIn(account)` says whether a refresh token is stored. A refused renewal is `MAIL_AUTH`.
- Scopes: `MICROSOFT_MAIL_SCOPES` (Outlook IMAP and SMTP, `offline_access`, `openid email profile`).

## Credentials

- `credentials.getPassword(account, { refresh })` returns `{ username?, domain?, password }`, or
  `{ username?, oauth }` where `oauth()` returns an access token, asked fresh at each connection. On an auth failure
  mailcore retries once with the same credentials (NTLM 401s are sometimes transient), then once with
  `refresh: true`.
- A client's `close()` starts the sign-out without waiting for it (an IMAP LOGOUT is waited for at most 5 s even
  then); `close({ wait: true })` resolves once it is done.

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
| `awaitingThem({ account?, days?, limit?, olderThanHours? })` | threads whose last message is mine, to someone else, unanswered |
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
| `google.login`, `google.beginLogin`, `google.signedIn`, `google.tokens`, `google.contacts` | Google sign-in and contacts (above) |

Also exported: `EventLog` (a cursor-backed, bounded, optionally persisted event queue with long-poll `wait()` and
an async iterator `events()`), rule matching (`ruleMatches`, `matchRule`, `accountOk`, `inQuietHours`), date
helpers (`parseWhen`, `parseDuration`, `dayStart`), body helpers (`prepareBody`, `replaceAboveQuote`,
`htmlToText`, …), thread helpers, stores (`jsonFileStore`, `memoryStore`), and account normalization
(`normalizeAccount`, `jmapSessionUrl`, `PROVIDERS`, …).

## The encrypted cache

With a `cacheKey` and a `dataDir`, mailcore keeps an encrypted copy of the inbox in `<dataDir>/cache.db`
(SQLCipher): headers always, bodies of new mail, for the last 30 days by default. Per account:
`cache: { enabled, days, bodies }`.

- `cacheKey` is a string, or `({ create }) => key | null`. Readers ask with `create: false` and never make a
  cache; the watcher asks with `create: true` the first time. mailcore never stores the key. A cache the key does
  not open is `CACHE_KEY`.
- The cache serves inbox listings only while a watcher has polled within 3× `pollSeconds` (the watcher writes
  `lastPollAt` to the `state` store); `cacheFresh(accounts)` replaces that test. `{ live: true }` on `find` or
  `read` goes to the server.
- `cache.cacheStats()`, `cache.prune()` and `cache.clearCache()` manage it.

## Push and watching

```js
const w = await mc.watch({ pollSeconds: 30 });
w.on('mail', ({ account, items }) => { /* new unread mail of one poll */ });
w.on('calendar', ({ account, changes }) => { /* created / updated / cancelled / deleted, `loud` for invitations */ });
w.on('reminder', (event) => { /* remindMinutes before start */ });
await w.start();
```

Each account is polled and, where the server offers it, pushed: EWS streaming notifications, IMAP IDLE, the JMAP
event source. The first poll of an account sets a baseline and reports nothing. Seen ids, and seen Message-IDs
(so a mail moved out of the inbox and back is not new), live in the `state` store (default
`<dataDir>/state.json`), so a restart does not re-announce mail. The Message-IDs are shared by all accounts on
purpose: a mail delivered to two of your accounts emits one `mail` event, from whichever account polls first.

`authGate: (account) => ({ blocked(), ok(), failed(err) })` lets the caller pause an account whose sign-in is
rejected: its poll, push stream and calendar refresh all wait while `blocked()`, and each tells the gate how
sign-in went.

## MCP tools (`@amenophis1er/mailcore/tools`)

Mail and calendar tools as plain objects any agent host can serve in-process, ready to list as MCP tools. They are
static, so a manifest can declare them before any instance exists; the instance comes with each call. zod (^4) is
a peer dependency: the schemas are your zod.

```js
import { mailTools, mailInstructions, MAIL_INSTRUCTIONS } from '@amenophis1er/mailcore/tools';

const tools = mailTools({ allowSend: false });    // [{ name, description, input: z.object, effect, effectFor?, run }]
const out = await tools[0].run(mc, { limit: 5 }, { signal });   // the data an MCP server sends as JSON text
const instructions = mailInstructions({ allowSend: false, name: 'my-app' });   // server instructions to go with them
```

`mailTools` options: `allowSend`, `attachmentsDir` (default `<dataDir>/attachments`), `attachmentsLabel` (how the
description names it), `sendDisabledHint` (what the refusal tells the user to do to allow sending).

`effect`, strictest first: `others` (sends mail to someone, or changes a meeting that has other attendees:
send_draft, create/update/delete_event, respond_to_event), `own-calendar` (an appointment with nobody else),
`draft`, `local` (mark_read, save_attachments), `read`. For create/update/delete_event, `effect` is the worst case
and `effectFor(core, args)` gives the effect of one call. Without `allowSend`, send_draft is absent and calendar
calls that would mail someone throw before doing anything.

## Errors

Errors are plain `Error`s with a `code`:

| code | meaning |
|---|---|
| `MAIL_AUTH`, `EWS_AUTH` | the sign-in was refused (`isAuthError(e)` tests for both) |
| `MAIL_NETWORK` | the server could not be reached |
| `MAIL_BUSY` | an IMAP account stayed busy longer than `turnWaitMs` (default 20000 ms) |
| `SEND_UNKNOWN` | a send whose answer never came: check Sent before sending again |
| `JMAP_UNSAFE`, `EWS_REDIRECT` | refused because the key or the sign-in would go somewhere unsafe |
| `NO_MAIL`, `NO_CALENDAR` | the account holds no mail (calendar only), or has no calendar |
| `CACHE_KEY` | the cache cannot be decrypted with the key given |
| `SIGN_IN_TIMEOUT`, `SIGN_IN_CANCELLED`, `SIGN_IN_REFUSED`, `SIGN_IN_REJECTED`, `SIGN_IN_FAILED` | an OAuth sign-in that did not finish (refused by the provider or the person; rejected by `accept`) |
| `GOOGLE_SCOPE`, `GOOGLE_API_DISABLED`, `GOOGLE_RATE`, `GOOGLE_API` | Google refused a contacts list |

On JMAP, any other 403 or a 5xx carries its HTTP `status` and is not an auth error.

## Tests

`npm test` runs `node --test` over the parts that need no network (the tool table, bodies, iCalendar, DAV XML,
EWS request building and parsing, JMAP, rules, the event log, thread heuristics, the encrypted cache, the
auth-retry policy, OAuth sign-ins against fake servers). `npm run typecheck` compiles a strict NodeNext consumer
against `index.d.ts`.

## Licence

To be announced.
