// Plain words out of what mail calls text.
//
// Everything here runs on mail as it arrives, on every listing: each pass is
// linear in the text (no pattern that starts over from every "<" or space of
// a long run of them).

const ENTITIES = { nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

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

/** An HTML body as text: blocks become lines, cells are set apart, tags go, entities are read. */
export function htmlToText(html) {
  return withoutBlocks(String(html || ''))
    .replace(/<br\s*\/?>|<\/p>|<\/div>|<\/tr>|<\/li>|<\/h[1-6]>/gi, '\n')
    .replace(/<\/t[dh]>/gi, ' ') // "Security code" and "930155" in two cells are two words
    // a tag is a name, then a space, a slash or the end: "<alice@example.com>" and "a < b" are text
    .replace(/<\/?[a-zA-Z][a-zA-Z0-9:-]*(?:\s[^<>]*)?\/?>|<![^<>]*>/g, '')
    .replace(/&(?:#(\d{1,7})|#x([0-9a-f]{1,6})|([a-z]{2,6}));/gi, (all, dec, hex, name) => {
      if (name) return ENTITIES[name.toLowerCase()] ?? all;
      const code = dec ? Number(dec) : parseInt(hex, 16);
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : all;
    })
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
  return /<!doctype\s+html|<html[\s>]|<\/(?:html|body|div|p|span|table|tr|td|a|h[1-6]|ul|ol|li|b|strong|em|center|font|style)>|<br\s*\/?>/i.test(t.slice(0, 4000)) ? htmlToText(t) : t;
}
