/**
 * Three poller defects that a real offline run exposed, reproduced against the
 * real background/poller.js.
 *
 * 1. THE BACKOFF WAS UNREACHABLE. _pollAccount caught every API error and
 *    returned, so poll() always completed successfully. Its catch block is the
 *    only caller of ProtonBadge.setError and the only place the Fibonacci
 *    backoff escalates, so with the API blocked the extension kept firing a
 *    doomed request every minute, with a clean badge and an error count stuck
 *    at 0. The older backoff tests hide this: they make the BADGE throw, which
 *    reaches the same catch block by a path no outage ever takes. Everything
 *    below fails the API itself, the way a network outage does.
 * 2. SNIPPETS WERE REFETCHED. _snippet is cached on the message object, but
 *    every list refresh replaces account.messages with fresh objects from
 *    getMonitoredMessages, so each refresh paid for a message GET plus an
 *    OpenPGP decrypt per message, and a newly arrived message was fetched
 *    twice in one poll (once to notify, once after the list refetch).
 * 3. THE NOTIFICATION PREVIEW NEVER APPEARED. The snippet fetch was gated on
 *    previewLines (the popup's list setting, default 0) while the notification
 *    body has its own setting (notificationPreviewText, default on), so the
 *    checkbox did nothing out of the box.
 * 4. THE KEYS PATH BYPASSED THE BACKOFF. A failed unlock is an API round trip
 *    that failed, but _pollAccount called it 'skipped', which left the backoff
 *    dead on the one offline path every post-wake poll takes.
 * 5. THE SNIPPET CACHE WAS EMPTY IN A NEW WORKER. The restored snapshot holds
 *    the snippets and the first list refetch threw them away, so one arriving
 *    message still cost four body fetches.
 *
 * The world is shared across "workers" the way the browser shares it:
 * storage.session and the alarms survive a worker restart, module state does
 * not. Same shape as tests/wake-resume.test.js, plus message bodies and a
 * failing API.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const ROOT = join(__dirname, '..');
const POLLER_SRC = readFileSync(join(ROOT, 'background', 'poller.js'), 'utf-8');

const clone = v => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));

/** Storage and alarms: the part of the browser that outlives a worker. */
function makeWorld(settings) {
  return {
    session: {},
    alarms: new Map(),
    alarmLog: [],
    settings: { maxEmailsPerAccount: 20, pollIntervalMinutes: 1, ...settings },
  };
}

function makeBrowser(world) {
  const session = {
    get: async (key) => ({ [key]: clone(world.session[key]) }),
    set: async (obj) => { for (const [k, v] of Object.entries(obj)) world.session[k] = clone(v); },
    remove: async (key) => { delete world.session[key]; },
  };
  return {
    storage: { session },
    alarms: {
      get: async (name) => clone(world.alarms.get(name)),
      create: (name, opts) => {
        world.alarmLog.push({ op: 'create', name, ...opts });
        world.alarms.set(name, { name, ...opts });
      },
      clear: async (name) => { world.alarmLog.push({ op: 'clear', name }); return world.alarms.delete(name); },
    },
    runtime: { sendMessage: () => Promise.resolve() },
  };
}

/**
 * A fake Proton backend. `events` is append-only and a cursor is the index of
 * the next unread event, the way Proton's opaque IDs behave.
 */
function makeProton() {
  return {
    events: [],
    list: [],
    count: 0,
    calls: [],
    pageSize: 50,
    cursor() { return 'E' + this.events.length; },
    push(ev) { this.events.push(ev); },
  };
}

/**
 * One worker's view of ProtonAccounts.
 *
 * state.apiFails maps an account id to how ITS requests fail:
 *   {}                      a plain network/5xx error
 *   { retryAfterSec: 30 }   the server asking us to wait (429/503)
 *   { permanentAuth: true } a dead session
 * That is the whole point of this file: the failure comes from the API, not
 * from the badge.
 */
function makeAccounts(state, proton) {
  const find = id => state.accounts.find(a => a.id === id) || null;
  const fail = (id) => {
    const spec = state.apiFails && state.apiFails[id];
    if (!spec) return;
    const err = new Error(spec.message || 'NetworkError: connection refused');
    if (spec.retryAfterSec) err.retryAfterSec = spec.retryAfterSec;
    if (spec.permanentAuth) err.permanentAuth = true;
    throw err;
  };
  return {
    hasAccounts: () => state.accounts.length > 0,
    getAccounts: () => state.accounts.map(a => ({
      id: a.id, email: a.email, unreadCount: a.unreadCount, authError: a.authError, lastCheckTime: a.lastCheckTime,
    })),
    getAccount: find,
    // Mirrors accounts.js ensureKeysUnlocked, including the part that decides
    // whether a request is sent at all: with no key password it returns false
    // having asked the server nothing (two-password mode before the user has
    // typed it), and with one it is an API round trip (core/v4/users plus
    // addresses) whose failure it SWALLOWS and reports as a plain false.
    // state.unlockFails is that round trip failing, the way it does offline.
    ensureKeysUnlocked: async (id) => {
      const a = find(id);
      if (!a) return false;
      if (a.keysUnlocked) return true;
      if (!a.keyPassword) return false;
      proton.calls.push({ op: 'unlock', id });
      return !state.unlockFails;
    },
    snapshotSource: () => 'session',
    effectiveViewMode: a => (typeof a.webViewMode === 'number' ? a.webViewMode : a.viewMode),
    getMonitoredLabelIds: () => ['0'],
    checkMonitoredAgainstCounts: async () => {},
    noteAccountEvents: async () => false,
    saveSnapshot: async () => { proton.calls.push({ op: 'snapshot' }); },
    getLatestEventId: async (id) => { proton.calls.push({ op: 'latest', id }); fail(id); return proton.cursor(); },
    getMonitoredUnreadCount: async (id) => {
      proton.calls.push({ op: 'count', id });
      fail(id);
      return proton.count;
    },
    getMonitoredMessages: async (id, limit) => {
      proton.calls.push({ op: 'list', id, limit });
      fail(id);
      return clone(proton.list).slice(0, limit);
    },
    // One message GET plus one decrypt: the pair this file counts.
    getMessage: async (id, msgId) => {
      proton.calls.push({ op: 'getMessage', id, msgId });
      fail(id);
      return { ID: msgId, Body: 'ENC:' + msgId };
    },
    decryptBody: async (id, body) => {
      proton.calls.push({ op: 'decrypt', id, body });
      return '<p>Hello from ' + String(body).replace('ENC:', '') + '</p>';
    },
    getEvents: async (id, cursor) => {
      proton.calls.push({ op: 'events', id, cursor });
      fail(id);
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
  const browser = makeBrowser(world);
  const accounts = makeAccounts(state, proton);
  const notifier = {
    notifyNewMessages: async (msgs) => {
      // Snapshot the snippet AS NOTIFIED: that is what the OS notification
      // body reads, and reading it later would see the list pass's objects.
      for (const m of msgs) state.notified.push({ ID: m.ID, snippet: m._snippet });
    },
    seedNotifiedIds: async () => {},
  };
  const factory = new Function(
    'browser', 'ProtonAccounts', 'ProtonNotifier', 'ProtonBadge', 'ProtonDND', 'ProtonTombstones',
    'ProtonPremium', 'ProtonNotificationRules', 'ProtonDiag', 'ProtonLabels', 'getSettings', 'debugLog',
    POLLER_SRC + '\nreturn ProtonPoller;');
  return factory(
    browser, accounts, notifier,
    {
      setLoggedOut() {}, setDND() {}, getState: () => ({}),
      setError(text) { state.badgeError = text; },
      setUnreadCount(n) { state.badge = n; },
    },
    { isActive: () => false },
    { apply() {} },
    { isPremium: () => true },
    { activeRules: () => [], needsBody: () => false, normalize: r => r },
    { record() {}, once: async () => true },
    { INBOX: '0', ALL_MAIL: '5' },
    async () => world.settings,
    () => {},
  );
}

function newState(accounts) {
  return { accounts, notified: [], badge: null, badgeError: null, apiFails: null, unlockFails: false };
}

function account(extra) {
  return {
    id: 'acc1', email: 'user@example.com', folderMode: 'inbox', viewMode: 0,
    unreadCount: 0, messages: [], lastEventId: 'E0', lastCheckTime: Date.now(), listLimit: 20,
    scopeGen: 0, countGen: 0, keysUnlocked: true,
    ...extra,
  };
}

const create = (id, extra) => ({ Action: 1, Message: { ID: id, Unread: 1, LabelIDs: ['0', '5'], ...extra } });

const ALARM = 'proton-mail-check';
const oneShots = world => world.alarmLog.filter(e => e.op === 'create' && e.name === ALARM && !e.periodInMinutes);
const periodics = world => world.alarmLog.filter(e => e.op === 'create' && e.name === ALARM && e.periodInMinutes);

describe('a poll whose API calls fail', () => {
  let world, proton, state;
  beforeEach(() => {
    world = makeWorld();
    proton = makeProton();
    state = newState([account()]);
  });

  it('shows the error badge and backs off when every attempted account failed', async () => {
    state.apiFails = { acc1: {} }; // the whole API is unreachable
    await startWorker(world, state, proton).poll();

    expect(state.badgeError).toBe('connection error');
    // One-shot, not periodic: start() recognises a pending alarm without a
    // period as a backoff and leaves it alone.
    expect(oneShots(world)).toHaveLength(1);
    expect(oneShots(world)[0].delayInMinutes).toBe(1);
    expect(world.session.protonPollErrorCount).toBe(1);
  });

  it('translates the badge tooltip when i18n is available', async () => {
    // The other tests here assert 'connection error', which is only the
    // FALLBACK the poller uses when ProtonI18n is absent, as it is in this
    // harness. That means they would still pass if the lookup were deleted,
    // and every offline non-English user would silently get an English
    // tooltip. The poller resolves ProtonI18n off the global scope, so stub it
    // there and put it back afterwards.
    const had = Object.prototype.hasOwnProperty.call(globalThis, 'ProtonI18n');
    const prev = globalThis.ProtonI18n;
    globalThis.ProtonI18n = { t: (k) => (k === 'err_network_error' ? 'Netzwerkfehler' : k) };
    try {
      state.apiFails = { acc1: {} };
      await startWorker(world, state, proton).poll();
      expect(state.badgeError).toBe('Netzwerkfehler');
    } finally {
      if (had) globalThis.ProtonI18n = prev; else delete globalThis.ProtonI18n;
    }
  });

  it('escalates the wait poll by poll instead of retrying every minute', async () => {
    state.apiFails = { acc1: {} };
    const worker = startWorker(world, state, proton);
    await worker.poll();
    await worker.poll();
    await worker.poll();
    // BACKOFF_MULTIPLIERS = [1, 1, 2, 3, ...] x the 1-minute base interval.
    expect(oneShots(world).map(e => e.delayInMinutes)).toEqual([1, 2, 3]);
  });

  it('escalates across worker restarts, reading the count back from session', async () => {
    state.apiFails = { acc1: {} };
    // Each poll runs in its own worker, as it does in MV3 after a teardown.
    await startWorker(world, state, proton).poll();
    await startWorker(world, state, proton).poll();
    expect(oneShots(world).map(e => e.delayInMinutes)).toEqual([1, 2]);
  });

  it('does not back off while another account still polled fine', async () => {
    // Two accounts, one unreachable. The badge is showing real data for the
    // healthy one, so an error badge would be a lie, and slowing the poll
    // would slow the account that works.
    state = newState([account(), account({ id: 'acc2', email: 'other@example.com' })]);
    state.apiFails = { acc1: {} };
    await startWorker(world, state, proton).poll();

    expect(state.badgeError).toBeNull();
    expect(oneShots(world)).toHaveLength(0);
    expect(world.session.protonPollErrorCount ?? 0).toBe(0);
  });

  it('leaves a server Retry-After to nextPollNotBefore instead of backing off', async () => {
    // The server's own deferral IS the backoff. Counting it as a failure too
    // would defer this account twice over.
    state.apiFails = { acc1: { retryAfterSec: 120 } };
    await startWorker(world, state, proton).poll();

    expect(state.badgeError).toBeNull();
    expect(oneShots(world)).toHaveLength(0);
    expect(state.accounts[0].nextPollNotBefore).toBeGreaterThan(Date.now());
  });

  it('leaves a dead session to the "!" badge instead of backing off', async () => {
    // A permanent auth failure already surfaces as "!" via account.authError
    // and is skipped from the next poll on. Slowing every account down for it
    // helps nobody.
    state.apiFails = { acc1: { permanentAuth: true } };
    await startWorker(world, state, proton).poll();

    expect(state.badgeError).toBeNull();
    expect(oneShots(world)).toHaveLength(0);
  });

  it('resets the count and restores the periodic alarm once a poll succeeds', async () => {
    state.apiFails = { acc1: {} };
    await startWorker(world, state, proton).poll();
    await startWorker(world, state, proton).poll();
    expect(world.session.protonPollErrorCount).toBe(2);

    state.apiFails = null; // the network is back
    state.badgeError = null;
    await startWorker(world, state, proton).poll();

    expect(world.session.protonPollErrorCount).toBe(0);
    expect(state.badgeError).toBeNull();
    // restart(): the one-shot is cleared and the normal period is back.
    const last = periodics(world).pop();
    expect(last.periodInMinutes).toBe(1);
    expect(world.alarms.get(ALARM).periodInMinutes).toBe(1);
  });
});

describe('a poll that cannot unlock its keys', () => {
  // The offline path that actually matters. MV3 wakes with the in-memory keys
  // gone, so the first poll after a wake goes through ensureKeysUnlocked, which
  // needs core/v4/users and addresses. Offline that round trip fails and comes
  // back as false, BEFORE any of the calls the tests above fail. Treating that
  // as a plain 'skipped' left the backoff exactly as dead as the bug this file
  // was written for: no error badge, and one doomed request every minute.
  let world, proton, state;
  const locked = extra => account({ keysUnlocked: false, keyPassword: 'kp', ...extra });
  const unlockCalls = p => p.calls.filter(c => c.op === 'unlock').length;

  beforeEach(() => {
    world = makeWorld();
    proton = makeProton();
    state = newState([locked()]);
    state.unlockFails = true;
  });

  it('shows the error badge and backs off when the unlock attempt failed', async () => {
    await startWorker(world, state, proton).poll();

    expect(unlockCalls(proton)).toBe(1); // it really did try the server
    // NOT 'connection error'. The wait escalates identically, but a stale
    // stored key password is not a network problem and the tooltip is the only
    // reason a user sees without opening the popup: "network error" would send
    // them to check their wifi when the fix is to sign in again.
    expect(state.badgeError).toBe('sign in again');
    expect(oneShots(world)).toHaveLength(1);
    expect(oneShots(world)[0].delayInMinutes).toBe(1);
    expect(world.session.protonPollErrorCount).toBe(1);
  });

  it('says network error, not sign in, when only SOME accounts cannot unlock', async () => {
    // One account with a bad key password beside another that is merely
    // offline is still, for the user, a connection problem.
    state = newState([locked({ id: 'acc1' }), account({ id: 'acc2' })]);
    state.unlockFails = true;
    state.apiFails = { acc2: {} };
    await startWorker(world, state, proton).poll();
    expect(state.badgeError).toBe('connection error');
  });

  it('clears the escalated wait when the user signs in again', async () => {
    // start() cannot tell a backoff one-shot from a fresh schedule, so it
    // leaves it alone. Without resetBackoff a successful sign-in loaded the
    // mail at once and then sat there: the next AUTOMATIC poll was still a
    // full backoff interval away, over three hours on the free cadence.
    const worker = startWorker(world, state, proton);
    await worker.poll();
    await worker.poll();
    await worker.poll();
    expect(world.session.protonPollErrorCount).toBeGreaterThan(0);
    expect(oneShots(world).length).toBeGreaterThan(0);

    const before = world.alarmLog.length;
    await worker.resetBackoff();

    expect(world.session.protonPollErrorCount).toBe(0);
    const created = world.alarmLog.slice(before).filter(e => e.op === 'create');
    expect(created).toHaveLength(1);
    expect(created[0].periodInMinutes).toBe(1); // periodic again, not a one-shot
  });

  it('escalates poll by poll like any other failure', async () => {
    const worker = startWorker(world, state, proton);
    await worker.poll();
    await worker.poll();
    await worker.poll();
    expect(oneShots(world).map(e => e.delayInMinutes)).toEqual([1, 2, 3]);
  });

  it('recovers once the unlock succeeds again', async () => {
    await startWorker(world, state, proton).poll();
    expect(world.session.protonPollErrorCount).toBe(1);

    state.unlockFails = false; // the network is back, the keys unlock
    state.badgeError = null;
    await startWorker(world, state, proton).poll();

    expect(world.session.protonPollErrorCount).toBe(0);
    expect(state.badgeError).toBeNull();
    expect(world.alarms.get(ALARM).periodInMinutes).toBe(1);
  });

  it('does not back off for an account with nothing to unlock with', async () => {
    // Two-password mode before the user has entered the mailbox password:
    // ensureKeysUnlocked returns false having sent NOTHING, so there is no
    // failure to count and slowing the poll would only delay the moment the
    // user's unlock takes effect.
    state = newState([locked({ keyPassword: null })]);
    state.unlockFails = true;
    await startWorker(world, state, proton).poll();

    expect(unlockCalls(proton)).toBe(0); // no request, so nothing failed
    expect(state.badgeError).toBeNull();
    expect(oneShots(world)).toHaveLength(0);
    expect(world.session.protonPollErrorCount ?? 0).toBe(0);
  });

  it('still keeps polling the account whose keys are fine', async () => {
    state = newState([locked(), account({ id: 'acc2', email: 'other@example.com' })]);
    state.unlockFails = true;
    await startWorker(world, state, proton).poll();

    expect(state.badgeError).toBeNull();
    expect(oneShots(world)).toHaveLength(0);
    expect(proton.calls.some(c => c.op === 'events' && c.id === 'acc2')).toBe(true);
  });
});

describe('pollIfStale after a poll that failed', () => {
  // Round 1 moved "_lastCheckTime = Date.now()" below the new failure throw, so
  // a totally failed poll stopped advancing it, and no account sets its own
  // lastCheckTime on a total failure either. pollIfStale throttles on those, so
  // while offline EVERY popup open fired another doomed poll, and each one
  // incremented the error count and re-created the backoff alarm with a longer
  // delay, pushing the automatic retry further and further out. The popup is
  // the thing a user opens repeatedly when mail looks stuck, so this is the
  // worst possible moment to un-throttle.
  //
  // The fix stamps a separate "we tried" time. Claiming a successful check
  // instead would have made the popup report "Checked just now" for a check
  // that never happened.
  let world, proton, state;
  beforeEach(() => {
    world = makeWorld();
    proton = makeProton();
    // lastCheckTime 0: nothing has ever succeeded, which is the state an
    // outage leaves behind. The harness default presets a fresh timestamp,
    // which would throttle pollIfStale on its own and make these vacuous.
    state = newState([account({ lastCheckTime: 0 })]);
  });

  it('does not re-poll on every popup open while the API is down', async () => {
    state.apiFails = { acc1: {} };
    const worker = startWorker(world, state, proton);
    await worker.poll();

    const afterFirst = world.session.protonPollErrorCount;
    const alarmsAfterFirst = oneShots(world).length;

    // Three popup opens in a row, well inside the poll interval.
    await worker.pollIfStale();
    await worker.pollIfStale();
    await worker.pollIfStale();

    expect(world.session.protonPollErrorCount).toBe(afterFirst);
    expect(oneShots(world)).toHaveLength(alarmsAfterFirst);
  });

  it('still reports the last SUCCESSFUL check, not the last attempt', async () => {
    // The popup renders this as "Checked ...", so a failed attempt must not
    // move it forward.
    state.apiFails = { acc1: {} };
    const worker = startWorker(world, state, proton);
    await worker.poll();

    expect(worker.getState().lastCheckTime).toBeFalsy();
  });

  it('still polls on popup open once the interval has genuinely elapsed', async () => {
    state.apiFails = { acc1: {} };
    const worker = startWorker(world, state, proton);
    await worker.poll();
    const before = world.session.protonPollErrorCount;

    // Push the attempt stamp into the past, as the passage of time would.
    const realNow = Date.now;
    Date.now = () => realNow() + 10 * 60 * 1000;
    try {
      await worker.pollIfStale();
    } finally {
      Date.now = realNow;
    }

    expect(world.session.protonPollErrorCount).toBeGreaterThan(before);
  });
});

describe('snippets across a list refresh', () => {
  let world, proton, state;
  const bodyFetches = (proton, msgId, from = 0) => proton.calls
    .slice(from)
    .filter(c => c.op === 'getMessage' && (msgId === undefined || c.msgId === msgId)).length;

  beforeEach(() => {
    world = makeWorld({ previewLines: 3 });
    proton = makeProton();
    state = newState([account({ unreadCount: 4 })]);
  });

  it('fetches an arriving message body once per poll, not once per pass', async () => {
    // One message arrives, so the list is refetched. Before the fix the new
    // message was fetched twice (announce, then the refreshed list) on top of
    // the four messages that were already there.
    proton.push({ Messages: [create('n1')], ConversationCounts: [{ LabelID: '0', Unread: 5 }] });
    proton.list = [
      { ID: 'n1', Unread: 1, Time: 5 },
      { ID: 'm1', Unread: 1, Time: 4 },
      { ID: 'm2', Unread: 1, Time: 3 },
      { ID: 'm3', Unread: 1, Time: 2 },
      { ID: 'm4', Unread: 1, Time: 1 },
    ];
    proton.count = 5;

    const worker = startWorker(world, state, proton);
    await worker.poll();

    expect(bodyFetches(proton, 'n1')).toBe(1);
    expect(bodyFetches(proton)).toBe(5); // the new one plus the four unseen

    // A second poll with a second arrival: only the newcomer costs anything.
    const mark = proton.calls.length;
    proton.push({ Messages: [create('n2')], ConversationCounts: [{ LabelID: '0', Unread: 6 }] });
    proton.list = [{ ID: 'n2', Unread: 1, Time: 6 }, ...proton.list];
    proton.count = 6;
    await worker.poll();

    expect(bodyFetches(proton, 'n2', mark)).toBe(1);
    expect(bodyFetches(proton, undefined, mark)).toBe(1);
    // The refreshed list objects are new objects, yet they carry the snippets.
    const byId = Object.fromEntries(state.accounts[0].messages.map(m => [m.ID, m._snippet]));
    expect(byId.n1).toBe('Hello from n1');
    expect(byId.m4).toBe('Hello from m4');
  });

  it('reads the snippets it already holds back out of a restored snapshot', async () => {
    // Measured against the real extension: one arriving message still cost
    // FOUR body fetches. The snapshot in storage.session carries _snippet for
    // every held message and is restored on a wake, but the snippet cache is
    // module state and a new MV3 worker generation starts with it EMPTY, so
    // the first list refetch replaced those messages with fresh objects that
    // had no _snippet and found nothing cached. Seeding the cache from the
    // held messages before anything can replace them is the whole fix.
    const held = [
      { ID: 'm1', Unread: 1, Time: 4, _snippet: 'Hello from m1' },
      { ID: 'm2', Unread: 1, Time: 3, _snippet: 'Hello from m2' },
      { ID: 'm3', Unread: 1, Time: 2, _snippet: 'Hello from m3' },
    ];
    state = newState([account({ unreadCount: 3, messages: held })]);

    // One arrival, so the count changes and the list IS refetched. What comes
    // back are fresh objects, exactly as the API hands them over: no _snippet.
    proton.push({ Messages: [create('n1')], ConversationCounts: [{ LabelID: '0', Unread: 4 }] });
    proton.list = [
      { ID: 'n1', Unread: 1, Time: 5 },
      { ID: 'm1', Unread: 1, Time: 4 },
      { ID: 'm2', Unread: 1, Time: 3 },
      { ID: 'm3', Unread: 1, Time: 2 },
    ];
    proton.count = 4;

    // A FRESH worker: the cache starts empty, as it does after a wake.
    await startWorker(world, state, proton).poll();

    // 1, not 4: only the message we have never seen costs a GET and a decrypt.
    expect(bodyFetches(proton)).toBe(1);
    expect(bodyFetches(proton, 'n1')).toBe(1);
    for (const id of ['m1', 'm2', 'm3']) expect(bodyFetches(proton, id)).toBe(0);

    // And the fresh list objects still carry the snapshot's snippets, so the
    // popup shows previews immediately rather than after a second poll.
    const byId = Object.fromEntries(state.accounts[0].messages.map(m => [m.ID, m._snippet]));
    expect(byId).toEqual({
      n1: 'Hello from n1', m1: 'Hello from m1', m2: 'Hello from m2', m3: 'Hello from m3',
    });
  });
});

describe('the notification preview', () => {
  let proton, state;
  beforeEach(() => {
    proton = makeProton();
    state = newState([account({ unreadCount: 0 })]);
    proton.push({ Messages: [create('n1')], ConversationCounts: [{ LabelID: '0', Unread: 1 }] });
    proton.list = [{ ID: 'n1', Unread: 1, Time: 5 }, { ID: 'm1', Unread: 1, Time: 4 }];
    proton.count = 1;
  });

  const bodyFetches = p => p.calls.filter(c => c.op === 'getMessage').length;

  it('is fetched for an announced message with the default settings', async () => {
    // previewLines 0 (the list preview is off) but notificationPreviewText is
    // on: the default combination, under which the checkbox used to do
    // nothing because the fetch was gated on previewLines alone.
    const world = makeWorld({ previewLines: 0, notificationPreviewText: true });
    await startWorker(world, state, proton).poll();

    expect(state.notified).toEqual([{ ID: 'n1', snippet: 'Hello from n1' }]);
    // Only the announced message: the whole-list pass still respects
    // previewLines, so nothing else is decrypted.
    expect(bodyFetches(proton)).toBe(1);
  });

  it('is fetched when the setting was never written, which is its default', async () => {
    const world = makeWorld({ previewLines: 0 }); // notificationPreviewText absent
    await startWorker(world, state, proton).poll();

    expect(state.notified[0].snippet).toBe('Hello from n1');
  });

  it('costs nothing when both preview settings are off', async () => {
    const world = makeWorld({ previewLines: 0, notificationPreviewText: false });
    await startWorker(world, state, proton).poll();

    expect(bodyFetches(proton)).toBe(0);
    expect(state.notified).toEqual([{ ID: 'n1', snippet: undefined }]);
  });
});
