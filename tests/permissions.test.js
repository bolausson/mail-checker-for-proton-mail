/**
 * What the extension asks the browser for.
 *
 * Permissions are the single biggest input to how the extension is scored by
 * store scanners and enterprise allowlisting, and the easiest thing to add
 * without noticing. This file pins the declared set so a new one has to be a
 * deliberate edit here as well, and pins the reasons the two removed ones are
 * not needed, so they cannot creep back in behind a "just add the permission"
 * fix.
 */

import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';

const ROOT = join(__dirname, '..');
const manifest = JSON.parse(readFileSync(join(ROOT, 'manifest.json'), 'utf-8'));

/** Every permission we intend to hold, with why it cannot be dropped. */
const EXPECTED = {
  alarms: 'polling and token refresh; survives MV3 service-worker restarts, setInterval would not',
  notifications: 'new-mail and session-expiry desktop alerts',
  storage: 'accounts, settings, drafts; nothing works without it',
  scripting: 'FIDO2 WebAuthn in the page world on Chrome, and the ps-* localStorage scan',
  declarativeNetRequestWithHostAccess: 'CAPTCHA only: lets account.proton.me frame verify.proton.me',
};

function jsFiles(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) jsFiles(p, out);
    else if (entry.endsWith('.js')) out.push(p);
  }
  return out;
}

const SHIPPED = ['background', 'popup', 'options', 'lib', 'captcha', 'fido2']
  .flatMap((d) => jsFiles(join(ROOT, d)))
  .filter((f) => !/openpgp\.min|bcrypt\.min|browser-polyfill/.test(f));

const sourceOf = (f) => readFileSync(f, 'utf-8');

describe('the declared permission set', () => {
  it('is exactly the set we intend to hold', () => {
    expect([...manifest.permissions].sort()).toEqual(Object.keys(EXPECTED).sort());
  });

  it('holds no host permission beyond Proton', () => {
    expect(manifest.host_permissions).toEqual(['*://*.proton.me/*']);
  });

  it('never asks for <all_urls>', () => {
    const all = JSON.stringify(manifest);
    expect(all).not.toContain('<all_urls>');
    expect(all).not.toContain('*://*/*');
  });
});

describe('webRequest is gone and stays gone', () => {
  // It could not work: it wrote slot mappings keyed by the WEB session's
  // x-pm-uid, while lookups use the EXTENSION session's uid. It was also
  // redundant with the ps-* localStorage scan, which reads the same mapping
  // from a stable source.
  it('is not declared', () => {
    expect(manifest.permissions).not.toContain('webRequest');
    expect(manifest.permissions).not.toContain('webRequestBlocking');
  });

  it('has no call site left in shipped code', () => {
    const offenders = SHIPPED.filter((f) => /\b(browser|chrome)\s*\.\s*webRequest\b/.test(sourceOf(f)));
    expect(offenders.map((f) => f.slice(ROOT.length + 1))).toEqual([]);
  });
});

describe('clipboardWrite is gone and stays gone', () => {
  // The one clipboard write is navigator.clipboard.writeText inside a click
  // handler, which does not need the permission. execCommand('copy') would.
  it('is not declared', () => {
    expect(manifest.permissions).not.toContain('clipboardWrite');
    expect(manifest.permissions).not.toContain('clipboardRead');
  });

  it('nothing uses execCommand copy or cut, which would need it back', () => {
    const offenders = SHIPPED.filter((f) => /execCommand\(\s*['"](copy|cut)['"]/.test(sourceOf(f)));
    expect(offenders.map((f) => f.slice(ROOT.length + 1))).toEqual([]);
  });
});

describe('cookies is gone and stays gone', () => {
  // It never worked. The strategy required a numeric `LocalID` in the
  // REFRESH-* cookie's JSON and skipped any cookie without one. Proton's
  // cookies carry { ResponseType, ClientID, GrantType, RefreshToken, UID },
  // so every cookie hit that `continue` and the loop mapped nothing, ever.
  // Confirmed against two live multi-account sessions on 2026-08-08.
  const SRC = readFileSync(join(ROOT, 'background', 'url-detection.js'), 'utf-8');

  it('is not declared', () => {
    expect(manifest.permissions).not.toContain('cookies');
  });

  it('has no call site left in shipped code', () => {
    const offenders = SHIPPED.filter((f) => /(browser|chrome)\s*\.\s*cookies/.test(sourceOf(f)));
    expect(offenders.map((f) => f.slice(ROOT.length + 1))).toEqual([]);
  });

  it('the dead strategy itself is gone, not just unreferenced', () => {
    expect(SRC).not.toMatch(/_detectFromCookies/);
    expect(SRC).not.toMatch(/getAll\(/);
  });

  it('but the note explaining why survives, so it is not re-added', () => {
    // The next person to want account-slot detection should find out why this
    // was removed rather than reinstating it and the permission with it.
    expect(SRC).toMatch(/REFRESH-\* cookie strategy/);
    expect(SRC).toMatch(/LocalID/);
  });
});

describe('the CSP override is armed for the CAPTCHA flow only', () => {
  // It lets account.proton.me frame verify.proton.me. 2FA, FIDO2 and the
  // legacy mailbox password all stay inside our own popup and never frame
  // anything, so arming it for those left header-stripping rules installed on
  // three Proton origins for an ordinary sign-in.
  const BG = readFileSync(join(ROOT, 'background', 'background.js'), 'utf-8');

  it('enabling is gated on an explicit opt-in flag', () => {
    const at = BG.indexOf('function _setPendingLogin');
    const fn = BG.slice(at, BG.indexOf('}', BG.indexOf('else', at)));
    expect(fn).toMatch(/opts && opts\.needsCspOverride/);
  });

  it('exactly one call site asks for it', () => {
    const armed = BG.match(/_setPendingLogin\([^)]*needsCspOverride[^)]*\)/g) || [];
    expect(armed).toHaveLength(1);
  });

  it('and that call site is the human-verification branch', () => {
    // The CALL, not the definition or the comment above it, both of which
    // also name the flag.
    const at = BG.indexOf('_setPendingLogin({ username, password }, { needsCspOverride: true })');
    expect(at).toBeGreaterThan(-1);
    expect(BG.slice(at, at + 300)).toMatch(/Human verification required/);
  });

  it('every other pending-login path leaves it off', () => {
    // 2FA and mailbox password pass no opts, so the else branch disables it.
    const plain = BG.match(/_setPendingLogin\(\{ username, password \}\);/g) || [];
    expect(plain).toHaveLength(2);
  });
});

// The reviewer notes are release tooling, left out of the public source
// snapshot; there this block skips itself instead of failing.
const NOTES_PATH = join(ROOT, 'scripts', 'amo-reviewer-notes.txt');

describe.skipIf(!existsSync(NOTES_PATH))('what we tell AMO reviewers matches the code', () => {
  const NOTES = existsSync(NOTES_PATH) ? readFileSync(NOTES_PATH, 'utf-8') : '';

  /** Just the "== Permissions ==" block: the standing description of what we
   *  hold. The per-version block below it legitimately NAMES removed
   *  permissions in order to explain the removal, so scanning the whole file
   *  would forbid exactly the sentence a reviewer most wants to read. */
  const section = () => {
    const start = NOTES.indexOf('== Permissions ==');
    expect(start, 'Permissions section').toBeGreaterThan(-1);
    return NOTES.slice(start, NOTES.indexOf('\n== ', start + 1));
  };

  it('does not claim permissions we no longer hold', () => {
    for (const p of ['webRequest', 'clipboardWrite', 'cookies']) {
      expect(section(), p).not.toContain(p);
    }
  });

  it('describes every permission we do hold', () => {
    for (const p of manifest.permissions) {
      expect(section(), p).toContain(p);
    }
  });

  it('fits the AMO approval-notes limit, counting the way their web form does', () => {
    // The API counts characters; the form normalises LF to CRLF, so budget
    // 3000 minus one per line. A 400 from the API proved the cap is 3000.
    //
    // Normalise to LF FIRST: git's autocrlf leaves this file CRLF on Windows,
    // and counting the \r already present as well as adding one per line
    // double-counts. That exact bug in the release tooling once rejected
    // notes that were inside the limit.
    const lf = NOTES.replace(/\r\n/g, '\n').replace(/\n+$/, '');
    const lines = (lf.match(/\n/g) || []).length;
    expect(lf.length + lines).toBeLessThanOrEqual(3000);
  });
});
