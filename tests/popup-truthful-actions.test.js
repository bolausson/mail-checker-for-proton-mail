/**
 * @vitest-environment jsdom
 *
 * Popup actions that said one thing and did another, found by reading the
 * code for the 2.0.0 README:
 *
 *  1. The preview button titled "Mark as unread" (shown on a read message)
 *     sent MARK_READ, so there was no way to mark a message unread at all
 *     apart from the Undo on the "Marked as read" toast.
 *  2. A free user could open the per-account settings (label, initials,
 *     color, notification switch, folders). The background refuses
 *     UPDATE_ACCOUNT_SETTINGS without Premium and the popup never read the
 *     reply, so every change looked saved and was not.
 *  3. The e and # shortcuts skipped the Premium check their buttons make: a
 *     free user saw "Archived" or "Moved to trash", then "Action failed:
 *     PREMIUM_REQUIRED" once the background refused it.
 *
 * Plus the options page's sync label, which named the Firefox account in
 * Chrome as well.
 *
 * House style: popup.js and options.js are DOM-bound IIFEs, so the functions
 * under test are lifted out of the source by name and evaluated with their
 * dependencies injected (same idea as popup-licence-banner.test.js).
 */

import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const ROOT = join(__dirname, '..');
const POPUP = readFileSync(join(ROOT, 'popup', 'popup.js'), 'utf-8');
const OPTIONS = readFileSync(join(ROOT, 'options', 'options.js'), 'utf-8');
const OPTIONS_HTML = readFileSync(join(ROOT, 'options', 'options.html'), 'utf-8');

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

function makeLift(src, file) {
  return (name) => {
    const m = new RegExp('(async )?function ' + name + '\\(').exec(src);
    if (!m) throw new Error('function not found in ' + file + ': ' + name);
    return src.slice(m.index, block(src, m.index, name));
  };
}

const liftPopup = makeLift(POPUP, 'popup.js');
const liftOptions = makeLift(OPTIONS, 'options.js');

/** Evaluate lifted functions together with `env`'s keys in scope. */
function sandbox(lift, names, env) {
  const keys = Object.keys(env || {});
  const parts = [];
  if (keys.length) parts.push('const { ' + keys.join(', ') + ' } = __env;');
  for (const n of names) parts.push(lift(n));
  parts.push('return { ' + names.join(', ') + ' };');
  return new Function('__env', parts.join('\n\n'))(env || {});
}

const ProtonI18n = { t: (k) => k };
const ICONS = new Proxy({}, { get: () => '' });
const flush = () => new Promise((r) => setTimeout(r, 0));

// --- 1. The preview's read/unread button ------------------------------------

describe('the preview button marks a read message unread', () => {
  /**
   * Render the preview actions for `msg` as the open message, with doAction
   * and showToast recorded. `free` renders for a free user with premium UI
   * hidden, the narrowest set the preview ever shows.
   */
  function preview(msg, { free = false } = {}) {
    const actionsEl = document.createElement('div');
    const actions = [];
    const toasts = [];
    const fns = sandbox(liftPopup, [
      '_renderPreviewActions', '_sortActionsByOrder',
      'handleMarkRead', 'handleMarkUnread', '_syncPreviewReadButton',
    ], {
      document,
      ProtonI18n,
      ICONS,
      previewActionsEl: actionsEl,
      _settings: {},
      _selectedMsg: { ID: msg.ID },
      FREE_PREVIEW_ACTIONS: new Set(['markRead', 'exportEml']),
      isPremium: () => !free,
      showPremiumUI: () => !free,
      showUpgradePrompt: vi.fn(),
      _setHTML: () => {},
      doAction: (type, ids, accountId) => actions.push([type, ids, accountId]),
      showToast: (text, undo) => toasts.push({ text, undo }),
    });
    fns._renderPreviewActions(msg, 'acc1');
    const button = () => actionsEl.querySelector('.action-read');
    return { ...fns, actions, toasts, button };
  }

  it('sends MARK_UNREAD for a read message, and says so', () => {
    const p = preview({ ID: 'm1', Unread: 0 });
    expect(p.button().title).toBe('markAsUnread');
    p.button().click();
    expect(p.actions).toEqual([['MARK_UNREAD', ['m1'], 'acc1']]);
    expect(p.toasts.map((t) => t.text)).toEqual(['markedAsUnread']);
  });

  it('still sends MARK_READ for an unread message', () => {
    const p = preview({ ID: 'm1', Unread: 1 });
    expect(p.button().title).toBe('markAsRead');
    p.button().click();
    expect(p.actions).toEqual([['MARK_READ', ['m1'], 'acc1']]);
    expect(p.toasts.map((t) => t.text)).toEqual(['markedAsRead']);
  });

  it('Undo on "Marked as unread" marks it read again', () => {
    const p = preview({ ID: 'm1', Unread: 0 });
    p.button().click();
    p.toasts[0].undo();
    expect(p.actions).toEqual([['MARK_UNREAD', ['m1'], 'acc1'], ['MARK_READ', ['m1'], 'acc1']]);
    expect(p.button().title).toBe('markAsUnread');
  });

  it('flips with each click, so the title always names what a click does', () => {
    const p = preview({ ID: 'm1', Unread: 1 });
    p.button().click();
    expect(p.button().title).toBe('markAsUnread');
    p.button().click();
    expect(p.button().title).toBe('markAsRead');
    expect(p.actions.map((a) => a[0])).toEqual(['MARK_READ', 'MARK_UNREAD']);
  });

  it('flips back when the Undo of "Marked as read" runs', () => {
    const p = preview({ ID: 'm1', Unread: 1 });
    p.button().click();
    p.toasts[0].undo();
    expect(p.button().title).toBe('markAsRead');
    p.button().click();
    expect(p.actions.map((a) => a[0])).toEqual(['MARK_READ', 'MARK_UNREAD', 'MARK_READ']);
  });

  it('works for a free user too: both directions are free', () => {
    const p = preview({ ID: 'm1', Unread: 0 }, { free: true });
    p.button().click();
    expect(p.actions).toEqual([['MARK_UNREAD', ['m1'], 'acc1']]);
  });

  it('marking another message from its list row leaves the open one alone', () => {
    const p = preview({ ID: 'm1', Unread: 1 });
    p.handleMarkRead({ stopPropagation() {} }, 'other', 'acc1');
    expect(p.button().title).toBe('markAsRead');
    expect(p.button().dataset.unread).toBe('1');
  });

  it('the auto-mark paths keep the button in step', () => {
    // Auto-mark-as-read on open and on reply mark the open message read
    // without a click; a stale "Mark as read" would then send MARK_READ again
    // instead of offering unread.
    const open = liftPopup('openPreview');
    expect(open).toMatch(/doAction\('MARK_READ', \[msg\.ID\], msg\._accountId\);\s*_syncPreviewReadButton\(msg\.ID, false\);/);
    const send = liftPopup('handleSendReply');
    expect(send).toMatch(/doAction\('MARK_READ', \[msgId\], accountId\);\s*_syncPreviewReadButton\(msgId, false\);/);
  });
});

// --- 2. Per-account settings ---------------------------------------------

describe('a per-account settings save that is refused says so', () => {
  function saver(reply) {
    const prompts = [];
    const toasts = [];
    const sendMessage = vi.fn(() => (reply instanceof Error ? Promise.reject(reply) : Promise.resolve(reply)));
    const { _saveAccountSettings } = sandbox(liftPopup, ['_saveAccountSettings'], {
      browser: { runtime: { sendMessage } },
      ProtonI18n,
      showUpgradePrompt: (k) => prompts.push(k),
      showToast: (t) => toasts.push(t),
    });
    return { _saveAccountSettings, sendMessage, prompts, toasts };
  }

  it('resolves true on a stored save, quietly', async () => {
    const s = saver({ success: true });
    expect(await s._saveAccountSettings('a1', { label: 'Work' })).toBe(true);
    expect(s.sendMessage).toHaveBeenCalledWith({ type: 'UPDATE_ACCOUNT_SETTINGS', accountId: 'a1', settings: { label: 'Work' } });
    expect(s.prompts).toEqual([]);
    expect(s.toasts).toEqual([]);
  });

  it('shows the upgrade prompt when Premium is required', async () => {
    const s = saver({ error: 'PREMIUM_REQUIRED', feature: 'UPDATE_ACCOUNT_SETTINGS' });
    expect(await s._saveAccountSettings('a1', { color: '#123456' })).toBe(false);
    expect(s.prompts).toEqual(['accountSettings']);
    expect(s.toasts).toEqual([]);
  });

  it('says the action failed for any other answer, or none', async () => {
    for (const reply of [{ error: 'FAILED' }, undefined, new Error('port closed')]) {
      const s = saver(reply);
      expect(await s._saveAccountSettings('a1', { initials: 'W' })).toBe(false);
      expect(s.toasts).toEqual(['actionFailed']);
    }
  });
});

describe('the per-account settings are gated like the other Premium controls', () => {
  const ACCOUNT = { id: 'a1', email: 'user@example.com', folderMode: 'inbox' };

  function accounts({ premium, hideUi = false, updateReply = { success: true } }) {
    const list = document.createElement('ul');
    const prompts = [];
    const sent = [];
    const sendMessage = vi.fn((msg) => {
      sent.push(msg.type);
      if (msg.type === 'UPDATE_ACCOUNT_SETTINGS') return Promise.resolve(updateReply);
      return Promise.resolve(null);
    });
    const fns = sandbox(liftPopup, ['renderAccountsList', '_saveAccountSettings', 'requirePremium'], {
      document,
      ProtonI18n,
      accountsList: list,
      browser: { runtime: { sendMessage } },
      isPremium: () => premium,
      showPremiumUI: () => premium || !hideUi,
      showUpgradePrompt: (k) => prompts.push(k),
      showToast: () => {},
      _setHTML: () => {},
      _getAccountInitials: () => 'U',
      _createColorPicker: () => document.createElement('div'),
      _positionColorPickerPanel: () => {},
      handleRemoveAccount: () => {},
    });
    fns.renderAccountsList([{ ...ACCOUNT }]);
    return {
      list, prompts, sent,
      toggle: () => list.querySelector('.account-toggle-btn'),
      details: () => list.querySelector('.account-details'),
      folderSelect: () => list.querySelector('.account-folder-select'),
    };
  }

  it('a free user gets the upgrade prompt, not the controls', () => {
    const a = accounts({ premium: false });
    a.toggle().click();
    expect(a.prompts).toEqual(['accountSettings']);
    expect(a.details().classList.contains('hidden')).toBe(true);
  });

  it('no settings button at all when the free user hides premium UI', () => {
    const a = accounts({ premium: false, hideUi: true });
    expect(a.toggle()).toBeNull();
    expect(a.details().classList.contains('hidden')).toBe(true);
  });

  it('Premium opens them as before', () => {
    const a = accounts({ premium: true });
    a.toggle().click();
    expect(a.prompts).toEqual([]);
    expect(a.details().classList.contains('hidden')).toBe(false);
  });

  it('a refused folder save does not refresh as if it had worked', async () => {
    const a = accounts({ premium: true, updateReply: { error: 'PREMIUM_REQUIRED' } });
    a.folderSelect().value = 'all';
    a.folderSelect().dispatchEvent(new Event('change'));
    await flush();
    expect(a.sent).toEqual(['UPDATE_ACCOUNT_SETTINGS']);
    expect(a.prompts).toEqual(['accountSettings']);
  });

  it('a stored folder save refreshes', async () => {
    const a = accounts({ premium: true });
    a.folderSelect().value = 'all';
    a.folderSelect().dispatchEvent(new Event('change'));
    await flush();
    expect(a.sent).toEqual(['UPDATE_ACCOUNT_SETTINGS', 'REFRESH']);
  });

  it('every per-account save goes through the checked helper', () => {
    expect(liftPopup('renderAccountsList')).not.toContain('UPDATE_ACCOUNT_SETTINGS');
  });

  it('the reorder arrows check Premium before asking the background', () => {
    const a = accounts({ premium: false });
    // One account: both arrows are disabled, so call their listeners directly.
    for (const btn of a.list.querySelectorAll('.account-reorder')) {
      btn.disabled = false;
      btn.click();
    }
    expect(a.prompts).toEqual(['reorderAccounts', 'reorderAccounts']);
    expect(a.sent).not.toContain('REORDER_ACCOUNT');
  });

  it('no reorder arrows when the free user hides premium UI, the remove button stays', () => {
    const a = accounts({ premium: false, hideUi: true });
    expect(a.list.querySelectorAll('.account-reorder')).toHaveLength(0);
    expect(a.list.querySelector('.account-remove')).not.toBeNull();
  });
});

// --- 3. The e and # shortcuts ---------------------------------------------

describe('the archive and delete shortcuts check Premium like their buttons', () => {
  // The keydown listener is anonymous: lift the arrow function it is given.
  const anchor = POPUP.indexOf("document.addEventListener('keydown', async (e) => {");
  const start = POPUP.indexOf('async (e) => {', anchor);
  const LISTENER = POPUP.slice(start, block(POPUP, start, 'keydown listener'));

  function keyboard({ premium }) {
    const prompts = [];
    const archived = [];
    const trashed = [];
    const env = {
      previewPanel: { classList: { contains: () => false } },
      getFlatMessageItems: () => [{}],
      getFocusedMessage: () => ({ ID: 'm1', _accountId: 'acc1' }),
      setFocusedIndex: () => {},
      openPreview: () => {},
      closePreview: async () => true,
      _focusedIndex: 0,
      _selectedMsg: null,
      _settings: {},
      replyBody: null,
      replyText: null,
      handleArchive: (e, id) => archived.push(id),
      handleTrash: (e, id) => trashed.push(id),
      isPremium: () => premium,
      showUpgradePrompt: (k) => prompts.push(k),
    };
    const keys = Object.keys(env);
    const listener = new Function('__env',
      'const { ' + keys.join(', ') + ' } = __env;\n' + liftPopup('requirePremium') + '\nreturn ' + LISTENER + ';')(env);
    const press = (key) => listener({ key, target: document.body, preventDefault() {} });
    return { press, prompts, archived, trashed };
  }

  it('a free user gets the upgrade prompt and no optimistic toast', async () => {
    const k = keyboard({ premium: false });
    await k.press('e');
    await k.press('#');
    expect(k.prompts).toEqual(['archive', 'delete']);
    expect(k.archived).toEqual([]);
    expect(k.trashed).toEqual([]);
  });

  it('Premium archives and deletes as before', async () => {
    const k = keyboard({ premium: true });
    await k.press('e');
    await k.press('#');
    expect(k.prompts).toEqual([]);
    expect(k.archived).toEqual(['m1']);
    expect(k.trashed).toEqual(['m1']);
  });

  it('uses the same feature keys as the archive and delete buttons', () => {
    // The list and preview buttons gate with showUpgradePrompt(action.key),
    // and their keys are 'archive' and 'delete'.
    const row = liftPopup('_renderPreviewActions');
    expect(row).toContain("key: 'archive'");
    expect(row).toContain("key: 'delete'");
  });
});

// --- The sync label ---------------------------------------------------------

describe('the options page names the sync account of the browser it runs in', () => {
  const BODY = OPTIONS_HTML.slice(OPTIONS_HTML.indexOf('<body>') + 6, OPTIONS_HTML.lastIndexOf('</body>'));

  function label(isFirefox) {
    document.body.innerHTML = BODY;
    const { _applySyncLabel } = sandbox(liftOptions, ['_applySyncLabel'], {
      document,
      ProtonBrowserInfo: { isFirefox: () => isFirefox },
    });
    _applySyncLabel();
    return document.getElementById('sync-enabled').parentElement.querySelector('span');
  }

  it('Chrome gets its own label', () => {
    expect(label(false).getAttribute('data-i18n')).toBe('syncSettingsChrome');
  });

  it('Firefox keeps the Firefox account label', () => {
    expect(label(true).getAttribute('data-i18n')).toBe('syncSettings');
  });

  it('runs before the first translation pass', () => {
    const init = OPTIONS.indexOf('\n  _applySyncLabel();');
    expect(init).toBeGreaterThan(-1);
    expect(init).toBeLessThan(OPTIONS.indexOf('\n  loadSettings();'));
  });
});
