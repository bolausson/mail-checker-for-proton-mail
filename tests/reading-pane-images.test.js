/**
 * @vitest-environment jsdom
 *
 * Reading-pane image gate.
 *
 * The banner exists to stop a sender learning that you opened their mail, so
 * the thing being gated is a NETWORK REQUEST, not an <img> tag. A `data:` URI
 * carries its own bytes and reaches nobody, yet the gate blocked every src that
 * was not `cid:` and so caught them too. That was visible on our own sent mail:
 * the composer embeds pasted images as `data:`, so a message we had just sent
 * came back reading "External images blocked" with the picture replaced by
 * "[image]", and clicking through was the only way to see something that had
 * never been remote.
 *
 * The neighbouring inline-style handler already keeps `url(data:...)` for this
 * reason, and the CSP admits `data:` while external content is blocked, so the
 * <img> gate was the odd one out rather than the strict one.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const SRC = readFileSync(join(__dirname, '..', 'popup', 'popup.js'), 'utf-8');

/** Slice `function NAME(...) { ... }` out of the source by balancing braces. */
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

const PNG = 'data:image/png;base64,iVBORw0KGgo=';

let gate;
let inlineImages;
beforeAll(() => {
  const body = [lift('_normalizeCid'), lift('_gateImages'), 'return _gateImages;'].join('\n\n');
  inlineImages = new Map();
  gate = new Function('_inlineImages', body)(inlineImages);
});

/** Run the gate over a fragment; returns { body, blocked }. */
function run(html, loadExternal = false) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const blocked = gate(doc, loadExternal);
  return { body: doc.body, blocked };
}

describe('data: images are not external', () => {
  it('keeps a data: image while external content is blocked', () => {
    const { body, blocked } = run('<img src="' + PNG + '">');
    expect(body.querySelector('img').getAttribute('src')).toBe(PNG);
    expect(blocked).toBe(false);
  });

  it('does not raise the banner for a data:-only message', () => {
    const { blocked } = run('<p>hi</p><img src="' + PNG + '"><img src="' + PNG + '">');
    expect(blocked).toBe(false);
  });

  it('matches the scheme case-insensitively and past leading space', () => {
    for (const src of ['DATA:image/png;base64,AAA', '  data:image/png;base64,AAA']) {
      const { body, blocked } = run('<img src="' + src + '">');
      expect(body.querySelector('img').hasAttribute('src')).toBe(true);
      expect(blocked).toBe(false);
    }
  });
});

describe('anything that would fetch is still withheld', () => {
  const remote = [
    ['https', 'https://tracker.example/px.gif'],
    ['http', 'http://tracker.example/px.gif'],
    ['protocol-relative', '//tracker.example/px.gif'],
  ];
  for (const [label, src] of remote) {
    it('stubs a remote image (' + label + ')', () => {
      const { body, blocked } = run('<img src="' + src + '">');
      const img = body.querySelector('img');
      expect(img.hasAttribute('src')).toBe(false);
      expect(img.getAttribute('alt')).toBe('[image]');
      expect(blocked).toBe(true);
    });
  }

  it('keeps an alt the message already had', () => {
    const { body } = run('<img src="https://x/y.png" alt="Company logo">');
    expect(body.querySelector('img').getAttribute('alt')).toBe('Company logo');
  });

  it('loads remote images once the user has opted in', () => {
    const { body, blocked } = run('<img src="https://x/y.png">', true);
    expect(body.querySelector('img').getAttribute('src')).toBe('https://x/y.png');
    expect(blocked).toBe(false);
  });
});

describe('srcset is gated independently of src', () => {
  it('strips a remote srcset even when src is an inert data: URI', () => {
    const { body, blocked } = run('<img src="' + PNG + '" srcset="https://x/y.png 2x">');
    const img = body.querySelector('img');
    expect(img.getAttribute('src')).toBe(PNG);
    expect(img.hasAttribute('srcset')).toBe(false);
    expect(blocked).toBe(true);
  });

  it('catches an img carrying srcset and no src at all', () => {
    // The src branch never sees this one: there is no src to test.
    const { body, blocked } = run('<img srcset="https://tracker.example/px.gif 1x">');
    expect(body.querySelector('img').hasAttribute('srcset')).toBe(false);
    expect(blocked).toBe(true);
  });

  it('leaves srcset alone after opt-in', () => {
    const { body } = run('<img src="' + PNG + '" srcset="https://x/y.png 2x">', true);
    expect(body.querySelector('img').getAttribute('srcset')).toBe('https://x/y.png 2x');
  });
});

describe('cid: parts still resolve from the decrypted attachment map', () => {
  it('swaps a resolved cid: for its data: URL without raising the banner', () => {
    inlineImages.set('abc', PNG);
    const { body, blocked } = run('<img src="cid:ABC">');
    expect(body.querySelector('img').getAttribute('src')).toBe(PNG);
    expect(blocked).toBe(false);
    inlineImages.clear();
  });

  it('drops an unresolved cid:, leaving the attachment list to show it', () => {
    const { body, blocked } = run('<img src="cid:missing">');
    expect(body.querySelector('img')).toBeNull();
    expect(blocked).toBe(false);
  });
});
