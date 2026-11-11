/**
 * Serialize a parsed VEVENT into the event Proton's calendar API expects in
 * PUT /calendar/v1/<calendarId>/events/sync (wrapped by calendar-api.js).
 *
 * Wire format (cross-checked against Proton's WebClients):
 *
 *   {
 *     SharedKeyPacket:    base64,   // shared session key wrapped with the calendar's primary key
 *     CalendarKeyPacket:  base64,   // calendar session key, only with a calendar-encrypted part (never built here)
 *     SharedEventContent: [
 *       { Type: SIGNED,              Data: vcal-clear, Signature: armored },
 *       { Type: ENCRYPTED_AND_SIGNED, Data: base64-cipher, Signature: armored }
 *     ],
 *     CalendarEventContent: [{ Type: SIGNED, Data: vcal-clear, Signature: armored }],
 *     AttendeesEventContent: [{ Type: ENCRYPTED_AND_SIGNED, Data, Signature }],
 *     Attendees: [{ Token, Status, Comment }],
 *     Notifications: [{ Type, Trigger }] | null,   // null = the calendar's default alarms
 *     Color: null,
 *     IsOrganizer: 0,   // invitation copies only (see below)
 *     Permissions: 1,   // invitation copies only
 *   }
 *
 * Three shapes:
 *  - buildPayload(event, ctx): an event imported from an .ics (PUBLISH),
 *    the "Add to Proton Calendar" button.
 *  - buildPayload(event, { ...ctx, invitation: true }): the copy an invited
 *    user keeps of an invitation they answered, built the way Proton's Mail
 *    app builds it when the invitation is not in the calendar yet: the
 *    invitation's own DTSTAMP and SEQUENCE (so the invitation is not
 *    "outdated" when opened again), its X-PM-TOKENs kept and the other
 *    tokens made from the canonical addresses (ctx.canonicalEmails), the
 *    answer only in the clear Attendees status (never as PARTSTAT inside
 *    the encrypted attendee lines), no STATUS/TRANSP/CREATED from the
 *    invitation, IsOrganizer 0 and Permissions 1. The server stores an
 *    event without IsOrganizer as the user's own (measured), so the flag is
 *    required.
 *  - buildLinkedPayload(event, ctx): the copy of an invitation sent from
 *    Proton Calendar (it carries X-PM-SHARED-EVENT-ID and X-PM-SESSION-KEY).
 *    It links to the organizer's event instead of carrying its own content:
 *    the organizer's session key re-wrapped for this calendar, plus the
 *    user's own attendee entry. That is what keeps it in step with the
 *    organizer's later changes.
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

  // Proton's API limits (MAX_CHARS_API): longer values are refused, and
  // Proton's own clients shorten them before saving.
  const MAX_CHARS = Object.freeze({ TITLE: 255, DESCRIPTION: 3000, LOCATION: 255 });

  // A token as Proton writes it into its own invitations: hex SHA-1.
  const PM_TOKEN = /^[0-9a-f]{40}$/i;

  // -------------------------------------------------------------
  // Attendee token: SHA-1 of the UID followed by the attendee's address, as
  // Proton makes it: from the canonical address when it is known (Proton's
  // clients ask core/v4/addresses/canonical first, and its server hashes the
  // same form: measured, a dotted proton.me address was hashed without its
  // dots), else from the address in lower case. One byte per UTF-16 unit
  // (its low 8 bits), as Proton turns the string into bytes.
  // -------------------------------------------------------------
  async function _attendeeToken(uid, email, canonical) {
    const s = uid + (canonical || String(email || '').trim().toLowerCase());
    const input = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) input[i] = s.charCodeAt(i);
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

  /** Trim a text value and shorten it to the API limit the way Proton's
   *  clients do, with an ellipsis marking the cut. Never splits an emoji. */
  function _limit(value, max) {
    if (value == null) return value;
    const v = String(value).trim();
    if (v.length <= max) return v;
    let cut = max - 1;
    if (/[\uD800-\uDBFF]/.test(v[cut - 1])) cut--;
    return v.slice(0, cut) + '…';
  }

  // -------------------------------------------------------------
  // Build the part-groups from a parsed VEVENT.
  // Each part-group has a `signed` (clear-but-signed) and an
  // `encrypted` (encrypted-and-signed) bucket. We emit each as a
  // mini VCALENDAR > VEVENT block containing only the properties
  // for that bucket. A part that would hold nothing but UID and
  // DTSTAMP is null for an invitation copy, as Proton leaves it out.
  // -------------------------------------------------------------
  function _buildParts(event, attendeesWithTokens, opts) {
    const invitation = !!(opts && opts.invitation);
    const uidLine = `UID:${ProtonCalendarICS.escapeText(ProtonCalendarICS.apiUid(event.uid))}`;
    const dtstampLine = ProtonCalendarICS.dateTimeLine('DTSTAMP', event.dtstamp || _nowDtstamp());
    const dtend = event.dtend || ProtonCalendarICS.endFromDuration(event.dtstart, event.duration);

    // --- shared.signed: scheduling-relevant clear fields ---
    const sharedSignedLines = [uidLine, dtstampLine];
    if (event.dtstart) sharedSignedLines.push(ProtonCalendarICS.dateTimeLine('DTSTART', event.dtstart));
    if (dtend) sharedSignedLines.push(ProtonCalendarICS.dateTimeLine('DTEND', dtend));
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
    if (invitation) {
      // Always present on an invitation copy, as Proton saves it: the
      // "is this invitation outdated" check compares it.
      sharedSignedLines.push(`SEQUENCE:${Math.max(0, event.sequence || 0)}`);
    } else if (typeof event.sequence === 'number') {
      sharedSignedLines.push(`SEQUENCE:${event.sequence}`);
    }

    // --- shared.encrypted: secret content the server must never see ---
    const sharedEncLines = [uidLine, dtstampLine];
    if (event.created && !invitation) sharedEncLines.push(ProtonCalendarICS.dateTimeLine('CREATED', event.created));
    const summary = _limit(event.summary, MAX_CHARS.TITLE);
    const description = _limit(event.description, MAX_CHARS.DESCRIPTION);
    const location = _limit(event.location, MAX_CHARS.LOCATION);
    if (summary) sharedEncLines.push(`SUMMARY:${ProtonCalendarICS.escapeText(summary)}`);
    if (description) sharedEncLines.push(`DESCRIPTION:${ProtonCalendarICS.escapeText(description)}`);
    if (location) sharedEncLines.push(`LOCATION:${ProtonCalendarICS.escapeText(location)}`);

    // --- calendar.signed: per-calendar state that doesn't propagate to attendees ---
    const calSignedLines = [uidLine, dtstampLine];
    if (event.exdates && event.exdates.length) {
      for (const ex of event.exdates) {
        const line = ProtonCalendarICS.dateTimeLine('EXDATE', ex);
        if (line) calSignedLines.push(line);
      }
    }
    // An invitation's STATUS and TRANSP are the organizer's, not this
    // calendar's: Proton drops them when it saves an invitation.
    if (event.status && !invitation) calSignedLines.push(`STATUS:${event.status}`);
    if (event.transp && !invitation) calSignedLines.push(`TRANSP:${event.transp}`);

    // --- calendar.encrypted: empty unless we're storing a private comment ---
    const calEncLines = null; // intentionally null: we don't author comments yet

    // --- attendees.encrypted: ATTENDEE lines with x-pm-token wrapped in ---
    let attendeesEncLines = null;
    if (attendeesWithTokens && attendeesWithTokens.length) {
      attendeesEncLines = [uidLine];
      for (const a of attendeesWithTokens) {
        attendeesEncLines.push(_attendeeLine(a, { withPartstat: !invitation }));
      }
    }

    return {
      sharedSigned: ProtonCalendarICS.serializeProps(sharedSignedLines),
      sharedEncrypted: ProtonCalendarICS.serializeProps(sharedEncLines),
      calendarSigned: (invitation && calSignedLines.length <= 2)
        ? null
        : ProtonCalendarICS.serializeProps(calSignedLines),
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

  // An invitation copy keeps the answers out of the encrypted lines: Proton
  // stores them only in the clear Attendees status, where a later answer
  // updates them, and readers put PARTSTAT back from that status.
  // ROLE and PARTSTAT values are tokens (RFC 5545). They come from the mail,
  // already caret-decoded, so a ^n in one is a real line break: anything that
  // is not a plain token is left out instead of being written into the event.
  const PARAM_TOKEN = /^[A-Za-z0-9-]+$/;

  function _attendeeLine(a, opts) {
    const withPartstat = !opts || opts.withPartstat !== false;
    const params = [];
    if (a.cn) params.push(`CN=${_quoteParam(a.cn)}`);
    if (a.role && PARAM_TOKEN.test(a.role)) params.push(`ROLE=${a.role}`);
    if (a.rsvp) params.push(`RSVP=TRUE`);
    if (a.partstat && withPartstat && PARAM_TOKEN.test(a.partstat)) params.push(`PARTSTAT=${a.partstat}`);
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
      .replace(/\r\n?|\n/g, '^n') // a bare CR too: some readers end a line there
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
  // Public entry points.
  // -------------------------------------------------------------
  /**
   * Build the full create-event payload.
   *
   * @param {object} event - Parsed VEVENT from ProtonCalendarICS.parse(). For
   *   an invitation copy the caller has already written the user's answer
   *   into their own attendee's partstat.
   * @param {object} ctx - { signingKey: openpgp PrivateKey (the calendar
   *   member's address key), calendarPublicKey: openpgp PublicKey (the
   *   calendar's primary key), invitation?: bool, notifications?: null | [],
   *   canonicalEmails?: async (addresses) => { address: canonical } (an
   *   invitation's attendee tokens; a failure leaves the addresses as written) }
   * @returns {Promise<object>} - The Event object for events/sync.
   */
  async function buildPayload(event, ctx) {
    if (!event) throw new Error('No event to serialize');
    if (!ctx || !ctx.signingKey || !ctx.calendarPublicKey) {
      throw new Error('Missing signing or calendar key');
    }
    const invitation = !!ctx.invitation;
    const uid = ProtonCalendarICS.apiUid(event.uid);

    // Tokenize attendees up front so the same tokens appear in the
    // encrypted ATTENDEE lines and the clear Attendees array.
    // An invitation's own token is kept, as Proton keeps it: the
    // organizer's calendar knows the attendee by exactly that token.
    const keepsToken = (a) => invitation && PM_TOKEN.test(a.pmToken || '');
    // The other tokens of an invitation copy come from the canonical
    // addresses (ctx.canonicalEmails: address as written -> canonical), as
    // Proton's clients make them and its server writes them when it adds or
    // updates an invitation by itself. Without the lookup, or for an address
    // it refused, the token is made from the address itself.
    let canonical = {};
    if (invitation && typeof ctx.canonicalEmails === 'function') {
      const ask = [...new Set((event.attendees || []).filter((a) => !keepsToken(a))
        .map((a) => String(a.email || '').trim()).filter(Boolean))];
      if (ask.length) {
        try { canonical = (await ctx.canonicalEmails(ask)) || {}; } catch (_) { canonical = {}; }
      }
    }
    const attendeesWithTokens = [];
    const seenEmails = new Set();
    const atToken = new Map(); // token -> its entry's index in attendeesWithTokens
    for (const a of (event.attendees || [])) {
      const email = String(a.email || '').trim();
      const known = Object.prototype.hasOwnProperty.call(canonical, email) && typeof canonical[email] === 'string'
        ? canonical[email] : '';
      const token = keepsToken(a) ? a.pmToken : await _attendeeToken(uid, email, known);
      if (invitation) {
        // Proton refuses an attendee listed twice: one line per address and
        // per token (two spellings of one mailbox are one attendee). The
        // first line wins, except over the user's own line (isSelf, the one
        // carrying their answer), which takes that place: an earlier
        // spelling, or a line bringing the user's token, must not stand in
        // for the answer.
        const key = email.toLowerCase();
        if (!key) continue;
        const at = atToken.has(token) ? atToken.get(token) : -1;
        if (at !== -1 || seenEmails.has(key)) {
          // Not when the user is in already: an earlier line with their
          // address carries the answer too (every such line is marked).
          if (a.isSelf && at !== -1 && !attendeesWithTokens[at].isSelf && !seenEmails.has(key)) {
            attendeesWithTokens[at] = { ...a, token };
            seenEmails.add(key);
          }
          continue;
        }
        seenEmails.add(key);
        atToken.set(token, attendeesWithTokens.length);
      }
      attendeesWithTokens.push({ ...a, token });
    }

    const parts = _buildParts(event, attendeesWithTokens, { invitation });

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
      parts.calendarSigned ? _signClear(parts.calendarSigned, ctx.signingKey) : null,
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
      Notifications: ctx.notifications !== undefined ? ctx.notifications : null,
      Color: null,
    };

    if (calSignedRes) {
      payload.CalendarEventContent = [
        { Type: CARD_TYPE.SIGNED, Data: calSignedRes.data, Signature: calSignedRes.signature },
      ];
    }
    if (calEncRes) {
      payload.CalendarKeyPacket = calendarKeyPacket;
      payload.CalendarEventContent = payload.CalendarEventContent || [];
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

    if (invitation) {
      // An invited attendee's copy (see the header): never the organizer's
      // event, and the attendee permission Proton gives every copy it saves.
      payload.IsOrganizer = 0;
      payload.Permissions = 1;
    }

    return payload;
  }

  /**
   * The linked copy of an invitation sent from Proton Calendar.
   *
   * @param {object} event - Parsed VEVENT of the invitation.
   * @param {object} ctx - { signingKey, calendarPublicKey, sharedEventId,
   *   sessionKey: { data: Uint8Array, algorithm } (the organizer's key from
   *   X-PM-SESSION-KEY), self: { token, partstat }, notifications?: null | [] }
   * @returns {Promise<object>} - The Event object for events/sync.
   */
  async function buildLinkedPayload(event, ctx) {
    if (!event) throw new Error('No event to serialize');
    if (!ctx || !ctx.signingKey || !ctx.calendarPublicKey || !ctx.sessionKey
      || !ctx.sharedEventId || !ctx.self || !PM_TOKEN.test(ctx.self.token || '')) {
      throw new Error('Missing data for a linked invitation copy');
    }
    const parts = _buildParts(event, [], { invitation: true });
    const payload = {
      SharedEventID: ctx.sharedEventId,
      UID: ProtonCalendarICS.apiUid(event.uid),
      IsOrganizer: 0,
      SharedKeyPacket: await _wrapSessionKey(ctx.sessionKey, ctx.calendarPublicKey),
      // Only the user's own entry: the organizer's event holds everyone else.
      Attendees: [{ Token: ctx.self.token, Status: _partstatToApi(ctx.self.partstat), Comment: null }],
      Notifications: ctx.notifications !== undefined ? ctx.notifications : null,
      Color: null,
    };
    if (parts.calendarSigned) {
      const signed = await _signClear(parts.calendarSigned, ctx.signingKey);
      payload.CalendarEventContent = [{ Type: CARD_TYPE.SIGNED, Data: signed.data, Signature: signed.signature }];
    }
    return payload;
  }

  return {
    CARD_TYPE,
    ATTENDEE_STATUS,
    buildPayload,
    buildLinkedPayload,
  };
})();
