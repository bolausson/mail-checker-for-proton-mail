/**
 * FIDO2/WebAuthn content script for Proton Mail Checker.
 *
 * Injected into account.proton.me at document_start (ISOLATED world).
 * Only activates when the URL hash starts with #ext-fido2.
 *
 * How it works:
 *   1. Render a "touch your key" UI:
 *      - Firefox: block page scripts via beforescriptexecute, then
 *        replace head + body wholesale.
 *      - Chrome:  let the page load normally; overlay a fullscreen card
 *        with z-index over the top. Replacing the DOM on Chrome makes
 *        chrome.scripting.executeScript fail with "Frame with ID 0 was
 *        removed" (Proton's React bundle reacts to its mount point
 *        disappearing), so we leave it intact.
 *   2. Fetch the FIDO2 challenge from the extension background.
 *   3. Call navigator.credentials.get() in the page's main world so
 *      the request uses the page's origin (https://account.proton.me)
 *      and rpId: proton.me matches.
 *      - Firefox: via window.wrappedJSObject + cloneInto.
 *      - Chrome:  via the background calling chrome.scripting.execute
 *        Script({ target, world: 'MAIN', func, args }): privileged
 *        extension API that bypasses page CSP entirely.
 *   4. Send the credential back to the background to complete login.
 */

(function () {
  'use strict';

  if (!location.hash.startsWith('#ext-fido2')) return;

  // Firefox exposes `cloneInto` and `window.wrappedJSObject` for
  // content-script ↔ page-world interop. Chrome has neither.
  const _isFirefox = typeof cloneInto !== 'undefined' &&
    typeof window.wrappedJSObject !== 'undefined';

  // --- Phase 1: Block page scripts and take over the DOM ---
  //
  // Firefox: we own the page. beforescriptexecute prevents Proton's React
  // bundle from ever running, then we replace head/body wholesale.
  //
  // Chrome: we do NOT take over the DOM. window.stop() + replaceChildren
  // leaves the frame in a state where chrome.scripting.executeScript fails
  // with "Frame with ID 0 was removed" (Proton's loaded bundle reacts to
  // its mount point disappearing). Instead we let the page render and
  // overlay our UI on top via a fullscreen z-index div.

  if (_isFirefox) {
    document.addEventListener('beforescriptexecute', e => e.preventDefault(), true);
  }

  const observer = new MutationObserver(() => {
    if (!document.body) return;
    observer.disconnect();
    if (_isFirefox) {
      window.stop();
      renderUIFirefox();
    } else {
      renderUIChrome();
    }
    startFIDO2();
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });
  if (document.body) {
    observer.disconnect();
    if (_isFirefox) {
      window.stop();
      renderUIFirefox();
    } else {
      renderUIChrome();
    }
    startFIDO2();
  }

  // --- Phase 2: UI ---

  // Build the styled card (icon, spinner, status text, retry/close buttons).
  // Used by both Firefox (full DOM takeover) and Chrome (overlay) renderers.
  function _buildCard() {
    const card = document.createElement('div');
    card.className = 'card';
    const els = [
      ['div', 'icon',    { id: 'icon',    text: '\u{1F511}' }],
      ['div', 'title',   { text: 'Security Key Verification' }],
      ['div', 'spinner', { id: 'spinner' }],
      ['div', 'status',  { id: 'status', text: 'Touch your security key to sign in\u2026' }],
    ];
    for (const [tag, cls, opt] of els) {
      const el = document.createElement(tag);
      el.className = cls;
      if (opt.id) el.id = opt.id;
      if (opt.text) el.textContent = opt.text;
      card.appendChild(el);
    }
    const actions = document.createElement('div');
    for (const [id, label, handler] of [
      ['btn-retry', 'Try again', () => startFIDO2()],
      ['btn-close', 'Close',     () => closeThisTab()],
    ]) {
      const btn = document.createElement('button');
      btn.id = id; btn.className = 'btn hidden'; btn.textContent = label;
      btn.addEventListener('click', handler);
      actions.appendChild(btn);
    }
    card.appendChild(actions);
    return card;
  }

  const _CARD_CSS =
    '#__pmc-fido2-overlay * { margin: 0; padding: 0; box-sizing: border-box; }' +
    '#__pmc-fido2-overlay { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;' +
    '  background: #1a1a2e; color: #e0e0e0;' +
    '  display: flex; align-items: center; justify-content: center; min-height: 100vh; }' +
    '#__pmc-fido2-overlay .card { background: #252540; border-radius: 16px; padding: 48px;' +
    '  text-align: center; max-width: 420px; width: 100%;' +
    '  box-shadow: 0 8px 32px rgba(0,0,0,.4); }' +
    '#__pmc-fido2-overlay .icon { font-size: 64px; margin-bottom: 24px; }' +
    '#__pmc-fido2-overlay .title { font-size: 22px; font-weight: 600; margin-bottom: 12px; color: #fff; }' +
    '#__pmc-fido2-overlay .status { font-size: 15px; color: #aaa; margin-bottom: 24px; line-height: 1.5; }' +
    '#__pmc-fido2-overlay .status.error { color: #ff6b6b; } #__pmc-fido2-overlay .status.success { color: #51cf66; }' +
    '#__pmc-fido2-overlay .spinner { width: 48px; height: 48px; border: 4px solid #333;' +
    '  border-top-color: #7c5cfc; border-radius: 50%;' +
    '  animation: __pmc-spin 1s linear infinite; margin: 0 auto 24px; }' +
    '@keyframes __pmc-spin { to { transform: rotate(360deg); } }' +
    '#__pmc-fido2-overlay .btn { background: #444; color: #fff; border: none; border-radius: 8px;' +
    '  padding: 12px 32px; font-size: 15px; cursor: pointer; margin: 8px; }' +
    '#__pmc-fido2-overlay .btn:hover { background: #555; }' +
    '#__pmc-fido2-overlay .hidden { display: none !important; }';

  // Firefox: full DOM takeover (page scripts already blocked via
  // beforescriptexecute, so this is safe).
  function renderUIFirefox() {
    document.title = 'Security Key Verification';
    const css = document.createElement('style');
    css.textContent =
      '* { margin: 0; padding: 0; box-sizing: border-box; }' +
      'body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;' +
      '  background: #1a1a2e; color: #e0e0e0;' +
      '  display: flex; align-items: center; justify-content: center; min-height: 100vh; }' +
      '.card { background: #252540; border-radius: 16px; padding: 48px;' +
      '  text-align: center; max-width: 420px; width: 100%;' +
      '  box-shadow: 0 8px 32px rgba(0,0,0,.4); }' +
      '.icon { font-size: 64px; margin-bottom: 24px; }' +
      '.title { font-size: 22px; font-weight: 600; margin-bottom: 12px; color: #fff; }' +
      '.status { font-size: 15px; color: #aaa; margin-bottom: 24px; line-height: 1.5; }' +
      '.status.error { color: #ff6b6b; } .status.success { color: #51cf66; }' +
      '.spinner { width: 48px; height: 48px; border: 4px solid #333;' +
      '  border-top-color: #7c5cfc; border-radius: 50%;' +
      '  animation: spin 1s linear infinite; margin: 0 auto 24px; }' +
      '@keyframes spin { to { transform: rotate(360deg); } }' +
      '.btn { background: #444; color: #fff; border: none; border-radius: 8px;' +
      '  padding: 12px 32px; font-size: 15px; cursor: pointer; margin: 8px; }' +
      '.btn:hover { background: #555; }' +
      '.hidden { display: none !important; }';
    document.head.replaceChildren(css);
    document.body.replaceChildren(_buildCard());
  }

  // Chrome: append a fullscreen overlay div WITHOUT touching the rest of
  // the document. Lets Proton's React bundle proceed undisturbed so
  // chrome.scripting.executeScript can reach the main frame later.
  function renderUIChrome() {
    document.title = 'Security Key Verification';
    const style = document.createElement('style');
    style.id = '__pmc-fido2-style';
    style.textContent = _CARD_CSS;
    document.head.appendChild(style);

    const overlay = document.createElement('div');
    overlay.id = '__pmc-fido2-overlay';
    overlay.style.cssText = 'position: fixed; inset: 0; z-index: 2147483647;';
    overlay.appendChild(_buildCard());
    document.body.appendChild(overlay);
  }

  function setStatus(text, type) {
    const el = document.getElementById('status');
    if (el) { el.textContent = text; el.className = 'status' + (type ? ' ' + type : ''); }
  }

  function show(id, visible) {
    const el = document.getElementById(id);
    if (el) el.classList.toggle('hidden', !visible);
  }

  function showError(msg) {
    show('spinner', false);
    setStatus(msg, 'error');
    show('btn-retry', true);
    show('btn-close', true);
  }

  // --- Phase 3: WebAuthn ceremony ---

  async function startFIDO2() {
    setStatus('Touch your security key to sign in\u2026');
    show('spinner', true);
    show('btn-retry', false);
    show('btn-close', false);

    // 1. Fetch FIDO2 challenge from background
    let fido2Options;
    try {
      fido2Options = await browser.runtime.sendMessage({ type: 'GET_FIDO2_OPTIONS' });
    } catch (_) {
      return showError('Could not connect to extension. Try logging in again.');
    }
    if (!fido2Options || !fido2Options.AuthenticationOptions) {
      return showError('No security key challenge available. Try logging in again.');
    }

    // 2. Build WebAuthn request options
    //    Proton sends challenge and credential IDs as number[] (byte arrays).
    //    WebAuthn API needs ArrayBuffer / Uint8Array.
    const pk = fido2Options.AuthenticationOptions.publicKey;
    const opts = {
      publicKey: {
        challenge: new Uint8Array(pk.challenge).buffer,
        rpId: pk.rpId,
        timeout: pk.timeout || 60000,
        userVerification: pk.userVerification || 'discouraged',
        allowCredentials: (pk.allowCredentials || []).map(c => ({
          type: c.type,
          id: new Uint8Array(c.id),
          transports: c.transports,
        })),
      },
    };

    // 3. Call the page's navigator.credentials.get() in the page's main
    //    world so the call carries the page's origin and rpId matches.
    let credential;
    try {
      credential = _isFirefox
        ? await callWebAuthnFirefox(opts)
        : await callWebAuthnChrome(opts);
    } catch (err) {
      if (err.name === 'NotAllowedError') return showError('Verification was cancelled or timed out.');
      if (err.name === 'InvalidStateError') return showError('This key is not registered for this account.');
      return showError(err.name + ': ' + (err.message || 'Unknown error'));
    }
    if (!credential || !credential.rawId) return showError('No credential received.');

    // 4. Convert response to Proton API format:
    //    ClientData, AuthenticatorData, Signature → base64 strings
    //    CredentialID → number[] (byte array)
    const resp = credential.response;
    const payload = {
      AuthenticationOptions: fido2Options.AuthenticationOptions,
      ClientData: bufToBase64(resp.clientDataJSON),
      AuthenticatorData: bufToBase64(resp.authenticatorData),
      Signature: bufToBase64(resp.signature),
      CredentialID: Array.from(new Uint8Array(credential.rawId)),
    };

    // 5. Send credential to background for API submission
    setStatus('Verifying\u2026');
    let result;
    try {
      result = await browser.runtime.sendMessage({
        type: 'FIDO2_COMPLETE', credential: payload,
      });
      if (result && result.error) return showError('Authentication failed: ' + result.error);
    } catch (e) {
      return showError('Failed: ' + e.message);
    }

    // 6. Success, but two-password accounts still need a mailbox password
    show('spinner', false);
    document.getElementById('icon').textContent = '\u2705';
    if (result && result.needsMailboxPassword) {
      setStatus('Security key verified. Open the extension popup to enter your mailbox password.', 'success');
      setTimeout(closeThisTab, 2500);
    } else {
      setStatus('Signed in successfully! This tab will close\u2026', 'success');
      setTimeout(closeThisTab, 1500);
    }
  }

  // Ask the background to close the current tab. Content scripts on
  // Chrome can't reliably call window.close() on tabs opened by the
  // extension; the background uses tabs.remove(sender.tab.id) instead.
  // Also requests popup reopen so the user lands back in the extension
  // (popup is normally closed when the FIDO2 tab takes focus).
  function closeThisTab() {
    try { browser.runtime.sendMessage({ type: 'CLOSE_THIS_TAB', reopenPopup: true }); } catch (_) {}
  }

  // Intentional local copy of base64 encoding: this is a content script in an
  // isolated world and cannot see the ProtonBinary global (extension scope).
  // WebAuthn buffers here are tiny (credential ids / signatures), so chunking
  // is unnecessary.
  function bufToBase64(buf) {
    const bytes = new Uint8Array(buf);
    let bin = '';
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin);
  }

  function base64ToBuf(b64) {
    const bin = atob(b64);
    const u = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
    return u.buffer;
  }

  // Firefox: hop into the page's JS scope via wrappedJSObject + cloneInto.
  async function callWebAuthnFirefox(opts) {
    const pageOpts = cloneInto(opts, window.wrappedJSObject, { cloneFunctions: false });
    return window.wrappedJSObject.navigator.credentials.get(pageOpts);
  }

  // Chrome: route the WebAuthn ceremony through the background, which
  // calls chrome.scripting.executeScript({ world: 'MAIN' }) on this tab.
  // That runs the call in the page's main world (so rpId matches) and
  // bypasses Proton's CSP entirely: chrome.scripting is privileged.
  async function callWebAuthnChrome(opts) {
    const pk = opts.publicKey;
    const serialised = {
      publicKey: {
        challenge: Array.from(new Uint8Array(pk.challenge)),
        rpId: pk.rpId,
        timeout: pk.timeout,
        userVerification: pk.userVerification,
        allowCredentials: (pk.allowCredentials || []).map(c => ({
          type: c.type,
          id: Array.from(c.id instanceof Uint8Array ? c.id : new Uint8Array(c.id)),
          transports: c.transports,
        })),
      },
    };

    const result = await browser.runtime.sendMessage({
      type: 'FIDO2_PAGE_WEBAUTHN',
      options: serialised,
    });
    if (!result || result.error) {
      const err = new Error((result && result.error) || 'unknown');
      err.name = (result && result.errorName) || 'Error';
      throw err;
    }
    return {
      rawId: base64ToBuf(result.rawIdB64),
      response: {
        clientDataJSON: base64ToBuf(result.clientDataJSONB64),
        authenticatorData: base64ToBuf(result.authenticatorDataB64),
        signature: base64ToBuf(result.signatureB64),
      },
    };
  }
})();
