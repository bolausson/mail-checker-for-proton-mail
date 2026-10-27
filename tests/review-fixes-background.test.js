/**
 * Background fixes whose regression would show no error anywhere: the user
 * just gets the wrong file, a late poll, an English tooltip or a weaker
 * signature check, and the diagnostic log quietly fills with data or lines
 * it should not hold.
 *
 *  1. OPEN_ATTACHMENT refuses bytes that are still encrypted. With key
 *     packets supplied, decrypted false means PGP ciphertext: the preview
 *     would show garbage, and on the download branch the browser would save
 *     it under the attachment's real filename.
 *  2. A sign-in clears the poll backoff. start() leaves an escalated one-shot
 *     alarm alone, so after an account has been failing the next automatic
 *     poll could still be hours away on the free cadence.
 *  3. The decrypted attendee data never reaches the log. debugLog and the
 *     console warnings feed the exportable diagnostic ring, and that payload
 *     holds every attendee's address and the event's details.
 *  4. Folder lists go out at most four at a time, and one failure stops the
 *     rest: after a 429 on one folder, the other queries must not keep going
 *     to a server that just asked us to wait.
 *  5. A burst of 401s from one expired token logs one req.401 per refresh
 *     cycle, and a failed refresh logs one refresh.fail per attempt, not one
 *     per request that waited on it. Otherwise the counts in the log no
 *     longer match what happened.
 *  6. The unread tooltip on the toolbar button is translated.
 *  7. A sender key lookup that failed is not cached. An empty key set pinned
 *     after one network error would turn off attachment signature checks for
 *     that sender for the life of the worker (days on a Firefox event page).
 *
 * The functions are lifted out of the real sources and run with injected
 * dependencies (same pattern as cold-start-keys.test.js); the sign-in runs
 * against the real poller and the tooltip against the real i18n table.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const ROOT = join(__dirname, '..');
const read = rel => readFileSync(join(ROOT, rel), 'utf-8');
const ACCOUNTS = read('background/accounts.js');
const BACKGROUND = read('background/background.js');
const POLLER = read('background/poller.js');
const BADGE = read('background/badge.js');
const I18N = read('lib/i18n.js');
const MONITORED_IDS = read('lib/monitored-ids.js');

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

// Lift one `case 'NAME':` of a switch, up to the next case or the end of the
// switch. The message handler is one large switch, and running the whole
// handler would tie these tests to every other message type in it.
function liftCase(src, label) {
  const start = src.indexOf("case '" + label + "':");
  if (start === -1) throw new Error('not found: case ' + label);
  const firstOnLine = i => src.slice(src.lastIndexOf('\n', i - 1) + 1, i).trim() === '';
  let depth = 0;
  for (let i = start + 1; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      if (depth === 0) return src.slice(start, i);
      depth--;
    } else if (depth === 0 && firstOnLine(i) &&
        (src.startsWith('case ', i) || src.startsWith('default:', i))) {
      return src.slice(start, i);
    }
  }
  throw new Error('unbalanced braces reading case ' + label);
}

// One macrotask: lets every pending await settle before the next step.
const flush = () => new Promise(resolve => setTimeout(resolve, 0));

const FAKE_KEY = { id: 'key1', toPublic: () => ({ id: 'key1pub' }) };

// --- 1. background.js: OPEN_ATTACHMENT ---------------------------------------

describe('opening an attachment that could not be decrypted', () => {
  const CIPHERTEXT = new Uint8Array([0xc1, 0x0e, 0x03, 0x1f, 0x9a, 0x42]); // PGP packet-ish
  const PLAINTEXT = new TextEncoder().encode('%PDF-1.7 quarterly figures');

  /**
   * The real case plus the real fetch-and-decrypt helper it calls. The
   * Chrome service worker has no `window` and stashes the bytes for the
   * preview page; the Firefox event page has one and opens a blob tab.
   */
  function build({ decrypts, serviceWorker }) {
    const seen = { tabs: [], stashed: [], blobs: [] };
    const accounts = {
      getAccount: () => ({ id: 'acc1', keysUnlocked: true }),
      getAttachment: async () => CIPHERTEXT,
      ensureKeysUnlocked: async () => true,
      decryptAttachment: async () => {
        if (!decrypts) throw new Error('Session key decryption failed');
        return PLAINTEXT;
      },
    };
    const fetchAndDecrypt = new Function('ProtonAccounts', 'console',
      lift(BACKGROUND, '_fetchAndDecryptAttachment') + '\nreturn _fetchAndDecryptAttachment;')(
      accounts, { warn() {} });
    const inlineSafe = new Function(
      BACKGROUND.match(/const INLINE_SAFE_MIME = new Set\(\[[^\]]*\]\);/)[0] + '\n' +
      lift(BACKGROUND, '_inlineSafeMimeType') + '\nreturn _inlineSafeMimeType;')();
    const browser = {
      runtime: { getURL: p => 'chrome-extension://ext-id/' + p },
      tabs: {
        create: async ({ url }) => { seen.tabs.push(url); return { id: 7 }; },
        onRemoved: { addListener() {}, removeListener() {} },
      },
    };
    class FakeBlob {
      constructor(parts, opts) { seen.blobs.push({ bytes: parts[0], type: opts.type }); }
    }
    const handle = new Function('_fetchAndDecryptAttachment', '_inlineSafeMimeType',
      '_stashPreviewBytes', '_scheduleBlobRevoke', 'browser', 'window', 'Blob', 'URL',
      'return function (message, sendResponse) {\nswitch (message.type) {\n' +
      liftCase(BACKGROUND, 'OPEN_ATTACHMENT') + '\n}\n};')(
      fetchAndDecrypt, inlineSafe,
      (bytes, mimeType, filename) => { seen.stashed.push({ bytes, mimeType, filename }); return 'p1'; },
      () => {},
      browser,
      serviceWorker ? undefined : {},
      FakeBlob,
      { createObjectURL: () => 'blob:moz-extension://ext-id/1', revokeObjectURL() {} });
    const open = extra => new Promise(resolve => {
      handle({
        type: 'OPEN_ATTACHMENT', accountId: 'acc1', attachmentId: 'att1',
        filename: 'figures.pdf', mimeType: 'application/pdf', ...extra,
      }, resolve);
    });
    return { open, seen };
  }

  const KEY_PACKETS = 'a2V5cGFja2V0cw==';

  it('fails visibly instead of previewing ciphertext (Chrome)', async () => {
    const { open, seen } = build({ decrypts: false, serviceWorker: true });
    // The popup turns any error into its localized download-failed toast.
    expect(await open({ keyPackets: KEY_PACKETS })).toEqual({ error: expect.any(String) });
    expect(seen.stashed).toEqual([]);
    expect(seen.tabs).toEqual([]);
  });

  it('fails visibly instead of opening ciphertext as a blob (Firefox)', async () => {
    const { open, seen } = build({ decrypts: false, serviceWorker: false });
    expect(await open({ keyPackets: KEY_PACKETS })).toEqual({ error: expect.any(String) });
    expect(seen.blobs).toEqual([]);
    expect(seen.tabs).toEqual([]);
  });

  it('opens the decrypted bytes when the decrypt worked', async () => {
    const { open, seen } = build({ decrypts: true, serviceWorker: true });
    const res = await open({ keyPackets: KEY_PACKETS });
    expect(res).toEqual({ ok: true });
    expect(Array.from(seen.stashed[0].bytes)).toEqual(Array.from(PLAINTEXT));
    expect(seen.tabs).toHaveLength(1);
  });

  it('still opens an attachment that came without key packets', async () => {
    // Nothing was meant to be decrypted, so the bytes are what the server
    // sent and decrypted false is not a failure.
    const { open, seen } = build({ decrypts: false, serviceWorker: false });
    const res = await open({});
    expect(res).toEqual({ ok: true });
    expect(Array.from(seen.blobs[0].bytes)).toEqual(Array.from(CIPHERTEXT));
    expect(seen.tabs).toHaveLength(1);
  });
});

// --- 2. background.js: the sign-in epilogue, against the real poller ----------

describe('signing in after the poll has backed off', () => {
  const ALARM = POLLER.match(/const ALARM_NAME = '([^']+)';/)[1];
  const clone = v => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));

  /** storage.session and the alarms: what a fresh worker wakes into. */
  function makeWorld() {
    return {
      session: {},
      alarms: new Map(),
      account: {
        id: 'acc1', email: 'user@example.com', folderMode: 'inbox', viewMode: 0,
        unreadCount: 0, messages: [], keysUnlocked: true, scopeGen: 0, countGen: 0,
      },
    };
  }

  function startPoller(world) {
    const browser = {
      storage: {
        session: {
          get: async key => ({ [key]: clone(world.session[key]) }),
          set: async obj => { for (const [k, v] of Object.entries(obj)) world.session[k] = clone(v); },
        },
      },
      alarms: {
        get: async name => clone(world.alarms.get(name)),
        create: (name, opts) => { world.alarms.set(name, { name, ...opts }); },
        clear: async name => world.alarms.delete(name),
      },
      runtime: { sendMessage: () => Promise.resolve() },
    };
    const acc = world.account;
    const accounts = {
      hasAccounts: () => true,
      getAccounts: () => [{ id: acc.id, email: acc.email, unreadCount: acc.unreadCount, authError: acc.authError }],
      getAccount: () => acc,
      effectiveViewMode: a => a.viewMode,
      ensureKeysUnlocked: async () => true,
      getLatestEventId: async () => 'E1',
      getMonitoredUnreadCount: async () => 2,
      getMonitoredMessages: async () => [
        { ID: 'm1', Unread: 1, Time: 200, LabelIDs: ['0', '5'] },
        { ID: 'm2', Unread: 1, Time: 100, LabelIDs: ['0', '5'] },
      ],
      saveSnapshot: async () => {},
    };
    return new Function(
      'browser', 'ProtonAccounts', 'ProtonNotifier', 'ProtonBadge', 'ProtonDND', 'ProtonTombstones',
      'ProtonPremium', 'ProtonNotificationRules', 'ProtonDiag', 'ProtonLabels', 'getSettings', 'debugLog',
      POLLER + '\nreturn ProtonPoller;')(
      browser, accounts,
      { notifyNewMessages: async () => {}, seedNotifiedIds: async () => {} },
      { setLoggedOut() {}, setDND() {}, setError() {}, setUnreadCount() {}, getState: () => 'normal' },
      { isActive: () => false },
      { apply() {} },
      { isPremium: () => false }, // the free cadence: 15 minutes
      { activeRules: () => [], needsBody: () => false, normalize: r => r },
      { record() {}, once: async () => true },
      { INBOX: '0', ALL_MAIL: '5' },
      async () => ({ maxEmailsPerAccount: 20, pollIntervalMinutes: 15 }),
      () => {},
    );
  }

  function finishLoginFlow(poller) {
    return new Function('ProtonPoller', '_setPendingLogin', '_clearPopupAccountDraft',
      lift(BACKGROUND, '_finishLoginFlow') + '\nreturn _finishLoginFlow;')(
      poller, () => {}, () => {})();
  }

  it('puts the next automatic poll back on the normal interval', async () => {
    const world = makeWorld();
    // What six failed polls leave behind: the count in storage.session and a
    // one-shot alarm at 13 x the 15-minute free interval.
    world.session.protonPollErrorCount = 6;
    world.alarms.set(ALARM, { name: ALARM, delayInMinutes: 195 });

    const poller = startPoller(world);
    await finishLoginFlow(poller);

    // The mail was loaded at once...
    expect(world.account.unreadCount).toBe(2);
    // ...and the next poll is one normal interval away, periodic again.
    expect(world.alarms.get(ALARM)).toMatchObject({ delayInMinutes: 15, periodInMinutes: 15 });
    expect(world.session.protonPollErrorCount).toBe(0);
  });
});

// --- 3. accounts.js: decrypted attendee data stays out of the log -------------

describe('decrypting the attendee list of an invite', () => {
  // The decrypted AttendeesEvent: every attendee's address plus the event.
  const PAYLOAD = [
    'BEGIN:VCALENDAR',
    'BEGIN:VEVENT',
    'UID:evt-7f3a@example.org',
    'SUMMARY:Contract renewal with legal',
    'ATTENDEE;CN=Co Invitee;X-PM-TOKEN=tok-co;PARTSTAT=NEEDS-ACTION:mailto:co.invitee@example.net',
    'ATTENDEE;CN=Alex;X-PM-TOKEN=tok-me;PARTSTAT=ACCEPTED:mailto:alex@example.com',
    'END:VEVENT',
    'END:VCALENDAR',
  ].join('\r\n');

  function build(logged) {
    // Formatted the way the diagnostic ring formats them: strings as they
    // are, anything else as JSON, so a logged object shows what it holds.
    const record = (...args) =>
      logged.push(args.map(a => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
    const body = lift(ACCOUNTS, '_attendeeTokenEmailMap') + '\n' +
      lift(ACCOUNTS, '_decryptAttendeeEmails') + '\nreturn _decryptAttendeeEmails;';
    return new Function('getAccount', '_getCalendarKeys', 'ProtonBinary', 'openpgp', 'debugLog', 'console', body)(
      () => ({ id: 'acc1', keysUnlocked: true, decryptedKeys: [FAKE_KEY] }),
      async () => [],
      { base64ToUint8: () => new Uint8Array([1, 2, 3]) },
      {
        readMessage: async () => ({}),
        decryptSessionKeys: async () => [{ data: new Uint8Array(32), algorithm: 'aes256' }],
        decrypt: async () => ({ data: PAYLOAD }),
      },
      record,
      // console.warn and console.error are copied into the same ring.
      { log: record, info: record, warn: record, error: record },
    );
  }

  it('resolves the tokens and keeps the decrypted data out of the log', async () => {
    const logged = [];
    const map = await build(logged)('acc1', {
      CalendarID: 'cal1',
      AddressKeyPacket: 'a2V5cGFja2V0',
      AttendeesEvents: [{ Data: 'ZW5jcnlwdGVkLWF0dGVuZGVlcw==' }],
    });

    expect(map).toEqual({ 'tok-co': 'co.invitee@example.net', 'tok-me': 'alex@example.com' });
    // The decrypt is still logged, so the checks below look at real output.
    expect(logged).not.toEqual([]);
    const log = logged.join('\n');
    const secrets = ['co.invitee@example.net', 'alex@example.com', 'Co Invitee', 'tok-co', 'tok-me',
      'evt-7f3a', 'Contract renewal', 'BEGIN:VCALENDAR', 'VEVENT'];
    for (const secret of secrets) {
      expect(log).not.toContain(secret);
    }
  });
});

// --- 4. accounts.js: per-folder list queries ----------------------------------

describe('listing a monitor of ten folders', () => {
  const ProtonMonitoredIds = new Function(MONITORED_IDS + '; return ProtonMonitoredIds;')();
  // Custom folder IDs are long and opaque, like Proton's.
  const FOLDERS = Array.from({ length: 10 }, (_, i) => 'FOLDER' + String(i).padStart(2, '0') + 'x'.repeat(78) + '==');
  const messageIn = (id, i) => ({ ID: 'msg' + i, Time: 1000 + i, Unread: 1, LabelIDs: [id, '5'] });

  let server;
  let getMonitoredMessages;

  beforeEach(() => {
    // Every list query stays open until the test answers it, so what is in
    // flight at any moment is exactly server.pending.
    server = {
      account: { id: 'acc1', email: 'user@example.com', folderMode: 'custom', monitoredFolders: FOLDERS, monitoredLabels: [] },
      queries: [],
      pending: [],
    };
    const names = ['_monitoredQueryIds', 'getMonitoredMessages', '_recordMonitorConfig', '_folderMode', '_proSettingsApply'];
    const body = names.map(n => lift(ACCOUNTS, n)).join('\n') + '\nreturn getMonitoredMessages;';
    getMonitoredMessages = new Function('getAccount', 'getMessages', '_recordLeak', '_recordReadInUnread',
      '_pruneStaleMonitoredIds', 'ProtonDiag', 'ProtonLabels', 'ProtonMonitoredIds', 'ProtonPremium', body)(
      () => server.account,
      (accountId, labelId) => new Promise((resolve, reject) => {
        server.queries.push(labelId);
        server.pending.push({ labelId, resolve, reject });
      }),
      async () => {}, async () => {}, async () => {},
      { once: async () => true, record() {} },
      { INBOX: '0', ALL_MAIL: '5' },
      ProtonMonitoredIds,
      { isPremium: () => true },
    );
  });

  it('never has more than four folder queries in flight', async () => {
    const run = getMonitoredMessages('acc1', 20, { unreadOnly: true });
    await flush();
    expect(server.pending.map(p => p.labelId)).toEqual(FOLDERS.slice(0, 4));

    let most = server.pending.length;
    while (server.pending.length) {
      const next = server.pending.shift();
      next.resolve([messageIn(next.labelId, FOLDERS.indexOf(next.labelId))]);
      await flush();
      most = Math.max(most, server.pending.length);
    }
    const msgs = await run;

    expect(most).toBe(4);
    expect(server.queries).toEqual(FOLDERS);
    expect(msgs.map(m => m.ID)).toEqual(FOLDERS.map((_, i) => 'msg' + i).reverse());
  });

  it('sends no further folder query once one has failed', async () => {
    const run = getMonitoredMessages('acc1', 20, { unreadOnly: true }).then(() => null, e => e);
    await flush();
    const [first, ...others] = server.pending.splice(0);

    const busy = Object.assign(new Error('Too many requests'), { status: 429, retryAfterSec: 30 });
    first.reject(busy);
    await flush();
    // The three already on the wire still answer; nothing new may follow them.
    for (const p of others) p.resolve([]);
    await flush();

    expect(await run).toBe(busy);
    expect(server.queries).toEqual(FOLDERS.slice(0, 4));
    expect(server.pending).toEqual([]);
  });
});

// --- 5. accounts.js: one log line per refresh, not per request ----------------

describe('a burst of requests on an expired session', () => {
  // Four folder lists of one poll, all sent with the same expired token.
  const PATHS = ['mail/v4/messages?f=1', 'mail/v4/messages?f=2', 'mail/v4/messages?f=3', 'mail/v4/messages?f=4'];

  let world;
  let request;
  const logged = event => world.records.filter(r => r.event === event);

  beforeEach(() => {
    world = {
      account: {
        id: 'acc1', email: 'user@example.com', uid: 'uid-0123456789',
        accessToken: 'access-0', refreshToken: 'refresh-0', consecutiveErrors: 0, authError: null,
      },
      validTokens: new Set(), // access-0 has expired
      refreshes: 0,
      refreshFails: false,
      records: [],
    };
    // The error codes, and the module state request() and _refreshTokens()
    // share, declared as the source declares them.
    const consts = ['ERROR_CODE_ACCOUNT_DELETED', 'ERROR_CODE_ACCOUNT_DISABLED', '_refreshInFlight', '_req401Logged']
      .map(n => ACCOUNTS.match(new RegExp('const ' + n + ' = [^;\\n]+;'))[0]);
    const body = consts.join('\n') + '\n' +
      ['request', '_refreshTokens', '_withRefreshLock'].map(n => lift(ACCOUNTS, n)).join('\n') +
      '\nreturn request;';
    request = new Function('getAccount', '_rawRequest', '_doRefreshTokens', '_setAuthError',
      '_clearAuthError', 'ProtonDiag', 'debugLog', 'navigator', body)(
      () => world.account,
      async (uid, accessToken, method, path) => {
        await Promise.resolve();
        if (!world.validTokens.has(accessToken)) {
          throw Object.assign(new Error('Invalid access token'), { status: 401 });
        }
        return { Code: 1000, path };
      },
      // One rotation, which takes a real round trip.
      async () => {
        world.refreshes++;
        await flush();
        if (world.refreshFails) throw new Error('NetworkError when attempting to fetch resource.');
        world.account.accessToken = 'access-' + world.refreshes;
        world.validTokens = new Set([world.account.accessToken]);
      },
      (account, reason) => { account.authError = reason; },
      () => {},
      { record: (event, fields) => world.records.push({ event, ...fields }) },
      () => {},
      undefined, // no Web Locks: _withRefreshLock runs the refresh directly
    );
  });

  it('logs one req.401 for the burst, and a later expiry gets its own', async () => {
    const replies = await Promise.all(PATHS.map(p => request('acc1', 'GET', p)));
    expect(replies.map(r => r.path)).toEqual(PATHS);
    expect(world.refreshes).toBe(1);
    expect(logged('req.401')).toHaveLength(1);

    world.validTokens = new Set(); // the new token expires in turn
    await request('acc1', 'GET', PATHS[0]);
    expect(world.refreshes).toBe(2);
    expect(logged('req.401')).toHaveLength(2);
  });

  it('logs one refresh.fail per failed refresh, however many requests waited on it', async () => {
    world.refreshFails = true;
    const errors = await Promise.all(PATHS.map(p => request('acc1', 'GET', p).then(() => null, e => e)));
    expect(errors).toEqual(PATHS.map(() => expect.any(Error)));
    expect(world.refreshes).toBe(1);
    expect(logged('refresh.fail')).toHaveLength(1);

    // A second, separate attempt is a second line.
    await request('acc1', 'GET', PATHS[0]).catch(() => {});
    expect(world.refreshes).toBe(2);
    expect(logged('refresh.fail')).toHaveLength(2);
  });
});

// --- 6. badge.js: the unread tooltip ------------------------------------------

describe('the toolbar tooltip for unread mail', () => {
  /** The tooltip badge.js sets, and what the language's table says for it. */
  async function tooltipFor(lang, count) {
    const i18n = new Function(I18N + '\nreturn ProtonI18n;')();
    i18n.setLanguage(lang);
    const titles = [];
    const action = {
      setIcon() {}, setBadgeText() {}, setBadgeBackgroundColor() {},
      setTitle: ({ title }) => titles.push(title),
    };
    const badge = new Function('browser', 'getSettings', 'ProtonI18n', BADGE + '\nreturn ProtonBadge;')(
      { action }, async () => ({}), i18n);
    await badge.setUnreadCount(count, false);
    return { title: titles.at(-1), table: i18n.t('badgeUnreadTitle', count) };
  }

  it('reads in the user\'s language', async () => {
    for (const [lang, count] of [['de', 3], ['it', 12]]) {
      const { title, table } = await tooltipFor(lang, count);
      expect(title).toBe(table);
      // The language really has its own wording, so this is not English
      // compared with English.
      expect(table).not.toBe((await tooltipFor('en', count)).table);
    }
  });

  it('is still English, count included, for an English user', async () => {
    const { title, table } = await tooltipFor('en', 3);
    expect(title).toBe(table);
    expect(title).toContain('3');
  });
});

// --- 7. accounts.js: the sender key cache -------------------------------------

describe('looking up a sender\'s public keys', () => {
  const SENDER = 'colleague@example.org';
  const ARMORED = '-----BEGIN PGP PUBLIC KEY BLOCK-----\nxjMEZtest\n-----END PGP PUBLIC KEY BLOCK-----';

  let world;
  let getSenderKeys;

  beforeEach(() => {
    world = { offline: false, lookups: [], keys: { [SENDER]: [{ PublicKey: ARMORED }] } };
    const body = 'const _senderKeyCache = new Map();\n' +
      ACCOUNTS.match(/const SENDER_KEY_CACHE_MAX = \d+;/)[0] + '\n' +
      lift(ACCOUNTS, '_getSenderPublicKeys') + '\nreturn _getSenderPublicKeys;';
    getSenderKeys = new Function('request', 'openpgp', 'debugLog', body)(
      async (accountId, method, path, opts) => {
        world.lookups.push(opts.params.Email);
        if (world.offline) throw new Error('NetworkError when attempting to fetch resource.');
        return { Code: 1000, Keys: world.keys[opts.params.Email.toLowerCase()] || [] };
      },
      { readKey: async ({ armoredKey }) => ({ armoredKey }) },
      () => {},
    );
  });

  it('asks again after a lookup that failed, and gets the key', async () => {
    world.offline = true;
    expect(await getSenderKeys('acc1', SENDER)).toEqual([]);

    world.offline = false;
    expect(await getSenderKeys('acc1', SENDER)).toEqual([{ armoredKey: ARMORED }]);
    expect(world.lookups).toEqual([SENDER, SENDER]);
  });

  it('keeps an answered lookup, an empty one included, without asking again', async () => {
    // No keys is a genuine answer for an external sender: the common case.
    const external = 'news@example.net';
    expect(await getSenderKeys('acc1', external)).toEqual([]);
    expect(await getSenderKeys('acc1', external)).toEqual([]);
    expect(await getSenderKeys('acc1', SENDER)).toHaveLength(1);
    expect(await getSenderKeys('acc1', SENDER.toUpperCase())).toHaveLength(1);
    expect(world.lookups).toEqual([external, SENDER]);
  });
});
