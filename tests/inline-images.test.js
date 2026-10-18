/**
 * Embedded (cid:) image handling.
 *
 * A message from Proton's Android app carries its screenshot as an attachment
 * with `Content-Disposition: inline` and a Content-ID, referenced from the HTML
 * body as <img src="cid:...">. Two independent filters used to hide it: the
 * renderer dropped every cid: image because inline resolution was unimplemented,
 * and the attachment list skipped anything inline-with-a-cid on the assumption
 * the body had drawn it. Together the picture vanished from the message.
 *
 * popup.js is a DOM-bound IIFE, so the pure helpers are lifted out of the source
 * by name and evaluated on their own (same idea as free-tier-gate.test.js).
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

let H;
beforeAll(() => {
  const names = ['_normalizeCid', '_cidRefs', '_isEmbeddedPart', '_emlPart', '_buildEml',
    '_wrapB64', '_b64Utf8Wrapped', '_emlHeaders'];
  const body = names.map(lift).join('\n\n') +
    '\nreturn {' + names.join(',') + '};';
  H = new Function(body)();
});

/** Minimal MIME walker: returns a nested {type, disposition, cid, children}. */
function parseMime(raw) {
  const CRLF = '\r\n';
  const split = (s) => {
    const i = s.indexOf(CRLF + CRLF);
    return i === -1 ? [s, ''] : [s.slice(0, i), s.slice(i + 4)];
  };
  const walk = (chunk) => {
    const [head, body] = split(chunk);
    const unfolded = head.split(CRLF).reduce((acc, l) => {
      if (/^[ \t]/.test(l) && acc.length) acc[acc.length - 1] += ' ' + l.trim();
      else acc.push(l);
      return acc;
    }, []);
    const get = (n) => {
      const line = unfolded.find((l) => l.toLowerCase().startsWith(n + ':'));
      return line ? line.slice(n.length + 1).trim() : '';
    };
    const ct = get('content-type');
    const node = {
      type: ct.split(';')[0].trim().toLowerCase(),
      disposition: get('content-disposition').split(';')[0].trim().toLowerCase(),
      cid: get('content-id'),
      children: [],
    };
    const b = /boundary\s*=\s*"([^"]+)"/i.exec(ct);
    if (b) {
      for (const seg of body.split('--' + b[1])) {
        const t = seg.replace(/^\r\n/, '').replace(/\r\n$/, '');
        if (!t.trim() || t.trim() === '--') continue;
        if (!/content-type:/i.test(t)) continue; // preamble
        node.children.push(walk(t));
      }
    }
    return node;
  };
  return walk(raw);
}

const CID = '8d154141-6044-4282-bf71-a7efc1d5e3c1';
const msg = {
  MIMEType: 'text/html',
  Subject: 'inline image',
  Header: 'From: Alex Example <alex@example.com>\r\nSubject: inline image',
  DecryptedBody: '<div>Hi</div><img class="proton-embedded" src="cid:' + CID + '">',
};
const imagePart = {
  name: 'Screenshot.jpg', mime: 'image/jpeg', b64: 'AAAA',
  cid: '<' + CID + '>', disp: 'inline',
};
const filePart = { name: 'notes.pdf', mime: 'application/pdf', b64: 'BBBB', cid: '', disp: 'attachment' };

describe('cid normalisation', () => {
  it('strips angle brackets, whitespace and case', () => {
    expect(H._normalizeCid('  <ABC-123>  ')).toBe('abc-123');
  });
  it('decodes percent-escapes so a quoted src still matches the header', () => {
    expect(H._normalizeCid('a%40b.com')).toBe('a@b.com');
  });
  it('survives a malformed escape rather than throwing', () => {
    expect(H._normalizeCid('100%-sure')).toBe('100%-sure');
  });
  it('returns empty for nothing', () => {
    expect(H._normalizeCid(undefined)).toBe('');
  });
});

describe('finding cid: references in a body', () => {
  it('finds the reference Proton Android actually emits', () => {
    const refs = H._cidRefs(msg.DecryptedBody);
    expect([...refs]).toEqual([CID]);
  });
  it('handles single quotes, unquoted values and mixed case', () => {
    const html = "<IMG SRC='cid:One'><img src=cid:Two><img src=\"cid:THREE\">";
    expect([...H._cidRefs(html)].sort()).toEqual(['one', 'three', 'two']);
  });
  it('ignores ordinary and data images', () => {
    const html = '<img src="https://x/y.png"><img src="data:image/png;base64,AA">';
    expect(H._cidRefs(html).size).toBe(0);
  });
  it('finds a cid when other attributes come first', () => {
    expect([...H._cidRefs('<img class="proton-embedded" width="10" src="cid:Zed">')]).toEqual(['zed']);
  });
});

describe('classifying a part for export', () => {
  it('treats an inline part with a Content-ID as embedded', () => {
    expect(H._isEmbeddedPart(imagePart)).toBe(true);
  });
  it('treats an image with a Content-ID but no disposition as embedded', () => {
    expect(H._isEmbeddedPart({ ...imagePart, disp: '' })).toBe(true);
  });
  it('keeps an explicit attachment as an attachment even with a Content-ID', () => {
    expect(H._isEmbeddedPart({ ...imagePart, disp: 'attachment; filename="x.jpg"' })).toBe(false);
  });
  it('never treats a part without a Content-ID as embedded', () => {
    expect(H._isEmbeddedPart(filePart)).toBe(false);
  });
  it('does not embed a non-image that merely carries a Content-ID', () => {
    expect(H._isEmbeddedPart({ ...filePart, cid: '<x>', disp: '' })).toBe(false);
  });
});

describe('exported .eml structure', () => {
  it('nests the body and the embedded image in multipart/related', () => {
    const tree = parseMime(H._buildEml(msg, [imagePart]));
    expect(tree.type).toBe('multipart/mixed');
    expect(tree.children.map((c) => c.type)).toEqual(['multipart/related']);
    const rel = tree.children[0];
    expect(rel.children.map((c) => c.type)).toEqual(['text/html', 'image/jpeg']);
  });

  it('marks the embedded image inline and keeps its Content-ID', () => {
    const tree = parseMime(H._buildEml(msg, [imagePart]));
    const img = tree.children[0].children[1];
    expect(img.disposition).toBe('inline');
    expect(img.cid).toBe('<' + CID + '>');
  });

  it('keeps real attachments in multipart/mixed, beside the related part', () => {
    const tree = parseMime(H._buildEml(msg, [imagePart, filePart]));
    expect(tree.children.map((c) => c.type)).toEqual(['multipart/related', 'application/pdf']);
    expect(tree.children[1].disposition).toBe('attachment');
  });

  it('omits the related wrapper when nothing is embedded', () => {
    const tree = parseMime(H._buildEml(msg, [filePart]));
    expect(tree.children.map((c) => c.type)).toEqual(['text/html', 'application/pdf']);
  });

  it('still produces a valid single-part message with no attachments at all', () => {
    const tree = parseMime(H._buildEml(msg, []));
    expect(tree.children.map((c) => c.type)).toEqual(['text/html']);
  });

  it('every cid referenced by the body resolves to an exported part', () => {
    const eml = H._buildEml(msg, [imagePart]);
    const tree = parseMime(eml);
    const ids = new Set(
      tree.children[0].children.filter((c) => c.cid).map((c) => H._normalizeCid(c.cid))
    );
    for (const ref of H._cidRefs(msg.DecryptedBody)) expect(ids.has(ref)).toBe(true);
  });
});
