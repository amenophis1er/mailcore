// EWS calendar operations, mixed into EwsClient (see the end of ews.js).
// Same SOAP endpoint and NTLM credentials as mail — nothing new to set up.
//
//   findCalendars({ mailbox })                       → Calendar[]
//   findEvents({ start, end, calendar, mailbox, limit }) → EventItem[]   (recurrences expanded)
//   getEvent(id)                                     → EventItem & { body, attendees… }
//   createEvent({...})                               → { id, changeKey }
//   updateEvent({ id, changeKey, ...fields, notify })→ { id, changeKey }
//   deleteEvent(id, changeKey, { notify })           → true
//   respondToEvent(id, changeKey, response, { message, notify }) → true
//   getFreeBusy({ emails, start, end, intervalMinutes }) → FreeBusy[]
//
// `calendar` is a folder id (own mailbox); `mailbox` an email address whose
// DEFAULT calendar is read (needs that person's sharing permission).
// Times go to Exchange as absolute ISO (UTC); all-day events as naive local
// dates under a TimeZoneContext header so they land on the right day.

import { esc, dig, toArray, textOf, parseMailbox, assertSuccess } from './ews-util.js';

const BUSY = ['Free', 'Tentative', 'Busy', 'OOF', 'WorkingElsewhere', 'NoData'];

// IANA → Windows time-zone ids for the TimeZoneContext header. Unmapped
// zones fall back to UTC, which only affects where all-day events start.
const WINDOWS_TZ = {
  'America/New_York': 'Eastern Standard Time', 'America/Detroit': 'Eastern Standard Time', 'America/Toronto': 'Eastern Standard Time',
  'America/Chicago': 'Central Standard Time', 'America/Denver': 'Mountain Standard Time', 'America/Phoenix': 'US Mountain Standard Time',
  'America/Los_Angeles': 'Pacific Standard Time', 'America/Vancouver': 'Pacific Standard Time', 'America/Anchorage': 'Alaskan Standard Time',
  'Pacific/Honolulu': 'Hawaiian Standard Time', 'America/Sao_Paulo': 'E. South America Standard Time', 'America/Mexico_City': 'Central Standard Time (Mexico)',
  'Europe/London': 'GMT Standard Time', 'Europe/Dublin': 'GMT Standard Time', 'Europe/Lisbon': 'GMT Standard Time',
  'Europe/Paris': 'Romance Standard Time', 'Europe/Brussels': 'Romance Standard Time', 'Europe/Madrid': 'Romance Standard Time',
  'Europe/Berlin': 'W. Europe Standard Time', 'Europe/Amsterdam': 'W. Europe Standard Time', 'Europe/Rome': 'W. Europe Standard Time',
  'Europe/Zurich': 'W. Europe Standard Time', 'Europe/Vienna': 'W. Europe Standard Time', 'Europe/Stockholm': 'W. Europe Standard Time',
  'Europe/Warsaw': 'Central European Standard Time', 'Europe/Prague': 'Central Europe Standard Time', 'Europe/Athens': 'GTB Standard Time',
  'Europe/Helsinki': 'FLE Standard Time', 'Europe/Kiev': 'FLE Standard Time', 'Europe/Moscow': 'Russian Standard Time', 'Europe/Istanbul': 'Turkey Standard Time',
  'Africa/Lagos': 'W. Central Africa Standard Time', 'Africa/Lome': 'Greenwich Standard Time', 'Africa/Accra': 'Greenwich Standard Time',
  'Africa/Abidjan': 'Greenwich Standard Time', 'Africa/Johannesburg': 'South Africa Standard Time', 'Africa/Cairo': 'Egypt Standard Time', 'Africa/Nairobi': 'E. Africa Standard Time',
  'Asia/Dubai': 'Arabian Standard Time', 'Asia/Kolkata': 'India Standard Time', 'Asia/Singapore': 'Singapore Standard Time', 'Asia/Hong_Kong': 'China Standard Time',
  'Asia/Shanghai': 'China Standard Time', 'Asia/Tokyo': 'Tokyo Standard Time', 'Asia/Seoul': 'Korea Standard Time', 'Australia/Sydney': 'AUS Eastern Standard Time',
  'Australia/Melbourne': 'AUS Eastern Standard Time', 'Pacific/Auckland': 'New Zealand Standard Time', 'UTC': 'UTC', 'Etc/UTC': 'UTC'
};

export function localTimeZone() {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch { return 'UTC'; }
}

function tzEnvelope(bodyXml, ianaZone) {
  const win = WINDOWS_TZ[ianaZone || localTimeZone()] || 'UTC';
  return `<?xml version="1.0" encoding="utf-8"?>
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"
  xmlns:t="http://schemas.microsoft.com/exchange/services/2006/types"
  xmlns:m="http://schemas.microsoft.com/exchange/services/2006/messages">
  <soap:Header>
    <t:RequestServerVersion Version="Exchange2013_SP1"/>
    <t:TimeZoneContext><t:TimeZoneDefinition Id="${esc(win)}"/></t:TimeZoneContext>
  </soap:Header>
  <soap:Body>${bodyXml}</soap:Body>
</soap:Envelope>`;
}

function folderRef({ calendar, mailbox }) {
  if (calendar) return `<t:FolderId Id="${esc(calendar)}"/>`;
  const mb = mailbox ? `<t:Mailbox><t:EmailAddress>${esc(mailbox)}</t:EmailAddress></t:Mailbox>` : '';
  return `<t:DistinguishedFolderId Id="calendar">${mb}</t:DistinguishedFolderId>`;
}

function iso(d) {
  const t = d instanceof Date ? d : new Date(d);
  if (isNaN(t)) throw new Error(`invalid date: ${d}`);
  return t.toISOString();
}

/** All-day boundaries: the local calendar date, no offset — resolved by TimeZoneContext. */
function localDate(d) {
  const t = d instanceof Date ? d : new Date(d);
  const pad = (n) => String(n).padStart(2, '0');
  return `${t.getFullYear()}-${pad(t.getMonth() + 1)}-${pad(t.getDate())}T00:00:00`;
}

const LIST_FIELDS = `
  <t:FieldURI FieldURI="item:Subject"/>
  <t:FieldURI FieldURI="calendar:Start"/>
  <t:FieldURI FieldURI="calendar:End"/>
  <t:FieldURI FieldURI="calendar:Location"/>
  <t:FieldURI FieldURI="calendar:Organizer"/>
  <t:FieldURI FieldURI="calendar:IsAllDayEvent"/>
  <t:FieldURI FieldURI="calendar:LegacyFreeBusyStatus"/>
  <t:FieldURI FieldURI="calendar:MyResponseType"/>
  <t:FieldURI FieldURI="calendar:IsMeeting"/>
  <t:FieldURI FieldURI="calendar:IsCancelled"/>
  <t:FieldURI FieldURI="calendar:IsRecurring"/>
  <t:FieldURI FieldURI="calendar:CalendarItemType"/>
  <t:FieldURI FieldURI="item:Sensitivity"/>
  <t:FieldURI FieldURI="item:HasAttachments"/>
  <t:FieldURI FieldURI="item:ReminderIsSet"/>
  <t:FieldURI FieldURI="item:ReminderMinutesBeforeStart"/>
  <t:FieldURI FieldURI="item:LastModifiedTime"/>`;

export const calendarMethods = {
  /** Every calendar folder of a mailbox (own by default); the default one is flagged. */
  async findCalendars({ mailbox } = {}) {
    const mb = mailbox ? `<t:Mailbox><t:EmailAddress>${esc(mailbox)}</t:EmailAddress></t:Mailbox>` : '';
    const getDefault = `
      <m:GetFolder>
        <m:FolderShape><t:BaseShape>IdOnly</t:BaseShape><t:AdditionalProperties><t:FieldURI FieldURI="folder:DisplayName"/><t:FieldURI FieldURI="folder:TotalCount"/></t:AdditionalProperties></m:FolderShape>
        <m:FolderIds><t:DistinguishedFolderId Id="calendar">${mb}</t:DistinguishedFolderId></m:FolderIds>
      </m:GetFolder>`;
    const j1 = await this.post(tzEnvelope(getDefault));
    const rm1 = dig(j1, 'Envelope.Body.GetFolderResponse.ResponseMessages.GetFolderResponseMessage');
    assertSuccess(rm1, mailbox ? `GetFolder(calendar of ${mailbox})` : 'GetFolder(calendar)');
    const def = dig(rm1, 'Folders.CalendarFolder');
    const parseFolder = (f, isDefault) => ({
      id: f.FolderId?.['@Id'] || '',
      changeKey: f.FolderId?.['@ChangeKey'] || '',
      name: textOf(f.DisplayName),
      itemCount: Number(f.TotalCount) || 0,
      isDefault,
      mailbox: mailbox || null
    });
    const out = def ? [parseFolder(def, true)] : [];
    // Other people's mailboxes: only their default calendar is addressable
    // without a folder id, and a Deep FindFolder needs root access we rarely have.
    if (mailbox) return out;

    const find = `
      <m:FindFolder Traversal="Deep">
        <m:FolderShape><t:BaseShape>IdOnly</t:BaseShape><t:AdditionalProperties><t:FieldURI FieldURI="folder:DisplayName"/><t:FieldURI FieldURI="folder:TotalCount"/></t:AdditionalProperties></m:FolderShape>
        <m:Restriction>
          <t:Contains ContainmentMode="Prefixed" ContainmentComparison="IgnoreCase"><t:FieldURI FieldURI="folder:FolderClass"/><t:Constant Value="IPF.Appointment"/></t:Contains>
        </m:Restriction>
        <m:ParentFolderIds><t:DistinguishedFolderId Id="msgfolderroot"/></m:ParentFolderIds>
      </m:FindFolder>`;
    const j2 = await this.post(tzEnvelope(find));
    const rm2 = dig(j2, 'Envelope.Body.FindFolderResponse.ResponseMessages.FindFolderResponseMessage');
    assertSuccess(rm2, 'FindFolder(calendars)');
    for (const f of toArray(dig(rm2, 'RootFolder.Folders.CalendarFolder'))) {
      const id = f.FolderId?.['@Id'] || '';
      if (!id || out.some((c) => c.id === id)) continue;
      out.push(parseFolder(f, false));
    }
    // "Other calendars" opened in Outlook/OWA are not folders of this
    // mailbox but shortcuts to someone else's calendar — list them too.
    try {
      for (const link of await this.findSharedCalendarLinks()) out.push({ id: '', changeKey: '', name: link.name, itemCount: null, isDefault: false, mailbox: link.email, shared: true, owner: link.owner });
    } catch {}
    return out;
  },

  /**
   * Shared calendars shown under "Other calendars": WunderBar link items in
   * the Common Views folder whose address-book entry names the owner. The
   * owner's legacy DN is resolved to an SMTP address with ResolveNames.
   */
  async findSharedCalendarLinks() {
    const j1 = await this.post(tzEnvelope(`
      <m:FindFolder Traversal="Shallow">
        <m:FolderShape><t:BaseShape>IdOnly</t:BaseShape></m:FolderShape>
        <m:Restriction><t:IsEqualTo><t:FieldURI FieldURI="folder:DisplayName"/><t:FieldURIOrConstant><t:Constant Value="Common Views"/></t:FieldURIOrConstant></t:IsEqualTo></m:Restriction>
        <m:ParentFolderIds><t:DistinguishedFolderId Id="root"/></m:ParentFolderIds>
      </m:FindFolder>`));
    const cv = toArray(dig(j1, 'Envelope.Body.FindFolderResponse.ResponseMessages.FindFolderResponseMessage.RootFolder.Folders.Folder'))[0];
    const cvId = cv?.FolderId?.['@Id'];
    if (!cvId) return [];
    const j2 = await this.post(tzEnvelope(`
      <m:FindItem Traversal="Associated">
        <m:ItemShape><t:BaseShape>IdOnly</t:BaseShape><t:AdditionalProperties>
          <t:FieldURI FieldURI="item:Subject"/><t:FieldURI FieldURI="item:ItemClass"/>
          <t:ExtendedFieldURI PropertyTag="0x6851" PropertyType="String"/>
          <t:ExtendedFieldURI PropertyTag="0x6849" PropertyType="Integer"/>
          <t:ExtendedFieldURI PropertyTag="0x6854" PropertyType="Binary"/>
        </t:AdditionalProperties></m:ItemShape>
        <m:IndexedPageItemView MaxEntriesReturned="200" Offset="0" BasePoint="Beginning"/>
        <m:ParentFolderIds><t:FolderId Id="${esc(cvId)}"/></m:ParentFolderIds>
      </m:FindItem>`));
    const rm = dig(j2, 'Envelope.Body.FindItemResponse.ResponseMessages.FindItemResponseMessage');
    const items = Object.values(dig(rm, 'RootFolder.Items') || {}).flatMap(toArray);
    const links = [];
    for (const it of items) {
      if (textOf(it.ItemClass) !== 'IPM.Microsoft.WunderBar.Link') continue;
      const ep = {};
      for (const e of toArray(it.ExtendedProperty)) ep[String(e.ExtendedFieldURI?.['@PropertyTag'] || '').toLowerCase()] = textOf(e.Value);
      if (ep['0x6849'] !== '2' || !ep['0x6854']) continue; // 2 = link to another mailbox's folder
      const raw = Buffer.from(ep['0x6854'], 'base64').toString('latin1');
      const dn = raw.match(/\/o=[^\0]+/i)?.[0];
      if (!dn) continue;
      links.push({ name: textOf(it.Subject), group: ep['0x6851'] || '', dn });
    }
    if (links.length === 0) return [];
    const resolved = [];
    for (const l of links) {
      try {
        const j = await this.post(tzEnvelope(`<m:ResolveNames ReturnFullContactData="false"><m:UnresolvedEntry>${esc(l.dn)}</m:UnresolvedEntry></m:ResolveNames>`));
        const res = toArray(dig(j, 'Envelope.Body.ResolveNamesResponse.ResponseMessages.ResolveNamesResponseMessage.ResolutionSet.Resolution'))[0];
        const mb = res?.Mailbox;
        resolved.push({ name: l.name, group: l.group, email: textOf(mb?.EmailAddress) || l.dn, owner: textOf(mb?.Name) || l.name });
      } catch {
        resolved.push({ name: l.name, group: l.group, email: l.dn, owner: l.name });
      }
    }
    return resolved;
  },

  /** Events overlapping [start, end] — recurring series expanded to occurrences, soonest first. */
  async findEvents({ start, end, calendar, mailbox, limit = 100 } = {}) {
    const from = start ? new Date(start) : new Date();
    const to = end ? new Date(end) : new Date(from.getTime() + 7 * 86400e3);
    const body = `
      <m:FindItem Traversal="Shallow">
        <m:ItemShape><t:BaseShape>IdOnly</t:BaseShape><t:AdditionalProperties>${LIST_FIELDS}</t:AdditionalProperties></m:ItemShape>
        <m:CalendarView MaxEntriesReturned="${Math.min(Math.max(1, limit), 1000)}" StartDate="${iso(from)}" EndDate="${iso(to)}"/>
        <m:ParentFolderIds>${folderRef({ calendar, mailbox })}</m:ParentFolderIds>
      </m:FindItem>`;
    const json = await this.post(tzEnvelope(body));
    const rm = dig(json, 'Envelope.Body.FindItemResponse.ResponseMessages.FindItemResponseMessage');
    assertSuccess(rm, mailbox ? `FindItem(calendar of ${mailbox})` : 'FindItem(calendar)');
    return toArray(dig(rm, 'RootFolder.Items.CalendarItem')).map((i) => parseEvent(i, mailbox)).sort((a, b) => new Date(a.start) - new Date(b.start));
  },

  /** One event in full: body, attendees with their responses, reminder, recurrence flag. */
  async getEvent(id) {
    const body = `
      <m:GetItem>
        <m:ItemShape><t:BaseShape>IdOnly</t:BaseShape><t:BodyType>Text</t:BodyType><t:AdditionalProperties>${LIST_FIELDS}
          <t:FieldURI FieldURI="item:Body"/>
          <t:FieldURI FieldURI="item:Categories"/>
          <t:FieldURI FieldURI="item:Importance"/>
          <t:FieldURI FieldURI="item:DateTimeCreated"/>
          <t:FieldURI FieldURI="calendar:RequiredAttendees"/>
          <t:FieldURI FieldURI="calendar:OptionalAttendees"/>
          <t:FieldURI FieldURI="calendar:Resources"/>
          <t:FieldURI FieldURI="calendar:IsResponseRequested"/>
          <t:FieldURI FieldURI="calendar:UID"/>
          <t:FieldURI FieldURI="calendar:AppointmentReplyTime"/>
        </t:AdditionalProperties></m:ItemShape>
        <m:ItemIds><t:ItemId Id="${esc(id)}"/></m:ItemIds>
      </m:GetItem>`;
    const json = await this.post(tzEnvelope(body));
    const rm = dig(json, 'Envelope.Body.GetItemResponse.ResponseMessages.GetItemResponseMessage');
    assertSuccess(rm, 'GetItem(event)');
    const it = dig(rm, 'Items.CalendarItem');
    if (!it) throw new Error('GetItem: not a calendar item');
    const attendees = (kind, role) => toArray(dig(it, kind + '.Attendee')).map((a) => ({
      ...parseMailbox(a.Mailbox), role, response: textOf(a.ResponseType) || 'Unknown'
    }));
    return {
      ...parseEvent(it, null),
      body: textOf(dig(it, 'Body')).replace(/\r\n?/g, '\n'),
      categories: toArray(dig(it, 'Categories.String')).map(textOf),
      importance: textOf(it.Importance) || 'Normal',
      created: textOf(it.DateTimeCreated),
      uid: textOf(it.UID),
      responseRequested: String(it.IsResponseRequested) !== 'false',
      attendees: [...attendees('RequiredAttendees', 'required'), ...attendees('OptionalAttendees', 'optional'), ...attendees('Resources', 'resource')]
    };
  },

  /**
   * Create an appointment (no attendees) or a meeting (attendees → invitations
   * go out when notify is true; otherwise it is saved without inviting anyone).
   */
  async createEvent({ subject, start, end, allDay = false, location, body, attendees = [], optionalAttendees = [], reminderMinutes, showAs, calendar, notify = true, timeZone }) {
    if (!subject) throw new Error('createEvent: subject is required');
    const s = new Date(start);
    const e = end ? new Date(end) : new Date(s.getTime() + (allDay ? 86400e3 : 30 * 60e3));
    if (isNaN(s) || isNaN(e)) throw new Error('createEvent: invalid start/end');
    if (e <= s) throw new Error('createEvent: end must be after start');
    const mailboxes = (list) => list.map((a) => `<t:Attendee><t:Mailbox><t:EmailAddress>${esc(a)}</t:EmailAddress></t:Mailbox></t:Attendee>`).join('');
    const hasAttendees = attendees.length + optionalAttendees.length > 0;
    const disposition = hasAttendees && notify ? 'SendToAllAndSaveCopy' : 'SendToNone';
    const saved = calendar ? `<m:SavedItemFolderId><t:FolderId Id="${esc(calendar)}"/></m:SavedItemFolderId>` : '';
    const xml = `
      <m:CreateItem SendMeetingInvitations="${disposition}">
        ${saved}
        <m:Items>
          <t:CalendarItem>
            <t:Subject>${esc(subject)}</t:Subject>
            ${body ? `<t:Body BodyType="Text">${esc(body)}</t:Body>` : ''}
            <t:ReminderIsSet>${reminderMinutes != null && reminderMinutes >= 0 ? 'true' : 'false'}</t:ReminderIsSet>
            ${reminderMinutes != null && reminderMinutes >= 0 ? `<t:ReminderMinutesBeforeStart>${Number(reminderMinutes)}</t:ReminderMinutesBeforeStart>` : ''}
            <t:Start>${allDay ? localDate(s) : iso(s)}</t:Start>
            <t:End>${allDay ? localDate(e) : iso(e)}</t:End>
            <t:IsAllDayEvent>${allDay ? 'true' : 'false'}</t:IsAllDayEvent>
            <t:LegacyFreeBusyStatus>${BUSY.includes(showAs) ? showAs : allDay ? 'Free' : 'Busy'}</t:LegacyFreeBusyStatus>
            ${location ? `<t:Location>${esc(location)}</t:Location>` : ''}
            ${attendees.length ? `<t:RequiredAttendees>${mailboxes(attendees)}</t:RequiredAttendees>` : ''}
            ${optionalAttendees.length ? `<t:OptionalAttendees>${mailboxes(optionalAttendees)}</t:OptionalAttendees>` : ''}
          </t:CalendarItem>
        </m:Items>
      </m:CreateItem>`;
    const json = await this.post(tzEnvelope(xml, timeZone));
    const rm = dig(json, 'Envelope.Body.CreateItemResponse.ResponseMessages.CreateItemResponseMessage');
    assertSuccess(rm, 'CreateItem(event)');
    const created = dig(rm, 'Items.CalendarItem.ItemId');
    return { id: created?.['@Id'] || null, changeKey: created?.['@ChangeKey'] || null, invitationsSent: hasAttendees && notify };
  },

  /** Change fields of an event. notify=true sends updates to attendees (meetings only). */
  async updateEvent({ id, changeKey, subject, start, end, allDay, location, body, attendees, optionalAttendees, reminderMinutes, showAs, notify = true, timeZone }) {
    const set = (uri, inner) => `<t:SetItemField><t:FieldURI FieldURI="${uri}"/><t:CalendarItem>${inner}</t:CalendarItem></t:SetItemField>`;
    const mailboxes = (list) => list.map((a) => `<t:Attendee><t:Mailbox><t:EmailAddress>${esc(a)}</t:EmailAddress></t:Mailbox></t:Attendee>`).join('');
    const sets = [];
    if (subject !== undefined) sets.push(set('item:Subject', `<t:Subject>${esc(subject)}</t:Subject>`));
    if (body !== undefined) sets.push(set('item:Body', `<t:Body BodyType="Text">${esc(body)}</t:Body>`));
    if (reminderMinutes !== undefined) {
      sets.push(set('item:ReminderIsSet', `<t:ReminderIsSet>${reminderMinutes >= 0 ? 'true' : 'false'}</t:ReminderIsSet>`));
      if (reminderMinutes >= 0) sets.push(set('item:ReminderMinutesBeforeStart', `<t:ReminderMinutesBeforeStart>${Number(reminderMinutes)}</t:ReminderMinutesBeforeStart>`));
    }
    if (start !== undefined) sets.push(set('calendar:Start', `<t:Start>${allDay ? localDate(start) : iso(start)}</t:Start>`));
    if (end !== undefined) sets.push(set('calendar:End', `<t:End>${allDay ? localDate(end) : iso(end)}</t:End>`));
    if (allDay !== undefined) sets.push(set('calendar:IsAllDayEvent', `<t:IsAllDayEvent>${allDay ? 'true' : 'false'}</t:IsAllDayEvent>`));
    if (showAs !== undefined && BUSY.includes(showAs)) sets.push(set('calendar:LegacyFreeBusyStatus', `<t:LegacyFreeBusyStatus>${showAs}</t:LegacyFreeBusyStatus>`));
    if (location !== undefined) sets.push(set('calendar:Location', `<t:Location>${esc(location)}</t:Location>`));
    if (attendees !== undefined) sets.push(set('calendar:RequiredAttendees', `<t:RequiredAttendees>${mailboxes(attendees)}</t:RequiredAttendees>`));
    if (optionalAttendees !== undefined) sets.push(set('calendar:OptionalAttendees', `<t:OptionalAttendees>${mailboxes(optionalAttendees)}</t:OptionalAttendees>`));
    if (sets.length === 0) throw new Error('updateEvent: nothing to change');
    const xml = `
      <m:UpdateItem ConflictResolution="AutoResolve" SendMeetingInvitationsOrCancellations="${notify ? 'SendToAllAndSaveCopy' : 'SendToNone'}">
        <m:ItemChanges>
          <t:ItemChange>
            <t:ItemId Id="${esc(id)}"${changeKey ? ` ChangeKey="${esc(changeKey)}"` : ''}/>
            <t:Updates>${sets.join('')}</t:Updates>
          </t:ItemChange>
        </m:ItemChanges>
      </m:UpdateItem>`;
    const json = await this.post(tzEnvelope(xml, timeZone));
    const rm = dig(json, 'Envelope.Body.UpdateItemResponse.ResponseMessages.UpdateItemResponseMessage');
    assertSuccess(rm, 'UpdateItem(event)');
    const upd = dig(rm, 'Items.CalendarItem.ItemId');
    return { id: upd?.['@Id'] || id, changeKey: upd?.['@ChangeKey'] || null };
  },

  /** Delete (to Deleted Items). As organizer of a meeting, notify=true sends cancellations. */
  async deleteEvent(id, changeKey, { notify = true } = {}) {
    const xml = `
      <m:DeleteItem DeleteType="MoveToDeletedItems" SendMeetingCancellations="${notify ? 'SendToAllAndSaveCopy' : 'SendToNone'}">
        <m:ItemIds><t:ItemId Id="${esc(id)}"${changeKey ? ` ChangeKey="${esc(changeKey)}"` : ''}/></m:ItemIds>
      </m:DeleteItem>`;
    const json = await this.post(tzEnvelope(xml));
    const rm = dig(json, 'Envelope.Body.DeleteItemResponse.ResponseMessages.DeleteItemResponseMessage');
    assertSuccess(rm, 'DeleteItem(event)');
    return true;
  },

  /** accept | tentative | decline a meeting. notify=false records it without mailing the organizer. */
  async respondToEvent(id, changeKey, response, { message, notify = true } = {}) {
    const tag = { accept: 'AcceptItem', tentative: 'TentativelyAcceptItem', decline: 'DeclineItem' }[String(response).toLowerCase()];
    if (!tag) throw new Error('response must be accept, tentative or decline');
    const xml = `
      <m:CreateItem MessageDisposition="${notify ? 'SendAndSaveCopy' : 'SaveOnly'}">
        <m:Items>
          <t:${tag}>
            ${message ? `<t:Body BodyType="Text">${esc(message)}</t:Body>` : ''}
            <t:ReferenceItemId Id="${esc(id)}"${changeKey ? ` ChangeKey="${esc(changeKey)}"` : ''}/>
          </t:${tag}>
        </m:Items>
      </m:CreateItem>`;
    const json = await this.post(tzEnvelope(xml));
    const rm = dig(json, 'Envelope.Body.CreateItemResponse.ResponseMessages.CreateItemResponseMessage');
    assertSuccess(rm, `CreateItem(${tag})`);
    return true;
  },

  /**
   * Free/busy of several people. Works for anyone in the organisation
   * (busy blocks); subjects/locations appear only where you have been granted
   * details. Interval grid (`merged`) is one char per slot: 0 free,
   * 1 tentative, 2 busy, 3 out of office, 4 no data.
   */
  async getFreeBusy({ emails, start, end, intervalMinutes = 30 }) {
    if (!emails || emails.length === 0) throw new Error('getFreeBusy: at least one email is required');
    const from = new Date(start || Date.now());
    const to = new Date(end || from.getTime() + 86400e3);
    const naive = (d) => d.toISOString().replace(/\.\d{3}Z$/, '');
    const tz = `
      <t:TimeZone>
        <t:Bias>0</t:Bias>
        <t:StandardTime><t:Bias>0</t:Bias><t:Time>02:00:00</t:Time><t:DayOrder>5</t:DayOrder><t:Month>10</t:Month><t:DayOfWeek>Sunday</t:DayOfWeek></t:StandardTime>
        <t:DaylightTime><t:Bias>0</t:Bias><t:Time>02:00:00</t:Time><t:DayOrder>1</t:DayOrder><t:Month>4</t:Month><t:DayOfWeek>Sunday</t:DayOfWeek></t:DaylightTime>
      </t:TimeZone>`;
    const xml = `
      <m:GetUserAvailabilityRequest>
        ${tz}
        <m:MailboxDataArray>
          ${emails.map((e) => `<t:MailboxData><t:Email><t:Address>${esc(e)}</t:Address></t:Email><t:AttendeeType>Required</t:AttendeeType><t:ExcludeConflicts>false</t:ExcludeConflicts></t:MailboxData>`).join('')}
        </m:MailboxDataArray>
        <t:FreeBusyViewOptions>
          <t:TimeWindow><t:StartTime>${naive(from)}</t:StartTime><t:EndTime>${naive(to)}</t:EndTime></t:TimeWindow>
          <t:MergedFreeBusyIntervalInMinutes>${Math.min(1440, Math.max(5, Number(intervalMinutes) || 30))}</t:MergedFreeBusyIntervalInMinutes>
          <t:RequestedView>DetailedMerged</t:RequestedView>
        </t:FreeBusyViewOptions>
      </m:GetUserAvailabilityRequest>`;
    const json = await this.post(tzEnvelope(xml, 'UTC'));
    const list = toArray(dig(json, 'Envelope.Body.GetUserAvailabilityResponse.FreeBusyResponseArray.FreeBusyResponse'));
    if (list.length === 0) throw new Error('GetUserAvailability: malformed response');
    return list.map((r, i) => {
      const rm = r.ResponseMessage || {};
      const view = r.FreeBusyView || {};
      const ok = rm['@ResponseClass'] === 'Success';
      return {
        email: emails[i],
        ok,
        error: ok ? null : textOf(rm.MessageText) || rm.ResponseCode || 'unknown error',
        view: textOf(view.FreeBusyViewType) || null,
        merged: textOf(view.MergedFreeBusy) || '',
        intervalMinutes: Number(intervalMinutes) || 30,
        start: from.toISOString(),
        end: to.toISOString(),
        events: toArray(dig(view, 'CalendarEventArray.CalendarEvent')).map((ev) => ({
          start: utcOf(textOf(ev.StartTime)),
          end: utcOf(textOf(ev.EndTime)),
          status: textOf(ev.BusyType),
          subject: textOf(dig(ev, 'CalendarEventDetails.Subject')) || null,
          location: textOf(dig(ev, 'CalendarEventDetails.Location')) || null,
          isMeeting: String(dig(ev, 'CalendarEventDetails.IsMeeting')) === 'true',
          isPrivate: String(dig(ev, 'CalendarEventDetails.IsPrivate')) === 'true'
        })),
        workingHours: parseWorkingHours(view.WorkingHours)
      };
    });
  }
};

// Availability times come back in the request's (UTC) zone without an offset.
function utcOf(s) {
  if (!s) return '';
  return /[zZ]|[+-]\d\d:\d\d$/.test(s) ? new Date(s).toISOString() : new Date(s + 'Z').toISOString();
}

function parseWorkingHours(wh) {
  if (!wh) return null;
  const periods = toArray(dig(wh, 'WorkingPeriodArray.WorkingPeriod')).map((p) => ({
    days: textOf(p.DayOfWeek).split(/\s+/).filter(Boolean),
    startMinutes: Number(p.StartTimeInMinutes) || 0,
    endMinutes: Number(p.EndTimeInMinutes) || 0
  }));
  return { timeZoneBias: Number(dig(wh, 'TimeZone.Bias')) || 0, periods };
}

function parseEvent(it, mailbox) {
  const org = dig(it, 'Organizer.Mailbox');
  // own appointments come back with a legacy Exchange DN instead of an SMTP address
  const orgEmail = textOf(org?.RoutingType) === 'EX' ? '' : textOf(org?.EmailAddress);
  return {
    id: it.ItemId?.['@Id'] || '',
    changeKey: it.ItemId?.['@ChangeKey'] || '',
    subject: textOf(it.Subject),
    start: textOf(it.Start),
    end: textOf(it.End),
    allDay: String(it.IsAllDayEvent) === 'true',
    location: textOf(it.Location),
    organizerName: textOf(org?.Name),
    organizerEmail: orgEmail,
    showAs: textOf(it.LegacyFreeBusyStatus) || 'Busy',
    myResponse: textOf(it.MyResponseType) || 'Unknown',
    isMeeting: String(it.IsMeeting) === 'true',
    isCancelled: String(it.IsCancelled) === 'true',
    isRecurring: String(it.IsRecurring) === 'true',
    type: textOf(it.CalendarItemType) || 'Single',
    private: ['Private', 'Confidential'].includes(textOf(it.Sensitivity)),
    hasAttachments: String(it.HasAttachments) === 'true',
    reminderMinutes: String(it.ReminderIsSet) === 'true' ? Number(it.ReminderMinutesBeforeStart) || 0 : null,
    modified: textOf(it.LastModifiedTime),
    mailbox: mailbox || null
  };
}
