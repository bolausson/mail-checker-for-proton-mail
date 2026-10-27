/**
 * Poller and notifier guarantees around message bodies, previews and the
 * session snapshot, run against the real background/poller.js and
 * background/notifier.js.
 *
 * 1. A BODY RULE IN A WORKER THAT JUST WOKE. The options page's Test button
 *    and a settings change both reach _ensureBodies in a worker whose keys
 *    are typically still unlocking. Judged on keysUnlocked without waiting
 *    for that unlock, every body rule matches nothing: the Test button
 *    reports no hits and the badge keeps counting mail the rule excludes.
 *    An unlock that fails still fetches nothing, or the blank bodies that
 *    locked keys decrypt to stay cached until the worker goes.
 * 2. A FAILED POLL STILL SAVES ITS SNAPSHOT. A cycle that ends in an error can
 *    already have moved the event cursor and announced mail. Without the
 *    snapshot the next wake restores the old cursor and reads those events
 *    again.
 * 3. NO BODY FETCH FOR A NOTIFICATION THAT CANNOT APPEAR. The notification
 *    preview bypasses the previewLines gate, but under Do Not Disturb or with
 *    notifications switched off nothing shows it, and each arrival would still
 *    cost a message GET plus an OpenPGP decrypt.
 * 4. THE SNIPPET CACHE. The full load a woken account without a cursor gets
 *    replaces the restored messages just as a poll does, so it seeds the
 *    cache from them first. A fetch that FAILED is neither cached nor seeded
 *    back from the '' it leaves on the message, or one transient blip blanks
 *    that preview for the whole browser run. And at its bound, re-caching a
 *    snippet the cache already holds must not throw another one away.
 * 5. THE NOTIFICATION BODY. The snippet is trimmed before it becomes the
 *    second line, so whitespace never turns into a blank or padded line.
 *
 * Same harness shape as tests/poll-backoff-and-snippets.test.js: the world
 * (storage.session, the alarms, the saved snapshot) outlives a worker, module
 * state does not. The quiet-mail rules are the real lib/notification-rules.js.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const ROOT = join(__dirname, '..');
const POLLER_SRC = readFileSync(join(ROOT, 'background', 'poller.js'), 'utf-8');
const NOTIFIER_SRC = readFileSync(join(ROOT, 'background', 'notifier.js'), 'utf-8');
const ProtonNotificationRules = new Function(
  readFileSync(join(ROOT, 'lib', 'notification-rules.js'), 'utf-8') + '\nreturn ProtonNotificationRules;')();

const clone = v => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));

/** Pull one function's source out of a module IIFE, by brace matching. */
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

/** Storage, alarms and the session snapshot: what outlives a worker. */
function makeWorld(settings) {
  return {
    session: {},
    alarms: new Map(),
    snapshot: null,
    settings: { maxEmailsPerAccount: 20, pollIntervalMinutes: 1, ...settings },
  };
}

function makeBrowser(world) {
  return {
    storage: {
      session: {
        get: async (key) => ({ [key]: clone(world.session[key]) }),
        set: async (obj) => { for (const [k, v] of Object.entries(obj)) world.session[k] = clone(v); },
        remove: async (key) => { delete world.session[key]; },
      },
    },
    alarms: {
      get: async (name) => clone(world.alarms.get(name)),
      create: (name, opts) => { world.alarms.set(name, { name, ...opts }); },
      clear: async (name) => world.alarms.delete(name),
    },
    runtime: { sendMessage: () => Promise.resolve() },
  };
}

/**
 * A fake Proton backend. `events` is append-only and a cursor is the index of
 * the next unread event, the way Proton's opaque IDs behave. `bodies` holds
 * the decrypted HTML of a message; anything else reads "Hello from <id>".
 */
function makeProton() {
  return {
    events: [],
    list: [],
    count: 0,
    calls: [],
    pageSize: 50,
    bodies: {},
    cursor() { return 'E' + this.events.length; },
    push(ev) { this.events.push(ev); },
  };
}

/** The part of accounts.js's storage.session snapshot these tests read back. */
function snapshotOf(state) {
  return clone(state.accounts.map(a => ({
    id: a.id, messages: a.messages, unreadCount: a.unreadCount,
    lastEventId: a.lastEventId, lastCheckTime: a.lastCheckTime,
  })));
}

/** A worker restart: accounts.js restores the accounts from the snapshot. */
function wake(world, state) {
  const saved = new Map(world.snapshot.map(s => [s.id, s]));
  state.accounts = state.accounts.map(a => ({ ...a, ...clone(saved.get(a.id)) }));
}

/**
 * One worker's view of ProtonAccounts.
 *
 * state.down names the requests that fail the way they do when the network
 * drops mid-cycle; state.bodyFails names the messages whose body GET fails.
 * The unlock resolves on a later tick and only then flips keysUnlocked, so a
 * caller that reads the flag before awaiting the unlock still sees false. And
 * like accounts.js, decryptBody refuses while the keys are locked, so a body
 * fetched without the unlock reads as nothing.
 */
function makeAccounts(state, proton, world) {
  const find = id => state.accounts.find(a => a.id === id) || null;
  const call = (op, id, extra) => {
    proton.calls.push({ op, id, ...extra });
    if (state.down.has(op)) throw new Error('NetworkError: connection refused');
  };
  return {
    hasAccounts: () => state.accounts.length > 0,
    getAccounts: () => state.accounts.map(a => ({
      id: a.id, email: a.email, unreadCount: a.unreadCount, authError: a.authError, lastCheckTime: a.lastCheckTime,
    })),
    getAccount: find,
    ensureKeysUnlocked: async (id) => {
      const a = find(id);
      if (!a) return false;
      if (a.keysUnlocked) return true;
      if (!a.keyPassword) return false;
      proton.calls.push({ op: 'unlock', id });
      await Promise.resolve();
      if (state.unlockFails) return false;
      a.keysUnlocked = true;
      return true;
    },
    snapshotSource: () => 'session',
    effectiveViewMode: a => a.viewMode,
    getMonitoredLabelIds: () => ['0'],
    checkMonitoredAgainstCounts: async () => {},
    noteAccountEvents: async () => false,
    saveSnapshot: async () => { world.snapshot = snapshotOf(state); },
    getLatestEventId: async (id) => { call('latest', id); return proton.cursor(); },
    getMonitoredUnreadCount: async (id) => { call('count', id); return proton.count; },
    getMonitoredMessages: async (id, limit) => {
      call('list', id, { limit });
      return clone(proton.list).slice(0, limit);
    },
    getMessage: async (id, msgId) => {
      call('getMessage', id, { msgId });
      if (state.bodyFails.has(msgId)) throw new Error('NetworkError: connection reset');
      return { ID: msgId, Body: 'ENC:' + msgId };
    },
    decryptBody: async (id, body) => {
      const msgId = String(body).replace('ENC:', '');
      proton.calls.push({ op: 'decrypt', id, msgId });
      const a = find(id);
      if (!a || !a.keysUnlocked) throw new Error('Keys not unlocked');
      return proton.bodies[msgId] || '<p>Hello from ' + msgId + '</p>';
    },
    getEvents: async (id, cursor) => {
      call('events', id, { cursor });
      const from = Number(String(cursor).slice(1));
      const page = proton.events.slice(from, from + proton.pageSize);
      const next = from + page.length;
      const reply = { EventID: 'E' + next, More: next < proton.events.length ? 1 : 0, Messages: [] };
      for (const ev of page) {
        if (ev.Messages) reply.Messages.push(...ev.Messages);
        for (const k of ['ConversationCounts', 'MessageCounts', 'Refresh']) {
          if (ev[k] !== undefined) reply[k] = ev[k];
        }
      }
      return reply;
    },
  };
}

/** Start a worker: fresh module state over the shared world. */
function startWorker(world, state, proton) {
  const notifier = {
    notifyNewMessages: async (msgs) => {
      // The snippet AS NOTIFIED: that is what the notification body reads.
      for (const m of msgs) state.notified.push({ ID: m.ID, snippet: m._snippet });
    },
    seedNotifiedIds: async () => {},
  };
  const factory = new Function(
    'browser', 'ProtonAccounts', 'ProtonNotifier', 'ProtonBadge', 'ProtonDND', 'ProtonTombstones',
    'ProtonPremium', 'ProtonNotificationRules', 'ProtonDiag', 'ProtonLabels', 'getSettings', 'debugLog',
    POLLER_SRC + '\nreturn ProtonPoller;');
  return factory(
    makeBrowser(world), makeAccounts(state, proton, world), notifier,
    {
      setLoggedOut() {}, getState: () => ({}),
      setError(text) { state.badgeError = text; },
      setDND(n) { state.badge = n; },
      setUnreadCount(n) { state.badge = n; },
    },
    { isActive: () => !!state.dnd },
    { apply() {} },
    { isPremium: () => true },
    ProtonNotificationRules,
    { record() {}, once: async () => true },
    { INBOX: '0', ALL_MAIL: '5' },
    async () => world.settings,
    () => {},
  );
}

function newState(accounts) {
  return {
    accounts, notified: [], badge: null, badgeError: null, dnd: false,
    down: new Set(), bodyFails: new Set(), unlockFails: false,
  };
}

function account(extra) {
  return {
    id: 'acc1', email: 'user@example.com', viewMode: 0,
    unreadCount: 0, messages: [], lastEventId: 'E0', lastCheckTime: Date.now(), listLimit: 20,
    scopeGen: 0, countGen: 0, keysUnlocked: true,
    ...extra,
  };
}

const create = (id, extra) => ({ Action: 1, Message: { ID: id, Unread: 1, LabelIDs: ['0', '5'], ...extra } });

const bodyFetches = (proton, msgId, from = 0) => proton.calls
  .slice(from)
  .filter(c => c.op === 'getMessage' && (msgId === undefined || c.msgId === msgId)).length;

const snippets = state => Object.fromEntries(state.accounts[0].messages.map(m => [m.ID, m._snippet]));

describe('a body rule in a worker whose keys are still unlocking', () => {
  let proton, state;
  beforeEach(() => {
    proton = makeProton();
    proton.bodies = {
      m1: '<p>Your invoice for October is attached.</p>',
      m2: '<p>Lunch on Friday?</p>',
    };
    state = newState([account({
      keysUnlocked: false, keyPassword: 'kp', unreadCount: 2,
      messages: [
        { ID: 'm1', Unread: 1, Time: 2, Subject: 'October', Sender: { Address: 'billing@example.com' } },
        { ID: 'm2', Unread: 1, Time: 1, Subject: 'Friday', Sender: { Address: 'friend@example.net' } },
      ],
    })]);
  });

  it('waits for the unlock, so the Test button finds the mail the rule catches', async () => {
    const result = await startWorker(makeWorld(), state, proton)
      .testQuietRule({ body: 'invoice', silenceNotification: true });

    expect(result.total).toBe(2);
    expect(result.count).toBe(1);
    expect(result.matched.map(m => m.subject)).toEqual(['October']);
    const ops = proton.calls.map(c => c.op);
    expect(ops).toContain('unlock');
    expect(ops.indexOf('unlock')).toBeLessThan(ops.indexOf('getMessage'));
  });

  it('waits for the unlock, so a rule saved right after a wake takes its mail off the badge', async () => {
    const world = makeWorld({
      notificationRules: [{ id: 'r1', body: 'invoice', excludeFromCount: true }],
    });
    await startWorker(world, state, proton).reapplyQuietRules();

    expect(state.badge).toBe(1);
    expect(state.accounts[0].messages.find(m => m.ID === 'm1')._notifRule).toMatchObject({ exclude: true });
  });

  it('fetches nothing when the unlock fails, so the body is still read once it succeeds', async () => {
    // A body fetched with the keys locked cannot be decrypted, and the blank
    // it leaves is cached for the life of the worker.
    const worker = startWorker(makeWorld(), state, proton);
    const rule = { body: 'invoice', silenceNotification: true };

    state.unlockFails = true;
    expect((await worker.testQuietRule(rule)).count).toBe(0);
    expect(bodyFetches(proton)).toBe(0);

    state.unlockFails = false;
    expect((await worker.testQuietRule(rule)).count).toBe(1);
  });
});

describe('a poll that fails after it moved the event cursor', () => {
  it('still saves the snapshot, so the next wake does not read the same events again', async () => {
    const world = makeWorld();
    const proton = makeProton();
    proton.pageSize = 1; // one event per page
    const state = newState([account()]);
    world.snapshot = snapshotOf(state); // what the last good poll left behind

    // The first page announces n1 and moves the cursor past it, the second
    // asks for a full refresh, and the network drops before that refresh
    // gets its count.
    proton.push({ Messages: [create('n1')], ConversationCounts: [{ LabelID: '0', Unread: 1 }] });
    proton.push({ Refresh: 1 });
    state.down.add('count');

    await startWorker(world, state, proton).poll();

    expect(state.badgeError).not.toBeNull(); // the poll as a whole failed
    expect(state.notified.map(n => n.ID)).toEqual(['n1']);
    expect(world.snapshot[0].lastEventId).toBeNull();

    // The worker is torn down; the next one restores the snapshot, and the
    // network is back.
    wake(world, state);
    state.down.clear();
    const mark = proton.calls.length;
    await startWorker(world, state, proton).poll();

    const reread = proton.calls.slice(mark).filter(c => c.op === 'events' && c.cursor === 'E0');
    expect(reread).toEqual([]);
  });
});

describe('the notification preview for a notification that cannot appear', () => {
  // previewLines 0, the default: only the notification preview could ask for
  // a body here.
  let proton, state;
  beforeEach(() => {
    proton = makeProton();
    state = newState([account()]);
    proton.push({ Messages: [create('n1')], ConversationCounts: [{ LabelID: '0', Unread: 1 }] });
    proton.list = [{ ID: 'n1', Unread: 1, Time: 5 }];
    proton.count = 1;
  });

  it('is fetched when the notification will show', async () => {
    // The baseline the two below differ from.
    await startWorker(makeWorld({ previewLines: 0 }), state, proton).poll();

    expect(state.notified).toEqual([{ ID: 'n1', snippet: 'Hello from n1' }]);
    expect(bodyFetches(proton)).toBe(1);
  });

  it('is not fetched under Do Not Disturb', async () => {
    state.dnd = true;
    await startWorker(makeWorld({ previewLines: 0 }), state, proton).poll();

    // The arrival still reaches the notifier, which records it as seen; only
    // the body nobody would read is left alone.
    expect(state.notified).toEqual([{ ID: 'n1', snippet: undefined }]);
    expect(bodyFetches(proton)).toBe(0);
  });

  it('is not fetched when notifications are switched off', async () => {
    await startWorker(makeWorld({ previewLines: 0, notificationsEnabled: false }), state, proton).poll();

    expect(state.notified).toEqual([{ ID: 'n1', snippet: undefined }]);
    expect(bodyFetches(proton)).toBe(0);
  });
});

describe('the snippet cache', () => {
  let world, proton;
  beforeEach(() => {
    world = makeWorld({ previewLines: 3 });
    proton = makeProton();
  });

  it('is seeded by the full load a woken account without a cursor gets', async () => {
    // resume() sends an account without a cursor through the initial load,
    // whose list replaces the very objects that carry the restored snippets.
    const held = [
      { ID: 'm1', Unread: 1, Time: 4, _snippet: 'Hello from m1' },
      { ID: 'm2', Unread: 1, Time: 3, _snippet: 'Hello from m2' },
      { ID: 'm3', Unread: 1, Time: 2, _snippet: 'Hello from m3' },
    ];
    const state = newState([account({ lastEventId: null, unreadCount: 3, messages: held })]);
    proton.list = [{ ID: 'n1', Unread: 1, Time: 5 }, ...held.map(({ _snippet, ...m }) => m)];
    proton.count = 4;

    await startWorker(world, state, proton).resume();

    expect(proton.calls.some(c => c.op === 'list')).toBe(true); // the full load ran
    expect(bodyFetches(proton)).toBe(1);
    expect(bodyFetches(proton, 'n1')).toBe(1);
    expect(snippets(state)).toEqual({
      n1: 'Hello from n1', m1: 'Hello from m1', m2: 'Hello from m2', m3: 'Hello from m3',
    });
  });

  it('tries a failed snippet again on the next poll instead of keeping it blank', async () => {
    const state = newState([account({
      unreadCount: 1, messages: [{ ID: 'm1', Unread: 1, Time: 3, _snippet: 'Hello from m1' }],
    })]);
    const worker = startWorker(world, state, proton);

    // n1 arrives while its body GET fails for the whole poll.
    state.bodyFails.add('n1');
    proton.push({ Messages: [create('n1')], ConversationCounts: [{ LabelID: '0', Unread: 2 }] });
    proton.list = [{ ID: 'n1', Unread: 1, Time: 4 }, { ID: 'm1', Unread: 1, Time: 3 }];
    proton.count = 2;
    await worker.poll();
    expect(snippets(state).n1).toBe('');

    // The blip is over. The next arrival refreshes the list.
    state.bodyFails.clear();
    const mark = proton.calls.length;
    proton.push({ Messages: [create('n2')], ConversationCounts: [{ LabelID: '0', Unread: 3 }] });
    proton.list = [{ ID: 'n2', Unread: 1, Time: 5 }, ...proton.list];
    proton.count = 3;
    await worker.poll();

    expect(bodyFetches(proton, 'n1', mark)).toBe(1);
    expect(snippets(state)).toEqual({ n2: 'Hello from n2', n1: 'Hello from n1', m1: 'Hello from m1' });
  });

  it('is not seeded with the blank a failed fetch left in the restored snapshot', async () => {
    // n1's fetch failed in an earlier worker, which saved '' for it. A fresh
    // worker seeds its cache from the snapshot.
    const held = [
      { ID: 'n1', Unread: 1, Time: 4, _snippet: '' },
      { ID: 'm1', Unread: 1, Time: 3, _snippet: 'Hello from m1' },
    ];
    const state = newState([account({ unreadCount: 2, messages: held })]);
    proton.push({ Messages: [create('n2')], ConversationCounts: [{ LabelID: '0', Unread: 3 }] });
    proton.list = [{ ID: 'n2', Unread: 1, Time: 5 }, ...held.map(({ _snippet, ...m }) => m)];
    proton.count = 3;

    await startWorker(world, state, proton).poll();

    expect(bodyFetches(proton, 'n1')).toBe(1);
    expect(bodyFetches(proton, 'm1')).toBe(0);
    expect(snippets(state)).toEqual({ n2: 'Hello from n2', n1: 'Hello from n1', m1: 'Hello from m1' });
  });
});

describe('the snippet cache at its bound', () => {
  // The real _cacheSnippet over its own map. Every poll re-caches the
  // snippets of the messages it holds, so at the bound an update of an id
  // already cached is the common case. Run on its own rather than through
  // poll() for the same reason: the seeding puts any held message's snippet
  // straight back, so a poll shows no extra fetch for what an eviction on
  // update loses, and the loss only shows in what the cache still holds.
  function makeCache() {
    const max = Number(POLLER_SRC.match(/const SNIPPET_CACHE_MAX = (\d+)/)[1]);
    const api = new Function('SNIPPET_CACHE_MAX',
      'const _snippetCache = new Map();\n' + lift(POLLER_SRC, '_cacheSnippet') +
      '\nreturn { cache: _snippetCache, put: _cacheSnippet };')(max);
    for (let i = 0; i < max; i++) api.put('m' + i, 'snippet ' + i);
    return { ...api, max };
  }

  it('keeps every other snippet when one it already holds is cached again', () => {
    const { cache, put, max } = makeCache();
    put('m7', 'snippet 7');

    expect(cache.size).toBe(max);
    expect(cache.get('m0')).toBe('snippet 0');
    expect(cache.get('m7')).toBe('snippet 7');
  });

  it('still makes room for a new snippet by dropping the oldest', () => {
    const { cache, put, max } = makeCache();
    put('n1', 'snippet n1');

    expect(cache.size).toBe(max);
    expect(cache.has('m0')).toBe(false);
    expect(cache.get('n1')).toBe('snippet n1');
  });
});

describe('the notification body', () => {
  function startNotifier(world) {
    const browser = {
      storage: {
        session: {
          get: async (key) => ({ [key]: clone(world.session[key]) }),
          set: async (obj) => { for (const [k, v] of Object.entries(obj)) world.session[k] = clone(v); },
        },
      },
      notifications: {
        create: async (id, opt) => { world.notifications.set(id, opt); return id; },
        clear: (id) => world.notifications.delete(id),
        onClicked: { addListener() {} },
      },
    };
    return new Function('browser', 'getSettings', 'ProtonDND', 'ProtonAccounts',
      'ProtonPremium', 'ProtonI18n', 'ProtonAudioBridge', 'ProtonPoller',
      NOTIFIER_SRC + '\nreturn ProtonNotifier;')(
      browser,
      async () => ({ notificationsEnabled: true }),
      { isActive: () => false },
      { getAccount: () => ({ id: 'acc1', email: 'user@example.com' }), getAccounts: () => [{ id: 'acc1' }] },
      { isPremium: () => true },
      { t: (k) => k },
      { playSound: async () => {} },
      { poll() {} });
  }

  const message = snippet => ({
    ID: 'msg-1', ConversationID: 'conv-1', Subject: 'Invoice',
    Sender: { Name: 'Billing', Address: 'billing@example.com' }, _snippet: snippet,
  });

  async function shown(snippet) {
    const world = { session: {}, notifications: new Map() };
    await startNotifier(world).notifyNewMessages([message(snippet)], 'user@example.com', 'acc1');
    return world.notifications.get('proton-conv-conv-1').message;
  }

  it('drops the whitespace a preview cut at a line break ends with', async () => {
    // The poller cuts a preview at 500 characters, which can end it on a line
    // break or a space.
    expect(await shown('Your invoice for October is attached.\n')).toBe(
      'Invoice\nYour invoice for October is attached.');
  });

  it('shows the subject alone when the snippet is only whitespace', async () => {
    expect(await shown(' \n\t ')).toBe('Invoice');
  });
});
