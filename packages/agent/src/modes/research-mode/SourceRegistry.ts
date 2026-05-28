import type { ResearchSource, SourceType } from './types.js';

// M1.5: 来源注册表 - 统一管理来源，实现去重
export class SourceRegistry {
  private sources = new Map<string, ResearchSource>();
  private urlIndex = new Map<string, string>();    // canonicalUrl -> sourceId
  private doiIndex = new Map<string, string>();    // doi -> sourceId
  private arxivIdIndex = new Map<string, string>(); // arXiv ID -> sourceId

  // 注册新来源，返回 canonical id
  register(source: ResearchSource): string {
    // 检查是否已存在
    const existingId = this.findExisting(source);
    if (existingId) {
      return existingId;
    }

    // 生成新 ID
    const id = source.id || `src_${Date.now()}_${this.sources.size}`;
    const canonical = { ...source, id };

    this.sources.set(id, canonical);

    // 建立索引
    if (canonical.canonicalUrl || canonical.url) {
      const url = this.normalizeUrl(canonical.canonicalUrl || canonical.url!);
      this.urlIndex.set(url, id);
    }
    if (canonical.doi) {
      this.doiIndex.set(canonical.doi.toLowerCase(), id);
    }
    if (canonical.arxivId) {
      this.arxivIdIndex.set(canonical.arxivId.toLowerCase(), id);
    }

    return id;
  }

  // 获取来源
  get(id: string): ResearchSource | undefined {
    return this.sources.get(id);
  }

  // 通过 URL 查找
  findByUrl(url: string): ResearchSource | undefined {
    const normalized = this.normalizeUrl(url);
    const id = this.urlIndex.get(normalized);
    return id ? this.sources.get(id) : undefined;
  }

  // 通过 DOI 查找
  findByDoi(doi: string): ResearchSource | undefined {
    const id = this.doiIndex.get(doi.toLowerCase());
    return id ? this.sources.get(id) : undefined;
  }

  // 通过 arXiv ID 查找
  findByArxivId(arxivId: string): ResearchSource | undefined {
    const id = this.arxivIdIndex.get(arxivId.toLowerCase());
    return id ? this.sources.get(id) : undefined;
  }

  // 获取所有来源
  getAll(): ResearchSource[] {
    return Array.from(this.sources.values());
  }

  // 按来源类型筛选
  getByType(type: SourceType): ResearchSource[] {
    return Array.from(this.sources.values()).filter(s => s.sourceType === type);
  }

  // 获取来源数量
  size(): number {
    return this.sources.size;
  }

  // 检查是否存在
  has(id: string): boolean {
    return this.sources.has(id);
  }

  // URL 规范化
  private normalizeUrl(url: string): string {
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

  // 检查来源是否已存在
  private findExisting(source: Partial<ResearchSource>): string | null {
    // 按优先级检查：DOI > arXiv > URL
    if (source.doi) {
      const existing = this.doiIndex.get(source.doi.toLowerCase());
      if (existing) return existing;
    }
    if (source.arxivId) {
      const existing = this.arxivIdIndex.get(source.arxivId.toLowerCase());
      if (existing) return existing;
    }
    if (source.url || source.canonicalUrl) {
      const url = this.normalizeUrl(source.canonicalUrl || source.url!);
      const existing = this.urlIndex.get(url);
      if (existing) return existing;
    }
    return null;
  }

  // 序列化（用于持久化）
  toJSON(): { sources: ResearchSource[]; urlIndex: [string, string][]; doiIndex: [string, string][]; arxivIdIndex: [string, string][] } {
    return {
      sources: Array.from(this.sources.values()),
      urlIndex: Array.from(this.urlIndex.entries()),
      doiIndex: Array.from(this.doiIndex.entries()),
      arxivIdIndex: Array.from(this.arxivIdIndex.entries()),
    };
  }

  // 反序列化（用于恢复）
  fromJSON(data: ReturnType<SourceRegistry['toJSON']>): void {
    this.sources = new Map(data.sources.map(s => [s.id, s]));
    this.urlIndex = new Map(data.urlIndex);
    this.doiIndex = new Map(data.doiIndex);
    this.arxivIdIndex = new Map(data.arxivIdIndex);
  }
}