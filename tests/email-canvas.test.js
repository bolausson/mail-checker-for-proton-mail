/**
 * @vitest-environment jsdom
 *
 * Tests for ProtonEmailCanvas (lib/email-canvas.js): the dark-mode
 * "does this email paint its own background?" heuristic.
 *
 * Answering YES suppresses the popup's light-canvas fallback, so a wrong YES
 * leaves a `color:#000` email as black text on the dark popup canvas. That is
 * exactly what happened with mail composed in web.de/Outlook, which wraps
 * pasted text in <span style="background-color:#ffffff">. The old check
 * scanned body's children AND grandchildren for any background and counted
 * that span as the page canvas (reported 2026-07-25).
 *
 * These tests run in a real DOM (jsdom) so the structure under test is the one
 * DOMParser actually produces, mirroring _buildEmailDocument's contract:
 * <style> blocks are removed from the document and their CSS passed separately.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

let ProtonEmailCanvas;

beforeAll(() => {
  const code = readFileSync(join(__dirname, '..', 'lib', 'email-canvas.js'), 'utf-8');
  ProtonEmailCanvas = new Function(code + '\nreturn ProtonEmailCanvas;')();
});

/** Parse an email body the way _buildEmailDocument does. */
const parse = (html) => new DOMParser().parseFromString(html, 'text/html');
const hasCanvas = (html, css) => ProtonEmailCanvas.hasOwnCanvas(parse(html), css || '');

// The reported mail, reduced to its structure: four sibling divs that set
// `color:#000`, the first three wrapping their text in a white-highlight span,
// the last (the bulk of the text) with no background at all.
const WEB_DE_MAIL = `<html><body>
<div style="font-family: 'verdana'; font-size: 12px; color: #000;"><span style="background-color: #ffffff;">Hello,</span></div>
<div style="font-family: 'verdana'; font-size: 12px; color: #000;"><span style="background-color: #ffffff;">could you have a quick look at the text below and tell me whether it reads clearly enough?</span></div>
<div style="font-family: 'verdana'; font-size: 12px; color: #000;"><span style="background-color: #ffffff;">&nbsp;</span></div>
<div style="font-family: 'verdana'; font-size: 12px; color: #000;">
<p class="x_MsoNormal">The original wording of the paragraph is:</p>
<p class="x_MsoNormal"><strong>Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat, duis aute irure.</strong></p>
<p class="x_MsoNormal">Duis aute irure dolor in reprehenderit in voluptate velit esse cillum dolore eu fugiat nulla?</p>
<p class="x_MsoNormal">A: Excepteur sint occaecat cupidatat non proident, sunt in culpa qui officia deserunt mollit.</p>
<p class="x_MsoNormal">B: Nemo enim ipsam voluptatem quia voluptas sit aspernatur aut odit aut fugit, sed quia magni.</p>
<p class="x_MsoNormal">thanks</p><p class="x_MsoNormal">best</p><p class="x_MsoNormal">Alex</p>
</div>
</body></html>`;

describe('regression: highlighted spans are not a canvas', () => {
  it('reports NO own canvas for the reported web.de mail', () => {
    // A YES here is the bug: the mail would keep the dark canvas and its
    // color:#000 text would be unreadable.
    expect(hasCanvas(WEB_DE_MAIL)).toBe(false);
  });

  it('ignores a background on an inline element even when it wraps all text', () => {
    expect(hasCanvas('<body><div><span style="background-color:#fff">all of it</span></div></body>'))
      .toBe(false);
  });

  it('ignores <font>/<b>/<a> backgrounds', () => {
    expect(hasCanvas('<body><font style="background:#fff">x</font></body>')).toBe(false);
    expect(hasCanvas('<body><b style="background:#fff">x</b></body>')).toBe(false);
    expect(hasCanvas('<body><a href="#" style="background:#ff0">x</a></body>')).toBe(false);
  });
});

describe('genuine canvases are still detected', () => {
  it('inline background on <body>', () => {
    expect(hasCanvas('<body style="background-color:#111"><p>hi</p></body>')).toBe(true);
  });

  it('bgcolor attribute on <body>', () => {
    expect(hasCanvas('<body bgcolor="#f4f4f4"><p>hi</p></body>')).toBe(true);
  });

  it('body/html rule in the email CSS', () => {
    expect(hasCanvas('<body><p>hi</p></body>', 'body { background-color: #1a1a1a; color: #eee; }'))
      .toBe(true);
    expect(hasCanvas('<body><p>hi</p></body>', 'html{background:#000}')).toBe(true);
  });

  it('full-width wrapper div that holds all the text', () => {
    expect(hasCanvas('<body><div style="background:#ffffff"><p>one</p><p>two</p></div></body>'))
      .toBe(true);
  });

  it('deeply nested newsletter wrapper (div > table > tbody > tr > td[bgcolor])', () => {
    // The old two-level scan missed this; the wrapper walk finds it.
    expect(hasCanvas(
      '<body><div><table><tbody><tr><td bgcolor="#0b0b0b">' +
      '<p>newsletter body text</p></td></tr></tbody></table></div></body>')).toBe(true);
  });

  it('background shorthand with an image still counts as a canvas', () => {
    expect(hasCanvas('<body><div style="background: #ffffff url(x.png) no-repeat">text</div></body>'))
      .toBe(true);
  });

  it('image-only mail: first block wrapper with a background counts', () => {
    expect(hasCanvas('<body><div style="background:#123456"><img src="x.png"></div></body>'))
      .toBe(true);
  });
});

describe('partial backgrounds resolve toward the readable answer', () => {
  it('a dark hero banner over half the mail is not a canvas', () => {
    const html = '<body>' +
      '<div style="background:#111;color:#eee">' + 'hero '.repeat(20) + '</div>' +
      '<div style="color:#111">' + 'rest '.repeat(20) + '</div></body>';
    // Forcing a light canvas keeps the hero dark (it paints itself) AND makes
    // the #111 text below readable.
    expect(hasCanvas(html)).toBe(false);
  });

  it('a wrapper leaving a footer outside falls below the coverage bar', () => {
    const html = '<body>' +
      '<div style="background:#fff">' + 'main '.repeat(20) + '</div>' +
      '<div>' + 'footer '.repeat(4) + '</div></body>';
    expect(hasCanvas(html)).toBe(false);
  });

  it('a wrapper holding essentially everything still counts', () => {
    const html = '<body>' +
      '<div style="background:#fff">' + 'main '.repeat(200) + '</div>' +
      '<div>x</div></body>';
    expect(hasCanvas(html)).toBe(true);
  });

  it('sibling wrappers that each paint their own half are not a canvas', () => {
    const html = '<body>' +
      '<div style="background:#fff">' + 'a '.repeat(20) + '</div>' +
      '<div style="background:#fff">' + 'b '.repeat(20) + '</div></body>';
    // Harmless either way: both halves paint white regardless of the canvas.
    expect(hasCanvas(html)).toBe(false);
  });
});

describe('background value parsing', () => {
  it('non-painting keywords are not backgrounds', () => {
    for (const v of ['transparent', 'inherit', 'initial', 'unset', 'none', '', '  ']) {
      expect(ProtonEmailCanvas.isMeaningfulBg(v)).toBe(false);
    }
    expect(hasCanvas('<body style="background:transparent"><p>x</p></body>')).toBe(false);
    expect(hasCanvas('<body style="background-color:inherit"><p>x</p></body>')).toBe(false);
  });

  it('colours in any notation are backgrounds', () => {
    for (const v of ['#fff', '#ffffff', 'rgb(1,2,3)', 'rgba(0,0,0,.5)', 'white', 'hsl(0 0% 0%)']) {
      expect(ProtonEmailCanvas.isMeaningfulBg(v)).toBe(true);
    }
  });

  it('readBg prefers background-color over the shorthand', () => {
    expect(ProtonEmailCanvas.readBg('background:#000;background-color:#fff').trim()).toBe('#fff');
    expect(ProtonEmailCanvas.readBg('color:#333;background:#abc').trim()).toBe('#abc');
    // `background-position` must not be mistaken for a background colour.
    expect(ProtonEmailCanvas.readBg('background-position:center').trim()).toBe('');
  });

  it('cssPaintsCanvas only matches body/html rules', () => {
    expect(ProtonEmailCanvas.cssPaintsCanvas('body{background:#fff}')).toBe(true);
    expect(ProtonEmailCanvas.cssPaintsCanvas('.wrap{background:#fff}')).toBe(false);
    expect(ProtonEmailCanvas.cssPaintsCanvas('body{background:transparent}')).toBe(false);
    expect(ProtonEmailCanvas.cssPaintsCanvas('')).toBe(false);
  });
});

describe('robustness', () => {
  it('handles an empty document', () => {
    expect(hasCanvas('')).toBe(false);
    expect(ProtonEmailCanvas.hasOwnCanvas(null, '')).toBe(false);
    expect(ProtonEmailCanvas.hasOwnCanvas({}, 'body{background:#fff}')).toBe(true);
  });

  it('does not run away on deeply nested wrappers', () => {
    let html = '<p>deep</p>';
    for (let i = 0; i < 40; i++) html = '<div>' + html + '</div>';
    expect(hasCanvas('<body>' + html + '</body>')).toBe(false);
  });
});
