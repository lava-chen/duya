import type { ResearchFinding, ResearchSource } from './types.js';

// M1.5: 去重服务 - 实现强规则去重
export class DeduplicationService {
  private seenUrls = new Set<string>();
  private seenDOIs = new Set<string>();
  private seenArxivIds = new Set<string>();
  private seenTitles = new Map<string, string>(); // title hash -> source id
  private seenQueries = new Map<string, string>(); // normalized query -> original

  // URL 规范化
  normalizeUrl(url: string): string {
    let u = url.toLowerCase().trim();
    // 去掉协议
    u = u.replace(/^https?:\/\//, '');
    // 去掉尾斜杠
    u = u.replace(/\/$/, '');
    // 去掉 query string
    u = u.replace(/\?.*$/, '');
    // 去掉 hash
    u = u.replace(/#.*$/, '');
    // 去掉 UTM 参数
    u = u.replace(/utm_[^&]+&?/g, '');
    return u;
  }

  // 查询规范化
  normalizeQuery(query: string): string {
    return query.toLowerCase().trim().replace(/\s+/g, ' ');
  }

  // 标题哈希（用于近似去重）
  hashTitle(title: string): string {
    const normalized = title.toLowerCase().trim().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ');
    // 简单哈希：取前 50 字符 + 长度
    return `${normalized.slice(0, 50)}_${normalized.length}`;
  }

  // 检查发现是否重复
  isDuplicate(finding: Partial<ResearchFinding>): { duplicate: boolean; reason: string | null } {
    // 1. DOI 检查
    if (finding.doi) {
      const doi = finding.doi.toLowerCase();
      if (this.seenDOIs.has(doi)) {
        return { duplicate: true, reason: 'doi' };
      }
    }

    // 2. arXiv ID 检查
    if (finding.arxivId) {
      const arxivId = finding.arxivId.toLowerCase();
      if (this.seenArxivIds.has(arxivId)) {
        return { duplicate: true, reason: 'arxiv' };
      }
    }

    // 3. URL 检查
    if (finding.url) {
      const normUrl = this.normalizeUrl(finding.url);
      if (this.seenUrls.has(normUrl)) {
        return { duplicate: true, reason: 'url' };
      }
    }

    // 4. 标题哈希检查
    if (finding.title) {
      const hash = this.hashTitle(finding.title);
      if (this.seenTitles.has(hash)) {
        return { duplicate: true, reason: 'title' };
      }
    }

    return { duplicate: false, reason: null };
  }

  // 检查来源是否重复
  isDuplicateSource(source: Partial<ResearchSource>): { duplicate: boolean; reason: string | null } {
    return this.isDuplicate(source as unknown as Partial<ResearchFinding>);
  }

  // 检查查询是否重复
  isDuplicateQuery(query: string): { duplicate: boolean; original: string | null } {
    const normalized = this.normalizeQuery(query);
    const existing = this.seenQueries.get(normalized);
    return {
      duplicate: !!existing,
      original: existing || null,
    };
  }

  // 记录发现
  record(finding: ResearchFinding): void {
    if (finding.doi) {
      this.seenDOIs.add(finding.doi.toLowerCase());
    }
    if (finding.arxivId) {
      this.seenArxivIds.add(finding.arxivId.toLowerCase());
    }
    if (finding.url) {
      this.seenUrls.add(this.normalizeUrl(finding.url));
    }
    if (finding.title) {
      this.seenTitles.set(this.hashTitle(finding.title), finding.id);
    }
    if (finding.canonicalUrl) {
      this.seenUrls.add(this.normalizeUrl(finding.canonicalUrl));
    }
  }

  // 记录来源
  recordSource(source: ResearchSource): void {
    this.record(source as unknown as ResearchFinding);
  }

  // 记录查询
  recordQuery(query: string): string {
    const normalized = this.normalizeQuery(query);
    if (!this.seenQueries.has(normalized)) {
      this.seenQueries.set(normalized, query);
    }
    return query;
  }

  // 获取统计信息
  getStats(): {
    uniqueUrls: number;
    uniqueDOIs: number;
    uniqueArxivIds: number;
    uniqueTitles: number;
    uniqueQueries: number;
  } {
    return {
      uniqueUrls: this.seenUrls.size,
      uniqueDOIs: this.seenDOIs.size,
      uniqueArxivIds: this.seenArxivIds.size,
      uniqueTitles: this.seenTitles.size,
      uniqueQueries: this.seenQueries.size,
    };
  }

  // 重置（用于新研究会话）
  reset(): void {
    this.seenUrls.clear();
    this.seenDOIs.clear();
    this.seenArxivIds.clear();
    this.seenTitles.clear();
    this.seenQueries.clear();
  }

  // 序列化
  toJSON(): Record<string, unknown> {
    return {
      seenUrls: Array.from(this.seenUrls),
      seenDOIs: Array.from(this.seenDOIs),
      seenArxivIds: Array.from(this.seenArxivIds),
      seenTitles: Array.from(this.seenTitles.entries()),
      seenQueries: Array.from(this.seenQueries.entries()),
    };
  }

  // 反序列化
  fromJSON(data: ReturnType<DeduplicationService['toJSON']>): void {
    this.seenUrls = new Set(data.seenUrls as string[]);
    this.seenDOIs = new Set(data.seenDOIs as string[]);
    this.seenArxivIds = new Set(data.seenArxivIds as string[]);
    this.seenTitles = new Map(data.seenTitles as [string, string][]);
    this.seenQueries = new Map(data.seenQueries as [string, string][]);
  }
}