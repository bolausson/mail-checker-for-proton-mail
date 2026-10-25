/**
 * ProtonLicenseEntry: what the text in the license key field is.
 *
 * Customers paste whatever they find in Paddle's emails, on the checkout's
 * success page or in the customer portal: the subscription ID alone, a line
 * or a link with the ID in it, the transaction ID from the invoice, but also
 * a Google Play order number or their email address. parse() names the text
 * and finds the ID in it, so the options page can answer at once and send
 * the ID alone.
 *
 * Ported from Sync for Proton 2.0.2 (SubscriptionEntry.kt), so that both apps
 * read the same text the same way. Like Sync, Mail Checker takes a Paddle
 * transaction ID too: background/premium.js resolves it to its subscription
 * through the proxy's /txn-to-sub. A subscription ID wins when the text holds
 * both, as the success page or a receipt can, and only a transaction ID that
 * is cut short or mistyped gets a message of its own.
 *
 * Where the answers differ from Sync's, on purpose: a copy of the ID cut
 * short (shown shortened beside it, say), or a piece too short to be an ID
 * (a "txn_1" label), is passed over beside an ID the text shows whole; an
 * email address with the start of an ID in its local part (a link run into
 * it) is not taken out before the search for a mistyped ID; a prefix typed
 * after a transaction ID is refused, as after a subscription ID; and an ID
 * never ends in "txn" right before a "-" either.
 *
 * Shared by background/premium.js, the authority (the proxy never gets
 * anything but a well-formed ID), and options/options.js. Pure: no browser
 * API and no logging. A result holds its kind and, for an ID, that ID, never
 * the text it came from. Log the kind and the text's length, nothing else:
 * the text may be an email address, and an ID is a license key.
 */
const ProtonLicenseEntry = (() => {
  'use strict';

  // Paddle IDs are ULIDs: 26 lowercase Crockford base32 characters (no i, l,
  // o or u), the first one 0-7. Mirrors KEY_PATTERN and TXN_PATTERN in
  // background/premium.js and the proxy's own check; change them together.
  // Nothing is required in front of an ID: in an Outlook safelink it follows
  // "%3D". The lookahead keeps a 27-character typo from being cut silently to
  // 26, except where another ID starts: a whole new ID pasted straight
  // against an earlier one is then found as a second ID, and a broken one is
  // caught by what is left over. A subscription ID does not end where a
  // "txn_" starts, so a transaction ID run straight after it is found on its
  // own and the two make two IDs (_transactionEntry). Nor does an ID end right
  // before "_", or in "txn" right before "-": t, x and n are base32 letters,
  // so an ID cut short by three and run into "txn_" or "txn-" would otherwise
  // pass as whole.
  const SUB_ID = /sub_[0-7][0-9a-hjkmnp-tv-z]{25}(?:(?=sub_)|(?![0-9a-z_])(?!(?<=txn)-))/g;
  const TXN_ID = /txn_[0-7][0-9a-hjkmnp-tv-z]{25}(?:(?=sub_|txn_)|(?![0-9a-z_])(?!(?<=txn)-))/g;
  const WHOLE_SUB_ID = /^sub_[0-7][0-9a-hjkmnp-tv-z]{25}$/;
  // What follows the prefix of a whole ID, at the start of what is read.
  const WHOLE_BODY = /^[0-7][0-9a-hjkmnp-tv-z]{25}/;
  // A prefix ("-" is a typo seen in the proxy's logs) and the start of an ID:
  // what can be left of another ID once the one found is taken out. Only the
  // prefix is matched, so prefixes typed one after another are each seen.
  const FRAGMENT = /(sub|txn)[_-](?=([0-7][0-9a-z]*))/g;
  const PREFIX_AT_END = /(sub|txn)[_-]$/;
  // A ULID's first ten characters are its time, so two IDs made close
  // together can share them. A piece with more than that, all of it the start
  // of the ID found, is a copy of that ID cut short; a piece with no more than
  // that says too little to be a second ID.
  const PAST_TIME = 11;

  // Something meant as an ID but cut short or mistyped, and the prefix
  // alone, as customers type it before giving up.
  const SUB_LIKE = /sub[_-][0-9a-z]+/;
  const SUB_PREFIX = /sub[_-]/;
  const TXN_LIKE = /txn[_-][0-9a-z]+/;
  const TXN_PREFIX = /txn[_-]/;
  const PLAY_ORDER = /gpa\.[0-9]{4}-[0-9]{4}-[0-9]{4}-[0-9]{5}/;
  // Sync's email pattern, [^\s@]+@[^\s@]+\.[a-z]{2,}, is tried from every
  // character, which took seconds on a long paste with no space or "@" in it
  // (a link, say). A match can only start where a run of such characters
  // starts (EMAIL), or, when addresses are taken out, right where the
  // previous one ended (EMAIL_AT): tried just there, the matches are Sync's.
  const EMAIL = /(?<![^\s@])[^\s@]+@[^\s@]+\.[a-z]{2,}/g;
  const EMAIL_AT = /[^\s@]+@[^\s@]+\.[a-z]{2,}/y;
  // The start of an ID in what reads as an address's local part: a link or a
  // label run into the address ("...?_ptxn=txn_...&email=name@..."), not a
  // prefix typed in front of it.
  const ID_START = /(?:sub|txn)[_-][0-7]/;
  const WHITESPACE = /\s+/g;
  const SPACE = /\s/;
  const ID_CHAR = /[0-9a-z]/;
  const RUN_CHAR = /[0-9a-z\s]/;
  // Unicode format characters (Cf), all invisible, that a copy can carry
  // along: zero-width space, byte order mark, soft hyphen, word joiner, bidi
  // marks.
  const FORMAT = /\p{Cf}/gu;

  /** Every kind parse() gives. */
  const KINDS = Object.freeze([
    'valid', 'valid_in_text', 'empty', 'several_ids', 'play_order',
    'mistyped_txn_id', 'mistyped_sub_id', 'email', 'not_an_id',
  ]);

  /**
   * Read the field's text. One ID gives { kind: 'valid', id }, or kind
   * 'valid_in_text' when other text came with it, the ID in lower case as the
   * proxy expects it. Anything else gives { kind } alone: 'empty',
   * 'several_ids' (two different IDs), 'play_order', 'mistyped_txn_id',
   * 'mistyped_sub_id', 'email' or 'not_an_id'.
   */
  function parse(raw) {
    const text = _cleaned(raw);
    if (!text) return { kind: 'empty' };
    const flat = text.replace(WHITESPACE, '');
    const subs = _idsIn(SUB_ID, text, flat);
    if (subs.ids.length) return _subscriptionEntry(text, subs);
    // No subscription ID: a transaction ID, which the background looks up.
    const txns = _idsIn(TXN_ID, text, flat);
    if (txns.ids.length) return _transactionEntry(text, txns);
    return _withoutId(text);
  }

  // A transaction ID beside the subscription ID is not looked at: the
  // success page or a receipt can show both, and the subscription ID is the
  // one wanted. A broken second subscription ID, or a transaction ID run
  // straight into this one's front, refuses it: typically a new paste next to
  // an earlier entry (the field keeps its text when an activation fails),
  // which must not be checked again in place of the paste.
  function _subscriptionEntry(text, { ids, shown }) {
    if (ids.length > 1) return { kind: 'several_ids' };
    const id = ids[0];
    const beside = _besideId(_leftover(text, id), id, shown);
    if (beside) return { kind: beside };
    const glued = _txnInFront(text, id);
    if (glued) return { kind: glued };
    return _valid(text, id);
  }

  // A subscription ID begun beside the transaction ID, not a whole one, is
  // what the customer meant, so the transaction ID is not looked up in its
  // place.
  function _transactionEntry(text, { ids, shown }) {
    if (ids.length > 1) return { kind: 'several_ids' };
    const id = ids[0];
    // A whole subscription ID with the transaction ID run straight after it.
    if (_subInFront(text, id)) return { kind: 'several_ids' };
    const beside = _besideId(_leftover(text, id), id, shown);
    if (beside) return { kind: beside };
    return _valid(text, id);
  }

  // No ID: named as well as it can be. Email addresses are taken out before
  // the text is searched for a mistyped ID, so "sub_" typed in front of an
  // address (seen in the proxy's logs) is answered as an email address,
  // while a real attempt at an ID next to one (a receipt line) is still a
  // mistyped ID. A prefix alone is a mistyped ID too.
  function _withoutId(text) {
    const { rest, hasEmail } = _takeOutEmails(text);
    if (PLAY_ORDER.test(text)) return { kind: 'play_order' };
    if (TXN_LIKE.test(rest)) return { kind: 'mistyped_txn_id' };
    if (SUB_LIKE.test(rest)) return { kind: 'mistyped_sub_id' };
    if (hasEmail) return { kind: 'email' };
    if (TXN_PREFIX.test(text)) return { kind: 'mistyped_txn_id' };
    if (SUB_PREFIX.test(text)) return { kind: 'mistyped_sub_id' };
    return { kind: 'not_an_id' };
  }

  // NFKC turns full-width letters and non-breaking or ideographic spaces into
  // plain ones, and the format characters are dropped. toLowerCase() ignores
  // the locale, so a Turkish system gets no dotless i.
  function _cleaned(raw) {
    if (typeof raw !== 'string') return '';
    return raw.normalize('NFKC').replace(FORMAT, '').trim().toLowerCase();
  }

  // Whitespace kept first, so the lookahead ends an ID at the space in
  // "sub_... is my ID". Only when that finds nothing is the text searched
  // again without it, for an ID broken by a space or a line wrap; such an ID
  // is not `shown` whole. The same ID twice is one ID.
  function _idsIn(pattern, text, flat) {
    const ids = _distinct(text, pattern);
    return ids.length ? { ids, shown: true } : { ids: _distinct(flat, pattern), shown: false };
  }

  function _distinct(s, pattern) {
    return [...new Set(Array.from(s.matchAll(pattern), (m) => m[0]))];
  }

  // The text without whitespace, every copy of the ID (a line wrap can split
  // one) replaced by a space, and for each character left whether whitespace
  // stood right before it in the text. A prefix typed right in front of a
  // pasted ID ("sub_" and then the ID, the field says IDs start with "sub_")
  // is then followed by that space, so it never reads as a broken ID. Sync
  // also takes such prefixes out, with a pattern that changes no answer but
  // took seconds on a long run of them.
  function _leftover(text, id) {
    const flat = [];
    const spaced = [];
    let space = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (SPACE.test(c)) {
        space = true;
        continue;
      }
      flat.push(c);
      spaced.push(space);
      space = false;
    }
    const joined = flat.join('');
    const left = [];
    const gaps = [];
    let from = 0;
    for (let at = joined.indexOf(id); at !== -1; at = joined.indexOf(id, at + id.length)) {
      for (let i = from; i < at; i++) {
        left.push(joined[i]);
        gaps.push(spaced[i]);
      }
      left.push(' ');
      gaps.push(spaced[at]);
      from = at + id.length;
    }
    for (let i = from; i < joined.length; i++) {
      left.push(joined[i]);
      gaps.push(spaced[i]);
    }
    return { left: left.join(''), gaps };
  }

  // What is left beside the ID found once every copy of it is taken out:
  // another whole transaction ID beside a transaction ID (one split by a line
  // wrap shows only now) gives 'several_ids'; a broken ID, 'mistyped_txn_id'
  // or 'mistyped_sub_id'; nothing, null. Beside a subscription ID only
  // subscription IDs count: a transaction ID next to it is the receipt's.
  // Beside a transaction ID a subscription ID begun counts too.
  //
  // Beside an ID the text shows whole, a copy of it cut short (shortened for
  // display, say) is passed over, and so is a piece too short to be an ID (a
  // "txn_1" label) that stands apart from it. A short piece run straight into
  // the ID, or at the very end of the text, is a new one begun against the
  // ID (typed or pasted next to an earlier entry), and counts at any length,
  // as does a prefix alone at the very end.
  function _besideId({ left, gaps }, id, shown) {
    const own = id.slice(0, 3);
    let several = false;
    let txn = false;
    let sub = false;
    for (const m of left.matchAll(FRAGMENT)) {
      const kind = m[1];
      const body = m[2];
      if (own === 'sub' && kind === 'txn') continue;
      if (shown && kind === own && _copyOf(body, gaps, m.index + 4, id)) continue;
      const end = m.index + 4 + body.length;
      const against = (left[end] === ' ' && !gaps[end]) || (left[m.index - 1] === ' ' && !gaps[m.index]);
      if (shown && body.length < PAST_TIME && end < left.length && !against) continue;
      if (own === 'txn' && kind === 'txn' && m[0][3] === '_' && WHOLE_BODY.test(body)) several = true;
      else if (kind === 'txn') txn = true;
      else sub = true;
    }
    const last = PREFIX_AT_END.exec(left);
    if (last && last[1] === 'sub') sub = true;
    if (last && last[1] === 'txn' && own === 'txn') txn = true;
    if (several) return 'several_ids';
    if (txn) return 'mistyped_txn_id';
    if (sub) return 'mistyped_sub_id';
    return null;
  }

  // Whether a piece, as far as the text shows it in one go (up to the first
  // whitespace: the text without it runs the next word on), is the ID cut
  // short: more than its time, and all of it the start of the ID.
  function _copyOf(body, gaps, at, id) {
    let upTo = 0;
    while (upTo < body.length && !gaps[at + upTo]) upTo++;
    return upTo >= PAST_TIME && id.startsWith(body.slice(0, upTo), 4);
  }

  // A transaction ID run straight into the front of the subscription ID
  // found, with nothing between the two: no receipt line, but a paste in
  // front of an earlier entry, or the other way round. Two IDs when it is a
  // whole one (a line wrap or a space inside it, from the invoice, allowed),
  // a mistyped transaction ID when a broken one touches the ID. "txn_" alone
  // in front is a typed prefix, as "sub_" is. Walked back from each copy of
  // the ID, so a long paste costs no more than its length.
  function _txnInFront(text, id) {
    for (let at = text.indexOf(id); at !== -1; at = text.indexOf(id, at + id.length)) {
      if (at === 0 || !ID_CHAR.test(text[at - 1])) continue;
      let start = at;
      while (start > 0 && ID_CHAR.test(text[start - 1])) start--;
      const touching = text.slice(Math.max(0, start - 4), start);
      if (touching === 'txn_' || touching === 'txn-') {
        const whole = touching === 'txn_' && at - start === 26 && WHOLE_BODY.test(text.slice(start, at));
        return whole ? 'several_ids' : 'mistyped_txn_id';
      }
      while (start > 0 && RUN_CHAR.test(text[start - 1])) start--;
      if (text.slice(Math.max(0, start - 4), start) !== 'txn_') continue;
      const body = text.slice(start, at).replace(WHITESPACE, '');
      if (body.length === 26 && WHOLE_BODY.test(body)) return 'several_ids';
    }
    return null;
  }

  // A whole subscription ID run straight into the front of the transaction
  // ID found: the subscription ID ends there only because the transaction ID
  // starts, so this is two IDs, never the transaction looked up alone.
  function _subInFront(text, id) {
    for (let at = text.indexOf(id); at !== -1; at = text.indexOf(id, at + id.length)) {
      if (at >= 30 && WHOLE_SUB_ID.test(text.slice(at - 30, at))) return true;
    }
    return false;
  }

  // Every email address in the text replaced by a space, as Sync's
  // EMAIL.replace(text, " ") does it, except one whose local part holds the
  // start of an ID: there a link or a label ran into the address, and the
  // broken ID in it must still be found.
  function _takeOutEmails(text) {
    let rest = '';
    let pos = 0;
    let hasEmail = false;
    for (;;) {
      EMAIL_AT.lastIndex = pos;
      let m = EMAIL_AT.exec(text);
      if (!m) {
        EMAIL.lastIndex = pos;
        m = EMAIL.exec(text);
      }
      if (!m) return { rest: rest + text.slice(pos), hasEmail };
      hasEmail = true;
      const local = m[0].slice(0, m[0].indexOf('@'));
      rest += text.slice(pos, m.index) + (ID_START.test(local) ? m[0] : ' ');
      pos = m.index + m[0].length;
    }
  }

  function _valid(text, id) {
    return { kind: text === id ? 'valid' : 'valid_in_text', id };
  }

  return { parse, KINDS };
})();
