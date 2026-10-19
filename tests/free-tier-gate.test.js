/**
 * Policy test for the FREE_ALLOWED set in background/background.js, the single
 * enforcement point deciding which messages a non-premium user may send.
 *
 * background.js can't be imported (it touches browser APIs at load), so the set
 * literal is lifted out of the source and evaluated on its own. The test is
 * intentionally about POLICY, not implementation: it pins what the free tier
 * promises, and equally that the paid features stay paid.
 *
 * Signing in is free, including accounts protected by an authenticator app or
 * a security key. How a user secures their Proton account is a property of that
 * account, not of our plan; gating it locked properly-secured users out of the
 * extension entirely (changed in v1.11.3, after the free-tier re-login lockout).
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

let FREE_ALLOWED;

beforeAll(() => {
  const src = readFileSync(join(__dirname, '..', 'background', 'background.js'), 'utf-8');
  const start = src.indexOf('const FREE_ALLOWED = new Set([');
  expect(start, 'FREE_ALLOWED set not found. Did the gate move?').toBeGreaterThan(-1);
  const open = src.indexOf('[', start);
  const close = src.indexOf(']);', open);
  expect(close).toBeGreaterThan(open);
  // The literal holds only strings and comments, safe to evaluate directly.
  FREE_ALLOWED = new Set(new Function('return ' + src.slice(open, close + 1))());
});

describe('the free tier can sign in', () => {
  it('allows adding / re-authenticating an account', () => {
    for (const type of ['ADD_ACCOUNT', 'REMOVE_ACCOUNT', 'CANCEL_PENDING_AUTH']) {
      expect(FREE_ALLOWED.has(type), type).toBe(true);
    }
  });

  it('allows two-factor sign-in (authenticator app)', () => {
    expect(FREE_ALLOWED.has('SUBMIT_2FA')).toBe(true);
    expect(FREE_ALLOWED.has('GET_PENDING_2FA')).toBe(true);
    expect(FREE_ALLOWED.has('SET_2FA_METHOD')).toBe(true);
  });

  it('allows security-key sign-in (FIDO2), every step of the ceremony', () => {
    for (const type of ['GET_FIDO2_OPTIONS', 'FIDO2_PAGE_WEBAUTHN', 'FIDO2_COMPLETE']) {
      expect(FREE_ALLOWED.has(type), type).toBe(true);
    }
  });

  it('allows the two-password (separate mailbox password) flow', () => {
    expect(FREE_ALLOWED.has('SUBMIT_MAILBOX_PASSWORD')).toBe(true);
    expect(FREE_ALLOWED.has('GET_PENDING_MAILBOX_PASSWORD')).toBe(true);
  });

  it('allows human verification to complete', () => {
    expect(FREE_ALLOWED.has('CAPTCHA_SOLVED')).toBe(true);
    expect(FREE_ALLOWED.has('CLOSE_THIS_TAB')).toBe(true);
  });

  it('allows reading mail and protecting user data', () => {
    for (const type of ['GET_STATE', 'REFRESH', 'GET_MESSAGE', 'MARK_READ',
      'SAVE_DRAFT', 'GET_DRAFT', 'TAKE_PENDING_DRIVE_LINKS']) {
      expect(FREE_ALLOWED.has(type), type).toBe(true);
    }
  });
});

describe('the free tier can manage its license', () => {
  // A held (unpaid or paused) or locked license has no Premium, and these are
  // exactly the messages that get it back: gating any of them would lock the
  // user out of fixing the payment they are being asked to fix.
  const LICENSE_MESSAGES = ['GET_PREMIUM_STATUS', 'VALIDATE_LICENSE', 'SET_LICENSE_KEY',
    'REMOVE_LICENSE_KEY', 'START_TRIAL', 'GET_MANAGE_URLS', 'LICENSE_NUDGE'];

  it('allows every license message', () => {
    for (const type of LICENSE_MESSAGES) {
      expect(FREE_ALLOWED.has(type), type).toBe(true);
    }
  });

  it('names only license messages the background handles', () => {
    const src = readFileSync(join(__dirname, '..', 'background', 'background.js'), 'utf-8');
    for (const type of LICENSE_MESSAGES) {
      expect(src.includes(`case '${type}'`), type).toBe(true);
    }
  });
});

describe('the free tier keeps support and the email cache working', () => {
  // Support asks free users for the diagnostic log, which needs the popup's
  // console capture, and the options page offers the email cache to everyone.
  // Refused, the cache toggle left the disk copy behind and "Clear cache"
  // reported success while clearing nothing.
  const MESSAGES = ['DIAG_CAPTURE', 'SET_CACHE_ENABLED', 'CLEAR_MSG_CACHE'];

  it('allows the diagnostic capture and both cache controls', () => {
    for (const type of MESSAGES) {
      expect(FREE_ALLOWED.has(type), type).toBe(true);
    }
  });

  it('names only messages the background handles', () => {
    const src = readFileSync(join(__dirname, '..', 'background', 'background.js'), 'utf-8');
    for (const type of MESSAGES) {
      expect(src.includes(`case '${type}'`), type).toBe(true);
    }
  });
});

describe('paid features stay paid', () => {
  it('does not leak compose / send', () => {
    for (const type of ['SEND_NEW_MESSAGE', 'SEND_REPLY', 'FORWARD_MESSAGE']) {
      expect(FREE_ALLOWED.has(type), type).toBe(false);
    }
  });

  it('does not leak Drive uploads, AI, or bulk actions', () => {
    for (const type of ['DRIVE_START_UPLOAD', 'DRIVE_UPLOAD_CANCEL',
      'AI_RUN_ACTION', 'ARCHIVE', 'SNOOZE', 'DND_ENABLE']) {
      expect(FREE_ALLOWED.has(type), type).toBe(false);
    }
  });

  it('names only message types that actually exist', () => {
    // Guards the assertions above from passing vacuously after a rename.
    const src = readFileSync(join(__dirname, '..', 'background', 'background.js'), 'utf-8');
    for (const type of ['SEND_NEW_MESSAGE', 'DRIVE_START_UPLOAD', 'AI_RUN_ACTION',
      'ARCHIVE', 'SNOOZE', 'DND_ENABLE', 'SUBMIT_2FA', 'FIDO2_COMPLETE']) {
      expect(src.includes(`case '${type}'`), type).toBe(true);
    }
  });
});
