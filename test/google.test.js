// Google calendar sign-in: the OAuth client asked for when it is needed, and
// what an auth error tells the user to do. fetch is a stand-in: no network.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMailcore } from '../src/index.js';

const noCreds = (tokens) => ({ getPassword: async () => ({ password: 'x' }), google: { get: async (a) => tokens[a] ?? null, set: async (a, t) => { tokens[a] = t; } } });

function withFetch(answer) {
  const real = globalThis.fetch;
  const asked = [];
  globalThis.fetch = async (url, init = {}) => { asked.push({ url: String(url), body: init.body ? String(init.body) : '' }); return answer(String(url), init); };
  return { asked, restore: () => { globalThis.fetch = real; } };
}
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
