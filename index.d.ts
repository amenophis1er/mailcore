// Types for mailcore's public API (the code is plain JS ESM).

import { EventEmitter } from 'node:events';

// --- accounts -----------------------------------------------------------------

export type Provider = 'ews' | 'imap' | 'jmap' | 'caldav' | 'google';
export type CalendarProvider = 'ews' | 'caldav' | 'google';

export interface CacheSettings { enabled?: boolean; days?: number; bodies?: boolean }
export interface CalendarSettings {
  watch?: boolean;
  remindMinutes?: number | number[];
  notify?: boolean;
  sound?: string | false;
  lookaheadDays?: number;
  pollMinutes?: number;
}
export interface ServerSettings { host: string; port?: number; secure?: boolean; rejectUnauthorized?: boolean }
export interface SmtpSettings extends ServerSettings {
  /** Not encrypted from the start (secure: false): STARTTLS is required, or nothing is sent. */
  requireTLS?: boolean;
}

export interface AccountDefinition {
  /** Required in the array form; the map key otherwise. */
  name?: string;
  provider?: Provider;
  email?: string;
  username?: string;
  /** EWS: the server root, e.g. https://mail.example.org */
  host?: string;
  /** EWS: NTLM domain */
  domain?: string;
  /** EWS: false turns push (streaming notifications) off */
  streaming?: boolean;
  imap?: ServerSettings;
  smtp?: SmtpSettings;
  /**
   * JMAP: `session` is the session URL (e.g. https://api.fastmail.com/jmap/session); a bare host means
   * https://<host>/.well-known/jmap, and none the email domain's. The password is the API key (a Bearer token).
   * `folders` names a mailbox (path or name) for a folder the server gives no role.
   */
  jmap?: { session?: string; folders?: Partial<Record<'inbox' | 'junk' | 'sent' | 'drafts' | 'trash' | 'archive', string>> };
  /** CalDAV: icloud | fastmail | other */
  service?: string;
  server?: string;
  hostPattern?: string;
  /** Other addresses that are mine (awaiting-reply). */
  aliases?: string[];
  /** The name mail is written as; on IMAP, the name in the From of what is sent and drafted (see displayNameOf). */
  displayName?: string;
  cache?: CacheSettings;
  /** For IMAP accounts: a calendar of their own ({ provider: 'google' | 'caldav', … }). */
  calendar?: CalendarSettings & Partial<Pick<AccountDefinition, 'email' | 'username' | 'server' | 'service' | 'hostPattern'>> & { provider?: 'google' | 'caldav' } | false;
  [extra: string]: unknown;
}

export interface Account extends AccountDefinition {
  name: string;
  provider: Provider;
  cache: Required<CacheSettings>;
  calendar?: CalendarSettings & Record<string, unknown>;
}

export type AccountsInput = Record<string, AccountDefinition> | AccountDefinition[];
type Lazy<T> = T | (() => T);

export interface AccountSummary {
  name: string;
  provider: Provider;
  email: string;
  mail: boolean;
  calendar: CalendarProvider | null;
  cached: boolean;
}

// --- credentials --------------------------------------------------------------

export interface PasswordCredentials {
  username?: string;
  domain?: string;
  password: string;
}

export interface GoogleTokens {
  refresh_token: string;
  access_token?: string;
  expires_at?: number;
  /** the scopes granted, space-separated (the token response's `scope`) */
  scope?: string;
  signed_in_at?: string;
  /** when Google refused to renew it (invalid_grant) */
  refused_at?: string;
  [extra: string]: unknown;
}

export interface GoogleSignInOptions {
  /** the scopes asked for (default GOOGLE_SCOPES) */
  scopes?: string[];
  /** asked for besides `scopes` */
  extraScopes?: string[];
  /** the address to sign in as (preselected by Google) */
  loginHint?: string;
  /** how long the loopback server waits (default 10 minutes) */
  timeoutMs?: number;
  /** what the page shown at the end tells to return to */
  appName?: string;
  /**
   * Called after the code was exchanged, before anything is stored: true stores the tokens; a string (why not)
   * stores nothing and ends the sign-in (SIGN_IN_REJECTED); an object adds its fields beside the tokens.
   */
  accept?: (tokens: GoogleTokens, ctx: { signal: AbortSignal }) => Promise<true | string | Record<string, unknown>> | true | string | Record<string, unknown>;
}

export interface GoogleSignIn {
  /** Google's consent page, to open in a browser */
  url: string;
  redirectUri: string;
  scopes: string[];
  done: Promise<GoogleTokens>;
  /** Ends it: true when it did (nothing stored); false once the tokens are being stored, or it ended (done says how). */
  cancel(): boolean;
}

export interface CredentialsProvider {
  /**
   * The password for an account. `refresh: true` comes after the server
   * rejected the last one: fetch it fresh from its source. For the CalDAV
   * calendar carried by an IMAP account, `account.name` is "<account>/calendar".
   */
  getPassword(account: Account, opts: { refresh: boolean }): PasswordCredentials | Promise<PasswordCredentials>;
  /** Token store for Google calendar accounts. */
  google?: {
    get(account: string): GoogleTokens | string | null | undefined | Promise<GoogleTokens | string | null | undefined>;
    set(account: string, tokens: GoogleTokens): void | Promise<void>;
  };
}

/** A string, or a function asked for the key; with create: true it may make and store one. */
export type CacheKey = string | ((opts: { create: boolean }) => string | null | undefined);

/** load() may return null/undefined (nothing stored yet): mailcore treats it as {}. */
export interface StateStore<T = Record<string, unknown>> {
  load(): T | null | undefined;
  save(value: T): void;
}

export interface MailcoreOptions {
  accounts: Lazy<AccountsInput>;
  defaultAccount?: Lazy<string | null | undefined>;
  credentials: CredentialsProvider;
  /** Where cache.db and (by default) state.json and calendar snapshots live. */
  dataDir?: string | null;
  /** No key, no cache. */
  cacheKey?: CacheKey | null;
  /** Watcher state (seen ids, baselines, lastPollAt, stream states); default <dataDir>/state.json. */
  state?: StateStore;
  /** IANA zone for all-day events and free slots; default: this machine's. */
  timeZone?: Lazy<string | null | undefined>;
  /** The watcher's poll interval; also how stale the cache may be (3×). Default 30. */
  pollSeconds?: Lazy<number>;
  /** The OAuth client used for Google calendars. */
  /**
   * The OAuth client used for Google calendars (or a function returning it, asked each time one is needed).
   * signInHint(account): what a Google auth error tells the user to do (default "sign in to Google again").
   */
  google?: Lazy<{ clientId?: string; clientSecret?: string; signInHint?: (account: string) => string }>;
  /** Replaces the default "a watcher polled within 3× pollSeconds" test for serving from the cache. */
  cacheFresh?: (accounts: string[]) => boolean;
  /** how long a use waits its turn at an IMAP account (a few at a time) before it is refused as busy, MAIL_BUSY (ms; default 20000) */
  turnWaitMs?: number;
  log?: (message: string) => void;
}

// --- mail ---------------------------------------------------------------------

export type Folder = 'inbox' | 'junk' | 'sent' | 'drafts' | 'trash' | 'archive';
export type BodyType = 'Text' | 'HTML';

export interface FindOptions {
  limit?: number;
  offset?: number;
  unreadOnly?: boolean;
  /** Flagged for follow-up (Exchange) or starred (IMAP \Flagged); never served from the cache. */
  flaggedOnly?: boolean;
  senderContains?: string;
  subjectContains?: string;
  toContains?: string;
  /** with any of these addresses: who wrote it, whom it was written to, or who was in copy (one search for a person's mail in a folder) */
  withAny?: string[];
  /** Subject OR body; several terms all match. */
  text?: string | string[];
  fromMe?: boolean;
  hasAttachments?: boolean;
  sinceIso?: string;
  untilIso?: string;
  folder?: Folder;
  /** Bypass the cache. */
  live?: boolean;
}

export interface Mailbox { name: string; email: string }

export interface ListItem {
  /** "<account>:<raw id>" */
  id: string;
  account: string;
  changeKey: string;
  subject: string;
  fromName: string;
  fromEmail: string;
  displayTo: string;
  isRead: boolean;
  /** Absent where the listing does not say. */
  isFlagged?: boolean;
  hasAttachments: boolean;
  /** ISO */
  received: string;
  conversationId?: string;
  messageId?: string;
  inReplyTo?: string;
  cached?: boolean;
}

export interface AttachmentInfo { id: string; name: string; size: number; contentType: string; inline: boolean }

export interface Message extends ListItem {
  to: Mailbox[];
  cc: Mailbox[];
  /** Only on a draft or a sent copy of one's own. */
  bcc?: Mailbox[];
  /** Where a reply goes when not to the sender (empty: to the sender). */
  replyTo?: Mailbox[];
  attachments: AttachmentInfo[];
  bodyType: BodyType;
  body: string;
  isBulk?: boolean;
  references?: string;
  /** The headers that say who really sent it, as the message holds them (absent where the backend cannot say). */
  authHeaders?: AuthHeaders;
}

/** Raw authentication headers of a message: what to trust of them is the caller's. */
export interface AuthHeaders {
  /** Every Authentication-Results header, topmost (the last receiving server's) first; at most 10. */
  results: string[];
  /** The BIMI-Selector header ('' when none). */
  bimiSelector: string;
  /** X-MS-Exchange-Organization-AuthAs (Exchange: Anonymous, Internal…; '' when none). */
  msAuthAs: string;
  /** X-Gmail-Fetch-Info: Gmail fetched it from another mailbox (POP/Gmailify), so its servers did not receive it ('' when none). */
  gmailFetchInfo: string;
}

export interface UserPhoto { contentType: 'image/jpeg' | 'image/png' | 'image/gif'; data: Buffer }

export interface DraftResult { draftId: string | null; changeKey: string | null }
export interface SendResult extends DraftResult { sent: boolean }

export interface NewAttachment { name: string; contentBase64: string; contentType?: string; inline?: boolean; contentId?: string }

export interface ComposeOptions {
  account?: string;
  to?: string[] | string;
  cc?: string[] | string;
  subject?: string;
  body?: string;
  bodyType?: BodyType;
  bcc?: string[] | string;
  /** Send at once instead of saving a draft. */
  send?: boolean;
}

export interface UpdateDraftOptions {
  id: string;
  changeKey?: string;
  subject?: string;
  body?: string;
  bodyType?: BodyType;
  to?: string[] | string;
  cc?: string[] | string;
  bcc?: string[] | string;
  /** Replace only what is above the quoted thread of a reply/forward draft. */
  keepQuoted?: boolean;
}

export interface SavedAttachment { name: string; path: string; size: number; contentType: string }

export interface ThreadMessage extends ListItem { folder?: 'inbox' | 'sent' }

export interface AwaitingThread {
  account: string;
  threadId: string;
  subject: string;
  lastMessageId: string;
  changeKey: string;
  from: string;
  fromEmail: string;
  received: string;
  addressed: 'to' | 'cc' | 'unknown';
  participants: Mailbox[];
  messages: number;
  theirsSinceMyLast: number;
  myLastReplyAt: string | null;
  isRead: boolean;
  askedSomething: boolean;
  snippet: string;
}

export interface AwaitingThemThread {
  account: string;
  threadId: string;
  subject: string;
  lastMessageId: string;
  /** Whom it went to (names, else addresses), me and robots left out. */
  to: string[];
  /** When my last message went. */
  sent: string;
  messages: number;
  lastTheirsAt: string | null;
}

export interface AwaitingOptions {
  account?: string;
  days?: number;
  limit?: number;
  /** Start of the window (instead of `days`). */
  sinceIso?: string;
  /** Shared between an awaitingReply and an awaitingThem call: the mail is gathered once for both. */
  memo?: Map<string, unknown>;
  onError?: OnAccountError;
}

export interface Person { name: string; email: string }
export interface Contact extends Person { emails: string[]; company: string; title: string; phones: { kind: string; number: string }[]; id?: string; department?: string; nickname?: string; addresses?: { kind: string; text: string }[]; birthday?: string }

/** What changed in an IMAP folder since `mark` (see ImapClient.changesIn); null where the backend cannot say. */
export interface FolderMark { path: string; validity: string; next: number; exists: number; modseq: string | null }
export interface FolderChanges {
  mark: FolderMark;
  reset?: true;
  same?: true;
  flags?: Array<{ id: string; uid: number; isRead: boolean; isFlagged: boolean }>;
  uids?: Set<number> | null;
}

/**
 * Shared by an account's poll, push stream and calendar watcher: while
 * blocked() nothing signs in; ok() after a sign-in that worked; failed(err)
 * after one the server rejected.
 */
export interface AuthGate {
  blocked(): boolean;
  ok(): void;
  failed(error: Error): void;
}

export type OnAccountError = (account: string, error: Error) => void;

// --- calendar -----------------------------------------------------------------

export interface CalendarInfo {
  id: string;
  account: string;
  name: string;
  changeKey?: string;
  itemCount?: number;
  isDefault?: boolean;
  shared?: boolean;
  mailbox?: string | null;
  [extra: string]: unknown;
}

export type Response = 'Accept' | 'Tentative' | 'Decline' | 'Organizer' | 'NoResponseReceived' | 'Unknown' | string;

export interface CalendarEvent {
  id: string;
  account: string;
  changeKey: string;
  subject: string;
  start: string;
  end: string;
  allDay: boolean;
  location: string;
  organizerName: string;
  organizerEmail: string;
  showAs: string;
  myResponse: Response;
  isMeeting: boolean;
  isCancelled: boolean;
  isRecurring: boolean;
  type: string;
  private: boolean;
  hasAttachments: boolean;
  reminderMinutes: number | null;
  modified: string;
  mailbox?: string | null;
  calendarName?: string;
  calendarId?: string;
  link?: string;
  [extra: string]: unknown;
}

export interface EventDetail extends CalendarEvent {
  body: string;
  categories: string[];
  importance: string;
  created: string;
  uid: string;
  responseRequested: boolean;
  attendees: Array<Mailbox & { role: 'required' | 'optional' | 'resource'; response: Response }>;
}

export type When = Date | string;

export interface EventFields {
  subject?: string;
  start?: When;
  end?: When;
  allDay?: boolean;
  location?: string;
  body?: string;
  attendees?: string[];
  optionalAttendees?: string[];
  reminderMinutes?: number;
  showAs?: string;
  /** Send invitations / updates (meetings only). Default true. */
  notify?: boolean;
}

export interface FreeBusyRow {
  email: string;
  ok: boolean;
  error: string | null;
  view: string | null;
  /** One char per interval: 0 free, 1 tentative, 2 busy, 3 away, 4 working elsewhere. */
  merged: string;
  intervalMinutes: number;
  start: string;
  end: string;
  events: Array<{ start: string; end: string; status: string; subject: string | null; location: string | null; isMeeting: boolean }>;
}

export interface FreeSlots {
  emails: string[];
  durationMinutes: number;
  window: { start: string; end: string };
  slots: Array<{ start: string; end: string }>;
  people: Array<{ email: string; view: string | null }>;
}

export interface CalendarApi {
  /** Accounts with a calendar: the one named, else all. */
  calendarAccounts(account?: string): string[];
  oneCalendarAccount(account?: string): string;
  /** "default" | an email | "<account>:<calendar id>" | a calendar name → where it lives. */
  resolveCalendar(spec?: string, account?: string): Promise<{ account: string | null; calendar?: string; mailbox?: string }>;
  listCalendars(account?: string, opts?: { mailbox?: string; onError?: OnAccountError }): Promise<CalendarInfo[]>;
  listEvents(opts?: { account?: string; start?: When; end?: When; calendar?: string; limit?: number; onError?: OnAccountError }): Promise<CalendarEvent[]>;
  /**
   * Events of every calendar the accounts see (own, other calendars, shared ones opened in Outlook/OWA).
   * A secondary calendar that cannot be read is marked `failed`; an account whose own calendar fails goes to onError (or throws).
   */
  listAllEvents(opts?: { account?: string; start?: When; end?: When; limit?: number; onError?: OnAccountError }): Promise<{
    items: Array<CalendarEvent & { calendarKey: string; calendarName: string; shared: boolean }>;
    calendars: Array<{ key: string; name: string; account: string; isDefault: boolean; shared: boolean; writable: boolean; failed?: string }>;
  }>;
  readEvent(id: string): Promise<EventDetail>;
  /** allowShared: the event may go into a calendar shared with me, where its owner lets me write. */
  createEvent(opts: EventFields & { account?: string; calendar?: string; allowShared?: boolean }): Promise<{ id: string; account: string; changeKey: string | null; invitationsSent?: boolean; [extra: string]: unknown }>;
  updateEvent(opts: EventFields & { id: string; changeKey?: string }): Promise<{ id: string; account: string; changeKey: string | null; [extra: string]: unknown }>;
  deleteEvent(id: string, opts?: { changeKey?: string; notify?: boolean }): Promise<unknown>;
  respondToEvent(id: string, response: 'accept' | 'tentative' | 'decline' | string, opts?: { changeKey?: string; message?: string; notify?: boolean }): Promise<unknown>;
  freeBusy(opts: { account?: string; emails: string[]; start: When; end: When; intervalMinutes?: number }): Promise<FreeBusyRow[]>;
  findFreeSlots(opts: {
    account?: string; emails: string[]; start?: When; end?: When; durationMinutes?: number; intervalMinutes?: number;
    hoursFrom?: number; hoursTo?: number; weekends?: boolean; tentativeOk?: boolean; max?: number;
  }): Promise<FreeSlots>;
}

// --- clients ------------------------------------------------------------------

/** One account's backend, ids prefixed "<account>:" in and out. */
export class AccountClient {
  constructor(name: string, backend: object | null, calendar?: object | (() => Promise<object | null>));
  readonly account: string;
  readonly hasMail: boolean;
  /** The provider's own client (EwsClient, ImapClient, JmapClient), unprefixed ids. */
  readonly backend: any;
  findInbox(opts?: FindOptions): Promise<ListItem[]>;
  getMessage(id: string, opts?: { bodyType?: BodyType }): Promise<Message>;
  /** IMAP: what changed in a folder since `mark`; null elsewhere. */
  changesIn(folder: Folder, opts?: { mark?: FolderMark | null; from?: number; flags?: 'changed' | 'all' | false }): Promise<FolderChanges | null>;
  /** IMAP: list items of a folder's messages by UID. */
  listByUids(folder: Folder, uids: number[]): Promise<ListItem[]>;
  /** IMAP: inbox messages from a UID on (whole, with `bodies`; `html` beside `body`); null where unknown or too many. */
  newSince(uid: number, opts?: { bodies?: boolean }): Promise<Array<ListItem & { body?: string; html?: string }> | null>;
  selfEmail(): Promise<string>;
  /** Map id → attachments, one request where the backend can. */
  attachmentsOf(ids: string[]): Promise<Map<string, AttachmentInfo[]>>;
  bulkFlags(ids: string[]): Promise<Map<string, boolean>>;
  /** Headers only, many messages at once; empty where the backend cannot say. */
  authHeadersOf(ids: string[]): Promise<Map<string, AuthHeaders & { fromEmail: string }>>;
  /** Whom the newest sent mail went to: To only (lower case), automatic answers left out; none where the backend cannot say. */
  sentTo(o?: { limit?: number }): Promise<{ to: string[]; sent: string }[]>;
  /** The organisation's photo of an address (Exchange 2013+, GetUserPhoto); null when none or no directory. Throws with `unsupported: true` where the server lacks the operation. */
  userPhoto(email: string, o?: { size?: 'HR48x48' | 'HR64x64' | 'HR96x96' | 'HR120x120' | 'HR240x240' | 'HR360x360' | 'HR432x432' | 'HR504x504' | 'HR648x648' }): Promise<UserPhoto | null>;
  draftReply(id: string, changeKey: string | null | undefined, body: string, opts?: { bodyType?: BodyType }): Promise<DraftResult>;
  draftReplyAll(id: string, changeKey: string | null | undefined, body: string, opts?: { bodyType?: BodyType }): Promise<DraftResult>;
  draftForward(id: string, changeKey: string | null | undefined, body: string, opts?: { bodyType?: BodyType; to?: string[]; cc?: string[]; bcc?: string[] }): Promise<DraftResult>;
  removeAttachment(id: string, changeKey: string | null | undefined, attachmentId: string): Promise<{ changeKey: string | null }>;
  createMessage(opts: Omit<ComposeOptions, 'account'>): Promise<SendResult>;
  /** Directory and contacts matching `query` (Exchange); [] elsewhere. */
  resolveNames(query: string): Promise<Person[]>;
  /** The mailbox's own contacts (Exchange); [] elsewhere. */
  /** `all`: those without an address too (with a name or a phone; `email` '') */
  contacts(opts?: { limit?: number; all?: boolean }): Promise<Contact[]>;
  updateDraft(opts: UpdateDraftOptions): Promise<DraftResult>;
  addAttachment(id: string, changeKey: string | null | undefined, attachment: NewAttachment): Promise<{ attachmentId: string | null; changeKey: string | null; /** IMAP: the draft, written again under a new id */ draftId?: string }>;
  sendItem(id: string, changeKey?: string | null): Promise<boolean>;
  deleteItem(id: string, changeKey?: string | null): Promise<boolean>;
  /** Map old id → new id, or → null for a message no longer there; ids missing were not moved. */
  moveItems(ids: string[], folder: Folder): Promise<Map<string, string | null>>;
  markRead(id: string, changeKey: string | null | undefined, isRead: boolean): Promise<boolean>;
  setFlag(id: string, changeKey: string | null | undefined, flagged: boolean): Promise<boolean>;
  /** Outlook on the web link to the item (Exchange); null elsewhere. */
  webLink(id: string): Promise<string | null>;
  getAttachment(attachmentId: string, messageId?: string): Promise<{ name: string; contentType: string; content: Buffer }>;
  findCalendars(opts?: { mailbox?: string }): Promise<CalendarInfo[]>;
  findEvents(opts?: { start?: Date; end?: Date; calendar?: string; mailbox?: string; limit?: number }): Promise<CalendarEvent[]>;
  getEvent(id: string): Promise<EventDetail>;
  createEvent(opts: object): Promise<{ id: string; account: string; [extra: string]: unknown }>;
  updateEvent(opts: object): Promise<{ id: string; account: string; [extra: string]: unknown }>;
  deleteEvent(id: string, changeKey?: string, opts?: { notify?: boolean }): Promise<unknown>;
  respondToEvent(id: string, changeKey: string | undefined, response: string, opts?: { message?: string; notify?: boolean }): Promise<unknown>;
  getFreeBusy(opts: { emails: string[]; start: Date; end: Date; intervalMinutes?: number }): Promise<FreeBusyRow[]>;
  /** Release both backends (IMAP logs out). The sign-out is started, not waited for, unless wait: true; never rejects. */
  close(opts?: { wait?: boolean }): Promise<void>;
}

export interface PushStream { start(): void; stop(): void }

// --- cache --------------------------------------------------------------------

export interface CacheStats {
  path: string;
  size: number;
  accounts: Array<{ account: string; n: number; bodies: number; oldest: string; synced: number | null }>;
}

export interface MailCache {
  readonly path: string | null;
  cachedAccounts(): string[];
  cacheKeyExists(): boolean;
  /** create: false never makes the database or the key; returns null when there is none. */
  openCache(opts?: { create?: boolean }): unknown | null;
  closeCache(): void;
  cacheUsable(accounts: string[], opts?: FindOptions): boolean;
  /** fromMe here is the address itself (the caller resolves it). */
  findCached(accounts: string[], opts?: Omit<FindOptions, 'fromMe'> & { fromMe?: string }): ListItem[];
  /** `stale`: a copy stored before Reply-To was kept is taken too (the server out of reach). */
  getCached(id: string, opts?: { bodyType?: BodyType; stale?: boolean }): Message | null;
  cachedSince(account: string, sinceIso: string, opts?: { limit?: number }): Array<ListItem & { to: Mailbox[] | null; cc: Mailbox[] | null; isBulk: boolean | null; bodyText: string | null; hasBody: boolean }>;
  /** Returns the ids not seen before; `report.changed`: rows already held whose read or flag state changed. */
  upsertItems(account: string, items: Partial<ListItem>[], report?: { changed?: number } | null): string[];
  /** Rows of `account` received since `sinceIso` that `items` (the inbox listing of that span) does not hold are dropped; returns how many. */
  dropUnlisted(account: string, items: Array<{ id: string }>, sinceIso: string): number;
  /** The cached inbox from `sinceIso` on made to match the server's listing of it. */
  reconcile(account: string, items: Partial<ListItem>[], sinceIso: string): { added: number; removed: number };
  /** Sent messages' thread identity (with `sinceIso`, `items` is the whole Sent listing from then on). */
  noteSent(account: string, items: Partial<ListItem>[], sinceIso?: string): { added: number; removed: number };
  /** Only rows a watcher listed are written to. html: '' = the mail has none; null/absent = not known (kept). */
  upsertBody(account: string, msg: Partial<Message>, bodies?: { text?: string | null; html?: string | null }): void;
  setRead(id: string, isRead: boolean): void;
  setFlagged(id: string, isFlagged: boolean): void;
  setBulk(id: string, isBulk: boolean): void;
  removeMessage(id: string): void;
  getMeta(key: string): string | null;
  setMeta(key: string, value: string | number): void;
  idsOf(account: string, table?: 'messages' | 'sent'): string[];
  /** Server differences applied at once; returns rows really changed. */
  applyChanges(changes: { flags?: Array<{ id: string; isRead: boolean; isFlagged: boolean }>; gone?: string[]; goneSent?: string[] }): { read: number; flagged: number; gone: number };
  /** "<account>|<conversationId>" → messages in the thread (inbox rows and sent). */
  threadCounts(items: Array<Pick<ListItem, 'account'> & { conversationId?: string }>): Map<string, number>;
  /** id → a preview line of the cached text body. */
  snippets(ids: string[], length?: number): Map<string, string>;
  /** id → the start of the cached text body, as stored. */
  texts(ids: string[], length?: number): Map<string, string>;
  /** People of the cached mail (senders and fellow recipients; newsletters and robots out), most frequent first. */
  people(q?: string, opts?: { accounts?: string[]; limit?: number }): Array<Person & { n: number; /** when they last wrote, or were written to (ISO) */ last?: string }>;
  lastSync(account: string): number | null;
  /** Drop rows older than each account's cache.days and rows of accounts no longer cached; returns rows removed. */
  prune(): number;
  /** Delete the database files. */
  clearCache(): void;
  cacheStats(): CacheStats | null;
}

// --- watching -----------------------------------------------------------------

export interface CalendarChange {
  action: 'created' | 'updated' | 'cancelled' | 'deleted';
  event: Pick<CalendarEvent, 'id' | 'subject' | 'start' | 'end' | 'allDay' | 'location' | 'organizerName' | 'organizerEmail' | 'isMeeting' | 'isCancelled' | 'myResponse' | 'changeKey'>;
  previous?: { start: string; end: string; location: string; subject: string };
  /** A new invitation from someone else, or a cancellation. */
  loud: boolean;
}

export type Reminder = CalendarChange['event'] & { account: string; minutes: number };

export interface MailWatchOptions {
  /** Default: every account. */
  accounts?: string[];
  pollSeconds?: number;
  /** Push streams (EWS streaming, IMAP IDLE); default true. */
  push?: boolean;
  /** Calendar watchers for accounts whose calendar.watch is not false; default true. */
  calendar?: boolean;
  /** Write headers and new bodies to the cache; default true. */
  cache?: boolean;
  calendarSnapshot?: (account: string) => StateStore;
  /** One gate per account, shared by its poll, stream and calendar watcher. */
  authGate?: (account: string) => AuthGate | null | undefined;
  log?: (message: string) => void;
}

export interface MailWatchEvents {
  mail: [{ account: string; items: ListItem[] }];
  baseline: [{ account: string; count: number }];
  poll: [{ account: string; items: ListItem[] }];
  failure: [{ account: string; error: Error; failures: number }];
  stream: [{ account: string; state: 'connected' | 'reconnecting' | 'off' | string }];
  calendar: [{ account: string; changes: CalendarChange[] }];
  reminder: [Reminder];
}

export class MailWatch extends EventEmitter<MailWatchEvents> {
  constructor(core: Mailcore, opts?: MailWatchOptions);
  /** Resolves once each account's first poll ran. */
  start(): Promise<this>;
  stop(): void;
  /** Poll one account now. */
  check(account: string): Promise<void> | undefined;
}

export interface CalendarWatchEvents {
  changes: [CalendarChange[]];
  reminder: [Reminder];
  failure: [Error];
}

export interface CalendarWatch extends EventEmitter<CalendarWatchEvents> {
  start(): CalendarWatch;
  /** Refresh soon (after a push). */
  refresh(): void;
  refreshNow(): Promise<void>;
  checkReminders(): void;
  stop(): void;
}

export interface CalendarWatchOptions {
  snapshot?: StateStore;
  settings?: () => CalendarSettings;
  log?: (message: string) => void;
  /** Start on the next tick (default true). */
  start?: boolean;
  /** No refresh while blocked(); told ok() / failed(err) on auth errors. */
  authGate?: AuthGate;
}

export function watchCalendar(core: Mailcore, opts: CalendarWatchOptions & { account: string }): CalendarWatch;

// --- event log ----------------------------------------------------------------

export interface LogEvent { ts: string; type: string; seq?: number; gap?: never; account?: string; rule?: string | null; [extra: string]: unknown }
export interface EventFilter { match?: 'rules' | 'all'; account?: string | null; rule?: string | null; types?: string[] | null }
/** Yielded by EventLog.events() when the cursor predates the oldest event kept: resync. */
export interface GapNotice { type: 'gap'; gap: true; oldest: number | null; lost: number; cursor: number }
export interface WaitResult { events: LogEvent[]; cursor: number; gap?: true; oldest?: number | null; lost?: number }

export class EventLog extends EventEmitter<{ event: [LogEvent] }> {
  constructor(opts?: { max?: number; store?: StateStore<{ seq: number; events: LogEvent[] }>; now?: () => Date });
  readonly cursor: number;
  /** Set by close(): waits resolve empty at once and events() iterators end. */
  readonly closed: boolean;
  append(type: string, data?: Record<string, unknown>): LogEvent;
  since(after: number, filter?: EventFilter): LogEvent[];
  wait(opts?: { after?: number | 'now' | null; timeout?: number; filter?: EventFilter; limit?: number; signal?: AbortSignal }): Promise<WaitResult>;
  events(opts?: { after?: number | 'now' | null; filter?: EventFilter; signal?: AbortSignal }): AsyncGenerator<LogEvent | GapNotice>;
  close(): void;
}

export const QUEUED_TYPES: Set<string>;
export const MAIL_TYPES: Set<string>;
export function gapInfo(after: number, queue: LogEvent[], seq: number): { gap?: true; oldest?: number | null; lost?: number };
export function matchesFilter(event: LogEvent, filter?: EventFilter): boolean;

// --- the instance -------------------------------------------------------------

export class Mailcore {
  constructor(options: MailcoreOptions);
  readonly accounts: Record<string, Account>;
  readonly defaultAccount: string | null;
  readonly timeZone: string | null;
  readonly pollSeconds: number;
  readonly config: { accounts: Record<string, Account>; defaultAccount: string | null; timeZone: string | null; pollSeconds: number };
  readonly dataDir: string | null;
  readonly state: StateStore;
  readonly cache: MailCache;
  readonly calendar: CalendarApi;
  readonly google: {
    accessToken(account: string, opts?: { force?: boolean }): Promise<string>;
    /** Interactive OAuth sign-in on a loopback port; stores the tokens through credentials.google. */
    login(account: string, opts?: GoogleSignInOptions & { openUrl?: (url: string) => void; log?: (message: string) => void }): Promise<GoogleTokens>;
    /**
     * The same sign-in, started: returns at once with the consent URL to open. `done` settles when it ends
     * (the stored tokens, or an error whose code is SIGN_IN_TIMEOUT, SIGN_IN_CANCELLED, SIGN_IN_REFUSED or SIGN_IN_FAILED).
     */
    beginLogin(account: string, opts?: GoogleSignInOptions): Promise<GoogleSignIn>;
    signedIn(account: string): Promise<boolean>;
    /** What is known of the account's sign-in, without a secret (null: not signed in). */
    tokens(account: string): Promise<{ scopes: string[]; signedInAt?: string; /** Google refused its renewal (invalid_grant) since */ refusedAt?: string } | null>;
    /** What a Google auth error of this account tells the user to do. */
    signInHint(account: string): string;
    /** The account's Google contacts (People API: its own, and its "other contacts"), over its tokens. See googleContacts. */
    contacts(account: string, opts?: Omit<GoogleContactsOptions, 'accessToken'> & { accessToken?: GoogleContactsOptions['accessToken'] }): Promise<GoogleContactsResult>;
    /** Adds a contact to the account's own Google contacts, over its tokens (the sign-in must allow `contacts`). See googleCreateContact. */
    createContact(account: string, contact: NewGoogleContact, opts?: { signal?: AbortSignal; fetch?: typeof fetch }): Promise<GoogleContact>;
  };

  accountNames(): string[];
  mailAccountNames(): string[];
  account(name?: string): Account;
  listAccounts(): AccountSummary[];
  selectAccounts(account?: string): string[];

  client(name?: string, opts?: { refresh?: boolean }): Promise<AccountClient>;
  /** fn(client) with one same-credential retry and one refresh retry on auth failure; account may be a prefixed id. */
  withClient<T>(account: string | undefined, fn: (client: AccountClient) => Promise<T> | T, opts?: { onRefresh?: (error: Error) => void }): Promise<T>;
  withAuthRetry<T>(fn: (client: AccountClient) => Promise<T> | T, onRefresh: ((error: Error) => void) | null | undefined, account?: string): Promise<T>;
  /**
   * Keep IMAP clients between uses (a process that stays up: signing in takes a second or two each time): for `ms`
   * unused (default two minutes), at most `max` per account (default 3). Kept connections hold the process up
   * until closeClients().
   */
  keepClients(opts?: { ms?: number; max?: number; /** unused for longer than this, a kept client is asked whether it still answers before it is used (default 15 s) */ probeMs?: number }): void;
  /** Close the clients kept (all, or one account's). */
  closeClients(name?: string): Promise<void>;
  stream(name: string, hooks?: {
    /** how: 'told' by the server's push, or 'asked' (IMAP's own look); from: IMAP, the first new UID when known. */
    onNewMail?: (how?: 'told' | 'asked', from?: number | null) => void;
    onCalendarChange?: () => void;
    /** Exchange: the Drafts folder changed. */
    onDraftsChange?: () => void;
    authGate?: AuthGate;
    onState?: (state: string) => void;
    log?: (message: string) => void;
  }): Promise<PushStream>;

  find(account: string | undefined, opts?: FindOptions, onError?: OnAccountError): Promise<ListItem[]>;
  read(id: string, opts?: { bodyType?: BodyType; live?: boolean }): Promise<Message>;
  getAttachment(messageId: string, attachmentId: string): Promise<{ name: string; contentType: string; content: Buffer }>;
  saveAttachments(id: string, dir: string, opts?: { only?: string }): Promise<SavedAttachment[]>;
  reply(id: string, body: string, opts?: { all?: boolean; send?: boolean; changeKey?: string; bodyType?: BodyType }): Promise<SendResult>;
  /** A forward draft (never sent here); the server adds the original and its attachments. */
  forward(id: string, body: string, opts?: { to?: string[]; cc?: string[]; bcc?: string[]; changeKey?: string; bodyType?: BodyType }): Promise<DraftResult>;
  compose(opts: ComposeOptions): Promise<SendResult>;
  updateDraft(opts: UpdateDraftOptions): Promise<DraftResult>;
  addAttachment(id: string, changeKey: string | null | undefined, attachment: NewAttachment): Promise<{ attachmentId: string | null; changeKey: string | null; /** IMAP: the draft, written again under a new id */ draftId?: string }>;
  removeAttachment(id: string, changeKey: string | null | undefined, attachmentId: string): Promise<{ changeKey: string | null }>;
  deleteItem(id: string, changeKey?: string | null): Promise<boolean>;
  markRead(id: string, isRead?: boolean, changeKey?: string | null): Promise<boolean>;
  setFlag(id: string, flagged?: boolean, changeKey?: string | null): Promise<boolean>;
  /**
   * Move messages (of any accounts) to a folder: old id → new id, or → null for one no longer there. Ids missing
   * were not moved (their account failed: onError is told; without it the error is thrown when nothing moved).
   */
  moveItems(ids: string[], folder: Folder, opts?: { onError?: OnAccountError }): Promise<Map<string, string | null>>;
  send(id: string, changeKey?: string | null): Promise<boolean>;
  /** People of the cached mail (see MailCache.people); [] without a cache. */
  people(q?: string, opts?: { accounts?: string[]; limit?: number }): Array<Person & { n: number; /** when they last wrote, or were written to (ISO) */ last?: string }>;
  noteRead(id: string, isRead?: boolean): void;
  noteFlagged(id: string, isFlagged?: boolean): void;
  noteRemoved(id: string): void;

  getThread(opts: { id?: string; subject?: string; days?: number; account?: string; limit?: number; onError?: OnAccountError }): Promise<ThreadMessage[]>;
  awaitingReply(opts?: AwaitingOptions & { includeCc?: boolean; since?: string }): Promise<{ threads: AwaitingThread[]; scanned: { inbound: number; sent: number; days: number }; cursor: string }>;
  /** "Who am I waiting on?": threads whose last message is mine, to someone else, unanswered since. */
  awaitingThem(opts?: AwaitingOptions & { olderThanHours?: number }): Promise<{ threads: AwaitingThemThread[] }>;

  watch(opts?: MailWatchOptions): Promise<MailWatch>;
  watchCalendar(account: string, opts?: CalendarWatchOptions): Promise<CalendarWatch>;
  close(): void;
}

export function createMailcore(options: MailcoreOptions): Mailcore;

// --- helpers ------------------------------------------------------------------

export const PROVIDERS: Provider[];
export const MAIL_PROVIDERS: Provider[];
export const CACHE_DEFAULTS: Required<CacheSettings>;
export const CALENDAR_DEFAULTS: Required<CalendarSettings>;
export const ACCOUNT_DEFAULTS: Record<Provider, Partial<Account>>;
export function normalizeAccount(name: string, def?: AccountDefinition): Account;
/** The session URL of a JMAP account (jmap.session, a bare host's or the email domain's /.well-known/jmap). Throws when there is nothing to go by. */
export function jmapSessionUrl(acct: AccountDefinition): string;
export function normalizeAccounts(accounts: AccountsInput): Record<string, Account>;
export function calendarProvider(account: AccountDefinition | null | undefined): CalendarProvider | null;
export function hasMail(account: AccountDefinition | null | undefined): boolean;
/** The name an account writes as: one line, at most 100 characters; '' when none. */
export function displayNameOf(account: AccountDefinition | null | undefined): string;
export function splitId(id: string): { account: string | null; rawId: string };
/** The folder, mailbox generation and UID an IMAP raw id holds; null for anything else. */
export function idParts(rawId: string): { path: string; validity: string; uid: number } | null;
export function isAuthError(error: unknown): boolean;

export interface Rule {
  name?: string;
  enabled?: boolean;
  senders?: string | string[];
  subjects?: string | string[];
  account?: string | string[];
  [extra: string]: unknown;
}
export function splitList(value: unknown): string[];
export function ruleMatches(rule: Rule, item: Pick<ListItem, 'fromName' | 'fromEmail' | 'subject'>): boolean;
export function accountOk(rule: Rule, account: string): boolean;
export function matchRule<R extends Rule>(rules: R[] | null | undefined, item: Pick<ListItem, 'fromName' | 'fromEmail' | 'subject'>, account: string): R | null;
export function inQuietHours(quiet: { enabled?: boolean; start?: string; end?: string } | null | undefined): boolean;

export function parseWhen(input: When, base?: Date): Date;
export function parseDuration(input: string | number | null | undefined, fallback?: number): number;
export function dayStart(d?: Date, days?: number): Date;

export function normalizeSubject(subject: string): string;
export function askedSomething(text: string): boolean;
export function unquoted(text: string): string;
export function snippet(text: string, n?: number): string;
export function groupThreads<T extends Partial<ListItem>>(messages: T[]): Map<string, T[]>;
export function looksBulk(m: Partial<ListItem> & { isBulk?: boolean | null; bodyText?: string | null }): boolean;

export const BODY_FORMATS: Array<'text' | 'markdown' | 'html'>;
export function prepareBody(body: string, format?: 'text' | 'markdown' | 'html'): { body: string; bodyType: BodyType };
export function replaceAboveQuote(prepared: { body: string; bodyType: BodyType }, currentBody: string, currentType: BodyType): { body: string; bodyType: BodyType };
export function splitQuoted(body: string, bodyType?: BodyType): { head: string; tail: string };
/** The line breaks an HTML text ends with, told from the text. */
export function splitBreaks(html: string): { text: string; breaks: string };
export function markdownToHtml(md: string): string;
export function textToHtml(text: string): string;
export function escapeHtml(s: string): string;
export function htmlToText(html: string): string;
/** A text part as text (one that is really HTML is read as HTML). */
export function plainText(text: string): string;

/** The calendar scopes: what a Google sign-in asks for by default. */
export const GOOGLE_SCOPES: string[];
/** Reading contacts (People API): contacts.readonly and contacts.other.readonly. */
export const GOOGLE_CONTACTS_SCOPES: string[];
/** Reading and adding one's own contacts (holds contacts.readonly's reading). */
export const GOOGLE_CONTACTS_WRITE_SCOPE: string;
/** Contacts read and added: GOOGLE_CONTACTS_WRITE_SCOPE and contacts.other.readonly. */
export const GOOGLE_CONTACTS_WRITE_SCOPES: string[];
/** What granted scopes allow of the contacts: reading (contacts.readonly or contacts, with the other contacts), adding (contacts). */
export function contactsAllowed(scopes: string[] | null | undefined): { read: boolean; write: boolean };
/** The scopes stored tokens were granted (their `scope`), as a list; [] when unknown. */
export function grantedScopes(tokens: GoogleTokens | null | undefined): string[];
/** The address of the Google account an access token is for (its primary calendar's id); null when Google does not say. */
export function googleAccountAddress(accessToken: string, opts?: { signal?: AbortSignal }): Promise<string | null>;

/** A contact of a Google account with at least one email address. */
export interface GoogleContact {
  /** '' when Google has none (or only the address) */
  name: string;
  /** the primary address */
  email: string;
  /** every address, the primary first */
  emails: string[];
  /** 'saved': one of the account's own contacts; 'other': an "other contact" (someone it wrote with) */
  kind: 'saved' | 'other';
  /** the https address of a picture someone chose (never Google's placeholder) */
  photo?: string;
  company?: string;
  title?: string;
  /** the People API's resource name (people/…) */
  id?: string;
  /** a saved contact's (never an other contact's): */
  department?: string;
  nickname?: string;
  phones?: { kind: string; number: string }[];
  addresses?: { kind: string; text: string }[];
  /** 'YYYY-MM-DD', or '--MM-DD' when the year is not known */
  birthday?: string;
  note?: string;
  urls?: { kind: string; url: string }[];
  relations?: { kind: string; name: string }[];
  dates?: { kind: string; date: string }[];
  /** the account's own groups it is in (contactGroups/…: their names in GoogleContactsResult.groups) */
  groups?: string[];
  starred?: true;
}
export type GoogleContactsErrorCode = 'GOOGLE_SCOPE' | 'GOOGLE_API_DISABLED' | 'GOOGLE_RATE' | 'GOOGLE_API';
export interface GoogleContactsResult {
  /** the account's own contacts; null when they could not be read (see errors) */
  saved: GoogleContact[] | null;
  /** its "other contacts"; null when they could not be read (see errors) */
  other: GoogleContact[] | null;
  /** the names of the account's own contact groups, by resource name ({} when none was needed; null when they could not be read) */
  groups: Record<string, string> | null;
  errors: { list: 'saved' | 'other'; code: GoogleContactsErrorCode | string; status?: number; message: string }[];
}
export interface GoogleContactsOptions {
  /** a valid access token for the account (force: renew it) — Mailcore's google.accessToken */
  accessToken: (account: string, opts: { force: boolean }) => Promise<string>;
  /** what an auth error tells the user to do */
  signInHint?: (account: string) => string;
  /** which lists to read (default both) */
  lists?: ('saved' | 'other')[];
  /** per request, at most 1000 (the default) */
  pageSize?: number;
  /** pages read at most per list (default 25) */
  maxPages?: number;
  signal?: AbortSignal;
  /** a stand-in for fetch (tests) */
  fetch?: typeof fetch;
}
/**
 * The contacts of a Google account over the People API (people/me/connections and otherContacts), paged. A list
 * Google refuses is null with its error in `errors` (code GOOGLE_SCOPE: contacts not allowed by the sign-in;
 * GOOGLE_API_DISABLED: the People API is off in the OAuth client's project; GOOGLE_RATE; GOOGLE_API). Throws on an
 * auth failure (code MAIL_AUTH, after one forced renewal) and when every list asked for failed (the first error,
 * with `errors`). Nothing is kept.
 */
export function googleContacts(account: string, opts: GoogleContactsOptions): Promise<GoogleContactsResult>;
/** A contact to add: at least a name, an address, a phone or a company. Lists take plain strings or { …, kind }. */
export interface NewGoogleContact {
  name?: string;
  givenName?: string;
  familyName?: string;
  emails?: (string | { value?: string; email?: string; kind?: string })[];
  phones?: (string | { number?: string; value?: string; kind?: string })[];
  /** lines as given (Google's formatted value) */
  addresses?: (string | { text?: string; value?: string; kind?: string })[];
  company?: string;
  title?: string;
  department?: string;
  note?: string;
  /** http(s) only */
  urls?: (string | { url?: string; value?: string; kind?: string })[];
  /** 'YYYY-MM-DD' or '--MM-DD' */
  birthday?: string;
}
/**
 * Adds a contact to a Google account's own contacts (people:createContact): the contact as Google keeps it (kind
 * 'saved', with its id). Throws a TypeError when nothing names it; MAIL_AUTH after one forced renewal; GOOGLE_SCOPE
 * when the sign-in only allows reading.
 */
export function googleCreateContact(account: string, contact: NewGoogleContact, opts: { accessToken: GoogleContactsOptions['accessToken']; signInHint?: (account: string) => string; signal?: AbortSignal; fetch?: typeof fetch }): Promise<GoogleContact>;
/** One person of the People API as a GoogleContact (null: an other contact without an email address, a saved one with neither address, name nor phone). */
export function googleContactOf(person: unknown, kind: 'saved' | 'other'): GoogleContact | null;
export function jsonFileStore<T = Record<string, unknown>>(file: string, fallback?: () => T): StateStore<T>;

/** What an Authentication-Results too long to keep is kept as: a value that parses as nothing. */
export const OVERSIZED: string;
/** Whether a message is an automatic answer (out-of-office, a rule's reply), by its subject or the raw Auto-Submitted / X-Autoreply headers. */
export function isAutoReply(subject: string, headers?: string): boolean;
/** The headers isAutoReply reads (lower case). */
export const AUTO_REPLY_HEADERS: string[];
/** The header names authHeadersOf asks for (lower case). */
export const AUTH_HEADER_NAMES: string[];
/** [name, value] pairs, topmost first → the authentication headers among them. */
export function authHeadersFrom(pairs: [string, string][]): AuthHeaders;
/** The [name, value] pairs of a raw header block, in order. */
export function headerPairs(raw: string | Buffer): [string, string][];
export function memoryStore<T = Record<string, unknown>>(fallback?: () => T): StateStore<T>;
