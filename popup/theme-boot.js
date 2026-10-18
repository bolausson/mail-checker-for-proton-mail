/**
 * Early theme + window-mode boot.
 *
 * Runs synchronously as the first child of <body>, BEFORE the rest of the
 * popup is parsed or painted, so the popup never flashes the default light
 * palette while popup.js loads settings + premium status asynchronously.
 *
 * Must be an external file: the popup CSP is `default-src 'self'` (no
 * 'unsafe-inline'), so inline <script> would be blocked.
 *
 * It replays the last *effective* theme/colour-scheme/density that popup.js
 * applied (mirrored to localStorage by _persistThemeBoot()). On the very
 * first open (no mirror yet) it falls back to the OS colour scheme so a
 * dark-mode user still doesn't get a white flash.
 *
 * Uses only localStorage / matchMedia / location (no browser.* APIs), so it
 * is safe to run before the Chrome polyfill and in any load order.
 */
(function () {
  try {
    const body = document.body;

    // Popped-out standalone window (browser.windows.create with
    // ?standalone=1) must fill the OS window instead of the fixed popup
    // size. Tag it now so the very first layout is correct.
    if ((location.search || '').indexOf('standalone=1') !== -1) {
      body.classList.add('standalone');
    }

    let cached = null;
    try {
      const raw = localStorage.getItem('mcpm-theme-boot');
      if (raw) cached = JSON.parse(raw);
    } catch (e) { /* ignore parse / access errors */ }

    let scheme = cached && cached.colorScheme;
    if (!scheme || scheme === 'auto') {
      scheme = (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches)
        ? 'dark' : 'light';
    }
    body.setAttribute('data-color-scheme', scheme);
    body.setAttribute('data-theme', (cached && cached.theme) || 'classic');

    const density = cached && cached.density;
    if (density && density !== 'comfortable') {
      body.classList.add('density-' + density);
    }

    // Replay the last applied popup size synchronously, so the popup opens at the
    // configured size instead of the default while popup.js loads settings and the
    // background's first poll resolves. Skip in standalone mode (the window fills
    // the OS frame and the cached values are empty strings anyway).
    if (cached && !body.classList.contains('standalone')) {
      if (cached.width) body.style.width = cached.width;
      if (cached.height) body.style.height = cached.height;
    }
  } catch (e) {
    /* Never let a boot error block the popup from painting. */
  }
})();
