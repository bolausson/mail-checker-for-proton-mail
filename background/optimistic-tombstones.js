/**
 * Optimistic-action tombstones.
 *
 * Proton's message-list query is eventually consistent: for a short window
 * after an action succeeds (trash / archive / mark-read / move / snooze) a
 * poll can still return the just-acted-on message, which then re-surfaces in
 * the UI even though the user already saw it disappear. To prevent that we:
 *
 *   - on a successful removal action, drop the message from the cached
 *     `account.messages` immediately AND record a tombstone for its ID;
 *   - after every fresh poll overwrites `account.messages`, subtract any
 *     tombstoned IDs the server is still returning (the consistency window),
 *     self-clear a tombstone the instant the server confirms the change
 *     (the ID stops coming back), and expire tombstones after a TTL backstop.
 *
 * Reverse actions (untrash / unarchive / mark-unread) clear the tombstone so
 * the message can legitimately return.
 *
 * Pure and dependency-free: every function operates on an `account` object of
 * the shape { messages: Message[], unreadCount: number, _tombstones?: Map,
 * _convTombstones?: Map }. `now` is injectable for deterministic tests.
 */
const ProtonTombstones = (function () {
  'use strict';

  const TTL_MS = 30000;

  function _ensure(account) {
    if (!account._tombstones) account._tombstones = new Map();        // msgID  -> expiry ts
    if (!account._convTombstones) account._convTombstones = new Map(); // convID -> expiry ts
  }

  function _recomputeUnread(account) {
    account.unreadCount = (account.messages || []).filter(m => m.Unread === 1).length;
  }

  /** Removal action succeeded: drop the IDs from the cache now + tombstone them. */
  function recordRemoval(account, messageIds, now) {
    if (!account || !messageIds || !messageIds.length) return;
    _ensure(account);
    const expiry = (now || Date.now()) + TTL_MS;
    for (const id of messageIds) account._tombstones.set(id, expiry);
    const idSet = new Set(messageIds);
    account.messages = (account.messages || []).filter(m => !idSet.has(m.ID));
    _recomputeUnread(account);
  }

  /** Snooze succeeded: drop the conversations' messages now + tombstone by conversation. */
  function recordSnooze(account, conversationIds, now) {
    if (!account || !conversationIds || !conversationIds.length) return;
    _ensure(account);
    const expiry = (now || Date.now()) + TTL_MS;
    for (const cid of conversationIds) account._convTombstones.set(cid, expiry);
    const convSet = new Set(conversationIds);
    account.messages = (account.messages || []).filter(m => !convSet.has(m.ConversationID));
    _recomputeUnread(account);
  }

  /** Reverse action (undo): drop tombstones so the message can return on the next poll. */
  function clear(account, messageIds, conversationIds) {
    if (!account) return;
    if (account._tombstones && messageIds) {
      for (const id of messageIds) account._tombstones.delete(id);
    }
    if (account._convTombstones && conversationIds) {
      for (const cid of conversationIds) account._convTombstones.delete(cid);
    }
  }

  /**
   * Reconcile a freshly-fetched `account.messages` against the tombstones.
   * Call immediately after the poller overwrites `account.messages`.
   *   - expired tombstone        -> drop it (TTL backstop)
   *   - tombstoned ID now absent  -> server confirmed the change; drop the tombstone
   *   - tombstoned ID still present -> consistency window; filter it out, keep tombstone
   */
  function apply(account, now) {
    if (!account) return;
    const ts = now || Date.now();
    const tomb = account._tombstones;
    const convTomb = account._convTombstones;
    const hasTomb = tomb && tomb.size;
    const hasConv = convTomb && convTomb.size;
    if (!hasTomb && !hasConv) return;

    const msgs = account.messages || [];
    const presentIds = new Set(msgs.map(m => m.ID));
    const presentConvs = new Set(msgs.map(m => m.ConversationID));
    const suppressIds = new Set();
    const suppressConvs = new Set();

    if (hasTomb) {
      for (const [id, expiry] of tomb) {
        if (expiry < ts) tomb.delete(id);
        else if (!presentIds.has(id)) tomb.delete(id);
        else suppressIds.add(id);
      }
    }
    if (hasConv) {
      for (const [cid, expiry] of convTomb) {
        if (expiry < ts) convTomb.delete(cid);
        else if (!presentConvs.has(cid)) convTomb.delete(cid);
        else suppressConvs.add(cid);
      }
    }
    if (suppressIds.size || suppressConvs.size) {
      account.messages = msgs.filter(
        m => !suppressIds.has(m.ID) && !suppressConvs.has(m.ConversationID));
      _recomputeUnread(account);
    }
  }

  return { recordRemoval, recordSnooze, clear, apply, TTL_MS };
})();
