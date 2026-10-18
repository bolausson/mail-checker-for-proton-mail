/**
 * Tests for API error classification: Retry-After honoring, permanent
 * refresh-token failures (HTTP 400/422), and account-disabled error codes
 * (10002/10003) marking the account with authError.
 *
 * auth.js and accounts.js are browser IIFEs, so we eval them with stubbed
 * globals (same pattern as ics-parsing.test.js).
 */

import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const read = (rel) => readFileSync(join(__dirname, '..', rel), 'utf-8');

// --- Shared stubs -----------------------------------------------------------

function makeJsonResponse({ ok, status, body = {}, headers = {} }) {
  const lower = Object.fromEntries(
    Object.entries(headers).map(([k, v]) => [k.toLowerCase(), String(v)]));
  return {
    ok,
    status,
    headers: { get: (name) => lower[name.toLowerCase()] ?? null },
    json: () => Promise.resolve(body),
  };
}

let ProtonAuth;
let notifiedAuthErrors;

beforeAll(() => {
  globalThis.ProtonConfig = {
    BASE_URL: 'https://mail.proton.me/api',
    buildHeaders: () => ({ 'Content-Type': 'application/json' }),
  };
  globalThis.debugLog = () => {};
  globalThis.ProtonDiag = {
    record: () => {},
    fp: (t) => (t ? String(t).slice(-6) : 'none'),
    getAll: async () => [],
    clear: async () => {},
  };
  globalThis.browser = {
    storage: {
      local: { get: async () => ({}), set: async () => {} },
      // no `session` key: accounts.js treats snapshots as unavailable
    },
    alarms: { create: () => {}, clear: () => {} },
  };
  notifiedAuthErrors = [];
  globalThis.ProtonNotifier = {
    notifyAuthError: (email, reason) => { notifiedAuthErrors.push({ email, reason }); },
  };
  globalThis.ExtEncryption = {
    encrypt: async (v) => v,
    decrypt: async (v) => v,
  };
  globalThis.ProtonBinary = {
    bytesToHex: (b) => Array.from(b).map((x) => x.toString(16).padStart(2, '0')).join(''),
  };
  globalThis.ProtonLabels = { INBOX: '0', ALL_MAIL: '5', ARCHIVE: '6', TRASH: '3' };

  ProtonAuth = new Function(read('background/auth.js') + '\nreturn ProtonAuth;')();
  globalThis.ProtonAuth = ProtonAuth;
});

beforeEach(() => {
  notifiedAuthErrors.length = 0;
});

// Build a fresh ProtonAccounts with one ready-to-use account. The stored
// account is legacy-plaintext (no `encrypted` flag) and has no keyPassword,
// so init() skips key unlock; userId is pre-set so the backfill is skipped.
async function makeAccounts() {
  const ProtonAccounts = new Function(
    read('background/accounts.js') + '\nreturn ProtonAccounts;')();
  globalThis.browser.storage.local.get = async () => ({
    protonAccounts: [{
      id: 'acc1',
      username: 'tester',
      email: 'tester@proton.me',
      uid: 'uid-1',
      userId: 'user-1',
      accessToken: 'access-1',
      refreshToken: 'refresh-1',
    }],
  });
  await ProtonAccounts.init();
  return ProtonAccounts;
}

describe('ProtonAuth.refreshSession error classification', () => {
  it('flags HTTP 422 (invalid refresh token, Code 10013) as permanent', async () => {
    globalThis.fetch = vi.fn(async () => makeJsonResponse({
      ok: false, status: 422, body: { Code: 10013, Error: 'Invalid refresh token' },
    }));

    await expect(ProtonAuth.refreshSession('uid-1', 'bad-token')).rejects.toMatchObject({
      code: 10013,
      status: 422,
      permanent: true,
    });
  });

  it('flags HTTP 400 as permanent', async () => {
    globalThis.fetch = vi.fn(async () => makeJsonResponse({
      ok: false, status: 400, body: { Code: 10013, Error: 'Invalid refresh token' },
    }));

    await expect(ProtonAuth.refreshSession('uid-1', 'bad-token')).rejects.toMatchObject({
      permanent: true,
    });
  });

  it('keeps transient failures (5xx) retryable', async () => {
    globalThis.fetch = vi.fn(async () => makeJsonResponse({
      ok: false, status: 503, body: { Error: 'Maintenance' },
    }));

    await expect(ProtonAuth.refreshSession('uid-1', 'token')).rejects.toMatchObject({
      permanent: false,
    });
  });
});

describe('ProtonAccounts.request error handling', () => {
  it('exposes Retry-After seconds on 429 responses', async () => {
    const accounts = await makeAccounts();
    globalThis.fetch = vi.fn(async () => makeJsonResponse({
      ok: false, status: 429,
      body: { Code: 85131, Error: 'Too many requests' },
      headers: { 'Retry-After': '120' },
    }));

    await expect(accounts.request('acc1', 'GET', 'mail/v4/messages/count'))
      .rejects.toMatchObject({ status: 429, retryAfterSec: 120 });
    expect(accounts.getAccount('acc1').authError).toBeFalsy();
  });

  it('marks the account disabled on Code 10003 and notifies once', async () => {
    const accounts = await makeAccounts();
    globalThis.fetch = vi.fn(async () => makeJsonResponse({
      ok: false, status: 422, body: { Code: 10003, Error: 'Account is disabled' },
    }));

    await expect(accounts.request('acc1', 'GET', 'mail/v4/messages/count'))
      .rejects.toMatchObject({ code: 10003, permanentAuth: true });

    const acc = accounts.getAccount('acc1');
    expect(acc.authError).toBe('disabled');
    expect(acc.keysUnlocked).toBe(false);
    expect(notifiedAuthErrors).toEqual([{ email: 'tester@proton.me', reason: 'disabled' }]);

    // Second failure must not notify again (no per-poll notification spam)
    await expect(accounts.request('acc1', 'GET', 'mail/v4/messages/count')).rejects.toBeTruthy();
    expect(notifiedAuthErrors).toHaveLength(1);
  });

  it('marks the account disabled on Code 10002 (account deleted)', async () => {
    const accounts = await makeAccounts();
    globalThis.fetch = vi.fn(async () => makeJsonResponse({
      ok: false, status: 422, body: { Code: 10002, Error: 'Account does not exist' },
    }));

    await expect(accounts.request('acc1', 'GET', 'mail/v4/messages/count'))
      .rejects.toMatchObject({ code: 10002, permanentAuth: true });
    expect(accounts.getAccount('acc1').authError).toBe('disabled');
    expect(notifiedAuthErrors).toEqual([{ email: 'tester@proton.me', reason: 'disabled' }]);
  });

  it('marks the account reauth-required when 401 refresh fails permanently', async () => {
    const accounts = await makeAccounts();
    globalThis.fetch = vi.fn(async (url) => {
      if (String(url).includes('auth/v4/refresh')) {
        return makeJsonResponse({
          ok: false, status: 422, body: { Code: 10013, Error: 'Invalid refresh token' },
        });
      }
      return makeJsonResponse({ ok: false, status: 401, body: { Code: 401 } });
    });

    await expect(accounts.request('acc1', 'GET', 'mail/v4/messages/count'))
      .rejects.toMatchObject({ permanentAuth: true });
    expect(accounts.getAccount('acc1').authError).toBe('reauth');
    expect(notifiedAuthErrors).toEqual([{ email: 'tester@proton.me', reason: 'reauth' }]);
  });

  it('does NOT set authError when 401 refresh fails transiently', async () => {
    const accounts = await makeAccounts();
    globalThis.fetch = vi.fn(async (url) => {
      if (String(url).includes('auth/v4/refresh')) {
        return makeJsonResponse({ ok: false, status: 503, body: { Error: 'Maintenance' } });
      }
      return makeJsonResponse({ ok: false, status: 401, body: { Code: 401 } });
    });

    await expect(accounts.request('acc1', 'GET', 'mail/v4/messages/count'))
      .rejects.toMatchObject({ permanentAuth: false });
    expect(accounts.getAccount('acc1').authError).toBeFalsy();
  });

  it('parses a token→email map from line-folded attendee ICS (regression)', async () => {
    const accounts = await makeAccounts();
    // Verbatim shape of Proton's decrypted attendee data, folded at ~75 octets
    // per RFC 5545. This is exactly what produced "Email map: {}" in the field.
    const folded =
      'BEGIN:VCALENDAR\r\n' +
      'PRODID:-//Proton AG//ProtonCalendar 1.0.0//EN\r\n' +
      'VERSION:2.0\r\n' +
      'BEGIN:VEVENT\r\n' +
      'UID:madeupeventuid000000000001@example.com\r\n' +
      'ATTENDEE;CUTYPE=INDIVIDUAL;ROLE=REQ-PARTICIPANT;RSVP=TRUE;CN=user@example.c\r\n' +
      ' om;X-NUM-GUESTS=0;X-PM-TOKEN=0123456789abcdef0123456789abcdef01234567:mail\r\n' +
      ' to:user@example.com\r\n' +
      'END:VEVENT\r\n' +
      'END:VCALENDAR';

    const map = accounts._attendeeTokenEmailMap(folded);
    expect(map['0123456789abcdef0123456789abcdef01234567']).toBe('user@example.com');
  });

  it('pairs multiple attendees with their own tokens', async () => {
    const accounts = await makeAccounts();
    const ics = [
      'BEGIN:VCALENDAR', 'BEGIN:VEVENT', 'UID:evt@google.com',
      'ATTENDEE;ROLE=REQ-PARTICIPANT;X-PM-TOKEN=aaa111:mailto:alex@example.org',
      'ATTENDEE;ROLE=REQ-PARTICIPANT;X-PM-TOKEN=bbb222:mailto:user@example.com',
      'END:VEVENT', 'END:VCALENDAR',
    ].join('\r\n');

    const map = accounts._attendeeTokenEmailMap(ics);
    expect(map).toEqual({ aaa111: 'alex@example.org', bbb222: 'user@example.com' });
  });

  it('picks the master event for a whole-series RSVP', async () => {
    const accounts = await makeAccounts();
    const events = [
      { ID: 'master', RecurrenceID: null },
      { ID: 'occ1', RecurrenceID: 1781000000 },
    ];
    // No recurrence id → whole series → master, regardless of list order.
    expect(accounts._pickEventForScope(events, false).ID).toBe('master');
    expect(accounts._pickEventForScope([events[1], events[0]], false).ID).toBe('master');
  });

  it('picks the single exception for an occurrence RSVP, never the master', async () => {
    const accounts = await makeAccounts();
    const events = [
      { ID: 'master', RecurrenceID: null },
      { ID: 'occ1', RecurrenceID: 1781000000 },
    ];
    const picked = accounts._pickEventForScope(events, true);
    expect(picked.ID).toBe('occ1');
    expect(picked.RecurrenceID).toBeTruthy(); // never the master series
  });

  it('refuses to guess when multiple occurrences exist (avoids series corruption)', async () => {
    const accounts = await makeAccounts();
    const events = [
      { ID: 'master', RecurrenceID: null },
      { ID: 'occ1', RecurrenceID: 1781000000 },
      { ID: 'occ2', RecurrenceID: 1781086400 },
    ];
    // Ambiguous → null so the caller skips the local update rather than
    // writing onto the wrong occurrence or the whole series.
    expect(accounts._pickEventForScope(events, true)).toBeNull();
  });

  it('does NOT clear a permanent authError on a plain successful request', async () => {
    // A dead *refresh* token leaves the *access* token valid for a few more
    // minutes, so polls keep succeeding after the session is really dead.
    // Clearing authError on such a success made the "!" badge flicker off and
    // re-armed the doomed proactive refresh, so a plain success must NOT clear
    // it. Only a successful refresh or re-login (new refresh token) clears it.
    const accounts = await makeAccounts();
    globalThis.fetch = vi.fn(async () => makeJsonResponse({
      ok: false, status: 422, body: { Code: 10003, Error: 'Account is disabled' },
    }));
    await expect(accounts.request('acc1', 'GET', 'mail/v4/messages/count')).rejects.toBeTruthy();
    expect(accounts.getAccount('acc1').authError).toBe('disabled');

    globalThis.fetch = vi.fn(async () => makeJsonResponse({
      ok: true, status: 200, body: { Code: 1000, Counts: [] },
    }));
    await accounts.request('acc1', 'GET', 'mail/v4/messages/count');
    // Still flagged: the access-token-backed success does not resurrect a
    // permanently-dead session.
    expect(accounts.getAccount('acc1').authError).toBe('disabled');
  });

  it('coalesces a reactive refresh when another context already rotated the token', async () => {
    const accounts = await makeAccounts();
    // Simulate another background generation having rotated the refresh + access
    // tokens in storage while this one was mid-request (the Opera cold-start race
    // that trips Proton's reuse-detection → 10013 → intermittent "session expired").
    globalThis.browser.storage.local.get = async () => ({
      protonAccounts: [{
        id: 'acc1', username: 'tester', email: 'tester@proton.me', uid: 'uid-1',
        userId: 'user-1', accessToken: 'access-2', refreshToken: 'refresh-2',
      }],
    });
    let n = 0;
    globalThis.fetch = vi.fn(async () => {
      n++;
      // 1st call (original request) 401s on the stale access token; the retry succeeds.
      return n === 1
        ? makeJsonResponse({ ok: false, status: 401, body: { Code: 401 } })
        : makeJsonResponse({ ok: true, status: 200, body: { Code: 1000, Count: 0 } });
    });

    const result = await accounts.request('acc1', 'GET', 'mail/v4/messages/count');
    expect(result).toBeTruthy();
    // Exactly 2 fetches (request 401 → retry 200): NO /auth/refresh call. We
    // re-read the already-rotated token and retried instead of rotating again
    // (a 3rd fetch). That rotation would have been the reuse that 10013s.
    expect(globalThis.fetch).toHaveBeenCalledTimes(2);
    // The account now holds the re-read (rotated) tokens.
    expect(accounts.getAccount('acc1').refreshToken).toBe('refresh-2');
    expect(accounts.getAccount('acc1').accessToken).toBe('access-2');
    expect(accounts.getAccount('acc1').authError).toBeFalsy();
  });
});

describe('ViewMode-aware unread counts', () => {
  // The badge must match Proton's own UI: conversation-mode accounts
  // (ViewMode 0) count conversations, message-mode (1/unset) count messages.
  async function countWithViewMode(viewMode) {
    const accounts = await makeAccounts();
    accounts.getAccount('acc1').viewMode = viewMode;
    const urls = [];
    globalThis.fetch = vi.fn(async (url) => {
      urls.push(String(url));
      return makeJsonResponse({
        ok: true, status: 200,
        body: { Code: 1000, Counts: [{ LabelID: '0', Unread: 7 }] },
      });
    });
    const unread = await accounts.getInboxUnreadCount('acc1');
    return { urls, unread };
  }

  it('uses conversations/count when the account is in conversation mode (ViewMode 0)', async () => {
    const { urls, unread } = await countWithViewMode(0);
    expect(urls.some((u) => u.includes('mail/v4/conversations/count'))).toBe(true);
    expect(urls.some((u) => u.includes('mail/v4/messages/count'))).toBe(false);
    expect(unread).toBe(7);
  });

  it('uses messages/count in message mode (ViewMode 1)', async () => {
    const { urls } = await countWithViewMode(1);
    expect(urls.some((u) => u.includes('mail/v4/messages/count'))).toBe(true);
    expect(urls.some((u) => u.includes('mail/v4/conversations/count'))).toBe(false);
  });

  it('falls back to messages/count when ViewMode is unknown (null)', async () => {
    const { urls } = await countWithViewMode(null);
    expect(urls.some((u) => u.includes('mail/v4/messages/count'))).toBe(true);
    expect(urls.some((u) => u.includes('mail/v4/conversations/count'))).toBe(false);
  });
});

// streamRequest (used by the AI assistant) keeps the error fields request()
// has always set and adds the parsed JSON error body as err.body, because the
// AI chat completions route can answer in OpenAI's { error: { code } } form,
// which has no Proton Code to copy.
describe('ProtonAccounts.streamRequest error body', () => {
  const PATH = 'ai/v1/chat/completions';
  const call = (accounts) => accounts.streamRequest('acc1', 'POST', PATH, { data: { model: 'm' }, onText: () => {} })
    .then(() => { throw new Error('expected a rejection'); }, (err) => err);

  it('keeps status, code and message, and adds the body (Proton form)', async () => {
    const accounts = await makeAccounts();
    const body = { Code: 2000, Error: 'Missing required attributes model,messages' };
    globalThis.fetch = vi.fn(async () => makeJsonResponse({ ok: false, status: 400, body }));
    const err = await call(accounts);
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toBe('Missing required attributes model,messages');
    expect(err).toMatchObject({ status: 400, code: 2000 });
    expect(err.body).toEqual(body);
    expect(err.retryAfterSec).toBeUndefined();
  });

  it('exposes an OpenAI-style body, which has no Code, next to Retry-After', async () => {
    const accounts = await makeAccounts();
    const body = { error: { code: 'rejected', type: 'server_error', message: 'busy' } };
    globalThis.fetch = vi.fn(async () => makeJsonResponse({
      ok: false, status: 503, body, headers: { 'Retry-After': '7' },
    }));
    const err = await call(accounts);
    expect(err.message).toBe('HTTP 503');
    expect(err).toMatchObject({ status: 503, retryAfterSec: 7 });
    expect(err.code).toBeUndefined();
    expect(err.body).toEqual(body);
  });

  it('keeps Retry-After on a 429 and a model-server body as it came', async () => {
    const accounts = await makeAccounts();
    const body = { object: 'error', type: 'BadRequestError', code: 400, message: 'too long' };
    globalThis.fetch = vi.fn(async () => makeJsonResponse({
      ok: false, status: 429, body, headers: { 'Retry-After': '3' },
    }));
    const err = await call(accounts);
    expect(err).toMatchObject({ status: 429, retryAfterSec: 3, body });
    expect(err.code).toBeUndefined(); // a lowercase code is not Proton's Code
  });

  it('adds no body when the error body is not JSON', async () => {
    const accounts = await makeAccounts();
    globalThis.fetch = vi.fn(async () => ({
      ok: false,
      status: 502,
      headers: { get: () => null },
      json: () => Promise.reject(new SyntaxError('Unexpected token < in JSON')),
    }));
    const err = await call(accounts);
    expect(err.message).toBe('HTTP 502');
    expect(err.status).toBe(502);
    expect(err.code).toBeUndefined();
    expect('body' in err).toBe(false);
  });

  it('copes with a JSON null error body', async () => {
    const accounts = await makeAccounts();
    globalThis.fetch = vi.fn(async () => makeJsonResponse({ ok: false, status: 500, body: null }));
    const err = await call(accounts);
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toBe('HTTP 500');
    expect(err.status).toBe(500);
    expect('body' in err).toBe(false);
  });

  it('still streams a successful answer through onText', async () => {
    const accounts = await makeAccounts();
    const parts = [new TextEncoder().encode('data: {"a":1}\n'), new TextEncoder().encode('data: [DONE]\n')];
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      headers: { get: () => null },
      body: {
        getReader: () => ({
          read: async () => (parts.length ? { done: false, value: parts.shift() } : { done: true }),
        }),
      },
    }));
    const seen = [];
    await accounts.streamRequest('acc1', 'POST', PATH, { data: { model: 'm' }, onText: (t) => { seen.push(t); } });
    expect(seen.join('')).toBe('data: {"a":1}\ndata: [DONE]\n');
    const [url, init] = globalThis.fetch.mock.calls[0];
    expect(url).toBe(`https://mail.proton.me/api/${PATH}`);
    expect(init.body).toBe(JSON.stringify({ model: 'm' }));
  });

  /** A failed response whose body is a stream that hands out these pieces, then ends. */
  function streamedFailure(status, pieces, extra = {}) {
    const reader = {
      reads: 0,
      read: vi.fn(async () => {
        reader.reads++;
        return pieces.length ? { done: false, value: pieces.shift() } : { done: true };
      }),
      cancel: vi.fn(async () => {}),
      ...extra,
    };
    return {
      reader,
      response: {
        ok: false,
        status,
        headers: { get: () => null },
        body: { getReader: () => reader },
        json: () => { throw new Error('the body stream should be read, not json()'); },
      },
    };
  }

  it('reads the error body from its stream, in pieces', async () => {
    const accounts = await makeAccounts();
    const text = JSON.stringify({ error: { code: 'timeout', type: 'server_error' } });
    const bytes = new TextEncoder().encode(text);
    const { response } = streamedFailure(503, [bytes.subarray(0, 10), bytes.subarray(10)]);
    globalThis.fetch = vi.fn(async () => response);
    const err = await call(accounts);
    expect(err).toMatchObject({ status: 503, body: { error: { code: 'timeout', type: 'server_error' } } });
  });

  it('does not buffer an error body past 16 KiB and cancels the rest', async () => {
    const accounts = await makeAccounts();
    const piece = new TextEncoder().encode(`{"Error":"${'x'.repeat(8 * 1024)}`);
    const { reader, response } = streamedFailure(500, Array.from({ length: 100 }, () => piece));
    globalThis.fetch = vi.fn(async () => response);
    const err = await call(accounts);
    expect(err.message).toBe('HTTP 500');
    expect(err.status).toBe(500);
    expect('body' in err).toBe(false);
    expect(reader.reads).toBeLessThanOrEqual(3);
    await vi.waitFor(() => expect(reader.cancel).toHaveBeenCalledTimes(1));
  });

  it('passes on an abort that hits while the error body is read', async () => {
    const accounts = await makeAccounts();
    const { response } = streamedFailure(503, [], {
      read: vi.fn(async () => { throw new DOMException('The operation was aborted.', 'AbortError'); }),
    });
    globalThis.fetch = vi.fn(async () => response);
    const err = await call(accounts);
    expect(err.name).toBe('AbortError');
    expect(err.status).toBeUndefined();
  });

  it('passes on an abort from json() as well', async () => {
    const accounts = await makeAccounts();
    globalThis.fetch = vi.fn(async () => ({
      ok: false,
      status: 503,
      headers: { get: () => null },
      json: () => Promise.reject(new DOMException('The operation was aborted.', 'AbortError')),
    }));
    const err = await call(accounts);
    expect(err.name).toBe('AbortError');
  });
});

// Cold-start fast/slow split: the popup must get the cached email list the instant
// the snapshot is restored, WITHOUT waiting for (or even attempting) key unlock,
// and the per-account keys must be flagged "unlocking" so the popup doesn't flash a
// false "session expired" banner over the cached list.
describe('ProtonAccounts cold-start fast/slow init', () => {
  // Real getSettings() lives in constants.js (not evaluated here); provide the same
  // storage-backed shape so the encrypted disk-cache (opt-in) path is exercised.
  function stubGetSettings() {
    globalThis.getSettings = async () => {
      const s = await globalThis.browser.storage.local.get('settings');
      return s.settings || {};
    };
  }

  it('initFast() restores the encrypted disk cache and flags keys as unlocking, without unlocking keys', async () => {
    const accounts = new Function(
      read('background/accounts.js') + '\nreturn ProtonAccounts;')();
    stubGetSettings();

    // ExtEncryption stub is identity, so the on-disk blob is just the JSON.
    const snapshot = JSON.stringify({
      acc1: {
        messages: [{ ID: 'm1', Subject: 'Cached subject', Unread: 1 }],
        unreadCount: 1, lastEventId: 'e1', lastCheckTime: 123, authError: null,
      },
    });
    globalThis.browser.storage.local.get = async (key) => {
      if (key === 'protonAccounts') return { protonAccounts: [{
        id: 'acc1', username: 'tester', email: 'tester@proton.me', uid: 'uid-1',
        userId: 'user-1', accessToken: 'a', refreshToken: 'r', keyPassword: 'kp',
      }] };
      if (key === 'settings') return { settings: { cacheEnabled: true } };
      if (key === '_msgCacheEnc') return { _msgCacheEnc: snapshot };
      return {};
    };

    // Fast phase ONLY: no initSlow(), so no key unlock / network is attempted.
    await accounts.initFast();

    // Cached list restored from disk, ready to serve to the popup immediately.
    expect(accounts.hasSnapshot()).toBe(true);
    expect(accounts.getAccount('acc1').messages).toEqual([
      { ID: 'm1', Subject: 'Cached subject', Unread: 1 },
    ]);

    // Keys are NOT unlocked yet (that's the slow phase) but ARE flagged unlocking,
    // so the popup shows the cached list without a false "session expired" banner.
    const info = accounts.getAccounts()[0];
    expect(info.keysUnlocked).toBe(false);
    expect(info.keysUnlocking).toBe(true);
    expect(info.authError).toBeNull();
  });

  it('does NOT flag keysUnlocking for an account already in authError (banner must still show)', async () => {
    const accounts = new Function(
      read('background/accounts.js') + '\nreturn ProtonAccounts;')();
    stubGetSettings();
    globalThis.browser.storage.local.get = async (key) => {
      if (key === 'protonAccounts') return { protonAccounts: [{
        id: 'acc1', username: 'tester', email: 'tester@proton.me', uid: 'uid-1',
        userId: 'user-1', accessToken: 'a', refreshToken: 'r', keyPassword: 'kp',
        authError: 'reauth',
      }] };
      return {};
    };

    await accounts.initFast();

    const info = accounts.getAccounts()[0];
    expect(info.keysUnlocking).toBe(false); // dead session is not "unlocking"
    expect(info.authError).toBe('reauth');  // so the banner still surfaces
  });
});

// The Opera "session expired" race: a proactive refresh rotates the token, then an
// in-flight request still carrying the PRE-refresh access token 401s ~130-540ms
// later, triggering a redundant reactive refresh that re-uses the just-rotated token
// inside Proton's reuse window → 10013 → a FALSE authError=reauth. The fix coalesces
// a reactive refresh that fires within _REACTIVE_REFRESH_COALESCE_MS of a successful
// one: skip the rotation, let the caller retry with the already-fresh access token.
describe('ProtonAccounts reactive-refresh coalesce (Opera 10013 race)', () => {
  it('coalesces a reactive refresh right after a successful one: no redundant rotation, no false reauth', async () => {
    const accounts = new Function(
      read('background/accounts.js') + '\nreturn ProtonAccounts;')();
    globalThis.browser.storage.local.get = async (key) => {
      if (key === 'protonAccounts') return { protonAccounts: [{
        id: 'acc1', username: 'tester', email: 'tester@proton.me', uid: 'uid-1',
        userId: 'user-1', accessToken: 'access-fresh', refreshToken: 'refresh-1',
        lastRefreshAt: Date.now(), // a refresh JUST succeeded
      }] };
      return {};
    };
    await accounts.init();

    const calls = [];
    let n = 0;
    globalThis.fetch = vi.fn(async (url) => {
      calls.push(String(url));
      n++;
      // Original request 401s (in flight with the pre-refresh access token); the
      // retry (after the coalesce) succeeds with the current token.
      if (n === 1) return makeJsonResponse({ ok: false, status: 401, body: { Code: 401 } });
      return makeJsonResponse({ ok: true, status: 200, body: { ok: 1 } });
    });

    const result = await accounts.request('acc1', 'GET', 'mail/v4/messages');

    expect(result).toEqual({ ok: 1 });
    // The redundant rotation was skipped: the refresh endpoint was never hit...
    expect(calls.some((u) => u.includes('auth/v4/refresh'))).toBe(false);
    // ...so no false "session expired", and just the request + one retry went out.
    expect(accounts.getAccount('acc1').authError).toBeFalsy();
    expect(calls.filter((u) => u.includes('mail/v4/messages'))).toHaveLength(2);
  });
});
