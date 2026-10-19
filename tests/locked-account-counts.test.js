/**
 * @vitest-environment jsdom
 *
 * Accounts left over from a trial still counted on the free plan.
 *
 * Without Premium only the first account is checked; the popup shows the
 * others locked (a dimmed header with a lock, no messages). But getState()
 * summed every account's unreadCount, so the counts those accounts had when
 * the trial ended stayed in the toolbar badge for good, and the popup's
 * status bar showed them on their pills. A session that expired on such an
 * account also kept a "!" on the badge that nothing in the popup explained.
 *
 * Now the badge counts the checked accounts only, and a locked account's
 * pill shows the lock its header shows instead of a count. Pro and the
 * trial: no change.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const ROOT = join(__dirname, '..');
const read = (rel) => readFileSync(join(ROOT, rel), 'utf-8');
const POLLER = read('background/poller.js');
const POPUP = read('popup/popup.js');
const ProtonTombstones = new Function(read('background/optimistic-tombstones.js') + '; return ProtonTombstones;')();

// Index just past a string literal or line comment starting at i.
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

function lift(src, name) {
  const m = new RegExp('(async )?function ' + name + '\\(').exec(src);
  if (!m) throw new Error('not found: ' + name);
  let depth = 0;
  for (let i = src.indexOf('{', src.indexOf(') {', m.index)); i < src.length; i++) {
    const next = skipLiteral(src, i);
    if (next !== i) { i = next - 1; continue; }
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) return src.slice(m.index, i + 1); }
  }
  throw new Error('unbalanced braces reading ' + name);
}

const msg = (id, accountId) => ({ ID: id, ConversationID: 'c-' + id, Unread: 1, Time: 1, _accountId: accountId });

/** The real poller over a free-plan first account and a trial leftover. */
function background({ premium = false, leftoverAuthError = null } = {}) {
  const accounts = [
    { id: 'a1', email: 'one@example.com', viewMode: 1, unreadCount: 3, messages: [msg('m1'), msg('m2'), msg('m3')] },
    // Left from the trial: last checked then, never since.
    { id: 'a2', email: 'two@example.com', viewMode: 1, unreadCount: 7, messages: [msg('n1')], authError: leftoverAuthError },
  ];
  const plan = { premium };
  const badge = [];
  const P = new Function(
    'browser', 'ProtonAccounts', 'ProtonNotifier', 'ProtonBadge', 'ProtonDND', 'ProtonTombstones',
    'ProtonPremium', 'ProtonNotificationRules', 'ProtonDiag', 'ProtonLabels', 'getSettings', 'debugLog',
    POLLER + '\nreturn ProtonPoller;')(
    { storage: {}, runtime: { sendMessage: () => Promise.resolve() } },
    {
      hasAccounts: () => true,
      getAccounts: () => accounts.map((a) => ({ id: a.id, email: a.email, unreadCount: a.unreadCount, authError: a.authError })),
      getAccount: (id) => accounts.find((a) => a.id === id) || null,
      effectiveViewMode: (a) => a.viewMode,
    },
    {},
    {
      setUnreadCount: (n, issue) => badge.push({ n, issue }),
      setDND: (n) => badge.push({ n, dnd: true }),
      getState: () => ({}),
    },
    { isActive: () => false },
    ProtonTombstones,
    { isPremium: () => plan.premium },
    { activeRules: () => [], needsBody: () => false },
    { record() {} },
    { INBOX: '0', ALL_MAIL: '5' },
    async () => ({}),
    () => {},
  );
  return { P, badge, plan };
}

describe('the toolbar badge', () => {
  it('free plan: only the account that is checked (the bug: 10)', () => {
    const b = background();
    expect(b.P.getState().unreadCount).toBe(3);
    b.P.refreshBadgeNow();
    expect(b.badge).toEqual([{ n: 3, issue: false }]);
  });

  it('Pro or a trial: every account, as before', () => {
    const b = background({ premium: true });
    expect(b.P.getState().unreadCount).toBe(10);
  });

  it('follows Premium both ways, nothing stored changed', () => {
    const b = background();
    b.plan.premium = true;
    b.P.refreshBadgeNow();
    b.plan.premium = false;
    b.P.refreshBadgeNow();
    expect(b.badge.map((x) => x.n)).toEqual([10, 3]);
  });

  it('a locked account\'s expired session puts no "!" on it; with Pro it does', () => {
    const free = background({ leftoverAuthError: 'reauth' });
    free.P.refreshBadgeNow();
    expect(free.badge).toEqual([{ n: 3, issue: false }]);
    const pro = background({ premium: true, leftoverAuthError: 'reauth' });
    pro.P.refreshBadgeNow();
    expect(pro.badge).toEqual([{ n: 10, issue: true }]);
  });

  it('the locked account is still in the state, for the popup to show it locked', () => {
    const state = background().P.getState();
    expect(state.accounts.map((a) => a.id)).toEqual(['a1', 'a2']);
  });
});

describe('the popup\'s status bar', () => {
  function pills(premium) {
    document.body.innerHTML = '<div id="pills"></div><span id="checked"></span><ul id="list"></ul>';
    const env = {
      document,
      accountPillsEl: document.getElementById('pills'),
      lastCheckedEl: document.getElementById('checked'),
      messageList: document.getElementById('list'),
      _accountSections: [],
      ProtonI18n: { t: (k) => k },
      _luminance: () => 0.2,
      isPremium: () => premium,
      formatRelativeTime: () => '',
      _syncCollapseAllBtn: () => {},
    };
    const fns = new Function('__env', 'const { ' + Object.keys(env).join(', ') + ' } = __env;\n' +
      lift(POPUP, '_getAccountInitials') + '\n' + lift(POPUP, 'updateStatusBar') + '\nreturn updateStatusBar;')(env);
    // As the background sends it: the leftover's last messages are still there.
    fns({
      isLoggedIn: true,
      accounts: [
        { id: 'a1', email: 'one@example.com', unreadUnlisted: 0 },
        { id: 'a2', email: 'two@example.com', unreadUnlisted: 6 },
      ],
      messages: [msg('m1', 'a1'), msg('m2', 'a1'), msg('n1', 'a2')],
    });
    return [...env.accountPillsEl.querySelectorAll('.account-pill')].map((p) => ({
      title: p.title,
      badge: (p.querySelector('.account-pill-badge') || {}).textContent || null,
      badgeTitle: (p.querySelector('.account-pill-badge') || {}).title || '',
      locked: p.classList.contains('account-locked'),
    }));
  }

  it('free plan: the locked account shows its lock, not the trial\'s count', () => {
    expect(pills(false)).toEqual([
      { title: 'one@example.com (2)', badge: '2', badgeTitle: '', locked: false },
      { title: 'two@example.com', badge: '🔒', badgeTitle: 'premiumRequired', locked: true },
    ]);
  });

  it('Pro: every account with its count, as before', () => {
    expect(pills(true)).toEqual([
      { title: 'one@example.com (2)', badge: '2', badgeTitle: '', locked: false },
      { title: 'two@example.com (7)', badge: '7', badgeTitle: '', locked: false },
    ]);
  });

  it('locked by the same rule as the account sections: not Premium, not the first', () => {
    expect(lift(POPUP, 'renderMessages')).toMatch(/const isLockedAccount = freeAccountLock && _idx > 0;/);
    expect(lift(POPUP, 'updateStatusBar')).toMatch(/const locked = freeAccountLock && idx > 0;/);
  });

  it('and the accounts view leaves the trial\'s count off a locked account too', () => {
    const fn = lift(POPUP, 'renderAccountsList');
    expect(fn).toMatch(/const locked = !isPremium\(\) && accounts\.indexOf\(acc\) > 0;\s*if \(acc\.unreadCount > 0 && !locked\)/);
  });

  it('the pill is dimmed as the locked header is', () => {
    const css = read('popup/popup.css');
    expect(css).toMatch(/\.account-pill\.account-locked \{\s*opacity: 0\.6;\s*filter: grayscale\(0\.3\);/);
  });
});
