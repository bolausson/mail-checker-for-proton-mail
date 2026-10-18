/**
 * Premium / trial / license module for Mail Checker for Proton Mail.
 *
 * Two independent unlock paths:
 *   1. 14-day trial:  starts on user click, no credit card required,
 *      purely client-side (no validation server-side). Offered once, and
 *      never after any license (_licEverLicensed), even one that never paid.
 *   2. License key:   Paddle subscription ID entered manually (or a txn_ ID
 *      resolved to one); checked against our Scaleway serverless proxy, which
 *      talks to Paddle. Its answers, and how each is handled, are listed below.
 *
 * Premium = a stored key that is neither held nor locked, OR an active trial.
 * State is stored in browser.storage.local and mirrored to storage.sync when
 * settings sync is on. The scheduling stamps (LOCAL_ONLY_KEYS) never leave
 * this device.
 *
 * What a proxy answer does:
 *   - ok (active, trialing, a past_due that paid before): Premium. The key
 *     becomes "confirmed": it has had a definite answer from Paddle.
 *   - HOLD (subscription_unpaid, subscription_paused): the key is kept and
 *     confirmed, Premium is off, and it comes back by itself once a later
 *     check answers ok. No grace and no lock apply to a held key.
 *   - REFUSAL (not found, wrong product, canceled, invalid, and the old
 *     proxy's inactive / expired / scheduled_cancel): an activation is
 *     refused. A stored key is deleted only when canceled or never confirmed;
 *     for a confirmed key any other refusal can only be a proxy fault, so it
 *     counts as transient.
 *   - anything else (network, proxy, Paddle 5xx, a body we cannot read):
 *     transient. Premium stays through a grace period from the first failure
 *     of the streak: 30 days for a confirmed key, 3 for an unconfirmed one.
 *     After that the key is locked (kept, Premium off) until a check succeeds.
 *
 * When to check (_nextCheck): after an ok, 1 h after the next billing date or
 * scheduled change (1 h to 30 days away); daily while past_due or held; after
 * a transient failure hourly, then every 6 h once the streak is a day old;
 * quick follow-ups for a few hours after the user asks for the update-payment
 * link. The due time is stamped (_licNextCheckAt) BEFORE every request, and
 * the alarm only wakes the check: a wake before the stamp re-arms instead of
 * fetching, so neither a hung request nor a stopped worker repeats a check.
 */

const ProtonPremium = (() => {
  // Paddle checkout page. With no ?plan= param it opens the monthly plan;
  // the page itself surfaces the yearly option.
  const CHECKOUT_URL = 'https://apps.olausson.de/mail_checker_for_proton/checkout.html';

  // Serverless proxy that validates Paddle subscriptions on the extension's
  // behalf (so the Paddle API key never ships in the XPI).
  // Fronts a Scaleway Serverless Function (EU, nl-ams) via CNAME.
  const WORKER_BASE_URL = 'https://mcpm-license.olausson.de';

  const MINUTE_MS = 60 * 1000;
  const HOUR_MS = 60 * MINUTE_MS;
  const DAY_MS = 24 * HOUR_MS;

  // Trial length.
  const TRIAL_DURATION_MS = 14 * DAY_MS;

  // Grace after the first failed check of a streak. A key Paddle has answered
  // for keeps Premium through a month of proxy outage; a key that never had
  // an answer (stored while offline) only for 3 days, so a mistyped ID cannot
  // unlock Premium for long.
  const GRACE_CONFIRMED_MS = 30 * DAY_MS;
  const GRACE_UNCONFIRMED_MS = 3 * DAY_MS;

  // Check cadence (see _nextCheck).
  const MIN_CHECK_DELAY_MS = MINUTE_MS;
  const MAX_CHECK_DELAY_MS = 30 * DAY_MS;
  const RENEWAL_MARGIN_MS = HOUR_MS;        // after a billing date, give Paddle time to charge
  const NO_ANCHOR_DELAY_MS = DAY_MS;
  const PAYMENT_ISSUE_DELAY_MS = DAY_MS;    // past_due, unpaid, paused
  const RETRY_DELAY_MS = HOUR_MS;
  const RETRY_SLOW_DELAY_MS = 6 * HOUR_MS;
  const RETRY_SLOW_AFTER_MS = DAY_MS;
  // No cadence produces a stamp further ahead than this: one that is is a
  // clock that stepped back, or a corrupt value, and the check is due.
  const STAMP_MAX_AHEAD_MS = MAX_CHECK_DELAY_MS + HOUR_MS;
  // Timers can fire a little early; a wake this close to the stamp is due.
  const DUE_SLACK_MS = 30 * 1000;

  // After the update-payment link is served while a payment is failing:
  // re-check at these offsets so a fixed payment shows within minutes.
  const FOLLOW_UP_WINDOW_MS = 3 * HOUR_MS;
  const FOLLOW_UP_STEPS_MS = [2 * MINUTE_MS, 10 * MINUTE_MS, 30 * MINUTE_MS, 2 * HOUR_MS];
  // Opening the popup or options while a payment is failing checks at most
  // this often.
  const NUDGE_MIN_GAP_MS = 5 * MINUTE_MS;

  // How long the reason for an automatic clear is shown next to the key field.
  const CLEARED_REASON_MS = 30 * DAY_MS;

  // Under Chrome's 30 s limit for a fetch in a service worker: past that the
  // worker can be stopped mid-request.
  const FETCH_TIMEOUT_MS = 25 * 1000;

  const VALIDATION_ALARM = 'proton-premium-validate';

  // Only subscription IDs are accepted as the license. Transaction IDs are
  // renewal-unstable, but we do accept them as *input* and resolve to a sub_
  // via the proxy, helpful for users who only have the txn_ from their invoice.
  // Paddle IDs are ULIDs: 26 lowercase Crockford base32 characters (no i, l,
  // o, u), the first one 0-7. Input is trimmed and lowercased first.
  const KEY_PATTERN = /^sub_[0-7][0-9a-hjkmnp-tv-z]{25}$/;
  const TXN_PATTERN = /^txn_[0-7][0-9a-hjkmnp-tv-z]{25}$/;
  // Paddle creates the subscription a few seconds after checkout.completed,
  // so the txn→sub lookup may report not_ready for a bit. Poll with backoff.
  const TXN_LOOKUP_ATTEMPTS = 5;
  const TXN_LOOKUP_DELAY_MS = 3000;

  // Paddle's definite "not paid": the key is kept, Premium is off.
  const HOLD_ERRORS = new Map([
    ['subscription_unpaid', 'unpaid'],
    ['subscription_paused', 'paused'],
  ]);
  // Paddle's definite "no". Every other code is transient (see _classify).
  const REFUSAL_ERRORS = new Set([
    'subscription_not_found',
    'subscription_wrong_product',
    'subscription_canceled',
    'invalid_request',
    // Contract 1 only (the proxy before 2026-09-23).
    'subscription_inactive',
    'subscription_expired',
    'subscription_scheduled_cancel',
  ]);
  // Clears by these codes (1.14.x wrote them) mean the key was a real
  // license, so the trial is not offered again.
  const EVER_LICENSED_CLEARS = new Set([
    'subscription_canceled', 'subscription_paused', 'subscription_expired',
    'subscription_inactive', 'subscription_scheduled_cancel',
  ]);

  // Storage keys. Underscore-prefixed to avoid clashing with settings.
  const KEY_LICENSE = '_premiumKey';
  const KEY_TRIAL_END = '_trialEnd';
  const KEY_LAST_VALIDATED = '_licLastValidatedAt';
  const KEY_FIRST_FAILED = '_licFirstFailedAt';
  const KEY_LAST_ERROR = '_licLastError';
  const KEY_LAST_STATUS = '_licLastStatus';
  // Plan + period info captured from the most recent definite answer,
  // shown to the user in the options page.
  const KEY_BILLING_INTERVAL = '_licBillingInterval';
  const KEY_PERIOD_START = '_licPeriodStart';
  const KEY_PERIOD_END = '_licPeriodEnd';
  const KEY_NEXT_BILLED = '_licNextBilledAt';
  const KEY_SCHEDULED_CHANGE = '_licScheduledChange';
  // Tombstone set when a license is removed or terminally cleared. Blocks
  // init()'s sync-adoption path from resurrecting stale synced license state
  // on this device (and, when synced, propagates the removal to others).
  const KEY_CLEARED = '_licCleared';
  // The subscription ID that last had a definite answer (ok, unpaid or
  // paused). It only counts for the key stored now, so any key change,
  // including a key adopted from sync, starts unconfirmed again.
  const KEY_CONFIRMED = '_licConfirmedKey';
  // When a key first had a definite answer (ms). Never cleared.
  const KEY_EVER_LICENSED = '_licEverLicensed';
  // Local only: when the next check is due, the follow-up window after the
  // update-payment link and its step, and the last popup/options nudge.
  const KEY_NEXT_CHECK = '_licNextCheckAt';
  const KEY_FOLLOW_UP_UNTIL = '_licFollowUpUntil';
  const KEY_FOLLOW_UP_STEP = '_licFollowUpStep';
  const KEY_LAST_NUDGE = '_licLastNudgeAt';

  const SYNCED_KEYS = [
    KEY_LICENSE, KEY_TRIAL_END,
    KEY_LAST_VALIDATED, KEY_FIRST_FAILED, KEY_LAST_ERROR, KEY_LAST_STATUS,
    KEY_BILLING_INTERVAL, KEY_PERIOD_START, KEY_PERIOD_END,
    KEY_NEXT_BILLED, KEY_SCHEDULED_CHANGE, KEY_CLEARED,
    KEY_CONFIRMED, KEY_EVER_LICENSED,
  ];
  const LOCAL_ONLY_KEYS = [KEY_NEXT_CHECK, KEY_FOLLOW_UP_UNTIL, KEY_FOLLOW_UP_STEP, KEY_LAST_NUDGE];

  // In-memory state (mirrors storage).
  let _licenseKey = null;
  let _trialEnd = 0;
  let _lastValidatedAt = 0;    // ms of the last definite answer ("Paddle last answered"); 0 = never
  let _firstFailedAt = 0;      // ms since epoch of first failure in current streak; 0 = no failure
  let _lastError = null;       // error code of the last failed check; the hold code while held
  let _lastStatus = null;      // Paddle status of the last definite answer
  let _billingInterval = null; // 'month' | 'year' | null
  let _periodStart = null;     // ISO datetime string from Paddle, or null
  let _periodEnd = null;       // ISO datetime string from Paddle, or null (trialing: projected, see _callValidate)
  let _nextBilledAt = null;    // ISO datetime string from Paddle, or null
  let _scheduledChange = null; // { action, effective_at } or null
  let _cleared = 0;            // ms since epoch of explicit removal/terminal clear; 0 = never
  let _confirmedKey = null;
  let _everLicensed = 0;
  let _nextCheckAt = 0;
  let _followUpUntil = 0;
  let _followUpStep = 0;
  let _lastNudgeAt = 0;

  /** Load persisted state and schedule the next validation. */
  async function init() {
    const local = await browser.storage.local.get([...SYNCED_KEYS, ...LOCAL_ONLY_KEYS]);
    let synced = {};
    let syncedTombstone = null;
    // Sync storage is an ADOPTION source for a license activated on another
    // device (or before a reinstall). Local state is authoritative on this
    // device: only look at sync when no license is known locally AND none
    // was explicitly removed here (tombstone). Otherwise stale synced data
    // would resurrect a removed license. A tombstone arriving VIA sync means
    // the removal happened on another device: honour it, don't adopt, but
    // keep the trial and license history so the trial is not offered again.
    if (!local[KEY_LICENSE] && !local[KEY_CLEARED]) {
      try { synced = await browser.storage.sync.get(SYNCED_KEYS); } catch (e) { /* no sync */ }
      if (synced[KEY_CLEARED]) {
        syncedTombstone = synced;
        synced = { [KEY_TRIAL_END]: synced[KEY_TRIAL_END], [KEY_EVER_LICENSED]: synced[KEY_EVER_LICENSED] };
      }
    }

    _licenseKey       = local[KEY_LICENSE] || synced[KEY_LICENSE] || null;
    _trialEnd         = local[KEY_TRIAL_END] || synced[KEY_TRIAL_END] || 0;
    _lastValidatedAt  = local[KEY_LAST_VALIDATED] || synced[KEY_LAST_VALIDATED] || 0;
    _firstFailedAt    = local[KEY_FIRST_FAILED] || synced[KEY_FIRST_FAILED] || 0;
    _lastError        = local[KEY_LAST_ERROR] || synced[KEY_LAST_ERROR] || null;
    _lastStatus       = local[KEY_LAST_STATUS] || synced[KEY_LAST_STATUS] || null;
    _billingInterval  = local[KEY_BILLING_INTERVAL] || synced[KEY_BILLING_INTERVAL] || null;
    _periodStart      = local[KEY_PERIOD_START] || synced[KEY_PERIOD_START] || null;
    _periodEnd        = local[KEY_PERIOD_END] || synced[KEY_PERIOD_END] || null;
    _nextBilledAt     = local[KEY_NEXT_BILLED] || synced[KEY_NEXT_BILLED] || null;
    _scheduledChange  = _parseScheduledChange(local[KEY_SCHEDULED_CHANGE] || synced[KEY_SCHEDULED_CHANGE]);
    _cleared          = local[KEY_CLEARED] || 0;
    _confirmedKey     = local[KEY_CONFIRMED] || synced[KEY_CONFIRMED] || null;
    _everLicensed     = local[KEY_EVER_LICENSED] || synced[KEY_EVER_LICENSED] || 0;
    _nextCheckAt      = _finiteOr0(local[KEY_NEXT_CHECK]);
    _followUpUntil    = _finiteOr0(local[KEY_FOLLOW_UP_UNTIL]);
    _followUpStep     = _finiteOr0(local[KEY_FOLLOW_UP_STEP]);
    _lastNudgeAt      = _finiteOr0(local[KEY_LAST_NUDGE]);

    // Upgrade from 1.14.x, which had none of the new keys. This must read
    // _lastValidatedAt BEFORE the adoption below zeroes it. A missing
    // _licNextCheckAt needs nothing here: it means due, so every existing
    // license is checked once after the update.
    const absent = k => local[k] === undefined && synced[k] === undefined;
    const hadAnswer = _lastValidatedAt > 0 || !!_lastStatus;
    let migrated = false;
    if (_licenseKey && hadAnswer && absent(KEY_CONFIRMED)) {
      _confirmedKey = _licenseKey;
      migrated = true;
    }
    if (absent(KEY_EVER_LICENSED)) {
      const clearedAt = _cleared || (syncedTombstone && syncedTombstone[KEY_CLEARED]) || 0;
      const clearReason = _cleared ? _lastError : syncedTombstone && syncedTombstone[KEY_LAST_ERROR];
      // Not for not_found or wrong_product clears: that key was never a license.
      if (hadAnswer || (clearedAt && EVER_LICENSED_CLEARS.has(clearReason))) {
        _everLicensed = _lastValidatedAt || clearedAt || Date.now();
        migrated = true;
      }
    }

    // Adopted a synced license: persist it locally right away (so this device
    // no longer depends on sync reads) and distrust the synced validation
    // timestamp: the subscription may have changed since the other device
    // last validated, so the init-time re-validation below must run now.
    const adopted = !local[KEY_LICENSE] && !!_licenseKey;
    if (adopted) {
      _lastValidatedAt = 0;
      _nextCheckAt = 0;
    }
    if (adopted || (migrated && _licenseKey)) {
      await _save();
      if (adopted) debugLog('[ProtonPremium] Adopted synced license', _maskKey(_licenseKey), '- revalidating');
    } else if (migrated) {
      // No key: only the history is new. A full _save() would overwrite a
      // tombstone in storage.sync with this device's empty state.
      await browser.storage.local.set({ [KEY_EVER_LICENSED]: _everLicensed });
    }

    _premiumSeen = isPremium();
    debugLog('[ProtonPremium] Initialized',
      'premium:', _premiumSeen,
      'licensed:', !!_licenseKey,
      'held:', _heldState(),
      'trial:', isTrialing(),
      _lastError ? 'lastError:' + _lastError : '');

    if (_licenseKey) {
      const now = Date.now();
      if (_checkDue(now)) {
        // Fires async, don't block init. It stamps and arms the next check.
        validateLicense().catch(() => {});
      } else {
        // Firefox does not keep alarms across a browser restart: re-arm a
        // missing one from the stamp. A pending one is left alone.
        _armCheck(false, _nextCheckAt - now).catch(() => {});
      }
    }
  }

  /** Handle an alarm. Every alarm also notices a trial or grace running out. */
  function handleAlarm(alarm) {
    _notifyIfPremiumChanged();
    if (!alarm || alarm.name !== VALIDATION_ALARM || !_licenseKey) return Promise.resolve();
    const now = Date.now();
    if (_checkDue(now)) return validateLicense().catch(() => {});
    // An alarm from before a reschedule, or re-armed at init: wait for the stamp.
    return _armCheck(true, _nextCheckAt - now).catch(() => {});
  }

  /** Is the stored key's next check due? No or an absurd stamp means yes. */
  function _checkDue(now) {
    if (!(_nextCheckAt > 0)) return true;
    if (_nextCheckAt - now > STAMP_MAX_AHEAD_MS) return true;
    return now >= _nextCheckAt - DUE_SLACK_MS;
  }

  /**
   * Schedule the next background license check.
   *
   * init() runs on every background wake, and clearing and re-creating the
   * alarm there restarted its countdown each time, so it only ever fired when
   * nothing woke the background for the whole interval (the poll alarm and
   * the token-refresh alarm had the same bug). `replace` is for a completed
   * check or a new stamp, when the alarm must move to the new delay.
   */
  async function _scheduleNextValidation(replace, delayMs) {
    if (!replace) {
      try {
        if (await browser.alarms.get(VALIDATION_ALARM)) return;
      } catch (_) { /* fall through and (re)create */ }
    }
    try { await browser.alarms.clear(VALIDATION_ALARM); } catch (_) { /* none to clear */ }
    // Clamped and never NaN: the stamp decides, the alarm only wakes the check.
    const ms = Math.min(Math.max(Number(delayMs) || 0, MIN_CHECK_DELAY_MS), MAX_CHECK_DELAY_MS);
    await browser.alarms.create(VALIDATION_ALARM, { delayInMinutes: ms / 60000 });
  }

  // Alarm operations run one after another, so the alarm matches the latest
  // stamp: a check finishing while init() re-arms, or while a follow-up
  // starts, would otherwise interleave clear/create and keep an older delay.
  let _alarmQueue = Promise.resolve();
  function _queueAlarmOp(op) {
    const run = _alarmQueue.then(op);
    _alarmQueue = run.catch(() => {});
    return run;
  }
  function _armCheck(replace, delayMs) {
    return _queueAlarmOp(() => _scheduleNextValidation(replace, delayMs));
  }
  function _disarmCheck() {
    return _queueAlarmOp(() => browser.alarms.clear(VALIDATION_ALARM)).catch(() => {});
  }

  /** Stamp the next check `delayMs` from now and move the alarm there. The
   *  caller persists the stamp. */
  function _setNextCheck(delayMs) {
    _nextCheckAt = Date.now() + delayMs;
    return _armCheck(true, delayMs);
  }

  /**
   * When to check next after an outcome: 'ok', 'hold' or 'transient'.
   * Returns { delay, step }: `step` is the follow-up step it arms, or -1.
   * While a follow-up window is open its steps come first; the first ok
   * that is not past_due has already closed it (_applyOk).
   */
  function _nextCheck(kind, result, now) {
    const followUp = _followUpNext(now);
    if (followUp) return followUp;
    return { delay: _cadence(kind, result, now), step: -1 };
  }

  function _cadence(kind, result, now) {
    if (kind === 'transient') {
      const streak = _firstFailedAt ? now - _firstFailedAt : 0;
      return streak < RETRY_SLOW_AFTER_MS ? RETRY_DELAY_MS : RETRY_SLOW_DELAY_MS;
    }
    if (kind === 'hold' || result.status === 'past_due') return PAYMENT_ISSUE_DELAY_MS;
    const anchor = _anchorMs(result);
    if (!(anchor > now)) return NO_ANCHOR_DELAY_MS; // missing, past or unparseable
    return Math.min(Math.max(anchor + RENEWAL_MARGIN_MS - now, HOUR_MS), MAX_CHECK_DELAY_MS);
  }

  /**
   * The date the subscription next changes: a scheduled change, else the next
   * billing date (a Paddle trial's end), else the RAW period end. Never the
   * trialing period end projected for display: that is up to a year away,
   * while the trial ends within days.
   */
  function _anchorMs(result) {
    const sc = result.scheduledChange;
    const raw = (sc && sc.effective_at) || result.nextBilledAt || result.rawPeriodEnd || null;
    return typeof raw === 'string' ? Date.parse(raw) : NaN;
  }

  function _followUpNext(now) {
    if (!_followUpUntil || now >= _followUpUntil) return null;
    if (_followUpUntil - now > FOLLOW_UP_WINDOW_MS) return null; // clock stepped back
    const start = _followUpUntil - FOLLOW_UP_WINDOW_MS;
    for (let step = 0; step < FOLLOW_UP_STEPS_MS.length; step++) {
      const at = start + FOLLOW_UP_STEPS_MS[step];
      if (at - now > DUE_SLACK_MS) return { delay: Math.max(at - now, MIN_CHECK_DELAY_MS), step };
    }
    return null;
  }

  /**
   * The one ending for every stored outcome (setLicenseKey and every check):
   * stamp and arm the next check, persist, and tell listeners when Premium
   * flipped.
   */
  async function _finishCheck(kind, result) {
    const now = Date.now();
    const next = _nextCheck(kind, result, now);
    if (_followUpUntil) {
      if (now >= _followUpUntil) { _followUpUntil = 0; _followUpStep = 0; }
      else _followUpStep = next.step >= 0 ? next.step : FOLLOW_UP_STEPS_MS.length;
    }
    const armed = _setNextCheck(next.delay);
    await _save();
    await armed.catch(() => {});
    _notifyIfPremiumChanged();
  }

  // --- Premium-change hook ---

  // Premium can flip without any message: a check answering "unpaid", a grace
  // period running out, a trial ending. The background re-applies the poll
  // interval and the badge when it does.
  const _premiumListeners = [];
  let _premiumSeen = null;
  function onPremiumChange(cb) {
    if (typeof cb === 'function') _premiumListeners.push(cb);
  }
  function _notifyIfPremiumChanged() {
    const now = isPremium();
    const before = _premiumSeen;
    _premiumSeen = now;
    if (before === null || before === now) return;
    for (const cb of _premiumListeners) {
      try { cb(now); } catch (e) { debugLog('[ProtonPremium] Premium-change listener failed:', e.message); }
    }
  }

  // --- State queries ---

  /** Premium = licensed (not held, not locked by failed-validation grace) OR active trial. */
  function isPremium() {
    if (_licenseKey && !_heldState() && !_licenseLocked()) return true;
    return _trialRunning();
  }

  /** 'unpaid' | 'paused' when Paddle's last definite answer was a hold, else null. */
  function _heldState() {
    return _licenseKey ? (HOLD_ERRORS.get(_lastError) || null) : null;
  }

  function _isPastDue() {
    return !!_licenseKey && !_heldState() && _lastStatus === 'past_due';
  }

  function _isConfirmed() {
    return !!_licenseKey && _confirmedKey === _licenseKey;
  }

  function _graceMs() {
    return _isConfirmed() ? GRACE_CONFIRMED_MS : GRACE_UNCONFIRMED_MS;
  }

  /** True when grace period has elapsed without a successful validation. */
  function _licenseLocked() {
    if (!_firstFailedAt) return false; // no failure streak → not locked
    return (Date.now() - _firstFailedAt) > _graceMs();
  }

  function _trialRunning() {
    return _trialEnd > 0 && Date.now() < _trialEnd;
  }
  function isTrialing() {
    return !_licenseKey && _trialRunning();
  }
  function trialExpired() {
    return !_licenseKey && _trialEnd > 0 && Date.now() >= _trialEnd;
  }
  function trialAvailable() { return _trialEnd === 0 && !_licenseKey && !_everLicensed; }
  function trialDaysRemaining() {
    if (!_trialEnd || Date.now() >= _trialEnd) return 0;
    return Math.ceil((_trialEnd - Date.now()) / DAY_MS);
  }

  // --- Trial ---

  async function startTrial() {
    // Refused here, not only hidden in the UI: never a trial after a license.
    if (!trialAvailable()) return { error: 'trial_unavailable' };
    _trialEnd = Date.now() + TRIAL_DURATION_MS;
    await _save();
    _notifyIfPremiumChanged();
    debugLog('[ProtonPremium] Trial started, ends:', new Date(_trialEnd).toISOString());
    return { success: true, daysRemaining: trialDaysRemaining() };
  }

  // --- License key entry ---

  function openPaymentPage() { return browser.tabs.create({ url: CHECKOUT_URL }); }

  /**
   * Store and validate a new license key. Accepts a `sub_xxx` directly, or a
   * Paddle `txn_xxx` that we resolve to its subscription via the proxy.
   * Resolution polls briefly because Paddle creates the subscription async
   * after a transaction settles.
   */
  async function setLicenseKey(key) {
    if (typeof key !== 'string') return { error: 'invalid_format' };
    let id = key.trim().toLowerCase();

    // If the user pasted a transaction ID, look up the subscription.
    if (id.startsWith('txn_')) {
      if (!TXN_PATTERN.test(id)) return { error: 'invalid_format' };
      const resolved = await _resolveTxnToSub(id);
      if (!resolved.ok) return { error: resolved.error };
      id = resolved.subscription_id.trim().toLowerCase();
    }

    if (!KEY_PATTERN.test(id)) return { error: 'invalid_format' };

    // Validate BEFORE storing so users see errors immediately.
    const result = await _callValidate(id, 'activation');
    const kind = _classify(result);
    if (kind === 'refusal') return { error: result.error };

    const now = Date.now();
    if (_licenseKey !== id) _resetKeyState();
    _licenseKey = id;
    _cleared = 0;
    if (kind === 'ok') _applyOk(id, result, now);
    else if (kind === 'hold') _applyHold(id, result, now);
    // Offline or a proxy fault: store the key and rely on later checks, which
    // keep asking as an activation until Paddle has answered for it.
    else _applyTransient(result, now);
    await _finishCheck(kind, result);

    if (kind === 'ok') {
      debugLog('[ProtonPremium] License activated:', _maskKey(id), 'status:', _lastStatus, 'plan:', _billingInterval);
      return { success: true };
    }
    if (kind === 'hold') {
      debugLog('[ProtonPremium] License stored, held:', _heldState());
      return { success: true, held: _heldState() };
    }
    debugLog('[ProtonPremium] Key stored but initial validation failed (grace):', result.error);
    return { success: true, warning: result.error };
  }

  async function removeLicenseKey() {
    await _dropLicense(null);
    debugLog('[ProtonPremium] License key removed');
  }

  /** Forget the key. `reason` is the refusal code of an automatic clear
   *  (shown next to the key field for a while), null for a removal. */
  async function _dropLicense(reason) {
    _licenseKey = null;
    _resetKeyState();
    _lastError = reason;
    _cleared = Date.now();
    _nextCheckAt = 0;
    _disarmCheck();
    await _save();
    _notifyIfPremiumChanged();
  }

  /** Everything learnt about the previous key. */
  function _resetKeyState() {
    // Including its confirmation: kept, a swap to another key and back while
    // offline would bring a held key back as confirmed, with no hold and the
    // 30-day grace.
    _confirmedKey = null;
    _lastValidatedAt = 0;
    _firstFailedAt = 0;
    _lastError = null;
    _lastStatus = null;
    _billingInterval = null;
    _periodStart = null;
    _periodEnd = null;
    _nextBilledAt = null;
    _scheduledChange = null;
    _followUpUntil = 0;
    _followUpStep = 0;
    _lastNudgeAt = 0;
  }

  // --- Validation ---

  /** 'ok' | 'hold' | 'refusal' | 'transient' for a _callValidate result. */
  function _classify(result) {
    if (result.ok) return 'ok';
    if (HOLD_ERRORS.has(result.error)) return 'hold';
    if (REFUSAL_ERRORS.has(result.error)) return 'refusal';
    return 'transient';
  }

  function _applyAnswerFields(result) {
    _billingInterval = result.billingInterval || null;
    _periodStart = result.periodStart || null;
    _periodEnd = result.periodEnd || null;
    _nextBilledAt = result.nextBilledAt || null;
    _scheduledChange = result.scheduledChange || null;
  }

  function _applyOk(key, result, now) {
    _confirmedKey = key;
    if (!_everLicensed) _everLicensed = now;
    _lastValidatedAt = now;
    _firstFailedAt = 0;
    _lastError = null;
    _lastStatus = result.status || 'active';
    _applyAnswerFields(result);
    // The payment went through: stop the follow-up checks.
    if (_lastStatus !== 'past_due') { _followUpUntil = 0; _followUpStep = 0; }
  }

  function _applyHold(key, result, now) {
    _confirmedKey = key;
    if (!_everLicensed) _everLicensed = now;
    // "Paddle last answered": a hold is a definite answer, not a failure.
    _lastValidatedAt = now;
    _firstFailedAt = 0;
    _lastError = result.error;
    _lastStatus = result.status || (result.error === 'subscription_paused' ? 'paused' : 'past_due');
    _applyAnswerFields(result);
  }

  function _applyTransient(result, now) {
    // The streak drives the grace period and the retry backoff. A held key
    // keeps its hold: its error stays the hold code, and getStatus shows no
    // grace for it, so the streak only paces the retries.
    if (!_firstFailedAt) _firstFailedAt = now;
    if (!_heldState()) _lastError = result.error;
  }

  /**
   * Validate the stored license against the proxy.
   * Updates state and returns a result object.
   */
  // One check at a time. The validation alarm now actually fires (it is no
  // longer re-created on every wake), and a cold wake's init() also validates
  // when due, so both could run at once; a late transient failure then
  // put a license that had just validated into the failed-validation state.
  let _validateInFlight = null;
  function validateLicense() {
    if (!_validateInFlight) {
      _validateInFlight = _validateLicenseOnce().finally(() => { _validateInFlight = null; });
    }
    return _validateInFlight;
  }

  async function _validateLicenseOnce() {
    const key = _licenseKey;
    if (!key) return { ok: false, error: 'no_license' };

    // Stamp the retry BEFORE the request: if it hangs or the worker is stopped
    // mid-request, the next wake finds the check not due instead of firing
    // another one, and the alarm still brings the retry.
    const retry = _nextCheck('transient', null, Date.now());
    const armed = _setNextCheck(retry.delay);
    await _saveLocal();
    await armed.catch(() => {});

    // 'activation' until Paddle has answered for this key: the proxy refuses
    // a wrong key only on an activation (on a refresh it can only be a fault).
    const result = await _callValidate(key, _isConfirmed() ? 'refresh' : 'activation');

    // The key was removed or replaced meanwhile: this answer is about a key
    // that is gone, and the new key's state and stamp must not be touched.
    if (_licenseKey !== key) {
      debugLog('[ProtonPremium] Dropping a check result for a replaced key');
      return { ok: false, error: 'key_changed' };
    }

    const now = Date.now();
    const kind = _classify(result);
    if (kind === 'ok') {
      _applyOk(key, result, now);
      debugLog('[ProtonPremium] Validation OK, status:', _lastStatus, 'plan:', _billingInterval);
    } else if (kind === 'hold') {
      _applyHold(key, result, now);
      debugLog('[ProtonPremium] Validation: license held:', result.error);
    } else if (kind === 'refusal' && (result.error === 'subscription_canceled' || !_isConfirmed())) {
      // Canceled is final. Any other refusal is final only for a key Paddle
      // never answered for: a typo, or the wrong product.
      debugLog('[ProtonPremium] Validation refused, clearing license:', result.error);
      await _dropLicense(result.error);
      return result;
    } else {
      // Transient, or a refusal for a confirmed key: Paddle does not delete
      // subscriptions or move them between products, so that is a fault.
      _applyTransient(result, now);
      debugLog('[ProtonPremium] Validation transient error, grace period active:', result.error,
        'daysSinceFirstFailure:', Math.floor((now - _firstFailedAt) / DAY_MS));
    }
    await _finishCheck(kind === 'refusal' ? 'transient' : kind, result);
    return result;
  }

  function _fetchSignal() {
    return (typeof AbortSignal !== 'undefined' && AbortSignal.timeout) ? AbortSignal.timeout(FETCH_TIMEOUT_MS) : undefined;
  }

  function _isObject(v) {
    return !!v && typeof v === 'object' && !Array.isArray(v);
  }

  function _finiteOr0(v) {
    return typeof v === 'number' && Number.isFinite(v) ? v : 0;
  }

  function _str(v) {
    return typeof v === 'string' && v ? v : null;
  }

  function _parseScheduledChange(v) {
    if (!_isObject(v) || !_str(v.action) || !_str(v.effective_at)) return null;
    return { action: v.action, effective_at: v.effective_at };
  }

  /**
   * @param {string} subId
   * @param {string} reason - 'activation' until the key has had a definite
   *                         answer, 'refresh' afterwards. The proxy refuses a
   *                         wrong key only on an activation.
   */
  async function _callValidate(subId, reason) {
    const params = `sub=${encodeURIComponent(subId)}&reason=${encodeURIComponent(reason || 'unknown')}`;
    let resp;
    try {
      resp = await fetch(`${WORKER_BASE_URL}/validate?${params}`, { signal: _fetchSignal() });
    } catch (e) {
      return { ok: false, error: 'proxy_unreachable' };
    }
    let data;
    try {
      data = await resp.json();
    } catch (e) {
      return { ok: false, error: 'proxy_unreachable' };
    }
    // null, a number, a string or an array is no answer at all.
    if (!_isObject(data)) return { ok: false, error: 'proxy_unreachable' };

    let periodEnd = data.current_period_ends_at || data.next_billed_at || null;
    // During a trial, Paddle's current_period covers just the trial window
    // (often 1 day or 7 days), which is misleading next to a "Yearly" or
    // "Monthly" plan label: the user's already-purchased cycle is the
    // billing interval, not the trial. Project periodEnd to match the
    // billing interval so the UI shows the cycle they actually signed
    // up for. Display only: the check cadence uses rawPeriodEnd.
    if (data.status === 'trialing' && data.current_period_starts_at) {
      const start = new Date(data.current_period_starts_at);
      if (!Number.isNaN(start.getTime())) {
        if (data.billing_interval === 'year') {
          start.setFullYear(start.getFullYear() + 1);
          periodEnd = start.toISOString();
        } else if (data.billing_interval === 'month') {
          start.setMonth(start.getMonth() + 1);
          periodEnd = start.toISOString();
        }
      }
    }

    const fields = {
      status: _str(data.status),
      nextBilledAt: _str(data.next_billed_at),
      billingInterval: _str(data.billing_interval),
      periodStart: _str(data.current_period_starts_at),
      periodEnd: _str(periodEnd),
      rawPeriodEnd: _str(data.current_period_ends_at),
      scheduledChange: _parseScheduledChange(data.scheduled_change),
    };
    if (data.ok === true) return { ok: true, ...fields };

    let error = _str(data.error) || 'proxy_unreachable';
    // The proxy's rule: a 5xx is never Paddle's definite answer, whatever it says.
    if (resp.status >= 500 && (HOLD_ERRORS.has(error) || REFUSAL_ERRORS.has(error))) {
      error = 'paddle_server_error';
    }
    // On a check of a stored key, the proxy answers a subscription Paddle does
    // not know (a test key from the sandbox, say) or one for the other product
    // with this fault and detail "unconfirmed", so that a Paddle hiccup never
    // costs a paying customer Premium. It stays transient (grace, retries), but
    // gets its own code, so the notice can say the key is the problem instead
    // of blaming a server error.
    if (error === 'paddle_server_error' && _str(data.detail) === 'unconfirmed') {
      error = 'license_unconfirmed';
    }
    return { ok: false, error, ...fields };
  }

  /**
   * Resolve a Paddle transaction ID to its subscription ID via the proxy.
   * Polls briefly because Paddle creates the subscription after the
   * transaction settles, so immediately-after-checkout lookups return
   * `not_ready` for a few seconds. Any other error is terminal.
   */
  async function _resolveTxnToSub(txnId) {
    let lastError = 'not_ready';
    for (let attempt = 1; attempt <= TXN_LOOKUP_ATTEMPTS; attempt++) {
      let data = null;
      try {
        const resp = await fetch(`${WORKER_BASE_URL}/txn-to-sub?txn=${encodeURIComponent(txnId)}`,
          { signal: _fetchSignal() });
        data = await resp.json();
      } catch (e) {
        // Proxy down → keep retrying; the extension is presumably online
        // (the user just clicked Activate) so this is usually transient.
      }
      if (!_isObject(data)) {
        lastError = 'proxy_unreachable';
      } else if (data.ok === true && _str(data.subscription_id)) {
        return { ok: true, subscription_id: data.subscription_id };
      } else if (_str(data.error) && data.error !== 'not_ready') {
        // Terminal: subscription truly not found, or our request was bad.
        return { ok: false, error: data.error };
      } else {
        lastError = 'not_ready';
      }
      if (attempt < TXN_LOOKUP_ATTEMPTS) {
        await new Promise(r => setTimeout(r, TXN_LOOKUP_DELAY_MS));
      }
    }
    return { ok: false, error: lastError === 'not_ready' ? 'transaction_not_ready' : lastError };
  }

  // --- Follow-up and nudge ---

  /** Open the follow-up window: checks at +2 min, +10 min, +30 min and +2 h. */
  async function _startFollowUp() {
    _followUpUntil = Date.now() + FOLLOW_UP_WINDOW_MS;
    _followUpStep = 0;
    const armed = _setNextCheck(FOLLOW_UP_STEPS_MS[0]);
    await _saveLocal();
    await armed.catch(() => {});
    debugLog('[ProtonPremium] Follow-up checks started after the update-payment link');
  }

  /**
   * The popup or options page opened. A user with a failing payment may just
   * have fixed it, so check now, at most once per NUDGE_MIN_GAP_MS. Resolves
   * with the status after the check (or right away when none is needed).
   */
  async function nudge() {
    if (!_heldState() && !_isPastDue()) return getStatus();
    const now = Date.now();
    // A stamp in the future is a clock that stepped back: not a throttle.
    if (_lastNudgeAt && now >= _lastNudgeAt && now - _lastNudgeAt < NUDGE_MIN_GAP_MS) return getStatus();
    _lastNudgeAt = now;
    await _saveLocal();
    await validateLicense();
    return getStatus();
  }

  // --- Status ---

  function getMaskedKey() {
    if (!_licenseKey) return null;
    if (_licenseKey.length <= 12) return _licenseKey;
    return _licenseKey.slice(0, 8) + '…' + _licenseKey.slice(-4);
  }

  /** The refusal code of an automatic clear, for 30 days after it. */
  function _clearedReason(now) {
    if (_licenseKey || !_cleared || !_lastError) return null;
    return now - _cleared < CLEARED_REASON_MS ? _lastError : null;
  }

  function getStatus() {
    const now = Date.now();
    const keyStored = !!_licenseKey;
    const held = _heldState();
    // A held key is neither licensed, nor in grace, nor locked: Paddle did
    // answer, and the answer was "not paid". Only a trial gives Premium then.
    const graceApplies = keyStored && !held;
    const locked = graceApplies && _licenseLocked();
    const inGracePeriod = graceApplies && !!_firstFailedAt && !locked;
    const graceRemainingMs = inGracePeriod ? Math.max(0, _graceMs() - (now - _firstFailedAt)) : 0;

    return {
      premium: isPremium(),
      licensed: graceApplies && !locked,
      locked,
      trialing: isTrialing(),
      trialExpired: trialExpired(),
      trialAvailable: trialAvailable(),
      trialDaysRemaining: trialDaysRemaining(),
      // The trial runs, whether or not a key is stored (a held key + trial).
      trialActive: _trialRunning(),
      licenseKeyMasked: getMaskedKey(),
      keyStored,
      held,
      pastDue: _isPastDue(),
      clearedReason: _clearedReason(now),

      // Validation detail for the options page:
      lastValidatedAt: _lastValidatedAt || null,
      lastValidationError: _lastError,
      lastValidationStatus: _lastStatus,
      firstFailedAt: _firstFailedAt || null,
      graceRemainingDays: Math.ceil(graceRemainingMs / DAY_MS),
      inGracePeriod,

      // Plan + period (from the most recent definite answer).
      billingInterval: _billingInterval,
      periodStart: _periodStart,
      periodEnd: _periodEnd,
      nextBilledAt: _nextBilledAt,
      scheduledChange: _scheduledChange ? { ..._scheduledChange } : null,
    };
  }

  // --- Persistence ---

  function _localOnlyData() {
    return {
      [KEY_NEXT_CHECK]: _nextCheckAt,
      [KEY_FOLLOW_UP_UNTIL]: _followUpUntil,
      [KEY_FOLLOW_UP_STEP]: _followUpStep,
      [KEY_LAST_NUDGE]: _lastNudgeAt,
    };
  }

  /** Persist the scheduling stamps only: never mirrored to storage.sync. */
  async function _saveLocal() {
    await browser.storage.local.set(_localOnlyData());
  }

  async function _save() {
    const data = {
      [KEY_LICENSE]: _licenseKey,
      [KEY_TRIAL_END]: _trialEnd,
      [KEY_LAST_VALIDATED]: _lastValidatedAt,
      [KEY_FIRST_FAILED]: _firstFailedAt,
      [KEY_LAST_ERROR]: _lastError,
      [KEY_LAST_STATUS]: _lastStatus,
      [KEY_BILLING_INTERVAL]: _billingInterval,
      [KEY_PERIOD_START]: _periodStart,
      [KEY_PERIOD_END]: _periodEnd,
      [KEY_NEXT_BILLED]: _nextBilledAt,
      [KEY_SCHEDULED_CHANGE]: _scheduledChange,
      [KEY_CLEARED]: _cleared,
      [KEY_CONFIRMED]: _confirmedKey,
      [KEY_EVER_LICENSED]: _everLicensed,
    };
    await browser.storage.local.set({ ...data, ..._localOnlyData() });
    // Mirror to browser sync ONLY when the user has settings sync enabled:
    // the license key must respect the same toggle as every other setting.
    try {
      const { syncEnabled } = await browser.storage.local.get('syncEnabled');
      if (syncEnabled) await browser.storage.sync.set(data);
    } catch (e) { debugLog('[ProtonPremium] Sync write failed:', e.message); }
  }

  function _maskKey(k) {
    if (!k) return '(none)';
    return k.slice(0, 8) + '…' + k.slice(-4);
  }

  /**
   * Fetch the Paddle customer-portal URLs for the stored subscription.
   * Returns { ok:true, update_payment_method, cancel } on success, or
   * { ok:false, error } otherwise. The returned URLs carry ~24h JWT
   * tokens. Callers MUST NOT persist them to storage; fetch fresh on
   * every "Manage subscription" interaction.
   */
  async function getManageUrls() {
    const key = _licenseKey;
    if (!key) return { ok: false, error: 'no_license' };
    let data;
    try {
      const resp = await fetch(`${WORKER_BASE_URL}/manage-url?sub=${encodeURIComponent(key)}`,
        { signal: _fetchSignal() });
      data = await resp.json();
    } catch (e) {
      return { ok: false, error: 'proxy_unreachable' };
    }
    if (!_isObject(data)) return { ok: false, error: 'proxy_unreachable' };
    if (data.ok !== true) return { ok: false, error: _str(data.error) || 'proxy_unreachable' };
    const urls = {
      ok: true,
      update_payment_method: data.update_payment_method || null,
      cancel: data.cancel || null,
    };
    // The user may be about to fix the payment: check again within minutes
    // instead of tomorrow. The popup and options share this, being here.
    if (urls.update_payment_method && _licenseKey === key
        && (_heldState() === 'unpaid' || _isPastDue())) {
      await _startFollowUp();
    }
    return urls;
  }

  return {
    init,
    handleAlarm,
    isPremium,
    isTrialing,
    trialExpired,
    trialAvailable,
    trialDaysRemaining,
    startTrial,
    openPaymentPage,
    setLicenseKey,
    removeLicenseKey,
    validateLicense,
    nudge,
    getManageUrls,
    getStatus,
    onPremiumChange,
    // Re-persist current state: called when the user turns the settings-sync
    // toggle ON so an already-active license reaches storage.sync right away
    // instead of waiting for the next check.
    resyncToSync: () => _save(),
  };
})();
