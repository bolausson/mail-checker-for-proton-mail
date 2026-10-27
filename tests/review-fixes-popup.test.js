/**
 * @vitest-environment jsdom
 *
 * Popup details whose only symptom is what the user sees, so nothing else
 * would notice them go wrong:
 *
 *  1. Sending a reply or forward from the reader draws the arrow at once, in
 *     the reader AND on the list row behind it. The row is DOM drawn before the
 *     send, so flagging the message object alone leaves the row without the
 *     arrow until something re-renders the whole list.
 *  2. A SCHEDULED send draws nothing. It has not gone yet, so "you answered
 *     this" would be untrue until the delivery time. The background leaves its
 *     own copy unflagged for the same reason (tests/replied-indicator.test.js),
 *     and the next list fetch brings whatever Proton decides.
 *  3. The header above the reader's attachment list counts through plural().
 *     A number glued to one fixed word reads "1 attachment(s)" in English and
 *     has no correct form at all in languages with three or more plural forms.
 *
 * House style: popup.js is a DOM-bound IIFE, so handleSendReply is lifted out
 * of the source by name and evaluated with its dependencies injected, together
 * with the real reply-state helpers it calls, so the arrows asserted on are the
 * ones the user would get. attachment-utils.js is evaluated whole, the way
 * tests/contract-a-consumers.test.js does it, against the real i18n module.
 */

import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const ROOT = join(__dirname, '..');
const POPUP = readFileSync(join(ROOT, 'popup', 'popup.js'), 'utf-8');
const ATTACH = readFileSync(join(ROOT, 'popup', 'attachment-utils.js'), 'utf-8');
const I18N = readFileSync(join(ROOT, 'lib', 'i18n.js'), 'utf-8');

/** Slice `function NAME(...) { ... }` out of popup.js by balancing braces. */
function lift(name) {
  const m = new RegExp('(async )?function ' + name + '\\(').exec(POPUP);
  if (!m) throw new Error('function not found in popup.js: ' + name);
  let i = POPUP.indexOf('{', m.index);
  let depth = 0;
  for (; i < POPUP.length; i++) {
    if (POPUP[i] === '{') depth++;
    else if (POPUP[i] === '}') { depth--; if (depth === 0) return POPUP.slice(m.index, i + 1); }
  }
  throw new Error('unbalanced braces reading ' + name);
}

/**
 * Evaluate the named functions together. `env` supplies their dependencies as
 * constants, `state` the popup's module-level `let`s that they assign to. Both
 * must stay disjoint from each other and from the lifted names, or the
 * declarations collide.
 */
function sandbox(names, env, state) {
  const parts = [];
  const lets = Object.keys(state || {});
  if (lets.length) parts.push('let { ' + lets.join(', ') + ' } = __state;');
  parts.push('const { ' + Object.keys(env).join(', ') + ' } = __env;');
  for (const n of names) parts.push(lift(n));
  parts.push('return { ' + names.join(', ') + ' };');
  return new Function('__env', '__state', parts.join('\n\n'))(env, state || {});
}

/** A fresh copy of the real i18n module, so setLanguage stays local. */
function loadI18n() {
  return new Function('window', 'self',
    I18N + '; return window.ProtonI18n || self.ProtonI18n || ProtonI18n;')({}, {});
}

// Each arrow carries U+FE0E, which pins it to its text form.
const REPLIED = '\u21A9\uFE0E';
const REPLIED_ALL = REPLIED + REPLIED;
const FORWARDED = '\u21AA\uFE0E';

// ---------------------------------------------------------------------------
// 1 and 2. The send handler and the arrows
// ---------------------------------------------------------------------------

describe('sending from the reader shows the arrow at once, unless the send is scheduled', () => {
  const ID = 'msg-1';
  let I;

  beforeAll(() => { I = loadI18n(); });

  /**
   * The handler over a fresh reader and a fresh list. `msg` is both the open
   * message and the one its row was drawn from, as in the popup; `rowArrow`
   * is what the row showed before the send (none means no span at all, which
   * is how createMessageItem draws an unflagged message).
   */
  function setup({ mode = 'reply', deliveryTime = null, flags = {}, rowArrow = null } = {}) {
    document.body.innerHTML =
      '<span id="preview-reply-state"></span>' +
      '<ul id="message-list">' +
      '  <li data-message-id="msg-other">' +
      '    <div class="msg-top-row"><span class="msg-time">08:00</span></div>' +
      '  </li>' +
      '  <li data-message-id="' + ID + '">' +
      '    <div class="msg-top-row">' +
      '      <span class="msg-sender">A Sender</span>' +
      (rowArrow ? '      <span class="msg-reply-state">' + rowArrow + '</span>' : '') +
      '      <span class="msg-time">09:00</span>' +
      '    </div>' +
      '  </li>' +
      '</ul>';

    const msg = Object.assign({ ID, _accountId: 'acc1', Unread: 0 }, flags);
    const sent = [];
    const toasts = [];
    const noop = () => {};
    const chips = (list) => ({ commitPending: noop, getChips: () => list });
    const replyText = document.createElement('textarea');
    replyText.value = 'Thanks, see you then.';

    const H = sandbox(['_replyStateIcons', '_renderReplyState', '_refreshListReplyState', 'handleSendReply'], {
      document,
      ProtonI18n: I,
      messageList: document.getElementById('message-list'),
      previewReplyState: document.getElementById('preview-reply-state'),
      _settings: { replyFormat: 'plaintext', autoMarkReadOnReply: false },
      _restoreQuoteUrls: (s) => s,
      _inlineDataUrlImages: (html) => ({ html, attachments: [] }),
      replyBody: document.createElement('div'),
      replyText,
      _selectedMsg: msg,
      _replyMode: mode,
      chipForwardTo: chips([{ address: 'sender@example.com' }]),
      chipReplyCc: chips([]),
      chipReplyBcc: chips([]),
      _blockOnInvalidRecipient: () => false,
      showToast: (text) => toasts.push(text),
      previewReply: document.createElement('div'),
      btnReplySend: document.createElement('button'),
      replyFromSelect: { value: 'me@example.org' },
      // What the send-options control reports: deliveryTime is null for
      // "send now" and a unix time for a scheduled send.
      replySendOpts: {
        getValues: () => ({ deliveryTime, expiresIn: null, eoPassword: '', eoHint: '' }),
        reset: noop,
      },
      replyDriveShare: { reset: noop },
      browser: {
        runtime: { sendMessage: async (payload) => { sent.push(payload); return { success: true }; } },
      },
      _sendErrorMessage: (code) => code,
      _renderReplyAttachments: noop,
      _clearDraft: noop,
      doAction: noop,
      _syncPreviewReadButton: noop,
      closePreview: async () => {},
    }, { _replyAttachments: [], _replyBaseline: '' });

    return { H, msg, sent, toasts };
  }

  async function send(opts) {
    const s = setup(opts);
    await s.H.handleSendReply(false);
    // The handler catches everything, so a dependency missing from the
    // sandbox would only show up as this toast. Say so here, not three
    // assertions later.
    expect(s.toasts, 'handleSendReply threw: check its injected dependencies')
      .not.toContain(I.t('sendFailed'));
    expect(s.sent).toHaveLength(1);
    return s;
  }

  const readerArrows = () => document.getElementById('preview-reply-state').textContent;
  const rowTop = (id) => document.querySelector('[data-message-id="' + id + '"] .msg-top-row');
  /** The arrows on a row, or null when the row has no reply-state span. */
  const rowArrows = (id = ID) => {
    const el = rowTop(id).querySelector('.msg-reply-state');
    return el ? el.textContent : null;
  };

  it('a reply sent now shows the arrow in the reader and on the list row behind it', async () => {
    const { msg, toasts } = await send({ mode: 'reply' });
    expect(toasts).toEqual([I.t('replySent')]);
    expect(msg.IsReplied).toBe(1);
    expect(readerArrows()).toBe(REPLIED);
    // The row was drawn before the send, without any arrow span.
    expect(rowArrows()).toBe(REPLIED);
    const order = [...rowTop(ID).children].map((el) => el.className);
    expect(order.indexOf('msg-reply-state')).toBeLessThan(order.indexOf('msg-time'));
    // Only the answered message's row changes.
    expect(rowArrows('msg-other')).toBeNull();
  });

  it('reply-all and forward put their own arrow on the row', async () => {
    for (const [mode, type, glyph] of [
      ['replyAll', 'SEND_REPLY', REPLIED_ALL],
      ['forward', 'FORWARD_MESSAGE', FORWARDED],
    ]) {
      const { sent } = await send({ mode });
      expect(sent[0].type, mode).toBe(type);
      expect(readerArrows(), mode).toBe(glyph);
      expect(rowArrows(), mode).toBe(glyph);
    }
  });

  it('a row that already showed an arrow gains the new one, not a stale copy', async () => {
    await send({ mode: 'reply', flags: { IsForwarded: 1 }, rowArrow: FORWARDED });
    expect(rowArrows()).toBe(REPLIED + FORWARDED);
    expect(rowTop(ID).querySelectorAll('.msg-reply-state')).toHaveLength(1);
  });

  it('a scheduled reply flags nothing: not the message, the reader or the row', async () => {
    const later = Math.floor(Date.now() / 1000) + 3600;
    const { msg, sent, toasts } = await send({ mode: 'reply', deliveryTime: later });
    // It did go to the background, as a scheduled send.
    expect(sent[0].sendOptions.deliveryTime).toBe(later);
    expect(toasts).toEqual([I.t('messageScheduled')]);
    expect(msg.IsReplied).toBeUndefined();
    expect(readerArrows()).toBe('');
    expect(rowArrows()).toBeNull();
  });

  it('a scheduled reply-all or forward flags nothing either', async () => {
    const later = Math.floor(Date.now() / 1000) + 3600;
    for (const [mode, flag] of [['replyAll', 'IsRepliedAll'], ['forward', 'IsForwarded']]) {
      const { msg, toasts } = await send({ mode, deliveryTime: later });
      expect(toasts, mode).toEqual([I.t('messageScheduled')]);
      expect(msg[flag], mode).toBeUndefined();
      expect(readerArrows(), mode).toBe('');
      expect(rowArrows(), mode).toBeNull();
    }
  });

  it('a scheduled reply leaves an arrow the message already had as it was', async () => {
    const later = Math.floor(Date.now() / 1000) + 3600;
    const { msg } = await send({ mode: 'reply', deliveryTime: later, flags: { IsForwarded: 1 }, rowArrow: FORWARDED });
    expect(msg.IsReplied).toBeUndefined();
    expect(msg.IsForwarded).toBe(1);
    expect(rowArrows()).toBe(FORWARDED);
  });
});

// ---------------------------------------------------------------------------
// 3. The attachment header
// ---------------------------------------------------------------------------

describe('the attachment header counts in the form the language uses', () => {
  let I;
  let A;

  beforeAll(() => {
    I = loadI18n();
    A = new Function('browser', 'ProtonI18n', 'document', ATTACH + '\nreturn PopupAttachments;')(
      { runtime: { sendMessage: () => Promise.resolve(null) }, tabs: { create() {} } },
      I, document);
  });

  afterEach(() => I.setLanguage('en'));

  const file = (n) => ({ ID: 'f' + n, Name: 'report' + n + '.pdf', MIMEType: 'application/pdf', Size: 1000 });
  // Drawn in the body via cid:, which is what makes it count as an image.
  const embedded = (n) => ({
    ID: 'i' + n,
    Name: 'logo' + n + '.png',
    MIMEType: 'image/png',
    Size: 500,
    Headers: { 'content-disposition': 'inline', 'content-id': '<logo' + n + '@example.com>' },
  });
  const files = (n) => Array.from({ length: n }, (_, i) => file(i));

  /** The count text in the header the reader shows for these attachments. */
  function header(attachments) {
    document.body.innerHTML = '<div id="preview-attachments"></div>';
    A.renderAttachmentList({ Attachments: attachments, Sender: { Address: 'sender@example.com' } }, 'acc1', () => {});
    const el = document.querySelector('#preview-attachments .attachments-detail');
    return el ? el.textContent : null;
  }

  it('reads "1 attachment" and "3 attachments" in English, never "attachment(s)"', () => {
    expect(header(files(1))).toBe('1 attachment');
    expect(header(files(3))).toBe('3 attachments');
  });

  it('counts files and embedded images each in their own right form', () => {
    expect(header([file(0), embedded(0)])).toBe('1 attachment, 1 embedded image');
    expect(header([...files(2), embedded(0), embedded(1)])).toBe('2 attachments, 2 embedded images');
  });

  it('uses the one, few and many forms of a language that has all three', () => {
    // The exact Polish wording belongs to the translators; what is pinned is
    // that the header shows the form plural() picks, and that the three
    // counts really need three different forms.
    I.setLanguage('pl');
    const got = [1, 3, 5].map((n) => header(files(n)));
    expect(got).toEqual([1, 3, 5].map((n) => I.plural('attachmentsCount', n)));
    expect(new Set(got.map((s) => s.replace(/^\d+ /, ''))).size).toBe(3);
  });
});
