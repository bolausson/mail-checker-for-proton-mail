/**
 * CAPTCHA-flow CSP override shim.
 *
 * Proton's hCaptcha is loaded as a cross-origin iframe of verify.proton.me
 * inside an account.proton.me page. Both pages set Content-Security-Policy
 * and X-Frame-Options that block this framing. The login flow temporarily
 * relaxes those headers ONLY while a login is pending so the iframe can
 * render.
 *
 * Implemented via declarativeNetRequest SESSION rules: kept in memory for
 * this browser run and never written to disk, which is what a rule meant to
 * exist for one sign-in should be. The dynamic rules used before are written
 * to the profile, and Chrome refused that write in at least one setup
 * ("Internal error while updating dynamic rules"), leaving Proton's CAPTCHA
 * frame blocked. Dynamic rules remain only as a fallback where session rules
 * are missing, and any left over from an older version are removed.
 * Works on both Firefox MV3 (we require 142+) and Chrome MV3. We don't use
 * webRequest.onHeadersReceived blocking mode because Firefox MV3 restricts
 * webRequestBlocking to enterprise / AMO-approved cases: even about:debugging
 * installs can't rely on it.
 *
 * Trade-off: DNR's modifyHeaders action can only set/append/remove the
 * entire header, so we remove CSP and X-Frame-Options outright on the
 * affected hosts during login. Security impact is limited to the brief
 * login window and only on Proton's own pages.
 */

const ProtonCSPShim = (() => {
  // Stable rule IDs so we can clean up dynamic rules left over from a
  // previous login (e.g. service worker died mid-flow).
  const RULE_ID_ACCOUNT = 1001;
  const RULE_ID_VERIFY = 1002;
  // verify-api.proton.me hosts the actual CAPTCHA challenge document, which
  // is loaded in a nested iframe inside verify.proton.me. Its CSP sets
  // `frame-ancestors https://verify.proton.me`, but Chrome checks the WHOLE
  // ancestor chain, so account.proton.me being the top frame blocks the
  // load. Strip CSP on verify-api.proton.me too.
  const RULE_ID_VERIFY_API = 1003;
  const ALL_RULE_IDS = [RULE_ID_ACCOUNT, RULE_ID_VERIFY, RULE_ID_VERIFY_API];

  // Feature-detect declarativeNetRequest. Both Firefox MV3 and Chrome
  // MV3 expose it once the permission is granted.
  const _supportsDNR = typeof browser !== 'undefined' &&
    browser.declarativeNetRequest &&
    typeof browser.declarativeNetRequest.updateDynamicRules === 'function';
  const _supportsSession = _supportsDNR &&
    typeof browser.declarativeNetRequest.updateSessionRules === 'function';

  /** Remove our rules of both kinds: session now, dynamic from older versions
   *  (or the fallback). Each is attempted on its own, so one failing cannot
   *  leave the other in place. */
  async function _removeAll() {
    if (_supportsSession) {
      try {
        await browser.declarativeNetRequest.updateSessionRules({ removeRuleIds: ALL_RULE_IDS });
      } catch (_) { /* none to remove */ }
    }
    try {
      await browser.declarativeNetRequest.updateDynamicRules({ removeRuleIds: ALL_RULE_IDS });
    } catch (_) { /* none to remove */ }
  }

  function _buildRules() {
    const headerStrip = [
      { header: 'content-security-policy', operation: 'remove' },
      { header: 'x-frame-options', operation: 'remove' },
    ];
    return [
      {
        id: RULE_ID_ACCOUNT,
        priority: 1,
        action: { type: 'modifyHeaders', responseHeaders: headerStrip },
        condition: {
          urlFilter: '||account.proton.me/',
          resourceTypes: ['main_frame', 'sub_frame'],
        },
      },
      {
        id: RULE_ID_VERIFY,
        priority: 1,
        action: { type: 'modifyHeaders', responseHeaders: headerStrip },
        condition: {
          urlFilter: '||verify.proton.me/',
          resourceTypes: ['main_frame', 'sub_frame'],
        },
      },
      {
        id: RULE_ID_VERIFY_API,
        priority: 1,
        action: { type: 'modifyHeaders', responseHeaders: headerStrip },
        condition: {
          urlFilter: '||verify-api.proton.me/',
          resourceTypes: ['main_frame', 'sub_frame'],
        },
      },
    ];
  }

  /** Install the rules that relax CSP on the CAPTCHA hosts. */
  async function enableLoginCSPOverride() {
    if (!_supportsDNR) return;
    try {
      if (_supportsSession) {
        await browser.declarativeNetRequest.updateSessionRules({
          addRules: _buildRules(),
          removeRuleIds: ALL_RULE_IDS,
        });
        // Never both at once: drop any dynamic copy an older version left.
        try {
          await browser.declarativeNetRequest.updateDynamicRules({ removeRuleIds: ALL_RULE_IDS });
        } catch (_) { /* none to remove */ }
      } else {
        await browser.declarativeNetRequest.updateDynamicRules({
          addRules: _buildRules(),
          removeRuleIds: ALL_RULE_IDS,
        });
      }
      debugLog('[ProtonCSPShim] DNR override enabled');
    } catch (e) {
      console.warn('[ProtonCSPShim] enable failed:', e.message);
    }
  }

  /** Remove the rules. Safe to call when no rules are active. */
  async function disableLoginCSPOverride() {
    if (!_supportsDNR) return;
    await _removeAll();
    debugLog('[ProtonCSPShim] DNR override disabled');
  }

  /** Clear any stale rules left over from a background that stopped
   *  mid-login. Called once at startup: the pending sign-in lived in that
   *  background's memory and is gone with it, so its rules must go too. */
  async function clearStaleRules() {
    if (!_supportsDNR) return;
    await _removeAll();
  }

  return {
    enableLoginCSPOverride,
    disableLoginCSPOverride,
    clearStaleRules,
    isSupported: () => _supportsDNR,
  };
})();
