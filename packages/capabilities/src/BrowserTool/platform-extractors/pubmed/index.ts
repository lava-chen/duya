/**
 * PubMed Extractor — article metadata (PMID, title, authors, journal, date,
 * type, DOI) via the NCBI E-utilities esummary JSON endpoint.
 */

import { BaseExtractor } from '../BaseExtractor.js';
import type { ICDPClient } from '../../CDPClient.js';
import type { PlatformContent, ExtractionOptions } from '../types.js';
import { publicFetchJson } from '../_shared/public-api.js';

interface PubmedAuthor {
  name?: string;
}

interface PubmedArticleId {
  idtype?: string;
  value?: string;
}

interface PubmedSummary {
  uid?: string;
  title?: string;
  authors?: PubmedAuthor[];
  fulljournalname?: string;
  source?: string;
  pubdate?: string;
  pubtype?: Array<string | { value?: string }>;
  articleids?: PubmedArticleId[];
}

interface ESummaryResult {
  result?: Record<string, PubmedSummary | undefined>;
}

const EUTILS_BASE = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils';

export class PubmedExtractor extends BaseExtractor {
  name = 'pubmed';

  matches(url: string): boolean {
    try {
      return new URL(url).hostname === 'pubmed.ncbi.nlm.nih.gov';
    } catch {
      return false;
    }
  }

  async extract(_cdp: ICDPClient, url: string, options?: ExtractionOptions): Promise<PlatformContent> {
    const maxLength = options?.maxLength ?? 15000;
    const parsed = this.parseUrl(url);
    const pmid = parsed?.pathname.split('/').filter(Boolean)[0] || '';
    if (!/^\d+$/.test(pmid)) {
      return this.error('pubmed', 'Not a PubMed article URL (missing numeric PMID)');
    }

    const api = `${EUTILS_BASE}/esummary.fcgi?db=pubmed&id=${pmid}&retmode=json`;
    const res = await publicFetchJson<ESummaryResult>(api, { timeoutMs: 15000 });
    if (!res.ok || !res.data?.result) {
      return this.error('pubmed', res.error || `HTTP ${res.status}`);
    }
    const art = res.data.result[pmid];
    if (!art || !art.uid) {
      return this.error('pubmed', `PMID ${pmid} not found`);
    }

    const authors = (art.authors || [])
      .map((a) => a.name || '')
      .filter((name) => name.length > 0);
    const shown = authors.slice(0, 3).join(', ') + (authors.length > 3 ? ' et al.' : '');
    const doi = ((art.articleids || []).find((a) => String(a.idtype || '').toLowerCase() === 'doi')?.value || '').trim();
    const type = (art.pubtype || [])
      .map((t) => (typeof t === 'string' ? t : t?.value || ''))
      .filter((t) => t.length > 0)[0] || 'Journal Article';

    const lines: string[] = [];
    lines.push(`# ${art.title || `PubMed ${pmid}`}`);
    lines.push('');
    lines.push(`- **PMID:** ${pmid}`);
    if (shown) lines.push(`- **Authors:** ${shown}`);
    const journal = art.fulljournalname || art.source || '';
    if (journal) lines.push(`- **Journal:** ${journal}`);
    if (art.pubdate) lines.push(`- **Date:** ${art.pubdate}`);
    lines.push(`- **Type:** ${type}`);
    if (doi) lines.push(`- **DOI:** ${doi}`);
    lines.push(`- **URL:** https://pubmed.ncbi.nlm.nih.gov/${pmid}/`);

    let text = lines.join('\n');
    if (text.length > maxLength) text = this.truncate(text, maxLength);
    return this.success('pubmed', text, undefined, { title: art.title || `PubMed ${pmid}` });
  }
}

export const pubmedExtractor = new PubmedExtractor();