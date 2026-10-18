/**
 * Inline color picker widget for Proton Mail Checker popup.
 *
 * Provides HSV-based color selection with preset swatches, a hue bar,
 * a saturation/brightness area, and a hex input. Used for account
 * label colors and editor text/highlight colors.
 *
 * Exports: PopupColorPicker.hexToHsv, hsvToHex, luminance, create
 */

const PopupColorPicker = (() => {
  function hexToHsv(hex) {
    const r = parseInt(hex.slice(1, 3), 16) / 255;
    const g = parseInt(hex.slice(3, 5), 16) / 255;
    const b = parseInt(hex.slice(5, 7), 16) / 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    const d = max - min;
    let h = 0;
    if (d) {
      if (max === r) h = ((g - b) / d + 6) % 6;
      else if (max === g) h = (b - r) / d + 2;
      else h = (r - g) / d + 4;
      h *= 60;
    }
    return { h, s: max ? d / max : 0, v: max };
  }

  function hsvToHex(h, s, v) {
    const c = v * s, x = c * (1 - Math.abs((h / 60) % 2 - 1)), m = v - c;
    let r = 0, g = 0, b = 0;
    if (h < 60) { r = c; g = x; }
    else if (h < 120) { r = x; g = c; }
    else if (h < 180) { g = c; b = x; }
    else if (h < 240) { g = x; b = c; }
    else if (h < 300) { r = x; b = c; }
    else { r = c; b = x; }
    const toHex = (n) => Math.round((n + m) * 255).toString(16).padStart(2, '0');
    return '#' + toHex(r) + toHex(g) + toHex(b);
  }

  function luminance(hex) {
    const r = parseInt(hex.slice(1, 3), 16) / 255;
    const g = parseInt(hex.slice(3, 5), 16) / 255;
    const b = parseInt(hex.slice(5, 7), 16) / 255;
    return 0.299 * r + 0.587 * g + 0.114 * b;
  }

  function create(initialColor, onChange, opts) {
    const defaultColor = (opts && opts.defaultColor) || '#6D4AFF';
    const PRESETS = [
      '#6D4AFF', '#8B5CF6', '#A855F7', '#EC4899', '#F43F5E',
      '#DB3251', '#EF4444', '#EC5E30', '#F59E0B', '#F5A623',
      '#84CC16', '#3CBB6E', '#22C55E', '#14B8A6', '#06B6D4',
      '#1EA0D5', '#3B82F6', '#6366F1', '#1B1340', '#6B7280',
    ];

    let hsv = hexToHsv(initialColor);
    let currentHex = initialColor.toUpperCase();

    const panel = document.createElement('div');
    panel.className = 'color-picker-panel';

    // Saturation/brightness area
    const area = document.createElement('div');
    area.className = 'cp-area';
    const cursor = document.createElement('div');
    cursor.className = 'cp-cursor';
    area.appendChild(cursor);

    // Hue bar
    const hueBar = document.createElement('div');
    hueBar.className = 'cp-hue-bar';
    const hueThumb = document.createElement('div');
    hueThumb.className = 'cp-hue-thumb';
    hueBar.appendChild(hueThumb);

    // Preview + hex input row
    const controlRow = document.createElement('div');
    controlRow.className = 'cp-control-row';
    const preview = document.createElement('div');
    preview.className = 'cp-preview';
    const hexInput = document.createElement('input');
    hexInput.className = 'cp-hex-input';
    hexInput.type = 'text';
    hexInput.maxLength = 7;
    hexInput.spellcheck = false;
    controlRow.appendChild(preview);
    controlRow.appendChild(hexInput);

    // Preset swatches
    const swatches = document.createElement('div');
    swatches.className = 'cp-swatches';
    for (const c of PRESETS) {
      const sw = document.createElement('button');
      sw.className = 'cp-swatch';
      sw.style.background = c;
      sw.addEventListener('click', (e) => {
        e.stopPropagation();
        hsv = hexToHsv(c);
        currentHex = c.toUpperCase();
        _updatePickerUI();
        onChange(currentHex);
      });
      swatches.appendChild(sw);
    }

    // Reset button
    const resetBtn = document.createElement('button');
    resetBtn.className = 'cp-reset';
    resetBtn.textContent = ProtonI18n.t('resetToDefault');
    resetBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const def = defaultColor;
      hsv = hexToHsv(def);
      currentHex = def;
      _updatePickerUI();
      onChange(currentHex);
    });

    panel.appendChild(area);
    panel.appendChild(hueBar);
    panel.appendChild(controlRow);
    panel.appendChild(swatches);
    panel.appendChild(resetBtn);

    function _updatePickerUI() {
      const pureHue = hsvToHex(hsv.h, 1, 1);
      area.style.background = `linear-gradient(to top, #000, transparent), linear-gradient(to right, #fff, ${pureHue})`;
      cursor.style.left = (hsv.s * 100) + '%';
      cursor.style.top = ((1 - hsv.v) * 100) + '%';
      hueThumb.style.left = (hsv.h / 360 * 100) + '%';
      currentHex = hsvToHex(hsv.h, hsv.s, hsv.v).toUpperCase();
      preview.style.background = currentHex;
      hexInput.value = currentHex;
    }

    // Area drag
    function _areaMove(e, rect) {
      hsv.s = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
      hsv.v = Math.max(0, Math.min(1, 1 - (e.clientY - rect.top) / rect.height));
      _updatePickerUI();
      onChange(currentHex);
    }
    area.addEventListener('pointerdown', (e) => {
      e.stopPropagation();
      e.preventDefault();
      const rect = area.getBoundingClientRect();
      _areaMove(e, rect);
      const onMove = (ev) => { ev.preventDefault(); _areaMove(ev, rect); };
      const onUp = () => { document.removeEventListener('pointermove', onMove); document.removeEventListener('pointerup', onUp); };
      document.addEventListener('pointermove', onMove);
      document.addEventListener('pointerup', onUp);
    });

    // Hue drag
    function _hueMove(e, rect) {
      hsv.h = Math.max(0, Math.min(359, (e.clientX - rect.left) / rect.width * 360));
      _updatePickerUI();
      onChange(currentHex);
    }
    hueBar.addEventListener('pointerdown', (e) => {
      e.stopPropagation();
      e.preventDefault();
      const rect = hueBar.getBoundingClientRect();
      _hueMove(e, rect);
      const onMove = (ev) => { ev.preventDefault(); _hueMove(ev, rect); };
      const onUp = () => { document.removeEventListener('pointermove', onMove); document.removeEventListener('pointerup', onUp); };
      document.addEventListener('pointermove', onMove);
      document.addEventListener('pointerup', onUp);
    });

    // Hex input
    hexInput.addEventListener('input', (e) => {
      let v = e.target.value.trim();
      if (!v.startsWith('#')) v = '#' + v;
      if (/^#[0-9A-Fa-f]{6}$/.test(v)) {
        hsv = hexToHsv(v);
        currentHex = v.toUpperCase();
        const pureHue = hsvToHex(hsv.h, 1, 1);
        area.style.background = `linear-gradient(to top, #000, transparent), linear-gradient(to right, #fff, ${pureHue})`;
        cursor.style.left = (hsv.s * 100) + '%';
        cursor.style.top = ((1 - hsv.v) * 100) + '%';
        hueThumb.style.left = (hsv.h / 360 * 100) + '%';
        preview.style.background = currentHex;
        onChange(currentHex);
      }
    });
    hexInput.addEventListener('click', (e) => e.stopPropagation());

    // Stop clicks inside panel from closing it
    panel.addEventListener('click', (e) => e.stopPropagation());

    _updatePickerUI();
    return panel;
  }

  return { hexToHsv, hsvToHex, luminance, create };
})();
