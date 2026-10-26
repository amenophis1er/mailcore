// EWS Streaming Notifications: Subscribe once, then hold a long-lived
// GetStreamingEvents connection on which Exchange pushes NewMailEvent the
// moment mail arrives. NTLM authenticates the *connection*, so both handshake
// legs and the streamed response must share one keep-alive socket — stock
// httpntlm buffers whole responses, so the handshake is done manually here
// with its low-level ntlm primitives.

import https from 'node:https';
import { URL } from 'node:url';
import httpntlm from 'httpntlm';

const { ntlm } = httpntlm;

const CONNECTION_TIMEOUT_MIN = 15; // server closes + we reopen this often
const SOCKET_IDLE_MS = 120000; // Exchange keep-alives arrive ~45s apart

export class EwsStream {
  constructor({ host, username, domain, password, onNewMail, onCalendarChange, refreshCreds, onState, log }) {
    this.url = new URL(host.replace(/\/$/, '') + '/EWS/Exchange.asmx');
    this.creds = { username, domain: domain || '', password };
    this.onNewMail = onNewMail;
    // when set, a second subscription watches the default calendar for
    // created / modified / deleted items (invitations, moves, cancellations)
    this.onCalendarChange = onCalendarChange || null;
    this.calendarSubscriptionId = null;
    this.refreshCreds = refreshCreds;
    this.onState = onState || (() => {});
    this.log = log || (() => {});
    this.stopped = false;
    this.subscriptionId = null;
    this.failures = 0;
    this.activeReq = null;
  }

  start() {
    this.stopped = false;
    this.loop();
  }

  stop() {
    this.stopped = true;
    try { this.activeReq?.destroy(); } catch {}
  }

  async loop() {
    while (!this.stopped) {
      let connectedAt = 0;
      try {
        if (!this.subscriptionId) {
          this.subscriptionId = await this.subscribe();
          this.log('subscribed to inbox NewMail events');
        }
        if (this.onCalendarChange && !this.calendarSubscriptionId) {
          try {
            this.calendarSubscriptionId = await this.subscribe('calendar', ['CreatedEvent', 'ModifiedEvent', 'DeletedEvent']);
            this.log('subscribed to calendar change events');
          } catch (e) {
            this.log('calendar subscription failed (' + e.message + ') — calendar is polled only');
            this.onCalendarChange = null;
          }
        }
        this.onState('connected');
        connectedAt = Date.now();
        await this.streamOnce();
        this.failures = 0; // normal server-side close; reconnect immediately
      } catch (e) {
        if (this.stopped) break;
        this.onState('reconnecting');
        if (e.code === 'EWS_AUTH' && this.refreshCreds) {
          this.log('auth failed — refreshing credentials');
          try { this.creds = await this.refreshCreds(); } catch (e2) { this.log('credential refresh failed: ' + e2.message); }
        }
        if (/SubscriptionNotFound|InvalidSubscription|ExpiredSubscription|SubscriptionUnsubscribed/i.test(e.message)) {
          this.subscriptionId = null;
          this.calendarSubscriptionId = null;
        }
        // A connection that lived a while and then got reset (RST from the
        // server or a middlebox) is routine, not a failure — reconnect fast.
        const uptime = connectedAt ? Date.now() - connectedAt : 0;
        if (uptime > 60000) {
          this.failures = 0;
          this.log(`stream dropped after ${Math.round(uptime / 1000)}s (${e.message}) — reconnecting`);
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

  async subscribe(folder = 'inbox', eventTypes = ['NewMailEvent']) {
    const body = envelope(`
      <m:Subscribe>
        <m:StreamingSubscriptionRequest>
          <t:FolderIds><t:DistinguishedFolderId Id="${folder}"/></t:FolderIds>
          <t:EventTypes>${eventTypes.map((t) => `<t:EventType>${t}</t:EventType>`).join('')}</t:EventTypes>
        </m:StreamingSubscriptionRequest>
      </m:Subscribe>`);
    const xml = await this.ntlmPost(body);
    if (/ResponseClass="Error"/.test(xml)) {
      throw new Error('Subscribe failed: ' + (xml.match(/<(?:\w+:)?ResponseCode>([^<]+)/)?.[1] || 'unknown'));
    }
    const id = xml.match(/<(?:\w+:)?SubscriptionId>([^<]+)<\//)?.[1];
    if (!id) throw new Error('Subscribe: no SubscriptionId in response');
    return id;
  }

  streamOnce() {
    const body = envelope(`
      <m:GetStreamingEvents>
        <m:SubscriptionIds>${[this.subscriptionId, this.calendarSubscriptionId].filter(Boolean).map((id) => `<t:SubscriptionId>${id}</t:SubscriptionId>`).join('')}</m:SubscriptionIds>
        <m:ConnectionTimeout>${CONNECTION_TIMEOUT_MIN}</m:ConnectionTimeout>
      </m:GetStreamingEvents>`);

    let buffer = '';
    let fatal = null;
    return this.ntlmPost(body, (chunk) => {
      buffer += chunk;
      let m;
      while ((m = buffer.match(/<\/(?:\w+:)?Envelope>/))) {
        const cut = m.index + m[0].length;
        const env = buffer.slice(0, cut);
        buffer = buffer.slice(cut);
        try {
          this.handleEnvelope(env);
        } catch (e) {
          fatal = e;
          try { this.activeReq?.destroy(); } catch {}
        }
      }
    }).then(
      () => { if (fatal) throw fatal; },
      (e) => { throw fatal || e; }
    );
  }

  handleEnvelope(env) {
    if (/ResponseClass="Error"/.test(env)) {
      throw new Error(env.match(/<(?:\w+:)?ResponseCode>([^<]+)/)?.[1] || 'streaming error');
    }
    // one envelope may carry several <Notification> blocks, each tagged with
    // its SubscriptionId — route calendar changes apart from new mail
    let mail = false;
    let calendar = false;
    for (const block of env.split(/<(?:\w+:)?Notification>/).slice(1)) {
      const sub = block.match(/<(?:\w+:)?SubscriptionId>([^<]+)<\//)?.[1];
      if (sub && sub === this.calendarSubscriptionId) {
        if (/(Created|Modified|Deleted)Event/.test(block)) calendar = true;
      } else if (block.includes('NewMailEvent')) mail = true;
    }
    if (mail) {
      this.log('NewMailEvent received');
      try { this.onNewMail(); } catch {}
    }
    if (calendar && this.onCalendarChange) {
      this.log('calendar change received');
      try { this.onCalendarChange(); } catch {}
    }
    // keep-alives (ConnectionStatus OK) need no action; Closed ends the
    // response body, which resolves streamOnce via the request 'end'.
  }

  /**
   * POST with a manual NTLM handshake on a single kept-alive socket.
   * With onData: resolves when the (streamed) response ends.
   * Without: resolves with the full response body.
   */
  ntlmPost(body, onData) {
    return new Promise((resolve, reject) => {
      const agent = new https.Agent({ keepAlive: true, maxSockets: 1 });
      const done = (fn, val) => {
        agent.destroy();
        this.activeReq = null;
        fn(val);
      };

      const baseOpts = {
        hostname: this.url.hostname,
        port: this.url.port || 443,
        path: this.url.pathname,
        method: 'POST',
        agent,
        headers: {
          'Content-Type': 'text/xml; charset=utf-8',
          'Connection': 'keep-alive',
          'Content-Length': Buffer.byteLength(body)
        }
      };

      // Leg 1: send NTLM type-1, expect 401 with the type-2 challenge.
      const req1 = https.request(
        { ...baseOpts, headers: { ...baseOpts.headers, Authorization: ntlm.createType1Message({ domain: this.creds.domain, workstation: '' }) } },
        (res1) => {
          res1.resume(); // drain so the socket is reusable
          res1.on('end', () => {
            const challenge = [].concat(res1.headers['www-authenticate'] || []).join(',');
            if (res1.statusCode !== 401 || !challenge.includes('NTLM')) {
              return done(reject, Object.assign(new Error(`NTLM handshake: expected 401 challenge, got ${res1.statusCode}`), { code: 'EWS_AUTH' }));
            }
            let type2;
            try {
              type2 = ntlm.parseType2Message(challenge, (e) => { if (e) throw e; });
            } catch (e) {
              return done(reject, new Error('NTLM: bad type-2 challenge: ' + e.message));
            }
            const auth = ntlm.createType3Message(type2, {
              username: this.creds.username,
              password: this.creds.password,
              domain: this.creds.domain,
              workstation: ''
            });

            // Leg 3: authenticate the same socket and receive the response.
            const req2 = https.request(
              { ...baseOpts, headers: { ...baseOpts.headers, Authorization: auth } },
              (res2) => {
                if (res2.statusCode === 401) {
                  res2.resume();
                  return done(reject, Object.assign(new Error('EWS authentication failed (401)'), { code: 'EWS_AUTH' }));
                }
                if (res2.statusCode !== 200) {
                  res2.resume();
                  return done(reject, new Error('EWS HTTP ' + res2.statusCode));
                }
                res2.setEncoding('utf8');
                let full = '';
                res2.on('data', (c) => (onData ? onData(c) : (full += c)));
                res2.on('end', () => done(resolve, full));
                res2.on('error', (e) => done(reject, e));
              }
            );
            this.wire(req2, reject, agent);
            req2.end(body);
          });
        }
      );
      this.wire(req1, reject, agent);
      req1.end(body);
    });
  }

  wire(req, reject, agent) {
    this.activeReq = req;
    req.setTimeout(SOCKET_IDLE_MS, () => req.destroy(new Error('stream idle timeout')));
    req.on('error', (e) => {
      agent.destroy();
      this.activeReq = null;
      reject(this.stopped ? Object.assign(new Error('stopped'), { stopped: true }) : e);
    });
  }
}

function envelope(bodyXml) {
  return `<?xml version="1.0" encoding="utf-8"?>
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"
  xmlns:t="http://schemas.microsoft.com/exchange/services/2006/types"
  xmlns:m="http://schemas.microsoft.com/exchange/services/2006/messages">
  <soap:Header><t:RequestServerVersion Version="Exchange2013_SP1"/></soap:Header>
  <soap:Body>${bodyXml}</soap:Body>
</soap:Envelope>`;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
