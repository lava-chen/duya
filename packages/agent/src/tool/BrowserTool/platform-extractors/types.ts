/**
 * Platform Extractors - Types
 * Defines interfaces for platform-specific content extraction
 */

import type { ICDPClient } from '../CDPClient.js';

/**
 * Interactive element for platform-specific content
 */
export interface PlatformInteractiveElement {
  ref: number;
  tag: string;
  type?: string;
  text: string;
  selector?: string;
}

/**
 * Content types supported by platform extractors
 */
export type PlatformContentType =
  | 'tweet'
  | 'thread'
  | 'reddit-post'
  | 'reddit-comments'
  | 'zhihu-answer'
  | 'zhihu-article'
  | 'youtube-video'
  | 'bilibili-video'
  | 'github-repo'
  | 'wechat-article'
  | 'google-search'
  | 'article';

/**
 * Result from a platform extractor
 */
export interface PlatformContent {
  /** Content type identifier */
  type: PlatformContentType;
  /** Formatted text content (Markdown) */
  text: string;
  /** Interactive elements extracted from the page */
  interactiveElements?: PlatformInteractiveElement[];
  /** Whether extraction was successful */
  success: boolean;
  /** Error message if extraction failed */
  error?: string;
  /** Additional metadata */
  metadata?: Record<string, unknown>;
}

/**
 * Interface for platform-specific content extractors
 */
export interface PlatformExtractor {
  /** Check if this extractor matches the given URL */
  matches(url: string): boolean;

  /** Extract content from the page */
  extract(cdp: ICDPClient, url: string, options?: ExtractionOptions): Promise<PlatformContent>;

  /** Platform name for logging */
  name: string;
}

/**
 * Options for content extraction
 */
export interface ExtractionOptions {
  /** Maximum text length */
  maxLength?: number;
  /** Include interactive elements */
  includeInteractive?: boolean;
  /** Maximum comment depth for threaded content */
  maxCommentDepth?: number;
  /** Maximum comments per level */
  maxCommentsPerLevel?: number;
}

/**
 * Twitter-specific types
 */
export interface TweetData {
  id: string;
  text: string;
  author: {
    screenName: string;
    name: string;
    verified: boolean;
  };
  createdAt: string;
  metrics: {
    likes: number;
    retweets: number;
    replies: number;
    views?: number;
  };
  media?: Array<{
    type: 'photo' | 'video' | 'animated_gif';
    url: string;
    alt?: string;
  }>;
  referencedTweet?: {
    type: 'quoted' | 'replied_to' | 'retweeted';
    id: string;
    author: string;
    text: string;
  };
}

/**
 * Reddit-specific types
 */
export interface RedditPost {
  id: string;
  title: string;
  author: string;
  subreddit: string;
  createdAt: number;
  score: number;
  numComments: number;
  selftext: string;
  url: string;
  isSelf: boolean;
}

export interface RedditComment {
  id: string;
  author: string;
  body: string;
  score: number;
  createdAt: number;
  depth: number;
  replies: RedditComment[];
  isOP: boolean;
}

/**
 * Zhihu-specific types
 */
export interface ZhihuAnswer {
  id: string;
  questionTitle: string;
  author: {
    name: string;
    url: string;
    badge?: string;
  };
  content: string;
  createdAt: number;
  updatedAt?: number;
  voteupCount: number;
  commentCount: number;
}
