/**
 * Undo history that survives the popup being closed.
 *
 * An extension popup is destroyed the moment it loses focus, and it comes back
 * as a BRAND NEW document. The browser's own undo stack belongs to that
 * document, so it starts empty every time: after reopening, Ctrl+Z did nothing
 * at all, for typing as much as for an image resize. Nothing can keep the
 * native stack alive across that, so the only way to offer undo afterwards is
 * to have saved the states ourselves.
 *
 * This is deliberately a FALLBACK, not a replacement. Native undo is better
 * than anything reimplemented here: it knows about word boundaries, IME
 * composition and caret placement. So undo() asks the browser first and only
 * steps through saved states when the browser says it has nothing left. In
 * practice that means the native stack covers edits made since the popup
 * opened, and this covers everything before it.
 *
 * States are whole snapshots of the editor markup, which is the only form that
 * survives serialisation into the draft. That is affordable because a saved
 * draft references its images as `cid:` parts rather than inline data: URIs,
 * so a snapshot is normally a few kilobytes. Right after a paste it can be
 * megabytes, which is what the size budget is for: an oversized state is
 * skipped rather than stored, and undo simply has one fewer step.
 */
const ProtonEditorHistory = (() => {
  'use strict';

  // Deep enough to be useful, shallow enough that the draft stays small.
  // Raised once it was clear how coarse the first version felt: recording only
  // on the draft-save debounce meant several lines typed without a pause
  // collapsed into ONE step, and a single Ctrl+Z threw all of them away.
  const MAX_STATES = 80;
  // Idle gap after the last keystroke before a state is recorded. Short enough
  // to break a paragraph into several steps, long enough not to store one per
  // character. Deliberately NOT tied to the draft-save debounce: they answer
  // different questions.
  const IDLE_MS = 400;
  // A single snapshot bigger than this is not recorded. Hit when an image has
  // just been pasted and is still an inline data: URI.
  const MAX_STATE_BYTES = 512 * 1024;
  // Total across all states, so a long editing session cannot grow the draft
  // without bound.
  const MAX_TOTAL_BYTES = 2 * 1024 * 1024;

  /**
   * @param {object} opts
   *   getHtml  - read the editor's current markup
   *   setHtml  - write markup back (the caller's own sanitising setter)
   *   exec     - run a native editing command, returning whether it changed
   *              anything. Injected so it can be tested without a browser.
   */
  function create(opts) {
    const o = opts || {};
    const getHtml = o.getHtml || (() => '');
    const setHtml = o.setHtml || (() => {});
    const exec = o.exec || (() => false);

    let states = [];
    let cursor = -1; // index of the state the editor is currently showing

    const size = (s) => (s ? s.length : 0);

    function trim() {
      if (states.length > MAX_STATES) {
        const drop = states.length - MAX_STATES;
        states.splice(0, drop);
        cursor -= drop;
      }
      let total = states.reduce((n, s) => n + size(s), 0);
      // Oldest first: the far end of the history is the least valuable.
      while (states.length > 1 && total > MAX_TOTAL_BYTES) {
        total -= size(states[0]);
        states.shift();
        cursor -= 1;
      }
      if (cursor < 0) cursor = states.length ? 0 : -1;
    }

    /** Record the current markup, if it is new and not too big. */
    function record() {
      const html = getHtml();
      if (html === null || html === undefined) return false;
      if (size(html) > MAX_STATE_BYTES) return false;
      if (states.length && states[cursor] === html) return false;
      // A new edit invalidates anything that was ahead of the cursor, exactly
      // as a normal undo stack does.
      if (cursor < states.length - 1) states = states.slice(0, cursor + 1);
      states.push(html);
      cursor = states.length - 1;
      trim();
      return true;
    }

    /**
     * Undo one step.
     * @returns {'native'|'history'|'none'}
     */
    function undo() {
      // The browser first: it is the better implementation, and while the
      // popup is open its stack holds everything typed this session.
      if (exec('undo')) return 'native';
      if (cursor > 0) {
        cursor -= 1;
        setHtml(states[cursor]);
        return 'history';
      }
      return 'none';
    }

    /** @returns {'native'|'history'|'none'} */
    function redo() {
      if (exec('redo')) return 'native';
      if (cursor >= 0 && cursor < states.length - 1) {
        cursor += 1;
        setHtml(states[cursor]);
        return 'history';
      }
      return 'none';
    }

    /** Step back one saved state. @returns {boolean} whether it moved. */
    function stepBack() {
      if (cursor <= 0) return false;
      cursor -= 1;
      setHtml(states[cursor]);
      return true;
    }

    /** Step forward one saved state. @returns {boolean} whether it moved. */
    function stepForward() {
      if (cursor < 0 || cursor >= states.length - 1) return false;
      cursor += 1;
      setHtml(states[cursor]);
      return true;
    }

    return {
      record,
      stepBack,
      stepForward,
      undo,
      redo,
      /** The states, for storing alongside the draft. */
      serialize: () => states.slice(),
      /**
       * Adopt states saved with a draft. The editor is showing the newest of
       * them, so the cursor starts at the end and Ctrl+Z walks backwards.
       */
      restore(saved) {
        states = Array.isArray(saved) ? saved.filter((s) => typeof s === 'string') : [];
        trim();
        cursor = states.length - 1;
      },
      get length() { return states.length; },
      get index() { return cursor; },
    };
  }

  return { create, MAX_STATES, MAX_STATE_BYTES, MAX_TOTAL_BYTES, IDLE_MS };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = ProtonEditorHistory;
