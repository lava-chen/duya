/**
 * Hacker News Extractor — story post plus a threaded comment tree, sourced
 * from the public Firebase API (https://hacker-news.firebaseio.com/v0/item/<id>.json).
 */

import { BaseExtractor } from '../BaseExtractor.js';
import type { ICDPClient } from '../../CDPClient.js';
import type { PlatformContent, ExtractionOptions } from '../types.js';
import { publicFetchJson } from '../_shared/public-api.js';

interface HnItem {
  id: string;
  type?: string;
  title?: string;
  text?: string;
  url?: string;
  by?: string;
  score?: number;
  kids?: string[];
  deleted?: boolean;
  dead?: boolean;
}

const HN_ITEM_BASE = 'https://hacker-news.firebaseio.com/v0/item';

export class HackerNewsExtractor extends BaseExtractor {
  name = 'hacker-news';

  matches(url: string): boolean {
    try {
      return new URL(url).hostname === 'news.ycombinator.com';
    } catch {
      return false;
    }
  }

  async extract(_cdp: ICDPClient, url: string, options?: ExtractionOptions): Promise<PlatformContent> {
    const maxLength = options?.maxLength ?? 20000;
    const parsed = this.parseUrl(url);
    const id = parsed?.searchParams.get('id');
    if (!id || !/^\d+$/.test(id)) {
      return this.error('hacker-news', 'Not an HN item URL (missing ?id=NNN)');
    }

    const fetchItem = (itemId: string): Promise<HnItem | null> =>
      publicFetchJson<HnItem>(`${HN_ITEM_BASE}/${itemId}.json`).then(r => r.data);

    const story = await fetchItem(id);
    if (!story || story.deleted || story.dead) {
      return this.error('hacker-news', `HN story ${id} not found or deleted`);
    }

    const lines: string[] = [];
    lines.push(`# ${story.title || `HN ${id}`}`);
    lines.push(`- id ${story.id} · by ${story.by || '[deleted]'} · score ${story.score ?? 0}`);
    if (story.url) lines.push(`- ${story.url}`);
    const selfText = story.text ? this.stripHtml(story.text) : '';
    if (selfText) {
      lines.push('');
      lines.push(selfText);
    }

    // Comment tree with the same caps as OpenCLI's HN read adapter.
    const limit = 25;
    const maxDepth = 2;
    const maxReplies = 5;

    const topIds = (story.kids || []).slice(0, limit);
    const top = (await Promise.all(topIds.map((k) => fetchItem(k).catch(() => null)))).filter(
      (n): n is HnItem => n !== null,
    );

    const visit = async (node: HnItem | null, depth: number): Promise<void> => {
      if (!node || node.deleted || node.dead) return;
      let body = this.stripHtml(node.text || '');
      if (body.length > 2000) body = body.slice(0, 2000) + '...';
      if (body) {
        lines.push('');
        lines.push(`  ${'  '.repeat(depth)}> ${body.split('\n').join(`\n${'  '.repeat(depth)}> `)}`);
        if (node.by) lines.push(`  ${'  '.repeat(depth)}  — ${node.by}`);
      }
      const kids = node.kids || [];
      if (depth + 1 >= maxDepth) {
        if (kids.length) lines.push(`${'  '.repeat(depth + 1)}[+${kids.length} more replies]`);
        return;
      }
      const toFetch = kids.slice(0, maxReplies);
      const replies = (await Promise.all(toFetch.map((k) => fetchItem(k).catch(() => null)))).filter(
        (n): n is HnItem => n !== null,
      );
      for (const reply of replies) await visit(reply, depth + 1);
      const hidden = kids.length - toFetch.length;
      if (hidden > 0) lines.push(`${'  '.repeat(depth + 1)}[+${hidden} more replies]`);
    };

    for (const comment of top) await visit(comment, 0);

    const hiddenTop = (story.kids || []).length - top.length;
    if (hiddenTop > 0) lines.push(`[+${hiddenTop} more top-level comments]`);

    let text = lines.join('\n');
    if (text.length > maxLength) text = text.substring(0, maxLength) + '\n\n*[Content truncated]*';
    return this.success('hacker-news', text, undefined, { title: story.title || `HN ${id}` });
  }
}

export const hackerNewsExtractor = new HackerNewsExtractor();