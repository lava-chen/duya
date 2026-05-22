/**
 * Google Search Content Extractor
 * Extracts search results with titles, links, and snippets
 */

import { BaseExtractor } from '../BaseExtractor.js';
import type { ICDPClient } from '../../CDPClient.js';
import type { PlatformContent, ExtractionOptions } from '../types.js';

interface GoogleResult {
  kind: 'ok' | 'error';
  text?: string;
  title?: string;
  detail?: string;
}

export class GoogleSearchExtractor extends BaseExtractor {
  name = 'google-search';

  private hosts = ['google.com', 'www.google.com', 'google.co.jp', 'www.google.co.jp',
    'google.com.hk', 'www.google.com.hk', 'google.cn', 'www.google.cn',
    'bing.com', 'www.bing.com', 'baidu.com', 'www.baidu.com'];

  matches(url: string): boolean {
    const parsed = this.parseUrl(url);
    if (!parsed) return false;

    // Match search result pages
    const isSearch = parsed.searchParams.has('q') ||
                     parsed.pathname.includes('/search') ||
                     parsed.hostname.includes('google') ||
                     parsed.hostname.includes('bing') ||
                     parsed.hostname.includes('baidu');
    return isSearch;
  }

  async extract(cdp: ICDPClient, url: string, options?: ExtractionOptions): Promise<PlatformContent> {
    const parsed = this.parseUrl(url);
    if (!parsed) {
      return this.error('google-search', 'Invalid URL');
    }

    try {
      const query = parsed.searchParams.get('q') || '';
      const hostname = parsed.hostname;

      if (hostname.includes('google')) {
        return this.extractGoogle(cdp, url, query, options);
      } else if (hostname.includes('bing')) {
        return this.extractBing(cdp, url, query, options);
      } else if (hostname.includes('baidu')) {
        return this.extractBaidu(cdp, url, query, options);
      }

      return this.extractGeneric(cdp, url, options);
    } catch (e) {
      return this.error('google-search', `Extraction failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  private async extractGoogle(cdp: ICDPClient, url: string, query: string, options?: ExtractionOptions): Promise<PlatformContent> {
    const maxLength = options?.maxLength ?? 15000;

    const script = `
      (async () => {
        const maxLength = ${maxLength};

        // Wait for page to load
        await new Promise(r => setTimeout(r, 500));

        // Check if we're on a Google search page
        const isGoogleSearch = window.location.hostname.includes('google') &&
                              window.location.pathname.includes('/search');
        if (!isGoogleSearch) {
          return { kind: 'error', detail: 'Not a Google search page' };
        }

        // Get search info
        const searchInfo = document.querySelector('#result-stats')?.textContent?.trim() || '';

        // Get main results - try multiple selectors
        const results = [];
        let resultEls = document.querySelectorAll('div.g');

        // If no results, try alternative selectors
        if (resultEls.length === 0) {
          resultEls = document.querySelectorAll('[data-sncf], [data-hveid]');
        }

        // Try more selectors
        if (resultEls.length === 0) {
          resultEls = document.querySelectorAll('div[data-hveid]');
        }

        for (let i = 0; i < Math.min(resultEls.length, 20); i++) {
          const el = resultEls[i];

          // Title and link
          const titleEl = el.querySelector('h3') || el.querySelector('[role="heading"]') || el.querySelector('a h3');
          const linkEl = titleEl?.closest('a') || el.querySelector('a[href*="url="]') || el.querySelector('div a[href]');

          let title = '';
          let link = '';

          if (titleEl) {
            title = titleEl.textContent?.trim() || '';
          }
          if (linkEl) {
            const href = linkEl.href || '';
            // Decode URL if encoded
            try {
              const urlMatch = href.match(/url=([^&]+)/);
              if (urlMatch) {
                link = decodeURIComponent(urlMatch[1]);
              } else if (href.startsWith('http') && !href.includes('google.com')) {
                link = href;
              }
            } catch {}

            if (!link) {
              link = href;
            }
          }

          // Snippet
          const snippetEl = el.querySelector('[data-sncf], [role="textbox"]') ||
                          el.querySelector('div[data-content-feature="1"]') ||
                          el.querySelector('.VwiC3b') ||
                          el.querySelector('span:last-child');
          let snippet = snippetEl?.textContent?.trim() || '';

          // Get additional info
          const siteEl = el.querySelector('cite') || el.querySelector('.iUh30');
          const site = siteEl?.textContent?.trim() || '';

          if (title || link) {
            results.push({ title, link, snippet: snippet.substring(0, 300), site });
          }
        }

        // Get "People also ask" section
        const paaEls = document.querySelectorAll('. RelatedQuestion');
        const paaResults = [];
        for (let i = 0; i < Math.min(paaEls.length, 5); i++) {
          const el = paaEls[i];
          const question = el.querySelector('.question')?.textContent?.trim() || '';
          const answer = el.querySelector('.answer')?.textContent?.trim() || '';
          if (question) {
            paaResults.push({ question, answer: answer.substring(0, 200) });
          }
        }

        // Build output
        const lines = [];
        lines.push('# Search Results: ' + query);
        lines.push('');

        if (searchInfo) {
          lines.push('**' + searchInfo + '**');
          lines.push('');
        }

        lines.push('**URL:** ' + url);
        lines.push('');

        if (results.length > 0) {
          lines.push('---');
          lines.push('');
          lines.push('## Results (' + results.length + ')');
          lines.push('');

          for (let i = 0; i < results.length; i++) {
            const r = results[i];
            lines.push((i + 1) + '. **' + r.title + '**');
            if (r.site) lines.push('   ' + r.site);
            if (r.link) lines.push('   ' + r.link.substring(0, 100));
            if (r.snippet) lines.push('   ' + r.snippet);
            lines.push('');
          }
        }

        if (paaResults.length > 0) {
          lines.push('---');
          lines.push('');
          lines.push('## People Also Ask');
          lines.push('');

          for (const p of paaResults) {
            lines.push('**Q:** ' + p.question);
            lines.push('**A:** ' + p.answer);
            lines.push('');
          }
        }

        let text = lines.join('\\n');
        if (text.length > maxLength) {
          text = text.substring(0, maxLength) + '\\n\\n*[Results truncated]*';
        }

        return {
          kind: 'ok',
          text: text,
          title: 'Search: ' + query
        };
      })()
    `;

    try {
      const result = await cdp.evaluate(script);
      if (result && typeof result === 'object' && 'kind' in result) {
        return this.success('google-search', (result as GoogleResult).text || '', undefined, {
          title: (result as GoogleResult).title
        });
      }
      return this.error('google-search', 'Unexpected result format');
    } catch (e) {
      return this.error('google-search', `Evaluation error: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  private async extractBing(cdp: ICDPClient, url: string, query: string, options?: ExtractionOptions): Promise<PlatformContent> {
    const maxLength = options?.maxLength ?? 15000;

    const script = `
      (async () => {
        const maxLength = ${maxLength};

        const searchInfo = document.querySelector('#b_context .b_highlight')?.textContent?.trim() || '';

        const results = [];
        const resultEls = document.querySelectorAll('li.b_algo');

        for (let i = 0; i < Math.min(resultEls.length, 20); i++) {
          const el = resultEls[i];
          const titleEl = el.querySelector('h2') || el.querySelector('a');
          const title = titleEl?.textContent?.trim() || '';
          const link = el.querySelector('a')?.href || '';
          const snippetEl = el.querySelector('.b_desc') || el.querySelector('p');
          const snippet = snippetEl?.textContent?.trim() || '';

          if (title) {
            results.push({ title, link, snippet: snippet.substring(0, 300) });
          }
        }

        const lines = [];
        lines.push('# Bing Results: ' + query);
        lines.push('');
        lines.push('**URL:** ' + url);
        lines.push('');

        if (results.length > 0) {
          lines.push('---');
          lines.push('');
          lines.push('## Results (' + results.length + ')');
          lines.push('');

          for (let i = 0; i < results.length; i++) {
            const r = results[i];
            lines.push((i + 1) + '. **' + r.title + '**');
            if (r.link) lines.push('   ' + r.link.substring(0, 100));
            if (r.snippet) lines.push('   ' + r.snippet);
            lines.push('');
          }
        }

        let text = lines.join('\\n');
        if (text.length > maxLength) {
          text = text.substring(0, maxLength) + '\\n\\n*[Results truncated]*';
        }

        return {
          kind: 'ok',
          text: text,
          title: 'Search: ' + query
        };
      })()
    `;

    try {
      const result = await cdp.evaluate(script);
      if (result && typeof result === 'object' && 'kind' in result) {
        return this.success('google-search', (result as GoogleResult).text || '', undefined, {
          title: (result as GoogleResult).title
        });
      }
      return this.error('google-search', 'Unexpected result format');
    } catch (e) {
      return this.error('google-search', `Evaluation error: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  private async extractBaidu(cdp: ICDPClient, url: string, query: string, options?: ExtractionOptions): Promise<PlatformContent> {
    const maxLength = options?.maxLength ?? 15000;

    const script = `
      (async () => {
        const maxLength = ${maxLength};

        const results = [];
        const resultEls = document.querySelectorAll('.result, .c-container');

        for (let i = 0; i < Math.min(resultEls.length, 20); i++) {
          const el = resultEls[i];
          const titleEl = el.querySelector('h3') || el.querySelector('.t') || el.querySelector('a');
          const title = titleEl?.textContent?.trim() || '';
          const linkEl = titleEl?.closest('a') || el.querySelector('a[href*="http"]');
          const link = linkEl?.href || '';
          const snippetEl = el.querySelector('.c-abstract') || el.querySelector('.content-right_8Zs40') || el.querySelector('p');
          const snippet = snippetEl?.textContent?.trim() || '';

          if (title) {
            results.push({ title, link, snippet: snippet.substring(0, 300) });
          }
        }

        const lines = [];
        lines.push('# 百度搜索: ' + query);
        lines.push('');
        lines.push('**URL:** ' + url);
        lines.push('');

        if (results.length > 0) {
          lines.push('---');
          lines.push('');
          lines.push('## 结果 (' + results.length + ')');
          lines.push('');

          for (let i = 0; i < results.length; i++) {
            const r = results[i];
            lines.push((i + 1) + '. **' + r.title + '**');
            if (r.link) lines.push('   ' + r.link.substring(0, 100));
            if (r.snippet) lines.push('   ' + r.snippet);
            lines.push('');
          }
        }

        let text = lines.join('\\n');
        if (text.length > maxLength) {
          text = text.substring(0, maxLength) + '\\n\\n*[结果已截断]*';
        }

        return {
          kind: 'ok',
          text: text,
          title: '搜索: ' + query
        };
      })()
    `;

    try {
      const result = await cdp.evaluate(script);
      if (result && typeof result === 'object' && 'kind' in result) {
        return this.success('google-search', (result as GoogleResult).text || '', undefined, {
          title: (result as GoogleResult).title
        });
      }
      return this.error('google-search', 'Unexpected result format');
    } catch (e) {
      return this.error('google-search', `Evaluation error: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  private async extractGeneric(cdp: ICDPClient, url: string, options?: ExtractionOptions): Promise<PlatformContent> {
    const maxLength = options?.maxLength ?? 10000;

    const script = `
      (async () => {
        const maxLength = ${maxLength};

        // Extract any links on the page
        const links = [];
        const linkEls = document.querySelectorAll('a[href*="http"]');

        for (let i = 0; i < Math.min(linkEls.length, 30); i++) {
          const el = linkEls[i];
          const text = el.textContent?.trim() || '';
          const href = el.href || '';

          if (text && href && !href.includes('google.com') && !href.includes('bing.com')) {
            links.push({ text: text.substring(0, 100), href });
          }
        }

        const lines = [];
        lines.push('# Page: ' + document.title);
        lines.push('');
        lines.push('**URL:** ' + url);
        lines.push('');

        if (links.length > 0) {
          lines.push('## Links (' + links.length + ')');
          lines.push('');

          for (const l of links) {
            lines.push('- [' + l.text + '](' + l.href + ')');
          }
        }

        let text = lines.join('\\n');
        if (text.length > maxLength) {
          text = text.substring(0, maxLength) + '\\n\\n*[Content truncated]*';
        }

        return {
          kind: 'ok',
          text: text,
          title: document.title
        };
      })()
    `;

    try {
      const result = await cdp.evaluate(script);
      if (result && typeof result === 'object' && 'kind' in result) {
        return this.success('google-search', (result as GoogleResult).text || '', undefined, {
          title: (result as GoogleResult).title
        });
      }
      return this.error('google-search', 'Unexpected result format');
    } catch (e) {
      return this.error('google-search', `Evaluation error: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}

export const googleSearchExtractor = new GoogleSearchExtractor();
