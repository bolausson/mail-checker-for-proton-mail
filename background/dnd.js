/**
 * Do Not Disturb (DND) module for Proton Mail Checker.
 *
 * Manages DND state: timed or indefinite suppression of notifications.
 * When active, the toolbar icon switches to gray.
 */

const ProtonDND = (() => {
  const ALARM_NAME = 'proton-dnd-expire';

  // _dndUntil:  0 = off,  -1 = indefinite,  >0 = epoch ms when DND expires
  let _dndUntil = 0;

  /** Load persisted DND state; clear if already expired. */
  async function init() {
    const stored = await browser.storage.local.get('dndUntil');
    _dndUntil = stored.dndUntil || 0;

    if (_dndUntil > 0 && _dndUntil <= Date.now()) {
      _dndUntil = 0;
      await browser.storage.local.set({ dndUntil: 0 });
    }

    if (_dndUntil > 0) {
      browser.alarms.create(ALARM_NAME, { when: _dndUntil });
    }

    // The stored state, not isActive(): Premium is not loaded yet at this point.
    debugLog('[ProtonDND] Initialized, until:', _dndUntil);
  }

  /**
   * Whether DND is currently active. It is Pro, so without Premium it is off,
   * like every Pro setting: a DND set during the trial ("until I turn it
   * off" never expires) would otherwise silence every notification for good,
   * and a free user cannot turn it off (DND_DISABLE is Pro). It stays stored
   * and applies again with Premium; a timed one still expires on its alarm.
   */
  function isActive() {
    if (typeof ProtonPremium !== 'undefined' && !ProtonPremium.isPremium()) return false;
    if (_dndUntil === -1) return true;
    if (_dndUntil > 0 && _dndUntil > Date.now()) return true;
    return false;
  }

  /**
   * Enable DND.
   * @param {number} minutes - Duration in minutes, or -1 for indefinite.
   */
  async function enable(minutes) {
    if (minutes === -1) {
      _dndUntil = -1;
    } else {
      _dndUntil = Date.now() + minutes * 60 * 1000;
    }
    await browser.storage.local.set({ dndUntil: _dndUntil });

    browser.alarms.clear(ALARM_NAME);
    if (_dndUntil > 0) {
      browser.alarms.create(ALARM_NAME, { when: _dndUntil });
    }

    debugLog('[ProtonDND] Enabled, until:', _dndUntil === -1 ? 'indefinite' : new Date(_dndUntil));
  }

  /** Disable DND. */
  async function disable() {
    _dndUntil = 0;
    await browser.storage.local.set({ dndUntil: 0 });
    browser.alarms.clear(ALARM_NAME);
    debugLog('[ProtonDND] Disabled');
  }

  /** Handle alarm expiry: auto-disable DND. */
  function handleAlarm(alarm) {
    if (alarm.name === ALARM_NAME) {
      _dndUntil = 0;
      browser.storage.local.set({ dndUntil: 0 });
      debugLog('[ProtonDND] Expired, auto-disabled');
    }
  }

  /** Get DND status for the popup. */
  function getStatus() {
    return {
      active: isActive(),
      until: _dndUntil,
    };
  }

  return { init, isActive, enable, disable, handleAlarm, getStatus };
})();
