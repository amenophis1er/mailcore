// Types for mailcore's public API (the code is plain JS ESM).

import { EventEmitter } from 'node:events';

// --- accounts -----------------------------------------------------------------

export type Provider = 'ews' | 'imap' | 'caldav' | 'google';
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
  smtp?: ServerSettings;
  /** CalDAV: icloud | fastmail | other */
  service?: string;
  server?: string;
  hostPattern?: string;
  /** Other addresses that are mine (awaiting-reply). */
  aliases?: string[];
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
  scope?: string;
  signed_in_at?: string;
  [extra: string]: unknown;
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
  google?: { clientId?: string; clientSecret?: string };
  /** Replaces the default "a watcher polled within 3× pollSeconds" test for serving from the cache. */
  cacheFresh?: (accounts: string[]) => boolean;
  log?: (message: string) => void;
}

// --- mail ---------------------------------------------------------------------

export type Folder = 'inbox' | 'junk' | 'sent' | 'drafts' | 'trash' | 'archive';
export type BodyType = 'Text' | 'HTML';

export interface FindOptions {
  limit?: number;
  offset?: number;
  unreadOnly?: boolean;
  senderContains?: string;
  subjectContains?: string;
  toContains?: string;
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
  attachments: AttachmentInfo[];
  bodyType: BodyType;
  body: string;
  isBulk?: boolean;
  references?: string;
}

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
  readEvent(id: string): Promise<EventDetail>;
  createEvent(opts: EventFields & { account?: string; calendar?: string }): Promise<{ id: string; account: string; changeKey: string | null; invitationsSent?: boolean; [extra: string]: unknown }>;
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
  findInbox(opts?: FindOptions): Promise<ListItem[]>;
  getMessage(id: string, opts?: { bodyType?: BodyType }): Promise<Message>;
  selfEmail(): Promise<string>;
  bulkFlags(ids: string[]): Promise<Map<string, boolean>>;
  draftReply(id: string, changeKey: string | null | undefined, body: string, opts?: { bodyType?: BodyType }): Promise<DraftResult>;
  draftReplyAll(id: string, changeKey: string | null | undefined, body: string, opts?: { bodyType?: BodyType }): Promise<DraftResult>;
  createMessage(opts: Omit<ComposeOptions, 'account'>): Promise<SendResult>;
  updateDraft(opts: UpdateDraftOptions): Promise<DraftResult>;
  addAttachment(id: string, changeKey: string | null | undefined, attachment: NewAttachment): Promise<{ attachmentId: string | null; changeKey: string | null }>;
  sendItem(id: string, changeKey?: string | null): Promise<boolean>;
  deleteItem(id: string, changeKey?: string | null): Promise<boolean>;
  markRead(id: string, changeKey: string | null | undefined, isRead: boolean): Promise<boolean>;
  getAttachment(attachmentId: string, messageId?: string): Promise<{ name: string; contentType: string; content: Buffer }>;
  findCalendars(opts?: { mailbox?: string }): Promise<CalendarInfo[]>;
  findEvents(opts?: { start?: Date; end?: Date; calendar?: string; mailbox?: string; limit?: number }): Promise<CalendarEvent[]>;
  getEvent(id: string): Promise<EventDetail>;
  createEvent(opts: object): Promise<{ id: string; account: string; [extra: string]: unknown }>;
  updateEvent(opts: object): Promise<{ id: string; account: string; [extra: string]: unknown }>;
  deleteEvent(id: string, changeKey?: string, opts?: { notify?: boolean }): Promise<unknown>;
  respondToEvent(id: string, changeKey: string | undefined, response: string, opts?: { message?: string; notify?: boolean }): Promise<unknown>;
  getFreeBusy(opts: { emails: string[]; start: Date; end: Date; intervalMinutes?: number }): Promise<FreeBusyRow[]>;
  /** Release both backends (IMAP logs out); never rejects. */
  close(): Promise<void>;
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
  getCached(id: string, opts?: { bodyType?: BodyType }): Message | null;
  cachedSince(account: string, sinceIso: string, opts?: { limit?: number }): Array<ListItem & { to: Mailbox[] | null; cc: Mailbox[] | null; isBulk: boolean | null; bodyText: string | null; hasBody: boolean }>;
  upsertItems(account: string, items: Partial<ListItem>[]): string[];
  upsertBody(account: string, msg: Partial<Message>, bodies?: { text?: string | null; html?: string | null }): void;
  setRead(id: string, isRead: boolean): void;
  setBulk(id: string, isBulk: boolean): void;
  removeMessage(id: string): void;
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
    login(account: string, opts?: { openUrl?: (url: string) => void; log?: (message: string) => void; timeoutMs?: number }): Promise<GoogleTokens>;
    signedIn(account: string): Promise<boolean>;
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
  stream(name: string, hooks?: { onNewMail?: () => void; onCalendarChange?: () => void; onState?: (state: string) => void; log?: (message: string) => void }): Promise<PushStream>;

  find(account: string | undefined, opts?: FindOptions, onError?: OnAccountError): Promise<ListItem[]>;
  read(id: string, opts?: { bodyType?: BodyType; live?: boolean }): Promise<Message>;
  getAttachment(messageId: string, attachmentId: string): Promise<{ name: string; contentType: string; content: Buffer }>;
  saveAttachments(id: string, dir: string, opts?: { only?: string }): Promise<SavedAttachment[]>;
  reply(id: string, body: string, opts?: { all?: boolean; send?: boolean; changeKey?: string; bodyType?: BodyType }): Promise<SendResult>;
  compose(opts: ComposeOptions): Promise<SendResult>;
  updateDraft(opts: UpdateDraftOptions): Promise<DraftResult>;
  addAttachment(id: string, changeKey: string | null | undefined, attachment: NewAttachment): Promise<{ attachmentId: string | null; changeKey: string | null }>;
  deleteItem(id: string, changeKey?: string | null): Promise<boolean>;
  markRead(id: string, isRead?: boolean, changeKey?: string | null): Promise<boolean>;
  send(id: string, changeKey?: string | null): Promise<boolean>;
  noteRead(id: string, isRead?: boolean): void;
  noteRemoved(id: string): void;

  getThread(opts: { id?: string; subject?: string; days?: number; account?: string; limit?: number; onError?: OnAccountError }): Promise<ThreadMessage[]>;
  awaitingReply(opts?: { account?: string; days?: number; limit?: number; includeCc?: boolean; since?: string; onError?: OnAccountError }): Promise<{ threads: AwaitingThread[]; scanned: { inbound: number; sent: number; days: number }; cursor: string }>;

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
export function normalizeAccounts(accounts: AccountsInput): Record<string, Account>;
export function calendarProvider(account: AccountDefinition | null | undefined): CalendarProvider | null;
export function hasMail(account: AccountDefinition | null | undefined): boolean;
export function splitId(id: string): { account: string | null; rawId: string };
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
export function markdownToHtml(md: string): string;
export function textToHtml(text: string): string;
export function escapeHtml(s: string): string;
export function htmlToText(html: string): string;

export const GOOGLE_SCOPES: string[];
export function jsonFileStore<T = Record<string, unknown>>(file: string, fallback?: () => T): StateStore<T>;
export function memoryStore<T = Record<string, unknown>>(fallback?: () => T): StateStore<T>;
