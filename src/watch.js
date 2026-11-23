// Watching mail accounts: one poll ticker and one push stream (EWS streaming
// notifications, IMAP IDLE or a JMAP event source) per account; the interval stays as a safety
// net for both. New mail is detected against a seen-set kept in the core's
// state store, and headers (plus bodies of new mail) go to the cache.
//
//   const w = await core.watch({ pollSeconds: 30 });
//   w.on('mail', ({ account, items }) => …)   // new unread mail of one poll
//   w.start();
//
// Events:
//   'mail'      { account, items }       new, unread mail (after the first poll, which only sets the baseline)
//   'baseline'  { account, count }       first poll of an account
//   'poll'      { account, items }       every successful poll (all items listed)
//   'failure'   { account, error, failures }   a poll failed (failures in a row)
//   'stream'    { account, state }       push state: connected | reconnecting | off
//   'calendar'  { account, changes }     calendar changes (with calendar: true), see calendar-watch.js
//   'reminder'  { account, minutes, …event }
//
// Rules, alerts and actions are the caller's: see rules.js for matching.
//
// authGate (optional): (account) => { blocked(), ok(), failed(err) }, one
// per account, shared by its poll, push stream and calendar watcher, so a
// sign-in the server rejects is not retried at every poll (which can lock
// the account out). While blocked() the account is not polled, its stream
// does not reconnect and its calendar is not refreshed.

import { EventEmitter } from 'node:events';
import { calendarProvider, hasMail } from './accounts.js';
import { isAuthError } from './client.js';

const SEEN_MAX = 4000;

export class MailWatch extends EventEmitter {
  /**
   * @param {import('./core.js').Mailcore} core
   * @param {{ accounts?: string[], pollSeconds?: number, push?: boolean, calendar?: boolean, cache?: boolean, log?: Function, calendarSnapshot?: (account: string) => { load(): any, save(o: any): void }, authGate?: (account: string) => { blocked(): boolean, ok(): void, failed(e: Error): void } }} [o]
   */
  constructor(core, { accounts, pollSeconds, push = true, calendar = true, cache = true, log, calendarSnapshot, authGate } = {}) {
    super();
    this.core = core;
    this.names = accounts || null;
    this.pollSeconds = pollSeconds;
    this.push = push;
    this.calendar = calendar;
    this.useCache = cache;
    this.log = log || core.log;
    this.calendarSnapshot = calendarSnapshot;
    this.authGate = authGate;
    this.timers = [];
    this.timeouts = new Set();
    this.streams = [];
    this.calendars = new Map();
    this.ticks = new Map();
    this.started = false;
    // stop() bumps the generation; anything begun under an older one checks
    // it after each await and installs nothing (intervals, streams, watchers)
    this.gen = 0;
  }

  #alive(gen) { return this.started && this.gen === gen; }
  #state() { return this.core.state.load() ?? {}; }

  /** Start every account; resolves once each account's first poll ran. */
  async start() {
    if (this.started) return this;
    this.started = true;
    const gen = ++this.gen;
    const core = this.core;
    const names = this.names || core.accountNames();
    if (names.length === 0) throw new Error('no accounts to watch');

    const cached = this.useCache ? core.cache.cachedAccounts() : [];
    if (cached.length) {
      try {
        core.cache.openCache({ create: true });
        const removed = core.cache.prune();
        this.log(`cache: ${cached.join(', ')} → ${core.cache.path}${removed ? ` (pruned ${removed} old rows)` : ''}`);
        this.#every(gen, () => { try { core.cache.prune(); } catch (e) { this.log('cache prune failed: ' + e.message); } }, 6 * 3600e3);
      } catch (e) {
        this.log('cache disabled: ' + e.message);
        this.useCache = false;
      }
    }
    await Promise.all(names.map((n) => this.#watchAccount(core.account(n), gen)));
    return this;
  }

  stop() {
    this.gen++;
    this.started = false;
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    for (const t of this.timeouts) clearTimeout(t);
    this.timeouts.clear();
    this.ticks.clear();
    for (const s of this.streams) { try { s.stop?.(); } catch {} }
    this.streams = [];
    for (const c of this.calendars.values()) c.stop();
    this.calendars.clear();
  }

  /** Poll one account now (also what a push triggers). */
  check(account) { return this.ticks.get(account)?.(); }

  #every(gen, fn, ms) {
    if (!this.#alive(gen)) return null;
    const t = setInterval(fn, ms);
    this.timers.push(t);
    return t;
  }

  #later(gen, fn, ms) {
    if (!this.#alive(gen)) return null;
    const t = setTimeout(() => { this.timeouts.delete(t); if (this.#alive(gen)) fn(); }, ms);
    this.timeouts.add(t);
    return t;
  }

  async #watchAccount(acct, gen) {
    const core = this.core;
    const name = acct.name;
    const mail = hasMail(acct);
    let failures = 0;
    let ticking = false;
    let again = false; // a push arrived mid-poll: run once more right after
    const authGate = this.authGate?.(name) || undefined;
    const tick = async () => {
      if (!mail || !this.#alive(gen) || authGate?.blocked()) return;
      if (ticking) { again = true; return; }
      ticking = true;
      try {
        await core.withClient(name, (client) => this.#poll(client, name, gen), {
          onRefresh: () => this.log(`[${name}] password rejected — asking for fresh credentials…`)
        });
        failures = 0;
        authGate?.ok();
      } catch (e) {
        if (!this.#alive(gen)) return;
        failures++;
        this.log(`[${name}] poll failed (${failures}): ${e.message}`);
        if (isAuthError(e)) authGate?.failed(e);
        this.emit('failure', { account: name, error: e, failures });
      } finally {
        ticking = false;
        if (again) { again = false; this.#later(gen, tick, 250); }
      }
    };
    this.ticks.set(name, tick);
    if (mail) {
      await tick();
      this.#every(gen, tick, Math.max(15, this.pollSeconds || core.pollSeconds) * 1000);
    }
    if (!this.#alive(gen)) return;

    // Calendar: snapshot + reminders, refreshed on push (Exchange) or by polling
    let calendar = null;
    if (this.calendar && calendarProvider(acct) && acct.calendar && acct.calendar.watch !== false) {
      try {
        const { watchCalendar } = await import('./calendar-watch.js');
        if (!this.#alive(gen)) return;
        calendar = watchCalendar(core, { account: name, log: this.log, snapshot: this.calendarSnapshot?.(name), start: false, authGate });
        calendar.on('changes', (changes) => this.emit('calendar', { account: name, changes }));
        calendar.on('reminder', (r) => this.emit('reminder', r));
        calendar.start();
        this.calendars.set(name, calendar);
        this.log(`[${name}] calendar watch on (reminders ${[].concat(acct.calendar.remindMinutes).join('/')} min before)`);
      } catch (e) {
        this.log(`[${name}] calendar watch not started: ${e.message}`);
      }
    }

    // Push: the server tells us the instant mail arrives; each event triggers an immediate check.
    if (!mail || !this.push || acct.streaming === false) return;
    try {
      const stream = await core.stream(name, {
        onNewMail: () => this.#later(gen, tick, 500), // small delay lets the item settle
        onCalendarChange: calendar ? () => calendar.refresh() : undefined,
        authGate,
        onState: (s) => {
          if (!this.#alive(gen)) return;
          try {
            const state = this.#state();
            core.state.save({ ...state, streams: { ...(state.streams || {}), [name]: { state: s, at: Date.now() } } });
          } catch {}
          this.emit('stream', { account: name, state: s });
        },
        log: (m) => this.log(`[${name}] [stream] ` + m)
      });
      if (!this.#alive(gen)) return; // stopped while connecting: never start it
      this.streams.push(stream);
      stream.start();
    } catch (e) {
      if (!this.#alive(gen)) return;
      this.log(`[${name}] push stream not started: ${e.message} — polling only`);
    }
  }

  async #poll(client, account, gen) {
    const core = this.core;
    const acct = core.accounts[account];
    const caching = this.useCache && acct?.cache?.enabled !== false && core.cache.openCache() !== null;
    // first poll with a cache: backfill a deeper slice of headers
    const backfill = caching && !(this.#state().baselinedAccounts || {})[account];
    const items = await client.findInbox({ limit: backfill ? 100 : 25 });
    if (!this.#alive(gen)) return;
    if (caching) {
      try {
        const newIds = core.cache.upsertItems(account, items);
        if (acct.cache.bodies !== false && !backfill) await this.#cacheBodies(client, account, items.filter((i) => newIds.includes(i.id)));
      } catch (e) {
        this.log(`[${account}] cache write failed: ${e.message}`);
      }
    }
    if (!this.#alive(gen)) return;
    const state = this.#state();
    const seen = new Set(state.seenIds || []);
    // ids are "<account>:<raw>"; an older seen-set may hold raw ids for the
    // account named "default" — honour those too so nothing re-alerts.
    const known = (id) => seen.has(id) || seen.has(id.slice(account.length + 1));
    // A mail moved out of the inbox and back (an archive taken back, a restore from the trash) comes back
    // under a new id. It is the same mail, by its Message-ID: not new, and not to be alerted about again.
    // The set is shared by all accounts on purpose: one mail delivered to two of my
    // accounts is announced once, by whichever account polls first.
    const seenMail = new Set(state.seenMessageIds || []);
    const fresh = items.filter((i) => i.id && !known(i.id) && !(i.messageId && seenMail.has(i.messageId)));
    for (const i of items) { if (i.id) seen.add(i.id); if (i.messageId) seenMail.add(i.messageId); }
    let ids = Array.from(seen);
    if (ids.length > SEEN_MAX) ids = ids.slice(ids.length - SEEN_MAX);
    let mailIds = Array.from(seenMail);
    if (mailIds.length > SEEN_MAX) mailIds = mailIds.slice(mailIds.length - SEEN_MAX);

    const baselined = { ...(state.baselinedAccounts || {}) };
    const wasBaselined = baselined[account] || (account === 'default' && state.baselined);
    baselined[account] = true;
    core.state.save({ ...state, seenIds: ids, seenMessageIds: mailIds, baselined: true, baselinedAccounts: baselined, lastPollAt: Date.now() });
    this.emit('poll', { account, items });

    if (!wasBaselined) {
      this.log(`[${account}] baseline set: ${items.length} items`);
      this.emit('baseline', { account, count: items.length });
      return;
    }
    const unread = fresh.filter((i) => !i.isRead);
    if (unread.length) this.emit('mail', { account, items: unread });
  }

  // Fetch and store the text + HTML bodies of newly seen mail (two calls per
  // mail; new-mail volume is low). Failures only cost the cached body.
  async #cacheBodies(client, account, items) {
    for (const item of items.slice(0, 10)) {
      try {
        const text = await client.getMessage(item.id, { bodyType: 'Text' });
        let html = null;
        try { html = await client.getMessage(item.id, { bodyType: 'HTML' }); } catch {}
        // '': no HTML in this mail; null: it could not be asked
        this.core.cache.upsertBody(account, text, { text: text.body, html: html ? (html.bodyType === 'HTML' ? html.body : '') : null });
      } catch (e) {
        this.log(`[${account}] body cache failed for ${item.subject}: ${e.message}`);
      }
    }
  }
}
