/**
 * Tests for ProtonAccountLimit (lib/account-limit.js): the free-tier
 * "one account" rule.
 *
 * The bug these lock down (reported 2026-07-27): the ADD_ACCOUNT gate refused
 * any login once `accounts.length >= 1`. When a session expired the account
 * stayed in the list awaiting re-login, so a free user pressing "Sign in" on
 * the session-expired banner got PREMIUM_REQUIRED, permanently locked out of
 * the single account the free tier advertises. Re-authenticating an account
 * you already have must never count as adding one.
 *
 * The opposite direction matters just as much: these also pin the limit itself,
 * including the loophole of adding a second account while the first is expired
 * and then reviving the first.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

let ProtonAccountLimit;

beforeAll(() => {
  const code = readFileSync(join(__dirname, '..', 'lib', 'account-limit.js'), 'utf-8');
  ProtonAccountLimit = new Function(code + '\nreturn ProtonAccountLimit;')();
});

const acct = (over) => ({ id: 'a1', username: 'jane', email: 'jane@proton.me', ...over });
const gate = (accounts, identifier, isPremium = false) =>
  ProtonAccountLimit.blocksFreeLogin({ accounts, identifier, isPremium });

describe('re-login after a session expiry (the reported lockout)', () => {
  it('allows signing in again to the one account a free user has', () => {
    const accounts = [acct({ authError: 'reauth' })];
    expect(gate(accounts, 'jane@proton.me')).toBe(false);
  });

  it('allows it before the session is even marked broken', () => {
    expect(gate([acct()], 'jane@proton.me')).toBe(false);
  });

  it('matches the identifier case-insensitively', () => {
    expect(gate([acct()], 'Jane@Proton.me')).toBe(false);
    expect(gate([acct()], '  JANE@PROTON.ME  ')).toBe(false);
  });

  it('matches the Proton username, not just the address', () => {
    expect(gate([acct({ username: 'jane', email: 'jane@proton.me' })], 'jane')).toBe(false);
  });

  it('allows recovery when the only account is unusable, even with another identifier', () => {
    // The identity is unknown until the server answers; accounts.js makes the
    // final call, so the attempt is allowed to reach the network.
    expect(gate([acct({ authError: 'reauth' })], 'someone.else@proton.me')).toBe(false);
    expect(gate([acct({ authError: 'disabled' })], 'someone.else@proton.me')).toBe(false);
  });
});

describe('the free-tier limit still holds', () => {
  it('blocks a second account while the first one works', () => {
    expect(gate([acct()], 'someone.else@proton.me')).toBe(true);
  });

  it('blocks when the identifier is empty or junk', () => {
    expect(gate([acct()], '')).toBe(true);
    expect(gate([acct()], '   ')).toBe(true);
    expect(gate([acct()], null)).toBe(true);
  });

  it('allows the very first account', () => {
    expect(gate([], 'jane@proton.me')).toBe(false);
  });

  it('never blocks a premium user', () => {
    const many = [acct(), acct({ id: 'a2', email: 'b@proton.me' })];
    expect(gate(many, 'third@proton.me', true)).toBe(false);
  });
});

describe('blocksNewAccount (authoritative, post-authentication)', () => {
  const newAcct = (accounts, isPremium = false) =>
    ProtonAccountLimit.blocksNewAccount({ accounts, isPremium });

  it('refuses a genuinely new account when a free user already has one', () => {
    expect(newAcct([acct()])).toBe(true);
  });

  it('closes the expired-account loophole', () => {
    // blocksFreeLogin lets this attempt through (all accounts unusable), so
    // the authoritative check MUST refuse it. Otherwise a free user could
    // bank a second account and then re-auth the first.
    const accounts = [acct({ authError: 'reauth' })];
    expect(gate(accounts, 'someone.else@proton.me')).toBe(false);
    expect(newAcct(accounts)).toBe(true);
  });

  it('allows the first account and any premium account', () => {
    expect(newAcct([])).toBe(false);
    expect(newAcct([acct(), acct({ id: 'a2' })], true)).toBe(false);
  });
});

describe('findByLogin / matchesLogin', () => {
  it('returns the matching account or null', () => {
    const a = acct();
    const b = acct({ id: 'a2', username: 'bob', email: 'bob@proton.me' });
    expect(ProtonAccountLimit.findByLogin([a, b], 'bob@proton.me')).toBe(b);
    expect(ProtonAccountLimit.findByLogin([a, b], 'nobody@proton.me')).toBeNull();
    expect(ProtonAccountLimit.findByLogin([a, b], '')).toBeNull();
    expect(ProtonAccountLimit.findByLogin(null, 'bob')).toBeNull();
  });

  it('tolerates accounts with missing fields', () => {
    expect(ProtonAccountLimit.matchesLogin({}, 'jane')).toBe(false);
    expect(ProtonAccountLimit.matchesLogin(null, 'jane')).toBe(false);
    expect(ProtonAccountLimit.matchesLogin(acct({ email: null }), 'jane')).toBe(true);
  });

  it('isUnusable tracks the authError flag', () => {
    expect(ProtonAccountLimit.isUnusable(acct())).toBe(false);
    expect(ProtonAccountLimit.isUnusable(acct({ authError: 'reauth' }))).toBe(true);
  });
});
