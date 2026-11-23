// JMAP push (RFC 8620 §7.3): the session's eventSourceUrl held open as Server-Sent Events (fetch, its body read
// as it comes, parsed here: EventSource sends no Authorization). The server sends a StateChange whenever the
// account's Emails or Mailboxes change; an Email state other than the last one known is a check (onNewMail, and
// onDraftsChange: a draft is an Email, and the state says nothing of which).
// Same hooks as EwsStream and ImapStream. A server with no eventSourceUrl has no push: the stream says 'off' at
// once, and the watcher's poll carries the account.

import { JmapClient, expand } from './jmap.js';

/** How often the server is asked to send a ping (seconds); twice that and more with nothing heard is a dead connection. */
const PING_SECONDS = 30;

export class JmapStream {
  constructor({ account, creds, onNewMail, onDraftsChange, refreshCreds, authGate, onState, log, retryMs = 5000, pauseMs = 15000, pingSeconds = PING_SECONDS }) {
    this.account = account;
    this.creds = creds;
    this.onNewMail = onNewMail || (() => {});
    this.onDraftsChange = onDraftsChange || null;
    this.refreshCreds = refreshCreds;
    this.authGate = authGate;
    this.onState = onState || (() => {});
    this.log = log || (() => {});
    this.retryMs = retryMs; // the first wait after a failure; it grows with each one, to a minute
    this.pauseMs = pauseMs; // how often a paused stream looks whether its sign-in may be tried again
    this.pingSeconds = pingSeconds;
    this.stopped = false;
    this.failures = 0;
    this.authFails = 0;
    this.emailState = null; // the last Email state known: what a reconnection compares with, so nothing between is missed
  }

  start() {
    this.stopped = false;
    this.loop();
  }

  stop() {
    this.stopped = true;
    try { this.abort?.abort(); } catch {}
    this.wake?.();
  }

  async loop() {
    while (!this.stopped) {
      let connectedAt = 0;
      // a sign-in the server rejects is not tried again while the gate says so
      if (this.authGate?.blocked?.()) {
        this.onState('reconnecting');
        this.paused = true;
        await this.#sleep(this.pauseMs);
        continue;
      }
      if (this.paused && this.refreshCreds) {
        // the pause ended: sign in with what is stored now, not what was rejected
        this.paused = false;
        this.authFails = 0;
        try { this.creds = await this.refreshCreds(); } catch (e2) { this.log('credential refresh failed: ' + e2.message); }
      }
      try {
        const held = await this.holdOnce(() => {
          connectedAt = Date.now();
          this.authFails = 0;
          this.authGate?.ok?.();
        });
        if (held === 'none') { this.log('the server offers no push (no eventSourceUrl) — polling only'); break; }
      } catch (e) {
        if (this.stopped) break;
        this.onState('reconnecting');
        if (e?.code === 'MAIL_AUTH') {
          if (this.refreshCreds) {
            this.log('auth failed — refreshing credentials');
            try { this.creds = await this.refreshCreds(); } catch (e2) { this.log('credential refresh failed: ' + e2.message); }
          }
          this.authFails++;
          if (this.authGate && (this.authFails >= 2 || !this.refreshCreds)) this.authGate.failed?.(e); // rejected again after a refresh
        }
        const uptime = connectedAt ? Date.now() - connectedAt : 0;
        if (uptime > 60000) {
          this.failures = 0;
          this.log(`event stream dropped after ${Math.round(uptime / 1000)}s (${e.message}) — reconnecting`);
          await this.#sleep(Math.min(1000, this.retryMs));
        } else {
          this.failures++;
          const delay = Math.min(60000, this.retryMs * this.failures);
          this.log(`stream error (${this.failures}): ${e.message} — retrying in ${delay / 1000}s`);
          await this.#sleep(delay);
        }
      }
    }
    this.onState('off');
  }

  /** One connection to the event source, held until it ends (an error, always) or the stream is stopped; 'none' when the server has none. */
  async holdOnce(onConnected) {
    // the controller first: a stop() at any await below reaches it, and `finally` always closes what was opened
    const ac = new AbortController();
    this.abort = ac;
    let watchdog = null;
    let res = null;
    let reader = null;
    try {
      const client = new JmapClient(this.account, this.creds);
      const s = await client.session();
      if (this.stopped) return 'stopped';
      if (!s.eventSourceUrl) return 'none';
      let heard = Date.now();
      const quiet = (this.pingSeconds * 2 + 15) * 1000;
      watchdog = setInterval(() => { if (Date.now() - heard > quiet) ac.abort(new Error(`nothing heard for ${Math.round(quiet / 1000)}s`)); }, Math.min(5000, quiet / 3));
      const url = expand(s.eventSourceUrl, { types: 'Email,Mailbox', closeafter: 'no', ping: String(this.pingSeconds) });
      res = await client.request(url, { headers: { Accept: 'text/event-stream', 'Cache-Control': 'no-cache' }, signal: ac.signal }, { timeoutMs: 0 });
      reader = res.body.getReader();
      if (this.stopped) return 'stopped';
      this.log('watching via the JMAP event source');
      this.onState('connected');
      onConnected();
      // where the Emails stand, asked once listening: what changed while disconnected is told, and nothing after is missed
      const state = await client.emailState();
      if (this.stopped) return 'stopped';
      this.#heard(state);
      const events = sseEvents((ev) => {
        if (ev.event !== 'state' && ev.event !== '') return; // ping, and what this does not know
        let change;
        try { change = JSON.parse(ev.data); } catch { return; }
        const now = change?.changed?.[s.accountId]?.Email;
        if (now !== undefined) this.#heard(now);
      });
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        heard = Date.now();
        events(value);
      }
      if (this.stopped) return 'stopped';
      throw new Error('the server closed the event stream');
    } catch (e) {
      if (this.stopped) return 'stopped';
      throw ac.signal.aborted && ac.signal.reason instanceof Error ? ac.signal.reason : e;
    } finally {
      if (watchdog) clearInterval(watchdog);
      try { ac.abort(); } catch {}
      if (reader) reader.cancel().catch(() => {});
      else res?.body?.cancel().catch(() => {});
      if (this.abort === ac) this.abort = null;
    }
  }

  /** An Email state heard: other than the last one known, mail may have come. */
  #heard(state) {
    if (state == null) return;
    const was = this.emailState;
    this.emailState = state;
    if (was != null && was !== state) {
      try { this.onNewMail('told'); } catch {}
      if (this.onDraftsChange) { try { this.onDraftsChange(); } catch {} }
    }
  }

  #sleep(ms) {
    return new Promise((resolve) => {
      const t = setTimeout(done, ms);
      function done() { clearTimeout(t); resolve(); }
      this.wake = done;
    });
  }
}

/**
 * A Server-Sent Events parser (the HTML standard's, the parts JMAP uses): fed the body's chunks as they come,
 * calls onEvent({ event, data, id }) at each blank line that ends an event with data.
 */
export function sseEvents(onEvent) {
  const decoder = new TextDecoder();
  let buffer = '';
  let ev = { event: '', data: [], id: '' };
  const line = (l) => {
    if (l === '') {
      if (ev.data.length) onEvent({ event: ev.event, data: ev.data.join('\n'), id: ev.id });
      ev = { event: '', data: [], id: ev.id };
      return;
    }
    if (l.startsWith(':')) return; // a comment (a keep-alive)
    const at = l.indexOf(':');
    const field = at < 0 ? l : l.slice(0, at);
    const value = at < 0 ? '' : l.slice(at + 1).replace(/^ /, '');
    if (field === 'event') ev.event = value;
    else if (field === 'data') ev.data.push(value);
    else if (field === 'id') ev.id = value;
  };
  return (chunk) => {
    buffer += typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true });
    let m;
    // (a CR at the very end waits for the next chunk: it may be the first half of a CRLF)
    while ((m = /\r\n|\n|\r(?=[^\n])/.exec(buffer))) {
      line(buffer.slice(0, m.index));
      buffer = buffer.slice(m.index + m[0].length);
    }
  };
}
