/**
 * lib/sender-alias.js: sending as a +alias of one of the account's own
 * addresses.
 *
 * Proton keeps no list of +aliases. Any tag reaches the address it is added
 * to, and the API accepts one as the sender of a new mail, a reply or a
 * forward that was never sent to it: measured on a test account, with the
 * alias kept as the From and the base address's AddressID and keys. These
 * tests pin how an alias is recognised, which addresses may carry one, and
 * which tags a user may type.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const S = new Function(readFileSync(join(__dirname, '..', 'lib', 'sender-alias.js'), 'utf-8') + '\nreturn ProtonSenderAlias;')();

// Proton's own Address fields, as core/v4/addresses returns them.
const addr = (Email, more = {}) => ({ ID: 'id-' + Email, Email, DisplayName: 'Me', Status: 1, Send: 1, Receive: 1, Type: 1, ...more });
const MAIN = addr('Name@example.com');
const OTHER = addr('other@example.org');
const ADDRESSES = [MAIN, OTHER];

describe('which addresses can carry a +alias', () => {
  it('an enabled address that sends and receives', () => {
    expect(S.canCarry(MAIN)).toBe(true);
  });

  it.each([
    ['disabled', { Status: 0 }],
    ['being deleted', { Status: 2 }],
    ['not allowed to send', { Send: 0 }],
    ['not receiving', { Receive: 0 }],
    ['external (bring your own address)', { Type: 5 }],
  ])('not an address that is %s', (_label, more) => {
    expect(S.canCarry(addr('x@example.com', more))).toBe(false);
  });

  it('the popup decides by CanAlias, which the background works out', () => {
    expect(S.canCarry({ Email: 'x@example.com', CanAlias: true })).toBe(true);
    expect(S.canCarry({ Email: 'x@example.com', CanAlias: false })).toBe(false);
  });
});

describe('recognising a +alias of an own address', () => {
  it('finds the base address whatever the case', () => {
    const p = S.parse('NAME+Shop@EXAMPLE.com', ADDRESSES);
    expect(p.base).toBe(MAIN);
    expect(p.tag).toBe('Shop');
  });

  it.each([
    ['an address without a tag', 'name@example.com'],
    ['an empty tag', 'name+@example.com'],
    ['no local part before the +', '+shop@example.com'],
    ['another domain', 'name+shop@example.net'],
    ['another local part', 'someone+shop@example.com'],
    ['not an address', 'name+shop'],
  ])('not %s', (_label, email) => {
    expect(S.parse(email, ADDRESSES)).toBe(null);
  });
});

describe('the tag a user types', () => {
  it.each(['shop', 'Shop.Test-4', 'a_b', 'x1', 'a.b.c'])('takes %s', (tag) => {
    expect(S.validTag(tag, 'name@example.com')).toBe(true);
  });

  it.each(['', '.shop', 'shop.', 'a..b', 'sh op', 'a+b', 'a@b', 'a=b', 'a/b', 'café'])('refuses %j', (tag) => {
    expect(S.validTag(tag, 'name@example.com')).toBe(false);
  });

  it('keeps the local part within 64 characters', () => {
    // "name" + "+" + tag: 4 + 1 + 59 = 64 fits, one more does not.
    expect(S.validTag('a'.repeat(59), 'name@example.com')).toBe(true);
    expect(S.validTag('a'.repeat(60), 'name@example.com')).toBe(false);
  });

  it('a tag a mail was delivered to may hold more than a typed one', () => {
    expect(S.validTag('a=b', 'name@example.com', { typed: false })).toBe(true);
    expect(S.validTag('a b', 'name@example.com', { typed: false })).toBe(false);
  });
});

describe('the sender chosen, checked against the account', () => {
  it('an own address is itself', () => {
    expect(S.resolve('other@EXAMPLE.org', ADDRESSES)).toEqual({ ok: true, email: OTHER.Email, base: OTHER, alias: false });
  });

  it('a +alias keeps its tag and the base as the account writes it', () => {
    expect(S.resolve('name+Shop@example.com', ADDRESSES)).toEqual(
      { ok: true, email: 'Name+Shop@example.com', base: MAIN, alias: true });
  });

  it('refuses an address that is not the account\'s', () => {
    expect(S.resolve('someone@example.net', ADDRESSES).ok).toBe(false);
    expect(S.resolve('someone+shop@example.net', ADDRESSES).ok).toBe(false);
  });

  it('refuses a +alias of an address that cannot carry one', () => {
    const list = [addr('name@example.com', { Receive: 0 })];
    expect(S.resolve('name+shop@example.com', list).ok).toBe(false);
  });

  it('holds a typed tag to the typed rules', () => {
    expect(S.resolve('name+a=b@example.com', ADDRESSES, { typed: true }).ok).toBe(false);
    expect(S.resolve('name+a=b@example.com', ADDRESSES).ok).toBe(true);
  });

  it('builds a +alias the way Proton writes it', () => {
    expect(S.build('Name@example.com', 'shop')).toBe('Name+shop@example.com');
  });
});

describe('the +alias a mail was sent to', () => {
  const msg = (more) => ({ ToList: [], CCList: [], BCCList: [], ...more });

  it('reads the X-Original-To header first, which also covers BCC and lists', () => {
    const found = S.detect(msg({
      ParsedHeaders: { 'X-Original-To': 'name+list@example.com' },
      ToList: [{ Address: 'list@example.net' }],
    }), ADDRESSES);
    // Written the way the account writes its address, as Proton does.
    expect(found).toEqual({ email: 'Name+list@example.com', base: MAIN });
  });

  it('reads the header whatever its case, and the addresses in its first value', () => {
    const found = S.detect(msg({ ParsedHeaders: { 'x-original-to': ['someone@example.net, name+b@example.com'] } }), ADDRESSES);
    expect(found.email).toBe('Name+b@example.com');
  });

  it('reads only the first X-Original-To value, as Proton does', () => {
    const found = S.detect(msg({ ParsedHeaders: { 'X-Original-To': ['someone@example.net', 'name+second@example.com'] } }), ADDRESSES);
    expect(found).toBe(null);
  });

  it('then the To, CC and BCC lists', () => {
    expect(S.detect(msg({ CCList: [{ Address: 'name+cc@example.com' }] }), ADDRESSES).email).toBe('Name+cc@example.com');
    expect(S.detect(msg({ BCCList: [{ Address: 'name+bcc@example.com' }] }), ADDRESSES).email).toBe('Name+bcc@example.com');
  });

  it('takes only a +alias of the address the mail was delivered to', () => {
    // Delivered to other@example.org; a +alias of Name@ in the To list is
    // another identity of the user's, not the one this mail went to.
    const delivered = msg({ AddressID: OTHER.ID, ToList: [{ Address: 'name+shop@example.com' }, { Address: 'other@example.org' }] });
    expect(S.detect(delivered, ADDRESSES)).toBe(null);
    expect(S.detect(msg({ AddressID: MAIN.ID, ToList: [{ Address: 'name+shop@example.com' }] }), ADDRESSES).email).toBe('Name+shop@example.com');
  });

  it.each([
    ['a bidi override', 'name+a‮b@example.com'],
    ['a zero-width space', 'name+a​b@example.com'],
    ['a control character', 'name+a\u0007b@example.com'],
  ])('refuses a tag with %s', (_label, address) => {
    expect(S.detect(msg({ ToList: [{ Address: address }] }), ADDRESSES)).toBe(null);
  });

  it('finds nothing in mail sent to the address itself', () => {
    expect(S.detect(msg({ ParsedHeaders: { 'X-Original-To': 'name@example.com' }, ToList: [{ Address: 'name@example.com' }] }), ADDRESSES)).toBe(null);
  });

  it('skips a +alias of an address that cannot carry one', () => {
    const list = [addr('name@example.com', { Send: 0 })];
    expect(S.detect(msg({ ToList: [{ Address: 'name+x@example.com' }] }), list)).toBe(null);
  });
});

describe('an address as the send log keeps it', () => {
  it('replaces a tag by its length, so the log never names the shop', () => {
    expect(S.forLog('name+shop@example.com')).toBe('name+<4>@example.com');
  });

  it('keeps an address without a tag', () => {
    expect(S.forLog('name@example.com')).toBe('name@example.com');
  });
});
