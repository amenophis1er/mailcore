// Google contacts over the People API: the account's own contacts
// (people/me/connections) and its "other contacts" (otherContacts: the people
// it wrote to or got mail from, which Google keeps apart). Read only, paged.
// Access tokens come from the accessToken function the caller passes
// (google-auth.js builds one over the caller's token store); the scopes are
// GOOGLE_CONTACTS_SCOPES (contacts.readonly, contacts.other.readonly).
//
// Nothing is kept here: the caller decides where the contacts go (they are
// personal data) and how often they are asked for.

const API = 'https://people.googleapis.com/v1';
const TIMEOUT_MS = 20000;
const EMAIL = /^[^\s@<>"(),;:\\]{1,64}@[^\s@<>"(),;:\\]{1,253}$/;
const LISTS = {
  saved: { path: '/people/me/connections', fields: 'personFields', mask: 'names,nicknames,emailAddresses,phoneNumbers,addresses,organizations,biographies,birthdays,urls,relations,events,memberships,photos', items: 'connections' },
  other: { path: '/otherContacts', fields: 'readMask', mask: 'names,emailAddresses,photos', items: 'otherContacts' }
};

function contactsError(message, code, status) {
  const e = new Error(message);
  e.code = code;
  if (status) e.status = status;
  return e;
}

/** The reasons Google gives in an error answer, old and new style. */
function reasonsOf(data) {
  const err = data?.error || {};
  const out = [err.status];
  for (const x of Array.isArray(err.errors) ? err.errors : []) out.push(x?.reason);
  for (const x of Array.isArray(err.details) ? err.details : []) out.push(x?.reason);
  return out.filter((v) => typeof v === 'string');
}

/**
 * What a refusal of the People API means: GOOGLE_SCOPE (the sign-in did not
 * allow contacts), GOOGLE_API_DISABLED (the People API is off in the OAuth
 * client's Google Cloud project), GOOGLE_RATE (rate-limited), GOOGLE_API
 * (anything else).
 */
function failure(status, data, what) {
  const reasons = reasonsOf(data);
  const message = String(data?.error?.message || '').split('\n')[0].slice(0, 300);
  if (status === 403 && reasons.some((r) => /SCOPE_INSUFFICIENT|insufficientPermissions/i.test(r))) {
    return contactsError(`Google did not allow reading ${what} (the sign-in lacks the contacts permission)`, 'GOOGLE_SCOPE', status);
  }
  if (status === 403 && (reasons.some((r) => /SERVICE_DISABLED|accessNotConfigured/i.test(r)) || /has not been used in project|is disabled/i.test(message))) {
    return contactsError(`the People API is not enabled for this OAuth client's Google Cloud project${message ? `: ${message}` : ''}`, 'GOOGLE_API_DISABLED', status);
  }
  if (status === 429 || reasons.some((r) => /RATE_LIMIT|rateLimitExceeded|RESOURCE_EXHAUSTED|quota/i.test(r))) {
    return contactsError(`Google is rate-limiting ${what} — try again shortly`, 'GOOGLE_RATE', status);
  }
  return contactsError(`Google answered ${status} for ${what}${reasons[0] ? ` (${reasons[0]})` : ''}${message ? `: ${message}` : ''}`, 'GOOGLE_API', status);
}

const primaryFirst = (list) => (Array.isArray(list) ? [...list].sort((a, b) => Number(!!b?.metadata?.primary) - Number(!!a?.metadata?.primary)) : []);
const text = (v, max = 200) => (typeof v === 'string' ? v.trim().replace(/\s+/g, ' ').slice(0, max) : '');

const typeOf = (x) => text(x?.formattedType || x?.type, 60);
/** A date of the People API ({ year?, month, day }) as 'YYYY-MM-DD', or '--MM-DD' when the year is not known. */
function dateOf(d) {
  const m = Number(d?.month), day = Number(d?.day), y = Number(d?.year);
  if (!(m >= 1 && m <= 12 && day >= 1 && day <= 31)) return '';
  const md = `${String(m).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  return y >= 1 && y <= 9999 ? `${String(y).padStart(4, '0')}-${md}` : `--${md}`;
}
const notEmpty = (list) => (list.length ? list : undefined);

/**
 * One person of the People API as a contact: { id, name, email, emails, kind, photo?, company?, title?, … }.
 * `email` is the primary address ('' for a saved contact that has none); an "other contact" without one is null,
 * as is a saved one with neither an address, a name nor a phone. `photo`: the address of a picture someone chose
 * (https), never Google's placeholder (`default`). Besides, when Google has them: department, nickname, phones
 * [{ kind, number }], addresses [{ kind, text }], birthday ('YYYY-MM-DD' or '--MM-DD'), note, urls [{ kind, url }],
 * relations [{ kind, name }], dates [{ kind, date }], groups (resource names: contactGroups/…), starred.
 */
export function contactOf(person, kind) {
  const seen = new Set();
  const emails = [];
  for (const e of primaryFirst(person?.emailAddresses)) {
    const v = text(e?.value, 320);
    if (!EMAIL.test(v) || seen.has(v.toLowerCase())) continue;
    seen.add(v.toLowerCase());
    emails.push(v);
  }
  const name = text(primaryFirst(person?.names).map((n) => n?.displayName || [n?.givenName, n?.familyName].filter(Boolean).join(' ')).find((n) => text(n)) || '');
  const phones = primaryFirst(person?.phoneNumbers).map((p) => ({ kind: typeOf(p), number: text(p?.value, 60) })).filter((p) => p.number);
  if (!emails.length && (kind !== 'saved' || (!name && !phones.length))) return null;
  const out = { name: emails[0] && name.toLowerCase() === emails[0].toLowerCase() ? '' : name, email: emails[0] || '', emails, kind };
  if (typeof person?.resourceName === 'string' && /^people\/[\w-]{1,200}$/.test(person.resourceName)) out.id = person.resourceName;
  const photo = primaryFirst(person?.photos).find((p) => typeof p?.url === 'string');
  if (photo && photo.default !== true) {
    try { const u = new URL(photo.url); if (u.protocol === 'https:') out.photo = u.toString(); } catch { /* not an address: none */ }
  }
  const org = primaryFirst(person?.organizations)[0];
  if (text(org?.name)) out.company = text(org.name);
  if (text(org?.title)) out.title = text(org.title);
  if (kind !== 'saved') return out;
  if (text(org?.department)) out.department = text(org.department);
  const nick = text(primaryFirst(person?.nicknames)[0]?.value, 100);
  if (nick) out.nickname = nick;
  if (phones.length) out.phones = phones;
  const addresses = notEmpty(primaryFirst(person?.addresses).map((a) => ({
    kind: typeOf(a),
    text: (typeof a?.formattedValue === 'string' && a.formattedValue.trim() ? a.formattedValue : [a?.streetAddress, a?.extendedAddress, [a?.postalCode, a?.city].filter(Boolean).join(' '), a?.region, a?.country].filter((v) => typeof v === 'string' && v.trim()).join('\n'))
      .split('\n').map((l) => text(l, 200)).filter(Boolean).join('\n')
  })).filter((a) => a.text));
  if (addresses) out.addresses = addresses;
  const birthday = primaryFirst(person?.birthdays).map((b) => dateOf(b?.date)).find(Boolean);
  if (birthday) out.birthday = birthday;
  const note = typeof primaryFirst(person?.biographies)[0]?.value === 'string' ? primaryFirst(person.biographies)[0].value.replace(/\r\n?/g, '\n').trim().slice(0, 4000) : '';
  if (note) out.note = note;
  const urls = notEmpty(primaryFirst(person?.urls).map((u) => ({ kind: typeOf(u), url: text(u?.value, 500) })).filter((u) => /^https?:\/\//i.test(u.url)));
  if (urls) out.urls = urls;
  const relations = notEmpty((Array.isArray(person?.relations) ? person.relations : []).map((r) => ({ kind: typeOf(r), name: text(r?.person, 120) })).filter((r) => r.name));
  if (relations) out.relations = relations;
  const dates = notEmpty((Array.isArray(person?.events) ? person.events : []).map((e) => ({ kind: typeOf(e), date: dateOf(e?.date) })).filter((e) => e.date));
  if (dates) out.dates = dates;
  const groups = (Array.isArray(person?.memberships) ? person.memberships : []).map((m) => m?.contactGroupMembership?.contactGroupResourceName).filter((g) => typeof g === 'string' && /^contactGroups\/[\w-]{1,200}$/.test(g));
  if (groups.includes('contactGroups/starred')) out.starred = true;
  const own = groups.filter((g) => !/^contactGroups\/(myContacts|starred|all|chatBuddies|friends|family|coworkers|blocked)$/.test(g));
  if (own.length) out.groups = own;
  return out;
}

/**
 * The contacts of a Google account: { saved, other, errors }.
 * `saved`: its own contacts; `other`: its "other contacts"; each null when
 * that list could not be read (its error in `errors`: [{ list, code, status?, message }]).
 * An "other contact" without an email address is left out; a saved one is kept with any of an address, a name, a
 * phone. `groups`: the names of the account's own contact groups ({ 'contactGroups/…': name }), {} when none was
 * needed, null when they could not be read (a contact's `groups` are those resource names).
 * An auth failure (not signed in, the token refused after a renewal: code
 * MAIL_AUTH) throws, as does a failure of every list asked for (the first
 * error, with `errors`).
 *
 * opts: accessToken(account, { force }) (required), signInHint(account),
 * lists (default ['saved', 'other']), pageSize (default 1000), maxPages per
 * list (default 25), signal, fetch (a stand-in, for tests).
 */
export async function googleContacts(account, { accessToken, signInHint = () => 'sign in to Google again', lists = ['saved', 'other'], pageSize = 1000, maxPages = 25, signal, fetch: fetchFn = globalThis.fetch } = {}) {
  if (typeof accessToken !== 'function') throw new TypeError(`account "${account}": Google contacts need an access token source (credentials.google)`);
  const size = Math.min(1000, Math.max(1, Number(pageSize) || 1000));

  const result = { saved: null, other: null, groups: {}, errors: [] };

  async function get(path, query, retry = true) {
    const url = new URL(`${API}${path}`);
    for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
    const token = await accessToken(account, { force: !retry });
    const timeout = AbortSignal.timeout(TIMEOUT_MS);
    const res = await fetchFn(url, { headers: { authorization: `Bearer ${token}`, accept: 'application/json' }, signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
    if (res.status === 401 && retry) return get(path, query, false);
    const body = await res.text();
    let data = null;
    try { data = body.trim() ? JSON.parse(body) : null; } catch { /* not JSON: the status says it */ }
    if (res.status === 401) throw contactsError(`Google no longer accepts the sign-in for "${account}" — ${signInHint(account)}`, 'MAIL_AUTH', 401);
    return { status: res.status, data };
  }

  async function list(kind) {
    const spec = LISTS[kind];
    const what = kind === 'saved' ? 'the contacts' : 'the other contacts';
    const out = [];
    let pageToken;
    for (let page = 0; page < maxPages; page++) {
      const res = await get(spec.path, { [spec.fields]: spec.mask, pageSize: size, pageToken });
      if (res.status !== 200) throw failure(res.status, res.data, what);
      for (const person of Array.isArray(res.data?.[spec.items]) ? res.data[spec.items] : []) {
        const c = contactOf(person, kind);
        if (c) out.push(c);
      }
      pageToken = res.data?.nextPageToken;
      if (!pageToken) break;
    }
    // the names of the account's own groups, once its contacts are read; not read (a failure that is not the sign-in's), null: the caller keeps the names it had
    if (kind === 'saved' && out.some((c) => c.groups)) {
      try {
        const names = {};
        let token;
        for (let page = 0; page < maxPages; page++) {
          const res = await get('/contactGroups', { pageSize: 1000, groupFields: 'name,groupType', pageToken: token });
          if (res.status !== 200) throw failure(res.status, res.data, 'the contact groups');
          for (const g of Array.isArray(res.data?.contactGroups) ? res.data.contactGroups : []) {
            if (g?.groupType !== 'USER_CONTACT_GROUP' || typeof g.resourceName !== 'string' || !/^contactGroups\/[\w-]{1,200}$/.test(g.resourceName)) continue;
            const n = text(g.formattedName || g.name, 100);
            if (n) names[g.resourceName] = n;
          }
          token = res.data?.nextPageToken;
          if (!token) break;
        }
        result.groups = names;
      } catch (e) {
        if (e?.code === 'MAIL_AUTH' || signal?.aborted) throw e;
        result.groups = null;
      }
    }
    return out;
  }

  const asked = [...new Set(lists)].filter((l) => Object.hasOwn(LISTS, l));
  const settled = await Promise.allSettled(asked.map((l) => list(l)));
  let firstError = null;
  for (const [i, s] of settled.entries()) {
    if (s.status === 'fulfilled') { result[asked[i]] = s.value; continue; }
    const e = s.reason;
    if (e?.code === 'MAIL_AUTH' || signal?.aborted) throw e;
    firstError ??= e;
    result.errors.push({ list: asked[i], code: e?.code || 'GOOGLE_API', ...(e?.status ? { status: e.status } : {}), message: String(e?.message || e) });
  }
  if (asked.length && result.errors.length === asked.length) throw Object.assign(firstError, { errors: result.errors });
  return result;
}
