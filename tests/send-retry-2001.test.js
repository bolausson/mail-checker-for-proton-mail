/**
 * Retrying a send that Proton rejected with apiCode 2001.
 *
 * Proton intermittently answers a send with 400 / 2001, "Invalid or missing
 * message signature", then accepts a byte-identical payload seconds later.
 * Measured 2026-08-07: a failure and the success immediately after it had the
 * same body length (7), the same ciphertext length (263, far too large to be
 * unsigned) and the same signing key, and Proton's own web client succeeded
 * against the same account throughout.
 *
 * The danger in retrying a SEND is duplicate mail, so the scoping matters more
 * than the retry: 2001 arrives with HTTP 400, meaning the message was rejected
 * at validation and never processed. Any other failure could be a lost response
 * to a send that actually went through, which is why the draft cleanup skips
 * this step too.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const SRC = readFileSync(join(__dirname, '..', 'background', 'accounts.js'), 'utf-8');

function lift(name) {
  let start = SRC.indexOf('async function ' + name + '(');
  if (start === -1) start = SRC.indexOf('function ' + name + '(');
  if (start === -1) throw new Error('not found: ' + name);
  let i = SRC.indexOf('{', start);
  let depth = 0;
  for (; i < SRC.length; i++) {
    if (SRC[i] === '{') depth++;
    else if (SRC[i] === '}') { depth--; if (depth === 0) return SRC.slice(start, i + 1); }
  }
  throw new Error('unbalanced braces reading ' + name);
}

describe('the retry is scoped to code 2001 alone', () => {
  const fn = lift('_encryptAndSend');

  it('rethrows anything that is not 2001', () => {
    // The whole safety argument rests on this condition. A generic retry could
    // deliver the same message twice.
    expect(fn).toMatch(/sendErr\.code !== 2001/);
  });

  it('gives up after a bounded number of attempts', () => {
    expect(fn).toMatch(/sendAttempt >= SEND_RETRY_SIGNATURE_MAX/);
    expect(SRC).toMatch(/const SEND_RETRY_SIGNATURE_MAX = [0-9]+;/);
  });

  it('rebuilds the packages between attempts', () => {
    // Pressing Send again produces a fresh session key and body, and that is
    // what is observed to succeed; re-posting the identical payload might not.
    const loop = fn.slice(fn.indexOf('let sendAttempt'));
    expect(loop).toMatch(/_buildSendPackages\(/);
    expect(loop).toMatch(/sendData\.Packages = packages;/);
  });

  it('records each retry, so its real-world rate is visible', () => {
    expect(fn).toMatch(/ProtonDiag\.record\('send\.retry'/);
  });

  it('reports how many attempts a successful send needed', () => {
    expect(fn).toMatch(/_recordSendDiag\('send',[\s\S]{0,160}sendAttempt\)/);
  });
});

describe('the surrounding safety properties still hold', () => {
  const fn = lift('_encryptAndSend');

  it('still never deletes the draft after a send-step failure', () => {
    // Proton converts a draft in place, so the same MessageID becomes the sent
    // message; deleting on a send error can destroy delivered mail.
    expect(fn).toMatch(/if \(step !== 'send'\)/);
  });

  it('a failure after the retries are exhausted is still reported', () => {
    expect(fn).toMatch(/_recordSendDiag\('send\.fail'/);
  });
});
