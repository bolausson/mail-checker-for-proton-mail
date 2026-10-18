/**
 * Shared verification-code pattern store.
 *
 * Loaded by both popup.js (for detection) and options.js (for the
 * configurable UI) via their HTML <script> tags. Exposes the
 * `ProtonCodePatterns` global, matching the IIFE-module pattern used by every
 * other module (this previously assigned to window.ProtonCodePatterns late).
 */
/* exported ProtonCodePatterns */
const ProtonCodePatterns = (() => {
  'use strict';

  // Shipped defaults. The `id` is stable; user-stored overrides are keyed
  // by it. The `name` is fixed for defaults (not user-editable). Order
  // here is the order patterns are tried, with the most specific first.
  const SHIPPED_DEFAULTS = Object.freeze([
    {
      id: 'default-verification',
      name: 'Verification code',
      regex: '(?:verification|verify|verified)[^\\d]{0,40}(\\d{4,10})',
      flags: 'i',
      enabled: true,
    },
    {
      id: 'default-otp',
      name: 'OTP / one-time code',
      regex: '(?:OTP|one[-\\s]?time(?:[\\s-]?(?:code|password|pin))?)[^\\d]{0,40}(\\d{4,10})',
      flags: 'i',
      enabled: true,
    },
    {
      id: 'default-auth',
      name: 'Authentication / login code',
      regex: '(?:auth(?:entication)?|sign[-\\s]?in|log[-\\s]?in|security)[^\\d]{0,40}(\\d{4,10})',
      flags: 'i',
      enabled: true,
    },
    {
      id: 'default-passcode',
      name: 'Passcode / PIN / 2FA',
      regex: '(?:passcode|\\bpin\\b|2fa|two[-\\s]?factor)[^\\d]{0,40}(\\d{4,10})',
      flags: 'i',
      enabled: true,
    },
    {
      id: 'default-code-prefix',
      name: 'Generic "code: 123456"',
      regex: '\\bcode[\\s:#=-]+(\\d{4,10})\\b',
      flags: 'i',
      enabled: true,
    },
    {
      id: 'default-confirm',
      name: 'Confirmation / activation code',
      regex: '(?:confirm(?:ation)?|activation|registration|access)[^\\d]{0,40}(\\d{4,10})',
      flags: 'i',
      enabled: true,
    },
    {
      id: 'default-bare-6digit',
      name: 'Bare 6-digit number (off by default, noisy)',
      regex: '\\b(\\d{6})\\b',
      flags: '',
      enabled: false,
    },
  ]);

  function getShippedDefaults() {
    return SHIPPED_DEFAULTS.map((p) => ({ ...p }));
  }

  function isDefaultId(id) {
    return typeof id === 'string' && id.indexOf('default-') === 0;
  }

  /** Merge stored patterns with shipped defaults.
   *  Returns: defaults (in original order, with overrides applied) followed
   *  by user-added custom patterns in their stored order. Each item is
   *  decorated with `kind` ('default' | 'custom') and, for defaults,
   *  `isModified` (true if the regex differs from the shipped value). */
  function mergeWithDefaults(stored) {
    const result = [];
    const storedById = new Map();
    if (Array.isArray(stored)) {
      for (const p of stored) {
        if (p && p.id) storedById.set(p.id, p);
      }
    }

    for (const def of SHIPPED_DEFAULTS) {
      const override = storedById.get(def.id);
      if (override) {
        const regex = override.regex !== undefined ? override.regex : def.regex;
        const flags = override.flags !== undefined ? override.flags : def.flags;
        result.push({
          id: def.id,
          name: def.name,
          regex: regex,
          flags: flags,
          enabled: override.enabled !== false,
          kind: 'default',
          isModified: regex !== def.regex || flags !== def.flags,
        });
      } else {
        result.push({ ...def, kind: 'default', isModified: false });
      }
    }

    if (Array.isArray(stored)) {
      for (const p of stored) {
        if (!p || !p.id || isDefaultId(p.id)) continue;
        result.push({
          id: p.id,
          name: p.name || '',
          regex: p.regex || '',
          flags: p.flags || '',
          enabled: p.enabled !== false,
          kind: 'custom',
          isModified: false,
        });
      }
    }

    return result;
  }

  /** Run merged patterns against `text`, returning the first capturing
   *  group of the first matching enabled pattern, or null. */
  function detectCode(text, mergedPatterns) {
    if (!text || !Array.isArray(mergedPatterns)) return null;
    for (const p of mergedPatterns) {
      if (!p.enabled || !p.regex) continue;
      let re;
      try {
        re = new RegExp(p.regex, p.flags || '');
      } catch (e) {
        continue; // invalid regex, skip silently
      }
      const m = text.match(re);
      if (m && m[1]) return m[1];
    }
    return null;
  }

  /** Validate a regex string. Returns null if valid, an error message
   *  otherwise. Also enforces presence of a capturing group. */
  function validateRegex(pattern, flags) {
    if (!pattern || !pattern.trim()) return 'Regex is empty';
    try {
      new RegExp(pattern, flags || ''); // validity probe: throws on bad pattern
    } catch (e) {
      return e.message || 'Invalid regex';
    }
    if (!/\([^?]/.test(pattern)) {
      return 'Regex must contain a capturing group, e.g. (\\d{6})';
    }
    return null;
  }

  return {
    SHIPPED_DEFAULTS,
    getShippedDefaults,
    mergeWithDefaults,
    detectCode,
    validateRegex,
    isDefaultId,
  };
})();
