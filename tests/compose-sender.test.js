/**
 * @vitest-environment jsdom
 *
 * Compose's sender: "Send as" (or From, with one account) lists the
 * account's addresses and "Other +alias…", which opens a field to type a
 * +alias of one of them (Pro). These tests follow the choice from the
 * picker to what is sent and saved:
 *   - the Send handler passes the typed +alias as params.senderAddress, and
 *     sends nothing for a refused alias or once Pro has ended;
 *   - a restored draft's sender comes back when the addresses arrive, also
 *     after a later fill, and stands in for the picker while they are not
 *     loaded, instead of the default address;
 *   - a fill for an account the user has left does not overwrite the next.
 *
 * House style: the functions under test are lifted out of popup.js by name
 * and run with their dependencies injected.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const ROOT = join(__dirname, '..');
const POPUP = readFileSync(join(ROOT, 'popup', 'popup.js'), 'utf-8');
const ProtonSenderAlias = new Function(readFileSync(join(ROOT, 'lib', 'sender-alias.js'), 'utf-8') + '\nreturn ProtonSenderAlias;')();
const OTHER_ALIAS = /const OTHER_ALIAS = '([^']+)';/.exec(POPUP)[1];

// Index just past a string literal or a comment starting at i.
function skipLiteral(src, i) {
  const c = src[i];
  if (c === '/' && src[i + 1] === '/') { const nl = src.indexOf('\n', i); return nl === -1 ? src.length : nl; }
  if (c === '/' && src[i + 1] === '*') return src.indexOf('*/', i + 2) + 2;
  if (c === '\'' || c === '"' || c === '`') {
    let j = i + 1;
    while (j < src.length && src[j] !== c) j += src[j] === '\\' ? 2 : 1;
    return j + 1;
  }
  return i;
}

function lift(name) {
  const m = new RegExp('(async )?function ' + name + '\\(').exec(POPUP);
  if (!m) throw new Error('function not found in popup.js: ' + name);
  let depth = 0;
  for (let i = POPUP.indexOf('{', POPUP.indexOf(') {', m.index)); i < POPUP.length; i++) {
    const next = skipLiteral(POPUP, i);
    if (next !== i) { i = next - 1; continue; }
    if (POPUP[i] === '{') depth++;
    else if (POPUP[i] === '}') { depth--; if (depth === 0) return POPUP.slice(m.index, i + 1); }
  }
  throw new Error('unbalanced braces reading ' + name);
}

/**
 * The named functions with `env` as their constants and `state` as
 * module-level lets, readable through get() and settable through set().
 */
function sandbox(names, env, state = {}) {
  const vars = Object.keys(state);
  const src = [
    'const { ' + Object.keys(env).join(', ') + ' } = __env;',
    vars.length ? 'let ' + vars.map((v) => v + ' = __state.' + v).join(', ') + ';' : '',
    ...names.map(lift),
    'return { ' + names.join(', ') + ', get: () => ({ ' + vars.join(', ') + ' }), set: (o) => { '
      + vars.map((v) => 'if (\'' + v + '\' in o) ' + v + ' = o.' + v + ';').join(' ') + ' } };',
  ].join('\n');
  return new Function('__env', '__state', src)(env, state);
}

const A = (ID, Email, CanAlias = true) => ({ ID, Email, DisplayName: 'Me ' + ID, Order: ID === 'main' ? 1 : 2, CanAlias });
const MAIN = A('main', 'Name@example.com');
const OTHER = A('other', 'other@example.org');

let premium;
let prompts;

beforeEach(() => {
  premium = true;
  prompts = [];
  document.body.innerHTML = '<div id="sender-row" class="hidden"><select id="sel"></select></div>'
    + '<div id="alias-row" class="hidden"><input id="alias"><p id="err" class="hidden"></p></div>';
});

/** The real sender picker over the test page's select and field. */
function picker() {
  const { _makeSenderPicker } = sandbox(['_makeSenderPicker'], {
    document,
    ProtonI18n: { t: (k) => k },
    ProtonSenderAlias,
    OTHER_ALIAS,
    isPremium: () => premium,
    // As popup.js requirePremium: the upgrade prompt only without Premium.
    requirePremium: (feature) => { if (premium) return true; prompts.push(feature); return false; },
  });
  return _makeSenderPicker(document.getElementById('sel'), document.getElementById('alias-row'),
    document.getElementById('alias'), document.getElementById('err'));
}

const choose = (value) => {
  const s = document.getElementById('sel');
  s.value = value;
  s.dispatchEvent(new Event('change'));
};

describe('sending a new mail', () => {
  function send(composePicker, want = '') {
    const sent = [];
    const toasts = [];
    const chips = (list) => ({ commitPending() {}, getChips: () => list });
    const h = sandbox(['handleSendCompose'], {
      composeFrom: { value: 'acc1', selectedOptions: [{ textContent: 'me' }] },
      _composeAccountId: 'acc1',
      chipTo: chips([{ address: 'friend@example.net', name: '' }]),
      chipCc: chips([]),
      chipBcc: chips([]),
      showToast: (t) => toasts.push(t),
      ProtonI18n: { t: (k) => k },
      _blockOnInvalidRecipient: () => false,
      composePicker,
      _composeSenderWant: want,
      btnComposeSend: document.createElement('button'),
      _settings: { composeFormat: 'plaintext' },
      composeSubject: { value: 's' },
      composeBody: { innerText: 'b', innerHTML: 'b' },
      _composeAttachments: [],
      _inlineDataUrlImages: (html) => ({ html, attachments: [] }),
      composeSendOpts: null,
      browser: { runtime: { sendMessage: async (m) => { sent.push(m); return { success: true }; } } },
      _sendErrorMessage: (c) => c,
      closeCompose: () => {},
    });
    return h.handleSendCompose().then(() => ({ sent, toasts }));
  }

  it('goes out from the +alias typed in the field', async () => {
    const p = picker();
    p.fill([MAIN]);
    choose(OTHER_ALIAS);
    document.getElementById('alias').value = 'name+shop@example.com';
    const { sent, toasts } = await send(p);
    expect(toasts).not.toContain('sendFailed');
    expect(sent).toHaveLength(1);
    expect(sent[0].type).toBe('SEND_NEW_MESSAGE');
    expect(sent[0].params.senderAddress).toBe('Name+shop@example.com');
  });

  it('goes out from the address chosen', async () => {
    const p = picker();
    p.fill([MAIN, OTHER], { preferred: 'other@example.org' });
    const { sent } = await send(p);
    expect(sent[0].params.senderAddress).toBe('other@example.org');
  });

  it('sends nothing when the typed +alias is not one of the account\'s', async () => {
    const p = picker();
    p.fill([MAIN]);
    choose(OTHER_ALIAS);
    document.getElementById('alias').value = 'someone+shop@example.com';
    const { sent } = await send(p);
    expect(sent).toEqual([]);
  });

  it('sends nothing once Pro has ended, and says it is Pro', async () => {
    const p = picker();
    p.fill([MAIN]);
    choose(OTHER_ALIAS);
    document.getElementById('alias').value = 'name+shop@example.com';
    premium = false;
    const { sent } = await send(p);
    expect(sent).toEqual([]);
    expect(prompts).toEqual(['plusAlias']);
  });

  it('while the addresses have not loaded, sends a restored draft\'s sender, not the default address', async () => {
    const p = picker(); // never filled
    const { sent } = await send(p, 'Name+shop@example.com');
    expect(sent[0].params.senderAddress).toBe('Name+shop@example.com');
  });
});

describe('filling "Send as"', () => {
  function filler(answer) {
    const composePicker = picker();
    const f = sandbox(['_fillComposeSender'], {
      composePicker,
      composeSenderRow: document.getElementById('sender-row'),
      _syncComposeFromRows: () => {},
      browser: { runtime: { sendMessage: (m) => answer(m) } },
    }, { _composeSenderToken: 0, _composeSenderWant: '' });
    return { ...f, composePicker };
  }
  const options = () => [...document.getElementById('sel').options].map((o) => o.value);

  it('selects the primary address and shows the row', async () => {
    const f = filler(async () => [OTHER, MAIN]);
    await f._fillComposeSender('acc1');
    expect(f.composePicker.value()).toBe('Name@example.com');
    expect(document.getElementById('sender-row').classList.contains('hidden')).toBe(false);
  });

  it('brings back the +alias a restored draft had', async () => {
    const f = filler(async () => [MAIN]);
    f.set({ _composeSenderWant: 'name+shop@example.com' });
    await f._fillComposeSender('acc1');
    expect(document.getElementById('sel').value).toBe(OTHER_ALIAS);
    expect(f.composePicker.value()).toBe('name+shop@example.com');
  });

  it('lets a later fill win over an older answer that arrives last', async () => {
    const pending = {};
    const f = filler((m) => new Promise((r) => { pending[m.accountId] = r; }));
    const first = f._fillComposeSender('acc1');
    const second = f._fillComposeSender('acc2');
    pending.acc2([OTHER]);
    await second;
    pending.acc1([MAIN]);
    await first;
    expect(options()).toEqual(['other@example.org', OTHER_ALIAS]);
  });

  it('keeps the row hidden when the addresses cannot be loaded', async () => {
    const f = filler(async () => ({ error: 'offline' }));
    await f._fillComposeSender('acc1');
    expect(document.getElementById('sender-row').classList.contains('hidden')).toBe(true);
    expect(f.composePicker.value()).toBe('');
  });
});

describe('a Compose draft', () => {
  function save(composePicker, want) {
    let stored = null;
    const chip = () => ({ getChips: () => [], getPending: () => '' });
    const { _saveDraft } = sandbox(['_saveDraft'], {
      composePanel: { classList: { contains: () => false } },
      composeFrom: { value: 'acc1' },
      composePicker,
      composeSubject: { value: 's' },
      composeBody: { innerHTML: 'b' },
      _historyFor: () => null,
      chipTo: chip(), chipCc: chip(), chipBcc: chip(),
      composeCcBccRows: { classList: { contains: () => true } },
      composeSendOpts: null,
      composeDriveShare: null,
      _noteDraftSave: () => {},
      browser: { runtime: { sendMessage: async (m) => { stored = m.draft; return { success: true }; } } },
    }, { _restoringDraft: false, _composeAccountId: 'acc1', _composeAttachments: [], _replyEditorOpen: false,
      _selectedMsg: null, _composeSenderWant: want });
    _saveDraft();
    return stored;
  }

  it('keeps the sender chosen', () => {
    expect(save({ value: () => 'Name+shop@example.com' }, '').composeSender).toBe('Name+shop@example.com');
  });

  it('keeps a restored draft\'s sender while the addresses have not loaded', () => {
    expect(save({ value: () => '' }, 'Name+shop@example.com').composeSender).toBe('Name+shop@example.com');
  });
});
