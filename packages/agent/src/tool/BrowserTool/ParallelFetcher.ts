/**
 * ParallelFetcher - Batch parallel fetching within a single Agent session
 * Inspired by OpenCLI's parallel fetch capability
 * Uses Promise.all with timeout control, max 5 concurrent requests
 */

import axios from 'axios';

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
  error?: string;
  durationMs: number;
}

const MAX_CONCURRENT = 5;
const FETCH_TIMEOUT = 15000;
const MAX_CONTENT_LENGTH = 500000;

/**
 * Parallel batch fetcher for static content
 * Fallback when Browser Extension is not available
 */
export class ParallelFetcher {
  /**
   * Fetch multiple URLs in parallel with concurrency limit
   */
  async fetchBatch(tasks: FetchTask[]): Promise<FetchResult[]> {
    const results: FetchResult[] = [];

    // Process in chunks of MAX_CONCURRENT
    for (let i = 0; i < tasks.length; i += MAX_CONCURRENT) {
      const chunk = tasks.slice(i, i + MAX_CONCURRENT);
      const chunkResults = await Promise.all(
        chunk.map(task => this.fetchSingle(task))
      );
      results.push(...chunkResults);
    }

    return results;
  }

  /**
   * Fetch single URL with regex-based parsing
   */
  async fetchSingle(task: FetchTask): Promise<FetchResult> {
    const startTime = Date.now();

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
      const titleMatch = html.match(/<title[^>]*>([^<]*)<\/title>/i);
      const title = titleMatch ? titleMatch[1].trim() : '';

      let content: string;

      if (task.selector) {
        // Extract specific element using regex
        const selectorRegex = new RegExp(`<${task.selector}[^>]*>([\\s\\S]*?)<\\/${task.selector}>`, 'i');
        const match = html.match(selectorRegex);
        content = match ? this.stripTags(match[1]) : '';
      } else {
        // Extract main content
        const contentSelectors = [
          /<main[^>]*>([\s\S]*?)<\/main>/i,
          /<article[^>]*>([\s\S]*?)<\/article>/i,
          /<div[^>]*class="[^"]*(?:content|main|article)[^"]*"[^>]*>([\s\S]*?)<\/div>/i,
        ];

        let mainContent = '';
        for (const regex of contentSelectors) {
          const match = html.match(regex);
          if (match && match[1].length > mainContent.length) {
            mainContent = match[1];
          }
        }

        if (!mainContent) {
          const bodyMatch = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
          mainContent = bodyMatch ? bodyMatch[1] : html;
        }

        content = this.stripTags(mainContent);
      }

      // Truncate if too long
      if (content.length > 100000) {
        content = content.slice(0, 100000) + '\n\n[Content truncated...]';
      }

      return {
        id: task.id,
        url: task.url,
        success: true,
        title,
        content,
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

  /**
   * Quick health check for a URL
   */
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

  /**
   * Strip HTML tags
   */
  private stripTags(html: string): string {
    return html
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }
}

export const parallelFetcher = new ParallelFetcher();
export default ParallelFetcher;
