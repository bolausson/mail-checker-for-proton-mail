/**
 * Leaving a reply in progress.
 *
 * The first version of this guard was wired to the preview's X button alone.
 * There are a dozen other ways out of the preview (Escape, clicking another
 * message, prev/next, archive, trash, spam, phishing, the bulk menu, the
 * accounts view), every one of which wiped the editor silently. Worse, the
 * `else` branch of _saveDraft posted `draft: null` whenever neither editor was
 * open, and closePreview/openPreview both create exactly that state, so the
 * pagehide flush then deleted the saved draft too: the text was gone with no
 * prompt and nothing to restore.
 *
 * The guard now sits inside closePreview and openPreview, so a new exit route
 * is protected by default rather than by remembering to add a call.
 *
 * Two later corrections are pinned here as well:
 *
 *  - The guard asked with window.confirm(), which Chrome ignores inside
 *    extension pages, returning a hard false. That did not merely skip the
 *    question, it made closePreview always answer "the user declined", so a
 *    reply with anything typed in it could not be closed at all. It is now an
 *    in-page modal, and therefore asynchronous.
 *  - Five destructive handlers called closePreview() and carried on regardless
 *    of the answer, so declining the prompt kept the reply open but still
 *    archived, trashed or deleted the message underneath it.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const SRC = readFileSync(join(__dirname, '..', 'popup', 'popup.js'), 'utf-8');

function lift(name) {
  const start = SRC.search(new RegExp('(async )?function ' + name + '\\('));
  if (start === -1) throw new Error('function not found in popup.js: ' + name);
  let i = SRC.indexOf('{', start);
  let depth = 0;
  for (; i < SRC.length; i++) {
    if (SRC[i] === '{') depth++;
    else if (SRC[i] === '}') { depth--; if (depth === 0) return SRC.slice(start, i + 1); }
  }
  throw new Error('unbalanced braces reading ' + name);
}

/** Build _confirmLeavingReply with its three dependencies injected. */
function build({ dirty, answer }) {
  const asked = { count: 0 };
  const body = lift('_confirmLeavingReply').replace(/^async /, '');
  const fn = new Function(
    '_replyHasUnsentContent', 'ProtonDialog', 'ProtonI18n',
    'return async ' + body + '\n;return _confirmLeavingReply;'
  )(
    () => dirty,
    { confirm: () => { asked.count++; return Promise.resolve(answer); } },
    { t: (k) => k }
  );
  return { fn, asked };
}

describe('when the reply has unsent work', () => {
  it('asks, and lets the caller proceed when the user agrees', async () => {
    const { fn, asked } = build({ dirty: true, answer: true });
    expect(await fn(false)).toBe(true);
    expect(asked.count).toBe(1);
  });

  it('asks, and aborts the caller when the user declines', async () => {
    const { fn, asked } = build({ dirty: true, answer: false });
    expect(await fn(false)).toBe(false);
    expect(asked.count).toBe(1);
  });
});

describe('when there is nothing to lose', () => {
  it('does not ask', async () => {
    const { fn, asked } = build({ dirty: false, answer: false });
    expect(await fn(false)).toBe(true);
    expect(asked.count).toBe(0);
  });
});

describe('force skips the question entirely', () => {
  it('never prompts on a forced exit, even with unsent work', async () => {
    // A completed send, a draft being restored, a dead session, or a poll
    // finding the message gone: there is nothing to abandon, or no way to stay.
    const { fn, asked } = build({ dirty: true, answer: false });
    expect(await fn(true)).toBe(true);
    expect(asked.count).toBe(0);
  });
});

describe('the guard is wired where it has to be, not on one button', () => {
  it('runs inside closePreview and openPreview', () => {
    expect(lift('closePreview')).toMatch(/await _confirmLeavingReply\(/);
    expect(lift('openPreview')).toMatch(/await _confirmLeavingReply\(/);
  });

  it('closePreview clears the in-progress flags, so it cannot prompt twice', () => {
    const close = lift('closePreview');
    expect(close).toMatch(/_replyEditorOpen\s*=\s*false/);
    expect(close).toMatch(/_replyBaseline\s*=\s*''/);
  });

  it('every forced call site is one of the six intended ones', () => {
    // Other options may ride along ({ force: true, readWhileOpen }).
    const forced = SRC.match(/\{\s*force:\s*true\b[^}]*\}/g) || [];
    expect(forced.length).toBe(6);
  });

  it('asks exactly once: the guard lives in closePreview, not also on the button', () => {
    // Moving the guard into closePreview while leaving the original on the X
    // button made it prompt twice for the same reply.
    const calls = SRC.match(/(?<!function )_replyHasUnsentContent\(\)/g) || [];
    expect(calls.length).toBe(1); // only inside _confirmLeavingReply
    expect(SRC).toMatch(/if \(await closePreview\(\)\) _clearDraft\(\);/);
  });

  it('the stored draft is dropped only when the close actually happened', () => {
    // closePreview resolves false when the user declines, so a cancelled close
    // must not fall through to _clearDraft.
    expect(SRC).not.toMatch(/_clearDraft\(\);\s*\n\s*await closePreview\(\);/);
  });
});

describe('the answer is asynchronous now, and every caller waits for it', () => {
  it('closePreview and the guard are async', () => {
    expect(SRC).toMatch(/async function closePreview\(/);
    expect(SRC).toMatch(/async function _confirmLeavingReply\(/);
  });

  it('no call site reads closePreview() as if it answered immediately', () => {
    // `if (closePreview())` on a promise is always truthy: the reply would be
    // discarded no matter what the user chose.
    const unawaited = [];
    SRC.split('\n').forEach((line, i) => {
      if (!/closePreview\(/.test(line)) return;
      if (/^\s*(\/\/|\*)/.test(line)) return;          // comment
      if (/async function closePreview\(/.test(line)) return; // the definition
      if (/await closePreview\(/.test(line)) return;
      // Bare `closePreview({ force: true });` as a statement is fine: forced
      // exits cannot prompt, so there is no answer worth waiting for.
      if (/^\s*(if \([^)]*\) )?closePreview\(\{ force: true \}\);\s*$/.test(line)) return;
      unawaited.push(`${i + 1}: ${line.trim()}`);
    });
    expect(unawaited).toEqual([]);
  });

  it('the guard asks through the in-page dialog, never window.confirm', () => {
    const guard = lift('_confirmLeavingReply');
    expect(guard).toMatch(/ProtonDialog\.confirm\(/);
    expect(guard).not.toMatch(/[^.\w]confirm\(/);
  });
});

describe('declining the prompt cancels the action, not just the close', () => {
  // Archiving the message while its reply stays open lost the draft anyway and
  // filed away mail the user had not finished answering.
  const HANDLERS = [
    'handleArchive',
    'handleTrash',
    'handleMoveToSpam',
    'handleDeletePermanently',
    'handleReportPhishing',
  ];

  for (const name of HANDLERS) {
    it(`${name} aborts when the user keeps the reply`, () => {
      const fn = lift(name);
      expect(fn, name).toMatch(/if \(!await closePreview\(\)\) return;/);
      // and it does so before touching the message
      const guardAt = fn.indexOf('if (!await closePreview()) return;');
      const actionAt = fn.indexOf('doAction(');
      expect(guardAt, name).toBeGreaterThan(-1);
      expect(actionAt, name).toBeGreaterThan(guardAt);
    });
  }

  it('every bulk action, and the accounts button, does the same', () => {
    // Five single-message handlers, six callbacks behind the bulk menu
    // (archive, trash, delete permanently, move to folder, spam, phishing),
    // and the header button that leaves the inbox for the accounts screen.
    const guarded = SRC.match(/if \(!await closePreview\(\)\) return;/g) || [];
    expect(guarded.length).toBe(HANDLERS.length + 6 + 1);
  });

  it('showAccountsView itself stays synchronous and forced', () => {
    // Making it async broke its two programmatic callers: both set
    // loginUsername.value straight after calling it, and the deferred body
    // clears that field, so the pre-filled address was wiped on re-auth. The
    // asking belongs on the button the user actually clicked.
    const fn = lift('showAccountsView');
    expect(SRC).toMatch(/\n {2}function showAccountsView\(/);
    expect(fn).toMatch(/closePreview\(\{ force: true \}\)/);
    expect(fn).not.toMatch(/await closePreview\(\)/);
  });

  it('no destructive path still calls closePreview and ignores it', () => {
    expect(SRC).not.toMatch(/^\s*closePreview\(\);\s*$/m);
  });
});

describe('a draft is never erased just because nothing is open', () => {
  it('_saveDraft returns instead of posting draft:null', () => {
    // closePreview nulls _selectedMsg and openPreview clears _replyEditorOpen,
    // so this branch is on every exit path; posting null here deleted the draft
    // that exists precisely to survive the popup closing.
    const save = lift('_saveDraft');
    expect(save).not.toMatch(/draft:\s*null/);
  });

  it('only _clearDraft drops a stored draft', () => {
    expect(lift('_clearDraft')).toMatch(/draft:\s*null/);
  });
});

describe('a failed draft save is no longer silent', () => {
  // Both ends swallowed their errors, so a rejected storage write looked
  // exactly like a successful one. The extension's own comment records this
  // eating an entire reply when an embedded photo blew the 10 MB quota.
  const BG = readFileSync(join(__dirname, '..', 'background', 'background.js'), 'utf-8');

  it('the popup reads the answer instead of discarding it', () => {
    const save = lift('_saveDraft');
    expect(save).toMatch(/_noteDraftSave\(/);
    expect(save).not.toMatch(/SAVE_DRAFT', draft \}\)\.catch\(\(\) => \{\}\)/);
  });

  it('a rejected send counts as a failure, not a shrug', () => {
    const save = lift('_saveDraft');
    expect(save).toMatch(/\.catch\(\(err\) => _noteDraftSave\(false/);
  });

  it('the user is told, once, rather than on every keystroke', () => {
    const note = lift('_noteDraftSave');
    expect(note).toMatch(/showToast\(ProtonI18n\.t\('draftSaveFailed'\)\)/);
    expect(note).toMatch(/if \(!_draftSaveHealthy\) return;/);
  });

  it('recovery is noticed, so a later failure warns again', () => {
    // Matched on the two things that carry the behaviour rather than the exact
    // one-line form, which stopped holding when the success branch grew to
    // also update the "Saved at HH:MM" label.
    const fn = lift('_noteDraftSave');
    expect(fn).toMatch(/if \(ok\) \{/);
    expect(fn).toMatch(/_draftSaveHealthy = true;/);
    expect(fn).toMatch(/return;/);
  });

  it('the background records why it failed and passes the reason back', () => {
    const at = BG.indexOf("case 'SAVE_DRAFT':");
    expect(at).toBeGreaterThan(-1);
    const block = BG.slice(at, at + 1400);
    expect(block).toMatch(/ProtonDiag\.record\('draft\.save\.fail'/);
    expect(block).toMatch(/sendResponse\(\{ success: false, error: reason \}\)/);
    expect(block).not.toMatch(/catch\(\(\) => sendResponse\(\{ success: false \}\)\)/);
  });

  it('the diagnostic record carries no message content', () => {
    // The log is exportable, so it must never carry the draft itself.
    const at = BG.indexOf("ProtonDiag.record('draft.save.fail'");
    // Only the FIELDS object, not the event name, which legitimately says
    // "draft".
    const open = BG.indexOf('{', at);
    const fields = BG.slice(open, BG.indexOf('}', open) + 1);
    expect(fields).toMatch(/reason:/);
    expect(fields).not.toMatch(/body|subject|message\.draft|\bdraft\b/);
  });

  it('logging failure cannot itself break the save path', () => {
    const at = BG.indexOf("case 'SAVE_DRAFT':");
    expect(BG.slice(at, at + 1400)).toMatch(/try \{ ProtonDiag\.record[\s\S]*?\} catch/);
  });

  it('the warning string exists in English', () => {
    const I18N = readFileSync(join(__dirname, '..', 'lib', 'i18n.js'), 'utf-8');
    expect(I18N).toMatch(/draftSaveFailed: '[^']+'/);
  });
});

describe('the draft survives the popup going away', () => {
  it('flushes on visibilitychange as well as pagehide', () => {
    // pagehide was the only flush point in the entire popup. One missed event
    // and everything since the last debounce tick was gone.
    expect(SRC).toMatch(/addEventListener\('pagehide', _flushDrafts\)/);
    expect(SRC).toMatch(/addEventListener\('visibilitychange'/);
  });

  it('only flushes when the page is actually being hidden', () => {
    const at = SRC.indexOf("addEventListener('visibilitychange'");
    expect(SRC.slice(at, at + 200)).toMatch(/visibilityState === 'hidden'/);
  });

  it('both signals run the same save, message and account draft alike', () => {
    const fn = lift('_flushDrafts');
    expect(fn).toMatch(/_saveDraft\(\)/);
    expect(fn).toMatch(/_saveAccountDraft\(\)/);
  });
});

describe('the restore guard cannot leak', () => {
  // _saveDraft returns early while _restoringDraft is set. It used to be
  // cleared at eight separate exit points; any future early return added
  // inside that try, or a throw in the catch, would have left it set for the
  // life of the popup, silently disabling every later save.
  const restore = lift('_restoreDraft');

  it('is set exactly once and cleared exactly once', () => {
    expect((SRC.match(/_restoringDraft = true/g) || [])).toHaveLength(1);
    // Excluding the `let` declaration, which is not a reset.
    expect((SRC.match(/(?<!let )_restoringDraft = false/g) || [])).toHaveLength(1);
  });

  it('is cleared in a finally, not on each exit path', () => {
    expect(restore).toMatch(/\} finally \{[\s\S]*?_restoringDraft = false;[\s\S]*?\}/);
  });

  it('the clear comes after the catch, so a failed restore still releases it', () => {
    expect(restore.indexOf('catch')).toBeLessThan(restore.indexOf('finally'));
  });

  it('every early return inside the restore is now bare', () => {
    // A `return` that also had to remember the flag was the fragile part.
    expect(restore).not.toMatch(/_restoringDraft = false; return/);
  });
});

describe('a half-typed address survives the popup closing', () => {
  // Only chips were persisted, so an address still being typed was dropped:
  // the blur handler that would commit it runs on a 150ms timer that never
  // fires once the document is torn down.
  //
  // The first attempt committed pending input inside _saveDraft. That runs on
  // a 500ms debounce, so pausing mid-word turned the partial text into an
  // invalid chip and the field went red while you were still typing in it.
  // The text is now saved AS TEXT and put back in the box on restore.
  const save = lift('_saveDraft');
  const restore = lift('_restoreDraft');

  it('_saveDraft never commits pending input', () => {
    expect(save).not.toMatch(/commitPending/);
  });

  it('it stores the raw text of every recipient field', () => {
    for (const f of ['composeToPending', 'composeCcPending', 'composeBccPending',
      'forwardToPending', 'replyCcPending', 'replyBccPending']) {
      expect(save, f).toContain(f);
    }
  });

  it('restore puts that text back in the input, not into a chip', () => {
    for (const c of ['chipTo', 'chipCc', 'chipBcc', 'chipForwardTo', 'chipReplyCc', 'chipReplyBcc']) {
      expect(restore, c).toContain(c + '.setPending(');
    }
    // The pending text goes back as text; only real chips go through addChip.
    expect(restore).toContain('.addChip(');
  });

  it('the chip input exposes the pending text without altering it', () => {
    const api = SRC.slice(SRC.indexOf('return {\n      addChip, getChips'), SRC.indexOf('return {\n      addChip, getChips') + 400);
    expect(api).toMatch(/getPending: \(\) => inputEl\.value/);
    expect(api).toMatch(/setPending: \(v\) => \{ inputEl\.value = v \|\| ''; \}/);
  });

  it('committing on a debounced save is not reintroduced', () => {
    // The regression that made the recipient field unusable.
    expect(lift('_scheduleDraftSave')).not.toMatch(/commitPending/);
  });
});
