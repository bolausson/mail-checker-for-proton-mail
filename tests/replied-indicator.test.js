/**
 * @vitest-environment jsdom
 *
 * The "you already replied to this" arrow, in the list row and the open message.
 *
 * Proton's list endpoint has always returned IsReplied / IsRepliedAll /
 * IsForwarded on every message, and our caches carry them through untouched
 * (getMonitoredMessages hands back the raw API objects, _sanitizeMessagesForDisk
 * only strips underscore-prefixed fields). We simply never drew them, so a
 * message you had answered looked exactly like one you had not.
 *
 * Two things about the display rule are easy to get wrong, so both are pinned
 * here rather than left to a reviewer's eye:
 *
 *  1. Replied-all implies replied, and Proton sets BOTH flags. Drawing one icon
 *     per true flag would put three arrows on such a message, which reads as
 *     nonsense. The two reply flags therefore pick ONE glyph between them.
 *  2. Forwarded is genuinely independent (Proton's own ItemAction.tsx renders
 *     it beside the reply icon), so it is a SECOND icon, never a replacement.
 *     A message replied to AND forwarded shows both.
 *
 * The reader reuses one container element for every message it opens, so the
 * regression to fear is a stale arrow surviving onto an unflagged message.
 * That case gets its own test.
 *
 * House style: popup.js and accounts.js are DOM-bound / browser-bound IIFEs, so
 * the functions under test are lifted out of the source by name and evaluated
 * with their dependencies injected (same idea as inline-images.test.js and
 * reply-discard-guard.test.js).
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const POPUP = readFileSync(join(__dirname, '..', 'popup', 'popup.js'), 'utf-8');
const POPUP_HTML = readFileSync(join(__dirname, '..', 'popup', 'popup.html'), 'utf-8');
const ACCOUNTS = readFileSync(join(__dirname, '..', 'background', 'accounts.js'), 'utf-8');

/** Slice `function NAME(...) { ... }` out of a source by balancing braces. */
function makeLift(SRC, label) {
  return function lift(name) {
    const m = new RegExp('(async )?function ' + name + '\\(').exec(SRC);
    if (!m) throw new Error('function not found in ' + label + ': ' + name);
    let i = SRC.indexOf('{', m.index);
    let depth = 0;
    for (; i < SRC.length; i++) {
      if (SRC[i] === '{') depth++;
      else if (SRC[i] === '}') { depth--; if (depth === 0) return SRC.slice(m.index, i + 1); }
    }
    throw new Error('unbalanced braces reading ' + name);
  };
}

/**
 * Evaluate the named functions together, with `env`'s keys in scope as their
 * dependencies and `mutable`'s names available as module-level `let`s to assign
 * to. Lifted names and env keys must stay disjoint, or the two declarations of
 * the same identifier collide.
 */
function sandbox(lift, names, env, mutable) {
  const keys = Object.keys(env || {});
  const parts = [];
  if (mutable && mutable.length) parts.push('let ' + mutable.join(', ') + ';');
  if (keys.length) parts.push('const { ' + keys.join(', ') + ' } = __env;');
  for (const n of names) parts.push(lift(n));
  parts.push('return { ' + names.join(', ') + ' };');
  return new Function('__env', parts.join('\n\n'))(env || {});
}

const liftPopup = makeLift(POPUP, 'popup.js');
const liftAccounts = makeLift(ACCOUNTS, 'background/accounts.js');

// U+FE0E is the variation selector that pins each arrow to its TEXT form. Left
// off, Windows and Android render U+21A9 as a blue colour emoji, which is far
// too loud for a hint that sits next to the date.
const VS = '︎';
const REPLIED = '↩' + VS;          // one hooked LEFT arrow
const REPLIED_ALL = REPLIED + REPLIED;  // two of them
const FORWARDED = '↪' + VS;        // the mirrored hooked RIGHT arrow

let I18N;
let icons;      // _replyStateIcons
let render;     // _renderReplyState

beforeAll(() => {
  I18N = new Function(
    'window', 'self',
    readFileSync(join(__dirname, '..', 'lib', 'i18n.js'), 'utf-8') +
    '; return window.ProtonI18n || self.ProtonI18n || ProtonI18n;'
  )({}, {});

  const H = sandbox(liftPopup, ['_replyStateIcons', '_renderReplyState'], {
    document: globalThis.document,
    ProtonI18n: I18N,
  });
  icons = H._replyStateIcons;
  render = H._renderReplyState;
});

/** The flags as the API sends them, 0 or 1. */
const flags = (replied, repliedAll, forwarded) => ({
  ID: 'm1',
  IsReplied: replied,
  IsRepliedAll: repliedAll,
  IsForwarded: forwarded,
});

const glyphs = (msg) => icons(msg).map((i) => i.glyph);

// ---------------------------------------------------------------------------
// 1. The icon-choice helper, on its own
// ---------------------------------------------------------------------------

describe('which arrows a flag combination earns', () => {
  it('shows nothing at all when nothing happened', () => {
    expect(icons(flags(0, 0, 0))).toEqual([]);
  });

  it('IsReplied alone gives the single arrow', () => {
    expect(glyphs(flags(1, 0, 0))).toEqual([REPLIED]);
  });

  it('IsRepliedAll alone gives the double arrow', () => {
    // Proton normally sets IsReplied too, but the flags are independent on the
    // wire and this must not depend on that.
    expect(glyphs(flags(0, 1, 0))).toEqual([REPLIED_ALL]);
  });

  it('IsReplied AND IsRepliedAll give the DOUBLE arrow only, never three', () => {
    // This is the combination Proton actually sends for a reply-all. One icon
    // per true flag would be single + double side by side: three arrows.
    const out = glyphs(flags(1, 1, 0));
    expect(out).toEqual([REPLIED_ALL]);
    const arrows = out.join('').split('↩').length - 1;
    expect(arrows).toBe(2);
  });

  it('IsForwarded alone gives the mirrored arrow', () => {
    expect(glyphs(flags(0, 0, 1))).toEqual([FORWARDED]);
  });

  it('IsForwarded ADDS a second icon rather than replacing the reply one', () => {
    expect(glyphs(flags(1, 0, 1))).toEqual([REPLIED, FORWARDED]);
    expect(glyphs(flags(0, 1, 1))).toEqual([REPLIED_ALL, FORWARDED]);
    expect(glyphs(flags(1, 1, 1))).toEqual([REPLIED_ALL, FORWARDED]);
  });

  it('covers all eight combinations without ever emitting both reply glyphs', () => {
    for (const r of [0, 1]) {
      for (const ra of [0, 1]) {
        for (const f of [0, 1]) {
          const out = icons(flags(r, ra, f));
          const reply = out.filter((i) => i.state !== 'forwarded');
          expect(reply.length).toBeLessThanOrEqual(1);
          expect(out.length).toBe((r || ra ? 1 : 0) + (f ? 1 : 0));
        }
      }
    }
  });

  it('survives a missing message instead of throwing', () => {
    expect(icons(undefined)).toEqual([]);
    expect(icons(null)).toEqual([]);
  });

  it('every arrow carries U+FE0E, so none can become a colour emoji', () => {
    for (const g of [REPLIED, REPLIED_ALL, FORWARDED]) {
      // The glyphs alternate arrow, selector, arrow, selector.
      for (let i = 1; i < g.length; i += 2) expect(g.charCodeAt(i)).toBe(0xFE0E);
    }
    const all = icons(flags(1, 1, 1)).map((i) => i.glyph).join('');
    const arrows = (all.match(/[↩↪]/g) || []).length;
    expect((all.match(/︎/g) || []).length).toBe(arrows);
  });

  it('names an i18n key per icon, and those keys are real', () => {
    expect(icons(flags(1, 0, 0))[0].titleKey).toBe('repliedTo');
    expect(icons(flags(0, 1, 0))[0].titleKey).toBe('repliedToAll');
    expect(icons(flags(0, 0, 1))[0].titleKey).toBe('forwarded');
    // ProtonI18n.t falls back to the key itself, so a real translation proves
    // the key exists rather than silently showing "repliedToAll" as a tooltip.
    expect(I18N.t('repliedTo')).toBe('Replied');
    expect(I18N.t('repliedToAll')).toBe('Replied to all');
    expect(I18N.t('forwarded')).toBe('Forwarded');
  });
});

describe('rendering the arrows into a container', () => {
  it('writes one span per icon, glyph and tooltip', () => {
    const box = document.createElement('span');
    render(box, flags(0, 1, 1));
    const kids = [...box.children];
    expect(kids.map((el) => el.textContent)).toEqual([REPLIED_ALL, FORWARDED]);
    expect(kids.map((el) => el.title)).toEqual(['Replied to all', 'Forwarded']);
    expect(kids.map((el) => el.dataset.state)).toEqual(['replied-all', 'forwarded']);
  });

  it('empties the container first, which is what stops a stale arrow', () => {
    const box = document.createElement('span');
    render(box, flags(1, 0, 0));
    expect(box.children.length).toBe(1);
    render(box, flags(0, 0, 0));
    expect(box.children.length).toBe(0);
    expect(box.textContent).toBe('');
  });

  it('does nothing when there is no container', () => {
    expect(() => render(null, flags(1, 0, 0))).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// 2. The list row
// ---------------------------------------------------------------------------

describe('the list row places the arrows left of the date', () => {
  let createMessageItem;

  beforeAll(() => {
    const noop = () => {};
    const built = sandbox(liftPopup, ['createMessageItem'], {
      document: globalThis.document,
      ProtonI18n: I18N,
      _renderReplyState: render,
      _formatSender: () => 'A Sender',
      formatMessageTime: () => '10:30',
      createAvatarEl: () => document.createElement('div'),
      _senderIconsAllowed: () => false,
      _detectOTP: () => null,
      _settings: { previewLines: 0 },
      // Free tier keeps the action row to two buttons and the overflow menu
      // empty, so none of that machinery has to be stubbed.
      showPremiumUI: () => false,
      isPremium: () => false,
      _sortActionsByOrder: (actions) => actions,
      createActionBtn: () => document.createElement('button'),
      ICONS: new Proxy({}, { get: () => '' }),
      browser: { runtime: { sendMessage: () => Promise.resolve(null) }, tabs: { create: noop } },
    });
    createMessageItem = built.createMessageItem;
  });

  /** Class names of the top row's children, in document order. */
  const topRow = (msg) => {
    const li = createMessageItem(Object.assign({ Subject: 'hi', Time: 1, Unread: 0 }, msg), false);
    const row = li.querySelector('.msg-top-row');
    expect(row).not.toBeNull();
    return [...row.children].map((el) => el.className);
  };

  it('puts .msg-reply-state inside .msg-top-row, before .msg-time', () => {
    const order = topRow(flags(1, 0, 0));
    const state = order.indexOf('msg-reply-state');
    const time = order.indexOf('msg-time');
    expect(state).toBeGreaterThanOrEqual(0);
    expect(time).toBeGreaterThanOrEqual(0);
    // "Left of the date" is the requirement, so assert the order, not presence.
    expect(state).toBeLessThan(time);
  });

  it('draws the real glyph for the flag that is set', () => {
    const li = createMessageItem(
      Object.assign({ Subject: 'hi', Time: 1, Unread: 0 }, flags(1, 1, 1)), false);
    const box = li.querySelector('.msg-reply-state');
    expect(box.textContent).toBe(REPLIED_ALL + FORWARDED);
  });

  it('adds no element at all when the message has no flags', () => {
    // An empty span would still claim the row's flex gap and nudge the date.
    expect(topRow(flags(0, 0, 0))).not.toContain('msg-reply-state');
  });

  it('sits after the paperclip, so the date stays last', () => {
    const order = topRow(Object.assign({ NumAttachments: 2 }, flags(0, 0, 1)));
    expect(order.indexOf('msg-attach-icon')).toBeLessThan(order.indexOf('msg-reply-state'));
    expect(order.indexOf('msg-reply-state')).toBeLessThan(order.indexOf('msg-time'));
  });
});

// ---------------------------------------------------------------------------
// 3. The open message
// ---------------------------------------------------------------------------

describe('the open message shows the arrows, and clears them', () => {
  let openPreview;
  let replyState;

  beforeAll(() => {
    // Take the sender row from popup.html itself: if the span or its id is ever
    // removed, this test fails rather than quietly testing a element it built.
    const row = /<div class="preview-sender-row">[\s\S]*?<\/div>/.exec(POPUP_HTML);
    expect(row).not.toBeNull();
    document.body.innerHTML = row[0];
    replyState = document.getElementById('preview-reply-state');
    expect(replyState).not.toBeNull();

    const noop = () => {};
    const el = () => document.createElement('div');
    const avatar = () => {
      const wrap = document.createElement('div');
      const inner = document.createElement('div');
      inner.className = 'msg-avatar';
      wrap.appendChild(inner);
      return wrap;
    };
    const built = sandbox(liftPopup, ['openPreview'], {
      document: globalThis.document,
      ProtonI18n: I18N,
      _renderReplyState: render,
      previewSender: document.getElementById('preview-sender'),
      previewTime: document.getElementById('preview-time'),
      previewReplyState: replyState,
      _confirmLeavingReply: async () => true,
      externalContentBanner: el(),
      _updateReplyModeUI: noop,
      formatFullTime: () => '1 Jan, 10:30',
      createAvatarEl: avatar,
      _senderIconsAllowed: () => false,
      previewAvatar: el(),
      previewSubject: el(),
      previewTo: el(),
      previewLabels: el(),
      previewActionsEl: el(),
      previewBody: el(),
      previewPanel: el(),
      calendarInviteEl: el(),
      btnToggleFormat: el(),
      _updateCanvasButton: noop,
      _getFormatTitle: () => '',
      _updatePreviewModeIndicator: noop,
      showPremiumUI: () => true,
      isPremium: () => true,
      _settings: {},
      _setHTML: (target) => { target.textContent = ''; },
      replyText: document.createElement('textarea'),
      replyBody: el(),
      chipForwardTo: { clearChips: noop },
      chipReplyCc: { clearChips: noop },
      chipReplyBcc: { clearChips: noop },
      replyCcBccRows: el(),
      replyFromSelect: el(),
      replyFromRow: el(),
      _updateNavButtons: noop,
      fetchAndShowBody: async () => {},
      doAction: noop,
      browser: { runtime: { sendMessage: () => Promise.resolve(null) }, tabs: { create: noop } },
    }, ['_selectedMsg', '_externalContentLoaded', '_replyMode', '_replyEditorOpen',
      '_replyBaseline', '_rawPreviewBody', '_previewMode']);
    openPreview = built.openPreview;
  });

  const open = (msg) => openPreview(
    Object.assign({ Subject: 'hi', Time: 1, Sender: { Name: 'A', Address: 'a@b.c' } }, msg));

  it('shows the indicator on a flagged message', async () => {
    await open(flags(0, 1, 1));
    expect(replyState.textContent).toBe(REPLIED_ALL + FORWARDED);
    expect([...replyState.children].map((e) => e.title))
      .toEqual(['Replied to all', 'Forwarded']);
  });

  it('clears it when the next message opened has no flags', async () => {
    // The container is reused across opens, so a missing clear leaves the
    // previous message's arrow sitting on an untouched one.
    await open(flags(1, 0, 0));
    expect(replyState.children.length).toBe(1);
    await open(flags(0, 0, 0));
    expect(replyState.children.length).toBe(0);
    expect(replyState.textContent).toBe('');
  });

  it('swaps the glyph rather than accumulating arrows', async () => {
    await open(flags(1, 0, 0));
    await open(flags(0, 1, 0));
    expect(replyState.textContent).toBe(REPLIED_ALL);
    expect(replyState.children.length).toBe(1);
  });

  it('keeps the indicator left of the date, as in the list', async () => {
    await open(flags(1, 0, 0));
    const order = [...replyState.parentElement.children].map((e) => e.id);
    expect(order.indexOf('preview-reply-state'))
      .toBeLessThan(order.indexOf('preview-time'));
  });
});

// ---------------------------------------------------------------------------
// 4. The optimistic flag on the held parent, after a send
// ---------------------------------------------------------------------------

describe('a sent reply or forward flags the parent we are holding', () => {
  const PARENT = 'parent-1';

  /** Fresh send functions over a fresh account; `fail` makes the send throw. */
  function build({ messages, fail } = {}) {
    const account = {
      email: 'me@proton.me',
      keysUnlocked: true,
      decryptedKeys: [{}],
      messages: messages === undefined ? [{ ID: PARENT }] : messages,
    };
    // getMessage returns the full message from the API, a DIFFERENT object from
    // the list entry we hold. Keeping them apart is the point: the arrow has to
    // land on the one the popup reads back.
    const original = {
      ID: PARENT,
      Subject: 'hi',
      Sender: { Name: 'A', Address: 'a@b.c' },
      ToList: [{ Address: 'me@proton.me' }],
      Time: 1,
      Body: 'x',
    };
    const saved = { count: 0 };
    const built = sandbox(liftAccounts, ['_sendWasImmediate', '_flagParentAfterSend', 'sendReply', 'forwardMessage'], {
      ensureKeysUnlocked: async () => {},
      getAccount: () => account,
      getMessage: async () => original,
      _resolveSenderInfo: async () => ({
        fromAddr: { ID: 'addr1', Email: 'me@proton.me', DisplayName: 'Me' },
        senderPrivKey: {},
        senderPubKey: {},
        addresses: [{ Email: 'me@proton.me' }],
        defaultAddr: { ID: 'addr1', DisplayName: 'Me' },
      }),
      _escapeHtml: (s) => String(s == null ? '' : s),
      _reattachQuotedImages: async (_a, _b, _c, att) => att,
      decryptBody: async () => 'original body',
      _encryptAndSend: async () => {
        if (fail) throw new Error('Send failed');
      },
      debugLog: () => {},
      saveSnapshot: async () => { saved.count++; },
    });
    return { account, original, saved, built };
  }

  const held = (account) => account.messages.find((m) => m.ID === PARENT) || {};

  const reply = (built, replyAll) => built.sendReply(
    'acct', PARENT, 'text', false, replyAll, null, [], [], [], [{ address: 'a@b.c' }], null);
  const forward = (built) => built.forwardMessage(
    'acct', PARENT, 'x@y.z', 'text', false, null, [], [], [], null);

  it('a successful reply sets IsReplied on the held parent', async () => {
    const { account, built, saved } = build();
    await expect(reply(built, false)).resolves.toEqual({ success: true });
    expect(held(account).IsReplied).toBe(1);
    expect(held(account).IsRepliedAll).toBeUndefined();
    // MV3 kills the worker seconds later, so the flag has to be persisted or
    // the popup never sees it.
    expect(saved.count).toBe(1);
  });

  it('a successful reply-all sets IsRepliedAll instead', async () => {
    const { account, built } = build();
    await reply(built, true);
    expect(held(account).IsRepliedAll).toBe(1);
    expect(held(account).IsReplied).toBeUndefined();
  });

  it('a successful forward sets IsForwarded', async () => {
    const { account, built } = build();
    await expect(forward(built)).resolves.toEqual({ success: true });
    expect(held(account).IsForwarded).toBe(1);
  });

  it('forwarding after replying keeps both flags, as Proton does', async () => {
    const { account, built } = build();
    await reply(built, false);
    await forward(built);
    expect(held(account).IsReplied).toBe(1);
    expect(held(account).IsForwarded).toBe(1);
  });

  it('flags the held list entry, not the message fetched from the API', async () => {
    const { original, built } = build();
    await reply(built, false);
    expect(original.IsReplied).toBeUndefined();
  });

  it('a FAILED send flags nothing and persists nothing', async () => {
    const { account, built, saved } = build({ fail: true });
    await expect(reply(built, false)).rejects.toThrow('Send failed');
    expect(held(account).IsReplied).toBeUndefined();
    expect(saved.count).toBe(0);

    const fwd = build({ fail: true });
    await expect(forward(fwd.built)).rejects.toThrow('Send failed');
    expect(held(fwd.account).IsForwarded).toBeUndefined();
    expect(fwd.saved.count).toBe(0);
  });

  it('does NOT flag the parent for a scheduled reply, which has not been sent yet', async () => {
    // The reply is queued, not delivered. Claiming "you answered this" would be
    // visibly untrue until the delivery time, and Proton decides for itself
    // whether the flag belongs on the parent at schedule time or at delivery.
    // The next list refetch tells us either way, so waiting costs one poll.
    const { account, built, saved } = build();
    const later = { deliveryTime: Math.floor(Date.now() / 1000) + 3600 };
    await expect(built.sendReply('acct', PARENT, 'text', false, false, null, [], [], [],
      [{ address: 'a@b.c' }], later)).resolves.toEqual({ success: true });
    expect(held(account).IsReplied).toBeUndefined();
    expect(held(account).IsRepliedAll).toBeUndefined();
    expect(saved.count).toBe(0);
  });

  it('does NOT flag the parent for a scheduled forward either', async () => {
    const { account, built, saved } = build();
    const later = { deliveryTime: Math.floor(Date.now() / 1000) + 3600 };
    await expect(built.forwardMessage('acct', PARENT, 'x@y.z', 'text', false, null, [], [], [],
      later)).resolves.toEqual({ success: true });
    expect(held(account).IsForwarded).toBeUndefined();
    expect(saved.count).toBe(0);
  });

  it('does not throw when the parent is not in the held list', async () => {
    // Outside the fetched window, or already archived by another client.
    for (const messages of [[], [{ ID: 'someone-else' }], undefined]) {
      const { built, saved } = build({ messages: messages === undefined ? [] : messages });
      await expect(reply(built, false)).resolves.toEqual({ success: true });
      await expect(forward(built)).resolves.toEqual({ success: true });
      // Nothing to update, so nothing to write either.
      expect(saved.count).toBe(0);
    }
  });

  it('survives an account with no messages array at all', async () => {
    const { built } = build({ messages: null });
    await expect(reply(built, false)).resolves.toEqual({ success: true });
  });

  it('never fails a sent message because the cache write failed', async () => {
    // The send already happened; a snapshot error must not turn it into an error
    // the user sees and retries.
    const { account, built } = build();
    const boom = sandbox(liftAccounts, ['_flagParentAfterSend'], {
      saveSnapshot: async () => { throw new Error('disk full'); },
    });
    await expect(boom._flagParentAfterSend(account, PARENT, 'IsReplied')).resolves.toBeUndefined();
    expect(held(account).IsReplied).toBe(1);
  });
});

describe('the arrow appears the moment you send, not at the next poll', () => {
  // The background flags its own copy, but the popup holds different objects
  // and cannot simply re-read state here: _reconcile ends in render(), which
  // would switch back to the inbox and throw the user out of the message they
  // just answered. So the popup updates its own copy in place.
  const ID = 'msg-sent-1';

  function row(flags) {
    document.body.innerHTML =
      '<ul id="message-list">' +
      '  <li data-message-id="' + ID + '">' +
      '    <div class="msg-top-row">' +
      '      <span class="msg-sender">A</span>' +
      (flags ? '      <span class="msg-reply-state"></span>' : '') +
      '      <span class="msg-time">09:00</span>' +
      '    </div>' +
      '  </li>' +
      '</ul>';
    return document.getElementById('message-list');
  }

  const build = (messageList) => sandbox(liftPopup,
    ['_replyStateIcons', '_renderReplyState', '_refreshListReplyState'],
    { ProtonI18n: { t: (k) => k }, document, messageList });

  it('adds the span to a row that never had one, before the time', () => {
    const list = row(false);
    const H = build(list);
    H._refreshListReplyState(ID, { IsReplied: 1 });
    const top = list.querySelector('.msg-top-row');
    const kids = [...top.children].map((c) => c.className);
    expect(kids).toContain('msg-reply-state');
    expect(kids.indexOf('msg-reply-state')).toBeLessThan(kids.indexOf('msg-time'));
    expect(top.querySelector('.msg-reply-state').textContent).toBe('↩︎');
  });

  it('repaints a row that already had one instead of adding a second', () => {
    const list = row(true);
    const H = build(list);
    H._refreshListReplyState(ID, { IsRepliedAll: 1, IsForwarded: 1 });
    const top = list.querySelector('.msg-top-row');
    expect(top.querySelectorAll('.msg-reply-state')).toHaveLength(1);
    expect(top.querySelector('.msg-reply-state').children).toHaveLength(2);
  });

  it('leaves other rows alone and does not throw on an unknown id', () => {
    const list = row(false);
    const H = build(list);
    expect(() => H._refreshListReplyState('not-here', { IsReplied: 1 })).not.toThrow();
    expect(list.querySelector('.msg-reply-state')).toBeNull();
  });
});
