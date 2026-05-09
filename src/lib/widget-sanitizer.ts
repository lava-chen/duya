const CDN_ALLOWLIST = [
  'cdnjs.cloudflare.com',
  'cdn.jsdelivr.net',
  'unpkg.com',
  'esm.sh',
];

const SCRIPT_SRC_ALLOWLIST = CDN_ALLOWLIST.map(domain => `https://${domain}`).join(' ');

const STRIP_TAGS_RE = /<\/(?:iframe|object|embed|form|meta|link|base|script)(?:\s[^>]*)?>/gi;
const STRIP_OPEN_TAGS_RE = /<(?:iframe|object|embed|form|meta|link|base|script)(?:\s[^>]*)?\/?>/gi;
const EVENT_HANDLER_RE = /\s+on\w+\s*=\s*"[^"]*"/gi;
const EVENT_HANDLER_SINGLE_RE = /\s+on\w+\s*=\s*'[^']*'/gi;
const JS_URL_RE = /\b(?:href|src|action)\s*=\s*["']\s*javascript\s*:/gi;
const DATA_URL_RE = /\b(?:href|src|action)\s*=\s*["']\s*data\s*:/gi;
const NESTED_SCRIPT_RE = /<script[\s\S]*?<\/script>/gi;

function stripTags(html: string): string {
  let result = html;
  result = result.replace(STRIP_OPEN_TAGS_RE, '');
  result = result.replace(STRIP_TAGS_RE, '');
  result = result.replace(EVENT_HANDLER_RE, '');
  result = result.replace(EVENT_HANDLER_SINGLE_RE, '');
  result = result.replace(JS_URL_RE, (match) => match.replace(/javascript\s*:/i, '#'));
  result = result.replace(DATA_URL_RE, (match) => match.replace(/data\s*:/i, '#'));
  return result;
}

export function sanitizeForStreaming(html: string): string {
  return stripTags(html);
}

export function sanitizeForIframe(html: string): string {
  let result = html;
  result = result.replace(NESTED_SCRIPT_RE, '');
  const stripped = stripTags(result);
  return stripped.replace(
    /<(?:iframe|object|embed)(?:\s[^>]*)?\/?>/gi,
    '<!-- blocked tag -->'
  );
}

export function escapeJsonString(str: string): string {
  return str
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t');
}

const RECEIVER_SCRIPT = /* js */ `
(function() {
  'use strict';

  function getPathLen(el) {
    var tag = el.tagName;
    if (tag === 'line') {
      var x1 = parseFloat(el.getAttribute('x1')) || 0;
      var y1 = parseFloat(el.getAttribute('y1')) || 0;
      var x2 = parseFloat(el.getAttribute('x2')) || 0;
      var y2 = parseFloat(el.getAttribute('y2')) || 0;
      return Math.sqrt((x2 - x1) * (x2 - x1) + (y2 - y1) * (y2 - y1));
    }
    if (tag === 'rect') {
      var w = parseFloat(el.getAttribute('width')) || 0;
      var h = parseFloat(el.getAttribute('height')) || 0;
      return 2 * w + 2 * h;
    }
    if (tag === 'circle') {
      var r = parseFloat(el.getAttribute('r')) || 0;
      return 2 * Math.PI * r;
    }
    if (tag === 'ellipse') {
      var rx = parseFloat(el.getAttribute('rx')) || 0;
      var ry = parseFloat(el.getAttribute('ry')) || 0;
      return Math.PI * (3 * (rx + ry) - Math.sqrt((3 * rx + ry) * (rx + 3 * ry)));
    }
    if (tag === 'path' || tag === 'polyline' || tag === 'polygon') {
      try {
        var len = el.getTotalLength();
        return len || 5000;
      } catch (e) {
        return 5000;
      }
    }
    return 5000;
  }

  function animateSvgDraw(svg) {
    if (!svg || svg.dataset.wdgAnimated) return;
    svg.dataset.wdgAnimated = '1';

    var drawables = [];
    var allEls = svg.querySelectorAll('rect, line, path, circle, ellipse, polyline, polygon, text');
    for (var i = 0; i < allEls.length; i++) {
      var el = allEls[i];
      if (el.closest('defs')) continue;
      if (el.closest('marker')) continue;
      if (el.closest('pattern')) continue;
      drawables.push(el);
    }

    var baseDelay = drawables.length > 60 ? 50 : 100;
    var drawDuration = drawables.length > 60 ? 300 : 450;

    for (var i = 0; i < drawables.length; i++) {
      var el = drawables[i];
      var delay = i * baseDelay;
      var isText = el.tagName === 'text' || el.tagName === 'tspan';

      if (isText) {
        el.style.opacity = '0';
        el.style.setProperty('--wdg-text-delay', delay + 'ms');
        el.style.setProperty('--wdg-text-dur', drawDuration + 'ms');
        el.classList.add('wg-fade-in');
      } else {
        var pathLen = getPathLen(el);
        el.style.strokeDasharray = pathLen;
        el.style.strokeDashoffset = pathLen;
        el.style.fillOpacity = '0';
        el.style.animation = 'wdg-draw ' + drawDuration + 'ms ease-out ' + delay + 'ms forwards, wdg-fill-in ' + drawDuration + 'ms ease-out ' + delay + 'ms forwards';
      }
    }

    var totalMs = drawables.length * baseDelay + drawDuration;
    setTimeout(function() {
      for (var i = 0; i < drawables.length; i++) {
        drawables[i].style.removeProperty('stroke-dasharray');
        drawables[i].style.removeProperty('stroke-dashoffset');
        drawables[i].style.removeProperty('fill-opacity');
        drawables[i].style.removeProperty('opacity');
        drawables[i].style.removeProperty('animation');
        drawables[i].classList.remove('wg-fade-in');
        drawables[i].style.removeProperty('--wdg-text-delay');
        drawables[i].style.removeProperty('--wdg-text-dur');
      }
      reportDrawHeight();
    }, totalMs + 200);
  }

  function setup() {
    var root = document.querySelector('.widget-root');
    if (!root) {
      root = document.createElement('div');
      root.className = 'widget-root';
      document.body.appendChild(root);
    }

    var ro = new ResizeObserver(function(entries) {
      for (var i = 0; i < entries.length; i++) {
        var h = entries[i].contentRect.height;
        if (h > 0) {
          window.parent.postMessage({ type: 'widget:resize', height: Math.ceil(h) }, '*');
        }
      }
    });
    ro.observe(document.documentElement);
    ro.observe(root);

    function reportHeight() {
      var h = Math.max(document.documentElement.scrollHeight, document.documentElement.offsetHeight, document.body.scrollHeight, document.body.offsetHeight);
      if (h > 0) {
        window.parent.postMessage({ type: 'widget:resize', height: Math.ceil(h) }, '*');
      }
    }
    window.reportDrawHeight = reportHeight;

    document.addEventListener('click', function(e) {
      var a = e.target.closest('a');
      if (a && a.href && a.target !== '_self') {
        e.preventDefault();
        window.parent.postMessage({ type: 'widget:link', href: a.href }, '*');
        return;
      }
      var btn = e.target.closest('[data-send-message]');
      if (btn) {
        var text = btn.getAttribute('data-send-message');
        if (text) {
          window.parent.postMessage({ type: 'widget:sendMessage', text: text }, '*');
        }
      }
    });

    window.addEventListener('message', function(e) {
      if (!e.data || !e.data.type) return;
      switch (e.data.type) {
        case 'widget:theme':
          if (e.data.theme === 'dark') {
            document.documentElement.style.colorScheme = 'dark';
          } else {
            document.documentElement.style.colorScheme = 'light';
          }
          break;
        case 'widget:update':
          root.innerHTML = e.data.content || '';
          reportHeight();
          break;
        case 'widget:finalize':
          document.open();
          document.write(e.data.srcdoc || '');
          document.close();
          break;
      }
    });

    window.addEventListener('load', reportHeight);
    reportHeight();

    var svgs = document.querySelectorAll('svg');
    for (var i = 0; i < svgs.length; i++) {
      animateSvgDraw(svgs[i]);
    }

    window.parent.postMessage({ type: 'widget:ready' }, '*');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', setup);
  } else {
    setup();
  }
})();
`;

const DRAW_CSS = /* css */ `
@keyframes wdg-draw {
  to { stroke-dashoffset: 0; }
}
@keyframes wdg-fill-in {
  0%, 65% { fill-opacity: 0; }
  100% { fill-opacity: 1; }
}
@keyframes wdg-fade-in-text {
  0%, 35% { opacity: 0; }
  100% { opacity: 1; }
}
.wg-fade-in {
  animation: wdg-fade-in-text var(--wdg-text-dur, 450ms) ease-out var(--wdg-text-delay, 0ms) forwards;
}
`;

export function buildReceiverSrcdoc(
  widgetCode: string,
  isStreaming: boolean,
  cssBridge: string,
): string {
  const sanitizedCode = isStreaming
    ? sanitizeForStreaming(widgetCode)
    : sanitizeForIframe(widgetCode);

  const visualHtml = sanitizedCode.replace(/<script[\s\S]*?<\/script>/gi, '');
  const scripts = sanitizedCode.match(/<script[^>]*>([\s\S]*?)<\/script>/gi)
    ?.map(s => s.replace(/<\/?script[^>]*>/gi, ''))
    .join('\n') || '';

  const animCss = isStreaming ? '' : DRAW_CSS;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="Content-Security-Policy" content="script-src 'unsafe-inline' ${SCRIPT_SRC_ALLOWLIST}; connect-src 'none';">
<style>
  *, *::before, *::after { box-sizing: border-box; }
  :root {
    ${cssBridge}
  }
  html {
    width: 100%;
    margin: 0;
    padding: 0;
    background: transparent;
    color: var(--color-text-primary, #e5e5e5);
    font-family: var(--font-sans, ui-sans-serif, sans-serif);
    font-size: 14px;
    line-height: 1.5;
    -webkit-font-smoothing: antialiased;
    -moz-osx-font-smoothing: grayscale;
  }
  body {
    width: 100%;
    margin: 0;
    padding: 12px;
    background: transparent;
    overflow: visible;
    min-height: 0;
  }
  .widget-root {
    width: 100%;
    padding: 0;
    border-radius: var(--border-radius-md, 8px);
    background: transparent;
    overflow: visible;
  }
  .widget-root .flex { display: flex; }
  .widget-root .flex-col { flex-direction: column; }
  .widget-root .flex-row { flex-direction: row; }
  .widget-root .flex-wrap { flex-wrap: wrap; }
  .widget-root .items-center { align-items: center; }
  .widget-root .justify-center { justify-content: center; }
  .widget-root .justify-between { justify-content: space-between; }
  .widget-root .gap-1 { gap: 4px; }
  .widget-root .gap-2 { gap: 8px; }
  .widget-root .gap-3 { gap: 12px; }
  .widget-root .gap-4 { gap: 16px; }
  .widget-root .grid { display: grid; }
  .widget-root .grid-cols-2 { grid-template-columns: repeat(2, 1fr); }
  .widget-root .grid-cols-3 { grid-template-columns: repeat(3, 1fr); }
  .widget-root .grid-cols-4 { grid-template-columns: repeat(4, 1fr); }
  .widget-root .text-center { text-align: center; }
  .widget-root .text-left { text-align: left; }
  .widget-root .text-right { text-align: right; }
  .widget-root .text-xs { font-size: 0.75rem; }
  .widget-root .text-sm { font-size: 0.875rem; }
  .widget-root .text-base { font-size: 1rem; }
  .widget-root .text-lg { font-size: 1.125rem; }
  .widget-root .text-xl { font-size: 1.25rem; }
  .widget-root .text-2xl { font-size: 1.5rem; }
  .widget-root .font-bold { font-weight: 700; }
  .widget-root .font-semibold { font-weight: 600; }
  .widget-root .font-mono { font-family: var(--font-mono, monospace); }
  .widget-root .p-1 { padding: 4px; }
  .widget-root .p-2 { padding: 8px; }
  .widget-root .p-3 { padding: 12px; }
  .widget-root .p-4 { padding: 16px; }
  .widget-root .rounded { border-radius: 4px; }
  .widget-root .rounded-md { border-radius: 6px; }
  .widget-root .rounded-lg { border-radius: 8px; }
  .widget-root .w-full { width: 100%; }
  .widget-root .h-full { height: 100%; }
  .widget-root .overflow-auto { overflow: auto; }
  .widget-root .overflow-hidden { overflow: hidden; }
  .widget-root .bg-primary { background: var(--color-background-primary, transparent); }
  .widget-root .border { border: 1px solid var(--color-border-tertiary, rgba(255,255,255,0.1)); }
  .widget-root .text-primary { color: var(--color-text-primary, #e5e5e5); }
  .widget-root .text-secondary { color: var(--color-text-secondary, #a0a0a0); }
  .widget-root svg { max-width: 100%; height: auto; }
  .widget-root button {
    display: inline-flex; align-items: center; justify-content: center;
    padding: 6px 12px; border-radius: 6px; border: 1px solid var(--color-border-tertiary, rgba(255,255,255,0.15));
    background: transparent; color: var(--color-text-primary, #e5e5e5);
    font-size: 0.8125rem; cursor: pointer; transition: background 0.15s, border-color 0.15s;
  }
  .widget-root button:hover {
    background: rgba(255,255,255,0.06);
    border-color: rgba(255,255,255,0.25);
  }
  .widget-root canvas { max-width: 100%; }
  .widget-root img { max-width: 100%; height: auto; }
  table { border-collapse: collapse; width: 100%; }
  th, td { padding: 6px 8px; border: 1px solid var(--color-border-tertiary, rgba(255,255,255,0.1)); }
  /* === SVG Diagram Semantic Classes === */
  /* Container fills (color → meaning) */
  .s-plat { fill: rgb(12,68,124); stroke: rgb(133,183,235); }
  .s-proc { fill: rgb(230,241,251); stroke: rgb(24,95,165); }
  .s-agent { fill: rgb(225,245,238); stroke: rgb(15,110,86); }
  .s-msg { fill: rgb(238,237,254); stroke: rgb(83,74,183); }
  .s-err { fill: rgb(252,235,235); stroke: rgb(163,45,45); }
  .s-chk { fill: rgb(250,238,218); stroke: rgb(133,79,11); }
  .s-sub { fill: rgb(241,239,232); stroke: rgb(95,94,90); }
  .s-sub-dark { fill: rgb(68,68,65); stroke: rgb(180,178,169); }
  /* Text colors (match to container) */
  .t-dark { fill: rgb(181,212,244); }
  .t-dim-dark { fill: rgb(133,183,235); }
  .t-light { fill: rgb(12,68,124); }
  .t-dim { fill: rgb(24,95,165); }
  .t-green { fill: rgb(8,80,65); }
  .t-gray { fill: rgb(68,68,65); }
  .t-gray-dim { fill: rgb(95,94,90); }
  .td-on-dark { fill: rgb(211,209,199); }
  .td-on-dark-dim { fill: rgb(180,178,169); }
  /* Typography */
  .tt { font-family: sans-serif; font-size: 14px; font-weight: 500; text-anchor: middle; dominant-baseline: middle; }
  .td { font-family: sans-serif; font-size: 12px; font-weight: 400; text-anchor: middle; dominant-baseline: middle; }
  /* Layout */
  .c-bx { rx: 10; stroke-width: 0.5; }
  .n-box { rx: 6; stroke-width: 0.5; }
  .arr-line { stroke: rgb(115,114,108); stroke-width: 1.5; marker-end: url(#arrow); }
  ${animCss}
</style>
</head>
<body>
<div class="widget-root">${visualHtml}</div>
<script>${RECEIVER_SCRIPT}</script>
${scripts ? `<script>${scripts}</script>` : ''}
</body>
</html>`;
}
