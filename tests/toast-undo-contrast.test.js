/**
 * The toast's Undo action has to stay readable in every theme and scheme.
 *
 * It used to be drawn in var(--purple-light), the theme's light accent, on the
 * toast's surface, which in most themes is the inverse one (background
 * var(--text)). In a dark scheme both are light: HUD dark put #6BEDD4 on
 * #EAF0FF, 1.25:1, where WCAG AA asks 4.5:1 for 12px text. 21 of the 38 theme
 * and scheme pairs fell short on the popup background, 22 once Modern dark's
 * glass is judged over a white backdrop. Undo now takes the toast's own text
 * colour, which every theme holds at AA.
 *
 * Rather than pin that one way of doing it, this test computes the outcome
 * from the stylesheets popup.html links: a small cascade over the element
 * chain showToast builds (html > body[data-theme][data-color-scheme] >
 * div.toast.visible > span + button.toast-undo), with the custom properties
 * resolved and opacity composited. It does so for every theme the options page
 * offers, light and dark, with every set of classes the popup puts on body,
 * with the pointer away, on the message or on Undo, with Undo held down or
 * not, and with no focus, mouse focus or keyboard focus. Rules inside @media /
 * @supports blocks are tried without the blocks, with each one on its own and
 * with all of them. An accent may come back if it passes all of that.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';

const ROOT = join(__dirname, '..');
const read = (...p) => readFileSync(join(ROOT, ...p), 'utf-8');
const CSS = read('popup', 'popup.css');
const POPUP_HTML = read('popup', 'popup.html');
const OPTIONS_HTML = read('options', 'options.html');

const AA_TEXT = 4.5;     // WCAG 1.4.3, normal-size text (the toast is 12px)
const AA_NON_TEXT = 3;   // WCAG 1.4.11, the underline and the focus ring

// ---------------------------------------------------------------------------
// Reading the stylesheets
// ---------------------------------------------------------------------------

/** Split on `sep` where it is not inside (), [] or quotes. */
function splitTop(s, sep) {
  const out = [];
  let depth = 0, quote = null, cur = '';
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (quote) {
      cur += ch;
      if (ch === '\\') { cur += s[++i] || ''; continue; }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; cur += ch; continue; }
    if (ch === '(' || ch === '[') depth++;
    else if (ch === ')' || ch === ']') depth--;
    if (ch === sep && depth === 0) { out.push(cur); cur = ''; continue; }
    cur += ch;
  }
  out.push(cur);
  return out;
}

function parseDecls(body) {
  const out = [];
  for (const part of splitTop(body, ';')) {
    const c = part.indexOf(':');
    if (c === -1) continue;
    const prop = part.slice(0, c).trim();
    let value = part.slice(c + 1).trim();
    if (!prop || !value) continue;
    let important = false;
    const m = /!\s*important\s*$/i.exec(value);
    if (m) { important = true; value = value.slice(0, m.index).trim(); }
    out.push({ prop: prop.startsWith('--') ? prop : prop.toLowerCase(), value, important });
  }
  return out;
}

const LEGACY_PSEUDO_ELEMENTS = new Set(['before', 'after', 'first-line', 'first-letter']);

/** One compound selector (no combinators) as a list of simple parts. */
function compoundParts(s) {
  const parts = [];
  let i = 0;
  while (i < s.length) {
    const ch = s[i];
    if (ch === '*') { parts.push({ t: 'universal' }); i++; continue; }
    if (ch === '.' || ch === '#') {
      const m = /^[\w-]+/.exec(s.slice(i + 1));
      parts.push({ t: ch === '.' ? 'class' : 'id', v: m[0] });
      i += 1 + m[0].length;
      continue;
    }
    if (ch === '[') {
      const end = s.indexOf(']', i);
      parts.push({ t: 'attr', v: s.slice(i + 1, end) });
      i = end + 1;
      continue;
    }
    if (ch === ':') {
      const element = s[i + 1] === ':';
      let k = i + (element ? 2 : 1);
      const name = /^[\w-]+/.exec(s.slice(k))[0].toLowerCase();
      k += name.length;
      let arg = null;
      if (s[k] === '(') {
        let d = 1, e = k + 1;
        for (; e < s.length && d; e++) { if (s[e] === '(') d++; else if (s[e] === ')') d--; }
        arg = s.slice(k + 1, e - 1);
        k = e;
      }
      const isElement = element || LEGACY_PSEUDO_ELEMENTS.has(name);
      parts.push({ t: isElement ? 'pseudo-element' : 'pseudo', v: name, arg });
      i = k;
      continue;
    }
    const m = /^[a-zA-Z][\w-]*/.exec(s.slice(i));
    if (!m) throw new Error('cannot read selector "' + s + '"');
    parts.push({ t: 'type', v: m[0].toLowerCase() });
    i += m[0].length;
  }
  return parts;
}

/** A complex selector as compounds, each with its combinator to the left. */
function parseSelector(sel) {
  const out = [];
  let cur = '', depth = 0, comb = null;
  const flush = () => {
    if (cur.trim()) { out.push({ comb: out.length ? (comb || ' ') : null, parts: compoundParts(cur.trim()) }); comb = null; }
    cur = '';
  };
  for (const ch of sel) {
    if (ch === '(' || ch === '[') depth++;
    if (ch === ')' || ch === ']') depth--;
    if (depth === 0 && /[\s>+~]/.test(ch)) {
      flush();
      if (!/\s/.test(ch)) comb = ch;
      continue;
    }
    cur += ch;
  }
  flush();
  return out;
}

function specificity(compiled) {
  const s = [0, 0, 0];
  for (const c of compiled) {
    for (const p of c.parts) {
      if (p.t === 'id') s[0]++;
      else if (p.t === 'class' || p.t === 'attr') s[1]++;
      else if (p.t === 'type' || p.t === 'pseudo-element') s[2]++;
      else if (p.t === 'pseudo') {
        if (p.v === 'where') continue;
        if (p.v === 'is' || p.v === 'not' || p.v === 'matches') {
          let best = [0, 0, 0];
          for (const arg of splitTop(p.arg, ',')) {
            const x = specificity(parseSelector(arg.trim()));
            if (compareSpec(x, best) > 0) best = x;
          }
          for (let i = 0; i < 3; i++) s[i] += best[i];
        } else s[1]++;
      }
    }
  }
  return s;
}

function compareSpec(a, b) {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return 0;
}

// Blocks whose rules apply only under a condition. Each one is tried both
// ways (see scenarios()), so a rule inside one can neither hide the
// declaration that really wins nor stand in for one that is missing.
const CONDITIONAL_AT_RULES = new Set(['media', 'supports', 'container', 'starting-style']);
// These change the cascade in ways this test does not model, so it stops
// rather than guess.
const UNMODELLED_AT_RULES = /(^|[;{}])\s*@(layer|scope|property|import)\b/i;

/** Style rules in source order, each with the ids of the conditional blocks
 *  it sits in (registered in `conditions`). @keyframes, @font-face and the
 *  like carry no selectors and are skipped. */
function parseRules(css, origin, start, conditions) {
  const rules = [];
  let order = start;
  const text = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const unmodelled = UNMODELLED_AT_RULES.exec(text);
  if (unmodelled) throw new Error('@' + unmodelled[2] + ' changes the cascade in a way this test does not model; teach parseRules');
  (function walk(text, conds) {
    let i = 0;
    while (i < text.length) {
      const open = text.indexOf('{', i);
      if (open === -1) break;
      let prelude = text.slice(i, open);
      prelude = prelude.slice(prelude.lastIndexOf(';') + 1).trim();
      let depth = 1, j = open + 1, quote = null;
      for (; j < text.length && depth; j++) {
        const ch = text[j];
        if (quote) { if (ch === '\\') j++; else if (ch === quote) quote = null; continue; }
        if (ch === '"' || ch === "'") quote = ch;
        else if (ch === '{') depth++;
        else if (ch === '}') depth--;
      }
      const body = text.slice(open + 1, j - 1);
      i = j;
      if (prelude.startsWith('@')) {
        const name = /^@([\w-]+)/.exec(prelude)[1].toLowerCase();
        if (CONDITIONAL_AT_RULES.has(name)) {
          const id = conditions.length;
          conditions.push({ id, prelude: prelude.replace(/\s+/g, ' '), parent: conds.length ? conds[conds.length - 1] : null });
          walk(body, [...conds, id]);
        }
        continue;
      }
      const selectors = splitTop(prelude, ',').map((s) => s.trim()).filter(Boolean).map((text) => {
        const compiled = parseSelector(text);
        return { text, compiled, spec: specificity(compiled) };
      });
      const decls = parseDecls(body).map((d) => ({ ...d, origin, order: order++ }));
      rules.push({ selectors, decls, conds });
    }
  })(text, []);
  return { rules, next: order };
}

// What Chrome's own stylesheet gives these elements when the author says
// nothing: dark button text, and an auto focus ring on :focus-visible.
const UA_CSS = `
  button { color: #000000; background-color: #EFEFEF; }
  :focus-visible { outline: auto 1px #101010; }
`;

/** The browser's rules, then each author stylesheet in document order. */
function loadSheet(texts) {
  const conditions = [];
  const ua = parseRules(UA_CSS, 0, 0, conditions);
  const rules = [...ua.rules];
  let next = ua.next;
  for (const css of texts) {
    const p = parseRules(css, 1, next, conditions);
    rules.push(...p.rules);
    next = p.next;
  }
  return { rules, conditions };
}

/** The stylesheets popup.html links, in document order, relative to popup/. */
function linkedStylesheets() {
  const out = [];
  for (const m of POPUP_HTML.matchAll(/<link\b[^>]*>/gi)) {
    if (!/\brel\s*=\s*["']?stylesheet\b/i.test(m[0])) continue;
    const href = /\bhref\s*=\s*["']([^"']+)["']/i.exec(m[0]);
    if (href) out.push(href[1]);
  }
  return out;
}

// ---------------------------------------------------------------------------
// The page: what the popup puts on body, and what pointer and keyboard do
// ---------------------------------------------------------------------------

function optionValues(selectId) {
  const select = new RegExp('<select id="' + selectId + '">([\\s\\S]*?)</select>').exec(OPTIONS_HTML);
  if (!select) throw new Error(selectId + ' select not found in options.html');
  return [...select[1].matchAll(/<option value="([^"]+)"/g)].map((m) => m[1]);
}

// The classes theme-boot.js and popup.js put on <body>. Each group holds at
// most one of its classes at a time; every group can also hold none.
const BODY_CLASS_GROUPS = [
  ['is-free', 'is-premium'],                                   // render(), once the first state arrives
  ['standalone'],                                              // theme-boot.js, the popped-out window
  optionValues('display-density').map((d) => 'density-' + d),  // theme-boot.js and applyDensity()
  ['hide-premium-ui'],                                         // render(), when premium UI is hidden
];
const BODY_SETS = BODY_CLASS_GROUPS.reduce((sets, group) => sets.flatMap((s) => [s, ...group.map((c) => [...s, c])]), [[]]);

/** What the popup's scripts write onto <body> and <html>, as far as a plain
 *  reading of the source can tell. */
function bodyWritesInScripts() {
  const found = { classes: [], dynamic: [], attrs: [], other: [] };
  for (const file of readdirSync(join(ROOT, 'popup')).filter((n) => n.endsWith('.js'))) {
    const src = read('popup', file);
    // theme-boot.js works on `const body = document.body`.
    const target = file === 'theme-boot.js' ? '(?:document\\.)?body' : 'document\\.body';
    for (const m of src.matchAll(new RegExp('\\b' + target + '\\.classList\\.(add|toggle|replace)\\(([^)]*)\\)', 'g'))) {
      const args = splitTop(m[2], ',').map((a) => a.trim());
      const named = m[1] === 'toggle' ? args.slice(0, 1) : m[1] === 'replace' ? args.slice(1, 2) : args;
      for (const a of named) {
        const lit = /^'([\w-]+)'$|^"([\w-]+)"$/.exec(a);
        if (lit) found.classes.push(lit[1] || lit[2]);
        else found.dynamic.push(file + ': ' + a);
      }
    }
    for (const m of src.matchAll(new RegExp('\\b' + target + '\\.setAttribute\\(\\s*([^,]+),', 'g'))) {
      found.attrs.push(m[1].trim().replace(/^['"]|['"]$/g, ''));
    }
    const odd = new RegExp('\\b' + target + '\\.(?:className|dataset)\\b|\\bdocument\\.documentElement\\.(?:classList|className|dataset|setAttribute)\\b', 'g');
    for (const m of src.matchAll(odd)) found.other.push(file + ': ' + m[0]);
  }
  return found;
}

// Where the pointer is (on the message or on Undo), whether Undo is held
// down, and how it got focus: mouse focus does not match :focus-visible,
// keyboard focus does.
const POINTER = ['', 'hover-message', 'hover'];
const PRESS = ['', 'active'];
const FOCUS = ['', 'focus', 'focus-visible'];
const STATES = POINTER.flatMap((p) => PRESS.flatMap((a) => FOCUS.map((f) => [p, a, f].filter(Boolean).join('+') || 'rest')));
const STATE_PARTS = new Set(['hover', 'hover-message', 'active', 'focus', 'focus-visible']);

function node(tag, o = {}) {
  return { tag, classes: o.classes || [], attrs: o.attrs || {}, parent: o.parent || null, prev: null, next: null, root: !!o.root, states: o.states || [], childOfKnown: !!o.childOfKnown };
}

/** The elements showToast builds, appended to body, with the page in
 *  `state`: 'rest', or '+'-joined parts of hover (pointer on Undo),
 *  hover-message (pointer on the message), active (Undo held down), focus
 *  (mouse focus) and focus-visible (keyboard focus). The ancestors share
 *  :hover and :active, and get :focus-within. */
function toastNodes(theme, scheme, state, bodyClasses = []) {
  const has = new Set(state === 'rest' ? [] : state.split('+'));
  for (const s of has) if (!STATE_PARTS.has(s)) throw new Error('unknown state "' + s + '"');
  const onUndo = has.has('hover'), onMessage = has.has('hover-message'), pressed = has.has('active');
  const keyboard = has.has('focus-visible'), focused = keyboard || has.has('focus');
  const up = [...(onUndo || onMessage ? ['hover'] : []), ...(pressed ? ['active'] : []), ...(focused ? ['focus-within'] : [])];
  const html = node('html', { root: true, states: up });
  const body = node('body', { classes: bodyClasses, attrs: { 'data-theme': theme, 'data-color-scheme': scheme }, parent: html, states: up });
  const toast = node('div', { classes: ['toast', 'visible'], parent: body, states: up });
  const span = node('span', { parent: toast, childOfKnown: true, states: onMessage ? ['hover'] : [] });
  const undo = node('button', {
    classes: ['toast-undo'], parent: toast, childOfKnown: true,
    states: [...(onUndo ? ['hover'] : []), ...(pressed ? ['active'] : []), ...(focused ? ['focus', 'focus-within'] : []), ...(keyboard ? ['focus-visible'] : [])],
  });
  span.next = undo;
  undo.prev = span;
  return { html, body, toast, span, undo };
}

// ---------------------------------------------------------------------------
// Matching and cascading
// ---------------------------------------------------------------------------

function matchAttr(src, e) {
  const m = /^\s*([\w-]+)\s*(?:([~|^$*]?=)\s*("([^"]*)"|'([^']*)'|[^\s\]]+))?\s*(i)?\s*$/.exec(src);
  if (!m) throw new Error('cannot read attribute selector [' + src + ']');
  const name = m[1], op = m[2];
  if (!(name in e.attrs)) return false;
  if (!op) return true;
  let want = m[4] !== undefined ? m[4] : m[5] !== undefined ? m[5] : m[3];
  let have = String(e.attrs[name]);
  if (m[6]) { want = want.toLowerCase(); have = have.toLowerCase(); }
  switch (op) {
    case '=': return have === want;
    case '~=': return have.split(/\s+/).includes(want);
    case '|=': return have === want || have.startsWith(want + '-');
    case '^=': return have.startsWith(want);
    case '$=': return have.endsWith(want);
    case '*=': return have.includes(want);
  }
  return false;
}

// Pseudo-classes none of these elements is ever in, and ones they always are.
const NEVER = new Set(['disabled', 'checked', 'indeterminate', 'placeholder-shown', 'empty', 'link', 'any-link', 'visited', 'target', 'autofill', 'read-write']);
const ALWAYS = new Set(['defined', 'read-only']);

function matchPseudo(p, e) {
  switch (p.v) {
    case 'root': return e.root;
    case 'hover': case 'focus': case 'focus-visible': case 'focus-within': case 'active':
      return e.states.includes(p.v);
    case 'not': return !matchList(p.arg, e);
    case 'is': case 'where': case 'matches': return matchList(p.arg, e);
    case 'enabled': return e.tag === 'button';
    case 'first-child': case 'last-child': case 'only-child':
      if (!e.childOfKnown) throw new Error('this test does not know where <' + e.tag + '> sits among its siblings (:' + p.v + ')');
      return p.v === 'first-child' ? !e.prev : p.v === 'last-child' ? !e.next : !e.prev && !e.next;
  }
  if (NEVER.has(p.v)) return false;
  if (ALWAYS.has(p.v)) return true;
  // Answering false here would quietly drop a rule that may well apply.
  throw new Error('this test cannot tell whether :' + p.v + ' matches <' + e.tag + '>; teach matchPseudo');
}

function matchCompound(parts, e) {
  // Tag, class and attribute first, so a pseudo-class is only asked about an
  // element the rest of the compound already fits.
  for (const p of parts) {
    if (p.t === 'type' && e.tag !== p.v) return false;
    if (p.t === 'class' && !e.classes.includes(p.v)) return false;
    if (p.t === 'id' && e.attrs.id !== p.v) return false;
    if (p.t === 'attr' && !matchAttr(p.v, e)) return false;
    if (p.t === 'pseudo-element') return false;
  }
  for (const p of parts) if (p.t === 'pseudo' && !matchPseudo(p, e)) return false;
  return true;
}

function matchCompiled(compiled, e) {
  const at = (idx, n) => {
    if (!matchCompound(compiled[idx].parts, n)) return false;
    if (idx === 0) return true;
    const comb = compiled[idx].comb;
    if (comb === '>') return !!n.parent && at(idx - 1, n.parent);
    if (comb === '+') return !!n.prev && at(idx - 1, n.prev);
    if (comb === ' ') { for (let p = n.parent; p; p = p.parent) if (at(idx - 1, p)) return true; return false; }
    if (comb === '~') { for (let p = n.prev; p; p = p.prev) if (at(idx - 1, p)) return true; return false; }
    return false;
  };
  return at(compiled.length - 1, e);
}

function matchList(list, e) {
  return splitTop(list, ',').some((s) => matchCompiled(parseSelector(s.trim()), e));
}

/** Whether a selector's subject could be `e` at all, judged on tag, classes
 *  and attribute names alone (states and attribute values are left to the
 *  real match). Only ever says no to a selector that cannot match. */
function subjectCouldBe(selector, e) {
  return selector.compiled[selector.compiled.length - 1].parts.every((p) => {
    switch (p.t) {
      case 'type': return e.tag === p.v;
      case 'class': return e.classes.includes(p.v);
      case 'id': return e.attrs.id === p.v;
      case 'attr': return /^\s*([\w-]+)/.exec(p.v)[1] in e.attrs;
      case 'pseudo-element': return false;
      default: return true;
    }
  });
}

// The rules worth trying on each kind of element, so the 18 states times 48
// body class sets times 38 themes stay quick.
const CANDIDATES = new WeakMap();
function candidates(rules, e) {
  let byKind = CANDIDATES.get(rules);
  if (!byKind) CANDIDATES.set(rules, (byKind = new Map()));
  const kind = JSON.stringify([e.tag, e.classes, Object.keys(e.attrs)]);
  let list = byKind.get(kind);
  if (!list) {
    list = [];
    for (const r of rules) {
      const selectors = r.selectors.filter((s) => subjectCouldBe(s, e));
      if (selectors.length) list.push({ selectors, decls: r.decls });
    }
    // The states these selectors ask about, anywhere in them.
    list.seen = new Set(list.flatMap((r) => r.selectors.flatMap((s) => [...s.text.matchAll(STATE_NAMES)].map((m) => m[1]))));
    byKind.set(kind, list);
  }
  return list;
}
const STATE_NAMES = /:(hover|active|focus-visible|focus-within|focus)\b/g;

/** Every declaration that applies to `e`, carrying the specificity of the
 *  most specific selector in its list that matched. */
function matchedDecls(rules, e) {
  const out = [];
  for (const r of candidates(rules, e)) {
    let best = null;
    for (const s of r.selectors) if (matchCompiled(s.compiled, e) && (!best || compareSpec(s.spec, best) > 0)) best = s.spec;
    if (best) for (const d of r.decls) out.push({ ...d, spec: best });
  }
  return out;
}

function beats(x, y) {
  if (x.important !== y.important) return x.important;
  if (x.origin !== y.origin) return x.origin > y.origin;
  const c = compareSpec(x.spec, y.spec);
  if (c !== 0) return c > 0;
  return x.order > y.order;
}

const SHORTHAND_OF = {
  'background-color': 'background', 'background-image': 'background',
  'text-decoration-line': 'text-decoration', 'text-decoration-color': 'text-decoration', 'text-decoration-thickness': 'text-decoration',
  'outline-style': 'outline', 'outline-width': 'outline', 'outline-color': 'outline',
};
const INITIAL = {
  color: '#000000', 'background-color': 'transparent', 'background-image': 'none', opacity: '1',
  filter: 'none', 'mix-blend-mode': 'normal', 'backdrop-filter': 'none', '-webkit-backdrop-filter': 'none',
  'text-decoration-line': 'none', 'text-decoration-color': 'currentcolor', 'text-decoration-thickness': 'auto',
  'outline-style': 'none', 'outline-width': 'medium', 'outline-color': 'currentcolor', 'text-underline-offset': 'auto',
};
// `color` first, so the others can resolve currentColor.
const LONGHANDS = ['color', ...Object.keys(INITIAL).filter((k) => k !== 'color')];
const INHERITED = new Set(['color']);

function winner(decls, prop) {
  let w = null;
  for (const d of decls) if ((d.prop === prop || d.prop === SHORTHAND_OF[prop]) && (!w || beats(d, w))) w = d;
  return w;
}

/** var() substitution; null when a reference has neither value nor fallback. */
function substitute(value, lookup) {
  let out = '', i = 0;
  for (;;) {
    const at = value.indexOf('var(', i);
    if (at === -1) return out + value.slice(i);
    out += value.slice(i, at);
    let d = 1, j = at + 4;
    for (; j < value.length && d; j++) { if (value[j] === '(') d++; else if (value[j] === ')') d--; }
    const inner = value.slice(at + 4, j - 1);
    const comma = inner.indexOf(',');
    const name = (comma === -1 ? inner : inner.slice(0, comma)).trim();
    let v = lookup(name);
    if (v == null) {
      if (comma === -1) return null;
      v = substitute(inner.slice(comma + 1).trim(), lookup);
      if (v == null) return null;
    }
    out += v;
    i = j;
  }
}

/** Custom properties as computed on `e`: declared ones resolved here,
 *  everything else inherited already resolved. */
function customProps(decls, inherited) {
  const declared = {};
  const best = {};
  for (const d of decls) if (d.prop.startsWith('--') && (!best[d.prop] || beats(d, best[d.prop]))) best[d.prop] = d;
  for (const k of Object.keys(best)) declared[k] = best[k].value;
  const done = {}, visiting = new Set();
  const get = (name) => {
    if (!(name in declared)) return name in inherited ? inherited[name] : null;
    if (name in done) return done[name];
    if (visiting.has(name)) return null;
    visiting.add(name);
    const v = substitute(declared[name], get);
    visiting.delete(name);
    done[name] = v;
    return v;
  };
  if (!Object.keys(declared).length) return inherited;
  const out = { ...inherited };
  for (const k of Object.keys(declared)) { const v = get(k); if (v == null) delete out[k]; else out[k] = v; }
  return out;
}

const tokens = (v) => splitTop(v.replace(/\s+/g, ' ').trim(), ' ').map((t) => t.trim()).filter(Boolean);
const isColor = (t) => { try { parseColor(t, BLACK); return true; } catch (e) { return false; } };
const OUTLINE_STYLES = new Set(['none', 'hidden', 'dotted', 'dashed', 'solid', 'double', 'groove', 'ridge', 'inset', 'outset', 'auto']);
const DECO_LINES = new Set(['none', 'underline', 'overline', 'line-through', 'blink']);
const DECO_STYLES = new Set(['solid', 'double', 'dotted', 'dashed', 'wavy']);
const isLength = (t) => /^-?(\d*\.)?\d+(px|em|rem|%)?$/.test(t) || ['thin', 'medium', 'thick', 'auto', 'from-font'].includes(t);

/** One longhand out of a shorthand value, or its initial value. */
function fromShorthand(sh, prop, value) {
  if (sh === 'background') {
    const layers = splitTop(value, ',');
    const last = tokens(layers[layers.length - 1]);
    if (prop === 'background-color') return last.find(isColor) || 'transparent';
    const images = layers.flatMap(tokens).filter((t) => /^(url|image|[a-z-]*gradient|image-set|cross-fade)\(/i.test(t));
    return images.length ? images.join(', ') : 'none';
  }
  const toks = tokens(value);
  if (sh === 'outline') {
    if (prop === 'outline-style') return toks.find((t) => OUTLINE_STYLES.has(t)) || 'none';
    if (prop === 'outline-width') return toks.find((t) => !OUTLINE_STYLES.has(t) && isLength(t)) || 'medium';
    return toks.find((t) => !OUTLINE_STYLES.has(t) && !isLength(t) && isColor(t)) || 'currentcolor';
  }
  if (sh === 'text-decoration') {
    if (prop === 'text-decoration-line') return toks.filter((t) => DECO_LINES.has(t)).join(' ') || 'none';
    if (prop === 'text-decoration-thickness') return toks.find((t) => isLength(t)) || 'auto';
    return toks.find((t) => !DECO_LINES.has(t) && !DECO_STYLES.has(t) && !isLength(t) && isColor(t)) || 'currentcolor';
  }
  throw new Error('no shorthand ' + sh);
}

/** What decides how `e` matches, besides its ancestors' own keys: its tag,
 *  classes and attributes and those of the siblings before it, plus the
 *  states its candidate selectors ask about, on every element they can look
 *  at. A state no selector asks about cannot change the outcome. */
function signature(rules, e) {
  const seen = candidates(rules, e).seen;
  const states = [];
  if (seen.size) for (let p = e; p; p = p.parent) for (let s = p; s; s = s.prev) states.push(s.states.filter((x) => seen.has(x)));
  const shape = (n) => [n.tag, n.classes, n.attrs, n.root, n.childOfKnown, !!n.next, n.prev ? shape(n.prev) : null];
  return JSON.stringify([shape(e), states]);
}

// The same element under the same parent always computes the same.
const COMPUTED = new WeakMap();

/** Computed values of `e` for the properties this test reads. Colours come
 *  back as {r, g, b, a}; currentColor and inherit are resolved. */
function compute(rules, e, parent) {
  let memo = COMPUTED.get(rules);
  if (!memo) COMPUTED.set(rules, (memo = new Map()));
  const key = (parent ? parent.key + ' > ' : '') + signature(rules, e);
  const hit = memo.get(key);
  if (hit) return hit;
  const decls = matchedDecls(rules, e);
  const custom = customProps(decls, parent ? parent.custom : {});
  const raw = {};
  let color = null;
  for (const prop of LONGHANDS) {
    const w = winner(decls, prop);
    let v;
    if (!w) v = INHERITED.has(prop) ? 'inherit' : 'initial';
    else {
      // A reference with no value and no fallback leaves the declaration
      // invalid at computed-value time, which behaves as unset.
      const sub = substitute(w.value, (n) => (n in custom ? custom[n] : null));
      v = sub == null ? 'unset' : w.prop === prop ? sub.trim() : fromShorthand(w.prop, prop, sub);
    }
    const kw = v.toLowerCase();
    // currentColor as the value of `color` itself means inherit.
    const inherits = kw === 'inherit' || (kw === 'unset' && INHERITED.has(prop)) || (prop === 'color' && kw === 'currentcolor');
    if (inherits) v = parent ? parent.raw[prop] : INITIAL[prop];
    else if (['initial', 'unset', 'revert', 'revert-layer'].includes(kw)) v = INITIAL[prop];
    raw[prop] = v;
    if (prop === 'color') color = inherits && parent ? parent.color : parseColor(v, parent ? parent.color : BLACK);
  }
  const out = { key, raw, custom, color };
  for (const p of ['background-color', 'text-decoration-color', 'outline-color']) out[p] = parseColor(raw[p], color);
  memo.set(key, out);
  return out;
}

/** The chain showToast builds, computed, with the page in `state`. */
function toastChain(rules, theme, scheme, state, bodyClasses = []) {
  const n = toastNodes(theme, scheme, state, bodyClasses);
  const html = compute(rules, n.html, null);
  const body = compute(rules, n.body, html);
  const toast = compute(rules, n.toast, body);
  return { html, body, toast, span: compute(rules, n.span, toast), undo: compute(rules, n.undo, toast) };
}

/**
 * The rule sets to judge: without any conditional block, with each block
 * that can reach the toast on its own (its enclosing blocks included), and
 * with all of them. Rules that cannot reach the toast are dropped first, so
 * a stylesheet whose conditional blocks style other things has one scenario.
 */
function scenarios(sheet) {
  const kinds = BODY_SETS.flatMap((set) => Object.values(toastNodes('-', 'light', 'rest', set)));
  const reach = sheet.rules.filter((r) => r.selectors.some((s) => kinds.some((e) => subjectCouldBe(s, e))));
  const blocks = [...new Set(reach.flatMap((r) => r.conds))].sort((a, b) => a - b);
  const withOuter = (id) => { const out = new Set(); for (let c = id; c != null; c = sheet.conditions[c].parent) out.add(c); return out; };
  const sets = [[blocks.length ? 'without any @media / @supports block' : '', new Set()]];
  for (const id of blocks) sets.push(['with only ' + sheet.conditions[id].prelude, withOuter(id)]);
  if (blocks.length > 1) sets.push(['with every @media / @supports block', new Set(blocks)]);
  return sets.map(([name, active]) => ({ name, rules: reach.filter((r) => r.conds.every((c) => active.has(c))) }));
}

// ---------------------------------------------------------------------------
// Colour
// ---------------------------------------------------------------------------

const BLACK = { r: 0, g: 0, b: 0, a: 1 };
const WHITE = { r: 255, g: 255, b: 255, a: 1 };
const NAMED = { black: [0, 0, 0], white: [255, 255, 255], red: [255, 0, 0], green: [0, 128, 0], blue: [0, 0, 255], gray: [128, 128, 128], grey: [128, 128, 128] };

function channel(t, scale) {
  t = t.trim();
  return t.endsWith('%') ? (parseFloat(t) / 100) * scale : parseFloat(t);
}

function parseColor(s, current) {
  const v = s.trim().toLowerCase();
  if (v === 'currentcolor') return current;
  if (v === 'transparent') return { r: 0, g: 0, b: 0, a: 0 };
  if (NAMED[v]) { const [r, g, b] = NAMED[v]; return { r, g, b, a: 1 }; }
  let m = /^#([0-9a-f]+)$/.exec(v);
  if (m) {
    let h = m[1];
    if (h.length === 3 || h.length === 4) h = h.split('').map((c) => c + c).join('');
    if (h.length !== 6 && h.length !== 8) throw new Error('bad hex ' + s);
    return { r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16), a: h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1 };
  }
  m = /^rgba?\((.*)\)$/.exec(v);
  if (m) {
    let parts, alpha = '1';
    if (m[1].includes(',')) { parts = m[1].split(','); if (parts.length === 4) alpha = parts.pop(); }
    else { const [rgb, a] = m[1].split('/'); parts = rgb.trim().split(/\s+/); if (a !== undefined) alpha = a; }
    if (parts.length !== 3) throw new Error('bad rgb ' + s);
    return { r: channel(parts[0], 255), g: channel(parts[1], 255), b: channel(parts[2], 255), a: channel(alpha, 1) };
  }
  m = /^hsla?\((.*)\)$/.exec(v);
  if (m) {
    let parts, alpha = '1';
    if (m[1].includes(',')) { parts = m[1].split(','); if (parts.length === 4) alpha = parts.pop(); }
    else { const [hsl, a] = m[1].split('/'); parts = hsl.trim().split(/\s+/); if (a !== undefined) alpha = a; }
    const h = (parseFloat(parts[0]) % 360 + 360) % 360, sat = parseFloat(parts[1]) / 100, l = parseFloat(parts[2]) / 100;
    const f = (n) => { const k = (n + h / 30) % 12; return l - sat * Math.min(l, 1 - l) * Math.max(-1, Math.min(k - 3, 9 - k, 1)); };
    return { r: f(0) * 255, g: f(8) * 255, b: f(4) * 255, a: channel(alpha, 1) };
  }
  m = /^color-mix\((.*)\)$/.exec(v);
  if (m) {
    const args = splitTop(m[1], ',').map((a) => a.trim());
    if (args[0] !== 'in srgb' || args.length !== 3) throw new Error('only color-mix(in srgb, a, b) is understood: ' + s);
    // The percentage sits before or after the colour, never inside it.
    const side = (a) => {
      const pm = /^(\d*\.?\d+)%\s+|\s+(\d*\.?\d+)%$/.exec(a);
      const col = pm ? (a.slice(0, pm.index) + a.slice(pm.index + pm[0].length)).trim() : a;
      return { c: parseColor(col, current), p: pm ? parseFloat(pm[1] !== undefined ? pm[1] : pm[2]) : null };
    };
    const A = side(args[1]), B = side(args[2]);
    let p1 = A.p, p2 = B.p;
    if (p1 == null && p2 == null) { p1 = 50; p2 = 50; }
    else if (p1 == null) p1 = 100 - p2;
    else if (p2 == null) p2 = 100 - p1;
    const sum = p1 + p2;
    const mult = sum < 100 ? sum / 100 : 1;
    p1 /= sum; p2 /= sum;
    const a = A.c.a * p1 + B.c.a * p2;
    if (a === 0) return { r: 0, g: 0, b: 0, a: 0 };
    const mix = (k) => (A.c[k] * A.c.a * p1 + B.c[k] * B.c.a * p2) / a;
    return { r: mix('r'), g: mix('g'), b: mix('b'), a: a * mult };
  }
  throw new Error('colour not understood: "' + s + '"');
}

/** `fg` painted over opaque `bg`. */
function over(fg, bg) {
  return { r: fg.r * fg.a + bg.r * (1 - fg.a), g: fg.g * fg.a + bg.g * (1 - fg.a), b: fg.b * fg.a + bg.b * (1 - fg.a), a: 1 };
}
function blend(a, b, t) {
  return { r: a.r * t + b.r * (1 - t), g: a.g * t + b.g * (1 - t), b: a.b * t + b.b * (1 - t), a: 1 };
}
function luminance(c) {
  const f = (v) => { v /= 255; return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
  return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b);
}
function contrast(a, b) {
  const x = luminance(a), y = luminance(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}
const hex = (c) => '#' + [c.r, c.g, c.b].map((v) => Math.round(v).toString(16).padStart(2, '0')).join('').toUpperCase();

/** An opacity value as a number from 0 to 1. */
function alpha(v) {
  const s = String(v).trim();
  const x = s.endsWith('%') ? parseFloat(s) / 100 : parseFloat(s);
  if (Number.isNaN(x)) throw new Error('opacity not understood: "' + v + '"');
  return Math.min(1, Math.max(0, x));
}

const widthPx = (w) => ({ thin: 1, medium: 3, thick: 5 }[w] ?? parseFloat(w));

// ---------------------------------------------------------------------------
// What a viewer sees
// ---------------------------------------------------------------------------

const NODE_NAMES = { html: '<html>', body: '<body>', toast: 'the toast', span: 'the message', undo: 'Undo' };
// Paint this test cannot turn into a colour; it says so rather than guess.
const UNJUDGEABLE = [
  ['background-image', 'none', ['toast', 'span', 'undo']],
  ['filter', 'none', ['html', 'body', 'toast', 'span', 'undo']],
  ['mix-blend-mode', 'normal', ['html', 'body', 'toast', 'span', 'undo']],
  ['backdrop-filter', 'none', ['span', 'undo']],
  ['-webkit-backdrop-filter', 'none', ['span', 'undo']],
];

function describeCase(theme, scheme, bodyClasses, state, scenario) {
  return [theme, scheme, bodyClasses.length ? 'body.' + bodyClasses.join('.') : '', state, scenario ? '(' + scenario + ')' : ''].filter(Boolean).join(' ');
}

/**
 * The pairs that have to contrast, as painted. An element with opacity below
 * 1 is painted as a group onto what lies under it: the message and Undo onto
 * the toast, the toast onto the page. An opaque toast is judged on itself. A
 * translucent one (Modern's glass, or any opacity below 1) is judged over the
 * popup background it sits on, and also over pure white and pure black:
 * whatever scrolls under the blurred glass lies between those two, so passing
 * both, with text on the same side of the surface in both, passes every
 * backdrop.
 */
function look(rules, theme, scheme, state, bodyClasses = [], scenario = '') {
  const c = toastChain(rules, theme, scheme, state, bodyClasses);
  const problems = [];
  const where = describeCase(theme, scheme, bodyClasses, state, scenario);
  for (const [prop, plain, keys] of UNJUDGEABLE) {
    for (const k of keys) if (c[k].raw[prop] !== plain) problems.push(where + ': ' + NODE_NAMES[k] + ' has ' + prop + ': ' + c[k].raw[prop] + ', which this test cannot judge');
  }
  const own = (k) => alpha(c[k].raw.opacity);
  const group = own('html') * own('body') * own('toast');
  const toastBg = c.toast['background-color'];
  const popupBg = over(c.body['background-color'], over(c.html['background-color'], WHITE));
  const translucent = toastBg.a < 1 || group < 1;
  const underline = c.undo.raw['text-decoration-line'].split(/\s+/).includes('underline');
  const ring = !['none', 'hidden', 'auto'].includes(c.undo.raw['outline-style']) && widthPx(c.undo.raw['outline-width']) !== 0;
  const seen = (backdrop) => {
    const bg = over(toastBg, backdrop);
    const spanBg = over(c.span['background-color'], bg);
    const undoBg = over(c.undo['background-color'], bg);
    const page = (x) => blend(x, backdrop, group);
    const inSpan = (x) => blend(x, bg, own('span'));
    const inUndo = (x) => blend(x, bg, own('undo'));
    return {
      bg: page(bg),
      spanBg: page(inSpan(spanBg)),
      undoBg: page(inUndo(undoBg)),
      text: page(inSpan(over(c.span.color, spanBg))),
      undo: page(inUndo(over(c.undo.color, undoBg))),
      deco: page(inUndo(over(c.undo['text-decoration-color'], undoBg))),
      ring: page(inUndo(over(c.undo['outline-color'], bg))),
    };
  };
  const backdrops = translucent ? [['the popup background', popupBg], ['white', WHITE], ['black', BLACK]] : [['', popupBg]];
  const views = backdrops.map(([name, b]) => ({ name, ...seen(b) }));
  const pairs = [
    ['toast text', 'text', 'spanBg', AA_TEXT, true],
    ['Undo text', 'undo', 'undoBg', AA_TEXT, true],
    ['Undo underline', 'deco', 'undoBg', AA_NON_TEXT, underline],
    // Wherever an outline is drawn; the browser's own auto ring is left out.
    ['Undo focus ring', 'ring', 'bg', AA_NON_TEXT, ring],
  ];
  const ratios = {};
  for (const [label, fg, bg, min, applies] of pairs) {
    if (!applies) continue;
    for (const v of views) {
      const r = contrast(v[fg], v[bg]);
      ratios[label + (v.name ? ' over ' + v.name : '')] = r;
      if (r < min) problems.push(where + ': ' + label + ' ' + hex(v[fg]) + ' on ' + hex(v[bg]) + (v.name ? ' (over ' + v.name + ')' : '') + ' is ' + r.toFixed(2) + ':1, needs ' + min + ':1');
    }
    if (translucent) {
      const side = (v) => Math.sign(luminance(v[fg]) - luminance(v[bg]));
      if (side(views[1]) !== side(views[2])) problems.push(where + ': ' + label + ' is lighter than the glass over one backdrop and darker over another, so some backdrop in between makes it vanish');
    }
  }
  return { c, problems, ratios, translucent };
}

/** Every problem for one theme and scheme, over every scenario, body class
 *  set and state. */
function problemsIn(scens, theme, scheme) {
  const problems = [];
  for (const sc of scens) for (const set of BODY_SETS) for (const state of STATES) problems.push(...look(sc.rules, theme, scheme, state, set, sc.name).problems);
  return problems;
}

/** Undo has to read as a control by more than its colour: underlined at
 *  rest, changed on hover, ringed on keyboard focus. */
function cueProblems(scens, theme, scheme) {
  const problems = [];
  const looks = (u) => JSON.stringify([
    u.raw['text-decoration-line'], u.raw['text-decoration-thickness'], u.raw['outline-style'], u.raw['outline-width'],
    hex(u.color), hex(u['background-color']), u['background-color'].a, hex(u['text-decoration-color']),
    alpha(u.raw.opacity), u.raw.filter, u.raw['text-underline-offset'],
  ]);
  for (const sc of scens) {
    for (const set of BODY_SETS) {
      const at = (state) => toastChain(sc.rules, theme, scheme, state, set).undo;
      const rest = at('rest'), hover = at('hover'), focus = at('focus-visible');
      const where = describeCase(theme, scheme, set, '', sc.name);
      if (!rest.raw['text-decoration-line'].split(/\s+/).includes('underline')) problems.push(where + ': not underlined at rest');
      if (looks(rest) === looks(hover)) problems.push(where + ': hover looks the same as rest');
      if (['none', 'hidden'].includes(focus.raw['outline-style']) || !(widthPx(focus.raw['outline-width']) > 0)) problems.push(where + ': no focus ring on :focus-visible');
    }
  }
  return problems;
}

/** A failure message short enough to read: how many, and the first few. */
function report(problems) {
  if (!problems.length) return '';
  return problems.length + ' problem(s), the first ' + Math.min(12, problems.length) + ':\n' + problems.slice(0, 12).join('\n');
}

const STYLESHEETS = linkedStylesheets();
const SHEET = loadSheet(STYLESHEETS.map((href) => read('popup', ...href.split('/'))));
const SCENARIOS = scenarios(SHEET);
const RULES = SCENARIOS[0].rules;
const THEMES = optionValues('theme-select');
const SCHEMES = ['light', 'dark'];
const CASES = THEMES.flatMap((t) => SCHEMES.map((s) => [t + ' ' + s, t, s]));

// ---------------------------------------------------------------------------

describe('the cascade this test runs', () => {
  const FIXTURE = loadSheet([`
    :root { --a: #101010; --b: var(--a); --glass: rgba(255, 255, 255, .5); }
    body[data-color-scheme="dark"] { --a: #F0F0F0; }
    [data-theme="t"] { --a: #202020; }
    [data-theme="t"][data-color-scheme="dark"] { --a: #E0E0E0; }
    .toast { background: var(--a); color: var(--missing, white); }
    [data-theme="late"] .toast { background: var(--b); }
    .toast-undo { background: none; color: inherit; text-decoration: underline #123456 2px; }
    [data-theme="t"] .toast-undo:hover { color: #00FF00 !important; }
    .toast .toast-undo:hover { color: #FF0000; }
    [data-theme="g"] .toast { background: color-mix(in srgb, var(--glass) 100%, transparent); }
  `]).rules;
  // A dark toast with a readable Undo, for the cases below to break.
  const BASE = '.toast { background: #000000; color: #FFFFFF; } .toast-undo { background: none; color: inherit; text-decoration: underline; } .toast-undo:hover { text-decoration-thickness: 2px; } ';
  const judge = (css) => problemsIn(scenarios(loadSheet([BASE + css])), 'x', 'light');
  const all = (css) => judge(css).join('\n');

  it('reads theme tokens off body, the dark block over the light one', () => {
    expect(hex(toastChain(FIXTURE, 'classic', 'light', 'rest').toast['background-color'])).toBe('#101010');
    expect(hex(toastChain(FIXTURE, 'classic', 'dark', 'rest').toast['background-color'])).toBe('#F0F0F0');
    expect(hex(toastChain(FIXTURE, 't', 'light', 'rest').toast['background-color'])).toBe('#202020');
    // [data-theme][data-color-scheme] (0,2,0) beats body[data-color-scheme] (0,1,1).
    expect(hex(toastChain(FIXTURE, 't', 'dark', 'rest').toast['background-color'])).toBe('#E0E0E0');
  });

  it('substitutes a token where it is declared, as the browser does', () => {
    // --b is var(--a) taken on :root; body redefining --a does not reach it.
    expect(hex(toastChain(FIXTURE, 'late', 'dark', 'rest').toast['background-color'])).toBe('#101010');
  });

  it('resolves fallbacks, inherit, shorthands, !important and pseudo states', () => {
    const rest = toastChain(FIXTURE, 't', 'light', 'rest');
    expect(hex(rest.undo.color)).toBe('#FFFFFF');
    expect(rest.undo['background-color'].a).toBe(0);
    expect(rest.undo.raw['text-decoration-line']).toBe('underline');
    expect(rest.undo.raw['text-decoration-thickness']).toBe('2px');
    expect(hex(rest.undo['text-decoration-color'])).toBe('#123456');
    expect(hex(toastChain(FIXTURE, 't', 'light', 'hover').undo.color)).toBe('#00FF00');
    expect(hex(toastChain(FIXTURE, 'classic', 'light', 'hover').undo.color)).toBe('#FF0000');
    expect(toastChain(FIXTURE, 'g', 'light', 'rest').toast['background-color'].a).toBeCloseTo(0.5, 5);
  });

  it('gives a button with no colour of its own the browser default, not the toast text', () => {
    // A button does not inherit color; left alone it is dark on a dark toast.
    const bare = loadSheet(['.toast { background: #000000; color: #FFFFFF; } .toast-undo { background: none; }']).rules;
    expect(hex(toastChain(bare, 'x', 'light', 'rest').undo.color)).toBe('#000000');
    expect(look(bare, 'x', 'light', 'rest').problems.join('\n')).toContain('Undo text #000000 on #000000');
  });

  it('starts from a readable fixture, so the cases below fail for their own reason', () => {
    expect(report(judge(''))).toBe('');
  });

  it('paints the button with its own opacity, and stops at a filter it cannot judge', () => {
    // White at 30% over black is #4D4D4D, 2.46:1.
    expect(all('.toast-undo { opacity: .3; }')).toContain('x light rest: Undo text #4D4D4D on #000000 is 2.46:1');
    expect(all('.toast-undo:hover { opacity: 30%; }')).toContain('x light hover: Undo text #4D4D4D');
    expect(all('.toast-undo { filter: opacity(.3); }')).toContain('Undo has filter: opacity(.3), which this test cannot judge');
    expect(all('.toast { mix-blend-mode: difference; }')).toContain('the toast has mix-blend-mode: difference');
  });

  it('counts a change of opacity or underline offset on hover as a hover cue, and no change as none', () => {
    const cues = (hover) => {
      const scens = scenarios(loadSheet(['.toast { background: #000000; color: #FFFFFF; } .toast-undo { background: none; color: inherit; text-decoration: underline; } .toast-undo:hover { ' + hover + ' } .toast-undo:focus-visible { outline: 2px solid; }']));
      return report(cueProblems(scens, 'x', 'light')) + report(problemsIn(scens, 'x', 'light'));
    };
    expect(cues('opacity: .8;')).toBe('');
    expect(cues('text-underline-offset: 4px;')).toBe('');
    expect(cues('opacity: 1;')).toContain('x light: hover looks the same as rest');
  });

  it('tries every class set the popup puts on body', () => {
    expect(BODY_SETS).toHaveLength(48);
    const out = all('body.standalone.density-compact .toast-undo { color: #333333; }');
    expect(out).toContain('x light body.standalone.density-compact rest: Undo text #333333');
    expect(out).not.toContain('x light rest:');
  });

  it('tries the pointer on the message, a held press and mouse focus, not just hover and keyboard focus', () => {
    expect(STATES).toHaveLength(18);
    expect(all('.toast-undo:active { color: #333333; }')).toContain('x light hover+active: Undo text #333333');
    expect(all('.toast-undo:focus:not(:focus-visible) { color: #333333; }')).toContain('x light focus: Undo text #333333');
    expect(all('.toast:hover .toast-undo:not(:hover) { color: #333333; }')).toContain('x light hover-message: Undo text #333333');
    // An outline drawn on mouse focus has to contrast as well.
    expect(all('.toast-undo:focus { outline: 2px solid #111111; }')).toContain('x light focus: Undo focus ring #111111');
  });

  it('tries rules inside @media both ways, so a fix that holds only under a condition fails', () => {
    const fixOnlyUnder = (cond) => all('.toast-undo { color: #333333; } @media ' + cond + ' { .toast-undo { color: inherit; } }');
    expect(fixOnlyUnder('(max-width: 1px)')).toContain('x light rest (without any @media / @supports block): Undo text #333333');
    expect(fixOnlyUnder('(prefers-reduced-motion: no-preference)')).toContain('(without any @media / @supports block)');
    expect(fixOnlyUnder('(max-width: 1px)')).not.toContain('(with only @media');
    expect(all('@media (prefers-color-scheme: dark) { .toast-undo { color: #333333; } }')).toContain('(with only @media (prefers-color-scheme: dark)): Undo text #333333');
    // A block that never reaches the toast adds no scenario.
    expect(scenarios(loadSheet([BASE + '@media (min-width: 1px) { .other { color: red; } }']))).toHaveLength(1);
  });

  it('stops at what it does not model instead of guessing', () => {
    expect(() => loadSheet(['@layer base { .toast-undo { color: red; } }'])).toThrow(/@layer/);
    expect(() => judge('.toast:has(.toast-undo:hover) .toast-undo { color: #333333; }')).toThrow(/:has/);
    expect(() => judge('body:last-child .toast-undo { color: #333333; }')).toThrow(/last-child/);
  });
});

describe('the toast Undo action, in every theme and colour scheme', () => {
  it('walks every theme the options page offers, and popup.css styles no other', () => {
    expect(THEMES).toContain('classic');
    expect(THEMES.length).toBeGreaterThanOrEqual(19);
    const styled = new Set([...CSS.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/\[data-theme="([^"]+)"\]/g)].map((m) => m[1]));
    for (const t of styled) expect(THEMES, t).toContain(t);
  });

  it('reads every stylesheet popup.html links', () => {
    expect(STYLESHEETS).toContain('popup.css');
    expect(STYLESHEETS.length).toBeGreaterThanOrEqual(2);
    expect(RULES.some((r) => r.selectors.some((s) => s.text === '.toast-undo'))).toBe(true);
  });

  it('covers every class and attribute the popup puts on body, and nothing on html', () => {
    const w = bodyWritesInScripts();
    expect(w.classes).toContain('standalone');
    const known = BODY_CLASS_GROUPS.flat();
    for (const c of w.classes) expect(known, c).toContain(c);
    for (const d of w.dynamic) expect(d, 'a body class this test cannot read').toMatch(/: 'density-' \+ /);
    expect([...new Set(w.attrs)].sort()).toEqual(['data-color-scheme', 'data-theme']);
    expect(w.other).toEqual([]);
  });

  it.each(CASES)('%s: Undo and the toast text read at AA, at rest, under the pointer, pressed and focused', (_, theme, scheme) => {
    expect(report(problemsIn(SCENARIOS, theme, scheme))).toBe('');
  });

  it('marks Undo as an action by more than its colour: underlined, changed on hover, ringed on focus', () => {
    // Undo shares the toast text colour, so the underline is what says it is
    // a control (WCAG 1.4.1); hover and keyboard focus each need a visible cue.
    const problems = CASES.flatMap(([, theme, scheme]) => cueProblems(SCENARIOS, theme, scheme));
    expect(report(problems)).toBe('');
  });
});
