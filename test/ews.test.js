import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EwsClient, parseEws } from '../src/ews.js';
import { esc, textOf, decodeEntities, assertSuccess, envelope } from '../src/ews-util.js';

const FIND_RESPONSE = `<?xml version="1.0" encoding="utf-8"?>
<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body>
<m:FindItemResponse xmlns:m="http://schemas.microsoft.com/exchange/services/2006/messages" xmlns:t="http://schemas.microsoft.com/exchange/services/2006/types">
<m:ResponseMessages><m:FindItemResponseMessage ResponseClass="Success"><m:ResponseCode>NoError</m:ResponseCode>
<m:RootFolder TotalItemsInView="1" IncludesLastItemInRange="true"><t:Items>
<t:Message>
  <t:ItemId Id="AAMkAD1" ChangeKey="CQAAAB"/>
  <t:Subject>Q3 &amp;lt;draft&amp;gt; &amp; notes</t:Subject>
  <t:DateTimeReceived>2026-10-24T08:30:00Z</t:DateTimeReceived>
  <t:HasAttachments>true</t:HasAttachments>
  <t:DisplayTo>Me</t:DisplayTo>
  <t:ConversationId Id="CONV1"/>
  <t:IsRead>false</t:IsRead>
  <t:From><t:Mailbox><t:Name>Ann</t:Name><t:EmailAddress>ann@x.org</t:EmailAddress></t:Mailbox></t:From>
  <t:InternetMessageId>&lt;m1@x.org&gt;</t:InternetMessageId>
</t:Message>
</t:Items></m:RootFolder></m:FindItemResponseMessage></m:ResponseMessages></m:FindItemResponse></s:Body></s:Envelope>`;

function stubbed(response) {
  const c = new EwsClient({ host: 'https://mail.example.org/', username: 'me', password: 'x', email: 'me@x.org' });
  c.sent = [];
  c.post = async (xml) => { c.sent.push(xml); return parseEws(response); };
  return c;
}

test('findInbox builds a restriction and parses the listing', async () => {
  const c = stubbed(FIND_RESPONSE);
  const items = await c.findInbox({ limit: 5, unreadOnly: true, subjectContains: 'a&b' });
  const xml = c.sent[0];
  assert.match(xml, /<m:FindItem Traversal="Shallow">/);
  assert.match(xml, /MaxEntriesReturned="5"/);
  assert.match(xml, /<t:And>.*FieldURI="item:Subject"\/><t:Constant Value="a&amp;b"\/>/s);
  assert.match(xml, /FieldURI="message:IsRead"/);
  assert.match(xml, /<t:DistinguishedFolderId Id="inbox"\/>/);
  assert.match(xml, /<m:SortOrder>/);
  assert.deepEqual(items, [{
    id: 'AAMkAD1', changeKey: 'CQAAAB', subject: 'Q3 &lt;draft&gt; & notes', fromName: 'Ann', fromEmail: 'ann@x.org',
    displayTo: 'Me', isRead: false, isFlagged: false, hasAttachments: true, received: '2026-10-24T08:30:00Z',
    conversationId: 'CONV1', messageId: '<m1@x.org>', inReplyTo: ''
  }]);
});

test('text search goes through an AQS query string without a sort order', async () => {
  const c = stubbed(FIND_RESPONSE);
  await c.findInbox({ text: ['invoice', 'q"3'], folder: 'sent' });
  const xml = c.sent[0];
  assert.match(xml, /<m:QueryString>\(subject:&quot;invoice&quot; OR body:&quot;invoice&quot;\) AND \(subject:&quot;q 3&quot;/);
  assert.doesNotMatch(xml, /<m:SortOrder>/);
  assert.match(xml, /Id="sentitems"/);
});

test('an unknown folder is refused before any request', async () => {
  const c = stubbed(FIND_RESPONSE);
  await assert.rejects(c.findInbox({ folder: 'nowhere' }), /unknown folder/);
  assert.equal(c.sent.length, 0);
});

test('EWS errors carry the response code', () => {
  assert.throws(() => assertSuccess({ '@ResponseClass': 'Error', ResponseCode: 'ErrorItemNotFound', MessageText: 'gone' }, 'GetItem'),
    (e) => e.ewsCode === 'ErrorItemNotFound' && /GetItem: Error — gone/.test(e.message));
});

test('escaping and decoding happen exactly once', () => {
  assert.equal(esc(`<'&">`), '&lt;&apos;&amp;&quot;&gt;');
  assert.equal(decodeEntities('&amp;lt; &#38;lt; &#x41;'), '&lt; &lt; A');
  assert.equal(textOf({ '#text': 'a &amp; b' }), 'a & b');
  assert.equal(textOf(undefined), '');
  assert.match(envelope('<x/>'), /<soap:Body><x\/><\/soap:Body>/);
});
