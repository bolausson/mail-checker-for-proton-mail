/**
 * Answering an invitation that is not in the calendar yet.
 *
 * Proton's server adds the invitations it can read to the calendar by itself
 * (the user's "Add to calendar and mark as pending", on by default). Others
 * are not there: an invitation it cannot read (an .ics mailed end-to-end
 * encrypted between Proton accounts), every invitation of a user who turned
 * the setting off, an event the user deleted. Proton's Mail app keeps
 * Yes/Maybe/No usable for those and saves the user's copy when they answer:
 * a mailed invitation after its reply went out, an invitation from Proton
 * Calendar linked to the organizer's event before the reply. Mail Checker
 * disabled the buttons instead (since v1.3.26, a511f6a), so such an
 * invitation could not be answered at all.
 *
 * The crypto is real (the vendored openpgp): the saved parts are decrypted
 * again and read back, the way Proton's apps will read them. The functions
 * are lifted out of the real sources and run with injected dependencies (the
 * pattern of cold-start-keys.test.js).
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { createHash } from 'crypto';

const ROOT = join(__dirname, '..');
const read = (...p) => readFileSync(join(ROOT, ...p), 'utf-8');
const ACCOUNTS = read('background', 'accounts.js');

let openpgp;
let ProtonBinary;
let ICS;
let Serialize;
let ProtonSenderAlias;
let TZ;
let POPUP; // the real popup module: its parser and the REPLY it builds
// What GET calendar/v1/timezones lists (a small part of the real 340: no
// Asia/Singapore, no Europe/Kyiv there either).
const ALLOWED = ['Europe/Berlin', 'Europe/Kiev', 'Asia/Kolkata', 'Asia/Kuala_Lumpur', 'America/New_York', 'UTC',
  'Europe/London', 'Europe/Dublin'];
let ADDRESS_KEY;   // the calendar member's address key: signs every part
let CALENDAR_KEY;  // the calendar's primary key: session keys are wrapped to it

beforeAll(async () => {
  globalThis.window = globalThis;
  globalThis.self = globalThis;
  // eslint-disable-next-line no-eval
  (0, eval)(read('lib', 'openpgp.min.js'));
  openpgp = globalThis.openpgp;
  ProtonBinary = new Function(read('lib', 'binary-utils.js') + '\nreturn ProtonBinary;')();
  ICS = new Function(read('background', 'calendar-ics.js') + '\nreturn ProtonCalendarICS;')();
  Serialize = new Function('openpgp', 'ProtonBinary', 'ProtonCalendarICS',
    read('background', 'calendar-serialize.js') + '\nreturn ProtonCalendarSerialize;')(openpgp, ProtonBinary, ICS);
  ProtonSenderAlias = new Function(read('lib', 'sender-alias.js') + '\nreturn ProtonSenderAlias;')();
  TZ = new Function(read('background', 'calendar-tz-data.js') + read('background', 'calendar-tz.js')
    + '\nreturn ProtonCalendarTZ;')();
  POPUP = new Function('browser', 'ProtonI18n', 'window', 'ProtonSenderAlias',
    read('popup', 'calendar-utils.js') + '\nreturn PopupCalendar;')(
    { runtime: { sendMessage: async () => null }, tabs: { create() {} } },
    { t: (k) => k, plural: (k, n) => n + ' ' + k }, globalThis, ProtonSenderAlias);
  const gen = async (email) => (await openpgp.generateKey({
    type: 'ecc', curve: 'curve25519', userIDs: [{ email }], format: 'object',
  })).privateKey;
  ADDRESS_KEY = await gen('me@example.com');
  CALENDAR_KEY = await gen('calendar@example.com');
});

// Lift a top-level function out of a source file, keeping `async`.
function lift(src, name) {
  let start = src.indexOf('function ' + name + '(');
  if (start === -1) throw new Error('not found: ' + name);
  if (src.slice(start - 6, start) === 'async ') start -= 6;
  let i = src.indexOf('{', src.indexOf(')', start));
  let depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) return src.slice(start, i + 1); }
  }
  throw new Error('unbalanced braces reading ' + name);
}

// Lift a one-line `const NAME = ...;` (a pattern or a small table) out of a source.
function liftConst(src, name) {
  const m = src.match(new RegExp('^\\s*const ' + name + ' = .*;$', 'm'));
  if (!m) throw new Error('not found: const ' + name);
  return new Function(m[0] + '\nreturn ' + name + ';')();
}

const sha1 = (s) => createHash('sha1').update(s).digest('hex');
const TOKEN_ME = sha1('pm-token-me');
const SESSION_KEY = new Uint8Array(32).map((_, i) => (i * 7 + 3) & 0xff);
const UPDATE_TIME = 1762700000; // 2025-11-09T14:53:20Z

/** A mailed invitation from an outside organizer to a +alias of ours. */
function externalInvite({
  uid = 'ext-invite-1@example.org', organizer = 'organizer@example.org', extra = [], vevents = 1,
  times = ['DTSTART:20261120T100000Z', 'DTEND:20261120T110000Z'],
} = {}) {
  const vevent = [
    'BEGIN:VEVENT',
    'UID:' + uid,
    'DTSTAMP:20261101T090000Z',
    'CREATED:20261101T085500Z',
    ...times,
    'SEQUENCE:2',
    'STATUS:CONFIRMED',
    'TRANSP:OPAQUE',
    'SUMMARY:Quarterly review \u{1F4C8}',
    'LOCATION:Room 4',
    'ORGANIZER;CN=Org Person:mailto:' + organizer,
    'ATTENDEE;CN=Me;ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=TRUE:mailto:me+team@example.com',
    'ATTENDEE;CN=Co Invitee;PARTSTAT=TENTATIVE:mailto:co.invitee@example.net',
    // Listed twice, in another case: Proton refuses a duplicate attendee.
    'ATTENDEE;CN=Me again;PARTSTAT=NEEDS-ACTION:mailto:ME+team@example.com',
    ...extra,
    'BEGIN:VALARM', 'ACTION:DISPLAY', 'TRIGGER:-PT15M', 'END:VALARM',
    'END:VEVENT',
  ];
  return ['BEGIN:VCALENDAR', 'PRODID:-//Example Corp//Calendar//EN', 'VERSION:2.0', 'METHOD:REQUEST',
    ...Array.from({ length: vevents }, () => vevent).flat(), 'END:VCALENDAR'].join('\r\n');
}

/** The same invitation as Proton Calendar mails it: the organizer's event ID,
 *  its session key and our attendee token come with it. */
function protonInvite() {
  return externalInvite({
    uid: 'pm-invite-1@proton.me',
    extra: [
      'X-PM-SHARED-EVENT-ID:shared-evt-1',
      'X-PM-SESSION-KEY:' + Buffer.from(SESSION_KEY).toString('base64'),
    ],
  }).replace('RSVP=TRUE:mailto:me+team@example.com', 'RSVP=TRUE;X-PM-TOKEN=' + TOKEN_ME + ':mailto:me+team@example.com');
}

/** What the card sends for `ics`: the popup's own parse and the REPLY it builds. */
function cardAnswer(ics, partstat) {
  const event = POPUP.parseICS(ics);
  return { event, reply: event ? POPUP.buildRsvpICS(event, 'me+team@example.com', partstat) : null };
}

/**
 * The background functions around one account. `world` records what reached
 * the network, in order: 'send' (the reply mail), 'create' (an event saved),
 * 'status' (a status update on an existing event).
 */
function makeWorld(over = {}) {
  const world = {
    log: [], sent: [], created: [], diag: [], statusTimes: [], lookups: [], usable: ['cal1'],
    existing: [],                 // getCalendarEventByUID's answer
    status: () => 'notFound',     // _updateCalendarAttendeeStatus's answer
    createFails: false,
    owned: [{ ID: 'a1', Email: 'me@example.com', CanAlias: true }],
    // core/v4/addresses/canonical: each address's Response (an Error: the
    // request fails). Lower case is what it does to these example domains.
    canonical: (email) => ({ Code: 1000, CanonicalEmail: email.toLowerCase() }),
    canonicalPaths: [],
    ...over,
  };
  const account = { id: 'acc1', keysUnlocked: true, decryptedKeys: [ADDRESS_KEY], addressKeyMap: { 'me@example.com': ADDRESS_KEY } };
  const deps = {
    ensureKeysUnlocked: async () => true,
    getAccount: () => account,
    _resolveSenderInfo: async () => ({
      fromAddr: { ID: 'a1', Email: 'me+team@example.com', DisplayName: 'Me' },
      senderPrivKey: ADDRESS_KEY, senderPubKey: ADDRESS_KEY, defaultAddr: { ID: 'a1', DisplayName: 'Me' },
    }),
    _encryptAndSend: async (accountId, acct, payload, toList, htmlBody, priv, pub, attachments) => {
      await new Promise((r) => setTimeout(r, 0));
      world.log.push('send');
      world.sent.push(Buffer.from(attachments[0].data, 'base64').toString('utf-8'));
    },
    _updateCalendarAttendeeStatus: async (a, uid, token, partstat, email, recurrenceId, updateTime) => {
      world.log.push('status');
      world.statusTimes.push(updateTime);
      return world.status(world);
    },
    getCalendarEventByUID: async (a, uid, opts) => {
      world.lookups.push(opts);
      if (world.existing instanceof Error) throw world.existing;
      return world.existing;
    },
    _ownCalendars: async () => ({ usable: new Set(world.usable) }),
    getAddresses: async () => world.owned,
    request: async (accountId, method, path) => {
      if (/^calendar\/v2\/[^/]+\/bootstrap$/.test(path)) return { Members: [{ ID: 'mem1', Email: 'Me@example.com' }] };
      if (path === 'calendar/v1/timezones') { world.log.push('zones'); return { Code: 1000, Timezones: ALLOWED }; }
      if (path.startsWith('core/v4/addresses/canonical?')) {
        world.canonicalPaths.push(path);
        if (world.canonical instanceof Error) throw world.canonical;
        const asked = path.slice(path.indexOf('?') + 1).split('&')
          .map((p) => decodeURIComponent(p.replace(/^Emails\[\]=/, '')));
        // As the API answers: Code 1001, one Response per address, echoing it.
        return { Code: 1001, Responses: asked.map((Email) => ({
          Email: world.canonicalEcho ? world.canonicalEcho(Email) : Email, Response: world.canonical(Email),
        })) };
      }
      throw new Error('unexpected request ' + path);
    },
    _getCalendarKeys: async () => [CALENDAR_KEY],
    ProtonCalendarAPI: {
      invitationCalendarId: async () => 'cal1',
      createEvent: async (accountId, calendarId, memberId, payload, opts) => {
        await new Promise((r) => setTimeout(r, 0));
        world.log.push('create');
        // true: every save fails; a number: the first N saves fail.
        const fails = world.createFails === true || (typeof world.createFails === 'number' && world.createFails-- > 0);
        if (fails) throw new Error('Calendar API error (code 2001)');
        world.created.push({ calendarId, memberId, payload, opts });
        return {
          ID: 'srv-evt-' + world.created.length,
          AttendeesInfo: { Attendees: (payload.Attendees || []).map((a) => ({ ...a, UpdateTime: UPDATE_TIME })) },
        };
      },
    },
    ProtonDiag: { record: (event, fields) => world.diag.push({ event, ...fields }) },
    debugLog: () => {},
    console: { warn: () => {}, log: () => {} },
    ProtonSenderAlias,
    ProtonCalendarICS: ICS,
    ProtonCalendarSerialize: Serialize,
    ProtonCalendarTZ: TZ,
    ProtonBinary,
    _inviteQueue: new Map(),
    _allowedZones: null,
    CONTROL_CHAR: liftConst(ACCOUNTS, 'CONTROL_CHAR'),
    LINE_SEPARATORS: liftConst(ACCOUNTS, 'LINE_SEPARATORS'),
    RRULE_INTERVAL_MAX: liftConst(ACCOUNTS, 'RRULE_INTERVAL_MAX'),
    RRULE_COUNT_MAX: liftConst(ACCOUNTS, 'RRULE_COUNT_MAX'),
  };
  const names = ['sendCalendarRsvp', '_oneInviteAtATime', '_invitationToSave', '_organizedByUser',
    '_protonInvitationKeys', '_inviteNotifications', '_withAnswer', '_invitationCalendarContext',
    '_saveInvitationCopy', '_linkProtonInvitation', '_asProtonReply', '_supportedZones', '_withSupportedZones',
    '_matchesReply', '_supportedRrule', 'canSaveInvitation', '_protonLinkKeys', '_scopeMatch', '_pickEventForScope',
    '_diagUid', '_hasControl', '_canonicalEmails'];
  const body = names.map((n) => lift(ACCOUNTS, n)).join('\n') + '\nreturn { ' + names.join(', ') + ' };';
  world.fns = new Function(...Object.keys(deps), body)(...Object.values(deps));
  return world;
}

/** Answer `ics` the way the card's CALENDAR_RSVP does: the REPLY and the
 *  RECURRENCE-ID come from the popup's own parse of the same mail. */
function answer(world, ics, { partstat = 'ACCEPTED', uid, recurrenceId, reply, promisedAdd = true, shownLocation } = {}) {
  const card = cardAnswer(ics, partstat);
  world.lastReply = reply || card.reply;
  return world.fns.sendCalendarRsvp('acc1', 'organizer@example.org', 'Accepted: Quarterly review', '<div>yes</div>',
    world.lastReply, 'me+team@example.com', {
      eventUID: uid || card.event.uid, attendeeToken: '', attendeeEmail: 'me+team@example.com', partstat,
      recurrenceId: recurrenceId !== undefined ? recurrenceId : (card.event.recurrenceIdRaw || ''),
      inviteIcs: ics, promisedAdd, shownLocation: shownLocation !== undefined ? shownLocation : (card.event.location || ''),
    });
}

/** Decrypt a saved event's parts with the calendar key, as Proton's apps do. */
async function readBack(payload) {
  const [sessionKey] = await openpgp.decryptSessionKeys({
    message: await openpgp.readMessage({ binaryMessage: ProtonBinary.base64ToUint8(payload.SharedKeyPacket) }),
    decryptionKeys: CALENDAR_KEY,
  });
  const open = async (b64) => (await openpgp.decrypt({
    message: await openpgp.readMessage({ binaryMessage: ProtonBinary.base64ToUint8(b64) }),
    sessionKeys: sessionKey,
  })).data;
  // openpgp hands text back with LF line ends; the signed clear part keeps CRLF.
  const unfold = (s) => s.replace(/\r?\n[ \t]/g, '').replace(/\r?\n/g, '\r\n');
  return {
    sessionKey,
    sharedSigned: unfold(payload.SharedEventContent ? payload.SharedEventContent[0].Data : ''),
    sharedEncrypted: payload.SharedEventContent ? unfold(await open(payload.SharedEventContent[1].Data)) : '',
    attendees: payload.AttendeesEventContent ? unfold(await open(payload.AttendeesEventContent[0].Data)) : '',
  };
}

describe('a mailed invitation that is not in the calendar', () => {
  it('sends the reply first, then saves the copy Proton saves', async () => {
    const world = makeWorld();
    const result = await answer(world, externalInvite());

    expect(result).toEqual({ success: true, calendar: 'added' });
    expect(world.log).toEqual(['send', 'status', 'create']);
    expect(world.sent[0]).toBe(world.lastReply);
    expect(world.created).toHaveLength(1);
    const { calendarId, memberId, payload, opts } = world.created[0];
    expect([calendarId, memberId, opts]).toEqual(['cal1', 'mem1', { invitee: true }]);
    // An invited attendee's copy, never the user's own event.
    expect(payload.IsOrganizer).toBe(0);
    expect(payload.Permissions).toBe(1);
    // Yes keeps the calendar's default alarms; nothing from the invitation's VALARM.
    expect(payload.Notifications).toBeNull();
    // No EXDATE, so no calendar part: the organizer's STATUS/TRANSP are not ours.
    expect(payload.CalendarEventContent).toBeUndefined();
    // Our answer in the clear status; the other attendee keeps theirs; the duplicate is gone.
    expect(payload.Attendees).toEqual([
      { Token: sha1('ext-invite-1@example.org' + 'me+team@example.com'), Status: 3, Comment: null },
      { Token: sha1('ext-invite-1@example.org' + 'co.invitee@example.net'), Status: 1, Comment: null },
    ]);
  });

  it('keeps the invitation\'s own DTSTAMP and SEQUENCE and drops what Proton drops', async () => {
    const world = makeWorld();
    await answer(world, externalInvite());
    const back = await readBack(world.created[0].payload);

    // What decides "is this invitation outdated" when it is opened again.
    expect(back.sharedSigned).toContain('DTSTAMP:20261101T090000Z');
    expect(back.sharedSigned).toContain('SEQUENCE:2');
    expect(back.sharedSigned).toContain('ORGANIZER;CN=Org Person:mailto:organizer@example.org');
    expect(back.sharedEncrypted).toContain('SUMMARY:Quarterly review \u{1F4C8}');
    expect(back.sharedEncrypted).toContain('LOCATION:Room 4');
    for (const part of [back.sharedSigned, back.sharedEncrypted]) {
      expect(part).not.toMatch(/^(CREATED|STATUS|TRANSP|BEGIN:VALARM)/m);
    }
    // Answers live in the clear Attendees list only, never as PARTSTAT inside.
    const lines = back.attendees.split('\r\n').filter((l) => l.startsWith('ATTENDEE'));
    expect(lines).toHaveLength(2);
    expect(back.attendees).not.toContain('PARTSTAT');
    expect(lines[0]).toContain('X-PM-TOKEN=' + world.created[0].payload.Attendees[0].Token);
    expect(lines[0]).toMatch(/:mailto:me\+team@example\.com$/);
  });

  it('gives a declined copy no alarms, as Proton does', async () => {
    const world = makeWorld();
    await answer(world, externalInvite(), { partstat: 'DECLINED' });
    const { payload } = world.created[0];
    expect(payload.Notifications).toEqual([]);
    expect(payload.Attendees[0].Status).toBe(2);
  });

  it('only updates the status when the event is in the calendar', async () => {
    const world = makeWorld({ status: () => 'updated' });
    const result = await answer(world, externalInvite());
    expect(result).toEqual({ success: true, calendar: 'updated' });
    expect(world.log).toEqual(['send', 'status']);
    expect(world.created).toHaveLength(0);
  });

  it('reports the reply as sent when the calendar refuses the copy', async () => {
    const world = makeWorld({ createFails: true });
    const result = await answer(world, externalInvite());
    expect(result).toEqual({ success: true, calendar: 'notAdded' });
    expect(world.log[0]).toBe('send');
    // It looked once more: another device may have added it meanwhile.
    expect(world.log.filter((x) => x === 'status')).toHaveLength(2);
    const rec = world.diag.find((d) => d.event === 'rsvp.import' && d.kind === 'copy');
    expect(rec).toMatchObject({ ok: 'no', uid: 'ext-invite-1@e' });
    // The diagnostic never carries an address.
    expect(JSON.stringify(world.diag)).not.toMatch(/@example\.(com|net|org)/);
  });

  it('saves one copy when the same invitation is answered twice at once', async () => {
    const world = makeWorld({ status: (w) => (w.created.length ? 'updated' : 'notFound') });
    const [first, second] = await Promise.all([answer(world, externalInvite()), answer(world, externalInvite())]);
    expect(world.created).toHaveLength(1);
    expect([first.calendar, second.calendar]).toEqual(['added', 'updated']);
  });

  it('keeps no copy of an event the user organizes', async () => {
    const world = makeWorld();
    const result = await answer(world, externalInvite({ organizer: 'me@example.com' }));
    expect(result.calendar).toBe('notAdded');
    expect(world.created).toHaveLength(0);
  });

  it('does not save a series that comes with changed occurrences', async () => {
    const world = makeWorld();
    const result = await answer(world, externalInvite({ vevents: 2 }));
    expect(result.calendar).toBe('notAdded');
    expect(world.created).toHaveLength(0);
    expect(world.diag.find((d) => d.kind === 'check')).toMatchObject({ savable: 'vevents' });
  });

  it('does not save the whole event for an answer to one occurrence', async () => {
    const world = makeWorld();
    const result = await answer(world, externalInvite(), { recurrenceId: 'RECURRENCE-ID:20261120T100000Z' });
    expect(result.calendar).toBe('notAdded');
    expect(world.created).toHaveLength(0);
  });

  it('stores an Outlook invitation under a zone the API accepts', async () => {
    // Measured: the API refuses "W. Europe Standard Time" ("Invalid timezone").
    const world = makeWorld();
    const outlook = (uid) => externalInvite({ uid, times: [
      'DTSTART;TZID=W. Europe Standard Time:20261120T100000',
      'DTEND;TZID=W. Europe Standard Time:20261120T110000',
    ] });
    expect((await answer(world, outlook('ol-1@example.org'), { uid: 'ol-1@example.org' })).calendar).toBe('added');
    const signed = world.created[0].payload.SharedEventContent[0].Data;
    expect(signed).toContain('DTSTART;TZID=Europe/Berlin:20261120T100000');
    expect(signed).toContain('DTEND;TZID=Europe/Berlin:20261120T110000');
    expect(signed).not.toContain('Standard Time');
    // The list is read once per worker.
    await answer(world, outlook('ol-2@example.org'), { uid: 'ol-2@example.org' });
    expect(world.created).toHaveLength(2);
    expect(world.log.filter((x) => x === 'zones')).toHaveLength(1);
  });

  it('sends the reply as UTF-8, an emoji title included', async () => {
    const world = makeWorld({ status: () => 'updated' });
    await answer(world, externalInvite());
    expect(world.sent[0]).toContain('SUMMARY:Quarterly review \u{1F4C8}');
  });

  it('saves one answered occurrence as Proton does, with its RECURRENCE-ID', async () => {
    const world = makeWorld();
    const ics = externalInvite({ extra: ['RECURRENCE-ID:20261120T100000Z'] });
    const result = await answer(world, ics, { recurrenceId: 'RECURRENCE-ID:20261120T100000Z' });
    expect(result.calendar).toBe('added');
    expect(world.created[0].payload.SharedEventContent[0].Data).toContain('RECURRENCE-ID:20261120T100000Z');
  });

  it('does not call an event missing when the save failed but the event is there now', async () => {
    // The save was refused, the second look finds it (another device, or the
    // response was lost after the server stored it), its status not settable.
    const world = makeWorld({ createFails: true, status: (w) => (w.log.includes('create') ? 'skipped' : 'notFound') });
    const result = await answer(world, externalInvite());
    expect(result).toEqual({ success: true });
  });

  it('reads an invitation whose METHOD sits inside the VEVENT, as the card does', async () => {
    const world = makeWorld();
    const ics = externalInvite().replace('METHOD:REQUEST\r\n', '').replace('SEQUENCE:2', 'SEQUENCE:2\r\nMETHOD:REQUEST');
    expect((await answer(world, ics)).calendar).toBe('added');
  });

  it('finds the user in an attendee line with a space before mailto:', async () => {
    const world = makeWorld();
    const ics = externalInvite().replace('RSVP=TRUE:mailto:me+team@example.com', 'RSVP=TRUE: mailto:me+team@example.com');
    expect((await answer(world, ics)).calendar).toBe('added');
  });

  it('writes no line break from a parameter of the mail into the saved event', async () => {
    // RFC 6868: ^n in a parameter value decodes to a line break. Written
    // back raw, it would start new lines: a fake attendee, a cut-off own line.
    const world = makeWorld();
    const ics = externalInvite({ times: [
      'DTSTART;TZID="Europe/Berlin^nX-EVIL:1":20261120T100000', 'DTEND;TZID="Europe/Berlin^nX-EVIL:1":20261120T110000',
    ] }).replace('ROLE=REQ-PARTICIPANT;', 'ROLE="REQ-PARTICIPANT^nATTENDEE;X-PM-TOKEN=deadbeef:mailto:injected@example.net^nX-A";');
    await answer(world, ics);
    const { payload } = world.created[0];
    const back = await readBack(payload);
    expect(back.attendees).not.toContain('injected@example.net');
    expect(back.attendees.split('\r\n').filter((l) => l.startsWith('ATTENDEE'))).toHaveLength(2);
    expect(back.attendees).toMatch(/^ATTENDEE;CN=Me;RSVP=TRUE;X-PM-TOKEN=[0-9a-f]{40}:mailto:me\+team@example\.com$/m);
    expect(back.sharedSigned).not.toMatch(/^X-EVIL/m);
    expect(back.sharedSigned).toContain('DTSTART;TZID="Europe/Berlin^nX-EVIL:1":20261120T100000');
  });
});

describe('an invitation from Proton Calendar that is not in the calendar', () => {
  it('links the copy to the organizer\'s event first, then sends a Proton reply', async () => {
    const world = makeWorld();
    const result = await answer(world, protonInvite(), { uid: 'pm-invite-1@proton.me' });

    expect(result).toEqual({ success: true, calendar: 'added' });
    // Proton's order: the server has the answer before the mail goes, and
    // there is no status update afterwards.
    expect(world.log).toEqual(['create', 'send']);
    const { payload, opts } = world.created[0];
    expect(opts).toEqual({ invitee: true });
    expect(payload).toMatchObject({
      SharedEventID: 'shared-evt-1', UID: 'pm-invite-1@proton.me', IsOrganizer: 0, Color: null,
      Notifications: null,
      Attendees: [{ Token: TOKEN_ME, Status: 3, Comment: null }],
    });
    // The organizer's event holds the content; a linked copy carries none.
    for (const k of ['SharedEventContent', 'AttendeesEventContent', 'Permissions', 'CalendarEventContent']) {
      expect(payload).not.toHaveProperty(k);
    }
    // The organizer's session key, re-wrapped for this calendar.
    const back = await readBack({ SharedKeyPacket: payload.SharedKeyPacket });
    expect(Array.from(back.sessionKey.data)).toEqual(Array.from(SESSION_KEY));
    // The reply says the server already has the answer, stamped when it got it.
    const lines = world.sent[0].split('\r\n');
    expect(lines.filter((l) => l.startsWith('DTSTAMP'))).toEqual(['DTSTAMP:20251109T145320Z']);
    expect(lines[lines.indexOf('END:VEVENT') - 1]).toBe('X-PM-PROTON-REPLY;VALUE=BOOLEAN:TRUE');
  });

  it('still sends a plain reply when the link is refused, and saves no copy of its own', async () => {
    const world = makeWorld({ createFails: true });
    const result = await answer(world, protonInvite(), { uid: 'pm-invite-1@proton.me' });
    expect(result).toEqual({ success: true, calendar: 'notAdded' });
    // One more try after the reply, never an unlinked copy.
    expect(world.log).toEqual(['create', 'send', 'status', 'create']);
    expect(world.created).toHaveLength(0);
    expect(world.sent[0]).toBe(world.lastReply);
  });

  it('links after the reply when the first try failed', async () => {
    const world = makeWorld({ createFails: 1 });
    const result = await answer(world, protonInvite(), { uid: 'pm-invite-1@proton.me' });
    expect(result).toEqual({ success: true, calendar: 'added' });
    expect(world.created[0].payload.SharedEventID).toBe('shared-evt-1');
  });

  it('links after the reply when the lookup before it failed', async () => {
    const world = makeWorld({ existing: new Error('network down') });
    const result = await answer(world, protonInvite(), { uid: 'pm-invite-1@proton.me' });
    expect(result).toEqual({ success: true, calendar: 'added' });
    expect(world.log).toEqual(['send', 'status', 'create']);
  });

  it('does not call it missing when the link was refused but the event is there', async () => {
    const world = makeWorld({ createFails: true, status: () => 'skipped' });
    const result = await answer(world, protonInvite(), { uid: 'pm-invite-1@proton.me' });
    expect(result).toEqual({ success: true });
  });

  it('answers as before when it is in the calendar already', async () => {
    const world = makeWorld({ existing: [{ ID: 'ev1', CalendarID: 'cal1' }], status: () => 'updated' });
    const result = await answer(world, protonInvite(), { uid: 'pm-invite-1@proton.me' });
    expect(result).toEqual({ success: true, calendar: 'updated' });
    expect(world.log).toEqual(['send', 'status']);
    expect(world.sent[0]).toBe(world.lastReply);
  });
});

describe('the payload builders', () => {
  const event = (over = {}) => ({
    uid: 'u-1@example.org', method: 'PUBLISH', summary: 'Flight', status: 'CONFIRMED', transp: 'OPAQUE',
    dtstamp: { year: 2026, month: 11, day: 1, hour: 9, minute: 0, second: 0, isUTC: true },
    dtstart: { year: 2026, month: 11, day: 20, hour: 10, minute: 0, second: 0, tzid: 'Europe/Berlin', isUTC: false },
    organizer: { email: 'organizer@example.org', cn: 'Org' },
    attendees: [{ email: 'me@example.com', cn: 'Me', partstat: 'ACCEPTED' }],
    ...over,
  });

  it('leaves the "Add to Proton Calendar" import as it was', async () => {
    const payload = await Serialize.buildPayload(event(), { signingKey: ADDRESS_KEY, calendarPublicKey: CALENDAR_KEY.toPublic() });
    expect(payload).not.toHaveProperty('IsOrganizer');
    expect(payload).not.toHaveProperty('Permissions');
    expect(payload.CalendarEventContent[0].Data).toContain('STATUS:CONFIRMED');
    const back = await readBack(payload);
    expect(back.attendees).toContain('PARTSTAT=ACCEPTED');
  });

  it('turns a DURATION into the DTEND Proton stores', async () => {
    const payload = await Serialize.buildPayload(event({ duration: 'PT45M' }),
      { signingKey: ADDRESS_KEY, calendarPublicKey: CALENDAR_KEY.toPublic() });
    expect(payload.SharedEventContent[0].Data).toContain('DTEND;TZID=Europe/Berlin:20261120T104500');
  });

  it('shortens an over-long title to the API limit without splitting an emoji', async () => {
    const summary = 'a'.repeat(253) + '\u{1F600}' + 'tail';
    const payload = await Serialize.buildPayload(event({ summary }),
      { signingKey: ADDRESS_KEY, calendarPublicKey: CALENDAR_KEY.toPublic() });
    const back = await readBack(payload);
    const title = back.sharedEncrypted.match(/^SUMMARY:(.*)$/m)[1];
    expect(title.length).toBeLessThanOrEqual(255);
    expect(title.endsWith('…')).toBe(true);
    expect(title).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
  });

  it('refuses a linked copy without the invitation\'s token', async () => {
    await expect(Serialize.buildLinkedPayload(event(), {
      signingKey: ADDRESS_KEY, calendarPublicKey: CALENDAR_KEY.toPublic(), sharedEventId: 's',
      sessionKey: { data: SESSION_KEY, algorithm: 'aes256' }, self: { token: '', partstat: 'ACCEPTED' },
    })).rejects.toThrow('Missing data');
  });
});

describe('time zone names the API accepts', () => {
  const allowed = new Set(ALLOWED);
  it.each([
    ['W. Europe Standard Time', 'Europe/Berlin'],
    ['(UTC+01:00) Amsterdam, Berlin, Bern, Rome, Stockholm, Vienna', 'Europe/Berlin'],
    ['W. Europe Standard Time 1', 'Europe/Berlin'],          // Outlook's export suffix
    ['Eastern Standard Time', 'America/New_York'],
    ['FLE Standard Time', 'Europe/Kiev'],                    // Proton lists Kiev, not Kyiv
    ['Europe/Kyiv', 'Europe/Kiev'],
    ['Asia/Calcutta', 'Asia/Kolkata'],
    ['India Standard Time', 'Asia/Kolkata'],
    ['europe/berlin', 'Europe/Berlin'],
    ['/mozilla.org/20050126_1/Europe/Berlin', 'Europe/Berlin'],
    ['Etc/UTC', 'UTC'],
    ['UTC', 'UTC'],
    ['Europe/Berlin', 'Europe/Berlin'],
    // Valid IANA names the API does not list: a zone with the same rules.
    ['Asia/Singapore', 'Asia/Kuala_Lumpur'],
    ['US/Eastern', 'America/New_York'],
    ['Etc/Universal', 'UTC'],
  ])('%s -> %s', (tzid, want) => {
    expect(TZ.resolve(tzid, allowed)).toBe(want);
  });

  it('never turns an unknown zone into UTC because of its offset', () => {
    expect(TZ.resolve('(UTC+01:00) Somewhere Unknown', allowed)).toBeNull();
    expect(TZ.resolve('Customized Time Zone', allowed)).toBeNull();
    expect(TZ.resolve('', allowed)).toBeNull();
  });

  it('matches whole zone names only', () => {
    expect(TZ.resolve('Etc/GMT+10', new Set(['Etc/GMT+1']))).toBeNull();
    expect(TZ.resolve('/vendor/Europe/Berlinx', allowed)).toBeNull();
    expect(TZ.resolve('/citadel.org/20190914_1/Europe/Berlin', allowed)).toBe('Europe/Berlin');
  });

  it('works out an occurrence\'s time the way Proton stores RecurrenceID', () => {
    const at = (line) => TZ.unixTime(ICS.parseDateLine(line));
    // Measured: a copy saved with RECURRENCE-ID:20261112T090000Z has RecurrenceID 1794474000.
    expect(at('RECURRENCE-ID:20261112T090000Z')).toBe(1794474000);
    expect(at('RECURRENCE-ID;TZID=Europe/Berlin:20261120T100000')).toBe(Date.UTC(2026, 10, 20, 9) / 1000);
    expect(at('RECURRENCE-ID;TZID=Europe/Berlin:20260720T100000')).toBe(Date.UTC(2026, 6, 20, 8) / 1000);
    expect(at('RECURRENCE-ID;TZID=W. Europe Standard Time:20261120T100000')).toBe(Date.UTC(2026, 10, 20, 9) / 1000);
    expect(at('RECURRENCE-ID;TZID=America/New_York:20261101T013000')).toBe(Date.UTC(2026, 10, 1, 5, 30) / 1000);
    expect(at('RECURRENCE-ID;VALUE=DATE:20261120')).toBe(Date.UTC(2026, 10, 20) / 1000);
    // Floating, or a zone nobody knows: no time, so no guessing.
    expect(at('RECURRENCE-ID:20261120T100000')).toBeNull();
    expect(at('RECURRENCE-ID;TZID=Customized Time Zone:20261120T100000')).toBeNull();
    expect(at('')).toBeNull();
  });

  it('falls back to its own table when the list cannot be read', () => {
    expect(TZ.resolve('W. Europe Standard Time', null)).toBe('Europe/Berlin');
    expect(TZ.resolve('Europe/Paris', null)).toBe('Europe/Paris');
    expect(TZ.resolve('Customized Time Zone', null)).toBeNull();
  });

  it('has a zone for every name in its table, keyed the way it looks names up', () => {
    const table = new Function(read('background', 'calendar-tz-data.js') + '\nreturn ProtonCalendarTZData;')().windows;
    expect(Object.keys(table).length).toBeGreaterThan(200);
    for (const [k, zones] of Object.entries(table)) {
      expect(TZ._key(k)).toBe(k);
      expect(zones.length).toBeGreaterThan(0);
      for (const z of zones) expect(z).toMatch(/^([A-Z][A-Za-z_-]+(\/[A-Za-z0-9_+-]+)+|UTC)$/);
    }
  });
});

describe('ICS helpers', () => {
  const at = (over) => ({ year: 2026, month: 11, day: 20, hour: 23, minute: 30, second: 0, tzid: 'Europe/Berlin', isUTC: false, isAllDay: false, ...over });

  it('works out the end of a DURATION', () => {
    expect(ICS.formatDateTime(ICS.endFromDuration(at(), 'PT1H'))).toBe('20261121T003000');
    expect(ICS.endFromDuration(at(), 'PT1H').tzid).toBe('Europe/Berlin');
    expect(ICS.formatDateTime(ICS.endFromDuration(at(), 'P1W'))).toBe('20261127T233000');
    expect(ICS.formatDateTime(ICS.endFromDuration(at({ isAllDay: true, hour: 0, minute: 0 }), 'P1D'))).toBe('20261121');
    for (const bad of ['-PT1H', 'P', 'PT', 'P0D', 'one hour', '']) expect(ICS.endFromDuration(at(), bad)).toBeNull();
    // An all-day event lasts whole days.
    expect(ICS.endFromDuration(at({ isAllDay: true }), 'PT1H')).toBeNull();
  });

  it('cuts a UID the way Proton stores it', () => {
    const long = 'x'.repeat(100) + 'y'.repeat(191);
    expect(ICS.apiUid(long)).toBe('y'.repeat(191));
    expect(ICS.apiUid('short@example.org')).toBe('short@example.org');
  });

  it('folds long lines without splitting an emoji', () => {
    const line = 'SUMMARY:' + '\u{1F600}'.repeat(80);
    const folded = ICS.serializeProps([line]);
    for (const l of folded.split('\r\n')) expect(l).not.toMatch(/[\uD800-\uDBFF]$/);
    expect(folded.replace(/\r\n /g, '')).toContain(line);
  });
});

describe('the API calls', () => {
  function api(calendars, defaultId) {
    const calls = [];
    const ProtonAccounts = {
      request: async (accountId, method, path, opts) => {
        calls.push({ method, path, opts });
        if (path === 'calendar/v1') return { Calendars: calendars };
        if (path === 'settings/calendar') return { CalendarUserSettings: { DefaultCalendarID: defaultId } };
        if (path.endsWith('/events/sync')) return { Responses: [{ Response: { Code: 1000, Event: { ID: 'e1' } } }] };
        throw new Error('unexpected ' + path);
      },
    };
    const mod = new Function('ProtonAccounts', read('background', 'calendar-api.js') + '\nreturn ProtonCalendarAPI;')(ProtonAccounts);
    return { mod, calls };
  }
  const cal = (ID, { type = 0, owner = 'me@example.com', member = 'me@example.com', flags = 1, perms = 127, priority = 1 } = {}) =>
    ({ ID, Type: type, Owner: { Email: owner }, Members: [{ Email: member, Flags: flags, Permissions: perms, Priority: priority }] });

  it('saves an invitee copy without the import flag and keeps the import as it was', async () => {
    const { mod, calls } = api([]);
    await mod.createEvent('acc1', 'cal1', 'mem1', { IsOrganizer: 0, Permissions: 1, X: 1 }, { invitee: true });
    await mod.createEvent('acc1', 'cal1', 'mem1', { X: 1 });
    const [invitee, imported] = calls.map((c) => c.opts.data);
    expect(invitee).toEqual({ MemberID: 'mem1', Events: [{ Overwrite: 0, Event: { IsOrganizer: 0, Permissions: 1, X: 1 } }] });
    expect(imported).toEqual({ MemberID: 'mem1', IsImport: 1, Events: [{ Overwrite: 0, Event: { X: 1, Permissions: 3 } }] });
  });

  it('picks the calendar Proton picks for an invitation', async () => {
    const calendars = [
      cal('shared', { owner: 'friend@example.net', priority: 0 }),
      cal('subscribed', { type: 1, priority: 0 }),
      cal('disabled', { flags: 1 | 32, priority: 0 }),
      cal('readonly', { perms: 96, priority: 0 }),
      cal('first', { priority: 2 }),
      cal('mine-default', { priority: 5 }),
    ];
    expect(await api(calendars, 'mine-default').mod.invitationCalendarId('acc1')).toBe('mine-default');
    // A default that is not an active calendar of the user's own does not count.
    expect(await api(calendars, 'shared').mod.invitationCalendarId('acc1')).toBe('first');
    expect(await api(calendars, null).mod.invitationCalendarId('acc1')).toBe('first');
    expect(await api([cal('shared', { owner: 'friend@example.net' })], 'shared').mod.invitationCalendarId('acc1')).toBeNull();
  });
});

describe('the calendar lookups', () => {
  it('looks a long UID up by the part Proton stores', async () => {
    const seen = [];
    const fn = new Function('request', 'ProtonCalendarICS',
      lift(ACCOUNTS, 'getCalendarEventByUID') + '\nreturn getCalendarEventByUID;')(
      async (accountId, method, path, opts) => { seen.push(opts.params.UID); return { Events: [] }; }, ICS);
    await fn('acc1', 'z'.repeat(250));
    expect(seen).toEqual(['z'.repeat(191)]);
  });

  it('hands out the calendar\'s primary key first', async () => {
    const passphrase = 'calendar passphrase';
    const mk = async () => openpgp.encryptKey({
      privateKey: (await openpgp.generateKey({ type: 'ecc', curve: 'curve25519', userIDs: [{ email: 'c@example.com' }], format: 'object' })).privateKey,
      passphrase,
    });
    const [plain, primary] = [await mk(), await mk()];
    const bootstrap = {
      Passphrase: { MemberPassphrases: [{ Passphrase: await openpgp.encrypt({
        message: await openpgp.createMessage({ text: passphrase }), encryptionKeys: ADDRESS_KEY.toPublic() }) }] },
      Keys: [{ Flags: 1, PrivateKey: plain.armor() }, { Flags: 3, PrivateKey: primary.armor() }],
    };
    const fn = new Function('getAccount', 'request', 'openpgp', 'debugLog',
      lift(ACCOUNTS, '_getCalendarKeys') + '\nreturn _getCalendarKeys;')(
      () => ({ keysUnlocked: true, decryptedKeys: [ADDRESS_KEY] }), async () => bootstrap, openpgp, () => {});
    const keys = await fn('acc1', 'cal1');
    expect(keys.map((k) => k.getFingerprint())).toEqual([primary.getFingerprint(), plain.getFingerprint()]);
  });
});

// Lift a `name: async (...) => { ... }` member of an object literal (addToCalendar).
function liftArrowProp(src, name) {
  const at = src.indexOf(name + ': async (');
  if (at === -1) throw new Error('not found: ' + name);
  let i = src.indexOf('{', src.indexOf('=>', at));
  let depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) return 'const ' + name + ' = ' + src.slice(at + name.length + 2, i + 1) + ';'; }
  }
  throw new Error('unbalanced braces reading ' + name);
}

describe('the real lookup chain decides between "update", "save" and "leave alone"', () => {
  // getCalendarAttendees + _pickEventForScope + _updateCalendarAttendeeStatus as
  // they are, over a fake API: whether a copy may be saved hinges on 'notFound'.
  const BERLIN_10H = Date.UTC(2026, 10, 20, 9) / 1000; // 2026-11-20 10:00 Europe/Berlin
  function chain(events, { event = {}, myStatus = 0 } = {}) {
    const puts = [];
    const lookups = [];
    const deps = {
      getCalendarEventByUID: async (a, uid, opts) => { lookups.push(opts); if (events instanceof Error) throw events; return events; },
      getCalendarEvent: async (a, cal, id) => ({
        Attendees: [{ ID: 'att-' + id, Token: 'tok-me', Status: myStatus }],
        IsOrganizer: 0, Notifications: null, Color: null, ...event,
      }),
      _decryptAttendeeEmails: async () => ({ 'tok-me': 'me@example.com' }),
      ensureKeysUnlocked: async () => true,
      request: async (a, method, path, opts) => { puts.push({ path, data: opts && opts.data }); return {}; },
      ProtonDiag: { record() {} }, debugLog() {}, console: { warn() {} },
      ProtonCalendarTZ: TZ, ProtonCalendarICS: ICS, ProtonSenderAlias,
      _inviteQueue: new Map(),
    };
    const names = ['getCalendarAttendees', '_readCalendarAttendees', '_scopeMatch', '_diagUid', '_pickEventForScope',
      '_updateCalendarAttendeeStatus', '_attendeeTokenCandidates', '_sha1Hex', '_alarmsForAnswer'];
    const body = names.map((n) => lift(ACCOUNTS, n)).join('\n') + '\nreturn { ' + names.join(', ') + ' };';
    const fns = new Function(...Object.keys(deps), body)(...Object.values(deps));
    const update = (recurrenceId, partstat = 'ACCEPTED') =>
      fns._updateCalendarAttendeeStatus('acc1', 'uid-1', '', partstat, 'me@example.com', recurrenceId);
    return { update, puts, fns, queue: deps._inviteQueue, lookups };
  }

  it('reports "not found" only when no event has the UID', async () => {
    const c = chain([]);
    expect(await c.update('')).toBe('notFound');
    expect(c.puts).toHaveLength(0);
  });

  it('never turns a failed lookup into "not found" (that would save a duplicate)', async () => {
    const c = chain(new Error('503'));
    expect(await c.update('')).toBe('error');
    expect(c.puts).toHaveLength(0);
  });

  it('counts an answer for another occurrence, or the series, as not in the calendar when no series is there', async () => {
    // Only the standalone copy of occurrence A is stored: Proton's Mail app
    // then saves B, or the series, as for an invitation not in the calendar.
    const c = chain([{ ID: 'evA', CalendarID: 'cal1', RecurrenceID: BERLIN_10H }]);
    expect(await c.update('RECURRENCE-ID;TZID=Europe/Berlin:20261127T100000')).toBe('notFound');
    expect(await c.update('')).toBe('notFound');
    expect(c.puts).toHaveLength(0);
  });

  it('leaves an occurrence the series does not hold yet alone, and one whose time is unknown', async () => {
    const c = chain([{ ID: 'master', CalendarID: 'cal1', RecurrenceID: null, StartTimezone: 'Europe/Berlin' }]);
    expect(await c.update('RECURRENCE-ID;TZID=Europe/Berlin:20261127T100000')).toBe('skipped');
    const orphan = chain([{ ID: 'evA', CalendarID: 'cal1', RecurrenceID: BERLIN_10H }]);
    expect(await orphan.update('RECURRENCE-ID:20261120T100000')).toBe('skipped'); // floating, no stored zone
    expect(c.puts.concat(orphan.puts)).toHaveLength(0);
  });

  it('updates exactly the answered occurrence among several', async () => {
    const c = chain([
      { ID: 'master', CalendarID: 'cal1', RecurrenceID: null },
      { ID: 'evA', CalendarID: 'cal1', RecurrenceID: BERLIN_10H - 7 * 86400 },
      { ID: 'evB', CalendarID: 'cal1', RecurrenceID: BERLIN_10H },
    ]);
    expect(await c.update('RECURRENCE-ID;TZID=W. Europe Standard Time:20261120T100000')).toBe('updated');
    expect(c.puts.map((p) => p.path)).toEqual(['calendar/v1/cal1/events/evB/attendees/att-evB']);
  });

  it('reads a zone the browser cannot place in the zone Proton stored the event under', async () => {
    // Outlook's "Customized Time Zone": the stored StartTimezone places it.
    const c = chain([
      { ID: 'master', CalendarID: 'cal1', RecurrenceID: null, StartTimezone: 'Europe/Berlin' },
      { ID: 'evB', CalendarID: 'cal1', RecurrenceID: BERLIN_10H, StartTimezone: 'Europe/Berlin' },
    ]);
    expect(await c.update('RECURRENCE-ID;TZID=Customized Time Zone:20261120T100000')).toBe('updated');
    expect(c.puts[0].path).toContain('/events/evB/');
  });

  it('finds an all-day exception from the date-time RECURRENCE-ID Outlook writes', async () => {
    const c = chain([
      { ID: 'master', CalendarID: 'cal1', RecurrenceID: null, FullDay: 1 },
      { ID: 'evD', CalendarID: 'cal1', RecurrenceID: Date.UTC(2026, 10, 20) / 1000, FullDay: 1 },
    ]);
    expect(await c.update('RECURRENCE-ID;TZID=W. Europe Standard Time:20261120T000000')).toBe('updated');
    expect(c.puts[0].path).toContain('/events/evD/');
  });

  it('gives alarms back after a No turns into a Yes, and takes them away on a No, as Proton does', async () => {
    const personal = (c) => c.puts.filter((p) => p.path.endsWith('/personal'));
    const yesAfterNo = chain([{ ID: 'e1', CalendarID: 'cal1', RecurrenceID: null }], { myStatus: 2, event: { Notifications: [], Color: '#ff0000' } });
    expect(await yesAfterNo.update('', 'ACCEPTED')).toBe('updated');
    expect(personal(yesAfterNo)).toEqual([{ path: 'calendar/v1/cal1/events/e1/personal', data: { Notifications: null, Color: '#ff0000' } }]);
    const noAfterYes = chain([{ ID: 'e1', CalendarID: 'cal1', RecurrenceID: null }], { myStatus: 3, event: { Notifications: null } });
    await noAfterYes.update('', 'DECLINED');
    expect(personal(noAfterYes)).toEqual([{ path: 'calendar/v1/cal1/events/e1/personal', data: { Notifications: [], Color: null } }]);
    // Between Yes and Maybe, alarms of the user's own, or the user's own event: untouched.
    const maybeAfterYes = chain([{ ID: 'e1', CalendarID: 'cal1', RecurrenceID: null }], { myStatus: 3, event: { Notifications: [] } });
    await maybeAfterYes.update('', 'TENTATIVE');
    const ownAlarms = chain([{ ID: 'e1', CalendarID: 'cal1', RecurrenceID: null }], { myStatus: 2, event: { Notifications: [{ Type: 1, Trigger: '-PT15M' }] } });
    await ownAlarms.update('', 'ACCEPTED');
    const organizer = chain([{ ID: 'e1', CalendarID: 'cal1', RecurrenceID: null }], { myStatus: 3, event: { IsOrganizer: 1 } });
    await organizer.update('', 'DECLINED');
    expect([maybeAfterYes, ownAlarms, organizer].map((c) => personal(c).length)).toEqual([0, 0, 0]);
  });

  it('waits for an answer still on its way before it looks', async () => {
    const c = chain([]);
    let release;
    c.queue.set('acc1|uid-1', new Promise((r) => { release = r; }));
    let done = false;
    const look = c.fns.getCalendarAttendees('acc1', 'uid-1', '').then((r) => { done = true; return r; });
    await new Promise((r) => setTimeout(r, 20));
    expect(done).toBe(false);
    release();
    expect(await look).toEqual({ notFound: true });
  });
});

describe('the message from the card reaches the background whole', () => {
  it('forwards the invitation itself with the answer', () => {
    const BACKGROUND = read('background', 'background.js');
    const rsvp = BACKGROUND.slice(BACKGROUND.indexOf("case 'CALENDAR_RSVP':"), BACKGROUND.indexOf("case 'GET_CALENDAR_ATTENDEES':"));
    expect(rsvp).toMatch(/inviteIcs: typeof message\.inviteIcs === 'string' \? message\.inviteIcs : ''/);
  });
});

describe('"Add to Proton Calendar" with an Outlook time zone', () => {
  it('stores the event under a zone the API accepts', async () => {
    const created = [];
    const zoneDeps = { request: async (a, m, path) => {
      if (path === 'calendar/v1/timezones') return { Timezones: ALLOWED };
      if (path === 'calendar/v2/cal1/bootstrap') return { Members: [{ ID: 'mem1', Email: 'me@example.com' }] };
      throw new Error('unexpected ' + path);
    }, debugLog() {}, ProtonCalendarTZ: TZ, _allowedZones: null };
    const zoneFns = new Function(...Object.keys(zoneDeps),
      lift(ACCOUNTS, '_supportedZones') + lift(ACCOUNTS, '_withSupportedZones') + '\nreturn _withSupportedZones;')(...Object.values(zoneDeps));
    const account = { keysUnlocked: true, decryptedKeys: [ADDRESS_KEY], addressKeyMap: { 'me@example.com': ADDRESS_KEY } };
    const addToCalendar = new Function('ProtonCalendarICS', 'ensureKeysUnlocked', 'getAccount', 'request',
      '_findAddressIdForEmail', '_getCalendarKeys', 'ProtonCalendarSerialize', 'ProtonCalendarAPI', '_withSupportedZones',
      liftArrowProp(ACCOUNTS, 'addToCalendar') + '\nreturn addToCalendar;')(
      ICS, async () => true, () => account, zoneDeps.request, async () => 'a1', async () => [CALENDAR_KEY], Serialize,
      { createEvent: async (a, cal, mem, payload) => { created.push(payload); return { ID: 'e1' }; } }, zoneFns);
    const ics = ['BEGIN:VCALENDAR', 'METHOD:PUBLISH', 'BEGIN:VEVENT', 'UID:pub-1@example.org', 'DTSTAMP:20261101T090000Z',
      'DTSTART;TZID=W. Europe Standard Time:20261120T100000', 'DTEND;TZID=W. Europe Standard Time:20261120T110000',
      'SUMMARY:Booking', 'END:VEVENT', 'END:VCALENDAR'].join('\r\n');
    await addToCalendar('acc1', 'cal1', ics);
    expect(created[0].SharedEventContent[0].Data).toContain('DTSTART;TZID=Europe/Berlin:20261120T100000');
  });
});

describe('what an answer refuses to save (review 2)', () => {
  it('reads neither the card nor the copy from inside an alarm (Google\'s e-mail reminder)', async () => {
    // An ACTION:EMAIL alarm carries its own SUMMARY and ATTENDEE. Both parsers
    // skip it, so the card shows and the copy saves the event's own title.
    const world = makeWorld();
    const ics = externalInvite().replace('BEGIN:VALARM\r\nACTION:DISPLAY',
      'BEGIN:VALARM\r\nACTION:EMAIL\r\nSUMMARY:Alarm notification\r\nATTENDEE:mailto:organizer@example.org');
    const card = cardAnswer(ics, 'ACCEPTED').event;
    expect(card.summary).toBe('Quarterly review \u{1F4C8}');
    expect(card.attendees.map((a) => a.email)).not.toContain('organizer@example.org');
    expect((await answer(world, ics)).calendar).toBe('added');
    const back = await readBack(world.created[0].payload);
    expect(back.sharedEncrypted).toContain('SUMMARY:Quarterly review \u{1F4C8}');
    expect(back.attendees).not.toContain('mailto:organizer@example.org');
  });

  it('saves nothing the card did not show: a location it never displayed', async () => {
    const world = makeWorld();
    const result = await answer(world, externalInvite(), { shownLocation: 'Somewhere else' });
    expect(result.calendar).toBe('notAdded');
    expect(world.diag.find((d) => d.kind === 'check')).toMatchObject({ savable: 'mismatch' });
  });

  it.each([
    ['a second VEVENT opened with a parameter', (ics) => ics.replace('END:VCALENDAR', 'BEGIN;X-A=1:VEVENT\r\nUID:x\r\nEND:VEVENT\r\nEND:VCALENDAR')],
    ['a second VEVENT folded over two lines', (ics) => ics.replace('END:VCALENDAR', 'BEGIN:VEV\r\n ENT\r\nUID:x\r\nEND:VEVENT\r\nEND:VCALENDAR')],
  ])('counts %s', async (label, edit) => {
    const world = makeWorld();
    const result = await answer(world, edit(externalInvite()));
    expect(result.calendar).toBe('notAdded');
    expect(world.created).toHaveLength(0);
  });

  it.each([
    ['every second', 'RRULE:FREQ=SECONDLY;COUNT=100000000'],
    ['beyond Proton\'s count', 'RRULE:FREQ=WEEKLY;COUNT=1000'],
    ['beyond Proton\'s interval', 'RRULE:FREQ=YEARLY;INTERVAL=100'],
    ['until after 2037', 'RRULE:FREQ=DAILY;UNTIL=20400101T000000Z'],
  ])('refuses a recurrence Proton refuses (%s)', async (label, rrule) => {
    const world = makeWorld();
    expect((await answer(world, externalInvite({ extra: [rrule] }))).calendar).toBe('notAdded');
    expect(world.created).toHaveLength(0);
  });

  it('saves a recurrence Proton accepts', async () => {
    const world = makeWorld();
    expect((await answer(world, externalInvite({ extra: ['RRULE:FREQ=WEEKLY;COUNT=10;BYDAY=FR'] }))).calendar).toBe('added');
    expect(world.created[0].payload.SharedEventContent[0].Data).toContain('RRULE:FREQ=WEEKLY;COUNT=10;BYDAY=FR');
  });

  it('refuses one occurrence that comes with a recurrence of its own', async () => {
    const world = makeWorld();
    const ics = externalInvite({ extra: ['RRULE:FREQ=WEEKLY;COUNT=10', 'RECURRENCE-ID:20261120T100000Z'] });
    expect((await answer(world, ics)).calendar).toBe('notAdded');
  });

  it('places floating times in the invitation\'s own zone, and refuses them without one', async () => {
    const floating = externalInvite({ times: ['DTSTART:20261120T100000', 'DTEND:20261120T110000'] });
    const without = makeWorld();
    expect((await answer(without, floating)).calendar).toBe('notAdded');
    const withZone = makeWorld();
    const zoned = floating.replace('METHOD:REQUEST', 'METHOD:REQUEST\r\nX-WR-TIMEZONE:Europe/Berlin');
    expect((await answer(withZone, zoned)).calendar).toBe('added');
    expect(withZone.created[0].payload.SharedEventContent[0].Data).toContain('DTSTART;TZID=Europe/Berlin:20261120T100000');
  });

  it('refuses a UID with a bare CR in it', async () => {
    const world = makeWorld();
    const ics = externalInvite({ uid: 'cr-uid@example.org\rX-UID-INJECT:1' });
    expect((await answer(world, ics)).calendar).toBe('notAdded');
    expect(world.created).toHaveLength(0);
  });

  it('never saves an unlinked copy of a Proton invitation without its session key', async () => {
    const world = makeWorld();
    const ics = protonInvite().replace(/X-PM-SESSION-KEY:[^\r]*\r\n/, '');
    expect((await answer(world, ics, { uid: 'pm-invite-1@proton.me' })).calendar).toBe('notAdded');
    expect(world.created).toHaveLength(0);
  });
});

describe('a Proton Calendar invitation already in the calendar (review 2)', () => {
  it('answers through the server first and marks the reply with the same time, as Proton does', async () => {
    const world = makeWorld({ existing: [{ ID: 'ev1', CalendarID: 'cal1', SharedEventID: 'shared-evt-1' }], status: () => 'updated' });
    const result = await answer(world, protonInvite(), { uid: 'pm-invite-1@proton.me' });
    expect(result).toEqual({ success: true, calendar: 'updated' });
    expect(world.log).toEqual(['status', 'send']);
    const t = world.statusTimes[0];
    expect(typeof t).toBe('number');
    const stamp = new Date(t * 1000).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
    const lines = world.sent[0].split('\r\n');
    expect(lines.filter((l) => l.startsWith('DTSTAMP'))).toEqual(['DTSTAMP:' + stamp]);
    expect(lines).toContain('X-PM-PROTON-REPLY;VALUE=BOOLEAN:TRUE');
  });

  it('sends the plain reply first when its copy is not linked to the organizer\'s event', async () => {
    const world = makeWorld({ existing: [{ ID: 'ev1', CalendarID: 'cal1', SharedEventID: 'someone-else' }], status: () => 'updated' });
    await answer(world, protonInvite(), { uid: 'pm-invite-1@proton.me' });
    expect(world.log).toEqual(['send', 'status']);
    expect(world.sent[0]).toBe(world.lastReply);
  });
});

describe('a calendar that cannot be read after the reply (review 2)', () => {
  it('tries once more, never saves, and says so where the card promised the add', async () => {
    const world = makeWorld({ status: () => 'error' });
    const result = await answer(world, externalInvite(), { promisedAdd: true });
    expect(result).toEqual({ success: true, calendar: 'notAdded' });
    expect(world.log.filter((x) => x === 'status')).toHaveLength(2);
    expect(world.created).toHaveLength(0);
  });

  it('stays quiet where the card promised nothing', async () => {
    const world = makeWorld({ status: () => 'error' });
    expect(await answer(world, externalInvite(), { promisedAdd: false })).toEqual({ success: true });
  });
});

describe('the card asks whether answering can add it (review 2)', () => {
  const ask = (world, ics, over = {}) => {
    const card = cardAnswer(ics, 'ACCEPTED');
    return world.fns.canSaveInvitation('acc1', {
      eventUID: card.event.uid, recurrenceId: card.event.recurrenceIdRaw || '',
      attendeeEmail: 'me+team@example.com', inviteIcs: ics, ...over,
    });
  };
  it('says yes for an ordinary invitation, also with an Outlook zone', async () => {
    expect(await ask(makeWorld(), externalInvite())).toBe(true);
    expect(await ask(makeWorld(), externalInvite({ times: [
      'DTSTART;TZID=W. Europe Standard Time:20261120T100000', 'DTEND;TZID=W. Europe Standard Time:20261120T110000'] }))).toBe(true);
  });
  it.each([
    ['a series with changed occurrences', () => externalInvite({ vevents: 2 })],
    ['the user\'s own event', () => externalInvite({ organizer: 'me@example.com' })],
    ['a zone the API refuses', () => externalInvite({ times: [
      'DTSTART;TZID=Customized Time Zone:20261120T100000', 'DTEND;TZID=Customized Time Zone:20261120T110000'] })],
    ['a floating time without a zone', () => externalInvite({ times: ['DTSTART:20261120T100000', 'DTEND:20261120T110000'] })],
    ['no organizer', () => externalInvite().replace(/ORGANIZER[^\r]*\r\n/, '')],
    ['a Proton invitation without its session key', () => protonInvite().replace(/X-PM-SESSION-KEY:[^\r]*\r\n/, '')],
  ])('says no for %s', async (label, make) => {
    const ics = make();
    const uid = ICS.parse(ics) ? ICS.parse(ics).uid : 'x';
    expect(await ask(makeWorld(), ics, { eventUID: uid })).toBe(false);
  });
  it('says no for an address that is not invited', async () => {
    expect(await ask(makeWorld(), externalInvite(), { attendeeEmail: 'someone.else@example.com' })).toBe(false);
  });
});

describe('time zones from hostile or unusual mail (review 2)', () => {
  it('answers in linear time on a TZID padded with 100,000 spaces', () => {
    const tzid = 'Europe/Berlin' + ' '.repeat(100000) + 'x';
    const t0 = Date.now();
    expect(TZ.resolve(tzid, new Set(ALLOWED))).toBeNull();
    expect(TZ.unixTime({ year: 2026, month: 11, day: 20, hour: 10, minute: 0, second: 0, tzid, isUTC: false, isAllDay: false })).toBeNull();
    expect(Date.now() - t0).toBeLessThan(200);
  });

  it('does not reach Object.prototype through a TZID', () => {
    for (const tzid of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
      expect(TZ.resolve(tzid, new Set(ALLOWED))).toBeNull();
      expect(TZ.resolve(tzid, null)).toBeNull();
      expect(TZ.unixTime({ year: 2026, month: 11, day: 20, hour: 10, minute: 0, second: 0, tzid, isUTC: false, isAllDay: false })).toBeNull();
    }
  });

  it('places GMT, the POSIX US zones and vendor-prefixed names', () => {
    const at = (line) => TZ.unixTime(ICS.parseDateLine(line));
    const berlin = Date.UTC(2026, 10, 20, 9) / 1000;
    expect(at('RECURRENCE-ID;TZID=GMT:20261120T100000')).toBe(Date.UTC(2026, 10, 20, 10) / 1000);
    expect(at('RECURRENCE-ID;TZID=EST5EDT:20261120T100000')).toBe(Date.UTC(2026, 10, 20, 15) / 1000);
    expect(at('RECURRENCE-ID;TZID=/citadel.org/20190914_1/Europe/Berlin:20261120T100000')).toBe(berlin);
    expect(at('RECURRENCE-ID;TZID=/freeassociation.sourceforge.net/Europe/Berlin:20261120T100000')).toBe(berlin);
    expect(TZ.resolve('GMT', new Set(ALLOWED))).toBe('UTC');
    expect(TZ.resolve('EST5EDT', new Set(ALLOWED))).toBe('America/New_York');
  });

  it('keeps an IANA name as written when the list cannot be read', () => {
    // Without the list only the tables know the accepted spelling: the API
    // accepts Europe/Kiev, so it must not turn into Europe/Kyiv.
    expect(TZ.resolve('Europe/Kiev', null)).toBe('Europe/Kiev');
    expect(TZ.resolve('Europe/Kyiv', null)).toBe('Europe/Kiev');
  });

  it('reads skipped and repeated wall times the same way east and west of UTC (RFC 5545 3.3.5)', () => {
    const at = (line) => TZ.unixTime(ICS.parseDateLine(line));
    // Skipped: the offset from before the gap.
    expect(at('RECURRENCE-ID;TZID=Europe/Berlin:20270328T023000')).toBe(Date.UTC(2027, 2, 28, 1, 30) / 1000);
    expect(at('RECURRENCE-ID;TZID=America/New_York:20270314T023000')).toBe(Date.UTC(2027, 2, 14, 7, 30) / 1000);
    expect(at('RECURRENCE-ID;TZID=Australia/Sydney:20261004T023000')).toBe(Date.UTC(2026, 9, 3, 16, 30) / 1000); // +10 before the gap
    // Repeated: the first of the two.
    expect(at('RECURRENCE-ID;TZID=Europe/Berlin:20261025T023000')).toBe(Date.UTC(2026, 9, 25, 0, 30) / 1000);
    expect(at('RECURRENCE-ID;TZID=America/New_York:20261101T013000')).toBe(Date.UTC(2026, 10, 1, 5, 30) / 1000);
    expect(at('RECURRENCE-ID;TZID=Australia/Sydney:20270404T023000')).toBe(Date.UTC(2027, 3, 3, 15, 30) / 1000);
  });

  it('reads a wall time in a zone it is told', () => {
    const dt = ICS.parseDateLine('RECURRENCE-ID;TZID=Customized Time Zone:20261120T100000');
    expect(TZ.unixTime(dt)).toBeNull();
    expect(TZ.unixTime({ ...dt, tzid: null }, 'Europe/Berlin')).toBe(Date.UTC(2026, 10, 20, 9) / 1000);
  });
});

describe('the parsers and writers keep calendar lines intact (review 2)', () => {
  it('takes METHOD after the VEVENT, and the zone of floating times', () => {
    const ev = ICS.parse(['BEGIN:VCALENDAR', 'X-WR-TIMEZONE:Europe/Berlin', 'BEGIN:VEVENT', 'UID:u', 'DTSTART:20261120T100000',
      'END:VEVENT', 'METHOD:REQUEST', 'END:VCALENDAR'].join('\r\n'));
    expect(ev.method).toBe('REQUEST');
    expect(ev.calendarZone).toBe('Europe/Berlin');
    const vtz = ICS.parse(['BEGIN:VCALENDAR', 'BEGIN:VTIMEZONE', 'TZID:Europe/Paris', 'BEGIN:STANDARD', 'DTSTART:16010101T030000',
      'END:STANDARD', 'END:VTIMEZONE', 'BEGIN:VEVENT', 'UID:u', 'DTSTART:20261120T100000', 'END:VEVENT', 'END:VCALENDAR'].join('\r\n'));
    expect(vtz.calendarZone).toBe('Europe/Paris');
  });

  it('gives the event only the lines directly inside it', () => {
    const ev = ICS.parse(['BEGIN:VCALENDAR', 'BEGIN:VEVENT', 'UID:u', 'SUMMARY:Real', 'DTSTART:20261120T100000Z',
      'BEGIN:X-NESTED', 'SUMMARY:Fake', 'DTSTART:20991231T000000Z', 'END:X-NESTED', 'END:VEVENT', 'END:VCALENDAR'].join('\r\n'));
    expect(ev.summary).toBe('Real');
    expect(ICS.formatDateTime(ev.dtstart)).toBe('20261120T100000Z');
  });

  it('counts VEVENTs however BEGIN is written', () => {
    expect(ICS.countVevents('BEGIN:VEVENT\r\nEND:VEVENT')).toBe(1);
    expect(ICS.countVevents('BEGIN:VEVENT\r\nEND:VEVENT\r\nBEGIN;X-A=1:VEVENT\r\nEND:VEVENT')).toBe(2);
    expect(ICS.countVevents('BEGIN:VEV\r\n ENT\r\nEND:VEVENT\r\nbegin:vevent\r\nEND:VEVENT')).toBe(2);
  });

  it('writes no bare CR from the mail into a saved line or the reply', async () => {
    expect(ICS.escapeText('Hello\rX-INJECT:1')).toBe('Hello\\nX-INJECT:1');
    const payload = await Serialize.buildPayload({
      uid: 'u@example.org', summary: 'T', dtstart: { year: 2026, month: 11, day: 20, hour: 10, minute: 0, second: 0, isUTC: true },
      organizer: { email: 'organizer@example.org', cn: 'Org\rX-ORG-INJECT:1' },
      attendees: [{ email: 'me@example.com', cn: 'Me\rX-CN-INJECT:1' }],
    }, { signingKey: ADDRESS_KEY, calendarPublicKey: CALENDAR_KEY.toPublic(), invitation: true });
    const back = await readBack(payload);
    for (const part of [back.sharedSigned, back.attendees]) expect(part).not.toMatch(/\r(?!\n)/);
    const card = POPUP.parseICS(['BEGIN:VCALENDAR', 'METHOD:REQUEST', 'BEGIN:VEVENT', 'UID:u', 'SUMMARY:Hi\rX-SUMMARY-INJECT:1',
      'DTSTART:20261120T100000Z', 'ORGANIZER:mailto:organizer@example.org', 'ATTENDEE:mailto:me+team@example.com',
      'END:VEVENT', 'END:VCALENDAR'].join('\r\n'));
    expect(POPUP.buildRsvpICS(card, 'me+team@example.com', 'ACCEPTED')).not.toMatch(/\r(?!\n)/);
  });
});

describe('only the user\'s own calendars hold their copy (review 2)', () => {
  function lookup(calendarsAnswers, events) {
    const calls = [];
    const answers = calendarsAnswers.slice();
    const deps = {
      request: async (a, method, path, opts) => {
        calls.push({ path, params: opts && opts.params });
        if (path === 'calendar/v1/events') return { Events: events };
        if (path === 'calendar/v1') {
          const next = answers.shift();
          if (next instanceof Error) throw next;
          return { Calendars: next };
        }
        throw new Error('unexpected ' + path);
      },
      ProtonCalendarICS: ICS, _calendarsByAccount: new Map(),
    };
    const fns = new Function(...Object.keys(deps), lift(ACCOUNTS, '_ownCalendars') + lift(ACCOUNTS, 'getCalendarEventByUID')
      + '\nreturn getCalendarEventByUID;')(...Object.values(deps));
    return { find: () => fns('acc1', 'uid-1', { ownOnly: true }), findAll: () => fns('acc1', 'uid-1'), calls };
  }
  const cal = (ID, owner = 'me@example.com', Type = 0) => ({ ID, Type, Owner: { Email: owner }, Members: [{ Email: 'me@example.com' }] });

  it('leaves out a copy in a calendar shared with the user, and asks with CalendarType', async () => {
    const l = lookup([[cal('mine'), cal('shared', 'colleague@example.net')]],
      [{ ID: 'e1', CalendarID: 'shared' }, { ID: 'e2', CalendarID: 'mine' }]);
    expect((await l.find()).map((e) => e.ID)).toEqual(['e2']);
    expect(l.calls[0].params).toMatchObject({ CalendarType: 0 });
  });

  it('reads the calendars again for one it does not know yet', async () => {
    const l = lookup([[cal('mine')], [cal('mine'), cal('new')]], [{ ID: 'e3', CalendarID: 'new' }]);
    expect((await l.find()).map((e) => e.ID)).toEqual(['e3']);
  });

  it('keeps a shared calendar\'s copy for "Add to Proton Calendar", which can write there', async () => {
    const l = lookup([[cal('mine'), cal('shared', 'colleague@example.net')]], [{ ID: 'e1', CalendarID: 'shared' }]);
    expect((await l.findAll()).map((e) => e.ID)).toEqual(['e1']);
    expect(l.calls.some((c) => c.path === 'calendar/v1')).toBe(false);
  });

  it('counts every event when the calendars cannot be read', async () => {
    const l = lookup([new Error('503')], [{ ID: 'e1', CalendarID: 'shared' }]);
    expect((await l.find()).map((e) => e.ID)).toEqual(['e1']);
  });
});

describe('round 3: the answer never waits for itself', () => {
  it('runs the real answer flow over one queue without the 20 s wait', async () => {
    // getCalendarAttendees waits for an answer still on its way (the card's
    // lookups). The answer reads through _readCalendarAttendees: had it used
    // the waiting one, it would sit on its own queue entry until the 20 s timer.
    const delays = [];
    const timer = (fn, ms) => { delays.push(ms); return setTimeout(fn, 0); };
    const account = { id: 'acc1', keysUnlocked: true, decryptedKeys: [ADDRESS_KEY], addressKeyMap: { 'me@example.com': ADDRESS_KEY } };
    const puts = [];
    const deps = {
      setTimeout: timer,
      ensureKeysUnlocked: async () => true,
      getAccount: () => account,
      _resolveSenderInfo: async () => ({ fromAddr: { ID: 'a1', Email: 'me+team@example.com' }, senderPrivKey: ADDRESS_KEY,
        senderPubKey: ADDRESS_KEY, defaultAddr: { ID: 'a1' } }),
      _encryptAndSend: async () => {},
      getCalendarEventByUID: async () => [{ ID: 'ev1', CalendarID: 'cal1', RecurrenceID: null }],
      getCalendarEvent: async () => ({ Attendees: [{ ID: 'att1', Token: 'tok', Status: 0 }], IsOrganizer: 0, Notifications: null, Color: null }),
      _decryptAttendeeEmails: async () => ({ tok: 'me+team@example.com' }),
      request: async (a, method, path, opts) => { puts.push(path); return {}; },
      getAddresses: async () => [{ ID: 'a1', Email: 'me@example.com', CanAlias: true }],
      ProtonDiag: { record() {} }, debugLog() {}, console: { warn() {} },
      ProtonSenderAlias, ProtonCalendarICS: ICS, ProtonCalendarTZ: TZ, ProtonBinary,
      _inviteQueue: new Map(),
      CONTROL_CHAR: liftConst(ACCOUNTS, 'CONTROL_CHAR'), LINE_SEPARATORS: liftConst(ACCOUNTS, 'LINE_SEPARATORS'),
      RRULE_INTERVAL_MAX: liftConst(ACCOUNTS, 'RRULE_INTERVAL_MAX'), RRULE_COUNT_MAX: liftConst(ACCOUNTS, 'RRULE_COUNT_MAX'),
    };
    const names = ['sendCalendarRsvp', '_oneInviteAtATime', '_invitationToSave', '_matchesReply', '_protonInvitationKeys',
      '_supportedRrule', '_hasControl', '_updateCalendarAttendeeStatus', 'getCalendarAttendees', '_readCalendarAttendees',
      '_scopeMatch', '_pickEventForScope', '_diagUid', '_alarmsForAnswer', '_attendeeTokenCandidates', '_sha1Hex'];
    const body = names.map((n) => lift(ACCOUNTS, n)).join('\n') + '\nreturn { ' + names.join(', ') + ' };';
    const fns = new Function(...Object.keys(deps), body)(...Object.values(deps));
    const ics = externalInvite();
    const card = cardAnswer(ics, 'ACCEPTED');
    const result = await fns.sendCalendarRsvp('acc1', 'organizer@example.org', 'Accepted', '<div>yes</div>', card.reply,
      'me+team@example.com', { eventUID: card.event.uid, attendeeEmail: 'me+team@example.com', partstat: 'ACCEPTED',
        recurrenceId: '', inviteIcs: ics, shownLocation: card.event.location });
    expect(result).toEqual({ success: true, calendar: 'updated' });
    expect(delays).not.toContain(20000);
    expect(puts).toContain('calendar/v1/cal1/events/ev1/attendees/att1');
    // While an answer is on its way, the card's own lookup does wait for it.
    let release;
    deps._inviteQueue.set('acc1|' + card.event.uid, new Promise((r) => { release = r; }));
    const look = fns.getCalendarAttendees('acc1', card.event.uid, '');
    expect(delays).toContain(20000);
    release();
    await look;
  });
});

describe('round 3: what is decided for the answer\'s own scope', () => {
  it('links a Proton occurrence first although another occurrence\'s copy is there', async () => {
    const tA = Date.UTC(2026, 10, 13, 10) / 1000;
    const world = makeWorld({ existing: [{ ID: 'evA', CalendarID: 'cal1', RecurrenceID: tA, SharedEventID: 'shared-A' }] });
    const ics = protonInvite().replace('SEQUENCE:2', 'SEQUENCE:2\r\nRECURRENCE-ID:20261120T100000Z');
    const result = await answer(world, ics, { uid: 'pm-invite-1@proton.me' });
    expect(result).toEqual({ success: true, calendar: 'added' });
    expect(world.log.slice(0, 2)).toEqual(['create', 'send']);
    expect(world.sent[0]).toContain('X-PM-PROTON-REPLY;VALUE=BOOLEAN:TRUE');
  });

  it('refuses an attendee address with a bare CR, also a co-attendee\'s', async () => {
    const world = makeWorld();
    const ics = externalInvite().replace('mailto:co.invitee@example.net', 'mailto:co.invitee@example.net\rX-INJECTED-PROP:1');
    expect((await answer(world, ics)).calendar).toBe('notAdded');
    expect(world.created).toHaveLength(0);
  });

  it.each([
    ['a start after 2037', ['DTSTART:20400101T100000Z', 'DTEND:20400101T110000Z']],
    ['an all-day start with a timed end', ['DTSTART;VALUE=DATE:20261120', 'DTEND:20261120T110000Z']],
  ])('refuses %s, as Proton does', async (label, times) => {
    const world = makeWorld();
    expect((await answer(world, externalInvite({ times }))).calendar).toBe('notAdded');
  });

  it('asks the card\'s question with the card\'s own reply', async () => {
    const world = makeWorld();
    const ics = externalInvite();
    const card = cardAnswer(ics, 'ACCEPTED');
    const ask = (over) => world.fns.canSaveInvitation('acc1', { eventUID: card.event.uid, recurrenceId: '',
      attendeeEmail: 'me+team@example.com', inviteIcs: ics, replyIcs: card.reply, shownLocation: card.event.location, ...over });
    expect(await ask({})).toBe(true);
    expect(await ask({ replyIcs: card.reply.replace('SUMMARY:', 'SUMMARY:Other ') })).toBe(false);
    expect(await ask({ shownLocation: 'Elsewhere' })).toBe(false);
  });

  it.each([
    ['without the user\'s own token', (ics) => ics.replace(/;X-PM-TOKEN=[0-9a-f]{40}/, '')],
    ['with a session key of the wrong length', (ics) => ics.replace(/X-PM-SESSION-KEY:[^\r]*/, 'X-PM-SESSION-KEY:' + Buffer.from('short').toString('base64'))],
  ])('promises nothing for a Proton invitation %s', async (label, edit) => {
    const world = makeWorld();
    const ics = edit(protonInvite());
    expect(await world.fns.canSaveInvitation('acc1', { eventUID: 'pm-invite-1@proton.me', recurrenceId: '',
      attendeeEmail: 'me+team@example.com', inviteIcs: ics })).toBe(false);
  });

  it('keeps line breaks and key=value lookalikes out of the diagnostic log', async () => {
    const world = makeWorld();
    await answer(world, externalInvite({ uid: 'u\rauth=x y@example.org' }), { uid: 'u\rauth=x y@example.org' });
    for (const rec of world.diag) if (rec.uid !== undefined) expect(rec.uid).toMatch(/^[\x21-\x3c\x3e-\x7e]*$/);
  });
});

describe('round 3: time zones', () => {
  const allowed = new Set(ALLOWED);
  it('maps a vendor-prefixed name through its zone, with and without the list', () => {
    expect(TZ.resolve('/citadel.org/20190914_1/Europe/Kyiv', allowed)).toBe('Europe/Kiev');
    expect(TZ.resolve('/mozilla.org/20050126_1/US/Eastern', allowed)).toBe('America/New_York');
    expect(TZ.resolve('/mozilla.org/20050126_1/US/Eastern', null)).toBe('America/New_York');
    expect(TZ.resolve('/vendor.example/Not/Azone', null)).toBe('Not/Azone');
    expect(TZ.resolve('weird zone name', null)).toBeNull();
    expect(TZ.resolve('UTC', null)).toBe('UTC');
  });

  it('maps Windows names written without " Standard Time" (Lotus Notes)', () => {
    expect(TZ.resolve('W. Europe', allowed)).toBe('Europe/Berlin');
    expect(TZ.resolve('Eastern', allowed)).toBe('America/New_York');
  });

  it('gives both instants of a repeated wall time, and finds an exception stored at either', () => {
    const dt = ICS.parseDateLine('RECURRENCE-ID;TZID=America/New_York:20261101T013000');
    expect(TZ.unixTimes(dt)).toEqual([Date.UTC(2026, 10, 1, 5, 30) / 1000, Date.UTC(2026, 10, 1, 6, 30) / 1000]);
    expect(TZ.unixTime(dt)).toBe(Date.UTC(2026, 10, 1, 5, 30) / 1000);
    const pick = new Function(lift(ACCOUNTS, '_pickEventForScope') + '\nreturn _pickEventForScope;')();
    const later = { ID: 'later', RecurrenceID: Date.UTC(2026, 10, 1, 6, 30) / 1000 };
    expect(pick([{ ID: 'm', RecurrenceID: null }, later], true, TZ.unixTimes(dt)).ID).toBe('later');
  });

  it('takes the zone tzdata means for an alias, and the zone of its own country for a Windows name', () => {
    const table = new Function(read('background', 'calendar-tz-data.js') + '\nreturn ProtonCalendarTZData;')();
    expect(table.iana.Iceland[0]).toBe('Atlantic/Reykjavik');
    expect(table.iana.Singapore[0]).toBe('Asia/Kuala_Lumpur');
    expect(table.windows['singapore standard time'][0]).toBe('Asia/Kuala_Lumpur');
    expect(table.iana['US/East-Indiana'][0]).toBe(table.iana['America/Indiana/Indianapolis'][0]);
  });
});

describe('round 3: both parsers agree on where the event ends', () => {
  it.each([
    ['a parameter on END', 'END;X=1:VEVENT'],
    ['a space before the colon', 'END :VEVENT'],
  ])('with %s', (label, endLine) => {
    const ics = ['BEGIN:VCALENDAR', 'METHOD:REQUEST', 'BEGIN:VEVENT', 'UID:agree-1', 'SUMMARY:Shown',
      'DTSTART:20261120T100000Z', 'ORGANIZER:mailto:organizer@example.org', 'ATTENDEE:mailto:me+team@example.com',
      endLine, 'LOCATION:Saved but never shown', 'END:VEVENT', 'END:VCALENDAR'].join('\r\n');
    const card = POPUP.parseICS(ics);
    const saved = ICS.parse(ics);
    expect(card.location || '').toBe('');
    expect(saved.location || '').toBe('');
  });
});

describe('round 4: lookups use the calendars they are meant for', () => {
  it('reads only the user\'s own calendars for an answer, before and after the reply', async () => {
    const world = makeWorld();
    await answer(world, protonInvite(), { uid: 'pm-invite-1@proton.me' });
    expect(world.lookups.length).toBeGreaterThan(0);
    for (const opts of world.lookups) expect(opts).toEqual({ ownOnly: true });
    const c = (function () {
      const lookups = [];
      const deps = {
        getCalendarEventByUID: async (a, uid, opts) => { lookups.push(opts); return []; },
        ProtonDiag: { record() {} }, debugLog() {}, console: { warn() {} }, ProtonCalendarICS: ICS, ProtonCalendarTZ: TZ,
        _inviteQueue: new Map(),
      };
      const names = ['getCalendarAttendees', '_readCalendarAttendees', '_scopeMatch', '_pickEventForScope', '_diagUid'];
      const fns = new Function(...Object.keys(deps), names.map((n) => lift(ACCOUNTS, n)).join('\n') + '\nreturn { ' + names.join(', ') + ' };')(...Object.values(deps));
      return { fns, lookups };
    })();
    await c.fns.getCalendarAttendees('acc1', 'uid-1', '');
    expect(c.lookups).toEqual([{ ownOnly: true }]);
  });

  it('lets "Add to Proton Calendar" see a copy it could have written, never a read-only one', async () => {
    const seen = [];
    const find = new Function('getCalendarEventByUID', 'debugLog',
      'const o = { ' + (function () {
        const at = ACCOUNTS.indexOf('findCalendarEventByUID: async (');
        let i = ACCOUNTS.indexOf('{', ACCOUNTS.indexOf('=>', at));
        let depth = 0;
        for (; i < ACCOUNTS.length; i++) {
          if (ACCOUNTS[i] === '{') depth++;
          else if (ACCOUNTS[i] === '}') { depth--; if (depth === 0) break; }
        }
        return ACCOUNTS.slice(at, i + 1);
      })() + ' }; return o.findCalendarEventByUID;')(
      async (a, uid, opts) => { seen.push(opts); return [{ ID: 'e1', CalendarID: 'cal1' }]; }, () => {});
    expect(await find('acc1', 'uid-1')).toEqual({ exists: true, calendarId: 'cal1', eventId: 'e1' });
    expect(seen).toEqual([{ writable: true }]);
  });

  it('filters by write access for Add, by ownership for an answer', async () => {
    const deps = {
      request: async (a, method, path) => {
        if (path === 'calendar/v1/events') return { Events: [{ ID: 'e-ro', CalendarID: 'ro' }, { ID: 'e-rw', CalendarID: 'rw' }, { ID: 'e-mine', CalendarID: 'mine' }] };
        if (path === 'calendar/v1') return { Calendars: [
          { ID: 'ro', Type: 0, Owner: { Email: 'colleague@example.net' }, Members: [{ Email: 'me@example.com', Permissions: 96, Flags: 1 }] },
          { ID: 'rw', Type: 0, Owner: { Email: 'colleague@example.net' }, Members: [{ Email: 'me@example.com', Permissions: 112, Flags: 1 }] },
          { ID: 'mine', Type: 0, Owner: { Email: 'me@example.com' }, Members: [{ Email: 'me@example.com', Permissions: 127, Flags: 1 }] },
        ] };
        throw new Error('unexpected ' + path);
      },
      ProtonCalendarICS: ICS, _calendarsByAccount: new Map(),
    };
    const fns = new Function(...Object.keys(deps), lift(ACCOUNTS, '_ownCalendars') + lift(ACCOUNTS, 'getCalendarEventByUID')
      + '\nreturn { getCalendarEventByUID, _ownCalendars };')(...Object.values(deps));
    expect((await fns.getCalendarEventByUID('acc1', 'u', { writable: true })).map((e) => e.ID)).toEqual(['e-rw', 'e-mine']);
    expect((await fns.getCalendarEventByUID('acc1', 'u', { ownOnly: true })).map((e) => e.ID)).toEqual(['e-mine']);
    expect([...(await fns._ownCalendars('acc1')).usable]).toEqual(['mine']);
  });

  it('saves another part of a series into the calendar that holds the series', async () => {
    const world = makeWorld({ usable: ['cal1', 'calWork'],
      existing: [{ ID: 'evA', CalendarID: 'calWork', RecurrenceID: Date.UTC(2026, 10, 13, 10) / 1000 }] });
    const ics = externalInvite({ extra: ['RECURRENCE-ID:20261120T100000Z'] });
    expect((await answer(world, ics)).calendar).toBe('added');
    expect(world.created[0].calendarId).toBe('calWork');
    // Not one of the user's own, active calendars: the default calendar.
    const other = makeWorld({ usable: ['cal1'],
      existing: [{ ID: 'evA', CalendarID: 'calShared', RecurrenceID: Date.UTC(2026, 10, 13, 10) / 1000 }] });
    await answer(other, ics);
    expect(other.created[0].calendarId).toBe('cal1');
  });

  it('forwards the location the card showed, failing closed when it is missing', () => {
    const BACKGROUND = read('background', 'background.js');
    const rsvp = BACKGROUND.slice(BACKGROUND.indexOf("case 'CALENDAR_RSVP':"), BACKGROUND.indexOf("case 'CHECK_INVITE_SAVABLE':"));
    const check = BACKGROUND.slice(BACKGROUND.indexOf("case 'CHECK_INVITE_SAVABLE':"), BACKGROUND.indexOf("case 'GET_CALENDAR_ATTENDEES':"));
    for (const part of [rsvp, check]) expect(part).toMatch(/shownLocation: typeof message\.shownLocation === 'string' \? message\.shownLocation : ''/);
    expect(check).toMatch(/replyIcs: typeof message\.replyIcs === 'string' \? message\.replyIcs : ''/);
  });
});

describe('round 4: the parsers on unusual structure', () => {
  const wrap = (lines) => ['BEGIN:VCALENDAR', 'METHOD:REQUEST', 'BEGIN:VEVENT', 'UID:p4', 'DTSTART:20261120T100000Z',
    'ORGANIZER:mailto:organizer@example.org', 'ATTENDEE:mailto:me+team@example.com', ...lines, 'END:VEVENT', 'END:VCALENDAR'].join('\r\n');

  it('reads "Begin: 10:00 coffee" as text, not as a component', () => {
    const ics = wrap(['DESCRIPTION:Programme', 'Begin: 10:00 welcome and coffee', 'SUMMARY:Workshop']);
    expect(POPUP.parseICS(ics).summary).toBe('Workshop');
    expect(ICS.parse(ics).summary).toBe('Workshop');
  });

  it('never takes a VEVENT nested in the event for the event, in either parser', () => {
    const ics = wrap(['SUMMARY:Shown', 'LOCATION:Room 1', 'BEGIN:X-WRAP', 'BEGIN:VEVENT', 'SUMMARY:Hidden', 'LOCATION:Elsewhere',
      'DTSTART:20261121T100000Z', 'END:VEVENT', 'END:X-WRAP']);
    const card = POPUP.parseICS(ics);
    const saved = ICS.parse(ics);
    expect([card.summary, card.location]).toEqual(['Shown', 'Room 1']);
    expect([saved.summary, saved.location, ICS.formatDateTime(saved.dtstart)]).toEqual(['Shown', 'Room 1', '20261120T100000Z']);
    expect(ICS.countVevents(ics)).toBe(2); // so an answer never saves it
  });

  it('gives an untitled event its card, and answering it works', async () => {
    const ics = wrap(['BEGIN:VALARM', 'ACTION:EMAIL', 'SUMMARY:Alarm notification', 'ATTENDEE:mailto:organizer@example.org',
      'TRIGGER:-PT30M', 'END:VALARM']);
    const card = POPUP.parseICS(ics);
    expect(card).not.toBeNull();
    expect(card.summary).toBe('');
    const world = makeWorld();
    expect((await answer(world, ics)).calendar).toBe('added');
  });
});

describe('round 4: time zone names from more vendors', () => {
  const allowed = new Set(ALLOWED);
  it.each([
    ['/freeassociation.sourceforge.net/Tzfile/Europe/Berlin', 'Europe/Berlin'],
    ['/Europe/London/', 'Europe/London'],
    ['/GB/', 'Europe/London'],
    ['/tzurl.org/2021a/Eire', 'Europe/Dublin'],
    ['/mozilla.org/20050126_1/GB-Eire', 'Europe/London'],
  ])('%s -> %s, with and without the list', (tzid, want) => {
    expect(TZ.resolve(tzid, allowed)).toBe(want);
    expect(TZ.resolve(tzid, null)).toBe(want);
  });

  it('places Australia/ACT in Sydney, where tzdata puts it', () => {
    const table = new Function(read('background', 'calendar-tz-data.js') + '\nreturn ProtonCalendarTZData;')();
    expect(table.iana['Australia/ACT'][0]).toBe('Australia/Sydney');
  });
});

describe('attendee tokens as Proton makes them (Google live test, 2026-11-10)', () => {
  // Proton's clients hash each attendee's canonical address (they ask
  // core/v4/addresses/canonical first), and so does Proton's server when it
  // adds or updates an invitation by itself: measured, a dotted proton.me
  // guest was hashed without the dot, and the organizer's next update
  // replaced the row a copy had hashed from the address as written.
  const UID = 'ext-invite-1@example.org';
  const canonicalOf = (table) => (email) => ({
    Code: 1000, CanonicalEmail: table[email.toLowerCase()] || email.toLowerCase(),
  });

  it('hashes each attendee\'s canonical address, asked for in one encoded request', async () => {
    const world = makeWorld({ canonical: canonicalOf({ 'co.invitee@example.net': 'coinvitee@example.net' }) });
    await answer(world, externalInvite());
    const { payload } = world.created[0];
    expect(payload.Attendees.map((a) => a.Token)).toEqual([sha1(UID + 'me+team@example.com'), sha1(UID + 'coinvitee@example.net')]);
    expect(world.canonicalPaths).toHaveLength(1);
    // "+" encoded: sent raw, the server would read a space.
    expect(world.canonicalPaths[0]).toContain('Emails[]=me%2Bteam%40example.com');
    expect(world.canonicalPaths[0].slice(world.canonicalPaths[0].indexOf('?'))).not.toContain('+');
    // The encrypted lines keep the addresses as written, with the same tokens.
    const back = await readBack(payload);
    expect(back.attendees).toContain('X-PM-TOKEN=' + sha1(UID + 'coinvitee@example.net') + ':mailto:co.invitee@example.net');
    // Counts only in the diagnostics, never an address.
    expect(world.diag.find((d) => d.event === 'rsvp.import' && d.kind === 'copy')).toMatchObject({ ok: 'yes', canonical: '3/3' });
    expect(JSON.stringify(world.diag)).not.toMatch(/@example\./);
  });

  it('keeps one attendee for two spellings of one mailbox', async () => {
    const world = makeWorld({ canonical: canonicalOf({ 'co.invitee@example.net': 'coinvitee@example.net' }) });
    await answer(world, externalInvite({ extra: ['ATTENDEE;CN=Co Again;PARTSTAT=ACCEPTED:mailto:coinvitee@example.net'] }));
    const { payload } = world.created[0];
    // The first line wins: Co Invitee, tentative.
    expect(payload.Attendees).toEqual([
      { Token: sha1(UID + 'me+team@example.com'), Status: 3, Comment: null },
      { Token: sha1(UID + 'coinvitee@example.net'), Status: 1, Comment: null },
    ]);
    const back = await readBack(payload);
    expect(back.attendees.split('\r\n').filter((l) => l.startsWith('ATTENDEE'))).toHaveLength(2);
  });

  it('makes the tokens from the addresses as written when the lookup fails', async () => {
    const world = makeWorld({ canonical: new Error('Network error') });
    expect(await answer(world, externalInvite())).toEqual({ success: true, calendar: 'added' });
    expect(world.created[0].payload.Attendees.map((a) => a.Token))
      .toEqual([sha1(UID + 'me+team@example.com'), sha1(UID + 'co.invitee@example.net')]);
    expect(world.diag.find((d) => d.event === 'rsvp.import' && d.kind === 'copy')).toMatchObject({ ok: 'yes', canonical: '0/3' });
  });

  it('makes one token from the address as written when the lookup refuses that address', async () => {
    const world = makeWorld({
      canonical: (email) => (/co\.invitee/.test(email) ? { Code: 2050, Error: 'The email address is malformed' }
        : { Code: 1000, CanonicalEmail: email.toLowerCase() }),
    });
    await answer(world, externalInvite());
    expect(world.created[0].payload.Attendees[1].Token).toBe(sha1(UID + 'co.invitee@example.net'));
    expect(world.diag.find((d) => d.event === 'rsvp.import' && d.kind === 'copy')).toMatchObject({ canonical: '2/3' });
  });

  it('hashes one byte per UTF-16 unit, as Proton does', async () => {
    const world = makeWorld();
    await answer(world, externalInvite({ extra: ['ATTENDEE;CN=Jörg;PARTSTAT=NEEDS-ACTION:mailto:jörg@example.de'] }));
    const tokens = world.created[0].payload.Attendees.map((a) => a.Token);
    const oneBytePerChar = createHash('sha1').update(Buffer.from(UID + 'jörg@example.de', 'latin1')).digest('hex');
    expect(tokens).toContain(oneBytePerChar);
    expect(tokens).not.toContain(sha1(UID + 'jörg@example.de')); // its UTF-8 bytes
  });

  it('asks only for attendees without their own token, and never for an import', async () => {
    const asked = [];
    const canonicalEmails = async (emails) => { asked.push(...emails); return {}; };
    const base = {
      uid: UID, method: 'REQUEST', summary: 'S',
      dtstamp: { year: 2026, month: 11, day: 1, hour: 9, minute: 0, second: 0, isUTC: true },
      dtstart: { year: 2026, month: 11, day: 20, hour: 10, minute: 0, second: 0, isUTC: true },
      organizer: { email: 'organizer@example.org', cn: 'Org' },
      attendees: [{ email: 'me@example.com', partstat: 'ACCEPTED', pmToken: TOKEN_ME },
        { email: 'co@example.net', partstat: 'NEEDS-ACTION' }],
    };
    const keys = { signingKey: ADDRESS_KEY, calendarPublicKey: CALENDAR_KEY.toPublic(), canonicalEmails };
    const copy = await Serialize.buildPayload(base, { ...keys, invitation: true });
    expect(asked).toEqual(['co@example.net']);
    expect(copy.Attendees[0].Token).toBe(TOKEN_ME);
    asked.length = 0;
    await Serialize.buildPayload({ ...base, method: 'PUBLISH' }, keys);
    expect(asked).toEqual([]);
  });

  it('asks 100 addresses a request and maps each answer back to the address given', async () => {
    const world = makeWorld({ canonicalEcho: (email) => email.toLowerCase() });
    const list = Array.from({ length: 150 }, (_, i) => `Guest${i}@Example.net`);
    const map = await world.fns._canonicalEmails('acc1', [...list, ' ', '', list[0]]);
    expect(world.canonicalPaths).toHaveLength(2);
    expect(world.canonicalPaths[0].split('&')).toHaveLength(100);
    expect(Object.keys(map)).toHaveLength(150);
    expect(map['Guest7@Example.net']).toBe('guest7@example.net');
  });

  it('never takes an answer with a control character', async () => {
    const world = makeWorld({ canonical: () => ({ Code: 1000, CanonicalEmail: 'other@example.net\r\nATTENDEE:x' }) });
    expect(await world.fns._canonicalEmails('acc1', ['a@example.net'])).toEqual({});
  });

  // The user's own line wins a token collision (review of the token fix):
  // another spelling of their mailbox listed first, a line that brings
  // their token, or one whose bytes hash the same, never stands in for the
  // answer they gave.
  const withLineFirst = (line) => externalInvite()
    .replace('ATTENDEE;CN=Me;ROLE=REQ-PARTICIPANT', line + '\r\nATTENDEE;CN=Me;ROLE=REQ-PARTICIPANT');
  async function selfRow(world) {
    const { payload } = world.created[0];
    const back = await readBack(payload);
    const lines = back.attendees.split('\r\n').filter((l) => l.startsWith('ATTENDEE'));
    return { payload, lines };
  }

  it('keeps the user\'s answer when another spelling of their mailbox comes first', async () => {
    const world = makeWorld({ canonical: canonicalOf({ 'me+work@example.com': 'me@example.com', 'me+team@example.com': 'me@example.com' }) });
    await answer(world, withLineFirst('ATTENDEE;CN=Me Work;PARTSTAT=ACCEPTED:mailto:me+work@example.com'), { partstat: 'DECLINED' });
    const { payload, lines } = await selfRow(world);
    // One row for the mailbox, in the first line's place, with the answer given.
    expect(payload.Attendees).toEqual([
      { Token: sha1(UID + 'me@example.com'), Status: 2, Comment: null },
      { Token: sha1(UID + 'co.invitee@example.net'), Status: 1, Comment: null },
    ]);
    expect(payload.Notifications).toEqual([]);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/:mailto:me\+team@example\.com$/);
  });

  it('keeps the user\'s answer when the user\'s own line comes first', async () => {
    const world = makeWorld({ canonical: canonicalOf({ 'me+work@example.com': 'me@example.com', 'me+team@example.com': 'me@example.com' }) });
    await answer(world, externalInvite({ extra: ['ATTENDEE;CN=Me Work;PARTSTAT=ACCEPTED:mailto:me+work@example.com'] }),
      { partstat: 'DECLINED' });
    const { payload, lines } = await selfRow(world);
    expect(payload.Attendees[0]).toEqual({ Token: sha1(UID + 'me@example.com'), Status: 2, Comment: null });
    expect(payload.Attendees).toHaveLength(2);
    expect(lines.join('\n')).not.toContain('me+work');
  });

  it('never lets a line that brings the user\'s token stand in for their answer', async () => {
    const world = makeWorld();
    const forged = sha1(UID + 'me+team@example.com');
    await answer(world, withLineFirst('ATTENDEE;CN=Decoy;PARTSTAT=ACCEPTED;X-PM-TOKEN=' + forged + ':mailto:decoy@example.net'),
      { partstat: 'DECLINED' });
    const { payload, lines } = await selfRow(world);
    expect(payload.Attendees[0]).toEqual({ Token: forged, Status: 2, Comment: null });
    expect(payload.Attendees.filter((a) => a.Token === forged)).toHaveLength(1);
    expect(lines[0]).toMatch(/:mailto:me\+team@example\.com$/);
    expect(lines.join('\n')).not.toContain('decoy@example.net');
  });

  it('never lets a line whose bytes hash like the user\'s stand in for their answer', async () => {
    // U+016D has the low byte of "m": hashed one byte per unit, the two
    // addresses give one token, with or without the lookup.
    const world = makeWorld({ canonical: new Error('Network error') });
    await answer(world, withLineFirst('ATTENDEE;CN=Twin;PARTSTAT=ACCEPTED:mailto:ŭe+team@example.com'), { partstat: 'DECLINED' });
    const { payload, lines } = await selfRow(world);
    expect(payload.Attendees[0]).toEqual({ Token: sha1(UID + 'me+team@example.com'), Status: 2, Comment: null });
    expect(lines[0]).toMatch(/:mailto:me\+team@example\.com$/);
  });

  it('lists the user once when their own line is already in under another token', async () => {
    // Their first line brings a token of its own; a later line of theirs must
    // not take over a third line's row: one line per address, as Proton keeps it.
    const world = makeWorld({ canonical: canonicalOf({ 'me+work@example.com': 'me@example.com', 'me+team@example.com': 'me@example.com' }) });
    const ics = externalInvite()
      .replace('RSVP=TRUE:mailto:me+team@example.com', 'RSVP=TRUE;X-PM-TOKEN=' + sha1('own-token') + ':mailto:me+team@example.com')
      .replace('ATTENDEE;CN=Co Invitee', 'ATTENDEE;CN=Me Work;PARTSTAT=ACCEPTED:mailto:me+work@example.com\r\nATTENDEE;CN=Co Invitee');
    await answer(world, ics, { partstat: 'DECLINED' });
    const { payload, lines } = await selfRow(world);
    expect(lines.filter((l) => /:mailto:me\+team@example\.com$/i.test(l))).toHaveLength(1);
    expect(payload.Attendees[0]).toEqual({ Token: sha1('own-token'), Status: 2, Comment: null });
  });

  it('hashes a character beyond the BMP as its two UTF-16 units, as Proton does', async () => {
    const lowBytes = (s) => createHash('sha1').update(Uint8Array.from({ length: s.length }, (_, i) => s.charCodeAt(i) & 0xff)).digest('hex');
    const address = 'cal\u{1F4C5}@example.net';
    const payload = await Serialize.buildPayload({
      uid: UID, method: 'REQUEST', summary: 'S',
      dtstamp: { year: 2026, month: 11, day: 1, hour: 9, minute: 0, second: 0, isUTC: true },
      dtstart: { year: 2026, month: 11, day: 20, hour: 10, minute: 0, second: 0, isUTC: true },
      organizer: { email: 'organizer@example.org', cn: 'Org' },
      attendees: [{ email: address, partstat: 'NEEDS-ACTION' }],
    }, { signingKey: ADDRESS_KEY, calendarPublicKey: CALENDAR_KEY.toPublic(), invitation: true });
    expect(payload.Attendees[0].Token).toBe(lowBytes(UID + address));
    // And the lookup's own hashing (_attendeeTokenCandidates) agrees.
    const sha1Hex = new Function(lift(ACCOUNTS, '_sha1Hex') + '\nreturn _sha1Hex;')();
    expect(await sha1Hex(UID + address)).toBe(lowBytes(UID + address));
  });

  it('never takes the address from an answer that is an error', async () => {
    const world = makeWorld({ canonical: () => ({ Code: 2001, CanonicalEmail: 'other@example.net' }) });
    expect(await world.fns._canonicalEmails('acc1', ['a@example.net'])).toEqual({});
  });
});
