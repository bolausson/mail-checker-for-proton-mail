/**
 * How long a toast stays on screen.
 *
 * A flat 4.5 seconds was fine for "Message sent" and too short for the messages
 * that actually need reading. Those are exactly the ones that matter: the send
 * failure explaining that nothing was sent and to try again, and the address
 * check naming the offending recipient. Scaling with length fixes the whole
 * class rather than the one message that prompted it.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const SRC = readFileSync(join(__dirname, '..', 'popup', 'popup.js'), 'utf-8');
const I18N = readFileSync(join(__dirname, '..', 'lib', 'i18n.js'), 'utf-8');

function lift(name) {
  const start = SRC.indexOf('function ' + name + '(');
  if (start === -1) throw new Error('not found: ' + name);
  let i = SRC.indexOf('{', start);
  let depth = 0;
  for (; i < SRC.length; i++) {
    if (SRC[i] === '{') depth++;
    else if (SRC[i] === '}') { depth--; if (depth === 0) return SRC.slice(start, i + 1); }
  }
  throw new Error('unbalanced braces reading ' + name);
}

let duration;
beforeAll(() => {
  duration = new Function(lift('_toastDurationMs') + '\nreturn _toastDurationMs;')();
});

describe('short messages are unchanged', () => {
  it('keeps the old 4.5s floor for a brief confirmation', () => {
    expect(duration('Message sent')).toBe(4500);
    expect(duration('Archived')).toBe(4500);
  });

  it('survives empty and junk input', () => {
    expect(duration('')).toBe(4500);
    expect(duration(null)).toBe(4500);
    expect(duration(undefined)).toBe(4500);
  });
});

describe('long messages get time to be read', () => {
  it('gives the send-rejection message noticeably longer', () => {
    const msg = /sendTemporarilyRejected: '([^']+)'/.exec(I18N)[1];
    expect(msg.length).toBeGreaterThan(100);
    expect(duration(msg)).toBeGreaterThan(6000);
  });

  it('scales with length', () => {
    expect(duration('x'.repeat(120))).toBeGreaterThan(duration('x'.repeat(60)));
  });

  it('never lingers past 12s, however long the text', () => {
    expect(duration('x'.repeat(10000))).toBe(12000);
  });
});

describe('it is actually wired to the toast', () => {
  it('showToast uses it rather than a literal', () => {
    const fn = lift('showToast');
    expect(fn).toMatch(/_toastDurationMs\(text\)/);
    expect(fn).not.toMatch(/, 4500\)/);
  });
});
