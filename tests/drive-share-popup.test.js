/**
 * @vitest-environment jsdom
 *
 * The custom link password field of the "Share via Proton Drive" panel
 * (popup/drive-share.js) keeps to Drive's 50-character limit
 * (MAX_SHARED_URL_PASSWORD_LENGTH). Drive's own sharing UI cannot save a
 * link's settings with a longer custom password.
 *
 * The field has no maxLength on purpose. In a masked field the browser would
 * silently cut a longer paste or drop, and the user would then hand
 * recipients a password the link does not have. Measuring a paste ourselves
 * goes wrong too: the browser drops a trailing line break before it inserts,
 * so a password that fits, copied with its line ending, would be refused.
 * So, like Drive's own sharing UI, the field takes any length, says so inline
 * while the value is too long, and "Choose files" refuses it.
 * background/drive.js enforces the same limit again; drive-routes.test.js
 * covers that side.
 */

import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

let PopupDriveShare;
let anchorings = 0; // positionPopup calls: the panel re-anchoring after a height change

beforeAll(() => {
  const src = readFileSync(join(__dirname, '..', 'popup', 'drive-share.js'), 'utf-8');
  // The panel is portaled through the editor-toolbar registry; a stub that
  // just mounts it is enough here. No date picker (PopupSendOptions) needed.
  const toolbarRegistry = {
    positionPopup() { anchorings += 1; },
    registerPopup() {}, unregisterPopup() {}, closeAllPopups() {},
  };
  const i18n = { t: (key) => key };
  PopupDriveShare = new Function(
    'PopupEditorToolbar', 'PopupSendOptions', 'ProtonI18n',
    src + '\nreturn PopupDriveShare;')(toolbarRegistry, undefined, i18n);
});

let toasts;
let chosen;
let control;

function openPanel() {
  document.querySelector('.drive-share-btn').click();
  return {
    input: document.querySelector('.drive-share-pw'),
    limit: document.querySelector('.drive-share-pw-error'),
    choose: document.querySelector('.drive-share-panel .btn-primary'),
  };
}

/** A paste event carrying `text`, the way the browser delivers one. */
function pasteEvent(text) {
  const e = new Event('paste', { bubbles: true, cancelable: true });
  Object.defineProperty(e, 'clipboardData', { value: { getData: () => text } });
  return e;
}

/** Set the value and fire the input event any edit (typing, paste, drop) fires. */
function edit(input, value) {
  input.value = value;
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

const isShown = (el) => !el.classList.contains('hidden');

beforeEach(() => {
  document.body.innerHTML = '';
  const toolbar = document.createElement('div');
  document.body.appendChild(toolbar);
  toasts = [];
  chosen = null;
  control = PopupDriveShare.mount({
    toolbar,
    requirePremium: () => true,
    showToast: (msg) => toasts.push(msg),
    getSettings: () => ({}),
    onChooseFiles: (options) => { chosen = options; },
  });
});

describe('the custom link password field', () => {
  it('has no maxLength, so the browser never cuts a paste or drop silently', () => {
    const { input } = openPanel();
    expect(input.hasAttribute('maxlength')).toBe(false);
  });

  it('never refuses a paste: 50 characters copied with their line ending go in', () => {
    const { input } = openPanel();
    const e = pasteEvent('a'.repeat(50) + '\r\n');
    input.dispatchEvent(e);
    expect(e.defaultPrevented).toBe(false);
    expect(toasts).toEqual([]);
  });

  it('says inline while the value is over 50, and stops at 50', () => {
    const { input, limit } = openPanel();
    expect(isShown(limit)).toBe(false);

    edit(input, 'a'.repeat(51));
    expect(isShown(limit)).toBe(true);
    expect(limit.textContent).toBe('drivePasswordTooLong');
    expect(input.getAttribute('aria-invalid')).toBe('true');

    edit(input, 'a'.repeat(50));
    expect(isShown(limit)).toBe(false);
    expect(input.hasAttribute('aria-invalid')).toBe(false);
  });

  it('re-anchors the panel when the message comes or goes, not on every keystroke', () => {
    const { input } = openPanel();
    const before = anchorings;
    edit(input, 'a'.repeat(51)); // message comes
    edit(input, 'a'.repeat(52)); // still shown
    expect(anchorings - before).toBe(1);
    edit(input, 'a'.repeat(50)); // message goes
    edit(input, 'a'.repeat(49));
    expect(anchorings - before).toBe(2);
  });

  it('never flags whitespace only: that is no password, whatever its length', () => {
    const { input, limit } = openPanel();
    edit(input, ' '.repeat(60));
    expect(isShown(limit)).toBe(false);
  });

  it('refuses a 60-character value on Choose files and hands nothing on', () => {
    const { input, choose } = openPanel();
    edit(input, 'c'.repeat(60));
    choose.click();
    expect(chosen).toBeNull();
    expect(toasts).toEqual(['drivePasswordTooLong']);
  });

  it('flags a longer value restored from a saved draft on open, and refuses it', () => {
    control.setValues({ permission: 'viewer', expirationDays: 30, customPassword: 'c'.repeat(60) });
    const { input, limit, choose } = openPanel();
    expect(input.value).toHaveLength(60);
    expect(isShown(limit)).toBe(true);
    choose.click();
    expect(chosen).toBeNull();
    expect(toasts).toEqual(['drivePasswordTooLong']);
  });

  it('hands a 50-character password through unchanged', () => {
    const { input, choose } = openPanel();
    edit(input, 'd'.repeat(50));
    choose.click();
    expect(toasts).toEqual([]);
    expect(chosen).toMatchObject({ customPassword: 'd'.repeat(50) });
  });
});
