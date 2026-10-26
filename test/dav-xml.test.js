import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseXml, childOf, childrenOf, escapeXml, DAV, CALDAV, APPLE } from '../src/dav-xml.js';

const MULTISTATUS = `<?xml version="1.0" encoding="utf-8"?>
<d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav" xmlns:a="http://apple.com/ns/ical/">
  <!-- a comment -->
  <d:response>
    <d:href>/cal/home/</d:href>
    <d:propstat>
      <d:prop>
        <d:displayname>Home &amp; family</d:displayname>
        <a:calendar-color>#FF0000</a:calendar-color>
        <c:supported-calendar-component-set><c:comp name="VEVENT"/></c:supported-calendar-component-set>
      </d:prop>
      <d:status>HTTP/1.1 200 OK</d:status>
    </d:propstat>
  </d:response>
  <response xmlns="DAV:"><href>/cal/work/</href></response>
</d:multistatus>`;

test('parseXml resolves namespaces, prefixed and default', () => {
  const ms = parseXml(MULTISTATUS); // the root element
  assert.equal(ms.ns, DAV);
  assert.equal(ms.name, 'multistatus');
  const responses = childrenOf(ms, DAV, 'response');
  assert.equal(responses.length, 2);
  assert.equal(childOf(responses[0], DAV, 'href').text, '/cal/home/');
  assert.equal(childOf(responses[1], DAV, 'href').text, '/cal/work/');
  const prop = childOf(childOf(responses[0], DAV, 'propstat'), DAV, 'prop');
  assert.equal(childOf(prop, DAV, 'displayname').text, 'Home & family');
  assert.equal(childOf(prop, APPLE, 'calendar-color').text, '#FF0000');
  const comp = childOf(childOf(prop, CALDAV, 'supported-calendar-component-set'), CALDAV, 'comp');
  assert.equal(comp.attrs.name, 'VEVENT');
});

test('escapeXml escapes the XML specials', () => {
  assert.equal(escapeXml('<a b="c">&</a>'), '&lt;a b=&quot;c&quot;&gt;&amp;&lt;/a&gt;');
});
