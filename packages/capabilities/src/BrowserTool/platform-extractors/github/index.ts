/**
 * GitHub Content Extractor
 * Extracts repository info, issues, pull requests, and code from GitHub
 */

import { BaseExtractor } from '../BaseExtractor.js';
import type { ICDPClient } from '../../CDPClient.js';
import type { PlatformContent, ExtractionOptions } from '../types.js';

interface GitHubResult {
  kind: 'ok' | 'error';
  text?: string;
  title?: string;
  detail?: string;
}

export class GitHubExtractor extends BaseExtractor {
  name = 'github';

  private hosts = ['github.com', 'www.github.com'];

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
      return this.error('github-repo', 'Invalid URL');
    }

    try {
      const pathname = parsed.pathname;
      const segments = pathname.split('/').filter(Boolean);

      // Repository root
      if (segments.length === 1) {
        return this.extractRepository(cdp, url, options);
      }

      // Repository with path
      if (segments.length >= 2) {
        const repoPath = segments.slice(2).join('/');

        if (segments.includes('issues')) {
          return this.extractIssues(cdp, url, options);
        } else if (segments.includes('pull')) {
          return this.extractPullRequest(cdp, url, options);
        } else if (segments.includes('discussions')) {
          return this.extractDiscussions(cdp, url, options);
        } else if (segments.includes('releases')) {
          return this.extractReleases(cdp, url, options);
        } else if (segments.includes('actions')) {
          return this.extractActions(cdp, url, options);
        } else if (segments.includes('projects')) {
          return this.extractProjects(cdp, url, options);
        } else if (segments[2] && !repoPath.includes('.')) {
          // Likely a code path or README
          return this.extractCodePath(cdp, url, options);
        } else {
          return this.extractRepository(cdp, url, options);
        }
      }

      return this.extractGeneric(cdp, url, options);
    } catch (e) {
      return this.error('github-repo', `Extraction failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  private extractRepoSegments(pathname: string): { owner: string; repo: string } | null {
    const segments = pathname.split('/').filter(Boolean);
    if (segments.length >= 2) {
      return { owner: segments[0], repo: segments[1] };
    }
    return null;
  }

  private async extractRepository(cdp: ICDPClient, url: string, options?: ExtractionOptions): Promise<PlatformContent> {
    const maxLength = options?.maxLength ?? 12000;
    const repoInfo = this.extractRepoSegments(new URL(url).pathname);

    const script = `
      (async () => {
        const maxLength = ${maxLength};

        const repoName = document.querySelector('.repo-title')?.textContent?.trim() ||
                        document.querySelector('h1')?.textContent?.trim() ||
                        document.title.replace(' · GitHub', '').trim() || 'Repository';

        // Get description
        const descEl = document.querySelector('.repo-title-description') ||
                      document.querySelector('.col-9 .f4') ||
                      document.querySelector('[itemprop="description"]');
        const description = descEl?.textContent?.trim() || '';

        // Get stats
        const stats = [];
        const statEls = document.querySelectorAll('.stat-entry') ||
                       document.querySelectorAll('.file-info a')?.length ? null :
                       document.querySelectorAll('.UnderlineNav-item');
        if (statEls) {
          for (const el of statEls) {
            const text = el.textContent?.trim() || '';
            if (text) stats.push(text.replace(/\\s+/g, ' '));
          }
        }

        // Get language
        const langEl = document.querySelector('.repo-language') ||
                     document.querySelector('[itemprop="programmingLanguage"]');
        const language = langEl?.textContent?.trim() || '';

        // Get stars, forks, watchers
        const starEl = document.querySelector('a[href*="/stargazers"] .Counter') ||
                      document.querySelector('.social-count[href*="/stargazers"]');
        const forkEl = document.querySelector('a[href*="/forks"] .Counter') ||
                      document.querySelector('.social-count[href*="/forks"]');
        const watchEl = document.querySelector('a[href*="/watchers"] .Counter');

        const stars = starEl?.textContent?.trim() || '0';
        const forks = forkEl?.textContent?.trim() || '0';
        const watchers = watchEl?.textContent?.trim() || '0';

        // Get README content
        const readmeEl = document.querySelector('.markdown-body') ||
                        document.querySelector('#readme') ||
                        document.querySelector('[data-target="repository-content.content"]');
        let readme = '';
        if (readmeEl) {
          const clone = readmeEl.cloneNode(true);
          clone.querySelectorAll('script, style').forEach(el => el.remove());
          readme = clone.textContent?.trim() || '';
        }

        // Build output
        const lines = [];
        lines.push('# ' + repoName);
        lines.push('');

        if (description) {
          lines.push(description);
          lines.push('');
        }

        lines.push('**链接:** ' + url);
        lines.push('');

        lines.push('| 指标 | 数值 |');
        lines.push('|------|------|');
        lines.push('| Stars | ' + stars + ' |');
        lines.push('| Forks | ' + forks + ' |');
        lines.push('| Watchers | ' + watchers + ' |');

        if (language) {
          lines.push('| Language | ' + language + ' |');
        }

        lines.push('');

        // Get recent commits/contributors
        const activityEls = document.querySelectorAll('.contribution-row') ||
                           document.querySelectorAll('.js-yearly-contributions .f4');

        if (readme && readme.length > 50) {
          lines.push('---');
          lines.push('');
          lines.push('## README');
          lines.push('');
          lines.push(readme.substring(0, 3000));
        }

        let text = lines.join('\\n');
        if (text.length > maxLength) {
          text = text.substring(0, maxLength) + '\\n\\n*[Content truncated]*';
        }

        return {
          kind: 'ok',
          text: text,
          title: repoName
        };
      })()
    `;

    try {
      const result = await cdp.evaluate(script);
      if (result && typeof result === 'object' && 'kind' in result) {
        return this.success('github-repo', (result as GitHubResult).text || '', undefined, {
          title: (result as GitHubResult).title
        });
      }
      return this.error('github-repo', 'Unexpected result format');
    } catch (e) {
      return this.error('github-repo', `Evaluation error: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  private async extractIssues(cdp: ICDPClient, url: string, options?: ExtractionOptions): Promise<PlatformContent> {
    const maxLength = options?.maxLength ?? 12000;

    const script = `
      (async () => {
        const maxLength = ${maxLength};

        const pageTitle = document.title.replace(' · GitHub', '').trim();
        const repoName = pageTitle.includes('issues') ? pageTitle.replace('issues', '').trim() : pageTitle;

        const lines = [];
        lines.push('# ' + pageTitle);
        lines.push('');
        lines.push('**链接:** ' + url);
        lines.push('');

        // Get issue filters
        const filterEl = document.querySelector('.Button--primary') ||
                        document.querySelector('.SelectMenu-item--selected');
        const filter = filterEl?.textContent?.trim() || 'Issues';

        // Get issues
        const issues = [];
        const issueEls = document.querySelectorAll('.js-issue-row') ||
                        document.querySelectorAll('[data-issue-and-pr-hover-enabled]');

        for (let i = 0; i < Math.min(issueEls.length, 20); i++) {
          const el = issueEls[i];
          const titleEl = el.querySelector('a[id*="issue"]') || el.querySelector('a[href*="/issues/"]') || el.querySelector('.issue-title');
          const stateEl = el.querySelector('.State') || el.querySelector('[class*="state"]');
          const authorEl = el.querySelector('.opened-by');
          const commentEl = el.querySelector('.comment-count') || el.querySelector('[data-type="issue"] .comments');
          const dateEl = el.querySelector('relative-time') || el.querySelector('.opened-by time');
          const labelEls = el.querySelectorAll('.IssueLabel') || el.querySelectorAll('.labels span');

          const title = titleEl?.textContent?.trim() || '';
          const state = stateEl?.textContent?.trim() || '';
          const author = authorEl?.textContent?.trim() || '';
          const comments = commentEl?.textContent?.trim() || '0';
          const date = dateEl?.textContent?.trim() || dateEl?.getAttribute('datetime') || '';
          const labels = [];
          for (const labelEl of labelEls) {
            const label = labelEl.textContent?.trim();
            if (label) labels.push(label);
          }

          if (title) {
            issues.push({
              title: title.replace(/\\s+/g, ' ').trim(),
              state: state.replace(/\\s+/g, ' ').trim(),
              author: author.replace(/\\s+/g, ' ').trim().replace('Opened by', '').trim(),
              comments: comments.replace(/[^0-9]/g, ''),
              date,
              labels
            });
          }
        }

        if (issues.length > 0) {
          lines.push('---');
          lines.push('');
          lines.push('## Issues (' + filter + ')');
          lines.push('');

          for (const issue of issues) {
            lines.push('### ' + issue.state + ' ' + issue.title);
            lines.push('');
            const meta = [];
            if (issue.author) meta.push('#' + issue.author);
            if (issue.date) meta.push(issue.date);
            if (issue.comments !== '0') meta.push(issue.comments + ' comments');
            if (meta.length) lines.push('**' + meta.join(' • ') + '**');
            if (issue.labels.length > 0) {
              lines.push('**Labels:** ' + issue.labels.join(', '));
            }
            lines.push('');
          }
        } else {
          lines.push('*No issues found*');
        }

        let text = lines.join('\\n');
        if (text.length > maxLength) {
          text = text.substring(0, maxLength) + '\\n\\n*[Content truncated]*';
        }

        return {
          kind: 'ok',
          text: text,
          title: pageTitle
        };
      })()
    `;

    try {
      const result = await cdp.evaluate(script);
      if (result && typeof result === 'object' && 'kind' in result) {
        return this.success('github-repo', (result as GitHubResult).text || '', undefined, {
          title: (result as GitHubResult).title
        });
      }
      return this.error('github-repo', 'Unexpected result format');
    } catch (e) {
      return this.error('github-repo', `Evaluation error: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  private async extractPullRequest(cdp: ICDPClient, url: string, options?: ExtractionOptions): Promise<PlatformContent> {
    const maxLength = options?.maxLength ?? 12000;

    const script = `
      (async () => {
        const maxLength = ${maxLength};

        const titleEl = document.querySelector('.gh-header-title') ||
                       document.querySelector('h1');
        const title = titleEl?.textContent?.trim() || document.title.replace(' · GitHub', '').trim();

        const stateEl = document.querySelector('.State') ||
                       document.querySelector('[class*="pr-state"]');
        const state = stateEl?.textContent?.trim() || '';

        const authorEl = document.querySelector('.author a') ||
                        document.querySelector('[class*="author"]');
        const author = authorEl?.textContent?.trim() || '';

        // Get PR stats
        const stats = [];
        const statEls = document.querySelectorAll('.discuss-meta') ||
                       document.querySelectorAll('.pr-meta span');
        for (const el of statEls) {
          const text = el.textContent?.trim();
          if (text) stats.push(text.replace(/\\s+/g, ' '));
        }

        // Get description/body
        const bodyEl = document.querySelector('.markdown-body') ||
                      document.querySelector('[data-body-version]');
        let body = '';
        if (bodyEl) {
          const clone = bodyEl.cloneNode(true);
          clone.querySelectorAll('script, style').forEach(el => el.remove());
          body = clone.textContent?.trim() || '';
        }

        const lines = [];
        lines.push('# ' + title.replace(/^#\\s*/, ''));
        lines.push('');
        lines.push('**State:** ' + state);
        if (author) lines.push('**Author:** ' + author);
        lines.push('**链接:** ' + url);
        lines.push('');

        if (body) {
          lines.push('---');
          lines.push('');
          lines.push('## Description');
          lines.push('');
          lines.push(body.substring(0, 3000));
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
        return this.success('github-repo', (result as GitHubResult).text || '', undefined, {
          title: (result as GitHubResult).title
        });
      }
      return this.error('github-repo', 'Unexpected result format');
    } catch (e) {
      return this.error('github-repo', `Evaluation error: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  private async extractDiscussions(cdp: ICDPClient, url: string, options?: ExtractionOptions): Promise<PlatformContent> {
    const maxLength = options?.maxLength ?? 10000;

    const script = `
      (async () => {
        const maxLength = ${maxLength};
        const title = document.title.replace(' · GitHub', '').trim();

        const lines = [];
        lines.push('# ' + title);
        lines.push('');
        lines.push('**链接:** ' + url);
        lines.push('');

        const discussions = [];
        const discussionEls = document.querySelectorAll('[data-hpc="true"]') ||
                              document.querySelectorAll('.discussion-item');

        for (let i = 0; i < Math.min(discussionEls.length, 15); i++) {
          const el = discussionEls[i];
          const titleEl = el.querySelector('a[href*="/discussions/"]') ||
                          el.querySelector('.discussion-title');
          const authorEl = el.querySelector('.author') ||
                          el.querySelector('.link-gray');
          const commentEl = el.querySelector('.comment-count') ||
                          el.querySelector('[data-type="discussions"] .comments');
          const dateEl = el.querySelector('relative-time') || el.querySelector('time');
          const categoryEl = el.querySelector('.discussion-category');

          const discussionTitle = titleEl?.textContent?.trim() || '';
          const author = authorEl?.textContent?.trim() || '';
          const comments = commentEl?.textContent?.trim() || '0';
          const date = dateEl?.textContent?.trim() || '';
          const category = categoryEl?.textContent?.trim() || '';

          if (discussionTitle) {
            discussions.push({
              title: discussionTitle.replace(/\\s+/g, ' ').trim(),
              author,
              comments: comments.replace(/[^0-9]/g, ''),
              date,
              category
            });
          }
        }

        if (discussions.length > 0) {
          lines.push('---');
          lines.push('');
          lines.push('## Discussions');
          lines.push('');

          for (const d of discussions) {
            lines.push('### ' + d.title);
            const meta = [];
            if (d.author) meta.push(d.author);
            if (d.category) meta.push(d.category);
            if (d.date) meta.push(d.date);
            if (meta.length) lines.push('**' + meta.join(' • ') + '**');
            if (d.comments !== '0') lines.push('💬 ' + d.comments + ' comments');
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
        return this.success('github-repo', (result as GitHubResult).text || '', undefined, {
          title: (result as GitHubResult).title
        });
      }
      return this.error('github-repo', 'Unexpected result format');
    } catch (e) {
      return this.error('github-repo', `Evaluation error: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  private async extractReleases(cdp: ICDPClient, url: string, options?: ExtractionOptions): Promise<PlatformContent> {
    const maxLength = options?.maxLength ?? 10000;

    const script = `
      (async () => {
        const maxLength = ${maxLength};
        const title = document.title.replace(' · GitHub', '').trim();

        const lines = [];
        lines.push('# ' + title);
        lines.push('');
        lines.push('**链接:** ' + url);
        lines.push('');

        const releases = [];
        const releaseEls = document.querySelectorAll('.release-block') ||
                          document.querySelectorAll('[data-target="releases-container"] .Box');

        for (let i = 0; i < Math.min(releaseEls.length, 10); i++) {
          const el = releaseEls[i];
          const tagEl = el.querySelector('.Link--primary') ||
                       el.querySelector('.release-title');
          const dateEl = el.querySelector('relative-time') ||
                        el.querySelector('.release-date');
          const bodyEl = el.querySelector('.markdown-body') ||
                        el.querySelector('.release-body');
          const authorEl = el.querySelector('.release-author a');

          const tag = tagEl?.textContent?.trim() || '';
          const date = dateEl?.textContent?.trim() || '';
          const body = bodyEl?.textContent?.trim() || '';
          const author = authorEl?.textContent?.trim() || '';

          if (tag) {
            releases.push({
              tag: tag.replace(/\\s+/g, ' ').trim(),
              date,
              author,
              body: body.replace(/\\s+/g, ' ').trim().substring(0, 500)
            });
          }
        }

        if (releases.length > 0) {
          lines.push('---');
          lines.push('');
          lines.push('## Releases');
          lines.push('');

          for (const r of releases) {
            lines.push('### ' + r.tag);
            const meta = [];
            if (r.date) meta.push(r.date);
            if (r.author) meta.push('by ' + r.author);
            if (meta.length) lines.push('**' + meta.join(' • ') + '**');
            if (r.body) lines.push(r.body);
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
        return this.success('github-repo', (result as GitHubResult).text || '', undefined, {
          title: (result as GitHubResult).title
        });
      }
      return this.error('github-repo', 'Unexpected result format');
    } catch (e) {
      return this.error('github-repo', `Evaluation error: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  private async extractActions(cdp: ICDPClient, url: string, options?: ExtractionOptions): Promise<PlatformContent> {
    const maxLength = options?.maxLength ?? 8000;

    const script = `
      (async () => {
        const maxLength = ${maxLength};
        const title = document.title.replace(' · GitHub', '').trim();

        const lines = [];
        lines.push('# ' + title);
        lines.push('');
        lines.push('**链接:** ' + url);
        lines.push('');

        // Get workflow runs
        const runs = [];
        const runEls = document.querySelectorAll('.run-item') ||
                      document.querySelectorAll('[data-target="runs.container"] .Box-row');

        for (let i = 0; i < Math.min(runEls.length, 10); i++) {
          const el = runEls[i];
          const nameEl = el.querySelector('.workflow-name') || el.querySelector('.run-name');
          const statusEl = el.querySelector('.color-fg-readiness') || el.querySelector('[class*="status"]');
          const branchEl = el.querySelector('.branch-name');
          const dateEl = el.querySelector('relative-time') || el.querySelector('time');
          const commitEl = el.querySelector('.commit-title');

          const name = nameEl?.textContent?.trim() || '';
          const status = statusEl?.textContent?.trim() || '';
          const branch = branchEl?.textContent?.trim() || '';
          const date = dateEl?.textContent?.trim() || '';
          const commit = commitEl?.textContent?.trim() || '';

          if (name || commit) {
            runs.push({
              name: (name || commit).replace(/\\s+/g, ' ').trim().substring(0, 100),
              status: status.replace(/\\s+/g, ' ').trim(),
              branch,
              date
            });
          }
        }

        if (runs.length > 0) {
          lines.push('---');
          lines.push('');
          lines.push('## Recent Runs');
          lines.push('');

          for (const r of runs) {
            lines.push('### ' + r.name);
            const meta = [];
            if (r.status) meta.push(r.status);
            if (r.branch) meta.push(r.branch);
            if (r.date) meta.push(r.date);
            if (meta.length) lines.push('**' + meta.join(' • ') + '**');
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
        return this.success('github-repo', (result as GitHubResult).text || '', undefined, {
          title: (result as GitHubResult).title
        });
      }
      return this.error('github-repo', 'Unexpected result format');
    } catch (e) {
      return this.error('github-repo', `Evaluation error: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  private async extractProjects(cdp: ICDPClient, url: string, options?: ExtractionOptions): Promise<PlatformContent> {
    const maxLength = options?.maxLength ?? 8000;

    const script = `
      (async () => {
        const maxLength = ${maxLength};
        const title = document.title.replace(' · GitHub', '').replace('Projects', '').trim() || 'Projects';

        const lines = [];
        lines.push('# ' + title);
        lines.push('');
        lines.push('**链接:** ' + url);
        lines.push('');

        // Get project items
        const items = [];
        const itemEls = document.querySelectorAll('.project-card') ||
                       document.querySelectorAll('[data-project-item]') ||
                       document.querySelectorAll('.d-flex .flex-items-center');

        for (let i = 0; i < Math.min(itemEls.length, 15); i++) {
          const el = itemEls[i];
          const titleEl = el.querySelector('.project-card-title') || el.querySelector('[data-item-name]') || el.querySelector('a');
          const statusEl = el.querySelector('.ProjectLabel') ||
                          el.querySelector('[data-column-name]') ||
                          el.querySelector('.labels a');

          const itemTitle = titleEl?.textContent?.trim() || '';
          const status = statusEl?.textContent?.trim() || '';

          if (itemTitle && !itemTitle.includes('http')) {
            items.push({
              title: itemTitle.replace(/\\s+/g, ' ').trim(),
              status: status.replace(/\\s+/g, ' ').trim()
            });
          }
        }

        if (items.length > 0) {
          lines.push('---');
          lines.push('');
          lines.push('## Project Items');
          lines.push('');

          for (const item of items) {
            lines.push('- ' + item.title);
            if (item.status) lines.push('  - ' + item.status);
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
        return this.success('github-repo', (result as GitHubResult).text || '', undefined, {
          title: (result as GitHubResult).title
        });
      }
      return this.error('github-repo', 'Unexpected result format');
    } catch (e) {
      return this.error('github-repo', `Evaluation error: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  private async extractCodePath(cdp: ICDPClient, url: string, options?: ExtractionOptions): Promise<PlatformContent> {
    const maxLength = options?.maxLength ?? 8000;

    const script = `
      (async () => {
        const maxLength = ${maxLength};
        const title = document.title.replace(' · GitHub', '').trim();

        // Get file path
        const pathEl = document.querySelector('.final-path') ||
                      document.querySelector('.breadcrumb') ||
                      document.querySelector('.file-info');
        const filePath = pathEl?.textContent?.trim() || title;

        // Get file content preview (for non-binary files)
        const codeEl = document.querySelector('.highlight') ||
                      document.querySelector('pre') ||
                      document.querySelector('#raw');
        let codePreview = '';
        if (codeEl) {
          const clone = codeEl.cloneNode(true);
          clone.querySelectorAll('script, style').forEach(el => el.remove());
          codePreview = clone.textContent?.trim() || '';
        }

        // Get README if available
        const readmeEl = document.querySelector('.Box-body .markdown-body') ||
                         document.querySelector('#readme');
        let readme = '';
        if (readmeEl) {
          const clone = readmeEl.cloneNode(true);
          clone.querySelectorAll('script, style').forEach(el => el.remove());
          readme = clone.textContent?.trim() || '';
        }

        const lines = [];
        lines.push('# ' + title);
        lines.push('');
        lines.push('**路径:** ' + filePath);
        lines.push('**链接:** ' + url);
        lines.push('');

        if (readme && readme.length > 100) {
          lines.push('---');
          lines.push('');
          lines.push('## README');
          lines.push('');
          lines.push(readme.substring(0, 2000));
        } else if (codePreview) {
          lines.push('---');
          lines.push('');
          lines.push('## Code Preview');
          lines.push('');
          lines.push('\`\`\`');
          lines.push(codePreview.substring(0, 2000));
          lines.push('\`\`\`');
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
        return this.success('github-repo', (result as GitHubResult).text || '', undefined, {
          title: (result as GitHubResult).title
        });
      }
      return this.error('github-repo', 'Unexpected result format');
    } catch (e) {
      return this.error('github-repo', `Evaluation error: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  private async extractGeneric(cdp: ICDPClient, url: string, options?: ExtractionOptions): Promise<PlatformContent> {
    const maxLength = options?.maxLength ?? 5000;

    const script = `
      (async () => {
        const maxLength = ${maxLength};
        const title = document.title.replace(' · GitHub', '').trim();

        const mainEl = document.querySelector('main') || document.body;
        const clone = mainEl.cloneNode(true);
        clone.querySelectorAll('script, style, nav, footer, aside').forEach(el => el.remove());

        const text = clone.textContent?.trim() || '';
        const truncated = text.length > 2000 ? text.substring(0, 2000) + '...' : text;

        const lines = [];
        lines.push('# ' + title);
        lines.push('');
        lines.push('**链接:** ' + url);
        lines.push('');
        lines.push(truncated);

        let result = lines.join('\\n');
        if (result.length > maxLength) {
          result = result.substring(0, maxLength) + '\\n\\n*[Content truncated]*';
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
        return this.success('github-repo', (result as GitHubResult).text || '', undefined, {
          title: (result as GitHubResult).title
        });
      }
      return this.error('github-repo', 'Unexpected result format');
    } catch (e) {
      return this.error('github-repo', `Evaluation error: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}

export const githubExtractor = new GitHubExtractor();
