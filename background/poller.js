/**
 * Polling mechanism for checking new Proton Mail messages.
 *
 * Iterates all accounts, uses Proton's event system for efficient
 * change detection, falling back to direct message count polling.
 */

const ProtonPoller = (() => {
  const ALARM_NAME = 'proton-mail-check';
  const DEFAULT_INTERVAL_MINUTES = 1;
  const BACKOFF_MULTIPLIERS = [1, 1, 2, 3, 5, 8, 13];
  const SNIPPET_MAX_CHARS = 500; // plain-text preview snippet truncation length

  let _isPolling = false;
  let _lastCheckTime = null;
  // When a poll last RAN, successful or not. Distinct from _lastCheckTime,
  // which means "last succeeded" and is what the popup shows as
  // "Checked ...". pollIfStale throttles on this one: since a failed poll
  // stopped advancing _lastCheckTime, throttling on that made every popup
  // open while offline fire another doomed poll, and each one escalated the
  // Fibonacci backoff and pushed the automatic retry further out. Claiming a
  // check that never happened would be the wrong fix: the popup would lie.
  let _lastPollAttempt = 0;
  let _errorCount = 0;
  // The backoff step lives in storage.session too: MV3 tears the worker down
  // between polls, and a count held only in memory restarted at zero on every
  // wake, so the backoff never escalated past its first step.
  const ERROR_COUNT_KEY = 'protonPollErrorCount';
  let _errorCountLoaded = null;
  function _loadErrorCount() {
    if (!_errorCountLoaded) {
      _errorCountLoaded = (async () => {
        try {
          if (browser.storage.session) {
            const stored = await browser.storage.session.get(ERROR_COUNT_KEY);
            const n = stored && stored[ERROR_COUNT_KEY];
            if (typeof n === 'number' && n > _errorCount) _errorCount = n;
          }
        } catch (_) { /* start from the in-memory value */ }
      })();
    }
    return _errorCountLoaded;
  }
  async function _saveErrorCount() {
    try {
      if (browser.storage.session) await browser.storage.session.set({ [ERROR_COUNT_KEY]: _errorCount });
    } catch (_) { /* best effort */ }
  }

  /** Update the toolbar badge based on current unread count and DND state. */
  function _updateBadge(unreadCount) {
    // Any account in a permanent auth-error state (expired session / disabled)
    // surfaces as a "!" on the badge so the user notices something is wrong
    // without opening the popup. An account issue takes precedence over the
    // muted DND style. Only for an account that is checked: one locked on
    // the free plan has nothing in the popup to explain the "!".
    const hasIssue = _effectiveAccountsForPolling().some(a => a.authError);
    if (ProtonDND.isActive() && !hasIssue) {
      ProtonBadge.setDND(unreadCount);
    } else {
      ProtonBadge.setUnreadCount(unreadCount, hasIssue);
    }
  }

  /** The badge tooltip for a failed poll. Translated: this string is
   *  interpolated into badgeErrorTitle, so it is what an offline user in any
   *  of the 28 languages actually reads. Guarded the way badge.js guards its
   *  own lookups, for contexts loaded without i18n. */
  function _pollErrorText(err) {
    const keysOnly = !!(err && err.keysOnly);
    const key = keysOnly ? 'sessionExpiredSignIn' : 'err_network_error';
    const fallback = keysOnly ? 'sign in again' : 'connection error';
    return typeof ProtonI18n !== 'undefined' ? ProtonI18n.t(key) : fallback;
  }

  /** Recompute + repaint the toolbar badge immediately, without waiting for the
   *  next poll cycle. Called when an account enters/leaves an auth-error state so
   *  the "!" appears (and clears) instantly. Uses the same unread total the poll
   *  uses (sum of per-account unreadCount). */
  function refreshBadgeNow() {
    // getState(), not a plain sum: that one also takes out mail a quiet rule
    // excludes from the count, and the two used to disagree until the next poll.
    _updateBadge(getState().unreadCount);
  }

  /** Ensure keys are unlocked for an account, recovering if needed.
   *  Returns true if keys are available, false otherwise. */
  async function _ensureKeys(accountId, email) {
    const account = ProtonAccounts.getAccount(accountId);
    if (!account) return false;
    if (account.keysUnlocked) return true;
    const recovered = await ProtonAccounts.ensureKeysUnlocked(accountId);
    if (!recovered) {
      debugLog('[ProtonPoller] Skipping', email, '- keys not unlocked');
      return false;
    }
    debugLog('[ProtonPoller] Keys recovered for', email);
    return true;
  }

  /**
   * Get the effective poll interval in minutes.
   * Free tier is locked to 15 min regardless of the user's setting; premium
   * (license or active trial) honors the configured interval.
   */
  async function _getPollInterval() {
    if (typeof ProtonPremium !== 'undefined' && !ProtonPremium.isPremium()) {
      return 15;
    }
    const s = await getSettings();
    return s.pollIntervalMinutes || DEFAULT_INTERVAL_MINUTES;
  }

  /**
   * Accounts whose data should be refreshed on this poll tick.
   * Free tier only polls the first account to save API calls; second+ accounts
   * remain visible in the popup as locked placeholders.
   */
  function _effectiveAccountsForPolling() {
    const accounts = ProtonAccounts.getAccounts();
    if (typeof ProtonPremium !== 'undefined' && !ProtonPremium.isPremium()) {
      return accounts.slice(0, 1);
    }
    return accounts;
  }

  /** Get the configured max emails per account. */
  async function _getMaxEmails() {
    const s = await getSettings();
    return s.maxEmailsPerAccount || 20;
  }

  /**
   * Strip HTML and extract a plain-text snippet from a decrypted message body.
   *
   * Pipeline: MSO conditionals → style/script tags → block-level tags to \n →
   *           remaining tags → HTML entities → invisible/spacing entities →
   *           whitespace collapse → truncate to 500 chars.
   *
   * Handles marketing email obfuscation (Amazon-style invisible entities,
   * MSO conditional comments with PixelsPerInch, etc.).
   *
   * @param {string} html - Decrypted HTML message body.
   * @returns {string} Plain-text snippet, max 500 characters.
   */
  function _extractSnippet(html) {
    return _htmlToText(html, SNIPPET_MAX_CHARS);
  }

  /**
   * Named HTML entities worth decoding, written as escapes so this file stays
   * ASCII. The catch-all at the end of the pipeline DELETES whatever is not
   * decoded here, which used to eat apostrophes mid-word and currency symbols
   * in exactly the marketing mail a preview exists for: "Don&rsquo;t miss it
   * &mdash; only &euro;19 today!" arrived as "Dont miss it  only 19 today!".
   *
   * &amp; is deliberately absent: it is decoded last of all, so a decoded "&"
   * can never be re-read as the start of another entity.
   */
  const HTML_ENTITIES = {
    nbsp: ' ', lt: '<', gt: '>', quot: '"', apos: "'",
    // Punctuation
    rsquo: '\u2019', lsquo: '\u2018', rdquo: '\u201D', ldquo: '\u201C',
    sbquo: '\u201A', bdquo: '\u201E', mdash: '\u2014', ndash: '\u2013',
    hellip: '\u2026', bull: '\u2022', middot: '\u00B7', dagger: '\u2020',
    Dagger: '\u2021', permil: '\u2030', prime: '\u2032', Prime: '\u2033',
    laquo: '\u00AB', raquo: '\u00BB', lsaquo: '\u2039', rsaquo: '\u203A',
    // Symbols
    copy: '\u00A9', reg: '\u00AE', trade: '\u2122', sect: '\u00A7',
    para: '\u00B6', deg: '\u00B0', plusmn: '\u00B1', times: '\u00D7',
    divide: '\u00F7', micro: '\u00B5', not: '\u00AC', iexcl: '\u00A1',
    iquest: '\u00BF',
    // Currency
    euro: '\u20AC', pound: '\u00A3', yen: '\u00A5', cent: '\u00A2',
    // Fractions and superscripts
    frac12: '\u00BD', frac14: '\u00BC', frac34: '\u00BE',
    sup1: '\u00B9', sup2: '\u00B2', sup3: '\u00B3',
    // Latin-1 letters: German, French, Nordic and Spanish mail is full of them
    szlig: '\u00DF',
    agrave: '\u00E0', aacute: '\u00E1', acirc: '\u00E2', atilde: '\u00E3',
    auml: '\u00E4', aring: '\u00E5', aelig: '\u00E6', ccedil: '\u00E7',
    egrave: '\u00E8', eacute: '\u00E9', ecirc: '\u00EA', euml: '\u00EB',
    igrave: '\u00EC', iacute: '\u00ED', icirc: '\u00EE', iuml: '\u00EF',
    ntilde: '\u00F1', ograve: '\u00F2', oacute: '\u00F3', ocirc: '\u00F4',
    otilde: '\u00F5', ouml: '\u00F6', oslash: '\u00F8', ugrave: '\u00F9',
    uacute: '\u00FA', ucirc: '\u00FB', uuml: '\u00FC', yacute: '\u00FD',
    yuml: '\u00FF',
    Agrave: '\u00C0', Aacute: '\u00C1', Acirc: '\u00C2', Atilde: '\u00C3',
    Auml: '\u00C4', Aring: '\u00C5', AElig: '\u00C6', Ccedil: '\u00C7',
    Egrave: '\u00C8', Eacute: '\u00C9', Ecirc: '\u00CA', Euml: '\u00CB',
    Igrave: '\u00CC', Iacute: '\u00CD', Icirc: '\u00CE', Iuml: '\u00CF',
    Ntilde: '\u00D1', Ograve: '\u00D2', Oacute: '\u00D3', Ocirc: '\u00D4',
    Otilde: '\u00D5', Ouml: '\u00D6', Oslash: '\u00D8', Ugrave: '\u00D9',
    Uacute: '\u00DA', Ucirc: '\u00DB', Uuml: '\u00DC', Yacute: '\u00DD',
    Yuml: '\u0178',
  };

  /** One numeric entity as text. String.fromCharCode cannot represent astral
   *  code points, so "&#128512;" (an emoji) used to produce a lone surrogate
   *  that renders as a broken glyph. Out-of-range and surrogate values decode
   *  to nothing rather than throwing. */
  function _entityCodePoint(n) {
    if (!Number.isFinite(n) || n < 1 || n > 0x10FFFF) return '';
    if (n >= 0xD800 && n <= 0xDFFF) return '';
    return String.fromCodePoint(n);
  }

  /** Shared HTML → plain text pipeline (see _extractSnippet for the rationale
   *  behind each step). `maxChars` caps the result: 500 for a notification
   *  preview, much larger when a quiet-mail rule matches against the body. */
  function _htmlToText(html, maxChars) {
    if (!html) return '';
    let text = html;
    // Strip MSO conditional comments (contain things like PixelsPerInch)
    text = text.replace(/<!--\[if[^>]*>[\s\S]*?<!\[endif\]-->/gi, '');
    text = text.replace(/<!\[if[^>]*>[\s\S]*?<!\[endif\]>/gi, '');
    text = text.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '');
    text = text.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '');
    text = text.replace(/<br\s*\/?>/gi, '\n');
    text = text.replace(/<\/(p|div|li|tr|h[1-6])>/gi, '\n');
    text = text.replace(/<[^>]+>/g, '');
    // Named entities. A name we do not know is LEFT ALONE here so the
    // invisible/spacing entities below still get their turn; only after that
    // is the rest dropped.
    text = text.replace(/&([a-zA-Z][a-zA-Z0-9]{1,9});/g, (m, name) => {
      const c = HTML_ENTITIES[name];
      if (typeof c === 'string') return c;
      // A miss retries lowercase: real mail writes &NBSP; and &COPY;, and a
      // wrongly cased accent still beats losing the letter altogether.
      const lower = HTML_ENTITIES[name.toLowerCase()];
      return typeof lower === 'string' ? lower : m;
    });
    text = text.replace(/&#(\d+);/g, (_, n) => _entityCodePoint(parseInt(n, 10)));
    text = text.replace(/&#x([0-9a-f]+);/gi, (_, h) => _entityCodePoint(parseInt(h, 16)));
    // Invisible/spacing entities (used by marketing emails like Amazon)
    text = text.replace(/&(zwnj|zwj|lrm|rlm|thinsp|hairsp);/gi, '');
    text = text.replace(/&shy;/gi, '');
    text = text.replace(/&(ensp|emsp|emsp13|emsp14);/gi, ' ');
    // Catch-all for any remaining named entities, so unknown markup does not
    // leak through. &amp; is exempt and decoded on the next line, last of all:
    // decoded any earlier, its "&" would turn "&amp;starf;" into an entity
    // that this very line would then delete.
    text = text.replace(/&(?!amp;)[a-zA-Z]{2,10};/gi, '');
    text = text.replace(/&amp;/gi, '&');
    // Clean up whitespace
    text = text.replace(/[ \t]+/g, ' ');
    text = text.replace(/\n\s*\n/g, '\n');
    return text.trim().substring(0, maxChars || SNIPPET_MAX_CHARS);
  }

  // --- Quiet-mail rules (premium) ---
  //
  // Decisions are cached on the message as `_notifRule`: the `_` prefix keeps
  // it out of the persisted cache (accounts.js strips underscore fields), which
  // matters more for the body text below: decrypted bodies must never reach
  // disk, so they live only in this module-scoped map.
  const _bodyTextCache = new Map();
  const BODY_CACHE_MAX = 200;
  /** Most bodies fetched+decrypted in a single rule evaluation. */
  const BODY_FETCH_MAX = 25;
  /** Matching messages returned to the options page's rule test. */
  const TEST_MAX_RESULTS = 8;

  function _cacheBodyText(id, text) {
    if (_bodyTextCache.size >= BODY_CACHE_MAX) {
      // Cheapest bounded eviction: drop the oldest insertion.
      const oldest = _bodyTextCache.keys().next();
      if (!oldest.done) _bodyTextCache.delete(oldest.value);
    }
    _bodyTextCache.set(id, text);
  }

  /** The fields a rule matches against, from a message-list entry. */
  function _ruleView(msg) {
    const recipients = []
      .concat(msg.ToList || [], msg.CCList || [], msg.BCCList || [])
      .map(r => (r && r.Address) || '')
      .filter(Boolean);
    return {
      from: (msg.Sender && msg.Sender.Address) || '',
      // What the message list shows as the sender, matched separately from
      // the address, which is often unrelated for newsletters.
      fromName: (msg.Sender && msg.Sender.Name) || '',
      to: recipients,
      subject: msg.Subject || '',
      body: _bodyTextCache.get(msg.ID) || '',
    };
  }

  /**
   * Fetch + decrypt the bodies a body rule needs, into the memory-only cache.
   * Shared by rule evaluation and the options page's Test button, so both pay
   * the cost once. Failures cache an empty string rather than retrying forever.
   */
  async function _ensureBodies(accountId, messages) {
    let account = ProtonAccounts.getAccount(accountId);
    if (!account) return;
    // Wake race: reached from testQuietRule (the options page's Test button)
    // and from reapplyQuietRules, both message handlers that typically run in
    // a freshly woken worker where the keys are still unlocking. Returning on
    // keysUnlocked alone made every body rule test as matching nothing and the
    // options UI report 0 hits with no error. Wait for the coalesced unlock,
    // then re-read: the reference above was taken before it ran.
    await ProtonAccounts.ensureKeysUnlocked(accountId);
    account = ProtonAccounts.getAccount(accountId);
    if (!account || !account.keysUnlocked) return;
    const todo = messages.filter(m => !_bodyTextCache.has(m.ID)).slice(0, BODY_FETCH_MAX);
    await Promise.all(todo.map(async (msg) => {
      try {
        const full = await ProtonAccounts.getMessage(accountId, msg.ID);
        const decrypted = full && full.Body
          ? await ProtonAccounts.decryptBody(accountId, full.Body) : '';
        _cacheBodyText(msg.ID, _htmlToText(decrypted, ProtonNotificationRules.MAX_BODY_CHARS));
      } catch (e) {
        debugLog('[ProtonPoller] Rule body fetch failed for', msg.ID, ':', e.message);
        _cacheBodyText(msg.ID, '');
      }
    }));
  }

  /**
   * Try one rule (as currently being edited, saved or not) against the messages
   * already loaded, so the options page can show what a pattern would catch
   * without waiting for new mail. Read-only: no decisions are cached, nothing
   * is hidden, the badge is untouched.
   *
   * @returns {Promise<{total:number,count:number,matched:Array,error?:string}>}
   */
  async function testQuietRule(rule) {
    const norm = ProtonNotificationRules.normalize(rule);
    const check = ProtonNotificationRules.validate(norm);
    if (!check.ok) return { error: 'INVALID', total: 0, count: 0, matched: [] };

    const probe = { ...norm, enabled: true };
    const needsBody = ProtonNotificationRules.needsBody([probe]);
    // Per-condition tallies: the fields of a rule are ANDed, so when the rule
    // as a whole matches nothing the useful answer is WHICH condition is the
    // blocker. A leftover From is the usual culprit.
    const conditions = ProtonNotificationRules.CONDITIONS.filter(f => norm[f]);
    const fields = {};
    for (const f of conditions) fields[f] = 0;

    let total = 0;
    let count = 0;
    const matched = [];

    for (const acc of _effectiveAccountsForPolling()) {
      const account = ProtonAccounts.getAccount(acc.id);
      if (!account || !account.messages || account.messages.length === 0) continue;
      total += account.messages.length;
      if (needsBody) await _ensureBodies(acc.id, account.messages);
      for (const msg of account.messages) {
        const view = _ruleView(msg);
        if (conditions.length > 1) {
          for (const f of conditions) {
            if (ProtonNotificationRules.matches({ enabled: true, [f]: norm[f] }, view)) fields[f]++;
          }
        }
        // enabled:true. Testing a rule you have switched off is still useful.
        if (!ProtonNotificationRules.matches(probe, view)) continue;
        count++;
        if (matched.length < TEST_MAX_RESULTS) {
          matched.push({
            subject: msg.Subject || '',
            from: (msg.Sender && msg.Sender.Address) || '',
            accountEmail: acc.email,
            time: msg.Time || 0,
          });
        }
      }
    }
    return { total, count, matched, fields: conditions.length > 1 ? fields : null };
  }

  /**
   * Evaluate the quiet-mail rules over `messages`, caching each decision on the
   * message. Bodies are fetched and decrypted ONLY when an enabled rule
   * actually tests the body: that is the expensive path (one message fetch +
   * OpenPGP decrypt each), so users without a body rule never pay for it.
   */
  async function _applyNotificationRules(accountId, messages) {
    if (!messages || messages.length === 0) return;

    // Premium feature: free tier keeps every notification.
    if (typeof ProtonPremium !== 'undefined' && !ProtonPremium.isPremium()) {
      for (const m of messages) delete m._notifRule;
      return;
    }

    const s = await getSettings();
    const rules = ProtonNotificationRules.activeRules(s.notificationRules || []);
    if (rules.length === 0) {
      for (const m of messages) delete m._notifRule;
      return;
    }

    if (ProtonNotificationRules.needsBody(rules)) await _ensureBodies(accountId, messages);

    // Which rule hit how many messages, and with which effects. A hidden or
    // uncounted message otherwise leaves no trace at all: it simply is not
    // there, which is indistinguishable from a sync bug and cost a long
    // investigation to tell apart.
    const hits = new Map(); // ruleId -> count

    for (const msg of messages) {
      const v = ProtonNotificationRules.evaluate(rules, _ruleView(msg));
      msg._notifRule = v.matched.length
        ? {
          silence: v.silenceNotification, exclude: v.excludeFromCount,
          mute: v.muteSound, hide: v.hideFromInbox,
        }
        : undefined;
      if (!msg._notifRule) delete msg._notifRule;
      for (const id of v.matched) hits.set(id, (hits.get(id) || 0) + 1);
    }

    await _logQuietRuleHits(accountId, rules, hits);
  }

  /**
   * Record which quiet rules are currently suppressing mail.
   *
   * Reported when it first happens and again only when it CHANGES, because
   * this is a standing state re-evaluated on every poll, not an event. The
   * per-rule effects are spelled out separately: "silenced" and "hidden" look
   * identical from the outside but mean very different things, and the whole
   * point of the line is to tell them apart.
   */
  async function _logQuietRuleHits(accountId, rules, hits) {
    const account = ProtonAccounts.getAccount(accountId);
    const email = (account && account.email) || accountId;
    if (!hits.size) {
      // Report the transition to "nothing suppressed" too, so a log does not
      // leave a stale impression that a rule is still hiding something.
      if (await ProtonDiag.once('quiet:' + accountId, 'none')) {
        ProtonDiag.record('quiet.rules', { email, active: 0 });
      }
      return;
    }
    const byId = new Map(rules.map(r => [ProtonNotificationRules.normalize(r).id, r]));
    const parts = [];
    for (const [id, count] of hits) {
      const raw = byId.get(id);
      const r = raw ? ProtonNotificationRules.normalize(raw) : null;
      if (!r) continue;
      // The four effects, named. Anything not listed is NOT being done.
      const effects = [
        r.silenceNotification ? 'no-notification' : null,
        r.excludeFromCount ? 'not-counted' : null,
        r.muteSound ? 'no-sound' : null,
        r.hideFromInbox ? 'hidden-from-list' : null,
      ].filter(Boolean).join('+') || 'none';
      parts.push((r.name || id) + '[' + effects + ']x' + count);
    }
    if (!parts.length) return;
    const summary = parts.sort().join(' ');
    if (!(await ProtonDiag.once('quiet:' + accountId, summary))) return;
    ProtonDiag.record('quiet.rules', { email, active: parts.length, rules: summary });
    debugLog('[ProtonPoller] Quiet rules matching for', email + ':', summary);
  }

  /** Unread messages the user asked to keep out of the badge count. Only the
   *  fetched window (maxEmailsPerAccount) can be inspected, so a matching
   *  message older than that window still counts (documented in the options UI). */
  function _suppressedUnread(account) {
    if (!account || !account.messages) return 0;
    const unread = account.messages.filter(m => m.Unread === 1);
    const excluded = m => !!(m._notifRule && m._notifRule.exclude);
    // In conversation mode the server count is of CONVERSATIONS, so subtract
    // conversations, not messages: only one whose every unread message in the
    // window is excluded. Counting messages here took three excluded messages
    // of one thread off a count that held that thread once, hiding other mail.
    if (ProtonAccounts.effectiveViewMode(account) === 0) {
      const byConversation = new Map();
      for (const m of unread) {
        const key = m.ConversationID || m.ID;
        byConversation.set(key, (byConversation.get(key) !== false) && excluded(m));
      }
      let n = 0;
      for (const allExcluded of byConversation.values()) if (allExcluded) n++;
      return n;
    }
    return unread.filter(excluded).length;
  }

  // Snippets by message ID. `_snippet` is cached ON the message, but every
  // list refresh replaces account.messages with FRESH objects from
  // getMonitoredMessages, so the snippets were thrown away and re-fetched:
  // one arriving message cost five message GETs plus five OpenPGP decrypts in
  // a single poll, and its own body was fetched twice (once to notify, once
  // after the list refetch). Memory-only and bounded for the same reason as
  // _bodyTextCache above: decrypted text must never reach disk.
  const _snippetCache = new Map();
  // Comfortably over maxEmailsPerAccount (at most 20) for a dozen accounts.
  const SNIPPET_CACHE_MAX = 300;

  function _cacheSnippet(id, text) {
    // Only an INSERT can grow the map. Evicting on an UPDATE too meant that at
    // the bound, re-caching an id already held still threw another message's
    // snippet away, so the cache shrank its useful contents for no gain.
    if (!_snippetCache.has(id) && _snippetCache.size >= SNIPPET_CACHE_MAX) {
      // Cheapest bounded eviction: drop the oldest insertion.
      const oldest = _snippetCache.keys().next();
      if (!oldest.done) _snippetCache.delete(oldest.value);
    }
    _snippetCache.set(id, text);
  }

  /**
   * Refill the cache from the messages this account already holds.
   *
   * The session snapshot carries _snippet for every held message and is
   * restored on a wake, but the cache above is module state and starts EMPTY
   * in a fresh MV3 worker generation. The first list refresh then replaces
   * account.messages with fresh objects from getMonitoredMessages, which have
   * no _snippet and find nothing cached: measured against the real extension,
   * one arriving message still cost four body fetches plus four decrypts.
   * Seeding before anything can replace that list makes a restored snapshot
   * repopulate the cache, so only the newcomer is fetched.
   */
  function _seedSnippetCache(account) {
    if (!account || !account.messages) return;
    for (const m of account.messages) {
      // Only a snippet that actually has text. A FAILED fetch also leaves
      // _snippet '' on the held message (so the rest of that poll does not
      // retry it) and the snapshot carries that '' along, so seeding empties
      // would put back into the cache exactly what the fetch path refuses to
      // cache, pinning a blank preview for the whole browser run after one
      // transient blip. A genuinely text-free message costs one re-read per
      // worker generation instead, which is much the cheaper mistake.
      if (m && m.ID && typeof m._snippet === 'string' && m._snippet !== '') {
        _cacheSnippet(m.ID, m._snippet);
      }
    }
  }

  /**
   * Fetch and cache _snippet for messages that don't have one yet.
   *
   * `options.force` bypasses the previewLines gate. The notification body has
   * its own setting (notificationPreviewText), which defaults ON while
   * previewLines defaults to 0, so gating on previewLines alone made "Show
   * message preview in notifications" do nothing out of the box. The
   * whole-list passes keep the gate, so a user who wants neither pays nothing.
   */
  async function _fetchSnippets(accountId, messages, options) {
    if (!messages || messages.length === 0) return;
    const s = await getSettings();
    if (!(options && options.force) && !parseInt(s.previewLines, 10)) return;

    // Anything already decrypted this browser run, whichever list object held
    // it last time. Done before the keys check: re-attaching a known snippet
    // costs nothing and needs no keys.
    const todo = [];
    for (const msg of messages) {
      if (msg._snippet !== undefined) continue;
      const cached = _snippetCache.get(msg.ID);
      if (cached !== undefined) { msg._snippet = cached; continue; }
      todo.push(msg);
    }
    if (todo.length === 0) return;

    const account = ProtonAccounts.getAccount(accountId);
    if (!account || !account.keysUnlocked) return;

    await Promise.all(todo.map(async (msg) => {
      try {
        const fullMsg = await ProtonAccounts.getMessage(accountId, msg.ID);
        if (fullMsg && fullMsg.Body) {
          const decrypted = await ProtonAccounts.decryptBody(accountId, fullMsg.Body);
          msg._snippet = _extractSnippet(decrypted);
        } else {
          msg._snippet = '';
        }
        // A message with no text really has no snippet, so that empty string
        // is a RESULT and is worth caching.
        _cacheSnippet(msg.ID, msg._snippet);
      } catch (e) {
        debugLog('[ProtonPoller] Snippet fetch failed for', msg.ID, ':', e.message);
        // A FAILURE is not cached: one transient blip used to remove this
        // message's notification and list preview for the whole browser run.
        // '' on this list object only, so the rest of this poll does not retry
        // it in a loop; the next poll's fresh objects try again.
        msg._snippet = '';
      }
    }));
  }

  /** Get aggregated state for the popup. */
  function getState() {
    const accounts = ProtonAccounts.getAccounts();
    // Only the accounts that are checked count: without Premium that is the
    // first one, and the popup shows the others locked. Their counts are
    // left from the trial, and they used to stay in the badge for good.
    const checked = new Set(_effectiveAccountsForPolling().map(a => a.id));
    let totalUnread = 0;
    let allMessages = [];

    for (const acc of accounts) {
      const full = ProtonAccounts.getAccount(acc.id);
      if (!full) continue;

      // Quiet-mail rules can keep matching mail out of the badge. The server
      // gives us a total, so the exclusion is a subtraction over the messages
      // we actually hold (never below zero).
      const unread = Math.max(0, (full.unreadCount || 0) - _suppressedUnread(full));
      if (checked.has(acc.id)) totalUnread += unread;

      // A quiet-mail rule can keep matching mail out of the list entirely.
      // Filtered here rather than in the popup so every consumer of the state
      // (list, navigation, preview reconcile) agrees on what exists.
      const msgs = (full.messages || [])
        .filter(m => !(m._notifRule && m._notifRule.hide))
        .map(m => ({
          ...m,
          _accountId: acc.id,
          _accountEmail: acc.email,
        }));
      // The list holds at most "messages per account", the count is
      // Proton's. What the count holds beyond the unread mail listed: the
      // popup adds it to the unread it lists, so its per-account counts
      // agree with the badge and still follow its own optimistic updates.
      acc.unreadUnlisted = Math.max(0, unread - msgs.filter(m => m.Unread === 1).length);
      allMessages = allMessages.concat(msgs);
    }

    // Sort combined messages by time (newest first)
    allMessages.sort((a, b) => (b.Time || 0) - (a.Time || 0));

    return {
      isLoggedIn: ProtonAccounts.hasAccounts(),
      accounts,
      unreadCount: totalUnread,
      messages: allMessages,
      lastCheckTime: _lastCheckTime,
      badgeState: ProtonBadge.getState(),
      isPolling: _isPolling, // so the popup can spin refresh if a poll is already running at open
    };
  }

  // --- Per-account polling ---
  //
  // Each account is polled independently. On first load, we fetch unread counts
  // and message lists via direct API calls (_pollAccountViaCounts), then capture
  // the latest event ID. Subsequent polls use the event stream
  // (_pollAccountViaEvents) which returns only changes since the last event,
  // making polling far more efficient. If the event stream signals a full
  // refresh is needed (Refresh flag), we fall back to count-based polling.
  //
  // Error handling uses Fibonacci backoff: [1, 1, 2, 3, 5, 8, 13] × base interval.

  /**
   * Poll one account. Returns what happened, so poll() can tell a real failure
   * from a deliberate skip:
   *   'ok'       the poll completed
   *   'skipped'  nothing was attempted, or the server told us to wait
   *   'error'    anything else went wrong (network down, 5xx, parse failure)
   *
   * Swallowing every error here left poll()'s catch block unreachable, and
   * that block is the ONLY caller of ProtonBadge.setError and the only place
   * the Fibonacci backoff escalates: with the API blocked, three consecutive
   * failed cycles left the error count at 0, showed no error badge, and kept
   * the alarm on its 1-minute period, firing a doomed request every minute.
   */
  async function _pollAccount(accountId) {
    const account = ProtonAccounts.getAccount(accountId);
    if (!account) return 'skipped';

    // Before anything can replace account.messages: both the event path and
    // the counts path refetch the list, and after a wake the snapshot's
    // snippets are the only copy left (see _seedSnippetCache).
    _seedSnippetCache(account);

    // Permanent auth failure (invalid refresh token, account disabled):
    // every request can only fail until the user signs in again, so skip.
    // The popup shows the per-account "Sign in" banner meanwhile.
    if (account.authError) {
      debugLog('[ProtonPoller] Skipping', account.email, '- auth error:', account.authError);
      return 'skipped';
    }

    // Server asked us to back off (429/503 Retry-After). Honor it.
    if (account.nextPollNotBefore && Date.now() < account.nextPollNotBefore) {
      debugLog('[ProtonPoller] Skipping', account.email, '- rate limited for another',
        Math.round((account.nextPollNotBefore - Date.now()) / 1000), 's');
      return 'skipped';
    }

    if (!(await _ensureKeys(accountId, account.email))) {
      // An unlock that was ATTEMPTED and failed is a real failure, not a
      // skip: the attempt is itself an API round trip (users + addresses).
      // MV3 wakes with the in-memory keys gone, so with the network down
      // EVERY poll fails here before reaching the try below, and calling
      // that a skip left the backoff just as unreachable as before, one
      // doomed request per minute with a clean badge.
      // An account with nothing to unlock WITH (no key password yet:
      // two-password mode before the user has entered it) sends no request,
      // so that one really is a skip. Re-read the account: it can be removed
      // while the unlock runs, and gone is not broken either.
      const live = ProtonAccounts.getAccount(accountId);
      // 'keyerror', not plain 'error': it backs off exactly the same, but the
      // badge tooltip has to say something different. "network error" on a
      // stale stored key password sends the user to check their wifi when the
      // fix is to sign in again, and the tooltip is the only place they see a
      // reason without opening the popup.
      return live && live.keyPassword ? 'keyerror' : 'skipped';
    }

    try {
      if (account.lastEventId) {
        await _pollAccountViaEvents(accountId);
      } else {
        await _pollAccountViaCounts(accountId);
      }
      account.nextPollNotBefore = null;
      return 'ok';
    } catch (err) {
      debugLog('[ProtonPoller] Poll error for', account.email, ':', err.message);
      if (err.retryAfterSec) {
        account.nextPollNotBefore = Date.now() + err.retryAfterSec * 1000;
        debugLog('[ProtonPoller] Server rate limit, deferring', account.email,
          'for', err.retryAfterSec, 's');
        // The server's own deferral IS the backoff. Counting it as a failure
        // too would defer this account twice over.
        return 'skipped';
      }
      // A dead session is not a connection problem: it already shows as "!"
      // on the badge via account.authError, and the check above skips it from
      // the next poll on. Slowing every account down for it helps nobody.
      if (err.permanentAuth) return 'skipped';
      return 'error';
    }
  }

  /** Which user edit of the monitored folders an account is on. Bumped only
   *  by the picker, by settings imports and by Premium starting or ending
   *  (the folders are a Pro setting), never by the automatic removal of a
   *  folder deleted in Proton: that one changes nothing the count or list
   *  contain, so it must not look like the user switched folders. */
  const _gen = account => (account && account.scopeGen) || 0;

  /** Notify `messages` (after snippets and quiet rules). */
  async function _announce(accountId, account, messages) {
    if (!messages || messages.length === 0) return;
    // The notification body reads _snippet under its own setting, so ask for
    // snippets here even when the list preview (previewLines) is off. Only
    // for the handful of messages about to be notified, and the cache means
    // the list pass below does not fetch them again.
    //
    // But only when a notification can actually appear: notifyNewMessages
    // drops out on DND and on either notification switch, and a message GET
    // plus an OpenPGP decrypt per arrival for a notification nobody will see
    // is precisely the cost the previewLines gate exists to avoid.
    const s = await getSettings();
    // The account's own switch is Pro: without Premium it stays stored but
    // is out of effect, as in notifyNewMessages.
    const premium = typeof ProtonPremium === 'undefined' || ProtonPremium.isPremium();
    const willNotify = s.notificationsEnabled !== false &&
      !(premium && account.notificationsEnabled === false) &&
      !(typeof ProtonDND !== 'undefined' && ProtonDND.isActive());
    await _fetchSnippets(accountId, messages, {
      force: willNotify && s.notificationPreviewText !== false,
    });
    await _applyNotificationRules(accountId, messages);
    await ProtonNotifier.notifyNewMessages(messages, account.email, accountId);
  }

  /**
   * Poll an account using Proton's event stream (GET /core/v5/events/{eventId}).
   *
   * Returns only changes since the last event ID, making this far more efficient
   * than fetching full message counts/lists. Falls back to _pollAccountViaCounts
   * if the event stream signals a full refresh (Refresh flag) or on error.
   * Follows More=1 page by page within one call: the newest page's counts win,
   * and the list is refetched at most once. (A recursive call used to set the
   * newer count, then have this older page overwrite it and refetch again.)
   *
   * Every page moves the cursor past its creates, so whatever the pages read
   * so far is announced before ANY early exit (an error, Refresh, a reset):
   * nothing will deliver those creates again.
   */
  const EVENT_PAGES_MAX = 20;

  async function _pollAccountViaEvents(accountId) {
    const account = ProtonAccounts.getAccount(accountId);
    if (!account || !account.lastEventId) {
      return _pollAccountViaCounts(accountId);
    }

    const monitoredIds = ProtonAccounts.getMonitoredLabelIds(accountId);
    // The count kind must match the REST counts (getCountsForViewMode), which
    // follow the web client's bucket when known. Deciding on the raw viewMode
    // here made the two disagree for anyone with grouping off in the web app:
    // the badge flipped between kinds and every flip refetched the list.
    const conversationCounts = ProtonAccounts.effectiveViewMode(account) === 0;
    let unreadCount = account.unreadCount;
    const newMessages = [];
    let keysChanged = false;
    let pendingErr = null;
    let fallBack = false;
    // The cursor this loop expects to find. Anything else means it was reset
    // (the monitored folders changed) while we waited, before or after a page.
    let expected = account.lastEventId;

    for (let page = 0; page < EVENT_PAGES_MAX; page++) {
      if (account.lastEventId !== expected) { fallBack = true; break; }
      let eventData;
      try {
        eventData = await ProtonAccounts.getEvents(accountId, expected);
      } catch (err) {
        // Rate limits and permanent auth failures must NOT trigger the counts
        // fallback: that would fire more requests at a server that just told
        // us to stop. _pollAccount handles the deferral once this rethrows.
        if (err.retryAfterSec || err.permanentAuth) { pendingErr = err; break; }
        debugLog('[ProtonPoller] Event poll failed for', account.email, ':', err.message);
        if (page === 0) fallBack = true;
        break; // later pages: keep what the earlier ones delivered
      }

      // Re-arming the cursor from this reply would undo a reset that landed
      // while it was in flight and keep the old folders' list.
      if (account.lastEventId !== expected) { fallBack = true; break; }

      if (eventData.Refresh) {
        account.lastEventId = null;
        if (await ProtonAccounts.noteAccountEvents(accountId, eventData)) keysChanged = true;
        fallBack = true;
        break;
      }

      if (eventData.EventID) {
        account.lastEventId = eventData.EventID;
        expected = eventData.EventID;
      }

      // Our own MailSettings, and User/Addresses changes (keys may be new).
      if (await ProtonAccounts.noteAccountEvents(accountId, eventData)) keysChanged = true;

      // Extract unread count based on monitored folders. Only the kind that
      // matches the view mode: when a page lacks it, the count is left as it
      // is rather than computed from the other kind.
      const eventCounts = conversationCounts ? eventData.ConversationCounts : eventData.MessageCounts;
      if (eventCounts) {
        if (monitoredIds === null) {
          // "all" mode: use All Mail
          const allMail = eventCounts.find(c => c.LabelID === ProtonLabels.ALL_MAIL);
          if (allMail) unreadCount = allMail.Unread;
        } else {
          let total = 0;
          for (const id of monitoredIds) {
            const c = eventCounts.find(cnt => cnt.LabelID === id);
            if (c) total += c.Unread;
          }
          unreadCount = total;
        }
        // The event carries every folder and label's counts, so a monitored
        // folder deleted in Proton shows up here as a missing entry.
        await ProtonAccounts.checkMonitoredAgainstCounts(accountId, eventCounts);
      }

      // Detect new messages matching monitored folders
      if (eventData.Messages) {
        for (const event of eventData.Messages) {
          if (event.Action === 1 && event.Message) {
            const msg = event.Message;
            if (msg.LabelIDs && msg.Unread === 1) {
              // null = all folders match; otherwise check intersection
              if (monitoredIds === null || msg.LabelIDs.some(id => monitoredIds.includes(id))) {
                newMessages.push(msg);
              }
            }
          }
        }
      }

      if (eventData.More !== 1) break;
    }

    // New keys or addresses: re-read them before decrypting the mail this
    // poll found, or its preview and any body rule see nothing.
    if (keysChanged) {
      try { await ProtonAccounts.ensureKeysUnlocked(accountId); } catch (_) { /* old set still serves */ }
    }

    await _announce(accountId, account, newMessages);

    if (pendingErr) {
      // Keep the count the pages delivered; the list waits for the next poll
      // rather than sending more requests at a server that asked us to stop.
      // Marked stale so that next poll refetches it whatever the counts do.
      account.unreadCount = unreadCount;
      account.listLimit = null;
      throw pendingErr;
    }

    // Also refetch when the list was built for a different "emails per
    // account" setting: otherwise a changed setting showed only once some
    // count happened to change.
    const maxEmails = await _getMaxEmails();

    // A folder change can also land during the awaits after the last page
    // (announcing, re-reading keys). The count above is for the old folders,
    // so hand over to the full fetch rather than store it as the new ones'.
    if (account.lastEventId !== expected) fallBack = true;
    if (fallBack) return _pollAccountViaCounts(accountId);

    if (unreadCount !== account.unreadCount || newMessages.length > 0 ||
        account.listLimit !== maxEmails) {
      account.unreadCount = unreadCount;
      try {
        const gen = _gen(account);
        account.messages = await ProtonAccounts.getMonitoredMessages(accountId, maxEmails, { unreadOnly: true });
        account.listLimit = maxEmails;
        account.countGen = gen;
        ProtonTombstones.apply(account);
      } catch (e) {
        account.listLimit = null; // refetch next poll
        console.warn('[ProtonPoller] Message refresh after event failed:', e.message);
      }
    }

    // Fetch snippets for any messages missing them (covers setting just enabled)
    await _fetchSnippets(accountId, account.messages);
    // Re-evaluate over the whole window so the badge exclusion also covers
    // messages that arrived before a rule was added.
    await _applyNotificationRules(accountId, account.messages);

    account.lastCheckTime = Date.now();
  }

  /**
   * Poll an account using direct message count + list API calls.
   *
   * Fallback strategy when no event ID is available (first load) or when
   * the event stream signals a full refresh. Also captures the latest event ID
   * so subsequent polls can use the more efficient event-based approach.
   *
   * The cursor is taken FIRST: events after it are read by the next poll, so
   * mail that lands while the count and list load is still announced. Taken
   * last, it skipped past such mail, which then was never announced.
   */
  async function _pollAccountViaCounts(accountId) {
    const account = ProtonAccounts.getAccount(accountId);
    if (!account) return;
    // Which folder selection is being fetched. If the user changes it while
    // this runs, the list below is for the old one and must not get a cursor.
    const genAtStart = _gen(account);

    let cursor = null;
    if (!account.lastEventId) {
      try {
        cursor = await ProtonAccounts.getLatestEventId(accountId);
      } catch (e) { console.warn('[ProtonPoller] Event ID fetch failed:', e.message); }
    }

    // "The count rose" means new mail only when the old count was taken for
    // the same folder selection. After the user changed it (picker, import,
    // sync) the rise is the added folders' existing mail. Decided right before
    // the count request, with no await in between, so both refer to one
    // selection.
    const sameScope = account.countGen === genAtStart && _gen(account) === genAtStart;
    const unreadCount = await ProtonAccounts.getMonitoredUnreadCount(accountId);

    if (sameScope && account.unreadCount >= 0 && unreadCount > account.unreadCount) {
      const newUnread = await ProtonAccounts.getMonitoredMessages(accountId, 5, { unreadOnly: true });
      await _announce(accountId, account, newUnread);
    }

    account.unreadCount = unreadCount;

    try {
      const maxEmails = await _getMaxEmails();
      account.messages = await ProtonAccounts.getMonitoredMessages(accountId, maxEmails, { unreadOnly: true });
      account.listLimit = maxEmails;
      account.countGen = genAtStart;
      ProtonTombstones.apply(account);
      if (!sameScope) await _takeInNewSelection(accountId, account);
    } catch (e) {
      account.listLimit = null; // refetch next poll
      console.warn('[ProtonPoller] Message fetch failed:', e.message);
    }

    // Fetch snippets for any messages missing them (covers setting just enabled)
    await _fetchSnippets(accountId, account.messages);
    await _applyNotificationRules(accountId, account.messages);

    // No cursor for a list of folders that changed while it loaded: the next
    // poll fetches the new set in full. Checked after the last await.
    if (_gen(account) === genAtStart && !account.lastEventId && cursor) {
      account.lastEventId = cursor;
    }

    account.lastCheckTime = Date.now();
  }

  /**
   * The list after the user changed the monitored folders: its existing mail
   * is taken in silently, but what arrived since the last check is real new
   * mail and is announced. That needs a recent last check: after a browser
   * restart it is hours old, and that mail is shown, not announced.
   */
  async function _takeInNewSelection(accountId, account) {
    const intervalMs = (await _getPollInterval()) * 60 * 1000;
    const last = account.lastCheckTime || 0;
    if (last && Date.now() - last <= 2 * intervalMs + 60 * 1000) {
      // A minute of slack for the difference between our clock and Proton's.
      const since = last / 1000 - 60;
      await _announce(accountId, account, (account.messages || []).filter(m => (m.Time || 0) > since));
    }
    await ProtonNotifier.seedNotifiedIds(account.messages);
  }

  // --- Main poll ---

  /** Tell an open popup that fresh state is available (no-op when closed).
   *  The popup re-fetches GET_STATE and re-renders. This is what turns a
   *  stale snapshot served right after a service-worker cold start into
   *  live data without the user clicking refresh. */
  function _broadcastStateUpdate() {
    try {
      browser.runtime.sendMessage({ type: 'STATE_UPDATED' }).catch(() => {});
    } catch (_) { /* no listeners / messaging unavailable */ }
  }

  /** Tell an open popup whether a poll is currently running, so it can spin the
   *  refresh button during a background poll exactly as it does for a manual one.
   *  Best-effort: a no-op when the popup is closed. */
  function _broadcastPolling(active) {
    try {
      browser.runtime.sendMessage({ type: 'POLL_STATUS', polling: !!active }).catch(() => {});
    } catch (_) { /* no listeners / messaging unavailable */ }
  }

  /**
   * Poll immediately if the newest successful check is older than the poll
   * interval. Called when the popup opens: after a service-worker cold start
   * GET_STATE can only serve the restored snapshot, which may be many minutes
   * old. Without this the stale view would persist until the next alarm.
   */
  async function pollIfStale() {
    try {
      if (_isPolling) return;
      if (!ProtonAccounts.hasAccounts()) return;
      const intervalMs = (await _getPollInterval()) * 60 * 1000;
      const accounts = ProtonAccounts.getAccounts();
      const newest = Math.max(_lastCheckTime || 0, _lastPollAttempt || 0,
        ...accounts.map(a => a.lastCheckTime || 0));
      if (Date.now() - newest > intervalMs) {
        debugLog('[ProtonPoller] State stale on popup open, polling now');
        await poll();
      }
    } catch (e) {
      debugLog('[ProtonPoller] pollIfStale failed:', e.message);
    }
  }

  async function poll() {
    if (_isPolling) return;
    if (!ProtonAccounts.hasAccounts()) {
      ProtonBadge.setLoggedOut();
      return;
    }

    _isPolling = true;
    _lastPollAttempt = Date.now();
    _broadcastPolling(true);
    try {
      await _loadErrorCount();
      const accounts = _effectiveAccountsForPolling();
      const results = await Promise.all(accounts.map(acc => _pollAccount(acc.id)));

      // Persist the fresh per-account state so the next BG wake-up
      // (Firefox event page idle, Chrome SW shutdown) restores instantly.
      // Before the failure check below: a cycle that ended badly can still
      // have advanced an event cursor and announced mail, and replaying that
      // on the next wake would be worse than saving it.
      ProtonAccounts.saveSnapshot();

      // A poll counts as failed only when every account that actually tried
      // failed. One 'ok' means the badge is showing real data for that
      // account, so an error badge would be a lie. Accounts that returned
      // 'skipped' (auth error, server Retry-After, keys locked) count on
      // neither side: they carry their own deferral, and adding the backoff
      // on top would defer them twice.
      const attempted = results.filter(r => r === 'ok' || r === 'error' || r === 'keyerror');
      if (attempted.length > 0 && !attempted.includes('ok')) {
        const failure = new Error('all ' + attempted.length + ' polled account(s) failed');
        // Only when EVERY failure was an unlock: one account with a bad key
        // password beside another that is merely offline is still, for the
        // user, a connection problem.
        failure.keysOnly = attempted.every(r => r === 'keyerror');
        throw failure;
      }

      _lastCheckTime = Date.now();
      const state = getState();
      _updateBadge(state.unreadCount);
      _broadcastStateUpdate();

      // Success: reset backoff and restore normal interval
      if (_errorCount > 0) {
        _errorCount = 0;
        await _saveErrorCount();
        await restart();
        debugLog('[ProtonPoller] Backoff reset, normal interval restored');
      }
    } catch (err) {
      console.error('[ProtonPoller] Poll error:', err.message);
      // setError's text goes straight into the badge tooltip, so it has to be
      // translated: err_network_error exists in all 28 locales. Now that this
      // block is reachable at all (see _pollAccount), an English-only tooltip
      // would be what every offline user actually reads. Guarded the way
      // badge.js guards its own lookups, for contexts loaded without i18n.
      ProtonBadge.setError(_pollErrorText(err));

      // Apply Fibonacci backoff
      _errorCount = Math.min(_errorCount + 1, BACKOFF_MULTIPLIERS.length - 1);
      await _saveErrorCount();
      const multiplier = BACKOFF_MULTIPLIERS[_errorCount];
      const baseInterval = await _getPollInterval();
      const backoffInterval = baseInterval * multiplier;
      await stop();
      // One-shot on purpose: start() recognises a pending alarm without a
      // period as a backoff and leaves it alone.
      browser.alarms.create(ALARM_NAME, { delayInMinutes: backoffInterval });
      debugLog('[ProtonPoller] Backoff: next poll in', backoffInterval, 'min (error #' + (_errorCount) + ')');
    } finally {
      _isPolling = false;
      _broadcastPolling(false);
    }
  }

  /** Initial load for all accounts, or only those in `accountIds`. */
  async function initialLoad(accountIds) {
    if (!ProtonAccounts.hasAccounts()) {
      ProtonBadge.setLoggedOut();
      return;
    }
    // Share the poll lock so an init-driven initial load and an alarm-driven poll()
    // on the same wake can't both fetch (double network + list flicker).
    if (_isPolling) return;
    _isPolling = true;
    _broadcastPolling(true);
    try {
      await _doInitialLoad(accountIds);
    } finally {
      _isPolling = false;
      _broadcastPolling(false);
    }
  }

  async function _doInitialLoad(accountIds) {
    debugLog('[ProtonPoller] Starting initial load...');
    const accounts = _effectiveAccountsForPolling()
      .filter(a => !accountIds || accountIds.includes(a.id));
    const maxEmails = await _getMaxEmails();

    await Promise.all(accounts.map(async (acc) => {
      try {
        const account = ProtonAccounts.getAccount(acc.id);

        // Same reason as in _pollAccount: resume() sends accounts without a
        // cursor through here, and the list below replaces the very objects
        // that hold the restored snapshot's snippets.
        _seedSnippetCache(account);

        // A server Retry-After still running: the poll picks this up later.
        if (account.nextPollNotBefore && Date.now() < account.nextPollNotBefore) {
          debugLog('[ProtonPoller] Initial load skipped for', acc.email, '- rate limited');
          return;
        }
        // No cursor survives a load that fails part-way: resuming from an old
        // one would replay everything since as new mail.
        account.lastEventId = null;

        if (!(await _ensureKeys(acc.id, acc.email))) return;

        const genAtStart = _gen(account);
        // Cursor first, as in _pollAccountViaCounts: mail landing during the
        // load is read by the next poll instead of skipped.
        let cursor = null;
        try {
          cursor = await ProtonAccounts.getLatestEventId(acc.id);
        } catch (e) { console.warn('[ProtonPoller] Event ID fetch failed:', e.message); }

        account.unreadCount = await ProtonAccounts.getMonitoredUnreadCount(acc.id);
        account.messages = await ProtonAccounts.getMonitoredMessages(acc.id, maxEmails, { unreadOnly: true });
        account.listLimit = maxEmails;
        account.countGen = genAtStart;
        ProtonTombstones.apply(account);
        await _fetchSnippets(acc.id, account.messages);
        // Without this the badge and list ignore quiet-mail rules until the
        // first poll after a cold start: hidden mail would reappear and
        // excluded mail would count again after every browser restart.
        await _applyNotificationRules(acc.id, account.messages);
        await ProtonNotifier.seedNotifiedIds(account.messages);

        // Not for a list built for folders that changed while it loaded.
        if (_gen(account) === genAtStart && !account.lastEventId && cursor) {
          account.lastEventId = cursor;
        }

        account.lastCheckTime = Date.now();
        debugLog('[ProtonPoller] Loaded', acc.email, '- unread:', account.unreadCount);
      } catch (err) {
        console.error('[ProtonPoller] Initial load failed:', err.message);
      }
    }));

    _lastCheckTime = Date.now();
    ProtonAccounts.saveSnapshot();
    const state = getState();
    _updateBadge(state.unreadCount);
    _broadcastStateUpdate();
    debugLog('[ProtonPoller] Initial load complete, total unread:', state.unreadCount);
  }

  /**
   * Make sure the poll alarm exists with the current interval.
   *
   * Only CREATES it when it is missing or its period is wrong.
   * alarms.create() with an existing name replaces that alarm and restarts its
   * delay, and this runs on every background wake, so re-creating it pushed
   * the poll back each time anything woke the page: a tab update, the popup,
   * another alarm. On the 15-minute free tier the poll could then almost never
   * fire. The token-refresh alarm had the same bug (accounts.js).
   *
   * A pending alarm WITHOUT a period is a backoff one-shot (see poll()) and is
   * left alone; the first successful poll after it calls restart().
   */
  async function start() {
    const interval = await _getPollInterval();
    try {
      const existing = await browser.alarms.get(ALARM_NAME);
      if (existing && (!existing.periodInMinutes || existing.periodInMinutes === interval)) {
        debugLog('[ProtonPoller] Polling already scheduled, interval:', interval, 'min');
        return;
      }
    } catch (_) {
      // alarms.get unavailable: fall through and create, the old behaviour.
    }
    browser.alarms.create(ALARM_NAME, {
      delayInMinutes: interval,
      periodInMinutes: interval,
    });
    debugLog('[ProtonPoller] Polling started, interval:', interval, 'min');
  }

  /** Remove the poll alarm. Returns the promise so restart() can wait for it:
   *  otherwise start() could still see the old alarm and keep it. */
  function stop() {
    return Promise.resolve(browser.alarms.clear(ALARM_NAME)).catch(() => {});
  }

  /**
   * Re-evaluate the quiet-mail rules over the messages already loaded, then
   * refresh the badge and the popup. Called when settings change so editing a
   * rule takes effect at once instead of at the next scheduled poll (which can
   * be 15 minutes away). No message-list request is made: only bodies a new
   * body rule needs, and those are cached after the first time.
   *
   * Coalesced: the options page saves on every edit, and overlapping runs
   * would fetch the same bodies twice. A request arriving mid-run schedules
   * exactly one more pass, so the last edit always wins.
   */
  let _reapplyInFlight = null;
  let _reapplyAgain = false;
  function reapplyQuietRules() {
    if (_reapplyInFlight) { _reapplyAgain = true; return _reapplyInFlight; }
    _reapplyInFlight = (async () => {
      do {
        _reapplyAgain = false;
        for (const acc of _effectiveAccountsForPolling()) {
          const account = ProtonAccounts.getAccount(acc.id);
          if (!account || !account.messages) continue;
          try {
            await _applyNotificationRules(acc.id, account.messages);
          } catch (e) {
            debugLog('[ProtonPoller] Rule re-apply failed for', acc.email, ':', e.message);
          }
        }
        const state = getState();
        _updateBadge(state.unreadCount);
        _broadcastStateUpdate();
      } while (_reapplyAgain);
    })().finally(() => { _reapplyInFlight = null; });
    return _reapplyInFlight;
  }

  /**
   * The user has just fixed whatever was failing, typically by signing in
   * again. The escalated wait is no longer justified.
   *
   * start() deliberately leaves a pending one-shot alone (it cannot tell a
   * backoff from a fresh schedule), and initialLoad() never touched the error
   * count, so a successful sign-in used to load the mail at once and then sit
   * there: the next AUTOMATIC poll was still up to a full backoff interval
   * away. That is 13 minutes on the 1-minute premium cadence and over three
   * hours on the 15-minute free one, immediately after the user did the right
   * thing.
   */
  async function resetBackoff() {
    _errorCount = 0;
    await _saveErrorCount();
    await restart();
    debugLog('[ProtonPoller] Backoff cleared after a successful sign-in');
  }

  /** Replace the poll alarm unconditionally (backoff over). */
  async function restart() {
    await stop();
    await start();
  }

  /**
   * Continue after a background wake that restored this browser run's
   * snapshot, instead of reloading everything.
   *
   * The full reload used to run on every wake not caused by the poll alarm (a
   * tab update, the popup, a notification click, another alarm). It jumped
   * the event cursor to the newest event without reading the ones in between,
   * so mail that arrived since the last poll was listed but never notified:
   * 32 such gaps in 6 hours of one real log.
   *
   * Now accounts that still have their cursor resume from it, and only when
   * the last check is older than the poll interval; otherwise the alarm, which
   * start() no longer pushes back, polls on schedule from the same cursor.
   * Only accounts with no cursor get the full load, and a start from the disk
   * cache (a browser restart) keeps the full load for everyone: mail that
   * arrived while the browser was closed is shown, not announced.
   */
  async function resume() {
    if (!ProtonAccounts.hasAccounts()) {
      ProtonBadge.setLoggedOut();
      return;
    }
    if (ProtonAccounts.snapshotSource() !== 'session') {
      debugLog('[ProtonPoller] Resume: no session snapshot, full load');
      return initialLoad();
    }
    const polled = _effectiveAccountsForPolling()
      .map(a => ProtonAccounts.getAccount(a.id))
      .filter(a => a && !a.authError);
    // Not an account inside a server Retry-After: poll() picks it up after.
    const cold = polled
      .filter(a => !a.lastEventId && !(a.nextPollNotBefore && Date.now() < a.nextPollNotBefore))
      .map(a => a.id);
    if (cold.length) {
      debugLog('[ProtonPoller] Resume: full load for', cold.length, 'account(s) without a cursor');
      await initialLoad(cold);
    }
    debugLog('[ProtonPoller] Resume: from saved cursor');
    await pollIfStale();
  }

  /** Refetch the lists now if the "emails per account" setting changed. */
  async function syncListLimit() {
    const maxEmails = await _getMaxEmails();
    const stale = _effectiveAccountsForPolling().some(a => {
      const acc = ProtonAccounts.getAccount(a.id);
      return acc && acc.lastEventId && acc.listLimit && acc.listLimit !== maxEmails;
    });
    if (stale) await poll();
  }

  function handleAlarm(alarm) {
    if (alarm.name === ALARM_NAME) {
      poll();
    }
  }

  return {
    poll, pollIfStale, start, stop, restart, resetBackoff, initialLoad, resume, syncListLimit,
    handleAlarm, getState, refreshBadgeNow, reapplyQuietRules, testQuietRule,
  };
})();
