/**
 * @vitest-environment jsdom
 *
 * Texts that said something untrue, found by reading the code for the 2.0.0
 * README:
 *
 *  1. The spellcheck hint told Chrome users to install a Firefox dictionary
 *     and set a pref in about:config. The setting only puts a lang attribute
 *     on the popup's editors; Firefox picks its dictionary from that, Chrome
 *     ignores it and checks the languages turned on in its own settings. The
 *     options page now says so on Chrome, and the popup's per-field language
 *     switchers, which do nothing there, are hidden on Chrome.
 *  2. The manifest description (the Chrome Web Store short description and
 *     the text in Firefox's add-on manager) listed Pro features as if free
 *     and promised "without opening a tab", which sign-in steps can break.
 *  3. The README said the password is "never sent or stored". An account so
 *     old its keys have no salt unlocks them with the password itself, which
 *     is then stored as the key password.
 *  4. One Serbian string was in Cyrillic beside its Latin neighbour.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const ROOT = join(__dirname, '..');
const read = (rel) => readFileSync(join(ROOT, rel), 'utf-8');
const POPUP = read('popup/popup.js');
const POPUP_HTML = read('popup/popup.html');
const OPTIONS = read('options/options.js');
const OPTIONS_HTML = read('options/options.html');
const MANIFEST_SRC = read('manifest.json');
const BUILD = read('scripts/build-chrome.js');

/** `function NAME(...) { ... }` out of `src`, by balancing braces. */
function lift(src, name) {
  const start = src.indexOf('function ' + name + '(');
  if (start === -1) throw new Error('not found: ' + name);
  let depth = 0;
  for (let i = src.indexOf('{', src.indexOf(')', start)); i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) return src.slice(start, i + 1); }
  }
  throw new Error('unbalanced braces reading ' + name);
}

function run(src, name, env) {
  const keys = Object.keys(env);
  return new Function(...keys, lift(src, name) + '\nreturn ' + name + ';')(...keys.map((k) => env[k]));
}

let strings;
beforeAll(() => {
  const code = read('lib/i18n.js').replace('return { setLanguage', 'return { _strings, setLanguage');
  const win = {};
  strings = new Function('window', 'self', code + '; return window.ProtonI18n || self.ProtonI18n || ProtonI18n;')(win, win)._strings;
});

// --- 1. Spellcheck ------------------------------------------------------------

describe('what the spellcheck language does', () => {
  it('sets only the lang attribute of the three editors', () => {
    const apply = lift(POPUP, '_applySpellcheckLang');
    expect(apply.match(/setAttribute\('([^']+)'/g)).toEqual([
      "setAttribute('lang'", "setAttribute('lang'", "setAttribute('lang'",
    ]);
  });
});

describe('the options page hint names the browser it runs in', () => {
  const BODY = OPTIONS_HTML.slice(OPTIONS_HTML.indexOf('<body>') + 6, OPTIONS_HTML.lastIndexOf('</body>'));

  function hint(isFirefox) {
    document.body.innerHTML = BODY;
    run(OPTIONS, '_applySpellcheckHint', { document, ProtonBrowserInfo: { isFirefox: () => isFirefox } })();
    return document.getElementById('spellcheck-language').closest('.option-group').querySelector('.option-hint');
  }

  it('Chrome gets its own hint', () => {
    expect(hint(false).getAttribute('data-i18n')).toBe('spellcheckHintChrome');
  });

  it('Firefox keeps the dictionary hint', () => {
    expect(hint(true).getAttribute('data-i18n')).toBe('spellcheckHint');
  });

  it('runs before the first translation pass', () => {
    const at = OPTIONS.indexOf('\n  _applySpellcheckHint();');
    expect(at).toBeGreaterThan(-1);
    expect(at).toBeLessThan(OPTIONS.indexOf('\n  loadSettings();'));
  });

  it('points Chrome users at the browser\'s own spell check languages', () => {
    expect(strings.en.spellcheckHintChrome).toContain('chrome://settings/languages');
    expect(strings.en.spellcheckHintChrome).not.toMatch(/about:config|Firefox/);
  });
});

describe('the popup\'s per-field language switchers', () => {
  const BODY = POPUP_HTML.slice(POPUP_HTML.indexOf('<body'), POPUP_HTML.lastIndexOf('</body>'));

  function switchers(isFirefox) {
    document.body.innerHTML = BODY.replace(/^<body[^>]*>/, '');
    run(POPUP, '_hideSpellcheckSwitchers', { document, ProtonBrowserInfo: { isFirefox: () => isFirefox } })();
    return [...document.querySelectorAll('.spellcheck-lang-select')];
  }

  it('are hidden on Chrome, with the separator in front of each', () => {
    const sels = switchers(false);
    expect(sels).toHaveLength(2);
    for (const sel of sels) {
      expect(sel.classList.contains('hidden')).toBe(true);
      expect(sel.previousElementSibling.classList.contains('editor-sep')).toBe(true);
      expect(sel.previousElementSibling.classList.contains('hidden')).toBe(true);
    }
  });

  it('stay on Firefox', () => {
    for (const sel of switchers(true)) {
      expect(sel.classList.contains('hidden')).toBe(false);
      expect(sel.previousElementSibling.classList.contains('hidden')).toBe(false);
    }
  });

  it('the popup loads the browser detection before popup.js', () => {
    const info = POPUP_HTML.indexOf('<script src="../lib/browser-info.js" defer></script>');
    expect(info).toBeGreaterThan(-1);
    expect(info).toBeLessThan(POPUP_HTML.indexOf('<script src="popup.js" defer></script>'));
  });
});

// --- 2. The manifest description ---------------------------------------------

describe('the manifest description', () => {
  const description = JSON.parse(MANIFEST_SRC).description;

  it('fits the Chrome Web Store short description (132 characters)', () => {
    expect([...description].length).toBeLessThanOrEqual(132);
  });

  it('separates the free basics from what Pro adds', () => {
    const pro = description.indexOf('Pro adds');
    expect(pro).toBeGreaterThan(0);
    // Pro features named before "Pro adds" would read as free.
    expect(description.slice(0, pro)).not.toMatch(/attachment|RSVP|calendar|compose|reply|multi/i);
  });

  it('promises nothing a sign-in step can break', () => {
    expect(description).not.toMatch(/without opening a tab/i);
  });

  it('goes into the Chrome build unchanged', () => {
    const transformManifest = new Function('POLYFILL_REL',
      lift(BUILD, 'transformManifest') + '\nreturn transformManifest;')('lib/browser-polyfill.js');
    expect(transformManifest(JSON.parse(MANIFEST_SRC)).description).toBe(description);
  });
});

// --- 3. README ----------------------------------------------------------------

describe('the README on passwords', () => {
  it('says the password never leaves the device, not that it is never stored', () => {
    const readme = read('README.md');
    expect(readme).toContain("- Sign-in uses Proton's SRP protocol, so your password never leaves your device.");
    expect(readme).not.toContain('never sent or stored');
  });

  it('because a key without a salt is unlocked with the password itself', () => {
    expect(read('background/auth.js')).toMatch(/\} else \{\s*keyPassword = password;/);
  });
});

// --- 4. Serbian -----------------------------------------------------------------

describe('the Serbian cache messages', () => {
  it('share the Latin script', () => {
    for (const key of ['cacheCleared', 'cacheClearFailed']) {
      expect(strings.sr[key]).not.toMatch(/[Ѐ-ӿ]/);
    }
    expect(strings.sr.cacheCleared).toBe('Keš obrisan');
  });
});
