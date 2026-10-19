/**
 * Desktop notification dispatch for new Proton Mail messages.
 * Supports configurable click actions and notification sounds.
 */

const ProtonNotifier = (() => {
  const _notifiedIds = new Set();
  const MAX_TRACKED_IDS = 200;

  // Map notification ID → { messageId, accountId } for click actions (a
  // multi-message notification has no single message: { accountId } only).
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

  // Load before writing: _persistNotifData writes the whole map, so without
  // the merge this worker would wipe entries other workers stored for
  // notifications still on screen. Saved before the notification exists, so
  // a teardown right after the create still leaves a clickable entry behind.
  async function _rememberNotification(notifId, data) {
    await _ensureDataLoaded();
    _notificationData.set(notifId, data);
    _trimNotificationData();
    await _persistNotifData();
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

    // Per-account notification switch. A Pro setting: without Premium it
    // stays stored (it applies again with Premium) but notifications are on.
    const premium = typeof ProtonPremium === 'undefined' || ProtonPremium.isPremium();
    if (accountId && premium) {
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
      await _rememberNotification(notifId, {
        messageId: msg.ID,
        accountId: accountId || msg._accountId,
      });

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

      // The account is in the id: accounts are polled in parallel, so two of
      // them can announce in the same millisecond, and a create under an id
      // already on screen replaces that notification.
      const notifId = 'proton-multi-' + (accountId ? accountId + '-' : '') + Date.now();
      // No single message to mark or archive, but the account to open.
      await _rememberNotification(notifId, { accountId: accountId || newMessages[0]._accountId });

      await browser.notifications.create(notifId, {
        type: 'basic',
        iconUrl: 'icons/icon-128.png',
        title,
        message,
      });
    }
  }

  // What a click needs loaded before it acts: Premium (the click action is a
  // Pro setting) and the accounts (the message to open, mark read or
  // archive). background.js hands it over (init). A click on a notification
  // from an earlier background wakes a new one and lands here at once,
  // before either is loaded: a Pro user's choice read as the free default.
  // Waited for, but never for long: a click must not hang on a stuck init.
  let _whenReady = null;
  const READY_WAIT_MS = 5000;

  function _readyForClick() {
    if (!_whenReady) return Promise.resolve();
    let timer;
    const late = new Promise((resolve) => { timer = setTimeout(resolve, READY_WAIT_MS); });
    const ready = Promise.resolve().then(_whenReady).catch(() => {});
    return Promise.race([ready, late]).finally(() => clearTimeout(timer));
  }

  async function handleClick(notificationId) {
    browser.notifications.clear(notificationId);

    await _readyForClick();
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

    // Each notification is for one account (the poller announces per
    // account). Without its id, getMailUrl resolves to /u/0/, so a click on a
    // second account's notification opened the first account's mailbox.
    const accountId = msgData ? msgData.accountId : undefined;

    switch (action) {
      case 'openInbox':
        browser.tabs.create({ url: ProtonAccounts.getMailUrl(null, accountId) });
        break;

      case 'openMessage':
        if (notificationId.startsWith('proton-conv-')) {
          // As the popup's "Open in Proton Mail": that account's session, the
          // conversation expanded at the message.
          const convId = notificationId.replace('proton-conv-', '');
          browser.tabs.create({
            url: ProtonAccounts.getMailUrl(convId, accountId, msgData ? msgData.messageId : undefined),
          });
        } else {
          browser.tabs.create({ url: ProtonAccounts.getMailUrl(null, accountId) });
        }
        break;

      case 'markRead':
        if (msgData && msgData.messageId) {
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
        if (msgData && msgData.messageId) {
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
   * account deleted/disabled server-side). The popup shows the matching
   * "Sign in" banner. A click acts as on a notification for several new
   * messages: that account's mailbox, no message to mark or archive. Without
   * the account it opened /u/0/, another account's mailbox.
   * @param {string} [accountId] - Account ID (for click actions).
   */
  async function notifyAuthError(accountEmail, reason, accountId) {
    if (_authErrorNotified.has(accountEmail)) return;
    _authErrorNotified.add(accountEmail);

    const s = await getSettings();
    if (s.notificationsEnabled === false) return;

    const body = reason === 'disabled'
      ? ProtonI18n.t('notifAccountDisabled')
      : ProtonI18n.t('notifSignInAgain');
    const notifId = `proton-autherror-${accountEmail}`;
    if (accountId) await _rememberNotification(notifId, { accountId });
    await browser.notifications.create(notifId, {
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

  /** @param {Function} [whenReady] resolves once a click can act (see _readyForClick). */
  function init(whenReady) {
    _whenReady = typeof whenReady === 'function' ? whenReady : null;
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
