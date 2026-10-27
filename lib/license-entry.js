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
 * Mail Checker takes a Paddle transaction ID too: background/premium.js
 * resolves it to its subscription through the proxy's /txn-to-sub. A
 * subscription ID wins when the text holds both, as the success page or a
 * receipt can, and only a transaction ID that is cut short or mistyped gets
 * a message of its own.
 *
 * Beside the ID found, a subscription ID begun (a prefix and a character an
 * ID starts with) refuses it, however little of it there is, and so does a
 * transaction ID begun beside a transaction ID: the field keeps its text
 * when an activation fails, so a new paste next to an earlier entry must
 * never have the earlier ID checked again in its place. A transaction ID
 * begun apart from a subscription ID is the receipt's and is let through;
 * run straight into its front, it refuses it too. A link's token parameter
 * is left out of that search. An email address is never read as an ID, as
 * part of one or as an ID begun: its local part is taken out before the text
 * is searched for an ID and before what is left over is searched for
 * another, so an ID run straight into an address goes with the address.
 * When the text holds no ID, every email address is taken out before it is
 * searched for a mistyped ID. Text longer than MAX_CHARS is not searched at
 * all.
 *
 * Shared by background/premium.js, the authority (the proxy never gets
 * anything but a well-formed ID), and options/options.js. Pure: no browser
 * API and no logging. A result holds its kind and, for an ID, that ID, never
 * the text it came from. Log the kind and the text's length, nothing else:
 * the text may be an email address, and an ID is a license key.
 */
const ProtonLicenseEntry = (() => {
  'use strict';

  // The longest text searched for an ID, in UTF-16 units once cleaned. A
  // pasted receipt, a customer-portal link with its token (about 1,500
  // characters) or an Outlook safelink around one fits easily. No paste that
  // holds an ID needs more, so longer text is something else, answered as
  // too long and not searched. The options page's field takes any length, so
  // a longer paste gets that answer instead of being cut short without a word.
  const MAX_CHARS = 5000;

  // Paddle IDs are ULIDs: 26 lowercase Crockford base32 characters (no i, l,
  // o or u), the first one 0-7. Mirrors KEY_PATTERN and TXN_PATTERN in
  // background/premium.js; change them together.
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
  const TXN_ID = /txn_[0-7][0-9a-hjkmnp-tv-z]{25}(?:(?=txn_|sub_)|(?![0-9a-z_])(?!(?<=txn)-))/g;
  // A whole subscription ID run straight into the front of a transaction ID,
  // where SUB_ID cannot find it, and a whole transaction ID, within some text
  // or as all of it.
  const WHOLE_SUB_ID = 'sub_[0-7][0-9a-hjkmnp-tv-z]{25}';
  const WHOLE_TXN_ID = /txn_[0-7][0-9a-hjkmnp-tv-z]{25}/;
  const ONLY_TXN_ID = /^txn_[0-7][0-9a-hjkmnp-tv-z]{25}$/;

  // What can be left of another subscription ID once the one found is taken
  // out: a prefix ("-" is a common typo) and a character an ID can start
  // with, or a prefix alone at the very end (typed after the ID, the start of
  // a new one). A prefix followed by anything else ("sub_" typed in front of
  // a link, a label or an email address) is not.
  const BROKEN_ID = /sub[_-][0-7]|sub[_-]$/;
  // The same beside a transaction ID, of either kind, but no prefix alone at
  // the end: "txn_" or "sub_" typed after the ID is let through. A
  // subscription ID begun there is what the customer meant, so the
  // transaction ID is not looked up in its place.
  const BROKEN_TXN_ID = /txn[_-][0-7]/;
  const BROKEN_SUB_ID = /sub[_-][0-7]/;

  // Something meant as an ID but cut short or mistyped, and the prefix
  // alone, as customers type it before giving up.
  const SUB_LIKE = /sub[_-][0-9a-z]+/;
  const SUB_PREFIX = /sub[_-]/;
  const TXN_LIKE = /txn[_-][0-9a-z]+/;
  const TXN_PREFIX = /txn[_-]/;
  const PLAY_ORDER = /gpa\.[0-9]{4}-[0-9]{4}-[0-9]{4}-[0-9]{5}/;
  // Whitespace in these patterns is the ASCII kind alone (space, tab, line
  // feed, vertical tab, form feed, carriage return): _cleaned() turns every
  // other space into a plain one or drops it, and \s would also take in any
  // space a newer Unicode adds.
  // The plain address pattern, [^\s@]+@[^\s@]+\.[a-z]{2,}, tried from every
  // character, takes seconds on a long paste with no space or "@" in it (a
  // link, say). A match can only start where a run of such characters starts
  // (EMAIL), or, when addresses are taken out, right where the previous one
  // ended (EMAIL_AT): tried just there, the matches are the same.
  const EMAIL = /(?<![^\t\n\v\f\r @])[^\t\n\v\f\r @]+@[^\t\n\v\f\r @]+\.[a-z]{2,}/g;
  const EMAIL_AT = /[^\t\n\v\f\r @]+@[^\t\n\v\f\r @]+\.[a-z]{2,}/y;
  const WHITESPACE = /[\t\n\v\f\r ]+/g;
  // An email address's local part: the ASCII letters, digits, ".", "_", "+",
  // "'" and "-" in front of its "@", or of the "%40" or "%2540" a link or a
  // link inside a link writes for it, from where such a run starts, whether
  // a domain follows or not. Taken out before the text is searched for an ID
  // (_idsIn) and before what is left over is searched for another
  // (_searched), so an address is never read as an ID, as part of one or as
  // an ID begun: a cut-short ID is not made whole with the start of an
  // address after it, with or without a space between, and "me+sub_3@"
  // beside an ID is no second one begun. An ID run straight into an address
  // goes with it. Only the local part goes: the domain after the "@" holds no
  // ID in a real address, and is read as other text is. The "@" left in its
  // place ends what comes before it, so an ID split by a line wrap is found
  // with an address after it. The other characters an address may hold, such
  // as "=", "&" or "?", are left out: in a link or a sentence they stand
  // right in front of one ("&email="). A local part that holds one of them,
  // or any other character (an accented letter, or a "+" a link writes as
  // "%2B"), is taken out only from the character after it, and one that a
  // line wrap or a space breaks only from the break: what comes before is
  // read as a word in front of an address. Tried only where a run of such
  // characters starts, so a long run without an "@" is read from its start
  // only, not again from every character in it.
  const LOCAL_PART = /(?<![0-9a-z._+'-])[0-9a-z._+'-]+(?=@|%40|%2540)/g;
  // A link's token parameter. The payment-method link in Paddle's email
  // carries a base64url one of about 1,300 characters, whose random letters
  // can spell "sub-3" or "txn_5": read as a broken second ID, the link would
  // be refused. Left out wherever what is left over is searched for one,
  // never where the ID itself is searched for. Also in its percent-encoded
  // form, as in an Outlook safelink (%26token%3d); the value ends at "%",
  // which base64url never has.
  const URL_TOKEN = /(?:(?<=[?&])|(?<=%26)|(?<=%3f))token(?:=|%3d)[^&%\t\n\v\f\r ]*/g;
  // NEL, the Ogham space mark and the line and paragraph separators, which
  // NFKC keeps: made plain spaces, so they split the text as other
  // whitespace does.
  const SEPARATORS = /[\u0085\u1680\u2028\u2029]/g;
  // Unicode format characters (Cf), all invisible, that a copy can carry
  // along: zero-width space, byte order mark, soft hyphen, word joiner, bidi
  // marks.
  const FORMAT = /\p{Cf}/gu;
  // Every Unicode space, line and paragraph separator: with ASCII whitespace
  // and the information separators U+001C to U+001F (which trim() would
  // leave), what is trimmed off either end (_isEdge).
  const SPACE_SEPARATOR = /[\p{Zs}\p{Zl}\p{Zp}]/u;

  /** Every kind parse() gives. */
  const KINDS = Object.freeze([
    'valid', 'valid_in_text', 'empty', 'too_long', 'several_ids', 'play_order',
    'mistyped_txn_id', 'mistyped_sub_id', 'email', 'not_an_id',
  ]);

  /**
   * Read the field's text. One ID gives { kind: 'valid', id }, or kind
   * 'valid_in_text' when other text came with it, the ID in lower case as the
   * proxy expects it. Anything else gives { kind } alone: 'empty',
   * 'too_long' (over MAX_CHARS once cleaned), 'several_ids' (two different
   * IDs), 'play_order', 'mistyped_txn_id', 'mistyped_sub_id', 'email' or
   * 'not_an_id'.
   */
  function parse(raw) {
    const text = _cleaned(raw);
    if (!text) return { kind: 'empty' };
    if (text.length > MAX_CHARS) return { kind: 'too_long' };
    const ids = _idsIn(SUB_ID, text);
    if (ids.length) return _subscriptionEntry(text, ids);
    // No subscription ID: a transaction ID, which the background looks up.
    const txnIds = _idsIn(TXN_ID, text);
    if (txnIds.length) return _transactionEntry(text, txnIds);
    return _withoutId(text);
  }

  // A transaction ID beside the subscription ID is not looked at: the
  // success page or a receipt can show both, and the subscription ID is the
  // one wanted. A broken second subscription ID, or a transaction ID run
  // straight into this one's front, refuses it: typically a new paste next to
  // an earlier entry, which must not be checked again in place of the paste.
  //
  // What is left over is read as _searched gives it, each copy of the ID taken
  // out (a line wrap can split one) together with any "sub_" typed right in
  // front of it: the field says IDs start with "sub_", so "sub_" and then a
  // pasted ID is still that ID. Not tried where a prefix that itself follows
  // a "_" or "-" comes right before (from a run's third prefix on): a run is
  // read from its first two prefixes only, not again from every one in it.
  // The same copies are taken out, since an ID holds no "_" or "-" past its
  // own prefix.
  //
  // The two searches for a transaction ID run into the ID's front read the
  // text as it is. Their runs cannot cross an "@", so they see an address
  // only when its local part itself holds a copy of the ID, which stays a
  // refusal; _transactionEntry reads a subscription ID run into its front the
  // same way.
  function _subscriptionEntry(text, ids) {
    if (ids.length > 1) return { kind: 'several_ids' };
    const id = ids[0];
    const leftover = _searched(text).replace(_copies('sub', id), ' ');
    if (BROKEN_ID.test(leftover)) return { kind: 'mistyped_sub_id' };
    // A whole transaction ID run straight into the ID's front, with a line
    // wrap or a space inside it (copied from the invoice) but none between it
    // and the ID: two IDs. With whitespace between the two it is a receipt
    // line, where the subscription ID decides.
    const spread = new RegExp('txn_[0-9a-z\\t\\n\\v\\f\\r ]*[0-9a-z]' + id).exec(text);
    if (spread && ONLY_TXN_ID.test(spread[0].slice(0, -id.length).replace(WHITESPACE, ''))) {
      return { kind: 'several_ids' };
    }
    // Any other one run into it: two IDs when it is whole, a mistyped
    // transaction ID when not (the "txn-" typo included). "txn_" alone in
    // front is a typed prefix, as "sub_" is.
    const against = new RegExp('txn[_-][0-9a-z]+' + id).exec(text);
    if (against) {
      return { kind: ONLY_TXN_ID.test(against[0].slice(0, -id.length)) ? 'several_ids' : 'mistyped_txn_id' };
    }
    return _valid(text, id);
  }

  // The text holds no subscription ID that SUB_ID finds. A whole one run
  // straight into the transaction ID's front, where SUB_ID cannot see it,
  // makes two IDs, as a transaction ID run into a subscription ID's front
  // does. What is left over is read as for a subscription ID: another whole
  // transaction ID there (one split by a line wrap, which the first search
  // cannot see) makes two; a broken one is a mistyped transaction ID, so the
  // first is not looked up in place of what was pasted; and a subscription ID
  // begun there is what the customer meant, so that one is the mistyped ID.
  function _transactionEntry(text, txnIds) {
    if (txnIds.length > 1) return { kind: 'several_ids' };
    const id = txnIds[0];
    if (new RegExp(WHOLE_SUB_ID + id).test(text)) return { kind: 'several_ids' };
    const leftover = _searched(text).replace(_copies('txn', id), ' ');
    if (WHOLE_TXN_ID.test(leftover)) return { kind: 'several_ids' };
    if (BROKEN_TXN_ID.test(leftover)) return { kind: 'mistyped_txn_id' };
    if (BROKEN_SUB_ID.test(leftover)) return { kind: 'mistyped_sub_id' };
    return _valid(text, id);
  }

  // No ID: named as well as it can be. Email addresses are taken out before
  // the text is searched for a mistyped ID, so "sub_" typed in front of an
  // address (as customers type it) is answered as an email address,
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
  // plain ones, the separators NFKC keeps become spaces, and the format
  // characters are dropped. toLowerCase() ignores the locale, so a Turkish
  // system gets no dotless i.
  function _cleaned(raw) {
    if (typeof raw !== 'string') return '';
    return _trimmed(raw.normalize('NFKC').replace(SEPARATORS, ' ').replace(FORMAT, '')).toLowerCase();
  }

  // Walked in from both ends: a pattern anchored at the end would read a long
  // run of spaces inside the text again from every position in it.
  function _trimmed(s) {
    let start = 0;
    let end = s.length;
    while (start < end && _isEdge(s[start])) start++;
    while (end > start && _isEdge(s[end - 1])) end--;
    return s.slice(start, end);
  }

  // Tab to carriage return (0x09 to 0x0D), the information separators (0x1C
  // to 0x1F), or a space or separator.
  function _isEdge(c) {
    const code = c.charCodeAt(0);
    return (code >= 0x09 && code <= 0x0D) || (code >= 0x1C && code <= 0x1F) || SPACE_SEPARATOR.test(c);
  }

  // Whitespace kept first, so the lookahead ends an ID at the space in
  // "sub_... is my ID". Only when that finds nothing is the text searched
  // again without it, for an ID broken by a space or a line wrap. Both read
  // the text without the local part of any email address (LOCAL_PART). The
  // same ID twice is one ID.
  function _idsIn(pattern, text) {
    const searched = text.replace(LOCAL_PART, '');
    const ids = _distinct(searched, pattern);
    return ids.length ? ids : _distinct(searched.replace(WHITESPACE, ''), pattern);
  }

  // matchAll starts where the pattern's lastIndex is: from the start, whatever
  // used the pattern last.
  function _distinct(s, pattern) {
    pattern.lastIndex = 0;
    return [...new Set(Array.from(s.matchAll(pattern), (m) => m[0]))];
  }

  // The text as what is left over is searched: without a link's token, the
  // local part of any email address and whitespace, in that order. The local
  // parts go while whitespace still parts them from what stands before them:
  // once it is gone, a broken second ID in front of an address
  // ("sub_07h0 name@") would run into the local part and go with it.
  function _searched(text) {
    return text.replace(URL_TOKEN, '').replace(LOCAL_PART, '').replace(WHITESPACE, '');
  }

  // Every copy of the ID with any run of prefixes typed in front of it, not
  // tried from a run's third prefix on. An ID is only letters, digits and
  // "_", nothing a pattern reads as syntax.
  function _copies(prefix, id) {
    return new RegExp('(?<![_-]' + prefix + '[_-])(?:' + prefix + '[_-])*' + id, 'g');
  }

  // Every email address in the text replaced by a space, and whether there
  // was one.
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
      rest += text.slice(pos, m.index) + ' ';
      pos = m.index + m[0].length;
    }
  }

  function _valid(text, id) {
    return { kind: text === id ? 'valid' : 'valid_in_text', id };
  }

  return { parse, KINDS, MAX_CHARS };
})();
