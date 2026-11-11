/**
 * @vitest-environment jsdom
 *
 * Closing the AI writing assistant's result panel cancels its request
 * (popup/ai-assistant.js).
 *
 * While the panel waits for AI_RUN_ACTION it holds a port named
 * "mcpm-ai-run:<token>", the token the message carries, and the background
 * aborts the run when that port disconnects (tests/ai-cancel.test.js). So
 * every way the panel can go away has to close the port: X, Escape, a click
 * outside it, closeAllPopups (which closing the reply or compose editor and
 * switching message call), the trigger, and starting another action. The
 * browser closes it with the popup or popout window itself.
 *
 * The real popup/editor-toolbar.js runs alongside, since Escape and
 * closeAllPopups reach the panel through its registry. sendMessage answers
 * AI_RUN_ACTION only when a test says so, and connect hands out fake ports.
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { inspect } from 'util';

const ROOT = join(__dirname, '..');
const read = (rel) => readFileSync(join(ROOT, rel), 'utf-8');
const PORT = 'mcpm-ai-run:';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

let PopupEditorToolbar;
let PopupScribe;

beforeAll(() => {
  ({ PopupEditorToolbar, PopupScribe } = new Function(
    read('popup/editor-toolbar.js') + '\n' + read('popup/ai-assistant.js') +
    '\nreturn { PopupEditorToolbar, PopupScribe };')());
});

let calls;  // what the module did, in order: 'connect' and message types
let sent;   // every message sent, whole
let runs;   // AI_RUN_ACTION messages, each with resolve/reject
let ports;
let toasts;

/** A runtime.Port as the popup gets it from connect(). */
function fakeConnect(info) {
  calls.push('connect');
  const port = {
    name: info.name,
    disconnects: 0,
    posts: 0,   // postMessage attempts, failed ones included
    pings: 0,
    gone: false,
    disconnectListeners: [],
    onDisconnect: { addListener: (fn) => port.disconnectListeners.push(fn) },
    postMessage(msg) {
      port.posts++;
      // Both browsers throw on a port that is closed at either end.
      if (port.disconnects || port.gone) throw new Error('Attempt to postMessage on disconnected port');
      if (msg && msg.type === 'PING') port.pings++;
    },
    disconnect() { port.disconnects++; },
    /** The background end going away: the browser fires onDisconnect here. */
    drop() { port.gone = true; for (const fn of port.disconnectListeners) fn(port); },
  };
  ports.push(port);
  return port;
}

function deps(overrides) {
  return {
    sendMessage: (msg) => {
      calls.push(msg.type);
      sent.push(msg);
      if (msg.type === 'AI_CAPABILITY') return Promise.resolve({ available: true, mode: 'server', reason: 'ok' });
      if (msg.type !== 'AI_RUN_ACTION') return Promise.resolve();
      return new Promise((resolve, reject) => runs.push({ msg, resolve, reject }));
    },
    connect: fakeConnect,
    showToast: (msg) => toasts.push(msg),
    t: (key) => key,
    isPremium: () => true,
    setHTML: () => {},
    ...overrides,
  };
}

const editor = () => document.getElementById('editor');
const trigger = () => document.getElementById('trigger');
const panel = () => document.querySelector('.scribe-panel');
const flush = () => new Promise((r) => setTimeout(r, 0));

function ctx() {
  return {
    accountId: 'acct-1', recipient: 'Recipient', sender: 'Sender', locale: 'en', isHtml: true,
    getText: () => editor().textContent,
    replace: (text) => { editor().textContent = text; },
    insert: (text) => { editor().textContent += text; },
    snapshot: () => editor().textContent,
    restore: (text) => { editor().textContent = text; },
  };
}

/** Open the menu and pick a row (1 = Proofread), up to the request in flight. */
async function start(row = 1, wait = flush) {
  await PopupScribe.update(trigger(), ctx());
  trigger().click();
  document.querySelectorAll('.scribe-menu-item')[row].click();
  await wait(); // arms the panel's outside-click handler
}

beforeEach(() => {
  document.body.innerHTML = '<div id="editor" contenteditable="true">A draft.</div>' +
    '<button id="trigger" type="button"></button><button id="elsewhere" type="button"></button>';
  calls = [];
  sent = [];
  runs = [];
  ports = [];
  toasts = [];
  PopupScribe.init(deps());
});

afterEach(() => {
  PopupScribe.close();
  PopupEditorToolbar.closeAllPopups();
  vi.useRealTimers();
  delete globalThis.browser;
});

describe('the request and its port', () => {
  it('opens the port before sending, named after the token the message carries', async () => {
    await start();
    expect(ports).toHaveLength(1);
    expect(runs).toHaveLength(1);
    expect(runs[0].msg).toMatchObject({ type: 'AI_RUN_ACTION', action: 'proofread', text: 'A draft.' });
    expect(runs[0].msg.token).toMatch(UUID);
    expect(ports[0].name).toBe(PORT + runs[0].msg.token);
    expect(calls.slice(calls.indexOf('connect'))).toEqual(['connect', 'AI_RUN_ACTION']);
    expect(ports[0].disconnects).toBe(0);
  });

  it('Write for me gets a token and a port too', async () => {
    await start(0);
    document.querySelector('.scribe-topic').value = 'Ask about the meeting';
    document.querySelector('.scribe-generate').click();
    await flush();
    expect(runs).toHaveLength(1);
    expect(runs[0].msg).toMatchObject({ action: 'writeFullEmail', prompt: 'Ask about the meeting' });
    expect(ports).toHaveLength(1);
    expect(ports[0].name).toBe(PORT + runs[0].msg.token);
  });

  it('gives every request its own token', async () => {
    await start();
    runs[0].resolve({ ok: true, result: 'One.' });
    await flush();
    PopupScribe.close();
    await start();
    expect(runs[1].msg.token).toMatch(UUID);
    expect(runs[1].msg.token).not.toBe(runs[0].msg.token);
    expect(ports[1].name).toBe(PORT + runs[1].msg.token);
  });
});

describe('the token stays out of the logs', () => {
  // With debug logging on, popup.js forwards console warnings and errors to
  // the exported diagnostic log, so the token may reach neither the console
  // nor any message but the AI_RUN_ACTION that carries it.
  it.each([
    ['an answer', {}, () => runs[0].resolve({ ok: true, result: 'Done.' })],
    ['a close while waiting', {}, () => {
      PopupScribe.close();
      runs[0].resolve({ ok: false, error: 'ABORTED' });
    }],
    ['a send that fails', {}, () => runs[0].reject(new Error('Receiving end does not exist.'))],
    ['a connect that throws', { connect: () => { throw new Error('Extension context invalidated.'); } },
      () => runs[0].resolve({ ok: true, result: 'Done.' })],
  ])('%s', async (_, overrides, finish) => {
    const lines = [];
    const capture = (...args) => lines.push(args.map((a) => (typeof a === 'string' ? a : inspect(a))).join(' '));
    const spies = ['log', 'info', 'warn', 'error', 'debug'].map((m) => vi.spyOn(console, m).mockImplementation(capture));
    try {
      PopupScribe.init(deps(overrides));
      await start();
      finish();
      await flush();
    } finally {
      spies.forEach((s) => s.mockRestore());
    }
    const { token } = sent.find((m) => m.type === 'AI_RUN_ACTION');
    expect(token).toMatch(UUID);
    expect(lines.join('\n')).not.toContain(token);
    expect(inspect(sent.filter((m) => m.type !== 'AI_RUN_ACTION'), { depth: null })).not.toContain(token);
  });
});

describe('every way the panel goes away closes the port, once', () => {
  it.each([
    ['the X button', () => document.querySelector('.scribe-panel .scribe-x').click()],
    ['Escape', () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))],
    ['a click outside the panel', () => document.getElementById('elsewhere').click()],
    ['closeAllPopups (closing the editor, switching message)', () => PopupEditorToolbar.closeAllPopups()],
    ['the trigger, toggling the panel shut', () => trigger().click()],
    ['PopupScribe.close()', () => PopupScribe.close()],
  ])('%s', async (_, closeIt) => {
    await start();
    closeIt();
    expect(panel()).toBeNull();
    expect(ports[0].disconnects).toBe(1);

    // What the background then answers changes nothing.
    runs[0].resolve({ ok: false, error: 'ABORTED' });
    await flush();
    expect(ports[0].disconnects).toBe(1);
    expect(panel()).toBeNull();
    expect(document.querySelector('.scribe-error')).toBeNull();
    expect(toasts).toEqual([]);
  });

  it('starting another action closes the first port and opens a new one', async () => {
    await start(1);
    trigger().click(); // shuts the running panel
    trigger().click(); // the menu again
    document.querySelectorAll('.scribe-menu-item')[2].click(); // Expand
    await flush();
    expect(ports).toHaveLength(2);
    expect(ports[0].disconnects).toBe(1);
    expect(ports[1].disconnects).toBe(0);
    expect(runs[1].msg.token).not.toBe(runs[0].msg.token);
    expect(ports[1].name).toBe(PORT + runs[1].msg.token);

    // The background answers the cancelled first run with ABORTED. Arriving
    // now, it must not close the second panel, nor cancel its request.
    runs[0].resolve({ ok: false, error: 'ABORTED' });
    await flush();
    expect(panel()).not.toBeNull();
    expect(ports[1].disconnects).toBe(0);

    runs[1].resolve({ ok: true, result: 'Second answer.' });
    await flush();
    expect(document.querySelector('.scribe-result-text').textContent).toBe('Second answer.');
    expect(ports[1].disconnects).toBe(1);
  });
});

describe('when the answer comes', () => {
  it('renders it and closes the port, so none lingers', async () => {
    await start();
    runs[0].resolve({ ok: true, result: 'A better draft.' });
    await flush();
    expect(document.querySelector('.scribe-result-text').textContent).toBe('A better draft.');
    expect(ports[0].disconnects).toBe(1);

    document.querySelector('.scribe-insert').click();
    expect(editor().textContent).toBe('A draft.A better draft.');
    expect(ports[0].disconnects).toBe(1);
  });

  it('closes the port on an error answer too, and the error stays readable', async () => {
    await start();
    runs[0].resolve({ ok: false, error: 'TOO_LONG' });
    await flush();
    expect(document.querySelector('.scribe-error').textContent).toBe('scribeTooLong');
    expect(ports[0].disconnects).toBe(1);
    document.querySelector('.scribe-x').click();
    expect(ports[0].disconnects).toBe(1);
  });

  it('closes the port when sending fails outright', async () => {
    await start();
    runs[0].reject(new Error('Could not establish connection. Receiving end does not exist.'));
    await flush();
    expect(document.querySelector('.scribe-error').textContent).toBe('scribeFailed');
    expect(ports[0].disconnects).toBe(1);
  });

  it('a late answer after a close changes nothing', async () => {
    await start();
    document.querySelector('.scribe-x').click();
    runs[0].resolve({ ok: true, result: 'Too late.' });
    await flush();
    expect(panel()).toBeNull();
    expect(document.body.textContent).not.toContain('Too late.');
    expect(editor().textContent).toBe('A draft.');
    expect(toasts).toEqual([]);
    expect(ports[0].disconnects).toBe(1);
  });

  it('ABORTED with the panel still open closes it without any error', async () => {
    await start();
    runs[0].resolve({ ok: false, error: 'ABORTED' });
    await flush();
    expect(panel()).toBeNull();
    expect(document.querySelector('.scribe-error')).toBeNull();
    expect(toasts).toEqual([]);
    expect(ports[0].disconnects).toBe(1);
  });

  it('PREMIUM_REQUIRED from the background gate says it is a premium feature', async () => {
    await start();
    runs[0].resolve({ error: 'PREMIUM_REQUIRED', feature: 'AI_RUN_ACTION' });
    await flush();
    expect(document.querySelector('.scribe-error').textContent).toBe('premiumRequired');
  });
});

describe('the keep-alive PING', () => {
  const advance = (ms) => vi.advanceTimersByTimeAsync(ms);

  it('goes out every 20 s while the answer is awaited, and stops with it', async () => {
    vi.useFakeTimers();
    await start(1, () => advance(0));
    await advance(19999);
    expect(ports[0].pings).toBe(0);
    await advance(1);
    expect(ports[0].pings).toBe(1);
    await advance(40000);
    expect(ports[0].pings).toBe(3);

    runs[0].resolve({ ok: true, result: 'Done.' });
    await advance(0);
    await advance(60000);
    expect(ports[0].posts).toBe(3);
  });

  it('stops when the panel is closed', async () => {
    vi.useFakeTimers();
    await start(1, () => advance(0));
    await advance(20000);
    document.querySelector('.scribe-x').click();
    await advance(60000);
    expect(ports[0].posts).toBe(1);
  });

  it('stops when a PING throws before the disconnect is reported', async () => {
    vi.useFakeTimers();
    await start(1, () => advance(0));
    ports[0].gone = true; // closed at the far end, onDisconnect still on its way
    await advance(20000);
    await advance(60000);
    expect(ports[0].posts).toBe(1);
  });

  it('stops when the background end goes away, and the popup does not close it again', async () => {
    let lastErrorReads = 0;
    globalThis.browser = { runtime: { get lastError() { lastErrorReads++; return undefined; } } };
    vi.useFakeTimers();
    await start(1, () => advance(0));
    ports[0].drop();
    expect(lastErrorReads).toBe(1); // read, so Chrome reports nothing unchecked
    await advance(60000);
    expect(ports[0].posts).toBe(0);

    runs[0].reject(new Error('The message port closed before a response was received.'));
    await advance(0);
    expect(ports[0].disconnects).toBe(0);
    document.querySelector('.scribe-x').click();
    expect(ports[0].disconnects).toBe(0);
  });
});

describe('without a usable port the action works as before, just not cancellable', () => {
  it.each([
    ['no connect dep', { connect: undefined }],
    ['connect throws (Chrome after an extension update)', {
      connect: () => { calls.push('connect'); throw new Error('Extension context invalidated.'); },
    }],
  ])('%s', async (_, overrides) => {
    PopupScribe.init(deps(overrides));
    await start();
    expect(ports).toHaveLength(0);
    expect(runs).toHaveLength(1);
    runs[0].resolve({ ok: true, result: 'Still works.' });
    await flush();
    expect(document.querySelector('.scribe-result-text').textContent).toBe('Still works.');
    document.querySelector('.scribe-replace').click();
    expect(editor().textContent).toBe('Still works.');
  });
});

describe('popup.js wiring', () => {
  const POPUP = read('popup/popup.js');

  /** `async function name(...) { ... }` out of popup.js. */
  function lift(name) {
    const start = POPUP.search(new RegExp('(async )?function ' + name + '\\('));
    if (start === -1) throw new Error('function not found in popup.js: ' + name);
    let depth = 0;
    for (let i = POPUP.indexOf('{', start); i < POPUP.length; i++) {
      if (POPUP[i] === '{') depth++;
      else if (POPUP[i] === '}') { depth--; if (depth === 0) return POPUP.slice(start, i + 1); }
    }
    throw new Error('unbalanced braces reading ' + name);
  }

  it('hands PopupScribe a connect that opens a runtime port', () => {
    const init = POPUP.slice(POPUP.indexOf('PopupScribe.init({'), POPUP.indexOf('});', POPUP.indexOf('PopupScribe.init({')));
    expect(init).toContain('connect: (info) => browser.runtime.connect(info),');
  });

  describe('openPreview, as j/k and Enter call it', () => {
    // A click on another message closes the panel as an outside click; j/k and
    // Enter switch message without any click, and the panel stayed open over
    // the next message, its request still running. openPreview is taken out of
    // popup.js the way tests/replied-indicator.test.js takes it, with the real
    // PopupEditorToolbar, and called with no opts, as the keyboard route does.
    const NEXT = { ID: 'm2', Subject: 'Next', Time: 1, Sender: { Name: 'Next', Address: 'next@example.org' } };
    const ELEMENTS = ['previewSender', 'previewTime', 'previewReplyState', 'externalContentBanner',
      'previewAvatar', 'previewSubject', 'previewTo', 'previewLabels', 'previewActionsEl', 'previewBody',
      'previewPanel', 'calendarInviteEl', 'btnToggleFormat', 'replyBody', 'replyCcBccRows',
      'replyFromSelect', 'replyFromRow'];
    const NOOPS = ['_renderReplyState', '_updateReplyModeUI', '_updateCanvasButton',
      '_updatePreviewModeIndicator', '_updateNavButtons'];
    let loading; // the panel and port as the next message starts loading

    function openPreviewWith(confirmLeavingReply) {
      const chips = { clearChips: () => {} };
      const env = {
        ...Object.fromEntries(ELEMENTS.map((n) => [n, document.createElement('div')])),
        ...Object.fromEntries(NOOPS.map((n) => [n, () => {}])),
        PopupEditorToolbar,
        ProtonI18n: { t: (k) => k },
        _confirmLeavingReply: confirmLeavingReply,
        formatFullTime: () => '',
        createAvatarEl: () => {
          const wrap = document.createElement('div');
          wrap.appendChild(document.createElement('div')).className = 'msg-avatar';
          return wrap;
        },
        _senderIconsAllowed: () => false,
        _getFormatTitle: () => '',
        _previewModeFor: () => 'html',
        showPremiumUI: () => true,
        isPremium: () => true,
        _settings: {},
        _setHTML: (target) => { target.textContent = ''; },
        replyText: document.createElement('textarea'),
        replyPicker: { clear: () => {} },
        _wantReplyFrom: () => {},
        chipForwardTo: chips,
        chipReplyCc: chips,
        chipReplyBcc: chips,
        fetchAndShowBody: async () => { loading = { panel: panel(), disconnects: ports[0].disconnects }; },
      };
      return new Function('__env',
        'let _selectedMsg, _readWhileOpenId, _externalContentLoaded, _replyMode, _replyEditorOpen, ' +
        '_replyBaseline, _rawPreviewBody, _previewMode;\n' +
        'const { ' + Object.keys(env).join(', ') + ' } = __env;\n' +
        lift('openPreview') + '\nreturn openPreview;')(env);
    }

    beforeEach(() => { loading = null; });

    it('closes the panel, and so cancels its request, before the next message loads', async () => {
      await start();
      await openPreviewWith(async () => true)(NEXT);
      expect(loading).toEqual({ panel: null, disconnects: 1 });
      expect(panel()).toBeNull();
    });

    it('leaves the panel and its request alone when the user keeps the reply', async () => {
      await start();
      await openPreviewWith(async () => false)(NEXT);
      expect(loading).toBeNull();
      expect(panel()).not.toBeNull();
      expect(ports[0].disconnects).toBe(0);
    });
  });
});
