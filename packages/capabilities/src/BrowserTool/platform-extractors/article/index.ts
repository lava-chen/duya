/**
 * Generic Article Extractor — OpenCLI-style readability for any web page.
 *
 * Runs an in-page readability pass (article → [role=main] → <main> → largest
 * text block), strips chrome/noise, dedupes identical blocks, then walks the
 * DOM converting to Markdown (headings / paragraphs / lists / code / links).
 *
 * Registered LAST in the extractor chain so it only claims pages no
 * platform-specific extractor handled.
 */

import { BaseExtractor } from '../BaseExtractor.js';
import type { ICDPClient } from '../../CDPClient.js';
import type { PlatformContent, ExtractionOptions } from '../types.js';

interface ArticleScriptResult {
  kind: 'ok' | 'error';
  text?: string;
  title?: string;
  detail?: string;
  interactive?: Array<{
    ref: number;
    tag: string;
    type?: string;
    text: string;
    selector?: string;
  }>;
}

export class ArticleExtractor extends BaseExtractor {
  name = 'article';

  matches(url: string): boolean {
    try {
      const u = new URL(url);
      return u.protocol === 'http:' || u.protocol === 'https:';
    } catch {
      return false;
    }
  }

  async extract(cdp: ICDPClient, url: string, options?: ExtractionOptions): Promise<PlatformContent> {
    const maxLength = options?.maxLength ?? 20000;

    const script = [
      '(async () => {',
      `  const maxLength = ${maxLength};`,
      '  const textLen = (el) => (el && (el.textContent || "").replace(/\\s+/g, " ").trim().length) || 0;',
      '  const abs = (v, b) => { if (!v) return ""; try { return new URL(v, b).href; } catch (e) { return v; } };',
      '  let content = null;',
      '  const articles = document.querySelectorAll("article");',
      '  if (articles.length === 1) { content = articles[0]; }',
      '  else if (articles.length > 1) {',
      '    let best = null, bl = 0;',
      '    articles.forEach(a => { const l = textLen(a); if (l > bl) { bl = l; best = a; } });',
      '    content = best;',
      '  }',
      '  if (!content) content = document.querySelector("[role=main]") || document.querySelector("main");',
      '  if (!content) {',
      '    const cands = document.querySelectorAll("div[id*=content], div[class*=content], div[class*=article], div[class*=post], div[class*=entry], section");',
      '    let best = null, bl = 0;',
      '    cands.forEach(c => { const l = textLen(c); if (l > bl) { bl = l; best = c; } });',
      '    content = best;',
      '  }',
      '  if (!content || textLen(content) < 200) content = document.body;',
      '  if (textLen(content) < 150) return { kind: "error", detail: "No readable article content found" };',
      '  const clone = content.cloneNode(true);',
      '  clone.querySelectorAll("script, style, noscript, nav, header, footer, aside, .sidebar, .menu, .footer, .header, .comments, .comment, .ad, .ads, .advertisement, .social-share, .related-posts, .newsletter, .cookie-banner, button, form, iframe, svg, canvas").forEach(el => el.remove());',
      '  const clean = (s) => (s || "").replace(/\\s+/g, "");',
      '  const dedup = (parent) => {',
      '    const children = Array.prototype.slice.call(parent.children || []);',
      '    for (let i = children.length - 1; i >= 1; i--) {',
      '      const ca = clean(children[i].textContent);',
      '      const cb = clean(children[i - 1].textContent);',
      '      if (ca.length < 20 || cb.length < 20) continue;',
      '      if (ca === cb) children[i - 1].remove();',
      '    }',
      '  };',
      '  dedup(clone);',
      '  clone.querySelectorAll("section, div").forEach(el => { if (el.children && el.children.length > 2) dedup(el); });',
      '  const out = [];',
      '  const walk = (el) => {',
      '    for (const child of el.childNodes) {',
      '      if (child.nodeType === Node.TEXT_NODE) {',
      '        const t = (child.textContent || "").replace(/\\s+/g, " ").trim();',
      '        if (t) out.push(t);',
      '      } else if (child.nodeType === Node.ELEMENT_NODE) {',
      '        const tag = child.tagName.toLowerCase();',
      '        if (tag === "h1" || tag === "h2" || tag === "h3" || tag === "h4" || tag === "h5" || tag === "h6") {',
      '          const t = (child.textContent || "").replace(/\\s+/g, " ").trim();',
      '          if (t) { out.push("#".repeat(Number(tag[1])) + " " + t); out.push(""); }',
      '        } else if (tag === "p") {',
      '          const t = (child.textContent || "").replace(/\\s+/g, " ").trim();',
      '          if (t) { out.push(t); out.push(""); }',
      '        } else if (tag === "li") {',
      '          const t = (child.textContent || "").replace(/\\s+/g, " ").trim();',
      '          if (t) out.push("- " + t);',
      '        } else if (tag === "pre" || tag === "code") {',
      '          const t = (child.textContent || "").trim();',
      '          if (t) { out.push("```"); out.push(t); out.push("```"); out.push(""); }',
      '        } else if (tag === "blockquote") {',
      '          const t = (child.textContent || "").replace(/\\s+/g, " ").trim();',
      '          if (t) { out.push("> " + t); out.push(""); }',
      '        } else if (tag === "a") {',
      '          const t = (child.textContent || "").replace(/\\s+/g, " ").trim();',
      '          const href = abs(child.getAttribute("href"), window.location.href);',
      '          if (t && /^https?:\\/\\//.test(href)) out.push("[" + t + "](" + href + ")");',
      '          else if (t) out.push(t);',
      '        } else if (tag === "br") {',
      '          out.push("");',
      '        } else if (tag === "ul" || tag === "ol" || tag === "table") {',
      '          walk(child);',
      '        } else {',
      '          walk(child);',
      '        }',
      '      }',
      '    }',
      '  };',
      '  walk(clone);',
      '  let text = out.join("\\n").replace(/\\n{3,}/g, "\\n\\n").trim();',
      '  if (text.length > maxLength) text = text.substring(0, maxLength) + "\\n\\n*[Content truncated]*";',
      "  const title = (document.title || '').replace(/\\s+/g, ' ').trim();",
      '  if (text.trim().length < 150) return { kind: "error", detail: "No readable article content found" };',
      '  if (title) text = "# " + title + "\\n\\n" + text;',
      // Collect interactive refs in the same pass so downstream callers can
      // skip a second full-DOM snapshot. Limit to 50 to keep payloads bounded.
      '  const interactiveSelectors = "a[href], button, input, select, textarea, [role=button], [role=link], [tabindex]";',
      '  const interactive = [];',
      '  let refIdx = 0;',
      '  document.querySelectorAll(interactiveSelectors).forEach(el => {',
      '    if (interactive.length >= 50) return;',
      '    const r = el.getBoundingClientRect();',
      '    if (r.width === 0 || r.height === 0) return;',
      '    const cs = window.getComputedStyle(el);',
      '    if (cs.display === "none" || cs.visibility === "hidden") return;',
      '    refIdx++;',
      '    el.setAttribute("data-duya-ref", String(refIdx));',
      '    interactive.push({',
      '      ref: refIdx,',
      '      tag: el.tagName.toLowerCase(),',
      '      type: el.getAttribute("type") || undefined,',
      '      text: (el.textContent || "").replace(/\\s+/g, " ").trim().slice(0, 80),',
      '      selector: el.id ? "#" + el.id : (el.getAttribute("data-testid") ? `[data-testid="${el.getAttribute("data-testid")}"]` : el.tagName.toLowerCase()),',
      '    });',
      '  });',
      '  return { kind: "ok", text, title, interactive };',
      '})()',
    ].join('\n');

    try {
      const res = await cdp.evaluate(script) as ArticleScriptResult | null;
      if (res && res.kind === 'ok' && res.text) {
        return this.success('article', res.text, res.interactive, { title: res.title });
      }
      return this.error('article', res?.detail || 'No readable article content found');
    } catch (e) {
      return this.error('article', `Evaluation error: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}

export const articleExtractor = new ArticleExtractor();