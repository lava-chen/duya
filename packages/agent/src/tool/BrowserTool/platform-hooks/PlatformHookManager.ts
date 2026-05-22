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
  private extractors: PlatformExtractor[] = platformExtractors;

  constructor() {
    this.registerPlatform('bilibili.com', bilibiliHooks);
    this.registerPlatform('bilibili.cn', bilibiliHooks);
    this.registerPlatform('youtube.com', youtubeHooks);
    this.registerPlatform('youtu.be', youtubeHooks);
    this.registerPlatform('mp.weixin.qq.com', weixinMpHooks);
    this.registerPlatform('x.com', twitterHooks);
    this.registerPlatform('twitter.com', twitterHooks);
  }

  /**
   * Register platform-specific hooks
   */
  registerPlatform(domainPattern: string, hooks: PlatformHooks): void {
    this.hooks.set(domainPattern, hooks);
  }

  /**
   * Check if platform hooks should be applied for given URL
   */
  shouldApplyHooks(url: string): boolean {
    try {
      const hostname = new URL(url).hostname;
      for (const pattern of this.hooks.keys()) {
        if (hostname.includes(pattern)) {
          return true;
        }
      }
    } catch {
      // Invalid URL
    }
    return false;
  }

  /**
   * Get hooks for a given URL
   */
  private getHooksForUrl(url: string): PlatformHooks | null {
    try {
      const hostname = new URL(url).hostname;
      for (const [pattern, hooks] of this.hooks.entries()) {
        if (hostname.includes(pattern)) {
          return hooks;
        }
      }
    } catch {
      // Invalid URL
    }
    return null;
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
   * Get content extractor for a URL
   */
  getExtractor(url: string): PlatformExtractor | null {
    for (const extractor of this.extractors) {
      if (extractor.matches(url)) {
        return extractor;
      }
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
      console.log(`[PlatformHookManager] Using ${extractor.name} extractor for ${url}`);
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
    this.extractors = this.extractors.filter((e) => e.name !== extractor.name);
    this.extractors.push(extractor);
  }
}
