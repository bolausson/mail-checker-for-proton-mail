/**
 * ProtonDrive: "Share via Proton Drive" client.
 *
 * Uploads files into the user's Proton Drive (E2E-encrypted, byte-compatible
 * with the official web client) and creates public share URLs for them, so the
 * compose/reply editors can insert a link instead of attaching the file.
 *
 * Wire protocol mirrors Proton's Drive SDK (@protontech/drive-sdk, source at
 * github.com/ProtonDriveApps/sdk), which the Drive web app now uploads and
 * shares through. Node routes are the volume-scoped drive/v2 ones: Proton
 * deprecated the share-scoped routes on 2026-01-14.
 *   - bootstrap: my-files (volume + main share + root folder) → share key →
 *                root node key → hash key
 *   - folder:    create, or reuse the folder a name conflict points at
 *   - upload:    file draft → verification data → 4 MiB encrypted blocks
 *                (session-key encryption + detached address-key signature +
 *                verifier token) → storage BareURL POSTs → revision commit
 *                with manifest signature + XAttr
 *   - share URL: per-file share (volume-scoped) → SRP-protected URL with
 *                viewer/editor permission, expiration and optional custom
 *                password (generated 12-char password rides in the #fragment)
 *
 * Large files are pulled from the picker tab chunk-by-chunk over a
 * runtime.Port ("mcpm-drive-upload"), so at most one block batch is resident
 * in memory; the open port also keeps the Chrome MV3 service worker alive.
 * Completed links are persisted encrypted (pendingDriveLinks) as each file
 * finishes, so a closed popup or SW restart never loses finished work.
 *
 * Dependencies (globals): openpgp, ProtonAccounts (request/getAccount/
 * ensureKeysUnlocked), ProtonAuth (buildEoAuthFromModulus/computeKeyPassword),
 * ProtonBinary, ProtonConfig, ProtonPremium, ProtonDiag, ExtEncryption.
 */
const ProtonDrive = (() => {
  'use strict';

  const FILE_CHUNK_SIZE = 4 * 1024 * 1024; // Proton Drive block size (FILE_CHUNK_SIZE)
  const BLOCK_BATCH = 4;                   // blocks encrypted+uploaded per drive/blocks request
  const GENERATED_PW_LEN = 12;             // SHARE_GENERATED_PASSWORD_LENGTH
  const MAX_CUSTOM_PW_LEN = 50;            // MAX_SHARED_URL_PASSWORD_LENGTH (Drive sharing UI)
  const MAX_EXPIRATION_DAYS = 90;          // server maximum for link expiry
  const EXPIRATION_MARGIN_S = 3600;        // ExpirationTime stays this far under that maximum
  const CHUNK_TIMEOUT_MS = 60000;          // picker tab must answer NEED_CHUNK within this
  const LINKS_BATCH = 100;                 // link IDs per drive/v2 links request (the SDK's batch)
  const MAX_CHILDREN_PAGES = 40;           // folder-listing fallback gives up after this many pages
  const PERMISSIONS = { viewer: 4, editor: 6 }; // SHARE_URL_PERMISSIONS (READ=4, READ|WRITE=6)
  const FLAG_GENERATED = 2;                // SharedURLFlags.GeneratedPasswordIncluded
  const FLAG_GENERATED_CUSTOM = 3;         // ...| CustomPassword
  const CODE_ALREADY_EXISTS = 2500;        // API_CUSTOM_ERROR_CODES.ALREADY_EXISTS
  const CODE_NOT_EXISTS = 2501;            // ErrorCode.NOT_EXISTS (my-files: no active volume yet)
  const CODE_EDITOR_NEEDS_PAID = 200004;   // MAX_PUBLIC_EDIT_MODE_FOR_FREE_USER
  const CODE_INSUFFICIENT_QUOTA = 200002;  // FREE_SPACE_EXCEEDED / INSUFFICIENT_STORAGE
  const ERR_PASSWORD_TOO_LONG = 'DRIVE_PASSWORD_TOO_LONG'; // popup localizes this code
  const PUBLIC_URL_BASE = 'https://drive.proton.me/urls/';
  const DEFAULT_FOLDER = 'mcpm-shared-files';

  // ---------------------------------------------------------------------------
  // Pure helpers (exported for unit tests)
  // ---------------------------------------------------------------------------

  /** Per-block verifier token: VerificationCode XOR ciphertext prefix (0-padded). */
  function _verifierToken(verificationCode, encryptedData) {
    const out = new Uint8Array(verificationCode.length);
    for (let i = 0; i < verificationCode.length; i++) {
      out[i] = verificationCode[i] ^ (encryptedData[i] || 0);
    }
    return out;
  }

  /** Effective share-URL password + Flags for optional custom password. */
  function _fullPasswordAndFlags(generated, custom) {
    if (custom) return { password: generated + custom, flags: FLAG_GENERATED_CUSTOM };
    return { password: generated, flags: FLAG_GENERATED };
  }

  /**
   * Days → ExpirationTime in absolute unix seconds (null = never), as the SDK
   * sends it. Whole days, rounded up: a custom date arrives as the fraction of
   * days to midnight at the START of the picked day (the picker has no time),
   * and rounding up moves the expiry onto that date, at the time of sharing.
   * The server allows at most now + 90 days by ITS clock, so the cap keeps an
   * hour of margin for a client clock running ahead.
   */
  function _expirationTime(days, nowMs) {
    const n = Number(days);
    if (!n || n <= 0 || !Number.isFinite(n)) return null;
    const maxSeconds = MAX_EXPIRATION_DAYS * 24 * 3600 - EXPIRATION_MARGIN_S;
    return Math.floor(nowMs / 1000) + Math.min(Math.ceil(n) * 24 * 3600, maxSeconds);
  }

  /**
   * The custom link password as used: '' when blank, else the value as typed.
   * Throws past 50 characters: Drive's own sharing UI refuses to save the
   * link's settings with a longer one.
   */
  function _customLinkPassword(value) {
    const custom = String(value || '').trim() ? String(value) : '';
    if (custom.length > MAX_CUSTOM_PW_LEN) {
      const err = new Error(ERR_PASSWORD_TOO_LONG);
      err.code = ERR_PASSWORD_TOO_LONG;
      throw err;
    }
    return custom;
  }

  /** Split "archive.tar.gz" → { base: "archive.tar", ext: ".gz" } (last-dot split,
   *  names starting with '.' keep the dot in the base, mirrors WebClients). */
  function _splitName(name) {
    const i = name.lastIndexOf('.');
    if (i <= 0) return { base: name, ext: '' };
    return { base: name.slice(0, i), ext: name.slice(i) };
  }

  /** Dedupe candidate n for a taken name: 0 → "a.txt", 2 → "a (2).txt". */
  function _adjustName(index, base, ext) {
    return index === 0 ? base + ext : `${base} (${index})${ext}`;
  }

  /** Plaintext block sizes for the XAttr Common.BlockSizes array. */
  function _blockSizes(totalSize) {
    const sizes = [];
    for (let off = 0; off < totalSize; off += FILE_CHUNK_SIZE) {
      sizes.push(Math.min(FILE_CHUNK_SIZE, totalSize - off));
    }
    return sizes;
  }

  /** Split a settings folder path ("a/b/c", tolerant of extra slashes) into segments. */
  function _splitFolderPath(path) {
    return String(path || '').split('/').map((s) => s.trim()).filter(Boolean);
  }

  // ---------------------------------------------------------------------------
  // Small crypto/binary utilities
  // ---------------------------------------------------------------------------

  const _b64 = (u8) => ProtonBinary.uint8ToBase64(u8);
  const _fromB64 = (s) => ProtonBinary.base64ToUint8(s);

  function _randomPassphrase() {
    // generatePassphrase(): base64 of 32 random bytes (calendarKeys.ts)
    return _b64(crypto.getRandomValues(new Uint8Array(32)));
  }

  /** Random [A-Za-z0-9] string (getRandomString charset), rejection-sampled. */
  function _randomString(len) {
    const charset = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let out = '';
    while (out.length < len) {
      const bytes = crypto.getRandomValues(new Uint8Array(len * 2));
      for (const b of bytes) {
        if (b < 248 && out.length < len) out += charset[b % 62]; // 248 = 62*4 → unbiased
      }
    }
    return out;
  }

  async function _sha256(bytes) {
    return new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  }

  /** HMAC-SHA256(name) keyed with the parent folder's hash key → hex (generateLookupHash). */
  async function _lookupHash(name, hashKeyBytes) {
    const key = await crypto.subtle.importKey(
      'raw', hashKeyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(name));
    return ProtonBinary.bytesToHex(new Uint8Array(sig));
  }

  /** pmcrypto stripTrailingSpaces: trailing whitespace removed per line. */
  function _stripTrailingSpaces(text) {
    return String(text).split('\n').map((l) => l.replace(/\s+$/, '')).join('\n');
  }

  /** Decrypt an armored message with any of the given private keys (decryptUnsigned). */
  async function _decryptUnsigned(armoredMessage, privateKeys, format) {
    const message = await openpgp.readMessage({ armoredMessage });
    const { data } = await openpgp.decrypt({
      message,
      decryptionKeys: privateKeys,
      format: format || 'utf8',
    });
    return data;
  }

  /** Unlock an armored locked private key with its passphrase. */
  async function _unlockArmoredKey(armoredKey, passphrase) {
    const privateKey = await openpgp.readPrivateKey({ armoredKey });
    return openpgp.decryptKey({ privateKey, passphrase });
  }

  /**
   * generateNodeKeys: fresh Curve25519 key locked with a random passphrase; the
   * passphrase is encrypted to the parent key(s) (explicit session key, retained
   * for later share creation) and signed detached by the address key.
   */
  async function _generateNodeKeys(parentKeys, addressKey) {
    const parents = (Array.isArray(parentKeys) ? parentKeys : [parentKeys]).map((k) => k.toPublic());
    const rawPassphrase = _randomPassphrase();

    const { privateKey } = await openpgp.generateKey({
      type: 'ecc', curve: 'ed25519Legacy',
      userIDs: [{ name: 'Drive key' }],
      format: 'object',
    });
    const locked = await openpgp.encryptKey({ privateKey, passphrase: rawPassphrase });

    const sessionKey = await openpgp.generateSessionKey({ encryptionKeys: parents });
    const NodePassphrase = await openpgp.encrypt({
      message: await openpgp.createMessage({ text: rawPassphrase }),
      sessionKey, encryptionKeys: parents,
    });
    const NodePassphraseSignature = await openpgp.sign({
      message: await openpgp.createMessage({ text: rawPassphrase }),
      signingKeys: addressKey, detached: true,
    });

    return {
      privateKey,
      NodeKey: locked.armor(),
      NodePassphrase,
      NodePassphraseSignature,
      sessionKey,
    };
  }

  /** encryptName: PGP-encrypt a node name to the parent key, signed by the address
   *  key; the explicit session key is retained (NameKeyPacket needs it later). */
  async function _encryptName(name, parentPublicKey, addressKey) {
    const sessionKey = await openpgp.generateSessionKey({ encryptionKeys: parentPublicKey });
    const armored = await openpgp.encrypt({
      message: await openpgp.createMessage({ text: _stripTrailingSpaces(name) }),
      sessionKey, encryptionKeys: parentPublicKey, signingKeys: addressKey,
    });
    return { armored, sessionKey };
  }

  /** generateContentKeys: content session key + key packet + signature for a new file. */
  async function _generateContentKeys(nodePrivateKey) {
    const pub = nodePrivateKey.toPublic();
    const sessionKey = await openpgp.generateSessionKey({ encryptionKeys: pub });
    const packet = await openpgp.encryptSessionKey({
      data: sessionKey.data, algorithm: sessionKey.algorithm,
      encryptionKeys: pub, format: 'binary',
    });
    const ContentKeyPacketSignature = await openpgp.sign({
      message: await openpgp.createMessage({ binary: sessionKey.data }),
      signingKeys: nodePrivateKey, detached: true,
    });
    return { sessionKey, ContentKeyPacket: _b64(packet), ContentKeyPacketSignature };
  }

  // ---------------------------------------------------------------------------
  // API plumbing
  // ---------------------------------------------------------------------------

  function _req(accountId, method, path, opts) {
    return ProtonAccounts.request(accountId, method, path, opts || {});
  }

  /** Map a raw API/network error to a { code, message } the UI can localize. */
  function _friendlyError(err) {
    const code = err && err.code;
    if (code === CODE_INSUFFICIENT_QUOTA ||
        /quota|storage.*full|not enough space/i.test((err && err.message) || '')) {
      return { code: 'DRIVE_QUOTA', message: err.message };
    }
    if (err && err.permanentAuth) return { code: 'DRIVE_AUTH', message: err.message };
    return { code: 'DRIVE_ERROR', message: (err && err.message) || 'Upload failed' };
  }

  // ---------------------------------------------------------------------------
  // Bootstrap: my-files → share key → root folder keys (cached per account)
  // ---------------------------------------------------------------------------

  // accountId → Promise<ctx>; memory-only, re-derived after a SW restart.
  // ctx = { volumeId, shareId, addressId, addressEmail, addressKey, shareKey,
  //         rootLinkId, rootKey, rootHashKey, folders: { [path]: folderCtx } }
  // folderCtx = { linkId, key, hashKey }
  const _ctx = {};

  function bootstrap(accountId) {
    if (_ctx[accountId]) return _ctx[accountId];
    const p = _doBootstrap(accountId).catch((err) => {
      delete _ctx[accountId]; // don't cache failures
      throw err;
    });
    _ctx[accountId] = p;
    return p;
  }

  /**
   * my-files answers Code 2501 while the account has no active main volume.
   * An HTTP 404 means a missing route instead: the SDK's apiErrorFactory draws
   * the same line, so only the coded answer may create a volume.
   */
  function _isNoActiveVolume(err) {
    return !!err && err.code === CODE_NOT_EXISTS && err.status !== 404;
  }

  async function _doBootstrap(accountId) {
    await ProtonAccounts.ensureKeysUnlocked(accountId);
    const account = ProtonAccounts.getAccount(accountId);
    if (!account) throw new Error('Account not found');
    if (!account.decryptedKeys || account.decryptedKeys.length === 0) {
      throw new Error('Keys are locked');
    }

    // 1. Volume, main share and root folder in one call, the way the Drive SDK
    //    bootstraps (shares/manager.ts getRootIDs).
    let mine;
    try {
      mine = await _req(accountId, 'GET', 'drive/v2/shares/my-files');
    } catch (err) {
      if (!_isNoActiveVolume(err)) throw err;
      // Account has never used Proton Drive: create its main volume, as the
      // SDK does on this answer. Its keys are made right there, so the result
      // is already a complete context with nothing to fetch or unlock.
      const created = await _createVolume(accountId, account);
      debugLog('[ProtonDrive] Bootstrapped', { volumeId: created.volumeId, shareId: created.shareId });
      return { ...created, folders: {} };
    }
    if (!mine || !mine.Volume || !mine.Share || !mine.Link || !mine.Link.Link) {
      throw new Error('Unexpected Drive bootstrap response');
    }
    const share = mine.Share;
    const root = mine.Link; // { Link, Folder }: the root folder's details

    // 2. Address the share belongs to (for signing + CreatorEmail); fall back to
    // the primary address if the AddressID no longer resolves.
    const addrRes = await _req(accountId, 'GET', 'core/v4/addresses');
    const addresses = (addrRes && addrRes.Addresses) || [];
    const shareAddr = addresses.find((a) => a.ID === share.AddressID) || addresses[0];
    if (!shareAddr) throw new Error('No address found for Drive share');
    const addressEmail = shareAddr.Email;
    const addressKey =
      (account.addressKeyMap && account.addressKeyMap[addressEmail.toLowerCase()]) ||
      account.decryptedKeys[0];

    // 3. Share passphrase (decrypted with the address keys) → share key.
    const allKeys = Object.values(account.addressKeyMap || {}).concat(account.decryptedKeys || []);
    const sharePassphrase = await _decryptUnsigned(share.Passphrase, allKeys);
    const shareKey = await _unlockArmoredKey(share.Key, sharePassphrase);

    // 4. Root folder (same response) → node key + hash key.
    const rootPassphrase = await _decryptUnsigned(
      root.Link.NodePassphrase, [shareKey].concat(allKeys));
    const rootKey = await _unlockArmoredKey(root.Link.NodeKey, rootPassphrase);
    const hashKeyArmored = root.Folder && root.Folder.NodeHashKey;
    if (!hashKeyArmored) throw new Error('Drive root folder has no hash key');
    const rootHashKey = await _decryptUnsigned(hashKeyArmored, [rootKey], 'binary');

    const volumeId = mine.Volume.VolumeID;
    const shareId = share.ShareID;
    debugLog('[ProtonDrive] Bootstrapped', { volumeId, shareId });
    return {
      volumeId, shareId,
      addressId: share.AddressID || shareAddr.ID,
      addressEmail, addressKey, shareKey,
      rootLinkId: root.Link.LinkID, rootKey, rootHashKey,
      folders: {},
    };
  }

  /**
   * First-use bootstrap: create the account's main Drive volume (share key
   * from the primary address key, root folder "root" under it). Mirrors the
   * SDK's SharesManager.createVolume. Returns the full bootstrap context: every
   * key in it was generated here.
   */
  async function _createVolume(accountId, account) {
    const addrRes = await _req(accountId, 'GET', 'core/v4/addresses');
    const address = ((addrRes && addrRes.Addresses) || [])[0];
    if (!address) throw new Error('No address available to create a Drive volume');
    const addressKey =
      (account.addressKeyMap && account.addressKeyMap[address.Email.toLowerCase()]) ||
      account.decryptedKeys[0];
    // AddressKeyID must name the key we actually sign with, not merely the one
    // flagged Primary: addressKeyMap holds the first primary that DECRYPTED, so
    // when the flagged primary is unusable (rotated, or post-quantum) the two
    // would name different keys and Proton would verify against the wrong one.
    // Match on the key material itself rather than trusting the flag twice.
    let addressKeyMeta = null;
    const wantFp = addressKey && addressKey.getFingerprint ? addressKey.getFingerprint() : null;
    if (wantFp) {
      for (const k of (address.Keys || [])) {
        if (!k.PrivateKey) continue;
        try {
          const parsed = await openpgp.readKey({ armoredKey: k.PrivateKey });
          if (parsed.getFingerprint() === wantFp) { addressKeyMeta = k; break; }
        } catch (e) {
          // Unreadable (post-quantum, or corrupt): it cannot be the key we
          // signed with, so skipping it is correct.
        }
      }
    }
    if (!addressKeyMeta) {
      addressKeyMeta = (address.Keys || []).find((k) => k.Primary === 1) || (address.Keys || [])[0];
    }

    const share = await _generateNodeKeys(addressKey, addressKey);
    const folder = await _generateNodeKeys(share.privateKey, addressKey);
    const { armored: FolderName } = await _encryptName('root', share.privateKey.toPublic(), addressKey);
    const hashKeyPassphrase = _randomPassphrase();
    const FolderHashKey = await openpgp.encrypt({
      message: await openpgp.createMessage({ text: hashKeyPassphrase }),
      encryptionKeys: folder.privateKey.toPublic(),
      signingKeys: folder.privateKey,
    });

    const res = await _req(accountId, 'POST', 'drive/volumes', {
      data: {
        AddressID: address.ID,
        AddressKeyID: addressKeyMeta ? addressKeyMeta.ID : undefined,
        ShareKey: share.NodeKey,
        SharePassphrase: share.NodePassphrase,
        SharePassphraseSignature: share.NodePassphraseSignature,
        FolderKey: folder.NodeKey,
        FolderPassphrase: folder.NodePassphrase,
        FolderPassphraseSignature: folder.NodePassphraseSignature,
        FolderName,
        FolderHashKey,
      },
    });
    debugLog('[ProtonDrive] Created main volume for first Drive use');
    // Volume.ID and Share.ID are deprecated aliases of VolumeID and ShareID.
    const volume = res.Volume;
    return {
      volumeId: volume.VolumeID || volume.ID,
      shareId: volume.Share.ShareID || volume.Share.ID,
      addressId: address.ID,
      addressEmail: address.Email,
      addressKey,
      shareKey: share.privateKey,
      rootLinkId: volume.Share.LinkID,
      rootKey: folder.privateKey,
      // HMAC key bytes = utf8 of the hash-key passphrase text (as _createFolder).
      rootHashKey: new TextEncoder().encode(hashKeyPassphrase),
    };
  }

  // ---------------------------------------------------------------------------
  // Folders: find-or-create (per path segment)
  // ---------------------------------------------------------------------------

  /** Link details ({ Link, Folder | File }) for up to LINKS_BATCH link IDs. */
  async function _loadLinks(accountId, ctx, linkIds) {
    const res = await _req(accountId, 'POST', `drive/v2/volumes/${ctx.volumeId}/links`,
      { data: { LinkIDs: linkIds } });
    return (res && res.Links) || [];
  }

  /** An active folder (Type 1, State 1) with this lookup hash. A trashed or
   *  draft link has the right name but cannot take uploads. */
  function _isActiveFolder(details, hash) {
    const link = details && details.Link;
    return !!link && link.Type === 1 && link.State === 1 && link.NameHash === hash;
  }

  /**
   * The existing child folder with this lookup hash, or null. A name conflict
   * names it (Details.ConflictLinkID), so one lookup is enough, as in the SDK.
   * Without that ID, page the children listing (IDs only) and load the details.
   */
  async function _findChildFolder(accountId, ctx, parent, hash, conflictLinkId) {
    if (conflictLinkId) {
      const links = await _loadLinks(accountId, ctx, [conflictLinkId]);
      return links.find((d) => _isActiveFolder(d, hash)) || null;
    }
    let anchor = null;
    for (let page = 0; page < MAX_CHILDREN_PAGES; page++) {
      const params = { FoldersOnly: 1 };
      if (anchor) params.AnchorID = anchor;
      const res = await _req(accountId, 'GET',
        `drive/v2/volumes/${ctx.volumeId}/folders/${parent.linkId}/children`, { params });
      const ids = (res && res.LinkIDs) || [];
      for (let i = 0; i < ids.length; i += LINKS_BATCH) {
        const links = await _loadLinks(accountId, ctx, ids.slice(i, i + LINKS_BATCH));
        const match = links.find((d) => _isActiveFolder(d, hash));
        if (match) return match;
      }
      if (!res || !res.More || !res.AnchorID) return null;
      anchor = res.AnchorID;
    }
    return null;
  }

  /** Unlock a folder (node key + hash key) from its link details. */
  async function _unlockFolderLink(ctx, parent, details) {
    const link = details.Link;
    const passphrase = await _decryptUnsigned(link.NodePassphrase, [parent.key, ctx.addressKey]);
    const key = await _unlockArmoredKey(link.NodeKey, passphrase);
    const hashArmored = details.Folder && details.Folder.NodeHashKey;
    if (!hashArmored) throw new Error('Drive folder has no hash key');
    const hashKey = await _decryptUnsigned(hashArmored, [key], 'binary');
    return { linkId: link.LinkID, key, hashKey };
  }

  async function _createFolder(accountId, ctx, parent, name, hash) {
    const keys = await _generateNodeKeys(parent.key, ctx.addressKey);
    const { armored: encName } = await _encryptName(name, parent.key.toPublic(), ctx.addressKey);

    // NodeHashKey: random passphrase encrypted+signed with the NEW folder's own
    // key (not the address key), as the SDK's generateHashKey does.
    const hashKeyPassphrase = _randomPassphrase();
    const NodeHashKey = await openpgp.encrypt({
      message: await openpgp.createMessage({ text: hashKeyPassphrase }),
      encryptionKeys: keys.privateKey.toPublic(),
      signingKeys: keys.privateKey,
    });

    // The spec's CreateFolderDto calls the signer SignatureAddress, but both
    // Drive SDKs (JS and C#) send SignatureEmail to this route: follow the
    // clients Proton runs in production.
    const res = await _req(accountId, 'POST', `drive/v2/volumes/${ctx.volumeId}/folders`, {
      data: {
        Name: encName,
        Hash: hash,
        ParentLinkID: parent.linkId,
        NodeKey: keys.NodeKey,
        NodePassphrase: keys.NodePassphrase,
        NodePassphraseSignature: keys.NodePassphraseSignature,
        SignatureEmail: ctx.addressEmail,
        NodeHashKey,
      },
    });
    return {
      linkId: res.Folder.ID,
      key: keys.privateKey,
      // The HMAC key bytes are the utf8 bytes of the (base64) passphrase text,
      // exactly what a later decrypt(format:'binary') of NodeHashKey yields.
      hashKey: new TextEncoder().encode(hashKeyPassphrase),
    };
  }

  /**
   * Find-or-create one folder level the way the Drive web app merges an
   * uploaded folder into an existing one: create it, and on a name conflict
   * reuse the folder the conflict points at. A name pre-check could not say
   * WHICH link holds the name, so it would only add a call.
   */
  async function _ensureChildFolder(accountId, ctx, parent, name) {
    const hash = await _lookupHash(name, parent.hashKey);
    try {
      return await _createFolder(accountId, ctx, parent, name, hash);
    } catch (err) {
      if (!err || err.code !== CODE_ALREADY_EXISTS) throw err;
      const existing = await _findChildFolder(accountId, ctx, parent, hash,
        err.details && err.details.ConflictLinkID);
      if (existing) return _unlockFolderLink(ctx, parent, existing);
      // Taken by a file, a pending draft or a trashed folder: nothing to reuse,
      // so the conflict itself is the error the user sees.
      throw err;
    }
  }

  /** Find-or-create the target folder (supports "a/b/c" paths); cached per account. */
  async function ensureFolder(accountId, path) {
    const ctx = await bootstrap(accountId);
    const segments = _splitFolderPath(path);
    if (segments.length === 0) segments.push(DEFAULT_FOLDER);
    const cacheKey = segments.join('/');
    if (ctx.folders[cacheKey]) return ctx.folders[cacheKey];

    let parent = { linkId: ctx.rootLinkId, key: ctx.rootKey, hashKey: ctx.rootHashKey };
    for (const segment of segments) {
      parent = await _ensureChildFolder(accountId, ctx, parent, segment);
    }
    ctx.folders[cacheKey] = parent;
    return parent;
  }

  // ---------------------------------------------------------------------------
  // File upload
  // ---------------------------------------------------------------------------

  /** Pick a free name in the folder: "name.ext", "name (1).ext", … */
  async function _findAvailableName(accountId, ctx, folder, filename) {
    const { base, ext } = _splitName(filename);
    for (let start = 0; start < 64; start += 8) {
      const candidates = [];
      for (let i = start; i < start + 8; i++) {
        const name = _adjustName(i, base, ext);
        candidates.push({ name, hash: await _lookupHash(name, folder.hashKey) });
      }
      // ClientUID null, as the SDK sends it without a client UID.
      const res = await _req(accountId, 'POST',
        `drive/v2/volumes/${ctx.volumeId}/links/${folder.linkId}/checkAvailableHashes`,
        { data: { Hashes: candidates.map((c) => c.hash), ClientUID: null } });
      const available = (res && res.AvailableHashes) || [];
      const found = candidates.find((c) => available.includes(c.hash));
      if (found) return found;
    }
    throw new Error('No available filename (too many duplicates)');
  }

  /** Encrypt one block; retries on verifier-decrypt failure (bitflip guard). */
  async function _encryptBlock(chunk, sessionKey, addressKey, nodePublicKey, verifier) {
    for (let attempt = 0; attempt < 3; attempt++) {
      const encryptedData = await openpgp.encrypt({
        message: await openpgp.createMessage({ binary: chunk }),
        sessionKey, format: 'binary',
      });
      try {
        // Sanity decrypt with the SERVER-provided key packet's session key:
        // detects bitflips and a wrong content key before bytes are committed.
        await openpgp.decrypt({
          message: await openpgp.readMessage({ binaryMessage: encryptedData }),
          sessionKeys: verifier.sessionKey, format: 'binary',
        });
      } catch (e) {
        debugLog('[ProtonDrive] Block verification failed, re-encrypting', attempt, e.message);
        continue;
      }
      const signature = await openpgp.sign({
        message: await openpgp.createMessage({ binary: chunk }),
        signingKeys: addressKey, detached: true, format: 'binary',
      });
      const EncSignature = await openpgp.encrypt({
        message: await openpgp.createMessage({ binary: signature }),
        sessionKey, encryptionKeys: nodePublicKey,
      });
      return {
        encryptedData,
        hash: await _sha256(encryptedData),
        EncSignature,
        token: _verifierToken(verifier.code, encryptedData),
      };
    }
    throw new Error('Upload failed: Verification of data failed');
  }

  /** POST one encrypted block to its storage BareURL (pm-storage-token auth). */
  async function _uploadBlockData(bareUrl, token, encryptedData, signal) {
    try {
      const host = new URL(bareUrl).host;
      if (!host.endsWith('.proton.me')) {
        // host_permissions only covers *.proton.me: record it so a CORS
        // failure below is diagnosable (and we learn the real storage domain).
        ProtonDiag.record('drive.bareurl_offhost', { host });
      }
    } catch (_) { /* diagnostics only */ }

    const form = new FormData();
    form.append('Block', new Blob([encryptedData]), 'blob');
    const headers = ProtonConfig.buildHeaders(null, null);
    delete headers['Content-Type']; // browser sets the multipart boundary
    headers['pm-storage-token'] = token;

    const res = await fetch(bareUrl, {
      method: 'POST', headers, body: form, credentials: 'omit', signal,
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      const err = new Error(body.Error || `Block upload failed (${res.status})`);
      err.status = res.status; err.code = body.Code;
      throw err;
    }
  }

  /**
   * Upload one file into `folder`.
   * @param {function(number, number): Promise<Uint8Array>} readChunk (offset, length)
   * @param {function(number): void} [onProgress] fraction 0..1 (upload phase)
   * @returns {Promise<{linkId, revisionId, name, nodeKey, passphraseSessionKey, nameSessionKey}>}
   */
  async function uploadFile(accountId, folder, meta, readChunk, onProgress, signal) {
    const ctx = await bootstrap(accountId);
    const size = meta.size || 0;

    // a. Name dedupe + b. node/content keys
    const { name, hash } = await _findAvailableName(accountId, ctx, folder, meta.name);
    const keys = await _generateNodeKeys(folder.key, ctx.addressKey);
    const { armored: encName, sessionKey: nameSessionKey } =
      await _encryptName(name, folder.key.toPublic(), ctx.addressKey);
    const content = await _generateContentKeys(keys.privateKey);

    // c. Create the file draft
    const created = await _req(accountId, 'POST', `drive/v2/volumes/${ctx.volumeId}/files`, {
      data: {
        Name: encName,
        Hash: hash,
        ParentLinkID: folder.linkId,
        NodeKey: keys.NodeKey,
        NodePassphrase: keys.NodePassphrase,
        NodePassphraseSignature: keys.NodePassphraseSignature,
        SignatureAddress: ctx.addressEmail,
        MIMEType: meta.mimeType || 'application/octet-stream',
        ContentKeyPacket: content.ContentKeyPacket,
        ContentKeyPacketSignature: content.ContentKeyPacketSignature,
      },
    });
    const linkId = created.File.ID;
    const revisionId = created.File.RevisionID;

    try {
      // d. Verification data (anti-tamper; server re-serves our key packet)
      const verRes = await _req(accountId, 'GET',
        `drive/v2/volumes/${ctx.volumeId}/links/${linkId}/revisions/${revisionId}/verification`);
      const verifierKeys = await openpgp.decryptSessionKeys({
        message: await openpgp.readMessage({ binaryMessage: _fromB64(verRes.ContentKeyPacket) }),
        decryptionKeys: keys.privateKey,
      });
      const verifier = { code: _fromB64(verRes.VerificationCode), sessionKey: verifierKeys[0] };

      // e/f. Encrypt + upload blocks in batches
      const nodePublicKey = keys.privateKey.toPublic();
      const blockHashes = [];
      let index = 0; let uploadedBytes = 0;
      let batch = [];

      const flushBatch = async () => {
        if (batch.length === 0) return;
        // VolumeID locates the revision (ShareID is deprecated). The server
        // computes each block's Hash and Size itself, so neither is sent; the
        // hashes are still ours to sign in the manifest.
        const res = await _req(accountId, 'POST', 'drive/blocks', {
          data: {
            AddressID: ctx.addressId,
            VolumeID: ctx.volumeId,
            LinkID: linkId,
            RevisionID: revisionId,
            BlockList: batch.map((b) => ({
              Index: b.index,
              EncSignature: b.EncSignature,
              Verifier: { Token: _b64(b.token) },
            })),
            ThumbnailList: [],
          },
        });
        // Pair blocks with upload URLs by Index, as the SDK does: the order
        // of UploadLinks is not part of the contract.
        const byIndex = new Map(((res && res.UploadLinks) || []).map((l) => [l.Index, l]));
        const targets = batch.map((b) => {
          const target = byIndex.get(b.index);
          if (!target) throw new Error(`Drive returned no upload URL for block ${b.index}`);
          return target;
        });
        await Promise.all(batch.map((b, i) =>
          _uploadBlockData(targets[i].BareURL, targets[i].Token, b.encryptedData, signal)));
        for (const b of batch) {
          uploadedBytes += b.plainSize;
          if (onProgress && size > 0) onProgress(Math.min(1, uploadedBytes / size));
        }
        batch = [];
      };

      // Empty files still need a committed revision (no blocks, empty manifest).
      for (let offset = 0; offset < size; offset += FILE_CHUNK_SIZE) {
        if (signal && signal.aborted) throw new Error('Cancelled');
        const len = Math.min(FILE_CHUNK_SIZE, size - offset);
        const chunk = await readChunk(offset, len);
        if (!chunk || chunk.length !== len) throw new Error('Chunk read failed');
        index += 1;
        const enc = await _encryptBlock(chunk, content.sessionKey, ctx.addressKey, nodePublicKey, verifier);
        blockHashes.push(enc.hash);
        batch.push({ ...enc, index, plainSize: len });
        if (batch.length >= BLOCK_BATCH) await flushBatch();
      }
      await flushBatch();

      // g. Commit: manifest signature over concatenated block hashes + XAttr
      const manifest = new Uint8Array(blockHashes.reduce((n, h) => n + h.length, 0));
      let mOff = 0;
      for (const h of blockHashes) { manifest.set(h, mOff); mOff += h.length; }
      const ManifestSignature = await openpgp.sign({
        message: await openpgp.createMessage({ binary: manifest }),
        signingKeys: ctx.addressKey, detached: true,
      });
      const xattrJson = JSON.stringify({
        Common: {
          ModificationTime: new Date(meta.modTime || Date.now()).toISOString(),
          Size: size,
          BlockSizes: _blockSizes(size),
        },
      });
      const XAttr = await openpgp.encrypt({
        message: await openpgp.createMessage({ text: xattrJson }),
        encryptionKeys: nodePublicKey, signingKeys: ctx.addressKey,
      });
      await _req(accountId, 'PUT',
        `drive/v2/volumes/${ctx.volumeId}/files/${linkId}/revisions/${revisionId}`, {
          data: { ManifestSignature, SignatureAddress: ctx.addressEmail, XAttr },
        });

      return {
        linkId, revisionId, name,
        nodeKey: keys.privateKey,
        passphraseSessionKey: keys.sessionKey,
        nameSessionKey,
      };
    } catch (err) {
      // Best-effort cleanup of the failed/cancelled draft so it doesn't linger.
      _deleteDraft(accountId, ctx, linkId);
      throw err;
    }
  }

  /**
   * Best-effort permanent delete of a failed/cancelled upload draft, as the
   * SDK's deleteDraft does (the route takes drafts only, skipping the trash).
   * A refusal comes back per link inside a 200, so read it. Never throws.
   */
  function _deleteDraft(accountId, ctx, linkId) {
    _req(accountId, 'POST', `drive/v2/volumes/${ctx.volumeId}/delete_multiple`,
      { data: { LinkIDs: [linkId] } })
      .then((res) => {
        const first = res && res.Responses && res.Responses[0];
        const code = first && first.Response && first.Response.Code;
        if (![1000, 1001, 1002].includes(code)) {
          ProtonDiag.record('drive.draft_cleanup_refused', { code });
        }
      })
      .catch((e) => debugLog('[ProtonDrive] draft cleanup failed:', e.message));
  }

  // ---------------------------------------------------------------------------
  // Public share URL
  // ---------------------------------------------------------------------------

  /**
   * Create a public share URL for an uploaded file.
   * @param {object} uploaded - return value of uploadFile()
   * @param {object} opts - { permission: 'viewer'|'editor', expirationDays: number|0,
   *                          customPassword: string }
   * @returns {Promise<{url, expirationTime, editorDenied, hasCustomPassword}>}
   */
  async function createShareUrl(accountId, uploaded, opts) {
    const o = opts || {};
    // Checked before the share exists, so a refusal leaves nothing behind.
    const custom = _customLinkPassword(o.customPassword);
    const wantEditor = o.permission === 'editor';
    const ctx = await bootstrap(accountId);

    // a. Per-file share (volume-scoped)
    const shareKeys = await _generateNodeKeys([uploaded.nodeKey, ctx.addressKey], ctx.addressKey);
    const sharePub = shareKeys.privateKey.toPublic();
    const PassphraseKeyPacket = _b64(await openpgp.encryptSessionKey({
      data: uploaded.passphraseSessionKey.data,
      algorithm: uploaded.passphraseSessionKey.algorithm,
      encryptionKeys: sharePub, format: 'binary',
    }));
    const NameKeyPacket = _b64(await openpgp.encryptSessionKey({
      data: uploaded.nameSessionKey.data,
      algorithm: uploaded.nameSessionKey.algorithm,
      encryptionKeys: sharePub, format: 'binary',
    }));
    const shareRes = await _req(accountId, 'POST', `drive/volumes/${ctx.volumeId}/shares`, {
      data: {
        AddressID: ctx.addressId,
        RootLinkID: uploaded.linkId,
        ShareKey: shareKeys.NodeKey,
        SharePassphrase: shareKeys.NodePassphrase,
        SharePassphraseSignature: shareKeys.NodePassphraseSignature,
        PassphraseKeyPacket,
        NameKeyPacket,
      },
    });
    const linkShareId = shareRes.Share.ID;

    // From here on the share exists, so ANY failure goes through the one
    // teardown below. That includes the password fields: their modulus GET
    // is a request too (no retry), before the URL POST and before the PUT.
    try {
      // b. Share URL: generated password → bcrypt key packet + SRP verifier
      const generated = _randomString(GENERATED_PW_LEN);
      const salt = _b64(crypto.getRandomValues(new Uint8Array(16)));

      const buildPasswordFields = async (password) => {
        const passphrase = ProtonAuth.computeKeyPassword(password, salt);
        const SharePassphraseKeyPacket = _b64(await openpgp.encryptSessionKey({
          data: shareKeys.sessionKey.data,
          algorithm: shareKeys.sessionKey.algorithm,
          passwords: [passphrase], format: 'binary',
        }));
        // Owner-recovery copy, encrypted (unsigned) to the creator's address key.
        const Password = await openpgp.encrypt({
          message: await openpgp.createMessage({ binary: new TextEncoder().encode(password) }),
          encryptionKeys: ctx.addressKey.toPublic(),
        });
        const mod = await _req(accountId, 'GET', 'core/v4/auth/modulus');
        const auth = await ProtonAuth.buildEoAuthFromModulus(mod.Modulus, mod.ModulusID, password);
        return {
          SharePassphraseKeyPacket, Password,
          SRPModulusID: auth.ModulusID, SRPVerifier: auth.Verifier, UrlPasswordSalt: auth.Salt,
        };
      };

      const createFields = await buildPasswordFields(generated);
      const expirationTime = _expirationTime(o.expirationDays, Date.now());
      const created = await _req(accountId, 'POST', `drive/shares/${linkShareId}/urls`, {
        data: {
          Flags: FLAG_GENERATED,
          Permissions: PERMISSIONS.viewer,
          MaxAccesses: 0,
          CreatorEmail: ctx.addressEmail,
          ExpirationTime: expirationTime,
          SharePasswordSalt: salt,
          ...createFields,
        },
      });
      let shareUrl = created.ShareURL;

      // c. One update for editor permission and/or custom password (mirrors WebClients)
      let editorDenied = false;
      if (wantEditor || custom) {
        const update = {};
        if (wantEditor) update.Permissions = PERMISSIONS.editor;
        if (custom) {
          const { password: full, flags } = _fullPasswordAndFlags(generated, custom);
          // Same SharePasswordSalt (never regenerated on password update); fresh
          // SRP verifier over the FULL (generated+custom) password.
          Object.assign(update, await buildPasswordFields(full));
          update.Flags = flags;
        }
        try {
          const res = await _req(accountId, 'PUT',
            `drive/shares/${linkShareId}/urls/${shareUrl.ShareURLID}`, { data: update });
          if (res && res.ShareURL) shareUrl = res.ShareURL;
        } catch (err) {
          // Any other failure fails the whole share: the viewer link works,
          // but the user asked for more, and a requested password must never
          // be silently dropped.
          if (!err || err.code !== CODE_EDITOR_NEEDS_PAID || !wantEditor) throw err;
          // Editor links are limited for free Proton plans: keep the viewer
          // link; still apply the custom password if one was requested.
          editorDenied = true;
          if (custom) {
            delete update.Permissions;
            const res2 = await _req(accountId, 'PUT',
              `drive/shares/${linkShareId}/urls/${shareUrl.ShareURLID}`, { data: update });
            if (res2 && res2.ShareURL) shareUrl = res2.ShareURL;
          }
        }
      }

      // d. Final URL: the generated password rides in the fragment (never sent
      //    to the server); a custom part must be typed by the recipient.
      const base = shareUrl.PublicUrl || (PUBLIC_URL_BASE + shareUrl.Token);
      return {
        url: `${base}#${generated}`,
        expirationTime: shareUrl.ExpirationTime || null,
        editorDenied,
        hasCustomPassword: !!custom,
        permission: wantEditor && !editorDenied ? 'editor' : 'viewer',
      };
    } catch (err) {
      // Tear down the share and any URL on it, so the file is not left shared
      // and no public link lacking what the user asked for stays live (Force
      // also covers a URL the server made before our request failed).
      _deleteShare(accountId, linkShareId);
      throw err;
    }
  }

  /**
   * Best-effort delete of our per-file share, in one call. Force=1 takes any
   * attached URL with it: without it the server refuses (Code 2005) while a
   * URL exists, as the SDK's deleteShareWithForce knows. Never throws.
   */
  function _deleteShare(accountId, shareId) {
    _req(accountId, 'DELETE', `drive/shares/${shareId}`, { params: { Force: 1 } })
      .catch((e) => debugLog('[ProtonDrive] share cleanup failed:', e.message));
  }

  // ---------------------------------------------------------------------------
  // Pending links hand-off (encrypted at rest, like pendingAttachments)
  // ---------------------------------------------------------------------------

  let _pendingChain = Promise.resolve();
  function _enqueuePendingWork(work) {
    const run = _pendingChain.then(work);
    _pendingChain = run.catch(() => {});
    return run;
  }

  function _appendPendingLink(entry) {
    return _enqueuePendingWork(async () => {
      const stored = await browser.storage.local.get('pendingDriveLinks');
      let list = [];
      const p = stored && stored.pendingDriveLinks;
      if (p && p.enc) {
        try { list = JSON.parse(await ExtEncryption.decrypt(p.data)); } catch (_) { list = []; }
      }
      list.push(entry);
      const data = await ExtEncryption.encrypt(JSON.stringify(list));
      await browser.storage.local.set({ pendingDriveLinks: { enc: 1, data } });
    });
  }

  /** Read-and-clear the finished links (popup pickup). */
  function takePendingLinks() {
    return _enqueuePendingWork(async () => {
      const stored = await browser.storage.local.get('pendingDriveLinks');
      const p = stored && stored.pendingDriveLinks;
      if (!p) return null;
      await browser.storage.local.remove('pendingDriveLinks');
      if (!p.enc) return null;
      try { return JSON.parse(await ExtEncryption.decrypt(p.data)); } catch (_) { return null; }
    });
  }

  // ---------------------------------------------------------------------------
  // Upload jobs: state machine + picker-tab port protocol
  // ---------------------------------------------------------------------------

  // uploadId → job. Kept in memory; finished links additionally live in
  // pendingDriveLinks so a SW restart only loses the in-flight file.
  const _jobs = {};
  let _jobSeq = 0;

  /**
   * Create an upload job and fail fast (bootstrap + target folder) before the
   * picker tab ever opens.
   * @returns {Promise<{uploadId: string}>}
   */
  async function startJob(accountId, options) {
    // An over-long custom password would only fail after the upload: refuse it
    // before the picker opens.
    _customLinkPassword(options && options.customPassword);
    const settings = await getSettings();
    const folderPath = (settings && settings.driveDefaultFolder) || DEFAULT_FOLDER;
    const folder = await ensureFolder(accountId, folderPath);

    const uploadId = `drv-${Date.now().toString(36)}-${++_jobSeq}`;
    _jobs[uploadId] = {
      id: uploadId,
      accountId,
      options: options || {},
      folder,
      state: 'waiting_picker',
      files: [],
      port: null,
      pendingChunks: {}, // "fileIndex:offset" → {resolve, reject, timer}
      abort: new AbortController(),
      error: null,
      createdAt: Date.now(),
    };
    // Stale-job GC: anything older than 24 h can go.
    for (const [id, job] of Object.entries(_jobs)) {
      if (Date.now() - job.createdAt > 24 * 3600 * 1000) delete _jobs[id];
    }
    ProtonDiag.record('drive.job_start', {
      permission: (options && options.permission) || 'viewer',
      expirationDays: (options && options.expirationDays),
      hasPassword: !!(options && options.customPassword),
    });
    return { uploadId };
  }

  /** Ask the picker tab for a file slice over the port (pull model). */
  function _requestChunk(job, fileIndex, offset, length) {
    return new Promise((resolve, reject) => {
      const key = `${fileIndex}:${offset}`;
      const timer = setTimeout(() => {
        delete job.pendingChunks[key];
        reject(new Error('Timed out waiting for file data'));
      }, CHUNK_TIMEOUT_MS);
      job.pendingChunks[key] = { resolve, reject, timer };
      try {
        job.port.postMessage({ type: 'NEED_CHUNK', fileIndex, offset, length });
      } catch (e) {
        clearTimeout(timer);
        delete job.pendingChunks[key];
        reject(new Error('Picker tab disconnected'));
      }
    });
  }

  function _post(job, msg) {
    try { if (job.port) job.port.postMessage(msg); } catch (_) { /* tab gone */ }
  }

  async function _processJob(job) {
    job.state = 'uploading';
    const o = job.options;
    for (let i = 0; i < job.files.length; i++) {
      if (job.abort.signal.aborted) break;
      const f = job.files[i];
      f.phase = 'upload'; f.fraction = 0;
      try {
        const uploaded = await uploadFile(
          job.accountId, job.folder,
          { name: f.name, size: f.size, mimeType: f.type, modTime: f.modTime },
          (offset, length) => _requestChunk(job, i, offset, length),
          (fraction) => {
            f.fraction = fraction;
            _post(job, { type: 'PROGRESS', fileIndex: i, phase: 'upload', fraction });
          },
          job.abort.signal);

        f.phase = 'share';
        _post(job, { type: 'PROGRESS', fileIndex: i, phase: 'share', fraction: 1 });
        const link = await createShareUrl(job.accountId, uploaded, {
          permission: o.permission,
          expirationDays: o.expirationDays,
          customPassword: o.customPassword,
        });

        f.phase = 'done';
        f.url = link.url;
        f.editorDenied = link.editorDenied;
        // Persistence is best-effort: the share URL is already live, so a
        // storage failure must NOT mark the file failed (which would lose a
        // real public link). The picker shows the URL from FILE_DONE below
        // regardless; only the auto-insert-into-draft would be skipped.
        try {
          await _appendPendingLink({
            name: uploaded.name,
            size: f.size,
            url: link.url,
            permission: link.permission,
            expirationTime: link.expirationTime,
            hasCustomPassword: link.hasCustomPassword,
            editorDenied: link.editorDenied,
          });
        } catch (persistErr) {
          ProtonDiag.record('drive.persist_fail', { msg: String(persistErr.message).slice(0, 120) });
        }
        _post(job, { type: 'FILE_DONE', fileIndex: i, url: link.url, editorDenied: link.editorDenied });
        ProtonDiag.record('drive.file_done', { size: f.size, editorDenied: link.editorDenied });
      } catch (err) {
        const friendly = _friendlyError(err);
        f.phase = 'error';
        f.error = friendly.code;
        ProtonDiag.record('drive.file_fail', { code: friendly.code, msg: String(err.message).slice(0, 200) });
        _post(job, { type: 'ERROR', fileIndex: i, code: friendly.code, message: friendly.message });
        if (job.abort.signal.aborted) break;
        // Keep going: remaining files may still succeed (partial success keeps
        // finished links).
      }
    }
    job.state = job.abort.signal.aborted ? 'cancelled' : 'done';
    const failed = job.files.filter((f) => f.phase === 'error').length;
    _post(job, {
      type: 'ALL_DONE',
      cancelled: job.state === 'cancelled',
      failed,
      succeeded: job.files.length - failed,
    });
  }

  /**
   * runtime.onConnect delegate for "mcpm-drive-upload" ports (the picker tab).
   * Ports bypass the FREE_ALLOWED message gate, so premium is re-checked here.
   */
  function handlePort(port) {
    if (!ProtonPremium.isPremium()) {
      try { port.postMessage({ type: 'ERROR', fileIndex: null, code: 'PREMIUM_REQUIRED', message: 'Premium required' }); } catch (_) {}
      try { port.disconnect(); } catch (_) {}
      return;
    }
    let job = null;
    port.onMessage.addListener((msg) => {
      if (!msg || typeof msg !== 'object') return;
      if (msg.type === 'HELLO') {
        // Only bind a job that is still waiting for its picker and has no port
        // yet. Assign the closure's `job` ONLY on success. Otherwise a
        // duplicate/late tab (same uploadId, e.g. after a reload) whose
        // onDisconnect fires would cancel the ACTIVE job it never owned.
        const target = _jobs[msg.uploadId];
        if (!target || target.port || target.state !== 'waiting_picker') {
          try { port.postMessage({ type: 'ERROR', fileIndex: null, code: 'DRIVE_ERROR', message: 'Unknown or already-active upload session' }); } catch (_) {}
          try { port.disconnect(); } catch (_) {}
          return;
        }
        job = target;
        job.port = port;
        job.files = (msg.files || []).map((f) => ({
          name: String(f.name || 'file'),
          size: Number(f.size) || 0,
          type: String(f.type || 'application/octet-stream'),
          modTime: Number(f.modTime) || Date.now(),
          phase: 'queued', fraction: 0, url: null, error: null,
        }));
        // Acknowledge the bind so the picker can clear its HELLO-ack timeout
        // (a dropped HELLO, e.g. a lost job after SW teardown, then surfaces
        // as an error instead of a stuck "Queued" row).
        _post(job, { type: 'BOUND' });
        _processJob(job).catch((err) => {
          job.state = 'failed';
          job.error = _friendlyError(err).code;
          _post(job, { type: 'ERROR', fileIndex: null, code: job.error, message: err.message });
          _post(job, { type: 'ALL_DONE', cancelled: false, failed: job.files.length, succeeded: 0 });
        });
      } else if (msg.type === 'CHUNK') {
        if (!job) return;
        const key = `${msg.fileIndex}:${msg.offset}`;
        const pending = job.pendingChunks[key];
        if (!pending) return;
        clearTimeout(pending.timer);
        delete job.pendingChunks[key];
        // Resolve/reject defensively: a malformed or missing dataB64 makes
        // _fromB64 (atob) throw, which, since the timer is already cleared and
        // the entry deleted, would otherwise leave the upload awaiting forever.
        if (msg.error) { pending.reject(new Error(String(msg.error))); return; }
        try {
          pending.resolve(_fromB64(msg.dataB64));
        } catch (_) {
          pending.reject(new Error('Malformed chunk data from picker'));
        }
      }
      // PING needs no reply: the message itself resets the SW idle timer.
    });
    port.onDisconnect.addListener(() => {
      if (!job) return;
      job.port = null;
      if (job.state === 'uploading' || job.state === 'waiting_picker') {
        cancel(job.id); // tab closed mid-upload = cancel
      }
    });
  }

  /** Status snapshot for the popup (all jobs, or one). */
  function getStatus(uploadId) {
    const jobs = uploadId ? [_jobs[uploadId]].filter(Boolean) : Object.values(_jobs);
    return {
      jobs: jobs.map((j) => ({
        uploadId: j.id,
        accountId: j.accountId,
        state: j.state,
        error: j.error,
        files: j.files.map((f) => ({
          name: f.name, size: f.size, phase: f.phase,
          fraction: f.fraction, url: f.url, error: f.error,
        })),
      })),
    };
  }

  function cancel(uploadId) {
    const job = _jobs[uploadId];
    if (!job) return { ok: false };
    job.abort.abort();
    for (const key of Object.keys(job.pendingChunks)) {
      const p = job.pendingChunks[key];
      clearTimeout(p.timer);
      p.reject(new Error('Cancelled'));
      delete job.pendingChunks[key];
    }
    if (job.state === 'waiting_picker') job.state = 'cancelled';
    ProtonDiag.record('drive.job_cancel', {});
    return { ok: true };
  }

  /**
   * Dev-only end-to-end selftest: uploads a generated buffer through the full
   * pipeline (multi-block when size > 4 MiB) and creates a share URL.
   * Reached via the DRIVE_SELFTEST message; not referenced by any UI.
   */
  async function selftest(accountId, sizeBytes, opts) {
    const size = Math.max(1, Number(sizeBytes) || (9 * 1024 * 1024));
    const buf = new Uint8Array(size);
    // Deterministic-ish pattern (crypto.getRandomValues caps at 64 KiB per call)
    for (let i = 0; i < size; i++) buf[i] = (i * 31 + 7) & 0xff;
    const settings = await getSettings();
    const folder = await ensureFolder(accountId,
      (settings && settings.driveDefaultFolder) || DEFAULT_FOLDER);
    const uploaded = await uploadFile(accountId, folder,
      { name: `selftest-${Date.now()}.bin`, size, mimeType: 'application/octet-stream' },
      (offset, length) => Promise.resolve(buf.subarray(offset, offset + length)),
      null, null);
    const link = await createShareUrl(accountId, uploaded, opts || {
      permission: 'viewer', expirationDays: 1, customPassword: '',
    });
    return { name: uploaded.name, url: link.url, expirationTime: link.expirationTime };
  }

  return {
    bootstrap,
    ensureFolder,
    uploadFile,
    createShareUrl,
    startJob,
    handlePort,
    getStatus,
    cancel,
    takePendingLinks,
    selftest,
    // pure helpers, exposed for unit tests
    _verifierToken,
    _fullPasswordAndFlags,
    _expirationTime,
    _customLinkPassword,
    _isNoActiveVolume,
    _splitName,
    _adjustName,
    _blockSizes,
    _splitFolderPath,
    _lookupHash,
  };
})();
