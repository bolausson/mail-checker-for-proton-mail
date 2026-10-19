/**
 * A notification click opens the mailbox of the account it is for.
 *
 * With several accounts, a click on a notification for the second account
 * opened the FIRST account's mailbox: handleClick called getMailUrl() and
 * getMailUrl(convId) without the account, and getMailUrl resolves a missing
 * account to /u/0/. The account was in the click map all along; only "mark
 * as read" and "archive" used it.
 *
 * A notification for several new messages had no map entry at all, so it
 * opened /u/0/ too, and its id was only a timestamp: accounts are polled in
 * parallel, and two of them announcing in the same millisecond shared an id.
 * The "sign in again" notification of an account had no entry either.
 *
 * A click that wakes the background reads the map back from storage.session
 * and waits for init (see notification-click-cold-wake.test.js). The /u/N/
 * slot itself comes from a map url-detection.js loads from storage, and init
 * started that read without waiting for it, so a woken click could build its
 * link first and resolve the account by its list position.
 *
 * House style: notifier.js, url-detection.js, background.js's _initialize and
 * accounts.js's initUrlDetection run for real with their dependencies
 * injected; the settings are read through the real getSettings().
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const ROOT = join(__dirname, '..');
const read = (rel) => readFileSync(join(ROOT, rel), 'utf-8');
const NOTIFIER = read('background/notifier.js');
const URL_DETECTION = read('background/url-detection.js');
const CONSTANTS = read('background/constants.js');
const BACKGROUND = read('background/background.js');
const ACCOUNTS = read('background/accounts.js');
const ProtonProSettings = new Function(read('lib/pro-settings.js') + '; return ProtonProSettings;')();

/** A top-level `async function name(...) { ... }` out of `src`. */
function liftFn(src, name) {
  const m = new RegExp('(async )?function ' + name + '\\(').exec(src);
  if (!m) throw new Error('not found: ' + name);
  let depth = 0;
  for (let i = src.indexOf('{', src.indexOf(') {', m.index)); i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) return src.slice(m.index, i + 1); }
  }
  throw new Error('unbalanced braces reading ' + name);
}

const flush = () => new Promise((r) => setTimeout(r, 0));
const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));

/**
 * The browser around the workers: what outlives one. The second account's web
 * session is /u/3/, neither /u/0/ (the bug) nor /u/1/ (its list position).
 */
function makeWorld({ action = 'openMessage', webViewModeB } = {}) {
  const second = { id: 'acc-b', uid: 'uid-b', email: 'second@example.com' };
  if (webViewModeB !== undefined) second.webViewMode = webViewModeB;
  return {
    accounts: [{ id: 'acc-a', uid: 'uid-a', email: 'first@example.com' }, second],
    local: {
      settings: { notificationClickAction: action },
      accountUrlMap: {
        'uid-a': { slot: 0, detectedAt: '2026-10-01T00:00:00.000Z' },
        'uid-b': { slot: 3, detectedAt: '2026-10-01T00:00:00.000Z' },
      },
    },
    session: {},
    notifications: new Map(),
    opened: [],
  };
}

/**
 * One background: fresh module state over the shared world. start() runs the
 * real _initialize, which registers the click listener before its first
 * await, as on a wake. `slowUrlMap` holds the slot map's storage read back
 * until releaseUrlMap().
 */
function startWorker(world, { premium = true, slowUrlMap = false } = {}) {
  const state = { premium: false };
  const accounts = []; // accounts.js _accounts: empty until initFast
  const calls = { marked: [], archived: [], warnings: [] };
  let clickListener = null;
  let releaseUrlMap = () => {};
  const urlMapGate = slowUrlMap ? new Promise((r) => { releaseUrlMap = r; }) : null;
  const consoleStub = { warn: (...a) => calls.warnings.push(a.join(' ')), log() {}, error() {} };

  const browser = {
    storage: {
      local: {
        get: async (keys) => {
          const list = typeof keys === 'string' ? [keys] : keys;
          if (urlMapGate && list.includes('accountUrlMap')) await urlMapGate;
          const out = {};
          for (const k of list) if (world.local[k] !== undefined) out[k] = clone(world.local[k]);
          return out;
        },
        set: async (o) => { Object.assign(world.local, clone(o)); },
      },
      session: {
        get: async (k) => ({ [k]: clone(world.session[k]) }),
        set: async (o) => { for (const [k, v] of Object.entries(o)) world.session[k] = clone(v); },
      },
      sync: { get: async () => ({}) },
    },
    notifications: {
      create: async (id, opt) => { world.notifications.set(id, opt); return id; },
      clear: (id) => { world.notifications.delete(id); },
      onClicked: { addListener: (fn) => { clickListener = fn; } },
    },
    tabs: {
      create: ({ url }) => { world.opened.push(url); },
      onUpdated: { addListener() {}, removeListener() {} },
      query: async () => [],
    },
  };

  const ProtonPremium = { init: async () => { state.premium = premium; }, isPremium: () => state.premium };
  const ProtonDND = { init: async () => {}, isActive: () => false };
  const ProtonPoller = { start() {}, resume: async () => {}, initialLoad: async () => {}, poll() {} };
  const ProtonAccounts = {
    initFast: async () => { accounts.push(...clone(world.accounts)); },
    initSlow: async () => {},
    hasAccounts: () => accounts.length > 0,
    hasSnapshot: () => true,
    importAccountSettings: async () => {},
    getAccounts: () => accounts,
    getAccount: (id) => accounts.find((a) => a.id === id) || null,
    // As accounts.js: delegated to url-detection.js.
    getMailUrl: (...args) => ProtonUrlDetection.getMailUrl(...args),
    markAsRead: async (id, ids) => { calls.marked.push({ id, ids }); },
    archiveMessages: async (id, ids) => { calls.archived.push({ id, ids }); },
  };
  const ProtonUrlDetection = new Function('browser', 'debugLog', 'ProtonScripting', 'ProtonAccounts', 'console',
    URL_DETECTION + '\nreturn ProtonUrlDetection;')(browser, () => {}, {}, ProtonAccounts, consoleStub);
  ProtonAccounts.initUrlDetection = new Function('ProtonUrlDetection', '_accounts',
    liftFn(ACCOUNTS, 'initUrlDetection') + '\nreturn initUrlDetection;')(ProtonUrlDetection, accounts);

  const getSettings = new Function('browser', 'ProtonProSettings', 'ProtonPremium',
    liftFn(CONSTANTS, 'getSettings') + '\nreturn getSettings;')(browser, ProtonProSettings, ProtonPremium);
  const ProtonNotifier = new Function('browser', 'getSettings', 'ProtonDND', 'ProtonAccounts', 'ProtonPremium',
    'ProtonI18n', 'ProtonAudioBridge', 'ProtonPoller', 'console', NOTIFIER + '\nreturn ProtonNotifier;')(
    browser, getSettings, ProtonDND, ProtonAccounts, ProtonPremium, { t: (k) => k },
    { playSound: async () => {} }, ProtonPoller, consoleStub);

  const initialize = new Function('ProtonNotifier', 'ProtonDND', 'ProtonPremium', 'ProtonAccounts',
    'ProtonProSettings', 'ProtonBadge', 'ProtonPoller', 'browser', 'console',
    'let _initDone = false;\nlet _markLoaded;\n' +
    'const _loaded = new Promise((resolve) => { _markLoaded = resolve; });\n' +
    liftFn(BACKGROUND, '_initialize') + '\nreturn _initialize;')(
    ProtonNotifier, ProtonDND, ProtonPremium, ProtonAccounts, ProtonProSettings,
    { setLoggedOut() {} }, ProtonPoller, browser, consoleStub);

  return {
    calls,
    start: () => initialize(),
    releaseUrlMap: () => releaseUrlMap(),
    notify: (messages, accountId) => ProtonNotifier.notifyNewMessages(
      messages, (world.accounts.find((a) => a.id === accountId) || {}).email, accountId),
    // As accounts.js _setAuthError.
    authError: (accountId, reason) => ProtonNotifier.notifyAuthError(
      (world.accounts.find((a) => a.id === accountId) || {}).email, reason, accountId),
    click: (id) => clickListener(id),
  };
}

/** A background that has been running for a while. */
async function running(world, opts) {
  const w = startWorker(world, opts);
  await w.start();
  return w;
}

const mail = (accountId, n) => ({
  ID: 'msg-' + n, ConversationID: 'conv-' + n, Subject: 'Subject ' + n,
  Sender: { Name: 'Sender', Address: 'sender@example.com' }, _accountId: accountId,
});

afterEach(() => { vi.restoreAllMocks(); });

describe('a click opens the account the notification is for', () => {
  it('open message: the second account\'s conversation in its own session (the bug: /u/0/)', async () => {
    const world = makeWorld();
    const w = await running(world);
    await w.notify([mail('acc-b', 'b')], 'acc-b');
    await w.click('proton-conv-conv-b');
    expect(world.opened).toEqual(['https://mail.proton.me/u/3/inbox/conv-b/msg-b']);

    await w.notify([mail('acc-a', 'a')], 'acc-a');
    await w.click('proton-conv-conv-a');
    expect(world.opened[1]).toBe('https://mail.proton.me/u/0/inbox/conv-a/msg-a');
  });

  it('the same link as the popup\'s "Open in Proton Mail", single-message accounts included', async () => {
    // Web client in single-message mode: the link routes by message id.
    const world = makeWorld({ webViewModeB: 1 });
    const w = await running(world);
    await w.notify([mail('acc-b', 'b')], 'acc-b');
    await w.click('proton-conv-conv-b');
    expect(world.opened).toEqual(['https://mail.proton.me/u/3/inbox/msg-b']);
  });

  it('open inbox: that account\'s inbox', async () => {
    const world = makeWorld({ action: 'openInbox' });
    const w = await running(world);
    await w.notify([mail('acc-b', 'b')], 'acc-b');
    await w.click('proton-conv-conv-b');
    expect(world.opened).toEqual(['https://mail.proton.me/u/3/inbox']);
  });

  it('free plan: the default action, for the right account too', async () => {
    const world = makeWorld({ action: 'openInbox' });
    const w = await running(world, { premium: false });
    await w.notify([mail('acc-b', 'b')], 'acc-b');
    await w.click('proton-conv-conv-b');
    expect(world.opened).toEqual(['https://mail.proton.me/u/3/inbox/conv-b/msg-b']);
  });

  it('mark as read and archive act on that account', async () => {
    const world = makeWorld({ action: 'markRead' });
    const w = await running(world);
    await w.notify([mail('acc-b', 'b')], 'acc-b');
    await w.click('proton-conv-conv-b');
    expect(w.calls.marked).toEqual([{ id: 'acc-b', ids: ['msg-b'] }]);

    world.local.settings.notificationClickAction = 'archive';
    await w.notify([mail('acc-b', 'b2')], 'acc-b');
    await w.click('proton-conv-conv-b2');
    expect(w.calls.archived).toEqual([{ id: 'acc-b', ids: ['msg-b2'] }]);
    expect(world.opened).toEqual([]);
  });
});

describe('a notification for several new messages', () => {
  it('opens its account\'s inbox, for open message and open inbox alike', async () => {
    for (const action of ['openMessage', 'openInbox']) {
      const world = makeWorld({ action });
      const w = await running(world);
      await w.notify([mail('acc-b', 'b1'), mail('acc-b', 'b2')], 'acc-b');
      const [id] = world.notifications.keys();
      expect(id.startsWith('proton-multi-')).toBe(true);
      await w.click(id);
      expect(world.opened, action).toEqual(['https://mail.proton.me/u/3/inbox']);
    }
  });

  it('mark as read and archive: still no single message to act on, and logged', async () => {
    for (const action of ['markRead', 'archive']) {
      const world = makeWorld({ action });
      const w = await running(world);
      await w.notify([mail('acc-b', 'b1'), mail('acc-b', 'b2')], 'acc-b');
      await w.click([...world.notifications.keys()][0]);
      expect(w.calls.marked).toEqual([]);
      expect(w.calls.archived).toEqual([]);
      expect(w.calls.warnings.join(' '), action).toContain('No message data');
    }
  });

  it('two accounts announcing in the same millisecond keep one notification each', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(1790000000000);
    const world = makeWorld({ action: 'openInbox' });
    const w = await running(world);
    // Accounts are polled in parallel (poller.js poll()).
    await Promise.all([
      w.notify([mail('acc-a', 'a1'), mail('acc-a', 'a2')], 'acc-a'),
      w.notify([mail('acc-b', 'b1'), mail('acc-b', 'b2')], 'acc-b'),
    ]);
    const ids = [...world.notifications.keys()];
    expect(ids).toHaveLength(2);
    for (const id of ids) await w.click(id);
    expect(world.opened.sort()).toEqual(['https://mail.proton.me/u/0/inbox', 'https://mail.proton.me/u/3/inbox']);
  });
});

describe('a "sign in again" notification', () => {
  it('opens its account\'s inbox, not /u/0/, even from a woken background', async () => {
    for (const action of ['openMessage', 'openInbox']) {
      const world = makeWorld({ action });
      await (await running(world)).authError('acc-b', 'reauth');
      const [id] = world.notifications.keys();
      expect(id).toBe('proton-autherror-second@example.com');

      const woken = startWorker(world);
      const init = woken.start();
      await woken.click(id);
      await init;
      expect(world.opened, action).toEqual(['https://mail.proton.me/u/3/inbox']);
    }
  });

  it('mark as read and archive: no message to act on, as before', async () => {
    for (const action of ['markRead', 'archive']) {
      const world = makeWorld({ action });
      const w = await running(world);
      await w.authError('acc-b', 'disabled');
      await w.click([...world.notifications.keys()][0]);
      expect(w.calls.marked).toEqual([]);
      expect(w.calls.archived).toEqual([]);
      expect(w.calls.warnings.join(' '), action).toContain('No message data');
    }
  });
});

describe('a click that wakes the background', () => {
  it('still opens the account the notification is for', async () => {
    const world = makeWorld();
    // Shown by a background that has been stopped since.
    await (await running(world)).notify([mail('acc-b', 'b')], 'acc-b');

    const woken = startWorker(world);
    const init = woken.start();
    await woken.click('proton-conv-conv-b');
    await init;
    expect(world.opened).toEqual(['https://mail.proton.me/u/3/inbox/conv-b/msg-b']);
  });

  it('waits for the slot map too: before it loads, the account resolves by list position', async () => {
    for (const [action, url] of [
      ['openMessage', 'https://mail.proton.me/u/3/inbox/conv-b/msg-b'],
      ['openInbox', 'https://mail.proton.me/u/3/inbox'],
    ]) {
      const world = makeWorld({ action });
      await (await running(world)).notify([mail('acc-b', 'b')], 'acc-b');

      const woken = startWorker(world, { slowUrlMap: true });
      const init = woken.start();
      const click = woken.click('proton-conv-conv-b');
      for (let i = 0; i < 5; i++) await flush();
      // Before the fix: https://mail.proton.me/u/1/... here, the list position.
      expect(world.opened, action).toEqual([]);
      woken.releaseUrlMap();
      await click;
      await init;
      expect(world.opened, action).toEqual([url]);
    }
  });
});
