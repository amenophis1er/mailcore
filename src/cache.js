// Encrypted local mail cache: SQLite (SQLCipher via better-sqlite3-multiple-
// ciphers) at <dataDir>/cache.db. The key is the caller's: a string, or a
// function ({ create }) → string | null that may create and store one the
// first time (create: true) — mailcore never stores it. A watcher writes —
// headers for every poll, bodies for new mail — and readers serve from it
// first while the watcher is alive, falling back to the live server.
//
// Only the inbox is cached, for the last `cache.days` days per account.
// Attachments are never stored (only their names/sizes). Of sent mail only
// the thread identity is kept (table `sent`), so a listing can say how many
// messages a thread holds.

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { MAIL_PROVIDERS } from './accounts.js';
import { previewText } from './text.js';

/**
 * createCache({ dir, key, accounts, state, pollSeconds, fresh })
 *   dir       directory of cache.db (null: no cache)
 *   key       string | ({ create }) => string | null
 *   accounts  () => normalized accounts map
 *   state     () => watcher state ({ lastPollAt })
 *   fresh     optional (accounts) => boolean, replaces the lastPollAt test
 */
export function createCache({ dir, key, accounts = () => ({}), state = () => ({}), pollSeconds = () => 30, fresh } = {}) {
  const CACHE_PATH = dir ? path.join(dir, 'cache.db') : null;
  let db = null;

  /** Accounts with caching enabled (the default). */
  function cachedAccounts(config = { accounts: accounts() }) {
    if (!CACHE_PATH || !key) return [];
    return Object.values(config.accounts).filter((a) => MAIL_PROVIDERS.includes(a.provider) && a.cache?.enabled !== false).map((a) => a.name);
  }

  function getKey(create) {
    if (!key) return null;
    if (typeof key === 'string') return key;
    return key({ create }) || null;
  }

  function cacheKeyExists() {
    try { return getKey(false) !== null; } catch { return false; }
  }

  /**
   * Open the cache. create=false (readers) returns null when there is no
   * database or key yet, so a reader never creates an empty cache or a key.
   */
  function openCache({ create = false } = {}) {
    if (db) return db;
    if (!CACHE_PATH) return null;
    if (!create && !fs.existsSync(CACHE_PATH)) return null;
    const k = getKey(create);
    if (!k) return null;
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const require = createRequire(import.meta.url);
    const Database = require('better-sqlite3-multiple-ciphers');
    const d = new Database(CACHE_PATH);
    d.pragma("cipher='sqlcipher'");
    d.pragma(`key='${String(k).replace(/'/g, "''")}'`);
    try {
      d.pragma('busy_timeout = 5000');
      d.pragma('journal_mode = WAL');
      migrate(d);
    } catch (e) {
      d.close();
      if (e.code === 'SQLITE_NOTADB') throw Object.assign(new Error(`cache.db cannot be decrypted with the key given — delete ${CACHE_PATH} to rebuild it`), { code: 'CACHE_KEY' });
      throw e;
    }
    try { fs.chmodSync(CACHE_PATH, 0o600); } catch {}
    db = d;
    return db;
  }

  function closeCache() {
    if (db) { try { db.close(); } catch {} db = null; }
  }

  function migrate(d) {
    d.exec(`
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        account TEXT NOT NULL,
        change_key TEXT,
        subject TEXT, from_name TEXT, from_email TEXT, display_to TEXT,
        is_read INTEGER NOT NULL DEFAULT 0,
        has_attachments INTEGER NOT NULL DEFAULT 0,
        received TEXT NOT NULL,
        to_json TEXT, cc_json TEXT, attachments_json TEXT,
        body_text TEXT, body_html TEXT,
        seen_at INTEGER NOT NULL,
        body_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS messages_account_received ON messages(account, received DESC);
      CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
        subject, from_name, from_email, body_text,
        content='messages', content_rowid='rowid', tokenize='unicode61'
      );
      CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
        INSERT INTO messages_fts(rowid, subject, from_name, from_email, body_text)
        VALUES (new.rowid, new.subject, new.from_name, new.from_email, new.body_text);
      END;
      CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages BEGIN
        INSERT INTO messages_fts(messages_fts, rowid, subject, from_name, from_email, body_text)
        VALUES ('delete', old.rowid, old.subject, old.from_name, old.from_email, old.body_text);
      END;
      CREATE TRIGGER IF NOT EXISTS messages_au AFTER UPDATE ON messages BEGIN
        INSERT INTO messages_fts(messages_fts, rowid, subject, from_name, from_email, body_text)
        VALUES ('delete', old.rowid, old.subject, old.from_name, old.from_email, old.body_text);
        INSERT INTO messages_fts(rowid, subject, from_name, from_email, body_text)
        VALUES (new.rowid, new.subject, new.from_name, new.from_email, new.body_text);
      END;
    `);
    // columns added after 1.0: thread identity, the bulk flag, the follow-up flag
    const cols = new Set(d.prepare('PRAGMA table_info(messages)').all().map((c) => c.name));
    for (const [name, type] of [['conversation_id', 'TEXT'], ['message_id', 'TEXT'], ['in_reply_to', 'TEXT'], ['is_bulk', 'INTEGER'], ['is_flagged', 'INTEGER'], ['reply_to_json', 'TEXT']]) {
      // a watcher and other readers can all open an older database in the same instant: the first one adds the column
      if (!cols.has(name)) try { d.exec(`ALTER TABLE messages ADD COLUMN ${name} ${type}`); } catch (e) { if (!/duplicate column/i.test(e.message)) throw e; }
    }
    d.exec('CREATE INDEX IF NOT EXISTS messages_conversation ON messages(account, conversation_id)');
    // sent mail: which thread each message belongs to, nothing else (no row in `messages`: every row there is an inbox row)
    d.exec(`
      CREATE TABLE IF NOT EXISTS sent (
        id TEXT PRIMARY KEY,
        account TEXT NOT NULL,
        conversation_id TEXT NOT NULL,
        message_id TEXT,
        received TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS sent_conversation ON sent(account, conversation_id);
    `);
  }

  // --- writes (daemon) ----------------------------------------------------------

  /**
   * Insert or refresh header rows from a listing. Returns ids not seen before.
   * `report`, when given, is told how many rows already held changed their read
   * or flag state (`report.changed`): what a list on screen has to hear about.
   */
  function upsertItems(account, items, report = null) {
    const d = openCache({ create: true });
    const now = Date.now();
    const sel = d.prepare('SELECT is_read, is_flagged FROM messages WHERE id = ?');
    let changed = 0;
    const ins = d.prepare(`INSERT INTO messages (id, account, change_key, subject, from_name, from_email, display_to, is_read, has_attachments, received, seen_at, conversation_id, message_id, in_reply_to, is_flagged)
      VALUES (@id, @account, @changeKey, @subject, @fromName, @fromEmail, @displayTo, @isRead, @hasAttachments, @received, @seenAt, @conversationId, @messageId, @inReplyTo, @isFlagged)`);
    // a listing that does not say whether a message is flagged leaves what is known
    const upd = d.prepare(`UPDATE messages SET change_key = @changeKey, is_read = @isRead, is_flagged = COALESCE(@isFlagged, is_flagged), has_attachments = @hasAttachments, seen_at = @seenAt,
      conversation_id = COALESCE(NULLIF(@conversationId, ''), conversation_id), message_id = COALESCE(NULLIF(@messageId, ''), message_id), in_reply_to = COALESCE(NULLIF(@inReplyTo, ''), in_reply_to) WHERE id = @id`);
    const fresh = [];
    d.transaction(() => {
      for (const i of items) {
        if (!i.id) continue;
        const row = {
          id: i.id, account, changeKey: i.changeKey || '', subject: i.subject || '', fromName: i.fromName || '', fromEmail: i.fromEmail || '',
          displayTo: i.displayTo || '', isRead: i.isRead ? 1 : 0, hasAttachments: i.hasAttachments ? 1 : 0,
          received: i.received || new Date(0).toISOString(), seenAt: now,
          conversationId: i.conversationId || '', messageId: i.messageId || '', inReplyTo: i.inReplyTo || '',
          isFlagged: i.isFlagged == null ? null : i.isFlagged ? 1 : 0
        };
        const held = sel.get(i.id);
        if (held) {
          if (held.is_read !== row.isRead || (row.isFlagged != null && (held.is_flagged ?? 0) !== row.isFlagged)) changed++;
          upd.run(row);
        } else { ins.run(row); fresh.push(i.id); }
      }
      d.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run('synced:' + account, String(now));
    }).immediate(); // reads first: as a deferred transaction it could not wait for another process's write
    if (report) report.changed = changed;
    return fresh;
  }

  /** Delete the rows of `account` received since `sinceIso` that `items` (a listing of the inbox over that span) does not hold. Returns how many. */
  function dropUnlisted(account, items, sinceIso) {
    const d = openCache();
    if (!d) return 0;
    const keep = new Set(items.map((i) => i.id));
    const rows = d.prepare('SELECT id FROM messages WHERE account = ? AND received >= ?').all(account, new Date(sinceIso).toISOString());
    const del = d.prepare('DELETE FROM messages WHERE id = ?');
    let removed = 0;
    d.transaction(() => {
      for (const r of rows) if (!keep.has(r.id)) { del.run(r.id); removed++; }
    }).immediate();
    return removed;
  }

  /**
   * Make the cached inbox of `account` from `sinceIso` on match `items`, the
   * server's own listing of that span: refresh what is there (read state,
   * change keys), add what is missing, and drop what is no longer in the inbox
   * (moved, archived or deleted in another client). Returns { added, removed }.
   */
  function reconcile(account, items, sinceIso) {
    const added = upsertItems(account, items).length;
    const d = openCache();
    if (!d) return { added, removed: 0 };
    const keep = new Set(items.map((i) => i.id));
    const rows = d.prepare('SELECT id FROM messages WHERE account = ? AND received >= ?').all(account, new Date(sinceIso).toISOString());
    const del = d.prepare('DELETE FROM messages WHERE id = ?');
    let removed = 0;
    d.transaction(() => {
      for (const r of rows) if (!keep.has(r.id)) { del.run(r.id); removed++; }
    })();
    return { added, removed };
  }

  /**
   * Note sent messages and the thread each belongs to (those without a thread
   * id are skipped). With `sinceIso`, `items` is the server's whole listing of
   * the Sent folder from then on, and rows of that span that are not in it are
   * dropped. Returns { added, removed }.
   */
  function noteSent(account, items, sinceIso) {
    const d = openCache({ create: true });
    const has = d.prepare('SELECT 1 FROM sent WHERE id = ?');
    const put = d.prepare(`INSERT INTO sent (id, account, conversation_id, message_id, received) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET conversation_id = excluded.conversation_id, message_id = excluded.message_id, received = excluded.received`);
    let added = 0;
    let removed = 0;
    d.transaction(() => {
      for (const i of items) {
        if (!i.id || !i.conversationId) continue;
        if (!has.get(i.id)) added++;
        put.run(i.id, account, i.conversationId, i.messageId || '', i.received || new Date(0).toISOString());
      }
      if (sinceIso) {
        const keep = new Set(items.map((i) => i.id));
        const del = d.prepare('DELETE FROM sent WHERE id = ?');
        for (const row of d.prepare('SELECT id FROM sent WHERE account = ? AND received >= ?').all(account, new Date(sinceIso).toISOString())) {
          if (!keep.has(row.id)) { del.run(row.id); removed++; }
        }
      }
    }).immediate(); // the write lock from the start: a lock taken after the first read cannot wait for another writer
    return { added, removed };
  }

  /**
   * Store a full message (from getMessage). text and html bodies are optional.
   * `html`: the mail's HTML; '' when it has none; null or absent when that is not known (what is stored stays).
   */
  function upsertBody(account, msg, { text, html } = {}) {
    const d = openCache({ create: true });
    const exists = d.prepare('SELECT body_text, body_html FROM messages WHERE id = ?').get(msg.id);
    // Only messages a watcher listed in the inbox have a row. A message read from
    // Sent, Drafts or anywhere else must not get one: every row is an inbox row.
    if (!exists) return;
    d.prepare(`UPDATE messages SET to_json = ?, cc_json = ?, reply_to_json = ?, attachments_json = ?,
        body_text = COALESCE(?, body_text), body_html = COALESCE(?, body_html), body_at = ?,
        is_bulk = ?, conversation_id = COALESCE(NULLIF(?, ''), conversation_id), message_id = COALESCE(NULLIF(?, ''), message_id), in_reply_to = COALESCE(NULLIF(?, ''), in_reply_to) WHERE id = ?`)
      .run(JSON.stringify(msg.to || []), JSON.stringify(msg.cc || []), JSON.stringify(msg.replyTo || []), JSON.stringify(msg.attachments || []),
        text ?? null, html ?? null, Date.now(),
        msg.isBulk == null ? null : msg.isBulk ? 1 : 0, msg.conversationId || '', msg.messageId || '', msg.inReplyTo || '', msg.id);
  }

  function setBulk(id, isBulk) {
    const d = openCache();
    if (!d) return;
    d.prepare('UPDATE messages SET is_bulk = ? WHERE id = ?').run(isBulk ? 1 : 0, id);
  }

  function setRead(id, isRead) {
    const d = openCache();
    if (d) d.prepare('UPDATE messages SET is_read = ? WHERE id = ?').run(isRead ? 1 : 0, id);
  }

  function setFlagged(id, isFlagged) {
    const d = openCache();
    if (d) d.prepare('UPDATE messages SET is_flagged = ? WHERE id = ?').run(isFlagged ? 1 : 0, id);
  }

  /** A note kept beside the mail (where a folder stood when it was last looked at): null when none. */
  function getMeta(name) {
    const d = openCache();
    return d ? d.prepare('SELECT value FROM meta WHERE key = ?').get(name)?.value ?? null : null;
  }

  function setMeta(name, value) {
    const d = openCache({ create: true });
    d.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(name, String(value));
  }

  /** The ids of an account's cached inbox rows, or of the sent messages its threads are counted from. */
  function idsOf(account, table = 'messages') {
    const d = openCache();
    if (!d) return [];
    return d.prepare(`SELECT id FROM ${table === 'sent' ? 'sent' : 'messages'} WHERE account = ?`).all(account).map((r) => r.id);
  }

  /**
   * What a server says changed since the last look, applied in one go: read
   * and flag state of messages (`flags`: [{ id, isRead, isFlagged }]), and
   * messages that are no longer there (`gone`: ids of inbox rows, `goneSent`:
   * of sent ones). Returns how many rows really changed: { read, flagged, gone }.
   */
  function applyChanges({ flags = [], gone = [], goneSent = [] } = {}) {
    const d = openCache({ create: true });
    const read = d.prepare('UPDATE messages SET is_read = ? WHERE id = ? AND is_read != ?');
    const flag = d.prepare('UPDATE messages SET is_flagged = ? WHERE id = ? AND COALESCE(is_flagged, 0) != ?');
    const drop = d.prepare('DELETE FROM messages WHERE id = ?');
    const dropSent = d.prepare('DELETE FROM sent WHERE id = ?');
    const out = { read: 0, flagged: 0, gone: 0 };
    d.transaction(() => {
      for (const f of flags) {
        out.read += read.run(f.isRead ? 1 : 0, f.id, f.isRead ? 1 : 0).changes;
        out.flagged += flag.run(f.isFlagged ? 1 : 0, f.id, f.isFlagged ? 1 : 0).changes;
      }
      for (const id of gone) out.gone += drop.run(id).changes;
      for (const id of goneSent) dropSent.run(id);
    }).immediate();
    return out;
  }

  function removeMessage(id) {
    const d = openCache();
    if (d) d.prepare('DELETE FROM messages WHERE id = ?').run(id);
  }

  /** Where an account's cached inbox begins (it holds the last cache.days days). */
  function windowStart(account) {
    const days = Number(accounts()[account]?.cache?.days || 30);
    return new Date(Date.now() - days * 86400e3);
  }

  /** Drop rows older than each account's cache.days, and rows of accounts no longer cached. */
  function prune(config = { accounts: accounts() }) {
    const d = openCache();
    if (!d) return 0;
    let removed = 0;
    for (const name of Object.keys(config.accounts)) {
      const acct = config.accounts[name];
      const days = Number(acct.cache?.days || 30);
      const cutoff = new Date(Date.now() - days * 86400e3).toISOString();
      removed += d.prepare('DELETE FROM messages WHERE account = ? AND received < ?').run(name, cutoff).changes;
      removed += d.prepare('DELETE FROM sent WHERE account = ? AND received < ?').run(name, cutoff).changes;
    }
    const names = Object.keys(config.accounts);
    for (const table of ['messages', 'sent']) {
      removed += d.prepare(`DELETE FROM ${table} WHERE account NOT IN (${names.map(() => '?').join(',') || "''"})`).run(...names).changes;
    }
    return removed;
  }

  function clearCache() {
    closeCache();
    for (const f of [CACHE_PATH, CACHE_PATH + '-wal', CACHE_PATH + '-shm']) { try { fs.unlinkSync(f); } catch {} }
  }

  // --- reads (CLI / MCP) --------------------------------------------------------

  /**
   * Whether a cached answer is acceptable right now: all requested accounts are
   * cached, the daemon has polled recently (so the cache is not stale), the
   * folder is the inbox, and the caller did not ask for live data.
   */
  function cacheUsable(names, opts = {}) {
    if (opts.live) return false;
    // mail flagged for follow-up is often older than the weeks the cache holds: only the server knows all of it
    if (opts.flaggedOnly) return false;
    if (opts.folder && String(opts.folder).toLowerCase() !== 'inbox') return false;
    if (!CACHE_PATH || !fs.existsSync(CACHE_PATH)) return false;
    const cached = new Set(cachedAccounts());
    if (!names.every((a) => cached.has(a))) return false;
    if (fresh) { if (!fresh(names)) return false; }
    else {
      // the watcher has polled recently, so the cache is not stale
      const st = state() || {};
      const maxAge = Math.max(15, pollSeconds() || 30) * 3 * 1000;
      if (!st.lastPollAt || Date.now() - st.lastPollAt >= maxAge) return false;
    }
    // every requested account must have completed at least one sync
    try { return names.every((a) => lastSync(a) !== null); } catch { return false; }
  }

  function lastSync(account) {
    const d = openCache();
    if (!d) return null;
    const row = d.prepare('SELECT value FROM meta WHERE key = ?').get('synced:' + account);
    return row ? Number(row.value) : null;
  }

  /** Same options as MailClient.findInbox, plus `accounts` (names). */
  function findCached(accounts, opts = {}) {
    const d = openCache();
    if (!d) return [];
    const where = [`m.account IN (${accounts.map(() => '?').join(',')})`];
    const params = [...accounts];
    if (opts.unreadOnly) where.push('m.is_read = 0');
    if (opts.flaggedOnly) where.push('m.is_flagged = 1');
    if (opts.hasAttachments) where.push('m.has_attachments = 1');
    if (opts.sinceIso) { where.push('m.received >= ?'); params.push(new Date(opts.sinceIso).toISOString()); }
    if (opts.untilIso) { where.push('m.received <= ?'); params.push(new Date(opts.untilIso).toISOString()); }
    if (opts.fromMe) { where.push('lower(m.from_email) = ?'); params.push(String(opts.fromMe).toLowerCase()); } // the caller resolves fromMe to the address
    if (opts.toContains) { where.push('(m.display_to LIKE ? OR m.to_json LIKE ? OR m.cc_json LIKE ?)'); params.push(like(opts.toContains), like(opts.toContains), like(opts.toContains)); }
    if (opts.senderContains) { where.push('(m.from_name LIKE ? OR m.from_email LIKE ?)'); params.push(like(opts.senderContains), like(opts.senderContains)); }
    if (opts.subjectContains) { where.push('m.subject LIKE ?'); params.push(like(opts.subjectContains)); }
    const texts = Array.isArray(opts.text) ? opts.text : opts.text ? [opts.text] : [];
    let join = '';
    if (texts.length) {
      join = 'JOIN messages_fts f ON f.rowid = m.rowid';
      where.push('messages_fts MATCH ?');
      // each term a word start: "kete" finds KETEKRE, and an address's parts are words ("landry.ketekre@…")
      params.push(texts.map((t) => '"' + String(t).replace(/"/g, '""') + '"*').join(' AND '));
    }
    params.push(Math.min(opts.limit || 25, 100), Math.max(0, Number(opts.offset) || 0));
    const rows = d.prepare(`SELECT m.* FROM messages m ${join} WHERE ${where.join(' AND ')} ORDER BY m.received DESC LIMIT ? OFFSET ?`).all(...params);
    return rows.map(toItem);
  }

  /**
   * Every cached inbox row of an account since `sinceIso` (newest first, up to
   * `limit`), with recipients, bulk flag and the start of the body when they
   * were stored — the raw material for the awaiting-reply sweep.
   */
  function cachedSince(account, sinceIso, { limit = 2000 } = {}) {
    const d = openCache();
    if (!d) return [];
    const rows = d.prepare('SELECT * FROM messages WHERE account = ? AND received >= ? ORDER BY received DESC LIMIT ?').all(account, new Date(sinceIso).toISOString(), limit);
    return rows.map((r) => ({
      ...toItem(r),
      to: r.to_json ? JSON.parse(r.to_json) : null,
      cc: r.cc_json ? JSON.parse(r.cc_json) : null,
      isBulk: r.is_bulk == null ? null : !!r.is_bulk,
      bodyText: r.body_text,
      hasBody: r.body_at != null
    }));
  }

  /**
   * How many messages each thread holds, as far as the cache knows: its inbox
   * rows plus what was sent in it. `items` are list items; the answer maps
   * "<account>|<conversationId>" → count. A message that is in both (mail to
   * yourself) counts once.
   */
  function threadCounts(items) {
    const d = openCache();
    const out = new Map();
    if (!d) return out;
    const wanted = new Map(); // account → conversation ids
    for (const i of items) {
      if (!i.account || !i.conversationId) continue;
      if (!wanted.has(i.account)) wanted.set(i.account, new Set());
      wanted.get(i.account).add(i.conversationId);
    }
    for (const [account, ids] of wanted) {
      const list = [...ids];
      const marks = list.map(() => '?').join(',');
      const rows = d.prepare(`SELECT id, conversation_id AS c, message_id AS m FROM messages WHERE account = ? AND conversation_id IN (${marks})
        UNION ALL SELECT id, conversation_id, message_id FROM sent WHERE account = ? AND conversation_id IN (${marks})`).all(account, ...list, account, ...list);
      const seen = new Map(); // conversation → message ids (the row id where there is none)
      for (const row of rows) {
        if (!seen.has(row.c)) seen.set(row.c, new Set());
        seen.get(row.c).add(row.m || row.id);
      }
      for (const [c, set] of seen) out.set(`${account}|${c}`, set.size);
    }
    return out;
  }

  /** Map id → the first `length` characters of the stored text body (only ids whose body is cached). */
  function snippets(ids, length = 180) {
    const out = new Map();
    // more than the line needs: a text part that is really a page of HTML starts with its head and styles
    for (const [id, text] of texts(ids, 8000)) {
      const t = previewText(text, length);
      if (t) out.set(id, t);
    }
    return out;
  }

  /** The start of the stored text of messages, as it was stored: id → text (those with a body only). */
  function texts(ids, length = 8000) {
    const d = openCache();
    const out = new Map();
    if (!d || !ids.length) return out;
    const rows = d.prepare(`SELECT id, substr(body_text, 1, ?) AS t FROM messages WHERE id IN (${ids.map(() => '?').join(',')}) AND body_text IS NOT NULL`).all(length, ...ids);
    for (const r of rows) out.set(r.id, String(r.t));
    return out;
  }

  /** Full cached message or null (null also when the body was never stored). */
  function getCached(id, { bodyType = 'Text', stale = false } = {}) {
    const d = openCache();
    if (!d) return null;
    const r = d.prepare('SELECT * FROM messages WHERE id = ?').get(id);
    if (!r || r.body_at == null) return null;
    // body_html: the HTML of the mail; '' when it is known to have none; null when nobody looked yet (only its text
    // was read). Asked for HTML, that last case is not an answer: the text would be shown for a mail that has HTML.
    if (bodyType === 'HTML' && r.body_html == null) return null;
    const wantHtml = bodyType === 'HTML' && r.body_html;
    if (bodyType !== 'HTML' && r.body_text == null) return null;
    // stored before Reply-To was kept: read again (and stored with it) rather than say it has none; `stale` takes
    // it as it is (the server cannot be reached), saying nothing of Reply-To
    if (r.reply_to_json == null && !stale) return null;
    return {
      ...toItem(r),
      to: JSON.parse(r.to_json || '[]'),
      cc: JSON.parse(r.cc_json || '[]'),
      ...(r.reply_to_json != null ? { replyTo: JSON.parse(r.reply_to_json) } : {}),
      attachments: JSON.parse(r.attachments_json || '[]'),
      bodyType: wantHtml ? 'HTML' : 'Text',
      body: wantHtml ? r.body_html : r.body_text ?? '',
      isBulk: r.is_bulk == null ? undefined : !!r.is_bulk,
      cached: true
    };
  }

  /**
   * People of the cached mail whose name or address contains `q` (everyone, with `q` empty): who wrote, and who
   * was written to alongside. Newsletters and robots are left out. [{ name, email, n }]: most frequent first.
   */
  function people(q, { accounts, limit = 12 } = {}) {
    const d = openCache();
    const needle = String(q || '').trim().toLowerCase();
    if (!d) return [];
    const scope = accounts?.length ? `account IN (${accounts.map(() => '?').join(',')}) AND` : '';
    const args = accounts?.length ? accounts : [];
    const found = new Map(); // email → { name, email, n }
    const add = (name, email, n) => {
      email = String(email || '').trim();
      name = String(name || '').trim();
      const key = email.toLowerCase();
      if (!key.includes('@') || ROBOT.test(key)) return;
      if (!key.includes(needle) && !name.toLowerCase().includes(needle)) return;
      const cur = found.get(key);
      if (cur) { cur.n += n; if (!cur.name && name && name.toLowerCase() !== key) cur.name = name; }
      else found.set(key, { name: name.toLowerCase() === key ? '' : name, email, n });
    };
    const p = like(needle);
    for (const r of d.prepare(`SELECT from_name AS name, from_email AS email, SUM(COALESCE(is_bulk, 0) = 0) AS n FROM messages
        WHERE ${scope} (from_email LIKE ? ESCAPE '\\' OR from_name LIKE ? ESCAPE '\\')
        GROUP BY lower(from_email)
        -- a sender whose mail is mostly bulk, or mostly says how to unsubscribe, is a newsletter, not someone I write with
        -- (a strict majority: one forwarded newsletter beside one mail of their own does not make someone a newsletter)
        HAVING SUM(CASE WHEN is_bulk = 1 OR body_text LIKE '%unsubscribe%' OR body_text LIKE '%opt out%' OR body_text LIKE '%sabonner%' OR body_text LIKE '%manage your preferences%' THEN 1 ELSE 0 END) * 2 <= COUNT(*)
          AND n > 0
        ORDER BY n DESC LIMIT 200`).all(...args, p, p)) add(r.name, r.email, r.n * 2); // someone who writes to me counts double
    for (const r of d.prepare(`SELECT to_json, cc_json FROM messages
        WHERE ${scope} (to_json LIKE ? ESCAPE '\\' OR cc_json LIKE ? ESCAPE '\\') AND COALESCE(is_bulk, 0) = 0
        ORDER BY received DESC LIMIT 400`).all(...args, p, p)) {
      for (const json of [r.to_json, r.cc_json]) {
        let list = [];
        try { list = JSON.parse(json || '[]'); } catch { /* an odd row: skip it */ }
        for (const who of list) add(who?.name, who?.email, 1);
      }
    }
    return [...found.values()].sort((a, b) => b.n - a.n).slice(0, limit);
  }

  function cacheStats() {
    const d = openCache();
    if (!d) return null;
    const rows = d.prepare('SELECT account, COUNT(*) AS n, SUM(body_at IS NOT NULL) AS bodies, MIN(received) AS oldest FROM messages GROUP BY account').all();
    let size = 0;
    for (const f of [CACHE_PATH, CACHE_PATH + '-wal']) { try { size += fs.statSync(f).size; } catch {} }
    return { path: CACHE_PATH, size, accounts: rows.map((r) => ({ ...r, synced: lastSync(r.account) })) };
  }

  function toItem(r) {
    return {
      id: r.id, account: r.account, changeKey: r.change_key || '', subject: r.subject, fromName: r.from_name, fromEmail: r.from_email,
      displayTo: r.display_to, isRead: !!r.is_read, isFlagged: !!r.is_flagged, hasAttachments: !!r.has_attachments, received: r.received, cached: true,
      conversationId: r.conversation_id || '', messageId: r.message_id || '', inReplyTo: r.in_reply_to || ''
    };
  }

  function like(s) {
    return '%' + String(s).replace(/[%_\\]/g, (c) => '\\' + c) + '%';
  }

  return {
    path: CACHE_PATH,
    cachedAccounts, cacheKeyExists, openCache, closeCache,
    upsertItems, dropUnlisted, reconcile, noteSent, upsertBody, setBulk, setRead, setFlagged, removeMessage,
    getMeta, setMeta, idsOf, applyChanges, prune, clearCache,
    cacheUsable, lastSync, windowStart, findCached, cachedSince, threadCounts, snippets, texts, getCached, people, cacheStats
  };
}

const ROBOT = /(^|[._+-])(no-?reply|do-?not-?reply|donotreply|mailer-daemon|postmaster|bounces?|notifications?)([._+-]|@)/;
