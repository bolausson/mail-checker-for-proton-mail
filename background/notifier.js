/**
 * Desktop notification dispatch for new Proton Mail messages.
 * Supports configurable click actions and notification sounds.
 */

const ProtonNotifier = (() => {
  const _notifiedIds = new Set();
  const MAX_TRACKED_IDS = 200;

  // Map notification ID → { messageId, accountId } for click actions.
  // Held in memory AND in storage.session, because the notification outlives
  // the worker that created it: MV3 tears the background down after ~30s idle
  // while the OS keeps showing the notification for minutes (one created at
  // 20:40 was still listed by notifications.getAll() twenty minutes and
  // several worker generations later). A click then landed in a fresh worker
  // with an empty map, so the 'markRead' and 'archive' actions did nothing at
  // all: no action, no error, no toast.
  const _notificationData = new Map();
  const NOTIF_DATA_KEY = 'protonNotifData';
  // Entries are normally dropped only when the user clicks, so bound them.
  const MAX_NOTIF_DATA = 100;

  function _trimTrackedIds() {
    if (_notifiedIds.size > MAX_TRACKED_IDS) {
      const excess = _notifiedIds.size - MAX_TRACKED_IDS;
      const iter = _notifiedIds.values();
      for (let i = 0; i < excess; i++) {
        _notifiedIds.delete(iter.next().value);
      }
    }
  }

  // A Map iterates in insertion order, so dropping from the front evicts the
  // oldest notification first, the way _trimTrackedIds does for the ids.
  function _trimNotificationData() {
    while (_notificationData.size > MAX_NOTIF_DATA) {
      const oldest = _notificationData.keys().next();
      if (oldest.done) break;
      _notificationData.delete(oldest.value);
    }
  }

  // The set above also lives in storage.session (memory-only, this browser
  // run). MV3 tears the background down between polls, and a set held only in
  // memory started empty on every wake. Then any path that re-reads mail the
  // user was already told about announced it again: the full-fetch fallback
  // notifies the newest unread when the count rises, and an event page read
  // twice (a worker killed before it saved its cursor) re-delivers creates.
  const NOTIFIED_KEY = 'protonNotifiedIds';
  let _loaded = null;

  function _ensureLoaded() {
    if (!_loaded) {
      _loaded = (async () => {
        try {
          if (!browser.storage.session) return;
          const stored = await browser.storage.session.get(NOTIFIED_KEY);
          const ids = (stored && stored[NOTIFIED_KEY]) || [];
          // Stored ids first, so anything added in this worker stays newest
          // for the trim.
          const current = Array.from(_notifiedIds);
          _notifiedIds.clear();
          for (const id of ids) _notifiedIds.add(id);
          for (const id of current) _notifiedIds.add(id);
          _trimTrackedIds();
        } catch (_) { /* memory-only for this worker */ }
      })();
    }
    return _loaded;
  }

  async function _persist() {
    try {
      if (browser.storage.session) {
        await browser.storage.session.set({ [NOTIFIED_KEY]: Array.from(_notifiedIds) });
      }
    } catch (_) { /* best effort */ }
  }

  // Same trio for the click-action map. Kept separate from the ids above so
  // each stays a single-key read/write, and so a click only pays for the map
  // it actually needs.
  let _dataLoaded = null;

  function _ensureDataLoaded() {
    if (!_dataLoaded) {
      _dataLoaded = (async () => {
        try {
          if (!browser.storage.session) return;
          const stored = await browser.storage.session.get(NOTIF_DATA_KEY);
          const pairs = (stored && stored[NOTIF_DATA_KEY]) || [];
          // Stored entries first, so anything this worker just showed stays
          // newest for the trim.
          const current = Array.from(_notificationData.entries());
          _notificationData.clear();
          for (const pair of pairs) {
            if (pair && pair[0] && pair[1]) _notificationData.set(pair[0], pair[1]);
          }
          for (const [id, data] of current) _notificationData.set(id, data);
          _trimNotificationData();
        } catch (_) { /* memory-only for this worker */ }
      })();
    }
    return _dataLoaded;
  }

  async function _persistNotifData() {
    try {
      if (browser.storage.session) {
        await browser.storage.session.set({
          [NOTIF_DATA_KEY]: Array.from(_notificationData.entries()),
        });
      }
    } catch (_) { /* best effort */ }
  }

  // Uses the shared getSettings() from constants.js

  /**
   * Play a notification sound. Delegated to ProtonAudioBridge so a Chrome
   * MV3 service worker (which has no AudioContext) can route to an
   * offscreen document; on Firefox's event page it plays directly.
   */
  function playSound(soundName, volume) {
    return ProtonAudioBridge.playSound(soundName, volume);
  }

  /**
   * Show notifications for new messages.
   * @param {Array} messages - Message metadata objects from the API.
   * @param {string} [accountEmail] - Account email (shown when multiple accounts).
   * @param {string} [accountId] - Account ID (for click actions).
   */
  async function notifyNewMessages(messages, accountEmail, accountId) {
    if (ProtonDND.isActive()) return;

    const s = await getSettings();
    if (s.notificationsEnabled === false) return;
    if (!messages || messages.length === 0) return;

    // Check per-account notification setting
    if (accountId) {
      const account = ProtonAccounts.getAccount(accountId);
      if (account && account.notificationsEnabled === false) return;
    }

    await _ensureLoaded();
    const arrived = messages.filter(m => !_notifiedIds.has(m.ID));
    if (arrived.length === 0) return;

    // Mark everything that arrived as seen, including mail a quiet-mail rule
    // silences, so it can't resurface as "new" on a later poll. Saved before
    // anything is shown, so a teardown right after cannot repeat it.
    for (const m of arrived) {
      _notifiedIds.add(m.ID);
    }
    _trimTrackedIds();
    await _persist();

    // Quiet-mail rules (poller._applyNotificationRules) decided per message.
    const newMessages = arrived.filter(m => !(m._notifRule && m._notifRule.silence));
    const soundAllowed = arrived.some(m => !(m._notifRule && m._notifRule.mute));

    // Play sound: only for premium users; free tier uses the default
    // OS notification sound (or none, if the OS is silent). A rule can mute
    // it independently of the popup notification, so this is deliberately
    // keyed off everything that arrived, not just what we display.
    const premium = typeof ProtonPremium === 'undefined' || ProtonPremium.isPremium();
    if (premium && s.notificationSoundEnabled && soundAllowed) {
      playSound(s.notificationSound || 'chime', s.notificationVolume || 50);
    }

    if (newMessages.length === 0) return;

    const multiAccount = ProtonAccounts.getAccounts().length > 1;

    // The snippet for an announced message is fetched by poller.js when this
    // setting is on, independently of the popup's previewLines setting (which
    // defaults to 0 and used to gate the fetch, so this checkbox did nothing
    // out of the box). It stays optional: a body fetch can fail or the keys
    // can still be locked, and then the text below falls back to the subject.
    const showPreview = s.notificationPreviewText !== false;

    if (newMessages.length === 1) {
      const msg = newMessages[0];
      const sender = (msg.Sender && msg.Sender.Name) ||
                     (msg.Sender && msg.Sender.Address) || ProtonI18n.t('unknown');
      const subject = msg.Subject || ProtonI18n.t('noSubject');
      const title = multiAccount && accountEmail
        ? `${sender} (${accountEmail})`
        : sender;

      let message = subject;
      // Trimmed: a body that strips down to whitespace would otherwise add a
      // blank second line, and a missing/empty snippet leaves the subject
      // alone as the whole body.
      const snippet = showPreview && typeof msg._snippet === 'string'
        ? msg._snippet.trim()
        : '';
      if (snippet) {
        message = subject + '\n' + snippet;
      }

      const notifId = `proton-conv-${msg.ConversationID || msg.ID}`;
      // Load before writing: _persistNotifData writes the whole map, so
      // without the merge this worker would wipe entries other workers stored
      // for notifications still on screen.
      await _ensureDataLoaded();
      _notificationData.set(notifId, {
        messageId: msg.ID,
        accountId: accountId || msg._accountId,
      });
      _trimNotificationData();
      // Saved before the notification exists, so a teardown right after the
      // create still leaves a clickable entry behind.
      await _persistNotifData();

      await browser.notifications.create(notifId, {
        type: 'basic',
        iconUrl: 'icons/icon-128.png',
        title,
        message,
      });
    } else {
      const title = multiAccount && accountEmail
        ? `Proton Mail: ${accountEmail}`
        : 'Proton Mail';

      let message = ProtonI18n.t('newMessages', newMessages.length);
      if (showPreview) {
        const subjects = newMessages.slice(0, 3).map(m => m.Subject || ProtonI18n.t('noSubject'));
        message = subjects.join(', ');
        if (newMessages.length > 3) message += ' ' + ProtonI18n.t('andNMore', newMessages.length - 3);
      }

      const notifId = 'proton-multi-' + Date.now();
      await browser.notifications.create(notifId, {
        type: 'basic',
        iconUrl: 'icons/icon-128.png',
        title,
        message,
      });
    }
  }

  async function handleClick(notificationId) {
    browser.notifications.clear(notificationId);

    const s = await getSettings();
    // Free tier always uses the default 'openMessage' behavior; premium users
    // can customize (openInbox, openMessage, etc.) via settings.
    const premium = typeof ProtonPremium === 'undefined' || ProtonPremium.isPremium();
    const action = premium ? (s.notificationClickAction || 'openMessage') : 'openMessage';
    // The click usually arrives in a worker that never created this
    // notification, so the map has to come back from storage.session first.
    await _ensureDataLoaded();
    const msgData = _notificationData.get(notificationId);
    if (_notificationData.delete(notificationId)) {
      // Consumed: persist the deletion too, or a later worker would restore it.
      await _persistNotifData();
    }

    switch (action) {
      case 'openInbox':
        browser.tabs.create({ url: ProtonAccounts.getMailUrl() });
        break;

      case 'openMessage':
        if (notificationId.startsWith('proton-conv-')) {
          const convId = notificationId.replace('proton-conv-', '');
          browser.tabs.create({ url: ProtonAccounts.getMailUrl(convId) });
        } else {
          browser.tabs.create({ url: ProtonAccounts.getMailUrl() });
        }
        break;

      case 'markRead':
        if (msgData) {
          try {
            await ProtonAccounts.markAsRead(msgData.accountId, [msgData.messageId]);
            ProtonPoller.poll();
          } catch (e) {
            console.warn('[ProtonNotifier] Mark read failed:', e.message);
          }
        } else {
          // A multi-message notification names no single message, so there is
          // nothing to mark. Logged rather than failing silently.
          console.warn('[ProtonNotifier] No message data for', notificationId);
        }
        break;

      case 'archive':
        if (msgData) {
          try {
            await ProtonAccounts.archiveMessages(msgData.accountId, [msgData.messageId]);
            ProtonPoller.poll();
          } catch (e) {
            console.warn('[ProtonNotifier] Archive failed:', e.message);
          }
        } else {
          console.warn('[ProtonNotifier] No message data for', notificationId);
        }
        break;

      case 'none':
        break;
    }
  }

  // Track which accounts we've already alerted about, so a permanent auth
  // failure produces one notification, not one per poll cycle / SW lifetime.
  const _authErrorNotified = new Set();

  /**
   * One-time desktop notification when an account permanently loses its
   * session ('reauth': invalid refresh token) or access ('disabled':
   * account deleted/disabled server-side). Clicking opens nothing special:
   * the popup shows the matching "Sign in" banner.
   */
  async function notifyAuthError(accountEmail, reason) {
    if (_authErrorNotified.has(accountEmail)) return;
    _authErrorNotified.add(accountEmail);

    const s = await getSettings();
    if (s.notificationsEnabled === false) return;

    const body = reason === 'disabled'
      ? ProtonI18n.t('notifAccountDisabled')
      : ProtonI18n.t('notifSignInAgain');
    await browser.notifications.create(`proton-autherror-${accountEmail}`, {
      type: 'basic',
      iconUrl: 'icons/icon-128.png',
      title: accountEmail,
      message: body,
    });
  }

  async function seedNotifiedIds(messages) {
    await _ensureLoaded();
    for (const m of messages || []) {
      _notifiedIds.add(m.ID);
    }
    _trimTrackedIds();
    await _persist();
  }

  function init() {
    browser.notifications.onClicked.addListener(handleClick);
  }

  return {
    init,
    notifyNewMessages,
    notifyAuthError,
    seedNotifiedIds,
    playSound,
  };
})();
