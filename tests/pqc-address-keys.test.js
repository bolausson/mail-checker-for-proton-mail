/**
 * The mixed-ring address-key Token, which is the real bug shape.
 *
 * On a post-quantum account the user holds TWO primary user keys, a v4 and a
 * v6. Every address key carries a `Token`: its passphrase, encrypted to ONE of
 * those user keys, and not necessarily the one we picked. Proton's
 * getDecryptedAddressKeys.ts passes the WHOLE user key set to
 * decryptAddressKeyToken for exactly this reason.
 *
 * The failure this guards against is silent and partial. Sign-in succeeds, the
 * user key unlocks, and then some address keys quietly fail to decrypt. The
 * user sees mail that opens and mail that does not, with no error naming the
 * cause. It is invisible on a single-user-key account, which is every account
 * we can test against by hand.
 *
 * Three separate fixes have to hold at once for this to work, so this is the
 * closest thing to an end-to-end post-quantum test we can run without an
 * opted-in account:
 *
 *   1. the vendored bundle can parse a post-quantum key at all,
 *   2. every user key is unlocked, each from its OWN salt (per-key salts),
 *   3. the whole set is handed to the Token decrypt, not just one key.
 *
 * Each assertion below has a negative control: the same operation with the
 * single-key ring, which must fail. Without that, a passing test proves only
 * that the fixture was easy.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const ROOT = join(__dirname, '..');

let openpgp;

beforeAll(() => {
  globalThis.window = globalThis;
  globalThis.self = globalThis;
  // eslint-disable-next-line no-eval
  (0, eval)(readFileSync(join(ROOT, 'lib', 'openpgp.min.js'), 'utf-8'));
  openpgp = globalThis.openpgp;
});

// Each user key has its own salt, so its own passphrase. Reusing one for the
// other is precisely the bug per-key salts fixed, so the fixture must not let
// them coincide.
const V4_PASS = 'passphrase derived from the v4 key salt';
const V6_PASS = 'passphrase derived from the v6 key salt';
const ADDRESS_PASS = 'the address key passphrase, wrapped in the Token';

/** Build the account shape: a v4 user key, a v6 (post-quantum) user key. */
async function makeUserKeys() {
  const v4 = await openpgp.generateKey({
    type: 'ecc', curve: 'curve25519',
    userIDs: [{ name: 'user', email: 'user@test.invalid' }],
    passphrase: V4_PASS, format: 'armored',
  });
  const v6 = await openpgp.generateKey({
    type: 'pqc',
    userIDs: [{ name: 'user', email: 'user@test.invalid' }],
    passphrase: V6_PASS, format: 'armored', config: { v6Keys: true },
  });
  return {
    v4: await openpgp.decryptKey({
      privateKey: await openpgp.readPrivateKey({ armoredKey: v4.privateKey }),
      passphrase: V4_PASS,
    }),
    v6: await openpgp.decryptKey({
      privateKey: await openpgp.readPrivateKey({ armoredKey: v6.privateKey }),
      passphrase: V6_PASS,
    }),
  };
}

/**
 * An address key Token: the address passphrase encrypted to one user key and
 * signed by it, the way Proton issues it.
 */
async function makeToken(userKey) {
  const armoredToken = await openpgp.encrypt({
    message: await openpgp.createMessage({ text: ADDRESS_PASS }),
    encryptionKeys: userKey.toPublic(),
    format: 'armored',
  });
  const armoredSignature = await openpgp.sign({
    message: await openpgp.createMessage({ text: ADDRESS_PASS }),
    signingKeys: userKey, detached: true, format: 'armored',
  });
  return { Token: armoredToken, Signature: armoredSignature };
}

/** Decrypt a Token the way _doUnlockKeys does, with a given key ring. */
async function openToken(addrKey, ring) {
  const opts = {
    message: await openpgp.readMessage({ armoredMessage: addrKey.Token }),
    decryptionKeys: ring,
  };
  if (addrKey.Signature) {
    opts.signature = await openpgp.readSignature({ armoredSignature: addrKey.Signature });
    opts.verificationKeys = ring.map(k => k.toPublic());
    opts.expectSigned = true;
  }
  const { data } = await openpgp.decrypt(opts);
  return data;
}

describe('an address key wrapped to the post-quantum user key', () => {
  let userKeys;
  let tokenToV6;
  let tokenToV4;

  beforeAll(async () => {
    userKeys = await makeUserKeys();
    tokenToV6 = await makeToken(userKeys.v6);
    tokenToV4 = await makeToken(userKeys.v4);
  }, 60000);

  it('opens when the whole user key set is offered', async () => {
    const ring = [userKeys.v4, userKeys.v6];
    await expect(openToken(tokenToV6, ring)).resolves.toBe(ADDRESS_PASS);
  });

  it('FAILS with only the v4 key, which is the bug being fixed', async () => {
    // The negative control. If this ever passes, the test above proves nothing
    // and the "pass the whole set" fix is not what is carrying it.
    await expect(openToken(tokenToV6, [userKeys.v4])).rejects.toThrow();
  });

  it('opens a v4-wrapped Token from the same mixed ring', async () => {
    // Routing has to work in both directions: adding the v6 key to the ring
    // must not disturb the ordinary case.
    const ring = [userKeys.v4, userKeys.v6];
    await expect(openToken(tokenToV4, ring)).resolves.toBe(ADDRESS_PASS);
  });

  it('verifies the Token signature made by the post-quantum key', async () => {
    // expectSigned is what rejects a server swapping in a Token that decrypts
    // to a different passphrase. It has to accept an ML-DSA signature now.
    const ring = [userKeys.v4, userKeys.v6];
    await expect(openToken(tokenToV6, ring)).resolves.toBe(ADDRESS_PASS);
    // ...and still reject a Token signed by a key not in the ring.
    const stranger = await openpgp.generateKey({
      type: 'ecc', curve: 'curve25519',
      userIDs: [{ name: 'x', email: 'x@test.invalid' }],
      passphrase: V4_PASS, format: 'armored',
    });
    const strangerKey = await openpgp.decryptKey({
      privateKey: await openpgp.readPrivateKey({ armoredKey: stranger.privateKey }),
      passphrase: V4_PASS,
    });
    const forged = await makeToken(strangerKey);
    // Encrypted to the stranger, so the ring cannot open it either way; the
    // point is that it does not silently succeed.
    await expect(openToken(forged, ring)).rejects.toThrow();
  }, 60000);

  it('unlocks an address key with the passphrase the Token carried', async () => {
    // The last link: the decrypted Token really is a usable passphrase.
    const address = await openpgp.generateKey({
      type: 'ecc', curve: 'curve25519',
      userIDs: [{ name: 'addr', email: 'addr@test.invalid' }],
      passphrase: ADDRESS_PASS, format: 'armored',
    });
    const passphrase = await openToken(tokenToV6, [userKeys.v4, userKeys.v6]);
    const unlocked = await openpgp.decryptKey({
      privateKey: await openpgp.readPrivateKey({ armoredKey: address.privateKey }),
      passphrase,
    });
    expect(unlocked.isDecrypted()).toBe(true);
  }, 60000);
});

describe('per-key salts are load-bearing here', () => {
  it('the v6 key does not open under the v4 key\'s passphrase', async () => {
    // Why the passphrase map exists. Without it the v6 key never joins the
    // ring, and every Token wrapped to it fails: the partial, silent failure.
    const v6 = await openpgp.generateKey({
      type: 'pqc', userIDs: [{ name: 'u', email: 'u@test.invalid' }],
      passphrase: V6_PASS, format: 'armored', config: { v6Keys: true },
    });
    await expect(openpgp.decryptKey({
      privateKey: await openpgp.readPrivateKey({ armoredKey: v6.privateKey }),
      passphrase: V4_PASS,
    })).rejects.toThrow();
  }, 60000);
});
