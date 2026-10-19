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
 * the shape { messages: Message[], unreadCount: number, listLimit?: number,
 * _tombstones?: Map, _convTombstones?: Map }. `now` is injectable for
 * deterministic tests.
 */
const ProtonTombstones = (function () {
  'use strict';

  const TTL_MS = 30000;

  function _ensure(account) {
    if (!account._tombstones) account._tombstones = new Map();        // msgID  -> expiry ts
    if (!account._convTombstones) account._convTombstones = new Map(); // convID -> expiry ts
  }

  /**
   * Take the unread among `dropped` off the count, until the next poll
   * brings Proton's own. Never recomputed from the list: the count comes
   * from Proton's counts and the list holds at most "messages per account",
   * so one mark-read would turn 30 unread into the 4 left in a list of 5.
   */
  function _dropUnread(account, dropped) {
    const n = dropped.filter(m => m.Unread === 1).length;
    if (n) account.unreadCount = Math.max(0, (account.unreadCount || 0) - n);
    if (dropped.length) _listShort(account);
  }

  /**
   * The list now holds fewer than it was fetched for: have the next poll
   * fetch it again (the poller refetches a list whose listLimit is not the
   * setting). The count cannot say so: it stays in step with Proton's, so
   * the event poll would see no change, and with "messages per account"
   * below the unread a list of 5 shrank with every action and stayed short.
   */
  function _listShort(account) {
    account.listLimit = null;
  }

  /** Removal action succeeded: drop the IDs from the cache now + tombstone them. */
  function recordRemoval(account, messageIds, now) {
    if (!account || !messageIds || !messageIds.length) return;
    _ensure(account);
    const expiry = (now || Date.now()) + TTL_MS;
    for (const id of messageIds) account._tombstones.set(id, expiry);
    const idSet = new Set(messageIds);
    const msgs = account.messages || [];
    _dropUnread(account, msgs.filter(m => idSet.has(m.ID)));
    account.messages = msgs.filter(m => !idSet.has(m.ID));
  }

  /** Snooze succeeded: drop the conversations' messages now + tombstone by conversation. */
  function recordSnooze(account, conversationIds, now) {
    if (!account || !conversationIds || !conversationIds.length) return;
    _ensure(account);
    const expiry = (now || Date.now()) + TTL_MS;
    for (const cid of conversationIds) account._convTombstones.set(cid, expiry);
    const convSet = new Set(conversationIds);
    const msgs = account.messages || [];
    _dropUnread(account, msgs.filter(m => convSet.has(m.ConversationID)));
    account.messages = msgs.filter(m => !convSet.has(m.ConversationID));
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
    // Only the list is filtered. The count was just set from Proton's
    // counts, which the list's lag does not touch. A list filtered short is
    // fetched again by the next poll, once the server has caught up.
    if (suppressIds.size || suppressConvs.size) {
      account.messages = msgs.filter(
        m => !suppressIds.has(m.ID) && !suppressConvs.has(m.ConversationID));
      _listShort(account);
    }
  }

  return { recordRemoval, recordSnooze, clear, apply, TTL_MS };
})();
