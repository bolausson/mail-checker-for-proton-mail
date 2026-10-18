/**
 * Drag-to-resize for inline images.
 *
 * The spec is a split: CORNER grips scale and keep the aspect ratio, EDGE
 * grips stretch one axis and ignore it. computeSize() is where that lives, and
 * it is pure so the geometry can be checked without a browser.
 *
 * The corner maths projects the drag onto the box diagonal rather than
 * following whichever axis moved further. Axis-following makes the image jump
 * as the pointer crosses the diagonal; projection is continuous and keeps the
 * ratio exact, which is the property these tests pin.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const ROOT = join(__dirname, '..');
const SRC = readFileSync(join(ROOT, 'lib', 'image-resize.js'), 'utf-8');
const R = new Function(SRC + '; return ProtonImageResize;')();

const ratio = (s) => s.width / s.height;

describe('the handle set', () => {
  it('has eight grips, four of them corners', () => {
    expect(R.HANDLES).toHaveLength(8);
    expect(R.HANDLES.filter(R.isCorner).map((h) => h.name).sort())
      .toEqual(['ne', 'nw', 'se', 'sw']);
  });

  it('treats the four edge grips as non-corners', () => {
    const edges = R.HANDLES.filter((h) => !R.isCorner(h)).map((h) => h.name).sort();
    expect(edges).toEqual(['e', 'n', 's', 'w']);
  });

  it('gives every edge grip exactly one live axis', () => {
    for (const h of R.HANDLES.filter((x) => !R.isCorner(x))) {
      expect(h.sx === 0 || h.sy === 0).toBe(true);
      expect(h.sx !== 0 || h.sy !== 0).toBe(true);
    }
  });
});

describe('corner grips keep the aspect ratio', () => {
  const box = { startW: 200, startH: 100 }; // ratio 2.0

  it('holds the ratio when growing', () => {
    const s = R.computeSize({ ...box, sx: 1, sy: 1, dx: 40, dy: 40 });
    expect(ratio(s)).toBeCloseTo(2.0, 5);
    expect(s.width).toBeGreaterThan(200);
  });

  it('holds the ratio when shrinking', () => {
    const s = R.computeSize({ ...box, sx: 1, sy: 1, dx: -60, dy: -60 });
    expect(ratio(s)).toBeCloseTo(2.0, 5);
    expect(s.width).toBeLessThan(200);
  });

  it('holds the ratio on a purely horizontal corner drag', () => {
    // The axis the user did NOT move must still follow, or the "corner"
    // behaves like an edge.
    const s = R.computeSize({ ...box, sx: 1, sy: 1, dx: 50, dy: 0 });
    expect(ratio(s)).toBeCloseTo(2.0, 5);
    expect(s.height).toBeGreaterThan(100);
  });

  it('holds the ratio on a purely vertical corner drag', () => {
    const s = R.computeSize({ ...box, sx: 1, sy: 1, dx: 0, dy: 50 });
    expect(ratio(s)).toBeCloseTo(2.0, 5);
    expect(s.width).toBeGreaterThan(200);
  });

  it('is continuous across the diagonal, with no jump', () => {
    // Axis-following implementations are discontinuous exactly here, where the
    // dominant axis swaps over. Projection must not be.
    const a = R.computeSize({ ...box, sx: 1, sy: 1, dx: 40, dy: 19.9 });
    const b = R.computeSize({ ...box, sx: 1, sy: 1, dx: 40, dy: 20.1 });
    expect(Math.abs(a.width - b.width)).toBeLessThanOrEqual(1);
  });

  it('grows away from the anchor for every corner', () => {
    // nw/sw pull left, ne/se push right; the n-side corners pull up. Each must
    // still GROW when dragged outward, which is what the sign vectors encode.
    const out = {
      se: { dx: 30, dy: 15 }, sw: { dx: -30, dy: 15 },
      ne: { dx: 30, dy: -15 }, nw: { dx: -30, dy: -15 },
    };
    for (const h of R.HANDLES.filter(R.isCorner)) {
      const s = R.computeSize({ ...box, sx: h.sx, sy: h.sy, ...out[h.name] });
      expect(ratio(s)).toBeCloseTo(2.0, 5);
      expect(s.width, h.name).toBeGreaterThan(200);
    }
  });

  it('preserves a stretched ratio, not the original image ratio', () => {
    // After a deliberate free-form stretch, a corner drag must keep the shape
    // the user chose rather than snapping back to one they already rejected.
    const s = R.computeSize({ startW: 300, startH: 100, sx: 1, sy: 1, dx: 30, dy: 10 });
    expect(ratio(s)).toBeCloseTo(3.0, 5);
  });
});

describe('edge grips ignore the aspect ratio', () => {
  const box = { startW: 200, startH: 100 };

  it('east and west move width only', () => {
    expect(R.computeSize({ ...box, sx: 1, sy: 0, dx: 50, dy: 999 }))
      .toEqual({ width: 250, height: 100 });
    expect(R.computeSize({ ...box, sx: -1, sy: 0, dx: -50, dy: 999 }))
      .toEqual({ width: 250, height: 100 });
  });

  it('north and south move height only', () => {
    expect(R.computeSize({ ...box, sx: 0, sy: 1, dx: 999, dy: 50 }))
      .toEqual({ width: 200, height: 150 });
    expect(R.computeSize({ ...box, sx: 0, sy: -1, dx: 999, dy: -50 }))
      .toEqual({ width: 200, height: 150 });
  });

  it('distorts on purpose, which is the point of an edge grip', () => {
    const s = R.computeSize({ ...box, sx: 1, sy: 0, dx: 200 });
    expect(ratio(s)).not.toBeCloseTo(2.0, 2);
  });
});

describe('bounds', () => {
  it('will not let a drag collapse an image to nothing', () => {
    const s = R.computeSize({ startW: 200, startH: 100, sx: 1, sy: 0, dx: -10000 });
    expect(s.width).toBe(R.MIN_SIZE);
  });

  it('keeps the ratio while clamping a corner to the floor', () => {
    // Clamping width alone would shear the image at the exact moment the user
    // is asking it not to.
    const s = R.computeSize({ startW: 200, startH: 100, sx: 1, sy: 1, dx: -10000, dy: -10000 });
    expect(ratio(s)).toBeCloseTo(2.0, 5);
    expect(Math.min(s.width, s.height)).toBeGreaterThanOrEqual(R.MIN_SIZE);
  });

  it('caps at the editor width so the image cannot force sideways scrolling', () => {
    const s = R.computeSize({ startW: 200, startH: 100, sx: 1, sy: 0, dx: 10000, maxWidth: 480 });
    expect(s.width).toBe(480);
  });

  it('keeps the ratio while clamping a corner to the max width', () => {
    const s = R.computeSize({
      startW: 200, startH: 100, sx: 1, sy: 1, dx: 10000, dy: 10000, maxWidth: 480,
    });
    expect(s.width).toBe(480);
    expect(ratio(s)).toBeCloseTo(2.0, 5);
  });

  it('treats a missing maxWidth as no limit, not as zero', () => {
    // A 0 bound would clamp every image to nothing.
    const s = R.computeSize({ startW: 200, startH: 100, sx: 1, sy: 0, dx: 1000 });
    expect(s.width).toBe(1200);
  });

  it('returns whole pixels', () => {
    const s = R.computeSize({ startW: 201, startH: 101, sx: 1, sy: 1, dx: 7, dy: 3 });
    expect(Number.isInteger(s.width)).toBe(true);
    expect(Number.isInteger(s.height)).toBe(true);
  });

  it('survives nonsense input instead of returning NaN', () => {
    const s = R.computeSize({ startW: 0, startH: 0, sx: 1, sy: 1, dx: NaN, dy: undefined });
    expect(Number.isFinite(s.width)).toBe(true);
    expect(Number.isFinite(s.height)).toBe(true);
  });
});

describe('writing the size onto the image', () => {
  it('sets attributes AND inline style, because clients disagree', () => {
    const calls = { attrs: {}, style: {} };
    const img = {
      setAttribute: (k, v) => { calls.attrs[k] = v; },
      style: calls.style,
    };
    R.applySize(img, { width: 320.4, height: 180.6 });
    expect(calls.attrs.width).toBe('320');
    expect(calls.attrs.height).toBe('181');
    expect(calls.style.width).toBe('320px');
    expect(calls.style.height).toBe('181px');
  });

  it('clears max-width, which would otherwise override the chosen size', () => {
    const style = {};
    R.applySize({ setAttribute() {}, style }, { width: 100, height: 50 });
    expect(style.maxWidth).toBe('none');
  });
});

describe('the overlay never enters the editable subtree', () => {
  it('is built on document.body, not inside the editor', () => {
    // Both editors are serialised straight out of innerHTML for sending and
    // for the encrypted draft, so a handle parked inside would be mailed to
    // the recipient.
    expect(SRC).toContain('document.body.appendChild(overlay)');
    expect(SRC).not.toContain('editor.appendChild(overlay)');
  });

  it('turns off the browser own resizing so there is only one set of grips', () => {
    // Gecko enables object resizing in every contenteditable, and its corner
    // grips stretch freely, which is exactly what this replaces.
    expect(SRC).toContain('enableObjectResizing');
  });

  it('fires input after a drag so the draft autosave notices', () => {
    // An attribute written by script does not fire input on its own, so the
    // resize would never reach the saved draft.
    expect(SRC).toContain("dispatchEvent(new Event('input'");
  });
});
