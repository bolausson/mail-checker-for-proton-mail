/**
 * What the background does when it wakes up, and what that costs in missed
 * notifications.
 *
 * MV3 stops the background after ~30 s idle, so nearly every poll starts in a
 * fresh worker that restores a snapshot (list, counts, event cursor) from
 * storage.session. A real 6-hour log had 286 such starts. Three defects, all
 * reproduced below against the real poller.js:
 *
 * 1. Any wake that was not the poll alarm (a tab update, the popup, another
 *    alarm) ran a full reload that jumped the event cursor to the newest event
 *    without reading the ones in between. Mail that had arrived since the last
 *    poll was listed but never notified. 32 such gaps in that log.
 * 2. Every wake re-created the poll alarm, which restarts its countdown, so a
 *    busy browser kept pushing the poll back. On the 15-minute free tier it
 *    could almost never fire.
 * 3. The event poll decided conversation vs message counts from a different
 *    view mode than the REST counts, followed extra pages recursively so an
 *    older page's count could win, and re-armed a cursor that a folder change
 *    had just reset.
 *
 * The world below is shared across "workers": storage.session and the alarms
 * survive a restart, module state does not, exactly as in the browser.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const ROOT = join(__dirname, '..');
const POLLER_SRC = readFileSync(join(ROOT, 'background', 'poller.js'), 'utf-8');
const NOTIFIER_SRC = readFileSync(join(ROOT, 'background', 'notifier.js'), 'utf-8');

const clone = v => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));

/** Storage and alarms: the part of the browser that outlives a worker. */
function makeWorld() {
  return {
    session: {},
    alarms: new Map(),
    alarmLog: [],
    settings: { maxEmailsPerAccount: 20, pollIntervalMinutes: 1 },
  };
}

function makeBrowser(world, { sessionAvailable = true } = {}) {
  const session = {
    get: async (key) => ({ [key]: clone(world.session[key]) }),
    set: async (obj) => { for (const [k, v] of Object.entries(obj)) world.session[k] = clone(v); },
    remove: async (key) => { delete world.session[key]; },
  };
  return {
    storage: sessionAvailable ? { session } : {},
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
 * A fake Proton account backend. `events` is an append-only list; a cursor is
 * the index of the next unread event, the way Proton's opaque IDs behave.
 */
function makeProton() {
  const p = {
    events: [],          // { Messages?, ConversationCounts?, MessageCounts?, Refresh?, ... }
    list: [],            // what a monitored list query returns
    count: 0,            // what getMonitoredUnreadCount returns
    calls: [],
    pageSize: 50,
    cursor() { return 'E' + this.events.length; },
    push(ev) { this.events.push(ev); },
  };
  return p;
}

/** One worker's view of ProtonAccounts, over the shared account objects. */
function makeAccounts(state, proton) {
  const find = id => state.accounts.find(a => a.id === id) || null;
  const scopeKey = a => (a.folderMode || 'inbox') + ':' + (a.scope || '0');
  return {
    hasAccounts: () => state.accounts.length > 0,
    getAccounts: () => state.accounts.map(a => ({
      id: a.id, email: a.email, unreadCount: a.unreadCount, authError: a.authError, lastCheckTime: a.lastCheckTime,
    })),
    getAccount: find,
    ensureKeysUnlocked: async (id) => {
      proton.calls.push({ op: 'unlock', id });
      await new Promise(r => setTimeout(r, 0));
      proton.calls.push({ op: 'unlocked', id });
      return state.unlockFails ? false : true;
    },
    snapshotSource: () => state.snapshotSource,
    scopeKey,
    effectiveViewMode: a => (typeof a.webViewMode === 'number' ? a.webViewMode : a.viewMode),
    getMonitoredLabelIds: () => ['0'],
    checkMonitoredAgainstCounts: async () => {},
    noteAccountEvents: async (id, ev) => {
      proton.calls.push({ op: 'note', id, keys: Object.keys(ev) });
      if (state.onNote) state.onNote(id, ev);
      return !!(ev.User || ev.Addresses || ev.Refresh);
    },
    saveSnapshot: async () => { proton.calls.push({ op: 'snapshot' }); },
    getLatestEventId: async (id) => { proton.calls.push({ op: 'latest', id }); return proton.cursor(); },
    getMonitoredUnreadCount: async (id) => {
      proton.calls.push({ op: 'count', id });
      if (state.onCount) state.onCount(id);
      return proton.count;
    },
    getMonitoredMessages: async (id, limit) => { proton.calls.push({ op: 'list', id, limit }); return clone(proton.list).slice(0, limit); },
    getEvents: async (id, cursor) => {
      proton.calls.push({ op: 'events', id, cursor });
      if (state.onGetEvents) state.onGetEvents(id, cursor);
      if (state.eventsError && state.eventsError(cursor)) throw state.eventsError(cursor);
      const from = Number(String(cursor).slice(1));
      const page = proton.events.slice(from, from + proton.pageSize);
      const next = from + page.length;
      // Merge the page into one event reply, newest counts last.
      const reply = { EventID: 'E' + next, More: next < proton.events.length ? 1 : 0, Messages: [] };
      for (const ev of page) {
        if (ev.Messages) reply.Messages.push(...ev.Messages);
        for (const k of ['ConversationCounts', 'MessageCounts', 'Refresh', 'MailSettings', 'User', 'Addresses']) {
          if (ev[k] !== undefined) reply[k] = ev[k];
        }
      }
      return reply;
    },
  };
}

/** Start a worker: fresh module state over the shared world. */
function startWorker(world, state, proton) {
  const notified = state.notified;
  const browser = makeBrowser(world);
  const accounts = makeAccounts(state, proton);
  const notifier = {
    notifyNewMessages: async (msgs) => {
      proton.calls.push({ op: 'notify', ids: msgs.map(m => m.ID) });
      for (const m of msgs) notified.push(m.ID);
      if (state.onNotify) state.onNotify();
    },
    seedNotifiedIds: async (msgs) => { state.seeded.push(...(msgs || []).map(m => m.ID)); },
  };
  const factory = new Function(
    'browser', 'ProtonAccounts', 'ProtonNotifier', 'ProtonBadge', 'ProtonDND', 'ProtonTombstones',
    'ProtonPremium', 'ProtonNotificationRules', 'ProtonDiag', 'ProtonLabels', 'getSettings', 'debugLog',
    POLLER_SRC + '\nreturn ProtonPoller;');
  return factory(
    browser, accounts, notifier,
    {
      setLoggedOut() {}, setError() {}, setDND() {}, getState: () => ({}),
      setUnreadCount(n) { if (state.badgeThrows) throw new Error('badge unavailable'); state.badge = n; },
    },
    { isActive: () => false },
    { apply() {} },
    { isPremium: () => state.premium !== false },
    { activeRules: () => [], needsBody: () => false, normalize: r => r },
    { record() {}, once: async () => true },
    { INBOX: '0', ALL_MAIL: '5' },
    async () => world.settings,
    () => {},
  );
}

function newState(accounts) {
  return { accounts, notified: [], seeded: [], snapshotSource: 'session', premium: true, badge: null };
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

describe('a wake that is not the poll alarm', () => {
  let world, proton;
  beforeEach(() => { world = makeWorld(); proton = makeProton(); });

  it('does not lose the mail that arrived since the last poll', async () => {
    // The bug, end to end. The last poll left the cursor at E0; then mail
    // arrived, and something other than the alarm woke the background.
    const state = newState([account({ lastEventId: proton.cursor() })]);
    proton.push({ Messages: [create('new-mail')], ConversationCounts: [{ LabelID: '0', Unread: 1 }] });
    proton.list = [{ ID: 'new-mail', Unread: 1, Time: 1 }];
    proton.count = 1;

    const woken = startWorker(world, state, proton);
    await woken.resume();
    // Fresh state: nothing is fetched and the cursor is left where it was.
    expect(proton.calls.filter(c => c.op === 'latest' || c.op === 'events')).toEqual([]);
    expect(state.accounts[0].lastEventId).toBe('E0');

    // The alarm then fires (in the same or a later worker) and reads on from
    // that cursor, so the create event is still there to notify.
    const later = startWorker(world, state, proton);
    await later.poll(); // what handleAlarm runs for the poll alarm
    expect(proton.calls.find(c => c.op === 'events').cursor).toBe('E0');
    expect(state.notified).toEqual(['new-mail']);
  });

  it('polls from the saved cursor at once when the state is older than the interval', async () => {
    const state = newState([account({ lastEventId: proton.cursor(), lastCheckTime: Date.now() - 5 * 60 * 1000 })]);
    proton.push({ Messages: [create('m1')], ConversationCounts: [{ LabelID: '0', Unread: 1 }] });
    proton.list = [{ ID: 'm1', Unread: 1 }];
    const w = startWorker(world, state, proton);
    await w.resume();
    expect(proton.calls.find(c => c.op === 'events').cursor).toBe('E0');
    expect(proton.calls.some(c => c.op === 'latest')).toBe(false);
    expect(state.notified).toEqual(['m1']);
  });

  it('gives only an account without a cursor the full load', async () => {
    const a = account({ id: 'a', lastEventId: 'E0' });
    const b = account({ id: 'b', email: 'b@example.com', lastEventId: null });
    const state = newState([a, b]);
    const w = startWorker(world, state, proton);
    await w.resume();
    const latest = proton.calls.filter(c => c.op === 'latest').map(c => c.id);
    expect(latest).toEqual(['b']);
    expect(a.lastEventId).toBe('E0');
    expect(b.lastEventId).toBe('E0');
  });

  it('still does the full load after a browser restart (disk snapshot)', async () => {
    // Mail that arrived while the browser was closed is shown, not announced.
    const state = newState([account({ lastEventId: 'E0' })]);
    state.snapshotSource = 'disk';
    proton.push({ Messages: [create('while-closed')] });
    proton.list = [{ ID: 'while-closed', Unread: 1 }];
    const w = startWorker(world, state, proton);
    await w.resume();
    expect(proton.calls.some(c => c.op === 'latest')).toBe(true);
    expect(proton.calls.some(c => c.op === 'events')).toBe(false);
    expect(state.notified).toEqual([]);
  });

  it('skips an account in an auth error', async () => {
    const state = newState([account({ lastEventId: null, authError: 'reauth' })]);
    const w = startWorker(world, state, proton);
    await w.resume();
    expect(proton.calls.some(c => c.op === 'latest')).toBe(false);
  });
});

describe('the poll alarm is not pushed back by every wake', () => {
  let world, proton, state;
  beforeEach(() => {
    world = makeWorld(); proton = makeProton();
    state = newState([account()]);
  });
  const creates = () => world.alarmLog.filter(e => e.op === 'create' && e.name === 'proton-mail-check');

  it('creates it when it is missing', async () => {
    await startWorker(world, state, proton).start();
    expect(creates()).toHaveLength(1);
    expect(creates()[0]).toMatchObject({ delayInMinutes: 1, periodInMinutes: 1 });
  });

  it('leaves a pending alarm with the right period alone', async () => {
    await startWorker(world, state, proton).start();
    await startWorker(world, state, proton).start();
    await startWorker(world, state, proton).start();
    expect(creates()).toHaveLength(1);
  });

  it('re-creates it when the interval changed', async () => {
    await startWorker(world, state, proton).start();
    world.settings.pollIntervalMinutes = 5;
    await startWorker(world, state, proton).start();
    expect(creates()).toHaveLength(2);
    expect(creates()[1].periodInMinutes).toBe(5);
  });

  it('leaves a pending backoff one-shot alone', async () => {
    world.alarms.set('proton-mail-check', { name: 'proton-mail-check', delayInMinutes: 3 });
    await startWorker(world, state, proton).start();
    expect(creates()).toHaveLength(0);
  });

  it('restart() replaces it, waiting for the clear first', async () => {
    await startWorker(world, state, proton).start();
    await startWorker(world, state, proton).restart();
    expect(world.alarmLog.map(e => e.op)).toEqual(['create', 'clear', 'create']);
    expect(world.alarms.get('proton-mail-check').periodInMinutes).toBe(1);
  });
});

describe('the backoff survives the worker', () => {
  it('escalates across restarts instead of starting over each time', async () => {
    const world = makeWorld();
    const proton = makeProton();
    const state = newState([account()]);
    state.badgeThrows = true; // an error poll() itself catches
    await startWorker(world, state, proton).poll();
    await startWorker(world, state, proton).poll();
    // Two failures in two workers: the second waits BACKOFF_MULTIPLIERS[2] = 2x.
    const oneShots = world.alarmLog.filter(e => e.op === 'create' && !e.periodInMinutes);
    expect(oneShots.map(e => e.delayInMinutes)).toEqual([1, 2]);
  });

  it('forgets the backoff across restarts once a poll succeeds', async () => {
    const world = makeWorld();
    const proton = makeProton();
    const state = newState([account()]);
    state.badgeThrows = true;
    await startWorker(world, state, proton).poll();
    state.badgeThrows = false;
    await startWorker(world, state, proton).poll();
    expect(world.session.protonPollErrorCount).toBe(0);
    // A later worker's start() then keeps the periodic alarm restart() made.
    const before = world.alarmLog.length;
    await startWorker(world, state, proton).start();
    expect(world.alarmLog.length).toBe(before);
  });
});

describe('the event poll', () => {
  let world, proton;
  beforeEach(() => { world = makeWorld(); proton = makeProton(); });

  it('uses message counts for an account whose web client shows single messages', async () => {
    // viewMode is our own bucket (always 0); webViewMode is what the user sees.
    const state = newState([account({ viewMode: 0, webViewMode: 1, unreadCount: 3 })]);
    proton.push({ ConversationCounts: [{ LabelID: '0', Unread: 1 }], MessageCounts: [{ LabelID: '0', Unread: 3 }] });
    await startWorker(world, state, proton).poll();
    expect(state.accounts[0].unreadCount).toBe(3);
    // Same number as before: no list refetch.
    expect(proton.calls.some(c => c.op === 'list')).toBe(false);
  });

  it('keeps the count when a page lacks the right kind, rather than using the other', async () => {
    const state = newState([account({ viewMode: 0, unreadCount: 2 })]);
    proton.push({ MessageCounts: [{ LabelID: '0', Unread: 7 }] });
    await startWorker(world, state, proton).poll();
    expect(state.accounts[0].unreadCount).toBe(2);
    expect(proton.calls.some(c => c.op === 'list')).toBe(false);
  });

  it('takes the newest page\'s count and refetches the list once', async () => {
    proton.pageSize = 1;
    const state = newState([account({ unreadCount: 0 })]);
    proton.push({ ConversationCounts: [{ LabelID: '0', Unread: 3 }] });
    proton.push({ ConversationCounts: [{ LabelID: '0', Unread: 5 }] });
    await startWorker(world, state, proton).poll();
    expect(proton.calls.filter(c => c.op === 'events').map(c => c.cursor)).toEqual(['E0', 'E1']);
    expect(state.accounts[0].unreadCount).toBe(5);
    expect(proton.calls.filter(c => c.op === 'list')).toHaveLength(1);
    expect(state.accounts[0].lastEventId).toBe('E2');
  });

  it('does not re-arm a cursor that a folder change reset while it waited', async () => {
    const state = newState([account()]);
    proton.push({ Messages: [create('x')] });
    // The user changes the monitored folders while getEvents is in flight.
    state.onGetEvents = () => { state.accounts[0].lastEventId = null; state.onGetEvents = null; };
    await startWorker(world, state, proton).poll();
    // It fell through to the full fetch and took a fresh cursor from there.
    expect(proton.calls.some(c => c.op === 'count')).toBe(true);
    expect(proton.calls.some(c => c.op === 'latest')).toBe(true);
  });

  it('refetches the list when the emails-per-account setting changed', async () => {
    const state = newState([account({ listLimit: 20 })]);
    world.settings.maxEmailsPerAccount = 50;
    await startWorker(world, state, proton).poll();
    const lists = proton.calls.filter(c => c.op === 'list');
    expect(lists).toHaveLength(1);
    expect(lists[0].limit).toBe(50);
    expect(state.accounts[0].listLimit).toBe(50);
  });

  it('hands account-level events on (settings, keys)', async () => {
    const state = newState([account()]);
    proton.push({ MailSettings: { ViewMode: 1 }, Addresses: [{}] });
    await startWorker(world, state, proton).poll();
    const note = proton.calls.find(c => c.op === 'note');
    expect(note.keys).toEqual(expect.arrayContaining(['MailSettings', 'Addresses']));
  });
});

describe('the event poll never drops mail it has already read past', () => {
  let world, proton;
  beforeEach(() => { world = makeWorld(); proton = makeProton(); proton.pageSize = 1; });

  it('announces earlier pages\' mail when a later page asks for a refresh', async () => {
    const state = newState([account({ unreadCount: 1 })]);
    proton.count = 1; // unchanged: the full-fetch fallback alone would not notify
    proton.push({ Messages: [create('m2')], ConversationCounts: [{ LabelID: '0', Unread: 1 }] });
    proton.push({ Refresh: 1 });
    await startWorker(world, state, proton).poll();
    expect(state.notified).toEqual(['m2']);
    // Refresh: keys re-read before the full fetch, which takes a new cursor.
    const ops = proton.calls.map(c => c.op);
    expect(ops.indexOf('unlocked')).toBeGreaterThan(-1);
    expect(ops.indexOf('unlocked')).toBeLessThan(ops.indexOf('count'));
    expect(ops).toContain('latest');
    expect(state.accounts[0].lastEventId).toBe(proton.cursor());
  });

  it('hands over to the full fetch when the folders change after the last page', async () => {
    // The change lands while the new mail is being announced: the page's count
    // is for the old folders and must not be stored as the new selection's.
    const state = newState([account({ unreadCount: 2 })]);
    proton.pageSize = 50;
    proton.push({ Messages: [create('x')], ConversationCounts: [{ LabelID: '0', Unread: 2 }] });
    state.onNotify = () => {
      state.accounts[0].lastEventId = null;
      state.accounts[0].scopeGen = 1;
      state.onNotify = null;
    };
    proton.count = 12;
    proton.list = [{ ID: 'x', Unread: 1 }, { ID: 'old1', Unread: 1 }, { ID: 'old2', Unread: 1 }];
    await startWorker(world, state, proton).poll();
    await startWorker(world, state, proton).poll();
    expect(state.notified).toEqual(['x']);
    expect(state.seeded).toEqual(expect.arrayContaining(['old1', 'old2']));
    expect(state.accounts[0].countGen).toBe(1);
  });

  it('refetches the list next poll after a rate limit skipped it', async () => {
    const state = newState([account()]);
    proton.push({ Messages: [create('a1')], ConversationCounts: [{ LabelID: '0', Unread: 1 }] });
    proton.push({ Messages: [] });
    state.eventsError = cursor => (cursor === 'E1' ? Object.assign(new Error('429'), { retryAfterSec: 1 }) : null);
    await startWorker(world, state, proton).poll();
    expect(state.accounts[0].listLimit).toBe(null);
    state.eventsError = null;
    state.accounts[0].nextPollNotBefore = null;
    proton.list = [{ ID: 'a1', Unread: 1 }];
    await startWorker(world, state, proton).poll();
    expect(state.accounts[0].messages.map(m => m.ID)).toEqual(['a1']);
  });

  it('announces them before deferring on a rate limit from a later page', async () => {
    const state = newState([account()]);
    proton.push({ Messages: [create('a1')], ConversationCounts: [{ LabelID: '0', Unread: 1 }] });
    proton.push({ Messages: [create('a2')] });
    state.eventsError = cursor => (cursor === 'E1' ? Object.assign(new Error('429'), { retryAfterSec: 600 }) : null);
    await startWorker(world, state, proton).poll();
    expect(state.notified).toEqual(['a1']);
    expect(state.accounts[0].nextPollNotBefore).toBeGreaterThan(Date.now());
    expect(state.accounts[0].unreadCount).toBe(1);
  });

  it('never asks for events/null when the cursor is reset between pages', async () => {
    const state = newState([account()]);
    proton.push({ Messages: [create('b1')] });
    proton.push({ Messages: [create('b2')] });
    // The folders change while page 0 is being processed.
    state.onNote = () => { state.accounts[0].lastEventId = null; state.onNote = null; };
    await startWorker(world, state, proton).poll();
    const cursors = proton.calls.filter(c => c.op === 'events').map(c => c.cursor);
    expect(cursors).not.toContain(null);
    // Not even one more page on the stale cursor: it goes to the full fetch.
    expect(cursors).toEqual(['E0']);
    expect(state.notified).toContain('b1');
  });

  it('re-reads the keys before decrypting mail that came with a key change', async () => {
    const state = newState([account()]);
    proton.push({ Messages: [create('to-new-address')], Addresses: [{}] });
    await startWorker(world, state, proton).poll();
    const ops = proton.calls.map(c => c.op);
    expect(ops.indexOf('unlocked')).toBeGreaterThan(-1);
    expect(ops.indexOf('unlocked')).toBeLessThan(ops.indexOf('notify'));
  });
});

describe('a full fetch takes its cursor first and keeps it honest', () => {
  let world, proton;
  beforeEach(() => { world = makeWorld(); proton = makeProton(); });

  it('takes the cursor before the count and list (fallback poll)', async () => {
    const state = newState([account({ lastEventId: null })]);
    await startWorker(world, state, proton).poll();
    const ops = proton.calls.map(c => c.op);
    expect(ops.indexOf('latest')).toBeLessThan(ops.indexOf('count'));
  });

  it('takes the cursor before the count and list (initial load)', async () => {
    const state = newState([account({ lastEventId: null })]);
    await startWorker(world, state, proton).initialLoad();
    const ops = proton.calls.map(c => c.op);
    expect(ops.indexOf('latest')).toBeLessThan(ops.indexOf('count'));
  });

  it('arms no cursor when the folders change during the fetch (fallback poll)', async () => {
    const state = newState([account({ lastEventId: null })]);
    state.onCount = () => { state.accounts[0].scopeGen = 1; };
    await startWorker(world, state, proton).poll();
    expect(state.accounts[0].lastEventId).toBe(null);
  });

  it('arms no cursor when the folders change during the fetch (initial load)', async () => {
    const state = newState([account({ lastEventId: null })]);
    state.onCount = () => { state.accounts[0].scopeGen = 1; };
    await startWorker(world, state, proton).initialLoad();
    expect(state.accounts[0].lastEventId).toBe(null);
  });

  it('records which selection the initial load was for', async () => {
    const state = newState([account({ lastEventId: null, scopeGen: 3, countGen: null })]);
    await startWorker(world, state, proton).initialLoad();
    expect(state.accounts[0].countGen).toBe(3);
  });

  it('does not treat the automatic removal of a deleted folder as a folder change', async () => {
    // The poller keys on the user-edit counter, not on the derived folder
    // key that such a removal changes: otherwise the cursor stayed unset and
    // the next poll silently swallowed new mail.
    const POLLER = readFileSync(join(ROOT, 'background', 'poller.js'), 'utf-8');
    expect(POLLER).not.toMatch(/scopeKey\(/);
    const state = newState([account({ lastEventId: null })]);
    state.onCount = () => { state.accounts[0].staleMonitorIds = ['DELETED']; };
    await startWorker(world, state, proton).poll();
    expect(state.accounts[0].lastEventId).toBe(proton.cursor());
  });

  it('leaves no old cursor behind when the load fails part-way', async () => {
    // e.g. a cursor from before the browser closed: resuming from it later
    // would replay everything since as new mail.
    const state = newState([account({ lastEventId: 'E0', keysUnlocked: false })]);
    state.unlockFails = true;
    await startWorker(world, state, proton).initialLoad();
    expect(state.accounts[0].lastEventId).toBe(null);
  });

  it('skips an account inside a server Retry-After', async () => {
    const state = newState([account({ lastEventId: null, nextPollNotBefore: Date.now() + 600000 })]);
    const network = () => proton.calls.filter(c => c.op !== 'snapshot');
    await startWorker(world, state, proton).resume();
    // resume() does not even start a load for it (no snapshot write either).
    expect(proton.calls).toEqual([]);
    await startWorker(world, state, proton).initialLoad();
    expect(network()).toEqual([]);
  });
});

describe('a folder change does not announce the added folders\' old mail', () => {
  it('takes the new list in silently when the count belongs to other folders', async () => {
    const world = makeWorld();
    const proton = makeProton();
    // The cursor was reset by a folder change (picker, import or sync); the
    // stored count (2) is for the old folders, the new set holds 12.
    const state = newState([account({ lastEventId: null, unreadCount: 2, countGen: 0, scopeGen: 1 })]);
    proton.count = 12;
    proton.list = [{ ID: 'old1', Unread: 1 }, { ID: 'old2', Unread: 1 }, { ID: 'old3', Unread: 1 }];
    await startWorker(world, state, proton).poll();
    expect(state.notified).toEqual([]);
    expect(state.seeded).toEqual(['old1', 'old2', 'old3']);
    expect(state.accounts[0].countGen).toBe(1);
  });

  it('still announces what arrived since the last check', async () => {
    const world = makeWorld();
    const proton = makeProton();
    const state = newState([account({ lastEventId: null, unreadCount: 2, countGen: 0, scopeGen: 1, lastCheckTime: Date.now() - 30000 })]);
    proton.count = 12;
    const now = Math.floor(Date.now() / 1000);
    proton.list = [{ ID: 'just-arrived', Unread: 1, Time: now }, { ID: 'old1', Unread: 1, Time: now - 86400 }];
    await startWorker(world, state, proton).poll();
    expect(state.notified).toEqual(['just-arrived']);
  });

  it('announces nothing when the last check is old (after a browser restart)', async () => {
    const world = makeWorld();
    const proton = makeProton();
    const state = newState([account({ lastEventId: null, countGen: null, lastCheckTime: Date.now() - 8 * 3600 * 1000 })]);
    proton.count = 3;
    const now = Math.floor(Date.now() / 1000);
    proton.list = [{ ID: 'overnight', Unread: 1, Time: now - 3600 }];
    await startWorker(world, state, proton).poll();
    expect(state.notified).toEqual([]);
    expect(state.seeded).toEqual(['overnight']);
  });

  it('still announces a rise on the same folders', async () => {
    const world = makeWorld();
    const proton = makeProton();
    const state = newState([account({ lastEventId: null, unreadCount: 1 })]);
    proton.count = 2;
    proton.list = [{ ID: 'fresh', Unread: 1 }];
    await startWorker(world, state, proton).poll();
    expect(state.notified).toEqual(['fresh']);
  });
});

describe('the quiet-rule badge exclusion counts the same unit as the badge', () => {
  it('subtracts conversations, not messages, in conversation mode', async () => {
    const world = makeWorld();
    const proton = makeProton();
    // Server count: 2 conversations. A has three unread messages that a rule
    // excludes; B has one normal one. The old code subtracted 3 and showed 0.
    const excluded = { _notifRule: { exclude: true } };
    const a = account({
      viewMode: 0, unreadCount: 2,
      messages: [
        { ID: 'a1', ConversationID: 'A', Unread: 1, ...excluded },
        { ID: 'a2', ConversationID: 'A', Unread: 1, ...excluded },
        { ID: 'a3', ConversationID: 'A', Unread: 1, ...excluded },
        { ID: 'b1', ConversationID: 'B', Unread: 1 },
      ],
    });
    const w = startWorker(world, newState([a]), proton);
    expect(w.getState().unreadCount).toBe(1);
  });

  it('does not subtract a conversation that still has counted unread mail', async () => {
    const a = account({
      viewMode: 0, unreadCount: 1,
      messages: [
        { ID: 'a1', ConversationID: 'A', Unread: 1, _notifRule: { exclude: true } },
        { ID: 'a2', ConversationID: 'A', Unread: 1 },
      ],
    });
    const w = startWorker(makeWorld(), newState([a]), makeProton());
    expect(w.getState().unreadCount).toBe(1);
  });

  it('follows the web client\'s mode, not our own bucket', async () => {
    // viewMode 0 (ours) but grouping is off in the web app: the counts are
    // message counts, so three excluded messages come off as three.
    const excluded = { _notifRule: { exclude: true } };
    const a = account({
      viewMode: 0, webViewMode: 1, unreadCount: 4,
      messages: [
        { ID: 'a1', ConversationID: 'A', Unread: 1, ...excluded },
        { ID: 'a2', ConversationID: 'A', Unread: 1, ...excluded },
        { ID: 'a3', ConversationID: 'A', Unread: 1, ...excluded },
        { ID: 'b1', ConversationID: 'B', Unread: 1 },
      ],
    });
    const w = startWorker(makeWorld(), newState([a]), makeProton());
    expect(w.getState().unreadCount).toBe(1);
  });

  it('still subtracts messages in single-message mode', async () => {
    const a = account({
      viewMode: 1, unreadCount: 3,
      messages: [
        { ID: 'a1', ConversationID: 'A', Unread: 1, _notifRule: { exclude: true } },
        { ID: 'a2', ConversationID: 'A', Unread: 1, _notifRule: { exclude: true } },
        { ID: 'b1', ConversationID: 'B', Unread: 1 },
      ],
    });
    const w = startWorker(makeWorld(), newState([a]), makeProton());
    expect(w.getState().unreadCount).toBe(1);
  });

  it('refreshBadgeNow paints the same number as a poll', async () => {
    const state = newState([account({
      viewMode: 1, unreadCount: 2,
      messages: [{ ID: 'x', Unread: 1, _notifRule: { exclude: true } }, { ID: 'y', Unread: 1 }],
    })]);
    const w = startWorker(makeWorld(), state, makeProton());
    w.refreshBadgeNow();
    expect(state.badge).toBe(1);
  });
});

describe('already-notified mail stays notified across workers', () => {
  function loadNotifier(world) {
    const shown = [];
    const browser = {
      storage: makeBrowser(world).storage,
      notifications: { create: async (id, o) => { shown.push(o.title + '|' + o.message); }, clear: async () => {}, onClicked: { addListener() {} } },
    };
    const factory = new Function(
      'browser', 'ProtonDND', 'ProtonAccounts', 'ProtonPremium', 'ProtonAudioBridge', 'ProtonI18n', 'getSettings', 'debugLog', 'ProtonPoller',
      NOTIFIER_SRC + '\nreturn ProtonNotifier;');
    const notifier = factory(
      browser, { isActive: () => false },
      { getAccount: () => null, getAccounts: () => [{ id: 'acc1' }], getMailUrl: () => '' },
      { isPremium: () => false }, { playSound: async () => {} },
      { t: (k) => k }, async () => ({}), () => {}, { poll() {} });
    return { notifier, shown };
  }
  const msg = (id) => ({ ID: id, Subject: 'S ' + id, Sender: { Name: 'N', Address: 'n@x' } });

  it('does not announce a message twice after a restart', async () => {
    const world = makeWorld();
    const first = loadNotifier(world);
    await first.notifier.notifyNewMessages([msg('m1')], 'user@example.com', 'acc1');
    const second = loadNotifier(world);
    await second.notifier.notifyNewMessages([msg('m1'), msg('m2')], 'user@example.com', 'acc1');
    expect(first.shown).toHaveLength(1);
    expect(second.shown).toHaveLength(1);
    // One notification can list several subjects, so check both ways.
    expect(second.shown[0]).toContain('S m2');
    expect(second.shown[0]).not.toContain('S m1');
  });

  it('remembers seeded mail across a restart too', async () => {
    const world = makeWorld();
    await loadNotifier(world).notifier.seedNotifiedIds([msg('old')]);
    const later = loadNotifier(world);
    await later.notifier.notifyNewMessages([msg('old')], 'user@example.com', 'acc1');
    expect(later.shown).toHaveLength(0);
  });
});
