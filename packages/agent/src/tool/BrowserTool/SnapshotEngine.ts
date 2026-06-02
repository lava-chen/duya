/**
 * SnapshotEngine - DOM snapshot generation for LLM consumption
 * Inspired by OpenCLI's 13-layer pruning pipeline
 * Generates token-efficient, LLM-friendly page representation
 */

import type { ICDPClient } from './CDPClient.js';

// ─── Types ─────────────────────────────────────────────────────────────────

export interface SnapshotOptions {
  maxLength?: number;
  includeImages?: boolean;
  includeHidden?: boolean;
  interactiveOnly?: boolean;
  /** Extra pixels beyond viewport to include (default 800) */
  viewportExpand?: number;
  /** Maximum DOM depth to traverse (default 50) */
  maxDepth?: number;
  /** Maximum text content length per node (default 120) */
  maxTextLength?: number;
  /** Enable bounding-box parent-child dedup (default true) */
  bboxDedup?: boolean;
  /** Report hidden interactive elements outside viewport (default true) */
  reportHidden?: boolean;
  /** Filter ad/noise elements (default true) */
  filterAds?: boolean;
  /** Serialize tables as markdown (default true) */
  markdownTables?: boolean;
  /** Previous snapshot hash set for diff marking */
  previousHashes?: string | null;
}

export interface SnapshotResult {
  url: string;
  title: string;
  snapshot: string;
  interactiveElements: InteractiveElement[];
  truncated: boolean;
}

export interface InteractiveElement {
  ref: number;
  tag: string;
  type?: string;
  text: string;
  ariaLabel?: string;
  selector: string;
  bounds?: { x: number; y: number; width: number; height: number };
}

// ─── Config Defaults ────────────────────────────────────────────────────────

const DEFAULT_VIEWPORT_EXPAND = 800;
const DEFAULT_MAX_DEPTH = 50;
const DEFAULT_MAX_TEXT_LENGTH = 120;

// ─── Utility JS Generators ──────────────────────────────────────────────────

/**
 * Generate JS to scroll to an element identified by data-opencli-ref.
 */
export function scrollToRefJs(ref: string): string {
  const safeRef = JSON.stringify(ref);
  return `
    (() => {
      const ref = ${safeRef};
      const el = document.querySelector('[data-opencli-ref="' + ref + '"]')
        || document.querySelector('[data-ref="' + ref + '"]');
      if (!el) throw new Error('Element not found: ref=' + ref);
      el.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'nearest' });
      return { scrolled: true, tag: el.tagName.toLowerCase(), text: (el.textContent || '').trim().slice(0, 80) };
    })()
  `.trim();
}

/**
 * Generate JS to extract all form field values from the page.
 */
export function getFormStateJs(): string {
  return `
    (() => {
      const result = { forms: [], orphanFields: [] };

      for (const form of document.forms) {
        const formData = {
          id: form.id || null,
          name: form.name || null,
          action: form.action || null,
          method: (form.method || 'get').toUpperCase(),
          fields: [],
        };
        for (const el of form.elements) {
          const field = extractField(el);
          if (field) formData.fields.push(field);
        }
        if (formData.fields.length > 0) result.forms.push(formData);
      }

      const allInputs = document.querySelectorAll('input, textarea, select, [contenteditable="true"]');
      for (const el of allInputs) {
        if (el.form) continue;
        const field = extractField(el);
        if (field) result.orphanFields.push(field);
      }

      function extractField(el) {
        const tag = el.tagName.toLowerCase();
        const type = (el.getAttribute('type') || (tag === 'textarea' ? 'textarea' : tag === 'select' ? 'select' : 'text')).toLowerCase();
        if (type === 'hidden' || type === 'submit' || type === 'button' || type === 'reset') return null;
        const name = el.name || el.id || null;
        const ref = el.getAttribute('data-opencli-ref') || null;
        const label = findLabel(el);
        let value;
        if (tag === 'select') {
          const opt = el.options?.[el.selectedIndex];
          value = opt ? opt.textContent.trim() : '';
        } else if (type === 'checkbox' || type === 'radio') {
          value = el.checked;
        } else if (type === 'password') {
          value = el.value ? '••••' : '';
        } else if (el.isContentEditable) {
          value = (el.textContent || '').trim().slice(0, 200);
        } else {
          value = (el.value || '').slice(0, 200);
        }
        return { tag, type, name, ref, label, value, required: el.required || false, disabled: el.disabled || false };
      }

      function findLabel(el) {
        if (el.getAttribute('aria-label')) return el.getAttribute('aria-label');
        if (el.id) {
          const label = document.querySelector('label[for="' + el.id + '"]');
          if (label) return label.textContent.trim().slice(0, 80);
        }
        const parentLabel = el.closest('label');
        if (parentLabel) return parentLabel.textContent.trim().slice(0, 80);
        return el.placeholder || null;
      }

      return result;
    })()
  `.trim();
}

// ─── Main Snapshot JS Generator ────────────────────────────────────────────

/**
 * Generate JavaScript code that returns a pruned DOM snapshot string.
 * Output format:
 *   [42]<button type=submit>Search</button>
 *   |scroll|<div> (0.5↑ 3.2↓)
 *     *[58]<a href=/r/1>Result 1</a>
 */
export function generateSnapshotJsPrompt(opts: SnapshotOptions = {}): string {
  const viewportExpand = opts.viewportExpand ?? DEFAULT_VIEWPORT_EXPAND;
  const maxDepth = Math.max(1, Math.min(opts.maxDepth ?? DEFAULT_MAX_DEPTH, 200));
  const interactiveOnly = opts.interactiveOnly ?? false;
  const maxTextLength = opts.maxTextLength ?? DEFAULT_MAX_TEXT_LENGTH;
  const bboxDedup = opts.bboxDedup ?? true;
  const reportHidden = opts.reportHidden ?? true;
  const filterAds = opts.filterAds ?? true;
  const markdownTables = opts.markdownTables ?? true;
  const previousHashes = opts.previousHashes ?? null;

  return `
(() => {
  try {
  'use strict';

  // ── Config ─────────────────────────────────────────────────────────
  const VIEWPORT_EXPAND = ${viewportExpand};
  const MAX_DEPTH = ${maxDepth};
  const INTERACTIVE_ONLY = ${interactiveOnly};
  const MAX_TEXT_LEN = ${maxTextLength};
  const BBOX_DEDUP = ${bboxDedup};
  const REPORT_HIDDEN = ${reportHidden};
  const FILTER_ADS = ${filterAds};
  const MARKDOWN_TABLES = ${markdownTables};
  const PREV_HASHES = ${previousHashes ? `new Set(${previousHashes})` : 'null'};

  // ── Constants ──────────────────────────────────────────────────────

  const SKIP_TAGS = new Set([
    'script', 'style', 'noscript', 'link', 'meta', 'head',
    'template', 'br', 'wbr', 'col', 'colgroup',
  ]);

  const SVG_CHILDREN = new Set([
    'path', 'rect', 'g', 'circle', 'ellipse', 'line', 'polyline',
    'polygon', 'use', 'defs', 'clippath', 'mask', 'pattern',
    'text', 'tspan', 'lineargradient', 'radialgradient', 'stop',
    'filter', 'fegaussianblur', 'fecolormatrix', 'feblend',
    'symbol', 'marker', 'foreignobject', 'desc', 'title',
  ]);

  const INTERACTIVE_TAGS = new Set([
    'a', 'button', 'input', 'select', 'textarea', 'details',
    'summary', 'option', 'optgroup',
  ]);

  const INTERACTIVE_ROLES = new Set([
    'button', 'link', 'menuitem', 'option', 'radio', 'checkbox',
    'tab', 'textbox', 'combobox', 'slider', 'spinbutton',
    'searchbox', 'switch', 'menuitemcheckbox', 'menuitemradio',
    'treeitem', 'gridcell', 'row',
  ]);

  const LANDMARK_ROLES = new Set([
    'main', 'navigation', 'banner', 'search', 'region',
    'complementary', 'contentinfo', 'form', 'dialog',
  ]);

  const LANDMARK_TAGS = new Set([
    'nav', 'main', 'header', 'footer', 'aside', 'form',
    'search', 'dialog', 'section', 'article',
  ]);

  const ATTR_WHITELIST = new Set([
    'id', 'name', 'type', 'value', 'placeholder', 'title', 'alt',
    'role', 'aria-label', 'aria-expanded', 'aria-checked', 'aria-selected',
    'aria-disabled', 'aria-valuemin', 'aria-valuemax', 'aria-valuenow',
    'aria-haspopup', 'aria-live', 'aria-required',
    'href', 'src', 'action', 'method', 'for', 'checked', 'selected',
    'disabled', 'required', 'multiple', 'accept', 'min', 'max',
    'pattern', 'maxlength', 'minlength', 'data-testid', 'data-test',
    'contenteditable', 'tabindex', 'autocomplete',
  ]);

  const PROPAGATING_TAGS = new Set(['a', 'button']);
  const PROPAGATING_ROLES = new Set(['button', 'link', 'menuitem', 'tab', 'option']);

  function isBboxPropagator(el, tag) {
    if (PROPAGATING_TAGS.has(tag)) return true;
    const role = el.getAttribute('role');
    return !!(role && PROPAGATING_ROLES.has(role));
  }

  function isDistinctivelyInteractive(el) {
    if (el.hasAttribute('aria-label')) return true;
    if (el.hasAttribute('aria-labelledby')) return true;
    if (el.id) return true;
    if (el.getAttribute('data-testid') || el.getAttribute('data-test')) return true;
    if (el.hasAttribute('name')) return true;
    const tag = el.tagName.toLowerCase();
    if (tag === 'input' || tag === 'select' || tag === 'textarea') return true;
    if (tag === 'a' && el.hasAttribute('href')) return true;
    return false;
  }

  const AD_PATTERNS = [
    'googleadservices.com', 'doubleclick.net', 'googlesyndication.com',
    'facebook.com/tr', 'analytics.google.com', 'connect.facebook.net',
    'ad.doubleclick', 'pagead', 'adsense',
  ];

  const AD_SELECTOR_RE = /\\b(ad[_-]?(?:banner|container|wrapper|slot|unit|block|frame|leaderboard|sidebar)|google[_-]?ad|sponsored|adsbygoogle|banner[_-]?ad)\\b/i;

  const SEARCH_INDICATORS = new Set([
    'search', 'magnify', 'glass', 'lookup', 'find', 'query',
    'search-icon', 'search-btn', 'search-button', 'searchbox',
    'fa-search', 'icon-search', 'btn-search',
  ]);

  // ── Viewport & Layout Helpers ──────────────────────────────────────

  const vw = window.innerWidth;
  const vh = window.innerHeight;

  function isInExpandedViewport(rect) {
    if (!rect || (rect.width === 0 && rect.height === 0)) return false;
    return rect.bottom > -VIEWPORT_EXPAND && rect.top < vh + VIEWPORT_EXPAND &&
           rect.right > -VIEWPORT_EXPAND && rect.left < vw + VIEWPORT_EXPAND;
  }

  function isVisibleByCSS(el) {
    const style = el.style;
    if (style.display === 'none') return false;
    if (style.visibility === 'hidden' || style.visibility === 'collapse') return false;
    if (style.opacity === '0') return false;
    try {
      const cs = window.getComputedStyle(el);
      if (cs.display === 'none') return false;
      if (cs.visibility === 'hidden') return false;
      if (parseFloat(cs.opacity) <= 0) return false;
      if (cs.clip === 'rect(0px, 0px, 0px, 0px)' && cs.position === 'absolute') return false;
      if (cs.overflow === 'hidden' && el.offsetWidth === 0 && el.offsetHeight === 0) return false;
    } catch {}
    return true;
  }

  // ── Paint Order Occlusion ──────────────────────────────────────────

  function isOccludedByOverlay(el) {
    try {
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return false;
      const cx = rect.left + rect.width / 2;
      const cy = rect.top + rect.height / 2;
      if (cx < 0 || cy < 0 || cx > vw || cy > vh) return false;
      const topEl = document.elementFromPoint(cx, cy);
      if (!topEl || topEl === el || el.contains(topEl) || topEl.contains(el)) return false;
      const cs = window.getComputedStyle(topEl);
      if (parseFloat(cs.opacity) < 0.5) return false;
      const bg = cs.backgroundColor;
      if (bg === 'rgba(0, 0, 0, 0)' || bg === 'transparent') return false;
      return true;
    } catch { return false; }
  }

  // ── Ad/Noise Detection ─────────────────────────────────────────────

  function isAdElement(el) {
    if (!FILTER_ADS) return false;
    try {
      const id = el.id || '';
      const cls = el.className || '';
      const testStr = id + ' ' + (typeof cls === 'string' ? cls : '');
      if (AD_SELECTOR_RE.test(testStr)) return true;
      if (el.tagName === 'IFRAME') {
        const src = el.src || '';
        for (const p of AD_PATTERNS) { if (src.includes(p)) return true; }
      }
      if (el.hasAttribute('data-ad') || el.hasAttribute('data-ad-slot') ||
          el.hasAttribute('data-adunit') || el.hasAttribute('data-google-query-id')) return true;
    } catch {}
    return false;
  }

  // ── Interactivity Detection ────────────────────────────────────────

  function hasFormControlDescendant(el, maxDepth = 2) {
    if (maxDepth <= 0) return false;
    for (const child of el.children || []) {
      const tag = child.tagName?.toLowerCase();
      if (tag === 'input' || tag === 'select' || tag === 'textarea') return true;
      if (hasFormControlDescendant(child, maxDepth - 1)) return true;
    }
    return false;
  }

  function isInteractive(el) {
    const tag = el.tagName.toLowerCase();
    if (INTERACTIVE_TAGS.has(tag)) {
      if (tag === 'label') {
        if (el.hasAttribute('for')) return false;
        if (hasFormControlDescendant(el, 2)) return true;
      }
      if (el.disabled && (tag === 'button' || tag === 'input')) return false;
      return true;
    }
    if (tag === 'span') {
      if (hasFormControlDescendant(el, 2)) return true;
    }
    const role = el.getAttribute('role');
    if (role && INTERACTIVE_ROLES.has(role)) return true;
    if (el.hasAttribute('onclick') || el.hasAttribute('onmousedown') || el.hasAttribute('ontouchstart')) return true;
    if (el.hasAttribute('tabindex') && el.getAttribute('tabindex') !== '-1') return true;
    if (hasFrameworkListener(el)) return true;
    try { if (window.getComputedStyle(el).cursor === 'pointer') return true; } catch {}
    if (el.isContentEditable && el.getAttribute('contenteditable') !== 'false') return true;
    if (isSearchElement(el)) return true;
    return false;
  }

  function hasFrameworkListener(el) {
    try {
      for (const key of Object.keys(el)) {
        if (key.startsWith('__reactProps$') || key.startsWith('__reactEvents$')) {
          const props = el[key];
          if (props && (props.onClick || props.onMouseDown || props.onPointerDown)) return true;
        }
      }
      if (el._vei && (el._vei.onClick || el._vei.click || el._vei.onMousedown)) return true;
      if (el.__vue__?.$listeners?.click) return true;
      if (el.hasAttribute('ng-reflect-click')) return true;
    } catch {}
    return false;
  }

  function isSearchElement(el) {
    const className = (typeof el.className === 'string' ? el.className : el.className?.baseVal || '').toLowerCase();
    const classes = className.split(/\\s+/).filter(Boolean);
    for (const cls of classes) {
      const cleaned = cls.replace(/[^a-z0-9-]/g, '');
      if (SEARCH_INDICATORS.has(cleaned)) return true;
    }
    const id = el.id?.toLowerCase() || '';
    const cleanedId = id.replace(/[^a-z0-9-]/g, '');
    if (SEARCH_INDICATORS.has(cleanedId)) return true;
    for (const attr of el.attributes || []) {
      if (attr.name.startsWith('data-')) {
        const value = attr.value.toLowerCase();
        for (const kw of SEARCH_INDICATORS) {
          if (value.includes(kw)) return true;
        }
      }
    }
    return false;
  }

  function isLandmark(el) {
    const role = el.getAttribute('role');
    if (role && LANDMARK_ROLES.has(role)) return true;
    return LANDMARK_TAGS.has(el.tagName.toLowerCase());
  }

  // ── Scrollability Detection ────────────────────────────────────────

  function getScrollInfo(el) {
    const sh = el.scrollHeight, ch = el.clientHeight;
    const sw = el.scrollWidth, cw = el.clientWidth;
    const isV = sh > ch + 5, isH = sw > cw + 5;
    if (!isV && !isH) return null;
    try {
      const cs = window.getComputedStyle(el);
      const scrollable = ['auto', 'scroll', 'overlay'];
      const tag = el.tagName.toLowerCase();
      const isBody = tag === 'body' || tag === 'html';
      if (isV && !isBody && !scrollable.includes(cs.overflowY)) return null;
      const info = {};
      if (isV) {
        const above = ch > 0 ? +(el.scrollTop / ch).toFixed(1) : 0;
        const below = ch > 0 ? +((sh - ch - el.scrollTop) / ch).toFixed(1) : 0;
        if (above > 0 || below > 0) info.v = { above, below };
      }
      if (isH && scrollable.includes(cs.overflowX)) {
        info.h = { pct: cw > 0 ? Math.round(el.scrollLeft / (sw - cw) * 100) : 0 };
      }
      return Object.keys(info).length > 0 ? info : null;
    } catch { return null; }
  }

  // ── BBox Containment Check ─────────────────────────────────────────

  function isContainedBy(childRect, parentRect, threshold) {
    if (!childRect || !parentRect) return false;
    const cArea = childRect.width * childRect.height;
    if (cArea === 0) return false;
    const xO = Math.max(0, Math.min(childRect.right, parentRect.right) - Math.max(childRect.left, parentRect.left));
    const yO = Math.max(0, Math.min(childRect.bottom, parentRect.bottom) - Math.max(childRect.top, parentRect.top));
    return (xO * yO) / cArea >= threshold;
  }

  // ── Text Helpers ───────────────────────────────────────────────────

  function getDirectText(el) {
    let text = '';
    for (const child = el.firstChild; child; child = child.nextSibling) {
      if (child.nodeType === 3) {
        const t = child.textContent.trim();
        if (t) text += (text ? ' ' : '') + t;
      }
    }
    return text;
  }

  function capText(s) {
    if (!s) return '';
    const t = s.replace(/\\s+/g, ' ').trim();
    return t.length > MAX_TEXT_LEN ? t.slice(0, MAX_TEXT_LEN) + '…' : t;
  }

  // ── Element Hashing (for incremental diff) ─────────────────────────

  function hashElement(el) {
    const tag = el.tagName || '';
    const id = el.id || '';
    const cls = (typeof el.className === 'string' ? el.className : '').slice(0, 50);
    const text = (el.textContent || '').trim().slice(0, 40);
    const s = tag + '|' + id + '|' + cls + '|' + text;
    let h = 0;
    for (let i = 0; i < s.length; i++) {
      h = ((h << 5) - h + s.charCodeAt(i)) | 0;
    }
    return '' + (h >>> 0);
  }

  // ── Attribute Serialization ────────────────────────────────────────

  function serializeAttrs(el) {
    const parts = [];
    for (const attr of el.attributes) {
      if (!ATTR_WHITELIST.has(attr.name)) continue;
      let val = attr.value.trim();
      if (!val) continue;
      if (val.length > 120) val = val.slice(0, 100) + '…';
      if (attr.name === 'type' && val.toLowerCase() === el.tagName.toLowerCase()) continue;
      if (attr.name === 'value' && el.getAttribute('type') === 'password') { parts.push('value=••••'); continue; }
      if (attr.name === 'href') {
        if (val.startsWith('javascript:')) continue;
        try {
          const u = new URL(val, location.origin);
          if (u.origin === location.origin) val = u.pathname + u.search + u.hash;
        } catch {}
      }
      parts.push(attr.name + '=' + val);
    }
    const tag = el.tagName;
    if (tag === 'INPUT') {
      const type = (el.getAttribute('type') || 'text').toLowerCase();
      const fmts = { 'date':'YYYY-MM-DD', 'time':'HH:MM', 'datetime-local':'YYYY-MM-DDTHH:MM', 'month':'YYYY-MM', 'week':'YYYY-W##' };
      if (fmts[type]) parts.push('format=' + fmts[type]);
      if (['text','email','tel','url','search','number','date','time','datetime-local','month','week'].includes(type)) {
        if (el.value && !parts.some(p => p.startsWith('value='))) parts.push('value=' + capText(el.value));
      }
      if (type === 'password' && el.value && !parts.some(p => p.startsWith('value='))) parts.push('value=••••');
      if ((type === 'checkbox' || type === 'radio') && el.checked && !parts.some(p => p.startsWith('checked'))) parts.push('checked');
      if (type === 'file' && el.files && el.files.length > 0) parts.push('files=' + Array.from(el.files).map(f => f.name).join(','));
    }
    if (tag === 'TEXTAREA' && el.value && !parts.some(p => p.startsWith('value='))) parts.push('value=' + capText(el.value));
    if (tag === 'SELECT') {
      const sel = el.options?.[el.selectedIndex];
      if (sel && !parts.some(p => p.startsWith('value='))) parts.push('value=' + capText(sel.textContent));
      const optEls = Array.from(el.options || []).slice(0, 6);
      if (optEls.length > 0) {
        const ot = optEls.map(o => capText(o.textContent).slice(0, 30));
        if (el.options.length > 6) ot.push('…' + (el.options.length - 6) + ' more');
        parts.push('options=[' + ot.join('|') + ']');
      }
    }
    return parts.join(' ');
  }

  function hasSemanticAttrs(el) {
    return !!(
      el.hasAttribute('role') ||
      el.hasAttribute('aria-label') ||
      el.hasAttribute('aria-labelledby') ||
      el.hasAttribute('data-testid') ||
      el.hasAttribute('data-test') ||
      el.id
    );
  }

  function isFlattenableContainer(tag, attrs, text, interactive, landmark, isScrollable, childLinesCount) {
    if (interactive || landmark || isScrollable) return false;
    if (text) return false;
    if (childLinesCount <= 0) return false;
    if (hasSemanticAttrs(attrs)) return false;
    // Keep non-generic structure nodes to preserve page map.
    if (!['div', 'span', 'section', 'article', 'main', 'header', 'footer', 'aside'].includes(tag)) return false;
    return true;
  }

  // ── Table → Markdown Serialization ─────────────────────────────────

  function serializeTable(table, depth) {
    if (!MARKDOWN_TABLES) return false;
    try {
      const rows = table.querySelectorAll('tr');
      if (rows.length === 0 || rows.length > 50) return false;
      const grid = [];
      let maxCols = 0;
      for (const row of rows) {
        const cells = [];
        for (const cell of row.querySelectorAll('th, td')) {
          let text = capText(cell.textContent || '');
          const links = cell.querySelectorAll('a[href]');
          if (links.length === 1 && text) {
            const href = links[0].getAttribute('href');
            if (href && !href.startsWith('javascript:')) {
              try {
                const u = new URL(href, location.origin);
                text = '[' + text + '](' + (u.origin === location.origin ? u.pathname + u.search : href) + ')';
              } catch { text = '[' + text + '](' + href + ')'; }
            }
          }
          cells.push(text || '');
        }
        if (cells.length > 0) {
          grid.push(cells);
          if (cells.length > maxCols) maxCols = cells.length;
        }
      }
      if (grid.length < 2 || maxCols === 0) return false;
      for (const row of grid) { while (row.length < maxCols) row.push(''); }
      const widths = [];
      for (let c = 0; c < maxCols; c++) {
        let w = 3;
        for (const row of grid) { if (row[c].length > w) w = Math.min(row[c].length, 40); }
        widths.push(w);
      }
      const indent = '  '.repeat(depth);
      const tableLines = [];
      tableLines.push(indent + '| ' + grid[0].map((c, i) => c.padEnd(widths[i])).join(' | ') + ' |');
      tableLines.push(indent + '| ' + widths.map(w => '-'.repeat(w)).join(' | ') + ' |');
      for (let r = 1; r < grid.length; r++) {
        tableLines.push(indent + '| ' + grid[r].map((c, i) => c.padEnd(widths[i])).join(' | ') + ' |');
      }
      return tableLines;
    } catch { return false; }
  }

  // ── Main Tree Walk ─────────────────────────────────────────────────

  let interactiveIndex = 0;
  const lines = [];
  const hiddenInteractives = [];
  const currentHashes = [];
  const refIdentity = {};
  const compoundInfos = {};
  let iframeCount = 0;
  let crossOriginIndex = 0;

  function walk(el, depth, parentPropagatingRect) {
    if (depth > MAX_DEPTH) return false;
    if (el.nodeType !== 1) return false;

    const tag = el.tagName.toLowerCase();
    if (SKIP_TAGS.has(tag)) return false;
    if (isAdElement(el)) return false;

    // SVG: emit tag, collapse children
    if (tag === 'svg') {
      const attrs = serializeAttrs(el);
      const interactive = isInteractive(el);
      let line = '  '.repeat(depth) + '- ';
      if (interactive) {
        interactiveIndex++;
        el.setAttribute('data-opencli-ref', '' + interactiveIndex);
        line += 'svg [ref=' + interactiveIndex + ']';
      } else {
        line += 'svg';
      }
      if (attrs) line += ' ' + attrs;
      lines.push(line);
      return interactive;
    }
    if (SVG_CHILDREN.has(tag)) return false;

    // Table: try markdown serialization
    if (tag === 'table' && MARKDOWN_TABLES) {
      const tableLines = serializeTable(el, depth);
      if (tableLines) {
        const indent = '  '.repeat(depth);
        lines.push(indent + '- |table|');
        for (const tl of tableLines) lines.push(tl);
        return false;
      }
    }

    // iframe handling
    if (tag === 'iframe' && iframeCount < 5) {
      return walkIframe(el, depth);
    }

    // Visibility check
    let rect;
    try { rect = el.getBoundingClientRect(); } catch { return false; }
    const hasArea = rect.width > 0 && rect.height > 0;
    if (hasArea && !isVisibleByCSS(el)) {
      if (!(tag === 'input' && el.type === 'file')) return false;
    }

    let interactive = isInteractive(el);

    // Viewport threshold pruning
    if (hasArea && !isInExpandedViewport(rect)) {
      if (interactive && REPORT_HIDDEN) {
        const scrollDist = rect.top > vh ? rect.top - vh : -rect.bottom;
        const pagesAway = Math.abs(scrollDist / vh).toFixed(1);
        const direction = rect.top > vh ? 'below' : 'above';
        const text = capText(getDirectText(el) || el.getAttribute('aria-label') || el.getAttribute('title') || '');
        hiddenInteractives.push({ tag, text, direction, pagesAway });
      }
      return false;
    }

    // Paint order occlusion
    if (interactive && hasArea && isOccludedByOverlay(el)) return false;

    const landmark = isLandmark(el);
    const scrollInfo = getScrollInfo(el);
    const isScrollable = scrollInfo !== null;

    // BBox dedup — tier 1 (non-interactive descendants, 0.95 threshold)
    let excludedByParent = false;
    if (BBOX_DEDUP && parentPropagatingRect && !interactive) {
      if (hasArea && isContainedBy(rect, parentPropagatingRect, 0.95)) {
        const hasSemantic = el.hasAttribute('aria-label') ||
          (el.getAttribute('role') && INTERACTIVE_ROLES.has(el.getAttribute('role')));
        if (!hasSemantic && !['input','select','textarea','label'].includes(tag)) {
          excludedByParent = true;
        }
      }
    }

    // BBox dedup — tier 2 (interactive descendants, 0.99 threshold)
    if (BBOX_DEDUP && parentPropagatingRect && interactive && hasArea) {
      if (isContainedBy(rect, parentPropagatingRect, 0.99) && !isDistinctivelyInteractive(el)) {
        interactive = false;
      }
    }

    let propagateRect = parentPropagatingRect;
    if (BBOX_DEDUP && hasArea && isBboxPropagator(el, tag)) propagateRect = rect;

    // Process children
    const origLen = lines.length;
    let hasInteractiveDescendant = false;

    for (const child of el.children) {
      const r = walk(child, depth + 1, propagateRect);
      if (r) hasInteractiveDescendant = true;
    }

    // Shadow DOM
    if (el.shadowRoot) {
      const shadowOrigLen = lines.length;
      for (const child of el.shadowRoot.children) {
        const r = walk(child, depth + 1, propagateRect);
        if (r) hasInteractiveDescendant = true;
      }
      if (lines.length > shadowOrigLen) {
        lines.splice(shadowOrigLen, 0, '  '.repeat(depth + 1) + '|shadow|');
      }
    }

    const childLinesCount = lines.length - origLen;
    const text = capText(getDirectText(el));

    // Decide whether to emit
    if (INTERACTIVE_ONLY && !interactive && !landmark && !hasInteractiveDescendant && !text) {
      lines.length = origLen;
      return false;
    }
    if (excludedByParent && !interactive && !isScrollable) return hasInteractiveDescendant;
    if (!interactive && !isScrollable && !text && childLinesCount === 0 && !landmark) return false;
    if (isFlattenableContainer(tag, el, text, interactive, landmark, isScrollable, childLinesCount)) {
      return hasInteractiveDescendant;
    }

    // ── Emit node (YAML outline) ─────────────────────────────────────
    const indent = '  '.repeat(depth);
    let line = indent + '- ';

    // Incremental diff: mark new elements with *
    if (PREV_HASHES) {
      const h = hashElement(el);
      currentHashes.push(h);
      if (!PREV_HASHES.has(h)) line += '*';
    } else {
      currentHashes.push(hashElement(el));
    }

    // Scroll marker (before tag)
    if (isScrollable) line += '|scroll| ';

    // Interactive index + data-ref
    if (interactive) {
      interactiveIndex++;
      el.setAttribute('data-opencli-ref', '' + interactiveIndex);
      refIdentity['' + interactiveIndex] = {
        tag: tag,
        role: el.getAttribute('role') || '',
        text: (el.textContent || '').trim().slice(0, 30),
        ariaLabel: el.getAttribute('aria-label') || '',
        id: el.id || '',
        testId: el.getAttribute('data-testid') || el.getAttribute('data-test') || '',
      };
      // Compound info for date/select/file
      const compound = compoundInfoOf(el);
      if (compound) compoundInfos['' + interactiveIndex] = compound;
    }

    // Tag name
    line += tag;

    // Ref marker (after tag name)
    if (interactive) line += ' [ref=' + interactiveIndex + ']';

    // Attributes
    const attrs = serializeAttrs(el);
    if (attrs) line += ' ' + attrs;

    // Suffix: text, scroll info, or container marker
    if (isScrollable && scrollInfo) {
      const parts = [];
      if (scrollInfo.v) parts.push(scrollInfo.v.above + '\u2191 ' + scrollInfo.v.below + '\u2193');
      if (scrollInfo.h) parts.push('h:' + scrollInfo.h.pct + '%');
      line += ' (' + parts.join(', ') + ')';
      if (childLinesCount > 0) line += ':';
    } else if (text && childLinesCount === 0) {
      line += ' "' + text.replace(/"/g, '').replace(/\\n/g, ' ') + '"';
    } else if (childLinesCount > 0) {
      line += ':';
    }

    lines.splice(origLen, 0, line);
    if (text && childLinesCount > 0) {
      lines.splice(origLen + 1, 0, indent + '  - text: "' + text.replace(/"/g, '').replace(/\\n/g, ' ') + '"');
    }

    return interactive || hasInteractiveDescendant;
  }

  // ── Compound Info (date/select/file) ───────────────────────────────

  function compoundInfoOf(el) {
    const tag = el.tagName.toLowerCase();
    const type = (el.getAttribute('type') || '').toLowerCase();

    if (tag === 'input' && ['date', 'time', 'datetime-local', 'month', 'week'].includes(type)) {
      const fmts = { 'date':'YYYY-MM-DD', 'time':'HH:MM', 'datetime-local':'YYYY-MM-DDTHH:MM', 'month':'YYYY-MM', 'week':'YYYY-W##' };
      return {
        control: type,
        format: fmts[type] || type,
        current: el.value || '',
        min: el.min || '',
        max: el.max || '',
      };
    }

    if (tag === 'select') {
      const options = Array.from(el.options).slice(0, 50);
      return {
        control: 'select',
        multiple: el.multiple || false,
        current: options[el.selectedIndex]?.textContent?.trim() || '',
        options: options.map(o => o.textContent?.trim() || ''),
        options_total: el.options.length,
      };
    }

    if (tag === 'input' && type === 'file') {
      return {
        control: 'file',
        multiple: el.multiple || false,
        accept: el.accept || '',
        current: el.files ? Array.from(el.files).map(f => f.name) : [],
      };
    }

    return null;
  }

  // ── iframe Processing ──────────────────────────────────────────────

  function walkIframe(el, depth) {
    const indent = '  '.repeat(depth);
    try {
      const doc = el.contentDocument;
      if (!doc || !doc.body) {
        const attrs = serializeAttrs(el);
        const frameLabel = '[F' + crossOriginIndex + ']';
        lines.push(indent + '- |iframe| ' + frameLabel + ' iframe' + (attrs ? ' ' + attrs : '') + ' (cross-origin)');
        crossOriginIndex++;
        return false;
      }
      iframeCount++;
      const attrs = serializeAttrs(el);
      lines.push(indent + '- |iframe| iframe' + (attrs ? ' ' + attrs : '') + ':');
      let has = false;
      for (const child = doc.body.firstChild; child; child = child.nextSibling) {
        if (child.nodeType === 1) {
          if (walk(child, depth + 1, null)) has = true;
        }
      }
      return has;
    } catch {
      const attrs = serializeAttrs(el);
      const frameLabel = '[F' + crossOriginIndex + ']';
      lines.push(indent + '- |iframe| ' + frameLabel + ' iframe' + (attrs ? ' ' + attrs : '') + ' (blocked)');
      crossOriginIndex++;
      return false;
    }
  }

  // ── Entry Point ────────────────────────────────────────────────────

  lines.push('url: ' + location.href);
  lines.push('title: ' + document.title);
  lines.push('viewport: ' + vw + 'x' + vh);
  const pageScrollInfo = getScrollInfo(document.documentElement) || getScrollInfo(document.body);
  if (pageScrollInfo && pageScrollInfo.v) {
    lines.push('page_scroll: ' + pageScrollInfo.v.above + '↑ ' + pageScrollInfo.v.below + '↓');
  }
  lines.push('---');

  const root = document.body || document.documentElement;
  if (root) walk(root, 0, null);

  // Hidden interactive elements hint
  if (REPORT_HIDDEN && hiddenInteractives.length > 0) {
    lines.push('---');
    lines.push('hidden (' + hiddenInteractives.length + '):');
    const shown = hiddenInteractives.slice(0, 10);
    for (const h of shown) {
      const label = h.text ? ' "' + h.text + '"' : '';
      lines.push('- ' + h.tag + label + ' ~' + h.pagesAway + ' pages ' + h.direction);
    }
    if (hiddenInteractives.length > 10) lines.push('- ...' + (hiddenInteractives.length - 10) + ' more');
  }

  // Compound sidecar
  const compoundRefs = Object.keys(compoundInfos);
  if (compoundRefs.length > 0) {
    lines.push('---');
    lines.push('compounds (' + compoundRefs.length + '):');
    compoundRefs.sort(function (a, b) { return parseInt(a, 10) - parseInt(b, 10); });
    for (const ref of compoundRefs) {
      try {
        lines.push('  [' + ref + '] ' + JSON.stringify(compoundInfos[ref]));
      } catch {}
    }
  }

  // Footer
  lines.push('---');
  lines.push('interactive: ' + interactiveIndex + ' | iframes: ' + iframeCount);

  // Store for next diff
  try { window.__opencli_prev_hashes = JSON.stringify(currentHashes); } catch {}
  try { window.__opencli_ref_identity = refIdentity; } catch {}

  return lines.join('\\n');
  } catch (_err) {
    return 'url: ' + (typeof location !== 'undefined' ? location.href : 'unknown') +
      '\\ntitle: ' + (typeof document !== 'undefined' ? document.title : 'unknown') +
      '\\n---\\nSnapshot generation failed: ' +
      (_err && _err.message ? _err.message : String(_err || 'unknown error'));
  }
})()
  `.trim();
}

// ─── SnapshotEngine Class ────────────────────────────────────────────────────

/**
 * SnapshotEngine - DOM snapshot generation for LLM consumption
 */
export class SnapshotEngine {
  private cdp: ICDPClient;
  private refCounter = 0;
  private refMap = new Map<number, string>();
  private prevHashes: string | null = null;

  // Constants for buildSnapshot (matching OpenCLI pruning)
  private static readonly SKIP_TAGS = new Set([
    'script', 'style', 'noscript', 'link', 'meta', 'head',
    'template', 'br', 'wbr', 'col', 'colgroup',
  ]);

  private static readonly SVG_CHILDREN = new Set([
    'path', 'rect', 'g', 'circle', 'ellipse', 'line', 'polyline',
    'polygon', 'use', 'defs', 'clippath', 'mask', 'pattern',
    'text', 'tspan', 'lineargradient', 'radialgradient', 'stop',
  ]);

  private static readonly AD_SELECTOR_RE = /(?:^|[\s"-])(ad[_-]?(?:banner|container|wrapper|slot|unit|block|frame)|sponsored|adsbygoogle)(?:[\s"-]|$)/i;

  private static readonly ATTR_WHITELIST = new Set([
    'id', 'name', 'type', 'value', 'placeholder', 'title', 'alt',
    'role', 'aria-label', 'aria-expanded', 'href', 'src', 'action',
    'for', 'checked', 'selected', 'disabled', 'required', 'multiple',
    'accept', 'min', 'max', 'pattern', 'maxlength', 'minlength',
    'data-testid', 'contenteditable', 'tabindex', 'autocomplete',
  ]);

  constructor(cdp: ICDPClient) {
    this.cdp = cdp;
  }

  /**
   * Capture full page snapshot with OpenCLI-style pruning
   */
  async capture(options: SnapshotOptions = {}): Promise<SnapshotResult> {
    const { maxLength = 100000, interactiveOnly = false } = options;

    const url = await this.cdp.getUrl();
    const title = await this.cdp.getTitle();

    // Generate OpenCLI-style snapshot JS
    const snapshotJs = generateSnapshotJsPrompt({
      ...options,
      interactiveOnly,
      previousHashes: this.prevHashes,
    });

    let snapshot: string | null = null;

    try {
      const result = await this.cdp.evaluate(snapshotJs);
      if (result && typeof result === 'string') {
        snapshot = result;
        // Store hashes for next diff
        try {
          const stored = await this.cdp.evaluate('window.__opencli_prev_hashes');
          if (typeof stored === 'string') {
            this.prevHashes = stored;
          }
        } catch { /* ignore */ }
      }
    } catch (error) {
      console.warn('[SnapshotEngine] OpenCLI-style snapshot failed at', url, ':',
        error instanceof Error ? error.message : String(error));
    }

    // Fallback: try CDP DOM.getDocument
    if (!snapshot || snapshot.trim().length < 100) {
      try {
        snapshot = await this.captureViaCDP(options);
      } catch (error) {
        console.warn('[SnapshotEngine] CDP fallback failed:', error instanceof Error ? error.message : error);
      }
    }

    // Fallback: try simple text extraction as last resort
    if (!snapshot || snapshot.trim().length < 50) {
      try {
        const textContent = await this.captureViaSimpleText();
        if (textContent) {
          snapshot = textContent;
        }
      } catch (error) {
        console.warn('[SnapshotEngine] Simple text fallback failed:', error instanceof Error ? error.message : error);
      }
    }

    // If all approaches failed, return minimal info so agent can still see context
    if (!snapshot || snapshot.trim().length < 50) {
      return {
        url,
        title,
        snapshot: `Unable to capture full DOM snapshot.\nURL: ${url}\nTitle: ${title}\n\nThe page is loaded but DOM access failed. Try a different action (e.g., screenshot or click).`,
        interactiveElements: [],
        truncated: false,
      };
    }

    // Extract interactive elements from ref identity
    const interactiveElements = await this.extractInteractiveElements();

    // Truncate if needed
    let finalSnapshot = snapshot;
    let truncated = false;
    if (snapshot.length > maxLength) {
      finalSnapshot = snapshot.slice(0, maxLength) + '\n\n[Snapshot truncated...]';
      truncated = true;
    }

    return {
      url,
      title,
      snapshot: finalSnapshot,
      interactiveElements,
      truncated,
    };
  }

  /**
   * Capture via CDP DOM.getDocument (fallback)
   */
  private async captureViaCDP(options: SnapshotOptions): Promise<string | null> {
    try {
      const domResult = await this.cdp.send('DOM.getDocument', {
        depth: -1,
        pierce: true,
      }) as { root?: DOMNode };

      if (domResult?.root) {
        this.refCounter = 0;
        this.refMap.clear();
        return this.buildSnapshot(domResult.root, {
          interactiveOnly: options.interactiveOnly ?? false,
          depth: 0,
        });
      }
    } catch { /* ignore */ }
    return null;
  }

  /**
   * Last-resort fallback: extract plain text content from the page
   */
  private async captureViaSimpleText(): Promise<string | null> {
    try {
      const result = await this.cdp.evaluate(`
        (function() {
          var body = document.body;
          if (!body) return 'Page body not available.';
          var text = body.innerText || body.textContent || '';
          var lines = text.split('\\n').filter(function(l) { return l.trim(); });
          if (lines.length > 200) {
            lines = lines.slice(0, 100).concat(['... (truncated ' + (lines.length - 100) + ' lines)'], lines.slice(-100));
          }
          return 'url: ' + location.href + '\\ntitle: ' + document.title + '\\n---\\n' + lines.join('\\n');
        })()
      `);
      if (typeof result === 'string' && result.trim().length > 20) {
        return result;
      }
    } catch { /* ignore */ }
    return null;
  }

  /**
   * Extract interactive elements from ref identity stored in window
   */
  private async extractInteractiveElements(): Promise<InteractiveElement[]> {
    try {
      const identity = await this.cdp.evaluate('window.__opencli_ref_identity || {}');
      if (identity && typeof identity === 'object') {
        return Object.entries(identity as Record<string, RefIdentity>).map(([ref, info]) => ({
          ref: parseInt(ref, 10),
          tag: info.tag,
          type: info.role || undefined,
          text: info.text || '',
          ariaLabel: info.ariaLabel || '',
          selector: info.id ? '#' + info.id : (info.testId ? '[data-testid="' + info.testId + '"]' : info.tag),
        }));
      }
    } catch { /* ignore */ }

    // Fallback: extract from DOM
    return this.extractInteractiveFromDOM();
  }

  /**
   * Fallback: extract interactive elements from DOM
   */
  private async extractInteractiveFromDOM(): Promise<InteractiveElement[]> {
    const script = `
      (function() {
        const elements = [];
        const interactiveTags = ['a', 'button', 'input', 'select', 'textarea'];
        const allElements = document.querySelectorAll('*');

        for (let i = 0; i < allElements.length; i++) {
          const el = allElements[i];
          const tag = el.tagName.toLowerCase();

          const isInteractive = interactiveTags.includes(tag) ||
                               el.getAttribute('role') === 'button' ||
                               el.getAttribute('role') === 'link' ||
                               el.onclick ||
                               (el.tabIndex && el.tabIndex >= 0);

          if (isInteractive) {
            const rect = el.getBoundingClientRect();
            if (rect.width > 0 && rect.height > 0) {
              elements.push({
                tag: tag,
                type: el.type || undefined,
                text: (el.textContent?.trim() || el.value?.trim() || el.placeholder || '').slice(0, 100),
                selector: el.id ? '#' + el.id :
                         (el.className ? tag + '.' + el.className.split(' ')[0] : tag)
              });
            }
          }
        }

        return elements.slice(0, 50);
      })()
    `;

    try {
      const result = await this.cdp.evaluate(script);
      if (Array.isArray(result)) {
        return result.map((el, index) => ({
          ref: index + 1,
          tag: el.tag || 'unknown',
          type: el.type,
          text: el.text || '',
          selector: el.selector || '',
        }));
      }
    } catch { /* ignore */ }
    return [];
  }

  /**
   * Build snapshot string from DOM node (CDP fallback, YAML outline format)
   */
  private buildSnapshot(
    node: DOMNode,
    options: {
      interactiveOnly: boolean;
      depth: number;
    }
  ): string {
    const { interactiveOnly, depth } = options;

    if (depth > 50) return '';

    if (['SCRIPT', 'STYLE', 'COMMENT', '#comment', 'LINK', 'META', 'HEAD', 'NOSCRIPT'].includes(node.nodeName)) {
      return '';
    }

    if (node.nodeName === '#document' || node.nodeName === 'HTML') {
      const children = node.children || [];
      let result = '';
      for (const child of children) {
        result += this.buildSnapshot(child, { ...options, depth });
      }
      return result;
    }

    const indent = '  '.repeat(depth);

    // Text node
    if (node.nodeName === '#text') {
      const text = node.nodeValue?.trim() || '';
      if (text) {
        const escaped = text.replace(/"/g, '').slice(0, 200);
        return `${indent}- text: "${escaped}"\n`;
      }
      return '';
    }

    const tag = node.nodeName.toLowerCase();

    if (SnapshotEngine.SVG_CHILDREN.has(tag) && tag !== 'foreignobject') {
      return '';
    }

    const attrs = this.buildAttributes(node);
    const id = node.attributes?.find(a => a.name === 'id')?.value || '';
    const className = node.attributes?.find(a => a.name === 'class')?.value || '';

    if (SnapshotEngine.AD_SELECTOR_RE.test(id + ' ' + className)) {
      return '';
    }

    const isInteractive = this.isInteractiveElement(node);
    const ref = isInteractive ? ++this.refCounter : null;

    if (isInteractive && ref !== null) {
      this.refMap.set(ref, this.buildSelector(node));
    }

    if (interactiveOnly && !isInteractive && !this.isContainerElement(node)) {
      return '';
    }

    const refStr = ref !== null ? ` [ref=${ref}]` : '';
    const attrsResult = this.buildWhitelistedAttrs(node);

    if (this.isVoidElement(node.nodeName)) {
      return `${indent}- ${tag}${refStr}${attrsResult}\n`;
    }

    const children = node.children || [];
    const textContent = this.getTextContent(node);
    const hasChildren = children.length > 0;
    const hasText = !!textContent.trim();

    if (!hasChildren) {
      if (hasText) {
        const truncated = textContent.trim().length > 200
          ? textContent.trim().slice(0, 200) + '...'
          : textContent.trim();
        const escaped = truncated.replace(/"/g, '');
        return `${indent}- ${tag} "${escaped}"${refStr}${attrsResult}\n`;
      }
      return `${indent}- ${tag}${refStr}${attrsResult}\n`;
    }

    let result = `${indent}- ${tag}${refStr}${attrsResult}:\n`;

    for (const child of children) {
      const childSnapshot = this.buildSnapshot(child, { ...options, depth: depth + 1 });
      if (childSnapshot) {
        result += childSnapshot;
      }
    }

    return result;
  }

  /**
   * Build attributes with whitelist filtering (OpenCLI style)
   */
  private buildWhitelistedAttrs(node: DOMNode): string {
    const whitelist = ['id', 'name', 'type', 'value', 'placeholder', 'title', 'alt',
      'role', 'aria-label', 'aria-expanded', 'href', 'src', 'action', 'method',
      'for', 'checked', 'selected', 'disabled', 'required', 'multiple',
      'accept', 'min', 'max', 'pattern', 'maxlength', 'minlength',
      'data-testid', 'contenteditable', 'tabindex', 'autocomplete'];

    const attrs: string[] = [];
    if (node.attributes) {
      for (const attr of node.attributes) {
        if (whitelist.includes(attr.name)) {
          const value = attr.value.slice(0, 200);
          if (attr.name === 'href' && !value.startsWith('#') && !value.startsWith('/')) {
            attrs.push(`${attr.name}="${value.slice(0, 50)}..."`);
          } else {
            attrs.push(`${attr.name}="${value}"`);
          }
        }
      }
    }
    return attrs.length > 0 ? ' ' + attrs.join(' ') : '';
  }

  /**
   * Check if element is interactive
   */
  private isInteractiveElement(node: DOMNode): boolean {
    const interactiveTags = ['A', 'BUTTON', 'INPUT', 'SELECT', 'TEXTAREA', 'DETAILS', 'SUMMARY', 'OPTION'];

    if (interactiveTags.includes(node.nodeName)) {
      // Check disabled state
      const disabled = node.attributes?.find(a => a.name === 'disabled');
      if (disabled) return false;
      return true;
    }

    const role = this.getAttribute(node, 'role');
    if (role && ['button', 'link', 'textbox', 'checkbox', 'radio', 'tab', 'menuitem',
        'combobox', 'searchbox', 'switch'].includes(role)) {
      return true;
    }

    if (this.getAttribute(node, 'onclick') || this.getAttribute(node, 'onkeydown')) {
      return true;
    }

    const tabindex = this.getAttribute(node, 'tabindex');
    if (tabindex && tabindex !== '-1') {
      return true;
    }

    return false;
  }

  /**
   * Check if element is a container
   */
  private isContainerElement(node: DOMNode): boolean {
    const containers = ['DIV', 'SECTION', 'ARTICLE', 'MAIN', 'NAV', 'HEADER', 'FOOTER', 'ASIDE', 'FORM'];
    return containers.includes(node.nodeName);
  }

  /**
   * Check if element is void (self-closing)
   */
  private isVoidElement(tagName: string): boolean {
    const voidElements = [
      'AREA', 'BASE', 'BR', 'COL', 'EMBED', 'HR', 'IMG', 'INPUT',
      'LINK', 'META', 'PARAM', 'SOURCE', 'TRACK', 'WBR',
    ];
    return voidElements.includes(tagName.toUpperCase());
  }

  /**
   * Build attribute string
   */
  private buildAttributes(node: DOMNode): string {
    const attrs: string[] = [];
    const importantAttrs = [
      'id', 'class', 'href', 'src', 'alt', 'title', 'placeholder',
      'type', 'name', 'value', 'checked', 'selected', 'disabled',
      'role', 'aria-label', 'data-testid',
    ];

    if (node.attributes) {
      for (const attr of node.attributes) {
        if (importantAttrs.includes(attr.name)) {
          attrs.push(`${attr.name}="${attr.value.slice(0, 100)}"`);
        }
      }
    }

    return attrs.length > 0 ? ' ' + attrs.join(' ') : '';
  }

  /**
   * Get text content from node
   */
  private getTextContent(node: DOMNode): string {
    if (node.nodeName === '#text') {
      return node.nodeValue || '';
    }

    // Skip style and script content (CSS/JS)
    if (['STYLE', 'SCRIPT', 'LINK', 'META'].includes(node.nodeName)) {
      return '';
    }

    let text = '';
    if (node.children) {
      for (const child of node.children) {
        text += this.getTextContent(child);
      }
    }

    return text;
  }

  /**
   * Get attribute value
   */
  private getAttribute(node: DOMNode, name: string): string | null {
    if (!node.attributes) return null;
    const attr = node.attributes.find(a => a.name === name);
    return attr ? attr.value : null;
  }

  /**
   * Build CSS selector for element
   */
  private buildSelector(node: DOMNode): string {
    const id = this.getAttribute(node, 'id');
    if (id) return `#${id}`;

    const dataTestId = this.getAttribute(node, 'data-testid');
    if (dataTestId) return `[data-testid="${dataTestId}"]`;

    const tag = node.nodeName.toLowerCase();
    const className = this.getAttribute(node, 'class');
    if (className) {
      const classes = className.split(' ').filter(c => c && !c.startsWith('_'));
      if (classes.length > 0) {
        return `${tag}.${classes.slice(0, 2).join('.')}`;
      }
    }

    return tag;
  }

  /**
   * Get selector for ref
   */
  getSelectorForRef(ref: number): string | undefined {
    return this.refMap.get(ref);
  }
}

// ─── Interfaces ───────────────────────────────────────────────────────────────

interface DOMNode {
  nodeId?: number;
  nodeName: string;
  nodeValue?: string;
  nodeType?: number;
  attributes?: Array<{ name: string; value: string }>;
  children?: DOMNode[];
  backendNodeId?: number;
}

interface RefIdentity {
  tag: string;
  role: string;
  text: string;
  ariaLabel: string;
  id: string;
  testId: string;
}

export default SnapshotEngine;
