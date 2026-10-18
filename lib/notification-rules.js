/**
 * ProtonNotificationRules: "quiet mail" rules.
 *
 * A rule matches incoming mail on any combination of sender address, recipient
 * address, subject and body, and switches off up to three things for the mail
 * it matches: the desktop notification, the unread badge count, and the
 * notification sound.
 *
 * Matching semantics (settled with the user, 2026-07-28):
 *  - from / to:   case-insensitive SUBSTRING of the address, so one field
 *                 covers a full address ("news@shop.com"), a whole domain
 *                 ("@shop.com") and a fragment ("noreply").
 *  - subject / body: JavaScript regular expression, case-insensitive.
 *  - Fields within a rule are ANDed; empty fields are ignored (the usual mail
 *    filter convention). Rules are ORed: every matching rule contributes its
 *    actions.
 *
 * Two deliberate safety properties:
 *  - A rule with no conditions never matches. Otherwise a half-filled row
 *    would silence the entire mailbox: the worst possible failure for a
 *    feature whose job is to hide notifications.
 *  - An unparseable regex never matches (and never throws). The options page
 *    reports it via validate(); at delivery time a broken pattern must not
 *    take the poller down or silence everything.
 *
 * Pure and DOM-free so both the background and the options page can use it,
 * and so the semantics are unit-testable.
 */
const ProtonNotificationRules = (() => {
  'use strict';

  /** Guard against a pathological user-supplied pattern (their own browser is
   *  the victim, but a runaway regex in the poller is still ours to prevent). */
  const MAX_PATTERN_LENGTH = 500;
  /** Cap the text a regex runs over. Bodies can be megabytes. */
  const MAX_BODY_CHARS = 100000;
  /** A rule's display name is a label, not data. Keep it to one line. */
  const MAX_NAME_LENGTH = 60;

  const ACTIONS = [
    'silenceNotification', 'excludeFromCount', 'muteSound',
    // Keep the mail out of the popup's message list entirely.
    'hideFromInbox',
  ];

  const _regexCache = new Map();

  const str = (v) => (v == null ? '' : String(v));

  /** Compile a user pattern; null when empty or invalid (never throws). */
  function compile(pattern) {
    const p = str(pattern);
    if (!p || p.length > MAX_PATTERN_LENGTH) return null;
    if (_regexCache.has(p)) return _regexCache.get(p);
    let re = null;
    try {
      re = new RegExp(p, 'i');
    } catch (e) {
      re = null; // invalid: validate() surfaces this in the options UI
    }
    if (_regexCache.size > 200) _regexCache.clear();
    _regexCache.set(p, re);
    return re;
  }

  /** Canonical rule object; tolerates partial/legacy input. */
  function normalize(raw) {
    const r = raw || {};
    return {
      id: str(r.id) || 'r' + Math.random().toString(36).slice(2, 10),
      enabled: r.enabled !== false,
      // Label only, never part of matching. Lets the options page show one
      // collapsed line per rule instead of a wall of fields.
      name: str(r.name).trim().slice(0, MAX_NAME_LENGTH),
      from: str(r.from).trim(),
      // The sender's DISPLAY name ("HUGO BOSS News"), which is what the
      // message list shows and is often unrelated to the address.
      fromName: str(r.fromName).trim(),
      to: str(r.to).trim(),
      subject: str(r.subject).trim(),
      body: str(r.body).trim(),
      silenceNotification: !!r.silenceNotification,
      excludeFromCount: !!r.excludeFromCount,
      muteSound: !!r.muteSound,
      hideFromInbox: !!r.hideFromInbox,
    };
  }

  /** Every field that can narrow a rule, in UI order. */
  const CONDITIONS = ['from', 'fromName', 'to', 'subject', 'body'];

  /** Does the rule test anything at all? */
  function hasConditions(rule) {
    const r = normalize(rule);
    return CONDITIONS.some((f) => !!r[f]);
  }

  /** Does the rule do anything if it matches? */
  function hasActions(rule) {
    const r = normalize(rule);
    return ACTIONS.some((a) => r[a]);
  }

  /**
   * Report what's wrong with a rule, for the options page.
   * @returns {{ok: boolean, errors: {subject?: string, body?: string},
   *            noConditions: boolean, noActions: boolean}}
   */
  function validate(rule) {
    const r = normalize(rule);
    const errors = {};
    for (const field of ['subject', 'body']) {
      if (!r[field]) continue;
      if (r[field].length > MAX_PATTERN_LENGTH) {
        errors[field] = 'tooLong';
      } else if (!compile(r[field])) {
        errors[field] = 'invalidRegex';
      }
    }
    const noConditions = !hasConditions(r);
    const noActions = !hasActions(r);
    return { ok: Object.keys(errors).length === 0 && !noConditions, errors, noConditions, noActions };
  }

  const contains = (haystack, needle) =>
    str(haystack).toLowerCase().includes(str(needle).toLowerCase());

  /**
   * @param {object} rule
   * @param {{from?: string, to?: string[], subject?: string, body?: string}} view
   */
  function matches(rule, view) {
    const r = normalize(rule);
    if (!r.enabled || !hasConditions(r)) return false;
    const v = view || {};

    if (r.from && !contains(v.from, r.from)) return false;

    if (r.fromName && !contains(v.fromName, r.fromName)) return false;

    if (r.to) {
      const recipients = Array.isArray(v.to) ? v.to : [v.to];
      if (!recipients.some((addr) => contains(addr, r.to))) return false;
    }

    if (r.subject) {
      const re = compile(r.subject);
      if (!re || !re.test(str(v.subject))) return false;
    }

    if (r.body) {
      const re = compile(r.body);
      if (!re || !re.test(str(v.body).slice(0, MAX_BODY_CHARS))) return false;
    }

    return true;
  }

  /**
   * Combined effect of every matching rule.
   * @returns {{silenceNotification: boolean, excludeFromCount: boolean,
   *            muteSound: boolean, hideFromInbox: boolean, matched: string[]}}
   */
  function evaluate(rules, view) {
    const out = {
      silenceNotification: false, excludeFromCount: false, muteSound: false,
      hideFromInbox: false, matched: [],
    };
    if (!Array.isArray(rules)) return out;
    for (const raw of rules) {
      if (!matches(raw, view)) continue;
      const r = normalize(raw);
      out.matched.push(r.id);
      for (const a of ACTIONS) if (r[a]) out[a] = true;
    }
    return out;
  }

  /** Would evaluating these rules require the message body? Used to avoid
   *  fetching and decrypting bodies for users who have no body rule. */
  function needsBody(rules) {
    if (!Array.isArray(rules)) return false;
    return rules.some((raw) => {
      const r = normalize(raw);
      return r.enabled && !!r.body && hasConditions(r);
    });
  }

  /** Rules that can actually do something (the only ones worth evaluating). */
  function activeRules(rules) {
    if (!Array.isArray(rules)) return [];
    return rules.filter((raw) => {
      const r = normalize(raw);
      return r.enabled && hasConditions(r) && hasActions(r);
    });
  }

  return {
    normalize, validate, matches, evaluate, needsBody, activeRules,
    hasConditions, hasActions, compile, CONDITIONS,
    ACTIONS, MAX_PATTERN_LENGTH, MAX_BODY_CHARS, MAX_NAME_LENGTH,
  };
})();

if (typeof window !== 'undefined') window.ProtonNotificationRules = ProtonNotificationRules;
