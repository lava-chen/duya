/**
 * WeChat Article Content Extractor
 * Extracts article content from WeChat public accounts
 */

import { BaseExtractor } from '../BaseExtractor.js';
import type { ICDPClient } from '../../CDPClient.js';
import type { PlatformContent, ExtractionOptions } from '../types.js';

interface WeChatResult {
  kind: 'ok' | 'error';
  text?: string;
  title?: string;
  detail?: string;
}

export class WeChatArticleExtractor extends BaseExtractor {
  name = 'wechat-article';

  private hosts = ['mp.weixin.qq.com', 'mp.weixin.qq.cn'];

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
      return this.error('wechat-article', 'Invalid URL');
    }

    try {
      // Detect page type
      const pathname = parsed.pathname;

      if (pathname.includes('/s/')) {
        return this.extractArticle(cdp, url, options);
      } else if (pathname.includes('/profile_ext')) {
        return this.extractProfile(cdp, url, options);
      } else {
        return this.extractGeneric(cdp, url, options);
      }
    } catch (e) {
      return this.error('wechat-article', `Extraction failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  private async extractArticle(cdp: ICDPClient, url: string, options?: ExtractionOptions): Promise<PlatformContent> {
    const maxLength = options?.maxLength ?? 15000;

    const script = `
      (async () => {
        const maxLength = ${maxLength};

        // Get title
        const titleEl = document.querySelector('#activity-name') ||
                       document.querySelector('.article-title') ||
                       document.querySelector('h1.title') ||
                       document.querySelector('h1');
        let title = titleEl?.textContent?.trim() || '';

        // Fallback to page title
        if (!title) {
          title = document.title.replace('_微信公众号', '').replace('_微信公众平台', '').trim() || 'Untitled';
        }

        // Get author (account name)
        const authorEl = document.querySelector('#js_name') ||
                        document.querySelector('.account_name') ||
                        document.querySelector('.rich_media_meta_text');
        const author = authorEl?.textContent?.trim() || '';

        // Get publish date
        const dateEl = document.querySelector('#publish_time') ||
                      document.querySelector('.rich_media_meta') ||
                      document.querySelector('.time');
        const publishDate = dateEl?.textContent?.trim() || '';

        // Get content
        const contentEl = document.querySelector('#js_content') ||
                         document.querySelector('.rich_media_content') ||
                         document.querySelector('#img-content') ||
                         document.querySelector('.article-content');

        let content = '';
        if (contentEl) {
          const clone = contentEl.cloneNode(true);

          // Remove unwanted elements
          clone.querySelectorAll('script, style, .advertisement, .qrcode, iframe, .video-placeholder').forEach(el => el.remove());

          // Get text content
          content = clone.textContent?.trim() || '';

          // Try to get images as alt text
          const imgEls = clone.querySelectorAll('img');
          const imgAlt = [];
          for (const img of imgEls) {
            const alt = img.getAttribute('data-src') || img.src || '';
            if (alt && !alt.includes('data:image')) {
              const altText = img.alt || alt.substring(alt.lastIndexOf('/') + 1, alt.lastIndexOf('.'));
              if (altText) imgAlt.push('[图片: ' + altText.substring(0, 50) + ']');
            }
          }

          if (imgAlt.length > 0 && content.length < 500) {
            content += '\\n\\n' + imgAlt.slice(0, 5).join('\\n');
          }
        }

        // Get like count
        const likeEl = document.querySelector('#like_number') ||
                      document.querySelector('.like_button');
        const likeCount = likeEl?.textContent?.trim() || '';

        // Get read count
        const readEl = document.querySelector('#read_count') ||
                      document.querySelector('.read_count');
        const readCount = readEl?.textContent?.trim() || '';

        // Build output
        const lines = [];
        lines.push('# ' + title);
        lines.push('');

        if (author) {
          lines.push('**公众号:** ' + author);
        }

        if (publishDate) {
          lines.push('**发布时间:** ' + publishDate);
        }

        if (readCount) {
          lines.push('**阅读量:** ' + readCount);
        }

        if (likeCount) {
          lines.push('**在看:** ' + likeCount);
        }

        lines.push('');
        lines.push('**链接:** ' + url);
        lines.push('');

        if (content) {
          lines.push('---');
          lines.push('');
          lines.push(content);
        } else {
          // Fallback: try to get any main content
          const fallbackEl = document.querySelector('main') || document.querySelector('#app') || document.body;
          const fallbackText = fallbackEl.textContent?.trim() || '';
          if (fallbackText) {
            lines.push('---');
            lines.push('');
            lines.push(fallbackText.substring(0, 3000));
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
        return this.success('wechat-article', (result as WeChatResult).text || '', undefined, {
          title: (result as WeChatResult).title
        });
      }
      return this.error('wechat-article', 'Unexpected result format');
    } catch (e) {
      return this.error('wechat-article', `Evaluation error: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  private async extractProfile(cdp: ICDPClient, url: string, options?: ExtractionOptions): Promise<PlatformContent> {
    const maxLength = options?.maxLength ?? 10000;

    const script = `
      (async () => {
        const maxLength = ${maxLength};

        const titleEl = document.querySelector('.profile_nickname') ||
                       document.querySelector('.account_name') ||
                       document.querySelector('h1');
        const title = titleEl?.textContent?.trim() || document.title.replace('_微信公众号', '').trim() || '微信公众号';

        const introEl = document.querySelector('.profile_desc') ||
                       document.querySelector('.account_intro');
        const intro = introEl?.textContent?.trim() || '';

        const lines = [];
        lines.push('# ' + title);
        lines.push('');

        if (intro) {
          lines.push('**简介:** ' + intro);
        }

        lines.push('');
        lines.push('**链接:** ' + url);
        lines.push('');

        // Get articles
        const articles = [];
        const articleEls = document.querySelectorAll('.article_list_item') ||
                          document.querySelectorAll('.appmsg') ||
                          document.querySelectorAll('.weui-article');

        for (let i = 0; i < Math.min(articleEls.length, 15); i++) {
          const el = articleEls[i];
          const titleEl = el.querySelector('.title') || el.querySelector('h3') || el.querySelector('.appmsg_title');
          const digestEl = el.querySelector('.desc') || el.querySelector('.appmsg_desc');
          const dateEl = el.querySelector('.date') || el.querySelector('.time');
          const linkEl = el.querySelector('a');

          const articleTitle = titleEl?.textContent?.trim() || '';
          const digest = digestEl?.textContent?.trim() || '';
          const date = dateEl?.textContent?.trim() || '';
          const articleUrl = linkEl?.href || '';

          if (articleTitle) {
            articles.push({
              title: articleTitle.replace(/\\s+/g, ' ').trim(),
              digest: digest.replace(/\\s+/g, ' ').trim(),
              date,
              url: articleUrl
            });
          }
        }

        if (articles.length > 0) {
          lines.push('---');
          lines.push('');
          lines.push('## 最新文章 (' + articles.length + ')');
          lines.push('');

          for (const a of articles) {
            lines.push('### ' + a.title);
            if (a.digest) lines.push(a.digest.substring(0, 200));
            if (a.date) lines.push('**发布时间:** ' + a.date);
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
        return this.success('wechat-article', (result as WeChatResult).text || '', undefined, {
          title: (result as WeChatResult).title
        });
      }
      return this.error('wechat-article', 'Unexpected result format');
    } catch (e) {
      return this.error('wechat-article', `Evaluation error: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  private async extractGeneric(cdp: ICDPClient, url: string, options?: ExtractionOptions): Promise<PlatformContent> {
    const maxLength = options?.maxLength ?? 8000;

    const script = `
      (async () => {
        const maxLength = ${maxLength};
        const title = document.title.replace('_微信公众号', '').replace('_微信公众平台', '').trim() || '微信';

        const mainEl = document.querySelector('#js_pc_qr_code')?.parentElement ||
                      document.querySelector('#img-content') ||
                      document.querySelector('main') ||
                      document.body;

        const clone = mainEl.cloneNode(true);
        clone.querySelectorAll('script, style, .qrcode, iframe').forEach(el => el.remove());

        const text = clone.textContent?.trim() || '';
        const truncated = text.length > 3000 ? text.substring(0, 3000) + '...' : text;

        const lines = [];
        lines.push('# ' + title);
        lines.push('');
        lines.push('**链接:** ' + url);
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
        return this.success('wechat-article', (result as WeChatResult).text || '', undefined, {
          title: (result as WeChatResult).title
        });
      }
      return this.error('wechat-article', 'Unexpected result format');
    } catch (e) {
      return this.error('wechat-article', `Evaluation error: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}

export const weChatArticleExtractor = new WeChatArticleExtractor();
