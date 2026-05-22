/**
 * Zhihu Content Extractor
 * Extracts Zhihu answers and articles via API
 */

import { BaseExtractor } from '../BaseExtractor.js';
import type { ICDPClient } from '../../CDPClient.js';
import type { PlatformContent, ExtractionOptions } from '../types.js';

interface ZhihuResult {
  kind: 'ok' | 'error' | 'inaccessible';
  text?: string;
  title?: string;
  detail?: string;
}

export class ZhihuExtractor extends BaseExtractor {
  name = 'zhihu';

  private hosts = ['zhihu.com', 'www.zhihu.com', 'zhuanlan.zhihu.com'];

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
      return this.error('zhihu-answer', 'Invalid URL');
    }

    try {
      // Detect page type and extract accordingly
      const pageType = this.detectPageType(parsed.pathname);

      let result: ZhihuResult;

      switch (pageType) {
        case 'answer':
          result = await this.extractAnswer(cdp, parsed.pathname, options);
          break;
        case 'question':
          result = await this.extractQuestion(cdp, parsed.pathname, options);
          break;
        case 'article':
          result = await this.extractArticle(cdp, parsed.pathname, options);
          break;
        default:
          result = await this.extractFromDOM(cdp, options);
      }

      if (result.kind !== 'ok' || !result.text) {
        return this.error(pageType === 'article' ? 'zhihu-article' : 'zhihu-answer', result.detail || 'Failed to extract content');
      }

      return this.success(
        pageType === 'article' ? 'zhihu-article' : 'zhihu-answer',
        result.text,
        undefined,
        { title: result.title }
      );
    } catch (e) {
      return this.error('zhihu-answer', `Extraction failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  private detectPageType(pathname: string): 'answer' | 'question' | 'article' | 'unknown' {
    if (pathname.includes('/answer/')) return 'answer';
    if (pathname.includes('/question/')) return 'question';
    if (pathname.includes('/p/')) return 'article';
    if (pathname.includes('/articles/')) return 'article';
    return 'unknown';
  }

  private extractAnswerId(pathname: string): string | null {
    const match = pathname.match(/\/answer\/([0-9]+)/);
    return match ? match[1] : null;
  }

  private extractQuestionId(pathname: string): string | null {
    const match = pathname.match(/\/question\/([0-9]+)/);
    return match ? match[1] : null;
  }

  private extractArticleSlug(pathname: string): string | null {
    const match = pathname.match(/\/p\/([^\/\?]+)/);
    return match ? match[1] : null;
  }

  private async extractAnswer(
    cdp: ICDPClient,
    pathname: string,
    options?: ExtractionOptions
  ): Promise<ZhihuResult> {
    const answerId = this.extractAnswerId(pathname);
    if (!answerId) {
      return { kind: 'error', detail: 'Could not extract answer ID' };
    }

    const maxLength = options?.maxLength ?? 10000;

    const script = `
      (async () => {
        const answerId = ${JSON.stringify(answerId)};
        const maxLength = ${maxLength};

        // Find the answer content from the page
        const answerEl = document.querySelector('.QuestionAnswer-content') ||
                        document.querySelector('[data-zop-questionanswer]') ||
                        document.querySelector('.List-item');

        if (!answerEl) {
          return { kind: 'error', detail: 'Answer element not found' };
        }

        // Extract question title
        const questionTitle = document.querySelector('.QuestionHeader-title')?.textContent?.trim() ||
                            document.querySelector('h1')?.textContent?.trim() || '';

        // Extract author info
        const authorEl = answerEl.querySelector('.AuthorInfo-name') ||
                        answerEl.querySelector('.UserLink-name');
        const authorName = authorEl?.textContent?.trim() || 'Anonymous';

        const authorBadgeEl = answerEl.querySelector('.AuthorInfo-badge');
        const authorBadge = authorBadgeEl?.textContent?.trim() || '';

        // Extract vote count
        const voteEl = answerEl.querySelector('.VoteButton--up') ||
                      answerEl.querySelector('[data-vote]');
        const voteText = voteEl?.textContent?.trim() || '0';
        const votes = parseInt(voteText.replace(/[^0-9]/g, '')) || 0;

        // Extract comment count
        const commentEl = answerEl.querySelector('.CommentItemCount') ||
                          answerEl.querySelector('[data-comment]');
        const commentText = commentEl?.textContent?.trim() || '0';
        const comments = parseInt(commentText.replace(/[^0-9]/g, '')) || 0;

        // Extract answer content
        const contentEl = answerEl.querySelector('.RichText') ||
                         answerEl.querySelector('.AnswerItem-richText') ||
                         answerEl.querySelector('[data-pid]');
        let answerContent = '';

        if (contentEl) {
          // Clone and clean the content
          const clone = contentEl.cloneNode(true);

          // Remove unwanted elements
          clone.querySelectorAll('script, style, .advertisement, .Promote, .Copyright').forEach(el => el.remove());

          answerContent = clone.textContent?.trim() || '';
        }

        // Build formatted output
        const lines = [];
        lines.push('# ' + questionTitle);
        lines.push('');
        lines.push('**Author:** ' + authorName + (authorBadge ? ' (' + authorBadge + ')' : ''));
        lines.push('**Votes:** ' + votes);
        lines.push('**Comments:** ' + comments);
        lines.push('');
        lines.push('---');
        lines.push('');
        lines.push(answerContent);

        let text = lines.join('\\n');
        if (text.length > maxLength) {
          text = text.substring(0, maxLength) + '\\n\\n*[内容已截断]*';
        }

        return {
          kind: 'ok',
          text: text,
          title: questionTitle
        };
      })()
    `;

    try {
      const result = await cdp.evaluate(script);
      if (result && typeof result === 'object' && 'kind' in result) {
        return result as ZhihuResult;
      }
      return { kind: 'error', detail: 'Unexpected result format' };
    } catch (e) {
      return { kind: 'error', detail: `Evaluation error: ${e instanceof Error ? e.message : String(e)}` };
    }
  }

  private async extractQuestion(
    cdp: ICDPClient,
    pathname: string,
    options?: ExtractionOptions
  ): Promise<ZhihuResult> {
    const maxLength = options?.maxLength ?? 15000;

    const script = `
      (async () => {
        const maxLength = ${maxLength};

        // Extract question title
        const questionTitle = document.querySelector('.QuestionHeader-title')?.textContent?.trim() ||
                            document.querySelector('h1')?.textContent?.trim() || 'Untitled Question';

        // Extract question details
        const questionDetail = document.querySelector('.QuestionHeader-detail') ||
                              document.querySelector('.QuestionRichText');
        const detailText = questionDetail?.textContent?.trim() || '';

        // Extract answer count
        const answerCountEl = document.querySelector('.List-headerText') ||
                             document.querySelector('[data-num]');
        const answerCount = answerCountEl?.textContent?.trim() || '0';

        // Extract top answers
        const answerEls = document.querySelectorAll('.QuestionAnswer-item');
        const topAnswers = [];

        for (let i = 0; i < Math.min(answerEls.length, 3); i++) {
          const answerEl = answerEls[i];
          const authorEl = answerEl.querySelector('.AuthorInfo-name');
          const contentEl = answerEl.querySelector('.RichText') || answerEl.querySelector('[data-pid]');
          const voteEl = answerEl.querySelector('.VoteButton--up');

          const author = authorEl?.textContent?.trim() || 'Anonymous';
          const content = contentEl?.textContent?.trim() || '';
          const votes = voteEl?.textContent?.trim() || '0';

          if (content) {
            topAnswers.push({
              author,
              content: content.substring(0, 500) + (content.length > 500 ? '...' : ''),
              votes
            });
          }
        }

        // Build output
        const lines = [];
        lines.push('# ' + questionTitle);
        lines.push('');

        if (detailText) {
          lines.push(detailText.substring(0, 500));
          lines.push('');
        }

        lines.push('**Answers:** ' + answerCount);
        lines.push('');
        lines.push('---');
        lines.push('');

        if (topAnswers.length > 0) {
          lines.push('## Top Answers');
          lines.push('');

          for (let i = 0; i < topAnswers.length; i++) {
            const ans = topAnswers[i];
            lines.push('### Answer ' + (i + 1));
            lines.push('');
            lines.push('**Author:** ' + ans.author + ' **Votes:** ' + ans.votes);
            lines.push('');
            lines.push(ans.content);
            lines.push('');
            lines.push('---');
            lines.push('');
          }
        } else {
          lines.push('*No answers found on this page.*');
        }

        let text = lines.join('\\n');
        if (text.length > maxLength) {
          text = text.substring(0, maxLength) + '\\n\\n*[内容已截断]*';
        }

        return {
          kind: 'ok',
          text: text,
          title: questionTitle
        };
      })()
    `;

    try {
      const result = await cdp.evaluate(script);
      if (result && typeof result === 'object' && 'kind' in result) {
        return result as ZhihuResult;
      }
      return { kind: 'error', detail: 'Unexpected result format' };
    } catch (e) {
      return { kind: 'error', detail: `Evaluation error: ${e instanceof Error ? e.message : String(e)}` };
    }
  }

  private async extractArticle(
    cdp: ICDPClient,
    pathname: string,
    options?: ExtractionOptions
  ): Promise<ZhihuResult> {
    const maxLength = options?.maxLength ?? 15000;

    const script = `
      (async () => {
        const maxLength = ${maxLength};

        // Extract article title
        const articleTitle = document.querySelector('.Post-Title')?.textContent?.trim() ||
                            document.querySelector('.ArticleTitle')?.textContent?.trim() ||
                            document.querySelector('h1')?.textContent?.trim() || 'Untitled Article';

        // Extract author
        const authorName = document.querySelector('.AuthorInfo-name')?.textContent?.trim() || 'Anonymous';

        // Extract article content
        const contentEl = document.querySelector('.Post-RichText') ||
                         document.querySelector('.RichText') ||
                         document.querySelector('.ArticleContent');

        let content = '';
        if (contentEl) {
          const clone = contentEl.cloneNode(true);
          clone.querySelectorAll('script, style, .advertisement').forEach(el => el.remove());
          content = clone.textContent?.trim() || '';
        }

        // Extract stats
        const statsEl = document.querySelector('.ContentItem-actions');
        const statsText = statsEl?.textContent?.trim() || '';

        // Build output
        const lines = [];
        lines.push('# ' + articleTitle);
        lines.push('');
        lines.push('**Author:** ' + authorName);
        lines.push('');
        lines.push('---');
        lines.push('');
        lines.push(content);

        let text = lines.join('\\n');
        if (text.length > maxLength) {
          text = text.substring(0, maxLength) + '\\n\\n*[内容已截断]*';
        }

        return {
          kind: 'ok',
          text: text,
          title: articleTitle
        };
      })()
    `;

    try {
      const result = await cdp.evaluate(script);
      if (result && typeof result === 'object' && 'kind' in result) {
        return result as ZhihuResult;
      }
      return { kind: 'error', detail: 'Unexpected result format' };
    } catch (e) {
      return { kind: 'error', detail: `Evaluation error: ${e instanceof Error ? e.message : String(e)}` };
    }
  }

  private async extractFromDOM(cdp: ICDPClient, options?: ExtractionOptions): Promise<ZhihuResult> {
    // Generic extraction from DOM
    const maxLength = options?.maxLength ?? 10000;

    const script = `
      (async () => {
        const maxLength = ${maxLength};

        const title = document.querySelector('h1')?.textContent?.trim() || 'Untitled';
        const mainContent = document.querySelector('main') || document.querySelector('#root') || document.body;

        const clone = mainContent.cloneNode(true);
        clone.querySelectorAll('script, style, nav, footer, aside, .advertisement, .sidebar').forEach(el => el.remove());

        const text = clone.textContent?.trim() || '';
        const truncated = text.length > maxLength ? text.substring(0, maxLength) + '...' : text;

        return {
          kind: 'ok',
          text: '# ' + title + '\\n\\n' + truncated,
          title: title
        };
      })()
    `;

    try {
      const result = await cdp.evaluate(script);
      if (result && typeof result === 'object' && 'kind' in result) {
        return result as ZhihuResult;
      }
      return { kind: 'error', detail: 'Unexpected result format' };
    } catch (e) {
      return { kind: 'error', detail: `Evaluation error: ${e instanceof Error ? e.message : String(e)}` };
    }
  }
}

export const zhihuExtractor = new ZhihuExtractor();
