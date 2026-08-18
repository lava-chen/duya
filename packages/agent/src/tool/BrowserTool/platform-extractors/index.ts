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
export { ArxivExtractor, arxivExtractor } from './arxiv/index.js';
export { WikipediaExtractor, wikipediaExtractor } from './wikipedia/index.js';
export { HackerNewsExtractor, hackerNewsExtractor } from './hacker-news/index.js';
export { PubmedExtractor, pubmedExtractor } from './pubmed/index.js';
export { WeiboExtractor, weiboExtractor } from './weibo/index.js';
export { InstagramExtractor, instagramExtractor } from './instagram/index.js';
export { TikTokExtractor, tiktokExtractor } from './tiktok/index.js';
export { RednoteExtractor, rednoteExtractor } from './rednote/index.js';
export { XianyuExtractor, xianyuExtractor } from './xianyu/index.js';
export { JdExtractor, jdExtractor } from './jd/index.js';
export { TaobaoExtractor, taobaoExtractor } from './taobao/index.js';
export { Ali1688Extractor, ali1688Extractor } from './ali1688/index.js';
export { ArticleExtractor, articleExtractor } from './article/index.js';

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
import { arxivExtractor } from './arxiv/index.js';
import { wikipediaExtractor } from './wikipedia/index.js';
import { hackerNewsExtractor } from './hacker-news/index.js';
import { pubmedExtractor } from './pubmed/index.js';
import { weiboExtractor } from './weibo/index.js';
import { instagramExtractor } from './instagram/index.js';
import { tiktokExtractor } from './tiktok/index.js';
import { rednoteExtractor } from './rednote/index.js';
import { xianyuExtractor } from './xianyu/index.js';
import { jdExtractor } from './jd/index.js';
import { taobaoExtractor } from './taobao/index.js';
import { ali1688Extractor } from './ali1688/index.js';
import { articleExtractor } from './article/index.js';

/**
 * All registered platform extractors.
 * `article` is intentionally LAST: it matches any http(s) page and is meant
 * to be the generic readability fallback after all platform-specific ones.
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
  arxivExtractor,
  wikipediaExtractor,
  hackerNewsExtractor,
  pubmedExtractor,
  weiboExtractor,
  instagramExtractor,
  tiktokExtractor,
  rednoteExtractor,
  xianyuExtractor,
  jdExtractor,
  taobaoExtractor,
  ali1688Extractor,
  articleExtractor,
];
