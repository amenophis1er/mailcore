import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ruleMatches, matchRule, accountOk, inQuietHours, splitList } from '../src/index.js';

const item = { fromName: 'Ann Smith', fromEmail: 'ann@bank.example', subject: 'Your statement is ready' };

test('splitList splits on commas, semicolons and newlines, lower-cased', () => {
  assert.deepEqual(splitList(' A, b;C\n\n'), ['a', 'b', 'c']);
});

test('senders match name or address; both lists must match', () => {
  assert.equal(ruleMatches({ senders: 'bank.example' }, item), true);
  assert.equal(ruleMatches({ senders: ['nobody', 'ann smith'] }, item), true);
  assert.equal(ruleMatches({ senders: 'bank', subjects: 'invoice' }, item), false);
  assert.equal(ruleMatches({ senders: 'bank', subjects: 'statement' }, item), true);
  assert.equal(ruleMatches({}, item), false, 'an empty rule matches nothing');
});

test('rule.account scopes a rule', () => {
  assert.equal(accountOk({}, 'work'), true);
  assert.equal(accountOk({ account: 'work, home' }, 'home'), true);
  assert.equal(accountOk({ account: ['work'] }, 'home'), false);
  const rules = [{ name: 'off', enabled: false, senders: 'ann' }, { name: 'home only', account: 'home', senders: 'ann' }, { name: 'any', subjects: 'statement' }];
  assert.equal(matchRule(rules, item, 'work').name, 'any');
  assert.equal(matchRule(rules, item, 'home').name, 'home only');
  assert.equal(matchRule([], item, 'home'), null);
});

test('quiet hours, including a window over midnight', () => {
  const now = new Date();
  const hm = (d) => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  const before = new Date(now.getTime() - 30 * 60e3);
  const after = new Date(now.getTime() + 30 * 60e3);
  assert.equal(inQuietHours({ enabled: false, start: hm(before), end: hm(after) }), false);
  assert.equal(inQuietHours({ enabled: true, start: hm(before), end: hm(after) }), true);
  assert.equal(inQuietHours({ enabled: true, start: hm(after), end: hm(before) }), false);
});
