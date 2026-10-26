import { test } from 'node:test';
import assert from 'node:assert/strict';
import { prepareBody, splitQuoted, replaceAboveQuote, htmlToText, escapeHtml } from '../src/index.js';

test('plain text stays text', () => {
  assert.deepEqual(prepareBody('a < b', 'text'), { body: 'a < b', bodyType: 'Text' });
});

test('markdown becomes styled HTML', () => {
  const r = prepareBody('**hi** there\n\n- a\n- b', 'markdown');
  assert.equal(r.bodyType, 'HTML');
  assert.match(r.body, /<strong>hi<\/strong> there/);
  assert.match(r.body, /<li>a<\/li><li>b<\/li>/);
});

test('escapeHtml escapes markup', () => {
  assert.equal(escapeHtml('<a href="x">&</a>'), '&lt;a href=&quot;x&quot;&gt;&amp;&lt;/a&gt;');
});

test('splitQuoted finds the quoted thread of a reply', () => {
  const r = splitQuoted('new text\n\nOn Mon, Jan 1, 2026 at 9:00 Bob wrote:\n> old', 'Text');
  assert.equal(r.head, 'new text\n\n');
  assert.equal(r.tail, 'On Mon, Jan 1, 2026 at 9:00 Bob wrote:\n> old');
});

test('replaceAboveQuote keeps the quoted thread', () => {
  const r = replaceAboveQuote({ body: 'fresh', bodyType: 'Text' }, 'draft\n\nOn Mon, Jan 1, 2026 at 9:00 Bob wrote:\n> old', 'Text');
  assert.equal(r.bodyType, 'Text');
  assert.equal(r.body, 'fresh\n\nOn Mon, Jan 1, 2026 at 9:00 Bob wrote:\n> old');
});

test('htmlToText drops tags and decodes entities once', () => {
  assert.equal(htmlToText('<head><title>t</title></head><p>Hello &amp; welcome</p><br><div>x</div>'), 'Hello & welcome\n\nx');
  assert.equal(htmlToText('<style>p{}</style>a&amp;lt;b'), 'a&lt;b');
});
