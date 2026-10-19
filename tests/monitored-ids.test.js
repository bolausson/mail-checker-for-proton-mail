/**
 * A deleted folder must not turn a folder monitor into "all mail".
 *
 * A customer monitored four folders and saw Archive and Spam mail in the list.
 * Their settings held a fifth ID, a folder or label since deleted in Proton:
 * the picker only draws what still exists, so they could neither see nor
 * untick it. Proton answers a list query for a deleted ID by ignoring the
 * filter and returning the whole mailbox. That was measured on a live account
 * (2026-09-18), and so were the facts the fake server below reproduces:
 *
 * - LabelID=<deleted ID> returns 200 and every message; a made-up ID is a 400.
 * - The counts list every existing folder and label, empty ones as 0/0, and
 *   drop an ID once it is deleted.
 * - Moving mail to Spam strips its custom labels.
 *
 * The behavioural tests run the real functions lifted out of accounts.js.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const ROOT = join(__dirname, '..');
const read = rel => readFileSync(join(ROOT, rel), 'utf-8');
const LIB = read('lib/monitored-ids.js');
const ACCOUNTS = read('background/accounts.js');
const POLLER = read('background/poller.js');
const BACKGROUND = read('background/background.js');
const OPTIONS_JS = read('options/options.js');
const OPTIONS_HTML = read('options/options.html');
const POPUP = read('popup/popup.js');
const MANIFEST = JSON.parse(read('manifest.json'));

const ProtonMonitoredIds = new Function(LIB + '; return ProtonMonitoredIds;')();

// Lift a top-level function out of a source file, keeping `async`.
function lift(src, name) {
  let start = src.indexOf('function ' + name + '(');
  if (start === -1) throw new Error('not found: ' + name);
  if (src.slice(start - 6, start) === 'async ') start -= 6;
  let i = src.indexOf('{', src.indexOf(')', start));
  let depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) return src.slice(start, i + 1); }
  }
  throw new Error('unbalanced braces reading ' + name);
}

// IDs shaped like Proton's: custom ones are long base64, system ones numeric.
const F_ONE = 'FOLDA1xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx==';
const F_TWO = 'FOLDB2xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx==';
const F_THREE = 'FOLDC3xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx==';
const L_ONE = 'LABELAxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx==';
const STALE = 'DELETEDFOLDERxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx==';

// Four messages like the ones in the report, plus one ordinary Inbox message, with
// the labels Proton gives them.
const ROOT_MSG = { ID: 'root', Time: 400, Unread: 1, LabelIDs: [F_TWO, '5', '15'] };
const INBOX_MSG = { ID: 'inbox1', Time: 350, Unread: 1, LabelIDs: ['0', '5', '15'] };
const LABELLED_1 = { ID: 'labelled1', Time: 300, Unread: 1, LabelIDs: ['6', '5', '15', L_ONE] };
const LABELLED_2 = { ID: 'labelled2', Time: 290, Unread: 1, LabelIDs: ['6', '5', '15', L_ONE] };
const SPAM_MSG = { ID: 'spam1', Time: 100, Unread: 1, LabelIDs: ['4', '5'] };
const MAILBOX = [ROOT_MSG, INBOX_MSG, LABELLED_1, LABELLED_2, SPAM_MSG];

describe('trimming a list reply to the ID it was asked for', () => {
  it('drops everything a deleted ID leaks', () => {
    const { kept, dropped } = ProtonMonitoredIds.carrying(MAILBOX, STALE);
    expect(kept).toEqual([]);
    expect(dropped).toBe(5);
  });

  it('keeps a real folder reply whole', () => {
    expect(ProtonMonitoredIds.carrying([ROOT_MSG], F_TWO)).toEqual({ kept: [ROOT_MSG], dropped: 0 });
  });

  it('keeps labelled mail wherever it lives, when the label is monitored', () => {
    // Labels cut across folders. Monitoring a label must still show the
    // labelled message sitting in Archive.
    const { kept } = ProtonMonitoredIds.carrying([LABELLED_1, LABELLED_2], L_ONE);
    expect(kept).toEqual([LABELLED_1, LABELLED_2]);
  });

  it('keeps a message with no LabelIDs rather than emptying the list', () => {
    const bare = { ID: 'bare' };
    expect(ProtonMonitoredIds.carrying([bare], F_TWO).kept).toEqual([bare]);
  });

  it('works for Inbox and the other system folders the picker offers', () => {
    const sent = { ID: 's', LabelIDs: ['2', '5', '7', '15'] };
    const starred = { ID: 'st', LabelIDs: ['0', '5', '10', '15'] };
    expect(ProtonMonitoredIds.carrying([INBOX_MSG], '0').kept).toEqual([INBOX_MSG]);
    expect(ProtonMonitoredIds.carrying([sent], '7').kept).toEqual([sent]);
    expect(ProtonMonitoredIds.carrying([starred], '10').kept).toEqual([starred]);
    expect(ProtonMonitoredIds.carrying([SPAM_MSG], '5').kept).toEqual([SPAM_MSG]);
  });
});

describe('spotting a deleted ID from the counts', () => {
  const COUNTS = ['0', '4', '5', '6', F_ONE, F_TWO, F_THREE, L_ONE]
    .map(LabelID => ({ LabelID, Unread: 0, Total: 0 }));

  it('flags a custom ID the counts no longer list', () => {
    expect(ProtonMonitoredIds.missingFromCounts(['0', F_TWO, STALE], COUNTS)).toEqual([STALE]);
  });

  it('does not flag an existing folder that is empty', () => {
    // Measured: an empty folder is listed as 0/0. If this ever changed, the
    // confirmation step still stands between a flag and a removal.
    expect(ProtonMonitoredIds.missingFromCounts([F_THREE], COUNTS)).toEqual([]);
  });

  it('never flags a system ID', () => {
    expect(ProtonMonitoredIds.missingFromCounts(['10', '7'], COUNTS)).toEqual([]);
  });

  it('flags nothing when the counts are missing or empty', () => {
    expect(ProtonMonitoredIds.missingFromCounts([STALE], [])).toEqual([]);
    expect(ProtonMonitoredIds.missingFromCounts([STALE], undefined)).toEqual([]);
  });
});

describe('confirming and removing', () => {
  it('calls stale only what neither list knows', () => {
    const folders = [{ ID: F_ONE }, { ID: F_TWO }];
    const labels = [{ ID: L_ONE }];
    expect(ProtonMonitoredIds.stale([STALE, F_TWO, L_ONE, '4'], folders, labels)).toEqual([STALE]);
  });

  it('removes from both lists and keeps the order', () => {
    const acc = { monitoredFolders: ['0', STALE, F_TWO], monitoredLabels: [STALE, L_ONE] };
    expect(ProtonMonitoredIds.withoutStale(acc, [STALE])).toEqual({
      monitoredFolders: ['0', F_TWO],
      monitoredLabels: [L_ONE],
    });
  });

  it('never empties a selection, because empty means Inbox', () => {
    const acc = { monitoredFolders: [STALE], monitoredLabels: [] };
    expect(ProtonMonitoredIds.withoutStale(acc, [STALE])).toEqual({ monitoredFolders: [STALE], monitoredLabels: [] });
  });

  it('lets a user edit empty the selection of deleted IDs', () => {
    const acc = { monitoredFolders: [], monitoredLabels: [STALE], staleMonitorIds: [STALE] };
    expect(ProtonMonitoredIds.withoutDeleted(acc)).toEqual({ monitoredFolders: [], monitoredLabels: [] });
  });

  it('leaves deleted IDs out of what is queried', () => {
    const acc = { monitoredFolders: ['0', STALE], monitoredLabels: [L_ONE], staleMonitorIds: [STALE] };
    expect(ProtonMonitoredIds.selected(acc)).toEqual(['0', STALE, L_ONE]);
    expect(ProtonMonitoredIds.live(acc)).toEqual(['0', L_ONE]);
  });
});

describe('describing the monitor for the log', () => {
  it('shows five entries where the picker showed four ticks', () => {
    const acc = { folderMode: 'custom', monitoredFolders: ['0', F_ONE, F_TWO, F_THREE, STALE], monitoredLabels: [] };
    expect(ProtonMonitoredIds.describe(acc))
      .toBe('mode=custom folders=Inbox,FOLDA1,FOLDB2,FOLDC3,DELETE labels=-');
  });

  it('marks a deleted ID that is still stored', () => {
    const acc = { folderMode: 'custom', monitoredFolders: [STALE], monitoredLabels: [], staleMonitorIds: [STALE] };
    expect(ProtonMonitoredIds.describe(acc)).toBe('mode=custom folders=DELETE labels=- deleted=DELETE');
  });

  it('names the plain modes', () => {
    expect(ProtonMonitoredIds.describe({ folderMode: 'all' })).toBe('mode=all');
    expect(ProtonMonitoredIds.describe({})).toBe('mode=inbox');
  });
});

// A fake account module assembled from the real functions in accounts.js.
function buildAccounts(server) {
  const names = ['_monitoredQueryIds', 'getMonitoredMessages', 'getMonitoredUnreadCount',
    'getMonitoredLabelIds', '_pruneStaleMonitoredIds', '_recordMonitorConfig', '_recordLeak',
    'checkMonitoredAgainstCounts', 'importAccountSettings', 'updateAccountSettings',
    '_exportEntry', '_scopeKey', '_recordReadInUnread', '_folderMode', '_proSettingsApply'];
  const body = names.map(n => lift(ACCOUNTS, n)).join('\n') +
    '\nconst _monitoredIdsConfirmed = new Map();' +
    '\nconst _STALE_MONITOR_IDS_MAX = 200;' +
    '\nreturn { ' + names.join(', ') + ' };';
  const factory = new Function('_accounts', 'getAccount', 'getMessages', 'getFolders', 'getLabels',
    'getCountsForViewMode', 'getInboxUnreadCount', '_save', 'pushAccountSettingsToSync', 'saveSnapshot',
    'ProtonDiag', 'ProtonLabels', 'ProtonMonitoredIds', 'debugLog', body);
  return factory(
    [server.account],
    () => server.account,
    async (_acc, id, limit) => { server.queries.push(id); return server.list(id).slice(0, limit); },
    async () => { server.lookups++; if (server.lookupFails) throw new Error('offline'); return { Labels: server.folders }; },
    async () => ({ Labels: server.labels }),
    async () => server.counts,
    async () => { throw new Error('the custom branch must not fall back to the Inbox helper'); },
    async () => { server.saves++; server.order.push('save'); },
    async () => { server.syncPushes++; },
    async () => {
      server.snapshots++;
      server.order.push('snapshot');
      server.cursorAtSnapshot = server.account.lastEventId;
    },
    {
      once: async (key, sig) => { if (server.sigs[key] === sig) return false; server.sigs[key] = sig; return true; },
      record: (event, fields) => { server.records.push({ event, ...fields }); },
    },
    { INBOX: '0', ALL_MAIL: '5' },
    ProtonMonitoredIds,
    () => {},
  );
}

describe('the customer\'s account, end to end', () => {
  let server;
  let api;
  const recorded = event => server.records.filter(r => r.event === event);

  beforeEach(() => {
    const live = new Set(['0', '5', '10', F_ONE, F_TWO, F_THREE, L_ONE]);
    server = {
      account: {
        id: 'acc1', email: 'alex@example.com', folderMode: 'custom',
        monitoredFolders: ['0', F_ONE, F_TWO, F_THREE, STALE], monitoredLabels: [],
      },
      folders: [{ ID: F_ONE }, { ID: F_TWO }, { ID: F_THREE }],
      labels: [{ ID: L_ONE }],
      counts: ['0', '4', '5', '6', '10', F_ONE, F_TWO, F_THREE, L_ONE]
        .map(LabelID => ({ LabelID, Unread: LabelID === F_TWO ? 1 : (LabelID === '0' ? 37 : 0), Total: 0 })),
      mailbox: MAILBOX,
      // Proton as measured: a live ID filters, a deleted one returns everything.
      list: id => (live.has(id) ? server.mailbox.filter(m => m.LabelIDs.includes(id)) : server.mailbox),
      queries: [], lookups: 0, lookupFails: false, saves: 0, syncPushes: 0, snapshots: 0, order: [], sigs: {}, records: [],
    };
    api = buildAccounts(server);
  });

  it('lists only the mail in the monitored folders', async () => {
    const msgs = await api.getMonitoredMessages('acc1', 20, { unreadOnly: true });
    expect(msgs.map(m => m.ID)).toEqual(['root', 'inbox1']);
  });

  it('stops querying the deleted folder and remembers it locally', async () => {
    await api.getMonitoredMessages('acc1', 20, { unreadOnly: true });
    expect(server.account.monitoredFolders).toEqual(['0', F_ONE, F_TWO, F_THREE]);
    expect(server.account.staleMonitorIds).toEqual([STALE]);
    expect(server.saves).toBe(1);
    server.queries = [];
    await api.getMonitoredMessages('acc1', 20, { unreadOnly: true });
    expect(server.queries).toEqual(['0', F_ONE, F_TWO, F_THREE]);
  });

  it('never writes to sync on its own', async () => {
    // Pushing this device's whole settings map unprompted could overwrite an
    // edit just made on another device.
    await api.getMonitoredMessages('acc1', 20, { unreadOnly: true });
    expect(server.syncPushes).toBe(0);
  });

  it('strips the deleted ID from a stale synced copy', async () => {
    await api.getMonitoredMessages('acc1', 20, { unreadOnly: true });
    // Firefox re-imports synced settings on every worker start.
    await api.importAccountSettings({
      'alex@example.com': { folderMode: 'custom', monitoredFolders: ['0', F_TWO, STALE], monitoredLabels: [] },
    });
    expect(server.account.monitoredFolders).toEqual(['0', F_TWO]);
    server.queries = [];
    await api.getMonitoredMessages('acc1', 20, { unreadOnly: true });
    expect(server.queries).not.toContain(STALE);
  });

  it('writes the leak, the removal and the config to the log', async () => {
    await api.getMonitoredMessages('acc1', 20, { unreadOnly: true });
    expect(recorded('monitor.config')).toHaveLength(1);
    expect(recorded('monitor.leak')[0]).toMatchObject({ id: 'DELETE', dropped: 5, returned: 5 });
    expect(recorded('monitor.pruned')[0].removed).toBe('DELETE');
  });

  it('writes each of those once, not on every poll', async () => {
    server.lookupFails = true; // keeps the leak happening poll after poll
    await api.getMonitoredMessages('acc1', 20, { unreadOnly: true });
    await api.getMonitoredMessages('acc1', 20, { unreadOnly: true });
    expect(recorded('monitor.config')).toHaveLength(1);
    expect(recorded('monitor.leak')).toHaveLength(1);
  });

  it('logs a removal once even when a restart finds the ID again', async () => {
    await api.getMonitoredMessages('acc1', 20, { unreadOnly: true });
    // A new worker: fresh module state, same persisted diag signatures, and
    // the save lost, so storage still holds the deleted ID.
    server.account.monitoredFolders = ['0', F_ONE, F_TWO, F_THREE, STALE];
    server.account.staleMonitorIds = [];
    api = buildAccounts(server);
    await api.getMonitoredMessages('acc1', 20, { unreadOnly: true });
    expect(recorded('monitor.pruned')).toHaveLength(1);
  });

  it('also catches it from the counts, before any list is fetched', async () => {
    const total = await api.getMonitoredUnreadCount('acc1');
    expect(total).toBe(38);
    expect(server.account.monitoredFolders).not.toContain(STALE);
  });

  it('removes nothing when the folder lookup fails, and tries again later', async () => {
    server.lookupFails = true;
    const msgs = await api.getMonitoredMessages('acc1', 20, { unreadOnly: true });
    expect(msgs.map(m => m.ID)).toEqual(['root', 'inbox1']);
    expect(server.account.monitoredFolders).toContain(STALE);
    expect(server.saves).toBe(0);
    server.lookupFails = false;
    await api.getMonitoredMessages('acc1', 20, { unreadOnly: true });
    expect(server.account.monitoredFolders).not.toContain(STALE);
  });

  it('keeps a live folder the counts happen to omit, and asks only once', async () => {
    server.counts = server.counts.filter(c => c.LabelID !== F_THREE);
    server.account.monitoredFolders = ['0', F_THREE];
    await api.getMonitoredUnreadCount('acc1');
    await api.getMonitoredUnreadCount('acc1');
    expect(server.account.monitoredFolders).toEqual(['0', F_THREE]);
    expect(server.lookups).toBe(1);
  });

  it('keeps a live label the counts happen to omit', async () => {
    // The label half of the confirmation: a folder-only check would call
    // this label deleted.
    server.counts = server.counts.filter(c => c.LabelID !== L_ONE);
    server.account.monitoredFolders = [];
    server.account.monitoredLabels = [L_ONE];
    await api.getMonitoredUnreadCount('acc1');
    expect(server.account.monitoredLabels).toEqual([L_ONE]);
    expect(server.saves).toBe(0);
  });

  it('removes only the deleted one when a live one is suspected alongside it', async () => {
    server.counts = server.counts.filter(c => c.LabelID !== L_ONE);
    server.account.monitoredLabels = [L_ONE];
    await api.getMonitoredUnreadCount('acc1');
    expect(server.account.monitoredFolders).not.toContain(STALE);
    expect(server.account.monitoredLabels).toEqual([L_ONE]);
  });

  it('monitors nothing, not Inbox, when the only ticked folder is deleted', async () => {
    server.account.monitoredFolders = [STALE];
    const msgs = await api.getMonitoredMessages('acc1', 20, { unreadOnly: true });
    expect(msgs).toEqual([]);
    expect(server.account.monitoredFolders).toEqual([STALE]);
    expect(server.account.staleMonitorIds).toEqual([STALE]);
    expect(api.getMonitoredLabelIds('acc1')).toEqual([]);
    expect(await api.getMonitoredUnreadCount('acc1')).toBe(0);
    server.queries = [];
    await api.getMonitoredMessages('acc1', 20, { unreadOnly: true });
    expect(server.queries).toEqual([]);
  });

  it('means Inbox when the user unticks everything, even with a deleted label hidden', async () => {
    // The deleted label is kept after the prune (never-empty rule) and sits
    // in the list the folder picker does not send.
    server.account.monitoredFolders = [];
    server.account.monitoredLabels = [STALE];
    await api.getMonitoredMessages('acc1', 20, { unreadOnly: true });
    expect(api.getMonitoredLabelIds('acc1')).toEqual([]);
    await api.updateAccountSettings('acc1', { monitoredFolders: [F_TWO] });
    expect(api.getMonitoredLabelIds('acc1')).toEqual([F_TWO]);
    await api.updateAccountSettings('acc1', { monitoredFolders: [] });
    expect(server.account.monitoredLabels).toEqual([]);
    expect(api.getMonitoredLabelIds('acc1')).toEqual(['0']);
  });

  it('still reads Inbox when nothing at all is ticked', async () => {
    server.account.monitoredFolders = [];
    expect(api.getMonitoredLabelIds('acc1')).toEqual(['0']);
    expect(await api.getMonitoredUnreadCount('acc1')).toBe(37);
  });

  it('shows labelled Archive mail when the label is what the user monitors', async () => {
    server.account.monitoredFolders = [];
    server.account.monitoredLabels = [L_ONE];
    const msgs = await api.getMonitoredMessages('acc1', 20, { unreadOnly: true });
    expect(msgs.map(m => m.ID)).toEqual(['labelled1', 'labelled2']);
    expect(server.saves).toBe(0);
  });

  it('merges several folders newest first, once each, up to the limit', async () => {
    const a = { ID: 'a', Time: 500, LabelIDs: ['0', '10'] };
    const b = { ID: 'b', Time: 450, LabelIDs: ['0'] };
    const c = { ID: 'c', Time: 480, LabelIDs: ['10'] };
    server.mailbox = [a, b, c];
    server.account.monitoredFolders = ['0', '10'];
    const msgs = await api.getMonitoredMessages('acc1', 2, { unreadOnly: true });
    expect(msgs.map(m => m.ID)).toEqual(['a', 'c']);
  });

  it('checks the event stream\'s counts too', async () => {
    await api.checkMonitoredAgainstCounts('acc1', server.counts);
    expect(server.account.monitoredFolders).not.toContain(STALE);
  });

  it('keeps Inbox mode showing Inbox mail', async () => {
    server.account.folderMode = 'inbox';
    const msgs = await api.getMonitoredMessages('acc1', 20, { unreadOnly: true });
    expect(server.queries).toEqual(['0']);
    expect(msgs.map(m => m.ID)).toEqual(['inbox1']);
    await api.checkMonitoredAgainstCounts('acc1', server.counts);
    expect(server.lookups).toBe(0);
  });

  it('keeps All mail mode showing everything, Spam included', async () => {
    server.account.folderMode = 'all';
    const msgs = await api.getMonitoredMessages('acc1', 20, { unreadOnly: true });
    expect(server.queries).toEqual(['5']);
    expect(msgs.map(m => m.ID)).toEqual(['root', 'inbox1', 'labelled1', 'labelled2', 'spam1']);
  });
});

describe('an import that changes the monitored folders', () => {
  let server;
  let api;
  const EMAIL = 'alex@example.com';

  beforeEach(() => {
    server = {
      account: {
        id: 'acc1', email: EMAIL, folderMode: 'custom',
        monitoredFolders: ['0', F_TWO], monitoredLabels: [], lastEventId: 'E9',
      },
      folders: [], labels: [], counts: [], list: () => [], mailbox: [],
      queries: [], lookups: 0, lookupFails: false, saves: 0, syncPushes: 0, snapshots: 0, order: [], sigs: {}, records: [],
    };
    api = buildAccounts(server);
  });

  const sync = (extra) => ({ [EMAIL]: { folderMode: 'custom', monitoredFolders: ['0', F_TWO], monitoredLabels: [], ...extra } });

  it('resets the event cursor and writes the snapshot before the settings', async () => {
    // A different folder set on the old cursor kept showing the old folders'
    // list until some count happened to change. And the order matters: a
    // teardown between the writes must not leave the new scope on the old cursor.
    const result = await api.importAccountSettings(sync({ monitoredFolders: ['0', F_THREE] }));
    expect(result.scopeChanged).toEqual(['acc1']);
    // A user edit: the poller treats the next count rise as existing mail.
    expect(server.account.scopeGen).toBe(1);
    expect(server.account.lastEventId).toBe(null);
    expect(server.order).toEqual(['snapshot', 'save']);
    // And the snapshot carries the reset, not the old cursor.
    expect(server.cursorAtSnapshot).toBe(null);
  });

  it('does nothing at all for an identical copy (the import on every worker start)', async () => {
    const result = await api.importAccountSettings(sync());
    expect(result).toEqual({ changed: false, scopeChanged: [] });
    expect(server.account.scopeGen).toBeUndefined();
    expect(server.account.lastEventId).toBe('E9');
    expect(server.order).toEqual([]);
  });

  it('keeps the cursor when only the order differs', async () => {
    await api.importAccountSettings(sync({ monitoredFolders: [F_TWO, '0'] }));
    expect(server.account.lastEventId).toBe('E9');
  });

  it('keeps the cursor for a copy that still carries a deleted ID', async () => {
    server.account.staleMonitorIds = [STALE];
    await api.importAccountSettings(sync({ monitoredFolders: ['0', F_TWO, STALE] }));
    expect(server.account.monitoredFolders).toEqual(['0', F_TWO]);
    expect(server.account.lastEventId).toBe('E9');
  });

  it('keeps the cursor for an account that monitors nothing any more', async () => {
    // Every ticked folder deleted: the key is 'custom:', never empty, so a
    // re-import of the same state does not look like a change.
    server.account.monitoredFolders = [STALE];
    server.account.staleMonitorIds = [STALE];
    await api.importAccountSettings(sync({ monitoredFolders: [STALE] }));
    expect(server.account.lastEventId).toBe('E9');
  });

  it('also writes the snapshot first for a change made in the picker', async () => {
    await api.updateAccountSettings('acc1', { monitoredFolders: ['0', F_THREE] });
    expect(server.account.lastEventId).toBe(null);
    expect(server.order).toEqual(['snapshot', 'save']);
    expect(server.cursorAtSnapshot).toBe(null);
    expect(server.account.scopeGen).toBe(1);
  });
});

describe('a read message in an unread-only reply', () => {
  let server;
  let api;
  beforeEach(() => {
    server = {
      account: { id: 'acc1', email: 'u@example.com', folderMode: 'custom', monitoredFolders: [F_TWO], monitoredLabels: [] },
      folders: [{ ID: F_TWO }], labels: [], counts: [],
      mailbox: [
        { ID: 'unread', Time: 3, Unread: 1, LabelIDs: [F_TWO] },
        { ID: 'read', Time: 2, Unread: 0, LabelIDs: [F_TWO, '4'] },
        { ID: 'no-flag', Time: 1, LabelIDs: [F_TWO] },
      ],
      list: id => server.mailbox.filter(m => m.LabelIDs.includes(id)),
      queries: [], lookups: 0, lookupFails: false, saves: 0, syncPushes: 0, snapshots: 0, order: [], sigs: {}, records: [],
    };
    api = buildAccounts(server);
  });

  it('is dropped, but only an explicit Unread 0', async () => {
    // A customer's popup showed a read Spam message from an Unread=1 query
    // (Proton's side). A missing flag is kept, so a changed field can never
    // empty the list.
    const msgs = await api.getMonitoredMessages('acc1', 20, { unreadOnly: true });
    expect(msgs.map(m => m.ID)).toEqual(['unread', 'no-flag']);
  });

  it('is kept when the caller did not ask for unread only', async () => {
    const msgs = await api.getMonitoredMessages('acc1', 20, {});
    expect(msgs.map(m => m.ID)).toEqual(['unread', 'read', 'no-flag']);
  });

  it('is recorded once, with its labels', async () => {
    await api.getMonitoredMessages('acc1', 20, { unreadOnly: true });
    await api.getMonitoredMessages('acc1', 20, { unreadOnly: true });
    const recs = server.records.filter(r => r.event === 'list.readInUnread');
    expect(recs).toHaveLength(1);
    expect(recs[0]).toMatchObject({ id: 'FOLDB2', count: 1 });
    expect(recs[0].labels).toContain('Spam');
  });
});

describe('wiring', () => {
  it('loads the module before accounts.js in the background', () => {
    const scripts = MANIFEST.background.scripts;
    expect(scripts).toContain('lib/monitored-ids.js');
    expect(scripts.indexOf('lib/monitored-ids.js')).toBeLessThan(scripts.indexOf('background/accounts.js'));
  });

  it('checks the event counts inside the branch that has them', () => {
    const fn = lift(POLLER, '_pollAccountViaEvents');
    const branch = fn.slice(fn.indexOf('if (eventCounts)'), fn.indexOf('// Detect new messages'));
    expect(branch).toContain('await ProtonAccounts.checkMonitoredAgainstCounts(accountId, eventCounts)');
  });

  it('keeps the deleted-ID list local: saved, never exported or synced', () => {
    expect(lift(ACCOUNTS, '_save')).toContain('staleMonitorIds: a.staleMonitorIds || []');
    expect(lift(ACCOUNTS, 'getAccountSettingsExport')).not.toContain('staleMonitorIds');
    expect(lift(ACCOUNTS, '_pruneStaleMonitoredIds')).not.toContain('pushAccountSettingsToSync');
  });

  it('still syncs a user edit, through the shared function', () => {
    expect(BACKGROUND).toContain('await ProtonAccounts.pushAccountSettingsToSync()');
  });

  it('states the monitored folders in the export header, from storage', () => {
    expect(OPTIONS_HTML).toContain('../lib/monitored-ids.js');
    const exportHandler = OPTIONS_JS.slice(
      OPTIONS_JS.indexOf('btnExportDiag.addEventListener'),
      OPTIONS_JS.indexOf('btnClearDiag.addEventListener'));
    expect(exportHandler).toContain("browser.storage.local.get('protonAccounts')");
    expect(exportHandler).toContain("'Monitor ' + a.email + ': ' + ProtonMonitoredIds.describe(a)");
    // Asking the background would hang the export exactly when it is broken.
    expect(exportHandler).not.toContain('sendMessage');
  });

  it('resets the once() signatures when the log is cleared', () => {
    // Without this, clear then reproduce never re-reports the plan, quiet
    // rules or monitored folders: they were "already said".
    expect(OPTIONS_JS).toContain('_authDiag: [], _diagSigs: {}');
    expect(OPTIONS_JS).not.toContain('set({ _authDiag: [] })');
  });

  it('saves only folders and labels the picker can show', () => {
    expect(POPUP).toContain('Array.from(selectedIds).filter(id => !foldersLoaded || shownIds.has(id))');
    expect(POPUP).toContain('Array.from(selectedIds).filter(id => shownLabelIds.has(id))');
    expect(POPUP).toContain('const foldersLoaded = !!(folders && !folders.error)');
  });
});
