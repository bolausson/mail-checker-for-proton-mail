/**
 * ProtonEmailCanvas: does an HTML email paint its own page background?
 *
 * The popup renders email HTML inside a sandboxed iframe whose canvas is the
 * popup's own background. In dark mode that canvas is dark, which only works
 * when the email either brings its own background or uses light text. Mail
 * composed for a white page (the overwhelming majority: `color:#000` with no
 * background) would render as black-on-black, so the popup falls back to a
 * white canvas, but only when the email doesn't paint one itself.
 *
 * "Its own canvas" means a background that covers essentially the WHOLE
 * message:
 *   - a background on <body> (inline or via the email's own CSS), or
 *   - a block-level wrapper element containing nearly all of the text.
 *
 * A highlighted <span>, a single coloured table cell or a dark hero banner is
 * NOT a canvas. Outlook and web.de wrap pasted text in
 * `<span style="background-color:#ffffff">…</span>`; counting that as the
 * canvas left the rest of a `color:#000` mail as black text on the dark popup
 * background, unreadable (reported 2026-07-25).
 *
 * The check is deliberately conservative: when in doubt it answers "no own
 * canvas" and the caller forces a light one. That direction is safe: the
 * email's own backgrounds still paint on top of the light canvas, so a dark
 * hero block keeps its light text. The opposite mistake is what makes mail
 * unreadable, so ambiguity always resolves toward the readable answer.
 */
const ProtonEmailCanvas = (() => {
  'use strict';

  /** Share of the message text a wrapper must contain to count as the canvas.
   *  Near-total on purpose: a wrapper that leaves even a footer outside would
   *  leave that footer's dark text sitting on the dark canvas. */
  const COVERAGE = 0.95;

  /** How deep to follow the wrapper chain. Outlook/newsletter markup nests
   *  div > table > tbody > tr > td before reaching the element that actually
   *  paints the page. */
  const MAX_DEPTH = 8;

  /** Elements that establish a full-width block box, i.e. that CAN be a page
   *  canvas. Anything else (span, a, font, b, …) paints only behind its own
   *  words. Unknown/custom tags are intentionally excluded: "not a canvas"
   *  is the safe answer. */
  const BLOCK_TAGS = new Set([
    'DIV', 'TABLE', 'TBODY', 'THEAD', 'TFOOT', 'TR', 'TD', 'TH', 'CENTER',
    'SECTION', 'ARTICLE', 'MAIN', 'HEADER', 'FOOTER', 'ASIDE', 'NAV',
    'P', 'BLOCKQUOTE', 'FIGURE', 'PRE', 'UL', 'OL', 'LI', 'DL', 'DD', 'DT',
  ]);

  /** A background value that actually paints something. */
  function isMeaningfulBg(value) {
    if (!value) return false;
    const s = String(value).trim().toLowerCase();
    return !!s && s !== 'transparent' && s !== 'inherit' && s !== 'initial' &&
      s !== 'unset' && s !== 'none';
  }

  /** `background-color`, else the value of the `background:` shorthand. */
  function readBg(styleAttr) {
    if (!styleAttr) return '';
    const mc = styleAttr.match(/background-color\s*:\s*([^;]+)/i);
    if (mc) return mc[1];
    const mb = styleAttr.match(/(?:^|;)\s*background\s*:\s*([^;]+)/i);
    return mb ? mb[1] : '';
  }

  function elementHasBg(el) {
    if (!el || !el.getAttribute) return false;
    return isMeaningfulBg(readBg(el.getAttribute('style'))) ||
      isMeaningfulBg(el.getAttribute('bgcolor'));
  }

  /** Text length ignoring whitespace, so indentation in the markup doesn't
   *  inflate a wrapper's apparent share of the content. */
  function textLen(el) {
    return ((el && el.textContent) || '').replace(/\s+/g, '').length;
  }

  /** Does the email's own CSS paint the page via a body/html rule? */
  function cssPaintsCanvas(cssText) {
    if (!cssText) return false;
    return /(?:^|[};])\s*(?:body|html)[^{}]*\{[^}]*background(-color)?\s*:\s*(?!transparent|inherit|initial|unset|none)[^;}]+/i
      .test(cssText);
  }

  /**
   * @param {Document} doc  parsed email document (already stripped of <style>)
   * @param {string} cssText  the email's collected <style> CSS
   * @returns {boolean} true when the email paints its own full-message canvas
   */
  function hasOwnCanvas(doc, cssText) {
    const body = doc && doc.body;
    if (!body) return cssPaintsCanvas(cssText);
    if (elementHasBg(body)) return true;

    // Walk the wrapper chain. At each level at most ONE child can still be the
    // canvas (the one holding nearly all the text), so there is never a
    // branch to explore. The walk stops as soon as the content fans out into
    // siblings, which is exactly when no single element covers the message.
    const total = textLen(body);
    let node = body;
    for (let depth = 0; node && depth < MAX_DEPTH; depth++) {
      let wrapper = null;
      for (const child of node.children || []) {
        if (!BLOCK_TAGS.has(child.tagName)) continue;
        // An image-only mail has no text to measure: the first block-level
        // child is the best available guess at its canvas.
        if (total > 0 && textLen(child) / total < COVERAGE) continue;
        wrapper = child;
        break;
      }
      if (!wrapper) break;
      if (elementHasBg(wrapper)) return true;
      node = wrapper;
    }

    return cssPaintsCanvas(cssText);
  }

  return {
    hasOwnCanvas,
    // exposed for unit tests
    isMeaningfulBg,
    readBg,
    cssPaintsCanvas,
    COVERAGE,
  };
})();

if (typeof window !== 'undefined') window.ProtonEmailCanvas = ProtonEmailCanvas;
