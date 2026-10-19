/**
 * @vitest-environment jsdom
 *
 * CONTRACT A, the consumer half.
 *
 * background.js _fetchAndDecryptAttachment answers GET_ATTACHMENT with
 * { bytes, decrypted }. decrypted === false means the bytes are STILL PGP
 * ciphertext: the decrypt was skipped or it failed. tests/cold-start-keys.test.js
 * pins the producer side of that promise. Nothing pinned the four places in the
 * popup that have to act on it, which is the half that decides what the user
 * actually gets:
 *
 *  1. attachment-utils.js downloadAttachment would save ciphertext under the
 *     attachment's real name: a file that looks right and will not open.
 *  2. popup.js handleExportEml would embed a ciphertext part in the .eml, and
 *     (round 2) dropping it silently is its own trap, so the export has to say
 *     it lost parts while still producing the file.
 *  3. popup.js _resolveInlineImages would build a data: URL over ciphertext,
 *     which paints a broken image where the picture was.
 *  4. calendar-utils.js detectCalendarInvite would hand ciphertext, decoded as
 *     UTF-8, to parseICS.
 *
 * decrypted === false ALSO comes back when we never sent key packets (nothing
 * to decrypt), so every guard is gated on keyPackets. Each block below asserts
 * all three cases: refuse when it matters, proceed when the bytes are good, and
 * do not fire when no key packets were sent.
 *
 * The functions are lifted out of the real sources and run with injected
 * dependencies, the same way tests/cold-start-keys.test.js and
 * tests/inline-images.test.js do it. The DOM, URL and Blob handed to the popup
 * functions are recorders, so "no download happened" is an assertion about the
 * anchor and the object URL, not about a side effect we hope did not occur.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const ROOT = join(__dirname, '..');
const ATTACH = readFileSync(join(ROOT, 'popup', 'attachment-utils.js'), 'utf-8');
const POPUP = readFileSync(join(ROOT, 'popup', 'popup.js'), 'utf-8');
const CALENDAR = readFileSync(join(ROOT, 'popup', 'calendar-utils.js'), 'utf-8');

/** Slice `function NAME(...) { ... }` out of a source by balancing braces. */
function lift(src, name) {
  let start = src.indexOf('function ' + name + '(');
  if (start === -1) throw new Error('not found: ' + name);
  if (src.slice(start - 6, start) === 'async ') start -= 6;
  let i = src.indexOf('{', src.indexOf(')', start));
  let depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) return src.slice(start, i + 1); }
  }
  throw new Error('unbalanced braces reading ' + name);
}

/**
 * A recording stand-in for document / URL / Blob.
 *
 * The point of the whole file is proving that a refusal produced NOTHING, so
 * the download machinery has to be observable rather than merely absent.
 */
function makeDom() {
  const rec = { anchors: [], clicks: [], objectUrls: [], revoked: [] };
  const doc = {
    body: { appendChild() {}, removeChild() {} },
    createElement(tag) {
      const el = {
        tagName: String(tag).toUpperCase(),
        href: '',
        download: '',
        click() { rec.clicks.push({ href: el.href, download: el.download }); },
      };
      if (el.tagName === 'A') rec.anchors.push(el);
      return el;
    },
  };
  const urlShim = {
    createObjectURL(blob) {
      rec.objectUrls.push(blob);
      return 'blob:recorded/' + rec.objectUrls.length;
    },
    revokeObjectURL(u) { rec.revoked.push(u); },
  };
  function FakeBlob(parts, opts) {
    this.parts = parts;
    this.type = (opts && opts.type) || '';
    this.text = parts.map(p => String(p)).join('');
  }
  return { rec, document: doc, URL: urlShim, Blob: FakeBlob };
}

const i18n = { t: k => k, plural: (k, n) => n + ' ' + k };

// --- 1. downloadAttachment: never save ciphertext under the real filename ---

describe('downloadAttachment refuses bytes that came back undecrypted', () => {
  let build;

  beforeAll(() => {
    build = (sendMessage, dom) => new Function(
      'browser', 'ProtonI18n', 'document', 'URL', 'Blob',
      lift(ATTACH, 'downloadAttachment') + '\nreturn downloadAttachment;',
    )({ runtime: { sendMessage } }, i18n, dom.document, dom.URL, dom.Blob);
  });

  const att = { ID: 'att1', Name: 'payroll.pdf', MIMEType: 'application/pdf', KeyPackets: 'wcBMA0aYest' };
  const plainB64 = btoa('%PDF-1.7 payroll');

  function run(att2, reply) {
    const dom = makeDom();
    const toasts = [];
    const btn = { textContent: '⬇', disabled: false };
    const download = build(async () => reply, dom);
    return download(att2, 'acc1', btn, k => toasts.push(k), 'alice@example.com')
      .then(() => ({ dom, toasts, btn }));
  }

  it('creates no download and says so when decrypted is false', async () => {
    // The bytes are the PGP packet, base64'd: saving them as payroll.pdf is
    // worse than a visible failure, because the file looks fine until opened.
    const { dom, toasts, btn } = await run(att, { data: btoa('Á\u000e\u0003'), decrypted: false });

    expect(dom.rec.clicks).toHaveLength(0);
    expect(dom.rec.anchors).toHaveLength(0);
    expect(dom.rec.objectUrls).toHaveLength(0);
    expect(toasts).toEqual(['downloadFailed']);
    // The button is handed back to the user either way.
    expect(btn.disabled).toBe(false);
    expect(btn.textContent).toBe('⬇');
  });

  it('downloads normally when decrypted is true', async () => {
    const { dom, toasts } = await run(att, { data: plainB64, decrypted: true });

    expect(toasts).toEqual([]);
    expect(dom.rec.clicks).toEqual([{ href: 'blob:recorded/1', download: 'payroll.pdf' }]);
    expect(dom.rec.objectUrls).toHaveLength(1);
    expect(dom.rec.objectUrls[0].type).toBe('application/pdf');
    expect(dom.rec.revoked).toEqual(['blob:recorded/1']);
  });

  it('does not fire when no key packets were sent', async () => {
    // An unencrypted attachment answers decrypted: false because there was
    // nothing to decrypt. Refusing it would break plain attachments outright.
    const plain = { ID: 'att2', Name: 'notes.txt', MIMEType: 'text/plain' };
    const { dom, toasts } = await run(plain, { data: btoa('hello'), decrypted: false });

    expect(toasts).toEqual([]);
    expect(dom.rec.clicks).toEqual([{ href: 'blob:recorded/1', download: 'notes.txt' }]);
  });
});

// --- 2. handleExportEml: leave the part out, and say that you did ----------

describe('the .eml export drops undecrypted parts and tells the user', () => {
  // The real _buildEml chain is lifted too, so "left out of the .eml" is read
  // off the MIME the user would have received, not off an intermediate list.
  const NAMES = ['handleExportEml', '_safeEmlName', '_b64Utf8Wrapped', '_wrapB64',
    '_emlHeaders', '_isEmbeddedPart', '_emlPart', '_buildEml'];

  function build(replies, dom, toasts) {
    const body = NAMES.map(n => lift(POPUP, n)).join('\n\n') + '\nreturn handleExportEml;';
    const sendMessage = async (m) => replies[m.attachmentId];
    return new Function('browser', 'ProtonI18n', 'showToast', 'document', 'URL', 'Blob', body)(
      { runtime: { sendMessage } }, i18n, k => toasts.push(k), dom.document, dom.URL, dom.Blob);
  }

  const GOOD_B64 = btoa('good attachment bytes');
  const BAD_B64 = btoa('Á\u000e\u0003 still ciphertext');

  const msg = {
    Subject: 'Q3 numbers',
    MIMEType: 'text/html',
    Header: 'From: Alice <alice@example.com>\r\nSubject: Q3 numbers',
    DecryptedBody: '<p>See attached.</p>',
    Attachments: [
      { ID: 'ok', Name: 'numbers.xlsx', MIMEType: 'application/vnd.ms-excel', KeyPackets: 'kp1' },
      { ID: 'bad', Name: 'secret.pdf', MIMEType: 'application/pdf', KeyPackets: 'kp2' },
    ],
  };

  async function exportWith(replies, attachments) {
    const dom = makeDom();
    const toasts = [];
    const run = build(replies, dom, toasts);
    await run(null, attachments ? { ...msg, Attachments: attachments } : msg, 'acc1');
    return { dom, toasts, eml: dom.rec.objectUrls.length ? dom.rec.objectUrls[0].text : '' };
  }

  it('omits the ciphertext part, still writes the file, and warns', async () => {
    const { dom, toasts, eml } = await exportWith({
      ok: { data: GOOD_B64, decrypted: true },
      bad: { data: BAD_B64, decrypted: false },
    });

    // The good part is there in full.
    expect(eml).toContain('numbers.xlsx');
    expect(eml).toContain(GOOD_B64);
    // The undecrypted one is gone: neither its name nor its bytes.
    expect(eml).not.toContain('secret.pdf');
    expect(eml).not.toContain(BAD_B64);
    // The export still completes. An .eml missing one part is worth having.
    expect(dom.rec.clicks).toHaveLength(1);
    expect(dom.rec.clicks[0].download).toBe('Q3 numbers.eml');
    expect(dom.rec.objectUrls[0].type).toBe('message/rfc822');
    // Round 2: losing a part silently is the bug this line fixes. It is not
    // 'downloadFailed', because the file did download.
    expect(toasts).toEqual(['attachmentsSkipped']);
  });

  it('warns once, not once per lost part', async () => {
    const { toasts, eml } = await exportWith({
      ok: { data: GOOD_B64, decrypted: false },
      bad: { data: BAD_B64, decrypted: false },
    });
    expect(toasts).toEqual(['attachmentsSkipped']);
    expect(eml).not.toContain('numbers.xlsx');
    expect(eml).not.toContain('secret.pdf');
  });

  it('stays silent when every part decrypted', async () => {
    const { toasts, eml } = await exportWith({
      ok: { data: GOOD_B64, decrypted: true },
      bad: { data: BAD_B64, decrypted: true },
    });
    expect(toasts).toEqual([]);
    expect(eml).toContain('numbers.xlsx');
    expect(eml).toContain('secret.pdf');
  });

  it('does not fire for a part that never had key packets', async () => {
    const { toasts, eml } = await exportWith(
      { plain: { data: GOOD_B64, decrypted: false } },
      [{ ID: 'plain', Name: 'readme.txt', MIMEType: 'text/plain' }],
    );
    expect(toasts).toEqual([]);
    expect(eml).toContain('readme.txt');
    expect(eml).toContain(GOOD_B64);
  });

  it('tells a free user the attachments are a Premium part of the export', async () => {
    // GET_ATTACHMENT is not in FREE_ALLOWED, so for a free user every part
    // comes back refused. The .eml still downloads, without them, and the
    // toast says why instead of nothing at all.
    const refused = { error: 'PREMIUM_REQUIRED', feature: 'GET_ATTACHMENT' };
    const { dom, toasts, eml } = await exportWith({ ok: refused, bad: refused });
    expect(dom.rec.clicks).toHaveLength(1);
    expect(eml).not.toContain('numbers.xlsx');
    expect(eml).not.toContain('secret.pdf');
    expect(toasts).toEqual(['emlExportedWithoutAttachments']);
  });

  it('stays silent for a free user exporting a message without attachments', async () => {
    const { toasts } = await exportWith({}, []);
    expect(toasts).toEqual([]);
  });
});

// --- 3. _resolveInlineImages: no data: URL over ciphertext ------------------

describe('inline cid: images ignore parts that came back undecrypted', () => {
  const CID = '8d154141-6044-4282-bf71-a7efc1d5e3c1';
  const BODY = '<div>Hi</div><img class="proton-embedded" src="cid:' + CID + '">';

  function build(reply, store, renders) {
    const names = ['_resolveInlineImages', '_cidRefs', '_normalizeCid', '_attachmentCid'];
    const body = names.map(n => lift(POPUP, n)).join('\n\n') + '\nreturn _resolveInlineImages;';
    return new Function('browser', 'isPremium', '_previewMode', 'INLINE_IMAGE_MAX_BYTES',
      '_inlineImages', '_rawPreviewBody', '_renderPreviewBody', body)(
      { runtime: { sendMessage: async () => reply } },
      () => true,
      'html',
      12 * 1024 * 1024,
      store,
      BODY,                       // _rawPreviewBody: still the open message
      () => { renders.push(1); },
    );
  }

  const fullMsg = {
    Sender: { Address: 'alice@example.com' },
    Attachments: [{
      ID: 'img1', Name: 'Screenshot.jpg', MIMEType: 'image/jpeg', Size: 2048,
      KeyPackets: 'kp1', Headers: { 'content-id': '<' + CID + '>', 'content-disposition': 'inline' },
    }],
  };

  it('leaves the cid unresolved when decrypted is false', async () => {
    const store = new Map();
    const renders = [];
    await build({ data: btoa('Á\u000e\u0003'), decrypted: false }, store, renders)(
      BODY, fullMsg, 'acc1');

    // No data: URL at all: one over ciphertext paints a broken image where the
    // picture was, and the attachment list still offers the file.
    expect(store.size).toBe(0);
    // Nothing resolved, so no re-render was triggered either.
    expect(renders).toHaveLength(0);
  });

  it('resolves it when decrypted is true', async () => {
    const store = new Map();
    const renders = [];
    const b64 = btoa('JPEGBYTES');
    await build({ data: b64, decrypted: true }, store, renders)(BODY, fullMsg, 'acc1');

    expect(store.get(CID)).toBe('data:image/jpeg;base64,' + b64);
    expect(renders).toHaveLength(1);
  });

  it('does not fire for an embedded image with no key packets', async () => {
    const store = new Map();
    const renders = [];
    const plainMsg = {
      Sender: { Address: 'alice@example.com' },
      Attachments: [{ ...fullMsg.Attachments[0], KeyPackets: null }],
    };
    const b64 = btoa('JPEGBYTES');
    await build({ data: b64, decrypted: false }, store, renders)(BODY, plainMsg, 'acc1');

    expect(store.get(CID)).toBe('data:image/jpeg;base64,' + b64);
    expect(renders).toHaveLength(1);
  });
});

// --- 4. detectCalendarInvite: never parse ciphertext as ICS -----------------

describe('the invite card refuses .ics attachments that came back undecrypted', () => {
  let PopupCalendar;
  let decoded;

  const ICS = [
    'BEGIN:VCALENDAR',
    'METHOD:CANCEL',
    'BEGIN:VEVENT',
    'UID:contract-a-1',
    'SUMMARY:Quarterly review',
    'DTSTART:20260415T100000Z',
    'DTEND:20260415T110000Z',
    'ORGANIZER;CN=Alice:mailto:alice@example.com',
    'END:VEVENT',
    'END:VCALENDAR',
  ].join('\r\n');
  const ICS_B64 = btoa(ICS);
  const CIPHER_B64 = btoa('Á\u000e\u0003\u001f\u009aB');

  let replies = {};

  beforeAll(() => {
    decoded = [];
    // base64ToUint8 is the decode step that feeds parseICS, so recording it is
    // a direct probe of "was this parsed". Ciphertext decoded as UTF-8 yields
    // garbage that parseICS happens to reject, so an assertion on the rendered
    // card alone would pass against the old code too.
    const ProtonBinary = {
      base64ToUint8(b64) {
        decoded.push(b64);
        const bin = atob(b64);
        const u8 = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
        return u8;
      },
    };
    const browserShim = {
      runtime: {
        sendMessage: async (m) => (m && m.type === 'GET_ATTACHMENT'
          ? replies[m.attachmentId]
          : null),
      },
      tabs: { create() {} },
    };
    PopupCalendar = new Function('browser', 'ProtonI18n', 'ProtonBinary', 'window',
      CALENDAR + '\nreturn PopupCalendar;')(browserShim, i18n, ProtonBinary, globalThis.window);
  });

  function icsAtt(id, name, keyPackets) {
    return { ID: id, Name: name, MIMEType: 'text/calendar', KeyPackets: keyPackets };
  }

  async function detect(atts, table) {
    decoded.length = 0;
    replies = table;
    const host = document.createElement('div');
    await PopupCalendar.detectCalendarInvite({ Attachments: atts }, 'acc1', {
      containerEl: host,
      getSelectedMsg: () => ({ ID: 'm1', ConversationID: 'c1', _accountId: 'acc1' }),
      showToast: () => {},
    });
    return host;
  }

  it('does not decode or parse ciphertext', async () => {
    const host = await detect([icsAtt('bad', 'invite.ics', 'kp1')],
      { bad: { data: CIPHER_B64, decrypted: false } });

    expect(decoded).toEqual([]);
    expect(host.querySelectorAll('.calendar-invite-card')).toHaveLength(0);
    expect(host.classList.contains('hidden')).toBe(true);
  });

  it('parses and renders the invite when decrypted is true', async () => {
    const host = await detect([icsAtt('ok', 'invite.ics', 'kp1')],
      { ok: { data: ICS_B64, decrypted: true } });

    expect(decoded).toEqual([ICS_B64]);
    const cards = host.querySelectorAll('.calendar-invite-card');
    expect(cards).toHaveLength(1);
    expect(cards[0].querySelector('.calendar-invite-title').textContent).toBe('Quarterly review');
    expect(host.classList.contains('hidden')).toBe(false);
  });

  it('renders the good invite in a message that also carries a bad one', async () => {
    const host = await detect(
      [icsAtt('bad', 'leg1.ics', 'kp1'), icsAtt('ok', 'leg2.ics', 'kp2')],
      { bad: { data: CIPHER_B64, decrypted: false }, ok: { data: ICS_B64, decrypted: true } },
    );

    expect(decoded).toEqual([ICS_B64]);
    expect(host.querySelectorAll('.calendar-invite-card')).toHaveLength(1);
  });

  it('does not fire for an .ics that was never encrypted', async () => {
    const host = await detect([icsAtt('plain', 'invite.ics', null)],
      { plain: { data: ICS_B64, decrypted: false } });

    expect(decoded).toEqual([ICS_B64]);
    expect(host.querySelectorAll('.calendar-invite-card')).toHaveLength(1);
  });
});
