/**
 * Shared binary <-> text conversion helpers.
 *
 * WHY THIS MODULE EXISTS
 * ----------------------
 * Base64 and hex conversion were independently re-implemented in at least
 * five places (background/encryption.js, background/accounts.js,
 * background/calendar-serialize.js, background/background.js, and inline
 * call sites in auth.js / calendar-utils.js). The copies had drifted:
 *   - only background.js chunked the encode loop, so the other copies threw
 *     RangeError on multi-MB attachments;
 *   - only accounts.js guarded against an already-encoded string input;
 *   - the decode side mixed a fast manual loop (encryption.js) with the
 *     11-36x slower `Uint8Array.from(atob(x), c => c.charCodeAt(0))` form on
 *     the hot attachment-decrypt path.
 *
 * Consolidating into one well-tested module removes that drift and gives the
 * whole codebase the safe (chunked) + fast variants by default. The encoder
 * here is a behavioural SUPERSET of every previous copy, so adopting it does
 * not change observable output for existing callers.
 *
 * Loaded early (right after constants.js) in manifest.json background.scripts,
 * and via <script> in popup.html / options.html, so every context can use the
 * `ProtonBinary` global. Content scripts (e.g. fido2/fido2-inject.js) run in an
 * isolated world that cannot see this global and keep their own small inline
 * copy on purpose.
 */
/* exported ProtonBinary */
const ProtonBinary = (() => {
  // String.fromCharCode.apply() spreads the chunk as call arguments; 32 KiB
  // stays well under every engine's argument-count limit while keeping the
  // loop short for typical payloads.
  const CHUNK = 0x8000; // 32768

  /**
   * Encode bytes as a base64 string.
   *
   * Accepts a Uint8Array, an ArrayBuffer, or a plain array of byte values.
   * As an idempotency guard it also accepts an already-encoded base64 string
   * and returns it unchanged: some callers (e.g. cached session-key packets
   * in accounts.js) may hand back a value that was encoded earlier.
   *
   * @param {Uint8Array|ArrayBuffer|number[]|string} bytes
   * @returns {string} base64 text
   */
  function uint8ToBase64(bytes) {
    if (typeof bytes === 'string') return bytes;
    const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    let bin = '';
    // Chunk to avoid String.fromCharCode hitting the call-stack argument
    // limit on large payloads (multi-MB attachments).
    for (let i = 0; i < u8.length; i += CHUNK) {
      bin += String.fromCharCode.apply(null, u8.subarray(i, i + CHUNK));
    }
    return btoa(bin);
  }

  /**
   * Decode a base64 string into bytes.
   *
   * Uses a manual charCodeAt loop rather than
   * `Uint8Array.from(atob(b64), c => c.charCodeAt(0))`: the loop is an order
   * of magnitude faster on large inputs (the per-element mapper allocates and
   * is markedly slower), which matters on the attachment-decrypt path.
   *
   * @param {string} b64 - base64 text
   * @returns {Uint8Array}
   */
  function base64ToUint8(b64) {
    const bin = atob(b64);
    const len = bin.length;
    const out = new Uint8Array(len);
    for (let i = 0; i < len; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  /**
   * Encode bytes as a lowercase, zero-padded hex string.
   * @param {Uint8Array|number[]} bytes
   * @returns {string} e.g. [0, 15, 255] -> "000fff"
   */
  function bytesToHex(bytes) {
    return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  }

  return { uint8ToBase64, base64ToUint8, bytesToHex };
})();
