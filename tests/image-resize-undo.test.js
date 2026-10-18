/**
 * @vitest-environment jsdom
 *
 * Making a resize undoable, and making it survive the popup closing.
 *
 * UNDO. Attribute and style writes made from script are invisible to
 * contenteditable undo. A resize done the obvious way is therefore skipped by
 * Ctrl+Z, which reaches back past it and undoes whatever was typed before,
 * which is worse than doing nothing. A private stack is not an option either:
 * two stacks racing for the same shortcut cannot be ordered against each
 * other. So the size is re-applied through execCommand, which the browser
 * records, and the element is rewound first so the entry has a real "before".
 *
 * PERSISTENCE. The popup is destroyed when it loses focus. Nothing extra is
 * needed for the resize to survive: it is a plain DOM mutation, both editors
 * autosave on input, and pagehide/visibilitychange flush by snapshotting the
 * live DOM. These tests pin that chain so a later change cannot quietly break
 * it, since the failure would only show up as a lost edit.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const ROOT = join(__dirname, '..');
const SRC = readFileSync(join(ROOT, 'lib', 'image-resize.js'), 'utf-8');
const POPUP = readFileSync(join(ROOT, 'popup', 'popup.js'), 'utf-8');
const R = new Function(SRC + '; return ProtonImageResize;')();

function editorWithImage() {
  document.body.innerHTML = '<div id="ed" contenteditable="true">' +
    '<img src="data:image/png;base64,AAA" width="200" height="100" ' +
    'style="width:200px;height:100px">' +
    '</div>';
  return { editor: document.getElementById('ed'), img: document.querySelector('img') };
}

/** Stand in for execCommand('insertHTML'), which jsdom does not implement. */
function fakeInsertHTML(returnValue = true) {
  const calls = [];
  document.execCommand = (cmd, ui, value) => {
    calls.push({ cmd, value });
    if (cmd !== 'insertHTML') return true;
    if (!returnValue) return false;
    const sel = window.getSelection();
    const range = sel.getRangeAt(0);
    range.deleteContents();
    const tpl = document.createElement('template');
    tpl.innerHTML = value;
    range.insertNode(tpl.content);
    return true;
  };
  return calls;
}

beforeEach(() => { document.body.innerHTML = ''; });

describe('committing a drag onto the native undo stack', () => {
  it('routes the final size through execCommand, not a direct write', () => {
    const { img } = editorWithImage();
    const calls = fakeInsertHTML();
    R.commitResize(img, { width: 200, height: 100 }, { width: 300, height: 150 });
    expect(calls.some((c) => c.cmd === 'insertHTML')).toBe(true);
  });

  it('rewinds to the start size before recording, so undo has a "before"', () => {
    // Without the rewind the undo entry captures the ALREADY-resized element
    // and Ctrl+Z appears to do nothing at all.
    const { img } = editorWithImage();
    let widthAtCommand = null;
    document.execCommand = (cmd) => {
      if (cmd === 'insertHTML') widthAtCommand = img.getAttribute('width');
      return true;
    };
    // Simulate the live drag having already written the new size.
    R.applySize(img, { width: 300, height: 150 });
    R.commitResize(img, { width: 200, height: 100 }, { width: 300, height: 150 });
    expect(widthAtCommand).toBe('200');
  });

  it('produces exactly one command per drag, not one per pointer move', () => {
    const { img } = editorWithImage();
    const calls = fakeInsertHTML();
    // A real drag writes directly many times...
    for (let w = 210; w <= 300; w += 10) R.applySize(img, { width: w, height: w / 2 });
    // ...and commits once.
    R.commitResize(img, { width: 200, height: 100 }, { width: 300, height: 150 });
    expect(calls.filter((c) => c.cmd === 'insertHTML')).toHaveLength(1);
  });

  it('the inserted image carries the final size', () => {
    const { img } = editorWithImage();
    fakeInsertHTML();
    const out = R.commitResize(img, { width: 200, height: 100 }, { width: 300, height: 150 });
    expect(out.getAttribute('width')).toBe('300');
    expect(out.getAttribute('height')).toBe('150');
    expect(out.style.width).toBe('300px');
  });

  it('leaves no marker attribute behind in the document', () => {
    // The marker exists only to find the replacement again. If it survived it
    // would be saved into the draft and mailed to the recipient.
    const { editor, img } = editorWithImage();
    fakeInsertHTML();
    R.commitResize(img, { width: 200, height: 100 }, { width: 300, height: 150 });
    expect(editor.innerHTML).not.toContain('data-pir-new');
    expect(document.querySelectorAll('[data-pir-new]')).toHaveLength(0);
  });

  it('does nothing at all when the size did not change', () => {
    const { img } = editorWithImage();
    const calls = fakeInsertHTML();
    R.commitResize(img, { width: 200, height: 100 }, { width: 200, height: 100 });
    expect(calls.filter((c) => c.cmd === 'insertHTML')).toHaveLength(0);
  });
});

describe('a lost resize is worse than a lost undo', () => {
  it('falls back to a direct write when execCommand refuses', () => {
    // Otherwise the rewind would be left showing and the drag would look like
    // it silently reverted.
    const { img } = editorWithImage();
    fakeInsertHTML(false);
    const out = R.commitResize(img, { width: 200, height: 100 }, { width: 300, height: 150 });
    expect(out.getAttribute('width')).toBe('300');
    expect(out.style.width).toBe('300px');
  });

  it('falls back when execCommand throws', () => {
    const { img } = editorWithImage();
    document.execCommand = () => { throw new Error('nope'); };
    const out = R.commitResize(img, { width: 200, height: 100 }, { width: 300, height: 150 });
    expect(out.getAttribute('width')).toBe('300');
  });

  it('falls back when the document has no execCommand', () => {
    const { img } = editorWithImage();
    delete document.execCommand;
    const out = R.commitResize(img, { width: 200, height: 100 }, { width: 300, height: 150 });
    expect(out.getAttribute('width')).toBe('300');
  });
});

describe('the drag itself stays off the undo stack', () => {
  it('pointer moves write directly rather than through execCommand', () => {
    // One drag must not leave a hundred entries the user has to press Ctrl+Z
    // through one at a time.
    const move = SRC.slice(SRC.indexOf('function onGripMove'), SRC.indexOf('function onGripUp'));
    expect(move).toContain('applySize(selected, drag.lastSize)');
    // The CALL form, not the bare word: the handler's own comment explains why
    // it does not use execCommand, and matching that would pass vacuously.
    expect(move).not.toContain('execCommand(');
  });

  it('a grip click that never moved commits nothing', () => {
    const up = SRC.slice(SRC.indexOf('function onGripUp'), SRC.indexOf('// Typing anywhere'));
    expect(up).toContain('if (!finished.lastSize) return');
  });
});

describe('surviving the popup being closed', () => {
  it('the editors autosave on input', () => {
    const at = POPUP.indexOf('Auto-save draft on input in compose/reply fields');
    expect(at).toBeGreaterThan(-1);
    const block = POPUP.slice(at, at + 400);
    expect(block).toContain('composeBody');
    expect(block).toContain('replyBody');
    expect(block).toContain("addEventListener('input', _scheduleDraftSave)");
  });

  it('a finished drag fires input, which a script write does not do by itself', () => {
    expect(SRC).toContain("dispatchEvent(new Event('input'");
  });

  it('closing flushes by snapshotting the live DOM, not a queued value', () => {
    // This is what makes a resize survive even if it happened inside the 500ms
    // debounce window, and even mid-drag.
    expect(POPUP).toContain("window.addEventListener('pagehide', _flushDrafts)");
    expect(POPUP).toContain("document.addEventListener('visibilitychange'");
    expect(POPUP).toContain("if (document.visibilityState === 'hidden') _flushDrafts()");
  });

  it('the saved draft is the editor markup, so sizes ride along', () => {
    expect(POPUP).toContain('draft.composeBody = composeBody.innerHTML');
  });

  it('restoring a draft preserves attributes and inline styles', () => {
    // _setHTML is a plain DOMParser round-trip: no sanitiser strips width,
    // height or style on the way back in.
    const at = POPUP.indexOf('function _setHTML');
    const fn = POPUP.slice(at, at + 220);
    expect(fn).toContain('DOMParser');
    expect(fn).toContain('replaceChildren');
  });
});

describe('nothing the resizer does can reach the outgoing mail', () => {
  it('never marks the image with a class', () => {
    // The image lives INSIDE the contenteditable, which is serialised straight
    // out of innerHTML for both the draft and the send. A selection class on
    // it would be saved and mailed to the recipient. Selection is tracked in a
    // variable and shown by the overlay alone.
    expect(SRC).not.toContain('pir-selected');
    expect(SRC).not.toContain('selected.classList');
  });

  it('sweeps every stray commit marker, not just the one it found', () => {
    // If the lookup missed it, the attribute would stay in the editable
    // subtree and ship with the message.
    const commit = SRC.slice(SRC.indexOf('function commitResize'), SRC.indexOf('* Wire drag-to-resize'));
    expect(commit).toContain('querySelectorAll');
    expect(commit).toContain('removeAttribute(MARK)');
  });

  it('leaves the editor markup carrying only real size information', () => {
    const { editor, img } = editorWithImage();
    fakeInsertHTML();
    R.commitResize(img, { width: 200, height: 100 }, { width: 300, height: 150 });
    const html = editor.innerHTML;
    expect(html).not.toContain('pir-');
    expect(html).not.toContain('data-pir');
    expect(html).toContain('width="300"');
  });
});
