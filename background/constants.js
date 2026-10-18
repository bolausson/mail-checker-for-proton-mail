/**
 * Shared constants for Proton Mail Checker.
 *
 * Loaded first in manifest.json so all background scripts can reference them.
 */

/** Proton system label/folder IDs. */
const ProtonLabels = Object.freeze({
  INBOX:    '0',
  DRAFTS:   '1',
  SENT:     '2',
  TRASH:    '3',
  SPAM:     '4',
  ALL_MAIL: '5',
  ARCHIVE:  '6',
  STARRED:  '10',
});

/**
 * Convenience accessor for extension settings from browser.storage.local.
 * Avoids repeating the get('settings') + fallback pattern in every module.
 */
async function getSettings() {
  const stored = await browser.storage.local.get('settings');
  return stored.settings || {};
}

/**
 * Debug logging: verbose output gated behind a storage flag.
 *
 * Toggle via Options → Data → "Enable debug logging", or manually:
 *   browser.storage.local.set({ debugLogging: true })
 *
 * In debug mode, sensitive context (emails, UIDs, token prefixes) is included
 * in log output to assist troubleshooting. Keep disabled in normal use.
 */
let _debugEnabled = false;
browser.storage.local.get('debugLogging').then(d => { _debugEnabled = !!d.debugLogging; });
browser.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.debugLogging) _debugEnabled = !!changes.debugLogging.newValue;
});
// Debug-mode console mirroring: when debug logging is on, copy debugLog output,
// real console.warn/error, and any uncaught error/rejection into the persistent
// ProtonDiag ring buffer, so the exported diagnostic log shows what the devtools
// console would, making future issues diagnosable from a single export. ALL of
// it is gated behind _debugEnabled and never runs in normal use.
let _diagCapturing = false; // re-entrancy guard: a capture must not re-log
function _fmtDiagArg(a) {
  if (typeof a === 'string') return a;
  if (a instanceof Error) return a.stack || (a.name + ': ' + a.message);
  try { return JSON.stringify(a); } catch (_) { return String(a); }
}
function _captureToDiag(level, args) {
  if (_diagCapturing || !_debugEnabled) return;
  if (typeof ProtonDiag === 'undefined' || !ProtonDiag.capture) return;
  _diagCapturing = true;
  try {
    const msg = args.map(_fmtDiagArg).join(' ').replace(/\s+/g, ' ').slice(0, 1500);
    ProtonDiag.capture(level, msg);
  } catch (_) { /* logging must never break the app */ }
  _diagCapturing = false;
}

/** Is verbose debug logging on? For callers that want to skip building an
 *  expensive log payload, not just skip printing one. */
function isDebugLoggingEnabled() { return _debugEnabled; }

function debugLog(...args) {
  if (!_debugEnabled) return;
  console.log('[DEBUG]', ...args);
  _captureToDiag('debug', args);
}

// Wrap warn/error (most are NOT routed through debugLog) and add global handlers
// for uncaught failures. console.log is left alone: ours already flows through
// debugLog, and capturing all info-level logs would bloat the ring buffer.
(function _installDiagConsoleCapture() {
  for (const level of ['warn', 'error']) {
    const orig = (console[level] || console.log).bind(console);
    console[level] = (...args) => { orig(...args); _captureToDiag(level, args); };
  }
  try {
    globalThis.addEventListener('error', (e) => {
      const where = e && e.filename ? ' @ ' + e.filename + ':' + e.lineno : '';
      _captureToDiag('uncaught', [(e && (e.error ? _fmtDiagArg(e.error) : e.message)) + where]);
    });
    globalThis.addEventListener('unhandledrejection', (e) => {
      _captureToDiag('rejection', [_fmtDiagArg(e && e.reason)]);
    });
  } catch (_) { /* no global error events in this scope */ }
})();

/** Shared API configuration. */
const ProtonConfig = Object.freeze({
  BASE_URL:    'https://mail-api.proton.me',
  APP_VERSION: 'Other',
  API_VERSION: '3',
  ACCEPT:      'application/vnd.protonmail.v1+json',

  /**
   * Build common Proton API request headers.
   * @param {string} [uid]         - x-pm-uid header (omit for unauthenticated requests)
   * @param {string} [accessToken] - Bearer token (omit for unauthenticated requests)
   * @returns {Object} Headers object ready for fetch()
   */
  buildHeaders(uid, accessToken) {
    const h = {
      'Content-Type': 'application/json',
      'x-pm-apiversion': ProtonConfig.API_VERSION,
      'Accept': ProtonConfig.ACCEPT,
      'x-pm-appversion': ProtonConfig.APP_VERSION,
    };
    if (uid) h['x-pm-uid'] = uid;
    if (accessToken) h['Authorization'] = `Bearer ${accessToken}`;
    return h;
  },
});
