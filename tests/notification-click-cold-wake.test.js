/**
 * A notification click that wakes the background used the default action.
 *
 * MV3 stops an idle background after about 30 s, while the notification it
 * showed stays on screen for minutes. Clicking it then starts a new
 * background, and the click handler runs at once, before init has loaded
 * Premium: ProtonPremium.isPremium() is still false, so the settings read as
 * the free plan's and a Pro user's click action ("open inbox", "mark as
 * read", "archive", "nothing") became "open the message". The accounts were
 * not loaded either, so a Pro "mark as read" could not have found its
 * account anyway.
 *
 * The click now waits until background.js says Premium and the accounts are
 * loaded, at most READY_WAIT_MS, and nothing else waits on it.
 *
 * House style: notifier.js runs for real with its dependencies injected; the
 * settings are read through the real getSettings() and lib/pro-settings.js.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const ROOT = join(__dirname, '..');
const read = (rel) => readFileSync(join(ROOT, rel), 'utf-8');
const NOTIFIER = read('background/notifier.js');
const CONSTANTS = read('background/constants.js');
const BACKGROUND = read('background/background.js');
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

/**
 * A background that has just been woken by the click. `premium` is what
 * ProtonPremium.init() will find; until load() it reads false, as the real
 * module does before init. The accounts likewise.
 */
function wake({ premium = true, stored = { notificationClickAction: 'openInbox' }, ready = 'pending' } = {}) {
  const world = { loaded: false, opened: [], marked: [], archived: [], polls: 0 };
  const session = {
    protonNotifData: [['proton-conv-c1', { messageId: 'm1', accountId: 'acc1' }]],
  };
  let clickListener = null;
  const browser = {
    storage: {
      local: { get: async () => ({ settings: { ...stored } }) },
      session: {
        get: async (k) => ({ [k]: session[k] }),
        set: async (o) => { Object.assign(session, o); },
      },
    },
    notifications: {
      clear() {},
      create: async () => {},
      onClicked: { addListener: (fn) => { clickListener = fn; } },
    },
    tabs: { create: ({ url }) => { world.opened.push(url); } },
  };
  const ProtonPremium = { isPremium: () => world.loaded && premium };
  const ProtonAccounts = {
    getMailUrl: (conv) => 'https://mail.proton.me/u/0/inbox' + (conv ? '/' + conv : ''),
    getAccount: () => (world.loaded ? { id: 'acc1' } : null),
    getAccounts: () => (world.loaded ? [{ id: 'acc1' }] : []),
    // Mirrors accounts.js request(): no account loaded, no request.
    markAsRead: async (id, ids) => {
      if (!world.loaded) throw new Error('Account not found');
      world.marked.push({ id, ids });
    },
    archiveMessages: async (id, ids) => {
      if (!world.loaded) throw new Error('Account not found');
      world.archived.push({ id, ids });
    },
  };
  const getSettings = new Function('browser', 'ProtonProSettings', 'ProtonPremium',
    liftFn(CONSTANTS, 'getSettings') + '\nreturn getSettings;')(browser, ProtonProSettings, ProtonPremium);
  const warnings = [];
  const Notifier = new Function('browser', 'getSettings', 'ProtonDND', 'ProtonAccounts', 'ProtonPremium',
    'ProtonI18n', 'ProtonAudioBridge', 'ProtonPoller', 'console', NOTIFIER + '\nreturn ProtonNotifier;')(
    browser, getSettings, { isActive: () => false }, ProtonAccounts, ProtonPremium, { t: (k) => k },
    { playSound: async () => {} }, { poll: () => { world.polls++; } },
    { warn: (...a) => warnings.push(a.join(' ')), log() {}, error() {} });

  let markLoaded;
  const loaded = new Promise((r) => { markLoaded = r; });
  const load = () => { world.loaded = true; markLoaded(); };
  if (ready === 'done') load();
  if (ready === 'none') Notifier.init();
  else if (ready === 'failed') Notifier.init(() => Promise.reject(new Error('init failed')));
  else Notifier.init(() => loaded);
  return { world, load, warnings, click: (id = 'proton-conv-c1') => clickListener(id) };
}

afterEach(() => { vi.useRealTimers(); });

describe('a click that wakes the background, with Pro', () => {
  it('waits for Premium, then does what the user chose (the bug: "open the message")', async () => {
    const b = wake();
    const click = b.click();
    await flush();
    expect(b.world.opened).toEqual([]); // still waiting for init
    b.load();
    await click;
    expect(b.world.opened).toEqual(['https://mail.proton.me/u/0/inbox']);
  });

  it('mark as read: marks the message, once the accounts are there', async () => {
    const b = wake({ stored: { notificationClickAction: 'markRead' } });
    const click = b.click();
    await flush();
    b.load();
    await click;
    expect(b.world.marked).toEqual([{ id: 'acc1', ids: ['m1'] }]);
    expect(b.world.opened).toEqual([]);
    expect(b.warnings).toEqual([]);
  });

  it('archive and nothing too', async () => {
    const a = wake({ stored: { notificationClickAction: 'archive' } });
    const archive = a.click();
    a.load();
    await archive;
    expect(a.world.archived).toEqual([{ id: 'acc1', ids: ['m1'] }]);

    const n = wake({ stored: { notificationClickAction: 'none' } });
    const none = n.click();
    n.load();
    await none;
    expect(n.world.opened).toEqual([]);
  });
});

describe('the wait', () => {
  it('free plan: the default action, as before', async () => {
    const b = wake({ premium: false });
    const click = b.click();
    b.load();
    await click;
    expect(b.world.opened).toEqual(['https://mail.proton.me/u/0/inbox/c1']);
  });

  it('costs nothing in a background that is already running', async () => {
    vi.useFakeTimers();
    const b = wake({ ready: 'done' });
    await b.click();
    expect(b.world.opened).toEqual(['https://mail.proton.me/u/0/inbox']);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('never hangs on an init that does not finish: the click acts after 5 s', async () => {
    vi.useFakeTimers();
    const b = wake();
    const click = b.click();
    await vi.advanceTimersByTimeAsync(4900);
    expect(b.world.opened).toEqual([]);
    await vi.advanceTimersByTimeAsync(200);
    await click;
    // Premium is still unknown, so the free default: a tab opens all the same.
    expect(b.world.opened).toEqual(['https://mail.proton.me/u/0/inbox/c1']);
  });

  it('nor on one that failed: the click acts at once, and does not throw', async () => {
    vi.useFakeTimers();
    const b = wake({ ready: 'failed' });
    await b.click();
    expect(b.world.opened).toEqual(['https://mail.proton.me/u/0/inbox/c1']);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('without a hook (tests, other pages) a click acts at once', async () => {
    const b = wake({ ready: 'none', premium: false });
    await b.click();
    expect(b.world.opened).toEqual(['https://mail.proton.me/u/0/inbox/c1']);
  });
});

describe('background.js hands the click what it waits for', () => {
  const init = liftFn(BACKGROUND, '_initialize');

  it('before the first await, so the hook is there for the click that woke it', () => {
    expect(init.indexOf('ProtonNotifier.init(() => _loaded);')).toBeGreaterThan(-1);
    expect(init.indexOf('ProtonNotifier.init(() => _loaded);')).toBeLessThan(init.indexOf('await'));
  });

  it('ready once Premium and the accounts are loaded, before anything that waits on the network', () => {
    const at = (s) => {
      const i = init.indexOf(s);
      expect(i, s).toBeGreaterThan(-1);
      return i;
    };
    const ready = at('_markLoaded();');
    expect(at('await ProtonPremium.init();')).toBeLessThan(ready);
    expect(at('await ProtonAccounts.initFast();')).toBeLessThan(ready);
    // The /u/N/ slot map a click builds its link from (notification-click-account.test.js).
    expect(at('await ProtonAccounts.initUrlDetection();')).toBeLessThan(ready);
    expect(ready).toBeLessThan(at('browser.storage.sync.get('));
    expect(ready).toBeLessThan(at('await ProtonAccounts.initSlow();'));
    expect(ready).toBeLessThan(at('await ProtonPoller.initialLoad();'));
    // Once, on every path: it precedes the first branch.
    expect(init.match(/_markLoaded\(\)/g)).toHaveLength(1);
    expect(ready).toBeLessThan(at('if (!ProtonAccounts.hasAccounts())'));
  });

  it('and released by an init that fails before it, so no click waits out the bound', async () => {
    const ensureFor = (initialize) => {
      const out = { released: 0 };
      out.ensure = new Function('_initialize', '_markLoaded',
        'let _initPromise = null;\n' + liftFn(BACKGROUND, 'ensureInitialized') + '\nreturn ensureInitialized;')(
        initialize, () => { out.released++; });
      return out;
    };
    const failed = ensureFor(() => Promise.reject(new Error('storage unavailable')));
    await expect(failed.ensure()).rejects.toThrow('storage unavailable');
    await flush();
    expect(failed.released).toBe(1);
    // A good init marks it itself, at the point the click needs.
    const good = ensureFor(() => Promise.resolve());
    await good.ensure();
    await flush();
    expect(good.released).toBe(0);
  });
});
