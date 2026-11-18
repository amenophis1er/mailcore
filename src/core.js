// The mailcore instance: the caller's accounts, credentials and data
// directory in, mail and calendar operations out. Nothing here reads a
// config file, a keychain or the environment — all of it is handed in.

import fs from 'node:fs';
import { AsyncLocalStorage } from 'node:async_hooks';
import path from 'node:path';
import { normalizeAccounts, calendarProvider, hasMail, MAIL_PROVIDERS } from './accounts.js';
import { AccountClient, splitId, isAuthError, makeBackend, makeCalendarBackend, makeStream } from './client.js';
import { createCache } from './cache.js';
import { googleAuth } from './google-auth.js';
import { googleContacts } from './google-contacts.js';
import { calendarApi } from './calendar.js';
import { awaitingApi } from './awaiting.js';
import { jsonFileStore, memoryStore } from './store.js';
import { htmlToText } from './text.js';

export { htmlToText };

const val = (x) => (typeof x === 'function' ? x() : x);
const emptyState = () => ({ seenIds: [], baselined: false });

/** How many connections to one IMAP account this process holds at a time (see Mailcore.withClient). */
const MAX_AT_ONCE = 4;
/** How long a use waits for its turn before it is refused as busy (MAIL_BUSY). */
const TURN_WAIT_MS = 20_000;
/** A connection the server refused for want of room: asked again after these waits (ms), then given up. */
const BUSY_WAITS = [1000, 2500, 5000];
/** A kept IMAP client (see Mailcore.keepClients): unused for longer than this, it is asked whether it still answers before it is used. */
const PROBE_MS = 15_000;
/** How long that answer is waited for. */
const PROBE_WAIT_MS = 3_000;
/** And it is not kept longer than this after it signed in, however much it is used (a password changed since is then asked for again). */
const LIFE_MS = 15 * 60_000;

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
   * @param {object|Function} [o.google]  { clientId, clientSecret, signInHint? } (or a function returning it, asked each time) — the OAuth client for Google calendars; signInHint(account): what a Google auth error tells the user to do
   * @param {Function} [o.cacheFresh]  (accounts) => boolean, replaces the "watcher polled recently" test
   * @param {Function} [o.log]
   */
  constructor({ accounts, defaultAccount, credentials, dataDir = null, cacheKey = null, state, timeZone = null, pollSeconds = 30, google = {}, cacheFresh, log, turnWaitMs = TURN_WAIT_MS } = {}) {
    this._turnWait = turnWaitMs; // (how long a use waits its turn at an IMAP account before it is refused as busy: a test's is short)
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
    const g = () => val(google) || {};
    this.google = googleAuth({ store: credentials.google, client: g, signInHint: (account) => (typeof g().signInHint === 'function' ? g().signInHint(account) : null) });
    // a Google account's contacts (People API), over the same tokens
    this.google.contacts = (account, opts = {}) => googleContacts(account, { accessToken: this.google.accessToken, signInHint: this.google.signInHint, ...opts });
    this.cache = createCache({
      dir: dataDir,
      key: cacheKey,
      accounts: () => this.accounts,
      state: () => this.state.load() ?? {},
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
    return splitDomain({ username: c.username ?? acct.username ?? acct.email ?? '', domain: c.domain ?? acct.domain ?? '', password: c.password });
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
      signInHint: this.google.signInHint,
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
      // One IMAP account takes only so many connections at once (Gmail: fifteen, every app and device counted): a
      // process holds a few at a time, and what else it has to ask waits its turn.
      const turn = await this.#turn(name);
      const release = turn.release;
      // (what fn asks of the same account meanwhile is part of this use: it has its turn)
      const inside = (work) => (turn.held ? this.#inUse.run([...(this.#inUse.getStore() ?? []), turn.held], work) : work());
      try {
        for (let tries = 0; ; tries++) {
          // (a client kept from a use a moment ago, where clients are kept: its connection is there already)
          const key = this.#keptKey(name);
          const gen = key ? this.#keptGen(key) : '';
          let lease = !refresh && key ? await this.#takeKept(key) : null;
          if (lease) { try { lease.c.again?.(); } catch { /* as it is */ } }
          const c = lease?.c ?? await this.client(name, { refresh });
          lease ??= { c, born: Date.now() };
          let done = false;
          try {
            const out = await inside(() => fn(c));
            done = true;
            return out;
          } catch (e) {
            // the server would take no more connections, and nothing was asked yet: waited for, and asked again from the
            // start (a kept client may have come back meanwhile, or another app let one go)
            if (!(e?.code === 'MAIL_BUSY' && e.unstarted && tries < BUSY_WAITS.length)) throw e;
            await new Promise((r) => setTimeout(r, BUSY_WAITS[tries]));
          } finally {
            // Kept for the next use only after one that went well (one that failed may have left its connection anywhere),
            // and only as the account still is: not when it was let go of meanwhile (signed in again, its clients closed),
            // nor when its settings changed during the use.
            // Nor one made with the password asked for anew (what it builds later would ask for it anew again).
            const still = done && !refresh && key && this.#keptKey(name) === key && this.#keptGen(key) === gen;
            if (!(still && this.#keep(key, lease))) { try { await c.close(); } catch {} }
          }
        }
      } finally {
        release();
      }
    };
    try {
      return await attempt(false);
    } catch (e) {
      if (!isAuthError(e)) throw e;
      await this.closeClients(this.#nameOf(name)); // (signed in with what is refused now)
      try {
        return await attempt(false);
      } catch (e2) {
        if (!isAuthError(e2)) throw e2;
        if (onRefresh) onRefresh(e2);
        return await attempt(true);
      }
    }
  }

  // --- a few at a time ------------------------------------------------------------------

  #turns = new Map(); // account name → { busy, waiting: [fn] }
  #inUse = new AsyncLocalStorage(); // the turns the work under way has (a use inside a use): [{ name, live }], live until given back

  /**
   * A turn at an IMAP account's connections (MAX_AT_ONCE of them at a time in this process); settles with
   * { release, held }: what gives it back, and the turn itself (null: none was needed). A use made inside a use of
   * the same account, while that one lasts, has its turn already (it would wait for itself). A turn not had within TURN_WAIT_MS is
   * not taken: the use is refused as busy (MAIL_BUSY: said, or waited for and asked again by whoever asked), so
   * that never more than MAX_AT_ONCE are at an account at once, however many wait.
   */
  async #turn(name) {
    let acct = null;
    try { acct = this.account(name); } catch { /* said where the client is made */ }
    // (a turn that is still had: something started inside a use and left running after it has none, and waits like any other)
    if (acct?.provider !== 'imap' || this.#inUse.getStore()?.some((t) => t.name === acct.name && t.live)) return { release: () => {}, held: null };
    const t = this.#turns.get(acct.name) ?? { busy: 0, waiting: [] };
    this.#turns.set(acct.name, t);
    if (t.busy >= MAX_AT_ONCE) {
      // (handed over by the one that ends: its place is this one's, never free in between)
      await new Promise((go, no) => {
        const timer = setTimeout(() => {
          const at = t.waiting.indexOf(mine);
          if (at >= 0) t.waiting.splice(at, 1);
          no(Object.assign(new Error(`${acct.name}: too much is being asked of this mail account at once; try again in a moment`), { code: 'MAIL_BUSY' }));
        }, this._turnWait);
        timer.unref?.();
        const mine = () => { clearTimeout(timer); go(); };
        t.waiting.push(mine);
      });
    } else t.busy++;
    const held = { name: acct.name, live: true };
    return {
      held,
      release: () => {
        if (!held.live) return;
        held.live = false;
        const next = t.waiting.shift();
        if (next) next(); else t.busy--;
      }
    };
  }

  // --- clients kept between uses ----------------------------------------------------
  //
  // Signing in to an IMAP server takes a second or two (Gmail), and withClient signs in for each use. A process that
  // stays up (a server answering a person's clicks) may keep the clients it used a moment ago instead: keepClients().
  // IMAP only (an Exchange client holds no connection). A client is kept after a use that went well, for `ms`
  // without another use and LIFE_MS at most since it signed in, `max` of them per account; taken again by the next
  // use (one at a time: concurrent uses each have their own, made as before when none is kept). One unused for
  // more than PROBE_MS is asked first whether it still answers (a connection the network dropped looks alive, and
  // would hold the next use up for minutes): not answering within PROBE_WAIT_MS, it is let go and another is made.
  // They are filed under the account as it is set up: changed in any way, the old ones are not taken, and closed.
  // Not for a process that should end when its work is done: kept connections hold it up until closeClients().

  #keptFor = 0;
  #keptMax = 0;
  #kept = new Map(); // key (the account as it is set up now) → [{ c, born, at, timer }]
  #gens = new Map(); // account name → how many times its clients were let go of
  #genAll = 0; // and how many times everyone's were
  #probeMs = PROBE_MS;

  /** Keep IMAP clients between uses: for `ms` unused (default two minutes), at most `max` per account (default 3). */
  keepClients({ ms = 120_000, max = 3, probeMs = PROBE_MS } = {}) {
    this.#probeMs = Math.max(0, Number(probeMs) || 0);
    this.#keptFor = Math.max(0, Number(ms) || 0);
    this.#keptMax = Math.max(0, Number(max) || 0);
    if (!this.#keptFor || !this.#keptMax) void this.closeClients();
  }

  /** Close the clients kept (all, or one account's), and those in use as they come back: before the process ends, or when an account's sign-in or settings change. */
  async closeClients(name) {
    const closing = [];
    if (name) this.#gens.set(name, (this.#gens.get(name) || 0) + 1); else this.#genAll++;
    for (const [key, list] of this.#kept) {
      if (name && key.split('\n')[0] !== name) continue;
      this.#kept.delete(key);
      for (const e of list) { clearTimeout(e.timer); closing.push(Promise.resolve().then(() => e.c.close()).catch(() => {})); }
    }
    await Promise.all(closing);
  }

  #nameOf(name) { try { return this.account(name).name; } catch { return name; } }
  #keptGen(key) { return `${this.#genAll}.${this.#gens.get(key.split('\n')[0]) || 0}`; }

  /** What an account's kept clients are filed under: its name and all of how it is set up now. null: none are kept for it. */
  #keptKey(name) {
    if (!this.#keptFor || !this.#keptMax) return null;
    let acct;
    try { acct = this.account(name); } catch { return null; }
    if (acct?.provider !== 'imap') return null;
    let tz = '';
    try { tz = String(this.timeZone ?? ''); } catch { /* none */ }
    return `${acct.name}\n${JSON.stringify(acct)}\n${tz}`;
  }

  /** A kept client for this key, known to answer; null when none is kept (or none of them answers any more). */
  async #takeKept(key) {
    for (;;) {
      const e = this.#kept.get(key)?.pop();
      if (!e) return null;
      clearTimeout(e.timer);
      if (Date.now() - e.at <= this.#probeMs) return e;
      let alive = false;
      try { alive = typeof e.c.ping === 'function' ? await e.c.ping(PROBE_WAIT_MS) : true; } catch { alive = false; }
      if (alive) return e;
      Promise.resolve().then(() => e.c.close()).catch(() => {});
      // (one does not answer: the network changed, and the others kept beside it are no better. All let go, not asked one by one)
      for (const other of this.#kept.get(key) ?? []) { clearTimeout(other.timer); Promise.resolve().then(() => other.c.close()).catch(() => {}); }
      this.#kept.delete(key);
      return null;
    }
  }

  #keep(key, lease) {
    if (Date.now() - lease.born > LIFE_MS) return false;
    const list = this.#kept.get(key) ?? [];
    if (list.length >= this.#keptMax) return false;
    try { lease.c.rest?.(); } catch { /* kept as it is */ }
    const e = { c: lease.c, born: lease.born, at: Date.now(), timer: null };
    e.timer = setTimeout(() => {
      const now = this.#kept.get(key);
      const at = now ? now.indexOf(e) : -1;
      if (at < 0) return;
      now.splice(at, 1);
      if (!now.length) this.#kept.delete(key);
      Promise.resolve().then(() => e.c.close()).catch(() => {});
    }, this.#keptFor);
    e.timer.unref?.();
    list.push(e);
    this.#kept.set(key, list);
    return true;
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
    // words typed in a search box: each must be there, anywhere (a "quoted phrase" stays one)
    if (typeof opts.text === 'string') opts = { ...opts, text: searchTerms(opts.text) };
    const names = this.selectAccounts(account);
    // `quiet`: what the cache found stands even when a server cannot be asked
    const ask = (n, o, quiet = false) => this.withClient(n, (c) => c.findInbox(o)).catch((e) => {
      if (onError) onError(n, e);
      else if (!quiet) throw e;
      return [];
    });
    const limit = opts.limit;
    const newest = (lists, cap = limit) => {
      const seen = new Set();
      const items = lists.flat().filter((i) => !seen.has(i.id) && seen.add(i.id)).sort((a, b) => new Date(b.received) - new Date(a.received));
      return cap ? items.slice(0, cap) : items;
    };
    if (this.cache.cacheUsable(names, opts)) {
      try {
        let hits = null;
        if (opts.fromMe && names.length === 1) {
          const me = await this.withClient(names[0], (c) => c.selfEmail());
          hits = this.cache.findCached(names, { ...opts, fromMe: me });
        } else if (!opts.fromMe) hits = this.cache.findCached(names, opts);
        if (hits) {
          // A search the cache cannot fill a page of: it holds some weeks only, and not every mail of them (headers
          // first, not each body). The servers are asked too, over the same span, and what both found is merged.
          // (A page by offset stays the cache's: two sources do not share one.)
          const page = opts.limit || 25;
          if (!opts.text?.length || opts.offset || hits.length >= page) return hits;
          // a server slow to answer does not hold back what the cache found: past a few seconds it counts as none
          const live = await Promise.all(names.map((n) => within(SEARCH_WAIT_MS, ask(n, opts, true), [])));
          return newest([hits, ...live], page);
        }
      } catch (e) {
        if (onError) onError('cache', e);
      }
    }
    return newest(await Promise.all(names.map((n) => ask(n, opts))));
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
    let msg;
    try {
      msg = await this.withClient(id, (c) => c.getMessage(id, opts));
    } catch (e) {
      // the server out of reach: a copy stored before Reply-To was kept is still the mail
      let old = null;
      if (!opts.live && cached()) try { old = this.cache.getCached(id, { ...opts, stale: true }); } catch {}
      if (old) return old;
      throw e;
    }
    if (cached()) {
      try {
        // asked for HTML and given text: this mail has no HTML ('' says so). Asked for text: whether it has any is not known (null)
        const html = msg.bodyType === 'HTML' ? msg.body : opts.bodyType === 'HTML' ? '' : null;
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

  /** Forward draft of a message (never sent here): the server adds the original and its attachments → { draftId, changeKey }. */
  forward(id, body, { to = [], cc = [], bcc = [], changeKey = '', bodyType = 'Text' } = {}) {
    return this.withClient(id, (c) => c.draftForward(id, changeKey, body, { bodyType, to, cc, bcc }));
  }

  /** New message: a draft, or sent at once with send: true → { sent, draftId, changeKey }. */
  compose({ account, ...o }) { return this.withClient(this.account(account).name, (c) => c.createMessage(o)); }

  // an edited draft's cached copy is stale: drop it so the next read is live
  updateDraft(o) { return this.withClient(o.id, (c) => c.updateDraft(o)).then((r) => { this.noteRemoved(o.id); return r; }); }
  addAttachment(id, changeKey, att) { return this.withClient(id, (c) => c.addAttachment(id, changeKey, att)).then((r) => { this.noteRemoved(id); return r; }); }
  removeAttachment(id, changeKey, attachmentId) { return this.withClient(id, (c) => c.removeAttachment(id, changeKey, attachmentId)).then((r) => { this.noteRemoved(id); return r; }); }
  /** Move to trash (a draft or a message). */
  deleteItem(id, changeKey) { return this.withClient(id, (c) => c.deleteItem(id, changeKey)).then((r) => { this.noteRemoved(id); return r; }); }
  markRead(id, isRead = true, changeKey) { return this.withClient(id, (c) => c.markRead(id, changeKey, isRead)).then((r) => { this.noteRead(id, isRead); return r; }); }
  /** Flag for follow-up (Exchange), or star (IMAP \Flagged); flagged: false clears it. */
  setFlag(id, flagged = true, changeKey) { return this.withClient(id, (c) => c.setFlag(id, changeKey, flagged)).then((r) => { this.noteFlagged(id, flagged); return r; }); }
  send(id, changeKey) { return this.withClient(id, (c) => c.sendItem(id, changeKey)); }

  /**
   * Move messages (of one account or several) to a folder (inbox, archive,
   * trash, junk, sent, drafts). A moved message has a new id: the answer maps
   * each old id (always "<account>:…", an unprefixed one being the default
   * account's) to its new one, or to null for a message that was no longer
   * there. Ids missing from the map were not moved (refused one by one, or
   * their account failed: onError is told). Without onError, a call that
   * moved nothing throws (the first error, else "none of these messages could
   * be moved"). Moved and gone ids leave the cache; mail moved back to the
   * inbox of a cached account is put in it at once.
   */
  async moveItems(ids, folder, { onError } = {}) {
    // unprefixed ids belong to the default (or only) account, as everywhere else
    const byAccount = new Map();
    for (const id of ids) {
      const name = splitId(id).account || this.account().name;
      byAccount.set(name, [...(byAccount.get(name) || []), id]);
    }
    const out = new Map();
    let firstError = null;
    for (const [name, list] of byAccount) {
      try {
        const m = await this.withClient(name, async (c) => {
          const done = await c.moveItems(list, folder);
          // back in the inbox (an archive or a delete taken back): a cached listing would only learn of it at a
          // watcher's next poll. Told now, so the mail is there at once.
          if (String(folder).toLowerCase() === 'inbox' && this.cache.cachedAccounts().includes(name)) {
            try {
              const back = (await Promise.all([...done.values()].filter(Boolean).map((id) => c.getMessage(id, { bodyType: 'Text' }).catch(() => null)))).filter(Boolean);
              if (back.length) this.cache.upsertItems(name, back);
            } catch { /* it shows up with the next poll instead */ }
          }
          return done;
        });
        for (const [from, to] of m) { out.set(from, to); if (to !== from) this.noteRemoved(from); }
      } catch (e) {
        if (onError) onError(name, e);
        else firstError ||= e;
      }
    }
    if (!onError && ids.length && ![...out.values()].some((v) => v != null)) throw firstError || new Error('none of these messages could be moved');
    return out;
  }

  /** People of the cached mail whose name or address contains `q` (see cache.people); [] without a cache. */
  people(q, opts) { try { return this.cache.people(q, opts); } catch { return []; } }

  /** Keep the cache honest after writes made through a client directly. */
  noteRead(id, isRead = true) { try { this.cache.setRead(id, isRead); } catch {} }
  noteFlagged(id, isFlagged = true) { try { this.cache.setFlagged(id, isFlagged); } catch {} }
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

/**
 * "DOMAIN\user" carries its own domain: split it, or NTLM gets the domain twice
 * (user "DOMAIN\user" in domain "DOMAIN") and Exchange answers 401.
 */
const SEARCH_WAIT_MS = 4000;

/** What `promise` gives within `ms`, else `fallback`. */
function within(ms, promise, fallback) {
  let timer;
  return Promise.race([promise, new Promise((resolve) => { timer = setTimeout(() => resolve(fallback), ms); })]).finally(() => clearTimeout(timer));
}

/** The terms of a search: its words, a "quoted phrase" as one; none when there is no letter or digit in it. */
export function searchTerms(text) {
  const terms = [];
  for (const m of String(text || '').matchAll(/"([^"]*)"|(\S+)/g)) {
    const t = (m[1] ?? m[2]).trim();
    // "&", "-", an emoji alone: no word to look for (and an index of words cannot find them)
    if (/[\p{L}\p{N}]/u.test(t)) terms.push(t);
  }
  return terms.length ? terms : undefined;
}

function splitDomain(creds) {
  const u = String(creds.username || '');
  if (u.includes('\\')) [creds.domain, creds.username] = u.split('\\');
  return creds;
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
