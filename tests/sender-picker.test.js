/**
 * @vitest-environment jsdom
 *
 * The sender of a reply (From) and of a new mail (Compose's "Send as"):
 * the account's addresses, a +alias the mail being answered was sent to,
 * and "Other +alias…", which opens a field to type a +alias of one of the
 * addresses. Proton sends from any +alias of an own address, one never used
 * before included (measured), so the field takes any valid tag.
 *
 * Typing a +alias is Pro: without Premium, "Other +alias…" shows the
 * upgrade prompt and the select goes back, and a send with a typed alias is
 * stopped the same way.
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

function lift(name) {
  const m = new RegExp('(async )?function ' + name + '\\(').exec(POPUP);
  if (!m) throw new Error('function not found in popup.js: ' + name);
  let depth = 0;
  for (let i = POPUP.indexOf('{', POPUP.indexOf(') {', m.index)); i < POPUP.length; i++) {
    const c = POPUP[i];
    if (c === '\'' || c === '"' || c === '`') {
      let j = i + 1;
      while (j < POPUP.length && POPUP[j] !== c) j += POPUP[j] === '\\' ? 2 : 1;
      i = j;
      continue;
    }
    if (c === '/' && POPUP[i + 1] === '/') { i = POPUP.indexOf('\n', i); continue; }
    // A block comment may hold a lone apostrophe ("the account's").
    if (c === '/' && POPUP[i + 1] === '*') { i = POPUP.indexOf('*/', i + 2) + 1; continue; }
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) return POPUP.slice(m.index, i + 1); }
  }
  throw new Error('unbalanced braces reading ' + name);
}

const A = (ID, Email, CanAlias = true) => ({ ID, Email, DisplayName: 'Me ' + ID, Order: ID === 'main' ? 1 : 2, CanAlias });
const MAIN = A('main', 'Name@example.com');
const SECOND = A('second', 'second@example.org');
const EXTERNAL = A('ext', 'me@example.net', false);

let premium;
let prompts;
let dom;

function build(extraEnv = {}, names = ['_makeSenderPicker'], mutable = []) {
  const env = {
    document,
    ProtonI18n: { t: (k) => k },
    ProtonSenderAlias,
    OTHER_ALIAS,
    isPremium: () => premium,
    // As popup.js requirePremium: the upgrade prompt only without Premium.
    requirePremium: (feature) => { if (premium) return true; prompts.push(feature); return false; },
    ...extraEnv,
  };
  const src = (mutable.length ? 'let ' + mutable.join(', ') + ';\n' : '')
    + 'const { ' + Object.keys(env).join(', ') + ' } = __env;\n'
    + names.map(lift).join('\n\n') + '\nreturn { ' + names.join(', ') + ' };';
  return new Function('__env', src)(env);
}

beforeEach(() => {
  premium = true;
  prompts = [];
  document.body.innerHTML = '<div id="row"><select id="sel"></select></div>'
    + '<div id="alias-row" class="hidden"><input id="alias"><p id="err" class="hidden"></p></div>';
  dom = {
    select: document.getElementById('sel'),
    aliasRow: document.getElementById('alias-row'),
    aliasInput: document.getElementById('alias'),
    aliasError: document.getElementById('err'),
  };
});

const picker = () => build()._makeSenderPicker(dom.select, dom.aliasRow, dom.aliasInput, dom.aliasError);
const choose = (value) => {
  dom.select.value = value;
  dom.select.dispatchEvent(new Event('change'));
};
const options = () => [...dom.select.options].map((o) => o.value);

describe('the sender select', () => {
  it('lists the addresses and ends with "Other +alias…"', () => {
    const p = picker();
    p.fill([MAIN, SECOND], { preferred: 'second@example.org' });
    expect(options()).toEqual(['Name@example.com', 'second@example.org', OTHER_ALIAS]);
    expect(dom.select.value).toBe('second@example.org');
    expect(p.value()).toBe('second@example.org');
  });

  it('puts a +alias the mail was sent to first, selected', () => {
    const p = picker();
    p.fill([MAIN], { detected: 'name+shop@example.com', preferred: 'Name@example.com' });
    expect(options()[0]).toBe('name+shop@example.com');
    expect(p.value()).toBe('name+shop@example.com');
  });

  it('offers no "Other +alias…" when no address can carry one', () => {
    picker().fill([EXTERNAL]);
    expect(options()).toEqual(['me@example.net']);
  });
});

describe('"Other +alias…"', () => {
  it('opens the field with the chosen address and a "+" to type after', () => {
    const p = picker();
    p.fill([MAIN, SECOND], { preferred: 'second@example.org' });
    choose(OTHER_ALIAS);
    expect(dom.aliasRow.classList.contains('hidden')).toBe(false);
    expect(dom.aliasInput.value).toBe('second+@example.org');
    expect(dom.aliasInput.selectionStart).toBe('second+'.length);
    expect(prompts).toEqual([]);
  });

  it('starts from an address that can carry one when the chosen one cannot', () => {
    const p = picker();
    p.fill([EXTERNAL, MAIN], { preferred: 'me@example.net' });
    choose(OTHER_ALIAS);
    expect(dom.aliasInput.value).toBe('Name+@example.com');
  });

  it('without Pro, says it is Pro and goes back to the address chosen before', () => {
    premium = false;
    const p = picker();
    p.fill([MAIN, SECOND], { preferred: 'second@example.org' });
    choose(OTHER_ALIAS);
    expect(prompts).toEqual(['plusAlias']);
    expect(dom.select.value).toBe('second@example.org');
    expect(dom.aliasRow.classList.contains('hidden')).toBe(true);
  });

  it('sends from the +alias typed, written the way Proton writes it', () => {
    const p = picker();
    p.fill([MAIN]);
    choose(OTHER_ALIAS);
    dom.aliasInput.value = 'name+Never.Used-1@EXAMPLE.com';
    expect(p.validate()).toBe(true);
    expect(p.value()).toBe('Name+Never.Used-1@example.com');
    expect(p.senderName()).toBe('Me main');
  });

  it.each([
    ['a tag with a space', 'name+my shop@example.com'],
    ['no tag', 'name+@example.com'],
    ['another domain', 'name+shop@example.net'],
    ['an address that is not the account\'s', 'someone+shop@example.com'],
    ['a tag with an =', 'name+a=b@example.com'],
  ])('refuses %s and says how a +alias looks', (_label, typed) => {
    const p = picker();
    p.fill([MAIN]);
    choose(OTHER_ALIAS);
    dom.aliasInput.value = typed;
    expect(p.validate()).toBe(false);
    expect(dom.aliasError.classList.contains('hidden')).toBe(false);
    expect(dom.aliasError.textContent).toBe('plusAliasInvalid');
    expect(dom.aliasInput.getAttribute('aria-invalid')).toBe('true');
    // Typing again clears the complaint.
    dom.aliasInput.dispatchEvent(new Event('input'));
    expect(dom.aliasError.classList.contains('hidden')).toBe(true);
  });

  it('stops a send with a typed +alias once Pro has ended', () => {
    const p = picker();
    p.fill([MAIN]);
    choose(OTHER_ALIAS);
    dom.aliasInput.value = 'name+shop@example.com';
    premium = false;
    expect(p.validate()).toBe(false);
    expect(prompts).toEqual(['plusAlias']);
  });

  it('a chosen address needs no check', () => {
    const p = picker();
    p.fill([MAIN]);
    expect(p.validate()).toBe(true);
    expect(prompts).toEqual([]);
  });
});

describe('a restored draft', () => {
  it('gets back an address it had', () => {
    const p = picker();
    p.fill([MAIN, SECOND]);
    p.setValue('SECOND@example.org');
    expect(p.value()).toBe('second@example.org');
  });

  it('gets back a +alias it had in the field', () => {
    const p = picker();
    p.fill([MAIN]);
    p.setValue('Name+shop@example.com');
    expect(dom.select.value).toBe(OTHER_ALIAS);
    expect(dom.aliasRow.classList.contains('hidden')).toBe(false);
    expect(p.value()).toBe('Name+shop@example.com');
  });

  it('without Pro, keeps the address shown instead of a typed +alias', () => {
    premium = false;
    const p = picker();
    p.fill([MAIN]);
    p.setValue('Name+shop@example.com');
    expect(p.value()).toBe('Name@example.com');
  });

  it('ignores a sender that is not the account\'s', () => {
    const p = picker();
    p.fill([MAIN]);
    p.setValue('someone@example.net');
    expect(p.value()).toBe('Name@example.com');
  });
});

describe('the reply\'s From', () => {
  function populate(addresses, msg, { selected = msg, want = '' } = {}) {
    document.body.innerHTML += '<div id="from-row" class="hidden"></div>';
    const row = document.getElementById('from-row');
    const { _makeSenderPicker } = build();
    const replyPicker = _makeSenderPicker(dom.select, dom.aliasRow, dom.aliasInput, dom.aliasError);
    const { _populateReplyFrom, _applyReplyFromWant } = build({
      replyPicker,
      replyFromRow: row,
      _selectedMsg: selected,
      _replyFromWant: want,
      browser: { runtime: { sendMessage: async () => addresses } },
    }, ['_populateReplyFrom', '_applyReplyFromWant'], ['_replyAddresses']);
    void _applyReplyFromWant;
    return _populateReplyFrom(msg, 'acc').then(() => ({ row, value: replyPicker.value(), options: options() }));
  }

  it('answers from the +alias the X-Original-To header names, also when the mail came by BCC', async () => {
    const r = await populate([MAIN, SECOND], {
      ID: 'm1',
      ParsedHeaders: { 'X-Original-To': 'name+bcc@example.com' },
      ToList: [{ Address: 'list@example.net' }],
      AddressID: 'main',
    });
    expect(r.value).toBe('Name+bcc@example.com');
  });

  it('does not answer from a +alias of another of the user\'s addresses than the one the mail went to', async () => {
    // Delivered to second@example.org; the To list names a +alias of Name@.
    const r = await populate([MAIN, SECOND], {
      ID: 'm1',
      ToList: [{ Address: 'name+other@example.com' }, { Address: 'second@example.org' }],
      AddressID: 'second',
    });
    expect(r.value).toBe('second@example.org');
  });

  it('brings back a restored draft\'s +alias once the From is filled', async () => {
    const r = await populate([MAIN], { ID: 'm1', ToList: [{ Address: 'Name@example.com' }] }, { want: 'Name+old@example.com' });
    expect(r.value).toBe('Name+old@example.com');
  });

  it('leaves the From alone when another message opened while the addresses loaded', async () => {
    const r = await populate([MAIN, SECOND], { ID: 'm1', ToList: [] }, { selected: { ID: 'm2' } });
    expect(r.options).toEqual([]);
  });

  it('shows the row to a Pro user with one address, for "Other +alias…"', async () => {
    const r = await populate([MAIN], { ToList: [{ Address: 'Name@example.com' }] });
    expect(r.row.classList.contains('hidden')).toBe(false);
  });

  it('hides it without Pro when there is nothing to choose', async () => {
    premium = false;
    const r = await populate([MAIN], { ToList: [{ Address: 'Name@example.com' }] });
    expect(r.row.classList.contains('hidden')).toBe(true);
  });
});

describe('Compose\'s From with one account or several', () => {
  function rows(accounts, addressesShown) {
    document.body.innerHTML = '<div id="from-row"></div><div id="sender-row"' + (addressesShown ? '' : ' class="hidden"')
      + '><label id="sender-label">sendAs</label></div>';
    const env = {
      composeFromRow: document.getElementById('from-row'),
      composeSenderRow: document.getElementById('sender-row'),
      composeSenderLabel: document.getElementById('sender-label'),
      ProtonI18n: { t: (k) => k },
      _composeAccountCount: accounts,
    };
    const src = 'const { ' + Object.keys(env).join(', ') + ' } = __env;\n' + lift('_syncComposeFromRows') + '\nreturn _syncComposeFromRows;';
    new Function('__env', src)(env)();
    return { fromHidden: env.composeFromRow.classList.contains('hidden'), label: env.composeSenderLabel.textContent };
  }

  it('one account: its addresses take the From row, labelled "From"', () => {
    expect(rows(1, true)).toEqual({ fromHidden: true, label: 'from' });
  });

  it('several accounts: From picks the account, "Send as" the address', () => {
    expect(rows(2, true)).toEqual({ fromHidden: false, label: 'sendAs' });
  });

  it('keeps the account select while the addresses load, or when they cannot be loaded', () => {
    expect(rows(1, false).fromHidden).toBe(false);
  });
});

describe('around the sender choice', () => {
  it('puts the caret in the field when "Other +alias…" is chosen, and closes it when an address is', () => {
    const p = picker();
    p.fill([MAIN, SECOND]);
    choose(OTHER_ALIAS);
    expect(document.activeElement).toBe(dom.aliasInput);
    choose('second@example.org');
    expect(dom.aliasRow.classList.contains('hidden')).toBe(true);
    expect(p.value()).toBe('second@example.org');
  });

  it('gives the AI assistant the base address\'s name while a +alias is typed, never the option label', () => {
    const p = picker();
    p.fill([MAIN, SECOND], { preferred: 'second@example.org' });
    choose(OTHER_ALIAS);
    dom.aliasInput.value = 'second+';
    expect(p.senderName()).toBe('Me second');
  });

  it('runs no one-key shortcut while a select has the focus (a typed letter picks an address)', () => {
    expect(POPUP).toMatch(/e\.target\.tagName === 'TEXTAREA' \|\| e\.target\.tagName === 'SELECT'/);
  });

  it('says what is wrong when the background refuses a sender that is not the account\'s', () => {
    const I18N = new Function('window', 'self', readFileSync(join(ROOT, 'lib', 'i18n.js'), 'utf-8')
      + '; return window.ProtonI18n || self.ProtonI18n || ProtonI18n;')({}, {});
    const { _sendErrorMessage } = build({ ProtonI18n: I18N }, ['_sendErrorMessage']);
    expect(_sendErrorMessage('SENDER_NOT_OWNED')).toBe(I18N.t('senderNotOwned'));
    expect(I18N.t('senderNotOwned')).not.toBe('senderNotOwned');
  });
});
