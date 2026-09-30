/**
 * arXiv Content Extractor
 * Extracts paper metadata via arXiv API first, falls back to DOM extraction
 *
 * arXiv exposes a public Atom/XML API — no key required.
 * https://info.arxiv.org/help/api/index.html
 */

import { BaseExtractor } from '../BaseExtractor.js';
import type { ICDPClient } from '../../CDPClient.js';
import type { PlatformContent, ExtractionOptions } from '../types.js';

interface ArxivEntry {
  id: string;
  title: string;
  authors: string;
  abstract: string;
  published: string;
  updated: string;
  primary_category: string;
  categories: string;
  comment: string;
  pdf: string;
  url: string;
}

interface ArxivResult {
  kind: 'ok' | 'error';
  text?: string;
  title?: string;
  detail?: string;
}

export class ArxivExtractor extends BaseExtractor {
  name = 'arxiv';

  private readonly hosts = ['arxiv.org', 'www.arxiv.org', 'export.arxiv.org'];

  matches(url: string): boolean {
    const parsed = this.parseUrl(url);
    if (!parsed) return false;
    return this.hosts.some(
      (host) => parsed.hostname === host || parsed.hostname.endsWith(`.${host}`)
    );
  }

  async extract(cdp: ICDPClient, url: string, options?: ExtractionOptions): Promise<PlatformContent> {
    const parsed = this.parseUrl(url);
    if (!parsed) {
      return this.error('arxiv', 'Invalid URL');
    }

    try {
      // 1. Try arXiv API first (fast, structured, reliable)
      const apiResult = await this.extractViaApi(parsed, url, options);
      if (apiResult && apiResult.success) {
        return apiResult;
      }

      // 2. Fallback to DOM extraction
      console.log('[ArxivExtractor] API extraction failed or returned empty, falling back to DOM');
      return await this.extractViaDom(cdp, url, options);
    } catch (e) {
      return this.error('arxiv', `Extraction failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // ─── API Extraction ──────────────────────────────────────────────────────

  private async extractViaApi(parsed: URL, url: string, options?: ExtractionOptions): Promise<PlatformContent | null> {
    const maxLength = options?.maxLength ?? 15000;

    let apiUrl: string | null = null;
    let pageType: 'paper' | 'search' | 'list' = 'search';

    const pathname = parsed.pathname;
    const searchParams = parsed.searchParams;

    // Paper detail page: /abs/1706.03762
    if (pathname.includes('/abs/')) {
      const id = pathname.split('/abs/')[1]?.split('/')[0]?.replace(/v\d+$/, '');
      if (id) {
        apiUrl = `https://export.arxiv.org/api/query?id_list=${encodeURIComponent(id)}`;
        pageType = 'paper';
      }
    }
    // Search page: /search?query=...&searchtype=...
    else if (pathname.includes('/search') || searchParams.has('query') || searchParams.has('searchtype') || searchParams.has('search_query')) {
      const query = searchParams.get('query') || searchParams.get('search_query') || '';
      if (query) {
        apiUrl = `https://export.arxiv.org/api/query?search_query=all:${encodeURIComponent(query)}&max_results=10&sortBy=relevance`;
        pageType = 'search';
      }
    }
    // Recent/list page: /list/cs/recent
    else if (pathname.includes('/list/')) {
      const categoryMatch = pathname.match(/\/list\/([^/]+)/);
      if (categoryMatch) {
        const category = categoryMatch[1];
        apiUrl = `https://export.arxiv.org/api/query?search_query=cat:${encodeURIComponent(category)}&max_results=10&sortBy=submittedDate&sortOrder=descending`;
        pageType = 'list';
      }
    }

    if (!apiUrl) {
      return null;
    }

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 10000);

      let resp: Response;
      try {
        resp = await fetch(apiUrl, { signal: controller.signal });
      } finally {
        clearTimeout(timeoutId);
      }

      if (resp.status === 429) {
        // Rate-limited. Honor Retry-After when present, else wait 2s, then
        // try once more before giving up. Two attempts is enough — sustained
        // 429s usually mean a runaway batch, and we should fall back to DOM
        // extraction instead of holding the pipeline.
        const retryAfterHeader = resp.headers.get('retry-after');
        const retryMs = retryAfterHeader
          ? Math.max(0, Number(retryAfterHeader) * 1000)
          : 2000;
        if (retryAfterHeader && Number.isNaN(retryAfterHeader)) {
          // Non-numeric Retry-After (HTTP-date) — fall back to a fixed delay.
          await this.sleep(2000);
        } else {
          await this.sleep(retryMs);
        }

        const retryController = new AbortController();
        const retryTimeoutId = setTimeout(() => retryController.abort(), 10000);
        try {
          resp = await fetch(apiUrl, { signal: retryController.signal });
        } finally {
          clearTimeout(retryTimeoutId);
        }

        if (!resp.ok) {
          if (resp.status === 429) {
            console.warn('[ArxivExtractor] API rate-limited (429), giving up after retry');
          } else {
            console.warn(`[ArxivExtractor] API HTTP ${resp.status} after retry`);
          }
          return null;
        }
      } else if (!resp.ok) {
        console.warn(`[ArxivExtractor] API HTTP ${resp.status}`);
        return null;
      }

      const xml = await resp.text();
      const entries = this.parseEntries(xml);

      if (!entries.length) {
        return null;
      }

      const text = this.formatEntries(entries, url, maxLength, pageType);
      return this.success('arxiv', text, undefined, { title: `arXiv ${pageType}` });
    } catch (e) {
      console.warn('[ArxivExtractor] API extraction error:', e);
      return null;
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  // ─── DOM Fallback Extraction ─────────────────────────────────────────────

  private async extractViaDom(cdp: ICDPClient, url: string, options?: ExtractionOptions): Promise<PlatformContent> {
    const maxLength = options?.maxLength ?? 15000;

    const script = `
      (async () => {
        const maxLength = ${maxLength};
        const pathname = window.location.pathname;
        const isSearch = pathname.includes('/search');
        const isAbs = pathname.includes('/abs/');
        const isList = pathname.includes('/list/');

        const lines = [];
        lines.push('# ' + document.title);
        lines.push('');
        lines.push('**URL:** ' + window.location.href);
        lines.push('');

        if (isSearch || isList) {
          const results = [];
          // arXiv search result selectors (multiple fallback selectors)
          const resultEls = document.querySelectorAll('li.arxiv-result, dl, .search-result, [class*="result"]');

          for (let i = 0; i < Math.min(resultEls.length, 15); i++) {
            const el = resultEls[i];
            const titleEl = el.querySelector('.title, .list-title, h3 a, dt a');
            const authorsEl = el.querySelector('.authors, .list-authors, .meta .author');
            const abstractEl = el.querySelector('.abstract, .abstract-short, p.abstract, dd');
            const linkEl = el.querySelector('a[href*="/abs/"]');

            const title = titleEl?.textContent?.trim().replace(/\\s+/g, ' ') || '';
            const authors = authorsEl?.textContent?.trim().replace(/\\s+/g, ' ') || '';
            const abstract = abstractEl?.textContent?.trim().replace(/\\s+/g, ' ') || '';
            const link = linkEl?.href || '';

            if (title && title.length > 5) {
              results.push({ title, authors, abstract, link });
            }
          }

          if (results.length > 0) {
            lines.push('## Results (' + results.length + ')');
            lines.push('');
            for (let i = 0; i < results.length; i++) {
              const r = results[i];
              lines.push((i + 1) + '. **' + r.title + '**');
              if (r.authors) lines.push('   Authors: ' + r.authors);
              if (r.abstract) lines.push('   ' + r.abstract.substring(0, 400));
              if (r.link) lines.push('   ' + r.link);
              lines.push('');
            }
          } else {
            // Last resort: grab main content area
            const main = document.querySelector('main, #content, .content, [role="main"]') || document.body;
            const text = main.innerText?.trim() || main.textContent?.trim() || '';
            if (text.length > 50) {
              lines.push(text.substring(0, 4000));
            } else {
              lines.push('*Could not extract content from page*');
            }
          }
        } else if (isAbs) {
          // Paper detail page
          const titleEl = document.querySelector('h1.title, .title.mathjax');
          const authorsEl = document.querySelector('.authors, .dateline');
          const abstractEl = document.querySelector('blockquote.abstract, .abstract, [class*="abstract"]');
          const metaEls = document.querySelectorAll('.metatable td, .dateline');

          const title = titleEl?.textContent?.trim().replace(/\\s+/g, ' ') || document.title;
          const authors = authorsEl?.textContent?.trim().replace(/\\s+/g, ' ') || '';
          const abstract = abstractEl?.textContent?.trim().replace(/\\s+/g, ' ') || '';

          let meta = '';
          for (const el of metaEls) {
            const text = el.textContent?.trim() || '';
            if (text && text.length > 3 && text.length < 500) {
              meta += text + ' ';
            }
          }

          lines.push('## ' + title);
          lines.push('');
          if (authors) {
            lines.push('**Authors:** ' + authors);
            lines.push('');
          }
          if (meta) {
            lines.push('**Meta:** ' + meta.trim());
            lines.push('');
          }
          if (abstract) {
            lines.push('**Abstract:**');
            lines.push(abstract);
          }
        } else {
          const main = document.querySelector('main, #content, [role="main"]') || document.body;
          const text = main.innerText?.trim() || main.textContent?.trim() || '';
          lines.push(text.substring(0, 4000));
        }

        let text = lines.join('\\n');
        if (text.length > maxLength) {
          text = text.substring(0, maxLength) + '\\n\\n*[Content truncated]*';
        }

        return { kind: 'ok', text, title: document.title };
      })()
    `;

    try {
      const result = await cdp.evaluate(script);
      if (result && typeof result === 'object' && 'kind' in result) {
        const r = result as ArxivResult;
        if (r.kind === 'ok' && r.text) {
          return this.success('arxiv', r.text, undefined, { title: r.title });
        } else if (r.kind === 'error') {
          return this.error('arxiv', r.detail || 'DOM extraction failed');
        }
      }
      return this.error('arxiv', 'Unexpected DOM result format');
    } catch (e) {
      return this.error('arxiv', `DOM extraction error: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // ─── XML Parsing (based on OpenCLI's approach) ───────────────────────────

  private parseEntries(xml: string): ArxivEntry[] {
    const entryRe = /<entry>([\s\S]*?)<\/entry>/g;
    const entries: ArxivEntry[] = [];
    let m;

    while ((m = entryRe.exec(xml)) !== null) {
      const e = m[1];
      const rawId = this.extractXml(e, 'id');
      const arxivId = rawId.replace(/^https?:\/\/arxiv\.org\/abs\//, '').replace(/v\d+$/, '');
      const pdf = this.findLinkHref(e, 'related') || `https://arxiv.org/pdf/${arxivId}`;

      entries.push({
        id: arxivId,
        title: this.decodeEntities(this.extractXml(e, 'title').replace(/\s+/g, ' ')),
        authors: this.decodeEntities(this.extractAllXml(e, 'name').join(', ')),
        abstract: this.decodeEntities(this.extractXml(e, 'summary').replace(/\s+/g, ' ')),
        published: this.extractXml(e, 'published').slice(0, 10),
        updated: this.extractXml(e, 'updated').slice(0, 10),
        primary_category: this.extractAttr(e, 'arxiv:primary_category', 'term'),
        categories: this.extractAllAttr(e, 'category', 'term').join(', '),
        comment: this.decodeEntities(this.extractXml(e, 'arxiv:comment').replace(/\s+/g, ' ')),
        pdf,
        url: `https://arxiv.org/abs/${arxivId}`,
      });
    }

    return entries;
  }

  private decodeEntities(s: string): string {
    return s
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'")
      .replace(/&#39;/g, "'");
  }

  private extractXml(xml: string, tag: string): string {
    const m = xml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`));
    return m ? m[1].trim() : '';
  }

  private extractAllXml(xml: string, tag: string): string[] {
    const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'g');
    const results: string[] = [];
    let m;
    while ((m = re.exec(xml)) !== null) {
      results.push(m[1].trim());
    }
    return results;
  }

  private extractAttr(xml: string, tag: string, attr: string): string {
    const m = xml.match(new RegExp(`<${tag}\\b[^>]*?\\b${attr}="([^"]*)"`));
    return m ? m[1] : '';
  }

  private extractAllAttr(xml: string, tag: string, attr: string): string[] {
    const re = new RegExp(`<${tag}\\b[^>]*?\\b${attr}="([^"]*)"`, 'g');
    const out: string[] = [];
    let m;
    while ((m = re.exec(xml)) !== null) {
      out.push(m[1]);
    }
    return out;
  }

  private findLinkHref(xml: string, rel: string): string {
    const re = /<link\b([^>]*)\/?>/g;
    let m;
    while ((m = re.exec(xml)) !== null) {
      const attrs = m[1];
      if (new RegExp(`\\brel="${rel}"`).test(attrs)) {
        const h = attrs.match(/\bhref="([^"]*)"/);
        if (h) return h[1];
      }
    }
    return '';
  }

  // ─── Formatting ──────────────────────────────────────────────────────────

  private formatEntries(entries: ArxivEntry[], url: string, maxLength: number, pageType: 'paper' | 'search' | 'list'): string {
    const lines: string[] = [];

    if (pageType === 'paper' && entries.length === 1) {
      const e = entries[0];
      lines.push(`# ${e.title}`);
      lines.push('');
      lines.push(`**arXiv ID:** ${e.id}`);
      lines.push(`**Authors:** ${e.authors}`);
      lines.push(`**Published:** ${e.published}`);
      if (e.updated !== e.published) lines.push(`**Updated:** ${e.updated}`);
      lines.push(`**Primary Category:** ${e.primary_category}`);
      if (e.categories && e.categories !== e.primary_category) {
        lines.push(`**Categories:** ${e.categories}`);
      }
      lines.push(`**PDF:** ${e.pdf}`);
      lines.push(`**URL:** ${e.url}`);
      if (e.comment) lines.push(`**Comments:** ${e.comment}`);
      lines.push('');
      lines.push('---');
      lines.push('');
      lines.push('## Abstract');
      lines.push('');
      lines.push(e.abstract);
    } else {
      // Search or list results
      const title = pageType === 'search' ? 'Search Results' : 'Recent Papers';
      lines.push(`# arXiv ${title}`);
      lines.push('');
      lines.push(`**Source:** ${url}`);
      lines.push(`**Count:** ${entries.length} papers`);
      lines.push('');
      lines.push('---');
      lines.push('');

      for (let i = 0; i < entries.length; i++) {
        const e = entries[i];
        lines.push(`${i + 1}. **${e.title}**`);
        lines.push(`   - **ID:** ${e.id}`);
        lines.push(`   - **Authors:** ${e.authors}`);
        lines.push(`   - **Published:** ${e.published} | **Category:** ${e.primary_category}`);
        lines.push(`   - **URL:** ${e.url}`);
        if (e.abstract) {
          const shortAbstract = e.abstract.length > 250 ? e.abstract.substring(0, 250) + '...' : e.abstract;
          lines.push(`   - **Abstract:** ${shortAbstract}`);
        }
        lines.push('');
      }
    }

    let text = lines.join('\n');
    if (text.length > maxLength) {
      text = text.substring(0, maxLength) + '\n\n*[Content truncated]*';
    }

    return text;
  }
}

export const arxivExtractor = new ArxivExtractor();
