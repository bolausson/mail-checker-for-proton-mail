/**
 * Badge and icon management for the browser action button.
 */

const ProtonBadge = (() => {
  const DEFAULT_COLOR = '#6D4AFF';
  const RED = '#FF0000';
  // Attention/warning colour for the "an account needs you to act" badge state
  // (e.g. a session expired and needs re-login, or an account was disabled).
  // Distinct from RED (a global connection error) and the purple unread badge.
  const ATTENTION = '#F5800A';

  /** Localised string with an English fallback: background i18n may not be
   *  initialised yet on the very first badge paint, and unit tests stub it.
   *  Extra args fill $1, $2... in the translation or, when we fall back, in the
   *  English text, so the result reads the same either way. */
  function _t(key, fallback, ...args) {
    try {
      const v = typeof ProtonI18n !== 'undefined' && ProtonI18n.t(key, ...args);
      if (v && v !== key) return v;
    } catch (_) {
      // i18n unavailable: fall through to the English fallback below.
    }
    let str = fallback;
    for (let i = 0; i < args.length; i++) str = str.replace('$' + (i + 1), args[i]);
    return str;
  }

  // MV3 exposes browser.action (both Firefox and Chrome). browserAction
  // kept as a defensive fallback only.
  const _action = browser.action || browser.browserAction;

  async function _getBadgeColor() {
    const s = await getSettings();
    return s.badgeColor || DEFAULT_COLOR;
  }

  const NORMAL_ICONS = {
    16: 'icons/icon-16.png',
    32: 'icons/icon-32.png',
    48: 'icons/icon-48.png',
    64: 'icons/icon-64.png',
  };

  const GRAY_ICONS = {
    16: 'icons/icon-gray-16.png',
    32: 'icons/icon-gray-32.png',
    48: 'icons/icon-gray-48.png',
    64: 'icons/icon-gray-64.png',
  };

  let _currentState = 'unknown';

  /** Format an unread count for the limited (~4 char) badge area. */
  function _countText(count) {
    if (count <= 0) return '';
    return count > 999 ? `${Math.floor(count / 1000)}K+` : String(count);
  }

  /**
   * Set badge to show unread count.
   *
   * When `hasIssue` is true, an account needs the user's attention (expired
   * session / disabled account). We surface it by appending "!" to the unread
   * count in an attention colour (e.g. "3!" with 3 unread elsewhere, or just
   * "!" when nothing is unread), so the problem is visible without opening the
   * popup.
   */
  async function setUnreadCount(count, hasIssue) {
    _action.setIcon({ path: NORMAL_ICONS });

    if (hasIssue) {
      _currentState = 'issue';
      _action.setBadgeText({ text: `${_countText(count)}!` });
      _action.setBadgeBackgroundColor({ color: ATTENTION });
      _action.setTitle({
        title: _t('badgeAccountIssue', 'An account needs attention. Open the extension'),
      });
      return;
    }

    _currentState = 'normal';
    if (count > 0) {
      const color = await _getBadgeColor();
      _action.setBadgeText({ text: _countText(count) });
      _action.setBadgeBackgroundColor({ color });
      _action.setTitle({ title: _t('badgeUnreadTitle', 'Proton Mail: $1 unread', count) });
    } else {
      _action.setBadgeText({ text: '' });
      _action.setTitle({ title: _t('badgeDefaultTitle', 'Mail Checker for Proton Mail') });
    }
  }

  /** Set badge to "not logged in" state. */
  function setLoggedOut() {
    _currentState = 'logged_out';
    _action.setIcon({ path: GRAY_ICONS });
    _action.setBadgeText({ text: '' });
    _action.setTitle({ title: _t('badgeLoggedOutTitle', 'Mail Checker for Proton Mail: not logged in') });
  }

  /** Set badge to error state. */
  function setError(message) {
    _currentState = 'error';
    _action.setIcon({ path: GRAY_ICONS });
    _action.setBadgeText({ text: '!' });
    _action.setBadgeBackgroundColor({ color: RED });
    _action.setTitle({ title: _t('badgeErrorTitle', 'Mail Checker for Proton Mail: $1', message || 'error') });
  }

  /** Get current badge state. */
  function getState() {
    return _currentState;
  }

  /** Set badge to DND state (gray icon, muted badge color). */
  function setDND(count) {
    _currentState = 'dnd';
    _action.setIcon({ path: GRAY_ICONS });
    if (count > 0) {
      const text = count > 999 ? `${Math.floor(count / 1000)}K+` : String(count);
      _action.setBadgeText({ text });
      _action.setBadgeBackgroundColor({ color: '#888888' });
    } else {
      _action.setBadgeText({ text: '' });
    }
    _action.setTitle({ title: _t('badgeDndTitle', 'Mail Checker for Proton Mail: Do Not Disturb') });
  }

  return {
    setUnreadCount,
    setLoggedOut,
    setError,
    setDND,
    getState,
  };
})();
