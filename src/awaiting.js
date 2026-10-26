// "Who am I keeping waiting?" — threads whose last message is theirs and I
// never answered — and thread lookup by message id.
//
// Threads are keyed by Exchange ConversationId when there is one, else by the
// Message-ID / In-Reply-To chain, else by the normalized subject. Inbound mail
// comes from the encrypted cache (headers, recipients, bulk flag and body
// are there for everything the daemon has seen); my own messages come from
// Sent Items on the server, plus my own mail found in the inbox. Nothing
// here needs a model: the judgment stays with whoever reads the result.

import { withAuthRetry, selectAccounts, readMessage } from './client.js';
import * as cache from './cache.js';
import { loadConfig } from './config.js';

const MAX_BODY_FETCHES = 40; // inbound candidates without a cached body/recipients → one GetItem each, at most
const SENT_PAGE = 100;
const SENT_MAX = 1000;

const BULK_SENDER = /(^|[.\-_])(no[-_.]?reply|do[-_.]?not[-_.]?reply|donotreply|noreply|notifications?|notify|alerts?|alerting|newsletter|news|marketing|mailer|bounce|mailer-daemon|postmaster|digest|updates?|billing|receipts?|invoices?|orders?|shipping|delivery|informeddelivery|info|hello|team|support|security|service|services|customerservice|customercare|account|accounts|register|verify|verification|member|members|membership|rewards|offers|promotions?|calendar-notification|jira|github|gitlab|slack|zoom|linkedin|automated|robot|bot|system|admin)([.\-_@]|$)/i;
const BULK_DOMAIN = /^(e|em|email|mail|news|newsletter|info|notify|notifications?|alerts?|marketing|promo|go|reply|bounce|list|lists|t|click|links?)\./i; // e.pnc.com, email.apple.com, news.x.com…
const BULK_BODY = /\b(unsubscribe|opt[- ]?out|manage (your )?(email )?preferences|se d[ée]sabonner|d[ée]sinscri|ne pas r[ée]pondre|do not reply|don't reply|this is an automated (message|email|notification)|automated message|this mailbox is not monitored|boîte (mail )?non surveillée)\b/i;
const CALENDAR_SUBJECT = /^(invitation|accepted|tentative|declined|cancell?ed|updated invitation|réunion|invitation mise à jour|accepté|refusé)\s*[:(]/i;
const ASK_PATTERNS = [
  /\?/,
  /\b(can|could|would|will) you\b/i, /\bplease\b/i, /\blet me know\b/i, /\bdeadline\b/i, /\bby (eod|end of day|tomorrow|monday|tuesday|wednesday|thursday|friday)\b/i,
  /\bthoughts\??/i, /\bwaiting (for|on) (you|your)\b/i, /\bfollow(ing)?[ -]up\b/i, /\bremind(er)?\b/i, /\b(asap|urgent)\b/i,
  /\b(peux|pouvez|pourrais|pourriez)[- ]?(tu|vous)\b/i, /\bmerci de\b/i, /\bs'il (te|vous) pla[iî]t\b/i, /\bstp\b|\bsvp\b/i,
  /\btiens[- ]moi au courant\b|\btenez[- ]moi au courant\b/i, /\bdate limite\b|\béchéance\b/i, /\bc'est urgent\b|\burgent\b/i, /\brelance\b/i, /\bqu'en (penses|pensez)[- ](tu|vous)\b/i
];

export function normalizeSubject(s) {
  return String(s || '').replace(/^\s*((re|fw|fwd|tr|aw|wg)\s*:\s*)+/i, '').replace(/\s+/g, ' ').trim().toLowerCase();
}

export function askedSomething(text) {
  const t = unquoted(text);
  return ASK_PATTERNS.some((re) => re.test(t));
}

/** Drop quoted replies and signatures from a plain-text body. */
export function unquoted(text) {
  const lines = String(text || '').replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  for (const l of lines) {
    if (/^\s*>/.test(l)) break;
    if (/^\s*(On .{3,200}? wrote:|Le .{3,200}? a écrit\s*:|-{3,}\s*Original Message\s*-{3,}|_{10,}|From:\s.+|De\s?:\s.+)\s*$/i.test(l)) break;
    if (/^\s*--\s*$/.test(l)) break;
    out.push(l);
  }
  return out.join('\n').trim();
}

export function snippet(text, n = 200) {
  const t = unquoted(text).replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
}

function looksBulk(m) {
  if (m.isBulk === true) return true;
  const e = String(m.fromEmail || '').toLowerCase();
  if (!e) return true;
  const [local, domain = ''] = e.split('@');
  if (BULK_SENDER.test(local) || BULK_SENDER.test(e) || BULK_DOMAIN.test(domain)) return true;
  if (m.bodyText && BULK_BODY.test(unquoted(m.bodyText))) return true;
  return false;
}

function sameAddress(a, b) { return !!a && !!b && String(a).toLowerCase() === String(b).toLowerCase(); }

/** Threads in `messages` (inbound + mine), keyed as described above. */
export function groupThreads(messages) {
  const byMsgId = new Map();
  for (const m of messages) if (m.messageId) byMsgId.set(m.messageId, m);
  const root = (m, seen = new Set()) => { // follow In-Reply-To up to the first message we know
    if (!m.inReplyTo || !byMsgId.has(m.inReplyTo) || seen.has(m.inReplyTo)) return m;
    seen.add(m.inReplyTo);
    return root(byMsgId.get(m.inReplyTo), seen);
  };
  const keyOf = (m) => {
    if (m.conversationId) return 'c:' + m.conversationId;
    const r = root(m);
    if (r.messageId && r !== m) return 'm:' + r.messageId;
    if (m.inReplyTo && !byMsgId.has(m.inReplyTo)) return 's:' + normalizeSubject(m.subject); // reply to something we never saw
    if (r.messageId && messages.some((o) => o !== m && o.inReplyTo === m.messageId)) return 'm:' + r.messageId;
    return 's:' + normalizeSubject(m.subject);
  };
  const threads = new Map();
  for (const m of messages) {
    const k = keyOf(m);
    if (!threads.has(k)) threads.set(k, []);
    threads.get(k).push(m);
  }
  for (const list of threads.values()) list.sort((a, b) => new Date(a.received) - new Date(b.received));
  return threads;
}

/** Sent Items since `sinceIso`, paged, as list items (fromMe: true). */
async function fetchSent(account, sinceIso, onError) {
  const out = [];
  for (let offset = 0; offset < SENT_MAX; offset += SENT_PAGE) {
    let page;
    try {
      page = await withAuthRetry((c) => c.findInbox({ folder: 'sent', sinceIso, limit: SENT_PAGE, offset }), null, account);
    } catch (e) {
      onError?.(account, e);
      break;
    }
    out.push(...page.map((m) => ({ ...m, fromMe: true })));
    if (page.length < SENT_PAGE) break;
  }
  return out;
}

/**
 * awaitingReply({ account?, days = 28, limit = 50, includeCc = true, since? })
 * → { threads: [...], scanned: { inbound, sent }, cursor }
 */
export async function awaitingReply({ account, days = 28, limit = 50, includeCc = true, since, onError } = {}) {
  const names = selectAccounts(account);
  const sinceIso = new Date(Date.now() - Math.max(1, days) * 86400e3).toISOString();
  const results = [];
  let scannedInbound = 0;
  let scannedSent = 0;
  for (const name of names) {
    let me = '';
    try { me = await withAuthRetry((c) => c.selfEmail(), null, name); } catch (e) { onError?.(name, e); continue; }
    const aliases = new Set([me, ...(loadConfig().accounts[name]?.aliases || []).map((a) => String(a).toLowerCase())]);
    const isMe = (addr) => aliases.has(String(addr || '').toLowerCase());

    // inbound: the cache first (complete for what the daemon has seen), else the server
    let inbound = [];
    if (cache.cachedAccounts().includes(name)) inbound = cache.cachedSince(name, sinceIso);
    if (!inbound.length) {
      for (let offset = 0; offset < 1000; offset += 100) {
        let page = [];
        try { page = await withAuthRetry((c) => c.findInbox({ sinceIso, limit: 100, offset }), null, name); } catch (e) { onError?.(name, e); break; }
        inbound.push(...page);
        if (page.length < 100) break;
      }
    }
    scannedInbound += inbound.length;
    const sent = await fetchSent(name, sinceIso, onError);
    scannedSent += sent.length;

    const all = [...inbound.map((m) => ({ ...m, fromMe: isMe(m.fromEmail) })), ...sent];
    const threads = groupThreads(all);
    const candidates = [];
    for (const [key, list] of threads) {
      const last = list[list.length - 1];
      if (last.fromMe) continue;
      if (CALENDAR_SUBJECT.test(last.subject || '')) continue;
      if (looksBulk(last)) continue; // headers prove bulk; the sender/body heuristics catch the automated mail that carries none
      if (since && new Date(last.received) <= new Date(since)) continue;
      candidates.push({ key, list, last });
    }
    // bulk flag from the headers for candidates the cache has not judged yet (one batched call, persisted)
    const unjudged = candidates.map((c) => c.last).filter((m) => m.isBulk == null && m.id);
    if (unjudged.length) {
      try {
        const flags = await withAuthRetry((c) => c.bulkFlags(unjudged.map((m) => m.id)), null, name);
        for (const m of unjudged) if (flags.has(m.id)) { m.isBulk = flags.get(m.id); try { cache.setBulk(m.id, m.isBulk); } catch {} }
      } catch (e) { onError?.(name, e); }
    }
    // recipients + body for the rest the cache has no body for (bounded)
    let fetches = 0;
    for (const c of candidates) {
      const m = c.last;
      if (m.isBulk === true || (m.to && m.cc) || fetches >= MAX_BODY_FETCHES) continue;
      fetches++;
      try {
        const full = await readMessage(m.id, { bodyType: 'Text' });
        Object.assign(m, { to: full.to || [], cc: full.cc || [], isBulk: full.isBulk ?? m.isBulk, bodyText: full.body });
      } catch (e) { onError?.(name, e); }
    }
    for (const { list, last } of candidates) {
      if (looksBulk(last)) continue; // re-check: the body may have arrived with the fetch
      const inTo = (last.to || []).some((r) => isMe(r.email));
      const inCc = (last.cc || []).some((r) => isMe(r.email));
      let addressed = inTo ? 'to' : inCc ? 'cc' : null;
      if (!addressed && last.to == null) addressed = 'unknown'; // recipients never fetched (budget) — keep, flagged
      if (!addressed) continue; // a list or a bulk sender: I am not a recipient
      if (addressed === 'cc' && !includeCc) continue;
      const mine = list.filter((m) => m.fromMe);
      const others = new Map();
      for (const m of list) {
        if (!m.fromMe && m.fromEmail && !isMe(m.fromEmail)) others.set(m.fromEmail.toLowerCase(), m.fromName || m.fromEmail);
        for (const r of [...(m.to || []), ...(m.cc || [])]) if (r.email && !isMe(r.email)) others.set(r.email.toLowerCase(), r.name || r.email);
      }
      const body = last.bodyText || '';
      results.push({
        account: name,
        threadId: last.conversationId || list[0].messageId || normalizeSubject(last.subject),
        subject: last.subject || '(no subject)',
        lastMessageId: last.id,
        changeKey: last.changeKey || '',
        from: last.fromName || last.fromEmail,
        fromEmail: last.fromEmail,
        received: last.received,
        addressed,
        participants: [...others].map(([email, name]) => ({ name, email })).slice(0, 12),
        messages: list.length,
        theirsSinceMyLast: list.slice(mine.length ? list.lastIndexOf(mine[mine.length - 1]) + 1 : 0).filter((m) => !m.fromMe).length,
        myLastReplyAt: mine.length ? mine[mine.length - 1].received : null,
        isRead: last.isRead,
        askedSomething: askedSomething(body),
        snippet: snippet(body)
      });
    }
  }
  results.sort((a, b) => new Date(b.received) - new Date(a.received));
  const threads = results.slice(0, Math.max(1, limit));
  return {
    threads,
    scanned: { inbound: scannedInbound, sent: scannedSent, days },
    cursor: results.length ? results[0].received : since || sinceIso
  };
}

/**
 * getThread({ id?, subject?, days = 14, account?, limit = 50 }) → messages of
 * one thread across Inbox and Sent, oldest first. With `id`, the thread is the
 * message's ConversationId (Exchange) or Message-ID chain (IMAP); subject
 * matching is the fallback and the only option without an id.
 */
export async function getThread({ id, subject, days = 14, account, limit = 50, onError } = {}) {
  const span = Math.min(90, Math.max(1, days));
  let seed = null;
  if (id) {
    seed = await readMessage(id, { bodyType: 'Text' });
    subject = seed.subject;
    account = seed.account || account || id.split(':')[0];
  }
  if (!subject) throw new Error('getThread: pass id or subject');
  const normalized = normalizeSubject(subject);
  const sinceIso = new Date(Date.now() - span * 86400e3).toISOString();
  const names = selectAccounts(account);
  const found = [];
  for (const name of names) {
    for (const folder of ['inbox', 'sent']) {
      try {
        const live = folder !== 'inbox';
        const items = await withAuthRetry((c) => c.findInbox({ folder, subjectContains: normalized, sinceIso, limit: 100, live }), null, name);
        found.push(...items.map((m) => ({ ...m, folder })));
      } catch (e) { onError?.(name, e); }
    }
  }
  let items = found.filter((m) => normalizeSubject(m.subject) === normalized);
  if (seed) {
    const sameConv = seed.conversationId ? items.filter((m) => m.conversationId === seed.conversationId) : [];
    if (sameConv.length) items = sameConv;
    else if (!seed.conversationId) {
      const threads = groupThreads([seed, ...items]);
      for (const list of threads.values()) if (list.some((m) => m.id === seed.id)) { items = list.filter((m) => m.id !== seed.id || m.folder); break; }
    }
    if (!items.some((m) => m.id === seed.id)) items.push({ ...seed, folder: 'inbox' });
  }
  const seen = new Set();
  items = items.filter((m) => !seen.has(m.id) && seen.add(m.id));
  items.sort((a, b) => new Date(a.received) - new Date(b.received));
  return items.slice(-limit);
}
