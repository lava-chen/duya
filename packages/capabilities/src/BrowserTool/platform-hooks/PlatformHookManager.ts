/**
 * Platform Hook Manager
 * Manages platform-specific hooks for websites like Bilibili, YouTube, etc.
 * Inspired by OpenCLI's platform handling approach.
 */

import type { ICDPClient } from '../CDPClient.js';
import type { PlatformHooks } from './types.js';
import { bilibiliHooks } from './platforms/bilibili.js';
import { youtubeHooks } from './platforms/youtube.js';
import { weixinMpHooks } from './platforms/weixin-mp.js';
import { twitterHooks } from './platforms/twitter.js';

// Platform extractors
import type { PlatformExtractor, PlatformContent, ExtractionOptions } from '../platform-extractors/types.js';
import { platformExtractors } from '../platform-extractors/index.js';

export class PlatformHookManager {
  private hooks: Map<string, PlatformHooks> = new Map();
  /**
   * Hook lookup: domain pattern -> hooks. Caller does `hostname.includes(pattern)`.
   * Kept as a Map so we can iterate, but pattern count is bounded (~7 entries).
   */
  private hookOrder: string[] = [];

  /**
   * Extractor lookup. Instead of linearly scanning 21 extractors per call and
   * logging each miss (the previous implementation did both on every navigate),
   * we eagerly evaluate `matches()` against a small set of candidate host
   * patterns and short-circuit. The article fallback matches any http(s) URL
   * via regex test, so we keep it as `defaultExtractor` to avoid the loop.
   */
  private hostnameExtractors: Map<string, PlatformExtractor> = new Map();
  /**
   * Platform-specific extractors whose `matches()` matched none of the sample
   * hostnames (e.g. arxiv.org). Scanned linearly after the hostname map.
   */
  private fallbackExtractors: PlatformExtractor[] = [];
  private defaultExtractor: PlatformExtractor | null = null;

  constructor() {
    this.registerPlatform('bilibili.com', bilibiliHooks);
    this.registerPlatform('bilibili.cn', bilibiliHooks);
    this.registerPlatform('youtube.com', youtubeHooks);
    this.registerPlatform('youtu.be', youtubeHooks);
    this.registerPlatform('mp.weixin.qq.com', weixinMpHooks);
    this.registerPlatform('x.com', twitterHooks);
    this.registerPlatform('twitter.com', twitterHooks);

    this.indexExtractors(platformExtractors);
  }

  /**
   * Build a hostname -> extractor index from the registered list. Each
   *   extractor's `matches()` is invoked at most a few times on common
   *   hostnames — this is faster than 21 regex tests per page and removes the
   *   per-call 21-line console.log.
   */
  private indexExtractors(extractors: PlatformExtractor[]): void {
    for (const extractor of extractors) {
      // The generic readability fallback claims no specific hostname. It must
      // be handled before the sample-host probe: `article.matches()` is true
      // for every http(s) URL, so probing it would mark it `indexed` and leave
      // ordinary sites with no extractor at all (they fell back to a structured
      // DOM snapshot instead of readable text).
      if (extractor.name === 'article') {
        this.defaultExtractor = extractor;
        continue;
      }
      const sampleHosts = [
        'twitter.com', 'x.com', 'reddit.com', 'www.zhihu.com',
        'youtube.com', 'www.youtube.com', 'youtu.be', 'www.bilibili.com',
        'mp.weixin.qq.com', 'github.com', 'www.google.com',
        'en.wikipedia.org', 'news.ycombinator.com', 'pubmed.ncbi.nlm.nih.gov',
        'weibo.com', 'www.instagram.com', 'www.tiktok.com', 'www.xiaohongshu.com',
        'www.goofish.com', 'item.jd.com', 'www.taobao.com', 'detail.1688.com',
      ];
      let indexed = false;
      for (const host of sampleHosts) {
        const probe = `https://${host}/`;
        if (extractor.matches(probe)) {
          if (!this.hostnameExtractors.has(host)) {
            this.hostnameExtractors.set(host, extractor);
          }
          indexed = true;
        }
      }
      // Platform-specific extractor that matched none of the sample hostnames —
      // keep it for a bounded linear scan in `getExtractor`.
      if (!indexed) {
        this.fallbackExtractors.push(extractor);
      }
    }
  }

  /**
   * Register platform-specific hooks
   */
  registerPlatform(domainPattern: string, hooks: PlatformHooks): void {
    this.hooks.set(domainPattern, hooks);
    this.hookOrder.push(domainPattern);
  }

  /**
   * Check if platform hooks should be applied for given URL
   */
  shouldApplyHooks(url: string): boolean {
    const hostname = this.safeHostname(url);
    if (!hostname) return false;
    for (const pattern of this.hookOrder) {
      if (hostname.includes(pattern)) {
        return true;
      }
    }
    return false;
  }

  /**
   * Get hooks for a given URL
   */
  private getHooksForUrl(url: string): PlatformHooks | null {
    const hostname = this.safeHostname(url);
    if (!hostname) return null;
    for (const pattern of this.hookOrder) {
      if (hostname.includes(pattern)) {
        return this.hooks.get(pattern) || null;
      }
    }
    return null;
  }

  private safeHostname(url: string): string | null {
    try {
      return new URL(url).hostname;
    } catch {
      return null;
    }
  }

  /**
   * Apply post-navigation hooks
   */
  async applyPostNavigateHooks(cdp: ICDPClient, url: string): Promise<void> {
    const hooks = this.getHooksForUrl(url);
    if (!hooks || !hooks.postNavigate) return;

    try {
      await hooks.postNavigate(cdp, url);
    } catch (error) {
      console.warn(`[PlatformHookManager] Post-navigate hook failed for ${url}:`, error);
    }
  }

  /**
   * Apply pre-snapshot hooks
   */
  async applyPreSnapshotHooks(cdp: ICDPClient, url: string): Promise<void> {
    const hooks = this.getHooksForUrl(url);
    if (!hooks || !hooks.preSnapshot) return;

    try {
      await hooks.preSnapshot(cdp, url);
    } catch (error) {
      console.warn(`[PlatformHookManager] Pre-snapshot hook failed for ${url}:`, error);
    }
  }

  /**
   * Apply post-click hooks
   */
  async applyPostClickHooks(cdp: ICDPClient, url: string, selector: string): Promise<void> {
    const hooks = this.getHooksForUrl(url);
    if (!hooks || !hooks.postClick) return;

    try {
      await hooks.postClick(cdp, url, selector);
    } catch (error) {
      console.warn(`[PlatformHookManager] Post-click hook failed for ${url}:`, error);
    }
  }

  /**
   * Apply pre-scroll hooks
   */
  async applyPreScrollHooks(cdp: ICDPClient, url: string): Promise<void> {
    const hooks = this.getHooksForUrl(url);
    if (!hooks || !hooks.preScroll) return;

    try {
      await hooks.preScroll(cdp, url);
    } catch (error) {
      console.warn(`[PlatformHookManager] Pre-scroll hook failed for ${url}:`, error);
    }
  }

  // ─── Platform Extractors ────────────────────────────────────────────────

  /**
   * Check if there's a content extractor for this URL
   */
  hasExtractor(url: string): boolean {
    return this.getExtractor(url) !== null;
  }

  /**
   * Get content extractor for a URL — now O(1) for known hostnames via the
   * precomputed `hostnameExtractors` map; falls back to the article default
   * for any http(s) URL.
   */
  getExtractor(url: string): PlatformExtractor | null {
    const hostname = this.safeHostname(url);
    if (!hostname) return null;
    const cached = this.hostnameExtractors.get(hostname);
    if (cached) return cached;
    for (const extractor of this.fallbackExtractors) {
      if (extractor.matches(url)) return extractor;
    }
    if (this.defaultExtractor && this.defaultExtractor.matches(url)) {
      return this.defaultExtractor;
    }
    return null;
  }

  /**
   * Extract content using platform-specific extractor
   */
  async extractContent(
    cdp: ICDPClient,
    url: string,
    options?: ExtractionOptions
  ): Promise<PlatformContent | null> {
    const extractor = this.getExtractor(url);
    if (!extractor) {
      return null;
    }

    try {
      const content = await extractor.extract(cdp, url, options);
      return content;
    } catch (error) {
      console.warn(`[PlatformHookManager] Extraction failed for ${url}:`, error);
      return null;
    }
  }

  /**
   * Register a custom extractor (for testing or custom platforms)
   */
  registerExtractor(extractor: PlatformExtractor): void {
    // Remove existing extractor for same platform
    this.hostnameExtractors.forEach((value, key) => {
      if (value.name === extractor.name) this.hostnameExtractors.delete(key);
    });
    if (this.defaultExtractor && this.defaultExtractor.name === extractor.name) {
      this.defaultExtractor = null;
    }
    this.indexExtractors([extractor]);
  }
}
