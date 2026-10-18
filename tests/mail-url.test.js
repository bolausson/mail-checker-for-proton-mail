/**
 * Tests for ViewMode-aware "open in Proton web UI" URLs: conversation-grouping
 * accounts (ViewMode 0) must route by ConversationID (optionally
 * /{messageID} to auto-expand that message), single-message accounts
 * (ViewMode 1) by message ID. The wrong ID kind makes Proton's web client
 * fetch conversations/{id} (or messages/{id}) and fail with
 * "Conversation does not exist" / "Message does not exist".
 *
 * url-detection.js is a browser IIFE, so we eval it with stubbed globals
 * (same pattern as error-handling.test.js).
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const read = (rel) => readFileSync(join(__dirname, '..', rel), 'utf-8');

let ProtonUrlDetection;

// Fallback slots come from list position: conv=0, single=1, unknown=2,
// web-single=3, web-conv=4
const accounts = [
  { id: 'acc-conv', email: 'conv@example.com', viewMode: 0 },
  { id: 'acc-single', email: 'single@example.com', viewMode: 1 },
  { id: 'acc-unknown', email: 'unknown@example.com', viewMode: null },
  // Proton scopes ViewMode per client app: the web client's own bucket
  // (webViewMode, read via an open Proton tab) must win over the
  // generic-client value the extension reads as 'Other'.
  { id: 'acc-web-single', email: 'web-single@example.com', viewMode: 0, webViewMode: 1 },
  { id: 'acc-web-conv', email: 'web-conv@example.com', viewMode: 1, webViewMode: 0 },
];

beforeAll(async () => {
  globalThis.debugLog = () => {};
  globalThis.browser = {
    storage: { local: { get: async () => ({}), set: async () => {} } },
    tabs: {
      onUpdated: { addListener: () => {}, removeListener: () => {} },
      query: async () => [],
      get: async () => ({}),
    },
    // Deliberately no `webRequest`: that strategy and its permission are gone.
    // If the module ever reaches for it again, loading it here will throw.
  };
  ProtonUrlDetection = new Function(read('background/url-detection.js') + '\nreturn ProtonUrlDetection;')();
  await ProtonUrlDetection.init({
    getAccounts: () => accounts,
    findAccountBy: (pred) => accounts.find(pred),
  });
});

describe('ViewMode-aware getMailUrl', () => {
  it('routes by ConversationID/messageID in conversation mode (ViewMode 0)', () => {
    expect(ProtonUrlDetection.getMailUrl('conv123', 'acc-conv', 'msg456'))
      .toBe('https://mail.proton.me/u/0/inbox/conv123/msg456');
  });

  it('routes by ConversationID alone when no message ID is given (ViewMode 0)', () => {
    expect(ProtonUrlDetection.getMailUrl('conv123', 'acc-conv', null))
      .toBe('https://mail.proton.me/u/0/inbox/conv123');
  });

  it('routes by message ID in single-message mode (ViewMode 1)', () => {
    expect(ProtonUrlDetection.getMailUrl('conv123', 'acc-single', 'msg456'))
      .toBe('https://mail.proton.me/u/1/inbox/msg456');
  });

  it('falls back to the conversation form when ViewMode is unknown (null)', () => {
    // Conversation grouping is Proton's default, so unknown → ConversationID
    expect(ProtonUrlDetection.getMailUrl('conv123', 'acc-unknown', 'msg456'))
      .toBe('https://mail.proton.me/u/2/inbox/conv123/msg456');
  });

  it('uses the conversation ID when only that is available and no account matches (notification click)', () => {
    expect(ProtonUrlDetection.getMailUrl('conv123', undefined, undefined))
      .toBe('https://mail.proton.me/u/0/inbox/conv123');
  });

  it('degrades to the message ID when no conversation ID is available (ViewMode 0)', () => {
    expect(ProtonUrlDetection.getMailUrl(null, 'acc-conv', 'msg456'))
      .toBe('https://mail.proton.me/u/0/inbox/msg456');
  });

  it('returns the bare inbox when no element IDs are given', () => {
    expect(ProtonUrlDetection.getMailUrl(null, 'acc-conv', null))
      .toBe('https://mail.proton.me/u/0/inbox');
  });

  it('prefers the web client bucket over the generic value (web=single wins)', () => {
    expect(ProtonUrlDetection.getMailUrl('conv123', 'acc-web-single', 'msg456'))
      .toBe('https://mail.proton.me/u/3/inbox/msg456');
  });

  it('prefers the web client bucket over the generic value (web=conversation wins)', () => {
    expect(ProtonUrlDetection.getMailUrl('conv123', 'acc-web-conv', 'msg456'))
      .toBe('https://mail.proton.me/u/4/inbox/conv123/msg456');
  });
});
