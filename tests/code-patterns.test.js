/**
 * Tests for ProtonCodePatterns (lib/code-patterns.js).
 *
 * Pure verification-code pattern logic (no DOM/browser deps), now exposed via
 * the standard IIFE pattern, so it loads with the same eval harness as the
 * other module tests.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

let CP;

beforeAll(() => {
  const code = readFileSync(join(__dirname, '..', 'lib', 'code-patterns.js'), 'utf-8');
  CP = new Function(code + '\nreturn ProtonCodePatterns;')();
});

describe('getShippedDefaults', () => {
  it('returns 7 defaults as independent copies', () => {
    const a = CP.getShippedDefaults();
    expect(a).toHaveLength(7);
    a[0].regex = 'mutated';
    expect(CP.getShippedDefaults()[0].regex).not.toBe('mutated'); // not shared
  });
});

describe('isDefaultId', () => {
  it('recognises default- ids and rejects others', () => {
    expect(CP.isDefaultId('default-otp')).toBe(true);
    expect(CP.isDefaultId('custom-123')).toBe(false);
    expect(CP.isDefaultId(null)).toBe(false);
    expect(CP.isDefaultId(42)).toBe(false);
  });
});

describe('mergeWithDefaults', () => {
  it('returns all 7 defaults unmodified for empty/null input', () => {
    for (const input of [null, undefined, []]) {
      const merged = CP.mergeWithDefaults(input);
      expect(merged).toHaveLength(7);
      expect(merged.every((p) => p.kind === 'default')).toBe(true);
      expect(merged.every((p) => p.isModified === false)).toBe(true);
    }
  });

  it('applies a regex override and flags it modified', () => {
    const merged = CP.mergeWithDefaults([{ id: 'default-otp', regex: '(\\d{8})' }]);
    const otp = merged.find((p) => p.id === 'default-otp');
    expect(otp.regex).toBe('(\\d{8})');
    expect(otp.isModified).toBe(true);
    expect(otp.kind).toBe('default');
  });

  it('keeps isModified false when an override matches the shipped value', () => {
    const def = CP.getShippedDefaults().find((p) => p.id === 'default-otp');
    const merged = CP.mergeWithDefaults([{ id: 'default-otp', regex: def.regex, flags: def.flags }]);
    expect(merged.find((p) => p.id === 'default-otp').isModified).toBe(false);
  });

  it('honours enabled:false overrides', () => {
    const merged = CP.mergeWithDefaults([{ id: 'default-otp', enabled: false }]);
    expect(merged.find((p) => p.id === 'default-otp').enabled).toBe(false);
  });

  it('appends custom patterns after the defaults', () => {
    const merged = CP.mergeWithDefaults([{ id: 'custom-1', name: 'Mine', regex: '(\\d{4})' }]);
    expect(merged).toHaveLength(8);
    const custom = merged[merged.length - 1];
    expect(custom.kind).toBe('custom');
    expect(custom.id).toBe('custom-1');
    expect(custom.name).toBe('Mine');
  });
});

describe('detectCode', () => {
  const merged = () => CP.mergeWithDefaults(null);

  it('extracts the captured code from matching text', () => {
    expect(CP.detectCode('Your verification code is 123456', merged())).toBe('123456');
    expect(CP.detectCode('Use OTP 9087 to continue', merged())).toBe('9087');
  });

  it('returns null when nothing matches', () => {
    expect(CP.detectCode('No numbers here at all', merged())).toBeNull();
  });

  it('returns null for empty/invalid inputs', () => {
    expect(CP.detectCode('', merged())).toBeNull();
    expect(CP.detectCode(null, merged())).toBeNull();
    expect(CP.detectCode('verification 123456', null)).toBeNull();
  });

  it('skips disabled patterns', () => {
    const patterns = [{ enabled: false, regex: '(\\d{6})', flags: '' }];
    expect(CP.detectCode('code 123456', patterns)).toBeNull();
  });

  it('skips invalid regexes without throwing', () => {
    const patterns = [
      { enabled: true, regex: '(unclosed', flags: '' }, // invalid
      { enabled: true, regex: 'code (\\d{4})', flags: 'i' },
    ];
    expect(CP.detectCode('code 4242', patterns)).toBe('4242');
  });
});

describe('validateRegex', () => {
  it('accepts a valid regex with a capturing group', () => {
    expect(CP.validateRegex('code (\\d{6})', 'i')).toBeNull();
  });

  it('rejects an empty pattern', () => {
    expect(CP.validateRegex('', '')).toBe('Regex is empty');
    expect(CP.validateRegex('   ', '')).toBe('Regex is empty');
  });

  it('rejects a syntactically invalid regex', () => {
    expect(CP.validateRegex('(unclosed', '')).toBeTruthy();
  });

  it('rejects a regex with no capturing group', () => {
    expect(CP.validateRegex('\\d{6}', '')).toMatch(/capturing group/);
  });
});
