// Message bodies for the write paths: a body is plain text (default), HTML,
// or Markdown that we turn into HTML here. Returns what the backends take:
// { body, bodyType: 'Text' | 'HTML' }.
//
// The Markdown converter is deliberately small (paragraphs, headings, bold,
// italic, inline code, code blocks, links, bullet/numbered lists, tables,
// blockquotes, rules) — enough for an agent to write a table into a mail
// without pulling in a parser. Everything is HTML-escaped first.

export const BODY_FORMATS = ['text', 'markdown', 'html'];

export function prepareBody(body, format = 'text') {
  const f = String(format || 'text').toLowerCase();
  if (f === 'html') return { body: String(body ?? ''), bodyType: 'HTML' };
  if (f === 'markdown' || f === 'md') return { body: markdownToHtml(body), bodyType: 'HTML' };
  if (f !== 'text') throw new Error(`unknown body format "${format}" — use text, markdown or html`);
  return { body: String(body ?? ''), bodyType: 'Text' };
}

export function escapeHtml(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

const FONT = 'font-family:Calibri,Segoe UI,Helvetica,Arial,sans-serif;font-size:11pt';
const CELL = 'border:1px solid #c8c8c8;padding:4px 8px;text-align:left;vertical-align:top';

export function markdownToHtml(md) {
  const lines = String(md ?? '').replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  let i = 0;
  const para = [];
  const flushPara = () => {
    if (!para.length) return;
    out.push(`<p style="margin:0 0 10px">${inline(para.join(' '))}</p>`);
    para.length = 0;
  };
  while (i < lines.length) {
    const line = lines[i];
    if (/^\s*$/.test(line)) { flushPara(); i++; continue; }
    // fenced code
    if (/^```/.test(line)) {
      flushPara();
      const buf = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i])) buf.push(lines[i++]);
      i++;
      out.push(`<pre style="font-family:Consolas,Menlo,monospace;font-size:10pt;background:#f4f4f4;padding:8px;margin:0 0 10px">${escapeHtml(buf.join('\n'))}</pre>`);
      continue;
    }
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) { flushPara(); out.push(`<h${h[1].length} style="margin:12px 0 6px">${inline(h[2])}</h${h[1].length}>`); i++; continue; }
    if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) { flushPara(); out.push('<hr style="border:0;border-top:1px solid #c8c8c8;margin:10px 0">'); i++; continue; }
    // table: header | row, then a separator line
    if (line.includes('|') && i + 1 < lines.length && /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/.test(lines[i + 1])) {
      flushPara();
      const aligns = cells(lines[i + 1]).map((c) => (/^:-+:$/.test(c) ? 'center' : /-+:$/.test(c) ? 'right' : 'left'));
      const head = cells(line);
      i += 2;
      const rows = [];
      while (i < lines.length && lines[i].includes('|') && !/^\s*$/.test(lines[i])) rows.push(cells(lines[i++]));
      const td = (c, k, tag) => `<${tag} style="${CELL};text-align:${aligns[k] || 'left'}${tag === 'th' ? ';background:#f0f0f0;font-weight:bold' : ''}">${inline(c)}</${tag}>`;
      out.push(`<table style="border-collapse:collapse;${FONT};margin:0 0 10px"><thead><tr>${head.map((c, k) => td(c, k, 'th')).join('')}</tr></thead><tbody>${
        rows.map((r) => `<tr>${head.map((_, k) => td(r[k] ?? '', k, 'td')).join('')}</tr>`).join('')}</tbody></table>`);
      continue;
    }
    // lists (one level, consecutive items)
    const li = /^\s*([-*+]|\d+[.)])\s+(.*)$/.exec(line);
    if (li) {
      flushPara();
      const ordered = /\d/.test(li[1]);
      const items = [];
      while (i < lines.length) {
        const m = /^\s*([-*+]|\d+[.)])\s+(.*)$/.exec(lines[i]);
        if (!m) break;
        items.push(m[2]);
        i++;
        while (i < lines.length && /^\s{2,}\S/.test(lines[i]) && !/^\s*([-*+]|\d+[.)])\s+/.test(lines[i])) items[items.length - 1] += ' ' + lines[i++].trim();
      }
      const tag = ordered ? 'ol' : 'ul';
      out.push(`<${tag} style="margin:0 0 10px 0;padding-left:24px">${items.map((t) => `<li>${inline(t)}</li>`).join('')}</${tag}>`);
      continue;
    }
    if (/^\s*>/.test(line)) {
      flushPara();
      const buf = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) buf.push(lines[i++].replace(/^\s*>\s?/, ''));
      out.push(`<blockquote style="margin:0 0 10px;padding-left:10px;border-left:3px solid #c8c8c8;color:#555">${inline(buf.join(' '))}</blockquote>`);
      continue;
    }
    para.push(line.trim());
    i++;
  }
  flushPara();
  return `<div style="${FONT}">${out.join('\n')}</div>`;
}

function cells(row) {
  return row.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
}

function inline(text) {
  let s = escapeHtml(text);
  s = s.replace(/`([^`]+)`/g, (_, c) => `<code style="font-family:Consolas,Menlo,monospace;font-size:10pt">${c}</code>`);
  s = s.replace(/!\[([^\]]*)\]\((cid:[^)\s]+|https?:\/\/[^)\s]+)\)/g, '<img src="$2" alt="$1" style="max-width:100%">');
  s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+|mailto:[^)\s]+)\)/g, '<a href="$2">$1</a>');
  s = s.replace(/(^|[^\w*])\*\*([^*]+)\*\*(?!\w)/g, '$1<strong>$2</strong>');
  s = s.replace(/(^|[^\w_])__([^_]+)__(?!\w)/g, '$1<strong>$2</strong>');
  s = s.replace(/(^|[^\w*])\*([^*\s][^*]*)\*(?!\w)/g, '$1<em>$2</em>');
  s = s.replace(/(^|[^\w_])_([^_\s][^_]*)_(?!\w)/g, '$1<em>$2</em>');
  s = s.replace(/~~([^~]+)~~/g, '<s>$1</s>');
  s = s.replace(/  $/gm, '<br>');
  return s;
}

// --- editing a reply draft above its quoted thread ---------------------------

const HTML_QUOTE_MARKERS = [
  /<div[^>]+id="?divRplyFwdMsg"?/i,            // Outlook / OWA reply header
  /<div[^>]+class="?gmail_quote/i,              // Gmail
  /<blockquote[^>]*type="?cite/i,               // Apple Mail, Thunderbird
  /<hr[^>]*>\s*(<[^>]+>\s*)*<b>\s*From:/i,      // Outlook desktop
  /<div[^>]+border-top:\s*solid\s+#E1E1E1/i,    // Outlook desktop (styled separator)
  /<div[^>]*>\s*On .{3,120}? wrote:\s*<\/div>/i, // our own IMAP replies and most clients
  /<div[^>]*>\s*-{5,} ?Forwarded message ?-{5,}/i, // our own IMAP forwards
  /_{10,}\s*<br\s*\/?>\s*From:/i,                // Exchange "converted from text" replies
  /<blockquote(?![^>]*\bmw-quote\b)/i           // last resort (not a quote typed in the side panel's editor: it marks its own)
];
const TEXT_QUOTE_MARKERS = [
  /^-{3,}\s*Original Message\s*-{3,}\s*$/im,
  /^-{5,} ?Forwarded message ?-{5,}\s*$/im,
  /^_{10,}\s*$/m,
  /^On .{3,200}? wrote:\s*$/im,
  /^From:\s.+\r?\n(Sent|Date):\s/im,
  /^(> ?.*(\r?\n|$)){2,}/m
];

/**
 * Split a reply/forward body into the part written above the quoted thread
 * and the quoted thread itself. Returns { head, tail } (tail '' when no quote
 * was recognised).
 */
export function splitQuoted(body, bodyType = 'Text') {
  const s = String(body ?? '');
  const markers = bodyType === 'HTML' ? HTML_QUOTE_MARKERS : TEXT_QUOTE_MARKERS;
  const first = (from) => {
    const rest = from ? s.slice(from) : s;
    let at = -1;
    for (const re of markers) {
      const m = re.exec(rest);
      if (m && (at < 0 || m.index < at)) at = m.index;
    }
    return at < 0 ? -1 : at + from;
  };
  let at = first(0);
  if (at >= 0 && bodyType === 'HTML') {
    // a signature is the person's own words: a line of it that reads like the start of a quote is not one
    const sig = signatureSpan(s);
    if (sig && sig.start < at && at < sig.end) at = first(sig.end);
  }
  if (at < 0) return { head: s, tail: '' };
  return { head: s.slice(0, at), tail: s.slice(at) };
}

/**
 * Where the signature block the side panel puts under the text is in an HTML
 * body (extension: panel/lib/signatures.ts, `<div … id="mw-sig-…">`): the
 * first one, which is the draft's own when it has one. null when there is
 * none, or it is never closed.
 */
function signatureSpan(s) {
  const open = /<div\s[^>]*\bid=["']?mw-sig-[^>]*>/i.exec(s);
  if (!open) return null;
  const tag = /<(\/?)div\b[^>]*>/gi;
  tag.lastIndex = open.index + open[0].length;
  let depth = 1;
  for (let m; (m = tag.exec(s));) {
    depth += m[1] ? -1 : 1;
    if (depth === 0) return { start: open.index, end: tag.lastIndex };
  }
  return null;
}

/**
 * The text written above a quote, and the line breaks it ends with: a reply
 * is built as text, two breaks, quote, and those breaks are the space
 * between the two, not something that was typed.
 */
export function splitBreaks(html) {
  const s = String(html ?? '');
  let end = s.length;
  for (;;) {
    while (end > 0 && /\s/.test(s[end - 1])) end--;
    const lt = s.lastIndexOf('<', end - 1);
    if (lt >= 0 && end - lt <= 8 && /^<br\s*\/?>$/i.test(s.slice(lt, end))) end = lt;
    else return { text: s.slice(0, end), breaks: s.slice(end) };
  }
}

/**
 * New body for a draft when only the text above the quote changes: the new
 * head (already prepared: { body, bodyType }) followed by the draft's existing
 * quoted tail, in the draft's own body type (text written for an HTML draft
 * becomes paragraphs; HTML written for a text draft is flattened).
 */
export function replaceAboveQuote(prepared, currentBody, currentType) {
  const { head: oldHead, tail } = splitQuoted(currentBody, currentType);
  if (!tail) return prepared;
  if (currentType === 'HTML') {
    const head = prepared.bodyType === 'HTML' ? prepared.body : textToHtml(prepared.body);
    // the space there was between the text and the quote stays between them
    return { body: `${htmlShell(oldHead)}${splitBreaks(head).text}${splitBreaks(oldHead).breaks}${tail}`, bodyType: 'HTML' };
  }
  if (prepared.bodyType === 'HTML') {
    // the new part needs HTML: upgrade the whole draft, quoting the old thread verbatim
    return { body: `${prepared.body}<div style="white-space:pre-wrap;${FONT}">${escapeHtml(tail)}</div>`, bodyType: 'HTML' };
  }
  return { body: `${prepared.body.replace(/\s+$/, '')}\n\n${tail}`, bodyType: 'Text' };
}

const INLINE_OPENER = /^(p|span|font|b|i|u|strong|em|a)$/i;
const VOID_TAG = /^(br|hr|img|meta|link|input|wbr|col|area|base|source)$/i;
const squash = (s) => String(s).replace(/\s+/g, '').replace(/;$/, '').toLowerCase();

/**
 * The opening tags of an HTML head that are still open when the quoted
 * thread starts (<html>, <body>, a server's <div class="PlainText">…), plus
 * the <head>/<style> blocks — everything the old text itself opened and
 * closed is dropped. Paragraph/inline openers and our own font wrapper are
 * never kept: they belonged to the old text (an unclosed wrapper is one an
 * earlier edit leaked; keeping it nested one more level per edit).
 */
function htmlShell(oldHead) {
  const out = [];
  const open = [];
  const re = /<!--[\s\S]*?-->|<(head|style)\b[^>]*>[\s\S]*?<\/\1\s*>|<![^>]*>|<(\/?)([a-z][\w:-]*)\b[^>]*?(\/?)>/gi;
  for (const m of String(oldHead).matchAll(re)) {
    if (m[1] || /^<!doctype/i.test(m[0])) { out.push(m[0]); continue; }
    if (!m[3]) continue; // comment
    const name = m[3].toLowerCase();
    if (m[2]) {
      const k = open.findLastIndex((o) => o.name === name);
      if (k >= 0) for (const o of open.splice(k)) o.closed = true;
    } else if (!m[4] && !VOID_TAG.test(name)) {
      const o = { name, tag: m[0], closed: false };
      open.push(o);
      out.push(o);
    }
  }
  const ours = (tag) => /^<div\b/i.test(tag) && squash((/\bstyle\s*=\s*"([^"]*)"/i.exec(tag) || [])[1] || '') === squash(FONT);
  return out
    .filter((o) => typeof o === 'string' || (!o.closed && !INLINE_OPENER.test(o.name) && !ours(o.tag)))
    .map((o) => (typeof o === 'string' ? o : o.tag))
    .join('');
}

export function textToHtml(text) {
  return `<div style="${FONT}">${String(text ?? '').replace(/\r\n?/g, '\n').split(/\n{2,}/).map((p) => `<p style="margin:0 0 10px">${escapeHtml(p).replace(/\n/g, '<br>')}</p>`).join('')}</div>`;
}

function htmlToPlain(html) {
  return String(html).replace(/<style[\s\S]*?<\/style>/gi, '').replace(/<br\s*\/?>|<\/p>|<\/div>|<\/tr>|<\/li>/gi, '\n').replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/\n{3,}/g, '\n\n').trim();
}
