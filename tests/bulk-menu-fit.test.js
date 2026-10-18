/**
 * @vitest-environment jsdom
 *
 * Fitting the bulk-actions menu inside the popup.
 *
 * The old placement was:
 *
 *     top = Math.min(rect.bottom + 2, bodyH - menuRect.height - 4)
 *
 * which clamps only the bottom. Once the menu grew taller than the popup that
 * expression went negative: the menu pinned itself to the bottom edge and ran
 * off the TOP, leaving its first entries permanently unreachable. Nothing
 * capped its height either, so no amount of repositioning could have helped.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const ROOT = join(__dirname, '..');
const SRC = readFileSync(join(ROOT, 'popup', 'popup.js'), 'utf-8');
const CSS = readFileSync(join(ROOT, 'popup', 'popup.css'), 'utf-8');

function lift(name) {
  const start = SRC.search(new RegExp('(async )?function ' + name + '\\('));
  if (start === -1) throw new Error('not found: ' + name);
  let i = SRC.indexOf('{', start);
  let depth = 0;
  for (; i < SRC.length; i++) {
    if (SRC[i] === '{') depth++;
    else if (SRC[i] === '}') { depth--; if (depth === 0) return SRC.slice(start, i + 1); }
  }
  throw new Error('unbalanced braces reading ' + name);
}

const fit = new Function(
  'BULK_EDGE',
  lift('_fitBulkMenu') + '\nreturn _fitBulkMenu;'
)(4);

/** A menu whose height shrinks by a quarter once compact mode is applied. */
function makeMenu(naturalHeight) {
  const el = document.createElement('div');
  el.className = 'dropdown-menu bulk-menu';
  document.body.appendChild(el);
  Object.defineProperty(el, 'offsetHeight', {
    get() {
      const compact = el.classList.contains('bulk-menu-compact');
      const h = compact ? Math.round(naturalHeight * 0.75) : naturalHeight;
      const cap = el.style.maxHeight ? parseInt(el.style.maxHeight, 10) : Infinity;
      return Math.min(h, cap);
    },
    configurable: true,
  });
  return el;
}

const top = (el) => parseInt(el.style.top, 10);

beforeEach(() => { document.body.innerHTML = ''; });

describe('when it fits', () => {
  it('hangs below the button, untouched', () => {
    const menu = makeMenu(200);
    fit(menu, { bottom: 40, top: 20 }, 600);
    expect(top(menu)).toBe(42);
    expect(menu.classList.contains('bulk-menu-compact')).toBe(false);
    expect(menu.style.maxHeight).toBe('');
  });

  it('slides up rather than overflowing the bottom', () => {
    const menu = makeMenu(200);
    fit(menu, { bottom: 500, top: 480 }, 600);
    expect(top(menu)).toBe(600 - 200 - 4);
    expect(menu.classList.contains('bulk-menu-compact')).toBe(false);
  });
});

describe('when it does not fit', () => {
  it('compacts first, before reaching for a scrollbar', () => {
    // 700 natural, 525 compact, 592 available: compacting alone is enough.
    const menu = makeMenu(700);
    fit(menu, { bottom: 40, top: 20 }, 600);
    expect(menu.classList.contains('bulk-menu-compact')).toBe(true);
    expect(menu.style.maxHeight).toBe('');
  });

  it('caps the height when even compact will not fit', () => {
    const menu = makeMenu(2000);
    fit(menu, { bottom: 40, top: 20 }, 600);
    expect(menu.classList.contains('bulk-menu-compact')).toBe(true);
    expect(menu.style.maxHeight).toBe('592px');
  });

  it('never starts above the top of the popup', () => {
    // The exact regression: bodyH - height - 4 is negative here.
    const menu = makeMenu(2000);
    fit(menu, { bottom: 560, top: 540 }, 600);
    expect(top(menu)).toBeGreaterThanOrEqual(4);
  });

  it('keeps the whole menu inside the popup, however tall', () => {
    for (const natural of [300, 700, 1200, 5000]) {
      for (const btnBottom of [10, 200, 400, 590]) {
        document.body.innerHTML = '';
        const menu = makeMenu(natural);
        fit(menu, { bottom: btnBottom, top: btnBottom - 20 }, 600);
        const t = top(menu);
        expect(t, `natural=${natural} btn=${btnBottom}`).toBeGreaterThanOrEqual(4);
        expect(t + menu.offsetHeight, `natural=${natural} btn=${btnBottom}`)
          .toBeLessThanOrEqual(600);
      }
    }
  });

  it('copes with a popup shorter than a single sensible menu', () => {
    const menu = makeMenu(800);
    fit(menu, { bottom: 30, top: 10 }, 120);
    expect(top(menu)).toBe(4);
    expect(menu.style.maxHeight).toBe('112px');
  });
});

describe('the styling that backs it', () => {
  it('the menu can actually scroll once capped', () => {
    const rule = /\.bulk-menu \{[^}]*\}/.exec(CSS)[0];
    expect(rule).toMatch(/overflow-y:\s*auto/);
  });

  it('compact mode trims spacing and icons', () => {
    expect(CSS).toMatch(/\.bulk-menu\.bulk-menu-compact \.dropdown-item \{[^}]*padding:/);
    expect(CSS).toMatch(/\.bulk-menu\.bulk-menu-compact \.dropdown-icon-wrap \{[^}]*width:/);
  });

  it('compact mode does NOT shrink the label', () => {
    // This menu contains "Delete permanently" and "Report all as phishing".
    // Shrinking the text and hit target of an irreversible action to save a
    // few pixels is the wrong trade.
    const compact = CSS.match(/\.bulk-menu\.bulk-menu-compact [^{]*\{[^}]*\}/g) || [];
    expect(compact.length).toBeGreaterThan(0);
    for (const rule of compact) expect(rule).not.toMatch(/font-size/);
  });
});

describe('measurement', () => {
  it('uses offsetHeight, not a rect measured through the open animation', () => {
    // .dropdown-menu animates in from scale(0.97), so getBoundingClientRect
    // reports the scaled height while it is opening.
    const fn = lift('_fitBulkMenu');
    expect(fn).toMatch(/offsetHeight/);
    expect(fn).not.toMatch(/getBoundingClientRect/);
  });

  it('the old bottom-only clamp is gone', () => {
    expect(SRC).not.toMatch(/Math\.min\(rect\.bottom \+ 2, bodyH - menuRect\.height - 4\)/);
  });
});
