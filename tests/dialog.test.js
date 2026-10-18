/**
 * @vitest-environment jsdom
 *
 * The in-page modal that replaces window.confirm() and window.prompt().
 *
 * Chrome ignores the native dialogs inside extension pages: the call returns
 * at once, confirm() false and prompt() null, and nothing is ever shown. So
 * every confirmation in the extension silently did nothing in Chrome, and the
 * two draft guards did worse than nothing: a hard false meant the reply and
 * compose editors could not be closed at all.
 *
 * The first test here is the one that matters most and is the cheapest to get
 * wrong: an invariant that no shipped file calls the native dialogs again. The
 * rest exercise the replacement's behaviour.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';

const ROOT = join(__dirname, '..');
const SRC = readFileSync(join(ROOT, 'lib', 'dialog.js'), 'utf-8');

function loadDialog() {
  // The module is an IIFE assigned to a const; evaluate it and hand back the
  // object rather than relying on a global.
  return new Function('window', 'document', SRC + '\nreturn ProtonDialog;')(
    globalThis.window, globalThis.document
  );
}

// ── The invariant ───────────────────────────────────────────────────────────

describe('no shipped code calls the native dialogs', () => {
  const SKIP_DIRS = new Set(['node_modules', 'dist', 'tests', '.git', 'docs', 'scripts', 'web']);
  const SKIP_FILES = new Set(['openpgp.min.js', 'bcrypt.min.js', 'browser-polyfill.js', 'dialog.js']);

  function jsFiles(dir, out = []) {
    for (const entry of readdirSync(dir)) {
      if (SKIP_DIRS.has(entry)) continue;
      const p = join(dir, entry);
      if (statSync(p).isDirectory()) jsFiles(p, out);
      else if (entry.endsWith('.js') && !SKIP_FILES.has(entry)) out.push(p);
    }
    return out;
  }

  it('never calls confirm(), alert() or prompt() as a bare global', () => {
    // A bare call: not preceded by a dot (ProtonDialog.confirm) and not part of
    // a longer identifier (_confirmBulk, confirmation).
    const bare = /(^|[^.\w$])(confirm|alert|prompt)\s*\(/;
    // Excluding anything dot-prefixed also excluded the explicit global form,
    // which is the same bug written differently. Name the globals instead.
    const qualified = /\b(window|self|globalThis|top|parent)\s*\.\s*(confirm|alert|prompt)\s*\(/;
    const offenders = [];
    for (const file of jsFiles(ROOT)) {
      const text = readFileSync(file, 'utf-8');
      text.split('\n').forEach((line, i) => {
        if (/^\s*\*/.test(line)) return; // jsdoc continuation
        const code = line
          // String contents are not calls. code-patterns.js carries a
          // detection regex reading "confirm(?:ation)?" that looks like one.
          .replace(/'(?:[^'\\]|\\.)*'/g, "''")
          .replace(/"(?:[^"\\]|\\.)*"/g, '""')
          .replace(/`(?:[^`\\]|\\.)*`/g, '``')
          .replace(/\/\/.*$/, '')
          .replace(/\/\*.*?\*\//g, '');
        if (bare.test(code) || qualified.test(code)) {
          offenders.push(`${file.slice(ROOT.length + 1)}:${i + 1}  ${line.trim()}`);
        }
      });
    }
    expect(offenders).toEqual([]);
  });

  it('both extension pages load the dialog module', () => {
    for (const page of ['popup/popup.html', 'options/options.html']) {
      const html = readFileSync(join(ROOT, page), 'utf-8');
      expect(html, page).toMatch(/<script src="\.\.\/lib\/dialog\.js" defer><\/script>/);
    }
  });

  it('both extension pages link the dialog stylesheet', () => {
    // Without this the dialog still opens and still works, but unstyled and
    // dumped at the foot of the page: a <p> and two buttons in normal flow.
    for (const page of ['popup/popup.html', 'options/options.html']) {
      const html = readFileSync(join(ROOT, page), 'utf-8');
      expect(html, page).toMatch(/<link rel="stylesheet" href="\.\.\/lib\/dialog\.css">/);
    }
  });

  it('every class the module sets has a rule in that stylesheet', () => {
    const css = readFileSync(join(ROOT, 'lib', 'dialog.css'), 'utf-8');
    const used = new Set();
    for (const m of SRC.matchAll(/className = '([^']+)'/g)) {
      for (const cls of m[1].split(/\s+/)) if (cls.startsWith('pd-')) used.add(cls);
    }
    // Set via string concatenation for the destructive variant.
    used.add('pd-danger');
    expect(used.size).toBeGreaterThan(4);
    for (const cls of used) expect(css, cls).toMatch(new RegExp('\\.' + cls + '[\\s,{:.]'));
  });

  it('does not inject styles at runtime any more', () => {
    // The injected <style> was the whole failure: it has to succeed at the
    // moment the first dialog opens, and when it did not the dialog appeared
    // anyway, unreadable.
    expect(SRC).not.toMatch(/createElement\('style'\)/);
  });

  it('loads the dialog before the script that uses it', () => {
    const html = readFileSync(join(ROOT, 'popup', 'popup.html'), 'utf-8');
    expect(html.indexOf('lib/dialog.js')).toBeLessThan(html.indexOf('popup.js'));
    expect(html.indexOf('lib/dialog.js')).toBeLessThan(html.indexOf('editor-toolbar.js'));
  });
});

// ── Behaviour ───────────────────────────────────────────────────────────────

describe('confirm', () => {
  let Dialog;
  beforeEach(() => {
    document.body.innerHTML = '';
    document.head.innerHTML = '';
    globalThis.ProtonI18n = { t: (k) => k };
    Dialog = loadDialog();
  });
  afterEach(() => { delete globalThis.ProtonI18n; });

  function box() { return document.querySelector('.pd-backdrop'); }
  function buttons() {
    return {
      cancel: document.querySelector('.pd-cancel'),
      ok: document.querySelector('.pd-confirm'),
    };
  }

  it('shows a dialog rather than returning immediately', async () => {
    const p = Dialog.confirm('Delete this?');
    expect(box()).not.toBeNull();
    expect(document.querySelector('.pd-message').textContent).toBe('Delete this?');
    buttons().cancel.click();
    await p;
  });

  it('resolves true only when confirmed', async () => {
    const p = Dialog.confirm('Sure?');
    buttons().ok.click();
    expect(await p).toBe(true);
  });

  it('resolves false when cancelled', async () => {
    const p = Dialog.confirm('Sure?');
    buttons().cancel.click();
    expect(await p).toBe(false);
  });

  it('removes itself from the page once answered', async () => {
    const p = Dialog.confirm('Sure?');
    buttons().ok.click();
    await p;
    expect(box()).toBeNull();
  });

  it('renders the message as text, never as markup', async () => {
    const p = Dialog.confirm('<img src=x onerror=alert(1)>');
    expect(document.querySelector('.pd-message').querySelector('img')).toBeNull();
    expect(document.querySelector('.pd-message').textContent).toContain('<img');
    buttons().cancel.click();
    await p;
  });

  it('focuses the safe choice, so a stray Enter cannot delete anything', async () => {
    const p = Dialog.confirm('Delete everything?', { danger: true });
    expect(document.activeElement).toBe(buttons().cancel);
    buttons().cancel.click();
    await p;
  });

  it('marks a destructive action so it does not look routine', async () => {
    const p = Dialog.confirm('Delete?', { danger: true });
    expect(buttons().ok.classList.contains('pd-danger')).toBe(true);
    buttons().cancel.click();
    await p;
  });

  it('uses the caller"s labels when given', async () => {
    const p = Dialog.confirm('x', { confirmLabel: 'Discard', cancelLabel: 'Keep' });
    expect(buttons().ok.textContent).toBe('Discard');
    expect(buttons().cancel.textContent).toBe('Keep');
    buttons().cancel.click();
    await p;
  });
});

describe('keyboard', () => {
  let Dialog;
  beforeEach(() => {
    document.body.innerHTML = '';
    document.head.innerHTML = '';
    globalThis.ProtonI18n = { t: (k) => k };
    Dialog = loadDialog();
  });
  afterEach(() => { delete globalThis.ProtonI18n; });

  function press(key, opts) {
    const e = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...opts });
    document.dispatchEvent(e);
    return e;
  }

  it('Escape cancels', async () => {
    const p = Dialog.confirm('Sure?');
    press('Escape');
    expect(await p).toBe(false);
  });

  it('Enter presses the focused button, which starts as Cancel', async () => {
    // Confirming regardless of focus undid the point of focusing the safe
    // choice: Enter on a "delete permanently?" prompt would have deleted.
    const p = Dialog.confirm('Sure?');
    press('Enter');
    expect(await p).toBe(false);
  });

  it('Enter confirms once the user has tabbed to the confirm button', async () => {
    const p = Dialog.confirm('Sure?');
    document.querySelector('.pd-confirm').focus();
    press('Enter');
    expect(await p).toBe(true);
  });

  it('Space presses the focused button too', async () => {
    const p = Dialog.confirm('Sure?');
    press(' ');
    expect(await p).toBe(false);
  });

  it('Enter in the prompt field submits it', async () => {
    const p = Dialog.prompt('URL?');
    document.querySelector('.pd-input').value = 'https://x.test';
    press('Enter');
    expect(await p).toBe('https://x.test');
  });

  it('stops Escape reaching the popup, which would close the preview behind it', async () => {
    const seenByPopup = vi.fn();
    document.addEventListener('keydown', seenByPopup);
    const p = Dialog.confirm('Sure?');
    press('Escape');
    await p;
    expect(seenByPopup).not.toHaveBeenCalled();
    document.removeEventListener('keydown', seenByPopup);
  });

  it('swallows every key, not just the ones it handles', async () => {
    // The popup binds single-key shortcuts on document: 'e' archives, '#'
    // trashes, '!' reports phishing. They fired behind the modal, so the
    // message you were being asked about could be archived while you read the
    // question.
    const pageHandler = vi.fn();
    document.addEventListener('keydown', pageHandler);
    const p = Dialog.confirm('Archive this?');
    for (const k of ['e', '#', '!', 'j', 'k', 'Delete', 'a']) press(k);
    expect(pageHandler).not.toHaveBeenCalled();
    document.querySelector('.pd-cancel').click();
    await p;
    document.removeEventListener('keydown', pageHandler);
  });

  it('swallows keyup and keypress as well', async () => {
    const onUp = vi.fn();
    const onPress = vi.fn();
    document.addEventListener('keyup', onUp);
    document.addEventListener('keypress', onPress);
    const p = Dialog.confirm('Sure?');
    document.dispatchEvent(new KeyboardEvent('keyup', { key: 'e', bubbles: true }));
    document.dispatchEvent(new KeyboardEvent('keypress', { key: 'e', bubbles: true }));
    expect(onUp).not.toHaveBeenCalled();
    expect(onPress).not.toHaveBeenCalled();
    document.querySelector('.pd-cancel').click();
    await p;
    document.removeEventListener('keyup', onUp);
    document.removeEventListener('keypress', onPress);
  });

  it('lets keys through again once closed', async () => {
    const p = Dialog.confirm('Sure?');
    press('Escape');
    await p;
    const seenByPopup = vi.fn();
    document.addEventListener('keydown', seenByPopup);
    press('Escape');
    expect(seenByPopup).toHaveBeenCalled();
    document.removeEventListener('keydown', seenByPopup);
  });

  it('keeps Tab inside the dialog', async () => {
    const p = Dialog.confirm('Sure?');
    const cancel = document.querySelector('.pd-cancel');
    const ok = document.querySelector('.pd-confirm');
    expect(document.activeElement).toBe(cancel);
    press('Tab');
    expect(document.activeElement).toBe(ok);
    press('Tab');
    expect(document.activeElement).toBe(cancel);
    press('Tab', { shiftKey: true });
    expect(document.activeElement).toBe(ok);
    cancel.click();
    await p;
  });
});

describe('prompt', () => {
  let Dialog;
  beforeEach(() => {
    document.body.innerHTML = '';
    document.head.innerHTML = '';
    globalThis.ProtonI18n = { t: (k) => k };
    Dialog = loadDialog();
  });
  afterEach(() => { delete globalThis.ProtonI18n; });

  it('returns what was typed', async () => {
    const p = Dialog.prompt('URL?');
    const input = document.querySelector('.pd-input');
    input.value = 'https://example.com';
    document.querySelector('.pd-confirm').click();
    expect(await p).toBe('https://example.com');
  });

  it('returns null when dismissed, matching window.prompt', async () => {
    const p = Dialog.prompt('URL?');
    document.querySelector('.pd-cancel').click();
    expect(await p).toBeNull();
  });

  it('focuses the field so the user can just type', async () => {
    const p = Dialog.prompt('URL?');
    expect(document.activeElement).toBe(document.querySelector('.pd-input'));
    document.querySelector('.pd-cancel').click();
    await p;
  });
});

describe('serialisation', () => {
  let Dialog;
  beforeEach(() => {
    document.body.innerHTML = '';
    document.head.innerHTML = '';
    globalThis.ProtonI18n = { t: (k) => k };
    Dialog = loadDialog();
  });
  afterEach(() => { delete globalThis.ProtonI18n; });

  it('shows one dialog at a time, so neither answer lands on the wrong caller', async () => {
    const first = Dialog.confirm('First?');
    const second = Dialog.confirm('Second?');

    expect(document.querySelectorAll('.pd-backdrop')).toHaveLength(1);
    expect(document.querySelector('.pd-message').textContent).toBe('First?');

    document.querySelector('.pd-confirm').click();
    expect(await first).toBe(true);

    // The queued one takes over only now.
    await Promise.resolve();
    expect(document.querySelector('.pd-message').textContent).toBe('Second?');
    document.querySelector('.pd-cancel').click();
    expect(await second).toBe(false);
  });
});

describe('the module itself', () => {
  it('falls back to English when a string is missing, rather than showing a key', () => {
    document.body.innerHTML = '';
    document.head.innerHTML = '';
    globalThis.ProtonI18n = { t: (k) => k }; // the "missing" behaviour
    const Dialog = loadDialog();
    const p = Dialog.confirm('x');
    expect(document.querySelector('.pd-confirm').textContent).toBe('OK');
    expect(document.querySelector('.pd-cancel').textContent).toBe('Cancel');
    document.querySelector('.pd-cancel').click();
    delete globalThis.ProtonI18n;
    return p;
  });

  it('survives ProtonI18n not being loaded at all', () => {
    document.body.innerHTML = '';
    document.head.innerHTML = '';
    const Dialog = loadDialog();
    const p = Dialog.confirm('x');
    expect(document.querySelector('.pd-confirm').textContent).toBe('OK');
    document.querySelector('.pd-cancel').click();
    return p;
  });

  it('leaves nothing behind in the page after repeated use', async () => {
    document.body.innerHTML = '';
    document.head.innerHTML = '';
    globalThis.ProtonI18n = { t: (k) => k };
    const Dialog = loadDialog();
    for (let i = 0; i < 3; i++) {
      const p = Dialog.confirm('x');
      document.querySelector('.pd-cancel').click();
      await p;
    }
    expect(document.body.children).toHaveLength(0);
    delete globalThis.ProtonI18n;
  });

  it('sits above every other layer in both pages', () => {
    const css = readFileSync(join(ROOT, 'lib', 'dialog.css'), 'utf-8');
    const mine = Number(/z-index:\s*(\d+)/.exec(/\.pd-backdrop\s*\{[^}]*\}/.exec(css)[0])[1]);
    for (const page of ['popup/popup.css', 'options/options.css']) {
      const other = readFileSync(join(ROOT, page), 'utf-8');
      const zs = [...other.matchAll(/z-index:\s*(\d+)/g)].map(m => +m[1]);
      expect(mine, page).toBeGreaterThan(Math.max(0, ...zs));
    }
  });
});

// ── Anchored placement ──────────────────────────────────────────────────────

describe('placing the dialog under the control that opened it', () => {
  let Dialog;
  let boxW = 340;
  let boxH = 120;

  beforeEach(() => {
    document.body.innerHTML = '';
    document.head.innerHTML = '';
    globalThis.ProtonI18n = { t: (k) => k };
    Dialog = loadDialog();
    boxW = 340;
    boxH = 120;
    // jsdom gives every element a zero-sized box, and placement runs the moment
    // the dialog opens, so the sizes have to be in place beforehand.
    Object.defineProperty(document.documentElement, 'clientWidth', { value: 1000, configurable: true });
    Object.defineProperty(document.documentElement, 'clientHeight', { value: 600, configurable: true });
    Object.defineProperty(HTMLElement.prototype, 'offsetWidth', {
      get() { return this.classList.contains('pd-box') ? boxW : 0; }, configurable: true,
    });
    Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
      get() { return this.classList.contains('pd-box') ? boxH : 0; }, configurable: true,
    });
  });
  afterEach(() => { delete globalThis.ProtonI18n; });

  function anchorAt(rect) {
    const btn = document.createElement('button');
    document.body.appendChild(btn);
    btn.getBoundingClientRect = () => rect;
    return btn;
  }

  async function place(rect) {
    const p = Dialog.confirm('x', { anchor: anchorAt(rect) });
    const box = document.querySelector('.pd-box');
    const pos = { top: Number(box.style.top.replace('px', '')), left: Number(box.style.left.replace('px', '')) };
    document.querySelector('.pd-cancel').click();
    await p;
    return pos;
  }

  it('opts into anchored mode only when given an anchor', async () => {
    const p = Dialog.confirm('x', { anchor: anchorAt({ top: 100, bottom: 130, left: 40, right: 140 }) });
    expect(document.querySelector('.pd-backdrop').classList.contains('pd-anchored')).toBe(true);
    document.querySelector('.pd-cancel').click();
    await p;

    const q = Dialog.confirm('x');
    expect(document.querySelector('.pd-backdrop').classList.contains('pd-anchored')).toBe(false);
    document.querySelector('.pd-cancel').click();
    await q;
  });

  it('sits just below the anchor, left edges aligned', async () => {
    const pos = await place({ top: 100, bottom: 130, left: 40, right: 140 });
    expect(pos.top).toBe(138);  // 130 + 8 gap
    expect(pos.left).toBe(40);
  });

  it('flips above when there is no room below', async () => {
    boxH = 200;
    // Anchor near the foot of a 600px viewport: 530 + 8 + 200 overflows.
    const pos = await place({ top: 500, bottom: 530, left: 40, right: 140 });
    expect(pos.top).toBe(292);  // 500 - 8 - 200
  });

  it('stays below when it fits, even low on the page', async () => {
    boxH = 50;
    const pos = await place({ top: 500, bottom: 530, left: 40, right: 140 });
    expect(pos.top).toBe(538);
  });

  it('never hangs off the right edge', async () => {
    const pos = await place({ top: 100, bottom: 130, left: 900, right: 980 });
    expect(pos.left + boxW).toBeLessThanOrEqual(1000);
    expect(pos.left).toBe(652);  // 1000 - 340 - 8
  });

  it('never places it off the top', async () => {
    const pos = await place({ top: -50, bottom: -20, left: 40, right: 140 });
    expect(pos.top).toBeGreaterThanOrEqual(8);
  });

  it('keeps it on screen even when taller than the window', async () => {
    boxH = 900;
    const pos = await place({ top: 100, bottom: 130, left: 40, right: 140 });
    expect(pos.top).toBe(8);
  });

  it('ignores a bogus anchor rather than throwing', async () => {
    const p = Dialog.confirm('x', { anchor: {} });
    expect(document.querySelector('.pd-backdrop').classList.contains('pd-anchored')).toBe(false);
    document.querySelector('.pd-cancel').click();
    await p;
  });
});

describe('the destructive options-page dialogs are anchored', () => {
  const OPTS = readFileSync(join(ROOT, 'options', 'options.js'), 'utf-8');

  it('all three name an anchor element', () => {
    // Firefox sizes the options iframe to the full content height, so an
    // unanchored dialog centres in the whole document and lands off-screen.
    for (const key of ['confirmRemoveLicense', 'resetConfirm', 'resetAllDefaultsConfirm']) {
      const at = OPTS.indexOf(key);
      expect(at, key).toBeGreaterThan(-1);
      expect(OPTS.slice(at, at + 280), key).toMatch(/anchor:/);
    }
  });
});
