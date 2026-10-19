/**
 * @vitest-environment jsdom
 *
 * "Messages per account" (5, 10, 15, 20) did not cap the list.
 *
 * getMessages asked mail/v4/messages for `Limit`, which Proton ignores:
 * measured, Limit 1, 2, 5 and 10 each returned all 6 unread messages. The
 * web client sizes its pages with Page and PageSize (and sends Limit equal
 * to PageSize). A single monitored folder (the usual Inbox) was also handed
 * back untrimmed, so nothing on our side capped it either.
 *
 * Once the cap holds, nothing may count unread mail by the list any more:
 * the badge, the popup's per-account counts and the optimistic updates after
 * an action all have to keep Proton's count of 30 when the list shows 5.
 *
 * House style: functions are lifted out of the real sources and run with
 * their dependencies injected; the poller runs whole.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const ROOT = join(__dirname, '..');
const read = (rel) => readFileSync(join(ROOT, rel), 'utf-8');
const ACCOUNTS = read('background/accounts.js');
const POLLER = read('background/poller.js');
const POPUP = read('popup/popup.js');
const ProtonMonitoredIds = new Function(read('lib/monitored-ids.js') + '; return ProtonMonitoredIds;')();
const ProtonTombstones = new Function(read('background/optimistic-tombstones.js') + '; return ProtonTombstones;')();

// Index just past a string literal or line comment starting at i.
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

function lift(src, name) {
  const m = new RegExp('(async )?function ' + name + '\\(').exec(src);
  if (!m) throw new Error('not found: ' + name);
  let depth = 0;
  for (let i = src.indexOf('{', src.indexOf(') {', m.index)); i < src.length; i++) {
    const next = skipLiteral(src, i);
    if (next !== i) { i = next - 1; continue; }
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) return src.slice(m.index, i + 1); }
  }
  throw new Error('unbalanced braces reading ' + name);
}

function sandbox(src, names, env) {
  const body = 'const { ' + Object.keys(env).join(', ') + ' } = __env;\n' +
    names.map((n) => lift(src, n)).join('\n\n') + '\nreturn { ' + names.join(', ') + ' };';
  return new Function('__env', body)(env);
}

const unread = (n, from = 0, extra = {}) => Array.from({ length: n }, (_, i) => ({
  ID: 'm' + (from + i), ConversationID: 'c' + (from + i), Unread: 1, Time: 1000 - from - i, LabelIDs: ['0'], ...extra,
}));

// =============================================================================
// 1. The request
// =============================================================================

describe('the list request', () => {
  function getMessages() {
    const sent = [];
    const api = sandbox(ACCOUNTS, ['getMessages'], {
      ProtonLabels: { INBOX: '0' },
      request: async (_id, method, path, opts) => { sent.push({ method, path, params: opts.params }); return { Messages: [] }; },
    });
    return { sent, getMessages: api.getMessages };
  }

  it('sizes the reply with Page and PageSize, as the web client does', async () => {
    const r = getMessages();
    await r.getMessages('acc1', '0', 5, { unreadOnly: true });
    expect(r.sent).toEqual([{
      method: 'GET', path: 'mail/v4/messages',
      params: { LabelID: '0', Page: '0', PageSize: '5', Limit: '5', Sort: 'Time', Desc: '1', Unread: '1' },
    }]);
  });

  it('the default is still 20, and only an unread-only list asks for Unread', async () => {
    const r = getMessages();
    await r.getMessages('acc1');
    expect(r.sent[0].params).toEqual({ LabelID: '0', Page: '0', PageSize: '20', Limit: '20', Sort: 'Time', Desc: '1' });
  });
});

describe('the monitored list holds the setting whatever comes back', () => {
  // Proton as measured: the size asked for is not the size returned.
  function monitored(ids, reply) {
    const asked = [];
    const api = sandbox(ACCOUNTS, ['getMonitoredMessages'], {
      getAccount: () => ({ id: 'acc1' }),
      _monitoredQueryIds: () => ids,
      _recordMonitorConfig: async () => {},
      _recordLeak: async () => {},
      _recordReadInUnread: async () => {},
      _pruneStaleMonitoredIds: async () => {},
      ProtonMonitoredIds,
      getMessages: async (_acc, id, limit) => { asked.push({ id, limit }); return reply(id); },
    });
    return { asked, get: (limit) => api.getMonitoredMessages('acc1', limit, { unreadOnly: true }) };
  }

  it('one folder: the newest `limit`, not the whole reply (the bug)', async () => {
    const m = monitored(['0'], () => unread(6));
    const msgs = await m.get(2);
    expect(msgs.map((x) => x.ID)).toEqual(['m0', 'm1']);
    expect(m.asked).toEqual([{ id: '0', limit: 2 }]);
  });

  it('several folders: merged newest first, then capped, as before', async () => {
    const m = monitored(['0', '10'], (id) => (id === '0' ? unread(3) : unread(3, 10, { LabelIDs: ['10'] })));
    const msgs = await m.get(4);
    expect(msgs.map((x) => x.ID)).toEqual(['m0', 'm1', 'm2', 'm10']);
  });
});

// =============================================================================
// 2. Counts come from Proton's counts, never from the list
// =============================================================================

describe('an action on a capped list keeps Proton\'s count', () => {
  const account = () => ({ unreadCount: 30, messages: unread(5) });

  it('mark read, archive, trash: one less, not the four left in the list', () => {
    const acc = account();
    ProtonTombstones.recordRemoval(acc, ['m0'], 1000);
    expect(acc.messages).toHaveLength(4);
    expect(acc.unreadCount).toBe(29);
  });

  it('a read message, or one the list does not hold, leaves the count alone', () => {
    const acc = account();
    acc.messages[1].Unread = 0;
    ProtonTombstones.recordRemoval(acc, ['m1', 'not-listed'], 1000);
    expect(acc.unreadCount).toBe(30);
  });

  it('snooze: the unread of the snoozed conversation', () => {
    const acc = account();
    acc.messages[1].ConversationID = 'c0';
    ProtonTombstones.recordSnooze(acc, ['c0'], 1000);
    expect(acc.messages.map((m) => m.ID)).toEqual(['m2', 'm3', 'm4']);
    expect(acc.unreadCount).toBe(28);
  });

  it('a poll inside the consistency window: the list is filtered, the fresh count kept', () => {
    const acc = account();
    ProtonTombstones.recordRemoval(acc, ['m0'], 1000);
    // The poll: Proton's count already knows, its list still lags.
    acc.unreadCount = 29;
    acc.messages = unread(5);
    ProtonTombstones.apply(acc, 2000);
    expect(acc.messages.map((m) => m.ID)).toEqual(['m1', 'm2', 'm3', 'm4']);
    expect(acc.unreadCount).toBe(29);
  });

  it('never below zero', () => {
    const acc = { unreadCount: 0, messages: unread(2) };
    ProtonTombstones.recordRemoval(acc, ['m0', 'm1'], 1000);
    expect(acc.unreadCount).toBe(0);
  });
});

/** The real poller over one account whose server holds `count` unread. */
function poller({ count = 30, maxEmails = 5, premium = true } = {}) {
  const server = { count, mail: unread(count), asked: [] };
  const acc = {
    id: 'acc1', email: 'user@example.com', folderMode: 'inbox', viewMode: 1,
    unreadCount: 0, messages: [], lastEventId: null, keysUnlocked: true, scopeGen: 0, countGen: 0,
  };
  const badge = [];
  const settings = { maxEmailsPerAccount: maxEmails, previewLines: 0 };
  const factory = new Function(
    'browser', 'ProtonAccounts', 'ProtonNotifier', 'ProtonBadge', 'ProtonDND', 'ProtonTombstones',
    'ProtonPremium', 'ProtonNotificationRules', 'ProtonDiag', 'ProtonLabels', 'getSettings', 'debugLog',
    POLLER + '\nreturn ProtonPoller;');
  const P = factory(
    {
      storage: { session: { get: async () => ({}), set: async () => {} } },
      alarms: { get: async () => undefined, create() {}, clear: async () => true },
      runtime: { sendMessage: () => Promise.resolve() },
    },
    {
      hasAccounts: () => true,
      getAccounts: () => [{ id: acc.id, email: acc.email, unreadCount: acc.unreadCount, authError: acc.authError }],
      getAccount: (id) => (id === acc.id ? acc : null),
      ensureKeysUnlocked: async () => true,
      effectiveViewMode: (a) => a.viewMode,
      getLatestEventId: async () => 'E1',
      getMonitoredUnreadCount: async () => server.count,
      // A server that honours the size asked for, as Page/PageSize do.
      getMonitoredMessages: async (_id, limit) => { server.asked.push(limit); return server.mail.slice(0, limit).map((m) => ({ ...m })); },
      saveSnapshot: async () => {},
      // The event poll: the counts only, no new mail.
      getMonitoredLabelIds: () => ['0'],
      getEvents: async () => ({ EventID: 'E2', MessageCounts: [{ LabelID: '0', Unread: server.count }], More: 0 }),
      noteAccountEvents: async () => false,
      checkMonitoredAgainstCounts: async () => {},
    },
    { seedNotifiedIds: async () => {}, notifyNewMessages: async () => {} },
    {
      setUnreadCount: (n) => badge.push(n), setDND() {}, setLoggedOut() {}, setError() {}, getState: () => ({}),
    },
    { isActive: () => false },
    ProtonTombstones,
    { isPremium: () => premium },
    { activeRules: () => [], needsBody: () => false },
    { record() {}, once: async () => true },
    { INBOX: '0', ALL_MAIL: '5' },
    async () => ({ ...settings }),
    () => {},
  );
  return { P, acc, server, badge, settings };
}

describe('the poller with a capped list', () => {
  it('loads the setting\'s worth of mail, and counts what Proton counts', async () => {
    const w = poller();
    await w.P.initialLoad();
    expect(w.server.asked).toEqual([5]);
    expect(w.acc.messages).toHaveLength(5);
    expect(w.badge.at(-1)).toBe(30);
    const state = w.P.getState();
    expect(state.unreadCount).toBe(30);
    expect(state.messages).toHaveLength(5);
    // What the popup adds to the 5 it lists, for its per-account counts.
    expect(state.accounts[0].unreadUnlisted).toBe(25);
  });

  it('after a mark-read the badge says 29, not 4', async () => {
    const w = poller();
    await w.P.initialLoad();
    ProtonTombstones.recordRemoval(w.acc, ['m0'], Date.now());
    w.P.refreshBadgeNow();
    expect(w.badge.at(-1)).toBe(29);
    expect(w.P.getState().accounts[0].unreadUnlisted).toBe(25);
  });

  it('the poll after a mark-read fills the list again, though the count it reads is unchanged', async () => {
    const w = poller();
    await w.P.initialLoad();
    // Marked read: Proton's count and list both know, ours dropped it.
    w.server.mail.shift();
    w.server.count = 29;
    ProtonTombstones.recordRemoval(w.acc, ['m0'], Date.now());
    expect(w.acc.messages).toHaveLength(4);
    await w.P.poll();
    // The event count (29) is what we already hold: only the short list
    // says to fetch it, and without that it stayed at 4 for good.
    expect(w.server.asked).toEqual([5, 5]);
    expect(w.acc.messages.map((m) => m.ID)).toEqual(['m1', 'm2', 'm3', 'm4', 'm5']);
    expect(w.badge.at(-1)).toBe(29);
  });

  it('and once more after a list that still held it: filtered short, fetched again', async () => {
    const w = poller();
    await w.P.initialLoad();
    // Proton's count already knows, its list lags (the consistency window).
    w.server.count = 29;
    ProtonTombstones.recordRemoval(w.acc, ['m0'], Date.now());
    await w.P.poll();
    expect(w.acc.messages).toHaveLength(4);
    // Caught up by the next poll: a full list again.
    w.server.mail.shift();
    await w.P.poll();
    expect(w.server.asked).toEqual([5, 5, 5]);
    expect(w.acc.messages.map((m) => m.ID)).toEqual(['m1', 'm2', 'm3', 'm4', 'm5']);
    // Nothing short any more: the next poll with nothing new fetches nothing.
    await w.P.poll();
    expect(w.server.asked).toEqual([5, 5, 5]);
  });

  it('everything listed: nothing beyond it', async () => {
    const w = poller({ count: 3 });
    await w.P.initialLoad();
    expect(w.P.getState().accounts[0].unreadUnlisted).toBe(0);
  });

  it('a changed setting is fetched at its new size, the count unchanged', async () => {
    const w = poller();
    await w.P.initialLoad();
    expect(w.acc.listLimit).toBe(5);
    w.settings.maxEmailsPerAccount = 10;
    await w.P.initialLoad();
    expect(w.server.asked).toEqual([5, 10]);
    expect(w.acc.listLimit).toBe(10);
    const state = w.P.getState();
    expect(state.messages).toHaveLength(10);
    expect(state.unreadCount).toBe(30);
    expect(state.accounts[0].unreadUnlisted).toBe(20);
  });

  it('every place that fetches the list asks for the setting, the announce for 5', () => {
    const calls = [...POLLER.matchAll(/getMonitoredMessages\(([^)]*)\)/g)].map((m) => m[1].split(',')[1].trim());
    expect(calls.sort()).toEqual(['5', 'maxEmails', 'maxEmails', 'maxEmails']);
  });
});

// =============================================================================
// 3. The popup's per-account counts
// =============================================================================

describe('the popup counts per account what the badge counts', () => {
  function statusBar(state, premium = true) {
    document.body.innerHTML = '<div id="pills"></div><span id="checked"></span><ul id="list"></ul>';
    const env = {
      document,
      accountPillsEl: document.getElementById('pills'),
      lastCheckedEl: document.getElementById('checked'),
      messageList: document.getElementById('list'),
      _accountSections: [],
      ProtonI18n: { t: (k) => k },
      _luminance: () => 0.2,
      isPremium: () => premium,
      formatRelativeTime: () => '',
      _syncCollapseAllBtn: () => {},
    };
    sandbox(POPUP, ['_getAccountInitials', 'updateStatusBar'], env).updateStatusBar(state);
    return [...env.accountPillsEl.querySelectorAll('.account-pill')].map((p) => ({
      title: p.title,
      badge: (p.querySelector('.account-pill-badge') || {}).textContent || null,
      locked: p.classList.contains('account-locked'),
    }));
  }
  const listed = (n, accountId) => unread(n).map((m) => ({ ...m, _accountId: accountId }));

  it('the 5 listed plus the 25 beyond the list', () => {
    const pills = statusBar({
      isLoggedIn: true,
      accounts: [{ id: 'a1', email: 'one@example.com', unreadUnlisted: 25 }],
      messages: listed(5, 'a1'),
    });
    expect(pills).toEqual([{ title: 'one@example.com (30)', badge: '30', locked: false }]);
  });

  it('and one less at once when a listed message is marked read in the popup', () => {
    const msgs = listed(5, 'a1');
    msgs[0].Unread = 0; // _applyOptimisticUpdate, before the background answers
    const pills = statusBar({ isLoggedIn: true, accounts: [{ id: 'a1', email: 'one@example.com', unreadUnlisted: 25 }], messages: msgs });
    expect(pills[0].badge).toBe('29');
  });

  it('an older background without the field: the listed unread, as before', () => {
    const pills = statusBar({ isLoggedIn: true, accounts: [{ id: 'a1', email: 'one@example.com' }], messages: listed(2, 'a1') });
    expect(pills[0].badge).toBe('2');
  });

  it('the account section header adds the same', () => {
    const fn = lift(POPUP, 'renderMessages');
    expect(fn).toMatch(/const unread = msgs\.filter\(m => m\.Unread === 1\)\.length \+ \(\(accInfo && accInfo\.unreadUnlisted\) \|\| 0\);/);
  });
});
