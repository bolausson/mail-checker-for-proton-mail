/**
 * @vitest-environment jsdom
 *
 * "Plain text" as the message preview format showed the raw message source.
 *
 * The options page stores previewFormat 'plaintext' (as it does for the
 * editor formats), while the popup's preview has three modes called 'html',
 * 'text' and 'raw'. The popup took the stored value as the mode, and
 * 'plaintext' is neither 'html' nor 'text', so it fell through to RAW. Only a
 * Pro user could see it: the free plan always opened as 'text'.
 *
 * 'plaintext' stays the stored value (every install, export and synced copy
 * already holds it); 'text' is accepted wherever the setting is read.
 *
 * House style: the functions under test are lifted out of popup.js by name
 * and run with their dependencies injected.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const ROOT = join(__dirname, '..');
const read = (rel) => readFileSync(join(ROOT, rel), 'utf-8');
const POPUP = read('popup/popup.js');
const ProtonProSettings = new Function(read('lib/pro-settings.js') + '; return ProtonProSettings;')();

// Index just past a string literal or line comment starting at i.
function skipLiteral(src, i) {
  const c = src[i];
  if (c === '/' && src[i + 1] === '/') {
    const nl = src.indexOf('\n', i);
    return nl === -1 ? src.length : nl;
  }
  if (c === '\'' || c === '"' || c === '`') {
    let j = i + 1;
    while (j < src.length && src[j] !== c) j += src[j] === '\\' ? 2 : 1;
    return j + 1;
  }
  return i;
}

function lift(name) {
  const m = new RegExp('(async )?function ' + name + '\\(').exec(POPUP);
  if (!m) throw new Error('function not found in popup.js: ' + name);
  let depth = 0;
  for (let i = POPUP.indexOf('{', POPUP.indexOf(') {', m.index)); i < POPUP.length; i++) {
    const next = skipLiteral(POPUP, i);
    if (next !== i) { i = next - 1; continue; }
    if (POPUP[i] === '{') depth++;
    else if (POPUP[i] === '}') { depth--; if (depth === 0) return POPUP.slice(m.index, i + 1); }
  }
  throw new Error('unbalanced braces reading ' + name);
}

const NAMES = ['_previewModeFor', '_updatePreviewModeIndicator', '_renderPreviewBody',
  'extractTextFromHtml', 'displayDecryptedBody'];

/** The popup's preview for a user with `stored` settings, Premium or not. */
function preview(stored, premium) {
  document.body.innerHTML = '<span id="preview-mode-indicator"></span><div id="body"></div><div id="banner"></div>';
  const mounted = [];
  const env = {
    document, window,
    isPremium: () => premium,
    _settings: ProtonProSettings.inEffect(stored, premium),
    previewBody: document.getElementById('body'),
    externalContentBanner: document.getElementById('banner'),
    _updateCanvasButton: () => {},
    _resolveInlineImages: () => {},
    _previewBgColor: () => '#fff',
    _buildEmailDocument: (body) => ({ srcdoc: body, hasExternalContent: false, forceLight: false }),
    _mountEmailIframe: (srcdoc) => mounted.push(srcdoc),
    _externalContentLoaded: false,
    _canvasOverride: null,
  };
  const src = 'const { ' + Object.keys(env).join(', ') + ' } = __env;\n' +
    'let _rawPreviewBody = null, _inlineImages = null, _previewMode = "html";\n' +
    NAMES.map(lift).join('\n\n') +
    '\nreturn { displayDecryptedBody, _previewModeFor, mode: () => _previewMode };';
  const api = new Function('__env', src)(env);
  return {
    api, mounted,
    show(body) {
      api.displayDecryptedBody(body, null, 'acc1');
      return {
        mode: api.mode(),
        indicator: document.getElementById('preview-mode-indicator').textContent,
        text: env.previewBody.textContent,
      };
    },
  };
}

const HTML_MAIL = '<html><body><p>Hello <b>world</b></p><p>Second line</p></body></html>';

describe('the stored preview format and the mode it opens in', () => {
  const { api } = preview({}, true);

  it('"Plain text" as the options page stores it, and the mode\'s own name', () => {
    expect(api._previewModeFor('plaintext')).toBe('text');
    expect(api._previewModeFor('text')).toBe('text');
  });

  it('HTML, the default, for HTML and for anything else', () => {
    expect(api._previewModeFor('html')).toBe('html');
    expect(api._previewModeFor(undefined)).toBe('html');
    expect(api._previewModeFor('')).toBe('html');
    // Never the raw source: that is only ever chosen with the toggle.
    expect(api._previewModeFor('raw')).toBe('html');
  });

  it('is what the options page offers and stores', () => {
    const html = read('options/options.html');
    const select = html.slice(html.indexOf('<select id="preview-format">'), html.indexOf('</select>', html.indexOf('id="preview-format"')));
    expect([...select.matchAll(/value="(\w+)"/g)].map((m) => m[1])).toEqual(['html', 'plaintext']);
    expect(ProtonProSettings.FREE_VALUES.previewFormat).toBe('plaintext');
  });
});

describe('a message opened with Pro', () => {
  it('"Plain text": the text of the mail, not its source (the bug)', () => {
    const shown = preview({ previewFormat: 'plaintext' }, true).show(HTML_MAIL);
    expect(shown.mode).toBe('text');
    expect(shown.indicator).toBe('TEXT');
    expect(shown.text).toBe('Hello world\n\nSecond line');
    expect(shown.text).not.toContain('<p>');
  });

  it('a stored \'text\' does the same', () => {
    const shown = preview({ previewFormat: 'text' }, true).show(HTML_MAIL);
    expect(shown.indicator).toBe('TEXT');
    expect(shown.text).not.toContain('<p>');
  });

  it('HTML: rendered, as before', () => {
    const p = preview({ previewFormat: 'html' }, true);
    const shown = p.show(HTML_MAIL);
    expect(shown.indicator).toBe('HTML');
    expect(p.mounted).toHaveLength(1);
  });
});

describe('a message opened on the free plan', () => {
  it('is plain text whatever the trial left', () => {
    for (const previewFormat of ['html', 'plaintext', 'text', undefined]) {
      const p = preview({ previewFormat }, false);
      const shown = p.show(HTML_MAIL);
      expect(shown.indicator, String(previewFormat)).toBe('TEXT');
      expect(p.mounted).toHaveLength(0);
    }
  });
});

describe('both places that open a message read the setting the same way', () => {
  it('opening the preview and showing the decrypted body', () => {
    const sites = POPUP.split('\n').filter((l) => /_previewMode = isPremium\(\)/.test(l)).map((l) => l.trim());
    expect(sites).toEqual([
      "_previewMode = isPremium() ? _previewModeFor(_settings.previewFormat) : 'text';",
      "_previewMode = isPremium() ? _previewModeFor(_settings.previewFormat) : 'text';",
    ]);
    expect(POPUP).not.toMatch(/_settings\.previewFormat \|\|/);
  });
});
