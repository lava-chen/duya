/**
 * Reddit Content Extractor
 * Extracts Reddit posts and comment trees via JSON API
 */

import { BaseExtractor } from '../BaseExtractor.js';
import type { ICDPClient } from '../../CDPClient.js';
import type { PlatformContent, RedditPost, RedditComment, ExtractionOptions } from '../types.js';

// Reddit API endpoint for comments
const REDDIT_COMMENTS_API = 'https://www.reddit.com';

interface RedditApiResponse {
  kind: string;
  data: {
    children: Array<{
      kind: string;
      data: RedditPostData;
    }>;
    after?: string;
  };
}

interface RedditPostData {
  id: string;
  name: string;
  title: string;
  author: string;
  subreddit: string;
  created_utc: number;
  score: number;
  num_comments: number;
  selftext: string;
  url: string;
  is_self: boolean;
  permalink: string;
  body?: string; // For comments
  parent_id?: string; // For comments
  depth?: number; // For comments
  replies?: RedditApiResponse | ''; // For comments
}

interface RedditResult {
  kind: 'ok' | 'inaccessible' | 'auth' | 'http' | 'malformed' | 'error';
  post?: RedditPost;
  comments?: RedditComment[];
  detail?: string;
}

export class RedditExtractor extends BaseExtractor {
  name = 'reddit';

  private hosts = ['reddit.com', 'www.reddit.com', 'old.reddit.com', 'new.reddit.com'];

  matches(url: string): boolean {
    const parsed = this.parseUrl(url);
    if (!parsed) return false;
    return this.hosts.some((host) => parsed.hostname === host || parsed.hostname.endsWith(`.${host}`));
  }

  async extract(cdp: ICDPClient, url: string, options?: ExtractionOptions): Promise<PlatformContent> {
    const parsed = this.parseUrl(url);
    if (!parsed) {
      return this.error('reddit-post', 'Invalid URL');
    }

    // Extract post ID from URL
    const postId = this.extractPostId(parsed.pathname);
    if (!postId) {
      return this.error('reddit-post', 'Could not extract Reddit post ID from URL');
    }

    try {
      // Fetch post and comments via Reddit JSON API
      const result = await this.fetchRedditContent(cdp, postId, options);

      if (result.kind !== 'ok') {
        return this.error('reddit-post', result.detail || 'Failed to fetch Reddit content');
      }

      // Format as Markdown
      const text = this.formatAsMarkdown(result.post!, result.comments!, options);

      return this.success('reddit-comments', text);
    } catch (e) {
      return this.error('reddit-comments', `Extraction failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  private extractPostId(pathname: string): string | null {
    // Handle /comments/<postId> format
    const commentsMatch = pathname.match(/\/comments\/([a-zA-Z0-9]+)/);
    if (commentsMatch) return commentsMatch[1];

    // Handle /r/<sub>/comments/<postId>/<slug> format
    const fullMatch = pathname.match(/\/r\/[^/]+\/comments\/([a-zA-Z0-9]+)/);
    if (fullMatch) return fullMatch[1];

    return null;
  }

  private async fetchRedditContent(
    cdp: ICDPClient,
    postId: string,
    options?: ExtractionOptions
  ): Promise<RedditResult> {
    const maxDepth = options?.maxCommentDepth ?? 3;
    const maxCommentsPerLevel = options?.maxCommentsPerLevel ?? 10;

    const script = `
      (async () => {
        const postId = ${JSON.stringify(postId)};
        const maxDepth = ${maxDepth};
        const maxCommentsPerLevel = ${maxCommentsPerLevel};

        // Fetch post and comments
        const res = await fetch(
          '/comments/' + postId + '.json?sort=best&limit=100&depth=6&raw_json=1',
          { credentials: 'include' }
        );

        if (res.status === 401 || res.status === 403) {
          return { kind: 'auth', detail: 'Authentication required' };
        }
        if (res.status === 404) {
          return { kind: 'inaccessible', detail: 'Post not found' };
        }
        if (!res.ok) {
          return { kind: 'http', detail: 'HTTP ' + res.status };
        }

        let data;
        try {
          data = await res.json();
        } catch (e) {
          return { kind: 'malformed', detail: 'Failed to parse JSON' };
        }

        if (!Array.isArray(data) || data.length < 2) {
          return { kind: 'malformed', detail: 'Unexpected response format' };
        }

        // Extract post
        const postData = data[0]?.data?.children?.[0]?.data;
        if (!postData) {
          return { kind: 'malformed', detail: 'No post data found' };
        }

        const post = {
          id: postData.id,
          title: postData.title || 'Untitled',
          author: postData.author || '[deleted]',
          subreddit: postData.subreddit || '',
          createdAt: postData.created_utc || 0,
          score: postData.score || 0,
          numComments: postData.num_comments || 0,
          selftext: postData.selftext || '',
          url: postData.url || postData.permalink || '',
          isSelf: postData.is_self !== false,
        };

        // Extract and walk comments
        const commentListing = data[1]?.data?.children || [];
        const comments = walkComments(commentListing, 0, maxDepth, maxCommentsPerLevel);

        return { kind: 'ok', post, comments };

        function walkComments(listing, depth, maxDepth, maxPerLevel) {
          const result = [];

          for (const item of listing) {
            if (item.kind === 'more') {
              // Skip 'more' stubs - too complex to expand
              continue;
            }

            if (item.kind !== 't1' || !item.data) continue;

            const comment = item.data;
            const commentObj = {
              id: comment.id,
              author: comment.author || '[deleted]',
              body: comment.body || '',
              score: comment.score || 0,
              createdAt: comment.created_utc || 0,
              depth: depth,
              isOP: commentDistinguished(comment),
              replies: [],
            };

            // Process replies
            if (depth < maxDepth && comment.replies && typeof comment.replies === 'object') {
              const children = comment.replies.data?.children || [];
              commentObj.replies = walkComments(children, depth + 1, maxDepth, maxPerLevel);
            }

            result.push(commentObj);
          }

          // Sort by score and limit
          result.sort((a, b) => b.score - a.score);
          return result.slice(0, maxPerLevel);
        }

        function commentDistinguished(comment) {
          return comment.distinguished === 'moderator' || comment.distinguished === 'admin';
        }
      })()
    `;

    try {
      const result = await cdp.evaluate(script);

      if (!result || typeof result !== 'object') {
        return { kind: 'error', detail: 'No result from page evaluation' };
      }

      const typedResult = result as RedditResult;

      if (typedResult.kind === 'ok' && typedResult.post) {
        return typedResult;
      }

      return typedResult;
    } catch (e) {
      return {
        kind: 'error',
        detail: `Evaluation error: ${e instanceof Error ? e.message : String(e)}`,
      };
    }
  }

  private formatAsMarkdown(post: RedditPost, comments: RedditComment[], options?: ExtractionOptions): string {
    const maxLength = options?.maxLength ?? 15000;
    const lines: string[] = [];

    // Header
    lines.push(`## ${this.escapeMarkdown(post.title)}`);
    lines.push('');
    lines.push(`**r/${post.subreddit}** • Posted by u/${post.author} • ${this.formatScore(post.score)} upvotes • ${post.numComments} comments`);
    lines.push('');

    // Post content
    if (post.selftext) {
      lines.push('---');
      lines.push('');
      const cleanText = this.stripHtml(post.selftext);
      lines.push(this.truncate(cleanText, 2000));
      lines.push('');
    }

    // Link if not self post
    if (!post.isSelf && post.url) {
      lines.push(`Link: ${post.url}`);
      lines.push('');
    }

    // Comments
    if (comments.length > 0) {
      lines.push('---');
      lines.push('');
      lines.push(`## Comments (${comments.length})`);
      lines.push('');

      for (const comment of comments) {
        this.formatComment(comment, lines, 0);
      }
    }

    let text = lines.join('\n');
    if (text.length > maxLength) {
      text = this.truncate(text, maxLength) + '\n\n*[Content truncated]*';
    }

    return text;
  }

  private formatComment(comment: RedditComment, lines: string[], depth: number): void {
    const indent = '  '.repeat(depth);
    const prefix = depth === 0 ? '' : indent + '> ';

    // Author line
    let authorLine = `**u/${comment.author}**`;
    if (comment.isOP) authorLine += ' [OP]';
    authorLine += ` • ${this.formatScore(comment.score)}`;

    lines.push(authorLine);

    // Body - indent each line for nested comments
    const bodyLines = comment.body.split('\n');
    for (const line of bodyLines) {
      if (depth > 0) {
        lines.push(prefix + line);
      } else {
        lines.push(line);
      }
    }

    lines.push('');

    // Recurse for replies
    for (const reply of comment.replies) {
      this.formatComment(reply, lines, depth + 1);
    }
  }

  private formatScore(score: number): string {
    if (score >= 1000000) return `${(score / 1000000).toFixed(1)}M`;
    if (score >= 1000) return `${(score / 1000).toFixed(1)}k`;
    return String(score);
  }

  private escapeMarkdown(text: string): string {
    return text
      .replace(/\*\*/g, '\\*\\*')
      .replace(/\*/g, '\\*')
      .replace(/#/g, '\\#')
      .replace(/-/g, '\\-');
  }
}

export const redditExtractor = new RedditExtractor();
