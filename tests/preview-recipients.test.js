/**
 * @vitest-environment jsdom
 *
 * The recipients line in the message preview.
 *
 * It showed names only ("to: Alex Example"), so the address a mail went to
 * could only be found in the Pro "Message details" window. With "Show
 * recipients' email addresses" (Pro) every recipient shows as
 * "Name <address>", or the address alone when there is no name or the name
 * is the address, with To, CC and BCC each on a line of their own. Without
 * Pro the line stays as it was: names only, on one line.
 *
 * House style: the functions under test are lifted out of popup.js by name
 * and run with their dependencies injected.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const ROOT = join(__dirname, '..');
const read = (rel) => readFileSync(join(ROOT, rel), 'utf-8');
const POPUP = read('popup/popup.js');
const ProtonProSettings = new Function(read('lib/pro-settings.js') + '; return ProtonProSettings;')();
let ProtonI18n;

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

beforeAll(() => {
  ProtonI18n = new Function('window', 'self', read('lib/i18n.js') + '; return window.ProtonI18n || self.ProtonI18n || ProtonI18n;')({}, {});
});

/** The recipients line for a user with `stored` settings, Premium or not. */
function render(msg, { stored = {}, premium = true } = {}) {
  const previewTo = document.createElement('div');
  previewTo.className = 'preview-recipients';
  const env = { document, previewTo, ProtonI18n, _settings: ProtonProSettings.inEffect(stored, premium) };
  const names = ['_escapeHtmlText', '_setHTML', '_recipientText', '_renderRecipients'];
  const fns = new Function('__env', 'const { ' + Object.keys(env).join(', ') + ' } = __env;\n'
    + names.map(lift).join('\n\n') + '\nreturn { _renderRecipients };')(env);
  fns._renderRecipients(msg);
  return previewTo;
}

const MSG = {
  ToList: [{ Name: 'Alex Example', Address: 'alex@example.com' }, { Name: '', Address: 'plain@example.org' }],
  CCList: [{ Name: 'same@example.net', Address: 'same@example.net' }],
  BCCList: [{ Name: 'Hidden', Address: 'hidden@example.org' }],
};
const ON = { stored: { showRecipientAddresses: true }, premium: true };

describe('the recipients line', () => {
  it('without the option, shows names on one line, as before', () => {
    const el = render(MSG);
    expect(el.textContent).toBe('To: Alex Example, plain@example.org   CC: same@example.net');
    expect(el.classList.contains('recipients-full')).toBe(false);
    // Every name stands apart from the text around it.
    expect([...el.querySelectorAll('bdi')].map((b) => b.textContent)).toEqual(['Alex Example', 'plain@example.org', 'same@example.net']);
  });

  it('with it, shows "Name <address>" with To, CC and BCC each on a line of its own', () => {
    const el = render(MSG, ON);
    expect([...el.querySelectorAll('.recipient-line')].map((l) => l.textContent)).toEqual([
      'To: Alex Example <alex@example.com>, plain@example.org',
      'CC: same@example.net',
      'BCC: Hidden <hidden@example.org>',
    ]);
    expect(el.classList.contains('recipients-full')).toBe(true);
    // Names and addresses each stand apart, so neither can reorder the other.
    expect([...el.querySelectorAll('bdi')].map((b) => b.textContent)).toEqual([
      'Alex Example', 'alex@example.com', 'plain@example.org', 'same@example.net', 'Hidden', 'hidden@example.org',
    ]);
  });

  it('goes back to names only when the option is turned off again', () => {
    const el = render(MSG, ON);
    // The same element is reused for the next message.
    const env = { document, previewTo: el, ProtonI18n, _settings: ProtonProSettings.inEffect({}, true) };
    const names = ['_escapeHtmlText', '_setHTML', '_recipientText', '_renderRecipients'];
    new Function('__env', 'const { ' + Object.keys(env).join(', ') + ' } = __env;\n'
      + names.map(lift).join('\n\n') + '\nreturn { _renderRecipients };')(env)._renderRecipients(MSG);
    expect(el.classList.contains('recipients-full')).toBe(false);
    expect(el.querySelectorAll('.recipient-line').length).toBe(0);
  });

  it('is Pro: without Premium the stored choice does not apply', () => {
    const el = render(MSG, { stored: { showRecipientAddresses: true }, premium: false });
    expect(el.textContent).not.toContain('<alex@example.com>');
    expect(el.classList.contains('recipients-full')).toBe(false);
  });

  it('shows a name as text, never as markup, and keeps it apart from the address', () => {
    const el = render({ ToList: [{ Name: '<img src=x onerror=alert(1)>‮', Address: 'a@example.com' }] }, ON);
    expect(el.querySelector('img')).toBe(null);
    const bdi = el.querySelector('bdi');
    expect(bdi.textContent).toBe('<img src=x onerror=alert(1)>‮');
    expect(el.textContent).toContain('<a@example.com>');
  });

  it('leaves out empty lists and empty entries', () => {
    const el = render({ ToList: [{ Name: '', Address: '' }, { Name: 'A', Address: 'a@example.com' }], CCList: [] }, ON);
    expect([...el.querySelectorAll('.recipient-line')].map((l) => l.textContent)).toEqual(['To: A <a@example.com>']);
  });

  it('uses the translated labels', () => {
    ProtonI18n.setLanguage && ProtonI18n.setLanguage('de');
    try {
      const el = render({ ToList: [{ Name: 'A', Address: 'a@example.com' }] }, ON);
      expect(el.textContent.startsWith(ProtonI18n.t('toLabel'))).toBe(true);
    } finally {
      ProtonI18n.setLanguage && ProtonI18n.setLanguage('en');
    }
  });
});

describe('the sender line', () => {
  it('does not repeat an address that is also the name', () => {
    expect(POPUP).toMatch(/senderName\.trim\(\)\.toLowerCase\(\) !== senderEmail\.trim\(\)\.toLowerCase\(\)/);
  });
});
