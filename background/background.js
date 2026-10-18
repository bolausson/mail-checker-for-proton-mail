/**
 * Background script entry point for Proton Mail Checker.
 *
 * Coordinates account management, polling, badge updates, and notifications.
 * Handles messages from the popup and options pages.
 */

(function main() {
  const _manifest = browser.runtime.getManifest();
  debugLog('[ProtonMailChecker] Starting v' + _manifest.version + '...');

  // Pending login state: the credentials to replay once the user has supplied
  // whatever the server asked for next (a 2FA code, a mailbox password, or a
  // solved CAPTCHA).
  //
  // The CSP/X-Frame-Options relaxation is a SEPARATE concern and is armed only
  // for the CAPTCHA case. It exists so account.proton.me may frame
  // verify.proton.me, which nothing else in the login flow does: 2FA, FIDO2 and
  // the legacy mailbox password all stay inside our own popup. Arming it for
  // those too, as this used to, left header-stripping rules installed on three
  // Proton origins for the whole of an ordinary sign-in, and made our AMO
  // reviewer notes ("during the CAPTCHA window only") untrue.
  //
  // Chrome MV3 and Firefox MV3 both run it through declarativeNetRequest
  // dynamic rules in ProtonCSPShim, which is fully feature-detected.
  //
  // The credentials stay in this background's memory only. MV3 stops an idle
  // background after ~30 s, which would lose them mid-CAPTCHA (and startup
  // clears the header rules), so the CAPTCHA tab keeps the background awake
  // with CAPTCHA_KEEPALIVE pings instead of the password being stored
  // anywhere. An abandoned CAPTCHA expires via CAPTCHA_EXPIRE_ALARM.
  let _pendingLogin = null;
  let _pendingCaptcha = false;
  const CAPTCHA_EXPIRE_ALARM = 'proton-captcha-expire';
  const CAPTCHA_EXPIRE_MIN = 15;
  function _setPendingLogin(value, opts) {
    _pendingLogin = value;
    _pendingCaptcha = !!(value && opts && opts.needsCspOverride);
    if (_pendingCaptcha) {
      ProtonCSPShim.enableLoginCSPOverride();
      browser.alarms.create(CAPTCHA_EXPIRE_ALARM, { delayInMinutes: CAPTCHA_EXPIRE_MIN });
    } else {
      ProtonCSPShim.disableLoginCSPOverride();
      Promise.resolve(browser.alarms.clear(CAPTCHA_EXPIRE_ALARM)).catch(() => {});
    }
  }

  // Drop any persisted Add-account form draft after the login finishes.
  // The popup persists the typed username (never the password) so it
  // survives popup-closes during Bitwarden copy-paste; once the account
  // is actually added it would otherwise hijack the next popup open
  // back into the Accounts view.
  function _clearPopupAccountDraft() {
    browser.storage.local.remove('popupAccountDraft').catch(() => {});
  }
  // Clean up any stale DNR rules from a prior SW instance that crashed
  // mid-login. No-op on Firefox.
  ProtonCSPShim.clearStaleRules();

  // === Async initialisation ===
  // Wrapped in a deferred-promise pattern so listeners (registered
  // synchronously below) can await readiness. Chrome MV3 service workers
  // dispatch events shortly after script load and discard listeners that
  // are registered after the first `await`, so all addListener() calls
  // must happen synchronously during the IIFE.
  let _initPromise = null;
  let _initDone = false;

  async function _initialize() {
    ProtonNotifier.init();
    await ProtonDND.init();
    await ProtonPremium.init();
    // Fast phase only: load accounts + restore the cached snapshot. Key-unlock and
    // network enrichment run in the slow phase below, so GET_STATE can serve the
    // cached email list without waiting ~1.5s for keys to decrypt.
    await ProtonAccounts.initFast();
    ProtonAccounts.initUrlDetection();

    // Apply synced account settings on startup (if sync enabled)
    try {
      const { syncEnabled } = await browser.storage.local.get('syncEnabled');
      if (syncEnabled) {
        const synced = await browser.storage.sync.get('accountSettings');
        if (synced.accountSettings) {
          await ProtonAccounts.importAccountSettings(synced.accountSettings);
        }
      }
    } catch (e) { /* sync storage may not be available */ }

    if (!ProtonAccounts.hasAccounts()) {
      ProtonBadge.setLoggedOut();
      await ProtonAccounts.initSlow(); // parity: run the slow tail (no-op w/o accounts)
      _initDone = true;
      return;
    }

    // When we have a snapshot from a prior session, flip _initDone now
    // so GET_STATE returns the cached messages instantly, and let the
    // initial poll run in parallel. Without a snapshot (first install,
    // browser restart, manually-cleared storage) we still block so the
    // popup doesn't flash to an empty "no messages" view before the
    // first real fetch lands.
    if (ProtonAccounts.hasSnapshot()) {
      // Cached list is ready: unblock the popup NOW (GET_STATE serves the cached
      // messages immediately). Arm the recurring poll alarm right away so polling
      // survives even if the slow phase / first fetch is cut short by an event-page
      // or service-worker teardown. Unlock keys + first real fetch run detached.
      _initDone = true;
      ProtonPoller.start();
      // resume(), not initialLoad(): a wake is not a reason to reload
      // everything. That jumped the event cursor past mail that had arrived
      // since the last poll, which then never notified (see poller.js).
      ProtonAccounts.initSlow()
        .then(() => ProtonPoller.resume())
        .catch(err => console.error('[ProtonMailChecker] Background init/poll failed:', err.message));
    } else {
      // No cached list: block the popup until keys are unlocked and the first
      // fetch lands, so it doesn't flash an empty "no messages" view.
      await ProtonAccounts.initSlow();
      await ProtonPoller.initialLoad();
      await ProtonPoller.start();
      _initDone = true;
    }
  }

  function ensureInitialized() {
    if (!_initPromise) _initPromise = _initialize();
    return _initPromise;
  }

  // Premium can flip without any message: a license check answering
  // "unpaid", a grace period running out, a trial ending. The poll interval
  // and the free tier's one-account polling follow isPremium(), so re-apply
  // them now instead of at the next restart. Registered before init, which
  // may already start a check.
  ProtonPremium.onPremiumChange(() => {
    ensureInitialized().then(async () => {
      if (!ProtonAccounts.hasAccounts()) return;
      await ProtonPoller.start();
      ProtonPoller.refreshBadgeNow();
    }).catch(err => console.warn('[ProtonMailChecker] Premium change handling failed:', err.message));
  });

  browser.alarms.onAlarm.addListener(async (alarm) => {
    await ensureInitialized();
    ProtonDND.handleAlarm(alarm);
    ProtonPoller.handleAlarm(alarm);
    ProtonPremium.handleAlarm(alarm);
    ProtonAccounts.handleAlarm(alarm);
    _handleBlobRevokeAlarm(alarm);

    // After DND expires, re-poll to restore normal badge
    if (alarm.name === 'proton-dnd-expire') {
      ProtonPoller.poll();
    }

    // A CAPTCHA left unsolved: drop the pending sign-in and its header rules.
    // (If this alarm woke a fresh background, startup already cleared them.)
    if (alarm.name === CAPTCHA_EXPIRE_ALARM && _pendingCaptcha) {
      _setPendingLogin(null);
    }
  });

  // Track blob URLs awaiting time-based revocation, keyed by alarm name.
  // Survives Chrome MV3 service-worker idle; on cold restart the SW loses
  // the blob URLs anyway (they're scoped to the SW global), so cleanup is
  // a no-op in that case.
  const _BLOB_REVOKE_PREFIX = 'proton-blob-revoke-';
  let _blobRevokeSeq = 0;
  const _pendingBlobRevokes = new Map();

  function _scheduleBlobRevoke(blobUrl, delayMinutes) {
    const name = _BLOB_REVOKE_PREFIX + (++_blobRevokeSeq);
    _pendingBlobRevokes.set(name, blobUrl);
    browser.alarms.create(name, { delayInMinutes: delayMinutes });
  }

  function _revokeBlobNow(name) {
    const url = _pendingBlobRevokes.get(name);
    if (!url) return;
    _pendingBlobRevokes.delete(name);
    try { URL.revokeObjectURL(url); } catch (_) { /* ignore */ }
  }

  function _handleBlobRevokeAlarm(alarm) {
    if (!alarm.name.startsWith(_BLOB_REVOKE_PREFIX)) return;
    _revokeBlobNow(alarm.name);
  }

  // Single-use stash of decrypted attachment bytes for the Chrome MV3
  // preview page (preview/preview.html). The page navigates here with
  // ?id=<id>, sends GET_PREVIEW_BLOB, gets the bytes, builds its own
  // blob URL inside the renderer, and renders via <embed>.
  //
  // In-memory only. If the SW dies between OPEN_ATTACHMENT and the page
  // calling GET_PREVIEW_BLOB the entry is lost; the preview page falls
  // back to a "not available" message and the user can retry. Auto-evict
  // after 60s to bound memory.
  let _previewSeq = 0;
  const _previewBytes = new Map();

  /**
   * MIME types we are willing to render inline when opening an attachment.
   *
   * Anything opened as a blob URL, or embedded in the preview page, gets the
   * EXTENSION's origin, so a scriptable type would run attacker markup with our
   * privileges. This is an allowlist of inert types on purpose: images that
   * cannot script (NOT image/svg+xml, which can), plain text, and PDF, which
   * both browsers render in their own sandboxed viewer. Everything else, and
   * anything unrecognised, becomes application/octet-stream, which the browser
   * downloads rather than renders. The file is still saved intact; only the
   * inline preview is refused.
   */
  const INLINE_SAFE_MIME = new Set([
    'image/png', 'image/jpeg', 'image/jpg', 'image/gif', 'image/webp',
    'image/bmp', 'image/x-icon', 'image/avif',
    'text/plain', 'application/pdf',
  ]);

  function _inlineSafeMimeType(raw) {
    // Strip any parameters ("text/html; charset=utf-8") before matching, and
    // never trust case.
    const base = String(raw || '').split(';')[0].trim().toLowerCase();
    return INLINE_SAFE_MIME.has(base) ? base : 'application/octet-stream';
  }

  function _stashPreviewBytes(bytes, mimeType, filename) {
    const id = String(++_previewSeq);
    _previewBytes.set(id, { bytes, mimeType, filename });
    setTimeout(() => _previewBytes.delete(id), 60 * 1000);
    return id;
  }

  // Chrome MV3 only: run a WebAuthn ceremony in the page's main world via
  // chrome.scripting.executeScript({ world: 'MAIN' }). Bypasses page CSP
  // since chrome.scripting is a privileged extension API. Firefox uses
  // wrappedJSObject + cloneInto from the content script instead and never
  // invokes this path.
  async function _runFido2InPageMainWorld(tabId, raw) {
    if (!browser.scripting || typeof browser.scripting.executeScript !== 'function') {
      return { error: 'scripting API unavailable', errorName: 'Error' };
    }
    try {
      const results = await browser.scripting.executeScript({
        target: { tabId },
        world: 'MAIN',
        args: [raw],
        func: async function pageFido2(raw) {
          try {
            const pk = raw.publicKey;
            const real = { publicKey: {
              challenge: new Uint8Array(pk.challenge).buffer,
              rpId: pk.rpId,
              timeout: pk.timeout || 60000,
              userVerification: pk.userVerification || 'discouraged',
              allowCredentials: (pk.allowCredentials || []).map(function (c) {
                return { type: c.type, id: new Uint8Array(c.id), transports: c.transports };
              }),
            } };
            const cred = await navigator.credentials.get(real);
            // This runs in the page's MAIN world via executeScript and cannot
            // see ProtonBinary (extension scope), so it keeps its own tiny
            // base64 encoder. Inputs here are signature-sized (small).
            const u8 = function (b) { return new Uint8Array(b); };
            const b64 = function (b) {
              const a = u8(b);
              let s = '';
              for (let i = 0; i < a.length; i++) s += String.fromCharCode(a[i]);
              return btoa(s);
            };
            const r = cred.response;
            return {
              ok: true,
              rawIdB64: b64(cred.rawId),
              clientDataJSONB64: b64(r.clientDataJSON),
              authenticatorDataB64: b64(r.authenticatorData),
              signatureB64: b64(r.signature),
            };
          } catch (e) {
            return { ok: false, errorName: e.name || 'Error', error: e.message || '' };
          }
        },
      });
      const r = results && results[0] && results[0].result;
      if (!r) return { error: 'No result from page', errorName: 'Error' };
      if (r.ok) return r;
      return { error: r.error, errorName: r.errorName };
    } catch (e) {
      return { error: e.message || String(e), errorName: e.name || 'Error' };
    }
  }

  // CSP/X-Frame-Options relaxation for the CAPTCHA flow is handled by
  // ProtonCSPShim (declarativeNetRequest dynamic rules), which works on
  // both Firefox MV3 (128+, we require 142+) and Chrome MV3. We don't
  // use webRequest.onHeadersReceived blocking mode because Firefox MV3
  // restricts webRequestBlocking to a narrow set of approved cases.
  // Even temporary-installed extensions can't rely on it.

  /**
   * Attempt login, handling CAPTCHA and 2FA responses.
   *
   * Three possible outcomes:
   *   1. Success → starts polling, returns { success: true, accountId }
   *   2. 2FA required → stores _pendingLogin, returns { needs2FA, twoFactorType }
   *   3. CAPTCHA required (HTTP 9001) → stores _pendingLogin, returns { needsCaptcha }
   *
   * On CAPTCHA, opens captcha/captcha.html which loads the hCaptcha iframe.
   * The CAPTCHA_SOLVED message triggers a retry with the token.
   */
  /**
   * Common epilogue shared by every successful login variant (password, 2FA,
   * FIDO2, two-password): clear the pending-login CSP state and the popup's
   * saved login draft, then do an initial poll and start the poller.
   */
  async function _finishLoginFlow() {
    _setPendingLogin(null);
    _clearPopupAccountDraft();
    await ProtonPoller.initialLoad();
    // resetBackoff, not start(): if this login is the user recovering from a
    // failing account, start() would leave the escalated one-shot in place and
    // the next automatic poll could be hours away on the free cadence.
    await ProtonPoller.resetBackoff();
  }

  async function _tryLogin(username, password, captchaToken) {
    try {
      const result = await ProtonAccounts.login(username, password, captchaToken);

      // 2FA required: return to popup for code input
      if (result && result.needs2FA) {
        _setPendingLogin({ username, password });
        debugLog('[ProtonMailChecker] 2FA required');
        return { needs2FA: true, twoFactorType: result.twoFactorType };
      }

      // Two-password (legacy) account: return to popup for mailbox password
      if (result && result.needsMailboxPassword) {
        _setPendingLogin({ username, password });
        debugLog('[ProtonMailChecker] Mailbox password required');
        return { needsMailboxPassword: true };
      }

      // Success: result is an account ID string
      await _finishLoginFlow();
      return { success: true, accountId: result };
    } catch (err) {
      // Human verification required (Proton error code 9001)
      if (err.code === 9001 && err.details) {
        const hvToken = err.details.HumanVerificationToken;
        const methods = err.details.HumanVerificationMethods || [];
        // The only flow that frames verify.proton.me, so the only one that
        // needs the header override.
        _setPendingLogin({ username, password }, { needsCspOverride: true });
        debugLog('[ProtonMailChecker] Human verification required, methods:', JSON.stringify(methods));
        return {
          needsCaptcha: true,
          humanVerificationToken: hvToken,
          verificationMethods: methods,
        };
      }
      console.error('[ProtonMailChecker] Add account failed:', err.message);
      return { error: err.message };
    }
  }

  /**
   * Run an async action, send { ok: true } on success, then trigger a poll.
   * Used by all message action cases (mark read, archive, trash, etc.).
   */
  function _doActionAndPoll(actionPromise, sendResponse) {
    actionPromise.then(() => {
      sendResponse({ ok: true });
      ProtonPoller.poll();
    }).catch(err => {
      sendResponse({ error: err.message });
    });
  }

  // Message types that are available to free-tier users. Everything not in
  // this set is silently gated: background replies with a PREMIUM_REQUIRED
  // error if ProtonPremium.isPremium() is false. This is the single
  // enforcement point. Even if popup UI is tampered with, the background
  // rejects unauthorized actions.
  const FREE_ALLOWED = new Set([
    // State queries / lifecycle
    'GET_STATE', 'REFRESH', 'GET_ACCOUNTS', 'GET_PENDING_2FA',
    'GET_MAIL_URL', 'GET_COMPOSE_URL',
    'GET_ACCOUNT_MAPPING', 'SET_ACCOUNT_MAPPING', 'RESCAN_ACCOUNT_MAPPING',
    'GET_ACCOUNT_SETTINGS_EXPORT', 'IMPORT_ACCOUNT_SETTINGS',
    'SETTINGS_CHANGED',

    // Auth. Signing in is never a paid feature: how an account is protected
    // (2FA app, security key, separate mailbox password) is a property of the
    // user's Proton account, not of our plan, and gating it meant a free user
    // who secured their account properly could not use the extension at all.
    // 2FA sign-in was premium until v1.11.3.
    'ADD_ACCOUNT', 'REMOVE_ACCOUNT', 'CAPTCHA_SOLVED', 'SET_2FA_METHOD',
    'SUBMIT_2FA', 'GET_FIDO2_OPTIONS', 'FIDO2_PAGE_WEBAUTHN', 'FIDO2_COMPLETE',
    'SUBMIT_MAILBOX_PASSWORD', 'GET_PENDING_MAILBOX_PASSWORD',
    'CANCEL_PENDING_AUTH', 'CLOSE_THIS_TAB', 'CAPTCHA_KEEPALIVE',

    // Read-only email viewing (popup additionally forces plaintext for free tier)
    'MARK_READ', 'MARK_UNREAD', 'GET_MESSAGE', 'GET_PREVIEW_BLOB',
    // Draft persistence is user-data protection, never a paid feature: a
    // trial expiring mid-compose must not silently destroy typed text, and
    // the legacy plaintext-draft migration must run for lapsed users too.
    // (Composing/sending itself stays premium-gated at its own messages.)
    'SAVE_DRAFT', 'GET_DRAFT', 'SAVE_PENDING_ATTACHMENTS', 'TAKE_PENDING_ATTACHMENTS',
    // Finished Drive share links are user data (the files are already in the
    // user's Drive). A lapsed trial must not orphan them. Starting uploads
    // (DRIVE_START_UPLOAD etc.) stays premium-gated by omission.
    'TAKE_PENDING_DRIVE_LINKS',
    // Sender logos (BIMI/favicon via Proton's image proxy): a free cosmetic,
    // gated client-side by the loadSenderIconsAlways / remote-content toggles.
    'GET_SENDER_LOGO',

    // DND status query only. Enable/disable remain premium
    'DND_GET_STATUS',

    // Premium module itself
    'GET_PREMIUM_STATUS', 'START_TRIAL', 'OPEN_PAYMENT_PAGE', 'PREMIUM_RESYNC',
    'SET_LICENSE_KEY', 'REMOVE_LICENSE_KEY', 'VALIDATE_LICENSE',
    // Manage Subscription: allowed even in the grace-period locked state
    // so the user can still update payment / cancel without first
    // recovering full premium.
    'GET_MANAGE_URLS',
    // Popup / options opened while a payment is failing: a held license has
    // no Premium, and this is how it gets it back.
    'LICENSE_NUDGE',
  ]);

  // Handle messages from popup and options pages.
  //
  // Cases are grouped by concern:
  //   1. State queries:        GET_STATE, GET_ACCOUNTS, GET_PENDING_2FA, GET_MAIL_URL,
  //                            GET_COMPOSE_URL, GET_ACCOUNT_MAPPING
  //   2. Account management:   ADD_ACCOUNT, SUBMIT_2FA, CAPTCHA_SOLVED, REMOVE_ACCOUNT,
  //                            REORDER_ACCOUNT, UPDATE_ACCOUNT_SETTINGS, SET_ACCOUNT_MAPPING,
  //                            RESCAN_ACCOUNT_MAPPING, GET_ACCOUNT_SETTINGS_EXPORT,
  //                            IMPORT_ACCOUNT_SETTINGS
  //   3. Message actions:      MARK_READ, MARK_UNREAD, ARCHIVE, UNARCHIVE, TRASH, UNTRASH,
  //                            STAR, UNSTAR, LABEL_MESSAGE, UNLABEL_MESSAGE, MOVE_TO_FOLDER,
  //                            SNOOZE, REPORT_PHISHING
  //   4. Compose / send:       SEND_NEW_MESSAGE, SEND_REPLY, FORWARD_MESSAGE, GET_MESSAGE,
  //                            GET_ATTACHMENT, SEARCH_CONTACTS, GET_ADDRESSES, GET_LABELS,
  //                            GET_FOLDERS
  //   5. Misc:                 SETTINGS_CHANGED, REFRESH, TEST_SOUND, DND_*
  //   6. Premium / trial:      GET_PREMIUM_STATUS, START_TRIAL, OPEN_PAYMENT_PAGE,
  //                            SET_LICENSE_KEY, REMOVE_LICENSE_KEY, VALIDATE_LICENSE,
  //                            GET_MANAGE_URLS, LICENSE_NUDGE
  //
  // Return value convention:
  //   return false → sendResponse was called synchronously
  //   return true  → sendResponse will be called later (async handler)
  /**
   * Fetch an attachment's ciphertext and decrypt it when the account's keys
   * are unlocked and key packets were supplied. Shared by GET_ATTACHMENT
   * (returns base64 to the popup) and OPEN_ATTACHMENT (opens a preview/blob
   * tab); a decrypt failure returns the raw bytes with decrypted false, which
   * every caller that supplied keyPackets must treat as a failure rather than
   * use the bytes (they are still PGP ciphertext).
   * @returns {Promise<{bytes: Uint8Array, decrypted: boolean}>}
   */
  async function _fetchAndDecryptAttachment(message) {
    let account = ProtonAccounts.getAccount(message.accountId);
    const encData = await ProtonAccounts.getAttachment(
      message.accountId, message.attachmentId);

    // Wake race: the MV3 worker is torn down after ~30 s idle and init flips
    // done BEFORE initSlow() has unlocked the keys, so right after a wake
    // keysUnlocked is still false. Skipping the decrypt then would hand back
    // PGP ciphertext that a caller may save under the real filename, so wait
    // for the coalesced unlock first, the same wait the GET_MESSAGE handler
    // below does, and re-read the account afterwards because the reference
    // taken above was read before the unlock ran.
    if (message.keyPackets && account && !account.keysUnlocked) {
      await ProtonAccounts.ensureKeysUnlocked(message.accountId);
      account = ProtonAccounts.getAccount(message.accountId);
    }

    let decryptedData = null;
    if (account && account.keysUnlocked && message.keyPackets) {
      try {
        decryptedData = await ProtonAccounts.decryptAttachment(
          message.accountId, encData, message.keyPackets, {
            armoredSignature: message.signature || null,
            senderAddress: message.senderAddress || null,
          });
      } catch (err) {
        console.warn('[ProtonMailChecker] Attachment decrypt failed:', err.message);
      }
    }

    return { bytes: decryptedData || new Uint8Array(encData), decrypted: !!decryptedData };
  }

  function _handleMessage(message, sender, sendResponse) {
    // Gate: reject premium-only message types when user isn't premium.
    if (!FREE_ALLOWED.has(message.type) && !ProtonPremium.isPremium()) {
      sendResponse({ error: 'PREMIUM_REQUIRED', feature: message.type });
      return false;
    }

    switch (message.type) {

      // --- Diagnostics ---

      // Popup-side console capture. The popup only sends these while debug
      // logging is on (it gates locally); we append with ctx=popup so the
      // exported diagnostic log shows the popup side of an issue too.
      case 'DIAG_CAPTURE':
        if (message.level && message.msg && typeof ProtonDiag !== 'undefined' && ProtonDiag.capture) {
          try { ProtonDiag.capture(String(message.level), String(message.msg).slice(0, 1500), 'popup'); }
          catch (_) { /* diagnostics must never break the app */ }
        }
        return false;

      // --- 1. State queries ---

      case 'GET_STATE': {
        const state = ProtonPoller.getState();
        state.premium = ProtonPremium.getStatus();
        sendResponse(state);
        // Popup may have opened against a cold-started service worker whose
        // snapshot is minutes old. Kick an immediate poll in that case; the
        // popup picks up the result via the STATE_UPDATED broadcast.
        ProtonPoller.pollIfStale().catch(err =>
          console.warn('[ProtonMailChecker] pollIfStale failed:', err.message));
        return false;
      }

      case 'REFRESH':
        ProtonPoller.poll().then(() => {
          const state = ProtonPoller.getState();
          state.premium = ProtonPremium.getStatus();
          sendResponse(state);
        });
        return true;

      case 'GET_ACCOUNTS':
        sendResponse(ProtonAccounts.getAccounts());
        return false;

      // --- 2. Account management ---

      case 'ADD_ACCOUNT':
        if (message.username && message.password) {
          // Free tier: one account max. Existing accounts on downgrade keep
          // working, but we refuse to ADD a second one. Signing in again to
          // the account you already have is not adding one. See
          // lib/account-limit.js; blocking it locked free users out of their
          // own mailbox after a session expiry. accounts.js re-checks once
          // the server has confirmed who actually logged in.
          if (ProtonAccountLimit.blocksFreeLogin({
            accounts: ProtonAccounts.getAccounts(),
            identifier: message.username,
            isPremium: ProtonPremium.isPremium(),
          })) {
            sendResponse({ error: 'PREMIUM_REQUIRED', feature: 'multipleAccounts' });
            return false;
          }
          _tryLogin(message.username, message.password, message.captchaToken)
            .then(sendResponse);
          return true;
        }
        return false;

      case 'GET_PENDING_2FA':
        sendResponse({
          pending: !!ProtonAccounts.hasPending2FA(),
          twoFactorType: ProtonAccounts.getPending2FAType(),
        });
        return false;

      case 'SET_2FA_METHOD':
        ProtonAccounts.set2FAMethod(message.method);
        return false;

      case 'GET_FIDO2_OPTIONS':
        sendResponse(ProtonAccounts.getFIDO2Options());
        return false;

      case 'CLOSE_THIS_TAB':
        // Content scripts on Chrome cannot reliably call window.close() on
        // tabs the extension opened (Chrome blocks self-close for tabs
        // not opened by window.open). Round-trip through here so the BG
        // closes the sender's tab via tabs.remove. Firefox accepts the
        // same path, so both browsers use it. After closing, also re-
        // open the toolbar popup so the user lands back in the login
        // flow (which auto-detects pending 2FA / mailbox-password and
        // shows the right next step on open). Best-effort: some
        // browsers/states reject openPopup, in which case the user just
        // clicks the toolbar icon manually.
        if (sender && sender.tab && sender.tab.id != null) {
          browser.tabs.remove(sender.tab.id).catch(() => { /* already gone */ });
        }
        if (message.reopenPopup && browser.action && typeof browser.action.openPopup === 'function') {
          try { browser.action.openPopup().catch(() => {}); } catch (_) {}
        }
        return false;

      case 'FIDO2_PAGE_WEBAUTHN':
        // Chrome-only path: the content script can't call WebAuthn in
        // page-world directly (Proton's CSP blocks inline-script
        // injection, even with the DNR shim). chrome.scripting.execute
        // Script({ world: 'MAIN' }) is privileged and runs in the page's
        // origin without going through CSP.
        if (sender && sender.tab && sender.tab.id != null) {
          _runFido2InPageMainWorld(sender.tab.id, message.options).then(sendResponse);
          return true;
        }
        sendResponse({ error: 'No tab context for FIDO2 ceremony', errorName: 'Error' });
        return false;

      case 'FIDO2_COMPLETE':
        if (message.credential) {
          (async () => {
            try {
              const result = await ProtonAccounts.submitFIDO2(message.credential);
              if (result && result.needsMailboxPassword) {
                sendResponse({ needsMailboxPassword: true });
                return;
              }
              await _finishLoginFlow();
              sendResponse({ success: true, accountId: result });
            } catch (err) {
              console.error('[ProtonMailChecker] FIDO2 auth failed:', err.message);
              sendResponse({ error: err.message });
            }
          })();
          return true;
        }
        return false;

      case 'SUBMIT_2FA':
        if (message.code) {
          (async () => {
            try {
              const result = await ProtonAccounts.submit2FA(message.code);
              if (result && result.needsMailboxPassword) {
                sendResponse({ needsMailboxPassword: true });
                return;
              }
              await _finishLoginFlow();
              sendResponse({ success: true, accountId: result });
            } catch (err) {
              console.error('[ProtonMailChecker] 2FA failed:', err.message);
              sendResponse({ error: err.message });
            }
          })();
          return true;
        }
        return false;

      case 'SUBMIT_MAILBOX_PASSWORD':
        if (message.password) {
          (async () => {
            try {
              const accountId = await ProtonAccounts.submitMailboxPassword(message.password);
              await _finishLoginFlow();
              sendResponse({ success: true, accountId });
            } catch (err) {
              console.error('[ProtonMailChecker] Mailbox password auth failed:', err.message);
              sendResponse({ error: err.message });
            }
          })();
          return true;
        }
        return false;

      case 'GET_PENDING_MAILBOX_PASSWORD':
        sendResponse({ pending: !!ProtonAccounts.hasPendingMailboxPassword() });
        return false;

      case 'CANCEL_PENDING_AUTH':
        // User cancelled a half-completed login (2FA, FIDO2, or mailbox-pwd
        // prompt). Drop the partial server session reference so the popup
        // doesn't auto-reopen the same prompt next time it's launched.
        _setPendingLogin(null);
        ProtonAccounts.cancelPendingAuth();
        sendResponse({ ok: true });
        return false;

      case 'CAPTCHA_KEEPALIVE':
        // Receiving a message is what keeps the background awake; the answer
        // tells the CAPTCHA tab whether there is still a sign-in to keep.
        sendResponse({ pending: !!(_pendingLogin && _pendingCaptcha) });
        return false;

      case 'CAPTCHA_SOLVED':
        if (_pendingLogin && message.captchaToken) {
          _tryLogin(_pendingLogin.username, _pendingLogin.password, message.captchaToken)
            .then(sendResponse);
          return true;
        }
        sendResponse({ error: 'No pending login. Please try signing in again.' });
        return false;

      case 'REORDER_ACCOUNT':
        if (message.accountId && message.direction) {
          ProtonAccounts.reorderAccount(message.accountId, message.direction)
            .then(() => sendResponse({ success: true, accounts: ProtonAccounts.getAccounts() }));
          return true;
        }
        return false;

      case 'UPDATE_ACCOUNT_SETTINGS':
        if (message.accountId && message.settings) {
          (async () => {
            await ProtonAccounts.updateAccountSettings(message.accountId, message.settings);
            // Auto-sync account settings if sync is enabled
            await ProtonAccounts.pushAccountSettingsToSync();
            sendResponse({ success: true });
          })();
          return true;
        }
        return false;

      case 'GET_ACCOUNT_SETTINGS_EXPORT':
        sendResponse(ProtonAccounts.getAccountSettingsExport());
        return false;

      case 'IMPORT_ACCOUNT_SETTINGS':
        if (message.accountSettings) {
          ProtonAccounts.importAccountSettings(message.accountSettings)
            .then((result) => {
              // Different folders now: show them without waiting for the alarm.
              if (result && result.scopeChanged && result.scopeChanged.length) {
                ProtonPoller.poll();
              }
              sendResponse({ success: true });
            });
          return true;
        }
        return false;

      case 'REMOVE_ACCOUNT':
        if (message.accountId) {
          (async () => {
            await ProtonAccounts.removeAccount(message.accountId);
            if (!ProtonAccounts.hasAccounts()) {
              ProtonPoller.stop();
              ProtonBadge.setLoggedOut();
            }
            sendResponse({ success: true, accounts: ProtonAccounts.getAccounts() });
          })();
          return true;
        }
        return false;

      case 'GET_MAIL_URL':
        sendResponse(ProtonAccounts.getMailUrl(message.conversationId, message.accountId, message.messageId));
        return false;

      case 'GET_COMPOSE_URL':
        sendResponse(ProtonAccounts.getComposeUrl(message.accountId));
        return false;

      case 'GET_ACCOUNT_MAPPING':
        sendResponse(ProtonAccounts.getAccountMapping());
        return false;

      case 'RESCAN_ACCOUNT_MAPPING':
        ProtonAccounts.rescanUrlMapping().then(result => sendResponse(result));
        return true;

      case 'SET_ACCOUNT_MAPPING':
        if (message.accountId !== undefined && message.slot !== undefined) {
          ProtonAccounts.setAccountMapping(message.accountId, message.slot)
            .then(() => sendResponse({ success: true }));
          return true;
        }
        return false;

      // --- 5. Misc ---

      // Drafts are composed in the popup but encrypted HERE: the popup also
      // saves on pagehide, where a dying document cannot await WebCrypto,
      // while a fire-and-forget sendMessage still dispatches reliably. A
      // reply draft embeds the quoted decrypted original message (and a
      // compose draft the typed body, attachments and send options,
      // including an Encrypted-Outside password), so drafts must never
      // rest on disk in plaintext. All draft storage work runs through
      // _draftChain (see below) so overlapping saves (debounce + pagehide)
      // can never complete out of order and a GET always sees the newest.
      case 'SAVE_DRAFT':
        _enqueueDraftWork(async () => {
          if (!message.draft) {
            await browser.storage.local.remove('popupDraft');
          } else {
            const data = await ExtEncryption.encrypt(JSON.stringify(message.draft));
            await browser.storage.local.set({ popupDraft: { enc: 1, data } });
          }
          return { success: true };
        }).then(sendResponse).catch((err) => {
          // A swallowed failure here reads exactly like a successful save. The
          // storage quota is 10 MB with no unlimitedStorage, and a reply with an
          // embedded photo can exceed it, so this path is reachable and has
          // silently lost a whole reply before. Record it and tell the popup.
          const reason = (err && err.message) ? err.message : String(err);
          try { ProtonDiag.record('draft.save.fail', { reason: reason.slice(0, 200) }); } catch (_) { /* never mask the original */ }
          sendResponse({ success: false, error: reason });
        });
        return true;

      case 'GET_DRAFT':
        _enqueueDraftWork(async () => {
          const stored = await browser.storage.local.get('popupDraft');
          const d = stored && stored.popupDraft;
          if (!d) return null;
          if (d.enc) {
            try {
              return JSON.parse(await ExtEncryption.decrypt(d.data));
            } catch (e) {
              await browser.storage.local.remove('popupDraft');
              return null;
            }
          }
          // Legacy plaintext draft (pre-encryption): migrate it right away
          // so the plaintext copy leaves the disk on first read.
          const data = await ExtEncryption.encrypt(JSON.stringify(d));
          await browser.storage.local.set({ popupDraft: { enc: 1, data } });
          return d;
        }).then(sendResponse).catch(() => sendResponse(null));
        return true;

      case 'SAVE_PENDING_ATTACHMENTS':
        _enqueueDraftWork(async () => {
          const data = await ExtEncryption.encrypt(JSON.stringify(message.attachments || []));
          await browser.storage.local.set({ pendingAttachments: { enc: 1, data } });
          return { success: true };
        }).then(sendResponse).catch(() => sendResponse({ success: false }));
        return true;

      case 'TAKE_PENDING_ATTACHMENTS':
        _enqueueDraftWork(async () => {
          const stored = await browser.storage.local.get('pendingAttachments');
          const p = stored && stored.pendingAttachments;
          if (!p) return null;
          await browser.storage.local.remove('pendingAttachments');
          if (Array.isArray(p)) return p; // legacy plaintext hand-off
          try {
            return JSON.parse(await ExtEncryption.decrypt(p.data));
          } catch (e) {
            return null;
          }
        }).then(sendResponse).catch(() => sendResponse(null));
        return true;

      // --- Share via Proton Drive ---

      // Creates the upload job and fails fast (Drive bootstrap + target
      // folder) BEFORE the picker tab opens; the tab then binds to the job
      // over the "mcpm-drive-upload" port (see onConnect below).
      case 'DRIVE_START_UPLOAD':
        ProtonDrive.startJob(message.accountId, message.options || {})
          .then(sendResponse)
          .catch(err => sendResponse({ error: err.message }));
        return true;

      case 'DRIVE_UPLOAD_STATUS':
        sendResponse(ProtonDrive.getStatus(message.uploadId));
        return false;

      case 'DRIVE_UPLOAD_CANCEL':
        sendResponse(ProtonDrive.cancel(message.uploadId));
        return false;

      case 'TAKE_PENDING_DRIVE_LINKS':
        ProtonDrive.takePendingLinks()
          .then(sendResponse)
          .catch(() => sendResponse(null));
        return true;

      // Dev-only end-to-end pipeline check (no UI references this).
      case 'DRIVE_SELFTEST':
        ProtonDrive.selftest(message.accountId, message.size, message.options)
          .then(sendResponse)
          .catch(err => sendResponse({ error: err.message, code: err.code }));
        return true;

      case 'PREMIUM_RESYNC':
        // Settings-sync toggle just turned ON: push current license state to
        // storage.sync now instead of waiting for the next license check.
        ProtonPremium.resyncToSync()
          .then(() => sendResponse({ success: true }))
          .catch(() => sendResponse({ success: false }));
        return true;

      // Options page: try a rule (saved or mid-edit) against the loaded
      // messages. Read-only: nothing is hidden, counted or notified.
      case 'QUIET_RULES_TEST':
        ProtonPoller.testQuietRule(message.rule)
          .then(sendResponse)
          .catch(err => sendResponse({ error: 'FAILED', message: err.message }));
        return true;

      case 'SETTINGS_CHANGED':
        // start(), not restart(): it re-creates the alarm only when the poll
        // interval changed. The options page saves on every edit, and each
        // forced restart pushed the next poll back.
        ProtonPoller.start();
        // A changed "emails per account" refetches the lists now.
        ProtonPoller.syncListLimit().catch(() => {});
        // Quiet-mail rules must not wait for the next scheduled poll (up to
        // 15 min): re-evaluate the already-loaded messages now so the badge
        // and list reflect the rule the user just edited.
        ProtonPoller.reapplyQuietRules().catch(() => {});
        return false;

      case 'CLEAR_MSG_CACHE':
        (async () => {
          await ProtonAccounts.clearMessageCache();
          ProtonPoller.refreshBadgeNow();   // reflect the emptied state immediately
          ProtonPoller.poll();              // re-fetch in the background to repopulate
          sendResponse({ success: true });
        })();
        return true;

      case 'SET_CACHE_ENABLED':
        // The "Enable cache" toggle. The setting itself is already persisted by
        // the options page; here we make it take effect immediately: on enable,
        // write the disk cache now (so a quick restart is already warm); on
        // disable, remove the on-disk copy but leave the current view intact.
        (async () => {
          if (message.enabled) {
            await ProtonAccounts.saveSnapshot();   // gated on the just-saved setting
          } else {
            await ProtonAccounts.wipeDiskCache();
          }
          sendResponse({ success: true });
        })();
        return true;

      // --- 6. Premium / trial ---

      case 'GET_PREMIUM_STATUS':
        sendResponse(ProtonPremium.getStatus());
        return false;

      case 'START_TRIAL':
        // Refused with trial_unavailable after any license (premium.js).
        ProtonPremium.startTrial().then((result) => {
          if (result.success) ProtonPoller.restart(); // picks up new poll interval
          sendResponse(result);
        }).catch(() => sendResponse({ error: 'internal_error' }));
        return true;

      case 'OPEN_PAYMENT_PAGE':
        ProtonPremium.openPaymentPage().then(() => sendResponse({ ok: true }));
        return true;

      case 'SET_LICENSE_KEY':
        ProtonPremium.setLicenseKey(message.key).then((result) => {
          if (result.success) ProtonPoller.restart();
          sendResponse(result);
        }).catch(() => sendResponse({ error: 'internal_error' }));
        return true;

      case 'REMOVE_LICENSE_KEY':
        ProtonPremium.removeLicenseKey().then(() => {
          ProtonPoller.restart();
          sendResponse({ ok: true });
        }).catch(() => sendResponse({ ok: false, error: 'internal_error' }));
        return true;

      case 'VALIDATE_LICENSE':
        // Manual "Validate now", and the options page's re-check on return
        // from the Paddle portal: forces an immediate server check. Returns
        // the validation result plus the updated status block. It must
        // always answer: the options page keeps its button disabled until
        // it does. No poller restart: that pushed the next mail poll back a
        // full interval on every call, and the premium-change hook already
        // re-applies the interval when Premium flips.
        ProtonPremium.validateLicense().then((result) => {
          sendResponse({ result, status: ProtonPremium.getStatus() });
        }).catch(() => sendResponse({ ok: false, error: 'internal_error' }));
        return true;

      case 'LICENSE_NUDGE':
        // Popup or options opened. premium.js re-validates only while the
        // license is held or past_due, at most once per 5 minutes, and
        // answers with the status after that check.
        ProtonPremium.nudge()
          .then(status => sendResponse({ ok: true, status }))
          .catch(() => sendResponse({ ok: true, status: ProtonPremium.getStatus() }));
        return true;

      case 'GET_MANAGE_URLS':
        // Fetches fresh Paddle customer-portal URLs for the active
        // subscription. URLs carry a ~24h JWT token. Never cache them
        // beyond a single options-page interaction (see
        // reference_paddle_manage_url memory). Serving the payment link
        // while a payment is failing also starts quick follow-up checks.
        ProtonPremium.getManageUrls()
          .then(sendResponse)
          .catch(() => sendResponse({ ok: false, error: 'internal_error' }));
        return true;

      // --- 3. Message actions (all follow the action-then-poll pattern) ---

      case 'MARK_READ':
        if (message.ids && message.ids.length > 0 && message.accountId) {
          _doActionAndPoll(ProtonAccounts.markAsRead(message.accountId, message.ids), sendResponse);
          return true;
        }
        return false;

      case 'ARCHIVE':
        if (message.ids && message.ids.length > 0 && message.accountId) {
          _doActionAndPoll(ProtonAccounts.archiveMessages(message.accountId, message.ids), sendResponse);
          return true;
        }
        return false;

      case 'TRASH':
        if (message.ids && message.ids.length > 0 && message.accountId) {
          _doActionAndPoll(ProtonAccounts.trashMessages(message.accountId, message.ids), sendResponse);
          return true;
        }
        return false;

      case 'DELETE_PERMANENTLY':
        if (message.ids && message.ids.length > 0 && message.accountId) {
          _doActionAndPoll(
            ProtonAccounts.deleteMessagesPermanently(message.accountId, message.ids), sendResponse);
          return true;
        }
        return false;

      case 'SNOOZE':
        if (message.conversationIds && message.conversationIds.length > 0 &&
            message.accountId && message.snoozeUntil) {
          _doActionAndPoll(
            ProtonAccounts.snoozeConversations(message.accountId, message.conversationIds, message.snoozeUntil),
            sendResponse);
          return true;
        }
        return false;

      case 'DND_GET_STATUS':
        sendResponse(ProtonDND.getStatus());
        return false;

      case 'DND_ENABLE':
        ProtonDND.enable(message.minutes).then(() => {
          ProtonPoller.poll().then(() => sendResponse(ProtonDND.getStatus()));
        });
        return true;

      case 'DND_DISABLE':
        ProtonDND.disable().then(() => {
          ProtonPoller.poll().then(() => sendResponse(ProtonDND.getStatus()));
        });
        return true;

      case 'MARK_UNREAD':
        if (message.ids && message.ids.length > 0 && message.accountId) {
          _doActionAndPoll(ProtonAccounts.markAsUnread(message.accountId, message.ids), sendResponse);
          return true;
        }
        return false;

      case 'UNARCHIVE':
        if (message.ids && message.ids.length > 0 && message.accountId) {
          _doActionAndPoll(ProtonAccounts.unarchiveMessages(message.accountId, message.ids), sendResponse);
          return true;
        }
        return false;

      case 'UNTRASH':
        if (message.ids && message.ids.length > 0 && message.accountId) {
          _doActionAndPoll(ProtonAccounts.untrashMessages(message.accountId, message.ids), sendResponse);
          return true;
        }
        return false;

      case 'STAR':
        if (message.ids && message.ids.length > 0 && message.accountId) {
          _doActionAndPoll(ProtonAccounts.starMessages(message.accountId, message.ids), sendResponse);
          return true;
        }
        return false;

      case 'UNSTAR':
        if (message.ids && message.ids.length > 0 && message.accountId) {
          _doActionAndPoll(ProtonAccounts.unstarMessages(message.accountId, message.ids), sendResponse);
          return true;
        }
        return false;

      case 'LABEL_MESSAGE':
        if (message.ids && message.ids.length > 0 && message.accountId && message.labelId) {
          _doActionAndPoll(ProtonAccounts.labelMessages(message.accountId, message.ids, message.labelId), sendResponse);
          return true;
        }
        return false;

      case 'UNLABEL_MESSAGE':
        if (message.ids && message.ids.length > 0 && message.accountId && message.labelId) {
          _doActionAndPoll(ProtonAccounts.unlabelMessages(message.accountId, message.ids, message.labelId), sendResponse);
          return true;
        }
        return false;

      // --- 4. Compose / send ---

      case 'GET_ADDRESSES':
        if (message.accountId) {
          ProtonAccounts.getAddresses(message.accountId).then(addresses => {
            sendResponse(addresses);
          }).catch(err => {
            sendResponse({ error: err.message });
          });
          return true;
        }
        return false;

      case 'GET_LABELS':
        if (message.accountId) {
          ProtonAccounts.getLabels(message.accountId).then(result => {
            sendResponse(result.Labels || []);
          }).catch(err => {
            sendResponse({ error: err.message });
          });
          return true;
        }
        return false;

      case 'GET_FOLDERS':
        if (message.accountId) {
          ProtonAccounts.getFolders(message.accountId).then(result => {
            sendResponse(result.Labels || []);
          }).catch(err => {
            sendResponse({ error: err.message });
          });
          return true;
        }
        return false;

      case 'GET_CALENDARS':
        // Premium-only (not in FREE_ALLOWED): gated by the standard check above.
        if (message.accountId) {
          ProtonCalendarAPI.listCalendars(message.accountId)
            .then(calendars => sendResponse({ calendars }))
            .catch(err => sendResponse({ error: err.message, calendars: [] }));
          return true;
        }
        return false;

      case 'CHECK_CALENDAR_EVENT_EXISTS':
        if (message.accountId && message.uid) {
          ProtonAccounts.findCalendarEventByUID(message.accountId, message.uid)
            .then(result => sendResponse(result))
            .catch(err => sendResponse({ exists: false, error: err.message }));
          return true;
        }
        sendResponse({ exists: false });
        return false;

      case 'ADD_ICS_TO_CALENDAR':
        if (message.accountId && message.calendarId && message.icsText) {
          ProtonAccounts.addToCalendar(message.accountId, message.calendarId, message.icsText)
            .then(result => sendResponse(result))
            .catch(err => sendResponse({ error: err.message }));
          return true;
        }
        sendResponse({ error: 'Missing parameters' });
        return false;

      case 'MOVE_TO_FOLDER':
        if (message.ids && message.ids.length > 0 && message.accountId && message.folderId) {
          _doActionAndPoll(ProtonAccounts.moveToFolder(message.accountId, message.ids, message.folderId), sendResponse);
          return true;
        }
        return false;

      case 'REPORT_PHISHING':
        if (message.messageId && message.accountId) {
          _doActionAndPoll(ProtonAccounts.reportPhishing(message.accountId, message.messageId), sendResponse);
          return true;
        }
        return false;

      case 'SEND_NEW_MESSAGE':
        if (message.accountId && message.params) {
          (async () => {
            try {
              const result = await ProtonAccounts.sendNewMessage(
                message.accountId, message.params);
              sendResponse(result);
            } catch (err) {
              console.error('[ProtonMailChecker] Send failed:', err.message);
              sendResponse({ error: err.message });
            }
          })();
          return true;
        }
        sendResponse({ error: 'Missing required fields' });
        return false;

      case 'CALENDAR_RSVP':
        if (message.accountId && message.organizerEmail && message.icsData) {
          (async () => {
            try {
              const result = await ProtonAccounts.sendCalendarRsvp(
                message.accountId, message.organizerEmail,
                message.subject || '', message.htmlBody || '',
                message.icsData, message.senderAddress || '',
                { eventUID: message.eventUID, attendeeToken: message.attendeeToken,
                  attendeeEmail: message.attendeeEmail || '',
                  partstat: message.partstat, recurrenceId: message.recurrenceId || '' });
              sendResponse(result);
            } catch (err) {
              console.error('[ProtonMailChecker] RSVP send failed:', err.message);
              sendResponse({ error: err.message });
            }
          })();
          return true;
        }
        sendResponse({ error: 'Missing required fields' });
        return false;

      case 'GET_CALENDAR_ATTENDEES':
        if (message.accountId && message.eventUID) {
          ProtonAccounts.getCalendarAttendees(message.accountId, message.eventUID, message.recurrenceId || '')
            .then(result => sendResponse(result || { attendees: [] }))
            .catch(() => sendResponse({ attendees: [] }));
          return true;
        }
        sendResponse({ error: 'Missing required fields' });
        return false;

      case 'SEARCH_CONTACTS':
        if (message.accountId && typeof message.query === 'string') {
          ProtonAccounts.searchContacts(message.accountId, message.query)
            .then(results => sendResponse({ contacts: results }))
            .catch(err => sendResponse({ contacts: [], error: err.message }));
          return true;
        }
        sendResponse({ contacts: [] });
        return false;

      // --- AI writing assistant (Scribe, server mode): premium-gated by the
      //     FREE_ALLOWED check above; additionally requires Proton Scribe. ---
      case 'AI_CAPABILITY':
        if (message.accountId) {
          ProtonAIAssistant.getCapability(message.accountId)
            .then(result => sendResponse(result))
            .catch(() => sendResponse({ available: false, mode: 'server', reason: 'error' }));
          return true;
        }
        sendResponse({ available: false, mode: 'server', reason: 'error' });
        return false;

      case 'AI_RUN_ACTION':
        if (message.accountId && message.action) {
          ProtonAIAssistant.runAction({
            accountId: message.accountId,
            action: message.action,
            text: message.text || '',
            prompt: message.prompt || '',
            recipient: message.recipient || '',
            sender: message.sender || '',
            locale: message.locale || '',
          })
            .then(result => sendResponse(result))
            .catch(err => sendResponse({ ok: false, error: 'GENERATION_FAIL', message: err && err.message }));
          return true;
        }
        sendResponse({ ok: false, error: 'GENERATION_FAIL' });
        return false;

      case 'TEST_SOUND':
        ProtonNotifier.playSound(message.sound || 'chime', message.volume || 50);
        sendResponse({ ok: true });
        return false;

      case 'SEND_REPLY':
        if (message.messageId && message.accountId && (message.body || message.htmlBody)) {
          (async () => {
            try {
              const result = await ProtonAccounts.sendReply(
                message.accountId, message.messageId,
                message.htmlBody || message.body, !!message.htmlBody,
                !!message.replyAll, message.senderAddress || '',
                message.attachments || null,
                message.cc || null, message.bcc || null,
                message.to || null, message.sendOptions || null);
              sendResponse(result);
            } catch (err) {
              console.error('[ProtonMailChecker] Send reply failed:', err.message);
              sendResponse({ error: err.message });
            }
          })();
          return true;
        }
        sendResponse({ error: 'Missing required fields' });
        return false;

      case 'FORWARD_MESSAGE':
        if (message.messageId && message.accountId && message.to &&
            (Array.isArray(message.to) ? message.to.length > 0 : true) &&
            (message.body || message.htmlBody)) {
          (async () => {
            try {
              const result = await ProtonAccounts.forwardMessage(
                message.accountId, message.messageId,
                message.to,
                message.htmlBody || message.body, !!message.htmlBody,
                message.senderAddress || '',
                message.attachments || null,
                message.cc || null, message.bcc || null,
                message.sendOptions || null);
              sendResponse(result);
            } catch (err) {
              console.error('[ProtonMailChecker] Forward failed:', err.message);
              sendResponse({ error: err.message });
            }
          })();
          return true;
        }
        sendResponse({ error: 'Missing required fields' });
        return false;

      case 'CANCEL_SCHEDULED_SEND':
        if (message.messageId && message.accountId) {
          (async () => {
            try {
              const result = await ProtonAccounts.cancelScheduledSend(
                message.accountId, message.messageId);
              sendResponse(result);
            } catch (err) {
              console.error('[ProtonMailChecker] Cancel scheduled send failed:', err.message);
              sendResponse({ error: err.message });
            }
          })();
          return true;
        }
        sendResponse({ error: 'Missing required fields' });
        return false;

      case 'GET_MESSAGE':
        if (message.messageId && message.accountId) {
          (async () => {
            try {
              const msg = await ProtonAccounts.getMessage(
                message.accountId, message.messageId);
              const account = ProtonAccounts.getAccount(message.accountId);
              // Keys may still be unlocking right after a cold start (the popup is
              // now shown before unlock completes); wait for the coalesced unlock so
              // a quick message-open decrypts instead of showing "decryption inactive".
              if (account && !account.keysUnlocked) {
                await ProtonAccounts.ensureKeysUnlocked(message.accountId);
              }
              if (msg && msg.Body && account && account.keysUnlocked) {
                try {
                  msg.DecryptedBody = await ProtonAccounts.decryptBody(
                    message.accountId, msg.Body);
                } catch (err) {
                  console.warn('[ProtonMailChecker] Decrypt failed:', err.message);
                }
              }
              sendResponse({
                message: msg,
                keysUnlocked: account && account.keysUnlocked,
              });
            } catch (err) {
              sendResponse({ error: err.message });
            }
          })();
          return true;
        }
        return false;
    case 'GET_ATTACHMENT':
      if (message.attachmentId && message.accountId) {
        (async () => {
          try {
            // Convert to base64 for message passing (can't send ArrayBuffer)
            const { bytes, decrypted } = await _fetchAndDecryptAttachment(message);
            sendResponse({ data: ProtonBinary.uint8ToBase64(bytes), decrypted });
          } catch (err) {
            sendResponse({ error: err.message });
          }
        })();
        return true;
      }
      return false;
    case 'GET_SENDER_LOGO':
      // Sender logo (BIMI/favicon) via Proton's image proxy. Returns a data:
      // URL, or { ok:false } when Proton has no logo (popup shows initials).
      if (message.accountId && message.email) {
        ProtonAccounts.getSenderLogo(message.accountId, message.email, message.size, message.mode)
          .then(dataUrl => sendResponse({ ok: !!dataUrl, dataUrl: dataUrl || null }))
          .catch(() => sendResponse({ ok: false }));
        return true;
      }
      sendResponse({ ok: false });
      return false;
    case 'GET_PREVIEW_BLOB': {
      // Chrome MV3 preview page asks for the bytes it was opened with.
      // Single-use: drop the stash entry once handed over.
      const id = String(message.id || '');
      const entry = _previewBytes.get(id);
      if (!entry) {
        sendResponse({ error: 'expired or unknown id' });
        return false;
      }
      _previewBytes.delete(id);
      sendResponse({
        bytesB64: ProtonBinary.uint8ToBase64(entry.bytes),
        mimeType: entry.mimeType,
        filename: entry.filename,
      });
      return false;
    }
    case 'OPEN_ATTACHMENT':
      if (message.attachmentId && message.accountId) {
        (async () => {
          try {
            const { bytes, decrypted } = await _fetchAndDecryptAttachment(message);
            // We sent key packets, so the bytes were supposed to come back in
            // the clear. decrypted false means they are still PGP ciphertext:
            // previewing that shows garbage, and the non-inline branch below
            // hands the browser an octet-stream it DOWNLOADS under the real
            // filename, which is the same unreadable-but-plausible file the
            // download path already refuses. Fail visibly instead; the popup
            // turns the error into its localized download-failed toast.
            if (message.keyPackets && decrypted === false) {
              throw new Error('Attachment could not be decrypted');
            }
            const filename = message.filename || 'attachment';
            // The MIME type comes from the MESSAGE, so it is attacker-chosen.
            // A blob URL minted here carries the EXTENSION's own origin, so
            // opening text/html or image/svg+xml as a document would run
            // attacker markup same-origin with the extension, with access to
            // anything that origin can reach. Render only inert types inline
            // and force everything else down the neutral octet-stream path,
            // which the browser downloads instead of rendering.
            const mimeType = _inlineSafeMimeType(message.mimeType);

            // Firefox MV3 event page: the background IS a regular
            // renderer, so tabs.create on a blob URL renders inline
            // (PDF viewer, image viewer, etc.). Chrome MV3 SW creates
            // blob URLs that are scoped to the SW process and
            // unreachable from a tab, so we open an extension preview
            // page instead. It reconstitutes the blob in its own
            // renderer where <embed> can render it. (PDFs go through
            // Chrome's built-in viewer.) Detect by checking for the
            // window global, which exists in event pages but not SWs.
            const isServiceWorker = typeof window === 'undefined';
            if (isServiceWorker) {
              const id = _stashPreviewBytes(bytes, mimeType, filename);
              const previewUrl = browser.runtime.getURL('preview/preview.html')
                + '?id=' + encodeURIComponent(id);
              await browser.tabs.create({ url: previewUrl, active: true });
            } else {
              const blob = new Blob([bytes], { type: mimeType });
              const url = URL.createObjectURL(blob);
              const tab = await browser.tabs.create({ url, active: true });
              const onRemoved = (tabId) => {
                if (tabId === tab.id) {
                  URL.revokeObjectURL(url);
                  browser.tabs.onRemoved.removeListener(onRemoved);
                }
              };
              browser.tabs.onRemoved.addListener(onRemoved);
              _scheduleBlobRevoke(url, 10);
            }
            sendResponse({ ok: true });
          } catch (err) {
            sendResponse({ error: err.message });
          }
        })();
        return true;
      }
      return false;
    }
  }

  // Fresh installs default to the HUD theme. Existing installs (reason
  // 'update') are left untouched: they keep whatever theme they already have
  // (or the Classic fallback if they never set one). NB: themes are premium-
  // gated, so a free new user still sees Classic until they upgrade, at which
  // point this saved default takes effect.
  /**
   * Pure part of the install/update settings migration, so it can be tested.
   * Returns the settings to write (or null when nothing changed) and whether to
   * set the one-shot marker.
   *
   * "Image attachments" was stored but never READ before 1.12.7, while the
   * options page preselected "Embed inline" whenever nothing was stored and
   * saveSettings() persisted whatever the dropdown showed. So a user who opened
   * Settings once, for any unrelated reason, is carrying imageAttachMode
   * 'inline' without ever having chosen it, and 1.12.7 silently turned
   * embedding on for them. Nobody could have chosen it meaningfully either,
   * because until 1.12.7 the setting did nothing. Reset those once.
   *
   * The marker is NOT part of `settings`: options saveSettings() rebuilds that
   * object from its form fields, so any key missing from that literal is
   * dropped on the next save, the migration would run again on a later update,
   * and it would then undo a choice the user really did make.
   */
  function _migrateSettings(stored, reason) {
    const settings = { ...((stored && stored.settings) || {}) };
    let changed = false;

    if (reason === 'install' && settings.theme === undefined) {
      settings.theme = 'hud';
      changed = true;
    }

    const needsImageReset = !(stored && stored.imageAttachModeMigrated);
    if (needsImageReset && settings.imageAttachMode === 'inline') {
      settings.imageAttachMode = 'attachment';
      changed = true;
    }

    return { settings: changed ? settings : null, markImageMigrated: needsImageReset };
  }

  // Firefox starts an event page at browser startup ONLY when it has a
  // runtime.onStartup listener, and Firefox does not keep alarms across a
  // restart. Without this, nothing restarted the poll after a browser restart
  // until something else woke the page: that used to be any tab loading
  // anywhere, until the tab listener was limited to Proton Mail tabs.
  // Chrome keeps its alarms, so there this only starts polling sooner.
  browser.runtime.onStartup.addListener(() => {
    ensureInitialized();
  });

  browser.runtime.onInstalled.addListener(async (details) => {
    try {
      const stored = await browser.storage.local.get(['settings', 'imageAttachModeMigrated']);
      const plan = _migrateSettings(stored, details && details.reason);
      if (plan.settings) await browser.storage.local.set({ settings: plan.settings });
      if (plan.markImageMigrated) await browser.storage.local.set({ imageAttachModeMigrated: true });
    } catch (e) {
      console.warn('[ProtonMailChecker] Settings migration failed:', e.message);
    }
  });

  // Serializes all draft/pending-attachment storage work: overlapping
  // SAVE_DRAFT messages (input debounce + pagehide flush) must complete in
  // arrival order or an older draft could overwrite a newer one, and a
  // GET_DRAFT from a freshly opened popout must see the preceding save.
  let _draftChain = Promise.resolve();
  function _enqueueDraftWork(work) {
    const run = _draftChain.then(work);
    // Keep the chain alive after failures; the caller still sees the error.
    _draftChain = run.catch(() => {});
    return run;
  }

  // Listener wrapper: dispatches synchronously once init is done; until then,
  // defers each message until the init promise resolves. Preserves the
  // original sync/async return contract of _handleMessage so fire-and-forget
  // cases still close the channel cleanly.
  browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (_initDone) return _handleMessage(message, sender, sendResponse);
    let respondedSync = false;
    const wrappedRespond = (val) => { respondedSync = true; sendResponse(val); };
    ensureInitialized().then(() => {
      const ret = _handleMessage(message, sender, wrappedRespond);
      if (ret === false && !respondedSync) sendResponse();
    });
    return true;
  });

  // Drive upload data channel: the picker tab streams file chunks to the
  // background over a long-lived port (which also keeps the Chrome MV3
  // service worker alive for the duration). Ports bypass the FREE_ALLOWED
  // gate above, so ProtonDrive.handlePort re-checks premium itself.
  browser.runtime.onConnect.addListener((port) => {
    if (port.name !== 'mcpm-drive-upload') return;
    // Attach the port listeners SYNCHRONOUSLY: the picker posts HELLO right
    // after connecting, and port messages are NOT buffered for a listener
    // added later (an ensureInitialized().then() would drop HELLO). handlePort
    // only touches already-loaded module state (ProtonDrive._jobs,
    // ProtonPremium); the job it binds to was created by DRIVE_START_UPLOAD,
    // which already awaited init, so it exists by the time HELLO arrives.
    ProtonDrive.handlePort(port);
  });

  // Kick off async init eagerly.
  ensureInitialized().then(() => {
    debugLog('[ProtonMailChecker] Initialized');
  });
})();
