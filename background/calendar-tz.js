/**
 * Time zone names in invitations, made acceptable to Proton's calendar API.
 *
 * The API stores an event's zone only when it is one of the IANA zones it
 * lists (GET calendar/v1/timezones: 340 zones, a curated mix of old and new
 * spellings, e.g. Europe/Kiev but not Europe/Kyiv, no Asia/Singapore). Any
 * other name is refused with "Invalid event data (Invalid timezone)"
 * (measured 2026-11-09), and invitations from Outlook, Exchange and Teams
 * carry Windows names such as "W. Europe Standard Time". Proton's own
 * clients convert the name before saving, and so does this, with its own
 * tables (calendar-tz-data.js, built from the Unicode CLDR and the tzdata
 * links by scripts/build-windows-zones.js).
 *
 * A TZID comes from the mail, so it is capped in length before any pattern
 * touches it (the longest real name is under 100 characters).
 */
const ProtonCalendarTZ = (() => {
  const MAX_TZID = 128;

  // tzdata renames, both ways: either spelling may be the one the API
  // accepts. Kept in step with scripts/build-windows-zones.js.
  const RENAMES = [
    ['Asia/Calcutta', 'Asia/Kolkata'], ['Asia/Katmandu', 'Asia/Kathmandu'], ['Asia/Rangoon', 'Asia/Yangon'],
    ['Asia/Saigon', 'Asia/Ho_Chi_Minh'], ['Europe/Kiev', 'Europe/Kyiv'], ['America/Godthab', 'America/Nuuk'],
    ['Pacific/Truk', 'Pacific/Chuuk'], ['Pacific/Ponape', 'Pacific/Pohnpei'], ['Pacific/Enderbury', 'Pacific/Kanton'],
    ['Atlantic/Faeroe', 'Atlantic/Faroe'], ['America/Buenos_Aires', 'America/Argentina/Buenos_Aires'],
    ['America/Indianapolis', 'America/Indiana/Indianapolis'], ['America/Louisville', 'America/Kentucky/Louisville'],
    ['America/Coral_Harbour', 'America/Atikokan'], ['Asia/Dacca', 'Asia/Dhaka'], ['Asia/Thimbu', 'Asia/Thimphu'],
    ['Asia/Ulan_Bator', 'Asia/Ulaanbaatar'], ['Asia/Macao', 'Asia/Macau'], ['Asia/Ujung_Pandang', 'Asia/Makassar'],
    ['Africa/Asmera', 'Africa/Asmara'], ['Europe/Istanbul', 'Asia/Istanbul'], ['America/Montreal', 'America/Toronto'],
    ['Etc/UTC', 'UTC'], ['Etc/GMT', 'UTC'], ['GMT', 'UTC'],
  ];
  const PARTNERS = new Map();
  for (const [a, b] of RENAMES) {
    PARTNERS.set(a, (PARTNERS.get(a) || []).concat(b));
    PARTNERS.set(b, (PARTNERS.get(b) || []).concat(a));
  }

  /** How the table spells a Windows name: lower case, no dots, single spaces. */
  function _key(s) {
    return String(s).toLowerCase().replace(/\./g, '').replace(/\s+/g, ' ').trim();
  }

  /** A table entry, own properties only: a TZID such as "constructor" must
   *  not reach Object.prototype. */
  function _lookup(table, key) {
    return table && Object.prototype.hasOwnProperty.call(table, key) && Array.isArray(table[key]) ? table[key] : null;
  }

  function _data() {
    return (typeof ProtonCalendarTZData !== 'undefined' && ProtonCalendarTZData) || {};
  }

  /** The name without an offset around it ("(UTC+01:00) Amsterdam, ...",
   *  "Name (GMT+1)"), in linear time. */
  function _stripOffset(raw) {
    let s = raw.replace(/^\((?:UTC|GMT)[^)]*\)\s*/i, '');
    const open = s.lastIndexOf('(');
    if (open > 0 && /^\((?:UTC|GMT)[^)]*\)$/i.test(s.slice(open))) s = s.slice(0, open).trimEnd();
    return s;
  }

  // How an IANA zone name looks: Area/Location, maybe Area/Sub/Location.
  const IANA_SHAPE = /^[A-Za-z]+(?:\/[A-Za-z0-9_+-]+){1,2}$/;

  /** The trailing zone names of a name with a vendor prefix, longest first:
   *  Area/Sub/Location and Area/Location ("/citadel.org/20190914_1/Europe/
   *  Berlin", Evolution's "/freeassociation.sourceforge.net/Europe/Zagreb"),
   *  then a single alias ("/tzurl.org/2021a/Eire", "/GB/"). A leading slash
   *  marks the whole path as the vendor's ("/Europe/London/" is the zone). */
  function _tails(raw) {
    const parts = raw.split('/').filter(Boolean);
    const out = [];
    const max = Math.min(3, parts.length - (raw.startsWith('/') ? 0 : 1));
    for (let n = max; n >= 1; n--) {
      const tail = parts.slice(-n).join('/');
      if (n >= 2 ? IANA_SHAPE.test(tail) : /^[A-Za-z][A-Za-z0-9_+-]*$/.test(tail)) out.push(tail);
    }
    return out;
  }

  /**
   * The zone to store for `tzid`, or null when none is known.
   *
   * @param {string} tzid - The TZID parameter as the invitation writes it.
   * @param {Set<string>|null} allowed - The zones the API accepts, or null
   *   when that list could not be read (then the tables' first pick, or the
   *   name itself when it looks like an IANA zone, is the best guess).
   */
  function resolve(tzid, allowed) {
    const raw = String(tzid == null ? '' : tzid).trim();
    if (!raw || raw.length > MAX_TZID) return null;
    const accepts = (z) => (allowed ? allowed.has(z) : true);
    if (allowed && allowed.has(raw)) return raw;
    const data = _data();
    // A renamed zone (with the list: the spelling it accepts). Without the
    // list only the tables know which spelling the API takes, so they come
    // first and a plain IANA name is kept as written.
    if (allowed) for (const alt of PARTNERS.get(raw) || []) if (allowed.has(alt)) return alt;
    // An IANA zone or alias the API does not list (Asia/Singapore,
    // US/Eastern): a zone with the same rules that it does.
    const alias = (_lookup(data.iana, raw) || []).find(accepts);
    if (alias) return alias;
    // A Windows name or display name, possibly with an offset around it,
    // Outlook's export suffix ("... 1"), or without " Standard Time" (Lotus
    // Notes writes "W. Europe", "Eastern").
    const stripped = _stripOffset(raw);
    const k = _key(stripped);
    const bare = k.replace(/\s+\d+$/, '');
    const list = _lookup(data.windows, k) || _lookup(data.windows, bare)
      || _lookup(data.windows, k + ' standard time') || _lookup(data.windows, bare + ' standard time');
    if (list) {
      const hit = list.find(accepts);
      if (hit) return hit;
    }
    // A vendor prefix before a zone name: the name, by the same steps.
    // Without the list only a name this browser knows counts (libical's
    // "/.../Tzfile/Europe/Berlin" is Europe/Berlin, not "Tzfile/Europe/
    // Berlin"); failing that, the longest Area/Location is the guess.
    if (raw.startsWith('/') || raw.split('/').length > 3) {
      const tails = _tails(raw);
      if (allowed) {
        for (const tail of tails) {
          const hit = resolve(tail, allowed);
          if (hit) return hit;
        }
      } else {
        const known = tails.find((t) => _formatter(t) || _lookup(data.iana, t) || PARTNERS.has(t));
        if (known) return resolve(known, null) || known;
        const guess = tails.find((t) => IANA_SHAPE.test(t));
        if (guess) return guess;
      }
    }
    if (!allowed) {
      if (IANA_SHAPE.test(raw) || raw === 'UTC') return raw;
      return (PARTNERS.get(raw) || [])[0] || null; // GMT -> UTC
    }
    // An accepted zone in another case, or ending a longer identifier after
    // a slash ("/mozilla.org/20050126_1/Europe/Berlin"). Whole names only:
    // a bare "UTC" in a word, or Etc/GMT+1 inside Etc/GMT+10, never matches.
    const lower = stripped.toLowerCase();
    let best = null;
    for (const z of allowed) {
      const zl = z.toLowerCase();
      if ((lower === zl || (zl.includes('/') && lower.endsWith('/' + zl))) && (!best || z.length > best.length)) best = z;
    }
    return best;
  }

  // Intl formatters per zone; null for a zone this browser does not know.
  const _formatters = new Map();
  function _formatter(zone) {
    if (_formatters.has(zone)) return _formatters.get(zone);
    let fmt = null;
    try {
      fmt = new Intl.DateTimeFormat('en-US', {
        timeZone: zone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric',
        hour: 'numeric', minute: 'numeric', second: 'numeric',
      });
    } catch (e) { /* unknown zone */ }
    if (_formatters.size > 200) _formatters.clear();
    _formatters.set(zone, fmt);
    return fmt;
  }

  /** The zone's UTC offset (ms) at instant t. */
  function _offsetAt(fmt, t) {
    const p = {};
    for (const part of fmt.formatToParts(new Date(t))) p[part.type] = part.value;
    return Date.UTC(+p.year, +p.month - 1, +p.day, (+p.hour) % 24, +p.minute, +p.second) - t;
  }

  /** Zones to try for a TZID, nearest first: the name itself (Intl knows
   *  GMT, EST5EDT and every IANA name), its trailing Area/Location after a
   *  vendor prefix ("/citadel.org/20190914_1/Europe/Berlin"), then the
   *  tables' pick (Windows names). */
  function _zonesFor(tzid) {
    const raw = String(tzid == null ? '' : tzid).trim();
    if (!raw || raw.length > MAX_TZID) return [];
    const out = [raw, ..._tails(raw)];
    const mapped = resolve(raw, null);
    if (mapped) out.push(mapped);
    return [...new Set(out)];
  }

  /**
   * The Unix times (seconds) a date in ProtonCalendarICS.parse()'s form can
   * stand for, the way Proton stores an occurrence's RecurrenceID: a UTC
   * time as is, an all-day date at its midnight UTC, a zoned wall-clock time
   * in its zone. A wall time that a daylight-saving change skips uses the
   * offset from before the gap (RFC 5545 3.3.5). One that it repeats stands
   * for both instants, earlier first: RFC 5545 means the first, Proton's web
   * client looks an occurrence up by the second, and two occurrences of one
   * series are never a single DST shift apart. Empty for a floating time or
   * a zone that cannot be placed: a caller must then not guess.
   *
   * @param {object} dt - The date.
   * @param {string} [zone] - A zone to read the wall time in instead of
   *   dt.tzid (the zone Proton stored the event under).
   */
  function unixTimes(dt, zone) {
    if (!dt || typeof dt.year !== 'number') return [];
    const wall = Date.UTC(dt.year, dt.month - 1, dt.day, dt.hour || 0, dt.minute || 0, dt.second || 0);
    if (dt.isUTC || dt.isAllDay) return [Math.floor(wall / 1000)];
    const candidates = zone ? [zone] : (dt.tzid ? _zonesFor(dt.tzid) : []);
    for (const name of candidates) {
      const fmt = _formatter(name);
      if (!fmt) continue;
      try {
        const before = _offsetAt(fmt, wall - 86400000);
        const after = _offsetAt(fmt, wall + 86400000);
        const fits = [...new Set([wall - before, wall - after])]
          .filter((t) => t + _offsetAt(fmt, t) === wall)
          .sort((a, b) => a - b);
        return (fits.length ? fits : [wall - before]).map((t) => Math.floor(t / 1000));
      } catch (e) { /* try the next name */ }
    }
    return [];
  }

  /** The first of unixTimes(), or null: the RFC 5545 reading of the date. */
  function unixTime(dt, zone) {
    const times = unixTimes(dt, zone);
    return times.length ? times[0] : null;
  }

  return { resolve, unixTime, unixTimes, _key, MAX_TZID };
})();
