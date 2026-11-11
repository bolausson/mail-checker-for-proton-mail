/**
 * Calendar invite detection, rendering, and RSVP for the popup.
 *
 * Handles ICS parsing (RFC 5545), calendar invite UI rendering,
 * and RSVP button interactions (Accept/Tentative/Decline).
 *
 * Extracted from popup.js to reduce that file's size.
 * Dependencies are injected via function parameters to avoid
 * coupling to popup.js internals.
 */

const PopupCalendar = (() => {

  // -------------------------------------------------------------------
  // ICS property tokeniser.
  //
  // Copied from background/calendar-ics.js (_parseProperty / _findUnquoted /
  // _splitUnquoted). The popup loads no background scripts (popup/popup.html),
  // and _unescapeText below is already duplicated between the two files for
  // exactly that reason. THE TWO COPIES MUST STAY IN STEP: when they drift,
  // one click produces an invite CARD and a CALENDAR ENTRY that disagree about
  // the same invite.
  //
  // Why tokenise instead of scanning the raw line with regexes: RFC 5545 lets
  // a parameter value be quoted, and a quoted value may then contain ';' and
  // ':'. A /CN=([^;:]+)/ over the whole line reads CN="Doe; John" as "Doe" and
  // happily picks up a CN= that sits inside an EARLIER parameter
  // (DIR="ldap:///CN=Doe John,OU=Users"). Worse, a /mailto:…/ over the whole
  // line takes the FIRST mailto: in it, which can also come from an earlier
  // parameter (SENT-BY="mailto:pa@corp.example", a perfectly legal one) - and
  // that address is the one the RSVP gets sent to.
  // -------------------------------------------------------------------

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

  /**
   * Decode a PARAMETER value: strip the optional DQUOTEs, then undo the
   * RFC 6868 caret escapes (^n newline, ^' DQUOTE, ^^ caret).
   *
   * Without this the escapes survive parsing, _icsParamValue re-encodes them
   * on the way out, and the carets DOUBLE on every hop: an incoming
   * CN=O^'Brien becomes CN=O^^'Brien in our REPLY and CN=O^^^^'Brien on the
   * next one, and that doubled form is what lands in the user's real calendar.
   *
   * Three details, each of which breaks something if changed:
   *  - ONE left-to-right pass. Chained replaces get "Caret^^n" wrong in either
   *    order (^^ first yields a newline that was never sent; ^n first eats the
   *    caret the sender escaped).
   *  - Unquote BEFORE decoding. Decoding can PRODUCE a leading quote (^'x^'
   *    decodes to "x"), and unquoting afterwards would strip the sender's own
   *    quote characters.
   *  - An unknown escape keeps BOTH characters (RFC 6868 section 3: "leave
   *    both the ^ and the following character in place"), so Weird^x stays
   *    Weird^x and a trailing lone ^ stays ^.
   */
  function _decodeParam(raw) {
    let s = String(raw == null ? '' : raw);
    if (s.length >= 2 && s[0] === '"' && s[s.length - 1] === '"') s = s.slice(1, -1);
    return s.replace(/\^(.)/gs, (m, c) => (c === 'n' ? '\n' : c === "'" ? '"' : c === '^' ? '^' : m));
  }

  /** Split a property "NAME;PARAM=VAL;...:VALUE" into { name, params, value }. */
  function _parseProperty(line) {
    let colon = _findUnquoted(line, ':');
    // Fall back to a plain scan when the line has an UNBALANCED quote: there
    // is then no unquoted colon at all, and failing closed would DROP the
    // property. 'SUMMARY;X-FOO="unbalanced:Lunch' parses today, and losing
    // SUMMARY fails the required-field check below, i.e. the whole invite card
    // disappears over one stray quote.
    if (colon < 0) colon = line.indexOf(':');
    if (colon < 0) return null;
    const head = line.slice(0, colon);
    const value = line.slice(colon + 1);

    // The property NAME can never contain a quote, so the first ';' in the
    // head is always the real parameter separator. The .trim() keeps an
    // invite whose producer writes "SUMMARY :Lunch" rendering; the
    // background copy trims for the same reason, so the two stay in step.
    const semi = _findUnquoted(head, ';');
    const name = (semi < 0 ? head : head.slice(0, semi)).trim().toUpperCase();
    const paramsRaw = semi < 0 ? '' : head.slice(semi + 1);

    const params = {};
    if (paramsRaw) {
      for (const seg of _splitUnquoted(paramsRaw, ';')) {
        const eq = seg.indexOf('=');
        if (eq < 0) continue;
        params[seg.slice(0, eq).toUpperCase()] = _decodeParam(seg.slice(eq + 1));
      }
    }
    return { name, params, value };
  }

  /**
   * The address of an ORGANIZER / ATTENDEE, taken from the property VALUE (the
   * part after the first unquoted colon) and never from a scan of the line.
   * The value is normally "mailto:someone@example.com", but the prefix is not
   * guaranteed, so tolerate its absence.
   */
  function _personEmail(value) {
    const v = String(value || '').trim();
    return (((v.match(/^mailto:([\s\S]+)$/i) || [])[1]) || v).trim();
  }

  /**
   * Parse an ICS (iCalendar) text into a structured event object.
   *
   * @param {string} text - Raw ICS text (RFC 5545).
   * @returns {object|null} Parsed event or null if invalid/incomplete.
   */
  function parseICS(text) {
    // Unfold lines (RFC 5545: continuation lines start with space/tab)
    const unfolded = text.replace(/\r\n[ \t]/g, '').replace(/\n[ \t]/g, '');
    const lines = unfolded.split(/\r\n|\n/);

    // The first VEVENT is the event, as the background parser and Proton's
    // Mail app read a file (a series sent with its edited occurrences, or a
    // file of several events): the card must show, and answer, that one.
    let method = null, inEvent = false, nested = 0, firstDone = false;
    let uid = '', summary = '', location = '';
    let dtstartRaw = '', dtendRaw = '', dtstampRaw = '';
    let sequence = '', recurrenceIdRaw = '';
    // The series' rule as written (the first RRULE, as Proton keeps one), and
    // whether extra dates make it a series without one: for the card's line.
    let rrule = '', hasRdate = false;
    let organizerName = '', organizerEmail = '';
    const attendees = [];

    for (const line of lines) {
      // Split each content line into its property NAME, parameters and value.
      // RFC 5545 lets ANY property carry parameters between the name and the
      // ':', e.g. "SUMMARY;LANGUAGE=en-US:Title" (Microsoft/Outlook does this
      // for SUMMARY / LOCATION / DESCRIPTION). Match on the name, not "NAME:",
      // otherwise a parameterised SUMMARY is missed, the event fails the
      // required-field check below, and the invite silently falls back to a
      // plain attachment instead of rendering the RSVP card.
      const parsed = _parseProperty(line);
      if (!parsed) continue;
      const prop = parsed.name;
      const params = parsed.params;
      const value = parsed.value;

      if (prop === 'METHOD') method = value.trim();
      // Only the VEVENT's own lines are the event's. A component inside it
      // (VALARM: Google's e-mail reminder carries "SUMMARY:Alarm
      // notification" and an ATTENDEE) is skipped, as the background parser
      // skips it: the card must show, and answer, the event the answer saves.
      // BEGIN and END count only with a component name: an unfolded
      // description line such as "Begin: 10:00 coffee" is text.
      const boundary = (prop === 'BEGIN' || prop === 'END') && /^[A-Za-z][A-Za-z0-9-]*$/.test(value.trim());
      if (boundary && prop === 'BEGIN') {
        if (inEvent) nested++;
        else if (!firstDone && value.trim().toUpperCase() === 'VEVENT') { inEvent = true; nested = 0; }
        continue;
      }
      if (boundary && prop === 'END') {
        if (inEvent && nested > 0) nested--;
        else if (inEvent && value.trim().toUpperCase() === 'VEVENT') { inEvent = false; firstDone = true; }
        continue;
      }
      if (!inEvent || nested > 0) continue;

      if (prop === 'UID') uid = value.trim();
      else if (prop === 'SUMMARY') summary = value.trim();
      else if (prop === 'LOCATION') location = value.trim();
      else if (prop === 'DTSTART') dtstartRaw = line;
      else if (prop === 'DTEND') dtendRaw = line;
      else if (prop === 'DTSTAMP') dtstampRaw = line;
      // SEQUENCE + RECURRENCE-ID must be echoed in REPLY messages so the
      // organizer matches the RSVP to the right revision / right instance
      // of a recurring event (WebClients keeps both in propertiesToKeep).
      else if (prop === 'SEQUENCE') sequence = value.trim();
      else if (prop === 'RECURRENCE-ID') recurrenceIdRaw = line;
      else if (prop === 'RRULE') { if (!rrule) rrule = value.trim(); }
      else if (prop === 'RDATE') hasRdate = true;
      // The name comes from the PARSED CN parameter and the address from the
      // property VALUE. Both were regex scans of the whole line, so any
      // earlier parameter could supply either one: X-LABEL="CN=spoofed" won
      // the name, and SENT-BY="mailto:pa@corp.example" won the address the
      // RSVP is then sent to.
      else if (prop === 'ORGANIZER') {
        organizerName = params.CN || '';
        organizerEmail = _personEmail(value);
      } else if (prop === 'ATTENDEE') {
        attendees.push({
          name: params.CN || '',
          email: _personEmail(value),
          partstat: params.PARTSTAT || 'NEEDS-ACTION',
          pmToken: params['X-PM-TOKEN'] || '',
        });
      }
    }

    const m = method ? method.toUpperCase() : '';
    // An event without a title still gets its card ("(no title)", as in
    // Proton's own widget): it can be answered all the same.
    if (!m || !uid) return null;

    function parseICSDate(raw) {
      if (!raw) return { date: null, tz: null, rawProp: raw };
      const tzMatch = raw.match(/TZID=([^;:]+)/i);
      const tz = tzMatch ? tzMatch[1] : null;
      const valMatch = raw.match(/:(\d{8}T?\d{0,6}Z?)$/);
      if (!valMatch) return { date: null, tz, rawProp: raw };
      const v = valMatch[1];
      const y = +v.slice(0, 4), mo = +v.slice(4, 6) - 1, d = +v.slice(6, 8);
      const allDay = v.length === 8;
      const h = allDay ? 0 : +v.slice(9, 11), mn = allDay ? 0 : +v.slice(11, 13), s = allDay ? 0 : +v.slice(13, 15);
      const isUTC = v.endsWith('Z');
      const date = isUTC ? new Date(Date.UTC(y, mo, d, h, mn, s)) : new Date(y, mo, d, h, mn, s);
      return { date, tz, allDay, rawProp: raw };
    }

    const start = parseICSDate(dtstartRaw);
    const end = parseICSDate(dtendRaw);

    return {
      method, uid, summary, location,
      dtstart: start.date, dtend: end.date,
      timezone: start.tz, allDay: start.allDay,
      dtstartRaw, dtendRaw, dtstampRaw,
      sequence, recurrenceIdRaw, rrule, hasRdate,
      organizer: { name: organizerName || organizerEmail, email: organizerEmail },
      attendees,
    };
  }

  // RFC 5545 weekday codes in the order the card lists them (Monday first),
  // each with its Date#getDay() number.
  const RRULE_WEEKDAYS = [['MO', 1], ['TU', 2], ['WE', 3], ['TH', 4], ['FR', 5], ['SA', 6], ['SU', 0]];
  // "second Tuesday": a whole phrase per position and weekday, because in
  // many of the card's languages the ordinal agrees with the weekday.
  const RRULE_NTH_KEYS = { 1: 'recurNth1', 2: 'recurNth2', 3: 'recurNth3', 4: 'recurNth4', '-1': 'recurNthLast' };

  /** The locale Intl formats weekday and month names in: the UI language
   *  (Serbian is shown in Latin script, Intl's default for "sr" is Cyrillic). */
  function _intlLocale() {
    const lang = (ProtonI18n.getLanguage && ProtonI18n.getLanguage()) || 'en';
    return lang === 'sr' ? 'sr-Latn' : lang;
  }

  function _rruleParts(value) {
    const parts = {};
    for (const p of String(value || '').split(';')) {
      const i = p.indexOf('=');
      if (i > 0) parts[p.slice(0, i).trim().toUpperCase()] = p.slice(i + 1).trim().toUpperCase();
    }
    return parts;
  }

  function _rruleList(value) {
    return value ? value.split(',').map((x) => x.trim()).filter(Boolean) : [];
  }

  /** "Tuesday and Thursday" / "Mon, Tue, Wed, Thu and Fri", in the UI language. */
  function _weekdayNames(codes) {
    const loc = _intlLocale();
    const days = RRULE_WEEKDAYS.filter(([c]) => codes.includes(c));
    const opts = { weekday: days.length > 2 ? 'short' : 'long' };
    let fmt;
    try { fmt = new Intl.DateTimeFormat(loc, opts); } catch (_) { fmt = new Intl.DateTimeFormat(undefined, opts); }
    // 5 January 2026 was a Monday: 4 + getDay() is that week's day, Sunday the 11th.
    const names = days.map(([, js]) => fmt.format(new Date(2026, 0, 4 + (js === 0 ? 7 : js))));
    try {
      return new Intl.ListFormat(loc, { style: 'long', type: 'conjunction' }).format(names);
    } catch (_) {
      return names.join(', ');
    }
  }

  /** A zone Intl can format in, for an event's TZID: the name itself when
   *  Intl knows it, else the IANA zone it maps to (Outlook's Windows names,
   *  renamed zones: ProtonCalendarTZ), else null. */
  function _intlZone(tzid) {
    const name = String(tzid || '').trim().replace(/^"(.*)"$/, '$1');
    if (!name) return null;
    const known = (z) => { try { new Intl.DateTimeFormat('en', { timeZone: z }); return true; } catch (_) { return false; } };
    if (known(name)) return name;
    const mapped = typeof ProtonCalendarTZ !== 'undefined' ? ProtonCalendarTZ.resolve(name, null) : null;
    return mapped && known(mapped) ? mapped : null;
  }

  /** The last day of a series (RRULE UNTIL), read as Proton's widget reads
   *  it (getUntilDate): an all-day series or a date as written; a UTC time
   *  in the organizer's zone for a zoned start (Google and Proton write the
   *  end of the last day there, Outlook the start of the last occurrence),
   *  in UTC for a UTC start; a floating time as written. '' when it cannot
   *  be placed. */
  function _rruleUntilText(value, event) {
    const m = String(value || '').match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/);
    if (!m) return '';
    const [y, mo, d, h, mi, s] = [m[1], m[2], m[3], m[4] || 0, m[5] || 0, m[6] || 0].map(Number);
    const loc = _intlLocale();
    const format = (date, extra) => {
      const opts = { day: 'numeric', month: 'short', year: 'numeric', ...extra };
      try { return date.toLocaleDateString(loc, opts); } catch (_) { return date.toLocaleDateString(undefined, opts); }
    };
    const asWritten = new Date(y, mo - 1, d, h, mi, s);
    if (isNaN(asWritten) || asWritten.getMonth() !== mo - 1 || asWritten.getDate() !== d) return '';
    if (!m[4] || event.allDay || !m[7]) return format(asWritten);
    const instant = new Date(Date.UTC(y, mo - 1, d, h, mi, s));
    if (!event.timezone) return format(instant, { timeZone: 'UTC' });
    // A zone Intl cannot place: no end date rather than perhaps the wrong day.
    const zone = _intlZone(event.timezone);
    return zone ? format(instant, { timeZone: zone }) : '';
  }

  /** What a rule repeats on: '' when its frequency says it all, null when it
   *  is beyond what the card describes (shown as "custom rule"). */
  function _recurrenceDetail(freq, r, start) {
    if (['BYYEARDAY', 'BYWEEKNO', 'BYHOUR', 'BYMINUTE', 'BYSECOND'].some((k) => r[k] !== undefined)) return null;
    const days = [];
    for (const d of _rruleList(r.BYDAY)) {
      const m = d.match(/^([+-]?\d{1,2})?(MO|TU|WE|TH|FR|SA|SU)$/);
      if (!m) return null;
      days.push({ n: m[1] ? parseInt(m[1], 10) : 0, code: m[2] });
    }
    const monthDays = _rruleList(r.BYMONTHDAY);
    const months = _rruleList(r.BYMONTH);
    const setPos = _rruleList(r.BYSETPOS);
    if (freq === 'DAILY' || freq === 'WEEKLY') {
      if (monthDays.length || months.length || setPos.length || days.some((d) => d.n)) return null;
      const codes = days.length ? days.map((d) => d.code)
        : (freq === 'WEEKLY' && start ? [RRULE_WEEKDAYS.find(([, js]) => js === start.getDay())[0]] : []);
      return codes.length ? _weekdayNames(codes) : '';
    }
    if (freq === 'MONTHLY') {
      if (months.length) return null;
      if (days.length) {
        // One weekday, at one position: 2TU, -1FR, or TU with BYSETPOS=2.
        if (days.length > 1 || monthDays.length || setPos.length > 1 || (days[0].n && setPos.length)) return null;
        const key = RRULE_NTH_KEYS[days[0].n || (setPos.length ? parseInt(setPos[0], 10) : 0)];
        return key ? ProtonI18n.t(key + days[0].code[0] + days[0].code[1].toLowerCase()) : null;
      }
      if (setPos.length || monthDays.length > 1) return null;
      const day = monthDays.length ? parseInt(monthDays[0], 10) : (start ? start.getDate() : NaN);
      if (day === -1) return ProtonI18n.t('recurLastMonthDay');
      return day >= 1 && day <= 31 ? ProtonI18n.t('recurMonthDay', day) : null;
    }
    if (freq === 'YEARLY') {
      // A day of the month without a month repeats in every month (RFC 5545).
      if (days.length || setPos.length || monthDays.length > 1 || months.length > 1
        || (monthDays.length && !months.length)) return null;
      const month = months.length ? parseInt(months[0], 10) : (start ? start.getMonth() + 1 : NaN);
      const day = monthDays.length ? parseInt(monthDays[0], 10) : (start ? start.getDate() : NaN);
      if (!(month >= 1 && month <= 12 && day >= 1 && day <= 31)) return null;
      // 2000 was a leap year: 29 February is a date.
      const date = new Date(2000, month - 1, day);
      if (date.getMonth() !== month - 1) return null;
      try {
        return date.toLocaleDateString(_intlLocale(), { day: 'numeric', month: 'long' });
      } catch (_) {
        return date.toLocaleDateString(undefined, { day: 'numeric', month: 'long' });
      }
    }
    return null;
  }

  /**
   * How an invitation repeats, for the card's line: "Weekly: Tuesday,
   * 3 times", "Monthly: second Tuesday, until 29 Dec 2026", "One occurrence
   * of a recurring event". '' for an event that does not repeat. Proton's
   * own widget shows the same: a rule it cannot put into words is a
   * "custom" one, never a guess.
   *
   * @param {object} event - Parsed event from parseICS().
   * @returns {string}
   */
  function describeRecurrence(event) {
    if (!event) return '';
    // One occurrence of a series: the answer is for that one only.
    if (event.recurrenceIdRaw) return ProtonI18n.t('recurOccurrence');
    if (!event.rrule) return event.hasRdate ? ProtonI18n.t('recurRepeats') : '';
    const r = _rruleParts(event.rrule);
    const interval = /^\d+$/.test(r.INTERVAL || '') ? Math.max(1, parseInt(r.INTERVAL, 10)) : 1;
    const base = {
      DAILY: interval > 1 ? ProtonI18n.plural('recurEveryDays', interval) : ProtonI18n.t('recurDaily'),
      WEEKLY: interval > 1 ? ProtonI18n.plural('recurEveryWeeks', interval) : ProtonI18n.t('recurWeekly'),
      MONTHLY: interval > 1 ? ProtonI18n.plural('recurEveryMonths', interval) : ProtonI18n.t('recurMonthly'),
      YEARLY: interval > 1 ? ProtonI18n.plural('recurEveryYears', interval) : ProtonI18n.t('recurYearly'),
    }[r.FREQ];
    // Hourly and finer, or no frequency at all: a series all the same.
    if (!base) return ProtonI18n.t('recurRepeats');
    const start = event.dtstart instanceof Date && !isNaN(event.dtstart) ? event.dtstart : null;
    let text;
    const weekdaysOnly = ['MO', 'TU', 'WE', 'TH', 'FR'];
    const byday = _rruleList(r.BYDAY);
    if (interval === 1 && (r.FREQ === 'DAILY' || r.FREQ === 'WEEKLY') && byday.length === 5
      && weekdaysOnly.every((d) => byday.includes(d))
      && !['BYMONTH', 'BYMONTHDAY', 'BYSETPOS', 'BYYEARDAY', 'BYWEEKNO', 'BYHOUR', 'BYMINUTE', 'BYSECOND'].some((k) => r[k] !== undefined)) {
      text = ProtonI18n.t('recurWeekdays');
    } else {
      const detail = _recurrenceDetail(r.FREQ, r, start);
      text = detail === null ? ProtonI18n.t('recurDetail', base, ProtonI18n.t('recurCustom'))
        : (detail ? ProtonI18n.t('recurDetail', base, detail) : base);
    }
    let end = '';
    if (/^\d+$/.test(r.COUNT || '') && parseInt(r.COUNT, 10) > 0) {
      end = ProtonI18n.plural('recurTimes', parseInt(r.COUNT, 10));
    } else if (r.UNTIL) {
      const day = _rruleUntilText(r.UNTIL, event);
      if (day) end = ProtonI18n.t('recurUntil', day);
    }
    return end ? ProtonI18n.t('recurEnd', text, end) : text;
  }

  /**
   * Unescape RFC 5545 TEXT escapes (\n, \N, \, , \; , \\) for DISPLAY ONLY.
   *
   * Mirrors background/calendar-ics.js _unescapeText. parseICS deliberately
   * leaves the parsed value ESCAPED, because buildRsvpICS re-emits
   * event.summary verbatim into the outgoing REPLY and it must stay escaped to
   * be valid on the wire. So we unescape at render time and never in the event.
   * Without this a Google invite whose LOCATION is "Online\; https://meet..."
   * rendered with the backslash visible.
   * ONE pass that consumes the backslash together with whatever it escapes:
   * sequential per-escape replaces got "C:\\ndir" wrong, because unescaping
   * \\ last still let the FIRST rule read the escaped backslash plus the
   * following "n" as a newline. A single regex can never re-match a backslash
   * an earlier rule produced.
   *
   * We also run it over CN, which is a param-value, not TEXT. By the RFC that
   * is wrong. Keep it anyway: ical.js 1.5.0, the library Proton Calendar
   * itself uses, applies the same TEXT decode to parameters (measured: it
   * returns "ACME" + newline + "owak" for CN=ACME\Nowak). Dropping it here
   * would make our card disagree with Proton's own rendering of the very same
   * invite, which is the comparison the user actually makes. Parameter escapes
   * proper (RFC 6868 carets) are handled at parse by _decodeParam.
   */
  function _unescapeText(raw) {
    if (!raw) return raw;
    return String(raw).replace(/\\([nN,;\\])/g, (m, c) => (c === 'n' || c === 'N') ? '\n' : c);
  }

  /**
   * Escape a value that is about to be interpolated into OUTGOING email HTML.
   *
   * The RSVP reply body is built by substituting values into a translated
   * sentence and sending the result as text/html. SUMMARY comes from the
   * invite, so it is chosen by whoever sent it: without this, a crafted
   * SUMMARY puts arbitrary markup into a message WE send, under our own
   * address, and the organizer's client renders it. The translated templates
   * are plain sentences with no markup of their own, so escaping the VALUES
   * before substitution is both sufficient and safe.
   *
   * textContent + innerHTML rather than a regex: the DOM does the escaping, so
   * it cannot miss a case. The popup always has a document.
   */
  function _escapeHtmlValue(str) {
    const el = document.createElement('span');
    el.textContent = str == null ? '' : String(str);
    return el.innerHTML;
  }

  /**
   * Normalise an email for owner-matching: lowercase + strip sub-addressing
   * (the "+tag" before the @). A Proton plus-alias such as
   * mail+shop@example.com is delivered to, and owned by, the base address
   * mail@example.com, so an invite addressed to the alias must still resolve to
   * the account's own address for the RSVP own-status highlight + reply.
   */
  function _baseEmail(email) {
    const s = String(email || '').toLowerCase().trim();
    const at = s.indexOf('@');
    if (at <= 0) return s;
    return s.slice(0, at).split('+')[0] + s.slice(at);
  }

  /**
   * Encode an ICS parameter value (RFC 5545 + RFC 6868).
   * Quotes the value when it contains : ; or , and caret-encodes characters
   * that may never appear in parameter values (DQUOTE, ^, newlines) instead
   * of silently stripping them: 'O"Brien' survives as O^'Brien rather than
   * becoming OBrien.
   *
   * The exact inverse of _decodeParam, and that is what keeps the round trip
   * symmetric: an incoming CN is decoded ONCE at parse and re-encoded ONCE
   * here, so the REPLY carries the sender's own token back byte for byte
   * instead of growing a pair of carets on every hop.
   */
  function _icsParamValue(v) {
    const s = String(v || '')
      .replace(/\^/g, '^^')
      .replace(/\r\n?|\n/g, '^n') // a bare CR too: some readers end a line there
      .replace(/"/g, "^'");
    return /[;:,]/.test(s) ? '"' + s + '"' : s;
  }

  /**
   * Build an ICS REPLY message for an RSVP response.
   *
   * @param {object} event - Parsed event from parseICS().
   * @param {string} attendeeEmail - Responding attendee's email.
   * @param {string} partstat - ACCEPTED, TENTATIVE, or DECLINED.
   * @returns {string} ICS REPLY text.
   */
  function buildRsvpICS(event, attendeeEmail, partstat) {
    // A REPLY must echo the original event's DTSTART so the organizer can
    // match it to their copy. Fabricating "now" produces replies that strict
    // servers (Exchange) reject or mis-match. Upstream rejects invites without
    // a usable start time (UNEXPECTED_FLOATING_TIME in icsSurgery); we refuse
    // to build the reply and let the caller surface rsvpFailed.
    if (!event.dtstartRaw) return null;

    const now = new Date();
    const stamp = now.getUTCFullYear().toString() +
      String(now.getUTCMonth() + 1).padStart(2, '0') +
      String(now.getUTCDate()).padStart(2, '0') + 'T' +
      String(now.getUTCHours()).padStart(2, '0') +
      String(now.getUTCMinutes()).padStart(2, '0') +
      String(now.getUTCSeconds()).padStart(2, '0') + 'Z';

    const lines = [
      'BEGIN:VCALENDAR',
      'PRODID:-//Proton Mail Checker//EN',
      'VERSION:2.0',
      'METHOD:REPLY',
      'BEGIN:VEVENT',
      'UID:' + event.uid,
      'DTSTAMP:' + stamp,
      // Echo SEQUENCE (default 0 per RFC 5545) so Google/Outlook organizers
      // match the reply to the right revision of the event.
      'SEQUENCE:' + (event.sequence || '0'),
      event.dtstartRaw,
    ];
    if (event.dtendRaw) lines.push(event.dtendRaw);
    // A reply to ONE instance of a recurring event must carry RECURRENCE-ID,
    // otherwise the organizer applies the RSVP to the whole series.
    if (event.recurrenceIdRaw) lines.push(event.recurrenceIdRaw);
    lines.push(
      'SUMMARY:' + event.summary,
      'ORGANIZER;CN=' + _icsParamValue(event.organizer.name) + ':mailto:' + event.organizer.email,
      'ATTENDEE;PARTSTAT=' + partstat + ':mailto:' + attendeeEmail,
      'END:VEVENT',
      'END:VCALENDAR',
    );
    // The values come from the mail: a bare CR in one (the parser splits on
    // CRLF and LF only) would end the line early for some readers.
    return lines.map((l) => l.replace(/\r/g, '')).join('\r\n');
  }

  // Proton attendee Status codes -> display. 0=pending 1=tentative 2=declined 3=accepted.
  const STATUS_ICONS = { 3: '✅', 1: '❓', 2: '❌', 0: '⏳' };
  // The badge title is on screen, so it must be translated. Only the KEYS live
  // at module level: resolving them here would freeze the popup's language at
  // load time and a later language switch would not take effect.
  const STATUS_LABEL_KEYS = {
    3: 'rsvpStatusAccepted', 1: 'rsvpStatusTentative',
    2: 'rsvpStatusDeclined', 0: 'rsvpStatusPending',
  };
  // ICS PARTSTAT -> Proton Status code, used to seed the badge before the live fetch.
  const PARTSTAT_TO_STATUS = { 'ACCEPTED': 3, 'TENTATIVE': 1, 'DECLINED': 2, 'NEEDS-ACTION': 0 };

  /** Is this rendered row the SPECIFIC attendee we resolved as "us"? Match on
   *  EXACT email identity: the resolved own-attendee is itself one of the rendered
   *  rows, so its email equals that row's email. We deliberately do NOT match by
   *  +alias base class here: that would also stamp a second owned-alias
   *  co-attendee row (e.g. an invite listing both mail@ and mail+shop@) with our
   *  status. The +alias↔base reconciliation stays in the server matcher below. */
  function _isSelfRow(ae, selfEmail) {
    if (!ae || !selfEmail) return false;
    return (ae.email || '').toLowerCase() === String(selfEmail).toLowerCase();
  }

  /** Paint a row's status badge and remember the status on the entry. */
  function _paintRow(ae, status) {
    if (STATUS_ICONS[status] === undefined) return;
    ae.badge.textContent = ' ' + STATUS_ICONS[status];
    ae.badge.title = ProtonI18n.t(STATUS_LABEL_KEYS[status]);
    ae._status = status;
  }

  /** Recompute the "(n yes, n pending, ...)" summary from the rows' statuses. */
  function _recountAttendees(attEntries, attText, event) {
    if (!attText) return;
    let accepted = 0, tentative = 0, declined = 0, pending = 0, known = 0;
    for (const ae of attEntries) {
      const s = ae._status;
      if (s === undefined) continue;
      known++;
      if (s === 3) accepted++;
      else if (s === 1) tentative++;
      else if (s === 2) declined++;
      else pending++;
    }
    if (!known) return;
    const parts = [];
    if (accepted) parts.push(accepted + ' ' + ProtonI18n.t('rsvpYes'));
    if (tentative) parts.push(tentative + ' ' + ProtonI18n.t('rsvpMaybe'));
    if (declined) parts.push(declined + ' ' + ProtonI18n.t('rsvpNo'));
    if (pending) parts.push(pending + ' ' + ProtonI18n.t('rsvpPending'));
    if (parts.length) {
      // plural() already embeds the count ("3 attendees"), hence no manual prefix.
      attText.textContent = ProtonI18n.plural('attendeesCount', event.attendees.length)
        + ' (' + parts.join(', ') + ')';
    }
  }

  /**
   * Refresh attendee status badges from the calendar API.
   *
   * @param {object} event - Parsed event.
   * @param {string} accountId
   * @param {Array} attEntries - Attendee DOM entries with { badge, token, email, _status }.
   * @param {HTMLElement} attText - Attendee count text element.
   * @param {HTMLElement} buttonsEl - Buttons container (unused since the
   *   buttons stay usable for an invitation that is not in the calendar).
   * @param {HTMLElement} statusEl - Status text element.
   * @param {object} [selfChoice] - { email, status }: the status the user JUST chose;
   *   prevents our own row being downgraded to "pending" by a read-after-write
   *   stale calendar response right after the RSVP PUT.
   */
  function refreshCalendarBadges(event, accountId, attEntries, attText, buttonsEl, statusEl, selfChoice) {
    browser.runtime.sendMessage({
      type: 'GET_CALENDAR_ATTENDEES', accountId, eventUID: event.uid,
      recurrenceId: event.recurrenceIdRaw || '',
    }).then(result => {
      // The lookup made on opening came back after an answer on this card:
      // that answer's own refresh (with selfChoice) paints the card.
      if (!selfChoice && statusEl && statusEl._answered) return;
      if (result && result.notFound) {
        // Not in the calendar: Proton's server adds only the invitations it
        // can read (when the user's "Add to calendar and mark as pending" is
        // on), and a deleted event looks the same. Proton's Mail app keeps
        // Yes/Maybe/No usable then and adds the event when the user answers,
        // and so does the card. Never over an answer: right after one the
        // calendar can lag behind the write that just happened, and a click
        // can beat this lookup ("Sending response..." is already showing).
        // Only where it is true: the background, which saves the copy, says
        // whether it can (statusEl._addsOnAnswer, set by the card).
        if (statusEl && !selfChoice && typeof statusEl._addsOnAnswer === 'function') {
          statusEl._addsOnAnswer().then((adds) => {
            if (adds && !statusEl.textContent) {
              statusEl.textContent = ProtonI18n.t('eventNotInCalendarYet');
              statusEl._promisedAdd = true;
            }
          });
        }
        return;
      }

      if (!result || !result.attendees) return;
      for (let idx = 0; idx < attEntries.length; idx++) {
        const ae = attEntries[idx];
        const aeEmail = (ae.email || '').toLowerCase();
        // Match by token (internal invites) → decrypted email → +alias base
        // email. NO positional fallback: the ICS attendee list and Proton's
        // attendee list aren't in the same order, so index-alignment mislabeled
        // statuses (e.g. attributing a room's "accepted" to the wrong person).
        // If none match, leave the badge at its original ICS PARTSTAT.
        const match = (ae.token && result.attendees.find(ra => ra.Token === ae.token))
          || (aeEmail && result.attendees.find(ra => (ra.Email || '').toLowerCase() === aeEmail))
          || (aeEmail && result.attendees.find(ra => _baseEmail(ra.Email || '') === _baseEmail(aeEmail)))
          || null;
        let status = match ? match.Status : ae._status;
        // Our own row shows the answer just given: a GET issued moments after
        // the PUT can still report the one before (read-after-write lag),
        // pending or, now that the answer can be changed on the same card,
        // the previous answer.
        if (selfChoice && _isSelfRow(ae, selfChoice.email)) {
          status = selfChoice.status;
        }
        if (status !== undefined) _paintRow(ae, status);
      }
      _recountAttendees(attEntries, attText, event);
    }).catch(() => {});
  }

  /**
   * Render a calendar invite into the given container element.
   *
   * @param {object} event - Parsed event from parseICS().
   * @param {string} accountId
   * @param {string} rawIcs - Raw ICS text: the "Add to calendar" button imports
   *   it, and an answer to an invitation that is not in the calendar adds it.
   * @param {object} ctx - Context from popup.js:
   * @param {HTMLElement} ctx.containerEl - Calendar invite DOM container.
   * @param {Function} ctx.getSelectedMsg - Returns the currently selected message.
   * @param {Function} ctx.showToast - Show a toast notification.
   */
  function renderCalendarInvite(event, accountId, rawIcs, ctx) {
    const { containerEl: hostEl, getSelectedMsg, showToast } = ctx;
    hostEl.classList.remove('hidden');

    // Each event lives in its own sub-card so a single message with
    // multiple .ics attachments (multi-leg flight, group booking,
    // etc.) renders one block per event. The caller `detectCalendarInvite`
    // is responsible for clearing the outer container before the first
    // render. We only append here.
    const containerEl = document.createElement('div');
    containerEl.className = 'calendar-invite-card';
    if (hostEl.childElementCount > 0) {
      // Visual gap between stacked event cards in a multi-event message.
      containerEl.style.marginTop = '8px';
    }
    hostEl.appendChild(containerEl);

    // Header
    const header = document.createElement('div');
    header.className = 'calendar-invite-header';
    const icon = document.createElement('span');
    icon.className = 'calendar-invite-icon';
    icon.textContent = '\uD83D\uDCC5';
    const title = document.createElement('span');
    title.className = 'calendar-invite-title';
    // Unescape for display only: event.summary stays escaped for the REPLY.
    title.textContent = _unescapeText(event.summary) || ProtonI18n.t('eventUntitled');
    header.append(icon, title);

    // Details
    const details = document.createElement('div');
    details.className = 'calendar-invite-details';

    // Date/time
    if (event.dtstart) {
      const dateOpts = { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' };
      const timeOpts = { hour: '2-digit', minute: '2-digit' };
      // A zoned DTSTART (TZID=…) is parsed as a local wall-clock Date, so show
      // it as written: the time the organizer specified (matches Proton's
      // widget). We deliberately do NOT pass event.timezone to Intl here: it's
      // often a Windows zone name ("W. Europe Standard Time") that throws
      // "invalid time zone", and even a valid IANA name would double-convert a
      // wall-clock Date. UTC times (…Z) have no event.timezone and still render
      // in the viewer's local zone.
      let dateStr = event.dtstart.toLocaleDateString(undefined, dateOpts);
      if (!event.allDay) {
        dateStr += ', ' + event.dtstart.toLocaleTimeString(undefined, timeOpts);
        if (event.dtend) dateStr += ' - ' + event.dtend.toLocaleTimeString(undefined, timeOpts);
      }
      const dateRow = document.createElement('div');
      dateRow.className = 'calendar-invite-detail';
      dateRow.innerHTML = '<span class="calendar-invite-detail-icon">\uD83D\uDD52</span>';
      const dateText = document.createElement('span');
      dateText.textContent = dateStr;
      dateRow.appendChild(dateText);
      details.appendChild(dateRow);
    }

    // Recurrence: how a series repeats, or that this is one occurrence of one.
    const recurrence = describeRecurrence(event);
    if (recurrence) {
      const recRow = document.createElement('div');
      recRow.className = 'calendar-invite-detail calendar-invite-recurrence';
      recRow.innerHTML = '<span class="calendar-invite-detail-icon">🔁</span>';
      const recText = document.createElement('span');
      recText.textContent = recurrence;
      recRow.appendChild(recText);
      details.appendChild(recRow);
    }

    // Organizer
    if (event.organizer.email) {
      const orgRow = document.createElement('div');
      orgRow.className = 'calendar-invite-detail';
      orgRow.innerHTML = '<span class="calendar-invite-detail-icon">\uD83D\uDC64</span>';
      const orgText = document.createElement('span');
      // Display only, same as the attendee rows below: the REPLY re-emits
      // organizer.name through _icsParamValue, which needs the stored value.
      // The TEXT unescape on a CN is deliberate, see _unescapeText: ical.js,
      // and therefore Proton Calendar, does the same to parameters.
      orgText.textContent = _unescapeText(event.organizer.name) || event.organizer.email;
      orgRow.appendChild(orgText);
      details.appendChild(orgRow);
    }

    // Attendees
    let attText = null;
    const attEntries = [];
    if (event.attendees.length > 0) {
      const attRow = document.createElement('div');
      attRow.className = 'calendar-invite-detail';
      attRow.innerHTML = '<span class="calendar-invite-detail-icon">\uD83D\uDC65</span>';
      attText = document.createElement('span');
      attText.className = 'calendar-invite-attendees-toggle';
      attText.textContent = ProtonI18n.plural('attendeesCount', event.attendees.length);
      attText.title = event.attendees.map(a => a.name ? _unescapeText(a.name) + ' <' + a.email + '>' : a.email).join('\n');
      attRow.appendChild(attText);

      const attList = document.createElement('div');
      attList.className = 'calendar-invite-attendee-list hidden';
      for (const a of event.attendees) {
        const entry = document.createElement('div');
        entry.className = 'calendar-invite-attendee';
        const nameSpan = document.createElement('span');
        nameSpan.textContent = a.name ? _unescapeText(a.name) + ' <' + a.email + '>' : a.email;
        entry.appendChild(nameSpan);
        const badge = document.createElement('span');
        badge.className = 'calendar-invite-attendee-status';
        entry.appendChild(badge);
        const ae = { entry, badge, token: a.pmToken, email: a.email };
        // Seed the badge from the ICS PARTSTAT; the live calendar fetch overrides it.
        _paintRow(ae, PARTSTAT_TO_STATUS[(a.partstat || '').toUpperCase()] ?? 0);
        attEntries.push(ae);
        attList.appendChild(entry);
      }
      attText.addEventListener('click', () => attList.classList.toggle('hidden'));
      attRow.appendChild(attList);
      details.appendChild(attRow);
    }

    // Location
    if (event.location) {
      const locRow = document.createElement('div');
      locRow.className = 'calendar-invite-detail';
      locRow.innerHTML = '<span class="calendar-invite-detail-icon">\uD83D\uDCCD</span>';
      const locText = document.createElement('span');
      locText.textContent = _unescapeText(event.location);
      locRow.appendChild(locText);
      details.appendChild(locRow);
    }

    const methodUpper = event.method.toUpperCase();

    // CANCEL: show red notice, no buttons
    if (methodUpper === 'CANCEL') {
      const notice = document.createElement('div');
      notice.className = 'calendar-invite-status';
      notice.style.color = '#c92a2a';
      notice.style.fontWeight = '600';
      notice.style.fontSize = '13px';
      notice.textContent = '\u274C ' + ProtonI18n.t('eventCancelled');
      containerEl.append(header, details, notice);
      return;
    }

    // Non-REQUEST methods: show inline method label + a single
    // action row (Open in Mail + calendar action) at the bottom.
    if (methodUpper !== 'REQUEST') {
      const methodLabels = {
        PUBLISH: ProtonI18n.t('eventPublished'),
        REPLY: ProtonI18n.t('eventReply'),
        COUNTER: ProtonI18n.t('eventCounter'),
        DECLINECOUNTER: ProtonI18n.t('eventDeclineCounter'),
        ADD: ProtonI18n.t('eventUpdated'),
        REFRESH: ProtonI18n.t('eventRefreshRequested'),
      };

      // Remove ICS-only attendee row (REPLY only has the responder, incomplete)
      // We'll replace it with the full list from Calendar API below
      if (attText) {
        const icsAttRow = attText.closest('.calendar-invite-detail');
        if (icsAttRow) icsAttRow.remove();
      }

      // Inline the method label into the first detail row (next to the
      // date) instead of giving it its own line.
      const firstDetail = details.querySelector('.calendar-invite-detail span:not(.calendar-invite-detail-icon)');
      if (firstDetail) {
        const tag = document.createElement('span');
        tag.className = 'calendar-invite-method-inline';
        tag.textContent = methodLabels[methodUpper] || methodUpper;
        firstDetail.parentNode.appendChild(tag);
      } else {
        const desc = document.createElement('div');
        desc.className = 'calendar-invite-status';
        desc.textContent = methodLabels[methodUpper] || methodUpper;
        details.appendChild(desc);
      }

      // PUBLISH/ADD/REFRESH are one-way notifications of an event
      // (flight confirmations, hotel bookings, etc.). We offer the
      // user a primary "Add to / Open in Proton Calendar" action.
      // For REPLY / COUNTER / DECLINECOUNTER, only Open-in-Mail is
      // useful, and it stays full-width.
      const importableMethods = new Set(['PUBLISH', 'ADD', 'REFRESH']);
      const isImportable = importableMethods.has(methodUpper) && typeof PopupCalendarAdd !== 'undefined';

      const actions = document.createElement('div');
      actions.className = 'calendar-invite-actions';
      actions.style.marginTop = '4px';

      const openBtn = document.createElement('button');
      openBtn.className = 'calendar-invite-btn';
      openBtn.type = 'button';
      if (isImportable) {
        // Demote Open-in-Mail to a secondary icon button when the
        // primary action is the calendar one.
        openBtn.classList.add('calendar-open-mail-btn');
        openBtn.title = ProtonI18n.t('openInProtonMail');
        openBtn.setAttribute('aria-label', ProtonI18n.t('openInProtonMail'));
        openBtn.textContent = '✉'; // ✉
      } else {
        openBtn.textContent = ProtonI18n.t('openInProtonMail');
      }
      openBtn.addEventListener('click', () => {
        const sel = getSelectedMsg();
        browser.runtime.sendMessage({
          type: 'GET_MAIL_URL',
          conversationId: sel.ConversationID,
          messageId: sel.ID,
          accountId: sel._accountId,
        }).then(url => { if (url) { browser.tabs.create({ url }); window.close(); } });
      });

      containerEl.append(header, details, actions);

      // Render the calendar action (Add or Open) BEFORE Open-in-Mail
      // so the primary action sits on the left. PopupCalendarAdd
      // appends its button(s) into the shared actions row, then we
      // append the demoted Open-in-Mail button to the right.
      if (isImportable) {
        PopupCalendarAdd.render(event, rawIcs, accountId, actions, ctx).catch(e => {
          console.warn('[CalendarAdd] render failed:', e.message);
        });
      }
      actions.appendChild(openBtn);

      // Fetch all attendees from Calendar API and show with live statuses
      if (event.uid) {
        browser.runtime.sendMessage({
          type: 'GET_CALENDAR_ATTENDEES', accountId, eventUID: event.uid,
        }).then(result => {
          if (!result || result.notFound || !result.attendees || result.attendees.length === 0) return;

          const statusIcons = { 3: '\u2705', 1: '\u2753', 2: '\u274C', 0: '\u23F3' };
          let accepted = 0, tentative = 0, declined = 0, pending = 0;

          const attRow = document.createElement('div');
          attRow.className = 'calendar-invite-detail';
          attRow.innerHTML = '<span class="calendar-invite-detail-icon">\uD83D\uDC65</span>';

          const liveAttText = document.createElement('span');
          liveAttText.className = 'calendar-invite-attendees-toggle';
          attRow.appendChild(liveAttText);

          const attList = document.createElement('div');
          attList.className = 'calendar-invite-attendee-list hidden';

          for (const att of result.attendees) {
            // Get email from decrypted calendar data, fall back to ICS match
            const icsMatch = event.attendees.find(a => a.pmToken && a.pmToken === att.Token);
            const email = att.Email || (icsMatch ? icsMatch.email : '');
            const name = icsMatch ? icsMatch.name : '';
            // Singular fallback label for a nameless, email-less attendee: this
            // is one person, not a count, so it is not the plural key.
            const label = name ? _unescapeText(name) + ' <' + email + '>' : email || ProtonI18n.t('attendeeUnknown');

            const entry = document.createElement('div');
            entry.className = 'calendar-invite-attendee';
            const nameSpan = document.createElement('span');
            nameSpan.textContent = label;
            entry.appendChild(nameSpan);
            const badge = document.createElement('span');
            badge.className = 'calendar-invite-attendee-status';
            if (statusIcons[att.Status] !== undefined) {
              badge.textContent = ' ' + statusIcons[att.Status];
              // Same keys as _paintRow, resolved here at paint time: this live
              // list had its own hardcoded English label table.
              badge.title = ProtonI18n.t(STATUS_LABEL_KEYS[att.Status]);
            }
            entry.appendChild(badge);
            attList.appendChild(entry);

            if (att.Status === 3) accepted++;
            else if (att.Status === 1) tentative++;
            else if (att.Status === 2) declined++;
            else pending++;
          }

          const parts = [];
          if (accepted) parts.push(accepted + ' ' + ProtonI18n.t('rsvpYes'));
          if (tentative) parts.push(tentative + ' ' + ProtonI18n.t('rsvpMaybe'));
          if (declined) parts.push(declined + ' ' + ProtonI18n.t('rsvpNo'));
          if (pending) parts.push(pending + ' ' + ProtonI18n.t('rsvpPending'));
          // plural() already embeds the count, hence no manual prefix.
          liveAttText.textContent = ProtonI18n.plural('attendeesCount', result.attendees.length)
            + (parts.length ? ' (' + parts.join(', ') + ')' : '');

          liveAttText.addEventListener('click', () => attList.classList.toggle('hidden'));
          attRow.appendChild(attList);

          // Add attendee row to the details section
          details.appendChild(attRow);
        }).catch(() => {});
      }

      return;
    }

    // REQUEST: show RSVP buttons
    const buttons = document.createElement('div');
    buttons.className = 'calendar-invite-buttons';

    // Resolve which attendee is "us" once: match the event attendees against
    // THIS account's own sendable addresses (NOT the message recipient list,
    // which also contains co-recipients like external attendees: matching
    // that could pick the wrong identity and send the RSVP from an address the
    // account doesn't own → "Invalid sender"). Shared by the RSVP buttons and
    // the live-status pre-select below.
    const myAttPromise = (async () => {
      let ownedEmails = [];
      let ownedAddrs = [];
      try {
        const addrs = await browser.runtime.sendMessage({ type: 'GET_ADDRESSES', accountId });
        ownedAddrs = Array.isArray(addrs) ? addrs : [];
        ownedEmails = ownedAddrs.map(a => (a.Email || '').toLowerCase());
      } catch (e) { /* fall back to the account's primary email below */ }
      const acctEmail = ((getSelectedMsg() && getSelectedMsg()._accountEmail) || '').toLowerCase();
      const owned = acctEmail ? ownedEmails.concat([acctEmail]) : ownedEmails;
      // Prefer an exact match; fall back to sub-address (+tag) matching so an
      // invite addressed to a plus-alias (mail+shop@example.com) still resolves
      // to the account that owns the base address (mail@example.com). Without
      // this, no attendee matches "us" → the own-status button never lights up.
      const att = event.attendees.find(a => owned.includes(a.email.toLowerCase()))
        || event.attendees.find(a => owned.some(o => _baseEmail(o) === _baseEmail(a.email)))
        || null;
      if (!att) return null;
      // The RSVP goes out from the address the invitation was sent to, as
      // Proton's own Calendar answers: an exact owned address, else a +alias
      // of one that can carry it (lib/sender-alias.js; the API accepts a
      // +alias as the sender), else the owned address sharing the attendee's
      // base local part, else the attendee email.
      const lower = att.email.toLowerCase();
      const alias = ProtonSenderAlias.resolve(att.email, ownedAddrs);
      const sendFrom = owned.includes(lower)
        ? lower
        : (alias.ok && alias.alias
          ? alias.email
          : (owned.find(o => _baseEmail(o) === _baseEmail(lower)) || lower));
      return { att, sendFrom };
    })();

    const btnData = [
      { label: ProtonI18n.t('accept'), partstat: 'ACCEPTED', cls: 'accepted', apiStatus: 3 },
      { label: ProtonI18n.t('tentative'), partstat: 'TENTATIVE', cls: 'tentative', apiStatus: 1 },
      { label: ProtonI18n.t('decline'), partstat: 'DECLINED', cls: 'declined', apiStatus: 2 },
    ];

    const statusEl = document.createElement('div');
    statusEl.className = 'calendar-invite-status';
    // Whether answering adds this invitation when it is not in the calendar.
    // The background decides, with the same checks it runs before it saves
    // (one event, the user invited and not organizing, every time zone one
    // the API accepts): asked once, and only when the lookup found nothing.
    let addsOnAnswer = null;
    statusEl._addsOnAnswer = () => (addsOnAnswer = addsOnAnswer || myAttPromise.then((resolved) => (!resolved ? false
      : browser.runtime.sendMessage({
        type: 'CHECK_INVITE_SAVABLE', accountId, eventUID: event.uid,
        recurrenceId: event.recurrenceIdRaw || '', attendeeEmail: resolved.att.email, inviteIcs: rawIcs || '',
        // What this card shows, as the answer will send it: the background
        // saves only an event that matches it.
        replyIcs: buildRsvpICS(event, resolved.att.email, 'ACCEPTED') || '', shownLocation: event.location || '',
      }).then((r) => !!(r && r.savable), () => false)), () => false));

    const allBtns = [];
    // The answer the card stands for: the one in the calendar (the pre-select
    // below) or the last one sent from here. As in Proton's Mail app, the
    // buttons are blocked only while an answer is on its way; afterwards the
    // other two change it, and the current one is not sent again.
    let current = null;
    let sending = false;
    // The answer the calendar holds, kept even when the lookup came back
    // during a first answer from this card, and whether one was sent here.
    let stored = null;
    let answeredHere = false;
    const paint = (partstat) => {
      for (const { btn, bd } of allBtns) {
        const on = bd.partstat === partstat;
        btn.classList.remove('accepted', 'tentative', 'declined');
        if (on) btn.classList.add(bd.cls);
        btn.setAttribute('aria-pressed', on ? 'true' : 'false');
      }
    };
    const setEnabled = (on) => { for (const { btn } of allBtns) btn.disabled = !on; };
    // Back to the answer the card stood for before: the send did not happen.
    // Nothing sent from here yet: that is the calendar's answer, and a lookup
    // still on its way may paint it again.
    const failed = () => {
      sending = false;
      if (!answeredHere) {
        current = stored;
        statusEl._answered = false;
      }
      paint(current);
      setEnabled(true);
      statusEl.textContent = ProtonI18n.t('rsvpFailed');
    };
    for (const bd of btnData) {
      const btn = document.createElement('button');
      btn.className = 'calendar-invite-btn';
      btn.textContent = bd.label;
      btn.setAttribute('aria-pressed', 'false');
      allBtns.push({ btn, bd });

      btn.addEventListener('click', async () => {
        if (sending || bd.partstat === current) return;
        sending = true;
        // From here on this card shows its own answer: a lookup started on
        // opening (which can wait for an earlier answer still on its way)
        // must not paint a stale one over it.
        statusEl._answered = true;
        setEnabled(false);
        paint(bd.partstat);
        statusEl.textContent = ProtonI18n.t('rsvpSending');

        const resolved = await myAttPromise;
        if (!resolved) {
          // None of this account's addresses is an attendee: can't RSVP as it.
          failed();
          return;
        }
        const myAtt = resolved.att;
        // The reply's ATTENDEE echoes the invited address (the +alias) so the
        // organizer matches it; the message is SENT from a real owned address.
        const attendeeEmail = myAtt.email;
        const senderAddress = resolved.sendFrom;
        const icsReply = buildRsvpICS(event, attendeeEmail, bd.partstat);
        if (!icsReply) {
          // Invite had no usable DTSTART: a fabricated reply would be
          // rejected/mismatched by the organizer's server.
          failed();
          return;
        }
        // The ICS attachment keeps SUMMARY escaped (buildRsvpICS re-emits it
        // verbatim), but the subject and body a human reads must not show
        // "Lunch\, then demo", so unescape a display copy here. Newlines are
        // flattened: "\n" in SUMMARY would otherwise put a line break into a
        // mail subject.
        const summaryText = (_unescapeText(event.summary) || ProtonI18n.t('eventUntitled')).replace(/[\r\n]+/g, ' ');
        const actionKey = bd.partstat === 'ACCEPTED' ? 'hasAccepted'
          : bd.partstat === 'TENTATIVE' ? 'hasTentativelyAccepted' : 'hasDeclined';
        // Escaped because this string becomes the HTML body of an outgoing
        // mail and summaryText is attacker-chosen. The subject below is a
        // plain-text header and must stay unescaped.
        const htmlBody = '<div>'
          + ProtonI18n.t(actionKey, _escapeHtmlValue(attendeeEmail), _escapeHtmlValue(summaryText))
          + '</div>';
        const subjectKey = bd.partstat === 'ACCEPTED' ? 'acceptedSubject'
          : bd.partstat === 'TENTATIVE' ? 'tentativeSubject' : 'declinedSubject';
        const subject = ProtonI18n.t(subjectKey, summaryText);

        try {
          const result = await browser.runtime.sendMessage({
            type: 'CALENDAR_RSVP',
            accountId,
            organizerEmail: event.organizer.email,
            subject,
            htmlBody,
            icsData: icsReply,
            senderAddress,
            attendeeEmail,
            eventUID: event.uid,
            recurrenceId: event.recurrenceIdRaw || '',
            attendeeToken: myAtt.pmToken || '',
            partstat: bd.partstat,
            // The invitation itself, so that answering one that is not in the
            // calendar yet adds it there.
            inviteIcs: rawIcs || '',
            // The card said "your answer adds it": if the calendar cannot be
            // checked afterwards, the background must not stay silent.
            promisedAdd: statusEl._promisedAdd === true,
            // The location the card showed: compared with what would be saved.
            shownLocation: event.location || '',
          });
          if (result && result.error) throw new Error(result.error);
          current = bd.partstat;
          answeredHere = true;
          sending = false;
          const confirmKey = bd.partstat === 'ACCEPTED' ? 'rsvpAccepted'
            : bd.partstat === 'TENTATIVE' ? 'rsvpTentative' : 'rsvpDeclined';
          statusEl.textContent = ProtonI18n.t(confirmKey);
          if (result && result.calendar === 'notAdded') {
            // The answer went out either way; say so on a line of its own
            // when the calendar could not take the event, instead of
            // implying it is there.
            const note = document.createElement('div');
            note.className = 'calendar-invite-status-note';
            note.textContent = ProtonI18n.t('rsvpSentNotAdded');
            statusEl.appendChild(note);
          } else {
            // In the calendar now: "your answer adds it" no longer stands.
            statusEl._promisedAdd = false;
          }
          paint(current);
          setEnabled(true);
          // Optimistically reflect OUR choice in the attendee list right away so
          // the user doesn't have to close + reopen the email to see it. We know
          // which row is ours (the resolved attendee's email); the server
          // reconcile below refreshes everyone else and won't downgrade our row.
          for (const ae of attEntries) {
            if (_isSelfRow(ae, myAtt.email)) _paintRow(ae, bd.apiStatus);
          }
          _recountAttendees(attEntries, attText, event);
          refreshCalendarBadges(event, accountId, attEntries, attText, buttons, statusEl,
            { email: myAtt.email, status: bd.apiStatus });
        } catch (e) {
          failed();
          showToast(ProtonI18n.t('rsvpFailed') + ': ' + e.message);
        }
      });
      buttons.appendChild(btn);
    }

    containerEl.append(header, details, buttons, statusEl);

    // Fetch live attendee statuses from calendar API (async, non-blocking)
    if (event.uid && event.attendees.length > 0) {
      refreshCalendarBadges(event, accountId, attEntries, attText, buttons, statusEl);
    }

    // Pre-select button based on live calendar API status
    if (event.uid) {
      browser.runtime.sendMessage({
        type: 'GET_CALENDAR_ATTENDEES', accountId, eventUID: event.uid,
        recurrenceId: event.recurrenceIdRaw || '',
      }).then(async result => {
        if (!result || !result.attendees || answeredHere) return;
        const resolved = await myAttPromise;
        if (answeredHere) return;
        const myAtt = resolved && resolved.att;
        const myToken = myAtt ? myAtt.pmToken : '';
        const myEmail = ((myAtt && myAtt.email) || '').toLowerCase();
        // Identify OUR attendee: by X-PM-TOKEN (internal invites) or by our
        // decrypted email (external invites carry no token). No blind
        // "attendees[0]" fallback: that highlighted whichever attendee was
        // listed first (often a co-invitee), so an external-invite RSVP never
        // lit up the right button. Email match falls back to the base address
        // so a plus-alias invite matches the calendar's base-address attendee.
        let myCalAtt = myToken ? result.attendees.find(a => a.Token === myToken) : null;
        if (!myCalAtt && myEmail) {
          myCalAtt = result.attendees.find(a => (a.Email || '').toLowerCase() === myEmail)
            || result.attendees.find(a => _baseEmail(a.Email) === _baseEmail(myEmail));
        }
        if (myCalAtt && myCalAtt.Status !== 0) {
          const statusToPartstat = { 3: 'ACCEPTED', 1: 'TENTATIVE', 2: 'DECLINED' };
          const ps = statusToPartstat[myCalAtt.Status];
          // Kept either way; painted only when no answer from this card is
          // on its way or made (a failed one hands the card back to it).
          if (ps) stored = ps;
          if (ps && !statusEl._answered) {
            current = ps;
            paint(ps);
            const confirmKey = ps === 'ACCEPTED' ? 'rsvpAccepted'
              : ps === 'TENTATIVE' ? 'rsvpTentative' : 'rsvpDeclined';
            statusEl.textContent = ProtonI18n.t(confirmKey);
          }
        }
      }).catch(() => {});
    }
  }

  /**
   * Detect and render a calendar invite from a message's attachments.
   *
   * @param {object} fullMsg - Full message object with Attachments array.
   * @param {string} accountId
   * @param {object} ctx - Context: { containerEl, getSelectedMsg, showToast }
   */
  async function detectCalendarInvite(fullMsg, accountId, ctx) {
    const { containerEl } = ctx;
    containerEl.textContent = '';
    containerEl.classList.add('hidden');

    const atts = fullMsg.Attachments || [];
    // Some emails (multi-leg flight confirmations, group bookings,
    // etc.) carry one .ics per event. Render an invite block for each.
    const icsAtts = atts.filter(a =>
      a.MIMEType === 'text/calendar' ||
      (a.Name && a.Name.toLowerCase().endsWith('.ics'))
    );
    if (!icsAtts.length) return;

    // Fetch + parse all .ics attachments in parallel.
    const parsed = await Promise.all(icsAtts.map(async (att) => {
      try {
        const keyPackets = att.KeyPackets || null;
        const result = await browser.runtime.sendMessage({
          type: 'GET_ATTACHMENT', attachmentId: att.ID, accountId,
          keyPackets,
        });
        // decrypted === false ALSO comes back when we sent no key packets, so
        // gate on keyPackets like the other call sites: only then does it mean
        // the bytes are still PGP ciphertext and a decryption failure, which we
        // must not parse (decoding ciphertext as UTF-8 feeds parseICS garbage).
        if (!result || result.error || !result.data) return null;
        if (keyPackets && result.decrypted === false) return null;
        const bytes = ProtonBinary.base64ToUint8(result.data);
        const icsText = new TextDecoder('utf-8').decode(bytes);
        const event = parseICS(icsText);
        if (!event) return null;
        return { event, icsText };
      } catch (e) {
        console.warn('[Calendar] Failed to fetch invite attachment:', e.message);
        return null;
      }
    }));

    // Render each valid event into the same container. renderCalendarInvite
    // appends (it doesn't replace), so multiple blocks stack naturally.
    // Dedupe by event UID (+ method): some providers (notably Google Calendar)
    // attach the SAME event twice (the inline text/calendar part AND an
    // explicit invite.ics), which would otherwise render two identical cards.
    // Genuinely distinct events (e.g. multi-leg flight itineraries) keep
    // distinct UIDs, so they each still render.
    const seenEvents = new Set();
    for (const item of parsed) {
      if (!item) continue;
      const key = (item.event.uid || '') + '|' + (item.event.method || '');
      if (seenEvents.has(key)) continue;
      seenEvents.add(key);
      try {
        renderCalendarInvite(item.event, accountId, item.icsText, ctx);
      } catch (e) {
        console.warn('[Calendar] Failed to render invite:', e.message);
      }
    }
  }

  return {
    parseICS,
    buildRsvpICS,
    describeRecurrence,
    detectCalendarInvite,
    renderCalendarInvite,
    refreshCalendarBadges,
    _baseEmail,
  };
})();
