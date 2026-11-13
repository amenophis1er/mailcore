import { test } from 'node:test';
import assert from 'node:assert/strict';
import { simpleParser } from 'mailparser';
import { authHeadersFrom, authHeadersOfParsed, headerPairs } from '../src/auth-headers.js';
import { EwsClient, parseEws } from '../src/ews.js';

const RAW = [
  'Delivered-To: me@gmail.com',
  'ARC-Authentication-Results: i=1; mx.google.com;',
  '       dmarc=pass (p=REJECT) header.from=bank.example',
  'Authentication-Results: mx.google.com;',
  '       dkim=pass header.i=@bank.example;',
  '       dmarc=pass (p=REJECT sp=REJECT dis=NONE) header.from=bank.example',
  'BIMI-Selector: v=BIMI1; s=brand;',
  'Authentication-Results: forged.example; dmarc=pass header.from=paypal.example',
  'From: Bank <news@bank.example>',
  'Subject: hi',
  '',
  'body',
  ''
].join('\r\n');

test('authHeadersFrom keeps every Authentication-Results, topmost first, unfolded; ARC ones are not among them', () => {
  const h = authHeadersFrom(headerPairs(RAW));
  assert.equal(h.results.length, 2);
  assert.match(h.results[0], /^mx\.google\.com; dkim=pass header\.i=@bank\.example; dmarc=pass/);
  assert.match(h.results[1], /^forged\.example;/);
  assert.equal(h.bimiSelector, 'v=BIMI1; s=brand;');
  assert.equal(h.msAuthAs, '');
});

test('headerPairs stops at the body and caps nothing it should not', () => {
  const pairs = headerPairs(RAW + 'Authentication-Results: in.the.body; dmarc=pass\r\n');
  assert.equal(pairs.filter(([k]) => k.toLowerCase() === 'authentication-results').length, 2);
});

test('a message read by mailparser gives the same, in the same order', async () => {
  const parsed = await simpleParser(RAW);
  const h = authHeadersOfParsed(parsed);
  assert.equal(h.results.length, 2);
  assert.match(h.results[0], /^mx\.google\.com;/);
  assert.match(h.results[1], /^forged\.example;/);
});

test('at most ten results, controls out', () => {
  const pairs = Array.from({ length: 15 }, (_, i) => ['Authentication-Results', `h${i}.example; dmarc=pass\u0000 header.from=x.example`]);
  const h = authHeadersFrom(pairs);
  assert.equal(h.results.length, 10);
  assert.doesNotMatch(h.results[0], /\u0000/);
});

function stubbed(response, fail) {
  const c = new EwsClient({ host: 'https://mail.example.org/', username: 'me', password: 'x', email: 'me@x.org' });
  c.sent = [];
  c.post = async (xml) => { c.sent.push(xml); if (fail) throw fail; return parseEws(response); };
  return c;
}

const env = (body) => `<?xml version="1.0" encoding="utf-8"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body>${body}</s:Body></s:Envelope>`;

test('EWS authHeadersOf: the headers of each message, in order, and its From', async () => {
  const c = stubbed(env(`<m:GetItemResponse xmlns:m="http://schemas.microsoft.com/exchange/services/2006/messages" xmlns:t="http://schemas.microsoft.com/exchange/services/2006/types"><m:ResponseMessages>
    <m:GetItemResponseMessage ResponseClass="Success"><m:ResponseCode>NoError</m:ResponseCode><m:Items><t:Message><t:ItemId Id="A1" ChangeKey="x"/>
      <t:InternetMessageHeaders>
        <t:InternetMessageHeader HeaderName="Received">from a</t:InternetMessageHeader>
        <t:InternetMessageHeader HeaderName="Authentication-Results">spf=pass (sender IP is 1.2.3.4) smtp.mailfrom=shop.example; dkim=pass (signature was verified) header.d=shop.example;dmarc=pass action=none header.from=shop.example;compauth=pass reason=100</t:InternetMessageHeader>
        <t:InternetMessageHeader HeaderName="X-MS-Exchange-Organization-AuthAs">Anonymous</t:InternetMessageHeader>
        <t:InternetMessageHeader HeaderName="Authentication-Results">evil.example; dmarc=pass header.from=bank.example</t:InternetMessageHeader>
      </t:InternetMessageHeaders>
      <t:From><t:Mailbox><t:Name>Shop</t:Name><t:EmailAddress>News@Shop.example</t:EmailAddress></t:Mailbox></t:From>
    </t:Message></m:Items></m:GetItemResponseMessage>
    <m:GetItemResponseMessage ResponseClass="Error"><m:ResponseCode>ErrorItemNotFound</m:ResponseCode></m:GetItemResponseMessage>
  </m:ResponseMessages></m:GetItemResponse>`));
  const m = await c.authHeadersOf(['A1', 'A2']);
  assert.match(c.sent[0], /item:InternetMessageHeaders/);
  assert.equal(m.size, 1);
  const a = m.get('A1');
  assert.equal(a.fromEmail, 'news@shop.example');
  assert.equal(a.results.length, 2);
  assert.match(a.results[0], /^spf=pass/);
  assert.equal(a.msAuthAs, 'Anonymous');
});

test('EWS userPhoto: the picture, none, and a server without the operation', async () => {
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]).toString('base64');
  const ok = stubbed(env(`<GetUserPhotoResponse ResponseClass="Success" xmlns="http://schemas.microsoft.com/exchange/services/2006/messages"><ResponseCode>NoError</ResponseCode><HasChanged>true</HasChanged><PictureData>${jpeg}</PictureData></GetUserPhotoResponse>`));
  const p = await ok.userPhoto('ann@x.org');
  assert.equal(p.contentType, 'image/jpeg');
  assert.equal(p.data[0], 0xff);
  assert.match(ok.sent[0], /<m:GetUserPhoto><m:Email>ann@x\.org<\/m:Email><m:SizeRequested>HR96x96<\/m:SizeRequested>/);

  const none = stubbed(env(`<GetUserPhotoResponse ResponseClass="Error" xmlns="http://schemas.microsoft.com/exchange/services/2006/messages"><ResponseCode>ErrorItemNotFound</ResponseCode></GetUserPhotoResponse>`));
  assert.equal(await none.userPhoto('bob@x.org'), null);
  assert.equal(await stubbed('', new Error('EWS HTTP 500: <s:Fault>ErrorItemNotFound</s:Fault>')).userPhoto('bob@x.org'), null);

  const old = stubbed('', new Error('EWS HTTP 500: The request failed schema validation'));
  await assert.rejects(old.userPhoto('bob@x.org'), (e) => e.unsupported === true);
  const dropped = stubbed('', Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }));
  await assert.rejects(dropped.userPhoto('bob@x.org'), (e) => !e.unsupported);

  // not an image (an HTML page in base64): nothing
  const odd = stubbed(env(`<GetUserPhotoResponse ResponseClass="Success" xmlns="http://schemas.microsoft.com/exchange/services/2006/messages"><ResponseCode>NoError</ResponseCode><PictureData>${Buffer.from('<html>').toString('base64')}</PictureData></GetUserPhotoResponse>`));
  assert.equal(await odd.userPhoto('ann@x.org'), null);
  // an address is escaped into the request
  await ok.userPhoto('a<b>@x.org');
  assert.match(ok.sent[1], /a&lt;b&gt;@x\.org/);
});

test('X-Gmail-Fetch-Info is kept: mail Gmail fetched from elsewhere', () => {
  const h = authHeadersFrom([['X-Gmail-Fetch-Info', 'me@other.example 1 pop.other.example 995 me'], ['Authentication-Results', 'mx.google.com; dmarc=pass header.from=bank.example']]);
  assert.equal(h.gmailFetchInfo, 'me@other.example 1 pop.other.example 995 me');
  assert.equal(authHeadersFrom([]).gmailFetchInfo, '');
});

test('EWS userPhoto: NoError is success even without ResponseClass; an error code is not, whatever the class says', async () => {
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]).toString('base64');
  const bare = stubbed(env(`<GetUserPhotoResponse xmlns="http://schemas.microsoft.com/exchange/services/2006/messages"><ResponseCode>NoError</ResponseCode><PictureData>${jpeg}</PictureData></GetUserPhotoResponse>`));
  assert.equal((await bare.userPhoto('ann@x.org')).contentType, 'image/jpeg');
  const odd = stubbed(env(`<GetUserPhotoResponse ResponseClass="Warning" xmlns="http://schemas.microsoft.com/exchange/services/2006/messages"><ResponseCode>NoError</ResponseCode><PictureData>${jpeg}</PictureData></GetUserPhotoResponse>`));
  assert.equal((await odd.userPhoto('ann@x.org')).contentType, 'image/jpeg');
  const none = stubbed(env(`<GetUserPhotoResponse ResponseClass="Success" xmlns="http://schemas.microsoft.com/exchange/services/2006/messages"><ResponseCode>ErrorItemNotFound</ResponseCode></GetUserPhotoResponse>`));
  assert.equal(await none.userPhoto('ann@x.org'), null);
});

test('EWS sentTo: To only, SMTP only, automatic answers left out, with when each was sent', async () => {
  const c = new EwsClient({ host: 'https://mail.example.org/', username: 'me', password: 'x', email: 'me@x.org' });
  c.findInbox = async (o) => { assert.equal(o.folder, 'sent'); return ['S1', 'S2', 'S3', 'S4', 'S5', 'S6'].map((id) => ({ id })); };
  let asked = '';
  c.post = async (xml) => { asked = xml; return parseEws(env(`<m:GetItemResponse xmlns:m="http://schemas.microsoft.com/exchange/services/2006/messages" xmlns:t="http://schemas.microsoft.com/exchange/services/2006/types"><m:ResponseMessages>
    <m:GetItemResponseMessage ResponseClass="Success"><m:Items><t:Message><t:ItemId Id="S1"/><t:ItemClass>IPM.Note</t:ItemClass><t:Subject>Lunch</t:Subject><t:DateTimeSent>2026-10-01T10:00:00Z</t:DateTimeSent>
      <t:ToRecipients><t:Mailbox><t:Name>Ann</t:Name><t:EmailAddress>Ann@Partner.example</t:EmailAddress><t:RoutingType>SMTP</t:RoutingType></t:Mailbox><t:Mailbox><t:EmailAddress>/o=ExchangeLabs/cn=x</t:EmailAddress><t:RoutingType>EX</t:RoutingType></t:Mailbox></t:ToRecipients>
    </t:Message></m:Items></m:GetItemResponseMessage>
    <m:GetItemResponseMessage ResponseClass="Success"><m:Items><t:Message><t:ItemId Id="S2"/><t:ItemClass>IPM.Note.Rules.OofTemplate.Microsoft</t:ItemClass><t:Subject>Automatic reply: Offer</t:Subject><t:DateTimeSent>2026-10-02T10:00:00Z</t:DateTimeSent>
      <t:ToRecipients><t:Mailbox><t:EmailAddress>spammer@evil.example</t:EmailAddress></t:Mailbox></t:ToRecipients>
    </t:Message></m:Items></m:GetItemResponseMessage>
    <m:GetItemResponseMessage ResponseClass="Success"><m:Items><t:Message><t:ItemId Id="S3"/><t:ItemClass>IPM.Note</t:ItemClass><t:Subject>Out of Office: back Monday</t:Subject><t:DateTimeSent>2026-10-03T10:00:00Z</t:DateTimeSent>
      <t:ToRecipients><t:Mailbox><t:EmailAddress>other@evil.example</t:EmailAddress></t:Mailbox></t:ToRecipients>
    </t:Message></m:Items></m:GetItemResponseMessage>
    <m:GetItemResponseMessage ResponseClass="Success"><m:Items><t:Message><t:ItemId Id="S4"/><t:ItemClass>IPM.Note</t:ItemClass><t:Subject>Re: Q4</t:Subject><t:DateTimeSent>2026-10-04T10:00:00Z</t:DateTimeSent>
      <t:ToRecipients><t:Mailbox><t:EmailAddress>bob@bank.example</t:EmailAddress></t:Mailbox></t:ToRecipients>
      <t:ExtendedProperty><t:ExtendedFieldURI DistinguishedPropertySetId="InternetHeaders" PropertyName="auto-submitted" PropertyType="String"/><t:Value>no</t:Value></t:ExtendedProperty>
    </t:Message></m:Items></m:GetItemResponseMessage>
    <m:GetItemResponseMessage ResponseClass="Success"><m:Items><t:Message><t:ItemId Id="S5"/><t:ItemClass>IPM.Note</t:ItemClass><t:Subject>Re: Your offer</t:Subject><t:DateTimeSent>2026-10-05T10:00:00Z</t:DateTimeSent>
      <t:ToRecipients><t:Mailbox><t:EmailAddress>stranger@evil.example</t:EmailAddress></t:Mailbox></t:ToRecipients>
      <t:ExtendedProperty><t:ExtendedFieldURI DistinguishedPropertySetId="InternetHeaders" PropertyName="auto-submitted" PropertyType="String"/><t:Value>auto-replied</t:Value></t:ExtendedProperty>
    </t:Message></m:Items></m:GetItemResponseMessage>
    <m:GetItemResponseMessage ResponseClass="Success"><m:Items><t:Message><t:ItemId Id="S6"/><t:ItemClass>IPM.Note</t:ItemClass><t:Subject>Re: Hello</t:Subject><t:DateTimeSent>2026-10-06T10:00:00Z</t:DateTimeSent>
      <t:ToRecipients><t:Mailbox><t:EmailAddress>stranger2@evil.example</t:EmailAddress></t:Mailbox></t:ToRecipients>
      <t:ExtendedProperty><t:ExtendedFieldURI DistinguishedPropertySetId="InternetHeaders" PropertyName="x-auto-response-suppress" PropertyType="String"/><t:Value>All</t:Value></t:ExtendedProperty>
    </t:Message></m:Items></m:GetItemResponseMessage>
  </m:ResponseMessages></m:GetItemResponse>`)); };
  const out = await c.sentTo();
  assert.doesNotMatch(asked, /CcRecipients|BccRecipients/);
  assert.match(asked, /DistinguishedPropertySetId="InternetHeaders" PropertyName="auto-submitted"/);
  assert.deepEqual(out, [{ to: ['ann@partner.example'], sent: '2026-10-01T10:00:00.000Z' }, { to: ['bob@bank.example'], sent: '2026-10-04T10:00:00.000Z' }]);
});

test('isAutoReply: by subject or by its headers', async () => {
  const { isAutoReply } = await import('../src/auto-reply.js');
  assert.equal(isAutoReply('Automatic reply: Offer'), true);
  assert.equal(isAutoReply('Réponse automatique : absent'), true);
  assert.equal(isAutoReply('Out of Office'), true);
  assert.equal(isAutoReply('Re: lunch', 'Auto-Submitted: auto-replied\r\n'), true);
  assert.equal(isAutoReply('Re: lunch', 'Auto-Submitted: no\r\n'), false);
  assert.equal(isAutoReply('Re: lunch', 'X-Autoreply: yes\r\n'), true);
  assert.equal(isAutoReply('Re: automation project'), false);
  assert.equal(isAutoReply('Re: lunch', 'Precedence: auto_reply\r\n'), true);
  assert.equal(isAutoReply('Re: lunch', 'Precedence: bulk\r\n'), false);
  assert.equal(isAutoReply('Re: lunch', 'X-Auto-Response-Suppress: All\r\n'), true);
});

test('an Authentication-Results too long to keep is kept as one that parses as nothing, in its place', async () => {
  const { OVERSIZED } = await import('../src/auth-headers.js');
  // a long first result, and a second dmarc past the cut that says fail
  const long = `mx.google.com; dmarc=pass header.from=bank.example; x-note=${'a'.repeat(5000)}; dmarc=fail header.from=bank.example`;
  const h = authHeadersFrom([['Authentication-Results', long], ['Authentication-Results', 'mx.google.com; dmarc=pass header.from=bank.example']]);
  assert.equal(h.results.length, 2);
  assert.equal(h.results[0], OVERSIZED);
  assert.ok(!h.results[0].includes('dmarc'));
  assert.equal(authHeadersFrom([['Authentication-Results', 'x'.repeat(4096)]]).results[0].length, 4096); // at the limit: kept whole
});

test('AccountClient.authHeadersOf leaves out ids of another account; IMAP leaves out ids that do not parse', async () => {
  const { AccountClient } = await import('../src/client.js');
  const seen = [];
  const ac = new AccountClient('g', { authHeadersOf: async (ids) => { seen.push(...ids); return new Map(); } });
  await ac.authHeadersOf(['g:INBOX/1/2', 'other:INBOX/1/3']);
  assert.deepEqual(seen, ['INBOX/1/2']);
  const { ImapClient } = await import('../src/imap.js');
  const imap = Object.create(ImapClient.prototype);
  // nothing that parses: answered without a connection
  assert.equal((await imap.authHeadersOf(['nonsense', 'also/bad'])).size, 0);
});
