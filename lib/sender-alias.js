/**
 * ProtonSenderAlias: sending as a +alias of one of the account's own
 * addresses (name+shop@domain is delivered to name@domain).
 *
 * Proton keeps no list of +aliases: any tag reaches the address it is added
 * to, and the API accepts one as the sender of a new mail, a reply or a
 * forward, sent with that address's AddressID and signed with its keys.
 * Only an address that is enabled and may both send and receive can carry
 * one, as in Proton's own clients, and not an external (bring your own)
 * address.
 *
 * Shared by the background, which sends, and the popup, which offers the
 * choice, so both read an alias the same way. Pure: no browser APIs.
 */
const ProtonSenderAlias = (() => {
  'use strict';

  // The longest local part an address may have (RFC 5321).
  const MAX_LOCAL = 64;
  // A tag the user types: letters, digits, "_" and "-", in parts joined by
  // single dots, so it neither starts nor ends with a dot.
  const TYPED_TAG = /^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*$/;
  // A tag taken from a mail that was delivered to it: anything an address may
  // hold, since it reached the account already, but no control, bidi or
  // invisible character (\p{C}): the To, CC and BCC lists are the sender's.
  const RECEIVED_TAG = /^[^\s@<>()[\]\\,;:"\p{C}]+$/u;
  const ADDRESS_TYPE_EXTERNAL = 5;

  function _split(email) {
    const s = String(email || '').trim();
    const at = s.lastIndexOf('@');
    if (at <= 0 || at === s.length - 1) return null;
    return { local: s.slice(0, at), domain: s.slice(at + 1) };
  }

  /**
   * Whether `address` can carry a +alias. The background reads Proton's own
   * Address fields; the popup gets CanAlias, worked out the same way.
   */
  function canCarry(address) {
    if (!address || !address.Email) return false;
    if (typeof address.CanAlias === 'boolean') return address.CanAlias;
    return address.Status === 1 && address.Send === 1 && address.Receive === 1
      && address.Type !== ADDRESS_TYPE_EXTERNAL;
  }

  /** The own address `email` is a +alias of, as { base, tag }, or null. */
  function parse(email, addresses) {
    const p = _split(email);
    if (!p) return null;
    const plus = p.local.indexOf('+');
    if (plus <= 0 || plus === p.local.length - 1) return null;
    const baseLocal = p.local.slice(0, plus).toLowerCase();
    const domain = p.domain.toLowerCase();
    const base = (addresses || []).find((a) => {
      const q = _split(a && a.Email);
      return !!q && q.local.toLowerCase() === baseLocal && q.domain.toLowerCase() === domain;
    });
    return base ? { base, tag: p.local.slice(plus + 1) } : null;
  }

  /**
   * Whether `tag` may follow the "+" of `baseEmail`: a typed tag must keep to
   * TYPED_TAG, and either way the local part stays within MAX_LOCAL.
   */
  function validTag(tag, baseEmail, { typed = true } = {}) {
    const t = String(tag || '');
    if (!(typed ? TYPED_TAG : RECEIVED_TAG).test(t)) return false;
    const p = _split(baseEmail);
    return !!p && p.local.length + 1 + t.length <= MAX_LOCAL;
  }

  /** `baseEmail` with `tag` added, the base as the account writes it. */
  function build(baseEmail, tag) {
    const p = _split(baseEmail);
    return p ? p.local + '+' + tag + '@' + p.domain : '';
  }

  /**
   * A chosen sender checked against the account's addresses: one of them
   * ({ ok, email, base, alias: false }) or a +alias of one that can carry it
   * ({ ok, email, base, alias: true }, the base part as the account writes
   * it). Anything else is { ok: false }. `typed` holds the tag to TYPED_TAG.
   */
  function resolve(email, addresses, { typed = false } = {}) {
    const s = String(email || '').trim();
    const own = (addresses || []).find((a) => a && a.Email && a.Email.toLowerCase() === s.toLowerCase());
    if (own) return { ok: true, email: own.Email, base: own, alias: false };
    const parsed = parse(s, addresses);
    if (!parsed || !canCarry(parsed.base) || !validTag(parsed.tag, parsed.base.Email, { typed })) {
      return { ok: false };
    }
    return { ok: true, email: build(parsed.base.Email, parsed.tag), base: parsed.base, alias: true };
  }

  // Every address in an X-Original-To header (one value, or a list of them).
  function _headerAddresses(value) {
    const out = [];
    for (const v of [].concat(value || [])) {
      for (const m of String(v).matchAll(/[^\s<>,;"]+@[^\s<>,;"]+/g)) out.push(m[0]);
    }
    return out;
  }

  /**
   * The +alias `msg` was sent to, as { email, base }, when it is one of the
   * address the mail was delivered to (its AddressID) and that address can
   * carry it; the base part as the account writes it. The X-Original-To
   * header comes first, its first value as in Proton's own client: it names
   * the address the mail was delivered to, also for BCC and for mail from a
   * list. Then the To, CC and BCC lists. Else null. A +alias of another of
   * the user's addresses named in the lists is not taken: the reply would go
   * out from an identity the mail was not sent to.
   */
  function detect(msg, addresses) {
    if (!msg) return null;
    const headers = msg.ParsedHeaders || {};
    const key = Object.keys(headers).find((k) => k.toLowerCase() === 'x-original-to');
    const candidates = _headerAddresses(key ? [].concat(headers[key])[0] : '')
      .concat([].concat(msg.ToList || [], msg.CCList || [], msg.BCCList || []).map((r) => r && r.Address));
    for (const c of candidates) {
      const parsed = parse(c, addresses);
      if (parsed && (!msg.AddressID || parsed.base.ID === msg.AddressID) && canCarry(parsed.base)
        && validTag(parsed.tag, parsed.base.Email, { typed: false })) {
        return { email: build(parsed.base.Email, parsed.tag), base: parsed.base };
      }
    }
    return null;
  }

  /**
   * An address as the send log keeps it: an alias's tag is replaced by its
   * length, so the log never names the shop or service a tag stands for.
   */
  function forLog(email) {
    const p = _split(email);
    if (!p) return String(email || '');
    const plus = p.local.indexOf('+');
    if (plus < 0) return p.local + '@' + p.domain;
    return p.local.slice(0, plus) + '+<' + (p.local.length - plus - 1) + '>@' + p.domain;
  }

  return { MAX_LOCAL, canCarry, parse, validTag, build, resolve, detect, forLog };
})();

if (typeof window !== 'undefined') window.ProtonSenderAlias = ProtonSenderAlias;
