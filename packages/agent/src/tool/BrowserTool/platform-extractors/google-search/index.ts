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

    const script = [
      '(async () => {',
      '  const maxLength = ' + maxLength + ';',
      '  const query = ' + JSON.stringify(query) + ';',
      '  const url = ' + JSON.stringify(url) + ';',
      '  try {',
      "    await new Promise(r => setTimeout(r, 500));",
      "    if (!window.location.hostname.includes('google') || !window.location.pathname.includes('/search')) {",
      "      return { kind: 'error', detail: 'Not a Google search page' };",
      '    }',
      "    const searchInfo = (document.querySelector('#result-stats') || document.querySelector('.fBTc4'))?.textContent?.trim() || '';",
      '    const results = [];',
      // Use more specific selectors for Google search results
      "    const resultEls = document.querySelectorAll('div.g[data-hveid], div[data-hveid] > div:first-child, div.BmP5Ef');",
      "    // Alternative selectors if main ones don't work",
      "    const altResultEls = document.querySelectorAll('div[data-hveid]');",
      "    const allResults = resultEls.length > 0 ? resultEls : altResultEls;",
      '    for (let i = 0; i < Math.min(allResults.length, 20); i++) {',
      '      const el = allResults[i];',
      // Skip elements that contain accessibility or utility text
      "      const elText = el.textContent?.trim() || '';",
      "      if (elText.includes('选择您要针对哪个元素') || elText.includes('无障碍功能') || elText.length < 20) continue;",
      "      const titleEl = el.querySelector('h3') || el.querySelector('[role=heading]') || el.querySelector('a h3') || el.querySelector('a');",
      "      const linkEl = titleEl?.closest('a') || el.querySelector('a[href][data-hveid]');",
      '      const title = titleEl?.textContent?.trim() || "";',
      '      let link = "";',
      "      if (linkEl) { const href = linkEl.href || ''; if (href && !href.includes('google.com/url') && !href.includes('google.com/search')) link = href; }",
      // Get snippet from multiple possible locations
      "      const snippet = (el.querySelector('.VwiC3b') || el.querySelector('[data-sncf]') || el.querySelector('.style-scope') || el.querySelector('span:not([class])'))?.textContent?.trim() || '';",
      // Get site info - try to get the actual domain from the URL or visible text
      "      const siteEl = el.querySelector('cite') || el.querySelector('.iUh30') || el.querySelector('[role=text]');",
      '      let site = siteEl?.textContent?.trim() || "";',
      // Extract domain from URL if site text is not helpful
      "      if (link && !site) { try { const u = new URL(link); site = u.hostname.replace('www.', ''); } catch {} }",
      '      if (title && link) results.push({ title: title.substring(0, 200), link, snippet: snippet.substring(0, 300), site });',
      '    }',
      '    const paaEls = document.querySelectorAll(".RelatedQuestion");',
      '    const paaResults = [];',
      '    for (let i = 0; i < Math.min(paaEls.length, 5); i++) {',
      '      const el = paaEls[i];',
      "      const question = el.querySelector('.question')?.textContent?.trim() || '';",
      "      const answer = el.querySelector('.answer')?.textContent?.trim() || '';",
      '      if (question) { paaResults.push({ question, answer: answer.substring(0, 200) }); }',
      '    }',
      '    const lines = [];',
      "    lines.push('# Search Results: ' + query);",
      '    lines.push("");',
      '    if (searchInfo) {',
      "      lines.push('**' + searchInfo + '**');",
      '      lines.push("");',
      '    }',
      "    lines.push('**URL:** ' + url);",
      '    lines.push("");',
      '    if (results.length > 0) {',
      "      lines.push('---');",
      '      lines.push("");',
      "      lines.push('## Results (' + results.length + ')');",
      '      lines.push("");',
      '      for (let i = 0; i < results.length; i++) {',
      '        const r = results[i];',
      "        lines.push((i + 1) + '. **' + r.title + '**');",
      '        if (r.site) lines.push("   " + r.site);',
      '        if (r.link) lines.push("   " + r.link.substring(0, 100));',
      '        if (r.snippet) lines.push("   " + r.snippet);',
      '        lines.push("");',
      '      }',
      '    } else {',
      "      lines.push('No search results found - page may still be loading');",
      '      lines.push("");',
      '    }',
      '    if (paaResults.length > 0) {',
      "      lines.push('---');",
      '      lines.push("");',
      "      lines.push('## People Also Ask');",
      '      lines.push("");',
      '      for (const p of paaResults) {',
      "        lines.push('**Q:** ' + p.question);",
      "        lines.push('**A:** ' + p.answer);",
      '        lines.push("");',
      '      }',
      '    }',
      '    let text = lines.join("\\n");',
      '    if (text.length > maxLength) {',
      "      text = text.substring(0, maxLength) + '\\n\\n*[Results truncated]*';",
      '    }',
      "    return { kind: 'ok', text, title: 'Search: ' + query };",
      '  } catch(e) {',
      "    return { kind: 'error', detail: e.message || String(e) };",
      '  }',
      '})()',
    ].join('');

    try {
      console.log('[GoogleSearchExtractor] Starting extraction, URL:', url);
      const result = await cdp.evaluate(script);
      console.log('[GoogleSearchExtractor] Raw result:', JSON.stringify(result));
      if (result && typeof result === 'object' && 'kind' in result) {
        const googleResult = result as GoogleResult;
        if (googleResult.kind === 'ok' && googleResult.text) {
          return this.success('google-search', googleResult.text, undefined, {
            title: googleResult.title
          });
        } else if (googleResult.kind === 'error') {
          return this.error('google-search', googleResult.detail || 'Unknown error');
        }
      }
      return this.error('google-search', 'Unexpected result format');
    } catch (e) {
      return this.error('google-search', `Evaluation error: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  private async extractBing(cdp: ICDPClient, url: string, query: string, options?: ExtractionOptions): Promise<PlatformContent> {
    const maxLength = options?.maxLength ?? 15000;

    const script = [
      '(async () => {',
      '  const maxLength = ' + maxLength + ';',
      "  const searchInfo = document.querySelector('#b_context .b_highlight')?.textContent?.trim() || '';",
      '  const results = [];',
      "  const resultEls = document.querySelectorAll('li.b_algo');",
      '  for (let i = 0; i < Math.min(resultEls.length, 20); i++) {',
      '    const el = resultEls[i];',
      "    const titleEl = el.querySelector('h2') || el.querySelector('a');",
      '    const title = titleEl?.textContent?.trim() || "";',
      "    const link = el.querySelector('a')?.href || '';",
      "    const snippetEl = el.querySelector('.b_desc') || el.querySelector('p');",
      '    const snippet = snippetEl?.textContent?.trim() || "";',
      '    if (title) { results.push({ title, link, snippet: snippet.substring(0, 300) }); }',
      '  }',
      '  const lines = [];',
      "  lines.push('# Bing Results: ' + query);",
      '  lines.push("");',
      "  lines.push('**URL:** ' + url);",
      '  lines.push("");',
      '  if (results.length > 0) {',
      "    lines.push('---');",
      '    lines.push("");',
      "    lines.push('## Results (' + results.length + ')');",
      '    lines.push("");',
      '    for (let i = 0; i < results.length; i++) {',
      '      const r = results[i];',
      "      lines.push((i + 1) + '. **' + r.title + '**');",
      '      if (r.link) lines.push("   " + r.link.substring(0, 100));',
      '      if (r.snippet) lines.push("   " + r.snippet);',
      '      lines.push("");',
      '    }',
      '  } else {',
      "    lines.push('No search results found');",
      '    lines.push("");',
      '  }',
      '  let text = lines.join("\\n");',
      '  if (text.length > maxLength) {',
      "    text = text.substring(0, maxLength) + '\\n\\n*[Results truncated]*';",
      '  }',
      "  return { kind: 'ok', text, title: 'Search: ' + query };",
      '})()',
    ].join('');

    try {
      console.log('[GoogleSearchExtractor] Starting extraction, URL:', url);
      const result = await cdp.evaluate(script);
      console.log('[GoogleSearchExtractor] Raw result:', JSON.stringify(result));
      if (result && typeof result === 'object' && 'kind' in result) {
        const googleResult = result as GoogleResult;
        if (googleResult.kind === 'ok' && googleResult.text) {
          return this.success('google-search', googleResult.text, undefined, {
            title: googleResult.title
          });
        } else if (googleResult.kind === 'error') {
          return this.error('google-search', googleResult.detail || 'Unknown error');
        }
      }
      return this.error('google-search', 'Unexpected result format');
    } catch (e) {
      return this.error('google-search', `Evaluation error: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  private async extractBaidu(cdp: ICDPClient, url: string, query: string, options?: ExtractionOptions): Promise<PlatformContent> {
    const maxLength = options?.maxLength ?? 15000;

    const script = [
      '(async () => {',
      '  const maxLength = ' + maxLength + ';',
      '  const results = [];',
      "  const resultEls = document.querySelectorAll('.result, .c-container');",
      '  for (let i = 0; i < Math.min(resultEls.length, 20); i++) {',
      '    const el = resultEls[i];',
      "    const titleEl = el.querySelector('h3') || el.querySelector('.t') || el.querySelector('a');",
      '    const title = titleEl?.textContent?.trim() || "";',
      "    const linkEl = titleEl?.closest('a') || el.querySelector('a[href*=\"http\"]');",
      '    const link = linkEl?.href || "";',
      "    const snippetEl = el.querySelector('.c-abstract') || el.querySelector('.content-right_8Zs40') || el.querySelector('p');",
      '    const snippet = snippetEl?.textContent?.trim() || "";',
      '    if (title) { results.push({ title, link, snippet: snippet.substring(0, 300) }); }',
      '  }',
      '  const lines = [];',
      "  lines.push('# 百度搜索: ' + query);",
      '  lines.push("");',
      "  lines.push('**URL:** ' + url);",
      '  lines.push("");',
      '  if (results.length > 0) {',
      "    lines.push('---');",
      '    lines.push("");',
      "    lines.push('## 结果 (' + results.length + ')');",
      '    lines.push("");',
      '    for (let i = 0; i < results.length; i++) {',
      '      const r = results[i];',
      "      lines.push((i + 1) + '. **' + r.title + '**');",
      '      if (r.link) lines.push("   " + r.link.substring(0, 100));',
      '      if (r.snippet) lines.push("   " + r.snippet);',
      '      lines.push("");',
      '    }',
      '  }',
      '  let text = lines.join("\\n");',
      '  if (text.length > maxLength) {',
      "    text = text.substring(0, maxLength) + '\\n\\n*[结果已截断]*';",
      '  }',
      "  return { kind: 'ok', text, title: '搜索: ' + query };",
      '})()',
    ].join('');

    try {
      console.log('[GoogleSearchExtractor] Starting extraction, URL:', url);
      const result = await cdp.evaluate(script);
      console.log('[GoogleSearchExtractor] Raw result:', JSON.stringify(result));
      if (result && typeof result === 'object' && 'kind' in result) {
        const googleResult = result as GoogleResult;
        if (googleResult.kind === 'ok' && googleResult.text) {
          return this.success('google-search', googleResult.text, undefined, {
            title: googleResult.title
          });
        } else if (googleResult.kind === 'error') {
          return this.error('google-search', googleResult.detail || 'Unknown error');
        }
      }
      return this.error('google-search', 'Unexpected result format');
    } catch (e) {
      return this.error('google-search', `Evaluation error: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  private async extractGeneric(cdp: ICDPClient, url: string, options?: ExtractionOptions): Promise<PlatformContent> {
    const maxLength = options?.maxLength ?? 10000;

    const script = [
      '(async () => {',
      '  const maxLength = ' + maxLength + ';',
      '  const links = [];',
      "  const linkEls = document.querySelectorAll('a[href*=\"http\"]');",
      '  for (let i = 0; i < Math.min(linkEls.length, 30); i++) {',
      '    const el = linkEls[i];',
      '    const text = el.textContent?.trim() || "";',
      '    const href = el.href || "";',
      "    if (text && href && !href.includes('google.com') && !href.includes('bing.com')) {",
      '      links.push({ text: text.substring(0, 100), href });',
      '    }',
      '  }',
      '  const lines = [];',
      '  lines.push("# Page: " + document.title);',
      '  lines.push("");',
      '  lines.push("**URL:** " + url);',
      '  lines.push("");',
      '  if (links.length > 0) {',
      '    lines.push("## Links (" + links.length + ")");',
      '    lines.push("");',
      '    for (const l of links) {',
      '      lines.push("- [" + l.text + "](" + l.href + ")");',
      '    }',
      '  }',
      '  let text = lines.join("\\n");',
      '  if (text.length > maxLength) {',
      "    text = text.substring(0, maxLength) + '\\n\\n*[Content truncated]*';",
      '  }',
      '  return { kind: "ok", text, title: document.title };',
      '})()',
    ].join('');

    try {
      console.log('[GoogleSearchExtractor] Starting extraction, URL:', url);
      const result = await cdp.evaluate(script);
      console.log('[GoogleSearchExtractor] Raw result:', JSON.stringify(result));
      if (result && typeof result === 'object' && 'kind' in result) {
        const googleResult = result as GoogleResult;
        if (googleResult.kind === 'ok' && googleResult.text) {
          return this.success('google-search', googleResult.text, undefined, {
            title: googleResult.title
          });
        } else if (googleResult.kind === 'error') {
          return this.error('google-search', googleResult.detail || 'Unknown error');
        }
      }
      return this.error('google-search', 'Unexpected result format');
    } catch (e) {
      return this.error('google-search', `Evaluation error: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}

export const googleSearchExtractor = new GoogleSearchExtractor();