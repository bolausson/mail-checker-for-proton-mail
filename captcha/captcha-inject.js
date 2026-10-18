/**
 * Content script injected into account.proton.me at document_start.
 *
 * If the URL hash contains #ext-captcha=TOKEN, this script:
 * 1. Stops the original page from loading (React app)
 * 2. Replaces the page with a minimal CAPTCHA container
 * 3. Iframes verify.proton.me/?methods=captcha&token=TOKEN (parent is account.proton.me)
 * 4. Captures the CAPTCHA solution and sends it to the background script
 */
(function () {
  const match = location.hash.match(/#ext-captcha=([^&]+)(?:&methods=(.+))?$/);
  if (!match) return; // Not a captcha request, let the page load normally

  const token = decodeURIComponent(match[1]);
  const methods = match[2] ? decodeURIComponent(match[2]) : 'captcha';

  // Keep the extension's background awake while the puzzle is open. The
  // pending sign-in lives only in its memory, and the browser stops an idle
  // background after ~30 s: a slower solve then found nothing to finish, and
  // the frame lost the rules that let it load. A message every 20 s resets
  // that idle timer in Chrome and Firefox alike, the first one at once (the
  // idle clock has been running since the sign-in was sent). Stops once
  // solved, once the background has no sign-in pending, and after 10 minutes
  // at the latest; restarted when a solved attempt fails and the puzzle is
  // offered again.
  //
  // Known limit: Chrome slows timers in a tab hidden for 5+ minutes to about
  // one a minute, so a CAPTCHA tab left in the background that long can still
  // lose the sign-in. Nothing faster survives that alignment.
  const KEEPALIVE_MS = 20 * 1000;
  const KEEPALIVE_MAX_MS = 10 * 60 * 1000;
  let keepAlive = null;
  let keepAliveStarted = 0;
  const stopKeepAlive = () => { if (keepAlive) { clearInterval(keepAlive); keepAlive = null; } };
  const ping = async () => {
    if (Date.now() - keepAliveStarted > KEEPALIVE_MAX_MS) { stopKeepAlive(); return; }
    try {
      const reply = await browser.runtime.sendMessage({ type: 'CAPTCHA_KEEPALIVE' });
      if (!reply || !reply.pending) stopKeepAlive();
    } catch (_) { /* extension reloading: try again next tick */ }
  };
  const startKeepAlive = () => {
    stopKeepAlive();
    keepAliveStarted = Date.now();
    keepAlive = setInterval(ping, KEEPALIVE_MS);
    ping();
  };
  startKeepAlive();

  // Wait for <body> to appear, then take over the page
  const observer = new MutationObserver(() => {
    if (!document.body) return;
    observer.disconnect();

    // Stop loading the original page's resources
    window.stop();

    // Replace page content
    document.title = 'Human Verification: Proton Mail Checker';

    const style = document.createElement('style');
    style.textContent = `
      * { margin: 0; padding: 0; box-sizing: border-box; }
      body { display: flex; justify-content: center; align-items: flex-start;
             min-height: 100vh; padding: 40px 20px; background: #1B1340; color: #fff;
             font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; }
      .container { max-width: 560px; width: 100%; display: flex; flex-direction: column;
                   align-items: center; gap: 12px; text-align: center; }
      h1 { font-size: 18px; font-weight: 600; }
      .desc { font-size: 14px; color: #B4B0CC; }
      .frame-wrap { width: 100%; border-radius: 8px; overflow: hidden; background: #fff; }
      iframe { width: 100%; height: 720px; border: none; display: block; }
      #status { font-size: 13px; min-height: 20px; }
      .success { color: #28A745; }
      .error { color: #DC3545; }
    `;
    document.head.replaceChildren(style);

    const container = document.createElement('div');
    container.className = 'container';
    const h1 = document.createElement('h1');
    h1.textContent = 'Human Verification';
    const desc = document.createElement('p');
    desc.className = 'desc';
    desc.textContent = 'Complete the CAPTCHA below to sign in.';
    const frameWrap = document.createElement('div');
    frameWrap.className = 'frame-wrap';
    const iframe = document.createElement('iframe');
    iframe.id = 'captcha-iframe';
    iframe.src = 'https://verify.proton.me/?methods=' + encodeURIComponent(methods) + '&token=' + encodeURIComponent(token);
    frameWrap.appendChild(iframe);
    const statusP = document.createElement('p');
    statusP.id = 'status';
    container.appendChild(h1);
    container.appendChild(desc);
    container.appendChild(frameWrap);
    container.appendChild(statusP);
    document.body.replaceChildren(container);

    // Listen for the CAPTCHA solution from the verify.proton.me iframe.
    //
    // Proton's verify app broadcasts via JSON.stringify() + postMessage on
    // window.parent. The current message format is:
    //   { type: 'HUMAN_VERIFICATION_SUCCESS', payload: { token, type: 'captcha' } }
    // sent as a STRING. We also accept the older { type: 'pm_captcha', token }
    // shape that earlier Proton verify versions used (hCaptcha-era).
    window.addEventListener('message', async (event) => {
      if (event.origin !== 'https://verify.proton.me') return;

      let data = event.data;
      if (typeof data === 'string') {
        try { data = JSON.parse(data); } catch (_) { return; }
      }
      if (!data) return;

      let solutionToken = null;
      if (data.type === 'HUMAN_VERIFICATION_SUCCESS') {
        solutionToken = data.payload && data.payload.token;
      } else if (data.type === 'pm_captcha') {
        solutionToken = data.token; // legacy
      }
      if (!solutionToken) return;
      stopKeepAlive();

      const status = document.getElementById('status');
      status.textContent = 'Verification complete, signing in...';
      status.className = 'success';

      const iframe = document.getElementById('captcha-iframe');
      if (iframe) {
        iframe.style.opacity = '0.5';
        iframe.style.pointerEvents = 'none';
      }

      try {
        const result = await browser.runtime.sendMessage({
          type: 'CAPTCHA_SOLVED',
          captchaToken: solutionToken,
        });

        // The CAPTCHA tab's only job is to clear human verification; any
        // further auth step (2FA, mailbox password) happens back in the
        // popup. Close + reopen the popup so the user continues in-place
        // and isn't left staring at a dead CAPTCHA page.
        const closeAndReopen = () => {
          setTimeout(
            () => browser.runtime.sendMessage({ type: 'CLOSE_THIS_TAB', reopenPopup: true }),
            1200
          );
        };

        if (result && result.success) {
          status.textContent = 'Login successful! Returning to extension...';
          status.className = 'success';
          closeAndReopen();
        } else if (result && (result.needs2FA || result.needsMailboxPassword)) {
          status.textContent = 'Continue in the extension popup...';
          status.className = 'success';
          closeAndReopen();
        } else if (result && result.error) {
          status.textContent = 'Login failed: ' + result.error;
          status.className = 'error';
          if (iframe) {
            iframe.style.opacity = '1';
            iframe.style.pointerEvents = 'auto';
          }
          // Offered again: keep the background awake for the next attempt.
          // If nothing is pending any more, the first ping ends it.
          startKeepAlive();
        }
      } catch (err) {
        status.textContent = 'Error: ' + err.message;
        status.className = 'error';
      }
    });
  });

  observer.observe(document.documentElement, { childList: true, subtree: true });

  // In case body already exists (shouldn't at document_start, but just in case)
  if (document.body) {
    observer.disconnect();
    // Re-trigger by dispatching
    const fakeEvent = new Event('DOMContentLoaded');
    document.dispatchEvent(fakeEvent);
  }
})();
