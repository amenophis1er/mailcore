// Google sign-in for calendar accounts: OAuth 2.0 with PKCE and a loopback
// redirect (the flow Google prescribes for installed apps), and access
// tokens renewed as needed.
//
// Nothing is stored here: the caller passes a token store { get(account),
// set(account, tokens) } (sync or async) and the OAuth client (clientId /
// clientSecret of a Google Cloud Desktop client). A Desktop client's secret is
// not confidential by Google's own definition — PKCE and the loopback
// redirect are what protect the sign-in.

import http from 'node:http';
import { createHash, randomBytes } from 'node:crypto';

export const GOOGLE_SCOPES = [
  'https://www.googleapis.com/auth/calendar.events',
  'https://www.googleapis.com/auth/calendar.calendarlist.readonly',
  'https://www.googleapis.com/auth/calendar.calendars.readonly',
  'https://www.googleapis.com/auth/calendar.freebusy'
];
const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';

function authError(message) {
  const e = new Error(message);
  e.code = 'MAIL_AUTH';
  return e;
}

/** What a Google auth error tells the user to do, by default. */
export const DEFAULT_SIGN_IN_HINT = () => 'sign in to Google again';

/**
 * googleAuth({ store, clientId, clientSecret, client, signInHint }) → { accessToken, login, signedIn, signInHint }.
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
   * Interactive sign-in: hands the consent URL to openUrl (and log), waits for
   * Google on 127.0.0.1, exchanges the code and stores the tokens.
   */
  async function login(account, { openUrl, log = () => {}, timeoutMs = 10 * 60e3 } = {}) {
    const { clientId, clientSecret } = client();
    const store = tokenStore();
    const verifier = randomBytes(48).toString('base64url');
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    const state = randomBytes(16).toString('hex');
    const server = http.createServer();
    await new Promise((res) => server.listen(0, '127.0.0.1', res));
    const port = server.address().port;
    const redirect = `http://127.0.0.1:${port}/`;
    const url = new URL(AUTH_URL);
    Object.entries({ client_id: clientId, redirect_uri: redirect, response_type: 'code', scope: GOOGLE_SCOPES.join(' '), access_type: 'offline', prompt: 'consent', code_challenge: challenge, code_challenge_method: 'S256', state })
      .forEach(([k, v]) => url.searchParams.set(k, v));
    log(`Open this address to sign in (${account}):\n  ${url}`);
    if (openUrl) { try { openUrl(url.toString()); } catch {} }
    const code = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { server.close(); reject(new Error(`sign-in timed out after ${Math.round(timeoutMs / 60e3)} minutes`)); }, timeoutMs);
      server.on('request', (req, res) => {
        const q = new URL(req.url, redirect).searchParams;
        if (q.get('state') !== state) { res.writeHead(400).end('wrong state'); return; }
        if (q.get('error')) { res.writeHead(200, { 'content-type': 'text/plain' }).end(`Google said: ${q.get('error')}. You can close this tab.`); clearTimeout(timer); server.close(); reject(new Error(`Google refused: ${q.get('error')}`)); return; }
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end('<p style="font-family:sans-serif">Signed in. You can close this tab.</p>');
        clearTimeout(timer); server.close(); resolve(q.get('code'));
      });
    });
    const tokens = await tokenRequest({ client_id: clientId, client_secret: clientSecret, code, code_verifier: verifier, grant_type: 'authorization_code', redirect_uri: redirect });
    if (!tokens.refresh_token) throw new Error('Google did not return a refresh token — remove the app at myaccount.google.com/connections and sign in again');
    const stored = { refresh_token: tokens.refresh_token, access_token: tokens.access_token, expires_at: Date.now() + (tokens.expires_in || 3600) * 1000, scope: tokens.scope, signed_in_at: new Date().toISOString() };
    await store.set(account, stored);
    return stored;
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
      if (/invalid_grant/.test(err.message)) throw authError(`Google no longer accepts the sign-in for "${account}" — ${hint(account)}`);
      throw err;
    }
    await tokenStore().set(account, { ...t, access_token: fresh.access_token, expires_at: Date.now() + (fresh.expires_in || 3600) * 1000 });
    return fresh.access_token;
  }

  return { accessToken, login, signedIn, signInHint: hint };
}

async function tokenRequest(params) {
  const res = await fetch(TOKEN_URL, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(params).toString(), signal: AbortSignal.timeout(20000) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Google token endpoint answered ${res.status}: ${data.error || ''} ${data.error_description || ''}`.trim());
  return data;
}
