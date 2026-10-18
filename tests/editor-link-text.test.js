/**
 * Giving a link its own text.
 *
 * Before this, the link button asked only for an address. Selecting "FAQ" and
 * adding a URL used execCommand('createLink'), which can only ever reuse the
 * selected text verbatim; with nothing selected it inserted the raw address as
 * its own label. So there was no way to end up with FAQ pointing at
 * https://apps.olausson.de/sync_provider_for_proton/#faq except by typing the
 * word first and selecting it.
 *
 * Now the dialog asks for text and address together, and prefills the text
 * from the selection.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const ROOT = join(__dirname, '..');
const TOOLBAR = readFileSync(join(ROOT, 'popup', 'editor-toolbar.js'), 'utf-8');
const DIALOG = readFileSync(join(ROOT, 'lib', 'dialog.js'), 'utf-8');
const I18N = readFileSync(join(ROOT, 'lib', 'i18n.js'), 'utf-8');

const ProtonDialog = new Function(
  'window', 'document',
  DIALOG + '; return ProtonDialog;'
)(undefined, undefined);

describe('the dialog can ask for more than one value', () => {
  it('exposes form() alongside confirm() and prompt()', () => {
    expect(typeof ProtonDialog.form).toBe('function');
    expect(typeof ProtonDialog.prompt).toBe('function');
    expect(typeof ProtonDialog.confirm).toBe('function');
  });

  it('keeps prompt() resolving a bare string, not an object', () => {
    // Every existing caller destructures nothing and compares to null.
    expect(DIALOG).toContain('finish(input ? input.value : true)');
    expect(DIALOG).toMatch(/fields: \[\{ name: 'value'/);
  });

  it('resolves form() to an object keyed by field name', () => {
    expect(DIALOG).toContain('out[f.name] = inputs[i].value');
  });

  it('makes every field a tab stop, not just the first', () => {
    // A second field the user cannot Tab into is worse than no second field.
    expect(DIALOG).toContain('inputs.concat([cancelBtn, confirmBtn])');
  });

  it('labels fields with a real label element bound by id', () => {
    // Two unlabelled boxes are indistinguishable.
    expect(DIALOG).toContain("lab.setAttribute('for', el.id)");
  });
});

describe('prefilling the link text from the selection', () => {
  it('reads the selected text before the dialog takes focus', () => {
    // The selection is gone once the dialog has focus, which is why the range
    // is cloned first; the text has to come off that clone.
    expect(TOOLBAR).toContain('range && !range.collapsed ? range.toString()');
  });

  it('offers an existing link its current text when editing', () => {
    expect(TOOLBAR).toContain('anchor ? anchor.textContent');
  });

  it('asks for text and address in that order', () => {
    const text = TOOLBAR.indexOf("name: 'text'");
    const url = TOOLBAR.indexOf("name: 'url'");
    expect(text).toBeGreaterThan(-1);
    expect(url).toBeGreaterThan(text); // "Link text" above "URL", as specified
  });
});

describe('applying the result', () => {
  it('no longer relies on createLink, which cannot relabel', () => {
    // createLink wraps the selection as-is, so an edited label would be
    // silently ignored.
    expect(TOOLBAR).not.toContain("execCommand('createLink'");
  });

  it('inserts an anchor carrying the chosen text', () => {
    expect(TOOLBAR).toContain('_escapeText(text || href)');
  });

  it('falls back to the address when no text was given', () => {
    // Keeps the old behaviour for someone who just pastes a URL.
    expect(TOOLBAR).toContain('text || href');
  });

  it('escapes both the address and the text', () => {
    // The text is user input landing in innerHTML.
    expect(TOOLBAR).toContain('_escapeAttr(href)');
    expect(TOOLBAR).toContain('_escapeText(');
  });

  it('still unwraps a link when the address is cleared', () => {
    expect(TOOLBAR).toContain('_unwrap(anchor)');
  });

  it('rewrites an existing link text only when it actually changed', () => {
    // Assigning textContent unconditionally would flatten an anchor wrapping
    // an image to a string and destroy it.
    expect(TOOLBAR).toContain("text !== (anchor.textContent || '').trim()");
  });
});

describe('the new strings are translated everywhere', () => {
  const LOCALES = 28;
  for (const key of ['linkText', 'linkTextPlaceholder', 'linkUrl', 'resizeImage']) {
    it(key + ' exists in all ' + LOCALES + ' locales', () => {
      expect(I18N.split(key + ':').length - 1).toBe(LOCALES);
    });
  }
});
