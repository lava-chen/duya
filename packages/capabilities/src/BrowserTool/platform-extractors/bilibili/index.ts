/**
 * Bilibili Content Extractor
 * Extracts video information, danmaku comments, and video lists from Bilibili
 */

import { BaseExtractor } from '../BaseExtractor.js';
import type { ICDPClient } from '../../CDPClient.js';
import type { PlatformContent, ExtractionOptions } from '../types.js';

interface BilibiliResult {
  kind: 'ok' | 'error';
  text?: string;
  title?: string;
  detail?: string;
}

export class BilibiliExtractor extends BaseExtractor {
  name = 'bilibili';

  private hosts = ['bilibili.com', 'www.bilibili.com', 'bilibili.cn', 'www.bilibili.cn'];

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
      return this.error('bilibili-video', 'Invalid URL');
    }

    try {
      // Detect page type
      const pathname = parsed.pathname;

      if (pathname.includes('/video/av') || pathname.match(/^\/video\/[a-zA-Z0-9]+$/)) {
        return this.extractVideo(cdp, url, options);
      } else if (pathname.includes('/favorites') || pathname.includes('/favorite')) {
        return this.extractFavorites(cdp, url, options);
      } else if (pathname.includes('/list')) {
        return this.extractPlaylist(cdp, url, options);
      } else if (pathname.match(/^\/[a-zA-Z0-9_]+$/)) {
        return this.extractUser(cdp, url, options);
      } else {
        return this.extractGeneric(cdp, url, options);
      }
    } catch (e) {
      return this.error('bilibili-video', `Extraction failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  private extractVideoId(pathname: string): string | null {
    const match = pathname.match(/\/video\/(BV[a-zA-Z0-9]+|av[0-9]+)/);
    return match ? match[1] : null;
  }

  private async extractVideo(cdp: ICDPClient, url: string, options?: ExtractionOptions): Promise<PlatformContent> {
    const maxLength = options?.maxLength ?? 10000;

    const script = `
      (async () => {
        const maxLength = ${maxLength};

        // Get title
        const title = document.title.replace('_哔哩哔哩 (゜-゜)つロ 干杯~-bilibili', '')
          .replace('_哔哩哔哩弹幕视频网', '')
          .replace('_bilibili', '')
          .trim() || 'Untitled Video';

        // Get video info from __INITIAL_STATE__ or window.__playinfo__
        let videoInfo = {};
        const scripts = document.querySelectorAll('script');
        for (const script of scripts) {
          const text = script.textContent || '';
          if (text.includes('__INITIAL_STATE__')) {
            const match = text.match(/window\\.__INITIAL_STATE__\\s*=\\s*({.+?});/s);
            if (match) {
              try {
                videoInfo = JSON.parse(match[1]);
                break;
              } catch {}
            }
          }
        }

        // Get basic info from DOM
        const titleEl = document.querySelector('.video-info-container .video-title') ||
                       document.querySelector('h1.title') ||
                       document.querySelector('.video-title');
        const videoTitle = titleEl?.textContent?.trim() || title;

        // Get uploader info
        const uploaderEl = document.querySelector('.user-name') ||
                          document.querySelector('.up-info .name') ||
                          document.querySelector('.up-name');
        const uploader = uploaderEl?.textContent?.trim() || 'Unknown';

        const uploaderLinkEl = document.querySelector('.user-name a') ||
                              document.querySelector('.up-info a');
        const uploaderLink = uploaderLinkEl?.href || '';

        // Get view stats
        const statsEls = document.querySelectorAll('.video-info-detail-item');
        let views = '0';
        let likes = '0';
        let coins = '0';
        let favorites = '0';
        let shares = '0';

        for (const el of statsEls) {
          const text = el.textContent || '';
          if (text.includes('观看')) views = text.replace(/[^0-9万]/g, '');
          if (text.includes('点赞')) likes = text.replace(/[^0-9万]/g, '');
          if (text.includes('投币')) coins = text.replace(/[^0-9万]/g, '');
          if (text.includes('收藏')) favorites = text.replace(/[^0-9万]/g, '');
          if (text.includes('分享')) shares = text.replace(/[^0-9万]/g, '');
        }

        // Get description
        const descEl = document.querySelector('.desc-info-v2') ||
                     document.querySelector('.desc-wrapper') ||
                     document.querySelector('.video-desc');
        let description = descEl?.textContent?.trim() || '';

        // Get tags
        const tags = [];
        const tagEls = document.querySelectorAll('.tag-link') ||
                     document.querySelectorAll('.tag-item');
        for (const tagEl of tagEls) {
          const tag = tagEl.textContent?.trim();
          if (tag && !tag.includes('更多')) {
            tags.push(tag);
          }
        }

        // Get category and timestamp
        const categoryEl = document.querySelector('.category-link') ||
                          document.querySelector('.channel-name');
        const category = categoryEl?.textContent?.trim() || '';

        // Build output
        const lines = [];
        lines.push('# ' + videoTitle);
        lines.push('');
        lines.push('**UP主:** [' + uploader + '](' + (uploaderLink || 'https://bilibili.com') + ')');

        if (category) lines.push('**分区:** ' + category);

        lines.push('');
        lines.push('| 数据 | 数值 |');
        lines.push('|------|------|');
        lines.push('| 观看 | ' + this.formatBiliCount(views) + ' |');
        lines.push('| 点赞 | ' + this.formatBiliCount(likes) + ' |');
        lines.push('| 投币 | ' + this.formatBiliCount(coins) + ' |');
        lines.push('| 收藏 | ' + this.formatBiliCount(favorites) + ' |');
        lines.push('| 分享 | ' + this.formatBiliCount(shares) + ' |');

        lines.push('');
        lines.push('**链接:** ' + url);

        if (tags.length > 0) {
          lines.push('');
          lines.push('**标签:** ' + tags.slice(0, 10).join(' | '));
        }

        if (description) {
          lines.push('');
          lines.push('---');
          lines.push('');
          lines.push('## 视频简介');
          lines.push('');
          lines.push(description.substring(0, 2000));
        }

        // Try to get comments
        const comments = [];
        const commentEls = document.querySelectorAll('.comment-item') ||
                         document.querySelectorAll('.list-item');

        for (let i = 0; i < Math.min(commentEls.length, 10); i++) {
          const el = commentEls[i];
          const authorEl = el.querySelector('.user-name') || el.querySelector('.uname');
          const textEl = el.querySelector('.text') || el.querySelector('.msg');

          const author = authorEl?.textContent?.trim() || 'Anonymous';
          const text = textEl?.textContent?.trim() || '';

          if (text && text.length > 5) {
            comments.push({ author, text: text.substring(0, 300) });
          }
        }

        if (comments.length > 0) {
          lines.push('');
          lines.push('---');
          lines.push('');
          lines.push('## 热评');
          lines.push('');

          for (const c of comments) {
            lines.push('**' + c.author + ':**');
            lines.push('> ' + c.text);
            lines.push('');
          }
        }

        let text = lines.join('\\n');
        if (text.length > maxLength) {
          text = text.substring(0, maxLength) + '\\n\\n*[内容已截断]*';
        }

        return {
          kind: 'ok',
          text: text,
          title: videoTitle
        };
      })()
    `;

    try {
      const result = await cdp.evaluate(script);
      if (result && typeof result === 'object' && 'kind' in result) {
        return this.success('bilibili-video', (result as BilibiliResult).text || '', undefined, {
          title: (result as BilibiliResult).title
        });
      }
      return this.error('bilibili-video', 'Unexpected result format');
    } catch (e) {
      return this.error('bilibili-video', `Evaluation error: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  private async extractFavorites(cdp: ICDPClient, url: string, options?: ExtractionOptions): Promise<PlatformContent> {
    const maxLength = options?.maxLength ?? 10000;

    const script = `
      (async () => {
        const maxLength = ${maxLength};
        const title = document.title.replace('_哔哩哔哩 (゜-゜)つロ 干杯~-bilibili', '').trim() || '我的收藏';

        const lines = [];
        lines.push('# ' + title);
        lines.push('');
        lines.push('**链接:** ' + url);
        lines.push('');

        // Get favorite videos
        const videos = [];
        const videoEls = document.querySelectorAll('.fav-item') ||
                        document.querySelectorAll('.video-item') ||
                        document.querySelectorAll('.bili-video-card');

        for (let i = 0; i < Math.min(videoEls.length, 20); i++) {
          const el = videoEls[i];
          const titleEl = el.querySelector('.title') || el.querySelector('h3') || el.querySelector('.bili-video-card__title');
          const metaEl = el.querySelector('.meta') || el.querySelector('.info') || el.querySelector('.bili-video-card__info');
          const linkEl = el.querySelector('a');

          const videoTitle = titleEl?.textContent?.trim() || '';
          const meta = metaEl?.textContent?.trim() || '';
          const videoUrl = linkEl?.href || '';

          if (videoTitle) {
            videos.push({
              title: videoTitle.replace(/\\s+/g, ' ').trim(),
              meta: meta.replace(/\\s+/g, ' ').trim(),
              url: videoUrl.startsWith('http') ? videoUrl : 'https://bilibili.com' + videoUrl
            });
          }
        }

        if (videos.length > 0) {
          lines.push('---');
          lines.push('');
          lines.push('## 收藏列表 (' + videos.length + ')');
          lines.push('');

          for (const v of videos) {
            lines.push('### ' + v.title);
            if (v.meta) lines.push(v.meta);
            if (v.url) lines.push('**链接:** ' + v.url);
            lines.push('');
          }
        } else {
          lines.push('*未找到收藏内容*');
        }

        let text = lines.join('\\n');
        if (text.length > maxLength) {
          text = text.substring(0, maxLength) + '\\n\\n*[内容已截断]*';
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
        return this.success('bilibili-video', (result as BilibiliResult).text || '', undefined, {
          title: (result as BilibiliResult).title
        });
      }
      return this.error('bilibili-video', 'Unexpected result format');
    } catch (e) {
      return this.error('bilibili-video', `Evaluation error: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  private async extractPlaylist(cdp: ICDPClient, url: string, options?: ExtractionOptions): Promise<PlatformContent> {
    const maxLength = options?.maxLength ?? 10000;

    const script = `
      (async () => {
        const maxLength = ${maxLength};
        const title = document.title.replace('_哔哩哔哩 (゜-゜)つロ 干杯~-bilibili', '').trim() || '播放列表';

        const lines = [];
        lines.push('# ' + title);
        lines.push('');
        lines.push('**链接:** ' + url);
        lines.push('');

        // Get playlist items
        const items = [];
        const itemEls = document.querySelectorAll('.playlist-item') ||
                        document.querySelectorAll('.video-item') ||
                        document.querySelectorAll('.list-item');

        for (let i = 0; i < Math.min(itemEls.length, 30); i++) {
          const el = itemEls[i];
          const titleEl = el.querySelector('.title') || el.querySelector('h3');
          const metaEl = el.querySelector('.meta') || el.querySelector('.info');
          const durationEl = el.querySelector('.duration');

          const itemTitle = titleEl?.textContent?.trim() || '';
          const meta = metaEl?.textContent?.trim() || '';
          const duration = durationEl?.textContent?.trim() || '';

          if (itemTitle) {
            items.push({
              index: i + 1,
              title: itemTitle.replace(/\\s+/g, ' ').trim(),
              meta: meta.replace(/\\s+/g, ' ').trim(),
              duration
            });
          }
        }

        if (items.length > 0) {
          lines.push('---');
          lines.push('');
          lines.push('## 播放列表 (' + items.length + ')');
          lines.push('');

          for (const item of items) {
            lines.push('**' + item.index + '.** ' + item.title);
            const metaParts = [item.meta, item.duration].filter(Boolean);
            if (metaParts.length) lines.push('   ' + metaParts.join(' | '));
            lines.push('');
          }
        }

        let text = lines.join('\\n');
        if (text.length > maxLength) {
          text = text.substring(0, maxLength) + '\\n\\n*[内容已截断]*';
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
        return this.success('bilibili-video', (result as BilibiliResult).text || '', undefined, {
          title: (result as BilibiliResult).title
        });
      }
      return this.error('bilibili-video', 'Unexpected result format');
    } catch (e) {
      return this.error('bilibili-video', `Evaluation error: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  private async extractUser(cdp: ICDPClient, url: string, options?: ExtractionOptions): Promise<PlatformContent> {
    const maxLength = options?.maxLength ?? 10000;

    const script = `
      (async () => {
        const maxLength = ${maxLength};
        const title = document.title.replace('_哔哩哔哩 (゜-゜)つロ 干杯~-bilibili', '').trim() || 'Bilibili User';

        const lines = [];
        lines.push('# ' + title);
        lines.push('');
        lines.push('**链接:** ' + url);
        lines.push('');

        // Get user stats
        const statEls = document.querySelectorAll('.stat-item') ||
                       document.querySelectorAll('.user-stats span');
        const stats = [];
        for (const el of statEls) {
          const text = el.textContent?.trim() || '';
          if (text) stats.push(text);
        }
        if (stats.length) {
          lines.push('**数据:** ' + stats.join(' | '));
        }

        // Get recent videos
        const videos = [];
        const videoEls = document.querySelectorAll('.video-item') ||
                        document.querySelectorAll('.video-card') ||
                        document.querySelectorAll('li.video-item');

        for (let i = 0; i < Math.min(videoEls.length, 15); i++) {
          const el = videoEls[i];
          const titleEl = el.querySelector('.title') || el.querySelector('h3') || el.querySelector('.video-title');
          const metaEl = el.querySelector('.meta') || el.querySelector('.info');
          const linkEl = el.querySelector('a');

          const videoTitle = titleEl?.textContent?.trim() || '';
          const meta = metaEl?.textContent?.trim() || '';
          const videoUrl = linkEl?.href || '';

          if (videoTitle && !videoTitle.includes('http')) {
            videos.push({
              title: videoTitle.replace(/\\s+/g, ' ').trim(),
              meta: meta.replace(/\\s+/g, ' ').trim(),
              url: videoUrl.startsWith('http') ? videoUrl : 'https://bilibili.com' + videoUrl
            });
          }
        }

        if (videos.length > 0) {
          lines.push('');
          lines.push('---');
          lines.push('');
          lines.push('## 最新视频');
          lines.push('');

          for (const v of videos) {
            lines.push('### ' + v.title);
            if (v.meta) lines.push(v.meta);
            lines.push('');
          }
        }

        let text = lines.join('\\n');
        if (text.length > maxLength) {
          text = text.substring(0, maxLength) + '\\n\\n*[内容已截断]*';
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
        return this.success('bilibili-video', (result as BilibiliResult).text || '', undefined, {
          title: (result as BilibiliResult).title
        });
      }
      return this.error('bilibili-video', 'Unexpected result format');
    } catch (e) {
      return this.error('bilibili-video', `Evaluation error: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  private async extractGeneric(cdp: ICDPClient, url: string, options?: ExtractionOptions): Promise<PlatformContent> {
    const maxLength = options?.maxLength ?? 8000;

    const script = `
      (async () => {
        const maxLength = ${maxLength};
        const title = document.title.replace('_哔哩哔哩 (゜-゜)つロ 干杯~-bilibili', '').replace('_bilibili', '').trim() || 'Bilibili';

        // Get main content
        const mainEl = document.querySelector('#app') || document.querySelector('main') || document.body;
        const clone = mainEl.cloneNode(true);
        clone.querySelectorAll('script, style, nav, footer, aside, .advertisement, .sidebar').forEach(el => el.remove());

        const text = clone.textContent?.trim() || '';
        const truncated = text.length > 2000 ? text.substring(0, 2000) + '...' : text;

        const lines = [];
        lines.push('# ' + title);
        lines.push('');
        lines.push('**链接:** ' + url);
        lines.push('');
        lines.push('---');
        lines.push('');
        lines.push(truncated);

        let result = lines.join('\\n');
        if (result.length > maxLength) {
          result = result.substring(0, maxLength) + '\\n\\n*[内容已截断]*';
        }

        return {
          kind: 'ok',
          text: result,
          title: title
        };
      })()
    `;

    try {
      const result = await cdp.evaluate(script);
      if (result && typeof result === 'object' && 'kind' in result) {
        return this.success('bilibili-video', (result as BilibiliResult).text || '', undefined, {
          title: (result as BilibiliResult).title
        });
      }
      return this.error('bilibili-video', 'Unexpected result format');
    } catch (e) {
      return this.error('bilibili-video', `Evaluation error: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  private formatBiliCount(text: string): string {
    if (!text) return '0';
    const num = parseFloat(text);
    if (text.includes('万')) return (num).toFixed(1) + '万';
    return String(num);
  }
}

export const bilibiliExtractor = new BilibiliExtractor();
