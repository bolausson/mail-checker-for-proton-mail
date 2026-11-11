/**
 * ICS parser → structured VEVENT, suitable for the calendar serializer.
 *
 * The popup-side parser in popup/calendar-utils.js is intentionally
 * thin (just enough to render the RSVP UI for METHOD:REQUEST invites).
 * Adding events to a calendar needs the full property set:
 *   - dtstart / dtend / duration with TZID + all-day handling
 *   - organizer, attendees with parameters (CN, ROLE, RSVP, PARTSTAT, etc.)
 *   - rrule, exdate, recurrence-id
 *   - description, location, summary
 *   - status, transp, sequence, dtstamp, uid
 *   - valarm components (VALARM blocks inside VEVENT)
 *   - method (PUBLISH / REQUEST / REPLY / CANCEL)
 *
 * Output shape mirrors a subset of Proton's VcalVeventComponent so the
 * serializer can consume it without further translation.
 */
const ProtonCalendarICS = (() => {
  // RFC 5545 line unfold: a single logical line may be split across
  // physical lines by CRLF + a leading space/tab. We undo that first.
  function _unfold(text) {
    return text.replace(/\r\n[ \t]/g, '').replace(/\n[ \t]/g, '');
  }

  // RFC 5545 escape sequences inside TEXT values. One pass, consuming the
  // backslash together with its escapee: chained replaces would re-read the
  // backslash an earlier rule just produced, so an escaped backslash followed
  // by the letter n would decode to a newline instead of "\" + "n" and get
  // written into the user's real calendar as a mangled SUMMARY/LOCATION.
  function _unescapeText(raw) {
    if (!raw) return raw;
    return String(raw).replace(/\\([nN,;\\])/g, (m, c) => (c === 'n' || c === 'N') ? '\n' : c);
  }

  // RFC 6868 caret escapes, which apply to PARAMETER values only (^n, ^' and
  // ^^). One left-to-right pass, for the same reason _unescapeText makes one:
  // chained replaces re-read what an earlier rule just produced, so "Caret^^n"
  // decodes to a stray newline in one order and a stray caret in the other.
  //
  // Unquoting happens BEFORE decoding, and needs BOTH quotes. Decoding can
  // produce a leading quote of its own (^'quoted^' decodes to "quoted"), so
  // unquoting afterwards would eat the user's own quote characters. Requiring
  // both is also why this is not the old /^"|"$/g, which stripped a leading or
  // a trailing quote independently and so threw away a real quote character
  // whenever only one side of the value had one.
  //
  // An unknown escape keeps BOTH characters, per RFC 6868 section 3 ("parsers
  // MUST leave both the ^ and the following character in place"), so Weird^x
  // stays Weird^x and a trailing lone ^ stays a caret.
  function _decodeParam(raw) {
    let s = String(raw == null ? '' : raw);
    if (s.length >= 2 && s[0] === '"' && s[s.length - 1] === '"') s = s.slice(1, -1);
    return s.replace(/\^(.)/gs, (m, c) => (c === 'n' ? '\n' : c === "'" ? '"' : c === '^' ? '^' : m));
  }

  // Split a property "NAME;PARAM=VAL;...:VALUE" into pieces.
  // Properties can contain quoted values (e.g. CN="Smith, John"), so we
  // tokenise carefully rather than splitting on raw ';' / ':'.
  function _parseProperty(line) {
    // A malformed quote in one parameter must not cost the user the whole
    // event. SUMMARY;X-FOO="unbalanced:Lunch has no unquoted colon, so the
    // line used to be dropped entirely and parse() returned an event with no
    // summary: "add to calendar" then failed on an invite the popup renders
    // fine. Fall back to the first colon of any kind instead.
    let colon = _findUnquoted(line, ':');
    if (colon < 0) colon = line.indexOf(':');
    if (colon < 0) return null;
    const head = line.slice(0, colon);
    const value = line.slice(colon + 1);

    const semi = _findUnquoted(head, ';');
    // .trim() so this parser accepts the same lines the popup one does: a
    // producer that writes "SUMMARY :Lunch" otherwise yields a name of
    // "SUMMARY " here, the property is skipped, and the invite the popup
    // renders fine fails "add to calendar" with no summary.
    const name = (semi < 0 ? head : head.slice(0, semi)).trim().toUpperCase();
    const paramsRaw = semi < 0 ? '' : head.slice(semi + 1);

    const params = {};
    if (paramsRaw) {
      for (const seg of _splitUnquoted(paramsRaw, ';')) {
        const eq = seg.indexOf('=');
        if (eq < 0) continue;
        const k = seg.slice(0, eq).toUpperCase();
        // Parameter values are decoded exactly once, here. Anything that
        // decodes them a second time doubles nothing but breaks A^^nB.
        params[k] = _decodeParam(seg.slice(eq + 1));
      }
    }
    return { name, params, value };
  }

  /** True when the quote at `i` actually opens a quoted section: either we are
   *  already inside one (so this closes it), or there is a matching quote
   *  later. An UNMATCHED quote is treated as data, because RFC 5545 forbids a
   *  DQUOTE inside a parameter value, so a lone one means the line is
   *  malformed, and honouring it would let one broken parameter swallow every
   *  parameter after it. Measured before this: ORGANIZER;X-NOQUOTE=a"b;CN=Real
   *  lost CN entirely. */
  function _quoteOpens(s, i, inQ) {
    return inQ || s.indexOf('"', i + 1) !== -1;
  }

  function _findUnquoted(s, ch) {
    let inQ = false;
    for (let i = 0; i < s.length; i++) {
      if (s[i] === '"' && _quoteOpens(s, i, inQ)) inQ = !inQ;
      else if (!inQ && s[i] === ch) return i;
    }
    return -1;
  }

  function _splitUnquoted(s, ch) {
    const out = [];
    let buf = '', inQ = false;
    // Indexed rather than for-of because _quoteOpens needs to look ahead. The
    // delimiters are ASCII, so walking code units splits identically.
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      if (c === '"' && _quoteOpens(s, i, inQ)) inQ = !inQ;
      if (!inQ && c === ch) { out.push(buf); buf = ''; }
      else buf += c;
    }
    if (buf) out.push(buf);
    return out;
  }

  // RFC 5545 date-time formats:
  //   20260704T142500Z   (UTC)
  //   20260704T142500    (floating / local, needs TZID param)
  //   20260704           (all-day, value type DATE)
  function _parseDateTime(value, params) {
    const isAllDay = params.VALUE === 'DATE' || /^\d{8}$/.test(value);
    const tz = params.TZID || null;
    const m = value.match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2}))?(Z?)$/);
    if (!m) return null;
    const [, y, mo, d, h, mi, s, z] = m;
    return {
      year: +y, month: +mo, day: +d,
      hour: h ? +h : 0, minute: mi ? +mi : 0, second: s ? +s : 0,
      tzid: tz,
      isUTC: z === 'Z',
      isAllDay,
      raw: value,
    };
  }

  function _parsePerson(value, params) {
    // Trimmed first, as the popup's parser does: " mailto:me@..." must not
    // keep its "mailto:" and miss every address comparison.
    const v = String(value).trim();
    const email = (v.match(/^mailto:([\s\S]+)$/i) || [])[1] || v;
    return {
      email: email.trim(),
      cn: params.CN || '',
      role: params.ROLE || '',
      partstat: params.PARTSTAT || 'NEEDS-ACTION',
      rsvp: params.RSVP === 'TRUE',
      pmToken: params['X-PM-TOKEN'] || '',
      raw: { value, params },
    };
  }

  // RRULE is a structured value: FREQ=WEEKLY;BYDAY=MO,WE;UNTIL=20260101
  function _parseRRule(value) {
    const out = {};
    for (const part of value.split(';')) {
      const eq = part.indexOf('=');
      if (eq < 0) continue;
      out[part.slice(0, eq).toUpperCase()] = part.slice(eq + 1);
    }
    return out;
  }

  // -------------------------------------------------------------
  // Top-level parser
  // -------------------------------------------------------------
  // A component name after BEGIN or END ("VEVENT", "X-FOO"); anything else
  // there is text, e.g. an unfolded description line "Begin: 10:00 coffee".
  const COMPONENT_NAME = /^[A-Za-z][A-Za-z0-9-]*$/;

  /**
   * Parse a raw ICS text into a structured VEVENT (or null if none).
   * Returns the first VEVENT found; ICS files with multiple events
   * are handled by the caller.
   */
  function parse(text) {
    if (typeof text !== 'string') return null;
    const lines = _unfold(text).split(/\r\n|\n/);

    let method = null;
    let calendarZone = null; // X-WR-TIMEZONE
    const vtimezoneIds = [];
    const stack = []; // components open outside the event
    let event = null;
    let eventDone = false;
    let depth = 0; // components open inside the event
    let alarm = null;

    for (const rawLine of lines) {
      if (!rawLine) continue;
      const prop = _parseProperty(rawLine);
      if (!prop) continue;
      const inEvent = !!event && !eventDone;

      // BEGIN and END read as properties (name trimmed, parameters allowed),
      // and only with a component name, as the popup's parser reads them:
      // the card and the saved copy must agree on where each component
      // starts and ends. Inside the event every component, whatever its
      // name, is one level down, as in the popup: a VEVENT nested there never
      // becomes the event, and only END:VEVENT at the event's own level ends it.
      if ((prop.name === 'BEGIN' || prop.name === 'END') && COMPONENT_NAME.test(prop.value.trim())) {
        const block = prop.value.trim().toUpperCase();
        if (prop.name === 'BEGIN') {
          if (inEvent) {
            depth++;
            if (depth === 1 && block === 'VALARM') alarm = {};
          } else if (block === 'VEVENT' && !event) {
            event = { attendees: [], valarms: [], extra: {} };
            depth = 0;
          } else {
            stack.push(block);
          }
        } else if (inEvent && depth > 0) {
          if (depth === 1 && alarm) {
            event.valarms.push(alarm);
            alarm = null;
          }
          depth--;
        } else if (inEvent && block === 'VEVENT') {
          // First VEVENT wins: calendar invites typically have a single event.
          // The lines after it are still read, for calendar-level properties.
          eventDone = true;
        } else {
          stack.pop();
        }
        continue;
      }

      // METHOD lives at calendar level, but some producers write it inside
      // the VEVENT or after it. Taken wherever it is, as the popup's parser
      // takes it: the card and an answer must agree on whether this is an
      // invitation.
      if (prop.name === 'METHOD') {
        method = prop.value.trim().toUpperCase();
        continue;
      }
      if (!inEvent) {
        // Where a floating time (no zone, no Z) belongs, as Proton's Mail app
        // decides it: the calendar's X-WR-TIMEZONE, else its only VTIMEZONE.
        const top = stack[stack.length - 1];
        if (top === 'VCALENDAR' && prop.name === 'X-WR-TIMEZONE' && !calendarZone) calendarZone = prop.value.trim();
        if (top === 'VTIMEZONE' && prop.name === 'TZID') vtimezoneIds.push(prop.value.trim());
        continue;
      }

      if (depth > 0) {
        // Inside a VALARM of the event; any other nested component is not the event's.
        if (alarm && depth === 1) {
          switch (prop.name) {
            case 'ACTION': alarm.action = prop.value; break;
            case 'TRIGGER': alarm.trigger = { value: prop.value, params: prop.params }; break;
            case 'DESCRIPTION': alarm.description = _unescapeText(prop.value); break;
            case 'SUMMARY': alarm.summary = _unescapeText(prop.value); break;
          }
        }
        continue;
      }

      switch (prop.name) {
        case 'UID': event.uid = prop.value.trim(); break;
        case 'DTSTAMP': event.dtstamp = _parseDateTime(prop.value, prop.params); break;
        case 'CREATED': event.created = _parseDateTime(prop.value, prop.params); break;
        case 'LAST-MODIFIED': event.lastModified = _parseDateTime(prop.value, prop.params); break;
        case 'DTSTART': event.dtstart = _parseDateTime(prop.value, prop.params); break;
        case 'DTEND': event.dtend = _parseDateTime(prop.value, prop.params); break;
        case 'DURATION': event.duration = prop.value; break;
        case 'SUMMARY': event.summary = _unescapeText(prop.value); break;
        case 'DESCRIPTION': event.description = _unescapeText(prop.value); break;
        case 'LOCATION': event.location = _unescapeText(prop.value); break;
        case 'STATUS': event.status = prop.value.trim().toUpperCase(); break;
        case 'TRANSP': event.transp = prop.value.trim().toUpperCase(); break;
        case 'SEQUENCE': event.sequence = parseInt(prop.value, 10) || 0; break;
        case 'CLASS': event.class = prop.value.trim().toUpperCase(); break;
        case 'ORGANIZER': event.organizer = _parsePerson(prop.value, prop.params); break;
        case 'ATTENDEE': event.attendees.push(_parsePerson(prop.value, prop.params)); break;
        case 'RRULE': event.rrule = { ...prop.params, ..._parseRRule(prop.value), raw: prop.value }; break;
        case 'EXDATE':
          event.exdates = event.exdates || [];
          for (const v of prop.value.split(',')) {
            const dt = _parseDateTime(v, prop.params);
            if (dt) event.exdates.push(dt);
          }
          break;
        case 'RECURRENCE-ID': event.recurrenceId = _parseDateTime(prop.value, prop.params); break;
        case 'CATEGORIES': event.categories = prop.value.split(',').map(_unescapeText); break;
        case 'URL': event.url = prop.value; break;
        default:
          // Preserve x- props so we don't lose vendor-specific metadata
          if (prop.name.startsWith('X-')) {
            event.extra[prop.name] = { value: prop.value, params: prop.params };
          }
      }
    }

    if (!event || !event.uid || !event.dtstart) return null;
    event.method = method || 'PUBLISH';
    event.calendarZone = calendarZone || (vtimezoneIds.length === 1 ? vtimezoneIds[0] : null);
    return event;
  }

  /** How many VEVENTs the text holds, counted the way properties are read
   *  (unfolded, name and value apart), so that neither a folded
   *  "BEGIN:VEV ENT" nor a parameter on BEGIN hides one. */
  function countVevents(text) {
    if (typeof text !== 'string') return 0;
    let n = 0;
    for (const line of _unfold(text).split(/\r\n|\n/)) {
      const prop = _parseProperty(line);
      if (prop && prop.name === 'BEGIN' && prop.value.trim().toUpperCase() === 'VEVENT') n++;
    }
    return n;
  }

  // Produce a canonical vcal-style serialization of a property set.
  // Used by the serializer to build the signed-clear and encrypted
  // parts: each part is a mini VCALENDAR > VEVENT containing only the
  // properties for that part-group.
  //
  // Output is folded to 75-octet lines per RFC 5545 §3.1.
  function serializeProps(propLines) {
    const out = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//Proton Mail Checker//NONSGML extension//EN',
      'BEGIN:VEVENT',
      ...propLines,
      'END:VEVENT',
      'END:VCALENDAR',
    ];
    return out.map(_fold).join('\r\n') + '\r\n';
  }

  function _fold(line) {
    if (line.length <= 75) return line;
    const chunks = [];
    let i = 0;
    while (i < line.length) {
      let end = Math.min(i + 75, line.length);
      // Never cut between the two halves of a surrogate pair: each half would
      // be encoded on its own as U+FFFD and an emoji in a long title or
      // description would reach the calendar as two replacement characters.
      if (end < line.length && /[\uD800-\uDBFF]/.test(line[end - 1])) end--;
      chunks.push(line.slice(i, end));
      i = end;
    }
    return chunks.join('\r\n ');
  }

  /**
   * The end of an event that gives a DURATION instead of a DTEND, as a date
   * object in the same form as dtstart (same zone, all-day flag). Weeks, days,
   * hours, minutes and seconds are added to the wall-clock time, which is
   * exact except for an event that spans a daylight-saving change in its own
   * zone. Returns null for anything that is not a positive duration, and for
   * an all-day start with a time part, which RFC 5545 does not allow.
   */
  function endFromDuration(start, duration) {
    if (!start || typeof duration !== 'string') return null;
    const m = duration.trim().toUpperCase()
      .match(/^(\+)?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/);
    if (!m) return null;
    const [, , w, d, h, mi, s] = m;
    if ([w, d, h, mi, s].every((x) => x === undefined)) return null;
    const days = (+w || 0) * 7 + (+d || 0);
    const secs = (+h || 0) * 3600 + (+mi || 0) * 60 + (+s || 0);
    if (!days && !secs) return null;
    if (start.isAllDay && secs) return null;
    const t = new Date(Date.UTC(start.year, start.month - 1, start.day + days,
      start.hour, start.minute, start.second + secs));
    return {
      ...start,
      year: t.getUTCFullYear(), month: t.getUTCMonth() + 1, day: t.getUTCDate(),
      hour: t.getUTCHours(), minute: t.getUTCMinutes(), second: t.getUTCSeconds(),
      raw: '',
    };
  }

  // Proton's API keeps at most the LAST 191 characters of a UID (its own
  // clients cut it the same way before saving and before every lookup), so an
  // event stored with a long UID can only be found again by the cut one.
  const API_UID_MAX = 191;
  function apiUid(uid) {
    const s = String(uid == null ? '' : uid);
    return s.length > API_UID_MAX ? s.slice(s.length - API_UID_MAX) : s;
  }

  function escapeText(s) {
    if (s == null) return '';
    return String(s)
      .replace(/\\/g, '\\\\')
      // A bare CR as well: some readers end a line there.
      .replace(/\r\n?|\n/g, '\\n')
      .replace(/,/g, '\\,')
      .replace(/;/g, '\\;');
  }

  // Formats a parsed date object back to ICS form, honouring all-day vs.
  // timed and the UTC ("Z") flag. This is NOT interchangeable with the date
  // formatters in popup/calendar-utils.js (always-UTC ICS REPLY stamps) or
  // options.js (local-time export filenames): each uses a different time
  // source, format, and input type, so they are intentionally separate.
  function formatDateTime(dt) {
    if (!dt) return '';
    const pad = (n) => String(n).padStart(2, '0');
    if (dt.isAllDay) {
      return `${dt.year}${pad(dt.month)}${pad(dt.day)}`;
    }
    const base = `${dt.year}${pad(dt.month)}${pad(dt.day)}T${pad(dt.hour)}${pad(dt.minute)}${pad(dt.second)}`;
    return dt.isUTC ? `${base}Z` : base;
  }

  // A parameter value written back: RFC 6868 caret escapes for ^, line
  // breaks and DQUOTE, and quoted when it holds , ; or :. A TZID comes from
  // the mail, and _decodeParam turned its ^n into a real line break: written
  // raw, it would start a new property line inside the saved event.
  function _paramValue(v) {
    const s = String(v)
      .replace(/\^/g, '^^')
      .replace(/\r?\n|\r/g, '^n')
      .replace(/"/g, "^'");
    return /[,;:]/.test(s) ? `"${s}"` : s;
  }

  function dateTimeLine(name, dt) {
    if (!dt) return null;
    const params = [];
    if (dt.isAllDay) params.push('VALUE=DATE');
    if (dt.tzid && !dt.isUTC) params.push(`TZID=${_paramValue(dt.tzid)}`);
    const paramStr = params.length ? ';' + params.join(';') : '';
    return `${name}${paramStr}:${formatDateTime(dt)}`;
  }

  /** One date property line ("RECURRENCE-ID;TZID=Europe/Berlin:20261120T100000",
   *  as the popup passes it) as a date object in parse()'s form, or null. */
  function parseDateLine(line) {
    const prop = _parseProperty(String(line == null ? '' : line).trim());
    return prop ? _parseDateTime(prop.value.trim(), prop.params) : null;
  }

  return {
    parse,
    serializeProps,
    escapeText,
    formatDateTime,
    dateTimeLine,
    parseDateLine,
    countVevents,
    endFromDuration,
    apiUid,
    unescapeText: _unescapeText,
  };
})();
