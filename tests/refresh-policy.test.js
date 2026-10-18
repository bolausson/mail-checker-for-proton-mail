/**
 * When the extension refreshes its Proton session, and when it must NOT.
 *
 * Background, from a user diagnostic on 2026-08-13 (33 h, one account):
 * ZERO 401s in the whole capture, all 52 refreshes fired by an MV3 cold start,
 * the minimum gap pinned at exactly the throttle floor, and a 10.5 h stretch
 * with no refresh at all during which 48 API calls returned 200. The access
 * token was good for at least half a day while we rotated every ~16 min:
 * roughly 790 rotations over the 9.2-day session that then died with 10013 on
 * a correctly-held, idle token.
 *
 * No Proton client behaves that way. go-proton-api, WebClients and Proton Pass
 * (also a browser extension) all refresh ONLY on a 401 and run no refresh timer
 * at all. So the timer here is a long safety net, and the reactive path is the
 * real mechanism.
 *
 * The stale-401 guard is the subtle half. A 401 can arrive from a request that
 * was already in flight when we rotated; refreshing again re-uses the fresh
 * token inside Proton's reuse-detection window and 10013s, which the user sees
 * as a false "session expired". Proton Pass decides this by comparing the
 * SERVER's date on the 401 against the SERVER's date of the last refresh, so
 * both sides come from one clock. We now do the same.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const ROOT = join(__dirname, '..');
const ACCOUNTS = readFileSync(join(ROOT, 'background', 'accounts.js'), 'utf-8');
const AUTH = readFileSync(join(ROOT, 'background', 'auth.js'), 'utf-8');

function lift(src, name) {
  const start = src.search(new RegExp('(async )?function ' + name + '\\('));
  if (start === -1) throw new Error('not found: ' + name);
  let i = src.indexOf('{', start);
  let depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) return src.slice(start, i + 1); }
  }
  throw new Error('unbalanced braces reading ' + name);
}

/**
 * Lifted lazily, per call. A module-level lift throws during collection when
 * the function is missing, which marks the whole FILE as one failed suite and
 * hides which assertion actually broke. Deferring it means a missing piece
 * fails exactly the tests that need it, and names it.
 */
const parseDateHeader = (...args) =>
  new Function(lift(AUTH, '_parseDateHeader') + '\nreturn _parseDateHeader;')()(...args);

/** The coalesce decision, extracted so it can be driven directly. */
function shouldCoalesce({ trigger, responseDate, lastRefreshServerAt, lastRefreshAt, now }, windowMs = 10000) {
  if (trigger === 'reactive' && responseDate && lastRefreshServerAt &&
      responseDate <= lastRefreshServerAt) return 'stale-401';
  if (trigger === 'reactive' && (!responseDate || !lastRefreshServerAt) &&
      lastRefreshAt && (now - lastRefreshAt) < windowMs) return 'recent-refresh-local';
  return null;
}

describe('reading the server clock off a response', () => {
  it('parses a real HTTP date header', () => {
    const h = new Headers({ date: 'Wed, 13 Aug 2026 09:30:16 GMT' });
    expect(parseDateHeader(h)).toBe(Date.parse('Wed, 13 Aug 2026 09:30:16 GMT'));
  });

  it('returns null rather than a wrong time when the header is absent', () => {
    // Callers must treat null as "unknown" and fall back, never as epoch 0,
    // which would make every 401 look newer than every refresh.
    expect(parseDateHeader(new Headers({}))).toBeNull();
    expect(parseDateHeader(null)).toBeNull();
    expect(parseDateHeader(undefined)).toBeNull();
  });

  it('returns null for an unparseable header instead of NaN', () => {
    expect(parseDateHeader(new Headers({ date: 'not a date' }))).toBeNull();
  });

  it('survives a headers object that throws', () => {
    expect(parseDateHeader({ get() { throw new Error('nope'); } })).toBeNull();
  });
});

describe('the stale-401 guard', () => {
  const REFRESHED = Date.parse('Wed, 13 Aug 2026 09:30:00 GMT');

  it('skips a 401 the server issued BEFORE our last refresh', () => {
    // That request was already in flight when we rotated, so its 401 says
    // nothing about the token we now hold. Refreshing again is what 10013s.
    expect(shouldCoalesce({
      trigger: 'reactive',
      responseDate: REFRESHED - 400,
      lastRefreshServerAt: REFRESHED,
    })).toBe('stale-401');
  });

  it('skips a 401 issued in the same second as the refresh', () => {
    // HTTP dates have one-second resolution, so equal timestamps are the
    // common case for the race, not an edge case. Must be <=, not <.
    expect(shouldCoalesce({
      trigger: 'reactive',
      responseDate: REFRESHED,
      lastRefreshServerAt: REFRESHED,
    })).toBe('stale-401');
  });

  it('DOES refresh on a 401 the server issued after our last refresh', () => {
    // A genuinely expired access token. Suppressing this would strand the user.
    expect(shouldCoalesce({
      trigger: 'reactive',
      responseDate: REFRESHED + 1000,
      lastRefreshServerAt: REFRESHED,
    })).toBeNull();
  });

  it('never suppresses a proactive refresh', () => {
    expect(shouldCoalesce({
      trigger: 'proactive',
      responseDate: REFRESHED - 5000,
      lastRefreshServerAt: REFRESHED,
    })).toBeNull();
  });

  it('is immune to a skewed local clock', () => {
    // Both sides come from Proton's Date header, so the device being hours
    // wrong cannot change the decision. This is the reason for the rewrite.
    const decide = (now) => shouldCoalesce({
      trigger: 'reactive',
      responseDate: REFRESHED - 400,
      lastRefreshServerAt: REFRESHED,
      lastRefreshAt: 0, now,
    });
    expect(decide(Date.now())).toBe('stale-401');
    expect(decide(Date.now() + 6 * 60 * 60 * 1000)).toBe('stale-401');
    expect(decide(Date.now() - 6 * 60 * 60 * 1000)).toBe('stale-401');
  });
});

describe('the local-clock fallback', () => {
  it('still guards an account that has not refreshed since this build', () => {
    // No lastRefreshServerAt yet. Dropping the guard entirely here would
    // regress the exact race it was written for.
    const now = 1_000_000;
    expect(shouldCoalesce({
      trigger: 'reactive', responseDate: now, lastRefreshServerAt: 0,
      lastRefreshAt: now - 400, now,
    })).toBe('recent-refresh-local');
  });

  it('guards when the response carried no Date header', () => {
    const now = 1_000_000;
    expect(shouldCoalesce({
      trigger: 'reactive', responseDate: null, lastRefreshServerAt: 12345,
      lastRefreshAt: now - 400, now,
    })).toBe('recent-refresh-local');
  });

  it('does not fire once the window has passed', () => {
    const now = 1_000_000;
    expect(shouldCoalesce({
      trigger: 'reactive', responseDate: null, lastRefreshServerAt: 0,
      lastRefreshAt: now - 30_000, now,
    })).toBeNull();
  });

  it('yields to the server-date guard when both timestamps exist', () => {
    // The precise check wins; the fallback must not second-guess it. A 401
    // NEWER than the refresh has to refresh even if it arrived milliseconds
    // after one, which is where the old fixed window got it wrong.
    const now = 1_000_000;
    expect(shouldCoalesce({
      trigger: 'reactive', responseDate: 5000, lastRefreshServerAt: 4000,
      lastRefreshAt: now - 400, now,
    })).toBeNull();
  });
});

describe('the proactive refresh is a safety net, not a heartbeat', () => {
  it('waits 12 hours, not 15 minutes', () => {
    expect(ACCOUNTS).toMatch(/_TOKEN_REFRESH_MIN_INTERVAL_MS = 12 \* 60 \* 60 \* 1000/);
    expect(ACCOUNTS).not.toMatch(/_TOKEN_REFRESH_MIN_INTERVAL_MS = 15 \* 60 \* 1000/);
  });

  it('no longer arms a refresh 30 seconds after every startup', () => {
    // Re-armed on each cold start, this was the mechanism that made the token
    // rotate on worker lifecycle rather than on need.
    expect(ACCOUNTS).not.toMatch(/_TOKEN_REFRESH_INITIAL_MIN/);
  });

  it('clears that alarm on upgrade, since existing installs still have it', () => {
    expect(ACCOUNTS).toMatch(/function _clearLegacyRefreshAlarm\(\)/);
    expect(lift(ACCOUNTS, '_clearLegacyRefreshAlarm'))
      .toMatch(/browser\.alarms\.clear\(ALARM_TOKEN_REFRESH_INITIAL\)/);
    expect(ACCOUNTS).toMatch(/_clearLegacyRefreshAlarm\(\);/);
  });

  it('does not re-create an alarm that already exists', () => {
    // alarms.create() REPLACES a same-named alarm and restarts its delay, so
    // re-creating on every cold start pushed the periodic alarm perpetually
    // into the future: the cadence came from cold starts, not from the period.
    const fn = lift(ACCOUNTS, '_startProactiveRefresh');
    expect(fn).toMatch(/browser\.alarms\.get\(ALARM_TOKEN_REFRESH\)/);
    expect(fn).toMatch(/if \(existing\) return;/);
  });
});

describe('the server refresh time is captured and persisted', () => {
  it('refreshSession returns the server date', () => {
    expect(lift(AUTH, 'refreshSession')).toMatch(/serverDate: _parseDateHeader\(result\.headers\)/);
  });

  it('a 401 carries the server date, and only a 401 pays for it', () => {
    expect(ACCOUNTS).toMatch(
      /if \(resp\.status === 401\) err\.responseDate = ProtonAuth\.parseDateHeader\(resp\.headers\)/);
  });

  it('is stored only when the header was actually present', () => {
    // Guarded, so a missing header cannot overwrite a good value with 0 and
    // make every later 401 look newer than the last refresh.
    expect(ACCOUNTS).toMatch(/if \(result\.serverDate\) account\.lastRefreshServerAt = result\.serverDate;/);
  });

  it('survives a restart and a cross-context token reload', () => {
    expect(ACCOUNTS).toMatch(/lastRefreshServerAt: a\.lastRefreshServerAt \|\| 0,/);
    expect(ACCOUNTS).toMatch(
      /if \(data\.lastRefreshServerAt\) account\.lastRefreshServerAt = data\.lastRefreshServerAt;/);
  });

  it('reaches the refresh through the reactive call site', () => {
    expect(ACCOUNTS).toMatch(
      /_refreshTokens\(account, 'reactive', \{ responseDate: err\.responseDate \}\)/);
  });
});

describe('the shipped guard matches the decision tested above', () => {
  // shouldCoalesce() re-expresses the guard so it can be driven directly. That
  // is only worth anything if the real conditions still read the same way, so
  // pin the two that carry the behaviour.
  const fn = () => lift(ACCOUNTS, '_doRefreshTokens');

  it('compares the 401 date against the stored server refresh time with <=', () => {
    // `<` instead of `<=` would let the equal-timestamps case through, and HTTP
    // dates are second-resolution so that case is the common one.
    expect(fn()).toMatch(
      /opts\.responseDate <= account\.lastRefreshServerAt/);
    expect(fn()).toMatch(
      /trigger === 'reactive' && opts\.responseDate && account\.lastRefreshServerAt/);
  });

  it('falls back only when a server timestamp is missing', () => {
    expect(fn()).toMatch(
      /trigger === 'reactive' && \(!opts\.responseDate \|\| !account\.lastRefreshServerAt\)/);
  });

  it('keeps both coalesce outcomes distinguishable in the diagnostic log', () => {
    // The next log tells us which guard fired, so a recurrence can be read
    // without guessing.
    expect(fn()).toMatch(/reason: 'stale-401'/);
    expect(fn()).toMatch(/reason: 'recent-refresh-local'/);
  });
});
