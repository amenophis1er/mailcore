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

import { calendarProvider, hasMail } from './accounts.js';
import { replaceAboveQuote } from './body.js';

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

/** The folder, mailbox generation and message number an IMAP id holds, or null for anything else. */
export function idParts(id) {
  const m = String(id ?? '').match(/^(.+)\/(\d+)\/(\d+)$/);
  if (!m) return null;
  try { return { path: decodeURIComponent(m[1]), validity: m[2], uid: Number(m[3]) }; } catch { return null; }
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
export async function makeCalendarBackend(acct, mailBackend, { timeZone = null, getPassword, accessToken, signInHint, refresh = false } = {}) {
  const kind = calendarProvider(acct);
  if (!kind) return null;
  if (kind === 'ews') return mailBackend;
  const spec = acct.provider === 'imap' ? acct.calendar : acct;
  if (kind === 'google') {
    const m = await import('./cal-google.js');
    return new m.GoogleCalendar({ account: acct.name, email: spec.email || acct.email, timeZone, accessToken, ...(signInHint ? { signInHint } : {}) });
  }
  const m = await import('./cal-caldav.js');
  // credentials: the account's own (calendar-only), or those of the calendar block, asked for as account "<account>/calendar"
  const credAcct = acct.provider === 'imap' ? { ...spec, name: `${acct.name}/calendar`, provider: 'caldav' } : acct;
  const creds = await getPassword(credAcct, { refresh });
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
  /** What changed in a folder since a mark (IMAP; see ImapClient.changesIn): ids prefixed; null where the backend cannot say. */
  async changesIn(folder, o) {
    if (typeof this.backend.changesIn !== 'function') return null;
    const r = await this.backend.changesIn(folder, o);
    return r.flags ? { ...r, flags: r.flags.map((f) => ({ ...f, id: this.#out(f.id) })) } : r;
  }
  async listByUids(folder, uids) { return (await this.backend.listByUids(folder, uids)).map((i) => this.#item(i)); }
  /** Whole messages that arrived since a mark only the backend understands (IMAP: a UID); null where the backend cannot say. */
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
  /**
   * Release both backends (IMAP signs out). The sign-out is started, not
   * waited for: an operation does not pay a LOGOUT round trip on its way out
   * (ImapClient.close caps its own wait). wait: true resolves once both are
   * closed. Never rejects.
   */
  async close({ wait = false } = {}) {
    const closing = [this.backend?.close?.bind(this.backend)];
    if (this._calendar && this._calendar !== this.backend) closing.push(this._calendar.close?.bind(this._calendar));
    const done = Promise.all(closing.filter(Boolean).map(async (fn) => { try { await fn(); } catch {} }));
    if (wait) await done;
  }

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

