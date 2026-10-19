/**
 * @vitest-environment jsdom
 *
 * Every Pro setting acts as its default while the user is not Premium.
 *
 * The options page locks the Pro controls for a free user, so a choice made
 * during the trial (auto mark-as-read, wrap-around navigation, an
 * "until I turn it off" Do Not Disturb, settings sync, a badge colour, ...)
 * used to apply for good: the user could no longer undo it. Themes always
 * reverted; now every Pro setting does, through one list
 * (lib/pro-settings.js) that the options page locks from and that the
 * popup and the background read their settings through. Nothing stored is
 * changed, so the user's own choices apply again the moment Premium is back.
 *
 * House style: the functions under test are lifted out of the real sources
 * by name and evaluated with their dependencies injected; the options page
 * runs for real against options.html.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const ROOT = join(__dirname, '..');
const read = (rel) => readFileSync(join(ROOT, rel), 'utf-8');
const load = (rel, name) => new Function(read(rel) + '; return ' + name + ';')();

const ProtonProSettings = load('lib/pro-settings.js', 'ProtonProSettings');
const ProtonCodePatterns = load('lib/code-patterns.js', 'ProtonCodePatterns');
const ProtonNotificationRules = load('lib/notification-rules.js', 'ProtonNotificationRules');
const ProtonMonitoredIds = load('lib/monitored-ids.js', 'ProtonMonitoredIds');
const ProtonBrowserInfo = load('lib/browser-info.js', 'ProtonBrowserInfo');

const OPTIONS = read('options/options.js');
const OPTIONS_HTML = read('options/options.html');
const OPTIONS_BODY = OPTIONS_HTML.slice(OPTIONS_HTML.indexOf('<body>') + 6, OPTIONS_HTML.lastIndexOf('</body>'));
const POPUP = read('popup/popup.js');
const CONSTANTS = read('background/constants.js');
const POLLER = read('background/poller.js');
const ACCOUNTS = read('background/accounts.js');
const BACKGROUND = read('background/background.js');

const { DEFAULTS, LOCKED_CONTROLS, LOCKED_KEYS, PRO_KEYS, KEPT } = ProtonProSettings;
const clone = (v) => (v === undefined ? v : JSON.parse(JSON.stringify(v)));

// Index just past a string literal or line comment starting at i, or i itself
// when neither starts there, so braces inside them do not unbalance the scan.
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

/** End of the balanced `{ ... }` block that opens at or after `from`. */
function block(src, from, what) {
  let depth = 0;
  for (let i = src.indexOf('{', from); i < src.length; i++) {
    const next = skipLiteral(src, i);
    if (next !== i) { i = next - 1; continue; }
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) return i + 1; }
  }
  throw new Error('unbalanced braces reading ' + what);
}

function makeLift(src, file) {
  return (name) => {
    const m = new RegExp('(async )?function ' + name + '\\(').exec(src);
    if (!m) throw new Error('function not found in ' + file + ': ' + name);
    const body = src.indexOf(') {', m.index) + 1;
    return src.slice(m.index, block(src, body, name));
  };
}

/** A `const NAME = ...;` declaration, up to its own `;`. */
function liftDecl(src, name) {
  const m = new RegExp('^[ \\t]*const ' + name + ' =', 'm').exec(src);
  if (!m) throw new Error('not found: ' + name);
  let depth = 0;
  for (let i = m.index; i < src.length; i++) {
    const next = skipLiteral(src, i);
    if (next !== i) { i = next - 1; continue; }
    const c = src[i];
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') depth--;
    else if (c === ';' && depth === 0) return src.slice(m.index, i + 1);
  }
  throw new Error('no end reading ' + name);
}

/**
 * Evaluate lifted functions with `env`'s keys in scope as constants and
 * `state`'s keys as variables they may reassign; get() reads those back.
 */
function sandbox(lift, names, env = {}, state = {}) {
  const keys = Object.keys(env);
  const vars = Object.keys(state);
  const parts = [];
  if (keys.length) parts.push('const { ' + keys.join(', ') + ' } = __env;');
  if (vars.length) parts.push('let ' + vars.map((v) => v + ' = __state.' + v).join(', ') + ';');
  for (const n of names) parts.push(lift(n));
  parts.push('return { ' + names.join(', ') + ', get: () => ({ ' + vars.join(', ') + ' }) };');
  return new Function('__env', '__state', parts.join('\n\n'))(env, state);
}

const liftPopup = makeLift(POPUP, 'popup.js');
const liftPoller = makeLift(POLLER, 'poller.js');
const liftAccounts = makeLift(ACCOUNTS, 'accounts.js');
const liftConstants = makeLift(CONSTANTS, 'constants.js');

const flush = () => new Promise((r) => setTimeout(r, 0));
async function settle() { for (let i = 0; i < 15; i++) await flush(); }

// What a trial leaves behind: Pro choices of every kind, and one free one.
const TRIAL = Object.freeze({
  ...DEFAULTS,
  pollIntervalMinutes: 1,
  theme: 'nord',
  colorScheme: 'dark',
  badgeColor: '#112233',
  maxEmailsPerAccount: 5,
  senderDisplayFormat: 'email',
  previewLines: 3,
  use24HourTime: true,
  notificationPreviewText: false,
  autoMarkReadOnPreview: true,
  autoAdvance: true,
  navCrossAccount: false,
  navWrap: true,
  visibleActions: ['openWeb', 'star'],
  actionOrder: ['star', 'openWeb', 'markRead'],
  alwaysLoadExternalContent: true,
  codeDetectionEnabled: false,
  codePatterns: [{ id: 'default-verification', enabled: false }],
  notificationRules: [{ id: 'r1', from: '@example.com', silenceNotification: true }],
  replyFormat: 'html',
  composeFormat: 'plaintext',
  language: 'de',
});

// =============================================================================
// 1. The list and what it does
// =============================================================================

describe('the settings in effect', () => {
  it('with Premium: the stored settings, as they are', () => {
    expect(ProtonProSettings.inEffect(TRIAL, true)).toEqual(TRIAL);
  });

  it('without Premium: every Pro setting at its default, the free ones as stored', () => {
    const s = ProtonProSettings.inEffect(TRIAL, false);
    for (const key of PRO_KEYS) {
      if (key in ProtonProSettings.FREE_VALUES) continue;
      expect(s[key], key).toEqual(DEFAULTS[key]);
    }
    expect(s.language).toBe('de');
  });

  it('keeps the free plan\'s own values: 15 minutes, plain text, Classic following the system', () => {
    const s = ProtonProSettings.inEffect(TRIAL, false);
    expect(s.pollIntervalMinutes).toBe(15);
    expect(s.previewFormat).toBe('plaintext');
    expect(s.theme).toBe('classic');
    expect(s.colorScheme).toBe('auto');
    expect(s.customCSS).toBe('');
  });

  it('leaves the two editor formats as stored, so a restored draft shows its text', () => {
    expect(KEPT).toEqual(['replyFormat', 'composeFormat']);
    const s = ProtonProSettings.inEffect(TRIAL, false);
    expect(s.replyFormat).toBe('html');
    expect(s.composeFormat).toBe('plaintext');
  });

  it('message text in notifications goes back to its default without Premium, the stored choice returns with it', () => {
    // Like every other Pro setting: its default (on) is in effect.
    expect(PRO_KEYS).toContain('notificationPreviewText');
    expect(ProtonProSettings.inEffect(TRIAL, false).notificationPreviewText).toBe(true);
    expect(ProtonProSettings.inEffect(TRIAL, true).notificationPreviewText).toBe(false);
    // A locked control, so a free save and Reset keep the stored choice.
    expect(LOCKED_KEYS).toContain('notificationPreviewText');
    const reset = ProtonProSettings.keepStored({ ...DEFAULTS }, TRIAL);
    expect(reset.notificationPreviewText).toBe(false);
  });

  it('never touches what is stored, and hands out copies of the defaults', () => {
    const stored = clone(TRIAL);
    const s = ProtonProSettings.inEffect(stored, false);
    expect(stored).toEqual(TRIAL);
    s.visibleActions.push('spam');
    expect(DEFAULTS.visibleActions).not.toContain('spam');
    expect(ProtonProSettings.inEffect(undefined, false).navWrap).toBe(false);
  });

  it('a free save writes the Pro settings back as stored, their defaults when nothing is', () => {
    const form = ProtonProSettings.inEffect(TRIAL, false);
    form.language = 'fr';
    const saved = ProtonProSettings.keepStored(form, TRIAL);
    expect(saved).toEqual({ ...TRIAL, language: 'fr' });
    // Never the free plan's 15 minutes as if the user had chosen it.
    expect(ProtonProSettings.keepStored(form, {}).pollIntervalMinutes).toBe(DEFAULTS.pollIntervalMinutes);
  });

  it('settings sync runs with Premium only', () => {
    expect(ProtonProSettings.syncInEffect(true, true)).toBe(true);
    expect(ProtonProSettings.syncInEffect(true, false)).toBe(false);
    expect(ProtonProSettings.syncInEffect(false, true)).toBe(false);
  });
});

describe('the list covers every locked control and nothing else', () => {
  // saveSettings(): each `key: <expression>` line, and the control it reads.
  const varToId = new Map();
  for (const m of OPTIONS.matchAll(/const (\w+) = document\.getElementById\('([\w-]+)'\);/g)) {
    varToId.set(m[1], m[2]);
  }
  // The four values saveSettings builds from editors rather than one control.
  const EDITORS = {
    _getVisibleActions: 'actions-sortable',
    _getActionOrder: 'actions-sortable',
    _codePatternsState: 'code-patterns-list',
    _quietRulesState: 'quiet-rules-list',
  };
  const save = makeLift(OPTIONS, 'options.js')('saveSettings');
  const literal = save.slice(save.indexOf('let settings = {'), save.indexOf('\n    };') + 1);
  const written = [];
  for (const m of literal.matchAll(/^ {6}(\w+): ([^\n]*(?:\n {8}[^\n]*)*)/gm)) {
    const [, key, expr] = m;
    const ids = new Set();
    for (const [v, id] of varToId) if (new RegExp('\\b' + v + '\\b').test(expr)) ids.add(id);
    for (const [v, id] of Object.entries(EDITORS)) if (expr.includes(v)) ids.add(id);
    written.push({ key, ids: [...ids] });
  }

  it('reads saveSettings completely', () => {
    expect(written.length).toBe(Object.keys(DEFAULTS).length);
    expect(written.map((w) => w.key).sort()).toEqual(Object.keys(DEFAULTS).sort());
    for (const w of written) expect(w.ids.length, w.key).toBe(1);
  });

  it('every setting a locked control saves is in the list, under that control', () => {
    for (const { key, ids: [id] } of written) {
      if (!(id in LOCKED_CONTROLS)) continue;
      expect(LOCKED_CONTROLS[id], id).toContain(key);
    }
  });

  it('no free control saves a setting the list calls Pro', () => {
    for (const { key, ids: [id] } of written) {
      if (id in LOCKED_CONTROLS) continue;
      expect(LOCKED_KEYS, key + ' (#' + id + ')').not.toContain(key);
    }
  });

  it('every listed setting is saved by a control the list locks', () => {
    for (const key of LOCKED_KEYS) {
      expect(DEFAULTS, key).toHaveProperty(key);
      const w = written.find((x) => x.key === key);
      expect(w, key).toBeTruthy();
      expect(LOCKED_CONTROLS, key).toHaveProperty(w.ids[0]);
    }
  });

  it('the options page locks exactly the listed controls, and each one exists', () => {
    expect(OPTIONS).toMatch(/const PREMIUM_ONLY_IDS = Object\.keys\(ProtonProSettings\.LOCKED_CONTROLS\);/);
    for (const id of Object.keys(LOCKED_CONTROLS)) expect(OPTIONS_HTML, id).toContain('id="' + id + '"');
  });

  it('still locks everything it locked before', () => {
    const BEFORE = [
      'poll-interval', 'popup-width', 'popup-width-value', 'popup-height', 'popup-height-value',
      'theme-select', 'color-scheme', 'custom-css', 'display-density', 'max-emails', 'sender-display',
      'preview-lines', 'use-24h-time', 'preview-format', 'compose-mode', 'compose-format', 'reply-format',
      'spellcheck-language', 'badge-color', 'notification-click-action', 'notification-sound-enabled',
      'notification-sound', 'notification-volume', 'notification-preview-text', 'auto-mark-read-preview',
      'auto-mark-read-reply', 'auto-mark-read-archive', 'auto-mark-read-delete', 'auto-mark-read-spam',
      'auto-mark-read-phishing', 'auto-mark-read-star', 'auto-mark-read-move-to-folder',
      'auto-mark-read-label', 'hide-send-archive', 'prettify-raw', 'image-attach-mode', 'auto-advance',
      'nav-cross-account', 'nav-wrap', 'actions-sortable', 'sync-enabled', 'btn-sync-now', 'btn-export',
      'btn-import', 'always-load-external', 'code-detection-enabled', 'code-patterns-list',
      'code-pattern-name', 'code-pattern-regex', 'code-pattern-add-btn', 'code-pattern-reset-all',
      'quiet-rules-list', 'quiet-rule-add-btn',
    ];
    for (const id of BEFORE) expect(LOCKED_CONTROLS, id).toHaveProperty(id);
  });

  it('every page that reads settings loads the list', () => {
    expect(JSON.parse(read('manifest.json')).background.scripts).toContain('lib/pro-settings.js');
    for (const page of ['popup/popup.html', 'options/options.html', 'captcha/captcha.html']) {
      const html = read(page);
      const lib = html.indexOf('../lib/pro-settings.js');
      expect(lib, page).toBeGreaterThan(-1);
      const own = html.indexOf(page.replace(/^.*\//, '').replace('.html', '.js') + '"');
      expect(lib, page).toBeLessThan(own);
    }
  });
});

// =============================================================================
// 2. The background
// =============================================================================

/** constants.js getSettings() over `stored`, with Premium as given. */
function settingsReader(stored, premium) {
  const writes = [];
  const browser = {
    storage: {
      local: {
        get: async () => ({ settings: clone(stored) }),
        set: async (o) => { writes.push(o); },
      },
    },
  };
  const { getSettings } = sandbox(liftConstants, ['getSettings'], {
    browser,
    ProtonProSettings,
    ProtonPremium: premium === undefined ? undefined : { isPremium: () => premium },
  });
  return { getSettings, writes };
}

describe('the background reads the settings in effect', () => {
  it('getSettings: Pro settings at their defaults without Premium, nothing written', async () => {
    const r = settingsReader(TRIAL, false);
    const s = await r.getSettings();
    expect(s.badgeColor).toBe(DEFAULTS.badgeColor);
    expect(s.notificationRules).toEqual([]);
    expect(s.language).toBe('de');
    expect(r.writes).toEqual([]);
  });

  it('getSettings: as stored with Premium, and where Premium is not loaded (tests, other pages)', async () => {
    expect(await settingsReader(TRIAL, true).getSettings()).toEqual(TRIAL);
    expect(await settingsReader(TRIAL, undefined).getSettings()).toEqual(TRIAL);
  });

  it('the badge colour', async () => {
    const BADGE = read('background/badge.js');
    for (const [premium, colour] of [[false, DEFAULTS.badgeColor], [true, '#112233']]) {
      const colours = [];
      const action = {
        setIcon() {}, setBadgeText() {}, setTitle() {},
        setBadgeBackgroundColor: ({ color }) => colours.push(color),
      };
      const Badge = new Function('browser', 'getSettings', 'ProtonI18n', BADGE + '\nreturn ProtonBadge;')(
        { action }, settingsReader(TRIAL, premium).getSettings, undefined);
      await Badge.setUnreadCount(3, false);
      expect(colours).toEqual([colour]);
    }
  });

  it('messages per account', async () => {
    for (const [premium, n] of [[false, 20], [true, 5]]) {
      const { _getMaxEmails } = sandbox(liftPoller, ['_getMaxEmails'], {
        getSettings: settingsReader(TRIAL, premium).getSettings,
      });
      expect(await _getMaxEmails()).toBe(n);
    }
  });

  it('preview lines: no list-wide fetch and decrypt for a free user', async () => {
    for (const [premium, fetched] of [[false, 0], [true, 2]]) {
      let calls = 0;
      const { _fetchSnippets } = sandbox(liftPoller, ['_fetchSnippets'], {
        getSettings: settingsReader(TRIAL, premium).getSettings,
        _snippetCache: new Map(),
        _cacheSnippet: () => {},
        _extractSnippet: (t) => t,
        debugLog: () => {},
        ProtonAccounts: {
          getAccount: () => ({ keysUnlocked: true }),
          getMessage: async () => { calls++; return { Body: 'x' }; },
          decryptBody: async () => 'text',
        },
      });
      await _fetchSnippets('acc1', [{ ID: 'm1' }, { ID: 'm2' }]);
      expect(calls).toBe(fetched);
    }
  });

  it('the preview text in notifications: its default without Premium, the stored choice with it', async () => {
    const NOTIFIER = read('background/notifier.js');
    for (const [premium, stored, message] of [
      [false, false, 'Hello\nBody text'], [true, false, 'Hello'],
      [false, true, 'Hello\nBody text'], [true, true, 'Hello\nBody text'],
    ]) {
      const shown = [];
      const session = {};
      const browser = {
        storage: {
          session: {
            get: async (k) => ({ [k]: session[k] }),
            set: async (o) => { Object.assign(session, o); },
          },
        },
        notifications: { create: async (id, opt) => { shown.push(opt.message); return id; }, clear() {}, onClicked: { addListener() {} } },
      };
      const N = new Function('browser', 'getSettings', 'ProtonDND', 'ProtonAccounts',
        'ProtonPremium', 'ProtonI18n', 'ProtonAudioBridge', 'ProtonPoller', 'console',
        NOTIFIER + '\nreturn ProtonNotifier;')(
        browser,
        settingsReader({ ...TRIAL, notificationRules: [], notificationPreviewText: stored }, premium).getSettings,
        { isActive: () => false },
        { getAccount: () => ({ id: 'acc1' }), getAccounts: () => [{ id: 'acc1' }] },
        { isPremium: () => premium },
        { t: (k) => k },
        { playSound: async () => {} },
        { poll() {} },
        { warn() {}, log() {}, error() {} });
      await N.notifyNewMessages([{ ID: 'm1', Subject: 'Hello', _snippet: 'Body text', Sender: { Name: 'Sender' } }],
        'user@example.com', 'acc1');
      expect(shown, 'premium ' + premium + ', stored ' + stored).toEqual([message]);
    }
  });

  it('and the poller fetches the text for a notification only when it will be shown', async () => {
    for (const [premium, stored, force] of [[false, false, true], [false, true, true], [true, false, false], [true, true, true]]) {
      const asked = [];
      const { _announce } = sandbox(liftPoller, ['_announce'], {
        getSettings: settingsReader({ ...TRIAL, notificationPreviewText: stored }, premium).getSettings,
        ProtonPremium: { isPremium: () => premium },
        ProtonDND: { isActive: () => false },
        _fetchSnippets: async (_id, _msgs, options) => { asked.push(options.force); },
        _applyNotificationRules: async () => {},
        ProtonNotifier: { notifyNewMessages: async () => {} },
      });
      await _announce('acc1', { id: 'acc1', email: 'user@example.com' }, [{ ID: 'm1' }]);
      expect(asked, 'premium ' + premium + ', stored ' + stored).toEqual([force]);
    }
  });

  it('Do Not Disturb "until I turn it off" from the trial is off without Premium, and back with it', async () => {
    const DND = read('background/dnd.js');
    let premium = false;
    const writes = [];
    const browser = {
      storage: { local: { get: async () => ({ dndUntil: -1 }), set: async (o) => { writes.push(o); } } },
      alarms: { create() {}, clear() {} },
    };
    const D = new Function('browser', 'debugLog', 'ProtonPremium', DND + '\nreturn ProtonDND;')(
      browser, () => {}, { isPremium: () => premium });
    await D.init();
    expect(D.isActive()).toBe(false);
    expect(D.getStatus()).toEqual({ active: false, until: -1 });
    premium = true;
    expect(D.isActive()).toBe(true);
    expect(writes).toEqual([]);
  });

  it('per-account label, initials and color read as unset without Premium', () => {
    let premium = false;
    const stored = { id: 'a1', email: 'user@example.com', label: 'Work', initials: 'WK', color: '#123456' };
    const { getAccounts } = sandbox(liftAccounts, ['_proSettingsApply', 'getAccounts'], {
      _accounts: [stored],
      ProtonPremium: { isPremium: () => premium },
    });
    expect(getAccounts()[0]).toMatchObject({ label: '', initials: '', color: '' });
    premium = true;
    expect(getAccounts()[0]).toMatchObject({ label: 'Work', initials: 'WK', color: '#123456' });
    expect(stored.label).toBe('Work');
  });

  it('so does the label on the options page\'s account alignment', () => {
    const at = ACCOUNTS.indexOf('getAccountMapping: () => {');
    const fn = ACCOUNTS.slice(at + 'getAccountMapping: '.length, block(ACCOUNTS, at, 'getAccountMapping'));
    let premium = false;
    const mapping = [{ id: 'a1', email: 'user@example.com', label: 'Work', activeSlot: 0 }];
    const get = new Function('_proSettingsApply', 'ProtonUrlDetection', 'return ' + fn + ';')(
      () => premium, { getAccountMapping: () => mapping });
    expect(get()[0]).toEqual({ id: 'a1', email: 'user@example.com', label: '', activeSlot: 0 });
    premium = true;
    expect(get()[0].label).toBe('Work');
  });

  it('a premium flip applies the list size and the quiet rules at once', () => {
    const at = BACKGROUND.indexOf('ProtonPremium.onPremiumChange(');
    const handler = BACKGROUND.slice(at, block(BACKGROUND, at, 'onPremiumChange'));
    expect(handler).toMatch(/ProtonPoller\.refreshBadgeNow\(\);/);
    expect(handler).toMatch(/ProtonPoller\.syncListLimit\(\)/);
    expect(handler).toMatch(/ProtonPoller\.reapplyQuietRules\(\)/);
  });

  it('a lapsed device takes nothing from settings sync at startup', () => {
    const init = makeLift(BACKGROUND, 'background.js')('_initialize');
    expect(init).toMatch(/if \(ProtonProSettings\.syncInEffect\(syncEnabled, ProtonPremium\.isPremium\(\)\)\) \{\s*const synced = await browser\.storage\.sync\.get\('accountSettings'\);/);
    // Premium is loaded before that read.
    expect(init.indexOf('await ProtonPremium.init();')).toBeLessThan(init.indexOf('syncInEffect'));
  });

  it('and pushes no per-account settings to it', async () => {
    let premium = false;
    const syncWrites = [];
    const { pushAccountSettingsToSync } = sandbox(liftAccounts, ['_proSettingsApply', 'pushAccountSettingsToSync'], {
      ProtonPremium: { isPremium: () => premium },
      getAccountSettingsExport: () => ({}),
      browser: {
        storage: {
          local: { get: async () => ({ syncEnabled: true }), set: async () => {} },
          sync: { set: async (o) => { syncWrites.push(o); } },
        },
      },
    });
    await pushAccountSettingsToSync();
    expect(syncWrites).toEqual([]);
    premium = true;
    await pushAccountSettingsToSync();
    expect(syncWrites).toHaveLength(1);
  });
});

// =============================================================================
// 3. The popup
// =============================================================================

describe('the popup decides everything from the settings in effect', () => {
  it('the stored settings are read in one place only', () => {
    const lines = POPUP.split('\n').filter((l) => l.includes('_storedSettings')).map((l) => l.trim());
    expect(lines).toEqual([
      'let _storedSettings = {};',
      '_settings = ProtonProSettings.inEffect(_storedSettings, isPremium());',
      '_storedSettings = stored.settings || {};',
      '_storedSettings = changes.settings.newValue || {};',
    ]);
    // _settings is only ever the result of that.
    const assigned = POPUP.split('\n').filter((l) => /\b_settings = /.test(l)).map((l) => l.trim());
    expect(assigned).toEqual([
      'let _settings = {};',
      '_settings = ProtonProSettings.inEffect(_storedSettings, isPremium());',
    ]);
  });

  it('and they are recomputed wherever the stored settings or Premium change', () => {
    expect(liftPopup('loadSettings')).toMatch(/_storedSettings = stored\.settings \|\| \{\};\s*_refreshSettingsInEffect\(\);/);
    expect(POPUP).toMatch(/_storedSettings = changes\.settings\.newValue \|\| \{\};\s*_refreshSettingsInEffect\(\);/);
    expect(POPUP).toMatch(/if \(premiumStatus\) _premium = premiumStatus;\s*_refreshSettingsInEffect\(\);/);
    // loadSettings() ran before Premium was known: the start-up applies the
    // editor settings again, or a Pro user's spellcheck language is lost.
    const startup = POPUP.slice(POPUP.indexOf('if (premiumStatus) _premium = premiumStatus;'));
    expect(startup.slice(0, startup.indexOf('GET_PENDING_2FA'))).toMatch(/_applyFormatSettings\(\);/);
    // Assigned in render() and the start-up above, nowhere else.
    expect(POPUP.match(/(?<!let )(?<![.\w])_premium = /g)).toHaveLength(2);
    expect(liftPopup('render')).toMatch(/_premium = state\.premium;/);
  });

  /** render() with everything but the settings stubbed. */
  function popup(premium) {
    const seen = [];
    // The background's DND answer: "until I turn it off", in effect with Premium only.
    const dnd = { asked: [], shown: [] };
    const env = {
      document, ProtonI18n: { t: (k) => k }, ProtonProSettings,
      browser: { runtime: { sendMessage: async (m) => {
        dnd.asked.push(m.type);
        return { active: box.get()._premium.premium, until: -1 };
      } } },
      updateDndButton: (status) => dnd.shown.push(status.active),
      btnAccount: document.createElement('button'), ICON_ACCOUNT: '',
      _setHTML: () => {},
      _renderPremiumHeaderBadge: () => {},
      _applyColorScheme: () => {},
      _applyCustomCSS: () => {},
      _applyFormatSettings: () => {},
      applyDensity: () => {},
      showAccountsView: () => {},
      updateStatusBar: () => {},
      _showErrorState: () => {},
      showState: () => {},
      _syncPreviewWithList: () => {},
      renderMessages: () => seen.push(box.get()._settings),
    };
    const stored = clone(TRIAL);
    const box = sandbox(liftPopup, ['isPremium', 'showPremiumUI', '_applyTheme', '_refreshSettingsInEffect', 'render'], env, {
      _premium: { premium }, _storedSettings: stored, _settings: ProtonProSettings.inEffect(stored, premium),
      _savedState: null, _showingAccounts: false,
    });
    const state = (p) => ({ isLoggedIn: true, messages: [], accounts: [], premium: { premium: p } });
    return { box, seen, stored, state, dnd };
  }

  it('the Do Not Disturb bell asks again when Premium flips, and only then', async () => {
    const p = popup(true);
    p.box.render(p.state(true));
    await settle();
    expect(p.dnd.asked).toEqual([]);
    // The trial ends with the popup open: the stored DND is out of effect.
    p.box.render(p.state(false));
    await settle();
    expect(p.dnd.asked).toEqual(['DND_GET_STATUS']);
    expect(p.dnd.shown).toEqual([false]);
    // A subscription starts: the stored DND applies again, and the bell says so.
    p.box.render(p.state(true));
    await settle();
    expect(p.dnd.shown).toEqual([false, true]);
  });

  it('the round trip: the trial ends, then a subscription brings every choice back', () => {
    const p = popup(true);
    p.box.render(p.state(false));
    let s = p.box.get()._settings;
    expect(s.autoMarkReadOnPreview).toBe(false);
    expect(s.navWrap).toBe(false);
    expect(s.senderDisplayFormat).toBe('name');
    expect(s.use24HourTime).toBe(false);
    expect(s.visibleActions).toEqual(DEFAULTS.visibleActions);
    expect(document.body.getAttribute('data-theme')).toBe('classic');
    // The list was drawn with them, not with the trial's.
    expect(p.seen[0].senderDisplayFormat).toBe('name');

    p.box.render(p.state(true));
    s = p.box.get()._settings;
    expect(s.autoMarkReadOnPreview).toBe(true);
    expect(s.navWrap).toBe(true);
    expect(s.senderDisplayFormat).toBe('email');
    expect(document.body.getAttribute('data-theme')).toBe('nord');
    expect(p.box.get()._storedSettings).toEqual(TRIAL);
  });

  it('auto mark-as-read on preview reads them', () => {
    expect(liftPopup('openPreview')).toMatch(/if \(_settings\.autoMarkReadOnPreview && msg\.Unread === 1\)/);
  });

  it('verification codes: the shipped patterns for a free user, whatever the trial left', () => {
    for (const [premium, code] of [[false, '482913'], [true, null]]) {
      const { _detectOTP } = sandbox(liftPopup, ['_detectOTP'], {
        ProtonCodePatterns,
        _settings: ProtonProSettings.inEffect({ ...TRIAL, codeDetectionEnabled: true }, premium),
      });
      expect(_detectOTP('Verification 482913', '')).toBe(code);
    }
    const { _detectOTP } = sandbox(liftPopup, ['_detectOTP'], {
      ProtonCodePatterns, _settings: ProtonProSettings.inEffect(TRIAL, false),
    });
    expect(_detectOTP('Verification 482913', '')).toBe('482913');
  });
});

describe('prev/next stays in the free plan\'s one account', () => {
  const msg = (id, accountId, time) => ({ ID: id, _accountId: accountId, Time: time });
  // Newest first, as the state lists them; a2 is locked on the free plan.
  const MESSAGES = [msg('n1', 'a2', 400), msg('m1', 'a1', 300), msg('n2', 'a2', 200), msg('m2', 'a1', 100)];

  function nav(premium, stored, openId = 'm1') {
    const opened = [];
    const btnPrevMsg = document.createElement('button');
    const btnNextMsg = document.createElement('button');
    const box = sandbox(liftPopup, ['_listNeighbours', '_getNavList', '_navigateMsg', '_updateNavButtons'], {
      isPremium: () => premium,
      openPreview: (m) => opened.push(m.ID),
      btnPrevMsg, btnNextMsg,
      _settings: ProtonProSettings.inEffect(stored, premium),
    }, {
      _savedState: { accounts: [{ id: 'a1' }, { id: 'a2' }], messages: MESSAGES },
      _selectedMsg: MESSAGES.find((m) => m.ID === openId),
    });
    box._updateNavButtons();
    return { box, opened, btnPrevMsg, btnNextMsg };
  }

  it('free: never into a locked account, across accounts or not', () => {
    for (const stored of [{}, TRIAL]) {
      const n = nav(false, stored);
      n.box._navigateMsg(1);
      n.box._navigateMsg(-1);
      expect(n.opened).toEqual(['m2']);
      expect(n.btnPrevMsg.disabled).toBe(true);
    }
  });

  it('free: wrap-around from the trial is out of effect', () => {
    const n = nav(false, { ...TRIAL, navCrossAccount: true });
    expect(n.btnPrevMsg.disabled).toBe(true);
    const p = nav(true, { ...TRIAL, navCrossAccount: true });
    expect(p.btnPrevMsg.disabled).toBe(false);
  });

  it('Premium: across accounts by default', () => {
    const n = nav(true, {});
    n.box._navigateMsg(1);
    n.box._navigateMsg(-1);
    expect(n.opened).toEqual(['n2', 'n1']);
  });
});

describe('labels and folders are asked for with Premium only', () => {
  function preview(premium, reply = (t) => (t === 'GET_LABELS' ? [{ ID: 'L1', Name: 'Work', Color: '#f00' }] : [])) {
    const sent = [];
    const previewLabels = document.createElement('div');
    const env = {
      document, previewLabels,
      ProtonI18n: { t: (k) => k },
      ICONS: { star: '' },
      _labelCache: {},
      _setHTML: (el, html) => { el.innerHTML = html; },
      isPremium: () => premium,
      browser: { runtime: { sendMessage: async (m) => { sent.push(m.type); return reply(m.type); } } },
    };
    const consts = ['SYSTEM_LABELS', 'SKIP_LABEL_IDS'].map((n) => liftDecl(POPUP, n)).join('\n');
    const fns = new Function('__env', 'const { ' + Object.keys(env).join(', ') + ' } = __env;\n' + consts + '\n' +
      liftPopup('_escapeHtmlText') + '\n' + liftPopup('_renderLabelsAndFolders') + '\nreturn _renderLabelsAndFolders;')(env);
    return { render: (ids) => fns(ids, 'acc1'), sent, previewLabels };
  }

  it('free: no request, which the background would refuse; Starred and system folders still show', async () => {
    const p = preview(false);
    await p.render(['10', '6', 'L1']);
    expect(p.sent).toEqual([]);
    expect(p.previewLabels.children).toHaveLength(2);
    expect(p.previewLabels.textContent).toContain('starred');
    expect(p.previewLabels.textContent).toContain('Archive');
  });

  it('Premium: asked once, then from the cache', async () => {
    const p = preview(true);
    await p.render(['L1']);
    await p.render(['L1']);
    expect(p.sent).toEqual(['GET_LABELS', 'GET_FOLDERS']);
    expect(p.previewLabels.textContent).toBe('Work');
  });

  it('a refusal is not cached: the names come back once the reply does', async () => {
    let refuse = true;
    const p = preview(true, (t) => (refuse ? { error: 'PREMIUM_REQUIRED' } : (t === 'GET_LABELS' ? [{ ID: 'L1', Name: 'Work' }] : [])));
    await p.render(['L1']);
    expect(p.previewLabels.textContent).toBe('');
    refuse = false;
    await p.render(['L1']);
    expect(p.previewLabels.textContent).toBe('Work');
  });
});

describe('the list row\'s overflow menu', () => {
  function row(premium) {
    const prompts = [];
    const submenus = [];
    const noop = () => {};
    const built = sandbox(liftPopup, ['createMessageItem', 'createActionBtn', '_sortActionsByOrder'], {
      document,
      ProtonI18n: { t: (k) => k },
      _renderReplyState: noop,
      _formatSender: () => 'A Sender',
      formatMessageTime: () => '10:30',
      createAvatarEl: () => document.createElement('div'),
      _senderIconsAllowed: () => false,
      _detectOTP: () => null,
      _settings: ProtonProSettings.inEffect(TRIAL, premium),
      showPremiumUI: () => true,
      isPremium: () => premium,
      showUpgradePrompt: (k) => prompts.push(k),
      _openSubmenu: (_btn, _msg, _acc, type) => submenus.push(type),
      _setHTML: noop, _menuEnter: noop, _menuLeave: noop, _closeSubmenu: noop, _closeAllMenus: noop,
      ICONS: new Proxy({}, { get: () => '' }),
      browser: { runtime: { sendMessage: () => Promise.resolve(null) }, tabs: { create: noop } },
    });
    const li = built.createMessageItem({ ID: 'm1', Subject: 'Hi', Time: 1, Unread: 1, _accountId: 'acc1' }, false);
    const entry = li.querySelector('.action-overflow-menu .action-label');
    return { li, entry, prompts, submenus };
  }

  it('free: hovering Labels asks for nothing; clicking it offers Pro', () => {
    const r = row(false);
    r.entry.dispatchEvent(new Event('mouseenter'));
    expect(r.submenus).toEqual([]);
    r.entry.click();
    expect(r.prompts).toEqual(['label']);
  });

  it('Premium: hovering opens the submenu as before', () => {
    const r = row(true);
    r.entry.dispatchEvent(new Event('mouseenter'));
    expect(r.submenus).toEqual(['label']);
  });

  it('free: the quick actions are the default ones, not the trial\'s', () => {
    const r = row(false);
    const primary = [...r.li.querySelectorAll(':scope .msg-actions > .action-btn')].map((b) => b.className);
    expect(primary.some((c) => c.includes('action-star'))).toBe(false);
    expect(primary.some((c) => c.includes('action-read'))).toBe(true);
  });
});

describe('the CAPTCHA page follows the system without Premium', () => {
  const CAPTCHA = read('captcha/captcha.js');
  const CAPTCHA_HTML = read('captcha/captcha.html');

  async function page(premium, reply = async (m) => (m.type === 'GET_PREMIUM_STATUS' ? { premium } : undefined)) {
    document.body.innerHTML = CAPTCHA_HTML.slice(CAPTCHA_HTML.indexOf('<body>') + 6, CAPTCHA_HTML.indexOf('<script'));
    document.body.removeAttribute('data-color-scheme');
    window.matchMedia = () => ({ matches: false, addEventListener() {} });
    window.history.replaceState(null, '', '?token=hv-token');
    const browser = {
      storage: { local: { get: async () => ({ settings: { colorScheme: 'dark' } }) } },
      runtime: { sendMessage: reply },
    };
    new Function('browser', 'ProtonI18n', 'ProtonProSettings', CAPTCHA)(browser, undefined, ProtonProSettings);
    await settle();
    window.history.replaceState(null, '', window.location.pathname);
    return document.body.getAttribute('data-color-scheme');
  }

  it('free: light, as the system is', async () => { expect(await page(false)).toBe('light'); });
  it('Premium: the chosen dark', async () => { expect(await page(true)).toBe('dark'); });

  it('the verification never waits for the background\'s answer', async () => {
    await page(false, () => new Promise(() => {}));
    expect(document.getElementById('captcha-iframe').getAttribute('src')).toContain('token=hv-token');
  });
});

// =============================================================================
// 4. The options page, for real
// =============================================================================

const FREE_STATUS = {
  premium: false, licensed: false, locked: false,
  trialing: false, trialExpired: true, trialAvailable: false, trialDaysRemaining: 0,
  licenseKeyMasked: null, lastValidatedAt: null, lastValidationError: null,
  lastValidationStatus: null, firstFailedAt: null, graceRemainingDays: 0,
  inGracePeriod: false, billingInterval: null, periodStart: null, periodEnd: null,
  keyStored: false, held: null, pastDue: false, scheduledChange: null,
  nextBilledAt: null, trialActive: false, clearedReason: null,
};

function optionsPage({ settings = TRIAL, syncEnabled = false, synced = {}, premium = false } = {}) {
  // holdLoads() keeps loadSettings() waiting on its storage read until
  // releaseLoads(), to act inside the window before the form is refilled.
  let held = null;
  let release = () => {};
  document.body.className = '';
  document.body.innerHTML = OPTIONS_BODY;
  window.matchMedia = () => ({ matches: false, addEventListener() {} });
  const local = { settings: clone(settings), syncEnabled, debugLogging: false };
  const sync = clone(synced);
  const syncWrites = [];
  const sent = [];
  const listeners = [];
  const status = { ...FREE_STATUS, premium };
  const pick = (store, keys) => {
    const out = {};
    for (const k of [].concat(keys)) if (k in store) out[k] = clone(store[k]);
    return out;
  };
  const browser = {
    storage: {
      local: {
        get: async (k) => {
          if (held && [].concat(k).includes('debugLogging')) await held;
          return pick(local, k);
        },
        set: async (o) => { Object.assign(local, clone(o)); },
      },
      sync: {
        get: async (k) => pick(sync, k),
        set: async (o) => { syncWrites.push(clone(o)); Object.assign(sync, clone(o)); },
      },
      onChanged: { addListener: (fn) => listeners.push(fn) },
    },
    runtime: {
      sendMessage: async (msg) => {
        sent.push(msg);
        if (msg.type === 'GET_PREMIUM_STATUS') return { ...status };
        if (msg.type === 'LICENSE_NUDGE') return { ok: false };
        if (msg.type === 'GET_ACCOUNT_MAPPING' || msg.type === 'GET_ACCOUNTS') return [];
        if (msg.type === 'GET_ACCOUNT_SETTINGS_EXPORT') return {};
        return undefined;
      },
      getManifest: () => ({ name: 'Mail Checker', version: '0.0.0' }),
      getURL: (p) => p,
    },
    tabs: { create() {} },
  };
  const ProtonI18n = {
    t: (k) => k, plural: (k, n) => n + ' ' + k,
    setLanguage() {}, applyTranslations() {}, getLanguage: () => 'en',
  };
  new Function('browser', 'ProtonI18n', 'ProtonDialog', 'ProtonBrowserInfo', 'ProtonCodePatterns',
    'ProtonNotificationRules', 'ProtonMonitoredIds', 'ProtonProSettings', OPTIONS)(
    browser, ProtonI18n, { confirm: async () => true }, ProtonBrowserInfo, ProtonCodePatterns,
    ProtonNotificationRules, ProtonMonitoredIds, ProtonProSettings);
  const $ = (id) => document.getElementById(id);
  return {
    local, sync, syncWrites, sent, $,
    /** The background reports another plan: a license write re-renders the page. */
    async setPremium(p) {
      status.premium = p;
      for (const fn of listeners) fn({ _trialEnd: { newValue: 1 } }, 'local');
      await new Promise((r) => setTimeout(r, 300));
      await settle();
    },
    change(id, value) {
      const el = $(id);
      if (typeof value === 'boolean') el.checked = value; else el.value = value;
      el.dispatchEvent(new Event('change'));
    },
    holdLoads() { held = new Promise((r) => { release = r; }); },
    releaseLoads() { held = null; release(); },
  };
}

describe('the options page without Premium', () => {
  beforeEach(() => { vi.useRealTimers(); });

  it('shows the values in effect on the locked controls, and says the user\'s own are kept', async () => {
    const o = optionsPage();
    await settle();
    expect(o.$('poll-interval').value).toBe('15');
    expect(o.$('theme-select').value).toBe('classic');
    expect(o.$('color-scheme').value).toBe('auto');
    expect(o.$('badge-color').value.toLowerCase()).toBe(DEFAULTS.badgeColor.toLowerCase());
    expect(o.$('preview-format').value).toBe('plaintext');
    expect(o.$('nav-wrap').checked).toBe(false);
    expect(o.$('nav-cross-account').checked).toBe(true);
    expect(o.$('auto-mark-read-preview').checked).toBe(false);
    expect(o.$('code-detection-enabled').checked).toBe(true);
    // The trial turned it off; its default is in effect.
    expect(o.$('notification-preview-text').checked).toBe(true);
    expect(o.$('notification-preview-text').disabled).toBe(true);
    // Kept as stored (they only shape a restored draft), and the free ones too.
    expect(o.$('reply-format').value).toBe('html');
    expect(o.$('language').value).toBe('de');
    // Locked, with the note.
    expect(o.$('nav-wrap').disabled).toBe(true);
    expect(o.$('pro-settings-note').classList.contains('hidden')).toBe(false);
    // The page itself follows the system too.
    expect(document.body.getAttribute('data-color-scheme')).toBe('light');
  });

  it('a list\'s rows cannot be reached with the keyboard either', async () => {
    const o = optionsPage();
    await settle();
    for (const id of ['actions-sortable', 'quiet-rules-list', 'code-patterns-list']) {
      expect(o.$(id).hasAttribute('inert'), id).toBe(true);
    }
  });

  it('saving a free setting keeps every Pro choice as stored', async () => {
    const o = optionsPage();
    await settle();
    o.change('language', 'fr');
    await settle();
    expect(o.local.settings).toEqual({ ...TRIAL, language: 'fr' });
  });

  it('even a Pro control changed past the lock saves nothing', async () => {
    const o = optionsPage();
    await settle();
    o.change('nav-wrap', true);
    o.$('actions-sortable').querySelector('input[type="checkbox"]').click();
    await settle();
    expect(o.local.settings).toEqual(TRIAL);
  });

  it('settings sync: the switch shows off, and nothing goes to or comes from sync', async () => {
    const o = optionsPage({ syncEnabled: true, synced: { settings: { ...TRIAL, language: 'sv' }, accountSettings: { 'x@example.com': {} } } });
    await settle();
    expect(o.$('sync-enabled').checked).toBe(false);
    expect(o.$('language').value).toBe('de');
    expect(o.sent.map((m) => m.type)).not.toContain('IMPORT_ACCOUNT_SETTINGS');
    o.change('language', 'fr');
    await settle();
    expect(o.syncWrites).toEqual([]);
    // The switch itself is kept for when Premium is back.
    expect(o.local.syncEnabled).toBe(true);
  });

  it('the round trip: with Premium back, every choice shows and applies again', async () => {
    const o = optionsPage();
    await settle();
    expect(o.$('nav-wrap').checked).toBe(false);
    await o.setPremium(true);
    expect(o.$('nav-wrap').checked).toBe(true);
    expect(o.$('nav-wrap').disabled).toBe(false);
    expect(o.$('poll-interval').value).toBe('1');
    expect(o.$('theme-select').value).toBe('nord');
    expect(o.$('badge-color').value.toLowerCase()).toBe('#112233');
    expect(o.$('notification-preview-text').checked).toBe(false);
    expect(o.$('notification-preview-text').disabled).toBe(false);
    expect(o.$('pro-settings-note').classList.contains('hidden')).toBe(true);
    expect(o.$('actions-sortable').hasAttribute('inert')).toBe(false);
    // Nothing was written to get there.
    expect(o.local.settings).toEqual(TRIAL);
    // And now a Pro control saves.
    o.change('nav-wrap', false);
    await settle();
    expect(o.local.settings.navWrap).toBe(false);
  });

  it('a save while Premium is known but the form still shows the free values keeps every Pro choice', async () => {
    const o = optionsPage();
    await settle();
    o.holdLoads();
    await o.setPremium(true);
    // Unlocked, but still the free plan's values: the refill has not landed.
    expect(o.$('nav-wrap').disabled).toBe(false);
    expect(o.$('poll-interval').value).toBe('15');
    o.change('language', 'fr');
    await settle();
    expect(o.local.settings).toEqual({ ...TRIAL, language: 'fr' });
    o.releaseLoads();
    await settle();
    expect(o.$('poll-interval').value).toBe('1');
  });
});

describe('the options page with Premium', () => {
  it('shows and saves the user\'s own choices, as before', async () => {
    const o = optionsPage({ premium: true });
    await settle();
    expect(o.$('nav-wrap').checked).toBe(true);
    expect(o.$('theme-select').value).toBe('nord');
    expect(o.$('pro-settings-note').classList.contains('hidden')).toBe(true);
    o.change('theme-select', 'ocean');
    await settle();
    // The form's own values, Pro ones included (lists come back normalized).
    expect(o.local.settings).toMatchObject({
      theme: 'ocean', navWrap: true, badgeColor: '#112233', pollIntervalMinutes: 1,
      autoMarkReadOnPreview: true, codeDetectionEnabled: false, language: 'de',
    });
    expect(o.local.settings.visibleActions.sort()).toEqual(['openWeb', 'star']);
  });

  it('a preview format imported as \'text\' shows as Plain text and saves as \'plaintext\'', async () => {
    const o = optionsPage({ premium: true, settings: { ...TRIAL, previewFormat: 'text' } });
    await settle();
    expect(o.$('preview-format').value).toBe('plaintext');
    o.change('theme-select', 'ocean');
    await settle();
    expect(o.local.settings.previewFormat).toBe('plaintext');
  });

  it('settings sync takes in what another device synced, and sends every save', async () => {
    const synced = { settings: { ...TRIAL, language: 'sv' }, accountSettings: { 'x@example.com': { label: 'Home' } } };
    const o = optionsPage({ premium: true, syncEnabled: true, synced });
    await settle();
    expect(o.$('sync-enabled').checked).toBe(true);
    expect(o.$('language').value).toBe('sv');
    expect(o.sent.filter((m) => m.type === 'IMPORT_ACCOUNT_SETTINGS')).toHaveLength(1);
    o.change('theme-select', 'ocean');
    await settle();
    expect(o.syncWrites.at(-1).settings.theme).toBe('ocean');
  });

  it('a trial ending while the page is open puts the locks and the defaults up', async () => {
    const o = optionsPage({ premium: true });
    await settle();
    await o.setPremium(false);
    expect(o.$('nav-wrap').checked).toBe(false);
    expect(o.$('nav-wrap').disabled).toBe(true);
    expect(o.$('pro-settings-note').classList.contains('hidden')).toBe(false);
    expect(o.local.settings).toEqual(TRIAL);
  });
});
