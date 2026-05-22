/**
 * Platform Extractors - Base Class
 * Abstract base class for platform-specific content extractors
 */

import type { ICDPClient } from '../CDPClient.js';
import type { PlatformContent, PlatformExtractor, ExtractionOptions } from './types.js';

/**
 * Response from fetch in page context
 */
interface FetchResponse {
  ok: boolean;
  status: number;
  json: unknown;
  text: string;
}

/**
 * Abstract base class for platform extractors
 */
export abstract class BaseExtractor implements PlatformExtractor {
  abstract name: string;

  abstract matches(url: string): boolean;

  abstract extract(cdp: ICDPClient, url: string, options?: ExtractionOptions): Promise<PlatformContent>;

  /**
   * Fetch JSON data from within the page context
   */
  protected async fetchJson<T = unknown>(
    cdp: ICDPClient,
    url: string,
    options?: RequestInit
  ): Promise<{ ok: boolean; status: number; data: T | null; error?: string }> {
    const result = await this.fetch(cdp, url, {
      ...options,
      headers: {
        ...options?.headers,
        Accept: 'application/json',
      },
    });

    if (!result.ok) {
      return {
        ok: false,
        status: result.status,
        data: null,
        error: `HTTP ${result.status}`,
      };
    }

    try {
      return {
        ok: true,
        status: result.status,
        data: result.json as T,
      };
    } catch (e) {
      return {
        ok: false,
        status: result.status,
        data: null,
        error: `JSON parse error: ${e instanceof Error ? e.message : String(e)}`,
      };
    }
  }

  /**
   * Fetch text data from within the page context
   */
  protected async fetchText(
    cdp: ICDPClient,
    url: string,
    options?: RequestInit
  ): Promise<{ ok: boolean; status: number; data: string | null; error?: string }> {
    const result = await this.fetch(cdp, url, options);

    if (!result.ok) {
      return {
        ok: false,
        status: result.status,
        data: null,
        error: `HTTP ${result.status}`,
      };
    }

    return {
      ok: true,
      status: result.status,
      data: result.text,
    };
  }

  /**
   * Execute fetch within page context
   */
  private async fetch(
    cdp: ICDPClient,
    url: string,
    options?: RequestInit
  ): Promise<FetchResponse> {
    const initOptions = options
      ? JSON.stringify({
          method: options.method || 'GET',
          headers: options.headers || {},
          body: options.body ? String(options.body) : undefined,
          credentials: 'include',
        })
      : JSON.stringify({ credentials: 'include' });

    const script = `
      (async () => {
        try {
          const res = await fetch(${JSON.stringify(url)}, ${initOptions});
          let json = null;
          let text = null;
          try {
            json = await res.json();
          } catch {}
          try {
            text = await res.text();
          } catch {}
          return {
            ok: res.ok,
            status: res.status,
            json,
            text: text || ''
          };
        } catch (e) {
          return {
            ok: false,
            status: 0,
            json: null,
            text: '',
            error: e?.message || String(e)
          };
        }
      })()
    `;

    try {
      const result = await cdp.evaluate(script);
      if (result && typeof result === 'object' && 'error' in result) {
        return {
          ok: false,
          status: 0,
          json: null,
          text: '',
        };
      }
      return result as FetchResponse;
    } catch {
      return {
        ok: false,
        status: 0,
        json: null,
        text: '',
      };
    }
  }

  /**
   * Wait for a condition in the page
   */
  protected async waitFor(
    cdp: ICDPClient,
    checkFn: string,
    timeoutMs = 10000,
    intervalMs = 500
  ): Promise<unknown> {
    const script = `
      (async () => {
        const startTime = Date.now();
        const interval = ${intervalMs};
        const timeout = ${timeoutMs};

        while (Date.now() - startTime < timeout) {
          const result = (${checkFn})();
          if (result) return result;
          await new Promise(r => setTimeout(r, interval));
        }
        return null;
      })()
    `;

    return cdp.evaluate(script);
  }

  /**
   * Create a successful content result
   */
  protected success(
    type: PlatformContent['type'],
    text: string,
    interactiveElements?: PlatformContent['interactiveElements'],
    metadata?: PlatformContent['metadata']
  ): PlatformContent {
    return {
      type,
      text,
      interactiveElements,
      success: true,
      metadata,
    };
  }

  /**
   * Create an error content result
   */
  protected error(type: PlatformContent['type'], error: string): PlatformContent {
    return {
      type,
      text: '',
      success: false,
      error,
    };
  }

  /**
   * Strip HTML tags from content
   */
  protected stripHtml(html: string): string {
    return html
      .replace(/<br\s*\/?\s*>/gi, '\n')
      .replace(/<\/(?:p|div|h[1-6]|li|blockquote)>/gi, '\n\n')
      .replace(/<[^>]+>/g, '')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&hellip;/g, '…')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  /**
   * Truncate text to max length
   */
  protected truncate(text: string, maxLength: number): string {
    if (text.length <= maxLength) return text;
    return text.slice(0, maxLength) + '…';
  }

  /**
   * Parse URL to extract components
   */
  protected parseUrl(url: string): URL | null {
    try {
      return new URL(url);
    } catch {
      return null;
    }
  }
}
