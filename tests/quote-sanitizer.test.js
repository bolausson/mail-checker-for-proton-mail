/**
 * @vitest-environment jsdom
 *
 * Reply-quote sanitiser.
 *
 * The quote lands in a live contenteditable of the POPUP's own document: no
 * iframe, no sandbox, and .preview-panel is a transformed full-viewport
 * container, so a positioned descendant can paint over the entire popup.
 *
 * Every case below is a bypass that an adversarial review actually found in the
 * previous, regex-based version of this code. They are kept as tests because a
 * regex cannot see what the CSS tokenizer sees: comments, ident escapes and
 * custom properties all mean the literal text and the parsed declaration differ.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const SRC = readFileSync(join(__dirname, '..', 'popup', 'popup.js'), 'utf-8');

/** Slice a top-level `function NAME(...) {...}` or `const NAME = ...;` out. */
function lift(name) {
  let start = SRC.indexOf('function ' + name + '(');
  if (start !== -1) {
    let i = SRC.indexOf('{', start);
    let depth = 0;
    for (; i < SRC.length; i++) {
      if (SRC[i] === '{') depth++;
      else if (SRC[i] === '}') { depth--; if (depth === 0) return SRC.slice(start, i + 1); }
    }
    throw new Error('unbalanced braces reading ' + name);
  }
  start = SRC.indexOf('const ' + name + ' = ');
  if (start === -1) throw new Error('not found in popup.js: ' + name);
  const end = SRC.indexOf(']);', start);
  if (end === -1) throw new Error('could not find the end of ' + name);
  return SRC.slice(start, end + 3);
}

let H;
let inlineImages;
beforeAll(() => {
  const parts = [
    lift('QUOTE_URL_ATTRS'),
    lift('QUOTE_SAFE_STYLE_PROPS'),
    lift('_sanitizeQuoteStyle'),
    lift('_normalizeCid'),
    lift('_sanitizeQuoteHtml'),
    lift('_restoreQuoteUrls'),
    'return { _sanitizeQuoteHtml, _sanitizeQuoteStyle, _restoreQuoteUrls };',
  ].join('\n\n');
  // The sanitiser reads these globals: two to decide on remote content, and
  // _inlineImages to draw an embedded image the reading pane already decrypted.
  inlineImages = new Map();
  H = new Function('document', 'DOMParser', '_externalContentLoaded', '_settings', '_inlineImages', parts)(
    globalThis.document, globalThis.DOMParser, false, {}, inlineImages);
});

/** Re-parse output so assertions are about the DOM, not string formatting. */
function parse(html) {
  return new DOMParser().parseFromString(html, 'text/html').body;
}

describe('inline style: positioning cannot survive in any spelling', () => {
  // .preview-panel is position:fixed with a transform, so it is the containing
  // block for a fixed descendant: this is the full-popup overlay vector.
  const cases = [
    ['plain', 'position:fixed;top:0'],
    ['custom property indirection', '--p:fixed;position:var(--p);top:0'],
    ['comment inside the declaration', 'position/**/:fixed;top:0'],
    ['ident escape', 'position:\\66 ixed;top:0'],
    ['vendor prefixed value', 'position:-webkit-sticky;top:0'],
    ['uppercase', 'POSITION:FIXED;top:0'],
    ['absolute', 'position:absolute;left:0'],
    ['sticky', 'position:sticky;top:0'],
  ];
  for (const [label, style] of cases) {
    it('drops position (' + label + ')', () => {
      expect(H._sanitizeQuoteStyle(style)).not.toMatch(/position/i);
    });
  }

  it('drops custom properties outright, so nothing can be reintroduced later', () => {
    expect(H._sanitizeQuoteStyle('--evil:fixed;color:red')).toBe('color: red');
  });

  it('keeps the ordinary formatting a quote needs', () => {
    const out = H._sanitizeQuoteStyle('color:#ff0000;font-weight:bold;margin-left:8px');
    expect(out).toMatch(/color/);
    expect(out).toMatch(/font-weight/);
    expect(out).toMatch(/margin-left/);
  });

  it('rejects values that could fetch or indirect', () => {
    expect(H._sanitizeQuoteStyle('background-color:url(https://x/y.png)')).toBe('');
    expect(H._sanitizeQuoteStyle('color:image-set("https://x/y.png" 1x)')).toBe('');
    expect(H._sanitizeQuoteStyle('width:expression(alert(1))')).toBe('');
  });

  it('survives junk without throwing', () => {
    expect(H._sanitizeQuoteStyle(null)).toBe('');
    expect(H._sanitizeQuoteStyle('}{;;:')).toBe('');
  });
});

describe('remote content is not fetched while composing', () => {
  it('parks a remote img src instead of loading it', () => {
    const body = parse(H._sanitizeQuoteHtml('<img src="https://tracker.example/px.gif">'));
    const img = body.querySelector('img');
    expect(img.hasAttribute('src')).toBe(false);
    expect(img.getAttribute('data-mcpm-src')).toBe('https://tracker.example/px.gif');
  });

  it('covers background= and poster=, which a denylist missed', () => {
    const body = parse(H._sanitizeQuoteHtml(
      '<table><tr><td background="https://a.example/b.png"></td></tr></table>' +
      '<video poster="https://c.example/d.jpg"></video>'));
    expect(body.querySelector('td').hasAttribute('background')).toBe(false);
    expect(body.querySelector('video').hasAttribute('poster')).toBe(false);
  });

  it('removes SVG entirely, so svg image/use href cannot fetch', () => {
    const body = parse(H._sanitizeQuoteHtml(
      '<svg><image href="https://tracker.example/px.png"/><use href="https://x/y#a"/></svg><p>keep</p>'));
    expect(body.querySelector('svg')).toBeNull();
    expect(body.querySelector('image')).toBeNull();
    expect(body.textContent).toContain('keep');
  });

  it('keeps data: and cid:, which hit no network', () => {
    const body = parse(H._sanitizeQuoteHtml(
      '<img src="data:image/png;base64,AAA"><img src="cid:abc">'));
    const imgs = body.querySelectorAll('img');
    expect(imgs[0].getAttribute('src')).toBe('data:image/png;base64,AAA');
    expect(imgs[1].getAttribute('src')).toBe('cid:abc');
  });

  it('leaves a real hyperlink alone: it fetches nothing until clicked', () => {
    const body = parse(H._sanitizeQuoteHtml('<a href="https://example.com/x">link</a>'));
    expect(body.querySelector('a').getAttribute('href')).toBe('https://example.com/x');
  });
});

describe('script-bearing markup is removed regardless of remote-content setting', () => {
  it('strips scripts, styles, forms and event handlers', () => {
    const body = parse(H._sanitizeQuoteHtml(
      '<script>alert(1)</script><style>a{}</style><form><input></form>' +
      '<p onclick="alert(1)" onmouseover="x()">t</p>'));
    expect(body.querySelector('script')).toBeNull();
    expect(body.querySelector('style')).toBeNull();
    expect(body.querySelector('form')).toBeNull();
    const p = body.querySelector('p');
    expect(p.hasAttribute('onclick')).toBe(false);
    expect(p.hasAttribute('onmouseover')).toBe(false);
  });

  it('drops javascript: and data:text/html in any URL attribute', () => {
    const body = parse(H._sanitizeQuoteHtml(
      '<a href="javascript:alert(1)">a</a><a href="data:text/html,<b>x">b</a>'));
    body.querySelectorAll('a').forEach(a => expect(a.hasAttribute('href')).toBe(false));
  });
});

describe('the outgoing quote is restored before sending', () => {
  it('puts a parked URL back, so the recipient copy is intact', () => {
    const sanitized = H._sanitizeQuoteHtml('<img src="https://cdn.example/logo.png">');
    const restored = parse(H._restoreQuoteUrls(sanitized)).querySelector('img');
    expect(restored.getAttribute('src')).toBe('https://cdn.example/logo.png');
    expect(restored.hasAttribute('data-mcpm-src')).toBe(false);
  });

  it('round-trips background and poster too', () => {
    const html = '<table><tr><td background="https://a/b.png"></td></tr></table>' +
      '<video poster="https://c/d.jpg"></video>';
    const body = parse(H._restoreQuoteUrls(H._sanitizeQuoteHtml(html)));
    expect(body.querySelector('td').getAttribute('background')).toBe('https://a/b.png');
    expect(body.querySelector('video').getAttribute('poster')).toBe('https://c/d.jpg');
  });

  it('does not resurrect something the sanitiser deleted for being dangerous', () => {
    const restored = parse(H._restoreQuoteUrls(
      H._sanitizeQuoteHtml('<a href="javascript:alert(1)">x</a>')));
    expect(restored.querySelector('a').hasAttribute('href')).toBe(false);
  });

  it('ignores an attacker-supplied data-mcpm- attribute for a non-URL name', () => {
    // The mail itself can contain data-mcpm-*; only known URL attrs restore.
    const restored = parse(H._restoreQuoteUrls('<p data-mcpm-onclick="alert(1)">x</p>'));
    expect(restored.querySelector('p').hasAttribute('onclick')).toBe(false);
  });
});

describe('a quote cannot borrow the popup stylesheet', () => {
  // The quote lands in a live contenteditable in the POPUP's own document, and
  // popup.css matches unprefixed class names. Stripping `position` from inline
  // styles is pointless if <div class="compose-panel"> is handed position:fixed
  // and a full-viewport z-index by our own stylesheet just for naming it.
  const OVERLAY_CLASSES = ['compose-panel', 'info-modal-overlay', 'preview-panel', 'toast'];

  for (const cls of OVERLAY_CLASSES) {
    it('removes class="' + cls + '"', () => {
      const out = H._sanitizeQuoteHtml('<div class="' + cls + '">x</div>');
      expect(parse(out).querySelector('div').hasAttribute('class')).toBe(false);
    });
  }

  it('removes id, which could shadow a real element for getElementById', () => {
    const out = H._sanitizeQuoteHtml('<div id="compose-panel">x</div>');
    expect(parse(out).querySelector('div').hasAttribute('id')).toBe(false);
  });

  it('strips them from nested elements too, not just the top level', () => {
    const out = H._sanitizeQuoteHtml('<div><p><span class="toast" id="x">t</span></p></div>');
    const span = parse(out).querySelector('span');
    expect(span.hasAttribute('class')).toBe(false);
    expect(span.hasAttribute('id')).toBe(false);
  });

  it('keeps the text and the inline formatting the quote is there for', () => {
    const out = H._sanitizeQuoteHtml('<div class="x" style="color:red">hello</div>');
    const div = parse(out).querySelector('div');
    expect(div.textContent).toBe('hello');
    expect(div.getAttribute('style')).toMatch(/color/);
  });

  it('does not resurrect a class on send', () => {
    const out = H._restoreQuoteUrls(H._sanitizeQuoteHtml('<div class="compose-panel">x</div>'));
    expect(parse(out).querySelector('div').hasAttribute('class')).toBe(false);
  });
});

describe('an embedded image in the quote is drawn, not left broken', () => {
  // A cid: resolves against the message being quoted, which the popup document
  // knows nothing about, so the reply editor drew a broken-image icon. The
  // bytes are already decrypted for the reading pane; use those, but send the
  // cid: back out, because the background re-attaches the part under that ID.
  const DATA = 'data:image/png;base64,AAA';

  it('shows the decrypted bytes and parks the reference', () => {
    inlineImages.set('abc@x.de', DATA);
    const img = parse(H._sanitizeQuoteHtml('<img src="cid:ABC@x.de">')).querySelector('img');
    expect(img.getAttribute('src')).toBe(DATA);
    expect(img.getAttribute('data-mcpm-cidsrc')).toBe('cid:ABC@x.de');
    inlineImages.clear();
  });

  it('puts the original cid: back on send', () => {
    inlineImages.set('abc@x.de', DATA);
    const out = H._restoreQuoteUrls(H._sanitizeQuoteHtml('<img src="cid:ABC@x.de">'));
    const img = parse(out).querySelector('img');
    expect(img.getAttribute('src')).toBe('cid:ABC@x.de');
    expect(img.hasAttribute('data-mcpm-cidsrc')).toBe(false);
    inlineImages.clear();
  });

  it('leaves an unresolved cid: alone rather than blanking it', () => {
    const img = parse(H._sanitizeQuoteHtml('<img src="cid:missing@x.de">')).querySelector('img');
    expect(img.getAttribute('src')).toBe('cid:missing@x.de');
  });

  it('refuses to restore anything that is not a cid:', () => {
    // The parked attribute round-trips through a contenteditable the user can
    // paste into, so its value is not trusted on the way back.
    const img = parse(H._restoreQuoteUrls('<img data-mcpm-cidsrc="javascript:alert(1)">')).querySelector('img');
    expect(img.hasAttribute('src')).toBe(false);
    expect(img.hasAttribute('data-mcpm-cidsrc')).toBe(false);
  });

  it('drops a data-mcpm-cidsrc that arrived in the message', () => {
    expect(H._sanitizeQuoteHtml('<img data-mcpm-cidsrc="cid:evil@x">')).not.toMatch(/data-mcpm-/);
  });
});

describe('the parking prefix cannot be forged by the incoming mail', () => {
  it('drops a data-mcpm- attribute that arrived in the message', () => {
    // Otherwise _restoreQuoteUrls would promote it to a real src that never
    // passed the javascript:/data:text/html check.
    const sanitized = H._sanitizeQuoteHtml('<img data-mcpm-src="javascript:alert(1)">');
    expect(sanitized).not.toMatch(/data-mcpm-/);
    const restored = parse(H._restoreQuoteUrls(sanitized)).querySelector('img');
    expect(restored.hasAttribute('src')).toBe(false);
  });

  it('still parks and restores a legitimate URL on the same element', () => {
    const html = '<img src="https://cdn.example/a.png" data-mcpm-src="javascript:alert(1)">';
    const restored = parse(H._restoreQuoteUrls(H._sanitizeQuoteHtml(html))).querySelector('img');
    expect(restored.getAttribute('src')).toBe('https://cdn.example/a.png');
  });
});
