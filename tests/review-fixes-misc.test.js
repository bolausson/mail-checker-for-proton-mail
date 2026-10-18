/**
 * @vitest-environment jsdom
 *
 * The small, self-contained fixes from the adversarial review. Each block
 * names the defect it pins, because every one of these reads as correct code
 * until you know what the old version did to real mail.
 *
 * House rule for this file: no em dash and no en dash anywhere in the source,
 * so the one string that legitimately contains a dash is built with
 * String.fromCharCode.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const ROOT = join(__dirname, '..');
const POLLER = readFileSync(join(ROOT, 'background', 'poller.js'), 'utf-8');
const CALENDAR = readFileSync(join(ROOT, 'popup', 'calendar-utils.js'), 'utf-8');
const CALENDAR_ICS = readFileSync(join(ROOT, 'background', 'calendar-ics.js'), 'utf-8');
const AUTH = readFileSync(join(ROOT, 'background', 'auth.js'), 'utf-8');
const NOTIFIER = readFileSync(join(ROOT, 'background', 'notifier.js'), 'utf-8');
const I18N = readFileSync(join(ROOT, 'lib', 'i18n.js'), 'utf-8');

/** Pull one function's source out of a module IIFE, by brace matching. */
function lift(src, name) {
  let start = src.indexOf('async function ' + name + '(');
  if (start === -1) start = src.indexOf('function ' + name + '(');
  if (start === -1) throw new Error('not found: ' + name);
  let i = src.indexOf('{', start);
  let depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) return src.slice(start, i + 1); }
  }
  throw new Error('unbalanced braces reading ' + name);
}

/** The same, for a `const NAME = { ... };` table. */
function liftConst(src, name) {
  const start = src.indexOf('const ' + name + ' = {');
  if (start === -1) throw new Error('not found: ' + name);
  let i = src.indexOf('{', start);
  let depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) return src.slice(start, i + 1) + ';'; }
  }
  throw new Error('unbalanced braces reading ' + name);
}

// Characters this file must compare against but may not contain literally.
const EM_DASH = String.fromCharCode(0x2014);
const RSQUO = '\u2019';
const EURO = '\u20AC';
const HELLIP = '\u2026';
const COPY = '\u00A9';
const GRINNING = 0x1F600; // "&#128512;"

// --- 1. poller.js: HTML entities in a notification preview -----------------

describe('the notification preview keeps the characters the mail was written with', () => {
  // The pipeline ends in a catch-all that DELETES every named entity it did
  // not decode, and the decode list was five entries long. So the marketing
  // mail a preview exists for lost its apostrophes, dashes and currency signs
  // silently: nothing failed, the words were simply wrong.
  let htmlToText;
  let snippetMax;

  beforeAll(() => {
    snippetMax = Number(POLLER.match(/const SNIPPET_MAX_CHARS = (\d+)/)[1]);
    htmlToText = new Function(
      'const SNIPPET_MAX_CHARS = ' + snippetMax + ';\n' +
      liftConst(POLLER, 'HTML_ENTITIES') + '\n' +
      lift(POLLER, '_entityCodePoint') + '\n' +
      lift(POLLER, '_htmlToText') + '\nreturn _htmlToText;')();
  });

  it('keeps the apostrophe, the dash and the euro sign', () => {
    // Measured before the fix as "Dont miss it only 19 today!".
    const out = htmlToText('<p>Don&rsquo;t miss it &mdash; only &euro;19 today!</p>', 500);
    expect(out).toBe('Don' + RSQUO + 't miss it ' + EM_DASH + ' only ' + EURO + '19 today!');
  });

  it('keeps the ellipsis and the copyright sign', () => {
    const out = htmlToText('<p>Rated 5 &starf; &hellip; &copy; 2026 ACME</p>', 500);
    expect(out).toBe('Rated 5 ' + HELLIP + ' ' + COPY + ' 2026 ACME');
    // &starf; is not in the table and is still dropped, on purpose: an
    // unknown entity must not leak its markup into the preview.
    expect(out).not.toContain('starf');
  });

  it('decodes an astral numeric entity as one code point, not a truncated one', () => {
    const out = htmlToText('<p>Party &#128512; time</p>', 500);
    const at = out.indexOf('Party ') + 'Party '.length;
    // The point of the assertion: String.fromCharCode(128512) silently
    // wrapped to U+F600 (private use), which renders as a broken glyph.
    expect(out.codePointAt(at)).toBe(GRINNING);
    expect(out).not.toContain(String.fromCharCode(128512));
    // One code point, carried as a surrogate pair, so it survives the wire.
    expect([...out].filter(c => c.codePointAt(0) === GRINNING)).toHaveLength(1);
    expect(out).toBe('Party ' + String.fromCodePoint(GRINNING) + ' time');
  });

  it('decodes the hex form of the same code point too', () => {
    const out = htmlToText('<p>Party &#x1F600; time</p>', 500);
    expect(out.codePointAt(out.indexOf('Party ') + 6)).toBe(GRINNING);
  });

  it('still does what it always did: nbsp, amp, tag stripping', () => {
    expect(htmlToText('<p>Tom&nbsp;&amp;&nbsp;Jerry <b>rules</b></p>', 500))
      .toBe('Tom & Jerry rules');
    // &amp; is decoded last of all, so "&amp;starf;" stays literal text
    // instead of being re-read as an entity and deleted.
    expect(htmlToText('<p>Literal &amp;starf; here</p>', 500)).toBe('Literal &starf; here');
    expect(htmlToText('<style>p{color:red}</style><p>Body</p>', 500)).toBe('Body');
  });

  it('still truncates at maxChars, and defaults to the snippet length', () => {
    expect(htmlToText('<p>abcdefghij</p>', 4)).toBe('abcd');
    expect(htmlToText('<p>' + 'x'.repeat(snippetMax + 50) + '</p>')).toHaveLength(snippetMax);
  });
});

// --- 2. popup/calendar-utils.js: ICS TEXT escapes ---------------------------

describe('ICS escapes are undone for display and kept on the wire', () => {
  let unescapeText, parseICS, buildRsvpICS, renderCalendarInvite;

  beforeAll(() => {
    unescapeText = new Function(lift(CALENDAR, '_unescapeText') + '\nreturn _unescapeText;')();
    const mod = new Function('browser', 'ProtonI18n', 'window',
      CALENDAR + '\nreturn PopupCalendar;')(
      { runtime: { sendMessage: () => Promise.resolve(null) }, tabs: { create() {} } },
      { t: (k) => k, plural: (k, n) => n + ' ' + k },
      globalThis.window);
    parseICS = mod.parseICS;
    buildRsvpICS = mod.buildRsvpICS;
    renderCalendarInvite = mod.renderCalendarInvite;
  });

  const GOOGLE_LOCATION = 'Online\\; https://meet.google.com/abc-defg-hij';

  function ics() {
    return [
      'BEGIN:VCALENDAR',
      'METHOD:CANCEL',
      'BEGIN:VEVENT',
      'UID:escape-test-1',
      'SUMMARY:Lunch\\, then slides\\; bring \\\\ the deck',
      'LOCATION:' + GOOGLE_LOCATION,
      'DTSTART:20260415T100000Z',
      'DTEND:20260415T110000Z',
      'ORGANIZER;CN=Alice:mailto:alice@example.com',
      'END:VEVENT',
      'END:VCALENDAR',
    ].join('\r\n');
  }

  it('renders a Google meeting link without the backslash', () => {
    // The user-visible bug: "Online\; https://meet.google.com/..." with a
    // literal backslash sitting in the middle of the invite card.
    const event = parseICS(ics());
    const host = document.createElement('div');
    // CANCEL is the shortest render path that still draws the summary and
    // location rows, so this exercises the real renderer without standing up
    // the whole RSVP machinery.
    renderCalendarInvite(event, 'acc1', ics(), {
      containerEl: host,
      getSelectedMsg: () => ({ ID: 'm1', ConversationID: 'c1', _accountId: 'acc1' }),
      showToast: () => {},
    });
    const texts = [...host.querySelectorAll('span')].map(s => s.textContent);
    const shown = texts.find(t => t.includes('meet.google.com'));
    expect(shown).toBe('Online; https://meet.google.com/abc-defg-hij');
    expect(shown).not.toContain('\\');
    // The summary keeps the ONE backslash the sender escaped, and loses the
    // separators' escapes: "\\," and "\\;" are punctuation, "\\\\" is a
    // backslash the sender meant.
    expect(texts).toContain('Lunch, then slides; bring \\ the deck');
  });

  it('parseICS still returns the ESCAPED value, so the RSVP stays valid', () => {
    // The regression guard. Unescaping in the parser would look right on
    // screen and quietly corrupt every outgoing REPLY: an unescaped ";" or
    // "," in SUMMARY ends the property value and the organizer's server
    // rejects or mis-reads the RSVP.
    const event = parseICS(ics());
    expect(event.summary).toBe('Lunch\\, then slides\\; bring \\\\ the deck');
    expect(event.location).toBe(GOOGLE_LOCATION);

    const reply = buildRsvpICS(event, 'bob@example.com', 'ACCEPTED');
    expect(reply).toContain('SUMMARY:Lunch\\, then slides\\; bring \\\\ the deck');
    expect(reply).not.toContain('SUMMARY:Lunch, then slides');
  });

  it('handles each RFC 5545 TEXT escape, with the double backslash last', () => {
    expect(unescapeText('a\\, b')).toBe('a, b');
    expect(unescapeText('a\\; b')).toBe('a; b');
    expect(unescapeText('line1\\nline2')).toBe('line1\nline2');
    expect(unescapeText('line1\\Nline2')).toBe('line1\nline2');
    expect(unescapeText('C:\\\\temp')).toBe('C:\\temp');
    // A sender who escaped the backslash itself keeps it: "\\;" is a literal
    // backslash followed by a plain separator, not an escaped semicolon. This
    // is why the double-backslash rule has to run LAST: undoing it first
    // leaves a bare "\;" that the semicolon rule then eats.
    expect(unescapeText('C:\\\\;done')).toBe('C:\\;done');
    expect(unescapeText('a\\\\,b')).toBe('a\\,b');
    expect(unescapeText('')).toBe('');
    expect(unescapeText(null)).toBe(null);
  });
});

// --- 3. lib/i18n.js: CLDR plural forms --------------------------------------

describe('plural() picks the CLDR form the language actually uses', () => {
  let I;

  beforeAll(() => {
    // _strings is module-private; expose it through the module's own return,
    // the way tests/i18n-parity.test.js does.
    const code = I18N.replace('return { setLanguage', 'return { _strings, setLanguage');
    const win = {};
    I = new Function('window', 'self',
      code + '; return window.ProtonI18n || self.ProtonI18n || ProtonI18n;')(win, win);
  });

  const FORMS = ['zero', 'one', 'two', 'few', 'many', 'other'];

  /** The form plural() selected, read back through the module's own lookup. */
  function categoryOf(lang, n) {
    I.setLanguage(lang);
    const table = I._strings[lang];
    // Give every form a unique marker, then see which one comes back. This
    // goes through plural() itself, so it pins the selection AND the lookup.
    const saved = {};
    for (const f of FORMS) {
      saved[f] = table['dayCount_' + f];
      table['dayCount_' + f] = f + ':$1';
    }
    const got = I.plural('dayCount', n);
    for (const f of FORMS) table['dayCount_' + f] = saved[f];
    return got.split(':')[0];
  }

  it('English: only 1 is singular', () => {
    expect(categoryOf('en', 1)).toBe('one');
    expect(categoryOf('en', 2)).toBe('other');
    expect(categoryOf('en', 0)).toBe('other');
  });

  it('Polish: one / few / many', () => {
    expect(categoryOf('pl', 1)).toBe('one');
    expect(categoryOf('pl', 2)).toBe('few');
    expect(categoryOf('pl', 5)).toBe('many');
    expect(categoryOf('pl', 22)).toBe('few');
    expect(categoryOf('pl', 12)).toBe('many'); // the teens are the exception
  });

  it('Russian: one / few / many, with the teens taking many', () => {
    expect(categoryOf('ru', 1)).toBe('one');
    expect(categoryOf('ru', 3)).toBe('few');
    expect(categoryOf('ru', 11)).toBe('many');
    expect(categoryOf('ru', 21)).toBe('one');
  });

  it('Slovenian: it has a dual', () => {
    expect(categoryOf('sl', 1)).toBe('one');
    expect(categoryOf('sl', 2)).toBe('two');
    expect(categoryOf('sl', 3)).toBe('few');
    expect(categoryOf('sl', 5)).toBe('other');
  });

  it('Latvian: it has a zero form, and 0 is not "other"', () => {
    expect(categoryOf('lv', 0)).toBe('zero');
    expect(categoryOf('lv', 1)).toBe('one');
    expect(categoryOf('lv', 5)).toBe('other');
    expect(categoryOf('lv', 11)).toBe('zero'); // 11..19 are all zero in lv
  });

  it('still substitutes $1 with the count', () => {
    I.setLanguage('en');
    expect(I.plural('attachmentsCount', 1)).toBe('1 attachment');
    expect(I.plural('attachmentsCount', 3)).toBe('3 attachments');
    expect(I.plural('embeddedImagesCount', 1)).toBe('1 embedded image');
    expect(I.plural('attendeesCount', 7)).toBe('7 attendees');
    expect(I.plural('dayCount', 1)).toBe('1 day');
  });

  it('falls back to a neutral form for a count it cannot classify', () => {
    // A NaN or fractional count must not pick a wrong grammatical form.
    for (const bad of [NaN, Infinity, -1, 1.5]) {
      expect(categoryOf('pl', bad)).toBe('other');
    }
  });

  it('every plural key exists in all six forms in all 28 locales', () => {
    const bases = ['attachmentsCount', 'embeddedImagesCount', 'attendeesCount', 'dayCount'];
    const langs = Object.keys(I._strings);
    expect(langs).toHaveLength(28);
    const missing = [];
    for (const lang of langs) {
      for (const base of bases) {
        for (const f of FORMS) {
          const v = I._strings[lang][base + '_' + f];
          if (typeof v !== 'string' || !v.trim()) missing.push(lang + '.' + base + '_' + f);
        }
      }
    }
    // A gap here is a silent English fallback in the middle of a sentence.
    expect(missing).toEqual([]);
  });

  it('no locale still carries the keys the plural forms replaced', () => {
    const dead = ['everyNMinutes', 'attachmentsCount', 'embeddedImagesCount', 'attendees'];
    const left = [];
    for (const lang of Object.keys(I._strings)) {
      for (const k of dead) {
        if (I._strings[lang][k] !== undefined) left.push(lang + '.' + k);
      }
    }
    expect(left).toEqual([]);
  });

  it('carries the plain keys the invite card needs', () => {
    I.setLanguage('en');
    for (const k of ['attendeeUnknown', 'rsvpYes', 'rsvpMaybe', 'rsvpNo', 'rsvpPending']) {
      expect(typeof I._strings.en[k]).toBe('string');
      expect(I.t(k)).not.toBe(k);
    }
  });
});

// --- 4. background/auth.js: SRP server ephemeral validation -----------------

describe('SRP rejects a server ephemeral that is congruent to zero', () => {
  // RFC 5054: abort if B % N == 0. The old guard was `B === 0n`, so a server
  // (or anyone holding the connection) could send B = N, a perfectly ordinary
  // 256-byte little-endian number that is not zero, and the client would
  // derive its shared secret from base 0. Every proof then becomes
  // predictable without knowing the password.
  const SRP_LEN = Number(AUTH.match(/const SRP_LEN = (\d+)/)[1]);
  const PAST_THE_GUARD = 'PAST-THE-GUARD';
  let generateProofs;
  let bigIntToLE;

  beforeAll(() => {
    const factory = new Function('expandHash', 'crypto', 'ProtonBinary',
      'const SRP_LEN = ' + SRP_LEN + ';\n' +
      lift(AUTH, 'bigIntToLE') + '\n' +
      lift(AUTH, 'leToBigInt') + '\n' +
      lift(AUTH, 'mergeArrays') + '\n' +
      lift(AUTH, 'modPow') + '\n' +
      lift(AUTH, 'generateProofs') + '\n' +
      'return { generateProofs, bigIntToLE };');
    // The first thing generateProofs does after the guard is derive k via
    // expandHash, so a throwing stub proves whether the guard let B past.
    const mod = factory(
      () => { throw new Error(PAST_THE_GUARD); },
      { getRandomValues: (a) => a },
      { uint8ToBase64: () => '' });
    generateProofs = mod.generateProofs;
    bigIntToLE = mod.bigIntToLE;
  });

  // A real Proton modulus is 2048 bits with the top bit set, so B = N is the
  // only multiple of N that fits the 256-byte wire format. Use a number of
  // that shape rather than a toy one.
  const N = (1n << 2047n) + 0x9f3dn;
  const hashedPassword = new Uint8Array(32).fill(7);

  it('rejects B = N, which is non-zero and fits the wire format', async () => {
    await expect(generateProofs(bigIntToLE(N, SRP_LEN), bigIntToLE(N, SRP_LEN), hashedPassword))
      .rejects.toThrow('Invalid server ephemeral');
  });

  it('rejects any other non-zero multiple of N', async () => {
    for (const mult of [2n, 3n, 17n]) {
      await expect(generateProofs(
        bigIntToLE(N, SRP_LEN), bigIntToLE(mult * N, SRP_LEN + 8), hashedPassword))
        .rejects.toThrow('Invalid server ephemeral');
    }
  });

  it('still rejects a literally zero B', async () => {
    await expect(generateProofs(
      bigIntToLE(N, SRP_LEN), new Uint8Array(SRP_LEN), hashedPassword))
      .rejects.toThrow('Invalid server ephemeral');
  });

  it('lets an ordinary B through to the proof derivation', async () => {
    // Proof that the guard did not simply become "reject everything".
    await expect(generateProofs(
      bigIntToLE(N, SRP_LEN), bigIntToLE(N + 1n, SRP_LEN), hashedPassword))
      .rejects.toThrow(PAST_THE_GUARD);
  });
});

// --- 5. background/notifier.js: click map across a worker restart -----------

describe('a notification stays clickable after the worker that showed it died', () => {
  // MV3 tears the background down after about 30 s idle while the OS keeps
  // the notification on screen for minutes. The click then arrives in a fresh
  // worker whose in-memory map is empty, so "Mark as read" and "Archive" did
  // nothing at all: no action, no error, no toast.

  /** storage.session: the part of the browser that outlives a worker. */
  function makeWorld() {
    return { session: {}, notifications: new Map(), tabs: [] };
  }

  const clone = v => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));

  /** One worker: fresh module state over the shared world. */
  function startWorker(world, opts) {
    const o = opts || {};
    const calls = { markRead: [], archive: [], polls: 0, warnings: [] };
    let clickHandler = null;
    const browser = {
      storage: o.noSession ? {} : {
        session: {
          get: async (key) => ({ [key]: clone(world.session[key]) }),
          set: async (obj) => {
            for (const [k, v] of Object.entries(obj)) world.session[k] = clone(v);
          },
        },
      },
      notifications: {
        create: async (id, opt) => { world.notifications.set(id, opt); return id; },
        clear: (id) => world.notifications.delete(id),
        onClicked: { addListener: (fn) => { clickHandler = fn; } },
      },
      tabs: { create: (t) => world.tabs.push(t) },
    };
    const accounts = {
      getAccount: () => ({ id: 'acc1', email: 'user@example.com' }),
      getAccounts: () => [{ id: 'acc1' }],
      getMailUrl: (id) => 'https://mail.proton.me/u/0/' + (id || 'inbox'),
      markAsRead: async (accountId, ids) => { calls.markRead.push({ accountId, ids }); },
      archiveMessages: async (accountId, ids) => { calls.archive.push({ accountId, ids }); },
    };
    const N = new Function('browser', 'getSettings', 'ProtonDND', 'ProtonAccounts',
      'ProtonPremium', 'ProtonI18n', 'ProtonAudioBridge', 'ProtonPoller', 'console',
      NOTIFIER + '\nreturn ProtonNotifier;')(
      browser,
      async () => ({ notificationsEnabled: true, notificationClickAction: o.action || 'markRead' }),
      { isActive: () => false },
      accounts,
      { isPremium: () => true },
      { t: (k) => k, plural: (k, n) => n + ' ' + k },
      { playSound: async () => {} },
      { poll: () => { calls.polls++; } },
      { warn: (...a) => calls.warnings.push(a.join(' ')), log() {}, error() {} });
    N.init();
    return { N, calls, click: (id) => clickHandler(id) };
  }

  const message = {
    ID: 'msg-1', ConversationID: 'conv-1', Subject: 'Invoice',
    Sender: { Name: 'Alice', Address: 'alice@example.com' },
  };

  it('resolves the notification to its message in a later worker', async () => {
    const world = makeWorld();

    // Worker A shows the notification, then the browser kills it.
    const a = startWorker(world);
    await a.N.notifyNewMessages([message], 'user@example.com', 'acc1');
    expect([...world.notifications.keys()]).toEqual(['proton-conv-conv-1']);

    // Worker B has never seen this notification and has only storage.session.
    const b = startWorker(world, { action: 'markRead' });
    await b.click('proton-conv-conv-1');

    expect(b.calls.markRead).toEqual([{ accountId: 'acc1', ids: ['msg-1'] }]);
    expect(b.calls.polls).toBe(1);
    expect(b.calls.warnings).toEqual([]);
  });

  it('does the same for the archive action', async () => {
    const world = makeWorld();
    const a = startWorker(world);
    await a.N.notifyNewMessages([message], 'user@example.com', 'acc1');

    const b = startWorker(world, { action: 'archive' });
    await b.click('proton-conv-conv-1');
    expect(b.calls.archive).toEqual([{ accountId: 'acc1', ids: ['msg-1'] }]);
  });

  it('consumes the entry, so a later worker does not act on it twice', async () => {
    const world = makeWorld();
    const a = startWorker(world);
    await a.N.notifyNewMessages([message], 'user@example.com', 'acc1');

    const b = startWorker(world);
    await b.click('proton-conv-conv-1');
    expect(b.calls.markRead).toHaveLength(1);

    const c = startWorker(world);
    await c.click('proton-conv-conv-1');
    expect(c.calls.markRead).toEqual([]);
    expect(c.calls.warnings.join(' ')).toContain('No message data');
  });

  it('does not wipe entries another worker stored for a live notification', async () => {
    const world = makeWorld();
    const a = startWorker(world);
    await a.N.notifyNewMessages([message], 'user@example.com', 'acc1');

    // A second worker shows a different message while the first is on screen.
    const b = startWorker(world);
    await b.N.notifyNewMessages(
      [{ ...message, ID: 'msg-2', ConversationID: 'conv-2' }], 'user@example.com', 'acc1');

    const c = startWorker(world);
    await c.click('proton-conv-conv-1');
    await c.click('proton-conv-conv-2');
    expect(c.calls.markRead).toEqual([
      { accountId: 'acc1', ids: ['msg-1'] },
      { accountId: 'acc1', ids: ['msg-2'] },
    ]);
  });

  it('still works in a browser without storage.session, within one worker', async () => {
    // Firefox's event page keeps the module alive, so the in-memory map stays
    // the fast path and must not depend on the store existing.
    const world = makeWorld();
    const a = startWorker(world, { noSession: true });
    await a.N.notifyNewMessages([message], 'user@example.com', 'acc1');
    await a.click('proton-conv-conv-1');
    expect(a.calls.markRead).toEqual([{ accountId: 'acc1', ids: ['msg-1'] }]);
  });
});

// --- 6. both copies of _unescapeText: the escape-ordering bug ---------------

describe('ICS TEXT unescaping consumes the backslash together with its escapee', () => {
  // The defect: four sequential replaces, the newline rule first and the
  // double-backslash rule last. The first rule is free to match a backslash
  // that belongs to an escaped-backslash PAIR, and running the pair rule last
  // cannot undo that: the pair is already gone. So the wire value "C:\ndir"
  // decoded to backslash + NEWLINE + "dir" instead of backslash + "n" + "dir".
  //
  // Both copies are pinned here. The background one is the dangerous one: its
  // parse() feeds Add to Proton Calendar, so a wrong decode is written into
  // the user's real calendar rather than merely drawn on an invite card.

  // Every backslash and newline in this block's test data is built from a
  // char code, never typed as a source escape. A test for a backslash bug
  // written with source-level backslashes is how the bug got in.
  const B = String.fromCharCode(92);  // one backslash
  const NL = String.fromCharCode(10); // one newline

  let popupUnescape, bgUnescape, bgParse;

  beforeAll(() => {
    popupUnescape = new Function(lift(CALENDAR, '_unescapeText') + '\nreturn _unescapeText;')();
    bgUnescape = new Function(lift(CALENDAR_ICS, '_unescapeText') + '\nreturn _unescapeText;')();
    // calendar-ics.js is a pure IIFE with no browser globals, so parse() can
    // be exercised end to end: that is the path that reaches the calendar.
    bgParse = new Function(CALENDAR_ICS + '\nreturn ProtonCalendarICS;')().parse;
  });

  /** One case against both copies, so neither can drift away from the other. */
  function both(input, expected) {
    expect(popupUnescape(input)).toBe(expected);
    expect(bgUnescape(input)).toBe(expected);
  }

  it('reads an escaped backslash followed by the letter n as backslash + n', () => {
    // Wire:  C:  \  \  n  d  i  r
    // Right: C:  \  n  d  i  r
    // Old:   C:  \  <newline>  d  i  r
    both('C:' + B + B + 'ndir', 'C:' + B + 'ndir');
    expect(popupUnescape('C:' + B + B + 'ndir')).not.toContain(NL);
    expect(bgUnescape('C:' + B + B + 'ndir')).not.toContain(NL);
  });

  it('does the same for the uppercase N form', () => {
    // \N is the other newline spelling in RFC 5545, and the old rule was /gi.
    both(B + B + 'Notes', B + 'Notes');
  });

  it('does not let a second escaped pair hand the first rule a backslash', () => {
    // Wire:  \ \ \ \ n     Right: \ \ n     Old: \ \ <newline>
    both(B + B + B + B + 'n', B + B + 'n');
  });

  it('still decodes an escaped backslash followed by a real separator', () => {
    // "\;" is a literal backslash and then a plain semicolon, not an
    // escaped semicolon. Same for the comma.
    both('C:' + B + B + ';done', 'C:' + B + ';done');
    both('a' + B + B + ',b', 'a' + B + ',b');
  });

  it('still decodes the plain escapes it always did', () => {
    both('line1' + B + 'nline2', 'line1' + NL + 'line2');
    both('line1' + B + 'Nline2', 'line1' + NL + 'line2');
    both('a' + B + ', b', 'a, b');
    both('a' + B + '; b', 'a; b');
    both('C:' + B + B + 'temp', 'C:' + B + 'temp');
  });

  it('keeps a trailing escaped backslash', () => {
    both('path' + B + B, 'path' + B);
    both(B + B, B);
  });

  it('leaves empty and null input alone', () => {
    both('', '');
    both(null, null);
  });

  it('writes the right SUMMARY and LOCATION into a parsed calendar event', () => {
    // The end-to-end shape of the bug: a UNC path in the title of an invite
    // the user then adds to Proton Calendar. On the wire every backslash is
    // doubled, so "\nas\share" arrives as four backslashes, "nas", two more.
    const ics = [
      'BEGIN:VCALENDAR',
      'METHOD:REQUEST',
      'BEGIN:VEVENT',
      'UID:unescape-order-1',
      'SUMMARY:Deploy ' + B + B + B + B + 'nas' + B + B + 'share',
      'LOCATION:C:' + B + B + 'nightly',
      'DTSTART:20260415T100000Z',
      'DTEND:20260415T110000Z',
      'END:VEVENT',
      'END:VCALENDAR',
    ].join('\r\n');

    const event = bgParse(ics);
    expect(event.summary).toBe('Deploy ' + B + B + 'nas' + B + 'share');
    expect(event.location).toBe('C:' + B + 'nightly');
    // A newline here would also break the serializer's line folding, on top
    // of showing the user a title they never wrote.
    expect(event.summary).not.toContain(NL);
    expect(event.location).not.toContain(NL);
  });
});
