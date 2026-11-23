// JMAP backend (RFC 8620 core, RFC 8621 mail) implementing the MailClient contract documented in client.js. Plain
// HTTP with global fetch: the session is fetched once and kept, and calls that depend on each other go in one
// request (back-references). The credential is a Bearer token: the account's API key (its password), or a token
// from a sign-in with a provider (creds.oauth).
//
// Ids are the server's Email ids ([A-Za-z0-9_-]: never a ':' nor a '/', so nothing takes one for an IMAP id). An
// Email keeps its id when it moves between mailboxes. A message is read whole (its raw blob, parsed by mailparser
// as the IMAP backend parses it), so it reads, replies and forwards exactly as there. Emails are immutable: an
// edited draft is imported anew and the old one destroyed, so updateDraft/addAttachment return the NEW id.
//
// No changesIn/newSince/listByUids: those speak of message numbers in one folder (IMAP's UIDs), which JMAP does not
// have. Without them a caller keeps an account in step by listing it (findInbox), as it does Exchange; push (see
// jmap-stream.js) says when to.

import { isIP, BlockList } from 'node:net';
import { lookup as dnsLookup } from 'node:dns/promises';
import { simpleParser } from 'mailparser';
import { displayNameOf, jmapSessionUrl } from './accounts.js';
import { FOLDERS, FOLDER_NAMES, shaped, addrs, compose, isAttachment, stripHtml, replyMail, forwardMail, draftMail, withoutBcc, withMessageId, newMessageId } from './imap.js';
import { AUTH_HEADER_NAMES, authHeadersFrom } from './auth-headers.js';
import { isAutoReply, AUTO_REPLY_HEADERS } from './auto-reply.js';

const CORE = 'urn:ietf:params:jmap:core';
const MAIL = 'urn:ietf:params:jmap:mail';
const SUBMISSION = 'urn:ietf:params:jmap:submission';

/** What a listing asks of each Email. */
const LIST_PROPS = ['id', 'blobId', 'threadId', 'mailboxIds', 'keywords', 'receivedAt', 'messageId', 'inReplyTo', 'from', 'sender', 'to', 'cc', 'subject', 'hasAttachment'];
const BULK_HEADERS = ['header:List-Id', 'header:List-Unsubscribe', 'header:List-Post', 'header:Precedence:asText', 'header:Auto-Submitted:asText'];
const NOT_FOUND = 'message not found (it may have been moved or deleted)';

export class JmapClient {
  changeKeyIsId = true;

  /**
   * opts.allowPrivate (or acct.jmap.allowPrivate) is FOR TESTS ONLY (a server on 127.0.0.1): with it, hosts that
   * resolve to private, loopback or link-local addresses, hosts that are IP literals, and plain http are allowed.
   * Never set it for a real account: the API key would go wherever the session sends it. opts.lookup replaces
   * node:dns's lookup (tests).
   */
  constructor(acct, creds = {}, opts = {}) {
    this.acct = acct;
    this.creds = creds || {};
    this.self = (acct.email || (String(this.creds.username || '').includes('@') ? this.creds.username : '')).toLowerCase();
    this.sessionUrl = jmapSessionUrl(acct);
    this.timeoutMs = 60_000; // one API call
    this.blobTimeoutMs = 300_000; // one upload or download
    this.allowPrivate = !!(opts.allowPrivate ?? acct.jmap?.allowPrivate);
    this.lookup = opts.lookup || dnsLookup;
    this._hosts = new Map(); // hostname → its check (a promise), for the client's lifetime
  }

  async selfEmail() {
    if (!this.self) throw new Error('set "email" on the JMAP account');
    return this.self;
  }

  // --- HTTP, session, method calls ---------------------------------------------

  /** The Authorization header: the API key (the account's password) or a sign-in token, as a Bearer token. */
  async authorization() {
    if (typeof this.creds.oauth === 'function') {
      try { return `Bearer ${await this.creds.oauth()}`; } catch (e) {
        // a sign-in refused is said as such; anything else (offline, the provider down) passes
        if (e?.code === 'MAIL_AUTH') throw e;
        throw Object.assign(new Error(`no sign-in token for now (${e?.message || e})`, { cause: e }), { code: 'MAIL_NETWORK' });
      }
    }
    const token = this.creds.accessToken || this.creds.password;
    if (!token) throw Object.assign(new Error(`account "${this.acct.name}": no API key (the account's password)`), { code: 'MAIL_AUTH' });
    return `Bearer ${token}`;
  }

  /**
   * A request with the account's Authorization, to a URL that passes #guard (else JMAP_UNSAFE, nothing sent).
   * 401 (and a 403 to the session fetch, `authOn403`): MAIL_AUTH. The network failing: MAIL_NETWORK. Any other
   * failure (another 403, a 5xx) is an error with its `status`, never taken for a refused sign-in. timeoutMs 0: none.
   * An error thrown before anything was sent carries `sentNothing`.
   */
  async request(url, init = {}, { timeoutMs = this.timeoutMs, authOn403 = false } = {}) {
    await this.#guard(url);
    let authorization;
    try { authorization = await this.authorization(); } catch (e) { throw Object.assign(e, { sentNothing: true }); }
    const headers = { ...(init.headers || {}), Authorization: authorization };
    const signal = init.signal || (timeoutMs ? AbortSignal.timeout(timeoutMs) : undefined);
    let res;
    try { res = await fetch(url, { ...init, headers, signal }); } catch (e) {
      if (init.signal?.aborted) throw e; // stopped by whoever asked
      throw Object.assign(new Error(`${hostOf(url)} could not be reached (${e?.cause?.message || e?.message || e})`, { cause: e }), { code: 'MAIL_NETWORK' });
    }
    if (res.status === 401 || (res.status === 403 && authOn403)) {
      await res.body?.cancel().catch(() => {});
      throw Object.assign(new Error(`${hostOf(url)} refused the API key (HTTP ${res.status})`), { code: 'MAIL_AUTH', status: res.status });
    }
    if (res.ok || (init.redirect === 'manual' && res.status >= 300 && res.status < 400)) return res;
    const text = await res.text().catch(() => '');
    let said = '';
    try { const p = JSON.parse(text); said = p.detail || p.title || p.description || p.type || ''; } catch { said = text.slice(0, 200).trim(); }
    throw Object.assign(new Error(`${hostOf(url)} answered HTTP ${res.status}${said ? `: ${said}` : ''}`), { status: res.status });
  }

  /** The JMAP session (RFC 8620 §2): fetched once, again when the server says it changed. */
  async session() {
    if (this._session) return this._session;
    this._loading ??= this.#loadSession().finally(() => { this._loading = null; });
    return (this._session = await this._loading);
  }

  async #loadSession() {
    // redirects are followed here, not by fetch, which drops the Authorization on the way to another origin
    // (/.well-known/jmap is a redirect on many servers); never from https to plain http
    let url = this.sessionUrl;
    for (let hops = 0; ; hops++) {
      const res = await this.request(url, { headers: { Accept: 'application/json' }, redirect: 'manual' }, { authOn403: true });
      if (res.status >= 300 && res.status < 400) {
        await res.body?.cancel().catch(() => {});
        const to = res.headers.get('location');
        let next = null;
        try { next = to ? new URL(to, url) : null; } catch {}
        if (!next || hops >= 5) throw new Error(`${hostOf(url)}: the JMAP session could not be found (a redirect that leads nowhere)`);
        // the key goes with the request: never to another origin (another host, or http)
        if (next.origin !== new URL(url).origin) throw unsafe(`${hostOf(url)} redirects the JMAP session to ${next.origin}: not followed with the API key (set jmap.session to the session URL itself)`);
        url = next.href;
        continue;
      }
      const s = await res.json().catch(() => null);
      const accountId = s?.primaryAccounts?.[MAIL];
      if (!s?.apiUrl || !accountId) throw new Error(`${hostOf(url)}: not a JMAP session with mail (${this.sessionUrl})`);
      const session = {
        url,
        state: s.state,
        apiUrl: absolute(s.apiUrl, url),
        downloadUrl: absolute(s.downloadUrl, url),
        uploadUrl: absolute(s.uploadUrl, url),
        eventSourceUrl: s.eventSourceUrl ? absolute(s.eventSourceUrl, url) : null,
        accountId,
        submissionAccountId: s.primaryAccounts[SUBMISSION] || null,
        maxObjectsInGet: Math.max(1, Math.min(500, Number(s.capabilities?.[CORE]?.maxObjectsInGet) || 500))
      };
      this.#checkSessionUrls(session);
      return session;
    }
  }

  /**
   * Where the session sends the key: apiUrl, uploadUrl and eventSourceUrl https on the session's own host;
   * downloadUrl https, on another host only when that is a public DNS name (Fastmail's is www.fastmailusercontent.com).
   */
  #checkSessionUrls(s) {
    const home = new URL(s.url).hostname;
    const check = (what, template, sameHost) => {
      if (!template) return;
      let u;
      try { u = new URL(expand(template, {})); } catch { throw unsafe(`the JMAP session's ${what} is not a URL`); }
      if (!this.#schemeOk(u)) throw unsafe(`the JMAP session's ${what} is not https (${u.origin})`);
      if (u.hostname === home) return;
      if (sameHost) throw unsafe(`the JMAP session's ${what} is on another host (${u.hostname}, not ${home})`);
      if (!this.allowPrivate && !isPublicName(u.hostname)) throw unsafe(`the JMAP session's ${what} is on ${u.hostname}: not a public host name`);
    };
    check('apiUrl', s.apiUrl, true);
    check('uploadUrl', s.uploadUrl, true);
    check('eventSourceUrl', s.eventSourceUrl, true);
    check('downloadUrl', s.downloadUrl, false);
  }

  #schemeOk(u) { return u.protocol === 'https:' || (this.allowPrivate && u.protocol === 'http:'); }

  /**
   * Before the key goes to a URL: https; not an IP literal; a host whose every address is public (resolved once per
   * host for the client's lifetime). allowPrivate (tests only) lets http, IP literals and private addresses by.
   */
  async #guard(url) {
    let u;
    try { u = new URL(url); } catch { throw unsafe(`not a URL: ${String(url).slice(0, 100)}`); }
    if (!this.#schemeOk(u)) throw unsafe(`${u.host}: not https, the API key is not sent there`);
    if (this.allowPrivate) return;
    const host = u.hostname.replace(/^\[|\]$/g, '');
    if (isIP(host)) throw unsafe(`${host}: an IP address, not a host name; the API key is not sent there`);
    let check = this._hosts.get(host);
    if (!check) {
      check = this.lookup(host, { all: true }).then((addrs) => {
        const list = (Array.isArray(addrs) ? addrs : [addrs]).map((a) => (typeof a === 'string' ? a : a?.address));
        if (!list.length) throw unsafe(`${host} has no address`);
        const bad = list.find((a) => isPrivateAddress(a));
        if (bad !== undefined) throw unsafe(`${host} is at a private address (${bad}); the API key is not sent there`);
      }, (e) => {
        this._hosts.delete(host); // (a lookup that failed is tried again next time)
        throw Object.assign(new Error(`${host} could not be found (${e?.code || e?.message || e})`, { cause: e }), { code: 'MAIL_NETWORK', sentNothing: true });
      });
      this._hosts.set(host, check);
    }
    await check;
  }

  /**
   * Method calls ([name, args, tag]) in one request; every call's args get the account's id unless they carry one.
   * → Map tag → the arguments of its answer (and "<tag> <name>" for each, an implicit Email/set among them). A method
   * that fails throws, with the server's own words.
   */
  async #run(calls) {
    const s = await this.session();
    const methodCalls = calls.map(([name, args, tag]) => [name, { accountId: s.accountId, ...args }, tag]);
    const using = [CORE, MAIL, ...(calls.some(([n]) => /^(EmailSubmission|Identity)\//.test(n)) ? [SUBMISSION] : [])];
    const res = await this.request(s.apiUrl, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify({ using, methodCalls }) });
    const body = await res.json().catch(() => null);
    if (!Array.isArray(body?.methodResponses)) throw new Error(`${hostOf(s.apiUrl)}: not a JMAP answer`);
    if (body.sessionState && s.state && body.sessionState !== s.state) this._session = null; // read again at the next call
    const out = new Map();
    for (const [name, args, tag] of body.methodResponses) {
      if (name === 'error') throw methodError(calls.find((c) => c[2] === tag)?.[0] || 'a call', args);
      if (!out.has(tag)) out.set(tag, args);
      out.set(`${tag} ${name}`, args);
    }
    return out;
  }

  async #one(name, args) { return (await this.#run([[name, args, '0']])).get('0'); }

  /** Email/get of many ids, in as many calls as the server takes ids at once. */
  async #getEmails(ids, properties) {
    const per = (await this.session()).maxObjectsInGet;
    const list = [];
    for (let at = 0; at < ids.length; at += per) list.push(...((await this.#one('Email/get', { ids: ids.slice(at, at + per), properties })).list || []));
    return list;
  }

  async #email(id, properties = LIST_PROPS) {
    const [e] = await this.#getEmails([id], properties);
    if (!e) throw new Error(NOT_FOUND);
    return e;
  }

  async #download(blobId, type = 'application/octet-stream', name = 'blob') {
    const s = await this.session();
    const res = await this.request(expand(s.downloadUrl, { accountId: s.accountId, blobId, type, name }), {}, { timeoutMs: this.blobTimeoutMs });
    return Buffer.from(await res.arrayBuffer());
  }

  async #upload(content, type) {
    const s = await this.session();
    const res = await this.request(expand(s.uploadUrl, { accountId: s.accountId }), { method: 'POST', headers: { 'Content-Type': type }, body: content }, { timeoutMs: this.blobTimeoutMs });
    const got = await res.json().catch(() => null);
    if (!got?.blobId) throw new Error(`${hostOf(s.uploadUrl)}: the upload was not taken`);
    return got.blobId;
  }

  // --- mailboxes -----------------------------------------------------------------

  async #mailboxes() {
    if (this._boxes) return this._boxes;
    const { list = [] } = await this.#one('Mailbox/get', { ids: null, properties: ['id', 'name', 'parentId', 'role'] });
    const byId = new Map(list.map((b) => [b.id, b]));
    const pathOf = (b) => {
      const names = [];
      for (let at = b, n = 0; at && n < 32; at = byId.get(at.parentId), n++) names.unshift(at.name);
      return names.join('/');
    };
    const find = (name) => list.find((b) => pathOf(b) === name) || list.find((b) => b.name === name)
      || list.find((b) => pathOf(b).toLowerCase() === String(name).toLowerCase());
    const map = {};
    for (const f of FOLDERS) {
      const override = this.acct.jmap?.folders?.[f];
      const byRole = list.find((b) => String(b.role || '').toLowerCase() === f);
      const byName = list.find((b) => !b.parentId && FOLDER_NAMES[f].includes(String(b.name || '').toLowerCase()));
      map[f] = (override && find(override)?.id) || byRole?.id || byName?.id || null;
    }
    this._boxes = { map, find };
    return this._boxes;
  }

  /** A folder's mailbox id: inbox|junk|sent|drafts|trash|archive by role (or name), else a mailbox of one's own by its path or name. */
  async #folder(key) {
    const k = String(key || 'inbox');
    const boxes = await this.#mailboxes();
    if (FOLDERS.includes(k.toLowerCase())) {
      const id = boxes.map[k.toLowerCase()];
      if (!id) throw new Error(`no "${k.toLowerCase()}" mailbox on this JMAP server — set accounts.${this.acct.name}.jmap.folders.${k.toLowerCase()} in config`);
      return id;
    }
    const own = boxes.find(k);
    if (!own) throw new Error(`unknown folder "${key}" — use: ${FOLDERS.join(', ')}, or the name of a mailbox of yours`);
    return own.id;
  }

  // --- reading -----------------------------------------------------------------

  async findInbox(opts = {}) {
    const max = Math.min(opts.limit || 25, 100);
    const offset = Math.max(0, Number(opts.offset) || 0);
    if (opts.threadId) {
      // (RFC 8621 has no filter by thread: the thread's messages, then the rest of the search here)
      const got = (await this.findThread({ folder: opts.folder, threadId: opts.threadId })) || [];
      return got.filter((i) => (!opts.unreadOnly || !i.isRead) && (!opts.flaggedOnly || i.isFlagged)).slice(offset, offset + max);
    }
    const all = [{ inMailbox: await this.#folder(opts.folder) }];
    if (opts.unreadOnly) all.push({ notKeyword: '$seen' });
    if (opts.flaggedOnly) all.push({ hasKeyword: '$flagged' });
    if (opts.senderContains) all.push({ from: String(opts.senderContains) });
    if (opts.subjectContains) all.push({ subject: String(opts.subjectContains) });
    if (opts.fromMe) all.push({ from: await this.selfEmail() });
    if (opts.hasAttachments) all.push({ hasAttachment: true });
    if (opts.sinceIso) all.push({ after: utcDate(new Date(opts.sinceIso)) });
    // up to and with the cursor's own second (before is exclusive)
    if (opts.untilIso) all.push({ before: utcDate(new Date(Math.floor(new Date(opts.untilIso).getTime() / 1000) * 1000 + 1000)) });
    const withAny = (Array.isArray(opts.withAny) ? opts.withAny : opts.withAny ? [opts.withAny] : []).filter((a) => typeof a === 'string' && a);
    if (withAny.length) all.push({ operator: 'OR', conditions: withAny.flatMap((a) => [{ from: a }, { to: a }, { cc: a }]) });
    if (opts.toContains) all.push({ operator: 'OR', conditions: [{ to: String(opts.toContains) }, { cc: String(opts.toContains) }] });
    for (const t of Array.isArray(opts.text) ? opts.text : opts.text ? [opts.text] : []) all.push({ text: String(t) });
    const filter = all.length === 1 ? all[0] : { operator: 'AND', conditions: all };
    const got = await this.#queryEmails({ filter, sort: [{ property: 'receivedAt', isAscending: false }], position: offset, limit: max, collapseThreads: false }, LIST_PROPS);
    return newestFirst(got.map(listItem));
  }

  /**
   * Email/query, then Email/get of what it found, in the query's order: in one request (a back-reference) when the
   * server takes that many ids in one Email/get (maxObjectsInGet), else the ids first and the Emails in chunks.
   */
  async #queryEmails(query, properties) {
    const per = (await this.session()).maxObjectsInGet;
    if (query.limit <= per) {
      const r = await this.#run([
        ['Email/query', query, 'q'],
        ['Email/get', { '#ids': { resultOf: 'q', name: 'Email/query', path: '/ids' }, properties }, 'g']
      ]);
      return r.get('g').list || [];
    }
    const ids = (await this.#one('Email/query', query)).ids || [];
    return inOrder(await this.#getEmails(ids, properties), ids);
  }

  /** The messages of one of the server's threads (a message's conversationId) that are in a folder: Thread/get, then the Emails. */
  async findThread({ folder, threadId, limit = 100 } = {}) {
    if (!threadId) return null;
    const box = await this.#folder(folder);
    // (two requests: a thread may hold more Emails than the server gives in one Email/get)
    const { list = [] } = await this.#one('Thread/get', { ids: [String(threadId)] });
    const ids = [...new Set(list.flatMap((t) => t.emailIds || []))];
    const got = await this.#getEmails(ids, LIST_PROPS);
    return newestFirst(got.filter((e) => e.mailboxIds?.[box]).map(listItem)).slice(0, limit);
  }

  async getMessage(id, { bodyType = 'Text' } = {}) {
    const { item, parsed } = await this.#read(id);
    return shaped(item, parsed, bodyType);
  }

  /** A message: its list item, mailparser's reading of its raw blob, and the blob itself. */
  async #read(id) {
    const e = await this.#email(id);
    const raw = await this.#download(e.blobId, 'message/rfc822', 'message.eml');
    return { item: listItem(e), parsed: await simpleParser(raw), raw };
  }

  /** Download one attachment, as getMessage lists it (the message is read and parsed again). */
  async getAttachment(attId, messageId) {
    if (!messageId) throw new Error('getAttachment: the message id is required for JMAP');
    const { parsed } = await this.#read(messageId);
    const list = parsed.attachments || [];
    const a = list.find((x, i) => isAttachment(x, i, attId)) || list.find((x) => x.filename === attId);
    if (!a) throw new Error(`attachment "${attId}" not found on this message`);
    return { name: a.filename || 'attachment', contentType: a.contentType || 'application/octet-stream', contentId: a.cid || undefined, content: a.content };
  }

  /** Bulk/list mail, by its headers (no bodies): Map id → boolean. */
  async bulkFlags(ids) {
    const out = new Map();
    for (const e of await this.#getEmails(ids.filter(isJmapId), ['id', ...BULK_HEADERS])) {
      const [listId, unsub, post, precedence, auto] = BULK_HEADERS.map((p) => e[p]);
      const a = String(auto || '').trim().toLowerCase();
      out.set(e.id, !!(listId || unsub || post) || /bulk|list|junk/.test(String(precedence || '').toLowerCase()) || (!!a && !/^no\b/.test(a)));
    }
    return out;
  }

  /** The authentication headers of many messages: Map id → { results, bimiSelector, msAuthAs, fromEmail } (auth-headers.js). */
  async authHeadersOf(ids) {
    const props = AUTH_HEADER_NAMES.map((n) => `header:${n}:all`);
    const out = new Map();
    for (const e of await this.#getEmails(ids.filter(isJmapId), ['id', 'from', ...props])) {
      const pairs = AUTH_HEADER_NAMES.flatMap((n, i) => (e[props[i]] || []).map((v) => [n, v]));
      out.set(e.id, { ...authHeadersFrom(pairs), fromEmail: String(e.from?.[0]?.email || '').toLowerCase() });
    }
    return out;
  }

  /** Whom my newest sent mail went to: [{ to, sent }], oldest first as on IMAP, To only, automatic answers left out. */
  async sentTo({ limit = 200 } = {}) {
    const sent = await this.#folder('sent');
    const heads = AUTO_REPLY_HEADERS.map((n) => `header:${n}:asText`);
    const got = await this.#queryEmails({ filter: { inMailbox: sent }, sort: [{ property: 'receivedAt', isAscending: false }], limit: Math.max(1, Math.min(200, limit)) }, ['id', 'to', 'subject', 'sentAt', 'receivedAt', ...heads]);
    const out = [];
    for (const e of got) {
      const said = AUTO_REPLY_HEADERS.map((n, i) => (e[heads[i]] == null ? '' : `${n}: ${e[heads[i]]}`)).join('\n');
      if (isAutoReply(e.subject, said)) continue;
      const to = [...new Set((e.to || []).map((a) => String(a.email || '').toLowerCase()).filter((x) => x.includes('@')))];
      const at = new Date(e.sentAt || e.receivedAt || 0);
      if (to.length) out.push({ to, sent: (isNaN(at) ? new Date(0) : at).toISOString() });
    }
    return out.reverse();
  }

  // --- drafts and sending ---------------------------------------------------------

  async draftReply(id, changeKey, newBodyText, { bodyType = 'Text' } = {}) {
    return this.draftReplyAll(id, changeKey, newBodyText, { all: false, bodyType });
  }

  async draftReplyAll(id, _changeKey, newBodyText, { all = true, bodyType = 'Text' } = {}) {
    const { parsed } = await this.#read(id);
    const draftId = await this.#importDraft(replyMail(parsed, newBodyText, { all, bodyType, self: this.self, from: this.#from }));
    return { draftId, changeKey: draftId };
  }

  async draftForward(id, _changeKey, newBodyText, { bodyType = 'Text', to = [], cc = [], bcc = [] } = {}) {
    const { parsed } = await this.#read(id);
    const draftId = await this.#importDraft(forwardMail(parsed, newBodyText, { bodyType, to, cc, bcc, from: this.#from }));
    return { draftId, changeKey: draftId };
  }

  async createMessage({ to = [], cc = [], bcc = [], subject = '', body = '', bodyType = 'Text', send = false }) {
    const html = bodyType === 'HTML';
    const mail = { from: this.#from, to, cc, bcc, subject, text: html ? stripHtml(body) : body, html: html ? body : undefined };
    if (!send) {
      const draftId = await this.#importDraft(mail);
      return { sent: false, draftId, changeKey: draftId };
    }
    // Bcc in the envelope only; the copy kept in Sent has it (as on IMAP)
    const whole = await compose(mail, { keepBcc: true });
    const sentId = await this.#submit(withoutBcc(whole), { from: this.self, to: [...to, ...cc, ...bcc] }, { sentCopy: bcc.length ? whole : null });
    return { sent: true, draftId: sentId, changeKey: sentId };
  }

  async updateDraft({ id, changeKey, subject, body, bodyType = 'Text', to, cc, bcc }) {
    if (subject === undefined && body === undefined && to === undefined && cc === undefined && bcc === undefined) {
      throw new Error('updateDraft: nothing to change');
    }
    const draftId = await this.#rewriteDraft(changeKey || id, (mail) => {
      if (subject !== undefined) mail.subject = subject;
      if (body !== undefined) {
        if (bodyType === 'HTML') { mail.html = body; mail.text = stripHtml(body); }
        else { mail.text = body; delete mail.html; }
      }
      if (to !== undefined) mail.to = to;
      if (cc !== undefined) mail.cc = cc;
      if (bcc !== undefined) mail.bcc = bcc;
    });
    return { draftId, changeKey: draftId };
  }

  async addAttachment(id, changeKey, { name, contentBase64, contentType, inline = false, contentId }) {
    const draftId = await this.#rewriteDraft(changeKey || id, (mail) => {
      mail.attachments.push({
        filename: name, content: Buffer.from(contentBase64, 'base64'), contentType: contentType || undefined,
        ...(inline ? { cid: contentId || name, contentDisposition: 'inline' } : {})
      });
    });
    return { attachmentId: name, draftId, changeKey: draftId };
  }

  async removeAttachment(id, changeKey, attId) {
    const draftId = await this.#rewriteDraft(changeKey || id, (mail, parsed) => {
      const at = (parsed.attachments || []).findIndex((x, i) => isAttachment(x, i, attId) || x.filename === attId);
      if (at < 0) throw new Error(`attachment "${attId}" not found on this draft`);
      mail.attachments.splice(at, 1);
    });
    return { draftId, changeKey: draftId };
  }

  async sendItem(id, changeKey) {
    const draft = changeKey || id;
    const { parsed, raw } = await this.#read(draft);
    const to = [...addrs(parsed.to), ...addrs(parsed.cc), ...addrs(parsed.bcc)].map((a) => a.email).filter(Boolean);
    if (to.length === 0) throw new Error('sendItem: the draft has no recipients');
    const from = addrs(parsed.from)[0]?.email || this.self;
    // as on IMAP: under a Message-ID of its own, not its draft's, and with no Bcc in what the others receive (the
    // copy kept in Sent has it)
    const mail = withMessageId(raw, newMessageId(from));
    await this.#submit(withoutBcc(mail), { from, to }, { sentCopy: addrs(parsed.bcc).length ? mail : null });
    // It has left. Removing the draft never makes this a send that failed (whoever tries again would send it twice).
    try { await this.#destroy([draft]); } catch { try { await this.#destroy([draft]); } catch {} }
    return true;
  }

  /** A raw message into Drafts (with its Bcc: a draft remembers it), as a draft: its new id. */
  async #importDraft(mail) {
    const drafts = await this.#folder('drafts');
    return this.#import(await compose(mail, { keepBcc: true }), { [drafts]: true }, { $draft: true, $seen: true });
  }

  async #import(raw, mailboxIds, keywords) {
    const blobId = await this.#upload(raw, 'message/rfc822');
    const r = await this.#one('Email/import', { emails: { m: { blobId, mailboxIds, keywords } } });
    const id = r.created?.m?.id;
    if (!id) throw setError('Email/import', r.notCreated?.m);
    return id;
  }

  /** A draft written again: read, changed by `mutate(mail, parsed)`, imported as a new draft; the old one goes. Its new id. */
  async #rewriteDraft(id, mutate) {
    const { parsed } = await this.#read(id);
    const mail = draftMail(parsed, { self: this.self, from: this.#from });
    mutate(mail, parsed);
    const newId = await this.#importDraft(mail);
    // (the new draft is there: an old one that will not go is not a reason to lose its id)
    try { await this.#destroy([id]); } catch { try { await this.#destroy([id]); } catch {} }
    return newId;
  }

  /**
   * Send a raw message: imported as a draft, then submitted (EmailSubmission/set) to the envelope's recipients;
   * once sent the server moves it to Sent and takes its $draft off (onSuccessUpdateEmail). `sentCopy` (the message
   * with its Bcc): imported into Sent in its place once sent. The id of what is in Sent.
   *
   * The copy made for sending is destroyed only when the server says the submission was not made (notCreated, a
   * method error, or the request refused as a whole: a 4xx, or nothing sent at all). A network failure, a timeout,
   * a 5xx or an answer that says nothing about it may come after the mail left: SEND_UNKNOWN, and the copy is kept.
   */
  async #submit(raw, { from, to }, { sentCopy = null } = {}) {
    const s = await this.session();
    if (!s.submissionAccountId) throw new Error('this JMAP account cannot send (the server offers no submission)');
    const [drafts, sent] = [await this.#folder('drafts'), await this.#folder('sent')]; // (before anything leaves)
    const identityId = await this.#identity(from);
    const emailId = await this.#import(raw, { [drafts]: true }, { $draft: true, $seen: true });
    const notSent = async (e) => { await this.#destroy([emailId]).catch(() => {}); return e; }; // the copy made for it goes
    let r;
    try {
      r = await this.#run([['EmailSubmission/set', {
        accountId: s.submissionAccountId,
        create: { send: { identityId, emailId, envelope: { mailFrom: { email: from }, rcptTo: to.map((email) => ({ email })) } } },
        onSuccessUpdateEmail: { '#send': { mailboxIds: { [sent]: true }, 'keywords/$draft': null } }
      }, 's']]);
    } catch (e) {
      if (e?.jmapType || e?.sentNothing || (e?.status >= 400 && e?.status < 500)) throw await notSent(e);
      throw sendUnknown(e);
    }
    const answer = r.get('s');
    if (!answer?.created?.send) {
      if (answer?.notCreated?.send) throw await notSent(setError('EmailSubmission/set', answer.notCreated.send));
      throw sendUnknown(new Error('the server said nothing of the submission'));
    }
    // It has left: nothing below makes this a send that failed (whoever tries again would send it twice).
    // A server that did not move it (no implicit Email/set) is asked once more.
    const moved = r.get('s Email/set')?.updated;
    if (!(moved && emailId in moved)) {
      await this.#update(emailId, { mailboxIds: { [sent]: true }, 'keywords/$draft': null }).catch(() => {});
    }
    if (!sentCopy) return emailId;
    // the copy with its Bcc in Sent, in place of the one submitted (which stays when this fails)
    let keptId = null;
    const keep = async () => { keptId = await this.#import(sentCopy, { [sent]: true }, { $seen: true }); };
    try { await keep(); } catch { try { await keep(); } catch { return emailId; } }
    try { await this.#destroy([emailId]); } catch { try { await this.#destroy([emailId]); } catch {} }
    return keptId;
  }

  /** The identity to send as: the one of the From address, else the account's own, else the first. */
  async #identity(from) {
    this._identities ??= (await this.#one('Identity/get', { accountId: (await this.session()).submissionAccountId, ids: null })).list || [];
    const of = (email) => { const e = String(email || '').toLowerCase(); return this._identities.find((i) => String(i.email || '').toLowerCase() === e); };
    const wild = this._identities.find((i) => String(i.email || '').startsWith('*@') && String(from || '').toLowerCase().endsWith(String(i.email).slice(1).toLowerCase()));
    const pick = of(from) || wild || of(this.self) || this._identities[0];
    if (!pick) throw new Error('the JMAP server has no identity to send as');
    return pick.id;
  }

  // --- changes -----------------------------------------------------------------

  /** Move to the trash; what is in the trash already is destroyed. */
  async deleteItem(id, changeKey) {
    const target = changeKey || id;
    const trash = await this.#folder('trash');
    const e = await this.#email(target, ['id', 'mailboxIds']);
    if (e.mailboxIds?.[trash]) await this.#destroy([target], { strict: true });
    else await this.#update(target, { mailboxIds: { [trash]: true } });
    return true;
  }

  /** Move messages to a folder. Map old id → new id: the same (a JMAP id stays with the message), null for one that is gone. */
  async moveItems(ids, folder) {
    const dest = await this.#folder(folder);
    const out = new Map();
    if (!ids.length) return out;
    const r = await this.#one('Email/set', { update: Object.fromEntries(ids.map((id) => [id, { mailboxIds: { [dest]: true } }])) });
    let failure = null;
    for (const id of ids) {
      if (r.updated && id in r.updated) out.set(id, id);
      else if (r.notUpdated?.[id]?.type === 'notFound') out.set(id, null);
      else failure ??= setError('Email/set', r.notUpdated?.[id]); // left out: not moved
    }
    if (failure && ![...out.values()].some((v) => v != null)) throw failure;
    return out;
  }

  async markRead(id, changeKey, isRead = true) { await this.#update(changeKey || id, { 'keywords/$seen': isRead ? true : null }); return true; }

  /** $flagged: a flag (a star elsewhere). */
  async setFlag(id, changeKey, flagged = true) { await this.#update(changeKey || id, { 'keywords/$flagged': flagged ? true : null }); return true; }

  async #update(id, patch) {
    const r = await this.#one('Email/set', { update: { [id]: patch } });
    if (r.updated && id in r.updated) return;
    if (r.notUpdated?.[id]?.type === 'notFound') throw new Error('message not found: it is no longer in that folder');
    throw setError('Email/set', r.notUpdated?.[id]);
  }

  /** `strict`: one that is not there is an error (else it is gone, as was asked). */
  async #destroy(ids, { strict = false } = {}) {
    const r = await this.#one('Email/set', { destroy: ids });
    for (const id of ids) {
      const no = r.notDestroyed?.[id];
      if (!no || (no.type === 'notFound' && !strict)) continue;
      throw no.type === 'notFound' ? new Error(NOT_FOUND) : setError('Email/set', no);
    }
  }

  // --- the rest of the contract ------------------------------------------------

  /** No connection is held: there is nothing to ask. */
  async ping() { return true; }

  /** Nothing to sign out of; the session is read again by whoever uses this client next. */
  async close() { this._session = null; this._boxes = null; this._identities = undefined; }

  /** The state of the account's Emails (what push compares with): Email/get of nothing. */
  async emailState() { return (await this.#one('Email/get', { ids: [], properties: ['id'] })).state ?? null; }

  /** The From of mail written here: the address, with the name the account writes as when one is set (displayName). */
  get #from() {
    const name = displayNameOf(this.acct);
    return name ? { name, address: this.self } : this.self;
  }
}

// --- helpers -----------------------------------------------------------------

function listItem(e) {
  const from = e.from?.[0] || e.sender?.[0] || {};
  const to = e.to || [];
  const cc = e.cc || [];
  const kw = Object.fromEntries(Object.entries(e.keywords || {}).map(([k, v]) => [k.toLowerCase(), v]));
  return {
    id: e.id,
    changeKey: '',
    subject: e.subject || '',
    fromName: from.name || '',
    fromEmail: from.email || '',
    displayTo: to.map((a) => a.name || a.email).filter(Boolean).join('; '),
    toPeople: [...to, ...cc].filter((a) => a.email).map((a) => ({ name: a.name || '', email: String(a.email).toLowerCase() })),
    isRead: !!kw.$seen,
    isFlagged: !!kw.$flagged,
    hasAttachments: !!e.hasAttachment,
    received: new Date(e.receivedAt || 0).toISOString(),
    conversationId: e.threadId ? String(e.threadId) : '',
    // as an IMAP envelope gives them: in angle brackets
    messageId: bracketed(e.messageId),
    inReplyTo: bracketed(e.inReplyTo)
  };
}

/** A submission that may or may not have gone (the request went out, no answer came that says). */
const sendUnknown = (cause) => Object.assign(new Error('the server may have sent it: check Sent before sending again', { cause }), { code: 'SEND_UNKNOWN' });

/** Emails in the order of their ids. */
const inOrder = (list, ids) => { const at = new Map(ids.map((id, i) => [id, i])); return list.sort((a, b) => (at.get(a.id) ?? 0) - (at.get(b.id) ?? 0)); };

/** A refused URL: the key is not sent there. */
const unsafe = (message) => Object.assign(new Error(message), { code: 'JMAP_UNSAFE', sentNothing: true });

const PRIVATE_V4 = new BlockList();
for (const [net, bits] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.168.0.0', 16]]) PRIVATE_V4.addSubnet(net, bits, 'ipv4');
const PRIVATE_V6 = new BlockList();
PRIVATE_V6.addAddress('::', 'ipv6');
PRIVATE_V6.addAddress('::1', 'ipv6');
PRIVATE_V6.addSubnet('fc00::', 7, 'ipv6');
PRIVATE_V6.addSubnet('fe80::', 10, 'ipv6');

/** A private, loopback, link-local or unspecified address, or an IPv4-mapped IPv6 one (anything not an address too). */
export function isPrivateAddress(addr) {
  const a = String(addr || '').replace(/^\[|\]$/g, '').replace(/%.*$/, '');
  const v = isIP(a);
  if (v === 4) return PRIVATE_V4.check(a, 'ipv4');
  if (v !== 6) return true;
  if (new URL(`http://[${a}]`).hostname.startsWith('[::ffff:')) return true; // (::ffff:a.b.c.d, however written)
  return PRIVATE_V6.check(a, 'ipv6');
}

/** A DNS name that may be public: not an IP literal, not localhost, *.local, *.internal or *.lan. */
function isPublicName(hostname) {
  const h = String(hostname).toLowerCase().replace(/\.$/, '');
  if (!h || isIP(h.replace(/^\[|\]$/g, ''))) return false;
  if (!h.includes('.')) return false;
  return !(h === 'localhost' || /\.(localhost|local|internal|lan)$/.test(h));
}

const bracketed = (ids) => (Array.isArray(ids) ? ids.map((x) => `<${x}>`).join(' ') : '');
const newestFirst = (items) => items.sort((a, b) => new Date(b.received) - new Date(a.received));
/** Whether an id can be a JMAP id (one of another backend, asked of this one, is left out rather than refused by the server). */
const isJmapId = (id) => /^[A-Za-z0-9_-]{1,255}$/.test(String(id));
/** RFC 3339 in UTC, no fraction of a second (a UTCDate). */
const utcDate = (d) => d.toISOString().replace(/\.\d{3}Z$/, 'Z');

function hostOf(url) {
  try { return new URL(url).host; } catch { return 'the JMAP server'; }
}

/** A session URL as given, made whole against the session's own (by hand: new URL() would escape a template's braces). */
function absolute(u, base) {
  const s = String(u || '');
  if (!s || /^https?:\/\//i.test(s)) return s;
  return s.startsWith('/') ? new URL(base).origin + s : base.replace(/[^/]*$/, '') + s;
}

/** A URL template (RFC 6570 level 1, as the session's are) with its variables filled in. */
export function expand(template, vars) {
  return String(template).replace(/\{(\w+)\}/g, (_, k) => encodeURIComponent(vars[k] ?? ''));
}

function methodError(method, args) {
  const type = args?.type || 'serverFail';
  return Object.assign(new Error(`the JMAP server refused ${method}: ${type}${args?.description ? ` (${args.description})` : ''}`), { jmapType: type });
}

function setError(method, err) {
  return methodError(method, err || { type: 'serverFail', description: 'no answer for that item' });
}
