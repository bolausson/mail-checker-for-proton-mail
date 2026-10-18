/**
 * @vitest-environment jsdom
 *
 * The options page's license UI.
 *
 * The background now reports more than "licensed or not": a key can be held
 * (payment not received, or paused) with Premium off and the key kept, a paying
 * customer's renewal can fail (past_due) with Premium kept, a cancel can be
 * scheduled, and a key the background removed on its own leaves a reason.
 * These tests render every one of those against the real options.html and the
 * real functions lifted out of options.js, with ProtonI18n stubbed to return
 * the key, so they do not depend on the translations.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const ROOT = join(__dirname, '..');
const SRC = readFileSync(join(ROOT, 'options', 'options.js'), 'utf-8');
const HTML = readFileSync(join(ROOT, 'options', 'options.html'), 'utf-8');
const BODY = HTML.slice(HTML.indexOf('<body>') + 6, HTML.lastIndexOf('</body>'));

// Index just past a string literal or line comment starting at i, or i itself
// when neither starts there. Keeps braces in strings and comments from
// unbalancing the scans below.
function skipLiteral(src, i) {
  const c = src[i];
  if (c === '/' && src[i + 1] === '/') {
    const nl = src.indexOf('\n', i);
    return nl === -1 ? src.length : nl;
  }
  if (c === '\'' || c === '"' || c === '`') {
    let j = i + 1;
    while (j < src.length && src[j] !== c) j += src[j] === '\\' ? 2 : 1;
    return j + 1;
  }
  return i;
}

function lift(name) {
  const start = SRC.search(new RegExp('(async )?function ' + name + '\\('));
  if (start === -1) throw new Error('not found: ' + name);
  let depth = 0;
  for (let i = SRC.indexOf('{', start); i < SRC.length; i++) {
    const next = skipLiteral(SRC, i);
    if (next !== i) { i = next - 1; continue; }
    if (SRC[i] === '{') depth++;
    else if (SRC[i] === '}') { depth--; if (depth === 0) return SRC.slice(start, i + 1); }
  }
  throw new Error('unbalanced braces reading ' + name);
}

// A `const NAME = ...;` or `let NAME = ...;` declaration, up to its own `;`.
// Anchored to a line start: a comment mentions "the const PREMIUM_ONLY_IDS".
function liftDecl(name) {
  const m = new RegExp('^[ \\t]*(const|let) ' + name + ' =', 'm').exec(SRC);
  if (!m) throw new Error('not found: ' + name);
  let depth = 0;
  for (let i = m.index; i < SRC.length; i++) {
    const next = skipLiteral(SRC, i);
    if (next !== i) { i = next - 1; continue; }
    const c = SRC[i];
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') depth--;
    else if (c === ';' && depth === 0) return SRC.slice(m.index, i + 1);
  }
  throw new Error('no end reading ' + name);
}

const DECLS = [
  'PREMIUM_ONLY_IDS', '_renderedStatus', '_premiumSectionAutoOpened',
  'LICENSE_SCHEDULE_KEYS', 'LICENSE_RELOAD_DEBOUNCE_MS', '_licenseReloadTimer',
  'RETURN_CHECK_WINDOW_MS', 'RETURN_CHECK_MIN_GAP_MS', '_manageOpenedAt', '_lastReturnCheckAt',
  'SUPPORT_EMAIL', 'MANAGE_CACHE_TTL_MS', '_manageUrlsCache', '_manageUrlsCacheFetchedAt',
  'VALIDATE_MIN_MS', 'VALIDATE_RESULT_MS', '_validateResultTimer',
];
const FUNCS = [
  'loadPremium', 'applyPremiumLocks', '_trialDaysPhrase', '_renderStatusLine',
  '_maybeAutoOpenPremium', 'renderPremium', '_errLabel', '_sentence', '_supportLink', '_renderValidationNotice',
  '_formatValidationTime', '_formatPeriodDate', '_showValidateResult', '_runValidateNow',
  '_onLicenseStorageChanged', '_needsPaymentAction', '_maybeRevalidateOnReturn',
  '_sendLicenseNudge', '_getManageUrls', '_showManageNotice', '_clearManageNotice',
  '_handleManageClick',
];
const HARNESS = DECLS.map(liftDecl).join('\n') + '\n' + FUNCS.map(lift).join('\n\n') + `
  return {
    renderPremium, loadPremium, _errLabel, _sentence, _onLicenseStorageChanged,
    _maybeRevalidateOnReturn, _runValidateNow, _sendLicenseNudge, _handleManageClick,
    get manageOpenedAt() { return _manageOpenedAt; },
  };`;

// t() answers the key, like the real one does for a missing key. Templates
// and the few labels the tests need to tell apart get text.
// The lowercase labels stand for the 27 locales whose err_ labels are
// fragments written for the grace notice's ({reason}) slot.
const DICT = {
  trialBannerTitle: 'trial {days}',
  validationGrace: 'grace {days} ({reason})',
  validationGraceUnconfirmed: 'unconfirmed {days}',
  validationLockedUnconfirmed: 'locked unconfirmed',
  err_license_unconfirmed: 'cle non confirmee',
  noticeEndsOn: 'ends {date}',
  err_paddle_unreachable: 'Paddle is unreachable',
  err_proxy_unreachable: 'our validation server is unreachable',
  err_subscription_canceled: 'This subscription has been canceled.',
  err_subscription_not_found: 'abonnement introuvable',
  err_subscription_inactive: 'abonnement inactif',
  err_subscription_paused: 'Resume it in the Paddle customer portal.',
};
const I18N = {
  t: (k) => (k in DICT ? DICT[k] : k),
  plural: (k, n) => n + ' ' + k,
};

const NOW = Date.parse('2026-09-23T12:00:00Z');

// Loads the page fresh, as a page load would: new closure state every time.
function build(replies = {}) {
  const sent = [];
  const tabs = [];
  const sendMessage = vi.fn(async (msg) => {
    sent.push(msg.type);
    const r = replies[msg.type];
    if (r instanceof Error) throw r;
    return typeof r === 'function' ? r(msg) : r;
  });
  const browser = {
    runtime: { sendMessage },
    tabs: { create: (o) => { tabs.push(o.url); } },
  };
  const quiet = { warn: vi.fn(), error: vi.fn(), log: vi.fn() };
  const api = new Function('browser', 'ProtonI18n', 'document', 'console', HARNESS)(
    browser, I18N, document, quiet);
  return { api, sent, tabs, sendMessage, replies, quiet };
}

const $ = (id) => document.getElementById(id);
const isHidden = (id) => $(id).classList.contains('hidden');

const FREE = {
  premium: false, licensed: false, locked: false,
  trialing: false, trialExpired: false, trialAvailable: true, trialDaysRemaining: 0,
  licenseKeyMasked: null, lastValidatedAt: null, lastValidationError: null,
  lastValidationStatus: null, firstFailedAt: null, graceRemainingDays: 0,
  inGracePeriod: false, billingInterval: null, periodStart: null, periodEnd: null,
  keyStored: false, held: null, pastDue: false, scheduledChange: null,
  nextBilledAt: null, trialActive: false, clearedReason: null,
};
const ACTIVE = {
  ...FREE, premium: true, licensed: true, trialAvailable: false, keyStored: true,
  licenseKeyMasked: 'sub_01ab…wxyz', lastValidatedAt: NOW - 60 * 1000,
  lastValidationStatus: 'active', billingInterval: 'month',
  periodStart: '2026-09-01T00:00:00Z', periodEnd: '2026-10-01T00:00:00Z',
  nextBilledAt: '2026-10-01T00:00:00Z',
};
const PAST_DUE = { ...ACTIVE, pastDue: true, lastValidationStatus: 'past_due' };
// Held: key kept, Premium off, and neither licensed, locked nor in grace.
const UNPAID = { ...ACTIVE, premium: false, licensed: false, held: 'unpaid', lastValidationStatus: 'past_due' };
const PAUSED = { ...UNPAID, held: 'paused', lastValidationStatus: 'paused' };
const GRACE = {
  ...ACTIVE, inGracePeriod: true, graceRemainingDays: 12,
  firstFailedAt: NOW - 18 * 86400000, lastValidationError: 'paddle_unreachable',
};
const LOCKED = {
  ...GRACE, premium: false, licensed: false, locked: true, inGracePeriod: false, graceRemainingDays: 0,
};
const ENDS = { ...ACTIVE, scheduledChange: { action: 'cancel', effective_at: '2026-10-01T00:00:00Z' } };

function localDate(iso) {
  return new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

beforeEach(() => {
  vi.useFakeTimers({ now: NOW });
  document.body.className = '';
  document.body.innerHTML = BODY;
});
afterEach(() => {
  vi.useRealTimers();
});

// Let a chain of resolved promises settle (no timers involved).
async function settle() {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

describe('the status line', () => {
  const cases = [
    ['free', FREE, 'freeTier', ''],
    ['a running trial', { ...FREE, trialing: true, trialActive: true, trialDaysRemaining: 5, premium: true, trialAvailable: false }, 'trial 5 dayCount', 'trial'],
    ['an expired trial', { ...FREE, trialExpired: true, trialAvailable: false }, 'trialExpired', 'expired'],
    ['an active license', ACTIVE, 'premiumActive', 'active'],
    ['a locked license', LOCKED, 'licenseLocked', 'expired'],
    ['a failed renewal (orange, the trial colour)', PAST_DUE, 'statusPaymentFailed', 'trial'],
    ['a payment not received (red)', UNPAID, 'statusFirstPaymentFailed', 'expired'],
    ['a paused subscription (red)', PAUSED, 'statusPaused', 'expired'],
  ];
  for (const [label, status, text, mod] of cases) {
    it('shows ' + label, () => {
      build().api.renderPremium(status);
      const el = $('premium-status-value');
      expect(el.textContent).toBe(text);
      expect(el.className).toBe('premium-status__value' + (mod ? ' premium-status__value--' + mod : ''));
    });
  }

  it('shows the trial days instead of the held label while the trial still runs', () => {
    // Premium is really on (from the trial): "Payment not received" in red
    // would say otherwise. The notice still names the held reason.
    build().api.renderPremium({ ...UNPAID, premium: true, trialActive: true, trialDaysRemaining: 3 });
    expect($('premium-status-value').textContent).toBe('trial 3 dayCount');
    expect($('premium-status-value').className).toContain('premium-status__value--trial');
    expect($('license-validation-notice').textContent).toBe('noticeUnpaid');

    build().api.renderPremium({ ...PAUSED, premium: true, trialActive: true, trialDaysRemaining: 3 });
    expect($('premium-status-value').textContent).toBe('trial 3 dayCount');
    expect($('license-validation-notice').textContent).toContain('noticePaused');
  });

  it('never says "Premium active, payment failed" once the key is locked', () => {
    build().api.renderPremium({ ...LOCKED, pastDue: true });
    expect($('premium-status-value').textContent).toBe('licenseLocked');
  });

  it('takes Premium on or off from status.premium, never from the held state', () => {
    const { api } = build();
    api.renderPremium(UNPAID);
    expect(document.body.classList.contains('is-free')).toBe(true);
    api.renderPremium({ ...UNPAID, premium: true, trialActive: true, trialDaysRemaining: 2 });
    expect(document.body.classList.contains('is-premium')).toBe(true);
    expect($('poll-interval').disabled).toBe(false);
  });
});

describe('the banner, the key block and the rows', () => {
  it('hides the upgrade banner when licensed or held, so a held user is not sold a second subscription', () => {
    const { api } = build();
    api.renderPremium(FREE);
    expect(isHidden('premium-banner')).toBe(false);
    api.renderPremium(ACTIVE);
    expect(isHidden('premium-banner')).toBe(true);
    api.renderPremium(PAST_DUE);
    expect(isHidden('premium-banner')).toBe(true);
    api.renderPremium(UNPAID);
    expect(isHidden('premium-banner')).toBe(true);
    api.renderPremium(PAUSED);
    expect(isHidden('premium-banner')).toBe(true);
    // Unchanged: a locked key still sees it.
    api.renderPremium(LOCKED);
    expect(isHidden('premium-banner')).toBe(false);
  });

  it('shows the stored key block from keyStored, including for a held key', () => {
    const { api } = build();
    api.renderPremium(UNPAID);
    expect(isHidden('license-active-group')).toBe(false);
    expect(isHidden('license-entry-group')).toBe(true);
    expect($('license-key-masked').textContent).toBe('sub_01ab…wxyz');

    api.renderPremium(FREE);
    expect(isHidden('license-active-group')).toBe(true);
    expect(isHidden('license-entry-group')).toBe(false);
  });

  it('shows Start trial only when the background offers one', () => {
    const { api } = build();
    api.renderPremium(FREE);
    expect(isHidden('btn-start-trial')).toBe(false);
    api.renderPremium({ ...FREE, trialAvailable: false });
    expect(isHidden('btn-start-trial')).toBe(true);
  });

  it('hides the current period while a payment is outstanding, and keeps the plan', () => {
    const { api } = build();
    api.renderPremium(ACTIVE);
    expect(isHidden('license-period-row')).toBe(false);
    expect($('license-period').textContent)
      .toBe(localDate(ACTIVE.periodStart) + ' - ' + localDate(ACTIVE.periodEnd));

    for (const s of [PAST_DUE, UNPAID, PAUSED]) {
      api.renderPremium(s);
      expect(isHidden('license-period-row')).toBe(true);
      expect(isHidden('license-plan-row')).toBe(false);
    }
  });

  it('hides Update payment only while paused', () => {
    const { api } = build();
    api.renderPremium(PAUSED);
    expect(isHidden('btn-manage-payment')).toBe(true);
    expect(isHidden('btn-manage-cancel')).toBe(false);
    for (const s of [UNPAID, PAST_DUE, ACTIVE]) {
      api.renderPremium(s);
      expect(isHidden('btn-manage-payment')).toBe(false);
    }
  });
});

describe('the license notice', () => {
  function notice(status) {
    build().api.renderPremium(status);
    const el = $('license-validation-notice');
    return {
      el,
      text: el.textContent,
      kind: ['error', 'warning', 'info'].find(k => el.classList.contains('license-validation__notice--' + k)) || null,
      hidden: el.classList.contains('hidden'),
    };
  }

  it('is hidden when everything is healthy', () => {
    expect(notice(ACTIVE).hidden).toBe(true);
  });

  it('explains a payment that was not received', () => {
    const n = notice(UNPAID);
    expect(n).toMatchObject({ text: 'noticeUnpaid', kind: 'error', hidden: false });
  });

  it('explains a paused subscription and follows it with the untranslated support link', () => {
    const n = notice(PAUSED);
    expect(n.kind).toBe('error');
    expect(n.el.firstChild.nodeType).toBe(3);
    expect(n.el.firstChild.textContent).toBe('noticePaused ');
    const link = n.el.querySelector('a');
    expect(link.getAttribute('href')).toBe('mailto:support+mcpm@olausson.de');
    expect(link.textContent).toBe('support+mcpm@olausson.de');
    expect(n.el.lastChild).toBe(link);
    expect(link.getAttribute('rel')).toBe('noopener');
  });

  it('says why a locked key is locked, falling back to a readable label', () => {
    expect(notice(LOCKED)).toMatchObject({ text: 'validationLocked (Paddle is unreachable)', kind: 'error' });
    // An unknown code used to show verbatim: t() answers a missing key with the key.
    expect(notice({ ...LOCKED, lastValidationError: 'subscription_unpaid' }).text)
      .toBe('validationLocked (err_validation_problem)');
    expect(notice({ ...LOCKED, lastValidationError: null }).text).toBe('validationLocked');
  });

  it('fills the grace notice with the days and a readable reason', () => {
    expect(notice(GRACE)).toMatchObject({ text: 'grace 12 dayCount (Paddle is unreachable)', kind: 'warning' });
    expect(notice({ ...GRACE, lastValidationError: 'subscription_unpaid' }).text)
      .toBe('grace 12 dayCount (err_validation_problem)');
    expect(notice({ ...GRACE, lastValidationError: null }).text)
      .toBe('grace 12 dayCount (err_validation_problem)');
  });

  it('gives a key Paddle cannot confirm its own grace notice', () => {
    expect(notice({ ...GRACE, lastValidationError: 'license_unconfirmed' }))
      .toMatchObject({ text: 'unconfirmed 12 dayCount', kind: 'warning' });
  });

  it('gives a key Paddle cannot confirm its own locked notice, without a ({reason}) tail', () => {
    expect(notice({ ...LOCKED, lastValidationError: 'license_unconfirmed' }))
      .toMatchObject({ text: 'locked unconfirmed', kind: 'error' });
    // Every other reason keeps the generic notice and its tail.
    expect(notice(LOCKED).text).toBe('validationLocked (Paddle is unreachable)');
  });

  it('warns about a failed renewal', () => {
    expect(notice(PAST_DUE)).toMatchObject({ text: 'noticePastDue', kind: 'warning' });
  });

  it('gives the date a scheduled cancel takes effect, as information', () => {
    expect(notice(ENDS)).toMatchObject({ text: 'ends ' + localDate('2026-10-01T00:00:00Z'), kind: 'info' });
    // Only a cancel ends the subscription.
    expect(notice({ ...ACTIVE, scheduledChange: { action: 'pause', effective_at: '2026-10-01T00:00:00Z' } }).hidden).toBe(true);
    expect(notice({ ...ACTIVE, scheduledChange: { action: 'cancel', effective_at: 'not a date' } }).hidden).toBe(true);
  });

  it('shows the first that applies: held, locked, grace, past_due, ends-on', () => {
    const cancel = { scheduledChange: ENDS.scheduledChange };
    expect(notice({ ...UNPAID, ...cancel }).text).toBe('noticeUnpaid');
    expect(notice({ ...PAUSED, ...cancel }).text).toContain('noticePaused');
    expect(notice({ ...LOCKED, pastDue: true, ...cancel }).text).toContain('validationLocked');
    expect(notice({ ...GRACE, pastDue: true, ...cancel }).text).toContain('grace');
    expect(notice({ ...PAST_DUE, ...cancel }).text).toBe('noticePastDue');
  });

  it('is text only: no button of its own', () => {
    for (const s of [UNPAID, PAUSED, LOCKED, GRACE, PAST_DUE, ENDS]) {
      expect(notice(s).el.querySelector('button')).toBeNull();
    }
  });
});

describe('the reason a key was cleared', () => {
  it('lives in the key entry group', () => {
    expect($('license-entry-group').contains($('license-cleared-notice'))).toBe(true);
  });

  it('shows the translated reason next to the key field', () => {
    build().api.renderPremium({ ...FREE, clearedReason: 'subscription_canceled' });
    expect(isHidden('license-cleared-notice')).toBe(false);
    expect($('license-cleared-notice').textContent).toBe('This subscription has been canceled.');
  });

  it('never shows a raw key for a code without a label', () => {
    build().api.renderPremium({ ...FREE, clearedReason: 'subscription_mystery' });
    expect($('license-cleared-notice').textContent).toBe('Abonnement inactif');
  });

  it('starts a lowercase fragment label with a capital letter', () => {
    // "abonnement introuvable" reads like a torn-off phrase on its own.
    build().api.renderPremium({ ...FREE, clearedReason: 'subscription_not_found' });
    expect($('license-cleared-notice').textContent).toBe('Abonnement introuvable');
  });

  it('sends a key 1.14.x cleared as paused to support, not to the Paddle portal', () => {
    build().api.renderPremium({ ...FREE, clearedReason: 'subscription_paused' });
    const el = $('license-cleared-notice');
    expect(isHidden('license-cleared-notice')).toBe(false);
    expect(el.textContent).toBe('statusPaused (support+mcpm@olausson.de)');
    expect(el.textContent).not.toContain('Paddle');
    const link = el.querySelector('a');
    expect(link.getAttribute('href')).toBe('mailto:support+mcpm@olausson.de');
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toBe('noopener');
  });

  it('drops the support link when the reason changes', () => {
    const { api } = build();
    api.renderPremium({ ...FREE, clearedReason: 'subscription_paused' });
    api.renderPremium({ ...FREE, clearedReason: 'subscription_canceled' });
    expect($('license-cleared-notice').querySelector('a')).toBeNull();
    expect($('license-cleared-notice').textContent).toBe('This subscription has been canceled.');
  });

  it('is hidden without a reason, and while a key is stored', () => {
    const { api } = build();
    api.renderPremium({ ...FREE, clearedReason: 'subscription_canceled' });
    api.renderPremium(FREE);
    expect(isHidden('license-cleared-notice')).toBe(true);
    api.renderPremium({ ...ACTIVE, clearedReason: 'subscription_canceled' });
    expect(isHidden('license-cleared-notice')).toBe(true);
  });
});

describe('_errLabel', () => {
  it('uses the err_ label when there is one, else the fallback', () => {
    const { api } = build();
    expect(api._errLabel('paddle_unreachable', 'err_validation_problem')).toBe('Paddle is unreachable');
    expect(api._errLabel('subscription_unpaid', 'err_validation_problem')).toBe('err_validation_problem');
    expect(api._errLabel(null, 'licenseActivationFailed')).toBe('licenseActivationFailed');
    expect(api._errLabel('', 'licenseActivationFailed')).toBe('licenseActivationFailed');
  });

  it('is what the activation path uses, with licenseActivationFailed as the fallback', () => {
    const start = SRC.indexOf("btnActivate.addEventListener('click'");
    const handler = SRC.slice(start, SRC.indexOf('licenseInput.addEventListener', start));
    // Shown on its own under the key field, so as a sentence.
    expect(handler).toContain("_sentence(_errLabel(code, 'licenseActivationFailed'))");
    // The old fallback that printed the raw code.
    expect(handler).not.toMatch(/\?\s*localized\s*:\s*code/);
  });

  it('leaves no raw "err_" + code lookup behind in the notices', () => {
    expect(SRC).not.toMatch(/ProtonI18n\.t\('err_' \+ \w+\)\s*\|\|/);
  });
});

describe('_sentence', () => {
  it('capitalizes the first letter only', () => {
    const { api } = build();
    expect(api._sentence('abonnement introuvable')).toBe('Abonnement introuvable');
    expect(api._sentence('This subscription has been canceled.')).toBe('This subscription has been canceled.');
    expect(api._sentence('')).toBe('');
    expect(api._sentence(null)).toBe(null);
  });

  it('leaves the fragment lowercase inside the grace notice\'s ({reason}) slot', () => {
    build().api.renderPremium({ ...GRACE, lastValidationError: 'proxy_unreachable' });
    expect($('license-validation-notice').textContent).toBe('grace 12 dayCount (our validation server is unreachable)');
    build().api.renderPremium({ ...LOCKED, lastValidationError: 'proxy_unreachable' });
    expect($('license-validation-notice').textContent).toBe('validationLocked (our validation server is unreachable)');
  });
});

describe('the heading above a stored key', () => {
  const heading = () => $('license-active-group').querySelector('label');

  it.each([
    ['held unpaid', UNPAID, 'licenseKey'],
    ['held paused', PAUSED, 'licenseKey'],
    ['locked', LOCKED, 'licenseKey'],
    ['active', ACTIVE, 'activeLicense'],
    ['past_due (Premium kept)', PAST_DUE, 'activeLicense'],
    ['in grace (Premium kept)', GRACE, 'activeLicense'],
  ])('%s', (_label, status, key) => {
    build().api.renderPremium(status);
    expect(heading().textContent).toBe(key);
    // So a later applyTranslations() does not put "Active license" back.
    expect(heading().getAttribute('data-i18n')).toBe(key);
  });

  it('goes back to "Active license" once the key is paid for', () => {
    const { api } = build();
    api.renderPremium(UNPAID);
    api.renderPremium(ACTIVE);
    expect(heading().textContent).toBe('activeLicense');
  });
});

describe('opening the Premium section by itself', () => {
  const actionable = [['unpaid', UNPAID], ['paused', PAUSED], ['past_due', PAST_DUE], ['locked', LOCKED], ['grace', GRACE]];
  for (const [label, status] of actionable) {
    it('opens for ' + label, () => {
      build().api.renderPremium(status);
      expect($('premium-section').open).toBe(true);
    });
  }

  const informational = [
    ['a cleared key', { ...FREE, clearedReason: 'subscription_canceled' }],
    ['a scheduled cancel', ENDS],
    ['an active license', ACTIVE],
    ['the free tier', FREE],
  ];
  for (const [label, status] of informational) {
    it('stays closed for ' + label, () => {
      build().api.renderPremium(status);
      expect($('premium-section').open).toBe(false);
    });
  }

  it('opens once per page load, so closing it sticks', () => {
    const { api } = build();
    api.renderPremium(ACTIVE);
    api.renderPremium(PAST_DUE);
    expect($('premium-section').open).toBe(true);
    $('premium-section').open = false;
    api.renderPremium(PAST_DUE);
    api.renderPremium(UNPAID);
    expect($('premium-section').open).toBe(false);

    // A new page load starts over.
    build().api.renderPremium(PAST_DUE);
    expect($('premium-section').open).toBe(true);
  });
});

describe('_onLicenseStorageChanged', () => {
  const change = (...keys) => Object.fromEntries(keys.map(k => [k, { newValue: 1 }]));

  it('re-reads the status once for a burst of license writes, after the debounce', async () => {
    const { api, sent } = build({ GET_PREMIUM_STATUS: PAST_DUE });
    api._onLicenseStorageChanged(change('_licLastValidatedAt', '_licLastStatus'), 'local');
    api._onLicenseStorageChanged(change('_licFirstFailedAt'), 'local');
    api._onLicenseStorageChanged(change('_premiumKey'), 'local');
    vi.advanceTimersByTime(249);
    expect(sent).toEqual([]);
    vi.advanceTimersByTime(1);
    await settle();
    expect(sent).toEqual(['GET_PREMIUM_STATUS']);
    expect($('premium-status-value').textContent).toBe('statusPaymentFailed');
  });

  it('reacts to the key and the trial as well as the _lic keys', () => {
    for (const key of ['_premiumKey', '_trialEnd', '_licScheduledChange', '_licConfirmedKey']) {
      const { api, sent } = build({ GET_PREMIUM_STATUS: ACTIVE });
      api._onLicenseStorageChanged(change(key), 'local');
      vi.advanceTimersByTime(250);
      expect(sent).toEqual(['GET_PREMIUM_STATUS']);
    }
  });

  it('ignores other areas, other keys and the local-only scheduling stamps', () => {
    const { api, sent } = build({ GET_PREMIUM_STATUS: ACTIVE });
    api._onLicenseStorageChanged(change('_licLastStatus'), 'sync');
    api._onLicenseStorageChanged(change('settings', 'accounts'), 'local');
    api._onLicenseStorageChanged(
      change('_licNextCheckAt', '_licFollowUpUntil', '_licFollowUpStep', '_licLastNudgeAt'), 'local');
    api._onLicenseStorageChanged(undefined, 'local');
    vi.advanceTimersByTime(10000);
    expect(sent).toEqual([]);
  });

  it('cannot loop: re-rendering only reads, it never validates or nudges', async () => {
    const { api, sent } = build({ GET_PREMIUM_STATUS: UNPAID });
    api._onLicenseStorageChanged(change('_licLastStatus'), 'local');
    await vi.advanceTimersByTimeAsync(10000);
    await settle();
    expect(sent).toEqual(['GET_PREMIUM_STATUS']);
  });

  it('is registered on storage.onChanged', () => {
    expect(SRC).toContain('browser.storage.onChanged.addListener(_onLicenseStorageChanged)');
  });
});

describe('_maybeRevalidateOnReturn', () => {
  const MANAGE = { ok: true, update_payment_method: 'https://portal.example/pay', cancel: 'https://portal.example/cancel' };

  async function afterManageClick(status, extra = {}) {
    const h = build({ GET_MANAGE_URLS: MANAGE, GET_PREMIUM_STATUS: status, VALIDATE_LICENSE: { ok: true }, ...extra });
    h.api.renderPremium(status);
    await h.api._handleManageClick('payment');
    expect(h.tabs).toEqual(['https://portal.example/pay']);
    h.sent.length = 0;
    return h;
  }

  it('does nothing without a Manage click', () => {
    const { api, sent } = build({ GET_PREMIUM_STATUS: PAST_DUE });
    api.renderPremium(PAST_DUE);
    expect(api._maybeRevalidateOnReturn(Date.now())).toBeNull();
    expect(sent).toEqual([]);
  });

  it('re-validates on return while past_due, at most once a minute, for 30 minutes', async () => {
    const { api, sent } = await afterManageClick(PAST_DUE);
    const t0 = Date.now();
    expect(api.manageOpenedAt).toBe(t0);

    await api._maybeRevalidateOnReturn(t0 + 5000);
    expect(sent).toEqual(['VALIDATE_LICENSE', 'GET_PREMIUM_STATUS']);

    // focus and visibilitychange arrive together: the second is dropped.
    expect(api._maybeRevalidateOnReturn(t0 + 5001)).toBeNull();
    expect(api._maybeRevalidateOnReturn(t0 + 64999)).toBeNull();
    expect(sent).toHaveLength(2);

    await api._maybeRevalidateOnReturn(t0 + 65000);
    expect(sent).toHaveLength(4);

    // Past the 30-minute window.
    expect(api._maybeRevalidateOnReturn(t0 + 30 * 60000 + 1)).toBeNull();
    expect(sent).toHaveLength(4);
  });

  it('works for a held key too', async () => {
    for (const status of [UNPAID, PAUSED]) {
      const { api, sent } = await afterManageClick(status);
      await api._maybeRevalidateOnReturn(Date.now() + 2000);
      expect(sent[0]).toBe('VALIDATE_LICENSE');
    }
  });

  it('stops once the state leaves hold or past_due', async () => {
    const h = await afterManageClick(UNPAID);
    const t0 = Date.now();
    h.replies.GET_PREMIUM_STATUS = ACTIVE;
    await h.api._maybeRevalidateOnReturn(t0 + 2000);
    expect($('premium-status-value').textContent).toBe('premiumActive');

    h.sent.length = 0;
    expect(h.api._maybeRevalidateOnReturn(t0 + 5 * 60000)).toBeNull();
    expect(h.sent).toEqual([]);
    expect(h.api.manageOpenedAt).toBe(0);
  });

  it('does not re-validate when nothing needed fixing', async () => {
    const { api, sent } = await afterManageClick(ACTIVE);
    expect(api._maybeRevalidateOnReturn(Date.now() + 2000)).toBeNull();
    expect(sent).toEqual([]);
  });

  it('still re-reads the status when the validation message fails', async () => {
    const { api, sent, quiet } = await afterManageClick(PAST_DUE, { VALIDATE_LICENSE: new Error('Receiving end does not exist') });
    await api._maybeRevalidateOnReturn(Date.now() + 2000);
    expect(sent).toEqual(['VALIDATE_LICENSE', 'GET_PREMIUM_STATUS']);
    expect(quiet.warn).toHaveBeenCalled();
  });

  it('is armed only when a portal tab actually opened', async () => {
    const h = build({ GET_MANAGE_URLS: { ok: false, error: 'manage_urls_unavailable' }, GET_PREMIUM_STATUS: PAST_DUE });
    h.api.renderPremium(PAST_DUE);
    await h.api._handleManageClick('payment');
    expect(h.tabs).toEqual([]);
    expect(h.api.manageOpenedAt).toBe(0);
  });

  it('runs on focus and on the page becoming visible', () => {
    expect(SRC).toMatch(/window\.addEventListener\('focus', \(\) => _maybeRevalidateOnReturn\(Date\.now\(\)\)\)/);
    expect(SRC).toMatch(/addEventListener\('visibilitychange'[\s\S]{0,160}_maybeRevalidateOnReturn\(Date\.now\(\)\)/);
  });
});

describe('_runValidateNow', () => {
  function button() {
    const btn = $('btn-validate-now');
    btn.textContent = 'validateNow';
    return btn;
  }
  // "Validating..." stays up at least this long (VALIDATE_MIN_MS in options.js);
  // the timers are fake in this file, so the tests move the clock.
  const MIN_MS = 600;
  async function run(api, btn) {
    const p = api._runValidateNow(btn);
    await vi.advanceTimersByTimeAsync(MIN_MS);
    await p;
  }
  const result = () => ({
    text: $('license-validate-result').textContent,
    hidden: isHidden('license-validate-result'),
    ok: $('license-validate-result').classList.contains('license-validation__result--ok'),
  });

  it('shows progress, then hands the button back and re-reads the status', async () => {
    let seenWhileRunning = null;
    const btn = button();
    const { api, sent } = build({
      VALIDATE_LICENSE: () => { seenWhileRunning = { disabled: btn.disabled, text: btn.textContent }; return { result: { ok: true } }; },
      GET_PREMIUM_STATUS: ACTIVE,
    });
    await run(api, btn);
    expect(seenWhileRunning).toEqual({ disabled: true, text: 'validating' });
    expect(btn.disabled).toBe(false);
    expect(btn.textContent).toBe('validateNow');
    expect(sent).toEqual(['VALIDATE_LICENSE', 'GET_PREMIUM_STATUS']);
  });

  it('hands the button back even when the message is rejected, and says the check failed', async () => {
    const btn = button();
    const { api, sent } = build({ VALIDATE_LICENSE: new Error('Receiving end does not exist'), GET_PREMIUM_STATUS: LOCKED });
    await run(api, btn);
    expect(btn.disabled).toBe(false);
    expect(btn.textContent).toBe('validateNow');
    expect(sent).toEqual(['VALIDATE_LICENSE', 'GET_PREMIUM_STATUS']);
    expect(result()).toEqual({ text: 'licenseNotConfirmed', hidden: false, ok: false });
  });

  it('keeps "Validating" up for a moment even when the check answers at once', async () => {
    const btn = button();
    const { api } = build({ VALIDATE_LICENSE: { result: { ok: true } }, GET_PREMIUM_STATUS: ACTIVE });
    const p = api._runValidateNow(btn);
    await vi.advanceTimersByTimeAsync(MIN_MS - 100);
    expect(btn.textContent).toBe('validating');
    expect(btn.disabled).toBe(true);
    await vi.advanceTimersByTimeAsync(100);
    await p;
    expect(btn.textContent).toBe('validateNow');
  });

  it('says the license is confirmed, then clears that after a few seconds', async () => {
    const btn = button();
    const { api } = build({ VALIDATE_LICENSE: { result: { ok: true }, status: ACTIVE }, GET_PREMIUM_STATUS: ACTIVE });
    await run(api, btn);
    expect(result()).toEqual({ text: 'licenseConfirmed', hidden: false, ok: true });
    await vi.advanceTimersByTimeAsync(6000);
    expect(result().hidden).toBe(true);
  });

  it('says it could not confirm the license when the check fails', async () => {
    const btn = button();
    const { api } = build({ VALIDATE_LICENSE: { result: { ok: false, error: 'paddle_unreachable' } }, GET_PREMIUM_STATUS: GRACE });
    await run(api, btn);
    expect(result()).toEqual({ text: 'licenseNotConfirmed', hidden: false, ok: false });
  });

  it('clears the previous outcome when a new check starts', async () => {
    const btn = button();
    const { api } = build({ VALIDATE_LICENSE: { result: { ok: true } }, GET_PREMIUM_STATUS: ACTIVE });
    await run(api, btn);
    expect(result().hidden).toBe(false);
    const p = api._runValidateNow(btn);
    expect(result().hidden).toBe(true);
    await vi.advanceTimersByTimeAsync(MIN_MS);
    await p;
    expect(result().hidden).toBe(false);
  });

  it('is what the Validate now button runs', () => {
    expect(SRC).toContain("btnValidateNow.addEventListener('click', () => _runValidateNow(btnValidateNow))");
  });
});

describe('LICENSE_NUDGE on open', () => {
  it('sends the nudge and renders the status it answers with', async () => {
    const { api, sent } = build({ LICENSE_NUDGE: { ok: true, status: PAST_DUE } });
    await api._sendLicenseNudge();
    expect(sent).toEqual(['LICENSE_NUDGE']);
    expect($('premium-status-value').textContent).toBe('statusPaymentFailed');
  });

  it('swallows a failed nudge', async () => {
    const { api, quiet } = build({ LICENSE_NUDGE: new Error('Receiving end does not exist') });
    await expect(api._sendLicenseNudge()).resolves.toBeUndefined();
    expect(quiet.warn).toHaveBeenCalled();
  });

  it('ignores an answer without a status', async () => {
    const { api } = build({ LICENSE_NUDGE: { ok: false, error: 'internal_error' } });
    await api._sendLicenseNudge();
    expect($('premium-status-value').textContent).toBe('-');
  });

  it('is sent exactly once, when the page opens', () => {
    const calls = SRC.match(/^\s*_sendLicenseNudge\(\);/gm) || [];
    expect(calls).toHaveLength(1);
  });
});
