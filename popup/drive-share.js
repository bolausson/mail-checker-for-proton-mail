/**
 * PopupDriveShare: premium "Share via Proton Drive" control for the compose
 * and reply/forward editors.
 *
 * Mounted once per send surface (like PopupSendOptions). Injects a cloud
 * toolbar button that opens an options panel: Viewer/Editor permission, link
 * expiration (presets or a custom date, max 90 days: Proton Drive's limit)
 * and an optional custom link password (max 50 characters, also Drive's
 * limit). "Choose files…" hands the resolved options to the caller
 * (popup.js), which starts the background upload job and opens the
 * file-picker tab; the share links are inserted into the draft when the
 * popup reopens.
 *
 * Defaults come from the extension settings (driveDefaultPermission,
 * driveDefaultExpirationDays, driveDefaultFolder); panel state is sticky per
 * draft via getValues()/setValues() (persisted in the encrypted draft).
 *
 * Panels are portaled to <body> through PopupEditorToolbar's registry, so Esc
 * and outside-click dismiss them (same plumbing as PopupSendOptions).
 */
const PopupDriveShare = (() => {
  const ET = (typeof PopupEditorToolbar !== 'undefined') ? PopupEditorToolbar : null;
  const SO = (typeof PopupSendOptions !== 'undefined') ? PopupSendOptions : null;
  const t = (k, ...a) => (typeof ProtonI18n !== 'undefined' ? ProtonI18n.t(k, ...a) : k);

  const EXPIRY_PRESETS = [1, 7, 15, 30, 60, 90]; // days (Drive UI max is 90)
  const MAX_DAYS = 90;
  const MAX_PASSWORD_LEN = 50; // MAX_SHARED_URL_PASSWORD_LENGTH; drive.js enforces it too

  // NOTE: the xmlns attribute is REQUIRED. _svg() parses these as strict XML
  // (see the same note in send-options.js).
  const CLOUD_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4.5 12.5a3 3 0 0 1-.4-5.97 4 4 0 0 1 7.8-.03 2.75 2.75 0 0 1-.4 5.99"/><path d="M8 13.5V8.2M5.9 10.2 8 8l2.1 2.2"/></svg>';
  const EYE_SVG = '<svg xmlns="http://www.w3.org/2000/svg" class="password-toggle-eye" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>';
  const EYE_OFF_SVG = '<svg xmlns="http://www.w3.org/2000/svg" class="password-toggle-eye-off" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M17.94 17.94A10.94 10.94 0 0 1 12 20c-7 0-11-8-11-8a19.77 19.77 0 0 1 5.06-5.94M9.9 4.24A10.94 10.94 0 0 1 12 4c7 0 11 8 11 8a19.77 19.77 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>';

  function _el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }
  function _svg(svgString) {
    const doc = new DOMParser().parseFromString(svgString, 'image/svg+xml');
    return document.importNode(doc.documentElement, true);
  }
  function _header(text) {
    const h = _el('div', 'dropdown-header');
    h.appendChild(_el('span', null, text));
    return h;
  }
  // Whitespace-only means "no password" (as in drive.js), whatever its length.
  function _passwordTooLong(pw) {
    return !!pw && !!pw.trim() && pw.length > MAX_PASSWORD_LEN;
  }

  // Portal a panel using the shared editor-toolbar registry (send-options.js).
  function _openPortal(panel, anchorBtn, onClose) {
    if (!ET) return () => {};
    document.body.appendChild(panel);
    panel.classList.add('open');
    ET.positionPopup(panel, anchorBtn);
    const reposition = () => ET.positionPopup(panel, anchorBtn);
    window.addEventListener('resize', reposition);
    window.addEventListener('scroll', reposition, true);
    const entry = { close };
    function close() {
      window.removeEventListener('resize', reposition);
      window.removeEventListener('scroll', reposition, true);
      ET.unregisterPopup(entry);
      document.removeEventListener('click', onDocClick, true);
      if (panel.parentNode) panel.remove();
      if (onClose) onClose();
    }
    function onDocClick(e) {
      if (!panel.contains(e.target) && !anchorBtn.contains(e.target)) close();
    }
    setTimeout(() => document.addEventListener('click', onDocClick, true), 0);
    ET.registerPopup(entry);
    return close;
  }

  /**
   * Mount the control onto a surface.
   * @param {object} config
   *   - toolbar:        editor toolbar element (cloud-button fallback placement)
   *   - insertAfter:    element the cloud button is placed after (the attach
   *                     button; falls back to appending to toolbar)
   *   - requirePremium: (feature) => boolean (gate; false aborts opening)
   *   - showToast:      (msg) => void
   *   - getSettings:    () => settings object (drive defaults)
   *   - onChooseFiles:  (options) => void, { permission, expirationDays, customPassword }
   * @returns {{ getValues, setValues, reset, destroy }}
   */
  function mount(config) {
    // null = "use the settings default at open time"
    const state = { permission: null, expirationDays: null, customPassword: '' };
    const requirePremium = config.requirePremium || (() => true);
    const showToast = config.showToast || (() => {});
    const getSettings = config.getSettings || (() => ({}));

    const btn = _el('button', 'editor-btn drive-share-btn');
    btn.type = 'button';
    btn.appendChild(_svg(CLOUD_SVG));
    btn.title = t('driveShare');
    // Anchored placement: directly after config.insertAfter (the paperclip).
    // PopupSendOptions mounted its hourglass there first, so inserting here
    // yields the toolbar order: attach, drive-share, expiring-message.
    if (config.insertAfter && config.insertAfter.parentNode) {
      config.insertAfter.parentNode.insertBefore(btn, config.insertAfter.nextSibling);
    } else if (config.toolbar) {
      config.toolbar.appendChild(btn);
    }

    let closePanel = null;

    function _defaults() {
      const s = getSettings() || {};
      return {
        permission: state.permission ||
          (s.driveDefaultPermission === 'editor' ? 'editor' : 'viewer'),
        expirationDays: state.expirationDays !== null && state.expirationDays !== undefined
          ? state.expirationDays
          : (typeof s.driveDefaultExpirationDays === 'number' ? s.driveDefaultExpirationDays : 30),
        customPassword: state.customPassword || '',
      };
    }

    function _openPanel() {
      if (closePanel) { closePanel(); closePanel = null; return; }
      if (ET) ET.closeAllPopups();
      if (!requirePremium('driveShare')) return;

      const def = _defaults();
      const panel = _el('div', 'dropdown-menu send-options-panel drive-share-panel');
      panel.appendChild(_header(t('driveShareTitle')));
      panel.appendChild(_el('p', 'send-options-hint', t('driveShareHint')));

      // --- permission (segmented Viewer | Editor) ---
      panel.appendChild(_el('div', 'drive-share-label', t('drivePermission')));
      const segRow = _el('div', 'drive-share-seg');
      const viewerBtn = _el('button', 'drive-share-seg-btn', t('driveViewer'));
      const editorBtn = _el('button', 'drive-share-seg-btn', t('driveEditor'));
      viewerBtn.type = 'button'; editorBtn.type = 'button';
      let permission = def.permission;
      function syncSeg() {
        viewerBtn.classList.toggle('active', permission === 'viewer');
        editorBtn.classList.toggle('active', permission === 'editor');
      }
      viewerBtn.addEventListener('click', (e) => { e.stopPropagation(); permission = 'viewer'; syncSeg(); });
      editorBtn.addEventListener('click', (e) => { e.stopPropagation(); permission = 'editor'; syncSeg(); });
      syncSeg();
      segRow.append(viewerBtn, editorBtn);
      panel.appendChild(segRow);

      // --- expiration (presets + never + custom date) ---
      panel.appendChild(_el('div', 'drive-share-label', t('driveExpiration')));
      const expSelect = _el('select', 'send-options-input drive-share-select');
      for (const d of EXPIRY_PRESETS) {
        const opt = _el('option', null, t('driveDaysUnit', String(d)));
        opt.value = String(d);
        expSelect.appendChild(opt);
      }
      const optNever = _el('option', null, t('driveNoExpiry'));
      optNever.value = '0';
      expSelect.appendChild(optNever);
      const optCustom = _el('option', null, t('driveCustomDate') + '…');
      optCustom.value = 'custom';
      expSelect.appendChild(optCustom);
      panel.appendChild(expSelect);

      // Custom-date row (shared in-document calendar from PopupSendOptions)
      let datePicker = null;
      const dateRow = _el('div', 'send-options-row hidden');
      if (SO && SO.makeDatePicker) {
        const initDays = (typeof def.expirationDays === 'number' && def.expirationDays > 0)
          ? Math.min(def.expirationDays, MAX_DAYS) : 30;
        datePicker = SO.makeDatePicker(
          new Date(Date.now() + initDays * 24 * 3600 * 1000),
          new Date(Date.now() + 24 * 3600 * 1000), // custom expiry ≥ tomorrow
          () => { if (ET) ET.positionPopup(panel, btn); });
        dateRow.appendChild(datePicker.field);
        panel.appendChild(dateRow);
        panel.appendChild(datePicker.cal);
        datePicker.cal.classList.add('hidden');
      }

      // Preselect: preset match → preset; 0 → never; anything else → custom.
      const dv = def.expirationDays;
      if (dv === 0) expSelect.value = '0';
      else if (EXPIRY_PRESETS.includes(dv)) expSelect.value = String(dv);
      else if (datePicker) { expSelect.value = 'custom'; dateRow.classList.remove('hidden'); }
      else expSelect.value = '30';

      expSelect.addEventListener('change', () => {
        dateRow.classList.toggle('hidden', expSelect.value !== 'custom');
        if (datePicker) datePicker.cal.classList.add('hidden');
        if (ET) ET.positionPopup(panel, btn);
      });

      // --- optional custom password ---
      panel.appendChild(_el('div', 'drive-share-label', t('driveCustomPassword')));
      const pwWrap = _el('div', 'password-wrap');
      const pwInput = _el('input', 'send-options-input drive-share-pw');
      pwInput.type = 'password';
      pwInput.placeholder = t('driveCustomPasswordPlaceholder');
      pwInput.value = def.customPassword;
      // Show/hide handled by popup.js's delegated .password-toggle listener.
      const pwToggle = _el('button', 'password-toggle');
      pwToggle.type = 'button';
      pwToggle.tabIndex = -1;
      pwToggle.title = t('showPassword');
      pwToggle.setAttribute('aria-label', t('showPassword'));
      pwToggle.appendChild(_svg(EYE_SVG));
      pwToggle.appendChild(_svg(EYE_OFF_SVG));
      pwWrap.append(pwInput, pwToggle);
      panel.appendChild(pwWrap);
      // No maxLength: the browser would silently cut a longer paste or drop,
      // and the masked field hides that, so recipients would be given a
      // password the link does not have. Like Drive's own sharing UI, take
      // any length and say so here while it is too long; Choose files refuses.
      const pwTooLong = _el('p', 'send-options-hint drive-share-pw-error hidden', t('drivePasswordTooLong'));
      // Returns whether the message came or went.
      const syncPasswordLimit = () => {
        const over = _passwordTooLong(pwInput.value);
        const shown = !pwTooLong.classList.contains('hidden');
        if (over === shown) return false;
        pwTooLong.classList.toggle('hidden', !over);
        if (over) pwInput.setAttribute('aria-invalid', 'true');
        else pwInput.removeAttribute('aria-invalid');
        return true;
      };
      pwInput.addEventListener('input', () => {
        // The message changes the panel's height: re-anchor, as the date row does.
        if (syncPasswordLimit() && ET) ET.positionPopup(panel, btn);
      });
      syncPasswordLimit(); // a value restored from a saved draft can be too long already
      panel.appendChild(pwTooLong);
      panel.appendChild(_el('p', 'send-options-hint', t('drivePasswordHint')));

      // --- action ---
      const actions = _el('div', 'send-options-actions');
      const chooseBtn = _el('button', 'btn-primary btn-small', t('driveChooseFiles'));
      chooseBtn.type = 'button';
      actions.appendChild(chooseBtn);
      panel.appendChild(actions);

      const close = _openPortal(panel, btn, () => { closePanel = null; });
      closePanel = close;

      chooseBtn.addEventListener('click', () => {
        let days;
        if (expSelect.value === 'custom' && datePicker) {
          const secs = Math.floor(datePicker.getDate().getTime() / 1000) -
            Math.floor(Date.now() / 1000);
          days = secs / 86400;
          if (days <= 0) { showToast(t('deliveryTimeInvalid')); return; }
          if (days > MAX_DAYS) { showToast(t('driveExpiryTooLong')); return; }
        } else {
          days = Number(expSelect.value) || 0;
        }
        // The field takes any length (see above), so this is where a longer
        // password, typed, pasted or restored from a saved draft, stops.
        if (_passwordTooLong(pwInput.value)) { showToast(t('drivePasswordTooLong')); return; }
        state.permission = permission;
        state.expirationDays = days;
        state.customPassword = pwInput.value || '';
        close();
        if (config.onChooseFiles) {
          config.onChooseFiles({
            permission: state.permission,
            expirationDays: state.expirationDays,
            customPassword: state.customPassword,
          });
        }
      });
    }

    btn.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); _openPanel(); });

    function getValues() {
      return {
        permission: state.permission,
        expirationDays: state.expirationDays,
        customPassword: state.customPassword || '',
      };
    }
    function setValues(v) {
      v = v || {};
      state.permission = v.permission || null;
      state.expirationDays = (typeof v.expirationDays === 'number') ? v.expirationDays : null;
      state.customPassword = v.customPassword || '';
    }
    function reset() {
      state.permission = null;
      state.expirationDays = null;
      state.customPassword = '';
      if (closePanel) { closePanel(); closePanel = null; }
    }
    function destroy() {
      reset();
      btn.remove();
    }

    return { getValues, setValues, reset, destroy };
  }

  return { mount };
})();

if (typeof window !== 'undefined') window.PopupDriveShare = PopupDriveShare;
