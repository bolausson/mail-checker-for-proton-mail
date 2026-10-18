/**
 * "Saved at HH:MM" beside the Send button.
 *
 * The draft autosave already worked; it just never said so, and a save that
 * quietly fails looks exactly like one that worked. The label is therefore
 * driven from _noteDraftSave, the one place that knows whether the write
 * actually persisted, rather than from the debounce that merely attempts it.
 * Claiming a save that did not happen would be worse than showing nothing.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const ROOT = join(__dirname, '..');
const POPUP = readFileSync(join(ROOT, 'popup', 'popup.js'), 'utf-8');
const HTML = readFileSync(join(ROOT, 'popup', 'popup.html'), 'utf-8');
const CSS = readFileSync(join(ROOT, 'popup', 'popup.css'), 'utf-8');
const I18N = readFileSync(join(ROOT, 'lib', 'i18n.js'), 'utf-8');

describe('where it sits', () => {
  it('is in the compose header, immediately before Send', () => {
    const at = HTML.indexOf('id="compose-saved-at"');
    const send = HTML.indexOf('id="btn-compose-send"');
    expect(at).toBeGreaterThan(-1);
    expect(send).toBeGreaterThan(at);
  });

  it('is in the reply actions row, immediately before Send', () => {
    const at = HTML.indexOf('id="reply-saved-at"');
    const send = HTML.indexOf('id="btn-reply-send"');
    expect(at).toBeGreaterThan(-1);
    expect(send).toBeGreaterThan(at);
  });

  it('announces changes to a screen reader without stealing focus', () => {
    expect(HTML).toContain('id="compose-saved-at" class="draft-saved-at" aria-live="polite"');
    expect(HTML).toContain('id="reply-saved-at" class="draft-saved-at" aria-live="polite"');
  });

  it('has a style, and a quiet one', () => {
    expect(CSS).toContain('.draft-saved-at');
    const rule = CSS.slice(CSS.indexOf('.draft-saved-at'), CSS.indexOf('.draft-saved-at') + 300);
    expect(rule).toContain('--text-secondary');
    // Wrapping would push the Send button around as the text appears.
    expect(rule).toContain('white-space: nowrap');
  });
});

describe('it only claims saves that happened', () => {
  it('updates from the success branch of _noteDraftSave', () => {
    const at = POPUP.indexOf('function _noteDraftSave');
    const fn = POPUP.slice(at, at + 500);
    expect(fn).toContain('_showSavedAt(Date.now())');
  });

  it('is not driven from the debounce, which only attempts a save', () => {
    const at = POPUP.indexOf('function _scheduleDraftSave');
    expect(POPUP.slice(at, at + 200)).not.toContain('_showSavedAt');
  });

  it('clears when the draft itself is dropped', () => {
    // A discarded or sent draft must not leave a save time implying one exists.
    const at = POPUP.indexOf('function _clearDraft');
    expect(POPUP.slice(at, at + 120)).toContain('_clearSavedAt()');
  });
});

describe('it survives a reopen', () => {
  it('stamps the draft on the way out', () => {
    expect(POPUP).toContain('draft.savedAt = Date.now()');
  });

  it('shows the stored time when either panel is restored', () => {
    // Otherwise a reopened draft reads as unsaved until the next keystroke.
    expect(POPUP.split('_showSavedAt(draft.savedAt)').length - 1).toBe(2);
  });
});

describe('the text itself', () => {
  it('is translated in all 28 locales', () => {
    expect(I18N.split('draftSavedAt:').length - 1).toBe(28);
  });

  it('carries the $1 placeholder the formatter substitutes', () => {
    const en = I18N.slice(I18N.indexOf('draftSavedAt:'), I18N.indexOf('draftSavedAt:') + 60);
    expect(en).toContain('$1');
  });

  it('formats an absolute local time, not a relative one', () => {
    // No ticking timer to keep "2 minutes ago" honest, and the question is
    // whether what is on screen is saved, not how long ago it was.
    const at = POPUP.indexOf('function _showSavedAt');
    const fn = POPUP.slice(at, at + 500);
    expect(fn).toContain('toLocaleTimeString');
    expect(fn).toContain("hour: '2-digit'");
    expect(fn).toContain("minute: '2-digit'");
    // 24-hour regardless of locale. Left to the browser this rendered
    // "12:39 AM" on an en-US profile.
    expect(fn).toContain("hourCycle: 'h23'");
  });

  it('cannot throw a label failure into the save path', () => {
    const at = POPUP.indexOf('function _showSavedAt');
    expect(POPUP.slice(at, at + 500)).toContain('catch');
  });
});
