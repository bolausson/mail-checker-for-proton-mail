/**
 * @vitest-environment jsdom
 *
 * The "Image attachments" setting (inline / attachment / both).
 *
 * This setting has existed in Settings for a long time, is stored, exported and
 * synced, and until now was read by nothing: a repo-wide search found it in
 * options.js, options.html and i18n.js and nowhere else. Every image was
 * attached as a file whichever of the three the user picked.
 *
 * Embedding writes a data: URI into the editor, which _inlineDataUrlImages then
 * converts to a cid: part on send. That is deliberate: one conversion, already
 * tested, rather than a second path that has to be kept in step with it.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const SRC = readFileSync(join(__dirname, '..', 'popup', 'popup.js'), 'utf-8');

function lift(name) {
  const start = SRC.indexOf('function ' + name + '(');
  if (start === -1) throw new Error('function not found in popup.js: ' + name);
  let i = SRC.indexOf('{', start);
  let depth = 0;
  for (; i < SRC.length; i++) {
    if (SRC[i] === '{') depth++;
    else if (SRC[i] === '}') { depth--; if (depth === 0) return SRC.slice(start, i + 1); }
  }
  throw new Error('unbalanced braces reading ' + name);
}

let plan, insert;
beforeAll(() => {
  plan = new Function(lift('_imageAttachPlan') + '\nreturn _imageAttachPlan;')();
  insert = new Function('document', lift('_insertInlineImage') + '\nreturn _insertInlineImage;')(
    globalThis.document);
});

const PNG = 'image/png';

describe('what each mode does with an image', () => {
  it('inline: draws it in the body and does NOT list it', () => {
    // The picture IS the message; listing it too would send it twice.
    expect(plan(PNG, 'inline', true)).toEqual({ embed: true, list: false });
  });

  it('both: draws it AND keeps it in the attachment row', () => {
    expect(plan(PNG, 'both', true)).toEqual({ embed: true, list: true });
  });

  it('attachment: leaves the body alone, which is the old behaviour', () => {
    expect(plan(PNG, 'attachment', true)).toEqual({ embed: false, list: true });
  });
});

describe('when embedding is impossible or wrong', () => {
  it('never embeds a non-image, whatever the mode says', () => {
    for (const mode of ['inline', 'both', 'attachment']) {
      expect(plan('application/pdf', mode, true)).toEqual({ embed: false, list: true });
    }
  });

  it('falls back to attaching in plain-text mode, which has no body', () => {
    expect(plan(PNG, 'inline', false)).toEqual({ embed: false, list: true });
    expect(plan(PNG, 'both', false)).toEqual({ embed: false, list: true });
  });

  it('attaches on an unrecognised or missing mode rather than losing the file', () => {
    for (const mode of [undefined, '', 'nonsense']) {
      expect(plan(PNG, mode, true)).toEqual({ embed: false, list: true });
    }
  });

  it('matches the MIME type case-insensitively', () => {
    expect(plan('IMAGE/JPEG', 'inline', true).embed).toBe(true);
  });

  it('treats a missing MIME type as a non-image', () => {
    expect(plan(undefined, 'inline', true)).toEqual({ embed: false, list: true });
  });
});

describe('the default is the same everywhere it is written down', () => {
  // Three separate literals decide it: the settings defaults (shared, in
  // lib/pro-settings.js), the value the options page selects when nothing is
  // stored, and the fallback the composer applies. If they drift, Settings
  // shows one mode while sending does another, which is a quieter version of
  // the bug this whole feature came from.
  const OPTIONS = readFileSync(join(__dirname, '..', 'options', 'options.js'), 'utf-8');
  const DEFAULTS = readFileSync(join(__dirname, '..', 'lib', 'pro-settings.js'), 'utf-8');

  const defaults = () => {
    const found = [
      /imageAttachMode:\s*'([a-z]+)'/.exec(DEFAULTS),
      /imageAttachMode\.value\s*=\s*s\.imageAttachMode\s*\|\|\s*'([a-z]+)'/.exec(OPTIONS),
      /_settings\.imageAttachMode\s*\|\|\s*'([a-z]+)'/.exec(SRC),
    ];
    expect(found.every(Boolean)).toBe(true);
    return found.map(m => m[1]);
  };

  it('agrees across settings, options page and composer', () => {
    const [stored, shown, used] = defaults();
    expect(shown).toBe(stored);
    expect(used).toBe(stored);
  });

  it('is a mode the plan actually recognises', () => {
    const [stored] = defaults();
    expect(['inline', 'attachment', 'both']).toContain(stored);
  });

  it('is "attachment", so upgrading changes nothing for anyone', () => {
    // Deliberate: the options page has always displayed "Embed inline" as
    // selected, but the extension attached as a file, and that is what existing
    // users have. Honouring the label instead would silently move every user's
    // images out of the attachment row on upgrade.
    expect(defaults()[0]).toBe('attachment');
  });
});

describe('where the image is placed', () => {
  const DATA = 'data:image/png;base64,AAA';

  it('goes above the quote, into what the user is writing', () => {
    const body = document.createElement('div');
    body.innerHTML = '<div>typed</div><div class="protonmail_quote">quoted</div>';
    insert(body, DATA, 'logo.png');
    const kids = [...body.children];
    const imgHolder = kids.findIndex(el => el.querySelector('img'));
    const quote = kids.findIndex(el => el.classList.contains('protonmail_quote'));
    expect(imgHolder).toBeGreaterThanOrEqual(0);
    expect(imgHolder).toBeLessThan(quote);
  });

  it('appends when there is no quote', () => {
    const body = document.createElement('div');
    body.innerHTML = '<div>typed</div>';
    insert(body, DATA, 'logo.png');
    expect(body.lastElementChild.querySelector('img')).not.toBeNull();
  });

  it('carries the filename as alt, which becomes the MIME part name', () => {
    // _inlineDataUrlImages uses alt as the filename when it looks like one.
    const body = document.createElement('div');
    insert(body, DATA, 'logo.png');
    expect(body.querySelector('img').getAttribute('alt')).toBe('logo.png');
  });

  it('keeps the image inside the editor width', () => {
    const body = document.createElement('div');
    insert(body, DATA, 'x.png');
    expect(body.querySelector('img').style.maxWidth).toBe('100%');
  });
});
