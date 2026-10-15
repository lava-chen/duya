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
    const onZhihu = this.hosts.some(
      (host) => parsed.hostname === host || parsed.hostname.endsWith(`.${host}`)
    );
    if (!onZhihu) return false;
    // Also route hot/top-story list pages (www.zhihu.com/hot, /billboard) and
    // question pages (/question/<id> without a specific answer) through this
    // extractor. The host check above already covers them.
    return true;
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
        case 'hot':
          result = await this.extractHot(cdp, options);
          break;
        default:
          result = await this.extractFromDOM(cdp, options);
      }

      if (result.kind !== 'ok' || !result.text) {
        return this.error(this.contentTypeFor(pageType), result.detail || 'Failed to extract content');
      }

      return this.success(
        this.contentTypeFor(pageType),
        result.text,
        undefined,
        { title: result.title }
      );
    } catch (e) {
      return this.error(this.detectPageTypeSafely(url), `Extraction failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  private contentTypeFor(
    pageType: 'answer' | 'question' | 'article' | 'hot' | 'unknown'
  ): 'zhihu-article' | 'zhihu-answer' {
    if (pageType === 'article' || pageType === 'hot') return 'zhihu-article';
    return 'zhihu-answer';
  }

  private detectPageTypeSafely(url: string): 'zhihu-article' | 'zhihu-answer' {
    const parsed = this.parseUrl(url);
    if (parsed) {
      const pageType = this.detectPageType(parsed.pathname);
      return this.contentTypeFor(pageType);
    }
    return 'zhihu-answer';
  }

  private detectPageType(pathname: string): 'answer' | 'question' | 'article' | 'hot' | 'unknown' {
    if (/\/hot(?:\/|\?|$)/.test(pathname) || /\/billboard(?:\/|\?|$)/.test(pathname)) return 'hot';
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

  /**
   * Run a script in the page and normalize the result to ZhihuResult.
   */
  private async runScript(cdp: ICDPClient, script: string): Promise<ZhihuResult> {
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
    _pathname: string,
    options?: ExtractionOptions
  ): Promise<ZhihuResult> {
    // Prefer the in-page embedded JSON (window.__INITIAL_STATE__).
    const stateResult = await this.runScript(cdp, this.buildQuestionStateScript(options));
    if (stateResult.kind === 'ok') return stateResult;

    // Fall back to DOM selectors.
    const domResult = await this.runScript(cdp, this.buildQuestionDomScript(options));
    if (domResult.kind === 'ok') return domResult;
    return { kind: 'error', detail: domResult.detail || 'Failed to extract question answers' };
  }

  private buildQuestionStateScript(options?: ExtractionOptions): string {
    const maxLength = options?.maxLength ?? 15000;

    return `(async () => {
      const maxLength = ${maxLength};
      const ANSWERS_LIMIT = 10;
      const CONTENT_LIMIT = 300;
      const stripHtml = (html) => {
        if (!html) return '';
        const div = document.createElement('div');
        div.innerHTML = html;
        return (div.textContent || '').replace(/\\s+/g, ' ').trim();
      };
      const state = window.__INITIAL_STATE__;
      if (!state) {
        return { kind: 'inaccessible', detail: 'No initial state' };
      }
      let questionId = '';
      let questionTitle = '';
      let answers = [];
      try {
        const initialState = (state.data && state.data.initialState) || state.initialState || state;
        const q = initialState.question;
        if (!q || typeof q.title !== 'string') {
          return { kind: 'inaccessible', detail: 'No question in initial state' };
        }
        questionId = q.id === undefined ? '' : String(q.id);
        questionTitle = q.title;
        const rawAnswers = initialState.answers;
        let arr = [];
        if (Array.isArray(rawAnswers)) {
          arr = rawAnswers;
        } else if (rawAnswers && typeof rawAnswers === 'object') {
          arr = Object.keys(rawAnswers).map((key) => rawAnswers[key]).filter(Boolean);
        }
        answers = arr
          .map((a) => {
            const aid = a && a.id !== undefined ? String(a.id) : '';
            return {
              id: aid,
              author: a && a.author && a.author.name ? String(a.author.name) : 'Anonymous',
              votes: a && typeof a.voteup_count === 'number' ? a.voteup_count : 0,
              content: stripHtml(a && a.content ? a.content : '')
            };
          })
          .filter((a) => a.content || a.id)
          .slice(0, ANSWERS_LIMIT);
      } catch {
        return { kind: 'inaccessible', detail: 'Failed to parse initial state' };
      }
      if (!answers.length) {
        return { kind: 'inaccessible', detail: 'No answers in initial state' };
      }
      const lines = ['# ' + questionTitle, '', '## Top Answers', ''];
      for (let i = 0; i < answers.length; i++) {
        const a = answers[i];
        const link = a.id
          ? 'https://www.zhihu.com/question/' + questionId + '/answer/' + a.id
          : '';
        const snippet = a.content.length > CONTENT_LIMIT ? a.content.substring(0, CONTENT_LIMIT) + '…' : a.content;
        lines.push((i + 1) + '. **' + a.author + '** (Votes: ' + a.votes + ')');
        if (snippet) lines.push('');
        lines.push(snippet);
        lines.push('');
        if (link) lines.push('Link: ' + link);
        lines.push('');
      }
      let text = lines.join('\\n');
      if (text.length > maxLength) {
        text = text.substring(0, maxLength) + '\\n\\n*[内容已截断]*';
      }
      return { kind: 'ok', text: text, title: questionTitle };
    })()`;
  }

  private buildQuestionDomScript(options?: ExtractionOptions): string {
    const maxLength = options?.maxLength ?? 15000;

    return `(async () => {
      const maxLength = ${maxLength};
      const ANSWERS_LIMIT = 10;
      const CONTENT_LIMIT = 300;
      const questionTitle = document.querySelector('.QuestionHeader-title')?.textContent?.trim() ||
                          document.querySelector('h1')?.textContent?.trim() || 'Untitled Question';
      const answerEls = document.querySelectorAll('.QuestionAnswer-item');
      const answers = [];
      for (let i = 0; i < answerEls.length && answers.length < ANSWERS_LIMIT; i++) {
        const el = answerEls[i];
        const authorEl = el.querySelector('.AuthorInfo-name') || el.querySelector('.UserLink-name');
        const contentEl = el.querySelector('.RichText') || el.querySelector('[data-pid]');
        const voteText = (el.querySelector('.VoteButton--up') || el.querySelector('[data-vote]'))?.textContent?.trim() || '0';
        const votes = parseInt(voteText.replace(/[^0-9]/g, ''), 10) || 0;
        let link = '';
        const anchor = el.querySelector('a');
        if (anchor && anchor.href) link = anchor.href;
        const content = contentEl?.textContent?.trim() || '';
        if (content) {
          answers.push({ author: authorEl?.textContent?.trim() || 'Anonymous', votes, content, link });
        }
      }
      if (!answers.length) {
        return { kind: 'error', detail: 'No answers found on the question page' };
      }
      const lines = ['# ' + questionTitle, '', '## Top Answers', ''];
      for (let i = 0; i < answers.length; i++) {
        const a = answers[i];
        const snippet = a.content.length > CONTENT_LIMIT ? a.content.substring(0, CONTENT_LIMIT) + '…' : a.content;
        lines.push((i + 1) + '. **' + a.author + '** (Votes: ' + a.votes + ')');
        if (snippet) lines.push('');
        lines.push(snippet);
        lines.push('');
        if (a.link) lines.push('Link: ' + a.link);
        lines.push('');
      }
      let text = lines.join('\\n');
      if (text.length > maxLength) {
        text = text.substring(0, maxLength) + '\\n\\n*[内容已截断]*';
      }
      return { kind: 'ok', text: text, title: questionTitle };
    })()`;
  }

  private async extractHot(cdp: ICDPClient, options?: ExtractionOptions): Promise<ZhihuResult> {
    const maxLength = options?.maxLength ?? 20000;

    // 1) In-page embedded JSON (window.__INITIAL_STATE__).
    const stateResult = await this.runScript(cdp, this.buildHotStateScript(maxLength));
    if (stateResult.kind === 'ok') return stateResult;

    // 2) Hot-lists API called from within the page (no login required).
    const apiResult = await this.runScript(cdp, this.buildHotApiScript(maxLength));
    if (apiResult.kind === 'ok') return apiResult;

    // 3) DOM selectors as a last resort.
    const domResult = await this.runScript(cdp, this.buildHotDomScript(maxLength));
    if (domResult.kind === 'ok') return domResult;
    return { kind: 'error', detail: domResult.detail || 'Failed to extract hot list' };
  }

  private buildHotStateScript(maxLength: number): string {
    return `(async () => {
      const maxLength = ${maxLength};
      const HOT_LIMIT = 50;
      const findHotList = (root, depth) => {
        if (!root || typeof root !== 'object' || depth > 8) return null;
        if (Array.isArray(root) && root.length > 0 && root[0] &&
            typeof root[0] === 'object' && root[0].target && typeof root[0].target.title === 'string') {
          return root;
        }
        if (Array.isArray(root)) {
          for (const item of root) {
            const found = findHotList(item, depth + 1);
            if (found) return found;
          }
          return null;
        }
        for (const key of Object.keys(root)) {
          const found = findHotList(root[key], depth + 1);
          if (found) return found;
        }
        return null;
      };
      const state = window.__INITIAL_STATE__;
      if (!state) return { kind: 'inaccessible', detail: 'No initial state' };
      let list = null;
      try {
        list = findHotList(state, 0);
      } catch {
        return { kind: 'inaccessible', detail: 'Failed to parse initial state' };
      }
      if (!list) return { kind: 'inaccessible', detail: 'No hot list in initial state' };
      const items = list
        .map((item, i) => {
          const t = item.target || {};
          const qid = t.id === undefined ? '' : String(t.id);
          return {
            rank: i + 1,
            title: typeof t.title === 'string' ? t.title : '',
            url: qid ? 'https://www.zhihu.com/question/' + qid : '',
            heat: typeof item.detail_text === 'string' ? item.detail_text : ''
          };
        })
        .filter((it) => it.title)
        .slice(0, HOT_LIMIT);
      if (!items.length) return { kind: 'inaccessible', detail: 'No hot items in initial state' };
      const lines = ['# 知乎热榜', ''];
      for (const it of items) {
        let line = it.rank + '. **' + it.title + '**';
        if (it.heat) line += ' — ' + it.heat;
        if (it.url) line += ' (' + it.url + ')';
        lines.push(line);
      }
      let text = lines.join('\\n');
      if (text.length > maxLength) {
        text = text.substring(0, maxLength) + '\\n\\n*[内容已截断]*';
      }
      return { kind: 'ok', text: text, title: '知乎热榜' };
    })()`;
  }

  private buildHotApiScript(maxLength: number): string {
    return `(async () => {
      const maxLength = ${maxLength};
      const HOT_LIMIT = 50;
      try {
        const res = await fetch('https://www.zhihu.com/api/v3/feed/topstory/hot-lists/total?limit=50', {
          credentials: 'include'
        });
        if (!res.ok) return { kind: 'inaccessible', detail: 'Hot list request failed (HTTP ' + res.status + ')' };
        const text = await res.text();
        let data;
        try {
          data = JSON.parse(text.replace(/("id"\\s*:\\s*)(\\d{16,})/g, '$1"$2"'));
        } catch {
          return { kind: 'inaccessible', detail: 'Hot list JSON parse failed' };
        }
        const items = (data && Array.isArray(data.data) ? data.data : [])
          .map((item, i) => {
            const t = item.target || {};
            const qid = t.id === undefined ? '' : String(t.id);
            return {
              rank: i + 1,
              title: typeof t.title === 'string' ? t.title : '',
              url: qid ? 'https://www.zhihu.com/question/' + qid : '',
              heat: typeof item.detail_text === 'string' ? item.detail_text : ''
            };
          })
          .filter((it) => it.title)
          .slice(0, HOT_LIMIT);
        if (!items.length) return { kind: 'inaccessible', detail: 'No hot items returned' };
        const lines = ['# 知乎热榜', ''];
        for (const it of items) {
          let line = it.rank + '. **' + it.title + '**';
          if (it.heat) line += ' — ' + it.heat;
          if (it.url) line += ' (' + it.url + ')';
          lines.push(line);
        }
        let output = lines.join('\\n');
        if (output.length > maxLength) {
          output = output.substring(0, maxLength) + '\\n\\n*[内容已截断]*';
        }
        return { kind: 'ok', text: output, title: '知乎热榜' };
      } catch (e) {
        return { kind: 'inaccessible', detail: e && e.message ? String(e.message) : String(e) };
      }
    })()`;
  }

  private buildHotDomScript(maxLength: number): string {
    return `(async () => {
      const maxLength = ${maxLength};
      const HOT_LIMIT = 50;
      const els = document.querySelectorAll('.HotItem');
      const items = [];
      for (let i = 0; i < els.length && items.length < HOT_LIMIT; i++) {
        const el = els[i];
        const anchor = el.querySelector('a.HotItem-title') || el.querySelector('.HotItem-title');
        const title = anchor ? (anchor.textContent || '').trim() : '';
        let url = '';
        if (anchor && anchor.href) url = anchor.href;
        const heatEl = el.querySelector('.HotItem-metrics') || el.querySelector('.HotItem-rank');
        const heat = heatEl ? (heatEl.textContent || '').trim() : '';
        if (title) items.push({ rank: items.length + 1, title, url, heat });
      }
      if (!items.length) {
        return { kind: 'error', detail: 'No hot items found on the page' };
      }
      const lines = ['# 知乎热榜', ''];
      for (const it of items) {
        let line = it.rank + '. **' + it.title + '**';
        if (it.heat) line += ' — ' + it.heat;
        if (it.url) line += ' (' + it.url + ')';
        lines.push(line);
      }
      let text = lines.join('\\n');
      if (text.length > maxLength) {
        text = text.substring(0, maxLength) + '\\n\\n*[内容已截断]*';
      }
      return { kind: 'ok', text: text, title: '知乎热榜' };
    })()`;
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
