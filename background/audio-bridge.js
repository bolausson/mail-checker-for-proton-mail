/**
 * Audio dispatch bridge.
 *
 * AudioContext is available on Firefox's MV3 event page and in regular
 * extension pages (popup, options, offscreen) on Chrome, but NOT in a
 * Chrome MV3 service worker. This module routes playSound() calls to the
 * right place:
 *
 *   - Firefox MV3 event page:      synthesise locally.
 *   - Chrome MV3 service worker:    create an offscreen document and ask it
 *                                    to play (creates the doc on first call,
 *                                    reused thereafter until idle-closed).
 *   - Inside the offscreen page itself (or popup/options): synthesise locally.
 */

const ProtonAudioBridge = (() => {
  const OFFSCREEN_PATH = 'offscreen/offscreen.html';
  const MSG_TYPE = 'PROTON_PLAY_SOUND';
  const MSG_TARGET_OFFSCREEN = 'offscreen';

  // We're in a SW context iff there's no `window` global (SW has `self` only).
  // Firefox's MV3 event page exposes `window`. Offscreen/popup/options
  // also expose `window`.
  const _isServiceWorker = typeof window === 'undefined';

  let _offscreenCreating = null;

  async function _ensureOffscreen() {
    const offscreen = (typeof chrome !== 'undefined' && chrome.offscreen)
      || (typeof browser !== 'undefined' && browser.offscreen);
    if (!offscreen) throw new Error('offscreen API unavailable');

    if (await offscreen.hasDocument()) return;
    if (_offscreenCreating) return _offscreenCreating;

    _offscreenCreating = offscreen.createDocument({
      url: OFFSCREEN_PATH,
      reasons: ['AUDIO_PLAYBACK'],
      justification: 'Play notification sound when new mail arrives',
    }).finally(() => { _offscreenCreating = null; });
    return _offscreenCreating;
  }

  /**
   * Synthesise a short tone using Web Audio. Only callable in contexts that
   * have AudioContext (Firefox event page, popup, options, offscreen page).
   */
  function _playLocally(soundName, volume) {
    try {
      const Ctx = (typeof AudioContext !== 'undefined') ? AudioContext
        : (typeof webkitAudioContext !== 'undefined') ? webkitAudioContext
        : null;
      if (!Ctx) return;

      const ctx = new Ctx();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);

      const vol = Math.max(0.001, (volume || 50) / 100);

      switch (soundName) {
        case 'chime':
          osc.type = 'sine';
          osc.frequency.setValueAtTime(880, ctx.currentTime);
          osc.frequency.setValueAtTime(1100, ctx.currentTime + 0.1);
          gain.gain.setValueAtTime(vol, ctx.currentTime);
          gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.4);
          osc.start(ctx.currentTime);
          osc.stop(ctx.currentTime + 0.4);
          break;
        case 'bell':
          osc.type = 'triangle';
          osc.frequency.setValueAtTime(600, ctx.currentTime);
          gain.gain.setValueAtTime(vol, ctx.currentTime);
          gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.8);
          osc.start(ctx.currentTime);
          osc.stop(ctx.currentTime + 0.8);
          break;
        case 'ding':
          osc.type = 'sine';
          osc.frequency.setValueAtTime(1200, ctx.currentTime);
          gain.gain.setValueAtTime(vol * 0.8, ctx.currentTime);
          gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.3);
          osc.start(ctx.currentTime);
          osc.stop(ctx.currentTime + 0.3);
          break;
      }
    } catch (e) {
      console.warn('[ProtonAudioBridge] Could not play sound:', e.message);
    }
  }

  /**
   * Public entry: play a notification sound.
   * In a Chrome MV3 SW this dispatches to the offscreen document.
   * Elsewhere it plays locally.
   */
  async function playSound(soundName, volume) {
    if (!_isServiceWorker) {
      _playLocally(soundName, volume);
      return;
    }
    try {
      await _ensureOffscreen();
      const api = (typeof browser !== 'undefined' && browser.runtime)
        ? browser.runtime : chrome.runtime;
      api.sendMessage({
        type: MSG_TYPE,
        target: MSG_TARGET_OFFSCREEN,
        soundName,
        volume,
      });
    } catch (e) {
      console.warn('[ProtonAudioBridge] Offscreen audio failed:', e.message);
    }
  }

  return {
    playSound,
    _playLocally,           // exposed for use from offscreen.js
    MSG_TYPE,
    MSG_TARGET_OFFSCREEN,
  };
})();
