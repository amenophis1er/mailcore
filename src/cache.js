// Encrypted local mail cache: SQLite (SQLCipher via better-sqlite3-multiple-
// ciphers) at <dataDir>/cache.db. The key is the caller's: a string, or a
// function ({ create }) → string | null that may create and store one the
// first time (create: true) — mailcore never stores it. A watcher writes —
// headers for every poll, bodies for new mail — and readers serve from it
// first while the watcher is alive, falling back to the live server.
//
// Only the inbox is cached, for the last `cache.days` days per account.
// Attachments are never stored (only their names/sizes).

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { MAIL_PROVIDERS } from './accounts.js';

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
    // columns added after 1.0: thread identity and the bulk flag
    const cols = new Set(d.prepare('PRAGMA table_info(messages)').all().map((c) => c.name));
    for (const [name, type] of [['conversation_id', 'TEXT'], ['message_id', 'TEXT'], ['in_reply_to', 'TEXT'], ['is_bulk', 'INTEGER']]) {
      if (!cols.has(name)) d.exec(`ALTER TABLE messages ADD COLUMN ${name} ${type}`);
    }
    d.exec('CREATE INDEX IF NOT EXISTS messages_conversation ON messages(account, conversation_id)');
  }

  // --- writes (daemon) ----------------------------------------------------------

  /** Insert or refresh header rows from a listing. Returns ids not seen before. */
  function upsertItems(account, items) {
    const d = openCache({ create: true });
    const now = Date.now();
    const sel = d.prepare('SELECT id FROM messages WHERE id = ?');
    const ins = d.prepare(`INSERT INTO messages (id, account, change_key, subject, from_name, from_email, display_to, is_read, has_attachments, received, seen_at, conversation_id, message_id, in_reply_to)
      VALUES (@id, @account, @changeKey, @subject, @fromName, @fromEmail, @displayTo, @isRead, @hasAttachments, @received, @seenAt, @conversationId, @messageId, @inReplyTo)`);
    const upd = d.prepare(`UPDATE messages SET change_key = @changeKey, is_read = @isRead, has_attachments = @hasAttachments, seen_at = @seenAt,
      conversation_id = COALESCE(NULLIF(@conversationId, ''), conversation_id), message_id = COALESCE(NULLIF(@messageId, ''), message_id), in_reply_to = COALESCE(NULLIF(@inReplyTo, ''), in_reply_to) WHERE id = @id`);
    const fresh = [];
    d.transaction(() => {
      for (const i of items) {
        if (!i.id) continue;
        const row = {
          id: i.id, account, changeKey: i.changeKey || '', subject: i.subject || '', fromName: i.fromName || '', fromEmail: i.fromEmail || '',
          displayTo: i.displayTo || '', isRead: i.isRead ? 1 : 0, hasAttachments: i.hasAttachments ? 1 : 0,
          received: i.received || new Date(0).toISOString(), seenAt: now,
          conversationId: i.conversationId || '', messageId: i.messageId || '', inReplyTo: i.inReplyTo || ''
        };
        if (sel.get(i.id)) upd.run(row);
        else { ins.run(row); fresh.push(i.id); }
      }
      d.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run('synced:' + account, String(now));
    })();
    return fresh;
  }

  /** Store a full message (from getMessage). text and html bodies are optional. */
  function upsertBody(account, msg, { text, html } = {}) {
    const d = openCache({ create: true });
    const exists = d.prepare('SELECT body_text, body_html FROM messages WHERE id = ?').get(msg.id);
    if (!exists) upsertItems(account, [msg]);
    d.prepare(`UPDATE messages SET to_json = ?, cc_json = ?, attachments_json = ?,
        body_text = COALESCE(?, body_text), body_html = COALESCE(?, body_html), body_at = ?,
        is_bulk = ?, conversation_id = COALESCE(NULLIF(?, ''), conversation_id), message_id = COALESCE(NULLIF(?, ''), message_id), in_reply_to = COALESCE(NULLIF(?, ''), in_reply_to) WHERE id = ?`)
      .run(JSON.stringify(msg.to || []), JSON.stringify(msg.cc || []), JSON.stringify(msg.attachments || []),
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

  function removeMessage(id) {
    const d = openCache();
    if (d) d.prepare('DELETE FROM messages WHERE id = ?').run(id);
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
    }
    const names = Object.keys(config.accounts);
    removed += d.prepare(`DELETE FROM messages WHERE account NOT IN (${names.map(() => '?').join(',') || "''"})`).run(...names).changes;
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
      params.push(texts.map((t) => '"' + String(t).replace(/"/g, '""') + '"').join(' AND '));
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

  /** Full cached message or null (null also when the body was never stored). */
  function getCached(id, { bodyType = 'Text' } = {}) {
    const d = openCache();
    if (!d) return null;
    const r = d.prepare('SELECT * FROM messages WHERE id = ?').get(id);
    if (!r || r.body_at == null) return null;
    const wantHtml = bodyType === 'HTML' && r.body_html;
    if (bodyType !== 'HTML' && r.body_text == null) return null;
    return {
      ...toItem(r),
      to: JSON.parse(r.to_json || '[]'),
      cc: JSON.parse(r.cc_json || '[]'),
      attachments: JSON.parse(r.attachments_json || '[]'),
      bodyType: wantHtml ? 'HTML' : 'Text',
      body: wantHtml ? r.body_html : r.body_text ?? '',
      isBulk: r.is_bulk == null ? undefined : !!r.is_bulk,
      cached: true
    };
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
      displayTo: r.display_to, isRead: !!r.is_read, hasAttachments: !!r.has_attachments, received: r.received, cached: true,
      conversationId: r.conversation_id || '', messageId: r.message_id || '', inReplyTo: r.in_reply_to || ''
    };
  }

  function like(s) {
    return '%' + String(s).replace(/[%_\\]/g, (c) => '\\' + c) + '%';
  }

  return {
    path: CACHE_PATH,
    cachedAccounts, cacheKeyExists, openCache, closeCache, upsertItems, upsertBody, setBulk, setRead, removeMessage,
    prune, clearCache, cacheUsable, lastSync, findCached, cachedSince, getCached, cacheStats
  };
}
