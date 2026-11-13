// Compiled (not run) by `npm run typecheck`: the public API as a strict
// NodeNext TypeScript consumer sees it.
import { createMailcore, EventLog, matchRule, parseWhen, type Mailcore, type ListItem, type CredentialsProvider } from 'mailcore';

const credentials: CredentialsProvider = {
  async getPassword(account, { refresh }) {
    return { username: account.username, password: refresh ? 'fresh' : 'cached' };
  },
  google: { get: async () => null, set: async () => {} }
};

const mc: Mailcore = createMailcore({
  accounts: { work: { provider: 'ews', host: 'https://mail.example.org', email: 'me@example.org' } },
  credentials,
  dataDir: '/tmp/mailcore-types',
  cacheKey: ({ create }) => (create ? 'k' : null),
  log: (m) => console.log(m)
});

async function main(): Promise<void> {
  const items: ListItem[] = await mc.find(undefined, { unreadOnly: true, limit: 10 }, (account, e) => console.error(account, e.message));
  const msg = await mc.read(items[0]!.id);
  const body: string = msg.body;
  const draft = await mc.reply(msg.id, 'Thanks', { all: true });
  const id: string | null = draft.draftId;
  const events = await mc.calendar.listEvents({ start: parseWhen('today'), end: '+7d' });
  const slots = await mc.calendar.findFreeSlots({ emails: ['a@example.org'], durationMinutes: 30 });
  const count: number = mc.client.length + events.length + slots.slots.length + body.length + (id ? 1 : 0);
  const w = await mc.watch({ pollSeconds: 30 });
  w.on('mail', ({ account, items }) => {
    const rule = matchRule([{ name: 'boss', senders: 'boss@' }], items[0]!, account);
    console.log(rule?.name, count);
  });
  w.on('calendar', ({ changes }) => changes.filter((c) => c.loud));
  await w.start();
  const log = new EventLog();
  log.append('newmail', { account: 'work', rule: 'boss' });
  const r = await log.wait({ after: 0, timeout: 10, filter: { match: 'all' } });
  for await (const e of log.events({ after: r.cursor })) {
    if (e.gap) console.log('resync, lost', e.lost);
    else console.log(e.seq);
  }
  const cached = mc.cache.findCached(['work'], { fromMe: 'me@example.org', unreadOnly: true });
  const c = await mc.client('work');
  const closed: Promise<void> = c.close();
  await closed;
  console.log(cached.length);
  // what MailWatcher's daemon and panel use
  const flagged = await mc.find('work', { flaggedOnly: true });
  const moved: Map<string, string | null> = await mc.moveItems(flagged.map((i) => i.id), 'archive', { onError: (a, e) => console.error(a, e.message) });
  await mc.setFlag(flagged[0]!.id, false);
  const them = await mc.awaitingThem({ days: 7, memo: new Map(), olderThanHours: 24 });
  const all = await mc.calendar.listAllEvents({ start: new Date(), end: '+7d' });
  const counts: Map<string, number> = mc.cache.threadCounts(flagged);
  const people = mc.people('ann', { limit: 5 });
  const changes = await c.changesIn('inbox', { mark: null });
  const gate = { blocked: () => false, ok: () => {}, failed: (e: Error) => console.error(e.message) };
  await mc.watch({ authGate: () => gate });
  await mc.stream('work', { onNewMail: (how) => console.log(how), onDraftsChange: () => {}, authGate: gate });
  console.log(moved.size, them.threads[0]?.to, all.calendars[0]?.writable, counts.size, people[0]?.n, changes?.reset);
}
void main;

import { mailTools, mailInstructions, MAIL_INSTRUCTIONS, type MailTool, type MailToolEffect } from 'mailcore/tools';
const manifest: MailTool[] = mailTools({ allowSend: false }); // no core needed
const text: string = MAIL_INSTRUCTIONS;
void manifest; void text;
async function tools(core: Mailcore): Promise<void> {
  const list: MailTool[] = mailTools({ allowSend: false });
  for (const t of list) {
    const parsed = t.input.parse({});
    const effect: MailToolEffect = t.effectFor ? await t.effectFor(core, parsed) : t.effect;
    if (effect !== 'others') console.log(t.name, await t.run(core, parsed, { signal: AbortSignal.timeout(1000) }));
  }
  console.log(mailInstructions({ allowSend: false, name: 'deputy' }));
}
void tools;
