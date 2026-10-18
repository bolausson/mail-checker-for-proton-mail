/**
 * Tests for ProtonBinary (lib/binary-utils.js).
 *
 * These lock in the behaviour the scattered base64/hex copies had BEFORE they
 * were consolidated, so the consolidation (replacing the old inline copies
 * with ProtonBinary) is provably behaviour-preserving:
 *   - round-trip correctness incl. all 256 byte values and large (chunked)
 *     payloads,
 *   - the string-passthrough idempotency guard (from accounts.js),
 *   - decode equivalence to the old `Uint8Array.from(atob(x), c => …)` form,
 *   - hex output matching the old _generateId / _attendeeToken conversion.
 *
 * Loaded with the same eval-the-IIFE harness as ics-parsing.test.js.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

let ProtonBinary;

beforeAll(() => {
  // btoa/atob/Uint8Array exist as Node globals; the module resolves them via
  // the global scope chain when eval'd through new Function().
  const code = readFileSync(join(__dirname, '..', 'lib', 'binary-utils.js'), 'utf-8');
  ProtonBinary = new Function(code + '\nreturn ProtonBinary;')();
});

// Reference implementation matching the old inline decode form, used to prove
// the fast loop produces identical bytes.
function refFromMapper(b64) {
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

describe('uint8ToBase64 / base64ToUint8 round-trip', () => {
  it('encodes a known vector', () => {
    expect(ProtonBinary.uint8ToBase64(new Uint8Array([72, 105]))).toBe('SGk='); // "Hi"
  });

  it('decodes a known vector', () => {
    expect(Array.from(ProtonBinary.base64ToUint8('SGk='))).toEqual([72, 105]);
  });

  it('round-trips all 256 byte values', () => {
    const bytes = new Uint8Array(256);
    for (let i = 0; i < 256; i++) bytes[i] = i;
    const back = ProtonBinary.base64ToUint8(ProtonBinary.uint8ToBase64(bytes));
    expect(Array.from(back)).toEqual(Array.from(bytes));
  });

  it('round-trips an empty array', () => {
    expect(ProtonBinary.uint8ToBase64(new Uint8Array([]))).toBe('');
    expect(ProtonBinary.base64ToUint8('').length).toBe(0);
  });

  it('round-trips a large (>32 KiB chunk boundary) payload without RangeError', () => {
    const n = 100000; // spans multiple 32 KiB chunks
    const bytes = new Uint8Array(n);
    for (let i = 0; i < n; i++) bytes[i] = (i * 31 + 7) & 0xff;
    const back = ProtonBinary.base64ToUint8(ProtonBinary.uint8ToBase64(bytes));
    expect(back.length).toBe(n);
    expect(Array.from(back)).toEqual(Array.from(bytes));
  });
});

describe('uint8ToBase64 input handling', () => {
  it('passes an already-encoded string through unchanged (idempotency guard)', () => {
    expect(ProtonBinary.uint8ToBase64('SGVsbG8=')).toBe('SGVsbG8=');
  });

  it('accepts an ArrayBuffer', () => {
    const buf = new Uint8Array([1, 2, 3]).buffer;
    expect(ProtonBinary.uint8ToBase64(buf)).toBe(ProtonBinary.uint8ToBase64(new Uint8Array([1, 2, 3])));
  });

  it('accepts a plain array of byte values', () => {
    expect(ProtonBinary.uint8ToBase64([72, 105])).toBe('SGk=');
  });
});

describe('base64ToUint8 equivalence to the old from-mapper form', () => {
  it('produces identical bytes to Uint8Array.from(atob(x), c => c.charCodeAt(0))', () => {
    const samples = ['', 'SGk=', 'SGVsbG8sIHdvcmxkIQ==', btoa('\x00\x01\xff\xfe\x7f\x80')];
    for (const s of samples) {
      expect(Array.from(ProtonBinary.base64ToUint8(s))).toEqual(Array.from(refFromMapper(s)));
    }
  });
});

describe('bytesToHex', () => {
  it('zero-pads each byte to two lowercase hex digits', () => {
    expect(ProtonBinary.bytesToHex(new Uint8Array([0, 15, 255]))).toBe('000fff');
    expect(ProtonBinary.bytesToHex(new Uint8Array([171, 205]))).toBe('abcd');
  });

  it('produces a 24-char string for a 12-byte id and 40-char for a 20-byte token', () => {
    expect(ProtonBinary.bytesToHex(new Uint8Array(12)).length).toBe(24);
    expect(ProtonBinary.bytesToHex(new Uint8Array(20)).length).toBe(40);
  });

  it('accepts a plain array', () => {
    expect(ProtonBinary.bytesToHex([1, 2, 3])).toBe('010203');
  });
});
