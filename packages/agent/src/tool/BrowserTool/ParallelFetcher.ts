/**
 * ParallelFetcher - Batch parallel fetching within a single Agent session
 * Uses regex-based parsing for Node.js 18 compatibility
 */

import axios from 'axios';
import { isSafeUrl } from '../../utils/urlSafety.js';

export interface FetchTask {
  id: string;
  url: string;
  selector?: string;
  extract?: 'text' | 'html' | 'markdown';
}

export interface FetchResult {
  id: string;
  url: string;
  success: boolean;
  title?: string;
  content?: string;
  interactiveCount?: number;
  error?: string;
  durationMs: number;
}

const MAX_CONCURRENT = 5;
const FETCH_TIMEOUT = 15000;
const MAX_CONTENT_LENGTH = 500000;

const SKIP_TAGS = new Set([
  'script', 'style', 'noscript', 'link', 'meta', 'head',
  'template', 'br', 'wbr', 'col', 'colgroup',
]);

const INTERACTIVE_TAGS = new Set([
  'a', 'button', 'input', 'select', 'textarea', 'details',
  'summary', 'option', 'optgroup',
]);

const AD_SELECTOR_RE = /\b(ad[_-]?(?:banner|container|wrapper|slot|unit|block|frame)|sponsored|adsbygoogle)\b/i;
const AD_DOMAINS = [
  'googleadservices.com', 'doubleclick.net', 'googlesyndication.com',
  'facebook.com/tr', 'analytics.google.com', 'connect.facebook.net',
  'ad.doubleclick', 'pagead', 'adsense',
];

const MAX_TEXT_LENGTH = 120;

interface ParsedElement {
  tagName: string;
  attributes: Record<string, string>;
  children: (string | ParsedElement)[];
  raw: string;
}

function parseHtmlSimple(html: string): ParsedElement[] {
  const elements: ParsedElement[] = [];
  const stack: ParsedElement[] = [];
  let currentContent = '';

  const tagRegex = /<(\/?)([a-zA-Z][a-zA-Z0-9]*)([^>]*?)(\/?)>/gi;
  let lastIndex = 0;
  let match;

  while ((match = tagRegex.exec(html)) !== null) {
    const before = html.slice(lastIndex, match.index);
    if (before.trim()) {
      currentContent += before;
    }

    const isClosing = match[1] === '/';
    const tagName = match[2].toLowerCase();
    const isSelfClosing = match[4] === '/' || ['img', 'br', 'hr', 'input', 'meta', 'link'].includes(tagName);

    // Parse attributes
    const attributes: Record<string, string> = {};
    const attrStr = match[3];
    const attrRegex = /([a-zA-Z][a-zA-Z0-9-]*)(?:\s*=\s*"(.*?)"|\s*=\s*'(.*?)')/gi;
    let attrMatch;
    while ((attrMatch = attrRegex.exec(attrStr)) !== null) {
      attributes[attrMatch[1].toLowerCase()] = attrMatch[2] ?? attrMatch[3] ?? '';
    }

    if (isClosing) {
      // Close tag - pop from stack
      if (stack.length > 0) {
        const closed = stack.pop()!;
        closed.raw = currentContent.trim();
        if (currentContent.trim()) {
          currentContent = '';
        }
        if (stack.length === 0) {
          elements.push(closed);
        } else {
          stack[stack.length - 1].children.push(closed);
        }
      }
    } else {
      const element: ParsedElement = {
        tagName,
        attributes,
        children: [],
        raw: '',
      };

      if (currentContent.trim()) {
        element.children.push(currentContent.trim());
        currentContent = '';
      }

      if (isSelfClosing) {
        if (stack.length === 0) {
          elements.push(element);
        } else {
          stack[stack.length - 1].children.push(element);
        }
      } else {
        stack.push(element);
      }
    }

    lastIndex = match.index + match[0].length;
  }

  // Add remaining content
  if (lastIndex < html.length) {
    currentContent += html.slice(lastIndex);
  }
  if (currentContent.trim() && stack.length > 0) {
    stack[stack.length - 1].children.push(currentContent.trim());
  }

  return elements;
}

function getTagText(element: ParsedElement): string {
  let text = '';
  for (const child of element.children) {
    if (typeof child === 'string') {
      text += child + ' ';
    } else if (child.tagName === 'script' || child.tagName === 'style') {
      // Skip
    } else {
      text += getTagText(child) + ' ';
    }
  }
  return text.trim();
}

function serializeAttributes(attrs: Record<string, string>): string {
  const ATTR_WHITELIST = new Set([
    'id', 'name', 'type', 'value', 'placeholder', 'title', 'alt',
    'role', 'aria-label', 'aria-expanded', 'aria-checked', 'aria-selected',
    'aria-disabled', 'href', 'src', 'action', 'method', 'for', 'checked', 'selected',
    'disabled', 'required', 'multiple', 'accept', 'min', 'max',
    'pattern', 'maxlength', 'minlength', 'data-testid', 'data-test',
    'contenteditable', 'tabindex', 'autocomplete',
  ]);

  const parts: string[] = [];
  for (const [name, value] of Object.entries(attrs)) {
    if (!ATTR_WHITELIST.has(name)) continue;
    if (!value || typeof value !== 'string') continue;

    let val = value.trim();
    if (val.length > 120) val = val.slice(0, 100) + '…';

    if (name === 'href') {
      if (val.startsWith('javascript:')) continue;
      try {
        const u = new URL(val, 'https://example.com');
        if (u.origin === 'https://example.com') val = u.pathname + u.search + u.hash;
      } catch {}
    }
    parts.push(name + '=' + val);
  }
  return parts.join(' ');
}

function capText(s: string): string {
  if (!s) return '';
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > MAX_TEXT_LENGTH ? t.slice(0, MAX_TEXT_LENGTH) + '…' : t;
}

function isInteractiveTag(tag: string): boolean {
  return INTERACTIVE_TAGS.has(tag);
}

function isAdElement(element: ParsedElement): boolean {
  const id = element.attributes.id || '';
  const cls = element.attributes.class || '';
  if (AD_SELECTOR_RE.test(id + ' ' + cls)) return true;

  if (element.tagName === 'iframe') {
    const src = element.attributes.src || '';
    for (const domain of AD_DOMAINS) {
      if (src.includes(domain)) return true;
    }
  }
  return false;
}

function isLandmarkTag(tag: string): boolean {
  return ['nav', 'main', 'header', 'footer', 'aside', 'form', 'search', 'dialog', 'section', 'article'].includes(tag);
}

function compressHtml(html: string, options: { interactiveOnly?: boolean; maxLength?: number } = {}): { content: string; interactiveCount: number } {
  // Remove skip tags
  let cleaned = html;
  for (const tag of SKIP_TAGS) {
    const regex = new RegExp(`<${tag}[^>]*>[\\s\\S]*?</${tag}>`, 'gi');
    cleaned = cleaned.replace(regex, '');
    const selfClosing = new RegExp(`<${tag}[^>]*\\/?>`, 'gi');
    cleaned = cleaned.replace(selfClosing, '');
  }

  // Remove HTML/HEAD/BODY
  cleaned = cleaned.replace(/<\/?(html|head|body)[^>]*>/gi, '');

  const lines: string[] = [];
  let interactiveCount = 0;
  let refIndex = 0;

  function walkElement(element: ParsedElement, depth: number): boolean {
    const tag = element.tagName;

    if (isAdElement(element)) {
      return false;
    }

    let hasInteractive = false;
    let childHasInteractive = false;

    for (const child of element.children) {
      if (typeof child === 'string') continue;
      if (walkElement(child, depth + 1)) {
        childHasInteractive = true;
      }
    }

    const text = capText(getTagText(element));
    const interactive = isInteractiveTag(tag) || element.attributes.href || element.attributes.onclick;
    const landmark = isLandmarkTag(tag);

    if (options.interactiveOnly && !interactive && !landmark && !childHasInteractive && !text) {
      return false;
    }

    if (!interactive && !childHasInteractive && !text && !landmark) {
      return false;
    }

    let line = '  '.repeat(depth);

    if (interactive) {
      refIndex++;
      interactiveCount++;
      line += '[' + refIndex + ']';
    }

    const attrs = serializeAttributes(element.attributes);
    if (text) {
      line += '<' + tag + (attrs ? ' ' + attrs : '') + '>' + text + '</' + tag + '>';
    } else {
      line += '<' + tag + (attrs ? ' ' + attrs : '') + ' />';
    }

    lines.push(line);
    if (interactive || childHasInteractive) hasInteractive = true;

    return hasInteractive;
  }

  const elements = parseHtmlSimple(cleaned);
  for (const element of elements) {
    if (SKIP_TAGS.has(element.tagName)) continue;
    walkElement(element, 0);
  }

  return {
    content: lines.join('\n').slice(0, options.maxLength || 100000),
    interactiveCount,
  };
}

function extractTitle(html: string): string {
  const match = html.match(/<title[^>]*>([^<]*)<\/title>/i);
  return match ? match[1].trim() : '';
}

export class ParallelFetcher {
  async fetchBatch(tasks: FetchTask[]): Promise<FetchResult[]> {
    const results: FetchResult[] = [];

    for (let i = 0; i < tasks.length; i += MAX_CONCURRENT) {
      const chunk = tasks.slice(i, i + MAX_CONCURRENT);
      const chunkResults = await Promise.all(
        chunk.map(task => this.fetchSingle(task))
      );
      results.push(...chunkResults);
    }

    return results;
  }

  async fetchSingle(task: FetchTask): Promise<FetchResult> {
    const startTime = Date.now();

    const safetyCheck = await isSafeUrl(task.url);
    if (!safetyCheck.safe) {
      return {
        id: task.id,
        url: task.url,
        success: false,
        error: `URL blocked for security: ${safetyCheck.reason}`,
        durationMs: Date.now() - startTime,
      };
    }

    try {
      const response = await axios.get(task.url, {
        timeout: FETCH_TIMEOUT,
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; duya/1.0)',
          'Accept': 'text/html, application/xhtml+xml, */*',
        },
        maxRedirects: 5,
        responseType: 'text',
        maxContentLength: MAX_CONTENT_LENGTH,
      });

      const html = response.data as string;
      const title = extractTitle(html);

      const { content: compressedContent, interactiveCount } = compressHtml(html, {
        interactiveOnly: false,
        maxLength: 100000,
      });

      return {
        id: task.id,
        url: task.url,
        success: true,
        title,
        content: compressedContent,
        interactiveCount,
        durationMs: Date.now() - startTime,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      return {
        id: task.id,
        url: task.url,
        success: false,
        error: errorMessage,
        durationMs: Date.now() - startTime,
      };
    }
  }

  async healthCheck(url: string): Promise<{ ok: boolean; status?: number; error?: string }> {
    try {
      const response = await axios.head(url, {
        timeout: 5000,
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; duya/1.0)',
        },
        maxRedirects: 3,
      });
      return { ok: true, status: response.status };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      return { ok: false, error: errorMessage };
    }
  }
}

export const parallelFetcher = new ParallelFetcher();
export default ParallelFetcher;