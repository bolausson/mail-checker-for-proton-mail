/**
 * Undo that survives the popup being closed.
 *
 * An extension popup is destroyed on focus loss and returns as a NEW document,
 * so the browser's undo stack starts empty every time. Ctrl+Z after reopening
 * did nothing at all: not for typing, not for an image resize. That is not a
 * regression from any one feature, it is what native undo is.
 *
 * The fix is deliberately a FALLBACK. Native undo knows about word boundaries,
 * IME composition and caret placement, and nothing reimplemented here would
 * match it, so the browser is always asked first. These tests pin that
 * ordering as much as the stepping itself.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const ROOT = join(__dirname, '..');
const SRC = readFileSync(join(ROOT, 'lib', 'editor-history.js'), 'utf-8');
const POPUP = readFileSync(join(ROOT, 'popup', 'popup.js'), 'utf-8');
const H = new Function(SRC + '; return ProtonEditorHistory;')();

/** A fake editor whose native undo can be told what it supports. */
function harness(nativeSteps = 0) {
  const state = { html: '', native: nativeSteps, execCalls: [] };
  const hist = H.create({
    getHtml: () => state.html,
    setHtml: (h) => { state.html = h; },
    exec: (cmd) => {
      state.execCalls.push(cmd);
      if (cmd === 'undo' && state.native > 0) {
        state.native -= 1;
        state.html = state.html + '<native-undo>';
        return true;
      }
      return false;
    },
  });
  return { state, hist };
}

describe('the browser is always asked first', () => {
  it('defers to native undo when it has something to give', () => {
    const { state, hist } = harness(1);
    state.html = 'a';
    hist.record();
    state.html = 'b';
    hist.record();
    expect(hist.undo()).toBe('native');
    expect(state.execCalls).toContain('undo');
  });

  it('falls back to a saved state only once native is exhausted', () => {
    const { state, hist } = harness(0);
    state.html = 'one';
    hist.record();
    state.html = 'two';
    hist.record();
    expect(hist.undo()).toBe('history');
    expect(state.html).toBe('one');
  });

  it('reports none when neither has anything left', () => {
    const { state, hist } = harness(0);
    state.html = 'only';
    hist.record();
    expect(hist.undo()).toBe('none');
    expect(state.html).toBe('only');
  });

  it('judges native success by the markup, not the return value', () => {
    // execCommand can return true having changed nothing, which would strand
    // the user on a Ctrl+Z that does not move.
    const exec = POPUP.slice(POPUP.indexOf('exec: (cmd) =>'), POPUP.indexOf('exec: (cmd) =>') + 320);
    expect(exec).toContain('const before = el.innerHTML');
    expect(exec).toContain('return el.innerHTML !== before');
  });
});

describe('stepping through saved states', () => {
  it('walks back through several', () => {
    const { state, hist } = harness(0);
    for (const h of ['a', 'ab', 'abc']) { state.html = h; hist.record(); }
    expect(hist.undo()).toBe('history');
    expect(state.html).toBe('ab');
    expect(hist.undo()).toBe('history');
    expect(state.html).toBe('a');
    expect(hist.undo()).toBe('none');
  });

  it('redoes back up again', () => {
    const { state, hist } = harness(0);
    for (const h of ['a', 'ab', 'abc']) { state.html = h; hist.record(); }
    hist.undo();
    hist.undo();
    expect(hist.redo()).toBe('history');
    expect(state.html).toBe('ab');
    expect(hist.redo()).toBe('history');
    expect(state.html).toBe('abc');
    expect(hist.redo()).toBe('none');
  });

  it('drops the redo branch once a new edit lands', () => {
    const { state, hist } = harness(0);
    for (const h of ['a', 'ab', 'abc']) { state.html = h; hist.record(); }
    hist.undo();            // back to 'ab'
    state.html = 'abZ';
    hist.record();          // a new branch
    expect(hist.redo()).toBe('none');
    expect(hist.undo()).toBe('history');
    expect(state.html).toBe('ab');
  });

  it('ignores a repeat of the state already showing', () => {
    const { state, hist } = harness(0);
    state.html = 'same';
    expect(hist.record()).toBe(true);
    expect(hist.record()).toBe(false);
    expect(hist.length).toBe(1);
  });
});

describe('surviving the reopen', () => {
  it('adopts saved states with the cursor at the newest', () => {
    // The editor is already showing the newest state, so the first Ctrl+Z has
    // to step BACK from it rather than reapply it.
    const { state, hist } = harness(0);
    hist.restore(['a', 'ab', 'abc']);
    state.html = 'abc';
    expect(hist.index).toBe(2);
    expect(hist.undo()).toBe('history');
    expect(state.html).toBe('ab');
  });

  it('round-trips through serialize', () => {
    const { state, hist } = harness(0);
    for (const h of ['a', 'ab']) { state.html = h; hist.record(); }
    const saved = hist.serialize();
    const fresh = harness(0);
    fresh.hist.restore(saved);
    expect(fresh.hist.undo()).toBe('history');
    expect(fresh.state.html).toBe('a');
  });

  it('shrugs off a missing or malformed history', () => {
    // An older draft has no history at all, and storage can return anything.
    const { hist } = harness(0);
    for (const bad of [undefined, null, 'nope', [1, 2], [{}]]) {
      hist.restore(bad);
      expect(hist.undo()).toBe('none');
    }
  });
});

describe('the draft cannot grow without bound', () => {
  it('skips a state too big to be worth storing', () => {
    // Hit right after a paste, while the image is still an inline data: URI.
    const { state, hist } = harness(0);
    state.html = 'small';
    hist.record();
    state.html = 'x'.repeat(H.MAX_STATE_BYTES + 1);
    expect(hist.record()).toBe(false);
    expect(hist.length).toBe(1);
  });

  it('caps the number of states, dropping the oldest', () => {
    const { state, hist } = harness(0);
    for (let i = 0; i < H.MAX_STATES + 10; i++) { state.html = 'v' + i; hist.record(); }
    expect(hist.length).toBe(H.MAX_STATES);
  });

  it('caps the total size, dropping the oldest', () => {
    const { state, hist } = harness(0);
    const chunk = 'y'.repeat(300 * 1024);
    for (let i = 0; i < 12; i++) { state.html = chunk + i; hist.record(); }
    const total = hist.serialize().reduce((n, s) => n + s.length, 0);
    expect(total).toBeLessThanOrEqual(H.MAX_TOTAL_BYTES);
    expect(hist.length).toBeGreaterThan(0);
  });

  it('keeps the cursor inside the list after trimming', () => {
    // An off-the-end cursor would make the next undo throw or no-op forever.
    const { state, hist } = harness(0);
    for (let i = 0; i < H.MAX_STATES + 5; i++) { state.html = 'v' + i; hist.record(); }
    expect(hist.index).toBeGreaterThanOrEqual(0);
    expect(hist.index).toBeLessThan(hist.length);
  });
});

describe('stepping without touching the browser', () => {
  it('stepBack and stepForward never consult native undo', () => {
    // The popup calls these only AFTER letting the browser have its turn, so
    // they must not take a second one.
    const { state, hist } = harness(5); // native has plenty, and must be unused
    for (const h of ['a', 'ab', 'abc']) { state.html = h; hist.record(); }
    expect(hist.stepBack()).toBe(true);
    expect(state.html).toBe('ab');
    expect(hist.stepForward()).toBe(true);
    expect(state.html).toBe('abc');
    expect(state.execCalls).toEqual([]);
  });

  it('reports when there is nothing left to step to', () => {
    const { state, hist } = harness(0);
    state.html = 'only';
    hist.record();
    expect(hist.stepBack()).toBe(false);
    expect(hist.stepForward()).toBe(false);
  });
});

describe('granularity', () => {
  it('keeps enough steps that a paragraph is not one of them', () => {
    // The first version recorded on the draft-save debounce, so several lines
    // typed without a pause collapsed into ONE step and a single Ctrl+Z threw
    // all of them away.
    expect(H.MAX_STATES).toBeGreaterThanOrEqual(50);
  });

  it('records on a typing pause shorter than the draft debounce', () => {
    // 500ms is when a draft is saved. Undo granularity is a different
    // question and has to be finer, or a step spans everything typed between
    // two pauses.
    expect(H.IDLE_MS).toBeLessThan(500);
    expect(H.IDLE_MS).toBeGreaterThan(100);
  });
});

describe('how the popup wires it up', () => {
  it('is saved with, and restored from, the draft for both editors', () => {
    expect(POPUP).toContain('draft.composeHistory = ch.serialize()');
    expect(POPUP).toContain('draft.replyHistory = rh.serialize()');
    expect(POPUP).toContain('ch.restore(draft.composeHistory)');
    expect(POPUP).toContain('rh.restore(draft.replyHistory)');
  });

  it('does NOT intercept the shortcut', () => {
    // Calling execCommand('undo') by hand quietly does nothing once the DOM
    // has been touched by script, so the coarse fallback ran instead of native
    // undo and swallowed whole paragraphs. Letting the browser handle the key
    // keeps its word-at-a-time granularity, caret placement and IME handling.
    const at = POPUP.indexOf('const isUndo = ');
    expect(at).toBeGreaterThan(-1);
    // Sliced to the end of the handler rather than a fixed length: the fixed
    // window silently fell short once the handler grew, and the assertion
    // below it stopped reaching the code it was meant to check.
    const end = POPUP.indexOf('}, 0);', at);
    expect(end).toBeGreaterThan(at);
    const handler = POPUP.slice(at, end);
    expect(handler).not.toContain('preventDefault');
    expect(handler).toContain('stepBack');
  });

  it('only falls back when the browser changed nothing', () => {
    const at = POPUP.indexOf('const isUndo = ');
    const handler = POPUP.slice(at, POPUP.indexOf('}, 0);', at));
    expect(handler).toContain('const before = el.innerHTML');
    expect(handler).toContain('if (el.innerHTML !== before)');
  });

  it('cancels a pending record when an undo starts', () => {
    // A state recorded mid-undo would become a new branch and discard
    // everything ahead of the cursor.
    const at = POPUP.indexOf('const isUndo = ');
    expect(POPUP.slice(at - 400, at + 400)).toContain('clearTimeout(idle)');
  });

  it('records on a typing pause, not on the draft-save debounce', () => {
    expect(POPUP).toContain('ProtonEditorHistory.IDLE_MS');
  });

  it('handles redo on both of its usual shortcuts', () => {
    expect(POPUP).toContain("(k === 'z' && e.shiftKey) || k === 'y'");
  });

  it('writes restored markup through the sanitising setter, not innerHTML', () => {
    const at = POPUP.indexOf('setHtml: (html) =>');
    expect(POPUP.slice(at, at + 200)).toContain('_setHTML(el, html)');
  });
});
