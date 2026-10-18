/**
 * Serialize a parsed VEVENT into the payload Proton's calendar API
 * expects for POST /calendar/v1/<calendarId>/events.
 *
 * Wire format (cross-checked against Proton's WebClients):
 *
 *   {
 *     SharedKeyPacket:    base64,   // shared session key wrapped with calendar pub key
 *     CalendarKeyPacket:  base64,   // calendar session key wrapped with calendar pub key (only when calendar-encrypted part is non-empty)
 *     SharedEventContent: [
 *       { Type: SIGNED,              Data: vcal-clear, Signature: armored },
 *       { Type: ENCRYPTED_AND_SIGNED, Data: base64-cipher, Signature: armored }
 *     ],
 *     CalendarEventContent: [
 *       { Type: SIGNED,              Data: vcal-clear, Signature: armored },
 *       { Type: ENCRYPTED_AND_SIGNED, Data: base64-cipher, Signature: armored }
 *     ],
 *     AttendeesEventContent: [{ Type: ENCRYPTED_AND_SIGNED, Data, Signature }],
 *     Attendees: [{ Token, Status, Comment }],
 *     Notifications: [{ Type, Trigger }] | null,
 *     Color: null,
 *     AddedProtonAttendees: [{ Email, AddressKeyPacket }],
 *     Permissions: 3,
 *     IsOrganizer: 0|1,
 *   }
 *
 * Field partition (matches Proton's SHARED_/CALENDAR_/ATTENDEES_ constants):
 *
 *   shared:    { signed:  [uid, dtstamp, dtstart, dtend, recurrence-id, rrule, exdate, organizer, sequence]
 *                encrypted: [uid, dtstamp, created, description, summary, location] }
 *   calendar:  { signed:  [uid, dtstamp, exdate, status, transp]
 *                encrypted: [uid, dtstamp, comment] }
 *   attendees: { encrypted: [uid, attendee] }
 *
 * uid + dtstamp appear in every part as binding metadata; the server
 * cross-validates they match across parts before accepting the event.
 */
const ProtonCalendarSerialize = (() => {
  // CALENDAR_CARD_TYPE constants from Proton's source
  // (packages/shared/lib/calendar/constants.ts).
  const CARD_TYPE = Object.freeze({
    CLEAR_TEXT: 0,
    ENCRYPTED: 1,
    SIGNED: 2,
    ENCRYPTED_AND_SIGNED: 3,
  });

  const ATTENDEE_STATUS = Object.freeze({
    NEEDS_ACTION: 0,
    TENTATIVE: 1,
    DECLINED: 2,
    ACCEPTED: 3,
  });

  // -------------------------------------------------------------
  // Attendee token: deterministic SHA-1(uid + normalized email).
  // -------------------------------------------------------------
  async function _attendeeToken(uid, email) {
    const normalized = String(email || '').trim().toLowerCase();
    const input = new TextEncoder().encode(uid + normalized);
    const buf = await crypto.subtle.digest('SHA-1', input);
    return ProtonBinary.bytesToHex(new Uint8Array(buf));
  }

  function _partstatToApi(partstat) {
    switch ((partstat || '').toUpperCase()) {
      case 'ACCEPTED': return ATTENDEE_STATUS.ACCEPTED;
      case 'TENTATIVE': return ATTENDEE_STATUS.TENTATIVE;
      case 'DECLINED': return ATTENDEE_STATUS.DECLINED;
      default: return ATTENDEE_STATUS.NEEDS_ACTION;
    }
  }

  // -------------------------------------------------------------
  // Build the four part-groups from a parsed VEVENT.
  // Each part-group has a `signed` (clear-but-signed) and an
  // `encrypted` (encrypted-and-signed) bucket. We emit each as a
  // mini VCALENDAR > VEVENT block containing only the properties
  // for that bucket.
  // -------------------------------------------------------------
  function _buildParts(event, attendeesWithTokens) {
    const uidLine = `UID:${ProtonCalendarICS.escapeText(event.uid)}`;
    const dtstampLine = ProtonCalendarICS.dateTimeLine('DTSTAMP', event.dtstamp || _nowDtstamp());

    // --- shared.signed: scheduling-relevant clear fields ---
    const sharedSignedLines = [uidLine, dtstampLine];
    if (event.dtstart) sharedSignedLines.push(ProtonCalendarICS.dateTimeLine('DTSTART', event.dtstart));
    if (event.dtend) sharedSignedLines.push(ProtonCalendarICS.dateTimeLine('DTEND', event.dtend));
    if (event.recurrenceId) sharedSignedLines.push(ProtonCalendarICS.dateTimeLine('RECURRENCE-ID', event.recurrenceId));
    if (event.rrule && event.rrule.raw) sharedSignedLines.push(`RRULE:${event.rrule.raw}`);
    if (event.exdates && event.exdates.length) {
      // EXDATE goes in shared.signed AND calendar.signed (Proton splits it that way).
      for (const ex of event.exdates) {
        const line = ProtonCalendarICS.dateTimeLine('EXDATE', ex);
        if (line) sharedSignedLines.push(line);
      }
    }
    if (event.organizer) sharedSignedLines.push(_organizerLine(event.organizer));
    if (typeof event.sequence === 'number') sharedSignedLines.push(`SEQUENCE:${event.sequence}`);

    // --- shared.encrypted: secret content the server must never see ---
    const sharedEncLines = [uidLine, dtstampLine];
    if (event.created) sharedEncLines.push(ProtonCalendarICS.dateTimeLine('CREATED', event.created));
    if (event.summary) sharedEncLines.push(`SUMMARY:${ProtonCalendarICS.escapeText(event.summary)}`);
    if (event.description) sharedEncLines.push(`DESCRIPTION:${ProtonCalendarICS.escapeText(event.description)}`);
    if (event.location) sharedEncLines.push(`LOCATION:${ProtonCalendarICS.escapeText(event.location)}`);

    // --- calendar.signed: per-calendar state that doesn't propagate to attendees ---
    const calSignedLines = [uidLine, dtstampLine];
    if (event.exdates && event.exdates.length) {
      for (const ex of event.exdates) {
        const line = ProtonCalendarICS.dateTimeLine('EXDATE', ex);
        if (line) calSignedLines.push(line);
      }
    }
    if (event.status) calSignedLines.push(`STATUS:${event.status}`);
    if (event.transp) calSignedLines.push(`TRANSP:${event.transp}`);

    // --- calendar.encrypted: empty unless we're storing a private comment ---
    const calEncLines = null; // intentionally null: we don't author comments yet

    // --- attendees.encrypted: ATTENDEE lines with x-pm-token wrapped in ---
    let attendeesEncLines = null;
    if (attendeesWithTokens && attendeesWithTokens.length) {
      attendeesEncLines = [uidLine];
      for (const a of attendeesWithTokens) {
        attendeesEncLines.push(_attendeeLine(a));
      }
    }

    return {
      sharedSigned: ProtonCalendarICS.serializeProps(sharedSignedLines),
      sharedEncrypted: ProtonCalendarICS.serializeProps(sharedEncLines),
      calendarSigned: ProtonCalendarICS.serializeProps(calSignedLines),
      calendarEncrypted: calEncLines ? ProtonCalendarICS.serializeProps(calEncLines) : null,
      attendeesEncrypted: attendeesEncLines ? ProtonCalendarICS.serializeProps(attendeesEncLines) : null,
    };
  }

  function _nowDtstamp() {
    const d = new Date();
    return {
      year: d.getUTCFullYear(),
      month: d.getUTCMonth() + 1,
      day: d.getUTCDate(),
      hour: d.getUTCHours(),
      minute: d.getUTCMinutes(),
      second: d.getUTCSeconds(),
      isUTC: true,
      isAllDay: false,
    };
  }

  function _organizerLine(org) {
    const params = [];
    if (org.cn) params.push(`CN=${_quoteParam(org.cn)}`);
    const paramStr = params.length ? ';' + params.join(';') : '';
    return `ORGANIZER${paramStr}:mailto:${org.email}`;
  }

  function _attendeeLine(a) {
    const params = [];
    if (a.cn) params.push(`CN=${_quoteParam(a.cn)}`);
    if (a.role) params.push(`ROLE=${a.role}`);
    if (a.rsvp) params.push(`RSVP=TRUE`);
    if (a.partstat) params.push(`PARTSTAT=${a.partstat}`);
    if (a.token) params.push(`X-PM-TOKEN=${a.token}`);
    const paramStr = params.length ? ';' + params.join(';') : '';
    return `ATTENDEE${paramStr}:mailto:${a.email}`;
  }

  function _quoteParam(v) {
    // RFC 5545 forbids DQUOTE inside parameter values; RFC 6868 defines
    // caret-encoding for it (plus ^ itself and newlines). Encoding instead
    // of stripping preserves names like O"Brien as O^'Brien.
    const s = String(v || '')
      .replace(/\^/g, '^^')
      .replace(/\r?\n/g, '^n')
      .replace(/"/g, "^'");
    return /[,;:]/.test(s) ? `"${s}"` : s;
  }

  // -------------------------------------------------------------
  // Crypto helpers wrapping openpgp.js.
  // -------------------------------------------------------------
  async function _signClear(text, signingKey) {
    const sig = await openpgp.sign({
      message: await openpgp.createMessage({ text }),
      signingKeys: signingKey,
      detached: true,
      format: 'armored',
    });
    return { data: text, signature: sig };
  }

  async function _signAndEncryptWithSessionKey(text, signingKey, sessionKey) {
    const enc = await openpgp.encrypt({
      message: await openpgp.createMessage({ text }),
      signingKeys: signingKey,
      sessionKey,
      format: 'binary',
    });
    const sig = await openpgp.sign({
      message: await openpgp.createMessage({ text }),
      signingKeys: signingKey,
      detached: true,
      format: 'armored',
    });
    return {
      dataPacket: ProtonBinary.uint8ToBase64(enc),
      signature: sig,
    };
  }

  async function _newSessionKey() {
    const sk = await openpgp.generateSessionKey({
      encryptionKeys: [],
      // openpgp.js needs encryptionKeys to derive the algorithm; pass
      // the standard AES-256 explicitly via config so we don't need a
      // recipient key at session-key minting time.
      config: { preferredSymmetricAlgorithm: openpgp.enums.symmetric.aes256 },
    });
    return sk;
  }

  // Fallback session-key minting when openpgp.generateSessionKey
  // rejects an empty encryptionKeys list (older builds). We mint a
  // 256-bit key locally and tag it as AES-256.
  function _localSessionKey() {
    const data = new Uint8Array(32);
    crypto.getRandomValues(data);
    return {
      data,
      algorithm: 'aes256',
    };
  }

  async function _wrapSessionKey(sessionKey, calendarPublicKey) {
    const wrapped = await openpgp.encryptSessionKey({
      data: sessionKey.data,
      algorithm: sessionKey.algorithm,
      encryptionKeys: calendarPublicKey,
      format: 'binary',
    });
    return ProtonBinary.uint8ToBase64(wrapped);
  }

  // -------------------------------------------------------------
  // Public entry point.
  // -------------------------------------------------------------
  /**
   * Build the full create-event payload.
   *
   * @param {object} event - Parsed VEVENT from ProtonCalendarICS.parse().
   * @param {object} ctx   - { signingKey: openpgp PrivateKey, calendarPublicKey: openpgp PublicKey, isOrganizer?: bool }
   * @returns {Promise<object>} - Payload ready for POST.
   */
  async function buildPayload(event, ctx) {
    if (!event) throw new Error('No event to serialize');
    if (!ctx || !ctx.signingKey || !ctx.calendarPublicKey) {
      throw new Error('Missing signing or calendar key');
    }

    // Tokenize attendees up front so the same tokens appear in the
    // encrypted ATTENDEE lines and the clear Attendees array.
    const attendeesWithTokens = [];
    if (event.attendees && event.attendees.length) {
      for (const a of event.attendees) {
        const token = await _attendeeToken(event.uid, a.email);
        attendeesWithTokens.push({ ...a, token });
      }
    }

    const parts = _buildParts(event, attendeesWithTokens);

    // Mint a shared session key (used to encrypt shared.encrypted
    // and attendees.encrypted parts) and, if needed, a calendar one.
    let sharedSK;
    try {
      sharedSK = await _newSessionKey();
    } catch (_) {
      sharedSK = _localSessionKey();
    }
    let calendarSK = null;
    if (parts.calendarEncrypted) {
      try { calendarSK = await _newSessionKey(); }
      catch (_) { calendarSK = _localSessionKey(); }
    }

    const [
      sharedSignedRes,
      sharedEncRes,
      calSignedRes,
      calEncRes,
      attendeesEncRes,
      sharedKeyPacket,
      calendarKeyPacket,
    ] = await Promise.all([
      _signClear(parts.sharedSigned, ctx.signingKey),
      _signAndEncryptWithSessionKey(parts.sharedEncrypted, ctx.signingKey, sharedSK),
      _signClear(parts.calendarSigned, ctx.signingKey),
      parts.calendarEncrypted
        ? _signAndEncryptWithSessionKey(parts.calendarEncrypted, ctx.signingKey, calendarSK)
        : null,
      parts.attendeesEncrypted
        ? _signAndEncryptWithSessionKey(parts.attendeesEncrypted, ctx.signingKey, sharedSK)
        : null,
      _wrapSessionKey(sharedSK, ctx.calendarPublicKey),
      calendarSK ? _wrapSessionKey(calendarSK, ctx.calendarPublicKey) : null,
    ]);

    const payload = {
      SharedKeyPacket: sharedKeyPacket,
      SharedEventContent: [
        { Type: CARD_TYPE.SIGNED, Data: sharedSignedRes.data, Signature: sharedSignedRes.signature },
        { Type: CARD_TYPE.ENCRYPTED_AND_SIGNED, Data: sharedEncRes.dataPacket, Signature: sharedEncRes.signature },
      ],
      CalendarEventContent: [
        { Type: CARD_TYPE.SIGNED, Data: calSignedRes.data, Signature: calSignedRes.signature },
      ],
      Notifications: null,
      Color: null,
    };

    if (calEncRes) {
      payload.CalendarKeyPacket = calendarKeyPacket;
      payload.CalendarEventContent.push({
        Type: CARD_TYPE.ENCRYPTED_AND_SIGNED,
        Data: calEncRes.dataPacket,
        Signature: calEncRes.signature,
      });
    }

    if (attendeesEncRes) {
      payload.AttendeesEventContent = [{
        Type: CARD_TYPE.ENCRYPTED_AND_SIGNED,
        Data: attendeesEncRes.dataPacket,
        Signature: attendeesEncRes.signature,
      }];
      payload.Attendees = attendeesWithTokens.map(a => ({
        Token: a.token,
        Status: _partstatToApi(a.partstat),
        Comment: null,
      }));
    }

    return payload;
  }

  return {
    CARD_TYPE,
    ATTENDEE_STATUS,
    buildPayload,
  };
})();
