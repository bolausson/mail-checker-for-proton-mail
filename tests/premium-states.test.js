/**
 * License states and check scheduling in background/premium.js.
 *
 * Every /validate answer the licence proxy can give (wire contract 3, and
 * every answer the contract-1 proxy gave, which a 1.14.x upgrade can still
 * meet) is run through activation and through a
 * check of a confirmed and an unconfirmed key. Then the rules around it: the
 * 1.14.7 upgrade, the check cadence and its stamp, the stale-result guard, the
 * follow-up after "Update payment", the nudge, held keys next to grace and
 * trial, the trial after a license, and the /txn-to-sub and /manage-url
 * answers.
 *
 * premium.js is a browser IIFE, evaluated here with its globals passed in, so
 * two instances can share one storage to stand for a worker that was stopped
 * and woke again. Only Date is faked: the code awaits real promises, and
 * AbortSignal.timeout keeps its real (unref'd) timer.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const SRC = readFileSync(join(__dirname, '..', 'background', 'premium.js'), 'utf-8');
// Loaded before premium.js in the background (manifest.json), as here.
const ProtonLicenseEntry = new Function(
  readFileSync(join(__dirname, '..', 'lib', 'license-entry.js'), 'utf-8') + '\nreturn ProtonLicenseEntry;')();

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const T0 = Date.parse('2026-09-23T12:00:00.000Z');
const ALARM = 'proton-premium-validate';
const LOCAL_ONLY = ['_licNextCheckAt', '_licFollowUpUntil', '_licFollowUpStep', '_licLastNudgeAt'];

// ULID-shaped (Crockford base32, first character 0-7), not real Paddle IDs.
const SUB_A = 'sub_01' + 'a'.repeat(24);
const SUB_B = 'sub_01' + 'b'.repeat(24);
const TXN_A = 'txn_01' + 'a'.repeat(24);
const iso = ms => new Date(ms).toISOString();
const clone = v => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));

// --- Harness ---

function makeArea(initial = {}) {
  const area = {
    data: clone(initial),
    async get(keys) {
      if (typeof keys === 'string') keys = [keys];
      const out = {};
      for (const k of keys) if (k in area.data) out[k] = clone(area.data[k]);
      return out;
    },
    async set(obj) { Object.assign(area.data, clone(obj)); },
    async remove(k) { delete area.data[k]; },
  };
  return area;
}

function makeAlarms() {
  const map = new Map();
  return {
    map,
    async get(name) { return map.get(name); },
    async clear(name) { return map.delete(name); },
    async create(name, info) {
      map.set(name, { name, delayInMinutes: info.delayInMinutes, scheduledTime: Date.now() + info.delayInMinutes * MIN });
    },
  };
}

const answer = (body, status = 200) => ({ status, json: async () => clone(body) });
const notJson = (status = 502) => ({ status, json: async () => { throw new SyntaxError('Unexpected token <'); } });
const networkError = () => { throw new TypeError('NetworkError when attempting to fetch resource.'); };
const hang = () => new Promise(() => {});
function deferred() {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return { promise, resolve };
}

function makeProxy() {
  const proxy = {
    calls: [],
    validate: () => answer(okBody()),
    txn: () => answer({ ok: true, subscription_id: SUB_B, status: 'active' }),
    manage: () => answer({ ok: true, update_payment_method: 'https://pay.example/update', cancel: 'https://pay.example/cancel' }),
    async fetch(url, opts) {
      const u = new URL(url);
      const call = {
        path: u.pathname,
        sub: u.searchParams.get('sub'),
        txn: u.searchParams.get('txn'),
        reason: u.searchParams.get('reason'),
        signal: opts && opts.signal,
        at: Date.now(),
      };
      proxy.calls.push(call);
      const handler = { '/validate': proxy.validate, '/txn-to-sub': proxy.txn, '/manage-url': proxy.manage }[u.pathname];
      return handler(call);
    },
  };
  return proxy;
}

/** A fresh premium.js instance over `env` (a new one, or a previous worker's). */
function boot({ local = {}, sync = {}, env } = {}) {
  const e = env || { local: makeArea(local), sync: makeArea(sync), alarms: makeAlarms(), proxy: makeProxy() };
  if (!e.timeouts) e.timeouts = [];
  if (!e.logs) e.logs = [];
  const browser = {
    storage: { local: e.local, sync: e.sync },
    alarms: e.alarms,
    tabs: { create: async () => ({}) },
  };
  // The real AbortSignal, with every timeout it is asked for recorded.
  const abortSignal = { timeout: (ms) => { e.timeouts.push(ms); return AbortSignal.timeout(ms); } };
  // Every debugLog line, as the arguments it was given.
  const debugLog = (...args) => { e.logs.push(args); };
  const P = new Function('browser', 'fetch', 'debugLog', 'AbortSignal', 'ProtonLicenseEntry', SRC + '\nreturn ProtonPremium;')(
    browser, (url, opts) => e.proxy.fetch(url, opts), debugLog, abortSignal, ProtonLicenseEntry);
  return { P, env: e, local: e.local, sync: e.sync, alarms: e.alarms, proxy: e.proxy };
}

// setImmediate, not setTimeout(0): Windows timers tick every ~15 ms.
const settle = async () => { for (let i = 0; i < 6; i++) await new Promise(r => setImmediate(r)); };

async function start(opts) {
  const w = boot(opts);
  await w.P.init();
  await settle();
  return w;
}

const validateCalls = w => w.proxy.calls.filter(c => c.path === '/validate');
const alarmAt = w => (w.alarms.map.get(ALARM) || {}).scheduledTime ?? null;
const stampOf = w => w.local.data._licNextCheckAt;
const at = ms => vi.setSystemTime(ms);
const fire = async (w, name = ALARM) => { await w.P.handleAlarm({ name }); await settle(); };

// --- Proxy answers ---

function fields(over = {}) {
  return {
    status: 'active',
    next_billed_at: iso(T0 + 20 * DAY),
    billing_interval: 'month',
    current_period_starts_at: iso(T0 - 10 * DAY),
    current_period_ends_at: iso(T0 + 20 * DAY),
    scheduled_change: null,
    ...over,
  };
}
function okBody(over = {}) { return { ok: true, valid: true, ...fields(over) }; }

// The /validate answers, named for contract 2, which introduced them.
const V2 = {
  active: () => answer(okBody()),
  trialing: () => answer(okBody({ status: 'trialing' })),
  pastDuePaid: () => answer({ ...okBody({ status: 'past_due' }), ever_paid: true }),
  unpaid: () => answer({ ok: false, error: 'subscription_unpaid', ...fields({ status: 'past_due' }), ever_paid: false }),
  paused: () => answer({ ok: false, error: 'subscription_paused', ...fields({ status: 'paused', next_billed_at: null }) }),
  canceled: () => answer({ ok: false, error: 'subscription_canceled', ...fields({ status: 'canceled', next_billed_at: null }) }),
  notFound: () => answer({ ok: false, error: 'subscription_not_found' }),
  wrongProduct: () => answer({ ok: false, error: 'subscription_wrong_product' }),
  invalid: () => answer({ ok: false, error: 'invalid_request' }, 400),
  serverError: () => answer({ ok: false, error: 'paddle_server_error', detail: 'unconfirmed' }, 502),
  unreachable: () => answer({ ok: false, error: 'paddle_unreachable' }, 502),
};

// The contract-1 proxy: no valid, ever_paid or scheduled_change; the old codes.
const v1Fields = { next_billed_at: iso(T0 + 20 * DAY), billing_interval: 'month',
  current_period_starts_at: iso(T0 - 10 * DAY), current_period_ends_at: iso(T0 + 20 * DAY) };
const V1 = {
  active: () => answer({ ok: true, status: 'active', ...v1Fields }),
  pastDueNeverPaid: () => answer({ ok: true, status: 'past_due', ...v1Fields }),
  inactive: () => answer({ ok: false, error: 'subscription_inactive', status: 'unknown' }),
  expired: () => answer({ ok: false, error: 'subscription_expired', status: 'expired' }),
  scheduledCancel: () => answer({ ok: false, error: 'subscription_scheduled_cancel', status: 'active' }),
  paused: () => answer({ ok: false, error: 'subscription_paused', status: 'paused' }),
  canceled: () => answer({ ok: false, error: 'subscription_canceled', status: 'canceled' }),
  notFound: () => answer({ ok: false, error: 'subscription_not_found' }),
  wrongProduct: () => answer({ ok: false, error: 'subscription_wrong_product' }),
  paddle401: () => answer({ ok: false, error: 'paddle_server_error' }, 401),
  internal: () => answer({ ok: false, error: 'internal_error', message: 'boom' }, 500),
  unknownPath: () => answer({ ok: false, error: 'not_found' }, 404),
};

// --- Stored states ---

function confirmedState(over = {}) {
  return {
    _premiumKey: SUB_A, _trialEnd: 0,
    _licLastValidatedAt: T0 - 5 * DAY, _licFirstFailedAt: 0, _licLastError: null, _licLastStatus: 'active',
    _licBillingInterval: 'month', _licPeriodStart: iso(T0 - 10 * DAY), _licPeriodEnd: iso(T0 + 20 * DAY),
    _licNextBilledAt: iso(T0 + 20 * DAY), _licScheduledChange: null, _licCleared: 0,
    _licConfirmedKey: SUB_A, _licEverLicensed: T0 - 40 * DAY,
    _licNextCheckAt: T0 + 10 * DAY, _licFollowUpUntil: 0, _licFollowUpStep: 0, _licLastNudgeAt: 0,
    ...over,
  };
}
function unconfirmedState(over = {}) {
  return confirmedState({
    _licLastValidatedAt: 0, _licLastStatus: null, _licFirstFailedAt: T0 - HOUR, _licLastError: 'proxy_unreachable',
    _licBillingInterval: null, _licPeriodStart: null, _licPeriodEnd: null, _licNextBilledAt: null,
    _licConfirmedKey: null, _licEverLicensed: 0,
    ...over,
  });
}
function heldState(over = {}) {
  return confirmedState({
    _licLastError: 'subscription_unpaid', _licLastStatus: 'past_due', _licNextCheckAt: T0 + 20 * HOUR,
    ...over,
  });
}

// Exactly the keys 1.14.7 wrote: nothing of the new ones.
const OLD_ACTIVE = {
  _premiumKey: SUB_A, _trialEnd: 0,
  _licLastValidatedAt: T0 - 10 * DAY, _licFirstFailedAt: 0, _licLastError: null, _licLastStatus: 'active',
  _licBillingInterval: 'month', _licPeriodStart: iso(T0 - 10 * DAY), _licPeriodEnd: iso(T0 + 20 * DAY),
  _licCleared: 0,
};

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  at(T0);
});
afterEach(() => {
  vi.useRealTimers();
});

// --- The answer table ---

function expectOutcome(w, outcome, { code, confirmed, res } = {}) {
  const s = w.P.getStatus();
  switch (outcome) {
    case 'ok':
    case 'pastDue':
      if (res) expect(res).toEqual({ success: true });
      expect(s.premium).toBe(true);
      expect(s.licensed).toBe(true);
      expect(s.held).toBe(null);
      expect(s.pastDue).toBe(outcome === 'pastDue');
      expect(s.inGracePeriod).toBe(false);
      expect(w.local.data._licConfirmedKey).toBe(SUB_A);
      expect(w.local.data._licEverLicensed).toBeGreaterThan(0);
      expect(s.lastValidatedAt).toBe(T0);
      break;
    case 'unpaid':
    case 'paused':
      if (res) expect(res).toEqual({ success: true, held: outcome });
      expect(s.keyStored).toBe(true);
      expect(s.held).toBe(outcome);
      expect(s.premium).toBe(false);
      expect(s.licensed).toBe(false);
      expect(s.locked).toBe(false);
      expect(s.inGracePeriod).toBe(false);
      expect(s.pastDue).toBe(false);
      expect(w.local.data._licConfirmedKey).toBe(SUB_A);
      expect(w.local.data._licEverLicensed).toBeGreaterThan(0);
      expect(w.local.data._licFirstFailedAt).toBe(0);
      expect(s.lastValidatedAt).toBe(T0);
      break;
    case 'refused':
      expect(res).toEqual({ error: code });
      expect(s.keyStored).toBe(false);
      expect(w.local.data._premiumKey).toBeUndefined();
      expect(w.alarms.map.has(ALARM)).toBe(false);
      break;
    case 'refusedKeepsKey':
      expect(res).toEqual({ error: code });
      expect(s.keyStored).toBe(true);
      expect(w.local.data._licConfirmedKey).toBe(SUB_A);
      break;
    case 'deleted':
      expect(s.keyStored).toBe(false);
      expect(s.premium).toBe(false);
      expect(s.clearedReason).toBe(code);
      expect(w.local.data._premiumKey).toBe(null);
      expect(w.local.data._licCleared).toBe(T0);
      expect(w.local.data._licNextCheckAt).toBe(0);
      expect(w.alarms.map.has(ALARM)).toBe(false);
      break;
    case 'transient':
      if (res) expect(res.success).toBe(true);
      if (res) expect(typeof res.warning).toBe('string');
      expect(s.keyStored).toBe(true);
      expect(s.held).toBe(null);
      expect(s.premium).toBe(true);
      expect(s.inGracePeriod).toBe(true);
      expect(s.graceRemainingDays).toBe(confirmed ? 30 : 3);
      expect(w.local.data._licConfirmedKey === SUB_A).toBe(!!confirmed);
      break;
    default:
      throw new Error('unknown outcome ' + outcome);
  }
}

// [answer, respond, activation, check of a confirmed key, check of an unconfirmed key]
const TABLE = [
  ['v2 active', V2.active, 'ok', 'ok', 'ok'],
  ['v2 trialing', V2.trialing, 'ok', 'ok', 'ok'],
  ['v2 past_due, paid before', V2.pastDuePaid, 'pastDue', 'pastDue', 'pastDue'],
  ['v2 subscription_unpaid', V2.unpaid, 'unpaid', 'unpaid', 'unpaid'],
  ['v2 subscription_paused', V2.paused, 'paused', 'paused', 'paused'],
  ['v2 subscription_canceled', V2.canceled, 'refused', 'deleted', 'deleted'],
  ['v2 subscription_not_found', V2.notFound, 'refused', 'transient', 'deleted'],
  ['v2 subscription_wrong_product', V2.wrongProduct, 'refused', 'transient', 'deleted'],
  ['v2 invalid_request (400)', V2.invalid, 'refused', 'transient', 'deleted'],
  ['v2 paddle_server_error (502)', V2.serverError, 'transient', 'transient', 'transient'],
  ['v2 paddle_unreachable (502)', V2.unreachable, 'transient', 'transient', 'transient'],
  ['a refusal code at HTTP 5xx', () => answer({ ok: false, error: 'subscription_canceled' }, 502), 'transient', 'transient', 'transient'],
  ['a hold code at HTTP 5xx', () => answer({ ok: false, error: 'subscription_unpaid' }, 503), 'transient', 'transient', 'transient'],
  ['v1 active', V1.active, 'ok', 'ok', 'ok'],
  ['v1 ok past_due that never paid', V1.pastDueNeverPaid, 'pastDue', 'pastDue', 'pastDue'],
  ['v1 subscription_inactive', V1.inactive, 'refused', 'transient', 'deleted'],
  ['v1 subscription_expired', V1.expired, 'refused', 'transient', 'deleted'],
  ['v1 subscription_scheduled_cancel', V1.scheduledCancel, 'refused', 'transient', 'deleted'],
  ['v1 subscription_paused', V1.paused, 'paused', 'paused', 'paused'],
  ['v1 subscription_canceled', V1.canceled, 'refused', 'deleted', 'deleted'],
  ['v1 subscription_not_found', V1.notFound, 'refused', 'transient', 'deleted'],
  ['v1 subscription_wrong_product', V1.wrongProduct, 'refused', 'transient', 'deleted'],
  ['v1 paddle_server_error at 401', V1.paddle401, 'transient', 'transient', 'transient'],
  ['v1 internal_error (500)', V1.internal, 'transient', 'transient', 'transient'],
  ['v1 unknown path (404 not_found)', V1.unknownPath, 'transient', 'transient', 'transient'],
  ['a body that is not JSON', () => notJson(502), 'transient', 'transient', 'transient'],
  ['a JSON null body', () => answer(null), 'transient', 'transient', 'transient'],
  ['a JSON array body', () => answer([]), 'transient', 'transient', 'transient'],
  ['a JSON string body', () => answer('ok'), 'transient', 'transient', 'transient'],
  ['ok:false with a null error', () => answer({ ok: false, error: null }), 'transient', 'transient', 'transient'],
  ['a network error', networkError, 'transient', 'transient', 'transient'],
];

const codeOf = async (respond) => {
  try {
    const r = await respond({});
    const body = await r.json();
    return body && body.error;
  } catch (_) { return undefined; }
};

describe('every proxy answer, on activation', () => {
  it.each(TABLE)('%s', async (_name, respond, outcome) => {
    const w = await start();
    w.proxy.validate = respond;
    const res = await w.P.setLicenseKey(SUB_A);
    await settle();
    expect(validateCalls(w).map(c => c.reason)).toEqual(['activation']);
    expectOutcome(w, outcome, { res, code: await codeOf(respond), confirmed: false });
  });

  it.each(TABLE)('%s, re-entering the stored confirmed key', async (_name, respond, outcome) => {
    const w = await start({ local: confirmedState() });
    w.proxy.validate = respond;
    const res = await w.P.setLicenseKey(SUB_A);
    await settle();
    const expected = outcome === 'refused' ? 'refusedKeepsKey' : outcome;
    expectOutcome(w, expected, { res, code: await codeOf(respond), confirmed: true });
  });
});

describe('every proxy answer, on a check', () => {
  it.each(TABLE)('%s, confirmed key', async (_name, respond, _act, outcome) => {
    const w = await start({ local: confirmedState() });
    expect(validateCalls(w)).toHaveLength(0); // not due yet
    w.proxy.validate = respond;
    await w.P.validateLicense();
    await settle();
    expect(validateCalls(w).map(c => c.reason)).toEqual(['refresh']);
    expectOutcome(w, outcome, { code: await codeOf(respond), confirmed: true });
  });

  it.each(TABLE)('%s, unconfirmed key', async (_name, respond, _act, _conf, outcome) => {
    const w = await start({ local: unconfirmedState() });
    w.proxy.validate = respond;
    await w.P.validateLicense();
    await settle();
    // Until Paddle has answered for the key, every check is an activation, so
    // the proxy still refuses a wrong key.
    expect(validateCalls(w).map(c => c.reason)).toEqual(['activation']);
    expectOutcome(w, outcome, { code: await codeOf(respond), confirmed: false });
  });

  it('asks as a refresh once the key has had an answer', async () => {
    const w = await start({ local: unconfirmedState() });
    await w.P.validateLicense();
    at(T0 + DAY);
    await w.P.validateLicense();
    expect(validateCalls(w).map(c => c.reason)).toEqual(['activation', 'refresh']);
  });
});

// --- Upgrade from 1.14.7 ---

describe('upgrading from 1.14.7 (only the old storage keys)', () => {
  it('an active user: confirmed, checked once right away as a refresh', async () => {
    const w = await start({ local: OLD_ACTIVE });
    expect(validateCalls(w).map(c => c.reason)).toEqual(['refresh']);
    expect(w.local.data._licConfirmedKey).toBe(SUB_A);
    expect(w.local.data._licEverLicensed).toBe(T0 - 10 * DAY);
    expect(w.P.getStatus().trialAvailable).toBe(false);
    expect(w.P.getStatus().premium).toBe(true);
    // And then not again until the cadence says so.
    expect(alarmAt(w)).toBe(T0 + 20 * DAY + HOUR);
    const again = boot({ env: w.env });
    at(T0 + 5 * MIN);
    await again.P.init();
    await settle();
    expect(validateCalls(w)).toHaveLength(1);
  });

  it('a user 10 days into a failure streak keeps the 30-day grace', async () => {
    const local = { ...OLD_ACTIVE, _licLastValidatedAt: T0 - 40 * DAY,
      _licFirstFailedAt: T0 - 10 * DAY, _licLastError: 'proxy_unreachable' };
    const w = boot({ local });
    w.proxy.validate = hang;
    await w.P.init();
    await settle();
    const s = w.P.getStatus();
    expect(s.premium).toBe(true);
    expect(s.inGracePeriod).toBe(true);
    expect(s.graceRemainingDays).toBe(20);
    expect(validateCalls(w).map(c => c.reason)).toEqual(['refresh']);
  });

  it('a user 10 days into a streak whose check fails again retries in 6 h, streak kept', async () => {
    const local = { ...OLD_ACTIVE, _licLastValidatedAt: T0 - 40 * DAY,
      _licFirstFailedAt: T0 - 10 * DAY, _licLastError: 'proxy_unreachable' };
    const w = boot({ local });
    w.proxy.validate = V2.unreachable;
    await w.P.init();
    await settle();
    expect(w.local.data._licFirstFailedAt).toBe(T0 - 10 * DAY);
    expect(alarmAt(w)).toBe(T0 + 6 * HOUR);
    expect(stampOf(w)).toBe(T0 + 6 * HOUR);
  });

  it('a key stored offline (never answered) is unconfirmed: 3-day grace, then an activation check', async () => {
    const local = { ...OLD_ACTIVE, _licLastValidatedAt: 0, _licLastStatus: null,
      _licBillingInterval: null, _licPeriodStart: null, _licPeriodEnd: null,
      _licFirstFailedAt: T0 - 5 * DAY, _licLastError: 'proxy_unreachable' };
    const pending = boot({ local });
    pending.proxy.validate = hang;
    await pending.P.init();
    await settle();
    expect(pending.P.getStatus().locked).toBe(true);
    expect(pending.P.getStatus().premium).toBe(false);
    expect(pending.local.data._licConfirmedKey).toBeUndefined();
    expect(pending.local.data._licEverLicensed).toBeUndefined();

    const w = await start({ local });
    expect(validateCalls(w).map(c => c.reason)).toEqual(['activation']);
    expect(w.P.getStatus().premium).toBe(true);
    expect(w.local.data._licConfirmedKey).toBe(SUB_A);
  });

  it('a trial-only user: no check, no license history, no second trial', async () => {
    const local = { _premiumKey: null, _trialEnd: T0 + 5 * DAY, _licLastValidatedAt: 0, _licFirstFailedAt: 0,
      _licLastError: null, _licLastStatus: null, _licBillingInterval: null, _licPeriodStart: null,
      _licPeriodEnd: null, _licCleared: 0 };
    const w = await start({ local });
    expect(w.proxy.calls).toHaveLength(0);
    const s = w.P.getStatus();
    expect(s.trialing).toBe(true);
    expect(s.trialActive).toBe(true);
    expect(s.trialAvailable).toBe(false);
    expect(w.local.data._licEverLicensed).toBeUndefined();
  });

  it('a legacy not_found on the first check keeps a confirmed key', async () => {
    const w = boot({ local: OLD_ACTIVE });
    w.proxy.validate = V1.notFound;
    await w.P.init();
    await settle();
    const s = w.P.getStatus();
    expect(s.keyStored).toBe(true);
    expect(s.premium).toBe(true);
    expect(s.inGracePeriod).toBe(true);
    expect(s.lastValidationError).toBe('subscription_not_found');
    expect(w.local.data._premiumKey).toBe(SUB_A);
  });

  it('a user whose 1.14.x check got subscription_unpaid (grace there) is held here', async () => {
    const local = { ...OLD_ACTIVE, _licLastStatus: 'past_due', _licFirstFailedAt: T0 - 2 * DAY,
      _licLastError: 'subscription_unpaid' };
    const w = boot({ local });
    w.proxy.validate = hang;
    await w.P.init();
    const s = w.P.getStatus();
    expect(s.held).toBe('unpaid');
    expect(s.premium).toBe(false);
    expect(s.inGracePeriod).toBe(false);
    await settle();
    expect(validateCalls(w).map(c => c.reason)).toEqual(['refresh']);
  });
});

describe('the upgrade backfill', () => {
  const cleared = (reason) => ({ _premiumKey: null, _trialEnd: 0, _licLastValidatedAt: 0, _licFirstFailedAt: 0,
    _licLastError: reason, _licLastStatus: null, _licBillingInterval: null, _licPeriodStart: null,
    _licPeriodEnd: null, _licCleared: T0 - 3 * DAY });

  it.each(['subscription_canceled', 'subscription_paused', 'subscription_expired',
    'subscription_inactive', 'subscription_scheduled_cancel'])(
    'a key cleared by %s was a license: no trial', async (reason) => {
      const w = await start({ local: cleared(reason) });
      expect(w.P.getStatus().trialAvailable).toBe(false);
      expect(w.local.data._licEverLicensed).toBe(T0 - 3 * DAY);
      expect(w.P.getStatus().clearedReason).toBe(reason);
    });

  it.each(['subscription_not_found', 'subscription_wrong_product'])(
    'a key cleared by %s never was: the trial stays available', async (reason) => {
      const w = await start({ local: cleared(reason) });
      expect(w.P.getStatus().trialAvailable).toBe(true);
      expect(w.local.data._licEverLicensed).toBeUndefined();
    });

  it('writes only the history for a device without a key, never storage.sync', async () => {
    const w = await start({ local: { ...cleared('subscription_canceled'), syncEnabled: true },
      sync: { _premiumKey: null, _licCleared: T0 - 3 * DAY } });
    expect(w.local.data._licEverLicensed).toBe(T0 - 3 * DAY);
    expect(w.sync.data).toEqual({ _premiumKey: null, _licCleared: T0 - 3 * DAY });
  });

  it('a last status without a validation time still counts as an answer', async () => {
    const w = boot({ local: { ...OLD_ACTIVE, _licLastValidatedAt: 0 } });
    w.proxy.validate = hang;
    await w.P.init();
    await settle();
    expect(w.local.data._licConfirmedKey).toBe(SUB_A);
    expect(w.local.data._licEverLicensed).toBe(T0);
    expect(validateCalls(w)[0].reason).toBe('refresh');
  });

  it('a key adopted from a 1.14.x device\'s sync data is confirmed from its validation time', async () => {
    // The adoption zeroes _lastValidatedAt, so the backfill must run first.
    const w = boot({ sync: { ...OLD_ACTIVE, _licLastStatus: null } });
    w.proxy.validate = hang;
    await w.P.init();
    await settle();
    expect(w.local.data._premiumKey).toBe(SUB_A);
    expect(w.local.data._licConfirmedKey).toBe(SUB_A);
    expect(w.local.data._licEverLicensed).toBe(T0 - 10 * DAY);
    expect(validateCalls(w).map(c => c.reason)).toEqual(['refresh']);
  });

  it('never overwrites a confirmed key that is already stored, even a stale one', async () => {
    // A 1.14.x device changed the synced key; the confirmed key is another one.
    const w = boot({ sync: { ...OLD_ACTIVE, _premiumKey: SUB_B, _licConfirmedKey: SUB_A } });
    w.proxy.validate = hang;
    await w.P.init();
    await settle();
    expect(w.local.data._premiumKey).toBe(SUB_B);
    expect(w.local.data._licConfirmedKey).toBe(SUB_A);
    expect(validateCalls(w).map(c => [c.sub, c.reason])).toEqual([[SUB_B, 'activation']]);
  });

  it('a synced tombstone from 1.14.x after a cancel: nothing adopted, and no trial', async () => {
    const w = await start({ sync: { _premiumKey: null, _licCleared: T0 - DAY, _licLastError: 'subscription_canceled',
      _trialEnd: 0 } });
    expect(w.P.getStatus().keyStored).toBe(false);
    expect(w.P.getStatus().trialAvailable).toBe(false);
    expect(w.proxy.calls).toHaveLength(0);
  });

  it('a synced tombstone keeps the synced trial and license history', async () => {
    const w = await start({ sync: { _premiumKey: null, _licCleared: T0 - DAY, _trialEnd: T0 - 30 * DAY,
      _licEverLicensed: T0 - 60 * DAY, _licLastValidatedAt: T0 - 2 * DAY } });
    const s = w.P.getStatus();
    expect(s.trialAvailable).toBe(false);
    expect(s.trialExpired).toBe(true);
    expect(s.lastValidatedAt).toBe(null);
  });

  it('a synced tombstone of a removed license, trial never used: the license history alone refuses the trial', async () => {
    // A removal leaves no reason and the trial was never started, so only the
    // synced _licEverLicensed tells this device there was a license.
    const w = await start({ sync: { _premiumKey: null, _licCleared: T0 - DAY, _licLastError: null, _trialEnd: 0,
      _licEverLicensed: T0 - 60 * DAY } });
    expect(w.P.getStatus().trialAvailable).toBe(false);
    expect(await w.P.startTrial()).toEqual({ error: 'trial_unavailable' });
  });
});

// --- Cadence ---

describe('when the next check is', () => {
  async function activate(body, local) {
    const w = await start({ local });
    w.proxy.validate = typeof body === 'function' ? body : () => answer(body);
    await w.P.setLicenseKey(SUB_A);
    await settle();
    expect(stampOf(w)).toBe(alarmAt(w)); // the stamp and the alarm agree
    return w;
  }

  it('a scheduled change comes first', async () => {
    const w = await activate(okBody({ scheduled_change: { action: 'cancel', effective_at: iso(T0 + 5 * DAY) },
      next_billed_at: iso(T0 + 20 * DAY) }));
    expect(alarmAt(w)).toBe(T0 + 5 * DAY + HOUR);
    expect(w.P.getStatus().scheduledChange).toEqual({ action: 'cancel', effective_at: iso(T0 + 5 * DAY) });
    expect(w.local.data._licScheduledChange).toEqual({ action: 'cancel', effective_at: iso(T0 + 5 * DAY) });
  });

  it('then the next billing date', async () => {
    const w = await activate(okBody({ next_billed_at: iso(T0 + 12 * DAY), current_period_ends_at: iso(T0 + 3 * DAY) }));
    expect(alarmAt(w)).toBe(T0 + 12 * DAY + HOUR);
    expect(w.P.getStatus().nextBilledAt).toBe(iso(T0 + 12 * DAY));
    expect(w.local.data._licNextBilledAt).toBe(iso(T0 + 12 * DAY));
  });

  it('then the raw period end', async () => {
    const w = await activate(okBody({ next_billed_at: null, current_period_ends_at: iso(T0 + 9 * DAY) }));
    expect(alarmAt(w)).toBe(T0 + 9 * DAY + HOUR);
  });

  it('a Paddle trial: its raw end, never the period projected for display', async () => {
    const w = await activate(okBody({ status: 'trialing', billing_interval: 'year', next_billed_at: null,
      current_period_starts_at: iso(T0 - DAY), current_period_ends_at: iso(T0 + 6 * DAY) }));
    expect(alarmAt(w)).toBe(T0 + 6 * DAY + HOUR);
    // The options page still shows the yearly cycle.
    expect(Date.parse(w.P.getStatus().periodEnd)).toBeGreaterThan(T0 + 300 * DAY);
  });

  it('at most 30 days away', async () => {
    const w = await activate(okBody({ next_billed_at: iso(T0 + 200 * DAY) }));
    expect(alarmAt(w)).toBe(T0 + 30 * DAY);
  });

  it('at least an hour away', async () => {
    const w = await activate(okBody({ next_billed_at: iso(T0 + 10 * MIN) }));
    expect(alarmAt(w)).toBe(T0 + 70 * MIN);
  });

  it.each([
    ['a past anchor', { next_billed_at: iso(T0 - HOUR) }],
    ['an unparseable anchor', { next_billed_at: 'next Tuesday' }],
    ['a scheduled change with an unparseable date', { scheduled_change: { action: 'cancel', effective_at: 'soon' } }],
    ['no anchor at all', { next_billed_at: null, current_period_ends_at: null }],
  ])('a day for %s', async (_name, over) => {
    const w = await activate(okBody(over));
    expect(alarmAt(w)).toBe(T0 + DAY);
  });

  it.each([
    ['past_due', () => answer({ ...okBody({ status: 'past_due' }), ever_paid: true })],
    ['unpaid', V2.unpaid],
    ['paused', V2.paused],
  ])('daily while %s', async (_name, respond) => {
    const w = await activate(respond);
    expect(alarmAt(w)).toBe(T0 + DAY);
  });

  it('an hour after a transient failure, then 6 h once the streak is a day old', async () => {
    const w = await activate(V2.unreachable);
    expect(alarmAt(w)).toBe(T0 + HOUR);
    at(T0 + HOUR);
    await fire(w);
    expect(alarmAt(w)).toBe(T0 + 2 * HOUR);
    at(T0 + DAY + 5 * MIN);
    await fire(w);
    expect(alarmAt(w)).toBe(T0 + DAY + 5 * MIN + 6 * HOUR);
    expect(w.local.data._licFirstFailedAt).toBe(T0);
  });

  it('replaces the alarm that was pending', async () => {
    const w = await start({ local: confirmedState({ _licNextCheckAt: T0 + 29 * DAY }) });
    expect(alarmAt(w)).toBe(T0 + 29 * DAY);
    w.proxy.validate = () => answer(okBody({ next_billed_at: iso(T0 + 3 * DAY) }));
    await w.P.validateLicense();
    await settle();
    expect(w.alarms.map.size).toBe(1);
    expect(alarmAt(w)).toBe(T0 + 3 * DAY + HOUR);
    expect(stampOf(w)).toBe(T0 + 3 * DAY + HOUR);
  });
});

// --- The stamp before the request ---

describe('the stamp written before the request', () => {
  it('a hung request: the next wake does not fetch again', async () => {
    const w = boot({ local: confirmedState({ _licNextCheckAt: 0 }) });
    w.proxy.validate = hang;
    await w.P.init();
    await settle();
    expect(validateCalls(w)).toHaveLength(1);
    expect(stampOf(w)).toBe(T0 + HOUR);
    expect(alarmAt(w)).toBe(T0 + HOUR);

    // The worker is stopped mid-request and woken again 5 minutes later.
    at(T0 + 5 * MIN);
    const woken = boot({ env: w.env });
    woken.proxy.validate = V2.active;
    await woken.P.init();
    await settle();
    expect(validateCalls(w)).toHaveLength(1);
    // An early alarm re-arms to the stamp instead of fetching.
    await fire(woken);
    expect(validateCalls(w)).toHaveLength(1);
    expect(alarmAt(w)).toBe(T0 + HOUR);
    // At the stamp, it checks.
    at(T0 + HOUR);
    await fire(woken);
    expect(validateCalls(w)).toHaveLength(2);
  });

  it('a null body: transient, and the next wake does not fetch again', async () => {
    const w = boot({ local: confirmedState({ _licNextCheckAt: 0 }) });
    w.proxy.validate = () => answer(null);
    await w.P.init();
    await settle();
    expect(validateCalls(w)).toHaveLength(1);
    expect(w.P.getStatus().inGracePeriod).toBe(true);
    at(T0 + MIN);
    const woken = boot({ env: w.env });
    await woken.P.init();
    await settle();
    expect(validateCalls(w)).toHaveLength(1);
  });

  it('is written before the request goes out', async () => {
    const w = await start({ local: confirmedState() });
    let seen;
    w.proxy.validate = () => { seen = w.local.data._licNextCheckAt; return V2.active(); };
    await w.P.validateLicense();
    expect(seen).toBe(T0 + HOUR);
  });

  it('every request carries a timeout signal', async () => {
    const w = await start({ local: heldState() });
    await w.P.getManageUrls();
    await w.P.validateLicense();
    const fresh = await start();
    await fresh.P.setLicenseKey(TXN_A);
    const calls = [...w.proxy.calls, ...fresh.proxy.calls];
    expect(calls.map(c => c.path).sort()).toEqual(['/manage-url', '/txn-to-sub', '/validate', '/validate']);
    for (const c of calls) expect(c.signal, c.path).toBeInstanceOf(AbortSignal);
    // Under Chrome's 30 s limit for a fetch in a service worker: past that the
    // worker can be stopped mid-request.
    const timeouts = [...w.env.timeouts, ...fresh.env.timeouts];
    expect(timeouts).toHaveLength(calls.length);
    for (const ms of timeouts) {
      expect(ms).toBeGreaterThan(0);
      expect(ms).toBeLessThan(30000);
    }
  });
});

describe('the alarm and init', () => {
  it('handleAlarm after init validated sends no second request', async () => {
    const w = await start({ local: OLD_ACTIVE });
    expect(validateCalls(w)).toHaveLength(1);
    await fire(w);
    expect(validateCalls(w)).toHaveLength(1);
    expect(alarmAt(w)).toBe(stampOf(w));
  });

  it('an alarm while init\'s check is still in flight sends no second request', async () => {
    const d = deferred();
    const w = boot({ local: OLD_ACTIVE });
    w.proxy.validate = () => d.promise;
    await w.P.init();
    await settle();
    await fire(w);
    expect(validateCalls(w)).toHaveLength(1);
    d.resolve(V2.active());
    await settle();
    expect(alarmAt(w)).toBe(T0 + 20 * DAY + HOUR);
  });

  it('re-arms a missing alarm from the stamp (Firefox loses alarms on restart)', async () => {
    const w = await start({ local: confirmedState({ _licNextCheckAt: T0 + 5 * HOUR }) });
    expect(validateCalls(w)).toHaveLength(0);
    expect(alarmAt(w)).toBe(T0 + 5 * HOUR);
  });

  it('leaves a pending alarm alone', async () => {
    const env = { local: makeArea(confirmedState({ _licNextCheckAt: T0 + 5 * HOUR })), sync: makeArea(),
      alarms: makeAlarms(), proxy: makeProxy() };
    env.alarms.map.set(ALARM, { name: ALARM, scheduledTime: T0 + 2 * HOUR });
    const w = boot({ env });
    await w.P.init();
    await settle();
    expect(alarmAt(w)).toBe(T0 + 2 * HOUR);
  });

  it.each([
    ['no stamp', undefined],
    ['a stamp in the past', T0 - MIN],
    ['a stamp further ahead than any cadence', T0 + 30 * DAY + 2 * HOUR],
    ['a stamp that is not a number', 'soon'],
  ])('checks at once with %s', async (_name, stamp) => {
    const local = confirmedState();
    if (stamp === undefined) delete local._licNextCheckAt; else local._licNextCheckAt = stamp;
    const w = await start({ local });
    expect(validateCalls(w)).toHaveLength(1);
  });

  it('does not check a stamp 30 days ahead', async () => {
    const w = await start({ local: confirmedState({ _licNextCheckAt: T0 + 30 * DAY }) });
    expect(validateCalls(w)).toHaveLength(0);
  });

  it('an alarm with no key stored does nothing', async () => {
    const w = await start();
    await fire(w);
    expect(w.proxy.calls).toHaveLength(0);
  });
});

// --- Stale results ---

describe('a result for a key that is gone', () => {
  it('does not touch the key that replaced it', async () => {
    const w = await start({ local: confirmedState() });
    const d = deferred();
    w.proxy.validate = (call) => (call.sub === SUB_A ? d.promise : answer(okBody({ next_billed_at: iso(T0 + 4 * DAY) })));
    const stale = w.P.validateLicense();
    await settle();
    const res = await w.P.setLicenseKey(SUB_B);
    expect(res).toEqual({ success: true });
    // The key swap moved the stamp to the new key's cadence.
    expect(stampOf(w)).toBe(T0 + 4 * DAY + HOUR);
    d.resolve(V2.canceled());
    expect(await stale).toEqual({ ok: false, error: 'key_changed' });
    await settle();
    const s = w.P.getStatus();
    expect(s.keyStored).toBe(true);
    expect(s.premium).toBe(true);
    expect(w.local.data._premiumKey).toBe(SUB_B);
    expect(w.local.data._licCleared).toBe(0);
    expect(stampOf(w)).toBe(T0 + 4 * DAY + HOUR);
    expect(alarmAt(w)).toBe(T0 + 4 * DAY + HOUR);
  });

  it('does not bring a removed key back', async () => {
    const w = await start({ local: confirmedState() });
    const d = deferred();
    w.proxy.validate = () => d.promise;
    const stale = w.P.validateLicense();
    await settle();
    await w.P.removeLicenseKey();
    d.resolve(V2.active());
    await stale;
    await settle();
    expect(w.P.getStatus().keyStored).toBe(false);
    expect(w.local.data._premiumKey).toBe(null);
    expect(w.alarms.map.has(ALARM)).toBe(false);
  });

  it('a new key starts unconfirmed, whatever the old one was', async () => {
    const w = await start({ local: confirmedState() });
    w.proxy.validate = V2.unreachable;
    await w.P.setLicenseKey(SUB_B);
    const s = w.P.getStatus();
    expect(s.graceRemainingDays).toBe(3);
    expect(s.lastValidationStatus).toBe(null);
    expect(s.billingInterval).toBe(null);
    expect(w.local.data._licConfirmedKey).toBe(null);
    at(T0 + HOUR);
    await fire(w);
    expect(validateCalls(w).map(c => [c.sub, c.reason]).pop()).toEqual([SUB_B, 'activation']);
  });

  it('a held key swapped out and back in while offline is neither held nor confirmed', async () => {
    // Kept, the old confirmation made it a confirmed key again: no hold and
    // 30 days of Premium for a key that never paid, once per swap.
    const w = await start();
    w.proxy.validate = V2.unpaid;
    await w.P.setLicenseKey(SUB_A);
    expect(w.P.getStatus().held).toBe('unpaid');
    w.proxy.validate = V2.unreachable;
    await w.P.setLicenseKey(SUB_B);
    await w.P.setLicenseKey(SUB_A);
    const s = w.P.getStatus();
    expect(s.held).toBe(null);
    expect(s.graceRemainingDays).toBe(3);
    expect(w.local.data._licConfirmedKey).toBe(null);
    at(T0 + HOUR);
    await fire(w);
    expect(validateCalls(w).map(c => [c.sub, c.reason]).pop()).toEqual([SUB_A, 'activation']);
  });

  it('re-entering the held key itself keeps the hold', async () => {
    const w = await start({ local: heldState() });
    w.proxy.validate = V2.unreachable;
    await w.P.setLicenseKey(SUB_A);
    expect(w.P.getStatus().held).toBe('unpaid');
    expect(w.local.data._licConfirmedKey).toBe(SUB_A);
  });
});

// --- Follow-up after "Update payment" ---

describe('the follow-up after the update-payment link', () => {
  async function heldWithLink(state = heldState()) {
    const w = await start({ local: state });
    const res = await w.P.getManageUrls();
    expect(res).toEqual({ ok: true, update_payment_method: 'https://pay.example/update', cancel: 'https://pay.example/cancel' });
    return w;
  }

  it('checks at +2 min, +10 min, +30 min and +2 h, then daily', async () => {
    const w = await heldWithLink();
    expect(w.local.data._licFollowUpUntil).toBe(T0 + 3 * HOUR);
    expect(stampOf(w)).toBe(T0 + 2 * MIN);
    expect(alarmAt(w)).toBe(T0 + 2 * MIN);
    w.proxy.validate = V2.unpaid;
    const steps = [[2 * MIN, 10 * MIN, 1], [10 * MIN, 30 * MIN, 2], [30 * MIN, 2 * HOUR, 3]];
    for (const [now, next, step] of steps) {
      at(T0 + now);
      await fire(w);
      expect(alarmAt(w)).toBe(T0 + next);
      expect(w.local.data._licFollowUpStep).toBe(step);
    }
    at(T0 + 2 * HOUR);
    await fire(w);
    expect(alarmAt(w)).toBe(T0 + 2 * HOUR + DAY);
    expect(validateCalls(w)).toHaveLength(4);
  });

  it('keeps its steps when every step wakes a fresh worker', async () => {
    // MV3 stops an idle background after about 30 s, so each step runs in a
    // new instance whose init() must restore the window from storage.
    const w = await heldWithLink();
    w.proxy.validate = V2.unpaid;
    const steps = [[2 * MIN, 10 * MIN], [10 * MIN, 30 * MIN], [30 * MIN, 2 * HOUR], [2 * HOUR, 2 * HOUR + DAY]];
    for (const [now, next] of steps) {
      at(T0 + now);
      const woken = boot({ env: w.env });
      await woken.P.init();
      await settle();
      await fire(woken);
      expect(alarmAt(woken)).toBe(T0 + next);
    }
    expect(validateCalls(w)).toHaveLength(4);
  });

  it('stops at the first ok', async () => {
    const w = await heldWithLink();
    w.proxy.validate = V2.active;
    at(T0 + 2 * MIN);
    await fire(w);
    expect(w.P.getStatus().premium).toBe(true);
    expect(w.P.getStatus().held).toBe(null);
    expect(w.local.data._licFollowUpUntil).toBe(0);
    expect(alarmAt(w)).toBe(T0 + 20 * DAY + HOUR);
  });

  it('keeps going through a transient failure and a still-past_due ok', async () => {
    const w = await heldWithLink(confirmedState({ _licLastStatus: 'past_due' }));
    expect(alarmAt(w)).toBe(T0 + 2 * MIN);
    w.proxy.validate = V2.unreachable;
    at(T0 + 2 * MIN);
    await fire(w);
    expect(alarmAt(w)).toBe(T0 + 10 * MIN);
    w.proxy.validate = V2.pastDuePaid;
    at(T0 + 10 * MIN);
    await fire(w);
    expect(alarmAt(w)).toBe(T0 + 30 * MIN);
  });

  it.each([
    ['an active subscription', confirmedState()],
    ['a paused one (no self-service fix)', heldState({ _licLastError: 'subscription_paused', _licLastStatus: 'paused' })],
  ])('does not start for %s', async (_name, state) => {
    const w = await start({ local: state });
    const before = alarmAt(w);
    await w.P.getManageUrls();
    expect(w.local.data._licFollowUpUntil).toBe(0);
    expect(alarmAt(w)).toBe(before);
  });

  it('does not start without a payment link', async () => {
    const w = await start({ local: heldState() });
    w.proxy.manage = () => answer({ ok: true, update_payment_method: null, cancel: 'https://pay.example/cancel' });
    await w.P.getManageUrls();
    expect(w.local.data._licFollowUpUntil).toBe(0);
  });

  it('answers a failed manage-url request without starting it', async () => {
    const w = await start({ local: heldState() });
    w.proxy.manage = () => answer(null);
    expect(await w.P.getManageUrls()).toEqual({ ok: false, error: 'proxy_unreachable' });
    w.proxy.manage = () => answer({ ok: false, error: 'manage_urls_unavailable' });
    expect(await w.P.getManageUrls()).toEqual({ ok: false, error: 'manage_urls_unavailable' });
    expect(w.local.data._licFollowUpUntil).toBe(0);
  });
});

// --- The portal links (contract 3) ---

describe('the portal links from /manage-url (contract 3)', () => {
  // Paddle customer-portal links without a sign-in token (the user signs in
  // with the purchase email); a link Paddle does not give is left out of the
  // answer. Made-up IDs, ULID-shaped like SUB_A.
  const CPL = 'cpl_01' + 'c'.repeat(24);
  const PORTAL_PAY = `https://customer-portal.paddle.com/${CPL}?action=update_subscription_payment_method&subscription_id=${SUB_A}`;
  const PORTAL_CANCEL = `https://customer-portal.paddle.com/${CPL}?action=cancel_subscription&subscription_id=${SUB_A}`;
  const stored = w => JSON.stringify([w.local.data, w.sync.data]);

  it.each([
    ['the payment link', { cancel: PORTAL_CANCEL }, { update_payment_method: null, cancel: PORTAL_CANCEL }, 0],
    ['the cancel link', { update_payment_method: PORTAL_PAY }, { update_payment_method: PORTAL_PAY, cancel: null }, T0 + 3 * HOUR],
  ])('reads %s, left out by the proxy, as null', async (_name, links, expected, followUpUntil) => {
    // A held key: the payment link alone decides whether the follow-up starts.
    const w = await start({ local: heldState() });
    w.proxy.manage = () => answer({ ok: true, ...links });
    expect(await w.P.getManageUrls()).toStrictEqual({ ok: true, ...expected });
    expect(w.local.data._licFollowUpUntil).toBe(followUpUntil);
    // The links are never persisted.
    expect(stored(w)).not.toContain('customer-portal.paddle.com');
  });

  it('answers a 502 for links it could not use (unusable_links) with ok:false and the error code', async () => {
    const w = await start({ local: heldState() });
    const before = alarmAt(w);
    w.proxy.manage = () => answer({ ok: false, error: 'paddle_server_error', detail: 'unusable_links' }, 502);
    expect(await w.P.getManageUrls()).toStrictEqual({ ok: false, error: 'paddle_server_error' });
    // No link, so no follow-up, and the license itself is untouched.
    expect(w.local.data._licFollowUpUntil).toBe(0);
    expect(alarmAt(w)).toBe(before);
    expect(w.P.getStatus().held).toBe('unpaid');
    expect(w.P.getStatus().lastValidationError).toBe('subscription_unpaid');
  });
});

// --- The nudge ---

describe('the nudge from the popup and options', () => {
  it('checks a held key and answers with the status after the check', async () => {
    const w = await start({ local: heldState() });
    w.proxy.validate = V2.active;
    const s = await w.P.nudge();
    expect(s.premium).toBe(true);
    expect(s.held).toBe(null);
    expect(validateCalls(w)).toHaveLength(1);
    expect(w.local.data._licLastNudgeAt).toBe(T0);
    // Fixed: the next open has nothing to check.
    at(T0 + 10 * MIN);
    await w.P.nudge();
    expect(validateCalls(w)).toHaveLength(1);
  });

  it('is throttled while the payment keeps failing', async () => {
    const w = await start({ local: heldState() });
    w.proxy.validate = V2.unpaid;
    await w.P.nudge();
    at(T0 + MIN);
    const s = await w.P.nudge();
    expect(s.held).toBe('unpaid');
    expect(validateCalls(w)).toHaveLength(1);
    at(T0 + 6 * MIN);
    await w.P.nudge();
    expect(validateCalls(w)).toHaveLength(2);
  });

  it('is throttled across worker restarts', async () => {
    // A popup opened after 30 s idle wakes a new worker: the throttle only
    // works if init() restores the last nudge time.
    const w = await start({ local: heldState() });
    w.proxy.validate = V2.unpaid;
    await w.P.nudge();
    at(T0 + MIN);
    const a = boot({ env: w.env });
    await a.P.init();
    await settle();
    await a.P.nudge();
    expect(validateCalls(w)).toHaveLength(1);
    at(T0 + 6 * MIN);
    const b = boot({ env: w.env });
    await b.P.init();
    await settle();
    await b.P.nudge();
    expect(validateCalls(w)).toHaveLength(2);
  });

  it('checks a past_due key too', async () => {
    const w = await start({ local: confirmedState({ _licLastStatus: 'past_due' }) });
    await w.P.nudge();
    expect(validateCalls(w)).toHaveLength(1);
  });

  it.each([
    ['an active key', confirmedState()],
    ['a key in grace', confirmedState({ _licFirstFailedAt: T0 - DAY, _licLastError: 'proxy_unreachable' })],
    ['no key', {}],
  ])('does nothing for %s', async (_name, state) => {
    const w = await start({ local: state });
    const s = await w.P.nudge();
    expect(validateCalls(w)).toHaveLength(0);
    expect(s).toEqual(w.P.getStatus());
  });

  it('is not throttled by a nudge stamp from the future (clock stepped back)', async () => {
    const w = await start({ local: heldState({ _licLastNudgeAt: T0 + HOUR }) });
    w.proxy.validate = V2.unpaid;
    await w.P.nudge();
    expect(validateCalls(w)).toHaveLength(1);
  });
});

// --- Held keys next to grace and trial ---

describe('a held key', () => {
  it('shows no grace and no lock, even after a transient failure', async () => {
    const w = await start({ local: heldState() });
    w.proxy.validate = V2.unreachable;
    await w.P.validateLicense();
    const s = w.P.getStatus();
    expect(s.held).toBe('unpaid');
    expect(s.premium).toBe(false);
    expect(s.licensed).toBe(false);
    expect(s.locked).toBe(false);
    expect(s.inGracePeriod).toBe(false);
    expect(s.graceRemainingDays).toBe(0);
    // The hold stands; the failure only paces the retry.
    expect(s.lastValidationError).toBe('subscription_unpaid');
    expect(s.lastValidatedAt).toBe(T0 - 5 * DAY);
    expect(alarmAt(w)).toBe(T0 + HOUR);
  });

  it('is never locked by an old failure streak', async () => {
    const w = await start({ local: heldState({ _licFirstFailedAt: T0 - 40 * DAY }) });
    const s = w.P.getStatus();
    expect(s.locked).toBe(false);
    expect(s.graceRemainingDays).toBe(0);
    expect(s.held).toBe('unpaid');
  });

  it('with a running trial: Premium from the trial, and both shown', async () => {
    const w = await start({ local: heldState({ _trialEnd: T0 + 5 * DAY }) });
    const s = w.P.getStatus();
    expect(s.premium).toBe(true);
    expect(s.trialActive).toBe(true);
    expect(s.trialDaysRemaining).toBe(5);
    expect(s.trialing).toBe(false);
    expect(s.licensed).toBe(false);
    expect(s.held).toBe('unpaid');
    expect(s.trialAvailable).toBe(false);
  });

  it('comes back by itself when Paddle collects', async () => {
    const w = await start({ local: heldState() });
    w.proxy.validate = V2.active;
    at(T0 + 20 * HOUR);
    await fire(w);
    expect(w.P.getStatus().premium).toBe(true);
    expect(w.P.getStatus().held).toBe(null);
  });
});

describe('grace', () => {
  it('an unconfirmed key locks after 3 days', async () => {
    const w = await start();
    w.proxy.validate = V2.unreachable;
    await w.P.setLicenseKey(SUB_A);
    at(T0 + 3 * DAY - MIN);
    expect(w.P.getStatus().locked).toBe(false);
    at(T0 + 3 * DAY + MIN);
    const s = w.P.getStatus();
    expect(s.locked).toBe(true);
    expect(s.premium).toBe(false);
    expect(s.keyStored).toBe(true);
  });

  it('a confirmed key locks after 30 days, and keeps the key', async () => {
    const w = await start({ local: confirmedState({ _licFirstFailedAt: T0, _licLastError: 'proxy_unreachable' }) });
    at(T0 + 29 * DAY);
    expect(w.P.getStatus().inGracePeriod).toBe(true);
    expect(w.P.getStatus().graceRemainingDays).toBe(1);
    at(T0 + 30 * DAY + MIN);
    const s = w.P.getStatus();
    expect(s.locked).toBe(true);
    expect(s.graceRemainingDays).toBe(0);
    expect(s.keyStored).toBe(true);
  });

  it('names a key Paddle cannot confirm, and keeps Premium in grace', async () => {
    // The live proxy's answer on a check of a key Paddle does not know (for
    // example a test key from the sandbox): a fault with detail "unconfirmed".
    const w = await start({ local: confirmedState() });
    w.proxy.validate = V2.serverError;
    await w.P.validateLicense();
    await settle();
    const s = w.P.getStatus();
    expect(s.lastValidationError).toBe('license_unconfirmed');
    expect(s.inGracePeriod).toBe(true);
    expect(s.graceRemainingDays).toBe(30);
    expect(s.premium).toBe(true);
    expect(s.keyStored).toBe(true);
  });

  it('keeps any other fault under its own code', async () => {
    const w = await start({ local: confirmedState() });
    w.proxy.validate = () => answer({ ok: false, error: 'paddle_server_error' }, 502);
    await w.P.validateLicense();
    await settle();
    expect(w.P.getStatus().lastValidationError).toBe('paddle_server_error');
    w.proxy.validate = () => answer({ ok: false, error: 'paddle_unreachable', detail: 'unconfirmed' }, 502);
    at(T0 + DAY);
    await w.P.validateLicense();
    await settle();
    expect(w.P.getStatus().lastValidationError).toBe('paddle_unreachable');
  });
});

// --- Trial after a license ---

describe('the trial after a license', () => {
  it('is refused after a license was removed', async () => {
    const w = await start();
    await w.P.setLicenseKey(SUB_A);
    await w.P.removeLicenseKey();
    expect(w.P.getStatus().trialAvailable).toBe(false);
    expect(await w.P.startTrial()).toEqual({ error: 'trial_unavailable' });
    expect(w.local.data._trialEnd).toBe(0);
  });

  it('is refused while held', async () => {
    const w = await start({ local: heldState() });
    expect(await w.P.startTrial()).toEqual({ error: 'trial_unavailable' });
  });

  it('is refused after an activation that was held (never paid)', async () => {
    const w = await start();
    w.proxy.validate = V2.unpaid;
    await w.P.setLicenseKey(SUB_A);
    await w.P.removeLicenseKey();
    expect(await w.P.startTrial()).toEqual({ error: 'trial_unavailable' });
  });

  it('is refused a second time', async () => {
    const w = await start();
    expect((await w.P.startTrial()).success).toBe(true);
    expect(await w.P.startTrial()).toEqual({ error: 'trial_unavailable' });
  });

  it('is still offered after a refused activation', async () => {
    const w = await start();
    w.proxy.validate = V2.notFound;
    await w.P.setLicenseKey(SUB_A);
    expect(w.P.getStatus().trialAvailable).toBe(true);
  });
});

// --- Input ---

describe('the ID the user types', () => {
  it('is trimmed and lowercased', async () => {
    const w = await start();
    const res = await w.P.setLicenseKey('  ' + SUB_A.toUpperCase() + '\n');
    expect(res).toEqual({ success: true });
    expect(validateCalls(w)[0].sub).toBe(SUB_A);
    expect(w.local.data._premiumKey).toBe(SUB_A);
  });

  // invalid_format as before, for any caller that only knows that code, and
  // the kind lib/license-entry.js gave the text, for the options page.
  it.each([
    ['sub_123', 'mistyped_sub_id'],
    ['sub_01' + 'a'.repeat(23), 'mistyped_sub_id'],
    ['sub_01' + 'a'.repeat(25), 'mistyped_sub_id'],
    ['sub_81' + 'a'.repeat(24), 'mistyped_sub_id'],
    ['sub_01' + 'i'.repeat(24), 'mistyped_sub_id'],
    ['sub_01' + 'u'.repeat(24), 'mistyped_sub_id'],
    ['sub-01' + 'a'.repeat(24), 'mistyped_sub_id'],
    ['txn_12', 'mistyped_txn_id'],
    ['txn_01' + 'o'.repeat(24), 'mistyped_txn_id'],
    ['hello', 'not_an_id'],
    ['', 'empty'],
  ])('refuses %j at once, without a request', async (input, kind) => {
    const w = await start();
    expect(await w.P.setLicenseKey(input)).toEqual({ error: 'invalid_format', kind });
    expect(w.proxy.calls).toHaveLength(0);
  });

  it('refuses a non-string', async () => {
    const w = await start();
    expect(await w.P.setLicenseKey(null)).toEqual({ error: 'invalid_format' });
  });

  // Made-up IDs for the text a user enters: 07 where every real Paddle ID (a
  // ULID, whose first characters are its creation time) starts with 01, so
  // none of them can be a real one. Written out whole, not split up to get
  // past a scanner.
  const ENTERED_SUB = 'sub_07h04vsc0qhwtsbsxh3422wjs4';
  const ENTERED_TXN = 'txn_07h04vsc0qhwtsbsxh3422wjs4';
  const OTHER_SUB = 'sub_07' + 'b'.repeat(24);
  const OTHER_TXN = 'txn_07' + 'b'.repeat(24);

  // The background is the authority: whatever reaches it, the proxy gets a
  // well-formed ID or nothing at all.
  it.each([
    ['an email address', 'name@example.com', 'email'],
    ['"sub_" and then an email address', 'sub_name@example.com', 'email'],
    ['the prefix alone', 'sub_', 'mistyped_sub_id'],
    ['the transaction prefix alone', 'txn_', 'mistyped_txn_id'],
    ['a Google Play order number', 'Gpa.1234-5678-9012-34567', 'play_order'],
    ['two subscription IDs', ENTERED_SUB + ' ' + OTHER_SUB, 'several_ids'],
    ['two transaction IDs', ENTERED_TXN + '\n' + OTHER_TXN, 'several_ids'],
    ['a broken ID pasted against a good one', ENTERED_SUB + OTHER_SUB.slice(0, -3), 'mistyped_sub_id'],
    ['a broken transaction ID against a good one', ENTERED_TXN + OTHER_TXN.slice(0, -3), 'mistyped_txn_id'],
    ['a broken subscription ID beside a transaction ID', ENTERED_SUB.slice(0, -1) + ' ' + ENTERED_TXN, 'mistyped_sub_id'],
    ['a transaction ID run straight into a subscription ID', ENTERED_TXN + ENTERED_SUB, 'several_ids'],
    ['a subscription ID run straight into a transaction ID', ENTERED_SUB + ENTERED_TXN, 'several_ids'],
    ['a cut transaction ID run into a subscription ID', ENTERED_TXN.slice(0, -3) + ENTERED_SUB, 'mistyped_txn_id'],
    ['a cut ID run into the "txn-" typo', ENTERED_SUB.slice(0, -3) + 'txn-' + ENTERED_TXN.slice(4), 'mistyped_txn_id'],
    ['a cut transaction ID in a link run into an address',
      'https://apps.example/checkout.html?_ptxn=' + ENTERED_TXN.slice(0, -4) + '&email=name@example.com', 'mistyped_txn_id'],
    ['an ID one character too long', ENTERED_SUB + 'x', 'mistyped_sub_id'],
    ['an ID in capitals, one character short', ENTERED_SUB.slice(0, -1).toUpperCase(), 'mistyped_sub_id'],
    ['a portal link without an ID', 'https://customer-portal.paddle.com/cpl_07' + 'c'.repeat(24), 'not_an_id'],
    ['invisible characters only', '​‎⁦﻿', 'empty'],
    ['whitespace only', ' \n\t ', 'empty'],
  ])('refuses %s without a request and without storing anything', async (_label, input, kind) => {
    const w = await start();
    expect(await w.P.setLicenseKey(input)).toEqual({ error: 'invalid_format', kind });
    expect(w.proxy.calls).toEqual([]);
    expect(w.local.data).toEqual({});
    expect(w.sync.data).toEqual({});
    expect(w.alarms.map.size).toBe(0);
    expect(w.P.getStatus().keyStored).toBe(false);
  });

  it.each([
    ['a labelled line', 'Subscription ID: ' + ENTERED_SUB + '\n'],
    ['a Paddle portal link', 'https://customer-portal.paddle.com/cpl_07' + 'c'.repeat(24)
      + '?action=overview&subscription_id=' + ENTERED_SUB + '&token=pga_example'],
    ['an ID split by a line break', ENTERED_SUB.slice(0, 14) + '\n' + ENTERED_SUB.slice(14)],
    ['"sub_" typed in front of the pasted ID', 'sub_' + ENTERED_SUB],
    ['a copy of it shortened in a link', 'Subscription ID: ' + ENTERED_SUB
      + '\nhttps://apps.example/success.html?_sub=' + ENTERED_SUB.slice(0, 19) + '...'],
    ['zero-width and bidi characters', '‪' + ENTERED_SUB.slice(0, 9) + '​' + ENTERED_SUB.slice(9) + '‏‬'],
    ['full-width characters', [...ENTERED_SUB].map(c => String.fromCharCode(c.charCodeAt(0) + 0xFEE0)).join('')],
  ])('sends only the subscription ID found in %s', async (_label, input) => {
    const w = await start();
    expect(await w.P.setLicenseKey(input)).toEqual({ success: true });
    expect(w.proxy.calls.map(c => [c.path, c.sub])).toEqual([['/validate', ENTERED_SUB]]);
    expect(w.local.data._premiumKey).toBe(ENTERED_SUB);
  });

  it('looks up the transaction ID found in a receipt line, and only that', async () => {
    const w = await start();
    const res = await w.P.setLicenseKey('Receipt | ' + ENTERED_TXN.toUpperCase() + ' | EUR 2.49 | name@example.com');
    expect(res).toEqual({ success: true });
    expect(w.proxy.calls.map(c => c.path)).toEqual(['/txn-to-sub', '/validate']);
    expect(w.proxy.calls[0].txn).toBe(ENTERED_TXN);
    expect(w.local.data._premiumKey).toBe(SUB_B);
  });

  it('takes the subscription ID when the text holds a transaction ID too, as the success page does', async () => {
    const w = await start();
    const res = await w.P.setLicenseKey('Subscription ID: ' + ENTERED_SUB + '\nTransaction ID: ' + ENTERED_TXN);
    expect(res).toEqual({ success: true });
    expect(w.proxy.calls.map(c => [c.path, c.sub, c.txn])).toEqual([['/validate', ENTERED_SUB, null]]);
  });

  it('logs the kind and the length of what was entered, never the text', async () => {
    const w = await start();
    const email = 'name@example.com';
    const line = 'Subscription ID: ' + ENTERED_SUB + ' sent to ' + email;
    await w.P.setLicenseKey(email);
    await w.P.setLicenseKey(line);
    await w.P.setLicenseKey(ENTERED_TXN);
    const printed = w.env.logs.map(args => args.map(a => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
    expect(printed).toContain('[ProtonPremium] License entry: email length: ' + email.length);
    expect(printed).toContain('[ProtonPremium] License entry: valid_in_text length: ' + line.length);
    expect(printed).toContain('[ProtonPremium] License entry: valid length: ' + ENTERED_TXN.length);
    // Not the address, and no key (one entered, SUB_B looked up), not even
    // masked.
    expect(printed.length).toBeGreaterThan(3);
    for (const p of printed) {
      expect(p).not.toMatch(/@|example|sub_|txn_/);
      for (const id of [ENTERED_SUB, ENTERED_TXN, SUB_B]) expect(p).not.toContain(id.slice(6, 14));
    }
  });

  it('resolves a transaction ID to its subscription', async () => {
    const w = await start();
    const res = await w.P.setLicenseKey(TXN_A.toUpperCase());
    expect(res).toEqual({ success: true });
    expect(w.proxy.calls.map(c => c.path)).toEqual(['/txn-to-sub', '/validate']);
    expect(w.proxy.calls[0].txn).toBe(TXN_A);
    expect(w.local.data._premiumKey).toBe(SUB_B);
  });

  it('passes on a refused transaction', async () => {
    const w = await start();
    w.proxy.txn = () => answer({ ok: false, error: 'subscription_not_found' });
    expect(await w.P.setLicenseKey(TXN_A)).toEqual({ error: 'subscription_not_found' });
    expect(validateCalls(w)).toHaveLength(0);
  });

  // The ID the lookup answers is checked as an entered one is: /validate
  // never gets anything but a well-formed subscription ID.
  it('refuses a malformed subscription ID from the lookup, and validates and stores nothing', async () => {
    const w = await start();
    w.proxy.txn = () => answer({ ok: true, subscription_id: OTHER_SUB.slice(0, -1) + 'o', status: 'active' });
    expect(await w.P.setLicenseKey(ENTERED_TXN)).toEqual({ error: 'invalid_format' });
    expect(w.proxy.calls.map(c => c.path)).toEqual(['/txn-to-sub']);
    expect(w.local.data).toEqual({});
    expect(w.P.getStatus().keyStored).toBe(false);
  });

  // Contract 3: /txn-to-sub answers a transaction it
  // cannot resolve with ok:false and an error code. Only not_ready is waited
  // out; any other code goes back to the options page as it came, and there
  // is no subscription ID, so nothing is stored.
  it('passes on a transaction for another product (200, ok:false) and stores nothing', async () => {
    const w = await start();
    w.proxy.txn = () => answer({ ok: false, error: 'subscription_wrong_product' });
    expect(await w.P.setLicenseKey(TXN_A)).toEqual({ error: 'subscription_wrong_product' });
    expect(w.proxy.calls.map(c => c.path)).toEqual(['/txn-to-sub']);
    expect(w.local.data).toEqual({});
    expect(w.sync.data).toEqual({});
    expect(w.alarms.map.size).toBe(0);
    const s = w.P.getStatus();
    expect(s.keyStored).toBe(false);
    expect(s.premium).toBe(false);
    expect(s.clearedReason).toBe(null);
    // Never a license, so the trial is still on offer.
    expect(s.trialAvailable).toBe(true);
  });

  it('passes on a Paddle server error from the lookup (502) and stores nothing', async () => {
    const w = await start();
    w.proxy.txn = () => answer({ ok: false, error: 'paddle_server_error' }, 502);
    expect(await w.P.setLicenseKey(TXN_A)).toEqual({ error: 'paddle_server_error' });
    // Asked once: a server error is not a subscription still being created.
    expect(w.proxy.calls.map(c => c.path)).toEqual(['/txn-to-sub']);
    expect(w.local.data).toEqual({});
    expect(w.sync.data).toEqual({});
    expect(w.alarms.map.size).toBe(0);
    expect(w.P.getStatus().keyStored).toBe(false);
  });
});

// --- Cleared reason ---

describe('the reason for an automatic clear', () => {
  it('is shown for 30 days', async () => {
    const w = await start({ local: confirmedState() });
    w.proxy.validate = V2.canceled;
    await w.P.validateLicense();
    expect(w.P.getStatus().clearedReason).toBe('subscription_canceled');
    at(T0 + 29 * DAY);
    expect(w.P.getStatus().clearedReason).toBe('subscription_canceled');
    at(T0 + 31 * DAY);
    expect(w.P.getStatus().clearedReason).toBe(null);
  });

  it('is not shown after a removal by the user', async () => {
    const w = await start({ local: confirmedState() });
    await w.P.removeLicenseKey();
    expect(w.P.getStatus().clearedReason).toBe(null);
  });

  it('goes away when a new key is entered', async () => {
    const w = await start({ local: unconfirmedState() });
    w.proxy.validate = V2.notFound;
    await w.P.validateLicense();
    expect(w.P.getStatus().clearedReason).toBe('subscription_not_found');
    w.proxy.validate = V2.active;
    await w.P.setLicenseKey(SUB_B);
    expect(w.P.getStatus().clearedReason).toBe(null);
  });
});

// --- Premium-change hook ---

describe('the premium-change hook', () => {
  it('fires when a check flips Premium, and only then', async () => {
    const w = await start({ local: confirmedState() });
    const seen = [];
    w.P.onPremiumChange(p => seen.push(p));
    await w.P.validateLicense();              // ok, still Premium
    w.proxy.validate = V2.unpaid;
    at(T0 + DAY);
    await w.P.validateLicense();              // held: off
    w.proxy.validate = V2.active;
    at(T0 + 2 * DAY);
    await w.P.validateLicense();              // paid: on
    expect(seen).toEqual([false, true]);
  });

  it('notices a grace period running out on any alarm', async () => {
    const w = await start({ local: confirmedState({ _licFirstFailedAt: T0 - 29 * DAY, _licLastError: 'proxy_unreachable' }) });
    const seen = [];
    w.P.onPremiumChange(p => seen.push(p));
    at(T0 + 2 * DAY);
    await fire(w, 'proton-mail-poll');
    expect(seen).toEqual([false]);
  });

  it('fires on activation, removal and trial start', async () => {
    const w = await start();
    const seen = [];
    w.P.onPremiumChange(p => seen.push(p));
    await w.P.setLicenseKey(SUB_A);
    await w.P.removeLicenseKey();
    expect(seen).toEqual([true, false]);
    const fresh = await start();
    const seen2 = [];
    fresh.P.onPremiumChange(p => seen2.push(p));
    await fresh.P.startTrial();
    expect(seen2).toEqual([true]);
  });

  it('survives a listener that throws', async () => {
    const w = await start();
    const seen = [];
    w.P.onPremiumChange(() => { throw new Error('boom'); });
    w.P.onPremiumChange(p => seen.push(p));
    await w.P.setLicenseKey(SUB_A);
    expect(seen).toEqual([true]);
  });
});

// --- Storage ---

describe('what is stored where', () => {
  it('never mirrors the scheduling stamps to storage.sync', async () => {
    const w = await start({ local: { syncEnabled: true } });
    w.proxy.validate = () => answer({ ...okBody({ status: 'past_due',
      scheduled_change: { action: 'cancel', effective_at: iso(T0 + 9 * DAY) } }), ever_paid: true });
    await w.P.setLicenseKey(SUB_A);
    await w.P.getManageUrls();
    at(T0 + 10 * MIN);
    await w.P.nudge();
    for (const k of LOCAL_ONLY) {
      expect(w.sync.data, k).not.toHaveProperty(k);
      expect(w.local.data, k).toHaveProperty(k);
    }
    expect(w.sync.data._licConfirmedKey).toBe(SUB_A);
    expect(w.sync.data._licEverLicensed).toBe(T0);
    expect(w.sync.data._licNextBilledAt).toBe(iso(T0 + 20 * DAY));
    expect(w.sync.data._licScheduledChange).toEqual({ action: 'cancel', effective_at: iso(T0 + 9 * DAY) });
  });

  it('adopting a synced key checks it at once, whatever this device\'s stamp said', async () => {
    const w = await start({ local: { _licNextCheckAt: T0 + 20 * DAY },
      sync: confirmedState({ _licNextCheckAt: undefined }) });
    expect(validateCalls(w).map(c => [c.sub, c.reason])).toEqual([[SUB_A, 'refresh']]);
    expect(w.local.data._premiumKey).toBe(SUB_A);
  });
});
