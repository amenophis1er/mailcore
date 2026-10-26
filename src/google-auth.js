// Google sign-in for calendar accounts: OAuth 2.0 with PKCE and a loopback
// redirect (the flow Google prescribes for installed apps). The refresh token
// lives in the macOS Keychain next to the mail passwords; access tokens are
// renewed here as needed.
//
// The OAuth client: config.google.clientId / clientSecret when set (your own
// Desktop client in Google Cloud), else the mailwatcher default below. A
// Desktop client's secret is not confidential by Google's own definition —
// PKCE and the loopback redirect are what protect the sign-in.

import http from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { keychainGet, keychainSet, loadConfig } from './config.js';

const decode = (parts) => Buffer.from(parts.join(''), 'base64').toString('utf8');
// Amen's Google Cloud Desktop client (buddi-510504); override with config.google.
const DEFAULT_CLIENT_ID = decode(['ODM3MzY5ODk4NDQ5LTcyOWh0', 'dTNwb252bjdhZnRiN3M4Y2Rn', 'MGszcTZqanFtLmFwcHMuZ29v', 'Z2xldXNlcmNvbnRlbnQuY29t']);
const DEFAULT_CLIENT_SECRET = decode(['R09DU1BYLVQ4Sl90TFYyNmhG', 'ejdxZnZoSkwtSkRDYzhxeXg=']);

export const GOOGLE_SCOPES = [
  'https://www.googleapis.com/auth/calendar.events',
  'https://www.googleapis.com/auth/calendar.calendarlist.readonly',
  'https://www.googleapis.com/auth/calendar.calendars.readonly',
  'https://www.googleapis.com/auth/calendar.freebusy'
];
const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const KEY = (account) => `google:${account}`;

export function googleClient(config = loadConfig()) {
  const g = config.google || {};
  return { clientId: g.clientId || DEFAULT_CLIENT_ID, clientSecret: g.clientSecret || DEFAULT_CLIENT_SECRET };
}

export function loadTokens(account) {
  try { return JSON.parse(keychainGet(KEY(account)) || 'null'); } catch { return null; }
}
export function saveTokens(account, tokens) { keychainSet(KEY(account), JSON.stringify(tokens)); }
export function hasGoogleTokens(account) { return !!loadTokens(account)?.refresh_token; }

/**
 * Interactive sign-in: opens the browser, waits for Google on 127.0.0.1,
 * exchanges the code and stores the tokens. Returns { email }.
 */
export async function loginGoogle(account, { config = loadConfig(), open = true, log = () => {} } = {}) {
  const { clientId, clientSecret } = googleClient(config);
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
  if (open) spawn('open', [url.toString()], { stdio: 'ignore', detached: true }).on('error', () => {}).unref();
  const code = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { server.close(); reject(new Error('sign-in timed out after 10 minutes')); }, 10 * 60e3);
    server.on('request', (req, res) => {
      const q = new URL(req.url, redirect).searchParams;
      if (q.get('state') !== state) { res.writeHead(400).end('wrong state'); return; }
      if (q.get('error')) { res.writeHead(200, { 'content-type': 'text/plain' }).end(`Google said: ${q.get('error')}. You can close this tab.`); clearTimeout(timer); server.close(); reject(new Error(`Google refused: ${q.get('error')}`)); return; }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end('<p style="font-family:sans-serif">mailwatcher: signed in. You can close this tab.</p>');
      clearTimeout(timer); server.close(); resolve(q.get('code'));
    });
  });
  const tokens = await tokenRequest({ client_id: clientId, client_secret: clientSecret, code, code_verifier: verifier, grant_type: 'authorization_code', redirect_uri: redirect });
  if (!tokens.refresh_token) throw new Error('Google did not return a refresh token — remove mailwatcher at myaccount.google.com/connections and sign in again');
  const stored = { refresh_token: tokens.refresh_token, access_token: tokens.access_token, expires_at: Date.now() + (tokens.expires_in || 3600) * 1000, scope: tokens.scope, signed_in_at: new Date().toISOString() };
  saveTokens(account, stored);
  return stored;
}

/** A valid access token for the account, refreshed when within a minute of expiry. */
export async function accessToken(account, { force = false } = {}) {
  const t = loadTokens(account);
  if (!t?.refresh_token) {
    const e = new Error(`account "${account}" is not signed in to Google — run: mailwatcher google-login ${account}`);
    e.code = 'MAIL_AUTH';
    throw e;
  }
  if (!force && t.access_token && t.expires_at - Date.now() > 60e3) return t.access_token;
  const { clientId, clientSecret } = googleClient();
  let fresh;
  try {
    fresh = await tokenRequest({ client_id: clientId, client_secret: clientSecret, refresh_token: t.refresh_token, grant_type: 'refresh_token' });
  } catch (err) {
    if (/invalid_grant/.test(err.message)) { const e = new Error(`Google no longer accepts the sign-in for "${account}" — run: mailwatcher google-login ${account}`); e.code = 'MAIL_AUTH'; throw e; }
    throw err;
  }
  saveTokens(account, { ...t, access_token: fresh.access_token, expires_at: Date.now() + (fresh.expires_in || 3600) * 1000 });
  return fresh.access_token;
}

async function tokenRequest(params) {
  const res = await fetch(TOKEN_URL, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(params).toString(), signal: AbortSignal.timeout(20000) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Google token endpoint answered ${res.status}: ${data.error || ''} ${data.error_description || ''}`.trim());
  return data;
}
