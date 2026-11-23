// Microsoft sign-in for mail: work and school accounts (Microsoft 365, Exchange Online) and personal ones
// (Outlook.com, Hotmail), which accept only OAuth since Microsoft turned basic authentication off. OAuth 2.0 with
// PKCE and a loopback redirect, as Microsoft prescribes for desktop apps (a public client: no secret), and access
// tokens renewed as needed. Microsoft renews the refresh token with each renewal: the new one is kept.
//
// The token is for Outlook's IMAP and SMTP (outlook.office.com), used as XOAUTH2 by imap.js; the account's address
// comes from the ID token of the sign-in.
//
// Nothing is stored here: the caller passes a token store { get(account), set(account, tokens) } (sync or async)
// and the client id of an app registered in Microsoft Entra (multitenant and personal accounts, public client).

import http from 'node:http';
import { createHash, randomBytes } from 'node:crypto';

/** What a mail account asks for: Outlook's IMAP and SMTP, a refresh token, and who signed in. */
export const MICROSOFT_MAIL_SCOPES = [
  'https://outlook.office.com/IMAP.AccessAsUser.All',
  'https://outlook.office.com/SMTP.Send',
  'offline_access', 'openid', 'email', 'profile'
];
/** The tenant of personal Microsoft accounts (Outlook.com, Hotmail, Live). */
export const MICROSOFT_PERSONAL_TENANT = '9188040d-6c67-4c5b-b112-36a304b66dad';
/** Where a Microsoft mailbox is reached: one IMAP server for all; SMTP by kind of account. */
export function microsoftServers(personal) {
  return {
    imap: { host: 'outlook.office365.com', port: 993, secure: true },
    smtp: personal ? { host: 'smtp-mail.outlook.com', port: 587, secure: false, requireTLS: true } : { host: 'smtp.office365.com', port: 587, secure: false, requireTLS: true },
  };
}

const AUTHORITY = 'https://login.microsoftonline.com/common/oauth2/v2.0';

function authError(message) { return Object.assign(new Error(message), { code: 'MAIL_AUTH' }); }
function signInError(message, code) { return Object.assign(new Error(message), { code }); }

/** Who an ID token says signed in: { email, name, tenant, personal }. Read, not verified: it came from the token endpoint over TLS, to us. */
export function idTokenClaims(idToken) {
  try {
    const c = JSON.parse(Buffer.from(String(idToken).split('.')[1], 'base64url').toString('utf8'));
    const email = [c.email, c.preferred_username, c.upn].find((v) => typeof v === 'string' && /^[^\s@<>"]{1,64}@[^\s@<>"]{1,253}$/.test(v)) ?? null;
    // who it is, for good: the tenant and the object id (an address can change hands; these do not)
    const id = typeof c.tid === 'string' && typeof c.oid === 'string' ? `${c.tid}:${c.oid}` : typeof c.sub === 'string' && typeof c.iss === 'string' ? `${c.iss}#${c.sub}` : null;
    return { email: email ? email.toLowerCase() : null, name: typeof c.name === 'string' ? c.name.slice(0, 120) : '', tenant: typeof c.tid === 'string' ? c.tid : null, personal: c.tid === MICROSOFT_PERSONAL_TENANT, id };
  } catch { return { email: null, name: '', tenant: null, personal: false, id: null }; }
}

export const DEFAULT_MICROSOFT_HINT = () => 'sign in to Microsoft again';
const escapeHtml = (v) => String(v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function endPage(ok, text) {
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${ok ? 'Signed in' : 'Not signed in'}</title>
<body style="font:16px/1.5 system-ui,sans-serif;max-width:32em;margin:15vh auto;padding:0 16px;color:#222"><h1 style="font-size:20px">${ok ? 'Signed in' : 'Not signed in'}</h1><p>${escapeHtml(text)}</p></body>`;
}

/**
 * microsoftAuth({ store, clientId, client, signInHint }) → { accessToken, beginLogin, signedIn, signInHint }.
 * `client`: a function returning { clientId }, asked each time one is needed (instead of clientId, fixed).
 */
export function microsoftAuth({ store, clientId, client: clientOf, signInHint = DEFAULT_MICROSOFT_HINT, fetchFn = fetch } = {}) {
  const client = () => {
    const id = typeof clientOf === 'function' ? clientOf()?.clientId : clientId;
    if (!id) throw new Error('Microsoft sign-in: no app (client id) configured');
    return id;
  };
  const hint = (account) => { try { return String(signInHint(account) || DEFAULT_MICROSOFT_HINT(account)); } catch { return DEFAULT_MICROSOFT_HINT(account); } };
  const tokenStore = () => {
    if (!store || typeof store.get !== 'function' || typeof store.set !== 'function') throw new Error('Microsoft sign-in: no token store');
    return store;
  };
  /**
   * Change what is stored of an account, compared and written in one step when the store can (`update(account,
   * fn)`: across processes, the daemon renewing while the web app signs in again). `fn(now)` returns what to write,
   * or undefined to write nothing.
   */
  const change = async (account, fn) => {
    const s = tokenStore();
    if (typeof s.update === 'function') return s.update(account, fn);
    const next = fn(await load(account));
    if (next !== undefined) await s.set(account, next);
    return next;
  };
  const load = async (account) => {
    const t = await tokenStore().get(account);
    if (!t) return null;
    if (typeof t === 'string') { try { return JSON.parse(t); } catch { return null; } }
    return t;
  };
  async function tokenRequest(params, signal) {
    const res = await fetchFn(`${AUTHORITY}/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(params).toString(), signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(20000)]) : AbortSignal.timeout(20000) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(`Microsoft answered ${res.status}: ${data.error || ''} ${String(data.error_description || '').split('\r\n')[0]}`.trim()), { oauthError: data.error });
    return data;
  }

  async function signedIn(account) {
    try { return !!(await load(account))?.refresh_token; } catch { return false; }
  }

  /**
   * Start an interactive sign-in. Returns at once with { url, redirectUri, state, done, cancel, complete }, as
   * google-auth's beginLogin does; `done` resolves with what was stored, which carries `email`, `name` and `personal`
   * from the ID token. opts: loginHint, timeoutMs, appName, accept(tokens, { signal }).
   *
   * Microsoft sends the browser back either to a one-time server on 127.0.0.1 (the default: the browser is on this
   * computer), or, with `redirectUri` (an https address registered for the app, such as a relay's), elsewhere: whoever
   * serves that address hands what Microsoft gave it ({ code, state, error, error_description }) to `complete`, which
   * answers { ok, status, text } for the page shown there. `stateTag`: put before the state (the relay reads which
   * computer it is for from it). `port`: the local server's (one a tunnel forwards; any free one otherwise). Either way the code is worth nothing without the verifier, which never leaves here.
   */
  async function beginLogin(account, { loginHint, timeoutMs = 10 * 60e3, appName = 'the app', accept, redirectUri, stateTag, port: wanted = 0 } = {}) {
    const id = client();
    const store = tokenStore();
    const verifier = randomBytes(48).toString('base64url');
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    const state = (stateTag ? `${stateTag}.` : '') + randomBytes(24).toString('base64url');
    let server = null, redirect, hosts;
    if (redirectUri) {
      const r = new URL(redirectUri);
      if (r.protocol !== 'https:') throw new Error('an outside redirect must be https');
      redirect = r.toString();
    } else {
      server = http.createServer();
      await new Promise((res, rej) => { server.once('error', rej); server.listen(wanted, '127.0.0.1', res); });
      const port = server.address().port;
      // (Microsoft matches a loopback redirect whatever its port: registered as http://localhost)
      redirect = `http://localhost:${port}/`;
      hosts = new Set([`localhost:${port}`, `127.0.0.1:${port}`]);
    }
    const url = new URL(`${AUTHORITY}/authorize`);
    Object.entries({ client_id: id, redirect_uri: redirect, response_type: 'code', response_mode: 'query', scope: MICROSOFT_MAIL_SCOPES.join(' '), prompt: 'select_account', code_challenge: challenge, code_challenge_method: 'S256', state, ...(loginHint ? { login_hint: String(loginHint) } : {}) })
      .forEach(([k, v]) => url.searchParams.set(k, v));

    let settled = false;
    let phase = 'waiting';
    const abort = new AbortController();
    let finish;
    const done = new Promise((resolve, reject) => { finish = (err, value) => { phase = 'ended'; if (err) reject(err); else resolve(value); }; });
    done.catch(() => {});
    const shut = () => { if (server) { server.close(); server.closeAllConnections?.(); } };
    const end = (err, value) => { if (settled) return; settled = true; clearTimeout(timer); shut(); finish(err, value); };
    const timer = setTimeout(() => end(signInError(`sign-in timed out after ${Math.max(1, Math.round(timeoutMs / 60e3))} minute(s)`, 'SIGN_IN_TIMEOUT')), timeoutMs);
    timer.unref?.();
    const back = `You can close this tab and return to ${appName}.`;

    /** What Microsoft sent back, wherever it arrived: { ok, status, text } for the page that shows it. */
    async function complete({ code, state: given, error, error_description: described } = {}) {
      if (settled) return { ok: false, status: 410, text: 'This sign-in has ended.' };
      if (typeof given !== 'string' || given !== state) return { ok: false, status: 400, text: 'This is not the sign-in that was started.' };
      settled = true;
      phase = 'checking';
      clearTimeout(timer);
      const said = (ok, text) => ({ ok, status: ok ? 200 : 400, text }); // (the server, if any, shuts once it has answered)
      if (error || !code) {
        finish(signInError(`Microsoft refused: ${String(described || '').split('\r\n')[0] || error || 'no code was sent'}`, 'SIGN_IN_REFUSED'));
        return said(false, `Microsoft said: ${error || 'no code'}. ${back}`);
      }
      const cancelled = () => signInError('sign-in cancelled', 'SIGN_IN_CANCELLED');
      try {
        const t = await tokenRequest({ client_id: id, code: String(code), code_verifier: verifier, grant_type: 'authorization_code', redirect_uri: redirect, scope: MICROSOFT_MAIL_SCOPES.join(' ') }, abort.signal);
        if (abort.signal.aborted) throw cancelled();
        if (!t.refresh_token) throw signInError('Microsoft did not return a refresh token', 'SIGN_IN_FAILED');
        const who = idTokenClaims(t.id_token);
        if (!who.email || !who.id) throw signInError('Microsoft did not say who signed in', 'SIGN_IN_FAILED');
        let stored = { refresh_token: t.refresh_token, access_token: t.access_token, expires_at: Date.now() + (t.expires_in || 3600) * 1000, scope: t.scope || '', email: who.email, name: who.name, personal: who.personal, tenant: who.tenant, identity: who.id, signed_in_at: new Date().toISOString() };
        if (accept) {
          const verdict = await accept({ ...stored }, { signal: abort.signal });
          if (abort.signal.aborted) throw cancelled();
          if (typeof verdict === 'string') throw signInError(verdict, 'SIGN_IN_REJECTED');
          if (verdict !== true && !(verdict && typeof verdict === 'object')) throw signInError('the sign-in was not accepted', 'SIGN_IN_REJECTED');
          if (typeof verdict === 'object') stored = { ...verdict, ...stored };
        }
        phase = 'storing';
        await store.set(account, stored);
        finish(null, stored);
        return said(true, `Signed in to Microsoft as ${who.email}. ${back}`);
      } catch (e) {
        const err = abort.signal.aborted ? cancelled() : e.code ? e : signInError(e.message, 'SIGN_IN_FAILED');
        finish(err);
        return said(false, err.code === 'SIGN_IN_REJECTED' ? `${err.message} ${back}` : err.code === 'SIGN_IN_CANCELLED' ? `The sign-in was cancelled. ${back}` : `The sign-in could not be completed. ${back}`);
      }
    }

    server?.on('request', async (req, res) => {
      const refuse = (status, text) => res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', connection: 'close' }).end(text);
      if (settled) return refuse(410, 'This sign-in has ended.');
      if (req.method !== 'GET') return refuse(405, 'not here');
      // only this machine's own address: not a name of the web that points here
      if (!hosts.has(req.headers.host)) return refuse(400, 'wrong host');
      let q;
      try { q = new URL(req.url, redirect); } catch { return refuse(400, 'bad request'); }
      if (q.pathname !== '/') return refuse(404, 'not here');
      if (q.searchParams.get('state') !== state) return refuse(400, 'wrong state');
      const a = await complete(Object.fromEntries(['code', 'state', 'error', 'error_description'].map((k) => [k, q.searchParams.get(k) ?? undefined])));
      res.writeHead(a.status, { 'content-type': 'text/html; charset=utf-8', connection: 'close', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' }).end(endPage(a.ok, a.text));
      shut();
    });

    const cancel = () => {
      if (phase === 'waiting') { end(signInError('sign-in cancelled', 'SIGN_IN_CANCELLED')); return true; }
      if (phase === 'checking') { abort.abort(); return true; }
      return false;
    };
    return { url: url.toString(), redirectUri: redirect, state, done, cancel, complete };
  }

  /** A valid access token for the account's IMAP and SMTP, renewed when within a minute of expiry (and its refresh token with it). */
  async function accessToken(account, { force = false } = {}) {
    const t = await load(account);
    if (!t?.refresh_token) throw authError(`account "${account}" is not signed in to Microsoft — ${hint(account)}`);
    if (!force && t.access_token && t.expires_at - Date.now() > 60e3) return t.access_token;
    let fresh;
    try {
      fresh = await tokenRequest({ client_id: client(), refresh_token: t.refresh_token, grant_type: 'refresh_token', scope: MICROSOFT_MAIL_SCOPES.join(' ') });
    } catch (err) {
      if (err.oauthError === 'invalid_grant' || err.oauthError === 'interaction_required') {
        const now = await load(account);
        if (now?.refresh_token && now.refresh_token !== t.refresh_token) return accessToken(account);
        try { await change(account, (cur) => (cur?.refresh_token === t.refresh_token && !cur.refused_at ? { ...cur, refused_at: new Date().toISOString() } : undefined)); } catch { /* said below */ }
        throw authError(`Microsoft no longer accepts the sign-in for "${account}" — ${hint(account)}`);
      }
      throw err;
    }
    // written over what is stored now, only if it is still the sign-in renewed (never over a newer one, nor a removed one)
    await change(account, (now) => {
      if (now?.refresh_token !== t.refresh_token) return undefined;
      const { refused_at: _r, ...kept } = now;
      return { ...kept, access_token: fresh.access_token, refresh_token: fresh.refresh_token || now.refresh_token, expires_at: Date.now() + (fresh.expires_in || 3600) * 1000 };
    });
    return fresh.access_token;
  }

  return { accessToken, beginLogin, signedIn, signInHint: hint };
}
