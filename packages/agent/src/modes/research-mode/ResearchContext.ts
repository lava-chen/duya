import crypto from 'node:crypto';
import {
  OrchestratorPhase,
  type ResearchQuestion,
  type ResearchFinding,
  type ResearchEntity,
  type ResearchStateSummary,
  type AnswerQuality,
  type CoverageScore,
  type QualityReport,
  type ResearchPlan,
  type RequiredEvidence,
  type QuestionStatus,
} from './types.js';

const DEFAULT_MIN_SOURCES_REQUIRED = 2;

function defaultAnswerQuality(minSourcesRequired?: number): AnswerQuality {
  return {
    hasSource: false,
    sourceCount: 0,
    hasAuthoritativeSource: false,
    hasRecentSource: false,
    hasPrimarySource: false,
    hasCounterEvidence: false,
    hasContradictingSource: false,
    confidence: 'low',
    gaps: [],
    minSourcesRequired: minSourcesRequired ?? DEFAULT_MIN_SOURCES_REQUIRED,
    evaluationTimestamp: Date.now(),
  };
}

function defaultRequiredEvidence(): RequiredEvidence {
  return {
    sourceTypes: [],
    minSources: DEFAULT_MIN_SOURCES_REQUIRED,
    needsPrimarySource: false,
    needsRecentSource: false,
    needsCounterEvidence: false,
  };
}

export class ResearchContext {
  private queryText: string;
  private questions: Map<string, ResearchQuestion>;
  private findings: Map<string, ResearchFinding>;
  private entities: Map<string, ResearchEntity>;
  private phase: OrchestratorPhase;
  private iteration: number;
  private sessionId: string;
  private createdAt: number;
  private updatedAt: number;
  private userAnswers?: Record<string, string>;
  private researchPlan?: ResearchPlan;

  constructor(queryText: string, sessionId?: string) {
    this.queryText = queryText;
    this.questions = new Map();
    this.findings = new Map();
    this.entities = new Map();
    this.phase = OrchestratorPhase.IDLE;
    this.iteration = 0;
    this.sessionId = sessionId || crypto.randomUUID();
    this.createdAt = Date.now();
    this.updatedAt = Date.now();
  }

  getQuery(): string {
    return this.queryText;
  }

  getSessionId(): string {
    return this.sessionId;
  }

  getPhase(): OrchestratorPhase {
    return this.phase;
  }

  setPhase(phase: OrchestratorPhase): void {
    this.phase = phase;
    this.touch();
  }

  getIteration(): number {
    return this.iteration;
  }

  incrementIteration(): void {
    this.iteration++;
    this.touch();
  }

  getUserAnswers(): Record<string, string> | undefined {
    return this.userAnswers;
  }

  setUserAnswers(answers: Record<string, string>): void {
    this.userAnswers = answers;
    this.touch();
  }

  getResearchPlan(): ResearchPlan | undefined {
    return this.researchPlan;
  }

  setResearchPlan(plan: ResearchPlan): void {
    this.researchPlan = plan;
    this.touch();
  }

  // === Questions ===

  addQuestion(question: ResearchQuestion): void {
    if (!question.answerQuality) {
      question.answerQuality = defaultAnswerQuality(
        question.requiredEvidence?.minSources
      );
    }
    if (!question.requiredEvidence) {
      question.requiredEvidence = defaultRequiredEvidence();
    }
    this.questions.set(question.id, question);
    this.touch();
  }

  addQuestions(questions: ResearchQuestion[]): void {
    for (const q of questions) {
      if (!q.answerQuality) {
        q.answerQuality = defaultAnswerQuality(
          q.requiredEvidence?.minSources
        );
      }
      if (!q.requiredEvidence) {
        q.requiredEvidence = defaultRequiredEvidence();
      }
      this.questions.set(q.id, q);
    }
    this.touch();
  }

  getQuestion(questionId: string): ResearchQuestion | undefined {
    return this.questions.get(questionId);
  }

  getQuestions(filterStatus?: string): ResearchQuestion[] {
    const all = Array.from(this.questions.values());
    if (filterStatus) {
      return all.filter((q) => q.status === filterStatus);
    }
    return all;
  }

  getActiveQuestions(): ResearchQuestion[] {
    return Array.from(this.questions.values()).filter(
      (q) => q.status !== 'obsolete'
    );
  }

  // M1.1: 动态问题排序
  rankQuestionsForIteration(
    maxCount: number,
    weights?: {
      missingPrimarySource?: number;
      missingCounterEvidence?: number;
      blockingStatus?: number;
      sourceGap?: number;
      alreadyAnswered?: number;
      dependencyUnsatisfied?: number;
      staleness?: number;
    }
  ): ResearchQuestion[] {
    const activeQuestions = this.getActiveQuestions();
    if (activeQuestions.length === 0) return [];

    const w = {
      missingPrimarySource: weights?.missingPrimarySource ?? 30,
      missingCounterEvidence: weights?.missingCounterEvidence ?? 25,
      blockingStatus: weights?.blockingStatus ?? 20,
      sourceGap: weights?.sourceGap ?? 5,
      alreadyAnswered: weights?.alreadyAnswered ?? -40,
      dependencyUnsatisfied: weights?.dependencyUnsatisfied ?? -50,
      staleness: weights?.staleness ?? 2,
    };

    const ranked = activeQuestions.map(q => ({
      question: q,
      score: this.calculateQuestionUrgencyScore(q, w),
    }));

    return ranked
      .sort((a, b) => b.score - a.score)
      .slice(0, maxCount)
      .map(r => r.question);
  }

  private calculateQuestionUrgencyScore(
    q: ResearchQuestion,
    w: {
      missingPrimarySource: number;
      missingCounterEvidence: number;
      blockingStatus: number;
      sourceGap: number;
      alreadyAnswered: number;
      dependencyUnsatisfied: number;
      staleness: number;
    }
  ): number {
    const aq = q.answerQuality;
    let score = 0;

    // 正向因子（增加优先级）
    if (q.requiredEvidence?.needsPrimarySource && !aq?.hasPrimarySource) {
      score += w.missingPrimarySource;
    }
    if (q.requiredEvidence?.needsCounterEvidence && !aq?.hasCounterEvidence) {
      score += w.missingCounterEvidence;
    }
    if (q.status === 'blocked') {
      score += w.blockingStatus;
    }
    if (aq?.gaps && aq.gaps.length > 0) {
      score += aq.gaps.length * w.sourceGap;
    }
    if (!aq?.hasSource || aq.sourceCount === 0) {
      score += w.sourceGap * 2;
    }

    // 负向因子（降低优先级）
    if (q.status === 'answered' || q.status === 'partial') {
      score += w.alreadyAnswered;
    }

    // 依赖未满足
    if (q.dependsOn && q.dependsOn.length > 0) {
      const depsSatisfied = q.dependsOn.every(depId => {
        const dep = this.questions.get(depId);
        return dep && (dep.status === 'answered' || dep.status === 'partial');
      });
      if (!depsSatisfied) {
        score += w.dependencyUnsatisfied;
      }
    }

    // 饥饿因子（未更新轮次越多，分数越高）
    const lastUpdated = aq?.evaluationTimestamp || this.createdAt;
    const staleness = Math.floor((Date.now() - lastUpdated) / (60 * 1000)); // 分钟
    score += Math.min(Math.floor(staleness / 10) * w.staleness, 20); // 最多加 20

    // P1 问题基础加权
    if (q.priority === 1) score += 10;
    else if (q.priority === 2) score += 5;

    return score;
  }

  // M1.2: claimKey 规范化
  normalizeClaimKey(key: string, questionId: string): string {
    return `${questionId}:${key.toLowerCase().trim().replace(/[^a-z0-9]+/g, '_')}`;
  }

  // M1.2: 添加 claimKey 索引（用于语义级冲突检测）
  private claimKeyIndex = new Map<string, string[]>(); // normalized key -> finding ids

  getFindingsByClaimKey(normalizedKey: string): ResearchFinding[] {
    const findingIds = this.claimKeyIndex.get(normalizedKey) || [];
    return findingIds
      .map(id => this.findings.get(id))
      .filter((f): f is ResearchFinding => f !== undefined);
  }

  indexFindingByClaimKey(finding: ResearchFinding): void {
    if (finding.claimKey && finding.claimQuestionId) {
      const normalizedKey = this.normalizeClaimKey(finding.claimKey, finding.claimQuestionId);
      const existing = this.claimKeyIndex.get(normalizedKey) || [];
      existing.push(finding.id);
      this.claimKeyIndex.set(normalizedKey, existing);
    }
  }

  updateQuestionStatus(
    questionId: string,
    status: QuestionStatus
  ): void {
    const question = this.questions.get(questionId);
    if (question) {
      question.status = status;
      this.touch();
    }
  }

  markQuestionAnswered(questionId: string): void {
    const question = this.questions.get(questionId);
    if (question) {
      question.status = 'answered';
      this.recalculateAnswerQuality(questionId);
      this.touch();
    }
  }

  markQuestionPartial(questionId: string): void {
    const question = this.questions.get(questionId);
    if (question) {
      question.status = 'partial';
      this.recalculateAnswerQuality(questionId);
      this.touch();
    }
  }

  markQuestionBlocked(questionId: string): void {
    const question = this.questions.get(questionId);
    if (question) {
      question.status = 'blocked';
      this.touch();
    }
  }

  markQuestionObsolete(questionId: string): void {
    const question = this.questions.get(questionId);
    if (question) {
      question.status = 'obsolete';
      this.touch();
    }
  }

  private recalculateAnswerQuality(questionId: string): void {
    const question = this.questions.get(questionId);
    if (!question) return;

    const findings = this.getFindingsByQuestionId(questionId);
    const sources = new Set(findings.map((f) => f.url || f.source));
    const supports = findings.filter((f) => f.stance === 'supports');
    const contradicts = findings.filter((f) => f.stance === 'contradicts');
    const authoritative = findings.filter(
      (f) => f.sourceReliability === 'high' || f.authorityLevel === 'high'
    );
    const oneYearAgo = Date.now() - 365 * 24 * 60 * 60 * 1000;
    const recent = findings.filter(
      (f) => f.publishedAt && new Date(f.publishedAt).getTime() > oneYearAgo
    );
    const primarySources = findings.filter(
      (f) => f.sourceType === 'official' || f.sourceType === 'paper'
    );
    const counterEvidence = findings.filter(
      (f) => f.stance === 'contradicts'
    );
    const gaps: string[] = [];

    const minRequired = question.requiredEvidence?.minSources ?? DEFAULT_MIN_SOURCES_REQUIRED;

    if (sources.size < minRequired) {
      gaps.push(`Only ${sources.size} sources found, need at least ${minRequired}`);
    }
    if (question.requiredEvidence?.needsPrimarySource && primarySources.length === 0) {
      gaps.push('No primary source found');
    }
    if (question.requiredEvidence?.needsRecentSource && recent.length === 0) {
      gaps.push('No recent sources found');
    }
    if (question.requiredEvidence?.needsCounterEvidence && counterEvidence.length === 0) {
      gaps.push('No counter-evidence found');
    }
    if (sources.size === 0) {
      gaps.push('No sources found at all');
    }

    let confidence: AnswerQuality['confidence'] = 'low';
    if (sources.size >= minRequired && authoritative.length > 0) {
      confidence = 'medium';
    }
    if (
      sources.size >= minRequired + 1 &&
      authoritative.length > 0 &&
      recent.length > 0 &&
      primarySources.length > 0
    ) {
      confidence = 'high';
    }

    question.answerQuality = {
      hasSource: sources.size > 0,
      sourceCount: sources.size,
      hasAuthoritativeSource: authoritative.length > 0,
      hasRecentSource: findings.length > 0
        ? recent.length >= sources.size * 0.5
        : false,
      hasPrimarySource: primarySources.length > 0,
      hasCounterEvidence: counterEvidence.length > 0,
      hasContradictingSource: contradicts.length > 0,
      confidence,
      gaps,
      minSourcesRequired: minRequired,
      evaluationTimestamp: Date.now(),
    };
  }

  // === Findings ===

  addFinding(finding: ResearchFinding): void {
    this.findings.set(finding.id, finding);
    for (const questionId of finding.relatedQuestionIds) {
      this.recalculateAnswerQuality(questionId);
    }
    this.touch();
  }

  addFindings(findings: ResearchFinding[]): void {
    for (const f of findings) {
      this.findings.set(f.id, f);
    }
    const affectedQuestionIds = new Set<string>();
    for (const f of findings) {
      for (const qid of f.relatedQuestionIds) {
        affectedQuestionIds.add(qid);
      }
    }
    for (const qid of affectedQuestionIds) {
      this.recalculateAnswerQuality(qid);
    }
    this.touch();
  }

  getFinding(findingId: string): ResearchFinding | undefined {
    return this.findings.get(findingId);
  }

  getAllFindings(): ResearchFinding[] {
    return Array.from(this.findings.values());
  }

  getFindingsByQuestionId(questionId: string): ResearchFinding[] {
    return Array.from(this.findings.values()).filter((f) =>
      f.relatedQuestionIds.includes(questionId)
    );
  }

  getFindingCount(): number {
    return this.findings.size;
  }

  // === Entities ===

  addEntity(entity: ResearchEntity): void {
    const existing = this.entities.get(entity.normalizedName);
    if (existing) {
      existing.occurrences += entity.occurrences;
      for (const alias of entity.aliases) {
        if (!existing.aliases.includes(alias)) {
          existing.aliases.push(alias);
        }
      }
    } else {
      this.entities.set(entity.normalizedName, entity);
    }
    this.touch();
  }

  normalizeEntityName(raw: string): string {
    return raw.trim().toLowerCase().replace(/\s+/g, '-');
  }

  extractEntities(text: string): string[] {
    const words = text.split(/\s+/);
    const candidates = new Set<string>();
    const entityNames = Array.from(this.entities.keys());

    for (let i = 0; i < words.length; i++) {
      const phrase = words.slice(i, i + 3).join(' ').toLowerCase();
      if (entityNames.includes(this.normalizeEntityName(phrase))) {
        candidates.add(this.normalizeEntityName(phrase));
        i += 2;
        continue;
      }
      const twoWords = words.slice(i, i + 2).join(' ').toLowerCase();
      if (entityNames.includes(this.normalizeEntityName(twoWords))) {
        candidates.add(this.normalizeEntityName(twoWords));
        i += 1;
        continue;
      }
      const oneWord = words[i].toLowerCase();
      if (entityNames.includes(this.normalizeEntityName(oneWord))) {
        candidates.add(this.normalizeEntityName(oneWord));
      }
    }
    return Array.from(candidates);
  }

  // === Coverage ===

  calculateCoverage(): number {
    const activeQuestions = this.getActiveQuestions();
    if (activeQuestions.length === 0) return 0;

    const answered = activeQuestions.filter(
      (q) => q.status === 'answered' || q.status === 'partial'
    ).length;

    return answered / activeQuestions.length;
  }

  calculateQualityCoverage(): number {
    const report = this.calculateQualityReport();
    return report.score;
  }

  calculateQualityReport(): QualityReport {
    const activeQuestions = this.getActiveQuestions();
    const allFindings = this.getAllFindings();

    if (activeQuestions.length === 0) {
      return {
        score: 0,
        readyForSynthesis: false,
        blockers: ['No active research questions'],
        criticalBlockers: [],
        nextActions: [],
        requiredQuestionsAnswered: true,
        dimensions: {
          questionCoverage: 0,
          evidenceCoverage: 0,
          sourceAuthority: 0,
          sourceDiversity: 0,
          recencyCoverage: 0,
          counterEvidenceCoverage: 0,
          synthesisReadiness: 0,
        },
      };
    }

    // questionCoverage: proportion of questions answered/partial
    const answeredQs = activeQuestions.filter(
      (q) => q.status === 'answered' || q.status === 'partial'
    );
    const questionCoverage = answeredQs.length / activeQuestions.length;

    // evidenceCoverage: proportion of questions meeting min sources
    let questionsWithAdequateSources = 0;
    for (const q of activeQuestions) {
      const findingsForQ = this.getFindingsByQuestionId(q.id);
      const uniqueSources = new Set(findingsForQ.map((f) => f.url || f.source));
      if (uniqueSources.size >= (q.requiredEvidence?.minSources ?? DEFAULT_MIN_SOURCES_REQUIRED)) {
        questionsWithAdequateSources++;
      }
    }
    const evidenceCoverage = questionsWithAdequateSources / activeQuestions.length;

    // sourceAuthority: proportion of findings with high/medium authority
    const authoritativeFindings = allFindings.filter(
      (f) => f.sourceReliability === 'high' || f.authorityLevel === 'high'
    );
    const sourceAuthority = allFindings.length > 0
      ? authoritativeFindings.length / allFindings.length
      : 0;

    // sourceDiversity: unique source types across all findings
    const sourceTypes = new Set(allFindings.map((f) => f.sourceType));
    const allSourceTypes = ['paper', 'official', 'news', 'blog', 'code', 'dataset', 'book'];
    const sourceDiversity = sourceTypes.size / allSourceTypes.length;

    // recencyCoverage: proportion of findings published in last year
    const oneYearAgo = Date.now() - 365 * 24 * 60 * 60 * 1000;
    const recentFindings = allFindings.filter(
      (f) => f.publishedAt && new Date(f.publishedAt).getTime() > oneYearAgo
    );
    const recencyCoverage = allFindings.length > 0
      ? recentFindings.length / allFindings.length
      : 0;

    // counterEvidenceCoverage: proportion of questions with at least one contradicting finding
    let questionsWithCounterEvidence = 0;
    for (const q of activeQuestions) {
      const findingsForQ = this.getFindingsByQuestionId(q.id);
      if (findingsForQ.some((f) => f.stance === 'contradicts')) {
        questionsWithCounterEvidence++;
      }
    }
    const counterEvidenceCoverage = questionsWithCounterEvidence / activeQuestions.length;

    // synthesisReadiness: composite measure
    const weights = {
      questionCoverage: 0.25,
      evidenceCoverage: 0.20,
      sourceAuthority: 0.15,
      sourceDiversity: 0.10,
      recencyCoverage: 0.15,
      counterEvidenceCoverage: 0.15,
    };
    const dimensions: CoverageScore = {
      questionCoverage,
      evidenceCoverage,
      sourceAuthority,
      sourceDiversity,
      recencyCoverage,
      counterEvidenceCoverage,
      synthesisReadiness: 0,
    };
    dimensions.synthesisReadiness =
      questionCoverage * weights.questionCoverage +
      evidenceCoverage * weights.evidenceCoverage +
      sourceAuthority * weights.sourceAuthority +
      sourceDiversity * weights.sourceDiversity +
      recencyCoverage * weights.recencyCoverage +
      counterEvidenceCoverage * weights.counterEvidenceCoverage;

    const blockers: string[] = [];
    const nextActions: string[] = [];

    if (questionCoverage < 0.7) {
      blockers.push(`Only ${Math.round(questionCoverage * 100)}% of questions have answers`);
      nextActions.push('Continue searching unanswered questions');
    }
    if (evidenceCoverage < 0.5) {
      blockers.push('Insufficient evidence across multiple questions');
      nextActions.push('Search for more sources per question');
    }
    if (sourceAuthority < 0.3) {
      blockers.push('Low authority sources — need more authoritative references');
      nextActions.push('Search for official documentation or peer-reviewed papers');
    }
    if (sourceDiversity < 0.3 && allFindings.length > 5) {
      blockers.push('Low source diversity');
      nextActions.push('Search across different source types (papers, docs, code)');
    }

    // Check per-question evidence requirements
    for (const q of activeQuestions) {
      if (q.status !== 'answered' && q.status !== 'partial') continue;
      const aq = q.answerQuality;
      if (!aq) continue;

      if (aq.gaps.length > 0) {
        for (const gap of aq.gaps) {
          blockers.push(`[${q.id}] ${gap}`);
        }
      }

      if (q.requiredEvidence?.needsPrimarySource && !aq.hasPrimarySource) {
        nextActions.push(`Find primary source for: ${q.text}`);
      }
      if (q.requiredEvidence?.needsCounterEvidence && !aq.hasCounterEvidence) {
        nextActions.push(`Search counter-evidence for: ${q.text}`);
      }
    }

    const readyForSynthesis = dimensions.synthesisReadiness >= 0.7 && blockers.length === 0;

    // M1.2: 计算 criticalBlockers
    const criticalBlockers: string[] = [];
    for (const q of activeQuestions.filter(q => q.priority === 1)) {
      if (q.requiredEvidence?.needsPrimarySource && !q.answerQuality?.hasPrimarySource && q.status !== 'answered') {
        criticalBlockers.push(`[${q.id}] Primary source missing for critical question`);
      }
    }
    for (const q of activeQuestions.filter(q => q.purpose === 'comparison' || q.purpose === 'critique')) {
      if (q.requiredEvidence?.needsCounterEvidence && !q.answerQuality?.hasCounterEvidence) {
        criticalBlockers.push(`[${q.id}] Counter-evidence missing`);
      }
    }

    // M1.2: 检查必要问题是否已回答
    const plan = this.getResearchPlan();
    const requiredQs = plan?.scope?.blockingQuestions || [];
    let requiredQuestionsAnswered = true;
    for (const qId of requiredQs) {
      const q = this.questions.get(qId);
      if (!q || (q.status !== 'answered' && q.status !== 'partial')) {
        requiredQuestionsAnswered = false;
        break;
      }
    }

    return {
      score: dimensions.synthesisReadiness,
      readyForSynthesis,
      blockers,
      criticalBlockers,
      nextActions,
      requiredQuestionsAnswered,
      dimensions,
    };
  }

  allQuestionsMeetQualityThreshold(): boolean {
    const answeredQuestions = this.getActiveQuestions().filter(
      (q) => q.status === 'answered' || q.status === 'partial'
    );

    for (const q of answeredQuestions) {
      const qa = q.answerQuality;
      if (!qa) return false;
      if (!qa.hasSource) return false;
      if (qa.sourceCount < qa.minSourcesRequired) return false;
      if (!qa.hasAuthoritativeSource) return false;
    }

    return answeredQuestions.length > 0;
  }

  getStateSummary(): ResearchStateSummary {
    return {
      questionCount: this.questions.size,
      findingCount: this.findings.size,
      coverage: this.calculateCoverage(),
      entities: Array.from(this.entities.keys()),
    };
  }

  // === Prompt Context ===

  toPromptContext(): string {
    const qLines = Array.from(this.questions.values()).map(
      (q) =>
        `  [${q.id}] (${q.status}, pri=${q.priority}, purpose=${q.purpose}) ${q.text}${
          q.parentId ? ` ← parent: ${q.parentId}` : ''
        }${q.dependsOn.length > 0 ? ` ← depends: ${q.dependsOn.join(', ')}` : ''}`
    );

    const fLines = Array.from(this.findings.values()).map(
      (f) =>
        `  [${f.id}] conf=${f.confidence.toFixed(1)} stance=${f.stance} authority=${f.authorityLevel} src="${
          f.content.slice(0, 150)
        }..."`
    );

    const qualityReport = this.calculateQualityReport();

    return [
      `Query: ${this.queryText}`,
      `Phase: ${this.phase}, Iteration: ${this.iteration}`,
      `Coverage: ${(this.calculateCoverage() * 100).toFixed(0)}% (${
        this.questions.size
      } questions, ${this.findings.size} findings)`,
      `Quality Score: ${(qualityReport.score * 100).toFixed(0)}%, Ready: ${qualityReport.readyForSynthesis}`,
      qualityReport.blockers.length > 0
        ? `Blockers: ${qualityReport.blockers.join('; ')}`
        : 'No blockers',
      '',
      'Questions:',
      ...qLines,
      '',
      'Current Findings:',
      ...fLines,
    ].join('\n');
  }

  buildResearchPrompt(): string {
    const qs = this.getQuestions()
      .filter((q) => q.status !== 'obsolete')
      .sort((a, b) => a.priority - b.priority);

    const findings = this.getAllFindings().slice(-20);
    const qualityReport = this.calculateQualityReport();

    const fSummary = findings
      .map(
        (f) =>
          `[${f.id}] (${f.stance}, ${f.authorityLevel}) "${f.content.slice(0, 300)}"`
      )
      .join('\n');

    return `Research Query: ${this.queryText}

Progress: ${this.iteration} iterations, ${this.findings.size} findings, ${(this.calculateCoverage() * 100).toFixed(0)}% coverage
Quality Score: ${(qualityReport.score * 100).toFixed(0)}%
Blockers: ${qualityReport.blockers.join('; ') || 'none'}
Next Actions: ${qualityReport.nextActions.join('; ') || 'none'}

Open Questions:
${qs.map((q) => `- [${q.id}] (${q.purpose}) ${q.text}`).join('\n')}

Recent Findings:
${fSummary}`;
  }

  // === Persistence ===

  toJSON(): string {
    return JSON.stringify({
      queryText: this.queryText,
      questions: Array.from(this.questions.values()),
      findings: Array.from(this.findings.values()),
      entities: Array.from(this.entities.values()),
      phase: this.phase,
      iteration: this.iteration,
      sessionId: this.sessionId,
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
      userAnswers: this.userAnswers,
      researchPlan: this.researchPlan,
    });
  }

  static fromJSON(json: string): ResearchContext {
    const data = JSON.parse(json);
    const ctx = new ResearchContext(data.queryText, data.sessionId);
    ctx.phase = data.phase;
    ctx.iteration = data.iteration;
    ctx.createdAt = data.createdAt;
    ctx.updatedAt = data.updatedAt;
    ctx.userAnswers = data.userAnswers;
    ctx.researchPlan = data.researchPlan;

    if (Array.isArray(data.questions)) {
      for (const q of data.questions) {
        ctx.questions.set(q.id, q);
      }
    }
    if (Array.isArray(data.findings)) {
      for (const f of data.findings) {
        ctx.findings.set(f.id, f);
      }
    }
    if (Array.isArray(data.entities)) {
      for (const e of data.entities) {
        ctx.entities.set(e.normalizedName, e);
      }
    }

    return ctx;
  }

  clone(): ResearchContext {
    return ResearchContext.fromJSON(this.toJSON());
  }

  // === Internal ===

  private touch(): void {
    this.updatedAt = Date.now();
  }
}