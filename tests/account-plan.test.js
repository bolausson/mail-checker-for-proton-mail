/**
 * Free or paid, from the User object.
 *
 * Every session-expiry report we have is a FREE account; the accounts that
 * never expire are all paid. A diagnostic log that does not say which is which
 * cannot settle that, and asking each user is a round trip. See
 * background/accounts.js `_planFromUser`.
 *
 * The two traps this guards:
 *   1. `Subscribed` is a product BITMASK, not a boolean. A Drive-only plan is
 *      paid while paid MAIL is false, and mail is what we are asking about.
 *   2. A business MEMBER has Subscribed = 0 while the ORGANISATION pays.
 *      WebClients' isPaid() is a bare `!!Subscribed`, so that test alone calls
 *      a paying customer "free".
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const SRC = readFileSync(join(__dirname, '..', 'background', 'accounts.js'), 'utf-8');

function lift(name) {
  // indexOf, not a regex: a backslash-escaped paren does not survive being
  // written through a shell heredoc, and the mangled version compiled to an
  // unterminated group.
  const start = SRC.indexOf('function ' + name + '(');
  if (start === -1) throw new Error('not found: ' + name);
  let i = SRC.indexOf('{', start);
  let depth = 0;
  for (; i < SRC.length; i++) {
    if (SRC[i] === '{') depth++;
    else if (SRC[i] === '}') { depth--; if (depth === 0) return SRC.slice(start, i + 1); }
  }
  throw new Error('unbalanced braces reading ' + name);
}

const planFromUser = new Function(lift('_planFromUser') + '\nreturn _planFromUser;')();

// PRODUCT_BIT from WebClients packages/shared/lib/constants.ts
const BIT = { MAIL: 1, DRIVE: 2, VPN: 4, PASS: 8, WALLET: 16, NEUTRON: 32, LUMO: 64, MEET: 256 };

describe('the ordinary cases', () => {
  it('calls Subscribed = 0 with role 0 free', () => {
    expect(planFromUser({ Subscribed: 0, Role: 0 })).toMatchObject({ tier: 'free', paidMail: false });
  });

  it('calls a Mail subscriber paid, with paid mail', () => {
    expect(planFromUser({ Subscribed: BIT.MAIL, Role: 2 }))
      .toMatchObject({ tier: 'paid', paidMail: true });
  });

  it('reports the raw bitmask so a plan can be identified later', () => {
    const bundle = BIT.MAIL | BIT.DRIVE | BIT.VPN | BIT.PASS;
    expect(planFromUser({ Subscribed: bundle, Role: 2 }).subscribed).toBe(bundle);
  });
});

describe('paid is not the same as paid MAIL', () => {
  it('marks a Drive-only subscriber paid but not paid mail', () => {
    // The question is always about MAIL sessions, so collapsing these would
    // put a Drive-only user in the wrong bucket.
    expect(planFromUser({ Subscribed: BIT.DRIVE, Role: 2 }))
      .toMatchObject({ tier: 'paid', paidMail: false });
  });

  it('same for VPN-only, the most common paid-but-not-mail case', () => {
    expect(planFromUser({ Subscribed: BIT.VPN, Role: 2 }))
      .toMatchObject({ tier: 'paid', paidMail: false });
  });

  it('reads the mail bit out of a bundle', () => {
    expect(planFromUser({ Subscribed: BIT.MAIL | BIT.VPN, Role: 2 }).paidMail).toBe(true);
    expect(planFromUser({ Subscribed: BIT.DRIVE | BIT.VPN, Role: 2 }).paidMail).toBe(false);
  });

  it('is not fooled by a high bit that happens to be set', () => {
    // MEET = 256. A naive truthiness test on the wrong bit would call this
    // paid mail.
    expect(planFromUser({ Subscribed: BIT.MEET, Role: 2 }).paidMail).toBe(false);
  });
});

describe('the organisation-member trap', () => {
  it('does NOT call a business member free', () => {
    // Subscribed = 0 but the organisation pays. `!!Subscribed` alone, which is
    // what WebClients' isPaid() does, would label this a free account.
    expect(planFromUser({ Subscribed: 0, Role: 1 }).tier).toBe('org-member');
  });

  it('keeps an admin with a subscription as plain paid', () => {
    expect(planFromUser({ Subscribed: BIT.MAIL, Role: 2 }).tier).toBe('paid');
  });

  it('treats a member who also subscribes personally as paid', () => {
    expect(planFromUser({ Subscribed: BIT.MAIL, Role: 1 }).tier).toBe('paid');
  });
});

describe('missing or malformed data', () => {
  it('says unknown rather than guessing free when Subscribed is absent', () => {
    // Reporting a missing field as "free" would quietly corrupt the very
    // comparison this exists to make.
    expect(planFromUser({ Role: 0 }).tier).toBe('unknown');
    expect(planFromUser({ Role: 0 }).paidMail).toBeNull();
  });

  it('still identifies an org member when Subscribed is absent', () => {
    expect(planFromUser({ Role: 1 }).tier).toBe('org-member');
  });

  it('says unknown when neither field is present', () => {
    expect(planFromUser({}).tier).toBe('unknown');
  });

  it('returns null for a missing or non-object user', () => {
    expect(planFromUser(null)).toBeNull();
    expect(planFromUser(undefined)).toBeNull();
    expect(planFromUser('nope')).toBeNull();
  });

  it('ignores a non-numeric Subscribed instead of coercing it', () => {
    // Reported as unknown, not free, for the same reason as the absent case:
    // a value we cannot read is not evidence of anything, and "free" here
    // would corrupt the comparison this field exists to make.
    expect(planFromUser({ Subscribed: '1', Role: 0 }).subscribed).toBeNull();
    expect(planFromUser({ Subscribed: '1', Role: 0 }).tier).toBe('unknown');
    expect(planFromUser({ Subscribed: '1', Role: 0 }).paidMail).toBeNull();
  });
});

describe('delinquency is carried too', () => {
  it('records it, since a lapsed payer can behave like a free account', () => {
    expect(planFromUser({ Subscribed: BIT.MAIL, Role: 2, Delinquent: 3 }).delinquent).toBe(3);
  });

  it('is null when absent rather than 0, which means "not delinquent"', () => {
    expect(planFromUser({ Subscribed: BIT.MAIL, Role: 2 }).delinquent).toBeNull();
  });
});

describe('how it reaches the log', () => {
  it('is recorded on first sight and again only when the plan CHANGES', () => {
    // Deduping per worker generation was no dedup at all: MV3 cold-starts
    // constantly, and a real 5000-entry log came back with 360 account.plan
    // records, 7% of the buffer, crowding out the auth history it exists to
    // hold. The signature has to outlive the worker, so it lives in storage.
    const fn = lift('_recordPlan');
    expect(fn).toMatch(/ProtonDiag\.once\('plan:' \+ account\.id, sig\)/);
    expect(SRC).not.toMatch(/_planRecorded/);
  });

  it('puts every field that matters into the signature', () => {
    // A tier change with the same bitmask, or a delinquency flag flipping,
    // must still be reported.
    const fn = lift('_recordPlan');
    for (const field of ['tier', 'subscribed', 'paidMail', 'role', 'delinquent']) {
      expect(fn).toContain('plan.' + field);
    }
  });

  it('costs no extra API call', () => {
    // core/v4/users is already fetched for the keys; the plan rides along.
    const at = SRC.indexOf('_recordPlan(account, userResult && userResult.User)');
    expect(at).toBeGreaterThan(-1);
    const before = SRC.slice(at - 700, at);
    expect(before).toMatch(/request\(accountId, 'GET', 'core\/v4\/users'\)/);
  });

  it('cannot break the unlock', () => {
    const at = SRC.indexOf('_recordPlan(account, userResult && userResult.User)');
    expect(SRC.slice(at - 200, at + 200)).toMatch(/catch/);
  });
});
