/**
 * Tests for ProtonTombstones: the optimistic-action reconciliation that stops
 * trashed/archived/read/snoozed messages from re-surfacing while Proton's API
 * is still eventually-consistent.
 *
 * The module is a dependency-free browser IIFE; eval it and grab the global.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

let T;

beforeAll(() => {
  const code = readFileSync(join(__dirname, '..', 'background', 'optimistic-tombstones.js'), 'utf-8');
  T = new Function(code + '\nreturn ProtonTombstones;')();
});

const msg = (id, conv, unread = 1) => ({ ID: id, ConversationID: conv || ('c-' + id), Unread: unread });

describe('recordRemoval', () => {
  it('drops the messages from the cache, tombstones them, and recomputes unread', () => {
    const acc = { messages: [msg('a'), msg('b'), msg('c', null, 0)], unreadCount: 2 };
    T.recordRemoval(acc, ['a'], 1000);
    expect(acc.messages.map(m => m.ID)).toEqual(['b', 'c']);
    expect(acc.unreadCount).toBe(1); // b unread, c read
    expect(acc._tombstones.has('a')).toBe(true);
  });

  it('is a no-op for empty / missing ids', () => {
    const acc = { messages: [msg('a')], unreadCount: 1 };
    T.recordRemoval(acc, [], 1000);
    T.recordRemoval(acc, null, 1000);
    expect(acc.messages.length).toBe(1);
  });
});

describe('apply: eventual-consistency window', () => {
  it('suppresses a tombstoned id the server still returns (the bug)', () => {
    const acc = { messages: [msg('a'), msg('b')], unreadCount: 2 };
    T.recordRemoval(acc, ['a'], 1000);
    // A poll fired inside the consistency window re-fetches 'a'.
    acc.messages = [msg('a'), msg('b')];
    T.apply(acc, 2000);
    expect(acc.messages.map(m => m.ID)).toEqual(['b']); // 'a' filtered back out
    expect(acc._tombstones.has('a')).toBe(true);        // kept, still in window
    expect(acc.unreadCount).toBe(1);
  });

  it('self-clears the tombstone once the server confirms (id absent)', () => {
    const acc = { messages: [msg('a'), msg('b')], unreadCount: 2 };
    T.recordRemoval(acc, ['a'], 1000);
    acc.messages = [msg('b')];          // poll no longer returns 'a' → confirmed
    T.apply(acc, 2000);
    expect(acc._tombstones.has('a')).toBe(false);
    // A later poll legitimately returning 'a' again is NOT suppressed.
    acc.messages = [msg('a'), msg('b')];
    T.apply(acc, 3000);
    expect(acc.messages.map(m => m.ID).sort()).toEqual(['a', 'b']);
  });

  it('expires a tombstone after the TTL backstop and stops suppressing', () => {
    const acc = { messages: [msg('a')], unreadCount: 1 };
    T.recordRemoval(acc, ['a'], 1000);
    acc.messages = [msg('a')];          // server still wrongly returning it past TTL
    T.apply(acc, 1000 + T.TTL_MS + 1);
    expect(acc._tombstones.has('a')).toBe(false); // expired
    expect(acc.messages.map(m => m.ID)).toEqual(['a']); // no longer suppressed
  });

  it('does nothing when there are no tombstones', () => {
    const acc = { messages: [msg('a')], unreadCount: 1 };
    T.apply(acc, 5000);
    expect(acc.messages.map(m => m.ID)).toEqual(['a']);
  });
});

describe('clear: undo (untrash / unarchive / mark-unread)', () => {
  it('drops the tombstone so the message returns on the next poll', () => {
    const acc = { messages: [msg('a'), msg('b')], unreadCount: 2 };
    T.recordRemoval(acc, ['a'], 1000);  // trash
    T.clear(acc, ['a']);                // untrash
    acc.messages = [msg('a'), msg('b')]; // poll re-fetches 'a'
    T.apply(acc, 2000);
    expect(acc.messages.map(m => m.ID).sort()).toEqual(['a', 'b']); // NOT suppressed
  });
});

describe('snooze, conversation-keyed', () => {
  it('drops + suppresses every message of a snoozed conversation', () => {
    const acc = { messages: [msg('a', 'conv1'), msg('b', 'conv2')], unreadCount: 2 };
    T.recordSnooze(acc, ['conv1'], 1000);
    expect(acc.messages.map(m => m.ID)).toEqual(['b']);
    // Poll re-adds the conversation (even a different message in it).
    acc.messages = [msg('a', 'conv1'), msg('b', 'conv2'), msg('a2', 'conv1')];
    T.apply(acc, 2000);
    expect(acc.messages.map(m => m.ID)).toEqual(['b']);
  });

  it('clear() with conversationIds lets the conversation return (unsnooze)', () => {
    const acc = { messages: [msg('a', 'conv1')], unreadCount: 1 };
    T.recordSnooze(acc, ['conv1'], 1000);
    T.clear(acc, null, ['conv1']);
    acc.messages = [msg('a', 'conv1')];
    T.apply(acc, 2000);
    expect(acc.messages.map(m => m.ID)).toEqual(['a']);
  });
});

describe('multi-account isolation', () => {
  it('keeps tombstones independent per account object', () => {
    const a1 = { messages: [msg('x')], unreadCount: 1 };
    const a2 = { messages: [msg('x')], unreadCount: 1 };
    T.recordRemoval(a1, ['x'], 1000);
    // a2 untouched
    expect(a2.messages.map(m => m.ID)).toEqual(['x']);
    expect(a2._tombstones).toBeUndefined();
  });
});
