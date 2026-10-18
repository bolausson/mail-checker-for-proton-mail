/**
 * In-page modal dialogs, replacing window.confirm() and window.prompt().
 *
 * Chrome ignores the native JS dialogs inside extension pages: the call returns
 * immediately, confirm() yielding false and prompt() yielding null, with no
 * dialog ever shown. Firefox still displays them. Every confirm() in this
 * extension therefore did nothing at all in Chrome, and the two guards that ask
 * before discarding a draft did worse than nothing, because a hard false meant
 * the reply and compose editors could not be closed at all.
 *
 * These replacements are ordinary DOM, so they behave the same in both
 * browsers. They are promise-based rather than blocking, which is the one
 * behavioural difference callers must respect: every call site awaits.
 *
 * Used by popup/, options/ and popup/editor-toolbar.js. Any page that loads
 * this script MUST also link lib/dialog.css, which leans on the host page's own
 * CSS variables so dark mode follows it for free. The styles were injected from
 * here at first; a linked stylesheet cannot half-apply and leave a working but
 * unreadable dialog dumped at the foot of the page.
 */

const ProtonDialog = (function () {
  'use strict';

  function _t(key, fallback) {
    if (typeof ProtonI18n === 'undefined') return fallback;
    const s = ProtonI18n.t(key);
    // ProtonI18n returns the key itself when a string is missing.
    return (!s || s === key) ? fallback : s;
  }

  // One dialog at a time. Two overlapping modals would fight over the focus
  // trap and the Escape handler, and a caller awaiting the first would see the
  // second one's answer.
  //
  // The first dialog opens synchronously; only a second one that arrives while
  // it is still up has to wait. Chaining unconditionally through a promise
  // would have delayed every dialog by a microtask, which is invisible to a
  // user but means a caller cannot rely on the dialog existing once the call
  // has returned.
  let _busy = false;
  const _pending = [];

  function _drain() {
    const job = _pending.shift();
    if (!job) { _busy = false; return; }
    _start(job.open).then(job.resolve, job.reject);
  }

  function _start(open) {
    let run;
    try {
      run = open();
    } catch (err) {
      // A synchronous failure must still release the queue, or every later
      // dialog in the session waits forever on a modal that never opened.
      _drain();
      return Promise.reject(err);
    }
    return run.then(
      (v) => { _drain(); return v; },
      (e) => { _drain(); throw e; }
    );
  }

  function _queue(open) {
    if (!_busy) {
      _busy = true;
      return _start(open);
    }
    return new Promise((resolve, reject) => _pending.push({ open, resolve, reject }));
  }

  const GAP = 8;   // between the anchor and the box
  const EDGE = 8;  // minimum breathing room against the window edges

  /**
   * Put the box just below `anchor`, flipping above it when there is no room,
   * and keep it fully on screen either way. Both are measured in viewport
   * coordinates, which is what the fixed backdrop establishes.
   */
  function _placeUnder(box, anchor) {
    const a = anchor.getBoundingClientRect();
    const w = box.offsetWidth;
    const h = box.offsetHeight;
    const vw = document.documentElement.clientWidth;
    const vh = document.documentElement.clientHeight;

    // Prefer below; flip above only if below overflows and above genuinely fits.
    let top = a.bottom + GAP;
    if (top + h > vh - EDGE && a.top - GAP - h >= EDGE) top = a.top - GAP - h;
    top = Math.max(EDGE, Math.min(top, Math.max(EDGE, vh - h - EDGE)));

    // Left-align with the anchor, pulled back inside the window if it would
    // hang off the right edge.
    let left = a.left;
    left = Math.max(EDGE, Math.min(left, Math.max(EDGE, vw - w - EDGE)));

    box.style.top = Math.round(top) + 'px';
    box.style.left = Math.round(left) + 'px';
  }

  /**
   * Build and show a modal, resolving with the caller's chosen result.
   *
   * @param {object} cfg
   * @param {string} cfg.message      Body text (rendered as text, never HTML).
   * @param {string} cfg.confirmLabel Label of the affirmative button.
   * @param {string} cfg.cancelLabel  Label of the dismissive button.
   * @param {boolean} cfg.danger      Style the affirmative button as destructive.
   * @param {boolean} cfg.withInput   Render a text field and resolve its value.
   * @param {string} cfg.value        Initial value of that field.
   * @param {string} cfg.placeholder  Placeholder for that field.
   * @param {*} cfg.cancelValue       What a dismissal resolves to.
   * @param {Element} cfg.anchor      Place it under this element, not centred.
   * @returns {Promise<*>}
   */
  function _show(cfg) {
    return new Promise((resolve) => {
      const previouslyFocused = document.activeElement;
      const backdrop = document.createElement('div');
      backdrop.className = 'pd-backdrop';

      const box = document.createElement('div');
      box.className = 'pd-box';
      box.setAttribute('role', cfg.withInput ? 'dialog' : 'alertdialog');
      box.setAttribute('aria-modal', 'true');

      const msg = document.createElement('p');
      msg.className = 'pd-message';
      msg.textContent = cfg.message;
      box.appendChild(msg);
      // Name the dialog by its own message; there is no separate title.
      msg.id = 'pd-message-' + Math.random().toString(36).slice(2, 10);
      box.setAttribute('aria-labelledby', msg.id);

      // One text field per entry in cfg.fields. prompt() passes a single
      // unnamed field and gets a bare string back; form() names them and gets
      // an object, so the link dialog can ask for text and URL at once.
      const fields = cfg.fields || [];
      const inputs = fields.map((f) => {
        const el = document.createElement('input');
        el.type = 'text';
        el.className = 'pd-input';
        el.value = f.value || '';
        if (f.placeholder) el.placeholder = f.placeholder;
        if (f.label) {
          const lab = document.createElement('label');
          lab.className = 'pd-label';
          lab.textContent = f.label;
          // Label the field rather than nesting it, so the input keeps its
          // own place in the tab order built below.
          el.id = 'pd-field-' + Math.random().toString(36).slice(2, 10);
          lab.setAttribute('for', el.id);
          box.appendChild(lab);
        }
        box.appendChild(el);
        return el;
      });
      const input = inputs.length === 1 && !cfg.named ? inputs[0] : null;

      const actions = document.createElement('div');
      actions.className = 'pd-actions';

      const cancelBtn = document.createElement('button');
      cancelBtn.type = 'button';
      cancelBtn.className = 'pd-btn pd-cancel';
      cancelBtn.textContent = cfg.cancelLabel;

      const confirmBtn = document.createElement('button');
      confirmBtn.type = 'button';
      confirmBtn.className = 'pd-btn pd-confirm' + (cfg.danger ? ' pd-danger' : '');
      confirmBtn.textContent = cfg.confirmLabel;

      actions.appendChild(cancelBtn);
      actions.appendChild(confirmBtn);
      box.appendChild(actions);
      backdrop.appendChild(box);

      // Place it under the control that opened it, when the caller named one.
      //
      // Centring alone is not safe everywhere: Firefox's about:addons sizes the
      // options iframe to the full content height, so the iframe viewport IS
      // the whole document and `position: fixed` centres against all of it. On
      // a short window the dialog then sits far below the fold, invisible. The
      // backdrop stays fixed, so getBoundingClientRect (viewport coordinates)
      // is the right frame of reference in both the tall-iframe case and an
      // ordinary one.
      const anchor = cfg.anchor && cfg.anchor.getBoundingClientRect ? cfg.anchor : null;
      if (anchor) backdrop.classList.add('pd-anchored');
      document.body.appendChild(backdrop);
      if (anchor) _placeUnder(box, anchor);

      let done = false;
      function finish(result) {
        if (done) return;
        done = true;
        document.removeEventListener('keydown', onKeyDown, true);
        document.removeEventListener('keyup', onKeyEvent, true);
        document.removeEventListener('keypress', onKeyEvent, true);
        backdrop.remove();
        // Put focus back where the user left it, but not onto something that
        // has since been removed from the page.
        if (previouslyFocused && typeof previouslyFocused.focus === 'function' &&
            document.contains(previouslyFocused)) {
          previouslyFocused.focus();
        }
        resolve(result);
      }

      function accept() {
        if (cfg.named) {
          const out = {};
          fields.forEach((f, i) => { out[f.name] = inputs[i].value; });
          finish(out);
          return;
        }
        finish(input ? input.value : true);
      }

      // While a dialog is up it owns the keyboard entirely. The popup binds
      // single-key shortcuts on document ('e' archives, '#' trashes, '!' reports
      // phishing, Escape closes the preview), and those fired happily behind the
      // modal: you could archive the very message you were being asked about.
      // Stopping propagation in the capture phase keeps them from ever seeing
      // the key. It does not cancel the default action, so typing in the prompt
      // field still works.
      function onKeyEvent(e) {
        e.stopPropagation();
      }

      function onKeyDown(e) {
        e.stopPropagation();

        if (e.key === 'Escape') {
          e.preventDefault();
          finish(cfg.cancelValue);
          return;
        }
        if (e.key === 'Enter') {
          // Enter activates whatever has focus, as a button normally would.
          // Confirming regardless would have undone the deliberate choice to
          // start with Cancel focused on a destructive prompt.
          e.preventDefault();
          if (document.activeElement === cancelBtn) finish(cfg.cancelValue);
          else accept();
          return;
        }
        if (e.key === ' ' && document.activeElement === cancelBtn) {
          // Same reasoning: Space presses the focused button, not the other one.
          e.preventDefault();
          finish(cfg.cancelValue);
          return;
        }
        if (e.key === 'Tab') {
          // Focus trap: only ever two or three stops, so cycle by hand.
          const stops = inputs.concat([cancelBtn, confirmBtn]);
          const i = stops.indexOf(document.activeElement);
          const next = e.shiftKey
            ? stops[(i <= 0 ? stops.length : i) - 1]
            : stops[(i + 1) % stops.length];
          e.preventDefault();
          next.focus();
        }
      }

      cancelBtn.addEventListener('click', () => finish(cfg.cancelValue));
      confirmBtn.addEventListener('click', accept);
      backdrop.addEventListener('mousedown', (e) => {
        if (e.target === backdrop) finish(cfg.cancelValue);
      });
      document.addEventListener('keydown', onKeyDown, true);
      document.addEventListener('keyup', onKeyEvent, true);
      document.addEventListener('keypress', onKeyEvent, true);

      if (inputs.length) {
        inputs[0].focus();
        inputs[0].select();
      } else {
        // Focus the safe choice, so a stray Space or Enter cannot confirm a
        // destructive action the user has not read yet.
        cancelBtn.focus();
      }
    });
  }

  /**
   * Ask a yes/no question. Replaces window.confirm().
   *
   * @param {string} message
   * @param {object} [opts] {confirmLabel, cancelLabel, danger, anchor}
   *   anchor: place the dialog under this element instead of centring it.
   * @returns {Promise<boolean>} true only if the user confirmed.
   */
  function confirm(message, opts) {
    const o = opts || {};
    return _queue(() => _show({
      message: message,
      confirmLabel: o.confirmLabel || _t('dialogOk', 'OK'),
      cancelLabel: o.cancelLabel || _t('cancel', 'Cancel'),
      danger: !!o.danger,
      withInput: false,
      cancelValue: false,
      anchor: o.anchor || null,
    }));
  }

  /**
   * Ask for a line of text. Replaces window.prompt().
   *
   * @param {string} message
   * @param {object} [opts] {value, placeholder, confirmLabel, cancelLabel, anchor}
   * @returns {Promise<string|null>} null if the user dismissed it.
   */
  function prompt(message, opts) {
    const o = opts || {};
    return _queue(() => _show({
      message: message,
      confirmLabel: o.confirmLabel || _t('dialogOk', 'OK'),
      cancelLabel: o.cancelLabel || _t('cancel', 'Cancel'),
      danger: false,
      withInput: true,
      fields: [{ name: 'value', value: o.value || '', placeholder: o.placeholder || '' }],
      cancelValue: null,
      anchor: o.anchor || null,
    }));
  }

  /**
   * Ask for several named values at once.
   *
   * Resolves to an object keyed by field name, or null if cancelled. Same
   * queue, focus trap and key handling as prompt(); the only difference is the
   * shape of the answer.
   *
   * @param {string} message
   * @param {Array<{name:string,label?:string,value?:string,placeholder?:string}>} fields
   */
  function form(message, fields, opts) {
    const o = opts || {};
    return _queue(() => _show({
      message: message,
      confirmLabel: o.confirmLabel || _t('dialogOk', 'OK'),
      cancelLabel: o.cancelLabel || _t('cancel', 'Cancel'),
      danger: false,
      withInput: true,
      named: true,
      fields: (fields || []).map((f) => ({
        name: f.name,
        label: f.label || '',
        value: f.value || '',
        placeholder: f.placeholder || '',
      })),
      cancelValue: null,
      anchor: o.anchor || null,
    }));
  }

  return { confirm, prompt, form };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = ProtonDialog;
