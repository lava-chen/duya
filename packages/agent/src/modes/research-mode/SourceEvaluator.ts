import type { SourceType, SourceQuality, ResearchSource } from './types.js';

export interface SourceEvaluationResult {
  sourceId: string;
  url: string;
  scores: SourceQuality;
  overall: number;
  decision: 'include' | 'exclude' | 'review';
  reasons: string[];
  warnings: string[];
}

interface AuthorityRule {
  pattern: RegExp;
  authority: number;
  reason: string;
}

// M1.4: 来源评估器 - 规则引擎（60%）+ LLM（40%）
export class SourceEvaluator {
  private llmComplete?: (prompt: string) => Promise<string>;

  // 来源类型 → 权威性基础分数
  private readonly SOURCE_TYPE_AUTHORITY: Partial<Record<SourceType, number>> = {
    paper: 0.9,      // peer-reviewed
    official: 0.85, // official docs/report
    dataset: 0.8,    // benchmark/repo
    review: 0.75,    // survey/review paper
    code: 0.6,       // GitHub repo
    news: 0.4,      // 权威媒体 > 社交
    blog: 0.3,      // 个人博客
    forum: 0.25,
    book: 0.5,
  };

  // 域名规则
  private readonly DOMAIN_RULES: AuthorityRule[] = [
    { pattern: /\.gov$/, authority: 0.95, reason: 'Government domain' },
    { pattern: /\.edu$/, authority: 0.85, reason: 'Educational institution' },
    { pattern: /\.org$/, authority: 0.8, reason: 'Non-profit organization' },
    { pattern: /nature|science|pnas/i, authority: 0.95, reason: 'Top-tier journal' },
    { pattern: /arxiv\.org/i, authority: 0.7, reason: 'Preprint server (arXiv)' },
    { pattern: /github\.com$/i, authority: 0.6, reason: 'Code repository' },
    { pattern: /gitlab\.com$/i, authority: 0.6, reason: 'Code repository' },
    { pattern: /stackoverflow\.com/i, authority: 0.5, reason: 'Community Q&A' },
    { pattern: /medium\.com|dev\.to|hashnode\.com/i, authority: 0.3, reason: ' blogging platform' },
  ];

  // 按任务类型的来源优先级
  private readonly SOURCE_PRIORITY_BY_TASK: Record<string, SourceType[]> = {
    'academic/literature_review': ['paper', 'review', 'dataset', 'official', 'code', 'blog'],
    'technical_design': ['official', 'code', 'dataset', 'paper', 'blog', 'news'],
    'frontier_ai_news': ['official', 'paper', 'news', 'blog', 'code'],
    'conceptual': ['official', 'paper', 'review', 'blog', 'news'],
    'factual': ['official', 'paper', 'dataset', 'news', 'code'],
    'default': ['official', 'paper', 'review', 'dataset', 'code', 'news', 'blog'],
  };

  constructor(llmComplete?: (prompt: string) => Promise<string>) {
    this.llmComplete = llmComplete;
  }

  // 规则引擎评估
  evaluateByRules(source: Partial<ResearchSource>): Partial<SourceEvaluationResult> {
    const reasons: string[] = [];
    const warnings: string[] = [];
    let authority = 0.5;

    // 1. 来源类型权威性
    if (source.sourceType && this.SOURCE_TYPE_AUTHORITY[source.sourceType]) {
      authority = this.SOURCE_TYPE_AUTHORITY[source.sourceType]!;
      reasons.push(`Source type: ${source.sourceType} (${(authority * 100).toFixed(0)}%)`);
    }

    // 2. 域名规则
    if (source.url) {
      for (const rule of this.DOMAIN_RULES) {
        if (rule.pattern.test(source.url!)) {
          authority = Math.max(authority, rule.authority);
          reasons.push(rule.reason);
          break;
        }
      }
    }

    // 3. DOI/arXiv ID 增强
    if (source.doi) {
      authority = Math.min(authority + 0.1, 1.0);
      reasons.push('Has DOI (verifiable identifier)');
    }
    if (source.arxivId) {
      authority = Math.min(authority + 0.05, 1.0);
      reasons.push('Has arXiv ID');
    }

    // 4. 时效性评估
    let freshness = 0.5;
    if (source.publishedAt) {
      const age = Date.now() - new Date(source.publishedAt).getTime();
      const oneYear = 365 * 24 * 60 * 60 * 1000;
      if (age < oneYear) {
        freshness = 1.0;
        reasons.push('Recent source (< 1 year)');
      } else if (age < 3 * oneYear) {
        freshness = 0.8;
      } else if (age < 5 * oneYear) {
        freshness = 0.6;
      } else {
        freshness = 0.4;
        warnings.push('Dated source (> 5 years)');
      }
    } else {
      warnings.push('No publication date');
    }

    // 5. 独立性（是否有作者）
    let independence = 0.5;
    if (source.authors && source.authors.length > 0) {
      independence = 0.7;
      reasons.push('Has attributed authors');
    }

    // 6. 第一手来源判断
    let primaryness = 0.5;
    if (source.sourceType === 'paper' || source.sourceType === 'official' || source.sourceType === 'code') {
      primaryness = 0.8;
      reasons.push('Primary source type');
    }
    if (source.sourceType === 'blog' || source.sourceType === 'news') {
      primaryness = 0.4;
      warnings.push('Secondary source (commentary/blog)');
    }

    // 7. 引用价值（粗略估计）
    const citationValue = authority * 0.6 + primaryness * 0.4;

    return {
      sourceId: source.id || '',
      url: source.url || '',
      scores: {
        authority,
        relevance: 0.5,
        freshness,
        independence,
        primaryness,
        citationValue,
      },
      overall: authority,
      decision: authority > 0.6 ? 'include' : authority < 0.3 ? 'exclude' : 'review',
      reasons,
      warnings,
    };
  }

  // LLM 辅助评估（评估相关性）
  async evaluateWithLLM(
    source: Partial<ResearchSource>,
    researchGoal?: string
  ): Promise<{ relevance: number; independence: number }> {
    if (!this.llmComplete) {
      return { relevance: 0.5, independence: 0.5 };
    }

    const prompt = `
Evaluate this source for research quality.

Source:
- Title: ${source.title || 'N/A'}
- URL: ${source.url || 'N/A'}
- Authors: ${source.authors?.join(', ') || 'N/A'}
- Published: ${source.publishedAt || 'N/A'}
- Type: ${source.sourceType || 'N/A'}

Research Goal: "${researchGoal || 'General research'}"

Score each dimension 0-1:
- relevance: How relevant is this to the research goal? Consider topic match and specificity.
- independence: Is this an independent/primary source, or derivative commentary?

Return JSON:
{"relevance": 0.0-1.0, "independence": 0.0-1.0}
`.trim();

    try {
      const response = await this.llmComplete(prompt);
      const parsed = JSON.parse(response);
      return {
        relevance: Math.min(1, Math.max(0, parsed.relevance || 0.5)),
        independence: Math.min(1, Math.max(0, parsed.independence || 0.5)),
      };
    } catch {
      return { relevance: 0.5, independence: 0.5 };
    }
  }

  // 综合评估
  async evaluate(
    source: Partial<ResearchSource>,
    options?: {
      researchGoal?: string;
      taskType?: string;
      weights?: { rules: number; llm: number };
    }
  ): Promise<SourceEvaluationResult> {
    const weights = { rules: 0.6, llm: 0.4, ...options?.weights };

    // 规则引擎评估
    const ruleBased = this.evaluateByRules(source);

    // LLM 评估（相关性 + 独立性）
    const llmBased = await this.evaluateWithLLM(source, options?.researchGoal);

    // 融合评估结果
    const ruleScores = ruleBased.scores || {
      authority: 0.5,
      relevance: 0.5,
      freshness: 0.5,
      independence: 0.5,
      primaryness: 0.5,
      citationValue: 0.5,
    };
    const finalScores: SourceQuality = {
      authority: ruleScores.authority,
      relevance: ruleScores.relevance * (1 - weights.llm) + llmBased.relevance * weights.llm,
      freshness: ruleScores.freshness,
      independence: ruleScores.independence * (1 - weights.llm) + llmBased.independence * weights.llm,
      primaryness: ruleScores.primaryness,
      citationValue: ruleScores.citationValue,
    };

    // 计算综合分数
    const overall =
      finalScores.authority * 0.25 +
      finalScores.relevance * 0.2 +
      finalScores.freshness * 0.15 +
      finalScores.independence * 0.1 +
      finalScores.primaryness * 0.15 +
      finalScores.citationValue * 0.15;

    return {
      sourceId: source.id || '',
      url: source.url || '',
      scores: finalScores,
      overall,
      decision: overall > 0.5 ? 'include' : overall < 0.3 ? 'exclude' : 'review',
      reasons: ruleBased.reasons || [],
      warnings: ruleBased.warnings || [],
    };
  }

  // 获取任务类型的来源优先级
  getSourcePriority(taskType: string): SourceType[] {
    return this.SOURCE_PRIORITY_BY_TASK[taskType] || this.SOURCE_PRIORITY_BY_TASK['default'];
  }

  // 评估来源是否满足任务需求
  isSourceAdequate(source: ResearchSource, requirements: {
    minAuthority?: number;
    maxAge?: number; // days
    requiredTypes?: SourceType[];
  }): { adequate: boolean; reasons: string[] } {
    const reasons: string[] = [];
    const eval_ = this.evaluateByRules(source);
    const evalScores = eval_.scores || { authority: 0.5, relevance: 0.5, freshness: 0.5, independence: 0.5, primaryness: 0.5, citationValue: 0.5 };

    if (requirements.minAuthority && evalScores.authority < requirements.minAuthority) {
      reasons.push(`Authority ${(evalScores.authority * 100).toFixed(0)}% < required ${(requirements.minAuthority * 100).toFixed(0)}%`);
    }

    if (requirements.maxAge && source.publishedAt) {
      const age = Date.now() - new Date(source.publishedAt).getTime();
      const maxAgeMs = requirements.maxAge * 24 * 60 * 60 * 1000;
      if (age > maxAgeMs) {
        reasons.push(`Source too old: ${Math.floor(age / (24 * 60 * 60 * 1000))} days > ${requirements.maxAge} days`);
      }
    }

    if (requirements.requiredTypes && !requirements.requiredTypes.includes(source.sourceType)) {
      reasons.push(`Source type ${source.sourceType} not in required types [${requirements.requiredTypes.join(', ')}]`);
    }

    return {
      adequate: reasons.length === 0,
      reasons,
    };
  }
}