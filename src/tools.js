// The mail and calendar tools of MailWatcher's MCP server, as plain objects
// any agent host can serve in-process. They are static (declared before any
// mailcore instance exists); the instance is passed to each call:
//
//   { name, description, input (a zod object schema), effect, run(core, args, ctx) }
//
// Names, descriptions, schemas and outputs are the MCP server's, unchanged.
// run() returns the data the MCP server sends as JSON text.
//
// effect, strictest first:
//   'others'        sends mail to someone, or changes a meeting that has other
//                   attendees (send_draft, invitations, updates, cancellations,
//                   responses). For create/update/delete_event `effect` is the
//                   worst case and effectFor(args) the effect of one call.
//   'own-calendar'  an appointment on my own calendar, nobody else involved
//   'draft'         creates, edits or deletes a draft; nothing is sent
//   'local'         changes state without mailing anyone (mark read, files written)
//   'read'          reads only
//
// Sending is refused unless allowSend: send_draft is left out, and the calendar
// tools throw before anything would mail another person.

import path from 'node:path';
import fs from 'node:fs';
import { z } from 'zod';
import { prepareBody, BODY_FORMATS } from './body.js';
import { calendarProvider, hasMail, jmapSessionUrl } from './accounts.js';
import { parseWhen } from './calendar.js';

export const EFFECTS = ['read', 'local', 'draft', 'own-calendar', 'others'];

/** The server instructions that go with the tools (allowSend says whether sending is on). */
export function mailInstructions({ allowSend = false, name = 'mailwatcher' } = {}) {
  return `${name}: the user's mailboxes (Exchange, IMAP and/or JMAP; list_accounts) and Exchange calendars. Message and event ids are "<account>:<id>".
Reading is open. Writing creates DRAFTS only (draft_reply, draft_reply_all, compose_draft) — mail is never sent unless a send_draft tool is present AND the user explicitly asks to send. Bodies are plain text by default; pass format: 'markdown' for tables/lists/bold (converted to HTML) or 'html'. add_attachment with inline: true embeds an image for <img src=\"cid:…\">.

Calendar (Exchange, CalDAV — iCloud/Fastmail — and Google accounts; list_accounts says which): list_calendars, list_events (own calendars by name, or a colleague's shared calendar by email on Exchange/Google), get_event, free_busy / find_free_slots (anyone in the organisation on Exchange; people who share with you on Google; via the scheduling outbox on CalDAV), create_event, update_event, delete_event, respond_to_event. Dates accept ISO or natural forms ("tomorrow 9am", "friday 14:00", "+2d"). Creating a meeting with attendees, changing or cancelling one, and accepting/declining all SEND mail to other people: ${allowSend ? 'allowed here, but only do it when the user explicitly asks' : 'disabled here (mcp.allowSend is off) — create attendee-less appointments only, and tell the user how to enable it'}.`;
}

/** The server's instructions as served with sending off (mcp.allowSend unset). */
export const MAIL_INSTRUCTIONS = mailInstructions({ allowSend: false });

/**
 * mailTools({ allowSend, attachmentsDir?, attachmentsLabel?, sendDisabledHint? }) → MailTool[]
 *   attachmentsDir    default target of save_attachments (default <core.dataDir>/attachments)
 *   attachmentsLabel  how the description names it (default: attachmentsDir, or <dataDir>/attachments)
 *   sendDisabledHint  what the refusal tells the user to do to allow sending
 * Each tool: run(core, args, ctx?) → the data the MCP server sends as JSON text.
 */
export function mailTools({ allowSend = false, attachmentsDir, attachmentsLabel, sendDisabledHint = 'set mcp.allowSend: true in ~/.mailwatcher/config.json to allow it' } = {}) {
  if (attachmentsLabel === undefined) attachmentsLabel = attachmentsDir || '<dataDir>/attachments';
  const accountSchema = z.string().optional().describe('Account name (default: all accounts)');
  const calendarArg = z.string().optional().describe('Own calendar by name or id (default: the default calendar), or a colleague\'s email for their shared calendar');
  const needSend = (what) => {
    if (!allowSend) throw new Error(`${what} would send mail to other people — disabled: ${sendDisabledHint}`);
  };

  // what a handler needs from one core; built per core, once
  const envs = new WeakMap();
  const envOf = (core) => {
    let e = envs.get(core);
    if (e) return e;
    const cal = { ...core.calendar, parseWhen };
    e = {
      core,
      cal,
      json: (data) => data,
      when: (v) => (v == null || v === '' ? undefined : parseWhen(v)),
      needSend,
      // listings span every account unless `account` is given; ids route to their account
      mail: {
        findInbox: (o, account) => core.find(account, o, () => {}),
        getMessage: (id, o) => core.read(id, o),
        draftReply: (id, ck, b, o) => core.withClient(id, (c) => c.draftReply(id, ck, b, o)),
        draftReplyAll: (id, ck, b, o) => core.withClient(id, (c) => c.draftReplyAll(id, ck, b, o)),
        createMessage: (o, account) => core.withClient(account, (c) => c.createMessage(o)),
        addAttachment: (id, ck, a) => core.addAttachment(id, ck, a),
        updateDraft: (o) => core.updateDraft(o),
        deleteItem: (id, ck) => core.deleteItem(id, ck),
        markRead: (id, ck) => core.markRead(id, true, ck),
        sendItem: (id, ck) => core.send(id, ck)
      },
      getThread: (o) => core.getThread(o),
      awaitingReply: (o) => core.awaitingReply(o),
      saveAttachments: (id, dir, o) => core.saveAttachments(id, dir, o),
      attachmentsDir: attachmentsDir !== undefined ? attachmentsDir : core.dataDir ? path.join(core.dataDir, 'attachments') : null
    };
    envs.set(core, e);
    return e;
  };

  const tool = (name, effect, { description, inputSchema }, make, extra = {}) => ({
    name,
    description,
    input: z.object(inputSchema),
    effect,
    run: (core, args = {}, ctx = {}) => make(envOf(core))(args, ctx),
    ...extra
  });

  return [
  tool('list_unread', 'read',
    {
      description: 'List unread messages (newest first).',
      inputSchema: {
        limit: z.number().int().min(1).max(50).optional().describe('Max results, default 20'),
        folder: z.enum(['inbox', 'junk', 'sent', 'drafts', 'trash', 'archive']).optional().describe('Default inbox'),
        account: accountSchema
      }
    },
    ({ core, mail, cal, json, when, needSend, getThread, awaitingReply, saveAttachments, attachmentsDir }) =>
    async ({ limit, folder, account }) => json(await mail.findInbox({ limit: limit || 20, unreadOnly: true, folder }, account))),
  tool('search_mail', 'read',
    {
      description:
        'Search a mail folder. sender/subject/to are substrings; text searches subject AND body; hasAttachments filters to mail with files. Inbox queries are served from the local encrypted cache when the daemon is running (live: true forces the server). Returns { items, cursor? }: when `limit` was hit, pass `cursor` as `until` (same filters) to page further back.',
      inputSchema: {
        sender: z.string().optional().describe('Substring of sender name or address'),
        subject: z.string().optional().describe('Substring of subject'),
        text: z.string().optional().describe('Search subject AND body (content-index search)'),
        to: z.string().optional().describe('Substring of a To/Cc recipient (name or address)'),
        fromMe: z.boolean().optional().describe('Only mail I sent (sender = my own address)'),
        since: z.string().optional().describe('ISO date/time: only mail received at or after this (replaces days)'),
        until: z.string().optional().describe('ISO date/time: only mail received at or before this — pass a previous result\'s cursor to page'),
        hasAttachments: z.boolean().optional().describe('Only mail with attachments'),
        days: z.number().int().min(1).max(90).optional().describe('Only mail from the last N days'),
        unread: z.boolean().optional().describe('Only unread mail'),
        folder: z.enum(['inbox', 'junk', 'sent', 'drafts', 'trash', 'archive']).optional().describe('Default inbox'),
        limit: z.number().int().min(1).max(50).optional(),
        account: accountSchema,
        live: z.boolean().optional().describe('Bypass the local cache and query the server')
      }
    },
    ({ core, mail, cal, json, when, needSend, getThread, awaitingReply, saveAttachments, attachmentsDir }) =>
    async ({ sender, subject, text, to, fromMe, since, until, hasAttachments, days, unread, folder, limit, account, live }) => {
      const max = limit || 20;
      const items = await mail.findInbox({
        limit: max,
        senderContains: sender,
        subjectContains: subject,
        text,
        toContains: to,
        fromMe: !!fromMe || undefined,
        hasAttachments: !!hasAttachments || undefined,
        unreadOnly: !!unread,
        folder,
        sinceIso: since ? new Date(since).toISOString() : days ? new Date(Date.now() - days * 86400e3).toISOString() : undefined,
        untilIso: until ? new Date(until).toISOString() : undefined,
        live
      }, account);
      const out = { items };
      if (items.length >= max && items.length) out.cursor = new Date(new Date(items[items.length - 1].received).getTime() - 1000).toISOString();
      return json(out);
    }),
  tool('read_message', 'read',
    {
      description: 'Read one message in full (body, recipients, attachments) by its id. Plain-text body by default; format: "html" returns the HTML body (e.g. to edit a draft in place with update_draft format: "html").',
      inputSchema: {
        id: z.string().describe('Message id from a listing'),
        format: z.enum(['text', 'html']).optional().describe('Body format: text (default) or html'),
        live: z.boolean().optional().describe('Bypass the local cache and read from the server')
      }
    },
    ({ core, mail, cal, json, when, needSend, getThread, awaitingReply, saveAttachments, attachmentsDir }) =>
    async ({ id, format, live }) => json(await mail.getMessage(id, { ...(format === 'html' ? { bodyType: 'HTML' } : {}), ...(live ? { live: true } : {}) }))),
  tool('save_attachments', 'local',
    {
      description:
        `Download a message's file attachments to a local directory (default ${attachmentsLabel}/<message>). Returns the saved paths. Use read_message first to see attachment names/ids.`,
      inputSchema: {
        id: z.string().describe('Message id'),
        only: z.string().optional().describe('Only this attachment (id or file name)'),
        dir: z.string().optional().describe('Target directory')
      }
    },
    ({ core, mail, cal, json, when, needSend, getThread, awaitingReply, saveAttachments, attachmentsDir }) =>
    async ({ id, only, dir }) => {
      if (!dir && !attachmentsDir) throw new Error('save_attachments: pass dir (no default attachments directory is configured)');
      const target = dir || path.join(attachmentsDir, id.replace(/[^\w.-]+/g, '_').slice(-80));
      return json(await saveAttachments(id, target, { only }));
    }),
  tool('get_thread', 'read',
    {
      description: 'Messages of one thread across Inbox and Sent, oldest first (each carries `folder`). Pass the id of any message in it (thread = Exchange ConversationId, or the Message-ID chain on IMAP); subject matching is the fallback. Looks back `days` (default 14, max 90).',
      inputSchema: {
        id: z.string().optional().describe('Id of any message in the thread (preferred)'),
        subject: z.string().optional().describe('Subject of any message in the thread (fallback)'),
        days: z.number().int().min(1).max(90).optional().describe('How far back to look (default 14)'),
        account: accountSchema
      }
    },
    ({ core, mail, cal, json, when, needSend, getThread, awaitingReply, saveAttachments, attachmentsDir }) =>
    async ({ id, subject, days, account }) => json(await getThread({ id, subject, days: days || 14, account, onError: () => {} }))),
  tool('awaiting_reply', 'read',
    {
      description:
        'Threads where the last word is theirs and I never answered: last message inbound, I am in To (or Cc), no message from me after it, within the last `days`. Bulk/automated senders, mailing lists and calendar mail are left out. Each thread: subject, lastMessageId (reply with draft_reply), sender, received, addressed (to|cc|unknown), participants, snippet (200 chars, quotes stripped), askedSomething (question/request heuristic, en+fr), myLastReplyAt, theirsSinceMyLast. Returns { threads, scanned, cursor }: pass `cursor` as `since` on the next sweep to see only threads with newer inbound mail. The judgment of what really needs an answer is yours.',
      inputSchema: {
        days: z.number().int().min(1).max(90).optional().describe('Look-back window (default 28)'),
        account: accountSchema,
        limit: z.number().int().min(1).max(200).optional().describe('Max threads (default 50)'),
        includeCc: z.boolean().optional().describe('Include threads where I am only in Cc (default true)'),
        since: z.string().optional().describe('Cursor from a previous sweep: only threads whose last inbound message is newer')
      }
    },
    ({ core, mail, cal, json, when, needSend, getThread, awaitingReply, saveAttachments, attachmentsDir }) =>
    async ({ days, account, limit, includeCc, since }) =>
      json(await awaitingReply({ days: days || 28, account, limit: limit || 50, includeCc: includeCc !== false, since, onError: () => {} }))),
  tool('draft_reply_all', 'draft',
    {
      description:
        'Create a reply-all DRAFT for a message. The draft is saved to the Drafts folder and is NEVER sent — a human reviews and sends it.',
      inputSchema: {
        id: z.string().describe('Message id to reply to'),
        changeKey: z.string().optional().describe('changeKey from the listing, if known; looked up when omitted'),
        body: z.string().describe('Body of the reply (plain text unless `format` says otherwise)'),
        format: z.enum(BODY_FORMATS).optional().describe("How to read `body`: 'text' (default), 'markdown' (converted to HTML — use for tables, lists, bold), or 'html' (sent as is)")
      }
    },
    ({ core, mail, cal, json, when, needSend, getThread, awaitingReply, saveAttachments, attachmentsDir }) =>
    async ({ id, changeKey, body, format }) => { const b = prepareBody(body, format); return json(await mail.draftReplyAll(id, changeKey, b.body, { bodyType: b.bodyType })); }),
  tool('draft_reply', 'draft',
    {
      description:
        'Create a reply DRAFT to the sender only (not reply-all). Saved to Drafts and NEVER sent — a human reviews and sends it.',
      inputSchema: {
        id: z.string().describe('Message id'),
        changeKey: z.string().optional().describe('changeKey from the listing, if known; looked up when omitted'),
        body: z.string().describe('Body of the reply (plain text unless `format` says otherwise)'),
        format: z.enum(BODY_FORMATS).optional().describe("How to read `body`: 'text' (default), 'markdown' (converted to HTML — use for tables, lists, bold), or 'html' (sent as is)")
      }
    },
    ({ core, mail, cal, json, when, needSend, getThread, awaitingReply, saveAttachments, attachmentsDir }) =>
    async ({ id, changeKey, body, format }) => { const b = prepareBody(body, format); return json(await mail.draftReply(id, changeKey, b.body, { bodyType: b.bodyType })); }),
  tool('compose_draft', 'draft',
    {
      description:
        'Create a brand-new mail as a DRAFT (not a reply): recipients, subject, plain-text body. Saved to Drafts, NEVER sent — a human reviews and sends. Returns the draft id + changeKey.',
      inputSchema: {
        to: z.array(z.string()).min(1).describe('Recipient email addresses'),
        cc: z.array(z.string()).optional(),
        subject: z.string(),
        body: z.string().describe('Body (plain text unless `format` says otherwise)'),
        format: z.enum(BODY_FORMATS).optional().describe("How to read `body`: 'text' (default), 'markdown' (converted to HTML — use for tables, lists, bold), or 'html' (sent as is)"),
        account: z.string().optional().describe('Account to create the draft in (required when several are configured)')
      }
    },
    ({ core, mail, cal, json, when, needSend, getThread, awaitingReply, saveAttachments, attachmentsDir }) =>
    async ({ to, cc, subject, body, account, format }) => { const b = prepareBody(body, format); return json(await mail.createMessage({ to, cc: cc || [], subject, body: b.body, bodyType: b.bodyType, send: false }, account)); }),
  tool('add_attachment', 'draft',
    {
      description:
        'Attach a local file to an existing DRAFT by its id. Returns the new changeKey. Max 25 MB. With inline=true the file (an image) is embedded for an HTML body: reference it as <img src="cid:CONTENT_ID"> (contentId defaults to the file name).',
      inputSchema: {
        id: z.string().describe('Draft item id'),
        changeKey: z.string().optional().describe('Current changeKey, if known'),
        path: z.string().describe('Absolute path of the file to attach'),
        inline: z.boolean().optional().describe('Embed as an inline image (HTML bodies)'),
        contentId: z.string().optional().describe('Content-ID to use in <img src="cid:…">; defaults to the file name')
      }
    },
    ({ core, mail, cal, json, when, needSend, getThread, awaitingReply, saveAttachments, attachmentsDir }) =>
    async ({ id, changeKey, path: filePath, inline, contentId }) => {
      const p = path;
      if (!p.isAbsolute(filePath)) throw new Error('path must be absolute');
      const data = fs.readFileSync(filePath);
      if (data.length > 25 * 1024 * 1024) throw new Error('file exceeds the 25 MB attachment limit');
      return json(
        await mail.addAttachment(id, changeKey, {
          name: p.basename(filePath),
          contentBase64: data.toString('base64'),
          contentType: mimeFor(filePath),
          inline: !!inline,
          contentId: contentId || p.basename(filePath)
        })
      );
    }),
  tool('update_draft', 'draft',
    {
      description:
        'Edit an existing DRAFT (subject, body, recipients). Requires the draft id and its current changeKey (from draft_reply_all/compose results or a drafts-folder listing). Returns the new changeKey for further edits. Never sends.',
      inputSchema: {
        id: z.string().describe('Draft item id'),
        changeKey: z.string().describe('Current changeKey of the draft'),
        subject: z.string().optional(),
        body: z.string().optional().describe('New body (replaces the whole body unless keepQuoted; plain text unless `format` says otherwise)'),
        keepQuoted: z.boolean().optional().describe('For reply/forward drafts: replace only the text above the quoted original thread and keep the quote as is'),
        format: z.enum(BODY_FORMATS).optional().describe("How to read `body`: 'text' (default), 'markdown' (converted to HTML — use for tables, lists, bold), or 'html' (sent as is)"),
        to: z.array(z.string()).optional().describe('Replacement To recipients (email addresses)'),
        cc: z.array(z.string()).optional().describe('Replacement Cc recipients')
      }
    },
    ({ core, mail, cal, json, when, needSend, getThread, awaitingReply, saveAttachments, attachmentsDir }) =>
    async ({ id, changeKey, subject, body, to, cc, format, keepQuoted }) => { const b = body === undefined ? {} : prepareBody(body, format); return json(await mail.updateDraft({ id, changeKey, subject, body: b.body, bodyType: b.bodyType, to, cc, keepQuoted: !!keepQuoted })); }),
  tool('delete_draft', 'draft',
    {
      description:
        'Delete a draft (moves it to Deleted Items — reversible). Use to replace or clean up drafts you created.',
      inputSchema: {
        id: z.string().describe('Draft item id'),
        changeKey: z.string().optional()
      }
    },
    ({ core, mail, cal, json, when, needSend, getThread, awaitingReply, saveAttachments, attachmentsDir }) =>
    async ({ id, changeKey }) => json({ ok: await mail.deleteItem(id, changeKey) })),
  tool('mark_read', 'local',
    {
      description: 'Mark a message as read.',
      inputSchema: {
        id: z.string(),
        changeKey: z.string().describe('changeKey from the listing')
      }
    },
    ({ core, mail, cal, json, when, needSend, getThread, awaitingReply, saveAttachments, attachmentsDir }) =>
    async ({ id, changeKey }) => json({ ok: await mail.markRead(id, changeKey, true) })),
  ...(allowSend ? [
    tool('send_draft', 'others',
      {
          description:
            'SEND an existing draft (from compose_draft, draft_reply or draft_reply_all). This actually sends mail to the recipients — only use it when the user explicitly asked to send. Enabled by mcp.allowSend in config.json.',
          inputSchema: { id: z.string().describe('Draft id'), changeKey: z.string().optional().describe('changeKey returned when the draft was created/updated') }
        },
      ({ core, mail, cal, json, when, needSend, getThread, awaitingReply, saveAttachments, attachmentsDir }) =>
      async ({ id, changeKey }) => json({ sent: await mail.sendItem(id, changeKey || '') }))
  ] : []),
  tool('list_accounts', 'read',
    { description: 'List the configured accounts (name, provider, whether it holds mail, which calendar backend: ews | caldav | google | null, server). Message and event ids are prefixed "<account>:".', inputSchema: {} },
    ({ core, mail, cal, json, when, needSend, getThread, awaitingReply, saveAttachments, attachmentsDir }) =>
    async () => {
      const cfg = core.config;
      return json(Object.values(cfg.accounts).map((a) => ({ name: a.name, provider: a.provider, mail: hasMail(a), calendar: calendarProvider(a) || null, server: a.provider === 'imap' ? a.imap?.host : a.provider === 'jmap' ? jmapHost(a) : a.provider === 'caldav' ? (a.server || a.service) : a.provider === 'google' ? 'calendar.google.com' : a.host, email: a.email || undefined })));
    }),
  tool('list_calendars', 'read',
    {
      description: 'List the calendars of the Exchange account(s): the default one plus any extra calendars you created. Pass mailbox to see whether a colleague\'s default calendar is shared with you.',
      inputSchema: { account: accountSchema, mailbox: z.string().optional().describe('Email of another person (their default calendar)') }
    },
    ({ core, mail, cal, json, when, needSend, getThread, awaitingReply, saveAttachments, attachmentsDir }) =>
    async ({ account, mailbox }) => json(await cal.listCalendars(account, { mailbox, onError: () => {} }))),
  tool('list_events', 'read',
    {
      description: 'Events in a time window (default: now → +7 days), recurring series expanded, soonest first. Own default calendar across accounts unless `calendar` names one of your calendars or a colleague\'s email (needs their sharing permission). Times are ISO with offset.',
      inputSchema: {
        start: z.string().optional().describe('ISO or natural ("today", "monday", "+1d"); default now'),
        end: z.string().optional().describe('Default start + 7 days'),
        calendar: calendarArg,
        limit: z.number().int().min(1).max(500).optional().describe('Default 100'),
        account: accountSchema
      }
    },
    ({ core, mail, cal, json, when, needSend, getThread, awaitingReply, saveAttachments, attachmentsDir }) =>
    async ({ start, end, calendar, limit, account }) => {
      const s = when(start) || new Date();
      const e = when(end) || new Date(s.getTime() + 7 * 86400e3);
      return json(await cal.listEvents({ account, start: s, end: e, calendar, limit: limit || 100, onError: () => {} }));
    }),
  tool('get_event', 'read',
    { description: 'One event in full: body, attendees and their responses, organizer, reminder.', inputSchema: { id: z.string().describe('Event id from list_events') } },
    ({ core, mail, cal, json, when, needSend, getThread, awaitingReply, saveAttachments, attachmentsDir }) =>
    async ({ id }) => json(await cal.readEvent(id))),
  tool('free_busy', 'read',
    {
      description: 'Availability of one or more people (anyone in the organisation): busy/tentative/out-of-office blocks, with subjects where you have detail access, plus a merged grid (one char per interval: 0 free, 1 tentative, 2 busy, 3 OOF, 4 no data).',
      inputSchema: {
        emails: z.array(z.string()).min(1),
        start: z.string().optional().describe('Default now'),
        end: z.string().optional().describe('Default start + 1 day'),
        intervalMinutes: z.number().int().min(5).max(1440).optional().describe('Grid interval, default 30'),
        account: accountSchema
      }
    },
    ({ core, mail, cal, json, when, needSend, getThread, awaitingReply, saveAttachments, attachmentsDir }) =>
    async ({ emails, start, end, intervalMinutes, account }) => json(await cal.freeBusy({ account, emails, start: when(start), end: when(end), intervalMinutes }))),
  tool('find_free_slots', 'read',
    {
      description: 'Suggest meeting slots when everyone listed is free: scans the next days inside working hours (local time, weekdays) and returns up to `max` candidate start/end pairs.',
      inputSchema: {
        emails: z.array(z.string()).min(1).describe('Everyone who must be free (include yourself)'),
        durationMinutes: z.number().int().min(5).max(1440).optional().describe('Default 30'),
        start: z.string().optional().describe('Search from (default now)'),
        end: z.string().optional().describe('Search until (default start + 5 days)'),
        hoursFrom: z.number().min(0).max(23).optional().describe('Earliest local hour, default 9'),
        hoursTo: z.number().min(1).max(24).optional().describe('Latest local hour, default 18'),
        weekends: z.boolean().optional(),
        tentativeOk: z.boolean().optional().describe('Treat tentative as free'),
        max: z.number().int().min(1).max(50).optional().describe('Default 10'),
        account: accountSchema
      }
    },
    ({ core, mail, cal, json, when, needSend, getThread, awaitingReply, saveAttachments, attachmentsDir }) =>
    async ({ emails, durationMinutes, start, end, hoursFrom, hoursTo, weekends, tentativeOk, max, account }) =>
      json(await cal.findFreeSlots({ account, emails, durationMinutes, start: when(start), end: when(end), hoursFrom, hoursTo, weekends, tentativeOk, max }))),
  tool('create_event', 'others',
    {
      description: 'Create an appointment on your calendar. With attendees it becomes a meeting and invitations are SENT (needs mcp.allowSend and the user\'s explicit request). Returns the event id.',
      inputSchema: {
        subject: z.string(),
        start: z.string().describe('ISO or natural ("tomorrow 9am")'),
        end: z.string().optional().describe('Default start + durationMinutes (30)'),
        durationMinutes: z.number().int().min(1).optional(),
        allDay: z.boolean().optional(),
        location: z.string().optional(),
        body: z.string().optional().describe('Plain-text description'),
        attendees: z.array(z.string()).optional().describe('Required attendees (emails) — sends invitations'),
        optionalAttendees: z.array(z.string()).optional(),
        reminderMinutes: z.number().int().min(0).optional().describe('Default: none'),
        showAs: z.enum(['Free', 'Tentative', 'Busy', 'OOF', 'WorkingElsewhere']).optional(),
        calendar: z.string().optional().describe('One of your calendars by name/id (default: the default calendar)'),
        account: accountSchema
      }
    },
    ({ core, mail, cal, json, when, needSend, getThread, awaitingReply, saveAttachments, attachmentsDir }) =>
    async ({ subject, start, end, durationMinutes, allDay, location, body, attendees, optionalAttendees, reminderMinutes, showAs, calendar, account }) => {
      const s = cal.parseWhen(start);
      const e = end ? cal.parseWhen(end) : new Date(s.getTime() + (allDay ? 86400e3 : (durationMinutes || 30) * 60e3));
      const invites = (attendees || []).length + (optionalAttendees || []).length > 0;
      if (invites) needSend('create_event with attendees');
      return json(await cal.createEvent({ account, calendar, subject, start: s, end: e, allDay, location, body, attendees: attendees || [], optionalAttendees: optionalAttendees || [], reminderMinutes, showAs, notify: true }));
    },
    { effectFor: (core, { attendees, optionalAttendees }) => ((attendees || []).length + (optionalAttendees || []).length > 0 ? 'others' : 'own-calendar') }),
  tool('update_event', 'others',
    {
      description: 'Change an event (subject, time, location, body, reminder, attendees). For a meeting, attendees are SENT an update (needs mcp.allowSend).',
      inputSchema: {
        id: z.string(),
        subject: z.string().optional(),
        start: z.string().optional(),
        end: z.string().optional(),
        allDay: z.boolean().optional(),
        location: z.string().optional(),
        body: z.string().optional(),
        reminderMinutes: z.number().int().min(-1).optional().describe('-1 removes the reminder'),
        showAs: z.enum(['Free', 'Tentative', 'Busy', 'OOF', 'WorkingElsewhere']).optional(),
        attendees: z.array(z.string()).optional().describe('Replacement required-attendee list'),
        optionalAttendees: z.array(z.string()).optional()
      }
    },
    ({ core, mail, cal, json, when, needSend, getThread, awaitingReply, saveAttachments, attachmentsDir }) =>
    async ({ id, start, end, attendees, optionalAttendees, ...rest }) => {
      const cur = await cal.readEvent(id);
      if (cur.isMeeting || (attendees || []).length || (optionalAttendees || []).length) needSend('update_event on a meeting');
      return json(await cal.updateEvent({ id, start: when(start), end: when(end), attendees, optionalAttendees, ...rest, notify: true }));
    },
    { effectFor: async (core, { id, attendees, optionalAttendees }) => ((attendees || []).length || (optionalAttendees || []).length || (await core.calendar.readEvent(id)).isMeeting ? 'others' : 'own-calendar') }),
  tool('delete_event', 'others',
    {
      description: 'Delete an event (to Deleted Items). As organizer of a meeting this SENDS cancellations (needs mcp.allowSend); as an attendee it just removes it from your calendar.',
      inputSchema: { id: z.string() }
    },
    ({ core, mail, cal, json, when, needSend, getThread, awaitingReply, saveAttachments, attachmentsDir }) =>
    async ({ id }) => {
      const cur = await cal.readEvent(id);
      if (cur.isMeeting) needSend('delete_event on a meeting');
      return json({ ok: await cal.deleteEvent(id, { notify: true }) });
    },
    { effectFor: async (core, { id }) => ((await core.calendar.readEvent(id)).isMeeting ? 'others' : 'own-calendar') }),
  tool('respond_to_event', 'others',
    {
      description: 'Accept, tentatively accept or decline a meeting invitation. The response is SENT to the organizer (needs mcp.allowSend) unless notify is false, which only records it on your calendar.',
      inputSchema: {
        id: z.string(),
        response: z.enum(['accept', 'tentative', 'decline']),
        message: z.string().optional().describe('Note to the organizer'),
        notify: z.boolean().optional().describe('Default true')
      }
    },
    ({ core, mail, cal, json, when, needSend, getThread, awaitingReply, saveAttachments, attachmentsDir }) =>
    async ({ id, response, message, notify }) => {
      const send = notify !== false;
      if (send) needSend('respond_to_event');
      return json({ ok: await cal.respondToEvent(id, response, { message, notify: send }) });
    })
  ];
}

function mimeFor(file) {
  const ext = String(file).toLowerCase().split('.').pop();
  return { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml', pdf: 'application/pdf', txt: 'text/plain', csv: 'text/csv', html: 'text/html', json: 'application/json', zip: 'application/zip' }[ext] || undefined;
}

/** The host of a JMAP account's session URL ('' when it has none to go by). */
function jmapHost(acct) {
  try { return new URL(jmapSessionUrl(acct)).host; } catch { return ''; }
}
