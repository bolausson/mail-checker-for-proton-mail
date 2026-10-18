/**
 * Popup script for Proton Mail Checker.
 * Supports multiple accounts, message list, preview, and quick actions.
 */

(function () {
  // Auto-dismiss delay (ms) shared by the popup toasts (upgrade prompt + undo).
  const TOAST_DURATION_MS = 5000;

  // DOM refs
  const stateAccounts = document.getElementById('state-accounts');
  const stateLoading = document.getElementById('state-loading');
  const stateError = document.getElementById('state-error');
  const stateNormal = document.getElementById('state-normal');
  const messageList = document.getElementById('message-list');
  const emptyInbox = document.getElementById('empty-inbox');
  const accountPillsEl = document.getElementById('account-pills');
  const lastCheckedEl = document.getElementById('last-checked');
  const errorMessageEl = document.getElementById('error-message');
  const errorLicenseBanner = document.getElementById('error-license-banner');

  const accountsList = document.getElementById('accounts-list');
  const loginForm = document.getElementById('login-form');
  const loginUsername = document.getElementById('login-username');
  const loginPassword = document.getElementById('login-password');
  const loginError = document.getElementById('login-error');
  const btnLoginSubmit = document.getElementById('btn-login-submit');
  const twofaForm = document.getElementById('twofa-form');
  const twofaCode = document.getElementById('twofa-code');
  const btnTwofaSubmit = document.getElementById('btn-twofa-submit');
  const btnTwofaCancel = document.getElementById('btn-twofa-cancel');
  const twofaChoice = document.getElementById('twofa-choice');
  const btnTwofaTotp = document.getElementById('btn-twofa-totp');
  const btnTwofaFido2 = document.getElementById('btn-twofa-fido2');
  const btnTwofaChoiceCancel = document.getElementById('btn-twofa-choice-cancel');
  const twofaFido2Info = document.getElementById('twofa-fido2-info');
  const btnFido2Cancel = document.getElementById('btn-fido2-cancel');
  const mailboxPwdForm = document.getElementById('mailbox-pwd-form');
  const mailboxPwdInput = document.getElementById('mailbox-pwd-input');
  const btnMailboxPwdSubmit = document.getElementById('btn-mailbox-pwd-submit');
  const btnMailboxPwdCancel = document.getElementById('btn-mailbox-pwd-cancel');

  const previewPanel = document.getElementById('preview-panel');
  const previewSender = document.getElementById('preview-sender');
  const previewTime = document.getElementById('preview-time');
  const previewReplyState = document.getElementById('preview-reply-state');
  const previewTo = document.getElementById('preview-to');
  const previewSubject = document.getElementById('preview-subject');
  const previewLabels = document.getElementById('preview-labels');
  const previewActionsEl = document.getElementById('preview-actions');
  const previewBody = document.getElementById('preview-body');
  const calendarInviteEl = document.getElementById('calendar-invite');
  const externalContentBanner = document.getElementById('external-content-banner');
  const btnLoadExternal = document.getElementById('btn-load-external');
  const previewAvatar = document.getElementById('preview-avatar');
  const btnClosePreview = document.getElementById('btn-close-preview');
  const btnPrevMsg = document.getElementById('btn-prev-msg');
  const btnNextMsg = document.getElementById('btn-next-msg');
  const btnToggleFormat = document.getElementById('btn-toggle-format');
  const btnToggleCanvas = document.getElementById('btn-toggle-canvas');
  const btnPreviewOpen = document.getElementById('btn-preview-open');
  const btnPreviewPopout = document.getElementById('btn-preview-popout');

  const snoozeMenu = document.getElementById('snooze-menu');
  const dndMenu = document.getElementById('dnd-menu');
  const replyText = document.getElementById('reply-text');
  const replyBody = document.getElementById('reply-body');
  const replyEditorToolbar = document.getElementById('reply-editor-toolbar');
  const previewReply = document.getElementById('preview-reply');
  const btnReplySend = document.getElementById('btn-reply-send');
  const btnReplySendArchive = document.getElementById('btn-reply-send-archive');
  const btnReplyMode = document.getElementById('btn-reply-mode');
  const btnReplyAllMode = document.getElementById('btn-reply-all-mode');
  const btnForwardMode = document.getElementById('btn-forward-mode');
  const replyFromRow = document.getElementById('reply-from-row');
  const replyFromSelect = document.getElementById('reply-from');
  const forwardToRow = document.getElementById('forward-to-row');
  const forwardToInput = document.getElementById('forward-to');
  const replyCcBccRows = document.getElementById('reply-cc-bcc-rows');
  const replyCcInput = document.getElementById('reply-cc');
  const replyBccInput = document.getElementById('reply-bcc');
  const btnReplyToggleCc = document.getElementById('btn-reply-toggle-cc');

  const btnDnd = document.getElementById('btn-dnd');
  const btnAccount = document.getElementById('btn-account');
  const btnRefresh = document.getElementById('btn-refresh');
  const btnSettings = document.getElementById('btn-settings');
  const btnPopout = document.getElementById('btn-popout');
  const btnUpgrade = document.getElementById('btn-upgrade');
  const btnRetry = document.getElementById('btn-retry');
  const btnOpen = document.getElementById('btn-open');
  const btnCollapseAll = document.getElementById('btn-collapse-all');

  const ICON_ACCOUNT = '<svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M8 8a3 3 0 1 0 0-6 3 3 0 0 0 0 6zm2-3a2 2 0 1 1-4 0 2 2 0 0 1 4 0zm4 8c0 1-1 1-1 1H3s-1 0-1-1 1-4 6-4 6 3 6 4zm-1-.004c-.001-.246-.154-.986-.832-1.664C11.516 10.68 10.289 10 8 10c-2.29 0-3.516.68-4.168 1.332-.678.678-.83 1.418-.832 1.664h10z"/></svg>';
  const ICON_BACK = '<svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path fill-rule="evenodd" d="M15 8a.5.5 0 0 0-.5-.5H2.707l3.147-3.146a.5.5 0 1 0-.708-.708l-4 4a.5.5 0 0 0 0 .708l4 4a.5.5 0 0 0 .708-.708L2.707 8.5H14.5A.5.5 0 0 0 15 8z"/></svg>';

  /** Parse an HTML string and set it as the content of an element (avoids innerHTML). */
  function _setHTML(el, html) {
    const parsed = new DOMParser().parseFromString(html, 'text/html');
    el.replaceChildren(...parsed.body.childNodes);
  }

  let _selectedMsg = null;
  let _snoozeTargetConversationIds = null;
  let _snoozeTargetAccountId = null;
  let _accountSections = []; // { collapseBtn, items, collapsed } per account
  let _savedState = null;
  let _showingAccounts = false;
  let _settings = {};

  // Debug-mode console capture (mirrors the background's): when debug logging is
  // on, forward popup warnings/errors + uncaught failures to the background's
  // ProtonDiag buffer (tagged ctx=popup), so the exported diagnostic log includes
  // the popup side of an issue. Gated behind the debugLogging flag; off in normal use.
  (function _installPopupDiagCapture() {
    let dbg = false, cap = false;
    browser.storage.local.get('debugLogging').then(d => { dbg = !!d.debugLogging; }).catch(() => {});
    browser.storage.onChanged.addListener((c, area) => {
      if (area === 'local' && c.debugLogging) dbg = !!c.debugLogging.newValue;
    });
    const fmt = (a) => typeof a === 'string' ? a
      : a instanceof Error ? (a.stack || (a.name + ': ' + a.message))
      : (() => { try { return JSON.stringify(a); } catch (_) { return String(a); } })();
    const send = (level, args) => {
      if (!dbg || cap) return;
      cap = true;
      try {
        const msg = args.map(fmt).join(' ').replace(/\s+/g, ' ').slice(0, 1500);
        browser.runtime.sendMessage({ type: 'DIAG_CAPTURE', level, msg }).catch(() => {});
      } catch (_) { /* never break the popup */ }
      cap = false;
    };
    for (const level of ['warn', 'error']) {
      const orig = (console[level] || console.log).bind(console);
      console[level] = (...args) => { orig(...args); send(level, args); };
    }
    window.addEventListener('error', (e) => send('uncaught',
      [(e && (e.error ? (e.error.stack || e.error.message) : e.message)) + (e && e.filename ? ' @ ' + e.filename + ':' + e.lineno : '')]));
    window.addEventListener('unhandledrejection', (e) => send('rejection', [fmt(e && e.reason)]));
  })();
  let _rawPreviewBody = null;
  // Embedded (cid:) images resolved to data: URLs, keyed by bare Content-ID.
  // Rebuilt per message and held in memory only, never persisted.
  let _inlineImages = new Map();
  // An embedded image larger than this stays in the attachment list rather than
  // being inlined, so one huge picture cannot bloat the iframe srcdoc.
  const INLINE_IMAGE_MAX_BYTES = 12 * 1024 * 1024;
  let _previewMode = 'html'; // 'html', 'text', 'raw'
  let _replyMode = 'reply'; // 'reply' | 'replyAll' | 'forward'
  let composeSendOpts = null; // PopupSendOptions controller for the composer
  let replySendOpts = null;   // PopupSendOptions controller for the reply/forward editor
  let composeDriveShare = null; // PopupDriveShare controller for the composer
  let replyDriveShare = null;   // PopupDriveShare controller for the reply/forward editor
  const _labelCache = {}; // accountId -> { labels: [], folders: [] }
  let _focusedIndex = -1;
  let _undoTimer = null;
  let _undoCallback = null;
  let _pendingOptimistic = []; // { ids?, conversationIds?, action, snapshot }
  // Actions that remove a message from the unread-inbox view. MARK_READ counts
  // because the monitored list is unread-only. SNOOZE removes by conversation.
  const REMOVE_ACTIONS = ['TRASH', 'ARCHIVE', 'MOVE_TO_FOLDER', 'REPORT_PHISHING', 'MARK_READ', 'DELETE_PERMANENTLY'];
  const CONV_REMOVE_ACTIONS = ['SNOOZE'];
  let _draftDebounce = null;
  let _restoringDraft = false; // guard to avoid re-saving during restore

  // Public pricing / info page: opened from "Upgrade" entry points so the
  // user sees the plan comparison before hitting the payment page.
  const PRICING_URL = 'https://apps.olausson.de/#mail-checker-pricing';

  // Premium state, populated from GET_STATE. Mirrors ProtonPremium.getStatus().
  // `premium` is the only flag used for gating; the rest drive UI (trial badge,
  // license banner, etc.). `held` ('unpaid' | 'paused') means a subscription key
  // is stored but Paddle has not collected for it, so Premium is off.
  let _premium = {
    premium: false, licensed: false, trialing: false, trialAvailable: true, trialDaysRemaining: 0, licenseKeyMasked: null,
    keyStored: false, held: null, pastDue: false, scheduledChange: null, nextBilledAt: null, trialActive: false, clearedReason: null,
  };
  function isPremium() { return !!_premium.premium; }

  // Banner text per license state. The banner names the subscription problem
  // only; the options page carries the full notice.
  const LICENSE_BANNER_TEXT = {
    pastDue: 'popupLicensePastDue',
    unpaid: 'popupLicenseUnpaid',
    paused: 'popupLicensePaused',
  };

  /** Which license banner applies: 'unpaid' / 'paused' (held), 'pastDue', or null. */
  function _licenseBannerState(premium) {
    if (!premium) return null;
    if (premium.held === 'unpaid' || premium.held === 'paused') return premium.held;
    if (premium.pastDue) return 'pastDue';
    return null;
  }

  /**
   * Open Paddle's update-payment page for the stored subscription. The portal
   * URL carries a short-lived token, so it is fetched on every click and never
   * cached. Asking for it also starts the background's quick re-checks, so
   * Premium comes back within minutes of the payment going through. Without a
   * URL (proxy down, no key) the options page is the next best place.
   */
  async function _openUpdatePayment(btn) {
    if (btn) {
      if (btn.disabled) return;
      btn.disabled = true;
    }
    try {
      let res = null;
      try {
        res = await browser.runtime.sendMessage({ type: 'GET_MANAGE_URLS' });
      } catch (_) { /* background unavailable: fall back below */ }
      if (res && res.ok && res.update_payment_method) {
        browser.tabs.create({ url: res.update_payment_method });
      } else {
        browser.runtime.openOptionsPage();
      }
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  /**
   * The one thing a user with a license problem can do from the popup: fix the
   * payment, or, for a paused subscription (no self-service resume), open the
   * settings page, whose notice explains the options.
   */
  function _runLicenseAction(state, btn) {
    if (state === 'paused') {
      browser.runtime.openOptionsPage();
      return Promise.resolve();
    }
    return _openUpdatePayment(btn);
  }

  /**
   * Render the license banner as the first li of `listEl` for a past-due,
   * unpaid or paused subscription; nothing otherwise. It concerns every
   * account, so it sits above the per-account sections, and it is not
   * dismissible: it goes away when Paddle's answer changes. Returns the li or null.
   */
  function _renderLicenseBanner(listEl, premium) {
    for (const old of listEl.querySelectorAll(':scope > .license-banner')) old.remove();
    const state = _licenseBannerState(premium);
    if (!state) return null;
    const banner = document.createElement('li');
    banner.className = 'account-status-banner license-banner';
    const icon = document.createElement('span');
    icon.className = 'status-banner-icon';
    icon.textContent = '\u26A0'; // ⚠
    banner.appendChild(icon);
    const text = document.createElement('span');
    text.textContent = ProtonI18n.t(LICENSE_BANNER_TEXT[state]);
    banner.appendChild(text);
    const btn = document.createElement('button');
    btn.className = 'banner-sign-in-btn';
    btn.textContent = ProtonI18n.t(state === 'paused' ? 'settings' : 'manageUpdatePayment');
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      _runLicenseAction(state, btn);
    });
    banner.appendChild(btn);
    listEl.insertBefore(banner, listEl.firstChild);
    return banner;
  }

  // Translate known background error codes to localized strings. Pass
  // through anything we don't recognize so unexpected errors stay
  // debuggable.
  function _localizeError(err) {
    if (err === 'PREMIUM_REQUIRED') return ProtonI18n.t('premiumRequired');
    return err;
  }

  /**
   * Whether premium-only UI elements should be rendered.
   * - Premium users: always true (elements are functional).
   * - Free users with `hidePremiumUI` setting: false (hide entirely so the
   *   popup isn't cluttered with non-functional buttons).
   * - Free users by default: true (show the buttons; clicking triggers the
   *   upgrade toast so the feature is discoverable).
   */
  function showPremiumUI() {
    if (isPremium()) return true;
    return !_settings.hidePremiumUI;
  }

  /**
   * Call from a click handler when the action is premium-only.
   * Shows an upgrade prompt and returns true so the caller can `if (!requirePremium()) return;`
   */
  function requirePremium(featureKey) {
    if (isPremium()) return true;
    showUpgradePrompt(featureKey);
    return false;
  }

  /**
   * Update the header upgrade button visibility + label based on current premium state.
   * Shown only on free tier (or trialing, with days remaining in the tooltip).
   */
  function _renderPremiumHeaderBadge() {
    if (!btnUpgrade) return;
    // A held user already has a subscription: never sell them a second one.
    const hideButton = !!_premium.held || (isPremium() && !_premium.trialing);
    btnUpgrade.classList.toggle('hidden', hideButton);
    if (_premium.trialing && _premium.trialDaysRemaining > 0) {
      btnUpgrade.title = ProtonI18n.t('trialActive') + ': ' + _premium.trialDaysRemaining + 'd';
    } else {
      btnUpgrade.title = ProtonI18n.t('upgrade');
    }
  }

  /**
   * Show a transient upgrade prompt. Currently reuses the undo-toast styling.
   * Keeps the user in the popup; clicking "Upgrade" opens Paddle checkout in a new tab.
   */
  function showUpgradePrompt(_featureKey) {
    // _featureKey is threaded through from requirePremium() but the prompt is
    // currently generic; kept (underscore-prefixed) to reserve the call shape
    // for a future feature-specific upsell message.
    // Avoid piling up prompts
    const existing = document.getElementById('upgrade-toast');
    if (existing) existing.remove();

    const toast = document.createElement('div');
    toast.id = 'upgrade-toast';
    toast.className = 'upgrade-toast';
    const msg = document.createElement('span');
    msg.textContent = ProtonI18n.t('premiumRequired');
    const btn = document.createElement('button');
    btn.className = 'upgrade-toast-btn';
    // A held subscription gets Premium back by being paid, not by buying
    // another one, so the prompt leads to the license action instead.
    const held = _premium.held;
    btn.textContent = !held ? ProtonI18n.t('upgrade')
      : ProtonI18n.t(held === 'paused' ? 'settings' : 'manageUpdatePayment');
    btn.addEventListener('click', () => {
      if (held) _runLicenseAction(held, btn);
      else browser.tabs.create({ url: PRICING_URL });
      toast.remove();
    });
    toast.appendChild(msg);
    toast.appendChild(btn);
    document.body.appendChild(toast);
    // Auto-dismiss after 5s
    setTimeout(() => { if (toast.parentNode) toast.remove(); }, TOAST_DURATION_MS);
  }

  const allStates = [stateAccounts, stateLoading, stateError, stateNormal];

  // True when running in a popped-out standalone window (?standalone=1). Such
  // windows fill/track the OS window rather than the fixed popup dimensions.
  const IS_STANDALONE = new URLSearchParams(location.search).get('standalone') === '1';

  /**
   * Mirror the *effective* theme / colour-scheme / density to localStorage so
   * theme-boot.js can replay it synchronously on the next open and avoid a
   * flash of the default light palette. Reads the values actually applied to
   * <body> (post premium-gating), so it stays correct for free + premium.
   */
  function _persistThemeBoot() {
    try {
      let density = 'comfortable';
      if (document.body.classList.contains('density-cozy')) density = 'cozy';
      else if (document.body.classList.contains('density-compact')) density = 'compact';
      localStorage.setItem('mcpm-theme-boot', JSON.stringify({
        theme: document.body.getAttribute('data-theme') || 'classic',
        colorScheme: document.body.getAttribute('data-color-scheme') || 'light',
        density,
        // Mirror the applied popup size so theme-boot.js can set it SYNCHRONOUSLY
        // before first paint. Otherwise the popup opens at the CSS default size
        // until applyDensity() runs, which on a cold start is gated behind the
        // background's first poll (GET_PREMIUM_STATUS). Reads the post-premium /
        // post-standalone values off body.style (applyDensity already set them;
        // they are '' in standalone mode), so no gating logic is duplicated.
        width: document.body.style.width || '',
        height: document.body.style.height || '',
      }));
    } catch (e) { /* localStorage may be unavailable; non-fatal */ }
  }

  /** Resolve and apply the color scheme (light/dark/auto) to the body. */
  function _applyColorScheme(scheme) {
    // Free tier: always "auto" (follow OS). Premium: honor user's choice.
    let resolved = isPremium() ? (scheme || 'auto') : 'auto';
    if (resolved === 'auto') {
      resolved = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    }
    document.body.setAttribute('data-color-scheme', resolved);
  }

  /** Inject or update the user's custom CSS <style> block. */
  function _applyCustomCSS(css) {
    // Free tier: no custom CSS (premium-only).
    const effective = isPremium() ? css : '';
    let el = document.getElementById('user-custom-css');
    if (!effective) {
      if (el) el.remove();
      return;
    }
    if (!el) {
      el = document.createElement('style');
      el.id = 'user-custom-css';
      document.head.appendChild(el);
    }
    el.textContent = effective;
  }

  /** Set the popup theme, forcing "classic" for free users. */
  function _applyTheme() {
    const theme = isPremium() ? (_settings.theme || 'classic') : 'classic';
    document.body.setAttribute('data-theme', theme);
  }

  // Live-update color scheme when OS theme changes (for "auto" mode)
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if ((_settings.colorScheme || 'auto') === 'auto') _applyColorScheme('auto');
  });

  async function loadSettings() {
    const stored = await browser.storage.local.get('settings');
    _settings = stored.settings || {};
    if (typeof ProtonI18n !== 'undefined') {
      ProtonI18n.setLanguage(_settings.language || 'en');
      ProtonI18n.applyTranslations();
    }
    _applyFormatSettings();
  }

  /** Apply all premium-gated visual settings (theme, color scheme,
   *  custom CSS). Split out of loadSettings so the IIFE can defer
   *  this until GET_PREMIUM_STATUS has resolved. Otherwise
   *  _applyTheme would see premium=false on cold open and force
   *  'classic', then re-apply after premium loads, causing a flash. */
  function _applyVisualSettings() {
    _applyTheme();
    _applyColorScheme(_settings.colorScheme || 'auto');
    _applyCustomCSS(_settings.customCSS || '');
  }

  /** Show/hide editor toolbars based on compose/reply format settings. */
  function _applyFormatSettings() {
    const composeToolbar = document.getElementById('compose-editor-toolbar');
    const composeHtml = (_settings.composeFormat || 'html') === 'html';
    composeToolbar.classList.toggle('hidden', !composeHtml);

    const replyHtml = _settings.replyFormat === 'html';
    replyEditorToolbar.classList.toggle('hidden', !replyHtml);
    replyText.classList.toggle('hidden', replyHtml);
    replyBody.classList.toggle('hidden', !replyHtml);

    // Apply spellcheck language to all editor elements
    _applySpellcheckLang();
  }

  function _getSpellcheckLang() {
    const s = _settings.spellcheckLanguage || 'auto';
    return s === 'auto' ? navigator.language.split('-')[0] : s;
  }

  function _applySpellcheckLang(lang) {
    const l = lang || _getSpellcheckLang();
    const composeEl = document.getElementById('compose-body');
    if (composeEl) composeEl.setAttribute('lang', l);
    replyBody.setAttribute('lang', l);
    replyText.setAttribute('lang', l);
    // Update toolbar switchers if they exist
    document.querySelectorAll('.spellcheck-lang-select').forEach(sel => { sel.value = l; });
  }

  // Color picker: extracted to popup/color-picker.js (PopupColorPicker global)
  const _createColorPicker = PopupColorPicker.create;
  const _luminance = PopupColorPicker.luminance;

  // Position an open account color-picker panel inside the popup viewport.
  // The panel is position:fixed (so it escapes the scrolling account list's
  // overflow); without explicit coordinates it sits at its in-flow spot beside
  // the swatch, which is near the right edge, and gets clipped. Anchor its
  // right edge to the button, clamp horizontally into the viewport, and open
  // below the button (flipping above if there isn't room).
  function _positionColorPickerPanel(btn, panel) {
    const r = btn.getBoundingClientRect();
    const vw = document.documentElement.clientWidth;
    const vh = document.documentElement.clientHeight;
    const margin = 8;
    const pw = panel.offsetWidth || 240;
    const ph = panel.offsetHeight || 300;
    const left = Math.max(margin, Math.min(r.right - pw, vw - pw - margin));
    let top = r.bottom + 4;
    if (top + ph > vh - margin) top = Math.max(margin, r.top - ph - 4);
    panel.style.left = left + 'px';
    panel.style.top = top + 'px';
  }

  // --- Utilities ---

  function formatRelativeTime(timestamp) {
    if (!timestamp) return '';
    const diff = Math.floor((Date.now() - timestamp) / 1000);
    if (diff < 60) return ProtonI18n.t('justNow');
    if (diff < 3600) return ProtonI18n.t('minutesAgo', Math.floor(diff / 60));
    if (diff < 86400) return ProtonI18n.t('hoursAgo', Math.floor(diff / 3600));
    return ProtonI18n.t('daysAgo', Math.floor(diff / 86400));
  }

  function formatMessageTime(unixTimestamp) {
    if (!unixTimestamp) return '';
    const date = new Date(unixTimestamp * 1000);
    const now = new Date();
    const diffDays = Math.floor((now - date) / 86400000);
    const hourOpt = _settings.use24HourTime ? { hour: '2-digit', minute: '2-digit', hour12: false } : { hour: '2-digit', minute: '2-digit' };
    if (diffDays === 0) return date.toLocaleTimeString([], hourOpt);
    if (diffDays === 1) return ProtonI18n.t('yesterday');
    if (diffDays < 7) return date.toLocaleDateString([], { weekday: 'short' });
    return date.toLocaleDateString([], { month: 'short', day: 'numeric' });
  }

  function formatFullTime(unixTimestamp) {
    if (!unixTimestamp) return '';
    const opts = { weekday: 'short', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' };
    if (_settings.use24HourTime) opts.hour12 = false;
    return new Date(unixTimestamp * 1000).toLocaleString([], opts);
  }

  /**
   * Which replied/forwarded arrows a message should show.
   *
   * IsReplied / IsRepliedAll / IsForwarded ride along on every message from
   * the list endpoint, and Proton treats them as independent flags: a message
   * can be both replied to and forwarded, so the forward arrow is a SECOND
   * icon, not a replacement. The two reply flags are the exception, since
   * replied-all implies replied and drawing both would render three arrows.
   * U+FE0E pins each arrow to its text form so it never becomes a colour emoji.
   *
   * One function for both call sites (list row and open message) so the two
   * can never disagree about what a flag combination looks like.
   */
  function _replyStateIcons(msg) {
    if (!msg) return [];
    const icons = [];
    if (msg.IsRepliedAll) {
      icons.push({ state: 'replied-all', glyph: '\u21A9\uFE0E\u21A9\uFE0E', titleKey: 'repliedToAll' });
    } else if (msg.IsReplied) {
      icons.push({ state: 'replied', glyph: '\u21A9\uFE0E', titleKey: 'repliedTo' });
    }
    if (msg.IsForwarded) {
      icons.push({ state: 'forwarded', glyph: '\u21AA\uFE0E', titleKey: 'forwarded' });
    }
    return icons;
  }

  /**
   * Fill `container` with those arrows, emptying it first. The reader reuses
   * one element for every message it opens, so clearing is what keeps a
   * message without the flags from inheriting the last one's arrow.
   */
  /**
   * Repaint the reply-state icons on an already-rendered list row.
   *
   * The row sits behind the open preview, so without this it would keep the
   * pre-send icons until something triggered a full re-render. The row only
   * carries the span when it had icons to show, so one may have to be created
   * and put back in its place, immediately before the time.
   */
  function _refreshListReplyState(messageId, msg) {
    if (!messageList) return;
    for (const row of messageList.querySelectorAll('[data-message-id]')) {
      if (row.dataset.messageId !== messageId) continue;
      const topRow = row.querySelector('.msg-top-row');
      if (!topRow) return;
      let el = topRow.querySelector('.msg-reply-state');
      if (!el) {
        el = document.createElement('span');
        el.className = 'msg-reply-state';
        topRow.insertBefore(el, topRow.querySelector('.msg-time'));
      }
      _renderReplyState(el, msg);
      return;
    }
  }

  function _renderReplyState(container, msg) {
    if (!container) return;
    container.textContent = '';
    for (const icon of _replyStateIcons(msg)) {
      const el = document.createElement('span');
      el.className = 'reply-state-icon';
      el.dataset.state = icon.state;
      el.title = ProtonI18n.t(icon.titleKey);
      el.textContent = icon.glyph;
      container.appendChild(el);
    }
  }

  // Map a send error code (from the background send-options guards) to a friendly,
  // localized toast; fall back to the raw error for anything else.
  function _sendErrorMessage(err) {
    switch (err) {
      case 'PREMIUM_REQUIRED': return ProtonI18n.t('upgradeRequired');
      case 'EXPIRY_REQUIRES_EO_PASSWORD': return ProtonI18n.t('expiryRequiresPassword');
      // Both mean the same thing to the user: we could not confirm how to
      // encrypt for a recipient, so nothing was sent.
      case 'RECIPIENT_KEYS_UNAVAILABLE':
      case 'RECIPIENT_KEYS_UNREADABLE': return ProtonI18n.t('recipientKeysUnavailable');
      // Proton rejected the send and kept rejecting it through every retry. Its
      // own text says to sign out and back in, which is wrong and would cost a
      // re-login for nothing.
      case 'SEND_TEMPORARILY_REJECTED': return ProtonI18n.t('sendTemporarilyRejected');
      case 'EO_PASSWORD_TOO_SHORT': return ProtonI18n.t('eoPasswordTooShort');
      case 'DELIVERY_TIME_INVALID': return ProtonI18n.t('deliveryTimeInvalid');
      case 'EXPIRY_INVALID': return ProtonI18n.t('expiryTooLong');
      default: return ProtonI18n.t('sendFailed') + ': ' + err;
    }
  }

  function showToast(text, undoCallback) {
    if (_undoTimer) clearTimeout(_undoTimer);
    _undoCallback = null;

    let toast = document.querySelector('.toast');
    if (!toast) {
      toast = document.createElement('div');
      toast.className = 'toast';
      document.body.appendChild(toast);
    }

    toast.textContent = '';
    if (undoCallback) {
      const span = document.createElement('span');
      span.textContent = text;
      const undoBtn = document.createElement('button');
      undoBtn.className = 'toast-undo';
      undoBtn.textContent = ProtonI18n.t('undo');
      undoBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (_undoCallback) {
          _undoCallback();
          _undoCallback = null;
        }
        toast.classList.remove('visible');
        if (_undoTimer) clearTimeout(_undoTimer);
      });
      toast.appendChild(span);
      toast.appendChild(undoBtn);
      _undoCallback = undoCallback;
      toast.classList.add('visible');
      _undoTimer = setTimeout(() => {
        toast.classList.remove('visible');
        _undoCallback = null;
      }, TOAST_DURATION_MS);
    } else {
      toast.textContent = text;
      toast.classList.add('visible');
      _undoTimer = setTimeout(() => toast.classList.remove('visible'), _toastDurationMs(text));
    }
  }

  /**
   * How long a toast stays up, scaled to how much there is to read.
   *
   * A flat 4.5s was fine for "Message sent" and far too short for the error
   * messages that actually need reading, which are the ones that explain what
   * went wrong and what to do about it. Roughly 18 characters per second after
   * a fixed beat to notice it appearing, floored so short messages are
   * unchanged and capped so nothing lingers.
   */
  function _toastDurationMs(text) {
    const len = String(text || '').length;
    return Math.min(12000, Math.max(4500, 1500 + len * 55));
  }

  function showState(stateName) {
    for (const el of allStates) el.classList.add('hidden');
    const map = { accounts: stateAccounts, loading: stateLoading, error: stateError, normal: stateNormal };
    if (map[stateName]) map[stateName].classList.remove('hidden');
  }

  /** Show the error view. It has no message list, so it carries its own
   *  license banner: a payment problem still needs saying when mail fails. */
  function _showErrorState(text) {
    showState('error');
    errorMessageEl.textContent = text;
    errorLicenseBanner.textContent = '';
    const banner = _renderLicenseBanner(errorLicenseBanner, _premium);
    errorLicenseBanner.classList.toggle('hidden', !banner);
  }

  // --- Account Management ---

  function renderAccountsList(accounts) {
    accountsList.textContent = '';

    if (!accounts || accounts.length === 0) {
      const empty = document.createElement('li');
      empty.className = 'accounts-empty';
      empty.textContent = ProtonI18n.t('noAccountsConfigured');
      accountsList.appendChild(empty);
      return;
    }

    for (const acc of accounts) {
      const li = document.createElement('li');
      li.className = 'account-item';

      const info = document.createElement('div');
      info.className = 'account-info';

      const email = document.createElement('span');
      email.className = 'account-email';
      email.textContent = acc.email || acc.username;

      const status = document.createElement('span');
      status.className = 'account-status';
      const parts = [];
      if (acc.unreadCount > 0) parts.push(ProtonI18n.t('unreadMessages', acc.unreadCount));
      if (acc.keysUnlocked) parts.push('decryption active');
      status.textContent = parts.join(' · ') || ProtonI18n.t('connected');

      info.appendChild(email);
      info.appendChild(status);

      // Collapsible details toggle
      const detailsWrap = document.createElement('div');
      detailsWrap.className = 'account-details hidden';
      const toggleBtn = document.createElement('button');
      toggleBtn.className = 'account-toggle-btn';
      toggleBtn.title = ProtonI18n.t('settings');
      _setHTML(toggleBtn, '<svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor"><path fill-rule="evenodd" d="M1.646 4.646a.5.5 0 0 1 .708 0L8 10.293l5.646-5.647a.5.5 0 0 1 .708.708l-6 6a.5.5 0 0 1-.708 0l-6-6a.5.5 0 0 1 0-.708z"/></svg>');
      toggleBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        detailsWrap.classList.toggle('hidden');
        toggleBtn.classList.toggle('expanded');
      });
      info.appendChild(toggleBtn);

      // Per-account customization row
      const customRow = document.createElement('div');
      customRow.className = 'account-custom-row';

      const labelInput = document.createElement('input');
      labelInput.type = 'text';
      labelInput.className = 'account-label-input';
      labelInput.placeholder = ProtonI18n.t('labelPlaceholder');
      labelInput.value = acc.label || '';
      labelInput.title = ProtonI18n.t('customLabel');

      const initialsInput = document.createElement('input');
      initialsInput.type = 'text';
      initialsInput.className = 'account-initials-input';
      initialsInput.maxLength = 2;
      initialsInput.placeholder = _getAccountInitials(acc.label || acc.email || '');
      initialsInput.value = acc.initials || '';
      initialsInput.title = ProtonI18n.t('badgeInitials');

      labelInput.addEventListener('change', () => {
        const newLabel = labelInput.value.trim();
        // Auto-update initials placeholder when label changes
        initialsInput.placeholder = _getAccountInitials(newLabel || acc.email || '');
        browser.runtime.sendMessage({
          type: 'UPDATE_ACCOUNT_SETTINGS',
          accountId: acc.id,
          settings: { label: newLabel },
        });
      });

      initialsInput.addEventListener('change', () => {
        browser.runtime.sendMessage({
          type: 'UPDATE_ACCOUNT_SETTINGS',
          accountId: acc.id,
          settings: { initials: initialsInput.value.trim().toUpperCase() },
        });
      });

      customRow.appendChild(labelInput);
      customRow.appendChild(initialsInput);

      const colorWrap = document.createElement('div');
      colorWrap.className = 'account-color-wrap';
      const colorBtn = document.createElement('button');
      colorBtn.className = 'account-color-btn';
      colorBtn.title = ProtonI18n.t('accountColor');
      colorBtn.style.background = acc.color || '#6D4AFF';

      const picker = _createColorPicker(acc.color || '#6D4AFF', (c) => {
        colorBtn.style.background = c;
        browser.runtime.sendMessage({
          type: 'UPDATE_ACCOUNT_SETTINGS',
          accountId: acc.id,
          settings: { color: c },
        });
      });

      colorBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        document.querySelectorAll('.color-picker-panel.open').forEach(p => p.classList.remove('open'));
        const willOpen = !picker.classList.contains('open');
        picker.classList.toggle('open');
        if (willOpen) _positionColorPickerPanel(colorBtn, picker);
      });
      colorWrap.appendChild(colorBtn);
      colorWrap.appendChild(picker);
      customRow.appendChild(colorWrap);

      const notifToggle = document.createElement('label');
      notifToggle.className = 'account-notif-toggle';
      notifToggle.title = ProtonI18n.t('accountNotifications');
      const notifCheck = document.createElement('input');
      notifCheck.type = 'checkbox';
      notifCheck.checked = acc.notificationsEnabled !== false;
      notifCheck.addEventListener('change', () => {
        browser.runtime.sendMessage({
          type: 'UPDATE_ACCOUNT_SETTINGS',
          accountId: acc.id,
          settings: { notificationsEnabled: notifCheck.checked },
        });
      });
      const bellIcon = document.createElement('span');
      _setHTML(bellIcon, '<svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor"><path d="M8 16a2 2 0 0 0 2-2H6a2 2 0 0 0 2 2zM8 1.918l-.797.161A4.002 4.002 0 0 0 4 6c0 .628-.134 2.197-.459 3.742-.16.767-.376 1.566-.663 2.258h10.244c-.287-.692-.502-1.49-.663-2.258C12.134 8.197 12 6.628 12 6a4.002 4.002 0 0 0-3.203-3.92L8 1.917z"/></svg>');
      notifToggle.appendChild(notifCheck);
      notifToggle.appendChild(bellIcon);
      customRow.appendChild(notifToggle);

      detailsWrap.appendChild(customRow);

      // Folder monitoring row
      const folderRow = document.createElement('div');
      folderRow.className = 'account-folder-row';

      const folderLabel = document.createElement('span');
      folderLabel.className = 'account-folder-label';
      folderLabel.textContent = ProtonI18n.t('monitor');
      folderRow.appendChild(folderLabel);

      const folderSelect = document.createElement('select');
      folderSelect.className = 'account-folder-select';
      _setHTML(folderSelect, `<option value="inbox">${ProtonI18n.t('inboxOnly')}</option><option value="all">${ProtonI18n.t('allFolders')}</option><option value="custom">${ProtonI18n.t('customFolders')}</option>`);
      folderSelect.value = acc.folderMode || 'inbox';

      const folderPickerWrap = document.createElement('div');
      folderPickerWrap.className = 'account-folder-picker';
      if (acc.folderMode !== 'custom') folderPickerWrap.classList.add('hidden');

      function _loadFolderPicker() {
        _setHTML(folderPickerWrap, `<span class="folder-picker-loading">${ProtonI18n.t('loadingFolders')}</span>`);
        // Fetch both system labels and custom folders
        Promise.all([
          browser.runtime.sendMessage({ type: 'GET_FOLDERS', accountId: acc.id }),
        ]).then(([folders]) => {
          folderPickerWrap.textContent = '';
          const selectedIds = new Set(acc.monitoredFolders || []);

          // System folders for the folder picker UI.
          // These use Proton's "folder label" IDs, NOT the system label IDs
          // from ProtonLabels in constants.js (which are used in API count
          // queries). E.g., Sent folder = '7' here, but ProtonLabels.SENT = '2'.
          const systemFolders = [
            { ID: '0', Name: 'Inbox' },
            { ID: '7', Name: 'Sent' },
            { ID: '8', Name: 'Drafts' },
            { ID: '6', Name: 'Archive' },
            { ID: '4', Name: 'Spam' },
            { ID: '3', Name: 'Trash' },
            { ID: '10', Name: 'Starred' },
          ];

          const allFolders = [...systemFolders];
          // Build folder tree for custom folders
          if (folders && !folders.error) {
            const byId = {};
            for (const f of folders) byId[f.ID] = f;
            const roots = folders.filter(f => !f.ParentID || !byId[f.ParentID]);
            const addTree = (parentId, depth) => {
              const children = folders.filter(f => f.ParentID === parentId)
                .sort((a, b) => (a.Order || 0) - (b.Order || 0) || a.Name.localeCompare(b.Name));
              for (const child of children) {
                child._depth = depth;
                allFolders.push(child);
                addTree(child.ID, depth + 1);
              }
            };
            roots.sort((a, b) => (a.Order || 0) - (b.Order || 0) || a.Name.localeCompare(b.Name));
            for (const r of roots) {
              r._depth = 0;
              allFolders.push(r);
              addTree(r.ID, 1);
            }
          }

          // A stored ID with no row here belongs to a folder deleted in
          // Proton: it cannot be unticked, and querying it lists the whole
          // mailbox. Saving only what is shown drops it, but only when the
          // folder list actually loaded, or a failed fetch would wipe every
          // custom folder the user picked.
          const foldersLoaded = !!(folders && !folders.error);
          const shownIds = new Set(allFolders.map(f => f.ID));

          for (const f of allFolders) {
            const row = document.createElement('label');
            row.className = 'folder-picker-item';
            const depth = f._depth || 0;
            if (depth > 0) row.style.paddingLeft = (4 + depth * 14) + 'px';

            const cb = document.createElement('input');
            cb.type = 'checkbox';
            cb.checked = selectedIds.has(f.ID);
            cb.addEventListener('change', () => {
              if (cb.checked) selectedIds.add(f.ID);
              else selectedIds.delete(f.ID);
              const newIds = Array.from(selectedIds).filter(id => !foldersLoaded || shownIds.has(id));
              acc.monitoredFolders = newIds;
              browser.runtime.sendMessage({
                type: 'UPDATE_ACCOUNT_SETTINGS',
                accountId: acc.id,
                settings: { monitoredFolders: newIds },
              }).then(() => {
                browser.runtime.sendMessage({ type: 'REFRESH' });
              });
            });

            const nameSpan = document.createElement('span');
            nameSpan.textContent = f.Name;

            row.appendChild(cb);
            row.appendChild(nameSpan);
            folderPickerWrap.appendChild(row);
          }
        });
      }

      folderSelect.addEventListener('change', () => {
        const mode = folderSelect.value;
        acc.folderMode = mode;
        browser.runtime.sendMessage({
          type: 'UPDATE_ACCOUNT_SETTINGS',
          accountId: acc.id,
          settings: { folderMode: mode },
        }).then(() => {
          browser.runtime.sendMessage({ type: 'REFRESH' });
        });
        if (mode === 'custom') {
          folderPickerWrap.classList.remove('hidden');
          labelPickerWrap.classList.remove('hidden');
          _loadFolderPicker();
          _loadLabelPicker();
        } else {
          folderPickerWrap.classList.add('hidden');
          labelPickerWrap.classList.add('hidden');
        }
      });

      if (acc.folderMode === 'custom') _loadFolderPicker();

      folderRow.appendChild(folderSelect);
      detailsWrap.appendChild(folderRow);
      detailsWrap.appendChild(folderPickerWrap);

      // Label monitoring picker (shown in custom mode)
      const labelPickerWrap = document.createElement('div');
      labelPickerWrap.className = 'account-label-picker';
      if (acc.folderMode !== 'custom') labelPickerWrap.classList.add('hidden');

      function _loadLabelPicker() {
        _setHTML(labelPickerWrap, `<span class="folder-picker-loading">${ProtonI18n.t('loadingLabels')}</span>`);
        browser.runtime.sendMessage({ type: 'GET_LABELS', accountId: acc.id }).then(labels => {
          labelPickerWrap.textContent = '';
          if (!labels || labels.error || labels.length === 0) {
            _setHTML(labelPickerWrap, `<span class="folder-picker-loading">${ProtonI18n.t('noLabelsFound')}</span>`);
            return;
          }
          const selectedIds = new Set(acc.monitoredLabels || []);

          const header = document.createElement('div');
          header.className = 'label-picker-header';
          header.textContent = ProtonI18n.t('labelsHeading');
          labelPickerWrap.appendChild(header);

          labels.sort((a, b) => (a.Order || 0) - (b.Order || 0) || a.Name.localeCompare(b.Name));
          // Same as the folder picker: save only labels that still exist.
          // The list loaded, or we would have returned above.
          const shownLabelIds = new Set(labels.map(l => l.ID));
          for (const lbl of labels) {
            const row = document.createElement('label');
            row.className = 'folder-picker-item label-picker-item';

            const cb = document.createElement('input');
            cb.type = 'checkbox';
            cb.checked = selectedIds.has(lbl.ID);
            cb.addEventListener('change', () => {
              if (cb.checked) selectedIds.add(lbl.ID);
              else selectedIds.delete(lbl.ID);
              const newIds = Array.from(selectedIds).filter(id => shownLabelIds.has(id));
              acc.monitoredLabels = newIds;
              browser.runtime.sendMessage({
                type: 'UPDATE_ACCOUNT_SETTINGS',
                accountId: acc.id,
                settings: { monitoredLabels: newIds },
              }).then(() => {
                browser.runtime.sendMessage({ type: 'REFRESH' });
              });
            });

            const dot = document.createElement('span');
            dot.className = 'label-picker-dot';
            dot.style.cssText = 'background:' + (lbl.Color || 'var(--purple)');

            const nameSpan = document.createElement('span');
            nameSpan.textContent = lbl.Name;

            row.appendChild(cb);
            row.appendChild(dot);
            row.appendChild(nameSpan);
            labelPickerWrap.appendChild(row);
          }
        });
      }

      if (acc.folderMode === 'custom') _loadLabelPicker();
      detailsWrap.appendChild(labelPickerWrap);
      info.appendChild(detailsWrap);

      const actionsDiv = document.createElement('div');
      actionsDiv.className = 'account-actions';

      const accIndex = accounts.indexOf(acc);
      const upBtn = document.createElement('button');
      upBtn.className = 'icon-btn account-reorder';
      upBtn.title = ProtonI18n.t('moveUp');
      _setHTML(upBtn, '<svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor"><path fill-rule="evenodd" d="M7.646 4.646a.5.5 0 0 1 .708 0l3 3a.5.5 0 0 1-.708.708L8.5 6.207V12a.5.5 0 0 1-1 0V6.207L5.354 8.354a.5.5 0 1 1-.708-.708l3-3z"/></svg>');
      upBtn.disabled = accIndex === 0;
      upBtn.addEventListener('click', () => {
        browser.runtime.sendMessage({ type: 'REORDER_ACCOUNT', accountId: acc.id, direction: 'up' })
          .then(res => { if (res && res.accounts) renderAccountsList(res.accounts); });
      });
      actionsDiv.appendChild(upBtn);

      const downBtn = document.createElement('button');
      downBtn.className = 'icon-btn account-reorder';
      downBtn.title = ProtonI18n.t('moveDown');
      _setHTML(downBtn, '<svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor"><path fill-rule="evenodd" d="M8.354 11.354a.5.5 0 0 1-.708 0l-3-3a.5.5 0 1 1 .708-.708L7.5 9.793V4a.5.5 0 0 1 1 0v5.793l2.146-2.147a.5.5 0 0 1 .708.708l-3 3z"/></svg>');
      downBtn.disabled = accIndex === accounts.length - 1;
      downBtn.addEventListener('click', () => {
        browser.runtime.sendMessage({ type: 'REORDER_ACCOUNT', accountId: acc.id, direction: 'down' })
          .then(res => { if (res && res.accounts) renderAccountsList(res.accounts); });
      });
      actionsDiv.appendChild(downBtn);

      const removeBtn = document.createElement('button');
      removeBtn.className = 'icon-btn account-remove';
      removeBtn.title = ProtonI18n.t('removeAccount');
      _setHTML(removeBtn, '<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M4.646 4.646a.5.5 0 0 1 .708 0L8 7.293l2.646-2.647a.5.5 0 0 1 .708.708L8.707 8l2.647 2.646a.5.5 0 0 1-.708.708L8 8.707l-2.646 2.647a.5.5 0 0 1-.708-.708L7.293 8 4.646 5.354a.5.5 0 0 1 0-.708z"/></svg>');
      removeBtn.addEventListener('click', () => handleRemoveAccount(acc.id, acc.email, removeBtn));
      actionsDiv.appendChild(removeBtn);

      li.appendChild(info);
      li.appendChild(actionsDiv);
      accountsList.appendChild(li);
    }
  }

  async function handleRemoveAccount(accountId, email, triggerBtn) {
    if (!await ProtonDialog.confirm(ProtonI18n.t('removeAccountConfirm', email),
      { confirmLabel: ProtonI18n.t('remove'), danger: true, anchor: triggerBtn })) return;

    try {
      const result = await browser.runtime.sendMessage({
        type: 'REMOVE_ACCOUNT', accountId,
      });
      if (result.accounts) {
        renderAccountsList(result.accounts);
        if (result.accounts.length === 0) {
          _savedState = null;
        }
      }
    } catch (err) {
      showToast(ProtonI18n.t('failedToRemoveAccount'));
    }
  }

  function showLoginForm() {
    loginForm.classList.remove('hidden');
    twofaForm.classList.add('hidden');
    if (mailboxPwdForm) mailboxPwdForm.classList.add('hidden');
    loginError.classList.add('hidden');
  }

  function _hideAll2FAForms() {
    twofaForm.classList.add('hidden');
    twofaChoice.classList.add('hidden');
    twofaFido2Info.classList.add('hidden');
    if (mailboxPwdForm) mailboxPwdForm.classList.add('hidden');
  }

  function showMailboxPasswordForm() {
    loginForm.classList.add('hidden');
    _hideAll2FAForms();
    if (!mailboxPwdForm) return;
    mailboxPwdForm.classList.remove('hidden');
    loginError.classList.add('hidden');
    mailboxPwdInput.value = '';
    mailboxPwdInput.focus();
  }

  function show2FAForm() {
    loginForm.classList.add('hidden');
    _hideAll2FAForms();
    twofaForm.classList.remove('hidden');
    loginError.classList.add('hidden');
    twofaCode.value = '';
    twofaCode.focus();
  }

  function show2FAChoice() {
    loginForm.classList.add('hidden');
    _hideAll2FAForms();
    twofaChoice.classList.remove('hidden');
    loginError.classList.add('hidden');
  }

  function showFIDO2Info() {
    loginForm.classList.add('hidden');
    _hideAll2FAForms();
    twofaFido2Info.classList.remove('hidden');
    loginError.classList.add('hidden');
  }

  function openFIDO2Tab() {
    browser.tabs.create({ url: 'https://account.proton.me/login#ext-fido2' });
    showFIDO2Info();
  }

  async function handleAddAccount() {
    const username = loginUsername.value.trim();
    const password = loginPassword.value;
    if (!username || !password) return;

    btnLoginSubmit.disabled = true;
    btnLoginSubmit.textContent = ProtonI18n.t('signingIn');
    loginError.classList.add('hidden');

    try {
      const result = await browser.runtime.sendMessage({
        type: 'ADD_ACCOUNT', username, password,
      });

      if (result.needs2FA) {
        if (result.twoFactorType === 'fido2') {
          openFIDO2Tab();
        } else if (result.twoFactorType === 'both') {
          show2FAChoice();
        } else {
          show2FAForm();
        }
        return;
      }

      if (result.needsMailboxPassword) {
        showMailboxPasswordForm();
        return;
      }

      if (result.needsCaptcha && result.humanVerificationToken) {
        // Open account.proton.me with hash: content script injects CAPTCHA iframe
        const methods = (result.verificationMethods || ['captcha']).join(',');
        const captchaUrl = 'https://account.proton.me/login#ext-captcha=' +
          encodeURIComponent(result.humanVerificationToken) +
          '&methods=' + encodeURIComponent(methods);
        browser.tabs.create({ url: captchaUrl });
        loginError.textContent = ProtonI18n.t('captchaRequired');
        loginError.classList.remove('hidden');
        // The CAPTCHA tab takes over; the user finishes the flow there
        // and the BG reopens the popup on success. Some Firefox builds
        // don't auto-close the popup on tabs.create. Close explicitly
        // so the user isn't left looking through it at the puzzle.
        setTimeout(() => { try { window.close(); } catch (_) {} }, 100);
        return;
      }

      if (result.error) {
        loginError.textContent = _localizeError(result.error);
        loginError.classList.remove('hidden');
        return;
      }

      // Success: clear form, refresh account list, go to inbox
      _clearAccountDraft();
      loginUsername.value = '';
      loginPassword.value = '';
      _showingAccounts = false;
      showState('loading');
      await loadState();
    } catch (err) {
      loginError.textContent = ProtonI18n.t('loginFailed') + ': ' + err.message;
      loginError.classList.remove('hidden');
    } finally {
      btnLoginSubmit.disabled = false;
      btnLoginSubmit.textContent = ProtonI18n.t('signIn');
    }
  }

  async function handle2FASubmit() {
    const code = twofaCode.value.trim();
    if (!code || code.length < 6) return;

    btnTwofaSubmit.disabled = true;
    btnTwofaSubmit.textContent = ProtonI18n.t('verifying');
    loginError.classList.add('hidden');

    try {
      const result = await browser.runtime.sendMessage({
        type: 'SUBMIT_2FA', code,
      });

      if (result.error) {
        // If the half-session expired (popup closed during 2FA), restart login
        if (result.error.includes('xpired') || result.error.includes('No pending')) {
          loginError.textContent = ProtonI18n.t('sessionExpiredRetrying') + ' ' + ProtonI18n.t('signIn') + '.';
          loginError.classList.remove('hidden');
          showLoginForm();
          loginPassword.value = '';
          loginPassword.focus();
          return;
        }
        loginError.textContent = _localizeError(result.error);
        loginError.classList.remove('hidden');
        twofaCode.value = '';
        twofaCode.focus();
        return;
      }

      // Two-password account: show mailbox-password prompt
      if (result.needsMailboxPassword) {
        twofaCode.value = '';
        showMailboxPasswordForm();
        return;
      }

      // Success
      _clearAccountDraft();
      loginUsername.value = '';
      loginPassword.value = '';
      twofaCode.value = '';
      showLoginForm();
      _showingAccounts = false;
      showState('loading');
      await loadState();
    } catch (err) {
      loginError.textContent = ProtonI18n.t('twoFaFailed') + ': ' + err.message;
      loginError.classList.remove('hidden');
    } finally {
      btnTwofaSubmit.disabled = false;
      btnTwofaSubmit.textContent = ProtonI18n.t('verify');
    }
  }

  async function handleMailboxPasswordSubmit() {
    if (!mailboxPwdForm) return;
    const pwd = mailboxPwdInput.value;
    if (!pwd) return;

    btnMailboxPwdSubmit.disabled = true;
    btnMailboxPwdSubmit.textContent = ProtonI18n.t('verifying');
    loginError.classList.add('hidden');

    try {
      const result = await browser.runtime.sendMessage({
        type: 'SUBMIT_MAILBOX_PASSWORD', password: pwd,
      });

      if (result.error) {
        // Half-session expired: restart full login
        if (result.error.includes('No pending')) {
          loginError.textContent = ProtonI18n.t('sessionExpiredRetrying') + ' ' + ProtonI18n.t('signIn') + '.';
          loginError.classList.remove('hidden');
          showLoginForm();
          loginPassword.value = '';
          loginPassword.focus();
          return;
        }
        // Wrong-password is the typical case; show the friendly translation.
        // Surface anything else verbatim so unexpected errors (network, 401)
        // remain debuggable.
        // A post-quantum key ring fails while being parsed, so the password
        // was never even tried. Saying "wrong password" would be a lie the
        // user cannot act on.
        if (result.error === 'Account uses post-quantum keys this version cannot read') {
          loginError.textContent = ProtonI18n.t('pqcUnsupported');
          loginError.classList.remove('hidden');
          return;
        }
        const isWrongPwd = result.error === 'Mailbox password is incorrect';
        loginError.textContent = isWrongPwd
          ? ProtonI18n.t('mailboxPasswordFailed')
          : _localizeError(result.error);
        loginError.classList.remove('hidden');
        mailboxPwdInput.value = '';
        mailboxPwdInput.focus();
        return;
      }

      // Success
      _clearAccountDraft();
      loginUsername.value = '';
      loginPassword.value = '';
      mailboxPwdInput.value = '';
      showLoginForm();
      _showingAccounts = false;
      showState('loading');
      await loadState();
    } catch (err) {
      loginError.textContent = ProtonI18n.t('loginFailed') + ': ' + err.message;
      loginError.classList.remove('hidden');
    } finally {
      btnMailboxPwdSubmit.disabled = false;
      btnMailboxPwdSubmit.textContent = ProtonI18n.t('unlock');
    }
  }

  btnLoginSubmit.addEventListener('click', handleAddAccount);
  loginPassword.addEventListener('keydown', (e) => { if (e.key === 'Enter') handleAddAccount(); });
  loginUsername.addEventListener('keydown', (e) => { if (e.key === 'Enter') loginPassword.focus(); });

  // Show / hide password toggle on every .password-toggle button
  document.addEventListener('click', (e) => {
    const btn = e.target.closest('.password-toggle');
    if (!btn) return;
    const targetId = btn.dataset.togglePassword;
    const input = targetId ? document.getElementById(targetId)
      : btn.parentElement && btn.parentElement.querySelector('input');
    if (!input) return;
    e.preventDefault();
    const reveal = input.type === 'password';
    input.type = reveal ? 'text' : 'password';
    btn.classList.toggle('is-revealed', reveal);
    const showLabel = (typeof ProtonI18n !== 'undefined') ? ProtonI18n.t('showPassword') : 'Show password';
    const hideLabel = (typeof ProtonI18n !== 'undefined') ? ProtonI18n.t('hidePassword') : 'Hide password';
    btn.title = reveal ? hideLabel : showLabel;
    btn.setAttribute('aria-label', reveal ? hideLabel : showLabel);
  });
  btnTwofaSubmit.addEventListener('click', handle2FASubmit);
  twofaCode.addEventListener('keydown', (e) => { if (e.key === 'Enter') handle2FASubmit(); });
  btnTwofaCancel.addEventListener('click', () => { _cancelPendingAuthAndReturn(); });
  btnTwofaTotp.addEventListener('click', () => {
    browser.runtime.sendMessage({ type: 'SET_2FA_METHOD', method: 'totp' });
    show2FAForm();
  });
  btnTwofaFido2.addEventListener('click', () => {
    browser.runtime.sendMessage({ type: 'SET_2FA_METHOD', method: 'fido2' });
    openFIDO2Tab();
  });
  btnTwofaChoiceCancel.addEventListener('click', () => { _cancelPendingAuthAndReturn(); });
  btnFido2Cancel.addEventListener('click', () => { _cancelPendingAuthAndReturn(); });
  if (btnMailboxPwdSubmit) {
    btnMailboxPwdSubmit.addEventListener('click', handleMailboxPasswordSubmit);
  }
  if (mailboxPwdInput) {
    mailboxPwdInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') handleMailboxPasswordSubmit();
    });
  }
  if (btnMailboxPwdCancel) {
    btnMailboxPwdCancel.addEventListener('click', () => { _cancelPendingAuthAndReturn(); });
  }

  /** Tell the background to drop the half-completed login (2FA / FIDO2 /
   *  mailbox-pwd prompt) before navigating away. Without this the popup
   *  would auto-reopen the same prompt the next time it's launched
   *  because GET_PENDING_2FA / GET_PENDING_MAILBOX_PASSWORD still report
   *  a pending state. */
  function _cancelPendingAuthAndReturn() {
    try {
      browser.runtime.sendMessage({ type: 'CANCEL_PENDING_AUTH' });
    } catch (e) { /* background may be unavailable; UX-only concern */ }
    _goBackToInbox();
  }

  function _goBackToInbox() {
    // Drop any half-typed sign-in form so reopening the popup doesn't
    // jump back to the Accounts view.
    _clearAccountDraft();
    _showingAccounts = false;
    _setHTML(btnAccount, ICON_ACCOUNT);
    btnAccount.title = ProtonI18n.t('accounts');
    // Restore accounts list and title (may have been hidden by _showReauthForm)
    accountsList.classList.remove('hidden');
    const addTitle = document.querySelector('.accounts-add-title');
    if (addTitle) addTitle.textContent = ProtonI18n.t('addAccount');

    if (_savedState && _savedState.isLoggedIn) {
      render(_savedState);
    } else {
      // No saved state (e.g. popup reopened to 2FA screen): load fresh
      showState('loading');
      loadState();
    }
    return true;
  }

  /** Show a streamlined re-auth form (no account list, title says "Sign in"). */
  function _showReauthForm(email) {
    _showingAccounts = true;
    loginError.classList.add('hidden');
    loginUsername.value = email;
    loginPassword.value = '';
    showLoginForm();
    // Forced: the session is already gone, so there is no choice to offer. The
    // reply is safe either way, having been saved to storage as it was typed.
    closePreview({ force: true });

    // Hide accounts list and change title
    accountsList.classList.add('hidden');
    const addTitle = document.querySelector('.accounts-add-title');
    if (addTitle) addTitle.textContent = ProtonI18n.t('signIn');

    if (_savedState && _savedState.isLoggedIn) {
      _setHTML(btnAccount, ICON_BACK);
      btnAccount.title = ProtonI18n.t('backToInbox');
    }
    showState('accounts');
    loginPassword.focus();
  }

  function showAccountsView() {
    // Forced, and the asking happens in the button handler instead. Two of the
    // three callers set loginUsername.value immediately after calling this, so
    // an await here deferred the field-clearing below past their assignment and
    // wiped the address they had just pre-filled.
    closePreview({ force: true });
    _showingAccounts = true;
    loginError.classList.add('hidden');
    loginUsername.value = '';
    loginPassword.value = '';
    showLoginForm();

    // Restore accounts list and title (may have been hidden by _showReauthForm)
    accountsList.classList.remove('hidden');
    const addTitle = document.querySelector('.accounts-add-title');
    if (addTitle) addTitle.textContent = ProtonI18n.t('addAccount');

    // Show back button + swap header icon if there's an inbox to go back to
    if (_savedState && _savedState.isLoggedIn) {
      _setHTML(btnAccount, ICON_BACK);
      btnAccount.title = ProtonI18n.t('backToInbox');
    }

    // Fetch fresh account list
    browser.runtime.sendMessage({ type: 'GET_ACCOUNTS' }).then(accounts => {
      renderAccountsList(accounts);
    });
    showState('accounts');
    loginUsername.focus();
  }

  btnAccount.addEventListener('click', async () => {
    if (_showingAccounts) {
      _goBackToInbox();
    } else {
      // The user chose to leave the inbox, so an open reply is theirs to keep
      // or discard. The other two callers of showAccountsView are forced: a
      // dead session, and having no accounts at all.
      if (!await closePreview()) return;
      showAccountsView();
    }
  });


  // --- Quick Actions ---

  const OPTIMISTIC_TIMEOUT_MS = 10000;
  const ACTION_LABELS = {
    TRASH: 'delete', ARCHIVE: 'archiveAll', MOVE_TO_FOLDER: 'moveAllToFolder',
    REPORT_PHISHING: 'reportPhishingAll', MARK_READ: 'markAllAsRead', MARK_UNREAD: 'markAsUnread',
    STAR: 'starAll', LABEL_MESSAGE: 'labelAll', DELETE_PERMANENTLY: 'deletePermanentlyAll',
    SNOOZE: 'snoozeAll',
  };

  function _applyOptimisticUpdate(action, { ids, conversationIds } = {}) {
    if (!_savedState || !_savedState.messages) return null;
    // Save state for rollback
    let snapshot = null;
    if (REMOVE_ACTIONS.includes(action)) {
      const idSet = new Set(ids || []);
      snapshot = _savedState.messages.filter(m => idSet.has(m.ID)).map(m => ({ ...m }));
      _savedState.messages = _savedState.messages.filter(m => !idSet.has(m.ID));
    } else if (CONV_REMOVE_ACTIONS.includes(action)) {
      const convSet = new Set(conversationIds || []);
      snapshot = _savedState.messages.filter(m => convSet.has(m.ConversationID)).map(m => ({ ...m }));
      _savedState.messages = _savedState.messages.filter(m => !convSet.has(m.ConversationID));
    } else if (action === 'MARK_UNREAD') {
      const idSet = new Set(ids || []);
      snapshot = _savedState.messages.filter(m => idSet.has(m.ID)).map(m => ({ ...m }));
      for (const msg of _savedState.messages) { if (idSet.has(msg.ID)) msg.Unread = 1; }
    }
    _savedState.unreadCount = _savedState.messages.filter(m => m.Unread === 1).length;
    render(_savedState);
    return snapshot;
  }

  function _rollbackOptimistic(snapshot, action) {
    if (!snapshot || !snapshot.length || !_savedState || !_savedState.messages) return;
    const isRemove = REMOVE_ACTIONS.includes(action) || CONV_REMOVE_ACTIONS.includes(action);
    const label = ACTION_LABELS[action] || action;
    const failText = ProtonI18n.t('actionFailed');

    if (isRemove) {
      // Re-insert removed messages with failure flag
      for (const msg of snapshot) {
        msg._failedAction = failText + ' (' + (ProtonI18n.t(label) || label).toLowerCase() + ')';
        if (!_savedState.messages.find(m => m.ID === msg.ID)) {
          _savedState.messages.push(msg);
        }
      }
      // Re-sort by time descending
      _savedState.messages.sort((a, b) => b.Time - a.Time);
    } else {
      // Revert read/unread state
      const snapMap = new Map(snapshot.map(m => [m.ID, m]));
      for (const msg of _savedState.messages) {
        const orig = snapMap.get(msg.ID);
        if (orig) {
          msg.Unread = orig.Unread;
          msg._failedAction = failText + ' (' + (ProtonI18n.t(label) || label).toLowerCase() + ')';
        }
      }
    }
    _savedState.unreadCount = _savedState.messages.filter(m => m.Unread === 1).length;
    render(_savedState);
  }

  // Filter a background-sourced state against still-pending optimistic actions,
  // then render. EVERY render path that takes background state must go through
  // this so a poll/refresh/reopen landing inside an action's in-flight window
  // can't re-surface a message the user already saw disappear. (The background
  // tombstones cover the longer server eventual-consistency window after the
  // action has settled and its pending entry is gone.)
  function _reconcile(state) {
    if (state && state.messages) {
      const removeIds = new Set();
      const removeConvs = new Set();
      const unreadIds = new Set();
      for (const p of _pendingOptimistic) {
        if (REMOVE_ACTIONS.includes(p.action)) {
          for (const id of (p.ids || [])) removeIds.add(id);
        } else if (CONV_REMOVE_ACTIONS.includes(p.action)) {
          for (const cid of (p.conversationIds || [])) removeConvs.add(cid);
        } else if (p.action === 'MARK_UNREAD') {
          for (const id of (p.ids || [])) unreadIds.add(id);
        }
      }
      if (removeIds.size || removeConvs.size) {
        state.messages = state.messages.filter(
          m => !removeIds.has(m.ID) && !removeConvs.has(m.ConversationID));
      }
      if (unreadIds.size) {
        for (const m of state.messages) { if (unreadIds.has(m.ID)) m.Unread = 1; }
      }
      state.unreadCount = state.messages.filter(m => m.Unread === 1).length;
    }
    // Reflect a poll that was already running when this state was produced (e.g. one
    // in flight when the popup opened, before the real-time POLL_STATUS push could be
    // heard). Real-time start/stop is handled by the POLL_STATUS listener.
    if (btnRefresh && state) btnRefresh.classList.toggle('spinning', !!state.isPolling);
    render(state);
  }

  async function doAction(type, ids, accountId, extra) {
    const msg = { type, ids, accountId, ...extra };
    const conversationIds = extra && extra.conversationIds;
    const isOptimistic = REMOVE_ACTIONS.includes(type) ||
      CONV_REMOVE_ACTIONS.includes(type) || type === 'MARK_UNREAD';

    let snapshot = null;
    if (isOptimistic) {
      snapshot = _applyOptimisticUpdate(type, { ids, conversationIds });
    }

    // Track the pending action so any concurrent render (poll/refresh/reopen)
    // filters it out until it settles.
    let settled = false;
    const entry = { ids, conversationIds, action: type, snapshot };
    _pendingOptimistic.push(entry);

    const timeoutId = setTimeout(() => {
      if (!settled) {
        settled = true;
        _pendingOptimistic = _pendingOptimistic.filter(e => e !== entry);
        if (snapshot) {
          _rollbackOptimistic(snapshot, type);
          showToast(ProtonI18n.t('actionFailed') + ' (timeout)');
        }
      }
    }, OPTIMISTIC_TIMEOUT_MS);

    try {
      const state = await browser.runtime.sendMessage(msg);
      // If the timeout already fired (settled), it has rolled back and dropped
      // the entry. Don't re-render a late response on top of that.
      if (settled) return;
      settled = true;
      clearTimeout(timeoutId);

      if (state && !state.error) {
        // If the background returned full state, reconcile it against pending
        // actions (the entry is still tracked here). { ok: true } → optimistic
        // UI stands; the next poll's STATE_UPDATED syncs via _reconcile.
        if (state.messages) _reconcile(state);
      } else if (state && state.error) {
        if (snapshot) _rollbackOptimistic(snapshot, type);
        showToast(ProtonI18n.t('actionFailed') + ': ' + state.error);
      }
    } catch (err) {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutId);
      if (snapshot) _rollbackOptimistic(snapshot, type);
      showToast(ProtonI18n.t('actionFailed'));
    } finally {
      _pendingOptimistic = _pendingOptimistic.filter(e => e !== entry);
    }
  }

  function _getNextMsgForAdvance(currentMsgId) {
    if (!_settings.autoAdvance || !_savedState || !_savedState.messages) return null;
    const msgs = _savedState.messages;
    const idx = msgs.findIndex(m => m.ID === currentMsgId);
    if (idx >= 0 && idx < msgs.length - 1) return msgs[idx + 1];
    if (idx > 0) return msgs[idx - 1];
    return null;
  }

  function _getNavList() {
    if (!_savedState || !_savedState.messages) return [];
    const allMsgs = _savedState.messages;
    if (!_selectedMsg) return allMsgs;
    const crossAccount = _settings.navCrossAccount !== false; // default true
    if (crossAccount) return allMsgs;
    // Same account only
    const accountId = _selectedMsg._accountId;
    return allMsgs.filter(m => m._accountId === accountId);
  }

  function _navigateMsg(direction) {
    const msgs = _getNavList();
    if (!msgs.length || !_selectedMsg) return;
    const idx = msgs.findIndex(m => m.ID === _selectedMsg.ID);
    if (idx < 0) return;
    let nextIdx = idx + direction;
    const wrap = !!_settings.navWrap;
    if (nextIdx < 0) {
      nextIdx = wrap ? msgs.length - 1 : -1;
    } else if (nextIdx >= msgs.length) {
      nextIdx = wrap ? 0 : -1;
    }
    if (nextIdx >= 0 && nextIdx < msgs.length) {
      openPreview(msgs[nextIdx]);
    }
  }

  function _updateNavButtons() {
    const msgs = _getNavList();
    if (!msgs.length || !_selectedMsg) {
      btnPrevMsg.disabled = true;
      btnNextMsg.disabled = true;
      return;
    }
    const idx = msgs.findIndex(m => m.ID === _selectedMsg.ID);
    const wrap = !!_settings.navWrap;
    btnPrevMsg.disabled = !wrap && idx <= 0;
    btnNextMsg.disabled = !wrap && idx >= msgs.length - 1;
  }

  btnPrevMsg.addEventListener('click', (e) => { e.stopPropagation(); _navigateMsg(-1); });
  btnNextMsg.addEventListener('click', (e) => { e.stopPropagation(); _navigateMsg(1); });

  function handleMarkRead(e, msgId, accountId) {
    e.stopPropagation();
    doAction('MARK_READ', [msgId], accountId);
    showToast(ProtonI18n.t('markedAsRead'), () => {
      doAction('MARK_UNREAD', [msgId], accountId);
    });
  }

  async function handleArchive(e, msgId, accountId) {
    e.stopPropagation();
    const nextMsg = _getNextMsgForAdvance(msgId);
    // Declining the discard prompt aborts the action itself. Filing the message
    // away regardless would strand the reply the user just chose to keep.
    if (!await closePreview()) return;
    if (_settings.autoMarkReadOnArchive) doAction('MARK_READ', [msgId], accountId);
    doAction('ARCHIVE', [msgId], accountId);
    showToast(ProtonI18n.t('archived'), () => {
      doAction('UNARCHIVE', [msgId], accountId);
    });
    if (nextMsg) setTimeout(() => openPreview(nextMsg), 250);
  }

  async function handleTrash(e, msgId, accountId) {
    e.stopPropagation();
    const nextMsg = _getNextMsgForAdvance(msgId);
    if (!await closePreview()) return;
    if (_settings.autoMarkReadOnDelete) doAction('MARK_READ', [msgId], accountId);
    doAction('TRASH', [msgId], accountId);
    showToast(ProtonI18n.t('movedToTrash'), () => {
      doAction('UNTRASH', [msgId], accountId);
    });
    if (nextMsg) setTimeout(() => openPreview(nextMsg), 250);
  }

  async function handleDeletePermanently(e, msgId, accountId) {
    e.stopPropagation();
    if (!requirePremium('deletePermanently')) return;
    if (!await ProtonDialog.confirm(ProtonI18n.t('deletePermanentlyConfirm'),
      { confirmLabel: ProtonI18n.t('deletePermanently'), danger: true })) return;
    const nextMsg = _getNextMsgForAdvance(msgId);
    if (!await closePreview()) return;
    doAction('DELETE_PERMANENTLY', [msgId], accountId);
    showToast(ProtonI18n.t('deletedPermanently'));
    if (nextMsg) setTimeout(() => openPreview(nextMsg), 250);
  }

  async function handleMoveToSpam(e, msgId, accountId) {
    e.stopPropagation();
    const nextMsg = _getNextMsgForAdvance(msgId);
    if (!await closePreview()) return;
    if (_settings.autoMarkReadOnSpam) doAction('MARK_READ', [msgId], accountId);
    doAction('MOVE_TO_FOLDER', [msgId], accountId, { folderId: '4' });
    showToast(ProtonI18n.t('movedToSpam'));
    if (nextMsg) setTimeout(() => openPreview(nextMsg), 250);
  }

  async function handleReportPhishing(e, msgId, accountId) {
    e.stopPropagation();
    if (!await ProtonDialog.confirm(ProtonI18n.t('reportPhishingConfirm'),
      { confirmLabel: ProtonI18n.t('reportPhishing'), danger: true })) return;
    const nextMsg = _getNextMsgForAdvance(msgId);
    if (!await closePreview()) return;
    if (_settings.autoMarkReadOnPhishing) doAction('MARK_READ', [msgId], accountId);
    doAction('REPORT_PHISHING', [msgId], accountId, { messageId: msgId });
    showToast(ProtonI18n.t('reportedAsPhishing'));
    if (nextMsg) setTimeout(() => openPreview(nextMsg), 250);
  }

  function showMessageHeaders() {
    if (!_selectedMsg || !_selectedMsg.Header) {
      showToast(ProtonI18n.t('headersNotAvailable'));
      return;
    }
    _showInfoModal(ProtonI18n.t('messageHeaders'), _selectedMsg.Header, true);
  }

  function showMessageDetails() {
    if (!_selectedMsg) return;
    const m = _selectedMsg;

    // Encryption status
    const encMap = { 0: ProtonI18n.t('notEncrypted'), 1: ProtonI18n.t('encryptionInternal'), 2: ProtonI18n.t('encryptionPgpMime'),
      3: ProtonI18n.t('encryptionPgpInline'), 4: ProtonI18n.t('encryptionStored'), 5: ProtonI18n.t('encryptionMultiPart'),
      7: ProtonI18n.t('encryptionE2ePgpMime'), 8: ProtonI18n.t('encryptionE2ePgpInline') };
    const encStatus = encMap[m.IsEncrypted] || (m.IsEncrypted != null ? 'Encrypted (' + m.IsEncrypted + ')' : ProtonI18n.t('unknown'));

    // Date
    const date = m.Time ? new Date(m.Time * 1000).toLocaleString(undefined, {
      weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
      hour: '2-digit', minute: '2-digit',
    }) : ProtonI18n.t('unknown');

    // Folder(s)
    const folderNames = [];
    if (m.LabelIDs) {
      for (const lid of m.LabelIDs) {
        const name = SYSTEM_LABELS[lid];
        if (name) folderNames.push(name);
      }
    }
    const folder = folderNames.length > 0 ? folderNames.join(', ') : ProtonI18n.t('unknown');

    // Size
    const size = m.Size ? _formatSize(m.Size) : ProtonI18n.t('unknown');

    // Attachments
    const numAtt = m.NumAttachments || 0;
    const attachments = m.Attachments || [];
    let attachInfo = ProtonI18n.plural('attachmentsCount', numAtt);
    if (numAtt > 0 && attachments.length > 0) {
      const totalSize = attachments.reduce((s, a) => s + (a.Size || 0), 0);
      attachInfo += ' (' + _formatSize(totalSize) + ')';
      const embedded = attachments.filter(PopupAttachments.isEmbeddedAttachment).length;
      if (embedded > 0) attachInfo += '\n' + ProtonI18n.plural('embeddedImagesCount', embedded);
    }

    // Sender
    const senderName = m.SenderName || (m.Sender && m.Sender.Name) || '';
    const senderAddr = m.SenderAddress || (m.Sender && m.Sender.Address) || '';
    const sender = senderName ? senderName + ' <' + senderAddr + '>' : senderAddr;

    // Recipients
    const fmtList = (list) => (list || []).map(r => r.Name ? r.Name + ' <' + r.Address + '>' : r.Address).join(', ');
    const toStr = fmtList(m.ToList);
    const ccStr = fmtList(m.CCList);
    const bccStr = fmtList(m.BCCList);

    // External ID
    const extId = m.ExternalID || '';

    let html = '<div class="details-section">';
    html += '<div class="details-row"><span class="details-icon">&#x1F512;</span><span>' + _escapeHtmlText(encStatus) + '</span></div>';
    html += '<div class="details-row"><span class="details-icon">&#x1F4C5;</span><span>' + _escapeHtmlText(date) + '</span></div>';
    html += '<div class="details-row"><span class="details-icon">&#x1F4C1;</span><span>' + _escapeHtmlText(folder) + '</span></div>';
    html += '<div class="details-row"><span class="details-icon">&#x1F4E6;</span><span>' + _escapeHtmlText(size) + '</span></div>';
    if (numAtt > 0) {
      html += '<div class="details-row"><span class="details-icon">&#x1F4CE;</span><span>' + _escapeHtmlText(attachInfo) + '</span></div>';
    }
    html += '</div>';

    html += '<div class="details-section">';
    html += '<div class="details-label">Sender</div>';
    html += '<div class="details-value">' + _escapeHtmlText(sender) + '</div>';
    html += '</div>';

    html += '<div class="details-section">';
    html += '<div class="details-label">Recipients</div>';
    if (toStr) html += '<div class="details-value"><span class="details-prefix">To:</span> ' + _escapeHtmlText(toStr) + '</div>';
    if (ccStr) html += '<div class="details-value"><span class="details-prefix">CC:</span> ' + _escapeHtmlText(ccStr) + '</div>';
    if (bccStr) html += '<div class="details-value"><span class="details-prefix">BCC:</span> ' + _escapeHtmlText(bccStr) + '</div>';
    html += '</div>';

    if (extId) {
      html += '<div class="details-section">';
      html += '<div class="details-label">Message ID</div>';
      html += '<div class="details-value details-mono">' + _escapeHtmlText(extId) + '</div>';
      html += '</div>';
    }

    _showInfoModal(ProtonI18n.t('messageDetails'), html, false);
  }

  // --- Attachment utilities (delegated to PopupAttachments) ---
  const _formatSize = PopupAttachments.formatSize;
  const _getFileIcon = PopupAttachments.getFileIcon;

  function _renderAttachmentList(fullMsg, accountId) {
    // Attachment download is premium-only. Skip the entire panel for free users.
    if (!isPremium()) return;
    PopupAttachments.renderAttachmentList(fullMsg, accountId, showToast);
  }

  function _showInfoModal(title, content, isPlainText) {
    PopupAttachments.showInfoModal(title, content, isPlainText, _setHTML);
  }

  // --- Calendar invite detection & RSVP (delegated to PopupCalendar) ---

  /** Context object passed to PopupCalendar for accessing popup.js internals. */
  function _calendarCtx() {
    return {
      containerEl: calendarInviteEl,
      getSelectedMsg: () => _selectedMsg,
      showToast,
    };
  }

  function _detectCalendarInvite(fullMsg, accountId) {
    // Calendar invite rendering and RSVP is premium-only.
    if (!isPremium()) return;
    PopupCalendar.detectCalendarInvite(fullMsg, accountId, _calendarCtx());
  }

  function handleStar(e, msgId, accountId, isCurrentlyStarred) {
    e.stopPropagation();
    if (isCurrentlyStarred) {
      doAction('UNSTAR', [msgId], accountId);
      showToast(ProtonI18n.t('starRemoved'));
    } else {
      if (_settings.autoMarkReadOnStar) doAction('MARK_READ', [msgId], accountId);
      doAction('STAR', [msgId], accountId);
      showToast(ProtonI18n.t('starred'));
    }
  }

  // --- Label menu ---
  let _labelMenuEl = null;

  // --- Cascading hover menu system ---
  // Shared timer: when it fires, close everything.
  let _menuTimer = null;

  function _menuEnter() {
    if (_menuTimer) { clearTimeout(_menuTimer); _menuTimer = null; }
  }

  function _menuLeave() {
    if (_menuTimer) clearTimeout(_menuTimer);
    _menuTimer = setTimeout(() => _closeAllMenus(), 350);
  }

  function _closeSubmenu() {
    if (_labelMenuEl) { _labelMenuEl.remove(); _labelMenuEl = null; }
    if (_folderMenuEl) { _folderMenuEl.remove(); _folderMenuEl = null; }
  }

  // --- Bulk actions menu (cascaded hover submenus) ---
  let _bulkMenuEl = null;
  let _bulkSubEl = null;
  let _bulkLeaveTimer = null;

  function _closeBulkSub() {
    if (_bulkSubEl) { _bulkSubEl.remove(); _bulkSubEl = null; }
    if (_bulkMenuEl) {
      _bulkMenuEl.querySelectorAll('.dropdown-item.has-submenu').forEach(el => el.classList.remove('active'));
    }
  }

  function _closeBulkMenu() {
    _closeBulkSub();
    if (_bulkMenuEl) { _bulkMenuEl.remove(); _bulkMenuEl = null; }
    if (_bulkLeaveTimer) { clearTimeout(_bulkLeaveTimer); _bulkLeaveTimer = null; }
  }

  function _bulkEnter() {
    if (_bulkLeaveTimer) { clearTimeout(_bulkLeaveTimer); _bulkLeaveTimer = null; }
  }

  function _bulkLeave() {
    if (_bulkLeaveTimer) clearTimeout(_bulkLeaveTimer);
    _bulkLeaveTimer = setTimeout(() => _closeBulkMenu(), 300);
  }

  async function _confirmBulk(actionLabel, count, callback) {
    if (await ProtonDialog.confirm(ProtonI18n.t('confirmBulkAction', actionLabel, count),
      { danger: true })) {
      await callback();
    }
  }

  function _positionBulkSub(sub, parentItem) {
    const parentMenu = _bulkMenuEl;
    if (!parentMenu) return;
    const menuRect = parentMenu.getBoundingClientRect();
    const itemRect = parentItem.getBoundingClientRect();
    const bodyW = document.body.clientWidth;
    const bodyH = document.body.clientHeight;
    sub.style.position = 'fixed';
    sub.style.zIndex = '310';
    // Prefer right side; if no room, go left
    const subWidth = 190;
    if (menuRect.right + subWidth + 4 <= bodyW) {
      sub.style.left = (menuRect.right + 2) + 'px';
      sub.style.right = 'auto';
    } else {
      sub.style.right = (bodyW - menuRect.left + 2) + 'px';
      sub.style.left = 'auto';
    }
    // Align top with the hovered item, but don't overflow bottom
    const maxH = 240;
    const top = Math.min(itemRect.top, bodyH - maxH - 4);
    sub.style.top = Math.max(4, top) + 'px';
  }

  function _showBulkSub(parentItem, buildFn) {
    _closeBulkSub();
    parentItem.classList.add('active');
    const sub = document.createElement('div');
    sub.className = 'dropdown-menu bulk-sub';
    sub.addEventListener('click', (ev) => ev.stopPropagation());
    sub.addEventListener('mouseenter', _bulkEnter);
    sub.addEventListener('mouseleave', _bulkLeave);
    document.body.appendChild(sub);
    _bulkSubEl = sub;
    buildFn(sub);
    _positionBulkSub(sub, parentItem);
  }

  function _buildLabelSub(sub, msgIds, accountId) {
    _setHTML(sub, '<div class="dropdown-header">' + ProtonI18n.t('labelAll') + '</div><div class="label-menu-loading">' + ProtonI18n.t('loading') + '</div>');
    browser.runtime.sendMessage({ type: 'GET_LABELS', accountId }).then(items => {
      if (!items || items.error) {
        sub.querySelector('.label-menu-loading').textContent = ProtonI18n.t('failedToLoadLabels');
        return;
      }
      sub.querySelector('.label-menu-loading').remove();
      for (const entry of items) {
        const item = document.createElement('button');
        item.className = 'dropdown-item label-menu-item';
        const colorDot = document.createElement('span');
        colorDot.className = 'label-color-dot';
        colorDot.style.background = entry.Color || '#6D4AFF';
        const nameSpan = document.createElement('span');
        nameSpan.textContent = entry.Name;
        item.appendChild(colorDot);
        item.appendChild(nameSpan);
        item.addEventListener('click', () => {
          _closeBulkMenu();
          // Labeling doesn't remove the message from the inbox, so doAction
          // applies no optimistic hide, but it routes the response/sync
          // through _reconcile like every other action.
          doAction('LABEL_MESSAGE', msgIds, accountId, { labelId: entry.ID });
          showToast(ProtonI18n.t('labelApplied'));
        });
        sub.appendChild(item);
      }
      if (items.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'label-menu-empty';
        empty.textContent = ProtonI18n.t('noLabelsFound');
        sub.appendChild(empty);
      }
    });
  }

  function _buildFolderSub(sub, msgIds, accountId, msgCount) {
    _setHTML(sub, '<div class="dropdown-header">' + ProtonI18n.t('moveAllToFolder') + '</div><div class="label-menu-loading">' + ProtonI18n.t('loading') + '</div>');
    browser.runtime.sendMessage({ type: 'GET_FOLDERS', accountId }).then(items => {
      if (!items || items.error) {
        sub.querySelector('.label-menu-loading').textContent = ProtonI18n.t('failedToLoadFolders');
        return;
      }
      sub.querySelector('.label-menu-loading').remove();
      const byId = {};
      for (const f of items) byId[f.ID] = f;
      const roots = items.filter(f => !f.ParentID || !byId[f.ParentID]);
      const ordered = [];
      const addChildren = (parentId, depth) => {
        const children = items.filter(f => f.ParentID === parentId)
          .sort((a, b) => (a.Order || 0) - (b.Order || 0) || a.Name.localeCompare(b.Name));
        for (const child of children) {
          child._depth = depth;
          ordered.push(child);
          addChildren(child.ID, depth + 1);
        }
      };
      roots.sort((a, b) => (a.Order || 0) - (b.Order || 0) || a.Name.localeCompare(b.Name));
      for (const r of roots) { r._depth = 0; ordered.push(r); addChildren(r.ID, 1); }
      for (const folder of ordered) {
        const item = document.createElement('button');
        item.className = 'dropdown-item label-menu-item';
        const depth = folder._depth || 0;
        if (depth > 0) item.style.paddingLeft = (12 + depth * 16) + 'px';
        const colorDot = document.createElement('span');
        colorDot.className = 'label-color-dot';
        colorDot.style.background = folder.Color || '#6D4AFF';
        const nameSpan = document.createElement('span');
        nameSpan.textContent = folder.Name;
        item.appendChild(colorDot);
        item.appendChild(nameSpan);
        item.addEventListener('click', () => {
          _closeBulkMenu();
          _confirmBulk(ProtonI18n.t('moveAllToFolder').toLowerCase(), msgCount, async () => {
            if (!await closePreview()) return;
            doAction('MOVE_TO_FOLDER', msgIds, accountId, { folderId: folder.ID });
            showToast(ProtonI18n.t('movedToFolder'));
          });
        });
        sub.appendChild(item);
      }
      if (ordered.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'label-menu-empty';
        empty.textContent = ProtonI18n.t('noFoldersFound');
        sub.appendChild(empty);
      }
    });
  }

  function _buildSnoozeSub(sub, conversationIds, accountId, msgCount) {
    _setHTML(sub, '<div class="dropdown-header">' + ProtonI18n.t('snoozeAll') + '</div>');
    const snoozeOptions = [
      { hours: 1, label: ProtonI18n.t('oneHour') },
      { hours: 3, label: ProtonI18n.t('threeHours') },
      { hours: 24, label: ProtonI18n.t('tomorrow') },
      { hours: 168, label: ProtonI18n.t('nextWeek') },
    ];
    for (const opt of snoozeOptions) {
      const item = document.createElement('button');
      item.className = 'dropdown-item';
      const iconWrap = document.createElement('span');
      iconWrap.className = 'dropdown-icon-wrap';
      const iconSpan = document.createElement('span');
      iconSpan.className = 'dropdown-icon';
      _setHTML(iconSpan, ICONS.snooze);
      iconWrap.appendChild(iconSpan);
      const labelSpan = document.createElement('span');
      labelSpan.className = 'dropdown-label';
      labelSpan.textContent = opt.label;
      item.appendChild(iconWrap);
      item.appendChild(labelSpan);
      item.addEventListener('click', () => {
        _closeBulkMenu();
        _confirmBulk(ProtonI18n.t('snoozeAll').toLowerCase(), msgCount, () => {
          const snoozeUntil = Math.floor(Date.now() / 1000) + (opt.hours * 3600);
          doAction('SNOOZE', null, accountId, { conversationIds, snoozeUntil });
          showToast(ProtonI18n.t('snoozed'));
        });
      });
      sub.appendChild(item);
    }
  }

  const BULK_EDGE = 4; // breathing room against the popup's top and bottom

  /**
   * Make the bulk menu fit the popup vertically, and place it.
   *
   * The old line was `top = Math.min(rect.bottom + 2, bodyH - height - 4)`,
   * which clamps only the BOTTOM. Once the menu is taller than the popup that
   * expression goes negative, so the menu pinned itself to the bottom and ran
   * off the top with its first entries unreachable.
   *
   * Compact mode is tried before scrolling because trimming padding is less
   * disruptive than a scrollbar, but it is not a substitute: translations are
   * longer than English and the item count grows with the user's folders, so
   * only the height cap makes overflow impossible.
   *
   * Heights come from offsetHeight, not getBoundingClientRect: the menu's
   * open animation starts at scale(0.97), and a rect would be measured through
   * that transform.
   */
  function _fitBulkMenu(menu, rect, bodyH) {
    const avail = bodyH - BULK_EDGE * 2;

    if (menu.offsetHeight > avail) menu.classList.add('bulk-menu-compact');
    if (menu.offsetHeight > avail) menu.style.maxHeight = avail + 'px';

    const h = Math.min(menu.offsetHeight, avail);
    let top = rect.bottom + 2;
    if (top + h > bodyH - BULK_EDGE) top = bodyH - h - BULK_EDGE; // prefer below
    menu.style.top = Math.max(BULK_EDGE, top) + 'px';             // never off the top
  }

  function _openBulkMenu(triggerBtn, msgs, accountId) {
    // Toggle: if already open, just close
    if (_bulkMenuEl) {
      _closeBulkMenu();
      return;
    }
    _closeAllMenus();

    const msgIds = msgs.map(m => m.ID);
    const msgCount = msgs.length;
    const conversationIds = [...new Set(msgs.map(m => m.ConversationID))];

    const menu = document.createElement('div');
    menu.className = 'dropdown-menu bulk-menu';
    menu.addEventListener('click', (ev) => ev.stopPropagation());
    menu.addEventListener('mouseenter', _bulkEnter);
    menu.addEventListener('mouseleave', _bulkLeave);

    // Header
    const header = document.createElement('div');
    header.className = 'dropdown-header';
    _setHTML(header, '<svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor"><path fill-rule="evenodd" d="M2.5 12a.5.5 0 0 1 .5-.5h10a.5.5 0 0 1 0 1H3a.5.5 0 0 1-.5-.5zm0-4a.5.5 0 0 1 .5-.5h10a.5.5 0 0 1 0 1H3a.5.5 0 0 1-.5-.5zm0-4a.5.5 0 0 1 .5-.5h10a.5.5 0 0 1 0 1H3a.5.5 0 0 1-.5-.5z"/></svg>');
    header.appendChild(document.createTextNode(ProtonI18n.t('bulkActions')));
    menu.appendChild(header);

    const actionOrder = _settings.actionOrder || null;
    const bulkItems = [
      { key: 'star', icon: ICONS.star, label: ProtonI18n.t('starAll'), handler: () => {
        _closeBulkMenu();
        _confirmBulk(ProtonI18n.t('starAll').toLowerCase(), msgCount, () => {
          doAction('STAR', msgIds, accountId);
          showToast(ProtonI18n.t('starred'));
        });
      }},
      { key: 'markRead', icon: ICONS.markRead, label: ProtonI18n.t('markAllAsRead'), handler: () => {
        _closeBulkMenu();
        _confirmBulk(ProtonI18n.t('markAllAsRead').toLowerCase(), msgCount, () => {
          doAction('MARK_READ', msgIds, accountId);
          showToast(ProtonI18n.t('markedAsRead'));
        });
      }},
      { key: 'label', icon: ICONS.label, label: ProtonI18n.t('labelAll'), submenu: true,
        onHover: (btn) => _showBulkSub(btn, (sub) => _buildLabelSub(sub, msgIds, accountId)),
      },
      { key: 'archive', icon: ICONS.archive, label: ProtonI18n.t('archiveAll'), handler: () => {
        _closeBulkMenu();
        _confirmBulk(ProtonI18n.t('archiveAll').toLowerCase(), msgCount, async () => {
          if (!await closePreview()) return;
          doAction('ARCHIVE', msgIds, accountId);
          showToast(ProtonI18n.t('archived'));
        });
      }},
      { key: 'delete', icon: ICONS.trash, label: ProtonI18n.t('deleteAll'), cls: 'bulk-delete', handler: () => {
        _closeBulkMenu();
        _confirmBulk(ProtonI18n.t('deleteAll').toLowerCase(), msgCount, async () => {
          if (!await closePreview()) return;
          doAction('TRASH', msgIds, accountId);
          showToast(ProtonI18n.t('movedToTrash'));
        });
      }},
      { key: 'deletePermanently', icon: ICONS.deletePermanently, label: ProtonI18n.t('deletePermanentlyAll'), cls: 'bulk-delete', handler: () => {
        _closeBulkMenu();
        if (!requirePremium('deletePermanently')) return;
        _confirmBulk(ProtonI18n.t('deletePermanentlyAll').toLowerCase(), msgCount, async () => {
          if (!await closePreview()) return;
          doAction('DELETE_PERMANENTLY', msgIds, accountId);
          showToast(ProtonI18n.t('deletedPermanently'));
        });
      }},
      { key: 'moveToFolder', icon: ICONS.folder, label: ProtonI18n.t('moveAllToFolder'), submenu: true,
        onHover: (btn) => _showBulkSub(btn, (sub) => _buildFolderSub(sub, msgIds, accountId, msgCount)),
      },
      { key: 'spam', icon: ICONS.spam, label: ProtonI18n.t('moveAllToSpam'), cls: 'bulk-spam', handler: () => {
        _closeBulkMenu();
        _confirmBulk(ProtonI18n.t('moveAllToSpam').toLowerCase(), msgCount, async () => {
          if (!await closePreview()) return;
          doAction('MOVE_TO_FOLDER', msgIds, accountId, { folderId: '4' });
          showToast(ProtonI18n.t('movedToSpam'));
        });
      }},
      { key: 'snooze', icon: ICONS.snooze, label: ProtonI18n.t('snoozeAll'), submenu: true,
        onHover: (btn) => _showBulkSub(btn, (sub) => _buildSnoozeSub(sub, conversationIds, accountId, msgCount)),
      },
      { key: 'phishing', icon: ICONS.phishing, label: ProtonI18n.t('reportPhishingAll'), cls: 'bulk-spam', handler: () => {
        _closeBulkMenu();
        _confirmBulk(ProtonI18n.t('reportPhishingAll').toLowerCase(), msgCount, async () => {
          if (!await closePreview()) return;
          for (const id of msgIds) {
            doAction('REPORT_PHISHING', [id], accountId, { messageId: id });
          }
          showToast(ProtonI18n.t('reportedAsPhishing'));
        });
      }},
    ];

    const sorted = _sortActionsByOrder(bulkItems, actionOrder);
    for (const item of sorted) {
      const btn = document.createElement('button');
      btn.className = 'dropdown-item' + (item.cls ? ' ' + item.cls : '') + (item.submenu ? ' has-submenu' : '');
      const iconWrap = document.createElement('span');
      iconWrap.className = 'dropdown-icon-wrap';
      const iconSpan = document.createElement('span');
      iconSpan.className = 'dropdown-icon';
      _setHTML(iconSpan, item.icon);
      iconWrap.appendChild(iconSpan);
      const labelSpan = document.createElement('span');
      labelSpan.className = 'dropdown-label';
      labelSpan.textContent = item.label;
      btn.appendChild(iconWrap);
      btn.appendChild(labelSpan);
      if (item.submenu) {
        const arrow = document.createElement('span');
        arrow.className = 'submenu-arrow';
        arrow.textContent = '\u203A';
        btn.appendChild(arrow);
        btn.addEventListener('mouseenter', () => item.onHover(btn));
        btn.addEventListener('click', () => item.onHover(btn));
      } else {
        btn.addEventListener('mouseenter', () => _closeBulkSub());
        btn.addEventListener('click', item.handler);
      }
      menu.appendChild(btn);
    }

    document.body.appendChild(menu);
    _bulkMenuEl = menu;

    // Position the menu
    const rect = triggerBtn.getBoundingClientRect();
    const bodyW = document.body.clientWidth;
    const bodyH = document.body.clientHeight;
    const menuRect = menu.getBoundingClientRect();
    _fitBulkMenu(menu, rect, bodyH);
    if (rect.right - menuRect.width < 0) {
      menu.style.left = Math.max(4, rect.left) + 'px';
      menu.style.right = 'auto';
    } else {
      menu.style.right = Math.max(4, bodyW - rect.right) + 'px';
      menu.style.left = 'auto';
    }
  }

  function _closeAllMenus() {
    _closeSubmenu();
    _closeBulkMenu();
    snoozeMenu.classList.add('hidden');
    document.querySelectorAll('.message-item.submenu-open').forEach(el => el.classList.remove('submenu-open'));
    document.querySelectorAll('.action-overflow-menu').forEach(m => m.classList.add('hidden'));
    if (_menuTimer) { clearTimeout(_menuTimer); _menuTimer = null; }
  }

  function _openSubmenu(triggerEl, msg, accountId, type) {
    // Close previous submenus and snooze, but keep overflow menu open
    _closeSubmenu();
    snoozeMenu.classList.add('hidden');
    if (_menuTimer) { clearTimeout(_menuTimer); _menuTimer = null; }

    const msgItem = triggerEl.closest('.message-item');
    if (msgItem) msgItem.classList.add('submenu-open');

    // Keep the parent overflow menu visible
    const parentOverflow = triggerEl.closest('.action-overflow-menu');
    if (parentOverflow) parentOverflow.classList.remove('hidden');

    const isLabel = (type === 'label');
    const menu = document.createElement('div');
    menu.className = 'label-menu';
    _setHTML(menu, '<div class="dropdown-header">' + (isLabel ? ProtonI18n.t('labels') : ProtonI18n.t('moveToFolder')) + '</div><div class="label-menu-loading">' + ProtonI18n.t('loading') + '</div>');
    menu.addEventListener('click', (ev) => ev.stopPropagation());
    menu.addEventListener('mouseenter', _menuEnter);
    menu.addEventListener('mouseleave', _menuLeave);
    document.body.appendChild(menu);

    if (isLabel) { _labelMenuEl = menu; } else { _folderMenuEl = menu; }

    const rect = triggerEl.getBoundingClientRect();
    const bodyW = document.body.clientWidth;
    const bodyH = document.body.clientHeight;
    menu.style.position = 'fixed';
    menu.style.zIndex = '300';

    // Vertical: prefer below button, but flip above if it would overflow bottom
    const menuMaxH = 240;
    if (rect.bottom + 2 + menuMaxH > bodyH && rect.top - menuMaxH > 0) {
      menu.style.bottom = (bodyH - rect.top + 2) + 'px';
      menu.style.top = 'auto';
    } else {
      menu.style.top = Math.min(rect.bottom + 2, bodyH - menuMaxH - 4) + 'px';
      menu.style.bottom = 'auto';
    }

    // Horizontal: prefer right-aligned, but if that would push off-screen left, use left-aligned
    const menuWidth = 180;
    const rightPos = bodyW - rect.right;
    if (rect.right - menuWidth < 0) {
      menu.style.left = Math.max(4, rect.left) + 'px';
      menu.style.right = 'auto';
    } else {
      menu.style.right = Math.max(4, rightPos) + 'px';
      menu.style.left = 'auto';
    }

    const msgType = isLabel ? 'GET_LABELS' : 'GET_FOLDERS';
    browser.runtime.sendMessage({ type: msgType, accountId }).then(items => {
      if (!items || items.error) {
        menu.querySelector('.label-menu-loading').textContent = isLabel ? ProtonI18n.t('failedToLoadLabels') : ProtonI18n.t('failedToLoadFolders');
        return;
      }
      menu.querySelector('.label-menu-loading').remove();
      const msgLabelIds = msg.LabelIDs || [];

      // For folders, sort into tree order with depth
      let sorted = items;
      if (!isLabel) {
        const byId = {};
        for (const f of items) byId[f.ID] = f;
        // Build tree-ordered list: parent then children recursively
        const roots = items.filter(f => !f.ParentID || !byId[f.ParentID]);
        const ordered = [];
        const addChildren = (parentId, depth) => {
          const children = items.filter(f => f.ParentID === parentId)
            .sort((a, b) => (a.Order || 0) - (b.Order || 0) || a.Name.localeCompare(b.Name));
          for (const child of children) {
            child._depth = depth;
            ordered.push(child);
            addChildren(child.ID, depth + 1);
          }
        };
        roots.sort((a, b) => (a.Order || 0) - (b.Order || 0) || a.Name.localeCompare(b.Name));
        for (const r of roots) {
          r._depth = 0;
          ordered.push(r);
          addChildren(r.ID, 1);
        }
        sorted = ordered;
      }

      for (const entry of sorted) {
        const item = document.createElement('button');
        item.className = 'dropdown-item label-menu-item';

        // Indent subfolders
        const depth = entry._depth || 0;
        if (depth > 0) {
          item.style.paddingLeft = (12 + depth * 16) + 'px';
        }

        const colorDot = document.createElement('span');
        colorDot.className = 'label-color-dot';
        colorDot.style.background = entry.Color || '#6D4AFF';

        const nameSpan = document.createElement('span');
        nameSpan.textContent = entry.Name;

        const isApplied = msgLabelIds.includes(entry.ID);
        const checkSpan = document.createElement('span');
        checkSpan.className = 'label-check';
        checkSpan.textContent = isApplied ? '\u2713' : '';

        item.appendChild(colorDot);
        item.appendChild(nameSpan);
        item.appendChild(checkSpan);

        if (isLabel) {

          item.addEventListener('click', (ev) => {
            ev.stopPropagation();
            if (!isApplied && _settings.autoMarkReadOnLabel) doAction('MARK_READ', [msg.ID], accountId);
            const action = isApplied ? 'UNLABEL_MESSAGE' : 'LABEL_MESSAGE';
            doAction(action, [msg.ID], accountId, { labelId: entry.ID });
            showToast(isApplied ? ProtonI18n.t('labelRemoved') : ProtonI18n.t('labelApplied'));
            _closeAllMenus();
          });
        } else {
          item.addEventListener('click', (ev) => {
            ev.stopPropagation();
            if (_settings.autoMarkReadOnMoveToFolder) doAction('MARK_READ', [msg.ID], accountId);
            doAction('MOVE_TO_FOLDER', [msg.ID], accountId, { folderId: entry.ID });
            showToast(ProtonI18n.t('movedTo', entry.Name));
            _closeAllMenus();
          });
        }

        menu.appendChild(item);
      }

      if (sorted.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'label-menu-empty';
        empty.textContent = isLabel ? ProtonI18n.t('noLabelsFound') : ProtonI18n.t('noFoldersFound');
        menu.appendChild(empty);
      }
    });
  }

  function handleLabelMenu(e, msg, accountId) {
    e.stopPropagation();
    e.preventDefault();
    _openSubmenu(e.currentTarget, msg, accountId, 'label');
  }

  // --- Move to folder menu ---
  let _folderMenuEl = null;

  function handleFolderMenu(e, msg, accountId) {
    e.stopPropagation();
    e.preventDefault();
    _openSubmenu(e.currentTarget, msg, accountId, 'folder');
  }

  function handleSnooze(e, conversationId, accountId) {
    e.stopPropagation();
    _closeAllMenus();
    _snoozeTargetConversationIds = [conversationId];
    _snoozeTargetAccountId = accountId;
    const rect = e.currentTarget.getBoundingClientRect();
    const bodyW = document.body.clientWidth;
    const menuWidth = 200;
    snoozeMenu.style.top = (rect.bottom + 2) + 'px';
    if (rect.right - menuWidth < 0) {
      snoozeMenu.style.left = Math.max(4, rect.left) + 'px';
      snoozeMenu.style.right = 'auto';
    } else {
      snoozeMenu.style.right = Math.max(4, bodyW - rect.right) + 'px';
      snoozeMenu.style.left = 'auto';
    }
    snoozeMenu.classList.remove('hidden');
  }

  for (const opt of document.querySelectorAll('.snooze-option')) {
    opt.addEventListener('click', (e) => {
      e.stopPropagation();
      const hours = parseInt(opt.dataset.hours, 10);
      const snoozeUntil = Math.floor(Date.now() / 1000) + (hours * 3600);
      snoozeMenu.classList.add('hidden');
      if (_snoozeTargetConversationIds && _snoozeTargetAccountId) {
        doAction('SNOOZE', null, _snoozeTargetAccountId, {
          conversationIds: _snoozeTargetConversationIds, snoozeUntil,
        });
        showToast(ProtonI18n.t('snoozed'));
        _snoozeTargetConversationIds = null;
        _snoozeTargetAccountId = null;
      }
    });
  }

  document.addEventListener('click', () => {
    snoozeMenu.classList.add('hidden');
    dndMenu.classList.add('hidden');
    _closeAllMenus();
    // Close any open color pickers
    document.querySelectorAll('.color-picker-panel.open').forEach(p => p.classList.remove('open'));
    _snoozeTargetConversationIds = null;
    _snoozeTargetAccountId = null;
  });

  // --- DND ---

  function updateDndButton(status) {
    if (status && status.active) {
      btnDnd.classList.add('dnd-active');
      btnDnd.title = status.until === -1
        ? ProtonI18n.t('dndEnabledUntil', ProtonI18n.t('indefinitely'))
        : ProtonI18n.t('dndEnabledUntil', new Date(status.until).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }));
      // Show "Turn off" option in menu
      dndMenu.querySelector('.dnd-disable').classList.remove('hidden');
    } else {
      btnDnd.classList.remove('dnd-active');
      btnDnd.title = ProtonI18n.t('doNotDisturb');
      dndMenu.querySelector('.dnd-disable').classList.add('hidden');
    }
  }

  btnDnd.addEventListener('click', (e) => {
    e.stopPropagation();
    if (!requirePremium('dnd')) return;
    const isVisible = !dndMenu.classList.contains('hidden');
    snoozeMenu.classList.add('hidden');
    dndMenu.classList.toggle('hidden');
    if (!isVisible) {
      const rect = btnDnd.getBoundingClientRect();
      dndMenu.style.top = (rect.bottom + 2) + 'px';
      dndMenu.style.right = (document.body.clientWidth - rect.right) + 'px';
      dndMenu.style.left = 'auto';
    }
  });

  for (const opt of dndMenu.querySelectorAll('.dnd-option')) {
    opt.addEventListener('click', (e) => {
      e.stopPropagation();
      dndMenu.classList.add('hidden');
      const val = opt.dataset.minutes;

      if (val === '0') {
        // Turn off DND
        browser.runtime.sendMessage({ type: 'DND_DISABLE' }).then(updateDndButton);
        showToast(ProtonI18n.t('dndOff'));
        return;
      }

      let minutes;
      if (val === 'today') {
        // Until midnight
        const now = new Date();
        const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 0);
        minutes = Math.ceil((midnight - now) / 60000);
      } else {
        minutes = parseInt(val, 10);
      }

      browser.runtime.sendMessage({ type: 'DND_ENABLE', minutes }).then(updateDndButton);
      showToast(ProtonI18n.t('dndEnabled'));
    });
  }

  // Load DND status on popup open
  browser.runtime.sendMessage({ type: 'DND_GET_STATUS' }).then(updateDndButton).catch(() => {});

  // --- Preview Panel ---

  async function openPreview(msg, opts) {
    // Switching to another message wipes the reply editor a few lines below, so
    // this is an exit from the reply just as much as closing the preview is.
    if (!await _confirmLeavingReply(opts && opts.force)) return;
    _selectedMsg = msg;
    _externalContentLoaded = false;
    externalContentBanner.classList.add('hidden');
    _replyMode = 'reply';
    _replyEditorOpen = false;
    _replyBaseline = '';
    _updateReplyModeUI();

    document.querySelectorAll('.message-item').forEach(el => el.classList.remove('selected'));
    const selected = document.querySelector(`.message-item[data-message-id="${msg.ID}"]`);
    if (selected) selected.classList.add('selected');

    // Sender: "Name <email>" or just email
    const senderName = msg.Sender && msg.Sender.Name;
    const senderEmail = msg.Sender && msg.Sender.Address;
    if (senderName && senderEmail) {
      previewSender.textContent = senderName + ' <' + senderEmail + '>';
    } else {
      previewSender.textContent = senderName || senderEmail || ProtonI18n.t('unknown');
    }
    previewTime.textContent = formatFullTime(msg.Time);
    // Mirrors the list row: arrows just left of the date. Re-rendered (and so
    // cleared) on every open, like the other optional meta fields below.
    _renderReplyState(previewReplyState, msg);

    // Set preview avatar
    previewAvatar.textContent = '';
    const pvAvatar = createAvatarEl(msg, _senderIconsAllowed(true));
    previewAvatar.appendChild(pvAvatar.querySelector('.msg-avatar'));
    previewSubject.textContent = '';
    const subjectLink = document.createElement('span');
    subjectLink.className = 'subject-link';
    subjectLink.textContent = msg.Subject || ProtonI18n.t('noSubject');
    subjectLink.title = ProtonI18n.t('openInProtonMail');
    subjectLink.addEventListener('click', () => {
      browser.runtime.sendMessage({ type: 'GET_MAIL_URL', conversationId: msg.ConversationID, messageId: msg.ID, accountId: msg._accountId })
        .then(mailUrl => { if (mailUrl) { browser.tabs.create({ url: mailUrl }); window.close(); } });
    });
    previewSubject.appendChild(subjectLink);

    // Clear dynamic meta areas (populated after full message loads)
    previewTo.textContent = '';
    previewLabels.textContent = '';
    previewActionsEl.textContent = '';
    // Hidden until the body renders and we know whether there's a canvas to
    // flip (the override itself survives, see _canvasOverride).
    _updateCanvasButton(false);
    const attachContainer = document.getElementById('preview-attachments');
    if (attachContainer) { attachContainer.textContent = ''; attachContainer.classList.add('hidden'); }
    calendarInviteEl.textContent = '';
    calendarInviteEl.classList.add('hidden');

    _rawPreviewBody = null;
    // Free tier: plaintext only, no mode toggle. Premium: honor user's setting.
    _previewMode = isPremium() ? (_settings.previewFormat || 'html') : 'text';
    btnToggleFormat.title = _getFormatTitle();
    _updatePreviewModeIndicator();
    // Hide the format toggle only when the user has asked us to hide premium UI.
    btnToggleFormat.classList.toggle('hidden', !showPremiumUI());
    _setHTML(previewBody, '<div class="spinner"></div>');
    replyText.value = '';
    replyBody.textContent = '';
    chipForwardTo.clearChips();
    chipReplyCc.clearChips();
    chipReplyBcc.clearChips();
    replyCcBccRows.classList.add('hidden');
    replyFromSelect.textContent = '';
    replyFromRow.classList.add('hidden');
    previewPanel.classList.remove('hidden');
    void previewPanel.offsetWidth;
    previewPanel.classList.add('visible');

    _updateNavButtons();

    await fetchAndShowBody(msg.ID, msg._accountId);

    // Auto-mark-as-read on preview
    if (_settings.autoMarkReadOnPreview && msg.Unread === 1) {
      doAction('MARK_READ', [msg.ID], msg._accountId);
    }
  }

  async function fetchAndShowBody(messageId, accountId) {
    _setHTML(previewBody, '<div class="spinner"></div>');

    try {
      const result = await browser.runtime.sendMessage({
        type: 'GET_MESSAGE', messageId, accountId,
      });

      if (result.error) {
        previewBody.textContent = ProtonI18n.t('couldNotLoadMessage', result.error);
        return;
      }

      const fullMsg = result.message;
      if (!fullMsg || !fullMsg.Body) {
        _setHTML(previewBody, '<span class="encrypted-notice">' + ProtonI18n.t('noPreviewAvailable') + '</span>');
        return;
      }

      // Store full message on _selectedMsg for reply-all / forward / details
      if (_selectedMsg) {
        _selectedMsg.ToList = fullMsg.ToList || [];
        _selectedMsg.CCList = fullMsg.CCList || [];
        _selectedMsg.BCCList = fullMsg.BCCList || [];
        _selectedMsg.ReplyTo = fullMsg.ReplyTo;
        _selectedMsg.LabelIDs = fullMsg.LabelIDs || _selectedMsg.LabelIDs || [];
        _selectedMsg.Header = fullMsg.Header || '';
        _selectedMsg.ParsedHeaders = fullMsg.ParsedHeaders || {};
        _selectedMsg.Size = fullMsg.Size || 0;
        _selectedMsg.NumAttachments = fullMsg.NumAttachments || 0;
        _selectedMsg.Attachments = fullMsg.Attachments || [];
        _selectedMsg.IsEncrypted = fullMsg.IsEncrypted;
        _selectedMsg.ExternalID = fullMsg.ExternalID || '';
      }

      // Populate recipients
      _renderRecipients(fullMsg);

      // Populate labels & folders
      _renderLabelsAndFolders(fullMsg.LabelIDs || [], accountId);

      // Populate action buttons
      _renderPreviewActions(fullMsg, accountId);

      // Populate "From" address selector
      _populateReplyFrom(fullMsg, accountId);

      // Render attachment list
      _renderAttachmentList(fullMsg, accountId);

      // Detect and render calendar invite (async, don't block body)
      _detectCalendarInvite(fullMsg, accountId);

      if (fullMsg.DecryptedBody) {
        displayDecryptedBody(fullMsg.DecryptedBody, fullMsg, accountId);
        return;
      }

      _setHTML(previewBody, '<span class="encrypted-notice">' + ProtonI18n.t('messageEncrypted') + '</span>');
    } catch (err) {
      previewBody.textContent = ProtonI18n.t('failedToLoadPreview');
    }
  }

  // System label IDs
  const SYSTEM_LABELS = {
    '0': 'Inbox', '1': 'All Drafts', '2': 'All Sent', '3': 'Trash',
    '4': 'Spam', '5': 'All Mail', '6': 'Archive', '7': 'Sent',
    '8': 'Drafts', '10': 'Starred', '12': 'Scheduled',
  };
  // System labels to skip showing as badges
  const SKIP_LABEL_IDS = new Set(['0', '1', '2', '5', '7', '8', '12']);

  function _renderRecipients(msg) {
    const parts = [];
    const toList = msg.ToList || [];
    const ccList = msg.CCList || [];
    if (toList.length > 0) {
      const names = toList.map(r => r.Name || r.Address).join(', ');
      parts.push('<span class="recipient-label">to:</span> ' + _escapeHtmlText(names));
    }
    if (ccList.length > 0) {
      const names = ccList.map(r => r.Name || r.Address).join(', ');
      parts.push('<span class="recipient-label">cc:</span> ' + _escapeHtmlText(names));
    }
    _setHTML(previewTo, parts.join(' &nbsp; '));
  }

  /**
   * Escape a string for safe display as HTML text (labels, folders, dates) via
   * the textContent->innerHTML round-trip. Newlines stay literal.
   *
   * NOT the same as accounts.js `_escapeHtml`, which converts newlines to <br>
   * for outgoing HTML email bodies. Different contexts (display vs. email
   * generation), kept separate on purpose.
   */
  function _escapeHtmlText(str) {
    const el = document.createElement('span');
    el.textContent = str;
    return el.innerHTML;
  }

  async function _renderLabelsAndFolders(labelIds, accountId) {
    previewLabels.textContent = '';
    if (!labelIds || labelIds.length === 0) return;

    // Fetch label/folder names (cached per account)
    if (!_labelCache[accountId]) {
      try {
        const [labels, folders] = await Promise.all([
          browser.runtime.sendMessage({ type: 'GET_LABELS', accountId }),
          browser.runtime.sendMessage({ type: 'GET_FOLDERS', accountId }),
        ]);
        _labelCache[accountId] = {
          labels: Array.isArray(labels) ? labels : [],
          folders: Array.isArray(folders) ? folders : [],
        };
      } catch (e) {
        _labelCache[accountId] = { labels: [], folders: [] };
      }
    }

    const cache = _labelCache[accountId];
    const labelMap = {};
    for (const l of cache.labels) labelMap[l.ID] = l;
    const folderMap = {};
    for (const f of cache.folders) folderMap[f.ID] = f;

    // Show folders first, then labels
    for (const id of labelIds) {
      if (SKIP_LABEL_IDS.has(id)) continue;

      // Starred
      if (id === '10') {
        const badge = document.createElement('span');
        badge.className = 'preview-label-badge';
        badge.style.setProperty('--badge-bg', '#F5A623');
        badge.style.background = '#F5A623';
        _setHTML(badge, ICONS.star + ' ' + ProtonI18n.t('starred'));
        previewLabels.appendChild(badge);
        continue;
      }

      // System folders (Trash, Spam, Archive)
      if (SYSTEM_LABELS[id] && !SKIP_LABEL_IDS.has(id)) {
        const badge = document.createElement('span');
        badge.className = 'preview-folder-badge';
        _setHTML(badge, '<svg width="10" height="10" viewBox="0 0 16 16" fill="currentColor"><path d="M.54 3.87L.5 3a2 2 0 0 1 2-2h3.672a2 2 0 0 1 1.414.586l.828.828A2 2 0 0 0 9.828 3H13.5a2 2 0 0 1 2 2v.054c-.175-.073-.356-.133-.54-.18A3 3 0 0 0 14 5H2a3 3 0 0 0-.96.074c-.184.047-.365.107-.54.18z"/><path d="M2 6a2 2 0 0 0-2 2v5a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2H2z"/></svg> ' + SYSTEM_LABELS[id]);
        previewLabels.appendChild(badge);
        continue;
      }

      // Custom folder
      if (folderMap[id]) {
        const f = folderMap[id];
        const badge = document.createElement('span');
        badge.className = 'preview-folder-badge';
        _setHTML(badge, '<svg width="10" height="10" viewBox="0 0 16 16" fill="currentColor"><path d="M.54 3.87L.5 3a2 2 0 0 1 2-2h3.672a2 2 0 0 1 1.414.586l.828.828A2 2 0 0 0 9.828 3H13.5a2 2 0 0 1 2 2v.054c-.175-.073-.356-.133-.54-.18A3 3 0 0 0 14 5H2a3 3 0 0 0-.96.074c-.184.047-.365.107-.54.18z"/><path d="M2 6a2 2 0 0 0-2 2v5a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2H2z"/></svg> ' + _escapeHtmlText(f.Name));
        previewLabels.appendChild(badge);
        continue;
      }

      // Custom label
      if (labelMap[id]) {
        const l = labelMap[id];
        const badge = document.createElement('span');
        badge.className = 'preview-label-badge';
        if (l.Color) badge.style.background = l.Color;
        badge.textContent = l.Name;
        previewLabels.appendChild(badge);
      }
    }
  }

  // Free tier only gets mark-read/unread in the preview panel; everything
  // else is premium. The Open-in-Proton-Mail action lives outside the actions
  // row (its own header button), so it's already always available.
  const FREE_PREVIEW_ACTIONS = new Set(['markRead', 'exportEml']);

  function _renderPreviewActions(msg, accountId) {
    previewActionsEl.textContent = '';
    const isUnread = msg.Unread === 1;
    const isStarred = msg.LabelIDs && msg.LabelIDs.includes('10');
    const actionOrder = _settings.actionOrder || null;

    const actions = [
      { key: 'star', cls: isStarred ? 'action-star starred' : 'action-star',
        title: isStarred ? ProtonI18n.t('unstar') : ProtonI18n.t('star'),
        icon: isStarred ? ICONS.starFilled : ICONS.star,
        handler: (e) => handleStar(e, msg.ID, accountId, isStarred) },
      { key: 'markRead', cls: 'action-read', title: isUnread ? ProtonI18n.t('markAsRead') : ProtonI18n.t('markAsUnread'),
        icon: ICONS.markRead,
        handler: (e) => handleMarkRead(e, msg.ID, accountId) },
      { key: 'label', cls: 'action-label', title: ProtonI18n.t('labels'), icon: ICONS.label,
        handler: (e) => handleLabelMenu(e, msg, accountId) },
      { key: 'moveToFolder', cls: 'action-folder', title: ProtonI18n.t('moveToFolder'), icon: ICONS.folder,
        handler: (e) => handleFolderMenu(e, msg, accountId) },
      { key: 'archive', cls: 'action-archive', title: ProtonI18n.t('archive'), icon: ICONS.archive,
        handler: (e) => handleArchive(e, msg.ID, accountId) },
      { key: 'snooze', cls: 'action-snooze', title: ProtonI18n.t('snooze'), icon: ICONS.snooze,
        handler: (e) => handleSnooze(e, msg.ConversationID, accountId) },
      { key: 'delete', cls: 'action-delete', title: ProtonI18n.t('delete'), icon: ICONS.trash,
        handler: (e) => handleTrash(e, msg.ID, accountId) },
      { key: 'deletePermanently', cls: 'action-delete-permanently', title: ProtonI18n.t('deletePermanently'), icon: ICONS.deletePermanently,
        handler: (e) => handleDeletePermanently(e, msg.ID, accountId) },
      { key: 'spam', cls: 'action-spam', title: ProtonI18n.t('moveToSpam'), icon: ICONS.spam,
        handler: (e) => handleMoveToSpam(e, msg.ID, accountId) },
      { key: 'phishing', cls: 'action-phishing', title: ProtonI18n.t('reportPhishing'), icon: ICONS.phishing,
        handler: (e) => handleReportPhishing(e, msg.ID, accountId) },
      { key: 'headers', cls: 'action-headers', title: ProtonI18n.t('viewHeaders'), icon: ICONS.headers,
        handler: () => showMessageHeaders() },
      { key: 'details', cls: 'action-details', title: ProtonI18n.t('messageDetails'), icon: ICONS.details,
        handler: () => showMessageDetails(msg, accountId) },
      { key: 'exportEml', cls: 'action-export-eml', title: ProtonI18n.t('exportEml'), icon: ICONS.exportEml,
        handler: (ev) => handleExportEml(ev, msg, accountId) },
    ];

    const sorted = _sortActionsByOrder(actions, actionOrder);
    // When premium, or when free+showPremiumUI(), render all actions; the
    // non-free ones get an upgrade-toast wrapper. When free+hidePremiumUI,
    // collapse to the free-allowed subset.
    const filtered = showPremiumUI() ? sorted : sorted.filter(a => FREE_PREVIEW_ACTIONS.has(a.key));
    for (const a of filtered) {
      const btn = document.createElement('button');
      btn.className = 'action-btn ' + a.cls;
      btn.title = a.title;
      _setHTML(btn, a.icon);
      const handler = (!isPremium() && !FREE_PREVIEW_ACTIONS.has(a.key))
        ? (e) => { if (e && e.stopPropagation) e.stopPropagation(); showUpgradePrompt(a.key); }
        : a.handler;
      btn.addEventListener('click', handler);
      previewActionsEl.appendChild(btn);
    }
  }

  /**
   * Export the open message as a standard .eml (RFC822 / MIME) file, including
   * every attachment (so a calendar .ics or any file is preserved). Useful for
   * debugging and archiving. Free for all users (no premium gate).
   */
  async function handleExportEml(e, msg, accountId) {
    if (e && e.stopPropagation) e.stopPropagation();
    const senderAddress = (msg.Sender && msg.Sender.Address) || null;
    try {
      const parts = [];
      let skippedUndecrypted = 0;
      for (const att of (msg.Attachments || [])) {
        const keyPackets = att.KeyPackets || null;
        const res = await browser.runtime.sendMessage({
          type: 'GET_ATTACHMENT', attachmentId: att.ID, accountId,
          keyPackets, signature: att.Signature || null,
          senderAddress,
        });
        // decrypted === false means the bytes came back as PGP ciphertext, so
        // embedding them would ship an .eml nobody can open. Treat it as a
        // fetch failure and skip the part.
        const undecrypted = !!keyPackets && res && res.decrypted === false;
        if (undecrypted) skippedUndecrypted++;
        if (res && res.data && !res.error && !undecrypted) {
          parts.push({
            name: (att.Name || 'attachment').replace(/"/g, ''),
            mime: att.MIMEType || 'application/octet-stream',
            b64: res.data,
            cid: (att.Headers && (att.Headers['content-id'] || att.Headers['Content-ID'])) || '',
            disp: (att.Headers && (att.Headers['content-disposition'] || att.Headers['Content-Disposition'])) || '',
          });
        }
      }
      const eml = _buildEml(msg, parts);
      const blob = new Blob([eml], { type: 'message/rfc822' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = _safeEmlName(msg.Subject) + '.eml';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      // The .eml is still worth having, but an export that quietly lost parts
      // is its own trap, so say so. Not 'downloadFailed': the file did download.
      if (skippedUndecrypted > 0) showToast(ProtonI18n.t('attachmentsSkipped'));
    } catch (err) {
      showToast(ProtonI18n.t('downloadFailed'));
    }
  }

  function _safeEmlName(subject) {
    const s = (subject || 'message').replace(/[\\/:*?"<>|\r\n\t]+/g, '_').trim();
    return (s || 'message').slice(0, 80);
  }

  /** base64 of a UTF-8 string, wrapped to 76-char lines (RFC 2045). */
  function _b64Utf8Wrapped(str) {
    const bytes = new TextEncoder().encode(str || '');
    let bin = '';
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin).replace(/.{76}/g, '$&\r\n');
  }

  /** Re-wrap an already-base64 string to 76-char lines. */
  function _wrapB64(b64) {
    return (b64 || '').replace(/\s+/g, '').replace(/.{76}/g, '$&\r\n');
  }

  /** Original RFC822 headers minus the ones describing the (encrypted) body:
   *  we rebuild the MIME around the decrypted content. Synthesizes minimal
   *  headers if the raw header block is unavailable. */
  function _emlHeaders(msg) {
    const dropRe = /^(content-type|content-transfer-encoding|content-disposition|mime-version)\s*:/i;
    const kept = [];
    let dropping = false;
    for (const line of (msg.Header || '').split(/\r?\n/)) {
      if (/^[ \t]/.test(line)) { if (!dropping) kept.push(line); continue; }
      dropping = dropRe.test(line);
      if (!dropping && line.trim() !== '') kept.push(line);
    }
    if (kept.length === 0) {
      if (msg.Sender) {
        kept.push('From: ' + (msg.Sender.Name ? '"' + msg.Sender.Name + '" ' : '') + '<' + msg.Sender.Address + '>');
      }
      if (msg.ToList && msg.ToList.length) kept.push('To: ' + msg.ToList.map(r => r.Address).join(', '));
      kept.push('Subject: ' + (msg.Subject || ''));
      if (msg.Time) kept.push('Date: ' + new Date(msg.Time * 1000).toUTCString());
    }
    return kept.join('\r\n');
  }

  /** True for a part the HTML references by cid:, so it belongs beside the body
   *  in multipart/related rather than hanging off multipart/mixed. */
  function _isEmbeddedPart(p) {
    if (!p.cid) return false;
    if (/inline/i.test(p.disp || '')) return true;
    // Proton sometimes omits the disposition; an image with a Content-ID is
    // embedded by convention.
    return !/attachment/i.test(p.disp || '') && /^image\//i.test(p.mime || '');
  }

  function _emlPart(out, p, disposition) {
    out.push('Content-Type: ' + p.mime + '; name="' + p.name + '"');
    out.push('Content-Transfer-Encoding: base64');
    out.push('Content-Disposition: ' + disposition + '; filename="' + p.name + '"');
    if (p.cid) out.push('Content-ID: ' + (p.cid.charAt(0) === '<' ? p.cid : '<' + p.cid + '>'));
    out.push('');
    out.push(_wrapB64(p.b64));
  }

  function _buildEml(msg, parts) {
    const stamp = Date.now().toString(36) + Math.round(Math.random() * 1e9).toString(36);
    const mixed = '----mcpm_mixed_' + stamp;
    const related = '----mcpm_rel_' + stamp;
    const mime = msg.MIMEType || 'text/html';
    const embedded = (parts || []).filter(_isEmbeddedPart);
    const files = (parts || []).filter(p => !_isEmbeddedPart(p));
    const out = [];
    out.push(_emlHeaders(msg));
    out.push('MIME-Version: 1.0');
    out.push('Content-Type: multipart/mixed; boundary="' + mixed + '"');
    out.push('');
    out.push('This is a multi-part message in MIME format (exported by Mail Checker for Proton Mail).');
    out.push('');
    out.push('--' + mixed);
    // Embedded images have to sit with the HTML inside multipart/related, or a
    // mail client cannot resolve the cid: references in the body and the
    // picture shows up as a stray attachment (or not at all).
    if (embedded.length > 0) {
      out.push('Content-Type: multipart/related; type="' + mime + '"; boundary="' + related + '"');
      out.push('');
      out.push('--' + related);
    }
    out.push('Content-Type: ' + mime + '; charset=utf-8');
    out.push('Content-Transfer-Encoding: base64');
    out.push('');
    out.push(_b64Utf8Wrapped(msg.DecryptedBody != null ? msg.DecryptedBody : ''));
    for (const p of embedded) {
      out.push('--' + related);
      _emlPart(out, p, 'inline');
    }
    if (embedded.length > 0) out.push('--' + related + '--');
    for (const p of files) {
      out.push('--' + mixed);
      _emlPart(out, p, 'attachment');
    }
    out.push('--' + mixed + '--');
    out.push('');
    return out.join('\r\n');
  }

  // The account's own addresses, cached by _populateReplyFrom. Used to strip
  // ourselves out of reply-all recipients (incl. +alias variants).
  let _replyAddresses = [];

  /** True if `addr` is one of our own addresses (exact or +alias of a base). */
  function _isOwnAddress(addr) {
    const a = (addr || '').toLowerCase();
    if (!a) return false;
    const [local, domain] = a.split('@');
    const base = (local || '').split('+')[0];
    return (_replyAddresses || []).some(my => {
      const [myLocal, myDomain] = (my.Email || '').toLowerCase().split('@');
      return myDomain === domain && (myLocal === local || myLocal === base);
    });
  }

  /**
   * Pre-fill the To/CC/BCC chip fields when opening reply / reply-all, so the
   * recipients are visible and editable (add/remove). Mirrors Proton:
   *   reply     → To = the sender.
   *   reply-all → To = sender + original To (minus us); CC = original CC
   *               (minus us); BCC = original BCC (minus us). Placement follows
   *               where each address sat in the received message.
   * Forward leaves the fields empty for the user to fill.
   */
  function _prefillReplyRecipients() {
    chipForwardTo.clearChips();
    chipReplyCc.clearChips();
    chipReplyBcc.clearChips();
    const msg = _selectedMsg;
    if (!msg || _replyMode === 'forward') return;

    const sender = msg.ReplyTo || msg.Sender || null;
    const senderAddr = sender && (sender.Address || (typeof sender === 'string' ? sender : ''));
    const seen = new Set();
    if (senderAddr) {
      chipForwardTo.addChip(senderAddr, (sender && sender.Name) || '');
      seen.add(senderAddr.toLowerCase());
    }

    if (_replyMode !== 'replyAll') return;

    let ccAny = false;
    const _add = (list, chip, markCc) => {
      (list || []).forEach(r => {
        const a = (r.Address || '').toLowerCase();
        if (!a || seen.has(a) || _isOwnAddress(a)) return;
        seen.add(a);
        chip.addChip(r.Address, r.Name || '');
        if (markCc) ccAny = true;
      });
    };
    _add(msg.ToList, chipForwardTo, false);   // other To recipients stay in To
    _add(msg.CCList, chipReplyCc, true);       // CC stays in CC
    _add(msg.BCCList, chipReplyBcc, true);     // BCC (usually empty on received)
    if (ccAny) replyCcBccRows.classList.remove('hidden');
  }

  /**
   * Sanitize an original email's HTML before it goes into the (non-sandboxed)
   * reply contenteditable as a quote: drop scripts/active elements and strip
   * event handlers + javascript:/vbscript: URLs. The full preview uses a
   * sandboxed iframe; the editable quote can't, so it must be sanitized here.
   * Images/links/formatting are kept (Proton keeps them in the quote too).
   */
  function _sanitizeQuoteHtml(html) {
    // The quote lands in a contenteditable in the POPUP's own document, with no
    // iframe and no sandbox, so this is the only barrier. Two things the
    // sandboxed reading pane can afford to be relaxed about must be handled
    // here: hostile CSS (harmless inside the iframe, able to paint over the
    // whole popup out here) and remote content (gated by a banner in the
    // reading pane, which would be pointless if replying silently fetched it).
    const loadExternal = _externalContentLoaded ||
      (_settings && _settings.alwaysLoadExternalContent);
    const doc = new DOMParser().parseFromString(html || '', 'text/html');
    // SVG goes entirely. It reaches the same privileged document as everything
    // else, but carries a parallel set of URL attributes (image/use href),
    // its own <style>, and SMIL elements that can rewrite attributes AFTER
    // sanitisation. Filtering all of that correctly is a losing game for a
    // courtesy quote; the reader still shows the original in the sandbox.
    doc.querySelectorAll(
      'script, style, link, meta, iframe, object, embed, form, input, button, base, title, svg, math'
    ).forEach(el => el.remove());
    // Separate pass, before anything is parked: the parking prefix is ours
    // alone, and a data-mcpm-* attribute arriving in the mail would otherwise be
    // promoted by _restoreQuoteUrls into a real URL attribute that never passed
    // the scheme check. It must run first, or it would delete our own parking.
    doc.querySelectorAll('*').forEach(el => {
      for (const attr of [...el.attributes]) {
        if (attr.name.toLowerCase().startsWith('data-mcpm-')) el.removeAttribute(attr.name);
      }
    });
    doc.querySelectorAll('*').forEach(el => {
      for (const attr of [...el.attributes]) {
        const name = attr.name.toLowerCase();
        if (name.startsWith('on')) { el.removeAttribute(attr.name); continue; }
        // class and id go too. The quote lands in a live contenteditable in the
        // POPUP's own document, where popup.css matches on unprefixed class
        // names, so <div class="compose-panel"> is handed position:fixed and a
        // full-viewport z-index by our own stylesheet: exactly what stripping
        // `position` from inline styles exists to prevent, granted for free by
        // naming a selector. `id` follows because the popup looks elements up by
        // id, and a quoted id can shadow a real one for document.getElementById.
        if (name === 'class' || name === 'id') { el.removeAttribute(attr.name); continue; }
        if (name === 'style') {
          const clean = _sanitizeQuoteStyle(attr.value);
          if (clean) el.setAttribute('style', clean); else el.removeAttribute(attr.name);
          continue;
        }
        // Allowlist, not denylist: every attribute that can make the browser
        // fetch something. A denylist missed background= and poster= last time.
        if (QUOTE_URL_ATTRS.has(name)) {
          const v = (attr.value || '').replace(/\s+/g, '').toLowerCase();
          if (v.startsWith('javascript:') || v.startsWith('vbscript:') || v.startsWith('data:text/html')) {
            el.removeAttribute(attr.name);
            continue;
          }
          // A real hyperlink does not fetch anything until clicked, so leave it.
          // Everything else here loads on insertion. `href` only counts as a
          // hyperlink on an actual HTML anchor: on SVG image/use it fetches,
          // which is why SVG is dropped above rather than reasoned about.
          const tag = (el.localName || '').toLowerCase();
          const isHyperlink = name === 'href' && (tag === 'a' || tag === 'area');
          if (isHyperlink) continue;
          // srcset is a comma-separated CANDIDATE LIST, so the data:/cid: prefix
          // test below inspects only the first entry: "data:...1x, https://
          // tracker/px.gif 2x" passed the check and kept its remote candidate
          // live in the popup document, which then fetched it. The reading pane
          // already drops srcset wholesale for this reason. Park the whole
          // attribute so the recipient's copy is still intact.
          if (name === 'srcset') {
            if (!loadExternal) {
              el.setAttribute('data-mcpm-' + name, attr.value);
              el.removeAttribute(attr.name);
            }
            continue;
          }
          // A cid: reference resolves against the message being quoted, which
          // this document knows nothing about, so the editor drew a broken
          // image. Show the decrypted bytes the reading pane already has, and
          // park the reference: the OUTGOING quote must keep cid:, because the
          // background re-attaches the original part under that exact
          // Content-ID. Nothing is fetched either way.
          if (name === 'src' && v.startsWith('cid:')) {
            const resolved = _inlineImages.get(_normalizeCid(attr.value.trim().slice(4)));
            if (resolved) {
              el.setAttribute('data-mcpm-cidsrc', attr.value);
              el.setAttribute('src', resolved);
            }
            continue;
          }
          if (!loadExternal && !v.startsWith('data:') && !v.startsWith('cid:')) {
            // Park it rather than delete it: this quote is also what gets SENT,
            // and silently stripping the original's images from the outgoing
            // reply would corrupt the conversation for the recipient.
            // _restoreQuoteUrls puts these back just before the message goes.
            el.setAttribute('data-mcpm-' + name, attr.value);
            el.removeAttribute(attr.name);
          }
        }
      }
    });
    return doc.body.innerHTML;
  }

  // Attributes that make the browser issue a request, or that carry a URL we
  // must vet. `href` is included so anchors get the scheme check.
  const QUOTE_URL_ATTRS = new Set([
    'href', 'src', 'srcset', 'xlink:href', 'background', 'poster',
    'data', 'action', 'formaction', 'lowsrc', 'dynsrc', 'cite', 'ping',
  ]);

  // Inline-style properties a quote may keep. An ALLOWLIST on purpose: the
  // previous denylist was bypassed by a CSS custom property (position:var(--p)),
  // by a comment inside the declaration, and by an ident escape, because a
  // regex cannot see what the CSS tokenizer sees. Parsing through the CSSOM and
  // keeping only known-inert properties removes that whole class.
  const QUOTE_SAFE_STYLE_PROPS = new Set([
    'color', 'background-color', 'font', 'font-family', 'font-size', 'font-style',
    'font-weight', 'font-variant', 'line-height', 'letter-spacing', 'word-spacing',
    'text-align', 'text-decoration', 'text-indent', 'text-transform', 'white-space',
    'vertical-align', 'direction', 'margin', 'margin-top', 'margin-right',
    'margin-bottom', 'margin-left', 'padding', 'padding-top', 'padding-right',
    'padding-bottom', 'padding-left', 'border', 'border-top', 'border-right',
    'border-bottom', 'border-left', 'border-color', 'border-style', 'border-width',
    'border-radius', 'border-collapse', 'border-spacing', 'list-style',
    'list-style-type', 'width', 'height', 'max-width', 'min-width', 'text-wrap',
  ]);

  /**
   * Rebuild an inline style from the CSSOM, keeping only inert properties.
   *
   * The quote lands in a live contenteditable of the popup document, where
   * .preview-panel is a transformed, fixed, full-viewport container. A
   * positioned descendant therefore resolves against it and can paint over the
   * whole popup, so `position` simply is not on the allowlist. Values that
   * could reintroduce a fetch or an indirection (url(), image-set(), var())
   * are rejected outright rather than rewritten.
   */
  function _sanitizeQuoteStyle(style) {
    const probe = document.createElement('div');
    try {
      probe.setAttribute('style', String(style || ''));
    } catch (e) {
      return '';
    }
    const out = [];
    for (const prop of Array.from(probe.style)) {
      const name = String(prop).toLowerCase();
      if (!QUOTE_SAFE_STYLE_PROPS.has(name)) continue; // drops --custom-props too
      const value = probe.style.getPropertyValue(prop);
      if (!value) continue;
      if (/url\s*\(|image-set\s*\(|var\s*\(|expression\s*\(|javascript\s*:|behavior\s*:/i.test(value)) continue;
      out.push(name + ': ' + value);
    }
    return out.join('; ');
  }

  /**
   * Put back the URLs `_sanitizeQuoteHtml` parked, just before sending. The
   * quote is the recipient's copy of the conversation, so it must go out as the
   * original had it even though we declined to fetch it while composing.
   */
  function _restoreQuoteUrls(html) {
    const doc = new DOMParser().parseFromString(html || '', 'text/html');
    doc.querySelectorAll('*').forEach(el => {
      for (const attr of [...el.attributes]) {
        const name = attr.name.toLowerCase();
        // An embedded image shown from the decrypted bytes goes back to the
        // cid: the original used, because the background re-attaches that part
        // under the same Content-ID. Only ever restore a cid: value: this
        // round-trips through a contenteditable the user can paste into.
        if (name === 'data-mcpm-cidsrc') {
          if (/^\s*cid:/i.test(attr.value)) el.setAttribute('src', attr.value);
          el.removeAttribute(attr.name);
          continue;
        }
        const m = name.match(/^data-mcpm-(.+)$/);
        if (!m || !QUOTE_URL_ATTRS.has(m[1])) continue;
        el.setAttribute(m[1], attr.value);
        el.removeAttribute(attr.name);
      }
    });
    return doc.body.innerHTML;
  }

  /** Content-ID for an embedded image: 8 hex chars @ the sender's domain, the
   *  shape Proton's own client generates. The domain only makes the id unique;
   *  nothing ever resolves it. */
  function _makeContentId(senderAddress) {
    const bytes = crypto.getRandomValues(new Uint8Array(4));
    const id = Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
    // The sender arrives as a bare address from the reply editor but as an
    // arbitrary account LABEL from compose, which may be "Name <a@b.com>" or
    // not an address at all. Take the domain only when what follows the last @
    // really looks like one: a stray '>' would otherwise land inside the
    // Content-ID, where angle brackets are the delimiters.
    const raw = String(senderAddress || '');
    const at = raw.lastIndexOf('@');
    const domain = at === -1 ? '' : raw.slice(at + 1).replace(/[<>\s]/g, '');
    return id + '@' + (/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(domain) ? domain : 'pm.me');
  }

  /** File extension for an image MIME type, for naming the generated part. */
  function _imageExtension(mime) {
    switch (String(mime || '').toLowerCase()) {
      case 'image/png': return 'png';
      case 'image/jpeg': case 'image/jpg': return 'jpg';
      case 'image/gif': return 'gif';
      case 'image/webp': return 'webp';
      case 'image/avif': return 'avif';
      case 'image/bmp': return 'bmp';
      case 'image/svg+xml': return 'svg';
      default: return 'img';
    }
  }

  /**
   * Turn every <img src="data:image/..."> in an outgoing body into a real
   * inline attachment, returning the rewritten HTML and the parts to upload
   * with it. Returns the input untouched when there is nothing to convert.
   *
   * A data: URI is not portable email. Verified 2026-08-07 by comparing the
   * .eml Gmail received against the one Proton stored: the URI arrived
   * byte-identical and Gmail's renderer dropped it, so an image pasted into
   * the composer was invisible to everyone outside Proton. The interoperable
   * form is a separate MIME part carrying a Content-ID, referenced as
   * <img src="cid:...">, which is what Proton's own client emits (WebClients
   * replaceDataUrl + attachmentUploader, where a non-empty ContentID is the
   * only thing that marks a part embedded).
   *
   * Identical sources collapse onto one attachment: the same signature image
   * repeated down a quoted thread would otherwise upload once per occurrence.
   */
  function _inlineDataUrlImages(html, senderAddress) {
    const out = { html: html || '', attachments: [] };
    if (!out.html || !/data:image\//i.test(out.html)) return out;
    const doc = new DOMParser().parseFromString(out.html, 'text/html');
    const cidBySrc = new Map();
    doc.querySelectorAll('img').forEach(img => {
      const src = (img.getAttribute('src') || '').trim();
      const m = /^data:(image\/[a-z0-9.+-]+)([^,]*),([\s\S]*)$/i.exec(src);
      if (!m) return;
      // Only base64 payloads. A percent-encoded data: URI needs a different
      // decode, and leaving it alone beats shipping a corrupted attachment.
      if (!/;base64/i.test(m[2])) return;
      const data = m[3].replace(/\s+/g, '');
      if (!data) return;
      // atob() runs later, in the background, inside the attachment upload loop
      // and outside any per-attachment guard, so one bad character there aborts
      // the whole send AND deletes the draft. Pasted HTML supplies percent
      // escapes (iVBORw0KGgo%3D) and URL-safe alphabets readily enough. Leave
      // anything that is not strict base64 as a data: URI: worse for Gmail, but
      // the message sends.
      if (!/^[A-Za-z0-9+/]+={0,2}$/.test(data) || data.length % 4 !== 0) return;
      let cid = cidBySrc.get(src);
      if (!cid) {
        const mime = m[1].toLowerCase();
        cid = _makeContentId(senderAddress);
        cidBySrc.set(src, cid);
        const alt = (img.getAttribute('alt') || '').trim();
        const named = /^[\w .()-]{1,64}\.[a-z0-9]{2,4}$/i.test(alt);
        out.attachments.push({
          name: named ? alt : 'image-' + cidBySrc.size + '.' + _imageExtension(mime),
          type: mime,
          data,
          cid,
        });
      }
      img.setAttribute('src', 'cid:' + cid);
    });
    if (out.attachments.length) out.html = doc.body.innerHTML;
    return out;
  }

  /** Rough HTML→plain-text for quoting an original in plain-text reply mode. */
  function _htmlToPlainText(html) {
    if (!html) return '';
    if (!/<[a-zA-Z!/][^>]*>/.test(html)) return html; // already plain text
    const doc = new DOMParser().parseFromString(html, 'text/html');
    doc.body.querySelectorAll('script,style').forEach(e => e.remove());
    doc.body.querySelectorAll('br').forEach(br => br.replaceWith('\n'));
    doc.body.querySelectorAll('p,div,li,tr,h1,h2,h3,h4,h5,h6,blockquote')
      .forEach(el => el.append('\n'));
    return (doc.body.textContent || '').replace(/\n{3,}/g, '\n\n').trim();
  }

  /**
   * Pre-fill the reply editor BODY with the quoted original (Proton-style), so
   * it's visible and editable (reply inline, trim the quote, etc.). Reply &
   * reply-all get the quote; forward keeps the body empty (its quote is added
   * on send). Honors html vs plain-text reply mode.
   */
  function _prefillReplyBody() {
    const replyHtml = _settings.replyFormat === 'html';
    if (_replyMode === 'forward' || !_selectedMsg) {
      if (replyHtml) _setHTML(replyBody, ''); else replyText.value = '';
      return;
    }
    const msg = _selectedMsg;
    const sender = msg.ReplyTo || msg.Sender || {};
    const sName = (sender && sender.Name) || '';
    const sAddr = (sender && sender.Address) || (typeof sender === 'string' ? sender : '');
    const dateStr = new Date((msg.Time || 0) * 1000).toLocaleString();

    if (replyHtml) {
      const senderStr = sName
        ? _escapeHtmlText(sName) + ' &lt;' + _escapeHtmlText(sAddr) + '&gt;'
        : _escapeHtmlText(sAddr);
      const attribution = ProtonI18n.t('replyQuoteAttribution', _escapeHtmlText(dateStr), senderStr);
      const raw = _rawPreviewBody || '';
      const origHtml = /<[a-zA-Z!/][^>]*>/.test(raw)
        ? _sanitizeQuoteHtml(raw)
        : '<div>' + _escapeHtmlText(raw).replace(/\n/g, '<br>') + '</div>';
      // Insert via _setHTML (DOMParser-based), never raw innerHTML, with the
      // original sanitized above before it enters this contenteditable.
      _setHTML(replyBody, '<div><br></div><div class="protonmail_quote">' + attribution +
        '<br><blockquote class="protonmail_quote" type="cite">' + origHtml + '</blockquote></div>');
    } else {
      const senderStr = sName ? sName + ' <' + sAddr + '>' : sAddr;
      const attribution = ProtonI18n.t('replyQuoteAttribution', dateStr, senderStr);
      const quoted = _htmlToPlainText(_rawPreviewBody || '').split('\n').map(l => '> ' + l).join('\n');
      replyText.value = '\n\n' + attribution + '\n' + quoted;
    }
  }

  async function _populateReplyFrom(msg, accountId) {
    replyFromSelect.textContent = '';
    try {
      const addresses = await browser.runtime.sendMessage({ type: 'GET_ADDRESSES', accountId });
      if (!Array.isArray(addresses) || addresses.length === 0) {
        replyFromRow.classList.add('hidden');
        return;
      }

      _replyAddresses = addresses; // cache for reply-all "minus self" filtering

      // Decide which of our addresses should be the From, i.e. the one this
      // mail was sent TO. Mirrors Proton's own reply logic.
      let detectedEmail = null;   // an account address to pre-select
      let plusAlias = null;       // a +alias the mail was addressed to (not a real address)
      const recipients = [...(msg.ToList || []), ...(msg.CCList || [])];

      // 1. Most precise: a +alias the mail was addressed to (e.g.
      //    app+testers@domain matching our base app@domain). Proton pre-selects
      //    the +alias itself, so detect it FIRST, before the AddressID match,
      //    which only ever resolves to the base address.
      for (const r of recipients) {
        const addr = (r.Address || '').toLowerCase();
        if (!addr.includes('+')) continue;
        const [localWithPlus, domain] = addr.split('@');
        const basePart = localWithPlus.split('+')[0];
        const baseMatch = addresses.find(a => {
          const [myLocal, myDomain] = a.Email.toLowerCase().split('@');
          return myLocal === basePart && myDomain === domain;
        });
        if (baseMatch) { plusAlias = r.Address; detectedEmail = baseMatch.Email; break; }
      }

      // 2. Authoritative for non-alias mail: the message's AddressID. Proton
      //    stamps every message with the user address it belongs to (the
      //    receiving address); robust even when the recipient list doesn't
      //    literally contain our address (catch-all, delivered-to, lists).
      if (!detectedEmail && msg.AddressID) {
        const byId = addresses.find(a => a.ID && a.ID === msg.AddressID);
        if (byId) detectedEmail = byId.Email;
      }

      // 3. Exact recipient match.
      if (!detectedEmail) {
        for (const r of recipients) {
          const addr = (r.Address || '').toLowerCase();
          const exactMatch = addr && addresses.find(a => a.Email.toLowerCase() === addr);
          if (exactMatch) { detectedEmail = exactMatch.Email; break; }
        }
      }

      // 4. Default: the primary address (lowest Order), not whatever lands first.
      if (!detectedEmail) {
        const primary = addresses.reduce((best, a) =>
          (a.Order != null && (best.Order == null || a.Order < best.Order)) ? a : best, addresses[0]);
        detectedEmail = primary.Email;
      }

      for (const a of addresses) {
        const opt = document.createElement('option');
        opt.value = a.Email;
        opt.textContent = a.DisplayName ? a.DisplayName + ' <' + a.Email + '>' : a.Email;
        // Only pre-select a real address when no +alias was detected. When one
        // was, the prepended +alias option is the selected one.
        if (!plusAlias && a.Email.toLowerCase() === detectedEmail.toLowerCase()) opt.selected = true;
        replyFromSelect.appendChild(opt);
      }

      // A +alias the mail was addressed to isn't a separate account address;
      // offer it explicitly (first) and pre-select it so the reply goes out as
      // the alias, matching Proton's behaviour.
      if (plusAlias && plusAlias.includes('+')) {
        const plusOpt = document.createElement('option');
        plusOpt.value = plusAlias;
        plusOpt.textContent = plusAlias + ' ' + ProtonI18n.t('plusAlias');
        replyFromSelect.prepend(plusOpt);
        replyFromSelect.selectedIndex = 0;
      }

      const hasPlusAlias = plusAlias && plusAlias.includes('+');
      replyFromRow.classList.toggle('hidden', addresses.length <= 1 && !hasPlusAlias);
    } catch (e) {
      replyFromRow.classList.add('hidden');
    }
  }

  function displayDecryptedBody(body, fullMsg, accountId) {
    _rawPreviewBody = body;
    _inlineImages = new Map();
    // Free tier: plaintext only, no mode toggle. Premium: honor user's setting.
    _previewMode = isPremium() ? (_settings.previewFormat || 'html') : 'text';
    _updatePreviewModeIndicator();
    _renderPreviewBody();
    // Paint first, then fill the embedded images in. They are part of the
    // message's own attachments, so fetching them talks to Proton and not to
    // the sender: no tracking risk, hence no external-content opt-in.
    _resolveInlineImages(body, fullMsg, accountId);
  }

  /** Bare, lowercased Content-IDs referenced by <img src="cid:..."> in `html`. */
  function _cidRefs(html) {
    const out = new Set();
    const re = /<img\b[^>]*?\bsrc\s*=\s*(?:"cid:([^"]*)"|'cid:([^']*)'|cid:([^\s>]+))/gi;
    let m;
    while ((m = re.exec(html))) {
      const cid = _normalizeCid(m[1] || m[2] || m[3]);
      if (cid) out.add(cid);
    }
    return out;
  }

  /** Strip <>, percent-escapes and case from a Content-ID so both sides match. */
  function _normalizeCid(raw) {
    let s = String(raw || '').trim();
    try { s = decodeURIComponent(s); } catch (e) { /* keep the raw form */ }
    return s.replace(/^<+|>+$/g, '').trim().toLowerCase();
  }

  function _attachmentCid(att) {
    const h = att.Headers || {};
    return _normalizeCid(h['content-id'] || h['Content-ID'] || '');
  }

  /** Fetch + decrypt the embedded images this body references and re-render. */
  async function _resolveInlineImages(body, fullMsg, accountId) {
    if (!body || !fullMsg || !accountId) return;
    // Only the HTML view can show them, and attachment decryption is premium,
    // so on the free tier this would just fire requests the gate rejects.
    if (_previewMode !== 'html' || !isPremium()) return;
    const wanted = _cidRefs(body);
    if (wanted.size === 0) return;
    const embedded = (fullMsg.Attachments || []).filter(a => {
      const cid = _attachmentCid(a);
      return cid && wanted.has(cid) && /^image\//i.test(a.MIMEType || '');
    });
    if (embedded.length === 0) return;

    const senderAddress = (fullMsg.Sender && fullMsg.Sender.Address) || null;
    let resolved = 0;
    for (const att of embedded) {
      if (att.Size && att.Size > INLINE_IMAGE_MAX_BYTES) continue;
      const keyPackets = att.KeyPackets || null;
      try {
        const res = await browser.runtime.sendMessage({
          type: 'GET_ATTACHMENT', attachmentId: att.ID, accountId,
          keyPackets, signature: att.Signature || null,
          senderAddress,
        });
        if (!res || res.error || !res.data) continue;
        // Still ciphertext: a data: URL over it renders as a broken image, so
        // leave the cid unresolved and let the attachment list carry it.
        if (keyPackets && res.decrypted === false) continue;
        _inlineImages.set(_attachmentCid(att),
          'data:' + (att.MIMEType || 'image/jpeg') + ';base64,' + res.data);
        resolved++;
      } catch (err) {
        // Leave it unresolved; the attachment list keeps it reachable.
      }
    }
    // The user may have moved to another message while we were fetching. The
    // attachment list needs no refresh: it lists embedded images either way.
    if (resolved === 0 || _rawPreviewBody !== body) return;
    _renderPreviewBody();
  }

  function _getFormatTitle() {
    if (_previewMode === 'html') return 'HTML → TEXT';
    if (_previewMode === 'text') return 'TEXT → RAW';
    return 'RAW → HTML';
  }

  function _updatePreviewModeIndicator() {
    const indicator = document.getElementById('preview-mode-indicator');
    if (!indicator) return;
    if (_previewMode === 'html') indicator.textContent = 'HTML';
    else if (_previewMode === 'text') indicator.textContent = 'TEXT';
    else indicator.textContent = 'RAW';
  }

  function _prettifyHtml(html) {
    let formatted = '';
    let indent = 0;
    const tokens = html.replace(/>\s*</g, '>\n<').split('\n');
    for (const token of tokens) {
      const trimmed = token.trim();
      if (!trimmed) continue;
      if (trimmed.startsWith('</')) indent = Math.max(0, indent - 1);
      formatted += '  '.repeat(indent) + trimmed + '\n';
      if (trimmed.startsWith('<') && !trimmed.startsWith('</')
          && !trimmed.startsWith('<!') && !trimmed.endsWith('/>')
          && !/^<(br|hr|img|input|meta|link|area|base|col|embed|source|track|wbr)\b/i.test(trimmed)) {
        indent++;
      }
    }
    return formatted;
  }

  let _externalContentLoaded = false;

  /** Manual reading-pane canvas: null = let the heuristic decide, otherwise
   *  'light' | 'dark'. Set by the toggle button next to the format indicator,
   *  and kept for the rest of the popup session: mail that trips the
   *  automatic rule usually arrives in batches (same sender/client). */
  let _canvasOverride = null;

  /** Button cycle: automatic → dark → light → automatic. Dark comes first so
   *  the first click on the common case (a mail the heuristic put on white)
   *  visibly changes something; the third step restores the automatic choice,
   *  which is otherwise unreachable once overridden. */
  const CANVAS_CYCLE = { auto: 'dark', dark: 'light', light: null };
  /** Tooltip names the state the NEXT click selects. */
  const CANVAS_NEXT_TITLE = {
    auto: 'switchToDarkBackground',
    dark: 'switchToLightBackground',
    light: 'switchToAutoBackground',
  };

  /** Reflect the current canvas mode on the toggle button; hidden outside the
   *  rendered-HTML view, where there is no email canvas to flip. */
  function _updateCanvasButton(visible) {
    if (!btnToggleCanvas) return;
    btnToggleCanvas.classList.toggle('hidden', !visible);
    if (!visible) return;
    const state = _canvasOverride || 'auto';
    btnToggleCanvas.setAttribute('data-canvas', state);
    const title = ProtonI18n.t(CANVAS_NEXT_TITLE[state]);
    btnToggleCanvas.title = title;
    btnToggleCanvas.setAttribute('aria-label', title);
    btnToggleCanvas.classList.toggle('active', !!_canvasOverride);
  }

  /** First opaque background colour found walking up from the preview body,
   *  used as the iframe canvas so the email sits on the popup's own background. */
  function _previewBgColor() {
    let el = previewBody;
    while (el) {
      const bg = window.getComputedStyle(el).backgroundColor;
      if (bg && bg !== 'transparent' && !/rgba?\([^)]*,\s*0(\.0+)?\s*\)/.test(bg)) return bg;
      el = el.parentElement;
    }
    return '#ffffff';
  }

  /**
   * Gate <img> elements in the reading pane. Returns true if anything that
   * would have hit the network was withheld, which is what raises the
   * "External images blocked" banner.
   *
   * The distinction is egress, not origin. A `data:` URI carries its own bytes,
   * so no request leaves the machine and there is nothing for a sender to
   * observe; the CSP admits `data:` even while external content is blocked, and
   * the inline-style handler keeps `url(data:...)` for the same reason. Gating
   * them here made our OWN sent mail demand "Load external content" to show an
   * image that was never remote, because the composer embeds pasted images as
   * `data:` rather than as `cid:` parts.
   */
  function _gateImages(doc, loadExternal) {
    let blocked = false;
    doc.querySelectorAll('img').forEach(img => {
      const src = (img.getAttribute('src') || '').trim();
      const scheme = src.slice(0, 5).toLowerCase();
      if (scheme.startsWith('cid:')) {
        // Embedded image: swap in the decrypted data: URL. If it is not
        // resolved (still loading, too big, or the fetch failed) drop the tag,
        // and the attachment list keeps the image reachable instead.
        const data = _inlineImages.get(_normalizeCid(src.slice(4)));
        if (data) img.setAttribute('src', data);
        else img.remove();
      } else if (scheme !== 'data:' && src && !loadExternal) {
        blocked = true;
        img.removeAttribute('src');
        img.setAttribute('alt', img.getAttribute('alt') || '[image]');
      }
      // srcset names its own candidates whatever src holds, and an <img> can
      // carry srcset with no src at all, which the branch above never sees.
      if (!loadExternal && img.hasAttribute('srcset')) {
        if (/(^|[\s,])(https?:|\/\/)/i.test(img.getAttribute('srcset') || '')) blocked = true;
        img.removeAttribute('srcset');
      }
    });
    return blocked;
  }

  /** Build a self-contained, sanitized HTML document for an email body to be
   *  rendered inside a SANDBOXED iframe. The iframe is the isolation boundary:
   *  the email's CSS/layout can't leak into the popup UI, external fonts never
   *  load (CSP `font-src 'none'`: silences the gstatic console noise), remote
   *  images are gated, and with no `allow-scripts` sandbox flag any script in
   *  the email is inert. Returns { srcdoc, hasExternalContent, forceLight }. */
  function _buildEmailDocument(body, loadExternal, opts) {
    const { textColor, bgColor, colorScheme, heuristicOn, canvasOverride } = opts;
    const doc = new DOMParser().parseFromString(body, 'text/html');

    // Drop dangerous/unwanted elements (scripts can't run without allow-scripts,
    // but strip them for defense in depth).
    doc.querySelectorAll('script, link[rel="stylesheet"], meta, iframe, object, embed, form, base, title')
      .forEach(el => el.remove());

    // Strip vendor/legacy CSS that browsers don't support and just drop with a
    // console warning anyway (Outlook mso-* props, prefixed text-size-adjust,
    // -ms-interpolation-mode). Purely cosmetic. These were never applied.
    const stripDeadDecls = (css) => (css || '')
      .replace(/mso-[a-z-]+\s*:[^;}]*;?/gi, '')
      .replace(/-ms-interpolation-mode\s*:[^;}]*;?/gi, '')
      .replace(/(?:-webkit-|-ms-|-moz-)text-size-adjust\s*:[^;}]*;?/gi, '');
    // For <style> blocks also drop external/unsupported at-rules: @font-face and
    // @import pull in resources the iframe CSP blocks anyway (removing them
    // avoids a console CSP-violation per blocked resource, the whole point of
    // this change); @viewport/@-ms-viewport are unsupported and only warn.
    const cleanCss = (css) => stripDeadDecls(css)
      // Strip CSS comments first. Otherwise a commented-out url(http://…)
      // would trip the external-content gate below and get mangled.
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/@font-face\s*\{[^}]*\}/gi, '')
      .replace(/@(?:-ms-)?viewport\s*\{[^}]*\}/gi, '')
      .replace(/@import[^;]+;/gi, '');

    // Collect the email's own <style> blocks (kept INSIDE the iframe, no
    // .preview-html scoping needed anymore).
    let emailStyles = '';
    doc.querySelectorAll('style').forEach(styleEl => {
      // An HTML <style> is RAWTEXT, so its textContent can never contain
      // "</style>". An SVG <style> is foreign content, where <![CDATA[ ]]> is
      // honoured and "</style>" is ordinary text, and this selector matches it
      // too. Since the result is interpolated between literal <style> tags in
      // the srcdoc below, that text could otherwise close the block early and
      // inject markup past the sanitizer. Neutralise any closing tag.
      emailStyles += cleanCss(styleEl.textContent).replace(/<\/(style)/gi, '<\\/$1') + '\n';
      styleEl.remove();
    });

    // Decide the canvas before mutating further. The automatic rule is the
    // dark-mode fallback: ProtonEmailCanvas only reports "own canvas" for a
    // background covering the WHOLE message (lib/email-canvas.js). A
    // highlighted <span> from Outlook/web.de must not suppress it, or the
    // rest of a `color:#000` mail ends up black-on-dark. The reading-pane
    // button overrides that verdict for mail the rule still gets wrong.
    const autoLight = heuristicOn && colorScheme === 'dark' &&
      !ProtonEmailCanvas.hasOwnCanvas(doc, emailStyles);
    const forceLight = canvasOverride ? canvasOverride === 'light' : autoLight;
    const forceDark = canvasOverride === 'dark';

    let hasExternalContent = false;

    // Gate external url() in the email's <style> blocks exactly like inline
    // styles: until the user opts in, only data: URIs may load. A CSS
    // background fetch is network egress just like an <img>, and combined
    // with attribute selectors it can be abused as an exfiltration channel.
    if (!loadExternal) {
      const neutralized = emailStyles.replace(/url\s*\(\s*(?!['"]?\s*data:)[^)]*\)/gi, 'url()');
      if (neutralized !== emailStyles) {
        hasExternalContent = true;
        emailStyles = neutralized;
      }
    }

    // SMIL animation can rewrite an attribute AFTER we have sanitised it:
    // <a href="#"><animate attributeName="href" to="javascript:..."/></a> puts
    // the neutralised value straight back at document time. Remove the
    // animation elements so the sanitised state is the final state.
    doc.querySelectorAll('animate, set, animateTransform, animateMotion')
      .forEach(el => el.remove());

    // Sanitize attributes + inline styles; make links open in a new tab safely.
    doc.querySelectorAll('*').forEach(el => {
      for (const attr of [...el.attributes]) {
        if (attr.name.startsWith('on')) el.removeAttribute(attr.name);
      }
      // localName, not tagName: an SVG anchor's tagName is the lowercase
      // qualified name "a", so a tagName === 'A' test silently skips every
      // link inside inline SVG and leaves its href unfiltered.
      const tag = (el.localName || '').toLowerCase();
      if (tag === 'a' || tag === 'area') {
        // Both spellings: SVG 1.1 anchors carry xlink:href, which browsers
        // still follow, so filtering only href would leave them live.
        for (const attrName of ['href', 'xlink:href']) {
          const raw = el.getAttribute(attrName);
          if (!raw) continue;
          const href = raw.trim();
          // Whitelist link protocols. With allow-popups-to-escape-sandbox on the
          // iframe, a clicked data:/javascript:/blob: link would open OUTSIDE the
          // sandbox, so anything that isn't plain web/mail/tel (or an in-document
          // anchor) is neutralized the way Proton does it (purify.ts renames to
          // proton-href): the text stays visible, the link goes inert.
          if (/^(https?:|mailto:|tel:|#|\/\/)/i.test(href)) {
            el.setAttribute('rel', 'noopener noreferrer');
          } else {
            el.setAttribute('proton-href', href);
            el.removeAttribute(attrName);
          }
        }
      }
      const style = el.getAttribute('style');
      if (style) {
        let clean = stripDeadDecls(style)
          .replace(/expression\s*\([^)]*\)/gi, '')
          .replace(/javascript\s*:/gi, '')
          .replace(/position\s*:\s*(fixed|absolute)/gi, 'position: relative');
        // Block external url() in inline styles unless allowed, but keep
        // data: URIs (embedded images, no network egress), matching the
        // <style>-block neutralization above.
        if (!loadExternal) {
          const cleaned = clean.replace(/url\s*\(\s*(?!['"]?\s*data:)[^)]*\)/gi, 'url()');
          if (cleaned !== clean) { hasExternalContent = true; clean = cleaned; }
        }
        el.setAttribute('style', clean);
      }
    });

    // Resolve cid: parts, keep inert data: URIs, stub anything that would fetch.
    if (_gateImages(doc, loadExternal)) hasExternalContent = true;

    const imgCsp = loadExternal ? 'data: https: http:' : 'data:';
    const csp = "default-src 'none'; style-src 'unsafe-inline'; img-src " + imgCsp +
      '; media-src ' + imgCsp + "; font-src 'none'";
    // A forced dark canvas can't reuse the popup's colours (in a light theme
    // they are dark-on-light), so it carries its own readable pair.
    const canvasFg = forceLight ? '#1a1a1a' : (forceDark ? '#e6e6e6' : textColor);
    const canvasBg = forceLight ? '#ffffff' : (forceDark ? '#1c1c1e' : bgColor);
    const baseCss =
      'html,body{margin:0;padding:0;}' +
      'body{font:13px/1.6 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;' +
      'color:' + canvasFg + ';' +
      'background:' + canvasBg + ';' +
      'word-wrap:break-word;overflow-wrap:break-word;}' +
      'img{max-width:100%!important;height:auto!important;}' +
      'pre,code{white-space:pre-wrap;max-width:100%;overflow-x:auto;}' +
      'ol,ul{padding-left:2.5em;}' +
      'blockquote{border-left:3px solid #8888;margin:8px 0;padding:4px 12px;}' +
      'h1,h2,h3{font-size:1.1em;margin:8px 0 4px;}' +
      'table{max-width:100%;}';

    const srcdoc =
      '<!DOCTYPE html><html><head>' +
      '<meta http-equiv="Content-Security-Policy" content="' + csp + '">' +
      '<meta name="color-scheme" content="' +
      (forceLight ? 'light' : (forceDark ? 'dark' : 'light dark')) + '">' +
      '<base target="_blank">' +
      '<style>' + baseCss + '</style>' +
      '<style>' + emailStyles + '</style>' +
      '</head><body>' + doc.body.innerHTML + '</body></html>';

    return { srcdoc, hasExternalContent, forceLight };
  }

  /** Mount (or refresh) the sandboxed email iframe inside #preview-body and
   *  auto-size it to its content so the outer .preview-scroll handles scroll. */
  function _mountEmailIframe(srcdoc) {
    previewBody.classList.remove('preview-plaintext');
    previewBody.classList.add('preview-html');
    let frame = previewBody.querySelector('iframe.email-frame');
    if (!frame) {
      previewBody.textContent = '';
      frame = document.createElement('iframe');
      frame.className = 'email-frame';
      // No allow-scripts → email JS is inert. allow-same-origin lets us measure
      // content height; allow-popups* lets target=_blank links open a real tab.
      frame.setAttribute('sandbox', 'allow-same-origin allow-popups allow-popups-to-escape-sandbox');
      frame.setAttribute('referrerpolicy', 'no-referrer');
      previewBody.appendChild(frame);
    }
    const resize = () => {
      try {
        const d = frame.contentDocument;
        if (d) frame.style.height = (d.documentElement.scrollHeight || d.body.scrollHeight || 0) + 'px';
      } catch (e) { /* opaque-origin guard */ }
    };
    frame.onload = () => {
      resize();
      try {
        frame.contentDocument.querySelectorAll('img').forEach(img => {
          img.addEventListener('load', resize);
          img.addEventListener('error', resize);
        });
      } catch (e) { /* ignore */ }
      // Settle late reflow (layout shifts, any images that do load).
      setTimeout(resize, 60);
      setTimeout(resize, 300);
    };
    frame.srcdoc = srcdoc;
  }

  function _renderPreviewBody() {
    const body = _rawPreviewBody;
    if (!body) return;
    if (_previewMode === 'html') {
      // Plain-text bodies (no HTML tags at all) must not go through DOMParser
      // -- the browser collapses whitespace during layout and destroys the
      // original line structure. Render them with preserved whitespace
      // instead, keeping _previewMode === 'html' so the toggle cycle is
      // unchanged.
      if (!/<[a-zA-Z!/][^>]*>/.test(body)) {
        previewBody.classList.remove('preview-html');
        previewBody.classList.remove('email-canvas-light');
        previewBody.classList.add('preview-plaintext');
        externalContentBanner.classList.add('hidden');
        _updateCanvasButton(false);
        previewBody.textContent = body;
        return;
      }
      const loadExternal = _externalContentLoaded || (_settings && _settings.alwaysLoadExternalContent);
      // Render the email HTML inside a sandboxed, style-isolated iframe.
      const cs = window.getComputedStyle(previewBody);
      const { srcdoc, hasExternalContent, forceLight } =
        _buildEmailDocument(body, loadExternal, {
          textColor: cs.color || '#1a1a1a',
          bgColor: _previewBgColor(),
          colorScheme: document.body.getAttribute('data-color-scheme') || 'light',
          heuristicOn: !_settings || _settings.emailCanvasHeuristic !== false,
          canvasOverride: _canvasOverride,
        });

      // Show/hide external content banner.
      if (hasExternalContent && !loadExternal) {
        externalContentBanner.classList.remove('hidden');
      } else {
        externalContentBanner.classList.add('hidden');
      }

      // Keep the outer class in parity (the canvas itself is applied in-iframe).
      previewBody.classList.toggle('email-canvas-light', forceLight);
      _updateCanvasButton(true);
      _mountEmailIframe(srcdoc);
    } else if (_previewMode === 'text') {
      previewBody.classList.remove('preview-html');
      previewBody.classList.remove('email-canvas-light');
      previewBody.classList.add('preview-plaintext');
      _updateCanvasButton(false);
      const text = extractTextFromHtml(body);
      previewBody.textContent = text || body.substring(0, 2000);
    } else {
      // RAW: show the original source, optionally prettified. Prettify is
      // only meaningful for HTML; applied to a plain-text body it would
      // strip blank lines, so skip it when no tags are present.
      previewBody.classList.remove('preview-html');
      previewBody.classList.remove('email-canvas-light');
      previewBody.classList.add('preview-plaintext');
      _updateCanvasButton(false);
      const hasHtmlTags = /<[a-zA-Z!/][^>]*>/.test(body);
      previewBody.textContent = (_settings.prettifyRaw && hasHtmlTags) ? _prettifyHtml(body) : body;
    }
  }

  /** Convert an HTML email body to plain text while preserving paragraph
   *  structure: block-level elements produce line breaks, <br> produces a
   *  single line break, and within text runs whitespace is collapsed. */
  function extractTextFromHtml(html) {
    if (!html) return '';
    if (!html.includes('<') && !html.includes('&')) return html.trim();

    const parser = new DOMParser();
    const doc = parser.parseFromString(html, 'text/html');

    // Drop elements whose content should not appear in text output
    doc.querySelectorAll('script, style, head, noscript, template').forEach(el => el.remove());

    const BLOCK = new Set([
      'P', 'DIV', 'SECTION', 'ARTICLE', 'HEADER', 'FOOTER', 'NAV', 'ASIDE',
      'MAIN', 'BLOCKQUOTE', 'PRE', 'FIGURE', 'FIGCAPTION', 'ADDRESS',
      'H1', 'H2', 'H3', 'H4', 'H5', 'H6',
      'UL', 'OL', 'LI', 'DL', 'DT', 'DD',
      'TABLE', 'TR', 'HR',
    ]);

    const parts = [];
    const walk = (node) => {
      if (node.nodeType === Node.TEXT_NODE) {
        // Collapse runs of whitespace inside a single text node but keep
        // single spaces so inline content (e.g. <span>foo</span> bar) stays
        // readable.
        const t = node.nodeValue.replace(/\s+/g, ' ');
        if (t) parts.push(t);
        return;
      }
      if (node.nodeType !== Node.ELEMENT_NODE) return;
      const tag = node.tagName;
      if (tag === 'BR') { parts.push('\n'); return; }
      const isBlock = BLOCK.has(tag);
      if (isBlock) parts.push('\n');
      for (const child of node.childNodes) walk(child);
      if (isBlock) parts.push('\n');
    };
    walk(doc.body);

    // Tidy: collapse inline whitespace, strip around linebreaks, then cap
    // runs of blank lines at one. Finally trim and cap total length so we
    // don't drop a 200 kB newsletter onto the DOM in one go.
    const text = parts.join('')
      .replace(/[ \t]+/g, ' ')
      .replace(/ *\n */g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
    return text.length > 50000 ? text.substring(0, 50000) + '\n…' : text;
  }

  /**
   * Ask before an action that would abandon a reply in progress. Returns false
   * when the user says no, so the caller aborts.
   *
   * The guard lives inside closePreview/openPreview rather than on each button
   * because there are a dozen ways out of the preview (Escape, clicking another
   * message, prev/next, archive, trash, spam, phishing, bulk actions, the
   * accounts view) and putting it on one of them, as the first version of this
   * did, protects the reply from exactly one of them.
   *
   * `force` is for the paths with nothing to ask about: a completed send, a
   * draft being restored, or a poll finding the message is gone.
   */
  async function _confirmLeavingReply(force) {
    if (force) return true;
    if (!_replyHasUnsentContent()) return true;
    return ProtonDialog.confirm(ProtonI18n.t('discardDraftConfirm'), {
      confirmLabel: ProtonI18n.t('discard'),
      danger: true,
    });
  }

  async function closePreview(opts) {
    if (!await _confirmLeavingReply(opts && opts.force)) return false;
    // Dismiss any colour/emoji picker portaled to <body>, else it orphans.
    if (typeof PopupEditorToolbar !== 'undefined') PopupEditorToolbar.closeAllPopups();
    _selectedMsg = null;
    _replyAttachments = [];
    _renderReplyAttachments();
    if (replySendOpts) replySendOpts.reset();
    if (replyDriveShare) replyDriveShare.reset();
    previewPanel.classList.remove('visible');
    // Wait for slide-out animation, then hide
    setTimeout(() => previewPanel.classList.add('hidden'), 200);
    document.querySelectorAll('.message-item').forEach(el => el.classList.remove('selected'));
    // Reset the forced-canvas class (email styles are isolated in the iframe).
    previewBody.classList.remove('email-canvas-light');
    // The reply editor is gone with the preview, so nothing is in progress any
    // more. Left true, _replyHasUnsentContent would keep answering yes and
    // prompt again on the next unrelated close.
    _replyEditorOpen = false;
    _replyBaseline = '';
    return true;
  }

  /** Would backing out of the reply editor throw away the user's work? A
   *  restored draft counts, since its body will not match any baseline. */
  function _replyHasUnsentContent() {
    if (!_replyEditorOpen) return false;
    if (_replyAttachments.length > 0) return true;
    if (replySendOpts) {
      const v = replySendOpts.getValues();
      if (v.deliveryTime || v.expiresIn || v.eoPassword) return true;
    }
    const now = (_settings.replyFormat === 'html') ? replyBody.innerHTML : replyText.value;
    return (now || '').trim() !== (_replyBaseline || '').trim();
  }

  btnClosePreview.addEventListener('click', async () => {
    // Compose has always asked before dropping a draft; the reply editor threw
    // the work away silently.
    // closePreview() does the asking now, for every exit rather than this one.
    // Prompting here too asked twice. It returns false when the user declines,
    // so the stored draft is only dropped once the close actually happened.
    if (await closePreview()) _clearDraft();
  });

  // --- Draft persistence across popup close/reopen ---

  function _scheduleDraftSave() {
    if (_restoringDraft) return;
    clearTimeout(_draftDebounce);
    _draftDebounce = setTimeout(_saveDraft, 500);
  }

  // Force-save draft when popup is about to close (focus loss)
  // Flush on both signals. pagehide is the one an extension popup reliably
  // gets when it is dismissed, but it was the ONLY flush point in the whole
  // popup: a single missed event and everything typed since the last 500ms
  // debounce tick is gone. visibilitychange fires first when the popup loses
  // focus, so the two cover each other. Saving twice is harmless, since
  // _saveDraft snapshots the live DOM rather than queueing anything.
  function _flushDrafts() {
    _saveDraft();
    _saveAccountDraft();
  }

  window.addEventListener('pagehide', _flushDrafts);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') _flushDrafts();
  });

  // --- Add-account form persistence (so the popup remembers the partially
  // filled Sign-in form when the user closes the popup to grab a password
  // from their password manager) ---

  let _accountDraftDebounce = null;

  function _scheduleAccountDraftSave() {
    clearTimeout(_accountDraftDebounce);
    _accountDraftDebounce = setTimeout(_saveAccountDraft, 250);
  }

  function _saveAccountDraft() {
    // Only persist while the user is in the Accounts state. Once they
    // navigate away (back to inbox, success, etc.) the draft is cleared.
    if (!_showingAccounts) return;
    // Only save the basic login form (not 2FA / mailbox-pwd). Those
    // have their own pending state handled by the background.
    if (loginForm.classList.contains('hidden')) return;
    // Persist the username only: passwords must never touch storage.
    // The user re-types the password on the next popup open; saving
    // just the username covers the common Bitwarden-copy-paste pattern
    // ("typed user, popup closed, reopened to paste password").
    const u = loginUsername.value;
    if (!u) {
      browser.storage.local.remove('popupAccountDraft').catch(() => {});
      return;
    }
    browser.storage.local.set({
      popupAccountDraft: { username: u, savedAt: Date.now() },
    }).catch(() => {});
  }

  function _clearAccountDraft() {
    clearTimeout(_accountDraftDebounce);
    browser.storage.local.remove('popupAccountDraft').catch(() => {});
  }

  async function _restoreAccountDraft() {
    let stored;
    try { stored = await browser.storage.local.get('popupAccountDraft'); }
    catch (e) { return false; }
    const draft = stored && stored.popupAccountDraft;
    if (!draft || !draft.username) return false;
    // Auto-open the Accounts view with the username pre-filled so the
    // user can paste their password without re-typing the address. The
    // password is never stored. Focus it for the user.
    showAccountsView();
    loginUsername.value = draft.username;
    loginPassword.value = '';
    loginPassword.focus();
    return true;
  }

  // Debounced save on input change.
  loginUsername.addEventListener('input', _scheduleAccountDraftSave);
  loginPassword.addEventListener('input', _scheduleAccountDraftSave);

  function _saveDraft() {
    if (_restoringDraft) return;
    const draft = {};
    if (!composePanel.classList.contains('hidden')) {
      draft.type = 'compose';
      draft.composeAccountId = _composeAccountId;
      draft.composeFrom = composeFrom.value;
      draft.composeSubject = composeSubject.value;
      draft.composeBody = composeBody.innerHTML;
      // Snapshot for cross-session undo. Recorded here rather than on every
      // keystroke so a state exists exactly where a draft does.
      const ch = _historyFor(composeBody);
      if (ch) { ch.record(); draft.composeHistory = ch.serialize(); }
      draft.composeTo = chipTo.getChips();
      draft.composeCc = chipCc.getChips();
      draft.composeBcc = chipBcc.getChips();
      draft.composeCcBccVisible = !composeCcBccRows.classList.contains('hidden');
      // Saved as raw text, NOT committed to a chip. Committing on save turned
      // a half-typed address into an invalid chip the moment the user paused
      // for the 500ms debounce, which made the field unusable.
      draft.composeToPending = chipTo.getPending();
      draft.composeCcPending = chipCc.getPending();
      draft.composeBccPending = chipBcc.getPending();
      if (composeSendOpts) draft.sendOptions = composeSendOpts.getValues();
      if (composeDriveShare) draft.driveOptions = composeDriveShare.getValues();
      // Persist attachments (base64 data survives popup close)
      if (_composeAttachments.length > 0) {
        draft.attachments = _composeAttachments.map(a => ({
          name: a.file.name, type: a.file.type, size: a.file.size,
          data: a._base64Data || null,
        }));
      }
    } else if (_replyEditorOpen && _selectedMsg) {
      draft.type = 'reply';
      draft.selectedMsgId = _selectedMsg.ID;
      draft.selectedMsgAccountId = _selectedMsg._accountId;
      draft.replyMode = _replyMode;
      draft.replyText = replyText.value;
      draft.replyBody = _draftReplyBody();
      // Same snapshot as compose, for undo after the popup has been reopened.
      const rh = _historyFor(replyBody);
      if (rh) { rh.record(); draft.replyHistory = rh.serialize(); }
      draft.replyFromValue = replyFromSelect.value;
      draft.forwardTo = chipForwardTo.getChips();
      draft.replyCc = chipReplyCc.getChips();
      draft.replyBcc = chipReplyBcc.getChips();
      draft.replyCcBccVisible = !replyCcBccRows.classList.contains('hidden');
      draft.forwardToPending = chipForwardTo.getPending();
      draft.replyCcPending = chipReplyCc.getPending();
      draft.replyBccPending = chipReplyBcc.getPending();
      if (replySendOpts) draft.sendOptions = replySendOpts.getValues();
      if (replyDriveShare) draft.driveOptions = replyDriveShare.getValues();
      // Persist reply/forward attachments too (compose already does)
      if (_replyAttachments.length > 0) {
        draft.attachments = _replyAttachments.map(a => ({
          name: a.file.name, type: a.file.type, size: a.file.size,
          data: a._base64Data || null,
        }));
      }
    } else {
      // Nothing is open, so there is nothing to save. Do NOT erase what is on
      // disk: closePreview() nulls _selectedMsg and openPreview() clears
      // _replyEditorOpen, so every way of leaving a reply lands here, and the
      // pagehide flush then deleted the very draft that exists to survive the
      // popup closing. A draft is only ever dropped deliberately, by
      // _clearDraft() on an explicit discard or a completed send.
      return;
    }
    // The background encrypts the draft before it touches disk (a reply
    // draft embeds the quoted decrypted original, and sendOptions can carry
    // an Encrypted-Outside password). Fire-and-forget so the pagehide save
    // still dispatches from a closing popup.
    // Stamped so a reopened popup can say when the draft it is showing was
    // stored, rather than starting blank until the next save.
    draft.savedAt = Date.now();
    browser.runtime.sendMessage({ type: 'SAVE_DRAFT', draft })
      .then((res) => _noteDraftSave(!res || res.success !== false, res && res.error))
      .catch((err) => _noteDraftSave(false, err && err.message));
  }

  // Whether the last draft save is believed to have worked. A save that fails
  // is indistinguishable from one that works unless somebody looks, and this
  // one has form: an embedded photo can push the draft past Chrome's 10 MB
  // storage quota, every save then rejects, and the reply is gone the moment
  // the popup closes. Better to say so while the text is still on screen.
  let _draftSaveHealthy = true;

  const _savedAtEls = ['compose-saved-at', 'reply-saved-at']
    .map((id) => document.getElementById(id)).filter(Boolean);

  /**
   * Show when the draft was last stored.
   *
   * Driven from _noteDraftSave, the only place that knows a save actually
   * persisted, so the label can never claim one that failed. An absolute time
   * rather than "2 minutes ago": it needs no ticking timer, and the question
   * being answered is "is what I am looking at saved", not "how long ago".
   */
  function _showSavedAt(ts) {
    if (!ts) return;
    let time;
    try {
      // hourCycle h23 forces 24-hour. Left to the browser locale this rendered
      // "12:39 AM" on an en-US profile; the hour format is a fixed choice here
      // rather than something that shifts with whatever locale the browser
      // happens to carry.
      time = new Date(ts).toLocaleTimeString(undefined, {
        hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
      });
    } catch (e) {
      return; // a label is not worth an exception
    }
    const text = ProtonI18n.t('draftSavedAt', time);
    _savedAtEls.forEach((el) => { el.textContent = text; });
  }

  /** Clear it, for a panel that no longer has a draft behind it. */
  function _clearSavedAt() {
    _savedAtEls.forEach((el) => { el.textContent = ''; });
  }

  function _noteDraftSave(ok, reason) {
    if (ok) {
      _draftSaveHealthy = true;
      _showSavedAt(Date.now());
      return;
    }
    // Warn once per run of failures: _saveDraft fires on a 500ms debounce, so
    // a toast per keystroke would bury the message it is trying to deliver.
    if (!_draftSaveHealthy) return;
    _draftSaveHealthy = false;
    console.warn('[Popup] draft save failed:', reason || '(no reason given)');
    showToast(ProtonI18n.t('draftSaveFailed'));
  }

  /**
   * The reply body as it should be STORED. Embedded images are shown from their
   * decrypted bytes, so innerHTML carries a full data: URI per picture. A 6 MB
   * photo costs roughly 1.83x that once the draft is JSON-encoded, AES-GCM
   * encrypted and base64'd, and Chrome's storage.local quota is 10 MB with no
   * unlimitedStorage in the manifest, so every save rejected and the typed reply
   * was never persisted at all: the paperclip saves and immediately closes the
   * popup, so the whole reply vanished.
   *
   * Only the cid: parking is undone, never the remote-URL parking: putting a
   * restored draft back with live remote URLs would fetch trackers in the popup.
   */
  function _draftReplyBody() {
    const doc = new DOMParser().parseFromString(replyBody.innerHTML || '', 'text/html');
    doc.querySelectorAll('img[data-mcpm-cidsrc]').forEach(img => {
      const parked = img.getAttribute('data-mcpm-cidsrc') || '';
      if (/^\s*cid:/i.test(parked)) img.setAttribute('src', parked);
    });
    return doc.body.innerHTML;
  }

  /** Re-draw the embedded images of a restored draft, whose stored body carries
   *  cid: references rather than the bytes. */
  function _resolveDraftCidImages() {
    replyBody.querySelectorAll('img[data-mcpm-cidsrc]').forEach(img => {
      const src = (img.getAttribute('src') || '').trim();
      if (!/^cid:/i.test(src)) return;
      const resolved = _inlineImages.get(_normalizeCid(src.slice(4)));
      if (resolved) img.setAttribute('src', resolved);
    });
  }

  function _clearDraft() {
    _clearSavedAt();
    clearTimeout(_draftDebounce);
    // Route through the background's draft chain (not a direct storage
    // remove) so a still-in-flight debounced SAVE_DRAFT cannot land after
    // the clear and resurrect a sent/discarded draft on disk.
    browser.runtime.sendMessage({ type: 'SAVE_DRAFT', draft: null }).catch(() => {});
  }

  /**
   * Drop an image into an editor body, ahead of the quoted original when there
   * is one, so it lands in what the user is writing instead of below the quote.
   *
   * The src is a data: URI on purpose. _inlineDataUrlImages converts every one
   * of them to a proper cid: part at send time, so this reuses that single
   * conversion rather than growing a second path that has to stay in step.
   */
  function _insertInlineImage(bodyEl, dataUrl, filename) {
    const img = document.createElement('img');
    img.src = dataUrl;
    // The name survives into the generated MIME part: _inlineDataUrlImages
    // takes alt as the filename when it already looks like one.
    if (filename) img.alt = filename;
    img.style.maxWidth = '100%';
    const holder = document.createElement('div');
    holder.appendChild(img);
    const quote = bodyEl.querySelector('.protonmail_quote');
    if (quote) bodyEl.insertBefore(holder, quote);
    else bodyEl.appendChild(holder);
  }

  /**
   * What to do with a picked file, given the "Image attachments" setting.
   *
   * `embed` draws it in the body, `list` keeps it in the attachment row. Only
   * images are ever embedded, and only into an HTML body: plain-text mode has
   * nowhere to put one. Any unrecognised mode attaches, which is what the
   * extension did before this setting was read at all.
   */
  function _imageAttachPlan(mimeType, mode, htmlBody) {
    const isImage = String(mimeType || '').toLowerCase().startsWith('image/');
    const embed = isImage && !!htmlBody && (mode === 'inline' || mode === 'both');
    return { embed, list: !embed || mode === 'both' };
  }

  // Pick up files saved by the filepicker.html tab (stored encrypted; the
  // background decrypts and removes them in one step)
  async function _pickUpPendingAttachments() {
    try {
      // Check BEFORE taking, exactly as _pickUpPendingDriveLinks does. TAKE
      // removes the files from storage, so the popup then holds the only copy;
      // with no editor open they were pushed into a hidden compose panel and
      // lost. That happens for real: the paperclip closes the popup, and if the
      // replied-to message leaves the polled set while the picker tab is open,
      // the draft cannot be restored and neither editor comes back. Leaving
      // them parked means the next popup open still finds them.
      const isReplyMode = _replyEditorOpen && _selectedMsg;
      const composeOpen = !composePanel.classList.contains('hidden');
      if (!isReplyMode && !composeOpen) return;
      const pending = await browser.runtime.sendMessage({ type: 'TAKE_PENDING_ATTACHMENTS' });
      if (!pending || !Array.isArray(pending) || pending.length === 0) return;
      const targetArray = isReplyMode ? _replyAttachments : _composeAttachments;
      // "Image attachments" from Settings, which until now was stored, synced
      // and never read. Plain-text mode has no body to embed into, so it falls
      // back to attaching whatever the setting says.
      const mode = _settings.imageAttachMode || 'attachment';
      const htmlBody = isReplyMode
        ? (_settings.replyFormat === 'html')
        : ((_settings.composeFormat || 'html') === 'html');
      const bodyEl = isReplyMode ? replyBody : composeBody;
      for (const att of pending) {
        const plan = _imageAttachPlan(att.type, mode, htmlBody);
        if (plan.embed) {
          _insertInlineImage(bodyEl, 'data:' + att.type + ';base64,' + att.data, att.name);
        }
        if (plan.list) {
          targetArray.push({
            file: { name: att.name, type: att.type, size: att.size },
            _base64Data: att.data,
          });
        }
      }
      if (isReplyMode) _renderReplyAttachments();
      else _renderComposeAttachments();
      _saveDraft();
    } catch (e) {
      console.warn('[Attachments] Failed to pick up pending files:', e);
    }
  }

  // Insert finished Drive share links (from the picker-tab upload) into the
  // open editor. Links are only TAKEN from storage when an editor is open.
  // Otherwise they stay parked (encrypted) for the next popup open, since
  // taking them is destructive.
  async function _pickUpPendingDriveLinks() {
    const isReplyMode = _replyEditorOpen && _selectedMsg;
    const composeOpen = !composePanel.classList.contains('hidden');
    if (!isReplyMode && !composeOpen) return;
    let links = null;
    try {
      links = await browser.runtime.sendMessage({ type: 'TAKE_PENDING_DRIVE_LINKS' });
    } catch (_) { return; }
    if (!links || !Array.isArray(links) || links.length === 0) return;

    const extras = (e) => {
      const parts = [];
      if (e.expirationTime) {
        parts.push(ProtonI18n.t('expiresOn') + ' ' +
          new Date(e.expirationTime * 1000).toLocaleDateString());
      }
      if (e.hasCustomPassword) parts.push(ProtonI18n.t('drivePasswordProtected'));
      return parts.length ? ' (' + parts.join(', ') + ')' : '';
    };

    const isHtml = isReplyMode
      ? _settings.replyFormat === 'html'
      : (_settings.composeFormat || 'html') === 'html';
    if (isReplyMode && !isHtml) {
      // Plaintext reply/forward: append "name: url" lines to the textarea.
      const lines = links.map((e) => `${e.name}: ${e.url}${extras(e)}`).join('\n');
      replyText.value = replyText.value.replace(/\n*$/, '\n\n') + lines + '\n';
    } else {
      // Contenteditable surfaces. Plaintext compose is sent as innerText, so
      // anchors would flatten to just the filename. Write "name: url" text
      // lines there; rich HTML gets one anchor line per file.
      const editor = isReplyMode ? replyBody : composeBody;
      for (const e of links) {
        const div = document.createElement('div');
        if (isHtml) {
          const a = document.createElement('a');
          a.href = e.url;
          a.textContent = e.name;
          div.appendChild(a);
          const extra = extras(e);
          if (extra) div.appendChild(document.createTextNode(extra));
        } else {
          div.textContent = `${e.name}: ${e.url}${extras(e)}`;
        }
        editor.appendChild(div);
      }
    }

    if (links.some((e) => e.editorDenied)) {
      showToast(ProtonI18n.t('driveEditorNeedsPaidProton'));
    } else {
      showToast(ProtonI18n.t('driveLinksInserted'));
    }
    _saveDraft();
  }

  async function _restoreDraft() {
    let draft;
    try {
      draft = await browser.runtime.sendMessage({ type: 'GET_DRAFT' });
    } catch (e) {
      return false;
    }
    if (!draft || !draft.type) return false;

    _restoringDraft = true;
    try {
      if (draft.type === 'compose') {
        // Verify account still exists before opening compose
        const accounts = _savedState && _savedState.accounts;
        if (!accounts || accounts.length === 0) return false;
        openCompose(draft.composeAccountId);
        // Wait for accounts dropdown to populate
        await new Promise(r => setTimeout(r, 150));
        if (draft.composeFrom) composeFrom.value = draft.composeFrom;
        composeSubject.value = draft.composeSubject || '';
        _showSavedAt(draft.savedAt);
        _setHTML(composeBody, draft.composeBody || '');
        // The editor now shows the newest saved state, so the history cursor
        // starts at the end and Ctrl+Z walks backwards from here.
        const ch = _historyFor(composeBody);
        if (ch) ch.restore(draft.composeHistory);
        if (draft.composeTo) draft.composeTo.forEach(c => chipTo.addChip(c.address, c.name));
        if (draft.composeCc) draft.composeCc.forEach(c => chipCc.addChip(c.address, c.name));
        if (draft.composeBcc) draft.composeBcc.forEach(c => chipBcc.addChip(c.address, c.name));
        if (draft.composeCcBccVisible) composeCcBccRows.classList.remove('hidden');
        chipTo.setPending(draft.composeToPending);
        chipCc.setPending(draft.composeCcPending);
        chipBcc.setPending(draft.composeBccPending);
        // Restore attachments from draft
        if (draft.attachments && draft.attachments.length > 0) {
          for (const att of draft.attachments) {
            _composeAttachments.push({
              file: { name: att.name, type: att.type, size: att.size },
              _base64Data: att.data,
            });
          }
          _renderComposeAttachments();
        }
        if (composeSendOpts && draft.sendOptions) composeSendOpts.setValues(draft.sendOptions);
        if (composeDriveShare && draft.driveOptions) composeDriveShare.setValues(draft.driveOptions);
        return true;
      }

      if (draft.type === 'reply') {
        if (!_savedState || !_savedState.messages || _savedState.messages.length === 0) {
          return false;
        }
        const msg = _savedState.messages.find(
          m => m.ID === draft.selectedMsgId && m._accountId === draft.selectedMsgAccountId);
        if (!msg) { _clearDraft(); return false; }
        await openPreview(msg, { force: true });
        _replyMode = draft.replyMode || 'reply';
        _replyEditorOpen = true;
        _updateReplyModeUI();
        replyText.value = draft.replyText || '';
        _showSavedAt(draft.savedAt);
        _setHTML(replyBody, draft.replyBody || '');
        const rh = _historyFor(replyBody);
        if (rh) rh.restore(draft.replyHistory);
        _resolveDraftCidImages();
        // Wait for sender dropdown to populate, then restore selection
        await new Promise(r => setTimeout(r, 200));
        if (draft.replyFromValue) replyFromSelect.value = draft.replyFromValue;
        if (draft.forwardTo) draft.forwardTo.forEach(c => chipForwardTo.addChip(c.address, c.name));
        if (draft.replyCc) draft.replyCc.forEach(c => chipReplyCc.addChip(c.address, c.name));
        if (draft.replyBcc) draft.replyBcc.forEach(c => chipReplyBcc.addChip(c.address, c.name));
        if (draft.replyCcBccVisible) replyCcBccRows.classList.remove('hidden');
        chipForwardTo.setPending(draft.forwardToPending);
        chipReplyCc.setPending(draft.replyCcPending);
        chipReplyBcc.setPending(draft.replyBccPending);
        if (replySendOpts && draft.sendOptions) replySendOpts.setValues(draft.sendOptions);
        if (replyDriveShare && draft.driveOptions) replyDriveShare.setValues(draft.driveOptions);
        if (draft.attachments && draft.attachments.length > 0) {
          for (const att of draft.attachments) {
            _replyAttachments.push({
              file: { name: att.name, type: att.type, size: att.size },
              _base64Data: att.data,
            });
          }
          _renderReplyAttachments();
        }
        return true;
      }
    } catch (e) {
      console.warn('[Draft] Restore error:', e);
      _clearDraft();
    } finally {
      // Structural, not eight hand-placed assignments: _saveDraft returns
      // early while this is set, so leaking it on any exit disables draft
      // saving for the rest of the popup's life and loses the reply silently.
      _restoringDraft = false;
    }
    return false;
  }

  /**
   * Reopen a specific message in a popped-out window carrying ?msg=&acct=
   * (the preview "pop out" button). Skipped if a draft already reopened a
   * preview, or the message is no longer in the polled set.
   */
  async function _maybeOpenDeepLinkedMessage() {
    const params = new URLSearchParams(location.search);
    const msgId = params.get('msg');
    if (!msgId) return;
    if (!previewPanel.classList.contains('hidden')) return; // already open via draft
    const acct = params.get('acct') || '';
    const msg = _savedState && _savedState.messages &&
      _savedState.messages.find(m => m.ID === msgId && (!acct || m._accountId === acct));
    if (msg) await openPreview(msg, { force: true });
  }

  // Draft auto-save listeners are attached after compose elements are declared (see below)

  btnLoadExternal.addEventListener('click', () => {
    _externalContentLoaded = true;
    externalContentBanner.classList.add('hidden');
    _renderPreviewBody();
    // Loading external content now also permits the sender icon. Refresh the
    // preview avatar so it appears (unless the always-on option already did).
    if (_selectedMsg) {
      previewAvatar.textContent = '';
      const a = createAvatarEl(_selectedMsg, _senderIconsAllowed(true));
      previewAvatar.appendChild(a.querySelector('.msg-avatar'));
    }
  });

  // Flip the reading pane between a light and a dark canvas. The automatic
  // rule (lib/email-canvas.js) can't win every case: some mail sets dark
  // text without a background, some sets light text on a background it only
  // paints partially, so this is the manual escape hatch.
  if (btnToggleCanvas) {
    btnToggleCanvas.addEventListener('click', () => {
      _canvasOverride = CANVAS_CYCLE[_canvasOverride || 'auto'];
      _renderPreviewBody();
    });
  }

  btnToggleFormat.addEventListener('click', () => {
    if (!requirePremium('htmlPreview')) return;
    if (_previewMode === 'html') _previewMode = 'text';
    else if (_previewMode === 'text') _previewMode = 'raw';
    else _previewMode = 'html';
    btnToggleFormat.title = _getFormatTitle();
    _updatePreviewModeIndicator();
    _renderPreviewBody();
  });

  btnPreviewOpen.addEventListener('click', () => {
    if (_selectedMsg) {
      browser.runtime.sendMessage({
        type: 'GET_MAIL_URL',
        conversationId: _selectedMsg.ConversationID,
        messageId: _selectedMsg.ID,
        accountId: _selectedMsg._accountId,
      }).then(url => {
        browser.tabs.create({ url });
        window.close();
      });
    }
  });

  // Pop the currently-open email out into its own resizable window. We
  // persist the draft first; the new standalone window restores it (and/or
  // reopens the message via the ?msg= deep link) on load. Defaults to a
  // roomier size so the reply area has space.
  if (btnPreviewPopout) {
    btnPreviewPopout.addEventListener('click', () => {
      if (!requirePremium('popout')) return;
      _saveDraft();
      let url = browser.runtime.getURL('popup/popup.html') + '?standalone=1';
      if (_selectedMsg) {
        url += '&msg=' + encodeURIComponent(_selectedMsg.ID) +
               '&acct=' + encodeURIComponent(_selectedMsg._accountId || '');
      }
      const width = Math.max(_settings.popupWidth || 420, 680);
      const height = Math.max(_settings.popupHeight || 540, 720);
      browser.windows.create({ url, type: 'popup', width: width + 16, height: height + 40 });
      window.close();
    });
  }

  // --- Quick Reply ---

  const replyEditor = document.getElementById('reply-editor');
  const previewReplyEl = document.getElementById('preview-reply');
  const replyResizeHandle = document.getElementById('reply-resize-handle');
  const REPLY_HEIGHT_KEY = 'mcpm-reply-height';
  const REPLY_MIN_HEIGHT = 180; // floor that keeps the send buttons in view
  let _replyEditorOpen = false;
  // The reply editor's contents as _prefillReplyBody left them, so backing out
  // can tell "user typed nothing" from "user typed above the quote".
  let _replyBaseline = '';

  // Reply area is drag-resizable (grab the handle at its top edge). Height is
  // clamped to keep both the message preview and the reply usable, and is
  // persisted across opens. If a small height can't fit the toolbar + send
  // buttons, the editor scrolls internally so nothing becomes unreachable.
  // Reply-height clamp. Not a generic clamp(): it derives its own dynamic max
  // from the panel height and Math.round()s the result for pixel layout. The
  // other Math.min/Math.max clamps in the popup/color-picker use different
  // bounds and rounding (e.g. the hue slider caps at 359, not 360), so this is
  // deliberately a bespoke function rather than a shared utility.
  function _clampReplyHeight(h) {
    const panelH = previewPanel.clientHeight || 540;
    const max = Math.max(REPLY_MIN_HEIGHT, panelH - 120); // keep >=120 for the preview
    return Math.round(Math.min(Math.max(h, REPLY_MIN_HEIGHT), max));
  }
  function _applyReplyHeight(h) {
    previewReplyEl.style.height = _clampReplyHeight(h) + 'px';
  }
  function _openReplyResize() {
    previewReplyEl.classList.add('resizable');
    const stored = parseInt(localStorage.getItem(REPLY_HEIGHT_KEY), 10);
    const apply = () => {
      let h = stored;
      if (!h || isNaN(h)) {
        const panelH = previewPanel.clientHeight || 540;
        h = Math.round(Math.min(panelH * 0.45, panelH - 160));
      }
      _applyReplyHeight(h);
    };
    // If the panel isn't laid out yet (clientHeight 0, e.g. during draft
    // restore), defer a frame so the clamp sees real dimensions.
    if (previewPanel.clientHeight > 0) apply();
    else requestAnimationFrame(apply);
  }
  function _closeReplyResize() {
    previewReplyEl.classList.remove('resizable');
    previewReplyEl.style.height = '';
  }
  if (replyResizeHandle) {
    let _dragMove = null;
    let _dragUp = null;
    const _endReplyDrag = () => {
      if (_dragMove) document.removeEventListener('pointermove', _dragMove);
      if (_dragUp) document.removeEventListener('pointerup', _dragUp);
      _dragMove = _dragUp = null;
    };
    replyResizeHandle.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      _endReplyDrag(); // drop any stale drag before starting a new one
      const startY = e.clientY;
      const startH = previewReplyEl.offsetHeight;
      // Listen on document so the drag tracks even when the pointer leaves the
      // thin handle, and always ends (no stuck listeners).
      _dragMove = (ev) => _applyReplyHeight(startH + (startY - ev.clientY));
      _dragUp = () => {
        _endReplyDrag();
        try { localStorage.setItem(REPLY_HEIGHT_KEY, String(previewReplyEl.offsetHeight)); } catch (e2) {}
      };
      document.addEventListener('pointermove', _dragMove);
      document.addEventListener('pointerup', _dragUp);
    });
  }
  // Re-clamp the reply height if the (standalone) window is resized smaller.
  window.addEventListener('resize', () => {
    if (previewReplyEl.classList.contains('resizable')) {
      _applyReplyHeight(previewReplyEl.offsetHeight);
    }
  });

  function _updateReplyModeUI() {
    btnReplyMode.classList.toggle('active', _replyMode === 'reply' && _replyEditorOpen);
    btnReplyAllMode.classList.toggle('active', _replyMode === 'replyAll' && _replyEditorOpen);
    btnForwardMode.classList.toggle('active', _replyMode === 'forward' && _replyEditorOpen);
    replyEditor.classList.toggle('hidden', !_replyEditorOpen);
    if (_replyEditorOpen) _openReplyResize(); else _closeReplyResize();
    // The To row is shown for every mode now: reply/reply-all pre-fill it with
    // editable recipients, forward starts empty.
    forwardToRow.classList.remove('hidden');
    if (_replyMode === 'forward') {
      btnReplySend.textContent = ProtonI18n.t('forward');
      btnReplySendArchive.textContent = ProtonI18n.t('forwardAndArchive');
    } else {
      btnReplySend.textContent = ProtonI18n.t('send');
      btnReplySendArchive.textContent = ProtonI18n.t('sendAndArchive');
    }
    btnReplySendArchive.classList.toggle('hidden', _settings.hideSendArchive === true);
    _applyFormatSettings();
    if (_replyEditorOpen) _refreshReplyScribe();
  }

  function _handleReplyModeClick(mode) {
    _scheduleDraftSave();
    const wasOpen = _replyEditorOpen;
    const prevMode = _replyMode;
    if (_replyMode === mode && _replyEditorOpen) {
      _replyEditorOpen = false;
    } else {
      _replyMode = mode;
      _replyEditorOpen = true;
    }
    _updateReplyModeUI();
    if (_replyEditorOpen) {
      const isQuote = (m) => m === 'reply' || m === 'replyAll';
      // Recipients refresh on a fresh open or any mode switch.
      if (!wasOpen || prevMode !== _replyMode) _prefillReplyRecipients();
      // The body (quoted original) is (re)built only on a fresh open or when
      // crossing the forward<->reply boundary. Switching reply<->reply-all
      // keeps whatever the user has already typed. (Draft restore uses
      // _updateReplyModeUI directly, so it isn't clobbered here.)
      if (!wasOpen || isQuote(prevMode) !== isQuote(_replyMode)) {
        _prefillReplyBody();
        // Remember what the editor looked like untouched. The quote is
        // pre-filled, so "empty" is not the baseline for deciding whether the
        // user would lose work by backing out. Switching reply<->reply-all
        // keeps the body and deliberately does not reset this.
        _replyBaseline = (_settings.replyFormat === 'html')
          ? replyBody.innerHTML : replyText.value;
      }
      const replyHtml = _settings.replyFormat === 'html';
      setTimeout(() => {
        const el = replyHtml ? replyBody : replyText;
        el.focus();
        // Place the caret at the very top so the user types above the quote.
        if (replyHtml) {
          try {
            const r = document.createRange();
            const s = window.getSelection();
            r.setStart(replyBody, 0);
            r.collapse(true);
            s.removeAllRanges();
            s.addRange(r);
          } catch (_) { /* best effort */ }
        } else {
          try { replyText.setSelectionRange(0, 0); } catch (_) { /* best effort */ }
        }
        // Putting the caret at the top is not enough on its own: focus() scrolls
        // the editor to its previous position, which for a long quoted message
        // is the very bottom, and moving the selection does not scroll back. The
        // reply opened showing Proton's footer, with the space to type in it
        // somewhere above off-screen.
        el.scrollTop = 0;
      }, 50);
    }
  }

  btnReplyMode.addEventListener('click', () => {
    if (!requirePremium('reply')) return;
    _handleReplyModeClick('reply');
  });
  btnReplyAllMode.addEventListener('click', () => {
    if (!requirePremium('reply')) return;
    _handleReplyModeClick('replyAll');
  });
  btnForwardMode.addEventListener('click', () => {
    if (!requirePremium('reply')) return;
    _handleReplyModeClick('forward');
  });

  async function handleSendReply(andArchive) {
    const replyHtml = _settings.replyFormat === 'html';
    // Put back any quote URLs we parked while composing, so the recipient's
    // copy of the conversation is intact even though we declined to fetch them.
    const text = replyHtml
      ? _restoreQuoteUrls(replyBody.innerHTML).trim()
      : replyText.value.trim();
    if (!text || !_selectedMsg) return;

    const msgId = _selectedMsg.ID;
    const accountId = _selectedMsg._accountId;

    // Same as compose: flush any half-typed recipient before reading the chips.
    chipForwardTo.commitPending(); chipReplyCc.commitPending(); chipReplyBcc.commitPending();
    // Every mode now has an editable To field. Require at least one recipient.
    if (chipForwardTo.getChips().length === 0) {
      showToast(ProtonI18n.t('enterRecipient'));
      return;
    }
    if (_blockOnInvalidRecipient(chipForwardTo, chipReplyCc, chipReplyBcc)) return;

    previewReply.classList.add('reply-sending');
    const origBtnText = btnReplySend.textContent;
    btnReplySend.textContent = ProtonI18n.t('sending');

    try {
      const senderAddress = replyFromSelect.value || '';
      let msgPayload;
      // Read reply attachments as base64
      let replyAttachmentData = null;
      if (_replyAttachments.length > 0) {
        replyAttachmentData = [];
        for (const att of _replyAttachments) {
          let data;
          if (att._base64Data) {
            data = att._base64Data;
          } else {
            data = await new Promise((resolve, reject) => {
              const reader = new FileReader();
              reader.onload = () => resolve(reader.result.split(',')[1]);
              reader.onerror = reject;
              reader.readAsDataURL(att.file);
            });
          }
          replyAttachmentData.push({
            name: att.file.name,
            type: att.file.type || 'application/octet-stream',
            data,
          });
        }
      }

      // Images pasted into the editor arrive as data: URIs. Send them as cid:
      // parts instead, which is the only form clients outside Proton render.
      let bodyToSend = text;
      if (replyHtml) {
        const inlined = _inlineDataUrlImages(text, senderAddress);
        if (inlined.attachments.length) {
          bodyToSend = inlined.html;
          replyAttachmentData = (replyAttachmentData || []).concat(inlined.attachments);
        }
      }

      const replyCcChips = chipReplyCc.getChips();
      const replyBccChips = chipReplyBcc.getChips();
      if (_replyMode === 'forward') {
        msgPayload = {
          type: 'FORWARD_MESSAGE',
          messageId: msgId,
          accountId,
          to: chipForwardTo.getChips(),
          cc: replyCcChips,
          bcc: replyBccChips,
          senderAddress,
          ...(replyHtml ? { htmlBody: bodyToSend } : { body: bodyToSend }),
          attachments: replyAttachmentData,
          sendOptions: replySendOpts ? replySendOpts.getValues() : null,
        };
      } else {
        msgPayload = {
          type: 'SEND_REPLY',
          messageId: msgId,
          accountId,
          replyAll: _replyMode === 'replyAll',
          to: chipForwardTo.getChips(),
          cc: replyCcChips,
          bcc: replyBccChips,
          senderAddress,
          ...(replyHtml ? { htmlBody: bodyToSend } : { body: bodyToSend }),
          attachments: replyAttachmentData,
          sendOptions: replySendOpts ? replySendOpts.getValues() : null,
        };
      }
      const result = await browser.runtime.sendMessage(msgPayload);

      if (result.error) {
        showToast(_sendErrorMessage(result.error));
        return;
      }

      // Show the arrow at once on the message being read. The background sets
      // the same flag on its own copy, but the popup holds its own objects and
      // deliberately does not re-read state here: _reconcile ends in render(),
      // which would switch back to the inbox and throw the user out of the
      // message they just answered. A scheduled send is not flagged, matching
      // the background: the reply has not gone yet.
      // _selectedMsg is the very object the list row was built from, so the row
      // behind the preview picks this up too.
      if (_selectedMsg && _selectedMsg.ID === msgId &&
          !(msgPayload.sendOptions && msgPayload.sendOptions.deliveryTime)) {
        if (_replyMode === 'forward') _selectedMsg.IsForwarded = 1;
        else if (_replyMode === 'replyAll') _selectedMsg.IsRepliedAll = 1;
        else _selectedMsg.IsReplied = 1;
        _renderReplyState(previewReplyState, _selectedMsg);
        _refreshListReplyState(msgId, _selectedMsg);
      }

      if (replyHtml) {
        replyBody.textContent = '';
      } else {
        replyText.value = '';
      }
      showToast(msgPayload.sendOptions && msgPayload.sendOptions.deliveryTime
        ? ProtonI18n.t('messageScheduled')
        : (_replyMode === 'forward' ? ProtonI18n.t('messageForwarded') : ProtonI18n.t('replySent')));
      if (replySendOpts) replySendOpts.reset();
      if (replyDriveShare) replyDriveShare.reset();
      _replyAttachments = [];
      _renderReplyAttachments();
      _clearDraft();
      // The editor was just emptied, so that is the new baseline. Left stale,
      // the next close compares an empty body against the old quote, concludes
      // there is unsent work, and offers to discard a reply already sent.
      _replyBaseline = replyHtml ? replyBody.innerHTML : replyText.value;

      // Auto-mark-as-read on reply
      if (_replyMode !== 'forward' && _settings.autoMarkReadOnReply && _selectedMsg && _selectedMsg.Unread === 1) {
        doAction('MARK_READ', [msgId], accountId);
      }

      if (andArchive) {
        await doAction('ARCHIVE', [msgId], accountId);
        await closePreview({ force: true });
      }
    } catch (err) {
      showToast(ProtonI18n.t('sendFailed'));
    } finally {
      previewReply.classList.remove('reply-sending');
      btnReplySend.textContent = origBtnText;
    }
  }

  btnReplySend.addEventListener('click', () => handleSendReply(false));
  btnReplySendArchive.addEventListener('click', () => handleSendReply(true));

  // --- Compose panel ---

  const composePanel = document.getElementById('compose-panel');
  const composeTo = document.getElementById('compose-to');
  const composeCc = document.getElementById('compose-cc');
  const composeBcc = document.getElementById('compose-bcc');
  const composeSubject = document.getElementById('compose-subject');
  const composeBody = document.getElementById('compose-body');
  const composeFrom = document.getElementById('compose-from');
  const btnCloseCompose = document.getElementById('btn-close-compose');
  const btnComposeSend = document.getElementById('btn-compose-send');
  const btnToggleCc = document.getElementById('btn-toggle-cc');
  const composeCcBccRows = document.getElementById('compose-cc-bcc-rows');

  // Undo history that outlives the popup.
  //
  // The popup is destroyed on focus loss and returns as a NEW document, so the
  // browser's own undo stack is empty every time it reopens: before this,
  // Ctrl+Z after reopening did nothing at all, for typing as much as for an
  // image resize. Native undo cannot survive that, so states are saved with
  // the draft and used only once the browser says it has nothing left.
  // See lib/editor-history.js.
  const _editorHistories = new Map();
  function _historyFor(el) {
    if (!el || typeof ProtonEditorHistory === 'undefined') return null;
    if (!_editorHistories.has(el)) {
      _editorHistories.set(el, ProtonEditorHistory.create({
        getHtml: () => el.innerHTML,
        setHtml: (html) => {
          _setHTML(el, html);
          // The draft autosave and the dirty-check both listen for input, and
          // a scripted write does not fire one.
          el.dispatchEvent(new Event('input', { bubbles: true }));
        },
        // Ask the browser first and report whether it actually changed
        // anything. execCommand can return true having done nothing, so the
        // markup is what decides.
        exec: (cmd) => {
          const before = el.innerHTML;
          try { document.execCommand(cmd); } catch (e) { return false; }
          return el.innerHTML !== before;
        },
      }));
    }
    return _editorHistories.get(el);
  }

  [replyBody, composeBody].forEach((el) => {
    if (!el) return;
    const hist = _historyFor(el);
    if (!hist) return;

    // Record a state after a short typing pause. NOT on the draft-save
    // debounce, which was the first attempt: a draft is saved once you stop
    // typing, so several lines written without a pause became a single undo
    // step and one Ctrl+Z discarded all of them.
    let idle = null;
    el.addEventListener('input', () => {
      clearTimeout(idle);
      idle = setTimeout(() => hist.record(), ProtonEditorHistory.IDLE_MS);
    });

    // The shortcut is deliberately NOT intercepted. Letting the browser run
    // its own undo, and only stepping through saved states when it turns out
    // to have done nothing, keeps native behaviour exactly as it was: the
    // word-at-a-time granularity, the caret placement, IME composition. The
    // earlier version called execCommand('undo') itself, and because that
    // quietly does nothing once the DOM has been touched by script, the coarse
    // fallback ran INSTEAD of native undo and swallowed whole paragraphs.
    el.addEventListener('keydown', (e) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      const k = (e.key || '').toLowerCase();
      const isUndo = k === 'z' && !e.shiftKey;
      const isRedo = (k === 'z' && e.shiftKey) || k === 'y';
      if (!isUndo && !isRedo) return;
      // A pending state would otherwise be recorded mid-undo and become a new
      // branch, discarding everything ahead of the cursor.
      clearTimeout(idle);
      const before = el.innerHTML;
      // Next turn of the event loop: the browser's own undo has run by then,
      // since it is the synchronous default action for this key.
      setTimeout(() => {
        // Chrome's own grouping splits "create the text node" from "append to
        // it", so one Ctrl+Z can leave the first character of a line behind.
        // That is native behaviour, measured and deliberately kept: matching
        // Proton's composer would mean replacing native undo outright and
        // taking over caret placement, which is a worse trade.
        if (el.innerHTML !== before) return; // native handled it
        if (isUndo) hist.stepBack(); else hist.stepForward();
      }, 0);
    });
  });

  // Drag-to-resize for inline images, in both editors. Corner grips keep the
  // aspect ratio, edge grips stretch one axis. The overlay lives on
  // document.body, never inside the editable subtree, because both editors are
  // serialised straight out of innerHTML for sending AND for the encrypted
  // draft: a handle parked in there would be mailed to the recipient.
  // See lib/image-resize.js.
  if (typeof ProtonImageResize !== 'undefined') {
    const label = ProtonI18n.t('resizeImage');
    [replyBody, composeBody].forEach((el) => {
      if (el) ProtonImageResize.attach(el, { label });
    });
  }

  let _composeAccountId = null;

  // --- Chip-based recipient inputs with autocomplete ---

  /**
   * Is this address plausibly deliverable?
   *
   * Deliberately permissive: the job is to catch a typo like "gmailcom" before
   * the send fails, NOT to enforce RFC 5321. Without this, a missing dot took
   * the message all the way to Proton's key lookup, which errors, which we
   * correctly refuse to guess about, and the user was told to check their
   * network connection. Anything passing here may still be rejected by Proton;
   * anything failing here cannot be delivered by anyone.
   */
  function _looksLikeEmail(address) {
    const s = String(address || '').trim();
    if (!s || /\s/.test(s)) return false;
    const at = s.lastIndexOf('@');
    if (at <= 0 || at === s.length - 1) return false;
    if (s.slice(0, at).includes('@')) return false;
    const domain = s.slice(at + 1);
    if (domain.includes('..')) return false;
    // Two labels minimum with an alphabetic final one, so "gmailcom" fails and
    // "gmail.com" passes. xn-- is spelled out so punycode domains still work.
    return /^[^\s@.-][^\s@]*\.(?:[a-z]{2,}|xn--[a-z0-9-]+)$/i.test(domain);
  }

  function _initChipInput(inputEl) {
    const container = inputEl.closest('.chip-container');
    const chips = []; // [{address, name}]
    let _acDropdown = null;
    let _acIndex = -1;
    let _acDebounce = null;

    function addChip(address, name) {
      const normalized = address.trim().toLowerCase();
      if (!normalized) return;
      if (chips.some(c => c.address.toLowerCase() === normalized)) return;
      const entry = { address: normalized, name: name || '' };
      chips.push(entry);

      const chip = document.createElement('span');
      chip.className = 'recipient-chip';
      chip.textContent = name ? name : normalized;
      chip.title = name ? `${name} <${normalized}>` : normalized;
      // Mark rather than refuse: a pasted address the check disagrees with is
      // still worth keeping on screen where it can be corrected. The send is
      // what actually blocks.
      if (!_looksLikeEmail(normalized)) {
        entry.invalid = true;
        chip.classList.add('invalid');
        chip.title = ProtonI18n.t('invalidRecipient', normalized);
      }
      const removeBtn = document.createElement('button');
      removeBtn.className = 'chip-remove';
      removeBtn.textContent = '\u00d7';
      removeBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        const idx = chips.indexOf(entry);
        if (idx >= 0) chips.splice(idx, 1);
        chip.remove();
        _scheduleDraftSave();
      });
      chip.appendChild(removeBtn);
      container.insertBefore(chip, inputEl);
      inputEl.value = '';
      _hideAutocomplete();
      _scheduleDraftSave();
    }

    function getChips() { return chips.slice(); }

    /** The first address that cannot be delivered, or '' if they all can. */
    function firstInvalid() {
      const bad = chips.find(c => c.invalid);
      return bad ? bad.address : '';
    }

    function clearChips() {
      chips.length = 0;
      container.querySelectorAll('.recipient-chip').forEach(c => c.remove());
      inputEl.value = '';
    }

    function _commitInput() {
      const val = inputEl.value.trim();
      if (!val) return;
      // Support "Name <email>" format
      const match = val.match(/^(.+?)\s*<(.+?)>$/);
      if (match) {
        addChip(match[2].trim(), match[1].trim());
      } else {
        addChip(val, '');
      }
    }

    // Autocomplete dropdown
    function _showAutocomplete(results) {
      _hideAutocomplete();
      if (results.length === 0) return;
      _acDropdown = document.createElement('div');
      _acDropdown.className = 'ac-dropdown';
      _acIndex = -1;

      for (let i = 0; i < results.length; i++) {
        const r = results[i];
        const item = document.createElement('div');
        item.className = 'ac-item';
        const nameSpan = document.createElement('span');
        nameSpan.className = 'ac-name';
        nameSpan.textContent = r.name || r.email;
        item.appendChild(nameSpan);
        if (r.name) {
          const emailSpan = document.createElement('span');
          emailSpan.className = 'ac-email';
          emailSpan.textContent = r.email;
          item.appendChild(emailSpan);
        }
        item.addEventListener('mousedown', (e) => {
          e.preventDefault();
          addChip(r.email, r.name);
          inputEl.focus();
        });
        _acDropdown.appendChild(item);
      }

      container.style.position = 'relative';
      container.appendChild(_acDropdown);
    }

    function _hideAutocomplete() {
      if (_acDropdown) { _acDropdown.remove(); _acDropdown = null; }
      _acIndex = -1;
    }

    function _updateAcSelection() {
      if (!_acDropdown) return;
      const items = _acDropdown.querySelectorAll('.ac-item');
      items.forEach((el, i) => el.classList.toggle('ac-active', i === _acIndex));
    }

    async function _fetchSuggestions(query) {
      const accountId = composeFrom.value || (_selectedMsg && _selectedMsg._accountId) || _composeAccountId;
      if (!accountId || query.length < 2) { _hideAutocomplete(); return; }
      try {
        const res = await browser.runtime.sendMessage({
          type: 'SEARCH_CONTACTS', accountId, query,
        });
        if (inputEl.value.trim().toLowerCase().startsWith(query.toLowerCase())) {
          _showAutocomplete(res.contacts || []);
        }
      } catch (e) {
        _hideAutocomplete();
      }
    }

    inputEl.addEventListener('input', () => {
      clearTimeout(_acDebounce);
      const q = inputEl.value.trim();
      if (q.length < 2) { _hideAutocomplete(); return; }
      _acDebounce = setTimeout(() => _fetchSuggestions(q), 200);
    });

    inputEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === 'Tab' || e.key === ',') {
        if (_acDropdown && _acIndex >= 0) {
          e.preventDefault();
          const items = _acDropdown.querySelectorAll('.ac-item');
          if (items[_acIndex]) items[_acIndex].dispatchEvent(new MouseEvent('mousedown'));
        } else if (inputEl.value.trim()) {
          e.preventDefault();
          _commitInput();
        }
      } else if (e.key === 'Backspace' && !inputEl.value && chips.length > 0) {
        chips.pop();
        const lastChip = container.querySelector('.recipient-chip:last-of-type');
        if (lastChip) lastChip.remove();
      } else if (e.key === 'ArrowDown' && _acDropdown) {
        e.preventDefault();
        const items = _acDropdown.querySelectorAll('.ac-item');
        _acIndex = Math.min(_acIndex + 1, items.length - 1);
        _updateAcSelection();
      } else if (e.key === 'ArrowUp' && _acDropdown) {
        e.preventDefault();
        _acIndex = Math.max(_acIndex - 1, 0);
        _updateAcSelection();
      } else if (e.key === 'Escape') {
        _hideAutocomplete();
      }
    });

    inputEl.addEventListener('blur', () => {
      setTimeout(() => {
        _commitInput();
        _hideAutocomplete();
      }, 150);
    });

    container.addEventListener('click', () => inputEl.focus());

    return {
      addChip, getChips, clearChips, firstInvalid,
      commitPending: _commitInput,
      // The half-typed address, still in the box and not yet a chip.
      getPending: () => inputEl.value,
      setPending: (v) => { inputEl.value = v || ''; },
    };
  }

  /** Toast and return true when any recipient field holds an undeliverable
   *  address, so the caller can abort before building a draft. */
  function _blockOnInvalidRecipient(...inputs) {
    for (const chipInput of inputs) {
      const bad = chipInput && chipInput.firstInvalid();
      if (bad) {
        showToast(ProtonI18n.t('invalidRecipient', bad));
        return true;
      }
    }
    return false;
  }

  const chipTo = _initChipInput(composeTo);
  const chipCc = _initChipInput(composeCc);
  const chipBcc = _initChipInput(composeBcc);
  const chipForwardTo = _initChipInput(forwardToInput);
  const chipReplyCc = _initChipInput(replyCcInput);
  const chipReplyBcc = _initChipInput(replyBccInput);

  // CC/BCC reveal toggle for the reply/forward editor.
  if (btnReplyToggleCc) {
    btnReplyToggleCc.addEventListener('click', () => {
      replyCcBccRows.classList.toggle('hidden');
      if (!replyCcBccRows.classList.contains('hidden')) replyCcInput.focus();
      _scheduleDraftSave();
    });
  }

  // Auto-save draft on input in compose/reply fields
  [composeSubject, composeBody, composeTo, composeCc, composeBcc,
   replyText, replyBody, forwardToInput, replyCcInput, replyBccInput].forEach(el => {
    el.addEventListener('input', _scheduleDraftSave);
  });

  function openCompose(accountId) {
    _composeAccountId = accountId;
    chipTo.clearChips();
    chipCc.clearChips();
    chipBcc.clearChips();
    composeSubject.value = '';
    composeBody.textContent = '';
    composeCcBccRows.classList.add('hidden');

    // Populate "From" with accounts
    composeFrom.textContent = '';
    browser.runtime.sendMessage({ type: 'GET_ACCOUNTS' }).then(accounts => {
      for (const acc of accounts) {
        const opt = document.createElement('option');
        opt.value = acc.id;
        opt.textContent = acc.label || acc.email;
        if (acc.id === accountId) opt.selected = true;
        composeFrom.appendChild(opt);
      }
      _refreshComposeScribe();
    });

    composePanel.classList.remove('hidden');
    composeTo.focus();
    _refreshComposeScribe();
  }

  function closeCompose() {
    // Dismiss any colour/emoji picker portaled to <body>, else it orphans.
    if (typeof PopupEditorToolbar !== 'undefined') PopupEditorToolbar.closeAllPopups();
    composePanel.classList.add('hidden');
    _composeAccountId = null;
    _composeAttachments = [];
    const attContainer = document.getElementById('compose-attachments');
    if (attContainer) { attContainer.textContent = ''; attContainer.classList.add('hidden'); }
    if (composeSendOpts) composeSendOpts.reset();
    if (composeDriveShare) composeDriveShare.reset();
    _clearDraft();
  }

  btnCloseCompose.addEventListener('click', async () => {
    const hasContent = chipTo.getChips().length > 0 || composeSubject.value || composeBody.innerHTML.trim();
    if (hasContent) {
      const discard = await ProtonDialog.confirm(ProtonI18n.t('discardDraftConfirm'), {
        confirmLabel: ProtonI18n.t('discard'),
        danger: true,
      });
      if (discard) closeCompose();
    } else {
      closeCompose();
    }
  });

  btnToggleCc.addEventListener('click', () => {
    composeCcBccRows.classList.toggle('hidden');
  });

  // WYSIWYG toolbar: delegated to PopupEditorToolbar
  const _composeEditorToolbar = document.getElementById('compose-editor-toolbar');
  PopupEditorToolbar.init(_composeEditorToolbar, composeBody, _createColorPicker);
  PopupEditorToolbar.init(replyEditorToolbar, replyBody, _createColorPicker);

  // Premium send options (schedule send + expiring/Encrypted-Outside messages),
  // mounted once per send surface. The Send handlers read getValues() and the
  // close/teardown paths call reset() so options never leak between drafts.
  if (typeof PopupSendOptions !== 'undefined') {
    composeSendOpts = PopupSendOptions.mount({
      sendBtn: btnComposeSend, toolbar: _composeEditorToolbar, summaryHost: _composeEditorToolbar,
      insertAfter: document.getElementById('btn-compose-attach'),
      requirePremium, showToast, use24Hour: !!(_settings && _settings.use24HourTime),
    });
    replySendOpts = PopupSendOptions.mount({
      sendBtn: btnReplySend, toolbar: replyEditorToolbar, summaryHost: replyEditorToolbar,
      insertAfter: document.getElementById('btn-reply-attach'),
      requirePremium, showToast, use24Hour: !!(_settings && _settings.use24HourTime),
    });
  }

  // Premium "Share via Proton Drive": uploads picked files to the user's
  // Drive and inserts a public share link per file instead of attaching.
  // The upload itself runs in the background, fed by the picker tab; the
  // links land in the draft via _pickUpPendingDriveLinks() on popup reopen.
  if (typeof PopupDriveShare !== 'undefined') {
    composeDriveShare = PopupDriveShare.mount({
      toolbar: _composeEditorToolbar, requirePremium, showToast,
      insertAfter: document.getElementById('btn-compose-attach'),
      getSettings: () => _settings,
      onChooseFiles: (options) => _startDriveShare('compose', options),
    });
    replyDriveShare = PopupDriveShare.mount({
      toolbar: replyEditorToolbar, requirePremium, showToast,
      insertAfter: document.getElementById('btn-reply-attach'),
      getSettings: () => _settings,
      onChooseFiles: (options) => _startDriveShare('reply', options),
    });
  }

  // Create the background upload job (fails fast: Drive bootstrap + target
  // folder happen before the tab opens), then hand off to the file picker
  // tab in drive mode, mirroring _openFilePicker's save-draft-then-tab flow.
  async function _startDriveShare(surface, options) {
    const accountId = surface === 'reply'
      ? (_selectedMsg && _selectedMsg._accountId)
      : (composeFrom.value || _composeAccountId);
    if (!accountId) { showToast(ProtonI18n.t('driveStartFailed')); return; }
    showToast(ProtonI18n.t('drivePreparing'));
    let res = null;
    try {
      res = await browser.runtime.sendMessage({ type: 'DRIVE_START_UPLOAD', accountId, options });
    } catch (_) { /* handled below */ }
    if (!res || res.error || !res.uploadId) {
      const error = res && res.error;
      let msg;
      if (error === 'PREMIUM_REQUIRED') msg = ProtonI18n.t('premiumRequired');
      else if (error === 'DRIVE_PASSWORD_TOO_LONG') msg = ProtonI18n.t('drivePasswordTooLong');
      else msg = ProtonI18n.t('driveStartFailed') + (error ? ` (${error})` : '');
      showToast(msg);
      return;
    }
    _saveDraft();
    browser.tabs.create({
      url: browser.runtime.getURL(
        'popup/filepicker.html?mode=drive&uploadId=' + encodeURIComponent(res.uploadId)),
    });
    window.close();
  }

  // ── AI writing assistant (Scribe) ──
  function _plainToHtml(text) {
    const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    return (text || '').split(/\n{2,}/).map((p) => '<p>' + esc(p).replace(/\n/g, '<br>') + '</p>').join('');
  }
  function _senderNameFromSelect(sel) {
    const opt = sel && sel.options[sel.selectedIndex];
    const txt = (opt && opt.textContent) || '';
    const m = txt.match(/^(.*?)\s*<[^>]+>$/);
    return (m ? m[1] : txt).trim();
  }
  function _insertIntoTextarea(el, text) {
    const start = el.selectionStart ?? el.value.length;
    const end = el.selectionEnd ?? el.value.length;
    el.value = el.value.slice(0, start) + text + el.value.slice(end);
    const pos = start + text.length;
    el.selectionStart = el.selectionEnd = pos;
    el.focus();
  }
  if (typeof PopupScribe !== 'undefined') {
    PopupScribe.init({
      sendMessage: (msg) => browser.runtime.sendMessage(msg),
      showToast,
      t: (...a) => ProtonI18n.t(...a),
      isPremium,
      setHTML: _setHTML,
    });
  }
  function _scribeReplyCtx() {
    const isHtml = _settings.replyFormat === 'html';
    const editor = isHtml ? replyBody : replyText;
    return {
      accountId: _selectedMsg && _selectedMsg._accountId,
      isHtml,
      recipient: (_selectedMsg && _selectedMsg.Sender && (_selectedMsg.Sender.Name || _selectedMsg.Sender.Address)) || '',
      sender: _senderNameFromSelect(replyFromSelect),
      locale: _settings.language || 'en',
      getText: () => (isHtml ? (editor.innerText || editor.textContent || '') : editor.value),
      replace: (text) => { if (isHtml) _setHTML(replyBody, _plainToHtml(text)); else replyText.value = text; },
      insert: (text) => {
        if (isHtml) { replyBody.focus(); document.execCommand('insertHTML', false, _plainToHtml(text)); }
        else _insertIntoTextarea(replyText, text);
      },
      snapshot: () => (isHtml ? { html: replyBody.innerHTML } : { val: replyText.value }),
      restore: (s) => { if (isHtml) _setHTML(replyBody, s.html); else replyText.value = s.val; },
    };
  }
  function _scribeComposeCtx() {
    const isHtml = (_settings.composeFormat || 'html') === 'html';
    const toChip = chipTo.getChips()[0];
    return {
      accountId: composeFrom.value || _composeAccountId,
      isHtml,
      recipient: toChip ? (toChip.name || toChip.address) : '',
      sender: _senderNameFromSelect(composeFrom),
      locale: _settings.language || 'en',
      getText: () => (composeBody.innerText || composeBody.textContent || ''),
      replace: (text) => { if (isHtml) _setHTML(composeBody, _plainToHtml(text)); else composeBody.textContent = text; },
      insert: (text) => { composeBody.focus(); document.execCommand(isHtml ? 'insertHTML' : 'insertText', false, isHtml ? _plainToHtml(text) : text); },
      snapshot: () => ({ html: composeBody.innerHTML }),
      restore: (s) => _setHTML(composeBody, s.html),
    };
  }
  function _refreshReplyScribe() {
    if (typeof PopupScribe === 'undefined') return;
    const btn = document.getElementById('btn-reply-scribe');
    if (_settings.aiAssistantEnabled === false) { if (btn) btn.classList.add('hidden'); return; }
    PopupScribe.update(btn, _scribeReplyCtx());
  }
  function _refreshComposeScribe() {
    if (typeof PopupScribe === 'undefined') return;
    const btn = document.getElementById('btn-compose-scribe');
    if (_settings.aiAssistantEnabled === false) { if (btn) btn.classList.add('hidden'); return; }
    PopupScribe.update(btn, _scribeComposeCtx());
  }
  replyFromSelect.addEventListener('change', _refreshReplyScribe);
  composeFrom.addEventListener('change', _refreshComposeScribe);

  // Spellcheck language switcher: per-session override (doesn't change saved default)
  for (const sel of document.querySelectorAll('.spellcheck-lang-select')) {
    sel.addEventListener('change', () => {
      _applySpellcheckLang(sel.value);
    });
  }

  // Clipboard image paste
  composeBody.addEventListener('paste', (e) => {
    const items = e.clipboardData && e.clipboardData.items;
    if (!items) return;
    for (const item of items) {
      if (item.type.startsWith('image/')) {
        e.preventDefault();
        const blob = item.getAsFile();
        const reader = new FileReader();
        reader.onload = (ev) => {
          const img = document.createElement('img');
          img.src = ev.target.result;
          img.style.maxWidth = '100%';
          img.style.borderRadius = '4px';
          img.style.margin = '4px 0';
          const sel = window.getSelection();
          if (sel.rangeCount) {
            const range = sel.getRangeAt(0);
            range.deleteContents();
            range.insertNode(img);
            range.collapse(false);
          }
        };
        reader.readAsDataURL(blob);
        break;
      }
    }
  });

  // Attachments lists (compose and reply are separate)
  let _composeAttachments = [];
  let _replyAttachments = [];

  function _renderComposeAttachments() { PopupEditorToolbar.renderComposeAttachments('compose-attachments', _composeAttachments); }
  function _renderReplyAttachments() { PopupEditorToolbar.renderComposeAttachments('reply-attachments', _replyAttachments); }

  // Paperclip button: opens a file picker in a separate tab.
  // Native file dialogs steal focus and close the popup, so we save
  // the compose draft first, open filepicker.html in a tab, and when
  // the popup reopens it picks up any attachments from storage.
  function _openFilePicker() {
    _saveDraft();
    browser.tabs.create({ url: browser.runtime.getURL('popup/filepicker.html') });
    window.close();
  }
  document.getElementById('btn-compose-attach').addEventListener('click', _openFilePicker);
  document.getElementById('btn-reply-attach').addEventListener('click', _openFilePicker);

  btnComposeSend.addEventListener('click', async () => {
    const accountId = composeFrom.value || _composeAccountId;
    // An address typed but not yet turned into a chip is still a recipient the
    // user believes they addressed. A chip is only committed on Enter/Tab/comma
    // or 150 ms after blur, and this click handler runs long before that timer,
    // so the text was dropped from the payload, skipped by the validity check,
    // and the user was told "Message sent".
    chipTo.commitPending(); chipCc.commitPending(); chipBcc.commitPending();
    const toList = chipTo.getChips();
    if (toList.length === 0) { showToast(ProtonI18n.t('pleaseEnterRecipient')); return; }
    if (_blockOnInvalidRecipient(chipTo, chipCc, chipBcc)) return;

    btnComposeSend.textContent = ProtonI18n.t('sending');
    btnComposeSend.disabled = true;

    try {
      const composeHtml = (_settings.composeFormat || 'html') === 'html';
      const params = {
        to: toList,
        cc: chipCc.getChips(),
        bcc: chipBcc.getChips(),
        subject: composeSubject.value,
      };
      if (composeHtml) {
        params.htmlBody = composeBody.innerHTML;
      } else {
        params.body = composeBody.innerText;
      }

      // Read file attachments as base64
      if (_composeAttachments.length > 0) {
        params.attachments = [];
        for (const att of _composeAttachments) {
          let data;
          if (att._base64Data) {
            // Already read by filepicker tab
            data = att._base64Data;
          } else {
            // Read from File object
            data = await new Promise((resolve, reject) => {
              const reader = new FileReader();
              reader.onload = () => resolve(reader.result.split(',')[1]);
              reader.onerror = reject;
              reader.readAsDataURL(att.file);
            });
          }
          params.attachments.push({
            name: att.file.name,
            type: att.file.type || 'application/octet-stream',
            data,
          });
        }
      }

      // As in the reply editor: pasted images become cid: parts, since a data:
      // URI is dropped by Gmail and Outlook.
      if (composeHtml) {
        const fromOpt = composeFrom.selectedOptions && composeFrom.selectedOptions[0];
        const inlined = _inlineDataUrlImages(params.htmlBody, (fromOpt && fromOpt.textContent) || '');
        if (inlined.attachments.length) {
          params.htmlBody = inlined.html;
          params.attachments = (params.attachments || []).concat(inlined.attachments);
        }
      }

      if (composeSendOpts) params.sendOptions = composeSendOpts.getValues();

      const result = await browser.runtime.sendMessage({
        type: 'SEND_NEW_MESSAGE',
        accountId,
        params,
      });

      if (result.error) {
        showToast(_sendErrorMessage(result.error));
      } else {
        showToast(params.sendOptions && params.sendOptions.deliveryTime
          ? ProtonI18n.t('messageScheduled') : ProtonI18n.t('messageSent'));
        closeCompose();
      }
    } catch (err) {
      showToast(ProtonI18n.t('sendFailed'));
    } finally {
      btnComposeSend.textContent = ProtonI18n.t('send');
      btnComposeSend.disabled = false;
    }
  });

  // --- SVG Icons ---

  const ICONS = {
    openWeb: '<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path fill-rule="evenodd" d="M8.636 3.5a.5.5 0 0 0-.5-.5H1.5A1.5 1.5 0 0 0 0 4.5v10A1.5 1.5 0 0 0 1.5 16h10a1.5 1.5 0 0 0 1.5-1.5V7.864a.5.5 0 0 0-1 0V14.5a.5.5 0 0 1-.5.5h-10a.5.5 0 0 1-.5-.5v-10a.5.5 0 0 1 .5-.5h6.636a.5.5 0 0 0 .5-.5z"/><path fill-rule="evenodd" d="M16 .5a.5.5 0 0 0-.5-.5h-5a.5.5 0 0 0 0 1h3.793L6.146 9.146a.5.5 0 1 0 .708.708L15 1.707V5.5a.5.5 0 0 0 1 0v-5z"/></svg>',
    exportEml: '<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M.5 9.9a.5.5 0 0 1 .5.5v2.5a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-2.5a.5.5 0 0 1 1 0v2.5a2 2 0 0 1-2 2H2a2 2 0 0 1-2-2v-2.5a.5.5 0 0 1 .5-.5z"/><path d="M7.646 11.854a.5.5 0 0 0 .708 0l3-3a.5.5 0 0 0-.708-.708L8.5 10.293V1.5a.5.5 0 0 0-1 0v8.793L5.354 8.146a.5.5 0 1 0-.708.708l3 3z"/></svg>',
    markRead: '<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M8.47 1.318a1 1 0 0 0-.94 0l-6 3.2A1 1 0 0 0 1 5.4V14a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V5.4a1 1 0 0 0-.53-.882l-6-3.2ZM13.5 5.093 8 2.118 2.5 5.093v1.208l5.203 3.12a.5.5 0 0 0 .594 0L13.5 6.3V5.093ZM2.5 7.697V13.5h11V7.697L8.797 10.95a1.5 1.5 0 0 1-1.594 0L2.5 7.697Z"/></svg>',
    archive: '<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M0 2a1 1 0 0 1 1-1h14a1 1 0 0 1 1 1v2a1 1 0 0 1-1 1v7.5a2.5 2.5 0 0 1-2.5 2.5h-9A2.5 2.5 0 0 1 1 12.5V5a1 1 0 0 1-1-1V2zm2 3v7.5A1.5 1.5 0 0 0 3.5 14h9a1.5 1.5 0 0 0 1.5-1.5V5H2zm13-3H1v2h14V2zM5 7.5a.5.5 0 0 1 .5-.5h5a.5.5 0 0 1 0 1h-5a.5.5 0 0 1-.5-.5z"/></svg>',
    trash: '<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M5.5 5.5A.5.5 0 0 1 6 6v6a.5.5 0 0 1-1 0V6a.5.5 0 0 1 .5-.5zm2.5 0a.5.5 0 0 1 .5.5v6a.5.5 0 0 1-1 0V6a.5.5 0 0 1 .5-.5zm3 .5a.5.5 0 0 0-1 0v6a.5.5 0 0 0 1 0V6z"/><path fill-rule="evenodd" d="M14.5 3a1 1 0 0 1-1 1H13v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V4h-.5a1 1 0 0 1-1-1V2a1 1 0 0 1 1-1H6a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1h3.5a1 1 0 0 1 1 1v1zM4.118 4L4 4.059V13a1 1 0 0 0 1 1h6a1 1 0 0 0 1-1V4.059L11.882 4H4.118zM2.5 3V2h11v1h-11z"/></svg>',
    snooze: '<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M8 3.5a.5.5 0 0 0-1 0V8a.5.5 0 0 0 .252.434l3.5 2a.5.5 0 0 0 .496-.868L8 7.71V3.5z"/><path d="M8 16A8 8 0 1 0 8 0a8 8 0 0 0 0 16zm7-8A7 7 0 1 1 1 8a7 7 0 0 1 14 0z"/></svg>',
    star: '<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M2.866 14.85c-.078.444.36.791.746.593l4.39-2.256 4.389 2.256c.386.198.824-.149.746-.592l-.83-4.73 3.522-3.356c.33-.314.16-.888-.282-.95l-4.898-.696L8.465.792a.513.513 0 0 0-.927 0L5.354 5.12l-4.898.696c-.441.062-.612.636-.283.95l3.523 3.356-.83 4.73zm4.905-2.767l-3.686 1.894.694-3.957a.565.565 0 0 0-.163-.505L1.71 6.745l4.052-.576a.525.525 0 0 0 .393-.288L8 2.223l1.847 3.658a.525.525 0 0 0 .393.288l4.052.575-2.906 2.77a.565.565 0 0 0-.163.506l.694 3.957-3.686-1.894a.503.503 0 0 0-.461 0z"/></svg>',
    starFilled: '<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M3.612 15.443c-.386.198-.824-.149-.746-.592l.83-4.73L.173 6.765c-.329-.314-.158-.888.283-.95l4.898-.696L7.538.792c.197-.39.73-.39.927 0l2.184 4.327 4.898.696c.441.062.612.636.282.95l-3.522 3.356.83 4.73c.078.443-.36.79-.746.592L8 13.187l-4.389 2.256z"/></svg>',
    label: '<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M2 2a1 1 0 0 1 1-1h4.586a1 1 0 0 1 .707.293l7 7a1 1 0 0 1 0 1.414l-4.586 4.586a1 1 0 0 1-1.414 0l-7-7A1 1 0 0 1 2 6.586V2zm3.5 4a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3z"/></svg>',
    popout: '<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M5.5 0a.5.5 0 0 1 0 1H1.707l6.147 6.146a.5.5 0 0 1-.708.708L1 1.707V5.5a.5.5 0 0 1-1 0v-5A.5.5 0 0 1 .5 0h5zM6 10a2 2 0 0 1 2-2h6a2 2 0 0 1 2 2v4a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2v-4zm2-1a1 1 0 0 0-1 1v4a1 1 0 0 0 1 1h6a1 1 0 0 0 1-1v-4a1 1 0 0 0-1-1H8z"/></svg>',
    folder: '<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M.54 3.87L.5 3a2 2 0 0 1 2-2h3.672a2 2 0 0 1 1.414.586l.828.828A2 2 0 0 0 9.828 3H13.5a2 2 0 0 1 2 2v.054c-.175-.073-.356-.133-.54-.18A3 3 0 0 0 14 5H2a3 3 0 0 0-.96.074c-.184.047-.365.107-.54.18z"/><path d="M2 6a2 2 0 0 0-2 2v5a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2H2z"/></svg>',
    spam: '<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M11.46.146A.5.5 0 0 0 11.107 0H4.893a.5.5 0 0 0-.353.146L.146 4.54A.5.5 0 0 0 0 4.893v6.214a.5.5 0 0 0 .146.353l4.394 4.394a.5.5 0 0 0 .353.146h6.214a.5.5 0 0 0 .353-.146l4.394-4.394a.5.5 0 0 0 .146-.353V4.893a.5.5 0 0 0-.146-.353L11.46.146zM8 4c.535 0 .954.462.9.995l-.35 3.507a.552.552 0 0 1-1.1 0L7.1 4.995A.905.905 0 0 1 8 4zm.002 6a1 1 0 1 1 0 2 1 1 0 0 1 0-2z"/></svg>',
    phishing: '<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M8 1.5a.5.5 0 0 1 .5.5v4.5a2.5 2.5 0 0 1 2.5 2.5c0 1-.5 1.8-1.2 2.4L9 12.1V14a.5.5 0 0 1-1 0v-2a.5.5 0 0 1 .15-.35C9 10.85 10 10.2 10 9a1.5 1.5 0 0 0-1.5-1.5H8.5v2a.5.5 0 0 1-1 0V2a.5.5 0 0 1 .5-.5z"/><path d="M5.5 3.5a2.5 2.5 0 0 1 5 0 .5.5 0 0 1-1 0 1.5 1.5 0 0 0-3 0 .5.5 0 0 1-1 0z"/></svg>',
    headers: '<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M14 1a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H2a1 1 0 0 1-1-1V2a1 1 0 0 1 1-1h12zM2 0a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V2a2 2 0 0 0-2-2H2z"/><path d="M3 4h10v1H3V4zm0 3h10v1H3V7zm0 3h7v1H3v-1z"/></svg>',
    details: '<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M8 15A7 7 0 1 1 8 1a7 7 0 0 1 0 14zm0 1A8 8 0 1 0 8 0a8 8 0 0 0 0 16z"/><path d="m8.93 6.588-2.29.287-.082.38.45.083c.294.07.352.176.288.469l-.738 3.468c-.194.897.105 1.319.808 1.319.545 0 1.178-.252 1.465-.598l.088-.416c-.2.176-.492.246-.686.246-.275 0-.375-.193-.304-.533L8.93 6.588zM9 4.5a1 1 0 1 1-2 0 1 1 0 0 1 2 0z"/></svg>',
    deletePermanently: '<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M16 8A8 8 0 1 1 0 8a8 8 0 0 1 16 0zM8 15A7 7 0 1 0 8 1a7 7 0 0 0 0 14z"/><path d="M4.646 4.646a.5.5 0 0 1 .708 0L8 7.293l2.646-2.647a.5.5 0 0 1 .708.708L8.707 8l2.647 2.646a.5.5 0 0 1-.708.708L8 8.707l-2.646 2.647a.5.5 0 0 1-.708-.708L7.293 8 4.646 5.354a.5.5 0 0 1 0-.708z"/></svg>',
  };

  function _sortActionsByOrder(actions, order) {
    if (!order || !order.length) return actions;
    const orderMap = {};
    for (let i = 0; i < order.length; i++) orderMap[order[i]] = i;
    return [...actions].sort((a, b) => {
      const ai = orderMap[a.key] !== undefined ? orderMap[a.key] : 999;
      const bi = orderMap[b.key] !== undefined ? orderMap[b.key] : 999;
      return ai - bi;
    });
  }

  function createActionBtn(className, title, iconHtml, handler) {
    const btn = document.createElement('button');
    btn.className = 'action-btn ' + className;
    btn.title = title;
    _setHTML(btn, iconHtml);
    btn.addEventListener('click', handler);
    return btn;
  }

  // --- Message List ---

  function renderMessages(messages, accounts) {
    messageList.textContent = '';
    _accountSections = [];
    // A license problem concerns every account, so it leads the list.
    const licenseBanner = _renderLicenseBanner(messageList, _premium);

    // Group messages by account
    const grouped = new Map();
    if (messages) {
      for (const msg of messages) {
        const key = msg._accountId || 'unknown';
        if (!grouped.has(key)) grouped.set(key, []);
        grouped.get(key).push(msg);
      }
    }

    // Build ordered account list: accounts with messages first (in account order), then remaining
    const allAccounts = accounts || [];
    const orderedIds = [];
    for (const acc of allAccounts) {
      orderedIds.push(acc.id);
    }
    // Add any account IDs from messages that aren't in accounts list
    for (const key of grouped.keys()) {
      if (!orderedIds.includes(key)) orderedIds.push(key);
    }

    if (orderedIds.length === 0) {
      emptyInbox.classList.remove('hidden');
      // The list stays up, sized to the banner, when it holds one.
      messageList.classList.toggle('hidden', !licenseBanner);
      messageList.classList.toggle('license-banner-only', !!licenseBanner);
      return;
    }

    emptyInbox.classList.add('hidden');
    messageList.classList.remove('hidden', 'license-banner-only');

    // Free tier lock: only the first account is live. Second+ accounts render
    // as a locked header with a 🔒 icon; no messages, no actions.
    const freeAccountLock = !isPremium();

    for (let _idx = 0; _idx < orderedIds.length; _idx++) {
      const accountId = orderedIds[_idx];
      const msgs = grouped.get(accountId) || [];
      const accInfo = allAccounts.find(a => a.id === accountId);
      const email = (msgs.length > 0 && msgs[0]._accountEmail) || (accInfo && accInfo.email) || accountId;
      const unread = msgs.filter(m => m.Unread === 1).length;

      const displayLabel = (accInfo && accInfo.label) || email;
      const acctColor = (accInfo && accInfo.color) || '';

      const isLockedAccount = freeAccountLock && _idx > 0;

      if (isLockedAccount) {
        // Render a minimal locked header and move on: no messages, no buttons.
        const lockedHeader = document.createElement('li');
        lockedHeader.className = 'account-section-header account-locked';
        const effectiveColor = acctColor || '#6D4AFF';
        // Expose the account colour as --acct-tint (not an inline background) so
        // each theme's .account-section-header rule can decide how to use it:
        // solid bar, rounded card, gradient, or a transparent pill.
        lockedHeader.style.setProperty('--acct-tint', effectiveColor);
        lockedHeader.style.borderLeftColor = effectiveColor;
        const isLight = _luminance(effectiveColor) > 0.55;
        lockedHeader.style.setProperty('--header-text', isLight ? '#1a1a1a' : '#ffffff');
        lockedHeader.style.setProperty('--header-overlay', isLight ? 'rgba(0,0,0,0.1)' : 'rgba(255,255,255,0.2)');

        const label = document.createElement('span');
        label.className = 'account-section-label';
        label.textContent = displayLabel;
        lockedHeader.appendChild(label);

        const lockIcon = document.createElement('span');
        lockIcon.className = 'account-locked-icon';
        lockIcon.textContent = '🔒';
        lockIcon.title = ProtonI18n.t('premiumRequired');
        lockedHeader.appendChild(lockIcon);

        // Clicking the locked header opens the upgrade pricing page, or the
        // license action while held (the user already has a subscription).
        lockedHeader.style.cursor = 'pointer';
        lockedHeader.addEventListener('click', () => {
          if (_premium.held) _runLicenseAction(_premium.held, null);
          else browser.tabs.create({ url: PRICING_URL });
        });

        messageList.appendChild(lockedHeader);
        continue;
      }

      // Account section header (clickable, opens inbox)
      const header = document.createElement('li');
      header.className = 'account-section-header';
      const effectiveColor = acctColor || '#6D4AFF';
      // Expose the account colour as --acct-tint (not an inline background) so
      // each theme's .account-section-header rule can decide how to use it.
      header.style.setProperty('--acct-tint', effectiveColor);
      header.style.borderLeftColor = effectiveColor;
      const isLight = _luminance(effectiveColor) > 0.55;
      const headerTextColor = isLight ? '#1a1a1a' : '#ffffff';
      header.style.setProperty('--header-text', headerTextColor);
      header.style.setProperty('--header-overlay', isLight ? 'rgba(0,0,0,0.1)' : 'rgba(255,255,255,0.2)');

      const headerLeft = document.createElement('span');
      headerLeft.className = 'account-section-label';
      headerLeft.textContent = displayLabel;
      headerLeft.title = ProtonI18n.t('openAccountInbox', email);
      headerLeft.addEventListener('click', () => {
        browser.runtime.sendMessage({ type: 'GET_MAIL_URL', accountId }).then(url => {
          browser.tabs.create({ url });
          window.close();
        });
      });
      header.appendChild(headerLeft);

      const spacer = document.createElement('span');
      spacer.className = 'account-section-spacer';
      header.appendChild(spacer);

      const headerRight = document.createElement('span');
      headerRight.className = 'account-section-right';

      if (unread > 0) {
        const badge = document.createElement('span');
        badge.className = 'account-section-count';
        badge.textContent = unread;
        headerRight.appendChild(badge);
      }

      // Compose button. Free users see it (for discoverability) and get an
      // upgrade toast on click, unless they've opted to hide premium UI.
      if (showPremiumUI()) {
        const composeBtn = document.createElement('button');
        composeBtn.className = 'account-header-btn';
        composeBtn.title = ProtonI18n.t('compose');
        _setHTML(composeBtn, '<svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor"><path d="M12.146.146a.5.5 0 0 1 .708 0l3 3a.5.5 0 0 1 0 .708l-10 10a.5.5 0 0 1-.168.11l-5 2a.5.5 0 0 1-.65-.65l2-5a.5.5 0 0 1 .11-.168l10-10zM11.207 2.5L13.5 4.793 14.793 3.5 12.5 1.207 11.207 2.5zm1.586 3L10.5 3.207 4 9.707V10h.5a.5.5 0 0 1 .5.5v.5h.5a.5.5 0 0 1 .5.5v.5h.293l6.5-6.5zm-9.761 5.175l-.106.106-1.528 3.821 3.821-1.528.106-.106A.5.5 0 0 1 5 12.5V12h-.5a.5.5 0 0 1-.5-.5V11h-.5a.5.5 0 0 1-.468-.325z"/></svg>');
        composeBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          if (!requirePremium('compose')) return;
          if (_settings.composeMode === 'popup') {
            openCompose(accountId);
          } else {
            browser.runtime.sendMessage({ type: 'GET_COMPOSE_URL', accountId }).then(url => {
              browser.tabs.create({ url });
              window.close();
            });
          }
        });
        headerRight.appendChild(composeBtn);
      }

      // Collapse/expand toggle
      const collapseBtn = document.createElement('button');
      collapseBtn.className = 'account-header-btn account-collapse-btn';
      collapseBtn.title = ProtonI18n.t('collapse');
      _setHTML(collapseBtn, '<svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor"><path fill-rule="evenodd" d="M1.646 4.646a.5.5 0 0 1 .708 0L8 10.293l5.646-5.647a.5.5 0 0 1 .708.708l-6 6a.5.5 0 0 1-.708 0l-6-6a.5.5 0 0 1 0-.708z"/></svg>');
      headerRight.appendChild(collapseBtn);

      // Burger menu (bulk actions). Shown to free users (upgrade toast on
      // click) unless they've opted to hide premium UI.
      if (showPremiumUI()) {
        const burgerBtn = document.createElement('button');
        burgerBtn.className = 'account-header-btn account-burger-btn';
        burgerBtn.title = ProtonI18n.t('bulkActions');
        _setHTML(burgerBtn, '<svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor"><path fill-rule="evenodd" d="M2.5 12a.5.5 0 0 1 .5-.5h10a.5.5 0 0 1 0 1H3a.5.5 0 0 1-.5-.5zm0-4a.5.5 0 0 1 .5-.5h10a.5.5 0 0 1 0 1H3a.5.5 0 0 1-.5-.5zm0-4a.5.5 0 0 1 .5-.5h10a.5.5 0 0 1 0 1H3a.5.5 0 0 1-.5-.5z"/></svg>');
        burgerBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          if (!requirePremium('bulkActions')) return;
          _openBulkMenu(burgerBtn, msgs, accountId);
        });
        burgerBtn.addEventListener('mouseenter', () => {
          if (!isPremium()) return; // don't open on hover for free users
          if (!_bulkMenuEl) _openBulkMenu(burgerBtn, msgs, accountId);
        });
        headerRight.appendChild(burgerBtn);
      }

      header.appendChild(headerRight);
      messageList.appendChild(header);

      // Show status banner if keys are not unlocked (session expired).
      // authError distinguishes permanent failures (background stops polling):
      // 'reauth' = refresh token invalid, 'disabled' = account deleted/disabled.
      // keysUnlocking is the transient cold-start state (the cached list is shown
      // before keys finish decrypting), NOT an error, so don't alarm the user with
      // a "session expired" banner during it; it clears the moment keys unlock.
      const msgItems = [];
      if (accInfo && (accInfo.authError || (!accInfo.keysUnlocked && !accInfo.keysUnlocking))) {
        const banner = document.createElement('li');
        banner.className = 'account-status-banner';
        banner.style.borderLeftColor = effectiveColor;
        const icon = document.createElement('span');
        icon.className = 'status-banner-icon';
        icon.textContent = '\u26A0'; // ⚠
        banner.appendChild(icon);
        const text = document.createElement('span');
        text.textContent = accInfo.authError === 'disabled'
          ? ProtonI18n.t('accountDisabledBanner')
          : accInfo.authError === 'reauth'
            ? ProtonI18n.t('sessionExpiredSignIn')
            : ProtonI18n.t('sessionExpiredRetrying');
        banner.appendChild(text);
        const signInBtn = document.createElement('button');
        signInBtn.className = 'banner-sign-in-btn';
        signInBtn.textContent = ProtonI18n.t('signIn');
        signInBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          _showReauthForm(accInfo.email || accInfo.username || '');
        });
        banner.appendChild(signInBtn);
        msgItems.push(banner);
        messageList.appendChild(banner);
      }

      // Create message items for this account
      for (const msg of msgs) {
        const item = createMessageItem(msg, false);
        item.style.setProperty('--acct-tint', effectiveColor);
        msgItems.push(item);
        messageList.appendChild(item);
      }

      // Track section for global collapse
      const section = { collapseBtn, items: msgItems, collapsed: false };
      _accountSections.push(section);

      // Collapse/expand handler
      collapseBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        section.collapsed = !section.collapsed;
        collapseBtn.classList.toggle('collapsed', section.collapsed);
        collapseBtn.title = section.collapsed ? ProtonI18n.t('expand') : ProtonI18n.t('collapse');
        for (const item of msgItems) {
          item.classList.toggle('hidden', section.collapsed);
        }
        _syncCollapseAllBtn();
      });
    }
  }

  // --- Sender Avatars ---

  const AVATAR_COLORS = [
    '#E91E63', '#9C27B0', '#673AB7', '#3F51B5', '#2196F3',
    '#00BCD4', '#009688', '#4CAF50', '#8BC34A', '#FF9800',
    '#FF5722', '#795548', '#607D8B', '#E65100', '#1565C0',
  ];

  function _hashString(str) {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      hash = ((hash << 5) - hash) + str.charCodeAt(i);
      hash |= 0;
    }
    return Math.abs(hash);
  }

  function _getAvatarColor(email) {
    return AVATAR_COLORS[_hashString(email || '') % AVATAR_COLORS.length];
  }

  function _getAvatarLetter(msg) {
    const name = msg.Sender && msg.Sender.Name;
    const email = msg.Sender && msg.Sender.Address;
    if (name && name.trim()) return name.trim()[0];
    if (email) return email[0];
    return '?';
  }

  function _getDomain(email) {
    if (!email) return null;
    const parts = email.split('@');
    if (parts.length !== 2) return null;
    const domain = parts[1].toLowerCase();
    // Skip common free email providers: favicons aren't useful sender icons
    const skip = ['gmail.com', 'yahoo.com', 'hotmail.com', 'outlook.com',
      'proton.me', 'protonmail.com', 'pm.me', 'icloud.com', 'aol.com',
      'live.com', 'mail.com', 'gmx.com', 'gmx.net', 'web.de', 'yandex.com'];
    if (skip.includes(domain) || domain.endsWith('.proton.me') || domain.endsWith('.protonmail.com')) return null;
    return domain;
  }

  // Cache resolved sender logos, keyed by `domain|mode`: a data: URL (Proton
  // proxy) or an https favicon URL (fallback) when one was found, or false when
  // neither was. Avoids refetching on every list render.
  const _logoCache = new Map();

  // Whether sender logos may be loaded. They come primarily from Proton's image
  // proxy (core/v4/images/logo: BIMI/favicon resolved server-side, so the
  // sender doesn't see us); when Proton has no logo we fall back to the domain
  // favicon directly (which DOES touch the sender's server). Either way it's
  // remote content fetched on view, so by default it follows the remote-content
  // gate (the "Always load external content" setting, or the per-message "Load
  // external content" click). The free `loadSenderIconsAlways` option always
  // loads regardless.
  function _senderIconsAllowed(isOpenMessage) {
    if (_settings && _settings.loadSenderIconsAlways) return true;
    if (_settings && _settings.alwaysLoadExternalContent) return true;
    return !!(isOpenMessage && _externalContentLoaded);
  }

  function createAvatarEl(msg, allowIcon) {
    const email = msg.Sender && msg.Sender.Address;
    const letter = _getAvatarLetter(msg);
    const color = _getAvatarColor(email);

    const wrap = document.createElement('div');
    wrap.className = 'msg-avatar-wrap';

    const avatar = document.createElement('div');
    avatar.className = 'msg-avatar';
    avatar.style.background = color;
    avatar.textContent = letter;
    wrap.appendChild(avatar);

    // Sender logo (BIMI/favicon via Proton's image proxy), only when allowed.
    const domain = allowIcon ? _getDomain(email) : null;
    if (domain) {
      const mode = document.body.getAttribute('data-color-scheme') === 'dark' ? 'dark' : 'light';
      const key = domain + '|' + mode;
      const cached = _logoCache.get(key);
      if (typeof cached === 'string') {
        _setAvatarImg(avatar, cached); // known logo, show immediately
      } else if (cached !== false) {
        // Unknown: fetch it through the background (Proton's proxy, authed).
        browser.runtime.sendMessage({
          type: 'GET_SENDER_LOGO', accountId: msg._accountId, email, size: 64, mode,
        }).then((res) => {
          if (res && res.ok && res.dataUrl) {
            _logoCache.set(key, res.dataUrl);
            _setAvatarImg(avatar, res.dataUrl);
          } else {
            // Proton has no logo (204) for this domain (e.g. small/personal
            // domains without a VMC-verified BIMI). Optionally fall back to the
            // domain's own favicon (opt-in, since it pings the sender directly).
            _maybeFaviconFallback(avatar, domain, key);
          }
        }).catch(() => { _maybeFaviconFallback(avatar, domain, key); });
      }
      // cached === false: known "no logo", keep the initials avatar
    }

    if (msg.Unread === 1) {
      const dot = document.createElement('div');
      dot.className = 'unread-dot';
      wrap.appendChild(dot);
    }

    return wrap;
  }

  function _setAvatarImg(avatarEl, src) {
    avatarEl.textContent = '';
    avatarEl.style.background = 'var(--bg-secondary)';
    const img = document.createElement('img');
    img.src = src;
    img.alt = '';
    avatarEl.appendChild(img);
  }

  // Fallback when Proton's proxy has no logo: load the domain's favicon
  // directly, but ONLY if the user opted in (senderIconFaviconFallback), since
  // this re-introduces a direct request to the sender's server. Failures (no
  // favicon, refused connection) fall through to the initials avatar.
  function _maybeFaviconFallback(avatarEl, domain, key) {
    if (!(_settings && _settings.senderIconFaviconFallback)) {
      _logoCache.set(key, false); // no Proton logo + fallback off → initials
      return;
    }
    const src = `https://${domain}/favicon.ico`;
    const img = new Image();
    img.onload = () => {
      _logoCache.set(key, src);
      _setAvatarImg(avatarEl, src);
    };
    img.onerror = () => { _logoCache.set(key, false); };
    img.src = src;
  }

  // --- OTP Code Detection ---
  // Patterns live in lib/code-patterns.js (shared with options.js).
  // Free users always get the shipped defaults; premium users may
  // override/disable defaults and add their own custom patterns.

  function _detectOTP(subject, snippet) {
    if (_settings && _settings.codeDetectionEnabled === false) return null;
    if (typeof ProtonCodePatterns === 'undefined') return null;
    const stored = (_settings && Array.isArray(_settings.codePatterns))
      ? _settings.codePatterns
      : [];
    const merged = ProtonCodePatterns.mergeWithDefaults(stored);
    const text = ((subject || '') + '\n' + (snippet || '')).trim();
    return ProtonCodePatterns.detectCode(text, merged);
  }

  function _formatSender(msg) {
    const name = msg.Sender && msg.Sender.Name;
    const email = msg.Sender && msg.Sender.Address;
    const format = _settings.senderDisplayFormat || 'name';
    switch (format) {
      case 'email':
        return email || name || ProtonI18n.t('unknown');
      case 'name-email':
        if (name && email) return `${name} <${email}>`;
        return name || email || ProtonI18n.t('unknown');
      case 'email-name':
        if (name && email) return `<${email}> ${name}`;
        return email || name || ProtonI18n.t('unknown');
      default:
        return name || email || ProtonI18n.t('unknown');
    }
  }

  function createMessageItem(msg, _showAccountBadge) {
    const isUnread = msg.Unread === 1;
    const sender = _formatSender(msg);
    const subject = msg.Subject || ProtonI18n.t('noSubject');
    const time = formatMessageTime(msg.Time);

    const li = document.createElement('li');
    li.className = `message-item${isUnread ? ' unread' : ''}`;
    li.dataset.messageId = msg.ID;

    const avatarWrap = createAvatarEl(msg, _senderIconsAllowed(false));

    const content = document.createElement('div');
    content.className = 'msg-content';

    const topRow = document.createElement('div');
    topRow.className = 'msg-top-row';
    const senderEl = document.createElement('span');
    senderEl.className = 'msg-sender';
    senderEl.textContent = sender;
    const timeEl = document.createElement('span');
    timeEl.className = 'msg-time';
    timeEl.textContent = time;
    topRow.appendChild(senderEl);
    if (msg.NumAttachments > 0) {
      const attachEl = document.createElement('span');
      attachEl.className = 'msg-attach-icon';
      attachEl.title = msg.NumAttachments + ' ' + ProtonI18n.t(msg.NumAttachments === 1 ? 'attachment' : 'attachments');
      attachEl.textContent = '\uD83D\uDCCE';
      if (msg.NumAttachments > 1) {
        const countEl = document.createElement('span');
        countEl.className = 'msg-attach-count';
        countEl.textContent = msg.NumAttachments;
        attachEl.appendChild(countEl);
      }
      topRow.appendChild(attachEl);
    }
    // Replied/forwarded arrows go where Proton puts them, just left of the
    // date, and only when there is one to show so the row keeps its spacing.
    const replyStateEl = document.createElement('span');
    replyStateEl.className = 'msg-reply-state';
    _renderReplyState(replyStateEl, msg);
    if (replyStateEl.childElementCount > 0) topRow.appendChild(replyStateEl);
    topRow.appendChild(timeEl);

    const subjectEl = document.createElement('div');
    subjectEl.className = 'msg-subject';
    subjectEl.textContent = subject;

    content.appendChild(topRow);
    content.appendChild(subjectEl);

    // Email body preview
    const previewLineCount = _settings.previewLines || 0;
    if (previewLineCount > 0 && msg._snippet) {
      const previewEl = document.createElement('div');
      previewEl.className = 'msg-preview';
      previewEl.textContent = msg._snippet;
      previewEl.style.webkitLineClamp = previewLineCount;
      content.appendChild(previewEl);
    }

    // OTP code detection: scan subject + preview snippet
    const otpCode = _detectOTP(subject, msg._snippet);
    if (otpCode) {
      const otpBadge = document.createElement('button');
      otpBadge.className = 'otp-badge';
      otpBadge.title = ProtonI18n.t('copyCodeToClipboard');
      otpBadge.textContent = otpCode;
      otpBadge.addEventListener('click', (e) => {
        e.stopPropagation();
        navigator.clipboard.writeText(otpCode).then(() => {
          showToast(ProtonI18n.t('codeCopiedWithCode', otpCode));
        }).catch(() => {
          showToast(ProtonI18n.t('failedToCopyCode'));
        });
      });
      content.appendChild(otpBadge);
    }

    // Failed action badge
    if (msg._failedAction) {
      const failBadge = document.createElement('div');
      failBadge.className = 'msg-failed-badge';
      failBadge.textContent = msg._failedAction;
      content.appendChild(failBadge);
      li.classList.add('msg-failed');
    }

    li.appendChild(avatarWrap);
    li.appendChild(content);

    // Quick action buttons: split into visible primary + overflow
    const actions = document.createElement('div');
    actions.className = 'msg-actions';

    const accountId = msg._accountId;
    // Free tier: when "hide premium UI" is on, show only openWeb + markRead.
    // Otherwise show the full set; premium-only actions show an upgrade toast.
    const FREE_LIST_ACTIONS = ['openWeb', 'markRead'];
    const visibleActions = showPremiumUI()
      ? (_settings.visibleActions || ['openWeb', 'markRead', 'archive', 'snooze', 'delete'])
      : FREE_LIST_ACTIONS;
    const actionOrder = showPremiumUI() ? (_settings.actionOrder || null) : null;

    // Check if message is starred (LabelID '10' = Starred)
    const isStarred = msg.LabelIDs && msg.LabelIDs.includes('10');

    // Define all action descriptors
    const allActions = [
      { key: 'openWeb', cls: 'action-open-web', title: ProtonI18n.t('openInProtonMail'), icon: ICONS.openWeb,
        handler: (e) => {
          e.stopPropagation();
          browser.runtime.sendMessage({ type: 'GET_MAIL_URL', conversationId: msg.ConversationID, messageId: msg.ID, accountId })
            .then(mailUrl => { browser.tabs.create({ url: mailUrl }); window.close(); });
        }},
      { key: 'star', cls: isStarred ? 'action-star starred' : 'action-star', title: isStarred ? ProtonI18n.t('unstar') : ProtonI18n.t('star'),
        icon: isStarred ? ICONS.starFilled : ICONS.star,
        handler: (e) => handleStar(e, msg.ID, accountId, isStarred) },
      { key: 'markRead', cls: 'action-read', title: ProtonI18n.t('markAsRead'), icon: ICONS.markRead,
        handler: (e) => handleMarkRead(e, msg.ID, accountId),
        condition: isUnread },
      { key: 'label', cls: 'action-label', title: ProtonI18n.t('labels'), icon: ICONS.label,
        handler: (e) => handleLabelMenu(e, msg, accountId) },
      { key: 'moveToFolder', cls: 'action-folder', title: ProtonI18n.t('moveToFolder'), icon: ICONS.folder,
        handler: (e) => handleFolderMenu(e, msg, accountId) },
      { key: 'archive', cls: 'action-archive', title: ProtonI18n.t('archive'), icon: ICONS.archive,
        handler: (e) => handleArchive(e, msg.ID, accountId) },
      { key: 'snooze', cls: 'action-snooze', title: ProtonI18n.t('snooze'), icon: ICONS.snooze,
        handler: (e) => handleSnooze(e, msg.ConversationID, accountId) },
      { key: 'delete', cls: 'action-delete', title: ProtonI18n.t('delete'), icon: ICONS.trash,
        handler: (e) => handleTrash(e, msg.ID, accountId) },
      { key: 'deletePermanently', cls: 'action-delete-permanently', title: ProtonI18n.t('deletePermanently'), icon: ICONS.deletePermanently,
        handler: (e) => handleDeletePermanently(e, msg.ID, accountId) },
      { key: 'spam', cls: 'action-spam', title: ProtonI18n.t('moveToSpam'), icon: ICONS.spam,
        handler: (e) => handleMoveToSpam(e, msg.ID, accountId) },
      { key: 'phishing', cls: 'action-phishing', title: ProtonI18n.t('reportPhishing'), icon: ICONS.phishing,
        handler: (e) => handleReportPhishing(e, msg.ID, accountId) },
      // Headers/details need the FULL message (openPreview's fetch merges
      // Header/Size/... into _selectedMsg), so await it, then open the modal
      // directly. Landing on the preview alone and making the user click
      // again was the old (reported) behaviour.
      { key: 'headers', cls: 'action-headers', title: ProtonI18n.t('viewHeaders'), icon: ICONS.headers,
        handler: async (e) => { e.stopPropagation(); await openPreview(msg); showMessageHeaders(); } },
      { key: 'details', cls: 'action-details', title: ProtonI18n.t('messageDetails'), icon: ICONS.details,
        handler: async (e) => { e.stopPropagation(); await openPreview(msg); showMessageDetails(); } },
      { key: 'exportEml', cls: 'action-export-eml', title: ProtonI18n.t('exportEml'), icon: ICONS.exportEml,
        handler: async (e) => {
          if (e && e.stopPropagation) e.stopPropagation();
          // The list item is metadata only. Fetch the full message (headers,
          // decrypted body, attachments) before building the .eml.
          try {
            const resp = await browser.runtime.sendMessage({ type: 'GET_MESSAGE', messageId: msg.ID, accountId });
            if (resp && resp.message) await handleExportEml(e, resp.message, accountId);
            else showToast(ProtonI18n.t('downloadFailed'));
          } catch (_) { showToast(ProtonI18n.t('downloadFailed')); }
        } },
    ];

    // Sort by user-defined order, then filter by condition
    const sorted = _sortActionsByOrder(allActions, actionOrder);
    const available = sorted.filter(a => a.condition !== false);
    const primary = available.filter(a => visibleActions.includes(a.key));
    // Overflow is empty only when "hide premium UI" is on for a free user.
    const overflow = showPremiumUI()
      ? available.filter(a => !visibleActions.includes(a.key))
      : [];

    // Wrap premium-only handlers with an upgrade-toast gate for free users.
    // Free-tier allowed actions (always functional): openWeb + markRead.
    const FREE_ALLOWED_KEYS = new Set(['openWeb', 'markRead', 'exportEml']);
    function _wrapHandler(action) {
      if (isPremium() || FREE_ALLOWED_KEYS.has(action.key)) return action.handler;
      return (e) => {
        if (e && e.stopPropagation) e.stopPropagation();
        showUpgradePrompt(action.key);
      };
    }
    for (const a of [...primary, ...overflow]) a.handler = _wrapHandler(a);

    for (const a of primary) {
      actions.appendChild(createActionBtn(a.cls, a.title, a.icon, a.handler));
    }

    if (overflow.length > 0) {
      const overflowWrap = document.createElement('div');
      overflowWrap.className = 'action-overflow-wrap';

      const moreBtn = document.createElement('button');
      moreBtn.className = 'action-btn action-more';
      moreBtn.title = ProtonI18n.t('moreActions');
      _setHTML(moreBtn, '<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><circle cx="3" cy="8" r="1.5"/><circle cx="8" cy="8" r="1.5"/><circle cx="13" cy="8" r="1.5"/></svg>');
      overflowWrap.appendChild(moreBtn);

      const overflowMenu = document.createElement('div');
      overflowMenu.className = 'action-overflow-menu hidden';

      // Hover-based overflow: open on enter, close on leave (shared timer)
      overflowWrap.addEventListener('mouseenter', () => {
        _menuEnter();
        _closeSubmenu();
        document.querySelectorAll('.action-overflow-menu').forEach(m => {
          if (m !== overflowMenu) m.classList.add('hidden');
        });
        overflowMenu.classList.remove('hidden');
        const msgItem = overflowWrap.closest('.message-item');
        if (msgItem) msgItem.classList.add('submenu-open');
      });
      overflowWrap.addEventListener('mouseleave', _menuLeave);

      for (const a of overflow) {
        const opensSubmenu = (a.key === 'label' || a.key === 'moveToFolder');
        const btn = createActionBtn(a.cls, a.title, a.icon, (e) => {
          if (!opensSubmenu) {
            _closeAllMenus();
            a.handler(e);
          }
        });
        if (opensSubmenu) {
          btn.addEventListener('mouseenter', () => {
            _menuEnter();
            _openSubmenu(btn, msg, accountId, a.key === 'label' ? 'label' : 'folder');
          });
        } else {
          btn.addEventListener('mouseenter', () => {
            _closeSubmenu();
          });
        }
        overflowMenu.appendChild(btn);
      }

      overflowWrap.appendChild(overflowMenu);
      actions.appendChild(overflowWrap);
    }

    li.appendChild(actions);
    li.addEventListener('click', () => openPreview(msg));
    return li;
  }

  function _getAccountInitials(label) {
    if (!label) return '??';
    // If it's an email, use first letter of local part + first letter of domain
    const atIdx = label.indexOf('@');
    if (atIdx > 0) {
      return (label[0] + label[atIdx + 1]).toUpperCase();
    }
    // Otherwise use first two chars or initials of words
    const words = label.trim().split(/\s+/);
    if (words.length >= 2) return (words[0][0] + words[1][0]).toUpperCase();
    return label.substring(0, 2).toUpperCase();
  }

  function updateStatusBar(state) {
    accountPillsEl.textContent = '';

    if (state.isLoggedIn && state.messages && state.accounts && state.accounts.length > 0) {
      // Group messages by account to count unread per account
      const unreadByAccount = {};
      for (const msg of state.messages) {
        const aid = msg._accountId || 'unknown';
        if (!unreadByAccount[aid]) unreadByAccount[aid] = 0;
        if (msg.Unread === 1) unreadByAccount[aid]++;
      }

      for (const acc of state.accounts) {
        const color = acc.color || '#6D4AFF';
        const label = acc.label || acc.email || acc.id;
        const initials = acc.initials || _getAccountInitials(label);
        const unread = unreadByAccount[acc.id] || 0;

        const pill = document.createElement('button');
        pill.className = 'account-pill';
        pill.title = label + (unread > 0 ? ' (' + unread + ')' : '');

        const circle = document.createElement('span');
        circle.className = 'account-pill-circle';
        circle.style.background = color;
        const isLight = _luminance(color) > 0.55;
        circle.style.color = isLight ? '#1a1a1a' : '#ffffff';
        circle.textContent = initials;
        pill.appendChild(circle);

        if (unread > 0) {
          const badge = document.createElement('span');
          badge.className = 'account-pill-badge';
          badge.textContent = unread;
          pill.appendChild(badge);
        }

        pill.addEventListener('click', () => {
          // Find the account section header and scroll to it
          const headers = messageList.querySelectorAll('.account-section-header');
          for (const h of headers) {
            const labelEl = h.querySelector('.account-section-label');
            if (labelEl && labelEl.textContent === label) {
              h.scrollIntoView({ behavior: 'smooth', block: 'start' });
              // Also expand if collapsed
              const section = _accountSections.find(s => s.collapseBtn === h.querySelector('.account-collapse-btn'));
              if (section && section.collapsed) {
                section.collapsed = false;
                section.collapseBtn.classList.remove('collapsed');
                section.collapseBtn.title = ProtonI18n.t('collapse');
                for (const item of section.items) item.classList.remove('hidden');
                _syncCollapseAllBtn();
              }
              break;
            }
          }
        });

        accountPillsEl.appendChild(pill);
      }
    } else if (state.unreadCount >= 0) {
      // Fallback: simple text for no-account states
      const span = document.createElement('span');
      span.className = 'unread-count';
      span.textContent = state.unreadCount === 0
        ? ProtonI18n.t('noUnreadMessages')
        : ProtonI18n.t('unreadMessages', state.unreadCount);
      accountPillsEl.appendChild(span);
    }

    lastCheckedEl.textContent = state.lastCheckTime
      ? ProtonI18n.t('lastChecked', formatRelativeTime(state.lastCheckTime))
      : '';
  }

  function applyDensity() {
    document.body.classList.remove('density-comfortable', 'density-cozy', 'density-compact');
    // Free tier: locked to comfortable density + default popup dimensions.
    const premium = isPremium();
    const density = premium ? (_settings.displayDensity || 'comfortable') : 'comfortable';
    if (density !== 'comfortable') {
      document.body.classList.add('density-' + density);
    }
    if (IS_STANDALONE) {
      // Popped-out window: let CSS (body.standalone) fill the OS window so the
      // content tracks resizes. Clear any previously-set fixed dimensions.
      document.body.style.width = '';
      document.body.style.height = '';
    } else {
      const width = premium ? Math.min(_settings.popupWidth || 420, 800) : 420;
      const height = premium ? Math.min(_settings.popupHeight || 540, 600) : 540;
      document.body.style.width = width + 'px';
      document.body.style.height = height + 'px';
    }
    // Mirror the now-applied theme/scheme/density for the next cold open.
    _persistThemeBoot();
  }

  function render(state) {
    _savedState = state;
    _showingAccounts = false;
    _setHTML(btnAccount, ICON_ACCOUNT);
    btnAccount.title = ProtonI18n.t('accounts');

    // Track premium status and reflect it on <body> so CSS can hide premium-only
    // UI elements. Also drives JS-level gating (requirePremium(), filtered actions).
    const wasPremium = isPremium();
    if (state && state.premium) {
      _premium = state.premium;
    }
    document.body.classList.toggle('is-free', !isPremium());
    document.body.classList.toggle('is-premium', isPremium());
    // When the user has opted to hide premium UI, apply a root class so CSS
    // can collapse static premium-only elements (DND button, Pop-out, etc.).
    document.body.classList.toggle('hide-premium-ui', !showPremiumUI());
    _renderPremiumHeaderBadge();
    // If premium flipped (trial started / license activated / license removed),
    // re-apply theme + color scheme + custom CSS so the UI updates immediately.
    if (wasPremium !== isPremium()) {
      _applyTheme();
      _applyColorScheme(_settings.colorScheme || 'auto');
      _applyCustomCSS(_settings.customCSS || '');
    }

    applyDensity();

    if (!state.isLoggedIn) {
      // No accounts: show accounts view
      showAccountsView();
      updateStatusBar(state);
      return;
    }

    if (state.badgeState === 'error') {
      _showErrorState(ProtonI18n.t('couldNotConnect'));
      updateStatusBar(state);
      return;
    }

    showState('normal');
    updateStatusBar(state);
    renderMessages(state.messages, state.accounts);

    if (_selectedMsg) {
      const stillExists = state.messages && state.messages.some(m => m.ID === _selectedMsg.ID);
      // Forced, so it never prompts and never needs awaiting; render() stays
      // synchronous for its five callers.
      if (!stillExists) closePreview({ force: true });
    }
  }

  async function loadState(retries = 10) {
    try {
      const state = await browser.runtime.sendMessage({ type: 'GET_STATE' });
      _reconcile(state);
      try {
        await _restoreDraft();
        await _pickUpPendingAttachments();
        await _pickUpPendingDriveLinks();
        await _maybeOpenDeepLinkedMessage();
      } catch (e) {
        console.warn('[Draft] Restore failed:', e);
        _clearDraft();
        closeCompose();
      }
      try {
        await _restoreAccountDraft();
      } catch (e) {
        console.warn('[AccountDraft] Restore failed:', e);
        _clearAccountDraft();
      }
    } catch (err) {
      if (retries > 0 && err.message && err.message.includes('Receiving end does not exist')) {
        showState('loading');
        setTimeout(() => loadState(retries - 1), 1000);
        return;
      }
      _showErrorState(ProtonI18n.t('couldNotConnectBackground'));
    }
  }

  async function handleRefresh() {
    btnRefresh.classList.add('spinning');
    try {
      const state = await browser.runtime.sendMessage({ type: 'REFRESH' });
      _reconcile(state);
    } catch (err) {
      console.error('Refresh failed:', err);
    } finally {
      btnRefresh.classList.remove('spinning');
    }
  }

  /**
   * Whether a background-driven re-render must wait. Never while the user is
   * composing, so we don't clobber an in-progress draft view. Also not while
   * another on-screen sub-view is open that a re-render would tear down:
   * render() switches to the inbox (showState('normal')) and rebuilds the list:
   *   - #state-accounts hosts the per-account settings panels AND the login /
   *     2FA / mailbox-password forms, so changing the folder-mode dropdown or
   *     ticking a folder (both fire a REFRESH -> STATE_UPDATED) bounced the user
   *     out mid-edit. Checked via the DOM (not the _showingAccounts flag) so it
   *     also covers the pending-2FA / mailbox-password forms shown at startup,
   *     which never set that flag.
   *   - an open reply editor (inside the preview) is in-progress text like a
   *     compose draft and must not be interrupted by a poll.
   * The inbox re-renders when the user returns to it.
   */
  function _listRerenderBlocked() {
    if (composePanel && !composePanel.classList.contains('hidden')) return true;
    if (!stateAccounts.classList.contains('hidden')) return true;
    return !!_replyEditorOpen;
  }

  /** What the license banner and the gating show, to tell whether a status
   *  answer changes anything on screen. */
  function _licenseViewKey(premium) {
    return (premium && premium.premium ? 'premium' : 'free') + '|' + (_licenseBannerState(premium) || '');
  }

  /**
   * Apply the status LICENSE_NUDGE answered with. The nudge may have
   * re-validated (Paddle collected the payment, or a renewal failed), so
   * re-render when the screen would change. Before the first render there is
   * nothing to update: the GET_STATE that renders it carries the fresh status.
   */
  function _applyNudgedStatus(status) {
    if (!status || typeof status !== 'object' || !_savedState) return;
    const changed = _licenseViewKey(status) !== _licenseViewKey(_premium);
    _savedState.premium = status;
    if (changed && !_listRerenderBlocked()) render(_savedState);
  }

  // Background → popup push: the poller broadcasts STATE_UPDATED after every
  // completed poll, including the one kicked off when this popup opened
  // against a cold-started service worker (whose GET_STATE could only serve
  // a stale snapshot). Re-fetch and re-render unless a sub-view is open.
  browser.runtime.onMessage.addListener((msg) => {
    if (!msg || msg.type !== 'STATE_UPDATED') return;
    if (_listRerenderBlocked()) return;
    browser.runtime.sendMessage({ type: 'GET_STATE' })
      .then(_reconcile)
      .catch(() => { /* background unavailable; next manual refresh recovers */ });
  });

  // Spin the refresh button while the background is polling (the cold-start fetch,
  // a periodic alarm poll, or a refresh triggered elsewhere), the same affordance
  // as clicking refresh, so background activity is visible. handleRefresh() also
  // toggles this class for an instant manual response; both are idempotent.
  browser.runtime.onMessage.addListener((msg) => {
    if (!msg || msg.type !== 'POLL_STATUS' || !btnRefresh) return;
    btnRefresh.classList.toggle('spinning', !!msg.polling);
  });

  // --- Global collapse/expand ---

  function _syncCollapseAllBtn() {
    const allCollapsed = _accountSections.length > 0 &&
      _accountSections.every(s => s.collapsed);
    btnCollapseAll.classList.toggle('collapsed', allCollapsed);
    btnCollapseAll.title = allCollapsed ? ProtonI18n.t('expandAll') : ProtonI18n.t('collapseAll');
  }

  btnCollapseAll.addEventListener('click', () => {
    const allCollapsed = _accountSections.every(s => s.collapsed);
    const newState = !allCollapsed;
    for (const section of _accountSections) {
      section.collapsed = newState;
      section.collapseBtn.classList.toggle('collapsed', newState);
      section.collapseBtn.title = newState ? ProtonI18n.t('expand') : ProtonI18n.t('collapse');
      for (const item of section.items) {
        item.classList.toggle('hidden', newState);
      }
    }
    _syncCollapseAllBtn();
  });

  // --- Event listeners ---

  btnRefresh.addEventListener('click', handleRefresh);

  btnSettings.addEventListener('click', () => {
    browser.runtime.openOptionsPage();
    window.close();
  });

  btnUpgrade.addEventListener('click', () => {
    // Hidden while held; should it ever show, it must not sell a second subscription.
    if (_premium.held) { _runLicenseAction(_premium.held, btnUpgrade); return; }
    // Open the public pricing page so the user can read the plan comparison
    // before deciding whether to start a trial or buy a license.
    browser.tabs.create({ url: PRICING_URL });
  });

  btnPopout.addEventListener('click', () => {
    if (!requirePremium('popout')) return;
    _saveDraft(); // carry any in-progress compose/reply into the new window
    const width = _settings.popupWidth || 420;
    const height = _settings.popupHeight || 540;
    browser.windows.create({
      url: browser.runtime.getURL('popup/popup.html') + '?standalone=1',
      type: 'popup',
      width: width + 16,
      height: height + 40,
    });
    window.close();
  });

  btnRetry.addEventListener('click', handleRefresh);

  btnOpen.addEventListener('click', () => {
    browser.tabs.create({ url: 'https://mail.proton.me' });
    window.close();
  });

  // --- Keyboard Shortcuts ---

  function getFlatMessageItems() {
    return Array.from(messageList.querySelectorAll('.message-item'));
  }

  function setFocusedIndex(index) {
    const items = getFlatMessageItems();
    items.forEach(el => el.classList.remove('focused'));
    if (index >= 0 && index < items.length) {
      _focusedIndex = index;
      items[index].classList.add('focused');
      items[index].scrollIntoView({ block: 'nearest' });
    } else {
      _focusedIndex = -1;
    }
  }

  function getFocusedMessage() {
    const items = getFlatMessageItems();
    if (_focusedIndex >= 0 && _focusedIndex < items.length) {
      const msgId = items[_focusedIndex].dataset.messageId;
      return _savedState && _savedState.messages
        ? _savedState.messages.find(m => m.ID === msgId)
        : null;
    }
    return null;
  }

  document.addEventListener('keydown', async (e) => {
    // Don't handle shortcuts when typing in inputs or contentEditable
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.isContentEditable) {
      if (e.key === 'Escape') e.target.blur();
      return;
    }

    const previewOpen = previewPanel.classList.contains('visible');
    const items = getFlatMessageItems();

    switch (e.key) {
      case 'j': // Next message
        e.preventDefault();
        if (items.length > 0) {
          setFocusedIndex(Math.min(_focusedIndex + 1, items.length - 1));
        }
        break;

      case 'k': // Previous message
        e.preventDefault();
        if (items.length > 0) {
          setFocusedIndex(Math.max(_focusedIndex - 1, 0));
        }
        break;

      case 'Enter': { // Open preview
        e.preventDefault();
        const msg = getFocusedMessage();
        if (msg) openPreview(msg);
        break;
      }

      case 'Escape': // Close preview
        if (previewOpen) {
          e.preventDefault();
          await closePreview();
        }
        break;

      case 'e': { // Archive
        e.preventDefault();
        const msg = previewOpen ? _selectedMsg : getFocusedMessage();
        if (msg) handleArchive(e, msg.ID, msg._accountId);
        break;
      }

      case '#': { // Delete
        e.preventDefault();
        const msg = previewOpen ? _selectedMsg : getFocusedMessage();
        if (msg) handleTrash(e, msg.ID, msg._accountId);
        break;
      }

      case 'r': // Reply
        if (previewOpen) {
          e.preventDefault();
          const replyHtmlMode = _settings.replyFormat === 'html';
          (replyHtmlMode ? replyBody : replyText).focus();
        }
        break;
    }
  });

  // Reload settings when changed from options page
  browser.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.settings) {
      _settings = changes.settings.newValue || {};
      _applyTheme();
      _applyColorScheme(_settings.colorScheme || 'auto');
      _applyCustomCSS(_settings.customCSS || '');
      _applyFormatSettings();
      applyDensity();
      // hidePremiumUI affects message list and header buttons: re-render.
      document.body.classList.toggle('hide-premium-ui', !showPremiumUI());
      if (_savedState) render(_savedState);
    }
  });

  // Initial load: load settings, fetch premium status, then check for
  // pending 2FA or mailbox password. Premium MUST be known before
  // applyDensity() runs, otherwise paths that bypass render() (the 2FA /
  // mailbox-password auto-resume) would size the popup as a free user.
  showState('loading');
  // Once per open: the background re-checks a held or past-due license now
  // (it decides whether, at most once per 5 min), so a payment made
  // elsewhere shows up here without waiting for the daily check.
  browser.runtime.sendMessage({ type: 'LICENSE_NUDGE' })
    .then((res) => { if (res && res.ok) _applyNudgedStatus(res.status); })
    .catch(() => { /* background not ready: the scheduled checks cover it */ });
  // Run settings load and premium fetch in PARALLEL so we can apply
  // the (premium-gated) theme exactly once, with correct premium
  // state. Doing it sequentially was the cause of a brief
  // classic→user-theme flash on cold open.
  Promise.all([
    loadSettings(),
    browser.runtime.sendMessage({ type: 'GET_PREMIUM_STATUS' }).catch(() => null),
  ]).then(([_settingsResult, premiumStatus]) => {
    if (premiumStatus) _premium = premiumStatus;
    _applyVisualSettings();
    applyDensity();
    return browser.runtime.sendMessage({ type: 'GET_PENDING_2FA' });
  }).then(res => {
    if (res && res.pending) {
      showState('accounts');
      if (res.twoFactorType === 'fido2') {
        showFIDO2Info();
      } else if (res.twoFactorType === 'both') {
        show2FAChoice();
      } else {
        show2FAForm();
      }
      return;
    }
    // No pending 2FA: check for pending mailbox-password (legacy two-password flow)
    return browser.runtime.sendMessage({ type: 'GET_PENDING_MAILBOX_PASSWORD' }).then(mbxRes => {
      if (mbxRes && mbxRes.pending) {
        showState('accounts');
        showMailboxPasswordForm();
      } else {
        loadState();
      }
    });
  }).catch(() => {
    // Background not ready yet: loadState will retry
    loadState();
  });
})();
