/**
 * @vitest-environment jsdom
 *
 * Marking the open message read closed its preview. The list is unread-only,
 * so MARK_READ is one of the actions that take a message out of it, and the
 * render after any change closed a preview whose message was no longer
 * listed. With "mark as read on open" (Pro) the preview closed the moment
 * the body had loaded, and the preview's own Mark as read button closed it
 * too, so its Mark as unread state could never be seen.
 *
 * Now the popup remembers that it read the open message itself and keeps
 * reading it. Everything else that takes the open message away (archive,
 * trash, move, spam, phishing, snooze, delete, or a poll that no longer
 * lists it because it was read or moved elsewhere) still closes it.
 *
 * House style: popup.js is a DOM-bound IIFE, so the functions under test are
 * lifted out of the source by name and evaluated together, with the module
 * state they assign declared as real variables (see popup()).
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const ROOT = join(__dirname, '..');
const POPUP = readFileSync(join(ROOT, 'popup', 'popup.js'), 'utf-8');

// Index just past a string literal or line comment starting at i, or i itself
// when neither starts there, so braces inside them do not unbalance the scan.
function skipLiteral(src, i) {
  const c = src[i];
  if (c === '/' && src[i + 1] === '/') {
    const nl = src.indexOf('\n', i);
    return nl === -1 ? src.length : nl;
  }
  if (c === '\'' || c === '"' || c === '`') {
    let j = i + 1;
    while (j < src.length && src[j] !== c) j += src[j] === '\\' ? 2 : 1;
    return j + 1;
  }
  return i;
}

/** The balanced `{ ... }` block that opens at or after `from`. */
function block(src, from, what) {
  let depth = 0;
  for (let i = src.indexOf('{', from); i < src.length; i++) {
    const next = skipLiteral(src, i);
    if (next !== i) { i = next - 1; continue; }
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) return i + 1; }
  }
  throw new Error('unbalanced braces reading ' + what);
}

function lift(name) {
  const m = new RegExp('(async )?function ' + name + '\\(').exec(POPUP);
  if (!m) throw new Error('function not found in popup.js: ' + name);
  // The body opens after the parameter list, which can hold braces of its
  // own: _applyOptimisticUpdate(action, { ids, conversationIds } = {}).
  const body = POPUP.indexOf(') {', m.index) + 1;
  return POPUP.slice(m.index, block(POPUP, body, name));
}

/** A top-level `const NAME = [...]` or `{...}` of popup.js, evaluated. */
function constant(name) {
  const m = new RegExp('const ' + name + ' = ([\\[{][\\s\\S]*?[\\]}]);').exec(POPUP);
  if (!m) throw new Error('const not found in popup.js: ' + name);
  return new Function('return ' + m[1])();
}

/**
 * Evaluate lifted functions with `env` in scope as constants and `state` as
 * variables they can assign, the way the module-level `let`s are in popup.js.
 */
function sandbox(names, env, state) {
  const keys = Object.keys(env);
  const vars = Object.keys(state);
  const src = [
    'const { ' + keys.join(', ') + ' } = __env;',
    'let ' + vars.map((v) => v + ' = __state.' + v).join(', ') + ';',
    ...names.map(lift),
    'return { ' + names.join(', ') + ',',
    '  get: () => ({ ' + vars.join(', ') + ' }),',
    '  set: (o) => { ' + vars.map((v) => 'if (\'' + v + '\' in o) ' + v + ' = o.' + v + ';').join(' ') + ' },',
    '};',
  ].join('\n');
  return new Function('__env', '__state', src)(env, state);
}

const ProtonI18n = { t: (k) => k };
const REMOVE_ACTIONS = constant('REMOVE_ACTIONS');
const CONV_REMOVE_ACTIONS = constant('CONV_REMOVE_ACTIONS');
const ACTION_LABELS = constant('ACTION_LABELS');
const flush = () => new Promise((r) => setTimeout(r, 0));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const click = { stopPropagation() {} };

const NAMES = [
  '_applyOptimisticUpdate', '_rollbackOptimistic', '_reconcile', 'doAction',
  '_listNeighbours', '_getNextMsgForAdvance', '_getNavList', '_navigateMsg', '_updateNavButtons',
  'handleMarkRead', 'handleMarkUnread', '_syncPreviewReadButton', '_syncPreviewWithList',
  'closePreview', 'handleArchive',
];

function message(id, time) {
  return { ID: id, ConversationID: 'c-' + id, Time: time, Unread: 1, _accountId: 'acc1', Subject: 'Subject ' + id };
}

/** Three unread messages, newest first, and the popup with `openId` open. */
function popup({ openId = 'm2', reply = () => ({ ok: true }), settings = {} } = {}) {
  const previewPanel = document.createElement('div');
  previewPanel.className = 'visible';
  const previewBody = document.createElement('div');
  const previewActionsEl = document.createElement('div');
  const readButton = document.createElement('button');
  readButton.className = 'action-read';
  readButton.dataset.unread = '1';
  readButton.title = 'markAsRead';
  previewActionsEl.appendChild(readButton);
  const btnPrevMsg = document.createElement('button');
  const btnNextMsg = document.createElement('button');
  const sent = [];
  const toasts = [];
  const opened = [];
  const box = {};
  const env = {
    document, ProtonI18n, REMOVE_ACTIONS, CONV_REMOVE_ACTIONS, ACTION_LABELS,
    OPTIMISTIC_TIMEOUT_MS: 10000,
    browser: { runtime: { sendMessage: async (msg) => { sent.push(msg); return reply(msg); } } },
    btnRefresh: null, btnPrevMsg, btnNextMsg, previewActionsEl, previewPanel, previewBody,
    _settings: settings,
    isPremium: () => true,
    showToast: (text, undo) => toasts.push({ text, undo }),
    // render() as far as the preview is concerned: store, then reconcile.
    render: (state) => { box.set({ _savedState: state }); box._syncPreviewWithList(state); },
    openPreview: async (msg, opts) => {
      opened.push(msg.ID);
      box.set({ _selectedMsg: msg, _readWhileOpenId: opts && opts.readWhileOpen ? msg.ID : null });
    },
    _confirmLeavingReply: async () => true,
    _renderReplyAttachments: () => {},
    replySendOpts: null,
    replyDriveShare: null,
  };
  const messages = [message('m1', 300), message('m2', 200), message('m3', 100)];
  const state = {
    _selectedMsg: messages.find((m) => m.ID === openId) || null,
    _readWhileOpenId: null,
    _savedState: { isLoggedIn: true, messages, unreadCount: 3 },
    _pendingOptimistic: [],
    _replyAttachments: [],
    _replyEditorOpen: false,
    _replyBaseline: '',
  };
  Object.assign(box, sandbox(NAMES, env, state));
  return {
    ...box, sent, toasts, opened, readButton, btnPrevMsg, btnNextMsg, previewPanel,
    open: () => box.get()._selectedMsg && box.get()._selectedMsg.ID,
    listed: () => box.get()._savedState.messages.map((m) => m.ID),
    types: () => sent.map((m) => m.type),
    /** A poll's state arriving, listing only `ids`. */
    poll: (ids) => box._reconcile({
      isLoggedIn: true,
      messages: ids.map((id) => message(id, { m1: 300, m2: 200, m3: 100 }[id])),
    }),
  };
}

describe('marking the open message read', () => {
  it('keeps the preview open, and the message leaves the list', async () => {
    const p = popup();
    p.handleMarkRead(click, 'm2', 'acc1');
    await flush();
    expect(p.types()).toEqual(['MARK_READ']);
    expect(p.listed()).toEqual(['m1', 'm3']);
    expect(p.get()._savedState.unreadCount).toBe(2);
    expect(p.open()).toBe('m2');
    expect(p.previewPanel.classList.contains('visible')).toBe(true);
  });

  it('turns its button into Mark as unread', async () => {
    const p = popup();
    p.handleMarkRead(click, 'm2', 'acc1');
    await flush();
    expect(p.readButton.title).toBe('markAsUnread');
    expect(p.readButton.dataset.unread).toBe('0');
    expect(p.toasts.map((t) => t.text)).toEqual(['markedAsRead']);
  });

  it('does the same for every other way of marking it read', async () => {
    // Auto-mark on open and on reply, star or label with their auto-mark
    // settings, a bulk mark-all: all of them come down to this call.
    const p = popup();
    p.doAction('MARK_READ', ['m2'], 'acc1');
    await flush();
    expect(p.open()).toBe('m2');
    expect(p.readButton.title).toBe('markAsUnread');
  });

  it('stays open through the polls that no longer list it', async () => {
    const p = popup();
    p.handleMarkRead(click, 'm2', 'acc1');
    await flush();
    p.poll(['m1', 'm3']);
    p.poll(['m1', 'm3']);
    await flush();
    expect(p.open()).toBe('m2');
  });

  it('leaves another open message alone when a list row is marked read', async () => {
    const p = popup({ openId: 'm1' });
    p.handleMarkRead(click, 'm2', 'acc1');
    await flush();
    expect(p.open()).toBe('m1');
    expect(p.readButton.title).toBe('markAsRead');
  });
});

describe('Mark as unread and Undo on the read open message', () => {
  it('Mark as unread keeps it open, and the poll that lists it again takes it back', async () => {
    const p = popup();
    p.handleMarkRead(click, 'm2', 'acc1');
    await flush();
    p.handleMarkUnread(click, 'm2', 'acc1');
    await flush();
    expect(p.types()).toEqual(['MARK_READ', 'MARK_UNREAD']);
    expect(p.readButton.title).toBe('markAsRead');
    expect(p.open()).toBe('m2');
    p.poll(['m1', 'm2', 'm3']);
    await flush();
    expect(p.open()).toBe('m2');
    expect(p.get()._readWhileOpenId).toBe(null);
  });

  it('Undo of "Marked as read" marks it unread and keeps it open', async () => {
    const p = popup();
    p.handleMarkRead(click, 'm2', 'acc1');
    await flush();
    p.toasts[0].undo();
    await flush();
    expect(p.types()).toEqual(['MARK_READ', 'MARK_UNREAD']);
    expect(p.sent[1].ids).toEqual(['m2']);
    expect(p.readButton.title).toBe('markAsRead');
    expect(p.open()).toBe('m2');
    p.poll(['m1', 'm2', 'm3']);
    await flush();
    expect(p.open()).toBe('m2');
  });

  it('marked unread elsewhere, the poll that lists it again turns its button back', async () => {
    const p = popup();
    p.handleMarkRead(click, 'm2', 'acc1');
    await flush();
    p.poll(['m1', 'm2', 'm3']);
    await flush();
    expect(p.types()).toEqual(['MARK_READ']);
    expect(p.open()).toBe('m2');
    expect(p.readButton.title).toBe('markAsRead');
    expect(p.readButton.dataset.unread).toBe('1');
    expect(p.get()._selectedMsg.Unread).toBe(1);
  });

  it('once listed again, reading it elsewhere closes it as before', async () => {
    const p = popup();
    p.handleMarkRead(click, 'm2', 'acc1');
    await flush();
    p.toasts[0].undo();
    await flush();
    p.poll(['m1', 'm2', 'm3']);
    p.poll(['m1', 'm3']);
    await flush();
    expect(p.open()).toBe(null);
  });
});

describe('a read change that fails', () => {
  it('a failed Mark as read puts the message back and the button back', async () => {
    const p = popup({ reply: (m) => (m.type === 'MARK_READ' ? { error: 'FAILED' } : { ok: true }) });
    p.handleMarkRead(click, 'm2', 'acc1');
    await flush();
    expect(p.listed()).toEqual(['m1', 'm2', 'm3']);
    expect(p.readButton.title).toBe('markAsRead');
    expect(p.open()).toBe('m2');
    expect(p.get()._readWhileOpenId).toBe(null);
  });

  it('puts it back unread, whichever path marked it read', async () => {
    // The open message is the very object the list held, and its button
    // sync marks it read: the rollback copy must be taken before that.
    const p = popup({ reply: (m) => (m.type === 'MARK_READ' ? { error: 'FAILED' } : { ok: true }) });
    p.doAction('MARK_READ', ['m2'], 'acc1');
    await flush();
    expect(p.get()._savedState.messages.find((m) => m.ID === 'm2').Unread).toBe(1);
    expect(p.get()._savedState.unreadCount).toBe(3);
    expect(p.readButton.title).toBe('markAsRead');
  });

  it('a failed Mark as read right after Mark as unread puts it back unread too', async () => {
    // Marked unread, but the poll that lists it again has not landed: the
    // list has no copy of it, yet it is unread and must end up so.
    let failRead = false;
    const p = popup({ reply: (m) => (m.type === 'MARK_READ' && failRead ? { error: 'FAILED' } : { ok: true }) });
    p.handleMarkRead(click, 'm2', 'acc1');
    await flush();
    p.handleMarkUnread(click, 'm2', 'acc1');
    await flush();
    failRead = true;
    p.handleMarkRead(click, 'm2', 'acc1');
    await flush();
    expect(p.readButton.title).toBe('markAsRead');
    expect(p.get()._selectedMsg.Unread).toBe(1);
    expect(p.listed()).toEqual(['m1', 'm2', 'm3']);
    expect(p.open()).toBe('m2');
  });

  it('a failed repeat on a message already read leaves it read', async () => {
    // Star or label with their auto-mark settings send MARK_READ for a read
    // message too: that one failing changes nothing.
    let failRead = false;
    const p = popup({ reply: (m) => (m.type === 'MARK_READ' && failRead ? { error: 'FAILED' } : { ok: true }) });
    p.handleMarkRead(click, 'm2', 'acc1');
    await flush();
    failRead = true;
    p.doAction('MARK_READ', ['m2'], 'acc1');
    await flush();
    expect(p.readButton.title).toBe('markAsUnread');
    expect(p.listed()).toEqual(['m1', 'm3']);
    expect(p.open()).toBe('m2');
  });

  it('a failed Mark as unread leaves the button offering unread', async () => {
    const p = popup({ reply: (m) => (m.type === 'MARK_UNREAD' ? { error: 'FAILED' } : { ok: true }) });
    p.handleMarkRead(click, 'm2', 'acc1');
    await flush();
    p.handleMarkUnread(click, 'm2', 'acc1');
    await flush();
    expect(p.readButton.title).toBe('markAsUnread');
    expect(p.get()._selectedMsg.Unread).toBe(0);
    expect(p.open()).toBe('m2');
  });
});

describe('everything else that takes the open message away still closes it', () => {
  const removals = [
    ['ARCHIVE', ['m2']],
    ['TRASH', ['m2']],
    ['MOVE_TO_FOLDER', ['m2'], { folderId: '4' }],
    ['REPORT_PHISHING', ['m2'], { messageId: 'm2' }],
    ['DELETE_PERMANENTLY', ['m2']],
    ['SNOOZE', null, { conversationIds: ['c-m2'], snoozeUntil: 1 }],
  ];

  for (const [type, ids, extra] of removals) {
    it(type + ' closes it', async () => {
      const p = popup();
      p.doAction(type, ids, 'acc1', extra);
      await flush();
      expect(p.open()).toBe(null);
      expect(p.previewPanel.classList.contains('visible')).toBe(false);
    });

    it(type + ' closes it after it was marked read too', async () => {
      // e.g. "mark as read on move" sends MARK_READ first, then the move.
      const p = popup();
      p.doAction('MARK_READ', ['m2'], 'acc1');
      await flush();
      p.doAction(type, ids, 'acc1', extra);
      await flush();
      expect(p.open()).toBe(null);
    });
  }

  it('a poll without it closes it when it was read or moved elsewhere', async () => {
    const p = popup();
    p.poll(['m1', 'm3']);
    await flush();
    expect(p.open()).toBe(null);
  });
});

describe('prev/next and auto-advance from a message that left the list', () => {
  it('the buttons step to its neighbours', async () => {
    const p = popup();
    p.handleMarkRead(click, 'm2', 'acc1');
    await flush();
    expect(p.btnPrevMsg.disabled).toBe(false);
    expect(p.btnNextMsg.disabled).toBe(false);
    p._navigateMsg(1);
    expect(p.opened).toEqual(['m3']);
  });

  it('previous goes to the newer neighbour', async () => {
    const p = popup();
    p.handleMarkRead(click, 'm2', 'acc1');
    await flush();
    p._navigateMsg(-1);
    expect(p.opened).toEqual(['m1']);
  });

  it('the newest one has no previous, unless navigation wraps', async () => {
    const p = popup({ openId: 'm1' });
    p.handleMarkRead(click, 'm1', 'acc1');
    await flush();
    expect(p.btnPrevMsg.disabled).toBe(true);
    expect(p.btnNextMsg.disabled).toBe(false);
    p._navigateMsg(-1);
    expect(p.opened).toEqual([]);

    const w = popup({ openId: 'm1', settings: { navWrap: true } });
    w.handleMarkRead(click, 'm1', 'acc1');
    await flush();
    expect(w.btnPrevMsg.disabled).toBe(false);
    w._navigateMsg(-1);
    expect(w.opened).toEqual(['m3']);
  });

  it('the oldest one has no next', async () => {
    const p = popup({ openId: 'm3' });
    p.handleMarkRead(click, 'm3', 'acc1');
    await flush();
    expect(p.btnNextMsg.disabled).toBe(true);
    p._navigateMsg(1);
    expect(p.opened).toEqual([]);
  });

  it('archiving it advances to the next message', async () => {
    const p = popup({ settings: { autoAdvance: true } });
    p.handleMarkRead(click, 'm2', 'acc1');
    await flush();
    await p.handleArchive(click, 'm2', 'acc1');
    expect(p.types()).toEqual(['MARK_READ', 'ARCHIVE']);
    await wait(300);
    expect(p.opened).toEqual(['m3']);
  });

  it('a listed message still advances as before', async () => {
    const p = popup({ settings: { autoAdvance: true } });
    expect(p._getNextMsgForAdvance('m2').ID).toBe('m3');
    expect(p._getNextMsgForAdvance('m3').ID).toBe('m2');
    expect(p._getNextMsgForAdvance('gone')).toBe(null);
  });
});

describe('render() hands the preview to the reconcile step', () => {
  it('on every render', () => {
    expect(lift('render')).toMatch(/renderMessages\(state\.messages, state\.accounts\);\s*_syncPreviewWithList\(state\);/);
  });

  it('opening a message starts it as listed', () => {
    expect(lift('openPreview')).toMatch(/_readWhileOpenId = opts && opts\.readWhileOpen \? msg\.ID : null;/);
  });
});

// --- Reopening a message that was read while open ---------------------------

describe('a reply to a message read while open survives the popup closing', () => {
  const chip = () => ({ getChips: () => [], getPending: () => '', addChip() {}, setPending() {} });

  function drafts({ listed = ['m1'], getMessage = null } = {}) {
    const sent = [];
    const opened = [];
    const cleared = [];
    let stored = null;
    const env = {
      document,
      composePanel: { classList: { contains: () => true } },
      replyText: { value: 'my reply' },
      replyBody: document.createElement('div'),
      replyFromSelect: { value: '' },
      replyCcBccRows: { classList: { contains: () => true, remove() {} } },
      chipForwardTo: chip(), chipReplyCc: chip(), chipReplyBcc: chip(),
      replySendOpts: null, replyDriveShare: null,
      _draftReplyBody: () => '<p>my reply</p>',
      _historyFor: () => null,
      _noteDraftSave: () => {},
      _updateReplyModeUI: () => {},
      _showSavedAt: () => {},
      _setHTML: () => {},
      _resolveDraftCidImages: () => {},
      _renderReplyAttachments: () => {},
      _clearDraft: () => { cleared.push(true); },
      openPreview: async (msg, opts) => { opened.push({ id: msg.ID, opts, msg }); },
      console,
      browser: {
        runtime: {
          sendMessage: async (msg) => {
            sent.push(msg);
            if (msg.type === 'SAVE_DRAFT') { stored = msg.draft; return { success: true }; }
            if (msg.type === 'GET_DRAFT') return stored;
            if (msg.type === 'GET_MESSAGE') return getMessage ? getMessage(msg) : { error: 'offline' };
            return null;
          },
        },
      },
    };
    const state = {
      _restoringDraft: false,
      _replyEditorOpen: true,
      _replyMode: 'reply',
      _replyAttachments: [],
      _selectedMsg: message('m2', 200),
      _readWhileOpenId: null,
      _savedState: {
        messages: listed.map((id) => message(id, 100)),
        accounts: [{ id: 'acc1', email: 'user@example.com' }],
      },
    };
    const fns = sandbox(['_saveDraft', '_restoreDraft', '_fetchReadMessage'], env, state);
    return { ...fns, sent, opened, cleared, stored: () => stored };
  }

  const fetched = (msg) => ({
    message: { ...message(msg.messageId, 200), Unread: 0, _accountId: undefined, Body: 'armored', DecryptedBody: '<p>hi</p>' },
  });

  it('the saved draft says the message was read while open', () => {
    const d = drafts();
    d.set({ _readWhileOpenId: 'm2' });
    d._saveDraft();
    expect(d.stored()).toMatchObject({ type: 'reply', selectedMsgId: 'm2', selectedMsgRead: true });
  });

  it('an ordinary reply draft does not', () => {
    const d = drafts();
    d._saveDraft();
    expect(d.stored().selectedMsgRead).toBeUndefined();
  });

  it('is reopened on the fetched message, which stays open although unlisted', async () => {
    const d = drafts({ getMessage: fetched });
    d.set({ _readWhileOpenId: 'm2' });
    d._saveDraft();
    expect(await d._restoreDraft()).toBe(true);
    expect(d.cleared).toEqual([]);
    expect(d.opened).toHaveLength(1);
    const { id, opts, msg } = d.opened[0];
    expect(id).toBe('m2');
    expect(opts).toEqual({ force: true, readWhileOpen: true });
    expect(msg._accountId).toBe('acc1');
    expect(msg._accountEmail).toBe('user@example.com');
    expect(msg.Body).toBeUndefined();
    expect(msg.DecryptedBody).toBeUndefined();
  });

  it('is reopened even when nothing unread is left in the list', async () => {
    const d = drafts({ listed: [], getMessage: fetched });
    d.set({ _readWhileOpenId: 'm2' });
    d._saveDraft();
    expect(await d._restoreDraft()).toBe(true);
    expect(d.opened.map((o) => o.id)).toEqual(['m2']);
  });

  it('is kept, not dropped, when the message cannot be fetched now', async () => {
    const d = drafts();
    d.set({ _readWhileOpenId: 'm2' });
    d._saveDraft();
    expect(await d._restoreDraft()).toBe(false);
    expect(d.cleared).toEqual([]);
    expect(d.opened).toEqual([]);
  });

  it('a draft for a listed message opens it as before', async () => {
    const d = drafts({ listed: ['m1', 'm2'] });
    d._saveDraft();
    expect(await d._restoreDraft()).toBe(true);
    expect(d.opened[0].opts).toEqual({ force: true, readWhileOpen: false });
    expect(d.sent.map((m) => m.type)).not.toContain('GET_MESSAGE');
  });

  it('a draft for an unlisted message not read here is dropped as before', async () => {
    const d = drafts({ getMessage: fetched });
    d._saveDraft();
    expect(await d._restoreDraft()).toBe(false);
    expect(d.cleared).toEqual([true]);
    expect(d.sent.map((m) => m.type)).not.toContain('GET_MESSAGE');
  });
});

describe('popping out a message read while open', () => {
  function deepLink(search, { listed = ['m1'], getMessage = null } = {}) {
    const opened = [];
    const env = {
      location: { search },
      previewPanel: { classList: { contains: () => true } },
      openPreview: async (msg, opts) => { opened.push({ id: msg.ID, opts }); },
      browser: { runtime: { sendMessage: async (m) => (getMessage ? getMessage(m) : { error: 'offline' }) } },
    };
    const state = {
      _savedState: { messages: listed.map((id) => message(id, 100)), accounts: [] },
    };
    const fns = sandbox(['_maybeOpenDeepLinkedMessage', '_fetchReadMessage'], env, state);
    return { ...fns, opened };
  }

  it('the window asks for it, as it is no longer listed', () => {
    const at = POPUP.indexOf("btnPreviewPopout.addEventListener('click'");
    const handler = POPUP.slice(at, block(POPUP, at, 'pop-out handler'));
    expect(handler).toMatch(/if \(_readWhileOpenId === _selectedMsg\.ID\) url \+= '&read=1';/);
  });

  it('the new window fetches and opens it', async () => {
    const d = deepLink('?standalone=1&msg=m2&acct=acc1&read=1', {
      getMessage: (m) => ({ message: { ...message(m.messageId, 200), Unread: 0 } }),
    });
    await d._maybeOpenDeepLinkedMessage();
    expect(d.opened).toEqual([{ id: 'm2', opts: { force: true, readWhileOpen: true } }]);
  });

  it('a listed message opens from the list as before', async () => {
    const d = deepLink('?standalone=1&msg=m1&acct=acc1');
    await d._maybeOpenDeepLinkedMessage();
    expect(d.opened).toEqual([{ id: 'm1', opts: { force: true, readWhileOpen: false } }]);
  });

  it('an unlisted message without the flag is not fetched', async () => {
    let asked = false;
    const d = deepLink('?standalone=1&msg=m2&acct=acc1', { getMessage: () => { asked = true; return null; } });
    await d._maybeOpenDeepLinkedMessage();
    expect(asked).toBe(false);
    expect(d.opened).toEqual([]);
  });
});

beforeEach(() => { document.body.innerHTML = ''; });
