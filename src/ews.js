// EWS (Exchange Web Services) client over NTLM.
// Talks SOAP to /EWS/Exchange.asmx — the server advertises NTLM/Negotiate,
// so every call authenticates with the AD username/password it is given.

import httpntlm from './ntlm-guard.js'; // httpntlm, kept from following a redirect elsewhere with the sign-in
import { XMLParser } from 'fast-xml-parser';
import { envelope, esc, dig, toArray, textOf, parseMailbox, assertSuccess } from './ews-util.js';
import { calendarMethods } from './ews-calendar.js';
import { authHeadersFrom } from './auth-headers.js';
import { isAutoReply, AUTO_REPLY_HEADERS } from './auto-reply.js';

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@',
  removeNSPrefix: true,
  // keep values as strings: a free/busy grid like "000200" must not become 200
  parseTagValue: false,
  // entities are decoded once, by textOf(); decoding here too turned an HTML
  // body's &lt;https://…&gt; into a raw <https://…> tag
  processEntities: false
});

/** Parse an EWS SOAP response the way the client does (exported for tests). */
export function parseEws(xml) {
  return parser.parse(xml);
}

/** A mail attached to a mail, named as a file: its subject, and .eml. */
const mailName = (name) => { const n = String(name || '').trim() || 'Attached mail'; return /\.eml$/i.test(n) ? n : `${n}.eml`; };

/**
 * The attachments of an item as read from GetItem: files as they are, and the mails attached to it (items, to
 * Exchange) as .eml files of type message/rfc822 (`mail: true`; getAttachment hands each out as a mail of its own).
 */
function attachmentsIn(item) {
  return ['FileAttachment', 'ItemAttachment'].flatMap((kind) => toArray(dig(item, 'Attachments.' + kind)).map((a) => ({
    id: a.AttachmentId?.['@Id'] || '',
    name: kind === 'ItemAttachment' ? mailName(textOf(a.Name)) : textOf(a.Name),
    size: Number(a.Size) || 0,
    contentType: kind === 'ItemAttachment' ? 'message/rfc822' : textOf(a.ContentType),
    contentId: textOf(a.ContentId) || undefined,
    inline: String(a.IsInline) === 'true',
    ...(kind === 'ItemAttachment' ? { mail: true } : {})
  })));
}

export class EwsClient {
  constructor({ host, username, password, domain = '', email = '' }) {
    this.url = host.replace(/\/$/, '') + '/EWS/Exchange.asmx';
    this.username = username;
    this.password = password;
    this.domain = domain;
    this.self = String(email || '').toLowerCase(); // own SMTP address; resolved lazily when not configured
  }

  /** Own SMTP address: from config, else ResolveNames on the login name (cached). */
  async selfEmail() {
    if (this.self) return this.self;
    const json = await this.post(envelope(`<m:ResolveNames ReturnFullContactData="false"><m:UnresolvedEntry>${esc(this.username)}</m:UnresolvedEntry></m:ResolveNames>`));
    const res = toArray(dig(json, 'Envelope.Body.ResolveNamesResponse.ResponseMessages.ResolveNamesResponseMessage.ResolutionSet.Resolution'))[0];
    this.self = textOf(res?.Mailbox?.EmailAddress).toLowerCase();
    if (!this.self) throw new Error(`cannot resolve my own address from "${this.username}" — set "email" on the account`);
    return this.self;
  }

  /**
   * People whose name or address starts with `query`: the organisation's
   * directory first, then the mailbox's own Contacts. [{ name, email }], at
   * most what the server returns for an ambiguous name (100).
   */
  async resolveNames(query) {
    const json = await this.post(envelope(`<m:ResolveNames ReturnFullContactData="false" SearchScope="ActiveDirectoryContacts"><m:UnresolvedEntry>${esc(query)}</m:UnresolvedEntry></m:ResolveNames>`));
    // "several matches" is a warning and "none" an error: both are answers here
    const set = dig(json, 'Envelope.Body.ResolveNamesResponse.ResponseMessages.ResolveNamesResponseMessage.ResolutionSet');
    return toArray(set?.Resolution)
      .map((r) => ({ name: textOf(r?.Mailbox?.Name), email: textOf(r?.Mailbox?.EmailAddress), routing: textOf(r?.Mailbox?.RoutingType) }))
      .filter((p) => p.email.includes('@') && (!p.routing || p.routing === 'SMTP'))
      .map(({ name, email }) => ({ name, email }));
  }

  /**
   * The people of the mailbox's own Contacts folder: [{ name, email, emails, company, title, phones }], at most
   * `limit` (the folder's first ones, by name), with id, department, nickname, addresses [{ kind, text }] and
   * birthday ('YYYY-MM-DD') when it has them. Those with no address are left out, but with `all` (then kept with a
   * name or a phone).
   */
  async contacts({ limit = 500, all: keepAll = false } = {}) {
    // by name, a page at a time, up to `limit`
    const all = [];
    for (let offset = 0; offset < limit; offset += 500) {
      const json = await this.post(envelope(`
        <m:FindItem Traversal="Shallow">
          <m:ItemShape><t:BaseShape>AllProperties</t:BaseShape></m:ItemShape>
          <m:IndexedPageItemView MaxEntriesReturned="${Math.min(500, limit - offset)}" Offset="${offset}" BasePoint="Beginning"/>
          <m:SortOrder><t:FieldOrder Order="Ascending"><t:FieldURI FieldURI="contacts:DisplayName"/></t:FieldOrder></m:SortOrder>
          <m:ParentFolderIds><t:DistinguishedFolderId Id="contacts"/></m:ParentFolderIds>
        </m:FindItem>`));
      const rm = dig(json, 'Envelope.Body.FindItemResponse.ResponseMessages.FindItemResponseMessage');
      assertSuccess(rm, 'FindItem(contacts)');
      const page = toArray((rm?.RootFolder?.Items || {}).Contact);
      all.push(...page);
      if (page.length < 500 || String(rm?.RootFolder?.['@IncludesLastItemInRange']) === 'true') break;
    }
    return all.map((c) => {
      const emails = toArray(c?.EmailAddresses?.Entry).map((e) => textOf(e)).filter((e) => e.includes('@') && !/^\/o=/i.test(e));
      const phones = toArray(c?.PhoneNumbers?.Entry).map((p) => ({ kind: String(p?.['@Key'] || ''), number: textOf(p) })).filter((p) => p.number);
      const out = { name: textOf(c?.DisplayName) || textOf(c?.CompleteName?.FullName), email: emails[0] || '', emails, company: textOf(c?.CompanyName), title: textOf(c?.JobTitle), phones };
      const id = c?.ItemId?.['@Id'];
      if (typeof id === 'string' && id) out.id = id;
      if (textOf(c?.Department)) out.department = textOf(c.Department);
      if (textOf(c?.Nickname)) out.nickname = textOf(c.Nickname);
      const addresses = toArray(c?.PhysicalAddresses?.Entry).map((a) => ({
        kind: String(a?.['@Key'] || ''),
        text: [textOf(a?.Street), [textOf(a?.PostalCode), textOf(a?.City)].filter(Boolean).join(' '), textOf(a?.State), textOf(a?.CountryOrRegion)].filter(Boolean).join('\n')
      })).filter((a) => a.text);
      if (addresses.length) out.addresses = addresses;
      // a day kept as the mailbox's midnight, in UTC: the nearest midnight is that day (east of UTC it reads as the evening before)
      const at = Date.parse(textOf(c?.Birthday));
      if (Number.isFinite(at)) {
        const day = new Date(Math.round(at / 86400e3) * 86400e3).toISOString().slice(0, 10);
        if (!/^(1601|4501)-/.test(day)) out.birthday = day;
      }
      return out;
    }).filter((c) => c.email || (keepAll && (c.name || c.phones.length)));
  }

  post(xml) {
    return new Promise((resolve, reject) => {
      httpntlm.post(
        {
          url: this.url,
          username: this.username,
          password: this.password,
          domain: this.domain,
          workstation: '',
          body: xml,
          headers: { 'Content-Type': 'text/xml; charset=utf-8' }
        },
        (err, res) => {
          if (err) return reject(err);
          if (res.statusCode === 401) {
            const e = new Error('EWS authentication failed (401) — the cached password is likely stale.');
            e.code = 'EWS_AUTH';
            return reject(e);
          }
          if (res.statusCode !== 200) {
            return reject(new Error(`EWS HTTP ${res.statusCode}: ${String(res.body).slice(0, 300)}`));
          }
          resolve(parser.parse(res.body));
        }
      );
    });
  }

  // --- operations -----------------------------------------------------------

  /**
   * List newest items in a folder. Options: limit, unreadOnly, flaggedOnly, senderContains,
   * subjectContains, sinceIso, folder (inbox|junk|sent|drafts|trash|archive),
   * text (subject OR body, via Exchange's content index), hasAttachments.
   */
  async findInbox(opts = {}) {
    const folderId = FOLDERS[String(opts.folder || 'inbox').toLowerCase()];
    if (!folderId) {
      throw new Error(`unknown folder "${opts.folder}" — use: ${Object.keys(FOLDERS).join(', ')}`);
    }

    // Body search and attachment filtering aren't expressible as EWS
    // restrictions — they need an AQS QueryString (the content index, same as
    // OWA's search box). When either is requested, translate ALL filters to
    // AQS, since QueryString and Restriction cannot be combined.
    // Recipients cannot be restricted on (a Contains over To or Cc matched nothing, ever): they go through AQS too.
    if (opts.text || opts.hasAttachments || opts.toContains) {
      const parts = [];
      // text may be one term or a list — every term must match (AND),
      // each in the subject OR the body.
      const texts = Array.isArray(opts.text) ? opts.text : opts.text ? [opts.text] : [];
      for (const t of texts) parts.push(`(subject:"${aqs(t)}" OR body:"${aqs(t)}")`);
      if (opts.subjectContains) parts.push(`subject:"${aqs(opts.subjectContains)}"`);
      if (opts.senderContains) parts.push(`from:"${aqs(opts.senderContains)}"`);
      if (opts.toContains) parts.push(`(to:"${aqs(opts.toContains)}" OR cc:"${aqs(opts.toContains)}")`);
      if (opts.fromMe) parts.push(`from:"${aqs(await this.selfEmail())}"`);
      if (opts.unreadOnly) parts.push('isread:false');
      if (opts.hasAttachments) parts.push('hasattachments:true');
      if (opts.sinceIso) {
        const d = new Date(opts.sinceIso);
        parts.push(`received:>=${d.getMonth() + 1}/${d.getDate()}/${d.getFullYear()}`);
      }
      if (opts.untilIso) {
        const d = new Date(opts.untilIso);
        parts.push(`received:<=${d.getMonth() + 1}/${d.getDate()}/${d.getFullYear()}`);
      }
      const query = `<m:QueryString>${esc(parts.join(' AND '))}</m:QueryString>`;
      // AQS dates are whole days, and it has no word for a flag: what it gives is narrowed here, to the exact
      // moment (a page's cursor is the time of its last mail: the next page must not hand the same day back) and to
      // the flag, page after page of it until enough are found or it has no more
      const since = opts.sinceIso ? new Date(opts.sinceIso).getTime() : -Infinity;
      const until = opts.untilIso ? new Date(opts.untilIso).getTime() : Infinity;
      const keep = (i) => { const t = new Date(i.received).getTime(); return t >= since && t <= until && (!opts.flaggedOnly || i.isFlagged); };
      const want = Math.min(opts.limit || 25, 100);
      const out = [];
      let offset = Math.max(0, Number(opts.offset) || 0);
      for (let round = 0; round < 10 && out.length < want; round++) {
        const batch = await this.#find(folderId, 100, '', query, offset);
        out.push(...batch.filter(keep));
        if (batch.length < 100) break; // the end of the matches
        offset += batch.length;
      }
      return out.slice(0, want);
    }
    const limit = Math.min(opts.limit || 25, 100);
    const conditions = [];
    if (opts.subjectContains) {
      conditions.push(
        `<t:Contains ContainmentMode="Substring" ContainmentComparison="IgnoreCase">` +
          `<t:FieldURI FieldURI="item:Subject"/><t:Constant Value="${esc(opts.subjectContains)}"/></t:Contains>`
      );
    }
    if (opts.senderContains || opts.fromMe) {
      conditions.push(
        `<t:Contains ContainmentMode="Substring" ContainmentComparison="IgnoreCase">` +
          `<t:FieldURI FieldURI="message:Sender"/><t:Constant Value="${esc(opts.fromMe ? await this.selfEmail() : opts.senderContains)}"/></t:Contains>`
      );
    }
    if (opts.unreadOnly) {
      conditions.push(
        `<t:IsEqualTo><t:FieldURI FieldURI="message:IsRead"/>` +
          `<t:FieldURIOrConstant><t:Constant Value="false"/></t:FieldURIOrConstant></t:IsEqualTo>`
      );
    }
    if (opts.flaggedOnly) {
      // PidTagFlagStatus: 2 is "flagged" (1 is "complete", which counts as cleared, as in setFlag)
      conditions.push(
        `<t:IsEqualTo><t:ExtendedFieldURI PropertyTag="0x1090" PropertyType="Integer"/>` +
          `<t:FieldURIOrConstant><t:Constant Value="2"/></t:FieldURIOrConstant></t:IsEqualTo>`
      );
    }
    if (opts.sinceIso) {
      conditions.push(
        `<t:IsGreaterThanOrEqualTo><t:FieldURI FieldURI="item:DateTimeReceived"/>` +
          `<t:FieldURIOrConstant><t:Constant Value="${esc(opts.sinceIso)}"/></t:FieldURIOrConstant></t:IsGreaterThanOrEqualTo>`
      );
    }
    if (opts.untilIso) {
      conditions.push(
        `<t:IsLessThanOrEqualTo><t:FieldURI FieldURI="item:DateTimeReceived"/>` +
          `<t:FieldURIOrConstant><t:Constant Value="${esc(new Date(opts.untilIso).toISOString())}"/></t:FieldURIOrConstant></t:IsLessThanOrEqualTo>`
      );
    }
    let restriction = '';
    if (conditions.length === 1) restriction = `<m:Restriction>${conditions[0]}</m:Restriction>`;
    else if (conditions.length > 1) restriction = `<m:Restriction><t:And>${conditions.join('')}</t:And></m:Restriction>`;

    return this.#find(folderId, limit, restriction, '', opts.offset);
  }

  async #find(folderId, limit, restriction, queryString, offset = 0) {
    const max = Math.min(limit || 25, 100);
    // SortOrder is not allowed together with QueryString; AQS results come
    // back newest-first from the content index anyway.
    const sort = queryString
      ? ''
      : `<m:SortOrder>
          <t:FieldOrder Order="Descending"><t:FieldURI FieldURI="item:DateTimeReceived"/></t:FieldOrder>
        </m:SortOrder>`;
    const body = `
      <m:FindItem Traversal="Shallow">
        <m:ItemShape>
          <t:BaseShape>IdOnly</t:BaseShape>
          <t:AdditionalProperties>
            <t:FieldURI FieldURI="item:Subject"/>
            <t:FieldURI FieldURI="message:From"/>
            <t:FieldURI FieldURI="message:IsRead"/>
            <t:FieldURI FieldURI="item:Flag"/>
            <t:FieldURI FieldURI="item:DateTimeReceived"/>
            <t:FieldURI FieldURI="item:HasAttachments"/>
            <t:FieldURI FieldURI="item:DisplayTo"/>
            <t:FieldURI FieldURI="item:ConversationId"/>
            <t:FieldURI FieldURI="message:InternetMessageId"/>
            <t:FieldURI FieldURI="item:InReplyTo"/>
          </t:AdditionalProperties>
        </m:ItemShape>
        <m:IndexedPageItemView MaxEntriesReturned="${max}" Offset="${Math.max(0, Number(offset) || 0)}" BasePoint="Beginning"/>
        ${restriction}
        ${sort}
        <m:ParentFolderIds><t:DistinguishedFolderId Id="${folderId}"/></m:ParentFolderIds>
        ${queryString}
      </m:FindItem>`;

    const json = await this.post(envelope(body));
    const rm = dig(json, 'Envelope.Body.FindItemResponse.ResponseMessages.FindItemResponseMessage');
    assertSuccess(rm, 'FindItem');
    const items = toArray(dig(rm, 'RootFolder.Items.Message'));
    return items.map(parseListItem);
  }

  /** Fetch one message with its body (Text by default, or HTML) and recipients. */
  async getMessage(id, { bodyType = 'Text' } = {}) {
    const bt = bodyType === 'HTML' ? 'HTML' : 'Text';
    const body = `
      <m:GetItem>
        <m:ItemShape>
          <t:BaseShape>IdOnly</t:BaseShape>
          <t:BodyType>${bt}</t:BodyType>
          <t:AdditionalProperties>
            <t:FieldURI FieldURI="item:Subject"/>
            <t:FieldURI FieldURI="message:From"/>
            <t:FieldURI FieldURI="message:ToRecipients"/>
            <t:FieldURI FieldURI="message:CcRecipients"/>
            <t:FieldURI FieldURI="message:BccRecipients"/>
            <t:FieldURI FieldURI="message:ReplyTo"/>
            <t:FieldURI FieldURI="message:IsRead"/>
            <t:FieldURI FieldURI="item:Flag"/>
            <t:FieldURI FieldURI="item:DateTimeReceived"/>
            <t:FieldURI FieldURI="item:HasAttachments"/>
            <t:FieldURI FieldURI="item:Attachments"/>
            <t:FieldURI FieldURI="item:Body"/>
            <t:FieldURI FieldURI="item:ConversationId"/>
            <t:FieldURI FieldURI="message:InternetMessageId"/>
            <t:FieldURI FieldURI="item:InReplyTo"/>
            <t:FieldURI FieldURI="message:References"/>
            <t:FieldURI FieldURI="item:InternetMessageHeaders"/>
          </t:AdditionalProperties>
        </m:ItemShape>
        <m:ItemIds><t:ItemId Id="${esc(id)}"/></m:ItemIds>
      </m:GetItem>`;

    const json = await this.post(envelope(body));
    const rm = dig(json, 'Envelope.Body.GetItemResponse.ResponseMessages.GetItemResponseMessage');
    assertSuccess(rm, 'GetItem');
    const msg = dig(rm, 'Items.Message');
    if (!msg) throw new Error('GetItem: message not found');
    const base = parseListItem(msg);
    const attachments = attachmentsIn(msg);
    const headers = {};
    const pairs = [];
    for (const h of toArray(dig(msg, 'InternetMessageHeaders.InternetMessageHeader'))) {
      const k = String(h?.['@HeaderName'] || '').toLowerCase();
      if (k) { headers[k] = textOf(h); pairs.push([k, textOf(h)]); }
    }
    return {
      ...base,
      authHeaders: authHeadersFrom(pairs),
      to: toArray(dig(msg, 'ToRecipients.Mailbox')).map(parseMailbox),
      cc: toArray(dig(msg, 'CcRecipients.Mailbox')).map(parseMailbox),
      bcc: toArray(dig(msg, 'BccRecipients.Mailbox')).map(parseMailbox), // only on a draft or a sent copy of one's own
      replyTo: toArray(dig(msg, 'ReplyTo.Mailbox')).map(parseMailbox), // where a reply goes, when not to the sender
      references: textOf(msg.References),
      isBulk: isBulkHeaders(headers),
      attachments,
      bodyType: bt,
      body: textOf(dig(msg, 'Body')).replace(/\r\n?/g, '\n')
    };
  }

  /**
   * Create a reply-all DRAFT (saved to Drafts, never sent) for a message.
   * The user reviews and sends it from any mail client.
   */
  async draftReplyAll(id, changeKey, newBodyText, { bodyType = 'Text' } = {}) {
    const ck = changeKey ? ` ChangeKey="${esc(changeKey)}"` : '';
    const body = `
      <m:CreateItem MessageDisposition="SaveOnly">
        <m:Items>
          <t:ReplyAllToItem>
            <t:ReferenceItemId Id="${esc(id)}"${ck}/>
            <t:NewBodyContent BodyType="${bodyType === 'HTML' ? 'HTML' : 'Text'}">${esc(newBodyText)}</t:NewBodyContent>
          </t:ReplyAllToItem>
        </m:Items>
      </m:CreateItem>`;

    const json = await this.post(envelope(body));
    const rm = dig(json, 'Envelope.Body.CreateItemResponse.ResponseMessages.CreateItemResponseMessage');
    assertSuccess(rm, 'CreateItem(draft reply-all)');
    const created = dig(rm, 'Items.Message.ItemId');
    return { draftId: created?.['@Id'] || null, changeKey: created?.['@ChangeKey'] || null };
  }

  /** Reply-to-sender DRAFT (same semantics as draftReplyAll). */
  async draftReply(id, changeKey, newBodyText, { bodyType = 'Text' } = {}) {
    const ck = changeKey ? ` ChangeKey="${esc(changeKey)}"` : '';
    const body = `
      <m:CreateItem MessageDisposition="SaveOnly">
        <m:Items>
          <t:ReplyToItem>
            <t:ReferenceItemId Id="${esc(id)}"${ck}/>
            <t:NewBodyContent BodyType="${bodyType === 'HTML' ? 'HTML' : 'Text'}">${esc(newBodyText)}</t:NewBodyContent>
          </t:ReplyToItem>
        </m:Items>
      </m:CreateItem>`;
    const json = await this.post(envelope(body));
    const rm = dig(json, 'Envelope.Body.CreateItemResponse.ResponseMessages.CreateItemResponseMessage');
    assertSuccess(rm, 'CreateItem(draft reply)');
    const created = dig(rm, 'Items.Message.ItemId');
    return { draftId: created?.['@Id'] || null, changeKey: created?.['@ChangeKey'] || null };
  }

  /**
   * Forward DRAFT: the server adds the original message below the new body
   * and carries its attachments over. Recipients may be set later (updateDraft).
   */
  async draftForward(id, changeKey, newBodyText, { bodyType = 'Text', to = [], cc = [], bcc = [] } = {}) {
    const ck = changeKey ? ` ChangeKey="${esc(changeKey)}"` : '';
    const mailboxes = (list) => list.map((a) => `<t:Mailbox><t:EmailAddress>${esc(a)}</t:EmailAddress></t:Mailbox>`).join('');
    const body = `
      <m:CreateItem MessageDisposition="SaveOnly">
        <m:Items>
          <t:ForwardItem>
            ${to.length ? `<t:ToRecipients>${mailboxes(to)}</t:ToRecipients>` : ''}
            ${cc.length ? `<t:CcRecipients>${mailboxes(cc)}</t:CcRecipients>` : ''}
            ${bcc.length ? `<t:BccRecipients>${mailboxes(bcc)}</t:BccRecipients>` : ''}
            <t:ReferenceItemId Id="${esc(id)}"${ck}/>
            <t:NewBodyContent BodyType="${bodyType === 'HTML' ? 'HTML' : 'Text'}">${esc(newBodyText)}</t:NewBodyContent>
          </t:ForwardItem>
        </m:Items>
      </m:CreateItem>`;
    const json = await this.post(envelope(body));
    const rm = dig(json, 'Envelope.Body.CreateItemResponse.ResponseMessages.CreateItemResponseMessage');
    assertSuccess(rm, 'CreateItem(draft forward)');
    const created = dig(rm, 'Items.Message.ItemId');
    return { draftId: created?.['@Id'] || null, changeKey: created?.['@ChangeKey'] || null };
  }

  /**
   * Edit an existing draft: any of subject, body (Text or HTML), to, cc, bcc.
   * Requires the current changeKey; returns the new one for further edits.
   */
  async updateDraft({ id, changeKey, subject, body, bodyType = 'Text', to, cc, bcc }) {
    const mailboxes = (list) =>
      list.map((a) => `<t:Mailbox><t:EmailAddress>${esc(a)}</t:EmailAddress></t:Mailbox>`).join('');
    const sets = [];
    if (subject !== undefined) {
      sets.push(`<t:SetItemField><t:FieldURI FieldURI="item:Subject"/><t:Message><t:Subject>${esc(subject)}</t:Subject></t:Message></t:SetItemField>`);
    }
    if (body !== undefined) {
      sets.push(`<t:SetItemField><t:FieldURI FieldURI="item:Body"/><t:Message><t:Body BodyType="${bodyType === 'HTML' ? 'HTML' : 'Text'}">${esc(body)}</t:Body></t:Message></t:SetItemField>`);
    }
    if (to !== undefined) {
      sets.push(`<t:SetItemField><t:FieldURI FieldURI="message:ToRecipients"/><t:Message><t:ToRecipients>${mailboxes(to)}</t:ToRecipients></t:Message></t:SetItemField>`);
    }
    if (cc !== undefined) {
      sets.push(`<t:SetItemField><t:FieldURI FieldURI="message:CcRecipients"/><t:Message><t:CcRecipients>${mailboxes(cc)}</t:CcRecipients></t:Message></t:SetItemField>`);
    }
    if (bcc !== undefined) {
      sets.push(bcc.length
        ? `<t:SetItemField><t:FieldURI FieldURI="message:BccRecipients"/><t:Message><t:BccRecipients>${mailboxes(bcc)}</t:BccRecipients></t:Message></t:SetItemField>`
        : '<t:DeleteItemField><t:FieldURI FieldURI="message:BccRecipients"/></t:DeleteItemField>');
    }
    if (sets.length === 0) throw new Error('updateDraft: nothing to change');

    const xml = `
      <m:UpdateItem ConflictResolution="AlwaysOverwrite" MessageDisposition="SaveOnly">
        <m:ItemChanges>
          <t:ItemChange>
            <t:ItemId Id="${esc(id)}" ChangeKey="${esc(changeKey)}"/>
            <t:Updates>${sets.join('')}</t:Updates>
          </t:ItemChange>
        </m:ItemChanges>
      </m:UpdateItem>`;

    const json = await this.post(envelope(xml));
    const rm = dig(json, 'Envelope.Body.UpdateItemResponse.ResponseMessages.UpdateItemResponseMessage');
    assertSuccess(rm, 'UpdateItem(draft)');
    const updated = dig(rm, 'Items.Message.ItemId');
    return { draftId: updated?.['@Id'] || id, changeKey: updated?.['@ChangeKey'] || null };
  }

  /**
   * Attach a file to an existing item (draft). Attaching changes the item's
   * changeKey — the new one is returned for subsequent operations.
   * inline + contentId: an inline image for an HTML body (<img src="cid:ID">).
   */
  async addAttachment(parentId, parentChangeKey, { name, contentBase64, contentType, inline = false, contentId }) {
    const ck = parentChangeKey ? ` ChangeKey="${esc(parentChangeKey)}"` : '';
    const ct = contentType ? `<t:ContentType>${esc(contentType)}</t:ContentType>` : '';
    const cid = inline ? `<t:ContentId>${esc(contentId || name)}</t:ContentId>` : '';
    const xml = `
      <m:CreateAttachment>
        <m:ParentItemId Id="${esc(parentId)}"${ck}/>
        <m:Attachments>
          <t:FileAttachment>
            <t:Name>${esc(name)}</t:Name>
            ${ct}
            ${cid}
            <t:Content>${contentBase64}</t:Content>
            ${inline ? '<t:IsInline>true</t:IsInline>' : ''}
          </t:FileAttachment>
        </m:Attachments>
      </m:CreateAttachment>`;
    const json = await this.post(envelope(xml));
    const rm = dig(json, 'Envelope.Body.CreateAttachmentResponse.ResponseMessages.CreateAttachmentResponseMessage');
    assertSuccess(rm, 'CreateAttachment');
    const att = dig(rm, 'Attachments.FileAttachment.AttachmentId');
    return { attachmentId: att?.['@Id'] || null, changeKey: att?.['@RootItemChangeKey'] || null };
  }

  /** Remove one attachment from a draft. Returns the draft's new changeKey. */
  async removeAttachment(_parentId, _parentChangeKey, attachmentId) {
    const xml = `
      <m:DeleteAttachment>
        <m:AttachmentIds><t:AttachmentId Id="${esc(attachmentId)}"/></m:AttachmentIds>
      </m:DeleteAttachment>`;
    const json = await this.post(envelope(xml));
    const rm = dig(json, 'Envelope.Body.DeleteAttachmentResponse.ResponseMessages.DeleteAttachmentResponseMessage');
    assertSuccess(rm, 'DeleteAttachment');
    return { changeKey: dig(rm, 'RootItemId')?.['@RootItemChangeKey'] || null };
  }

  /** Send an existing draft (used by the CLI's --send after attaching). */
  async sendItem(id, changeKey) {
    // Exchange needs the draft's current ChangeKey to send it; a caller that has only the id gets it looked up here
    if (!changeKey) changeKey = (await this.getMessage(id)).changeKey;
    const ck = changeKey ? ` ChangeKey="${esc(changeKey)}"` : '';
    const xml = `
      <m:SendItem SaveItemToFolder="true">
        <m:ItemIds><t:ItemId Id="${esc(id)}"${ck}/></m:ItemIds>
        <m:SavedItemFolderId><t:DistinguishedFolderId Id="sentitems"/></m:SavedItemFolderId>
      </m:SendItem>`;
    const json = await this.post(envelope(xml));
    const rm = dig(json, 'Envelope.Body.SendItemResponse.ResponseMessages.SendItemResponseMessage');
    // a failed send may still have gone out (Exchange has sent one and answered with an error): never retry blind
    try { assertSuccess(rm, 'SendItem'); }
    catch (err) { throw new Error(`${err.message}. It may still have been sent: look in Sent before trying again.`); }
    return true;
  }

  /** Move an item to Deleted Items (reversible, unlike a hard delete). */
  async deleteItem(id, changeKey) {
    const ck = changeKey ? ` ChangeKey="${esc(changeKey)}"` : '';
    const xml = `
      <m:DeleteItem DeleteType="MoveToDeletedItems">
        <m:ItemIds><t:ItemId Id="${esc(id)}"${ck}/></m:ItemIds>
      </m:DeleteItem>`;
    const json = await this.post(envelope(xml));
    const rm = dig(json, 'Envelope.Body.DeleteItemResponse.ResponseMessages.DeleteItemResponseMessage');
    assertSuccess(rm, 'DeleteItem');
    return true;
  }

  /**
   * Move messages to a folder (inbox|junk|sent|drafts|trash|archive). A moved
   * item gets a new id: returns Map old id → new id; old id → null for a
   * message that is no longer there (moved or deleted elsewhere); an id that
   * could not be moved for another reason is absent.
   */
  async moveItems(ids, folder) {
    const to = FOLDERS[String(folder || '').toLowerCase()];
    if (!to) throw new Error(`unknown folder "${folder}" — use: ${Object.keys(FOLDERS).join(', ')}`);
    const out = new Map();
    let refused = null; // a batch the server failed outright: those before it are moved, and must be said so
    for (let i = 0; i < ids.length; i += 50) {
      const batch = ids.slice(i, i + 50);
      const xml = `
        <m:MoveItem>
          <m:ToFolderId><t:DistinguishedFolderId Id="${to}"/></m:ToFolderId>
          <m:ItemIds>${batch.map((id) => `<t:ItemId Id="${esc(id)}"/>`).join('')}</m:ItemIds>
        </m:MoveItem>`;
      let json;
      try { json = await this.post(envelope(xml)); } catch (e) { refused = e; break; }
      const rms = toArray(dig(json, 'Envelope.Body.MoveItemResponse.ResponseMessages.MoveItemResponseMessage'));
      if (!rms.length) { refused = new Error('MoveItem: no response'); break; }
      rms.forEach((rm, k) => {
        if (rm?.['@ResponseClass'] !== 'Success') {
          if (/ErrorItemNotFound|ErrorInvalidIdMalformed/.test(textOf(rm?.ResponseCode))) out.set(batch[k], null);
          return;
        }
        const moved = Object.values(rm?.Items || {}).flatMap((v) => toArray(v))[0];
        out.set(batch[k], moved?.ItemId?.['@Id'] || batch[k]);
      });
      // nothing moved at all: say why, as the server did for the first one
      if (!out.size && i + 50 >= ids.length) assertSuccess(rms[0], 'MoveItem');
    }
    if (refused && !out.size) throw refused;
    return out; // an id not in it was not moved (the caller says so)
  }

  /**
   * Compose a new message. send=false saves a draft in Drafts;
   * send=true sends it and keeps a copy in Sent Items.
   */
  async createMessage({ to = [], cc = [], bcc = [], subject = '', body = '', bodyType = 'Text', send = false }) {
    const mailboxes = (list) =>
      list.map((a) => `<t:Mailbox><t:EmailAddress>${esc(a)}</t:EmailAddress></t:Mailbox>`).join('');
    const disposition = send ? 'SendAndSaveCopy' : 'SaveOnly';
    const savedFolder = send ? 'sentitems' : 'drafts';
    const xml = `
      <m:CreateItem MessageDisposition="${disposition}">
        <m:SavedItemFolderId><t:DistinguishedFolderId Id="${savedFolder}"/></m:SavedItemFolderId>
        <m:Items>
          <t:Message>
            <t:Subject>${esc(subject)}</t:Subject>
            <t:Body BodyType="${bodyType === 'HTML' ? 'HTML' : 'Text'}">${esc(body)}</t:Body>
            ${to.length ? `<t:ToRecipients>${mailboxes(to)}</t:ToRecipients>` : ''}
            ${cc.length ? `<t:CcRecipients>${mailboxes(cc)}</t:CcRecipients>` : ''}
            ${bcc.length ? `<t:BccRecipients>${mailboxes(bcc)}</t:BccRecipients>` : ''}
          </t:Message>
        </m:Items>
      </m:CreateItem>`;

    const json = await this.post(envelope(xml));
    const rm = dig(json, 'Envelope.Body.CreateItemResponse.ResponseMessages.CreateItemResponseMessage');
    assertSuccess(rm, send ? 'CreateItem(send)' : 'CreateItem(draft)');
    const created = dig(rm, 'Items.Message.ItemId');
    return { sent: send, draftId: created?.['@Id'] || null, changeKey: created?.['@ChangeKey'] || null };
  }

  /** Bulk/list flag for many ids at once (headers only, one GetItem). Returns Map id → boolean. */
  async bulkFlags(ids) {
    const out = new Map();
    for (let i = 0; i < ids.length; i += 50) {
      const batch = ids.slice(i, i + 50);
      const xml = `
        <m:GetItem>
          <m:ItemShape><t:BaseShape>IdOnly</t:BaseShape><t:AdditionalProperties><t:FieldURI FieldURI="item:InternetMessageHeaders"/></t:AdditionalProperties></m:ItemShape>
          <m:ItemIds>${batch.map((id) => `<t:ItemId Id="${esc(id)}"/>`).join('')}</m:ItemIds>
        </m:GetItem>`;
      const json = await this.post(envelope(xml));
      const rms = toArray(dig(json, 'Envelope.Body.GetItemResponse.ResponseMessages.GetItemResponseMessage'));
      rms.forEach((rm, k) => {
        if (rm?.['@ResponseClass'] !== 'Success') return;
        const it = dig(rm, 'Items.Message') || dig(rm, 'Items.MeetingRequest') || dig(rm, 'Items.Item');
        const headers = {};
        for (const h of toArray(dig(it, 'InternetMessageHeaders.InternetMessageHeader'))) {
          const key = String(h?.['@HeaderName'] || '').toLowerCase();
          if (key) headers[key] = textOf(h);
        }
        out.set(it?.ItemId?.['@Id'] || batch[k], isBulkHeaders(headers));
      });
    }
    return out;
  }

  /**
   * The authentication headers of many messages (one GetItem per 50, headers
   * and From only): Map id → { results, bimiSelector, msAuthAs, fromEmail }
   * (see auth-headers.js). A message the server does not return is left out.
   */
  async authHeadersOf(ids) {
    const out = new Map();
    for (let i = 0; i < ids.length; i += 50) {
      const batch = ids.slice(i, i + 50);
      const xml = `
        <m:GetItem>
          <m:ItemShape><t:BaseShape>IdOnly</t:BaseShape><t:AdditionalProperties><t:FieldURI FieldURI="item:InternetMessageHeaders"/><t:FieldURI FieldURI="message:From"/></t:AdditionalProperties></m:ItemShape>
          <m:ItemIds>${batch.map((id) => `<t:ItemId Id="${esc(id)}"/>`).join('')}</m:ItemIds>
        </m:GetItem>`;
      const json = await this.post(envelope(xml));
      const rms = toArray(dig(json, 'Envelope.Body.GetItemResponse.ResponseMessages.GetItemResponseMessage'));
      rms.forEach((rm, k) => {
        if (rm?.['@ResponseClass'] !== 'Success') return;
        const it = dig(rm, 'Items.Message') || dig(rm, 'Items.MeetingRequest') || dig(rm, 'Items.Item');
        if (!it) return;
        const pairs = toArray(dig(it, 'InternetMessageHeaders.InternetMessageHeader')).map((h) => [String(h?.['@HeaderName'] || ''), textOf(h)]);
        out.set(batch[k], { ...authHeadersFrom(pairs), fromEmail: textOf(dig(it, 'From.Mailbox.EmailAddress')).toLowerCase() });
      });
    }
    return out;
  }

  /**
   * The photo the organisation keeps of an address (Exchange 2013 and later:
   * GetUserPhoto), at `size` (HR48x48 … HR648x648; HR96x96 by default):
   * { contentType, data: Buffer } or null when there is none. A server that
   * does not know the operation throws (its error, with `unsupported: true`).
   */
  async userPhoto(email, { size = 'HR96x96' } = {}) {
    const sizes = ['HR48x48', 'HR64x64', 'HR96x96', 'HR120x120', 'HR240x240', 'HR360x360', 'HR432x432', 'HR504x504', 'HR648x648'];
    const want = sizes.includes(size) ? size : 'HR96x96';
    let json;
    try {
      json = await this.post(envelope(`<m:GetUserPhoto><m:Email>${esc(email)}</m:Email><m:SizeRequested>${want}</m:SizeRequested></m:GetUserPhoto>`));
    } catch (e) {
      if (e.code === 'EWS_AUTH') throw e;
      // a photo that is not there is answered 404 or 500 with ErrorItemNotFound; a server without the operation fails otherwise
      if (/ErrorItemNotFound|ErrorPhotoNotFound|HTTP 404/i.test(e.message)) return null;
      // an answer that refuses the request (an older server's schema error) means none will come; a dropped connection says nothing
      if (/^EWS HTTP (400|500|501)\b/.test(e.message)) e.unsupported = true;
      throw e;
    }
    const r = dig(json, 'Envelope.Body.GetUserPhotoResponse');
    if (!r) throw Object.assign(new Error('GetUserPhoto: malformed EWS response'), { unsupported: true });
    // NoError is success whatever ResponseClass says (some servers leave it out); without a code, ResponseClass decides
    const code = textOf(r.ResponseCode);
    const ok = code ? code === 'NoError' : !r['@ResponseClass'] || r['@ResponseClass'] === 'Success';
    if (!ok) {
      if (/NotFound|ErrorNonExistentMailbox|ErrorInvalidSmtpAddress/i.test(code)) return null;
      throw Object.assign(new Error(`GetUserPhoto: ${code || 'error'}`), { unsupported: !/ErrorServerBusy|Timeout/i.test(code) });
    }
    const b64 = textOf(r.PictureData).replace(/\s+/g, '');
    if (!b64) return null;
    const data = Buffer.from(b64, 'base64');
    const contentType = data[0] === 0xff && data[1] === 0xd8 ? 'image/jpeg' : data.subarray(0, 4).toString('latin1') === '\x89PNG' ? 'image/png' : data.subarray(0, 3).toString('latin1') === 'GIF' ? 'image/gif' : '';
    return contentType ? { contentType, data } : null;
  }

  /**
   * Whom my newest sent mail went to: [{ to: [addresses, lower case], sent: ISO }]
   * for the newest `limit` messages of Sent (To only; automatic answers,
   * out-of-office and the replies of rules, left out). One FindItem, one GetItem per 50.
   */
  async sentTo({ limit = 200 } = {}) {
    const ids = [];
    for (let offset = 0; ids.length < limit; offset += 100) {
      const page = await this.findInbox({ folder: 'sent', limit: Math.min(100, limit - ids.length), offset });
      ids.push(...page.map((i) => i.id));
      if (page.length < 100) break;
    }
    const out = [];
    for (let i = 0; i < ids.length; i += 50) {
      const batch = ids.slice(i, i + 50);
      const json = await this.post(envelope(`
        <m:GetItem>
          <m:ItemShape><t:BaseShape>IdOnly</t:BaseShape><t:AdditionalProperties><t:FieldURI FieldURI="message:ToRecipients"/><t:FieldURI FieldURI="item:ItemClass"/><t:FieldURI FieldURI="item:Subject"/><t:FieldURI FieldURI="item:DateTimeSent"/>${AUTO_REPLY_HEADERS.map((h) => `<t:ExtendedFieldURI DistinguishedPropertySetId="InternetHeaders" PropertyName="${h}" PropertyType="String"/>`).join('')}</t:AdditionalProperties></m:ItemShape>
          <m:ItemIds>${batch.map((id) => `<t:ItemId Id="${esc(id)}"/>`).join('')}</m:ItemIds>
        </m:GetItem>`));
      for (const rm of toArray(dig(json, 'Envelope.Body.GetItemResponse.ResponseMessages.GetItemResponseMessage'))) {
        if (rm?.['@ResponseClass'] !== 'Success') continue;
        const it = dig(rm, 'Items.Message');
        // the headers asked for, as the message has them (each an extended property of the InternetHeaders set)
        const headers = toArray(it?.ExtendedProperty).map((p) => `${String(p?.ExtendedFieldURI?.['@PropertyName'] || '')}: ${textOf(p?.Value)}`).join('\n');
        if (!it || /^IPM\.Note\.Rules\./i.test(textOf(it.ItemClass)) || isAutoReply(textOf(it.Subject), headers)) continue;
        const to = toArray(dig(it, 'ToRecipients.Mailbox'))
          .filter((mb) => !mb?.RoutingType || textOf(mb.RoutingType) === 'SMTP')
          .map((mb) => textOf(mb?.EmailAddress).toLowerCase()).filter((e) => e.includes('@'));
        const sent = new Date(textOf(it.DateTimeSent));
        if (to.length) out.push({ to: [...new Set(to)], sent: isNaN(sent) ? new Date(0).toISOString() : sent.toISOString() });
      }
    }
    return out;
  }

  /** The attachments of many messages at once (one GetItem per 50): Map id → [{ id, name, size, contentType, contentId, inline }]. */
  async attachmentsOf(ids) {
    const out = new Map();
    for (let i = 0; i < ids.length; i += 50) {
      const batch = ids.slice(i, i + 50);
      const xml = `
        <m:GetItem>
          <m:ItemShape><t:BaseShape>IdOnly</t:BaseShape><t:AdditionalProperties><t:FieldURI FieldURI="item:Attachments"/></t:AdditionalProperties></m:ItemShape>
          <m:ItemIds>${batch.map((id) => `<t:ItemId Id="${esc(id)}"/>`).join('')}</m:ItemIds>
        </m:GetItem>`;
      const json = await this.post(envelope(xml));
      const rms = toArray(dig(json, 'Envelope.Body.GetItemResponse.ResponseMessages.GetItemResponseMessage'));
      rms.forEach((rm, k) => {
        if (rm?.['@ResponseClass'] !== 'Success') return;
        const it = dig(rm, 'Items.Message') || dig(rm, 'Items.MeetingRequest') || dig(rm, 'Items.Item') || Object.values(rm?.Items || {})[0];
        out.set(batch[k], attachmentsIn(it));
      });
    }
    return out;
  }

  /**
   * Download one attachment (id from getMessage().attachments): a file as it is; a mail attached to the mail (an
   * item, to Exchange) as a mail of its own, an .eml any mail program opens (its MIME content, asked for with it).
   */
  async getAttachment(attachmentId) {
    const body = `
      <m:GetAttachment>
        <m:AttachmentShape><t:IncludeMimeContent>true</t:IncludeMimeContent></m:AttachmentShape>
        <m:AttachmentIds><t:AttachmentId Id="${esc(attachmentId)}"/></m:AttachmentIds>
      </m:GetAttachment>`;
    const json = await this.post(envelope(body));
    const rm = dig(json, 'Envelope.Body.GetAttachmentResponse.ResponseMessages.GetAttachmentResponseMessage');
    // (an item Exchange cannot write out as a mail: a contact, a task)
    if (/MimeContentConversionFailed|MimeContentInvalid/i.test(textOf(rm?.ResponseCode))) throw new Error('this attached item cannot be downloaded: Exchange does not hand it out as a file');
    assertSuccess(rm, 'GetAttachment');
    const file = dig(rm, 'Attachments.FileAttachment');
    if (!file) {
      const item = dig(rm, 'Attachments.ItemAttachment');
      const inside = item && Object.values(item).find((v) => v && typeof v === 'object' && v.MimeContent !== undefined);
      const mime = inside ? String(textOf(inside.MimeContent) || '') : '';
      if (!mime) throw new Error('this attached item cannot be downloaded: Exchange does not hand it out as a file');
      return { name: mailName(textOf(item.Name)), contentType: 'message/rfc822', contentId: undefined, content: Buffer.from(mime, 'base64') };
    }
    return {
      name: textOf(file.Name) || 'attachment',
      contentType: textOf(file.ContentType) || 'application/octet-stream',
      contentId: textOf(file.ContentId) || undefined,
      content: Buffer.from(String(textOf(file.Content) || ''), 'base64')
    };
  }

  /**
   * Link that opens the item in Outlook on the web (a draft opens in the
   * compose form). Exchange 2013+ returns a full URL; older servers a query
   * string for /owa/. null when the server has none.
   */
  async webLink(id) {
    const body = `
      <m:GetItem>
        <m:ItemShape>
          <t:BaseShape>IdOnly</t:BaseShape>
          <t:AdditionalProperties>
            <t:FieldURI FieldURI="item:WebClientEditFormQueryString"/>
            <t:FieldURI FieldURI="item:WebClientReadFormQueryString"/>
          </t:AdditionalProperties>
        </m:ItemShape>
        <m:ItemIds><t:ItemId Id="${esc(id)}"/></m:ItemIds>
      </m:GetItem>`;
    const json = await this.post(envelope(body));
    const rm = dig(json, 'Envelope.Body.GetItemResponse.ResponseMessages.GetItemResponseMessage');
    assertSuccess(rm, 'GetItem');
    const item = dig(rm, 'Items.Message') || {};
    const link = textOf(item.WebClientEditFormQueryString) || textOf(item.WebClientReadFormQueryString);
    if (!link) return null;
    return /^https?:/i.test(link) ? link : this.url.replace(/\/EWS\/Exchange\.asmx$/, '/owa/') + link.replace(/^\/?(owa\/)?/, '');
  }

  /** Mark a message read (requires the changeKey from a listing). */
  async markRead(id, changeKey, isRead = true) {
    const body = `
      <m:UpdateItem ConflictResolution="AutoResolve" MessageDisposition="SaveOnly">
        <m:ItemChanges>
          <t:ItemChange>
            <t:ItemId Id="${esc(id)}" ChangeKey="${esc(changeKey)}"/>
            <t:Updates>
              <t:SetItemField>
                <t:FieldURI FieldURI="message:IsRead"/>
                <t:Message><t:IsRead>${isRead}</t:IsRead></t:Message>
              </t:SetItemField>
            </t:Updates>
          </t:ItemChange>
        </m:ItemChanges>
      </m:UpdateItem>`;

    const json = await this.post(envelope(body));
    const rm = dig(json, 'Envelope.Body.UpdateItemResponse.ResponseMessages.UpdateItemResponseMessage');
    assertSuccess(rm, 'UpdateItem(markRead)');
    return true;
  }

  /** Flag a message for follow-up, or clear its flag (a flag marked complete counts as cleared). */
  async setFlag(id, changeKey, flagged = true) {
    const body = `
      <m:UpdateItem ConflictResolution="AutoResolve" MessageDisposition="SaveOnly">
        <m:ItemChanges>
          <t:ItemChange>
            <t:ItemId Id="${esc(id)}" ChangeKey="${esc(changeKey)}"/>
            <t:Updates>
              <t:SetItemField>
                <t:FieldURI FieldURI="item:Flag"/>
                <t:Message><t:Flag><t:FlagStatus>${flagged ? 'Flagged' : 'NotFlagged'}</t:FlagStatus></t:Flag></t:Message>
              </t:SetItemField>
            </t:Updates>
          </t:ItemChange>
        </m:ItemChanges>
      </m:UpdateItem>`;

    const json = await this.post(envelope(body));
    const rm = dig(json, 'Envelope.Body.UpdateItemResponse.ResponseMessages.UpdateItemResponseMessage');
    assertSuccess(rm, 'UpdateItem(setFlag)');
    return true;
  }
}

// --- helpers -----------------------------------------------------------------

export const FOLDERS = {
  inbox: 'inbox',
  junk: 'junkemail',
  sent: 'sentitems',
  drafts: 'drafts',
  trash: 'deleteditems',
  archive: 'archive'
};

function parseListItem(m) {
  const from = dig(m, 'From.Mailbox');
  return {
    id: m.ItemId?.['@Id'] || '',
    changeKey: m.ItemId?.['@ChangeKey'] || '',
    subject: textOf(m.Subject),
    fromName: textOf(from?.Name),
    fromEmail: textOf(from?.EmailAddress),
    displayTo: textOf(m.DisplayTo),
    isRead: String(m.IsRead) !== 'false',
    isFlagged: textOf(dig(m, 'Flag.FlagStatus')) === 'Flagged',
    hasAttachments: String(m.HasAttachments) === 'true',
    received: textOf(m.DateTimeReceived),
    conversationId: m.ConversationId?.['@Id'] || '',
    messageId: textOf(m.InternetMessageId),
    inReplyTo: textOf(m.InReplyTo)
  };
}

/** Mailing-list / automated mail, judged from the usual headers. */
export function isBulkHeaders(h) {
  const get = (k) => String(h[k] || '').toLowerCase();
  if (h['list-id'] || h['list-unsubscribe'] || h['list-post']) return true;
  if (/bulk|list|junk/.test(get('precedence'))) return true;
  const auto = get('auto-submitted');
  if (auto && auto !== 'no') return true;
  return false;
}

function aqs(s) {
  // value inside an AQS quoted string — strip quotes to avoid breaking out
  return String(s).replace(/"/g, ' ');
}

// Calendar operations live in ews-calendar.js and share this client's post().
Object.assign(EwsClient.prototype, calendarMethods);
