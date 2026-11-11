/**
 * Sending as a +alias, background side (background/accounts.js).
 *
 * The sender the popup chose is resolved against the account's addresses
 * (lib/sender-alias.js): an own address is itself, a +alias of one goes out
 * as the alias with the base address's ID and keys, and anything else is
 * refused instead of being sent from the default address the user did not
 * choose. A new mail now takes a sender too and states its AddressID, as
 * replies always did.
 *
 * House style: the functions under test are lifted out of accounts.js by
 * name and run with their dependencies injected.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const ROOT = join(__dirname, '..');
const ACCOUNTS = readFileSync(join(ROOT, 'background', 'accounts.js'), 'utf-8');
const ProtonSenderAlias = new Function(readFileSync(join(ROOT, 'lib', 'sender-alias.js'), 'utf-8') + '\nreturn ProtonSenderAlias;')();

function lift(name) {
  const m = new RegExp('(async )?function ' + name + '\\(').exec(ACCOUNTS);
  if (!m) throw new Error('function not found in accounts.js: ' + name);
  let depth = 0;
  for (let i = ACCOUNTS.indexOf('{', m.index); i < ACCOUNTS.length; i++) {
    if (ACCOUNTS[i] === '{') depth++;
    else if (ACCOUNTS[i] === '}') { depth--; if (depth === 0) return ACCOUNTS.slice(m.index, i + 1); }
  }
  throw new Error('unbalanced braces reading ' + name);
}

function sandbox(names, env) {
  const keys = Object.keys(env);
  const src = 'const { ' + keys.join(', ') + ' } = __env;\n' + names.map(lift).join('\n\n')
    + '\nreturn { ' + names.join(', ') + ' };';
  return new Function('__env', src)(env);
}

// Proton's own Address fields, as core/v4/addresses returns them.
const address = (ID, Email, more = {}) => ({
  ID, Email, DisplayName: 'Me ' + ID, Status: 1, Send: 1, Receive: 1, Type: 1,
  Keys: [{ ID: 'key-' + ID, Primary: 1, Active: 1, PublicKey: 'pub-' + Email.toLowerCase() }],
  ...more,
});
const MAIN = address('main', 'Name@example.com');
const SECOND = address('second', 'second@example.org');
const NO_RECEIVE = address('noreceive', 'quiet@example.org', { Receive: 0 });

// A private key per own address; its fingerprint is the address it belongs to.
const keyFor = (email) => ({
  getKeyID: () => ({ toHex: () => 'k' + email }),
  getFingerprint: () => 'fp-' + email,
  toPublic: () => ({ pub: email }),
});

function resolver(addresses = [MAIN, SECOND, NO_RECEIVE]) {
  const diag = {};
  const account = {
    addressKeyMap: Object.fromEntries(addresses.map((a) => [a.Email.toLowerCase(), keyFor(a.Email.toLowerCase())])),
    decryptedKeys: [keyFor('first-key')],
  };
  const { _resolveSenderInfo, _detectPlusAlias } = sandbox(['_resolveSenderInfo', '_detectPlusAlias'], {
    request: async () => ({ Addresses: addresses }),
    ProtonSenderAlias,
    // The public key a Keys entry holds reads back with its address's fingerprint.
    openpgp: { readKey: async ({ armoredKey }) => ({ getFingerprint: () => 'fp-' + armoredKey.slice(4) }) },
    _lastSenderResolution: diag,
  });
  return { resolve: (sender, original) => _resolveSenderInfo('acc', account, sender, original), diag, _detectPlusAlias };
}

describe('the sender a reply, forward or new mail goes out from', () => {
  it('an own address is sent from as itself', async () => {
    const { resolve } = resolver();
    const r = await resolve('SECOND@example.org');
    expect(r.fromAddr.ID).toBe('second');
    expect(r.fromAddr.Email).toBe('second@example.org');
    expect(r.senderPubKey).toEqual({ pub: 'second@example.org' });
  });

  it('a +alias never used before goes out as the alias, with the base address\'s ID and key', async () => {
    const { resolve, diag } = resolver();
    const r = await resolve('name+newshop@example.com');
    expect(r.fromAddr.Email).toBe('Name+newshop@example.com');
    expect(r.fromAddr.ID).toBe('main');
    expect(r.fromAddr.DisplayName).toBe('Me main');
    expect(r.senderPubKey).toEqual({ pub: 'name@example.com' });
    // The log checks the key against the base's keys and does not name the tag.
    expect(diag.acc.keySrc).toBe('aliasBase');
    expect(diag.acc.keyMatchesAddr).toBe('primary');
    expect(diag.acc.from).toBe('Name+<7>@example.com');
  });

  it('refuses an address that is not the account\'s, rather than sending from the default one', async () => {
    const { resolve } = resolver();
    await expect(resolve('someone@example.net')).rejects.toThrow('SENDER_NOT_OWNED');
    await expect(resolve('someone+tag@example.com')).rejects.toThrow('SENDER_NOT_OWNED');
  });

  it('refuses a +alias of an address that does not receive mail', async () => {
    const { resolve } = resolver();
    await expect(resolve('quiet+tag@example.org')).rejects.toThrow('SENDER_NOT_OWNED');
  });

  it('without a choice, replies from the +alias the X-Original-To header names', async () => {
    const { resolve } = resolver();
    const original = { ParsedHeaders: { 'X-Original-To': 'name+list@example.com' }, ToList: [{ Address: 'list@example.net' }] };
    const r = await resolve('', original);
    expect(r.fromAddr).toEqual({ Email: 'Name+list@example.com', DisplayName: 'Me main', ID: 'main' });
  });

  it('without a choice or an alias, sends from the default address', async () => {
    const { resolve } = resolver();
    const r = await resolve('', { ToList: [{ Address: 'second@example.org' }] });
    expect(r.fromAddr.ID).toBe('main');
  });
});

describe('the addresses the popup is given', () => {
  it('say which can carry a +alias', async () => {
    const { getAddresses } = sandbox(['getAddresses'], {
      request: async () => ({ Addresses: [MAIN, NO_RECEIVE, address('ext', 'me@example.net', { Type: 5 }), address('off', 'off@example.com', { Status: 0 })] }),
      ProtonSenderAlias,
    });
    const list = await getAddresses('acc');
    expect(list.map((a) => [a.Email, a.CanAlias])).toEqual([
      ['Name@example.com', true],
      ['quiet@example.org', false],
      ['me@example.net', false],
    ]);
  });
});

describe('a new mail', () => {
  function sender() {
    const calls = { resolve: [], sent: [] };
    const { sendNewMessage } = sandbox(['sendNewMessage'], {
      ensureKeysUnlocked: async () => {},
      getAccount: () => ({ keysUnlocked: true, decryptedKeys: [{}] }),
      _escapeHtml: (s) => s,
      _resolveSenderInfo: async (accountId, account, senderAddress) => {
        calls.resolve.push(senderAddress);
        return {
          fromAddr: senderAddress
            ? { ID: 'main', Email: 'Name+shop@example.com', DisplayName: 'Me' }
            : { ID: 'main', Email: 'Name@example.com', DisplayName: 'Me' },
          senderPrivKey: {},
          senderPubKey: {},
        };
      },
      _encryptAndSend: async (accountId, account, payload) => { calls.sent.push(payload.Message); },
      debugLog: () => {},
    });
    return { sendNewMessage, calls };
  }
  const to = [{ address: 'friend@example.net', name: '' }];

  it('goes out from the address chosen in Compose, a +alias included, with its AddressID', async () => {
    const { sendNewMessage, calls } = sender();
    await sendNewMessage('acc', { to, subject: 's', body: 'b', senderAddress: 'name+shop@example.com' });
    expect(calls.resolve).toEqual(['name+shop@example.com']);
    expect(calls.sent[0].AddressID).toBe('main');
    expect(calls.sent[0].Sender).toEqual({ Address: 'Name+shop@example.com', Name: 'Me' });
  });

  it('without a choice, from the account\'s default address, as before', async () => {
    const { sendNewMessage, calls } = sender();
    await sendNewMessage('acc', { to, subject: 's', body: 'b' });
    expect(calls.resolve).toEqual(['']);
    expect(calls.sent[0].Sender.Address).toBe('Name@example.com');
  });
});

describe('the calendar reply log', () => {
  it('keeps only the tag\'s length for an invitation sent to a +alias', () => {
    expect(ACCOUNTS).toMatch(/attendeeEmail: ProtonSenderAlias\.forLog\(wantEmail\)/);
  });
});
