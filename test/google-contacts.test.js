// Google contacts over the People API: paging, both lists, photos, and what a
// refusal means. fetch is a stand-in: no network.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMailcore, googleContacts, googleContactOf } from '../src/index.js';

const json = (status, data) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
const token = (asked = []) => async (account, { force }) => { asked.push({ account, force }); return force ? 'fresh' : 'tok'; };

const person = (name, emails, { photo, isDefault, org } = {}) => ({
  names: name ? [{ displayName: name, metadata: { primary: true } }] : [],
  emailAddresses: emails.map((value, i) => ({ value, metadata: { primary: i === 0 } })),
  ...(photo ? { photos: [{ url: photo, ...(isDefault ? { default: true } : {}), metadata: { primary: true } }] } : {}),
  ...(org ? { organizations: [{ name: org.name, title: org.title, metadata: { primary: true } }] } : {})
});

/** A People API: `saved` and `other` as pages; `refuse` per list: [status, body]. */
function peopleApi({ saved = [[]], other = [[]], refuse = {} } = {}) {
  const asked = [];
  const fetch = async (url, init) => {
    const u = new URL(String(url));
    asked.push({ url: u, auth: init.headers.authorization });
    const kind = u.pathname === '/v1/people/me/connections' ? 'saved' : u.pathname === '/v1/otherContacts' ? 'other' : null;
    if (!kind) return json(404, { error: { message: 'no' } });
    if (refuse[kind]) return json(...refuse[kind]);
    const pages = kind === 'saved' ? saved : other;
    const at = Number(u.searchParams.get('pageToken') || 0);
    const body = { [kind === 'saved' ? 'connections' : 'otherContacts']: pages[at] };
    if (at + 1 < pages.length) body.nextPageToken = String(at + 1);
    return json(200, body);
  };
  return { fetch, asked };
}

test('both lists are read, every page, with the fields asked for and the account\'s token', async () => {
  const api = peopleApi({
    saved: [[person('Ann Example', ['ann@a.example'])], [person('Bob', ['bob@b.example', 'Bob@B.example', 'bob@home.example'], { org: { name: 'B Corp', title: 'CTO' } })]],
    other: [[person('', ['carol@c.example']), person('Nobody', [])]]
  });
  const r = await googleContacts('g', { accessToken: token(), fetch: api.fetch });
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.saved, [
    { name: 'Ann Example', email: 'ann@a.example', emails: ['ann@a.example'], kind: 'saved' },
    { name: 'Bob', email: 'bob@b.example', emails: ['bob@b.example', 'bob@home.example'], kind: 'saved', company: 'B Corp', title: 'CTO' }
  ]);
  // without an address a contact is of no use here
  assert.deepEqual(r.other, [{ name: '', email: 'carol@c.example', emails: ['carol@c.example'], kind: 'other' }]);
  const saved = api.asked.filter((a) => a.url.pathname.endsWith('/connections'));
  assert.equal(saved.length, 2);
  assert.equal(saved[0].url.searchParams.get('personFields'), 'names,emailAddresses,photos,organizations');
  assert.equal(saved[0].url.searchParams.get('pageSize'), '1000');
  assert.equal(saved[1].url.searchParams.get('pageToken'), '1');
  const other = api.asked.find((a) => a.url.pathname === '/v1/otherContacts');
  assert.equal(other.url.searchParams.get('readMask'), 'names,emailAddresses,photos');
  assert.equal(other.url.origin, 'https://people.googleapis.com');
  assert.ok(api.asked.every((a) => a.auth === 'Bearer tok'));
});

test('a photo someone chose is kept; Google\'s placeholder and a non-https address are not', () => {
  assert.equal(googleContactOf(person('A', ['a@x.example'], { photo: 'https://lh3.googleusercontent.com/a/abc=s100' }), 'saved').photo, 'https://lh3.googleusercontent.com/a/abc=s100');
  assert.equal(googleContactOf(person('A', ['a@x.example'], { photo: 'https://lh3.googleusercontent.com/cm/def=s100', isDefault: true }), 'saved').photo, undefined);
  assert.equal(googleContactOf(person('A', ['a@x.example'], { photo: 'http://lh3.googleusercontent.com/a/abc' }), 'other').photo, undefined);
  // the primary one, wherever it is in the list
  const p = person('A', ['a@x.example']);
  p.photos = [{ url: 'https://lh3.googleusercontent.com/cm/placeholder', default: true }, { url: 'https://lh3.googleusercontent.com/a/real', metadata: { primary: true } }];
  assert.equal(googleContactOf(p, 'saved').photo, 'https://lh3.googleusercontent.com/a/real');
  // a name that is only the address is no name
  assert.equal(googleContactOf(person('a@x.example', ['a@x.example']), 'saved').name, '');
  assert.equal(googleContactOf({ names: [{ displayName: 'X' }] }, 'saved'), null);
});

test('a list Google refuses is null with its reason; the other one is still read', async () => {
  const api = peopleApi({
    saved: [[person('Ann', ['ann@a.example'])]],
    refuse: { other: [403, { error: { code: 403, status: 'PERMISSION_DENIED', message: 'Request had insufficient authentication scopes.', details: [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: 'ACCESS_TOKEN_SCOPE_INSUFFICIENT' }] } }] }
  });
  const r = await googleContacts('g', { accessToken: token(), fetch: api.fetch });
  assert.equal(r.saved.length, 1);
  assert.equal(r.other, null);
  assert.equal(r.errors.length, 1);
  assert.equal(r.errors[0].list, 'other');
  assert.equal(r.errors[0].code, 'GOOGLE_SCOPE');
  assert.equal(r.errors[0].status, 403);
});

test('the People API turned off: every list fails, so it throws GOOGLE_API_DISABLED with the errors', async () => {
  const off = [403, { error: { code: 403, status: 'PERMISSION_DENIED', message: 'People API has not been used in project 123 before or it is disabled. Enable it by visiting …', errors: [{ reason: 'accessNotConfigured' }], details: [{ reason: 'SERVICE_DISABLED' }] } }];
  const api = peopleApi({ refuse: { saved: off, other: off } });
  await assert.rejects(googleContacts('g', { accessToken: token(), fetch: api.fetch }), (e) => e.code === 'GOOGLE_API_DISABLED' && e.errors.length === 2 && /People API is not enabled/.test(e.message));
  // rate limits and anything else have their own codes
  const busy = peopleApi({ refuse: { saved: [429, { error: { status: 'RESOURCE_EXHAUSTED' } }], other: [500, { error: { message: 'boom' } }] } });
  await assert.rejects(googleContacts('g', { accessToken: token(), fetch: busy.fetch }), (e) => e.code === 'GOOGLE_RATE' && e.errors[1].code === 'GOOGLE_API' && e.errors[1].status === 500);
});

test('a 401 is asked again once with a renewed token; refused again, it is an auth error', async () => {
  const asked = [];
  let calls = 0;
  const once = async (url, init) => { calls++; return init.headers.authorization === 'Bearer fresh' ? json(200, { connections: [person('Ann', ['ann@a.example'])] }) : json(401, { error: { message: 'expired' } }); };
  const r = await googleContacts('g', { accessToken: token(asked), fetch: once, lists: ['saved'] });
  assert.equal(r.saved.length, 1);
  assert.equal(r.other, null);
  assert.deepEqual(r.errors, []);
  assert.deepEqual(asked.map((a) => a.force), [false, true]);
  assert.equal(calls, 2);
  const never = async () => json(401, {});
  await assert.rejects(googleContacts('g', { accessToken: token(), fetch: never, signInHint: (a) => `run: login ${a}` }), (e) => e.code === 'MAIL_AUTH' && e.message.endsWith('run: login g'));
});

test('paging stops at maxPages, and an account without a token source is refused', async () => {
  const pages = Array.from({ length: 5 }, (_, i) => [person(`P${i}`, [`p${i}@x.example`])]);
  const api = peopleApi({ saved: pages });
  const r = await googleContacts('g', { accessToken: token(), fetch: api.fetch, lists: ['saved'], maxPages: 3 });
  assert.equal(r.saved.length, 3);
  await assert.rejects(googleContacts('g', {}), TypeError);
});

test('the instance reads them over its own tokens (renewed when near expiry, as for the calendar)', async (t) => {
  const tokens = { g: { refresh_token: 'r', access_token: 'stored', expires_at: Date.now() + 3600e3 } };
  const core = createMailcore({ accounts: { g: { provider: 'google', email: 'me@gmail.example' } }, credentials: { getPassword: async () => ({ password: 'x' }), google: { get: async (a) => tokens[a] ?? null, set: async (a, v) => { tokens[a] = v; } } }, google: { clientId: 'c' } });
  const real = globalThis.fetch;
  const auth = [];
  globalThis.fetch = async (url, init) => { auth.push(init.headers.authorization); return json(200, String(url).includes('otherContacts') ? { otherContacts: [] } : { connections: [person('Ann', ['ann@a.example'])] }); };
  t.after(() => { globalThis.fetch = real; });
  const r = await core.google.contacts('g');
  assert.equal(r.saved[0].email, 'ann@a.example');
  assert.deepEqual(r.other, []);
  assert.deepEqual(auth, ['Bearer stored', 'Bearer stored']);
});
