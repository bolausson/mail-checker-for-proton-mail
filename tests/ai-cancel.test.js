/**
 * Closing the AI writing assistant's panel cancels its request
 * (background/background.js).
 *
 * The popup used to forget a running request when its panel went away, and
 * Proton kept writing an answer nobody would see. Now AI_RUN_ACTION carries
 * a random token, the popup holds a port named "mcpm-ai-run:<token>" while
 * it waits, and the port's disconnect aborts the run. The browser closes the
 * port with the popup or popout window, so closing, reloading or crashing
 * cancels too; tests/scribe-popup.test.js covers the popup's own closes.
 *
 * The port is handled at once while the message may wait for init, so they
 * can arrive in either order. Each order runs here against the REAL
 * ProtonAIAssistant, with ProtonAccounts stubbed the way tests/scribe.test.js
 * stubs it: a stream that trickles keep-alives until it is aborted, or one
 * that answers.
 *
 * background.js can't be imported (it touches browser APIs at load), so the
 * run state, the port handler, the onConnect listener and the AI_RUN_ACTION
 * case are sliced out of the source and evaluated together with stubs.
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import { randomUUID } from 'crypto';
import { join } from 'path';
import { inspect } from 'util';

const ROOT = join(__dirname, '..');
const read = (rel) => readFileSync(join(ROOT, rel), 'utf-8');
const BG = read('background/background.js');
const AI_SOURCE = read('background/ai-assistant.js');

const PORT = 'mcpm-ai-run:';
const EXT_ID = 'mail-checker@example.org';
const EXT_BASE = 'moz-extension://0b5e6c1a-1111-4222-8333-944455556666/';
const POPUP = { id: EXT_ID, url: EXT_BASE + 'popup/popup.html' };
const ABORTED = { ok: false, error: 'ABORTED' };
const KEY = Uint8Array.from({ length: 32 }, (_, i) => i + 1);

/** A top-level `function name(...) { ... }` out of `src`. */
function liftFn(src, name) {
  const m = new RegExp('(async )?function ' + name + '\\(').exec(src);
  if (!m) throw new Error('not found: ' + name);
  let depth = 0;
  for (let i = src.indexOf('{', src.indexOf(') {', m.index)); i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) return src.slice(m.index, i + 1); }
  }
  throw new Error('unbalanced braces reading ' + name);
}

/** A one-line top-level `const NAME = ...;`, with its trailing comment if any. */
function liftConst(name) {
  const m = new RegExp('^  const ' + name + ' = .*$', 'm').exec(BG);
  if (!m) throw new Error('const not found: ' + name);
  return m[0];
}

/** The runtime.onConnect registration, from its call to the closing `});`. */
function liftOnConnect() {
  const start = BG.indexOf('  browser.runtime.onConnect.addListener(');
  if (start === -1) throw new Error('onConnect listener not found');
  let depth = 0;
  for (let i = BG.indexOf('{', start); i < BG.length; i++) {
    if (BG[i] === '{') depth++;
    else if (BG[i] === '}') { depth--; if (depth === 0) return BG.slice(start, BG.indexOf(';', i) + 1); }
  }
  throw new Error('unbalanced braces reading the onConnect listener');
}

/** Source without its whole-line comments, for the structural checks. */
const code = (src) => src.replace(/^\s*\/\/.*$/gm, '');

/** The source of one `case 'TYPE':` block of the message switch. */
function caseBlock(type) {
  const start = BG.indexOf(`      case '${type}':`);
  if (start === -1) throw new Error('case not found: ' + type);
  const end = BG.indexOf('\n      case ', start + 1);
  return BG.slice(start, end);
}

/**
 * The sliced background: connect(port) is the browser delivering a port,
 * send(message) the AI_RUN_ACTION message once init let it through.
 */
function background({ ProtonAIAssistant, ProtonDrive = { handlePort: vi.fn() } }) {
  let onConnect = null;
  const browser = {
    runtime: {
      id: EXT_ID,
      getURL: (path) => EXT_BASE + path,
      onConnect: { addListener: (fn) => { onConnect = fn; } },
    },
  };
  const src = [
    ...['AI_RUN_PORT', 'AI_RUN_TOKEN', 'AI_RUN_MAX_CANCELLED', '_aiRuns'].map(liftConst),
    liftFn(BG, '_aiRunFor'),
    liftFn(BG, '_cancelAiRun'),
    liftFn(BG, '_handleAiRunPort'),
    liftOnConnect(),
    `function handleMessage(message, sender, sendResponse) {\nswitch (message.type) {\n${caseBlock('AI_RUN_ACTION')}\n}\n}`,
    'return { handleMessage, runs: _aiRuns };',
  ].join('\n\n');
  const built = new Function('browser', 'ProtonAIAssistant', 'ProtonDrive', src)(browser, ProtonAIAssistant, ProtonDrive);
  return {
    runs: built.runs,
    connect: (port) => onConnect(port),
    send(message) {
      let answer;
      const answered = new Promise((r) => { answer = r; });
      const ret = built.handleMessage({
        type: 'AI_RUN_ACTION', accountId: 'acct-7', action: 'proofread', text: 'A draft.', ...message,
      }, POPUP, answer);
      return { ret, answered };
    },
  };
}

/** A port as the background's onConnect listener receives it. */
function fakePort(name, sender = POPUP) {
  const port = {
    name,
    sender,
    disconnects: 0,
    messageListeners: [],
    disconnectListeners: [],
    onMessage: { addListener: (fn) => port.messageListeners.push(fn) },
    onDisconnect: { addListener: (fn) => port.disconnectListeners.push(fn) },
    disconnect() { port.disconnects++; },
    /** The popup end going away: the browser fires onDisconnect here. */
    close() { for (const fn of port.disconnectListeners) fn(port); },
  };
  return port;
}

const settle = async () => { for (let i = 0; i < 4; i++) await new Promise((r) => setImmediate(r)); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Every debugLog and console line until restore(), objects written out whole. */
function captureLogs() {
  const lines = [];
  const capture = (...args) => lines.push(args.map((a) => (typeof a === 'string' ? a : inspect(a))).join(' '));
  globalThis.debugLog = capture;
  const spies = ['log', 'info', 'warn', 'error', 'debug'].map((m) => vi.spyOn(console, m).mockImplementation(capture));
  return { lines, restore: () => spies.forEach((s) => s.mockRestore()) };
}

// ---------------------------------------------------------------------------
// The real ProtonAIAssistant, as tests/scribe.test.js loads it
// ---------------------------------------------------------------------------

let AI;
let net;

beforeAll(() => {
  globalThis.window = globalThis;
  globalThis.self = globalThis;
  // eslint-disable-next-line no-eval
  (0, eval)(read('lib/openpgp.min.js'));
  globalThis.ProtonBinary = new Function(read('lib/binary-utils.js') + '\nreturn ProtonBinary;')();
  globalThis.debugLog = () => {};
});

beforeEach(() => {
  AI = new Function(AI_SOURCE + '\nreturn ProtonAIAssistant;')();
  AI._setCipherContextFactory(() => AI._createCipherContext({ keyBytes: KEY }));
});

afterEach(() => {
  vi.useRealTimers();
  delete globalThis.ProtonAccounts;
  globalThis.debugLog = () => {};
});

/** An answer chunk sealed the way the server seals it, as one stream line. */
async function sealedDelta(text, opts) {
  const key = await crypto.subtle.importKey('raw', KEY, { name: 'AES-GCM' }, false, ['encrypt']);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const additionalData = new TextEncoder().encode(`lumo.response.${opts.data.lumo.request_id}.chunk`);
  const sealed = new Uint8Array(await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData, tagLength: 128 }, key, new TextEncoder().encode(text)));
  const bytes = new Uint8Array(12 + sealed.length);
  bytes.set(iv);
  bytes.set(sealed, 12);
  const content = Buffer.from(bytes).toString('base64');
  return `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content, encrypted: true }, finish_reason: null }] })}\n`;
}

/**
 * ProtonAccounts with the capability probes answered. The stream either
 * answers "Hello there." or, like a long generation, sends keep-alives until
 * it is aborted and then fails the way fetch does.
 */
function stubAccounts({ answers = false } = {}) {
  net = { requests: 0, signals: [] };
  globalThis.ProtonAccounts = {
    request: async (accountId, method, path) => {
      net.requests++;
      if (path === 'core/v4/settings') return { Code: 1000, UserSettings: { AIAssistantFlags: 2 } };
      if (path === 'ai/v1/models') return { object: 'list', data: [{ id: 'lumo-x' }] };
      throw new Error('unexpected request ' + path);
    },
    streamRequest: async (accountId, method, path, opts) => {
      net.signals.push(opts.signal);
      if (answers) { await opts.onText(await sealedDelta('Hello there.', opts)); return; }
      while (!opts.signal.aborted) {
        await opts.onText(': keep-alive\n');
        await sleep(5);
      }
      throw new DOMException('The operation was aborted.', 'AbortError');
    },
  };
}

// ---------------------------------------------------------------------------
// The arrival orders, against the real module
// ---------------------------------------------------------------------------

describe('a closed panel aborts its run, whichever arrives first', () => {
  it('port, message, then a close mid-stream: ABORTED, and the request is aborted', async () => {
    stubAccounts();
    const bg = background({ ProtonAIAssistant: AI });
    const token = randomUUID();
    const port = fakePort(PORT + token);
    bg.connect(port);
    const { ret, answered } = bg.send({ token });
    expect(ret).toBe(true);
    await vi.waitFor(() => expect(net.signals).toHaveLength(1));
    expect(net.signals[0].aborted).toBe(false);

    port.close();
    expect(await answered).toStrictEqual(ABORTED);
    expect(net.signals[0].aborted).toBe(true);
    await settle();
    expect(bg.runs.size).toBe(0);
  });

  it('message, port, then a close mid-stream: ABORTED, and the request is aborted', async () => {
    stubAccounts();
    const bg = background({ ProtonAIAssistant: AI });
    const token = randomUUID();
    const { answered } = bg.send({ token });
    const port = fakePort(PORT + token);
    bg.connect(port);
    await vi.waitFor(() => expect(net.signals).toHaveLength(1));

    port.close();
    expect(await answered).toStrictEqual(ABORTED);
    expect(net.signals[0].aborted).toBe(true);
    await settle();
    expect(bg.runs.size).toBe(0);
  });

  it('port, close, then the message (it waited for init): ABORTED without any request', async () => {
    stubAccounts();
    const bg = background({ ProtonAIAssistant: AI });
    const token = randomUUID();
    const port = fakePort(PORT + token);
    bg.connect(port);
    port.close();
    expect(bg.runs.size).toBe(1); // the cancel waits for its message

    const { answered } = bg.send({ token });
    expect(await answered).toStrictEqual(ABORTED);
    expect(net.requests).toBe(0); // not even the capability recheck
    expect(net.signals).toHaveLength(0);
    await settle();
    expect(bg.runs.size).toBe(0);
  });

  it('message, port, a normal end, then the popup closes the port: no entry is left', async () => {
    stubAccounts({ answers: true });
    const bg = background({ ProtonAIAssistant: AI });
    const token = randomUUID();
    const { answered } = bg.send({ token });
    const port = fakePort(PORT + token);
    bg.connect(port);
    expect(await answered).toStrictEqual({ ok: true, result: 'Hello there.' });
    await settle();
    expect(bg.runs.size).toBe(0);

    // The popup closes its port after every answer; that cancels nothing.
    port.close();
    expect(bg.runs.size).toBe(0);
  });

  it('port, close, a long wait, then the message: still ABORTED, no timer drops the cancel', async () => {
    vi.useFakeTimers();
    const bg = background({ ProtonAIAssistant: AI });
    const token = randomUUID();
    const port = fakePort(PORT + token);
    bg.connect(port);
    port.close();
    // A message parked behind a blocking init (first fetch without a
    // snapshot) can take longer than any timeout we could pick.
    await vi.advanceTimersByTimeAsync(2 * 60 * 60 * 1000);
    expect(vi.getTimerCount()).toBe(0);
    vi.useRealTimers();

    stubAccounts();
    const { answered } = bg.send({ token });
    expect(await answered).toStrictEqual(ABORTED);
    expect(net.requests).toBe(0);
    expect(net.signals).toHaveLength(0);
  });

  it('closing one port aborts that run only', async () => {
    stubAccounts();
    const bg = background({ ProtonAIAssistant: AI });
    const [a, b] = [randomUUID(), randomUUID()];
    const portA = fakePort(PORT + a);
    const portB = fakePort(PORT + b);
    bg.connect(portA);
    bg.connect(portB);
    const runA = bg.send({ token: a });
    const runB = bg.send({ token: b });
    await vi.waitFor(() => expect(net.signals).toHaveLength(2));

    portA.close();
    expect(await runA.answered).toStrictEqual(ABORTED);
    expect(net.signals.filter((s) => s.aborted)).toHaveLength(1);
    portB.close();
    expect(await runB.answered).toStrictEqual(ABORTED);
  });

  it('never writes the token to a log', async () => {
    const logs = captureLogs();
    stubAccounts();
    const bg = background({ ProtonAIAssistant: AI });
    const token = randomUUID();
    const port = fakePort(PORT + token);
    bg.connect(port);
    const { answered } = bg.send({ token });
    await vi.waitFor(() => expect(net.signals).toHaveLength(1));
    port.close();
    await answered;
    await settle();
    logs.restore();
    expect(logs.lines.length).toBeGreaterThan(0);
    expect(logs.lines.join('\n')).not.toContain(token);
  });
});

// ---------------------------------------------------------------------------
// Bookkeeping, with a stub assistant
// ---------------------------------------------------------------------------

/** A ProtonAIAssistant whose runs stay open until settled by hand. */
function stubAssistant() {
  const calls = [];
  return {
    calls,
    runAction: vi.fn((opts) => new Promise((resolve) => calls.push({ opts, resolve }))),
  };
}

describe('the cancels kept for messages still to come', () => {
  it('keeps the newest 32 and drops the oldest first', () => {
    const bg = background({ ProtonAIAssistant: stubAssistant() });
    const tokens = Array.from({ length: 40 }, () => randomUUID());
    for (const token of tokens) {
      const port = fakePort(PORT + token);
      bg.connect(port);
      port.close();
    }
    expect([...bg.runs.keys()]).toEqual(tokens.slice(8));
  });

  it('never drops a running run or a port that is still open', () => {
    const assistant = stubAssistant();
    const bg = background({ ProtonAIAssistant: assistant });
    const running = randomUUID();
    const waiting = randomUUID();
    bg.connect(fakePort(PORT + running));
    bg.send({ token: running });
    bg.connect(fakePort(PORT + waiting));
    for (let i = 0; i < 40; i++) {
      const port = fakePort(PORT + randomUUID());
      bg.connect(port);
      port.close();
    }
    expect(bg.runs.has(running)).toBe(true);
    expect(bg.runs.has(waiting)).toBe(true);
    expect(bg.runs.size).toBe(34);
    expect(assistant.calls[0].opts.signal.aborted).toBe(false);
  });

  it('a dropped cancel no longer stops its message: the price of the bound', () => {
    const assistant = stubAssistant();
    const bg = background({ ProtonAIAssistant: assistant });
    const tokens = Array.from({ length: 33 }, () => randomUUID());
    for (const token of tokens) {
      const port = fakePort(PORT + token);
      bg.connect(port);
      port.close();
    }
    bg.send({ token: tokens[0] });
    bg.send({ token: tokens[1] });
    expect(assistant.calls[0].opts.signal.aborted).toBe(false);
    expect(assistant.calls[1].opts.signal.aborted).toBe(true);
  });

  it('removes a run when it settles, and a close after that is a no-op', async () => {
    const assistant = stubAssistant();
    const bg = background({ ProtonAIAssistant: assistant });
    const token = randomUUID();
    const port = fakePort(PORT + token);
    bg.connect(port);
    const { answered } = bg.send({ token });
    expect(bg.runs.get(token).running).toBe(true);
    assistant.calls[0].resolve({ ok: true, result: 'Done.' });
    expect(await answered).toStrictEqual({ ok: true, result: 'Done.' });
    await settle();
    expect(bg.runs.size).toBe(0);
    port.close();
    expect(bg.runs.size).toBe(0);
    expect(assistant.calls[0].opts.signal.aborted).toBe(false);
  });

  it('removes a run whose assistant call rejects', async () => {
    const bg = background({ ProtonAIAssistant: { runAction: () => Promise.reject(new Error('boom')) } });
    const token = randomUUID();
    bg.connect(fakePort(PORT + token));
    const { answered } = bg.send({ token });
    expect(await answered).toStrictEqual({ ok: false, error: 'GENERATION_FAIL', message: 'boom' });
    await settle();
    expect(bg.runs.size).toBe(0);
  });
});

describe('a message without a token keeps the old contract', () => {
  it.each([
    ['no token', {}],
    ['a token that is not a UUID', { token: 'not-a-token' }],
    ['a token in capitals', { token: randomUUID().toUpperCase() }],
    ['a token that is not a string', { token: 12345678 }],
  ])('%s: no signal and no entry', async (_, extra) => {
    const assistant = stubAssistant();
    const bg = background({ ProtonAIAssistant: assistant });
    const { ret, answered } = bg.send(extra);
    expect(ret).toBe(true);
    expect(assistant.runAction).toHaveBeenCalledTimes(1);
    expect(assistant.calls[0].opts.signal).toBeUndefined();
    expect(assistant.calls[0].opts).toMatchObject({ accountId: 'acct-7', action: 'proofread', text: 'A draft.' });
    expect(bg.runs.size).toBe(0);
    assistant.calls[0].resolve({ ok: true, result: 'Done.' });
    expect(await answered).toStrictEqual({ ok: true, result: 'Done.' });
    await settle();
    expect(bg.runs.size).toBe(0);
  });

  it('still refuses a message without an account or action', async () => {
    const assistant = stubAssistant();
    const bg = background({ ProtonAIAssistant: assistant });
    const { ret, answered } = bg.send({ accountId: '', token: randomUUID() });
    expect(ret).toBe(false);
    expect(await answered).toStrictEqual({ ok: false, error: 'GENERATION_FAIL' });
    expect(assistant.runAction).not.toHaveBeenCalled();
    expect(bg.runs.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Which ports are accepted
// ---------------------------------------------------------------------------

describe('the AI port', () => {
  const REFUSED = [
    ['an empty token', PORT, POPUP],
    ['a short token', PORT + 'abc', POPUP],
    ['a token that is not a UUID', PORT + 'x'.repeat(36), POPUP],
    ['a token with a path in it', PORT + randomUUID() + '/x', POPUP],
    ['another extension', PORT + randomUUID(), { id: 'other@example.net', url: EXT_BASE + 'popup/popup.html' }],
    ['our content script on a Proton page', PORT + randomUUID(), { id: EXT_ID, url: 'https://mail.proton.me/u/0/inbox', tab: { id: 4 } }],
    ['another extension page', PORT + randomUUID(), { id: EXT_ID, url: EXT_BASE + 'options/options.html' }],
    ['a page that only starts like the popup', PORT + randomUUID(), { id: EXT_ID, url: EXT_BASE + 'popup/popup.html.evil' }],
    ['a sender without a URL', PORT + randomUUID(), { id: EXT_ID }],
    ['no sender at all', PORT + randomUUID(), undefined],
  ];

  /** Hand `name` to the onConnect listener, from `sender` (undefined: none at all). */
  function connectFrom(name, sender) {
    const bg = background({ ProtonAIAssistant: stubAssistant() });
    const port = fakePort(name, sender);
    if (sender === undefined) delete port.sender;
    bg.connect(port);
    return { bg, port };
  }

  it.each(REFUSED)('refuses %s: disconnected, no listeners, no entry', (_, name, sender) => {
    const { bg, port } = connectFrom(name, sender);
    expect(port.disconnects).toBe(1);
    expect(port.messageListeners).toHaveLength(0);
    expect(port.disconnectListeners).toHaveLength(0);
    expect(bg.runs.size).toBe(0);
  });

  // A refused token can still be a real one (a popup the URL check got wrong),
  // so the refusal must not log it either. The empty token has nothing to leak.
  it.each(REFUSED.filter(([, name]) => name !== PORT))('logs no token when it refuses %s', (_, name, sender) => {
    const logs = captureLogs();
    try {
      connectFrom(name, sender);
    } finally {
      logs.restore();
    }
    expect(logs.lines.join('\n')).not.toContain(name.slice(PORT.length));
  });

  it.each([
    ['the toolbar popup', POPUP.url],
    ['the standalone popout', EXT_BASE + 'popup/popup.html?standalone=1'],
    ['a popout opened on one message', EXT_BASE + 'popup/popup.html?standalone=1&msg=m1&acct=a1#top'],
  ])('accepts %s, with both listeners attached before connect returns', (_, url) => {
    const bg = background({ ProtonAIAssistant: stubAssistant() });
    const token = randomUUID();
    const port = fakePort(PORT + token, { id: EXT_ID, url });
    bg.connect(port);
    expect(port.disconnects).toBe(0);
    expect(port.messageListeners).toHaveLength(1);
    expect(port.disconnectListeners).toHaveLength(1);
    expect(bg.runs.get(token)).toMatchObject({ running: false });
    // The keep-alive PING is received and ignored.
    port.messageListeners[0]({ type: 'PING' }, port);
    expect(bg.runs.get(token).controller.signal.aborted).toBe(false);
  });

  it('still routes the Drive upload port to ProtonDrive, and nothing else there', () => {
    const ProtonDrive = { handlePort: vi.fn() };
    const bg = background({ ProtonAIAssistant: stubAssistant(), ProtonDrive });
    const drive = fakePort('mcpm-drive-upload');
    bg.connect(drive);
    bg.connect(fakePort(PORT + randomUUID()));
    const other = fakePort('something-else');
    bg.connect(other);
    expect(ProtonDrive.handlePort).toHaveBeenCalledTimes(1);
    expect(ProtonDrive.handlePort).toHaveBeenCalledWith(drive);
    expect(other.disconnects).toBe(0);
    expect(bg.runs.size).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Structure
// ---------------------------------------------------------------------------

describe('the port listeners are attached synchronously', () => {
  // Port messages and disconnects are not queued for a listener added later,
  // so nothing may wait (for init, or anything else) before the listeners.
  it('registers runtime.onConnect once, at the top level of background.js', () => {
    expect(BG.match(/runtime\.onConnect\.addListener/g)).toHaveLength(1);
    expect(BG).toMatch(/^ {2}browser\.runtime\.onConnect\.addListener\(\(port\) => \{$/m);
  });

  it('routes the AI port first, with nothing awaited on the way', () => {
    const listener = code(liftOnConnect());
    expect(listener).not.toMatch(/\bawait\b|\basync\b|\.then\(|setTimeout|ensureInitialized/);
    expect(listener.indexOf('_handleAiRunPort(port)')).toBeGreaterThan(-1);
    expect(listener.indexOf('_handleAiRunPort(port)')).toBeLessThan(listener.indexOf("'mcpm-drive-upload'"));
  });

  it('attaches both port listeners with nothing awaited before them', () => {
    const handler = code(liftFn(BG, '_handleAiRunPort'));
    expect(handler).not.toMatch(/^async /);
    const before = handler.slice(0, handler.lastIndexOf('.addListener('));
    expect(before).not.toMatch(/\bawait\b|\.then\(|setTimeout|ensureInitialized|isPremium/);
    expect(handler).toContain('port.onMessage.addListener(');
    expect(handler).toContain('port.onDisconnect.addListener(');
  });
});

describe('only the background listens for runtime.onConnect', () => {
  // Firefox closes a port as soon as ANY receiving context unloads. An
  // extension page with its own onConnect listener would receive the popup's
  // AI port too, and closing that page would abort the user's request.
  const DIRS = ['popup', 'options', 'captcha', 'preview', 'offscreen', 'fido2', 'lib'];
  const files = DIRS.flatMap((dir) => readdirSync(join(ROOT, dir))
    .filter((f) => f.endsWith('.js') && !f.endsWith('.min.js'))
    .map((f) => dir + '/' + f));

  it('finds the page scripts it checks', () => {
    expect(files).toContain('popup/popup.js');
    expect(files).toContain('popup/ai-assistant.js');
    expect(files).toContain('options/options.js');
  });

  it.each(files)('%s registers no runtime.onConnect listener', (file) => {
    expect(read(file)).not.toMatch(/runtime\.onConnect\b/);
  });
});
