/**
 * WYSIWYG editor toolbar initialization for the popup.
 *
 * Handles button commands (bold, italic, link, etc.), select commands
 * (font name/size), inline color pickers, and emoji picker.
 *
 * Extracted from popup.js to reduce that file's size.
 * Used for both the compose toolbar and the reply toolbar.
 */

const PopupEditorToolbar = (() => {

  // Shared registry of open toolbar popups (colour pickers + emoji), across
  // BOTH the compose and reply toolbars. Module-scoped (not per-init) so
  // opening any picker closes any other, and so popup.js can dismiss orphaned
  // pickers when the preview/compose panel closes (they are portaled to
  // <body>, so they don't get torn down with their panel).
  const activePopups = [];
  function closeAllPopups() {
    while (activePopups.length) activePopups.pop().close();
  }

  /**
   * Anchor a portaled popup to its toolbar button: prefer opening below,
   * flip above when there isn't room, and clamp to the viewport so it's
   * never cut off, regardless of window size (handles the popped-out,
   * resized window too).
   */
  function positionPopup(panel, anchorBtn) {
    const r = anchorBtn.getBoundingClientRect();
    const pw = panel.offsetWidth || 220;
    const ph = panel.offsetHeight || 200;
    const m = 6;
    const vw = document.documentElement.clientWidth;
    const vh = document.documentElement.clientHeight;
    const spaceBelow = vh - r.bottom;
    const spaceAbove = r.top;
    let top = (spaceBelow >= ph + m || spaceBelow >= spaceAbove)
      ? r.bottom + m
      : r.top - ph - m;
    top = Math.max(m, Math.min(top, vh - ph - m));
    const left = Math.max(m, Math.min(r.right - pw, vw - pw - m));
    panel.style.position = 'fixed';
    panel.style.top = top + 'px';
    panel.style.left = left + 'px';
    panel.style.right = 'auto';
    panel.style.bottom = 'auto';
  }

  // Escape closes any open editor popup first (and stops the keystroke from
  // also closing the surrounding preview/compose panel). Registered once;
  // editor-toolbar.js loads before popup.js so this runs before popup.js's
  // Escape handler.
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && activePopups.length) {
      closeAllPopups();
      e.stopImmediatePropagation();
      e.preventDefault();
    }
  });

  /**
   * Initialize a WYSIWYG editor toolbar.
   *
   * Attaches event listeners to all toolbar buttons, selects, color pickers,
   * and the emoji picker within the given toolbar element.
   *
   * @param {HTMLElement} toolbarEl - The toolbar container element.
   * @param {HTMLElement} editorEl - The contenteditable editor element.
   * @param {Function} createColorPicker - Color picker factory function.
   */
  /**
   * The <a href> the caret sits in, or null. Scoped to the editor so a link in
   * surrounding chrome can never be edited by accident.
   */
  function _anchorAt(range, editorEl) {
    if (!range) return null;
    let node = range.startContainer;
    if (node && node.nodeType === 3) node = node.parentNode;
    if (!node || !node.closest) return null;
    const a = node.closest('a[href]');
    return a && editorEl.contains(a) ? a : null;
  }

  /** Replace a link with its own contents, leaving the text behind. */
  function _unwrap(el) {
    const parent = el.parentNode;
    if (!parent) return;
    while (el.firstChild) parent.insertBefore(el.firstChild, el);
    parent.removeChild(el);
  }

  function _escapeAttr(s) {
    return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;')
      .replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function _escapeText(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function init(toolbarEl, editorEl, createColorPicker) {
    // Button commands (bold, italic, etc.). Skip color buttons, handled below
    for (const btn of toolbarEl.querySelectorAll('.editor-btn[data-cmd]:not(.editor-color-btn)')) {
      btn.addEventListener('click', async (e) => {
        e.preventDefault();
        const cmd = btn.dataset.cmd;
        if (cmd === 'createLink') {
          // The selection is lost while the dialog holds focus, so capture it
          // first and put it back before running the command.
          const sel = window.getSelection();
          const range = sel && sel.rangeCount > 0 ? sel.getRangeAt(0).cloneRange() : null;
          const anchor = _anchorAt(range, editorEl);

          // What the link should READ as. Editing an existing link offers its
          // current text; a fresh link offers the selection, so highlighting
          // "FAQ" and hitting the link button turns that word into the link
          // instead of dumping the address into the message.
          const selectedText = range && !range.collapsed ? range.toString() : '';
          const initialText = anchor ? anchor.textContent || '' : selectedText;

          const result = await ProtonDialog.form(ProtonI18n.t('insertLink'), [
            { name: 'text', label: ProtonI18n.t('linkText'), value: initialText,
              placeholder: ProtonI18n.t('linkTextPlaceholder') },
            // Editing an existing link offered an empty box, so the address had
            // to be retyped from memory to change it.
            { name: 'url', label: ProtonI18n.t('linkUrl'),
              value: anchor ? anchor.getAttribute('href') || '' : '',
              placeholder: 'https://' },
          ]);

          if (range) {
            editorEl.focus();
            sel.removeAllRanges();
            sel.addRange(range);
          }

          if (result !== null) {
            const href = (result.url || '').trim();
            const text = (result.text || '').trim();
            if (anchor) {
              // execCommand cannot help here: the selection is a caret inside
              // the link, and createLink on a collapsed selection does nothing.
              if (!href) {
                _unwrap(anchor);
              } else {
                anchor.setAttribute('href', href);
                // Only rewrite the text when it actually changed, so an
                // anchor wrapping an image or other markup keeps its contents
                // instead of being flattened to a string.
                if (text && text !== (anchor.textContent || '').trim()) {
                  anchor.textContent = text;
                }
              }
            } else if (href) {
              // One insert covers both cases. With a selection, insertHTML
              // replaces it, which is what makes the chosen text become the
              // link; with a caret it just inserts. createLink is no longer
              // involved because it can only ever reuse the selected text
              // verbatim and would ignore an edited label.
              document.execCommand('insertHTML', false,
                '<a href="' + _escapeAttr(href) + '">' +
                _escapeText(text || href) + '</a>');
            }
          }
        } else if (cmd === 'formatBlock' && btn.dataset.value) {
          document.execCommand('formatBlock', false, '<' + btn.dataset.value + '>');
        } else {
          document.execCommand(cmd, false, null);
        }
        editorEl.focus();
      });
    }

    // Select commands (fontName, fontSize)
    for (const sel of toolbarEl.querySelectorAll('.editor-select[data-cmd]')) {
      sel.addEventListener('change', () => {
        const val = sel.value;
        if (val) {
          document.execCommand(sel.dataset.cmd, false, val);
        }
        sel.selectedIndex = 0; // reset to label
        editorEl.focus();
      });
    }

    // Inline colour pickers (foreColor, hiliteColor). The shared
    // activePopups / closeAllPopups / positionPopup (module scope) are used so
    // pickers across the compose + reply toolbars share one registry.
    for (const btn of toolbarEl.querySelectorAll('.editor-color-btn[data-cmd]')) {
      let pickerPanel = null;
      let reposition = null;
      function closePicker() {
        if (pickerPanel) pickerPanel.classList.remove('open');
        if (reposition) {
          window.removeEventListener('resize', reposition);
          window.removeEventListener('scroll', reposition, true);
          reposition = null;
        }
        const i = activePopups.indexOf(entry);
        if (i !== -1) activePopups.splice(i, 1);
      }
      const entry = { close: closePicker };
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const wasOpen = pickerPanel && pickerPanel.classList.contains('open');
        closeAllPopups();
        if (wasOpen) return;
        const colorBar = btn.querySelector('.editor-color-bar');
        const cmd = btn.dataset.cmd;
        const initialColor = btn.dataset.color || '#000000';
        const defaultColor = cmd === 'hiliteColor' ? '#FFFFFF' : '#000000';
        if (!pickerPanel) {
          pickerPanel = createColorPicker(initialColor, (hex) => {
            btn.dataset.color = hex;
            colorBar.style.setProperty('--bar-color', hex);
            document.execCommand(cmd, false, hex);
          }, { defaultColor });
          document.body.appendChild(pickerPanel);
        }
        pickerPanel.classList.add('open');
        positionPopup(pickerPanel, btn);
        reposition = () => positionPopup(pickerPanel, btn);
        window.addEventListener('resize', reposition);
        window.addEventListener('scroll', reposition, true);
        activePopups.push(entry);
      });
      document.addEventListener('click', (e) => {
        if (pickerPanel && pickerPanel.classList.contains('open')
            && !btn.contains(e.target) && !pickerPanel.contains(e.target)) {
          closePicker();
        }
      });
    }

    // Emoji picker
    const emojiBtn = toolbarEl.querySelector('#btn-editor-emoji') || toolbarEl.querySelector('.editor-btn-emoji');
    if (emojiBtn) {
      const emojis = [
        '😀','😃','😄','😁','😅','😂','🤣','😊','😇','🙂','😉','😍','🥰','😘',
        '😋','😛','😜','🤪','😎','🤩','🥳','😏','😒','😞','😔','😟','😕','😣',
        '😢','😭','😤','😠','😡','🤬','😈','👿','💀','☠️','💩','🤡','👹','👺',
        '👻','👽','🤖','😺','😸','😹','😻','😼','😽','🙀','😿','😾','🙈','🙉',
        '🙊','💋','💌','💘','💝','💖','💗','💓','💞','💕','❣️','💔','❤️','🧡',
        '💛','💚','💙','💜','🤎','🖤','🤍','💯','💢','💥','💫','💦','💨','🕳️',
        '💣','💬','👋','🤚','🖐️','✋','🖖','👌','🤏','✌️','🤞','🤟','🤘','🤙',
        '👈','👉','👆','👇','☝️','👍','👎','✊','👊','🤛','🤜','👏','🙌','👐',
      ];
      let pickerEl = null;
      let reposition = null;
      function closeEmoji() {
        if (pickerEl) { pickerEl.remove(); pickerEl = null; }
        if (reposition) {
          window.removeEventListener('resize', reposition);
          window.removeEventListener('scroll', reposition, true);
          reposition = null;
        }
        const i = activePopups.indexOf(entry);
        if (i !== -1) activePopups.splice(i, 1);
      }
      const entry = { close: closeEmoji };
      emojiBtn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const wasOpen = !!pickerEl;
        closeAllPopups();
        if (wasOpen) return;
        pickerEl = document.createElement('div');
        pickerEl.className = 'emoji-picker';
        for (const em of emojis) {
          const b = document.createElement('button');
          b.textContent = em;
          b.type = 'button';
          b.addEventListener('click', (ev) => {
            ev.preventDefault();
            editorEl.focus();
            document.execCommand('insertText', false, em);
            closeEmoji();
          });
          pickerEl.appendChild(b);
        }
        document.body.appendChild(pickerEl);
        positionPopup(pickerEl, emojiBtn);
        reposition = () => positionPopup(pickerEl, emojiBtn);
        window.addEventListener('resize', reposition);
        window.addEventListener('scroll', reposition, true);
        activePopups.push(entry);
      });
      // Close picker on outside click
      document.addEventListener('click', (e) => {
        if (pickerEl && !emojiBtn.contains(e.target) && !pickerEl.contains(e.target)) {
          closeEmoji();
        }
      });
    }
  }

  /**
   * Render a compose/reply attachment list.
   *
   * @param {string} containerId - DOM element ID for the attachment container.
   * @param {Array} attArray - Array of { file: File, _base64Data? } objects.
   */
  function renderComposeAttachments(containerId, attArray) {
    const container = document.getElementById(containerId);
    if (!container) return;
    container.textContent = '';
    if (attArray.length === 0) {
      container.classList.add('hidden');
      return;
    }
    container.classList.remove('hidden');
    for (let i = 0; i < attArray.length; i++) {
      const att = attArray[i];
      const item = document.createElement('div');
      item.className = 'compose-attachment-item';

      const icon = document.createElement('span');
      icon.className = 'attachment-icon';
      icon.textContent = PopupAttachments.getFileIcon(att.file.type || att.file.name);

      const name = document.createElement('span');
      name.className = 'compose-attachment-name';
      name.textContent = att.file.name + ' (' + PopupAttachments.formatSize(att.file.size) + ')';

      const removeBtn = document.createElement('button');
      removeBtn.className = 'compose-attachment-remove';
      removeBtn.textContent = '\u00D7';
      removeBtn.title = ProtonI18n.t('remove');
      const idx = i;
      removeBtn.addEventListener('click', () => {
        attArray.splice(idx, 1);
        renderComposeAttachments(containerId, attArray);
      });

      item.appendChild(icon);
      item.appendChild(name);
      item.appendChild(removeBtn);
      container.appendChild(item);
    }
  }

  return {
    init,
    renderComposeAttachments,
    closeAllPopups,
    positionPopup,
    registerPopup: (entry) => { activePopups.push(entry); },
    unregisterPopup: (entry) => { const i = activePopups.indexOf(entry); if (i !== -1) activePopups.splice(i, 1); },
  };
})();
