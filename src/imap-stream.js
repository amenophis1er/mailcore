// IMAP "push", two ways at once. Same hooks as EwsStream.
//
// Told: a connection with the inbox selected; the server's IDLE (imapflow
// enters it by itself when nothing else is pending) delivers an EXISTS when
// mail arrives. When, though, is the server's business: Gmail tells on a beat
// of about thirty seconds (measured: 9 to 34 seconds after arrival).
//
// Asked: a second connection with nothing selected asks for the inbox's next
// message number every couple of seconds (STATUS INBOX (UIDNEXT)), which the
// server answers from the mailbox as it is (measured on Gmail: new mail seen
// at the first ask after it arrived). One short command on an open
// connection: nothing is signed in again, nothing is listed.
//
// Whichever notices first calls onNewMail; the other's call finds nothing new.

import { ImapFlow } from 'imapflow';
import { imapOptionsNow, authError } from './imap.js';

/** How long one IDLE is held before it is ended and begun again (RFC 2177 asks for under 29 minutes; Gmail needs under ten). */
const IDLE_RENEW_MS = 4 * 60e3;
/** How often the inbox is asked for its next message number. accounts.<name>.imap.askSeconds (0: never, wait to be told). */
const ASK_SECONDS = 2;

export class ImapStream {
  constructor({ account, creds, onNewMail, refreshCreds, authGate, onState, log }) {
    this.account = account;
    this.creds = creds;
    this.onNewMail = onNewMail;
    this.refreshCreds = refreshCreds;
    this.onState = onState || (() => {});
    this.authGate = authGate;
    this.log = log || (() => {});
    this.stopped = false;
    this.failures = 0;
    this.authFails = 0;
    this.pauseMs = 15000; // how often a paused stream looks whether its sign-in may be tried again
    this.client = null;
  }

  start() {
    this.stopped = false;
    this.loop();
    this.ask();
  }

  stop() {
    this.stopped = true;
    try { this.client?.close(); } catch {}
    try { this.asker?.close(); } catch {}
  }

  /**
   * Ask the inbox for its next message number every few seconds; a higher one is new mail. Reconnects by itself,
   * ever more slowly while it keeps failing; it leaves signing in again after a refusal to the told connection
   * (which goes through the daemon's own care for that), and only uses what that one found.
   */
  async ask() {
    const every = Number(this.account.imap?.askSeconds ?? ASK_SECONDS) * 1000;
    if (!(every > 0)) return;
    const inbox = this.account.imap?.folders?.inbox || 'INBOX'; // the same folder the checks read (see ImapClient)
    let failures = 0;
    while (!this.stopped) {
      if (this.authGate?.blocked?.()) { await sleep(30000); continue; }
      let client = null;
      /** Where the inbox stands. A refusal comes back as `false`, not as an error: it is one here. */
      const stand = async () => {
        const s = await client.status(inbox, { uidNext: true, uidValidity: true });
        if (!s || !Number.isFinite(Number(s.uidNext))) throw new Error('the server did not say where the inbox stands');
        return { next: Number(s.uidNext), validity: String(s.uidValidity ?? '') };
      };
      try {
        // (inside the guard: a sign-in token not to be had just now is one more failure, tried again later)
        // a server that stops answering without hanging up is a dead connection: known within seconds, not minutes
        client = new ImapFlow({ ...(await imapOptionsNow(this.account, this.creds)), disableAutoIdle: true, socketTimeout: 20000 });
        this.asker = client;
        client.on('error', () => {}); // surfaced through the awaiting command
        await client.connect();
        let at = await stand();
        let healthy = 0;
        while (!this.stopped && client.usable) {
          await sleep(Math.max(1000, every));
          const now = await stand();
          if (++healthy === 15) failures = 0; // half a minute of answers: it works again
          if (now.validity !== at.validity || now.next < at.next) {
            // the mailbox was rebuilt: its numbers mean something else now. A plain check, and count from here.
            at = now;
            this.onNewMail('asked');
          } else if (now.next > at.next) {
            const from = at.next; // the first number that is new
            at = now;
            this.onNewMail('asked', from);
          }
        }
      } catch (e) {
        if (this.stopped) break;
        // quietly: the told connection and the timed check still stand. Said once things look broken, not at every blip.
        if (++failures === 3) this.log(`asking for new mail keeps failing (${e.message}): waiting to be told meanwhile`);
      } finally {
        this.asker = null;
        try { client?.close(); } catch {}
      }
      if (!this.stopped) await sleep(Math.min(60000, 2000 * 2 ** Math.min(failures, 5)));
    }
  }

  async loop() {
    while (!this.stopped) {
      let connectedAt = 0;
      // a sign-in the server rejects is not tried again while the gate says so (it could lock the account out)
      if (this.authGate?.blocked?.()) {
        this.onState('reconnecting');
        this.paused = true;
        await sleep(this.pauseMs);
        continue;
      }
      if (this.paused && this.refreshCreds) {
        // the pause ended: sign in with what is stored now, not what was rejected
        this.paused = false;
        this.authFails = 0;
        try { this.creds = await this.refreshCreds(); } catch (e2) { this.log('credential refresh failed: ' + e2.message); }
      }
      try {
        await this.holdOnce(() => {
          connectedAt = Date.now();
          this.authFails = 0;
          this.authGate?.ok?.();
        });
        this.failures = 0;
      } catch (e) {
        if (this.stopped) break;
        this.onState('reconnecting');
        if (authError(e)) {
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
          this.log(`idle connection dropped after ${Math.round(uptime / 1000)}s (${e.message}) — reconnecting`);
          await sleep(1000);
        } else {
          this.failures++;
          const delay = Math.min(60000, 5000 * this.failures);
          this.log(`stream error (${this.failures}): ${e.message} — retrying in ${delay / 1000}s`);
          await sleep(delay);
        }
      }
    }
    this.onState('off');
  }

  async holdOnce(onConnected) {
    // (the token, when the account signs in with its provider, is asked for first: a refusal is this call's error)
    const options = await imapOptionsNow(this.account, this.creds);
    return new Promise(async (resolve, reject) => {
      // IDLE is renewed every few minutes. Left alone, a server may keep the connection open and simply stop
      // telling: Gmail goes quiet after about ten minutes, and new mail then waited for the next poll.
      const client = new ImapFlow({ ...options, maxIdleTime: IDLE_RENEW_MS });
      this.client = client;
      let settled = false;
      const done = (err) => {
        if (settled) return;
        settled = true;
        this.client = null;
        err ? reject(err) : resolve();
      };
      client.on('error', (e) => done(authError(e) ? tagAuth(e) : e));
      client.on('close', () => done(new Error('connection closed')));
      client.on('exists', ({ count, prevCount }) => {
        if (count > (prevCount || 0)) this.onNewMail('told');
      });
      try {
        await client.connect();
        await client.mailboxOpen('INBOX');
        this.log('watching INBOX via IDLE');
        this.onState('connected');
        onConnected();
      } catch (e) {
        done(authError(e) ? tagAuth(e) : e);
      }
    });
  }
}

function tagAuth(e) {
  e.code = 'MAIL_AUTH';
  return e;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
