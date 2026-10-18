/**
 * Tests for ProtonNotificationRules (lib/notification-rules.js): the "quiet
 * mail" matching engine.
 *
 * The two safety properties matter most here: a rule with no conditions must
 * never match (a half-filled row would otherwise silence the whole mailbox),
 * and an invalid regex must never match or throw (a typo must not take the
 * poller down, nor silence everything).
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

let R;

beforeAll(() => {
  const code = readFileSync(join(__dirname, '..', 'lib', 'notification-rules.js'), 'utf-8');
  R = new Function(code + '\nreturn ProtonNotificationRules;')();
});

const rule = (over) => ({ id: 'r1', enabled: true, silenceNotification: true, ...over });
const mail = (over) => ({
  from: 'news@shop.example.com',
  to: ['me@proton.me'],
  subject: 'Weekly deals: 20% off',
  body: 'Unsubscribe here. Order number 12345.',
  ...over,
});

describe('address matching (case-insensitive substring)', () => {
  it('matches a full sender address', () => {
    expect(R.matches(rule({ from: 'news@shop.example.com' }), mail())).toBe(true);
  });

  it('matches a whole domain', () => {
    expect(R.matches(rule({ from: '@shop.example.com' }), mail())).toBe(true);
  });

  it('matches a fragment, ignoring case', () => {
    expect(R.matches(rule({ from: 'NEWS' }), mail())).toBe(true);
    expect(R.matches(rule({ from: 'Shop.Example' }), mail())).toBe(true);
  });

  it('does not match a different sender', () => {
    expect(R.matches(rule({ from: 'bank.example.com' }), mail())).toBe(false);
  });

  it('matches any one of several recipients', () => {
    const m = mail({ to: ['team@proton.me', 'alias+shop@proton.me'] });
    expect(R.matches(rule({ to: 'alias+shop@' }), m)).toBe(true);
    expect(R.matches(rule({ to: 'nobody@' }), m)).toBe(false);
  });

  it('tolerates a bare string instead of a recipient list', () => {
    expect(R.matches(rule({ to: 'me@proton.me' }), mail({ to: 'me@proton.me' }))).toBe(true);
  });
});

describe('sender name (the display name the list shows)', () => {
  // The list shows "HUGO BOSS News" (the sender's NAME) above the subject.
  // Matching that is separate from the address, which is often unrelated.
  const newsletter = mail({
    from: 'noreply@e.hugo-mail.example',
    fromName: 'HUGO BOSS News',
    subject: 'Herzlichen Glückwunsch!',
  });

  it('matches the display name, case-insensitively and as a substring', () => {
    expect(R.matches(rule({ fromName: 'HUGO BOSS News' }), newsletter)).toBe(true);
    expect(R.matches(rule({ fromName: 'boss' }), newsletter)).toBe(true);
    expect(R.matches(rule({ fromName: 'hugo' }), newsletter)).toBe(true);
    expect(R.matches(rule({ fromName: 'adidas' }), newsletter)).toBe(false);
  });

  it('is independent of the address field', () => {
    // The address contains neither "hugo boss" nor "news".
    expect(R.matches(rule({ from: 'boss' }), newsletter)).toBe(false);
    expect(R.matches(rule({ fromName: 'boss' }), newsletter)).toBe(true);
  });

  it('does not leak into the subject', () => {
    // The reported confusion: a subject pattern must not match the sender name.
    expect(R.matches(rule({ subject: '.*boss.*' }), newsletter)).toBe(false);
    expect(R.matches(rule({ subject: 'Herzlichen' }), newsletter)).toBe(true);
  });

  it('counts as a condition and ANDs with the others', () => {
    expect(R.hasConditions({ fromName: 'boss' })).toBe(true);
    const both = rule({ fromName: 'boss', subject: 'Herzlichen' });
    expect(R.matches(both, newsletter)).toBe(true);
    expect(R.matches(rule({ fromName: 'boss', subject: 'invoice' }), newsletter)).toBe(false);
  });

  it('is listed in CONDITIONS, in UI order', () => {
    expect(R.CONDITIONS).toEqual(['from', 'fromName', 'to', 'subject', 'body']);
  });
});

describe('subject / body regex', () => {
  it('matches a subject pattern', () => {
    expect(R.matches(rule({ subject: '^weekly deals' }), mail())).toBe(true);
    expect(R.matches(rule({ subject: '\\d+% off' }), mail())).toBe(true);
    expect(R.matches(rule({ subject: 'invoice' }), mail())).toBe(false);
  });

  it('matches a body pattern', () => {
    expect(R.matches(rule({ body: 'unsubscribe' }), mail())).toBe(true);
    expect(R.matches(rule({ body: 'order number \\d{5}' }), mail())).toBe(true);
    expect(R.matches(rule({ body: 'wire transfer' }), mail())).toBe(false);
  });

  it('is case-insensitive', () => {
    expect(R.matches(rule({ subject: 'WEEKLY' }), mail())).toBe(true);
  });

  it('an invalid regex never matches and never throws', () => {
    expect(() => R.matches(rule({ subject: '([unclosed' }), mail())).not.toThrow();
    expect(R.matches(rule({ subject: '([unclosed' }), mail())).toBe(false);
    expect(R.matches(rule({ body: '*bad' }), mail())).toBe(false);
  });

  it('ignores an over-long pattern rather than running it', () => {
    expect(R.matches(rule({ subject: 'a'.repeat(R.MAX_PATTERN_LENGTH + 1) }), mail())).toBe(false);
  });
});

describe('safety: never silence everything by accident', () => {
  it('a rule with no conditions never matches', () => {
    expect(R.matches(rule({}), mail())).toBe(false);
    expect(R.matches(rule({ from: '', to: '', subject: '', body: '' }), mail())).toBe(false);
  });

  it('a disabled rule never matches', () => {
    expect(R.matches(rule({ from: '@shop.example.com', enabled: false }), mail())).toBe(false);
  });

  it('whitespace-only fields count as empty', () => {
    expect(R.matches(rule({ from: '   ' }), mail())).toBe(false);
  });
});

describe('fields are ANDed within a rule', () => {
  it('requires every non-empty condition to match', () => {
    const r = rule({ from: '@shop.example.com', subject: 'deals' });
    expect(R.matches(r, mail())).toBe(true);
    expect(R.matches(r, mail({ subject: 'Your invoice' }))).toBe(false);
    expect(R.matches(r, mail({ from: 'news@other.com' }))).toBe(false);
  });
});

describe('hideFromInbox action', () => {
  it('is reported by evaluate and counts as an action', () => {
    const r = rule({ from: '@shop.example.com', silenceNotification: false, hideFromInbox: true });
    const out = R.evaluate([r], mail());
    expect(out.hideFromInbox).toBe(true);
    expect(out.matched).toEqual(['r1']);
    expect(R.hasActions(r)).toBe(true);
    expect(R.activeRules([r])).toHaveLength(1);
  });

  it('defaults to false and is independent of the other actions', () => {
    expect(R.normalize({}).hideFromInbox).toBe(false);
    const out = R.evaluate([rule({ from: '@shop.example.com' })], mail());
    expect(out.silenceNotification).toBe(true);
    expect(out.hideFromInbox).toBe(false);
  });

  it('still needs a condition: hiding everything by accident must be impossible', () => {
    expect(R.matches(rule({ hideFromInbox: true, silenceNotification: false }), mail())).toBe(false);
    expect(R.evaluate([rule({ hideFromInbox: true, silenceNotification: false })], mail()).hideFromInbox)
      .toBe(false);
  });
});

describe('evaluate: rules are ORed, actions accumulate', () => {
  it('combines the actions of every matching rule', () => {
    const rules = [
      rule({ id: 'a', from: '@shop.example.com', silenceNotification: true, muteSound: false }),
      rule({ id: 'b', subject: 'deals', silenceNotification: false, muteSound: true }),
      rule({ id: 'c', from: 'nomatch@x.y', excludeFromCount: true }),
    ];
    const out = R.evaluate(rules, mail());
    expect(out.silenceNotification).toBe(true);
    expect(out.muteSound).toBe(true);
    expect(out.excludeFromCount).toBe(false);
    expect(out.matched).toEqual(['a', 'b']);
  });

  it('returns all-false for mail nothing matches', () => {
    const out = R.evaluate([rule({ from: 'nobody@x.y' })], mail());
    expect(out).toEqual({
      silenceNotification: false, excludeFromCount: false, muteSound: false,
      hideFromInbox: false, matched: [],
    });
  });

  it('tolerates junk input', () => {
    expect(R.evaluate(null, mail()).matched).toEqual([]);
    expect(R.evaluate([null, undefined, {}], mail()).matched).toEqual([]);
  });
});

describe('needsBody (avoids fetching + decrypting bodies unnecessarily)', () => {
  it('is false without an enabled body rule', () => {
    expect(R.needsBody([])).toBe(false);
    expect(R.needsBody([rule({ from: '@shop.example.com' })])).toBe(false);
    expect(R.needsBody([rule({ body: 'unsubscribe', enabled: false })])).toBe(false);
  });

  it('is true as soon as one enabled rule tests the body', () => {
    expect(R.needsBody([rule({ from: 'x' }), rule({ body: 'unsubscribe' })])).toBe(true);
  });
});

describe('activeRules / validate', () => {
  it('activeRules drops disabled, condition-less and action-less rules', () => {
    const rules = [
      rule({ id: 'keep', from: '@shop.com' }),
      rule({ id: 'disabled', from: '@shop.com', enabled: false }),
      rule({ id: 'noCond' }),
      { id: 'noAction', enabled: true, from: '@shop.com' },
    ];
    expect(R.activeRules(rules).map((r) => r.id)).toEqual(['keep']);
  });

  it('validate reports invalid regexes per field', () => {
    const v = R.validate(rule({ subject: '([bad', body: 'fine' }));
    expect(v.ok).toBe(false);
    expect(v.errors.subject).toBe('invalidRegex');
    expect(v.errors.body).toBeUndefined();
  });

  it('validate flags a rule that tests nothing or does nothing', () => {
    expect(R.validate(rule({})).noConditions).toBe(true);
    expect(R.validate({ id: 'x', enabled: true, from: 'a@b.c' }).noActions).toBe(true);
    expect(R.validate(rule({ from: 'a@b.c' })).ok).toBe(true);
  });
});

describe('normalize', () => {
  it('fills defaults and trims', () => {
    const r = R.normalize({ from: '  a@b.c  ', subject: ' x ' });
    expect(r.from).toBe('a@b.c');
    expect(r.subject).toBe('x');
    expect(r.enabled).toBe(true);
    expect(r.silenceNotification).toBe(false);
    expect(r.id).toMatch(/^r/);
  });

  it('keeps an explicit disabled flag and id', () => {
    const r = R.normalize({ id: 'keep-me', enabled: false });
    expect(r).toMatchObject({ id: 'keep-me', enabled: false });
  });
});

describe('name (label only, never part of matching)', () => {
  it('is trimmed, defaults to empty and is length-capped', () => {
    expect(R.normalize({}).name).toBe('');
    expect(R.normalize({ name: '  Newsletters  ' }).name).toBe('Newsletters');
    expect(R.normalize({ name: 'x'.repeat(R.MAX_NAME_LENGTH + 20) }).name)
      .toHaveLength(R.MAX_NAME_LENGTH);
  });

  it('never affects whether a rule matches', () => {
    const named = rule({ name: 'Climbing hall', from: '@shop.example.com' });
    const unnamed = rule({ from: '@shop.example.com' });
    expect(R.matches(named, mail())).toBe(R.matches(unnamed, mail()));
    // A name alone is not a condition. Such a rule must stay inert.
    expect(R.matches(rule({ name: 'Just a label' }), mail())).toBe(false);
    expect(R.hasConditions({ name: 'Just a label' })).toBe(false);
  });
});
