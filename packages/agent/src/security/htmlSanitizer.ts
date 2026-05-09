import * as cheerio from "cheerio";

interface CheerioElement {
  tagName?: string;
  nodeName?: string;
  attribs?: Record<string, string>;
}

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
  "div",
  "span",
  "p",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "ul",
  "ol",
  "li",
  "a",
  "strong",
  "b",
  "em",
  "i",
  "u",
  "s",
  "del",
  "br",
  "hr",
  "blockquote",
  "pre",
  "code",
  "table",
  "thead",
  "tbody",
  "tr",
  "th",
  "td",
  "img",
  "svg",
  "path",
  "circle",
  "rect",
  "line",
  "polyline",
  "polygon",
  "ellipse",
  "g",
  "defs",
  "linearGradient",
  "radialGradient",
  "stop",
  "text",
  "tspan",
  "title",
  "desc",
  "use",
  "symbol",
  "section",
  "header",
  "footer",
  "nav",
  "main",
  "article",
  "aside",
  "figure",
  "figcaption",
  "details",
  "summary",
  "mark",
  "time",
  "abbr",
  "cite",
  "small",
  "sub",
  "sup",
  "dl",
  "dt",
  "dd",
]);

const ALLOWED_ATTRIBUTES = new Set([
  "class",
  "id",
  "style",
  "href",
  "src",
  "alt",
  "title",
  "width",
  "height",
  "target",
  "rel",
  "colspan",
  "rowspan",
  "type",
  "start",
  "reversed",
  "datetime",
  "lang",
  "dir",
  "fill",
  "stroke",
  "stroke-width",
  "stroke-linecap",
  "stroke-linejoin",
  "d",
  "cx",
  "cy",
  "r",
  "rx",
  "ry",
  "x",
  "y",
  "x1",
  "y1",
  "x2",
  "y2",
  "points",
  "viewBox",
  "preserveAspectRatio",
  "transform",
  "opacity",
  "font-family",
  "font-size",
  "text-anchor",
  "dominant-baseline",
  "data-widget-id",
  "data-widget-role",
]);

const BLOCKED_TAG_PATTERNS: Array<{
  tag: string;
  reason: string;
}> = [
  { tag: "script", reason: "Script execution not allowed in dynamic widgets" },
  { tag: "iframe", reason: "Nested iframes not allowed in dynamic widgets" },
  { tag: "object", reason: "Object embeds not allowed in dynamic widgets" },
  { tag: "embed", reason: "Embeds not allowed in dynamic widgets" },
  { tag: "form", reason: "Forms not allowed in dynamic widgets" },
  { tag: "input", reason: "Form inputs not allowed in dynamic widgets" },
  { tag: "button", reason: "Buttons not allowed in dynamic widgets (use a tag with href instead)" },
  { tag: "select", reason: "Select inputs not allowed in dynamic widgets" },
  { tag: "textarea", reason: "Text inputs not allowed in dynamic widgets" },
  { tag: "link", reason: "External stylesheets not allowed in dynamic widgets" },
  { tag: "meta", reason: "Meta tags not allowed in dynamic widgets" },
  { tag: "base", reason: "Base tag not allowed in dynamic widgets" },
  { tag: "applet", reason: "Applet not allowed in dynamic widgets" },
  { tag: "audio", reason: "Audio not allowed in dynamic widgets" },
  { tag: "video", reason: "Video not allowed in dynamic widgets" },
  { tag: "source", reason: "Media sources not allowed in dynamic widgets" },
  { tag: "track", reason: "Media tracks not allowed in dynamic widgets" },
  { tag: "canvas", reason: "Canvas not allowed in dynamic widgets" },
  { tag: "style", reason: "Style tags not allowed in dynamic widgets (use inline style attribute)" },
];

const EVENT_HANDLER_PATTERN = /^on\w+/i;

const DANGEROUS_URL_SCHEMES = ["javascript:", "data:text/html", "vbscript:"];

const DANGEROUS_CSS_PATTERNS: Array<{
  pattern: RegExp;
  reason: string;
}> = [
  { pattern: /url\s*\(\s*["']?\s*(?:javascript|data)/i, reason: "CSS url() with dangerous scheme" },
  { pattern: /expression\s*\(/i, reason: "CSS expression() is dangerous" },
  { pattern: /behavior\s*:/i, reason: "CSS behavior is dangerous" },
  { pattern: /-moz-binding/i, reason: "CSS -moz-binding is dangerous" },
];

const SVG_DANGEROUS_TAGS = new Set([
  "script",
  "foreignObject",
  "use",  // allowed but restricted
  "animate",
  "set",
  "animateMotion",
  "animateTransform",
  "handler",
]);

export function sanitizeHtml(html: string): HtmlSanitizeResult {
  const warnings: string[] = [];
  const blocked: SanitizeBlockedEntry[] = [];

  if (!html || typeof html !== "string") {
    return {
      safe: true,
      sanitized: "",
      warnings: [],
      blocked: [],
    };
  }

  let $: cheerio.CheerioAPI;
  try {
    $ = cheerio.load(html, { xml: { xmlMode: false } }, false);
  } catch {
    return {
      safe: false,
      sanitized: "",
      warnings: ["Failed to parse HTML content"],
      blocked: [{ element: "root", reason: "Invalid HTML structure" }],
    };
  }

  $("*").each((_index, element) => {
    const el = $(element);
    const elem = element as unknown as CheerioElement;
    const tagName = (elem.tagName || elem.nodeName || "").toLowerCase();

    if (!tagName || tagName === "html" || tagName === "head" || tagName === "body" || tagName === "#document") {
      return;
    }

    // Check blocked tags
    const blockedTag = BLOCKED_TAG_PATTERNS.find((p) => p.tag === tagName);
    if (blockedTag) {
      blocked.push({ element: tagName, reason: blockedTag.reason });
      el.remove();
      return;
    }

    // Check SVG-specific dangerous tags
    if (SVG_DANGEROUS_TAGS.has(tagName)) {
      blocked.push({ element: tagName, reason: `SVG element "${tagName}" not allowed in dynamic widgets` });
      el.remove();
      return;
    }

    // Check allowed tags
    if (!ALLOWED_TAGS.has(tagName)) {
      warnings.push(`Removed unknown tag: <${tagName}>`);
      el.replaceWith(el.html() || "");
      return;
    }

    // Check and clean attributes
    const attrs: Record<string, string> = elem.attribs || {};
    for (const [attrName, attrValue] of Object.entries(attrs)) {
      // Block event handlers
      if (EVENT_HANDLER_PATTERN.test(attrName)) {
        blocked.push({
          element: tagName,
          attribute: attrName,
          reason: `Inline event handler "${attrName}" not allowed`,
        });
        el.removeAttr(attrName);
        continue;
      }

      // Check allowed attributes
      if (!ALLOWED_ATTRIBUTES.has(attrName) && !attrName.startsWith("data-") && !attrName.startsWith("aria-")) {
        warnings.push(`Removed attribute "${attrName}" from <${tagName}>`);
        el.removeAttr(attrName);
        continue;
      }

      // Check URL attributes for dangerous schemes
      if ((attrName === "href" || attrName === "src") && attrValue) {
        const lowerValue = attrValue.toLowerCase().trim();
        const hasDangerousScheme = DANGEROUS_URL_SCHEMES.some((scheme) =>
          lowerValue.startsWith(scheme)
        );
        if (hasDangerousScheme) {
          blocked.push({
            element: tagName,
            attribute: attrName,
            reason: `Dangerous URL scheme in "${attrName}" attribute`,
          });
          el.attr(attrName, "#blocked");
        }
      }

      // Check style attribute for dangerous CSS
      if (attrName === "style" && attrValue) {
        for (const { pattern, reason } of DANGEROUS_CSS_PATTERNS) {
          if (pattern.test(attrValue)) {
            blocked.push({
              element: tagName,
              attribute: "style",
              reason,
            });
            el.removeAttr("style");
            break;
          }
        }
      }

      // Validate target attribute on links
      if (attrName === "target" && tagName === "a") {
        if (attrValue !== "_blank") {
          warnings.push(`Non-standard target "${attrValue}" on <a> reset to "_blank"`);
          el.attr("target", "_blank");
        }
      }
    }
  });

  const sanitized = $.html()
    .replace(/<html>/gi, "")
    .replace(/<\/html>/gi, "")
    .replace(/<head>[\s\S]*?<\/head>/gi, "")
    .replace(/<body>/gi, "")
    .replace(/<\/body>/gi, "")
    .trim();

  return {
    safe: blocked.length === 0,
    sanitized,
    warnings,
    blocked,
  };
}

export function sanitizeSvg(svgContent: string): HtmlSanitizeResult {
  return sanitizeHtml(svgContent);
}

export function isHtmlSafe(html: string): boolean {
  const result = sanitizeHtml(html);
  return result.safe;
}
