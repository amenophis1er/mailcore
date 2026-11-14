// Plain words out of what mail calls text.
//
// Everything here runs on mail as it arrives, on every listing: each pass is
// linear in the text (no pattern that starts over from every "<" or space of
// a long run of them).

const ENTITIES = {
  nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'",
  // what newsletters write most: invisible padding, quotes and dashes, a few signs
  zwnj: '\u200c', zwj: '\u200d', shy: '\u00ad', ensp: ' ', emsp: ' ', thinsp: ' ',
  lsquo: '\u2018', rsquo: '\u2019', ldquo: '\u201c', rdquo: '\u201d', ndash: '\u2013', mdash: '\u2014', hellip: '\u2026',
  bull: '\u2022', middot: '\u00b7', copy: '\u00a9', reg: '\u00ae', trade: '\u2122', euro: '\u20ac',
};

/** `<style>…</style>`, `<script>`, `<head>` and comments out, to their end or, unclosed, to the end of the text. */
function withoutBlocks(html) {
  const open = /<(style|script|head)\b|<!--/gi;
  let out = '';
  let from = 0;
  for (let m; (m = open.exec(html));) {
    out += html.slice(from, m.index);
    const close = m[1] ? `</${m[1].toLowerCase()}` : '-->';
    const at = html.toLowerCase().indexOf(close, m.index + m[0].length);
    if (at < 0) return out; // cut off before its end (a text read up to a length): nothing after it is content
    const end = m[1] ? html.indexOf('>', at) : at + 2;
    if (end < 0) return out;
    from = end + 1;
    open.lastIndex = from;
  }
  return out + html.slice(from);
}

/** `&amp;`, `&#847;`, `&#x200C;` read as the characters they stand for (an unknown name stays as written). */
export function decodeEntities(text) {
  return String(text || '').replace(ENTITY, entity);
}
const ENTITY = /&(?:#(\d{1,7})|#x([0-9a-f]{1,6})|([a-z]{2,6}));/gi;
function entity(all, dec, hex, name) {
  if (name) return ENTITIES[name.toLowerCase()] ?? all;
  const code = dec ? Number(dec) : parseInt(hex, 16);
  return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : all;
}

// Marketing mail pads its hidden preheader with runs of characters that take no room ("͏ ‌ ͏ ‌") so a client's
// preview line stops at its own words. Soft hyphen, combining grapheme joiner, zero-width space, word joiner and byte
// order mark go wherever they are; the zero-width (non-)joiners only beside a space or an end: between two letters
// or two emoji they shape the word ("می‌روم", "👩‍💻").
const INVISIBLE = /[\u00ad\u034f\u200b\u2060\ufeff]/g;
const LOOSE_JOINERS = /(^|\s)[\u200c\u200d]+|[\u200c\u200d]+(?=\s|$)/g;

/**
 * The preview line of a mail: its text as words, entities read (some senders write
 * them in the plain-text part too), invisible padding, link and image targets out.
 */
export function previewText(text, length = 180) {
  const t = String(text || '');
  // entities read once: by htmlToText for HTML, here for a text part that writes them
  return (looksHtml(t) ? htmlToText(t) : decodeEntities(t))
    .replace(INVISIBLE, '')
    .replace(LOOSE_JOINERS, '$1')
    // text bodies of HTML mail carry link and image targets in brackets: not worth a preview line
    .replace(/\[(cid:|https?:\/\/|mailto:)[^\]]*\]|<https?:\/\/[^>\s]*>/gi, ' ')
    .replace(/\s+/g, ' ').trim().slice(0, length);
}

/** An HTML body as text: blocks become lines, cells are set apart, tags go, entities are read. */
export function htmlToText(html) {
  return withoutBlocks(String(html || ''))
    .replace(/<br\s*\/?>|<\/p>|<\/div>|<\/tr>|<\/li>|<\/h[1-6]>/gi, '\n')
    .replace(/<\/t[dh]>/gi, ' ') // "Security code" and "930155" in two cells are two words
    // a tag is a name, then a space, a slash or the end: "<alice@example.com>" and "a < b" are text
    .replace(/<\/?[a-zA-Z][a-zA-Z0-9:-]*(?:\s[^<>]*)?\/?>|<![^<>]*>/g, '')
    .replace(ENTITY, entity)
    .replace(/[ \t]{2,}/g, ' ').replace(/ ?\n ?/g, '\n').replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * The text part of a mail as text. Some senders put their HTML in the
 * plain-text part too ("<p>Your verification code is:</p>", a whole
 * "<!doctype html>" page): that is read as HTML. Plain text that merely
 * mentions a tag or holds an address in angle brackets ("Use <b> for bold",
 * "Anna <a.jones@example.com>", "a < b") is left as it is: it takes a
 * document's opening, a closing tag or a line break tag to be HTML.
 */
export function plainText(text) {
  const t = String(text || '');
  return looksHtml(t) ? htmlToText(t) : t;
}

function looksHtml(t) {
  return /<!doctype\s+html|<html[\s>]|<\/(?:html|body|div|p|span|table|tr|td|a|h[1-6]|ul|ol|li|b|strong|em|center|font|style)>|<br\s*\/?>/i.test(t.slice(0, 4000));
}
