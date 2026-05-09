/**
 * FallbackBrowser - Lightweight browser fallback when Extension is not available
 * Uses cheerio + axios for static content extraction
 * No JavaScript execution, no login state, but fast and reliable
 */

import axios from 'axios';

export interface FallbackSnapshot {
  url: string;
  title: string;
  snapshot: string;
  interactiveElements: Array<{ ref: number; tag: string; text: string }>;
  truncated: boolean;
  source: 'fallback';
}

const FETCH_TIMEOUT = 15000;
const MAX_CONTENT_LENGTH = 500000;

/**
 * Fallback browser using regex-based static HTML parsing
 * No cheerio dependency - uses simple regex for cross-compatibility
 */
export class FallbackBrowser {
  private refCounter = 0;
  private lastHtml = '';
  private lastUrl = '';

  /**
   * Navigate and get snapshot
   */
  async navigate(url: string): Promise<FallbackSnapshot> {
    if (!url && this.lastUrl) {
      // Return cached snapshot
      return this.buildSnapshot(this.lastUrl, this.lastHtml);
    }

    const startTime = Date.now();

    try {
      const response = await axios.get(url, {
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
      this.lastHtml = html;
      this.lastUrl = url;

      return this.buildSnapshot(url, html);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      return {
        url,
        title: 'Error',
        snapshot: `Failed to load page: ${errorMessage}`,
        interactiveElements: [],
        truncated: false,
        source: 'fallback',
      };
    }
  }

  /**
   * Build snapshot from HTML
   */
  private buildSnapshot(url: string, html: string): FallbackSnapshot {
    const title = this.extractTitle(html) || url;
    const snapshot = this.htmlToSnapshot(html);
    const interactiveElements = this.extractInteractiveElements(html);

    return {
      url,
      title,
      snapshot,
      interactiveElements,
      truncated: snapshot.length > 100000,
      source: 'fallback',
    };
  }

  /**
   * Extract title from HTML
   */
  private extractTitle(html: string): string {
    const match = html.match(/<title[^>]*>([^<]*)<\/title>/i);
    return match ? match[1].trim() : '';
  }

  /**
   * Convert HTML to snapshot string
   */
  private htmlToSnapshot(html: string): string {
    // Remove script/style/noscript content
    let cleaned = html
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
      .replace(/<noscript[^>]*>[\s\S]*?<\/noscript>/gi, '');

    // Extract main content areas
    const mainContent = this.extractMainContent(cleaned);

    // Build snapshot
    this.refCounter = 0;
    return this.parseHTMLToSnapshot(mainContent, 0);
  }

  /**
   * Extract main content from HTML
   */
  private extractMainContent(html: string): string {
    const contentSelectors = [
      /<main[^>]*>([\s\S]*?)<\/main>/i,
      /<article[^>]*>([\s\S]*?)<\/article>/i,
      /<div[^>]*class="[^"]*(?:content|main|article)[^"]*"[^>]*>([\s\S]*?)<\/div>/i,
      /<section[^>]*>([\s\S]*?)<\/section>/i,
    ];

    for (const regex of contentSelectors) {
      const match = html.match(regex);
      if (match && match[1].length > 500) {
        return match[1];
      }
    }

    // Fallback: extract body content
    const bodyMatch = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
    return bodyMatch ? bodyMatch[1] : html;
  }

  /**
   * Parse HTML to snapshot string
   */
  private parseHTMLToSnapshot(html: string, depth: number): string {
    const indent = '  '.repeat(depth);
    let result = '';

    // Simple regex-based parsing
    const tagRegex = /<([a-z][a-z0-9]*)[^>]*>([\s\S]*?)<\/\1>|<([a-z][a-z0-9]*)[^>]*\/>/gi;
    let match;

    while ((match = tagRegex.exec(html)) !== null) {
      const tagName = (match[1] || match[3]).toLowerCase();
      const content = match[2] || '';
      const fullTag = match[0];

      // Skip hidden elements
      if (fullTag.includes('display:none') || fullTag.includes('visibility:hidden')) {
        continue;
      }

      // Skip void elements
      const voidElements = ['br', 'hr', 'meta', 'link'];
      if (voidElements.includes(tagName)) {
        continue;
      }

      // Handle images
      if (tagName === 'img') {
        const alt = fullTag.match(/alt="([^"]*)"/)?.[1] || '';
        const src = fullTag.match(/src="([^"]*)"/)?.[1] || '';
        result += `${indent}[Image: ${alt || src}]\n`;
        continue;
      }

      // Handle inputs
      if (tagName === 'input') {
        const type = fullTag.match(/type="([^"]*)"/)?.[1] || 'text';
        const placeholder = fullTag.match(/placeholder="([^"]*)"/)?.[1] || '';
        const value = fullTag.match(/value="([^"]*)"/)?.[1] || '';
        const ref = `[${++this.refCounter}]`;
        result += `${indent}<input type="${type}" placeholder="${placeholder}" value="${value}" ${ref}/>\n`;
        continue;
      }

      // Check if interactive
      const isInteractive = ['a', 'button', 'select', 'textarea'].includes(tagName) ||
        fullTag.includes('onclick=') ||
        fullTag.includes('role="button"');
      const ref = isInteractive ? `[${++this.refCounter}]` : '';

      // Extract attributes
      const attrs = this.extractAttributes(fullTag);

      // Get text content (strip nested tags)
      const textContent = this.stripTags(content).trim();

      if (!textContent && !content.includes('<')) {
        result += `${indent}<${tagName}${attrs}${ref}></${tagName}>\n`;
        continue;
      }

      if (!content.includes('<')) {
        result += `${indent}<${tagName}${attrs}${ref}>${textContent}</${tagName}>\n`;
        continue;
      }

      // Has nested elements
      result += `${indent}<${tagName}${attrs}${ref}>\n`;
      if (textContent) {
        result += `${indent}  ${textContent.slice(0, 200)}\n`;
      }

      // Recursively parse nested content (limit depth)
      if (depth < 5) {
        result += this.parseHTMLToSnapshot(content, depth + 1);
      }

      result += `${indent}</${tagName}>\n`;
    }

    return result;
  }

  /**
   * Extract important attributes
   */
  private extractAttributes(tag: string): string {
    const attrs: string[] = [];
    const importantAttrs = ['id', 'class', 'href', 'src', 'alt', 'title', 'placeholder', 'type', 'name'];

    for (const attr of importantAttrs) {
      const regex = new RegExp(`${attr}="([^"]*)"`, 'i');
      const match = tag.match(regex);
      if (match) {
        attrs.push(`${attr}="${match[1].slice(0, 100)}"`);
      }
    }

    return attrs.length > 0 ? ' ' + attrs.join(' ') : '';
  }

  /**
   * Strip HTML tags
   */
  private stripTags(html: string): string {
    return html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  }

  /**
   * Extract interactive elements
   */
  private extractInteractiveElements(html: string): Array<{ ref: number; tag: string; text: string }> {
    const elements: Array<{ ref: number; tag: string; text: string }> = [];
    let ref = 0;

    const interactiveRegex = /<(a|button|input|select|textarea)[^>]*>/gi;
    let match;

    while ((match = interactiveRegex.exec(html)) !== null) {
      const tag = match[1].toLowerCase();
      const fullTag = match[0];

      let text = '';
      if (tag === 'input') {
        text = fullTag.match(/placeholder="([^"]*)"/)?.[1] ||
               fullTag.match(/value="([^"]*)"/)?.[1] || '';
      } else {
        // Extract text from between tags
        const closeTag = `</${tag}>`;
        const startIdx = match.index;
        const endIdx = html.indexOf(closeTag, startIdx);
        if (endIdx > startIdx) {
          text = this.stripTags(html.slice(startIdx + fullTag.length, endIdx)).slice(0, 100);
        }
      }

      elements.push({ ref: ++ref, tag, text: text || `[${tag}]` });
    }

    return elements;
  }

  /**
   * Execute JavaScript (not supported in fallback)
   */
  async evaluate(_script: string): Promise<{ error: string; mode: string; suggestion: string }> {
    return {
      error: 'JavaScript evaluation not available in fallback mode',
      mode: 'fallback',
      suggestion: 'To enable JavaScript evaluation, install and enable the DUYA Browser Bridge Chrome extension. The extension connects to your Chrome browser and allows full JavaScript execution, cookie access, and interactive page manipulation.'
    };
  }

  /**
   * Click element (not supported in fallback)
   */
  async click(_ref: string): Promise<{ error: string }> {
    return { error: 'Element interaction not available in fallback mode. Use browser with Extension installed.' };
  }

  /**
   * Type text (not supported in fallback)
   */
  async type(_ref: string, _text: string): Promise<{ error: string }> {
    return { error: 'Element interaction not available in fallback mode. Use browser with Extension installed.' };
  }
}

export const fallbackBrowser = new FallbackBrowser();
export default FallbackBrowser;
