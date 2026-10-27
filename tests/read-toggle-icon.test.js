/**
 * @vitest-environment jsdom
 *
 * The reader's read/unread button changed its title on every flip but never
 * its icon, and the icon it kept was not an envelope at all. Its path drew an
 * outer pentagon and two cut-outs (the flap and the body), all three wound
 * the same way, and without fill-rule="evenodd" the default nonzero rule
 * fills the cut-outs back in: a solid pentagon, "like a little house".
 *
 * Now the button shows the action it performs, as Proton's own toolbar does
 * (ReadUnreadButtons.tsx: envelope-open on "Mark as read", envelope-dot on
 * "Mark as unread"): an open envelope while the message is unread, a closed
 * one once it is read, swapped on every flip of the open message (its click,
 * both Undo toasts, and the auto-mark, rollback and poll paths, which all go
 * through _syncPreviewReadButton). The list row and the bulk menu only ever
 * mark read, and show the same open envelope.
 *
 * House style: popup.js is a DOM-bound IIFE, so the functions under test are
 * lifted out of the source by name and evaluated with their dependencies
 * injected. ICONS and _setHTML are the real ones, so the icon asserted on is
 * the SVG the user gets.
 */

import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const ROOT = join(__dirname, '..');
const POPUP = readFileSync(join(ROOT, 'popup', 'popup.js'), 'utf-8');

// Index just past a string literal or line comment starting at i, or i itself
// when neither starts there, so braces inside them do not unbalance the scan.
function skipLiteral(src, i) {
  const c = src[i];
  if (c === '/' && src[i + 1] === '/') {
    const nl = src.indexOf('\n', i);
    return nl === -1 ? src.length : nl;
  }
  if (c === '\'' || c === '"' || c === '`') {
    let j = i + 1;
    while (j < src.length && src[j] !== c) j += src[j] === '\\' ? 2 : 1;
    return j + 1;
  }
  return i;
}

/** The balanced `{ ... }` block that opens at or after `from`. */
function block(src, from, what) {
  let depth = 0;
  for (let i = src.indexOf('{', from); i < src.length; i++) {
    const next = skipLiteral(src, i);
    if (next !== i) { i = next - 1; continue; }
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) return i + 1; }
  }
  throw new Error('unbalanced braces reading ' + what);
}

function lift(name) {
  const m = new RegExp('(async )?function ' + name + '\\(').exec(POPUP);
  if (!m) throw new Error('function not found in popup.js: ' + name);
  const body = POPUP.indexOf(') {', m.index) + 1;
  return POPUP.slice(m.index, block(POPUP, body, name));
}

/** Evaluate lifted functions with `env` as constants and `state` as lets. */
function sandbox(names, env, state = {}) {
  const parts = [];
  const lets = Object.keys(state);
  if (lets.length) parts.push('let { ' + lets.join(', ') + ' } = __state;');
  parts.push('const { ' + Object.keys(env).join(', ') + ' } = __env;');
  for (const n of names) parts.push(lift(n));
  parts.push('return { ' + names.join(', ') + ' };');
  return new Function('__env', '__state', parts.join('\n\n'))(env, state);
}

// The real icon table.
const ICONS_AT = POPUP.indexOf('const ICONS = {');
const ICONS = new Function('return ' + POPUP.slice(POPUP.indexOf('{', ICONS_AT), block(POPUP, ICONS_AT, 'ICONS')))();

const ProtonI18n = { t: (k) => k };
const click = { stopPropagation() {} };

/** The `d` of an icon's single path, from its source string. */
const pathOf = (svg) => {
  const all = [...svg.matchAll(/<path\b[^>]*\sd="([^"]+)"/g)];
  if (all.length !== 1) throw new Error('expected one path, found ' + all.length);
  return all[0][1];
};
const OPEN = pathOf(ICONS.markRead);
const CLOSED = pathOf(ICONS.markUnread);

/** Which of the two icons a button shows: 'open', 'closed', or what it has instead. */
function iconOf(btn) {
  const svgs = btn.querySelectorAll('svg');
  if (svgs.length !== 1) return svgs.length + ' svgs';
  const paths = svgs[0].querySelectorAll('path');
  if (paths.length !== 1) return paths.length + ' paths';
  const d = paths[0].getAttribute('d');
  if (d === OPEN) return 'open';
  if (d === CLOSED) return 'closed';
  return 'another icon';
}

/** What a click on the reader's button does, by its title and by its icon. */
function face(btn) {
  return { title: btn.title, icon: iconOf(btn), unread: btn.dataset.unread };
}
const OFFERS_READ = { title: 'markAsRead', icon: 'open', unread: '1' };
const OFFERS_UNREAD = { title: 'markAsUnread', icon: 'closed', unread: '0' };

// --- Geometry: is the icon an envelope or a filled blob? --------------------

/**
 * Split a path into closed polygons. Arcs are reduced to their chord, which
 * is close enough for points chosen away from the rounded corners.
 */
function polygons(d) {
  const toks = d.match(/[MmLlHhVvAaZz]|-?(?:\d*\.\d+|\d+)(?:e[-+]?\d+)?/g);
  const polys = [];
  let poly = null;
  let x = 0, y = 0, sx = 0, sy = 0, cmd = null, i = 0;
  const num = () => parseFloat(toks[i++]);
  const to = (nx, ny) => { x = nx; y = ny; poly.push([x, y]); };
  while (i < toks.length) {
    if (/[A-Za-z]/.test(toks[i])) cmd = toks[i++];
    switch (cmd) {
      case 'M': case 'm': {
        const nx = num(), ny = num();
        const rel = cmd === 'm';
        poly = [];
        polys.push(poly);
        to(rel ? x + nx : nx, rel ? y + ny : ny);
        sx = x; sy = y;
        cmd = rel ? 'l' : 'L';
        break;
      }
      case 'L': to(num(), num()); break;
      case 'l': to(x + num(), y + num()); break;
      case 'H': to(num(), y); break;
      case 'h': to(x + num(), y); break;
      case 'V': to(x, num()); break;
      case 'v': to(x, y + num()); break;
      case 'A': case 'a': {
        num(); num(); num(); num(); num();
        const nx = num(), ny = num();
        to(cmd === 'a' ? x + nx : nx, cmd === 'a' ? y + ny : ny);
        break;
      }
      case 'Z': case 'z': x = sx; y = sy; cmd = null; break;
      default: throw new Error('path command not handled here: ' + cmd);
    }
  }
  return polys;
}

/** Whether the point is painted, under the fill rule the path declares. */
function painted(svg, px, py) {
  const rule = /fill-rule="evenodd"/.test(svg) ? 'evenodd' : 'nonzero';
  let wn = 0;
  for (const poly of polygons(pathOf(svg))) {
    for (let k = 0; k < poly.length; k++) {
      const [x1, y1] = poly[k];
      const [x2, y2] = poly[(k + 1) % poly.length];
      const side = (x2 - x1) * (py - y1) - (px - x1) * (y2 - y1);
      if (y1 <= py && y2 > py && side > 0) wn++;
      else if (y2 <= py && y1 > py && side < 0) wn--;
    }
  }
  return rule === 'evenodd' ? wn % 2 !== 0 : wn !== 0;
}

describe('the two icons are envelopes drawn in outline, not filled shapes', () => {
  it('both are in the house style of the other toolbar icons', () => {
    for (const svg of [ICONS.markRead, ICONS.markUnread]) {
      expect(svg).toMatch(/^<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">/);
      expect(svg).toMatch(/<\/svg>$/);
    }
    expect(OPEN).not.toBe(CLOSED);
  });

  it('the open envelope (Mark as read) has a hollow flap, body and sides', () => {
    const svg = ICONS.markRead;
    // Hollow: inside the flap, inside the body, inside each side triangle.
    for (const [x, y] of [[8, 4], [8, 13], [2.6, 10.25], [13.4, 10.25]]) {
      expect(painted(svg, x, y), 'hollow at ' + x + ',' + y).toBe(false);
    }
    // Drawn: the left and bottom edges, the top of the flap, the fold line.
    for (const [x, y] of [[0.5, 10], [8, 15.5], [8, 0.9], [8, 9.5]]) {
      expect(painted(svg, x, y), 'drawn at ' + x + ',' + y).toBe(true);
    }
  });

  it('the closed envelope (Mark as unread) has a hollow flap, body and sides', () => {
    const svg = ICONS.markUnread;
    for (const [x, y] of [[8, 5], [8, 12], [2.6, 8.2], [13.4, 8.2]]) {
      expect(painted(svg, x, y), 'hollow at ' + x + ',' + y).toBe(false);
    }
    for (const [x, y] of [[0.5, 8], [8, 13.5], [8, 2.5], [8, 9]]) {
      expect(painted(svg, x, y), 'drawn at ' + x + ',' + y).toBe(true);
    }
  });

  it('only the open one reaches the top: its flap stands open above the body', () => {
    // The closed envelope's top edge is at y=2, the open one's peak at y<1.
    expect(painted(ICONS.markRead, 8, 1)).toBe(true);
    expect(painted(ICONS.markUnread, 8, 1)).toBe(false);
  });
});

// --- The reader's button ----------------------------------------------------

describe('the reader\'s button shows the action it performs', () => {
  /**
   * The reader's actions rendered for `msg` as the open message, with the
   * real icons and the real _setHTML, and doAction and showToast recorded.
   */
  function reader(msg, { free = false } = {}) {
    const actionsEl = document.createElement('div');
    const actions = [];
    const toasts = [];
    const selected = { ID: msg.ID, Unread: msg.Unread };
    const fns = sandbox([
      '_renderPreviewActions', '_sortActionsByOrder', '_setHTML',
      'handleMarkRead', 'handleMarkUnread', '_syncPreviewReadButton',
    ], {
      document,
      ProtonI18n,
      ICONS,
      previewActionsEl: actionsEl,
      _settings: {},
      _selectedMsg: selected,
      FREE_PREVIEW_ACTIONS: new Set(['markRead', 'exportEml']),
      isPremium: () => !free,
      showPremiumUI: () => !free,
      showUpgradePrompt: vi.fn(),
      doAction: (type, ids) => actions.push([type, ...ids]),
      showToast: (text, undo) => toasts.push({ text, undo }),
    });
    fns._renderPreviewActions(msg, 'acc1');
    const button = () => actionsEl.querySelector('.action-read');
    return { ...fns, actions, toasts, button, selected, actionsEl };
  }

  it('an unread message opens with the open envelope, titled Mark as read', () => {
    const r = reader({ ID: 'm1', Unread: 1 });
    expect(face(r.button())).toEqual(OFFERS_READ);
  });

  it('a read message opens with the closed envelope, titled Mark as unread', () => {
    const r = reader({ ID: 'm1', Unread: 0 });
    expect(face(r.button())).toEqual(OFFERS_UNREAD);
  });

  it('the button holds exactly one icon, and the other buttons keep theirs', () => {
    const r = reader({ ID: 'm1', Unread: 1 });
    r.button().click();
    r.button().click();
    expect(r.button().querySelectorAll('svg')).toHaveLength(1);
    for (const b of r.actionsEl.querySelectorAll('.action-btn:not(.action-read)')) {
      expect(['open', 'closed']).not.toContain(iconOf(b));
    }
  });

  it('Mark as read swaps it to the closed envelope', () => {
    const r = reader({ ID: 'm1', Unread: 1 });
    r.button().click();
    expect(r.actions).toEqual([['MARK_READ', 'm1']]);
    expect(face(r.button())).toEqual(OFFERS_UNREAD);
  });

  it('Mark as unread swaps it to the open envelope', () => {
    const r = reader({ ID: 'm1', Unread: 0 });
    r.button().click();
    expect(r.actions).toEqual([['MARK_UNREAD', 'm1']]);
    expect(face(r.button())).toEqual(OFFERS_READ);
  });

  it('Undo on "Marked as read" swaps it back to the open envelope', () => {
    const r = reader({ ID: 'm1', Unread: 1 });
    r.button().click();
    expect(r.toasts.map((t) => t.text)).toEqual(['markedAsRead']);
    r.toasts[0].undo();
    expect(r.actions).toEqual([['MARK_READ', 'm1'], ['MARK_UNREAD', 'm1']]);
    expect(face(r.button())).toEqual(OFFERS_READ);
  });

  it('Undo on "Marked as unread" swaps it back to the closed envelope', () => {
    const r = reader({ ID: 'm1', Unread: 0 });
    r.button().click();
    expect(r.toasts.map((t) => t.text)).toEqual(['markedAsUnread']);
    r.toasts[0].undo();
    expect(r.actions).toEqual([['MARK_UNREAD', 'm1'], ['MARK_READ', 'm1']]);
    expect(face(r.button())).toEqual(OFFERS_UNREAD);
  });

  it('title, icon and the action a click sends agree after every step', () => {
    // Clicks and Undos in a row, from both starting states. Each one flips
    // the button, the icon always says what the title says, and a click
    // sends what both said. Each toast's Undo runs at most once, as in the UI.
    for (const start of [0, 1]) {
      const r = reader({ ID: 'm1', Unread: start });
      const undone = new Set();
      for (const [n, step] of ['click', 'undo', 'click', 'click', 'undo', 'click', 'click'].entries()) {
        const at = 'start ' + start + ', step ' + n + ' (' + step + ')';
        const before = face(r.button());
        const sent = r.actions.length;
        if (step === 'click') {
          r.button().click();
          expect(r.actions[sent][0], at).toBe(before.icon === 'open' ? 'MARK_READ' : 'MARK_UNREAD');
        } else {
          const last = r.toasts[r.toasts.length - 1];
          expect(undone.has(last), at).toBe(false);
          undone.add(last);
          last.undo();
        }
        const after = face(r.button());
        expect([OFFERS_READ, OFFERS_UNREAD], at).toContainEqual(after);
        expect(after.icon, at).not.toBe(before.icon);
        expect(r.selected.Unread, at).toBe(after.unread === '1' ? 1 : 0);
      }
    }
  });

  it('every other flip goes through _syncPreviewReadButton, which swaps the icon too', () => {
    // Auto-mark on open and on reply, star/label/move with their auto-mark
    // settings, a failed change rolled back, a poll listing it again: all of
    // them call this (tests/preview-read-stays-open.test.js runs those paths).
    const r = reader({ ID: 'm1', Unread: 1 });
    r._syncPreviewReadButton('m1', false);
    expect(face(r.button())).toEqual(OFFERS_UNREAD);
    r._syncPreviewReadButton('m1', true);
    expect(face(r.button())).toEqual(OFFERS_READ);
  });

  it('a list row marking another message leaves the open one\'s icon alone', () => {
    const r = reader({ ID: 'm1', Unread: 1 });
    r.handleMarkRead(click, 'other', 'acc1');
    expect(face(r.button())).toEqual(OFFERS_READ);
    r._syncPreviewReadButton('other', false);
    expect(face(r.button())).toEqual(OFFERS_READ);
  });

  it('works the same for a free user with premium UI hidden', () => {
    const r = reader({ ID: 'm1', Unread: 1 }, { free: true });
    expect(r.actionsEl.querySelectorAll('.action-btn')).toHaveLength(2);
    expect(face(r.button())).toEqual(OFFERS_READ);
    r.button().click();
    expect(face(r.button())).toEqual(OFFERS_UNREAD);
  });

  it('no path sets the button\'s title without its icon', () => {
    // The only two places that write the title, and each writes the icon
    // from the same state.
    const render = lift('_renderPreviewActions');
    expect(render).toMatch(/title: isUnread \? ProtonI18n\.t\('markAsRead'\) : ProtonI18n\.t\('markAsUnread'\),\s*icon: isUnread \? ICONS\.markRead : ICONS\.markUnread,/);
    const sync = lift('_syncPreviewReadButton');
    expect(sync).toMatch(/btn\.title = ProtonI18n\.t\(unread \? 'markAsRead' : 'markAsUnread'\);\s*_setHTML\(btn, unread \? ICONS\.markRead : ICONS\.markUnread\);/);
  });
});

// --- The list row and the bulk menu -----------------------------------------

describe('the list row and the bulk menu mark read with the same open envelope', () => {
  function row(msg) {
    const noop = () => {};
    const built = sandbox(['createMessageItem', 'createActionBtn', '_sortActionsByOrder', '_setHTML'], {
      document,
      ProtonI18n,
      ICONS,
      _renderReplyState: noop,
      _formatSender: () => 'A Sender',
      formatMessageTime: () => '10:30',
      createAvatarEl: () => document.createElement('div'),
      _senderIconsAllowed: () => false,
      _detectOTP: () => null,
      _settings: {},
      showPremiumUI: () => true,
      isPremium: () => true,
      showUpgradePrompt: noop,
      _openSubmenu: noop, _menuEnter: noop, _menuLeave: noop, _closeSubmenu: noop, _closeAllMenus: noop,
      handleMarkRead: noop,
      openPreview: noop,
      browser: { runtime: { sendMessage: () => Promise.resolve(null) }, tabs: { create: noop } },
    });
    return built.createMessageItem(Object.assign({ Subject: 'Hi', Time: 1, _accountId: 'acc1' }, msg), false);
  }

  it('an unread row offers Mark as read with the open envelope', () => {
    const li = row({ ID: 'm1', Unread: 1 });
    const btns = li.querySelectorAll('.action-read');
    expect(btns).toHaveLength(1);
    expect(btns[0].parentElement.classList.contains('msg-actions')).toBe(true);
    expect(btns[0].title).toBe('markAsRead');
    expect(iconOf(btns[0])).toBe('open');
  });

  it('a read row has no read button at all, so no closed envelope there either', () => {
    const li = row({ ID: 'm1', Unread: 0 });
    expect(li.querySelectorAll('.action-read')).toHaveLength(0);
    expect([...li.querySelectorAll('.action-btn')].map(iconOf)).not.toContain('closed');
  });

  it('the bulk menu\'s Mark all as read shows the open envelope', () => {
    const noop = () => {};
    document.body.textContent = '';
    const fns = sandbox(['_openBulkMenu', '_sortActionsByOrder', '_setHTML'], {
      document,
      ProtonI18n,
      ICONS,
      _settings: {},
      _closeBulkMenu: noop, _closeAllMenus: noop, _bulkEnter: noop, _bulkLeave: noop,
      _fitBulkMenu: noop, _closeBulkSub: noop, _showBulkSub: noop, _confirmBulk: noop,
      _buildLabelSub: noop, _buildFolderSub: noop, _buildSnoozeSub: noop,
      requirePremium: () => true, doAction: noop, showToast: noop, closePreview: async () => true,
    }, { _bulkMenuEl: null });
    const trigger = document.createElement('button');
    document.body.appendChild(trigger);
    fns._openBulkMenu(trigger, [{ ID: 'm1', ConversationID: 'c1' }, { ID: 'm2', ConversationID: 'c2' }], 'acc1');
    const items = [...document.querySelectorAll('.bulk-menu .dropdown-item')];
    const markAll = items.find((b) => b.querySelector('.dropdown-label').textContent === 'markAllAsRead');
    expect(markAll).toBeTruthy();
    expect(iconOf(markAll.querySelector('.dropdown-icon'))).toBe('open');
    // And it is the only envelope in the menu.
    expect(items.map((b) => iconOf(b.querySelector('.dropdown-icon'))).filter((i) => i === 'open' || i === 'closed'))
      .toEqual(['open']);
  });
});
