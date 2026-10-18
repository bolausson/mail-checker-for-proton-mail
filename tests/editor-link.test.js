/**
 * @vitest-environment jsdom
 *
 * The editor toolbar's link button.
 *
 * Two defects, both pre-dating the move off window.prompt but both easy to fix
 * once the dialog was ours:
 *
 *  - Clicking into an existing link and pressing the button offered an EMPTY
 *    box, so the address had to be retyped from memory to change it. Worse, the
 *    resulting execCommand('createLink') did nothing at all, because the
 *    selection was a caret rather than a range.
 *  - With no selection and no link under the caret, the button was a silent
 *    no-op for the same reason.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const SRC = readFileSync(join(__dirname, '..', 'popup', 'editor-toolbar.js'), 'utf-8');

function lift(name) {
  const start = SRC.search(new RegExp('(async )?function ' + name + '\\('));
  if (start === -1) throw new Error('not found: ' + name);
  let i = SRC.indexOf('{', start);
  let depth = 0;
  for (; i < SRC.length; i++) {
    if (SRC[i] === '{') depth++;
    else if (SRC[i] === '}') { depth--; if (depth === 0) return SRC.slice(start, i + 1); }
  }
  throw new Error('unbalanced braces reading ' + name);
}

const anchorAt = new Function(lift('_anchorAt') + '\nreturn _anchorAt;')();
const unwrap = new Function(lift('_unwrap') + '\nreturn _unwrap;')();
const escapeAttr = new Function(lift('_escapeAttr') + '\nreturn _escapeAttr;')();
const escapeText = new Function(lift('_escapeText') + '\nreturn _escapeText;')();

let editor;
beforeEach(() => {
  document.body.innerHTML = '<div id="ed" contenteditable></div>';
  editor = document.getElementById('ed');
});

function caretIn(node, offset = 0) {
  const r = document.createRange();
  r.setStart(node, offset);
  r.collapse(true);
  return r;
}

describe('finding the link under the caret', () => {
  it('finds it when the caret is inside the link text', () => {
    editor.innerHTML = '<p>see <a href="https://example.test">this link</a> now</p>';
    const a = editor.querySelector('a');
    expect(anchorAt(caretIn(a.firstChild, 3), editor)).toBe(a);
  });

  it('finds it from a nested element inside the link', () => {
    editor.innerHTML = '<a href="https://x.test"><b>bold link</b></a>';
    const b = editor.querySelector('b');
    expect(anchorAt(caretIn(b.firstChild, 2), editor)).toBe(editor.querySelector('a'));
  });

  it('returns null when the caret is plain text', () => {
    editor.innerHTML = '<p>no link here</p>';
    expect(anchorAt(caretIn(editor.querySelector('p').firstChild, 4), editor)).toBeNull();
  });

  it('ignores a link outside the editor, which must never be editable', () => {
    document.body.insertAdjacentHTML('beforeend', '<a href="https://elsewhere.test" id="out">x</a>');
    const outside = document.getElementById('out');
    expect(anchorAt(caretIn(outside.firstChild, 0), editor)).toBeNull();
  });

  it('survives a missing range', () => {
    expect(anchorAt(null, editor)).toBeNull();
  });

  it('ignores an anchor with no href, which is not a link', () => {
    editor.innerHTML = '<a name="anchor">target</a>';
    const a = editor.querySelector('a');
    expect(anchorAt(caretIn(a.firstChild, 1), editor)).toBeNull();
  });
});

describe('removing a link', () => {
  it('keeps the text and drops only the anchor', () => {
    editor.innerHTML = '<p>see <a href="https://x.test">this link</a> now</p>';
    unwrap(editor.querySelector('a'));
    expect(editor.querySelector('a')).toBeNull();
    expect(editor.textContent).toBe('see this link now');
  });

  it('keeps nested formatting', () => {
    editor.innerHTML = '<a href="https://x.test"><b>bold</b> and <i>italic</i></a>';
    unwrap(editor.querySelector('a'));
    expect(editor.querySelector('a')).toBeNull();
    expect(editor.querySelector('b')).not.toBeNull();
    expect(editor.querySelector('i')).not.toBeNull();
  });
});

describe('inserting a bare address safely', () => {
  it('escapes quotes and angle brackets in the attribute', () => {
    expect(escapeAttr('https://x.test/"onmouseover="alert(1)'))
      .toBe('https://x.test/&quot;onmouseover=&quot;alert(1)');
    expect(escapeAttr('a<b>c')).toBe('a&lt;b&gt;c');
  });

  it('escapes the visible text too', () => {
    expect(escapeText('<script>')).toBe('&lt;script&gt;');
    expect(escapeText('a&b')).toBe('a&amp;b');
  });

  it('escapes ampersands first, so entities are not double-broken', () => {
    expect(escapeAttr('?a=1&b=2')).toBe('?a=1&amp;b=2');
  });

  it('produces markup that parses back to a single harmless link', () => {
    const evil = 'https://x.test/"><img src=x onerror=alert(1)>';
    const html = '<a href="' + escapeAttr(evil) + '">' + escapeText(evil) + '</a>';
    const el = document.createElement('div');
    el.innerHTML = html;
    expect(el.querySelectorAll('a')).toHaveLength(1);
    expect(el.querySelector('img')).toBeNull();
    expect(el.querySelector('a').getAttribute('href')).toBe(evil);
  });
});

describe('the handler wires those cases up', () => {
  const handler = SRC.slice(SRC.indexOf("if (cmd === 'createLink')"), SRC.indexOf("} else if (cmd === 'formatBlock'"));

  it('pre-fills the dialog with the existing address', () => {
    expect(handler).toMatch(/value: anchor \? anchor\.getAttribute\('href'\)/);
  });

  it('updates the anchor directly rather than via execCommand', () => {
    // createLink on a collapsed selection does nothing, which is why editing a
    // link appeared to silently fail.
    expect(handler).toMatch(/anchor\.setAttribute\('href', href\)/);
  });

  it('an emptied address removes the link instead of leaving a dead one', () => {
    // Now guarded by an explicit empty-address branch rather than a trailing
    // else, since the dialog also carries a text field that may be filled in.
    expect(handler).toMatch(/if \(!href\) \{/);
    expect(handler).toMatch(/_unwrap\(anchor\)/);
  });

  it('distinguishes cancel from an empty string', () => {
    // The dialog resolves null when dismissed; '' means "the user cleared it".
    // Reads `result` rather than `url` since it now returns both fields.
    expect(handler).toMatch(/if \(result !== null\)/);
  });

  it('inserts a link whether or not anything was selected', () => {
    // One insertHTML covers both: with a selection it replaces it, which is
    // what lets the chosen text become the link; with a caret it just inserts.
    expect(handler).toMatch(/insertHTML/);
  });

  it('escapes what it injects as HTML', () => {
    // The link TEXT is user input landing in innerHTML too, not just the href.
    expect(handler).toMatch(/_escapeAttr\(href\)/);
    expect(handler).toMatch(/_escapeText\(text \|\| href\)/);
  });
});
