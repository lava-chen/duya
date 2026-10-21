/**
 * Wikipedia Extractor — full plain-text article via the page-language
 * MediaWiki API (action=query, prop=extracts, explaintext), without a browser.
 */

import { BaseExtractor } from '../BaseExtractor.js';
import type { ICDPClient } from '../../CDPClient.js';
import type { PlatformContent, ExtractionOptions } from '../types.js';
import { publicFetchJson } from '../_shared/public-api.js';

interface WikiPage {
  title?: string;
  pageid?: number;
  missing?: boolean;
  description?: string;
  extract?: string;
  fullurl?: string;
}

interface WikiResult {
  query?: { pages?: WikiPage[] };
}

export class WikipediaExtractor extends BaseExtractor {
  name = 'wikipedia';

  matches(url: string): boolean {
    try {
      return new URL(url).hostname.toLowerCase().endsWith('.wikipedia.org');
    } catch {
      return false;
    }
  }

  async extract(_cdp: ICDPClient, url: string, options?: ExtractionOptions): Promise<PlatformContent> {
    const maxLength = options?.maxLength ?? 20000;
    const parsed = this.parseUrl(url);
    if (!parsed) {
      return this.error('wikipedia', 'Invalid URL');
    }

    const m = parsed.pathname.match(/\/wiki\/([^/?#]+)/);
    const title = m ? decodeURIComponent(m[1]) : '';
    if (!title) {
      return this.error('wikipedia', 'Not a Wikipedia article URL (missing /wiki/Title)');
    }

    const api = new URL(`https://${parsed.hostname}/w/api.php`);
    api.searchParams.set('action', 'query');
    api.searchParams.set('format', 'json');
    api.searchParams.set('formatversion', '2');
    api.searchParams.set('prop', 'extracts|info|description');
    api.searchParams.set('inprop', 'url');
    api.searchParams.set('explaintext', '1');
    api.searchParams.set('redirects', '1');
    api.searchParams.set('titles', title);

    const res = await publicFetchJson<WikiResult>(api.toString(), { timeoutMs: 15000 });
    if (!res.ok || !res.data) {
      return this.error('wikipedia', res.error || `HTTP ${res.status}`);
    }
    const page = Array.isArray(res.data.query?.pages) ? res.data.query.pages[0] : undefined;
    if (!page || page.missing) {
      return this.error('wikipedia', `No article "${title}"`);
    }

    const body = String(page.extract ?? '').trim();
    if (!body) {
      return this.error('wikipedia', `Article "${title}" has no extractable content`);
    }

    const lines: string[] = [];
    lines.push(`# ${page.title || title}`);
    if (page.description) {
      lines.push(`> ${page.description}`);
      lines.push('');
    }
    lines.push(body);

    let text = lines.join('\n');
    if (text.length > maxLength) text = this.truncate(text, maxLength);
    return this.success('wikipedia', text, undefined, { title: page.title || title });
  }
}

export const wikipediaExtractor = new WikipediaExtractor();