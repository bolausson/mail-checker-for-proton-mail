/**
 * Proton SRP authentication.
 *
 * Implements the full Secure Remote Password (SRP-6a, RFC 5054) login flow
 * against Proton's API with Proton-specific extensions.
 *
 * Login flow:
 *   1. POST /auth/v4/info      → server ephemeral, PGP-signed modulus, salt
 *   2. Verify modulus signature  (Ed25519 via openpgp.js)
 *   3. Hash password             (bcrypt + expandHash, yields 2048-bit x)
 *   4. Generate SRP proofs       (client ephemeral A, client proof M1)
 *   5. POST /auth/v4            → server proof, UID, tokens
 *   6. Verify server proof       (MITM protection)
 *   7. If 2FA required          → return partial session for submit2FA/submitFIDO2
 *   8. GET /core/v4/keys/salts  → derive keyPassword via bcrypt
 *
 * After successful authentication, returns a session with full scopes
 * (including 'locked' for key salt access) plus the derived key password
 * for decrypting PGP private keys.
 *
 * Proton-specific deviations from standard SRP-6a:
 *   - 2048-bit modulus (vs typical 1024/3072)
 *   - expandHash produces 2048-bit output (4x SHA-512 concatenated)
 *   - All BigInts encoded as little-endian byte arrays
 *   - Password hashed via bcrypt before SRP (standard SRP hashes directly)
 *   - bcrypt salt appended with "proton" literal before encoding
 *   - $2a$ prefix treated as equivalent to $2y$ (PHP bcrypt compat)
 */

const ProtonAuth = (() => {
  const SRP_LEN = 256; // 2048 bits in bytes
  const BCRYPT_PREFIX = '$2a$10$'; // bcryptjs uses $2a$; Proton uses $2y$ but they're equivalent
  const BASE_URL = ProtonConfig.BASE_URL;
  const bcrypt = (typeof dcodeIO !== 'undefined' && dcodeIO.bcrypt) || null;

  // Proton's SRP modulus verification key (Ed25519)
  const SRP_MODULUS_KEY = `-----BEGIN PGP PUBLIC KEY BLOCK-----

xjMEXAHLgxYJKwYBBAHaRw8BAQdAFurWXXwjTemqjD7CXjXVyKf0of7n9Ctm
L8v9enkzggHNEnByb3RvbkBzcnAubW9kdWx1c8J3BBAWCgApBQJcAcuDBgsJ
BwgDAgkQNQWFxOlRjyYEFQgKAgMWAgECGQECGwMCHgEAAPGRAP9sauJsW12U
MnTQUZpsbJb53d0Wv55mZIIiJL2XulpWPQD/V6NglBd96lZKBmInSXX/kXat
Sv+y0io+LR8i2+jV+AbOOARcAcuDEgorBgEEAZdVAQUBAQdAeJHUz1c9+KfE
kSIgcBRE3WuXC4oj5a2/U3oASExGDW4DAQgHwmEEGBYIABMFAlwBy4MJEDUF
hcTpUY8mAhsMAAD/XQD8DxNI6E78meodQI+wLsrKLeHn32iLvUqJbVDhfWSU
WO4BAMcm1u02t4VKw++ttECPt+HUgPUq5pqQWe5Q2cW4TMsE
=Y4Mw
-----END PGP PUBLIC KEY BLOCK-----`;

  // --- Byte/BigInt helpers (all little-endian) ---

  function bigIntToLE(n, len) {
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) {
      bytes[i] = Number(n & 0xFFn);
      n >>= 8n;
    }
    return bytes;
  }

  function leToBigInt(bytes) {
    let result = 0n;
    for (let i = bytes.length - 1; i >= 0; i--) {
      result = (result << 8n) | BigInt(bytes[i]);
    }
    return result;
  }

  function mergeArrays(arrays) {
    const len = arrays.reduce((s, a) => s + a.length, 0);
    const result = new Uint8Array(len);
    let offset = 0;
    for (const a of arrays) {
      result.set(a, offset);
      offset += a.length;
    }
    return result;
  }

  // --- Crypto helpers ---

  async function sha512(data) {
    return new Uint8Array(await crypto.subtle.digest('SHA-512', data));
  }

  /**
   * Proton's expanded hash: H(x) = SHA512(x||0) || SHA512(x||1) || SHA512(x||2) || SHA512(x||3)
   * Produces a 2048-bit (256-byte) output.
   */
  async function expandHash(input) {
    const hashes = await Promise.all(
      [0, 1, 2, 3].map(i => sha512(mergeArrays([input, new Uint8Array([i])])))
    );
    return mergeArrays(hashes);
  }

  /** Modular exponentiation: base^exp mod mod */
  function modPow(base, exp, mod) {
    base = ((base % mod) + mod) % mod;
    let result = 1n;
    while (exp > 0n) {
      if (exp & 1n) result = (result * base) % mod;
      exp >>= 1n;
      base = (base * base) % mod;
    }
    return result;
  }

  // --- SRP ---

  /** Verify the PGP-signed modulus from the server and extract the modulus bytes. */
  async function verifyModulus(armoredModulus) {
    const publicKey = await openpgp.readKey({ armoredKey: SRP_MODULUS_KEY });
    const message = await openpgp.readCleartextMessage({ cleartextMessage: armoredModulus });
    const result = await openpgp.verify({ message, verificationKeys: publicKey });

    try {
      await result.signatures[0].verified;
    } catch (err) {
      throw new Error('Invalid modulus signature');
    }

    return ProtonBinary.base64ToUint8(result.data.trim());
  }

  /**
   * Hash the password for SRP (auth version >= 3).
   *
   * Flow: bcrypt(password, salt+"proton") → replace $2a$ with $2y$ →
   *       expandHash(bcryptOutput || modulus)
   */
  function hashPasswordV4(password, salt, modulusBytes) {
    if (!bcrypt) throw new Error('bcrypt library not loaded');

    // Decode salt, append "proton", take first 16 bytes for bcrypt
    const saltBinary = ProtonBinary.base64ToUint8(salt);
    const protonBytes = new TextEncoder().encode('proton');
    const combined = new Uint8Array(saltBinary.length + protonBytes.length);
    combined.set(saltBinary);
    combined.set(protonBytes, saltBinary.length);
    const bcryptSalt = bcrypt.encodeBase64(Array.from(combined.slice(0, 16)), 16);

    // bcrypt hash (bcryptjs uses $2a$ internally)
    const hash = bcrypt.hashSync(password, BCRYPT_PREFIX + bcryptSalt);

    // Proton uses $2y$: replace prefix so the full hash string matches
    const hash2y = hash.replace('$2a$', '$2y$');
    const hashBytes = new TextEncoder().encode(hash2y);

    // expandHash(bcryptOutput || modulus)
    return expandHash(mergeArrays([hashBytes, modulusBytes]));
  }

  /**
   * Build an SRP verifier ("Auth") for an Encrypted-Outside (EO) message password.
   *
   * Reuses the exact x-derivation login uses (hashPasswordV4) but with a fresh
   * random 10-byte salt, then computes the standard SRP verifier v = g^x mod N
   * (g = 2). Returns the { Version, ModulusID, Salt, Verifier } object Proton
   * expects in a SEND_EO (Type 2) package, the same shape WebClients' srpGetVerify
   * produces. The password is used only here (transiently) and is never logged.
   *
   * @param {string} armoredModulus - PGP-signed Modulus from GET core/v4/auth/modulus.
   * @param {string} modulusId - the ModulusID from the same response.
   * @param {string} password - the user-chosen EO password.
   * @returns {Promise<{Version:number, ModulusID:string, Salt:string, Verifier:string}>}
   */
  async function buildEoAuthFromModulus(armoredModulus, modulusId, password) {
    const modulusBytes = await verifyModulus(armoredModulus);
    const N = leToBigInt(modulusBytes);
    // 10 random bytes: hashPasswordV4 appends "proton" (6 bytes) and takes the
    // first 16 for the bcrypt salt, so the random portion must be exactly 10.
    const salt = crypto.getRandomValues(new Uint8Array(10));
    const saltB64 = ProtonBinary.uint8ToBase64(salt);
    const hashedPassword = await hashPasswordV4(password, saltB64, modulusBytes);
    const x = leToBigInt(hashedPassword);
    const verifier = bigIntToLE(modPow(2n, x, N), SRP_LEN);
    return {
      Version: 4,
      ModulusID: modulusId,
      Salt: saltB64,
      Verifier: ProtonBinary.uint8ToBase64(verifier),
    };
  }

  /**
   * Generate SRP-6a client proofs.
   *
   * Math (all arithmetic mod N, all values little-endian):
   *   k = H(g_le || N_le)         : hash of generator and modulus
   *   a = random 2048-bit          : client secret
   *   A = g^a mod N                : client ephemeral (must be non-zero)
   *   u = H(A_le || B_le)          : scrambling parameter (must be non-zero)
   *   S = (B - k*g^x)^(u*x + a)   : shared secret
   *   M1 = H(A || B || S)          : client proof (sent to server)
   *   M2 = H(A || M1 || S)         : expected server proof (verified locally)
   *
   * Retries up to 1000 times if A=0 or u=0 (astronomically unlikely).
   *
   * @param {Uint8Array} modulusBytes - Verified server modulus N (little-endian).
   * @param {Uint8Array} serverEphemeralBytes - Server ephemeral B (little-endian).
   * @param {Uint8Array} hashedPassword - 2048-bit hashed password from hashPasswordV4.
   * @returns {{ clientEphemeral: string, clientProof: string, expectedServerProof: string }}
   */
  async function generateProofs(modulusBytes, serverEphemeralBytes, hashedPassword) {
    const N = leToBigInt(modulusBytes);
    const g = 2n;
    const B = leToBigInt(serverEphemeralBytes);

    // RFC 5054 requires aborting on B mod N == 0, not just on a literally zero B.
    if (B % N === 0n) throw new Error('Invalid server ephemeral');

    // k = H(g_le || N_le)
    const gLE = bigIntToLE(g, SRP_LEN);
    const k = leToBigInt(await expandHash(mergeArrays([gLE, modulusBytes])));

    // x from hashed password
    const x = leToBigInt(hashedPassword);

    let A, a, u, ALE;
    for (let i = 0; i < 1000; i++) {
      a = leToBigInt(crypto.getRandomValues(new Uint8Array(SRP_LEN)));
      A = modPow(g, a, N);
      if (A === 0n) continue;

      ALE = bigIntToLE(A, SRP_LEN);
      u = leToBigInt(await expandHash(mergeArrays([ALE, serverEphemeralBytes])));
      if (u !== 0n) break;
    }

    if (!u || u === 0n) throw new Error('Failed to generate valid SRP parameters');

    // S = (B - k*g^x mod N) ^ (u*x + a) mod (N-1)
    const kgx = (k * modPow(g, x, N)) % N;
    const base = ((B - kgx) % N + N) % N;
    const exp = ((u * x + a) % (N - 1n) + (N - 1n)) % (N - 1n);
    const S = modPow(base, exp, N);

    const SLE = bigIntToLE(S, SRP_LEN);

    // M1 = H(A_le || B_le || S_le)
    const M1 = await expandHash(mergeArrays([ALE, serverEphemeralBytes, SLE]));

    // M2 = H(A_le || M1 || S_le)
    const M2 = await expandHash(mergeArrays([ALE, M1, SLE]));

    return {
      clientEphemeral: ProtonBinary.uint8ToBase64(ALE),
      clientProof: ProtonBinary.uint8ToBase64(M1),
      expectedServerProof: ProtonBinary.uint8ToBase64(M2),
    };
  }

  // --- Direct fetch (unauthenticated, bypasses API module) ---

  /** Build a rich error from a failed API response. */
  function _apiError(body, status) {
    const err = new Error(body.Error || `HTTP ${status}`);
    err.code = body.Code;
    err.details = body.Details;
    return err;
  }

  async function _fetch(method, path, data, extraHeaders) {
    const url = `${BASE_URL}/${path}`;
    const headers = ProtonConfig.buildHeaders();
    if (extraHeaders) Object.assign(headers, extraHeaders);

    const opts = { method, headers, credentials: 'omit' };
    if (data) opts.body = JSON.stringify(data);

    const resp = await fetch(url, opts);
    if (!resp.ok) {
      const body = await resp.json().catch(() => ({}));
      throw _apiError(body, resp.status);
    }
    return resp.json();
  }

  /** Authenticated fetch using a specific session (Bearer token). */
  async function _authFetch(method, path, uid, accessToken, data) {
    const url = `${BASE_URL}/${path}`;
    const headers = ProtonConfig.buildHeaders(uid, accessToken);

    const opts = { method, headers, credentials: 'omit' };
    if (data) opts.body = JSON.stringify(data);

    const resp = await fetch(url, opts);
    if (!resp.ok) {
      const body = await resp.json().catch(() => ({}));
      throw _apiError(body, resp.status);
    }
    return resp.json();
  }

  // --- Main login flow ---

  /**
   * Perform full SRP login.
   *
   * @param {string} username - Proton Mail username or email.
   * @param {string} password - Login password.
   * @param {string} [captchaToken] - CAPTCHA solution token for human verification.
   * @returns {Object} Session info with UID, tokens, keyPassword, etc.
   */
  async function login(username, password, captchaToken) {
    debugLog('[ProtonAuth] Starting SRP login');

    // Step 1: Get auth info
    const info = await _fetch('POST', 'auth/v4/info', {
      Username: username,
      Intent: 'Proton',
    });
    debugLog('[ProtonAuth] Got auth info, version:', info.Version);

    // Step 2: Verify and extract modulus
    const modulusBytes = await verifyModulus(info.Modulus);

    // Step 3: Hash password
    const version = info.Version || 4;
    if (version < 3) {
      throw new Error('Auth version ' + version + ' is not supported (too old)');
    }
    const hashedPassword = await hashPasswordV4(password, info.Salt, modulusBytes);

    // Step 4: Decode server ephemeral
    const serverEphemeralBytes = ProtonBinary.base64ToUint8(info.ServerEphemeral);

    // Step 5: Generate SRP proofs
    const proofs = await generateProofs(modulusBytes, serverEphemeralBytes, hashedPassword);
    debugLog('[ProtonAuth] SRP proofs generated');

    // Step 6: Authenticate (include CAPTCHA headers if provided)
    const authHeaders = {};
    if (captchaToken) {
      authHeaders['x-pm-human-verification-token'] = captchaToken;
      authHeaders['x-pm-human-verification-token-type'] = 'captcha';
    }
    const auth = await _fetch('POST', 'auth/v4', {
      Username: username,
      ClientEphemeral: proofs.clientEphemeral,
      ClientProof: proofs.clientProof,
      SRPSession: info.SRPSession,
      PersistentCookies: 1,
    }, authHeaders);

    // Step 7: Verify server proof
    if (auth.ServerProof !== proofs.expectedServerProof) {
      throw new Error('Server proof mismatch, possible MITM attack');
    }
    debugLog('[ProtonAuth] Server proof verified, UID:', auth.UID);

    // Step 8: Check for 2FA
    if (auth['2FA'] && auth['2FA'].Enabled) {
      const hasTOTP = !!auth['2FA'].TOTP;
      const hasFIDO2 = !!(auth['2FA'].FIDO2 && auth['2FA'].FIDO2.AuthenticationOptions);
      return {
        needs2FA: true,
        twoFactorType: hasTOTP && hasFIDO2 ? 'both' : (hasFIDO2 ? 'fido2' : 'totp'),
        fido2Options: hasFIDO2 ? auth['2FA'].FIDO2 : null,
        uid: auth.UID,
        accessToken: auth.AccessToken,
        refreshToken: auth.RefreshToken,
        passwordMode: auth.PasswordMode,
        _username: username, // Keep for re-auth matching
        _password: password, // Keep for key derivation after 2FA
      };
    }

    // Step 9: Two-password (legacy) accounts need a separate mailbox password
    // before keys can be unlocked. PasswordMode === 2 → SRP login password
    // does NOT unlock keys; UI must prompt for the mailbox password.
    if (auth.PasswordMode === 2) {
      return {
        needsMailboxPassword: true,
        uid: auth.UID,
        accessToken: auth.AccessToken,
        refreshToken: auth.RefreshToken,
        passwordMode: auth.PasswordMode,
        _username: username,
      };
    }

    // Step 10: Complete login (fetch key salts, derive key password)
    return _completeLogin(auth, password);
  }

  /**
   * Submit 2FA TOTP code to complete login.
   */
  async function submit2FA(partialSession, code) {
    debugLog('[ProtonAuth] Submitting 2FA code...');
    const twoFaResult = await _authFetch('POST', 'auth/v4/2fa',
      partialSession.uid, partialSession.accessToken,
      { TwoFactorCode: code });

    // Use updated tokens from 2FA response if provided
    let accessToken = twoFaResult.AccessToken || partialSession.accessToken;
    let refreshToken = twoFaResult.RefreshToken || partialSession.refreshToken;

    // The access token may have expired while the user was entering the 2FA code
    // (especially if the popup closed and they had to reopen it). Refresh it now.
    try {
      const refreshed = await refreshSession(partialSession.uid, refreshToken);
      accessToken = refreshed.accessToken;
      if (refreshed.refreshToken) refreshToken = refreshed.refreshToken;
      debugLog('[ProtonAuth] Tokens refreshed after 2FA');
    } catch (e) {
      debugLog('[ProtonAuth] Token refresh after 2FA not needed or failed:', e.message);
      // Continue with existing tokens: they may still be valid
    }

    // Two-password accounts: tokens are now valid (2FA scope cleared) but
    // the SRP login password still doesn't unlock keys. Defer to the
    // mailbox-password prompt instead of completing the login here.
    if (partialSession.passwordMode === 2) {
      return {
        needsMailboxPassword: true,
        uid: partialSession.uid,
        accessToken: accessToken,
        refreshToken: refreshToken,
        passwordMode: partialSession.passwordMode,
        _username: partialSession._username,
      };
    }

    const result = {
      UID: partialSession.uid,
      AccessToken: accessToken,
      RefreshToken: refreshToken,
      PasswordMode: partialSession.passwordMode,
    };
    return _completeLogin(result, partialSession._password);
  }

  /**
   * Submit FIDO2/WebAuthn credential to complete login.
   */
  async function submitFIDO2(partialSession, fido2Response) {
    debugLog('[ProtonAuth] Submitting FIDO2 credential...');
    const twoFaResult = await _authFetch('POST', 'auth/v4/2fa',
      partialSession.uid, partialSession.accessToken,
      { FIDO2: fido2Response });

    let accessToken = twoFaResult.AccessToken || partialSession.accessToken;
    let refreshToken = twoFaResult.RefreshToken || partialSession.refreshToken;

    // Refresh tokens in case they expired during FIDO2 flow
    try {
      const refreshed = await refreshSession(partialSession.uid, refreshToken);
      accessToken = refreshed.accessToken;
      if (refreshed.refreshToken) refreshToken = refreshed.refreshToken;
      debugLog('[ProtonAuth] Tokens refreshed after FIDO2');
    } catch (e) {
      debugLog('[ProtonAuth] Token refresh after FIDO2 not needed or failed:', e.message);
    }

    if (partialSession.passwordMode === 2) {
      return {
        needsMailboxPassword: true,
        uid: partialSession.uid,
        accessToken: accessToken,
        refreshToken: refreshToken,
        passwordMode: partialSession.passwordMode,
        _username: partialSession._username,
      };
    }

    const result = {
      UID: partialSession.uid,
      AccessToken: accessToken,
      RefreshToken: refreshToken,
      PasswordMode: partialSession.passwordMode,
    };
    return _completeLogin(result, partialSession._password);
  }

  /**
   * Complete login for a two-password account by deriving the key password
   * from the user-supplied mailbox password.
   *
   * @param {Object} pendingMbx - { uid, accessToken, refreshToken, passwordMode }
   * @param {string} mailboxPassword - The separate mailbox password (not the SRP login password).
   */
  async function submitMailboxPassword(pendingMbx, mailboxPassword) {
    debugLog('[ProtonAuth] Submitting mailbox password for two-password account');
    const result = {
      UID: pendingMbx.uid,
      AccessToken: pendingMbx.accessToken,
      RefreshToken: pendingMbx.refreshToken,
      PasswordMode: pendingMbx.passwordMode,
    };
    return _completeLogin(result, mailboxPassword);
  }

  /**
   * Complete login: fetch key salts, derive key password.
   */
  async function _completeLogin(auth, password) {
    const uid = auth.UID;
    const accessToken = auth.AccessToken;

    // Fetch key salts (we now have 'locked' scope)
    debugLog('[ProtonAuth] Fetching key salts...');
    const saltsResult = await _authFetch('GET', 'core/v4/keys/salts', uid, accessToken);
    const keySalts = saltsResult.KeySalts || [];

    // Fetch user info to find primary key
    debugLog('[ProtonAuth] Fetching user info...');
    const userResult = await _authFetch('GET', 'core/v4/users', uid, accessToken);
    const user = userResult.User;

    if (!user || !user.Keys || user.Keys.length === 0) {
      throw new Error('No user keys found');
    }

    // Find salt for the primary key we can actually read. A post-quantum
    // account has two primary user keys, a v4 and a v6, and the v6 one is
    // unreadable here; deriving from its salt would produce a key password
    // that unlocks nothing. See docs/pqc-readiness.md.
    const selection = ProtonPqc.selectUsableKey(user.Keys);
    if (selection.allUnsupported) {
      const e = new Error('Account uses post-quantum keys this version cannot read');
      e.code = 'PQC_UNSUPPORTED';
      throw e;
    }
    if (selection.skippedUnsupported) {
      debugLog('[ProtonAuth] Skipped an unreadable user key (post-quantum);',
        'using key', selection.key.ID);
    }
    const primaryKey = selection.key;
    const saltEntry = keySalts.find(ks => ks.ID === primaryKey.ID);
    const salt = saltEntry ? saltEntry.KeySalt : null;

    // Derive key password
    let keyPassword;
    if (salt) {
      keyPassword = _computeKeyPassword(password, salt);
      debugLog('[ProtonAuth] Key password derived from salt');
    } else {
      keyPassword = password;
      debugLog('[ProtonAuth] No salt, using password directly');
    }

    // ...and one per key, because EVERY user key has its OWN salt.
    //
    // A post-quantum account has two primary user keys, and the address-key
    // Tokens are each wrapped to one of them, not necessarily the one selected
    // above. Unlocking the others needs a passphrase derived from THEIR salt;
    // reusing the first key's passphrase simply fails to decrypt, silently.
    //
    // This has to happen here: the derivation is bcrypt over the login
    // password, which we deliberately never persist, so it cannot be redone
    // later from stored state.
    const keyPasswords = {};
    for (const k of user.Keys) {
      const entry = keySalts.find(ks => ks.ID === k.ID);
      if (entry && entry.KeySalt) keyPasswords[k.ID] = _computeKeyPassword(password, entry.KeySalt);
    }
    if (Object.keys(keyPasswords).length > 1) {
      debugLog('[ProtonAuth] Derived', Object.keys(keyPasswords).length, 'per-key passphrases');
    }

    // Also cache the key salts for future use
    await browser.storage.local.set({ protonKeySalts: keySalts });

    debugLog('[ProtonAuth] Login complete');

    return {
      success: true,
      uid: uid,
      userId: user.ID,
      accessToken: accessToken,
      refreshToken: auth.RefreshToken,
      keyPassword: keyPassword,
      keyPasswords: keyPasswords,
      keySalts: keySalts,
    };
  }

  /**
   * Derive Proton key password from login password + salt.
   * Same as computeKeyPassword in Proton's srp/lib/keys.ts.
   *
   * The key password is the bcrypt hash suffix starting at position 29.
   * A bcrypt hash looks like: "$2a$10$" (7) + salt (22) + hash (31) = 60 chars.
   * Position 29 = 7 + 22 = start of the actual hash output (31 chars).
   * This 31-character string is the passphrase used to decrypt PGP keys.
   *
   * @param {string} password - Login password.
   * @param {string} salt - Base64-encoded key salt from server.
   * @returns {string} 31-character key password for PGP key decryption.
   */
  function _computeKeyPassword(password, salt) {
    if (!bcrypt) throw new Error('bcrypt library not loaded');

    const saltBinary = ProtonBinary.base64ToUint8(salt);
    const bcryptSalt = bcrypt.encodeBase64(Array.from(saltBinary), 16);
    const hash = bcrypt.hashSync(password, BCRYPT_PREFIX + bcryptSalt);
    return hash.slice(29);
  }

  /**
   * The `Date` response header as epoch ms, or null if absent/unparseable.
   *
   * Every Proton response carries one, but a proxy or a stripped-header
   * environment could omit it, so callers must treat null as "unknown" and fall
   * back to their previous behaviour rather than assuming a time.
   */
  function _parseDateHeader(headers) {
    try {
      const raw = headers && headers.get ? headers.get('date') : null;
      if (!raw) return null;
      const ms = Date.parse(raw);
      return Number.isNaN(ms) ? null : ms;
    } catch (e) {
      return null;
    }
  }

  /**
   * Refresh an access token using a refresh token.
   */
  async function refreshSession(uid, refreshToken) {
    debugLog('[ProtonAuth] Refreshing session for UID:', uid.substring(0, 8) + '...');
    const result = await fetch(`${BASE_URL}/auth/v4/refresh`, {
      method: 'POST',
      headers: ProtonConfig.buildHeaders(uid),
      credentials: 'omit',
      // Cap a stalled refresh so it can't hang forever. On aggressively-suspended
      // backgrounds a half-open socket would otherwise hold the cross-context
      // refresh lock and starve this account's polling. A timed-out refresh aborts
      // as a TRANSIENT error (no .permanent, only 400/422 are permanent below),
      // so the session stays healthy and simply retries next cycle.
      signal: (typeof AbortSignal !== 'undefined' && AbortSignal.timeout) ? AbortSignal.timeout(30000) : undefined,
      body: JSON.stringify({
        ResponseType: 'token',
        GrantType: 'refresh_token',
        RefreshToken: refreshToken,
        RedirectURI: 'https://proton.me',
      }),
    });

    if (!result.ok) {
      const body = await result.json().catch(() => ({}));
      const err = new Error(body.Error || 'Token refresh failed');
      err.code = body.Code;
      err.status = result.status;
      // 400/422 means the refresh token itself is invalid (revoked, rotated
      // away, or the session was deauthed server-side). Retrying can never
      // succeed; the user must sign in again. Matches go-proton-api, which
      // deauths on StatusBadRequest/StatusUnprocessableEntity (Code 10013).
      err.permanent = result.status === 400 || result.status === 422;
      if (typeof ProtonDiag !== 'undefined') {
        ProtonDiag.record('refresh.http_fail', {
          uid: uid ? uid.slice(0, 8) : 'none',
          status: result.status, code: body.Code,
        });
      }
      console.warn('[ProtonAuth] Refresh failed, HTTP', result.status,
        'Code:', body.Code, 'Error:', body.Error);
      throw err;
    }

    const data = await result.json();
    debugLog('[ProtonAuth] Session refreshed successfully');
    return {
      accessToken: data.AccessToken,
      refreshToken: data.RefreshToken,
      uid: data.UID,
      // The SERVER's clock at the moment this refresh happened. Stored so a
      // later 401 can be compared against it to tell "this 401 is newer than my
      // token, so refresh" from "this 401 was already in flight when I rotated,
      // so ignore it". Both sides of that comparison must come from the same
      // clock; mixing in Date.now() would reintroduce the skew this avoids.
      // Matches Proton Pass (packages/pass/lib/api/refresh.ts), which sets
      // RefreshTime from getDateHeader(response.headers).
      serverDate: _parseDateHeader(result.headers),
    };
  }

  return {
    login,
    submit2FA,
    submitFIDO2,
    submitMailboxPassword,
    refreshSession,
    // Exported so accounts.js can stamp the server date onto a 401 without
    // duplicating the parsing (and its null handling).
    parseDateHeader: _parseDateHeader,
    buildEoAuthFromModulus,
    // Drive share-URL passwords derive their symmetric key-packet passphrase
    // with the exact bcrypt-slice used for login key passwords (WebClients'
    // computeKeyPassword), exported so ProtonDrive reuses this implementation.
    computeKeyPassword: _computeKeyPassword,
  };
})();
