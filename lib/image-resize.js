/**
 * Drag-to-resize for inline images in the compose and reply editors.
 *
 * Corner handles scale and keep the aspect ratio; edge handles stretch one
 * axis and ignore it. That split is the whole feature, and it lives in
 * computeSize(), which is pure so it can be tested without a browser.
 *
 * Two constraints shape the implementation:
 *
 * 1. **The handles must never live inside the contenteditable.** Both editors
 *    are serialised straight out of innerHTML, for sending AND for the
 *    encrypted draft, in a dozen places. Anything parked in the editable
 *    subtree would be mailed to the recipient. So the overlay is a
 *    position-fixed sibling on document.body, positioned from the image's
 *    viewport rect and repositioned on scroll.
 *
 * 2. **Firefox turns on its own object resizing in contenteditable.** Gecko
 *    ships handles that stretch freely from every grip, including corners,
 *    which is exactly the behaviour this replaces. It has to be switched off
 *    or the user gets two sets of handles that disagree.
 *
 * The size is written as BOTH the width/height presentation attributes and an
 * inline pixel style. Mail clients are split on which they honour, Proton's own
 * client emits style, and older ones only read the attributes.
 */
const ProtonImageResize = (() => {
  'use strict';

  // Small enough to still be grabbable, large enough that a stray drag cannot
  // collapse an image to something invisible and unrecoverable.
  const MIN_SIZE = 24;

  // How far the grips stick out past the overlay box, from the -6px offsets in
  // popup.css. The clip in position() has to leave this much room or it would
  // slice every grip in half along the edges the editor is not cutting.
  const GRIP_OVERHANG = 8;

  // sx/sy say how a pointer delta on this grip turns into a size change:
  // +1 grows with the axis, -1 grows against it, 0 leaves that axis alone.
  // Both non-zero means a corner, which is what locks the aspect ratio.
  const HANDLES = [
    { name: 'nw', sx: -1, sy: -1 },
    { name: 'n', sx: 0, sy: -1 },
    { name: 'ne', sx: 1, sy: -1 },
    { name: 'e', sx: 1, sy: 0 },
    { name: 'se', sx: 1, sy: 1 },
    { name: 's', sx: 0, sy: 1 },
    { name: 'sw', sx: -1, sy: 1 },
    { name: 'w', sx: -1, sy: 0 },
  ];

  const isCorner = (h) => !!h && h.sx !== 0 && h.sy !== 0;

  /**
   * The new pixel size for a drag.
   *
   * Corners project the drag onto the box diagonal rather than following a
   * single axis. Driving off whichever axis moved more makes the image jump
   * when the pointer crosses the diagonal; projection is continuous, scales
   * symmetrically in and out, and keeps the ratio exact:
   *
   *   t = (ax*W + ay*H) / (W*W + H*H),  then W*(1+t), H*(1+t)
   *
   * The ratio preserved is the CURRENT box ratio, not the file's natural one,
   * so a deliberate stretch survives a later corner drag instead of snapping
   * back to a shape the user already rejected.
   *
   * @param {object} o - sx, sy, startW, startH, dx, dy, and optional
   *   min / maxWidth / maxHeight bounds.
   * @returns {{width:number, height:number}} rounded pixels
   */
  function computeSize(o) {
    const startW = Math.max(1, Number(o.startW) || 0);
    const startH = Math.max(1, Number(o.startH) || 0);
    const dx = Number(o.dx) || 0;
    const dy = Number(o.dy) || 0;
    const sx = Number(o.sx) || 0;
    const sy = Number(o.sy) || 0;
    const min = Math.max(1, Number(o.min) || MIN_SIZE);
    // A missing bound must not become 0 and clamp everything to nothing.
    const maxW = Number(o.maxWidth) > 0 ? Number(o.maxWidth) : Infinity;
    const maxH = Number(o.maxHeight) > 0 ? Number(o.maxHeight) : Infinity;

    let w, h;
    if (sx !== 0 && sy !== 0) {
      const ax = sx * dx;
      const ay = sy * dy;
      const t = (ax * startW + ay * startH) / (startW * startW + startH * startH);
      w = startW * (1 + t);
      h = startH * (1 + t);
      // Clamp on the ratio, never per axis: clamping width alone would shear
      // the image at exactly the moment the user is asking it not to.
      const ratio = startW / startH;
      if (w < min) { w = min; h = w / ratio; }
      if (h < min) { h = min; w = h * ratio; }
      if (w > maxW) { w = maxW; h = w / ratio; }
      if (h > maxH) { h = maxH; w = h * ratio; }
      // The ratio corrections above can push the other axis back under the
      // floor on an extreme box; the floor wins, the ratio gives.
      if (w < min) w = min;
      if (h < min) h = min;
    } else {
      w = sx === 0 ? startW : startW + sx * dx;
      h = sy === 0 ? startH : startH + sy * dy;
      w = Math.min(Math.max(w, min), maxW);
      h = Math.min(Math.max(h, min), maxH);
    }
    return { width: Math.round(w), height: Math.round(h) };
  }

  /** Write a size onto an image in the forms mail clients actually read. */
  function applySize(img, size) {
    if (!img || !size) return;
    const w = Math.round(size.width);
    const h = Math.round(size.height);
    img.setAttribute('width', String(w));
    img.setAttribute('height', String(h));
    img.style.width = w + 'px';
    img.style.height = h + 'px';
    // A max-width from the message stylesheet would otherwise silently win
    // over the width the user just chose.
    img.style.maxWidth = 'none';
  }

  /**
   * Turn off the browser's own image resizing for this editor.
   *
   * Gecko enables it in every contenteditable; Blink dropped it years ago.
   * Both throw or no-op on the command, hence the guard.
   */
  function disableNativeResizing(doc) {
    if (!doc || !doc.execCommand) return false;
    let ok = false;
    try { ok = doc.execCommand('enableObjectResizing', false, 'false') || ok; } catch (e) { /* not supported */ }
    try { doc.execCommand('enableInlineTableEditing', false, 'false'); } catch (e) { /* not supported */ }
    return ok;
  }

  /**
   * Commit a finished drag as ONE entry on the browser's own undo stack.
   *
   * Attribute and style writes made from script are invisible to
   * contenteditable undo, so a resize done the obvious way is simply skipped
   * by Ctrl+Z, which then reaches back past it and undoes whatever was typed
   * before. Keeping a private stack instead would mean two stacks racing for
   * the same shortcut with no way to order them against each other.
   *
   * So the size is re-applied through execCommand, which the browser DOES
   * record. The element is first put back to the size it had when the drag
   * started, because the undo entry captures the DOM as it stands at the
   * moment of the command: without that rewind, undo would restore the size
   * the user just dragged to and appear to do nothing.
   *
   * The drag itself still writes directly, so dragging stays smooth and a
   * hundred pointermove events do not become a hundred undo entries.
   *
   * @returns {Element|null} the image now in the document, which is a NEW node
   *   when the native path ran, or null if it could not be found again.
   */
  function commitResize(img, startSize, finalSize) {
    if (!img || !finalSize) return img;
    if (startSize && startSize.width === finalSize.width &&
        startSize.height === finalSize.height) return img;

    const doc = img.ownerDocument;
    const win = doc && doc.defaultView;
    if (!doc || !win || !doc.execCommand || !startSize) {
      applySize(img, finalSize);
      return img;
    }

    // Marks the replacement so it can be found again straight after the
    // insert. Removed in the finally below, so it cannot reach a draft or an
    // outgoing message.
    const MARK = 'data-pir-new';
    let inserted = null;
    try {
      const clone = img.cloneNode(false);
      applySize(clone, finalSize);
      clone.setAttribute(MARK, '1');

      applySize(img, startSize); // rewind, so undo has something to go back to

      const sel = win.getSelection();
      const range = doc.createRange();
      range.selectNode(img);
      sel.removeAllRanges();
      sel.addRange(range);

      const ok = doc.execCommand('insertHTML', false, clone.outerHTML);
      if (!ok) {
        // Nothing was inserted, so the rewind above is still showing. Put the
        // size back directly: a lost resize is far worse than a lost undo.
        applySize(img, finalSize);
        return img;
      }
      inserted = doc.querySelector('img[' + MARK + ']');
      if (!inserted) return null; // replaced, but we cannot re-select it
      return inserted;
    } catch (e) {
      applySize(img, finalSize);
      return img;
    } finally {
      // Sweep, rather than only clearing the node we happened to find: a
      // marker left behind would be saved into the draft and mailed out.
      const strays = doc.querySelectorAll ? doc.querySelectorAll('[' + MARK + ']') : [];
      for (let i = 0; i < strays.length; i++) strays[i].removeAttribute(MARK);
    }
  }

  /**
   * Wire drag-to-resize onto one contenteditable editor.
   *
   * The overlay is built on document.body, NOT inside the editor: see the file
   * header. It is position-fixed and driven from getBoundingClientRect, so it
   * follows the image without the editor needing a positioned wrapper, which
   * would mean touching the existing layout.
   *
   * @param {Element} editor - the contenteditable
   * @param {object} [opts] - {label} accessible name for the overlay
   * @returns {{detach:Function, hide:Function}}
   */
  function attach(editor, opts) {
    if (!editor || typeof document === 'undefined') return { detach() {}, hide() {} };
    const options = opts || {};
    let selected = null;
    let drag = null;

    const overlay = document.createElement('div');
    overlay.className = 'pir-overlay';
    overlay.setAttribute('role', 'group');
    overlay.setAttribute('aria-label', options.label || 'Resize image');
    overlay.hidden = true;
    const grips = HANDLES.map((h) => {
      const el = document.createElement('div');
      el.className = 'pir-grip pir-' + h.name;
      el.dataset.handle = h.name;
      overlay.appendChild(el);
      return { def: h, el };
    });
    document.body.appendChild(overlay);

    function position() {
      if (!selected) return;
      const r = selected.getBoundingClientRect();
      const e = editor.getBoundingClientRect();
      // The editors scroll internally, and an image can easily be taller than
      // the visible area.
      const visible = r.bottom > e.top && r.top < e.bottom && r.right > e.left && r.left < e.right;
      if (!visible || r.width === 0) { overlay.hidden = true; return; }
      overlay.hidden = false;
      overlay.style.left = r.left + 'px';
      overlay.style.top = r.top + 'px';
      overlay.style.width = r.width + 'px';
      overlay.style.height = r.height + 'px';

      // Clip to the editor. Testing for INTERSECTION alone is not enough: a
      // partly-scrolled image is still "visible", so the whole frame stayed
      // drawn and the top grips rode up over the toolbar and the subject line.
      // The overhang lets the grips, which sit 6px outside the box, stay whole
      // on any edge the editor is not actually cutting.
      const over = -(GRIP_OVERHANG);
      const top = Math.max(e.top - r.top, over);
      const left = Math.max(e.left - r.left, over);
      const right = Math.max(r.right - e.right, over);
      const bottom = Math.max(r.bottom - e.bottom, over);
      overlay.style.clipPath =
        'inset(' + top + 'px ' + right + 'px ' + bottom + 'px ' + left + 'px)';
    }

    function select(img) {
      if (selected === img) { position(); return; }
      // Selection is tracked here and shown by the overlay ALONE. Marking the
      // image with a class would put it inside the contenteditable, and the
      // editors are serialised straight out of innerHTML: the class would be
      // saved into the draft and mailed to the recipient.
      selected = img;
      if (selected) position(); else overlay.hidden = true;
    }

    const deselect = () => select(null);

    function onEditorPointerDown(ev) {
      const img = ev.target && ev.target.nodeName === 'IMG' && editor.contains(ev.target)
        ? ev.target : null;
      if (img) select(img); else deselect();
    }

    function onGripDown(ev) {
      const name = ev.target && ev.target.dataset ? ev.target.dataset.handle : null;
      const grip = grips.find((g) => g.def.name === name);
      if (!grip || !selected) return;
      ev.preventDefault();
      ev.stopPropagation();
      const r = selected.getBoundingClientRect();
      // Bound by the editor's CONTENT width, so a resize cannot push the image
      // wider than the composer and force it to scroll sideways.
      const style = window.getComputedStyle(editor);
      const maxWidth = Math.max(
        MIN_SIZE,
        editor.clientWidth - (parseFloat(style.paddingLeft) || 0) - (parseFloat(style.paddingRight) || 0)
      );
      drag = {
        grip, startX: ev.clientX, startY: ev.clientY,
        startW: r.width, startH: r.height, maxWidth,
        // The size to rewind to when the drag is committed as one undo entry.
        startSize: { width: Math.round(r.width), height: Math.round(r.height) },
        lastSize: null,
      };
      document.addEventListener('pointermove', onGripMove);
      document.addEventListener('pointerup', onGripUp);
      overlay.classList.add('pir-dragging');
    }

    function onGripMove(ev) {
      if (!drag || !selected) return;
      // Written straight onto the element: a live preview, and deliberately
      // NOT through execCommand, or a single drag would leave a hundred
      // entries on the undo stack. commitResize collapses it to one on release.
      drag.lastSize = computeSize({
        sx: drag.grip.def.sx,
        sy: drag.grip.def.sy,
        startW: drag.startW,
        startH: drag.startH,
        dx: ev.clientX - drag.startX,
        dy: ev.clientY - drag.startY,
        min: MIN_SIZE,
        maxWidth: drag.maxWidth,
      });
      applySize(selected, drag.lastSize);
      position();
    }

    function onGripUp() {
      document.removeEventListener('pointermove', onGripMove);
      document.removeEventListener('pointerup', onGripUp);
      overlay.classList.remove('pir-dragging');
      const finished = drag;
      drag = null;
      if (!finished || !selected) return;
      if (!finished.lastSize) return; // a click on a grip that never moved

      const replacement = commitResize(selected, finished.startSize, finished.lastSize);
      if (replacement && replacement !== selected) {
        // execCommand swapped in a new node, so the old reference is detached.
        selected = replacement;
      } else if (!replacement) {
        deselect(); // replaced but unfindable: better no handles than stale ones
      }
      position();
      // The draft autosave and the dirty-check both listen for input. A native
      // execCommand fires one itself; the direct-write fallback does not, so
      // it is dispatched here and a harmless duplicate is accepted.
      editor.dispatchEvent(new Event('input', { bubbles: true }));
    }

    // Typing anywhere in the editor moves the image; rather than chase it,
    // drop the selection. Reselecting is one click.
    const onInput = () => { if (!drag) deselect(); };
    const onKeyDown = (ev) => { if (ev.key === 'Escape' && selected) deselect(); };
    // Repositioning straight from a scroll handler is what Firefox warns about
    // as a "scroll-linked positioning effect": it runs on every scroll event,
    // which can be more often than the compositor paints, and fights async
    // panning. Coalescing to at most one reposition per frame is the standard
    // answer, and it also stops the redundant layout reads.
    let rafPending = 0;
    const onScrollOrResize = () => {
      if (!selected || rafPending) return;
      rafPending = requestAnimationFrame(() => { rafPending = 0; position(); });
    };
    const onDocPointerDown = (ev) => {
      if (overlay.contains(ev.target) || editor.contains(ev.target)) return;
      deselect();
    };

    editor.addEventListener('pointerdown', onEditorPointerDown);
    overlay.addEventListener('pointerdown', onGripDown);
    editor.addEventListener('input', onInput);
    editor.addEventListener('scroll', onScrollOrResize, true);
    editor.addEventListener('keydown', onKeyDown);
    document.addEventListener('pointerdown', onDocPointerDown, true);
    window.addEventListener('scroll', onScrollOrResize, true);
    window.addEventListener('resize', onScrollOrResize);
    editor.addEventListener('focus', () => disableNativeResizing(document), true);
    disableNativeResizing(document);

    return {
      hide: deselect,
      detach() {
        deselect();
        onGripUp();
        if (rafPending) { cancelAnimationFrame(rafPending); rafPending = 0; }
        editor.removeEventListener('pointerdown', onEditorPointerDown);
        overlay.removeEventListener('pointerdown', onGripDown);
        editor.removeEventListener('input', onInput);
        editor.removeEventListener('scroll', onScrollOrResize, true);
        editor.removeEventListener('keydown', onKeyDown);
        document.removeEventListener('pointerdown', onDocPointerDown, true);
        window.removeEventListener('scroll', onScrollOrResize, true);
        window.removeEventListener('resize', onScrollOrResize);
        if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
      },
    };
  }

  return { HANDLES, MIN_SIZE, isCorner, computeSize, applySize, commitResize, disableNativeResizing, attach };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = ProtonImageResize;
