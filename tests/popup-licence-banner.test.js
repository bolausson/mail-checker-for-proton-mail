/**
 * @vitest-environment jsdom
 *
 * The popup's license banner and the upgrade paths while a license is held.
 *
 * A stored subscription can be in trouble in three ways the popup has to say
 * out loud: a renewal failed (past_due, Premium stays on during dunning), the
 * payment never went through (held 'unpaid', Premium off), or the
 * subscription is paused (held 'paused', Premium off). Each gets one banner
 * above the account sections, in every list state, with the one action that
 * helps: update the payment method, or open the settings for a paused one.
 *
 * A held user already has a subscription, so every "Upgrade" path (the header
 * button, the upgrade toast, the locked-account header) must lead to that
 * action and never to the pricing page: selling them a second subscription is
 * the failure these tests exist to catch.
 *
 * House style: popup.js is a DOM-bound IIFE, so the functions under test are
 * lifted out of the source by name and evaluated with their dependencies
 * injected (same idea as replied-indicator.test.js).
 */

import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const POPUP = readFileSync(join(__dirname, '..', 'popup', 'popup.js'), 'utf-8');
const POPUP_HTML = readFileSync(join(__dirname, '..', 'popup', 'popup.html'), 'utf-8');

const PRICING_URL = 'https://apps.olausson.de/#mail-checker-pricing';
const PAY_URL = 'https://customer-portal.paddle.com/update-payment?token=abc';

/** Slice `function NAME(...) { ... }` out of popup.js by balancing braces. */
function lift(name) {
  const m = new RegExp('(async )?function ' + name + '\\(').exec(POPUP);
  if (!m) throw new Error('function not found in popup.js: ' + name);
  let i = POPUP.indexOf('{', m.index);
  let depth = 0;
  for (; i < POPUP.length; i++) {
    if (POPUP[i] === '{') depth++;
    else if (POPUP[i] === '}') { depth--; if (depth === 0) return POPUP.slice(m.index, i + 1); }
  }
  throw new Error('unbalanced braces reading ' + name);
}

/** Slice `const|let NAME = { ... };` out of popup.js. */
function liftObject(kind, name) {
  const start = POPUP.indexOf(kind + ' ' + name + ' = {');
  if (start === -1) throw new Error(kind + ' not found in popup.js: ' + name);
  const end = POPUP.indexOf('};', start);
  return POPUP.slice(start, end + 2);
}

// The banner and its action, the unit every other test builds on.
const BANNER_FNS = ['_licenseBannerState', '_openUpdatePayment', '_runLicenseAction', '_renderLicenseBanner'];

/**
 * Evaluate lifted functions together, with `env`'s keys in scope as their
 * dependencies and `mutable` names as assignable `let`s. Lifted names and env
 * keys must stay disjoint.
 */
function sandbox(names, env, mutable) {
  const keys = Object.keys(env || {});
  const parts = [liftObject('const', 'LICENSE_BANNER_TEXT')];
  if (mutable && mutable.length) parts.push('let ' + mutable.join(', ') + ';');
  if (keys.length) parts.push('const { ' + keys.join(', ') + ' } = __env;');
  for (const n of names) parts.push(lift(n));
  parts.push('return { ' + names.join(', ') + ' };');
  return new Function('__env', parts.join('\n\n'))(env || {});
}

const ProtonI18n = { t: (k) => k };

/**
 * A browser stub. `manage` is what GET_MANAGE_URLS answers: a value, a
 * function returning a promise (for the in-flight test), or an Error to reject.
 */
function makeBrowser(manage = { ok: true, update_payment_method: PAY_URL, cancel: null }) {
  const sent = [];
  const tabs = [];
  let optionsOpened = 0;
  const browser = {
    runtime: {
      sendMessage: vi.fn((msg) => {
        sent.push(msg.type);
        if (typeof manage === 'function') return manage(msg);
        if (manage instanceof Error) return Promise.reject(manage);
        return Promise.resolve(manage);
      }),
      openOptionsPage: vi.fn(() => { optionsOpened++; return Promise.resolve(); }),
    },
    tabs: { create: vi.fn(({ url }) => { tabs.push(url); return Promise.resolve(); }) },
  };
  return { browser, sent, tabs, options: () => optionsOpened };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

// Status shapes as ProtonPremium.getStatus() reports them (contract fields only).
const S = {
  pastDue: { premium: true, licensed: true, keyStored: true, held: null, pastDue: true },
  unpaid: { premium: false, licensed: false, locked: false, keyStored: true, held: 'unpaid', pastDue: false },
  paused: { premium: false, licensed: false, locked: false, keyStored: true, held: 'paused', pastDue: false },
  active: { premium: true, licensed: true, keyStored: true, held: null, pastDue: false },
  free: { premium: false, licensed: false, keyStored: false, held: null, pastDue: false },
  trial: { premium: true, licensed: false, trialing: true, trialActive: true, keyStored: false, held: null, pastDue: false },
  locked: { premium: false, licensed: false, locked: true, keyStored: true, held: null, pastDue: false },
  grace: { premium: true, licensed: true, inGracePeriod: true, graceRemainingDays: 12, keyStored: true, held: null, pastDue: false },
  endsOn: { premium: true, licensed: true, keyStored: true, held: null, pastDue: false,
    scheduledChange: { action: 'cancel', effective_at: '2026-10-30T00:00:00Z' } },
};

function bannerKit(manage) {
  const b = makeBrowser(manage);
  const fns = sandbox(BANNER_FNS, { browser: b.browser, ProtonI18n });
  return { ...b, ...fns };
}

function newList() {
  const ul = document.createElement('ul');
  document.body.appendChild(ul);
  return ul;
}

describe('one banner per license problem, none otherwise', () => {
  const CASES = [
    ['past_due (renewal failed, Premium kept)', S.pastDue, 'popupLicensePastDue', 'manageUpdatePayment'],
    ['held unpaid (payment not received)', S.unpaid, 'popupLicenseUnpaid', 'manageUpdatePayment'],
    ['held paused', S.paused, 'popupLicensePaused', 'settings'],
  ];

  for (const [label, status, textKey, buttonKey] of CASES) {
    it(label, () => {
      const { _renderLicenseBanner } = bannerKit();
      const ul = newList();
      const li = _renderLicenseBanner(ul, status);
      expect(li).not.toBeNull();
      expect(ul.children).toHaveLength(1);
      expect(ul.firstElementChild).toBe(li);
      expect(li.tagName).toBe('LI');
      // Reuses the session-expired banner's look, nothing new.
      expect(li.classList.contains('account-status-banner')).toBe(true);
      expect(li.querySelector('.status-banner-icon')).not.toBeNull();
      expect(li.textContent).toContain(textKey);
      const buttons = li.querySelectorAll('button');
      expect(buttons).toHaveLength(1); // the action, and no dismiss control
      expect(buttons[0].classList.contains('banner-sign-in-btn')).toBe(true);
      expect(buttons[0].textContent).toBe(buttonKey);
    });
  }

  const NONE = [
    ['active', S.active], ['free', S.free], ['trial', S.trial], ['locked', S.locked],
    ['grace', S.grace], ['scheduled cancel', S.endsOn], ['no status', null], ['empty status', {}],
  ];
  for (const [label, status] of NONE) {
    it('no banner when ' + label, () => {
      const { _renderLicenseBanner } = bannerKit();
      const ul = newList();
      expect(_renderLicenseBanner(ul, status)).toBeNull();
      expect(ul.children).toHaveLength(0);
    });
  }

  it('held wins over past_due, should both ever be set', () => {
    const { _renderLicenseBanner } = bannerKit();
    const ul = newList();
    _renderLicenseBanner(ul, { ...S.unpaid, pastDue: true });
    expect(ul.textContent).toContain('popupLicenseUnpaid');
    expect(ul.textContent).not.toContain('popupLicensePastDue');
  });

  it('is only ever ONE li, and it leads the list', () => {
    const { _renderLicenseBanner } = bannerKit();
    const ul = newList();
    const header = document.createElement('li');
    header.className = 'account-section-header';
    ul.appendChild(header);
    _renderLicenseBanner(ul, S.pastDue);
    _renderLicenseBanner(ul, S.unpaid);
    expect(ul.querySelectorAll('.account-status-banner')).toHaveLength(1);
    expect(ul.firstElementChild.textContent).toContain('popupLicenseUnpaid');
    // A later "all clear" removes it.
    _renderLicenseBanner(ul, S.active);
    expect(ul.querySelectorAll('.account-status-banner')).toHaveLength(0);
    expect(ul.firstElementChild).toBe(header);
  });
});

describe('the Update payment method button', () => {
  it('asks the background for the portal URL and opens it in a new tab', async () => {
    const kit = bannerKit();
    const ul = newList();
    kit._renderLicenseBanner(ul, S.unpaid).querySelector('button').click();
    await flush();
    expect(kit.sent).toEqual(['GET_MANAGE_URLS']);
    expect(kit.tabs).toEqual([PAY_URL]);
    expect(kit.options()).toBe(0);
  });

  it('is disabled while the URL is being fetched, and a second click sends nothing', async () => {
    let release;
    const kit = bannerKit(() => new Promise((r) => { release = r; }));
    const btn = kit._renderLicenseBanner(newList(), S.pastDue).querySelector('button');
    btn.click();
    expect(btn.disabled).toBe(true);
    kit._openUpdatePayment(btn); // what a second click would run
    expect(kit.sent).toEqual(['GET_MANAGE_URLS']);
    release({ ok: true, update_payment_method: PAY_URL });
    await flush();
    expect(btn.disabled).toBe(false);
    expect(kit.tabs).toEqual([PAY_URL]);
  });

  it('never caches the URL: every click fetches a fresh one', async () => {
    // The portal token expires after about a day.
    const kit = bannerKit();
    const btn = kit._renderLicenseBanner(newList(), S.unpaid).querySelector('button');
    btn.click();
    await flush();
    btn.click();
    await flush();
    expect(kit.sent).toEqual(['GET_MANAGE_URLS', 'GET_MANAGE_URLS']);
    expect(kit.tabs).toEqual([PAY_URL, PAY_URL]);
  });

  const FALLBACKS = [
    ['the proxy refuses', { ok: false, error: 'manage_urls_unavailable' }],
    ['there is no update URL', { ok: true, update_payment_method: null, cancel: null }],
    ['the background is unreachable', new Error('Receiving end does not exist')],
    ['the answer is empty', null],
  ];
  for (const [label, answer] of FALLBACKS) {
    it('falls back to the options page when ' + label, async () => {
      const kit = bannerKit(answer);
      const btn = kit._renderLicenseBanner(newList(), S.unpaid).querySelector('button');
      btn.click();
      await flush();
      expect(kit.tabs).toEqual([]);
      expect(kit.options()).toBe(1);
      expect(btn.disabled).toBe(false);
    });
  }

  it('paused shows Settings, which opens the options page and fetches no portal URL', async () => {
    const kit = bannerKit();
    const btn = kit._renderLicenseBanner(newList(), S.paused).querySelector('button');
    expect(btn.textContent).toBe('settings');
    btn.click();
    await flush();
    expect(kit.options()).toBe(1);
    expect(kit.sent).toEqual([]);
    expect(kit.tabs).toEqual([]);
  });

  it('a click does not bubble into the list behind it', () => {
    const kit = bannerKit();
    const ul = newList();
    const onListClick = vi.fn();
    ul.addEventListener('click', onListClick);
    kit._renderLicenseBanner(ul, S.unpaid).querySelector('button').click();
    expect(onListClick).not.toHaveBeenCalled();
  });
});

describe('a held user is never sold a second subscription', () => {
  function headerBadge(premium) {
    const btnUpgrade = document.createElement('button');
    btnUpgrade.className = 'hidden';
    const { _renderPremiumHeaderBadge } = sandbox(['_renderPremiumHeaderBadge'], {
      btnUpgrade, ProtonI18n, _premium: premium, isPremium: () => !!premium.premium,
    });
    _renderPremiumHeaderBadge();
    return btnUpgrade;
  }

  it('the header Upgrade button is hidden while held', () => {
    expect(headerBadge(S.unpaid).classList.contains('hidden')).toBe(true);
    expect(headerBadge(S.paused).classList.contains('hidden')).toBe(true);
    // Held while the in-extension trial runs: still no upsell.
    expect(headerBadge({ ...S.unpaid, premium: true, trialing: true, trialActive: true })
      .classList.contains('hidden')).toBe(true);
  });

  it('but still shows for a free user and a trial user', () => {
    expect(headerBadge(S.free).classList.contains('hidden')).toBe(false);
    expect(headerBadge(S.trial).classList.contains('hidden')).toBe(false);
  });

  it('the header Upgrade click routes to the license action while held', () => {
    const at = POPUP.indexOf("btnUpgrade.addEventListener('click'");
    expect(at).toBeGreaterThan(-1);
    const handler = POPUP.slice(at, POPUP.indexOf('});', at));
    const heldAt = handler.search(/if \(_premium\.held\) \{ _runLicenseAction\(_premium\.held, btnUpgrade\); return; \}/);
    expect(heldAt).toBeGreaterThan(-1);
    expect(heldAt).toBeLessThan(handler.indexOf('PRICING_URL'));
  });

  function upgradeToast(premium, manage) {
    document.getElementById('upgrade-toast')?.remove();
    const b = makeBrowser(manage);
    const fns = sandbox([...BANNER_FNS, 'showUpgradePrompt'], {
      browser: b.browser, ProtonI18n, _premium: premium, PRICING_URL, TOAST_DURATION_MS: 5000,
    });
    fns.showUpgradePrompt('compose');
    return { ...b, btn: document.querySelector('#upgrade-toast .upgrade-toast-btn') };
  }

  it('the upgrade toast offers Update payment method while unpaid, and opens no pricing tab', async () => {
    const t = upgradeToast(S.unpaid);
    expect(t.btn.textContent).toBe('manageUpdatePayment');
    t.btn.click();
    await flush();
    expect(t.sent).toEqual(['GET_MANAGE_URLS']);
    expect(t.tabs).toEqual([PAY_URL]);
    expect(t.tabs).not.toContain(PRICING_URL);
  });

  it('the upgrade toast offers Settings while paused', async () => {
    const t = upgradeToast(S.paused);
    expect(t.btn.textContent).toBe('settings');
    t.btn.click();
    await flush();
    expect(t.options()).toBe(1);
    expect(t.tabs).toEqual([]);
  });

  it('the upgrade toast still sells Premium to a free user', async () => {
    const t = upgradeToast(S.free);
    expect(t.btn.textContent).toBe('upgrade');
    t.btn.click();
    await flush();
    expect(t.tabs).toEqual([PRICING_URL]);
    expect(t.sent).toEqual([]);
  });

  it('the locked-account header opens the license action while held, the pricing page otherwise', async () => {
    const accounts = [
      { id: 'a1', email: 'one@example.com', keysUnlocked: true },
      { id: 'a2', email: 'two@example.com', keysUnlocked: true },
    ];
    for (const [premium, expectTabs, expectSent] of [
      [S.unpaid, [PAY_URL], ['GET_MANAGE_URLS']],
      [S.free, [PRICING_URL], []],
    ]) {
      const v = listView(premium);
      v.renderMessages([], accounts);
      const locked = v.messageList.querySelector('.account-locked');
      expect(locked).not.toBeNull();
      locked.click();
      await flush();
      expect(v.tabs).toEqual(expectTabs);
      expect(v.sent).toEqual(expectSent);
    }
  });
});

/** renderMessages with its dependencies stubbed, for list-level assertions. */
function listView(premium) {
  document.body.textContent = '';
  const messageList = document.createElement('ul');
  messageList.className = 'message-list hidden';
  const emptyInbox = document.createElement('div');
  emptyInbox.className = 'state-message hidden';
  document.body.append(messageList, emptyInbox);
  const b = makeBrowser();
  const fns = sandbox([...BANNER_FNS, '_setHTML', 'renderMessages'], {
    browser: b.browser, ProtonI18n, _premium: premium, PRICING_URL,
    messageList, emptyInbox,
    isPremium: () => !!premium.premium,
    showPremiumUI: () => false,
    _luminance: () => 0.2,
    createMessageItem: (msg) => {
      const li = document.createElement('li');
      li.className = 'message-item';
      li.dataset.messageId = msg.ID;
      return li;
    },
    _syncCollapseAllBtn: () => {},
    _showReauthForm: () => {},
  }, ['_accountSections']);
  return { ...b, ...fns, messageList, emptyInbox };
}

describe('the banner is there in every list state', () => {
  it('above the account sections when there are accounts', () => {
    const v = listView(S.pastDue);
    v.renderMessages(
      [{ ID: 'm1', _accountId: 'a1', _accountEmail: 'one@example.com', Unread: 1 }],
      [{ id: 'a1', email: 'one@example.com', keysUnlocked: true }]);
    const first = v.messageList.firstElementChild;
    expect(first.classList.contains('account-status-banner')).toBe(true);
    expect(first.textContent).toContain('popupLicensePastDue');
    expect(first.nextElementSibling.classList.contains('account-section-header')).toBe(true);
    expect(v.messageList.querySelectorAll('.account-status-banner')).toHaveLength(1);
    // The banner is not a message: keyboard navigation (.message-item) skips it.
    expect(first.classList.contains('message-item')).toBe(false);
  });

  it('above every account, locked ones included, when held', () => {
    const v = listView(S.unpaid);
    v.renderMessages([], [
      { id: 'a1', email: 'one@example.com', keysUnlocked: true },
      { id: 'a2', email: 'two@example.com', keysUnlocked: true },
    ]);
    const items = [...v.messageList.children];
    expect(items[0].textContent).toContain('popupLicenseUnpaid');
    expect(items.filter((li) => li.classList.contains('account-status-banner'))).toHaveLength(1);
    expect(items.some((li) => li.classList.contains('account-locked'))).toBe(true);
  });

  it('in the empty view: the list stays visible, holding only the banner', () => {
    const v = listView(S.paused);
    v.renderMessages([], []);
    expect(v.emptyInbox.classList.contains('hidden')).toBe(false);
    expect(v.messageList.classList.contains('hidden')).toBe(false);
    expect(v.messageList.classList.contains('license-banner-only')).toBe(true);
    expect(v.messageList.children).toHaveLength(1);
    expect(v.messageList.textContent).toContain('popupLicensePaused');
  });

  it('the empty view without a license problem hides the list as before', () => {
    const v = listView(S.active);
    v.renderMessages([], []);
    expect(v.emptyInbox.classList.contains('hidden')).toBe(false);
    expect(v.messageList.classList.contains('hidden')).toBe(true);
    expect(v.messageList.children).toHaveLength(0);
  });

  it('a later render with accounts drops the banner-only sizing', () => {
    const v = listView(S.unpaid);
    v.renderMessages([], []);
    v.renderMessages([], [{ id: 'a1', email: 'one@example.com', keysUnlocked: true }]);
    expect(v.messageList.classList.contains('license-banner-only')).toBe(false);
    expect(v.emptyInbox.classList.contains('hidden')).toBe(true);
  });

  function errorView(premium) {
    document.body.textContent = '';
    const errorMessageEl = document.createElement('p');
    const errorLicenseBanner = document.createElement('ul');
    errorLicenseBanner.className = 'license-banner-list hidden';
    document.body.append(errorLicenseBanner, errorMessageEl);
    const shown = [];
    const fns = sandbox([...BANNER_FNS, '_showErrorState'], {
      browser: makeBrowser().browser, ProtonI18n, _premium: premium,
      showState: (s) => shown.push(s), errorMessageEl, errorLicenseBanner,
    });
    return { ...fns, shown, errorMessageEl, errorLicenseBanner };
  }

  it('in the error view, with its own list', () => {
    const v = errorView(S.unpaid);
    v._showErrorState('couldNotConnect');
    expect(v.shown).toEqual(['error']);
    expect(v.errorMessageEl.textContent).toBe('couldNotConnect');
    expect(v.errorLicenseBanner.classList.contains('hidden')).toBe(false);
    expect(v.errorLicenseBanner.children).toHaveLength(1);
    expect(v.errorLicenseBanner.textContent).toContain('popupLicenseUnpaid');
    // Shown again: still one banner.
    v._showErrorState('couldNotConnectBackground');
    expect(v.errorLicenseBanner.children).toHaveLength(1);
  });

  it('the error view without a license problem shows no banner', () => {
    const v = errorView(S.free);
    v._showErrorState('couldNotConnect');
    expect(v.errorLicenseBanner.classList.contains('hidden')).toBe(true);
    expect(v.errorLicenseBanner.children).toHaveLength(0);
  });

  it('both error paths go through _showErrorState', () => {
    // render()'s poll error and loadState()'s unreachable background.
    expect(lift('render')).toMatch(/_showErrorState\(ProtonI18n\.t\('couldNotConnect'\)\)/);
    expect(lift('loadState')).toMatch(/_showErrorState\(ProtonI18n\.t\('couldNotConnectBackground'\)\)/);
    // No error view is shown without its banner.
    expect(POPUP.match(/showState\('error'\)/g)).toHaveLength(1);
    expect(lift('_showErrorState')).toMatch(/showState\('error'\)/);
  });

  it('popup.html gives the error view its banner list', () => {
    const at = POPUP_HTML.indexOf('id="state-error"');
    expect(at).toBeGreaterThan(-1);
    const end = POPUP_HTML.indexOf('id="state-normal"', at);
    expect(POPUP_HTML.slice(at, end)).toMatch(/<ul id="error-license-banner" class="license-banner-list hidden"><\/ul>/);
  });

  it('renderMessages places the banner after clearing and before the account loop', () => {
    const fn = lift('renderMessages');
    const cleared = fn.indexOf("messageList.textContent = ''");
    const banner = fn.indexOf('_renderLicenseBanner(messageList, _premium)');
    const loop = fn.indexOf('for (let _idx = 0;');
    expect(cleared).toBeGreaterThan(-1);
    expect(banner).toBeGreaterThan(cleared);
    expect(loop).toBeGreaterThan(banner);
    // And before the empty-view early return.
    expect(banner).toBeLessThan(fn.indexOf('if (orderedIds.length === 0)'));
  });
});

describe('LICENSE_NUDGE on open', () => {
  it('is sent exactly once, from the popup start-up, not from a render path', () => {
    const sends = POPUP.match(/type: 'LICENSE_NUDGE'/g) || [];
    expect(sends).toHaveLength(1);
    for (const fn of ['render', 'renderMessages', 'loadState', '_reconcile', '_applyNudgedStatus']) {
      expect(lift(fn)).not.toMatch(/LICENSE_NUDGE/);
    }
    // Next to the initial showState('loading'), before the start-up chain.
    const at = POPUP.indexOf("type: 'LICENSE_NUDGE'");
    const boot = POPUP.lastIndexOf("showState('loading');", at);
    expect(boot).toBeGreaterThan(-1);
    expect(boot).toBeGreaterThan(POPUP.lastIndexOf('function ', at)); // top level, not in a function
    expect(at - boot).toBeLessThan(400);
    expect(POPUP.slice(at, at + 200)).toMatch(/\.catch\(/);
  });

  function nudgeKit(current, savedState, blocked = false) {
    const renders = [];
    const env = {
      _premium: current,
      _savedState: savedState,
      render: (s) => renders.push(s),
      _listRerenderBlocked: () => blocked,
    };
    const fns = sandbox(['_licenseBannerState', '_licenseViewKey', '_applyNudgedStatus'], env);
    return { ...fns, renders };
  }

  it('re-renders when Paddle has collected (held to active)', () => {
    const saved = { premium: S.unpaid, messages: [] };
    const k = nudgeKit(S.unpaid, saved);
    k._applyNudgedStatus(S.active);
    expect(k.renders).toHaveLength(1);
    expect(k.renders[0].premium).toBe(S.active);
  });

  it('re-renders when a renewal failed (active to past_due), though Premium stays on', () => {
    const saved = { premium: S.active, messages: [] };
    const k = nudgeKit(S.active, saved);
    k._applyNudgedStatus(S.pastDue);
    expect(k.renders).toHaveLength(1);
  });

  it('does not re-render when nothing on screen changes', () => {
    const saved = { premium: S.unpaid, messages: [] };
    const k = nudgeKit(S.unpaid, saved);
    k._applyNudgedStatus({ ...S.unpaid, lastValidatedAt: 123 });
    expect(k.renders).toHaveLength(0);
    // Kept for the next render anyway.
    expect(saved.premium.lastValidatedAt).toBe(123);
  });

  it('waits while a sub-view is open, but keeps the status for the next render', () => {
    const saved = { premium: S.unpaid, messages: [] };
    const k = nudgeKit(S.unpaid, saved, true);
    k._applyNudgedStatus(S.active);
    expect(k.renders).toHaveLength(0);
    expect(saved.premium).toBe(S.active);
  });

  it('ignores an answer before the first render, and a malformed one', () => {
    const k = nudgeKit(S.unpaid, null);
    k._applyNudgedStatus(S.active);
    expect(k.renders).toHaveLength(0);
    const k2 = nudgeKit(S.unpaid, { premium: S.unpaid });
    k2._applyNudgedStatus(null);
    k2._applyNudgedStatus('ok');
    expect(k2.renders).toHaveLength(0);
  });

  it('STATE_UPDATED and the nudge share one re-render guard', () => {
    const guard = lift('_listRerenderBlocked');
    expect(guard).toMatch(/composePanel/);
    expect(guard).toMatch(/stateAccounts\.classList\.contains\('hidden'\)/);
    expect(guard).toMatch(/_replyEditorOpen/);
    const at = POPUP.indexOf("msg.type !== 'STATE_UPDATED'");
    expect(POPUP.slice(at, at + 200)).toMatch(/if \(_listRerenderBlocked\(\)\) return;/);
  });
});

describe('the popup default status carries the new fields', () => {
  it('matches the getStatus() contract before the first answer arrives', () => {
    const src = liftObject('let', '_premium');
    const _premium = new Function(src.replace(/^let /, 'var ') + '\nreturn _premium;')();
    expect(_premium).toMatchObject({
      premium: false, licensed: false, trialing: false, trialAvailable: true,
      keyStored: false, held: null, pastDue: false, scheduledChange: null,
      nextBilledAt: null, trialActive: false, clearedReason: null,
    });
  });

  it('the banner keys are the contract names', () => {
    const T = new Function(liftObject('const', 'LICENSE_BANNER_TEXT') + '\nreturn LICENSE_BANNER_TEXT;')();
    expect(T).toEqual({
      pastDue: 'popupLicensePastDue',
      unpaid: 'popupLicenseUnpaid',
      paused: 'popupLicensePaused',
    });
  });
});
