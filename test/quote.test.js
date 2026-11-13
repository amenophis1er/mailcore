// Telling what is written in a draft from the thread quoted under it
// (src/body.js): the side panel edits the first and leaves the second alone.

import test from 'node:test';
import assert from 'node:assert/strict';
import { splitQuoted, splitBreaks, replaceAboveQuote } from '../src/index.js';

const SIG = (inner) => `<div class="mw-signature" id="mw-sig-abc123">${inner}</div>`;
const QUOTE = '<div>On Mon, 3 Mar 2025, Jane Doe wrote:</div><blockquote style="margin:0">Hi</blockquote>';
const FORWARD = '<div>---------- Forwarded message ----------<br>From: Jane Doe &lt;jane@example.com&gt;<br>Subject: Numbers</div><br><p>The numbers.</p>';

test('a reply: the text and its signature are the head, the quote the tail', () => {
  const body = `<p>Thursday works.</p>${SIG('<div>Sam</div>')}<br><br>${QUOTE}`;
  const { head, tail } = splitQuoted(body, 'HTML');
  assert.equal(head, `<p>Thursday works.</p>${SIG('<div>Sam</div>')}<br><br>`);
  assert.equal(tail, QUOTE);
});

test('a forward written on an IMAP account: the forwarded mail is the tail', () => {
  const { head, tail } = splitQuoted(`<p>FYI</p>${SIG('<div>Sam</div>')}<br><br>${FORWARD}`, 'HTML');
  assert.equal(head, `<p>FYI</p>${SIG('<div>Sam</div>')}<br><br>`);
  assert.equal(tail, FORWARD);
  assert.equal(splitQuoted('FYI\n\n---------- Forwarded message ----------\nFrom: Jane\n\nThe numbers.\n', 'Text').head, 'FYI\n\n');
});

test('a line of a signature that reads like the start of a quote is not one', () => {
  for (const inner of ['<div>On Monday Alice wrote:</div><div>Ann</div>', '<div><div>On tour, as someone once wrote:</div></div><div>Ann</div>', '<div>__________________<br>From: the desk of Ann</div>']) {
    const body = `<p>Hello</p>${SIG(inner)}<br><br>${QUOTE}`;
    const { head, tail } = splitQuoted(body, 'HTML');
    assert.equal(tail, QUOTE, inner);
    assert.equal(head, `<p>Hello</p>${SIG(inner)}<br><br>`, inner);
  }
  // and with nothing quoted under it, nothing is cut
  assert.deepEqual(splitQuoted(`<p>Hello</p>${SIG('<div>On Monday Alice wrote:</div>')}`, 'HTML'), { head: `<p>Hello</p>${SIG('<div>On Monday Alice wrote:</div>')}`, tail: '' });
});

test('a signature inside the quoted thread (an earlier mail of mine) changes nothing', () => {
  const quoted = `<div>On Mon, 3 Mar 2025, Sam wrote:</div><blockquote>Earlier${SIG('<div>On Monday Alice wrote:</div>')}</blockquote>`;
  const { head, tail } = splitQuoted(`<p>New text</p><br><br>${quoted}`, 'HTML');
  assert.equal(head, '<p>New text</p><br><br>');
  assert.equal(tail, quoted);
});

test('a signature that is never closed is not stepped over', () => {
  const body = `<p>Hello</p><div id="mw-sig-abc123"><div>On Monday Alice wrote:</div>`;
  assert.equal(splitQuoted(body, 'HTML').head, '<p>Hello</p><div id="mw-sig-abc123">');
});

test('the breaks a text ends with are told from the text', () => {
  assert.deepEqual(splitBreaks('<p>Hi</p><br><br>'), { text: '<p>Hi</p>', breaks: '<br><br>' });
  assert.deepEqual(splitBreaks('<p>Hi</p> <br/>\n<BR >  '), { text: '<p>Hi</p>', breaks: ' <br/>\n<BR >  ' });
  assert.deepEqual(splitBreaks('<p>Hi<br></p>'), { text: '<p>Hi<br></p>', breaks: '' });
  assert.deepEqual(splitBreaks('<br>'), { text: '', breaks: '<br>' });
  assert.deepEqual(splitBreaks(''), { text: '', breaks: '' });
  assert.deepEqual(splitBreaks(`${' '.repeat(200_000)}x`), { text: `${' '.repeat(200_000)}x`, breaks: '' }); // and quickly
});

test('saving again above a quote: once, with the same space before the quote, however often', () => {
  let body = `<p>One</p>${SIG('<div>Sam</div>')}<br><br>${QUOTE}`;
  for (const text of ['<p>Two</p>', '<p>Three</p><br>', '<p>Four</p>']) {
    body = replaceAboveQuote({ body: `${text}${SIG('<div>On Monday Alice wrote:</div><div>Sam</div>')}`, bodyType: 'HTML' }, body, 'HTML').body;
    assert.equal(body.split('mw-sig-abc123').length - 1, 1, body);
    assert.equal(body.split('wrote:</div><blockquote').length - 1, 1, body);
  }
  assert.equal(body, `<p>Four</p>${SIG('<div>On Monday Alice wrote:</div><div>Sam</div>')}<br><br>${QUOTE}`);
});

test('a quote typed in the text is text: only a quote that is not from the editor starts the thread', () => {
  const typed = '<p>You said:</p><blockquote class="mw-quote"><p>ship it Friday</p></blockquote><p>I agree.</p>';
  let body = `${typed}${SIG('<div>Sam</div>')}<br><br>${QUOTE}`;
  assert.equal(splitQuoted(body, 'HTML').head, `${typed}${SIG('<div>Sam</div>')}<br><br>`);
  for (let i = 0; i < 3; i++) body = replaceAboveQuote({ body: `${typed}${SIG('<div>Sam</div>')}`, bodyType: 'HTML' }, body, 'HTML').body;
  assert.equal(body, `${typed}${SIG('<div>Sam</div>')}<br><br>${QUOTE}`); // saved three times: still once
  // a new mail with a typed quote has no thread under it at all
  assert.deepEqual(splitQuoted(`${typed}${SIG('<div>Sam</div>')}`, 'HTML'), { head: `${typed}${SIG('<div>Sam</div>')}`, tail: '' });
  // any other <blockquote> is still where a thread begins
  assert.equal(splitQuoted('<p>Hi</p><blockquote><p>earlier</p></blockquote>', 'HTML').head, '<p>Hi</p>');
  assert.equal(splitQuoted(`<p>Hi</p><div id='mw-sig-abc123'><div>On Monday Alice wrote:</div></div><blockquote>earlier</blockquote>`, 'HTML').tail, '<blockquote>earlier</blockquote>');
});
