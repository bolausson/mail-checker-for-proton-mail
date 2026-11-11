/**
 * @vitest-environment jsdom
 *
 * The calendar invite card and the RSVP it sends, run through the real popup
 * module (popup/calendar-utils.js), the real background parser
 * (background/calendar-ics.js) and the real translations (lib/i18n.js). What
 * each block protects against:
 *
 *  1. Markup in a mail we send. The RSVP body goes out as text/html from the
 *     user's own address, and the invite title in it was chosen by whoever
 *     sent the invite. So was the +tag on our own attendee address, which
 *     still resolves to us. Unescaped, either one becomes live markup in the
 *     organizer's client.
 *  2. ICS escapes on show. The subject and body a human reads must say
 *     "Lunch, then demo", not "Lunch\, then demo", and an escaped line break
 *     must never become a line break in a mail subject. The same goes for
 *     the organizer and attendee names on the card.
 *  3. English in a translated card. The status words on the attendee badges,
 *     both on the card and in the live list of a non-REQUEST invite, come
 *     from the language active when they are painted, and the attendee count
 *     uses that language's plural form ("1 attendee", Polish "2 uczestnicy").
 *  4. A dropped property. A stray quote in a parameter can pair with a quote
 *     in the value, which leaves no unquoted colon on the line at all. Both
 *     parsers must then fall back to the first colon instead of dropping the
 *     property, because a dropped SUMMARY loses the whole invite card in the
 *     popup and "add to calendar" in the background. The two parsers are
 *     copies kept in step on purpose, so every parser case runs on both.
 */

import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const ROOT = join(__dirname, '..');
const CALENDAR = readFileSync(join(ROOT, 'popup', 'calendar-utils.js'), 'utf-8');
const CALENDAR_ICS = readFileSync(join(ROOT, 'background', 'calendar-ics.js'), 'utf-8');
const I18N = readFileSync(join(ROOT, 'lib', 'i18n.js'), 'utf-8');
const ProtonSenderAlias = new Function(readFileSync(join(ROOT, 'lib', 'sender-alias.js'), 'utf-8') + '\nreturn ProtonSenderAlias;')();

// The account's own address, as GET_ADDRESSES reports it.
const ME = 'me@example.com';
const ORGANIZER = 'organizer@example.org';
const STATUS_KEYS = ['rsvpStatusAccepted', 'rsvpStatusTentative', 'rsvpStatusDeclined', 'rsvpStatusPending'];

// The real translation module, so a status word and a plural form are the
// ones the user gets. One instance for the whole file: the card must read the
// language when it paints, not when it loads, and tests switch it in between.
let I18n;
let bgParse;

beforeAll(() => {
  I18n = new Function(I18N + '\nreturn ProtonI18n;')();
  bgParse = new Function(CALENDAR_ICS + '\nreturn ProtonCalendarICS;')().parse;
});

afterEach(() => { I18n.setLanguage('en'); });

const flush = () => new Promise((r) => setTimeout(r, 0));

/** Escape a string as an ICS TEXT value, so the card's unescape hands back exactly this string. */
function icsText(s) {
  return s.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/,/g, '\\,').replace(/;/g, '\\;');
}

function invite({
  method = 'REQUEST',
  summary = 'Planning',
  organizer = 'ORGANIZER;CN=Organizer:mailto:' + ORGANIZER,
  attendees = ['ATTENDEE;PARTSTAT=NEEDS-ACTION:mailto:' + ME],
} = {}) {
  return [
    'BEGIN:VCALENDAR',
    'METHOD:' + method,
    'BEGIN:VEVENT',
    'UID:calendar-fixes-1',
    'SUMMARY:' + summary,
    'DTSTART:20261105T100000Z',
    'DTEND:20261105T110000Z',
    organizer,
    ...attendees,
    'END:VEVENT',
    'END:VCALENDAR',
  ].join('\r\n');
}

/**
 * A fresh popup module. `replies` answers the background messages by type;
 * every message the card sends is recorded in `sent`.
 */
function loadCalendar(replies = {}) {
  const sent = [];
  const answers = { GET_ADDRESSES: [{ Email: ME }], CALENDAR_RSVP: {}, ...replies };
  const browserShim = {
    runtime: {
      sendMessage: async (m) => {
        sent.push(m);
        const a = answers[m.type];
        return typeof a === 'function' ? a(m) : (a === undefined ? null : a);
      },
    },
    tabs: { create() {} },
  };
  const mod = new Function('browser', 'ProtonI18n', 'window', 'ProtonSenderAlias',
    CALENDAR + '\nreturn PopupCalendar;')(browserShim, I18n, globalThis.window, ProtonSenderAlias);
  return { mod, sent };
}

/** Parse and render one invite, the way detectCalendarInvite does. */
function mountCard(ics, replies = {}) {
  const { mod, sent } = loadCalendar(replies);
  const event = mod.parseICS(ics);
  const host = document.createElement('div');
  mod.renderCalendarInvite(event, 'acc1', ics, {
    containerEl: host,
    getSelectedMsg: () => ({ ID: 'm1', ConversationID: 'c1', _accountId: 'acc1', _accountEmail: ME }),
    showToast: () => {},
  });
  return { host, sent, event };
}

/** Click one RSVP button and return the CALENDAR_RSVP message the card sent. */
async function rsvp(ics, buttonKey = 'accept', replies = {}) {
  const { host, sent } = mountCard(ics, replies);
  const btn = [...host.querySelectorAll('.calendar-invite-buttons .calendar-invite-btn')]
    .find(b => b.textContent === I18n.t(buttonKey));
  btn.click();
  for (let i = 0; i < 10 && !sent.some(m => m.type === 'CALENDAR_RSVP'); i++) await flush();
  const msg = sent.find(m => m.type === 'CALENDAR_RSVP');
  expect(msg).toBeTruthy();
  return msg;
}

/** Parse an outgoing HTML body the way the organizer's client will. */
function parseBody(html) {
  const tpl = document.createElement('template');
  tpl.innerHTML = html;
  return tpl.content;
}

/**
 * The body must be our one wrapper element holding a single text node, and
 * that text must read exactly as the sentence with the raw values in it: no
 * tag, attribute, comment or entity from the invite survives as anything else.
 */
function expectInertBody(htmlBody, expectedText) {
  const frag = parseBody(htmlBody);
  expect(frag.childNodes).toHaveLength(1);
  const wrapper = frag.firstChild;
  expect(wrapper.nodeType).toBe(1);
  // No attribute on the wrapper either, so no part of the invite can sit in one.
  expect(wrapper.attributes).toHaveLength(0);
  expect(wrapper.querySelectorAll('*')).toHaveLength(0);
  expect([...wrapper.childNodes].map(n => n.nodeName)).toEqual(['#text']);
  expect(wrapper.textContent).toBe(expectedText);
  // And on the wire: "<" is what opens markup in text, so the wrapper's own
  // two tags must be the only ones. A ">" in text is harmless and may stay.
  expect(htmlBody.match(/</g)).toHaveLength(2);
}

// --- 1. The RSVP body is inert HTML, whatever the invite says -----------------

describe('the RSVP mail body never carries markup from the invite', () => {
  // Each of these is a SUMMARY an organizer can put in an invite. None of them
  // uses "$", because the translation lookup treats "$" patterns in its
  // arguments specially and the expected text is computed through it.
  const HOSTILE_TITLES = [
    ['an image with an onerror handler', '<img src=x onerror=alert(1)>'],
    ['a script element', '<script>alert(document.cookie)</script>'],
    ['a closing tag that breaks out to plant a link',
      '</div><a href="https://example.net/login">Confirm your password</a><div>'],
    ['a style element that hides the mail', '<style>*{display:none}</style>Lunch'],
    ['an svg with an onload handler', '<svg/onload=alert(1)>'],
    ['an iframe with inline content', '<iframe srcdoc="<script>alert(1)</script>"></iframe>'],
    ['a form that posts elsewhere', '<form action="https://example.net/collect"><input name=pw></form>'],
    ['an open comment that would swallow the rest', 'Lunch <!-- everything after this would vanish'],
    ['a tag left open', '<img src=x onerror=alert(1)//'],
    ['a bare less-than sign', 'Sizing: 3<5 and x<y'],
    ['text that is already entity-escaped', '&lt;b&gt;already escaped&lt;/b&gt; &amp; kept literal'],
  ];

  it.each(HOSTILE_TITLES)('keeps %s as plain text in the body we send', async (_label, title) => {
    const msg = await rsvp(invite({ summary: icsText(title) }));
    expect(msg.organizerEmail).toBe(ORGANIZER);
    expectInertBody(msg.htmlBody, I18n.t('hasAccepted', ME, title));
  });

  it('does the same for the tentative and the decline reply', async () => {
    const title = '<img src=x onerror=alert(1)>';
    for (const [button, sentence] of [['tentative', 'hasTentativelyAccepted'], ['decline', 'hasDeclined']]) {
      const msg = await rsvp(invite({ summary: icsText(title) }), button);
      expectInertBody(msg.htmlBody, I18n.t(sentence, ME, title));
    }
  });

  it('escapes a hostile +tag on our own attendee address, which still resolves to us', async () => {
    // The base address matches the account, so the card treats this attendee
    // as us and echoes the invited spelling, +tag and all, in the body.
    const invited = 'me+<img src=x onerror=alert(1)>@example.com';
    const msg = await rsvp(invite({ attendees: ['ATTENDEE;PARTSTAT=NEEDS-ACTION:mailto:' + invited] }));
    expect(msg.attendeeEmail).toBe(invited);
    expect(msg.senderAddress).toBe(ME);
    expectInertBody(msg.htmlBody, I18n.t('hasAccepted', invited, 'Planning'));
  });

  it('answers an invitation sent to a +alias from that +alias, as Proton Calendar does', async () => {
    const invited = 'me+club@example.com';
    const msg = await rsvp(invite({ attendees: ['ATTENDEE;PARTSTAT=NEEDS-ACTION:mailto:' + invited] }), 'accept',
      { GET_ADDRESSES: [{ Email: ME, CanAlias: true }] });
    expect(msg.attendeeEmail).toBe(invited);
    expect(msg.senderAddress).toBe(invited);
  });

  it('answers from the base address when that address cannot carry a +alias', async () => {
    const invited = 'me+club@example.com';
    const msg = await rsvp(invite({ attendees: ['ATTENDEE;PARTSTAT=NEEDS-ACTION:mailto:' + invited] }), 'accept',
      { GET_ADDRESSES: [{ Email: ME, CanAlias: false }] });
    expect(msg.attendeeEmail).toBe(invited);
    expect(msg.senderAddress).toBe(ME);
  });

  it('escapes in a translated sentence too', async () => {
    I18n.setLanguage('de');
    const title = '<b onmouseover=alert(1)>Budget</b>';
    const msg = await rsvp(invite({ summary: icsText(title) }));
    expectInertBody(msg.htmlBody, I18n.t('hasAccepted', ME, title));
  });

  it('leaves the subject, a plain-text header, unescaped', async () => {
    // Escaping belongs to the HTML body only: "&lt;" in a subject line is
    // what the organizer would then read.
    const title = 'Q&A <draft> "final"';
    const msg = await rsvp(invite({ summary: icsText(title) }));
    expect(msg.subject).toBe(I18n.t('acceptedSubject', title));
    expectInertBody(msg.htmlBody, I18n.t('hasAccepted', ME, title));
  });
});

// --- 2. ICS escapes are undone for the words a human reads ---------------------

describe('the RSVP subject and body show the title as written', () => {
  const WIRE = 'Lunch\\, then demo\\nFriday';
  const SHOWN = 'Lunch, then demo Friday';

  it('unescapes the title and flattens its line break in the subject and body', async () => {
    const msg = await rsvp(invite({ summary: WIRE }));
    expect(msg.subject).toBe(I18n.t('acceptedSubject', SHOWN));
    expect(msg.subject).not.toMatch(/[\r\n\\]/);
    expect(parseBody(msg.htmlBody).textContent).toBe(I18n.t('hasAccepted', ME, SHOWN));
  });

  it('still sends the title escaped in the attached REPLY', async () => {
    // The display copy is a copy: the calendar part must stay valid ICS.
    const msg = await rsvp(invite({ summary: WIRE }));
    expect(msg.icsData.split('\r\n')).toContain('SUMMARY:' + WIRE);
  });
});

describe('the card shows organizer and attendee names without ICS escapes', () => {
  const ics = invite({
    organizer: 'ORGANIZER;CN=Roe\\, Richard:mailto:' + ORGANIZER,
    attendees: [
      'ATTENDEE;CN=Doe\\, Jane;PARTSTAT=ACCEPTED:mailto:jane@example.net',
      'ATTENDEE;PARTSTAT=NEEDS-ACTION:mailto:' + ME,
    ],
  });

  it('shows the organizer name as written', () => {
    const { host, event } = mountCard(ics);
    const shown = [...host.querySelectorAll('.calendar-invite-detail > span:not(.calendar-invite-detail-icon)')]
      .map(s => s.textContent);
    expect(shown).toContain('Roe, Richard');
    expect(shown.some(t => t.includes('\\'))).toBe(false);
    // Display only: the stored name keeps its escape for the REPLY.
    expect(event.organizer.name).toBe('Roe\\, Richard');
  });

  it('shows each attendee name as written in the attendee list', () => {
    const { host } = mountCard(ics);
    const rows = [...host.querySelectorAll('.calendar-invite-attendee > span:first-child')]
      .map(s => s.textContent);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toContain('Doe, Jane');
    expect(rows.some(t => t.includes('\\'))).toBe(false);
  });
});

// --- 3. Status words and counts in the active language ------------------------

describe('attendee status words follow the active language', () => {
  /** Switch the UI to `lang` and return its four status words. */
  function useLanguage(lang) {
    I18n.setLanguage('en');
    const english = STATUS_KEYS.map(k => I18n.t(k));
    I18n.setLanguage(lang);
    const words = STATUS_KEYS.map(k => I18n.t(k));
    // The words must differ from English, or a hardcoded English table passes.
    expect(words).not.toEqual(english);
    return words;
  }

  const ATTENDEES = [
    'ATTENDEE;PARTSTAT=ACCEPTED:mailto:a@example.net',
    'ATTENDEE;PARTSTAT=TENTATIVE:mailto:b@example.net',
    'ATTENDEE;PARTSTAT=DECLINED:mailto:c@example.net',
    'ATTENDEE;PARTSTAT=NEEDS-ACTION:mailto:' + ME,
  ];
  const badgeTitles = (host) => [...host.querySelectorAll('.calendar-invite-attendee-status')].map(b => b.title);

  it('labels the badges seeded from the invite in German', () => {
    const words = useLanguage('de');
    const { host } = mountCard(invite({ attendees: ATTENDEES }));
    expect(badgeTitles(host)).toEqual(words);
  });

  it('labels the badges repainted from the calendar in the language active at repaint time', async () => {
    // Statuses from the server differ from the invite's PARTSTATs, so every
    // badge is repainted, after the language changed underneath the card.
    const live = {
      attendees: [
        { Email: 'a@example.net', Status: 0 },
        { Email: 'b@example.net', Status: 2 },
        { Email: 'c@example.net', Status: 3 },
        { Email: ME, Status: 1 },
      ],
    };
    const { host } = mountCard(invite({ attendees: ATTENDEES }), { GET_CALENDAR_ATTENDEES: live });
    expect(badgeTitles(host)).toEqual(STATUS_KEYS.map(k => I18n.t(k)));
    const words = useLanguage('pl');
    for (let i = 0; i < 5; i++) await flush();
    const [accepted, tentative, declined, pending] = words;
    expect(badgeTitles(host)).toEqual([pending, declined, accepted, tentative]);
  });

  it('labels the live attendee list of a non-REQUEST invite in the language active when it paints', async () => {
    // A REPLY drops the invite's own attendee row and lists the calendar's
    // attendees instead, painted by a separate code path once the fetch
    // answers. The language changes while that fetch is still pending.
    const live = {
      attendees: [
        { Email: 'a@example.net', Status: 3 },
        { Email: 'b@example.net', Status: 1 },
        { Email: 'c@example.net', Status: 2 },
        { Email: 'd@example.net', Status: 0 },
      ],
    };
    const { host, sent } = mountCard(invite({ method: 'REPLY', attendees: ATTENDEES }), { GET_CALENDAR_ATTENDEES: live });
    const words = useLanguage('de');
    for (let i = 0; i < 5; i++) await flush();
    expect(sent.some(m => m.type === 'GET_CALENDAR_ATTENDEES')).toBe(true);
    const rows = [...host.querySelectorAll('.calendar-invite-attendee > span:first-child')].map(s => s.textContent);
    expect(rows).toEqual(['a@example.net', 'b@example.net', 'c@example.net', 'd@example.net']);
    expect(badgeTitles(host)).toEqual(words);
  });
});

describe('the attendee count uses the plural form of the active language', () => {
  const countText = (n, lang) => {
    I18n.setLanguage(lang);
    const attendees = [];
    for (let i = 1; i < n; i++) attendees.push('ATTENDEE;PARTSTAT=NEEDS-ACTION:mailto:guest' + i + '@example.net');
    attendees.push('ATTENDEE;PARTSTAT=NEEDS-ACTION:mailto:' + ME);
    const { host } = mountCard(invite({ attendees }));
    return host.querySelector('.calendar-invite-attendees-toggle').textContent;
  };

  it('uses the singular form for a single attendee in English', () => {
    const one = countText(1, 'en');
    const three = countText(3, 'en');
    expect(one).toBe(I18n.plural('attendeesCount', 1));
    expect(three).toBe(I18n.plural('attendeesCount', 3));
    // English inflects the noun for one, so the forms must differ.
    expect(one.replace('1', '')).not.toBe(three.replace('3', ''));
  });

  it('picks the Polish few and many forms', () => {
    const two = countText(2, 'pl');
    const five = countText(5, 'pl');
    expect(two).toBe(I18n.plural('attendeesCount', 2));
    expect(five).toBe(I18n.plural('attendeesCount', 5));
    // Polish inflects the noun between 2 and 5, so the forms must differ.
    expect(two.replace('2', '')).not.toBe(five.replace('5', ''));
  });
});

// --- 4. The colon fallback, in both parsers ------------------------------------

describe('a stray parameter quote that pairs with a quote in the value keeps the property', () => {
  // The quote after LANGUAGE= is unmatched within the parameters, but the
  // quoted word in the title gives it a partner, so every colon on the line
  // sits "inside quotes" and a quote-aware scan finds none. The title has a
  // colon of its own, so only the FIRST colon gives the title back whole.
  const TITLE = 'Agenda: the "Atlas" draft';
  const ics = invite({ summary: TITLE }).replace('SUMMARY:', 'SUMMARY;LANGUAGE="en:');

  it('the popup parser still yields the invite with its title', () => {
    expect(ics).toContain('SUMMARY;LANGUAGE="en:Agenda: the "Atlas" draft');
    const event = loadCalendar().mod.parseICS(ics);
    expect(event).not.toBeNull();
    expect(event.summary).toBe(TITLE);
    const { host } = mountCard(ics);
    expect(host.querySelector('.calendar-invite-title').textContent).toBe(TITLE);
  });

  it('the background parser still yields the title for "add to calendar"', () => {
    const event = bgParse(ics);
    expect(event).not.toBeNull();
    expect(event.summary).toBe(TITLE);
    expect(event.uid).toBe('calendar-fixes-1');
  });
});
