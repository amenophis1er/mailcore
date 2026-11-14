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

test('previewText reads entities written in a text part and drops invisible preheader padding', async () => {
  const { previewText } = await import('../src/text.js');
  const uber = 'Plus, get $0 Delivery Fee on eligible orders. &#847; &#8204; &#847; &#8204; &#847;&zwnj; Order now [https://click.example/x]';
  assert.equal(previewText(uber), 'Plus, get $0 Delivery Fee on eligible orders. Order now');
  assert.equal(previewText('<p>Caf&eacute; &amp; more&#x200B;</p>\n<p>͏­ ok</p>'), 'Caf&eacute; & more ok');
  assert.equal(previewText('Tom &amp; Jerry'), 'Tom & Jerry');
  assert.equal(previewText('<p>Use &amp;lt;b&amp;gt; for bold</p>'), 'Use &lt;b&gt; for bold', 'decoded once');
  assert.equal(previewText('Engineer \u{1F469}\u200d\u{1F4BB} available, \u0645\u06cc\u200c\u0631\u0648\u0645'), 'Engineer \u{1F469}\u200d\u{1F4BB} available, \u0645\u06cc\u200c\u0631\u0648\u0645', 'joiners inside words stay');
  assert.equal(previewText('x'.repeat(300)).length, 180);
});
