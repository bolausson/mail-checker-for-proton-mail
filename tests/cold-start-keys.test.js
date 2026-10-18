/**
 * Cold start: the three handlers that judged account.keysUnlocked before
 * waiting for the unlock.
 *
 * MV3 tears the background down after about 30 s idle. On the next wake
 * background.js flips _initDone BEFORE ProtonAccounts.initSlow() has finished
 * unlocking the keys, so for a short window every account reads
 * keysUnlocked === false while the unlock is still in flight. sendReply,
 * forwardMessage and sendNewMessage already await ensureKeysUnlocked() first.
 * These three did not, and each failed for a user who acted in that window:
 *
 *  1. accounts.js sendCalendarRsvp threw 'Keys not unlocked', so clicking Yes
 *     on an invite right after a wake failed outright.
 *  2. accounts.js addToCalendar threw the same way.
 *  3. background.js _fetchAndDecryptAttachment skipped the decrypt and handed
 *     back PGP ciphertext with decrypted: false, bytes a caller could save
 *     under the attachment's real filename.
 *
 * Nothing in tests/ covered any of them, which is why all three shipped.
 *
 * The fake unlock below resolves on a real await tick and flips keysUnlocked
 * only when it resolves, so a handler that reads the flag before awaiting
 * still sees false. A test that only inspected the end state would pass
 * against the old code. The log records what every read of the account saw,
 * which is what makes the ordering, not just the outcome, assertable.
 *
 * The functions are lifted out of the real sources and run with injected
 * dependencies (same pattern as monitored-ids.test.js and key-freshness.test.js).
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const ROOT = join(__dirname, '..');
const ACCOUNTS = readFileSync(join(ROOT, 'background', 'accounts.js'), 'utf-8');
const BACKGROUND = readFileSync(join(ROOT, 'background', 'background.js'), 'utf-8');

// Lift a top-level function out of a source file, keeping `async`.
function lift(src, name) {
  let start = src.indexOf('function ' + name + '(');
  if (start === -1) throw new Error('not found: ' + name);
  if (src.slice(start - 6, start) === 'async ') start -= 6;
  let i = src.indexOf('{', src.indexOf(')', start));
  let depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) return src.slice(start, i + 1); }
  }
  throw new Error('unbalanced braces reading ' + name);
}

// Lift a `name: async (...) => { ... }` member of an object literal and
// re-bind it as a const. addToCalendar is exported that way, not as a
// top-level declaration, so lift() above cannot see it.
function liftArrowProp(src, name) {
  const at = src.indexOf(name + ': async (');
  if (at === -1) throw new Error('not found: ' + name);
  let i = src.indexOf('{', src.indexOf('=>', at));
  let depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth--;
      if (depth === 0) {
        return 'const ' + name + ' = ' + src.slice(at + name.length + 2, i + 1) + ';';
      }
    }
  }
  throw new Error('unbalanced braces reading ' + name);
}

const FAKE_KEY = { id: 'key1', toPublic: () => ({ id: 'key1pub' }) };
const CIPHERTEXT = new Uint8Array([0xc1, 0x0e, 0x03, 0x1f, 0x9a, 0x42]); // PGP packet-ish
const PLAINTEXT = new TextEncoder().encode('%PDF-1.7 payroll');

const bytes = u8 => Array.from(u8);

/**
 * One account plus the log of what each reader saw.
 * canUnlock=false is the genuinely-unrecoverable case: a session whose keys
 * cannot be unlocked at all (no key password, or the unlock kept failing).
 */
function makeWorld({ canUnlock = true } = {}) {
  const world = {
    log: [],
    sent: [],
    created: [],
    account: {
      id: 'acc1',
      email: 'alex@example.com',
      keysUnlocked: false,     // as it reads right after a wake
      decryptedKeys: [],
      addressKeyMap: {},
    },
  };
  world.getAccount = () => {
    world.log.push('getAccount:keysUnlocked=' + world.account.keysUnlocked);
    return world.account;
  };
  // The real ensureKeysUnlocked awaits a network round trip and only then
  // populates decryptedKeys. Resolving on a tick is what makes the ordering
  // observable: a caller that checks the flag first still sees false.
  world.ensureKeysUnlocked = async () => {
    world.log.push('unlock:start');
    await new Promise(resolve => setTimeout(resolve, 0));
    if (canUnlock) {
      world.account.keysUnlocked = true;
      world.account.decryptedKeys = [FAKE_KEY];
      world.account.addressKeyMap = { 'alex@example.com': FAKE_KEY };
    }
    world.log.push(canUnlock ? 'unlock:done' : 'unlock:failed');
    return canUnlock;
  };
  return world;
}

function buildSendCalendarRsvp(world, src = ACCOUNTS) {
  const body = lift(src, 'sendCalendarRsvp') + '\nreturn sendCalendarRsvp;';
  const factory = new Function('ensureKeysUnlocked', 'getAccount', '_resolveSenderInfo',
    '_encryptAndSend', '_updateCalendarAttendeeStatus', 'ProtonBinary', 'debugLog', body);
  return factory(
    world.ensureKeysUnlocked,
    world.getAccount,
    async () => ({
      fromAddr: { ID: 'addr1', Email: 'alex@example.com', DisplayName: 'Alex' },
      senderPrivKey: FAKE_KEY,
      senderPubKey: FAKE_KEY,
      defaultAddr: { ID: 'addr1', DisplayName: 'Alex' },
    }),
    async (accountId, account, payload, toList, htmlBody, priv, pub, attachments) => {
      world.log.push('send:keysUnlocked=' + account.keysUnlocked);
      world.sent.push({ payload, toList, attachments });
    },
    async () => { world.log.push('calendarStatus'); },
    { uint8ToBase64: () => 'QkVHSU46VkNBTEVOREFS' },
    () => {},
  );
}

function buildAddToCalendar(world, src = ACCOUNTS) {
  const body = liftArrowProp(src, 'addToCalendar') + '\nreturn addToCalendar;';
  const factory = new Function('ProtonCalendarICS', 'ensureKeysUnlocked', 'getAccount',
    'request', '_findAddressIdForEmail', '_getCalendarKeys', 'ProtonCalendarSerialize',
    'ProtonCalendarAPI', body);
  return factory(
    { parse: () => ({ uid: 'evt-1', summary: 'Lunch' }) },
    world.ensureKeysUnlocked,
    world.getAccount,
    async () => ({ Members: [{ ID: 'mem1', Email: 'Alex@example.com' }] }),
    async () => 'addr1',
    // Mirrors the real helper, which returns [] while the keys are locked, so
    // the test cannot pass by accident further down the chain.
    async () => (world.account.keysUnlocked ? [FAKE_KEY] : []),
    { buildPayload: async () => ({ SharedEventContent: [] }) },
    {
      createEvent: async () => {
        world.log.push('create:keysUnlocked=' + world.account.keysUnlocked);
        world.created.push('evt-1');
        return { ID: 'srv-evt-1' };
      },
    },
  );
}

function buildFetchAttachment(world, src = BACKGROUND) {
  const body = lift(src, '_fetchAndDecryptAttachment') + '\nreturn _fetchAndDecryptAttachment;';
  return new Function('ProtonAccounts', body)({
    getAccount: world.getAccount,
    getAttachment: async () => { world.log.push('getAttachment'); return CIPHERTEXT; },
    ensureKeysUnlocked: world.ensureKeysUnlocked,
    decryptAttachment: async () => {
      world.log.push('decrypt:keysUnlocked=' + world.account.keysUnlocked);
      if (!world.account.keysUnlocked) throw new Error('Keys not unlocked');
      return PLAINTEXT;
    },
  });
}

const rsvpArgs = ['acc1', 'organizer@example.com', 'Accepted: Lunch', '<p>Yes</p>',
  'BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n', 'alex@example.com'];

describe('sendCalendarRsvp on a worker that just woke', () => {
  it('waits for the in-flight unlock instead of refusing the RSVP', async () => {
    const world = makeWorld();
    const sendCalendarRsvp = buildSendCalendarRsvp(world);

    const result = await sendCalendarRsvp(...rsvpArgs);

    expect(result).toEqual({ success: true });
    expect(world.sent).toHaveLength(1);
    // The unlock is awaited BEFORE anything reads the flag: no reader ever
    // saw false, and the send ran with a genuinely unlocked account.
    expect(world.log[0]).toBe('unlock:start');
    expect(world.log).not.toContain('getAccount:keysUnlocked=false');
    expect(world.log.indexOf('unlock:done'))
      .toBeLessThan(world.log.indexOf('getAccount:keysUnlocked=true'));
    expect(world.log).toContain('send:keysUnlocked=true');
  });

  it('still refuses when the unlock genuinely cannot succeed', async () => {
    const world = makeWorld({ canUnlock: false });
    const sendCalendarRsvp = buildSendCalendarRsvp(world);

    await expect(sendCalendarRsvp(...rsvpArgs)).rejects.toThrow('Keys not unlocked');
    // It tried, and it did not send anything with a locked key set.
    expect(world.log).toContain('unlock:failed');
    expect(world.sent).toHaveLength(0);
  });
});

describe('addToCalendar on a worker that just woke', () => {
  it('waits for the in-flight unlock instead of refusing the event', async () => {
    const world = makeWorld();
    const addToCalendar = buildAddToCalendar(world);

    const result = await addToCalendar('acc1', 'cal1', 'BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n');

    expect(result.success).toBe(true);
    expect(world.created).toEqual(['evt-1']);
    expect(world.log).not.toContain('getAccount:keysUnlocked=false');
    expect(world.log.indexOf('unlock:done'))
      .toBeLessThan(world.log.indexOf('getAccount:keysUnlocked=true'));
    expect(world.log).toContain('create:keysUnlocked=true');
  });

  it('still refuses when the unlock genuinely cannot succeed', async () => {
    const world = makeWorld({ canUnlock: false });
    const addToCalendar = buildAddToCalendar(world);

    await expect(addToCalendar('acc1', 'cal1', 'BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n'))
      .rejects.toThrow('Keys not unlocked');
    expect(world.log).toContain('unlock:failed');
    expect(world.created).toHaveLength(0);
  });
});

describe('_fetchAndDecryptAttachment on a worker that just woke', () => {
  const message = { accountId: 'acc1', attachmentId: 'att1', keyPackets: 'wcBMA0aYest' };

  it('waits for the unlock and returns the decrypted bytes', async () => {
    const world = makeWorld();
    const fetchAttachment = buildFetchAttachment(world);

    const result = await fetchAttachment(message);

    expect(result.decrypted).toBe(true);
    expect(bytes(result.bytes)).toEqual(bytes(PLAINTEXT));
    // The decrypt ran after the unlock resolved, never against a locked set.
    expect(world.log.indexOf('unlock:done'))
      .toBeLessThan(world.log.indexOf('decrypt:keysUnlocked=true'));
    expect(world.log).not.toContain('decrypt:keysUnlocked=false');
    // And the account was re-read afterwards: the object captured before the
    // unlock would still have reported keysUnlocked false.
    expect(world.log.slice(world.log.indexOf('unlock:done')))
      .toContain('getAccount:keysUnlocked=true');
  });

  it('reports decrypted: false rather than passing ciphertext off as plaintext', async () => {
    const world = makeWorld({ canUnlock: false });
    const fetchAttachment = buildFetchAttachment(world);

    const result = await fetchAttachment(message);

    // CONTRACT A: decrypted === false means the bytes are STILL ciphertext.
    // Claiming true here would have a caller save PGP bytes under the real
    // filename, which is worse than the failure it is hiding.
    expect(result.decrypted).toBe(false);
    expect(bytes(result.bytes)).toEqual(bytes(CIPHERTEXT));
    expect(bytes(result.bytes)).not.toEqual(bytes(PLAINTEXT));
    expect(world.log).toContain('unlock:failed');
  });

  it('does not wake the keys for an attachment with no key packets', async () => {
    const world = makeWorld();
    const fetchAttachment = buildFetchAttachment(world);

    const result = await fetchAttachment({ accountId: 'acc1', attachmentId: 'att1' });

    // Nothing to decrypt, so nothing to wait for: the bytes are already plain
    // and decrypted stays false because no key packets were supplied.
    expect(world.log).not.toContain('unlock:start');
    expect(result.decrypted).toBe(false);
    expect(bytes(result.bytes)).toEqual(bytes(CIPHERTEXT));
  });
});
