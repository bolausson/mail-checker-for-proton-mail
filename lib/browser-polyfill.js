/**
 * Tiny chrome → browser shim.
 *
 * Firefox exposes `browser.*` natively (and `chrome.*` as an alias).
 * Chrome MV3 exposes only `chrome.*`; the canonical source uses
 * `browser.*` throughout, so on Chrome we alias them.
 *
 * Chrome 121+ returns promises from chrome.* APIs, so existing
 * `await browser.something(...)` calls work unchanged after aliasing.
 * The Chrome build sets minimum_chrome_version: "121" in its manifest.
 *
 * No-op on Firefox (where `browser` is already defined).
 */
if (typeof browser === 'undefined' && typeof chrome !== 'undefined') {
  globalThis.browser = chrome;
}
