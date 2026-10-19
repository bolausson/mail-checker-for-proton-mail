/**
 * @vitest-environment jsdom
 *
 * Per-account settings chosen during the trial kept applying after it ended.
 * Notifications switched off for an account stayed off, and an account set
 * to custom folders or All mail kept monitoring them, while the free user
 * could no longer change either: the popup controls are Pro-gated and the
 * background refuses UPDATE_ACCOUNT_SETTINGS.
 *
 * Every other Pro setting reverts when the trial ends, so these do too: while
 * not Premium the background behaves as if they were at their defaults
 * (notifications on, Inbox), without deleting what is stored, so a
 * subscription brings them back. Label, initials and color follow the same
 * rule (tests/pro-settings.test.js).
 *
 * Also here: the popup no longer asks for folders and labels for a panel a
 * free user cannot open, and the options page's "Reset to defaults" says
 * what it kept.
 *
 * House style: the functions under test are lifted out of the real sources
 * by name and evaluated with their dependencies injected.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const ROOT = join(__dirname, '..');
const read = (rel) => readFileSync(join(ROOT, rel), 'utf-8');
const ACCOUNTS = read('background/accounts.js');
const NOTIFIER = read('background/notifier.js');
const POLLER = read('background/poller.js');
const POPUP = read('popup/popup.js');
const OPTIONS = read('options/options.js');
const ProtonMonitoredIds = new Function(read('lib/monitored-ids.js') + '; return ProtonMonitoredIds;')();
const ProtonProSettings = new Function(read('lib/pro-settings.js') + '; return ProtonProSettings;')();

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
    // The body opens after the parameter list, which can hold braces or
    // calls of its own (defaults).
    const body = src.indexOf(') {', m.index) + 1;
    return src.slice(m.index, block(src, body, name));
  };
}

/** Evaluate lifted functions with `env`'s keys in scope. */
function sandbox(lift, names, env) {
  const keys = Object.keys(env || {});
  const parts = [];
  if (keys.length) parts.push('const { ' + keys.join(', ') + ' } = __env;');
  for (const n of names) parts.push(lift(n));
  parts.push('return { ' + names.join(', ') + ' };');
  return new Function('__env', parts.join('\n\n'))(env || {});
}

const liftAccounts = makeLift(ACCOUNTS, 'accounts.js');
const liftPoller = makeLift(POLLER, 'poller.js');
const liftPopup = makeLift(POPUP, 'popup.js');
const liftOptions = makeLift(OPTIONS, 'options.js');

const F_ONE = 'FOLDA1xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx==';
const F_TWO = 'FOLDB2xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx==';

// --- 1. The folders an account monitors -------------------------------------

/** accounts.js with a fake server and a switchable Premium. */
function accountsModule(server) {
  const names = ['_proSettingsApply', '_folderMode', '_monitoredQueryIds', 'getMonitoredLabelIds',
    'getMonitoredUnreadCount', 'getMonitoredMessages', 'checkMonitoredAgainstCounts', '_scopeKey',
    'applyPremiumScope', '_applySnapshot', 'saveSnapshot', 'importAccountSettings', '_exportEntry',
    '_recordMonitorConfig', '_recordLeak', '_recordReadInUnread', '_pruneStaleMonitoredIds'];
  return sandbox(liftAccounts, names, {
    _accounts: server.accounts,
    getAccount: (id) => server.accounts.find((a) => a.id === id) || null,
    getMessages: async (_acc, id) => { server.queries.push(id); return []; },
    getCountsForViewMode: async () => server.counts,
    getInboxUnreadCount: async () => 7,
    getFolders: async () => { server.lookups++; return { Labels: [] }; },
    getLabels: async () => ({ Labels: [] }),
    _save: async () => { server.order.push('save'); },
    _persistEncryptedCache: async () => {},
    _monitoredIdsConfirmed: new Map(),
    _STALE_MONITOR_IDS_MAX: 200,
    SNAPSHOT_KEY: 'protonAccountsSnapshot',
    browser: {
      storage: {
        session: {
          set: async (o) => {
            server.order.push('snapshot');
            server.session = JSON.parse(JSON.stringify(o));
          },
        },
      },
    },
    ProtonPremium: { isPremium: () => server.premium },
    ProtonDiag: { once: async () => true, record: (event, f) => server.records.push({ event, ...f }) },
    ProtonLabels: { INBOX: '0', ALL_MAIL: '5' },
    ProtonMonitoredIds,
    debugLog: () => {},
  });
}

function world(premium) {
  return {
    premium,
    accounts: [
      { id: 'custom', email: 'one@example.com', folderMode: 'custom', monitoredFolders: [F_ONE, F_TWO], monitoredLabels: [],
        notificationsEnabled: false, label: 'Work', color: '#123456', lastEventId: 'E9', scopeGen: 2, countGen: 2 },
      { id: 'all', email: 'two@example.com', folderMode: 'all', lastEventId: 'E5', scopeGen: 0, countGen: 0 },
      { id: 'inbox', email: 'three@example.com', folderMode: 'inbox', lastEventId: 'E7', scopeGen: 0, countGen: 0 },
    ],
    counts: [
      { LabelID: '0', Unread: 7 }, { LabelID: '5', Unread: 40 },
      { LabelID: F_ONE, Unread: 2 }, { LabelID: F_TWO, Unread: 3 },
    ],
    queries: [], lookups: 0, order: [], records: [], session: null,
  };
}

describe('the folders an account monitors follow Premium', () => {
  it('without Premium a custom selection monitors Inbox', async () => {
    const w = world(false);
    const api = accountsModule(w);
    expect(api.getMonitoredLabelIds('custom')).toEqual(['0']);
    expect(await api.getMonitoredUnreadCount('custom')).toBe(7);
    await api.getMonitoredMessages('custom', 20, { unreadOnly: true });
    expect(w.queries).toEqual(['0']);
  });

  it('without Premium All mail monitors Inbox too', async () => {
    const w = world(false);
    const api = accountsModule(w);
    expect(api.getMonitoredLabelIds('all')).toEqual(['0']);
    expect(await api.getMonitoredUnreadCount('all')).toBe(7);
  });

  it('with Premium they monitor what was chosen', async () => {
    const w = world(true);
    const api = accountsModule(w);
    expect(api.getMonitoredLabelIds('custom')).toEqual([F_ONE, F_TWO]);
    expect(await api.getMonitoredUnreadCount('custom')).toBe(5);
    expect(api.getMonitoredLabelIds('all')).toBe(null);
    expect(await api.getMonitoredUnreadCount('all')).toBe(40);
  });

  it('keeps what is stored, so a subscription brings it back', async () => {
    const w = world(false);
    const api = accountsModule(w);
    await api.getMonitoredMessages('custom', 20, { unreadOnly: true });
    // A selection out of effect is not checked for deleted folders either.
    await api.checkMonitoredAgainstCounts('custom', []);
    expect(w.lookups).toBe(0);
    expect(w.accounts[0]).toMatchObject({ folderMode: 'custom', monitoredFolders: [F_ONE, F_TWO] });
    w.premium = true;
    expect(api.getMonitoredLabelIds('custom')).toEqual([F_ONE, F_TWO]);
  });

  it('the log names what is queried and what is stored', async () => {
    const w = world(false);
    const api = accountsModule(w);
    await api.getMonitoredMessages('custom', 20, { unreadOnly: true });
    expect(w.records.find((r) => r.event === 'monitor.config').monitor)
      .toBe('mode=inbox (no Premium; stored mode=custom folders=FOLDA1,FOLDB2 labels=-)');
  });

  it('a synced copy of another selection changes nothing a free account polls', async () => {
    // Firefox re-imports synced settings on every worker start, Premium or not.
    const w = world(false);
    const api = accountsModule(w);
    const result = await api.importAccountSettings({
      'one@example.com': { folderMode: 'custom', monitoredFolders: [F_ONE], monitoredLabels: [] },
    });
    expect(result.scopeChanged).toEqual([]);
    expect(w.accounts[0].lastEventId).toBe('E9');
    expect(w.accounts[0].monitoredFolders).toEqual([F_ONE]);
  });
});

describe('Premium starting or ending switches the folders like the picker does', () => {
  it('resets the cursor of every account that monitors more than Inbox', async () => {
    const w = world(false);
    const api = accountsModule(w);
    expect(await api.applyPremiumScope(false)).toBe(true);
    const [custom, all, inbox] = w.accounts;
    for (const a of [custom, all]) {
      expect(a.lastEventId).toBe(null);
      // The next poll takes the new set's existing mail in silently.
      expect(a.countGen).toBe(null);
    }
    expect(custom.scopeGen).toBe(3);
    expect(all.scopeGen).toBe(1);
    expect(inbox).toMatchObject({ lastEventId: 'E7', scopeGen: 0, countGen: 0 });
  });

  it('writes the snapshot before the settings, carrying the reset', async () => {
    const w = world(false);
    const api = accountsModule(w);
    await api.applyPremiumScope(false);
    expect(w.order).toEqual(['snapshot', 'save']);
    const snap = w.session.protonAccountsSnapshot;
    expect(snap.custom).toMatchObject({ lastEventId: null, countGen: null, effectiveFolderMode: 'inbox' });
  });

  it('does nothing when every account monitors Inbox', async () => {
    const w = world(true);
    w.accounts = w.accounts.filter((a) => a.id === 'inbox');
    const api = accountsModule(w);
    expect(await api.applyPremiumScope(true)).toBe(false);
    expect(w.order).toEqual([]);
    expect(w.accounts[0].lastEventId).toBe('E7');
  });
});

describe('a wake after Premium changed while no worker ran', () => {
  const snapshot = (mode) => ({
    custom: { messages: [], unreadCount: 5, lastEventId: 'E9', countGen: 2, effectiveFolderMode: mode },
  });

  it('does not resume a cursor taken for the other folders', () => {
    const w = world(false);
    const api = accountsModule(w);
    expect(api._applySnapshot(snapshot('custom'))).toBe(true);
    expect(w.accounts[0].lastEventId).toBe(null);
    expect(w.accounts[0].countGen).toBe(null);
  });

  it('resumes it when the folders in effect are the same', () => {
    const w = world(true);
    const api = accountsModule(w);
    api._applySnapshot(snapshot('custom'));
    expect(w.accounts[0].lastEventId).toBe('E9');
    expect(w.accounts[0].countGen).toBe(2);
  });

  it('records the folders in effect with every snapshot', async () => {
    const w = world(false);
    const api = accountsModule(w);
    await api.saveSnapshot();
    const snap = w.session.protonAccountsSnapshot;
    expect(snap.custom.effectiveFolderMode).toBe('inbox');
    w.premium = true;
    await api.saveSnapshot();
    expect(w.session.protonAccountsSnapshot.custom.effectiveFolderMode).toBe('custom');
  });
});

describe('the background re-applies the folders when Premium flips', () => {
  it('from the premium-change hook', () => {
    const at = read('background/background.js').indexOf('\n  ProtonPremium.onPremiumChange(');
    const hook = read('background/background.js').slice(at, at + 1200);
    expect(hook).toMatch(/await ProtonAccounts\.applyPremiumScope\(premium\)/);
  });
});

// --- 2. The account's notification switch -----------------------------------

describe('an account\'s notification switch follows Premium', () => {
  function notifier({ premium }) {
    const shown = [];
    const session = {};
    const browser = {
      storage: {
        session: {
          get: async (k) => ({ [k]: session[k] }),
          set: async (o) => { Object.assign(session, o); },
        },
      },
      notifications: {
        create: async (id, opt) => { shown.push(opt); return id; },
        clear() {},
        onClicked: { addListener() {} },
      },
      tabs: { create() {} },
    };
    const accounts = {
      getAccount: () => ({ id: 'acc1', email: 'user@example.com', notificationsEnabled: false }),
      getAccounts: () => [{ id: 'acc1' }],
      getMailUrl: () => 'https://mail.proton.me/u/0/inbox',
    };
    const N = new Function('browser', 'getSettings', 'ProtonDND', 'ProtonAccounts',
      'ProtonPremium', 'ProtonI18n', 'ProtonAudioBridge', 'ProtonPoller', 'console',
      NOTIFIER + '\nreturn ProtonNotifier;')(
      browser,
      async () => ({ notificationsEnabled: true }),
      { isActive: () => false },
      accounts,
      { isPremium: () => premium },
      { t: (k) => k, plural: (k, n) => n + ' ' + k },
      { playSound: async () => {} },
      { poll() {} },
      { warn() {}, log() {}, error() {} });
    N.init();
    return { N, shown };
  }

  const mail = { ID: 'm1', ConversationID: 'c1', Subject: 'Hello', Sender: { Name: 'Sender', Address: 'sender@example.com' } };

  it('switched off during the trial, it is out of effect without Premium', async () => {
    const { N, shown } = notifier({ premium: false });
    await N.notifyNewMessages([mail], 'user@example.com', 'acc1');
    expect(shown).toHaveLength(1);
  });

  it('with Premium it still silences the account', async () => {
    const { N, shown } = notifier({ premium: true });
    await N.notifyNewMessages([mail], 'user@example.com', 'acc1');
    expect(shown).toEqual([]);
  });

  function announcer({ premium }) {
    const forced = [];
    const notified = [];
    const { _announce } = sandbox(liftPoller, ['_announce'], {
      getSettings: async () => ({ notificationsEnabled: true }),
      ProtonDND: { isActive: () => false },
      ProtonPremium: { isPremium: () => premium },
      _fetchSnippets: async (_id, _msgs, opts) => { forced.push(opts.force); },
      _applyNotificationRules: async () => {},
      ProtonNotifier: { notifyNewMessages: async (msgs) => { notified.push(...msgs.map((m) => m.ID)); } },
    });
    return { _announce, forced, notified };
  }

  it('the poller fetches the preview text for a notification that will show', async () => {
    // Skipped for a switched-off account, the notification would show the
    // subject alone although "show preview text" is on.
    const a = announcer({ premium: false });
    await a._announce('acc1', { id: 'acc1', notificationsEnabled: false }, [mail]);
    expect(a.forced).toEqual([true]);
    const p = announcer({ premium: true });
    await p._announce('acc1', { id: 'acc1', notificationsEnabled: false }, [mail]);
    expect(p.forced).toEqual([false]);
  });
});

// --- 3. The popup's per-account panel ----------------------------------------

describe('the per-account panel asks for folders only when it can be used', () => {
  function panel({ premium, folderMode = 'custom' }) {
    const list = document.createElement('ul');
    const sent = [];
    const prompts = [];
    const sendMessage = async (msg) => {
      sent.push(msg.type);
      if (msg.type === 'GET_FOLDERS' || msg.type === 'GET_LABELS') return [];
      return { success: true };
    };
    const fns = sandbox(liftPopup, ['renderAccountsList', '_saveAccountSettings', 'requirePremium'], {
      document,
      ProtonI18n: { t: (k) => k },
      accountsList: list,
      browser: { runtime: { sendMessage } },
      isPremium: () => premium,
      showPremiumUI: () => true,
      showUpgradePrompt: (k) => prompts.push(k),
      showToast: () => {},
      _setHTML: () => {},
      _getAccountInitials: () => 'U',
      _createColorPicker: () => document.createElement('div'),
      _positionColorPickerPanel: () => {},
      handleRemoveAccount: () => {},
    });
    fns.renderAccountsList([{ id: 'a1', email: 'user@example.com', folderMode, monitoredFolders: [F_ONE] }]);
    return { sent, prompts, toggle: () => list.querySelector('.account-toggle-btn') };
  }

  it('a free user with a custom selection from the trial: no request at all', () => {
    const p = panel({ premium: false });
    expect(p.sent).toEqual([]);
    p.toggle().click();
    expect(p.prompts).toEqual(['accountSettings']);
    expect(p.sent).toEqual([]);
  });

  it('Premium: the pickers are filled when the panel first opens', () => {
    const p = panel({ premium: true });
    expect(p.sent).toEqual([]);
    p.toggle().click();
    expect(p.sent).toEqual(['GET_FOLDERS', 'GET_LABELS']);
    p.toggle().click();
    p.toggle().click();
    expect(p.sent).toEqual(['GET_FOLDERS', 'GET_LABELS']);
  });

  it('an Inbox account asks for nothing until custom is chosen', () => {
    const p = panel({ premium: true, folderMode: 'inbox' });
    p.toggle().click();
    expect(p.sent).toEqual([]);
  });
});

// --- 4. Reset to defaults ----------------------------------------------------

describe('Reset to defaults says what it reset', () => {
  const at = OPTIONS.indexOf("document.getElementById('btn-reset').addEventListener('click', async () => {");
  const start = OPTIONS.indexOf('async () => {', at);
  const HANDLER = OPTIONS.slice(start, block(OPTIONS, start, 'reset handler'));

  // What a trial left behind: two Pro choices and one free one.
  const LEFT = { ...ProtonProSettings.DEFAULTS, navWrap: true, badgeColor: '#112233', language: 'de' };

  function options({ update, premium = true }) {
    const sent = [];
    const status = [];
    const stored = { settings: { ...LEFT } };
    const browser = {
      storage: {
        local: {
          get: async () => ({ settings: stored.settings }),
          set: async (o) => { Object.assign(stored, o); },
        },
        sync: { set: async () => {} },
      },
      runtime: {
        sendMessage: async (msg) => {
          sent.push(msg);
          if (msg.type === 'GET_ACCOUNTS') return [{ id: 'a1' }, { id: 'a2' }, { id: 'a3' }];
          if (msg.type === 'UPDATE_ACCOUNT_SETTINGS') return update(msg);
          return undefined;
        },
      },
    };
    const env = {
      document,
      browser,
      ProtonI18n: { t: (k) => k },
      ProtonDialog: { confirm: async () => true },
      ProtonProSettings,
      DEFAULT_SETTINGS: ProtonProSettings.DEFAULTS,
      _premiumNow: premium,
      _syncInEffect: async () => false,
      loadSettings: () => {},
      showStatus: (text, ms) => status.push({ text, ms }),
    };
    const keys = Object.keys(env);
    const handler = new Function('__env',
      'const { ' + keys.join(', ') + ' } = __env;\n' + liftOptions('_resetAccountSettings') + '\nreturn ' + HANDLER + ';')(env);
    return { handler, sent, status, stored };
  }

  const updates = (o) => o.sent.filter((m) => m.type === 'UPDATE_ACCOUNT_SETTINGS').map((m) => m.accountId);

  it('Premium: everything reset, as before', async () => {
    const o = options({ update: () => ({ success: true }) });
    await o.handler();
    expect(updates(o)).toEqual(['a1', 'a2', 'a3']);
    expect(o.stored.settings).toEqual(ProtonProSettings.DEFAULTS);
    expect(o.status.map((s) => s.text)).toEqual(['settingsReset']);
  });

  it('free: only the free settings are reset; the Pro ones and the per-account ones are kept', async () => {
    const o = options({ premium: false, update: () => ({ success: true }) });
    await o.handler();
    // Nothing is asked of the background that it would refuse.
    expect(updates(o)).toEqual([]);
    expect(o.stored.settings.language).toBe('en');
    expect(o.stored.settings.navWrap).toBe(true);
    expect(o.stored.settings.badgeColor).toBe('#112233');
    expect(o.status.map((s) => s.text)).toEqual(['settingsResetProKept']);
  });

  it('the trial ended while the page was open: it says the per-account ones were kept', async () => {
    const o = options({ update: () => ({ error: 'PREMIUM_REQUIRED', feature: 'UPDATE_ACCOUNT_SETTINGS' }) });
    await o.handler();
    // Refused once means refused for all: no point asking twice more.
    expect(updates(o)).toEqual(['a1']);
    expect(o.status.map((s) => s.text)).toEqual(['settingsResetAccountsKept']);
  });

  it('any other failed save is named too, and the rest are still reset', async () => {
    const o = options({ update: (m) => (m.accountId === 'a2' ? undefined : { success: true }) });
    await o.handler();
    expect(updates(o)).toEqual(['a1', 'a2', 'a3']);
    expect(o.status.map((s) => s.text)).toEqual(['settingsResetAccountsFailed']);
  });

  it('a save that throws counts as failed', async () => {
    const o = options({ update: () => { throw new Error('port closed'); } });
    await o.handler();
    expect(o.status.map((s) => s.text)).toEqual(['settingsResetAccountsFailed']);
  });
});

beforeEach(() => { document.body.innerHTML = '<button id="btn-reset"></button>'; });
