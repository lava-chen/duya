/**
 * YouTube Content Extractor
 * Extracts video metadata, captions, and comments via page analysis
 */

import { BaseExtractor } from '../BaseExtractor.js';
import type { ICDPClient } from '../../CDPClient.js';
import type { PlatformContent, ExtractionOptions } from '../types.js';

interface YouTubeResult {
  kind: 'ok' | 'error';
  text?: string;
  title?: string;
  detail?: string;
}

export class YouTubeExtractor extends BaseExtractor {
  name = 'youtube';

  private hosts = ['youtube.com', 'www.youtube.com', 'youtu.be', 'music.youtube.com'];

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
      return this.error('youtube-video', 'Invalid URL');
    }

    try {
      // Detect page type
      const isWatchPage = parsed.pathname === '/watch' || parsed.pathname.startsWith('/watch');
      const isChannelPage = parsed.pathname.startsWith('/@') || parsed.pathname.startsWith('/channel/');
      const isPlaylistPage = parsed.pathname.startsWith('/playlist');
      const isSearchPage = parsed.pathname === '/results' || parsed.pathname.startsWith('/results');

      if (isWatchPage) {
        return this.extractVideo(cdp, url, options);
      } else if (isChannelPage) {
        return this.extractChannel(cdp, url, options);
      } else if (isPlaylistPage) {
        return this.extractPlaylist(cdp, url, options);
      } else if (isSearchPage) {
        return this.extractSearch(cdp, url, options);
      } else {
        return this.extractHome(cdp, url, options);
      }
    } catch (e) {
      return this.error('youtube-video', `Extraction failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  private async extractVideo(cdp: ICDPClient, url: string, options?: ExtractionOptions): Promise<PlatformContent> {
    const maxLength = options?.maxLength ?? 12000;

    const script = `
      (async () => {
        const maxLength = ${maxLength};

        // Try to get ytInitialData from the page
        const scripts = document.querySelectorAll('script');
        let initialData = null;

        for (const script of scripts) {
          const text = script.textContent || '';
          if (text.includes('ytInitialData')) {
            const match = text.match(/ytInitialData\s*=\s*({.+?});/s);
            if (match) {
              try {
                initialData = JSON.parse(match[1]);
                break;
              } catch {}
            }
          }
        }

        // Get video ID
        const urlParams = new URLSearchParams(window.location.search);
        const videoId = urlParams.get('v') || '';

        // Extract video details
        const title = document.title.replace(' - YouTube', '').trim();

        // Try to get description from meta tags first
        const metaDesc = document.querySelector('meta[name="description"]')?.getAttribute('content') || '';

        // Get channel info
        const channelLink = document.querySelector('#channel-name a') ||
                          document.querySelector('ytd-video-owner-renderer #channel-name a');
        const channelName = channelLink?.textContent?.trim() || '';
        const channelId = channelLink?.href?.match(/\\/(@[\\w]+|channel\\/[\\w]+)/)?.[1] || '';

        // Get view count
        const viewCountEl = document.querySelector('#count .view-count') ||
                           document.querySelector('ytd-video-view-count-renderer .view-count');
        const viewCountText = viewCountEl?.textContent?.trim() || '0';
        const viewCount = parseInt(viewCountText.replace(/[^0-9]/g, '')) || 0;

        // Get like count
        const likeCountEl = document.querySelector('like-button-view-model #segmented-like-dislike-button > yt-formatted-string');
        const likeCountText = likeCountEl?.textContent?.trim() || '0';
        const likeCount = parseInt(likeCountText.replace(/[^0-9]/g, '')) || 0;

        // Get upload date
        const dateEl = document.querySelector('#info .date') ||
                      document.querySelector('ytd-video-primary-info-renderer #info .date');
        const uploadDate = dateEl?.textContent?.trim() || '';

        // Get video duration
        const durationEl = document.querySelector('.ytp-time-duration') ||
                          document.querySelector('h1.ytd-video-primary-info-renderer');
        const duration = durationEl?.textContent?.trim() || '';

        // Get video description (from expandable section)
        const expandBtn = document.querySelector('#expand') ||
                        document.querySelector('button[aria-label*="more"]');
        if (expandBtn) {
          try { expandBtn.click(); } catch {}
          await new Promise(r => setTimeout(r, 500));
        }

        const descEl = document.querySelector('#description-inline-expander') ||
                     document.querySelector('#description') ||
                     document.querySelector('.ytd-video-secondary-info-renderer #description');
        let description = descEl?.textContent?.trim() || metaDesc;

        // Build output
        const lines = [];
        lines.push('# ' + title);
        lines.push('');
        lines.push('**Channel:** [' + channelName + '](https://youtube.com/' + channelId + ')');
        lines.push('**Video ID:** ' + videoId);

        if (viewCount > 0) {
          lines.push('**Views:** ' + this.formatCount(viewCount));
        }
        if (likeCount > 0) {
          lines.push('**Likes:** ' + this.formatCount(likeCount));
        }
        if (uploadDate) {
          lines.push('**Uploaded:** ' + uploadDate);
        }

        lines.push('');
        lines.push('**URL:** ' + url);
        lines.push('');

        if (description) {
          lines.push('---');
          lines.push('');
          lines.push('## Description');
          lines.push('');
          lines.push(description.substring(0, 3000));
        }

        // Try to get comments
        const comments = [];
        const commentEls = document.querySelectorAll('ytd-comment-thread-renderer');

        for (let i = 0; i < Math.min(commentEls.length, 10); i++) {
          const el = commentEls[i];
          const authorEl = el.querySelector('#author-text');
          const textEl = el.querySelector('#content-text');
          const likeEl = el.querySelector('#like-count');

          const author = authorEl?.textContent?.trim() || 'Anonymous';
          const text = textEl?.textContent?.trim() || '';
          const likes = likeEl?.textContent?.trim() || '0';

          if (text) {
            comments.push({
              author: author.replace(/^@/, ''),
              text: text.substring(0, 500),
              likes
            });
          }
        }

        if (comments.length > 0) {
          lines.push('');
          lines.push('---');
          lines.push('');
          lines.push('## Top Comments (' + comments.length + ')');
          lines.push('');

          for (const c of comments) {
            lines.push('**' + c.author + '** • ' + c.likes + ' likes');
            lines.push('> ' + c.text.split('\\n')[0]);
            lines.push('');
          }
        }

        let text = lines.join('\\n');
        if (text.length > maxLength) {
          text = text.substring(0, maxLength) + '\\n\\n*[Content truncated]*';
        }

        return {
          kind: 'ok',
          text: text,
          title: title
        };
      })()
    `;

    try {
      const result = await cdp.evaluate(script);
      if (result && typeof result === 'object' && 'kind' in result) {
        return this.success('youtube-video', (result as YouTubeResult).text || '', undefined, {
          title: (result as YouTubeResult).title
        });
      }
      return this.error('youtube-video', 'Unexpected result format');
    } catch (e) {
      return this.error('youtube-video', `Evaluation error: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  private async extractChannel(cdp: ICDPClient, url: string, options?: ExtractionOptions): Promise<PlatformContent> {
    const maxLength = options?.maxLength ?? 10000;

    const script = `
      (async () => {
        const maxLength = ${maxLength};

        const title = document.title.replace(' - YouTube', '').trim();
        const channelName = document.querySelector('#channel-title')?.textContent?.trim() || title;
        const subscriberText = document.querySelector('#subscriber-count')?.textContent?.trim() || '';

        const lines = [];
        lines.push('# ' + channelName);
        lines.push('');
        lines.push('**URL:** ' + url);
        if (subscriberText) {
          lines.push('**Subscribers:** ' + subscriberText);
        }
        lines.push('');

        // Get featured videos
        const videos = [];
        const videoEls = document.querySelectorAll('ytd-rich-item-renderer, ytd-video-renderer');

        for (let i = 0; i < Math.min(videoEls.length, 15); i++) {
          const el = videoEls[i];
          const titleEl = el.querySelector('#video-title') || el.querySelector('h3');
          const metaEl = el.querySelector('#metadata-line');
          const linkEl = el.querySelector('a#thumbnail');

          const videoTitle = titleEl?.textContent?.trim() || '';
          const meta = metaEl?.textContent?.trim() || '';
          const videoUrl = linkEl?.href || '';

          if (videoTitle) {
            videos.push({
              title: videoTitle,
              meta: meta,
              url: videoUrl ? 'https://youtube.com' + videoUrl.split('&')[0].replace('/watch?v=', '/watch?v=') : ''
            });
          }
        }

        if (videos.length > 0) {
          lines.push('---');
          lines.push('');
          lines.push('## Recent Videos');
          lines.push('');

          for (const v of videos) {
            lines.push('### ' + v.title);
            lines.push('');
            lines.push(v.meta);
            if (v.url) lines.push('**Link:** ' + v.url);
            lines.push('');
          }
        }

        let text = lines.join('\\n');
        if (text.length > maxLength) {
          text = text.substring(0, maxLength) + '\\n\\n*[Content truncated]*';
        }

        return {
          kind: 'ok',
          text: text,
          title: title
        };
      })()
    `;

    try {
      const result = await cdp.evaluate(script);
      if (result && typeof result === 'object' && 'kind' in result) {
        return this.success('youtube-video', (result as YouTubeResult).text || '', undefined, {
          title: (result as YouTubeResult).title
        });
      }
      return this.error('youtube-video', 'Unexpected result format');
    } catch (e) {
      return this.error('youtube-video', `Evaluation error: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  private async extractPlaylist(cdp: ICDPClient, url: string, options?: ExtractionOptions): Promise<PlatformContent> {
    const maxLength = options?.maxLength ?? 10000;

    const script = `
      (async () => {
        const maxLength = ${maxLength};

        const title = document.title.replace(' - YouTube', '').trim();

        const lines = [];
        lines.push('# ' + title);
        lines.push('');
        lines.push('**URL:** ' + url);
        lines.push('');

        // Get playlist items
        const items = [];
        const itemEls = document.querySelectorAll('ytd-playlist-video-renderer, ytd-playlist-panel-video-renderer');

        for (let i = 0; i < Math.min(itemEls.length, 30); i++) {
          const el = itemEls[i];
          const titleEl = el.querySelector('#title');
          const metaEl = el.querySelector('#meta');
          const indexEl = el.querySelector('#index');

          const videoTitle = titleEl?.textContent?.trim() || '';
          const meta = metaEl?.textContent?.trim() || '';
          const index = indexEl?.textContent?.trim() || String(i + 1);

          if (videoTitle && !videoTitle.includes('http')) {
            items.push({
              index,
              title: videoTitle.replace(/\\s+/g, ' ').trim(),
              meta: meta.replace(/\\s+/g, ' ').trim()
            });
          }
        }

        if (items.length > 0) {
          lines.push('---');
          lines.push('');
          lines.push('## Playlist Items (' + items.length + ')');
          lines.push('');

          for (const item of items) {
            lines.push('**' + item.index + '.** ' + item.title);
            if (item.meta) lines.push('   ' + item.meta);
            lines.push('');
          }
        }

        let text = lines.join('\\n');
        if (text.length > maxLength) {
          text = text.substring(0, maxLength) + '\\n\\n*[Content truncated]*';
        }

        return {
          kind: 'ok',
          text: text,
          title: title
        };
      })()
    `;

    try {
      const result = await cdp.evaluate(script);
      if (result && typeof result === 'object' && 'kind' in result) {
        return this.success('youtube-video', (result as YouTubeResult).text || '', undefined, {
          title: (result as YouTubeResult).title
        });
      }
      return this.error('youtube-video', 'Unexpected result format');
    } catch (e) {
      return this.error('youtube-video', `Evaluation error: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  private async extractSearch(cdp: ICDPClient, url: string, options?: ExtractionOptions): Promise<PlatformContent> {
    const maxLength = options?.maxLength ?? 10000;

    const script = `
      (async () => {
        const maxLength = ${maxLength};
        const urlParams = new URLSearchParams(window.location.search);
        const query = urlParams.get('search_query') || '';

        const lines = [];
        lines.push('# YouTube Search: ' + query);
        lines.push('');
        lines.push('**URL:** ' + url);
        lines.push('');

        const results = [];
        const resultEls = document.querySelectorAll('ytd-video-renderer, ytd-rich-item-renderer');

        for (let i = 0; i < Math.min(resultEls.length, 20); i++) {
          const el = resultEls[i];
          const titleEl = el.querySelector('#video-title') || el.querySelector('h3');
          const metaEl = el.querySelector('#metadata-line');
          const linkEl = el.querySelector('a#thumbnail');

          const title = titleEl?.textContent?.trim() || '';
          const meta = metaEl?.textContent?.trim() || '';
          const videoUrl = linkEl?.href?.split('&')[0] || '';

          if (title && !title.includes('http')) {
            results.push({
              title: title.replace(/\\s+/g, ' ').trim(),
              meta: meta.replace(/\\s+/g, ' ').trim(),
              url: videoUrl
            });
          }
        }

        if (results.length > 0) {
          lines.push('---');
          lines.push('');
          lines.push('## Search Results (' + results.length + ')');
          lines.push('');

          for (const r of results) {
            lines.push('### ' + r.title);
            lines.push(r.meta);
            if (r.url) lines.push('**Link:** ' + r.url);
            lines.push('');
          }
        }

        let text = lines.join('\\n');
        if (text.length > maxLength) {
          text = text.substring(0, maxLength) + '\\n\\n*[Content truncated]*';
        }

        return {
          kind: 'ok',
          text: text,
          title: 'Search: ' + query
        };
      })()
    `;

    try {
      const result = await cdp.evaluate(script);
      if (result && typeof result === 'object' && 'kind' in result) {
        return this.success('youtube-video', (result as YouTubeResult).text || '', undefined, {
          title: (result as YouTubeResult).title
        });
      }
      return this.error('youtube-video', 'Unexpected result format');
    } catch (e) {
      return this.error('youtube-video', `Evaluation error: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  private async extractHome(cdp: ICDPClient, url: string, options?: ExtractionOptions): Promise<PlatformContent> {
    const maxLength = options?.maxLength ?? 8000;

    const script = `
      (async () => {
        const maxLength = ${maxLength};
        const title = document.title.replace(' - YouTube', '').trim();

        const lines = [];
        lines.push('# ' + title);
        lines.push('');
        lines.push('**URL:** ' + url);
        lines.push('');

        const videos = [];
        const videoEls = document.querySelectorAll('ytd-rich-item-renderer, ytd-video-renderer');

        for (let i = 0; i < Math.min(videoEls.length, 15); i++) {
          const el = videoEls[i];
          const titleEl = el.querySelector('#video-title') || el.querySelector('h3');
          const metaEl = el.querySelector('#metadata-line');

          const videoTitle = titleEl?.textContent?.trim() || '';
          const meta = metaEl?.textContent?.trim() || '';

          if (videoTitle && !videoTitle.includes('http')) {
            videos.push({
              title: videoTitle.replace(/\\s+/g, ' ').trim(),
              meta: meta.replace(/\\s+/g, ' ').trim()
            });
          }
        }

        if (videos.length > 0) {
          lines.push('---');
          lines.push('');
          lines.push('## Recommended Videos');
          lines.push('');

          for (const v of videos) {
            lines.push('### ' + v.title);
            lines.push(v.meta);
            lines.push('');
          }
        }

        let text = lines.join('\\n');
        if (text.length > maxLength) {
          text = text.substring(0, maxLength) + '\\n\\n*[Content truncated]*';
        }

        return {
          kind: 'ok',
          text: text,
          title: title
        };
      })()
    `;

    try {
      const result = await cdp.evaluate(script);
      if (result && typeof result === 'object' && 'kind' in result) {
        return this.success('youtube-video', (result as YouTubeResult).text || '', undefined, {
          title: (result as YouTubeResult).title
        });
      }
      return this.error('youtube-video', 'Unexpected result format');
    } catch (e) {
      return this.error('youtube-video', `Evaluation error: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  private formatCount(num: number): string {
    if (num >= 1000000) return (num / 1000000).toFixed(1) + 'M';
    if (num >= 1000) return (num / 1000).toFixed(1) + 'K';
    return String(num);
  }
}

export const youtubeExtractor = new YouTubeExtractor();
