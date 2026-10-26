import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { z } from 'zod';
import { createMailcore } from '../src/index.js';
import { mailTools, mailInstructions, MAIL_INSTRUCTIONS, EFFECTS } from 'mailcore/tools';

// tools/list of MailWatcher's MCP server (allowSend on) before the tools moved here
const FIXTURE = JSON.parse(fs.readFileSync(new URL('./fixtures/mcp-tools.json', import.meta.url), 'utf8'));
const core = () => createMailcore({ accounts: { work: { provider: 'ews', host: 'https://x', email: 'me@x' } }, credentials: { getPassword: async () => ({ password: 'x' }) }, dataDir: '/nonexistent/mailcore' });

const EXPECTED = {
  list_unread: 'read', search_mail: 'read', read_message: 'read', save_attachments: 'local', get_thread: 'read', awaiting_reply: 'read',
  draft_reply_all: 'draft', draft_reply: 'draft', compose_draft: 'draft', add_attachment: 'draft', update_draft: 'draft', delete_draft: 'draft',
  mark_read: 'local', send_draft: 'others', list_accounts: 'read',
  list_calendars: 'read', list_events: 'read', get_event: 'read', free_busy: 'read', find_free_slots: 'read',
  create_event: 'others', update_event: 'others', delete_event: 'others', respond_to_event: 'others'
};

test('the tools are static: built without a core, the core comes with each call', async () => {
  const tools = mailTools({ allowSend: false });
  const a = core();
  const b = createMailcore({ accounts: { home: { provider: 'imap', email: 'me@home', imap: { host: 'imap.home' } } }, credentials: { getPassword: async () => ({ password: 'x' }) } });
  const list = tools.find((t) => t.name === 'list_accounts');
  assert.deepEqual((await list.run(a, {})).map((x) => x.name), ['work']);
  assert.deepEqual((await list.run(b, {})).map((x) => x.name), ['home']);
  await assert.rejects(tools.find((t) => t.name === 'save_attachments').run(b, { id: 'home:1' }), /pass dir/);
});

test('every tool has a name, a description, a zod object schema, an effect and run()', () => {
  const tools = mailTools({ allowSend: true });
  assert.deepEqual(tools.map((t) => t.name), Object.keys(EXPECTED));
  for (const t of tools) {
    assert.match(t.name, /^[a-z_]+$/, t.name);
    assert.ok(t.description.length > 10, t.name);
    assert.ok(t.input instanceof z.ZodObject, t.name);
    assert.ok(EFFECTS.includes(t.effect), t.name);
    assert.equal(t.effect, EXPECTED[t.name], t.name);
    assert.equal(typeof t.run, 'function', t.name);
  }
});

test('names, descriptions and schemas match the MCP server they came from', () => {
  const tools = mailTools({ allowSend: true, attachmentsLabel: '~/.mailwatcher/attachments' });
  assert.deepEqual(tools.map((t) => t.name), FIXTURE.map((t) => t.name));
  for (const [i, t] of tools.entries()) {
    const f = FIXTURE[i];
    assert.equal(t.description, f.description, t.name);
    const schema = z.toJSONSchema(t.input);
    assert.deepEqual(Object.keys(schema.properties || {}), Object.keys(f.inputSchema.properties || {}), t.name);
    assert.deepEqual(schema.required || [], f.inputSchema.required || [], t.name);
    for (const [k, v] of Object.entries(schema.properties || {})) assert.equal(v.description, f.inputSchema.properties[k].description, `${t.name}.${k}`);
  }
});

test('without allowSend there is no send_draft, and the instructions say sending is off', () => {
  const names = mailTools({ allowSend: false }).map((t) => t.name);
  assert.ok(!names.includes('send_draft'));
  assert.equal(names.length, Object.keys(EXPECTED).length - 1);
  assert.match(mailInstructions({ allowSend: false }), /disabled here \(mcp\.allowSend is off\)/);
  assert.match(mailInstructions({ allowSend: true }), /^mailwatcher: the user's mailboxes/);
  assert.match(mailInstructions({ allowSend: true, name: 'deputy' }), /^deputy: /);
  assert.equal(MAIL_INSTRUCTIONS, mailInstructions({ allowSend: false }));
});

test('effectFor: appointments without attendees are own-calendar; meetings are others', async () => {
  const mc = core();
  let meeting = false;
  mc.calendar.readEvent = async () => ({ isMeeting: meeting });
  const by = Object.fromEntries(mailTools({ allowSend: false }).map((t) => [t.name, t]));
  assert.equal(by.create_event.effectFor(mc, { subject: 's', start: 'now' }), 'own-calendar');
  assert.equal(by.create_event.effectFor(mc, { subject: 's', start: 'now', attendees: ['a@x'] }), 'others');
  assert.equal(by.create_event.effectFor(mc, { subject: 's', start: 'now', optionalAttendees: ['a@x'] }), 'others');
  assert.equal(await by.update_event.effectFor(mc, { id: 'work:1' }), 'own-calendar');
  assert.equal(await by.update_event.effectFor(mc, { id: 'work:1', attendees: ['a@x'] }), 'others');
  assert.equal(await by.delete_event.effectFor(mc, { id: 'work:1' }), 'own-calendar');
  meeting = true;
  assert.equal(await by.update_event.effectFor(mc, { id: 'work:1' }), 'others');
  assert.equal(await by.delete_event.effectFor(mc, { id: 'work:1' }), 'others');
  assert.equal(by.respond_to_event.effectFor, undefined, 'responding always concerns a meeting with others');
});

test('without allowSend, calendar tools refuse before mailing anyone', async () => {
  const mc = core();
  mc.calendar.readEvent = async () => ({ isMeeting: true });
  mc.calendar.createEvent = async () => { throw new Error('must not be reached'); };
  mc.calendar.updateEvent = mc.calendar.deleteEvent = mc.calendar.respondToEvent = mc.calendar.createEvent;
  const by = Object.fromEntries(mailTools({ allowSend: false, sendDisabledHint: 'ask the owner' }).map((t) => [t.name, t]));
  await assert.rejects(by.create_event.run(mc, { subject: 's', start: '2026-11-02 10:00', attendees: ['a@x'] }), /would send mail to other people — disabled: ask the owner/);
  await assert.rejects(by.update_event.run(mc, { id: 'work:1', subject: 'x' }), /would send mail/);
  await assert.rejects(by.delete_event.run(mc, { id: 'work:1' }), /would send mail/);
  await assert.rejects(by.respond_to_event.run(mc, { id: 'work:1', response: 'accept' }), /would send mail/);
});

test('run() returns data; drafts go through the core with prepared bodies', async () => {
  const mc = core();
  const calls = [];
  mc.withClient = async (account, fn) => fn({ draftReply: async (...a) => { calls.push(a); return { draftId: 'work:D', changeKey: 'CK' }; } });
  const by = Object.fromEntries(mailTools().map((t) => [t.name, t]));
  const r = await by.draft_reply.run(mc, { id: 'work:1', body: '**hi**', format: 'markdown' });
  assert.deepEqual(r, { draftId: 'work:D', changeKey: 'CK' });
  assert.equal(calls[0][0], 'work:1');
  assert.match(calls[0][2], /<strong>hi<\/strong>/);
  assert.deepEqual(calls[0][3], { bodyType: 'HTML' });
  const accounts = await by.list_accounts.run(mc, {});
  assert.deepEqual(accounts, [{ name: 'work', provider: 'ews', mail: true, calendar: 'ews', server: 'https://x', email: 'me@x' }]);
});
