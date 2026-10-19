/**
 * CAPTCHA verification page for Proton Mail Checker.
 *
 * Opens when Proton requires human verification during login.
 * Embeds Proton's verification iframe and relays the solution
 * back to the background script to retry the login.
 */
(async function () {
  // Initialize i18n
  if (typeof ProtonI18n !== 'undefined') {
    await ProtonI18n.loadLanguage();
    ProtonI18n.applyTranslations();
  }

  // Apply color scheme from settings. It is a Pro setting, so without
  // Premium the page follows the system, like the popup (lib/pro-settings.js).
  // Not awaited: the verification below must not wait for the background.
  Promise.all([
    browser.storage.local.get('settings'),
    browser.runtime.sendMessage({ type: 'GET_PREMIUM_STATUS' }).catch(() => null),
  ]).then(([stored, premiumStatus]) => {
    const settings = ProtonProSettings.inEffect(stored.settings, !!(premiumStatus && premiumStatus.premium));
    const scheme = settings.colorScheme || 'auto';
    let resolved = scheme;
    if (resolved === 'auto') {
      resolved = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    }
    document.body.setAttribute('data-color-scheme', resolved);
  }).catch(() => { /* ignore */ });

  const iframe = document.getElementById('captcha-iframe');
  const loading = document.getElementById('captcha-loading');
  const status = document.getElementById('captcha-status');

  // Read the human verification token from the URL
  const params = new URLSearchParams(window.location.search);
  const hvToken = params.get('token');

  if (!hvToken) {
    status.textContent = typeof ProtonI18n !== 'undefined' ? ProtonI18n.t('missingVerificationToken') : 'Missing verification token. Please try signing in again.';
    status.className = 'captcha-status error';
    return;
  }

  // Load Proton's CAPTCHA iframe
  const captchaUrl = `https://verify.proton.me/captcha?token=${encodeURIComponent(hvToken)}&purpose=login`;
  iframe.src = captchaUrl;

  iframe.addEventListener('load', () => {
    loading.style.display = 'none';
  });

  // Listen for the CAPTCHA solution from Proton's iframe
  window.addEventListener('message', async (event) => {
    // Proton's CAPTCHA iframe posts: { type: 'pm_captcha', token: '<solution>' }
    if (!event.data || event.data.type !== 'pm_captcha') return;

    const solutionToken = event.data.token;
    if (!solutionToken) return;

    status.textContent = typeof ProtonI18n !== 'undefined' ? ProtonI18n.t('verificationComplete') : 'Verification complete, signing in...';
    status.className = 'captcha-status success';
    iframe.style.opacity = '0.5';
    iframe.style.pointerEvents = 'none';

    try {
      const result = await browser.runtime.sendMessage({
        type: 'CAPTCHA_SOLVED',
        captchaToken: solutionToken,
      });

      if (result && result.success) {
        status.textContent = typeof ProtonI18n !== 'undefined' ? ProtonI18n.t('loginSuccessful') : 'Login successful! You can close this tab.';
        status.className = 'captcha-status success';
        // Auto-close after a brief delay. Use the BG-mediated path
        // (CLOSE_THIS_TAB) for consistency with content-script siblings;
        // extension-page window.close() works on Chrome but the message
        // route is uniform across captcha entry points.
        setTimeout(() => browser.runtime.sendMessage({ type: 'CLOSE_THIS_TAB', reopenPopup: true }), 1500);
      } else if (result && result.error) {
        status.textContent = (typeof ProtonI18n !== 'undefined' ? ProtonI18n.t('loginFailed') : 'Login failed') + ': ' + result.error;
        status.className = 'captcha-status error';
        iframe.style.opacity = '1';
        iframe.style.pointerEvents = 'auto';
      }
    } catch (err) {
      status.textContent = 'Error: ' + err.message;
      status.className = 'captcha-status error';
    }
  });
})();
