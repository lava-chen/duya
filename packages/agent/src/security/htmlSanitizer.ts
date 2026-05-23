/**
 * HTML Sanitizer - XSS protection for dynamic widgets
 * Uses regex-based parsing instead of cheerio for Node.js 18 compatibility
 */

export interface HtmlSanitizeResult {
  safe: boolean;
  sanitized: string;
  warnings: string[];
  blocked: SanitizeBlockedEntry[];
}

export interface SanitizeBlockedEntry {
  element: string;
  attribute?: string;
  reason: string;
}

const ALLOWED_TAGS = new Set([
  "div", "span", "p", "h1", "h2", "h3", "h4", "h5", "h6",
  "ul", "ol", "li", "a", "strong", "b", "em", "i", "u", "s", "del",
  "br", "hr", "blockquote", "pre", "code",
  "table", "thead", "tbody", "tr", "th", "td",
  "img", "svg", "path", "circle", "rect", "line", "polyline", "polygon", "ellipse",
  "g", "defs", "linearGradient", "radialGradient", "stop",
  "text", "tspan", "title", "desc", "use", "symbol",
  "section", "header", "footer", "nav", "main", "article", "aside",
  "figure", "figcaption", "details", "summary",
  "mark", "time", "abbr", "cite", "small", "sub", "sup",
  "dl", "dt", "dd",
]);

const ALLOWED_ATTRIBUTES = new Set([
  "class", "id", "style",
  "href", "src", "alt", "title",
  "width", "height", "target", "rel",
  "colspan", "rowspan",
  "type", "start", "reversed", "datetime", "lang", "dir",
  "fill", "stroke", "stroke-width", "stroke-linecap", "stroke-linejoin",
  "d", "cx", "cy", "r", "rx", "ry", "x", "y", "x1", "y1", "x2", "y2", "points",
  "viewBox", "preserveAspectRatio", "transform", "opacity",
  "font-family", "font-size", "text-anchor", "dominant-baseline",
  "data-widget-id", "data-widget-role",
]);

const BLOCKED_TAGS = new Set([
  "script", "iframe", "object", "embed", "form", "input", "button",
  "select", "textarea", "link", "meta", "base", "applet",
  "audio", "video", "source", "track", "canvas", "style",
]);

const SVG_DANGEROUS_TAGS = new Set([
  "script", "foreignObject", "animate", "set", "animateMotion", "animateTransform", "handler",
]);

const EVENT_HANDLER_PATTERN = /^on\w+/i;
const DANGEROUS_URL_SCHEMES = ["javascript:", "data:text/html", "vbscript:"];
const DANGEROUS_CSS_PATTERNS = [
  /url\s*\(\s*["']?\s*(?:javascript|data)/i,
  /expression\s*\(/i,
  /behavior\s*:/i,
  /-moz-binding/i,
];

interface ParsedTag {
  tagName: string;
  attributes: Record<string, string>;
  selfClosing: boolean;
  raw: string;
}

function parseTag(tagStr: string): ParsedTag | null {
  const match = tagStr.match(/^<(\/?)([a-zA-Z][a-zA-Z0-9-]*)([^>]*?)\/?(\s+[^>]*)?>$/);
  if (!match) return null;

  const closingSlash = match[1];
  const tagName = match[2].toLowerCase();
  const rest = match[3] || '';
  const attributes: Record<string, string> = {};

  // Parse attributes
  const attrRegex = /([a-zA-Z][a-zA-Z0-9-]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
  let attrMatch;
  while ((attrMatch = attrRegex.exec(rest + (match[4] || ''))) !== null) {
    const name = attrMatch[1].toLowerCase();
    const value = attrMatch[2] ?? attrMatch[3] ?? attrMatch[4] ?? '';
    attributes[name] = value;
  }

  return {
    tagName,
    attributes,
    selfClosing: tagStr.endsWith('/>'),
    raw: tagStr,
  };
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function sanitizeTagName(tagName: string): string | null {
  return ALLOWED_TAGS.has(tagName) ? tagName : null;
}

export function sanitizeHtml(html: string): HtmlSanitizeResult {
  const warnings: string[] = [];
  const blocked: SanitizeBlockedEntry[] = [];

  if (!html || typeof html !== "string") {
    return { safe: true, sanitized: "", warnings: [], blocked: [] };
  }

  const result: string[] = [];
  const tagRegex = /<(\/?)([a-zA-Z][a-zA-Z0-9-]*)([^>]*?)(\/?)>/gi;
  let lastIndex = 0;
  let match;

  while ((match = tagRegex.exec(html)) !== null) {
    const before = html.slice(lastIndex, match.index);
    if (before) result.push(before);

    const isClosing = match[1] === '/';
    const tagName = match[2].toLowerCase();
    const attrStr = match[3];
    const isSelfClosing = match[4] === '/';

    // Parse attributes
    const attributes: Record<string, string> = {};
    const attrRegex = /([a-zA-Z][a-zA-Z0-9-]*)(?:\s*=\s*"(?:[^"]*)"|\s*=\s*'(?:[^']*)'|\s*=\s*[^\s>]+)?/gi;
    let attrMatch;
    while ((attrMatch = attrRegex.exec(attrStr)) !== null) {
      const name = attrMatch[1].toLowerCase();
      const valueMatch = attrStr.slice(attrMatch.index).match(/=\s*"(.*?)"/) ||
                         attrStr.slice(attrMatch.index).match(/=\s*'(.*?)'/) ||
                         attrStr.slice(attrMatch.index).match(/=\s*([^\s>]+)/);
      attributes[name] = valueMatch ? valueMatch[1] : '';
    }

    // Skip structural tags
    if (tagName === "html" || tagName === "head" || tagName === "body" || tagName === "#document") {
      lastIndex = match.index + match[0].length;
      continue;
    }

    // Check blocked tags
    if (BLOCKED_TAGS.has(tagName)) {
      blocked.push({ element: tagName, reason: getBlockedReason(tagName) });
      lastIndex = match.index + match[0].length;
      continue;
    }

    // Check SVG dangerous tags
    if (SVG_DANGEROUS_TAGS.has(tagName)) {
      blocked.push({ element: tagName, reason: `SVG element "${tagName}" not allowed in dynamic widgets` });
      lastIndex = match.index + match[0].length;
      continue;
    }

    // Check allowed tags
    if (!ALLOWED_TAGS.has(tagName)) {
      warnings.push(`Removed unknown tag: <${tagName}>`);
      lastIndex = match.index + match[0].length;
      continue;
    }

    // Clean attributes
    let cleanAttrs = '';
    for (const [attrName, attrValue] of Object.entries(attributes)) {
      // Block event handlers
      if (EVENT_HANDLER_PATTERN.test(attrName)) {
        blocked.push({
          element: tagName,
          attribute: attrName,
          reason: `Inline event handler "${attrName}" not allowed`,
        });
        continue;
      }

      // Check allowed attributes
      if (!ALLOWED_ATTRIBUTES.has(attrName) && !attrName.startsWith('data-') && !attrName.startsWith('aria-')) {
        warnings.push(`Removed attribute "${attrName}" from <${tagName}>`);
        continue;
      }

      // Check dangerous URL schemes
      if ((attrName === 'href' || attrName === 'src') && attrValue) {
        const lowerValue = attrValue.toLowerCase().trim();
        if (DANGEROUS_URL_SCHEMES.some(scheme => lowerValue.startsWith(scheme))) {
          blocked.push({
            element: tagName,
            attribute: attrName,
            reason: `Dangerous URL scheme in "${attrName}" attribute`,
          });
          continue;
        }
      }

      // Check style attribute for dangerous CSS
      if (attrName === 'style' && attrValue) {
        for (const pattern of DANGEROUS_CSS_PATTERNS) {
          if (pattern.test(attrValue)) {
            blocked.push({
              element: tagName,
              attribute: 'style',
              reason: pattern.source.includes('url') ? 'CSS url() with dangerous scheme' :
                      pattern.source.includes('expression') ? 'CSS expression() is dangerous' :
                      'Dangerous CSS pattern',
            });
            continue;
          }
        }
      }

      // Validate target attribute on links
      if (attrName === 'target' && tagName === 'a') {
        if (attrValue !== '_blank') {
          warnings.push(`Non-standard target "${attrValue}" on <a> reset to "_blank"`);
          continue;
        }
      }

      cleanAttrs += ` ${attrName}="${escapeHtml(attrValue)}"`;
    }

    // Build clean tag
    if (isClosing) {
      result.push(`</${tagName}>`);
    } else {
      result.push(`<${tagName}${cleanAttrs}${isSelfClosing ? ' />' : '>'}`);
    }

    lastIndex = match.index + match[0].length;
  }

  // Add remaining content
  if (lastIndex < html.length) {
    result.push(html.slice(lastIndex));
  }

  const sanitized = result.join('');

  return {
    safe: blocked.length === 0,
    sanitized,
    warnings,
    blocked,
  };
}

function getBlockedReason(tagName: string): string {
  const reasons: Record<string, string> = {
    script: "Script execution not allowed in dynamic widgets",
    iframe: "Nested iframes not allowed in dynamic widgets",
    object: "Object embeds not allowed in dynamic widgets",
    embed: "Embeds not allowed in dynamic widgets",
    form: "Forms not allowed in dynamic widgets",
    input: "Form inputs not allowed in dynamic widgets",
    button: "Buttons not allowed in dynamic widgets (use a tag with href instead)",
    select: "Select inputs not allowed in dynamic widgets",
    textarea: "Text inputs not allowed in dynamic widgets",
    link: "External stylesheets not allowed in dynamic widgets",
    meta: "Meta tags not allowed in dynamic widgets",
    base: "Base tag not allowed in dynamic widgets",
    applet: "Applet not allowed in dynamic widgets",
    audio: "Audio not allowed in dynamic widgets",
    video: "Video not allowed in dynamic widgets",
    source: "Media sources not allowed in dynamic widgets",
    track: "Media tracks not allowed in dynamic widgets",
    canvas: "Canvas not allowed in dynamic widgets",
    style: "Style tags not allowed in dynamic widgets (use inline style attribute)",
  };
  return reasons[tagName] || "Tag not allowed in dynamic widgets";
}

export function sanitizeSvg(svgContent: string): HtmlSanitizeResult {
  return sanitizeHtml(svgContent);
}

export function isHtmlSafe(html: string): boolean {
  const result = sanitizeHtml(html);
  return result.safe;
}