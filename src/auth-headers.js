// The headers a reader needs to judge who really sent a message, as they
// stand in it: every Authentication-Results header, topmost (the last
// receiving server's) first, the BIMI-Selector, and Exchange Online's word
// on how the message came in (X-MS-Exchange-Organization-AuthAs, a header
// Exchange removes from what arrives from outside before setting its own).
// Raw values only: what to trust of them is the caller's (the authserv-id
// of its own receiving server, and so on).

/** The header names asked for (lower case). */
export const AUTH_HEADER_NAMES = ['authentication-results', 'bimi-selector', 'x-ms-exchange-organization-authas'];

const MAX_RESULTS = 10;
const MAX_VALUE = 4096;

/** A header value on one line: folded lines joined, controls out, cut to MAX_VALUE. */
const flat = (v) => String(v ?? '').replace(/\r?\n[ \t]+/g, ' ').replace(/[\x00-\x08\x0a-\x1f\x7f]+/g, ' ').trim().slice(0, MAX_VALUE);

/**
 * `pairs`: [name, value] in the order the message holds them, topmost first.
 * → { results: string[], bimiSelector: string, msAuthAs: string } (the first
 * BIMI-Selector and AuthAs when there are several; '' when none).
 */
export function authHeadersFrom(pairs) {
  const out = { results: [], bimiSelector: '', msAuthAs: '' };
  for (const [rawName, value] of pairs || []) {
    const name = String(rawName || '').trim().toLowerCase();
    if (name === 'authentication-results') { if (out.results.length < MAX_RESULTS) out.results.push(flat(value)); }
    else if (name === 'bimi-selector') { if (!out.bimiSelector) out.bimiSelector = flat(value); }
    else if (name === 'x-ms-exchange-organization-authas') { if (!out.msAuthAs) out.msAuthAs = flat(value); }
  }
  return out;
}

/** The [name, value] pairs of a raw header block (the lines up to the first empty one), in order. */
export function headerPairs(raw) {
  const text = Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw ?? '');
  const head = text.split(/\r?\n\r?\n/, 1)[0];
  const pairs = [];
  for (const line of head.split(/\r?\n(?![ \t])/)) {
    const at = line.indexOf(':');
    if (at > 0) pairs.push([line.slice(0, at), line.slice(at + 1)]);
  }
  return pairs;
}

/** The same of a message mailparser read (its headerLines keep every header line, in order: { key, line: "Name: value" }). */
export function authHeadersOfParsed(parsed) {
  return authHeadersFrom((parsed?.headerLines || []).map((h) => [h.key, String(h.line || '').replace(/^[^:]*:/, '')]));
}
