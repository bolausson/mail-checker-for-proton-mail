/**
 * Choosing which /u/N/ slot belongs to which account.
 *
 * A browser profile that has signed into the same Proton account more than
 * once keeps one `ps-N` localStorage entry per slot it has ever used, and they
 * all carry the SAME UserID. Both scan paths used to write every match in turn:
 *
 *     for (const s of sessions) {
 *       const acct = accounts.find(a => a.userId === s.userId);
 *       if (acct) _updateSlotMapping(acct.uid, s.localId);
 *     }
 *
 * so whichever entry came last in localStorage order won. Arbitrary, often
 * stale, and then shown in Options as "Auto-detected" as though it were known.
 * Observed live: three sessions mapping onto two accounts, the same UID
 * written twice to different slots in one pass.
 *
 * The consequence is a wrong "Open in Proton Mail": the wrong mailbox, or
 * "Conversation does not exist" when the two accounts use different ViewModes.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const SRC = readFileSync(join(__dirname, '..', 'background', 'url-detection.js'), 'utf-8');

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

const resolveSlots = new Function(lift('_resolveSlots') + '\nreturn _resolveSlots;')();
const slotFromUrl = new Function(lift('_slotFromUrl') + '\nreturn _slotFromUrl;')();

const ACCOUNTS = [
  { uid: 'uid-a', userId: 'user-a', email: 'a@example.com' },
  { uid: 'uid-b', userId: 'user-b', email: 'b@example.com' },
];
const session = (localId, userId) => ({ localId, userId });

describe('reading the slot out of a tab URL', () => {
  it('finds it', () => {
    expect(slotFromUrl('https://mail.proton.me/u/3/inbox')).toBe(3);
    expect(slotFromUrl('https://mail.proton.me/u/12/inbox/abc')).toBe(12);
  });

  it('returns null when there is nothing to read', () => {
    expect(slotFromUrl('https://mail.proton.me/')).toBeNull();
    expect(slotFromUrl('https://account.proton.me/u/2/')).toBeNull();
    expect(slotFromUrl(undefined)).toBeNull();
    expect(slotFromUrl('')).toBeNull();
  });
});

describe('the unambiguous case', () => {
  it('maps one session per account', () => {
    const { resolved, ambiguous } = resolveSlots(
      [session(2, 'user-a'), session(3, 'user-b')], ACCOUNTS, null);
    expect(resolved.get('uid-a')).toBe(2);
    expect(resolved.get('uid-b')).toBe(3);
    expect(ambiguous).toEqual([]);
  });

  it('ignores sessions for accounts we do not have', () => {
    const { resolved, users } = resolveSlots(
      [session(2, 'user-a'), session(9, 'someone-else')], ACCOUNTS, null);
    expect(resolved.size).toBe(1);
    expect(users).toBe(2); // both users seen, only one of ours
  });
});

describe('duplicate sessions for one account', () => {
  // The bug. Three sessions, two accounts, one account appearing twice.
  const DUPES = [session(1, 'user-a'), session(2, 'user-a'), session(4, 'user-b')];

  it('does NOT silently pick one when nothing distinguishes them', () => {
    const { resolved, ambiguous } = resolveSlots(DUPES, ACCOUNTS, null);
    expect(resolved.has('uid-a')).toBe(false);
    expect(ambiguous).toHaveLength(1);
    expect(ambiguous[0].account.uid).toBe('uid-a');
    expect(ambiguous[0].slots).toEqual([1, 2]);
  });

  it('still resolves the accounts that are unambiguous', () => {
    const { resolved } = resolveSlots(DUPES, ACCOUNTS, null);
    expect(resolved.get('uid-b')).toBe(4);
  });

  it('uses the tab the user is looking at to settle it', () => {
    // The scanned tab is showing /u/2/, so slot 2 is that account's, and 1 is
    // a leftover from an earlier sign-in.
    const { resolved, ambiguous } = resolveSlots(DUPES, ACCOUNTS, 2);
    expect(resolved.get('uid-a')).toBe(2);
    expect(ambiguous).toEqual([]);
  });

  it('does not let an unrelated tab decide', () => {
    // The tab shows a slot this account never had, so it settles nothing.
    const { resolved, ambiguous } = resolveSlots(DUPES, ACCOUNTS, 7);
    expect(resolved.has('uid-a')).toBe(false);
    expect(ambiguous).toHaveLength(1);
  });

  it('reports the candidates in a stable order, for a readable log', () => {
    const { ambiguous } = resolveSlots(
      [session(9, 'user-a'), session(3, 'user-a'), session(5, 'user-a')], ACCOUNTS, null);
    expect(ambiguous[0].slots).toEqual([3, 5, 9]);
  });

  it('never writes the same account twice, whatever the order', () => {
    for (const order of [[1, 2, 4], [4, 2, 1], [2, 4, 1]]) {
      const sessions = order.map((n) => session(n, n === 4 ? 'user-b' : 'user-a'));
      const { resolved } = resolveSlots(sessions, ACCOUNTS, null);
      expect(new Set(resolved.keys()).size, order.join(',')).toBe(resolved.size);
    }
  });
});

describe('degenerate input', () => {
  it('copes with no sessions', () => {
    const { resolved, ambiguous } = resolveSlots([], ACCOUNTS, null);
    expect(resolved.size).toBe(0);
    expect(ambiguous).toEqual([]);
  });

  it('copes with no accounts', () => {
    const { resolved } = resolveSlots([session(1, 'user-a')], [], null);
    expect(resolved.size).toBe(0);
  });

  it('treats slot 0 as a real slot, not as absent', () => {
    // /u/0/ is the common case; a falsy-slot bug here would break everyone.
    const { resolved } = resolveSlots([session(0, 'user-a')], ACCOUNTS, null);
    expect(resolved.get('uid-a')).toBe(0);
  });

  it('lets an active slot of 0 settle an ambiguity', () => {
    const { resolved } = resolveSlots(
      [session(0, 'user-a'), session(5, 'user-a')], ACCOUNTS, 0);
    expect(resolved.get('uid-a')).toBe(0);
  });
});

describe('both scan paths go through the resolver', () => {
  it('the passive tab scan does', () => {
    expect(lift('_scanAllSessionsFromTab')).toMatch(/_resolveSlots\(/);
  });

  it('the Options rescan does', () => {
    expect(lift('rescanUrlMapping')).toMatch(/_resolveSlots\(/);
  });

  it('neither still writes a mapping per raw session', () => {
    // The original shape: iterate sessions, write on every match.
    for (const fn of ['_scanAllSessionsFromTab', 'rescanUrlMapping']) {
      expect(lift(fn), fn).not.toMatch(/for \(const s of sessions\)/);
    }
  });

  it('both feed the scanned tab URL in as ground truth', () => {
    expect(lift('_scanAllSessionsFromTab')).toMatch(/_slotFromUrl\(tabUrl\)/);
    expect(lift('rescanUrlMapping')).toMatch(/_slotFromUrl\(loaded && loaded\.url\)/);
    // ...and the callers actually supply it.
    expect(SRC).toMatch(/_scanAllSessionsFromTab\(tabId, 'Tab updated', tab\.url\)/);
    expect(SRC).toMatch(/_scanAllSessionsFromTab\(tabs\[0\]\.id, 'Startup scan', tabs\[0\]\.url\)/);
  });
});

describe('what each path does with an account it cannot resolve', () => {
  it('the passive scan leaves it alone', () => {
    // Runs in the background off a tab load; it should only ever improve
    // things, never degrade a mapping the user is relying on.
    const fn = lift('_scanAllSessionsFromTab');
    expect(fn).toMatch(/left unchanged/);
    expect(fn).not.toMatch(/delete _accountUrlMap/);
  });

  it('the rescan clears it, so Options says Fallback rather than lying', () => {
    // The user pressed Refresh and is owed a straight answer.
    const fn = lift('rescanUrlMapping');
    expect(fn).toMatch(/delete _accountUrlMap\[acct\.uid\]/);
    expect(fn).toMatch(/ambiguous, several stale sessions/);
  });
});

describe('the scan logs do not print stray arguments', () => {
  // A trailing `cond ? 'text' : ''` argument makes the console render
  // "<empty string>" on every clean scan, which reads like a defect in a log
  // a user may well be pasting into a bug report.
  it('concatenates the ambiguity note into the message', () => {
    // `+ (cond ? '...' : '')` appends nothing when clean. The bug was the
    // same ternary passed as a trailing ARGUMENT, which the console prints.
    // Allow a line break: the two call sites wrap differently.
    for (const fn of ['_scanAllSessionsFromTab', 'rescanUrlMapping']) {
      expect(lift(fn), fn).toMatch(/\+\s*\(ambiguous\.length \? ' \('/);
    }
  });

  it('does not hand debugLog a bare conditional as its last argument', () => {
    // What produced "<empty string>" in the console on every clean scan.
    for (const fn of ['_scanAllSessionsFromTab', 'rescanUrlMapping']) {
      expect(lift(fn), fn).not.toMatch(/,\s*ambiguous\.length \?/);
    }
  });
});
