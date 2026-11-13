// The IMAP backend's moves and its push stream's auth gate, against a stand-in
// for imapflow's connection (no network).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ImapClient } from '../src/imap.js';
import { ImapStream } from '../src/imap-stream.js';

const ACCT = { name: 'home', provider: 'imap', email: 'me@home.invalid', imap: { host: '127.0.0.1' } };

/** An ImapClient whose connection is a fake: folders and their UIDVALIDITY, and what MOVE does. */
function fakeClient({ validity = { INBOX: '999', Spam: '5' }, move }) {
  const c = new ImapClient(ACCT, { username: 'me', password: 'x' });
  const moves = [];
  const conn = {
    usable: true,
    mailbox: null,
    async getMailboxLock(path) { conn.mailbox = { path, uidValidity: BigInt(validity[path]) }; return { release() { conn.mailbox = null; } }; },
    async messageMove(range, dest) { moves.push([conn.mailbox.path, range, dest]); return move(conn.mailbox.path, range); }
  };
  c.client = conn;
  c.folderMap = { inbox: 'INBOX', archive: 'Archive', junk: 'Spam', sent: 'Sent', drafts: 'Drafts', trash: 'Trash' };
  return { c, moves };
}

test('moveItems: an id of an earlier generation of the mailbox is gone, and its number is not moved', async () => {
  const { c, moves } = fakeClient({ move: (path, range) => ({ uidValidity: 77n, uidMap: new Map(range.split(',').map((u) => [Number(u), Number(u) + 100])) }) });
  const out = await c.moveItems(['INBOX/111/7', 'INBOX/999/8'], 'archive');
  assert.deepEqual(moves, [['INBOX', '8', 'Archive']]); // never UID 7 of generation 999
  assert.deepEqual([...out], [['INBOX/111/7', null], ['INBOX/999/8', 'Archive/77/108']]);
});

test('moveItems: a folder whose move fails does not lose what another folder moved', async () => {
  const fail = new Error('NO [CANNOT] move refused');
  const { c } = fakeClient({ move: (path) => { if (path === 'Spam') throw fail; return { uidValidity: 77n, uidMap: new Map([[8, 108]]) }; } });
  const out = await c.moveItems(['INBOX/999/8', 'Spam/5/3'], 'archive');
  assert.deepEqual([...out], [['INBOX/999/8', 'Archive/77/108']]); // Spam/5/3 left out: not moved
  await assert.rejects(c.moveItems(['Spam/5/3'], 'archive'), (e) => e === fail); // nothing moved: the error is the answer
});

test('the IDLE loop waits while the auth gate is blocked, then signs in with fresh credentials and says how it went', async () => {
  let blocked = true;
  const heard = [];
  const gate = { blocked: () => blocked, ok: () => heard.push('ok'), failed: (e) => heard.push('failed:' + e.code) };
  let refreshed = 0;
  const s = new ImapStream({ account: { ...ACCT, imap: { ...ACCT.imap, askSeconds: 0 } }, creds: {}, onNewMail() {}, refreshCreds: async () => { refreshed++; return { password: 'new' }; }, authGate: gate });
  s.pauseMs = 5;
  let holds = 0;
  s.holdOnce = async (onConnected) => {
    holds++;
    if (holds === 1) { onConnected(); s.stopped = true; return; } // connected once, then stopped
  };
  s.start();
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(holds, 0, 'nothing signs in while blocked');
  blocked = false;
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(holds, 1);
  assert.equal(refreshed, 1, 'the pause ended: the stored credentials are read again');
  assert.deepEqual(heard, ['ok']);
  s.stop();

  // rejected, refreshed, rejected again: the gate hears of it
  const s2 = new ImapStream({ account: { ...ACCT, imap: { ...ACCT.imap, askSeconds: 0 } }, creds: {}, onNewMail() {}, refreshCreds: async () => ({ password: 'x' }), authGate: { blocked: () => false, ok() {}, failed: (e) => { heard.push('failed:' + e.code); s2.stop(); } }, log() {} });
  s2.holdOnce = async () => { throw Object.assign(new Error('AUTHENTICATIONFAILED'), { code: 'MAIL_AUTH' }); };
  const realSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (fn, ms) => realSetTimeout(fn, Math.min(ms, 1)); // the retry delay, made short
  try {
    s2.start();
    await new Promise((r) => realSetTimeout(r, 30));
  } finally { globalThis.setTimeout = realSetTimeout; }
  assert.deepEqual(heard, ['ok', 'failed:MAIL_AUTH']);
});
