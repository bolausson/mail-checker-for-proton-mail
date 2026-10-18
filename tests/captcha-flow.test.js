// @vitest-environment jsdom
/**
 * Signing in through Proton's CAPTCHA.
 *
 * Two defects, both found while signing a test account in:
 *
 * 1. The pending sign-in (username and password, needed to finish the login
 *    once the puzzle is solved) lives only in the background's memory, and the
 *    browser stops an idle background after ~30 s. A slower solve then found
 *    nothing to finish, and every background start removed the header rules
 *    that let Proton's CAPTCHA frame load at all. Rather than storing the
 *    password anywhere, the CAPTCHA tab now keeps the background awake.
 * 2. Those header rules were dynamic rules, written to the profile. Chrome
 *    refused that write in one setup ("Internal error while updating dynamic
 *    rules") and the frame stayed blocked. They are session rules now:
 *    memory-only, which is what a rule for one sign-in should be.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const ROOT = join(__dirname, '..');
const SHIM = readFileSync(join(ROOT, 'background', 'csp-shim.js'), 'utf-8');
const BACKGROUND = readFileSync(join(ROOT, 'background', 'background.js'), 'utf-8');
const INJECT = readFileSync(join(ROOT, 'captcha', 'captcha-inject.js'), 'utf-8');

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

function makeDNR({ session = true, dynamicThrows = false } = {}) {
  const dnr = {
    sessionRules: new Map(),
    dynamicRules: new Map(),
    updateDynamicRules: async ({ addRules = [], removeRuleIds = [] }) => {
      if (dynamicThrows) throw new Error('Internal error while updating dynamic rules.');
      for (const id of removeRuleIds) dnr.dynamicRules.delete(id);
      for (const r of addRules) dnr.dynamicRules.set(r.id, r);
    },
  };
  if (session) {
    dnr.updateSessionRules = async ({ addRules = [], removeRuleIds = [] }) => {
      for (const id of removeRuleIds) dnr.sessionRules.delete(id);
      for (const r of addRules) dnr.sessionRules.set(r.id, r);
    };
  }
  return dnr;
}

function loadShim(dnr) {
  return new Function('browser', 'debugLog', SHIM + '\nreturn ProtonCSPShim;')(
    { declarativeNetRequest: dnr }, () => {});
}

describe('the header rules for the CAPTCHA frame', () => {
  it('are session rules, never written to disk', async () => {
    const dnr = makeDNR();
    await loadShim(dnr).enableLoginCSPOverride();
    expect([...dnr.sessionRules.keys()].sort()).toEqual([1001, 1002, 1003]);
    expect(dnr.dynamicRules.size).toBe(0);
  });

  it('work even where writing dynamic rules fails', async () => {
    // The failure seen in Chrome: the session path never touches it.
    const dnr = makeDNR({ dynamicThrows: true });
    await loadShim(dnr).enableLoginCSPOverride();
    expect(dnr.sessionRules.size).toBe(3);
  });

  it('cover exactly the three Proton hosts, and only strip the two headers', async () => {
    const dnr = makeDNR();
    await loadShim(dnr).enableLoginCSPOverride();
    const rules = [...dnr.sessionRules.values()];
    expect(rules.map(r => r.condition.urlFilter).sort())
      .toEqual(['||account.proton.me/', '||verify-api.proton.me/', '||verify.proton.me/']);
    for (const r of rules) {
      expect(r.action.responseHeaders.map(h => h.header).sort()).toEqual(['content-security-policy', 'x-frame-options']);
      expect(r.condition.resourceTypes.sort()).toEqual(['main_frame', 'sub_frame']);
    }
  });

  it('replace a dynamic copy left by an older version instead of adding to it', async () => {
    const dnr = makeDNR();
    await dnr.updateDynamicRules({ addRules: [{ id: 1001 }, { id: 1002 }, { id: 1003 }] });
    await loadShim(dnr).enableLoginCSPOverride();
    expect(dnr.dynamicRules.size).toBe(0);
  });

  it('are removed, both kinds, when the sign-in ends and at startup', async () => {
    const dnr = makeDNR();
    const shim = loadShim(dnr);
    await shim.enableLoginCSPOverride();
    await dnr.updateDynamicRules({ addRules: [{ id: 1002 }] });
    await shim.disableLoginCSPOverride();
    expect(dnr.sessionRules.size + dnr.dynamicRules.size).toBe(0);
    await shim.enableLoginCSPOverride();
    await shim.clearStaleRules();
    expect(dnr.sessionRules.size).toBe(0);
  });

  it('still clear the session rules when clearing dynamic ones fails', async () => {
    const dnr = makeDNR();
    const shim = loadShim(dnr);
    await shim.enableLoginCSPOverride();
    const broken = makeDNR({ dynamicThrows: true });
    broken.sessionRules = dnr.sessionRules;
    await loadShim(broken).disableLoginCSPOverride();
    expect(dnr.sessionRules.size).toBe(0);
  });

  it('fall back to dynamic rules where session rules are missing', async () => {
    const dnr = makeDNR({ session: false });
    await loadShim(dnr).enableLoginCSPOverride();
    expect(dnr.dynamicRules.size).toBe(3);
  });
});

describe('the pending sign-in in the background', () => {
  function makePending() {
    const log = [];
    const body = "let _pendingLogin = null; let _pendingCaptcha = false;\n" +
      "const CAPTCHA_EXPIRE_ALARM = 'proton-captcha-expire'; const CAPTCHA_EXPIRE_MIN = 15;\n" +
      lift(BACKGROUND, '_setPendingLogin') +
      '\nreturn { set: _setPendingLogin, get: () => ({ login: _pendingLogin, captcha: _pendingCaptcha }) };';
    const api = new Function('ProtonCSPShim', 'browser', body)(
      { enableLoginCSPOverride: () => log.push('rules on'), disableLoginCSPOverride: () => log.push('rules off') },
      { alarms: { create: (n, o) => log.push('alarm ' + n + ' ' + o.delayInMinutes), clear: async n => log.push('clear ' + n) } });
    return { api, log };
  }

  it('arms the rules and an expiry for a CAPTCHA, and nothing else for 2FA', () => {
    const { api, log } = makePending();
    api.set({ username: 'u', password: 'p' }, { needsCspOverride: true });
    expect(log).toEqual(['rules on', 'alarm proton-captcha-expire 15']);
    expect(api.get().captcha).toBe(true);
    log.length = 0;
    api.set({ username: 'u', password: 'p' }); // 2FA next: no header rules
    expect(log).toEqual(['rules off', 'clear proton-captcha-expire']);
    expect(api.get().captcha).toBe(false);
  });

  it('drops an abandoned CAPTCHA sign-in when the expiry fires', () => {
    const at = BACKGROUND.indexOf('browser.alarms.onAlarm.addListener');
    const handler = BACKGROUND.slice(at, BACKGROUND.indexOf('});', at));
    expect(handler).toMatch(/alarm\.name === CAPTCHA_EXPIRE_ALARM && _pendingCaptcha\)\s*\{\s*_setPendingLogin\(null\);/);
  });

  it('answers the keep-alive ping with whether a CAPTCHA sign-in is pending', () => {
    const at = BACKGROUND.indexOf("case 'CAPTCHA_KEEPALIVE':");
    const block = BACKGROUND.slice(at, BACKGROUND.indexOf('return false;', at));
    expect(block).toMatch(/sendResponse\(\{ pending: !!\(_pendingLogin && _pendingCaptcha\) \}\)/);
  });

  it('accepts the ping from free-tier users (signing in is never paid)', () => {
    expect(BACKGROUND).toMatch(/'CANCEL_PENDING_AUTH', 'CLOSE_THIS_TAB', 'CAPTCHA_KEEPALIVE',/);
  });

  it('never stores the password: no storage call anywhere near it', () => {
    const fn = lift(BACKGROUND, '_setPendingLogin');
    expect(fn).not.toMatch(/storage/);
  });
});

describe('the CAPTCHA tab keeps the background awake', () => {
  let sent;
  let reply;

  function runScript({ bodyFirst = false } = {}) {
    window.history.replaceState(null, '', '/login#ext-captcha=tok123&methods=captcha');
    if (!bodyFirst && document.body) document.documentElement.removeChild(document.body);
    window.stop = () => {};
    globalThis.browser = {
      runtime: {
        sendMessage: async (msg) => {
          sent.push(msg.type);
          if (msg.type === 'CAPTCHA_KEEPALIVE') return reply();
          if (msg.type === 'CAPTCHA_SOLVED') return { success: true };
          return undefined;
        },
      },
    };
    new Function(INJECT)();
  }

  // Each test runs the script again in the same page, so whatever one run
  // registered (message listeners, the body watcher) is taken down after it:
  // otherwise earlier runs answer a later test's messages too.
  let added;
  let observers;
  let realAdd;
  let RealObserver;

  beforeEach(() => {
    vi.useFakeTimers();
    sent = [];
    reply = () => ({ pending: true });
    added = [];
    observers = [];
    realAdd = window.addEventListener;
    window.addEventListener = function (type, fn, opts) {
      added.push([type, fn, opts]);
      return realAdd.call(this, type, fn, opts);
    };
    RealObserver = globalThis.MutationObserver;
    globalThis.MutationObserver = class extends RealObserver {
      constructor(cb) { super(cb); observers.push(this); }
    };
  });
  afterEach(() => {
    for (const [type, fn, opts] of added) window.removeEventListener(type, fn, opts);
    window.addEventListener = realAdd;
    for (const o of observers) o.disconnect();
    globalThis.MutationObserver = RealObserver;
    vi.clearAllTimers();
    vi.useRealTimers();
    delete globalThis.browser;
    if (!document.body) document.documentElement.appendChild(document.createElement('body'));
  });

  const pings = () => sent.filter(t => t === 'CAPTCHA_KEEPALIVE').length;

  it('pings at once, since the idle clock started with the sign-in', async () => {
    runScript();
    await vi.advanceTimersByTimeAsync(0);
    expect(pings()).toBe(1);
  });

  it('then pings every 20 seconds while the puzzle is open', async () => {
    runScript();
    await vi.advanceTimersByTimeAsync(20000);
    expect(pings()).toBe(2);
    await vi.advanceTimersByTimeAsync(60000);
    expect(pings()).toBe(5);
  });

  it('stops once the background has no sign-in pending', async () => {
    reply = () => ({ pending: false });
    runScript();
    await vi.advanceTimersByTimeAsync(80000);
    expect(pings()).toBe(1);
  });

  it('stops after 10 minutes at the latest', async () => {
    runScript();
    await vi.advanceTimersByTimeAsync(15 * 60 * 1000);
    expect(pings()).toBe(31); // at once, then every 20 s through minute 10
  });

  it('stops once the puzzle is solved', async () => {
    runScript();
    // The page takeover runs when <body> appears (document_start in the browser).
    document.documentElement.appendChild(document.createElement('body'));
    await vi.advanceTimersByTimeAsync(0);
    expect(document.getElementById('captcha-iframe')).not.toBe(null);
    await vi.advanceTimersByTimeAsync(20000);
    expect(pings()).toBe(2);
    window.dispatchEvent(new MessageEvent('message', {
      origin: 'https://verify.proton.me',
      data: JSON.stringify({ type: 'HUMAN_VERIFICATION_SUCCESS', payload: { token: 'solved', type: 'captcha' } }),
    }));
    await vi.advanceTimersByTimeAsync(0);
    expect(sent).toContain('CAPTCHA_SOLVED');
    await vi.advanceTimersByTimeAsync(60000);
    expect(pings()).toBe(2);
  });

  it('starts again when a solved attempt fails and the puzzle is offered again', async () => {
    runScript();
    const solvedReply = { error: 'Incorrect login credentials' };
    const original = globalThis.browser.runtime.sendMessage;
    globalThis.browser.runtime.sendMessage = async (msg) => {
      if (msg.type === 'CAPTCHA_SOLVED') { sent.push(msg.type); return solvedReply; }
      return original(msg);
    };
    document.documentElement.appendChild(document.createElement('body'));
    await vi.advanceTimersByTimeAsync(0);
    window.dispatchEvent(new MessageEvent('message', {
      origin: 'https://verify.proton.me',
      data: JSON.stringify({ type: 'HUMAN_VERIFICATION_SUCCESS', payload: { token: 'solved', type: 'captcha' } }),
    }));
    await vi.advanceTimersByTimeAsync(0);
    const afterFailure = pings();
    await vi.advanceTimersByTimeAsync(40000);
    expect(pings()).toBe(afterFailure + 2);
  });

  it('does nothing on an ordinary Proton page', async () => {
    window.history.replaceState(null, '', '/login');
    globalThis.browser = { runtime: { sendMessage: async (m) => { sent.push(m.type); } } };
    new Function(INJECT)();
    await vi.advanceTimersByTimeAsync(60000);
    expect(sent).toEqual([]);
  });
});
