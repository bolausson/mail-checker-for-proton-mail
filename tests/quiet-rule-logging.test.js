/**
 * Saying so when a quiet rule suppresses mail.
 *
 * A rule that hides a message, or keeps it out of the count, leaves no trace:
 * the mail simply is not there, which looks exactly like a sync bug. Working
 * out that a rule was NOT responsible for a missing message took a diagnostic
 * export, a screenshot of the rule and a long read through the poller. One
 * line in the log would have answered it.
 *
 * The four effects are named separately on purpose. "Silenced" and "hidden"
 * are indistinguishable from outside the extension and mean entirely different
 * things, and telling them apart is the point of the entry.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const ROOT = join(__dirname, '..');
const POLLER = readFileSync(join(ROOT, 'background', 'poller.js'), 'utf-8');
const DIAG = readFileSync(join(ROOT, 'background', 'diag.js'), 'utf-8');
const ACCOUNTS = readFileSync(join(ROOT, 'background', 'accounts.js'), 'utf-8');

function lift(src, name) {
  const start = src.indexOf('function ' + name + '(');
  if (start === -1) throw new Error('not found: ' + name);
  let i = src.indexOf('{', start);
  let depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) return src.slice(start, i + 1); }
  }
  throw new Error('unbalanced braces reading ' + name);
}

describe('the entry distinguishes what a rule actually does', () => {
  const fn = lift(POLLER, '_logQuietRuleHits');

  it('names all four effects separately', () => {
    for (const label of ['no-notification', 'not-counted', 'no-sound', 'hidden-from-list']) {
      expect(fn).toContain(label);
    }
  });

  it('maps each label to its own rule flag', () => {
    // Reporting "hidden" for a rule that only silences the notification would
    // send the next investigation in precisely the wrong direction.
    expect(fn).toContain("r.silenceNotification ? 'no-notification'");
    expect(fn).toContain("r.excludeFromCount ? 'not-counted'");
    expect(fn).toContain("r.muteSound ? 'no-sound'");
    expect(fn).toContain("r.hideFromInbox ? 'hidden-from-list'");
  });

  it('names the rule, so it can be found in settings', () => {
    expect(fn).toContain('r.name');
  });

  it('reports how many messages each rule matched', () => {
    expect(fn).toContain('hits');
    expect(fn).toContain("]x' + count");
  });

  it('reports the account, since rules are evaluated per account', () => {
    expect(fn).toContain('email');
  });
});

describe('it reports state changes, not every poll', () => {
  const fn = lift(POLLER, '_logQuietRuleHits');

  it('goes through the storage-backed once()', () => {
    // Rules are re-evaluated on every poll. Logging each time would bury the
    // buffer exactly as the plan record did.
    expect(fn).toContain("ProtonDiag.once('quiet:' + accountId");
  });

  it('reports the transition to nothing-suppressed too', () => {
    // Otherwise a log keeps implying a rule is still hiding mail long after
    // the user stopped matching it.
    expect(fn).toContain("'none'");
    expect(fn).toContain('active: 0');
  });

  it('is awaited, so a rejection cannot escape as an unhandled promise', () => {
    expect(POLLER).toContain('await _logQuietRuleHits(accountId, rules, hits)');
  });
});

describe('the dedup survives the worker dying', () => {
  const fn = lift(DIAG, 'once');

  it('keeps the signature in storage, not in memory', () => {
    // The whole failure it fixes: an in-memory Set is empty again on every
    // cold start, and MV3 cold-starts constantly.
    expect(fn).toContain('browser.storage.local.get(SIG_KEY)');
    expect(fn).toContain('browser.storage.local.set');
  });

  it('re-reports when the value changes', () => {
    expect(fn).toContain('if (sigs[key] === sig) return false');
  });

  it('errs towards reporting when storage is unavailable', () => {
    // A duplicate line is a smaller problem than a fact that never lands.
    const tail = fn.slice(fn.indexOf('catch'));
    expect(tail).toContain('return true');
  });

  it('is reset by clearing the log', () => {
    // Otherwise clear, reproduce, export gives a log missing both facts,
    // because they were already reported against a buffer that is gone.
    const clear = lift(DIAG, 'clear');
    expect(clear).toContain('[SIG_KEY]: {}');
  });
});

describe('the plan record uses the same mechanism', () => {
  it('no longer dedups per worker generation', () => {
    expect(ACCOUNTS).not.toContain('_planRecorded');
    expect(lift(ACCOUNTS, '_recordPlan')).toContain("ProtonDiag.once('plan:' + account.id");
  });
});
