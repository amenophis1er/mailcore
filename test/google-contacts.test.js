// Google contacts over the People API: paging, both lists, photos, and what a
// refusal means. fetch is a stand-in: no network.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMailcore, googleContacts, googleContactOf, googleCreateContact, contactsAllowed } from '../src/index.js';

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
  assert.equal(saved[0].url.searchParams.get('personFields'), 'names,nicknames,emailAddresses,phoneNumbers,addresses,organizations,biographies,birthdays,urls,relations,events,memberships,photos');
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
  // without an address: an other contact is nobody; a saved one is kept for its name or its phone
  assert.equal(googleContactOf({ names: [{ displayName: 'X' }] }, 'other'), null);
  assert.equal(googleContactOf({}, 'saved'), null);
  assert.deepEqual(googleContactOf({ phoneNumbers: [{ value: '+1 555 0100' }] }, 'saved'), { name: '', email: '', emails: [], kind: 'saved', phones: [{ kind: '', number: '+1 555 0100' }] });
});

test('a saved contact comes with what Google has of it: phones, addresses, birthday, note, links, relations, dates, groups, a star', () => {
  const c = googleContactOf({
    resourceName: 'people/c42',
    names: [{ displayName: 'Jo Doe' }], nicknames: [{ value: 'Jojo' }],
    emailAddresses: [{ value: 'jo@x.example' }],
    phoneNumbers: [{ value: '+1 555 0100', formattedType: 'Mobile' }, { value: '' }],
    addresses: [{ formattedValue: '1 Main St\r\nTown', formattedType: 'Home' }, { streetAddress: '2 Side Rd', city: 'Lomé', postalCode: 'BP 1', country: 'Togo', type: 'work' }],
    organizations: [{ name: 'Acme', title: 'CTO', department: 'R&D' }],
    birthdays: [{ date: { year: 1990, month: 2, day: 9 } }],
    biographies: [{ value: 'Met in Accra.\r\nLikes tea.' }],
    urls: [{ value: 'https://jo.example', type: 'homePage' }, { value: 'javascript:alert(1)' }],
    relations: [{ person: 'Sam', formattedType: 'Spouse' }],
    events: [{ date: { month: 6, day: 1 }, formattedType: 'Anniversary' }, { date: { month: 13, day: 1 } }],
    memberships: [{ contactGroupMembership: { contactGroupResourceName: 'contactGroups/starred' } }, { contactGroupMembership: { contactGroupResourceName: 'contactGroups/myContacts' } }, { contactGroupMembership: { contactGroupResourceName: 'contactGroups/1a2b' } }]
  }, 'saved');
  assert.deepEqual(c, {
    name: 'Jo Doe', email: 'jo@x.example', emails: ['jo@x.example'], kind: 'saved', id: 'people/c42', company: 'Acme', title: 'CTO', department: 'R&D', nickname: 'Jojo',
    phones: [{ kind: 'Mobile', number: '+1 555 0100' }],
    addresses: [{ kind: 'Home', text: '1 Main St\nTown' }, { kind: 'work', text: '2 Side Rd\nBP 1 Lomé\nTogo' }],
    birthday: '1990-02-09', note: 'Met in Accra.\nLikes tea.', urls: [{ kind: 'homePage', url: 'https://jo.example' }],
    relations: [{ kind: 'Spouse', name: 'Sam' }], dates: [{ kind: 'Anniversary', date: '--06-01' }],
    starred: true, groups: ['contactGroups/1a2b']
  });
  // an other contact: what it is, never more
  assert.deepEqual(Object.keys(googleContactOf({ emailAddresses: [{ value: 'o@x.example' }], phoneNumbers: [{ value: '1' }] }, 'other')).sort(), ['email', 'emails', 'kind', 'name']);
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

test('the groups\' names come after the contacts, every page of them; failing, they are null (the caller keeps its own), the sign-in refused, it throws', async () => {
  const member = (g) => ({ names: [{ displayName: 'G' }], emailAddresses: [{ value: 'g@x.example' }], memberships: [{ contactGroupMembership: { contactGroupResourceName: g } }] });
  const run = (groups) => {
    const asked = [];
    const fetch = async (url) => {
      const u = new URL(String(url));
      asked.push(u.pathname);
      if (u.pathname.endsWith('/connections')) return new Response(JSON.stringify({ connections: [member('contactGroups/a'), member('contactGroups/b')] }), { status: 200 });
      return groups(u);
    };
    return googleContacts('acct', { accessToken: async () => 'tok', lists: ['saved'], fetch }).then((r) => ({ r, asked }));
  };
  const page = (u) => (u.searchParams.get('pageToken') === '2'
    ? new Response(JSON.stringify({ contactGroups: [{ resourceName: 'contactGroups/b', formattedName: 'B', groupType: 'USER_CONTACT_GROUP' }] }), { status: 200 })
    : new Response(JSON.stringify({ contactGroups: [{ resourceName: 'contactGroups/a', formattedName: 'A', groupType: 'USER_CONTACT_GROUP' }], nextPageToken: '2' }), { status: 200 }));
  assert.deepEqual((await run(page)).r.groups, { 'contactGroups/a': 'A', 'contactGroups/b': 'B' });
  assert.equal((await run(() => new Response('{}', { status: 500 }))).r.groups, null);
  await assert.rejects(run(() => new Response('{}', { status: 401 })), (e) => e.code === 'MAIL_AUTH');
});


test('a contact is added as Google takes it, and comes back as Google keeps it', async () => {
  const sent = [];
  const fetch = async (url, init) => {
    sent.push({ url: new URL(String(url)), init });
    const p = JSON.parse(init.body);
    return json(200, { resourceName: 'people/c42', ...p, names: [{ displayName: 'Example Co.', metadata: { primary: true } }] });
  };
  const made = await googleCreateContact('gmail', {
    name: 'Example Co.', emails: ['info@example.com', 'INFO@example.com', 'not an address'], phones: ['+1 555 0100', { number: '+1 555 0101', kind: 'WhatsApp' }, 'none'],
    addresses: [{ text: '1 Example Street\nSpringfield, ST 00000', kind: 'work' }], company: 'Example Co. Ltd', note: 'A test note', urls: ['javascript:alert(1)', 'https://example.com']
  }, { accessToken: token(), fetch });
  assert.equal(sent.length, 1);
  const { url, init } = sent[0];
  assert.equal(init.method, 'POST');
  assert.equal(url.pathname, '/v1/people:createContact');
  assert.match(url.searchParams.get('personFields'), /emailAddresses/);
  const body = JSON.parse(init.body);
  assert.deepEqual(body.names, [{ unstructuredName: 'Example Co.' }]);
  assert.deepEqual(body.emailAddresses, [{ value: 'info@example.com' }]);
  assert.deepEqual(body.phoneNumbers, [{ value: '+1 555 0100' }, { value: '+1 555 0101', type: 'whatsapp' }]);
  assert.deepEqual(body.addresses, [{ formattedValue: '1 Example Street\nSpringfield, ST 00000', type: 'work' }]);
  assert.deepEqual(body.urls, [{ value: 'https://example.com' }]);
  assert.deepEqual(body.organizations, [{ name: 'Example Co. Ltd' }]);
  assert.equal(made.id, 'people/c42');
  assert.equal(made.kind, 'saved');
  assert.equal(made.email, 'info@example.com');
});

test('adding: a company alone, made by Google, is told by its id (not taken for a failure, which would make it again)', async () => {
  const made = await googleCreateContact('gmail', { company: 'Acme Ltd' }, { accessToken: token(), fetch: async () => json(200, { resourceName: 'people/c77', organizations: [{ name: 'Acme Ltd' }] }) });
  assert.equal(made.id, 'people/c77');
  assert.equal(made.name, 'Acme Ltd');
  await assert.rejects(googleCreateContact('gmail', { company: 'Acme Ltd' }, { accessToken: token(), fetch: async () => json(200, { organizations: [{ name: 'Acme Ltd' }] }) }), /without the contact/);
});

test('adding: nothing that names it is refused before Google is asked; a sign-in that only reads is GOOGLE_SCOPE; a 401 is asked again once', async () => {
  let n = 0;
  await assert.rejects(googleCreateContact('gmail', { note: 'only a note' }, { accessToken: token(), fetch: async () => { n++; return json(200, {}); } }), /needs a name/);
  assert.equal(n, 0);
  const scope = json(403, { error: { status: 'PERMISSION_DENIED', details: [{ reason: 'ACCESS_TOKEN_SCOPE_INSUFFICIENT' }] } });
  await assert.rejects(googleCreateContact('gmail', { name: 'Ann' }, { accessToken: token(), fetch: async () => scope }), (e) => e.code === 'GOOGLE_SCOPE' && /adding/.test(e.message));
  const asked = [];
  const calls = [];
  const made = await googleCreateContact('gmail', { name: 'Ann' }, { accessToken: token(asked), fetch: async (u, init) => { calls.push(init.headers.authorization); return calls.length === 1 ? json(401, {}) : json(200, { resourceName: 'people/c1', names: [{ displayName: 'Ann' }] }); } });
  assert.deepEqual(calls, ['Bearer tok', 'Bearer fresh']);
  assert.equal(made.name, 'Ann');
  await assert.rejects(googleCreateContact('gmail', { name: 'Ann' }, { accessToken: token(), fetch: async () => json(401, {}) }), (e) => e.code === 'MAIL_AUTH');
});

test('what granted scopes allow of the contacts: reading by either scope with the other contacts, adding by contacts alone', () => {
  const G = (s) => `https://www.googleapis.com/auth/${s}`;
  assert.deepEqual(contactsAllowed([G('contacts.readonly'), G('contacts.other.readonly')]), { read: true, write: false });
  assert.deepEqual(contactsAllowed([G('contacts'), G('contacts.other.readonly')]), { read: true, write: true });
  assert.deepEqual(contactsAllowed([G('contacts')]), { read: false, write: true });
  assert.deepEqual(contactsAllowed(null), { read: false, write: false });
});
