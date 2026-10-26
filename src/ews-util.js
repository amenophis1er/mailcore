// Shared EWS SOAP plumbing: envelope, XML escaping, response digging.
// Used by the mail client (ews.js) and the calendar client (ews-calendar.js).

export function envelope(bodyXml) {
  return `<?xml version="1.0" encoding="utf-8"?>
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"
  xmlns:t="http://schemas.microsoft.com/exchange/services/2006/types"
  xmlns:m="http://schemas.microsoft.com/exchange/services/2006/messages">
  <soap:Header><t:RequestServerVersion Version="Exchange2013_SP1"/></soap:Header>
  <soap:Body>${bodyXml}</soap:Body>
</soap:Envelope>`;
}

export function esc(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

export function dig(obj, path) {
  return path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

export function toArray(x) {
  if (x === undefined || x === null) return [];
  return Array.isArray(x) ? x : [x];
}

export function textOf(node) {
  if (node === undefined || node === null) return '';
  const raw = typeof node === 'string' || typeof node === 'number' || typeof node === 'boolean' ? String(node) : String(node['#text'] ?? '');
  return decodeEntities(raw);
}

const NAMED = { lt: '<', gt: '>', quot: '"', apos: "'", amp: '&' };

/** One pass, so "&amp;lt;" stays "&lt;" (and "&#38;lt;" too). */
export function decodeEntities(s) {
  return s.replace(/&(?:#x([0-9a-f]+)|#(\d+)|(lt|gt|quot|apos|amp));/gi, (m, h, d, n) =>
    h ? String.fromCodePoint(parseInt(h, 16)) : d ? String.fromCodePoint(Number(d)) : NAMED[n.toLowerCase()] ?? m);
}

export function parseMailbox(mb) {
  return { name: textOf(mb?.Name), email: textOf(mb?.EmailAddress) };
}

export function assertSuccess(rm, op) {
  if (!rm) throw new Error(op + ': malformed EWS response');
  const first = toArray(rm)[0];
  if (first['@ResponseClass'] !== 'Success') {
    const code = first.ResponseCode || '';
    const e = new Error(`${op}: ${first['@ResponseClass']} — ${textOf(first.MessageText) || code || 'unknown EWS error'}`);
    e.ewsCode = code;
    throw e;
  }
}
