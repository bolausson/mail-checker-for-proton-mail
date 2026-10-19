/**
 * Naming the browser in the diagnostic export.
 *
 * "Chrome" is not a useful answer. Opera, Edge, Brave and Vivaldi are all
 * Chromium, all report `Chrome/<version>` in their user agent, and they do not
 * behave alike: Opera kills the MV3 service worker every 2 to 4 minutes, which
 * made a refresh-token race constant there while it was mild elsewhere. That
 * took a long investigation, and the browser identity would have shortened it.
 *
 * So these tests are mostly about the forks, not about Chrome.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const SRC = readFileSync(join(__dirname, '..', 'lib', 'browser-info.js'), 'utf-8');
const ProtonBrowserInfo = new Function(SRC + '; return ProtonBrowserInfo;')();
const { describe: summarise, fromBrands, fromUserAgent } = ProtonBrowserInfo;

// Real user-agent strings. Note every Chromium one contains "Chrome/".
const UA = {
  firefox: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:142.0) Gecko/20100101 Firefox/142.0',
  chrome: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36',
  opera: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36 OPR/121.0.5600.20',
  edge: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36 Edg/136.0.3240.50',
  vivaldi: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36 Vivaldi/7.3.3635.11',
  brave: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36',
};

describe('telling the Chromium forks apart from the user agent', () => {
  it('names Opera, not Chrome', () => {
    // The whole point. Opera's UA says Chrome/136 and OPR/121; reporting
    // "Chrome" would hide the browser whose worker lifecycle broke us.
    expect(fromUserAgent(UA.opera)).toEqual({ name: 'Opera', version: '121.0.5600.20' });
  });

  it('names Edge and Vivaldi, not Chrome', () => {
    expect(fromUserAgent(UA.edge).name).toBe('Microsoft Edge');
    expect(fromUserAgent(UA.vivaldi).name).toBe('Vivaldi');
  });

  it('still recognises plain Chrome and Firefox', () => {
    expect(fromUserAgent(UA.chrome)).toEqual({ name: 'Chrome', version: '136.0.0.0' });
    expect(fromUserAgent(UA.firefox)).toEqual({ name: 'Firefox', version: '142.0' });
  });

  it('checks the specific tokens before the generic ones', () => {
    // Order dependence is the entire risk here: every fork also says Chrome,
    // and several also say Safari. A rule that tested Chrome first would call
    // all four of these Chrome.
    for (const ua of [UA.opera, UA.edge, UA.vivaldi]) {
      expect(fromUserAgent(ua).name).not.toBe('Chrome');
      expect(fromUserAgent(ua).name).not.toBe('Safari');
    }
  });

  it('returns null for junk instead of guessing', () => {
    expect(fromUserAgent('')).toBeNull();
    expect(fromUserAgent(null)).toBeNull();
    expect(fromUserAgent('totally unrelated')).toBeNull();
  });
});

describe('reading navigator.userAgentData.brands', () => {
  it('picks the fork over Chromium and the junk entry', () => {
    // Chromium ships a deliberately varying junk brand to stop literal
    // matching, so the rule has to DISCARD rather than match.
    expect(fromBrands([
      { brand: 'Not;A=Brand', version: '99' },
      { brand: 'Chromium', version: '136' },
      { brand: 'Opera', version: '121' },
    ])).toEqual({ name: 'Opera', version: '121' });
  });

  it('survives the junk entry changing its spelling', () => {
    expect(fromBrands([
      { brand: '"Not:A-Brand"', version: '24' },
      { brand: 'Chromium', version: '136' },
      { brand: 'Brave', version: '1.78' },
    ])).toEqual({ name: 'Brave', version: '1.78' });
  });

  it('says Chromium when that is genuinely all there is', () => {
    expect(fromBrands([
      { brand: 'Not.A/Brand', version: '8' },
      { brand: 'Chromium', version: '136' },
    ])).toEqual({ name: 'Chromium', version: '136' });
  });

  it('ignores a malformed list rather than throwing', () => {
    expect(fromBrands(null)).toBeNull();
    expect(fromBrands('nonsense')).toBeNull();
    expect(fromBrands([null, { version: '1' }, { brand: 42 }])).toBeNull();
  });
});

describe('the summary line', () => {
  it('prefers getBrowserInfo, which only Firefox answers and answers exactly', () => {
    expect(summarise({
      browserInfo: { name: 'Firefox', version: '142.0.1' },
      userAgent: UA.firefox, platform: 'Win32',
    })).toBe('Firefox 142.0.1 on Win32');
  });

  it('prefers brands over the user agent for a fork', () => {
    // Brave is the case that needs it: it ships NO token of its own, so the
    // user agent is indistinguishable from Chrome's.
    expect(summarise({
      brands: [{ brand: 'Brave', version: '1.78' }, { brand: 'Chromium', version: '136' }],
      userAgent: UA.brave, platform: 'Win32',
    })).toBe('Brave 1.78 (Chromium 136.0.0.0) on Win32');
  });

  it('reports the engine build alongside a fork version', () => {
    // Opera 121 says nothing about which Chromium it carries, and MV3
    // behaviour tracks the engine, not the badge on the box.
    expect(summarise({ userAgent: UA.opera, platform: 'Win32' }))
      .toBe('Opera 121.0.5600.20 (Chromium 136.0.0.0) on Win32');
  });

  it('does not append a redundant Chromium note for Chrome itself', () => {
    expect(summarise({ userAgent: UA.chrome, platform: 'Win32' }))
      .toBe('Chrome 136.0.0.0 on Win32');
  });

  it('does not append one for Firefox, which has no Chromium build', () => {
    expect(summarise({ userAgent: UA.firefox, platform: 'Linux x86_64' }))
      .toBe('Firefox 142.0 on Linux x86_64');
  });

  it('degrades to "unknown" rather than throwing on an empty environment', () => {
    expect(summarise({})).toBe('unknown');
    expect(summarise()).toBe('unknown');
    expect(summarise({ platform: 'Win32' })).toBe('unknown on Win32');
  });
});

describe('isFirefox, for text that names the browser\'s own services', () => {
  // The options page labelled the sync switch "(Firefox account)" in Chrome
  // too. The test is the API only Gecko has, not the user agent.
  function withBrowser(value, fn) {
    const had = Object.prototype.hasOwnProperty.call(globalThis, 'browser');
    const before = globalThis.browser;
    globalThis.browser = value;
    try { return fn(); } finally {
      if (had) globalThis.browser = before; else delete globalThis.browser;
    }
  }

  it('is true where runtime.getBrowserInfo exists (Firefox and its forks)', () => {
    expect(withBrowser({ runtime: { getBrowserInfo: async () => ({ name: 'Firefox' }) } },
      () => ProtonBrowserInfo.isFirefox())).toBe(true);
  });

  it('is false in Chrome, where browser is the aliased chrome object', () => {
    expect(withBrowser({ runtime: { id: 'x' } }, () => ProtonBrowserInfo.isFirefox())).toBe(false);
  });

  it('is false, not a throw, without any extension API', () => {
    expect(withBrowser(undefined, () => ProtonBrowserInfo.isFirefox())).toBe(false);
  });
});

describe('the export header carries it', () => {
  const OPTIONS = readFileSync(join(__dirname, '..', 'options', 'options.js'), 'utf-8');

  it('records browser, extension version and the raw user agent', () => {
    expect(OPTIONS).toMatch(/'Browser: ' \+ env\.summary/);
    expect(OPTIONS).toMatch(/'Extension: ' \+ \(extVersion \|\| 'unknown'\)/);
    // Raw UA kept because every parse above can be wrong or absent.
    expect(OPTIONS).toMatch(/'User agent: ' \+ \(env\.userAgent \|\| 'unknown'\)/);
  });

  it('never lets detection failure block the export', () => {
    // A log that will not export is worse than one missing a header line.
    const at = OPTIONS.indexOf('ProtonBrowserInfo.detect()');
    expect(at).toBeGreaterThan(-1);
    expect(OPTIONS.slice(at - 200, at + 200)).toMatch(/catch/);
  });

  it('is loaded by the options page', () => {
    const HTML = readFileSync(join(__dirname, '..', 'options', 'options.html'), 'utf-8');
    expect(HTML).toMatch(/lib\/browser-info\.js/);
  });
});
