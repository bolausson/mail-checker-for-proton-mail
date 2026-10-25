/**
 * What the license key field makes of the text a user enters
 * (lib/license-entry.js). Only an ID reaches the licence proxy, so anything
 * else must be named here, and an ID wrapped in a link, a labelled line or
 * invisible characters from a copy must still come out as the ID.
 *
 * Ported from Sync for Proton 2.0.2 (SubscriptionEntryTest.kt): every one of
 * its inputs (its checkout link becomes Mail Checker's), with Mail Checker's
 * answer. Like Sync, Mail Checker takes a Paddle transaction ID
 * (background/premium.js looks up its subscription), so a well-formed txn_ ID
 * is valid here and a subscription ID beside one wins. The few answers that
 * differ from Sync's on purpose are in their own groups below, each saying
 * why.
 *
 * Made-up vectors only. V and T have the shape of a Paddle subscription and
 * transaction ID but start with 07, where every real Paddle ID (a ULID, whose
 * first characters are its creation time) starts with 01, so neither can ever
 * be a real one; the parser, like the proxy, takes any first character from 0
 * to 7. FAKE and T2 are made the same way. The vectors are written out whole:
 * none is split up to get it past a scanner. Google Play order numbers are
 * written "Gpa." or "gpa.", never in the capitals of a real one.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const ROOT = join(__dirname, '..');
const read = rel => readFileSync(join(ROOT, rel), 'utf-8');
const LIB = read('lib/license-entry.js');
const ProtonLicenseEntry = new Function(LIB + '\nreturn ProtonLicenseEntry;')();

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

// ---------------------------------------------------------------- Sync's vectors: the ID alone

function theIdAloneHoweverItWasCopied() {
  valid(V, false);
  valid('  ' + V + '\n', false);
  valid(V.toUpperCase(), false);
  valid('﻿' + V, false);
  valid(V.slice(0, 8) + '​' + V.slice(8, 14) + '­' + V.slice(14, 20) + '⁠' + V.slice(20), false);
  valid(' ' + V + ' ', false);
  valid('　' + V + '　', false);
  valid(fullWidth(V), false);
}

// ---------------------------------------------------------------- Sync's vectors: the ID in other text

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
  // The same ID twice is still one ID.
  valid(V + ' ' + V, true);
  // "sub_" typed by hand, then the whole ID pasted after it, is that ID.
  valid('sub_' + V, true);
  valid('sub_ ' + V, true);
  valid('sub_sub_' + V, true);
  valid('sub_' + V + V, true);
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

// ---------------------------------------------------------------- Sync's vectors: not an ID

function cutShortTooLongOrMistyped() {
  kind(V + 'x', 'mistyped_sub_id');
  kind(V.slice(0, -1), 'mistyped_sub_id');
  kind(V.slice(0, -1) + 'u', 'mistyped_sub_id');
  for (const letter of ['i', 'l', 'o']) kind(V.slice(0, 10) + letter + V.slice(11), 'mistyped_sub_id');
  kind('sub_81' + V.slice(6), 'mistyped_sub_id');
  kind('sub-' + V.slice(4), 'mistyped_sub_id');
}

// ---------------------------------------------------------------- Sync's vectors: transaction IDs

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
  // A prefix typed in front of the pasted ID is no second ID. (Sync also
  // lets "sub_" typed after it through: see aPrefixAfterATransactionId.)
  transaction('txn_' + T, true);
  transaction('sub_' + T, true);
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
}

function aBrokenTransactionId() {
  kind(T.slice(0, -1), 'mistyped_txn_id');
  kind(T + 'x', 'mistyped_txn_id');
  kind(T.slice(0, -1) + 'u', 'mistyped_txn_id');
  kind('txn_81' + T.slice(6), 'mistyped_txn_id');
  kind('https://apps.example/checkout.html?_ptxn=' + T.slice(0, -2), 'mistyped_txn_id');
  // The prefix alone, too.
  kind('txn_', 'mistyped_txn_id');
  kind('TXN_', 'mistyped_txn_id');
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
  // Three characters short: without the space, "txn" would make it whole, and that made-up ID was sent.
  kind(V.slice(0, -3) + ' ' + T, 'mistyped_sub_id');
  kind(V.slice(0, -3) + '\n' + T, 'mistyped_sub_id');
  kind(T + ' sub-' + V.slice(4), 'mistyped_sub_id');
  kind(T + V.slice(0, -1), 'mistyped_sub_id');
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
  // With whitespace between the two it is a receipt line, where the subscription ID decides.
  valid(T + ' ' + V, true);
  valid(T.slice(0, 15) + '\n' + T.slice(15) + '\n' + V, true);
  valid(T + '\nSubscription ID ' + V, true);
  // Whatever of a transaction ID stands apart from a subscription ID, whole,
  // cut short or only begun, is the receipt's (Sync's answer too).
  valid(V + ' ' + T.slice(0, -3), true);
  valid(V + ' txn_', true);
  kind(T.slice(0, -3) + V, 'mistyped_txn_id');
  kind(V + T.slice(0, -3), 'mistyped_txn_id');
  // "txn_" typed in front of a pasted subscription ID is a typed prefix, as "sub_" is.
  valid('txn_' + V, true);
}

function aGooglePlayOrderNumber() {
  kind('Gpa.1234-5678-9012-34567', 'play_order');
  kind('gpa.1234-5678-9012-34567..0', 'play_order');
  kind('  gpa.1234-5678-9012-34567  ', 'play_order');
}

function anEmailAddress() {
  kind(EMAIL, 'email');
  kind('Thanks for your order! A receipt was sent to ' + EMAIL + '. Total: EUR 1.99', 'email');
}

function thePrefixAloneOrBeforeAnAddress() {
  // Both seen in the proxy's logs: a customer typed "sub_", then "sub_" and an email address.
  kind('sub_', 'mistyped_sub_id');
  kind('sub-', 'mistyped_sub_id');
  kind('sub_' + EMAIL, 'email');
  kind('sub_ ' + EMAIL, 'email');
  // A real attempt at an ID next to an address (a receipt line) is still a mistyped ID.
  kind('Subscription ' + V.slice(0, -1) + ', receipt sent to ' + EMAIL, 'mistyped_sub_id');
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

// ---------------------------------------------------------------- where Mail Checker answers otherwise, on purpose

// Sync looks up the transaction ID when "sub_" or "txn_" follows it. Here a
// prefix at the very end is a new ID begun after it, after a transaction ID
// as after a subscription ID: the field keeps what was entered when an
// activation fails, so an earlier ID with a new one begun after it must not
// be looked up again in place of the new one.
function aPrefixAfterATransactionId() {
  kind(T + ' sub_', 'mistyped_sub_id');
  kind(T + 'sub_', 'mistyped_sub_id');
  kind(T + 'txn_', 'mistyped_txn_id');
  kind(T + ' txn_', 'mistyped_txn_id');
  kind(T + ' txn-', 'mistyped_txn_id');
  kind(T + ' sub_07', 'mistyped_sub_id');
}

// Sync refuses any "sub_0" or "txn_0" beside the ID found. Beside an ID the
// text shows whole, a copy of that ID cut short (more than the ULID's time,
// ten characters, and all of it the ID's start) is the same ID, and a short
// piece standing apart from it (a "Txn_1" label, an ID shortened for a table)
// is too little to be a second one; both are passed over.
function aCutCopyOrAShortPieceBesideTheId() {
  transaction('Transaction ID: ' + T + '\nhttps://apps.example/checkout.html?_ptxn=txn_07h04vsc0qhwtsb...', true);
  transaction(T + ' (txn_07h04vsc...)', true);
  transaction('Txn_1 ' + T, true);
  transaction('txn_07h04vsc0qhw shown in the table, ' + T + ' in full', true);
  valid('Subscription ID: ' + V + '\nhttps://apps.example/success.html?_sub=sub_07h04vsc0qhwtsb...', true);
  valid(V + ' (sub_07h04vsc...)', true);
  valid('Sub_1 ' + V, true);
  valid('Subscription ' + V + ' (shown as sub_07h04vsc0qhw in the portal)', true);
  // A cut copy run straight into the ID, an earlier entry with the whole ID
  // pasted after it, is that ID too, and so is the ID once more with the
  // "sub-" typo.
  valid(V.slice(0, -3) + V, true);
  transaction(T + T.slice(0, -3), true);
  valid(V + ' sub-' + V.slice(4), true);
  // A subscription ID shortened beside a transaction ID is too little to say
  // which subscription was meant: the transaction ID is looked up.
  transaction('Subscription sub_07h04v..., transaction ' + T, true);
  // Ten characters after the prefix are no more than a ULID's time: too
  // little to be a second ID, wherever they come from. (Eleven are: see
  // whatStillRefusesBesideAWholeId.)
  valid('sub_07' + 'a'.repeat(8) + ' ' + V, true);
  transaction('txn_07' + 'b'.repeat(8) + ' ' + T, true);
}

// What still refuses beside a whole ID: a short piece run straight into it
// or left at the very end (a new ID begun against an earlier entry), a piece
// longer than the ULID's time that is not the ID's start, and anything at
// all beside an ID the text only shows split by whitespace.
function whatStillRefusesBesideAWholeId() {
  kind('sub_07h0' + V, 'mistyped_sub_id');
  kind(V + 'sub_07h0', 'mistyped_sub_id');
  kind(V + 'sub_07h0&x=1', 'mistyped_sub_id');
  kind(V + ' sub_07', 'mistyped_sub_id');
  kind('txn_07h0' + T, 'mistyped_txn_id');
  kind(T + 'txn_07h0', 'mistyped_txn_id');
  kind(T + ' txn_1', 'mistyped_txn_id');
  kind('sub_07h0' + T, 'mistyped_sub_id');
  kind('txn_07h0' + V, 'mistyped_txn_id');
  kind('sub_07' + 'a'.repeat(9) + ' ' + V, 'mistyped_sub_id');
  kind('txn_07' + 'b'.repeat(9) + ' ' + T, 'mistyped_txn_id');
  // A copy is all of it the ID's start: one that goes on otherwise (a typo
  // in it) is a broken second ID, however much it shares.
  kind('sub_' + V.slice(4, 18) + 'aaaa ' + V, 'mistyped_sub_id');
  kind('txn_' + T.slice(4, 18) + 'bbbb ' + T, 'mistyped_txn_id');
  kind(V + ' sub-' + V.slice(4) + 'x', 'mistyped_sub_id');
  // Beside an ID the text only shows split by whitespace, nothing is passed
  // over: the text without whitespace can run a cut ID and the next word
  // into a made-up whole one, and a copy of that is no proof.
  kind(V.slice(0, 15) + '\n' + V.slice(15) + ' (sub_07h04vsc...)', 'mistyped_sub_id');
  kind(V.slice(0, 15) + '\n' + V.slice(15) + ' (shown as sub_07h04vsc0qhw)', 'mistyped_sub_id');
  kind('Txn_1 ' + T.slice(0, 15) + '\n' + T.slice(15), 'mistyped_txn_id');
  // Beside a transaction ID, a broken transaction ID is named before a
  // broken subscription ID, as in Sync.
  kind(T + ' ' + T2.slice(0, -3) + ' ' + V.slice(0, -3), 'mistyped_txn_id');
  // The "txn-" typo is never a whole second ID, in front of a subscription
  // ID or beside a transaction ID.
  kind('txn-' + T.slice(4) + V, 'mistyped_txn_id');
  kind(T + ' txn-' + T2.slice(4), 'mistyped_txn_id');
}

// Sync takes every email address out before it looks for a mistyped ID, and
// its address pattern runs a link or a label into the address: a broken ID
// there went with it. An address whose local part holds the start of an ID
// stays, so the broken ID is named; "sub_" or "txn_" typed in front of an
// address is still the address.
function aBrokenIdRunIntoAnAddress() {
  kind('https://apps.example/checkout.html?_ptxn=txn_07h04vsc0qhwtsbsxh3422&email=' + EMAIL, 'mistyped_txn_id');
  kind('Transaction ID' + T + 'Email' + EMAIL, 'mistyped_txn_id');
  kind('https://apps.example/success.html?_sub=sub_07h04vsc0qhwtsbsxh3422&email=' + EMAIL, 'mistyped_sub_id');
  kind(T.slice(0, -3) + ',' + EMAIL, 'mistyped_txn_id');
  kind('txn_' + EMAIL, 'email');
  kind('sub_' + EMAIL, 'email');
  kind('sub_ ' + EMAIL + ', ' + 'other@example.com', 'email');
}

// Sync ends an ID in "txn" right before a "-": an ID cut short by three and
// run into the "txn-" typo then passed as a whole made-up ID, which was sent.
// Never here.
function noMadeUpIdFromTheTxnTypo() {
  kind(FAKE.slice(0, -3) + 'txn-' + T.slice(4), 'mistyped_txn_id');
  kind(V.slice(0, -3) + 'txn-', 'mistyped_sub_id');
  kind(T2.slice(0, -3) + 'txn-' + T.slice(4), 'mistyped_txn_id');
  kind(T2.slice(0, -3) + ' txn-', 'mistyped_txn_id');
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
    // Dropped before the text is trimmed, as in Sync: the space inside is
    // then at the very edge, and the ID is still the ID alone.
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
  // An ID never ends right before "_" either, as in Sync.
  kind(V + '_', 'mistyped_sub_id');
  kind(T + '_', 'mistyped_txn_id');
  // Prefixes typed in front of a pasted transaction ID are passed over.
  transaction('sub_' + T, true);
  transaction('txn_' + T, true);
  transaction('sub_ ' + T, true);
  transaction('sub_Transaction ID: ' + T, true);
}

function theCustomersSubPrefixAndEmail() {
  // Seen in the proxy's logs: first "sub_" alone, then "sub_" and an email
  // address. The first is incomplete, the second an email address.
  kind('sub_', 'mistyped_sub_id');
  kind('sub_' + EMAIL, 'email');
}

function googlePlayOrdersAndPlainEmails() {
  kind('Order number: Gpa.1234-5678-9012-34567 (Google Play)', 'play_order');
  kind('first.last+mail@example.com', 'email');
  kind('NAME@EXAMPLE.COM', 'email');
  kind('  ' + EMAIL + '\n', 'email');
  // Two addresses with only a comma between them, "sub_" typed in front of
  // the second: both are taken out, as Sync's pattern does.
  kind(EMAIL + ',' + 'other@example.com', 'email');
  kind(EMAIL + ',sub_' + EMAIL, 'email');
  // Only the whole shape is an order number.
  kind('gpa.1234-5678-9', 'not_an_id');
}

// Text without an ID gets the first kind that fits, in Sync's order: a Play
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
  'a Google Play order number is named as one': aGooglePlayOrderNumber,
  'an email address is named as one': anEmailAddress,
  'the prefix alone, or typed in front of an email address, is answered as what it is': thePrefixAloneOrBeforeAnAddress,
  'a transaction ID wins over an email address in the same text': aTransactionIdBesideAnAddress,
  'blank text is empty': blankText,
  'anything else is not an ID': anythingElse,
  'an upper-case ID reads the same on any locale': upperCaseOnAnyLocale,
};

const OWN_ANSWER_GROUPS = {
  'a prefix typed after a transaction ID is a new ID begun': aPrefixAfterATransactionId,
  'a cut copy of the ID, or a short piece apart from it, is passed over beside a whole ID': aCutCopyOrAShortPieceBesideTheId,
  'what still refuses beside a whole ID': whatStillRefusesBesideAWholeId,
  'a broken ID run into an email address is still named as a broken ID': aBrokenIdRunIntoAnAddress,
  'no made-up ID comes out of the "txn-" typo': noMadeUpIdFromTheTxnTypo,
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
  'the customer who typed "sub_", then "sub_" and an email address': theCustomersSubPrefixAndEmail,
  'Google Play orders and plain email addresses': googlePlayOrdersAndPlainEmails,
  'text without an ID gets the first kind that fits, in Sync\'s order': theOrderOfTheKinds,
};

describe('Sync 2.0.2 vectors', () => {
  for (const [name, group] of Object.entries(GROUPS)) it(name, group);
});

describe('where Mail Checker answers otherwise, on purpose', () => {
  for (const [name, group] of Object.entries(OWN_ANSWER_GROUPS)) it(name, group);
});

describe('what Mail Checker customers paste', () => {
  for (const [name, group] of Object.entries(MAIL_CHECKER_GROUPS)) it(name, group);

  it('reads a long paste quickly, whatever it holds', () => {
    // From every character, Sync's email pattern took seconds on such text,
    // and its leftover pattern on a long run of prefixes. Every pass here is
    // linear: these are 200,000 characters each.
    const N = 200000;
    const started = Date.now();
    kind('a'.repeat(N), 'not_an_id');
    kind('x'.repeat(N) + '@example', 'not_an_id');
    // A prefix followed by anything else is not a broken ID, as in Sync.
    valid('sub_'.repeat(N / 4) + 'x' + V, true);
    valid('sub_'.repeat(N / 4) + V, true);
    // Walked back from the ID over a long run, once.
    valid('0'.repeat(N) + V, true);
    valid('txn_' + '0 '.repeat(N / 2) + '0' + V, true);
    // Many short pieces and cut copies beside the ID.
    valid('sub_0 '.repeat(N / 6) + V, true);
    transaction('txn_07h04vsc0qhw '.repeat(N / 17) + T, true);
    kind('txn_0'.repeat(N / 5) + '@example.com', 'mistyped_txn_id');
    expect(Date.now() - started).toBeLessThan(3000);
  });
});

describe('privacy', () => {
  it('no entry holds the text it came from, an email address, or anything but its kind and ID', () => {
    seen.length = 0;
    const all = [...Object.values(GROUPS), ...Object.values(OWN_ANSWER_GROUPS), ...Object.values(MAIL_CHECKER_GROUPS)];
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
    // The ID patterns are global; a stale lastIndex would skip an ID.
    for (let i = 0; i < 3; i++) {
      expect(ProtonLicenseEntry.parse(V)).toEqual({ kind: 'valid', id: V });
      expect(ProtonLicenseEntry.parse(EMAIL)).toEqual({ kind: 'email' });
      expect(ProtonLicenseEntry.parse('Txn_1 ' + T)).toEqual({ kind: 'valid_in_text', id: T });
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
