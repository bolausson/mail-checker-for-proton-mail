/**
 * AES-256-GCM encryption for sensitive data at rest.
 *
 * Encrypts keyPassword, accessToken, and refreshToken before they are
 * written to browser.storage.local.  The encryption key and IV are
 * themselves stored in browser.storage.local. This protects against
 * casual disk/profile inspection but not a fully compromised browser
 * context (same tradeoff as Checker Plus for Gmail, Bitwarden, etc.).
 */

const ExtEncryption = (() => {
  const ALGO = 'AES-GCM';
  const IV_LEN = 12;
  const KEY_STORAGE_KEY = '_encKey';

  let _cachedKey = null;

  async function _getOrCreateKey() {
    if (_cachedKey) return _cachedKey;

    const stored = await browser.storage.local.get(KEY_STORAGE_KEY);
    if (stored[KEY_STORAGE_KEY]) {
      const raw = new Uint8Array(stored[KEY_STORAGE_KEY]).buffer;
      _cachedKey = await crypto.subtle.importKey(
        'raw', raw, ALGO, true, ['encrypt', 'decrypt']);
      return _cachedKey;
    }

    const key = await crypto.subtle.generateKey(
      { name: ALGO, length: 256 }, true, ['encrypt', 'decrypt']);
    const exported = await crypto.subtle.exportKey('raw', key);
    await browser.storage.local.set({
      [KEY_STORAGE_KEY]: Array.from(new Uint8Array(exported)),
    });
    _cachedKey = key;
    return key;
  }

  async function encrypt(plaintext) {
    if (!plaintext) return plaintext;
    const key = await _getOrCreateKey();
    const iv = crypto.getRandomValues(new Uint8Array(IV_LEN));
    const encoded = new TextEncoder().encode(plaintext);
    const ciphertext = await crypto.subtle.encrypt(
      { name: ALGO, iv }, key, encoded);
    // Prepend IV to ciphertext so each encryption uses a unique IV
    const combined = new Uint8Array(IV_LEN + ciphertext.byteLength);
    combined.set(iv, 0);
    combined.set(new Uint8Array(ciphertext), IV_LEN);
    return ProtonBinary.uint8ToBase64(combined);
  }

  async function decrypt(ciphertext) {
    if (!ciphertext) return ciphertext;
    const key = await _getOrCreateKey();
    const buffer = ProtonBinary.base64ToUint8(ciphertext);
    // Support both new format (IV prepended) and legacy (static IV)
    if (buffer.length > IV_LEN) {
      try {
        const iv = buffer.slice(0, IV_LEN);
        const data = buffer.slice(IV_LEN);
        const decrypted = await crypto.subtle.decrypt(
          { name: ALGO, iv }, key, data);
        return new TextDecoder().decode(decrypted);
      } catch (_) {
        // Fall through to legacy decryption
      }
    }
    // Legacy: try with stored static IV (for data encrypted before this change)
    const stored = await browser.storage.local.get('_encIv');
    if (stored._encIv) {
      const legacyIv = new Uint8Array(stored._encIv);
      const decrypted = await crypto.subtle.decrypt(
        { name: ALGO, iv: legacyIv }, key, buffer);
      return new TextDecoder().decode(decrypted);
    }
    throw new Error('Cannot decrypt: no IV available');
  }

  return { encrypt, decrypt };
})();
