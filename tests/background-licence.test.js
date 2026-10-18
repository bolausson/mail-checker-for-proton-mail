/**
 * The license wiring in background/background.js.
 *
 * background.js can't be imported (it touches browser APIs at load), so the
 * pieces are sliced out of the source and run with stubs: the license message
 * cases (each must answer even when premium.js throws, or the options page
 * waits forever on a disabled button) and the premium-change hook that
 * re-applies the poll interval and the badge when Premium flips.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const BG = readFileSync(join(__dirname, '..', 'background', 'background.js'), 'utf-8');

const settle = async () => { for (let i = 0; i < 4; i++) await new Promise(r => setImmediate(r)); };

/** The source of one `case 'TYPE':` block of the message switch. */
function caseBlock(type) {
  const start = BG.indexOf(`      case '${type}':`);
  if (start === -1) throw new Error('case not found: ' + type);
  const end = BG.indexOf('\n      case ', start + 1);
  return BG.slice(start, end);
}

/** Run one case with stubs; resolves with what it answered. */
function runCase(type, { ProtonPremium, ProtonPoller = { restart: async () => {} } }, message = {}) {
  const fn = new Function('message', 'sendResponse', 'ProtonPremium', 'ProtonPoller',
    `switch (message.type) {\n${caseBlock(type)}\n}`);
  let answer;
  const answered = new Promise(r => { answer = r; });
  const ret = fn({ type, ...message }, answer, ProtonPremium, ProtonPoller);
  return { ret, answered };
}

const rejecting = () => Promise.reject(new Error('storage exploded'));

describe('VALIDATE_LICENSE', () => {
  it('answers internal_error when the check throws', async () => {
    const { ret, answered } = runCase('VALIDATE_LICENSE', {
      ProtonPremium: { validateLicense: rejecting, getStatus: () => ({}) },
    });
    expect(ret).toBe(true);
    expect(await answered).toEqual({ ok: false, error: 'internal_error' });
  });

  it('answers internal_error when reading the status throws', async () => {
    const { answered } = runCase('VALIDATE_LICENSE', {
      ProtonPremium: { validateLicense: async () => ({ ok: true }), getStatus: () => { throw new Error('x'); } },
    });
    expect(await answered).toEqual({ ok: false, error: 'internal_error' });
  });

  it('answers the result and the status after the check', async () => {
    let restarted = 0;
    const { answered } = runCase('VALIDATE_LICENSE', {
      ProtonPremium: { validateLicense: async () => ({ ok: true }), getStatus: () => ({ premium: true }) },
      ProtonPoller: { restart: async () => { restarted++; }, start: async () => {} },
    });
    expect(await answered).toEqual({ result: { ok: true }, status: { premium: true } });
    // The options page sends this on every return to its tab: a restart
    // there pushed the next mail poll back a full interval each time.
    expect(restarted).toBe(0);
  });

  it('does not restart the poller (the premium-change hook re-applies the interval)', () => {
    expect(caseBlock('VALIDATE_LICENSE')).not.toMatch(/ProtonPoller\.restart\(\)/);
  });
});

describe('LICENSE_NUDGE', () => {
  it('answers ok with the status the nudge resolves to', async () => {
    const { ret, answered } = runCase('LICENSE_NUDGE', {
      ProtonPremium: { nudge: async () => ({ held: null, premium: true }), getStatus: () => ({ stale: true }) },
    });
    expect(ret).toBe(true);
    expect(await answered).toEqual({ ok: true, status: { held: null, premium: true } });
  });

  it('still answers with the current status when the nudge throws', async () => {
    const { answered } = runCase('LICENSE_NUDGE', {
      ProtonPremium: { nudge: rejecting, getStatus: () => ({ held: 'unpaid' }) },
    });
    expect(await answered).toEqual({ ok: true, status: { held: 'unpaid' } });
  });
});

describe('the other license messages always answer', () => {
  it.each([
    ['GET_MANAGE_URLS', { getManageUrls: rejecting }, { ok: false, error: 'internal_error' }],
    ['SET_LICENSE_KEY', { setLicenseKey: rejecting }, { error: 'internal_error' }],
    ['REMOVE_LICENSE_KEY', { removeLicenseKey: rejecting }, { ok: false, error: 'internal_error' }],
    ['START_TRIAL', { startTrial: rejecting }, { error: 'internal_error' }],
  ])('%s', async (type, ProtonPremium, expected) => {
    const { ret, answered } = runCase(type, { ProtonPremium });
    expect(ret).toBe(true);
    expect(await answered).toEqual(expected);
  });

  it('GET_MANAGE_URLS passes the URLs through', async () => {
    const urls = { ok: true, update_payment_method: 'https://pay', cancel: 'https://cancel' };
    const { answered } = runCase('GET_MANAGE_URLS', { ProtonPremium: { getManageUrls: async () => urls } });
    expect(await answered).toEqual(urls);
  });

  it('START_TRIAL passes a refusal through', async () => {
    const { answered } = runCase('START_TRIAL', {
      ProtonPremium: { startTrial: async () => ({ error: 'trial_unavailable' }) },
    });
    expect(await answered).toEqual({ error: 'trial_unavailable' });
  });
});

describe('the premium-change hook', () => {
  const HOOK_START = '\n  ProtonPremium.onPremiumChange(';

  function hookSource() {
    const start = BG.indexOf(HOOK_START);
    expect(start, 'premium-change hook not registered at top level').toBeGreaterThan(-1);
    const end = BG.indexOf('\n  });', start) + '\n  });'.length;
    return BG.slice(start, end);
  }

  function register({ hasAccounts = true } = {}) {
    const log = [];
    let cb = null;
    const deps = {
      ProtonPremium: { onPremiumChange: (fn) => { cb = fn; } },
      ProtonPoller: {
        start: async () => { log.push('start'); },
        refreshBadgeNow: () => { log.push('badge'); },
      },
      ProtonAccounts: { hasAccounts: () => hasAccounts },
      ensureInitialized: () => { log.push('init'); return Promise.resolve(); },
    };
    new Function(...Object.keys(deps), hookSource())(...Object.values(deps));
    return { log, fire: (p) => cb(p) };
  }

  it('is registered at the top level, before init can start a check', () => {
    const hook = BG.indexOf(HOOK_START);
    expect(hook).toBeLessThan(BG.indexOf('browser.alarms.onAlarm.addListener'));
    const initFn = BG.indexOf('async function _initialize()');
    const initEnd = BG.indexOf('\n  }\n', initFn);
    expect(hook < initFn || hook > initEnd).toBe(true);
  });

  it('waits for init, then re-applies the poll interval and the badge', async () => {
    const { log, fire } = register();
    fire(false);
    await settle();
    expect(log).toEqual(['init', 'start', 'badge']);
  });

  it('leaves polling alone when there is no account', async () => {
    const { log, fire } = register({ hasAccounts: false });
    fire(true);
    await settle();
    expect(log).toEqual(['init']);
  });

  it('gets every alarm to premium.js, which notices a trial or grace running out', () => {
    const at = BG.indexOf('browser.alarms.onAlarm.addListener');
    const block = BG.slice(at, BG.indexOf('\n  });', at));
    expect(block).toMatch(/ProtonPremium\.handleAlarm\(alarm\);/);
    expect(block).not.toMatch(/if \([^)]*\)\s*ProtonPremium\.handleAlarm/);
  });
});
