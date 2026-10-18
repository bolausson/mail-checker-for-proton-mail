/**
 * Cross-browser scripting helper.
 *
 * Both Firefox MV3 (102+) and Chrome MV3 expose browser.scripting
 * .executeScript({ target, func }), which accepts a function reference
 * to run in the page's global scope.
 *
 * IMPORTANT: the function must not close over any variables. It's
 * invoked in the page's global scope. Pass arguments via the function
 * body itself, not closures.
 */

const ProtonScripting = (() => {
  /**
   * Run a self-contained function in a tab and resolve to its return value.
   * Returns undefined on failure or when the script returned nothing.
   */
  async function executeInTab(tabId, fn) {
    const results = await browser.scripting.executeScript({
      target: { tabId },
      func: fn,
    });
    return results && results[0] && results[0].result;
  }

  return { executeInTab };
})();
