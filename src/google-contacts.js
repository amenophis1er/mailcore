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
  saved: { path: '/people/me/connections', fields: 'personFields', mask: 'names,emailAddresses,photos,organizations', items: 'connections' },
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

/**
 * One person of the People API as a contact: { name, email, emails, photo?, company?, title? },
 * or null when it has no email address. `photo`: the address of a picture
 * someone chose (https), never Google's placeholder (`default`).
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
  if (!emails.length) return null;
  const name = text(primaryFirst(person?.names).map((n) => n?.displayName || [n?.givenName, n?.familyName].filter(Boolean).join(' ')).find((n) => text(n)) || '');
  const out = { name: name.toLowerCase() === emails[0].toLowerCase() ? '' : name, email: emails[0], emails, kind };
  const photo = primaryFirst(person?.photos).find((p) => typeof p?.url === 'string');
  if (photo && photo.default !== true) {
    try { const u = new URL(photo.url); if (u.protocol === 'https:') out.photo = u.toString(); } catch { /* not an address: none */ }
  }
  const org = primaryFirst(person?.organizations)[0];
  if (text(org?.name)) out.company = text(org.name);
  if (text(org?.title)) out.title = text(org.title);
  return out;
}

/**
 * The contacts of a Google account: { saved, other, errors }.
 * `saved`: its own contacts; `other`: its "other contacts"; each null when
 * that list could not be read (its error in `errors`: [{ list, code, status?, message }]).
 * Only contacts with an email address are returned.
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
    return out;
  }

  const asked = [...new Set(lists)].filter((l) => Object.hasOwn(LISTS, l));
  const result = { saved: null, other: null, errors: [] };
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
