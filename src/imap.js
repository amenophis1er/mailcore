// IMAP (+ SMTP for sending) backend implementing the MailClient contract
// documented in client.js. Uses imapflow for IMAP, mailparser to read
// messages, nodemailer to build MIME and to send.
//
// Ids are "<mailbox>/<uidvalidity>/<uid>" (mailbox URI-encoded), so a
// listing from any folder routes back to the right message, and a mailbox
// reset (new UIDVALIDITY) never collides with old ids in the seen-set.
// Drafts are immutable in IMAP: an edit appends a new message and deletes
// the old one, so updateDraft/addAttachment return the NEW id as changeKey.

import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import nodemailer from 'nodemailer';
import MailComposer from 'nodemailer/lib/mail-composer';

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

export function authError(e) {
  return !!e && (e.authenticationFailed === true || e.code === 'MAIL_AUTH' || e.code === 'EAUTH' ||
    /AUTHENTICATIONFAILED|Invalid credentials|LOGIN failed/i.test(String(e.responseText || e.message || '')));
}

function tagAuth(e) {
  if (authError(e)) e.code = 'MAIL_AUTH';
  return e;
}

export class ImapClient {
  changeKeyIsId = true;

  constructor(acct, creds) {
    this.acct = acct;
    this.creds = creds;
    this.self = (acct.email || (String(creds.username).includes('@') ? creds.username : '')).toLowerCase();
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
    const c = new ImapFlow(imapOptions(this.acct, this.creds));
    c.on('error', () => {}); // surfaced through the awaiting command instead
    try {
      await c.connect();
    } catch (e) {
      throw tagAuth(e);
    }
    this.client = c;
    return c;
  }

  async close() {
    const c = this.client;
    this.client = null;
    if (c) { try { await c.logout(); } catch { try { c.close(); } catch {} } }
  }

  async #inMailbox(path, fn) {
    const c = await this.#conn();
    const lock = await c.getMailboxLock(path);
    try {
      return await fn(c, c.mailbox);
    } finally {
      lock.release();
    }
  }

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
    return this.#inMailbox(path, async (c, mailbox) => {
      const uv = String(mailbox.uidValidity);
      const query = {};
      if (opts.unreadOnly) query.seen = false;
      if (opts.senderContains) query.from = opts.senderContains;
      if (opts.subjectContains) query.subject = opts.subjectContains;
      if (opts.sinceIso) query.since = new Date(opts.sinceIso);
      if (opts.untilIso) query.before = new Date(new Date(opts.untilIso).getTime() + 86400e3); // BEFORE is exclusive, by day
      if (opts.fromMe) query.from = await this.selfEmail();
      if (opts.toContains) query.or = [{ to: opts.toContains }, { cc: opts.toContains }];
      const texts = Array.isArray(opts.text) ? opts.text : opts.text ? [opts.text] : [];
      if (texts.length === 1) query.text = texts[0];
      else if (texts.length > 1) query.and = texts.map((t) => ({ text: t }));

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
        const uids = (await c.search(query, { uid: true })) || [];
        if (uids.length === 0) return [];
        uids.sort((a, b) => a - b);
        const page = uids.slice(0, uids.length - offset).slice(-want);
        if (page.length === 0) return [];
        range = page.join(',');
      }
      const items = [];
      for await (const m of c.fetch(range, { uid: true, envelope: true, flags: true, bodyStructure: true, internalDate: true }, { uid: byUid })) {
        items.push(listItem(path, uv, m));
      }
      items.sort((a, b) => new Date(b.received) - new Date(a.received));
      const filtered = opts.hasAttachments ? items.filter((i) => i.hasAttachments) : items;
      return filtered.slice(0, max);
    });
  }

  async getMessage(id, { bodyType = 'Text' } = {}) {
    const { path, uid } = parseId(id);
    const { item, parsed } = await this.#fetchParsed(path, uid);
    const html = parsed.html || null;
    const text = parsed.text || (html ? stripHtml(html) : '');
    const useHtml = bodyType === 'HTML' && html;
    return {
      ...item,
      to: addrs(parsed.to),
      cc: addrs(parsed.cc),
      references: Array.isArray(parsed.references) ? parsed.references.join(' ') : parsed.references || '',
      isBulk: isBulkHeaders(parsed.headers),
      attachments: (parsed.attachments || []).map((a, i) => ({
        id: attachmentId(a, i),
        name: a.filename || '(unnamed)',
        size: a.size || 0,
        contentType: a.contentType || '',
        inline: a.contentDisposition === 'inline' || !!a.cid
      })),
      bodyType: useHtml ? 'HTML' : 'Text',
      body: String(useHtml ? html : text).replace(/\r\n?/g, '\n')
    };
  }

  async draftReply(id, changeKey, newBodyText, { bodyType = 'Text' } = {}) {
    return this.draftReplyAll(id, changeKey, newBodyText, { all: false, bodyType });
  }

  async draftReplyAll(id, _changeKey, newBodyText, { all = true, bodyType = 'Text' } = {}) {
    const { path, uid } = parseId(id);
    const { parsed } = await this.#fetchParsed(path, uid);
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
      from: this.self,
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

  async createMessage({ to = [], cc = [], subject = '', body = '', bodyType = 'Text', send = false }) {
    const html = bodyType === 'HTML';
    const mail = { from: this.self, to, cc, subject, text: html ? stripHtml(body) : body, html: html ? body : undefined };
    if (!send) {
      const draftId = await this.#appendDraft(mail);
      return { sent: false, draftId, changeKey: draftId };
    }
    const raw = await compose(mail);
    await this.#smtpSend(raw, { from: this.self, to: [...to, ...cc] });
    const sentId = await this.#append(await this.#folder('sent'), raw, ['\\Seen']);
    return { sent: true, draftId: sentId, changeKey: sentId };
  }

  async updateDraft({ id, changeKey, subject, body, bodyType = 'Text', to, cc }) {
    if (subject === undefined && body === undefined && to === undefined && cc === undefined) {
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
    return { attachmentId: name, changeKey: draftId };
  }

  async sendItem(id, changeKey) {
    const { path, uid } = parseId(changeKey || id);
    const { parsed, source } = await this.#fetchParsed(path, uid, true);
    const to = [...addrs(parsed.to), ...addrs(parsed.cc), ...addrs(parsed.bcc)].map((a) => a.email).filter(Boolean);
    if (to.length === 0) throw new Error('sendItem: the draft has no recipients');
    const from = addrs(parsed.from)[0]?.email || this.self;
    await this.#smtpSend(source, { from, to });
    await this.#append(await this.#folder('sent'), source, ['\\Seen']);
    await this.#delete(path, uid);
    return true;
  }

  /** Download one attachment: attachmentId as listed by getMessage (the message is re-fetched and parsed). */
  async getAttachment(attId, messageId) {
    if (!messageId) throw new Error('getAttachment: the message id is required for IMAP');
    const { path, uid } = parseId(messageId);
    const { parsed } = await this.#fetchParsed(path, uid);
    const list = parsed.attachments || [];
    const a = list.find((x, i) => attachmentId(x, i) === attId) || list.find((x) => x.filename === attId);
    if (!a) throw new Error(`attachment "${attId}" not found on this message`);
    return { name: a.filename || 'attachment', contentType: a.contentType || 'application/octet-stream', content: a.content };
  }

  async deleteItem(id, changeKey) {
    const { path, uid } = parseId(changeKey || id);
    const trash = await this.#folder('trash');
    await this.#inMailbox(path, async (c) => {
      if (path === trash) await c.messageDelete(uid, { uid: true });
      else await c.messageMove(uid, trash, { uid: true });
    });
    return true;
  }

  async markRead(id, changeKey, isRead = true) {
    const { path, uid } = parseId(changeKey || id);
    await this.#inMailbox(path, async (c) => {
      if (isRead) await c.messageFlagsAdd(uid, ['\\Seen'], { uid: true });
      else await c.messageFlagsRemove(uid, ['\\Seen'], { uid: true });
    });
    return true;
  }

  // --- internals ------------------------------------------------------------

  async #fetchParsed(path, uid, withSource = false) {
    return this.#inMailbox(path, async (c, mailbox) => {
      const meta = await c.fetchOne(uid, { uid: true, envelope: true, flags: true, bodyStructure: true, internalDate: true }, { uid: true });
      if (!meta) throw new Error('message not found (it may have been moved or deleted)');
      const { content } = await c.download(uid, undefined, { uid: true });
      const source = await readAll(content);
      const parsed = await simpleParser(source);
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

  async #append(path, raw, flags) {
    const c = await this.#conn();
    const r = await c.append(path, raw, flags);
    if (!r || !r.uid) throw new Error('append failed: the server did not return the new uid');
    return makeId(path, String(r.uidValidity), r.uid);
  }

  async #appendDraft(mail) {
    return this.#append(await this.#folder('drafts'), await compose(mail), ['\\Draft', '\\Seen']);
  }

  async #rewriteDraft(id, mutate) {
    const { path, uid } = parseId(id);
    const { parsed } = await this.#fetchParsed(path, uid);
    const mail = {
      from: addrs(parsed.from)[0]?.email || this.self,
      to: addrs(parsed.to).map((a) => a.email),
      cc: addrs(parsed.cc).map((a) => a.email),
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
    await this.#inMailbox(path, (c) => c.messageDelete(uid, { uid: true }));
  }

  async #smtpSend(raw, envelope) {
    const s = this.acct.smtp || {};
    if (!s.host) throw new Error(`account "${this.acct.name}": smtp.host is not set — sending needs SMTP`);
    const transport = nodemailer.createTransport({
      host: s.host,
      port: Number(s.port || 587),
      secure: !!s.secure,
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

function parseId(id) {
  const m = String(id).match(/^(.+)\/(\d+)\/(\d+)$/);
  if (!m) throw new Error(`not an IMAP message id: ${id}`);
  return { path: decodeURIComponent(m[1]), uidValidity: m[2], uid: Number(m[3]) };
}

function attachmentId(a, i) {
  // stable across re-parses of the same source: content checksum, else position
  return `${i + 1}-${a.checksum || 'x'}`;
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
    isRead: flags.has('\\Seen'),
    hasAttachments: hasAttachment(m.bodyStructure),
    received: (m.internalDate || env.date || new Date(0)).toISOString(),
    conversationId: '',
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
  return values.map((a) => ({ name: a.name || '', email: a.address || '' }));
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

function compose(mail) {
  return new MailComposer({ ...mail, attachments: mail.attachments || [] }).compile().build();
}

function readAll(stream) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    stream.on('data', (c) => chunks.push(c));
    stream.on('end', () => resolve(Buffer.concat(chunks)));
    stream.on('error', reject);
  });
}
