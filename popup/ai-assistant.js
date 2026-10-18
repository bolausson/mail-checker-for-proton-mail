/**
 * AI writing assistant (Scribe) UI for the reply/compose editor.
 *
 * Renders the ✨ toolbar trigger, the action menu (Write for me, Proofread,
 * Expand, Shorten, Make formal, Make friendly), and the result preview panel
 * (Replace / Insert / Discard). All generation runs server-side via the
 * background `AI_RUN_ACTION` message (Proton's own endpoint); this file is
 * pure UI + orchestration.
 *
 * Visual language: refined-minimal, brand purple as a sharp accent, every
 * surface driven by the popup's theme vars so dark mode comes for free.
 * Menus/panels are portaled to <body> and share PopupEditorToolbar's
 * activePopups registry (Escape + outside-click + closeAllPopups).
 */

const PopupScribe = (() => {
  let _deps = null; // { sendMessage, showToast, t, isPremium, setHTML }
  let _deviceNoteShown = false;

  // action key → { i18n label key, inline SVG icon }
  const ACTIONS = [
    { action: 'writeFullEmail', label: 'scribeWriteForMe', icon: 'M5 3l1.2 2.6L9 6.8 6.2 8 5 10.6 3.8 8 1 6.8l2.8-1.2L5 3zm7 5l.8 1.7 1.7.8-1.7.8L12 13l-.8-1.9L9.5 10.3l1.7-.8L12 8z', write: true },
    { action: 'proofread', label: 'scribeProofread', icon: 'M6.5 11.6L3 8.1l1.1-1.1 2.4 2.4 5.4-5.4L13 5.1l-6.5 6.5z' },
    { action: 'expand', label: 'scribeExpand', icon: 'M2 4h12v1.5H2V4zm0 3.25h12v1.5H2v-1.5zM2 10.5h8V12H2v-1.5zm10.5-.4l2.4 2.4-2.4 2.4V13H11v-1.5h1.5v-1.4z' },
    { action: 'shorten', label: 'scribeShorten', icon: 'M2 4h12v1.5H2V4zm0 3.25h8v1.5H2v-1.5zM2 10.5h12V12H2v-1.5zm10-3.9V5.1l2.4 2.4-2.4 2.4V8.4h-1.5v-1.8H12z' },
    { action: 'formal', label: 'scribeFormal', icon: 'M8 1.5l1.9 3.9 4.3.6-3.1 3 .7 4.3L8 11.3l-3.8 2 .7-4.3-3.1-3 4.3-.6L8 1.5z' },
    { action: 'friendly', label: 'scribeFriendly', icon: 'M8 1.5A6.5 6.5 0 1 0 8 14.5 6.5 6.5 0 0 0 8 1.5zM5.5 6.5a1 1 0 1 1 2 0 1 1 0 0 1-2 0zm3 0a1 1 0 1 1 2 0 1 1 0 0 1-2 0zM5 9.2a.6.6 0 0 1 .85.18A2.6 2.6 0 0 0 8 10.6a2.6 2.6 0 0 0 2.15-1.22.6.6 0 1 1 1 .66A3.8 3.8 0 0 1 8 11.8a3.8 3.8 0 0 1-3.15-1.76A.6.6 0 0 1 5 9.2z' },
  ];

  const SPARKLE_SVG =
    '<svg viewBox="0 0 16 16" width="13" height="13" fill="currentColor" aria-hidden="true">' +
    '<path d="M8 1l1.4 3.3L13 5.7 9.4 7.1 8 10.6 6.6 7.1 3 5.7l3.6-1.4L8 1z"/>' +
    '<path d="M12.6 9.2l.7 1.6 1.7.7-1.7.7-.7 1.6-.7-1.6-1.6-.7 1.6-.7.7-1.6z"/></svg>';

  function _icon(path, size) {
    size = size || 14;
    return `<svg viewBox="0 0 16 16" width="${size}" height="${size}" fill="currentColor" aria-hidden="true"><path d="${path}"/></svg>`;
  }

  /** Escape text for safe interpolation into the panel/menu markup. */
  function _esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  // Render trusted markup (our own SVG icons + _esc'd text) into `el` WITHOUT
  // innerHTML. DOMParser documents are inert (no script execution, no resource
  // loads), so this is safe, and it avoids addons-linter's innerHTML warning.
  function _setHtml(el, html) {
    el.textContent = '';
    const doc = new DOMParser().parseFromString(html, 'text/html');
    while (doc.body.firstChild) el.appendChild(doc.body.firstChild);
  }

  // ── Portaled popup lifecycle (shares PopupEditorToolbar's registry) ──
  let _openEl = null;     // currently open menu/panel element
  let _openEntry = null;  // its activePopups entry
  let _reposition = null;
  let _outsideHandler = null;
  let _anchorBtn = null;

  function closeOpen() {
    if (_reposition) {
      window.removeEventListener('resize', _reposition);
      window.removeEventListener('scroll', _reposition, true);
      _reposition = null;
    }
    if (_outsideHandler) { document.removeEventListener('click', _outsideHandler, true); _outsideHandler = null; }
    if (_openEntry) { PopupEditorToolbar.unregisterPopup(_openEntry); _openEntry = null; }
    if (_openEl) { _openEl.remove(); _openEl = null; }
    _anchorBtn = null;
  }

  function _portal(el, anchorBtn) {
    closeOpen();
    PopupEditorToolbar.closeAllPopups(); // dismiss any emoji/colour picker too
    document.body.appendChild(el);
    _openEl = el;
    _anchorBtn = anchorBtn;
    PopupEditorToolbar.positionPopup(el, anchorBtn);
    _reposition = () => { if (_openEl) PopupEditorToolbar.positionPopup(_openEl, anchorBtn); };
    window.addEventListener('resize', _reposition);
    window.addEventListener('scroll', _reposition, true);
    _openEntry = { close: closeOpen };
    PopupEditorToolbar.registerPopup(_openEntry);
    // Outside-click closes (defer so the opening click doesn't immediately close it).
    setTimeout(() => {
      _outsideHandler = (e) => {
        if (_openEl && !_openEl.contains(e.target) && (!anchorBtn || !anchorBtn.contains(e.target))) closeOpen();
      };
      document.addEventListener('click', _outsideHandler, true);
    }, 0);
  }

  // ── Action menu ──
  function _buildMenu(ctx, anchorBtn) {
    const t = _deps.t;
    const menu = document.createElement('div');
    menu.className = 'scribe-menu';

    const list = document.createElement('div');
    list.className = 'scribe-menu-list';

    for (const a of ACTIONS) {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'scribe-menu-item' + (a.write ? ' scribe-menu-item--write' : '');
      _setHtml(row, '<span class="scribe-menu-ico">' + _icon(a.icon) + '</span>' +
        '<span class="scribe-menu-label">' + _esc(t(a.label)) + '</span>');
      row.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (a.write) { _openWritePanel(ctx, anchorBtn); }
        else { _runAndPreview(ctx, anchorBtn, a, null); }
      });
      list.appendChild(row);
    }

    menu.appendChild(list);
    const foot = document.createElement('div');
    foot.className = 'scribe-menu-foot';
    foot.textContent = t('scribePoweredBy');
    menu.appendChild(foot);
    return menu;
  }

  // ── "Write for me" topic panel ──
  function _openWritePanel(ctx, anchorBtn) {
    const t = _deps.t;
    const panel = document.createElement('div');
    panel.className = 'scribe-panel scribe-panel--write';
    _setHtml(panel,
      '<div class="scribe-panel-head"><span class="scribe-panel-title">' + SPARKLE_SVG +
      '<span>' + _esc(t('scribeWriteForMe')) + '</span></span>' +
      '<button type="button" class="scribe-x" aria-label="' + _esc(t('scribeDiscard')) + '">' + _icon('M4.3 3.3L8 7l3.7-3.7 1 1L9 8l3.7 3.7-1 1L8 9l-3.7 3.7-1-1L7 8 3.3 4.3z', 12) + '</button></div>' +
      '<div class="scribe-write-body">' +
      '<textarea class="scribe-topic" rows="3" placeholder="' + _esc(t('scribeTopicPlaceholder')) + '"></textarea>' +
      '</div>' +
      '<div class="scribe-panel-foot">' +
      '<button type="button" class="scribe-btn-primary scribe-generate">' + SPARKLE_SVG + '<span>' + _esc(t('scribeGenerate')) + '</span></button>' +
      '</div>');
    panel.querySelector('.scribe-x').addEventListener('click', (e) => { e.preventDefault(); closeOpen(); });
    const topic = panel.querySelector('.scribe-topic');
    const gen = panel.querySelector('.scribe-generate');
    const submit = () => {
      const v = topic.value.trim();
      if (!v) { topic.focus(); return; }
      _runAndPreview(ctx, anchorBtn, ACTIONS[0], v);
    };
    gen.addEventListener('click', (e) => { e.preventDefault(); submit(); });
    topic.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); submit(); } });
    _portal(panel, anchorBtn);
    setTimeout(() => topic.focus(), 0);
  }

  // ── Run an action and show the result preview panel ──
  async function _runAndPreview(ctx, anchorBtn, actionDef, prompt) {
    const t = _deps.t;

    // Refine actions need draft text.
    const draft = ctx.getText();
    if (!actionDef.write && !draft.trim()) {
      _deps.showToast(t('scribeEmptyDraft'));
      return;
    }

    const panel = document.createElement('div');
    panel.className = 'scribe-panel';
    _setHtml(panel,
      '<div class="scribe-panel-head"><span class="scribe-panel-title">' + SPARKLE_SVG +
      '<span>' + _esc(t(actionDef.label)) + '</span></span>' +
      '<button type="button" class="scribe-x" aria-label="' + _esc(t('scribeDiscard')) + '">' + _icon('M4.3 3.3L8 7l3.7-3.7 1 1L9 8l3.7 3.7-1 1L8 9l-3.7 3.7-1-1L7 8 3.3 4.3z', 12) + '</button></div>' +
      '<div class="scribe-result" aria-live="polite">' +
      '<div class="scribe-writing"><span class="scribe-dot"></span><span class="scribe-dot"></span><span class="scribe-dot"></span>' +
      '<span class="scribe-writing-label">' + _esc(t('scribeWriting')) + '</span></div></div>' +
      '<div class="scribe-panel-foot scribe-foot-actions hidden">' +
      '<button type="button" class="scribe-btn-ghost scribe-discard">' + _esc(t('scribeDiscard')) + '</button>' +
      '<button type="button" class="scribe-btn-ghost scribe-insert">' + _esc(t('scribeInsert')) + '</button>' +
      '<button type="button" class="scribe-btn-primary scribe-replace">' + _esc(t('scribeReplace')) + '</button>' +
      '</div>');
    panel.querySelector('.scribe-x').addEventListener('click', (e) => { e.preventDefault(); closeOpen(); });
    _portal(panel, anchorBtn);

    const resultEl = panel.querySelector('.scribe-result');
    const footEl = panel.querySelector('.scribe-foot-actions');

    let res;
    try {
      res = await _deps.sendMessage({
        type: 'AI_RUN_ACTION',
        accountId: ctx.accountId,
        action: actionDef.action,
        text: draft,
        prompt: prompt || '',
        recipient: ctx.recipient || '',
        sender: ctx.sender || '',
        locale: ctx.locale || '',
      });
    } catch (e) {
      res = { ok: false, error: 'GENERATION_FAIL' };
    }
    if (_openEl !== panel) return; // user closed/changed while waiting

    if (!res || !res.ok) {
      if (res && res.error === 'ABORTED') { closeOpen(); return; } // user cancelled, no error UI
      _renderError(resultEl, res || {}, t);
      return;
    }

    const text = res.result || '';
    resultEl.textContent = '';
    const pre = document.createElement('div');
    pre.className = 'scribe-result-text';
    pre.textContent = text;
    resultEl.appendChild(pre);
    PopupEditorToolbar.positionPopup(panel, anchorBtn); // grew: re-anchor

    footEl.classList.remove('hidden');
    panel.querySelector('.scribe-discard').addEventListener('click', (e) => { e.preventDefault(); closeOpen(); });
    panel.querySelector('.scribe-insert').addEventListener('click', (e) => {
      e.preventDefault();
      ctx.insert(text);
      closeOpen();
      _deps.showToast(t('scribeInserted'));
    });
    panel.querySelector('.scribe-replace').addEventListener('click', (e) => {
      e.preventDefault();
      const prior = ctx.snapshot();
      ctx.replace(text);
      closeOpen();
      _deps.showToast(t('scribeReplaced'), () => ctx.restore(prior));
    });
  }

  function _renderError(resultEl, res, t) {
    let msg;
    switch (res.error) {
      case 'NO_ENTITLEMENT': msg = t('scribeNeedsScribe'); break;
      case 'DEVICE_MODE': msg = t('scribeDeviceMode'); break;
      case 'APP_VERSION':
      case 'OFF':
      case 'TIMEOUT': msg = t('scribeUnavailable'); break;
      case 'RATE_LIMITED': msg = res.retryAfterSec ? t('scribeRateLimitedSec', res.retryAfterSec) : t('scribeRateLimited'); break;
      case 'HARMFUL':
      case 'REJECTED': msg = t('scribeHarmful'); break;
      case 'TOO_LONG': msg = t('scribeTooLong'); break;
      default: msg = t('scribeFailed');
    }
    _setHtml(resultEl, '<div class="scribe-error">' +
      _icon('M8 1.5A6.5 6.5 0 1 0 8 14.5 6.5 6.5 0 0 0 8 1.5zM7.25 4.5h1.5v5h-1.5v-5zM8 12a1 1 0 1 1 0-2 1 1 0 0 1 0 2z', 18) +
      '<span>' + _esc(msg) + '</span></div>');
  }

  // ── Public API ──

  /** One-time global wiring. deps: { sendMessage, showToast, t, isPremium, setHTML } */
  function init(deps) { _deps = deps; }

  /**
   * Refresh a Scribe trigger button for the given editor context.
   * Decides visibility from capability and stores the ctx for click handling.
   * ctx: { accountId, recipient, sender, locale, isHtml,
   *        getText, replace, insert, snapshot, restore }
   */
  async function update(buttonEl, ctx) {
    if (!buttonEl) return;
    // Premium gate first (cheap, local).
    if (!_deps.isPremium()) { buttonEl.classList.add('hidden'); return; }
    if (!ctx || !ctx.accountId) { buttonEl.classList.add('hidden'); return; }

    // Wire the click once.
    if (!buttonEl._scribeWired) {
      buttonEl._scribeWired = true;
      _setHtml(buttonEl, SPARKLE_SVG);
      buttonEl.classList.add('scribe-trigger');
      buttonEl.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const cur = buttonEl._scribeCtx;
        if (!cur) return;
        const wasOpen = !!_openEl;
        closeOpen();
        if (wasOpen) return;
        _portal(_buildMenu(cur, buttonEl), buttonEl);
      });
    }
    buttonEl._scribeCtx = ctx;

    let cap;
    try { cap = await _deps.sendMessage({ type: 'AI_CAPABILITY', accountId: ctx.accountId }); }
    catch (e) { cap = { available: false, reason: 'error' }; }

    if (cap && cap.available) {
      buttonEl.classList.remove('hidden');
      buttonEl.title = _deps.t('scribe');
    } else if (cap && cap.reason === 'no-entitlement') {
      // Discoverable: show, but clicking explains it needs Proton Scribe.
      buttonEl.classList.remove('hidden');
      buttonEl.title = _deps.t('scribeNeedsScribe');
      buttonEl._scribeCtx = { ...ctx, _locked: 'NO_ENTITLEMENT' };
      _rewireLocked(buttonEl);
    } else {
      // device-mode / off / error → hide (respect the user's "Run on device" choice).
      buttonEl.classList.add('hidden');
      if (cap && cap.reason === 'device-mode' && !_deviceNoteShown) {
        _deviceNoteShown = true;
        _deps.showToast(_deps.t('scribeDeviceMode'));
      }
    }
  }

  // When locked (no entitlement), the trigger shows the upsell instead of the menu.
  function _rewireLocked(buttonEl) {
    if (buttonEl._scribeLockedWired) return;
    buttonEl._scribeLockedWired = true;
    buttonEl.addEventListener('click', (e) => {
      if (buttonEl._scribeCtx && buttonEl._scribeCtx._locked) {
        e.preventDefault();
        e.stopPropagation();
        closeOpen();
        _deps.showToast(_deps.t('scribeNeedsScribe'));
      }
    }, true);
  }

  return { init, update, close: closeOpen };
})();
