// A cursor-backed queue of mail and calendar events, with long-poll waits.
//
// Every queued event gets a monotonic sequence number (`seq`); a consumer
// keeps the last cursor it saw and asks for what came after it, so nothing
// is missed across restarts when the log is persisted ({ load, save }).
// The queue is bounded (last 500 by default): a cursor older than the oldest
// event kept gets { gap: true, oldest, lost } and should resync.
//
// Filters: { match: 'rules' | 'all', account, rule, types }
//   mail events (newmail, wake) pass match=rules only when they carry `rule`;
//   calendar events (calendar, reminder) pass only when `types` names them.

import { EventEmitter } from 'node:events';

export const QUEUED_TYPES = new Set(['newmail', 'wake', 'calendar', 'reminder']);
export const MAIL_TYPES = new Set(['newmail', 'wake']);

/**
 * A cursor older than the oldest event still retained means events in
 * between are gone (the queue is bounded): { gap: true, oldest, lost }, else {}.
 */
export function gapInfo(after, queue, seq) {
  const oldest = queue.length ? queue[0].seq : seq + 1;
  if (after >= oldest - 1) return {};
  return { gap: true, oldest: queue.length ? oldest : null, lost: Math.min(seq, oldest - 1) - after };
}

/** Whether event `e` passes filter `f` (see the header). */
export function matchesFilter(e, f = {}) {
  if (f.types && !f.types.includes(e.type)) return false;
  if (MAIL_TYPES.has(e.type)) {
    if (f.match !== 'all' && !e.rule) return false;
    if (f.rule && e.rule !== f.rule) return false;
  } else if (!f.types) {
    return false; // calendar/reminder: only when asked for via types
  }
  if (f.account && e.account !== f.account) return false;
  return true;
}

export class EventLog extends EventEmitter {
  /** @param {{ max?: number, store?: { load(): any, save(obj): void }, now?: () => Date }} [o] */
  constructor({ max = 500, store = null, now = () => new Date() } = {}) {
    super();
    this.max = max;
    this.store = store;
    this.now = now;
    this.seq = 0;
    this.queue = [];
    this.waiters = new Set();
    this.closed = false;
    if (store) {
      try {
        const saved = store.load();
        if (saved) {
          this.seq = Number(saved.seq) || 0;
          this.queue = Array.isArray(saved.events) ? saved.events.slice(-max) : [];
        }
      } catch {}
    }
  }

  get cursor() { return this.seq; }

  /**
   * Add an event { type, … }. Queued types get `seq` and wake matching
   * waiters; every event is emitted as 'event' (live listeners).
   */
  append(type, data = {}) {
    const event = { ts: this.now().toISOString(), type, ...data };
    if (QUEUED_TYPES.has(type)) {
      event.seq = ++this.seq;
      this.queue.push(event);
      if (this.queue.length > this.max) this.queue = this.queue.slice(-this.max);
      this.#persist();
      for (const w of Array.from(this.waiters)) {
        if (matchesFilter(event, w.filter)) w.resolve([event]);
      }
    }
    this.emit('event', event);
    return event;
  }

  #persist() {
    if (!this.store) return;
    try { this.store.save({ seq: this.seq, events: this.queue }); } catch {}
  }

  /** Queued events after `after` that pass `filter`. */
  since(after, filter = {}) {
    return this.queue.filter((e) => e.seq > after && matchesFilter(e, filter));
  }

  /**
   * Long-poll: { events, cursor, gap? } at once when events past `after`
   * match, else when the first matching one lands, else after `timeout`
   * seconds with events: []. after 'now' (or null) = from the current cursor.
   * `signal` (AbortSignal) ends the wait early with events: [] — at once
   * when it is already aborted — and so does close().
   */
  wait({ after = 'now', timeout = 90, filter = {}, limit = 50, signal } = {}) {
    const from = after == null || after === 'now' ? this.seq : Math.max(0, Number(after) || 0);
    const gap = after != null && after !== 'now' ? gapInfo(from, this.queue, this.seq) : {};
    const max = Math.min(100, Math.max(1, Number(limit) || 50));
    const ready = this.since(from, filter);
    const result = (events) => ({ events, cursor: events.length ? events[events.length - 1].seq : this.seq, ...gap });
    if (ready.length) return Promise.resolve(result(ready.slice(0, max)));
    if (!(timeout > 0) || this.closed || signal?.aborted) return Promise.resolve(result([]));
    return new Promise((resolve) => {
      const w = { filter, timer: null, resolve: null };
      const onAbort = () => w.resolve([]);
      // one settle path: timeout, abort, a matching event and close() all clean up the same three things
      w.resolve = (events) => {
        if (!this.waiters.delete(w)) return;
        clearTimeout(w.timer);
        signal?.removeEventListener('abort', onAbort);
        resolve(result(events));
      };
      this.waiters.add(w);
      w.timer = setTimeout(onAbort, timeout * 1000);
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }

  /**
   * Async iterator over matching events after `after`, until `signal` aborts
   * or the log is closed. Each event carries its `seq`: keep it as the cursor.
   * When `after` predates what the bounded queue still holds, a
   * { type: 'gap', gap: true, oldest, lost, cursor } notice comes first:
   * resync rather than trust the stream.
   */
  async *events({ after = 'now', filter = {}, signal } = {}) {
    let cursor = after == null || after === 'now' ? 'now' : Number(after) || 0;
    while (!signal?.aborted && !this.closed) {
      const r = await this.wait({ after: cursor, timeout: 3600, filter, signal });
      if (r.gap) yield { type: 'gap', gap: true, oldest: r.oldest ?? null, lost: r.lost ?? 0, cursor: typeof cursor === 'number' ? cursor : this.seq };
      for (const e of r.events) yield e;
      cursor = r.cursor;
    }
  }

  /** Release every waiter (events: []) and end every events() iterator. */
  close() {
    this.closed = true;
    for (const w of Array.from(this.waiters)) w.resolve([]);
  }
}
