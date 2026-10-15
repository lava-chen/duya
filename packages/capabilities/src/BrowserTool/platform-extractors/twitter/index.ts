/**
 * Twitter/X Content Extractor
 * Extracts tweets and threads via GraphQL API
 */

import { BaseExtractor } from '../BaseExtractor.js';
import type { ICDPClient } from '../../CDPClient.js';
import type { PlatformContent, ExtractionOptions } from '../types.js';

interface TwitterResult {
  kind: 'ok' | 'error';
  text?: string;
  title?: string;
  detail?: string;
}

/** A single tweet gathered from the page's embedded JSON (`__INITIAL_STATE__`). */
interface ThreadTweet {
  id: string;
  author: string;
  text: string;
  likes: number;
  retweets: number;
  created_at: string;
}

/** Discriminated result of the enhanced thread/article probe. */
type EnhancedExtractionResult =
  | { kind: 'thread'; tweets: ThreadTweet[] }
  | { kind: 'article'; title: string; author: string; body: string }
  | { kind: 'none' };

export class TwitterExtractor extends BaseExtractor {
  name = 'twitter';

  private hosts = ['x.com', 'twitter.com', 'mobile.twitter.com'];

  matches(url: string): boolean {
    const parsed = this.parseUrl(url);
    if (!parsed) return false;
    return this.hosts.some(
      (host) => parsed.hostname === host || parsed.hostname.endsWith(`.${host}`)
    );
  }

  async extract(cdp: ICDPClient, url: string, options?: ExtractionOptions): Promise<PlatformContent> {
    const parsed = this.parseUrl(url);
    if (!parsed) {
      return this.error('tweet', 'Invalid URL');
    }

    try {
      // Detect page type
      const pathname = parsed.pathname;

      if (pathname.match(/\/(?:[^/]+|i)\/status\/[0-9]+/)) {
        // Tweet page
        const tweetId = this.extractTweetId(pathname);
        if (tweetId) {
          await this.ensureOnPage(cdp, url);
          // Try thread/article extraction from the page's embedded JSON first.
          const enhanced = await this.extractThreadOrArticle(cdp, tweetId, url, options);
          if (enhanced) return enhanced;

          const result = await this.extractTweet(cdp, tweetId, options);
          if (result.kind === 'ok' && result.text) {
            return this.success('tweet', result.text, undefined, { title: result.title });
          }
        }
      }

      // Long-form article page (x.com article route).
      if (pathname.match(/\/(?:i\/)?articles?\/[0-9]+/)) {
        await this.ensureOnPage(cdp, url);
        const enhanced = await this.extractThreadOrArticle(cdp, null, url, options);
        if (enhanced) return enhanced;
      }

      // Try to extract user profile or generic content
      const result = await this.extractProfile(cdp, url, options);
      if (result.kind === 'ok' && result.text) {
        return this.success('thread', result.text, undefined, { title: result.title });
      }

      // Fallback to generic extraction
      return this.extractGeneric(cdp, url, options);
    } catch (e) {
      return this.error('tweet', `Extraction failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  private extractTweetId(pathname: string): string | null {
    // Match /username/status/123456789 or /i/status/123456789
    const match = pathname.match(/\/(?:[^/]+|i)\/status\/([0-9]+)/);
    return match ? match[1] : null;
  }

  private async ensureOnPage(cdp: ICDPClient, url: string): Promise<void> {
    const script = `
      (async () => {
        // Wait for the page to be ready
        await new Promise(r => setTimeout(r, 1000));

        // Check if we're on the right page
        const currentPath = window.location.pathname;
        const tweetMatch = currentPath.match(/\\/(?:[^/]+|i)\\/status\\/([0-9]+)/);

        return {
          ready: !!document.querySelector('[data-testid="tweet"]'),
          tweetId: tweetMatch ? tweetMatch[1] : null,
          title: document.title
        };
      })()
    `;

    await cdp.evaluate(script);
  }

  private async extractTweet(
    cdp: ICDPClient,
    tweetId: string,
    options?: ExtractionOptions
  ): Promise<TwitterResult> {
    const maxLength = options?.maxLength ?? 8000;

    const script = `
      (async () => {
        const tweetId = ${JSON.stringify(tweetId)};
        const maxLength = ${maxLength};

        // Find the tweet article element
        const articles = document.querySelectorAll('article[data-testid="tweet"]');
        let targetArticle = null;

        for (const article of articles) {
          // Check if this article links to our target tweet
          const links = article.querySelectorAll('a[href*="/status/' + tweetId + '"]');
          if (links.length > 0) {
            targetArticle = article;
            break;
          }
          // Also check the URL in the article
          const timeLink = article.querySelector('a[href*="/status/"]');
          if (timeLink && timeLink.href.includes(tweetId)) {
            targetArticle = article;
            break;
          }
        }

        if (!targetArticle) {
          // Fallback: try to find any tweet article on the page
          targetArticle = articles[0];
        }

        if (!targetArticle) {
          return { kind: 'error', detail: 'Tweet article not found on page' };
        }

        // Extract author
        const authorEl = targetArticle.querySelector('[data-testid="User-Name"]');
        const authorName = authorEl?.textContent?.trim().split(/[\n@]/)[0]?.trim() || 'Unknown';

        // Extract username
        const usernameEl = targetArticle.querySelector('a[href^="/"] span');
        const username = usernameEl?.textContent?.trim() || '';

        // Extract tweet text
        const textEl = targetArticle.querySelector('[data-testid="tweetText"]');
        let tweetText = textEl?.textContent?.trim() || '';

        // Extract metrics
        const metrics = {};
        const metricEls = targetArticle.querySelectorAll('[data-testid="tweetButtonInline"]');
        for (const metricEl of metricEls) {
          const text = metricEl.textContent || '';
          if (text.includes('Reply')) {
            metrics.replies = parseInt(text.replace(/[^0-9]/g, '')) || 0;
          }
        }

        // Try to get engagement from other elements
        const engagementSection = targetArticle.querySelector('[role="group"]');
        if (engagementSection) {
          const spans = engagementSection.querySelectorAll('span');
          for (const span of spans) {
            const text = span.textContent || '';
            if (text.includes('like') || text.includes('❤️')) {
              metrics.likes = parseInt(text.replace(/[^0-9]/g, '')) || 0;
            }
          }
        }

        // Extract timestamp
        const timeEl = targetArticle.querySelector('time');
        const timestamp = timeEl?.textContent?.trim() || '';
        const datetime = timeEl?.getAttribute('datetime') || '';

        // Extract media
        const media = [];
        const mediaEls = targetArticle.querySelectorAll('[data-testid="tweetPhoto"], .media-img');
        for (const mediaEl of mediaEls) {
          const img = mediaEl.querySelector('img');
          if (img) {
            media.push({
              type: 'photo',
              alt: img.getAttribute('alt') || 'Image',
              url: img.src || img.getAttribute('data-src') || ''
            });
          }
        }

        // Build formatted text
        const lines = [];

        lines.push('## Tweet by @' + username);
        lines.push('');
        lines.push(tweetText);
        lines.push('');

        if (timestamp) {
          lines.push('**Time:** ' + timestamp + (datetime ? ' (' + datetime + ')' : ''));
        }

        if (metrics.likes !== undefined || metrics.replies !== undefined) {
          lines.push('**Engagement:**');
          if (metrics.likes !== undefined) lines.push('- ❤️ ' + metrics.likes + ' likes');
          if (metrics.replies !== undefined) lines.push('- 💬 ' + metrics.replies + ' replies');
        }

        if (media.length > 0) {
          lines.push('');
          lines.push('**Media:**');
          for (const m of media) {
            if (m.alt) lines.push('- [' + m.alt + '](' + m.url + ')');
            else lines.push('- ' + m.url);
          }
        }

        // Check for quoted tweet
        const quotedTweet = targetArticle.querySelector('[data-testid="tweetQuoplay"]');
        if (quotedTweet) {
          lines.push('');
          lines.push('**Quoted Tweet:**');
          const quoteText = quotedTweet.querySelector('[data-testid="tweetText"]');
          if (quoteText) {
            lines.push(quoteText.textContent?.trim() || '');
          }
        }

        // Check for retweet info
        const retweetEl = targetArticle.querySelector('[data-testid="retweet"]');
        const retweetText = retweetEl?.textContent?.trim();
        if (retweetText && retweetText.includes('Repost')) {
          lines.push('');
          lines.push('*' + retweetText + '*');
        }

        let text = lines.join('\\n');
        if (text.length > maxLength) {
          text = text.substring(0, maxLength) + '\\n\\n*[Content truncated]*';
        }

        return {
          kind: 'ok',
          text: text,
          title: '@' + username + ': ' + tweetText.substring(0, 50) + '...'
        };
      })()
    `;

    try {
      const result = await cdp.evaluate(script);

      if (!result || typeof result !== 'object') {
        return { kind: 'error', detail: 'No result from page evaluation' };
      }

      const typedResult = result as TwitterResult;

      // Sanitize the result
      if (typedResult.text) {
        typedResult.text = typedResult.text.replace(/\s+/g, ' ').trim();
      }

      return typedResult;
    } catch (e) {
      return {
        kind: 'error',
        detail: `Evaluation error: ${e instanceof Error ? e.message : String(e)}`,
      };
    }
  }

  /**
   * Probe the page's embedded `__INITIAL_STATE__` JSON for a full thread or a
   * long-form article. Returns a `PlatformContent` for thread/article pages and
   * `null` when there is nothing to enhance beyond a single tweet, so the
   * caller falls back to the existing single-tweet extraction.
   *
   * The embedded state must be present (browser logged-in enough to hydrate a
   * conversation/timeline); on logged-out or walled pages it is absent, so we
   * degrade to `null` rather than erroring.
   */
  private async extractThreadOrArticle(
    cdp: ICDPClient,
    tweetId: string | null,
    url: string,
    options?: ExtractionOptions
  ): Promise<PlatformContent | null> {
    const maxLength = options?.maxLength ?? 12000;

    const script = `
      (async () => {
        try {
          const state = window.__INITIAL_STATE__;
          if (!state || typeof state !== 'object') return { kind: 'none' };

          const isObj = function (v) { return Boolean(v && typeof v === 'object' && !Array.isArray(v)); };
          const ts = function (s) { const n = Date.parse(s || ''); return isNaN(n) ? 0 : n; };

          // Convert an article's Draft.js content_state.blocks into Markdown.
          const blocksToMarkdown = function (artResult) {
            const contentState = isObj(artResult.content_state) ? artResult.content_state : {};
            const blocks = Array.isArray(contentState.blocks) ? contentState.blocks : [];
            if (blocks.length === 0) return '';
            const rawEntityMap = contentState.entityMap || {};
            const entityByKey = {};
            if (Array.isArray(rawEntityMap)) {
              for (const entry of rawEntityMap) {
                if (entry && entry.key != null && entry.value) entityByKey[String(entry.key)] = entry.value;
              }
            } else if (isObj(rawEntityMap)) {
              for (const key of Object.keys(rawEntityMap)) {
                const entry = rawEntityMap[key];
                entityByKey[String(key)] = entry && entry.value ? entry.value : entry;
              }
            }
            const mediaUrlById = {};
            const meVal = artResult.media_entities;
            if (Array.isArray(meVal) || isObj(meVal)) {
              const items = Array.isArray(meVal) ? meVal : Object.values(meVal);
              for (const me of items) {
                if (me && isObj(me) && me.media_id != null && me.media_info && typeof me.media_info.original_img_url === 'string') {
                  mediaUrlById[String(me.media_id)] = me.media_info.original_img_url;
                }
              }
            }
            const nl = String.fromCharCode(10);
            const parts = [];
            let counter = 0;
            for (const block of blocks) {
              if (!isObj(block)) continue;
              const type = block.type || 'unstyled';
              if (type === 'atomic') {
                const ranges = block.entityRanges || [];
                const ek = ranges.length > 0 ? ranges[0].key : null;
                const entity = ek == null ? null : entityByKey[String(ek)];
                if (entity && entity.type === 'MEDIA') {
                  const items = entity.data && entity.data.mediaItems ? entity.data.mediaItems : [];
                  const mid = items.length > 0 ? items[0].mediaId : null;
                  const imgUrl = mid == null ? null : mediaUrlById[String(mid)];
                  if (imgUrl) {
                    const cap = String((entity.data && entity.data.caption) || 'Image').replace(/\\]/g, '&#93;');
                    parts.push('![' + cap + '](' + imgUrl + ')');
                  }
                }
                continue;
              }
              const text = typeof block.text === 'string' ? block.text : '';
              if (!text) continue;
              if (type !== 'ordered-list-item') counter = 0;
              if (type === 'header-one') parts.push('# ' + text);
              else if (type === 'header-two') parts.push('## ' + text);
              else if (type === 'header-three') parts.push('### ' + text);
              else if (type === 'blockquote') parts.push('> ' + text);
              else if (type === 'unordered-list-item') parts.push('- ' + text);
              else if (type === 'ordered-list-item') { counter++; parts.push(counter + '. ' + text); }
              else if (type === 'code-block') { const bt = String.fromCharCode(96); parts.push(bt + bt + bt + nl + text + nl + bt + bt + bt); }
              else parts.push(text);
            }
            return parts.join(nl + nl);
          };

          const tweets = new Map();
          let article = null;

          const screenNameOf = function (userResults) {
            const u = userResults && userResults.result;
            const l = u && u.legacy;
            const name = (l && l.screen_name) || (u && u.core && u.core.screen_name);
            return typeof name === 'string' ? name : '';
          };

          const store = function (t, id) {
            const key = String(id);
            if (tweets.has(key)) return;
            const l = t.legacy && isObj(t.legacy) ? t.legacy : {};
            const noteNode = t.note_tweet && t.note_tweet.note_tweet_results && t.note_tweet.note_tweet_results.result;
            const noteText = noteNode && typeof noteNode.text === 'string' ? noteNode.text : '';
            const fullText = typeof l.full_text === 'string' ? l.full_text : '';
            tweets.set(key, {
              id: key,
              author: screenNameOf(t.core && t.core.user_results) || 'unknown',
              text: noteText || fullText,
              likes: typeof l.favorite_count === 'number' ? l.favorite_count : 0,
              retweets: typeof l.retweet_count === 'number' ? l.retweet_count : 0,
              created_at: typeof l.created_at === 'string' ? l.created_at : '',
              isNote: noteText.length > 0
            });
            if (!article) {
              const artWrap = t.article && isObj(t.article) ? t.article : null;
              const artResult = artWrap && artWrap.article_results && artWrap.article_results.result;
              if (artResult && isObj(artResult)) {
                const body = blocksToMarkdown(artResult);
                if (body) {
                  article = {
                    author: screenNameOf(t.core && t.core.user_results) || '',
                    title: typeof artResult.title === 'string' ? artResult.title : '(Untitled)',
                    body: body
                  };
                }
              }
            }
          };

          // Bounded deep-walk of the embedded state to gather every tweet result
          // node (the conversation's parent/replies plus the article holder).
          const stack = [state];
          let budget = 500000;
          while (stack.length > 0 && budget > 0) {
            budget--;
            const cur = stack.pop();
            if (cur === null || typeof cur !== 'object') continue;
            if (Array.isArray(cur)) {
              for (let i = 0; i < cur.length; i++) if (cur[i] !== null && typeof cur[i] === 'object') stack.push(cur[i]);
              continue;
            }
            if (typeof cur.rest_id === 'string') store(cur, cur.rest_id);
            for (const key of Object.keys(cur)) {
              const v = cur[key];
              if (v !== null && typeof v === 'object') stack.push(v);
            }
          }

          // 1) Long-form article embedded in the state.
          if (article) {
            return { kind: 'article', title: article.title, author: article.author, body: article.body };
          }

          // 2) A focused long-form "note tweet".
          const focalId = ${JSON.stringify(tweetId)};
          const list = Array.from(tweets.values());
          const focal = focalId ? list.find(function (t) { return t.id === focalId; }) : undefined;
          if (focal && focal.isNote && focal.text) {
            return { kind: 'article', title: '(Note Tweet)', author: focal.author, body: focal.text };
          }

          // 3) Full thread (tweet + neighbouring parent/replies) in chronological order.
          if (list.length > 1) {
            const sorted = list.slice().sort(function (a, b) { return ts(a.created_at) - ts(b.created_at); });
            const out = sorted.map(function (t) {
              return { id: t.id, author: t.author, text: t.text, likes: t.likes, retweets: t.retweets, created_at: t.created_at };
            });
            return { kind: 'thread', tweets: out };
          }

          return { kind: 'none' };
        } catch {
          return { kind: 'none' };
        }
      })()
    `;

    try {
      const raw = await cdp.evaluate(script);
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;

      const r = raw as EnhancedExtractionResult;

      if (r.kind === 'article') {
        let text = '# ' + r.title + '\n\nby @' + r.author + '\n\n---\n\n' + r.body;
        if (text.length > maxLength) text = text.slice(0, maxLength) + '\n\n*[Content truncated]*';
        return this.success('tweet', text, undefined, { title: r.title });
      }

      if (r.kind === 'thread') {
        const lines: string[] = [];
        lines.push('# Thread');
        lines.push('');
        lines.push('**Source:** ' + url);
        lines.push('');
        for (let i = 0; i < r.tweets.length; i++) {
          const t = r.tweets[i];
          lines.push('### ' + (i + 1) + '. @' + t.author + (t.created_at ? ' — ' + t.created_at : ''));
          lines.push('');
          lines.push(t.text);
          if (t.likes > 0 || t.retweets > 0) {
            lines.push('');
            lines.push('> ❤️ ' + t.likes + ' · 🔁 ' + t.retweets);
          }
          lines.push('');
        }
        let text = lines.join('\n');
        if (text.length > maxLength) text = text.slice(0, maxLength) + '\n\n*[Content truncated]*';
        const threadTitle = r.tweets.length > 0 ? 'Thread by @' + r.tweets[0].author : 'Thread';
        return this.success('thread', text, undefined, { title: threadTitle });
      }

      return null;
    } catch {
      return null;
    }
  }

  private async extractProfile(cdp: ICDPClient, url: string, options?: ExtractionOptions): Promise<TwitterResult> {
    const maxLength = options?.maxLength ?? 10000;

    const script = `
      (async () => {
        const maxLength = ${maxLength};

        // Get profile info
        const nameEl = document.querySelector('[data-testid="UserName"] span') ||
                       document.querySelector('h1 span') ||
                       document.querySelector('[role="heading"] span');
        const username = window.location.pathname.split('/')[1] || '';
        const name = nameEl?.textContent?.trim() || username;

        // Get bio
        const bioEl = document.querySelector('[data-testid="UserDescription"]') ||
                     document.querySelector('[data-testid="UserBio"]');
        const bio = bioEl?.textContent?.trim() || '';

        // Get stats
        const statEls = document.querySelectorAll('[data-testid="UserProfileHeader_Items"] span');
        let followers = '';
        let following = '';
        for (const el of statEls) {
          const text = el.textContent || '';
          if (text.includes('Followers') || text.includes('关注')) {
            followers = text;
          }
          if (text.includes('Following') || text.includes('关注中')) {
            following = text;
          }
        }

        // Get recent tweets
        const tweets = [];
        const tweetEls = document.querySelectorAll('[data-testid="tweet"]');

        for (let i = 0; i < Math.min(tweetEls.length, 10); i++) {
          const el = tweetEls[i];
          const textEl = el.querySelector('[data-testid="tweetText"]') || el.querySelector('div[lang]');
          const timeEl = el.querySelector('time');
          const metricsEl = el.querySelectorAll('[data-testid="tweetButton"] span');

          const text = textEl?.textContent?.trim() || '';
          const time = timeEl?.textContent?.trim() || timeEl?.getAttribute('datetime') || '';

          // Get engagement metrics
          let likes = '0';
          let reposts = '0';
          const allText = el.textContent || '';
          const likesMatch = allText.match(/([\\d,.]+)\\s*(?:like|赞)/i);
          const repostsMatch = allText.match(/([\\d,.]+)\\s*(?:repost|转)/i);
          if (likesMatch) likes = likesMatch[1];
          if (repostsMatch) reposts = repostsMatch[1];

          if (text && text.length > 5) {
            tweets.push({ text: text.substring(0, 500), time, likes, reposts });
          }
        }

        // Build output
        const lines = [];
        lines.push('# @' + username + (name !== username ? ' (' + name + ')' : ''));
        lines.push('');
        lines.push('**Profile:** ' + url);
        lines.push('');

        if (bio) {
          lines.push('## Bio');
          lines.push('');
          lines.push(bio.substring(0, 500));
          lines.push('');
        }

        if (followers || following) {
          lines.push('**Stats:** ' + [followers, following].filter(Boolean).join(' | '));
          lines.push('');
        }

        if (tweets.length > 0) {
          lines.push('---');
          lines.push('');
          lines.push('## Recent Tweets (' + tweets.length + ')');
          lines.push('');

          for (let i = 0; i < tweets.length; i++) {
            const t = tweets[i];
            lines.push('### Tweet ' + (i + 1) + (t.time ? ' - ' + t.time : ''));
            lines.push('');
            lines.push(t.text);
            if (t.likes !== '0' || t.reposts !== '0') {
              lines.push('');
              lines.push('❤️ ' + t.likes + ' | 🔁 ' + t.reposts);
            }
            lines.push('');
          }
        } else {
          lines.push('*No tweets found - may need to log in or scroll to load*');
        }

        let text = lines.join('\\n');
        if (text.length > maxLength) {
          text = text.substring(0, maxLength) + '\\n\\n*[Content truncated]*';
        }

        return {
          kind: 'ok',
          text: text,
          title: '@' + username + ' on X'
        };
      })()
    `;

    try {
      const result = await cdp.evaluate(script);
      if (!result || typeof result !== 'object') {
        return { kind: 'error', detail: 'No result from page evaluation' };
      }
      return result as TwitterResult;
    } catch (e) {
      return {
        kind: 'error',
        detail: `Evaluation error: ${e instanceof Error ? e.message : String(e)}`,
      };
    }
  }

  private async extractGeneric(cdp: ICDPClient, url: string, options?: ExtractionOptions): Promise<PlatformContent> {
    const maxLength = options?.maxLength ?? 5000;

    const script = `
      (async () => {
        const maxLength = ${maxLength};
        const title = document.title || 'X';

        // Try to get any visible content
        const mainEl = document.querySelector('main') || document.querySelector('[role="main"]') || document.body;
        const clone = mainEl.cloneNode(true);
        clone.querySelectorAll('script, style, nav, [data-testid="sidebarColumn"], [data-testid="primaryColumn"] aside').forEach(el => el.remove());

        // Get tweets
        const tweets = [];
        const tweetEls = document.querySelectorAll('[data-testid="tweet"], article');

        for (let i = 0; i < Math.min(tweetEls.length, 5); i++) {
          const el = tweetEls[i];
          const textEl = el.querySelector('[data-testid="tweetText"], [lang]');
          const text = textEl?.textContent?.trim() || el.textContent?.trim() || '';
          if (text.length > 20) {
            tweets.push(text.substring(0, 300));
          }
        }

        const lines = [];
        lines.push('# ' + title);
        lines.push('');
        lines.push('**URL:** ' + url);
        lines.push('');

        if (tweets.length > 0) {
          lines.push('## Content');
          lines.push('');
          for (const t of tweets) {
            lines.push('- ' + t);
          }
        }

        let text = lines.join('\\n');
        if (text.length > maxLength) {
          text = text.substring(0, maxLength) + '\\n\\n*[Content truncated]*';
        }

        return { kind: 'ok', text, title };
      })()
    `;

    try {
      const result = await cdp.evaluate(script);
      if (result && typeof result === 'object' && 'kind' in result) {
        return this.success('tweet', (result as TwitterResult).text || '', undefined, {
          title: (result as TwitterResult).title
        });
      }
      return this.error('tweet', 'Unexpected result format');
    } catch (e) {
      return this.error('tweet', `Evaluation error: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}

export const twitterExtractor = new TwitterExtractor();
