// Google calendar sign-in: the OAuth client asked for when it is needed, and
// what an auth error tells the user to do. fetch is a stand-in: no network.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createMailcore, GOOGLE_SCOPES, GOOGLE_CONTACTS_SCOPES, grantedScopes, googleAccountAddress } from '../src/index.js';

const noCreds = (tokens) => ({ getPassword: async () => ({ password: 'x' }), google: { get: async (a) => tokens[a] ?? null, set: async (a, t) => { tokens[a] = t; } } });

function withFetch(answer) {
  const real = globalThis.fetch;
  const asked = [];
  globalThis.fetch = async (url, init = {}) => { asked.push({ url: String(url), body: init.body ? String(init.body) : '' }); return answer(String(url), init); };
  return { asked, restore: () => { globalThis.fetch = real; } };
}
const realFetch = globalThis.fetch;
const json = (status, data) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });

test('the OAuth client is asked for each time one is needed, not once', async (t) => {
  const tokens = { g: { refresh_token: 'r', access_token: 'old', expires_at: 0 } };
  let client = { clientId: 'first', clientSecret: 's1' };
  const core = createMailcore({ accounts: { g: { provider: 'google', email: 'me@gmail.example' } }, credentials: noCreds(tokens), google: () => client });
  const f = withFetch(() => json(200, { access_token: 'new', expires_in: 3600 }));
  t.after(f.restore);
  await core.google.accessToken('g', { force: true });
  client = { clientId: 'second', clientSecret: 's2' };
  await core.google.accessToken('g', { force: true });
  assert.deepEqual(f.asked.map((a) => new URLSearchParams(a.body).get('client_id')), ['first', 'second']);
});

test('every Google auth error ends with the hint given, and a default one without', async (t) => {
  const tokens = { g: { refresh_token: 'r', access_token: 'tok', expires_at: Date.now() + 3600e3 } };
  const hint = (a) => `run: mailwatcher google-login ${a}`;
  const core = createMailcore({ accounts: { g: { provider: 'google', email: 'me@gmail.example' }, none: { provider: 'google' } }, credentials: noCreds(tokens), google: { clientId: 'c', clientSecret: 's', signInHint: hint } });
  const f = withFetch((url) => (url.includes('oauth2') ? json(400, { error: 'invalid_grant' }) : json(401, { error: { message: 'unauthorized' } })));
  t.after(f.restore);
  await assert.rejects(core.google.accessToken('none'), (e) => e.code === 'MAIL_AUTH' && e.message === 'account "none" is not signed in to Google — run: mailwatcher google-login none');
  await assert.rejects(core.google.accessToken('g', { force: true }), (e) => e.code === 'MAIL_AUTH' && e.message.endsWith('— run: mailwatcher google-login g'));
  // the calendar API refusing a token twice (the second time with a refresh that is refused too, or not)
  tokens.g = { refresh_token: 'r', access_token: 'tok', expires_at: Date.now() + 3600e3 };
  const f2 = withFetch((url) => (url.includes('oauth2') ? json(200, { access_token: 'tok2', expires_in: 3600 }) : json(401, { error: { message: 'unauthorized' } })));
  t.after(f2.restore);
  const c = await core.client('g');
  await assert.rejects(c.findCalendars(), (e) => e.code === 'MAIL_AUTH' && e.message === 'Google no longer accepts the sign-in for "g" — run: mailwatcher google-login g');
  f2.restore();

  const plain = createMailcore({ accounts: { none: { provider: 'google' } }, credentials: noCreds({}), google: { clientId: 'c' } });
  await assert.rejects(plain.google.accessToken('none'), (e) => e.message === 'account "none" is not signed in to Google — sign in to Google again');
});

// --- the loopback sign-in ------------------------------------------------------

/** A GET to the loopback server, as a browser would send it (http, not fetch: fetch is the token endpoint's stand-in). */
function visit(url, { host } = {}) {
  const u = new URL(url);
  return new Promise((resolve, reject) => {
    const req = http.request({ host: u.hostname, port: u.port, path: u.pathname + u.search, method: 'GET', headers: { host: host ?? u.host }, agent: false }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject);
    req.end();
  });
}
const signer = (tokens = {}) => createMailcore({ accounts: { g: { provider: 'google', email: 'me@gmail.example' } }, credentials: noCreds(tokens), google: { clientId: 'cid', clientSecret: 'sec' } });
const back = (flow, params) => { const r = new URL(flow.redirectUri); for (const [k, v] of Object.entries(params)) r.searchParams.set(k, v); return r.toString(); };

test('a sign-in asks for the calendar by default, for more when told, with PKCE S256, offline, on 127.0.0.1', async () => {
  const core = signer();
  const plain = await core.google.beginLogin('g');
  const u = new URL(plain.url);
  assert.equal(u.origin + u.pathname, 'https://accounts.google.com/o/oauth2/v2/auth');
  assert.deepEqual(u.searchParams.get('scope').split(' '), GOOGLE_SCOPES);
  assert.equal(u.searchParams.get('code_challenge_method'), 'S256');
  assert.match(u.searchParams.get('code_challenge'), /^[\w-]{43}$/);
  assert.equal(u.searchParams.get('access_type'), 'offline');
  assert.match(u.searchParams.get('redirect_uri'), /^http:\/\/127\.0\.0\.1:\d+\/$/);
  assert.equal(u.searchParams.get('login_hint'), null);
  plain.cancel();
  const more = await core.google.beginLogin('g', { extraScopes: GOOGLE_CONTACTS_SCOPES, loginHint: 'me@gmail.example' });
  assert.deepEqual(new URL(more.url).searchParams.get('scope').split(' '), [...GOOGLE_SCOPES, ...GOOGLE_CONTACTS_SCOPES]);
  assert.equal(new URL(more.url).searchParams.get('login_hint'), 'me@gmail.example');
  assert.notEqual(new URL(more.url).searchParams.get('state'), u.searchParams.get('state'));
  more.cancel();
  await assert.rejects(core.google.beginLogin('g', { scopes: ['https://evil.example/scope'] }), /not a Google scope/);
});

test('the code is exchanged with the verifier, the granted scopes kept with the tokens; the tab is told to go back', async (t) => {
  const tokens = {};
  const core = signer(tokens);
  const f = withFetch(() => json(200, { access_token: 'at', refresh_token: 'rt', expires_in: 3600, scope: [...GOOGLE_SCOPES, GOOGLE_CONTACTS_SCOPES[0]].join(' ') }));
  t.after(f.restore);
  const flow = await core.google.beginLogin('g', { extraScopes: GOOGLE_CONTACTS_SCOPES, appName: 'Mail <Watcher>' });
  const state = new URL(flow.url).searchParams.get('state');
  const page = await visit(back(flow, { state, code: 'the-code' }));
  assert.equal(page.status, 200);
  assert.match(page.body, /return to Mail &lt;Watcher&gt;\./);
  const stored = await flow.done;
  assert.equal(stored.refresh_token, 'rt');
  assert.deepEqual(grantedScopes(tokens.g), [...GOOGLE_SCOPES, GOOGLE_CONTACTS_SCOPES[0]]);
  const sent = new URLSearchParams(f.asked[0].body);
  assert.equal(f.asked[0].url, 'https://oauth2.googleapis.com/token');
  assert.equal(sent.get('code'), 'the-code');
  assert.equal(sent.get('grant_type'), 'authorization_code');
  assert.equal(sent.get('redirect_uri'), flow.redirectUri);
  // the verifier is the one whose S256 is the challenge sent to Google
  const { createHash } = await import('node:crypto');
  assert.equal(createHash('sha256').update(sent.get('code_verifier')).digest('base64url'), new URL(flow.url).searchParams.get('code_challenge'));
  assert.deepEqual(await core.google.tokens('g'), { scopes: [...GOOGLE_SCOPES, GOOGLE_CONTACTS_SCOPES[0]], signedInAt: stored.signed_in_at });
  // single use: the server is gone
  await assert.rejects(visit(back(flow, { state, code: 'again' })), /ECONNREFUSED|ECONNRESET/);
});

test('a wrong state, another path or another Host is refused and the sign-in goes on; then the right one ends it', async (t) => {
  const tokens = { g: { refresh_token: 'old', scope: GOOGLE_SCOPES.join(' ') } };
  const core = signer(tokens);
  const f = withFetch(() => json(200, { access_token: 'at', refresh_token: 'new', expires_in: 3600, scope: GOOGLE_SCOPES.join(' ') }));
  t.after(f.restore);
  const flow = await core.google.beginLogin('g');
  const state = new URL(flow.url).searchParams.get('state');
  assert.equal((await visit(back(flow, { state: 'not-it', code: 'c' }))).status, 400);
  assert.equal((await visit(back(flow, { state, code: 'c' }).replace(/\/\?/, '/elsewhere?'))).status, 404);
  // a page of the web reaching this port through a name of its own that points at 127.0.0.1
  assert.equal((await visit(back(flow, { state, code: 'c' }), { host: 'evil.example:' + new URL(flow.redirectUri).port })).status, 400);
  assert.equal((await visit(back(flow, { state, code: 'c' }), { host: 'localhost:' + new URL(flow.redirectUri).port })).status, 400);
  assert.equal(f.asked.length, 0, 'nothing was exchanged');
  assert.equal(tokens.g.refresh_token, 'old', 'the tokens before are kept meanwhile');
  assert.equal((await visit(back(flow, { state, code: 'c' }))).status, 200);
  assert.equal((await flow.done).refresh_token, 'new');
});

test('Google saying no ends the sign-in, tells the tab, and keeps the tokens before', async () => {
  const tokens = { g: { refresh_token: 'old' } };
  const core = signer(tokens);
  const flow = await core.google.beginLogin('g', { appName: 'Mail Watcher' });
  const state = new URL(flow.url).searchParams.get('state');
  const page = await visit(back(flow, { state, error: 'access_denied' }));
  assert.equal(page.status, 400);
  assert.match(page.body, /access_denied\. You can close this tab and return to Mail Watcher\./);
  await assert.rejects(flow.done, (e) => e.code === 'SIGN_IN_REFUSED');
  assert.equal(tokens.g.refresh_token, 'old');
});

test('a code that cannot be exchanged fails the sign-in, and the tab says so', async (t) => {
  const core = signer();
  const f = withFetch(() => json(400, { error: 'invalid_grant' }));
  t.after(f.restore);
  const flow = await core.google.beginLogin('g');
  const page = await visit(back(flow, { state: new URL(flow.url).searchParams.get('state'), code: 'stale' }));
  assert.equal(page.status, 400);
  assert.match(page.body, /could not be completed/);
  await assert.rejects(flow.done, (e) => e.code === 'SIGN_IN_FAILED' && /invalid_grant/.test(e.message));
});

test('a sign-in left alone times out, and a cancelled one ends at once; both close the port', async () => {
  const core = signer();
  const slow = await core.google.beginLogin('g', { timeoutMs: 50 });
  await assert.rejects(slow.done, (e) => e.code === 'SIGN_IN_TIMEOUT');
  await assert.rejects(visit(slow.redirectUri), /ECONNREFUSED|ECONNRESET/);
  const gone = await core.google.beginLogin('g');
  assert.equal(gone.cancel(), true);
  await assert.rejects(gone.done, (e) => e.code === 'SIGN_IN_CANCELLED');
  await assert.rejects(visit(back(gone, { state: new URL(gone.url).searchParams.get('state'), code: 'c' })), /ECONNREFUSED|ECONNRESET/);
  assert.equal(gone.cancel(), false, 'twice: nothing more');
});

test('a renewal Google refuses is noted with the tokens (until the next sign-in); one that works clears it and keeps the scopes Google names', async (t) => {
  const tokens = { g: { refresh_token: 'r', access_token: 'old', expires_at: 0, scope: GOOGLE_SCOPES.join(' ') } };
  const core = signer(tokens);
  const f = withFetch(() => json(400, { error: 'invalid_grant' }));
  t.after(f.restore);
  await assert.rejects(core.google.accessToken('g'), (e) => e.code === 'MAIL_AUTH');
  const at = tokens.g.refused_at;
  assert.ok(at);
  assert.equal((await core.google.tokens('g')).refusedAt, at);
  await assert.rejects(core.google.accessToken('g'));
  assert.equal(tokens.g.refused_at, at, 'noted once');
  f.restore();
  const ok = withFetch(() => json(200, { access_token: 'fresh', expires_in: 3600, scope: [...GOOGLE_SCOPES, ...GOOGLE_CONTACTS_SCOPES].join(' ') }));
  t.after(ok.restore);
  assert.equal(await core.google.accessToken('g'), 'fresh');
  assert.equal(tokens.g.refused_at, undefined);
  assert.deepEqual(grantedScopes(tokens.g), [...GOOGLE_SCOPES, ...GOOGLE_CONTACTS_SCOPES]);
  assert.equal(await core.google.tokens('none'), null);
});

test('accept: a string stores nothing and tells the tab why; an object is kept beside the tokens, never over them', async (t) => {
  const tokens = { g: { refresh_token: 'old' } };
  const core = signer(tokens);
  withFetch(() => json(200, { access_token: 'at', refresh_token: 'new', expires_in: 3600, scope: GOOGLE_SCOPES.join(' ') }));
  t.after(() => { globalThis.fetch = realFetch; });
  const seen = [];
  const no = await core.google.beginLogin('g', { appName: 'Mail Watcher', accept: async (tk) => { seen.push(tk.access_token); return 'You signed in to Google as b@x.example; this account is a@x.example. Sign in with a@x.example.'; } });
  const page = await visit(back(no, { state: new URL(no.url).searchParams.get('state'), code: 'c' }));
  assert.equal(page.status, 400);
  assert.match(page.body, /You signed in to Google as b@x\.example; this account is a@x\.example\. Sign in with a@x\.example\. You can close this tab/);
  await assert.rejects(no.done, (e) => e.code === 'SIGN_IN_REJECTED' && /as b@x\.example/.test(e.message));
  assert.deepEqual(seen, ['at']);
  assert.equal(tokens.g.refresh_token, 'old', 'nothing stored');

  const yes = await core.google.beginLogin('g', { accept: async () => ({ email: 'a@x.example', refresh_token: 'forged' }) });
  await visit(back(yes, { state: new URL(yes.url).searchParams.get('state'), code: 'c' }));
  await yes.done;
  assert.equal(tokens.g.refresh_token, 'new');
  assert.equal(tokens.g.email, 'a@x.example');
});
test('cancel while the code is exchanged aborts it: nothing stored; once storing, cancel says no and the outcome lands', async (t) => {
  const tokens = { g: { refresh_token: 'old' } };
  let release;
  const store = { get: async (a) => tokens[a] ?? null, set: async (a, v) => { await new Promise((r) => { release = r; }); tokens[a] = v; } };
  const core = createMailcore({ accounts: { g: { provider: 'google' } }, credentials: { getPassword: async () => ({ password: 'x' }), google: store }, google: { clientId: 'cid' } });
  let aborted = false;
  globalThis.fetch = (url, init) => new Promise((resolve, reject) => {
    init.signal.addEventListener('abort', () => { aborted = true; reject(init.signal.reason); });
    setTimeout(() => resolve(json(200, { access_token: 'at', refresh_token: 'new', expires_in: 3600 })), 200);
  });
  t.after(() => { globalThis.fetch = realFetch; });
  const flow = await core.google.beginLogin('g');
  const visited = visit(back(flow, { state: new URL(flow.url).searchParams.get('state'), code: 'c' }));
  await new Promise((r) => setTimeout(r, 30)); // the callback is in, the exchange under way
  assert.equal(flow.cancel(), true);
  await assert.rejects(flow.done, (e) => e.code === 'SIGN_IN_CANCELLED');
  assert.ok(aborted, 'the token request was aborted');
  assert.match((await visited).body, /cancelled/);
  assert.equal(tokens.g.refresh_token, 'old');

  globalThis.fetch = async () => json(200, { access_token: 'at', refresh_token: 'new', expires_in: 3600 });
  const late = await core.google.beginLogin('g');
  const v2 = visit(back(late, { state: new URL(late.url).searchParams.get('state'), code: 'c' }));
  while (!release) await new Promise((r) => setTimeout(r, 5));
  assert.equal(late.cancel(), false, 'being stored: no longer stopped');
  release();
  assert.equal((await late.done).refresh_token, 'new');
  assert.equal((await v2).status, 200);
  assert.equal(late.cancel(), false);
});

test('a renewal never writes over a newer sign-in', async (t) => {
  const tokens = { g: { refresh_token: 'r1', access_token: 'old', expires_at: 0 } };
  const core = signer(tokens);
  // the refresh answers after a new sign-in replaced the tokens
  globalThis.fetch = async () => { tokens.g = { refresh_token: 'r2', access_token: 'newer', expires_at: Date.now() + 3600e3 }; return json(200, { access_token: 'from-r1', expires_in: 3600 }); };
  t.after(() => { globalThis.fetch = realFetch; });
  assert.equal(await core.google.accessToken('g'), 'from-r1');
  assert.deepEqual([tokens.g.refresh_token, tokens.g.access_token], ['r2', 'newer']);
  // refused, but a new sign-in came meanwhile: not marked refused, and the new one's token is used
  tokens.g = { refresh_token: 'r1', access_token: 'old', expires_at: 0 };
  globalThis.fetch = async () => { tokens.g = { refresh_token: 'r3', access_token: 'fresh3', expires_at: Date.now() + 3600e3 }; return json(400, { error: 'invalid_grant' }); };
  assert.equal(await core.google.accessToken('g'), 'fresh3');
  assert.equal(tokens.g.refused_at, undefined);
});

test('the Google address of a token: its primary calendar\'s id, or null', async (t) => {
  const asked = [];
  globalThis.fetch = async (url, init) => { asked.push([String(url), init.headers.authorization]); return json(200, { id: 'Me@Gmail.example', summary: 'Me' }); };
  t.after(() => { globalThis.fetch = realFetch; });
  assert.equal(await googleAccountAddress('tok'), 'Me@Gmail.example');
  assert.deepEqual(asked, [['https://www.googleapis.com/calendar/v3/calendars/primary', 'Bearer tok']]);
  globalThis.fetch = async () => json(403, { error: { message: 'insufficient' } });
  assert.equal(await googleAccountAddress('tok'), null);
  globalThis.fetch = async () => json(200, { id: 'not an address' });
  assert.equal(await googleAccountAddress('tok'), null);
});
