/**
 * How long an unlocked key set is trusted.
 *
 * Proton's own stated root cause for the post-quantum
 * rollout was "some clients did not update the key in memory". Ours did the
 * same: ensureKeysUnlocked returned the moment the set was populated, so no
 * key was re-read for the life of the worker.
 *
 * Keys are ADDITIVE, so nothing already decryptable breaks. That is what makes
 * it silent: the failure only touches NEW key material. Opting into PQC
 * generates a v6 user key AND v6 address keys, and because Proton wraps a
 * calendar passphrase to the primary ADDRESS key, a new primary alone can
 * start failing until the process restarts.
 *
 * The subtlety that cost them a second bug: the fetch swallows its own
 * errors, so stamping the freshness clock unconditionally would pin a
 * KNOWN-STALE set for the whole window. Only start the clock when the keys
 * were genuinely re-read.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const SRC = readFileSync(join(__dirname, '..', 'background', 'accounts.js'), 'utf-8');

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

const WINDOW_MS = 30 * 60 * 1000;
const keysAreFresh = new Function(
  '_KEYS_FRESH_FOR_MS',
  lift('_keysAreFresh') + '\nreturn _keysAreFresh;'
)(WINDOW_MS);

afterEach(() => { vi.useRealTimers(); });

describe('when the set is considered fresh', () => {
  it('is fresh immediately after a genuine unlock', () => {
    expect(keysAreFresh({ keysUnlocked: true, keysUnlockedAt: Date.now() })).toBe(true);
  });

  it('stays fresh inside the window', () => {
    expect(keysAreFresh({
      keysUnlocked: true, keysUnlockedAt: Date.now() - (WINDOW_MS - 60_000),
    })).toBe(true);
  });

  it('goes stale past the window, so new key material is picked up', () => {
    expect(keysAreFresh({
      keysUnlocked: true, keysUnlockedAt: Date.now() - (WINDOW_MS + 1),
    })).toBe(false);
  });

  it('is never fresh when dated in the future (a clock stepped back)', () => {
    expect(keysAreFresh({ keysUnlocked: true, keysUnlockedAt: Date.now() + 60000 })).toBe(false);
  });

  it('is never fresh when nothing is unlocked', () => {
    expect(keysAreFresh({ keysUnlocked: false, keysUnlockedAt: Date.now() })).toBe(false);
  });

  it('treats a missing timestamp as stale', () => {
    // Unlocked before this bound existed, or restored from storage. Re-reading
    // once is cheap, and it removes any way to hold an unbounded set.
    expect(keysAreFresh({ keysUnlocked: true })).toBe(false);
    expect(keysAreFresh({ keysUnlocked: true, keysUnlockedAt: 0 })).toBe(false);
  });

  it('is stale again after the window elapses', () => {
    vi.useFakeTimers();
    const account = { keysUnlocked: true, keysUnlockedAt: Date.now() };
    expect(keysAreFresh(account)).toBe(true);
    vi.advanceTimersByTime(WINDOW_MS + 1000);
    expect(keysAreFresh(account)).toBe(false);
  });
});

describe('the clock only starts on a genuine re-read', () => {
  it('is stamped where the keys were actually decrypted', () => {
    const at = SRC.indexOf('account.keysUnlocked = decryptedKeys.length > 0');
    expect(at).toBeGreaterThan(-1);
    expect(SRC.slice(at, at + 600)).toMatch(/account\.keysUnlockedAt = account\.keysUnlocked \? fetchedAt : 0/);
  });

  it('a failed unlock does not stamp it', () => {
    // Only one place assigns it, and it sits after the decryption succeeded.
    const stamps = SRC.match(/keysUnlockedAt = Date\.now\(\)/g) || [];
    expect(stamps).toHaveLength(0); // always the conditional form, never bare
    const conditional = SRC.match(/keysUnlockedAt = account\.keysUnlocked \? fetchedAt : 0/g) || [];
    expect(conditional).toHaveLength(1);
  });

  it('dates a set built from the session copy to when the copy was fetched', () => {
    // The users/addresses responses are kept in storage.session so a cold
    // start need not refetch them. If a set unlocked from that copy were
    // stamped "now", it would count as fresh for another full window on top
    // of the copy's age, and key material could be up to twice as old as the
    // bound says. The copy's own fetch time keeps the bound honest.
    const fn = SRC.slice(SRC.indexOf('async function _doUnlockKeys('));
    const head = fn.slice(0, fn.indexOf('const user = userResult.User'));
    expect(head).toMatch(/fetchedAt = cached\.at/);
    expect(head).toMatch(/fetchedAt = Date\.now\(\);\s*await _writeBootstrap/);
  });

  it('never serves the session copy past the same window', () => {
    const read = SRC.slice(SRC.indexOf('async function _readBootstrap('), SRC.indexOf('async function _writeBootstrap('));
    expect(read).toMatch(/age >= 0 && age < _KEYS_FRESH_FOR_MS/);
    // A copy from another session (re-login mints a new UID) is not ours.
    expect(read).toMatch(/entry\.uid !== account\.uid/);
  });

  it('re-reads from the API when told to, not from the copy', () => {
    const inv = SRC.slice(SRC.indexOf('function invalidateKeys('), SRC.indexOf('// --- Bootstrap cache'));
    expect(inv).toMatch(/invalidateBootstrap\(accountId\)/);
  });
});

describe('ensureKeysUnlocked', () => {
  const fn = lift('ensureKeysUnlocked');

  it('asks whether the set is FRESH, not merely whether it exists', () => {
    expect(fn).toMatch(/_keysAreFresh\(account\)/);
    expect(fn).not.toMatch(/if \(account\.keysUnlocked\) return true;/);
  });

  it('keeps serving a usable set when the re-read fails', () => {
    // A transient network error must not lock the user out of mail they can
    // already decrypt; it just does not refresh the clock.
    expect(fn).toMatch(/return !!account\.keysUnlocked;/);
  });
});

describe('explicit invalidation', () => {
  it('exists, for failures that look like a missing key', () => {
    expect(SRC).toMatch(/function invalidateKeys\(accountId\)/);
    expect(lift('invalidateKeys')).toMatch(/account\.keysUnlockedAt = 0/);
  });

  it('is exported so callers can reach it', () => {
    expect(SRC).toMatch(/^\s{4}invalidateKeys,$/m);
  });

  it('clears only the clock, never the usable keys', () => {
    const fn = lift('invalidateKeys');
    expect(fn).not.toMatch(/decryptedKeys = \[\]/);
    expect(fn).not.toMatch(/keysUnlocked = false/);
  });
});
