/**
 * @vitest-environment jsdom
 *
 * The invitation card for an invitation that is not in the calendar, run
 * through the real popup module (popup/calendar-utils.js) and the real
 * translations. Proton's Mail app keeps Yes/Maybe/No usable then and adds
 * the event when the user answers; the card disabled them from v1.3.26 to
 * 2.0.4 and said the event was "no longer" in the calendar, which was wrong
 * for every invitation that had simply never been added. Whether an answer
 * CAN add it is the background's call (CHECK_INVITE_SAVABLE, the same checks
 * it runs before saving); what an answer saves is in
 * invite-not-in-calendar.test.js.
 */

import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const ROOT = join(__dirname, '..');
const read = (...p) => readFileSync(join(ROOT, ...p), 'utf-8');
const CALENDAR = read('popup', 'calendar-utils.js');
const ProtonSenderAlias = new Function(read('lib', 'sender-alias.js') + '\nreturn ProtonSenderAlias;')();

const ME = 'me@example.com';
let I18n;

beforeAll(() => { I18n = new Function(read('lib', 'i18n.js') + '\nreturn ProtonI18n;')(); });
afterEach(() => { I18n.setLanguage('en'); });

const flush = () => new Promise((r) => setTimeout(r, 0));
const settle = async (n = 12) => { for (let i = 0; i < n; i++) await flush(); };

const ICS = [
  'BEGIN:VCALENDAR', 'METHOD:REQUEST', 'BEGIN:VEVENT', 'UID:not-in-calendar-1',
  'SUMMARY:Planning', 'DTSTART:20261105T100000Z', 'DTEND:20261105T110000Z',
  'ORGANIZER;CN=Organizer:mailto:organizer@example.org',
  'ATTENDEE;PARTSTAT=NEEDS-ACTION:mailto:' + ME,
  'END:VEVENT', 'END:VCALENDAR',
].join('\r\n');

/** Mount the card; `replies` answers background messages by type. */
function mount(replies = {}, ics = ICS, accountEmail = ME) {
  const sent = [];
  const answers = {
    GET_ADDRESSES: [{ Email: ME }], GET_CALENDAR_ATTENDEES: { notFound: true },
    CHECK_INVITE_SAVABLE: { savable: true }, CALENDAR_RSVP: { success: true }, ...replies,
  };
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
  const host = document.createElement('div');
  mod.renderCalendarInvite(mod.parseICS(ics), 'acc1', ics, {
    containerEl: host,
    getSelectedMsg: () => ({ ID: 'm1', ConversationID: 'c1', _accountId: 'acc1', _accountEmail: accountEmail }),
    showToast: () => {},
  });
  const buttons = () => [...host.querySelectorAll('.calendar-invite-buttons .calendar-invite-btn')];
  const status = () => host.querySelector('.calendar-invite-status');
  const click = (key) => buttons().find((b) => b.textContent === I18n.t(key)).click();
  return { host, sent, buttons, status, click };
}

describe('an invitation that is not in the calendar', () => {
  it('keeps Yes, Maybe and No usable and says answering adds it', async () => {
    const card = mount();
    await settle();
    expect(card.buttons()).toHaveLength(3);
    expect(card.buttons().every((b) => !b.disabled)).toBe(true);
    expect(card.status().textContent).toBe(I18n.t('eventNotInCalendarYet'));
    // A note, not a warning: nothing is wrong with the invitation.
    expect(card.status().style.color).toBe('');
  });

  it('asks the background, once, with the invitation and the invited address', async () => {
    const card = mount();
    await settle();
    const asks = card.sent.filter((m) => m.type === 'CHECK_INVITE_SAVABLE');
    expect(asks).toHaveLength(1);
    expect(asks[0]).toMatchObject({ accountId: 'acc1', eventUID: 'not-in-calendar-1', attendeeEmail: ME, inviteIcs: ICS, recurrenceId: '', shownLocation: '' });
    // The card's own reply, for the background to compare with what it would save.
    expect(asks[0].replyIcs).toMatch(/^BEGIN:VCALENDAR/);
    expect(asks[0].replyIcs.split('\r\n')).toContain('UID:not-in-calendar-1');
  });

  it('promises nothing when the background cannot save it', async () => {
    // A series with its changed occurrences, the user's own event, a zone the
    // API refuses: the background says no, the buttons still work.
    const card = mount({ CHECK_INVITE_SAVABLE: { savable: false } });
    await settle();
    expect(card.buttons().every((b) => !b.disabled)).toBe(true);
    expect(card.status().textContent).toBe('');
  });

  it('does not even ask when none of the account\'s addresses is invited', async () => {
    const card = mount({ GET_ADDRESSES: [{ Email: 'someone.else@example.com' }] }, ICS, 'someone.else@example.com');
    await settle();
    expect(card.status().textContent).toBe('');
    expect(card.sent.some((m) => m.type === 'CHECK_INVITE_SAVABLE')).toBe(false);
  });

  it('says so in the active language', async () => {
    I18n.setLanguage('de');
    const card = mount();
    await settle();
    expect(card.status().textContent).toBe(I18n.t('eventNotInCalendarYet'));
    expect(card.status().textContent).toMatch(/noch nicht in Ihrem Kalender/);
  });

  it('hands the invitation and the promise to the background with the answer', async () => {
    const card = mount();
    await settle();
    card.click('accept');
    await settle();
    const msg = card.sent.find((m) => m.type === 'CALENDAR_RSVP');
    expect(msg).toMatchObject({ partstat: 'ACCEPTED', eventUID: 'not-in-calendar-1', inviteIcs: ICS, promisedAdd: true, shownLocation: '' });
  });

  it('makes no promise on the answer it did not make on the card', async () => {
    const card = mount({ CHECK_INVITE_SAVABLE: { savable: false } });
    await settle();
    card.click('accept');
    await settle();
    expect(card.sent.find((m) => m.type === 'CALENDAR_RSVP').promisedAdd).toBe(false);
  });

  it('confirms the answer and stops the note once it is answered', async () => {
    // The calendar can lag behind the write: the lookup after the answer may
    // still find nothing. The confirmation must stay.
    const card = mount({ CALENDAR_RSVP: { success: true, calendar: 'added' } });
    await settle();
    card.click('accept');
    await settle();
    expect(card.status().textContent).toBe(I18n.t('rsvpAccepted'));
    expect(card.host.querySelector('.calendar-invite-status-note')).toBeNull();
  });

  it('says on a line of its own when the calendar could not take the event', async () => {
    const card = mount({ CALENDAR_RSVP: { success: true, calendar: 'notAdded' } });
    await settle();
    card.click('decline');
    await settle();
    const note = card.host.querySelector('.calendar-invite-status-note');
    expect(note && note.textContent).toBe(I18n.t('rsvpSentNotAdded'));
    expect(card.status().textContent.startsWith(I18n.t('rsvpDeclined'))).toBe(true);
  });

  it('does not put the note over an answer that beat the lookup', async () => {
    let release;
    const lookup = new Promise((r) => { release = r; });
    const card = mount({ GET_CALENDAR_ATTENDEES: () => lookup.then(() => ({ notFound: true })) });
    await settle(2);
    card.click('tentative');
    await settle();
    expect(card.status().textContent).toBe(I18n.t('rsvpTentative'));
    release();
    await settle();
    expect(card.status().textContent).toBe(I18n.t('rsvpTentative'));
  });

  it('does not paint a late lookup over an answer made on this card', async () => {
    // A reopened card whose lookups wait for an earlier answer still on its
    // way: the user answers No meanwhile; the earlier Yes must not come back.
    let release;
    const late = new Promise((r) => { release = r; });
    const card = mount({
      GET_CALENDAR_ATTENDEES: () => late.then(() => ({ attendees: [{ Token: '', Email: ME, Status: 3 }] })),
      CALENDAR_RSVP: { success: true, calendar: 'updated' },
    });
    await settle(2);
    card.click('decline');
    await settle();
    release();
    await settle();
    const lit = card.buttons().filter((b) => /accepted|tentative|declined/.test(b.className)).map((b) => b.textContent);
    expect(lit).toEqual([I18n.t('decline')]);
    expect(card.status().textContent).toBe(I18n.t('rsvpDeclined'));
  });

  it('shows an event without a title as "(no title)"', async () => {
    const card = mount({}, ICS.replace('SUMMARY:Planning\r\n', ''));
    await settle();
    expect(card.host.querySelector('.calendar-invite-title').textContent).toBe(I18n.t('eventUntitled'));
  });
});


describe('the buttons after an answer (they stayed disabled until the mail was reopened)', () => {
  // As in Proton's Mail app: blocked only while an answer is on its way; the
  // other two change it afterwards; the current one is not sent again.
  const lit = (card) => card.buttons().filter((b) => /accepted|tentative|declined/.test(b.className)).map((b) => b.textContent);
  const pressed = (card) => card.buttons().filter((b) => b.getAttribute('aria-pressed') === 'true').map((b) => b.textContent);
  const rsvps = (card) => card.sent.filter((m) => m.type === 'CALENDAR_RSVP');

  it('keeps them usable once the answer is sent', async () => {
    const card = mount({ CALENDAR_RSVP: { success: true, calendar: 'added' } });
    await settle();
    card.click('accept');
    await settle();
    expect(card.buttons().every((b) => !b.disabled)).toBe(true);
    expect(lit(card)).toEqual([I18n.t('accept')]);
    expect(pressed(card)).toEqual([I18n.t('accept')]);
    expect(card.status().textContent).toBe(I18n.t('rsvpAccepted'));
  });

  it('changes the answer on the same card, and the change no longer promises to add it', async () => {
    const card = mount({ CALENDAR_RSVP: { success: true, calendar: 'added' } });
    await settle();
    card.click('accept');
    await settle();
    card.click('decline');
    await settle();
    expect(rsvps(card).map((m) => m.partstat)).toEqual(['ACCEPTED', 'DECLINED']);
    expect(rsvps(card).map((m) => m.promisedAdd)).toEqual([true, false]);
    expect(lit(card)).toEqual([I18n.t('decline')]);
    expect(pressed(card)).toEqual([I18n.t('decline')]);
    expect(card.status().textContent).toBe(I18n.t('rsvpDeclined'));
  });

  it('keeps the promise while the calendar could not take the event', async () => {
    const card = mount({ CALENDAR_RSVP: { success: true, calendar: 'notAdded' } });
    await settle();
    card.click('accept');
    await settle();
    card.click('tentative');
    await settle();
    expect(rsvps(card).map((m) => m.promisedAdd)).toEqual([true, true]);
    expect(card.host.querySelectorAll('.calendar-invite-status-note')).toHaveLength(1);
  });

  it('does not send the current answer again', async () => {
    const card = mount({ CALENDAR_RSVP: { success: true, calendar: 'added' } });
    await settle();
    card.click('accept');
    await settle();
    card.click('accept');
    await settle();
    expect(rsvps(card)).toHaveLength(1);
    expect(card.status().textContent).toBe(I18n.t('rsvpAccepted'));
  });

  it('takes no second answer while one is on its way', async () => {
    let release;
    const card = mount({ CALENDAR_RSVP: () => new Promise((r) => { release = () => r({ success: true, calendar: 'added' }); }) });
    await settle();
    card.click('accept');
    await settle();
    expect(card.buttons().every((b) => b.disabled)).toBe(true);
    expect(card.status().textContent).toBe(I18n.t('rsvpSending'));
    card.click('decline');
    await settle();
    expect(rsvps(card)).toHaveLength(1);
    release();
    await settle();
    expect(card.buttons().every((b) => !b.disabled)).toBe(true);
    expect(lit(card)).toEqual([I18n.t('accept')]);
  });

  it('goes back to the answer it stood for when sending fails, and lets the user try again', async () => {
    let fail = false;
    const card = mount({ CALENDAR_RSVP: () => (fail ? { error: 'Network error' } : { success: true, calendar: 'added' }) });
    await settle();
    card.click('accept');
    await settle();
    fail = true;
    card.click('decline');
    await settle();
    expect(lit(card)).toEqual([I18n.t('accept')]);
    expect(pressed(card)).toEqual([I18n.t('accept')]);
    expect(card.buttons().every((b) => !b.disabled)).toBe(true);
    expect(card.status().textContent).toBe(I18n.t('rsvpFailed'));
    fail = false;
    card.click('decline');
    await settle();
    expect(rsvps(card).map((m) => m.partstat)).toEqual(['ACCEPTED', 'DECLINED', 'DECLINED']);
    expect(lit(card)).toEqual([I18n.t('decline')]);
  });

  it('lights nothing again when a first answer fails', async () => {
    const card = mount({ CALENDAR_RSVP: { error: 'Network error' } });
    await settle();
    card.click('tentative');
    await settle();
    expect(lit(card)).toEqual([]);
    expect(pressed(card)).toEqual([]);
    expect(card.buttons().every((b) => !b.disabled)).toBe(true);
  });

  it('treats the answer found in the calendar as the current one', async () => {
    const card = mount({
      GET_CALENDAR_ATTENDEES: { attendees: [{ Token: '', Email: ME, Status: 1 }] },
      CALENDAR_RSVP: { success: true, calendar: 'updated' },
    });
    await settle();
    expect(lit(card)).toEqual([I18n.t('tentative')]);
    expect(pressed(card)).toEqual([I18n.t('tentative')]);
    expect(card.buttons().every((b) => !b.disabled)).toBe(true);
    card.click('tentative');
    await settle();
    expect(rsvps(card)).toHaveLength(0);
    card.click('accept');
    await settle();
    expect(rsvps(card).map((m) => m.partstat)).toEqual(['ACCEPTED']);
    expect(lit(card)).toEqual([I18n.t('accept')]);
  });

  it('stays usable when this account cannot answer at all', async () => {
    const card = mount({ GET_ADDRESSES: [{ Email: 'someone.else@example.com' }] }, ICS, 'someone.else@example.com');
    await settle();
    card.click('accept');
    await settle();
    expect(rsvps(card)).toHaveLength(0);
    expect(card.status().textContent).toBe(I18n.t('rsvpFailed'));
    expect(card.buttons().every((b) => !b.disabled)).toBe(true);
    expect(lit(card)).toEqual([]);
  });
});

describe('the card after a changed or failed answer (review)', () => {
  const lit = (card) => card.buttons().filter((b) => /accepted|tentative|declined/.test(b.className)).map((b) => b.textContent);
  const rsvps = (card) => card.sent.filter((m) => m.type === 'CALENDAR_RSVP');

  it('shows the answer just given in the attendee list, not the one a lagging read-back still has', async () => {
    const card = mount({
      // The calendar keeps reporting the earlier Yes (read-after-write lag).
      GET_CALENDAR_ATTENDEES: { attendees: [{ Token: '', Email: ME, Status: 3 }] },
      CALENDAR_RSVP: { success: true, calendar: 'updated' },
    });
    await settle();
    expect(lit(card)).toEqual([I18n.t('accept')]);
    card.click('decline');
    await settle();
    const badge = card.host.querySelector('.calendar-invite-attendee-status');
    expect(badge.title).toBe(I18n.t('rsvpStatusDeclined'));
  });

  it('shows the calendar\'s answer again when a first answer that beat the lookup fails', async () => {
    let release;
    const late = new Promise((r) => { release = r; });
    const card = mount({
      GET_CALENDAR_ATTENDEES: () => late.then(() => ({ attendees: [{ Token: '', Email: ME, Status: 3 }] })),
      CALENDAR_RSVP: { error: 'Network error' },
    });
    await settle(2);
    card.click('decline');
    await settle();
    release();
    await settle();
    expect(lit(card)).toEqual([I18n.t('accept')]);
    // Yes is the current answer again: not sent a second time.
    card.click('accept');
    await settle();
    expect(rsvps(card).map((m) => m.partstat)).toEqual(['DECLINED']);
  });

  it('and when the lookup came back while that failing answer was on its way', async () => {
    let fail;
    const card = mount({
      GET_CALENDAR_ATTENDEES: { attendees: [{ Token: '', Email: ME, Status: 3 }] },
      CALENDAR_RSVP: () => new Promise((r) => { fail = () => r({ error: 'Network error' }); }),
    });
    card.click('decline');
    await settle();
    // The lookup came back during the send: kept, not painted over it.
    expect(lit(card)).toEqual([I18n.t('decline')]);
    fail();
    await settle();
    expect(lit(card)).toEqual([I18n.t('accept')]);
    expect(card.status().textContent).toBe(I18n.t('rsvpFailed'));
  });
});
