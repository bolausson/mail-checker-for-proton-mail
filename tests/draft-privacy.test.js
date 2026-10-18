/**
 * Tests for the privacy-at-rest fixes:
 *  - ExtEncryption round-trips draft payloads (incl. an Encrypted-Outside
 *    password) and the ciphertext leaks no plaintext
 *  - ProtonPremium mirrors license state to storage.sync ONLY when the
 *    settings-sync toggle is enabled
 *  - ProtonPremium.init() treats local state as authoritative and reads
 *    sync only to recover on a fresh install
 *
 * encryption.js and premium.js are browser IIFEs, so we eval them with
 * stubbed globals (same pattern as error-handling.test.js).
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const read = (rel) => readFileSync(join(__dirname, '..', rel), 'utf-8');

function makeStorageArea(initial = {}) {
  const area = {
    data: { ...initial },
    setCalls: 0,
    async get(keys) {
      if (typeof keys === 'string') keys = [keys];
      const out = {};
      for (const k of keys) if (k in area.data) out[k] = area.data[k];
      return out;
    },
    async set(obj) { area.setCalls++; Object.assign(area.data, obj); },
    async remove(k) { delete area.data[k]; },
  };
  return area;
}

describe('draft encryption at rest (ExtEncryption)', () => {
  it('round-trips a draft with an EO password and leaks no plaintext', async () => {
    const local = makeStorageArea();
    globalThis.browser = { storage: { local } };
    globalThis.ProtonBinary = new Function(read('lib/binary-utils.js') + '\nreturn ProtonBinary;')();
    const ExtEncryption = new Function(read('background/encryption.js') + '\nreturn ExtEncryption;')();

    const draft = {
      type: 'reply',
      replyBody: '<p>quoted decrypted original message</p>',
      sendOptions: { expiresIn: 3600, eoPassword: 'hunter22secret', eoHint: 'the usual' },
    };
    const cipher = await ExtEncryption.encrypt(JSON.stringify(draft));

    expect(typeof cipher).toBe('string');
    expect(cipher).not.toContain('hunter22secret');
    expect(cipher).not.toContain('quoted decrypted');
    // Encryption key was created in storage (same-storage boundary, documented)
    expect(local.data._encKey).toBeDefined();

    const roundTrip = JSON.parse(await ExtEncryption.decrypt(cipher));
    expect(roundTrip).toEqual(draft);
  });
});

describe('license sync respects the settings-sync toggle', () => {
  function loadPremium({ localData = {}, syncData = {} } = {}) {
    const local = makeStorageArea(localData);
    const sync = makeStorageArea(syncData);
    globalThis.debugLog = () => {};
    globalThis.fetch = async () => { throw new Error('offline'); };
    globalThis.browser = {
      storage: { local, sync },
      alarms: { create: () => {}, clear: async () => {} },
      tabs: { create: async () => ({}) },
    };
    const ProtonPremium = new Function(read('background/premium.js') + '\nreturn ProtonPremium;')();
    return { ProtonPremium, local, sync };
  }

  it('does NOT write to storage.sync when the toggle is off', async () => {
    const { ProtonPremium, local, sync } = loadPremium();
    await ProtonPremium.init();
    const res = await ProtonPremium.startTrial();
    expect(res.success).toBe(true);
    expect(sync.setCalls).toBe(0);
    expect(Object.keys(sync.data)).toHaveLength(0);
    expect(Object.keys(local.data).length).toBeGreaterThan(0);
  });

  it('mirrors to storage.sync when the toggle is on', async () => {
    const { ProtonPremium, sync } = loadPremium({ localData: { syncEnabled: true } });
    await ProtonPremium.init();
    await ProtonPremium.startTrial();
    expect(sync.setCalls).toBeGreaterThan(0);
    expect(Object.keys(sync.data).length).toBeGreaterThan(0);
  });

  it('adopts a synced license on a fresh install and persists it locally', async () => {
    const { ProtonPremium, local } = loadPremium({ syncData: { _premiumKey: 'sub_01hxyzrecovered' } });
    await ProtonPremium.init();
    expect(ProtonPremium.getStatus().licenseKeyMasked).toContain('sub_01hx');
    // Adopted state is persisted: no dependence on sync reads afterwards
    expect(local.data._premiumKey).toBe('sub_01hxyzrecovered');
  });

  it('adopts a synced license even when a trial was used on this device', async () => {
    const { ProtonPremium } = loadPremium({
      localData: { _trialEnd: 123456 }, // long-expired trial
      syncData: { _premiumKey: 'sub_01hxadopted' },
    });
    await ProtonPremium.init();
    expect(ProtonPremium.getStatus().licenseKeyMasked).toContain('sub_01hx');
  });

  it('prefers local state over a stale synced copy', async () => {
    const { ProtonPremium } = loadPremium({
      localData: { _premiumKey: 'sub_01hlocalcurrent' },
      syncData: { _premiumKey: 'sub_01hstalesynced' },
    });
    await ProtonPremium.init();
    expect(ProtonPremium.getStatus().licenseKeyMasked).toContain('sub_01hl');
    expect(ProtonPremium.getStatus().licenseKeyMasked).not.toContain('stal');
  });

  it('does not resurrect a removed license from stale sync data (local tombstone)', async () => {
    const { ProtonPremium } = loadPremium({
      localData: { _licCleared: 1700000000000 },
      syncData: { _premiumKey: 'sub_01hstaleremoved' },
    });
    await ProtonPremium.init();
    expect(ProtonPremium.getStatus().licensed).toBe(false);
    expect(ProtonPremium.getStatus().licenseKeyMasked).toBe(null);
  });

  it('honours a removal tombstone arriving via sync from another device', async () => {
    const { ProtonPremium } = loadPremium({
      syncData: { _premiumKey: 'sub_01hremovedaway', _licCleared: 1700000000000 },
    });
    await ProtonPremium.init();
    expect(ProtonPremium.getStatus().licenseKeyMasked).toBe(null);
  });

  it('sets the tombstone on license removal so it cannot come back', async () => {
    const { ProtonPremium, local } = loadPremium({
      localData: { _premiumKey: 'sub_01hactivenow' },
    });
    await ProtonPremium.init();
    await ProtonPremium.removeLicenseKey();
    expect(local.data._licCleared).toBeGreaterThan(0);
    expect(ProtonPremium.getStatus().licenseKeyMasked).toBe(null);
  });
});
