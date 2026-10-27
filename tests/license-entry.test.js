/**
 * What the license key field makes of the text a user enters
 * (lib/license-entry.js). Only an ID reaches the licence proxy, so anything
 * else must be named here, and an ID wrapped in a link, a labelled line or
 * invisible characters from a copy must still come out as the ID.
 *
 * Every input comes with Mail Checker's answer. Mail Checker takes a Paddle
 * transaction ID (background/premium.js looks up its subscription), so a
 * well-formed txn_ ID is valid here and a subscription ID beside one wins.
 *
 * Made-up vectors only. V and T have the shape of a Paddle subscription and
 * transaction ID but start with 07, where every real Paddle ID (a ULID, whose
 * first characters are its creation time) starts with 01, so neither can ever
 * be a real one; the parser takes any first character from 0 to 7. FAKE, T2
 * and the few other whole IDs below are made the same way. Google Play order
 * numbers are written "Gpa." or
 * "gpa.", never in the capitals of a real one.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const ROOT = join(__dirname, '..');
const read = rel => readFileSync(join(ROOT, rel), 'utf-8');
const LIB = read('lib/license-entry.js');
const ProtonLicenseEntry = new Function(LIB + '\nreturn ProtonLicenseEntry;')();
const MAX = ProtonLicenseEntry.MAX_CHARS;

const V = 'sub_07h04vsc0qhwtsbsxh3422wjs4';
const FAKE = 'sub_07' + 'a'.repeat(24);
const T = 'txn_07h04vsc0qhwtsbsxh3422wjs4';
const T2 = 'txn_07' + 'b'.repeat(24);
const EMAIL = 'name@example.com';

/** Every entry parsed below, for the privacy checks at the end. */
const seen = [];

function parse(raw) {
  const entry = ProtonLicenseEntry.parse(raw);
  seen.push(entry);
  return entry;
}

function valid(raw, inText, id = V) {
  expect(parse(raw), JSON.stringify(raw)).toEqual({ kind: inText ? 'valid_in_text' : 'valid', id });
}

function transaction(raw, inText) {
  valid(raw, inText, T);
}

function kind(raw, expected) {
  expect(parse(raw), JSON.stringify(raw)).toEqual({ kind: expected });
}

/** The full-width form of s, as some keyboards and East Asian input methods type it. */
const fullWidth = s => [...s]
  .map(c => (c >= '!' && c <= '~' ? String.fromCharCode(c.charCodeAt(0) + 0xFEE0) : c)).join('');

/** The character with that code, for those that are invisible or break a line in the source. */
const ch = code => String.fromCharCode(code);

// ---------------------------------------------------------------- the ID alone

function theIdAloneHoweverItWasCopied() {
  valid(V, false);
  valid('  ' + V + '\n', false);
  valid(V.toUpperCase(), false);
  valid('﻿' + V, false);
  valid(V.slice(0, 8) + '​' + V.slice(8, 14) + '­' + V.slice(14, 20) + '⁠' + V.slice(20), false);
  valid(' ' + V + ' ', false);
  valid('　' + V + '　', false);
  valid(fullWidth(V), false);
  // The first and last character of every range an ID's characters come from.
  const edges = 'sub_0789abcdefghjkmnpqrstvwxyz';
  valid(edges, false, edges);
}

// Tab, line feed, vertical tab, form feed and carriage return: trimmed off
// the ends, joined across inside an ID, and never part of an address.
function asciiWhitespace() {
  for (const ws of ['\t', '\n', '\v', '\f', '\r']) {
    valid(ws + V + ws, false);
    kind(ws, 'empty');
    valid(V.slice(0, 15) + ws + V.slice(15), true);
    kind('name' + ws + '@example.com', 'not_an_id');
    kind(V.slice(0, 12) + ws + EMAIL, 'mistyped_sub_id');
  }
}

// NFKC keeps these four; they become plain spaces, so an ID split by one is
// joined again as one split by a space is, and none is part of an address.
function theSeparatorsNfkcKeeps() {
  for (const sp of [0x2028, 0x2029, 0x85, 0x1680].map(ch)) {
    valid(V.slice(0, 12) + sp + V.slice(12), true);
    valid('s' + sp + 'u' + sp + 'b' + sp + '_' + sp + V.slice(4), true);
    transaction(T.slice(0, 10) + sp + T.slice(10), true);
    kind('name' + sp + '@example.com', 'not_an_id');
    valid(sp + V + sp, false);
  }
}

// The information separators U+001C to U+001F are trimmed off the ends, as
// whitespace (trim() would keep them), but inside the text they are none.
function theInformationSeparators() {
  for (const sep of [0x1c, 0x1d, 0x1e, 0x1f].map(ch)) {
    valid(sep + V + sep, false);
    transaction(sep + T, false);
    kind(sep + sep, 'empty');
    kind(sep + 'sub_' + sep, 'mistyped_sub_id');
    kind(sep + EMAIL + sep, 'email');
    kind(V.slice(0, 15) + sep + V.slice(15), 'mistyped_sub_id');
  }
}

// ---------------------------------------------------------------- the ID in other text

function punctuationAfterTheId() {
  for (const end of ['.', ',', ';', ')', '"', '”']) valid(V + end, true);
}

function aLabelledLineOrALink() {
  valid('Subscription ID: ' + V, true);
  valid(V + ' is my id', true);
  valid('https://customer-portal.paddle.com/cpl_01abc?action=cancel_subscription&subscription_id=' + V, true);
  valid(
    'https://eur01.safelinks.protection.outlook.com/?url=https%3A%2F%2Fcustomer-portal.paddle.com%2Fcpl_01abc'
      + '%3Fsubscription_id%3D' + V + '%26a&data=05',
    true,
  );
  valid('https://apps.example/success.html?_sub=' + V, true);
}

function theSameIdTwice() {
  valid(V + ' ' + V, true);
}

function brokenByASpaceOrALineWrap() {
  valid(V.slice(0, 15) + ' ' + V.slice(15), true);
  valid(V.slice(0, 15) + '\n' + V.slice(15), true);
}

function twoDifferentIds() {
  kind(V + ' ' + FAKE, 'several_ids');
  kind(V + '\n' + FAKE + '.', 'several_ids');
  // Run together: a new ID pasted in front of, or after, an earlier one.
  kind(FAKE + V, 'several_ids');
  kind(V + FAKE, 'several_ids');
  // Pasted into the middle of an earlier ID: neither is whole, so nothing is sent.
  kind(V.slice(0, 10) + FAKE + V.slice(10), 'mistyped_sub_id');
  // A broken new ID against an earlier one, on either side: refused, never the earlier one checked again.
  kind(V + FAKE.slice(0, -3), 'mistyped_sub_id');
  kind(FAKE.slice(0, -3) + V, 'mistyped_sub_id');
  kind(FAKE + 'a' + V, 'mistyped_sub_id');
  kind(V + FAKE.slice(0, -1) + 'o', 'mistyped_sub_id');
  kind(V + 'sub_', 'mistyped_sub_id');
  // Split by a line wrap beside a whole one, the second is a broken one.
  kind(V + ' ' + FAKE.slice(0, 15) + '\n' + FAKE.slice(15), 'mistyped_sub_id');
  // The same ID twice is still one ID.
  valid(V + ' ' + V, true);
  // "sub_" typed by hand, then the whole ID pasted after it, is that ID.
  valid('sub_' + V, true);
  valid('sub_ ' + V, true);
  valid('sub_sub_' + V, true);
  valid('sub-sub-' + V, true);
  valid('sub_' + V + V, true);
  // Each copy of the ID is taken out as a space, so what stands on either
  // side of it never joins into a prefix.
  valid('sub ' + V + '-', true);
  // A "sub_" typed first, then a link, a label line, a quoted ID or an email address pasted after it.
  valid('sub_https://customer-portal.paddle.com/cpl_01abc?action=overview&subscription_id=' + V + '&token=pga_abc', true);
  valid('sub_Subscription ID: ' + V, true);
  valid('sub_ Subscription ID: ' + V, true);
  valid('sub_"' + V + '"', true);
  valid('sub_' + EMAIL + ' ' + V, true);
  // A broken ID after a typed "sub_" is still refused.
  kind('sub_sub_' + FAKE.slice(0, -3) + V, 'mistyped_sub_id');
  kind('sub_ ' + FAKE.slice(0, -3) + V, 'mistyped_sub_id');
  // The same ID twice in a copied receipt, one copy split by a line wrap, is that ID.
  valid('Subscription ID: ' + V + '\nhttps://customer-portal.paddle.com/cpl_01abc?subscription_id='
    + V.slice(0, 14) + '\n' + V.slice(14), true);
  // The "sub-" typo of a broken second ID is refused too.
  kind(V + ' sub-07j' + 'a'.repeat(20), 'mistyped_sub_id');
}

// ---------------------------------------------------------------- not an ID

function cutShortTooLongOrMistyped() {
  kind(V + 'x', 'mistyped_sub_id');
  kind(V + '7', 'mistyped_sub_id');
  kind(V.slice(0, -1), 'mistyped_sub_id');
  kind(V.slice(0, -1) + 'u', 'mistyped_sub_id');
  for (const letter of ['i', 'l', 'o']) kind(V.slice(0, 10) + letter + V.slice(11), 'mistyped_sub_id');
  kind('sub_81' + V.slice(6), 'mistyped_sub_id');
  kind('sub-' + V.slice(4), 'mistyped_sub_id');
  // NFKC makes an e and a combining accent one letter, which no ID holds. A
  // zero-width space between the two keeps them apart, as it is only dropped
  // after NFKC: the e then makes the ID 27 characters long.
  kind(V.slice(0, -1) + 'e' + ch(0x301), 'mistyped_sub_id');
  kind(V + 'e' + ch(0x200B) + ch(0x301), 'mistyped_sub_id');
}

// ---------------------------------------------------------------- transaction IDs

function aTransactionIdAloneOrInText() {
  transaction(T, false);
  transaction('  ' + T.toUpperCase() + '\n', false);
  transaction(fullWidth(T), false);
  transaction(T.slice(0, 8) + '​' + T.slice(8), false);
  transaction(T + '.', true);
  transaction('Transaction ID: ' + T, true);
  transaction('https://apps.example/checkout.html?_ptxn=' + T, true);
  transaction(T + ' ' + T, true);
  transaction(T.slice(0, 15) + '\n' + T.slice(15), true);
  // A prefix typed in front of the pasted ID, or "sub_" alone after it, is no second ID.
  transaction('txn_' + T, true);
  transaction('sub_' + T, true);
  transaction(T + ' sub_', true);
  // Each copy is taken out as a space, as for a subscription ID.
  transaction('txn ' + T + '-0', true);
  // The first and last character of every range an ID's characters come from.
  const edges = 'txn_0789abcdefghjkmnpqrstvwxyz';
  valid(edges, false, edges);
}

function aSubscriptionIdDecides() {
  valid('Subscription ID: ' + V + ', transaction ID: ' + T, true);
  valid(T + ' ' + V, true);
  valid(V + '\n' + T, true);
  valid('https://apps.example/success.html?_ptxn=' + T + '&_sub=' + V, true);
  // Broken by a line wrap, the subscription ID is still found in the second pass, and still decides.
  valid(T + '\n' + V.slice(0, 15) + '\n' + V.slice(15), true);
  // Two subscription IDs stay two, whatever transaction ID comes with them.
  kind(V + ' ' + FAKE + ' ' + T, 'several_ids');
}

function twoDifferentTransactionIds() {
  kind(T + ' ' + T2, 'several_ids');
  kind(T + '\n' + T2 + '.', 'several_ids');
  kind(T + T2, 'several_ids');
  // The second split by a line wrap, on either side: still two, never the first looked up alone.
  kind(T + ' ' + T2.slice(0, 15) + '\n' + T2.slice(15), 'several_ids');
  kind(T2.slice(0, 15) + '\n' + T2.slice(15) + ' ' + T, 'several_ids');
  // A broken second one beside a whole one: refused, so the whole one is not looked up in its place.
  kind(T + ' ' + T2.slice(0, -3), 'mistyped_txn_id');
  kind(T + T2.slice(0, -3), 'mistyped_txn_id');
  kind(T + ' ' + T2.slice(0, -1), 'mistyped_txn_id');
  // A cut one, then "txn_" and the whole one: the "txn_" goes with the whole
  // one, so the cut one stays cut and is refused, never made whole by it.
  kind(T.slice(0, -3) + 'txn_' + T, 'mistyped_txn_id');
  // A second whole one inside a link's token is still a second ID: the token
  // is only left out of what is left over.
  kind(T + '&token=' + T2, 'several_ids');
}

function aBrokenTransactionId() {
  kind(T.slice(0, -1), 'mistyped_txn_id');
  kind(T + 'x', 'mistyped_txn_id');
  kind(T + '7', 'mistyped_txn_id');
  kind(T.slice(0, -1) + 'u', 'mistyped_txn_id');
  kind('txn_81' + T.slice(6), 'mistyped_txn_id');
  kind('https://apps.example/checkout.html?_ptxn=' + T.slice(0, -2), 'mistyped_txn_id');
  // The prefix alone, too.
  kind('txn_', 'mistyped_txn_id');
  kind('TXN_', 'mistyped_txn_id');
  // A cut ID run into the "txn-" typo must not end in that "txn" and come out whole.
  kind(T.slice(0, -3) + 'txn-', 'mistyped_txn_id');
  // The "txn-" typo, as "sub-" is handled.
  kind('txn-' + T.slice(4), 'mistyped_txn_id');
  kind('TXN-' + T.slice(4), 'mistyped_txn_id');
  kind('txn-', 'mistyped_txn_id');
  // "txn_" typed in front of an email address is answered as the email address, as "sub_" is.
  kind('txn_' + EMAIL, 'email');
  kind('txn_ ' + EMAIL, 'email');
  kind('TXN_ ' + EMAIL, 'email');
}

function aBrokenSubscriptionIdBesideATransactionId() {
  // The customer meant the subscription ID, so the transaction ID is not looked up in its place.
  kind(T + ' ' + V.slice(0, -1), 'mistyped_sub_id');
  // Three characters short: without the space, "txn" would make it whole, and that made-up ID would be sent.
  kind(V.slice(0, -3) + ' ' + T, 'mistyped_sub_id');
  kind(V.slice(0, -3) + '\n' + T, 'mistyped_sub_id');
  kind(T + ' sub-' + V.slice(4), 'mistyped_sub_id');
  kind(T + V.slice(0, -1), 'mistyped_sub_id');
  // Mistyped (an l) and run straight into the transaction ID: not whole, so
  // not two IDs either.
  kind(V.slice(0, 10) + 'l' + V.slice(11) + T, 'mistyped_sub_id');
  // Split by a line wrap and run straight into the transaction ID's front, it
  // is no whole ID there, only one begun.
  kind(V.slice(0, 15) + '\n' + V.slice(15) + T, 'mistyped_sub_id');
}

function aTransactionIdRunAgainstASubscriptionId() {
  // Pasted in front of or after an earlier subscription ID with nothing
  // between: no receipt line, so the subscription ID does not decide, and the
  // earlier ID is not checked again in place of the paste.
  kind(T + V, 'several_ids');
  kind(V + T, 'several_ids');
  // A whole one with a line wrap or a space inside, from the invoice, is still two IDs.
  kind(T.slice(0, 15) + '\n' + T.slice(15) + V, 'several_ids');
  kind(T.slice(0, 15) + ' ' + T.slice(15) + V, 'several_ids');
  kind(T.slice(0, 8) + '\n' + T.slice(8, 20) + '\n' + T.slice(20) + V, 'several_ids');
  // Whatever else is run into another copy of the subscription ID.
  kind(T.slice(0, 15) + ' ' + T.slice(15) + V + ' txn-x' + V, 'several_ids');
  // With whitespace between the two it is a receipt line, where the subscription ID decides.
  valid(T + ' ' + V, true);
  valid(T.slice(0, 15) + '\n' + T.slice(15) + '\n' + V, true);
  valid(T + '\nSubscription ID ' + V, true);
  // Whatever of a transaction ID stands apart from a subscription ID, whole,
  // cut short or only begun, is the receipt's.
  valid(V + ' ' + T.slice(0, -3), true);
  valid(V + ' txn_', true);
  kind(T.slice(0, -3) + V, 'mistyped_txn_id');
  kind(V + T.slice(0, -3), 'mistyped_txn_id');
  // Run into its front, one too long or mistyped is no whole one either.
  kind(T + 'x' + V, 'mistyped_txn_id');
  kind(T.slice(0, 10) + 'l' + T.slice(11) + V, 'mistyped_txn_id');
  // "txn_" typed in front of a pasted subscription ID is a typed prefix, as "sub_" is.
  valid('txn_' + V, true);
}

// ---------------------------------------------------------------- beside a whole ID

// The field keeps its text when an activation fails, so an earlier ID with a
// new one begun beside it must not be looked up again in place of the new
// one. A subscription ID begun (a prefix and a character an ID starts with)
// refuses a whole ID of either kind, and a transaction ID begun refuses a
// whole transaction ID, however little of it there is, and whatever it
// shares with the whole one: a copy cut short, a short label, a piece of a
// link. A transaction ID begun apart from a subscription ID is the receipt's
// (aTransactionIdRunAgainstASubscriptionId); run into its front, it refuses
// it too.
function anotherIdBegunBesideAWholeOne() {
  kind('Transaction ID: ' + T + '\nhttps://apps.example/checkout.html?_ptxn=txn_07h04vsc0qhwtsb...', 'mistyped_txn_id');
  kind(T + ' (txn_07h04vsc...)', 'mistyped_txn_id');
  kind('Txn_1 ' + T, 'mistyped_txn_id');
  kind('txn_07h04vsc0qhw shown in the table, ' + T + ' in full', 'mistyped_txn_id');
  kind('Subscription ID: ' + V + '\nhttps://apps.example/success.html?_sub=sub_07h04vsc0qhwtsb...', 'mistyped_sub_id');
  kind(V + ' (sub_07h04vsc...)', 'mistyped_sub_id');
  kind('Sub_1 ' + V, 'mistyped_sub_id');
  kind('sub_7 ' + V, 'mistyped_sub_id');
  kind('Subscription ' + V + ' (shown as sub_07h04vsc0qhw in the portal)', 'mistyped_sub_id');
  kind('sub_07' + 'a'.repeat(8) + ' ' + V, 'mistyped_sub_id');
  kind('txn_07' + 'b'.repeat(8) + ' ' + T, 'mistyped_txn_id');
  // Run straight into the whole one, or left at the very end.
  kind(V.slice(0, -3) + V, 'mistyped_sub_id');
  kind(T + T.slice(0, -3), 'mistyped_txn_id');
  kind('sub_07h0' + V, 'mistyped_sub_id');
  kind(V + 'sub_07h0', 'mistyped_sub_id');
  kind(V + 'sub_07h0&x=1', 'mistyped_sub_id');
  kind(V + ' sub_07', 'mistyped_sub_id');
  kind('txn_07h0' + T, 'mistyped_txn_id');
  kind(T + 'txn_07h0', 'mistyped_txn_id');
  kind(T + ' txn_1', 'mistyped_txn_id');
  kind(T + ' txn_7', 'mistyped_txn_id');
  kind('sub_07h0' + T, 'mistyped_sub_id');
  kind(T + ' sub_7', 'mistyped_sub_id');
  kind('txn_07h0' + V, 'mistyped_txn_id');
  // The whole ID once more with the "sub-" typo, or with a typo in it.
  kind(V + ' sub-' + V.slice(4), 'mistyped_sub_id');
  kind(V + ' sub-' + V.slice(4) + 'x', 'mistyped_sub_id');
  kind('sub_' + V.slice(4, 18) + 'aaaa ' + V, 'mistyped_sub_id');
  kind('txn_' + T.slice(4, 18) + 'bbbb ' + T, 'mistyped_txn_id');
  // Beside an ID the text only shows split by whitespace, too.
  kind(V.slice(0, 15) + '\n' + V.slice(15) + ' (sub_07h04vsc...)', 'mistyped_sub_id');
  kind(V.slice(0, 15) + '\n' + V.slice(15) + ' (shown as sub_07h04vsc0qhw)', 'mistyped_sub_id');
  kind('Txn_1 ' + T.slice(0, 15) + '\n' + T.slice(15), 'mistyped_txn_id');
  // A subscription ID shortened beside a transaction ID: the customer meant a
  // subscription ID, so the transaction ID is not looked up in its place.
  kind('Subscription sub_07h04v..., transaction ' + T, 'mistyped_sub_id');
  // Beside a transaction ID, a broken transaction ID is named before a
  // broken subscription ID.
  kind(T + ' ' + T2.slice(0, -3) + ' ' + V.slice(0, -3), 'mistyped_txn_id');
  // The "txn-" typo is never a whole second ID, in front of a subscription
  // ID or beside a transaction ID.
  kind('txn-' + T.slice(4) + V, 'mistyped_txn_id');
  kind(T + ' txn-' + T2.slice(4), 'mistyped_txn_id');
  // A prefix followed by anything else is no ID begun.
  valid('sub_x ' + V, true);
  transaction(T + ' txn_x', true);
}

// "sub_" alone at the very end is a new subscription ID begun after a
// subscription ID; "txn_" alone after it is let through, and so is either
// prefix alone after a transaction ID. After a transaction ID, either prefix
// with a character an ID starts with is one begun there.
function aPrefixAloneAfterTheId() {
  kind(V + 'sub_', 'mistyped_sub_id');
  kind(V + ' sub_', 'mistyped_sub_id');
  kind(V + ' sub-', 'mistyped_sub_id');
  valid(V + ' txn_', true);
  transaction(T + ' sub_', true);
  transaction(T + 'sub_', true);
  transaction(T + ' sub-', true);
  transaction(T + 'txn_', true);
  transaction(T + ' txn_', true);
  transaction(T + ' txn-', true);
  kind(T + ' sub_07', 'mistyped_sub_id');
  kind(T + ' txn_07', 'mistyped_txn_id');
}

// An ID never ends in "txn" right before a "-": an ID cut short by three and
// run into the "txn-" typo must not pass as a whole made-up ID. Ending in any
// other letters, it does end there. Only a prefix with "_" can follow an ID
// straight away: run into the "sub-" or "txn-" typo, it is too long.
function noMadeUpIdFromTheTxnTypo() {
  kind(FAKE.slice(0, -3) + 'txn-' + T.slice(4), 'mistyped_txn_id');
  kind(V.slice(0, -3) + 'txn-', 'mistyped_sub_id');
  kind(T2.slice(0, -3) + 'txn-' + T.slice(4), 'mistyped_txn_id');
  kind(T2.slice(0, -3) + ' txn-', 'mistyped_txn_id');
  const axn = 'sub_07' + 'e'.repeat(21) + 'axn';
  valid(axn + '-', true, axn);
  const txnAxn = 'txn_07' + 'e'.repeat(21) + 'axn';
  valid(txnAxn + '-', true, txnAxn);
  kind(V + 'sub-x', 'mistyped_sub_id');
  kind(T + 'txn-', 'mistyped_txn_id');
}

// The payment-method link in Paddle's email carries a long base64url token,
// whose random letters can spell the start of an ID. The token is left out of
// what is searched for a second ID, never of what is searched for the ID.
// Made up: the cpl_ ID and the tokens, which spell what would read as a
// broken second ID.
function aLinksToken() {
  const portal = 'https://customer-portal.paddle.com/cpl_07' + 'a'.repeat(24);
  for (const token of ['pga_ab12', 'pga_x9SUB-3yz', 'pga_q_sub_5w', 'pga_k-TXN_7m', 'pga_aSub-0b_txn-1c']) {
    const link = portal + '?action=update_subscription_payment_method&subscription_id=' + V + '&token=' + token
      + '&source=email';
    // The sign-in email's link, once the first one's token has expired: the token last.
    const signIn = portal + '?action=update_subscription_payment_method&origin-intended=true&source=email'
      + '&subscription_id=' + V + '&token=' + token;
    // The same link as Outlook's Safe Links rewrites it: "%26token%3D" there.
    const safelink = 'https://eur01.safelinks.protection.outlook.com/?url=' + encodeURIComponent(link)
      + '&data=05%7C02%7C%7C0&sdata=AbCd%3D&reserved=0';
    for (const pasted of [link, signIn, safelink]) {
      valid(pasted, true);
      // A transaction ID beside it: the link's subscription ID decides, as in a receipt line.
      valid(T + ' ' + pasted, true);
    }
  }
  // Right after the "?", plain or encoded ("%3Ftoken%3D").
  valid('https://customer-portal.paddle.com/subscriptions/' + V + '/update-payment-method?token=pga_x9sub-3yz', true);
  valid('https://eur01.safelinks.protection.outlook.com/?url=https%3A%2F%2Fcustomer-portal.paddle.com%2Fsubscriptions%2F'
    + V + '%3Ftoken%3Dpga_x9sub-3yz&data=05', true);
  // Beside a link that carries no subscription ID, a transaction ID is looked up, whatever the token spells.
  transaction(T + ' ' + portal + '?token=pga_k-TXN_7m', true);
  // The address of the subscription's page in the portal.
  valid('https://customer-portal.paddle.com/subscriptions/' + V + '/cpl_07' + 'a'.repeat(24)
    + '?origin-intended=true&source=email', true);
  // Only a parameter named "token" is left out: not "mytoken=", not "token"
  // without "=", not "token=" with no "?" or "&" in front.
  kind('https://apps.example/?mytoken=pga_x9sub-3yz ' + V, 'mistyped_sub_id');
  kind('https://apps.example/?a=1&mytoken%3dpga_x9sub-3yz ' + V, 'mistyped_sub_id');
  kind('https://apps.example/?tokenpga_x9sub-3yz ' + V, 'mistyped_sub_id');
  kind('token=pga_x9sub-3yz ' + V, 'mistyped_sub_id');
  // The value ends at "&", "%" or whitespace: a broken second ID after it is
  // still refused, also after a wrapped link.
  for (const ws of [' ', '\t', '\n', '\v', '\f', '\r']) {
    kind(portal + '?subscription_id=' + V + '&token=pga_ab12' + ws + 'sub_07aaa', 'mistyped_sub_id');
  }
  kind(portal + '?subscription_id=' + V + '&token=pga_ab12&sub_07aaa', 'mistyped_sub_id');
  kind(portal + '?subscription_id=' + V + '&token=pga_ab12%26sub_07aaa', 'mistyped_sub_id');
  kind('https://eur01.safelinks.protection.outlook.com/?url=https%3A%2F%2Fcustomer-portal.paddle.com%2Fcpl_07'
    + 'a'.repeat(24) + '%3Fsubscription_id%3D' + V + '%26token%3Dpga_ab12%26source%3Demail&data=05 sub_07aaa',
  'mistyped_sub_id');
}

// The limit is on the cleaned text: what NFKC makes of it, without the
// format characters and the whitespace at either end. Over it, nothing is
// searched, not even for a whole ID.
function tooLongOnceCleaned() {
  expect(MAX).toBe(5000);
  const fill = n => 'x'.repeat(n);
  kind(fill(MAX), 'not_an_id');
  kind(fill(MAX + 1), 'too_long');
  valid(V + ' ' + fill(MAX - V.length - 1), true);
  kind(V + ' ' + fill(MAX - V.length), 'too_long');
  kind(fill(MAX) + ' ' + V, 'too_long');
  // A zero-width space is dropped before counting: 5,001 as pasted, 5,000 once cleaned.
  valid(ch(0x200B) + V + ' ' + fill(MAX - V.length - 1), true);
  kind(ch(0x200B) + V + ' ' + fill(MAX - V.length), 'too_long');
  // Spaces around the text are trimmed away before counting.
  valid('  ' + V + ' ' + fill(MAX - V.length - 1) + ' \n', true);
  // NFKC can make text longer: each of these 300 characters spells out 18.
  kind(ch(0xFDFA).repeat(300), 'too_long');
  // Each of these 2,600 becomes a space and a combining mark, which is kept.
  kind(ch(0xA8).repeat(2600), 'too_long');
  // Counted in UTF-16 units once lowercased: an emoji is two, and so is a
  // capital I with a dot, which lowercases to an i and a combining dot.
  const emoji = ch(0xD83D) + ch(0xDE00);
  kind(emoji.repeat(MAX / 2), 'not_an_id');
  kind(emoji.repeat(MAX / 2 + 1), 'too_long');
  kind(ch(0x130).repeat(MAX / 2), 'not_an_id');
  kind(ch(0x130).repeat(MAX / 2 + 1), 'too_long');
}

function aGooglePlayOrderNumber() {
  kind('Gpa.1234-5678-9012-34567', 'play_order');
  kind('gpa.1234-5678-9012-34567..0', 'play_order');
  kind('  gpa.1234-5678-9012-34567  ', 'play_order');
}

function anEmailAddress() {
  kind(EMAIL, 'email');
  kind('Thanks for your order! A receipt was sent to ' + EMAIL + '. Total: EUR 1.99', 'email');
  // Found right after another "@" too.
  kind('x@' + EMAIL, 'email');
  // A dot and a top-level domain of two letters or more, after a name.
  kind('name@example.zz', 'email');
  kind('name@example.c', 'not_an_id');
  kind('name@host.12', 'not_an_id');
  kind('name@localhost', 'not_an_id');
  kind('name@.com', 'not_an_id');
}

function thePrefixAloneOrBeforeAnAddress() {
  // A customer may type "sub_" alone, then "sub_" and an email address.
  kind('sub_', 'mistyped_sub_id');
  kind('sub-', 'mistyped_sub_id');
  kind('sub_' + EMAIL, 'email');
  kind('sub_ ' + EMAIL, 'email');
  // A real attempt at an ID next to an address (a receipt line) is still a mistyped ID.
  kind('Subscription ' + V.slice(0, -1) + ', receipt sent to ' + EMAIL, 'mistyped_sub_id');
  kind('sub_x ' + EMAIL, 'mistyped_sub_id');
}

// Every address is taken out before the text is searched for a mistyped ID,
// with whatever runs into it: a link or a label without a space before the
// address goes with it.
function anAddressIsTakenOutWithWhatRunsIntoIt() {
  kind('https://apps.example/checkout.html?_ptxn=txn_07h04vsc0qhwtsbsxh3422&email=' + EMAIL, 'email');
  kind('Transaction ID' + T + 'Email' + EMAIL, 'email');
  kind('https://apps.example/success.html?_sub=sub_07h04vsc0qhwtsbsxh3422&email=' + EMAIL, 'email');
  kind(T.slice(0, -3) + ',' + EMAIL, 'email');
  kind('sub_ ' + EMAIL + ', ' + 'other@example.com', 'email');
  // Apart from the address, a broken ID is still named.
  kind('https://apps.example/checkout.html?_ptxn=' + T.slice(0, -3) + ' ' + EMAIL, 'mistyped_txn_id');
  kind(T.slice(0, -3) + ', ' + EMAIL, 'mistyped_txn_id');
}

// An email address is never read as an ID, as part of one or as an ID
// begun: the local part in front of its "@" is left out of every search for
// one. The field keeps its text when an activation fails, so an address
// pasted after a cut-short ID must not make it whole, and an address beside
// an ID must not refuse it as a second ID begun. Where an answer here was
// different before, the comment above it says what it was.
function anAddressIsNeverReadAsAnId() {
  const cutT = T.slice(0, -4);
  // A cut-short ID is not made whole with the start of an address after it,
  // with or without whitespace between, whatever the address is made of.
  // All but the two at example.org made up an ID out of the address, such
  // as "txn_07h04vsc0qhwtsbsxh3422name", and sent it.
  kind('https://apps.example/checkout.html?_ptxn=' + cutT + ' ' + EMAIL, 'mistyped_txn_id');
  kind(cutT + EMAIL, 'email');
  kind(cutT + '\n' + EMAIL, 'mistyped_txn_id');
  kind(cutT + ' first.last@example.org', 'mistyped_txn_id');
  kind(cutT + ' ab-c+tag@example.org', 'mistyped_txn_id');
  kind(V.slice(0, -4) + '\r\n' + EMAIL, 'mistyped_sub_id');
  kind(V.slice(0, -2) + " ab'cd@example.com", 'mistyped_sub_id');
  // An ID run straight into an address is part of the address, whatever
  // joins the two (it was the ID, except after "_"); with whitespace or
  // other punctuation between them, it is found.
  kind(V + '@example.com', 'email');
  kind(V + '.support@example.com', 'email');
  kind(V + '+tag@example.com', 'email');
  kind(V + '-x@example.com', 'email');
  kind(V + '_x@example.com', 'email');
  kind(V + "'x@example.com", 'email');
  kind('Your ID is ' + V + '.support@example.com', 'email');
  kind(T + '+tag@example.com', 'email');
  valid(V + ' ' + EMAIL, true);
  valid(V + ',' + EMAIL, true);
  valid(V + ' (' + EMAIL + ')', true);
  // Whatever follows the "@", "%40" or "%2540", a domain or nothing, the run
  // in front of it is a local part: an ID run into it goes with it (it was
  // that ID), and a transaction ID beside it is the one found (it was the
  // subscription ID).
  kind(V + '@', 'mistyped_sub_id');
  kind(V + '%40', 'mistyped_sub_id');
  transaction(T + ' ' + V + '@example.com', true);
  // The ends of the ranges a local part is read with ("0" to "9", "a" to
  // "z"). Any other character ends one: an ID right in front of it is found
  // with the address after it taken out, and an address right after it is
  // still taken out.
  kind(V + '.z9@example.com', 'email');
  for (const c of ['=', '&', '?', '/', ':', '<', '(', ',', ';']) valid(V + c + EMAIL, true);
  for (const c of ['mailto:', '/', '<', '(', '"', '=']) valid(V + ' ' + c + 'me+sub_3@example.com', true);
  // Only "@", "%40" and "%2540" end a local part, not an encoding that
  // starts as one of them does.
  for (const after of ['%4', '%41', '%25', '%2526', '%254', '%2541']) valid(V + after, true);
  // A local part of one character is taken out too, and one of any length.
  kind(T2.slice(0, -1) + ' b@example.com', 'mistyped_txn_id');
  valid(V.slice(0, 15) + '\n' + V.slice(15) + ' a@example.com', true);
  kind(V + '.' + 'a'.repeat(40) + '@example.com', 'email');
  // A link's token is taken out before the local parts: the other way
  // round, an "@" in its value would take the "3d" of its "%3d" along, and
  // the token, "sub-3" and all, would be left in.
  valid(V + ' https://eur01.safelinks.protection.outlook.com/?url=https%3A%2F%2Fapps.example%2Fp'
    + '%3Ftoken%3Dpga_x9@sub-3%26a&data=05', true);
  // A sentence with an address after it, with or without a space after the
  // full stop.
  valid('Your ID is ' + V + '. Questions? support@example.com', true);
  valid('Your ID is ' + V + '.Questions? support@example.com', true);
  valid('Your ID is ' + V + '. Questions?support@example.com', true);
  valid('Your ID is ' + V + '. support@example.com', true);
  valid('Your ID is ' + V + '.\nsupport@example.com', true);
  transaction('Your transaction ID is ' + T + '.Questions? support@example.com', true);
  // An ID at the end of a line, the address on the next one.
  valid(V + '\n' + EMAIL, true);
  valid('Subscription ID: ' + V + '\r\nEmail: ' + EMAIL, true);
  valid('> Subscription ID: ' + V + '\n> ' + EMAIL, true);
  transaction('Transaction ID: ' + T + '\n' + EMAIL, true);
  transaction('Receipt | ' + T + ' | EUR 2.49\n' + EMAIL, true);
  // An ID split by a line wrap or a space is found with an address after
  // it, on the same line or the next. All but the one with " - " between
  // were a mistyped ID.
  valid(V.slice(0, 16) + '\n' + V.slice(16) + ' ' + EMAIL, true);
  valid(V.slice(0, 15) + '\n' + V.slice(15) + ' ' + EMAIL, true);
  valid(V.slice(0, 15) + '\n' + V.slice(15) + '\n' + EMAIL, true);
  valid('Subscription ' + V.slice(0, 15) + ' ' + V.slice(15) + ' - ' + EMAIL, true);
  transaction('Transaction ' + T.slice(0, 13) + ' ' + T.slice(13) + ' ' + EMAIL, true);
  // A wrapped link whose query carries the address, plain or encoded. The
  // two whose address holds an ID begun were a mistyped ID.
  transaction('https://apps.example/checkout.html?_ptxn=' + T.slice(0, 18) + '\n' + T.slice(18) + '&email=' + EMAIL, true);
  transaction('https://apps.example/checkout.html?_ptxn=' + T + '&email=na\nme@example.com', true);
  transaction('https://apps.example/checkout.html?_ptxn=' + T.slice(0, 18) + '\n' + T.slice(18)
    + '&email=jane.sub-2%40example.com', true);
  valid('https://customer-portal.paddle.com/cpl_07' + 'a'.repeat(24) + '?subscription_id=' + V.slice(0, 18) + '\n'
    + V.slice(18) + '&email=me+sub_3%40example.com', true);
  transaction(
    'https://eur01.safelinks.protection.outlook.com/?url=https%3A%2F%2Fapps.example%2Fcheckout.html%3F_ptxn%3D'
      + T.slice(0, 20) + '\n' + T.slice(20) + '%26email%3Dname%2540example.com&data=05',
    true,
  );
  // An address that holds an ID begun is no second ID beside a whole one,
  // also where a link writes its "@" as "%40", or a link inside a link as
  // "%2540". Each was a mistyped ID, except "me+txn_0@" in front of a
  // subscription ID.
  valid(V + ' me+sub_3@example.com', true);
  valid(V + ' jane.sub-2@example.com', true);
  valid(V + ' club-sub-1@example.com', true);
  valid('me+txn_0@example.com\n' + V, true);
  transaction(T + ' sub-1@example.com', true);
  transaction(T + ' txn-2@example.com', true);
  valid(V.slice(0, 15) + '\n' + V.slice(15) + ' me+sub_3@example.com', true);
  transaction('https://apps.example/checkout.html?_ptxn=' + T + '&email=me+sub_3@example.com', true);
  transaction('https://apps.example/checkout.html?_ptxn=' + T + '&email=jane.sub-2%40example.com', true);
  valid(
    'https://eur01.safelinks.protection.outlook.com/?url=https%3A%2F%2Fcustomer-portal.paddle.com%2Fcpl_07'
      + 'a'.repeat(24) + '%3Fsubscription_id%3D' + V + '%26a&data=05%7C02%7Cclub-sub-1%40example.com%7C0',
    true,
  );
  transaction(
    'https://eur01.safelinks.protection.outlook.com/?url=https%3A%2F%2Fapps.example%2Fcheckout.html%3F_ptxn%3D'
      + T + '%26email%3Djane.sub-2%2540example.com&data=05',
    true,
  );
  // Nor is a whole ID in an address a second ID (they were several IDs).
  transaction(T + ' ' + T2 + '.x@example.com', true);
  valid(V + ' ' + FAKE + '@example.com', true);
  // A broken second ID apart from the address still refuses the ID.
  kind(V + ' sub_07h0 ' + EMAIL, 'mistyped_sub_id');
  kind(V + ' sub_07h0, ' + EMAIL, 'mistyped_sub_id');
  kind(V + ' sub_07h0\n' + EMAIL, 'mistyped_sub_id');
  kind(V + ' sub_07h0 me+sub_3@example.com', 'mistyped_sub_id');
  kind(T + ' txn_07h0 ' + EMAIL, 'mistyped_txn_id');
  kind(T + ' sub_07h0 ' + EMAIL, 'mistyped_sub_id');
  // Run straight into the address, it is part of the address, as an ID
  // would be, and the ID beside it is found (it was a mistyped ID).
  valid(V + ' sub_07h0' + EMAIL, true);
  // Only the local part goes: an ID in an address's domain, where a real
  // address has none, is still found.
  valid('user@' + V + '.example.com', true);
  // A cut-short ID with an ordinary word after it, then an address, is
  // character for character an ID split by a space with an address after
  // it: nothing tells the two apart, so both are read as one ID. Both were
  // a mistyped ID, the address run into the word in front of it.
  valid(cutT + ' data ' + EMAIL, true, cutT + 'data');
  transaction(cutT + ' ' + T.slice(-4) + ' ' + EMAIL, true);
}

function aTransactionIdBesideAnAddress() {
  transaction('Order ' + T + ', receipt sent to ' + EMAIL, true);
  kind('Order ' + T.slice(0, -3) + ', receipt sent to ' + EMAIL, 'mistyped_txn_id');
}

function blankText() {
  kind('', 'empty');
  kind('   ', 'empty');
  kind('​', 'empty');
  // Not text at all: a caller's mistake, with nothing in it to read.
  kind(null, 'empty');
  kind(undefined, 'empty');
}

function anythingElse() {
  kind('hello', 'not_an_id');
  kind('12345', 'not_an_id');
  kind('pri_07h04vsc0qhwtsbsxh3422wjs4', 'not_an_id');
  kind('https://apps.olausson.de/mail_checker_for_proton/checkout.html', 'not_an_id');
}

function upperCaseOnAnyLocale() {
  // toLowerCase() ignores the locale (checked in the source below), so a
  // Turkish system reads an upper-case ID the same.
  valid(V.toUpperCase(), false);
  valid('SUBSCRIPTION ID: ' + V.toUpperCase(), true);
  transaction(T.toUpperCase(), false);
}

// ---------------------------------------------------------------- what Mail Checker customers paste

// Made-up page text: the checkout's success page and Paddle's emails can show
// the subscription ID next to the transaction ID.
const SUCCESS_PAGE = 'Thank you! Your Mail Checker Pro subscription is active.\n'
  + 'Subscription ID: ' + V + '\n'
  + 'Transaction ID: ' + T + '\n'
  + 'Paste the subscription ID into the extension\'s settings.';

function pastedSuccessPageText() {
  valid(SUCCESS_PAGE, true);
  valid('Transaction ID: ' + T + '\nSubscription ID: ' + V, true);
  transaction('Payment received. Transaction ID: ' + T + '\nThank you!', true);
}

function aPortalLinkWithTheSubscriptionId() {
  valid('https://customer-portal.paddle.com/cpl_07' + 'c'.repeat(24) + '?action=overview&subscription_id=' + V, true);
  valid('https://customer-portal.paddle.com/cpl_07' + 'c'.repeat(24) + '?action=cancel_subscription&subscription_id='
    + V + '&token=pga_example', true);
}

function aReceiptLineWithATransactionId() {
  transaction('Receipt | ' + T + ' | EUR 2.49 | ' + EMAIL, true);
  transaction('Invoice for transaction ' + T + '.', true);
}

function zeroWidthAndBidiCharacters() {
  const marks = ['​', '‌', '‍', '‎', '‏', '‪', '‫', '‬', '‭',
    '‮', '⁦', '⁧', '⁨', '⁩', '؜', '⁠', '﻿', '­'];
  for (const m of marks) {
    valid(m + V.slice(0, 12) + m + V.slice(12) + m, false);
    transaction(m + T + m, false);
    // Dropped before the text is trimmed: the space inside is then at the
    // very edge, and the ID is still the ID alone.
    valid(m + ' ' + V + '\n' + m, false);
  }
  valid('⁨Subscription ID: ⁩' + V + '‏', true);
}

function anIdSplitByALineBreak() {
  valid(V.slice(0, 15) + '\r\n' + V.slice(15), true);
  transaction(T.slice(0, 20) + '\n' + T.slice(20), true);
  valid('https://customer-portal.paddle.com/cpl_01abc?subscription_id=' + V.slice(0, 18) + '\n' + V.slice(18)
    + '&token=pga_abc', true);
}

function upperCase() {
  valid('SUBSCRIPTION ID: ' + V.toUpperCase(), true);
  transaction(T.toUpperCase(), false);
  valid('Sub_' + V.slice(4).toUpperCase(), false);
}

function fullWidthCharacters() {
  valid(fullWidth('Subscription ID: ' + V), true);
  transaction(fullWidth(T), false);
  valid('　' + fullWidth(V) + '　', false);
}

function severalIds() {
  kind(T + ' ' + T2, 'several_ids');
  kind(T + T2, 'several_ids');
  kind(V + ' ' + FAKE + ' ' + T, 'several_ids');
  // One subscription ID wins over any transaction IDs beside it, either
  // order, with whitespace between them (a receipt or the success page).
  valid(V + ' ' + T, true);
  valid(T + ' ' + V, true);
  valid(V + ' ' + T + ' ' + T2, true);
  // A broken ID against a transaction ID: refused, by the kind that is broken.
  kind(T + T2.slice(0, -3), 'mistyped_txn_id');
  kind(T2.slice(0, -3) + T, 'mistyped_txn_id');
  kind(FAKE.slice(0, -3) + ' ' + T, 'mistyped_sub_id');
  // Cut by exactly three and run into "txn_": the t, x and n are base32
  // letters, so the cut ID would end in "txn" and pass as whole.
  kind(FAKE.slice(0, -3) + T, 'mistyped_sub_id');
  // An ID never ends right before "_" either.
  kind(V + '_', 'mistyped_sub_id');
  kind(T + '_', 'mistyped_txn_id');
  // Prefixes typed in front of a pasted transaction ID are passed over.
  transaction('sub_' + T, true);
  transaction('txn_' + T, true);
  transaction('sub_ ' + T, true);
  transaction('sub_Transaction ID: ' + T, true);
}

function theCustomersSubPrefixAndEmail() {
  // First "sub_" alone, then "sub_" and an email address: the first is
  // incomplete, the second an email address.
  kind('sub_', 'mistyped_sub_id');
  kind('sub_' + EMAIL, 'email');
}

function googlePlayOrdersAndPlainEmails() {
  kind('Order number: Gpa.1234-5678-9012-34567 (Google Play)', 'play_order');
  kind('first.last+mail@example.com', 'email');
  kind('NAME@EXAMPLE.COM', 'email');
  kind('  ' + EMAIL + '\n', 'email');
  // Two addresses with only a comma between them, "sub_" typed in front of
  // the second: both are taken out.
  kind(EMAIL + ',' + 'other@example.com', 'email');
  kind(EMAIL + ',sub_' + EMAIL, 'email');
  // Only the whole shape is an order number, wherever it stands, also with an
  // address run into it.
  kind('gpa.1234-5678-9', 'not_an_id');
  kind('gpa-1234-5678-9012-34567', 'not_an_id');
  kind('gpa.1234-5678-9012-3456', 'not_an_id');
  kind('gpa.1234-5678-9012-345678', 'play_order');
  kind('gpa.1234-5678-9012-34567@example.com', 'play_order');
}

// Text without an ID gets the first kind that fits, in this order: a Play
// order number, a broken transaction ID, a broken subscription ID (its "sub-"
// typo too), then an email address, then a prefix alone.
function theOrderOfTheKinds() {
  kind('gpa.1234-5678-9012-34567 ' + T.slice(0, -3), 'play_order');
  kind('gpa.1234-5678-9012-34567, ' + V.slice(0, -1), 'play_order');
  kind(V.slice(0, -1) + ' ' + T.slice(0, -1), 'mistyped_txn_id');
  kind('Subscription sub-' + V.slice(4, -1) + ', receipt sent to ' + EMAIL, 'mistyped_sub_id');
  kind('sub_ txn_', 'mistyped_txn_id');
}

const GROUPS = {
  'the ID alone, however it was copied, is valid and not in text': theIdAloneHoweverItWasCopied,
  'tab, line feed, vertical tab, form feed and carriage return are whitespace': asciiWhitespace,
  'NEL, the Ogham space mark and the line and paragraph separators are whitespace': theSeparatorsNfkcKeeps,
  'the information separators are trimmed off the ends, but are no whitespace inside': theInformationSeparators,
  'an ID with punctuation after it is found, not cut or refused': punctuationAfterTheId,
  'an ID in a labelled line or a link is found': aLabelledLineOrALink,
  'the same ID twice is one ID': theSameIdTwice,
  'an ID broken by a space or a line wrap is found in the second pass': brokenByASpaceOrALineWrap,
  'two different IDs are several IDs': twoDifferentIds,
  'an ID that is cut short, too long or mistyped is a mistyped ID, never a shorter valid one': cutShortTooLongOrMistyped,
  'a transaction ID alone or in other text is looked up': aTransactionIdAloneOrInText,
  'a subscription ID decides over a transaction ID in the same text': aSubscriptionIdDecides,
  'two different transaction IDs are several IDs': twoDifferentTransactionIds,
  'a transaction ID that is cut short, too long or mistyped is a mistyped transaction ID': aBrokenTransactionId,
  'a broken subscription ID beside a transaction ID is a mistyped subscription ID': aBrokenSubscriptionIdBesideATransactionId,
  'a transaction ID run straight against a subscription ID is refused, never the earlier ID checked': aTransactionIdRunAgainstASubscriptionId,
  'another ID begun beside a whole one refuses it, however little of it there is, unless it is a transaction ID apart from a subscription ID': anotherIdBegunBesideAWholeOne,
  '"sub_" alone after a subscription ID is a new one begun; "txn_" alone after it, and either prefix alone after a transaction ID, is let through': aPrefixAloneAfterTheId,
  'no made-up ID comes out of the "txn-" typo': noMadeUpIdFromTheTxnTypo,
  'a link\'s token is never read as a second ID, whatever it spells': aLinksToken,
  'text longer than MAX_CHARS once cleaned is too long, and not searched': tooLongOnceCleaned,
  'a Google Play order number is named as one': aGooglePlayOrderNumber,
  'an email address is named as one': anEmailAddress,
  'the prefix alone, or typed in front of an email address, is answered as what it is': thePrefixAloneOrBeforeAnAddress,
  'an email address is taken out with whatever runs into it': anAddressIsTakenOutWithWhatRunsIntoIt,
  'an email address is never read as an ID, as part of one or as an ID begun': anAddressIsNeverReadAsAnId,
  'a transaction ID wins over an email address in the same text': aTransactionIdBesideAnAddress,
  'blank text is empty': blankText,
  'anything else is not an ID': anythingElse,
  'an upper-case ID reads the same on any locale': upperCaseOnAnyLocale,
};

const MAIL_CHECKER_GROUPS = {
  'pasted success-page text gives the subscription ID': pastedSuccessPageText,
  'a Paddle portal link with subscription_id= gives that ID': aPortalLinkWithTheSubscriptionId,
  'a receipt line with a transaction ID gives that ID': aReceiptLineWithATransactionId,
  'zero-width and bidi characters are dropped': zeroWidthAndBidiCharacters,
  'an ID split by a line break is found': anIdSplitByALineBreak,
  'upper case reads as lower case': upperCase,
  'full-width characters read as plain ones (NFKC)': fullWidthCharacters,
  'several IDs: one kind twice is several, a subscription ID beats transaction IDs': severalIds,
  '"sub_" alone, then "sub_" and an email address, as a customer may type them': theCustomersSubPrefixAndEmail,
  'Google Play orders and plain email addresses': googlePlayOrdersAndPlainEmails,
  'text without an ID gets the first kind that fits, in a fixed order': theOrderOfTheKinds,
};

describe('the parser\'s vectors', () => {
  for (const [name, group] of Object.entries(GROUPS)) it(name, group);
});

describe('what Mail Checker customers paste', () => {
  for (const [name, group] of Object.entries(MAIL_CHECKER_GROUPS)) it(name, group);
});

describe('a long paste', () => {
  it('is answered as too long at once, however long it is', () => {
    // Over the limit nothing is searched, so 200,000 characters cost no more
    // than cleaning them. Only the cleaned text counts: an ID with 200,000
    // spaces around it is the ID alone.
    const N = 200000;
    const started = Date.now();
    kind('a'.repeat(N), 'too_long');
    kind('x'.repeat(N) + '@example', 'too_long');
    kind('a'.repeat(N) + ' ' + V, 'too_long');
    kind('sub_'.repeat(N / 4) + 'x' + V, 'too_long');
    kind('sub_'.repeat(12500) + 'x ' + V, 'too_long');
    kind('0'.repeat(N) + V, 'too_long');
    kind('txn_0'.repeat(N / 5) + '@example.com', 'too_long');
    kind('a' + ' '.repeat(N) + 'b', 'too_long');
    valid(' '.repeat(N / 2) + V + '\n'.repeat(N / 2), false);
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('is answered quickly at the limit, whatever it holds', () => {
    // Every pass is linear: each of these is just under MAX_CHARS, and each
    // is parsed 30 times. A pass that is not linear still fits this bound at
    // the limit, so the comparisons with a plain text below are what catch
    // one.
    const started = Date.now();
    for (let i = 0; i < 30; i++) {
      kind('a'.repeat(MAX - 1) + '@', 'not_an_id');
      kind('a'.repeat(MAX - 2) + '@b', 'not_an_id');
      kind('a'.repeat(MAX - EMAIL.length - 1) + ' ' + EMAIL, 'email');
      kind('a@'.repeat(MAX / 2), 'not_an_id');
      kind('txn_'.repeat(MAX / 4), 'mistyped_txn_id');
      kind('txn_0'.repeat(MAX / 5 - 3) + '@example.com', 'email');
      // Every pattern that reads back from the ID, over a long run in front of it.
      valid('0'.repeat(MAX - V.length) + V, true);
      valid('txn_' + '0 '.repeat((MAX - V.length - 6) / 2) + '0' + V, true);
      valid('s'.repeat(MAX - V.length - 1) + ' ' + V, true);
      kind('sub_0 '.repeat(Math.floor((MAX - V.length) / 6)) + V, 'mistyped_sub_id');
      valid('&token=pga_x9sub-3'.repeat(Math.floor((MAX - V.length - 1) / 18)) + ' ' + V, true);
    }
    expect(Date.now() - started).toBeLessThan(2000);
  });

  // How long a text takes against a plain text of the same length, as the
  // best of several runs, so a slow or busy machine does not fail it.
  const best = text => {
    for (let i = 0; i < 5; i++) ProtonLicenseEntry.parse(text);
    let fastest = Infinity;
    for (let i = 0; i < 15; i++) {
      const started = performance.now();
      for (let j = 0; j < 10; j++) ProtonLicenseEntry.parse(text);
      fastest = Math.min(fastest, performance.now() - started);
    }
    return fastest;
  };
  const expectAsQuickAs = (reference, texts) => {
    const plain = best(reference);
    for (const text of texts) {
      const ratio = best(text) / plain;
      expect(ratio, text.slice(0, 12) + '... took ' + ratio.toFixed(1) + ' times the plain text').toBeLessThan(10);
    }
  };
  const expectAsQuickAsPlainText = texts => expectAsQuickAs('a'.repeat(MAX - V.length - 1) + ' ' + V, texts);

  it('reads a run of typed prefixes once, not again from every prefix in it', () => {
    // Over a thousand prefixes that do not lead to the ID, just under the
    // limit. Read again from every prefix in them, each took dozens of times
    // as long as a plain text of the same length; read once, a few times.
    const prefixes = 'sub_'.repeat((MAX - V.length - 2) / 4) + 'x ' + V;
    const hyphens = 'sub-'.repeat((MAX - V.length - 2) / 4) + 'x ' + V;
    const spaced = 's u b _ '.repeat((MAX - V.length - 2) / 8) + 'x ' + V;
    const txnPrefixes = 'txn_'.repeat((MAX - T.length - 2) / 4) + 'x ' + T;
    valid(prefixes, true);
    valid(hyphens, true);
    valid(spaced, true);
    transaction(txnPrefixes, true);
    expectAsQuickAsPlainText([prefixes, hyphens, spaced, txnPrefixes]);
  });

  it('tries the address pattern only where an address can start', () => {
    // A long run without a space or with an "@" at one end, just under the
    // limit. Tried from every character, the address pattern took hundreds of
    // times as long as a plain text of the same length on each (and seconds
    // on far longer text); tried where a run starts, a few times.
    const texts = ['a'.repeat(MAX - 1) + '@', '@' + 'a'.repeat(MAX - 1), 'a@' + 'b'.repeat(MAX - 2)];
    for (const text of texts) kind(text, 'not_an_id');
    expectAsQuickAsPlainText(texts);
  });

  it('tries a local part only where a run of address characters starts', () => {
    // Runs of address characters before an "@" or its "%2540" form, cut
    // short by a "=" or by a "%254" that never becomes "%2540", many dots or
    // "@" between spaces, one run of every character a local part is read
    // with and no "@", all just under the limit, and an ID beside many
    // addresses that each hold an ID begun. A local part is tried only where
    // a run starts, so each run is read from its start only, not again from
    // every character in it.
    const beside = (V + ' me+sub_3@example.com ').repeat(Math.floor(MAX / 52));
    const texts = [
      'a.'.repeat(Math.floor((MAX - 1) / 2)) + '@',
      'a@ '.repeat(Math.floor(MAX / 3)),
      '  a@'.repeat(MAX / 4),
      ' .'.repeat(MAX / 2),
      ('a'.repeat(99) + '=').repeat(MAX / 100 - 1) + '@',
      ('a'.repeat(96) + '%254').repeat(MAX / 100),
      'a%2540'.repeat(Math.floor(MAX / 6)),
      "09az._+'-".repeat(Math.floor(MAX / 9)),
    ];
    for (const text of texts) kind(text, 'not_an_id');
    valid(beside, true);
    expectAsQuickAsPlainText([...texts, beside]);
    // The plain text is such a run too, so it would be as slow as they are:
    // both are also measured against short words, which take as long however
    // a local part is tried.
    expectAsQuickAs('id is '.repeat(Math.floor((MAX - V.length) / 6)) + V, [
      'a'.repeat(MAX - V.length - 1) + ' ' + V,
      "09az._+'-".repeat(Math.floor(MAX / 9)),
    ]);
  });
});

describe('privacy', () => {
  it('no entry holds the text it came from, an email address, or anything but its kind and ID', () => {
    seen.length = 0;
    const all = [...Object.values(GROUPS), ...Object.values(MAIL_CHECKER_GROUPS)];
    for (const group of all) group();
    expect(seen.length).toBeGreaterThan(200);
    const secret = /sub_[0-9]|txn_[0-9]|@/;
    for (const entry of seen) {
      expect(ProtonLicenseEntry.KINDS).toContain(entry.kind);
      expect(entry.kind).not.toMatch(secret);
      if (entry.id) {
        expect(Object.keys(entry).sort()).toEqual(['id', 'kind']);
        expect(entry.id).toMatch(/^(sub|txn)_[0-7][0-9a-hjkmnp-tv-z]{25}$/);
        expect(entry.kind).toMatch(/^valid(_in_text)?$/);
      } else {
        expect(Object.keys(entry)).toEqual(['kind']);
      }
    }
  });

  it('keeps no state between calls', () => {
    // The ID, address and token patterns are global; a stale lastIndex would skip a match.
    const link = 'https://customer-portal.paddle.com/cpl_07' + 'c'.repeat(24) + '?subscription_id=' + V + '&token=pga_x9sub-3yz';
    for (let i = 0; i < 3; i++) {
      expect(ProtonLicenseEntry.parse(V)).toEqual({ kind: 'valid', id: V });
      expect(ProtonLicenseEntry.parse(EMAIL)).toEqual({ kind: 'email' });
      expect(ProtonLicenseEntry.parse('Transaction ID: ' + T)).toEqual({ kind: 'valid_in_text', id: T });
      expect(ProtonLicenseEntry.parse(link)).toEqual({ kind: 'valid_in_text', id: V });
    }
  });

  it('lowercases without the locale, and logs nothing', () => {
    expect(LIB).toContain('.toLowerCase()');
    expect(LIB).not.toContain('toLocaleLowerCase');
    expect(LIB).not.toMatch(/console\.|debugLog|ProtonDiag/);
  });
});

describe('wiring', () => {
  const MANIFEST = JSON.parse(read('manifest.json'));
  const OPTIONS_HTML = read('options/options.html');

  it('loads before premium.js in the background, and so in the Chrome service worker', () => {
    const scripts = MANIFEST.background.scripts;
    expect(scripts).toContain('lib/license-entry.js');
    expect(scripts.indexOf('lib/license-entry.js')).toBeLessThan(scripts.indexOf('background/premium.js'));
    // build-chrome.js copies lib/ and imports the manifest's list, in order.
    const build = read('scripts/build-chrome.js');
    expect(build).toMatch(/COPY_DIRS = \[[^\]]*'lib'/);
    expect(build).toContain('generateServiceWorker(srcBackgroundScripts)');
  });

  it('loads before options.js on the options page', () => {
    const lib = OPTIONS_HTML.indexOf('<script src="../lib/license-entry.js" defer></script>');
    expect(lib).toBeGreaterThan(-1);
    expect(lib).toBeLessThan(OPTIONS_HTML.indexOf('<script src="options.js" defer></script>'));
  });

  it('is a known global to eslint, and linted', () => {
    expect(read('eslint.config.js')).toContain("ProtonLicenseEntry: 'readonly'");
    const pkg = JSON.parse(read('package.json'));
    expect(pkg.scripts.lint).toContain('lib/license-entry.js');
  });

  it('is what the background and the options page read the field with', () => {
    expect(read('background/premium.js')).toContain('ProtonLicenseEntry.parse(key)');
    expect(read('options/options.js')).toContain("ProtonLicenseEntry.parse(licenseInput.value || '')");
  });
});

describe('the messages', () => {
  // _strings is module-private; expose it through the module's own return.
  const code = read('lib/i18n.js').replace('return { setLanguage', 'return { _strings, setLanguage');
  const win = {};
  const strings = new Function('window', 'self', code + '; return window.ProtonI18n || self.ProtonI18n || ProtonI18n;')(win, win)._strings;
  const KEYS = {
    licenseEntrySeveralIds: [],
    licenseEntryPlayOrder: ['apps.olausson.de'],
    licenseEntryMistypedTxnId: [],
    licenseEntryMistypedSubId: [],
    licenseEntryEmail: ['sub_'],
    licenseEntryNotAnId: ['sub_', 'txn_'],
    licenseEntryTooLong: [],
  };

  it('exist in English as a short sentence pair each', () => {
    for (const key of Object.keys(KEYS)) {
      const text = strings.en[key];
      expect(typeof text, key).toBe('string');
      expect(text.split(/(?<=[.!?])\s+(?=\S)/).length, key).toBe(2);
    }
  });

  it('keep the prefixes and the shop address in every language that has them', () => {
    for (const [loc, table] of Object.entries(strings)) {
      for (const [key, literals] of Object.entries(KEYS)) {
        if (typeof table[key] !== 'string') continue;
        for (const literal of literals) expect(table[key], loc + '/' + key).toContain(literal);
      }
    }
  });

  it('never pair a low opening quote with a straight closing one', () => {
    // As tests/i18n-parity.test.js checks the other license strings: „sub_“
    // or „sub_”, never „sub_" and never an unclosed one.
    const LOW = String.fromCharCode(0x201E);
    for (const [loc, table] of Object.entries(strings)) {
      for (const key of Object.keys(KEYS)) {
        const value = table[key];
        if (typeof value !== 'string') continue;
        let at = value.indexOf(LOW);
        while (at !== -1) {
          const close = value.slice(at + 1).search(/["“”]/);
          expect(close !== -1 && value[at + 1 + close] !== '"', loc + '/' + key).toBe(true);
          at = value.indexOf(LOW, at + 1);
        }
      }
    }
  });
});
