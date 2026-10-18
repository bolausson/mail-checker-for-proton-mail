/**
 * The vendored OpenPGP.js must be the post-quantum-capable build.
 *
 * We ship Proton's fork, `@protontech/openpgp@6.3.1`, in place of upstream
 * `openpgp@6.3.1`. **Both call themselves 6.3.1.** Only the banner date differs
 * (2026-07-31 vs 2026-06-04), so a version check would not catch a refresh that
 * quietly put upstream back and took post-quantum support with it.
 *
 * The pin therefore has to be STRUCTURAL: ask the bundle what it implements.
 * Every assertion here fails against upstream 6.3.1, which is the only property
 * that makes the pin worth having. A
 * check that cannot fail proves nothing.
 *
 * These are also the first tests anywhere in the repo to make a real
 * `openpgp.*` call rather than stub the library out.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const ROOT = join(__dirname, '..');
const BUNDLE = join(ROOT, 'lib', 'openpgp.min.js');

const PQC_SRC = readFileSync(join(ROOT, 'lib', 'pqc-detect.js'), 'utf-8');
const ProtonPqc = new Function('atob', PQC_SRC + '; return ProtonPqc;')(globalThis.atob);

const PASSPHRASE = 'pin-test passphrase';

let openpgp;

beforeAll(() => {
  // Load it exactly as the extension does: a classic global IIFE, no bundler,
  // no ESM. If the fork ever ships only `.mjs`, importScripts in the Chrome
  // service worker would break and so does this line.
  globalThis.window = globalThis;
  globalThis.self = globalThis;
  // eslint-disable-next-line no-eval
  (0, eval)(readFileSync(BUNDLE, 'utf-8'));
  openpgp = globalThis.openpgp;
});

/**
 * A post-quantum key pair, generated once and shared.
 *
 * Deliberately NOT built in beforeAll. Against upstream this call throws
 * ("Unsupported key type pqc"), and a throwing beforeAll marks every test in
 * the file *skipped* rather than failed, which hides the precise assertion
 * that identifies the problem. Generating it lazily lets the enum checks fail
 * on their own terms and name exactly what is missing.
 */
// Post-quantum keygen takes seconds by design, and the suite gained four
// files in the review fix rounds, so the 5 s default started flaking under
// parallel load. This is a slow operation, not a hanging one: give the tests
// that wait on the fixture room rather than letting CI go red at random.
const PQC_TIMEOUT_MS = 60000;

let _pqcKeys = null;
function pqcFixture() {
  if (!_pqcKeys) {
    _pqcKeys = openpgp.generateKey({
      type: 'pqc',
      userIDs: [{ name: 'pin', email: 'pin@test.invalid' }],
      passphrase: PASSPHRASE,
      format: 'armored',
      config: { v6Keys: true },
    });
  }
  return _pqcKeys;
}

describe('the bundle implements RFC 9980', () => {
  it('knows ML-DSA-65 + Ed25519 as algorithm 30', () => {
    expect(openpgp.enums.publicKey.pqc_mldsa_ed25519).toBe(30);
  });

  it('knows ML-KEM-768 + X25519 as algorithm 35', () => {
    expect(openpgp.enums.publicKey.pqc_mlkem_x25519).toBe(35);
  });

  it('is the fork, not upstream, by banner date', () => {
    // Belt and braces. The structural checks above are the real pin; this one
    // names the artefact in the failure message so the fix is obvious.
    const banner = readFileSync(BUNDLE, 'utf-8').slice(0, 200);
    expect(banner).toContain('OpenPGP.js v6.3.1');
    expect(banner).not.toContain('v6.3.1 - 2026-06-04'); // upstream
  });

  it('exposes every entry point the extension calls', () => {
    // A swap that drops one of these breaks the extension at runtime, in a
    // code path no other test reaches.
    const used = ['readKey', 'readKeys', 'readPrivateKey', 'readMessage',
      'readSignature', 'createMessage', 'createCleartextMessage', 'decryptKey',
      'encryptKey', 'generateKey', 'generateSessionKey', 'encrypt', 'decrypt',
      'sign', 'verify', 'encryptSessionKey', 'decryptSessionKeys', 'armor',
      'unarmor', 'enums', 'config'];
    expect(used.filter(name => openpgp[name] === undefined)).toEqual([]);
  });
});

describe('a post-quantum key actually works end to end', () => {
  it('generates the shape Proton issues: a v6 algo-30 primary with an algo-35 subkey', async () => {
    const pqcKeys = await pqcFixture();
    const priv = await openpgp.readPrivateKey({ armoredKey: pqcKeys.privateKey });
    expect(priv.keyPacket.version).toBe(6);
    expect(priv.keyPacket.algorithm).toBe(30); // ML-DSA + Ed25519, signing
    const subkeyAlgorithms = priv.getSubkeys().map(s => s.keyPacket.algorithm);
    expect(subkeyAlgorithms).toContain(35);    // ML-KEM + X25519, encryption
  }, PQC_TIMEOUT_MS);

  it('unlocks with a passphrase, the step that used to throw during PARSING', async () => {
    const pqcKeys = await pqcFixture();
    const unlocked = await openpgp.decryptKey({
      privateKey: await openpgp.readPrivateKey({ armoredKey: pqcKeys.privateKey }),
      passphrase: PASSPHRASE,
    });
    expect(unlocked.isDecrypted()).toBe(true);
  }, PQC_TIMEOUT_MS);

  it('encrypts, decrypts, signs and verifies', async () => {
    const pqcKeys = await pqcFixture();
    const priv = await openpgp.decryptKey({
      privateKey: await openpgp.readPrivateKey({ armoredKey: pqcKeys.privateKey }),
      passphrase: PASSPHRASE,
    });
    const pub = await openpgp.readKey({ armoredKey: pqcKeys.publicKey });

    const armored = await openpgp.encrypt({
      message: await openpgp.createMessage({ text: 'post-quantum round trip' }),
      encryptionKeys: pub,
      signingKeys: priv,
      format: 'armored',
    });
    const result = await openpgp.decrypt({
      message: await openpgp.readMessage({ armoredMessage: armored }),
      decryptionKeys: priv,
      verificationKeys: pub,
    });

    expect(result.data).toBe('post-quantum round trip');
    await expect(result.signatures[0].verified).resolves.not.toThrow();
  }, PQC_TIMEOUT_MS);

  it('routes by PKESK when a v4 and a v6 key share one ring', async () => {
    // The real shape of a post-quantum account: both key types held at once.
    // Encrypt to the v4 key alone, then decrypt with BOTH in the ring. The
    // library has to pick, and picking wrong is silent.
    const pqcKeys = await pqcFixture();
    const classic = await openpgp.generateKey({
      type: 'ecc', curve: 'curve25519',
      userIDs: [{ name: 'v4', email: 'v4@test.invalid' }],
      passphrase: PASSPHRASE, format: 'armored',
    });
    const classicPriv = await openpgp.decryptKey({
      privateKey: await openpgp.readPrivateKey({ armoredKey: classic.privateKey }),
      passphrase: PASSPHRASE,
    });
    const pqcPriv = await openpgp.decryptKey({
      privateKey: await openpgp.readPrivateKey({ armoredKey: pqcKeys.privateKey }),
      passphrase: PASSPHRASE,
    });

    const armored = await openpgp.encrypt({
      message: await openpgp.createMessage({ text: 'mixed ring' }),
      encryptionKeys: await openpgp.readKey({ armoredKey: classic.publicKey }),
      format: 'armored',
    });
    const result = await openpgp.decrypt({
      message: await openpgp.readMessage({ armoredMessage: armored }),
      decryptionKeys: [pqcPriv, classicPriv],
    });
    expect(result.data).toBe('mixed ring');
  }, 30000);
});

describe('pqc-detect agrees with the bundle', () => {
  it('marks exactly the ids the bundle implements as supported', () => {
    // Derive the truth from the bundle rather than restating it, so adding id
    // 31 upstream shows up here as a failure telling us to widen the set,
    // instead of silently classifying a readable key as unreadable.
    const inBundle = Object.entries(openpgp.enums.publicKey)
      .filter(([, id]) => typeof id === 'number' && ProtonPqc.isPqcAlgorithm(id))
      .map(([, id]) => id)
      .sort((a, b) => a - b);

    expect(inBundle).toEqual([30, 35]);
    expect([...ProtonPqc.SUPPORTED_PQC_ALGOS].sort((a, b) => a - b)).toEqual(inBundle);
  }, PQC_TIMEOUT_MS);

  it('still refuses the ids nobody implements', () => {
    // 31 and 36 are the larger parameter sets; 32 to 34 are SLH-DSA. Not in
    // the fork, not in upstream, not anywhere.
    for (const id of [31, 32, 33, 34, 36]) {
      expect(ProtonPqc.isSupportedAlgorithm(id)).toBe(false);
      expect(ProtonPqc.isPqcAlgorithm(id)).toBe(true);
    }
  });

  it('reads a REAL post-quantum key header, not one the tests built', async () => {
    // Every other pqc-detect test feeds the parser packets assembled by the
    // same understanding of the format that wrote the parser. A key straight
    // out of the library is an independent oracle for the offset arithmetic,
    // and a v6 PQC key is the one whose length field is large enough to use a
    // two-byte header, which is where getting it wrong shifts the algorithm
    // byte and misclassifies everything.
    const pqcKeys = await pqcFixture();
    expect(ProtonPqc.readKeyAlgorithm(pqcKeys.privateKey)).toEqual({ version: 6, algorithm: 30 });
    expect(ProtonPqc.readKeyAlgorithm(pqcKeys.publicKey)).toEqual({ version: 6, algorithm: 30 });
  });

  it('no longer calls a real post-quantum key unsupported', async () => {
    // The single assertion that inverts with this release.
    const pqcKeys = await pqcFixture();
    expect(ProtonPqc.isUnsupportedKey(pqcKeys.privateKey)).toBe(false);
    expect(ProtonPqc.isUnsupportedKey(pqcKeys.publicKey)).toBe(false);
  });

  it('lets a post-quantum account sign in, and still reports it as one', async () => {
    // Both user keys are flagged Primary on an opted-in account.
    const pqcKeys = await pqcFixture();
    const selection = ProtonPqc.selectUsableKey([
      { ID: 'v6', Primary: 1, PrivateKey: pqcKeys.privateKey },
      { ID: 'v4', Primary: 1, PrivateKey: pqcKeys.privateKey },
    ]);
    expect(selection.allUnsupported).toBe(false);
    expect(selection.skippedUnsupported).toBe(false);
    // hasPqc must stay true even though nothing was skipped: it means "this is
    // a post-quantum account", which is the fact the diagnostic exists to log.
    expect(selection.hasPqc).toBe(true);
    expect(selection.hasUnsupportedPqc).toBe(false);
  });
});
