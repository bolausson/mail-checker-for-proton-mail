/**
 * The Drive routes "Share via Proton Drive" calls, pinned call by call.
 *
 * Proton marked the share-scoped Drive node routes @deprecated on 2026-01-14
 * and is deleting their last web callers; the Drive SDK, which the Drive web
 * app now uploads and shares through, uses only the volume-scoped drive/v2
 * routes. These tests pin the exact method, path and payload keys of every
 * request background/drive.js makes, in order, so a regression to an old route
 * or a stray deprecated field fails here instead of in production the day
 * Proton removes the route.
 *
 * Nothing talks to a server. ProtonAccounts.request is a recorder that answers
 * from a route table, with bodies shaped like the SDK's OpenAPI types
 * (client/js/src/internal/apiService/driveTypes.ts at js/v0.22.2), and the
 * storage upload (fetch) is a stub. The crypto is real: the vendored openpgp
 * runs, the keys in the mock responses are genuine, and the tests decrypt what
 * drive.js sent. A response read from the wrong field therefore fails to
 * unlock rather than passing quietly.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { createHash, createHmac, randomBytes } from 'crypto';
import { readFileSync } from 'fs';
import { join } from 'path';

const ROOT = join(__dirname, '..');
const DRIVE_SRC = readFileSync(join(ROOT, 'background', 'drive.js'), 'utf-8');

const ACCOUNT_ID = 'acc-1';
const EMAIL = 'me@test.invalid';
const ADDRESS_ID = 'addr-1';
const VOLUME_ID = 'vol-1';
const SHARE_ID = 'share-main';
const ROOT_LINK_ID = 'link-root';
const FOLDER_NAME = 'mcpm-shared-files';
const CHUNK = 4 * 1024 * 1024;
const DAY = 24 * 3600;

let openpgp;
let ProtonBinary;
let fx; // fixture: real keys and the responses built from them

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

const b64 = (u8) => Buffer.from(u8).toString('base64');
const fromB64 = (s) => new Uint8Array(Buffer.from(s, 'base64'));
const hmacHex = (keyBytes, name) =>
  createHmac('sha256', Buffer.from(keyBytes)).update(name, 'utf8').digest('hex');
const sha256 = (u8) => new Uint8Array(createHash('sha256').update(u8).digest());
const keysOf = (obj) => Object.keys(obj).sort();
const routesOf = (calls) => calls.map((c) => `${c.method} ${c.path}`);
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

/** The error shape accounts.js _rawRequest throws for a non-2xx answer. */
function apiError(status, code, details, message) {
  const err = new Error(message || `HTTP ${status}`);
  err.status = status;
  err.code = code;
  err.details = details;
  return err;
}

/** No request may use a route the SDK has left behind. */
function expectNoLegacyRoutes(calls) {
  const legacy = calls.filter((c) =>
    /^drive\/shares\/[^/]+\/(files|folders|links)(\/|$)/.test(c.path) ||
    (c.method === 'GET' && /^drive\/(volumes|shares)(\/[^/]+)?$/.test(c.path)) ||
    /trash_multiple/.test(c.path));
  expect(legacy).toEqual([]);
}

async function decryptText(armoredMessage, decryptionKeys, format) {
  const { data } = await openpgp.decrypt({
    message: await openpgp.readMessage({ armoredMessage }),
    decryptionKeys,
    format: format || 'utf8',
  });
  return data;
}

async function unlock(armoredKey, passphrase) {
  return openpgp.decryptKey({
    privateKey: await openpgp.readPrivateKey({ armoredKey }),
    passphrase,
  });
}

// ---------------------------------------------------------------------------
// Fixture: a real address key, main share, root folder and one child folder
// ---------------------------------------------------------------------------

/** A Drive node key locked with a random passphrase, encrypted to `encryptTo`. */
async function makeNode(encryptTo, signer) {
  const passphrase = b64(randomBytes(32));
  const { privateKey } = await openpgp.generateKey({
    type: 'ecc', curve: 'ed25519Legacy', userIDs: [{ name: 'Drive key' }], format: 'object',
  });
  const locked = await openpgp.encryptKey({ privateKey, passphrase });
  const armoredPassphrase = await openpgp.encrypt({
    message: await openpgp.createMessage({ text: passphrase }),
    encryptionKeys: encryptTo,
  });
  const armoredSignature = await openpgp.sign({
    message: await openpgp.createMessage({ text: passphrase }),
    signingKeys: signer, detached: true,
  });
  return { key: privateKey, armoredKey: locked.armor(), armoredPassphrase, armoredSignature };
}

/** A folder hash key: random passphrase text, encrypted and signed by the folder key. */
async function makeHashKey(folderKey) {
  const text = b64(randomBytes(32));
  const armored = await openpgp.encrypt({
    message: await openpgp.createMessage({ text }),
    encryptionKeys: folderKey.toPublic(),
    signingKeys: folderKey,
  });
  return { armored, bytes: new TextEncoder().encode(text) };
}

/** LinkDto with every field the spec lists. */
function linkDto(o) {
  return {
    LinkID: o.LinkID,
    Type: o.Type,
    ParentLinkID: o.ParentLinkID === undefined ? ROOT_LINK_ID : o.ParentLinkID,
    State: o.State,
    CreateTime: 1700000000,
    ModifyTime: 1700000000,
    TrashTime: o.State === 2 ? 1700000500 : null,
    Name: '-----BEGIN PGP MESSAGE-----\n\nnot read by these tests\n-----END PGP MESSAGE-----',
    NameHash: o.NameHash === undefined ? null : o.NameHash,
    NodeKey: o.NodeKey || 'unused',
    NodePassphrase: o.NodePassphrase || 'unused',
    NodePassphraseSignature: o.NodePassphraseSignature || 'unused',
    SignatureEmail: EMAIL,
    NameSignatureEmail: EMAIL,
    OwnedBy: { Email: EMAIL, Organization: null },
    DirectPermissions: null,
    ThirdParty: false,
    Sdk: true,
  };
}

/** FolderDetailsDto (an entry of LoadLinkDetailsResponseDto.Links). */
function folderDetails(linkFields, node, hashKey) {
  return {
    Link: linkDto({
      Type: 1, State: 1,
      NodeKey: node && node.armoredKey,
      NodePassphrase: node && node.armoredPassphrase,
      NodePassphraseSignature: node && node.armoredSignature,
      ...linkFields,
    }),
    Folder: { NodeHashKey: hashKey ? hashKey.armored : null, XAttr: null, IsImported: false },
    Sharing: null, Membership: null, File: null, Album: null,
  };
}

/** FileDetailsDto: a FILE holding a name. */
function fileDetails(linkFields) {
  return {
    Link: linkDto({ Type: 2, State: 1, ...linkFields }),
    File: {
      ActiveRevision: null, TotalEncryptedSize: 0, ContentKeyPacket: '',
      MediaType: 'text/plain', ContentKeyPacketSignature: null,
    },
    Sharing: null, Membership: null, Folder: null, Album: null,
  };
}

async function makeFixture() {
  const { privateKey: addressKey } = await openpgp.generateKey({
    type: 'ecc', curve: 'ed25519Legacy', userIDs: [{ name: 'me', email: EMAIL }], format: 'object',
  });
  const addressKeyArmored = (await openpgp.encryptKey({
    privateKey: addressKey, passphrase: 'address key passphrase',
  })).armor();

  const share = await makeNode([addressKey.toPublic()], addressKey);
  const root = await makeNode([share.key.toPublic()], addressKey);
  const rootHash = await makeHashKey(root.key);
  // An existing "mcpm-shared-files" folder for the reuse tests.
  const child = await makeNode([root.key.toPublic()], addressKey);
  const childHash = await makeHashKey(child.key);

  return {
    addressKey,
    account: { decryptedKeys: [addressKey], addressKeyMap: { [EMAIL]: addressKey } },
    share, root, rootHash, child, childHash,
    childNameHash: hmacHex(rootHash.bytes, FOLDER_NAME),
    verificationCode: new Uint8Array(randomBytes(32)),
    // GET core/v4/addresses
    addresses: {
      Code: 1000,
      Addresses: [{
        ID: ADDRESS_ID, Email: EMAIL,
        Keys: [{ ID: 'addrkey-1', Primary: 1, PrivateKey: addressKeyArmored }],
      }],
    },
    // GET drive/v2/shares/my-files: PrimaryRootShareResponseDto
    myFiles: {
      Code: 1000,
      Volume: { VolumeID: VOLUME_ID, UsedSpace: 0 },
      Share: {
        ShareID: SHARE_ID, CreatorEmail: EMAIL, AddressID: ADDRESS_ID,
        Key: share.armoredKey, Passphrase: share.armoredPassphrase,
        PassphraseSignature: share.armoredSignature,
      },
      Link: folderDetails({ LinkID: ROOT_LINK_ID, ParentLinkID: null }, root, rootHash),
    },
  };
}

// ---------------------------------------------------------------------------
// Mock server + module loader
// ---------------------------------------------------------------------------

/** ShareURLResponseDto echoing what was sent. */
function shareUrlDto(data) {
  return {
    Token: 'TOKEN123', ShareURLID: 'url-1', ShareID: 'share-file',
    PublicUrl: 'https://drive.proton.me/urls/TOKEN123',
    ExpirationTime: data.ExpirationTime === undefined ? null : data.ExpirationTime,
    LastAccessTime: null, CreateTime: 1700000000, MaxAccesses: 0, NumAccesses: 0,
    CreatorEmail: EMAIL, Permissions: data.Permissions || 4, Flags: data.Flags || 2,
    UrlPasswordSalt: 'url-salt', SharePasswordSalt: 'salt', SRPVerifier: 'v',
    SRPModulusID: 'mod-1', Password: 'pw', SharePassphraseKeyPacket: 'kp', Name: null,
  };
}

/**
 * The route table. Each handler gets { method, path, params, data, match }
 * and returns a body shaped like the spec's 200 response, or throws apiError.
 * An unknown route throws, so an unexpected call cannot pass silently.
 */
function makeServer(overrides) {
  const state = { files: 0, drafts: {} };
  const handlers = {
    myFiles: () => fx.myFiles,
    addresses: () => fx.addresses,
    // GetVolumeResponseDto. ID / Share.ID carry the deprecated aliases with
    // DIFFERENT values, so reading the wrong field is visible.
    createVolume: () => ({
      Code: 1000,
      Volume: {
        ID: 'vol-legacy-alias', VolumeID: 'vol-new', CreationTime: 0, MaxSpace: null,
        CreateTime: 0, ModifyTime: 0, UsedSpace: 0, DownloadedBytes: 0, UploadedBytes: 0,
        State: 1, Type: 1,
        Share: { ShareID: 'share-new', ID: 'share-legacy-alias', LinkID: 'link-root-new' },
      },
    }),
    createFolder: () => ({ Code: 1000, Folder: { ID: 'folder-new' } }),
    links: () => ({ Code: 1000, Links: [] }),
    children: () => ({ Code: 1000, LinkIDs: [], AnchorID: null, More: false }),
    checkHashes: ({ data }) => ({ Code: 1000, AvailableHashes: data.Hashes, PendingHashes: [] }),
    createFile: ({ data }) => {
      const n = ++state.files;
      const File = { ID: `file-${n}`, RevisionID: `rev-${n}`, ClientUID: null };
      state.drafts[File.ID] = data;
      return { Code: 1000, File };
    },
    // VerificationData: the server re-serves the draft's own ContentKeyPacket.
    verification: ({ match }) => ({
      Code: 1000,
      VerificationCode: b64(fx.verificationCode),
      ContentKeyPacket: state.drafts[match[2]].ContentKeyPacket,
    }),
    // RequestUploadResponse, deliberately in REVERSE order: pairing by
    // position would send every block to the wrong URL.
    blocks: ({ data }) => ({
      Code: 1000,
      UploadLinks: data.BlockList.map((b) => ({
        Index: b.Index, Token: `tok-${b.Index}`,
        BareURL: `https://storage.proton.me/blocks/${b.Index}`, URL: '',
      })).reverse(),
      ThumbnailLinks: [],
    }),
    commit: () => ({ Code: 1000 }),
    deleteDrafts: ({ data }) => ({
      Code: 1001,
      Responses: data.LinkIDs.map((LinkID) => ({ LinkID, Response: { Code: 1000 } })),
    }),
    createShare: () => ({ Code: 1000, Share: { ID: 'share-file', EditorsCanShare: false } }),
    modulus: () => ({ Code: 1000, Modulus: 'MODULUS', ModulusID: 'mod-1' }),
    createUrl: ({ data }) => ({ Code: 1000, ShareURL: shareUrlDto(data) }),
    updateUrl: ({ data }) => ({ Code: 1000, ShareURL: shareUrlDto(data) }),
    deleteShare: () => ({ Code: 1000 }),
    ...(overrides || {}),
  };
  const routes = [
    ['GET', /^drive\/v2\/shares\/my-files$/, 'myFiles'],
    ['GET', /^core\/v4\/addresses$/, 'addresses'],
    ['POST', /^drive\/volumes$/, 'createVolume'],
    ['POST', /^drive\/v2\/volumes\/([^/]+)\/folders$/, 'createFolder'],
    ['POST', /^drive\/v2\/volumes\/([^/]+)\/links$/, 'links'],
    ['GET', /^drive\/v2\/volumes\/([^/]+)\/folders\/([^/]+)\/children$/, 'children'],
    ['POST', /^drive\/v2\/volumes\/([^/]+)\/links\/([^/]+)\/checkAvailableHashes$/, 'checkHashes'],
    ['POST', /^drive\/v2\/volumes\/([^/]+)\/files$/, 'createFile'],
    ['GET', /^drive\/v2\/volumes\/([^/]+)\/links\/([^/]+)\/revisions\/([^/]+)\/verification$/, 'verification'],
    ['POST', /^drive\/blocks$/, 'blocks'],
    ['PUT', /^drive\/v2\/volumes\/([^/]+)\/files\/([^/]+)\/revisions\/([^/]+)$/, 'commit'],
    ['POST', /^drive\/v2\/volumes\/([^/]+)\/delete_multiple$/, 'deleteDrafts'],
    ['POST', /^drive\/volumes\/([^/]+)\/shares$/, 'createShare'],
    ['GET', /^core\/v4\/auth\/modulus$/, 'modulus'],
    ['POST', /^drive\/shares\/([^/]+)\/urls$/, 'createUrl'],
    ['PUT', /^drive\/shares\/([^/]+)\/urls\/([^/]+)$/, 'updateUrl'],
    ['DELETE', /^drive\/shares\/([^/]+)$/, 'deleteShare'],
  ];
  return {
    state,
    async handle(call) {
      for (const [method, re, name] of routes) {
        const match = call.method === method && call.path.match(re);
        if (match) return handlers[name]({ ...call, match });
      }
      throw new Error(`unexpected request ${call.method} ${call.path}`);
    },
  };
}

/**
 * A fresh ProtonDrive (empty bootstrap cache) wired to the mock server.
 * `account` stands in for the fixture's unlocked account in one test, so that
 * test never changes what the others share.
 */
function loadDrive(overrides, account) {
  const server = makeServer(overrides);
  const calls = [];
  const uploads = [];
  const diag = [];
  const ProtonAccounts = {
    ensureKeysUnlocked: async () => {},
    getAccount: (id) => (id === ACCOUNT_ID ? (account || fx.account) : null),
    request: async (accountId, method, path, opts = {}) => {
      const call = { method, path, params: opts.params, data: opts.data };
      calls.push(call);
      return server.handle(call);
    },
  };
  const ProtonAuth = {
    computeKeyPassword: (password, salt) => `keypass(${password}|${salt})`,
    buildEoAuthFromModulus: async (modulus, modulusId, password) =>
      ({ ModulusID: modulusId, Verifier: `verifier(${password})`, Salt: 'url-salt' }),
  };
  const ProtonConfig = { buildHeaders: () => ({ 'Content-Type': 'application/json' }) };
  const ProtonDiag = { record: (event, fields) => diag.push({ event, fields }) };
  const fetchStub = async (url, init) => {
    const blob = init.body.get('Block');
    uploads.push({
      url, method: init.method,
      token: init.headers['pm-storage-token'],
      bytes: new Uint8Array(await blob.arrayBuffer()),
    });
    return { ok: true, status: 200, json: async () => ({ Code: 1000 }) };
  };
  const factory = new Function(
    'ProtonBinary', 'ProtonAccounts', 'ProtonAuth', 'ProtonConfig', 'ProtonDiag',
    'ProtonPremium', 'ExtEncryption', 'openpgp', 'debugLog', 'getSettings', 'browser', 'fetch',
    DRIVE_SRC + '\nreturn ProtonDrive;');
  const drive = factory(
    ProtonBinary, ProtonAccounts, ProtonAuth, ProtonConfig, ProtonDiag,
    { isPremium: () => true }, {}, openpgp, () => {}, async () => ({}), {}, fetchStub);
  return { drive, calls, uploads, diag, server };
}

/** Deterministic file content. */
function pattern(size) {
  const buf = new Uint8Array(size);
  for (let i = 0; i < size; i++) buf[i] = (i * 31 + 7) & 0xff;
  return buf;
}

/** Bootstrap + new target folder; returns the folder ctx and the call offset after it. */
async function readyFolder(t) {
  const folder = await t.drive.ensureFolder(ACCOUNT_ID, FOLDER_NAME);
  return { folder, from: t.calls.length };
}

async function uploadSmall(t, folder, name, size) {
  const data = pattern(size || 10);
  return t.drive.uploadFile(ACCOUNT_ID, folder,
    { name: name || 'a.txt', size: data.length, mimeType: 'text/plain', modTime: 1700000000000 },
    (offset, length) => Promise.resolve(data.subarray(offset, offset + length)),
    null, null);
}

beforeAll(async () => {
  globalThis.window = globalThis;
  globalThis.self = globalThis;
  // eslint-disable-next-line no-eval
  (0, eval)(readFileSync(join(ROOT, 'lib', 'openpgp.min.js'), 'utf-8'));
  openpgp = globalThis.openpgp;
  const binCode = readFileSync(join(ROOT, 'lib', 'binary-utils.js'), 'utf-8');
  ProtonBinary = new Function(binCode + '\nreturn ProtonBinary;')();
  fx = await makeFixture();
}, 60000);

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

describe('bootstrap: GET drive/v2/shares/my-files (SDK shares/manager.ts getRootIDs)', () => {
  it('existing volume: my-files, then the address list, and nothing else', async () => {
    const t = loadDrive();
    const ctx = await t.drive.bootstrap(ACCOUNT_ID);

    expect(routesOf(t.calls)).toEqual([
      'GET drive/v2/shares/my-files',
      'GET core/v4/addresses',
    ]);
    expect(t.calls[0].params).toBeUndefined();
    expect(ctx.volumeId).toBe(VOLUME_ID);
    expect(ctx.shareId).toBe(SHARE_ID);
    expect(ctx.addressId).toBe(ADDRESS_ID);
    expect(ctx.addressEmail).toBe(EMAIL);
    expect(ctx.rootLinkId).toBe(ROOT_LINK_ID);
    expectNoLegacyRoutes(t.calls);
  });

  it('unlocks the share key, root key and hash key from the my-files shape', async () => {
    const t = loadDrive();
    const ctx = await t.drive.bootstrap(ACCOUNT_ID);
    // Share.Key/Passphrase, Link.Link.NodeKey/NodePassphrase, Link.Folder.NodeHashKey
    expect(ctx.shareKey.getFingerprint()).toBe(fx.share.key.getFingerprint());
    expect(ctx.rootKey.getFingerprint()).toBe(fx.root.key.getFingerprint());
    expect(Array.from(ctx.rootHashKey)).toEqual(Array.from(fx.rootHash.bytes));
    expect(ctx.addressKey).toBe(fx.addressKey);
  });

  it('the share address comes from Share.AddressID, not the first address', async () => {
    // A decoy address listed FIRST, with a real key of its own. Ignoring
    // Share.AddressID, or reading it from the wrong field, lands on the decoy:
    // its email and key would then sign every folder, draft, block and share.
    const DECOY_EMAIL = 'other@test.invalid';
    const { privateKey: decoyKey } = await openpgp.generateKey({
      type: 'ecc', curve: 'ed25519Legacy', userIDs: [{ name: 'other', email: DECOY_EMAIL }], format: 'object',
    });
    const t = loadDrive({
      addresses: () => ({
        Code: 1000,
        Addresses: [{ ID: 'addr-0', Email: DECOY_EMAIL, Keys: [] }, ...fx.addresses.Addresses],
      }),
    }, {
      decryptedKeys: [decoyKey, fx.addressKey],
      addressKeyMap: { [DECOY_EMAIL]: decoyKey, [EMAIL]: fx.addressKey },
    });
    const ctx = await t.drive.bootstrap(ACCOUNT_ID);
    expect(ctx.addressId).toBe(ADDRESS_ID);
    expect(ctx.addressEmail).toBe(EMAIL);
    expect(ctx.addressKey).toBe(fx.addressKey);
  });

  it('is cached: a second bootstrap makes no request', async () => {
    const t = loadDrive();
    await t.drive.bootstrap(ACCOUNT_ID);
    const n = t.calls.length;
    await t.drive.bootstrap(ACCOUNT_ID);
    expect(t.calls.length).toBe(n);
  });

  it('first use: Code 2501 creates the volume with the same 10 fields', async () => {
    const t = loadDrive({
      myFiles: () => { throw apiError(422, 2501, {}, 'Volume not found'); },
    });
    const ctx = await t.drive.bootstrap(ACCOUNT_ID);

    expect(routesOf(t.calls)).toEqual([
      'GET drive/v2/shares/my-files',
      'GET core/v4/addresses',
      'POST drive/volumes',
    ]);
    const data = t.calls[2].data;
    expect(keysOf(data)).toEqual([
      'AddressID', 'AddressKeyID', 'FolderHashKey', 'FolderKey', 'FolderName',
      'FolderPassphrase', 'FolderPassphraseSignature', 'ShareKey', 'SharePassphrase',
      'SharePassphraseSignature',
    ]);
    expect(data.AddressID).toBe(ADDRESS_ID);
    expect(data.AddressKeyID).toBe('addrkey-1');
    // VolumeID / ShareID win over the deprecated ID aliases.
    expect(ctx.volumeId).toBe('vol-new');
    expect(ctx.shareId).toBe('share-new');
    expect(ctx.rootLinkId).toBe('link-root-new');
    expect(ctx.addressId).toBe(ADDRESS_ID);
    expect(ctx.addressEmail).toBe(EMAIL);
    expectNoLegacyRoutes(t.calls);
  });

  it('first use: the locally kept keys are exactly the ones sent to the server', async () => {
    // Nothing is fetched after creating the volume, so the context must match
    // what a later my-files would unlock from the stored request.
    const t = loadDrive({
      myFiles: () => { throw apiError(422, 2501, {}, 'Volume not found'); },
    });
    const ctx = await t.drive.bootstrap(ACCOUNT_ID);
    const data = t.calls[2].data;

    const sharePass = await decryptText(data.SharePassphrase, [fx.addressKey]);
    const shareKey = await unlock(data.ShareKey, sharePass);
    expect(shareKey.getFingerprint()).toBe(ctx.shareKey.getFingerprint());

    const folderPass = await decryptText(data.FolderPassphrase, [ctx.shareKey]);
    const rootKey = await unlock(data.FolderKey, folderPass);
    expect(rootKey.getFingerprint()).toBe(ctx.rootKey.getFingerprint());

    const hashKey = await decryptText(data.FolderHashKey, [ctx.rootKey], 'binary');
    expect(Array.from(hashKey)).toEqual(Array.from(ctx.rootHashKey));
  });

  it('first use: the deprecated aliases are only a fallback', async () => {
    const t = loadDrive({
      myFiles: () => { throw apiError(422, 2501, {}, 'Volume not found'); },
      createVolume: () => ({
        Code: 1000,
        Volume: {
          ID: 'vol-legacy-alias', State: 1, Type: 1,
          Share: { ID: 'share-legacy-alias', LinkID: 'link-root-new' },
        },
      }),
    });
    const ctx = await t.drive.bootstrap(ACCOUNT_ID);
    expect(ctx.volumeId).toBe('vol-legacy-alias');
    expect(ctx.shareId).toBe('share-legacy-alias');
  });

  it('an HTTP 404 is a missing route, not "no volume": nothing is created', async () => {
    const t = loadDrive({
      myFiles: () => { throw apiError(404, 2501, {}, 'Not found'); },
    });
    await expect(t.drive.bootstrap(ACCOUNT_ID)).rejects.toMatchObject({ status: 404 });
    expect(routesOf(t.calls)).toEqual(['GET drive/v2/shares/my-files']);
  });

  it('any other my-files error propagates without creating a volume', async () => {
    const t = loadDrive({
      myFiles: () => { throw apiError(422, 2011, {}, 'No permission'); },
    });
    await expect(t.drive.bootstrap(ACCOUNT_ID)).rejects.toMatchObject({ code: 2011 });
    expect(routesOf(t.calls)).toEqual(['GET drive/v2/shares/my-files']);
  });
});

// ---------------------------------------------------------------------------
// Folders
// ---------------------------------------------------------------------------

describe('folders: create, or reuse what the name conflict points at (SDK nodes/apiService.ts)', () => {
  it('new folder: one POST drive/v2/volumes/{volumeID}/folders, signer as SignatureEmail', async () => {
    const t = loadDrive();
    await t.drive.bootstrap(ACCOUNT_ID);
    const from = t.calls.length;
    const folder = await t.drive.ensureFolder(ACCOUNT_ID, FOLDER_NAME);

    expect(routesOf(t.calls.slice(from))).toEqual([`POST drive/v2/volumes/${VOLUME_ID}/folders`]);
    const data = t.calls[from].data;
    expect(keysOf(data)).toEqual([
      'Hash', 'Name', 'NodeHashKey', 'NodeKey', 'NodePassphrase', 'NodePassphraseSignature',
      'ParentLinkID', 'SignatureEmail',
    ]);
    expect(data.ParentLinkID).toBe(ROOT_LINK_ID);
    expect(data.SignatureEmail).toBe(EMAIL);
    expect(data.Hash).toBe(fx.childNameHash);
    expect(folder.linkId).toBe('folder-new');

    // The returned keys are the ones the request carries (crypto unchanged).
    const pass = await decryptText(data.NodePassphrase, [fx.root.key]);
    const key = await unlock(data.NodeKey, pass);
    expect(key.getFingerprint()).toBe(folder.key.getFingerprint());
    const hashKey = await decryptText(data.NodeHashKey, [folder.key], 'binary');
    expect(Array.from(hashKey)).toEqual(Array.from(folder.hashKey));
    expectNoLegacyRoutes(t.calls);
  });

  it('existing folder: the 2500 conflict link is loaded with ONE drive/v2 links call', async () => {
    const t = loadDrive({
      createFolder: () => {
        throw apiError(422, 2500, {
          ConflictLinkID: 'folder-x', ConflictRevisionID: null,
          ConflictDraftRevisionID: null, ConflictDraftClientUID: null,
        }, 'A file or folder with that name already exists');
      },
      links: ({ data }) => ({
        Code: 1000,
        Links: data.LinkIDs.includes('folder-x')
          ? [folderDetails({ LinkID: 'folder-x', NameHash: fx.childNameHash }, fx.child, fx.childHash)]
          : [],
      }),
    });
    await t.drive.bootstrap(ACCOUNT_ID);
    const from = t.calls.length;
    const folder = await t.drive.ensureFolder(ACCOUNT_ID, FOLDER_NAME);

    expect(routesOf(t.calls.slice(from))).toEqual([
      `POST drive/v2/volumes/${VOLUME_ID}/folders`,
      `POST drive/v2/volumes/${VOLUME_ID}/links`,
    ]);
    expect(t.calls[from + 1].data).toEqual({ LinkIDs: ['folder-x'] });
    expect(folder.linkId).toBe('folder-x');
    expect(folder.key.getFingerprint()).toBe(fx.child.key.getFingerprint());
    expect(Array.from(folder.hashKey)).toEqual(Array.from(fx.childHash.bytes));
  });

  it('existing folder without a conflict ID: pages the v2 children by AnchorID, active folders only', async () => {
    const t = loadDrive({
      createFolder: () => { throw apiError(422, 2500, undefined, 'Already exists'); },
      // ListChildrenResponseDto: IDs only, More + AnchorID paging.
      children: ({ params }) => (params && params.AnchorID === 'l-trashed'
        ? { Code: 1000, LinkIDs: ['folder-y'], More: false, AnchorID: null }
        : { Code: 1000, LinkIDs: ['l-other', 'l-trashed'], More: true, AnchorID: 'l-trashed' }),
      links: ({ data }) => ({
        Code: 1000,
        Links: data.LinkIDs.map((id) => {
          if (id === 'l-other') return folderDetails({ LinkID: id, NameHash: 'f'.repeat(64) }, null, null);
          // Same name, but trashed: no place to upload into.
          if (id === 'l-trashed') return folderDetails({ LinkID: id, NameHash: fx.childNameHash, State: 2 }, null, null);
          return folderDetails({ LinkID: id, NameHash: fx.childNameHash }, fx.child, fx.childHash);
        }),
      }),
    });
    await t.drive.bootstrap(ACCOUNT_ID);
    const from = t.calls.length;
    const folder = await t.drive.ensureFolder(ACCOUNT_ID, FOLDER_NAME);

    const calls = t.calls.slice(from);
    expect(routesOf(calls)).toEqual([
      `POST drive/v2/volumes/${VOLUME_ID}/folders`,
      `GET drive/v2/volumes/${VOLUME_ID}/folders/${ROOT_LINK_ID}/children`,
      `POST drive/v2/volumes/${VOLUME_ID}/links`,
      `GET drive/v2/volumes/${VOLUME_ID}/folders/${ROOT_LINK_ID}/children`,
      `POST drive/v2/volumes/${VOLUME_ID}/links`,
    ]);
    expect(calls[1].params).toEqual({ FoldersOnly: 1 });
    expect(calls[2].data).toEqual({ LinkIDs: ['l-other', 'l-trashed'] });
    expect(calls[3].params).toEqual({ FoldersOnly: 1, AnchorID: 'l-trashed' });
    expect(calls[4].data).toEqual({ LinkIDs: ['folder-y'] });
    expect(folder.linkId).toBe('folder-y');
    expectNoLegacyRoutes(t.calls);
  });

  it('a name held by a FILE is not reused: the 2500 reaches the caller, no listing', async () => {
    const t = loadDrive({
      createFolder: () => {
        throw apiError(422, 2500, { ConflictLinkID: 'file-z' }, 'A file or folder with that name already exists');
      },
      links: () => ({ Code: 1000, Links: [fileDetails({ LinkID: 'file-z', NameHash: fx.childNameHash })] }),
    });
    await t.drive.bootstrap(ACCOUNT_ID);
    const from = t.calls.length;
    await expect(t.drive.ensureFolder(ACCOUNT_ID, FOLDER_NAME)).rejects.toMatchObject({ code: 2500 });
    expect(routesOf(t.calls.slice(from))).toEqual([
      `POST drive/v2/volumes/${VOLUME_ID}/folders`,
      `POST drive/v2/volumes/${VOLUME_ID}/links`,
    ]);
  });

  it('other folder errors propagate untouched', async () => {
    const t = loadDrive({
      createFolder: () => { throw apiError(422, 2501, {}, 'Parent folder is not active'); },
    });
    await expect(t.drive.ensureFolder(ACCOUNT_ID, FOLDER_NAME)).rejects.toMatchObject({ code: 2501 });
    expect(routesOf(t.calls).slice(-1)).toEqual([`POST drive/v2/volumes/${VOLUME_ID}/folders`]);
  });
});

// ---------------------------------------------------------------------------
// Upload
// ---------------------------------------------------------------------------

describe('upload: v2 draft, verification and commit; drive/blocks by VolumeID (SDK upload/apiService.ts)', () => {
  it('multi-block file: exact routes and payload keys, blocks paired by Index, manifest over local hashes', async () => {
    const t = loadDrive();
    const { folder, from } = await readyFolder(t);
    const size = 4 * CHUNK + 7; // five blocks: one batch of four, then one
    const content = pattern(size);
    const uploaded = await t.drive.uploadFile(ACCOUNT_ID, folder,
      { name: 'report.bin', size, mimeType: 'application/octet-stream', modTime: 1700000000000 },
      (offset, length) => Promise.resolve(content.subarray(offset, offset + length)),
      null, null);

    const calls = t.calls.slice(from);
    const { linkId, revisionId } = uploaded;
    expect(routesOf(calls)).toEqual([
      `POST drive/v2/volumes/${VOLUME_ID}/links/folder-new/checkAvailableHashes`,
      `POST drive/v2/volumes/${VOLUME_ID}/files`,
      `GET drive/v2/volumes/${VOLUME_ID}/links/${linkId}/revisions/${revisionId}/verification`,
      'POST drive/blocks',
      'POST drive/blocks',
      `PUT drive/v2/volumes/${VOLUME_ID}/files/${linkId}/revisions/${revisionId}`,
    ]);

    // Name check: v2 route, ClientUID null as the SDK sends it without one.
    const check = calls[0].data;
    expect(keysOf(check)).toEqual(['ClientUID', 'Hashes']);
    expect(check.ClientUID).toBeNull();
    expect(check.Hashes).toHaveLength(8);
    expect(check.Hashes[0]).toBe(hmacHex(folder.hashKey, 'report.bin'));

    // Draft: same body as before, now on the volume route.
    const draft = calls[1].data;
    expect(keysOf(draft)).toEqual([
      'ContentKeyPacket', 'ContentKeyPacketSignature', 'Hash', 'MIMEType', 'Name', 'NodeKey',
      'NodePassphrase', 'NodePassphraseSignature', 'ParentLinkID', 'SignatureAddress',
    ]);
    expect(draft.ParentLinkID).toBe('folder-new');
    expect(draft.SignatureAddress).toBe(EMAIL);
    expect(draft.Hash).toBe(check.Hashes[0]);

    // drive/blocks: VolumeID, no ShareID, no per-block Hash or Size.
    const blockCalls = [calls[3].data, calls[4].data];
    for (const body of blockCalls) {
      expect(keysOf(body)).toEqual(['AddressID', 'BlockList', 'LinkID', 'RevisionID', 'ThumbnailList', 'VolumeID']);
      expect(body.VolumeID).toBe(VOLUME_ID);
      expect(body.AddressID).toBe(ADDRESS_ID);
      expect(body.LinkID).toBe(linkId);
      expect(body.RevisionID).toBe(revisionId);
      expect(body.ThumbnailList).toEqual([]);
      for (const block of body.BlockList) {
        expect(keysOf(block)).toEqual(['EncSignature', 'Index', 'Verifier']);
        expect(keysOf(block.Verifier)).toEqual(['Token']);
      }
    }
    expect(blockCalls[0].BlockList.map((b) => b.Index)).toEqual([1, 2, 3, 4]);
    expect(blockCalls[1].BlockList.map((b) => b.Index)).toEqual([5]);

    // Each upload went to the URL and token carrying its OWN Index (the mock
    // answered in reverse order), and its bytes are that block's ciphertext:
    // the verifier token sent for Index i is code XOR the bytes uploaded for i.
    const tokens = {};
    for (const body of blockCalls) for (const b of body.BlockList) tokens[b.Index] = b.Verifier.Token;
    expect(t.uploads).toHaveLength(5);
    const byIndex = {};
    for (const up of t.uploads) {
      const index = Number(up.url.split('/').pop());
      expect(up.method).toBe('POST');
      expect(up.token).toBe(`tok-${index}`);
      const want = fx.verificationCode.map((c, i) => c ^ (up.bytes[i] || 0));
      expect(tokens[index]).toBe(b64(want));
      byIndex[index] = up.bytes;
    }

    // And each block decrypts to the right slice of the file.
    const [sessionKey] = await openpgp.decryptSessionKeys({
      message: await openpgp.readMessage({ binaryMessage: fromB64(draft.ContentKeyPacket) }),
      decryptionKeys: uploaded.nodeKey,
    });
    for (let index = 1; index <= 5; index++) {
      const { data } = await openpgp.decrypt({
        message: await openpgp.readMessage({ binaryMessage: byIndex[index] }),
        sessionKeys: sessionKey, format: 'binary',
      });
      const start = (index - 1) * CHUNK;
      expect(Buffer.compare(Buffer.from(data), Buffer.from(content.subarray(start, start + CHUNK)))).toBe(0);
    }

    // Commit: same body; the manifest signature covers the SHA-256 of the
    // bytes actually uploaded, in Index order, though no Hash was sent.
    const commit = calls[5].data;
    expect(keysOf(commit)).toEqual(['ManifestSignature', 'SignatureAddress', 'XAttr']);
    expect(commit.SignatureAddress).toBe(EMAIL);
    const manifest = Buffer.concat([1, 2, 3, 4, 5].map((i) => Buffer.from(sha256(byIndex[i]))));
    const verified = await openpgp.verify({
      message: await openpgp.createMessage({ binary: new Uint8Array(manifest) }),
      signature: await openpgp.readSignature({ armoredSignature: commit.ManifestSignature }),
      verificationKeys: fx.addressKey.toPublic(),
    });
    await expect(verified.signatures[0].verified).resolves.toBe(true);
    const xattr = JSON.parse(await decryptText(commit.XAttr, [uploaded.nodeKey]));
    expect(xattr.Common.Size).toBe(size);
    expect(xattr.Common.BlockSizes).toEqual([CHUNK, CHUNK, CHUNK, CHUNK, 7]);
    expectNoLegacyRoutes(t.calls);
  }, 60000);

  it('name dedupe: a taken name becomes "name (1).ext" via the v2 checkAvailableHashes', async () => {
    const t = loadDrive({
      checkHashes: ({ data }) => ({ Code: 1000, AvailableHashes: data.Hashes.slice(1), PendingHashes: [] }),
    });
    const { folder, from } = await readyFolder(t);
    const uploaded = await uploadSmall(t, folder, 'a.txt');

    const check = t.calls[from];
    expect(check.path).toBe(`drive/v2/volumes/${VOLUME_ID}/links/folder-new/checkAvailableHashes`);
    expect(check.data.Hashes[1]).toBe(hmacHex(folder.hashKey, 'a (1).txt'));
    expect(uploaded.name).toBe('a (1).txt');
    expect(t.calls[from + 1].data.Hash).toBe(check.data.Hashes[1]);
  });

  it('empty file: no drive/blocks call, still a committed revision', async () => {
    const t = loadDrive();
    const { folder, from } = await readyFolder(t);
    const data = new Uint8Array(0);
    const uploaded = await t.drive.uploadFile(ACCOUNT_ID, folder,
      { name: 'empty.txt', size: 0, mimeType: 'text/plain' },
      () => Promise.resolve(data), null, null);
    expect(routesOf(t.calls.slice(from))).toEqual([
      `POST drive/v2/volumes/${VOLUME_ID}/links/folder-new/checkAvailableHashes`,
      `POST drive/v2/volumes/${VOLUME_ID}/files`,
      `GET drive/v2/volumes/${VOLUME_ID}/links/${uploaded.linkId}/revisions/${uploaded.revisionId}/verification`,
      `PUT drive/v2/volumes/${VOLUME_ID}/files/${uploaded.linkId}/revisions/${uploaded.revisionId}`,
    ]);
  });

  it('a missing upload URL for a block fails the file and deletes the draft (delete_multiple, not trash)', async () => {
    const t = loadDrive({
      blocks: () => ({
        Code: 1000,
        UploadLinks: [{ Index: 9, Token: 'tok-9', BareURL: 'https://storage.proton.me/blocks/9', URL: '' }],
        ThumbnailLinks: [],
      }),
    });
    const { folder, from } = await readyFolder(t);
    await expect(uploadSmall(t, folder)).rejects.toThrow('Drive returned no upload URL for block 1');
    await flush();

    const cleanup = t.calls.slice(from).filter((c) => /delete_multiple|trash/.test(c.path));
    expect(cleanup).toEqual([{
      method: 'POST', path: `drive/v2/volumes/${VOLUME_ID}/delete_multiple`,
      params: undefined, data: { LinkIDs: ['file-1'] },
    }]);
    expect(t.uploads).toHaveLength(0);
    expect(t.diag.filter((d) => d.event === 'drive.draft_cleanup_refused')).toEqual([]);
  });

  it('a failed commit deletes the draft once; a per-link refusal inside the 200 is recorded', async () => {
    const t = loadDrive({
      commit: () => { throw apiError(500, undefined, undefined, 'Internal error'); },
      // MultiResponsesPerLinkFactory: the per-link answer refuses.
      deleteDrafts: ({ data }) => ({
        Code: 1001,
        Responses: data.LinkIDs.map((LinkID) => ({ LinkID, Response: { Code: 2501, Error: 'Not a draft', Details: {} } })),
      }),
    });
    const { folder, from } = await readyFolder(t);
    await expect(uploadSmall(t, folder)).rejects.toThrow('Internal error');
    await flush();

    const cleanup = t.calls.slice(from).filter((c) => /delete_multiple|trash/.test(c.path));
    expect(routesOf(cleanup)).toEqual([`POST drive/v2/volumes/${VOLUME_ID}/delete_multiple`]);
    expect(t.diag.filter((d) => d.event === 'drive.draft_cleanup_refused'))
      .toEqual([{ event: 'drive.draft_cleanup_refused', fields: { code: 2501 } }]);
  });
});

// ---------------------------------------------------------------------------
// Share URL
// ---------------------------------------------------------------------------

const SHARE_KEYS = [
  'AddressID', 'NameKeyPacket', 'PassphraseKeyPacket', 'RootLinkID', 'ShareKey',
  'SharePassphrase', 'SharePassphraseSignature',
];
const URL_KEYS = [
  'CreatorEmail', 'ExpirationTime', 'Flags', 'MaxAccesses', 'Password', 'Permissions',
  'SRPModulusID', 'SRPVerifier', 'SharePassphraseKeyPacket', 'SharePasswordSalt', 'UrlPasswordSalt',
];

describe('share URL: per-file share, POST urls with ExpirationTime, cleanup with Force=1', () => {
  async function uploadedFile(t) {
    const { folder } = await readyFolder(t);
    const uploaded = await uploadSmall(t, folder);
    return { uploaded, from: t.calls.length };
  }

  it('viewer link: share, modulus, URL; ExpirationTime absolute, no ExpirationDuration, Flags 2', async () => {
    const t = loadDrive();
    const { uploaded, from } = await uploadedFile(t);
    const before = Math.floor(Date.now() / 1000);
    const link = await t.drive.createShareUrl(ACCOUNT_ID, uploaded,
      { permission: 'viewer', expirationDays: 7, customPassword: '' });
    const after = Math.floor(Date.now() / 1000);

    const calls = t.calls.slice(from);
    expect(routesOf(calls)).toEqual([
      `POST drive/volumes/${VOLUME_ID}/shares`,
      'GET core/v4/auth/modulus',
      'POST drive/shares/share-file/urls',
    ]);
    expect(keysOf(calls[0].data)).toEqual(SHARE_KEYS);
    expect(calls[0].data.AddressID).toBe(ADDRESS_ID);
    expect(calls[0].data.RootLinkID).toBe(uploaded.linkId);

    const body = calls[2].data;
    expect(keysOf(body)).toEqual(URL_KEYS);
    expect(body).not.toHaveProperty('ExpirationDuration');
    expect(body.Flags).toBe(2);
    expect(body.Permissions).toBe(4);
    expect(body.MaxAccesses).toBe(0);
    expect(body.CreatorEmail).toBe(EMAIL);
    expect(body.SRPModulusID).toBe('mod-1');
    expect(body.ExpirationTime).toBeGreaterThanOrEqual(before + 7 * DAY);
    expect(body.ExpirationTime).toBeLessThanOrEqual(after + 7 * DAY);

    expect(link.url).toMatch(/^https:\/\/drive\.proton\.me\/urls\/TOKEN123#[A-Za-z0-9]{12}$/);
    expect(link.expirationTime).toBe(body.ExpirationTime);
    expect(link.permission).toBe('viewer');
    expect(link.hasCustomPassword).toBe(false);
    expectNoLegacyRoutes(t.calls);
  });

  it('no expiry sends ExpirationTime null; 90 days stays one hour under the server cap', async () => {
    const t = loadDrive();
    const { uploaded, from } = await uploadedFile(t);
    await t.drive.createShareUrl(ACCOUNT_ID, uploaded, { permission: 'viewer', expirationDays: 0 });
    const before = Math.floor(Date.now() / 1000);
    await t.drive.createShareUrl(ACCOUNT_ID, uploaded, { permission: 'viewer', expirationDays: 90 });
    const after = Math.floor(Date.now() / 1000);

    const urlCalls = t.calls.slice(from).filter((c) => c.path === 'drive/shares/share-file/urls');
    expect(urlCalls).toHaveLength(2);
    expect(urlCalls[0].data.ExpirationTime).toBeNull();
    expect(urlCalls[1].data.ExpirationTime).toBeGreaterThanOrEqual(before + 90 * DAY - 3600);
    expect(urlCalls[1].data.ExpirationTime).toBeLessThanOrEqual(after + 90 * DAY - 3600);
  });

  it('editor + custom password: ONE PUT with Permissions 6, Flags 3 and the full password', async () => {
    const t = loadDrive();
    const { uploaded, from } = await uploadedFile(t);
    const custom = 'p'.repeat(50); // exactly at the limit
    const link = await t.drive.createShareUrl(ACCOUNT_ID, uploaded,
      { permission: 'editor', expirationDays: 1, customPassword: custom });

    const calls = t.calls.slice(from);
    expect(routesOf(calls)).toEqual([
      `POST drive/volumes/${VOLUME_ID}/shares`,
      'GET core/v4/auth/modulus',
      'POST drive/shares/share-file/urls',
      'GET core/v4/auth/modulus',
      'PUT drive/shares/share-file/urls/url-1',
    ]);
    const put = calls[4].data;
    expect(keysOf(put)).toEqual([
      'Flags', 'Password', 'Permissions', 'SRPModulusID', 'SRPVerifier',
      'SharePassphraseKeyPacket', 'UrlPasswordSalt',
    ]);
    expect(put.Flags).toBe(3);
    expect(put.Permissions).toBe(6);
    // The SRP verifier is over generated + custom; the generated part is the fragment.
    const generated = link.url.split('#')[1];
    expect(put.SRPVerifier).toBe(`verifier(${generated}${custom})`);
    expect(link.hasCustomPassword).toBe(true);
    expect(link.permission).toBe('editor');
  });

  it('a failed URL update tears down with ONE DELETE drive/shares/{id}?Force=1 (no URL delete)', async () => {
    const t = loadDrive({
      updateUrl: () => { throw apiError(422, 2001, {}, 'Invalid PGP message'); },
    });
    const { uploaded, from } = await uploadedFile(t);
    await expect(t.drive.createShareUrl(ACCOUNT_ID, uploaded,
      { permission: 'editor', expirationDays: 1, customPassword: 'hunter2' }))
      .rejects.toMatchObject({ code: 2001 });

    const deletes = t.calls.slice(from).filter((c) => c.method === 'DELETE');
    expect(deletes).toEqual([{
      method: 'DELETE', path: 'drive/shares/share-file', params: { Force: 1 }, data: undefined,
    }]);
  });

  it('a failed URL creation also deletes the share with Force=1, once', async () => {
    const t = loadDrive({
      createUrl: () => { throw apiError(500, undefined, undefined, 'Timeout'); },
    });
    const { uploaded, from } = await uploadedFile(t);
    await expect(t.drive.createShareUrl(ACCOUNT_ID, uploaded, { permission: 'viewer', expirationDays: 1 }))
      .rejects.toThrow('Timeout');

    const deletes = t.calls.slice(from).filter((c) => c.method === 'DELETE');
    expect(deletes).toEqual([{
      method: 'DELETE', path: 'drive/shares/share-file', params: { Force: 1 }, data: undefined,
    }]);
  });

  // The password fields make a request of their own (the SRP modulus), after
  // the share exists: its failure must not leave the file shared.
  it('the modulus GET failing before the URL POST still deletes the share with Force=1, once', async () => {
    const t = loadDrive({
      modulus: () => { throw apiError(503, undefined, undefined, 'Service unavailable'); },
    });
    const { uploaded, from } = await uploadedFile(t);
    await expect(t.drive.createShareUrl(ACCOUNT_ID, uploaded, { permission: 'viewer', expirationDays: 1 }))
      .rejects.toMatchObject({ status: 503 });

    const calls = t.calls.slice(from);
    expect(routesOf(calls)).toEqual([
      `POST drive/volumes/${VOLUME_ID}/shares`,
      'GET core/v4/auth/modulus',
      'DELETE drive/shares/share-file',
    ]);
    expect(calls[2]).toEqual({
      method: 'DELETE', path: 'drive/shares/share-file', params: { Force: 1 }, data: undefined,
    });
  });

  it('the modulus GET failing for the custom password deletes the live viewer link, once', async () => {
    let modulusCalls = 0;
    const t = loadDrive({
      modulus: () => {
        modulusCalls += 1;
        if (modulusCalls === 2) throw apiError(429, undefined, undefined, 'Too many requests');
        return { Code: 1000, Modulus: 'MODULUS', ModulusID: 'mod-1' };
      },
    });
    const { uploaded, from } = await uploadedFile(t);
    await expect(t.drive.createShareUrl(ACCOUNT_ID, uploaded,
      { permission: 'viewer', expirationDays: 1, customPassword: 'hunter2' }))
      .rejects.toMatchObject({ status: 429 });

    // The URL exists without the requested password: it goes, with the share.
    const calls = t.calls.slice(from);
    expect(routesOf(calls)).toEqual([
      `POST drive/volumes/${VOLUME_ID}/shares`,
      'GET core/v4/auth/modulus',
      'POST drive/shares/share-file/urls',
      'GET core/v4/auth/modulus',
      'DELETE drive/shares/share-file',
    ]);
    expect(calls[4]).toEqual({
      method: 'DELETE', path: 'drive/shares/share-file', params: { Force: 1 }, data: undefined,
    });
  });

  it('editor refused on a free plan, no password asked: the viewer link stays, nothing deleted', async () => {
    const t = loadDrive({
      updateUrl: () => { throw apiError(422, 200004, {}, 'Editor links need a paid plan'); },
    });
    const { uploaded, from } = await uploadedFile(t);
    const link = await t.drive.createShareUrl(ACCOUNT_ID, uploaded,
      { permission: 'editor', expirationDays: 1, customPassword: '' });

    expect(routesOf(t.calls.slice(from))).toEqual([
      `POST drive/volumes/${VOLUME_ID}/shares`,
      'GET core/v4/auth/modulus',
      'POST drive/shares/share-file/urls',
      'PUT drive/shares/share-file/urls/url-1',
    ]);
    expect(link.url).toMatch(/^https:\/\/drive\.proton\.me\/urls\/TOKEN123#[A-Za-z0-9]{12}$/);
    expect(link.editorDenied).toBe(true);
    expect(link.permission).toBe('viewer');
  });

  it('editor refused on a free plan (200004): keeps the viewer link, still applies the password', async () => {
    const t = loadDrive({
      updateUrl: ({ data }) => {
        if (data.Permissions) throw apiError(422, 200004, {}, 'Editor links need a paid plan');
        return { Code: 1000, ShareURL: shareUrlDto(data) };
      },
    });
    const { uploaded, from } = await uploadedFile(t);
    const link = await t.drive.createShareUrl(ACCOUNT_ID, uploaded,
      { permission: 'editor', expirationDays: 1, customPassword: 'hunter2' });

    const puts = t.calls.slice(from).filter((c) => c.method === 'PUT');
    expect(puts).toHaveLength(2);
    expect(puts[1].data).not.toHaveProperty('Permissions');
    expect(puts[1].data.Flags).toBe(3);
    expect(t.calls.slice(from).filter((c) => c.method === 'DELETE')).toEqual([]);
    expect(link.editorDenied).toBe(true);
    expect(link.permission).toBe('viewer');
    expect(link.hasCustomPassword).toBe(true);
  });

  it('editor refused, then the password-only retry fails: the same single Force=1 teardown', async () => {
    const t = loadDrive({
      updateUrl: ({ data }) => {
        if (data.Permissions) throw apiError(422, 200004, {}, 'Editor links need a paid plan');
        throw apiError(500, undefined, undefined, 'Retry failed');
      },
    });
    const { uploaded, from } = await uploadedFile(t);
    await expect(t.drive.createShareUrl(ACCOUNT_ID, uploaded,
      { permission: 'editor', expirationDays: 1, customPassword: 'hunter2' }))
      .rejects.toThrow('Retry failed');

    const deletes = t.calls.slice(from).filter((c) => c.method === 'DELETE');
    expect(deletes).toEqual([{
      method: 'DELETE', path: 'drive/shares/share-file', params: { Force: 1 }, data: undefined,
    }]);
  });
});

// ---------------------------------------------------------------------------
// Custom password cap
// ---------------------------------------------------------------------------

describe('custom link password: at most 50 characters (MAX_SHARED_URL_PASSWORD_LENGTH)', () => {
  it('createShareUrl refuses 51 characters before creating anything', async () => {
    const t = loadDrive();
    const { folder } = await readyFolder(t);
    const uploaded = await uploadSmall(t, folder);
    const from = t.calls.length;
    await expect(t.drive.createShareUrl(ACCOUNT_ID, uploaded,
      { permission: 'viewer', expirationDays: 1, customPassword: 'x'.repeat(51) }))
      .rejects.toMatchObject({ message: 'DRIVE_PASSWORD_TOO_LONG', code: 'DRIVE_PASSWORD_TOO_LONG' });
    expect(t.calls.length).toBe(from);
  });

  it('startJob refuses 51 characters before bootstrap or folder, so the picker never opens', async () => {
    const t = loadDrive();
    await expect(t.drive.startJob(ACCOUNT_ID, { permission: 'viewer', customPassword: 'x'.repeat(51) }))
      .rejects.toThrow('DRIVE_PASSWORD_TOO_LONG');
    expect(t.calls).toEqual([]);
  });

  it('startJob with a 50-character password goes on to bootstrap and the folder', async () => {
    const t = loadDrive();
    const res = await t.drive.startJob(ACCOUNT_ID, { permission: 'viewer', customPassword: 'x'.repeat(50) });
    expect(res.uploadId).toMatch(/^drv-/);
    expect(routesOf(t.calls)).toEqual([
      'GET drive/v2/shares/my-files',
      'GET core/v4/addresses',
      `POST drive/v2/volumes/${VOLUME_ID}/folders`,
    ]);
  });
});

// ---------------------------------------------------------------------------
// The whole flow, as one route map
// ---------------------------------------------------------------------------

describe('one file, end to end', () => {
  it('uses exactly these routes, in this order, and none of the deprecated ones', async () => {
    const t = loadDrive();
    const { folder } = await readyFolder(t);
    const uploaded = await uploadSmall(t, folder);
    await t.drive.createShareUrl(ACCOUNT_ID, uploaded, { permission: 'viewer', expirationDays: 30 });

    expect(routesOf(t.calls)).toEqual([
      'GET drive/v2/shares/my-files',
      'GET core/v4/addresses',
      `POST drive/v2/volumes/${VOLUME_ID}/folders`,
      `POST drive/v2/volumes/${VOLUME_ID}/links/folder-new/checkAvailableHashes`,
      `POST drive/v2/volumes/${VOLUME_ID}/files`,
      `GET drive/v2/volumes/${VOLUME_ID}/links/file-1/revisions/rev-1/verification`,
      'POST drive/blocks',
      `PUT drive/v2/volumes/${VOLUME_ID}/files/file-1/revisions/rev-1`,
      `POST drive/volumes/${VOLUME_ID}/shares`,
      'GET core/v4/auth/modulus',
      'POST drive/shares/share-file/urls',
    ]);
    expectNoLegacyRoutes(t.calls);
  });
});
