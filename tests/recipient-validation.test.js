/**
 * Recipient address validation.
 *
 * Typing "someone@examplecom" sent the message all the way to Proton's recipient
 * key lookup, which errors on an address like that. The send path correctly
 * refuses to guess whether an unknown recipient is internal or external, so it
 * aborted, and the user was shown "Check your connection and try again" for
 * what was a missing dot. Catching it in the composer keeps that guard for
 * genuine lookup failures and puts the typo where it can be seen.
 *
 * The check is deliberately loose. It is not RFC 5321: it only has to be sure
 * that a rejected address could not be delivered by anyone.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const SRC = readFileSync(join(__dirname, '..', 'popup', 'popup.js'), 'utf-8');

function lift(name) {
  const start = SRC.indexOf('function ' + name + '(');
  if (start === -1) throw new Error('function not found in popup.js: ' + name);
  let i = SRC.indexOf('{', start);
  let depth = 0;
  for (; i < SRC.length; i++) {
    if (SRC[i] === '{') depth++;
    else if (SRC[i] === '}') { depth--; if (depth === 0) return SRC.slice(start, i + 1); }
  }
  throw new Error('unbalanced braces reading ' + name);
}

let ok;
beforeAll(() => {
  ok = new Function(lift('_looksLikeEmail') + '\nreturn _looksLikeEmail;')();
});

describe('addresses that must be accepted', () => {
  const good = [
    'someone@example.com',
    'alex@example.org',
    'first.last@example.co.uk',
    'alias+shop@proton.me',
    'x@a.io',
    'user_name@sub.domain.example.com',
    'UPPER@EXAMPLE.COM',
    'user@example.xn--p1ai',          // punycode TLD
    "o'brien@example.com",            // apostrophes are legal in a local part
  ];
  for (const a of good) {
    it('accepts ' + a, () => expect(ok(a)).toBe(true));
  }

  it('tolerates surrounding whitespace', () => {
    expect(ok('  someone@example.com  ')).toBe(true);
  });
});

describe('addresses that cannot be delivered', () => {
  const bad = [
    ['someone@examplecom', 'the reported typo: no dot in the domain'],
    ['user@example', 'single-label domain'],
    ['user@.com', 'domain starts with a dot'],
    ['user@-example.com', 'domain starts with a hyphen'],
    ['user@example..com', 'empty label'],
    ['@example.com', 'no local part'],
    ['user@', 'no domain'],
    ['user', 'no @ at all'],
    ['a@b@c.com', 'two @ signs'],
    ['user name@example.com', 'space in the local part'],
    ['user@exam ple.com', 'space in the domain'],
    ['', 'empty'],
    ['   ', 'whitespace only'],
    ['user@example.', 'trailing dot, no TLD'],
    ['user@example.c', 'one-character TLD'],
  ];
  for (const [a, why] of bad) {
    it('rejects "' + a + '" (' + why + ')', () => expect(ok(a)).toBe(false));
  }

  it('rejects user@localhost, which is deliberate', () => {
    // Valid on a local MTA, but this client sends through Proton to the
    // internet, where a single-label domain cannot be routed.
    expect(ok('user@localhost')).toBe(false);
  });
});

describe('junk input never throws', () => {
  for (const v of [null, undefined, 0, {}, []]) {
    it('handles ' + JSON.stringify(v), () => expect(() => ok(v)).not.toThrow());
  }
});
