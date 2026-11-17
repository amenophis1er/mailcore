// IMAP (+ SMTP for sending) backend implementing the MailClient contract
// documented in client.js. Uses imapflow for IMAP, mailparser to read
// messages, nodemailer to build MIME and to send.
//
// Ids are "<mailbox>/<uidvalidity>/<uid>" (mailbox URI-encoded), so a
// listing from any folder routes back to the right message, and a mailbox
// reset (new UIDVALIDITY) never collides with old ids in the seen-set.
// Drafts are immutable in IMAP: an edit appends a new message and deletes
// the old one, so updateDraft/addAttachment return the NEW id as changeKey.

import { randomUUID } from 'node:crypto';
import { domainToASCII } from 'node:url';
import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import nodemailer from 'nodemailer';
import MailComposer from 'nodemailer/lib/mail-composer';
import { displayNameOf } from './accounts.js';
import { idParts } from './client.js';
import { AUTH_HEADER_NAMES, authHeadersFrom, authHeadersOfParsed, headerPairs } from './auth-headers.js';
import { isAutoReply, AUTO_REPLY_HEADERS } from './auto-reply.js';

export { idParts }; // defined beside splitId, so it can be had without loading the IMAP backend

const FOLDER_SPECIAL = { inbox: '\\Inbox', junk: '\\Junk', sent: '\\Sent', drafts: '\\Drafts', trash: '\\Trash', archive: '\\Archive' };
const FOLDER_NAMES = {
  inbox: ['inbox'],
  junk: ['junk', 'spam', 'junk e-mail', 'junk email', 'bulk mail'],
  sent: ['sent', 'sent items', 'sent messages', 'sent mail'],
  drafts: ['drafts', 'draft'],
  trash: ['trash', 'deleted items', 'deleted messages', 'bin'],
  archive: ['archive', 'all mail']
};
export const FOLDERS = Object.keys(FOLDER_SPECIAL);

export function imapOptions(acct, creds) {
  const { host, port = 993, secure = true, rejectUnauthorized } = acct.imap || {};
  if (!host) throw new Error(`account "${acct.name}": imap.host is not set`);
  return {
    host,
    port: Number(port),
    secure: !!secure,
    auth: { user: creds.username || acct.email, pass: creds.password },
    logger: false,
    tls: rejectUnauthorized === false ? { rejectUnauthorized: false } : undefined
  };
}

/**
 * The server will take no more connections for this account just now (Gmail allows fifteen at once, counting every
 * app and device signed in to it): said at sign-in, where a wrong password is said too, and not to be taken for one.
 */
export function busyError(e) {
  return !!e && /too many simultaneous connections|too many connections|connection limit|\[(?:UNAVAILABLE|LIMIT|INUSE)\]/i.test(String(e.responseText || e.message || ''));
}

export function authError(e) {
  if (busyError(e)) return false;
  return !!e && (e.authenticationFailed === true || e.code === 'MAIL_AUTH' || e.code === 'EAUTH' ||
    /AUTHENTICATIONFAILED|Invalid credentials|LOGIN failed/i.test(String(e.responseText || e.message || '')));
}

function tagAuth(e) {
  if (busyError(e)) {
    e.code = 'MAIL_BUSY';
    e.message = `the mail server takes no more connections for this account just now (${String(e.responseText || e.message).replace(/\s*\(Failure\)\s*$/, '').trim()}): other apps and devices signed in to it count too. Try again in a moment`;
  } else if (authError(e)) e.code = 'MAIL_AUTH';
  return e;
}

export class ImapClient {
  changeKeyIsId = true;

  constructor(acct, creds) {
    this.acct = acct;
    this.creds = creds;
    this.self = (acct.email || (String(creds.username).includes('@') ? creds.username : '')).toLowerCase();
    this.logoutMs = 5000; // how long close() waits for the server's answer to LOGOUT
  }

  async selfEmail() {
    if (!this.self) throw new Error('set "email" on the IMAP account');
    return this.self;
    this.client = null;
    this.folderMap = null;
  }

  // --- connection -----------------------------------------------------------

  async #conn() {
    if (this.client && this.client.usable) return this.client;
    // (one connection, however many ask for it at once as it is being made)
    this.connecting ??= (async () => {
      const c = new ImapFlow(imapOptions(this.acct, this.creds));
      c.on('error', () => {}); // surfaced through the awaiting command instead
      try {
        await c.connect();
      } catch (e) {
        const said = tagAuth(e);
        // (refused before anything was asked on this client: whoever holds it may wait and ask again from the start)
        if (said.code === 'MAIL_BUSY' && !this.connected) said.unstarted = true;
        throw said;
      }
      this.connected = true;
      this.client = c;
      return c;
    })().finally(() => { this.connecting = null; });
    return this.connecting;
  }

  /** Kept from a use before, and taken for another (Mailcore.keepClients): the folder its connection has selected is selected anew at its first use (#inMailbox). */
  again() { this.use = (this.use || 0) + 1; }

  /**
   * Whether the connection kept still answers: a NOOP, waited for `ms` (a connection the network dropped looks
   * usable, and its next command would wait for minutes). The server also says with it what arrived meanwhile.
   * true when there is none, or one known to be gone: the next use makes one.
   */
  async ping(ms = 3000) {
    const c = this.client;
    if (!c || !c.usable) return true;
    let timer;
    const late = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('no answer')), ms); });
    try { await Promise.race([c.noop(), late]); return true; } catch { return false; } finally { clearTimeout(timer); }
  }

  /**
   * Sign out (LOGOUT), or just hang up: a server that has not answered the
   * goodbye within `logoutMs` (a dead connection never will) is not waited for.
   */
  async close() {
    const c = this.client;
    this.client = null;
    if (!c) return;
    let timer;
    const late = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('no answer to LOGOUT')), this.logoutMs); });
    try { await Promise.race([c.logout(), late]); } catch { try { c.close(); } catch {} } finally { clearTimeout(timer); }
  }

  /**
   * For a connection that is kept and looked through again and again (the daemon's checks): each look opens
   * the mailbox anew. A session that keeps a mailbox selected learns of new mail when the server gets round to
   * telling it (Gmail: ten seconds and more after it arrived); a mailbox just opened is the mailbox as it is.
   * It is opened read-only, so that leaving it removes nothing (CLOSE expunges only what was opened to write).
   */
  asWatcher() {
    this.watcher = true;
    return this;
  }

  /** A watcher's next look opens the mailbox anew, however lately it was opened (the daemon says so before each check). */
  lookAgain() {
    this.openedAt = 0;
  }

  /**
   * Run fn(connection, mailbox) with a folder selected. `sure`: the folder's state must be the server's now (what
   * moves or deletes mail by its number).
   */
  async #inMailbox(path, fn, { sure = false } = {}) {
    const c = await this.#conn();
    if (this.watcher) {
      // (not between the steps of one look: the listing, then the bodies of what it found)
      if (c.mailbox && c.mailbox.readOnly && Date.now() - (this.openedAt || 0) > 1500) await c.mailboxClose();
      if (!c.mailbox) this.openedAt = Date.now();
    }
    const lock = await c.getMailboxLock(path, this.watcher ? { readOnly: true } : undefined);
    try {
      // (selected by this lock, or the one it had selected: by the mailbox it holds, which is another once selected anew)
      // (when, in which use of this client, and after how many changes made from here: counted, not timed, so that two things of the same instant are told apart)
      const selected = () => { this.box = c.mailbox; this.selectedAt = Date.now(); this.selectedIn = this.use || 0; this.selectedAfter = changedHere.get(this.#account()) || 0; };
      if (c.mailbox !== this.box) selected();
      const anew = async () => { await c.mailboxOpen(path); selected(); };
      // A folder this connection had selected before this use began (a client kept from a use before, taken again:
      // again()): the session sees the folder as it was until told otherwise, and the lock selects nothing when the
      // folder is the one selected. Selecting it anew costs (a second and more for a large inbox at Gmail), so: at
      // once when it must be sure (what moves or deletes by a number, what lists by the folder's count), when it was
      // selected more than RESELECT_MS ago, or when mail was put in, moved or removed from here since (changedHere:
      // by any connection of this process to the account); else only if a message turns out not to be found (one
      // that arrived since: selected anew then, and asked once more, nothing having been done). Once selected anew
      // in a use, it is fresh for the rest of that use; any other folder is selected by the lock anyway.
      const kept = !this.watcher && (this.selectedIn || 0) < (this.use || 0);
      const now = kept && (sure || Date.now() - (this.selectedAt || 0) > RESELECT_MS || (this.selectedAfter || 0) < (changedHere.get(this.#account()) || 0));
      if (now) await anew();
      try {
        return await fn(c, c.mailbox);
      } catch (e) {
        // (a message that is not there: not an attachment of one that is)
        if (!(kept && !now && /message not found|no longer in that folder/i.test(String(e?.message)))) throw e;
        await anew();
        return await fn(c, c.mailbox);
      }
    } finally {
      lock.release();
    }
  }

  /** The account, as what was changed in it from here is told of (changedHere). */
  #account() { return `${this.acct?.imap?.host || ''}|${this.creds?.username || this.acct?.email || this.acct?.name || ''}`; }
  /** Mail was put in, moved or removed by this process: every connection to the account kept from before sees its folders anew. */
  #changed() { changedHere.set(this.#account(), (changedHere.get(this.#account()) || 0) + 1); }

  async #folder(key) {
    const k = String(key || 'inbox').toLowerCase();
    if (!FOLDER_SPECIAL[k]) throw new Error(`unknown folder "${key}" — use: ${FOLDERS.join(', ')}`);
    if (k === 'inbox' && !this.acct.imap?.folders?.inbox) return 'INBOX'; // RFC-fixed name: skip the (slow) LIST
    if (!this.folderMap) {
      const c = await this.#conn();
      const boxes = await c.list();
      const map = {};
      for (const f of FOLDERS) {
        const override = this.acct.imap?.folders?.[f];
        const bySpecial = boxes.find((b) => b.specialUse === FOLDER_SPECIAL[f]);
        const byName = boxes.find((b) => FOLDER_NAMES[f].includes(leaf(b).toLowerCase()));
        map[f] = override || bySpecial?.path || byName?.path || (f === 'inbox' ? 'INBOX' : null);
      }
      this.folderMap = map;
    }
    const path = this.folderMap[k];
    if (!path) throw new Error(`no "${k}" folder on this IMAP server — set accounts.${this.acct.name}.imap.folders.${k} in config`);
    return path;
  }

  // --- operations -----------------------------------------------------------

  async findInbox(opts = {}) {
    const path = await this.#folder(opts.folder);
    const max = Math.min(opts.limit || 25, 100);
    // (with nothing to search for, the newest are listed by the folder's count: that count has to be the server's now)
    const some = (v) => (Array.isArray(v) ? v.length > 0 : !!v);
    const byCount = ![opts.unreadOnly, opts.flaggedOnly, opts.senderContains, opts.subjectContains, opts.threadId, opts.sinceIso, opts.untilIso, opts.fromMe, opts.toContains, opts.withAny, opts.text].some(some);
    return this.#inMailbox(path, async (c, mailbox) => {
      const uv = String(mailbox.uidValidity);
      const query = {};
      if (opts.unreadOnly) query.seen = false;
      if (opts.flaggedOnly) query.flagged = true; // Gmail's star
      if (opts.senderContains) query.from = opts.senderContains;
      if (opts.subjectContains) query.subject = opts.subjectContains;
      if (opts.threadId) query.threadId = String(opts.threadId); // the server's own thread (Gmail's X-GM-THRID, THREADID): see findThread
      if (opts.sinceIso) query.since = new Date(opts.sinceIso);
      if (opts.untilIso) query.before = new Date(new Date(opts.untilIso).getTime() + 86400e3); // BEFORE is exclusive, by day
      if (opts.fromMe) query.from = await this.selfEmail();
      // with any of these addresses: who wrote it, whom it was written to, or who was in copy (one search for all of a
      // person's mail in a folder, where from, to and cc were three)
      const withAny = (Array.isArray(opts.withAny) ? opts.withAny : opts.withAny ? [opts.withAny] : []).filter((a) => typeof a === 'string' && a);
      const any = withAny.flatMap((a) => [{ from: a }, { to: a }, { cc: a }]);
      // (both: to or cc that one, AND with any of these: a key holds one OR, so the second is inside each side of the first)
      if (withAny.length && opts.toContains) query.or = [{ to: opts.toContains, or: any }, { cc: opts.toContains, or: any }];
      else if (withAny.length) query.or = any;
      else if (opts.toContains) query.or = [{ to: opts.toContains }, { cc: opts.toContains }];
      const texts = Array.isArray(opts.text) ? opts.text : opts.text ? [opts.text] : [];
      if (texts.length === 1) query.text = texts[0];
      // every term: IMAP's criteria are ANDed but a key holds one value, and imapflow has no AND to nest,
      // so NOT (NOT a OR NOT b …), which is a AND b …
      else if (texts.length > 1) query.not = { or: texts.map((t) => ({ not: { text: t } })) };

      let range;
      let byUid = true;
      // hasAttachments is decided client-side from the body structure, so
      // scan the newest 100 and filter down.
      const want = opts.hasAttachments ? 100 : max;
      const offset = Math.max(0, Number(opts.offset) || 0);
      if (Object.keys(query).length === 0) {
        if (!mailbox.exists) return [];
        const hi = mailbox.exists - offset;
        if (hi < 1) return [];
        range = `${Math.max(1, hi - want + 1)}:${hi}`;
        byUid = false;
      } else {
        let uids = found(await c.search(query, { uid: true }));
        if (uids.length === 0) return [];
        uids.sort((a, b) => a - b);
        if (opts.untilIso) {
          // BEFORE is by whole days: the mail of the cursor's own day that came after it (the page before showed it) is left out here
          const until = new Date(opts.untilIso).getTime();
          const recent = uids.slice(-Math.max(want + offset, 1) - 500); // the newest ones are where the day's surplus is
          const late = new Set();
          for await (const m of c.fetch(recent.join(','), { uid: true, internalDate: true }, { uid: true })) if (m.internalDate && m.internalDate.getTime() > until) late.add(m.uid);
          if (late.size) uids = uids.filter((u) => !late.has(u));
          if (uids.length === 0) return [];
        }
        const page = uids.slice(0, uids.length - offset).slice(-want);
        if (page.length === 0) return [];
        range = page.join(',');
      }
      const items = [];
      for await (const m of c.fetch(range, { uid: true, envelope: true, flags: true, bodyStructure: true, internalDate: true, threadId: true }, { uid: byUid })) {
        items.push(listItem(path, uv, m));
      }
      items.sort((a, b) => new Date(b.received) - new Date(a.received));
      const filtered = opts.hasAttachments ? items.filter((i) => i.hasAttachments) : items;
      return filtered.slice(0, max);
    }, { sure: byCount });
  }

  /**
   * The messages of one thread of the server's own keeping, in a folder: by its thread id (what a message's
   * conversationId is: Gmail's X-GM-THRID, or THREADID where the server has OBJECTID), which the server looks up
   * at once, where a search by subject reads through months of mail. null where the server keeps no thread ids
   * to search by: the caller searches as it did.
   */
  async findThread({ folder, threadId, limit = 100 } = {}) {
    if (!threadId) return null;
    try { return await this.findInbox({ folder, threadId, limit }); } catch (e) {
      // (no thread ids to search by, or the server refused this search: by subject, as before)
      if (e?.code === 'MissingServerExtension' || /THREADID|refused the search/.test(String(e?.message))) return null;
      throw e;
    }
  }

  async getMessage(id, { bodyType = 'Text' } = {}) {
    const { path, uid } = parseId(id);
    const { item, parsed } = await this.#read(path, uid);
    return shaped(item, parsed, bodyType);
  }

  /**
   * Where a folder stands, and what changed in it since it stood at `mark` (what an earlier call gave back),
   * among the messages numbered `from` and up: the ones a cache holds, never the whole of a large mailbox.
   *
   *   { mark, reset: true }   no earlier mark, or the mailbox was rebuilt since: there is no difference to give
   *   { mark, same: true }    nothing changed
   *   { mark, flags, uids }   flags: [{ id, uid, isRead, isFlagged }] of the messages whose flags changed;
   *                           uids: the numbers of the messages there now (a Set), when their number changed,
   *                           else null. What is in a cache and not among them has left the folder.
   *
   * `flags`: 'changed' asks the server for what changed since the mark's counter (CONDSTORE; nothing is asked
   * where the server keeps no counter); 'all' reads the flags of every message from `from` up, counter or not;
   * false leaves flags alone.
   */
  async changesIn(folder, { mark = null, from = 1, flags = 'changed' } = {}) {
    const path = await this.#folder(folder);
    // (a watcher's look is as fresh as its check made it: the daemon asks this right after looking for new mail)
    return this.#inMailbox(path, async (c, mailbox) => {
      const now = {
        path,
        validity: String(mailbox.uidValidity),
        next: Number(mailbox.uidNext),
        exists: Number(mailbox.exists),
        modseq: mailbox.highestModseq != null ? String(mailbox.highestModseq) : null
      };
      // a server that does not say where the folder's numbers stand cannot be asked what changed since
      if (!Number.isFinite(now.next) || !Number.isFinite(now.exists)) return null;
      if (!mark || mark.path !== path || mark.validity !== now.validity) return { mark: now, reset: true };
      const moved = now.exists !== mark.exists || now.next !== mark.next;
      const counted = /^\d+$/.test(now.modseq ?? '') && /^\d+$/.test(mark.modseq ?? '');
      // every flag when all are asked for, counter or not: the counter of a server that keeps it badly is no excuse
      const flagsMoved = flags === 'all' || (counted && now.modseq !== mark.modseq);
      if (!moved && !(flags && flagsMoved)) return { mark: now, same: true, flags: [], uids: null };
      const first = Math.max(1, Number(from) || 1);
      const range = `${first}:*`;
      const changed = [];
      if (flags && flagsMoved) {
        const since = counted && flags !== 'all' ? { changedSince: BigInt(mark.modseq) } : {};
        for await (const m of c.fetch(range, { uid: true, flags: true }, { uid: true, ...since })) {
          // ("n:*" answers with the last message even when it is older than n)
          if (m.uid >= first) changed.push({ id: makeId(path, now.validity, m.uid), uid: m.uid, isRead: m.flags.has('\\Seen'), isFlagged: m.flags.has('\\Flagged') });
        }
      }
      // no server says what left a folder (short of QRESYNC, which Gmail has not): when the number of messages
      // moved, the numbers that are there are asked for, and the difference is taken by whoever kept the others
      const uids = moved ? new Set(found(await c.search({ uid: range }, { uid: true })).filter((u) => u >= first)) : null;
      return { mark: now, flags: changed, uids };
    });
  }

  /** The list items (headers, flags, thread) of messages of a folder, by number. */
  async listByUids(folder, uids) {
    const path = await this.#folder(folder);
    if (!uids.length) return [];
    return this.#inMailbox(path, async (c, mailbox) => {
      const uv = String(mailbox.uidValidity);
      const out = [];
      for await (const m of c.fetch(uids.join(','), { uid: true, envelope: true, flags: true, bodyStructure: true, internalDate: true, threadId: true }, { uid: true })) out.push(listItem(path, uv, m));
      return out.sort((x, y) => new Date(y.received) - new Date(x.received));
    });
  }

  /**
   * The inbox's messages from a UID on: what arrived since the mailbox was last looked at, without listing it
   * again. With `bodies` each comes whole (its text in `body`, its HTML in `html`), downloaded once instead of
   * once per form of its body. Null when there are more than a handful: that is not "a mail came in" but a
   * mailbox being filled (a batch moved back in), which the ordinary listing handles, with its own limits.
   */
  async newSince(uid, { bodies = true } = {}) {
    const from = Number(uid);
    const path = await this.#folder('inbox');
    this.lookAgain(); // by definition the first step of a look: what is new shows only in a mailbox just opened
    return this.#inMailbox(path, async (c, mailbox) => {
      const uv = String(mailbox.uidValidity);
      const found = [];
      for await (const m of c.fetch(`${from}:*`, { uid: true, envelope: true, flags: true, bodyStructure: true, internalDate: true, threadId: true }, { uid: true })) {
        if (m.uid >= from) found.push(m); // "n:*" always answers with the last message, an older one too
      }
      if (found.length > 10) return null;
      const items = new Map(found.map((m) => [m.uid, listItem(path, uv, m)]));
      const out = [...items.values()];
      if (bodies && found.length) {
        out.length = 0;
        for await (const m of c.fetch(found.map((x) => x.uid).join(','), { uid: true, source: true }, { uid: true })) {
          if (!items.has(m.uid) || !m.source) continue;
          const parsed = await simpleParser(m.source);
          out.push({ ...shaped(items.get(m.uid), parsed, 'Text'), html: parsed.html ? String(parsed.html).replace(/\r\n?/g, '\n') : null });
          items.delete(m.uid);
        }
        out.push(...items.values()); // one whose body did not come (gone meanwhile): its header is still news
      }
      return out.sort((x, y) => new Date(y.received) - new Date(x.received));
    });
  }

  async draftReply(id, changeKey, newBodyText, { bodyType = 'Text' } = {}) {
    return this.draftReplyAll(id, changeKey, newBodyText, { all: false, bodyType });
  }

  async draftReplyAll(id, _changeKey, newBodyText, { all = true, bodyType = 'Text' } = {}) {
    const { path, uid } = parseId(id);
    // (a reply carries none of the attachments: a large message is read without them, but with the pictures its quote shows)
    const { parsed } = await this.#read(path, uid, { pictures: bodyType === 'HTML' });
    const from = addrs(parsed.from)[0] || {};
    const replyTo = addrs(parsed.replyTo);
    const recipients = (replyTo.length ? replyTo : [from]).concat(all ? addrs(parsed.to) : []).map((a) => a.email).filter(Boolean);
    const cc = all ? addrs(parsed.cc).map((a) => a.email).filter(Boolean) : [];
    const notSelf = (e) => e.toLowerCase() !== this.self;
    const to = uniq(recipients.filter(notSelf));
    const subject = /^re:/i.test(parsed.subject || '') ? parsed.subject : `Re: ${parsed.subject || ''}`;
    const when = parsed.date ? parsed.date.toUTCString() : '';
    const who = from.name ? `${from.name} <${from.email}>` : from.email || '';
    const origText = String(parsed.text || stripHtml(parsed.html || ''));
    const quoted = origText.split('\n').map((l) => '> ' + l).join('\n');
    const html = bodyType === 'HTML';
    const text = `${html ? stripHtml(newBodyText) : newBodyText}\n\nOn ${when}, ${who} wrote:\n${quoted}\n`;
    const htmlBody = html
      ? `${newBodyText}<br><br><div>On ${escapeHtml(when)}, ${escapeHtml(who)} wrote:</div><blockquote style="margin:0 0 0 .8ex;border-left:1px solid #ccc;padding-left:1ex">${parsed.html || `<pre style="white-space:pre-wrap">${escapeHtml(origText)}</pre>`}</blockquote>`
      : undefined;
    const refs = [].concat(parsed.references || [], parsed.messageId || []).filter(Boolean);
    const draftId = await this.#appendDraft({
      from: this.#from,
      to,
      cc: uniq(cc.filter(notSelf).filter((e) => !to.includes(e))),
      subject,
      text,
      html: htmlBody,
      inReplyTo: parsed.messageId,
      references: refs.join(' ')
    });
    return { draftId, changeKey: draftId };
  }

  /** Forward DRAFT: the original below the new body, its attachments carried over. */
  async draftForward(id, _changeKey, newBodyText, { bodyType = 'Text', to = [], cc = [], bcc = [] } = {}) {
    const { path, uid } = parseId(id);
    const { parsed } = await this.#fetchParsed(path, uid);
    const from = addrs(parsed.from)[0] || {};
    const who = from.name ? `${from.name} <${from.email}>` : from.email || '';
    const when = parsed.date ? parsed.date.toUTCString() : '';
    const toLine = addrs(parsed.to).map((a) => a.email).join(', ');
    const subject = /^fwd?:/i.test(parsed.subject || '') ? parsed.subject : `Fwd: ${parsed.subject || ''}`;
    const header = [`From: ${who}`, `Date: ${when}`, `Subject: ${parsed.subject || ''}`, `To: ${toLine}`];
    const origText = String(parsed.text || stripHtml(parsed.html || ''));
    const html = bodyType === 'HTML';
    const text = `${html ? stripHtml(newBodyText) : newBodyText}\n\n---------- Forwarded message ----------\n${header.join('\n')}\n\n${origText}\n`;
    const htmlBody = html
      ? `${newBodyText}<br><br><div>---------- Forwarded message ----------<br>${header.map(escapeHtml).join('<br>')}</div><br>${parsed.html || `<pre style="white-space:pre-wrap">${escapeHtml(origText)}</pre>`}`
      : undefined;
    const draftId = await this.#appendDraft({
      from: this.#from, to, cc, bcc, subject, text, html: htmlBody,
      attachments: (parsed.attachments || []).map((a) => ({ filename: a.filename, content: a.content, contentType: a.contentType, cid: a.cid }))
    });
    return { draftId, changeKey: draftId };
  }

  async createMessage({ to = [], cc = [], bcc = [], subject = '', body = '', bodyType = 'Text', send = false }) {
    const html = bodyType === 'HTML';
    const mail = { from: this.#from, to, cc, bcc, subject, text: html ? stripHtml(body) : body, html: html ? body : undefined };
    if (!send) {
      const draftId = await this.#appendDraft(mail);
      return { sent: false, draftId, changeKey: draftId };
    }
    const raw = await compose(mail);
    const sent = await this.#folder('sent'); // (before anything leaves)
    await this.#smtpSend(raw, { from: this.self, to: [...to, ...cc, ...bcc] });
    // It has left: a copy in Sent that fails is tried again, and never makes this a send that failed (as in sendItem).
    let sentId = null;
    const keep = async () => { sentId = await this.#append(sent, raw, ['\\Seen']); };
    try { await keep(); } catch { try { await keep(); } catch {} }
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
    // the draft was written again under a new id: say so, or the old one (gone) is the one asked for next
    return { attachmentId: name, draftId, changeKey: draftId };
  }

  /** Remove one attachment (id from getMessage().attachments, or its file name) from a draft. */
  async removeAttachment(id, changeKey, attId) {
    const { path, uid } = parseId(changeKey || id);
    const { parsed } = await this.#fetchParsed(path, uid);
    const at = (parsed.attachments || []).findIndex((x, i) => isAttachment(x, i, attId) || x.filename === attId);
    if (at < 0) throw new Error(`attachment "${attId}" not found on this draft`);
    const draftId = await this.#rewriteDraft(changeKey || id, (mail) => { mail.attachments.splice(at, 1); });
    return { draftId, changeKey: draftId };
  }

  async sendItem(id, changeKey) {
    const { path, uid } = parseId(changeKey || id);
    const { parsed, source } = await this.#fetchParsed(path, uid, true);
    const to = [...addrs(parsed.to), ...addrs(parsed.cc), ...addrs(parsed.bcc)].map((a) => a.email).filter(Boolean);
    if (to.length === 0) throw new Error('sendItem: the draft has no recipients');
    const from = addrs(parsed.from)[0]?.email || this.self;
    const sent = await this.#folder('sent'); // (before anything leaves: an account with no Sent folder sends nothing)
    // It leaves under a Message-ID of its own, not its draft's. On Gmail a mail sent from a draft has been found
    // afterwards as one message marked both sent and draft, under another number in Drafts (what removes the draft
    // below then finds nothing): as read here, Gmail takes a mail submitted under the id of a draft it holds for
    // that draft. Under an id of its own the mail and its draft are two things for the server.
    const mail = withMessageId(source, newMessageId(from));
    await this.#smtpSend(withoutBcc(mail), { from, to }); // Bcc is in the envelope, never in what the others receive
    // It has left. Nothing below makes this a send that failed: whoever tries again (the caller on an error, the
    // retry around a client call when signing in again fails) would send it a second time. The copy in Sent and
    // the draft's removal are tried twice; a draft is only removed once its mail is kept.
    let kept = false;
    const tidy = async () => {
      if (!kept) {
        const c = await this.#conn();
        if (!await c.append(sent, mail, ['\\Seen'])) throw new Error('not kept in Sent'); // (no number asked of the server: kept is kept)
        this.#changed();
        kept = true;
      }
      if (!await this.#delete(path, uid)) throw new Error('the draft was not removed');
    };
    try { await tidy(); } catch { try { await tidy(); } catch {} }
    return true;
  }

  /** Download one attachment: attachmentId as listed by getMessage (the message is re-fetched and parsed). */
  async getAttachment(attId, messageId) {
    if (!messageId) throw new Error('getAttachment: the message id is required for IMAP');
    const { path, uid } = parseId(messageId);
    // one listed by its part (a large message, read part by part): that part alone
    const byPart = /^p(\d+(?:\.\d+)*)$/.exec(String(attId));
    if (byPart) return this.#fetchPart(path, uid, byPart[1]);
    const { parsed } = await this.#fetchParsed(path, uid);
    const list = parsed.attachments || [];
    const a = list.find((x, i) => isAttachment(x, i, attId)) || list.find((x) => x.filename === attId);
    if (!a) throw new Error(`attachment "${attId}" not found on this message`);
    return { name: a.filename || 'attachment', contentType: a.contentType || 'application/octet-stream', contentId: a.cid || undefined, content: a.content };
  }

  async deleteItem(id, changeKey) {
    const { path, uidValidity, uid } = parseId(changeKey || id);
    const trash = await this.#folder('trash');
    await this.#inMailbox(path, async (c, mailbox) => {
      // (an id of an earlier generation of the mailbox names a message that is gone: its number may now be another's)
      if (String(mailbox.uidValidity) !== uidValidity) throw new Error(`message not found: ${id}`);
      if (path === trash) await c.messageDelete(uid, { uid: true });
      else await c.messageMove(uid, trash, { uid: true });
    }, { sure: true });
    this.#changed();
    return true;
  }

  /** Move messages to a folder. Returns Map old id → new id (where the server says it: UIDPLUS). (EWS also answers null for a message that is gone; here such a move simply does nothing.) */
  async moveItems(ids, folder) {
    const dest = await this.#folder(folder);
    const out = new Map();
    const byPath = new Map();
    for (const id of ids) { const p = parseId(id); byPath.set(p.path, [...(byPath.get(p.path) || []), { id, uid: p.uid, uidValidity: p.uidValidity }]); }
    // each folder on its own: one that fails does not undo what another already moved (ids left out were not moved)
    let failure = null;
    for (const [path, list] of byPath) {
      if (path === dest) { for (const x of list) out.set(x.id, x.id); continue; }
      try {
        await this.#inMailbox(path, async (c, mailbox) => {
          // an id of an earlier generation of the mailbox (rebuilt since) names a message that is gone: its
          // number may now be another message's, which must not be moved in its place
          const live = [];
          for (const x of list) { if (String(mailbox.uidValidity) === x.uidValidity) live.push(x); else out.set(x.id, null); }
          if (!live.length) return;
          const r = await c.messageMove(live.map((x) => x.uid).join(','), dest, { uid: true });
          this.#changed();
          if (!r) throw new Error(`the mail server did not move the messages out of ${path}`);
          for (const x of live) {
            const uid = r.uidMap?.get(x.uid);
            // a server that says where each went (UIDPLUS) and not where this one went: it was no longer there
            out.set(x.id, uid && r.uidValidity ? `${encodeURIComponent(dest)}/${r.uidValidity}/${uid}` : r.uidMap ? null : x.id);
          }
        }, { sure: true });
      } catch (e) {
        failure ||= e;
      }
    }
    if (failure && ![...out.values()].some((v) => v != null)) throw failure;
    return out;
  }


  markRead(id, changeKey, isRead = true) { return this.#store(changeKey || id, '\\Seen', isRead); }

  /** \\Flagged: a star in Gmail, a flag elsewhere. */
  setFlag(id, changeKey, flagged = true) { return this.#store(changeKey || id, '\\Flagged', flagged); }

  /**
   * Set or clear one IMAP flag on the message an id names. The id holds the
   * mailbox's UIDVALIDITY: in a mailbox rebuilt since, the same UID is
   * another message. And a STORE on a UID that is gone succeeds without
   * doing anything, so the message is looked for first.
   */
  async #store(id, flag, on) {
    const { path, uidValidity, uid } = parseId(id);
    await this.#inMailbox(path, async (c, mailbox) => {
      if (String(mailbox.uidValidity) !== uidValidity || !(await c.fetchOne(uid, { uid: true }, { uid: true }))) throw new Error('message not found: it is no longer in that folder');
      const done = on ? await c.messageFlagsAdd(uid, [flag], { uid: true }) : await c.messageFlagsRemove(uid, [flag], { uid: true });
      if (!done) throw new Error(`the mail server did not ${on ? 'set' : 'clear'} ${flag} on that message`);
    });
    return true;
  }

  // --- internals ------------------------------------------------------------

  /**
   * A message as #fetchParsed gives it (its list item, and mailparser's reading of it), in one look at the
   * mailbox. One over LIGHT_OVER is read without the bytes of its attachments: its structure, every part's own
   * headers and the bodies of its texts are put back together as the message with those bodies left empty, and
   * that is parsed as the whole would be (the same texts, in the same order; the attachments listed, by part, with
   * the sizes the server gives; their bytes are #fetchPart's, when asked for). `pictures`: with the bodies of its
   * inline pictures too, taken into the HTML as the whole parse takes them (a reply's quote).
   */
  async #read(path, uid, { pictures = false } = {}) {
    return this.#inMailbox(path, async (c, mailbox) => {
      const meta = await c.fetchOne(uid, { uid: true, envelope: true, flags: true, bodyStructure: true, internalDate: true, threadId: true, size: true, headers: true }, { uid: true });
      if (!meta) throw new Error('message not found (it may have been moved or deleted)');
      const item = listItem(path, String(mailbox.uidValidity), meta);
      // (a part the server would not give: the message is read whole instead)
      const skeleton = (meta.size || 0) > LIGHT_OVER && Buffer.isBuffer(meta.headers) ? await skeletonOf(c, uid, meta, { pictures }).catch(() => null) : null;
      if (skeleton) {
        const parsed = await simpleParser(skeleton.source, { keepCidLinks: !pictures });
        const single = onePart(meta.bodyStructure);
        for (const at of parsed.attachments || []) {
          if (!at.partId && single) at.partId = '1'; // a message that is one attachment
          const node = skeleton.leaves.get(at.partId);
          // (what the server gives is the size as sent: base64 is a third more, with a line break every 76 characters)
          if (node && !skeleton.fetched.has(at.partId)) at.size = node.encoding === 'base64' ? Math.floor(node.size * 3 / 4 * 76 / 78) : node.size;
        }
        return { item, parsed };
      }
      const whole = await c.fetchOne(uid, { uid: true, source: true }, { uid: true });
      if (!whole?.source) throw new Error('message not found (it may have been moved or deleted)');
      const parsed = await simpleParser(whole.source);
      if (meta.bodyStructure && onePart(meta.bodyStructure)) for (const at of parsed.attachments || []) at.partId ||= '1';
      return { item, parsed };
    });
  }

  /** One part of a message (its number as mailparser gives it), decoded as the whole parse decodes it: { name, contentType, contentId, content }. */
  async #fetchPart(path, uid, part) {
    return this.#inMailbox(path, async (c) => {
      const meta = await c.fetchOne(uid, { uid: true, bodyStructure: true, headers: true }, { uid: true });
      if (!meta) throw new Error('message not found (it may have been moved or deleted)');
      const leaves = leavesOf(meta.bodyStructure);
      if (!meta.bodyStructure || !leaves.has(part)) throw new Error(`attachment "p${part}" not found on this message`);
      const single = onePart(meta.bodyStructure);
      const got = await c.fetchOne(uid, { uid: true, bodyParts: single ? [part] : [`${part}.MIME`, part] }, { uid: true });
      const bodies = partsMap(got);
      const head = single ? meta.headers : bodies.get(`${part}.mime`);
      const body = bodies.get(part);
      if (!Buffer.isBuffer(head) || !Buffer.isBuffer(body)) throw new Error(`attachment "p${part}" not found on this message`);
      const parsed = await simpleParser(Buffer.concat([withoutEnd(head), Buffer.from('\r\n\r\n'), body]), { keepCidLinks: true });
      const a = parsed.attachments?.[0];
      if (a) return { name: a.filename || 'attachment', contentType: a.contentType || 'application/octet-stream', contentId: a.cid || undefined, content: a.content };
      // a text the parse took for one (named, not said to be an attachment): its text, as shown
      const node = leaves.get(part);
      const html = node.type === 'text/html';
      return { name: node.filename || (html ? 'part.html' : 'part.txt'), contentType: html ? 'text/html' : 'text/plain', contentId: undefined, content: Buffer.from(String((html ? parsed.html : parsed.text) || ''), 'utf8') };
    });
  }

  async #fetchParsed(path, uid, withSource = false) {
    return this.#inMailbox(path, async (c, mailbox) => {
      const meta = await c.fetchOne(uid, { uid: true, envelope: true, flags: true, bodyStructure: true, internalDate: true, threadId: true }, { uid: true });
      if (!meta) throw new Error('message not found (it may have been moved or deleted)');
      // whole, in one FETCH: download() asks for it 64 KB a command (a mail with an 8 MB attachment was some 170
      // round trips, a minute and more, with what else the connection had to do waiting behind it), and with larger
      // windows it takes a server's shorter answer for the end
      const whole = await c.fetchOne(uid, { uid: true, source: true }, { uid: true });
      if (!whole?.source) throw new Error('message not found (it may have been moved or deleted)');
      const source = whole.source;
      const parsed = await simpleParser(source);
      if (meta.bodyStructure && onePart(meta.bodyStructure)) for (const at of parsed.attachments || []) at.partId ||= '1'; // (as #read names it)
      const item = listItem(path, String(mailbox.uidValidity), meta);
      return withSource ? { item, parsed, source } : { item, parsed };
    });
  }

  /** Bulk/list flag for many ids (header fetch only). Returns Map id → boolean. */
  async bulkFlags(ids) {
    const out = new Map();
    const byPath = new Map();
    for (const id of ids) {
      const { path, uidValidity, uid } = parseId(id);
      if (!byPath.has(path)) byPath.set(path, { uv: uidValidity, uids: [] });
      byPath.get(path).uids.push(uid);
    }
    for (const [path, { uv, uids }] of byPath) {
      await this.#inMailbox(path, async (c) => {
        for await (const m of c.fetch(uids.join(','), { uid: true, headers: ['list-id', 'list-unsubscribe', 'list-post', 'precedence', 'auto-submitted'] }, { uid: true })) {
          const text = String(m.headers || '').toLowerCase();
          const has = (k) => new RegExp(`^${k}:`, 'm').test(text);
          const val = (k) => (text.match(new RegExp(`^${k}:\\s*(.*)$`, 'm')) || [])[1] || '';
          const bulk = has('list-id') || has('list-unsubscribe') || has('list-post') || /bulk|list|junk/.test(val('precedence')) || (val('auto-submitted') && !/^no\b/.test(val('auto-submitted')));
          out.set(makeId(path, uv, m.uid), !!bulk);
        }
      });
    }
    return out;
  }

  /**
   * The authentication headers of many messages (a header fetch, no bodies):
   * Map id → { results, bimiSelector, msAuthAs, fromEmail } (see
   * auth-headers.js). Ids of another generation of their folder are left out.
   */
  async authHeadersOf(ids) {
    const out = new Map();
    const byPath = new Map();
    for (const id of ids) {
      let parts;
      try { parts = parseId(id); } catch { continue; } // not an id of this server: left out, the others answered
      const { path, uidValidity, uid } = parts;
      if (!byPath.has(path)) byPath.set(path, { uv: uidValidity, uids: [] });
      byPath.get(path).uids.push(uid);
    }
    for (const [path, { uv, uids }] of byPath) {
      await this.#inMailbox(path, async (c, mailbox) => {
        if (String(mailbox.uidValidity) !== uv) return;
        for await (const m of c.fetch(uids.join(','), { uid: true, envelope: true, headers: AUTH_HEADER_NAMES }, { uid: true })) {
          out.set(makeId(path, uv, m.uid), { ...authHeadersFrom(headerPairs(m.headers)), fromEmail: String(m.envelope?.from?.[0]?.address || '').toLowerCase() });
        }
      });
    }
    return out;
  }

  /**
   * Whom my newest sent mail went to: [{ to: [addresses, lower case], sent: ISO }] for the newest `limit` (at
   * most 200) of Sent, To only, automatic answers left out (by Auto-Submitted, X-Autoreply, or their subject).
   */
  async sentTo({ limit = 200 } = {}) {
    const path = await this.#folder('sent');
    return this.#inMailbox(path, async (c, mailbox) => {
      const n = Number(mailbox.exists) || 0;
      if (!n) return [];
      const out = [];
      for await (const m of c.fetch(`${Math.max(1, n - Math.min(200, limit) + 1)}:*`, { envelope: true, internalDate: true, headers: AUTO_REPLY_HEADERS })) {
        const env = m.envelope || {};
        if (isAutoReply(env.subject, m.headers ? m.headers.toString('utf8') : '')) continue;
        const to = [...new Set((env.to || []).map((a) => String(a.address || '').toLowerCase()).filter((e) => e.includes('@')))];
        const at = env.date || m.internalDate;
        if (to.length) out.push({ to, sent: at && !isNaN(new Date(at)) ? new Date(at).toISOString() : new Date(0).toISOString() });
      }
      return out;
    });
  }

  async #append(path, raw, flags) {
    const c = await this.#conn();
    const r = await c.append(path, raw, flags);
    this.#changed();
    if (!r || !r.uid) throw new Error('append failed: the server did not return the new uid');
    return makeId(path, String(r.uidValidity), r.uid);
  }

  /** The From of mail written here: the address, with the name the account writes as when one is set (displayName). */
  get #from() {
    const name = displayNameOf(this.acct);
    return name ? { name, address: this.self } : this.self;
  }

  /** The From a draft keeps when it is written again: its own when it is from another address (an alias), else the account's as it is now. */
  #fromOf(parsed) {
    const was = addrs(parsed.from)[0];
    if (!was?.email || was.email.toLowerCase() === this.self) return this.#from;
    return was.name ? { name: was.name, address: was.email } : was.email;
  }

  async #appendDraft(mail) {
    return this.#append(await this.#folder('drafts'), await compose(mail, { keepBcc: true }), ['\\Draft', '\\Seen']); // a draft remembers its Bcc
  }

  async #rewriteDraft(id, mutate) {
    const { path, uid } = parseId(id);
    const { parsed } = await this.#fetchParsed(path, uid);
    const mail = {
      from: this.#fromOf(parsed),
      to: addrs(parsed.to).map((a) => a.email),
      cc: addrs(parsed.cc).map((a) => a.email),
      bcc: addrs(parsed.bcc).map((a) => a.email),
      subject: parsed.subject || '',
      text: parsed.text || undefined,
      html: parsed.html || undefined,
      inReplyTo: parsed.inReplyTo || undefined,
      references: Array.isArray(parsed.references) ? parsed.references.join(' ') : parsed.references || undefined,
      attachments: (parsed.attachments || []).map((a) => ({ filename: a.filename, content: a.content, contentType: a.contentType, cid: a.cid }))
    };
    mutate(mail);
    const newId = await this.#appendDraft(mail);
    await this.#delete(path, uid);
    return newId;
  }

  async #delete(path, uid) {
    const out = await this.#inMailbox(path, (c) => c.messageDelete(uid, { uid: true }), { sure: true });
    this.#changed();
    return out;
  }

  async #smtpSend(raw, envelope) {
    const s = this.acct.smtp || {};
    if (!s.host) throw new Error(`account "${this.acct.name}": smtp.host is not set — sending needs SMTP`);
    const transport = nodemailer.createTransport({
      host: s.host,
      port: Number(s.port || 587),
      secure: !!s.secure,
      // not encrypted from the start: encrypted by STARTTLS, or nothing is sent (set for accounts added from the panel)
      requireTLS: !s.secure && !!s.requireTLS,
      auth: { user: this.creds.username || this.acct.email, pass: this.creds.password },
      tls: s.rejectUnauthorized === false ? { rejectUnauthorized: false } : undefined
    });
    try {
      await transport.sendMail({ raw, envelope });
    } catch (e) {
      throw tagAuth(e);
    } finally {
      transport.close();
    }
  }
}

// --- helpers -----------------------------------------------------------------

function makeId(path, uidValidity, uid) {
  return `${encodeURIComponent(path)}/${uidValidity}/${uid}`;
}

/** A parsed message as the clients hand it out: the list item, the people, the attachments and one form of the body. */
function shaped(item, parsed, bodyType = 'Text') {
  const html = parsed.html || null;
  const text = parsed.text || (html ? stripHtml(html) : '');
  const useHtml = bodyType === 'HTML' && html;
  return {
    ...item,
    to: addrs(parsed.to),
    cc: addrs(parsed.cc),
    bcc: addrs(parsed.bcc),
    replyTo: addrs(parsed.replyTo), // where a reply goes, when not to the sender
    references: Array.isArray(parsed.references) ? parsed.references.join(' ') : parsed.references || '',
    isBulk: isBulkHeaders(parsed.headers),
    authHeaders: authHeadersOfParsed(parsed),
    attachments: (parsed.attachments || []).map((a, i) => ({
      id: attachmentId(a, i),
      name: a.filename || '(unnamed)',
      size: a.size || 0,
      contentType: a.contentType || '',
      contentId: a.cid || undefined,
      inline: a.contentDisposition === 'inline' || !!a.cid
    })),
    bodyType: useHtml ? 'HTML' : 'Text',
    body: String(useHtml ? html : text).replace(/\r\n?/g, '\n')
  };
}

/**
 * What a search found. A search the server refuses (NO, BAD: busy, throttled) comes back from imapflow as
 * `false`, not as an error: that is a failure, never "nothing there". Whoever compares a cache with the answer
 * would otherwise take a refusal for an empty folder, and drop everything it holds.
 */
function found(answer) {
  if (!Array.isArray(answer)) throw new Error('the mail server refused the search');
  return answer;
}

function parseId(id) {
  const m = String(id).match(/^(.+)\/(\d+)\/(\d+)$/);
  if (!m) throw new Error(`not an IMAP message id: ${id}`);
  return { path: decodeURIComponent(m[1]), uidValidity: m[2], uid: Number(m[3]) };
}

function attachmentId(a, i) {
  // by its part (the same whether the message was read whole or without its attachments); else, stable across
  // re-parses of the same source: content checksum, else position
  if (a.partId) return `p${a.partId}`;
  return `${i + 1}-${a.checksum || 'x'}`;
}

/** Whether an attachment is the one an id names: as attachmentId names it now, or as it named it before (by checksum). */
function isAttachment(a, i, id) {
  return attachmentId(a, i) === id || `${i + 1}-${a.checksum || 'x'}` === id;
}

/** Whether a message is of one part (its root is no multipart: a forwarded message, nested or not, is one). */
const onePart = (root) => !String(root?.type || 'text/plain').toLowerCase().startsWith('multipart/');

/** The parts of a FETCH's answer by name, in lower case (a server says 1.MIME or 1.mime). */
function partsMap(got) {
  const out = new Map();
  for (const [k, v] of got?.bodyParts || []) out.set(String(k).toLowerCase(), v);
  return out;
}

/** A header block without its closing blank line. */
function withoutEnd(head) {
  let end = head.length;
  while (end > 0 && (head[end - 1] === 0x0a || head[end - 1] === 0x0d)) end--;
  return head.subarray(0, end);
}

/** A message's leaves (imapflow's bodyStructure), by part: { part, type, size, filename, id }. A forwarded message is one leaf. */
export function leavesOf(root) {
  const out = new Map();
  const walk = (node) => {
    const type = String(node?.type || 'text/plain').toLowerCase();
    if (type.startsWith('multipart/') && Array.isArray(node.childNodes)) { for (const child of node.childNodes) walk(child); return; }
    out.set(node.part || '1', { part: node.part || '1', type, size: Number(node.size) || 0, encoding: String(node.encoding || '').toLowerCase(), filename: node.dispositionParameters?.filename || node.parameters?.name || '', id: typeof node.id === 'string' ? node.id : '' });
  };
  if (root) walk(root);
  return out;
}

/** The leaves whose bodies a read without attachments still fetches, whatever their size: texts (and the reports a bounce carries); with `pictures`, inline pictures. */
const keepsBody = (leaf, pictures) => leaf.type.startsWith('text/') || /^message\/(delivery-status|disposition-notification|feedback-report)$/.test(leaf.type)
  || (pictures && leaf.id && leaf.type.startsWith('image/'));

/**
 * A message put back together without the bodies of its attachments: its headers, its structure's boundaries,
 * every part's own headers, the bodies of its texts. { source, leaves, fetched } (fetched: the parts whose
 * bodies are in), or null when the structure cannot be rebuilt (then it is read whole).
 */
export async function skeletonOf(c, uid, meta, { pictures = false } = {}) {
  const root = meta.bodyStructure;
  if (!root) return null;
  const leaves = leavesOf(root);
  const single = onePart(root);
  const fetched = new Set([...leaves.values()].filter((l) => keepsBody(l, pictures)).map((l) => l.part));
  const heads = [];
  const walk = (node, top) => {
    const type = String(node?.type || 'text/plain').toLowerCase();
    if (!top) heads.push(`${node.part}.MIME`);
    if (type.startsWith('multipart/') && Array.isArray(node.childNodes)) for (const child of node.childNodes) walk(child, false);
  };
  if (!single) walk(root, true);
  const got = await c.fetchOne(uid, { uid: true, bodyParts: [...heads, ...fetched] }, { uid: true });
  const parts = partsMap(got);
  const CRLF = Buffer.from('\r\n');
  const chunks = [];
  let broken = false;
  const render = (node, head) => {
    const type = String(node?.type || 'text/plain').toLowerCase();
    if (!Buffer.isBuffer(head)) { broken = true; return; }
    chunks.push(withoutEnd(head), CRLF, CRLF);
    if (type.startsWith('multipart/') && Array.isArray(node.childNodes)) {
      const boundary = node.parameters?.boundary;
      if (!boundary) { broken = true; return; }
      for (const child of node.childNodes) {
        chunks.push(Buffer.from(`--${boundary}\r\n`));
        render(child, parts.get(`${child.part}.mime`));
        chunks.push(CRLF);
      }
      chunks.push(Buffer.from(`--${boundary}--\r\n`));
      return;
    }
    const part = node.part || '1';
    if (fetched.has(part)) {
      const body = parts.get(part);
      if (!Buffer.isBuffer(body)) { broken = true; return; } // a text the structure has and the server did not give
      chunks.push(body);
    }
  };
  render(root, meta.headers);
  if (broken) throw new Error('the mail server did not give every part of that message');
  return { source: Buffer.concat(chunks), leaves, fetched };
}

function leaf(box) {
  return String(box.path).split(box.delimiter || '/').pop();
}

function listItem(path, uv, m) {
  const env = m.envelope || {};
  const from = (env.from && env.from[0]) || (env.sender && env.sender[0]) || {};
  const flags = m.flags || new Set();
  return {
    id: makeId(path, uv, m.uid),
    changeKey: '',
    subject: env.subject || '',
    fromName: from.name || '',
    fromEmail: from.address || '',
    displayTo: (env.to || []).map((a) => a.name || a.address).filter(Boolean).join('; '),
    // who it went to (To and Cc), each name with its address: who a message of mine went to, without reading it
    toPeople: [...(env.to || []), ...(env.cc || [])].filter((a) => a.address).map((a) => ({ name: a.name || '', email: String(a.address).toLowerCase() })),
    isRead: flags.has('\\Seen'),
    isFlagged: flags.has('\\Flagged'),
    hasAttachments: hasAttachment(m.bodyStructure),
    received: (m.internalDate || env.date || new Date(0)).toISOString(),
    // Gmail's X-GM-THRID (or THREADID where the server has OBJECTID): the server's own threading
    conversationId: m.threadId ? String(m.threadId) : '',
    messageId: env.messageId || '',
    inReplyTo: env.inReplyTo || ''
  };
}

function isBulkHeaders(headers) {
  const get = (k) => { const v = headers?.get?.(k); return v == null ? '' : String(typeof v === 'object' && v.text != null ? v.text : v).toLowerCase(); };
  // mailparser folds every List-* header into one `list` entry: { id, unsubscribe, post, … }
  const list = headers?.get?.('list');
  if (list && typeof list === 'object' && (list.id || list.unsubscribe || list.post || list.help)) return true;
  if (headers?.has?.('list-id') || headers?.has?.('list-unsubscribe')) return true;
  if (/bulk|list|junk/.test(get('precedence'))) return true;
  const auto = get('auto-submitted');
  if (auto && auto !== 'no') return true;
  return false;
}

function hasAttachment(node) {
  if (!node) return false;
  if (node.disposition === 'attachment') return true;
  const type = String(node.type || '').toLowerCase();
  if (!type.startsWith('multipart/') && !type.startsWith('text/') && (node.dispositionParameters?.filename || node.parameters?.name)) return true;
  return (node.childNodes || []).some(hasAttachment);
}

function addrs(list) {
  const values = Array.isArray(list) ? list.flatMap((l) => l.value || []) : list?.value || [];
  // a group ("Team: Ann <ann@x>, Bob <bob@x>;") is its members
  return values.flatMap((a) => (Array.isArray(a.group) ? a.group : [a])).map((a) => ({ name: a.name || '', email: a.address || '' }));
}

function uniq(list) {
  return Array.from(new Set(list.map((s) => s.toLowerCase())));
}

function escapeHtml(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function stripHtml(html) {
  return String(html)
    .replace(/<style[\s\S]*?<\/style>|<script[\s\S]*?<\/script>/gi, '')
    .replace(/<br\s*\/?>|<\/p>|<\/div>|<\/tr>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function compose(mail, { keepBcc = false } = {}) {
  const compiled = new MailComposer({ ...mail, attachments: mail.attachments || [] }).compile();
  compiled.keepBcc = keepBcc;
  return compiled.build();
}

/** A raw message without its Bcc header (folded lines included); the body is untouched. */
export function withoutBcc(raw) {
  const buf = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
  const crlf = buf.indexOf('\r\n\r\n');
  const lf = buf.indexOf('\n\n');
  const end = crlf >= 0 && (lf < 0 || crlf < lf) ? crlf : lf;
  if (end < 0) return buf;
  const head = buf.subarray(0, end).toString('latin1').replace(/^bcc:[^\r\n]*(?:\r?\n[ \t][^\r\n]*)*(?:\r?\n|$)/gim, '').replace(/\r?\n$/, '');
  return Buffer.concat([Buffer.from(head, 'latin1'), buf.subarray(end)]);
}

/** The end of a raw message's headers (where the blank line starts), or -1. */
function headEnd(buf) {
  const crlf = buf.indexOf('\r\n\r\n');
  const lf = buf.indexOf('\n\n');
  return crlf >= 0 && (lf < 0 || crlf < lf) ? crlf : lf;
}

/** A Message-ID for mail from `from`: random, at the sender's domain. */
export function newMessageId(from) {
  const named = /@([^@\s<>]+?)\.?$/.exec(String(from || '').trim())?.[1] || '';
  const domain = /^[a-z0-9-]+(\.[a-z0-9-]+)*$/.test(domainToASCII(named)) ? domainToASCII(named) : 'localhost'; // (a name in other letters in its ASCII form)
  return `<${randomUUID()}@${domain}>`;
}

/** A raw message under another Message-ID (its own, folded lines included, is replaced; one is added where there was none); the rest is untouched. */
export function withMessageId(raw, id) {
  const buf = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
  const end = headEnd(buf);
  if (end < 0) return buf;
  const nl = buf[end] === 0x0d ? '\r\n' : '\n';
  const lines = buf.subarray(0, end).toString('latin1').replace(/^message-id[ \t]*:[^\r\n]*(?:\r?\n[ \t][^\r\n]*)*(?:\r?\n|$)/gim, '').replace(/\r?\n$/, '');
  return Buffer.concat([Buffer.from(`${lines}${nl}Message-ID: ${id}`, 'latin1'), buf.subarray(end)]);
}

/** A folder kept selected from a use before is selected anew when it was selected longer ago than this (see #inMailbox). */
const RESELECT_MS = 15_000;
/** How many times mail was put in, moved or removed from this process, by account: a connection that selected its folder before the last of them sees it anew. */
const changedHere = new Map();
/** A message bigger than this is read without the bytes of its attachments (they are fetched when asked for). */
const LIGHT_OVER = 512 * 1024;
