// Google sign-in for calendar accounts: OAuth 2.0 with PKCE and a loopback
// redirect (the flow Google prescribes for installed apps), and access
// tokens renewed as needed. A sign-in asks for the calendar (GOOGLE_SCOPES)
// unless the caller names other scopes (contacts: GOOGLE_CONTACTS_SCOPES);
// the scopes Google granted are kept with the tokens (`scope`).
//
// Nothing is stored here: the caller passes a token store { get(account),
// set(account, tokens) } (sync or async) and the OAuth client (clientId /
// clientSecret of a Google Cloud Desktop client). A Desktop client's secret is
// not confidential by Google's own definition — PKCE and the loopback
// redirect are what protect the sign-in.

import http from 'node:http';
import { createHash, randomBytes } from 'node:crypto';

/** What a calendar account asks for (the default of a sign-in). */
export const GOOGLE_SCOPES = [
  'https://www.googleapis.com/auth/calendar.events',
  'https://www.googleapis.com/auth/calendar.calendarlist.readonly',
  'https://www.googleapis.com/auth/calendar.calendars.readonly',
  'https://www.googleapis.com/auth/calendar.freebusy'
];
/** Reading the contacts (People API): one's own, and "other contacts" (the people one wrote to). */
export const GOOGLE_CONTACTS_SCOPES = [
  'https://www.googleapis.com/auth/contacts.readonly',
  'https://www.googleapis.com/auth/contacts.other.readonly'
];
/** Reading and adding one's own contacts (it holds contacts.readonly's reading): asked in its place to add contacts. */
export const GOOGLE_CONTACTS_WRITE_SCOPE = 'https://www.googleapis.com/auth/contacts';
/** Contacts read and written: the write scope with "other contacts" (what a sign-in asks for to read and add contacts). */
export const GOOGLE_CONTACTS_WRITE_SCOPES = [GOOGLE_CONTACTS_WRITE_SCOPE, GOOGLE_CONTACTS_SCOPES[1]];

/**
 * What granted scopes allow of the contacts: `read` (one's own, by contacts.readonly or contacts, and the other
 * contacts), `write` (adding one's own: contacts).
 */
export function contactsAllowed(scopes) {
  const has = (s) => Array.isArray(scopes) && scopes.includes(s);
  return { read: (has(GOOGLE_CONTACTS_SCOPES[0]) || has(GOOGLE_CONTACTS_WRITE_SCOPE)) && has(GOOGLE_CONTACTS_SCOPES[1]), write: has(GOOGLE_CONTACTS_WRITE_SCOPE) };
}
const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const PRIMARY_URL = 'https://www.googleapis.com/calendar/v3/calendars/primary';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SCOPE = /^https:\/\/www\.googleapis\.com\/auth\/[\w.-]+$|^(openid|email|profile)$/;

function authError(message) {
  const e = new Error(message);
  e.code = 'MAIL_AUTH';
  return e;
}
function signInError(message, code) {
  const e = new Error(message);
  e.code = code;
  return e;
}

/**
 * The address of the Google account an access token is for: its primary
 * calendar's id (calendars.get, which calendar.calendars.readonly allows).
 * null when Google does not say (that scope not granted, an error).
 */
export async function googleAccountAddress(accessToken, { signal } = {}) {
  try {
    const res = await fetch(PRIMARY_URL, { headers: { authorization: `Bearer ${accessToken}` }, signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(20000)]) : AbortSignal.timeout(20000) });
    if (!res.ok) return null;
    const id = (await res.json().catch(() => ({})))?.id;
    return typeof id === 'string' && /^[^\s@<>"]{1,64}@[^\s@<>"]{1,253}$/.test(id) ? id : null;
  } catch (e) {
    if (signal?.aborted) throw e;
    return null;
  }
}

/** What a Google auth error tells the user to do, by default. */
export const DEFAULT_SIGN_IN_HINT = () => 'sign in to Google again';

/** The scopes stored tokens were granted (their `scope`, space-separated), as a list; [] when unknown. */
export function grantedScopes(tokens) {
  return typeof tokens?.scope === 'string' ? tokens.scope.split(/\s+/).filter(Boolean) : [];
}

/** The scopes a sign-in asks for: `scopes` (default GOOGLE_SCOPES) and `extraScopes`, each once. */
function scopesOf({ scopes, extraScopes } = {}) {
  const list = [...(scopes ?? GOOGLE_SCOPES), ...(extraScopes ?? [])];
  for (const s of list) if (typeof s !== 'string' || !SCOPE.test(s)) throw new Error(`not a Google scope: ${String(s).slice(0, 100)}`);
  if (!list.length) throw new Error('a Google sign-in asks for at least one scope');
  return [...new Set(list)];
}

const escapeHtml = (v) => String(v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** The page the browser tab shows at the end of a sign-in. */
function endPage(ok, text) {
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${ok ? 'Signed in' : 'Not signed in'}</title>
<body style="font:16px/1.5 system-ui,sans-serif;max-width:32em;margin:15vh auto;padding:0 16px;color:#222"><h1 style="font-size:20px">${ok ? 'Signed in' : 'Not signed in'}</h1><p>${escapeHtml(text)}</p></body>`;
}

/**
 * googleAuth({ store, clientId, clientSecret, client, signInHint }) → { accessToken, login, beginLogin, signedIn, tokens, signInHint }.
 * `client`: a function returning { clientId, clientSecret }, asked each time
 * one is needed (instead of clientId/clientSecret, fixed). `signInHint(account)`:
 * what an auth error tells the user to do ("sign in to Google again").
 * `store` and the client are only needed once a Google account is used.
 */
export function googleAuth({ store, clientId, clientSecret, client: clientOf, signInHint = DEFAULT_SIGN_IN_HINT } = {}) {
  const client = () => {
    const c = typeof clientOf === 'function' ? clientOf() || {} : { clientId, clientSecret };
    if (!c.clientId) throw new Error('Google calendar: no OAuth client configured (pass google: { clientId, clientSecret } to createMailcore)');
    return { clientId: c.clientId, clientSecret: c.clientSecret };
  };
  const hint = (account) => { try { return String(signInHint(account) || DEFAULT_SIGN_IN_HINT(account)); } catch { return DEFAULT_SIGN_IN_HINT(account); } };
  const tokenStore = () => {
    if (!store || typeof store.get !== 'function' || typeof store.set !== 'function') throw new Error('Google calendar: no token store (pass credentials.google: { get, set } to createMailcore)');
    return store;
  };
  const load = async (account) => {
    const t = await tokenStore().get(account);
    if (!t) return null;
    if (typeof t === 'string') { try { return JSON.parse(t); } catch { return null; } }
    return t;
  };

  /** Whether the account holds a refresh token. */
  async function signedIn(account) {
    try { return !!(await load(account))?.refresh_token; } catch { return false; }
  }

  /**
   * What is known of an account's sign-in, without a secret: whether it holds
   * a refresh token, the scopes granted, when it signed in, and whether Google
   * refused it since (`refusedAt`: an invalid_grant on renewal). null: none.
   */
  async function tokens(account) {
    let t;
    try { t = await load(account); } catch { return null; }
    if (!t?.refresh_token) return null;
    return { scopes: grantedScopes(t), ...(t.signed_in_at ? { signedInAt: t.signed_in_at } : {}), ...(t.refused_at ? { refusedAt: t.refused_at } : {}) };
  }

  /**
   * Start an interactive sign-in: a one-time server on 127.0.0.1 (a port of
   * the system's choosing) waits for Google's redirect. Returns at once with
   * { url, redirectUri, scopes, done, cancel }: `url` is the consent page to
   * open; `done` settles once the sign-in ended — with the stored tokens, or an
   * error whose code says why (SIGN_IN_TIMEOUT, SIGN_IN_CANCELLED,
   * SIGN_IN_REFUSED: Google or the person said no, SIGN_IN_REJECTED: `accept`
   * said no, SIGN_IN_FAILED: the code could not be exchanged). `cancel()` ends
   * it and says whether it did: true while Google has not answered, or while
   * the code is being exchanged and checked (that is aborted, nothing is
   * stored); false once the tokens are being stored (or it ended already) —
   * `done` then gives the real outcome.
   *
   * Only one request is answered as the sign-in: a GET of "/" with the Host
   * the redirect names and the state sent to Google. Anything else (another
   * path, another Host — a page of the web reaching 127.0.0.1 through a name of
   * its own — a wrong state) is refused without ending it. The tokens stored
   * replace the ones before only once the code was exchanged.
   *
   * opts: scopes (default GOOGLE_SCOPES), extraScopes, loginHint (the address
   * to sign in as, preselected), timeoutMs (default 10 minutes), appName (what
   * the page shown at the end tells to go back to), accept(tokens, { signal })
   * (called after the exchange, before anything is stored: true to store them,
   * a string — why not — to store nothing, or an object of fields to keep with
   * them, such as the Google address; `signal` aborts with a cancel).
   */
  async function beginLogin(account, { scopes, extraScopes, loginHint, timeoutMs = 10 * 60e3, appName = 'the app', accept } = {}) {
    const { clientId, clientSecret } = client();
    const store = tokenStore();
    const asked = scopesOf({ scopes, extraScopes });
    const verifier = randomBytes(48).toString('base64url');
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    const state = randomBytes(16).toString('hex');
    const server = http.createServer();
    await new Promise((res, rej) => { server.once('error', rej); server.listen(0, '127.0.0.1', res); });
    const port = server.address().port;
    const host = `127.0.0.1:${port}`;
    const redirect = `http://${host}/`;
    const url = new URL(AUTH_URL);
    Object.entries({ client_id: clientId, redirect_uri: redirect, response_type: 'code', scope: asked.join(' '), access_type: 'offline', prompt: 'consent', code_challenge: challenge, code_challenge_method: 'S256', state, ...(loginHint ? { login_hint: String(loginHint) } : {}) })
      .forEach(([k, v]) => url.searchParams.set(k, v));

    let settled = false;
    let phase = 'waiting'; // → 'checking' (the code being exchanged and checked: abortable) → 'storing' → 'ended'
    const abort = new AbortController();
    let finish;
    const done = new Promise((resolve, reject) => { finish = (err, value) => { phase = 'ended'; if (err) reject(err); else resolve(value); }; });
    done.catch(() => {}); // a caller that only polls is not an unhandled rejection
    const shut = () => { server.close(); server.closeAllConnections?.(); };
    const end = (err, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      shut();
      finish(err, value);
    };
    const timer = setTimeout(() => end(signInError(`sign-in timed out after ${Math.max(1, Math.round(timeoutMs / 60e3))} minute(s)`, 'SIGN_IN_TIMEOUT')), timeoutMs);
    timer.unref?.();
    const back = `You can close this tab and return to ${appName}.`;

    server.on('request', async (req, res) => {
      const refuse = (status, text) => res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', connection: 'close' }).end(text);
      if (settled) return refuse(410, 'This sign-in has ended.');
      if (req.method !== 'GET') return refuse(405, 'not here');
      // only this machine's own address, as the redirect names it: not a name of the web that points here
      if (req.headers.host !== host) return refuse(400, 'wrong host');
      let q;
      try { q = new URL(req.url, redirect); } catch { return refuse(400, 'bad request'); }
      if (q.pathname !== '/') return refuse(404, 'not here');
      if (q.searchParams.get('state') !== state) return refuse(400, 'wrong state');
      // the one answer: whatever follows is refused
      settled = true;
      phase = 'checking';
      clearTimeout(timer);
      const page = (ok, text) => res.writeHead(ok ? 200 : 400, { 'content-type': 'text/html; charset=utf-8', connection: 'close', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' }).end(endPage(ok, text));
      const error = q.searchParams.get('error');
      const code = q.searchParams.get('code');
      if (error || !code) {
        page(false, `Google said: ${error || 'no code'}. ${back}`);
        shut();
        return finish(signInError(`Google refused: ${error || 'no code was sent'}`, 'SIGN_IN_REFUSED'));
      }
      const cancelled = () => signInError('sign-in cancelled', 'SIGN_IN_CANCELLED');
      try {
        const t = await tokenRequest({ client_id: clientId, client_secret: clientSecret, code, code_verifier: verifier, grant_type: 'authorization_code', redirect_uri: redirect }, abort.signal);
        if (abort.signal.aborted) throw cancelled();
        if (!t.refresh_token) throw signInError('Google did not return a refresh token — remove the app at myaccount.google.com/connections and sign in again', 'SIGN_IN_FAILED');
        let stored = { refresh_token: t.refresh_token, access_token: t.access_token, expires_at: Date.now() + (t.expires_in || 3600) * 1000, ...(t.scope ? { scope: t.scope } : {}), signed_in_at: new Date().toISOString() };
        if (accept) {
          const verdict = await accept({ ...stored }, { signal: abort.signal });
          if (abort.signal.aborted) throw cancelled();
          if (typeof verdict === 'string') throw signInError(verdict, 'SIGN_IN_REJECTED');
          if (verdict !== true && !(verdict && typeof verdict === 'object')) throw signInError('the sign-in was not accepted', 'SIGN_IN_REJECTED');
          if (typeof verdict === 'object') stored = { ...verdict, ...stored }; // kept beside the tokens, never over them
        }
        // from here it can no longer be cancelled: the outcome is what is stored
        phase = 'storing';
        await store.set(account, stored);
        page(true, `Signed in to Google. ${back}`);
        shut();
        finish(null, stored);
      } catch (e) {
        const err = abort.signal.aborted ? cancelled() : e.code ? e : signInError(e.message, 'SIGN_IN_FAILED');
        page(false, err.code === 'SIGN_IN_REJECTED' ? `${err.message} ${back}` : err.code === 'SIGN_IN_CANCELLED' ? `The sign-in was cancelled. ${back}` : `The sign-in could not be completed. ${back}`);
        shut();
        finish(err);
      }
    });

    const cancel = () => {
      if (phase === 'waiting') { end(signInError('sign-in cancelled', 'SIGN_IN_CANCELLED')); return true; }
      if (phase === 'checking') { abort.abort(); return true; }
      return false; // being stored, or ended: `done` says how
    };
    return { url: url.toString(), redirectUri: redirect, scopes: asked, done, cancel };
  }

  /**
   * Interactive sign-in: hands the consent URL to openUrl (and log), waits for
   * Google on 127.0.0.1, exchanges the code and stores the tokens. Takes the
   * options of beginLogin.
   */
  async function login(account, { openUrl, log = () => {}, ...opts } = {}) {
    const flow = await beginLogin(account, opts);
    log(`Open this address to sign in (${account}):\n  ${flow.url}`);
    if (openUrl) { try { openUrl(flow.url); } catch {} }
    return flow.done;
  }

  /** A valid access token for the account, refreshed when within a minute of expiry. */
  async function accessToken(account, { force = false } = {}) {
    const t = await load(account);
    if (!t?.refresh_token) throw authError(`account "${account}" is not signed in to Google — ${hint(account)}`);
    if (!force && t.access_token && t.expires_at - Date.now() > 60e3) return t.access_token;
    const { clientId, clientSecret } = client();
    let fresh;
    try {
      fresh = await tokenRequest({ client_id: clientId, client_secret: clientSecret, refresh_token: t.refresh_token, grant_type: 'refresh_token' });
    } catch (err) {
      if (/invalid_grant/.test(err.message)) {
        // a sign-in since replaced the tokens that were refused: those are the account's now
        const now = await load(account);
        if (now?.refresh_token && now.refresh_token !== t.refresh_token) return accessToken(account, { force: false });
        // noted once, with the tokens: what the account's status shows ("sign-in expired") until it signs in again
        if (now && !now.refused_at) { try { await tokenStore().set(account, { ...now, refused_at: new Date().toISOString() }); } catch { /* the error below says it */ } }
        throw authError(`Google no longer accepts the sign-in for "${account}" — ${hint(account)}`);
      }
      throw err;
    }
    // written over what is stored now, and only if it is still the sign-in renewed: never over a newer one
    const now = await load(account);
    if (now?.refresh_token !== t.refresh_token) return fresh.access_token;
    const { refused_at: _r, ...kept } = now;
    await tokenStore().set(account, { ...kept, access_token: fresh.access_token, expires_at: Date.now() + (fresh.expires_in || 3600) * 1000, ...(fresh.scope ? { scope: fresh.scope } : {}) });
    return fresh.access_token;
  }

  return { accessToken, login, beginLogin, signedIn, tokens, signInHint: hint };
}

async function tokenRequest(params, signal) {
  const res = await fetch(TOKEN_URL, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(params).toString(), signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(20000)]) : AbortSignal.timeout(20000) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Google token endpoint answered ${res.status}: ${data.error || ''} ${data.error_description || ''}`.trim());
  return data;
}
