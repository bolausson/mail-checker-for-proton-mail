/**
 * Where the reply editor is scrolled when it opens.
 *
 * The caret was already being placed at position 0 so the user types above the
 * quote. That was not enough: focus() restores the editor's previous scroll
 * position, which with a long quoted message is the very bottom, and moving the
 * selection does not scroll back. Opening a reply showed the sender's footer
 * with the place to type somewhere off-screen above.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const SRC = readFileSync(join(__dirname, '..', 'popup', 'popup.js'), 'utf-8');

/** The block that runs shortly after the reply editor is revealed. */
function focusBlock() {
  const at = SRC.indexOf('const el = replyHtml ? replyBody : replyText;');
  expect(at, 'reply focus block not found').toBeGreaterThan(-1);
  const end = SRC.indexOf('}, 50);', at);
  expect(end, 'end of the reply focus block not found').toBeGreaterThan(at);
  return SRC.slice(at, end);
}

describe('opening a reply', () => {
  it('scrolls the editor back to the top', () => {
    expect(focusBlock()).toMatch(/el\.scrollTop\s*=\s*0/);
  });

  it('does so after focusing, not before', () => {
    // focus() is what moves the scroll position, so resetting it first would be
    // undone immediately.
    const b = focusBlock();
    expect(b.indexOf('el.scrollTop')).toBeGreaterThan(b.indexOf('el.focus()'));
  });

  it('still puts the caret above the quote in both editor modes', () => {
    const b = focusBlock();
    expect(b).toMatch(/setStart\(replyBody, 0\)/);   // html
    expect(b).toMatch(/setSelectionRange\(0, 0\)/);  // plain text
  });
});
