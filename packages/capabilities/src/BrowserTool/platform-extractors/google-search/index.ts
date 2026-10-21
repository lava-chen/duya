/**
 * Search Engine SERP Content Extractor.
 * Extracts search results (titles, links, snippets) for google/bing/baidu/
 * brave/yahoo and renders them as a clean Markdown result list.
 *
 * Google extraction follows OpenCLI's resilient strategy: scope to #rso, find
 * every <a> containing an <h3>, walk up to the result container ([data-hveid])
 * to source the snippet, and additionally capture the featured snippet and
 * People-Also-Ask blocks — all typed so the renderer can lay them out.
 */

import { BaseExtractor } from '../BaseExtractor.js';
import type { ICDPClient } from '../../CDPClient.js';
import type { PlatformContent, ExtractionOptions } from '../types.js';

interface SerpItem {
  type?: 'snippet' | 'result' | 'paa';
  title: string;
  url: string;
  snippet: string;
}

interface GoogleResult {
  kind: 'ok' | 'error';
  text?: string;
  title?: string;
  detail?: string;
}

// ─── In-page collectors (typed item arrays) ────────────────────────────────
// Each body is injected after a short sleep inside a single async IIFE and
// must end with `return results;`.

const GOOGLE_COLLECT = `
  const results = [];
  const seen = {};
  const rso = document.querySelector('#rso');
  if (!rso) return results;

  // Featured / answer snippet block
  const fe = rso.querySelector('.xpdopen .hgKElc') || rso.querySelector('.IZ6rdc');
  if (fe) {
    const block = fe.closest('[data-hveid]') || fe.parentElement;
    const fLink = block ? block.querySelector('a[href]') : null;
    const fUrl = fLink ? fLink.href : '';
    if (fUrl) seen[fUrl] = true;
    results.push({ type: 'snippet', title: fe.textContent.trim().slice(0, 200), url: fUrl, snippet: '' });
  }

  // All links containing an h3 within #rso
  const links = rso.querySelectorAll('a');
  for (let i = 0; i < links.length; i++) {
    const a = links[i];
    const h3 = a.querySelector('h3');
    if (!h3) continue;
    const href = a.href || '';
    if (!/^https?:\\/\\//.test(href)) continue;
    if (href.indexOf('google.com/search') >= 0 || href.indexOf('google.com/url') >= 0) continue;
    if (seen[href]) continue;
    seen[href] = true;

    let c = a;
    for (let j = 0; j < 6; j++) {
      if (c.parentElement && c.parentElement !== rso) c = c.parentElement;
      if (c.getAttribute && c.getAttribute('data-hveid')) break;
    }

    const titleText = h3.textContent.trim();
    let sn = '';
    const cands = c.querySelectorAll('span, div');
    for (let k = 0; k < cands.length && !sn; k++) {
      const el = cands[k];
      if (el.querySelector('h3') || el.querySelector('a[href]')) continue;
      const t = el.textContent.trim();
      if (t.length < 40 || t.length > 500) continue;
      if (t === titleText) continue;
      if (t.indexOf('\u203a') >= 0) continue;
      if (new RegExp('https?://').test(t.slice(0, 60))) continue;
      sn = t;
    }

    results.push({ type: 'result', title: titleText.slice(0, 200), url: href, snippet: sn.slice(0, 300) });
  }

  // People Also Ask
  const paa = document.querySelectorAll('[data-sgrd="true"]');
  for (let i = 0; i < paa.length; i++) {
    const q = paa[i].querySelector('span.CSkcDe');
    if (q) results.push({ type: 'paa', title: q.textContent.trim().slice(0, 200), url: '', snippet: '' });
  }
  return results;
`;

const BRAVE_COLLECT = `
  const results = [];
  const items = document.querySelectorAll('.snippet');
  for (let i = 0; i < items.length; i++) {
    const el = items[i];
    if (el.classList.contains('standalone') || el.classList.contains('ad')) continue;
    const titleEl = el.querySelector('.search-snippet-title');
    if (!titleEl) continue;
    const linkEl = el.querySelector('.result-content a');
    const href = linkEl ? linkEl.href || '' : '';
    const snippetEl = el.querySelector('.generic-snippet .content');
    const snippet = snippetEl ? snippetEl.textContent.trim() : '';
    if (titleEl.textContent.trim() && href) {
      results.push({ type: 'result', title: titleEl.textContent.trim().slice(0, 200), url: href, snippet: snippet.slice(0, 300) });
    }
  }
  return results;
`;

const YAHOO_COLLECT = `
  const resolve = (href) => {
    if (!href) return '';
    const m = href.match(/RU=([^/]+)\\/RK=/);
    if (m && m[1]) { try { return decodeURIComponent(m[1]); } catch (e) {} }
    return href;
  };
  const results = [];
  const items = document.querySelectorAll('.algo');
  for (let i = 0; i < items.length; i++) {
    const el = items[i];
    const h3 = el.querySelector('h3');
    const linkEl = el.querySelector('.compTitle a');
    if (!h3 || !linkEl) continue;
    const href = resolve(linkEl.getAttribute('href') || '');
    const snippetEl = el.querySelector('.compText');
    const snippet = snippetEl ? snippetEl.textContent.trim() : '';
    if (h3.textContent.trim() && href) {
      results.push({ type: 'result', title: h3.textContent.trim().slice(0, 200), url: href, snippet: snippet.slice(0, 300) });
    }
  }
  return results;
`;

export class GoogleSearchExtractor extends BaseExtractor {
  name = 'google-search';

  private hosts = ['google.com', 'www.google.com', 'google.co.jp', 'www.google.co.jp',
    'google.com.hk', 'www.google.com.hk', 'google.cn', 'www.google.cn',
    'bing.com', 'www.bing.com', 'baidu.com', 'www.baidu.com',
    'search.brave.com', 'search.yahoo.com'];

  matches(url: string): boolean {
    const parsed = this.parseUrl(url);
    if (!parsed) return false;

    const isSearch = parsed.searchParams.has('q') ||
                     parsed.pathname.includes('/search') ||
                     parsed.hostname.includes('google') ||
                     parsed.hostname.includes('bing') ||
                     parsed.hostname.includes('baidu') ||
                     parsed.hostname.includes('brave') ||
                     parsed.hostname.includes('yahoo');
    return isSearch;
  }

  async extract(cdp: ICDPClient, url: string, options?: ExtractionOptions): Promise<PlatformContent> {
    const parsed = this.parseUrl(url);
    if (!parsed) {
      return this.error('google-search', 'Invalid URL');
    }

    try {
      const query = parsed.searchParams.get('q') || parsed.searchParams.get('p') || '';
      const hostname = parsed.hostname;

      if (hostname.includes('google')) {
        return this.extractGoogle(cdp, url, query, options);
      } else if (hostname.includes('brave')) {
        return this.extractWith(cdp, url, query, options, BRAVE_COLLECT, 'Brave Search Results');
      } else if (hostname.includes('yahoo')) {
        return this.extractWith(cdp, url, query, options, YAHOO_COLLECT, 'Yahoo Search Results');
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

  /**
   * Run an in-page collector that returns a typed item array.
   */
  private async collectSerp(cdp: ICDPClient, body: string): Promise<SerpItem[]> {
    const script = `(async () => { await new Promise(r => setTimeout(r, 500)); ${body} })()`;
    try {
      const res = await cdp.evaluate(script);
      return Array.isArray(res) ? (res as SerpItem[]) : [];
    } catch {
      return [];
    }
  }

  /**
   * Render typed SERP items as a clean Markdown result list.
   */
  private renderSearchList(query: string, url: string, items: SerpItem[], maxLength: number, heading: string): string {
    const lines: string[] = [];
    lines.push(`# ${heading}: ${query}`);
    lines.push('');
    lines.push(`**URL:** ${url}`);
    lines.push('');
    if (items.length === 0) {
      lines.push('No search results found - page may still be loading or blocked by consent/CAPTCHA.');
    } else {
      let n = 0;
      let paaStarted = false;
      for (const r of items) {
        if (r.type === 'snippet') {
          lines.push('');
          lines.push(`**Featured snippet:** ${r.title}`);
          if (r.url) lines.push(`  ${r.url}`);
        } else if (r.type === 'paa') {
          if (!paaStarted) {
            lines.push('');
            lines.push('## People Also Ask');
            paaStarted = true;
          }
          lines.push(`- ${r.title}`);
        } else {
          n++;
          lines.push('');
          lines.push(`${n}. **${r.title}**`);
          if (r.url) lines.push(`   ${r.url}`);
          if (r.snippet) lines.push(`   ${r.snippet}`);
        }
      }
    }
    let text = lines.join('\n');
    if (text.length > maxLength) text = text.substring(0, maxLength) + '\n\n*[Results truncated]*';
    return text;
  }

  private async extractGoogle(cdp: ICDPClient, url: string, query: string, options?: ExtractionOptions): Promise<PlatformContent> {
    const maxLength = options?.maxLength ?? 15000;
    const items = await this.collectSerp(cdp, GOOGLE_COLLECT);
    if (items.length === 0) {
      return this.error('google-search', 'No search results parsed on Google SERP');
    }
    const text = this.renderSearchList(query, url, items, maxLength, 'Google Search Results');
    return this.success('google-search', text, undefined, { title: `Search: ${query}` });
  }

  /**
   * Shared entry for engines that only produce standard `result` items.
   */
  private async extractWith(
    cdp: ICDPClient,
    url: string,
    query: string,
    options: ExtractionOptions | undefined,
    body: string,
    heading: string,
  ): Promise<PlatformContent> {
    const maxLength = options?.maxLength ?? 15000;
    const items = await this.collectSerp(cdp, body);
    if (items.length === 0) {
      return this.error('google-search', `No search results parsed on ${heading} SERP`);
    }
    const text = this.renderSearchList(query, url, items, maxLength, heading);
    return this.success('google-search', text, undefined, { title: `Search: ${query}` });
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