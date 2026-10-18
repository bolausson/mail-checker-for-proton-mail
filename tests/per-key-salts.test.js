/**
 * One passphrase per user key.
 *
 * GET /core/v4/keys/salts returns one entry per
 * key ID. Unlocking the second user key means deriving a second mailbox
 * password from THAT key's salt. Reusing the first key's passphrase silently
 * fails. This is easy to miss because with one key it never comes up.
 *
 * It matters because a post-quantum account has TWO primary user keys, and
 * each address key's Token is wrapped to one of them, not necessarily the one
 * we selected. Unlocking only the selected key signs the user in and then
 * leaves half their address keys shut: mail that opens, and mail that does
 * not, with no error that names the cause.
 *
 * The derivation is bcrypt over the LOGIN PASSWORD, which is deliberately
 * never persisted, so the map has to be built during sign-in and carried. It
 * cannot be reconstructed later from stored state.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const ROOT = join(__dirname, '..');
const AUTH = readFileSync(join(ROOT, 'background', 'auth.js'), 'utf-8');
const ACCOUNTS = readFileSync(join(ROOT, 'background', 'accounts.js'), 'utf-8');

function lift(src, name) {
  const start = src.search(new RegExp('(async )?function ' + name + '\\('));
  if (start === -1) throw new Error('not found: ' + name);
  let i = src.indexOf('{', start);
  let depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) return src.slice(start, i + 1); }
  }
  throw new Error('unbalanced braces reading ' + name);
}

const passphraseFor = new Function(lift(ACCOUNTS, '_passphraseFor') + '\nreturn _passphraseFor;')();

describe('picking the passphrase for a given key', () => {
  const account = {
    keyPassword: 'single-fallback',
    keyPasswords: { 'key-v4': 'pass-v4', 'key-v6': 'pass-v6' },
  };

  it('uses that key\'s own passphrase', () => {
    expect(passphraseFor(account, 'key-v4')).toBe('pass-v4');
    expect(passphraseFor(account, 'key-v6')).toBe('pass-v6');
  });

  it('does not hand one key another key\'s passphrase', () => {
    expect(passphraseFor(account, 'key-v6')).not.toBe(passphraseFor(account, 'key-v4'));
  });

  it('falls back to the single passphrase for a key it has no entry for', () => {
    expect(passphraseFor(account, 'key-unknown')).toBe('single-fallback');
  });

  it('falls back for an account stored before the map existed', () => {
    // Migration: these accounts keep working on the old single-passphrase
    // path until their next sign-in repopulates the map.
    expect(passphraseFor({ keyPassword: 'legacy' }, 'any-key')).toBe('legacy');
    expect(passphraseFor({ keyPassword: 'legacy', keyPasswords: {} }, 'any-key')).toBe('legacy');
  });

  it('survives a missing account or key id', () => {
    expect(passphraseFor(null, 'k')).toBeUndefined();
    expect(passphraseFor({ keyPassword: 'x' }, undefined)).toBe('x');
  });

  it('is not fooled by inherited properties', () => {
    // A key literally named "toString" must not resolve to Object.prototype's.
    const acct = { keyPassword: 'fallback', keyPasswords: {} };
    expect(passphraseFor(acct, 'toString')).toBe('fallback');
    expect(passphraseFor(acct, 'constructor')).toBe('fallback');
  });

  it('honours an entry whose value is empty, rather than falling through', () => {
    // An account with no salt for a key legitimately derives ''. Falling back
    // would try the wrong passphrase instead of the intended one.
    const acct = { keyPassword: 'fallback', keyPasswords: { k: '' } };
    expect(passphraseFor(acct, 'k')).toBe('');
  });
});

describe('the map is built at sign-in, from each key\'s own salt', () => {
  it('derives one passphrase per user key', () => {
    const at = AUTH.indexOf('const keyPasswords = {}');
    expect(at).toBeGreaterThan(-1);
    const block = AUTH.slice(at, at + 400);
    expect(block).toMatch(/for \(const k of user\.Keys\)/);
    expect(block).toMatch(/keySalts\.find\(ks => ks\.ID === k\.ID\)/);
    expect(block).toMatch(/_computeKeyPassword\(password, entry\.KeySalt\)/);
  });

  it('matches salts by key ID, never by position', () => {
    // "falling back to 'first salt' silently produces a wrong passphrase"
    const at = AUTH.indexOf('const keyPasswords = {}');
    expect(AUTH.slice(at, at + 400)).not.toMatch(/keySalts\[0\]/);
  });

  it('returns the map alongside the single passphrase', () => {
    expect(AUTH).toMatch(/keyPasswords: keyPasswords,/);
    expect(AUTH).toMatch(/keyPassword: keyPassword,/);
  });

  it('is built on the one path every sign-in flow funnels through', () => {
    // login, 2FA, FIDO2 and mailbox-password all end in _completeLogin, so
    // building it there covers every route in.
    const calls = AUTH.match(/return _completeLogin\(/g) || [];
    expect(calls.length).toBeGreaterThanOrEqual(4);
    expect(lift(AUTH, '_completeLogin')).toMatch(/const keyPasswords = \{\}/);
  });
});

describe('it survives a restart', () => {
  it('is encrypted at rest like the passphrase it is', () => {
    expect(ACCOUNTS).toMatch(/keyPasswords: await ExtEncryption\.encrypt\(JSON\.stringify\(a\.keyPasswords \|\| \{\}\)\)/);
  });

  it('is restored on load', () => {
    expect(ACCOUNTS).toMatch(/keyPasswords: await _decryptKeyPasswords\(a\.keyPasswords\)/);
  });

  it('a corrupt blob degrades to the fallback instead of killing the account', () => {
    const fn = lift(ACCOUNTS, '_decryptKeyPasswords');
    expect(fn).toMatch(/catch/);
    expect(fn).toMatch(/return \{\}/);
    // and rejects a non-object payload rather than trusting it
    expect(fn).toMatch(/typeof parsed === 'object'/);
    expect(fn).toMatch(/!Array\.isArray\(parsed\)/);
  });

  it('carries the map through from login into the account', () => {
    expect(ACCOUNTS).toMatch(/account\.keyPasswords = result\.keyPasswords \|\| \{\}/);
    expect(ACCOUNTS).toMatch(/keyPasswords: result\.keyPasswords \|\| \{\}/);
  });
});

describe('the multi-key unlock actually uses it', () => {
  it('the other-user-keys loop asks for that key\'s passphrase', () => {
    const at = ACCOUNTS.indexOf('const userPrivateKeys = [userPrivateKey]');
    expect(at).toBeGreaterThan(-1);
    const loop = ACCOUNTS.slice(at, at + 1200);
    expect(loop).toMatch(/passphrase: _passphraseFor\(account, k\.ID\)/);
  });

  it('no longer passes the selected key\'s passphrase to every key', () => {
    const at = ACCOUNTS.indexOf('const userPrivateKeys = [userPrivateKey]');
    const loop = ACCOUNTS.slice(at, at + 1200);
    expect(loop).not.toMatch(/passphrase: account\.keyPassword,/);
  });
});
