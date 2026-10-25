/**
 * Multi-account manager for Proton Mail Checker.
 *
 * Manages multiple Proton accounts, each with its own SRP session,
 * API credentials, and decrypted PGP keys. Replaces the old single-session
 * api.js, session.js, and crypto.js modules.
 */

const ProtonAccounts = (() => {
  const BASE_URL = ProtonConfig.BASE_URL;

  // In-memory account state
  let _accounts = [];

  // --- Persistence ---

  // Per-account poll snapshot, two tiers:
  //  - storage.SESSION (SNAPSHOT_KEY): warm, in-RAM, fast, cleared on browser
  //    restart. Written on every poll.
  //  - storage.LOCAL (MSG_CACHE_KEY): a cold-start fallback that SURVIVES a
  //    browser restart, so the popup shows the last message list (and opens at the
  //    configured size) instantly instead of waiting for the first poll. ENCRYPTED
  //    at rest (AES-256-GCM via ExtEncryption) and METADATA-ONLY: the
  //    decrypted-body preview (`_snippet`) and any other _-prefixed runtime field
  //    are stripped before write, so NO message body text is persisted to disk,
  //    even encrypted. OPT-IN: only written/read when Settings → Data → "Enable
  //    cache" is on (default off). Dead sessions (authError) are never cached.
  //    Wiped on the last account's removal / cleared per-account on session death;
  //    ignored (and cleared) when no credentials remain or the feature is off; and
  //    by the Settings → Data "Clear cache" button.
  const SNAPSHOT_KEY = 'protonAccountsSnapshot';
  const MSG_CACHE_KEY = '_msgCacheEnc';
  let _hasSnapshot = false;
  // Where the restored snapshot came from: 'session' (this browser run, so its
  // event cursor is still good to resume from), 'disk' (the opt-in cache after
  // a browser restart) or null.
  let _snapshotSource = null;

  /** Strip body-derived / runtime fields (the `_snippet` preview and any other
   *  underscore-prefixed field): keep only serialisable message metadata. */
  function _sanitizeMessagesForDisk(messages) {
    return (messages || []).map(m => {
      const clean = {};
      for (const k of Object.keys(m)) {
        if (k.charAt(0) === '_') continue; // _snippet (body), _accountId, …: drop
        clean[k] = m[k];
      }
      return clean;
    });
  }

  /** Persist the current snapshot to storage.local, ENCRYPTED + metadata-only,
   *  skipping dead (authError) sessions. Opt-in only (Settings → Data → "Enable
   *  cache", default off). Best-effort; never throws. */
  async function _persistEncryptedCache() {
    try {
      if (!(await getSettings()).cacheEnabled) return; // opt-in only
      const snap = {};
      for (const a of _accounts) {
        if (a.authError) continue; // never cache a dead session's mail to disk
        snap[a.id] = {
          messages: _sanitizeMessagesForDisk(a.messages),
          unreadCount: a.unreadCount || 0,
          lastEventId: a.lastEventId || null,
          lastCheckTime: a.lastCheckTime || null,
          authError: null,
        };
      }
      const blob = await ExtEncryption.encrypt(JSON.stringify(snap));
      await browser.storage.local.set({ [MSG_CACHE_KEY]: blob });
    } catch (_) { /* encryption/storage unavailable: non-fatal */ }
  }

  /** Remove the persisted encrypted message cache from disk. */
  async function _wipeEncryptedCache() {
    try { await browser.storage.local.remove(MSG_CACHE_KEY); }
    catch (_) { /* non-fatal */ }
  }

  async function saveSnapshot() {
    if (browser.storage.session) {
      const snap = {};
      for (const a of _accounts) {
        snap[a.id] = {
          messages: a.messages || [],
          unreadCount: a.unreadCount || 0,
          lastEventId: a.lastEventId || null,
          lastCheckTime: a.lastCheckTime || null,
          authError: a.authError || null,
          // A server Retry-After must outlive the worker: MV3 tears it down
          // between polls, and a deadline held only in memory was forgotten
          // at the very next wake.
          nextPollNotBefore: a.nextPollNotBefore || null,
          // How many messages the held list was fetched for, so a changed
          // "emails per account" setting can trigger a refetch.
          listLimit: a.listLimit || null,
          // Which folder selection (scopeGen) the count and list were taken
          // for. A count rise across a change is the added folders' existing
          // mail, not new mail (see _pollAccountViaCounts).
          countGen: typeof a.countGen === 'number' ? a.countGen : null,
          // The folder mode in effect, which follows Premium (_folderMode),
          // so a wake can tell Premium changed while no worker ran.
          effectiveFolderMode: _folderMode(a),
        };
      }
      try {
        await browser.storage.session.set({ [SNAPSHOT_KEY]: snap });
      } catch (_) { /* session storage may be unavailable; non-fatal */ }
    }
    // Also mirror to the encrypted on-disk cache so the next cold browser start
    // is warm. Detached: never blocks the poll path.
    _persistEncryptedCache().catch(() => {});
  }

  // Apply a restored snapshot map ({ [accountId]: {...} }) onto the in-memory
  // accounts. Returns true if any account matched.
  function _applySnapshot(snap) {
    if (!snap) return false;
    let restored = false;
    for (const a of _accounts) {
      const s = snap[a.id];
      if (!s) continue;
      a.messages = s.messages || [];
      a.unreadCount = s.unreadCount || 0;
      a.lastEventId = s.lastEventId || null;
      a.lastCheckTime = s.lastCheckTime || null;
      a.authError = s.authError || null;
      a.nextPollNotBefore = s.nextPollNotBefore || null;
      a.listLimit = s.listLimit || null;
      a.countGen = typeof s.countGen === 'number' ? s.countGen : null;
      // Premium can change while no worker runs (a trial ending overnight),
      // and then nothing reports it. A list and cursor taken for the other
      // folder mode are not resumed: the next poll fetches the one now in
      // effect in full and takes its existing mail in silently.
      if (s.effectiveFolderMode && s.effectiveFolderMode !== _folderMode(a)) {
        a.lastEventId = null;
        a.countGen = null;
      }
      restored = true;
    }
    return restored;
  }

  // Returns true if any account had its state restored from a prior snapshot.
  // Callers use this to decide whether GET_STATE has something meaningful to
  // return before the first poll completes. Tries the warm storage.session
  // snapshot first, then falls back to the encrypted on-disk cache (which
  // survives a browser restart, so a cold start still shows the last mail).
  async function _restoreSnapshot() {
    // No credentials → nothing legitimately owns a cache. Ignore it and clear
    // any orphaned encrypted cache so it can never outlive the accounts.
    _snapshotSource = null;
    if (_accounts.length === 0) { _wipeEncryptedCache(); return false; }

    // 1. Warm path: storage.session (same browser run).
    if (browser.storage.session) {
      try {
        const stored = await browser.storage.session.get(SNAPSHOT_KEY);
        if (_applySnapshot(stored && stored[SNAPSHOT_KEY])) { _snapshotSource = 'session'; return true; }
      } catch (_) { /* fall through to the encrypted cache */ }
    }

    // 2. Cold path: the encrypted on-disk cache, only if the user opted in
    //    (Settings → Data → "Enable cache", default off). If it's off, make sure
    //    no on-disk cache lingers.
    let cacheEnabled = false;
    try { cacheEnabled = !!(await getSettings()).cacheEnabled; } catch (_) { /* default off */ }
    if (!cacheEnabled) { _wipeEncryptedCache(); return false; }

    try {
      const stored = await browser.storage.local.get(MSG_CACHE_KEY);
      if (stored && stored[MSG_CACHE_KEY]) {
        const snap = JSON.parse(await ExtEncryption.decrypt(stored[MSG_CACHE_KEY]));
        if (_applySnapshot(snap)) {
          _snapshotSource = 'disk';
          // A cursor from before the browser was closed is hours old. Nothing
          // may resume from it, not even an alarm poll that runs before the
          // full load: it would announce everything since as new mail.
          for (const a of _accounts) { a.lastEventId = null; a.countGen = null; }
          return true;
        }
      }
    } catch (_) { /* corrupt / un-decryptable → treat as cold start */ }

    return false;
  }

  /** Clear ALL cached message state: the encrypted on-disk cache, the session
   *  snapshot, and the in-memory message lists. Backs the Settings → Data
   *  "Clear cache" button. */
  async function clearMessageCache() {
    await _wipeEncryptedCache();
    if (browser.storage.session) {
      try { await browser.storage.session.remove(SNAPSHOT_KEY); } catch (_) { /* non-fatal */ }
    }
    for (const a of _accounts) {
      a.messages = [];
      a.unreadCount = 0;
      // Without this the next poll resumes from the cursor, sees no change,
      // and the emptied list and zero count stay until some count moves.
      a.lastEventId = null;
      a.listLimit = null;
      a.countGen = null;
    }
    _hasSnapshot = false;
    _snapshotSource = null;
  }

  /**
   * The passphrase for one specific user key.
   *
   * Every user key has its OWN salt, so its passphrase is a separate bcrypt of
   * the login password. A post-quantum account carries two primary user keys
   * and the address-key Tokens are wrapped to one or the other, so unlocking
   * only the selected key leaves half the address keys shut.
   *
   * Falls back to the single `keyPassword` when the map has no entry: accounts
   * stored before the map existed have none until their next sign-in, and that
   * fallback is exactly the old behaviour.
   */
  function _passphraseFor(account, keyId) {
    const map = account && account.keyPasswords;
    if (map && keyId && Object.prototype.hasOwnProperty.call(map, keyId)) return map[keyId];
    return account ? account.keyPassword : undefined;
  }

  /** Restore the per-key passphrase map, tolerating every shape it has had. */
  async function _decryptKeyPasswords(stored) {
    if (!stored) return {};                       // pre-migration account
    try {
      const json = await ExtEncryption.decrypt(stored);
      const parsed = json ? JSON.parse(json) : null;
      // Never let a corrupt blob take the account down: an empty map degrades
      // to the single-passphrase path, which still signs in.
      return (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) ? parsed : {};
    } catch (e) {
      console.warn('[ProtonAccounts] Could not restore per-key passphrases:', e.message);
      return {};
    }
  }

  /** Save accounts to storage (excluding in-memory-only fields).
   *  Sensitive fields (keyPassword, keyPasswords, accessToken, refreshToken)
   *  are encrypted at rest using AES-256-GCM via ExtEncryption. */
  async function _save() {
    const data = await Promise.all(_accounts.map(async a => ({
      id: a.id,
      username: a.username,
      email: a.email,
      uid: a.uid,
      userId: a.userId || '',
      accessToken: await ExtEncryption.encrypt(a.accessToken),
      refreshToken: await ExtEncryption.encrypt(a.refreshToken),
      keyPassword: await ExtEncryption.encrypt(a.keyPassword),
      // One passphrase per user key, each derived from THAT key's salt.
      // Stored as JSON so the whole map goes through one encrypt.
      keyPasswords: await ExtEncryption.encrypt(JSON.stringify(a.keyPasswords || {})),
      label: a.label || '',
      initials: a.initials || '',
      color: a.color || '',
      notificationsEnabled: a.notificationsEnabled !== false,
      folderMode: a.folderMode || 'inbox',
      monitoredFolders: a.monitoredFolders || [],
      monitoredLabels: a.monitoredLabels || [],
      // Monitored folders/labels found deleted in Proton. Local on purpose:
      // it is what strips them from a stale synced copy (see
      // _pruneStaleMonitoredIds), so it must never travel with that copy.
      staleMonitorIds: a.staleMonitorIds || [],
      // Bumped by user edits of the monitored folders (picker, import) and
      // by Premium starting or ending (applyPremiumScope), not by the
      // automatic removal of a deleted folder: see poller.js _gen().
      scopeGen: a.scopeGen || 0,
      // Persist a permanent auth failure ('reauth' | 'disabled') so a dead
      // session stays marked across service-worker/browser restarts instead of
      // re-storming the API (and the diagnostic log) with doomed refreshes on
      // every cold start. Cleared on successful re-login.
      authError: a.authError || null,
      // Persist the last successful refresh time so the proactive refresh can
      // throttle across cold starts. Without it the token re-rotates on every
      // service-worker wake (the churn that gets tokens server-side-rejected).
      lastRefreshAt: a.lastRefreshAt || 0,
      // The SERVER's clock at that same refresh. Compared against a later 401's
      // Date header to spot a 401 that was already in flight when we rotated.
      lastRefreshServerAt: a.lastRefreshServerAt || 0,
      // When this server-side session was established (login / re-auth), used by
      // the death-log diagnostic to report total session lifetime at revocation.
      sessionCreatedAt: a.sessionCreatedAt || 0,
      // The WEB client's ViewMode bucket (Proton scopes it per client app);
      // persisted because it can only be detected while a Proton tab is open.
      webViewMode: typeof a.webViewMode === 'number' ? a.webViewMode : null,
      // Our own ('Other') bucket. Persisted so a cold start does not spend a
      // mail/v4/settings request on it: MV3 cold-starts before nearly every
      // poll, and that request was a fifth of all API calls. Rechecked daily
      // and updated from the event stream. Never persisted as unknown.
      viewMode: typeof a.viewMode === 'number' ? a.viewMode : null,
      viewModeCheckedAt: typeof a.viewMode === 'number' ? (a.viewModeCheckedAt || 0) : 0,
      encrypted: true,
    })));
    await browser.storage.local.set({ protonAccounts: data });
  }

  /** Fast init phase: load accounts from storage, decrypt credentials, and
   *  restore the cached message snapshot. Deliberately does NO key unlock and NO
   *  network call, so the background can serve the cached email list to the popup
   *  the instant this resolves (the slow phase runs afterwards). */
  async function initFast() {
    const stored = await browser.storage.local.get('protonAccounts');
    const data = stored.protonAccounts || [];

    // Decrypt sensitive fields (or load plaintext for legacy data)
    let needsMigration = false;
    const decryptedData = await Promise.all(data.map(async a => {
      if (a.encrypted) {
        return {
          ...a,
          accessToken: await ExtEncryption.decrypt(a.accessToken),
          refreshToken: await ExtEncryption.decrypt(a.refreshToken),
          keyPassword: await ExtEncryption.decrypt(a.keyPassword),
          keyPasswords: await _decryptKeyPasswords(a.keyPasswords),
        };
      }
      // Legacy plaintext: flag for migration
      needsMigration = true;
      return a;
    }));

    _accounts = decryptedData.map(a => ({
      ...a,
      encrypted: undefined, // don't keep marker in memory
      decryptedKeys: [],
      keysUnlocked: false,
      keysUnlocking: false,
      unreadCount: 0,
      messages: [],
      lastEventId: null,
      lastCheckTime: null,
      consecutiveErrors: 0,
    }));

    // Restore the in-memory poll state (messages, counts, lastEventId)
    // from the last session-storage snapshot. On Firefox MV3 event pages
    // and Chrome MV3 service workers, the background goes idle after
    // ~30s and the in-memory `messages` cache is lost; without this,
    // every popup open after idle would show "Checking mail..." until a
    // full poll completes. The snapshot is a few KB and restore is sync
    // enough that GET_STATE returns instantly with stale-but-recent
    // data, with the fresh poll running in parallel.
    _hasSnapshot = await _restoreSnapshot();

    // Diagnostic: record the token fingerprint each account starts this (cold)
    // start with. If init.load.refreshFp is OLDER than the last refresh.saved
    // fingerprint from before shutdown, a rotated refresh token was lost before
    // it persisted: the prime suspect for repeated re-auth. If they match but
    // the next refresh still 10013s, it points to server-side revocation.
    for (const _a of _accounts) {
      ProtonDiag.record('init.load', {
        email: _a.email,
        uid: _a.uid ? _a.uid.slice(0, 8) : 'none',
        refreshFp: ProtonDiag.fp(_a.refreshToken),
        accessFp: ProtonDiag.fp(_a.accessToken),
        authError: _a.authError || null,
      });
    }

    // Migrate legacy plaintext accounts to encrypted storage
    if (needsMigration) await _save();

    // Mark accounts the slow phase will unlock as "unlocking" so the popup (which
    // now renders the cached list BEFORE keys finish unlocking) shows a quiet
    // loading state for them instead of the alarming "session expired" banner
    // (reserved for a genuine authError or a real unlock failure). Cleared by
    // unlockKeys() when each attempt settles.
    for (const a of _accounts) {
      if (a.keyPassword && !a.authError) a.keysUnlocking = true;
    }
  }

  /** Slow init phase: unlock keys (network + crypto), schedule key-unlock retries,
   *  start proactive token refresh, and backfill userId. Split out from initFast()
   *  so the background can show the cached snapshot without waiting on this. */
  async function initSlow() {
    // Unlock keys for all accounts in parallel
    await Promise.all(_accounts.map(async (account) => {
      if (account.keyPassword && !account.authError) {
        try {
          await unlockKeys(account.id);
        } catch (err) {
          console.warn('[ProtonAccounts] Could not unlock keys for',
            account.email || account.username, ':', err.message);
        }
      }
    }));

    // Schedule retries for any accounts that failed to unlock
    _scheduleKeyRetries();

    // Start proactive token refresh to keep sessions warm
    _startProactiveRefresh();
    _clearLegacyRefreshAlarm();

    // The web client's ViewMode bucket. This used to ride on the mail/v4/settings
    // fetch, which now runs once a day; left there, the web bucket would stop
    // being re-read. Throttled inside, detached so it never delays a poll.
    refreshWebViewModes().catch(() => {});

    // Backfill userId for existing accounts that don't have it
    let needsSave = false;
    await Promise.all(_accounts.map(async (account) => {
      if (!account.userId && account.uid && account.accessToken) {
        try {
          const userResult = await _rawRequest(
            account.uid, account.accessToken, 'GET', 'core/v4/users');
          if (userResult.User && userResult.User.ID) {
            account.userId = userResult.User.ID;
            needsSave = true;
          }
        } catch (e) { /* best-effort userId enrichment */ }
      }
    }));
    if (needsSave) {
      try { await _save(); } catch (_) { /* best-effort; retried on next wake */ }
    }

    debugLog('[ProtonAccounts] Initialized with', _accounts.length, 'account(s)');
  }

  /** Initialize: fast phase (load + restore snapshot) then slow phase (unlock keys
   *  + enrich). Single-call wrapper kept for callers/tests that want the whole
   *  thing; the background invokes initFast()/initSlow() separately so it can
   *  unblock the popup as soon as the cached snapshot is ready. */
  async function init() {
    await initFast();
    await initSlow();
  }

  // --- Key unlock retry ---
  //
  // Retries are alarm-driven so they survive a Chrome MV3 service-worker
  // restart between attempts. Alarm name encodes account ID + next attempt
  // index: "proton-key-retry-<accountId>-<attempt>".

  const _KEY_RETRY_DELAYS_MIN = [5 / 60, 15 / 60, 30 / 60, 1]; // 5s, 15s, 30s, 60s
  const _KEY_RETRY_PREFIX = 'proton-key-retry-';

  /** Schedule retries for accounts whose keys failed to unlock. */
  function _scheduleKeyRetries() {
    const failed = _accounts.filter(a => a.keyPassword && !a.keysUnlocked && !a.authError);
    if (failed.length === 0) return;

    debugLog('[ProtonAccounts] Scheduling key unlock retries for',
      failed.map(a => a.email || a.username).join(', '));

    for (const account of failed) {
      _retryUnlockWithBackoff(account, 0);
    }
  }

  /** Retry unlocking keys with increasing delays. */
  function _retryUnlockWithBackoff(account, attempt) {
    if (attempt >= _KEY_RETRY_DELAYS_MIN.length) {
      debugLog('[ProtonAccounts] Giving up key unlock retries for',
        account.email || account.username, 'after', attempt, 'attempts');
      return;
    }
    const delayMin = _KEY_RETRY_DELAYS_MIN[attempt];
    debugLog('[ProtonAccounts] Will retry key unlock for', account.email,
      'in', Math.round(delayMin * 60), 's (attempt', attempt + 1 + ')');

    browser.alarms.create(_KEY_RETRY_PREFIX + account.id + '-' + attempt, {
      delayInMinutes: delayMin,
    });
  }

  async function _handleKeyRetryAlarm(alarmName) {
    // Strip prefix → "<accountId>-<attempt>"
    const tail = alarmName.slice(_KEY_RETRY_PREFIX.length);
    const lastDash = tail.lastIndexOf('-');
    if (lastDash < 0) return;
    const accountId = tail.slice(0, lastDash);
    const attempt = parseInt(tail.slice(lastDash + 1), 10);

    const account = getAccount(accountId);
    if (!account || account.keysUnlocked || account.authError) return; // gone, recovered, or dead

    try {
      await unlockKeys(accountId);
      debugLog('[ProtonAccounts] Retry succeeded for', account.email);
      if (typeof ProtonPoller !== 'undefined') {
        ProtonPoller.poll();
      }
    } catch (err) {
      debugLog('[ProtonAccounts] Retry', attempt + 1, 'failed for', account.email, ':', err.message);
      _retryUnlockWithBackoff(account, attempt + 1);
    }
  }

  // How long an unlocked key set is trusted before it is re-read.
  //
  // Proton's own stated root cause for the post-quantum rollout was "some
  // clients did not update the key in memory". This used to return the moment
  // the set was populated, so nothing was re-read for the life of the worker.
  //
  // Keys are ADDITIVE, so nothing already decryptable breaks: the failure is
  // silent and only affects NEW key material. Opting into post-quantum
  // generates a v6 user key and v6 ADDRESS keys, and because Proton wraps a
  // calendar passphrase to the primary address key, a new primary alone can
  // start failing until the process restarts.
  //
  // MV3 tears the Chrome worker down constantly, which masks this; Firefox's
  // event page persists far longer, so it is real there.
  const _KEYS_FRESH_FOR_MS = 30 * 60 * 1000;

  function _keysAreFresh(account) {
    if (!account.keysUnlocked) return false;
    // No timestamp means it was unlocked before this bound existed, or restored
    // from storage. Treat as stale and re-read once; that is cheap and leaves
    // no way to pin an unbounded set.
    if (!account.keysUnlockedAt) return false;
    const age = Date.now() - account.keysUnlockedAt;
    return age >= 0 && age < _KEYS_FRESH_FOR_MS; // negative: clock stepped back
  }

  /** Force the next ensureKeysUnlocked to re-read from the API.
   *  Call when a failure is what a missing key would look like. */
  function invalidateKeys(accountId) {
    const account = getAccount(accountId);
    if (!account) return;
    account.keysUnlockedAt = 0;
    // "Re-read from the API" has to mean the API, not the session copy below.
    invalidateBootstrap(accountId);
  }

  // --- Bootstrap cache: core/v4/users + core/v4/addresses ---
  //
  // Unlocking the keys needs both responses, and MV3 tears the background down
  // between nearly every poll, so they were fetched on almost every poll: with
  // the ViewMode read, 58% of all API calls in a real 6-hour log. They change
  // rarely (a new address or key, a plan change), so keep them for the browser
  // session in storage.session, which is memory-only and never written to disk.
  //
  // The bound is the same 30 minutes the in-memory key set already has, and a
  // set unlocked from this copy is dated to when the copy was FETCHED, so key
  // material is never older than that however often the worker restarts. The
  // event stream drops the copy early when it reports a User or Addresses
  // change, and so do invalidateKeys, a failed unlock and account removal.
  //
  // It holds the same data the unlock already held in memory: armored keys
  // (still passphrase-protected), address list, display names, plan fields.
  // One key per account, so a write or a removal touches only that account.
  // A shared object read, changed and written back let one account's write
  // restore another account's copy that had just been dropped.
  const BOOTSTRAP_KEY = 'protonBootstrap';
  const _bootstrapKey = id => BOOTSTRAP_KEY + ':' + id;

  async function _readBootstrap(account) {
    if (!browser.storage.session || account._bootstrapInvalid) return null;
    try {
      const key = _bootstrapKey(account.id);
      const stored = await browser.storage.session.get(key);
      const entry = stored && stored[key];
      if (!entry || entry.uid !== account.uid) return null;
      // A negative age is a clock stepped back: never trust that as fresh.
      const age = Date.now() - entry.at;
      if (!(age >= 0 && age < _KEYS_FRESH_FOR_MS)) return null;
      if (!entry.userResult || !entry.addrResult) return null;
      return entry;
    } catch (_) { return null; }
  }

  async function _writeBootstrap(account, userResult, addrResult, at) {
    if (!browser.storage.session) return;
    try {
      await browser.storage.session.set({
        [_bootstrapKey(account.id)]: { uid: account.uid, at, userResult, addrResult },
      });
      account._bootstrapInvalid = false;
    } catch (_) { /* no cache is fine: the next unlock fetches */ }
  }

  /** Drop the session copy of an account's user and address data. */
  function invalidateBootstrap(accountId) {
    const account = getAccount(accountId);
    // Flag first: the storage write is async, and an unlock racing it must not
    // pick up the copy being dropped.
    if (account) account._bootstrapInvalid = true;
    if (!browser.storage.session) return Promise.resolve();
    return (async () => {
      try {
        await browser.storage.session.remove(_bootstrapKey(accountId));
      } catch (_) { /* non-fatal: the TTL still bounds it */ }
    })();
  }

  /** Try to unlock keys for an account if they aren't already unlocked.
   *  Returns true if keys are (now) unlocked. */
  async function ensureKeysUnlocked(accountId) {
    const account = getAccount(accountId);
    if (!account) return false;
    if (_keysAreFresh(account)) return true;
    if (!account.keyPassword) return false;

    try {
      await unlockKeys(accountId);
      return true;
    } catch (err) {
      console.warn('[ProtonAccounts] ensureKeysUnlocked failed for',
        account.email || account.username, ':', err.message);
      // A re-read that failed must not leave the old set looking fresh, but the
      // set itself is still usable: keep serving it rather than locking the
      // user out over a transient network error.
      return !!account.keysUnlocked;
    }
  }

  // --- Proactive token refresh: a safety net, NOT a heartbeat ---
  //
  // This used to rotate the refresh token every ~15-20 min to keep the session
  // "warm". Nothing needed that.
  //
  // Measured over the active time in diagnostic logs (sleep excluded), the
  // timer meant about 3.3 rotations per hour, where a client that refreshes
  // only on a 401 needs about 2: the access token lives roughly 30 minutes.
  // Dropping the timer cuts that churn by about a third, with nothing lost.
  //
  // No Proton client does this. Their own clients refresh ONLY on a 401:
  //   go-proton-api  client.go: "If we receive a 401, we need to refresh the auth."
  //   WebClients     withApiHandlers.ts: refreshHandler() inside the UNAUTHORIZED branch
  //   Proton Pass    handlers.ts: same, and it is a browser extension like us
  // None of them runs a refresh timer.
  //
  // So the reactive path (401 -> refresh -> retry) is the real mechanism, and it
  // is the hardened one: Web-Locks serialized, coalesced, 30 s timeout. What
  // remains here is only a long safety net so a genuinely idle session cannot
  // rot, at a cadence low enough to be irrelevant to token churn.
  const _TOKEN_REFRESH_PERIOD_MIN = 60; // alarm ticks hourly; the interval below decides
  // Minimum age before the safety net actually rotates anything. Most ticks
  // no-op, which is the point.
  const _TOKEN_REFRESH_MIN_INTERVAL_MS = 12 * 60 * 60 * 1000; // 12 hours
  // A reactive (401-triggered) refresh that fires within this window of a SUCCESSFUL
  // refresh is the "in-flight request still carried the pre-refresh access token"
  // race: the new access token is already valid, so rotating AGAIN just re-uses the
  // freshly-rotated refresh token inside Proton's reuse-detection window and 10013s:
  // a FALSE "session expired". We coalesce those (see _doRefreshTokens). Diagnostic
  // logs showed the redundant reactive firing ~130-540ms after the proactive refresh.
  const _REACTIVE_REFRESH_COALESCE_MS = 10 * 1000; // 10 seconds
  const ALARM_TOKEN_REFRESH = 'proton-token-refresh';
  const ALARM_TOKEN_REFRESH_INITIAL = 'proton-token-refresh-initial';

  async function _startProactiveRefresh() {
    // Alarms survive Chrome MV3 service-worker restarts; setInterval would not.
    //
    // Create it ONLY if it is not already scheduled. alarms.create() with an
    // existing name REPLACES that alarm and restarts its delay, so re-creating
    // it on every cold start pushed the periodic alarm perpetually into the
    // future and it never fired on its own schedule. The refresh cadence was
    // therefore set by cold-start frequency, not by this period.
    try {
      const existing = await browser.alarms.get(ALARM_TOKEN_REFRESH);
      if (existing) return;
    } catch (e) {
      // alarms.get unavailable or failed: fall through and (re)create. Worst
      // case is the old reset-on-cold-start behaviour, which the 12-hour
      // interval check makes harmless anyway.
    }
    browser.alarms.create(ALARM_TOKEN_REFRESH, {
      delayInMinutes: _TOKEN_REFRESH_PERIOD_MIN,
      periodInMinutes: _TOKEN_REFRESH_PERIOD_MIN,
    });
  }

  /** Remove the retired 30-second post-startup refresh alarm.
   *
   *  It was re-armed on every cold start, which is precisely how the token came
   *  to rotate every ~68 s and later every ~15 min. Existing installs still have
   *  it scheduled, so clear it once on upgrade rather than leaving it firing. */
  function _clearLegacyRefreshAlarm() {
    try {
      const p = browser.alarms.clear(ALARM_TOKEN_REFRESH_INITIAL);
      if (p && p.catch) p.catch(() => {});
    } catch (e) { /* nothing to clear */ }
  }

  async function _refreshAllTokens() {
    for (const account of _accounts) {
      // Skip accounts already known-dead (permanent auth error): refreshing a
      // revoked/consumed token can only 10013, hammering the API and the log.
      if (!account.accessToken || !account.refreshToken || account.authError) continue;
      // The safety net only fires on a genuinely old token. Every other tick
      // no-ops here, which is the intended steady state: refreshes should come
      // from 401s, not from a timer.
      if (account.lastRefreshAt && (Date.now() - account.lastRefreshAt) < _TOKEN_REFRESH_MIN_INTERVAL_MS) {
        continue;
      }
      try {
        await _refreshTokens(account, 'proactive');
        debugLog('[ProtonAccounts] Proactive refresh succeeded for', account.email);
      } catch (err) {
        // refresh.fail is recorded inside _refreshTokens, once per ATTEMPT
        // rather than once per caller waiting on the coalesced promise.
        //
        // A permanent failure (10013 / disabled) means the session is dead.
        // Mark it so the badge shows "!", the user is notified, and we stop
        // retrying it every wake. Previously the proactive path failed silently
        // forever until a reactive request finally surfaced it.
        if (err && err.permanent) _setAuthError(account, 'reauth');
        debugLog('[ProtonAccounts] Proactive refresh failed for', account.email, ':', err.message);
      }
    }
  }

  // --- Account CRUD ---

  function hasAccounts() {
    return _accounts.length > 0;
  }

  /**
   * Get public account info for UI display. Label, initials and color are
   * Pro settings, given out as in effect: without Premium they read as
   * unset (the email, its initials, the default color) and stay stored for
   * when Premium is back. The other per-account settings are given out as
   * stored, for the Pro settings panel; they take effect via _folderMode
   * and the notification checks.
   */
  function getAccounts() {
    const premium = _proSettingsApply();
    return _accounts.map(a => ({
      id: a.id,
      username: a.username,
      email: a.email,
      unreadCount: a.unreadCount,
      keysUnlocked: a.keysUnlocked,
      keysUnlocking: a.keysUnlocking || false,
      authError: a.authError || null,
      lastCheckTime: a.lastCheckTime,
      label: (premium && a.label) || '',
      initials: (premium && a.initials) || '',
      color: (premium && a.color) || '',
      notificationsEnabled: a.notificationsEnabled !== false,
      folderMode: a.folderMode || 'inbox',
      monitoredFolders: a.monitoredFolders || [],
      monitoredLabels: a.monitoredLabels || [],
    }));
  }

  /** Get full internal account object. */
  function getAccount(id) {
    return _accounts.find(a => a.id === id) || null;
  }

  // Pending 2FA session (in-memory only)
  let _pending2FA = null;
  // Pending mailbox-password session for legacy two-password (PasswordMode=2)
  // accounts. SRP and any 2FA have already succeeded. We're just waiting for
  // the user to enter their separate mailbox password so we can derive the
  // key passphrase. In-memory only.
  let _pendingMailboxPwd = null;

  /**
   * Shared tail of every login variant (password, 2FA, FIDO2, two-password).
   *
   * Given a successful auth `result`, either re-authenticates a matching
   * existing account (by UID, or by username/email for re-login) or creates a
   * new one, enriches it with the display email (/addresses) and userId
   * (/users), persists, and kicks off key unlock. Returns the account id.
   *
   * Previously this ~30-line block was copy-pasted into login / submit2FA /
   * submitFIDO2 / submitMailboxPassword; the callers differ only in the few
   * parameters below.
   *
   * @param {object} result - session result from a ProtonAuth.* call.
   * @param {object} opts
   * @param {string}  opts.matchUser      - username/email used to match an
   *   existing account for re-auth.
   * @param {string}  opts.initialEmail   - email to fall back to if the
   *   /addresses lookup fails.
   * @param {string}  opts.initialUserId  - pre-known userId; when empty it is
   *   fetched from /users.
   * @param {(email:string)=>string} opts.usernameFor - computes the stored
   *   account.username from the resolved email.
   * @param {boolean} [opts.warnOnEmailError=true] - console.warn (vs silent)
   *   when the /addresses lookup fails.
   * @param {string}  [opts.label='']       - suffix for the "Account added" log.
   * @param {string}  [opts.reauthLabel=''] - suffix for the re-auth debug log.
   * @returns {Promise<string>} the account id.
   */
  // Curated swatch palette (mirrors popup/color-picker.js) used to auto-assign
  // a distinct colour to each newly-added account so accounts are easy to tell
  // apart in the list, avatars and (themed) section headers.
  const ACCOUNT_COLOR_PALETTE = [
    '#6D4AFF', '#8B5CF6', '#A855F7', '#EC4899', '#F43F5E',
    '#DB3251', '#EF4444', '#EC5E30', '#F59E0B', '#F5A623',
    '#84CC16', '#3CBB6E', '#22C55E', '#14B8A6', '#06B6D4',
    '#1EA0D5', '#3B82F6', '#6366F1', '#1B1340', '#6B7280',
  ];

  function _hexToHue(hex) {
    const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex || '');
    if (!m) return null;
    const r = parseInt(m[1], 16) / 255, g = parseInt(m[2], 16) / 255, b = parseInt(m[3], 16) / 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
    if (d === 0) return null; // grey: no meaningful hue
    let h;
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    return ((Math.round(h * 60)) + 360) % 360;
  }

  function _hslToHex(h, s, l) {
    s /= 100; l /= 100;
    const a = s * Math.min(l, 1 - l);
    const f = (n) => {
      const k = (n + h / 30) % 12;
      const c = l - a * Math.max(-1, Math.min(k - 3, Math.min(9 - k, 1)));
      return Math.round(255 * c).toString(16).padStart(2, '0');
    };
    return `#${f(0)}${f(8)}${f(4)}`;
  }

  /** Pick a colour for a newly-added account that differs from every existing
   *  account's colour. Prefers a random unused swatch from the curated palette;
   *  if all swatches are taken, generates a random hue kept away from existing
   *  ones. The default-coloured first account counts as using the brand purple. */
  function _pickDistinctAccountColor() {
    const used = new Set(_accounts.map(a => (a.color || '#6D4AFF').toLowerCase()));
    const free = ACCOUNT_COLOR_PALETTE.filter(c => !used.has(c.toLowerCase()));
    if (free.length) return free[Math.floor(Math.random() * free.length)];
    const usedHues = _accounts.map(a => _hexToHue(a.color || '#6D4AFF')).filter(h => h !== null);
    if (!usedHues.length) return _hslToHex(Math.floor(Math.random() * 360), 68, 56);
    // Pick the hue farthest from every existing hue, and nudge lightness by
    // count so even a repeated hue stays visually distinguishable.
    let bestHue = 0, bestGap = -1;
    for (let h = 0; h < 360; h += 5) {
      const gap = Math.min(...usedHues.map(uh => { const d = Math.abs(h - uh); return Math.min(d, 360 - d); }));
      if (gap > bestGap) { bestGap = gap; bestHue = h; }
    }
    return _hslToHex(bestHue, 68, 48 + (_accounts.length % 3) * 8);
  }

  async function _completeLoginWithResult(result, opts) {
    const {
      matchUser = '', initialEmail = '', initialUserId = '',
      usernameFor, warnOnEmailError = true, label = '', reauthLabel = '',
    } = opts;

    /** Adopt a freshly minted session into an account we already have. */
    const _adoptSession = async (account, foundBy) => {
      account.uid = result.uid;
      account.accessToken = result.accessToken;
      account.refreshToken = result.refreshToken;
      account.keyPassword = result.keyPassword;
      account.keyPasswords = result.keyPasswords || {};
      account.consecutiveErrors = 0;
      account.authError = null;
      // A rotated UID = a fresh server-side session; stamp it so the diagnostic
      // log can report how long a session lived before it was revoked. The fresh
      // tokens are effectively "just refreshed", so stamp lastRefreshAt too: keeps
      // the proactive throttle (and the refresh coalesce) from immediately
      // re-rotating a brand-new login token.
      account.sessionCreatedAt = Date.now();
      account.lastRefreshAt = Date.now();
      await _save();
      await unlockKeys(account.id);
      debugLog('[ProtonAccounts] Re-authenticated existing account' +
        (reauthLabel ? ' (' + reauthLabel + ')' : '') + ' by ' + foundBy + ':', account.email);
      return account.id;
    };

    // Re-auth an existing account (UID may rotate on re-login). Identifier
    // matching is shared with the free-tier gate (lib/account-limit.js) so the
    // two can never disagree: a mismatch would either lock a user out of
    // their own account or silently create a duplicate.
    const existing = _accounts.find(a => a.uid === result.uid) ||
      ProtonAccountLimit.findByLogin(_accounts, matchUser);
    if (existing) return _adoptSession(existing, 'session/identifier');

    // Enrich: display email from /addresses.
    let email = initialEmail;
    try {
      const addrResult = await _rawRequest(
        result.uid, result.accessToken, 'GET', 'core/v4/addresses');
      const addresses = addrResult.Addresses || [];
      if (addresses.length > 0) email = addresses[0].Email;
    } catch (e) {
      if (warnOnEmailError) console.warn('[ProtonAccounts] Could not fetch email:', e.message);
    }

    // Enrich: userId from /users (for account alignment), unless already known.
    let userId = initialUserId;
    if (!userId) {
      try {
        const userResult = await _rawRequest(result.uid, result.accessToken, 'GET', 'core/v4/users');
        userId = userResult.User && userResult.User.ID || '';
      } catch (e) { /* best-effort userId enrichment */ }
    }

    // The account is also recognisable by its Proton UserID or its real
    // address, which only the server can tell us. Re-check now that the
    // identity is known, so signing in with something the list didn't
    // recognise (an alias, or the username where the list stored the address)
    // still re-authenticates instead of duplicating the account.
    const knownNow = _accounts.find(a =>
      (userId && a.userId && a.userId === userId) ||
      ProtonAccountLimit.matchesLogin(a, email));
    if (knownNow) {
      if (!knownNow.userId && userId) knownNow.userId = userId;
      return _adoptSession(knownNow, 'identity');
    }

    // Authoritative free-tier check: this login WOULD create a new account.
    // The ADD_ACCOUNT gate could only judge the typed identifier; now we know
    // who this really is. Unlike that gate this admits no recovery exception:
    // reaching here means the account genuinely isn't one we hold. Drop the
    // session we just minted rather than leaving it live on Proton's side.
    if (typeof ProtonPremium !== 'undefined' &&
        ProtonAccountLimit.blocksNewAccount({
          accounts: _accounts, isPremium: ProtonPremium.isPremium(),
        })) {
      try {
        await _rawRequest(result.uid, result.accessToken, 'DELETE', 'auth/v4');
      } catch (e) { /* best-effort revoke of the unused session */ }
      debugLog('[ProtonAccounts] Refused second account on free tier');
      throw new Error('PREMIUM_REQUIRED');
    }

    const account = {
      id: _generateId(),
      username: usernameFor(email),
      email,
      uid: result.uid,
      userId,
      sessionCreatedAt: Date.now(),
      lastRefreshAt: Date.now(),
      accessToken: result.accessToken,
      refreshToken: result.refreshToken,
      keyPassword: result.keyPassword,
      keyPasswords: result.keyPasswords || {},
      decryptedKeys: [],
      keysUnlocked: false,
      keysUnlocking: false,
      unreadCount: 0,
      messages: [],
      lastEventId: null,
      lastCheckTime: null,
      consecutiveErrors: 0,
    };

    // Give each additional account a distinct colour (the first account keeps
    // the default brand colour) so multi-account setups are easy to tell apart.
    if (_accounts.length > 0) {
      account.color = _pickDistinctAccountColor();
    }

    _accounts.push(account);
    await _save();

    try {
      await unlockKeys(account.id);
    } catch (err) {
      console.warn('[ProtonAccounts] Key unlock failed:', err.message);
    }

    debugLog('[ProtonAccounts] Account added' + (label ? ' (' + label + ')' : ''));
    return account.id;
  }

  /** Add a new account via SRP login. Returns the account ID or 2FA prompt. */
  async function login(username, password, captchaToken) {
    debugLog('[ProtonAccounts] Logging in');

    const result = await ProtonAuth.login(username, password, captchaToken);

    if (result.needs2FA) {
      _pending2FA = result;
      debugLog('[ProtonAccounts] 2FA required, type:', result.twoFactorType);
      return { needs2FA: true, twoFactorType: result.twoFactorType };
    }

    if (result.needsMailboxPassword) {
      _pendingMailboxPwd = result;
      debugLog('[ProtonAccounts] Mailbox password required (two-password account)');
      return { needsMailboxPassword: true };
    }

    return _completeLoginWithResult(result, {
      matchUser: username,
      initialEmail: username,
      initialUserId: result.userId || '',
      usernameFor: () => username,
    });
  }

  /** Complete 2FA login with a TOTP code. */
  async function submit2FA(code) {
    if (!_pending2FA) throw new Error('No pending 2FA session');

    debugLog('[ProtonAccounts] Submitting 2FA code...');
    const result = await ProtonAuth.submit2FA(_pending2FA, code);
    const partialSession = _pending2FA;
    _pending2FA = null;

    // Two-password account: SRP+2FA done, but keys still need the mailbox
    // password. Defer to the mailbox-password prompt.
    if (result.needsMailboxPassword) {
      _pendingMailboxPwd = result;
      debugLog('[ProtonAccounts] Mailbox password required after 2FA');
      return { needsMailboxPassword: true };
    }

    const pendingUser = partialSession._username || '';
    return _completeLoginWithResult(result, {
      matchUser: pendingUser,
      initialEmail: pendingUser || '',
      initialUserId: '',
      usernameFor: (email) => email,
      label: '2FA',
    });
  }

  /** Complete 2FA login with a FIDO2/WebAuthn credential. */
  async function submitFIDO2(fido2Response) {
    if (!_pending2FA) throw new Error('No pending 2FA session');

    debugLog('[ProtonAccounts] Submitting FIDO2 credential...');
    const result = await ProtonAuth.submitFIDO2(_pending2FA, fido2Response);
    const pendingUser = _pending2FA._username || '';
    _pending2FA = null;

    // Two-password account: defer to mailbox-password prompt.
    if (result.needsMailboxPassword) {
      _pendingMailboxPwd = result;
      debugLog('[ProtonAccounts] Mailbox password required after FIDO2');
      return { needsMailboxPassword: true };
    }

    // Same upsert/enrich tail as the other login variants. Note: FIDO2 stays
    // silent on an /addresses failure and has no initial email fallback.
    return _completeLoginWithResult(result, {
      matchUser: pendingUser,
      initialEmail: '',
      initialUserId: '',
      usernameFor: (email) => email,
      warnOnEmailError: false,
      label: 'FIDO2',
      reauthLabel: 'FIDO2',
    });
  }

  /**
   * Complete login for a two-password (legacy) account. Called after the user
   * enters their separate mailbox password. Derives the key passphrase from
   * the mailbox password (NOT the SRP login password) and unlocks keys.
   */
  async function submitMailboxPassword(mailboxPassword) {
    if (!_pendingMailboxPwd) throw new Error('No pending mailbox password session');

    debugLog('[ProtonAccounts] Submitting mailbox password...');
    const pending = _pendingMailboxPwd;
    let result;
    try {
      result = await ProtonAuth.submitMailboxPassword(pending, mailboxPassword);
    } catch (err) {
      // _completeLogin failure (e.g. /users 401): keep pending session for retry.
      console.warn('[ProtonAccounts] Mailbox password submission failed:', err.message);
      throw err;
    }

    // Wrong-mailbox-password failures don't surface from _completeLogin: bcrypt
    // produces a deterministic-but-wrong keyPassword that only fails when we
    // try to PGP-decrypt the user's private key. Validate inline BEFORE
    // mutating any account state, so a retry is possible.
    try {
      const userResult = await _rawRequest(
        result.uid, result.accessToken, 'GET', 'core/v4/users');
      const user = userResult && userResult.User;
      if (!user || !user.Keys || user.Keys.length === 0) {
        throw new Error('No user keys found');
      }
      const selection = ProtonPqc.selectUsableKey(user.Keys);
      if (selection.allUnsupported) {
        const e = new Error('Account uses post-quantum keys this version cannot read');
        e.code = 'PQC_UNSUPPORTED';
        throw e;
      }
      const keyObj = await openpgp.readPrivateKey({ armoredKey: selection.key.PrivateKey });
      await openpgp.decryptKey({ privateKey: keyObj, passphrase: result.keyPassword });
    } catch (err) {
      // A post-quantum key ring fails while being PARSED, before the passphrase
      // is ever tried, so reporting it as a bad password sends the user round in
      // circles re-entering a correct one.
      if (err.code === 'PQC_UNSUPPORTED') throw err;
      // Wrong mailbox password (or unrelated key error). Pending session is
      // intentionally preserved so the user can retry.
      debugLog('[ProtonAccounts] Mailbox password validation failed:', err.message);
      const e = new Error('Mailbox password is incorrect');
      e.cause = err;
      throw e;
    }

    _pendingMailboxPwd = null;

    // Same upsert/enrich tail as the other login variants.
    const pendingUser = pending._username || '';
    return _completeLoginWithResult(result, {
      matchUser: pendingUser,
      initialEmail: pendingUser || '',
      initialUserId: result.userId || '',
      usernameFor: (email) => pendingUser || email,
      label: 'two-password',
      reauthLabel: 'two-password',
    });
  }

  function getFIDO2Options() {
    return _pending2FA ? _pending2FA.fido2Options : null;
  }

  function getPending2FAType() {
    if (!_pending2FA) return null;
    // If user already chose a method, return that instead of 'both'
    return _pending2FA._chosenMethod || _pending2FA.twoFactorType;
  }

  function set2FAMethod(method) {
    if (_pending2FA) _pending2FA._chosenMethod = method;
  }

  /** Reorder accounts by moving one up or down. */
  async function reorderAccount(id, direction) {
    const idx = _accounts.findIndex(a => a.id === id);
    if (idx < 0) return;
    const newIdx = direction === 'up' ? idx - 1 : idx + 1;
    if (newIdx < 0 || newIdx >= _accounts.length) return;
    const temp = _accounts[idx];
    _accounts[idx] = _accounts[newIdx];
    _accounts[newIdx] = temp;
    await _save();
  }

  /** Update per-account settings. */
  async function updateAccountSettings(id, settings) {
    const account = getAccount(id);
    if (!account) return;
    if (settings.label !== undefined) account.label = settings.label;
    if (settings.initials !== undefined) account.initials = settings.initials;
    if (settings.color !== undefined) account.color = settings.color;
    if (settings.notificationsEnabled !== undefined) account.notificationsEnabled = settings.notificationsEnabled;
    // Folder/label monitoring changes alter WHICH messages we show. The poller's
    // incremental event stream (_pollAccountViaEvents) only reports changes since
    // lastEventId, so a newly-monitored folder's PRE-EXISTING mail isn't a "new
    // event" and wouldn't surface until a later full poll, the ~1-min delay the
    // user sees. Drop the event cursor when the monitored scope changes so the
    // very next poll (incl. the REFRESH the popup fires right after) takes the
    // full-fetch branch (_pollAccountViaCounts) and the new folder's messages
    // appear immediately. That branch re-arms lastEventId, so it costs one full poll.
    const scopeChanged =
      settings.folderMode !== undefined ||
      settings.monitoredFolders !== undefined ||
      settings.monitoredLabels !== undefined;
    const scopeBefore = _scopeKey(account);
    if (settings.folderMode !== undefined) account.folderMode = settings.folderMode;
    if (settings.monitoredFolders !== undefined) account.monitoredFolders = settings.monitoredFolders;
    if (settings.monitoredLabels !== undefined) account.monitoredLabels = settings.monitoredLabels;
    // Each picker sends only its own list, so a deleted ID kept in the other
    // one would survive the edit and turn "nothing ticked" into "monitor
    // nothing" instead of Inbox. This is the user's own choice: drop them all.
    if (scopeChanged) Object.assign(account, ProtonMonitoredIds.withoutDeleted(account));
    if (scopeChanged) {
      account.lastEventId = null;
      if (_scopeKey(account) !== scopeBefore) account.scopeGen = (account.scopeGen || 0) + 1;
      // The cursor lives in the session snapshot, not in _save(). Write the
      // reset there FIRST: a teardown between the two writes must leave the
      // old scope with no cursor, never the new scope with the old cursor.
      await saveSnapshot();
    }
    await _save();
  }

  /** What an account monitors, as a key that changes only when the effective
   *  set of queried IDs does. Order-independent, and never empty (a custom
   *  selection whose folders were all deleted is 'custom:'). */
  function _scopeKey(account) {
    const mode = _folderMode(account);
    return mode + ':' + _monitoredQueryIds(account).slice().sort().join(',');
  }

  /**
   * Premium started or ended, so every account with a stored folder mode
   * other than Inbox now monitors something else. Reset its cursor like a
   * change in the picker does, so the next poll fetches the new set in full
   * and takes its existing mail in silently. Resolves true when any changed.
   */
  async function applyPremiumScope(premium) {
    const changed = _accounts.filter(a => _folderMode(a, !premium) !== _folderMode(a, premium));
    if (!changed.length) return false;
    for (const a of changed) {
      a.lastEventId = null;
      a.scopeGen = (a.scopeGen || 0) + 1;
      // In the snapshot too: should the settings write below be lost, the
      // count still does not count as taken for the new folders.
      a.countGen = null;
    }
    // Snapshot before settings, for the same reason as updateAccountSettings.
    await saveSnapshot();
    await _save();
    return true;
  }

  /**
   * Export per-account settings (safe, non-sensitive data only).
   * Keyed by email so settings survive account re-login on another device.
   */
  function getAccountSettingsExport() {
    const result = {};
    for (const a of _accounts) result[a.email] = _exportEntry(a);
    return result;
  }

  function _exportEntry(a) {
    return {
      label: a.label || '',
      initials: a.initials || '',
      color: a.color || '',
      notificationsEnabled: a.notificationsEnabled !== false,
      folderMode: a.folderMode || 'inbox',
      monitoredFolders: a.monitoredFolders || [],
      monitoredLabels: a.monitoredLabels || [],
    };
  }

  /**
   * Import per-account settings by matching email addresses.
   * Only updates accounts that exist locally; ignores unknown emails.
   */
  async function importAccountSettings(accountSettingsMap) {
    const result = { changed: false, scopeChanged: [] };
    if (!accountSettingsMap || typeof accountSettingsMap !== 'object') return result;
    debugLog('[ProtonAccounts] Import account settings, keys:', Object.keys(accountSettingsMap),
      'local accounts:', _accounts.map(a => a.email));
    let changed = false;
    for (const a of _accounts) {
      const imported = accountSettingsMap[a.email];
      if (!imported) {
        debugLog('[ProtonAccounts] No match for', a.email);
        continue;
      }
      debugLog('[ProtonAccounts] Applying settings for', a.email);
      // Firefox Sync re-imports on EVERY worker start, so what matters is
      // whether anything actually changed: an unconditional save cost a
      // storage write and four encryptions per account per start, and an
      // unconditional cursor reset would turn every start into a full poll.
      const before = JSON.stringify(_exportEntry(a));
      const scopeBefore = _scopeKey(a);
      if (imported.label !== undefined) a.label = imported.label;
      if (imported.initials !== undefined) a.initials = imported.initials;
      if (imported.color !== undefined) a.color = imported.color;
      if (imported.notificationsEnabled !== undefined) a.notificationsEnabled = imported.notificationsEnabled;
      if (imported.folderMode !== undefined) a.folderMode = imported.folderMode;
      if (imported.monitoredFolders !== undefined) a.monitoredFolders = imported.monitoredFolders;
      if (imported.monitoredLabels !== undefined) a.monitoredLabels = imported.monitoredLabels;
      // A synced or imported copy can predate this device finding a folder
      // deleted. Strip those IDs, or every worker start would bring them back.
      if (a.staleMonitorIds && a.staleMonitorIds.length) {
        Object.assign(a, ProtonMonitoredIds.withoutStale(a, a.staleMonitorIds));
      }
      if (JSON.stringify(_exportEntry(a)) !== before) changed = true;
      // A different folder set on the same cursor would keep showing the old
      // folders' list until some count happened to change. Reset it, like a
      // change made in the picker does.
      if (_scopeKey(a) !== scopeBefore) {
        result.scopeChanged.push(a.id);
        a.lastEventId = null;
        a.scopeGen = (a.scopeGen || 0) + 1;
        changed = true; // scopeGen is saved
      }
    }
    // Snapshot before settings, for the same reason as updateAccountSettings.
    if (result.scopeChanged.length) await saveSnapshot();
    if (changed) await _save();
    result.changed = changed;
    return result;
  }

  /** Remove an account, revoking the server-side session first. */
  async function removeAccount(id) {
    const account = getAccount(id);
    if (account && account.uid && account.accessToken) {
      try {
        await _rawRequest(account.uid, account.accessToken, 'DELETE', 'auth/v4');
      } catch (_) {
        // Best-effort: session may already be expired
      }
    }
    _accounts = _accounts.filter(a => a.id !== id);
    invalidateBootstrap(id);
    try { ProtonAIAssistant.clearCapability(id); } catch (_) { /* module optional */ }
    await _save();
    // Keep the persisted message cache in step with the accounts: drop the whole
    // thing once the last account is gone (there is no global "logout": removing
    // an account IS the logout), otherwise re-persist so the removed account's
    // mail no longer lives in the cache.
    if (_accounts.length === 0) {
      await _wipeEncryptedCache();
      if (browser.storage.session) {
        try { await browser.storage.session.remove(SNAPSHOT_KEY); } catch (_) { /* non-fatal */ }
      }
    } else {
      _persistEncryptedCache().catch(() => {});
    }
    debugLog('[ProtonAccounts] Account removed');
  }

  function _generateId() {
    const bytes = crypto.getRandomValues(new Uint8Array(12));
    return ProtonBinary.bytesToHex(bytes);
  }

  // --- API Requests ---

  /**
   * Verbose API trace, debug-logging only.
   *
   * Records WHAT was called and HOW it answered, never what came back. A
   * SUCCESSFUL Proton response routinely carries secrets: auth/v4/refresh
   * returns access and refresh tokens, core/v4/users returns private key
   * material, mail/v4/messages returns bodies. None of that may reach a file
   * the user exports and mails to a stranger. So success logs status only.
   *
   * An ERROR body is different: Proton's is {Code, Error, Details}, which is
   * diagnostic by design and carries no content. That is the part worth having,
   * and its absence is exactly what made "Invalid or missing message signature"
   * so expensive to chase.
   *
   * The query string is dropped: core/v4/keys?Email=... would otherwise put a
   * recipient's address in the log.
   */
  function _recordApiCall(method, path, status, errorBody) {
    try {
      if (typeof isDebugLoggingEnabled !== 'function' || !isDebugLoggingEnabled()) return;
      if (typeof ProtonDiag === 'undefined' || !ProtonDiag.record) return;
      const fields = { method, path: String(path || '').split('?')[0], status };
      if (errorBody) {
        if (errorBody.Code !== undefined) fields.apiCode = errorBody.Code;
        if (errorBody.Error !== undefined) fields.apiError = String(errorBody.Error).slice(0, 200);
        if (errorBody.Details !== undefined) {
          try { fields.apiDetails = JSON.stringify(errorBody.Details).slice(0, 300); } catch (_) { /* ignore */ }
        }
      }
      ProtonDiag.record(errorBody ? 'api.fail' : 'api', fields);
    } catch (_) { /* tracing must never break a request */ }
  }

  /** Raw authenticated request (no retry logic). */
  async function _rawRequest(uid, accessToken, method, path, { params, data } = {}) {
    let url = `${BASE_URL}/${path}`;
    if (params) {
      url += '?' + new URLSearchParams(params).toString();
    }

    const headers = ProtonConfig.buildHeaders(uid, accessToken);

    const opts = { method, headers, credentials: 'omit' };
    if (data) opts.body = JSON.stringify(data);

    const resp = await fetch(url, opts);
    if (!resp.ok) {
      const body = await resp.json().catch(() => ({}));
      _recordApiCall(method, path, resp.status, body);
      const err = new Error(body.Error || `HTTP ${resp.status}`);
      err.status = resp.status;
      err.code = body.Code;
      err.details = body.Details;
      // Honor server rate-limit guidance (429/503): expose Retry-After so
      // the poller can defer the next poll instead of using its own backoff.
      if (resp.status === 429 || resp.status === 503) {
        const retryAfter = parseInt(resp.headers.get('retry-after') || '', 10);
        if (retryAfter > 0) err.retryAfterSec = retryAfter;
      }
      // When the SERVER produced this 401, on its own clock. The reactive
      // refresh compares it against the server date of the last refresh to tell
      // a genuinely-expired token from a 401 that was already in flight when we
      // rotated. Only 401 needs it; reading the header for every error would be
      // noise. Null when absent, and the caller falls back accordingly.
      if (resp.status === 401) err.responseDate = ProtonAuth.parseDateHeader(resp.headers);
      throw err;
    }
    _recordApiCall(method, path, resp.status);
    return resp.json();
  }

  // Proton error codes that mean the account can never recover on its own
  // (matches WebClients packages/shared/lib/errors.ts API_CUSTOM_ERROR_CODES).
  const ERROR_CODE_ACCOUNT_DELETED = 10002;
  const ERROR_CODE_ACCOUNT_DISABLED = 10003; // AUTH_ACCOUNT_DISABLED

  /**
   * Mark an account as needing user action (re-login or account recovery).
   *
   * Sets authError ('reauth' | 'disabled') and drops the decrypted keys so the
   * popup's existing "session expired: Sign in" banner appears. The poller
   * skips authError'd accounts entirely: no point hammering the API with
   * requests that can only fail until the user signs in again.
   */
  function _setAuthError(account, reason) {
    if (account.authError === reason) return;
    account.authError = reason;
    account.keysUnlocked = false;
    account.decryptedKeys = [];
    _save().catch(() => {}); // persist the dead flag so restarts don't re-storm
    // Drop this dead session's mail from the on-disk cache (re-persist skips
    // authError accounts) so a restart doesn't resurrect a revoked session's mail.
    _persistEncryptedCache().catch(() => {});
    // Enriched death-log: this fires exactly once per revocation now that a
    // plain-request success no longer clears authError. uid + ages let the kill
    // moment be correlated against Proton's own server-side security/session log
    // (e.g. a Sentinel revocation of the "Unknown" session). killedAt = entry.t.
    ProtonDiag.record('authError.set', {
      email: account.email,
      reason,
      uid: account.uid ? account.uid.slice(0, 8) : 'none',
      refreshFp: ProtonDiag.fp(account.refreshToken),
      tokenAgeMs: account.lastRefreshAt ? (Date.now() - account.lastRefreshAt) : null,
      sessionAgeMs: account.sessionCreatedAt ? (Date.now() - account.sessionCreatedAt) : null,
    });
    console.warn('[ProtonAccounts] Auth error (' + reason + ') for', account.email,
      '- polling paused until re-login');
    try { ProtonNotifier.notifyAuthError(account.email, reason, account.id); }
    catch (_) { /* notifier unavailable (e.g. unit tests) */ }
    // Repaint the toolbar badge NOW so the "!" appears the instant the session
    // is flagged dead, instead of waiting up to a poll interval for the next
    // _updateBadge() in the poll cycle.
    try { if (typeof ProtonPoller !== 'undefined') ProtonPoller.refreshBadgeNow(); }
    catch (_) { /* poller not loaded (e.g. unit tests) */ }
  }

  /** Clear a previous auth error (after successful request or re-login). */
  function _clearAuthError(account) {
    if (account.authError) {
      account.authError = null;
      _save().catch(() => {}); // persist the recovery (e.g. after re-login)
      // Drop the "!" immediately on genuine recovery (re-login / refresh OK).
      try { if (typeof ProtonPoller !== 'undefined') ProtonPoller.refreshBadgeNow(); }
      catch (_) { /* poller not loaded */ }
    }
  }

  /**
   * Authenticated API request with auto token refresh on 401.
   *
   * On 401, attempts a single token refresh via _refreshTokens(), then retries.
   * Refresh calls are deduplicated per-account via _refreshInFlight to prevent
   * concurrent refreshes from racing and invalidating each other's tokens
   * (Proton rotates both access and refresh tokens on every refresh call).
   *
   * Permanent failures (invalid refresh token, account deleted/disabled) set
   * account.authError so the poller stops retrying and the popup prompts the
   * user to sign in again. Tracks consecutiveErrors for the poller's backoff.
   */
  async function request(accountId, method, path, opts = {}) {
    const account = getAccount(accountId);
    if (!account) throw new Error('Account not found');

    try {
      const result = await _rawRequest(
        account.uid, account.accessToken, method, path, opts);
      account.consecutiveErrors = 0;
      // Do NOT clear authError on a plain request success. A dead *refresh*
      // token leaves the *access* token valid for a few more minutes, so polls
      // keep succeeding after the session is really dead. Clearing here made
      // the "!" badge flicker off and re-armed the doomed proactive refresh
      // (which then 10013s and re-sets it). authError is always permanent
      // (10013 / disabled); only a successful *refresh* (below) or re-login,
      // which mints a NEW refresh token, legitimately clears it.
      return result;
    } catch (err) {
      if (err.status === 401) {
        // Log the 401→refresh transition only while the account is still
        // healthy; once it's marked dead we go quiet (the path guards suppress
        // the retry storm: this avoids any residual log noise).
        //
        // ONE record per refresh cycle, not one per request. A custom-folder
        // poll now fetches every monitored ID at once, so an expired session
        // 401s all of them together; N identical lines would bury the session
        // history this buffer exists to hold, and make a burst look like a
        // series of separate expiries. The flag is cleared when the refresh
        // cycle settles (see _refreshTokens), so a genuinely later 401 still
        // gets its own line.
        if (!account.authError && !_req401Logged.has(account.id)) {
          _req401Logged.add(account.id);
          ProtonDiag.record('req.401', { email: account.email, path });
        }
        // Only the refresh itself belongs in this try. With the retried
        // request inside it, an ordinary error from the RETRY (a 422 from a
        // send, say) was reported as a refresh failure: the real status and
        // code were discarded, a false refresh.fail went into the diagnostic
        // log, and the caller was told "Session expired, please sign in again"
        // for something that had nothing to do with the session. A 401 then
        // refresh then retry is the normal path after any idle period, so this
        // was on the common route, not an edge case.
        try {
          await _refreshTokens(account, 'reactive', { responseDate: err.responseDate });
        } catch (refreshErr) {
          account.consecutiveErrors++;
          // refresh.fail is recorded inside _refreshTokens, once per ATTEMPT.
          // Recorded here, every concurrent 401 waiting on the ONE coalesced
          // refresh wrote its own line, so the count no longer matched the
          // number of refreshes actually tried.
          if (refreshErr.permanent) _setAuthError(account, 'reauth');
          const e = new Error('Session expired, please sign in again');
          e.permanentAuth = refreshErr.permanent === true;
          e.retryAfterSec = refreshErr.retryAfterSec;
          throw e;
        }
        // The refresh worked, so retry once. Anything thrown from here is a
        // real error from the retried call and is reported as itself, with the
        // same deleted/disabled handling the first attempt gets.
        try {
          const result = await _rawRequest(
            account.uid, account.accessToken, method, path, opts);
          account.consecutiveErrors = 0;
          _clearAuthError(account);
          return result;
        } catch (retryErr) {
          account.consecutiveErrors++;
          if (retryErr.code === ERROR_CODE_ACCOUNT_DELETED ||
              retryErr.code === ERROR_CODE_ACCOUNT_DISABLED) {
            _setAuthError(account, 'disabled');
            retryErr.permanentAuth = true;
          }
          throw retryErr;
        }
      }
      account.consecutiveErrors++;
      if (err.code === ERROR_CODE_ACCOUNT_DELETED ||
          err.code === ERROR_CODE_ACCOUNT_DISABLED) {
        _setAuthError(account, 'disabled');
        err.permanentAuth = true;
      }
      throw err;
    }
  }

  /** In-flight refresh promises, keyed by account id.
   *  Prevents concurrent refresh calls from racing and invalidating
   *  each other's refresh tokens (Proton rotates tokens on each use). */
  const _refreshInFlight = {};

  /** Accounts whose current refresh cycle has already logged its req.401.
   *  Emptied when that cycle settles, below. */
  const _req401Logged = new Set();

  // True until the first token refresh of this background generation. Lets the
  // diagnostic log flag "first refresh after a cold start" (lost-write suspect).
  let _coldStartRefresh = true;

  /** Refresh access/refresh tokens for an account (deduplicated).
   *  `trigger` ('reactive' | 'proactive') is recorded for diagnostics. */
  /** Serialize a refresh across ALL extension contexts + background generations
   *  via the Web Locks API. MV3 suspends the background aggressively (especially
   *  on Opera), so a freshly cold-started worker can fire a refresh while another
   *  generation's refresh is still in flight; both then rotate the SAME token and
   *  Proton's reuse-detection kills the family (10013 → intermittent "session
   *  expired"). The origin-scoped lock (auto-released if a holder dies) makes them
   *  run one-at-a-time, so the second one re-reads the rotation and coalesces.
   *  Falls back to unserialized when Web Locks is unavailable (old runtime/tests). */
  function _withRefreshLock(accountId, fn) {
    const locks = (typeof navigator !== 'undefined' && navigator.locks && navigator.locks.request)
      ? navigator.locks : null;
    if (!locks) return Promise.resolve().then(fn);
    return locks.request('mcpm-refresh-' + accountId, fn);
  }

  /** Re-read an account's persisted tokens: another context may have rotated
   *  them while this generation was cold-starting or queued for the refresh lock.
   *  Best-effort: on any failure keep the in-memory tokens. */
  async function _reloadTokensFromStorage(account) {
    try {
      const stored = await browser.storage.local.get('protonAccounts');
      const data = (stored.protonAccounts || []).find(a => a.id === account.id);
      if (!data) return;
      const access = data.encrypted ? await ExtEncryption.decrypt(data.accessToken) : data.accessToken;
      const refresh = data.encrypted ? await ExtEncryption.decrypt(data.refreshToken) : data.refreshToken;
      if (access) account.accessToken = access;
      if (refresh) account.refreshToken = refresh;
      if (data.uid) account.uid = data.uid;
      if (data.lastRefreshAt) account.lastRefreshAt = data.lastRefreshAt;
      if (data.lastRefreshServerAt) account.lastRefreshServerAt = data.lastRefreshServerAt;
    } catch (e) {
      debugLog('[ProtonAccounts] Token reload failed (keeping in-memory):', e.message);
    }
  }

  function _refreshTokens(account, trigger, opts) {
    // If a refresh is already in progress IN THIS worker, reuse it (cheap
    // fast-path; the Web Lock below covers the cross-worker/generation case).
    if (_refreshInFlight[account.id]) {
      debugLog('[ProtonAccounts] Refresh already in progress for', account.email, '- waiting');
      return _refreshInFlight[account.id];
    }

    // This caller OWNS the attempt, so this is the one place that can count
    // refreshes rather than waiters: every other caller is handed the promise
    // above. A later, genuinely separate attempt builds a new chain and so
    // records its own line.
    _refreshInFlight[account.id] = _withRefreshLock(account.id, () => _doRefreshTokens(account, trigger, opts))
      .catch(err => {
        if (!account.authError) {
          ProtonDiag.record('refresh.fail', {
            email: account.email, trigger: trigger || 'reactive',
            uid: account.uid ? account.uid.slice(0, 8) : 'none',
            status: err.status, code: err.code,
            permanent: err.permanent === true, message: err.message,
          });
        }
        throw err;
      })
      .finally(() => {
        delete _refreshInFlight[account.id];
        // The cycle is over: the next 401 is news again.
        _req401Logged.delete(account.id);
      });
    return _refreshInFlight[account.id];
  }

  /** Refresh access/refresh tokens for an account. */
  async function _doRefreshTokens(account, trigger, opts) {
    trigger = trigger || 'reactive';
    opts = opts || {};
    // Now holding the cross-context refresh lock. Re-read the persisted tokens:
    // another background generation may have rotated while we cold-started or
    // queued for the lock. Refreshing with our STALE in-memory token is exactly
    // what trips Proton's reuse-detection (10013).
    const hadToken = account.refreshToken;
    await _reloadTokensFromStorage(account);
    if (hadToken && account.refreshToken && account.refreshToken !== hadToken) {
      // Another context already rotated; our token is current now. Rotating again
      // WOULD be the reuse. Coalesce. A reactive caller then retries its request
      // with the fresh access token we just re-read (no further rotation needed).
      ProtonDiag.record('refresh.coalesced', {
        email: account.email, trigger,
        newRefreshFp: ProtonDiag.fp(account.refreshToken),
      });
      debugLog('[ProtonAccounts] Refresh coalesced, another context rotated', account.email);
      return;
    }
    // Same-context "just refreshed, then 401" race: the 401 came from a request
    // still in flight with the PRE-refresh access token. The new access token is
    // already in account.accessToken (set by the recent refresh, and re-read
    // above), so rotating again would re-use the just-rotated refresh token and
    // 10013: a false "session expired". Skip it; the caller retries with the
    // current access token.
    //
    // Decided by comparing when the SERVER issued the 401 against when the
    // server performed our last refresh. A 401 dated at or before that refresh
    // cannot be about the token we now hold, because the server had not issued
    // it yet. Both timestamps come from Proton's `Date` header, so this is one
    // clock compared with itself and local clock skew cannot affect it.
    //
    // This replaces a fixed 10-second local-clock window, which had to guess a
    // duration and mis-fired whenever the real gap fell outside the guess.
    // Matches Proton Pass (packages/pass/lib/api/refresh.ts).
    if (trigger === 'reactive' && opts.responseDate && account.lastRefreshServerAt &&
        opts.responseDate <= account.lastRefreshServerAt) {
      ProtonDiag.record('refresh.coalesced', {
        email: account.email, trigger, reason: 'stale-401',
        staleByMs: account.lastRefreshServerAt - opts.responseDate,
        newRefreshFp: ProtonDiag.fp(account.refreshToken),
      });
      debugLog('[ProtonAccounts] Refresh coalesced, 401 predates our last refresh by',
        (account.lastRefreshServerAt - opts.responseDate) + 'ms', account.email);
      return;
    }
    // Fallback for when either server timestamp is missing: an account that has
    // not refreshed since this build landed, or a response with no Date header.
    // Reverts to the previous local-clock window rather than leaving the race
    // unguarded, since losing the guard entirely would be a regression for
    // exactly the users it was written for.
    if (trigger === 'reactive' && (!opts.responseDate || !account.lastRefreshServerAt) &&
        account.lastRefreshAt &&
        (Date.now() - account.lastRefreshAt) < _REACTIVE_REFRESH_COALESCE_MS) {
      ProtonDiag.record('refresh.coalesced', {
        email: account.email, trigger, reason: 'recent-refresh-local',
        ageMs: Date.now() - account.lastRefreshAt,
        newRefreshFp: ProtonDiag.fp(account.refreshToken),
      });
      debugLog('[ProtonAccounts] Refresh coalesced (local clock), refreshed',
        (Date.now() - account.lastRefreshAt) + 'ms ago', account.email);
      return;
    }
    const oldFp = ProtonDiag.fp(account.refreshToken);
    const coldStart = _coldStartRefresh;
    _coldStartRefresh = false;
    if (!account.authError) {
      ProtonDiag.record('refresh.start', {
        email: account.email, trigger, refreshFp: oldFp, coldStart,
        ageMs: account.lastRefreshAt ? (Date.now() - account.lastRefreshAt) : null,
      });
    }
    debugLog('[ProtonAccounts] Refreshing tokens for', account.email);
    const result = await ProtonAuth.refreshSession(account.uid, account.refreshToken);
    const tokenChanged = result.refreshToken && result.refreshToken !== account.refreshToken;
    account.accessToken = result.accessToken;
    if (result.refreshToken) account.refreshToken = result.refreshToken;
    account.lastRefreshAt = Date.now();
    // Server clock, for comparing against a later 401's Date header. Left
    // untouched when the header was missing, so a stale value never outranks a
    // real one; the local-clock fallback in the coalesce guard covers that case.
    if (result.serverDate) account.lastRefreshServerAt = result.serverDate;
    ProtonDiag.record('refresh.ok', {
      email: account.email, trigger, rotated: !!tokenChanged,
      oldRefreshFp: oldFp, newRefreshFp: ProtonDiag.fp(account.refreshToken),
    });
    await _save();
    // Await this one so the "persisted" marker has the best chance of landing
    // before any teardown: it confirms the rotated token reached storage.
    await ProtonDiag.record('refresh.saved', {
      email: account.email, refreshFp: ProtonDiag.fp(account.refreshToken),
    });
    debugLog('[ProtonAccounts] Token refresh succeeded for', account.email,
      tokenChanged ? '(rotated)' : '(unchanged)');
  }

  // --- Crypto ---

  // One diagnostic per account per reason per worker generation. Unlock is
  // retried on every poll tick, so an ungated record would fill the 5000-entry
  // ring in a few days and evict the multi-day session history it exists for.
  const _pqcRecorded = new Set();
  const _pqcAttempts = new Map();
  const PQC_RECORD_MAX_ATTEMPTS = 2;

  /**
   * Record that we met a post-quantum account, and, when an unreadable key
   * blocks the unlock, ask Proton whether the user actually opted in.
   *
   * Three reasons reach here. `pqc_ok` is the one that matters most now: we
   * have no post-quantum account to test against, so a user's diagnostics are
   * the only evidence that the vendored fork works against Proton's real key
   * material rather than only against keys we generated ourselves.
   *
   * Parsing the key tells us only whether we can read it. `SupportPgpV6Keys` is
   * Proton's own statement that the user opted in, which is what separates a
   * post-quantum account from a corrupt or merely unfamiliar key. Note our
   * detection fires for any algorithm we do not implement, so `hasPqc` (the RFC
   * 9980 range) is recorded separately from "we could not read it".
   *
   * Awaited, never detached. An unawaited request() would drag the whole
   * 401 to refresh to token-rotate to save chain onto a promise nothing holds,
   * and an MV3 worker can be killed between the rotation and the save, which
   * costs the user their session. The fetch therefore happens only on the
   * blocking path, where the unlock has already failed so the extra round trip
   * costs nothing, and never on the path where unlock is about to succeed.
   */
  async function _recordPqcAccount(account, reason, selection) {
    const dedupKey = account.id + ':' + reason;
    if (_pqcRecorded.has(dedupKey)) return;
    const attempt = (_pqcAttempts.get(dedupKey) || 0) + 1;
    _pqcAttempts.set(dedupKey, attempt);

    const fields = {
      reason,
      email: account.email,
      hasPqc: !!(selection && selection.hasPqc),
      hasUnsupportedPqc: !!(selection && selection.hasUnsupportedPqc),
    };
    let resolved = true;
    if (reason === 'unlock_blocked') {
      try {
        const settings = await request(account.id, 'GET', 'core/v4/settings');
        // Proton nests this one under UserSettings.Flags (unlike
        // AIAssistantFlags, which is top level); tolerate a flat shape too.
        const us = (settings && settings.UserSettings) || settings || {};
        const flags = us.Flags || {};
        fields.supportPgpV6Keys =
          typeof flags.SupportPgpV6Keys === 'number' ? flags.SupportPgpV6Keys : null;
        resolved = fields.supportPgpV6Keys !== null;
      } catch (e) {
        // request() swallows its error here but not its side effects: a 401
        // whose refresh fails will still mark the session re-auth-needed, which
        // is correct in itself, just reached from a diagnostic.
        fields.supportPgpV6Keys = null;
        resolved = false;
      }
    }
    // Seal only once the flag is known, so one transient failure does not
    // permanently null the single fact this record exists to capture. Capped,
    // because unlock retries every poll tick.
    if (resolved || attempt >= PQC_RECORD_MAX_ATTEMPTS) _pqcRecorded.add(dedupKey);
    await ProtonDiag.record('pqc.account', fields);
    debugLog('[ProtonAccounts] Unreadable key (' + reason + ') for', account.email,
      'hasPqc =', fields.hasPqc, 'SupportPgpV6Keys =', fields.supportPgpV6Keys);
  }

  /** Unlock PGP keys for an account using its stored keyPassword. */
  async function unlockKeys(accountId) {
    const account = getAccount(accountId);
    if (!account || !account.keyPassword) {
      throw new Error('No key password available');
    }
    // Coalesce concurrent unlock attempts for the same account (e.g. a cold-start
    // initSlow() racing a popup-triggered poll / body-decrypt now that the popup is
    // served before keys finish unlocking), so we never double-fetch keys/addresses
    // or double-decrypt. keysUnlocking drives the popup's "loading, not broken"
    // state and is cleared when the (shared) attempt settles, success or failure.
    if (account._unlockInFlight) return account._unlockInFlight;
    account.keysUnlocking = true;
    account._unlockInFlight = _doUnlockKeys(account, accountId);
    try {
      return await account._unlockInFlight;
    } catch (err) {
      // Whatever went wrong, the retry must not be served the same cached
      // data: that is what a stale key after a rotation would look like.
      invalidateBootstrap(accountId);
      throw err;
    } finally {
      account._unlockInFlight = null;
      account.keysUnlocking = false;
    }
  }

  // Proton scopes MailSettings.ViewMode per CLIENT app (x-pm-appversion):
  // web, Android and iOS each keep their own conversation-grouping bucket,
  // and a generic client ('Other', which this extension truthfully identifies
  // as) only ever sees the untouched default (0). "Open in Proton Mail" URLs
  // must match what the USER'S WEB CLIENT expects, so read the web bucket
  // through an open mail.proton.me tab: the request runs on the web origin
  // with the web session's own cookies and the web app's own version string
  // (from /assets/version.json), exactly like the page's own requests.
  // Results are matched to accounts by UserID and persisted so they survive
  // background restarts even when no tab is open.
  //
  // The throttle is kept in storage.session as well as in memory: in memory
  // alone it reset on every cold start, so the probe (a script injection, a
  // version.json fetch and a settings request per session) ran on nearly every
  // poll. And it is stamped only once a probe has actually run, so a failed
  // attempt does not block the retry when the tab finishes loading.
  const _VIEW_MODE_RECHECK_MS = 24 * 60 * 60 * 1000;
  const _WEB_VIEW_MODE_PROBE_MS = 10 * 60 * 1000;
  const _WEB_VIEW_MODE_PROBE_KEY = 'protonWebViewModeProbeAt';
  let _webViewModeLastRun = 0;
  async function refreshWebViewModes(force, opts) {
    if (!browser.tabs || !browser.scripting) return;
    // The last completed probe: when it ran, and which accounts it could not
    // resolve (not signed in to the open Proton tab). Such an account stays
    // unknown however often we ask, so it must not skip the throttle on every
    // wake: that ran the probe on nearly every poll for any multi-account user.
    let last = { at: _webViewModeLastRun, notFound: [] };
    try {
      if (browser.storage.session) {
        const stored = await browser.storage.session.get(_WEB_VIEW_MODE_PROBE_KEY);
        const s = stored && stored[_WEB_VIEW_MODE_PROBE_KEY];
        if (s && typeof s === 'object') {
          last = { at: Math.max(last.at, s.at || 0), notFound: s.notFound || [] };
        }
      }
    } catch (_) { /* fall back to the in-memory stamp */ }
    // A Proton tab that just loaded may have signed an account in, so a tab
    // load looks again at accounts the last probe could not resolve.
    const notFound = (opts && opts.afterTabLoad) ? [] : last.notFound;
    const missing = _accounts.some(a => typeof a.webViewMode !== 'number' && !notFound.includes(a.id));
    if (!force && !missing && Date.now() - last.at < _WEB_VIEW_MODE_PROBE_MS) return;
    try {
      const tabs = await browser.tabs.query({ url: '*://mail.proton.me/*' });
      if (!tabs.length) return;
      const results = await browser.scripting.executeScript({
        target: { tabId: tabs[0].id },
        func: async () => {
          let version = null;
          try {
            version = (await (await fetch('/assets/version.json')).json()).version || null;
          } catch (e) { /* fall through */ }
          if (!version) return null; // a failure, not "no sessions here"
          const out = [];
          for (let i = 0; i < localStorage.length; i++) {
            const key = localStorage.key(i);
            if (!key || !key.startsWith('ps-')) continue;
            try {
              const data = JSON.parse(localStorage.getItem(key));
              if (!data || !data.UID || !data.UserID) continue;
              const res = await fetch('/api/mail/v4/settings', {
                headers: {
                  'x-pm-uid': data.UID,
                  'x-pm-appversion': `web-mail@${version}`,
                  'Accept': 'application/vnd.protonmail.v1+json',
                },
                credentials: 'include',
              });
              if (!res.ok) continue;
              const body = await res.json().catch(() => null);
              const vm = body && body.MailSettings && body.MailSettings.ViewMode;
              if (typeof vm === 'number') out.push({ userId: data.UserID, viewMode: vm });
            } catch (e) { /* skip this session */ }
          }
          return out;
        },
      });
      const raw = results && results[0] ? results[0].result : null;
      // null: the probe could not run in the tab. No stamp, no notFound, so a
      // later attempt is not throttled by a failure.
      if (raw === null || raw === undefined) return;
      const list = raw;
      _webViewModeLastRun = Date.now();
      let changed = false;
      for (const entry of list) {
        const account = _accounts.find(a => a.userId === entry.userId);
        if (account && account.webViewMode !== entry.viewMode) {
          account.webViewMode = entry.viewMode;
          changed = true;
          debugLog('[ProtonAccounts] Web ViewMode for', account.email, '=', entry.viewMode,
            '(web client bucket; overrides the generic-client value for URLs/counts)');
        }
      }
      try {
        if (browser.storage.session) {
          const notFound = _accounts.filter(a => typeof a.webViewMode !== 'number').map(a => a.id);
          await browser.storage.session.set({
            [_WEB_VIEW_MODE_PROBE_KEY]: { at: _webViewModeLastRun, notFound },
          });
        }
      } catch (_) { /* the in-memory stamp still throttles this worker */ }
      if (changed) await _save();
    } catch (e) {
      debugLog('[ProtonAccounts] Web ViewMode refresh failed:', e.message);
    }
  }

  /** Effective view mode for matching Proton's WEB UI: prefer the web
   *  client's own bucket when detected, else the generic-client value. */
  function _effectiveViewMode(account) {
    if (!account) return null;
    return typeof account.webViewMode === 'number' ? account.webViewMode : account.viewMode;
  }

  /**
   * Apply what an event page says about this account's own settings and data.
   * MailSettings in an event is our ('Other') bucket, the one viewMode holds.
   * User or Addresses means keys or addresses may have changed, so the session
   * copy used for unlocking is dropped and the key set re-read on next use.
   */
  async function noteAccountEvents(accountId, eventData) {
    const account = getAccount(accountId);
    if (!account || !eventData) return false;
    const ms = eventData.MailSettings;
    if (ms && typeof ms.ViewMode === 'number' && ms.ViewMode !== account.viewMode) {
      account.viewMode = ms.ViewMode;
      account.viewModeCheckedAt = Date.now();
      debugLog('[ProtonAccounts] ViewMode for', account.email, 'changed to', ms.ViewMode, '(event)');
      try { await _save(); } catch (_) { /* rechecked daily anyway */ }
    }
    if (eventData.User || eventData.Addresses || eventData.Refresh) {
      invalidateKeys(accountId);
      // The caller re-reads the keys before decrypting what this poll found.
      return true;
    }
    return false;
  }

  /**
   * Free or paid, from the User object we already hold.
   *
   * `Subscribed` is a product bitmask, not a boolean: MAIL=1, DRIVE=2, VPN=4,
   * PASS=8, WALLET=16, NEUTRON=32, LUMO=64, MEET=256 (WebClients PRODUCT_BIT).
   * So a Drive-only subscriber is "paid" while `paidMail` is false, which is
   * worth telling apart when the question is about MAIL sessions.
   *
   * The trap is `Role`. WebClients' isPaid() is a plain `!!Subscribed`, but a
   * business MEMBER has Subscribed = 0 while the ORGANISATION pays, so that
   * test alone labels a paying customer "free". USER_ROLES: 0 free, 1 member,
   * 2 admin. `tier` collapses the two into the answer we actually want.
   *
   * Nothing here costs a request: core/v4/users is already fetched for the keys.
   */
  function _planFromUser(user) {
    if (!user || typeof user !== 'object') return null;
    const subscribed = typeof user.Subscribed === 'number' ? user.Subscribed : null;
    const role = typeof user.Role === 'number' ? user.Role : null;
    let tier = 'unknown';
    if (subscribed !== null) {
      if (subscribed > 0) tier = 'paid';
      else if (role === 1) tier = 'org-member'; // the organisation pays, not them
      else if (role !== null) tier = 'free';
    } else if (role === 1) {
      tier = 'org-member';
    }
    return {
      tier,
      subscribed,
      // Bit 0 is Mail. A Drive-only or VPN-only plan is paid but not paid MAIL.
      paidMail: subscribed === null ? null : (subscribed & 1) === 1,
      role,
      // A lapsed payer can behave like a free account without looking like one.
      delinquent: typeof user.Delinquent === 'number' ? user.Delinquent : null,
    };
  }

  /**
   * Log the plan when it is first seen, and again only if it CHANGES.
   *
   * Was deduped per worker generation, which is no dedup at all: MV3
   * cold-starts constantly, and a real 5000-entry log came back with 360
   * account.plan records, 7% of the buffer, crowding out the auth history it
   * exists to hold. ProtonDiag.once keeps the signature in storage instead.
   */
  async function _recordPlan(account, user) {
    if (!account) return;
    const plan = _planFromUser(user);
    if (!plan) return;
    const sig = [plan.tier, plan.subscribed, plan.paidMail, plan.role, plan.delinquent].join('/');
    if (!(await ProtonDiag.once('plan:' + account.id, sig))) return;
    ProtonDiag.record('account.plan', {
      email: account.email,
      tier: plan.tier,
      subscribed: plan.subscribed,
      paidMail: plan.paidMail,
      role: plan.role,
      delinquent: plan.delinquent,
    });
    debugLog('[ProtonAccounts] Plan for', account.email, '=', plan.tier,
      '(Subscribed=' + plan.subscribed + ', Role=' + plan.role + ')');
  }

  async function _doUnlockKeys(account, accountId) {
    debugLog('[ProtonAccounts] Unlocking keys for', account.email);

    // From the session copy when it is fresh, else from the API (and cache it).
    let userResult, addrResult, fetchedAt;
    const cached = await _readBootstrap(account);
    if (cached) {
      userResult = cached.userResult;
      addrResult = cached.addrResult;
      fetchedAt = cached.at;
    } else {
      [userResult, addrResult] = await Promise.all([
        request(accountId, 'GET', 'core/v4/users'),
        request(accountId, 'GET', 'core/v4/addresses'),
      ]);
      fetchedAt = Date.now();
      await _writeBootstrap(account, userResult, addrResult, fetchedAt);
    }

    // Free vs paid, for the session-expiry investigation: the reports we have
    // are all free accounts and the accounts that never expire are all paid,
    // and a log that does not say which is which cannot settle that.
    try {
      // Awaited: _recordPlan is async now (it reads the stored signature), and
      // a sync try/catch cannot catch a rejected promise. Two small storage
      // operations, on a path that has just made two network requests.
      await _recordPlan(account, userResult && userResult.User);
    } catch (e) { /* a diagnostic must never break the unlock */ }

    // Cache the account's ViewMode (0 = conversation grouping, 1 = single
    // messages. VIEW_MODE in WebClients mailSettings.ts) so unread counts
    // can match what Proton's own UI shows. Persisted, so this request runs
    // at most once a day instead of on every cold start; the event stream
    // updates it in between (noteMailSettings). Best-effort: on failure a
    // known value is kept, and an unknown one stays null (message counts).
    const vmAge = Date.now() - (account.viewModeCheckedAt || 0);
    if (typeof account.viewMode !== 'number' || !(vmAge < _VIEW_MODE_RECHECK_MS)) {
      try {
        const msResult = await request(accountId, 'GET', 'mail/v4/settings');
        const vm = msResult.MailSettings && msResult.MailSettings.ViewMode;
        if (typeof vm === 'number') {
          account.viewMode = vm;
          account.viewModeCheckedAt = Date.now();
          try { await _save(); } catch (_) { /* refetched next cold start */ }
        } else if (typeof account.viewMode !== 'number') {
          account.viewMode = null;
        }
        debugLog('[ProtonAccounts] ViewMode for', account.email, '=', account.viewMode,
          '(0 = conversation grouping, 1 = single messages)');
      } catch (e) {
        if (typeof account.viewMode !== 'number') account.viewMode = null;
        debugLog('[ProtonAccounts] MailSettings fetch failed:', e.message);
      }
    }

    const user = userResult.User;
    const addresses = addrResult.Addresses || [];

    if (!user || !user.Keys || user.Keys.length === 0) {
      throw new Error('No user keys found');
    }

    // Decrypt primary user key. On a post-quantum account there are two
    // primary user keys and only the v4 one is readable here, so pick by
    // parseability rather than trusting the API's ordering.
    const userSelection = ProtonPqc.selectUsableKey(user.Keys);
    if (userSelection.allUnsupported) {
      // Awaited: the unlock is failing regardless, so the round trip is free,
      // and awaiting keeps any token refresh it triggers on a held promise.
      await _recordPqcAccount(account, 'unlock_blocked', userSelection);
      const e = new Error('Account uses post-quantum keys this version cannot read');
      e.code = 'PQC_UNSUPPORTED';
      throw e;
    }
    if (userSelection.skippedUnsupported) {
      debugLog('[ProtonAccounts] Unreadable user key present; unlocking with',
        userSelection.key.ID, '(mail encrypted to that key alone will not open)');
      // No network call here: this unlock is about to succeed and must not gain
      // a new failure mode for a diagnostic. The await is only on the diag
      // queue, which cannot reject, though it can wait behind queued appends.
      await _recordPqcAccount(account, 'user_key_skipped', userSelection);
    } else if (userSelection.hasPqc) {
      // A post-quantum account unlocking with nothing skipped. We cannot
      // reproduce this locally, so record it: it is the first evidence that the
      // vendored fork reads Proton's own post-quantum keys, not merely the ones
      // our tests generate. Same no-network rule as above.
      debugLog('[ProtonAccounts] Post-quantum account unlocking with all keys readable');
      await _recordPqcAccount(account, 'pqc_ok', userSelection);
    }
    const primaryKey = userSelection.key;
    const keyObj = await openpgp.readPrivateKey({ armoredKey: primaryKey.PrivateKey });
    const userPrivateKey = await openpgp.decryptKey({
      privateKey: keyObj, passphrase: account.keyPassword,
    });

    // Unlock every OTHER user key we can, for the address-key Tokens below.
    // They are wrapped to one user key each, not necessarily the selected one.
    // Failures are expected and ignored: an unsupported (post-quantum) key, or
    // one under a different passphrase, simply does not join the set.
    const userPrivateKeys = [userPrivateKey];
    for (const k of (user.Keys || [])) {
      if (k === primaryKey || k.ID === primaryKey.ID) continue;
      if (ProtonPqc.isUnsupportedKey(k.PrivateKey)) continue;
      try {
        userPrivateKeys.push(await openpgp.decryptKey({
          privateKey: await openpgp.readPrivateKey({ armoredKey: k.PrivateKey }),
          // THIS key's passphrase. Every user key has its own salt, so the
          // selected key's passphrase does not open the others; it just fails
          // to decrypt, silently. Falls back to the single passphrase for
          // accounts stored before the map existed, which is the old
          // behaviour and no worse.
          passphrase: _passphraseFor(account, k.ID),
        }));
      } catch (e) { /* not ours to unlock; the selected key may still cover it */ }
    }
    if (userPrivateKeys.length > 1) {
      debugLog('[ProtonAccounts] Unlocked', userPrivateKeys.length, 'user key(s) for address tokens');
    }

    // Decrypt address keys and map them to their email addresses
    const decryptedKeys = [];
    const addressKeyMap = {}; // email (lowercase) -> decrypted private key
    // email -> {primary, version} of the key currently in addressKeyMap, so a
    // later key can be compared against it without re-parsing.
    const addressKeyChoice = {};
    for (const address of addresses) {
      if (!address.Keys) continue;
      for (const addrKey of address.Keys) {
        try {
          let passphrase;
          if (addrKey.Token) {
            const tokenMsg = await openpgp.readMessage({ armoredMessage: addrKey.Token });
            // Verify the Token's detached signature with the user key when
            // present (newer key format), like WebClients' decryptAddressKeyToken.
            // Rejects a malicious/compromised server swapping in a Token that
            // decrypts to a different passphrase (key substitution). Legacy keys
            // have no Signature; those decrypt unverified, same as upstream.
            // Every user key we could unlock, not just the selected one. Proton
            // encrypts and signs each address-key Token under ONE user key, and
            // it need not be the one selectUsableKey picked. With a single key
            // here, an account with more than one user key (a post-quantum
            // account has two primary ones, and any rotation leaves more) threw
            // on the mismatched Tokens and silently dropped those address keys,
            // so mail encrypted to them would not open.
            const decryptOpts = {
              message: tokenMsg, decryptionKeys: userPrivateKeys,
            };
            if (addrKey.Signature) {
              decryptOpts.signature = await openpgp.readSignature({
                armoredSignature: addrKey.Signature,
              });
              decryptOpts.verificationKeys = userPrivateKeys.map(k => k.toPublic());
              decryptOpts.expectSigned = true; // throw on missing/invalid signature
            }
            const { data: decryptedToken } = await openpgp.decrypt(decryptOpts);
            passphrase = decryptedToken;
          } else {
            passphrase = account.keyPassword;
          }
          const privKey = await openpgp.readPrivateKey({ armoredKey: addrKey.PrivateKey });
          const decryptedKey = await openpgp.decryptKey({ privateKey: privKey, passphrase });
          // Every key goes into decryptedKeys, including rotated-out ones:
          // old mail is encrypted to them and OpenPGP routes by PKESK.
          decryptedKeys.push(decryptedKey);
          // addressKeyMap is a different question. It picks the ONE key used to
          // sign and encrypt outgoing mail for this address, so it must be the
          // address's primary, not merely the first that happened to decrypt.
          // Those coincide only while Proton returns the primary first and it
          // decrypts; an address can carry several active keys after a rotation,
          // and on a post-quantum account it carries a v4 and a v6 at once.
          //
          // The key VERSION matters here too, and only since we vendored the
          // post-quantum bundle: a v6 key now decrypts, so it can now be chosen
          // to sign, and v6 signatures break parsing for some third-party
          // OpenPGP libraries. Prefer the v4. Rule lives in ProtonPqc so it can
          // be tested; see preferAddressKeyForSigning for the full reasoning.
          //
          // The version comes from the library rather than our own header
          // parser: it has already parsed this key, so there is no reason to
          // prefer a second opinion.
          const addrEmail = address.Email.toLowerCase();
          const candidate = {
            primary: addrKey.Primary === 1,
            version: decryptedKey.keyPacket.version,
          };
          if (ProtonPqc.preferAddressKeyForSigning(addressKeyChoice[addrEmail] || null, candidate)) {
            addressKeyMap[addrEmail] = decryptedKey;
            addressKeyChoice[addrEmail] = candidate;
          }
        } catch (err) {
          console.warn('[ProtonAccounts] Failed to decrypt address key:', err.message);
        }
      }
    }

    account.decryptedKeys = decryptedKeys;
    account.addressKeyMap = addressKeyMap;
    account.keysUnlocked = decryptedKeys.length > 0;
    // Start the freshness clock ONLY here, where keys were genuinely re-read.
    // Stamping it anywhere the fetch could have failed would pin a known-stale
    // set for the whole window, which is worse than not caching. Dated to when
    // the data was FETCHED, so a set built from the session copy does not get
    // a fresh 30 minutes on top of the copy's age.
    account.keysUnlockedAt = account.keysUnlocked ? fetchedAt : 0;

    // Update email from addresses if we only had a username
    if ((!account.email || account.email === account.username) && addresses.length > 0) {
      account.email = addresses[0].Email;
      await _save();
    }

    debugLog('[ProtonAccounts] Unlocked', decryptedKeys.length, 'key(s) for', account.email);
  }

  /** Decrypt a PGP message body for a specific account. */
  async function decryptBody(accountId, armoredBody) {
    const account = getAccount(accountId);
    if (!account || !account.keysUnlocked || account.decryptedKeys.length === 0) {
      throw new Error('Keys not unlocked');
    }

    const message = await openpgp.readMessage({ armoredMessage: armoredBody });
    const { data } = await openpgp.decrypt({
      message, decryptionKeys: account.decryptedKeys, format: 'utf8',
    });
    return data;
  }

  /** Fetch raw attachment data (binary) for a specific account.
   *  Binary response, so it can't go through request(); replicates the same
   *  single refresh-and-retry on 401 (token may have expired while the
   *  popup was open). */
  async function getAttachment(accountId, attachmentId) {
    const account = getAccount(accountId);
    if (!account) throw new Error('Account not found');

    const fetchOnce = () => {
      const headers = ProtonConfig.buildHeaders(account.uid, account.accessToken);
      delete headers['Content-Type']; // binary download, no Content-Type needed
      return fetch(`${BASE_URL}/mail/v4/attachments/${attachmentId}`, {
        method: 'GET',
        headers,
        credentials: 'omit',
      });
    };

    let resp = await fetchOnce();
    if (resp.status === 401) {
      await _refreshTokens(account);
      resp = await fetchOnce();
    }
    if (!resp.ok) throw new Error(`Attachment fetch failed: HTTP ${resp.status}`);
    return resp.arrayBuffer();
  }

  /**
   * Fetch the sender logo for an email address via Proton's image proxy
   * (core/v4/images/logo). Proton resolves BIMI (+VMC) and falls back to the
   * domain favicon SERVER-SIDE, so the logo reaches us without the client ever
   * doing a DNS lookup or pinging the sender's server. Returns a data: URL, or
   * null when Proton has no logo (caller falls back to the initials avatar).
   */
  async function getSenderLogo(accountId, email, size, mode) {
    const account = getAccount(accountId);
    if (!account) throw new Error('Account not found');
    const params = new URLSearchParams({
      Address: String(email || '').toLowerCase(),
      Size: String(size || 32),
    });
    if (mode === 'light' || mode === 'dark') params.set('Mode', mode);
    const url = `${BASE_URL}/core/v4/images/logo?${params.toString()}`;
    const fetchOnce = () => {
      const headers = ProtonConfig.buildHeaders(account.uid, account.accessToken);
      delete headers['Content-Type']; // binary download
      return fetch(url, { method: 'GET', headers, credentials: 'omit' });
    };
    let resp = await fetchOnce();
    if (resp.status === 401) {
      await _refreshTokens(account);
      resp = await fetchOnce();
    }
    if (!resp.ok) return null; // 422/404 → no logo available
    const buf = await resp.arrayBuffer();
    if (!buf || buf.byteLength === 0) return null;
    const contentType = (resp.headers.get('content-type') || 'image/png').split(';')[0];
    return `data:${contentType};base64,${ProtonBinary.uint8ToBase64(new Uint8Array(buf))}`;
  }

  // A JSON error answer is a few hundred bytes. Anything past this is not
  // read into memory: streamRequest's caller limits only the success stream.
  const STREAM_ERROR_BODY_MAX_BYTES = 16 * 1024;

  /**
   * The parsed JSON error body of a failed streamRequest, or null when it is
   * empty, not JSON, or longer than STREAM_ERROR_BODY_MAX_BYTES (the rest of
   * the body is then cancelled unread). An abort while reading is thrown on
   * as it is, so the caller sees the abort rather than an ordinary HTTP error.
   */
  async function _readStreamErrorBody(resp) {
    const nullUnlessAbort = (e) => {
      if (e && e.name === 'AbortError') throw e;
      return null;
    };
    if (!resp.body || typeof resp.body.getReader !== 'function') {
      // No body stream to read in pieces (a test double, for example).
      return typeof resp.json === 'function' ? resp.json().catch(nullUnlessAbort) : null;
    }
    const reader = resp.body.getReader();
    const pieces = [];
    let size = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value || !value.byteLength) continue;
        size += value.byteLength;
        if (size > STREAM_ERROR_BODY_MAX_BYTES) {
          Promise.resolve().then(() => reader.cancel()).catch(() => {});
          return null;
        }
        pieces.push(value);
      }
    } catch (e) {
      return nullUnlessAbort(e);
    }
    const bytes = new Uint8Array(size);
    let at = 0;
    for (const piece of pieces) {
      bytes.set(piece, at);
      at += piece.byteLength;
    }
    try {
      return JSON.parse(new TextDecoder().decode(bytes));
    } catch (_) {
      return null;
    }
  }

  /**
   * Streaming authenticated request (for SSE endpoints like ai/v1/chat/completions).
   *
   * request()/_rawRequest() buffer the whole body via resp.json(), so they
   * can't stream. This reads resp.body incrementally and invokes
   * opts.onText(textChunk) per decoded chunk. Replicates the single 401
   * refresh-and-retry of getAttachment(); on a non-ok response it throws an
   * error carrying status/code/retryAfterSec, matching _rawRequest's shape so
   * callers can detect rate-limits and app-version rejections. It also
   * carries the parsed JSON error body as `body`, because the AI endpoint
   * can answer in OpenAI's { error: { code, type, message } } form, which
   * has no Proton Code to copy. The error body is read with a size cap (see
   * _readStreamErrorBody), and an abort while reading it stays an abort.
   */
  async function streamRequest(accountId, method, path, { data, signal, onText } = {}) {
    const account = getAccount(accountId);
    if (!account) throw new Error('Account not found');

    const fetchOnce = () => {
      const headers = ProtonConfig.buildHeaders(account.uid, account.accessToken);
      return fetch(`${BASE_URL}/${path}`, {
        method,
        headers,
        credentials: 'omit',
        body: data ? JSON.stringify(data) : undefined,
        signal,
      });
    };

    let resp = await fetchOnce();
    if (resp.status === 401) {
      await _refreshTokens(account);
      resp = await fetchOnce();
    }
    if (!resp.ok) {
      const parsed = await _readStreamErrorBody(resp);
      const body = parsed && typeof parsed === 'object' ? parsed : {};
      const err = new Error(body.Error || `HTTP ${resp.status}`);
      err.status = resp.status;
      err.code = body.Code;
      if (parsed && typeof parsed === 'object') err.body = parsed;
      if (resp.status === 429 || resp.status === 503) {
        const retryAfter = parseInt(resp.headers.get('retry-after') || '', 10);
        if (retryAfter > 0) err.retryAfterSec = retryAfter;
      }
      throw err;
    }
    if (!resp.body || typeof resp.body.getReader !== 'function') {
      // No streaming body available: hand the whole text to the callback once.
      if (onText) await onText(await resp.text());
      return;
    }
    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (onText && value) await onText(decoder.decode(value, { stream: true }));
    }
    if (onText) { const tail = decoder.decode(); if (tail) await onText(tail); }
  }

  // Sender public keys cache for attachment signature verification,
  // keyed by `${accountId}:${email}`. In-memory only; cleared with the SW.
  // Bounded because the key space is every sender the user ever reads: a
  // Firefox event page can live for days, and each entry holds parsed OpenPGP
  // key objects rather than a small string. Oldest-inserted is evicted first
  // (Map preserves insertion order); a re-fetch is one cheap request.
  const _senderKeyCache = new Map();
  const SENDER_KEY_CACHE_MAX = 500;

  /** Fetch a sender's public keys (internal Proton senders only: external
   *  senders have no keys at this endpoint). Best-effort: returns []. */
  async function _getSenderPublicKeys(accountId, email) {
    const cacheKey = `${accountId}:${email.toLowerCase()}`;
    if (_senderKeyCache.has(cacheKey)) return _senderKeyCache.get(cacheKey);
    let keys = [];
    let looked = false;
    try {
      const keyResult = await request(accountId, 'GET', 'core/v4/keys', {
        params: { Email: email },
      });
      // One unreadable key must not lose the sender's other keys: a
      // post-quantum sender publishes a v6 key alongside their v4 one, and
      // Promise.all would reject the whole batch over it.
      const settled = await Promise.allSettled((keyResult.Keys || [])
        .filter(k => k.PublicKey)
        .map(k => openpgp.readKey({ armoredKey: k.PublicKey })));
      keys = settled.filter(r => r.status === 'fulfilled').map(r => r.value);
      const dropped = settled.length - keys.length;
      if (dropped > 0) {
        debugLog('[ProtonAccounts] Ignored', dropped, 'unreadable public key(s) for',
          email, '(likely post-quantum); kept', keys.length);
      }
      looked = true;
    } catch (e) {
      debugLog('[ProtonAccounts] Sender key lookup failed for', email, ':', e.message);
    }
    // Cache only a lookup that actually completed. Caching a thrown request
    // would pin an empty key set for the life of the worker (days on a Firefox
    // event page), silently disabling attachment signature verification for
    // that sender after one transient network error. An empty result from a
    // request that SUCCEEDED is a genuine external sender and stays cached:
    // that is the common case and re-querying it every time would be wasteful.
    if (!looked) return keys;
    if (_senderKeyCache.size >= SENDER_KEY_CACHE_MAX) {
      // Evict the oldest insertion. Map iteration order is insertion order, so
      // the first key is the least recently ADDED (not the least recently used,
      // which would need a re-insert on every hit for no real benefit here).
      _senderKeyCache.delete(_senderKeyCache.keys().next().value);
    }
    _senderKeyCache.set(cacheKey, keys);
    return keys;
  }

  async function decryptAttachment(accountId, encryptedData, keyPackets, opts = {}) {
    const account = getAccount(accountId);
    if (!account || !account.keysUnlocked || account.decryptedKeys.length === 0) {
      throw new Error('Keys not unlocked');
    }

    const keyPacketBytes = typeof keyPackets === 'string'
      ? ProtonBinary.base64ToUint8(keyPackets)
      : new Uint8Array(keyPackets);
    const dataBytes = new Uint8Array(encryptedData);

    // Combine key packets + encrypted data into a single PGP message
    const combined = new Uint8Array(keyPacketBytes.length + dataBytes.length);
    combined.set(keyPacketBytes, 0);
    combined.set(dataBytes, keyPacketBytes.length);

    const message = await openpgp.readMessage({ binaryMessage: combined });
    const { data } = await openpgp.decrypt({
      message,
      decryptionKeys: account.decryptedKeys,
      format: 'binary',
    });

    // Best-effort detached-signature verification, like the web client's
    // attachmentLoader. Only possible for internal Proton senders (we can
    // fetch their public keys); failure warns but never blocks the download.
    // The user still gets their file, we just lose the integrity assurance.
    if (opts.armoredSignature && opts.senderAddress) {
      try {
        const senderKeys = await _getSenderPublicKeys(accountId, opts.senderAddress);
        if (senderKeys.length > 0) {
          const signature = await openpgp.readSignature({
            armoredSignature: opts.armoredSignature,
          });
          const verifyResult = await openpgp.verify({
            message: await openpgp.createMessage({ binary: data }),
            signature,
            verificationKeys: senderKeys,
            format: 'binary',
          });
          await verifyResult.signatures[0].verified;
          debugLog('[ProtonAccounts] Attachment signature verified for', opts.senderAddress);
        }
      } catch (e) {
        console.warn('[ProtonAccounts] Attachment signature verification FAILED for',
          opts.senderAddress, ':', e.message);
      }
    }

    return data;
  }

  // --- Convenience API methods ---

  async function getMessageCounts(accountId) {
    const result = await request(accountId, 'GET', 'mail/v4/messages/count');
    return result.Counts || [];
  }

  async function getConversationCounts(accountId) {
    const result = await request(accountId, 'GET', 'mail/v4/conversations/count');
    return result.Counts || [];
  }

  /** Unread counts matching the account's ViewMode: conversation counts when
   *  the account groups by conversation (ViewMode 0, Proton's default), else
   *  per-message counts, so the badge agrees with Proton's own UI. */
  async function getCountsForViewMode(accountId) {
    const account = getAccount(accountId);
    if (account && _effectiveViewMode(account) === 0) {
      return getConversationCounts(accountId);
    }
    return getMessageCounts(accountId);
  }

  async function getInboxUnreadCount(accountId) {
    const counts = await getCountsForViewMode(accountId);
    const inbox = counts.find(c => c.LabelID === ProtonLabels.INBOX);
    return inbox ? inbox.Unread : 0;
  }

  /**
   * Whether the per-account Pro settings apply: the notification switch, a
   * folder mode other than Inbox, and label, initials and color. Without
   * Premium they stay stored as the trial (or a lapsed subscription) left
   * them and come back with Premium, but the account behaves and shows as if
   * they were at their defaults, like every other Pro setting.
   */
  function _proSettingsApply() {
    return typeof ProtonPremium === 'undefined' || ProtonPremium.isPremium();
  }

  /** The folder mode in effect: the stored one with Premium, else Inbox.
   *  (The notification switch follows the same rule in notifier.js and
   *  poller.js _announce.) */
  function _folderMode(account, premium = _proSettingsApply()) {
    return (premium && account && account.folderMode) || 'inbox';
  }

  /** Get unread count respecting per-account folder monitoring settings. */
  async function getMonitoredUnreadCount(accountId) {
    const account = getAccount(accountId);
    const mode = _folderMode(account);

    if (mode === 'inbox') {
      return getInboxUnreadCount(accountId);
    }

    if (mode === 'all') {
      const counts = await getCountsForViewMode(accountId);
      const allMail = counts.find(c => c.LabelID === ProtonLabels.ALL_MAIL);
      return allMail ? allMail.Unread : 0;
    }

    // Custom: sum unread for selected folders + labels
    const ids = _monitoredQueryIds(account);
    const counts = await getCountsForViewMode(accountId);
    let total = 0;
    for (const id of ids) {
      const c = counts.find(cnt => cnt.LabelID === id);
      if (c) total += c.Unread;
    }
    // A deleted folder adds nothing to the total, but its ID still widens the
    // list query to the whole account (see lib/monitored-ids.js). The counts
    // list every folder and label that exists, so this is a free place to
    // notice one has gone.
    const missing = ProtonMonitoredIds.missingFromCounts(ids, counts);
    if (missing.length) await _pruneStaleMonitoredIds(account, missing);
    return total;
  }

  /** The label IDs a monitored list is built from, in query order. */
  function _monitoredQueryIds(account) {
    const mode = _folderMode(account);
    if (mode === 'inbox') return [ProtonLabels.INBOX];
    if (mode === 'all') return [ProtonLabels.ALL_MAIL];
    // Nothing ticked has always meant Inbox. Everything ticked since deleted
    // in Proton means nothing: the user never picked Inbox.
    if (ProtonMonitoredIds.selected(account).length === 0) return [ProtonLabels.INBOX];
    return ProtonMonitoredIds.live(account);
  }

  /** Get messages respecting per-account folder monitoring settings. */
  async function getMonitoredMessages(accountId, limit = 20, opts = {}) {
    const account = getAccount(accountId);
    const ids = _monitoredQueryIds(account);
    await _recordMonitorConfig(account);

    // One query per ID, each trimmed to the messages that really carry that
    // ID. Proton answers a deleted folder's ID with the whole mailbox, so
    // without the trim one stale selection lists every unread message,
    // spam included.
    //
    // The queries go out together, but only a few at a time: monitoring four
    // folders used to cost four serial round trips on every refresh, while a
    // user monitoring a dozen folders AND labels would otherwise fire a dozen
    // simultaneous list requests per poll. The old serial loop was
    // self-throttling; Proton rate-limits with 429/503 and Retry-After, so
    // keep the burst polite. Only the fetch is concurrent: the replies are
    // still processed in ID order, never completion order, because the
    // leak/read diagnostics below are ordered and once()-gated and the
    // de-duplication is "first ID wins". Each worker therefore writes its
    // reply into the slot for its ID, not onto the end of a list.
    const MAX_PARALLEL_LISTS = 4;
    const replies = new Array(ids.length);
    let nextIdx = 0;
    // One failure stops the others. The serial loop this replaced could not
    // send a second request after an error; without this flag a 429 on the
    // first folder would still have the remaining workers fire every other
    // query at a server that just asked us to stop, which is the opposite of
    // what the cap above is for.
    let fetchFailed = false;
    const fetchWorker = async () => {
      while (nextIdx < ids.length && !fetchFailed) {
        const i = nextIdx++;
        try {
          replies[i] = await getMessages(accountId, ids[i], limit, opts);
        } catch (e) {
          fetchFailed = true;
          throw e;
        }
      }
    };
    const workers = [];
    for (let w = 0; w < Math.min(MAX_PARALLEL_LISTS, ids.length); w++) workers.push(fetchWorker());
    await Promise.all(workers);
    const allMsgs = [];
    const seen = new Set();
    const leaked = [];
    for (let i = 0; i < ids.length; i++) {
      const id = ids[i];
      const msgs = replies[i];
      const { kept, dropped } = ProtonMonitoredIds.carrying(msgs, id);
      if (dropped) {
        leaked.push(id);
        await _recordLeak(account, id, dropped, msgs.length);
      }
      // An unread-only query should hold no read message, but a customer's
      // did (Proton's side, unexplained). Drop only an explicit Unread 0, so a
      // missing or changed field can never empty the list, and say so once.
      // After the trim above, so the leak count still sees the raw reply.
      let rows = kept;
      if (opts && opts.unreadOnly) {
        const read = kept.filter(m => m && m.Unread === 0);
        if (read.length) {
          rows = kept.filter(m => !(m && m.Unread === 0));
          await _recordReadInUnread(account, id, read);
        }
      }
      for (const m of rows) {
        if (!seen.has(m.ID)) {
          seen.add(m.ID);
          allMsgs.push(m);
        }
      }
    }
    if (leaked.length) await _pruneStaleMonitoredIds(account, leaked);
    if (ids.length > 1) allMsgs.sort((a, b) => (b.Time || 0) - (a.Time || 0));
    // One ID too: the cap is the user's setting, so it holds whatever size
    // of reply comes back (a single ID used to be returned untrimmed, and
    // Proton ignored the size we asked for, see getMessages).
    return allMsgs.slice(0, limit);
  }

  // IDs confirmed to still exist during this worker's lifetime, per account,
  // so a suspicion that turned out wrong is not re-checked on every poll.
  const _monitoredIdsConfirmed = new Map();

  // Deleted IDs remembered per account. Proton never reuses one, so the list
  // only needs a cap against unbounded growth, not an expiry.
  const _STALE_MONITOR_IDS_MAX = 200;

  /**
   * Stop monitoring IDs that Proton no longer knows. `suspects` come from a
   * cheap signal (missing from the counts, or a list reply that ignored its
   * filter); nothing is acted on until the folder and label lists confirm the
   * ID is in neither. A failed lookup changes nothing: losing a user's real
   * selection would be worse than one more trimmed poll.
   *
   * A confirmed ID goes on the account's local staleMonitorIds, which every
   * query skips and every sync import strips. Nothing is written to
   * storage.sync from here: pushing this device's whole settings map
   * unprompted could overwrite an edit just made on another device, and the
   * local list is what keeps a stale synced copy from bringing the ID back.
   */
  async function _pruneStaleMonitoredIds(account, suspects) {
    if (!account) return;
    const confirmed = _monitoredIdsConfirmed.get(account.id) || new Set();
    const known = new Set(account.staleMonitorIds || []);
    const toCheck = [...new Set(suspects || [])].filter(id =>
      !ProtonMonitoredIds.isSystemId(id) && !confirmed.has(id) && !known.has(id));
    if (!toCheck.length) return;

    let folders, labels;
    try {
      [folders, labels] = await Promise.all([getFolders(account.id), getLabels(account.id)]);
    } catch (e) {
      debugLog('[ProtonAccounts] Could not check monitored folders for', account.email + ':', e.message);
      return;
    }
    if (!folders || !Array.isArray(folders.Labels) || !labels || !Array.isArray(labels.Labels)) return;

    const stale = ProtonMonitoredIds.stale(toCheck, folders.Labels, labels.Labels);
    for (const id of toCheck) {
      if (!stale.includes(id)) confirmed.add(id);
    }
    _monitoredIdsConfirmed.set(account.id, confirmed);
    if (!stale.length) return;

    account.staleMonitorIds = [...known, ...stale].slice(-_STALE_MONITOR_IDS_MAX);
    Object.assign(account, ProtonMonitoredIds.withoutStale(account, account.staleMonitorIds));
    try {
      await _save();
    } catch (e) {
      // Tidying the settings must never fail a poll. Memory is already
      // right; if the save is lost, the next worker finds the ID again.
      debugLog('[ProtonAccounts] Could not save monitored folders for', account.email + ':', e.message);
    }
    // Once per ID: a restart that finds the same ID again must not fill the
    // ring buffer with the same line.
    const fresh = [];
    for (const id of stale) {
      if (await ProtonDiag.once('pruned:' + account.id + ':' + id, 'done')) fresh.push(id);
    }
    const removed = stale.map(ProtonMonitoredIds.shortId).join(',');
    if (fresh.length) {
      ProtonDiag.record('monitor.pruned', {
        email: account.email,
        removed: fresh.map(ProtonMonitoredIds.shortId).join(','),
        now: ProtonMonitoredIds.describe(account),
      });
    }
    debugLog('[ProtonAccounts] Stopped monitoring deleted folder/label', removed, 'for', account.email);
  }

  /** Record what an account monitors, whenever that changes. */
  async function _recordMonitorConfig(account) {
    if (!account) return;
    let desc = ProtonMonitoredIds.describe(account);
    // Stored but out of effect without Premium: the log names what is
    // actually queried, and what comes back with Premium.
    if (_folderMode(account) !== (account.folderMode || 'inbox')) {
      desc = 'mode=inbox (no Premium; stored ' + desc + ')';
    }
    if (!(await ProtonDiag.once('monitor:' + account.id, desc))) return;
    ProtonDiag.record('monitor.config', { email: account.email, monitor: desc });
  }

  /** Record read messages in an unread-only reply, once per ID. */
  async function _recordReadInUnread(account, id, read) {
    if (!account) return;
    if (!(await ProtonDiag.once('readrow:' + account.id + ':' + id, 'seen'))) return;
    const labels = [...new Set(read.flatMap(m => m.LabelIDs || []))].map(ProtonMonitoredIds.shortId);
    ProtonDiag.record('list.readInUnread', {
      email: account.email,
      id: ProtonMonitoredIds.shortId(id),
      count: read.length,
      labels: labels.join(','),
    });
  }

  /** Record a list reply that ignored its filter, once per ID. */
  async function _recordLeak(account, id, dropped, returned) {
    if (!account) return;
    if (!(await ProtonDiag.once('leak:' + account.id + ':' + id, 'seen'))) return;
    ProtonDiag.record('monitor.leak', {
      email: account.email,
      id: ProtonMonitoredIds.shortId(id),
      dropped,
      returned,
    });
  }

  /** Mirror per-account settings to storage.sync when the user has sync on
   *  (a Pro feature, so with Premium only). */
  async function pushAccountSettingsToSync() {
    try {
      const { syncEnabled } = await browser.storage.local.get('syncEnabled');
      if (!syncEnabled || !_proSettingsApply()) return;
      await browser.storage.sync.set({ accountSettings: getAccountSettingsExport() });
      await browser.storage.local.set({ lastSyncTime: new Date().toISOString() });
    } catch (e) { /* sync storage may not be available */ }
  }

  /** Get the label IDs this account monitors (for event filtering). */
  function getMonitoredLabelIds(accountId) {
    const account = getAccount(accountId);
    const mode = _folderMode(account);
    if (mode === 'all') return null; // null = match any
    return _monitoredQueryIds(account);
  }

  /**
   * Check the monitored IDs against a counts snapshot the caller already has
   * (the event stream carries a full one). Costs nothing unless an ID is
   * missing from it.
   */
  async function checkMonitoredAgainstCounts(accountId, counts) {
    const account = getAccount(accountId);
    if (!account || _folderMode(account) !== 'custom') return;
    const missing = ProtonMonitoredIds.missingFromCounts(_monitoredQueryIds(account), counts);
    if (missing.length) await _pruneStaleMonitoredIds(account, missing);
  }

  async function getMessages(accountId, labelId = ProtonLabels.INBOX, limit = 20, { unreadOnly = false } = {}) {
    // Page and PageSize size the reply. Limit alone is ignored: measured,
    // Limit 1, 2, 5 and 10 each returned all 6 unread messages, so "messages
    // per account" capped nothing. Proton's web client sends all three, with
    // Limit equal to PageSize (WebClients elementQuery.ts), and so do we.
    const size = String(limit);
    const params = { LabelID: labelId, Page: '0', PageSize: size, Limit: size, Sort: 'Time', Desc: '1' };
    if (unreadOnly) params.Unread = '1';
    const result = await request(accountId, 'GET', 'mail/v4/messages', { params });
    return result.Messages || [];
  }

  async function getMessage(accountId, messageId) {
    const result = await request(accountId, 'GET', `mail/v4/messages/${messageId}`);
    return result.Message || null;
  }

  async function getLatestEventId(accountId) {
    const result = await request(accountId, 'GET', 'core/v4/events/latest');
    return result.EventID;
  }

  async function getEvents(accountId, eventId) {
    return request(accountId, 'GET', `core/v5/events/${eventId}`, {
      params: { ConversationCounts: '1', MessageCounts: '1' },
    });
  }

  async function markAsRead(accountId, messageIds) {
    const res = await request(accountId, 'PUT', 'mail/v4/messages/read', {
      data: { IDs: messageIds },
    });
    // Read messages leave the unread-only monitored view. Treat as a removal.
    ProtonTombstones.recordRemoval(getAccount(accountId), messageIds);
    return res;
  }

  async function archiveMessages(accountId, messageIds) {
    await request(accountId, 'PUT', 'mail/v4/messages/label',
      { data: { LabelID: ProtonLabels.ARCHIVE, IDs: messageIds } });
    ProtonTombstones.recordRemoval(getAccount(accountId), messageIds);
  }

  async function trashMessages(accountId, messageIds) {
    await request(accountId, 'PUT', 'mail/v4/messages/label',
      { data: { LabelID: ProtonLabels.TRASH, IDs: messageIds } });
    ProtonTombstones.recordRemoval(getAccount(accountId), messageIds);
  }

  /** Permanently delete messages: bypasses Trash. Irreversible. */
  async function deleteMessagesPermanently(accountId, messageIds) {
    await request(accountId, 'PUT', 'mail/v4/messages/delete',
      { data: { IDs: messageIds } });
    ProtonTombstones.recordRemoval(getAccount(accountId), messageIds);
  }

  async function markAsUnread(accountId, messageIds) {
    const res = await request(accountId, 'PUT', 'mail/v4/messages/unread', {
      data: { IDs: messageIds },
    });
    // Undo of mark-read: drop the tombstone so the message can return next poll.
    ProtonTombstones.clear(getAccount(accountId), messageIds);
    return res;
  }

  async function unarchiveMessages(accountId, messageIds) {
    await request(accountId, 'PUT', 'mail/v4/messages/label',
      { data: { LabelID: ProtonLabels.INBOX, IDs: messageIds } });
    await request(accountId, 'PUT', 'mail/v4/messages/unlabel',
      { data: { LabelID: ProtonLabels.ARCHIVE, IDs: messageIds } });
    ProtonTombstones.clear(getAccount(accountId), messageIds);
  }

  async function untrashMessages(accountId, messageIds) {
    await request(accountId, 'PUT', 'mail/v4/messages/label',
      { data: { LabelID: ProtonLabels.INBOX, IDs: messageIds } });
    await request(accountId, 'PUT', 'mail/v4/messages/unlabel',
      { data: { LabelID: ProtonLabels.TRASH, IDs: messageIds } });
    ProtonTombstones.clear(getAccount(accountId), messageIds);
  }

  async function snoozeConversations(accountId, conversationIds, snoozeUntilTime) {
    const res = await request(accountId, 'PUT', 'mail/v4/conversations/snooze', {
      data: { IDs: conversationIds, SnoozeTime: snoozeUntilTime },
    });
    ProtonTombstones.recordSnooze(getAccount(accountId), conversationIds);
    return res;
  }

  async function starMessages(accountId, messageIds) {
    return request(accountId, 'PUT', 'mail/v4/messages/label', {
      data: { LabelID: ProtonLabels.STARRED, IDs: messageIds },
    });
  }

  async function unstarMessages(accountId, messageIds) {
    return request(accountId, 'PUT', 'mail/v4/messages/unlabel', {
      data: { LabelID: ProtonLabels.STARRED, IDs: messageIds },
    });
  }

  async function labelMessages(accountId, messageIds, labelId) {
    return request(accountId, 'PUT', 'mail/v4/messages/label', {
      data: { LabelID: labelId, IDs: messageIds },
    });
  }

  async function unlabelMessages(accountId, messageIds, labelId) {
    return request(accountId, 'PUT', 'mail/v4/messages/unlabel', {
      data: { LabelID: labelId, IDs: messageIds },
    });
  }

  async function getAddresses(accountId) {
    const result = await request(accountId, 'GET', 'core/v4/addresses');
    return (result.Addresses || [])
      .filter(a => a.Status !== 0 && a.Send !== 0)
      .map(a => ({ ID: a.ID, Email: a.Email, DisplayName: a.DisplayName || '', Order: a.Order }));
  }

  /** Look up the API-level Address ID for an email on this account.
   *  Used by addToCalendar to populate the event's AddressID so the
   *  server can match the signing key to the address. */
  async function _findAddressIdForEmail(accountId, email) {
    if (!email) return null;
    const result = await request(accountId, 'GET', 'core/v4/addresses');
    const addr = (result.Addresses || []).find(
      a => a.Email && a.Email.toLowerCase() === email.toLowerCase()
    );
    return addr ? addr.ID : null;
  }

  async function getLabels(accountId) {
    return request(accountId, 'GET', 'core/v4/labels', {
      params: { Type: '1' },
    });
  }

  async function getFolders(accountId) {
    return request(accountId, 'GET', 'core/v4/labels', {
      params: { Type: '3' },
    });
  }

  async function moveToFolder(accountId, messageIds, folderLabelId) {
    // Apply the target folder label: Proton automatically removes from
    // the current system folder (Inbox, etc.) when labeling with another
    await request(accountId, 'PUT', 'mail/v4/messages/label', {
      data: { LabelID: folderLabelId, IDs: messageIds },
    });
    // Leaves the monitored inbox view. Treat as a removal. (Edge: moving INTO
    // a custom-monitored folder will hide it for up to the tombstone TTL, then
    // it reappears; acceptable for that rare case.)
    ProtonTombstones.recordRemoval(getAccount(accountId), messageIds);
  }

  async function reportPhishing(accountId, messageId) {
    // Move to spam first
    await moveToFolder(accountId, [messageId], ProtonLabels.SPAM);
    // Report phishing via Proton API
    try {
      await request(accountId, 'POST', `mail/v4/messages/${messageId}/mark/phishing`, {
        data: { MessageID: messageId },
      });
    } catch (err) {
      console.warn('[ProtonAccounts] Phishing report API call failed:', err.message);
      // Still consider it successful since we moved to spam
    }
  }

  // --- Send / Reply ---
  //
  // All send flows (reply, forward, compose) follow the same pattern:
  //   1. Resolve sender address (including +alias detection and key lookup)
  //   2. Encrypt the message body with the sender's public key (self-encryption for draft)
  //   3. Create an encrypted draft via POST /mail/v4/messages
  //   4. Build per-recipient send packages (_buildSendPackages):
  //      - Generate a random AES-256 session key
  //      - Encrypt the body with the session key
  //      - For internal (Proton) recipients: encrypt session key with their public key (Type 1)
  //      - For external recipients: send session key in the clear (Type 4 / ClearScheme)
  //   5. Send via POST /mail/v4/messages/{draftId}

  /**
   * Escape text for embedding in an outgoing HTML email body, turning newlines
   * into <br> so manual line breaks survive.
   *
   * NOT the same as popup.js `_escapeHtmlText`, which is a display-only escaper
   * that leaves newlines as literal whitespace. The two look similar but serve
   * opposite contexts (HTML email generation here vs. safe label rendering
   * there), so they are deliberately kept separate rather than merged.
   */
  function _escapeHtml(text) {
    return text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/\n/g, '<br>');
  }

  /**
   * Detect if the original message was sent to a + alias of one of our addresses.
   * Returns { Email, DisplayName } with the + alias, or null if none found.
   */
  function _detectPlusAlias(originalMsg, addresses) {
    const recipients = [...(originalMsg.ToList || []), ...(originalMsg.CCList || [])];
    for (const r of recipients) {
      const addr = r.Address.toLowerCase();
      if (!addr.includes('+')) continue;
      const [localWithPlus, domain] = addr.split('@');
      const basePart = localWithPlus.split('+')[0];
      // Check if base matches one of our addresses
      for (const myAddr of addresses) {
        const [myLocal, myDomain] = myAddr.Email.toLowerCase().split('@');
        if (myLocal === basePart && myDomain === domain) {
          // Return the + alias address with base address ID and display name
          return { Email: r.Address, DisplayName: myAddr.DisplayName || '', ID: myAddr.ID };
        }
      }
    }
    return null;
  }

  /**
   * Resolve the sender address, matching private key, and public key for sending.
   * Handles explicit sender, +alias detection from the original message, and key lookup.
   *
   * @param {string} accountId
   * @param {object} account - Full account object with decryptedKeys and addressKeyMap
   * @param {string} [senderAddress] - Explicit sender email (if user chose one)
   * @param {object} [originalMsg] - Original message (for +alias detection in replies/forwards)
   * @returns {{ fromAddr: object, senderPrivKey, senderPubKey, addresses: Array }}
   */
  async function _resolveSenderInfo(accountId, account, senderAddress, originalMsg) {
    const addrResult = await request(accountId, 'GET', 'core/v4/addresses');
    const addresses = addrResult.Addresses || [];
    const defaultAddr = addresses[0];
    if (!defaultAddr) throw new Error('No sender address found');

    // Resolve which address to send from
    let fromAddr;
    if (senderAddress) {
      let match = addresses.find(a => a.Email.toLowerCase() === senderAddress.toLowerCase());
      if (!match && senderAddress.includes('+')) {
        const [localWithPlus, domain] = senderAddress.toLowerCase().split('@');
        const baseEmail = localWithPlus.split('+')[0] + '@' + domain;
        const baseAddr = addresses.find(a => a.Email.toLowerCase() === baseEmail);
        // Send AS the +alias: keep the alias as the From/Sender address, but sign
        // with (and use the AddressID of) the underlying base address. This is
        // what Proton's web client does: the recipient then sees the +alias in
        // the From header and envelope, not the bare base address.
        if (baseAddr) match = { ...baseAddr, Email: senderAddress };
      }
      fromAddr = match || { Email: senderAddress, DisplayName: defaultAddr.DisplayName || '', ID: defaultAddr.ID };
    } else if (originalMsg) {
      fromAddr = _detectPlusAlias(originalMsg, addresses) || defaultAddr;
    } else {
      fromAddr = defaultAddr;
    }

    // Resolve sender's private key (handles +alias → base address lookup)
    const senderEmail = (fromAddr.Email || fromAddr).toLowerCase();
    let senderPrivKey = account.addressKeyMap && account.addressKeyMap[senderEmail];
    let keySource = senderPrivKey ? 'addressMap' : '';
    if (!senderPrivKey && senderEmail.includes('+')) {
      const [localWithPlus, domain] = senderEmail.split('@');
      const baseEmail = localWithPlus.split('+')[0] + '@' + domain;
      senderPrivKey = account.addressKeyMap && account.addressKeyMap[baseEmail];
      if (senderPrivKey) keySource = 'aliasBase';
    }
    if (!senderPrivKey) {
      // Last resort. The body is signed with this key and internal packages
      // declare Signature: 1, so Proton verifies it against the keys published
      // for the SENDING ADDRESS. A key belonging to another address is rejected
      // with "Invalid or missing message signature", which is why the fallback
      // is recorded rather than taken silently.
      senderPrivKey = account.decryptedKeys[0];
      keySource = 'fallbackFirstKey';
    }
    // Diagnostics only: read by _recordSendDiag, which cannot see this function's
    // decision any other way. A send is a single sequential flow per account.
    // Which KEY signed, and what the address actually publishes. Proton
    // verifies the body signature only for CLEAR packages, because only then
    // can it read the body, which is why a wrong signing key is invisible on
    // internal mail and fatal on external mail (apiCode 2001). Key IDs and the
    // Primary/Active flags are public metadata, not secrets.
    let keyId = '';
    try { keyId = senderPrivKey.getKeyID().toHex(); } catch (_) { /* best effort */ }
    let addrKeys = '';
    // Does the key we are about to SIGN with actually belong to the address we
    // are sending AS? Proton verifies that for clear packages and rejects with
    // apiCode 2001 when it does not. Until now the log printed Proton's key IDs
    // next to an OpenPGP key ID, two different identifier spaces, so the two
    // could disagree while looking like they agreed. Compare fingerprints.
    let keyMatchesAddr = '?';
    try {
      const a = addresses.find(x => (x.Email || '').toLowerCase() === senderEmail);
      const keys = (a && a.Keys) || [];
      addrKeys = keys
        .map(k => (k.ID || '?').slice(0, 8) + (k.Primary === 1 ? '*' : '') + (k.Active === 1 ? '' : '!'))
        .join(',');
      const signingFp = senderPrivKey.getFingerprint();
      keyMatchesAddr = 'no';
      for (const k of keys) {
        try {
          const pub = await openpgp.readKey({ armoredKey: k.PublicKey });
          if (pub.getFingerprint() === signingFp) {
            keyMatchesAddr = (k.Primary === 1) ? 'primary' : 'nonPrimary';
            break;
          }
        } catch (_) { /* unreadable (post-quantum) keys cannot match anyway */ }
      }
    } catch (_) { /* best effort */ }

    _lastSenderResolution[accountId] = {
      keyId: keyId.slice(0, 16),
      addrKeys,
      keyMatchesAddr,
      from: fromAddr.Email || String(fromAddr),
      keySrc: keySource,
      addrs: addresses.length,
      addrIdx: addresses.findIndex(a => a.ID === fromAddr.ID),
      mapped: account.addressKeyMap ? Object.keys(account.addressKeyMap).length : 0,
    };

    return {
      fromAddr,
      senderPrivKey,
      senderPubKey: senderPrivKey.toPublic(),
      addresses,
      defaultAddr,
    };
  }

  /**
   * Encrypt body, create draft, build send packages, and send.
   *
   * @param {string} accountId
   * @param {object} account
   * @param {object} draftPayload - The Message + optional ParentID/Action for POST /messages
   * @param {Array} allRecipients - Combined to/cc/bcc list for send packages
   * @param {string} htmlBody - Plaintext HTML for send package encryption
   * @param {object} senderPrivKey - Sender's PGP private key
   * @param {object} senderPubKey - Sender's PGP public key
   * @param {Array} [attachments] - Optional attachments to upload
   * @returns {string} Draft message ID
   */
  // Send-option limits (mirror Proton): schedule 2 min .. 90 days out; expiry <= 730 days.
  // How many extra attempts a send gets when Proton answers apiCode 2001.
  // See the retry loop in _encryptAndSend for why only that code qualifies.
  const SEND_RETRY_SIGNATURE_MAX = 3;

  const _SCHED_MIN_S = 120;
  const _SCHED_MAX_S = 90 * 24 * 3600;
  const _EXPIRE_MIN_S = 30 * 60;          // 30 min: Proton rejects sooner expirations
  const _EXPIRE_MAX_S = 28 * 24 * 3600;   // 28 days: Proton's MAX_EXPIRATION_TIME (672h)

  /** Validate + premium-guard the optional send options (schedule / expiry / EO).
   *  Throws a coded Error on violation; no-op when none are set. Belt-and-suspenders
   *  behind the popup's requirePremium() gate. */
  function _guardSendOptions(sendOptions) {
    const o = sendOptions || {};
    if (!o.deliveryTime && !o.expiresIn && !o.eoPassword) return;
    if (typeof ProtonPremium !== 'undefined' && !ProtonPremium.isPremium()) {
      throw new Error('PREMIUM_REQUIRED');
    }
    if (o.eoPassword && o.eoPassword.length < 8) { // Proton MIN_PASSWORD_LENGTH (Encrypted Outside)
      throw new Error('EO_PASSWORD_TOO_SHORT');
    }
    if (o.deliveryTime != null) {
      const now = Math.floor(Date.now() / 1000);
      if (!Number.isFinite(o.deliveryTime) ||
          o.deliveryTime < now + _SCHED_MIN_S || o.deliveryTime > now + _SCHED_MAX_S) {
        throw new Error('DELIVERY_TIME_INVALID');
      }
    }
    if (o.expiresIn != null) {
      if (!Number.isFinite(o.expiresIn) || o.expiresIn < _EXPIRE_MIN_S || o.expiresIn > _EXPIRE_MAX_S) {
        throw new Error('EXPIRY_INVALID');
      }
    }
  }

  /** Privacy-safe send diagnostic: records WHAT KIND of send this was (scheduled /
   *  expiring / Encrypted-Outside) plus the per-package-type recipient counts, so a
   *  released-build issue can be traced from the user's diagnostic log. NEVER records
   *  the EO password, recipient addresses, subject, or body. Always-on (ProtonDiag),
   *  so it's available even without verbose debug logging. */
  function _recordSendDiag(event, account, sendOptions, packages, attachments, err, step, retries) {
    try {
      const o = sendOptions || {};
      const nowSec = Math.floor(Date.now() / 1000);
      const r = (account && _lastSenderResolution[account.id]) || {};
      const b = _lastBodyEncrypt || {};
      const fields = {
        email: account && account.email,
        // Which address we sent AS, and where its signing key came from. The
        // account email above is not the same thing on a multi-address account.
        from: r.from,
        keySrc: r.keySrc,
        keyId: r.keyId,
        addrKeys: r.addrKeys,
        keyMatchesAddr: r.keyMatchesAddr,
        encMs: b.encMs,
        bodyLen: b.bodyLen,
        cipherLen: b.cipherLen,
        addrIdx: r.addrIdx,
        addrs: r.addrs,
        mapped: r.mapped,
        step,
        ...(retries ? { retries } : {}),
        scheduled: o.deliveryTime ? Math.round((o.deliveryTime - nowSec) / 60) + 'min' : 'no',
        expiry: o.expiresIn ? Math.round(o.expiresIn / 60) + 'min' : 'no',
        eo: !!o.eoPassword,
        att: (attachments || []).length,
      };
      // Package breakdown e.g. "1:2,2:1" = 2 internal + 1 Encrypted-Outside recipient.
      if (packages) fields.pkgs = packages.map(p => p.Type + ':' + Object.keys(p.Addresses || {}).length).join(',');
      if (err) {
        fields.error = err.message;
        // The message alone is not enough to act on. Proton's numeric Code
        // identifies the rejection exactly, where the prose is shared by
        // several causes; "Invalid or missing message signature" cost most of
        // an afternoon precisely because the code was thrown away. Details is
        // Proton's own structured hint. None of these carry message content.
        if (err.status !== undefined) fields.httpStatus = err.status;
        if (err.code !== undefined) fields.apiCode = err.code;
        if (err.details !== undefined) {
          try { fields.apiDetails = JSON.stringify(err.details).slice(0, 200); } catch (_) { /* ignore */ }
        }
      }
      ProtonDiag.record(event, fields);
    } catch (_) { /* diagnostics must never break send */ }
  }

  // Set by _resolveSenderInfo, read by _recordSendDiag. Diagnostics only: it
  // exists because the sender/key decision happens in a different function from
  // the one that records the outcome, and a failure is unreadable without it.
  //
  // Keyed by account: the background router dispatches SEND_NEW_MESSAGE,
  // SEND_REPLY, FORWARD_MESSAGE and the RSVP handlers concurrently, so with a
  // single slot a second account's send could overwrite the first account's
  // resolution while it was still uploading, and the failure would then be
  // logged against the wrong From address and key source. Wrong evidence is
  // worse than none in a diagnostic log.
  const _lastSenderResolution = {};

  // Set by _buildSendPackages, read by _recordSendDiag: how long the body
  // encrypt+sign took, and how big it came out. Diagnostics only.
  let _lastBodyEncrypt = null;

  /** Strip the angle brackets a Content-ID header carries, and nothing else.
   *  This is the value that goes back on the wire, so it must survive intact. */
  function _rawCid(raw) {
    return String(raw || '').trim().replace(/^<|>$/g, '').trim();
  }

  /** Match key for a Content-ID: case and percent-escapes folded away so a body
   *  reference and a header agree. NEVER upload this. A Content-ID is an RFC
   *  5322 msg-id whose local part is case-SENSITIVE, so a lowercased one stops
   *  resolving in the clients this feature exists for: Outlook emits uppercase
   *  hex like image001.png@01DA1234.5678ABCD. */
  function _bareCid(raw) {
    let s = _rawCid(raw);
    try { s = decodeURIComponent(s); } catch (_) { /* leave as-is */ }
    return s.toLowerCase();
  }

  /** Bare Content-IDs referenced by <img src="cid:..."> in `html`.
   *  Regex, not DOM: a Chrome MV3 service worker has no DOMParser.
   *
   *  The tag is matched by consuming attribute values as quoted strings rather
   *  than skipping them with [^>]*, because a literal '>' inside an earlier
   *  attribute is legal HTML (<img alt="1 > 2" src="cid:x">) and used to end
   *  the scan before src was reached. The reference was dropped, the part never
   *  re-attached, and the recipient got a broken image while the sender, whose
   *  client resolves it against the quoted original, saw the picture. */
  function _cidRefsIn(html) {
    const out = new Set();
    const tagRe = /<img\b((?:[^>"']|"[^"]*"|'[^']*')*)>/gi;
    // Walk NAME=VALUE pairs rather than searching the tag for "src=": an
    // attribute VALUE can contain that text (<img alt="src=cid:evil@x"
    // src="cid:real@y">) and a plain search picked the decoy.
    const attrRe = /([a-zA-Z_:][-\w:.]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]*)))?/g;
    let tag;
    while ((tag = tagRe.exec(html || '')) !== null) {
      attrRe.lastIndex = 0;
      let a;
      while ((a = attrRe.exec(tag[1])) !== null) {
        if (a.index === attrRe.lastIndex) { attrRe.lastIndex++; continue; } // zero-width
        if ((a[1] || '').toLowerCase() !== 'src') continue;
        const src = (a[2] !== undefined ? a[2] : a[3] !== undefined ? a[3] : a[4] || '').trim();
        if (/^cid:/i.test(src)) out.add(_bareCid(src.slice(4)));
        break; // first src wins, as the parser would take it
      }
    }
    return out;
  }

  /**
   * Re-attach the embedded images that a quoted original still references.
   *
   * Replying to or forwarding a message with an inline image carried its
   * <img src="cid:..."> into the new body, but the part it names belongs to the
   * PARENT message. The recipient has no way to resolve it, so the picture
   * arrived broken while looking perfect to the sender, whose own client
   * resolves the cid against the message being quoted.
   *
   * Only what the outgoing body actually references is re-uploaded, so trimming
   * the quote trims the attachments with it. One failure is skipped rather than
   * failing the send: a reply that goes with one broken image beats a reply
   * that cannot be sent, which is what the recipient would have got anyway.
   */
  async function _reattachQuotedImages(accountId, htmlBody, parentMessage, attachments) {
    const refs = _cidRefsIn(htmlBody);
    if (refs.size === 0) return attachments;
    const out = (attachments || []).slice();
    const seen = new Set(out.map(a => _bareCid(a.cid)).filter(Boolean));
    for (const att of (parentMessage && parentMessage.Attachments) || []) {
      const headers = att.Headers || {};
      const rawHeader = headers['content-id'] || headers['Content-ID'] || '';
      const cid = _bareCid(rawHeader);
      if (!cid || !refs.has(cid) || seen.has(cid)) continue;
      try {
        const encrypted = await getAttachment(accountId, att.ID);
        const bytes = await decryptAttachment(accountId, encrypted, att.KeyPackets);
        out.push({
          name: att.Name || 'image',
          type: att.MIMEType || 'application/octet-stream',
          data: ProtonBinary.uint8ToBase64(new Uint8Array(bytes)),
          // The RAW header value, so the ContentID uploaded is byte-identical
          // to the cid: the outgoing body still carries.
          cid: _rawCid(rawHeader),
        });
        seen.add(cid);
      } catch (e) {
        console.warn('[ProtonAccounts] Could not re-attach quoted image', cid, ':', e.message);
      }
    }
    return out;
  }

  async function _encryptAndSend(accountId, account, draftPayload, allRecipients, htmlBody, senderPrivKey, senderPubKey, attachments, sendOptions) {
    sendOptions = sendOptions || {};
    _guardSendOptions(sendOptions);
    // Encrypt body for draft storage (encrypted to sender)
    const draftMsg = await openpgp.createMessage({ text: htmlBody });
    const encryptedDraft = await openpgp.encrypt({
      message: draftMsg,
      encryptionKeys: [senderPubKey],
      signingKeys: [senderPrivKey],
    });

    // Set encrypted body in draft payload
    draftPayload.Message.Body = encryptedDraft;

    // Create draft
    const draftResult = await request(accountId, 'POST', 'mail/v4/messages', { data: draftPayload });
    const draft = draftResult.Message;
    if (!draft || !draft.ID) throw new Error('Failed to create draft');

    // Which API call we are on, so a failure says WHERE. "Invalid or missing
    // message signature" means something quite different from the attachment
    // upload than from the send itself, and the error text alone cannot say.
    let step = 'attachments';
    let packages = null;
    try {
      // Upload attachments and collect their IDs + session keys for re-encryption
      const uploadedAttachments = []; // { id, sessionKeyData, algorithm }
      if (attachments && attachments.length > 0) {
        for (const att of attachments) {
          const result = await _uploadAttachment(accountId, account, draft.ID, att, senderPubKey, senderPrivKey);
          uploadedAttachments.push(result);
        }
      }

      // Build send packages (includes per-recipient attachment key re-encryption)
      step = 'packages';
      packages = await _buildSendPackages(
        accountId, account, allRecipients, htmlBody, senderPrivKey, uploadedAttachments, sendOptions);
      const sendData = { AutoSaveContacts: 0, Packages: packages };
      if (sendOptions.deliveryTime) sendData.DeliveryTime = sendOptions.deliveryTime; // Unix seconds
      if (sendOptions.expiresIn) sendData.ExpiresIn = sendOptions.expiresIn;           // seconds from now
      step = 'send';
      // Proton intermittently rejects a send with apiCode 2001, "Invalid or
      // missing message signature", and then accepts a byte-identical payload
      // seconds later. Measured 2026-08-07: a failure and the success right
      // after it had the same body length (7), the same ciphertext length (263,
      // far too large to be unsigned) and the same signing key, and the web
      // client succeeded throughout. Clicking Send again has always worked.
      //
      // Scoped to code 2001 ALONE, on purpose. 2001 comes with HTTP 400, so the
      // message was rejected at validation and never processed, and a retry
      // cannot deliver it twice. Retrying on a generic failure could: a lost
      // response to a send that actually succeeded is indistinguishable here,
      // which is the same reason the draft cleanup skips this step.
      //
      // The packages are rebuilt each attempt with a fresh session key and body,
      // because that is what pressing Send again does and what is observed to
      // succeed.
      let sendAttempt = 0;
      for (;;) {
        try {
          await request(accountId, 'POST', 'mail/v4/messages/' + draft.ID, { data: sendData });
          break;
        } catch (sendErr) {
          if (sendErr.code !== 2001) throw sendErr;
          if (sendAttempt >= SEND_RETRY_SIGNATURE_MAX) {
            // Do NOT surface Proton's own text here. It reads "Invalid or
            // missing message signature, please sign out and back in again",
            // and that advice is wrong: the session is healthy (right key,
            // right address, no auth events), so signing out fixes nothing and
            // costs the user a re-login and possibly a 2FA round. Give the
            // caller a code it can turn into something true instead. The
            // server's wording is still in the log, on the api.fail line.
            const e = new Error('SEND_TEMPORARILY_REJECTED');
            e.code = sendErr.code;
            e.status = sendErr.status;
            throw e;
          }
          sendAttempt++;
          try {
            ProtonDiag.record('send.retry', {
              email: account && account.email, attempt: sendAttempt, apiCode: sendErr.code,
            });
          } catch (_) { /* diagnostics must never break send */ }
          // 2s, 4s, 6s. Each attempt behaves like an independent coin toss
          // rather than something that clears with time: one send failed three
          // times across 12 seconds, while another was rescued by a retry 4
          // seconds later ON THE SAME DRAFT. That also rules out needing a
          // fresh draft, and confirms the payload was fine all along. So the
          // lever is MORE attempts, not longer waits, bounded by how long a
          // user will sit watching "Sending...".
          await new Promise(r => setTimeout(r, 2000 * sendAttempt));
          packages = await _buildSendPackages(
            accountId, account, allRecipients, htmlBody, senderPrivKey, uploadedAttachments, sendOptions);
          sendData.Packages = packages;
        }
      }
      _recordSendDiag('send', account, sendOptions, packages, attachments, null, step,
        sendAttempt);
    } catch (err) {
      // Pass the packages built so far: on a send-step failure their types are
      // exactly what the server rejected.
      _recordSendDiag('send.fail', account, sendOptions, packages, attachments, err, step);
      // Clean up the draft, but NEVER after the send call itself. Proton
      // converts a draft in place: the same MessageID moves from Drafts to
      // Sent. A lost response (504, dropped connection, a 503 emitted after the
      // backend committed) is indistinguishable here from a real failure, and
      // PUT mail/v4/messages/delete is the PERMANENT delete, the same route as
      // "delete permanently" from Trash. Deleting on a send-step error can
      // therefore destroy a message the recipient has already received, leaving
      // the user no copy and no evidence. An orphan draft is the cheaper
      // mistake, so the send step keeps it.
      if (step !== 'send') {
        try {
          await request(accountId, 'PUT', 'mail/v4/messages/delete', {
            data: { IDs: [draft.ID] },
          });
          debugLog('[ProtonAccounts] Cleaned up draft', draft.ID, 'after', step, 'failure');
        } catch (cleanupErr) {
          console.warn('[ProtonAccounts] Failed to clean up draft:', cleanupErr.message);
        }
      } else {
        debugLog('[ProtonAccounts] Keeping draft', draft.ID,
          '(send may have completed server-side despite the error)');
      }
      throw err;
    }

    return draft.ID;
  }

  /**
   * Flag the parent of a reply/forward we just sent, in the held message list.
   *
   * Proton sets IsReplied/IsRepliedAll/IsForwarded on the parent server-side,
   * but our poller only refetches the list when the unread count changes, and
   * a reply need not change it (with autoMarkReadOnReply off the parent stays
   * unread). Without this the arrow would wait for some unrelated refresh.
   * The next full fetch overwrites the flag with the value the server already
   * holds, so we are only anticipating the server, never inventing state.
   *
   * The parent may not be held at all (outside the fetched window, or gone):
   * then there is nothing to update and nothing to persist.
   */
  /** A scheduled send has not been delivered yet, so do not claim the parent
   *  has been answered. Proton decides for itself whether the flag belongs on
   *  the parent at schedule time or at delivery; the next list refetch tells us
   *  either way, and waiting a poll is better than asserting something the user
   *  can see is untrue. */
  function _sendWasImmediate(sendOptions) {
    return !(sendOptions && sendOptions.deliveryTime);
  }

  async function _flagParentAfterSend(account, parentMessageId, flag) {
    const parent = ((account && account.messages) || [])
      .find(m => m && m.ID === parentMessageId);
    if (!parent) return;
    parent[flag] = 1;
    // MV3 tears the worker down moments after a send, so the flag has to reach
    // the session snapshot (saveSnapshot also mirrors the encrypted disk cache)
    // or it is forgotten before the popup next reads the list.
    try { await saveSnapshot(); } catch (_) { /* cache-only: never fail a sent message */ }
  }

  /**
   * Send a reply (or reply-all) to a message.
   *
   * Flow: resolve sender → build recipients → encrypt → create draft → send.
   * For reply-all, includes original To/CC excluding own addresses and +alias variants.
   * Action codes: 0=reply, 1=reply-all.
   */
  async function sendReply(accountId, parentMessageId, replyText, isHtml, replyAll, senderAddress, attachments, extraCc, extraBcc, toRecipients, sendOptions) {
    // Keys may still be unlocking if the user acts within the first moment after a
    // cold start; wait for the (coalesced) unlock rather than hard-failing.
    await ensureKeysUnlocked(accountId);
    const account = getAccount(accountId);
    if (!account || !account.keysUnlocked || account.decryptedKeys.length === 0) {
      throw new Error('Keys not unlocked, cannot send');
    }

    const original = await getMessage(accountId, parentMessageId);
    if (!original) throw new Error('Original message not found');

    const { fromAddr, senderPrivKey, senderPubKey, addresses, defaultAddr } =
      await _resolveSenderInfo(accountId, account, senderAddress, original);

    const _norm = (arr) => (arr || [])
      .map(r => ({ Address: (r.address || r.Address || '').trim(), Name: r.name || r.Name || '' }))
      .filter(r => r.Address);

    // Recipients. The popup now shows editable To/CC/BCC for reply & reply-all
    // (pre-filled by where each address sat in the original), so it sends the
    // exact lists the user sees/edited. Fall back to deriving them from the
    // original message when no explicit To is supplied (legacy/safety).
    let toList, ccList, bccList;
    const explicitTo = _norm(toRecipients);
    if (explicitTo.length > 0) {
      toList = explicitTo;
      ccList = _norm(extraCc);
      bccList = _norm(extraBcc);
    } else {
      const replyTo = original.ReplyTo || original.Sender;
      toList = [{ Address: replyTo.Address, Name: replyTo.Name || '' }];
      ccList = [];
      if (replyAll) {
        const myAddresses = new Set(addresses.map(a => a.Email.toLowerCase()));
        const allOrigTo = [...(original.ToList || []), ...(original.CCList || [])];
        ccList = allOrigTo.filter(r => {
          const addr = r.Address.toLowerCase();
          if (addr === replyTo.Address.toLowerCase()) return false;
          for (const myAddr of myAddresses) {
            const [localPart, domain] = myAddr.split('@');
            if (addr === myAddr) return false;
            if (domain && addr.endsWith('@' + domain) && addr.split('@')[0].split('+')[0] === localPart) return false;
          }
          return true;
        });
      }
      const _seen = new Set([...toList, ...ccList].map(r => r.Address.toLowerCase()));
      for (const r of _norm(extraCc)) {
        if (!_seen.has(r.Address.toLowerCase())) { ccList.push(r); _seen.add(r.Address.toLowerCase()); }
      }
      bccList = [];
      for (const r of _norm(extraBcc)) {
        if (!_seen.has(r.Address.toLowerCase())) { bccList.push(r); _seen.add(r.Address.toLowerCase()); }
      }
    }

    const subject = (original.Subject || '').startsWith('Re:')
      ? original.Subject
      : 'Re: ' + (original.Subject || '');

    // The reply editor now contains BOTH the user's text and the quoted
    // original (pre-filled in the popup so it can be edited inline), so we send
    // the body as-is, no quoting here (that would double it). Plain-text mode:
    // preserve line breaks as <br> since the message is sent as text/html.
    const htmlBody = isHtml ? replyText : '<div>' + _escapeHtml(replyText).replace(/\n/g, '<br>') + '</div>';
    const allRecipients = [...toList, ...ccList, ...bccList];
    // The quote may still point at the ORIGINAL message's embedded images.
    attachments = await _reattachQuotedImages(accountId, htmlBody, original, attachments);

    await _encryptAndSend(accountId, account, {
      Message: {
        ToList: toList,
        CCList: ccList,
        BCCList: bccList,
        Subject: subject,
        MIMEType: 'text/html',
        AddressID: fromAddr.ID || defaultAddr.ID,
        Sender: {
          Address: fromAddr.Email || fromAddr,
          Name: (fromAddr.DisplayName || defaultAddr.DisplayName) || '',
        },
      },
      ParentID: parentMessageId,
      Action: replyAll ? 1 : 0, // Reply=0, ReplyAll=1
    }, allRecipients, htmlBody, senderPrivKey, senderPubKey, attachments, sendOptions);

    debugLog('[ProtonAccounts] Reply sent for', account.email);
    // Only now, after the send actually succeeded: a failed send leaves the
    // parent untouched. Reply-all and reply are mutually exclusive here, the
    // same way Action was picked above.
    if (_sendWasImmediate(sendOptions)) {
      await _flagParentAfterSend(account, parentMessageId, replyAll ? 'IsRepliedAll' : 'IsReplied');
    }
    return { success: true };
  }

  /**
   * Forward a message to a single recipient.
   *
   * Flow: resolve sender → decrypt original body → prepend forward header →
   *       encrypt → create draft → send. Action code: 2=forward.
   */
  async function forwardMessage(accountId, parentMessageId, forwardTo, fwdText, isHtml, senderAddress, attachments, extraCc, extraBcc, sendOptions) {
    // Wait for a still-in-progress cold-start unlock instead of hard-failing.
    await ensureKeysUnlocked(accountId);
    const account = getAccount(accountId);
    if (!account || !account.keysUnlocked || account.decryptedKeys.length === 0) {
      throw new Error('Keys not unlocked, cannot send');
    }

    const original = await getMessage(accountId, parentMessageId);
    if (!original) throw new Error('Original message not found');

    const { fromAddr, senderPrivKey, senderPubKey, defaultAddr } =
      await _resolveSenderInfo(accountId, account, senderAddress, original);

    // forwardTo may be a single address string (legacy) or an array of
    // {address, name} chips. Build the recipient lists + user CC/BCC, de-duped.
    const _norm = (arr) => (arr || [])
      .map(r => ({ Address: (r.address || r.Address || '').trim(), Name: r.name || r.Name || '' }))
      .filter(r => r.Address);
    const toList = typeof forwardTo === 'string'
      ? [{ Address: forwardTo.trim(), Name: '' }]
      : _norm(forwardTo);
    if (toList.length === 0) throw new Error('No forward recipient');
    const _seen = new Set(toList.map(r => r.Address.toLowerCase()));
    const ccList = [];
    for (const r of _norm(extraCc)) {
      if (!_seen.has(r.Address.toLowerCase())) { ccList.push(r); _seen.add(r.Address.toLowerCase()); }
    }
    const bccList = [];
    for (const r of _norm(extraBcc)) {
      if (!_seen.has(r.Address.toLowerCase())) { bccList.push(r); _seen.add(r.Address.toLowerCase()); }
    }
    const allRecipients = [...toList, ...ccList, ...bccList];

    const subject = (original.Subject || '').startsWith('Fwd:')
      ? original.Subject
      : 'Fwd: ' + (original.Subject || '');

    // Build forward body: user text + quoted original
    let origBody = '';
    try {
      origBody = await decryptBody(accountId, original.Body);
    } catch (e) {
      origBody = '(could not decrypt original message)';
    }
    // Escape everything that came from the original message: a sender
    // display name (attacker-controlled) containing HTML must not become
    // markup in the forwarded body.
    const origSender = (original.Sender && original.Sender.Name)
      ? _escapeHtml(original.Sender.Name) + ' &lt;' + _escapeHtml(original.Sender.Address) + '&gt;'
      : _escapeHtml((original.Sender && original.Sender.Address) || 'Unknown');
    const fwdHeader = '<br><br>---------- Forwarded message ----------<br>' +
      '<b>From:</b> ' + origSender + '<br>' +
      '<b>Date:</b> ' + _escapeHtml(new Date(original.Time * 1000).toLocaleString()) + '<br>' +
      '<b>Subject:</b> ' + _escapeHtml(original.Subject || '') + '<br>' +
      '<b>To:</b> ' + _escapeHtml((original.ToList || []).map(r => r.Address).join(', ')) + '<br><br>';
    const userBody = isHtml ? fwdText : '<div>' + _escapeHtml(fwdText) + '</div>';
    const htmlBody = userBody + fwdHeader + origBody;
    // origBody is the original verbatim, so any inline image it draws is still
    // a cid: reference to the PARENT's parts. Carry them into the forward.
    attachments = await _reattachQuotedImages(accountId, htmlBody, original, attachments);

    await _encryptAndSend(accountId, account, {
      Message: {
        ToList: toList,
        CCList: ccList,
        BCCList: bccList,
        Subject: subject,
        MIMEType: 'text/html',
        AddressID: fromAddr.ID || defaultAddr.ID,
        Sender: {
          Address: fromAddr.Email || fromAddr,
          Name: (fromAddr.DisplayName || defaultAddr.DisplayName) || '',
        },
      },
      ParentID: parentMessageId,
      Action: 2, // Forward
    }, allRecipients, htmlBody, senderPrivKey, senderPubKey, attachments, sendOptions);

    debugLog('[ProtonAccounts] Message forwarded for', account.email);
    // Forward is independent of the reply flags: Proton shows both icons when
    // a message was replied to AND forwarded, so this never clears IsReplied.
    if (_sendWasImmediate(sendOptions)) {
      await _flagParentAfterSend(account, parentMessageId, 'IsForwarded');
    }
    return { success: true };
  }

  /**
   * Build encryption packages for the Proton send endpoint.
   *
   * Proton's send model: the body is encrypted with a random AES-256 session key,
   * then for each recipient the session key is encrypted with their public key.
   *
   * - Internal recipients (Proton users, Type=1): session key encrypted with
   *   recipient's PGP public key, fetched via GET /core/v4/keys?Email=...
   * - External recipients (non-Proton, Type=4): session key sent in cleartext
   *   (Proton's clear scheme: body is still encrypted in transit via TLS).
   *
   * Attachment session keys are also re-encrypted per-recipient using the same
   * pattern, so each recipient can decrypt attachments independently.
   */
  async function _buildSendPackages(accountId, account, toList, htmlBody, signingKey, uploadedAttachments, sendOptions) {
    const opts = sendOptions || {};
    const eoPassword = opts.eoPassword || '';
    const eoHint = opts.eoHint || '';
    // Proton can't expire a plain clear email to an external recipient. That needs
    // a password (Encrypted Outside). So expiry + an external recipient REQUIRES one.
    const requireEoForExternal = !!opts.expiresIn;

    const algorithm = 'aes256';
    const sessionKeyData = crypto.getRandomValues(new Uint8Array(32));
    const attList = uploadedAttachments || [];

    // Encrypt body with session key.
    //
    // Instrumented because every observed apiCode 2001 ("Invalid or missing
    // message signature") on an external send correlates with this step being
    // FAST, and every success with it being slow. If the body is going out
    // unsigned, this is where it happens, and the timing plus the resulting
    // ciphertext length are the cheapest way to see it.
    const _encStart = Date.now();
    const message = await openpgp.createMessage({ text: htmlBody });
    const binaryEncrypted = await openpgp.encrypt({
      message,
      sessionKey: { data: sessionKeyData, algorithm },
      signingKeys: [signingKey],
      format: 'binary',
    });
    _lastBodyEncrypt = {
      encMs: Date.now() - _encStart,
      bodyLen: (htmlBody || '').length,
      cipherLen: binaryEncrypted.length,
      signed: signingKey ? 1 : 0,
    };
    const encryptedBodyBase64 = ProtonBinary.uint8ToBase64(binaryEncrypted);

    const internalAddresses = {};
    const externalAddresses = {};
    const eoAddresses = {};

    // Encrypted-Outside material is identical for every EO recipient in this send
    // (one password per message). Build the verifier + password-bound keys once.
    let _eoShared = null;
    async function _getEoShared() {
      if (_eoShared) return _eoShared;
      const modInfo = await request(accountId, 'GET', 'core/v4/auth/modulus');
      const Auth = await ProtonAuth.buildEoAuthFromModulus(modInfo.Modulus, modInfo.ModulusID, eoPassword);
      // The Token is a BEARER CREDENTIAL for the Encrypted-Outside viewer
      // (GET eo/message/{token}/{id}), not key material, and Proton necessarily
      // stores it in the clear. It must therefore be an independent random
      // value: reusing sessionKeyData here would hand the server the very key
      // that decrypts Body, defeating the password. Proton's own client mints a
      // separate key for exactly this reason (WebClients sendSubPackages.ts,
      // sendPMEncryptedOutside). BodyKeyPacket below stays bound to the real
      // body session key, which is what actually delivers the message.
      const tokenBytes = crypto.getRandomValues(new Uint8Array(32));
      const Token = ProtonBinary.uint8ToBase64(tokenBytes);
      // EncToken: the Token string symmetrically encrypted with the password (armored).
      const EncToken = await openpgp.encrypt({
        message: await openpgp.createMessage({ text: Token }),
        passwords: [eoPassword],
        format: 'armored',
      });
      // Body + attachment session keys bound to the password (vs a recipient pubkey).
      const bodyKeyPacket = await openpgp.encryptSessionKey({
        data: sessionKeyData, algorithm, passwords: [eoPassword], format: 'binary',
      });
      const attKeyPackets = {};
      for (const att of attList) {
        const encAttKey = await openpgp.encryptSessionKey({
          data: att.sessionKeyData, algorithm: att.algorithm,
          passwords: [eoPassword], format: 'binary',
        });
        attKeyPackets[att.id] = ProtonBinary.uint8ToBase64(encAttKey);
      }
      _eoShared = {
        Auth, Token, EncToken,
        BodyKeyPacket: ProtonBinary.uint8ToBase64(bodyKeyPacket),
        attKeyPackets,
      };
      return _eoShared;
    }

    for (const recipient of toList) {
      // Type 4 ships the body session key in CLEAR TEXT, so a recipient may only
      // be classified external when Proton positively tells us they have no key.
      // An error here means we do not KNOW, and guessing "external" would
      // silently strip end-to-end encryption from a Proton-to-Proton message.
      // Refuse to send instead; the caller cleans up the draft.
      let recipientKeys;
      try {
        const keyResult = await request(accountId, 'GET', 'core/v4/keys', {
          params: { Email: recipient.Address },
        });
        recipientKeys = keyResult.Keys || [];
      } catch (err) {
        const e = new Error('RECIPIENT_KEYS_UNAVAILABLE');
        e.cause = err;
        throw e;
      }

      const publicKeys = recipientKeys.filter(k => k && k.PublicKey);

      if (publicKeys.length === 0) {
        // Genuinely external: the lookup succeeded and returned no key.
        if (eoPassword) {
          const s = await _getEoShared();
          eoAddresses[recipient.Address] = {
            Type: 2,
            Token: s.Token,
            EncToken: s.EncToken,
            Auth: s.Auth,
            BodyKeyPacket: s.BodyKeyPacket,
            ...(eoHint ? { PasswordHint: eoHint } : {}),
            ...(Object.keys(s.attKeyPackets).length > 0 && { AttachmentKeyPackets: s.attKeyPackets }),
            Signature: 1,
          };
        } else if (requireEoForExternal) {
          // Expiry requested but this external recipient has no password: Proton
          // would reject it, so fail early.
          throw new Error('EXPIRY_REQUIRES_EO_PASSWORD');
        } else {
          externalAddresses[recipient.Address] = { Type: 4, Signature: 0 };
        }
        continue;
      }

      // Internal recipient. Use the first key we can actually parse rather than
      // index 0: a post-quantum recipient publishes a v6 key alongside a v4 one
      // and the order is not ours to control, so taking [0] blindly would fail
      // on an account we can perfectly well encrypt to.
      let recipientPubKey = null;
      for (const k of publicKeys) {
        if (ProtonPqc.isUnsupportedKey(k.PublicKey)) continue;
        try {
          recipientPubKey = await openpgp.readKey({ armoredKey: k.PublicKey });
          break;
        } catch (e) {
          // Try the next key rather than giving up on the recipient.
        }
      }
      if (!recipientPubKey) {
        // A Proton user whose keys we cannot read. Clear text would be a silent
        // downgrade, so this fails the send.
        throw new Error('RECIPIENT_KEYS_UNREADABLE');
      }

      const bodyKeyPacket = await openpgp.encryptSessionKey({
        data: sessionKeyData, algorithm,
        encryptionKeys: [recipientPubKey],
        format: 'binary',
      });

      // Re-encrypt each attachment's session key for this recipient
      const attKeyPackets = {};
      for (const att of attList) {
        const encAttKey = await openpgp.encryptSessionKey({
          data: att.sessionKeyData, algorithm: att.algorithm,
          encryptionKeys: [recipientPubKey],
          format: 'binary',
        });
        attKeyPackets[att.id] = ProtonBinary.uint8ToBase64(encAttKey);
      }

      internalAddresses[recipient.Address] = {
        Type: 1,
        BodyKeyPacket: ProtonBinary.uint8ToBase64(bodyKeyPacket),
        Signature: 1,
        ...(Object.keys(attKeyPackets).length > 0 && { AttachmentKeyPackets: attKeyPackets }),
      };
    }

    const packages = [];

    if (Object.keys(internalAddresses).length > 0) {
      packages.push({
        Addresses: internalAddresses,
        Type: 1,
        Body: encryptedBodyBase64,
        MIMEType: 'text/html',
      });
    }

    if (Object.keys(eoAddresses).length > 0) {
      packages.push({
        Addresses: eoAddresses,
        Type: 2,
        Body: encryptedBodyBase64,
        MIMEType: 'text/html',
      });
    }

    if (Object.keys(externalAddresses).length > 0) {
      // For clear/external: include unencrypted attachment session keys
      const attKeys = {};
      for (const att of attList) {
        attKeys[att.id] = { Key: ProtonBinary.uint8ToBase64(att.sessionKeyData), Algorithm: att.algorithm };
      }

      packages.push({
        Addresses: externalAddresses,
        Type: 4,
        Body: encryptedBodyBase64,
        MIMEType: 'text/html',
        BodyKey: { Key: ProtonBinary.uint8ToBase64(sessionKeyData), Algorithm: algorithm },
        ...(Object.keys(attKeys).length > 0 && { AttachmentKeys: attKeys }),
      });
    }

    return packages;
  }

  /**
   * Upload an encrypted attachment to a draft message.
   * @param {string} accountId
   * @param {object} account
   * @param {string} messageId - Draft message ID
   * @param {object} att - { name, type, data (base64) }
   * @param {object} pubKey - Sender's public key
   * @param {object} privKey - Sender's private key
   */
  async function _uploadAttachment(accountId, account, messageId, att, pubKey, privKey) {
    // Decode base64 attachment data to binary
    const binary = atob(att.data);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);

    // 1. Generate a random AES-256 session key
    const algorithm = 'aes256';
    const sessionKeyData = crypto.getRandomValues(new Uint8Array(32));

    // 2. Create detached signature of the plaintext (required by Proton API)
    const msg = await openpgp.createMessage({ binary: bytes });
    const detachedSig = await openpgp.sign({
      message: msg,
      signingKeys: [privKey],
      detached: true,
      format: 'binary',
    });

    // 3. Encrypt attachment data with the session key → DataPacket
    const msgForEncrypt = await openpgp.createMessage({ binary: bytes });
    const dataPacket = await openpgp.encrypt({
      message: msgForEncrypt,
      sessionKey: { data: sessionKeyData, algorithm },
      format: 'binary',
    });

    // 4. Encrypt the session key with the sender's public key → KeyPackets
    const keyPackets = await openpgp.encryptSessionKey({
      data: sessionKeyData,
      algorithm,
      encryptionKeys: [pubKey],
      format: 'binary',
    });

    // 5. Upload via multipart form data.
    // Multipart body can't go through request(); replicate its single
    // refresh-and-retry on 401 (token may expire during long compose sessions).
    // A FormData body is consumed by the first fetch(), so build a FRESH one
    // per attempt: reusing it would send an empty body on the retry.
    const buildFormData = () => {
      const fd = new FormData();
      fd.append('MessageID', messageId);
      fd.append('Filename', att.name || 'attachment');
      fd.append('MIMEType', att.type || 'application/octet-stream');
      // A non-empty ContentID is the ONLY thing that marks a part embedded:
      // Proton's upload endpoint has no Disposition field (WebClients
      // api/attachments.ts), and the server derives Content-Disposition from
      // this. Empty for ordinary attachments, set for pasted inline images.
      fd.append('ContentID', att.cid || '');
      fd.append('KeyPackets', new Blob([keyPackets]));
      fd.append('DataPacket', new Blob([dataPacket]));
      fd.append('Signature', new Blob([detachedSig]));
      return fd;
    };
    const uploadOnce = () => {
      const uploadHeaders = ProtonConfig.buildHeaders(account.uid, account.accessToken);
      delete uploadHeaders['Content-Type'];
      return fetch(`${BASE_URL}/mail/v4/attachments`, {
        method: 'POST',
        headers: uploadHeaders,
        credentials: 'omit',
        body: buildFormData(),
      });
    };
    let resp = await uploadOnce();
    if (resp.status === 401) {
      await _refreshTokens(account);
      resp = await uploadOnce();
    }
    if (!resp.ok) {
      const errBody = await resp.json().catch(() => ({}));
      throw new Error(errBody.Error || `Upload failed: HTTP ${resp.status}`);
    }
    const result = await resp.json();
    // Return the attachment ID + session key for re-encryption in send packages
    return {
      id: result.Attachment && result.Attachment.ID,
      sessionKeyData,
      algorithm,
    };
  }

  /**
   * Send a new message (compose, not reply).
   * @param {string} accountId
   * @param {object} params - { to, cc, bcc, subject, htmlBody, attachments }
   */
  async function sendNewMessage(accountId, params) {
    const { to, cc, bcc, subject, body } = params;
    let { htmlBody } = params;
    // Wait for a still-in-progress cold-start unlock instead of hard-failing.
    await ensureKeysUnlocked(accountId);
    const account = getAccount(accountId);
    if (!account || !account.keysUnlocked || account.decryptedKeys.length === 0) {
      throw new Error('Keys not unlocked, cannot send');
    }

    const toList = (to || []).map(a => ({ Address: a.address, Name: a.name || '' }));
    const ccList = (cc || []).map(a => ({ Address: a.address, Name: a.name || '' }));
    const bccList = (bcc || []).map(a => ({ Address: a.address, Name: a.name || '' }));

    if (toList.length === 0) throw new Error('No recipients');

    if (!htmlBody && body) {
      htmlBody = '<div>' + _escapeHtml(body) + '</div>';
    }

    const { fromAddr, senderPrivKey, senderPubKey } =
      await _resolveSenderInfo(accountId, account);

    const allRecipients = [...toList, ...ccList, ...bccList];

    await _encryptAndSend(accountId, account, {
      Message: {
        ToList: toList,
        CCList: ccList,
        BCCList: bccList,
        Subject: subject || '',
        MIMEType: 'text/html',
        Sender: {
          Address: fromAddr.Email,
          Name: fromAddr.DisplayName || '',
        },
      },
    }, allRecipients, htmlBody, senderPrivKey, senderPubKey, params.attachments, params.sendOptions);

    debugLog('[ProtonAccounts] New message sent from', account.email);
    return { success: true };
  }

  /** Cancel a scheduled message. Proton moves it back to Drafts. */
  async function cancelScheduledSend(accountId, messageId) {
    await request(accountId, 'POST', 'mail/v4/messages/' + messageId + '/cancel_send');
    debugLog('[ProtonAccounts] Cancelled scheduled send', messageId);
    return { success: true };
  }

  /** Send a calendar RSVP reply email with ICS attachment to the organizer. */
  async function sendCalendarRsvp(accountId, organizerEmail, subject, htmlBody, icsData, senderAddress, opts) {
    // The worker is torn down after ~30 s idle and comes back with _initDone
    // already true while initSlow() is still unlocking. Clicking Yes on an
    // invite in that window failed outright ("Keys not unlocked" logged 27 ms
    // before the unlock finished), so wait for the coalesced unlock first.
    await ensureKeysUnlocked(accountId);
    const account = getAccount(accountId);
    if (!account || !account.keysUnlocked || account.decryptedKeys.length === 0) {
      throw new Error('Keys not unlocked');
    }

    const { fromAddr, senderPrivKey, senderPubKey, defaultAddr } =
      await _resolveSenderInfo(accountId, account, senderAddress);

    const toList = [{ Address: organizerEmail, Name: '' }];
    const icsAttachment = {
      name: 'invite.ics',
      type: 'text/calendar; method=REPLY',
      // btoa() is code-point based: it throws above U+00FF and silently emits
      // Latin-1 bytes for U+0080..U+00FF. SUMMARY and the organizer's name come
      // verbatim from the invite, so an emoji in a title threw before any
      // network call and an umlaut produced mojibake in the organizer's
      // calendar. Encode the UTF-8 bytes instead.
      data: ProtonBinary.uint8ToBase64(new TextEncoder().encode(icsData)),
    };

    await _encryptAndSend(accountId, account, {
      Message: {
        ToList: toList,
        CCList: [],
        BCCList: [],
        Subject: subject,
        MIMEType: 'text/html',
        AddressID: fromAddr.ID || defaultAddr.ID,
        Sender: {
          Address: fromAddr.Email || fromAddr,
          Name: (fromAddr.DisplayName || defaultAddr.DisplayName) || '',
        },
      },
    }, toList, htmlBody, senderPrivKey, senderPubKey, [icsAttachment]);

    debugLog('[ProtonAccounts] Calendar RSVP sent to', organizerEmail);

    // Also update the calendar event status if possible
    if (opts && opts.eventUID && opts.partstat) {
      try {
        await _updateCalendarAttendeeStatus(
          accountId, opts.eventUID, opts.attendeeToken || '',
          // Match the calendar attendee by the ACTUAL invited address (the ICS
          // ATTENDEE, e.g. a +alias mail+shop@), NOT the SMTP send-from, which
          // is the base address (mail@) and would miss the +alias attendee
          // (token candidates / email both fail). Fall back to senderAddress
          // only if the popup didn't supply the attendee email.
          opts.partstat, opts.attendeeEmail || senderAddress || '', opts.recurrenceId || '');
      } catch (calErr) {
        console.warn('[ProtonAccounts] Calendar update failed (email was sent):', calErr.message);
      }
    }

    return { success: true };
  }

  /** Look up a calendar event by its UID across all personal calendars. */
  async function getCalendarEventByUID(accountId, uid) {
    const result = await request(accountId, 'GET', 'calendar/v1/events', {
      params: { UID: uid, Type: 0 },
    });
    return result.Events || [];
  }

  /** Get full calendar event details including attendee info. */
  async function getCalendarEvent(accountId, calendarId, eventId) {
    const result = await request(accountId, 'GET',
      `calendar/v1/${calendarId}/events/${eventId}`);
    return result.Event || null;
  }

  /** Get attendee statuses for a calendar event (live from API). */
  /** Decrypt attendee emails from the calendar event's encrypted AttendeesEvents.
   *  Returns a map of Token → email. */
  /** Get decrypted calendar private keys by bootstrapping the calendar.
   *  Chain: user address key → decrypt member passphrase → import calendar private key */
  async function _getCalendarKeys(accountId, calendarId) {
    const account = getAccount(accountId);
    if (!account || !account.keysUnlocked || account.decryptedKeys.length === 0) return [];

    try {
      const bootstrap = await request(accountId, 'GET', `calendar/v2/${calendarId}/bootstrap`);
      const passphrase = bootstrap.Passphrase;
      const calKeys = bootstrap.Keys || [];
      debugLog('[CalendarDecrypt] Bootstrap: keys:', calKeys.length,
        'memberPassphrases:', passphrase?.MemberPassphrases?.length || 0);
      if (!passphrase || !passphrase.MemberPassphrases || calKeys.length === 0) return [];

      // Decrypt the member passphrase using our address keys
      let decryptedPassphrase = null;
      for (const mp of passphrase.MemberPassphrases) {
        try {
          const msg = await openpgp.readMessage({ armoredMessage: mp.Passphrase });
          const { data } = await openpgp.decrypt({
            message: msg,
            decryptionKeys: account.decryptedKeys,
          });
          decryptedPassphrase = data;
          debugLog('[CalendarDecrypt] Passphrase decrypted, length:', data.length);
          break;
        } catch (e) {
          debugLog('[CalendarDecrypt] Passphrase decrypt failed:', e.message);
        }
      }
      if (!decryptedPassphrase) {
        debugLog('[CalendarDecrypt] Could not decrypt any member passphrase');
        return [];
      }

      // Import calendar private keys using the decrypted passphrase
      const decryptedCalKeys = [];
      for (const ck of calKeys) {
        try {
          const keyObj = await openpgp.readPrivateKey({ armoredKey: ck.PrivateKey });
          const decrypted = await openpgp.decryptKey({ privateKey: keyObj, passphrase: decryptedPassphrase });
          decryptedCalKeys.push(decrypted);
          debugLog('[CalendarDecrypt] Calendar key imported successfully');
        } catch (e) {
          debugLog('[CalendarDecrypt] Calendar key import failed:', e.message);
        }
      }
      debugLog('[CalendarDecrypt] Decrypted calendar keys:', decryptedCalKeys.length);
      return decryptedCalKeys;
    } catch (e) {
      debugLog('[CalendarDecrypt] Bootstrap failed:', e.message);
      return [];
    }
  }

  /** Decrypt attendee emails from the calendar event's encrypted AttendeesEvents. */
  /**
   * Extract a Proton attendee-token → email map from a decrypted attendee
   * VCALENDAR.
   *
   * Unfolds RFC 5545 line folding FIRST: Proton wraps lines at ~75 octets with
   * a leading space on continuation lines, which splits "mailto:" (and the
   * email itself) across physical lines, defeating any regex that expects the
   * literal ":mailto:". The popup's parseICS already unfolds; this background
   * path previously did not, which left the map empty ("Email map: {}") and
   * blinded the self-attendee match. Matched per ATTENDEE property so each
   * token stays paired with its own email even with multiple attendees.
   */
  function _attendeeTokenEmailMap(decrypted) {
    const unfolded = (decrypted || '').replace(/\r\n[ \t]/g, '').replace(/\n[ \t]/g, '');
    const map = {};
    for (const line of (unfolded.match(/^ATTENDEE.*$/gim) || [])) {
      const token = (line.match(/X-PM-TOKEN=([^;:\s]+)/i) || [])[1];
      const email = (line.match(/:mailto:([^\s;]+)/i) || [])[1];
      if (token && email) map[token] = email;
    }
    return map;
  }

  async function _decryptAttendeeEmails(accountId, full) {
    const account = getAccount(accountId);
    if (!account || !account.keysUnlocked || account.decryptedKeys.length === 0) return {};

    const attendeesEvents = full.AttendeesEvents || [];
    if (attendeesEvents.length === 0) return {};

    // Build list of all keys to try: user keys + calendar keys
    const allKeys = [...account.decryptedKeys];

    // Bootstrap calendar keys if SharedKeyPacket is the only option
    if (!full.AddressKeyPacket && full.CalendarID) {
      const calKeys = await _getCalendarKeys(accountId, full.CalendarID);
      allKeys.push(...calKeys);
      debugLog('[CalendarDecrypt] Total keys to try:', allKeys.length,
        '(user:', account.decryptedKeys.length, '+ calendar:', calKeys.length + ')');
    }

    // Try to decrypt session key from available key packets
    const keyPacketSources = [
      { name: 'AddressKeyPacket', data: full.AddressKeyPacket },
      { name: 'SharedKeyPacket', data: full.SharedKeyPacket },
      { name: 'CalendarKeyPacket', data: full.CalendarKeyPacket },
    ].filter(kp => kp.data);

    let sessionKey = null;
    for (const kp of keyPacketSources) {
      try {
        const binaryKeyPacket = ProtonBinary.base64ToUint8(kp.data);
        const sessionKeys = await openpgp.decryptSessionKeys({
          message: await openpgp.readMessage({ binaryMessage: binaryKeyPacket }),
          decryptionKeys: allKeys,
        });
        if (sessionKeys && sessionKeys.length > 0) {
          sessionKey = sessionKeys[0];
          debugLog('[CalendarDecrypt] Session key decrypted via', kp.name);
          break;
        }
      } catch (e) {
        debugLog('[CalendarDecrypt]', kp.name, 'failed:', e.message);
      }
    }
    if (!sessionKey) {
      debugLog('[CalendarDecrypt] All key packets failed');
      return {};
    }

    // Decrypt each AttendeesEvent to extract attendee emails
    const emailMap = {};
    let decryptedCount = 0;
    for (const ae of attendeesEvents) {
      if (!ae.Data) continue;
      try {
        // Data can be armored (starts with -----) or base64-encoded binary
        const isArmored = ae.Data.trimStart().startsWith('-----');
        const dataMsg = isArmored
          ? await openpgp.readMessage({ armoredMessage: ae.Data })
          : await openpgp.readMessage({ binaryMessage: ProtonBinary.base64ToUint8(ae.Data) });
        const { data: decrypted } = await openpgp.decrypt({
          message: dataMsg, sessionKeys: [sessionKey],
        });
        decryptedCount++;
        Object.assign(emailMap, _attendeeTokenEmailMap(decrypted));
      } catch (e) {
        debugLog('[CalendarDecrypt] AttendeesEvent decrypt failed:', e.message);
      }
    }
    // Counts only, never the payload or the addresses: debugLog is captured
    // into the exportable ProtonDiag ring when debug logging is on, and the
    // log must never hold decrypted content.
    debugLog('[CalendarDecrypt] Decrypted', decryptedCount, 'of', attendeesEvents.length,
      'attendee entries;', Object.keys(emailMap).length, 'token(s) resolved to an email');
    return emailMap;
  }

  /**
   * Pick the calendar event that matches the RSVP scope.
   *
   * A recurring UID resolves to a master event (RecurrenceID null) plus one
   * event per modified occurrence (RecurrenceID = the occurrence's Unix time).
   *  - Whole-series RSVP (no recurrence): the master.
   *  - Single-occurrence RSVP: the matching exception. With exactly one
   *    exception we use it; with several we can't disambiguate without
   *    timezone-exact RecurrenceID math, so we return null and callers SKIP
   *    the local own-status update rather than write onto the wrong event or
   *    the whole series (the emailed REPLY already carried RECURRENCE-ID, so
   *    the organizer is correct regardless).
   */
  function _pickEventForScope(events, isOccurrence) {
    if (!events || events.length === 0) return null;
    if (!isOccurrence) {
      return events.find(e => !e.RecurrenceID) || events[0];
    }
    const exceptions = events.filter(e => e.RecurrenceID);
    return exceptions.length === 1 ? exceptions[0] : null;
  }

  async function getCalendarAttendees(accountId, eventUID, recurrenceId) {
    try {
      const events = await getCalendarEventByUID(accountId, eventUID);
      if (!events || events.length === 0) {
        debugLog('[ProtonAccounts] No calendar event found for UID:', eventUID);
        return { notFound: true };
      }
      const ev = _pickEventForScope(events, !!recurrenceId);
      // Diagnostic: how many calendar events share this UID (duplicates from a
      // re-imported/sequence-bumped invite?) and which one we target.
      ProtonDiag.record('rsvp.lookup', {
        uid: (eventUID || '').slice(0, 14),
        eventsForUid: events.length,
        isOccurrence: !!recurrenceId,
        picked: ev ? (ev.ID || '').slice(0, 10) : 'none',
      });
      if (!ev) {
        debugLog('[ProtonAccounts] Could not isolate occurrence for UID:', eventUID,
          '- leaving local calendar untouched');
        return null;
      }
      const full = await getCalendarEvent(accountId, ev.CalendarID, ev.ID);
      const attendees = full.Attendees
        || (full.AttendeesInfo && full.AttendeesInfo.Attendees)
        || [];
      if (attendees.length === 0) return null;

      // Try to decrypt attendee emails from the encrypted event data
      const emailMap = await _decryptAttendeeEmails(accountId, full);

      // Enrich attendees with decrypted emails
      const enriched = attendees.map(a => ({
        ...a,
        Email: emailMap[a.Token] || '',
      }));

      // Diagnostic: the per-attendee Status string (e.g. "00030000") reveals
      // whether our RSVP actually persisted server-side on the next read,
      // without logging any addresses.
      ProtonDiag.record('rsvp.attendees', {
        uid: (eventUID || '').slice(0, 14),
        n: enriched.length,
        statuses: enriched.map(a => a.Status).join(''),
        withEmail: enriched.filter(a => a.Email).length,
      });

      return {
        calendarId: ev.CalendarID,
        eventId: ev.ID,
        attendees: enriched,
      };
    } catch (e) {
      console.warn('[ProtonAccounts] Calendar attendee lookup failed:', e.message);
      return null;
    }
  }

  /** SHA-1 of a binary string, hex-encoded. Matches Proton's
   *  binaryStringToUint8Array + computeHash('unsafeSHA1').toHex(). */
  async function _sha1Hex(str) {
    const bytes = Uint8Array.from(str, (c) => c.charCodeAt(0) & 0xff);
    const buf = await crypto.subtle.digest('SHA-1', bytes);
    return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');
  }

  /** Candidate Proton attendee tokens for an email on a given event UID.
   *  Proton's token = SHA1(uid + canonicalizedEmail).hex(), where the
   *  canonicalization depends on the provider (verified against real tokens):
   *    - default/custom domains: lowercase
   *    - gmail/googlemail/google: strip dots + "+alias"
   *    - proton.me/pm.me (internal): strip ". _ -" + "+alias"
   *  We try the relevant variants so a token-less (external) invite can still
   *  be matched to its calendar attendee instead of guessing. */
  async function _attendeeTokenCandidates(uid, email) {
    const e = (email || '').trim();
    const at = e.lastIndexOf('@');
    if (at < 0) return new Set();
    const domain = e.slice(at + 1).toLowerCase();
    const local = e.slice(0, at).split('+')[0]; // drop +alias
    const variants = new Set([e.toLowerCase(), local.toLowerCase() + '@' + domain]);
    if (['gmail.com', 'googlemail.com', 'google.com'].includes(domain)) {
      variants.add(local.replace(/[.]/g, '').toLowerCase() + '@' + domain);
    }
    if (['proton.me', 'protonmail.com', 'protonmail.ch', 'pm.me'].includes(domain)) {
      variants.add(local.replace(/[._-]/g, '').toLowerCase() + '@' + domain);
    }
    const tokens = new Set();
    for (const v of variants) {
      if (v) tokens.add(await _sha1Hex(uid + v));
    }
    return tokens;
  }

  /** Update an attendee's participation status on the calendar event.
   *  recurrenceId (the invite's RECURRENCE-ID, if any) scopes the update to a
   *  single occurrence so a per-occurrence RSVP never writes onto the whole
   *  series. */
  async function _updateCalendarAttendeeStatus(accountId, eventUID, attendeeToken, partstat, attendeeEmail, recurrenceId) {
    const statusMap = { ACCEPTED: 3, TENTATIVE: 1, DECLINED: 2 };
    const apiStatus = statusMap[partstat];
    if (apiStatus === undefined) return;

    const calData = await getCalendarAttendees(accountId, eventUID, recurrenceId);
    if (!calData || !calData.attendees || calData.attendees.length === 0) {
      console.warn('[ProtonAccounts] Could not isolate this event/occurrence for UID:', eventUID,
        '- RSVP email was sent; skipping local status update');
      return;
    }

    // Identify which attendee is "us", in priority order, most reliable first:
    //  1. The X-PM-TOKEN from the invite ICS (present on Proton-internal invites).
    //  2. The decrypted attendee EMAIL (now reliable: _attendeeTokenEmailMap
    //     unfolds the ICS, so we positively match our own address rather than
    //     guessing; this is the key fix for external invites attributing the
    //     RSVP to the wrong attendee).
    //  3. Last resort: recompute Proton's SHA1(uid + canonicalEmail) token
    //     candidates (covers any address-canonicalization we couldn't decrypt).
    const wantEmail = (attendeeEmail || '').toLowerCase();
    let matchedVia = '';
    let attendee = attendeeToken
      ? calData.attendees.find(a => a.Token === attendeeToken)
      : null;
    if (attendee) matchedVia = 'token';

    if (!attendee && wantEmail) {
      attendee = calData.attendees.find(a => (a.Email || '').toLowerCase() === wantEmail);
      if (attendee) matchedVia = 'email';
    }

    if (!attendee && wantEmail && eventUID) {
      try {
        const candidates = await _attendeeTokenCandidates(eventUID, attendeeEmail);
        attendee = calData.attendees.find(a => candidates.has(a.Token));
        if (attendee) matchedVia = 'token-candidate';
      } catch (e) {
        console.warn('[ProtonAccounts] Attendee token computation failed:', e.message);
      }
    }

    // Diagnostic: record whether we found "us" among the calendar attendees and
    // how, so an RSVP that doesn't stick is visible in the exported diag log.
    ProtonDiag.record('rsvp.update', {
      uid: (eventUID || '').slice(0, 14),
      attendeeEmail: wantEmail,
      hasToken: attendeeToken ? 'yes' : 'no',
      calAttendees: calData.attendees.length,
      matched: attendee ? matchedVia : 'NONE',
      partstat,
    });

    if (!attendee) {
      // Don't guess: a wrong guess writes our partstat onto another attendee.
      // The RSVP email was still sent to the organizer; only the local calendar
      // copy's own-status won't update in this (rare) case.
      console.warn('[ProtonAccounts] Could not identify self attendee for', attendeeEmail, '- skipping local status update');
      return;
    }

    try {
      await request(accountId, 'PUT',
        `calendar/v1/${calData.calendarId}/events/${calData.eventId}/attendees/${attendee.ID}`, {
          data: { Status: apiStatus, UpdateTime: Math.floor(Date.now() / 1000) },
        });
      // Diagnostic: the PUT result was previously swallowed. Capture success so a
      // "matched but didn't stick" case points at the server, not the matching.
      ProtonDiag.record('rsvp.put', {
        ok: 'yes',
        eventId: (calData.eventId || '').slice(0, 10),
        attendee: (attendee.ID || '').slice(0, 10),
        status: apiStatus,
      });
      debugLog('[ProtonAccounts] Calendar attendee status updated to', partstat);
    } catch (e) {
      // Capture the failure (incl. Proton error code/message) so a rejected
      // partstat PUT on a sequence-bumped/external invite is visible in the log.
      ProtonDiag.record('rsvp.put', {
        ok: 'no',
        eventId: (calData.eventId || '').slice(0, 10),
        status: apiStatus,
        error: (e && e.message ? String(e.message) : 'unknown').slice(0, 120),
      });
      console.warn('[ProtonAccounts] Calendar status update failed:', e.message);
    }
  }

  // --- Contacts ---

  // --- Alarm dispatcher ---

  /** Dispatch alarms owned by ProtonAccounts (token refresh, key retry). */
  function handleAlarm(alarm) {
    if (alarm.name === ALARM_TOKEN_REFRESH ||
        alarm.name === ALARM_TOKEN_REFRESH_INITIAL) {
      _refreshAllTokens();
      return;
    }
    if (alarm.name.startsWith(_KEY_RETRY_PREFIX)) {
      _handleKeyRetryAlarm(alarm.name);
      return;
    }
  }

  // --- URL Detection (delegated to ProtonUrlDetection) ---

  /** Initialize URL detection with account accessors. */
  async function initUrlDetection() {
    await ProtonUrlDetection.init({
      getAccounts: () => _accounts,
      findAccountBy: (pred) => _accounts.find(pred),
    });
    ProtonUrlDetection.initListeners();
    // The web client's ViewMode bucket is re-checked on Proton tab loads by
    // url-detection's listener, which is registered at top level: one added
    // here, after the init awaits, missed the very load that woke the page.
  }

  return {
    init,
    initFast,
    initSlow,
    hasAccounts,
    getAccounts,
    getAccount,
    login,
    submit2FA,
    updateAccountSettings,
    applyPremiumScope,
    reorderAccount,
    removeAccount,
    request,
    unlockKeys,
    ensureKeysUnlocked,
    invalidateKeys,
    decryptBody,
    getMessageCounts,
    getInboxUnreadCount,
    getMonitoredUnreadCount,
    getMonitoredMessages,
    getMonitoredLabelIds,
    checkMonitoredAgainstCounts,
    snapshotSource: () => _snapshotSource,
    scopeKey: _scopeKey,
    effectiveViewMode: _effectiveViewMode,
    noteAccountEvents,
    invalidateBootstrap,
    getMessages,
    getMessage,
    getLatestEventId,
    getEvents,
    markAsRead,
    archiveMessages,
    trashMessages,
    deleteMessagesPermanently,
    snoozeConversations,
    hasPending2FA: () => !!_pending2FA,
    getPending2FAType,
    set2FAMethod,
    getFIDO2Options,
    submitFIDO2,
    hasPendingMailboxPassword: () => !!_pendingMailboxPwd,
    cancelPendingAuth: () => {
      _pending2FA = null;
      _pendingMailboxPwd = null;
    },
    submitMailboxPassword,
    sendReply,
    forwardMessage,
    markAsUnread,
    unarchiveMessages,
    untrashMessages,
    starMessages,
    unstarMessages,
    labelMessages,
    unlabelMessages,
    getAddresses,
    getLabels,
    getFolders,
    moveToFolder,
    reportPhishing,
    sendNewMessage,
    cancelScheduledSend,
    sendCalendarRsvp,
    getCalendarAttendees,
    _attendeeTokenEmailMap, // exposed for unit tests (pure ICS token→email parse)
    _pickEventForScope,     // exposed for unit tests (master vs occurrence selection)
    initUrlDetection,
    handleAlarm,
    refreshWebViewModes,
    getMailUrl: (...args) => ProtonUrlDetection.getMailUrl(...args),
    getComposeUrl: (...args) => ProtonUrlDetection.getComposeUrl(...args),
    // The label is a Pro setting: without Premium it reads as unset, as in getAccounts().
    getAccountMapping: () => {
      const premium = _proSettingsApply();
      return ProtonUrlDetection.getAccountMapping().map((m) => (premium ? m : { ...m, label: '' }));
    },
    setAccountMapping: (...args) => ProtonUrlDetection.setAccountMapping(...args),
    rescanUrlMapping: () => ProtonUrlDetection.rescanUrlMapping(),
    getAttachment,
    getSenderLogo,
    streamRequest,
    decryptAttachment,
    getContactEmails: (...args) => ProtonContacts.getContactEmails(...args),
    searchContacts: (...args) => ProtonContacts.searchContacts(...args),
    getAccountSettingsExport,
    pushAccountSettingsToSync,
    importAccountSettings,
    saveSnapshot,
    hasSnapshot: () => _hasSnapshot,
    clearMessageCache,
    // Remove ONLY the on-disk encrypted cache (used when the "Enable cache"
    // toggle is switched off: leaves the in-RAM messages + session snapshot so
    // the current popup view is undisturbed).
    wipeDiskCache: _wipeEncryptedCache,
    /**
     * Add a parsed-from-ICS event into the user's calendar.
     * Orchestrates: parse → bootstrap+decrypt calendar key → serialize+encrypt → POST.
     * Returns { success: true, event } or throws.
     */
    /**
     * Check whether an event with this UID already exists in any of
     * the user's calendars. Returns { exists, calendarId, eventId }.
     * Mirrors what the Proton WebUI does to decide between "Add to
     * Proton Calendar" and "Open in Proton Calendar".
     */
    findCalendarEventByUID: async (accountId, uid) => {
      try {
        const events = await getCalendarEventByUID(accountId, uid);
        if (events && events.length > 0) {
          return { exists: true, calendarId: events[0].CalendarID, eventId: events[0].ID };
        }
      } catch (e) {
        // Network / auth failure: treat as "unknown" so the popup
        // falls back to offering the Add button.
        debugLog('[ProtonAccounts] findCalendarEventByUID failed:', e.message);
      }
      return { exists: false };
    },
    addToCalendar: async (accountId, calendarId, icsText) => {
      const event = ProtonCalendarICS.parse(icsText);
      if (!event) throw new Error('Could not parse ICS');
      // Same cold-start race as sendCalendarRsvp: keys may still be unlocking
      // right after the worker wakes, so wait for it before judging them.
      await ensureKeysUnlocked(accountId);
      const account = getAccount(accountId);
      if (!account || !account.keysUnlocked || !account.decryptedKeys.length) {
        throw new Error('Keys not unlocked');
      }

      // Bootstrap the calendar: gives us the MemberID (needed by
      // /events/sync) AND the member's email, which we use to pick
      // the matching signing key. Proton's API rejects payloads
      // signed by a key that doesn't belong to the calendar
      // membership's address.
      const bootstrap = await request(accountId, 'GET',
        `calendar/v2/${calendarId}/bootstrap`);
      const member = bootstrap && bootstrap.Members && bootstrap.Members[0];
      if (!member || !member.ID) throw new Error('Calendar membership not found');
      const memberId = member.ID;
      const memberEmail = (member.Email || '').toLowerCase();

      // addressKeyMap is built during unlockKeys (email -> primary
      // decrypted private key). Fall back to decryptedKeys[0] only if
      // we somehow don't have a match: better to attempt the call
      // than fail outright, the server will produce a clear error.
      const signingKey =
        (memberEmail && account.addressKeyMap && account.addressKeyMap[memberEmail])
        || account.decryptedKeys[0];

      // The address ID matching the member's email, needed in the
      // event payload so the server knows which address signed.
      const addressId = await _findAddressIdForEmail(accountId, memberEmail);

      const calKeys = await _getCalendarKeys(accountId, calendarId);
      if (!calKeys.length) throw new Error('Could not unlock calendar key');
      const calendarPrivateKey = calKeys[0];
      const calendarPublicKey = calendarPrivateKey.toPublic
        ? calendarPrivateKey.toPublic()
        : calendarPrivateKey;

      const payload = await ProtonCalendarSerialize.buildPayload(event, {
        signingKey, calendarPublicKey,
      });
      if (addressId) payload.AddressID = addressId;
      const created = await ProtonCalendarAPI.createEvent(accountId, calendarId, memberId, payload);
      return { success: true, event: created };
    },
    // --- Exposed for the calendar-add modules ---
    // request() is already exported above; the helpers below complete the set:
    // getCalendarKeys(): decrypted calendar private keys (for signing context).
    // getCalendarPublicKey(): calendar public key used to wrap session keys.
    // (getSigningKey() was removed: it returned decryptedKeys[0], an arbitrary
    // key that was not even address-scoped, and had no callers. The calendar
    // path resolves its own signing key from addressKeyMap just above.)
    getCalendarKeys: _getCalendarKeys,
    getCalendarPublicKey: async (accountId, calendarId) => {
      const bootstrap = await request(accountId, 'GET',
        `calendar/v2/${calendarId}/bootstrap`);
      const keys = (bootstrap && bootstrap.Keys) || [];
      // Prefer a key we can parse, so a post-quantum key alongside it does not
      // take out calendar access.
      const readable = keys.filter(k => !ProtonPqc.isUnsupportedKey(k.PublicKey));
      const pool = readable.length ? readable : keys;
      const primary = pool.find(k => k.Flags & 1) || pool[0];
      if (!primary) return null;
      return openpgp.readKey({ armoredKey: primary.PublicKey });
    },
  };
})();
