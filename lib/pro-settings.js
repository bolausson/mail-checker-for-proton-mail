/**
 * ProtonProSettings: which settings are Pro, and what applies without Premium.
 *
 * The rule: while the user is not Premium (the free plan, or after the trial
 * ended) every Pro setting acts as its default, as the popup themes always
 * did. What is stored is never changed or deleted, so the user's own choice
 * applies again the moment Premium starts (a trial, or a subscription).
 *
 * Without this, a choice made during the trial applied for good: the options
 * page locks the Pro controls for a free user, who then could not undo it.
 *
 * One list for every place that reads settings: the options page locks
 * exactly the controls in LOCKED_CONTROLS (its PREMIUM_ONLY_IDS), and the
 * popup and the background read settings through inEffect(), so a setting
 * locked on the page is out of effect everywhere else too. A new Pro control
 * goes into LOCKED_CONTROLS with the settings it edits, and
 * tests/pro-settings.test.js checks that against the options page.
 *
 * Pro state kept outside the settings follows the same rule where it is
 * read: the sync switch (syncInEffect below), Do Not Disturb (dnd.js
 * isActive) and the per-account settings (accounts.js _proSettingsApply).
 *
 * Loaded by the background (manifest), the popup, the options page and the
 * CAPTCHA page.
 */
const ProtonProSettings = (() => {
  'use strict';

  const _freezeArrays = (o) => {
    for (const v of Object.values(o)) if (Array.isArray(v)) Object.freeze(v);
    return Object.freeze(o);
  };

  /**
   * Every setting's default. A fresh install is also given theme 'hud'
   * (background.js _migrateSettings), which only shows with Premium.
   */
  const DEFAULTS = _freezeArrays({
    pollIntervalMinutes: 1,
    notificationsEnabled: true,
    notificationClickAction: 'openMessage',
    notificationSoundEnabled: false,
    notificationSound: 'chime',
    notificationVolume: 50,
    notificationPreviewText: true,
    badgeColor: '#6D4AFF',
    use24HourTime: false,
    maxEmailsPerAccount: 20,
    popupWidth: 420,
    popupHeight: 540,
    displayDensity: 'comfortable',
    senderDisplayFormat: 'name',
    previewLines: 0,
    autoMarkReadOnPreview: false,
    autoMarkReadOnReply: true,
    autoMarkReadOnArchive: false,
    autoMarkReadOnDelete: false,
    autoMarkReadOnSpam: false,
    autoMarkReadOnPhishing: false,
    autoMarkReadOnStar: false,
    autoMarkReadOnMoveToFolder: false,
    autoMarkReadOnLabel: false,
    hideSendArchive: false,
    prettifyRaw: false,
    imageAttachMode: 'attachment',
    autoAdvance: false,
    navCrossAccount: true,
    navWrap: false,
    visibleActions: ['openWeb', 'markRead', 'archive', 'snooze', 'delete'],
    actionOrder: ['openWeb', 'star', 'markRead', 'label', 'moveToFolder', 'archive', 'snooze', 'delete', 'deletePermanently', 'spam', 'phishing', 'headers', 'details', 'exportEml'],
    theme: 'classic',
    colorScheme: 'auto',
    customCSS: '',
    previewFormat: 'html',
    alwaysLoadExternalContent: false,
    loadSenderIconsAlways: false,
    senderIconFaviconFallback: false,
    emailCanvasHeuristic: true,
    codeDetectionEnabled: true,
    aiAssistantEnabled: true,
    codePatterns: [],
    notificationRules: [],
    composeMode: 'webui',
    composeFormat: 'html',
    replyFormat: 'plaintext',
    spellcheckLanguage: 'auto',
    language: 'en',
    hidePremiumUI: false,
    cacheEnabled: false,
    driveDefaultFolder: 'mcpm-shared-files',
    driveDefaultExpirationDays: 30,
    driveDefaultPermission: 'viewer',
  });

  /**
   * The options page controls that need Pro, each with the settings it
   * edits. An empty list is an action (export, import, sync now) or the sync
   * switch, which is a storage flag of its own (see syncInEffect).
   */
  const LOCKED_CONTROLS = Object.freeze({
    // General
    'poll-interval': ['pollIntervalMinutes'],
    'popup-width': ['popupWidth'],
    'popup-width-value': ['popupWidth'],
    'popup-height': ['popupHeight'],
    'popup-height-value': ['popupHeight'],
    'theme-select': ['theme'],
    'color-scheme': ['colorScheme'],
    'custom-css': ['customCSS'],
    'display-density': ['displayDensity'],
    'max-emails': ['maxEmailsPerAccount'],
    'sender-display': ['senderDisplayFormat'],
    'preview-lines': ['previewLines'],
    'use-24h-time': ['use24HourTime'],
    'preview-format': ['previewFormat'],
    'compose-mode': ['composeMode'],
    'compose-format': ['composeFormat'],
    'reply-format': ['replyFormat'],
    'spellcheck-language': ['spellcheckLanguage'],
    'badge-color': ['badgeColor'],
    // Notifications (customization only: the master switch stays free)
    'notification-click-action': ['notificationClickAction'],
    'notification-sound-enabled': ['notificationSoundEnabled'],
    'notification-sound': ['notificationSound'],
    'notification-volume': ['notificationVolume'],
    'notification-preview-text': ['notificationPreviewText'],
    // Behavior: all Pro
    'auto-mark-read-preview': ['autoMarkReadOnPreview'],
    'auto-mark-read-reply': ['autoMarkReadOnReply'],
    'auto-mark-read-archive': ['autoMarkReadOnArchive'],
    'auto-mark-read-delete': ['autoMarkReadOnDelete'],
    'auto-mark-read-spam': ['autoMarkReadOnSpam'],
    'auto-mark-read-phishing': ['autoMarkReadOnPhishing'],
    'auto-mark-read-star': ['autoMarkReadOnStar'],
    'auto-mark-read-move-to-folder': ['autoMarkReadOnMoveToFolder'],
    'auto-mark-read-label': ['autoMarkReadOnLabel'],
    'hide-send-archive': ['hideSendArchive'],
    'prettify-raw': ['prettifyRaw'],
    'image-attach-mode': ['imageAttachMode'],
    'auto-advance': ['autoAdvance'],
    'nav-cross-account': ['navCrossAccount'],
    'nav-wrap': ['navWrap'],
    'actions-sortable': ['visibleActions', 'actionOrder'],
    // Data: export, import and settings sync
    'sync-enabled': [],
    'btn-sync-now': [],
    'btn-export': [],
    'btn-import': [],
    // Misc
    'always-load-external': ['alwaysLoadExternalContent'],
    // Verification code customization (detection with the shipped patterns stays free)
    'code-detection-enabled': ['codeDetectionEnabled'],
    'code-patterns-list': ['codePatterns'],
    'code-pattern-name': ['codePatterns'],
    'code-pattern-regex': ['codePatterns'],
    'code-pattern-add-btn': ['codePatterns'],
    'code-pattern-reset-all': ['codePatterns'],
    // Quiet mail rules: the whole section
    'quiet-rules-list': ['notificationRules'],
    'quiet-rule-add-btn': ['notificationRules'],
  });

  /**
   * Pro settings that stay as stored without Premium. Both only shape the
   * Pro editors, which a free user reaches only through a draft restored
   * after the trial. The draft keeps its plain and its HTML text, and these
   * decide which of the two the editor shows: at their defaults an HTML
   * draft would open as an empty plain editor, its text seemingly lost.
   */
  const KEPT = Object.freeze(['replyFormat', 'composeFormat']);

  /**
   * The value in effect without Premium, where it is not the default: the
   * free plan checks for mail every 15 minutes and reads mail as plain text.
   * The options page shows these to a free user.
   */
  const FREE_VALUES = Object.freeze({
    pollIntervalMinutes: 15,
    previewFormat: 'plaintext',
  });

  /** Every setting a locked control edits. */
  const LOCKED_KEYS = Object.freeze([...new Set(Object.values(LOCKED_CONTROLS).flat())]);

  /** The settings that act as their free value without Premium. */
  const PRO_KEYS = Object.freeze(LOCKED_KEYS.filter((k) => !KEPT.includes(k)));

  // Arrays are copied, so no caller can reach into the frozen defaults.
  const _copy = (v) => (Array.isArray(v) ? v.slice() : v);

  /** What a Pro setting is without Premium. */
  function freeValue(key) {
    return _copy(Object.prototype.hasOwnProperty.call(FREE_VALUES, key) ? FREE_VALUES[key] : DEFAULTS[key]);
  }

  /**
   * The settings in effect: `stored` as it is with Premium, and without it
   * every Pro setting at its free value. Always a new object; `stored` is
   * left untouched.
   */
  function inEffect(stored, premium) {
    const out = { ...(stored || {}) };
    if (premium) return out;
    for (const key of PRO_KEYS) out[key] = freeValue(key);
    return out;
  }

  /**
   * `settings` with every setting a locked control edits taken from `stored`
   * (its default when nothing is stored). What the options page saves
   * without Premium: its locked controls show the values in effect, not the
   * user's own, and a free save must never overwrite the user's own.
   */
  function keepStored(settings, stored) {
    const out = { ...(settings || {}) };
    const s = stored || {};
    for (const key of LOCKED_KEYS) {
      out[key] = Object.prototype.hasOwnProperty.call(s, key) ? s[key] : _copy(DEFAULTS[key]);
    }
    return out;
  }

  /** Whether settings sync runs: it is Pro, so with Premium only. The
   *  stored switch (storage.local syncEnabled) is kept either way. */
  function syncInEffect(syncEnabled, premium) {
    return !!syncEnabled && !!premium;
  }

  return {
    DEFAULTS, LOCKED_CONTROLS, LOCKED_KEYS, PRO_KEYS, KEPT, FREE_VALUES,
    freeValue, inEffect, keepStored, syncInEffect,
  };
})();

if (typeof window !== 'undefined') window.ProtonProSettings = ProtonProSettings;
