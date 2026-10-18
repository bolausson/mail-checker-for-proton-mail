/**
 * PopupSendOptions: premium "Schedule send" + "Expiring message" (incl. Encrypted
 * Outside) controls for the compose and reply/forward editors.
 *
 * Mounted once per send surface. Each instance owns:
 *   - a Send split-button caret that opens a schedule menu (presets + custom
 *     date/time), and
 *   - an hourglass toggle that opens an expiry panel (date/time + an optional
 *     "non-Proton recipient" password = Encrypted Outside).
 * It holds the chosen options as sticky state and renders a small summary chip;
 * the surface's existing Send button reads getValues() and threads
 * { deliveryTime, expiresIn, eoPassword, eoHint } into its send message.
 *
 * Pickers/menus are portaled to <body> and share PopupEditorToolbar's registry
 * (positionPopup / registerPopup / unregisterPopup / closeAllPopups), so Esc and
 * outside-click close them and they're dismissed when the panel closes.
 *
 * All three options are premium: opening either control calls the caller's
 * requirePremium(feature) gate first (compose/reply are already premium, so this
 * is per-feature upsell + defence in depth).
 */
const PopupSendOptions = (() => {
  const ET = (typeof PopupEditorToolbar !== 'undefined') ? PopupEditorToolbar : null;
  const t = (k) => (typeof ProtonI18n !== 'undefined' ? ProtonI18n.t(k) : k);
  let _toast = (_m) => {};   // set from mount config (popup.js showToast)
  let _use24 = false;        // 24-hour time preference, set from mount config

  // Proton limits (mirror the backend guard): schedule 2 min .. 90 days; expiry <= 730 days.
  const SCHED_MIN_S = 120;
  const SCHED_MAX_S = 90 * 24 * 3600;
  const EXPIRE_MIN_S = 30 * 60;          // 30 min: Proton rejects sooner expirations ("too soon")
  const EXPIRE_MAX_S = 28 * 24 * 3600;   // 28 days: Proton's MAX_EXPIRATION_TIME (672h)
  const EO_PW_MIN = 8;                   // Proton's MIN_PASSWORD_LENGTH for Encrypted Outside

  // NOTE: the xmlns attribute is REQUIRED. _svg() parses these as strict XML
  // ('image/svg+xml'), where an svg element without an explicit namespace is
  // not an SVG at all and renders as nothing (the HTML parser auto-namespaces,
  // the XML parser does not).
  const CARET_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M4 6l4 4 4-4z"/></svg>';
  const HOURGLASS_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true"><path d="M4 2h8M4 14h8M5 2c0 3 6 3 6 6s-6 3-6 6M11 2c0 3-6 3-6 6s6 3 6 6"/></svg>';
  const CLOSE_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>';
  const EYE_SVG = '<svg xmlns="http://www.w3.org/2000/svg" class="password-toggle-eye" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>';
  const EYE_OFF_SVG = '<svg xmlns="http://www.w3.org/2000/svg" class="password-toggle-eye-off" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M17.94 17.94A10.94 10.94 0 0 1 12 20c-7 0-11-8-11-8a19.77 19.77 0 0 1 5.06-5.94M9.9 4.24A10.94 10.94 0 0 1 12 4c7 0 11 8 11 8a19.77 19.77 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>';

  // --- date helpers (all return Unix SECONDS) ---
  function _todayAt(addDays, hour) {
    const d = new Date();
    d.setDate(d.getDate() + addDays);
    d.setHours(hour, 0, 0, 0);
    return Math.floor(d.getTime() / 1000);
  }
  function _nextMorning() {
    // 8:00 today if it's still before 8, else 8:00 tomorrow.
    return _todayAt(new Date().getHours() < 8 ? 0 : 1, 8);
  }
  function _nextMonday() {
    const d = new Date();
    const day = d.getDay(); // 0 Sun .. 6 Sat
    const delta = ((8 - day) % 7) || 7; // days until next Monday (never today)
    return _todayAt(delta, 8);
  }
  function _fmt(unixSec) {
    try {
      const d = new Date(unixSec * 1000);
      const use24 = _use24;
      return d.toLocaleString([], {
        weekday: 'short', day: 'numeric', month: 'short',
        hour: '2-digit', minute: '2-digit', hour12: !use24,
      });
    } catch (_) { return ''; }
  }
  function _pad(n) { return String(n).padStart(2, '0'); }
  function _timeInputValue(d) { return _pad(d.getHours()) + ':' + _pad(d.getMinutes()); }

  function _el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }
  // Parse a STATIC inline SVG icon into a DOM node: avoids innerHTML (CSP-safe and
  // keeps addons-linter clean; the strings are module constants, never user input).
  function _svg(svgString) {
    const doc = new DOMParser().parseFromString(svgString, 'image/svg+xml');
    return document.importNode(doc.documentElement, true);
  }
  // A .dropdown-header containing a <span> label (replaces an innerHTML string).
  function _header(text) {
    const h = _el('div', 'dropdown-header');
    h.appendChild(_el('span', null, text));
    return h;
  }
  // A .dropdown-item button with a label (+ optional right-aligned hint).
  function _menuItem(label, hint) {
    const item = _el('button', 'dropdown-item');
    item.type = 'button';
    item.appendChild(_el('span', 'dropdown-label', label));
    if (hint != null) item.appendChild(_el('span', 'dropdown-hint', hint));
    return item;
  }

  // Combine a Date (Y/M/D) with an <input type=time> value into Unix seconds (local TZ).
  function _combineDateAndTime(date, timeStr) {
    const [h, mi] = (timeStr || '00:00').split(':').map(Number);
    const d = new Date(date.getFullYear(), date.getMonth(), date.getDate(), h || 0, mi || 0, 0, 0);
    const sec = Math.floor(d.getTime() / 1000);
    return Number.isFinite(sec) ? sec : null;
  }

  // Localized Monday-first short weekday labels (Jan 1 2024 was a Monday).
  function _weekdays() {
    const out = [];
    for (let i = 0; i < 7; i++) out.push(new Date(2024, 0, 1 + i).toLocaleDateString([], { weekday: 'short' }));
    return out;
  }

  /**
   * A self-contained, in-document date picker. Native <input type=date> opens its
   * calendar in a separate layer that renders BEHIND extension popup windows in
   * Firefox, so we render our own DOM calendar (which layers correctly). Returns
   * { el, getDate }. Time is still a native <input type=time> (inline, no popup).
   */
  function _makeDatePicker(initialDate, minDate, onLayoutChange) {
    const sel = new Date(initialDate); sel.setHours(0, 0, 0, 0);
    const min = minDate ? new Date(minDate) : null; if (min) min.setHours(0, 0, 0, 0);
    let vy = sel.getFullYear(), vm = sel.getMonth();

    const field = _el('button', 'send-options-input so-date-field'); field.type = 'button';
    const cal = _el('div', 'so-cal hidden');

    function fmtField() {
      field.textContent = sel.toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' });
    }
    function render() {
      cal.replaceChildren();
      const head = _el('div', 'so-cal-head');
      const prev = _el('button', 'so-cal-nav', '‹'); prev.type = 'button';
      const next = _el('button', 'so-cal-nav', '›'); next.type = 'button';
      const title = _el('span', 'so-cal-title',
        new Date(vy, vm, 1).toLocaleDateString([], { month: 'long', year: 'numeric' }));
      prev.addEventListener('click', (e) => { e.stopPropagation(); vm--; if (vm < 0) { vm = 11; vy--; } render(); });
      next.addEventListener('click', (e) => { e.stopPropagation(); vm++; if (vm > 11) { vm = 0; vy++; } render(); });
      head.appendChild(prev); head.appendChild(title); head.appendChild(next);
      cal.appendChild(head);

      const grid = _el('div', 'so-cal-grid');
      for (const w of _weekdays()) grid.appendChild(_el('span', 'so-cal-wd', w));
      const offset = (new Date(vy, vm, 1).getDay() + 6) % 7; // Monday-first
      for (let i = 0; i < offset; i++) grid.appendChild(_el('span', 'so-cal-empty'));
      const days = new Date(vy, vm + 1, 0).getDate();
      for (let d = 1; d <= days; d++) {
        const cell = _el('button', 'so-cal-day'); cell.type = 'button'; cell.textContent = String(d);
        const cur = new Date(vy, vm, d);
        if (min && cur < min) { cell.disabled = true; cell.classList.add('disabled'); }
        if (cur.getFullYear() === sel.getFullYear() && cur.getMonth() === sel.getMonth() && cur.getDate() === sel.getDate()) {
          cell.classList.add('selected');
        }
        cell.addEventListener('click', (e) => {
          e.stopPropagation();
          sel.setFullYear(vy, vm, d);
          fmtField();
          cal.classList.add('hidden');
          if (onLayoutChange) onLayoutChange();
        });
        grid.appendChild(cell);
      }
      cal.appendChild(grid);
    }
    field.addEventListener('click', (e) => {
      e.stopPropagation();
      const willOpen = cal.classList.contains('hidden');
      cal.classList.toggle('hidden');
      if (willOpen) render();
      if (onLayoutChange) onLayoutChange();
    });
    fmtField();
    return { field, cal, getDate: () => new Date(sel) };
  }

  // Portal a panel using the shared editor-toolbar registry: position it under the
  // anchor, reposition on resize/scroll, close on outside-click + Esc.
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
    // defer so the opening click doesn't immediately close it
    setTimeout(() => document.addEventListener('click', onDocClick, true), 0);
    ET.registerPopup(entry);
    return close;
  }

  /**
   * Mount the controls onto a surface.
   * @param {object} config
   *   - sendBtn:     the surface's primary Send button (caret is injected after it)
   *   - toolbar:     the editor toolbar element (hourglass fallback placement)
   *   - insertAfter: element the hourglass is placed after (the attach button;
   *                  falls back to appending to toolbar)
   *   - summaryHost: element to append the summary chip into (defaults near sendBtn)
   *   - requirePremium: (feature) => boolean (gate; returns false to abort opening)
   * @returns {{ getValues, reset, destroy }}
   */
  function mount(config) {
    const state = { deliveryTime: null, expiresIn: null, eoPassword: '', eoHint: '' };
    const requirePremium = config.requirePremium || (() => true);
    if (config.showToast) _toast = config.showToast;
    _use24 = !!config.use24Hour;

    // --- caret (schedule) ---
    const caret = _el('button', 'icon-btn send-options-caret');
    caret.type = 'button';
    caret.appendChild(_svg(CARET_SVG));
    caret.title = t('scheduleSend');
    caret.setAttribute('aria-haspopup', 'menu');
    caret.setAttribute('aria-expanded', 'false');
    if (config.sendBtn && config.sendBtn.parentNode) {
      config.sendBtn.parentNode.insertBefore(caret, config.sendBtn.nextSibling);
    }

    // --- hourglass (expiry) ---
    const hourglass = _el('button', 'editor-btn send-options-expiry-btn');
    hourglass.type = 'button';
    hourglass.appendChild(_svg(HOURGLASS_SVG));
    hourglass.title = t('expiringMessage');
    // Anchored placement: directly after config.insertAfter (the paperclip);
    // PopupDriveShare later inserts its cloud button after the same anchor,
    // which lands it BETWEEN the two → final order: attach, drive, expiry.
    if (config.insertAfter && config.insertAfter.parentNode) {
      config.insertAfter.parentNode.insertBefore(hourglass, config.insertAfter.nextSibling);
    } else if (config.toolbar) {
      config.toolbar.appendChild(hourglass);
    }

    // --- summary chip host ---
    const summary = _el('div', 'send-options-summary hidden');
    const host = config.summaryHost || (config.sendBtn && config.sendBtn.parentNode);
    if (host) host.appendChild(summary);

    let closeMenu = null;
    let closeExpiry = null;

    function _renderSummary() {
      const parts = [];
      if (state.deliveryTime) {
        parts.push({ key: 'schedule', label: t('scheduledFor') + ' ' + _fmt(state.deliveryTime) });
      }
      if (state.expiresIn) {
        const when = _fmt(Math.floor(Date.now() / 1000) + state.expiresIn);
        parts.push({ key: 'expiry', label: (state.eoPassword ? '🔒 ' : '') + t('expiresOn') + ' ' + when });
      }
      summary.replaceChildren();
      if (parts.length === 0) { summary.classList.add('hidden'); }
      else {
        summary.classList.remove('hidden');
        for (const p of parts) {
          const chip = _el('span', 'send-options-chip');
          chip.appendChild(_el('span', 'send-options-chip-label', p.label));
          const x = _el('button', 'send-options-chip-clear');
          x.appendChild(_svg(CLOSE_SVG));
          x.type = 'button';
          x.title = t('clear');
          x.addEventListener('click', (e) => {
            e.stopPropagation();
            if (p.key === 'schedule') state.deliveryTime = null;
            else { state.expiresIn = null; state.eoPassword = ''; state.eoHint = ''; }
            _syncActive();
            _renderSummary();
          });
          chip.appendChild(x);
          summary.appendChild(chip);
        }
      }
    }
    function _syncActive() {
      caret.classList.toggle('active', !!state.deliveryTime);
      hourglass.classList.toggle('active', !!state.expiresIn);
    }

    // --- schedule menu ---
    function _openScheduleMenu() {
      if (closeMenu) { closeMenu(); closeMenu = null; return; }
      if (ET) ET.closeAllPopups();
      if (!requirePremium('scheduledSend')) return;

      const menu = _el('div', 'dropdown-menu send-options-menu');
      menu.appendChild(_header(t('scheduleSend')));

      const opts = [
        { label: t('sendInTheMorning'), at: _nextMorning() },
        { label: t('sendTomorrow'), at: _todayAt(1, 8) },
        { label: t('sendMonday'), at: _nextMonday() },
      ];
      for (const o of opts) {
        const item = _menuItem(o.label, _fmt(o.at));
        item.addEventListener('click', () => { _setSchedule(o.at); if (closeMenu) closeMenu(); });
        menu.appendChild(item);
      }

      const custom = _menuItem(t('sendCustom') + '…');
      custom.addEventListener('click', () => { if (closeMenu) closeMenu(); _openCustomSchedule(); });
      menu.appendChild(custom);

      if (state.deliveryTime) {
        menu.appendChild(_el('div', 'dropdown-divider'));
        const now = _menuItem(t('sendNow'));
        now.addEventListener('click', () => { state.deliveryTime = null; _syncActive(); _renderSummary(); if (closeMenu) closeMenu(); });
        menu.appendChild(now);
      }

      caret.setAttribute('aria-expanded', 'true');
      closeMenu = _openPortal(menu, caret, () => { closeMenu = null; caret.setAttribute('aria-expanded', 'false'); });
    }

    function _setSchedule(unixSec) {
      const now = Math.floor(Date.now() / 1000);
      if (unixSec < now + SCHED_MIN_S || unixSec > now + SCHED_MAX_S) {
        _toast(t('deliveryTimeInvalid'));
        return;
      }
      state.deliveryTime = unixSec;
      _syncActive();
      _renderSummary();
    }

    function _openCustomSchedule() {
      const panel = _el('div', 'dropdown-menu send-options-panel');
      const def = new Date(Date.now() + 3600 * 1000); // default +1h
      panel.appendChild(_header(t('sendCustom')));
      const row = _el('div', 'send-options-row');
      const datePicker = _makeDatePicker(def, new Date(), () => { if (ET) ET.positionPopup(panel, caret); });
      row.appendChild(datePicker.field);
      const timeInput = _el('input', 'send-options-input so-time');
      timeInput.type = 'time'; timeInput.value = _timeInputValue(def);
      row.appendChild(timeInput);
      panel.appendChild(row);
      panel.appendChild(datePicker.cal);
      const actions = _el('div', 'send-options-actions');
      const confirm = _el('button', 'btn-primary btn-small', t('schedule')); confirm.type = 'button';
      actions.appendChild(confirm);
      panel.appendChild(actions);

      const close = _openPortal(panel, caret, null);
      confirm.addEventListener('click', () => {
        const sec = _combineDateAndTime(datePicker.getDate(), timeInput.value);
        if (sec == null) return;
        _setSchedule(sec);
        close();
      });
    }

    // --- expiry / EO panel ---
    function _openExpiry() {
      if (closeExpiry) { closeExpiry(); closeExpiry = null; return; }
      if (ET) ET.closeAllPopups();
      if (!requirePremium('expiringMessage')) return;

      const panel = _el('div', 'dropdown-menu send-options-panel send-options-expiry');
      const def = new Date(Date.now() + 7 * 24 * 3600 * 1000); // default +7d
      const hasExpiry = !!state.expiresIn;
      const exp = hasExpiry ? new Date((Math.floor(Date.now() / 1000) + state.expiresIn) * 1000) : def;

      panel.appendChild(_header(t('expiringMessage')));
      panel.appendChild(_el('p', 'send-options-hint', t('setExpiryHint')));

      const row = _el('div', 'send-options-row');
      const datePicker = _makeDatePicker(exp, new Date(), () => { if (ET) ET.positionPopup(panel, hourglass); });
      row.appendChild(datePicker.field);
      const timeInput = _el('input', 'send-options-input so-etime');
      timeInput.type = 'time'; timeInput.value = _timeInputValue(exp);
      row.appendChild(timeInput);
      panel.appendChild(row);
      panel.appendChild(datePicker.cal);

      const eoLabel = _el('label', 'send-options-check');
      const eoCheck = _el('input', 'so-eo');
      eoCheck.type = 'checkbox';
      eoCheck.checked = !!state.eoPassword;
      eoLabel.appendChild(eoCheck);
      eoLabel.appendChild(document.createTextNode(' '));
      eoLabel.appendChild(_el('span', null, t('sendingToNonProton')));
      panel.appendChild(eoLabel);

      const eoFields = _el('div', 'so-eo-fields' + (state.eoPassword ? '' : ' hidden'));
      const eoPwInput = _el('input', 'send-options-input so-eo-pw');
      eoPwInput.type = 'password';
      eoPwInput.placeholder = t('eoPassword');
      eoPwInput.value = state.eoPassword || '';
      // Same show/hide affordance as the login password fields: the button's
      // click is handled by popup.js's delegated .password-toggle listener,
      // which finds the sibling input via the .password-wrap parent.
      const eoPwWrap = _el('div', 'password-wrap');
      const eoPwToggle = _el('button', 'password-toggle');
      eoPwToggle.type = 'button';
      eoPwToggle.tabIndex = -1;
      eoPwToggle.title = t('showPassword');
      eoPwToggle.setAttribute('aria-label', t('showPassword'));
      eoPwToggle.appendChild(_svg(EYE_SVG));
      eoPwToggle.appendChild(_svg(EYE_OFF_SVG));
      eoPwWrap.appendChild(eoPwInput);
      eoPwWrap.appendChild(eoPwToggle);
      const eoHintInput = _el('input', 'send-options-input so-eo-hint');
      eoHintInput.type = 'text';
      eoHintInput.placeholder = t('eoHint');
      eoHintInput.value = state.eoHint || '';
      eoFields.appendChild(eoPwWrap);
      eoFields.appendChild(eoHintInput);
      panel.appendChild(eoFields);

      const actions = _el('div', 'send-options-actions');
      let clearBtn = null;
      if (hasExpiry) { clearBtn = _el('button', 'btn-secondary btn-small', t('clear')); clearBtn.type = 'button'; actions.appendChild(clearBtn); }
      const setBtn = _el('button', 'btn-primary btn-small', t('setExpiry')); setBtn.type = 'button';
      actions.appendChild(setBtn);
      panel.appendChild(actions);

      const close = _openPortal(panel, hourglass, () => { closeExpiry = null; });
      closeExpiry = close;

      eoCheck.addEventListener('change', () => {
        eoFields.classList.toggle('hidden', !eoCheck.checked);
        if (eoCheck.checked) eoPwInput.focus();
        if (ET) ET.positionPopup(panel, hourglass);
      });
      setBtn.addEventListener('click', () => {
        const when = _combineDateAndTime(datePicker.getDate(), timeInput.value);
        const nowSec = Math.floor(Date.now() / 1000);
        if (when == null) { _toast(t('deliveryTimeInvalid')); return; }
        const secs = when - nowSec;
        if (secs < EXPIRE_MIN_S) { _toast(t('expiryTooSoon')); return; }
        if (secs > EXPIRE_MAX_S) { _toast(t('expiryTooLong')); return; }
        const eoOn = eoCheck.checked;
        const pw = eoOn ? (eoPwInput.value || '') : '';
        if (eoOn && !pw) { _toast(t('expiryRequiresPassword')); return; }
        if (eoOn && pw.length < EO_PW_MIN) { _toast(t('eoPasswordTooShort')); return; }
        state.expiresIn = secs;
        state.eoPassword = pw;
        state.eoHint = eoOn ? (eoHintInput.value || '') : '';
        _syncActive();
        _renderSummary();
        close();
      });
      if (clearBtn) clearBtn.addEventListener('click', () => {
        state.expiresIn = null; state.eoPassword = ''; state.eoHint = '';
        _syncActive(); _renderSummary(); close();
      });
    }

    caret.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); _openScheduleMenu(); });
    hourglass.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); _openExpiry(); });

    function getValues() {
      return {
        deliveryTime: state.deliveryTime || null,
        expiresIn: state.expiresIn || null,
        eoPassword: state.eoPassword || '',
        eoHint: state.eoHint || '',
      };
    }
    function setValues(v) {
      v = v || {};
      state.deliveryTime = v.deliveryTime || null;
      state.expiresIn = v.expiresIn || null;
      state.eoPassword = v.eoPassword || '';
      state.eoHint = v.eoHint || '';
      _syncActive();
      _renderSummary();
    }
    function reset() {
      state.deliveryTime = null; state.expiresIn = null; state.eoPassword = ''; state.eoHint = '';
      if (closeMenu) { closeMenu(); closeMenu = null; }
      if (closeExpiry) { closeExpiry(); closeExpiry = null; }
      _syncActive();
      _renderSummary();
    }
    function destroy() {
      reset();
      caret.remove(); hourglass.remove(); summary.remove();
    }

    return { getValues, setValues, reset, destroy };
  }

  // makeDatePicker is shared with PopupDriveShare (same in-document calendar,
  // for the same reason: native date inputs render behind FF popup windows).
  return { mount, makeDatePicker: _makeDatePicker };
})();

if (typeof window !== 'undefined') window.PopupSendOptions = PopupSendOptions;
