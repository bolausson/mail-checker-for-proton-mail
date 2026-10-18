/**
 * Options page script for Proton Mail Checker.
 */

(function () {
  const DEFAULT_SETTINGS = {
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
  };

  // DOM refs
  const pollInterval = document.getElementById('poll-interval');
  const popupWidth = document.getElementById('popup-width');
  const popupWidthValue = document.getElementById('popup-width-value');
  const popupHeight = document.getElementById('popup-height');
  const popupHeightValue = document.getElementById('popup-height-value');
  const themeSelect = document.getElementById('theme-select');
  const colorSchemeSelect = document.getElementById('color-scheme');
  const customCSSInput = document.getElementById('custom-css');
  const displayDensity = document.getElementById('display-density');
  const maxEmails = document.getElementById('max-emails');
  const senderDisplay = document.getElementById('sender-display');
  const previewLines = document.getElementById('preview-lines');
  const use24hTime = document.getElementById('use-24h-time');
  const notificationsEnabled = document.getElementById('notifications-enabled');
  const notificationClickAction = document.getElementById('notification-click-action');
  const notificationSoundEnabled = document.getElementById('notification-sound-enabled');
  const notificationSound = document.getElementById('notification-sound');
  const notificationVolume = document.getElementById('notification-volume');
  const volumeValue = document.getElementById('volume-value');
  const btnTestSound = document.getElementById('btn-test-sound');
  const soundSettings = document.getElementById('sound-settings');
  const volumeSettings = document.getElementById('volume-settings');
  const notificationPreviewText = document.getElementById('notification-preview-text');
  const badgeColor = document.getElementById('badge-color');
  const badgeColorPreview = document.getElementById('badge-color-preview');
  const autoMarkReadPreview = document.getElementById('auto-mark-read-preview');
  const autoMarkReadReply = document.getElementById('auto-mark-read-reply');
  const autoMarkReadArchive = document.getElementById('auto-mark-read-archive');
  const autoMarkReadDelete = document.getElementById('auto-mark-read-delete');
  const autoMarkReadSpam = document.getElementById('auto-mark-read-spam');
  const autoMarkReadPhishing = document.getElementById('auto-mark-read-phishing');
  const autoMarkReadStar = document.getElementById('auto-mark-read-star');
  const autoMarkReadMoveToFolder = document.getElementById('auto-mark-read-move-to-folder');
  const autoMarkReadLabel = document.getElementById('auto-mark-read-label');
  const hideSendArchive = document.getElementById('hide-send-archive');
  const prettifyRaw = document.getElementById('prettify-raw');
  const imageAttachMode = document.getElementById('image-attach-mode');
  const autoAdvance = document.getElementById('auto-advance');
  const navCrossAccount = document.getElementById('nav-cross-account');
  const navWrap = document.getElementById('nav-wrap');
  const actionsSortable = document.getElementById('actions-sortable');
  const debugLogging = document.getElementById('debug-logging');
  const btnExportDiag = document.getElementById('btn-export-diag');
  const btnClearDiag = document.getElementById('btn-clear-diag');
  const clearDiagStatus = document.getElementById('clear-diag-status');
  const btnClearCache = document.getElementById('btn-clear-cache');
  const clearCacheStatus = document.getElementById('clear-cache-status');
  const cacheEnabledInput = document.getElementById('cache-enabled');
  const syncEnabled = document.getElementById('sync-enabled');
  const syncStatus = document.getElementById('sync-status');
  const btnSyncNow = document.getElementById('btn-sync-now');
  const alwaysLoadExternal = document.getElementById('always-load-external');
  const loadSenderIconsAlwaysInput = document.getElementById('load-sender-icons-always');
  const senderIconFaviconFallbackInput = document.getElementById('sender-icon-favicon-fallback');
  const emailCanvasHeuristicInput = document.getElementById('email-canvas-heuristic');
  const codeDetectionEnabledInput = document.getElementById('code-detection-enabled');
  const aiAssistantEnabledInput = document.getElementById('ai-assistant-enabled');
  const quietRulesList = document.getElementById('quiet-rules-list');
  const quietRuleCount = document.getElementById('quiet-rule-count');
  const quietRuleAddBtn = document.getElementById('quiet-rule-add-btn');
  const driveDefaultFolderInput = document.getElementById('drive-default-folder');
  const driveDefaultExpiration = document.getElementById('drive-default-expiration');
  const driveDefaultPermission = document.getElementById('drive-default-permission');
  const codePatternsList = document.getElementById('code-patterns-list');
  const codePatternCount = document.getElementById('code-pattern-count');
  const codePatternNameInput = document.getElementById('code-pattern-name');
  const codePatternRegexInput = document.getElementById('code-pattern-regex');
  const codePatternAddBtn = document.getElementById('code-pattern-add-btn');
  const codePatternResetAll = document.getElementById('code-pattern-reset-all');
  const previewFormat = document.getElementById('preview-format');
  const composeMode = document.getElementById('compose-mode');
  const composeFormat = document.getElementById('compose-format');
  const replyFormat = document.getElementById('reply-format');
  const spellcheckLanguage = document.getElementById('spellcheck-language');
  const languageSelect = document.getElementById('language');
  const hidePremiumUI = document.getElementById('hide-premium-ui');
  const statusEl = document.getElementById('status');

  // --- Sortable actions list ---
  const ALL_ACTION_DEFS = [
    { key: 'openWeb', i18nKey: 'openInProtonMail' },
    { key: 'star', i18nKey: 'star' },
    { key: 'markRead', i18nKey: 'markAsRead' },
    { key: 'label', i18nKey: 'labels' },
    { key: 'moveToFolder', i18nKey: 'moveToFolder' },
    { key: 'archive', i18nKey: 'archive' },
    { key: 'snooze', i18nKey: 'snooze' },
    { key: 'delete', i18nKey: 'delete' },
    { key: 'deletePermanently', i18nKey: 'deletePermanently' },
    { key: 'spam', i18nKey: 'moveToSpam' },
    { key: 'phishing', i18nKey: 'reportPhishing' },
    { key: 'headers', i18nKey: 'viewHeaders' },
    { key: 'details', i18nKey: 'messageDetails' },
    { key: 'exportEml', i18nKey: 'exportEml' },
  ];

  let _dragState = null;

  function _buildActionsList(order, visible) {
    actionsSortable.innerHTML = '';
    const visibleSet = new Set(visible);
    for (const key of order) {
      const def = ALL_ACTION_DEFS.find(d => d.key === key);
      if (!def) continue;
      const row = document.createElement('div');
      row.className = 'action-sort-item';
      row.dataset.key = key;

      const handle = document.createElement('span');
      handle.className = 'action-sort-handle';
      handle.innerHTML = '&#x2630;';
      handle.title = ProtonI18n.t('dragToReorder');

      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = visibleSet.has(key);
      cb.addEventListener('change', saveSettings);

      const lbl = document.createElement('span');
      lbl.className = 'action-sort-label';
      lbl.textContent = ProtonI18n.t(def.i18nKey);

      // Up/down buttons for reordering
      const btnWrap = document.createElement('span');
      btnWrap.className = 'action-sort-btns';

      const upBtn = document.createElement('button');
      upBtn.className = 'action-sort-arrow';
      upBtn.innerHTML = '&#x25B2;';
      upBtn.title = ProtonI18n.t('moveUp');
      upBtn.addEventListener('click', () => {
        const prev = row.previousElementSibling;
        if (prev) { prev.before(row); saveSettings(); }
      });

      const downBtn = document.createElement('button');
      downBtn.className = 'action-sort-arrow';
      downBtn.innerHTML = '&#x25BC;';
      downBtn.title = ProtonI18n.t('moveDown');
      downBtn.addEventListener('click', () => {
        const next = row.nextElementSibling;
        if (next) { next.after(row); saveSettings(); }
      });

      btnWrap.appendChild(upBtn);
      btnWrap.appendChild(downBtn);

      row.appendChild(handle);
      row.appendChild(cb);
      row.appendChild(lbl);
      row.appendChild(btnWrap);

      // Mouse-based drag reordering via handle
      handle.addEventListener('mousedown', (e) => {
        e.preventDefault();
        const startY = e.clientY;
        const rowHeight = row.offsetHeight + 2; // include gap
        _dragState = { row, startY, moved: false };
        row.classList.add('dragging');

        const onMouseMove = (ev) => {
          if (!_dragState) return;
          const dy = ev.clientY - _dragState.startY;
          _dragState.moved = true;
          row.style.transform = 'translateY(' + dy + 'px)';
          row.style.zIndex = '10';

          // Determine which sibling to swap with
          const items = [...actionsSortable.children];
          const idx = items.indexOf(row);
          if (dy < -rowHeight / 2 && idx > 0) {
            items[idx - 1].before(row);
            _dragState.startY -= rowHeight;
          } else if (dy > rowHeight / 2 && idx < items.length - 1) {
            items[idx + 1].after(row);
            _dragState.startY += rowHeight;
          }
        };

        const onMouseUp = () => {
          document.removeEventListener('mousemove', onMouseMove);
          document.removeEventListener('mouseup', onMouseUp);
          row.classList.remove('dragging');
          row.style.transform = '';
          row.style.zIndex = '';
          if (_dragState && _dragState.moved) saveSettings();
          _dragState = null;
        };

        document.addEventListener('mousemove', onMouseMove);
        document.addEventListener('mouseup', onMouseUp);
      });

      actionsSortable.appendChild(row);
    }
  }

  function _getActionOrder() {
    return [...actionsSortable.querySelectorAll('.action-sort-item')].map(el => el.dataset.key);
  }

  function _getVisibleActions() {
    const result = [];
    for (const row of actionsSortable.querySelectorAll('.action-sort-item')) {
      const cb = row.querySelector('input[type="checkbox"]');
      if (cb && cb.checked) result.push(row.dataset.key);
    }
    return result;
  }

  function updateSoundVisibility() {
    const show = notificationSoundEnabled.checked;
    soundSettings.style.display = show ? '' : 'none';
    volumeSettings.style.display = show ? '' : 'none';
  }

  /** Apply color scheme to the options page itself. */
  function _applyColorScheme(scheme) {
    let resolved = scheme;
    if (scheme === 'auto') {
      resolved = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    }
    document.body.setAttribute('data-color-scheme', resolved);
  }

  // Live-update when OS theme changes (for "auto" mode)
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if (colorSchemeSelect.value === 'auto') _applyColorScheme('auto');
  });

  // Live-update when color scheme select changes
  colorSchemeSelect.addEventListener('change', () => {
    _applyColorScheme(colorSchemeSelect.value);
  });

  /** Load saved settings into the form. */
  /** Show a transient message in the main status element, then clear it. */
  function showStatus(text, ms = 2000) {
    statusEl.textContent = text;
    setTimeout(() => { statusEl.textContent = ''; }, ms);
  }

  /**
   * Collect the { settings, accountSettings } payload pushed to sync storage.
   * Shared by the sync-enable toggle and the "Sync now" button.
   */
  async function _collectSyncData() {
    const stored = await browser.storage.local.get('settings');
    const accountSettings = await browser.runtime.sendMessage({ type: 'GET_ACCOUNT_SETTINGS_EXPORT' });
    const syncData = {};
    if (stored.settings) syncData.settings = stored.settings;
    if (accountSettings) syncData.accountSettings = accountSettings;
    return syncData;
  }

  async function loadSettings() {
    const localData = await browser.storage.local.get(['settings', 'syncEnabled', 'debugLogging']);
    const isSyncEnabled = !!localData.syncEnabled;
    syncEnabled.checked = isSyncEnabled;
    debugLogging.checked = !!localData.debugLogging;

    let stored = localData;
    if (isSyncEnabled) {
      try {
        const synced = await browser.storage.sync.get(['settings', 'accountSettings']);
        if (synced.settings) stored = synced;
        // Apply synced account settings (label, color, initials, folders, etc.)
        if (synced.accountSettings) {
          await browser.runtime.sendMessage({
            type: 'IMPORT_ACCOUNT_SETTINGS',
            accountSettings: synced.accountSettings,
          });
        }
      } catch (e) { /* sync not available, fall back to local */ }
    }
    const s = { ...DEFAULT_SETTINGS, ...stored.settings };

    pollInterval.value = String(s.pollIntervalMinutes);
    popupWidth.value = s.popupWidth;
    popupWidthValue.value = s.popupWidth;
    popupHeight.value = s.popupHeight;
    popupHeightValue.value = s.popupHeight;
    themeSelect.value = s.theme || 'classic';
    colorSchemeSelect.value = s.colorScheme || 'auto';
    customCSSInput.value = s.customCSS || '';
    _applyColorScheme(s.colorScheme || 'auto');
    displayDensity.value = s.displayDensity;
    maxEmails.value = String(s.maxEmailsPerAccount);
    senderDisplay.value = s.senderDisplayFormat;
    previewLines.value = String(s.previewLines || 0);
    use24hTime.checked = s.use24HourTime;
    hidePremiumUI.checked = !!s.hidePremiumUI;
    cacheEnabledInput.checked = !!s.cacheEnabled;
    notificationsEnabled.checked = s.notificationsEnabled;
    notificationClickAction.value = s.notificationClickAction;
    notificationSoundEnabled.checked = s.notificationSoundEnabled;
    notificationSound.value = s.notificationSound;
    notificationVolume.value = s.notificationVolume;
    volumeValue.textContent = s.notificationVolume + '%';
    notificationPreviewText.checked = s.notificationPreviewText;
    badgeColor.value = s.badgeColor;
    badgeColorPreview.style.background = s.badgeColor;
    autoMarkReadPreview.checked = s.autoMarkReadOnPreview;
    autoMarkReadReply.checked = s.autoMarkReadOnReply;
    autoMarkReadArchive.checked = s.autoMarkReadOnArchive;
    autoMarkReadDelete.checked = s.autoMarkReadOnDelete;
    autoMarkReadSpam.checked = s.autoMarkReadOnSpam;
    autoMarkReadPhishing.checked = s.autoMarkReadOnPhishing;
    autoMarkReadStar.checked = s.autoMarkReadOnStar;
    autoMarkReadMoveToFolder.checked = s.autoMarkReadOnMoveToFolder;
    autoMarkReadLabel.checked = s.autoMarkReadOnLabel;
    hideSendArchive.checked = s.hideSendArchive;
    prettifyRaw.checked = s.prettifyRaw;
    imageAttachMode.value = s.imageAttachMode || 'attachment';
    autoAdvance.checked = s.autoAdvance;
    navCrossAccount.checked = s.navCrossAccount !== false;
    navWrap.checked = !!s.navWrap;
    spellcheckLanguage.value = s.spellcheckLanguage || 'auto';
    languageSelect.value = s.language || 'en';
    if (typeof ProtonI18n !== 'undefined') {
      ProtonI18n.setLanguage(s.language || 'en');
    }

    const va = s.visibleActions || DEFAULT_SETTINGS.visibleActions;
    const ao = s.actionOrder || DEFAULT_SETTINGS.actionOrder;
    // Ensure any new actions not in saved order are appended
    const allKeys = ALL_ACTION_DEFS.map(d => d.key);
    const fullOrder = [...ao, ...allKeys.filter(k => !ao.includes(k))];
    _buildActionsList(fullOrder, va);
    previewFormat.value = s.previewFormat || 'html';
    alwaysLoadExternal.checked = !!s.alwaysLoadExternalContent;
    loadSenderIconsAlwaysInput.checked = !!s.loadSenderIconsAlways;
    senderIconFaviconFallbackInput.checked = !!s.senderIconFaviconFallback;
    emailCanvasHeuristicInput.checked = s.emailCanvasHeuristic !== false;
    codeDetectionEnabledInput.checked = s.codeDetectionEnabled !== false;
    aiAssistantEnabledInput.checked = s.aiAssistantEnabled !== false;
    _codePatternsState = Array.isArray(s.codePatterns) ? s.codePatterns.map((p) => ({ ...p })) : [];
    _renderCodePatterns();
    _quietRulesState = Array.isArray(s.notificationRules)
      ? s.notificationRules.map((r) => ProtonNotificationRules.normalize(r)) : [];
    _renderQuietRules();
    composeMode.value = s.composeMode || 'webui';
    composeFormat.value = s.composeFormat || 'html';
    replyFormat.value = s.replyFormat || 'html';
    driveDefaultFolderInput.value = s.driveDefaultFolder || DEFAULT_SETTINGS.driveDefaultFolder;
    driveDefaultExpiration.value = String(
      typeof s.driveDefaultExpirationDays === 'number' ? s.driveDefaultExpirationDays : 30);
    driveDefaultPermission.value = s.driveDefaultPermission === 'editor' ? 'editor' : 'viewer';
    if (typeof ProtonI18n !== 'undefined') {
      ProtonI18n.applyTranslations();
    }
    updateSoundVisibility();
  }

  /** Save current form values to storage and notify background. */
  async function saveSettings() {
    const settings = {
      pollIntervalMinutes: parseInt(pollInterval.value, 10),
      popupWidth: parseInt(popupWidth.value, 10),
      popupHeight: parseInt(popupHeight.value, 10),
      theme: themeSelect.value,
      colorScheme: colorSchemeSelect.value,
      customCSS: customCSSInput.value,
      displayDensity: displayDensity.value,
      maxEmailsPerAccount: parseInt(maxEmails.value, 10),
      senderDisplayFormat: senderDisplay.value,
      previewLines: parseInt(previewLines.value, 10),
      use24HourTime: use24hTime.checked,
      notificationsEnabled: notificationsEnabled.checked,
      notificationClickAction: notificationClickAction.value,
      notificationSoundEnabled: notificationSoundEnabled.checked,
      notificationSound: notificationSound.value,
      notificationVolume: parseInt(notificationVolume.value, 10),
      notificationPreviewText: notificationPreviewText.checked,
      badgeColor: badgeColor.value,
      autoMarkReadOnPreview: autoMarkReadPreview.checked,
      autoMarkReadOnReply: autoMarkReadReply.checked,
      autoMarkReadOnArchive: autoMarkReadArchive.checked,
      autoMarkReadOnDelete: autoMarkReadDelete.checked,
      autoMarkReadOnSpam: autoMarkReadSpam.checked,
      autoMarkReadOnPhishing: autoMarkReadPhishing.checked,
      autoMarkReadOnStar: autoMarkReadStar.checked,
      autoMarkReadOnMoveToFolder: autoMarkReadMoveToFolder.checked,
      autoMarkReadOnLabel: autoMarkReadLabel.checked,
      hideSendArchive: hideSendArchive.checked,
      prettifyRaw: prettifyRaw.checked,
      imageAttachMode: imageAttachMode.value,
      autoAdvance: autoAdvance.checked,
      navCrossAccount: navCrossAccount.checked,
      navWrap: navWrap.checked,
      visibleActions: _getVisibleActions(),
      actionOrder: _getActionOrder(),
      previewFormat: previewFormat.value,
      alwaysLoadExternalContent: alwaysLoadExternal.checked,
      loadSenderIconsAlways: loadSenderIconsAlwaysInput.checked,
      senderIconFaviconFallback: senderIconFaviconFallbackInput.checked,
      emailCanvasHeuristic: emailCanvasHeuristicInput.checked,
      codeDetectionEnabled: codeDetectionEnabledInput.checked,
      aiAssistantEnabled: aiAssistantEnabledInput.checked,
      codePatterns: _codePatternsState,
      notificationRules: _quietRulesState.map((r) => ProtonNotificationRules.normalize(r)),
      composeMode: composeMode.value,
      composeFormat: composeFormat.value,
      replyFormat: replyFormat.value,
      spellcheckLanguage: spellcheckLanguage.value,
      language: languageSelect.value,
      hidePremiumUI: hidePremiumUI.checked,
      cacheEnabled: cacheEnabledInput.checked,
      // Folder path is sanitized (empty → default); '/' separates subfolders.
      driveDefaultFolder: driveDefaultFolderInput.value
        .split('/').map((p) => p.trim()).filter(Boolean).join('/') ||
        DEFAULT_SETTINGS.driveDefaultFolder,
      driveDefaultExpirationDays: parseInt(driveDefaultExpiration.value, 10) || 0,
      driveDefaultPermission: driveDefaultPermission.value === 'editor' ? 'editor' : 'viewer',
    };

    await browser.storage.local.set({ settings });

    // Also write to sync storage if enabled
    const localData = await browser.storage.local.get('syncEnabled');
    if (localData.syncEnabled) {
      try {
        await browser.storage.sync.set({ settings });
        await _updateSyncTimestamp();
      } catch (e) { /* sync storage may not be available */ }
    }

    browser.runtime.sendMessage({ type: 'SETTINGS_CHANGED' });

    // Re-apply translations if language changed
    if (typeof ProtonI18n !== 'undefined') {
      ProtonI18n.setLanguage(settings.language || 'en');
      ProtonI18n.applyTranslations();
      // Rebuild action labels with new language
      _buildActionsList(_getActionOrder(), _getVisibleActions());
    }

    showStatus(ProtonI18n.t('settingsSaved'));
  }

  // Save on any change
  const inputs = [
    pollInterval, popupWidth, popupHeight, displayDensity, maxEmails, senderDisplay, previewLines, use24hTime,
    notificationsEnabled, notificationClickAction,
    notificationSoundEnabled, notificationSound,
    notificationVolume, notificationPreviewText, badgeColor,
    autoMarkReadPreview, autoMarkReadReply,
    autoMarkReadArchive, autoMarkReadDelete, autoMarkReadSpam,
    autoMarkReadPhishing, autoMarkReadStar, autoMarkReadMoveToFolder, autoMarkReadLabel,
    hideSendArchive, prettifyRaw, imageAttachMode, autoAdvance, navCrossAccount, navWrap,
    themeSelect, colorSchemeSelect, customCSSInput,
    alwaysLoadExternal, loadSenderIconsAlwaysInput, senderIconFaviconFallbackInput, emailCanvasHeuristicInput, codeDetectionEnabledInput, aiAssistantEnabledInput,
    previewFormat, composeMode, composeFormat, replyFormat, spellcheckLanguage, languageSelect,
    hidePremiumUI,
    driveDefaultFolderInput, driveDefaultExpiration, driveDefaultPermission,
  ];
  for (const input of inputs) {
    input.addEventListener('change', saveSettings);
  }

  // Download current CSS as template
  document.getElementById('btn-download-css').addEventListener('click', async () => {
    try {
      const cssUrl = browser.runtime.getURL('popup/popup.css');
      const resp = await fetch(cssUrl);
      const css = await resp.text();
      const blob = new Blob([css], { type: 'text/css' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'popup-theme-template.css';
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      /* ignore */
    }
  });

  // Slider ↔ number input sync
  popupWidth.addEventListener('input', () => {
    popupWidthValue.value = popupWidth.value;
  });
  popupWidthValue.addEventListener('input', () => {
    const v = Math.min(800, Math.max(350, parseInt(popupWidthValue.value, 10) || 350));
    popupWidth.value = v;
  });
  popupWidthValue.addEventListener('change', () => {
    const v = Math.min(800, Math.max(350, parseInt(popupWidthValue.value, 10) || 350));
    popupWidthValue.value = v;
    popupWidth.value = v;
    saveSettings();
  });

  popupHeight.addEventListener('input', () => {
    popupHeightValue.value = popupHeight.value;
  });
  popupHeightValue.addEventListener('input', () => {
    const v = Math.min(600, Math.max(300, parseInt(popupHeightValue.value, 10) || 300));
    popupHeight.value = v;
  });
  popupHeightValue.addEventListener('change', () => {
    const v = Math.min(600, Math.max(300, parseInt(popupHeightValue.value, 10) || 300));
    popupHeightValue.value = v;
    popupHeight.value = v;
    saveSettings();
  });

  notificationVolume.addEventListener('input', () => {
    volumeValue.textContent = notificationVolume.value + '%';
  });

  // Badge color preview
  badgeColor.addEventListener('input', () => {
    badgeColorPreview.style.background = badgeColor.value;
  });

  // Sound toggle: show/hide sub-settings
  notificationSoundEnabled.addEventListener('change', updateSoundVisibility);

  // Test sound button
  btnTestSound.addEventListener('click', () => {
    browser.runtime.sendMessage({
      type: 'TEST_SOUND',
      sound: notificationSound.value,
      volume: parseInt(notificationVolume.value, 10),
    });
  });

  // --- Sync ---

  async function _updateSyncTimestamp() {
    const now = new Date().toISOString();
    await browser.storage.local.set({ lastSyncTime: now });
    _displaySyncTime(now);
  }

  function _displaySyncTime(isoString) {
    if (!isoString) {
      syncStatus.textContent = '';
      return;
    }
    try {
      const d = new Date(isoString);
      syncStatus.textContent = ProtonI18n.t('lastSynced') + ': ' +
        d.toLocaleDateString() + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    } catch (e) {
      syncStatus.textContent = '';
    }
  }

  debugLogging.addEventListener('change', () => {
    browser.storage.local.set({ debugLogging: debugLogging.checked });
  });

  // Export the persistent auth/session diagnostic log (background ProtonDiag,
  // stored in storage.local so it survives service-worker death + browser
  // restarts) as a plain-text file. Contains token *fingerprints* only.
  btnExportDiag.addEventListener('click', async () => {
    const stored = await browser.storage.local.get('_authDiag');
    const log = stored._authDiag || [];
    const lines = log.map((e) => {
      const { t, event, ...rest } = e;
      const extra = Object.keys(rest).map((k) => `${k}=${rest[k]}`).join(' ');
      return `${t}  ${event}  ${extra}`.trimEnd();
    });
    // Environment goes in the header because support cannot ask for it later:
    // by the time a log arrives, the answer is a round trip away. "Chromium
    // fork" matters specifically, see lib/browser-info.js. The extension
    // version is here too, so nobody has to scan the body for "Starting v..."
    // to notice the user is on an older build than they think.
    let env = { summary: 'unknown', userAgent: '' };
    try {
      env = await ProtonBrowserInfo.detect();
    } catch (e) { /* an unknown environment must not block the export */ }
    let extVersion = '';
    try {
      extVersion = (browser.runtime.getManifest() || {}).version || '';
    } catch (e) { /* likewise */ }
    // What each account monitors, stated at export time. The background also
    // logs it when it changes, but a busy log rolls that entry out of the
    // ring buffer, and a stored folder the picker cannot show is exactly the
    // kind of thing nobody knows to mention. Read from storage (these fields
    // are stored in the clear), not asked of the background: a stuck
    // background is precisely when this log is wanted, and it must not wait.
    let monitorLines = '';
    try {
      const { protonAccounts } = await browser.storage.local.get('protonAccounts');
      if (Array.isArray(protonAccounts)) {
        monitorLines = protonAccounts.map(a =>
          'Monitor ' + a.email + ': ' + ProtonMonitoredIds.describe(a) + '\n').join('');
      }
    } catch (e) { /* an unreadable account list must not block the export */ }
    const header = 'Mail Checker for Proton Mail: diagnostic log\n' +
      'Exported: ' + new Date().toISOString() + '\n' +
      'Extension: ' + (extVersion || 'unknown') + '\n' +
      'Browser: ' + env.summary + '\n' +
      // Raw, because every parse above can be wrong or missing, and this is
      // what lets a human settle it.
      'User agent: ' + (env.userAgent || 'unknown') + '\n' +
      monitorLines +
      'Entries: ' + log.length + '\n\n';
    const blob = new Blob([header + lines.join('\n') + '\n'], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    const now = new Date();
    const ts = now.getFullYear().toString() +
      String(now.getMonth() + 1).padStart(2, '0') +
      String(now.getDate()).padStart(2, '0') + '-' +
      String(now.getHours()).padStart(2, '0') +
      String(now.getMinutes()).padStart(2, '0');
    a.download = 'mcpm-diagnostic-' + ts + '.txt';
    a.click();
    URL.revokeObjectURL(url);
  });

  btnClearDiag.addEventListener('click', async () => {
    // Clearing an already-empty log looks identical to the button doing
    // nothing, so say so either way. Mirrors the Clear cache row below.
    btnClearDiag.disabled = true;
    try {
      // Reset the once() signatures with the log (background/diag.js clear()).
      // Otherwise facts reported only on change (plan, quiet rules, monitored
      // folders) are never written again, and "clear, reproduce, export"
      // yields a log missing exactly those.
      await browser.storage.local.set({ _authDiag: [], _diagSigs: {} });
      clearDiagStatus.textContent = ProtonI18n.t('diagLogCleared');
    } catch (e) {
      clearDiagStatus.textContent = ProtonI18n.t('diagLogClearFailed');
    } finally {
      btnClearDiag.disabled = false;
    }
    setTimeout(() => { clearDiagStatus.textContent = ''; }, 4000);
  });

  btnClearCache.addEventListener('click', async () => {
    btnClearCache.disabled = true;
    try {
      await browser.runtime.sendMessage({ type: 'CLEAR_MSG_CACHE' });
      clearCacheStatus.textContent = ProtonI18n.t('cacheCleared');
    } catch (e) {
      clearCacheStatus.textContent = '';
    } finally {
      btnClearCache.disabled = false;
    }
    setTimeout(() => { clearCacheStatus.textContent = ''; }, 4000);
  });

  // The "Enable cache" toggle is handled separately from the generic settings
  // inputs so we can guarantee the setting is persisted BEFORE the background
  // reacts (writing/wiping the on-disk cache reads the just-saved value).
  cacheEnabledInput.addEventListener('change', async () => {
    await saveSettings();
    browser.runtime.sendMessage({
      type: 'SET_CACHE_ENABLED',
      enabled: cacheEnabledInput.checked,
    });
  });

  // Load and display last sync time on startup, disable button if sync off
  browser.storage.local.get('lastSyncTime').then(data => {
    btnSyncNow.disabled = !syncEnabled.checked;
    if (data.lastSyncTime && syncEnabled.checked) _displaySyncTime(data.lastSyncTime);
  });

  syncEnabled.addEventListener('change', async () => {
    const enabled = syncEnabled.checked;
    btnSyncNow.disabled = !enabled;
    await browser.storage.local.set({ syncEnabled: enabled });
    if (enabled) {
      // Push current settings + per-account settings to sync
      const syncData = await _collectSyncData();
      try { await browser.storage.sync.set(syncData); } catch (e) { /* sync storage may not be available */ }
      // Also backfill the premium license state (its _save only mirrors to
      // sync while the toggle is on, so an earlier activation never reached it)
      browser.runtime.sendMessage({ type: 'PREMIUM_RESYNC' }).catch(() => {});
      await _updateSyncTimestamp();
      showStatus(ProtonI18n.t('syncEnabled'));
    } else {
      syncStatus.textContent = '';
      showStatus(ProtonI18n.t('syncDisabled'));
    }
  });

  // Listen for sync changes from other devices
  browser.storage.onChanged.addListener((changes, area) => {
    if (area !== 'sync') return;
    browser.storage.local.get('syncEnabled').then(data => {
      if (!data.syncEnabled) return;
      _updateSyncTimestamp();
      if (changes.settings) {
        browser.storage.local.set({ settings: changes.settings.newValue }).then(() => {
          loadSettings();
          browser.runtime.sendMessage({ type: 'SETTINGS_CHANGED' });
        });
      }
      if (changes.accountSettings) {
        browser.runtime.sendMessage({
          type: 'IMPORT_ACCOUNT_SETTINGS',
          accountSettings: changes.accountSettings.newValue,
        });
      }
    });
  });

  // Sync now button: force push current settings to sync storage
  btnSyncNow.addEventListener('click', async () => {
    if (!syncEnabled.checked) {
      syncStatus.textContent = ProtonI18n.t('syncDisabled');
      return;
    }
    btnSyncNow.disabled = true;
    const origText = btnSyncNow.textContent;
    btnSyncNow.textContent = '...';
    try {
      const syncData = await _collectSyncData();
      await browser.storage.sync.set(syncData);
      await _updateSyncTimestamp();
      syncStatus.textContent += ' \u2705';
    } catch (e) {
      syncStatus.textContent = ProtonI18n.t('syncFailed');
    }
    btnSyncNow.textContent = origText;
    btnSyncNow.disabled = false;
  });

  // --- Export / Import ---

  const btnExport = document.getElementById('btn-export');
  const btnImport = document.getElementById('btn-import');
  const importFile = document.getElementById('import-file');
  const exportImportStatus = document.getElementById('export-import-status');

  function _formatTimestamp(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    return d.toLocaleDateString() + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  function _updateExportImportStatus() {
    browser.storage.local.get(['lastExportTime', 'lastImportTime']).then(data => {
      const parts = [];
      if (data.lastExportTime) parts.push(ProtonI18n.t('lastExported') + ': ' + _formatTimestamp(data.lastExportTime));
      if (data.lastImportTime) parts.push(ProtonI18n.t('lastImported') + ': ' + _formatTimestamp(data.lastImportTime));
      exportImportStatus.textContent = parts.join('  \u00B7  ');
    });
  }
  _updateExportImportStatus();

  btnExport.addEventListener('click', async () => {
    const stored = await browser.storage.local.get('settings');
    const accountSettings = await browser.runtime.sendMessage({ type: 'GET_ACCOUNT_SETTINGS_EXPORT' });
    const exportData = {
      settings: stored.settings || {},
      accountSettings: accountSettings || {},
    };
    const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    const now = new Date();
    const ts = now.getFullYear().toString() +
      String(now.getMonth() + 1).padStart(2, '0') +
      String(now.getDate()).padStart(2, '0') + '-' +
      String(now.getHours()).padStart(2, '0') +
      String(now.getMinutes()).padStart(2, '0') +
      String(now.getSeconds()).padStart(2, '0');
    a.download = 'proton-mail-checker-settings-' + ts + '.json';
    a.click();
    URL.revokeObjectURL(url);
    await browser.storage.local.set({ lastExportTime: new Date().toISOString() });
    _updateExportImportStatus();
  });

  btnImport.addEventListener('click', () => {
    importFile.click();
  });

  importFile.addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const text = await file.text();
      const imported = JSON.parse(text);
      if (typeof imported !== 'object' || imported === null) throw new Error('Invalid format');

      // Support both new format (with accountSettings) and legacy (flat settings)
      const globalSettings = imported.settings || imported;
      const accountSettings = imported.accountSettings || null;

      const merged = { ...DEFAULT_SETTINGS, ...globalSettings };
      await browser.storage.local.set({ settings: merged });
      browser.runtime.sendMessage({ type: 'SETTINGS_CHANGED' });

      if (accountSettings) {
        await browser.runtime.sendMessage({
          type: 'IMPORT_ACCOUNT_SETTINGS',
          accountSettings,
        });
      }

      // Also update sync storage so synced data matches the import
      const localSync = await browser.storage.local.get('syncEnabled');
      if (localSync.syncEnabled) {
        try {
          const syncData = { settings: merged };
          if (accountSettings) syncData.accountSettings = accountSettings;
          await browser.storage.sync.set(syncData);
          await _updateSyncTimestamp();
        } catch (e) { /* sync storage may not be available */ }
      }

      await loadSettings();
      await browser.storage.local.set({ lastImportTime: new Date().toISOString() });
      _updateExportImportStatus();
    } catch (err) {
      showStatus(ProtonI18n.t('importFailed') + ': ' + err.message, 3000);
    }
    importFile.value = '';
  });

  // --- Reset to Defaults ---

  document.getElementById('btn-reset').addEventListener('click', async () => {
    if (!await ProtonDialog.confirm(ProtonI18n.t('resetConfirm'),
      { confirmLabel: ProtonI18n.t('resetToDefaults'), danger: true,
        anchor: document.getElementById('btn-reset') })) return;
    // Reset global settings
    await browser.storage.local.set({ settings: { ...DEFAULT_SETTINGS } });
    if (syncEnabled.checked) {
      await browser.storage.sync.set({ settings: { ...DEFAULT_SETTINGS } });
    }
    // Reset per-account settings (label, initials, color, notifications, folders)
    const accounts = await browser.runtime.sendMessage({ type: 'GET_ACCOUNTS' });
    if (accounts && Array.isArray(accounts)) {
      for (const acc of accounts) {
        await browser.runtime.sendMessage({
          type: 'UPDATE_ACCOUNT_SETTINGS',
          accountId: acc.id,
          settings: {
            label: '',
            initials: '',
            color: '',
            notificationsEnabled: true,
            folderMode: 'inbox',
            monitoredFolders: [],
            monitoredLabels: [],
          },
        });
      }
    }
    await browser.runtime.sendMessage({ type: 'SETTINGS_CHANGED' });
    loadSettings();
    showStatus(ProtonI18n.t('settingsReset'));
  });

  // --- Verification code pattern manager ---

  // --- Quiet mail rules ---------------------------------------------------
  //
  // Rule objects live in settings.notificationRules; the matching semantics
  // (and validation) come from lib/notification-rules.js so the options page
  // and the poller can never disagree about what a rule means.
  let _quietRulesState = [];

  const QUIET_FIELDS = [
    { key: 'from', label: 'quietRuleFrom', placeholder: '@newsletter.shop.com' },
    { key: 'fromName', label: 'quietRuleFromName', placeholder: 'Shop News' },
    { key: 'to', label: 'quietRuleTo', placeholder: 'alias+shop@proton.me' },
    { key: 'subject', label: 'quietRuleSubject', placeholder: '^\\[Jira\\]', mono: true },
    { key: 'body', label: 'quietRuleBody', placeholder: 'unsubscribe', mono: true },
  ];
  const QUIET_ACTIONS = [
    { key: 'silenceNotification', label: 'quietRuleSilence' },
    { key: 'excludeFromCount', label: 'quietRuleExclude' },
    { key: 'muteSound', label: 'quietRuleMute' },
    { key: 'hideFromInbox', label: 'quietRuleHide' },
  ];

  function _quietRuleById(id) {
    return _quietRulesState.find((r) => r && r.id === id) || null;
  }

  /** Rule ids the user has expanded. Kept in memory (not in settings) so the
   *  list re-renders without collapsing what you're editing, while a fresh
   *  options page always opens tidy. */
  const _quietExpanded = new Set();

  /** The collapsed line's title: the user's name, else a description built
   *  from the first condition, so an unnamed rule is still identifiable. */
  function _quietRuleTitle(rule) {
    if (rule.name) return rule.name;
    for (const f of QUIET_FIELDS) {
      if (rule[f.key]) return ProtonI18n.t(f.label) + ' ' + rule[f.key];
    }
    return ProtonI18n.t('quietRuleUntitled');
  }

  function _renderQuietRules() {
    if (!quietRulesList || typeof ProtonNotificationRules === 'undefined') return;
    quietRulesList.replaceChildren();

    if (quietRuleCount) {
      const active = ProtonNotificationRules.activeRules(_quietRulesState).length;
      quietRuleCount.textContent = active ? String(active) : '';
    }

    if (_quietRulesState.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'option-hint';
      empty.textContent = ProtonI18n.t('quietRulesEmpty');
      quietRulesList.appendChild(empty);
      return;
    }

    for (const raw of _quietRulesState) {
      const rule = ProtonNotificationRules.normalize(raw);
      const check = ProtonNotificationRules.validate(rule);

      // One collapsed line per rule: <details> keeps the disclosure behaviour
      // (and keyboard support) native.
      const row = document.createElement('details');
      row.className = 'quiet-rule';
      if (!rule.enabled) row.classList.add('is-disabled');
      row.dataset.ruleId = rule.id;
      row.setAttribute('role', 'listitem');
      row.open = _quietExpanded.has(rule.id);
      row.addEventListener('toggle', () => {
        if (row.open) _quietExpanded.add(rule.id);
        else _quietExpanded.delete(rule.id);
      });

      // Summary line: enable toggle + title + delete
      const head = document.createElement('summary');
      head.className = 'quiet-rule-head';

      const toggle = document.createElement('label');
      toggle.className = 'quiet-rule-toggle';
      toggle.title = ProtonI18n.t('quietRuleEnabled');
      const enabled = document.createElement('input');
      enabled.type = 'checkbox';
      enabled.checked = rule.enabled;
      enabled.dataset.field = 'enabled';
      // Inside a <summary>, a click would also open/close the rule.
      enabled.addEventListener('click', (e) => e.stopPropagation());
      toggle.addEventListener('click', (e) => e.stopPropagation());
      toggle.appendChild(enabled);
      head.appendChild(toggle);

      const title = document.createElement('span');
      title.className = 'quiet-rule-title';
      title.textContent = _quietRuleTitle(rule);
      head.appendChild(title);

      // Flag a broken or inert rule on the collapsed line too. Otherwise the
      // only hint would be hidden inside a rule the user never opens.
      if (!check.ok) {
        const flag = document.createElement('span');
        flag.className = 'quiet-rule-flag';
        flag.textContent = '!';
        flag.title = ProtonI18n.t(check.noConditions
          ? 'quietRuleNoConditions' : 'quietRuleInvalidRegex');
        head.appendChild(flag);
      }

      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'pattern-icon-btn';
      del.dataset.action = 'delete';
      del.title = ProtonI18n.t('quietRuleDelete');
      del.setAttribute('aria-label', ProtonI18n.t('quietRuleDelete'));
      del.textContent = '×';
      // preventDefault cancels the <summary>'s toggle; stopPropagation must
      // NOT be used here: the delete handler is delegated on the list, so
      // stopping the click would silently disable deleting.
      del.addEventListener('click', (e) => e.preventDefault());
      head.appendChild(del);
      row.appendChild(head);

      // Name: first field inside the rule, since it labels the whole thing.
      const nameWrap = document.createElement('label');
      nameWrap.className = 'quiet-rule-field quiet-rule-name-field';
      const nameLabel = document.createElement('span');
      nameLabel.textContent = ProtonI18n.t('quietRuleName');
      const nameInput = document.createElement('input');
      nameInput.type = 'text';
      nameInput.value = rule.name || '';
      nameInput.placeholder = ProtonI18n.t('quietRuleNamePlaceholder');
      nameInput.dataset.field = 'name';
      nameInput.maxLength = ProtonNotificationRules.MAX_NAME_LENGTH;
      nameWrap.append(nameLabel, nameInput);
      row.appendChild(nameWrap);

      // Conditions
      const fields = document.createElement('div');
      fields.className = 'quiet-rule-fields';
      for (const f of QUIET_FIELDS) {
        const wrap = document.createElement('label');
        wrap.className = 'quiet-rule-field';
        const label = document.createElement('span');
        label.textContent = ProtonI18n.t(f.label);
        const input = document.createElement('input');
        input.type = 'text';
        input.value = rule[f.key] || '';
        input.placeholder = f.placeholder;
        input.dataset.field = f.key;
        input.maxLength = ProtonNotificationRules.MAX_PATTERN_LENGTH;
        if (f.mono) input.className = 'mono';
        wrap.append(label, input);
        if (check.errors[f.key]) {
          input.classList.add('is-invalid');
          const err = document.createElement('span');
          err.className = 'quiet-rule-error';
          err.textContent = ProtonI18n.t('quietRuleInvalidRegex');
          wrap.appendChild(err);
        }
        fields.appendChild(wrap);
      }
      row.appendChild(fields);

      // Actions
      const actions = document.createElement('div');
      actions.className = 'quiet-rule-actions';
      for (const a of QUIET_ACTIONS) {
        const label = document.createElement('label');
        label.className = 'checkbox-label';
        const box = document.createElement('input');
        box.type = 'checkbox';
        box.checked = !!rule[a.key];
        box.dataset.field = a.key;
        const text = document.createElement('span');
        text.textContent = ProtonI18n.t(a.label);
        label.append(box, text);
        actions.appendChild(label);
      }
      row.appendChild(actions);

      // Try the rule against the mail already loaded, so a regex can be
      // checked without waiting for a matching message to arrive.
      const testRow = document.createElement('div');
      testRow.className = 'quiet-rule-test';
      const testBtn = document.createElement('button');
      testBtn.type = 'button';
      testBtn.className = 'btn-test';
      testBtn.dataset.action = 'test';
      testBtn.textContent = ProtonI18n.t('quietRuleTest');
      const testOut = document.createElement('div');
      testOut.className = 'quiet-rule-test-result';
      testRow.append(testBtn, testOut);
      row.appendChild(testRow);

      // A rule that tests nothing, or does nothing, is inert. Say so rather
      // than letting the user believe mail is being muted.
      if (check.noConditions || check.noActions) {
        const warn = document.createElement('p');
        warn.className = 'quiet-rule-warning';
        warn.textContent = ProtonI18n.t(
          check.noConditions ? 'quietRuleNoConditions' : 'quietRuleNoActions');
        row.appendChild(warn);
      }

      quietRulesList.appendChild(row);
    }
  }

  let _codePatternsState = []; // raw stored array (overrides + custom)

  /** Build an edit-icon SVG element (14px, currentColor). Uses
   *  createElementNS so AMO's reviewer doesn't flag innerHTML. */
  function _buildPatternEditIcon() {
    const NS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', '0 0 14 14');
    svg.setAttribute('width', '14');
    svg.setAttribute('height', '14');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '1.4');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    const path = document.createElementNS(NS, 'path');
    path.setAttribute('d', 'M9.5 1.5l3 3-7 7H2.5v-3z');
    svg.appendChild(path);
    return svg;
  }

  /** Find or create a stored entry for a given pattern id. */
  function _getStoredEntry(id) {
    let entry = _codePatternsState.find((p) => p && p.id === id);
    if (!entry) {
      entry = { id };
      _codePatternsState.push(entry);
    }
    return entry;
  }

  /** Remove a stored entry by id. */
  function _removeStoredEntry(id) {
    _codePatternsState = _codePatternsState.filter((p) => !p || p.id !== id);
  }

  function _renderCodePatterns() {
    if (!codePatternsList || typeof ProtonCodePatterns === 'undefined') return;
    const merged = ProtonCodePatterns.mergeWithDefaults(_codePatternsState);
    codePatternsList.replaceChildren();

    for (const p of merged) {
      const row = document.createElement('div');
      row.className = 'pattern-row';
      if (!p.enabled) row.classList.add('is-disabled');
      if (p.isModified) row.classList.add('is-modified');
      row.dataset.patternId = p.id;
      row.dataset.patternKind = p.kind;
      row.setAttribute('role', 'listitem');

      // Head row
      const head = document.createElement('div');
      head.className = 'pattern-row-head';

      const toggleLabel = document.createElement('label');
      toggleLabel.className = 'pattern-toggle';
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.checked = p.enabled;
      checkbox.dataset.action = 'toggle';
      const nameSpan = document.createElement('span');
      nameSpan.className = 'pattern-name';
      nameSpan.textContent = p.name;
      toggleLabel.appendChild(checkbox);
      toggleLabel.appendChild(nameSpan);
      head.appendChild(toggleLabel);

      if (p.isModified) {
        const badge = document.createElement('span');
        badge.className = 'pattern-badge';
        badge.title = ProtonI18n.t('patternModifiedTitle');
        badge.textContent = 'MOD';
        head.appendChild(badge);
      }

      const actions = document.createElement('div');
      actions.className = 'pattern-actions';

      const editBtn = document.createElement('button');
      editBtn.type = 'button';
      editBtn.className = 'pattern-icon-btn';
      editBtn.dataset.action = 'edit';
      editBtn.title = ProtonI18n.t('edit');
      editBtn.setAttribute('aria-label', ProtonI18n.t('edit'));
      editBtn.appendChild(_buildPatternEditIcon());
      actions.appendChild(editBtn);

      if (p.kind === 'default') {
        const resetBtn = document.createElement('button');
        resetBtn.type = 'button';
        resetBtn.className = 'pattern-icon-btn';
        resetBtn.dataset.action = 'reset';
        resetBtn.title = ProtonI18n.t('resetToDefault');
        resetBtn.setAttribute('aria-label', ProtonI18n.t('resetToDefault'));
        resetBtn.textContent = '↺'; // ↺
        if (!p.isModified) resetBtn.disabled = true;
        actions.appendChild(resetBtn);
      } else {
        const delBtn = document.createElement('button');
        delBtn.type = 'button';
        delBtn.className = 'pattern-icon-btn pattern-icon-btn--danger';
        delBtn.dataset.action = 'delete';
        delBtn.title = ProtonI18n.t('delete');
        delBtn.setAttribute('aria-label', ProtonI18n.t('delete'));
        delBtn.textContent = '×'; // ×
        actions.appendChild(delBtn);
      }
      head.appendChild(actions);
      row.appendChild(head);

      // Regex row
      const regexWrap = document.createElement('div');
      regexWrap.className = 'pattern-regex';
      const regexInput = document.createElement('input');
      regexInput.type = 'text';
      regexInput.className = 'mono';
      regexInput.value = p.regex;
      regexInput.readOnly = true;
      regexInput.dataset.action = 'regex';
      regexInput.setAttribute('aria-label', 'Regex');
      regexWrap.appendChild(regexInput);
      row.appendChild(regexWrap);

      codePatternsList.appendChild(row);
    }

    if (codePatternCount) {
      codePatternCount.textContent = '(' + merged.length + ')';
    }
  }

  /** Validate + save edits to a pattern's regex inline. */
  function _commitRegexEdit(row, newRegex) {
    const id = row.dataset.patternId;
    const kind = row.dataset.patternKind;
    const merged = ProtonCodePatterns.mergeWithDefaults(_codePatternsState);
    const current = merged.find((p) => p.id === id);
    if (!current) return false;

    const err = ProtonCodePatterns.validateRegex(newRegex, current.flags);
    if (err) {
      const inp = row.querySelector('input[data-action="regex"]');
      if (inp) {
        inp.classList.add('invalid');
        inp.title = err;
      }
      return false;
    }

    if (kind === 'default') {
      // Find the shipped default; if regex == shipped, drop the override
      const shipped = ProtonCodePatterns.SHIPPED_DEFAULTS.find((d) => d.id === id);
      if (shipped && newRegex === shipped.regex) {
        // Reset to shipped, but keep enabled override if any
        const stored = _codePatternsState.find((p) => p && p.id === id);
        if (stored) {
          delete stored.regex;
          if (stored.enabled === undefined && stored.regex === undefined && stored.flags === undefined) {
            _removeStoredEntry(id);
          }
        }
      } else {
        const entry = _getStoredEntry(id);
        entry.regex = newRegex;
      }
    } else {
      const entry = _getStoredEntry(id);
      entry.regex = newRegex;
    }
    saveSettings();
    _renderCodePatterns();
    return true;
  }

  if (codePatternsList) {
  // --- Quiet rules: add / edit / delete ---
  if (quietRuleAddBtn) {
    quietRuleAddBtn.addEventListener('click', () => {
      const rule = ProtonNotificationRules.normalize({ silenceNotification: true });
      _quietRulesState.push(rule);
      // A rule you just added is the one you want open.
      _quietExpanded.add(rule.id);
      _renderQuietRules();
      saveSettings();
      const row = quietRulesList.querySelector(`.quiet-rule[data-rule-id="${rule.id}"]`);
      const nameInput = row && row.querySelector('input[data-field="name"]');
      if (nameInput) nameInput.focus();
    });
  }

  /** The rule as currently shown in a row: live input values on top of the
   *  stored rule, so an unsaved edit is what gets tested. */
  function _quietRuleFromRow(row) {
    const stored = _quietRuleById(row.dataset.ruleId);
    if (!stored) return null;
    const live = { ...stored };
    row.querySelectorAll('input[data-field]').forEach((input) => {
      live[input.dataset.field] = input.type === 'checkbox' ? input.checked : input.value;
    });
    return ProtonNotificationRules.normalize(live);
  }

  /** Debounce handle for text-field saves; the Test button flushes it. */
  let _quietDebounce = null;

  /** Run one rule against the loaded mail and render the outcome. */
  async function _runQuietRuleTest(row, rule) {
    const btn = row.querySelector('button[data-action="test"]');
    const out = row.querySelector('.quiet-rule-test-result');
    if (!btn || !out) return;

    const check = ProtonNotificationRules.validate(rule);
    if (!check.ok) {
      out.textContent = ProtonI18n.t('quietRuleTestInvalid');
      out.className = 'quiet-rule-test-result is-warning';
      return;
    }

    const label = btn.textContent;
    btn.disabled = true;
    btn.textContent = ProtonI18n.t('quietRuleTesting');
    out.textContent = '';
    out.className = 'quiet-rule-test-result';
    try {
      const res = await browser.runtime.sendMessage({ type: 'QUIET_RULES_TEST', rule });
      if (!res || res.error) {
        out.textContent = ProtonI18n.t(
          res && res.error === 'INVALID' ? 'quietRuleTestInvalid' : 'quietRuleTestFailed');
        out.className = 'quiet-rule-test-result is-warning';
        return;
      }
      out.replaceChildren();
      const summary = document.createElement('div');
      // No match is not an error: only loaded mail can be tested.
      summary.textContent = res.count
        ? ProtonI18n.t('quietRuleTestResult', String(res.count), String(res.total))
        : ProtonI18n.t('quietRuleTestNone', String(res.total));
      out.appendChild(summary);
      if (res.matched && res.matched.length) {
        const list = document.createElement('ul');
        list.className = 'quiet-rule-test-matches';
        for (const m of res.matched) {
          const li = document.createElement('li');
          li.textContent = (m.from || '?') + ': ' + (m.subject || ProtonI18n.t('noSubject'));
          list.appendChild(li);
        }
        out.appendChild(list);
      }

      // Nothing matched but several conditions are set: the fields are ANDed,
      // so show each one's own tally: the condition sitting at 0 is why.
      if (!res.count && res.fields) {
        const parts = QUIET_FIELDS
          .filter((f) => f.key in res.fields)
          .map((f) => ProtonI18n.t(f.label) + ': ' + res.fields[f.key]);
        if (parts.length > 1) {
          const breakdown = document.createElement('div');
          breakdown.className = 'quiet-rule-test-breakdown';
          breakdown.textContent = parts.join(' · ');
          out.appendChild(breakdown);
        }
      }
      out.className = 'quiet-rule-test-result' + (res.count ? ' is-match' : '');
    } catch (err) {
      out.textContent = ProtonI18n.t('quietRuleTestFailed');
      out.className = 'quiet-rule-test-result is-warning';
    } finally {
      btn.disabled = false;
      btn.textContent = label;
    }
  }

  if (quietRulesList) {
    quietRulesList.addEventListener('click', (e) => {
      const row = e.target.closest('.quiet-rule');
      if (!row) return;

      if (e.target.closest('button[data-action="test"]')) {
        // Test what is on screen, not what was last saved: text fields are
        // persisted on a debounce, so a rule tested straight after typing
        // would otherwise be the PREVIOUS one. Flush the pending save too, so
        // stored state and tested state can't diverge.
        const rule = _quietRuleFromRow(row);
        if (rule) {
          clearTimeout(_quietDebounce);
          const stored = _quietRuleById(row.dataset.ruleId);
          if (stored) { Object.assign(stored, rule); saveSettings(); }
          _runQuietRuleTest(row, rule);
        }
        return;
      }

      if (!e.target.closest('button[data-action="delete"]')) return;
      _quietRulesState = _quietRulesState.filter((r) => r.id !== row.dataset.ruleId);
      _renderQuietRules();
      saveSettings();
    });

    /** Update one row's error/warning state without rebuilding it. A full
     *  re-render while typing would steal focus and the caret. */
    const _refreshRowValidity = (row, rule) => {
      const check = ProtonNotificationRules.validate(rule);
      row.querySelectorAll('.quiet-rule-field').forEach((wrap) => {
        const input = wrap.querySelector('input[data-field]');
        const old = wrap.querySelector('.quiet-rule-error');
        if (old) old.remove();
        if (!input) return;
        const bad = check.errors[input.dataset.field];
        input.classList.toggle('is-invalid', !!bad);
        if (bad) {
          const err = document.createElement('span');
          err.className = 'quiet-rule-error';
          err.textContent = ProtonI18n.t('quietRuleInvalidRegex');
          wrap.appendChild(err);
        }
      });
      const oldWarn = row.querySelector('.quiet-rule-warning');
      if (oldWarn) oldWarn.remove();
      if (check.noConditions || check.noActions) {
        const warn = document.createElement('p');
        warn.className = 'quiet-rule-warning';
        warn.textContent = ProtonI18n.t(
          check.noConditions ? 'quietRuleNoConditions' : 'quietRuleNoActions');
        row.appendChild(warn);
      }
      row.classList.toggle('is-disabled', !rule.enabled);

      // Keep the collapsed line in sync: its title follows the name (or the
      // first condition) as it's typed, and the flag follows validity.
      const titleEl = row.querySelector('.quiet-rule-title');
      if (titleEl) titleEl.textContent = _quietRuleTitle(rule);
      const head = row.querySelector('.quiet-rule-head');
      const oldFlag = head && head.querySelector('.quiet-rule-flag');
      if (oldFlag) oldFlag.remove();
      if (head && !check.ok) {
        const flag = document.createElement('span');
        flag.className = 'quiet-rule-flag';
        flag.textContent = '!';
        flag.title = ProtonI18n.t(check.noConditions
          ? 'quietRuleNoConditions' : 'quietRuleInvalidRegex');
        head.insertBefore(flag, head.querySelector('button[data-action="delete"]'));
      }

      if (quietRuleCount) {
        const active = ProtonNotificationRules.activeRules(_quietRulesState).length;
        quietRuleCount.textContent = active ? String(active) : '';
      }
    };

    const _applyField = (input) => {
      const row = input.closest('.quiet-rule');
      const rule = row && _quietRuleById(row.dataset.ruleId);
      if (!rule) return;
      rule[input.dataset.field] = input.type === 'checkbox' ? input.checked : input.value;
      _refreshRowValidity(row, rule);
      saveSettings();
    };

    quietRulesList.addEventListener('change', (e) => {
      const input = e.target.closest('input[type="checkbox"][data-field]');
      if (input) _applyField(input);
    });

    // Persist as the user types (debounced): a half-written regex must survive
    // closing the options page, and there is no explicit Save button here.
    quietRulesList.addEventListener('input', (e) => {
      const input = e.target.closest('input[type="text"][data-field]');
      if (!input) return;
      clearTimeout(_quietDebounce);
      _quietDebounce = setTimeout(() => _applyField(input), 500);
    });
  }

    codePatternsList.addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-action]');
      if (!btn) return;
      const row = btn.closest('.pattern-row');
      if (!row) return;
      const action = btn.dataset.action;
      const id = row.dataset.patternId;

      if (action === 'edit') {
        // Toggle edit mode
        const wasEditing = row.classList.toggle('is-editing');
        const inp = row.querySelector('input[data-action="regex"]');
        if (!inp) return;
        if (wasEditing) {
          inp.readOnly = false;
          inp.focus();
          inp.select();
        } else {
          // Commit
          const newVal = inp.value;
          const ok = _commitRegexEdit(row, newVal);
          if (ok) inp.readOnly = true;
        }
      } else if (action === 'reset') {
        const stored = _codePatternsState.find((p) => p && p.id === id);
        if (stored) {
          delete stored.regex;
          delete stored.flags;
          if (stored.enabled === undefined) _removeStoredEntry(id);
        }
        saveSettings();
        _renderCodePatterns();
      } else if (action === 'delete') {
        _removeStoredEntry(id);
        saveSettings();
        _renderCodePatterns();
      }
    });

    codePatternsList.addEventListener('change', (e) => {
      const cb = e.target.closest('input[type="checkbox"][data-action="toggle"]');
      if (!cb) return;
      const row = cb.closest('.pattern-row');
      if (!row) return;
      const id = row.dataset.patternId;
      const kind = row.dataset.patternKind;
      const enabled = cb.checked;
      if (kind === 'default') {
        const shipped = ProtonCodePatterns.SHIPPED_DEFAULTS.find((d) => d.id === id);
        const entry = _getStoredEntry(id);
        if (shipped && enabled === shipped.enabled && entry.regex === undefined && entry.flags === undefined) {
          _removeStoredEntry(id);
        } else {
          entry.enabled = enabled;
        }
      } else {
        const entry = _getStoredEntry(id);
        entry.enabled = enabled;
      }
      saveSettings();
      _renderCodePatterns();
    });

    // Commit on Enter / cancel on Escape while editing
    codePatternsList.addEventListener('keydown', (e) => {
      const inp = e.target.closest('input[data-action="regex"]');
      if (!inp || inp.readOnly) return;
      const row = inp.closest('.pattern-row');
      if (!row) return;
      if (e.key === 'Enter') {
        e.preventDefault();
        const ok = _commitRegexEdit(row, inp.value);
        if (ok) {
          inp.readOnly = true;
          row.classList.remove('is-editing');
        }
      } else if (e.key === 'Escape') {
        e.preventDefault();
        inp.readOnly = true;
        row.classList.remove('is-editing');
        inp.classList.remove('invalid');
        _renderCodePatterns(); // restore the displayed value
      }
    });
  }

  if (codePatternAddBtn) {
    codePatternAddBtn.addEventListener('click', () => {
      const name = (codePatternNameInput.value || '').trim();
      const regex = (codePatternRegexInput.value || '').trim();
      codePatternNameInput.classList.remove('invalid');
      codePatternRegexInput.classList.remove('invalid');

      if (!name) {
        codePatternNameInput.classList.add('invalid');
        codePatternNameInput.focus();
        return;
      }
      const err = ProtonCodePatterns.validateRegex(regex, 'i');
      if (err) {
        codePatternRegexInput.classList.add('invalid');
        codePatternRegexInput.title = err;
        codePatternRegexInput.focus();
        return;
      }

      const id = 'custom-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
      _codePatternsState.push({ id, name, regex, flags: 'i', enabled: true });
      codePatternNameInput.value = '';
      codePatternRegexInput.value = '';
      saveSettings();
      _renderCodePatterns();
    });

    // Pressing Enter in either input triggers Add
    [codePatternNameInput, codePatternRegexInput].forEach((inp) => {
      inp.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          codePatternAddBtn.click();
        }
      });
      inp.addEventListener('input', () => {
        inp.classList.remove('invalid');
        inp.removeAttribute('title');
      });
    });
  }

  if (codePatternResetAll) {
    codePatternResetAll.addEventListener('click', async () => {
      if (!await ProtonDialog.confirm(ProtonI18n.t('resetAllDefaultsConfirm'),
        { confirmLabel: ProtonI18n.t('resetAllDefaults'), danger: true,
          anchor: codePatternResetAll })) return;
      // Drop every stored override that matches a default id (keep custom).
      _codePatternsState = _codePatternsState.filter(
        (p) => p && p.id && !ProtonCodePatterns.isDefaultId(p.id)
      );
      saveSettings();
      _renderCodePatterns();
    });
  }

  // --- Account Alignment ---

  const alignmentList = document.getElementById('account-alignment-list');
  const btnRefreshAlignment = document.getElementById('btn-refresh-alignment');

  async function loadAccountAlignment() {
    let mapping;
    try {
      mapping = await browser.runtime.sendMessage({ type: 'GET_ACCOUNT_MAPPING' });
    } catch (e) {
      // Background script not ready yet. Retry after a short delay
      setTimeout(loadAccountAlignment, 1000);
      return;
    }
    if (!mapping || !Array.isArray(mapping)) {
      alignmentList.textContent = ProtonI18n.t('noAccountsConfigured');
      return;
    }

    alignmentList.textContent = '';
    for (const acct of mapping) {
      const row = document.createElement('div');
      row.className = 'alignment-row';

      const label = document.createElement('span');
      label.className = 'alignment-label';
      label.textContent = acct.label || acct.email;
      label.title = acct.email;

      const prefix = document.createElement('span');
      prefix.className = 'alignment-slot-prefix';
      prefix.textContent = '/u/';
      prefix.style.fontSize = '13px';
      prefix.style.color = 'var(--text-secondary)';

      const input = document.createElement('input');
      input.type = 'number';
      input.className = 'alignment-slot';
      input.min = '0';
      input.max = '9';
      input.value = acct.activeSlot;
      input.title = ProtonI18n.t('webSlotIndex');

      const suffix = document.createElement('span');
      suffix.textContent = '/';
      suffix.style.fontSize = '13px';
      suffix.style.color = 'var(--text-secondary)';

      const source = document.createElement('span');
      source.className = 'alignment-source ' + acct.source;
      const sourceLabel = document.createElement('span');
      sourceLabel.textContent = ProtonI18n.t('source_' + acct.source);
      source.appendChild(sourceLabel);
      if (acct.source === 'detected' && acct.detectedAt) {
        try {
          const d = new Date(acct.detectedAt);
          const dateEl = document.createElement('span');
          dateEl.className = 'alignment-date';
          dateEl.textContent = d.toLocaleDateString() + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
          source.appendChild(dateEl);
        } catch (e) { console.warn('[Options] Sync source date parse failed:', e.message); }
      }

      const clearBtn = document.createElement('button');
      clearBtn.className = 'alignment-clear';
      clearBtn.textContent = '\u00D7';
      clearBtn.title = ProtonI18n.t('clearOverride');
      clearBtn.style.visibility = acct.source === 'manual' ? 'visible' : 'hidden';

      input.addEventListener('change', async () => {
        const val = parseInt(input.value, 10);
        if (isNaN(val) || val < 0) { input.value = acct.activeSlot; return; }
        await browser.runtime.sendMessage({
          type: 'SET_ACCOUNT_MAPPING', accountId: acct.id, slot: val,
        });
        await loadAccountAlignment();
      });

      clearBtn.addEventListener('click', async () => {
        await browser.runtime.sendMessage({
          type: 'SET_ACCOUNT_MAPPING', accountId: acct.id, slot: null,
        });
        await loadAccountAlignment();
      });

      row.appendChild(label);
      row.appendChild(prefix);
      row.appendChild(input);
      row.appendChild(suffix);
      row.appendChild(source);
      row.appendChild(clearBtn);
      alignmentList.appendChild(row);
    }
  }

  btnRefreshAlignment.addEventListener('click', async () => {
    btnRefreshAlignment.disabled = true;
    btnRefreshAlignment.textContent = ProtonI18n.t('refreshAlignment') + '...';
    try {
      const mapping = await browser.runtime.sendMessage({ type: 'RESCAN_ACCOUNT_MAPPING' });
      if (mapping && Array.isArray(mapping)) {
        // Re-render with the fresh mapping
        alignmentList.textContent = '';
        // Temporarily store and re-call with the data
      }
      await loadAccountAlignment();
    } catch (e) { console.warn('[Options] Alignment refresh failed:', e.message); }
    btnRefreshAlignment.disabled = false;
    btnRefreshAlignment.textContent = ProtonI18n.t('refreshAlignment');
  });

  loadSettings();
  loadAccountAlignment();
  loadPremium();

  // Pessimistic premium lock: disable every PREMIUM_ONLY_IDS control
  // synchronously at page load so a free-tier user can't tap a
  // premium-only control during the ~100ms before loadPremium
  // resolves. loadPremium → renderPremium → applyPremiumLocks(!premium)
  // will unlock them once the actual status is known. (Called after
  // the imperative loadSettings/loadPremium so PREMIUM_ONLY_IDS is
  // out of the temporal dead zone, see line 1217.)
  // NOTE: scheduled via queueMicrotask so it runs after the rest of
  // the IIFE has finished initializing the const PREMIUM_ONLY_IDS.
  queueMicrotask(() => applyPremiumLocks(true));

  // Show version
  const manifest = browser.runtime.getManifest();
  document.getElementById('version-info').textContent = manifest.name + ' v' + manifest.version;

  // ---------------- Premium / license management ----------------
  //
  // Fetch status from ProtonPremium via the background script, then render:
  //   - Premium banner (hidden when licensed or held)
  //   - Status line (held / payment failed / locked / Premium active / trial / free)
  //   - License key input OR stored license block, plus one license notice
  //   - Disabled state on every premium-only control (applied via CSS class)
  //
  // Re-renders whenever the user starts a trial, activates, or removes a key,
  // and whenever the background writes new license state to storage.

  async function loadPremium() {
    try {
      const status = await browser.runtime.sendMessage({ type: 'GET_PREMIUM_STATUS' });
      renderPremium(status);
    } catch (e) {
      console.warn('[Options] Could not load premium status:', e.message);
      setTimeout(loadPremium, 1000);
    }
  }

  // IDs of controls that are premium-only. Their parent .option-group gets
  // the .premium-locked class when the user is on the free tier, which CSS
  // uses to dim + disable. The language selector and account-level toggles
  // stay fully functional on free.
  const PREMIUM_ONLY_IDS = [
    // General
    'poll-interval', 'popup-width', 'popup-width-value', 'popup-height', 'popup-height-value',
    'theme-select', 'color-scheme', 'custom-css', 'display-density',
    'max-emails', 'sender-display', 'preview-lines', 'use-24h-time',
    'preview-format', 'compose-mode', 'compose-format', 'reply-format',
    'spellcheck-language', 'badge-color',
    // Notifications (customization only: master toggle stays free)
    'notification-click-action', 'notification-sound-enabled',
    'notification-sound', 'notification-volume', 'notification-preview-text',
    // Behavior: all premium
    'auto-mark-read-preview', 'auto-mark-read-reply', 'auto-mark-read-archive',
    'auto-mark-read-delete', 'auto-mark-read-spam', 'auto-mark-read-phishing',
    'auto-mark-read-star', 'auto-mark-read-move-to-folder', 'auto-mark-read-label',
    'hide-send-archive', 'prettify-raw', 'image-attach-mode', 'auto-advance',
    'nav-cross-account', 'nav-wrap', 'actions-sortable',
    // Data: export, import, Firefox sync are premium
    'sync-enabled', 'btn-sync-now', 'btn-export', 'btn-import',
    // Misc
    'always-load-external',
    // Verification code pattern customization (basic detection stays free)
    'code-detection-enabled',
    'code-patterns-list',
    'code-pattern-name', 'code-pattern-regex', 'code-pattern-add-btn',
    'code-pattern-reset-all',
    // Quiet mail rules: the whole section is premium
    'quiet-rules-list', 'quiet-rule-add-btn',
  ];

  function applyPremiumLocks(isFree) {
    const groups = new Set();
    for (const id of PREMIUM_ONLY_IDS) {
      const el = document.getElementById(id);
      if (!el) continue;
      el.disabled = isFree ? true : false;
      const group = el.closest('.option-group') || el.parentElement;
      if (group) groups.add(group);
    }
    groups.forEach(g => g.classList.toggle('premium-locked', isFree));
  }

  // The status most recently rendered: the return-from-Paddle re-check reads
  // it to know whether the license still needs the user's attention.
  let _renderedStatus = null;
  // The Premium section opens by itself at most once per page load, so a user
  // who closes it is not fought by the next storage-driven re-render.
  let _premiumSectionAutoOpened = false;

  // Same phrase as the banner rather than "n" + "days remaining" glued
  // together: that concatenation was English grammar in every language and
  // read "1 days remaining" on the last trial day.
  function _trialDaysPhrase(status) {
    return ProtonI18n.t('trialBannerTitle')
      .replace('{days}', ProtonI18n.plural('dayCount', status.trialDaysRemaining));
  }

  function _renderStatusLine(el, status) {
    let text;
    let mod = '';
    if (status.held) {
      // Held: the key is kept but Premium is off, unless the in-extension
      // trial still runs. Then the trial days are what the user has; the
      // notice below still names the held reason.
      if (status.trialActive) {
        text = _trialDaysPhrase(status);
        mod = 'trial';
      } else {
        text = ProtonI18n.t(status.held === 'paused' ? 'statusPaused' : 'statusFirstPaymentFailed');
        mod = 'expired';
      }
    } else if (status.pastDue && !status.locked) {
      // "Premium active, payment failed" would be false once the grace period
      // has locked the key, so a locked key falls through to "locked".
      text = ProtonI18n.t('statusPaymentFailed');
      mod = 'trial';
    } else if (status.locked) {
      text = ProtonI18n.t('licenseLocked');
      mod = 'expired';
    } else if (status.licensed) {
      text = ProtonI18n.t('premiumActive');
      mod = 'active';
    } else if (status.trialing) {
      text = _trialDaysPhrase(status);
      mod = 'trial';
    } else if (status.trialExpired) {
      text = ProtonI18n.t('trialExpired');
      mod = 'expired';
    } else {
      text = ProtonI18n.t('freeTier');
    }
    el.textContent = text;
    el.className = 'premium-status__value' + (mod ? ' premium-status__value--' + mod : '');
  }

  // Open the Premium section once when the license needs the user to act.
  // A cleared key or a scheduled cancel is information, not a call to act.
  function _maybeAutoOpenPremium(status) {
    if (_premiumSectionAutoOpened) return;
    if (!(status.held || status.pastDue || status.locked || status.inGracePeriod)) return;
    const section = document.getElementById('premium-section');
    if (!section) return;
    section.open = true;
    _premiumSectionAutoOpened = true;
  }

  function renderPremium(status) {
    _renderedStatus = status;
    const banner = document.getElementById('premium-banner');
    const btnStartTrial = document.getElementById('btn-start-trial');
    const statusValue = document.getElementById('premium-status-value');
    const entryGroup = document.getElementById('license-entry-group');
    const activeGroup = document.getElementById('license-active-group');
    const keyMaskedEl = document.getElementById('license-key-masked');
    const lastValidatedEl = document.getElementById('license-last-validated');
    const validationNotice = document.getElementById('license-validation-notice');
    const clearedNotice = document.getElementById('license-cleared-notice');

    _renderStatusLine(statusValue, status);

    // Banner visibility: hide when the user has an active license, and while
    // a key is held: that user already has a subscription and must not be
    // sold a second one. Trial users still see it so they can subscribe.
    banner.classList.toggle('hidden', !!status.licensed || !!status.held);

    // Tailor the banner copy for the user's current state. The title/text
    // elements intentionally have NO data-i18n attribute so ProtonI18n's
    // applyTranslations() doesn't race with us. We own the copy here.
    const bannerTitle = document.getElementById('premium-banner-title');
    const bannerText = document.getElementById('premium-banner-text');
    if (bannerTitle && bannerText) {
      if (status.trialing) {
        // {days} wants a complete phrase, not a bare number: plural() picks the
        // form the active language needs for this count ("1 day" vs "3 days").
        bannerTitle.textContent = ProtonI18n.t('trialBannerTitle')
          .replace('{days}', ProtonI18n.plural('dayCount', status.trialDaysRemaining));
        bannerText.textContent = ProtonI18n.t('trialBannerText');
      } else if (status.trialExpired) {
        bannerTitle.textContent = ProtonI18n.t('trialExpiredBannerTitle');
        bannerText.textContent = ProtonI18n.t('trialExpiredBannerText');
      } else {
        bannerTitle.textContent = ProtonI18n.t('upgradeBannerTitle');
        bannerText.textContent = ProtonI18n.t('upgradeBannerText');
      }
    }

    // "Start Free Trial" button only shown when a trial has never been started.
    btnStartTrial.classList.toggle('hidden', !status.trialAvailable);

    // License key input vs. stored license block. The background says whether
    // a key is stored: a held key is neither licensed nor locked, but the user
    // still needs its notice, Update payment and Remove.
    const keyStored = !!status.keyStored;
    entryGroup.classList.toggle('hidden', keyStored);
    activeGroup.classList.toggle('hidden', !keyStored);
    if (keyStored && status.licenseKeyMasked) {
      keyMaskedEl.textContent = status.licenseKeyMasked;
    }
    // A held or locked key is stored but not active. data-i18n is set too, so
    // a later applyTranslations() keeps the right heading.
    const activeLabel = activeGroup.querySelector('label');
    if (activeLabel) {
      const headingKey = (status.held || status.locked) ? 'licenseKey' : 'activeLicense';
      activeLabel.setAttribute('data-i18n', headingKey);
      activeLabel.textContent = ProtonI18n.t(headingKey);
    }

    // Why the last key disappeared on its own (canceled, not found, ...),
    // shown next to the key field for the 30 days the background keeps it.
    if (clearedNotice) {
      const showCleared = !keyStored && !!status.clearedReason;
      clearedNotice.textContent = '';
      if (showCleared && status.clearedReason === 'subscription_paused') {
        // Only 1.14.x cleared paused keys. The err_subscription_paused label
        // says to resume in the Paddle portal; support resumes it instead.
        clearedNotice.appendChild(document.createTextNode(ProtonI18n.t('statusPaused') + ' ('));
        clearedNotice.appendChild(_supportLink());
        clearedNotice.appendChild(document.createTextNode(')'));
      } else if (showCleared) {
        clearedNotice.textContent = _sentence(_errLabel(status.clearedReason, 'err_subscription_inactive'));
      }
      clearedNotice.classList.toggle('hidden', !showCleared);
    }

    // Validation timestamp + warning/error notice.
    if (lastValidatedEl) {
      lastValidatedEl.textContent = _formatValidationTime(status.lastValidatedAt);
    }
    if (validationNotice) {
      _renderValidationNotice(validationNotice, status);
    }

    // A paused subscription has no payment to update: the notice offers the
    // support link and key removal instead.
    const btnPay = document.getElementById('btn-manage-payment');
    if (btnPay) btnPay.classList.toggle('hidden', status.held === 'paused');

    // Plan (Monthly/Yearly) and current billing period from the most recent
    // successful validation. Only shown while a key is stored: the entire
    // active block is already hidden otherwise.
    const planEl = document.getElementById('license-plan');
    const planRow = document.getElementById('license-plan-row');
    const periodEl = document.getElementById('license-period');
    const periodRow = document.getElementById('license-period-row');
    if (planEl && planRow) {
      const interval = status.billingInterval;
      if (interval === 'month' || interval === 'year') {
        planEl.textContent = ProtonI18n.t(interval === 'year' ? 'licenseTypeYearly' : 'licenseTypeMonthly');
        planRow.classList.remove('hidden');
      } else {
        planRow.classList.add('hidden');
      }
    }
    if (periodEl && periodRow) {
      const start = _formatPeriodDate(status.periodStart);
      const end = _formatPeriodDate(status.periodEnd);
      // No period while a payment is outstanding: the period Paddle reports
      // is one that has not been paid for.
      if (start && end && !status.pastDue && !status.held) {
        // Plain hyphen: language-neutral, so the range needs no i18n key.
        periodEl.textContent = start + ' - ' + end;
        periodRow.classList.remove('hidden');
      } else {
        periodRow.classList.add('hidden');
      }
    }

    // Toggle .premium-locked on all premium-only controls via root class.
    document.body.classList.toggle('is-free', !status.premium);
    document.body.classList.toggle('is-premium', !!status.premium);
    applyPremiumLocks(!status.premium);

    // The "Hide premium UI" option is only useful when the user is on the
    // free tier; hide the whole option group for premium users.
    const hideUiGroup = document.getElementById('hide-premium-ui-group');
    if (hideUiGroup) hideUiGroup.classList.toggle('hidden', !!status.premium);

    _maybeAutoOpenPremium(status);
  }

  // --- Event wiring ---
  const btnStartTrial = document.getElementById('btn-start-trial');
  const btnBuyLicense = document.getElementById('btn-buy-license');
  const btnActivate = document.getElementById('btn-activate-license');
  const btnRemoveLicense = document.getElementById('btn-remove-license');
  const licenseInput = document.getElementById('license-key-input');
  const licenseError = document.getElementById('license-entry-error');

  btnStartTrial.addEventListener('click', async () => {
    btnStartTrial.disabled = true;
    const result = await browser.runtime.sendMessage({ type: 'START_TRIAL' });
    btnStartTrial.disabled = false;
    if (result && result.success) {
      await loadPremium();
    } else {
      // trial_unavailable (a trial was used, or a license was ever stored):
      // the reloaded status hides the button.
      await loadPremium();
    }
  });

  btnBuyLicense.addEventListener('click', () => {
    browser.runtime.sendMessage({ type: 'OPEN_PAYMENT_PAGE' });
  });

  btnActivate.addEventListener('click', async () => {
    licenseError.classList.add('hidden');
    const key = (licenseInput.value || '').trim();
    if (!key) return;

    // Swap the button into a progress state. "Looking up…" is shown when the
    // user pastes a transaction ID: the proxy may poll Paddle for a few
    // seconds while the subscription is being created server-side.
    const originalLabel = btnActivate.textContent;
    const isTxn = /^txn_[a-z0-9]+$/i.test(key);
    btnActivate.disabled = true;
    btnActivate.textContent = isTxn
      ? ProtonI18n.t('lookingUpSubscription')
      : ProtonI18n.t('validating');

    const result = await browser.runtime.sendMessage({ type: 'SET_LICENSE_KEY', key });

    btnActivate.disabled = false;
    btnActivate.textContent = originalLabel;

    if (result && result.success) {
      licenseInput.value = '';
      await loadPremium();
    } else {
      const code = result && result.error;
      const message = code === 'invalid_format'
        ? ProtonI18n.t('licenseInvalidFormat')
        : _sentence(_errLabel(code, 'licenseActivationFailed'));
      licenseError.textContent = message;
      licenseError.classList.remove('hidden');
    }
  });

  licenseInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      btnActivate.click();
    }
  });

  btnRemoveLicense.addEventListener('click', async () => {
    if (!await ProtonDialog.confirm(ProtonI18n.t('confirmRemoveLicense'),
      { confirmLabel: ProtonI18n.t('removeLicense'), danger: true,
        anchor: btnRemoveLicense })) return;
    // Optimistically flip the UI before the round-trip so the user sees
    // immediate feedback even if GET_PREMIUM_STATUS gets queued behind other
    // settings messages.
    document.getElementById('license-active-group').classList.add('hidden');
    document.getElementById('license-entry-group').classList.remove('hidden');
    document.getElementById('license-key-input').value = '';
    const errEl = document.getElementById('license-entry-error');
    if (errEl) errEl.classList.add('hidden');

    try {
      await browser.runtime.sendMessage({ type: 'REMOVE_LICENSE_KEY' });
    } catch (e) {
      console.error('[Options] Remove license failed:', e);
    }
    // Tiny delay so the background has time to flush its storage writes
    // before we re-query state.
    await new Promise(r => setTimeout(r, 50));
    await loadPremium();
  });

  // --- Validation: manual "Validate now" button ---
  // The button is handed back in `finally`: a rejected message (background
  // restarting) used to leave it disabled and reading "Validating..." for good.
  // A check often answers within a fraction of a second, and with "Last
  // validated" already reading "just now" the click looked like it did
  // nothing. So "Validating..." stays up for at least VALIDATE_MIN_MS, and the
  // outcome is spelled out next to the button for VALIDATE_RESULT_MS.
  const VALIDATE_MIN_MS = 600;
  const VALIDATE_RESULT_MS = 6000;
  let _validateResultTimer = null;

  // The outcome of a manual check, next to the button (role="status", so a
  // screen reader announces it). null clears it. A failure only says so: the
  // validation notice explains why.
  function _showValidateResult(ok) {
    const el = document.getElementById('license-validate-result');
    if (!el) return;
    clearTimeout(_validateResultTimer);
    _validateResultTimer = null;
    if (ok === null) {
      el.textContent = '';
      el.classList.add('hidden');
      return;
    }
    el.textContent = ProtonI18n.t(ok ? 'licenseConfirmed' : 'licenseNotConfirmed');
    el.classList.toggle('license-validation__result--ok', ok);
    el.classList.toggle('license-validation__result--failed', !ok);
    el.classList.remove('hidden');
    _validateResultTimer = setTimeout(() => _showValidateResult(null), VALIDATE_RESULT_MS);
  }

  async function _runValidateNow(btn) {
    btn.disabled = true;
    const origLabel = btn.textContent;
    btn.textContent = ProtonI18n.t('validating');
    _showValidateResult(null);
    const started = Date.now();
    let res = null;
    try {
      res = await browser.runtime.sendMessage({ type: 'VALIDATE_LICENSE' });
    } catch (e) {
      console.warn('[Options] Validate now failed:', e.message);
    } finally {
      const left = VALIDATE_MIN_MS - (Date.now() - started);
      if (left > 0) await new Promise((resolve) => setTimeout(resolve, left));
      btn.textContent = origLabel;
      btn.disabled = false;
    }
    await loadPremium();
    _showValidateResult(!!(res && res.result && res.result.ok));
  }

  const btnValidateNow = document.getElementById('btn-validate-now');
  if (btnValidateNow) btnValidateNow.addEventListener('click', () => _runValidateNow(btnValidateNow));

  // --- Re-render on background license writes ---
  // Local-only scheduling stamps change on every background check without
  // changing anything this page shows.
  const LICENSE_SCHEDULE_KEYS = new Set([
    '_licNextCheckAt', '_licFollowUpUntil', '_licFollowUpStep', '_licLastNudgeAt',
  ]);
  const LICENSE_RELOAD_DEBOUNCE_MS = 250;
  let _licenseReloadTimer = null;

  // A check finishing in the background (alarm, follow-up after Update
  // payment, the nudge) lands here, so the page never shows a stale state.
  // Debounced: one check writes several keys. It only re-reads the status and
  // never validates, so its own work cannot trigger it again.
  function _onLicenseStorageChanged(changes, area) {
    if (area !== 'local' || !changes) return;
    const relevant = Object.keys(changes).some(k => !LICENSE_SCHEDULE_KEYS.has(k)
      && (k.startsWith('_lic') || k === '_premiumKey' || k === '_trialEnd'));
    if (!relevant) return;
    clearTimeout(_licenseReloadTimer);
    _licenseReloadTimer = setTimeout(() => {
      _licenseReloadTimer = null;
      loadPremium();
    }, LICENSE_RELOAD_DEBOUNCE_MS);
  }
  browser.storage.onChanged.addListener(_onLicenseStorageChanged);

  // --- Re-check when the user comes back from the Paddle portal ---
  // The background's follow-up ladder covers the next hours; this makes the
  // common case (fix the card, switch back to this tab) show up at once.
  const RETURN_CHECK_WINDOW_MS = 30 * 60 * 1000;
  const RETURN_CHECK_MIN_GAP_MS = 60 * 1000;
  let _manageOpenedAt = 0;
  let _lastReturnCheckAt = 0;

  function _needsPaymentAction(status) {
    return !!(status && (status.held || status.pastDue));
  }

  function _maybeRevalidateOnReturn(now) {
    if (!_manageOpenedAt || now - _manageOpenedAt > RETURN_CHECK_WINDOW_MS) return null;
    if (!_needsPaymentAction(_renderedStatus)) {
      // Resolved (or never needed): stop re-checking on focus.
      _manageOpenedAt = 0;
      return null;
    }
    if (now - _lastReturnCheckAt < RETURN_CHECK_MIN_GAP_MS) return null;
    _lastReturnCheckAt = now;
    return browser.runtime.sendMessage({ type: 'VALIDATE_LICENSE' })
      .catch(e => console.warn('[Options] Return re-check failed:', e.message))
      .then(() => loadPremium());
  }

  window.addEventListener('focus', () => _maybeRevalidateOnReturn(Date.now()));
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') _maybeRevalidateOnReturn(Date.now());
  });

  // Opening this page is a moment the user may just have fixed a payment.
  // The background re-validates only when held or past_due, at most once per
  // 5 minutes, and answers with the resulting status.
  function _sendLicenseNudge() {
    return browser.runtime.sendMessage({ type: 'LICENSE_NUDGE' })
      .then(resp => { if (resp && resp.ok && resp.status) renderPremium(resp.status); })
      .catch(e => console.warn('[Options] License nudge failed:', e.message));
  }
  _sendLicenseNudge();

  // --- Manage subscription ---
  // The /manage-url endpoint returns URLs whose token has ~24h expiry.
  // We MUST NOT persist them; a short in-memory cache (60s) is fine and
  // keeps double-clicks across the two buttons free of redundant fetches.
  const MANAGE_CACHE_TTL_MS = 60 * 1000;
  let _manageUrlsCache = null;
  let _manageUrlsCacheFetchedAt = 0;

  async function _getManageUrls() {
    if (_manageUrlsCache && (Date.now() - _manageUrlsCacheFetchedAt) < MANAGE_CACHE_TTL_MS) {
      return _manageUrlsCache;
    }
    const result = await browser.runtime.sendMessage({ type: 'GET_MANAGE_URLS' });
    if (result && result.ok) {
      _manageUrlsCache = result;
      _manageUrlsCacheFetchedAt = Date.now();
    }
    return result;
  }

  function _showManageNotice(messageKey, isError) {
    const el = document.getElementById('license-manage-notice');
    if (!el) return;
    el.className = 'license-validation__notice';
    el.classList.add(isError ? 'license-validation__notice--error' : 'license-validation__notice--warning');
    el.textContent = ProtonI18n.t(messageKey);
  }

  function _clearManageNotice() {
    const el = document.getElementById('license-manage-notice');
    if (!el) return;
    el.textContent = '';
    el.className = 'license-validation__notice hidden';
  }

  async function _handleManageClick(which) {
    const btnPay = document.getElementById('btn-manage-payment');
    const btnCancel = document.getElementById('btn-manage-cancel');
    _clearManageNotice();
    if (btnPay) btnPay.disabled = true;
    if (btnCancel) btnCancel.disabled = true;
    try {
      const result = await _getManageUrls();
      if (!result || !result.ok) {
        const isUnavailable = result && result.error === 'manage_urls_unavailable';
        _showManageNotice(isUnavailable ? 'manageUnavailable' : 'manageError', !isUnavailable);
        return;
      }
      const url = which === 'cancel' ? result.cancel : result.update_payment_method;
      if (!url) {
        _showManageNotice('manageUnavailable', false);
        return;
      }
      // Arms the re-check for when the user comes back to this tab.
      _manageOpenedAt = Date.now();
      browser.tabs.create({ url });
    } finally {
      if (btnPay) btnPay.disabled = false;
      if (btnCancel) btnCancel.disabled = false;
    }
  }

  const btnManagePayment = document.getElementById('btn-manage-payment');
  if (btnManagePayment) btnManagePayment.addEventListener('click', () => _handleManageClick('payment'));
  const btnManageCancel = document.getElementById('btn-manage-cancel');
  if (btnManageCancel) btnManageCancel.addEventListener('click', () => _handleManageClick('cancel'));

  // Format a "last validated" timestamp relative to now. Reuses the existing
  // justNow/minutesAgo/hoursAgo/daysAgo i18n keys (with $1 placeholder for
  // the number) so it matches the status-bar format already shown in popup.js.
  function _formatValidationTime(ms) {
    if (!ms) return ProtonI18n.t('neverValidated');
    const seconds = Math.floor((Date.now() - ms) / 1000);
    if (seconds < 60) return ProtonI18n.t('justNow');
    if (seconds < 3600) return ProtonI18n.t('minutesAgo', Math.floor(seconds / 60));
    if (seconds < 86400) return ProtonI18n.t('hoursAgo', Math.floor(seconds / 3600));
    return ProtonI18n.t('daysAgo', Math.floor(seconds / 86400));
  }

  // Format a Paddle ISO datetime as a localized short date. Returns '' if
  // the input is falsy or unparseable (caller hides the row in that case).
  function _formatPeriodDate(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    try {
      return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
    } catch (e) {
      return d.toISOString().slice(0, 10);
    }
  }

  // The translated label for an error code, or the fallback key's text. The
  // `|| err` this replaces never fired: t() answers a missing key with the
  // key itself, so an unknown code showed "err_subscription_unpaid" verbatim.
  function _errLabel(code, fallbackKey) {
    if (code) {
      const key = 'err_' + code;
      const label = ProtonI18n.t(key);
      if (label && label !== key) return label;
    }
    return ProtonI18n.t(fallbackKey);
  }

  // Most err_ labels are lowercase fragments written for the grace notice's
  // ({reason}) slot. Shown on their own, they start with a capital letter.
  function _sentence(label) {
    if (!label) return label;
    const lang = typeof ProtonI18n.getLanguage === 'function' ? ProtonI18n.getLanguage() : undefined;
    let first;
    try { first = label.charAt(0).toLocaleUpperCase(lang); } catch (_) { first = label.charAt(0).toUpperCase(); }
    return first + label.slice(1);
  }

  // Deliberately not translated: an address, the same in every language.
  const SUPPORT_EMAIL = 'support+mcpm@olausson.de';

  function _supportLink() {
    const link = document.createElement('a');
    link.href = 'mailto:' + SUPPORT_EMAIL;
    // A web mail handler (Gmail, Proton) must not load inside this embedded page.
    link.target = '_blank';
    link.rel = 'noopener';
    link.textContent = SUPPORT_EMAIL;
    return link;
  }

  // Populate the notice box under the license block. One notice, the first
  // that applies: held (unpaid, paused), locked, grace, past_due, then the
  // scheduled cancel date. Text only: the Update payment button sits above.
  function _renderValidationNotice(el, status) {
    el.className = 'license-validation__notice';
    el.textContent = '';

    const err = status.lastValidationError;
    const change = status.scheduledChange;
    const endsOn = change && change.action === 'cancel' ? _formatPeriodDate(change.effective_at) : '';

    if (status.held === 'paused') {
      el.classList.add('license-validation__notice--error');
      el.appendChild(document.createTextNode(ProtonI18n.t('noticePaused') + ' '));
      el.appendChild(_supportLink());
      return;
    }
    if (status.held) {
      el.classList.add('license-validation__notice--error');
      el.textContent = ProtonI18n.t('noticeUnpaid');
      return;
    }
    if (status.locked) {
      el.classList.add('license-validation__notice--error');
      // Like its grace notice, a key Paddle cannot confirm gets its own
      // message, which says what to do about it.
      if (err === 'license_unconfirmed') {
        el.textContent = ProtonI18n.t('validationLockedUnconfirmed');
        return;
      }
      const msg = ProtonI18n.t('validationLocked');
      const reason = err ? ' (' + _errLabel(err, 'err_validation_problem') + ')' : '';
      el.textContent = msg + reason;
      return;
    }
    if (status.inGracePeriod) {
      el.classList.add('license-validation__notice--warning');
      const days = status.graceRemainingDays;
      // {days} is a pluralised phrase (see trialBannerTitle above); {reason} is
      // already a translated error label, so it goes in as-is. A key Paddle
      // cannot confirm gets its own notice, which says what to do about it.
      const graceKey = err === 'license_unconfirmed' ? 'validationGraceUnconfirmed' : 'validationGrace';
      el.textContent = ProtonI18n.t(graceKey)
        .replace('{days}', ProtonI18n.plural('dayCount', days))
        .replace('{reason}', _errLabel(err, 'err_validation_problem'));
      return;
    }
    if (status.pastDue) {
      el.classList.add('license-validation__notice--warning');
      el.textContent = ProtonI18n.t('noticePastDue');
      return;
    }
    if (endsOn) {
      el.classList.add('license-validation__notice--info');
      el.textContent = ProtonI18n.t('noticeEndsOn').replace('{date}', endsOn);
      return;
    }
    // No notice: everything healthy.
    el.classList.add('hidden');
  }
})();
