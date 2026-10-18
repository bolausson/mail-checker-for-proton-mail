/**
 * Offscreen document for audio playback (Chrome MV3 only).
 *
 * Service workers can't use AudioContext, so on Chrome we host the
 * notification-sound synthesis here. Listens for PROTON_PLAY_SOUND
 * messages from the SW and delegates to ProtonAudioBridge._playLocally,
 * which has access to AudioContext in this regular extension page.
 */
(function () {
  const api = (typeof browser !== 'undefined' && browser.runtime)
    ? browser.runtime : chrome.runtime;

  api.onMessage.addListener((msg) => {
    if (!msg || msg.type !== ProtonAudioBridge.MSG_TYPE) return;
    if (msg.target !== ProtonAudioBridge.MSG_TARGET_OFFSCREEN) return;
    ProtonAudioBridge._playLocally(msg.soundName, msg.volume);
  });
})();
