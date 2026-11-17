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

test('an Exchange sign-in that is sent elsewhere is not followed', async () => {
  const { default: httpntlm } = await import('../src/ntlm-guard.js');
  const options = { url: 'https://mail.example.invalid/EWS/Exchange.asmx', username: 'a', password: 'secret', body: '' };
  // the first request of a handshake goes out (here: to nowhere); httpntlm follows a redirect by calling itself again with the same options
  await new Promise((resolve) => httpntlm.post(options, () => resolve()));
  for (const elsewhere of ['http://mail.example.invalid/EWS/Exchange.asmx', 'https://evil.example.invalid/EWS/Exchange.asmx']) {
    options.url = elsewhere;
    const err = await new Promise((resolve) => httpntlm.post(options, (e) => resolve(e)));
    assert.equal(err?.code, 'EWS_REDIRECT', elsewhere);
  }
  options.url = 'https://mail.example.invalid/owa/EWS/Exchange.asmx'; // the same server: followed
  const same = await new Promise((resolve) => httpntlm.post(options, (e) => resolve(e)));
  assert.notEqual(same?.code, 'EWS_REDIRECT');
}, { timeout: 30_000 });

test('getMessage asks for Reply-To and hands it out', async () => {
  const c = stubbed(`<?xml version="1.0" encoding="utf-8"?>
<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body>
<m:GetItemResponse xmlns:m="http://schemas.microsoft.com/exchange/services/2006/messages" xmlns:t="http://schemas.microsoft.com/exchange/services/2006/types">
<m:ResponseMessages><m:GetItemResponseMessage ResponseClass="Success"><m:ResponseCode>NoError</m:ResponseCode><m:Items>
<t:Message>
  <t:ItemId Id="AAMkAD1" ChangeKey="CQAAAB"/>
  <t:Subject>Lunch</t:Subject>
  <t:Body BodyType="Text">Friday?</t:Body>
  <t:DateTimeReceived>2026-10-24T08:30:00Z</t:DateTimeReceived>
  <t:From><t:Mailbox><t:Name>Ann</t:Name><t:EmailAddress>ann@x.org</t:EmailAddress></t:Mailbox></t:From>
  <t:ToRecipients><t:Mailbox><t:Name>Me</t:Name><t:EmailAddress>me@x.org</t:EmailAddress></t:Mailbox></t:ToRecipients>
  <t:ReplyTo><t:Mailbox><t:Name>Ann at home</t:Name><t:EmailAddress>ann@home.example</t:EmailAddress></t:Mailbox></t:ReplyTo>
</t:Message>
</m:Items></m:GetItemResponseMessage></m:ResponseMessages></m:GetItemResponse></s:Body></s:Envelope>`);
  const m = await c.getMessage('AAMkAD1');
  assert.match(c.sent[0], /FieldURI="message:ReplyTo"/);
  assert.deepEqual(m.replyTo.map((p) => p.email), ['ann@home.example']);
  assert.equal(m.replyTo[0].name, 'Ann at home');
});

const NS = 'xmlns:m="http://schemas.microsoft.com/exchange/services/2006/messages" xmlns:t="http://schemas.microsoft.com/exchange/services/2006/types"';
const soap = (inner) => `<?xml version="1.0" encoding="utf-8"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body>${inner}</s:Body></s:Envelope>`;

test('a mail attached to a mail is listed as an .eml, and downloaded as a mail of its own; a file as it is', async () => {
  const listed = stubbed(soap(`<m:GetItemResponse ${NS}><m:ResponseMessages><m:GetItemResponseMessage ResponseClass="Success"><m:ResponseCode>NoError</m:ResponseCode><m:Items><t:Message>
    <t:ItemId Id="AAMk1" ChangeKey="CK"/><t:Subject>Run this</t:Subject>
    <t:Attachments>
      <t:FileAttachment><t:AttachmentId Id="F1"/><t:Name>results.txt</t:Name><t:ContentType>text/plain</t:ContentType><t:Size>10</t:Size><t:IsInline>false</t:IsInline></t:FileAttachment>
      <t:ItemAttachment><t:AttachmentId Id="I1"/><t:Name>RE: Buyout_Rates_Update.xlsx</t:Name><t:Size>43000</t:Size><t:IsInline>false</t:IsInline></t:ItemAttachment>
    </t:Attachments></t:Message></m:Items></m:GetItemResponseMessage></m:ResponseMessages></m:GetItemResponse>`));
  const got = await listed.attachmentsOf(['AAMk1']);
  assert.deepEqual(got.get('AAMk1').map((a) => [a.id, a.name, a.contentType, a.mail === true]), [['F1', 'results.txt', 'text/plain', false], ['I1', 'RE: Buyout_Rates_Update.xlsx.eml', 'message/rfc822', true]]);

  const eml = 'From: a@x.org\r\nSubject: RE: Buyout\r\n\r\nSee attached.';
  const mail = stubbed(soap(`<m:GetAttachmentResponse ${NS}><m:ResponseMessages><m:GetAttachmentResponseMessage ResponseClass="Success"><m:ResponseCode>NoError</m:ResponseCode><m:Attachments>
    <t:ItemAttachment><t:AttachmentId Id="I1"/><t:Name>RE: Buyout_Rates_Update.xlsx</t:Name><t:Message><t:MimeContent CharacterSet="UTF-8">${Buffer.from(eml).toString('base64')}</t:MimeContent><t:Subject>RE: Buyout</t:Subject></t:Message></t:ItemAttachment>
  </m:Attachments></m:GetAttachmentResponseMessage></m:ResponseMessages></m:GetAttachmentResponse>`));
  const file = await mail.getAttachment('I1');
  assert.match(mail.sent[0], /<m:AttachmentShape><t:IncludeMimeContent>true<\/t:IncludeMimeContent><\/m:AttachmentShape>\s*<m:AttachmentIds>/);
  assert.equal(file.name, 'RE: Buyout_Rates_Update.xlsx.eml');
  assert.equal(file.contentType, 'message/rfc822');
  assert.equal(file.content.toString(), eml);

  const plain = stubbed(soap(`<m:GetAttachmentResponse ${NS}><m:ResponseMessages><m:GetAttachmentResponseMessage ResponseClass="Success"><m:ResponseCode>NoError</m:ResponseCode><m:Attachments>
    <t:FileAttachment><t:AttachmentId Id="F1"/><t:Name>results.txt</t:Name><t:ContentType>text/plain</t:ContentType><t:Content>${Buffer.from('ten bytes!').toString('base64')}</t:Content></t:FileAttachment>
  </m:Attachments></m:GetAttachmentResponseMessage></m:ResponseMessages></m:GetAttachmentResponse>`));
  assert.equal((await plain.getAttachment('F1')).content.toString(), 'ten bytes!');

  // an item Exchange does not write out as a mail: said plainly
  const contact = stubbed(soap(`<m:GetAttachmentResponse ${NS}><m:ResponseMessages><m:GetAttachmentResponseMessage ResponseClass="Success"><m:ResponseCode>NoError</m:ResponseCode><m:Attachments>
    <t:ItemAttachment><t:AttachmentId Id="I2"/><t:Name>Someone</t:Name><t:Contact><t:DisplayName>Someone</t:DisplayName></t:Contact></t:ItemAttachment>
  </m:Attachments></m:GetAttachmentResponseMessage></m:ResponseMessages></m:GetAttachmentResponse>`));
  await assert.rejects(contact.getAttachment('I2'), /cannot be downloaded/);
});

test('findInbox withAny goes through the content index: from, to or cc, any of the addresses', async () => {
  const c = stubbed(FIND_RESPONSE);
  await c.findInbox({ withAny: ['a@x.org', 'b@y.org'], limit: 5 });
  assert.match(c.sent[0], /<m:QueryString>\(from:&quot;a@x\.org&quot; OR to:&quot;a@x\.org&quot; OR cc:&quot;a@x\.org&quot; OR from:&quot;b@y\.org&quot; OR to:&quot;b@y\.org&quot; OR cc:&quot;b@y\.org&quot;\)<\/m:QueryString>/);
});

test('an attached item is named as what Exchange hands out: an event as .ics, a contact as .vcf, anything else as a mail', async () => {
  const one = (name, inner) => soap(`<m:GetAttachmentResponse ${NS}><m:ResponseMessages><m:GetAttachmentResponseMessage ResponseClass="Success"><m:ResponseCode>NoError</m:ResponseCode><m:Attachments><t:ItemAttachment><t:AttachmentId Id="I9"/><t:Name>${name}</t:Name>${inner}</t:ItemAttachment></m:Attachments></m:GetAttachmentResponseMessage></m:ResponseMessages></m:GetAttachmentResponse>`);
  const mime = (text) => `<t:MimeContent CharacterSet="UTF-8">${Buffer.from(text).toString('base64')}</t:MimeContent>`;
  const ics = await stubbed(one('Budget review', `<t:CalendarItem>${mime('BEGIN:VCALENDAR\r\nVERSION:2.0\r\nEND:VCALENDAR\r\n')}</t:CalendarItem>`)).getAttachment('I9');
  assert.deepEqual([ics.name, ics.contentType], ['Budget review.ics', 'text/calendar']);
  const vcf = await stubbed(one('Someone', `<t:Contact>${mime('BEGIN:VCARD\r\nFN:Someone\r\nEND:VCARD\r\n')}</t:Contact>`)).getAttachment('I9');
  assert.deepEqual([vcf.name, vcf.contentType], ['Someone.vcf', 'text/vcard']);
  const eml = await stubbed(one('RE: The lease', `<t:Message>${mime('From: a@x.org\r\nSubject: RE: The lease\r\n\r\nHello\r\n')}</t:Message>`)).getAttachment('I9');
  assert.deepEqual([eml.name, eml.contentType], ['RE: The lease.eml', 'message/rfc822']);
});

