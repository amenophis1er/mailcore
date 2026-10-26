// Local event bus. The daemon publishes mail activity two ways:
//
//  1. events.sock — live NDJSON stream (hello, newmail, match, wake, stream);
//     fire-and-forget, nothing is replayed.
//  2. http.sock   — HTTP over a Unix socket with a cursor-backed queue of
//     mail and calendar events (newmail / wake / calendar / reminder) and a
//     LONG-POLL endpoint:
//
//       GET /events?after=<cursor>&timeout=<s>&match=rules|all&account=<a>&rule=<r>&types=<t,t>
//         → { events: [...], cursor }   immediately when events exist past the
//           cursor, else when the first matching one lands, else on timeout;
//           plus { gap: true, oldest, lost } when `after` predates the oldest
//           retained event (the queue keeps the last 500): the client should
//           resync (list_unread / the agenda) rather than trust the stream
//           (events: []). match=rules (default) = mail that hit a rule.
//           Calendar events (calendar = created/updated/cancelled/deleted,
//           reminder = an event starts soon) are delivered only when `types`
//           names them, e.g. types=newmail,reminder.
//       GET /cursor → { cursor }   the latest sequence number
//
//     Sequence numbers are monotonic and persisted (events-log.json), so a
//     client can re-arm with its last cursor across daemon restarts and
//     miss nothing. From a shell: curl --unix-socket ~/.mailwatcher/http.sock
//     'http://mail/events?after=42&timeout=600'. The CLI wraps it as
//     `mailwatcher events --wait`, the MCP server as `next_event`.

import net from 'node:net';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { HOME_DIR } from './config.js';

export const EVENTS_SOCK = path.join(HOME_DIR, 'events.sock');
export const HTTP_SOCK = path.join(HOME_DIR, 'http.sock');
const LOG_PATH = path.join(HOME_DIR, 'events-log.json');
const QUEUE_MAX = 500;
const QUEUED_TYPES = new Set(['newmail', 'wake', 'calendar', 'reminder']);
const MAIL_TYPES = new Set(['newmail', 'wake']);
const MAX_WAIT_S = 3600;

/**
 * A cursor older than the oldest event still retained means events in
 * between are gone (the queue is bounded): { gap: true, oldest, lost }, else {}.
 */
export function gapInfo(after, queue, seq) {
  const oldest = queue.length ? queue[0].seq : seq + 1;
  if (after >= oldest - 1) return {};
  return { gap: true, oldest: queue.length ? oldest : null, lost: Math.min(seq, oldest - 1) - after };
}

export function startEventServer(log = () => {}) {
  const clients = new Set();

  // --- cursor-backed queue --------------------------------------------------
  let seq = 0;
  let queue = [];
  try {
    const saved = JSON.parse(fs.readFileSync(LOG_PATH, 'utf8'));
    seq = Number(saved.seq) || 0;
    queue = Array.isArray(saved.events) ? saved.events.slice(-QUEUE_MAX) : [];
  } catch {}
  const persist = () => {
    try { fs.writeFileSync(LOG_PATH, JSON.stringify({ seq, events: queue }), { mode: 0o600 }); } catch {}
  };
  const waiters = new Set(); // { filter, resolve, timer }

  const matches = (e, f) => {
    if (f.types && !f.types.includes(e.type)) return false;
    if (MAIL_TYPES.has(e.type)) {
      if (f.match !== 'all' && !e.rule) return false;
      if (f.rule && e.rule !== f.rule) return false;
    } else if (!f.types) {
      return false; // calendar/reminder: only when asked for via types=
    }
    if (f.account && e.account !== f.account) return false;
    return true;
  };
  const since = (after, f) => queue.filter((e) => e.seq > after && matches(e, f));

  // --- live NDJSON socket ---------------------------------------------------
  const server = net.createServer((sock) => {
    clients.add(sock);
    sock.on('close', () => clients.delete(sock));
    sock.on('error', () => clients.delete(sock));
    sock.write(line({ type: 'hello', service: 'mailwatcher', pid: process.pid, cursor: seq }));
  });
  server.on('error', (e) => log('event server error: ' + e.message));

  // --- HTTP long-poll over a Unix socket ------------------------------------
  const httpServer = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://mail');
    const json = (code, body) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body) + '\n'); };
    if (req.method !== 'GET') return json(405, { error: 'GET only' });
    if (url.pathname === '/cursor') return json(200, { cursor: seq });
    if (url.pathname !== '/events') return json(404, { error: 'unknown path — use /events or /cursor' });
    const q = url.searchParams;
    const types = String(q.get('types') || '').split(',').map((t) => t.trim()).filter(Boolean);
    const filter = { match: q.get('match') === 'all' ? 'all' : 'rules', account: q.get('account') || null, rule: q.get('rule') || null, types: types.length ? types : null };
    const afterRaw = q.get('after');
    const after = afterRaw == null || afterRaw === 'now' ? seq : Math.max(0, Number(afterRaw) || 0);
    const timeout = Math.min(MAX_WAIT_S, Math.max(0, Number(q.get('timeout') ?? 90) || 0));
    const limit = Math.min(100, Math.max(1, Number(q.get('limit')) || 50));

    const gap = afterRaw != null && afterRaw !== 'now' ? gapInfo(after, queue, seq) : {};

    const ready = since(after, filter);
    if (ready.length || timeout === 0) return json(200, { events: ready.slice(0, limit), cursor: ready.length ? ready[Math.min(limit, ready.length) - 1].seq : seq, ...gap });

    const w = { filter, resolve: (events) => json(200, { events, cursor: events.length ? events[events.length - 1].seq : seq, ...gap }), timer: null };
    w.timer = setTimeout(() => { waiters.delete(w); w.resolve([]); }, timeout * 1000);
    waiters.add(w);
    req.on('close', () => { clearTimeout(w.timer); waiters.delete(w); });
  });
  httpServer.on('error', (e) => log('event http error: ' + e.message));

  const inos = { events: null, http: null };
  const listen = () => {
    try { fs.unlinkSync(EVENTS_SOCK); } catch {}
    try { fs.unlinkSync(HTTP_SOCK); } catch {}
    server.listen(EVENTS_SOCK, () => {
      try { inos.events = fs.statSync(EVENTS_SOCK).ino; } catch {}
      log('event socket listening at ' + EVENTS_SOCK);
    });
    httpServer.listen(HTTP_SOCK, () => {
      try { inos.http = fs.statSync(HTTP_SOCK).ino; } catch {}
      log(`event long-poll at ${HTTP_SOCK} (cursor ${seq})`);
    });
  };
  listen();

  // If another process (a foreground `mailwatcher watch`, say) replaced the
  // socket files and left, clients would get ECONNREFUSED forever: re-bind.
  const guard = setInterval(() => {
    const cur = (p) => { try { return fs.statSync(p).ino; } catch { return null; } };
    if ((inos.events !== null && cur(EVENTS_SOCK) !== inos.events) || (inos.http !== null && cur(HTTP_SOCK) !== inos.http)) {
      log('event socket path was replaced — re-binding');
      let pending = 2;
      const done = () => { if (--pending === 0) listen(); };
      server.close(done);
      httpServer.close(done);
    }
  }, 30000);

  return {
    emit(type, data = {}) {
      const event = { ts: new Date().toISOString(), type, ...data };
      if (QUEUED_TYPES.has(type)) {
        event.seq = ++seq;
        queue.push(event);
        if (queue.length > QUEUE_MAX) queue = queue.slice(-QUEUE_MAX);
        persist();
        for (const w of Array.from(waiters)) {
          if (matches(event, w.filter)) {
            clearTimeout(w.timer);
            waiters.delete(w);
            w.resolve([event]);
          }
        }
      }
      const msg = JSON.stringify(event) + '\n';
      for (const c of clients) {
        try { c.write(msg); } catch { clients.delete(c); }
      }
    },
    cursor: () => seq,
    clientCount: () => clients.size,
    close() {
      clearInterval(guard);
      for (const w of waiters) { clearTimeout(w.timer); w.resolve([]); }
      server.close();
      httpServer.close();
      for (const c of clients) c.destroy();
      try { fs.unlinkSync(EVENTS_SOCK); } catch {}
      try { fs.unlinkSync(HTTP_SOCK); } catch {}
    }
  };
}

/**
 * Client side of the long-poll (CLI `events --wait`, MCP `next_event`).
 * Resolves { events, cursor }; rejects if the daemon is not running.
 */
export function pollEvents({ after = 'now', timeout = 90, match = 'rules', account, rule, types, limit } = {}) {
  const q = new URLSearchParams({ after: String(after), timeout: String(timeout), match });
  if (account) q.set('account', account);
  if (rule) q.set('rule', rule);
  if (types && types.length) q.set('types', Array.isArray(types) ? types.join(',') : String(types));
  if (limit) q.set('limit', String(limit));
  return httpGet('/events?' + q.toString(), Number(timeout) + 30);
}

export function currentCursor() {
  return httpGet('/cursor', 10).then((r) => r.cursor);
}

function httpGet(pathname, timeoutS) {
  return new Promise((resolve, reject) => {
    const req = http.request({ socketPath: HTTP_SOCK, path: pathname, method: 'GET', timeout: timeoutS * 1000 }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => {
        try { resolve(JSON.parse(body)); } catch { reject(new Error('bad response from the daemon: ' + body.slice(0, 200))); }
      });
    });
    req.on('timeout', () => { req.destroy(new Error('long-poll timed out without a response')); });
    req.on('error', (e) => reject(new Error(`cannot reach the daemon at ${HTTP_SOCK} (${e.code || e.message}) — is it running? (mailwatcher status)`)));
    req.end();
  });
}

function line(obj) {
  return JSON.stringify({ ts: new Date().toISOString(), ...obj }) + '\n';
}
