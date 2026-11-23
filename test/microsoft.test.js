// Microsoft sign-in (src/microsoft-auth.js) against a made-up Microsoft: the consent URL, the loopback redirect,
// the code exchanged, who signed in, renewals that rotate the refresh token, a sign-in refused; and IMAP and SMTP
// given a token instead of a password (src/imap.js).
import test from 'node:test';
import assert from 'node:assert/strict';
import { microsoftAuth, idTokenClaims, microsoftServers, MICROSOFT_PERSONAL_TENANT } from '../src/microsoft-auth.js';
import { imapOptions, imapOptionsNow } from '../src/imap.js';

const jwt = (claims) => `x.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.y`;
const memory = () => { const m = new Map(); return { m, store: { get: (a) => m.get(a) ?? null, set: (a, t) => { m.set(a, t); } } }; };

test('who an ID token says signed in; where a Microsoft mailbox is reached', () => {
  assert.deepEqual(idTokenClaims(jwt({ preferred_username: 'Sam@Contoso.com', name: 'Sam', tid: 'abc', oid: 'o1' })), { email: 'sam@contoso.com', name: 'Sam', tenant: 'abc', personal: false, id: 'abc:o1' });
  assert.equal(idTokenClaims(jwt({ email: 'me@outlook.com', tid: MICROSOFT_PERSONAL_TENANT })).personal, true);
  assert.equal(idTokenClaims('junk').email, null);
  assert.equal(microsoftServers(true).smtp.host, 'smtp-mail.outlook.com');
  assert.equal(microsoftServers(false).smtp.host, 'smtp.office365.com');
  assert.equal(microsoftServers(false).imap.host, 'outlook.office365.com');
});

test('a sign-in: the consent URL, the redirect answered once, the code exchanged, who signed in kept with the tokens', async () => {
  const { m, store } = memory();
  const asked = [];
  const fetchFn = async (url, init) => {
    const p = Object.fromEntries(new URLSearchParams(init.body));
    asked.push(p);
    return new Response(JSON.stringify({ access_token: 'at1', refresh_token: 'rt1', expires_in: 3600, scope: 'IMAP SMTP', id_token: jwt({ preferred_username: 'sam@contoso.com', name: 'Sam', tid: 'abc', oid: 'o1' }) }));
  };
  const ms = microsoftAuth({ store, clientId: 'app-id', fetchFn });
  const flow = await ms.beginLogin('work', { appName: 'Sideora' });
  const u = new URL(flow.url);
  assert.equal(u.origin + u.pathname, 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize');
  assert.equal(u.searchParams.get('client_id'), 'app-id');
  assert.equal(u.searchParams.get('code_challenge_method'), 'S256');
  assert.match(u.searchParams.get('scope'), /IMAP\.AccessAsUser\.All .*SMTP\.Send .*offline_access/);
  assert.match(u.searchParams.get('redirect_uri'), /^http:\/\/localhost:\d+\/$/);
  const back = new URL(u.searchParams.get('redirect_uri'));
  // a wrong state is refused, and the sign-in still waits
  assert.equal((await fetch(`http://127.0.0.1:${back.port}/?state=nope&code=c`, { headers: { host: back.host } })).status, 400);
  const page = await fetch(`http://127.0.0.1:${back.port}/?state=${u.searchParams.get('state')}&code=the-code`, { headers: { host: back.host } });
  assert.equal(page.status, 200);
  const stored = await flow.done;
  assert.deepEqual([stored.email, stored.personal, stored.refresh_token, stored.identity], ['sam@contoso.com', false, 'rt1', 'abc:o1']);
  assert.deepEqual([asked[0].grant_type, asked[0].code, asked[0].client_id, 'client_secret' in asked[0]], ['authorization_code', 'the-code', 'app-id', false]);
  assert.ok(asked[0].code_verifier.length >= 43);
  assert.equal(m.get('work').email, 'sam@contoso.com');
});

test('renewals: the token kept while fresh, renewed near expiry with the new refresh token kept; refused, it says to sign in again', async () => {
  const { m, store } = memory();
  m.set('work', { refresh_token: 'rt1', access_token: 'old', expires_at: Date.now() + 30e3, email: 'sam@contoso.com' });
  let answer = { access_token: 'at2', refresh_token: 'rt2', expires_in: 3600 };
  let status = 200;
  const fetchFn = async () => new Response(JSON.stringify(answer), { status });
  const ms = microsoftAuth({ store, clientId: 'app-id', fetchFn });
  assert.equal(await ms.accessToken('work'), 'at2'); // (within a minute of expiry: renewed)
  assert.deepEqual([m.get('work').refresh_token, m.get('work').email], ['rt2', 'sam@contoso.com']);
  assert.equal(await ms.accessToken('work'), 'at2'); // (fresh: kept)
  status = 400; answer = { error: 'invalid_grant', error_description: 'AADSTS70000: expired' };
  await assert.rejects(ms.accessToken('work', { force: true }), (e) => e.code === 'MAIL_AUTH' && /sign in to Microsoft again/.test(e.message));
  assert.ok(m.get('work').refused_at);
  await assert.rejects(ms.accessToken('nobody'), (e) => e.code === 'MAIL_AUTH');
});

test('IMAP signs in with a token asked for at each connection, or with a password', async () => {
  const acct = { name: 'work', email: 'sam@contoso.com', imap: { host: 'outlook.office365.com' } };
  assert.deepEqual(imapOptions(acct, { password: 'p' }).auth, { user: 'sam@contoso.com', pass: 'p' });
  let n = 0;
  const o = await imapOptionsNow(acct, { username: 'sam@contoso.com', oauth: async () => `tok${++n}` });
  assert.deepEqual(o.auth, { user: 'sam@contoso.com', accessToken: 'tok1' });
  assert.equal((await imapOptionsNow(acct, { oauth: async () => `tok${++n}` })).auth.accessToken, 'tok2');
  // offline, or Microsoft down: a passing trouble, not a sign-in refused; a refusal stays one
  await assert.rejects(imapOptionsNow(acct, { oauth: async () => { throw new TypeError('fetch failed'); } }), (e) => e.code === 'MAIL_NETWORK' && /fetch failed/.test(e.message));
  await assert.rejects(imapOptionsNow(acct, { oauth: async () => { throw Object.assign(new Error('signed out'), { code: 'MAIL_AUTH' }); } }), (e) => e.code === 'MAIL_AUTH');
  await assert.rejects(imapOptionsNow(acct, { oauth: async () => { throw new DOMException('timed out', 'TimeoutError'); } }), (e) => e.code === 'MAIL_NETWORK');
});

test('a renewal writes only over the sign-in it renewed: a newer sign-in, or a removal, meanwhile is kept', async () => {
  const { m, store } = memory();
  m.set('work', { refresh_token: 'rt1', access_token: 'old', expires_at: 0 });
  // the store's own one-step change, as Sideora gives it (a lock across processes)
  store.update = async (a, fn) => { const next = fn(m.get(a) ?? null); if (next !== undefined) m.set(a, next); return next; };
  const fetchFn = async () => { m.set('work', { refresh_token: 'rt-new', access_token: 'signed-in-again', expires_at: Date.now() + 3600e3 }); return new Response(JSON.stringify({ access_token: 'renewed', refresh_token: 'rt2', expires_in: 3600 })); };
  const ms = microsoftAuth({ store, clientId: 'app-id', fetchFn });
  assert.equal(await ms.accessToken('work'), 'renewed');
  assert.equal(m.get('work').refresh_token, 'rt-new'); // (the sign-in made meanwhile stays)
  m.set('gone', { refresh_token: 'rt1', access_token: 'old', expires_at: 0 });
  const removing = microsoftAuth({ store, clientId: 'app-id', fetchFn: async () => { m.delete('gone'); return new Response(JSON.stringify({ access_token: 'x', refresh_token: 'rt9', expires_in: 3600 })); } });
  await removing.accessToken('gone');
  assert.equal(m.has('gone'), false); // (removed meanwhile: not brought back)
});
