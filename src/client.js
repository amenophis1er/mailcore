// Mail client contract, backend factory, and per-account auth retry.
//
// Every backend (EwsClient in ews.js, ImapClient in imap.js) implements the
// same duck-typed MailClient interface; callers never see the provider.
//
//   findInbox(opts)                     → ListItem[]   newest first
//       opts: limit, unreadOnly, flaggedOnly, senderContains, subjectContains, text,
//             hasAttachments, sinceIso, folder (inbox|junk|sent|drafts|trash|archive)
//   getMessage(id, { bodyType })        → ListItem & { to, cc, attachments, bodyType, body }
//   draftReply(id, changeKey, body, { bodyType })     → { draftId, changeKey }   reply to sender
//   draftReplyAll(id, changeKey, body, { bodyType })  → { draftId, changeKey }
//   createMessage({ to, cc, subject, body, bodyType, send }) → { sent, draftId, changeKey }
//   updateDraft({ id, changeKey, subject, body, bodyType, to, cc, keepQuoted }) → { draftId, changeKey }
//     keepQuoted: only the text above the quoted thread is replaced (reply/forward drafts)
//   addAttachment(id, changeKey, { name, contentBase64, contentType, inline, contentId }) → { attachmentId, changeKey }
//   bodyType is 'Text' (default) or 'HTML' — see body.js (prepareBody) for Markdown.
//   sendItem(id, changeKey)             → true
//   deleteItem(id, changeKey)           → true   (move to trash)
//   moveItems(ids, folder)              → Map old id → new id
//   markRead(id, changeKey, isRead)     → true
//   setFlag(id, changeKey, flagged)     → true
//   getAttachment(attachmentId, messageId) → { name, contentType, content (Buffer) }
//   close?()                            → release connections (optional)
//
// Calendar (EWS backends only — AccountClient raises NO_CALENDAR otherwise):
//   findCalendars / findEvents / getEvent / createEvent / updateEvent /
//   deleteEvent / respondToEvent / getFreeBusy — see ews-calendar.js and the
//   account-level helpers in calendar.js.
//
//   ListItem: { id, changeKey, subject, fromName, fromEmail, displayTo,
//               isRead, hasAttachments, received (ISO) }
//
// changeKey is an EWS concept (item version). IMAP has none: it returns the
// current message id there, because an edited draft is re-appended and gets
// a new id. Callers keep passing (id, changeKey) back; both backends cope.
//
// Ids handed to callers are prefixed "<account>:" so any id routes back to
// its account; AccountClient adds/strips the prefix around the backend.

import { loadConfig, getCredentials, getAccount, accountNames, mailAccountNames, calendarProvider, hasMail } from './config.js';
import { replaceAboveQuote } from './body.js';
import * as cache from './cache.js';
import { htmlToText } from './text.js';

export function isAuthError(e) {
  return !!e && (e.code === 'EWS_AUTH' || e.code === 'MAIL_AUTH');
}

/** "work:AAMk…" → { account: "work", rawId: "AAMk…" }; unprefixed → account null. */
export function splitId(id) {
  const s = String(id || '');
  const i = s.indexOf(':');
  // EWS ids are base64 (no ':'); IMAP raw ids are "<mailbox>/<uidvalidity>/<uid>".
  if (i <= 0) return { account: null, rawId: s };
  return { account: s.slice(0, i), rawId: s.slice(i + 1) };
}

export function makeBackend(acct, creds) {
  if (!hasMail(acct)) return Promise.resolve(null); // calendar-only account
  return acct.provider === 'imap'
    ? import('./imap.js').then((m) => new m.ImapClient(acct, creds))
    : import('./ews.js').then((m) => new m.EwsClient({ host: acct.host, email: acct.email, ...creds }));
}

/**
 * The calendar backend of an account: the EWS client itself, a CalDAV or
 * Google client for calendar-only accounts, or the one an IMAP account
 * carries under `calendar`. null when the account has no calendar.
 */
export async function makeCalendarBackend(acct, mailBackend, config, forceRefresh = false) {
  const kind = calendarProvider(acct);
  if (!kind) return null;
  if (kind === 'ews') return mailBackend;
  const spec = acct.provider === 'imap' ? acct.calendar : acct;
  const timeZone = config?.timeZone || null;
  if (kind === 'google') {
    const m = await import('./cal-google.js');
    return new m.GoogleCalendar({ account: acct.name, email: spec.email || acct.email, timeZone });
  }
  const m = await import('./cal-caldav.js');
  // credentials: the account's own (calendar-only), or the calendar block's 1Password item / keychain entry "<account>/calendar"
  const credAcct = acct.provider === 'imap' ? { ...spec, name: `${acct.name}/calendar`, provider: 'caldav' } : acct;
  const creds = await getCredentials(config || loadConfig(), credAcct, forceRefresh);
  return new m.CaldavCalendar({ server: spec.server, service: spec.service, username: creds.username || spec.username || spec.email, password: creds.password, email: spec.email || acct.email, hostPattern: spec.hostPattern, timeZone, account: acct.name });
}

export function makeStream(acct, creds, hooks) {
  return acct.provider === 'imap'
    ? import('./imap-stream.js').then((m) => new m.ImapStream({ account: acct, creds, ...hooks }))
    : import('./ews-stream.js').then((m) => new m.EwsStream({ host: acct.host, ...creds, ...hooks }));
}

/** Wraps a backend so every id in/out carries the "<account>:" prefix. */
export class AccountClient {
  /** `calendar`: the calendar backend, or a factory for it (built on first use, so a calendar's credentials never block mail). */
  constructor(name, backend, calendar = backend) {
    this.account = name;
    this.hasMail = !!backend;
    this.backend = backend ? backend : new Proxy({}, { get: (_, prop) => { if (prop === 'then' || prop === 'close' || typeof prop === 'symbol') return undefined; return () => { throw Object.assign(new Error(`account "${name}" holds no mail (calendar only)`), { code: 'NO_MAIL' }); }; } });
    this._calendarFactory = typeof calendar === 'function' ? calendar : () => calendar;
    this._calendar = typeof calendar === 'function' ? undefined : calendar;
  }
  #in(id) {
    if (id == null) return id;
    const { account, rawId } = splitId(id);
    if (account && account !== this.account) throw new Error(`message ${id} belongs to account "${account}", not "${this.account}"`);
    return rawId;
  }
  #ck(ck) {
    // IMAP changeKeys are ids too; EWS changeKeys never contain ':'.
    return ck && String(ck).startsWith(this.account + ':') ? this.#in(ck) : ck;
  }
  #out(id) {
    return id ? `${this.account}:${id}` : id;
  }
  #item(item) {
    return { ...item, id: this.#out(item.id), account: this.account };
  }
  #result(r) {
    const out = { ...r };
    if (out.draftId) out.draftId = this.#out(out.draftId);
    if (out.changeKey && this.backend.changeKeyIsId) out.changeKey = this.#out(out.changeKey);
    return out;
  }
  async findInbox(opts) { return (await this.backend.findInbox(opts)).map((i) => this.#item(i)); }
  async getMessage(id, o) { return this.#item(await this.backend.getMessage(this.#in(id), o)); }
  /** Whole messages that arrived since a mark only the backend understands (IMAP: a UID); null where the backend cannot say. */
  /** What changed in a folder since a mark (IMAP; see ImapClient.changesIn): ids prefixed; null where the backend cannot say. */
  async changesIn(folder, o) {
    if (typeof this.backend.changesIn !== 'function') return null;
    const r = await this.backend.changesIn(folder, o);
    return r.flags ? { ...r, flags: r.flags.map((f) => ({ ...f, id: this.#out(f.id) })) } : r;
  }
  async listByUids(folder, uids) { return (await this.backend.listByUids(folder, uids)).map((i) => this.#item(i)); }
  async newSince(mark, o) { const got = typeof this.backend.newSince === 'function' ? await this.backend.newSince(mark, o) : null; return got && got.map((i) => this.#item(i)); }
  /** My own address: from the mail backend, else from the calendar backend (calendar-only accounts). */
  async selfEmail() {
    if (this.hasMail) return this.backend.selfEmail();
    return (await this.#cal('selfEmail'))();
  }
  /** The attachments of many messages: Map id → attachments. One request where the backend can, else a read per message. */
  async attachmentsOf(ids) {
    if (typeof this.backend.attachmentsOf === 'function') {
      const m = await this.backend.attachmentsOf(ids.map((id) => this.#in(id)));
      return new Map([...m].map(([id, v]) => [`${this.account}:${id}`, v]));
    }
    const out = new Map();
    for (const id of ids) {
      try { out.set(id, (await this.backend.getMessage(this.#in(id), { bodyType: 'Text' })).attachments || []); } catch { /* that message is skipped */ }
    }
    return out;
  }
  async bulkFlags(ids) {
    const m = await this.backend.bulkFlags(ids.map((id) => this.#in(id)));
    return new Map([...m].map(([id, v]) => [`${this.account}:${id}`, v]));
  }
  async #replyCk(id, ck) {
    // Exchange requires the item's current ChangeKey for Reply(All)ToItem; IMAP ignores it
    if (ck || this.backend.changeKeyIsId) return this.#ck(ck);
    return (await this.backend.getMessage(this.#in(id), { bodyType: 'Text' })).changeKey || '';
  }
  async draftReply(id, ck, b, o) { return this.#result(await this.backend.draftReply(this.#in(id), await this.#replyCk(id, ck), b, o)); }
  async draftReplyAll(id, ck, b, o) { return this.#result(await this.backend.draftReplyAll(this.#in(id), await this.#replyCk(id, ck), b, o)); }
  async draftForward(id, ck, b, o) { return this.#result(await this.backend.draftForward(this.#in(id), await this.#replyCk(id, ck), b, o)); }
  async removeAttachment(id, ck, attId) { return this.#result(await this.backend.removeAttachment(this.#in(id), this.#ck(ck), attId)); }
  async createMessage(o) { return this.#result(await this.backend.createMessage(o)); }
  /** People of the account's directory and contacts matching `query` ([{ name, email }]); none where the backend has no directory. */
  async resolveNames(query) { return typeof this.backend.resolveNames === 'function' ? this.backend.resolveNames(query) : []; }
  /** The mailbox's own contacts (Exchange); none where the backend keeps none. */
  async contacts(o) { return typeof this.backend.contacts === 'function' ? this.backend.contacts(o) : []; }
  async updateDraft({ keepQuoted = false, ...o }) {
    if (keepQuoted && o.body !== undefined) {
      // replace only what is written above the quoted thread of a reply/forward draft
      const cur = await this.backend.getMessage(this.#in(o.id), { bodyType: 'HTML' });
      const merged = replaceAboveQuote({ body: o.body, bodyType: o.bodyType || 'Text' }, cur.body, cur.bodyType);
      o = { ...o, body: merged.body, bodyType: merged.bodyType, changeKey: o.changeKey || cur.changeKey };
    }
    return this.#result(await this.backend.updateDraft({ ...o, id: this.#in(o.id), changeKey: this.#ck(o.changeKey) }));
  }
  async addAttachment(id, ck, a) { return this.#result(await this.backend.addAttachment(this.#in(id), this.#ck(ck), a)); }
  sendItem(id, ck) { return this.backend.sendItem(this.#in(id), this.#ck(ck)); }
  deleteItem(id, ck) { return this.backend.deleteItem(this.#in(id), this.#ck(ck)); }
  /** Move messages to a folder: Map old id → new id (the moved message's), or → null for one that is no longer there. */
  async moveItems(ids, folder) {
    const m = await this.backend.moveItems(ids.map((id) => this.#in(id)), folder);
    return new Map([...m].map(([from, to]) => [`${this.account}:${from}`, to == null ? null : `${this.account}:${to}`]));
  }
  markRead(id, ck, r) { return this.backend.markRead(this.#in(id), this.#ck(ck), r); }
  setFlag(id, ck, f) { return this.backend.setFlag(this.#in(id), this.#ck(ck), f); }
  async webLink(id) { return typeof this.backend.webLink === 'function' ? this.backend.webLink(this.#in(id)) : null; }
  getAttachment(attId, messageId) { return this.backend.getAttachment(attId, messageId ? this.#in(messageId) : undefined); }
  close() { try { this.backend?.close?.(); } catch {} if (this._calendar && this._calendar !== this.backend) try { this._calendar.close?.(); } catch {} }

  // --- calendar (ews-calendar.js, cal-caldav.js or cal-google.js) ----------
  async #cal(method) {
    if (this._calendar === undefined) this._calendar = (await this._calendarFactory()) || null;
    const cal = this._calendar;
    if (!cal || typeof cal[method] !== 'function') {
      throw Object.assign(new Error(`account "${this.account}" has no calendar (Exchange, CalDAV or Google accounts do)`), { code: 'NO_CALENDAR' });
    }
    return cal[method].bind(cal);
  }
  get calendar() { return this._calendar; }
  #event(ev) { return { ...ev, id: this.#out(ev.id), account: this.account }; }
  async findCalendars(o) { return (await (await this.#cal('findCalendars'))(o)).map((c) => ({ ...c, id: this.#out(c.id), account: this.account })); }
  async findEvents(o = {}) { return (await (await this.#cal('findEvents'))({ ...o, calendar: o.calendar ? this.#in(o.calendar) : undefined })).map((e) => this.#event(e)); }
  async getEvent(id) { return this.#event(await (await this.#cal('getEvent'))(this.#in(id))); }
  async createEvent(o) { const r = await (await this.#cal('createEvent'))({ ...o, calendar: o.calendar ? this.#in(o.calendar) : undefined }); return { ...r, id: this.#out(r.id), account: this.account }; }
  async updateEvent(o) { const r = await (await this.#cal('updateEvent'))({ ...o, id: this.#in(o.id) }); return { ...r, id: this.#out(r.id), account: this.account }; }
  async deleteEvent(id, ck, o) { return (await this.#cal('deleteEvent'))(this.#in(id), ck, o); }
  async respondToEvent(id, ck, response, o) { return (await this.#cal('respondToEvent'))(this.#in(id), ck, response, o); }
  async getFreeBusy(o) { return (await this.#cal('getFreeBusy'))(o); }
}

export async function createClient(account, forceRefresh = false) {
  const config = loadConfig();
  const acct = getAccount(config, account);
  const creds = hasMail(acct) || acct.provider === 'caldav' ? await getCredentials(config, acct, forceRefresh) : null;
  const backend = await makeBackend(acct, creds);
  // the calendar backend is built on first calendar call (lazily): a CalDAV password problem must not stop mail
  return new AccountClient(acct.name, backend, () => makeCalendarBackend(acct, backend, config, forceRefresh));
}

/**
 * Run fn(client) for one account with automatic credential refresh: an auth
 * failure (the password rotated) triggers one re-fetch from 1Password and a
 * single retry. `account` may be a name, or a prefixed message id.
 */
export async function withAuthRetry(fn, onRefresh, account) {
  const name = account && splitId(account).account ? splitId(account).account : account;
  const attempt = async (force) => {
    const c = await createClient(name, force);
    try { return await fn(c); } finally { try { await c.close(); } catch {} }
  };
  try {
    return await attempt(false);
  } catch (e) {
    if (!isAuthError(e)) throw e;
    // NTLM 401s are sometimes transient — retry once with the same cached
    // credentials before concluding the password rotated.
    try {
      return await attempt(false);
    } catch (e2) {
      if (!isAuthError(e2)) throw e2;
      if (onRefresh) onRefresh(e2);
      return await attempt(true);
    }
  }
}

/** Account names to query: the one given, or all of them. */
export function selectAccounts(account) {
  const config = loadConfig();
  if (account) return [getAccount(config, account).name];
  return mailAccountNames(config);
}

/**
 * findInbox across accounts (all, or the one named), merged newest-first and
 * trimmed to opts.limit. Any account that fails is reported via onError and
 * skipped so one dead server does not blank the whole listing.
 *
 * Served from the encrypted cache when every requested account is cached,
 * the daemon is alive, and the folder is the inbox; opts.live forces the
 * servers. Cached items carry `cached: true`.
 */
export async function findAcross(account, opts = {}, onError) {
  const names = selectAccounts(account);
  if (cache.cacheUsable(names, opts)) {
    try {
      if (opts.fromMe && names.length === 1) {
        const me = await withAuthRetry((c) => c.selfEmail(), null, names[0]);
        return cache.findCached(names, { ...opts, fromMe: me });
      }
      if (!opts.fromMe) return cache.findCached(names, opts);
    } catch (e) {
      if (onError) onError('cache', e);
    }
  }
  const lists = await Promise.all(
    names.map((n) =>
      withAuthRetry((c) => c.findInbox(opts), null, n).catch((e) => {
        if (onError) onError(n, e);
        else throw e;
        return [];
      })
    )
  );
  const items = lists.flat().sort((a, b) => new Date(b.received) - new Date(a.received));
  return opts && opts.limit ? items.slice(0, opts.limit) : items;
}

/**
 * One full message: cached body when stored, else live (and the live result
 * is written back to the cache for next time). opts.live forces the server.
 */
export async function readMessage(id, opts = {}) {
  const { account } = splitId(id);
  // a stored body only goes stale when a draft is edited (the write paths drop it), so no daemon-liveness check here
  if (!opts.live && account && cache.cachedAccounts().includes(account)) {
    try {
      const hit = cache.getCached(id, opts);
      if (hit) return hit;
    } catch {}
  }
  const msg = await withAuthRetry((c) => c.getMessage(id, opts), null, id);
  if (account && cache.cachedAccounts().includes(account)) {
    try {
      // asked for HTML and given text: this mail has no HTML ('' says so). Asked for text: whether it has any is not known (null)
      const html = msg.bodyType === 'HTML' ? msg.body : opts.bodyType === 'HTML' ? '' : null;
      // keep a text version too so the mail is searchable (FTS) and readable with --plain
      const text = msg.bodyType === 'Text' ? msg.body : htmlToText(msg.body);
      cache.upsertBody(account, msg, { text, html });
    } catch {}
  }
  return msg;
}

/**
 * Save attachments of a message to a directory. `only` filters by attachment
 * id or file name. Returns [{ name, path, size, contentType }]. Existing files
 * are never overwritten (a " (2)" suffix is added).
 */
export async function saveAttachments(id, dir, { only } = {}) {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const msg = await readMessage(id, { bodyType: 'Text' });
  let list = (msg.attachments || []).filter((a) => !a.inline || only);
  if (only) list = list.filter((a) => a.id === only || a.name === only);
  if (list.length === 0) throw new Error(only ? `no attachment "${only}" on this message` : 'this message has no attachments');
  fs.mkdirSync(dir, { recursive: true });
  const saved = [];
  for (const a of list) {
    const file = await withAuthRetry((c) => c.getAttachment(a.id, id), null, id);
    const target = uniquePath(fs, path, dir, safeName(file.name || a.name));
    fs.writeFileSync(target, file.content, { mode: 0o600 });
    saved.push({ name: path.basename(target), path: target, size: file.content.length, contentType: file.contentType });
  }
  return saved;
}

function safeName(name) {
  const n = String(name || 'attachment').replace(/[\/\\:\0]/g, '_').replace(/^\.+/, '_').slice(0, 200);
  return n || 'attachment';
}

function uniquePath(fs, path, dir, name) {
  let target = path.join(dir, name);
  if (!fs.existsSync(target)) return target;
  const ext = path.extname(name);
  const base = name.slice(0, name.length - ext.length);
  for (let i = 2; ; i++) {
    target = path.join(dir, `${base} (${i})${ext}`);
    if (!fs.existsSync(target)) return target;
  }
}

/**
 * Reply to a message: creates the (reply or reply-all) draft, and sends it
 * when `send` is true. Returns { sent, draftId, changeKey }.
 */
export async function replyTo(id, body, { all = false, send = false, changeKey = '', bodyType = 'Text' } = {}) {
  return withAuthRetry(async (c) => {
    const d = all ? await c.draftReplyAll(id, changeKey, body, { bodyType }) : await c.draftReply(id, changeKey, body, { bodyType });
    if (!send) return { sent: false, ...d };
    await c.sendItem(d.draftId, d.changeKey);
    return { sent: true, ...d };
  }, null, id);
}

/** Keep the cache honest after writes that change a cached row. */
export function noteRead(id, isRead = true) { try { cache.setRead(id, isRead); } catch {} }
export function noteFlagged(id, isFlagged = true) { try { cache.setFlagged(id, isFlagged); } catch {} }
export function noteRemoved(id) { try { cache.removeMessage(id); } catch {} }
