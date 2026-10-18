/**
 * i18n parity.
 *
 * 18 keys once existed only in the English block, so 27 languages silently fell
 * back to English for them, including every string on the two-password mailbox
 * unlock screen. Nothing failed, nothing warned, and the gap sat there
 * accumulating. These tests are the thing that was missing: a key added to `en`
 * and nowhere else is now a build failure, not a discovery months later.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

let strings;
let locales;
let enKeys;

beforeAll(() => {
  // _strings is module-private; expose it through the module's own return.
  const code = readFileSync(join(__dirname, '..', 'lib', 'i18n.js'), 'utf-8')
    .replace('return { setLanguage', 'return { _strings, setLanguage');
  const win = {};
  const I = new Function('window', 'self', code + '; return window.ProtonI18n || self.ProtonI18n || ProtonI18n;')(win, win);
  strings = I._strings;
  locales = Object.keys(strings).filter((l) => l !== 'en');
  enKeys = Object.keys(strings.en);
});

/** Placeholders the runtime substitutes: $1/$2 and {name} style. */
function placeholders(value) {
  const dollar = (String(value).match(/\$\d/g) || []);
  const braced = (String(value).match(/\{[a-zA-Z_][a-zA-Z0-9_]*\}/g) || []);
  return [...new Set([...dollar, ...braced])].sort();
}

describe('every locale carries every English key', () => {
  it('has 28 locales including English', () => {
    expect(locales.length + 1).toBe(28);
  });

  it('no locale is missing a key that English defines', () => {
    const missing = {};
    for (const loc of locales) {
      const gaps = enKeys.filter((k) => typeof strings[loc][k] !== 'string' || !strings[loc][k].trim());
      if (gaps.length) missing[loc] = gaps;
    }
    // Named so a failure prints exactly which locale lacks which key.
    expect(missing).toEqual({});
  });

  it('no locale defines a key English does not', () => {
    const en = new Set(enKeys);
    const extra = {};
    for (const loc of locales) {
      const surplus = Object.keys(strings[loc]).filter((k) => !en.has(k));
      if (surplus.length) extra[loc] = surplus;
    }
    expect(extra).toEqual({});
  });
});

describe('placeholders survive translation', () => {
  it('every translated string keeps the placeholders its English source has', () => {
    const broken = [];
    for (const loc of locales) {
      for (const key of enKeys) {
        const want = placeholders(strings.en[key]);
        if (!want.length) continue;
        const got = placeholders(strings[loc][key]);
        if (JSON.stringify(want) !== JSON.stringify(got)) {
          broken.push(loc + '/' + key + ': expected ' + want.join(',') + ' got ' + (got.join(',') || 'none'));
        }
      }
    }
    expect(broken).toEqual([]);
  });

  it('licenseKeyHint keeps the sub_ and txn_ prefixes users copy from an invoice', () => {
    for (const loc of [...locales, 'en']) {
      expect(strings[loc].licenseKeyHint).toContain('sub_');
      expect(strings[loc].licenseKeyHint).toContain('txn_');
    }
  });
});

describe('license strings', () => {
  // The lock notice once said "more than 7 days" while the grace period was 30.
  // It names the grace period instead of counting it, so it cannot drift from
  // premium.js again (30 days, or 3 for a key Paddle never answered for) and
  // needs no number-noun agreement per language.
  it('validationLocked states no number in any locale', () => {
    const offenders = [];
    for (const loc of Object.keys(strings)) {
      if (/\d/.test(strings[loc].validationLocked)) offenders.push(loc + ': ' + strings[loc].validationLocked);
    }
    expect(offenders).toEqual([]);
  });

  // The options and popup tests stub t() to answer the key itself, and the
  // parity checks above only compare locales with English. A key missing from
  // English AND every locale passed all of that, while users saw the raw key.
  const LICENSE_KEYS = [
    'statusPaymentFailed', 'statusFirstPaymentFailed', 'statusPaused',
    'noticePastDue', 'noticeUnpaid', 'noticePaused', 'noticeEndsOn',
    'popupLicensePastDue', 'popupLicenseUnpaid', 'popupLicensePaused',
    'err_validation_problem', 'validationLocked', 'validationGrace',
  ];

  it('every license string the UI names exists in English', () => {
    const keys = [...LICENSE_KEYS, 'licenseKey', 'activeLicense'];
    expect(keys.filter((k) => typeof strings.en[k] !== 'string')).toEqual([]);
  });

  it('a quote opened with a low quote (U+201E) never closes with a straight one', () => {
    // Polish validationLocked once rendered as „Waliduj teraz" : the pair is
    // „...” or „...“. Scoped to the license strings: older strings elsewhere
    // still mix the two.
    const LOW = String.fromCharCode(0x201E);
    const CLOSERS = ['"', String.fromCharCode(0x201D), String.fromCharCode(0x201C)];
    const offenders = [];
    for (const loc of Object.keys(strings)) {
      for (const key of LICENSE_KEYS) {
        const value = strings[loc][key];
        let at = value.indexOf(LOW);
        while (at !== -1) {
          const ends = CLOSERS.map((c) => value.indexOf(c, at + 1)).filter((i) => i !== -1);
          if (!ends.length || value[Math.min(...ends)] === '"') offenders.push(loc + '/' + key);
          at = value.indexOf(LOW, at + 1);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('every key of the popup license banner exists in English', () => {
    const popup = readFileSync(join(__dirname, '..', 'popup', 'popup.js'), 'utf-8');
    const body = /LICENSE_BANNER_TEXT = \{([\s\S]*?)\}/.exec(popup);
    expect(body, 'LICENSE_BANNER_TEXT not found in popup.js').not.toBeNull();
    const keys = [...body[1].matchAll(/'([A-Za-z0-9_]+)'/g)].map((m) => m[1]);
    expect(keys.length).toBeGreaterThan(0);
    expect(keys.filter((k) => typeof strings.en[k] !== 'string')).toEqual([]);
  });

  it('every literal key the options page and the popup translate exists in English', () => {
    // A computed key ('source_' + name) is skipped: only a literal key that
    // is closed right away counts. A plural key is there when its _one form is.
    const missing = [];
    for (const file of [['options', 'options.js'], ['popup', 'popup.js']]) {
      const src = readFileSync(join(__dirname, '..', ...file), 'utf-8');
      for (const m of src.matchAll(/\b(t|plural)\(\s*'([A-Za-z0-9_]+)'\s*[,)]/g)) {
        const key = m[1] === 'plural' ? m[2] + '_one' : m[2];
        if (typeof strings.en[key] !== 'string') missing.push(file[1] + ': ' + m[2]);
      }
    }
    expect([...new Set(missing)]).toEqual([]);
  });

  // subscription_unpaid is also the answer for a paying customer whose renewal
  // has been past_due for over 35 days: "the first payment failed" is false there.
  it('the unpaid strings never claim it was the first payment', () => {
    const FIRST = {
      en: 'first', de: 'erste', fr: 'premier', es: 'primer', it: 'primo', pt: 'primeiro', nl: 'eerste',
      pl: 'pierwsz', ru: 'перв', tr: 'ilk ', sv: 'första', da: 'første', nb: 'første', fi: 'ensimmäi',
      uk: 'перш', cs: 'první', ro: 'prima ', hu: 'első', el: 'πρώτη', hr: 'prvo ', sk: 'prvá ',
      bg: 'първ', lt: 'pirmasis', lv: 'pirmais', et: 'esimene', sl: 'prvo ', sr: 'prvo ', ca: 'primer',
    };
    expect(Object.keys(FIRST).sort()).toEqual(Object.keys(strings).sort());
    const offenders = [];
    for (const loc of Object.keys(strings)) {
      for (const key of ['statusFirstPaymentFailed', 'noticeUnpaid', 'popupLicenseUnpaid']) {
        if (strings[loc][key].toLocaleLowerCase(loc).includes(FIRST[loc])) offenders.push(loc + '/' + key);
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe('house rules hold across every locale', () => {
  it('contains no em dash or en dash in any resolved string', () => {
    const EM = String.fromCharCode(0x2014);
    const EN = String.fromCharCode(0x2013);
    const offenders = [];
    for (const loc of Object.keys(strings)) {
      for (const [key, value] of Object.entries(strings[loc])) {
        if (typeof value !== 'string') continue;
        if (value.includes(EM) || value.includes(EN)) offenders.push(loc + '/' + key);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('has no unresolved backslash-u escape left in a value', () => {
    const offenders = [];
    for (const loc of Object.keys(strings)) {
      for (const [key, value] of Object.entries(strings[loc])) {
        if (typeof value === 'string' && value.includes(String.fromCharCode(92) + 'u')) {
          offenders.push(loc + '/' + key);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
