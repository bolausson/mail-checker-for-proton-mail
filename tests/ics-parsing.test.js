/**
 * Tests for PopupCalendar ICS parsing and RSVP generation.
 *
 * The calendar-utils.js module is a browser IIFE, so we eval it
 * with a minimal browser stub to make PopupCalendar available.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

let PopupCalendar;
// The background half of the same invite: ProtonCalendarICS.parse feeds "add
// to calendar", and the serializer's ORGANIZER/ATTENDEE lines are what get
// written into the user's real Proton Calendar. The parameter tests below run
// against BOTH sides, because a card and a calendar entry that disagree about
// the same invite is exactly the failure they guard.
let bgParse, bgOrganizerLine, bgAttendeeLine;
let popupDecodeParam, bgDecodeParam, popupUnescapeText;

/**
 * Pull one function's source out of a module IIFE, by brace matching.
 * Same helper as tests/review-fixes-misc.test.js: these are private helpers
 * inside the IIFE, and exporting them only for tests would widen the modules'
 * public surface for no runtime reason.
 */
function lift(src, name) {
  const start = src.indexOf('function ' + name + '(');
  if (start === -1) throw new Error('not found: ' + name);
  let i = src.indexOf('{', start);
  let depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) return src.slice(start, i + 1); }
  }
  throw new Error('unbalanced braces reading ' + name);
}

// Every global this file fakes, remembered so afterAll can put back whatever
// was there before. These stubs must not outlive the file: badge.js and
// poller.js prefer a ProtonI18n lookup and only fall back to English when it is
// undefined, so a leaked ProtonI18n would quietly hand other test files a
// translated string where they assert the English one. Vitest isolates files
// today, but --no-isolate would make that leak real.
const stubbed = new Map();

function stub(name, value) {
  if (!stubbed.has(name)) stubbed.set(name, { had: name in globalThis, prev: globalThis[name] });
  globalThis[name] = value;
}

beforeAll(() => {
  // Minimal stubs for browser APIs used by the module
  stub('browser', { runtime: { sendMessage: () => Promise.resolve({}) } });
  stub('document', { createElement: () => ({ append() {}, appendChild() {}, classList: { add() {}, remove() {}, toggle() {} }, querySelectorAll: () => [], addEventListener() {}, style: {} }) });
  stub('ProtonI18n', { t: (key) => key });
  stub('window', { close() {} });
  stub('atob', (b64) => Buffer.from(b64, 'base64').toString('binary'));
  stub('Uint8Array', Uint8Array);
  stub('TextDecoder', TextDecoder);

  // Load and eval the module (wrap eval to capture the const assignment)
  const code = readFileSync(join(__dirname, '..', 'popup', 'calendar-utils.js'), 'utf-8');
  const fn = new Function(code + '\nreturn PopupCalendar;');
  PopupCalendar = fn();

  // calendar-ics.js and calendar-serialize.js are pure IIFEs with no browser
  // globals of their own, so the background path runs end to end here.
  const icsCode = readFileSync(join(__dirname, '..', 'background', 'calendar-ics.js'), 'utf-8');
  const serCode = readFileSync(join(__dirname, '..', 'background', 'calendar-serialize.js'), 'utf-8');
  bgParse = new Function(icsCode + '\nreturn ProtonCalendarICS;')().parse;
  const quote = lift(serCode, '_quoteParam');
  bgOrganizerLine = new Function(quote + '\n' + lift(serCode, '_organizerLine') + '\nreturn _organizerLine;')();
  bgAttendeeLine = new Function(quote + '\n' + lift(serCode, '_attendeeLine') + '\nreturn _attendeeLine;')();
  popupDecodeParam = new Function(lift(code, '_decodeParam') + '\nreturn _decodeParam;')();
  bgDecodeParam = new Function(lift(icsCode, '_decodeParam') + '\nreturn _decodeParam;')();
  popupUnescapeText = new Function(lift(code, '_unescapeText') + '\nreturn _unescapeText;')();
});

afterAll(() => {
  for (const [name, { had, prev }] of stubbed) {
    if (had) globalThis[name] = prev;
    else delete globalThis[name];
  }
  stubbed.clear();
});

describe('parseICS', () => {
  it('parses a basic REQUEST invite', () => {
    const ics = [
      'BEGIN:VCALENDAR',
      'METHOD:REQUEST',
      'BEGIN:VEVENT',
      'UID:test-uid-123',
      'SUMMARY:Team Meeting',
      'LOCATION:Room 42',
      'DTSTART:20260415T100000Z',
      'DTEND:20260415T110000Z',
      'ORGANIZER;CN=Alice:mailto:alice@example.com',
      'ATTENDEE;CN=Bob;PARTSTAT=NEEDS-ACTION;X-PM-TOKEN=tok123:mailto:bob@example.com',
      'END:VEVENT',
      'END:VCALENDAR',
    ].join('\r\n');

    const event = PopupCalendar.parseICS(ics);

    expect(event).not.toBeNull();
    expect(event.method).toBe('REQUEST');
    expect(event.uid).toBe('test-uid-123');
    expect(event.summary).toBe('Team Meeting');
    expect(event.location).toBe('Room 42');
    expect(event.organizer.name).toBe('Alice');
    expect(event.organizer.email).toBe('alice@example.com');
    expect(event.attendees).toHaveLength(1);
    expect(event.attendees[0].name).toBe('Bob');
    expect(event.attendees[0].email).toBe('bob@example.com');
    expect(event.attendees[0].partstat).toBe('NEEDS-ACTION');
    expect(event.attendees[0].pmToken).toBe('tok123');
    expect(event.dtstart).toBeInstanceOf(Date);
    expect(event.dtend).toBeInstanceOf(Date);
    expect(event.allDay).toBe(false);
  });

  it('normalises sub-addressed (+tag) emails for owner matching', () => {
    // The RSVP own-status highlight matches the invite attendee against the
    // account's addresses; a plus-alias must resolve to its base address.
    expect(PopupCalendar._baseEmail('mail+shop@example.com')).toBe('mail@example.com');
    expect(PopupCalendar._baseEmail('Mail+SHOP@Example.COM')).toBe('mail@example.com');
    expect(PopupCalendar._baseEmail('mail@example.org')).toBe('mail@example.org');
    expect(PopupCalendar._baseEmail('a+b+c@x.com')).toBe('a@x.com');
    expect(PopupCalendar._baseEmail('')).toBe('');
    expect(PopupCalendar._baseEmail('not-an-email')).toBe('not-an-email');
  });

  it('parses a Microsoft/Outlook invite with parameterised SUMMARY/LOCATION', () => {
    // Real-world Exchange invite: SUMMARY/LOCATION carry a ;LANGUAGE=en-US
    // parameter, DTSTART uses a Windows timezone name, ORGANIZER/ATTENDEE are
    // folded. Regression for invites silently falling back to a plain
    // attachment because SUMMARY was missed and the required-field check failed.
    const ics = [
      'BEGIN:VCALENDAR',
      'METHOD:REQUEST',
      'PRODID:Microsoft Exchange Server 2010',
      'VERSION:2.0',
      'BEGIN:VTIMEZONE',
      'TZID:W. Europe Standard Time',
      'BEGIN:STANDARD',
      'DTSTART:16010101T030000',
      'END:STANDARD',
      'END:VTIMEZONE',
      'BEGIN:VEVENT',
      'ORGANIZER;CN=Alex Example ext:mailto:Alex.Exampleext@example.',
      ' com',
      'ATTENDEE;ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=TRUE;CN=mail+shop',
      ' @example.com:mailto:mail+shop@example.com',
      'UID:040000008200E00074C5B7101A82E008-EXAMPLE',
      'SUMMARY;LANGUAGE=en-US:Example Team - Planning call [Q3 Review]',
      'DTSTART;TZID=W. Europe Standard Time:20260617T100000',
      'DTEND;TZID=W. Europe Standard Time:20260617T104500',
      'LOCATION;LANGUAGE=en-US:Microsoft Teams Meeting',
      'SEQUENCE:0',
      'END:VEVENT',
      'END:VCALENDAR',
    ].join('\r\n');

    const event = PopupCalendar.parseICS(ics);

    expect(event).not.toBeNull();
    expect(event.method).toBe('REQUEST');
    expect(event.summary).toBe('Example Team - Planning call [Q3 Review]');
    expect(event.location).toBe('Microsoft Teams Meeting');
    expect(event.organizer.email).toBe('Alex.Exampleext@example.com');
    expect(event.organizer.name).toBe('Alex Example ext');
    expect(event.attendees).toHaveLength(1);
    expect(event.attendees[0].email).toBe('mail+shop@example.com');
    expect(event.attendees[0].partstat).toBe('NEEDS-ACTION');
    expect(event.timezone).toBe('W. Europe Standard Time');
    expect(event.dtstart).toBeInstanceOf(Date);
  });

  it('parses an all-day event', () => {
    const ics = [
      'BEGIN:VCALENDAR',
      'METHOD:REQUEST',
      'BEGIN:VEVENT',
      'UID:allday-123',
      'SUMMARY:Holiday',
      'DTSTART;VALUE=DATE:20260501',
      'DTEND;VALUE=DATE:20260502',
      'END:VEVENT',
      'END:VCALENDAR',
    ].join('\r\n');

    const event = PopupCalendar.parseICS(ics);
    expect(event).not.toBeNull();
    expect(event.allDay).toBe(true);
    expect(event.dtstart.getFullYear()).toBe(2026);
    expect(event.dtstart.getMonth()).toBe(4); // May = 4
    expect(event.dtstart.getDate()).toBe(1);
  });

  it('handles CANCEL method', () => {
    const ics = [
      'BEGIN:VCALENDAR',
      'METHOD:CANCEL',
      'BEGIN:VEVENT',
      'UID:cancel-123',
      'SUMMARY:Cancelled Meeting',
      'DTSTART:20260415T100000Z',
      'END:VEVENT',
      'END:VCALENDAR',
    ].join('\r\n');

    const event = PopupCalendar.parseICS(ics);
    expect(event).not.toBeNull();
    expect(event.method).toBe('CANCEL');
  });

  it('handles line folding (RFC 5545)', () => {
    const ics = [
      'BEGIN:VCALENDAR',
      'METHOD:REQUEST',
      'BEGIN:VEVENT',
      'UID:fold-123',
      'SUMMARY:Very Long Sum',
      ' mary Title',
      'DTSTART:20260415T100000Z',
      'END:VEVENT',
      'END:VCALENDAR',
    ].join('\n');

    const event = PopupCalendar.parseICS(ics);
    expect(event).not.toBeNull();
    expect(event.summary).toBe('Very Long Summary Title');
  });

  it('returns null for invalid ICS', () => {
    expect(PopupCalendar.parseICS('')).toBeNull();
    expect(PopupCalendar.parseICS('not an ics file')).toBeNull();
    expect(PopupCalendar.parseICS('BEGIN:VCALENDAR\nEND:VCALENDAR')).toBeNull();
  });

  it('parses DTSTART with TZID', () => {
    const ics = [
      'BEGIN:VCALENDAR',
      'METHOD:REQUEST',
      'BEGIN:VEVENT',
      'UID:tz-123',
      'SUMMARY:Berlin Meeting',
      'DTSTART;TZID=Europe/Berlin:20260415T100000',
      'DTEND;TZID=Europe/Berlin:20260415T110000',
      'END:VEVENT',
      'END:VCALENDAR',
    ].join('\r\n');

    const event = PopupCalendar.parseICS(ics);
    expect(event).not.toBeNull();
    expect(event.timezone).toBe('Europe/Berlin');
    expect(event.dtstart).toBeInstanceOf(Date);
  });

  it('parses multiple attendees', () => {
    const ics = [
      'BEGIN:VCALENDAR',
      'METHOD:REQUEST',
      'BEGIN:VEVENT',
      'UID:multi-att-123',
      'SUMMARY:Group Call',
      'DTSTART:20260415T100000Z',
      'ATTENDEE;CN=Alice;PARTSTAT=ACCEPTED:mailto:alice@example.com',
      'ATTENDEE;CN=Bob;PARTSTAT=TENTATIVE:mailto:bob@example.com',
      'ATTENDEE;CN=Charlie;PARTSTAT=DECLINED:mailto:charlie@example.com',
      'END:VEVENT',
      'END:VCALENDAR',
    ].join('\r\n');

    const event = PopupCalendar.parseICS(ics);
    expect(event.attendees).toHaveLength(3);
    expect(event.attendees[0].partstat).toBe('ACCEPTED');
    expect(event.attendees[1].partstat).toBe('TENTATIVE');
    expect(event.attendees[2].partstat).toBe('DECLINED');
  });
});

describe('buildRsvpICS', () => {
  it('builds a valid REPLY ICS', () => {
    const event = {
      uid: 'test-uid-123',
      summary: 'Team Meeting',
      organizer: { name: 'Alice', email: 'alice@example.com' },
      dtstartRaw: 'DTSTART:20260415T100000Z',
      dtendRaw: 'DTEND:20260415T110000Z',
    };

    const ics = PopupCalendar.buildRsvpICS(event, 'bob@example.com', 'ACCEPTED');

    expect(ics).toContain('METHOD:REPLY');
    expect(ics).toContain('UID:test-uid-123');
    expect(ics).toContain('SUMMARY:Team Meeting');
    expect(ics).toContain('ORGANIZER;CN=Alice:mailto:alice@example.com');
    expect(ics).toContain('ATTENDEE;PARTSTAT=ACCEPTED:mailto:bob@example.com');
    expect(ics).toContain('DTSTART:20260415T100000Z');
    expect(ics).toContain('DTEND:20260415T110000Z');
    expect(ics).toContain('BEGIN:VCALENDAR');
    expect(ics).toContain('END:VCALENDAR');
  });

  it('preserves TZID in DTSTART/DTEND', () => {
    const event = {
      uid: 'tz-test',
      summary: 'TZ Meeting',
      organizer: { name: 'Alice', email: 'alice@example.com' },
      dtstartRaw: 'DTSTART;TZID=Europe/Berlin:20260415T100000',
      dtendRaw: 'DTEND;TZID=Europe/Berlin:20260415T110000',
    };

    const ics = PopupCalendar.buildRsvpICS(event, 'bob@example.com', 'TENTATIVE');
    expect(ics).toContain('DTSTART;TZID=Europe/Berlin:20260415T100000');
    expect(ics).toContain('ATTENDEE;PARTSTAT=TENTATIVE:mailto:bob@example.com');
  });

  it('defaults SEQUENCE to 0 and echoes a parsed SEQUENCE', () => {
    const base = {
      uid: 'seq-test',
      summary: 'Seq Meeting',
      organizer: { name: 'Alice', email: 'alice@example.com' },
      dtstartRaw: 'DTSTART:20260415T100000Z',
    };
    expect(PopupCalendar.buildRsvpICS(base, 'bob@example.com', 'ACCEPTED'))
      .toContain('SEQUENCE:0');
    expect(PopupCalendar.buildRsvpICS({ ...base, sequence: '3' }, 'bob@example.com', 'ACCEPTED'))
      .toContain('SEQUENCE:3');
  });

  it('echoes RECURRENCE-ID for replies to a recurring instance', () => {
    const event = {
      uid: 'rec-test',
      summary: 'Weekly Sync',
      organizer: { name: 'Alice', email: 'alice@example.com' },
      dtstartRaw: 'DTSTART;TZID=Europe/Berlin:20260415T100000',
      recurrenceIdRaw: 'RECURRENCE-ID;TZID=Europe/Berlin:20260422T100000',
    };
    const ics = PopupCalendar.buildRsvpICS(event, 'bob@example.com', 'DECLINED');
    expect(ics).toContain('RECURRENCE-ID;TZID=Europe/Berlin:20260422T100000');
  });

  it('refuses to build a reply without DTSTART instead of fabricating one', () => {
    const event = {
      uid: 'no-start',
      summary: 'Broken Invite',
      organizer: { name: 'Alice', email: 'alice@example.com' },
      dtstartRaw: '',
    };
    expect(PopupCalendar.buildRsvpICS(event, 'bob@example.com', 'ACCEPTED')).toBeNull();
  });

  it('omits DTEND when the invite has none (instead of fabricating it)', () => {
    const event = {
      uid: 'no-end',
      summary: 'Open End',
      organizer: { name: 'Alice', email: 'alice@example.com' },
      dtstartRaw: 'DTSTART:20260415T100000Z',
    };
    const ics = PopupCalendar.buildRsvpICS(event, 'bob@example.com', 'ACCEPTED');
    expect(ics).not.toContain('DTEND');
  });

  it('quotes and caret-encodes organizer names with special characters (RFC 6868)', () => {
    const event = {
      uid: 'cn-test',
      summary: 'Names',
      organizer: { name: 'O"Brien, Patrick', email: 'pat@example.com' },
      dtstartRaw: 'DTSTART:20260415T100000Z',
    };
    const ics = PopupCalendar.buildRsvpICS(event, 'bob@example.com', 'ACCEPTED');
    // Comma forces quoting; the double quote survives as ^' instead of being stripped.
    expect(ics).toContain('ORGANIZER;CN="O^\'Brien, Patrick":mailto:pat@example.com');
  });

  it('puts no CN on the reply ATTENDEE line', () => {
    // We answer as an address, not as a display name: the organizer already
    // knows what they called us, and echoing a CN we never verified would put
    // an invite-chosen name into the reply under our own address.
    const event = {
      uid: 'att-cn',
      summary: 'Names',
      organizer: { name: 'Alice', email: 'alice@example.com' },
      dtstartRaw: 'DTSTART:20260415T100000Z',
    };
    const ics = PopupCalendar.buildRsvpICS(event, 'bob@example.com', 'ACCEPTED');
    const attLine = ics.split('\r\n').find(l => l.startsWith('ATTENDEE'));
    expect(attLine).toBe('ATTENDEE;PARTSTAT=ACCEPTED:mailto:bob@example.com');
    expect(attLine).not.toContain('CN=');
  });
});

describe('parseICS SEQUENCE/RECURRENCE-ID extraction', () => {
  it('extracts SEQUENCE and RECURRENCE-ID from a recurring-instance invite', () => {
    const ics = [
      'BEGIN:VCALENDAR',
      'METHOD:REQUEST',
      'BEGIN:VEVENT',
      'UID:rec-uid',
      'SUMMARY:Weekly Sync',
      'SEQUENCE:2',
      'DTSTART;TZID=Europe/Berlin:20260422T100000',
      'DTEND;TZID=Europe/Berlin:20260422T110000',
      'RECURRENCE-ID;TZID=Europe/Berlin:20260422T100000',
      'ORGANIZER;CN=Alice:mailto:alice@example.com',
      'END:VEVENT',
      'END:VCALENDAR',
    ].join('\r\n');

    const event = PopupCalendar.parseICS(ics);
    expect(event.sequence).toBe('2');
    expect(event.recurrenceIdRaw).toBe('RECURRENCE-ID;TZID=Europe/Berlin:20260422T100000');
  });

  it('leaves sequence/recurrenceIdRaw empty when absent', () => {
    const ics = [
      'BEGIN:VCALENDAR',
      'METHOD:REQUEST',
      'BEGIN:VEVENT',
      'UID:plain-uid',
      'SUMMARY:One-off',
      'DTSTART:20260415T100000Z',
      'END:VEVENT',
      'END:VCALENDAR',
    ].join('\r\n');

    const event = PopupCalendar.parseICS(ics);
    expect(event.sequence).toBe('');
    expect(event.recurrenceIdRaw).toBe('');
  });
});

// ---------------------------------------------------------------------------
// ICS PARAMETER handling, popup and background together.
//
// The popup used to read CN and the RSVP address with regexes run over the
// WHOLE raw property line: /CN=([^;:]+)/i and /mailto:([^\s;>]+)/i. Both take
// the FIRST hit in the line, so any EARLIER parameter could supply either one.
// The background parser already tokenised properly, so the same click produced
// an invite card and a calendar entry that disagreed about the same invite.
//
// House rule for this block, as in tests/review-fixes-misc.test.js: no
// backslash and no newline is typed as a source escape in test data. A test
// for an escaping bug written with source-level escapes is how the bug got in.
// ---------------------------------------------------------------------------

const B = String.fromCharCode(92);  // one backslash
const NL = String.fromCharCode(10); // one newline

/** A minimal REQUEST invite carrying the given extra property lines. */
function invite(...props) {
  return [
    'BEGIN:VCALENDAR',
    'METHOD:REQUEST',
    'BEGIN:VEVENT',
    'UID:param-uid-1',
    'SUMMARY:Lunch',
    'DTSTART:20260415T100000Z',
    'DTEND:20260415T110000Z',
    ...props,
    'END:VEVENT',
    'END:VCALENDAR',
  ].join('\r\n');
}

describe('parseICS parameter tokenising (RFC 5545 quoted values)', () => {
  it('keeps a quoted CN that contains the parameter delimiters', () => {
    // A quoted parameter value may contain ';' and ':'. The old regex stopped
    // at the first one and showed half a name.
    expect(PopupCalendar.parseICS(invite(
      'ORGANIZER;CN="Doe; John":mailto:dj@corp.example',
    )).organizer.name).toBe('Doe; John');

    expect(PopupCalendar.parseICS(invite(
      'ORGANIZER;CN="Re: lunch":mailto:rl@corp.example',
    )).organizer.name).toBe('Re: lunch');
  });

  it('takes CN from the CN parameter, not from an earlier one containing "CN="', () => {
    // DIR is a legitimate RFC 5545 parameter and an LDAP URI legitimately
    // contains "CN=". The old scan read the directory entry as the name.
    expect(PopupCalendar.parseICS(invite(
      'ORGANIZER;DIR="ldap:///CN=Doe John,OU=Users";CN=John Doe:mailto:jd@corp.example',
    )).organizer.name).toBe('John Doe');

    // Same shape, but chosen by the sender: a spoofed name planted in an
    // unrelated parameter used to win over the real CN.
    expect(PopupCalendar.parseICS(invite(
      'ORGANIZER;X-LABEL="CN=spoofed";CN=Real Name:mailto:real@corp.example',
    )).organizer.name).toBe('Real Name');
  });

  it('agrees with the background parser on all four, so card and calendar match', () => {
    const cases = [
      ['ORGANIZER;CN="Doe; John":mailto:dj@corp.example', 'Doe; John'],
      ['ORGANIZER;CN="Re: lunch":mailto:rl@corp.example', 'Re: lunch'],
      ['ORGANIZER;DIR="ldap:///CN=Doe John,OU=Users";CN=John Doe:mailto:jd@corp.example', 'John Doe'],
      ['ORGANIZER;X-LABEL="CN=spoofed";CN=Real Name:mailto:real@corp.example', 'Real Name'],
    ];
    for (const [line, expected] of cases) {
      expect(PopupCalendar.parseICS(invite(line)).organizer.name).toBe(expected);
      expect(bgParse(invite(line)).organizer.cn).toBe(expected);
    }
  });
});

describe('parseICS RSVP recipient: an invite must not choose where our reply is sent', () => {
  // organizer.email is handed to background/accounts.js sendCalendarRsvp as
  // the recipient. It now comes from the property VALUE (everything after the
  // first unquoted colon) and never from a scan of the line, so no parameter
  // can steer it.

  it('ignores a mailto: inside an earlier parameter when picking the organizer', () => {
    // SENT-BY is a real RFC 5545 parameter holding a real mailto: URI, so this
    // shape is not even an attack: the old regex simply answered the
    // assistant, and with the rest of the line glued on the address was
    // undeliverable anyway.
    const sentBy = PopupCalendar.parseICS(invite(
      'ORGANIZER;CN=Boss;SENT-BY="mailto:pa@corp.example":mailto:boss@corp.example',
    ));
    expect(sentBy.organizer.email).toBe('boss@corp.example');
    expect(sentBy.organizer.name).toBe('Boss');

    // The deliberate version. The card still reads "Boss", so the redirect is
    // invisible to the user: only the reply goes somewhere else.
    const planted = PopupCalendar.parseICS(invite(
      'ORGANIZER;CN=Boss;X-NOTE="reply mailto:evil@attacker.test please":mailto:boss@corp.example',
    ));
    expect(planted.organizer.email).toBe('boss@corp.example');
    expect(planted.organizer.name).toBe('Boss');
    expect(planted.organizer.email).not.toContain('attacker.test');
  });

  it('does the same for an ATTENDEE address', () => {
    // The attendee list is how we resolve which row is US, and the resolved
    // attendee's email is echoed as the ATTENDEE of the reply.
    const sentBy = PopupCalendar.parseICS(invite(
      'ATTENDEE;CN=Boss;SENT-BY="mailto:pa@corp.example":mailto:boss@corp.example',
    ));
    expect(sentBy.attendees[0].email).toBe('boss@corp.example');

    const planted = PopupCalendar.parseICS(invite(
      'ATTENDEE;CN=Boss;X-NOTE="reply mailto:evil@attacker.test please":mailto:boss@corp.example',
    ));
    expect(planted.attendees[0].email).toBe('boss@corp.example');
    expect(planted.attendees[0].email).not.toContain('attacker.test');
  });

  it('still reads a plain unparameterised organizer and attendee', () => {
    const event = PopupCalendar.parseICS(invite(
      'ORGANIZER:mailto:plain@corp.example',
      'ATTENDEE;PARTSTAT=ACCEPTED;X-PM-TOKEN=tok9:mailto:guest@corp.example',
    ));
    expect(event.organizer.email).toBe('plain@corp.example');
    expect(event.attendees[0].email).toBe('guest@corp.example');
    expect(event.attendees[0].partstat).toBe('ACCEPTED');
    expect(event.attendees[0].pmToken).toBe('tok9');
  });
});

describe('RFC 6868 caret escapes are DECODED, in both parsers', () => {
  /** One case against both copies, so neither can drift away from the other. */
  function both(input, expected) {
    expect(popupDecodeParam(input)).toBe(expected);
    expect(bgDecodeParam(input)).toBe(expected);
  }

  it('decodes the three defined escapes', () => {
    both("O^'Brien", 'O"Brien');
    both('Line^nBreak', 'Line' + NL + 'Break');
    both('100^^', '100^');
  });

  it('leaves an unknown escape and a trailing caret in place (RFC 6868 section 3)', () => {
    // "parsers MUST leave both the ^ and the following character in place".
    both('Weird^x', 'Weird^x');
    both('Trail^', 'Trail^');
  });

  it('decodes once, left to right, so an escaped caret is never re-read', () => {
    // A^^nB is an escaped caret followed by a literal "n". Decoding twice, or
    // chaining ^^ and ^n as separate replaces, turns it into a newline the
    // sender never wrote.
    both('A^^nB', 'A^nB');
    expect(popupDecodeParam('A^^nB')).not.toContain(NL);
    expect(bgDecodeParam('A^^nB')).not.toContain(NL);
    both('Caret^^n', 'Caret^n');
  });

  it('strips the surrounding quotes before decoding, not after', () => {
    // Decoding can PRODUCE a leading quote, so unquoting afterwards would eat
    // the sender's own quote characters.
    both('"quoted"', 'quoted');
    both("^'quoted^'", '"quoted"');
  });
});

describe('parameter round trip: the CN token comes back byte for byte', () => {
  // This is the test that would have caught the doubling. With no decode at
  // parse, the re-encode on the way out adds a caret pair on every hop:
  // O^'Brien leaves as O^^'Brien in our reply and O^^^^'Brien on the next one,
  // and the doubled form is what lands in the user's real calendar.
  const TOKENS = ["O^'Brien", 'Line^nBreak', '100^^', '"Doe; John"'];

  it('popup: parseICS then buildRsvpICS reproduces the incoming ORGANIZER CN', () => {
    for (const token of TOKENS) {
      const event = PopupCalendar.parseICS(invite('ORGANIZER;CN=' + token + ':mailto:x@corp.example'));
      const reply = PopupCalendar.buildRsvpICS(event, 'me@corp.example', 'ACCEPTED');
      const line = reply.split('\r\n').find(l => l.startsWith('ORGANIZER'));
      expect(line).toBe('ORGANIZER;CN=' + token + ':mailto:x@corp.example');
    }
  });

  it('background: parse then the serializer lines reproduce the incoming CN', () => {
    for (const token of TOKENS) {
      const event = bgParse(invite(
        'ORGANIZER;CN=' + token + ':mailto:x@corp.example',
        'ATTENDEE;CN=' + token + ':mailto:a@corp.example',
      ));
      expect(bgOrganizerLine({ cn: event.organizer.cn, email: event.organizer.email }))
        .toBe('ORGANIZER;CN=' + token + ':mailto:x@corp.example');
      expect(bgAttendeeLine({ cn: event.attendees[0].cn, email: event.attendees[0].email }))
        .toBe('ATTENDEE;CN=' + token + ':mailto:a@corp.example');
    }
  });
});

describe('an unbalanced parameter quote must not cost the whole event', () => {
  // A quote-aware scan fails CLOSED: there is no unquoted colon in
  // 'SUMMARY;X-FOO="unbalanced:Lunch', so without a plain-indexOf fallback the
  // property is dropped, SUMMARY goes missing, and the invite card vanishes
  // (popup) or "add to calendar" fails (background) over one stray quote. The
  // background parser was already losing this one before the fix.
  const ics = [
    'BEGIN:VCALENDAR',
    'METHOD:REQUEST',
    'BEGIN:VEVENT',
    'UID:unbalanced-uid-1',
    'SUMMARY;X-FOO="unbalanced:Lunch',
    'DTSTART:20260415T100000Z',
    'END:VEVENT',
    'END:VCALENDAR',
  ].join('\r\n');

  it('still yields an event with a summary in the popup parser', () => {
    const event = PopupCalendar.parseICS(ics);
    expect(event).not.toBeNull();
    expect(event.summary).toBe('Lunch');
  });

  it('still yields an event with a summary in the background parser', () => {
    const event = bgParse(ics);
    expect(event).not.toBeNull();
    expect(event.summary).toBe('Lunch');
  });

  it('both parsers accept whitespace before the colon', () => {
    // "SUMMARY :Lunch" is malformed, but producers emit it. The popup
    // trimmed the property name and the background parser did not, so the
    // card rendered while "add to calendar" failed on the same invite.
    const spaced = [
      'BEGIN:VCALENDAR',
      'METHOD:REQUEST',
      'BEGIN:VEVENT',
      'UID:spaced-uid-1',
      'SUMMARY :Lunch',
      'DTSTART:20260415T100000Z',
      'END:VEVENT',
      'END:VCALENDAR',
    ].join('\r\n');
    expect(PopupCalendar.parseICS(spaced).summary).toBe('Lunch');
    expect(bgParse(spaced).summary).toBe('Lunch');
  });
});

describe('an unmatched quote inside a parameter must not swallow the rest', () => {
  // RFC 5545 forbids a DQUOTE inside a parameter value, so a lone one means the
  // line is malformed. Honouring it anyway left the scan "inside a quote" to
  // the end of the line, so every parameter AFTER the stray quote vanished.
  // Measured on 1.14.6: ORGANIZER;X-NOQUOTE=a"b;CN=Real Name lost CN entirely,
  // and the popup fell back to showing the bare email address instead of the
  // organiser's name. The fix treats a quote as opening a section only when a
  // matching one exists later.
  const DQ = String.fromCharCode(34);

  it('keeps a parameter that follows the stray quote, in both parsers', () => {
    const ics = invite('ORGANIZER;X-NOQUOTE=a' + DQ + 'b;CN=Real Name:mailto:o@x.example');
    expect(PopupCalendar.parseICS(ics).organizer.name).toBe('Real Name');
    expect(bgParse(ics).organizer.cn).toBe('Real Name');
  });

  it('keeps the stray quote as data rather than dropping it', () => {
    const ics = invite('ORGANIZER;X-NOQUOTE=a' + DQ + 'b;CN=Real Name:mailto:o@x.example');
    expect(bgParse(ics).organizer.raw.params['X-NOQUOTE']).toBe('a' + DQ + 'b');
  });

  it('still honours a properly quoted value that comes before one', () => {
    // The stray quote must not retroactively break the well formed parameter.
    const ics = invite('ORGANIZER;CN=' + DQ + 'Doe; John' + DQ + ';X-F=a' + DQ + 'b:mailto:o@x.example');
    expect(PopupCalendar.parseICS(ics).organizer.name).toBe('Doe; John');
    expect(bgParse(ics).organizer.cn).toBe('Doe; John');
  });

  it('does not regress a correctly quoted CN with no stray quote anywhere', () => {
    const ics = invite('ORGANIZER;CN=' + DQ + 'Doe; John' + DQ + ':mailto:o@x.example');
    expect(PopupCalendar.parseICS(ics).organizer.name).toBe('Doe; John');
    expect(bgParse(ics).organizer.cn).toBe('Doe; John');
  });

  it('still finds the real address, which is the security critical part', () => {
    const ics = invite('ORGANIZER;X-NOQUOTE=a' + DQ + 'b;CN=Real Name:mailto:o@x.example');
    expect(PopupCalendar.parseICS(ics).organizer.email).toBe('o@x.example');
    expect(bgParse(ics).organizer.email).toBe('o@x.example');
  });
});

describe('the TEXT unescape on CN is deliberate, not an oversight', () => {
  it('renders an escaped comma in a CN while the stored value keeps its backslash', () => {
    // By RFC 5545 the TEXT escapes do not apply to a parameter value. We
    // decode them anyway at RENDER time, because ical.js 1.5.0 (the library
    // Proton Calendar itself uses) does the same to parameters: dropping it
    // would make our card disagree with Proton's own rendering of the very
    // same invite. The stored value stays escaped because buildRsvpICS
    // re-emits it and it must be valid on the wire.
    const event = PopupCalendar.parseICS(invite(
      'ORGANIZER;CN=Doe' + B + ', John:mailto:dj@corp.example',
    ));
    expect(event.organizer.name).toBe('Doe' + B + ', John');
    expect(popupUnescapeText(event.organizer.name)).toBe('Doe, John');
  });
});
