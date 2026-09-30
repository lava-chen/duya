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

// Block-level tags that introduce line breaks when serializing readable text.
const BLOCK_TAGS = new Set([
  'p', 'div', 'section', 'article', 'aside', 'header', 'footer', 'main', 'nav',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'li', 'dl', 'dt', 'dd',
  'table', 'thead', 'tbody', 'tr', 'th', 'td', 'blockquote', 'pre', 'figure',
  'figcaption', 'form', 'fieldset', 'address', 'details', 'summary', 'hr', 'br',
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

/**
 * Extract readable plain text from HTML — no tags, no structure.
 *
 * The static HTTP path is a research/read path: callers want the page's text
 * content, not a serialized DOM. Block-level elements are separated by line
 * breaks; ads and non-content tags are dropped.
 */
function htmlToPlainText(html: string, maxLength = 100000): { text: string; interactiveCount: number } {
  let cleaned = html.replace(/<br\s*\/?>/gi, '\n');
  for (const tag of SKIP_TAGS) {
    if (tag === 'br') continue;
    cleaned = cleaned.replace(new RegExp(`<${tag}[^>]*>[\\s\\S]*?</${tag}>`, 'gi'), '');
    cleaned = cleaned.replace(new RegExp(`<${tag}[^>]*\\/?>`, 'gi'), '');
  }
  cleaned = cleaned.replace(/<\/?(html|head|body)[^>]*>/gi, '');

  const pieces: string[] = [];
  let interactiveCount = 0;

  function walk(element: ParsedElement): void {
    if (isAdElement(element)) return;
    if (isInteractiveTag(element.tagName) || element.attributes.href || element.attributes.onclick) {
      interactiveCount++;
    }
    const block = BLOCK_TAGS.has(element.tagName);
    if (block) pieces.push('\n');
    for (const child of element.children) {
      if (typeof child === 'string') {
        pieces.push(child);
      } else {
        walk(child);
      }
    }
    // Inner text of a closed element lives in `raw`, not in `children`.
    if (element.raw) pieces.push(element.raw);
    if (block) pieces.push('\n');
  }

  for (const element of parseHtmlSimple(cleaned)) {
    if (SKIP_TAGS.has(element.tagName)) continue;
    walk(element);
  }

  const text = pieces
    .join('')
    .replace(/[ \t\f\v\u00a0]+/g, ' ')
    .split('\n')
    .map(line => line.trim())
    .filter(line => line.length > 0)
    .join('\n');

  return {
    text: text.length > maxLength ? `${text.slice(0, maxLength)}\n\n[Text truncated...]` : text,
    interactiveCount,
  };
}

function extractTitle(html: string): string {
  const match = html.match(/<title[^>]*>([^<]*)<\/title>/i);
  return match ? match[1].trim() : '';
}

// Signals that a 2xx response is actually an error / bot-block page.
const ERROR_PAGE_RE = /(404\s+not\s+found|page\s+not\s+found|403\s+forbidden|access\s+denied|forbidden|unauthorized|bad\s+request|internal\s+server\s+error|service\s+unavailable|captcha|hcaptcha|recaptcha|anti[- ]?bot|you\s+have\s+been\s+blocked|something\s+went\s+wrong|error\s+occurred)/i;

function matchErrorPageSignal(title: string, content: string): string | null {
  const searchable = `${title} ${content}`.trim();
  if (!searchable) return null;
  const match = searchable.match(ERROR_PAGE_RE);
  return match ? match[0] : null;
}

// A 2xx status does not guarantee that the body carries useful content.
// Treat empty / whitespace-only / near-empty bodies without a title as failures.
function isContentMeaningful(content: string, title: string): boolean {
  const text = (content || '').trim();
  const pageTitle = (title || '').trim();

  // Empty or whitespace-only body with no page title.
  if (!text && !pageTitle) return false;

  // A very short body with no title is unlikely to carry useful content.
  if (text.length < 50 && !pageTitle) return false;

  return true;
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

      // Plain readable text only — the static path must not return page structure.
      const { text: content, interactiveCount } = htmlToPlainText(html, 100000);

      // A 2xx status does not guarantee useful content; validate before reporting success.
      if (!isContentMeaningful(content, title)) {
        return {
          id: task.id,
          url: task.url,
          success: false,
          error: 'Empty response: server returned success status but no readable content',
          durationMs: Date.now() - startTime,
        };
      }

      // Detect error / bot-block pages served with a 2xx status.
      const errorSignal = matchErrorPageSignal(title, content);
      if (errorSignal) {
        return {
          id: task.id,
          url: task.url,
          success: false,
          error: `Error page detected: ${errorSignal}`,
          durationMs: Date.now() - startTime,
        };
      }

      return {
        id: task.id,
        url: task.url,
        success: true,
        title,
        content,
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