/**
 * Tests for ProtonDiag: the persistent auth/session diagnostic ring buffer.
 *
 * It's a dependency-light browser IIFE (storage.local + debugLog); eval it with
 * an in-memory storage stub and grab the global.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

function load() {
  const store = {};
  globalThis.browser = {
    storage: {
      local: {
        get: async (k) => (k in store ? { [k]: store[k] } : {}),
        set: async (obj) => { Object.assign(store, obj); },
      },
    },
  };
  globalThis.debugLog = () => {};
  const code = readFileSync(join(__dirname, '..', 'background', 'diag.js'), 'utf-8');
  const Diag = new Function(code + '\nreturn ProtonDiag;')();
  return { Diag, store };
}

describe('ProtonDiag.fp', () => {
  it('fingerprints a token as last-6 + length without exposing it', () => {
    const { Diag } = load();
    expect(Diag.fp('abcdef0123456789')).toBe('456789/16');
    expect(Diag.fp(null)).toBe('none');
    expect(Diag.fp('')).toBe('none');
  });

  it('changes when the token rotates (so a lost-write is visible)', () => {
    const { Diag } = load();
    expect(Diag.fp('tokenAAAAAA')).not.toBe(Diag.fp('tokenBBBBBB'));
  });
});

describe('ProtonDiag.record / getAll / clear', () => {
  it('persists structured events with a timestamp and the given fields', async () => {
    const { Diag, store } = load();
    await Diag.record('refresh.ok', { email: 'a@b.c', rotated: true });
    const log = await Diag.getAll();
    expect(log).toHaveLength(1);
    expect(log[0].event).toBe('refresh.ok');
    expect(log[0].email).toBe('a@b.c');
    expect(log[0].rotated).toBe(true);
    expect(typeof log[0].t).toBe('string');
    // It actually lives in storage.local (survives SW death / restart).
    expect(store._authDiag).toHaveLength(1);
  });

  it('preserves order across serialized concurrent writes', async () => {
    const { Diag } = load();
    await Promise.all([
      Diag.record('a'), Diag.record('b'), Diag.record('c'),
    ]);
    const log = await Diag.getAll();
    expect(log.map((e) => e.event)).toEqual(['a', 'b', 'c']);
  });

  it('caps the ring buffer, dropping the oldest entries', async () => {
    const { Diag } = load();
    for (let i = 0; i < 5005; i++) await Diag.record('e', { i });
    const log = await Diag.getAll();
    expect(log).toHaveLength(5000);
    // oldest 5 dropped → first surviving entry is i=5
    expect(log[0].i).toBe(5);
    expect(log[log.length - 1].i).toBe(5004);
  });

  it('clear() empties the log', async () => {
    const { Diag } = load();
    await Diag.record('x');
    await Diag.clear();
    expect(await Diag.getAll()).toEqual([]);
  });
});

describe('ProtonDiag.capture (debug-mode console mirroring)', () => {
  it('appends a console line as a log.<level> entry, msg kept last', async () => {
    const { Diag, store } = load();
    await Diag.capture('warn', 'something failed: x y', 'popup');
    const log = await Diag.getAll();
    expect(log).toHaveLength(1);
    expect(log[0].event).toBe('log.warn');
    expect(log[0].ctx).toBe('popup');
    expect(log[0].msg).toBe('something failed: x y');
    // msg must be the LAST key so spaces in it don't break the key=value export.
    const keys = Object.keys(log[0]);
    expect(keys[keys.length - 1]).toBe('msg');
    expect(store._authDiag).toHaveLength(1);
  });

  it('omits ctx for background-origin captures', async () => {
    const { Diag } = load();
    await Diag.capture('debug', 'hello');
    const log = await Diag.getAll();
    expect(log[0].event).toBe('log.debug');
    expect('ctx' in log[0]).toBe(false);
    expect(log[0].msg).toBe('hello');
  });

  it('shares the ring buffer + cap with record()', async () => {
    const { Diag } = load();
    await Diag.record('refresh.ok', { email: 'a@b.c' });
    await Diag.capture('error', 'boom');
    const log = await Diag.getAll();
    expect(log.map((e) => e.event)).toEqual(['refresh.ok', 'log.error']);
  });
});
