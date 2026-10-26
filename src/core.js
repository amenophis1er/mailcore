// The mailcore instance: the caller's accounts, credentials and data
// directory in, mail and calendar operations out. Nothing here reads a
// config file, a keychain or the environment — all of it is handed in.

import fs from 'node:fs';
import path from 'node:path';
import { normalizeAccounts, calendarProvider, hasMail, MAIL_PROVIDERS } from './accounts.js';
import { AccountClient, splitId, isAuthError, makeBackend, makeCalendarBackend, makeStream } from './client.js';
import { createCache } from './cache.js';
import { googleAuth } from './google-auth.js';
import { calendarApi } from './calendar.js';
import { awaitingApi } from './awaiting.js';
import { jsonFileStore, memoryStore } from './store.js';

const val = (x) => (typeof x === 'function' ? x() : x);
const emptyState = () => ({ seenIds: [], baselined: false });

export class Mailcore {
  /**
   * @param {object} o
   * @param {object|Array|Function} o.accounts   { name: def } | [{ name, … }] | () => either
   * @param {string|Function} [o.defaultAccount]
   * @param {object} o.credentials  { getPassword(account, { refresh }), google?: { get(account), set(account, tokens) } }
   * @param {string} [o.dataDir]    where cache.db (and, by default, the watcher state) live
   * @param {string|Function} [o.cacheKey]  the cache key, or ({ create }) => key | null; none = no cache
   * @param {object} [o.state]      { load(), save(obj) } for watcher state; default <dataDir>/state.json
   * @param {string|Function} [o.timeZone]  IANA zone for all-day events and free slots
   * @param {number|Function} [o.pollSeconds]
   * @param {object} [o.google]     { clientId, clientSecret } — the OAuth client for Google calendars
   * @param {Function} [o.cacheFresh]  (accounts) => boolean, replaces the "watcher polled recently" test
   * @param {Function} [o.log]
   */
  constructor({ accounts, defaultAccount, credentials, dataDir = null, cacheKey = null, state, timeZone = null, pollSeconds = 30, google = {}, cacheFresh, log } = {}) {
    if (!credentials || typeof credentials.getPassword !== 'function') {
      throw new TypeError('createMailcore: credentials.getPassword(account, { refresh }) is required');
    }
    this._accounts = accounts || {};
    this._defaultAccount = defaultAccount;
    this._timeZone = timeZone;
    this._pollSeconds = pollSeconds;
    this.credentials = credentials;
    this.dataDir = dataDir;
    this.log = typeof log === 'function' ? log : () => {};
    this.state = state || (dataDir ? jsonFileStore(path.join(dataDir, 'state.json'), emptyState) : memoryStore(emptyState));
    this.google = googleAuth({ store: credentials.google, clientId: google.clientId, clientSecret: google.clientSecret });
    this.cache = createCache({
      dir: dataDir,
      key: cacheKey,
      accounts: () => this.accounts,
      state: () => this.state.load(),
      pollSeconds: () => this.pollSeconds,
      fresh: cacheFresh
    });
    this.calendar = calendarApi(this);
    Object.assign(this, awaitingApi(this));
  }

  // --- settings -----------------------------------------------------------

  /** Normalized accounts map, read from the caller each time (it may change). */
  get accounts() { return normalizeAccounts(val(this._accounts)); }
  get defaultAccount() { return val(this._defaultAccount) || null; }
  get timeZone() { return val(this._timeZone) || null; }
  get pollSeconds() { return Number(val(this._pollSeconds)) || 30; }
  /** The settings in one object: { accounts, defaultAccount, timeZone, pollSeconds }. */
  get config() { return { accounts: this.accounts, defaultAccount: this.defaultAccount, timeZone: this.timeZone, pollSeconds: this.pollSeconds }; }

  accountNames() { return Object.keys(this.accounts); }
  /** Accounts that hold mail (ews, imap). */
  mailAccountNames() { const a = this.accounts; return Object.keys(a).filter((n) => MAIL_PROVIDERS.includes(a[n].provider)); }

  /** Resolve an account by name; with one account (or a defaultAccount), name may be omitted. */
  account(name) {
    const accounts = this.accounts;
    const names = Object.keys(accounts);
    if (names.length === 0) throw new Error('no accounts configured');
    if (!name) {
      if (names.length === 1) return accounts[names[0]];
      const def = this.defaultAccount;
      if (def && accounts[def]) return accounts[def];
      throw new Error(`several accounts configured (${names.join(', ')}) — name one, or set a default account`);
    }
    const acct = accounts[name];
    if (!acct) throw new Error(`unknown account "${name}" — configured: ${names.join(', ')}`);
    return acct;
  }

  /** What each account offers: [{ name, provider, email, mail, calendar, cached }]. */
  listAccounts() {
    const cached = new Set(this.cache.cachedAccounts());
    return Object.values(this.accounts).map((a) => ({
      name: a.name, provider: a.provider, email: a.email || '', mail: hasMail(a), calendar: calendarProvider(a), cached: cached.has(a.name)
    }));
  }

  /** Account names to query: the one given, or every mail account. */
  selectAccounts(account) {
    if (account) return [this.account(account).name];
    return this.mailAccountNames();
  }

  // --- clients ------------------------------------------------------------

  async #password(acct, refresh) {
    const c = await this.credentials.getPassword(acct, { refresh: !!refresh });
    if (!c || typeof c.password !== 'string') throw Object.assign(new Error(`no password for account "${acct.name}"`), { code: 'MAIL_AUTH' });
    return { username: c.username ?? acct.username ?? acct.email ?? '', domain: c.domain ?? acct.domain ?? '', password: c.password };
  }

  /** An AccountClient for one account (ids in and out carry "<account>:"). Close it when done. */
  async client(name, { refresh = false } = {}) {
    const acct = this.account(name);
    const creds = hasMail(acct) || acct.provider === 'caldav' ? await this.#password(acct, refresh) : null;
    const backend = await makeBackend(acct, creds);
    // the calendar backend is built on first calendar call (lazily): a CalDAV password problem must not stop mail
    return new AccountClient(acct.name, backend, () => makeCalendarBackend(acct, backend, {
      timeZone: this.timeZone,
      getPassword: (a, o) => this.#password(a, o.refresh),
      accessToken: this.google.accessToken,
      refresh
    }));
  }

  /**
   * Run fn(client) for one account with credential refresh: an auth failure
   * is retried once with the same credentials (NTLM 401s are sometimes
   * transient), then once with { refresh: true } from the credentials
   * provider. `account` may be a name or a prefixed id.
   */
  async withClient(account, fn, { onRefresh } = {}) {
    const name = account && splitId(account).account ? splitId(account).account : account;
    const attempt = async (refresh) => {
      const c = await this.client(name, { refresh });
      try { return await fn(c); } finally { try { await c.close(); } catch {} }
    };
    try {
      return await attempt(false);
    } catch (e) {
      if (!isAuthError(e)) throw e;
      try {
        return await attempt(false);
      } catch (e2) {
        if (!isAuthError(e2)) throw e2;
        if (onRefresh) onRefresh(e2);
        return await attempt(true);
      }
    }
  }

  /** MailWatcher's historical signature: withAuthRetry(fn, onRefresh, account). */
  withAuthRetry(fn, onRefresh, account) { return this.withClient(account, fn, { onRefresh: onRefresh || undefined }); }

  /** Push stream for one mail account (EWS streaming notifications or IMAP IDLE). */
  async stream(name, hooks = {}) {
    const acct = this.account(name);
    if (!hasMail(acct)) throw new Error(`account "${acct.name}" holds no mail`);
    const creds = await this.#password(acct, false);
    return makeStream(acct, creds, { ...hooks, refreshCreds: () => this.#password(acct, true) });
  }

  // --- mail ---------------------------------------------------------------

  /**
   * Listing across accounts (all, or the one named), merged newest first and
   * trimmed to opts.limit. An account that fails is reported via onError and
   * skipped (without onError, the error is thrown).
   *
   * Served from the encrypted cache when every requested account is cached,
   * a watcher is alive, and the folder is the inbox; opts.live forces the
   * servers. Cached items carry `cached: true`.
   */
  async find(account, opts = {}, onError) {
    const names = this.selectAccounts(account);
    if (this.cache.cacheUsable(names, opts)) {
      try {
        if (opts.fromMe && names.length === 1) {
          const me = await this.withClient(names[0], (c) => c.selfEmail());
          return this.cache.findCached(names, { ...opts, fromMe: me });
        }
        if (!opts.fromMe) return this.cache.findCached(names, opts);
      } catch (e) {
        if (onError) onError('cache', e);
      }
    }
    const lists = await Promise.all(
      names.map((n) =>
        this.withClient(n, (c) => c.findInbox(opts)).catch((e) => {
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
   * One full message: cached body when stored, else live (written back to
   * the cache). opts.bodyType 'Text' (default) or 'HTML'; opts.live forces the server.
   */
  async read(id, opts = {}) {
    const { account } = splitId(id);
    const cached = () => account && this.cache.cachedAccounts().includes(account);
    // a stored body only goes stale when a draft is edited (the write paths drop it), so no liveness check here
    if (!opts.live && cached()) {
      try {
        const hit = this.cache.getCached(id, opts);
        if (hit) return hit;
      } catch {}
    }
    const msg = await this.withClient(id, (c) => c.getMessage(id, opts));
    if (cached()) {
      try {
        const html = msg.bodyType === 'HTML' ? msg.body : null;
        // keep a text version too so the mail is searchable (FTS) and readable as text
        const text = msg.bodyType === 'Text' ? msg.body : htmlToText(msg.body);
        this.cache.upsertBody(account, msg, { text, html });
      } catch {}
    }
    return msg;
  }

  /** One attachment's bytes: { name, contentType, content: Buffer }. */
  getAttachment(messageId, attachmentId) {
    return this.withClient(messageId, (c) => c.getAttachment(attachmentId, messageId));
  }

  /**
   * Save attachments of a message to a directory. `only` filters by
   * attachment id or file name. Returns [{ name, path, size, contentType }].
   * Existing files are never overwritten (a " (2)" suffix is added).
   */
  async saveAttachments(id, dir, { only } = {}) {
    const msg = await this.read(id, { bodyType: 'Text' });
    let list = (msg.attachments || []).filter((a) => !a.inline || only);
    if (only) list = list.filter((a) => a.id === only || a.name === only);
    if (list.length === 0) throw new Error(only ? `no attachment "${only}" on this message` : 'this message has no attachments');
    fs.mkdirSync(dir, { recursive: true });
    const saved = [];
    for (const a of list) {
      const file = await this.getAttachment(id, a.id);
      const target = uniquePath(dir, safeName(file.name || a.name));
      fs.writeFileSync(target, file.content, { mode: 0o600 });
      saved.push({ name: path.basename(target), path: target, size: file.content.length, contentType: file.contentType });
    }
    return saved;
  }

  /** Reply (or reply-all) draft, sent when `send` is true → { sent, draftId, changeKey }. */
  reply(id, body, { all = false, send = false, changeKey = '', bodyType = 'Text' } = {}) {
    return this.withClient(id, async (c) => {
      const d = all ? await c.draftReplyAll(id, changeKey, body, { bodyType }) : await c.draftReply(id, changeKey, body, { bodyType });
      if (!send) return { sent: false, ...d };
      await c.sendItem(d.draftId, d.changeKey);
      return { sent: true, ...d };
    });
  }

  /** New message: a draft, or sent at once with send: true → { sent, draftId, changeKey }. */
  compose({ account, ...o }) { return this.withClient(this.account(account).name, (c) => c.createMessage(o)); }

  // an edited draft's cached copy is stale: drop it so the next read is live
  updateDraft(o) { return this.withClient(o.id, (c) => c.updateDraft(o)).then((r) => { this.noteRemoved(o.id); return r; }); }
  addAttachment(id, changeKey, att) { return this.withClient(id, (c) => c.addAttachment(id, changeKey, att)).then((r) => { this.noteRemoved(id); return r; }); }
  /** Move to trash (a draft or a message). */
  deleteItem(id, changeKey) { return this.withClient(id, (c) => c.deleteItem(id, changeKey)).then((r) => { this.noteRemoved(id); return r; }); }
  markRead(id, isRead = true, changeKey) { return this.withClient(id, (c) => c.markRead(id, changeKey, isRead)).then((r) => { this.noteRead(id, isRead); return r; }); }
  send(id, changeKey) { return this.withClient(id, (c) => c.sendItem(id, changeKey)); }

  /** Keep the cache honest after writes made through a client directly. */
  noteRead(id, isRead = true) { try { this.cache.setRead(id, isRead); } catch {} }
  noteRemoved(id) { try { this.cache.removeMessage(id); } catch {} }

  // --- watching -----------------------------------------------------------

  /** A MailWatch over the mail accounts (see watch.js). */
  async watch(opts = {}) {
    const { MailWatch } = await import('./watch.js');
    return new MailWatch(this, opts);
  }

  /** A calendar watcher for one account (see calendar-watch.js). */
  async watchCalendar(account, opts = {}) {
    const { watchCalendar } = await import('./calendar-watch.js');
    return watchCalendar(this, { ...opts, account });
  }

  close() { this.cache.closeCache(); }
}

function safeName(name) {
  const n = String(name || 'attachment').replace(/[\/\\:\0]/g, '_').replace(/^\.+/, '_').slice(0, 200);
  return n || 'attachment';
}

function uniquePath(dir, name) {
  let target = path.join(dir, name);
  if (!fs.existsSync(target)) return target;
  const ext = path.extname(name);
  const base = name.slice(0, name.length - ext.length);
  for (let i = 2; ; i++) {
    target = path.join(dir, `${base} (${i})${ext}`);
    if (!fs.existsSync(target)) return target;
  }
}

const ENTITIES = { nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'" };

export function htmlToText(html) {
  return String(html || '')
    .replace(/<style[\s\S]*?<\/style>|<script[\s\S]*?<\/script>|<head[\s\S]*?<\/head>/gi, '')
    .replace(/<br\s*\/?>|<\/p>|<\/div>|<\/tr>|<\/li>|<\/h[1-6]>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&(nbsp|amp|lt|gt|quot|#39);/g, (m, n) => ENTITIES[n]) // one pass, so &amp;lt; stays &lt;
    .replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n')
    .trim();
}
