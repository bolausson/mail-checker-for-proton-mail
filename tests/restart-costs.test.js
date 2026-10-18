/**
 * What a background cold start costs, and keeping it down.
 *
 * MV3 stops the background after ~30 s idle and the poll runs every minute, so
 * nearly every poll is a cold start: 286 of them in a real 6-hour log. Each one
 * re-fetched core/v4/users, core/v4/addresses and mail/v4/settings to unlock
 * the keys: 58% of every API call the extension made. Other wake-up work was
 * repeated the same way: the web ViewMode probe (its throttle lived in memory)
 * and the license-check alarm (re-created, so re-delayed, on every wake).
 *
 * The functions below are lifted from the real sources and run with stubs.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const ROOT = join(__dirname, '..');
const ACCOUNTS = readFileSync(join(ROOT, 'background', 'accounts.js'), 'utf-8');
const URLDET = readFileSync(join(ROOT, 'background', 'url-detection.js'), 'utf-8');
const PREMIUM = readFileSync(join(ROOT, 'background', 'premium.js'), 'utf-8');
const BACKGROUND = readFileSync(join(ROOT, 'background', 'background.js'), 'utf-8');

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

const clone = v => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));

function sessionStore() {
  const data = {};
  return {
    data,
    api: {
      get: async (k) => ({ [k]: clone(data[k]) }),
      set: async (o) => { for (const [k, v] of Object.entries(o)) data[k] = clone(v); },
      remove: async (k) => { delete data[k]; },
    },
  };
}

describe('the users/addresses copy in storage.session', () => {
  let store, account, api;
  const THIRTY_MIN = 30 * 60 * 1000;

  beforeEach(() => {
    store = sessionStore();
    account = { id: 'acc1', uid: 'uid-1' };
    const body = ['_readBootstrap', '_writeBootstrap', 'invalidateBootstrap']
      .map(n => lift(ACCOUNTS, n)).join('\n') +
      '\nreturn { _readBootstrap, _writeBootstrap, invalidateBootstrap };';
    api = new Function('browser', 'getAccount', '_bootstrapKey', '_KEYS_FRESH_FOR_MS', body)(
      { storage: { session: store.api } }, () => account, id => 'protonBootstrap:' + id, THIRTY_MIN);
  });

  it('serves what was written, for the same session', async () => {
    await api._writeBootstrap(account, { User: { ID: 'u' } }, { Addresses: [] }, Date.now());
    const got = await api._readBootstrap(account);
    expect(got.userResult.User.ID).toBe('u');
  });

  it('expires after the same 30 minutes the key set has', async () => {
    await api._writeBootstrap(account, { User: {} }, { Addresses: [] }, Date.now() - THIRTY_MIN - 1);
    expect(await api._readBootstrap(account)).toBe(null);
  });

  it('is ignored after a re-login (new UID)', async () => {
    await api._writeBootstrap(account, { User: {} }, { Addresses: [] }, Date.now());
    account.uid = 'uid-2';
    expect(await api._readBootstrap(account)).toBe(null);
  });

  it('is dropped by invalidateBootstrap, at once and in storage', async () => {
    await api._writeBootstrap(account, { User: {} }, { Addresses: [] }, Date.now());
    const pending = api.invalidateBootstrap('acc1');
    // Flagged synchronously: an unlock racing the storage write is refused.
    expect(await api._readBootstrap(account)).toBe(null);
    await pending;
    expect(store.data['protonBootstrap:acc1']).toBeUndefined();
  });

  it('rejects a copy dated in the future (a clock stepped back)', async () => {
    await api._writeBootstrap(account, { User: {} }, { Addresses: [] }, Date.now() + 60 * 60 * 1000);
    expect(await api._readBootstrap(account)).toBe(null);
  });

  it('keeps each account under its own key, so one write cannot undo another\'s removal', async () => {
    // A shared object read, changed and written back let account B's write
    // restore account A's copy that had just been dropped.
    const other = { id: 'acc2', uid: 'uid-9' };
    await api._writeBootstrap(account, { User: { ID: 'a' } }, { Addresses: [] }, Date.now());
    await Promise.all([
      api.invalidateBootstrap('acc1'),
      api._writeBootstrap(other, { User: { ID: 'b' } }, { Addresses: [] }, Date.now()),
    ]);
    expect(store.data['protonBootstrap:acc1']).toBeUndefined();
    expect(store.data['protonBootstrap:acc2'].userResult.User.ID).toBe('b');
  });

  it('keeps accounts apart', async () => {
    const other = { id: 'acc2', uid: 'uid-9' };
    await api._writeBootstrap(account, { User: { ID: 'a' } }, { Addresses: [] }, Date.now());
    await api._writeBootstrap(other, { User: { ID: 'b' } }, { Addresses: [] }, Date.now());
    expect((await api._readBootstrap(account)).userResult.User.ID).toBe('a');
    expect((await api._readBootstrap(other)).userResult.User.ID).toBe('b');
  });

  it('does nothing without storage.session', async () => {
    const bare = new Function('browser', 'getAccount', '_bootstrapKey', '_KEYS_FRESH_FOR_MS',
      lift(ACCOUNTS, '_readBootstrap') + '\nreturn _readBootstrap;')({ storage: {} }, () => account, id => 'k:' + id, THIRTY_MIN);
    expect(await bare(account)).toBe(null);
  });
});

describe('the unlock path uses it, and fetches ViewMode at most daily', () => {
  const fn = lift(ACCOUNTS, '_doUnlockKeys');
  const head = fn.slice(0, fn.indexOf('const user = userResult.User'));

  it('reads the copy before touching the API', () => {
    expect(head.indexOf('_readBootstrap(account)')).toBeLessThan(head.indexOf("'core/v4/users'"));
  });

  it('writes the copy after a real fetch', () => {
    expect(head).toMatch(/await _writeBootstrap\(account, userResult, addrResult, fetchedAt\)/);
  });

  it('fetches mail/v4/settings only when ViewMode is unknown or a day old', () => {
    expect(head).toMatch(/typeof account\.viewMode !== 'number' \|\| !\(vmAge < _VIEW_MODE_RECHECK_MS\)/);
    expect(ACCOUNTS).toMatch(/_VIEW_MODE_RECHECK_MS = 24 \* 60 \* 60 \* 1000/);
  });

  it('never overwrites a known ViewMode with unknown on a failed fetch', () => {
    const block = head.slice(head.indexOf("'mail/v4/settings'"));
    expect(block).toMatch(/if \(typeof account\.viewMode !== 'number'\) account\.viewMode = null;/);
  });

  it('persists ViewMode, but never as unknown', () => {
    const save = lift(ACCOUNTS, '_save');
    expect(save).toMatch(/viewMode: typeof a\.viewMode === 'number' \? a\.viewMode : null/);
  });

  it('persists the folder-edit counter, so a restart does not reset it', () => {
    // Reset to 0 on restart, a later edit could land on the value the stored
    // count carries and look like no edit at all.
    expect(lift(ACCOUNTS, '_save')).toMatch(/scopeGen: a\.scopeGen \|\| 0/);
  });

  it('no longer ties the web probe to the settings fetch', () => {
    expect(head).not.toMatch(/refreshWebViewModes\(\)/);
    expect(lift(ACCOUNTS, 'initSlow')).toMatch(/refreshWebViewModes\(\)\.catch/);
  });

  it('drops the copy when an unlock fails, so the retry refetches', () => {
    const unlock = lift(ACCOUNTS, 'unlockKeys');
    expect(unlock).toMatch(/catch \(err\) \{[\s\S]*invalidateBootstrap\(accountId\)[\s\S]*throw err;/);
  });

  it('drops it when the account is removed', () => {
    expect(lift(ACCOUNTS, 'removeAccount')).toMatch(/invalidateBootstrap\(id\)/);
  });
});

describe('what the event stream says about the account', () => {
  let account, saves, invalidated, note;
  beforeEach(() => {
    account = { id: 'acc1', email: 'u@x', viewMode: 0 };
    saves = 0; invalidated = [];
    note = new Function('getAccount', '_save', 'invalidateKeys', 'debugLog',
      lift(ACCOUNTS, 'noteAccountEvents') + '\nreturn noteAccountEvents;')(
      () => account, async () => { saves++; }, (id) => invalidated.push(id), () => {});
  });

  it('takes a new ViewMode from MailSettings and persists it', async () => {
    await note('acc1', { MailSettings: { ViewMode: 1 } });
    expect(account.viewMode).toBe(1);
    expect(saves).toBe(1);
  });

  it('does not save when ViewMode is unchanged', async () => {
    await note('acc1', { MailSettings: { ViewMode: 0 } });
    expect(saves).toBe(0);
  });

  it('re-reads keys after a User, Addresses or Refresh event, and says so', async () => {
    expect(await note('acc1', { User: {} })).toBe(true);
    expect(await note('acc1', { Addresses: [] })).toBe(true);
    expect(await note('acc1', { Refresh: 1 })).toBe(true);
    expect(await note('acc1', { Messages: [] })).toBe(false);
    expect(invalidated).toEqual(['acc1', 'acc1', 'acc1']);
  });
});

describe('the web ViewMode probe', () => {
  function makeProbe(store, {
    tabs = [{ id: 7 }], results = [{ result: [{ userId: 'u1', viewMode: 1 }] }], fails = false,
    accounts = [{ id: 'acc1', userId: 'u1', webViewMode: 0, email: 'u@x' }],
  } = {}) {
    const calls = { executeScript: 0 };
    const browser = {
      storage: { session: store.api },
      tabs: { query: async () => tabs },
      scripting: {
        executeScript: async () => { calls.executeScript++; if (fails) throw new Error('no access'); return results; },
      },
    };
    const body = 'let _webViewModeLastRun = 0;\n' + lift(ACCOUNTS, 'refreshWebViewModes') + '\nreturn refreshWebViewModes;';
    const probe = new Function('browser', '_accounts', '_save', 'debugLog',
      '_WEB_VIEW_MODE_PROBE_MS', '_WEB_VIEW_MODE_PROBE_KEY', body)(
      browser, accounts, async () => {}, () => {}, 10 * 60 * 1000, 'probeAt');
    return { probe, calls, accounts };
  }

  it('runs at most once per 10 minutes across worker restarts', async () => {
    const store = sessionStore();
    const w1 = makeProbe(store);
    await w1.probe();
    const w2 = makeProbe(store); // a fresh worker: in-memory stamp is 0
    await w2.probe();
    expect(w1.calls.executeScript).toBe(1);
    expect(w2.calls.executeScript).toBe(0);
  });

  it('is not throttled by an attempt that failed', async () => {
    const store = sessionStore();
    const failing = makeProbe(store, { fails: true });
    await failing.probe();
    const retry = makeProbe(store);
    await retry.probe();
    expect(retry.calls.executeScript).toBe(1);
    expect(retry.accounts[0].webViewMode).toBe(1);
  });

  it('is not forced on every wake by an account the tab cannot resolve', async () => {
    // Two accounts, the open Proton tab signed in to one: the other never gets
    // a web ViewMode. It used to skip the throttle on every wake, so the probe
    // ran on nearly every poll.
    const store = sessionStore();
    const accounts = () => [
      { id: 'acc1', userId: 'u1', webViewMode: 0, email: 'a@x' },
      { id: 'acc2', userId: 'u2', webViewMode: null, email: 'b@x' },
    ];
    const w1 = makeProbe(store, { accounts: accounts() });
    await w1.probe();
    const w2 = makeProbe(store, { accounts: accounts() });
    await w2.probe();
    expect(w1.calls.executeScript).toBe(1);
    expect(w2.calls.executeScript).toBe(0);
  });

  it('still probes at once for a newly added account', async () => {
    const store = sessionStore();
    await makeProbe(store).probe();
    const withNew = makeProbe(store, { accounts: [
      { id: 'acc1', userId: 'u1', webViewMode: 1, email: 'a@x' },
      { id: 'acc3', userId: 'u3', webViewMode: null, email: 'c@x' },
    ] });
    await withNew.probe();
    expect(withNew.calls.executeScript).toBe(1);
  });

  it('treats a probe that could not read the web app\'s version as a failure', async () => {
    const store = sessionStore();
    const failed = makeProbe(store, { results: [{ result: null }] });
    await failed.probe();
    expect(store.data.probeAt).toBeUndefined();
    // Not throttled in the same worker either.
    await failed.probe();
    expect(failed.calls.executeScript).toBe(2);
    const retry = makeProbe(store);
    await retry.probe();
    expect(retry.calls.executeScript).toBe(1);
  });

  it('looks again at an unresolved account when a Proton tab loads', async () => {
    const store = sessionStore();
    const accounts = () => [
      { id: 'acc1', userId: 'u1', webViewMode: 0, email: 'a@x' },
      { id: 'acc2', userId: 'u2', webViewMode: null, email: 'b@x' },
    ];
    await makeProbe(store, { accounts: accounts() }).probe();
    const onTabLoad = makeProbe(store, { accounts: accounts() });
    await onTabLoad.probe(false, { afterTabLoad: true });
    expect(onTabLoad.calls.executeScript).toBe(1);
  });

  it('is not throttled when no Proton tab was open', async () => {
    const store = sessionStore();
    await makeProbe(store, { tabs: [] }).probe();
    const later = makeProbe(store);
    await later.probe();
    expect(later.calls.executeScript).toBe(1);
  });
});

describe('the tab listener', () => {
  const body = lift(URLDET, 'addProtonTabListener') + '\nreturn addProtonTabListener;';

  it('is limited to Proton Mail tab loads where the browser can filter (Firefox)', () => {
    const added = [];
    const add = new Function('browser', body)({ tabs: { onUpdated: { addListener: (fn, filter) => added.push(filter) } } });
    add(() => {});
    expect(added).toEqual([{ urls: ['*://mail.proton.me/*'], properties: ['status'] }]);
  });

  it('falls back to the plain listener where a filter throws (Chrome)', () => {
    const added = [];
    const onUpdated = {
      addListener(fn, filter) {
        if (filter) throw new Error('This event does not support filters.');
        added.push('plain');
      },
    };
    const add = new Function('browser', body)({ tabs: { onUpdated } });
    add(() => {});
    expect(added).toEqual(['plain']);
  });

  it('is the one top-level listener, and it also re-checks the web ViewMode', () => {
    // A listener added in initUrlDetection, after the init awaits, missed the
    // very tab load that woke the page; the top-level one sees it.
    expect(URLDET).toMatch(/addProtonTabListener\(\(tabId, changeInfo, tab\) => \{\s*if \(changeInfo\.status !== 'complete'/);
    expect(URLDET).toMatch(/ProtonAccounts\.refreshWebViewModes\(false, \{ afterTabLoad: true \}\)/);
    expect(lift(ACCOUNTS, 'initUrlDetection')).not.toMatch(/onUpdated|addProtonTabListener/);
  });
});

describe('the license-check alarm', () => {
  const MIN = 60 * 1000;
  function make(existing) {
    const log = [];
    const created = [];
    const alarms = {
      get: async () => (existing ? { name: 'v' } : undefined),
      clear: async () => { log.push('clear'); },
      create: (name, info) => { log.push('create'); created.push(info); },
    };
    const fn = new Function('browser', 'VALIDATION_ALARM', 'MIN_CHECK_DELAY_MS', 'MAX_CHECK_DELAY_MS',
      lift(PREMIUM, '_scheduleNextValidation') + '\nreturn _scheduleNextValidation;')(
      { alarms }, 'v', MIN, 30 * 24 * 60 * MIN);
    return { fn, log, created };
  }

  it('is left alone when already pending (every wake calls this)', async () => {
    const { fn, log } = make(true);
    await fn(false, 5 * 60 * MIN);
    expect(log).toEqual([]);
  });

  it('is created when missing, at the delay the stamp gives', async () => {
    const { fn, log, created } = make(false);
    await fn(false, 5 * 60 * MIN);
    expect(log).toEqual(['clear', 'create']);
    expect(created[0].delayInMinutes).toBe(300);
  });

  it('is replaced after a check, at the new delay', async () => {
    const { fn, log, created } = make(true);
    await fn(true, 90 * MIN);
    expect(log).toEqual(['clear', 'create']);
    expect(created[0].delayInMinutes).toBe(90);
  });

  it('always gets a finite delay between 1 minute and 30 days', async () => {
    // An undefined delay must never reach alarms.create: the stamp decides
    // when the check is due, and the alarm has to wake it.
    const cases = [[NaN, 1], [undefined, 1], [-5, 1], [10, 1], [90 * 24 * 60 * MIN, 30 * 24 * 60]];
    for (const [delay, minutes] of cases) {
      const { fn, created } = make(false);
      await fn(true, delay);
      expect(Number.isFinite(created[0].delayInMinutes), String(delay)).toBe(true);
      expect(created[0].delayInMinutes, String(delay)).toBe(minutes);
    }
  });
});

describe('a license check at a time', () => {
  it('shares one in-flight validation between concurrent callers', async () => {
    let runs = 0;
    let release;
    const body = 'let _validateInFlight = null;\n' + lift(PREMIUM, 'validateLicense') + '\nreturn validateLicense;';
    const validate = new Function('_validateLicenseOnce', body)(() => {
      runs++;
      return new Promise(r => { release = r; });
    });
    const a = validate();
    const b = validate();
    release({ ok: true });
    expect(await a).toEqual({ ok: true });
    expect(await b).toEqual({ ok: true });
    expect(runs).toBe(1);
    // And a later call runs again.
    const c = validate();
    release({ ok: true });
    await c;
    expect(runs).toBe(2);
  });
});

describe('clearing the message cache', () => {
  it('leaves no cursor next to the emptied list', () => {
    // Otherwise the next poll resumes from the cursor, sees no change, and the
    // empty list and zero count stay until some count moves.
    const clear = lift(ACCOUNTS, 'clearMessageCache');
    expect(clear).toMatch(/a\.lastEventId = null;/);
    expect(clear).toMatch(/a\.listLimit = null;/);
    expect(clear).toMatch(/a\.countGen = null;/);
  });
});

describe('a start from the on-disk cache', () => {
  it('never keeps the cursor it restores', () => {
    // Saved before the browser closed, so hours old: resuming from it, even by
    // an alarm poll that beats the full load, would announce everything since.
    const restore = lift(ACCOUNTS, '_restoreSnapshot');
    const disk = restore.slice(restore.indexOf("_snapshotSource = 'disk'"));
    expect(disk).toMatch(/for \(const a of _accounts\) \{ a\.lastEventId = null; a\.countGen = null; \}/);
  });
});

describe('the background wiring', () => {
  it('starts on Firefox browser startup, where alarms do not survive', () => {
    // Firefox starts an event page at startup only if it has a runtime.onStartup
    // listener. Registered at top level, synchronously, like the others.
    expect(BACKGROUND).toMatch(/browser\.runtime\.onStartup\.addListener\(\(\) => \{\s*ensureInitialized\(\);/);
  });

  it('resumes on a snapshot wake instead of reloading everything', () => {
    expect(BACKGROUND).toMatch(/initSlow\(\)\s*\.then\(\(\) => ProtonPoller\.resume\(\)\)/);
    expect(BACKGROUND).not.toMatch(/initSlow\(\)\s*\.then\(\(\) => ProtonPoller\.initialLoad\(\)\)/);
  });

  it('does not push the poll back on every options edit', () => {
    const at = BACKGROUND.indexOf("case 'SETTINGS_CHANGED':");
    const block = BACKGROUND.slice(at, BACKGROUND.indexOf('return false;', at));
    expect(block).toMatch(/ProtonPoller\.start\(\)/);
    expect(block).not.toMatch(/ProtonPoller\.restart\(\)/);
    expect(block).toMatch(/ProtonPoller\.syncListLimit\(\)/);
  });

  it('polls after an import that changed the monitored folders', () => {
    const at = BACKGROUND.indexOf("case 'IMPORT_ACCOUNT_SETTINGS':");
    const block = BACKGROUND.slice(at, BACKGROUND.indexOf('return false;', at));
    expect(block).toMatch(/result\.scopeChanged\.length[\s\S]*ProtonPoller\.poll\(\)/);
  });
});
