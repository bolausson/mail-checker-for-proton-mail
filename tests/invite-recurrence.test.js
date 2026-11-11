/**
 * @vitest-environment jsdom
 *
 * The invitation card says when an event repeats: "Weekly: Tuesday,
 * 3 times", "Monthly: second Tuesday", or that the invitation is for one
 * occurrence of a series (the answer is then for that one only). The card
 * showed the first date only, so a weekly series looked like one meeting.
 * Run through the real popup module and the real translations; weekday and
 * month names come from Intl in the UI language.
 */

import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const ROOT = join(__dirname, '..');
const read = (...p) => readFileSync(join(ROOT, ...p), 'utf-8');
const CALENDAR = read('popup', 'calendar-utils.js');
const ProtonSenderAlias = new Function(read('lib', 'sender-alias.js') + '\nreturn ProtonSenderAlias;')();

let I18n;
let mod;
let TZ;
beforeAll(() => {
  I18n = new Function(read('lib', 'i18n.js') + '\nreturn ProtonI18n;')();
  TZ = new Function(read('background', 'calendar-tz-data.js') + read('background', 'calendar-tz.js') + '\nreturn ProtonCalendarTZ;')();
  mod = new Function('browser', 'ProtonI18n', 'window', 'ProtonSenderAlias', CALENDAR + '\nreturn PopupCalendar;')(
    { runtime: { sendMessage: async () => null }, tabs: { create() {} } }, I18n, globalThis.window, ProtonSenderAlias);
});
afterEach(() => { I18n.setLanguage('en'); });

/** A REQUEST for one event, with `lines` added to its VEVENT. 15 Dec 2026 is a Tuesday. */
function ics(lines = [], { start = 'DTSTART;TZID=Europe/Berlin:20261215T140000', extra = [] } = {}) {
  return ['BEGIN:VCALENDAR', 'METHOD:REQUEST', ...extra, 'BEGIN:VEVENT', 'UID:recur-1@example.org', 'SUMMARY:Sync',
    start, 'DTEND;TZID=Europe/Berlin:20261215T144500', 'ORGANIZER:mailto:organizer@example.org',
    'ATTENDEE;PARTSTAT=NEEDS-ACTION:mailto:me@example.com', ...lines, 'END:VEVENT', 'END:VCALENDAR'].join('\r\n');
}
const describeRule = (rule, opts) => mod.describeRecurrence(mod.parseICS(ics(rule ? ['RRULE:' + rule] : [], opts)));

describe('what the card says about a series', () => {
  it.each([
    ['FREQ=DAILY', 'Daily'],
    ['FREQ=DAILY;INTERVAL=3', 'Every 3 days'],
    ['FREQ=DAILY;COUNT=1', 'Daily, 1 time'],
    ['FREQ=WEEKLY;COUNT=3', 'Weekly: Tuesday, 3 times'],
    ['FREQ=WEEKLY;BYDAY=TH,TU', 'Weekly: Tuesday and Thursday'],
    ['FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE,FR', 'Every 2 weeks: Mon, Wed, and Fri'],
    ['FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR', 'Every weekday (Monday to Friday)'],
    ['FREQ=DAILY;BYDAY=MO,TU,WE,TH,FR;COUNT=10', 'Every weekday (Monday to Friday), 10 times'],
    ['FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,TU,WE,TH,FR', 'Every 2 weeks: Mon, Tue, Wed, Thu, and Fri'],
    ['FREQ=MONTHLY', 'Monthly: day 15'],
    ['FREQ=MONTHLY;BYMONTHDAY=8', 'Monthly: day 8'],
    ['FREQ=MONTHLY;BYMONTHDAY=-1', 'Monthly: last day of the month'],
    ['FREQ=MONTHLY;BYDAY=2TU', 'Monthly: second Tuesday'],
    ['FREQ=MONTHLY;BYDAY=+3TU', 'Monthly: third Tuesday'],
    ['FREQ=MONTHLY;BYDAY=-1FR', 'Monthly: last Friday'],
    ['FREQ=MONTHLY;BYDAY=TU;BYSETPOS=2', 'Monthly: second Tuesday'],
    ['FREQ=MONTHLY;INTERVAL=3;BYDAY=1MO;COUNT=4', 'Every 3 months: first Monday, 4 times'],
    ['FREQ=YEARLY', 'Yearly: December 15'],
    ['FREQ=YEARLY;BYMONTH=2;BYMONTHDAY=29', 'Yearly: February 29'],
    ['FREQ=YEARLY;INTERVAL=2', 'Every 2 years: December 15'],
  ])('%s -> %s', (rule, want) => {
    expect(describeRule(rule)).toBe(want);
  });

  it.each([
    // Beyond what the card puts into words: said to be custom, never guessed.
    ['FREQ=MONTHLY;BYDAY=5TU', 'Monthly: custom rule'],
    ['FREQ=MONTHLY;BYDAY=TU', 'Monthly: custom rule'],
    ['FREQ=MONTHLY;BYDAY=TU,TH;BYSETPOS=1', 'Monthly: custom rule'],
    ['FREQ=MONTHLY;BYDAY=2TU;BYSETPOS=1', 'Monthly: custom rule'],
    ['FREQ=MONTHLY;BYMONTHDAY=1,15', 'Monthly: custom rule'],
    ['FREQ=MONTHLY;BYMONTHDAY=-2', 'Monthly: custom rule'],
    ['FREQ=MONTHLY;BYMONTH=1;BYMONTHDAY=1', 'Monthly: custom rule'],
    ['FREQ=YEARLY;BYMONTH=11;BYDAY=4TH', 'Yearly: custom rule'],
    ['FREQ=YEARLY;BYMONTH=2;BYMONTHDAY=30', 'Yearly: custom rule'],
    ['FREQ=YEARLY;BYMONTH=1,7', 'Yearly: custom rule'],
    // A day of the month without a month: every month (RFC 5545), not once a year.
    ['FREQ=YEARLY;BYMONTHDAY=15', 'Yearly: custom rule'],
    ['FREQ=WEEKLY;BYDAY=2TU', 'Weekly: custom rule'],
    ['FREQ=WEEKLY;BYDAY=XX', 'Weekly: custom rule'],
    ['FREQ=DAILY;BYHOUR=9,17', 'Daily: custom rule'],
    ['FREQ=WEEKLY;BYWEEKNO=20', 'Weekly: custom rule'],
  ])('%s -> %s', (rule, want) => {
    expect(describeRule(rule)).toBe(want);
  });

  it('ends a series by its count or its last day', () => {
    expect(describeRule('FREQ=WEEKLY;UNTIL=20261229')).toBe('Weekly: Tuesday, until Dec 29, 2026');
    // A UTC time as the instant: midday, the same day in every zone the card can be in.
    expect(describeRule('FREQ=DAILY;UNTIL=20261229T120000Z')).toBe('Daily, until Dec 29, 2026');
    // COUNT wins when a broken rule has both.
    expect(describeRule('FREQ=DAILY;COUNT=2;UNTIL=20261229')).toBe('Daily, 2 times');
    expect(describeRule('FREQ=DAILY;UNTIL=garbage')).toBe('Daily');
    expect(describeRule('FREQ=DAILY;COUNT=0')).toBe('Daily');
  });

  it('calls finer or unknown frequencies a recurring event', () => {
    expect(describeRule('FREQ=HOURLY;INTERVAL=4')).toBe('Recurring event');
    expect(describeRule('INTERVAL=2')).toBe('Recurring event');
    expect(describeRule('garbage')).toBe('Recurring event');
  });

  it('reads the rule in any case and spacing', () => {
    expect(describeRule('freq=weekly;byday=tu ; count=2')).toBe('Weekly: Tuesday, 2 times');
  });

  it('says nothing for an event that does not repeat', () => {
    expect(describeRule('')).toBe('');
    // Google's time zone block carries its own RRULEs (daylight saving): they
    // are not the event's.
    const google = ics([], { extra: ['BEGIN:VTIMEZONE', 'TZID:Europe/Berlin', 'BEGIN:DAYLIGHT',
      'DTSTART:19700329T020000', 'RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU', 'END:DAYLIGHT', 'END:VTIMEZONE'] });
    expect(mod.describeRecurrence(mod.parseICS(google))).toBe('');
  });

  it('takes the event\'s own rule, not one inside a component it holds', () => {
    const withAlarm = ics(['BEGIN:VALARM', 'ACTION:DISPLAY', 'TRIGGER:-PT10M', 'RRULE:FREQ=DAILY', 'END:VALARM']);
    expect(mod.describeRecurrence(mod.parseICS(withAlarm))).toBe('');
    // The first RRULE counts, as Proton keeps one.
    expect(mod.describeRecurrence(mod.parseICS(ics(['RRULE:FREQ=WEEKLY', 'RRULE:FREQ=DAILY'])))).toBe('Weekly: Tuesday');
  });

  it('says that an invitation is for one occurrence', () => {
    const one = ics(['RECURRENCE-ID;TZID=Europe/Berlin:20261222T140000']);
    expect(mod.describeRecurrence(mod.parseICS(one))).toBe('One occurrence of a recurring event');
    // Extra dates only: a series all the same.
    expect(mod.describeRecurrence(mod.parseICS(ics(['RDATE:20261222T130000Z'])))).toBe('Recurring event');
  });

  it('places a weekday series on the day the organizer wrote, whatever the reader\'s zone', () => {
    // A zoned DTSTART is read as written (wall clock), as the date row shows it.
    expect(describeRule('FREQ=WEEKLY', { start: 'DTSTART;TZID=Pacific/Kiritimati:20261215T235900' })).toBe('Weekly: Tuesday');
  });
});

describe('the card\'s line', () => {
  function mount(text) {
    const host = document.createElement('div');
    mod.renderCalendarInvite(mod.parseICS(text), 'acc1', text, {
      containerEl: host, getSelectedMsg: () => ({ ID: 'm1', _accountId: 'acc1', _accountEmail: 'me@example.com' }),
      showToast: () => {},
    });
    return host;
  }

  it('shows how the series repeats, under the date', () => {
    const host = mount(ics(['RRULE:FREQ=WEEKLY;COUNT=3']));
    const rows = [...host.querySelectorAll('.calendar-invite-detail')];
    const at = rows.findIndex((r) => r.classList.contains('calendar-invite-recurrence'));
    expect(at).toBe(1);
    expect(rows[at].textContent).toBe('\u{1F501}Weekly: Tuesday, 3 times');
  });

  it('has no such line for an event that does not repeat', () => {
    expect(mount(ics()).querySelector('.calendar-invite-recurrence')).toBeNull();
  });

  it('shows it on a cancellation too', () => {
    const host = mount(ics(['RRULE:FREQ=DAILY']).replace('METHOD:REQUEST', 'METHOD:CANCEL'));
    expect(host.querySelector('.calendar-invite-recurrence').textContent).toBe('\u{1F501}Daily');
  });
});

describe('in the other languages', () => {
  it('uses the UI language for the words and the weekday names', () => {
    I18n.setLanguage('de');
    const text = describeRule('FREQ=WEEKLY;COUNT=3');
    expect(text).toContain('Dienstag');
    expect(text).toContain(I18n.t('recurWeekly'));
    expect(text).not.toMatch(/Weekly|Tuesday|times/);
  });

  it('writes Serbian weekday names in Latin script, as the rest of the Serbian text', () => {
    I18n.setLanguage('sr');
    expect(describeRule('FREQ=WEEKLY;BYDAY=TU')).not.toMatch(/[Ѐ-ӿ]/);
    expect(describeRule('FREQ=WEEKLY;BYDAY=TU').toLowerCase()).toContain('utorak');
  });

  it('keeps every phrase\'s placeholders and gives each weekday phrase its own words', () => {
    // That every language HAS each key is tests/i18n-parity.test.js's job.
    const langs = ['bg', 'ca', 'cs', 'da', 'de', 'el', 'es', 'et', 'fi', 'fr', 'hr', 'hu', 'it', 'lt', 'lv', 'nb',
      'nl', 'pl', 'pt', 'ro', 'ru', 'sk', 'sl', 'sr', 'sv', 'tr', 'uk'];
    const nthKeys = ['1', '2', '3', '4', 'Last'].flatMap((n) => ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'].map((d) => 'recurNth' + n + d));
    const keys = ['recurDaily', 'recurWeekly', 'recurMonthly', 'recurYearly', 'recurWeekdays', 'recurUntil', 'recurDetail',
      'recurEnd', 'recurMonthDay', 'recurLastMonthDay', 'recurCustom', 'recurRepeats', 'recurOccurrence', ...nthKeys];
    I18n.setLanguage('en');
    const placeholders = Object.fromEntries(keys.map((k) => [k, I18n.t(k).match(/\$\d/g) || []]));
    for (const lang of langs) {
      I18n.setLanguage(lang);
      for (const k of keys) {
        const v = I18n.t(k);
        expect(v.trim(), lang + ' ' + k).not.toBe('');
        expect((v.match(/\$\d/g) || []).sort(), lang + ' ' + k).toEqual([...placeholders[k]].sort());
      }
      expect(new Set(nthKeys.map((k) => I18n.t(k))).size, lang).toBe(35);
      for (const base of ['recurEveryDays', 'recurEveryWeeks', 'recurEveryMonths', 'recurEveryYears', 'recurTimes']) {
        for (const n of [1, 2, 3, 5, 11, 21, 22, 25, 100, 101]) {
          expect(I18n.plural(base, n), lang + ' ' + base + ' ' + n).toContain(String(n));
        }
      }
    }
  });
});

describe('the last day of a series, read as Proton reads it (review)', () => {
  // The card's date row shows a zoned start as the organizer's wall clock;
  // the "until" date must come from the same frame, never the reader's zone.
  function inZone(tz, fn) {
    const before = process.env.TZ;
    process.env.TZ = tz;
    try { return fn(); } finally { if (before === undefined) delete process.env.TZ; else process.env.TZ = before; }
  }
  const line = (start, rule) => mod.describeRecurrence(mod.parseICS(ics(['RRULE:' + rule], { start })));

  it('reads a UTC end in the organizer\'s zone, wherever the reader is', () => {
    // Google and Proton write the end of the last day in the organizer's zone.
    for (const tz of ['Asia/Tokyo', 'Europe/Berlin', 'America/Los_Angeles']) {
      expect(inZone(tz, () => line('DTSTART;TZID=Europe/London:20261215T090000', 'FREQ=DAILY;UNTIL=20261229T235959Z')), tz)
        .toBe('Daily, until Dec 29, 2026');
      expect(inZone(tz, () => line('DTSTART;TZID=America/New_York:20261215T090000', 'FREQ=WEEKLY;BYDAY=TU,WE;UNTIL=20261230T045959Z')), tz)
        .toBe('Weekly: Tuesday and Wednesday, until Dec 29, 2026');
    }
  });

  it('maps Outlook\'s zone names, and leaves out an end it cannot place', () => {
    // Outlook writes the start of the last occurrence, in its own zone names.
    const outlook = () => line('DTSTART;TZID=W. Europe Standard Time:20261215T080000', 'FREQ=WEEKLY;UNTIL=20261229T070000Z');
    globalThis.ProtonCalendarTZ = TZ;
    try {
      expect(inZone('America/Los_Angeles', outlook)).toBe('Weekly: Tuesday, until Dec 29, 2026');
      expect(inZone('Asia/Tokyo', outlook)).toBe('Weekly: Tuesday, until Dec 29, 2026');
    } finally {
      delete globalThis.ProtonCalendarTZ;
    }
    // Without the zone table, or for a zone nobody can name: no end date rather than perhaps a wrong one.
    expect(inZone('America/Los_Angeles', outlook)).toBe('Weekly: Tuesday');
    expect(line('DTSTART;TZID=Customized Time Zone:20261215T080000', 'FREQ=WEEKLY;UNTIL=20261229T070000Z')).toBe('Weekly: Tuesday');
  });

  it('reads a UTC series\' end in UTC, and an all-day or floating end as written', () => {
    for (const tz of ['Asia/Tokyo', 'Europe/Berlin', 'America/New_York']) {
      expect(inZone(tz, () => line('DTSTART:20261215T090000Z', 'FREQ=DAILY;UNTIL=20261229T235959Z')), tz).toBe('Daily, until Dec 29, 2026');
      expect(inZone(tz, () => line('DTSTART;VALUE=DATE:20261215', 'FREQ=DAILY;UNTIL=20261229T000000Z')), tz).toBe('Daily, until Dec 29, 2026');
      expect(inZone(tz, () => line('DTSTART:20261215T090000', 'FREQ=DAILY;UNTIL=20261229T235959')), tz).toBe('Daily, until Dec 29, 2026');
    }
    // An all-day start that names a zone too: its end date is still the one written.
    for (const tz of ['Asia/Tokyo', 'America/New_York']) {
      expect(inZone(tz, () => line('DTSTART;TZID=America/New_York;VALUE=DATE:20261215', 'FREQ=DAILY;UNTIL=20261229T000000Z')), tz)
        .toBe('Daily, until Dec 29, 2026');
    }
    // A day that does not exist: no end date.
    expect(line('DTSTART:20261215T090000Z', 'FREQ=DAILY;UNTIL=20260231')).toBe('Daily');
  });
});

describe('a file with several VEVENTs (review)', () => {
  // The first VEVENT is the event, as the background parser and Proton's Mail
  // app read the file: the card used to mix the last one's title and date
  // with the first one's rule, and a series sent with its edited occurrence
  // was answered for that occurrence only.
  const two = (method, a, b) => ['BEGIN:VCALENDAR', 'METHOD:' + method,
    'BEGIN:VEVENT', ...a, 'END:VEVENT', 'BEGIN:VEVENT', ...b, 'END:VEVENT', 'END:VCALENDAR'].join('\r\n');
  const org = 'ORGANIZER:mailto:organizer@example.org';
  const att = 'ATTENDEE;PARTSTAT=NEEDS-ACTION:mailto:me@example.com';

  it('shows the first of two events, with its own rule', () => {
    const ev = mod.parseICS(two('PUBLISH',
      ['UID:standup@example.org', 'SUMMARY:Standup', 'DTSTART;TZID=Europe/Berlin:20261215T090000', 'RRULE:FREQ=WEEKLY;BYDAY=TU', org],
      ['UID:launch@example.org', 'SUMMARY:Launch party', 'DTSTART;TZID=Europe/Berlin:20261218T190000', org]));
    expect([ev.uid, ev.summary]).toEqual(['standup@example.org', 'Standup']);
    expect(ev.dtstart.getDate()).toBe(15);
    expect(mod.describeRecurrence(ev)).toBe('Weekly: Tuesday');
  });

  it('answers a series sent with its edited occurrence for the series', () => {
    const ev = mod.parseICS(two('REQUEST',
      ['UID:s@example.org', 'SUMMARY:S', 'DTSTART;TZID=Europe/Berlin:20261215T140000', 'RRULE:FREQ=WEEKLY;COUNT=3', org, att],
      ['UID:s@example.org', 'SUMMARY:S moved', 'DTSTART;TZID=Europe/Berlin:20261222T160000',
        'RECURRENCE-ID;TZID=Europe/Berlin:20261222T140000', org, att]));
    expect(ev.recurrenceIdRaw).toBe('');
    expect(ev.summary).toBe('S');
    expect(mod.describeRecurrence(ev)).toBe('Weekly: Tuesday, 3 times');
    const reply = mod.buildRsvpICS(ev, 'me@example.com', 'ACCEPTED');
    expect(reply).toContain('DTSTART;TZID=Europe/Berlin:20261215T140000');
    expect(reply).not.toContain('RECURRENCE-ID');
  });

  it('keeps reading the calendar\'s METHOD wherever it stands', () => {
    const ics2 = two('REQUEST', ['UID:a@example.org', 'DTSTART:20261215T090000Z', org], ['UID:b@example.org', 'DTSTART:20261216T090000Z', org])
      .replace('METHOD:REQUEST\r\n', '').replace('END:VCALENDAR', 'METHOD:REQUEST\r\nEND:VCALENDAR');
    expect(mod.parseICS(ics2)).toMatchObject({ method: 'REQUEST', uid: 'a@example.org' });
  });
});
