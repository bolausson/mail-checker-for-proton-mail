/**
 * Keeping a folder monitor to the folders it names.
 *
 * Custom monitoring asks Proton for one list per selected folder or label
 * (mail/v4/messages?LabelID=...). Proton answers a DELETED folder or label ID
 * by dropping the filter altogether: the reply is every message in the
 * account, Spam, Archive, Trash and Sent included. A made-up ID is refused
 * with a 400, but one that existed once is not. Measured on a live account,
 * 2026-09-18.
 *
 * The picker only draws folders and labels that still exist, so a selection
 * made before the folder was deleted stays stored, invisible and impossible to
 * untick, and quietly turns "these four folders" into "all unread mail". That
 * is what a customer saw: their list held Archive and Spam mail while they
 * monitored four folders, and their log showed five list queries per refresh.
 *
 * Two defences live here. A list reply is trimmed to the messages that really
 * carry the ID asked for, which holds whatever the server does. And an ID
 * that the counts no longer mention is flagged as possibly deleted, for the
 * caller to confirm against the folder and label lists. A confirmed ID joins
 * the account's staleMonitorIds, which live() keeps out of every query.
 */
const ProtonMonitoredIds = (() => {
  'use strict';

  // Proton's own folders and views have short numeric IDs; user-created
  // folders and labels have long opaque ones. Only the latter can be deleted,
  // so nothing numeric is ever treated as stale.
  function isSystemId(id) {
    return typeof id === 'string' && /^\d+$/.test(id);
  }

  function _uniq(list) {
    return [...new Set(list || [])];
  }

  /**
   * The messages of a list reply that actually carry `labelId`, and how many
   * did not. For a live ID that is every message. A message with no LabelIDs
   * array is kept: an extra row is a smaller failure than an empty list if the
   * API ever stops sending the field.
   */
  function carrying(messages, labelId) {
    const kept = [];
    let dropped = 0;
    for (const m of messages || []) {
      if (!m) continue;
      if (!Array.isArray(m.LabelIDs) || m.LabelIDs.includes(labelId)) kept.push(m);
      else dropped++;
    }
    return { kept, dropped };
  }

  /**
   * User-created IDs that a counts reply does not list. Proton lists every
   * existing folder and label there, empty ones included as 0/0, and drops an
   * ID the moment it is deleted. Still a suspicion, not a verdict: the caller
   * confirms before acting. An empty or missing reply says nothing, so it
   * flags nothing.
   */
  function missingFromCounts(ids, counts) {
    if (!Array.isArray(counts) || counts.length === 0) return [];
    const listed = new Set(counts.map(c => c && c.LabelID));
    return _uniq(ids).filter(id => !isSystemId(id) && !listed.has(id));
  }

  /** The suspects that appear in neither the account's folders nor its labels. */
  function stale(suspects, folders, labels) {
    const exists = new Set([...(folders || []), ...(labels || [])].map(l => l && l.ID));
    return _uniq(suspects).filter(id => !isSystemId(id) && !exists.has(id));
  }

  /** Everything the account has ticked, folders then labels, once each. */
  function selected(account) {
    return _uniq([...((account && account.monitoredFolders) || []), ...((account && account.monitoredLabels) || [])]);
  }

  /** The ticked IDs that Proton has not deleted. */
  function live(account) {
    const gone = new Set((account && account.staleMonitorIds) || []);
    return selected(account).filter(id => !gone.has(id));
  }

  /**
   * The account's monitored lists with the deleted `ids` taken out, order
   * kept. Never empties a selection that had something in it: an empty custom
   * selection has always meant "monitor Inbox", and a user whose only folder
   * was deleted did not choose Inbox. The deleted ID stays stored instead, and
   * live() keeps it out of every query, so such an account monitors nothing.
   */
  function withoutStale(account, ids) {
    const drop = new Set(ids || []);
    const folders = (account && account.monitoredFolders) || [];
    const labels = (account && account.monitoredLabels) || [];
    const keptFolders = folders.filter(id => !drop.has(id));
    const keptLabels = labels.filter(id => !drop.has(id));
    if (keptFolders.length + keptLabels.length === 0 && folders.length + labels.length > 0) {
      return { monitoredFolders: folders.slice(), monitoredLabels: labels.slice() };
    }
    return { monitoredFolders: keptFolders, monitoredLabels: keptLabels };
  }

  /**
   * The account's lists with every known-deleted ID taken out, even if that
   * empties them. For the user's own edits: whatever they left ticked is
   * their choice, and nothing ticked means Inbox, as it always has. Without
   * this a deleted ID kept by withoutStale() would outlive the edit, hidden
   * in whichever list the user was not editing.
   */
  function withoutDeleted(account) {
    const gone = new Set((account && account.staleMonitorIds) || []);
    return {
      monitoredFolders: ((account && account.monitoredFolders) || []).filter(id => !gone.has(id)),
      monitoredLabels: ((account && account.monitoredLabels) || []).filter(id => !gone.has(id)),
    };
  }

  const SYSTEM_NAMES = Object.freeze({
    0: 'Inbox', 1: 'AllDrafts', 2: 'AllSent', 3: 'Trash', 4: 'Spam', 5: 'AllMail',
    6: 'Archive', 7: 'Sent', 8: 'Drafts', 10: 'Starred', 15: 'AlmostAllMail',
  });

  /** A short, stable handle for an ID in the diagnostic log. */
  function shortId(id) {
    if (isSystemId(id)) return SYSTEM_NAMES[id] || id;
    return String(id).slice(0, 6);
  }

  /**
   * One line naming what an account monitors. Custom IDs appear as their
   * first six characters, enough to tell them apart and to match a later
   * removal record. Five entries where the picker shows four ticks is the
   * pattern to look for.
   */
  function describe(account) {
    const mode = (account && account.folderMode) || 'inbox';
    if (mode !== 'custom') return 'mode=' + mode;
    const list = ids => (ids && ids.length ? ids.map(shortId).join(',') : '-');
    const gone = new Set(account.staleMonitorIds || []);
    const deleted = selected(account).filter(id => gone.has(id));
    return 'mode=custom folders=' + list(account.monitoredFolders) +
      ' labels=' + list(account.monitoredLabels) +
      (deleted.length ? ' deleted=' + list(deleted) : '');
  }

  return {
    isSystemId, carrying, missingFromCounts, stale, selected, live,
    withoutStale, withoutDeleted, shortId, describe,
  };
})();
