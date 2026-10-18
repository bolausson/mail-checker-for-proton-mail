/**
 * Which browser is this, really?
 *
 * Support logs need this and the diagnostic export did not carry it. "Chrome"
 * is not a useful answer: Opera, Edge, Brave and Vivaldi are all Chromium, all
 * report `Chrome/<version>` in their user agent, and they do NOT behave the
 * same. Opera kills the MV3 service worker every 2 to 4 minutes, which is why
 * a refresh-token race that was mild elsewhere was constant there and took a
 * long investigation to pin down. Knowing the brand up front would have
 * shortened it.
 *
 * Detection order, most trustworthy first:
 *   1. runtime.getBrowserInfo(), which only Firefox implements and which
 *      answers authoritatively.
 *   2. navigator.userAgentData.brands, the modern Chromium list, where Opera
 *      and Edge name themselves properly instead of hiding behind Chrome.
 *   3. The user-agent string, parsed most-specific-first.
 *
 * The raw user agent goes into the export too. Every layer above can be wrong
 * or absent, and when it is, the untouched string is what lets a human tell
 * what actually happened.
 */
const ProtonBrowserInfo = (() => {
  'use strict';

  // Order matters: every Chromium fork also says "Chrome", and several say
  // "Safari", so the specific tokens have to be tested first. Brave is absent
  // on purpose, it ships no token at all and is only identifiable via brands.
  const UA_PATTERNS = [
    { name: 'Opera', re: /\bOPR\/([\d.]+)/ },
    { name: 'Opera', re: /\bOpera\/([\d.]+)/ },
    { name: 'Microsoft Edge', re: /\bEdg(?:e|A|iOS)?\/([\d.]+)/ },
    { name: 'Vivaldi', re: /\bVivaldi\/([\d.]+)/ },
    { name: 'Yandex', re: /\bYaBrowser\/([\d.]+)/ },
    { name: 'Samsung Internet', re: /\bSamsungBrowser\/([\d.]+)/ },
    { name: 'Firefox', re: /\bFirefox\/([\d.]+)/ },
    { name: 'Chrome', re: /\bChrome\/([\d.]+)/ },
    { name: 'Safari', re: /\bVersion\/([\d.]+).*\bSafari\// },
  ];

  /** Chromium's own version, which is separate from the fork's version. */
  function _chromiumVersion(ua) {
    const m = /\bChrome\/([\d.]+)/.exec(String(ua || ''));
    return m ? m[1] : null;
  }

  /**
   * Pick the real brand out of navigator.userAgentData.brands.
   *
   * The list always carries a deliberately junk entry ("Not;A=Brand" and
   * friends, the exact spelling varies to stop anyone matching it literally)
   * plus a generic "Chromium". The fork's own name is whatever is left, so
   * discard rather than match.
   */
  function fromBrands(brands) {
    if (!Array.isArray(brands)) return null;
    for (const entry of brands) {
      const brand = entry && entry.brand;
      if (typeof brand !== 'string') continue;
      if (/not.*brand/i.test(brand)) continue;   // the junk entry
      if (/^chromium$/i.test(brand)) continue;   // the engine, not the product
      return { name: brand, version: (entry.version || '') || null };
    }
    // Only Chromium and junk: it IS plain Chromium, which is worth saying.
    const chromium = brands.find(b => b && /^chromium$/i.test(b.brand || ''));
    return chromium ? { name: 'Chromium', version: chromium.version || null } : null;
  }

  /** Best guess from the user-agent string alone. */
  function fromUserAgent(ua) {
    const text = String(ua || '');
    for (const { name, re } of UA_PATTERNS) {
      const m = re.exec(text);
      if (m) return { name, version: m[1] || null };
    }
    return null;
  }

  /**
   * Build the one-line summary.
   *
   * @param {object} sources - {browserInfo, brands, userAgent, platform}
   * @returns {string} e.g. "Opera 121.0.5600 (Chromium 136.0.0.0) on Win32"
   */
  function describe(sources) {
    const s = sources || {};
    let picked = null;
    if (s.browserInfo && s.browserInfo.name) {
      picked = { name: s.browserInfo.name, version: s.browserInfo.version || null };
    }
    if (!picked) picked = fromBrands(s.brands);
    if (!picked) picked = fromUserAgent(s.userAgent);
    if (!picked) return 'unknown' + (s.platform ? ' on ' + s.platform : '');

    let out = picked.name + (picked.version ? ' ' + picked.version : '');
    // Name the engine build too when the product is a Chromium fork, since a
    // fork's own version number says nothing about which Chromium it carries,
    // and MV3 behaviour tracks the engine.
    const chromium = _chromiumVersion(s.userAgent);
    if (chromium && !/^chrom(e|ium)$/i.test(picked.name) && picked.version !== chromium) {
      out += ' (Chromium ' + chromium + ')';
    }
    if (s.platform) out += ' on ' + s.platform;
    return out;
  }

  /** Gather what this runtime will tell us. Never throws. */
  async function detect() {
    const sources = { browserInfo: null, brands: null, userAgent: '', platform: '' };
    try {
      sources.userAgent = (typeof navigator !== 'undefined' && navigator.userAgent) || '';
      sources.platform = (typeof navigator !== 'undefined' && navigator.platform) || '';
      const uaData = (typeof navigator !== 'undefined' && navigator.userAgentData) || null;
      if (uaData && Array.isArray(uaData.brands)) sources.brands = uaData.brands;
      if (uaData && uaData.platform) sources.platform = uaData.platform;
    } catch (e) { /* keep whatever we already have */ }
    try {
      // Firefox only. Guarded because Chromium's runtime has no such method.
      if (typeof browser !== 'undefined' && browser.runtime && browser.runtime.getBrowserInfo) {
        sources.browserInfo = await browser.runtime.getBrowserInfo();
      }
    } catch (e) { /* fall through to the other sources */ }
    return { summary: describe(sources), userAgent: sources.userAgent };
  }

  return { describe, detect, fromBrands, fromUserAgent };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = ProtonBrowserInfo;
