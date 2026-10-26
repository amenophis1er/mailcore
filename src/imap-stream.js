// IMAP push: hold a connection with the inbox selected; the server's IDLE
// (imapflow enters it automatically when nothing else is pending) delivers
// an EXISTS the moment mail arrives. Same hooks as EwsStream.

import { ImapFlow } from 'imapflow';
import { imapOptions, authError } from './imap.js';

export class ImapStream {
  constructor({ account, creds, onNewMail, refreshCreds, onState, log }) {
    this.account = account;
    this.creds = creds;
    this.onNewMail = onNewMail;
    this.refreshCreds = refreshCreds;
    this.onState = onState || (() => {});
    this.log = log || (() => {});
    this.stopped = false;
    this.failures = 0;
    this.client = null;
  }

  start() {
    this.stopped = false;
    this.loop();
  }

  stop() {
    this.stopped = true;
    try { this.client?.close(); } catch {}
  }

  async loop() {
    while (!this.stopped) {
      let connectedAt = 0;
      try {
        await this.holdOnce(() => { connectedAt = Date.now(); });
        this.failures = 0;
      } catch (e) {
        if (this.stopped) break;
        this.onState('reconnecting');
        if (authError(e) && this.refreshCreds) {
          this.log('auth failed — refreshing credentials');
          try { this.creds = await this.refreshCreds(); } catch (e2) { this.log('credential refresh failed: ' + e2.message); }
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

  holdOnce(onConnected) {
    return new Promise(async (resolve, reject) => {
      const client = new ImapFlow(imapOptions(this.account, this.creds));
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
        if (count > (prevCount || 0)) this.onNewMail();
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
