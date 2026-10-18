/**
 * @vitest-environment jsdom
 *
 * Outgoing inline images: data: URI to cid: part.
 *
 * The composer produces <img src="data:image/png;base64,..."> for a pasted
 * image, and that is not portable email. Proven on 2026-08-07 by exporting the
 * same message from Gmail and from Proton's Sent folder: both .eml bodies
 * decoded to the identical 6202 characters, both containing the data: URI, and
 * Gmail still rendered nothing. The bytes arrive; Gmail's sanitiser drops them.
 *
 * The interoperable form is a separate MIME part with a Content-ID, referenced
 * as <img src="cid:...">. Proton's own client does exactly this (WebClients
 * helpers/message/messageDataUrl.ts), and its upload endpoint has no
 * Disposition field, so a non-empty ContentID is what marks a part embedded.
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

const B64 = 'iVBORw0KGgoAAAANSUhEUg==';
const PNG = 'data:image/png;base64,' + B64;
const GIF = 'data:image/gif;base64,R0lGODlhAQABAA==';

let inline;
beforeAll(() => {
  const body = [
    lift('_makeContentId'), lift('_imageExtension'), lift('_inlineDataUrlImages'),
    'return _inlineDataUrlImages;',
  ].join('\n\n');
  inline = new Function('crypto', 'DOMParser', body)(globalThis.crypto, globalThis.DOMParser);
});

function parse(html) {
  return new DOMParser().parseFromString(html, 'text/html').body;
}

describe('a pasted image becomes a real attachment', () => {
  it('replaces the data: URI with a cid: reference', () => {
    const r = inline('<p>hi</p><img src="' + PNG + '">', 'sender@example.org');
    expect(r.attachments).toHaveLength(1);
    const src = parse(r.html).querySelector('img').getAttribute('src');
    expect(src).toBe('cid:' + r.attachments[0].cid);
    expect(r.html).not.toContain('data:image');
  });

  it('carries the base64 payload and MIME type across unchanged', () => {
    const r = inline('<img src="' + PNG + '">', 'a@b.com');
    expect(r.attachments[0].data).toBe(B64);
    expect(r.attachments[0].type).toBe('image/png');
  });

  it('builds a Content-ID of 8 hex characters at the sender domain', () => {
    const r = inline('<img src="' + PNG + '">', 'sender@example.org');
    expect(r.attachments[0].cid).toMatch(/^[0-9a-f]{8}@example\.org$/);
  });

  it('strips the angle brackets of a "Name <addr>" sender', () => {
    // '>' is the Content-ID delimiter, so it must never reach the id itself.
    const r = inline('<img src="' + PNG + '">', 'Test User <sender@example.org>');
    expect(r.attachments[0].cid).toMatch(/^[0-9a-f]{8}@example\.org$/);
  });

  it('falls back to a usable domain when the sender is unknown', () => {
    // Compose passes an account LABEL, which need not be an address at all.
    for (const from of ['', 'Work', 'no-at-sign', 'x@', 'a@localhost']) {
      const r = inline('<img src="' + PNG + '">', from);
      expect(r.attachments[0].cid).toMatch(/^[0-9a-f]{8}@pm\.me$/);
    }
  });

  it('names the part from the MIME type', () => {
    const r = inline('<img src="' + PNG + '"><img src="' + GIF + '">', 'a@b.com');
    expect(r.attachments.map(a => a.name)).toEqual(['image-1.png', 'image-2.gif']);
  });

  it('prefers an alt that already looks like a filename', () => {
    const r = inline('<img alt="logo.png" src="' + PNG + '">', 'a@b.com');
    expect(r.attachments[0].name).toBe('logo.png');
  });

  it('ignores prose in alt, which would name the file "happy birthday"', () => {
    const r = inline('<img alt="happy birthday" src="' + PNG + '">', 'a@b.com');
    expect(r.attachments[0].name).toBe('image-1.png');
  });
});

describe('the same image is uploaded once', () => {
  it('collapses duplicate sources onto one attachment and one cid', () => {
    // A signature image repeated down a quoted thread.
    const r = inline('<img src="' + PNG + '"><p>q</p><img src="' + PNG + '">', 'a@b.com');
    expect(r.attachments).toHaveLength(1);
    const srcs = [...parse(r.html).querySelectorAll('img')].map(i => i.getAttribute('src'));
    expect(srcs[0]).toBe(srcs[1]);
    expect(srcs[0]).toBe('cid:' + r.attachments[0].cid);
  });

  it('keeps distinct images distinct', () => {
    const r = inline('<img src="' + PNG + '"><img src="' + GIF + '">', 'a@b.com');
    expect(r.attachments).toHaveLength(2);
    expect(r.attachments[0].cid).not.toBe(r.attachments[1].cid);
  });
});

describe('everything else is left exactly as it was', () => {
  it('returns the input untouched when there is no data: image', () => {
    const html = '<p>plain</p><img src="cid:existing@x"><img src="https://x/y.png">';
    const r = inline(html, 'a@b.com');
    expect(r.attachments).toHaveLength(0);
    expect(r.html).toBe(html);   // identical string, not merely equivalent
  });

  it('leaves a non-image data: URI alone', () => {
    const html = '<a href="data:text/plain;base64,QQ==">x</a>';
    const r = inline(html, 'a@b.com');
    expect(r.attachments).toHaveLength(0);
    expect(r.html).toBe(html);
  });

  it('leaves a percent-encoded data: image alone rather than corrupting it', () => {
    // Not base64, so the payload would not survive the attachment path.
    const html = '<img src="data:image/svg+xml,%3Csvg%2F%3E">';
    const r = inline(html, 'a@b.com');
    expect(r.attachments).toHaveLength(0);
    expect(r.html).toBe(html);
  });

  it('skips an empty payload', () => {
    const r = inline('<img src="data:image/png;base64,">', 'a@b.com');
    expect(r.attachments).toHaveLength(0);
  });

  it('preserves the surrounding markup and other attributes', () => {
    const r = inline('<div class="k"><img src="' + PNG + '" width="64" alt="x"></div>', 'a@b.com');
    const img = parse(r.html).querySelector('img');
    expect(img.getAttribute('width')).toBe('64');
    expect(parse(r.html).querySelector('div').className).toBe('k');
  });

  it('survives junk input', () => {
    expect(inline('', 'a@b.com').attachments).toHaveLength(0);
    expect(inline(null, 'a@b.com').html).toBe('');
  });
});
