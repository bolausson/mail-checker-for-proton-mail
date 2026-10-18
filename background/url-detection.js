/**
 * Proton Web URL Detection.
 *
 * Maps extension account IDs to Proton's /u/N/ URL slots for generating
 * correct "open in Proton" links. The slot is a LocalID from the web session
 * and is NOT the account's position in our own list, so it has to be
 * discovered from the browser's Proton sessions.
 *
 * RESOLUTION order, when a link is built (_getAccountIndex):
 *   1. Manual override, set by the user in Options > Account Alignment
 *   2. The detected map, keyed by session uid
 *   3. Fallback: the account's position in our list
 *
 * The detected map is WRITTEN by exactly one thing: the ps-* localStorage
 * scan, via scripting.executeScript on a Proton tab. It runs at startup if a
 * tab is already open, on tab load, and on the Options rescan button, which is
 * also the only path that clears stale entries.
 *
 * It needs an open Proton tab, so a fresh profile with none resolves by
 * position until the user opens one. Options surfaces which of the three
 * sources produced each slot, and lets the user override it.
 *
 * Extracted from accounts.js to reduce that module's size and responsibility.
 * Depends on account data via callbacks passed to init().
 */

const ProtonUrlDetection = (() => {
  // Shared state: persisted to browser.storage.local
  let _accountUrlMap = {};  // { uid: { slot, detectedAt } }
  let _manualUrlMap = {};   // { accountId: slotNumber }

  // Callbacks injected by init() to access account data without circular deps
  let _getAccounts = () => [];
  let _findAccountBy = () => null;

  /** Initialize with stored mappings and account accessors. */
  async function init({ getAccounts, findAccountBy }) {
    _getAccounts = getAccounts;
    _findAccountBy = findAccountBy;

    const stored = await browser.storage.local.get(['accountUrlMap', 'manualUrlMap']);
    _accountUrlMap = stored.accountUrlMap || {};
    _manualUrlMap = stored.manualUrlMap || {};
  }

  /** Update the slot mapping for a UID. */
  function _updateSlotMapping(uid, slot, forceTimestamp) {
    const existing = _accountUrlMap[uid];
    const existingSlot = existing && typeof existing === 'object' ? existing.slot : existing;
    const hasTimestamp = existing && typeof existing === 'object' && existing.detectedAt;
    if (existingSlot !== slot || !hasTimestamp || forceTimestamp) {
      _accountUrlMap[uid] = { slot, detectedAt: new Date().toISOString() };
      browser.storage.local.set({ accountUrlMap: _accountUrlMap });
      if (existingSlot !== slot) {
        debugLog('[ProtonUrlDetection] Detected mapping: UID', uid, '→ /u/' + slot + '/');
      }
    }
  }

  // There used to be a REFRESH-* cookie strategy here, and the `cookies`
  // permission that went with it. It never worked. It required a numeric
  // `LocalID` in the cookie's JSON payload and skipped any cookie without one;
  // Proton's REFRESH-* cookies actually carry
  // { ResponseType, ClientID, GrantType, RefreshToken, UID } and have no
  // LocalID or UserID at all, so the loop mapped nothing on every run. Verified
  // against two live multi-account sessions on 2026-08-08 via the key-name
  // debug line the code itself emitted.
  //
  // `cookies` is the most heavily weighted permission in extension scanners,
  // and it was being held for a loop that could not produce a mapping.

  // Self-contained reader: scans the tab's localStorage for ps-* session
  // entries. It is passed by reference to scripting.executeScript and runs in
  // the page's own global scope, so it must not reference any outer-scope
  // identifier (see lib/scripting-shim.js).
  function _readSessionsFromPage() {
    const sessions = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key.indexOf('ps-') !== 0) continue;
      try {
        const val = JSON.parse(localStorage.getItem(key));
        if (val && val.UserID) {
          sessions.push({ localId: parseInt(key.substring(3), 10), userId: val.UserID });
        }
      } catch (e) { /* ignore non-JSON */ }
    }
    return sessions;
  }

  /** The /u/N/ slot a Proton Mail URL is showing, or null. */
  function _slotFromUrl(url) {
    const m = /mail\.proton\.me\/u\/(\d+)/.exec(url || '');
    return m ? parseInt(m[1], 10) : null;
  }

  /**
   * Decide at most one slot per account from a raw ps-* session list.
   *
   * A browser profile that has signed into the same Proton account more than
   * once keeps one ps-* entry per slot it has ever used, and they all carry
   * the SAME UserID. Both scan paths used to write every match in turn, so
   * whichever entry came last in localStorage order won: arbitrary, often
   * stale, and then shown to the user as "Auto-detected" as though it were
   * known.
   *
   * `activeSlot` is the slot the scanned tab is actually displaying. For that
   * one account it settles the question outright.
   *
   * Accounts we cannot resolve are returned as `ambiguous` rather than
   * guessed. Callers decide what to do with them.
   */
  function _resolveSlots(sessions, accounts, activeSlot) {
    const slotsByUser = new Map();
    for (const s of sessions) {
      if (!slotsByUser.has(s.userId)) slotsByUser.set(s.userId, []);
      slotsByUser.get(s.userId).push(s.localId);
    }

    const resolved = new Map();
    const ambiguous = [];
    for (const [userId, slots] of slotsByUser) {
      const acct = accounts.find(a => a.userId === userId);
      if (!acct) continue;
      if (slots.length === 1) {
        resolved.set(acct.uid, slots[0]);
      } else if (activeSlot !== null && slots.indexOf(activeSlot) !== -1) {
        resolved.set(acct.uid, activeSlot);
      } else {
        ambiguous.push({ account: acct, slots: slots.slice().sort((a, b) => a - b) });
      }
    }
    return { resolved, ambiguous, users: slotsByUser.size };
  }

  // Read ALL ps-* keys from a tab's localStorage and map accounts
  let _lastFullScanTime = 0;
  function _scanAllSessionsFromTab(tabId, label, tabUrl) {
    ProtonScripting.executeInTab(tabId, _readSessionsFromPage)
      .then(sessions => {
        if (!sessions || !Array.isArray(sessions) || sessions.length === 0) return;
        const accounts = _getAccounts();
        const { resolved, ambiguous, users } = _resolveSlots(
          sessions, accounts, _slotFromUrl(tabUrl));

        for (const [uid, slot] of resolved) _updateSlotMapping(uid, slot);

        // This path runs in the background off a tab load, so it only ever
        // improves the mapping. An account it cannot resolve keeps whatever it
        // had; degrading that silently would be worse than leaving it.
        for (const a of ambiguous) {
          debugLog('[ProtonUrlDetection]', label + ': ambiguous slots for',
            a.account.email || a.account.id, '(/u/' + a.slots.join('/, /u/') + '/), left unchanged');
        }

        if (resolved.size > 0 || ambiguous.length > 0) {
          // One string, not a trailing '' argument: the console renders an
          // empty argument as "<empty string>", which reads like a bug.
          debugLog('[ProtonUrlDetection] ' + label + ': mapped ' + resolved.size +
            ' account(s) from ' + sessions.length + ' session(s) for ' + users +
            ' user(s)' + (ambiguous.length ? ' (' + ambiguous.length + ' ambiguous)' : ''));
        }
      })
      .catch(err => {
        console.warn('[ProtonUrlDetection]', label, 'scan failed:', err.message);
      });
  }

  // === Synchronous listener registration ===
  // Listeners must register on script load so Chrome MV3 service workers
  // don't drop events that fire during cold start. Each listener gracefully
  // handles being called before init(): _getAccounts() returns [] until
  // accessor callbacks are injected, so unmatched events become no-ops.

  // There used to be a `webRequest` strategy here: an onBeforeSendHeaders
  // listener that read the x-pm-uid header off Proton traffic and paired it
  // with the /u/N/ slot in the originating tab's URL.
  //
  // It was removed along with the `webRequest` permission, for two reasons.
  // It could not work: the header on a web tab's request carries the WEB
  // session's UID, while _getAccountIndex looks slots up by the EXTENSION
  // session's uid, minted separately by our own /auth/v4 login. Nothing
  // converts one to the other. Our own API requests do carry the header, but
  // they have tabId -1 and no documentUrl, so the listener no-opped on them.
  // And it was redundant regardless: the localStorage ps-* scan below produces
  // the same uid -> slot mapping from a stable source, and is the only
  // strategy that also clears stale entries.
  //
  // `webRequest` is among the most heavily weighted permissions in every
  // extension scanner, so holding it for a listener that produced nothing was
  // a poor trade.

  /**
   * Listen for Proton Mail tab loads only.
   *
   * A tabs.onUpdated listener wakes a stopped Firefox event page for EVERY
   * update in EVERY tab (title, favicon, audio, loading state), and each wake
   * cost a cold start. Firefox takes a filter that limits it to the status
   * changes of Proton Mail tabs. Chrome's tabs.onUpdated supports no filter
   * and throws when given one, so it keeps the unfiltered listener; the
   * handlers return at once for anything that is not a Proton tab.
   */
  function addProtonTabListener(listener) {
    try {
      browser.tabs.onUpdated.addListener(listener, {
        urls: ['*://mail.proton.me/*'],
        properties: ['status'],
      });
    } catch (e) {
      browser.tabs.onUpdated.addListener(listener);
    }
  }

  // When any Proton Mail tab finishes loading, scan all sessions from localStorage.
  addProtonTabListener((tabId, changeInfo, tab) => {
    if (changeInfo.status !== 'complete' || !tab.url) return;
    if (!tab.url.includes('mail.proton.me/u/')) return;
    // Debounce: don't scan more than once per 10 seconds
    const now = Date.now();
    if (now - _lastFullScanTime < 10000) return;
    _lastFullScanTime = now;
    _scanAllSessionsFromTab(tabId, 'Tab updated', tab.url);
    // The same moment is the only time the web client's ViewMode bucket is
    // reachable: re-check it, including accounts the last probe could not
    // resolve, since this load may have signed one in (throttled inside).
    if (typeof ProtonAccounts !== 'undefined' && ProtonAccounts.refreshWebViewModes) {
      ProtonAccounts.refreshWebViewModes(false, { afterTabLoad: true }).catch(() => {});
    }
  });

  /** Kick off startup scans (call once after init()). Listeners are already
   *  registered above; this just runs the scans that need account data. */
  function initListeners() {
    // On startup, try to scan from any already-open Proton Mail tab
    browser.tabs.query({ url: '*://mail.proton.me/*' }).then(tabs => {
      if (tabs.length > 0 && tabs[0].id) {
        _scanAllSessionsFromTab(tabs[0].id, 'Startup scan', tabs[0].url);
      }
    }).catch(() => {});
  }

  /** Actively rescan: open a Proton Mail tab, read localStorage, map accounts, close tab. */
  async function rescanUrlMapping() {
    const tab = await browser.tabs.create({ url: 'https://mail.proton.me', active: true });

    // Wait for the tab to finish loading (timeout 15s)
    await new Promise(resolve => {
      const listener = (tabId, changeInfo) => {
        if (tabId === tab.id && changeInfo.status === 'complete') {
          browser.tabs.onUpdated.removeListener(listener);
          resolve();
        }
      };
      browser.tabs.onUpdated.addListener(listener);
      setTimeout(() => { browser.tabs.onUpdated.removeListener(listener); resolve(); }, 15000);
    });

    // Small delay to let Proton's SPA fully initialize
    await new Promise(r => setTimeout(r, 2000));

    // Scan all ps-* sessions from localStorage
    const accounts = _getAccounts();
    try {
      const sessions = await ProtonScripting.executeInTab(tab.id, _readSessionsFromPage);

      // The tab has settled on a /u/N/ by now, which is ground truth for
      // whichever account it belongs to.
      let activeSlot = null;
      try {
        const loaded = await browser.tabs.get(tab.id);
        activeSlot = _slotFromUrl(loaded && loaded.url);
      } catch (_) { /* tab may already be gone */ }

      const { resolved, ambiguous } = _resolveSlots(
        Array.isArray(sessions) ? sessions : [], accounts, activeSlot);

      for (const [uid, slot] of resolved) _updateSlotMapping(uid, slot, true);

      // Unlike the passive scan, this one runs because the user pressed
      // "Refresh" and is owed a straight answer. An account we cannot resolve
      // has its mapping CLEARED, so Options shows it as "Fallback" and invites
      // a manual override, rather than leaving a stale value wearing an
      // "Auto-detected" badge it has not earned.
      const keep = new Set(resolved.keys());
      for (const acct of accounts) {
        if (!acct.uid || keep.has(acct.uid)) continue;
        if (_accountUrlMap[acct.uid] === undefined) continue;
        delete _accountUrlMap[acct.uid];
        const why = ambiguous.some(a => a.account.uid === acct.uid)
          ? 'ambiguous, several stale sessions' : 'no session found';
        debugLog('[ProtonUrlDetection] Rescan: cleared mapping for account', acct.id, '(' + why + ')');
      }

      browser.storage.local.set({ accountUrlMap: _accountUrlMap });
      debugLog('[ProtonUrlDetection] Rescan: mapped ' + resolved.size +
        ' account(s) from ' + (sessions || []).length + ' session(s)' +
        (ambiguous.length ? ' (' + ambiguous.length + ' ambiguous)' : ''));
    } catch (err) {
      console.warn('[ProtonUrlDetection] Rescan executeScript failed:', err.message);
    }

    return getAccountMapping();
  }

  /** Get the /u/N/ index for a given account ID, using detected/manual mapping. */
  function _getAccountIndex(accountId) {
    if (!accountId) return 0;
    const accounts = _getAccounts();
    const account = accounts.find(a => a.id === accountId);
    if (!account) return 0;

    // Manual override takes priority
    if (_manualUrlMap[accountId] !== undefined) return _manualUrlMap[accountId];

    // Auto-detected mapping by UID
    if (account.uid && _accountUrlMap[account.uid] !== undefined) {
      const entry = _accountUrlMap[account.uid];
      return typeof entry === 'object' ? entry.slot : entry;
    }

    // Fallback: position in extension's account list
    const idx = accounts.findIndex(a => a.id === accountId);
    return idx >= 0 ? idx : 0;
  }

  /** Get the full account-to-URL mapping state for the options UI. */
  function getAccountMapping() {
    const accounts = _getAccounts();
    return accounts.map(a => {
      const manualSlot = _manualUrlMap[a.id];
      const entry = (a.uid && _accountUrlMap[a.uid] !== undefined) ? _accountUrlMap[a.uid] : null;
      const detectedSlot = entry !== null ? (typeof entry === 'object' ? entry.slot : entry) : null;
      const detectedAt = entry !== null && typeof entry === 'object' ? entry.detectedAt : null;
      const fallbackSlot = accounts.indexOf(a);
      return {
        id: a.id,
        email: a.email,
        label: a.label || '',
        activeSlot: manualSlot !== undefined ? manualSlot : (detectedSlot !== null ? detectedSlot : fallbackSlot),
        detectedSlot,
        detectedAt,
        manualSlot: manualSlot !== undefined ? manualSlot : null,
        source: manualSlot !== undefined ? 'manual' : (detectedSlot !== null ? 'detected' : 'fallback'),
      };
    });
  }

  /** Set a manual URL mapping override for an account. Pass null to clear. */
  async function setAccountMapping(accountId, slot) {
    if (slot === null || slot === undefined) {
      delete _manualUrlMap[accountId];
    } else {
      _manualUrlMap[accountId] = parseInt(slot, 10);
    }
    await browser.storage.local.set({ manualUrlMap: _manualUrlMap });
  }

  /** Build a Proton Mail URL for a message/conversation. The element segment
   *  must match the WEB client's ViewMode: conversation-grouping accounts
   *  (ViewMode 0, Proton's default) route by ConversationID: a message ID
   *  there makes the web client fetch conversations/{id} and fail with
   *  "Conversation does not exist". Single-message accounts (ViewMode 1)
   *  route by message ID. Proton scopes ViewMode per client app, so prefer
   *  the web client's own bucket (account.webViewMode, detected via an open
   *  Proton tab) over the generic-client value; unknown → conversation form. */
  function getMailUrl(conversationId, accountId, messageId) {
    const n = _getAccountIndex(accountId);
    const base = `https://mail.proton.me/u/${n}/inbox`;
    const account = _findAccountBy(a => a.id === accountId);
    const viewMode = account
      ? (typeof account.webViewMode === 'number' ? account.webViewMode : account.viewMode)
      : null;
    const singleMode = viewMode === 1;
    if (!singleMode && conversationId) {
      // Optional third segment: auto-expands that message in the conversation.
      return messageId ? `${base}/${conversationId}/${messageId}` : `${base}/${conversationId}`;
    }
    if (messageId) return `${base}/${messageId}`;
    if (conversationId) return `${base}/${conversationId}`;
    return base;
  }

  /** Build a Proton Mail compose URL. */
  function getComposeUrl(accountId) {
    const n = _getAccountIndex(accountId);
    return `https://mail.proton.me/u/${n}/inbox#mailto=mailto:`;
  }

  return {
    init,
    initListeners,
    addProtonTabListener,
    rescanUrlMapping,
    getAccountMapping,
    setAccountMapping,
    getMailUrl,
    getComposeUrl,
  };
})();
