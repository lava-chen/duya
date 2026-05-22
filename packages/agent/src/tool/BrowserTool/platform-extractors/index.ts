/**
 * Platform Extractors - Main Entry Point
 * Unified exports for all platform-specific content extractors
 */

// Types
export * from './types.js';

// Base class
export { BaseExtractor } from './BaseExtractor.js';

// Extractors
export { RedditExtractor, redditExtractor } from './reddit/index.js';
export { TwitterExtractor, twitterExtractor } from './twitter/index.js';
export { ZhihuExtractor, zhihuExtractor } from './zhihu/index.js';
export { YouTubeExtractor, youtubeExtractor } from './youtube/index.js';
export { BilibiliExtractor, bilibiliExtractor } from './bilibili/index.js';
export { WeChatArticleExtractor, weChatArticleExtractor } from './wechat-article/index.js';
export { GitHubExtractor, githubExtractor } from './github/index.js';
export { GoogleSearchExtractor, googleSearchExtractor } from './google-search/index.js';

// Import extractors for manager
import type { PlatformExtractor } from './types.js';
import { redditExtractor } from './reddit/index.js';
import { twitterExtractor } from './twitter/index.js';
import { zhihuExtractor } from './zhihu/index.js';
import { youtubeExtractor } from './youtube/index.js';
import { bilibiliExtractor } from './bilibili/index.js';
import { weChatArticleExtractor } from './wechat-article/index.js';
import { githubExtractor } from './github/index.js';
import { googleSearchExtractor } from './google-search/index.js';

/**
 * All registered platform extractors
 */
export const platformExtractors: PlatformExtractor[] = [
  twitterExtractor,
  redditExtractor,
  zhihuExtractor,
  youtubeExtractor,
  bilibiliExtractor,
  weChatArticleExtractor,
  githubExtractor,
  googleSearchExtractor,
];
