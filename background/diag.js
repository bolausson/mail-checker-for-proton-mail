/**
 * Persistent diagnostic ring buffer for auth/session + general troubleshooting.
 *
 * Unlike debugLog (console-only, wiped on every service-worker / event-page
 * suspension and on a browser restart), ProtonDiag appends structured events to
 * storage.local so they survive SW death AND a full browser close. The log is
 * therefore still there when the user opens the extension hours after a problem
 * and can be exported from the options page.
 *
 * Two entry kinds share one ring buffer:
 *  - record(event, fields): low-volume STRUCTURED events (auth/session/RSVP),
 *    always on. These are the load-bearing session-expiry diagnostics.
 *  - capture(level, msg, ctx): free-form CONSOLE lines (debugLog output, real
 *    console.warn/error, uncaught errors/rejections), mirrored only when debug
 *    logging is enabled. The caller (constants.js / popup) does the gating; this
 *    module just appends. Gives the exported log a full console trace on demand.
 *
 * NEVER pass secrets: structured callers log token *fingerprints* (ProtonDiag.fp),
 * never the raw tokens, and never keyPassword. In debug mode the captured console
 * may include emails/UIDs (the same sensitive context debugLog already prints).
 * That is the documented trade-off of turning debug logging on.
 */
const ProtonDiag = (() => {
  const KEY = '_authDiag';
  const MAX = 5000; // ring-buffer cap (oldest entries dropped), sized for
                    // multi-day diagnostic captures.

  // Serialize the read-modify-write so concurrent events (e.g. a 401 burst)
  // can't clobber each other's appends.
  let _tail = Promise.resolve();

  /** Short fingerprint of a token: last 6 chars + length. Enough to SEE a
   *  rotation (the value changes) without ever storing the secret itself. */
  function fp(token) {
    if (!token) return 'none';
    return String(token).slice(-6) + '/' + String(token).length;
  }

  /** Append one entry to the persisted ring buffer. Never throws. */
  function _append(entry) {
    _tail = _tail.then(async () => {
      try {
        const stored = await browser.storage.local.get(KEY);
        const log = stored[KEY] || [];
        log.push(entry);
        if (log.length > MAX) log.splice(0, log.length - MAX);
        await browser.storage.local.set({ [KEY]: log });
      } catch (_) {
        /* best effort: diagnostics must never break the app */
      }
    });
    return _tail;
  }

  /** Record a structured diagnostic event. Fire-and-forget, or await it to
   *  maximise the chance it is persisted before a teardown. Never throws. */
  function record(event, fields) {
    const entry = { t: new Date().toISOString(), event };
    if (fields) Object.assign(entry, fields);
    return _append(entry);
  }

  /** Mirror a console line into the log (debug-mode only; gated by the caller).
   *  `level` is debug|warn|error|uncaught|rejection; `ctx` marks a non-background
   *  origin (e.g. 'popup'). `msg` is kept LAST so spaces in it don't break the
   *  key=value export rendering. */
  // Signatures for once(), kept out of the ring buffer itself.
  const SIG_KEY = '_diagSigs';

  function capture(level, msg, ctx) {
    const entry = { t: new Date().toISOString(), event: 'log.' + level };
    if (ctx) entry.ctx = ctx;
    entry.msg = msg;
    return _append(entry);
  }

  /**
   * True the first time a fact is seen, and again only when it CHANGES.
   *
   * For facts that are true on every poll rather than events that happen:
   * an account's plan, a quiet rule matching the same mail. Deduping them in
   * memory does not work, because the MV3 worker cold-starts constantly and
   * each generation starts with an empty set. A real log showed 360
   * `account.plan` records in one 5000-entry buffer, 7% of the space, crowding
   * out the auth history the buffer exists to hold. The signature is therefore
   * kept in storage, where it outlives the worker.
   *
   * @param {string} key - what is being tracked, e.g. 'plan:<accountId>'
   * @param {string} sig - the current value; any change re-reports
   */
  async function once(key, sig) {
    try {
      const stored = await browser.storage.local.get(SIG_KEY);
      const sigs = stored[SIG_KEY] || {};
      if (sigs[key] === sig) return false;
      sigs[key] = sig;
      await browser.storage.local.set({ [SIG_KEY]: sigs });
      return true;
    } catch (e) {
      // Storage unavailable: report rather than go silent. A duplicate line is
      // a smaller problem than a fact that never reaches the log at all.
      return true;
    }
  }

  /** All recorded events (oldest first). */
  async function getAll() {
    const stored = await browser.storage.local.get(KEY);
    return stored[KEY] || [];
  }

  /** Wipe the log. */
  async function clear() {
    // The once() signatures go too. Otherwise a user who clears the log,
    // reproduces the problem and exports gets a log with no plan line and no
    // quiet-rule line, because both were already "reported" against a buffer
    // that no longer exists.
    await browser.storage.local.set({ [KEY]: [], [SIG_KEY]: {} });
  }

  return { record, capture, once, getAll, clear, fp };
})();
