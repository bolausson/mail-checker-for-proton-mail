/**
 * Post-quantum (RFC 9980) key detection.
 *
 * Proton has been rolling out opt-in post-quantum keys since May 2026. An
 * opted-in account keeps its v4 user keys and gains a v6 one, so it has TWO
 * primary active user keys, and every address gains a v6 sibling as well.
 *
 * We now vendor Proton's OpenPGP.js fork, which implements the two RFC 9980
 * algorithms Proton actually issues: 30 (ML-DSA-65 + Ed25519, signing) and 35
 * (ML-KEM-768 + X25519, encryption). Those keys parse and unlock like any
 * other, so this module no longer exists to refuse them.
 *
 * It still earns its place, because the RFC defines five more ids that NO
 * implementation ships: 31 and 36 (the -87 and -1024 parameter sets) and 32 to
 * 34 (SLH-DSA). A key using one of those still fails while the ring is PARSED,
 * before any passphrase is tried, so find(Primary === 1) would fail at random
 * depending on the order the API happened to return. Reading the packet header
 * by hand, without OpenPGP.js, is what lets us pick a key we can use and
 * explain the one we cannot instead of blaming the password.
 *
 * See docs/pqc-readiness.md.
 */
const ProtonPqc = (() => {
  'use strict';

  // RFC 9980. 30 to 34 are ML-DSA + EdDSA and SLH-DSA signatures, 35 and 36
  // are ML-KEM + ECDH encryption.
  const PQC_ALGO_MIN = 30;
  const PQC_ALGO_MAX = 36;
  // Highest CLASSICAL public-key algorithm id OpenPGP.js implements (ed448).
  const MAX_CLASSICAL_ALGO = 28;
  // The post-quantum ids the vendored bundle can actually parse. An explicit
  // set, not a range: 31 to 34 and 36 sit BETWEEN these two and are supported
  // by nobody, so a bound of "<= 35" would claim keys we cannot read.
  // tests/openpgp-pqc-pin.test.js checks this against the bundle itself.
  const SUPPORTED_PQC_ALGOS = new Set([30, 35]);

  /** Decode the base64 payload of an ASCII-armored block to bytes. */
  function _dearmor(armored) {
    const text = String(armored || '');
    const begin = text.indexOf('-----BEGIN');
    if (begin === -1) return null;
    const afterBegin = text.indexOf('\n', begin);
    if (afterBegin === -1) return null;
    const end = text.indexOf('-----END');
    const body = text.slice(afterBegin + 1, end === -1 ? undefined : end);

    const b64 = [];
    let pastHeaders = false;
    for (const rawLine of body.split('\n')) {
      const line = rawLine.trim();
      if (!pastHeaders) {
        // Armor headers ("Version: ...") run until the first blank line. A
        // block with no headers starts its base64 immediately.
        if (line === '') { pastHeaders = true; continue; }
        if (/^[A-Za-z][A-Za-z-]*:\s/.test(line)) continue;
        pastHeaders = true;
      }
      if (line === '' || line.charAt(0) === '=') continue; // CRC24 tail
      b64.push(line);
    }
    const joined = b64.join('');
    if (!joined) return null;
    try {
      const bin = atob(joined);
      const out = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
      return out;
    } catch (e) {
      return null;
    }
  }

  /** Offset of the first packet's body, or -1 if the header is unreadable. */
  function _firstPacketBodyOffset(bytes) {
    if (!bytes || bytes.length < 2) return -1;
    const header = bytes[0];
    if ((header & 0x80) === 0) return -1; // not a packet header
    if (header & 0x40) {
      // New format: one length byte, or 2, or 5, or a partial length.
      const first = bytes[1];
      if (first < 192) return 2;
      if (first < 224) return 3;
      if (first === 255) return 6;
      return 2; // partial length; the body still starts right after it
    }
    // Old format: the low two bits select the length field width.
    switch (header & 0x03) {
      case 0: return 2;
      case 1: return 3;
      case 2: return 5;
      default: return 1; // indeterminate length, body follows immediately
    }
  }

  /**
   * Read the version and public-key algorithm of an armored key, without
   * OpenPGP.js. In v4, v5 and v6 key packets alike the layout begins
   * version(1) + creation time(4) + algorithm(1), so the algorithm sits at
   * offset 5 of the packet body.
   *
   * @returns {{version:number, algorithm:number}|null} null if unreadable.
   */
  function readKeyAlgorithm(armoredKey) {
    const bytes = _dearmor(armoredKey);
    if (!bytes) return null;
    const start = _firstPacketBodyOffset(bytes);
    if (start < 0 || bytes.length < start + 6) return null;
    const version = bytes[start];
    if (version < 2 || version > 6) return null;
    return { version, algorithm: bytes[start + 5] };
  }

  /** True for an RFC 9980 post-quantum algorithm id. */
  function isPqcAlgorithm(algorithm) {
    return typeof algorithm === 'number' &&
      algorithm >= PQC_ALGO_MIN && algorithm <= PQC_ALGO_MAX;
  }

  /**
   * True when the vendored OpenPGP.js implements this algorithm id.
   *
   * Everything at or below the classical bound, plus the post-quantum ids the
   * Proton fork adds. Ids we have never heard of that sit below the bound stay
   * "supported" on purpose: see isUnsupportedKey.
   */
  function isSupportedAlgorithm(algorithm) {
    if (typeof algorithm !== 'number') return false;
    return algorithm <= MAX_CLASSICAL_ALGO || SUPPORTED_PQC_ALGOS.has(algorithm);
  }

  /**
   * True when our OpenPGP.js cannot parse this key. Deliberately conservative:
   * a key we cannot read the header of at all is reported as usable, so an
   * unfamiliar-but-fine key is still tried rather than silently skipped.
   */
  function isUnsupportedKey(armoredKey) {
    const info = readKeyAlgorithm(armoredKey);
    if (!info) return false;
    return !isSupportedAlgorithm(info.algorithm);
  }

  /**
   * Split a Proton `Keys` array into the ones we can use and the ones we
   * cannot, preserving the API's order within each group.
   *
   * `hasPqc` counts EVERY post-quantum key, usable or not. It used to imply
   * "and therefore unreadable", which stopped being true the moment the fork
   * was vendored: a working post-quantum account would otherwise report
   * hasPqc false, which is exactly backwards for a diagnostic whose whole job
   * is to tell us whether such an account exists in the wild.
   *
   * @param {Array} keys - Proton key objects with PrivateKey or PublicKey.
   * @returns {{usable:Array, unsupported:Array, hasPqc:boolean, hasUnsupportedPqc:boolean}}
   */
  function classifyKeys(keys) {
    const usable = [];
    const unsupported = [];
    let hasPqc = false;
    let hasUnsupportedPqc = false;
    for (const key of (keys || [])) {
      const armored = key && (key.PrivateKey || key.PublicKey);
      const info = armored ? readKeyAlgorithm(armored) : null;
      const pqc = !!info && isPqcAlgorithm(info.algorithm);
      if (pqc) hasPqc = true;
      if (info && !isSupportedAlgorithm(info.algorithm)) {
        unsupported.push(key);
        if (pqc) hasUnsupportedPqc = true;
      } else {
        usable.push(key);
      }
    }
    return { usable, unsupported, hasPqc, hasUnsupportedPqc };
  }

  /**
   * Choose the user key to unlock with. Prefers a primary key we can parse,
   * then any parseable key, and only then falls back to the API's own first
   * primary, so behaviour on an ordinary account is unchanged.
   *
   * @returns {{key:object|null, skippedUnsupported:boolean, hasPqc:boolean}}
   */
  function selectUsableKey(keys) {
    const list = keys || [];
    const { usable, unsupported, hasPqc, hasUnsupportedPqc } = classifyKeys(list);
    const pick = usable.find(k => k.Primary === 1) || usable[0] || null;
    return {
      key: pick || list.find(k => k.Primary === 1) || list[0] || null,
      skippedUnsupported: !!pick && unsupported.length > 0,
      hasPqc,
      hasUnsupportedPqc,
      // No key at all is usable: the caller should explain rather than blame
      // the password.
      allUnsupported: !pick && unsupported.length > 0,
    };
  }

  /**
   * How suitable a decrypted address key is for SIGNING outgoing mail.
   * Higher wins. Primary-ness outranks key version; version breaks the tie.
   *
   * Two separate rules, in that order:
   *
   * 1. **Primary.** Matches WebClients' getPrimaryAddressKeysForSigning, not
   *    getPrimaryKey, which is plain keys[0] and ignores the flag. An address
   *    can hold several active keys after a rotation, so "the first one that
   *    decrypted" is not good enough.
   * 2. **v4 over v6.** WebClients passes `withV6SupportForSigning: false` on
   *    the mail path because "presence of v6 signatures breaks parsing for some
   *    third-party OpenPGP libs (e.g. RNP), as well as older gopenpgp
   *    versions". On a post-quantum account an address holds a v4 and a v6
   *    primary at once: the v6 is for DECRYPTION, and signing with it would
   *    silently produce mail some recipients cannot parse. Nothing in our own
   *    testing would catch that, because we verify our own signatures fine.
   *
   * Primary-ness is ranked first because it is Proton's own statement about
   * which key to use, and a non-primary key may have been rotated out. The
   * combination it protects against, a v6 primary with only a non-primary v4
   * available, does not arise while Proton keeps the v4 key primary on opt-in.
   */
  function _signingRank(choice) {
    // A v5 key would rank with v6 here, which is right: the concern is any
    // signature version third-party parsers may not accept.
    return (choice.primary ? 2 : 0) + (choice.version <= 4 ? 1 : 0);
  }

  /**
   * Should a freshly decrypted address key replace the one already chosen to
   * sign and encrypt outgoing mail for that address?
   *
   * Decryption success is only known after the attempt, so the choice has to be
   * made incrementally as the unlock loop runs, which is why this is a reducer
   * rather than a filter. Ties keep the incumbent, so an account whose keys are
   * all v4 behaves exactly as it did before post-quantum support.
   *
   * @param {{primary:boolean, version:number}|null} existing - current choice
   * @param {{primary:boolean, version:number}} candidate - the key just decrypted
   */
  function preferAddressKeyForSigning(existing, candidate) {
    if (!existing) return true;
    return _signingRank(candidate) > _signingRank(existing);
  }

  return {
    readKeyAlgorithm,
    isPqcAlgorithm,
    isSupportedAlgorithm,
    isUnsupportedKey,
    classifyKeys,
    selectUsableKey,
    preferAddressKeyForSigning,
    PQC_ALGO_MIN,
    PQC_ALGO_MAX,
    MAX_CLASSICAL_ALGO,
    SUPPORTED_PQC_ALGOS,
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = ProtonPqc;
