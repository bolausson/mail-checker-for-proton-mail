/**
 * Tests for the pure helpers in background/drive.js (ProtonDrive).
 *
 * These lock in the wire-format-critical arithmetic of the "Share via Proton
 * Drive" feature against the semantics of Proton's WebClients source:
 *   - the block verifier token (worker/verifier.ts: VerificationCode XOR
 *     ciphertext prefix, 0-padded to the code's length),
 *   - the generated+custom password concatenation and its SharedURLFlags
 *     (interfaces/drive/sharing.ts: 2 = generated, 3 = generated|custom),
 *   - ExpirationTime (absolute unix seconds in whole days rounded up, so a
 *     custom date expires on that date, not at its start; null = never; kept
 *     under the server's 90-day cap),
 *   - the 50-character custom password limit (MAX_SHARED_URL_PASSWORD_LENGTH),
 *   - which my-files error means "no volume yet" (SDK apiErrorFactory),
 *   - filename dedupe splitting ("a.tar.gz" → "a.tar (1).gz", link.ts adjustName),
 *   - XAttr Common.BlockSizes (4 MiB chunks + trailing remainder),
 *   - the HMAC-SHA256 lookup hash (driveKeys.ts generateLookupHash, hex).
 *
 * Loaded with the same eval-the-IIFE harness as binary-utils.test.js. The
 * request sequences (routes, payloads, real openpgp crypto) are covered by
 * drive-routes.test.js.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { createHmac } from 'crypto';
import { readFileSync } from 'fs';
import { join } from 'path';

let ProtonDrive;

const CHUNK = 4 * 1024 * 1024;

beforeAll(() => {
  const binCode = readFileSync(join(__dirname, '..', 'lib', 'binary-utils.js'), 'utf-8');
  const ProtonBinary = new Function(binCode + '\nreturn ProtonBinary;')();
  const code = readFileSync(join(__dirname, '..', 'background', 'drive.js'), 'utf-8');
  // The module only touches its other globals (openpgp, ProtonAccounts, …)
  // inside functions, so evaluating the IIFE with ProtonBinary alone is enough
  // for the pure helpers.
  ProtonDrive = new Function('ProtonBinary', code + '\nreturn ProtonDrive;')(ProtonBinary);
});

describe('_verifierToken (VerificationCode XOR ciphertext prefix)', () => {
  it('XORs byte-wise over the code length', () => {
    const code = new Uint8Array([0x0f, 0xf0, 0xaa, 0x00]);
    const data = new Uint8Array([0xff, 0x0f, 0xaa, 0x12, 0x34, 0x56]);
    expect(Array.from(ProtonDrive._verifierToken(code, data)))
      .toEqual([0xf0, 0xff, 0x00, 0x12]);
  });

  it('0-pads when the ciphertext is shorter than the code', () => {
    const code = new Uint8Array([0x11, 0x22, 0x33]);
    const data = new Uint8Array([0xff]);
    expect(Array.from(ProtonDrive._verifierToken(code, data)))
      .toEqual([0xee, 0x22, 0x33]);
  });

  it('token length always equals the code length', () => {
    const code = new Uint8Array(16);
    expect(ProtonDrive._verifierToken(code, new Uint8Array(1000)).length).toBe(16);
    expect(ProtonDrive._verifierToken(code, new Uint8Array(0)).length).toBe(16);
  });
});

describe('_fullPasswordAndFlags (SharedURLFlags)', () => {
  it('generated only → flags 2, password unchanged', () => {
    expect(ProtonDrive._fullPasswordAndFlags('abcdefghijkl', ''))
      .toEqual({ password: 'abcdefghijkl', flags: 2 });
  });

  it('custom appended → flags 3, generated+custom concatenated', () => {
    expect(ProtonDrive._fullPasswordAndFlags('abcdefghijkl', 'hunter2'))
      .toEqual({ password: 'abcdefghijklhunter2', flags: 3 });
  });
});

describe('_expirationTime (ExpirationTime, absolute unix seconds)', () => {
  const DAY = 24 * 3600;
  const NOW_MS = 1790000000123; // fixed clock; milliseconds are floored away
  const NOW_S = 1790000000;

  it('30 days → now + 2592000 s', () => {
    expect(ProtonDrive._expirationTime(30, NOW_MS)).toBe(NOW_S + 30 * DAY);
  });

  it('0 / null / undefined / NaN / negative → null (never expires)', () => {
    expect(ProtonDrive._expirationTime(0, NOW_MS)).toBeNull();
    expect(ProtonDrive._expirationTime(null, NOW_MS)).toBeNull();
    expect(ProtonDrive._expirationTime(undefined, NOW_MS)).toBeNull();
    expect(ProtonDrive._expirationTime('x', NOW_MS)).toBeNull();
    expect(ProtonDrive._expirationTime(-3, NOW_MS)).toBeNull();
  });

  it('stays one hour under the server\'s now + 90 days, whatever is asked', () => {
    const cap = NOW_S + 90 * DAY - 3600;
    expect(ProtonDrive._expirationTime(90, NOW_MS)).toBe(cap);
    expect(ProtonDrive._expirationTime(91, NOW_MS)).toBe(cap);
    expect(ProtonDrive._expirationTime(10000, NOW_MS)).toBe(cap);
  });

  it('just under the cap is kept exactly', () => {
    expect(ProtonDrive._expirationTime(89, NOW_MS)).toBe(NOW_S + 89 * DAY);
  });

  it('fractional days (custom date) round up to whole days', () => {
    expect(ProtonDrive._expirationTime(0.5, NOW_MS)).toBe(NOW_S + DAY);
    expect(ProtonDrive._expirationTime(29.1, NOW_MS)).toBe(NOW_S + 30 * DAY);
    // Today + 90 picked in the morning: 90 whole days, then the one-hour cap.
    expect(ProtonDrive._expirationTime(89.4, NOW_MS)).toBe(NOW_S + 90 * DAY - 3600);
  });

  it('a custom date picked late in the evening expires on that date, not at its start', () => {
    // What the popup sends for "tomorrow" picked at 22:30: the days to local
    // midnight at the START of the picked day (its date picker has no time).
    const now = new Date(2026, 9, 3, 22, 30).getTime();
    const picked = new Date(2026, 9, 4).getTime();
    const days = (Math.floor(picked / 1000) - Math.floor(now / 1000)) / DAY;
    const expires = ProtonDrive._expirationTime(days, now);
    expect(expires * 1000).toBeGreaterThan(picked);
    expect(expires).toBe(Math.floor(now / 1000) + DAY); // tomorrow at 22:30
  });
});

describe('_customLinkPassword (MAX_SHARED_URL_PASSWORD_LENGTH = 50)', () => {
  it('blank or whitespace-only means no custom password', () => {
    expect(ProtonDrive._customLinkPassword('')).toBe('');
    expect(ProtonDrive._customLinkPassword(undefined)).toBe('');
    expect(ProtonDrive._customLinkPassword(null)).toBe('');
    expect(ProtonDrive._customLinkPassword('   ')).toBe('');
    // Whitespace-only is "none", so its length is not held against it.
    expect(ProtonDrive._customLinkPassword(' '.repeat(60))).toBe('');
  });

  it('keeps a password exactly as typed, surrounding spaces included', () => {
    expect(ProtonDrive._customLinkPassword(' hunter2 ')).toBe(' hunter2 ');
  });

  it('accepts exactly 50 characters', () => {
    const fifty = 'a'.repeat(50);
    expect(ProtonDrive._customLinkPassword(fifty)).toBe(fifty);
  });

  it('refuses 51 characters with the code the popup localizes', () => {
    let err = null;
    try { ProtonDrive._customLinkPassword('a'.repeat(51)); } catch (e) { err = e; }
    expect(err).not.toBeNull();
    expect(err.message).toBe('DRIVE_PASSWORD_TOO_LONG');
    expect(err.code).toBe('DRIVE_PASSWORD_TOO_LONG');
  });
});

describe('_isNoActiveVolume (when my-files means "create the volume")', () => {
  it('Code 2501 on a 422 is "no active volume yet"', () => {
    expect(ProtonDrive._isNoActiveVolume({ status: 422, code: 2501 })).toBe(true);
  });

  it('an HTTP 404 is a missing route, never "no volume", whatever the body says', () => {
    expect(ProtonDrive._isNoActiveVolume({ status: 404, code: 2501 })).toBe(false);
  });

  it('other codes and empty errors are not "no volume"', () => {
    expect(ProtonDrive._isNoActiveVolume({ status: 422, code: 2500 })).toBe(false);
    expect(ProtonDrive._isNoActiveVolume({ status: 500 })).toBe(false);
    expect(ProtonDrive._isNoActiveVolume(null)).toBe(false);
  });
});

describe('_splitName / _adjustName (filename dedupe)', () => {
  it('splits at the last dot', () => {
    expect(ProtonDrive._splitName('report.pdf')).toEqual({ base: 'report', ext: '.pdf' });
    expect(ProtonDrive._splitName('archive.tar.gz')).toEqual({ base: 'archive.tar', ext: '.gz' });
  });

  it('no extension / leading dot keep the whole name as base', () => {
    expect(ProtonDrive._splitName('README')).toEqual({ base: 'README', ext: '' });
    expect(ProtonDrive._splitName('.env')).toEqual({ base: '.env', ext: '' });
  });

  it('adjustName: 0 keeps the name, n appends " (n)" before the extension', () => {
    expect(ProtonDrive._adjustName(0, 'a', '.txt')).toBe('a.txt');
    expect(ProtonDrive._adjustName(1, 'a', '.txt')).toBe('a (1).txt');
    expect(ProtonDrive._adjustName(2, 'archive.tar', '.gz')).toBe('archive.tar (2).gz');
  });
});

describe('_blockSizes (XAttr Common.BlockSizes)', () => {
  it('empty file → no blocks', () => {
    expect(ProtonDrive._blockSizes(0)).toEqual([]);
  });

  it('below one chunk → single block of file size', () => {
    expect(ProtonDrive._blockSizes(1)).toEqual([1]);
    expect(ProtonDrive._blockSizes(CHUNK - 1)).toEqual([CHUNK - 1]);
  });

  it('exact multiple → equal chunks, no trailing zero block', () => {
    expect(ProtonDrive._blockSizes(2 * CHUNK)).toEqual([CHUNK, CHUNK]);
  });

  it('multiple + remainder → trailing partial block', () => {
    expect(ProtonDrive._blockSizes(2 * CHUNK + 5)).toEqual([CHUNK, CHUNK, 5]);
  });
});

describe('_splitFolderPath (settings folder path)', () => {
  it('splits on / and trims empties', () => {
    expect(ProtonDrive._splitFolderPath('a/b/c')).toEqual(['a', 'b', 'c']);
    expect(ProtonDrive._splitFolderPath(' /shared// files / ')).toEqual(['shared', 'files']);
    expect(ProtonDrive._splitFolderPath('')).toEqual([]);
    expect(ProtonDrive._splitFolderPath(null)).toEqual([]);
  });
});

describe('_lookupHash (HMAC-SHA256 lookup hash, hex)', () => {
  it('matches an independent HMAC-SHA256 implementation', async () => {
    const key = new Uint8Array(32).map((_, i) => i);
    const name = 'mcpm-shared-files';
    const expected = createHmac('sha256', key).update(Buffer.from(name, 'utf8')).digest('hex');
    expect(await ProtonDrive._lookupHash(name, key)).toBe(expected);
  });

  it('is case-sensitive over the raw name (no lowercasing, mirrors driveKeys.ts)', async () => {
    const key = new Uint8Array(32).fill(7);
    const a = await ProtonDrive._lookupHash('File.TXT', key);
    const b = await ProtonDrive._lookupHash('file.txt', key);
    expect(a).not.toBe(b);
  });
});
