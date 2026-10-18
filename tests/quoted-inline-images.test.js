/**
 * Re-attaching the embedded images a quote still references.
 *
 * Replying to or forwarding a message that contains an inline image carried its
 * <img src="cid:..."> into the new body, but the part that Content-ID names
 * belongs to the PARENT message. The recipient cannot resolve it, so the image
 * arrived broken, while looking perfect to the sender whose own client resolves
 * the cid against the message being quoted.
 *
 * The scan is a regex rather than a DOM walk because a Chrome MV3 service
 * worker has no DOMParser, so the cases below pin the shapes real mail uses:
 * unquoted attributes, single quotes, angle-bracketed and percent-escaped
 * Content-IDs, and case differences between the body and the header.
 */

import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const SRC = readFileSync(join(__dirname, '..', 'background', 'accounts.js'), 'utf-8');

/** Slice `function NAME(...) { ... }` (optionally async) out by balancing braces. */
function lift(name) {
  let start = SRC.indexOf('async function ' + name + '(');
  if (start === -1) start = SRC.indexOf('function ' + name + '(');
  if (start === -1) throw new Error('function not found in accounts.js: ' + name);
  let i = SRC.indexOf('{', start);
  let depth = 0;
  for (; i < SRC.length; i++) {
    if (SRC[i] === '{') depth++;
    else if (SRC[i] === '}') { depth--; if (depth === 0) return SRC.slice(start, i + 1); }
  }
  throw new Error('unbalanced braces reading ' + name);
}

const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);

let H;
let getAttachment, decryptAttachment;
beforeAll(() => {
  const body = [
    lift('_rawCid'), lift('_bareCid'), lift('_cidRefsIn'), lift('_reattachQuotedImages'),
    'return { _rawCid, _bareCid, _cidRefsIn, _reattachQuotedImages };',
  ].join('\n\n');
  getAttachment = vi.fn(async () => PNG_BYTES.buffer);
  decryptAttachment = vi.fn(async () => PNG_BYTES);
  H = new Function('getAttachment', 'decryptAttachment', 'ProtonBinary', 'console', body)(
    (...a) => getAttachment(...a),
    (...a) => decryptAttachment(...a),
    { uint8ToBase64: (b) => Buffer.from(b).toString('base64') },
    { warn() {} },
  );
});

// The lifted function closes over these mocks for the whole file, so call
// counts would otherwise accumulate across tests.
beforeEach(() => {
  getAttachment.mockClear();
  decryptAttachment.mockClear();
});

/** A parent message carrying one embedded image. */
function parent(cidHeader, extra = {}) {
  return {
    Attachments: [{
      ID: 'att-1',
      Name: 'logo.png',
      MIMEType: 'image/png',
      KeyPackets: 'AAAA',
      Headers: { 'content-id': cidHeader },
      ...extra,
    }],
  };
}

describe('finding the cid: references in an outgoing body', () => {
  const cases = [
    ['double quotes', '<img src="cid:abc@x.de">'],
    ['single quotes', "<img src='cid:abc@x.de'>"],
    ['unquoted', '<img src=cid:abc@x.de>'],
    ['other attributes first', '<img width="10" alt="a" src="cid:abc@x.de" />'],
    ['uppercase scheme', '<img src="CID:ABC@x.de">'],
  ];
  for (const [label, html] of cases) {
    it('matches ' + label, () => {
      expect([...H._cidRefsIn(html)]).toEqual(['abc@x.de']);
    });
  }

  it('ignores images that are not cid:', () => {
    expect(H._cidRefsIn('<img src="https://x/y.png"><img src="data:image/png;base64,AA">').size).toBe(0);
  });

  it('collects several distinct references once each', () => {
    const refs = H._cidRefsIn('<img src="cid:a@x"><img src="cid:b@x"><img src="cid:a@x">');
    expect([...refs].sort()).toEqual(['a@x', 'b@x']);
  });
});

describe('normalising a Content-ID from either side', () => {
  it('strips angle brackets, case and percent-escapes', () => {
    expect(H._bareCid('<ABC@Proton.me>')).toBe('abc@proton.me');
    expect(H._bareCid('  a%40b.com  ')).toBe('a@b.com');
    expect(H._bareCid(undefined)).toBe('');
  });
});

describe('re-attaching what the quote references', () => {
  it('adds the parent part with the SAME cid the body names', async () => {
    const out = await H._reattachQuotedImages('acct', '<img src="cid:abc@x.de">', parent('<abc@x.de>'), []);
    expect(out).toHaveLength(1);
    expect(out[0].cid).toBe('abc@x.de');
    expect(out[0].type).toBe('image/png');
    expect(out[0].name).toBe('logo.png');
    expect(out[0].data).toBe(Buffer.from(PNG_BYTES).toString('base64'));
  });

  it('matches across the bracket and case difference between body and header', async () => {
    const out = await H._reattachQuotedImages('acct', '<img src="cid:ABC@X.de">', parent('<abc@x.de>'), []);
    expect(out).toHaveLength(1);
  });

  it('keeps the user\'s own attachments and appends to them', async () => {
    const mine = [{ name: 'report.pdf', type: 'application/pdf', data: 'AA' }];
    const out = await H._reattachQuotedImages('acct', '<img src="cid:abc@x.de">', parent('<abc@x.de>'), mine);
    expect(out).toHaveLength(2);
    expect(out[0].name).toBe('report.pdf');
  });

  it('does nothing when the quote was trimmed away', async () => {
    const out = await H._reattachQuotedImages('acct', '<p>no images here</p>', parent('<abc@x.de>'), []);
    expect(out).toHaveLength(0);
    expect(getAttachment).not.toHaveBeenCalled();
  });

  it('skips a parent part the body does not reference', async () => {
    const out = await H._reattachQuotedImages('acct', '<img src="cid:other@x.de">', parent('<abc@x.de>'), []);
    expect(out).toHaveLength(0);
  });

  it('does not duplicate an image already being uploaded under that cid', async () => {
    // The popup converts pasted data: images and gives them a cid of their own.
    const already = [{ name: 'image-1.png', type: 'image/png', data: 'AA', cid: 'abc@x.de' }];
    const out = await H._reattachQuotedImages('acct', '<img src="cid:abc@x.de">', parent('<abc@x.de>'), already);
    expect(out).toHaveLength(1);
  });

  it('ignores a parent attachment with no Content-ID', async () => {
    const p = { Attachments: [{ ID: 'a', Name: 'f.pdf', MIMEType: 'application/pdf', Headers: {} }] };
    const out = await H._reattachQuotedImages('acct', '<img src="cid:abc@x.de">', p, []);
    expect(out).toHaveLength(0);
  });

  it('sends the reply anyway when one image cannot be fetched', async () => {
    // A broken image is what the recipient got before this fix; a send that
    // throws would be a regression.
    getAttachment.mockRejectedValueOnce(new Error('HTTP 500'));
    const out = await H._reattachQuotedImages('acct', '<img src="cid:abc@x.de">', parent('<abc@x.de>'), []);
    expect(out).toHaveLength(0);
  });

  it('tolerates a parent with no attachments at all', async () => {
    expect(await H._reattachQuotedImages('acct', '<img src="cid:a@x">', {}, [])).toHaveLength(0);
    expect(await H._reattachQuotedImages('acct', '<img src="cid:a@x">', null, [])).toHaveLength(0);
  });
});
