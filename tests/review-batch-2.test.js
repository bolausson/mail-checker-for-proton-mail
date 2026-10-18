/**
 * @vitest-environment jsdom
 *
 * Fixes for the second batch of adversarial-review findings. Each block names
 * the defect it pins, because several of these are subtle enough that the code
 * reads as correct without knowing what went wrong.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const POPUP = readFileSync(join(__dirname, '..', 'popup', 'popup.js'), 'utf-8');
const ACCOUNTS = readFileSync(join(__dirname, '..', 'background', 'accounts.js'), 'utf-8');

function lift(src, name) {
  let start = src.indexOf('async function ' + name + '(');
  if (start === -1) start = src.indexOf('function ' + name + '(');
  if (start === -1) throw new Error('not found: ' + name);
  let i = src.indexOf('{', start);
  let depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) return src.slice(start, i + 1); }
  }
  throw new Error('unbalanced braces reading ' + name);
}

describe('Content-ID case is preserved on the wire', () => {
  // A Content-ID is an RFC 5322 msg-id: its local part is case-SENSITIVE.
  // Outlook emits uppercase hex, so uploading a lowercased copy while the body
  // kept the original meant the recipient could not resolve the part, breaking
  // exactly the images this feature exists to carry.
  let rawCid, bareCid;
  beforeAll(() => {
    rawCid = new Function(lift(ACCOUNTS, '_rawCid') + '\nreturn _rawCid;')();
    bareCid = new Function(lift(ACCOUNTS, '_rawCid') + '\n' + lift(ACCOUNTS, '_bareCid') + '\nreturn _bareCid;')();
  });

  it('keeps the case for the value that is uploaded', () => {
    expect(rawCid('<image001.png@01DA1234.5678ABCD>')).toBe('image001.png@01DA1234.5678ABCD');
  });

  it('folds case only for matching', () => {
    expect(bareCid('<image001.png@01DA1234.5678ABCD>')).toBe('image001.png@01da1234.5678abcd');
  });

  it('still matches a body reference written in another case', () => {
    expect(bareCid('cid:ABC@X.de'.slice(4))).toBe(bareCid('<abc@x.de>'));
  });
});

describe('the cid scanner survives a > inside an earlier attribute', () => {
  let refs;
  beforeAll(() => {
    refs = new Function(
      lift(ACCOUNTS, '_rawCid') + '\n' + lift(ACCOUNTS, '_bareCid') + '\n' +
      lift(ACCOUNTS, '_cidRefsIn') + '\nreturn _cidRefsIn;')();
  });

  it('finds the cid when alt contains a literal >', () => {
    // Legal HTML, and the old [^>]* ended the scan before src was reached, so
    // the part was never re-attached and the recipient got a broken image.
    expect([...refs('<img alt="1 > 2" src="cid:sig@x.de">')]).toEqual(['sig@x.de']);
  });

  it('finds it with several attributes and a > among them', () => {
    expect([...refs('<img title="3>2" width="10" src="cid:z@y">')]).toEqual(['z@y']);
  });

  it('is not fooled by a cid: written inside another attribute', () => {
    const out = [...refs('<img alt="src=cid:evil@x" src="cid:real@y">')];
    expect(out).toEqual(['real@y']);
  });

  it('still handles the ordinary shapes', () => {
    expect([...refs("<img src='cid:a@b'>")]).toEqual(['a@b']);
    expect([...refs('<img src=cid:c@d>')]).toEqual(['c@d']);
    expect(refs('<img src="https://x/y.png">').size).toBe(0);
  });
});

describe('a lost send response never deletes the message', () => {
  it('cleanup is skipped when the failure came from the send step', () => {
    // Proton converts a draft in place, so the same MessageID becomes the sent
    // mail, and this route is the PERMANENT delete. A 504 after the backend
    // committed would have destroyed a message the recipient already had.
    const fn = lift(ACCOUNTS, '_encryptAndSend');
    const guardAt = fn.indexOf("if (step !== 'send')");
    expect(guardAt).toBeGreaterThan(-1);
    // The only real call is inside the guarded block, after it.
    const callAt = fn.indexOf("'PUT', 'mail/v4/messages/delete'");
    expect(callAt).toBeGreaterThan(guardAt);
  });
});

describe('a 401 retry reports its own error', () => {
  it('only the refresh call sits inside the refresh catch', () => {
    // With the retry inside it, a 422 from a resent message was logged as a
    // refresh failure and surfaced as "Session expired, please sign in again".
    const catchAt = ACCOUNTS.indexOf('catch (refreshErr)');
    const retryAt = ACCOUNTS.indexOf('catch (retryErr)');
    expect(catchAt).toBeGreaterThan(-1);
    expect(retryAt).toBeGreaterThan(catchAt);
    // The refresh try holds the refresh and nothing else.
    // Anchored WITHOUT the closing paren: the call gained a third argument and
    // the old exact-match anchor silently stopped matching, leaving indexOf at
    // -1, the slice empty and this assertion passing while checking nothing.
    const refreshAt = ACCOUNTS.indexOf("await _refreshTokens(account, 'reactive'");
    expect(refreshAt).toBeGreaterThan(-1);
    expect(refreshAt).toBeLessThan(catchAt);
    const between = ACCOUNTS.slice(refreshAt, catchAt);
    expect(between).not.toMatch(/_rawRequest/);
  });
});

describe('calendar RSVP encodes UTF-8, not code points', () => {
  it('does not hand the ICS text straight to btoa', () => {
    // btoa throws above U+00FF (an emoji in a title) and silently emits Latin-1
    // for U+0080..U+00FF (an umlaut in the organizer name).
    expect(ACCOUNTS).not.toMatch(/btoa\(icsData\)/);
    expect(ACCOUNTS).toMatch(/TextEncoder\(\)\.encode\(icsData\)/);
  });
});

describe('the send diagnostic cannot borrow another account resolution', () => {
  it('the slot is keyed by account', () => {
    expect(ACCOUNTS).toMatch(/_lastSenderResolution\[accountId\] = \{/);
    expect(ACCOUNTS).toMatch(/_lastSenderResolution\[account\.id\]/);
  });
});

describe('base64 is validated before it can abort a send', () => {
  let inline;
  beforeAll(() => {
    inline = new Function('crypto', 'DOMParser',
      lift(POPUP, '_makeContentId') + '\n' + lift(POPUP, '_imageExtension') + '\n' +
      lift(POPUP, '_inlineDataUrlImages') + '\nreturn _inlineDataUrlImages;'
    )(globalThis.crypto, globalThis.DOMParser);
  });

  it('leaves a percent-escaped payload as a data: URI instead of converting it', () => {
    // atob() runs in the background inside the upload loop, outside any
    // per-attachment guard, so one bad character aborted the send AND deleted
    // the draft. Pasted HTML supplies these readily.
    const html = '<img src="data:image/png;base64,iVBORw0KGgo%3D">';
    const r = inline(html, 'a@b.com');
    expect(r.attachments).toHaveLength(0);
    expect(r.html).toBe(html);
  });

  it('rejects a URL-safe alphabet', () => {
    expect(inline('<img src="data:image/png;base64,ab-_cd==">', 'a@b.com').attachments).toHaveLength(0);
  });

  it('rejects a payload whose length is not a multiple of four', () => {
    expect(inline('<img src="data:image/png;base64,iVBORw0KGgoAX">', 'a@b.com').attachments).toHaveLength(0);
  });

  it('still converts a well-formed payload', () => {
    const r = inline('<img src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==">', 'a@b.com');
    expect(r.attachments).toHaveLength(1);
  });
});

describe('half-typed recipients reach the send', () => {
  it('the chip input exposes a commit, and both send paths call it', () => {
    // A chip is only made on Enter/Tab/comma or 150 ms after blur, and the send
    // click runs first, so the address was dropped and the user still saw
    // "Message sent".
    expect(POPUP).toMatch(/commitPending: _commitInput/);
    expect(POPUP).toMatch(/chipTo\.commitPending\(\); chipCc\.commitPending\(\); chipBcc\.commitPending\(\);/);
    expect(POPUP).toMatch(/chipForwardTo\.commitPending\(\); chipReplyCc\.commitPending\(\); chipReplyBcc\.commitPending\(\);/);
  });
});

describe('picked files are not taken when there is nowhere to put them', () => {
  it('the open-editor check happens before the destructive TAKE', () => {
    const fn = lift(POPUP, '_pickUpPendingAttachments');
    const guardAt = fn.indexOf('if (!isReplyMode && !composeOpen) return;');
    const takeAt = fn.indexOf('TAKE_PENDING_ATTACHMENTS');
    expect(guardAt).toBeGreaterThan(-1);
    expect(guardAt).toBeLessThan(takeAt);
  });
});

describe('srcset cannot smuggle a remote candidate past the gate', () => {
  let H;
  beforeAll(() => {
    // Rebuilt the same way tests/quote-sanitizer.test.js does.
    const src = POPUP;
    const sliceConst = (name) => {
      const start = src.indexOf('const ' + name + ' = ');
      const end = src.indexOf(']);', start);
      return src.slice(start, end + 3);
    };
    const body = [
      sliceConst('QUOTE_URL_ATTRS'), sliceConst('QUOTE_SAFE_STYLE_PROPS'),
      lift(src, '_sanitizeQuoteStyle'), lift(src, '_normalizeCid'),
      lift(src, '_sanitizeQuoteHtml'), lift(src, '_restoreQuoteUrls'),
      'return { _sanitizeQuoteHtml, _restoreQuoteUrls };',
    ].join('\n\n');
    H = new Function('document', 'DOMParser', '_externalContentLoaded', '_settings', '_inlineImages', body)(
      globalThis.document, globalThis.DOMParser, false, {}, new Map());
  });

  const parse = (html) => new DOMParser().parseFromString(html, 'text/html').body;

  it('parks a srcset whose FIRST candidate is data:', () => {
    // srcset is a candidate LIST, so the whole-value data: prefix test passed
    // and left the remote candidate live in the popup, which fetched it.
    const html = '<img srcset="data:image/gif;base64,R0lGOD 1x, https://tracker.example/px.gif 2x">';
    const img = parse(H._sanitizeQuoteHtml(html)).querySelector('img');
    expect(img.hasAttribute('srcset')).toBe(false);
    expect(img.getAttribute('data-mcpm-srcset')).toContain('tracker.example');
  });

  it('covers srcset on <source> inside <picture> too', () => {
    const html = '<picture><source srcset="data:image/gif;base64,AA 1x, https://evil/t.png 2x"></picture>';
    const out = H._sanitizeQuoteHtml(html);
    expect(out).not.toMatch(/\ssrcset=/);
  });

  it('restores it for the recipient copy on send', () => {
    const html = '<img srcset="data:image/gif;base64,R0lGOD 1x, https://cdn.example/a.png 2x">';
    const restored = parse(H._restoreQuoteUrls(H._sanitizeQuoteHtml(html))).querySelector('img');
    expect(restored.getAttribute('srcset')).toContain('cdn.example');
  });
});
