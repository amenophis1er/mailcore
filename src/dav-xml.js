// Just enough XML for WebDAV: a multistatus answer parsed into elements that
// know their namespace, text with entities decoded. No DTDs, no external
// entities, nothing fetched. Elements are matched by namespace + local name,
// never by prefix (every server picks its own: d:, D:, none).
// Ported from Amen's buddi calendar plugin (Apache-2.0).

export const DAV = 'DAV:';
export const CALDAV = 'urn:ietf:params:xml:ns:caldav';
export const APPLE = 'http://apple.com/ns/ical/';
export const CS = 'http://calendarserver.org/ns/';

const ENTITIES = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };
const MAX_ELEMENTS = 200000;

export function decodeEntities(text) {
  return text.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi, (whole, body) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    return ENTITIES[body.toLowerCase()] ?? whole;
  });
}

export function escapeXml(text) {
  return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function parseXml(source) {
  const root = { ns: '', name: '#document', children: [], attrs: {}, text: '' };
  const stack = [{ el: root, scope: { xml: 'http://www.w3.org/XML/1998/namespace' } }];
  let i = 0;
  let count = 0;
  const n = source.length;
  while (i < n) {
    const lt = source.indexOf('<', i);
    const top = stack[stack.length - 1];
    if (lt === -1) { top.el.text += decodeEntities(source.slice(i)); break; }
    if (lt > i) top.el.text += decodeEntities(source.slice(i, lt));
    if (source.startsWith('<!--', lt)) {
      const end = source.indexOf('-->', lt + 4);
      if (end === -1) throw new Error('not XML (unclosed comment)');
      i = end + 3; continue;
    }
    if (source.startsWith('<![CDATA[', lt)) {
      const end = source.indexOf(']]>', lt + 9);
      if (end === -1) throw new Error('not XML (unclosed CDATA)');
      top.el.text += source.slice(lt + 9, end);
      i = end + 3; continue;
    }
    if (source.startsWith('<?', lt)) {
      const end = source.indexOf('?>', lt + 2);
      if (end === -1) throw new Error('not XML');
      i = end + 2; continue;
    }
    if (source.startsWith('<!', lt)) {
      const end = source.indexOf('>', lt + 2);
      if (end === -1 || source.slice(lt, end).includes('[')) throw new Error('the answer carries a doctype we do not read');
      i = end + 1; continue;
    }
    const gt = findTagEnd(source, lt + 1);
    if (gt === -1) throw new Error('not XML (unclosed tag)');
    const raw = source.slice(lt + 1, gt);
    i = gt + 1;
    if (raw.startsWith('/')) {
      if (stack.length <= 1) throw new Error('not XML (stray closing tag)');
      stack.pop(); continue;
    }
    const selfClosing = raw.endsWith('/');
    const body = selfClosing ? raw.slice(0, -1) : raw;
    const nameMatch = /^([^\s/>]+)/.exec(body);
    if (!nameMatch) throw new Error('not XML (tag without a name)');
    const qname = nameMatch[1];
    const scope = { ...top.scope };
    const attrs = {};
    for (const m of body.slice(qname.length).matchAll(/([^\s=]+)\s*=\s*("([^"]*)"|'([^']*)')/g)) {
      const attr = m[1];
      const value = decodeEntities(m[3] ?? m[4] ?? '');
      if (attr === 'xmlns') scope[''] = value;
      else if (attr.startsWith('xmlns:')) scope[attr.slice(6)] = value;
      else attrs[attr.includes(':') ? attr.slice(attr.indexOf(':') + 1) : attr] = value;
    }
    const colon = qname.indexOf(':');
    const prefix = colon === -1 ? '' : qname.slice(0, colon);
    const local = colon === -1 ? qname : qname.slice(colon + 1);
    const el = { ns: scope[prefix] ?? '', name: local, children: [], attrs, text: '' };
    if (++count > MAX_ELEMENTS) throw new Error('the answer is too large to read');
    top.el.children.push(el);
    if (!selfClosing) stack.push({ el, scope });
  }
  const doc = root.children[0];
  if (!doc) throw new Error('not XML (no element)');
  return doc;
}

function findTagEnd(source, from) {
  let quote = null;
  for (let j = from; j < source.length; j++) {
    const c = source[j];
    if (quote) { if (c === quote) quote = null; }
    else if (c === '"' || c === "'") quote = c;
    else if (c === '>') return j;
  }
  return -1;
}

export function childrenOf(el, ns, name) {
  return el ? el.children.filter((c) => c.ns === ns && c.name === name) : [];
}
export function childOf(el, ns, name) {
  return el?.children.find((c) => c.ns === ns && c.name === name);
}
