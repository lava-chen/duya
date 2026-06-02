import { ResearchContext } from './ResearchContext.js';
import {
  OrchestratorPhase,
  type ResearchEvent,
  type ResearchQuestion,
  type ResearchFinding,
  type ResearchEntity,
  type FindingContradiction,
  type SearchStrategy,
  type AnswerQuality,
  type QueryComplexity,
  type ResearchClassification,
  type OrchestratorConfig,
  type OrchestratorDependencies,
  type ResearchRunDB,
  type ResearchPlan,
  type ResearchIntent,
  type ResearchScope,
  type EvidenceStrategy,
  type ResearchSearchStrategy,
  type QualityGates,
  type SynthesisPlan,
  type QualityReport,
  type QuestionPurpose,
  type RequiredEvidence,
  type StopDecision,
  type ResearchAction,
  type ResearchActionType,
  type ResearchActionResult,
  type CompareAction,
  type PlanDelta,
  type PlanDeltaType,
  type ResearchState,
  type QuestionCoverageStatus,
  type HypothesisStatus,
  type EvidenceConflict,
  type Hypothesis,
  type QuestionLayer,
  type AgentCallInput,
  type ToolCallResult,
  type ToolSpec,
} from './types.js';
import type { ClarificationQuestion } from '../types.js';
import type { ToolResult } from '../../tool/types.js';
import { computeSourceReliability, sourceTypeFromQueryType, authorityLevelFromReliability, truncateResult, safeParseJSON } from './utils.js';
import {
  classifyQuery,
  CLASSIFY_QUERY_VERSION,
} from './prompts/classify-query.js';
import {
  generateClarification,
  GENERATE_CLARIFICATION_VERSION,
} from './prompts/generate-clarification.js';
import {
  generatePlan,
  GENERATE_PLAN_VERSION,
} from './prompts/generate-plan.js';
import {
  selectActions,
  SELECT_ACTIONS_VERSION,
} from './prompts/select-actions.js';
import {
  extractFindings,
  EXTRACT_FINDINGS_VERSION,
} from './prompts/extract-findings.js';
import {
  sourceCheck,
  SOURCE_CHECK_VERSION,
} from './prompts/source-check.js';
import {
  compare,
  COMPARE_VERSION,
} from './prompts/compare.js';
import {
  replan,
  REPLAN_VERSION,
  type ReplanInput,
} from './prompts/replan.js';
import {
  continueResearch,
  CONTINUE_RESEARCH_VERSION,
} from './prompts/continue-research.js';
import {
  synthesize,
  SYNTHESIZE_VERSION,
} from './prompts/synthesize.js';
import {
  exploreAgent,
  EXPLORE_AGENT_SYSTEM_PROMPT,
  buildExplorePrompt,
  parseExploreResponse,
} from './prompts/explore-agent.js';

export const DEFAULT_ORCHESTRATOR_CONFIG: Required<OrchestratorConfig> = {
  maxIterations: 15,
  concurrencyLimit: 12,
  coverageThreshold: 0.9,
  requireClarification: false,
  maxClarificationQuestions: 3,
  maxQuestionsPerIteration: 8,
  maxTotalQuestions: 60,

  // M1.1: 动态问题排序权重
  questionRankingWeights: {
    missingPrimarySource: 30,
    missingCounterEvidence: 25,
    blockingStatus: 20,
    sourceGap: 5,
    alreadyAnswered: -40,
    dependencyUnsatisfied: -50,
    staleness: 2,
  },

  // M1.5: 并发控制
  maxToolCallsPerIteration: 12,
  maxSearchResultsPerQuery: 20,
  enableUrlDeduplication: true,
  enableQueryDeduplication: true,
};

const COMPLEXITY_CONFIG: Record<
  QueryComplexity,
  {
    maxIterations: number;
    coverageThreshold: number;
    freshness: ResearchClassification['freshness'];
    sourceDepth: ResearchClassification['sourceDepth'];
    riskLevel: ResearchClassification['riskLevel'];
    label: string;
  }
> = {
  factual: {
    maxIterations: 3, coverageThreshold: 0.8,
    freshness: 'stable', sourceDepth: 'light', riskLevel: 'low',
    label: 'Factual (quick answer)',
  },
  conceptual: {
    maxIterations: 6, coverageThreshold: 0.8,
    freshness: 'stable', sourceDepth: 'standard', riskLevel: 'low',
    label: 'Conceptual (moderate depth)',
  },
  comparative: {
    maxIterations: 10, coverageThreshold: 0.85,
    freshness: 'recent', sourceDepth: 'standard', riskLevel: 'medium',
    label: 'Comparative (side-by-side analysis)',
  },
  analytical: {
    maxIterations: 15, coverageThreshold: 0.9,
    freshness: 'recent', sourceDepth: 'deep', riskLevel: 'high',
    label: 'Analytical (deep research)',
  },
  literature_review: {
    maxIterations: 20, coverageThreshold: 0.9,
    freshness: 'recent', sourceDepth: 'deep', riskLevel: 'high',
    label: 'Literature Review (comprehensive survey)',
  },
  technical_design: {
    maxIterations: 12, coverageThreshold: 0.85,
    freshness: 'latest', sourceDepth: 'deep', riskLevel: 'medium',
    label: 'Technical Design (implementation-focused)',
  },
  unknown: {
    maxIterations: 8, coverageThreshold: 0.85,
    freshness: 'recent', sourceDepth: 'standard', riskLevel: 'medium',
    label: 'General (default depth)',
  },
};

function buildSearchUrl(query: string): string {
  const encoded = encodeURIComponent(query);
  return `https://html.duckduckgo.com/html/?q=${encoded}`;
}

function extractDomain(url: string): string {
  try {
    const hostname = new URL(url).hostname;
    return hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

const BROWSER_TOOLS: ToolSpec[] = [
  {
    name: 'browser',
    description: `Navigate and interact with web pages using a real browser.

PRIMARY OPERATION — use this FIRST every time:
- parallel_fetch: Fetch MULTIPLE URLs simultaneously. Pass {"urls": ["url1", "url2", ...]}.
  Open 5-15 known authoritative URLs at once. This is your main research tool.
  Examples: docs.python.org, en.wikipedia.org/wiki/..., arxiv.org/abs/..., github.com/.../...

SECONDARY — after reviewing parallel_fetch results:
- navigate: Go to a specific URL for detailed reading. Returns compact page snapshot.
- snapshot: Get a full structured text snapshot of the current page.

FALLBACK ONLY — when you don't know specific URLs:
- navigate to "https://html.duckduckgo.com/html/?q=YOUR+QUERY"`,

    input_schema: {
      type: 'object',
      properties: {
        operation: {
          type: 'string',
          enum: ['navigate', 'snapshot', 'parallel_fetch'],
          description: 'The browser operation. Use parallel_fetch FIRST to batch-open known URLs.',
        },
        url: {
          type: 'string',
          description: 'URL to navigate to (for navigate operation)',
        },
        urls: {
          type: 'array',
          items: { type: 'string' },
          description: 'Array of URLs for parallel_fetch. Include 5-15 diverse sources.',
        },
      },
      required: ['operation'],
    },
  },
];

export class Orchestrator {
  private config: Required<OrchestratorConfig>;
  private context: ResearchContext;
  private currentPhase: OrchestratorPhase;
  private currentIteration: number;
  private currentClassification: ResearchClassification;
  private clarificationAnswers: Record<string, string> = {};
  private readonly originalQuery: string;
  private researchState: ResearchState;
  private readonly runDB: ResearchRunDB | undefined;
  private readonly sessionId: string;
  private activitySeq: number = 0;
  private stepMap: Map<string, string> = new Map();

  private llmComplete: (prompt: string, systemPrompt?: string) => Promise<string>;
  private llmStreamFn?: (prompt: string, systemPrompt?: string) => AsyncIterable<string>;
  private llmAgentCall?: (input: AgentCallInput) => Promise<{ content: string; toolCalls: ToolCallResult[] }>;
  private toolExecute: (name: string, input: Record<string, unknown>) => Promise<ToolResult>;
  private toolExecuteConcurrent: (
    calls: Array<{ name: string; input: Record<string, unknown> }>
  ) => AsyncGenerator<ToolResult>;
  private emitSSE: (event: ResearchEvent) => void;
  private awaitClarification: (questions: ClarificationQuestion[], requestId: string) => Promise<Record<string, string>>;
  private persistState?: (contextJSON: string) => Promise<void>;
  private cancelled = false;
  private readonly localAbortController = new AbortController();

  constructor(
    initialQuery: string,
    deps: OrchestratorDependencies,
    context?: ResearchContext,
  ) {
    this.config = {
      ...DEFAULT_ORCHESTRATOR_CONFIG,
      ...(deps.config || {}),
    } as Required<OrchestratorConfig>;
    this.context = context ?? new ResearchContext(initialQuery);
    this.originalQuery = initialQuery;
    this.currentPhase = OrchestratorPhase.IDLE;
    this.currentIteration = 0;
    this.currentClassification = {
      complexity: 'unknown',
      maxIterations: this.config.maxIterations,
      coverageThreshold: this.config.coverageThreshold,
      freshness: 'recent',
      sourceDepth: 'standard',
      riskLevel: 'medium',
      needsCitations: true,
      needsTools: ['browser'],
    };
    this.llmComplete = deps.llmComplete;
    this.llmStreamFn = deps.llmStreamFn;
    this.llmAgentCall = deps.llmAgentCall;
    this.toolExecute = this._wrapToolExecute(deps.toolExecute);
    this.toolExecuteConcurrent = deps.toolExecuteConcurrent;
    this.emitSSE = deps.emitSSE;
    this.awaitClarification = deps.awaitClarification;
    this.persistState = deps.persistState;
    this.runDB = deps.runDB;
    this.sessionId = deps.sessionId || '';
    if (deps.abortSignal) {
      if (deps.abortSignal.aborted) {
        this.localAbortController.abort();
      } else {
        deps.abortSignal.addEventListener('abort', () => this.localAbortController.abort(), { once: true });
      }
    }
    this.researchState = {
      iteration: 0,
      questionCoverage: [],
      hypothesisStatuses: [],
      conflicts: [],
      gapFindings: [],
      saturationSignals: [],
      overallCoverageScore: 0,
    };
  }

  getPhase(): OrchestratorPhase {
    return this.currentPhase;
  }

  getContext(): ResearchContext {
    return this.context;
  }

  getOriginalQuery(): string {
    return this.originalQuery;
  }

  async execute(): Promise<void> {
    try {
      this.throwIfCancelled();
      this.transitionTo(OrchestratorPhase.PLANNING);

      await this._updateRunStatus('classifying');
      await this._logActivity('phase', '正在分析研究任务并制定计划');
      await this.classifyQuery();

      await this._updateRunStatus('planning');
      await this._logActivity('phase', '正在生成研究方案与调查问题');
      await this.executePlanning();
      await this._persistContext();
      this.throwIfCancelled();

      const plan = this.context.getResearchPlan();
      if (plan && plan.scope.clarificationNeeded && plan.scope.blockingQuestions.length > 0) {
        this.transitionTo(OrchestratorPhase.CLARIFICATION);
        await this._updateRunStatus('awaiting_clarification');
        await this.executeClarification();
        await this._persistContext();
        this.throwIfCancelled();
      }

      await this._updateRunStatus('awaiting_approval');
      await this.executePlanApproval();
      await this._persistContext();
      this.throwIfCancelled();

      this.transitionTo(OrchestratorPhase.RESEARCH_LOOP);
      await this._updateRunStatus('running');
      await this._logActivity('milestone', '开始执行研究调查，查阅在线来源');
      await this.executeResearchLoop();
      this.throwIfCancelled();

      this.transitionTo(OrchestratorPhase.SYNTHESIS);
      await this._updateRunStatus('synthesizing');
      await this._logActivity('milestone', '正在组织研究报告与引用');
      await this.executeSynthesis();
      this.throwIfCancelled();

      this.transitionTo(OrchestratorPhase.COMPLETE);
      await this._updateRunStatus('completed');
      const finalCoverage = this.context.calculateCoverage();
      const finalFindings = this.context.getFindingCount();
      await this._updateRun({
        run_status: 'completed',
        completed_at: Date.now(),
        progress_summary: `Research complete: ${finalFindings} findings, ${Math.round(finalCoverage * 100)}% coverage in ${this.currentIteration} iterations`,
      });

      this.emit({
        type: 'complete',
        summary: this.buildSummary(),
        iterations: this.currentIteration,
        coverage: finalCoverage,
        findingsCount: finalFindings,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const cancelled = isResearchCancelledError(err) || this.cancelled;
      if (!cancelled) {
        this.emit({ type: 'error', message });
      }
      this.transitionTo(OrchestratorPhase.ABORTED);
      await this._updateRun({
        run_status: cancelled ? 'aborted' : 'failed',
        completed_at: Date.now(),
        error_json: JSON.stringify({ code: cancelled ? 'CANCELLED' : 'EXECUTION_ERROR', message, recoverable: false }),
        progress_summary: cancelled ? `Research aborted: ${message}` : `Research failed: ${message}`,
      });
    }
  }

  async handleClarificationAnswers(answers: Record<string, string>): Promise<void> {
    this.clarificationAnswers = answers;
    this.context.setUserAnswers(answers);
    this.emit({ type: 'clarification_answers_received', answers });
  }

  async continueResearch(additionalQuery: string): Promise<void> {
    const prompt = continueResearch.buildPrompt({
      additionalQuery,
      existingQuestions: this.context.getQuestions().map((q) => `- [${q.id}] (${q.status}) ${q.text}`).join('\n'),
      iteration: 0,
      maxIterations: 0,
      isLoopEvaluation: false,
    });

    const response = await this.llmComplete(prompt);
    const parsed = continueResearch.parseResponse(response);
    const newQuestions: ResearchQuestion[] = [];

    if (parsed.questions.length > 0) {
      for (const q of parsed.questions) {
        const id = `q${Date.now()}_${newQuestions.length}`;
        newQuestions.push({
          id,
          text: q.text || `Research: ${additionalQuery}`,
          purpose: (q.purpose as QuestionPurpose) || 'evidence',
          priority: Math.min(3, Math.max(1, (q.priority || 3) + 1)) as 1 | 2 | 3,
          dependsOn: [],
          searchQueries: [q.text],
          requiredEvidence: {
            sourceTypes: [],
            minSources: 2,
            needsPrimarySource: false,
            needsRecentSource: false,
            needsCounterEvidence: false,
          },
          status: 'pending',
          sources: [],
        });
      }
    } else {
      newQuestions.push({
        id: `q${Date.now()}_0`,
        text: additionalQuery,
        purpose: 'evidence',
        priority: 3,
        dependsOn: [],
        searchQueries: [additionalQuery],
        requiredEvidence: {
          sourceTypes: [],
          minSources: 2,
          needsPrimarySource: false,
          needsRecentSource: false,
          needsCounterEvidence: false,
        },
        status: 'pending',
        sources: [],
      });
    }

    this.context.addQuestions(newQuestions);

    const coverageBefore = this.context.calculateCoverage();
    this.emit({ type: 'continue_research_start', addedQuestions: newQuestions, coverageBefore });

    await this.executeResearchLoop();
    this.transitionTo(OrchestratorPhase.SYNTHESIS);
    await this.executeSynthesis();
    this.transitionTo(OrchestratorPhase.COMPLETE);
    this.emit({
      type: 'complete',
      summary: this.buildSummary(),
      iterations: this.currentIteration,
      coverage: this.context.calculateCoverage(),
      findingsCount: this.context.getFindingCount(),
    });
  }

  abort(): void {
    this.cancelled = true;
    this.localAbortController.abort();
    this.transitionTo(OrchestratorPhase.ABORTED);
  }

  getRunId(): string | undefined {
    return this.runDB?.runId;
  }

  // === Run DB helpers ===

  private async _updateRunStatus(status: string): Promise<void> {
    if (!this.runDB) return;
    try {
      await this.runDB.updateRun({ run_status: status });
    } catch {
      // non-fatal
    }
    this.emit({ type: 'run_status', status, phase: this.currentPhase });
  }

  private async _updateRun(data: Parameters<ResearchRunDB['updateRun']>[0]): Promise<void> {
    if (!this.runDB) return;
    try {
      await this.runDB.updateRun(data);
    } catch {
      // non-fatal
    }
  }

  private async _persistContext(): Promise<void> {
    if (!this.persistState) return;
    try {
      await this.persistState(this.context.toJSON());
    } catch {
      // persist failure is non-fatal
    }
  }

  private async _logActivity(
    kind: string,
    title: string,
    detail?: string,
    visibility: 'user' | 'debug' = 'user',
    sources?: Array<{ url: string; title: string }>,
  ): Promise<void> {
    this.activitySeq++;
    if (this.runDB) {
      try {
        await this.runDB.logActivity({ kind, title, detail, visibility, sources });
      } catch {
        // non-fatal
      }
    }
    this.emit({ type: 'activity', kind, title, detail, sequence: this.activitySeq, sources });
  }

  private async _createPlanSteps(): Promise<void> {
    if (!this.runDB) return;
    const plan = this.context.getResearchPlan();
    if (!plan || plan.researchQuestions.length === 0) return;

    const steps = plan.researchQuestions.map((q, i) => ({
      id: `step_${q.id}`,
      order_num: i + 1,
      user_facing_label: q.text,
      internal_question_ids: [q.id],
    }));

    try {
      await this.runDB.createPlanSteps(steps);
      this.stepMap.clear();
      for (const s of steps) {
        this.stepMap.set(s.internal_question_ids[0], s.id);
      }
      this.emit({
        type: 'plan_steps_created',
        steps: steps.map((s) => ({ id: s.id, order: s.order_num, label: s.user_facing_label })),
      });
      await this._persistContext();
    } catch {
      // non-fatal
    }
  }

  private async _updateActiveStep(questionId: string): Promise<void> {
    if (!this.runDB) return;
    const stepId = this.stepMap.get(questionId);
    if (!stepId) return;

    try {
      await this.runDB.updatePlanStep(stepId, {
        status: 'active',
        started_at: Date.now(),
      });
      await this.runDB.updateRun({ active_step_id: stepId });
    } catch {
      // non-fatal
    }
  }

  private async _completeStep(questionId: string): Promise<void> {
    if (!this.runDB) return;
    const stepId = this.stepMap.get(questionId);
    if (!stepId) return;

    try {
      await this.runDB.updatePlanStep(stepId, {
        status: 'completed',
        completed_at: Date.now(),
      });
    } catch {
      // non-fatal
    }
  }

  private _wrapToolExecute(
    original: (name: string, input: Record<string, unknown>) => Promise<ToolResult>,
  ): (name: string, input: Record<string, unknown>) => Promise<ToolResult> {
    return async (name: string, input: Record<string, unknown>): Promise<ToolResult> => {
      if (name === 'browser') {
        const operation = input.operation as string | undefined;
        if (operation === 'navigate' && input.url) {
          const url = String(input.url);
          const domain = extractDomain(url);
          void this._logActivity('browse', '正在检索页面', `${domain}`);
        } else if (operation === 'parallel_fetch' && Array.isArray(input.urls)) {
          const urls = input.urls as string[];
          const domains = [...new Set(urls.map((u) => extractDomain(String(u))))];
          void this._logActivity(
            'browse',
            '正在检索多个来源',
            domains.length > 0 ? domains.join(', ') : `${urls.length} 个页面`,
            'user',
            urls.map((u) => ({ url: String(u), title: extractDomain(String(u)) })),
          );
        }
      }
      return original(name, input);
    };
  }

  // === Phase: Classify ===

  private async classifyQuery(): Promise<void> {
    const prompt = classifyQuery.buildPrompt({ query: this.originalQuery });

    try {
      const response = await this.llmComplete(prompt);
      const result = classifyQuery.parseResponse(response);
      const complexity: QueryComplexity = result.complexity;
      const cfg = COMPLEXITY_CONFIG[complexity];

      this.currentClassification = {
        complexity,
        maxIterations: cfg.maxIterations,
        coverageThreshold: cfg.coverageThreshold,
        freshness: result.freshness,
        sourceDepth: result.sourceDepth,
        riskLevel: result.riskLevel,
        needsCitations: complexity !== 'factual',
        needsTools: result.needsTools,
      };

      this.config.maxIterations = cfg.maxIterations;
      this.config.coverageThreshold = cfg.coverageThreshold;

      this.emit({
        type: 'complexity_classified',
        classification: this.currentClassification,
      });
    } catch {
      this.currentClassification = {
        complexity: 'unknown',
        maxIterations: this.config.maxIterations,
        coverageThreshold: this.config.coverageThreshold,
        freshness: 'recent',
        sourceDepth: 'standard',
        riskLevel: 'medium',
        needsCitations: true,
        needsTools: ['browser'],
      };
      this.emit({
        type: 'complexity_classified',
        classification: this.currentClassification,
      });
    }
  }

  // === Phase: Clarification ===

  private async executeClarification(): Promise<void> {
    const questions = await this.generateClarificationQuestions();
    if (questions.length === 0) return;

    const requestId = `clarify_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    this.emit({
      type: 'clarification_questions',
      requestId,
      questions,
      isHardBlock: true,
    });
    const answers = await this.awaitClarification(questions, requestId);
    await this.handleClarificationAnswers(answers);
  }

  private async generateClarificationQuestions(): Promise<ClarificationQuestion[]> {
    const prompt = generateClarification.buildPrompt({ query: this.originalQuery });

    try {
      const response = await this.llmComplete(prompt);
      const result = generateClarification.parseResponse(response);
      return result.questions;
    } catch {
      // fall through
    }
    return [];
  }

  // === Phase: Planning ===

  private async executePlanning(): Promise<void> {
    this.emit({ type: 'planning_start' });

    const plan = await this.llmGenerateResearchPlan();
    if (plan) {
      this.context.setResearchPlan(plan);
      this.context.addQuestions(plan.researchQuestions);
      await this._createPlanSteps();
    } else {
      this.addFallbackQuestion();
    }
  }

  private async llmGenerateResearchPlan(): Promise<ResearchPlan | null> {
    const classification = this.currentClassification;
    const userAnswers = this.clarificationAnswers;

    const prompt = generatePlan.buildPrompt({
      query: this.originalQuery,
      classification,
      userAnswers: userAnswers && Object.keys(userAnswers).length > 0 ? userAnswers : undefined,
    });

    try {
      const response = await this.llmComplete(prompt);
      const parsed = generatePlan.parseResponse(response);

      if (parsed && typeof parsed === 'object') {
        return this.parseResearchPlan(parsed as unknown as Record<string, unknown>);
      }
    } catch {
      // fall through
    }
    return null;
  }

  private parseResearchPlan(raw: Record<string, unknown>): ResearchPlan {
    const intentRaw = (raw.intent || {}) as Record<string, unknown>;
    const scopeRaw = (raw.scope || {}) as Record<string, unknown>;
    const evStratRaw = (raw.evidenceStrategy || {}) as Record<string, unknown>;
    const searchStratRaw = (raw.searchStrategy || {}) as Record<string, unknown>;
    const gatesRaw = (raw.qualityGates || {}) as Record<string, unknown>;
    const synthRaw = (raw.synthesisPlan || {}) as Record<string, unknown>;

    const intent: ResearchIntent = {
      taskType: (intentRaw.taskType as ResearchIntent['taskType']) || 'analytical',
      userGoal: (intentRaw.userGoal as string) || this.originalQuery,
      expectedOutput: (intentRaw.expectedOutput as ResearchIntent['expectedOutput']) || 'structured_report',
      audienceLevel: (intentRaw.audienceLevel as ResearchIntent['audienceLevel']) || 'intermediate',
    };

    const scope: ResearchScope = {
      included: Array.isArray(scopeRaw.included) ? scopeRaw.included as string[] : [],
      excluded: Array.isArray(scopeRaw.excluded) ? scopeRaw.excluded as string[] : [],
      timeRange: scopeRaw.timeRange as string | undefined,
      geography: scopeRaw.geography as string | undefined,
      domains: Array.isArray(scopeRaw.domains) ? scopeRaw.domains as string[] : [],
      assumptions: Array.isArray(scopeRaw.assumptions) ? scopeRaw.assumptions as string[] : [],
      clarificationNeeded: !!scopeRaw.clarificationNeeded,
      blockingQuestions: Array.isArray(scopeRaw.blockingQuestions) ? scopeRaw.blockingQuestions as string[] : [],
      nonBlockingSuggestions: Array.isArray(scopeRaw.nonBlockingSuggestions) ? scopeRaw.nonBlockingSuggestions as string[] : [],
    };

    const evidenceStrategy: EvidenceStrategy = {
      sourceTypes: Array.isArray(evStratRaw.sourceTypes)
        ? evStratRaw.sourceTypes as EvidenceStrategy['sourceTypes']
        : ['paper', 'official'],
      authorityRules: Array.isArray(evStratRaw.authorityRules) ? evStratRaw.authorityRules as string[] : [],
      freshnessRequirement: (evStratRaw.freshnessRequirement as EvidenceStrategy['freshnessRequirement']) || 'recent',
      minIndependentSources: typeof evStratRaw.minIndependentSources === 'number' ? evStratRaw.minIndependentSources : 3,
      mustFindPrimarySources: !!evStratRaw.mustFindPrimarySources,
      mustFindCounterEvidence: !!evStratRaw.mustFindCounterEvidence,
    };

    const searchStrategy: ResearchSearchStrategy = {
      seedQueries: Array.isArray(searchStratRaw.seedQueries) ? searchStratRaw.seedQueries as string[] : [this.originalQuery],
      queryExpansionRules: Array.isArray(searchStratRaw.queryExpansionRules) ? searchStratRaw.queryExpansionRules as string[] : [],
      priorityOrder: Array.isArray(searchStratRaw.priorityOrder) ? searchStratRaw.priorityOrder as string[] : [],
    };

    const qualityGates: QualityGates = {
      coverageThreshold: typeof gatesRaw.coverageThreshold === 'number'
        ? gatesRaw.coverageThreshold : this.config.coverageThreshold,
      requiredFindings: Array.isArray(gatesRaw.requiredFindings) ? gatesRaw.requiredFindings as string[] : [],
      stopConditions: Array.isArray(gatesRaw.stopConditions) ? gatesRaw.stopConditions as string[] : [],
      failureConditions: Array.isArray(gatesRaw.failureConditions) ? gatesRaw.failureConditions as string[] : [],
    };

    const synthesisPlan: SynthesisPlan = {
      recommendedStructure: Array.isArray(synthRaw.recommendedStructure)
        ? synthRaw.recommendedStructure as string[]
        : ['Executive Summary', 'Key Findings', 'Analysis', 'Limitations', 'References'],
      comparisonDimensions: Array.isArray(synthRaw.comparisonDimensions)
        ? synthRaw.comparisonDimensions as string[]
        : undefined,
      expectedCaveats: Array.isArray(synthRaw.expectedCaveats) ? synthRaw.expectedCaveats as string[] : [],
    };

    const researchQuestions: ResearchQuestion[] = [];
    const rawQs = raw.researchQuestions || raw.questions;
    if (Array.isArray(rawQs)) {
      let idx = 0;
      for (const q of rawQs as Array<Record<string, unknown>>) {
        const id = `q_plan_${idx++}`;
        const qText = (q.text || '') as string;
        const qPurpose: QuestionPurpose = (q.purpose as QuestionPurpose) || 'evidence';
        const qPriority = Math.min(3, Math.max(1, ((q.priority as number) || 2) | 0));
        const qDependsOn: string[] = Array.isArray(q.dependsOn) ? q.dependsOn as string[] : [];
        const qSearchQueries: string[] = Array.isArray(q.searchQueries)
          ? q.searchQueries as string[]
          : [qText];
        const rawReqEv = (q.requiredEvidence || {}) as Record<string, unknown>;
        const requiredEvidence: RequiredEvidence = {
          sourceTypes: Array.isArray(rawReqEv.sourceTypes) ? rawReqEv.sourceTypes as string[] : [],
          minSources: typeof rawReqEv.minSources === 'number' ? rawReqEv.minSources : 2,
          needsPrimarySource: !!rawReqEv.needsPrimarySource,
          needsRecentSource: !!rawReqEv.needsRecentSource,
          needsCounterEvidence: !!rawReqEv.needsCounterEvidence,
        };

        researchQuestions.push({
          id,
          text: qText,
          purpose: qPurpose,
          questionLayer: ((q.questionLayer as string) || undefined) as QuestionLayer | undefined,
          hypothesisLink: (q.hypothesisLink as string) || undefined,
          priority: qPriority as 1 | 2 | 3,
          dependsOn: qDependsOn,
          searchQueries: qSearchQueries,
          requiredEvidence,
          status: 'pending',
          sources: [],
        });
      }
    }

    return {
      intent,
      scope,
      hypotheses: this.extractHypotheses(raw),
      researchQuestions,
      evidenceStrategy,
      searchStrategy,
      qualityGates,
      synthesisPlan,
    };
  }

  private extractHypotheses(raw: Record<string, unknown>): Hypothesis[] | undefined {
    const rawHyps = raw.hypotheses;
    if (!Array.isArray(rawHyps) || rawHyps.length === 0) return undefined;

    return (rawHyps as Array<Record<string, unknown>>).map((h) => ({
      statement: (h.statement as string) || '',
      type: (h.type as Hypothesis['type']) || 'subsidiary',
      verificationApproach: (h.verificationApproach as string) || '',
      expectedEvidence: (h.expectedEvidence as string) || '',
      falsificationCriteria: (h.falsificationCriteria as string) || '',
    }));
  }

  private addFallbackQuestion(): void {
    this.context.addQuestion({
      id: 'q_plan_fallback_0',
      text: this.originalQuery,
      purpose: 'evidence',
      priority: 1,
      dependsOn: [],
      searchQueries: [this.originalQuery],
      requiredEvidence: {
        sourceTypes: [],
        minSources: 2,
        needsPrimarySource: false,
        needsRecentSource: false,
        needsCounterEvidence: false,
      },
      status: 'pending',
      sources: [],
    });
  }

  private async executePlanApproval(): Promise<void> {
    const plan = this.context.getResearchPlan();
    const questions = this.context.getQuestions().filter((q) => q.status !== 'obsolete');
    if (questions.length === 0) {
      return;
    }

    const effectivePlan = plan || {
      intent: {
        userGoal: this.originalQuery,
        taskType: 'analytical' as const,
        expectedOutput: 'structured_report' as const,
        audienceLevel: 'intermediate' as const,
      },
      scope: {
        included: [this.originalQuery],
        excluded: [],
        timeRange: '',
        geography: '',
        assumptions: [],
        domains: [],
        clarificationNeeded: false,
        blockingQuestions: [],
        nonBlockingSuggestions: [],
      },
      researchQuestions: questions.map((q) => ({
        id: q.id,
        text: q.text,
        purpose: q.purpose || ('evidence' as const),
        questionLayer: (q.questionLayer || 'analytical') as 'analytical',
        priority: (q.priority || 1) as 1 | 2 | 3,
        dependsOn: q.dependsOn || [],
        searchQueries: q.searchQueries || [q.text],
        requiredEvidence: q.requiredEvidence || {
          sourceTypes: ['news'],
          minSources: 1,
          needsPrimarySource: false,
          needsRecentSource: true,
          needsCounterEvidence: false,
        },
        status: (q.status || 'pending') as ResearchQuestion['status'],
        sources: q.sources || [],
      })),
      evidenceStrategy: {
        sourceTypes: ['news' as const],
        authorityRules: [],
        freshnessRequirement: 'recent' as const,
        minIndependentSources: 2,
        mustFindPrimarySources: false,
        mustFindCounterEvidence: false,
      },
      qualityGates: {
        coverageThreshold: 0.5,
        requiredFindings: [],
        stopConditions: ['all_questions_answered'],
        failureConditions: [],
      },
      searchStrategy: {
        seedQueries: [this.originalQuery],
        queryExpansionRules: ['synonyms', 'related_concepts'],
        priorityOrder: ['recent', 'authoritative'],
      },
      hypotheses: [],
      synthesisPlan: {
        recommendedStructure: ['summary', 'findings', 'conclusion'],
        expectedCaveats: [],
      },
    };

    const requestId = `plan_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    this.emit({
      type: 'planning_complete',
      requestId,
      plan: effectivePlan as ResearchPlan,
      approvalRequired: true,
      complexity: this.currentClassification.complexity,
      maxIterations: this.config.maxIterations,
    });

    const answers = await this.awaitClarification([
      {
        id: 'approval',
        question: 'Approve the research plan and start execution?',
        type: 'single_choice',
        options: ['start', 'edit_scope', 'add_question', 'remove_question', 'increase_depth', 'decrease_depth', 'change_sources', 'cancel'],
      },
    ], requestId);

    const action = answers.approval;
    if (action === 'cancel') {
      throw new Error('Research plan cancelled by user.');
    }

    if (action === 'increase_depth') {
      this.config.maxIterations = Math.min(this.config.maxIterations + 5, 20);
    }
    if (action === 'decrease_depth') {
      this.config.maxIterations = Math.max(this.config.maxIterations - 1, 1);
    }
  }

  // === Phase: Research Loop ===

  private initResearchState(): void {
    const plan = this.context.getResearchPlan();
    const questions = this.context.getQuestions();

    const questionCoverage: QuestionCoverageStatus[] = questions
      .filter((q) => q.status !== 'obsolete')
      .map((q) => ({
        questionId: q.id,
        questionLayer: q.questionLayer || 'analytical',
        status: 'pending' as const,
        anchorFindings: [],
        coverageScore: 0,
      }));

    const hypothesisStatuses: HypothesisStatus[] = (plan?.hypotheses || []).map((h) => ({
      statement: h.statement,
      verdict: 'unexamined' as const,
      supportingFindings: [],
      contradictingFindings: [],
      confidenceLevel: 'insufficient-evidence' as const,
    }));

    this.researchState = {
      iteration: 0,
      questionCoverage,
      hypothesisStatuses,
      conflicts: [],
      gapFindings: [],
      saturationSignals: [],
      overallCoverageScore: 0,
    };
  }

  private async executeResearchLoop(): Promise<void> {
    const maxIter = this.config.maxIterations;

    this.initResearchState();

    for (let i = 0; i < maxIter; i++) {
      this.throwIfCancelled();
      this.currentIteration = i + 1;

      if (this.abortController?.signal.aborted) {
        this.transitionTo(OrchestratorPhase.ABORTED);
        return;
      }

      // M1.1: 使用动态问题排序而非静态 priority 排序
      const rankingWeights = this.config.questionRankingWeights;
      const activeQs = this.context.rankQuestionsForIteration(
        this.config.maxQuestionsPerIteration,
        rankingWeights
      );

      this.emit({
        type: 'iteration_start',
        iteration: this.currentIteration,
        maxIterations: maxIter,
        questions: activeQs.map((q) => q.text),
      });

      const activeQuestionIds = activeQs.map((q) => q.id);
      const questionPreview = activeQs.slice(0, 2).map((q) => q.text).join('、');
      const questionSuffix = activeQs.length > 2 ? ` 等 ${activeQs.length} 个问题` : '';
      await this._logActivity(
        'search',
        `正在调查关键问题`,
        `${questionPreview}${questionSuffix}`
      );

      if (activeQs.length > 0) {
        await this._updateActiveStep(activeQs[0].id);
      }

      const qualityReport = this.context.calculateQualityReport();

      if (qualityReport.nextActions.length > 0) {
        for (const action of qualityReport.nextActions.slice(0, 3)) {
          this.emit({
            type: 'research_next_action',
            action,
            reason: 'Coverage gap detected',
          });
        }
      }

      let findingCount = 0;

      if (this.llmAgentCall) {
        this.throwIfCancelled();
        const results = await this.exploreIteration(activeQs);
        this.throwIfCancelled();

        for (const result of results) {
          this.emit({ type: 'action_executed', result });

          if (result.findings) {
            for (const f of result.findings) {
              this.context.addFinding(f);
              this.emit({ type: 'finding_added', finding: f });

              if (f.stance === 'contradicts') {
                const existingSupports = this.context
                  .getFindingsByQuestionId(f.questionId)
                  .filter((ef) => ef.stance === 'supports' && ef.id !== f.id);
                if (existingSupports.length > 0) {
                  this.emit({
                    type: 'research_conflict_detected',
                    findingId1: existingSupports[0].id,
                    findingId2: f.id,
                    description: f.claim,
                  });
                }
              }

              findingCount++;
            }
          }
        }
      } else {
        // Fallback: rigid select-actions → execute pipeline
        this.throwIfCancelled();
        const actions = await this.llmSelectResearchActions(activeQs, qualityReport);

        if (actions.length > 0) {
          const results = await this.executeResearchActions(actions);
          this.throwIfCancelled();

          for (const result of results) {
            this.emit({ type: 'action_executed', result });

            if (result.findings) {
              for (const f of result.findings) {
                this.context.addFinding(f);
                this.emit({ type: 'finding_added', finding: f });

                if (f.stance === 'contradicts') {
                  const existingSupports = this.context
                    .getFindingsByQuestionId(f.questionId)
                    .filter((ef) => ef.stance === 'supports' && ef.id !== f.id);
                  if (existingSupports.length > 0) {
                    this.emit({
                      type: 'research_conflict_detected',
                      findingId1: existingSupports[0].id,
                      findingId2: f.id,
                      description: f.claim,
                    });
                  }
                }

                findingCount++;
              }
            }
          }
        }
      }

      const updatedReport = this.context.calculateQualityReport();

      this.emit({
        type: 'iteration_complete',
        iteration: this.currentIteration,
        findingsCount: findingCount,
        coverage: this.context.calculateQualityCoverage(),
        qualityReport: updatedReport,
      });

      for (const q of activeQs) {
        if (q.status === 'answered' || q.status === 'obsolete') {
          await this._completeStep(q.id);
        }
      }

      const coverage = this.context.calculateQualityCoverage();
      await this._updateRun({
        progress_summary: `Iteration ${this.currentIteration}/${maxIter}: ${findingCount} new findings, ${Math.round(coverage * 100)}% coverage`,
        current_phase: 'researching',
      });

      if (updatedReport.blockers.length > 0) {
        const gaps = updatedReport.blockers.slice(0, 5);
        const nextActions = updatedReport.nextActions.slice(0, 3);
        this.emit({
          type: 'research_gap_detected',
          gaps,
          nextActions,
        });
      }

      this.emit({
        type: 'research_quality_snapshot',
        qualityReport: updatedReport,
      });

      if (this.persistState) {
        try {
          await this.persistState(this.context.toJSON());
        } catch {
          // persist failure is non-fatal
        }
      }

      this.researchState.iteration = this.currentIteration;

      await this.evaluateCoverageViaLLM(i);
      this.throwIfCancelled();

      // M1.3: 使用 StopDecision 替代 shouldStop
      const stopDecision = this.evaluateStop(updatedReport);
      this.emit({ type: 'research_stop_decision', decision: stopDecision });

      if (stopDecision.shouldStop) {
        this.emit({
          type: 'early_stop',
          reason: stopDecision.reason,
          coverage: updatedReport.score,
          iteration: this.currentIteration,
          maxIterations: this.config.maxIterations,
          qualityReport: updatedReport,
        });
        break;
      }

      if (i < maxIter - 1) {
        const hasConflicts = this.researchState.conflicts.filter((c) => !c.resolved).length > 0;
        const hasRefutedHypothesis = this.researchState.hypothesisStatuses.some(
          (hs) => hs.verdict === 'refuted'
        );
        const hasBlockedQuestions = this.researchState.questionCoverage.some(
          (qc) => qc.status === 'blocked'
        );

        if (hasConflicts || hasRefutedHypothesis || hasBlockedQuestions) {
          const triggerReason: ReplanInput['triggerReason'] = hasRefutedHypothesis
            ? 'hypothesis-refuted'
            : hasBlockedQuestions
              ? 'evidence-gap'
              : 'unexpected-finding';

          const refutedHypothesis = hasRefutedHypothesis
            ? this.researchState.hypothesisStatuses.find((hs) => hs.verdict === 'refuted')?.statement
            : undefined;

          await this.replan(updatedReport, triggerReason, refutedHypothesis);
          this.throwIfCancelled();
        }
      }
    }
  }

  // === Autonomous Exploration ===

  private async exploreIteration(
    questions: ResearchQuestion[]
  ): Promise<ResearchActionResult[]> {
    this.throwIfCancelled();
    if (!this.llmAgentCall) {
      return [];
    }

    const results: ResearchActionResult[] = [];

    const questionPreview = questions.slice(0, 2).map((q) => q.text).join('、');
    const questionSuffix = questions.length > 2 ? ` 等 ${questions.length} 个问题` : '';
    await this._logActivity(
      'search',
      '正在搜索核心来源',
      `调查 ${questionPreview}${questionSuffix}`
    );

    const plan = this.context.getResearchPlan();
    const existingFindings = this.context.getAllFindings().slice(-30);

    const userPrompt = buildExplorePrompt({
      questions,
      plan: plan ?? null,
      existingFindings,
      researchState: this.researchState,
      iteration: this.currentIteration,
      maxIterations: this.config.maxIterations,
      query: this.originalQuery,
    });

    try {
      const response = await this.llmAgentCall({
        systemPrompt: EXPLORE_AGENT_SYSTEM_PROMPT,
        userPrompt,
        tools: BROWSER_TOOLS,
        maxToolCalls: this.config.maxToolCallsPerIteration,
        toolExecute: this.toolExecute,
      });
      this.throwIfCancelled();

      // Extract structured findings from agent's JSON response
      const parsed = parseExploreResponse(response.content);
      const allFindings: ResearchFinding[] = [];

      for (let i = 0; i < parsed.findings.length; i++) {
        const f = parsed.findings[i];
        const questionIndex = typeof f.questionIndex === 'number' ? f.questionIndex : 0;
        const targetQuestion = questions[questionIndex];
        const questionId = targetQuestion?.id || (questions[0]?.id || 'unknown');

        const finding: ResearchFinding = {
          id: `f_explore_${Date.now()}_${i}`,
          questionId,
          type: 'web',
          claim: f.claim,
          evidence: f.evidence || f.claim,
          content: f.claim,
          source: 'browser',
          sourceId: `src_explore_${Date.now()}_${i}`,
          sourceType: 'blog' as ResearchFinding['sourceType'],
          title: f.sourceTitle,
          url: f.sourceUrl,
          accessedAt: new Date().toISOString(),
          sourceReliability: f.confidence >= 0.8 ? 'medium' : f.confidence >= 0.6 ? 'low' : 'unverified',
          authorityLevel: f.confidence >= 0.8 ? 'medium' : 'low',
          stance: (f.stance as ResearchFinding['stance']) || 'neutral',
          confidence: Math.min(1, Math.max(0, f.confidence || 0.7)),
          relevance: 0.7,
          relatedQuestionIds: [questionId],
          supports: [],
          contradicts: [],
          limitations: Array.isArray(f.limitations) ? f.limitations : [],
          extractedEntities: [],
          iteration: this.currentIteration - 1,
          evidenceType: f.evidenceType,
        };

        allFindings.push(finding);
      }

      if (allFindings.length > 0) {
        results.push({
          actionId: `explore_${Date.now()}`,
          action: {
            id: `explore_${Date.now()}`,
            type: 'search',
            targetQuestionId: questions[0]?.id || '',
            params: {},
            priority: 1,
            reason: 'Autonomous agent exploration',
            expectedOutcome: `Investigated ${questions.length} questions, found ${allFindings.length} findings`,
          },
          status: 'success',
          findings: allFindings,
          retryable: false,
          attempts: 1,
        });
      }

      // Mark answered questions
      const answeredQuestions: string[] = [];
      for (const qi of parsed.questionsAnswered) {
        const q = questions[qi];
        if (q) {
          this.context.markQuestionAnswered(q.id);
          answeredQuestions.push(q.text);
        }
      }

      for (const qi of parsed.questionsPartiallyAnswered) {
        const q = questions[qi];
        if (q) {
          this.context.markQuestionPartial(q.id);
        }
      }

      // Emit source-based activity with extracted source URLs
      const sourceUrls = new Map<string, string>();
      for (const f of parsed.findings) {
        if (f.sourceUrl && f.sourceTitle) {
          sourceUrls.set(f.sourceUrl, f.sourceTitle);
        }
      }
      const sources = Array.from(sourceUrls.entries()).map(([url, title]) => ({
        url,
        title: title || extractDomain(url),
      }));

      await this._logActivity(
        'finding',
        allFindings.length > 0 ? `发现 ${allFindings.length} 条关键证据` : '搜索完成，正在整理信息',
        sources.length > 0 ? `来源：${sources.map((s) => s.title).join('、')}` : undefined,
        'user',
        sources.length > 0 ? sources : undefined,
      );

      // Emit activity for each answered question
      for (const qText of answeredQuestions.slice(0, 3)) {
        await this._logActivity(
          'question_answered',
          '已回答',
          qText.length > 40 ? qText.slice(0, 40) + '...' : qText,
        );
      }

      // Report gaps
      if (parsed.gapsIdentified.length > 0) {
        this.emit({
          type: 'research_gap_detected',
          gaps: parsed.gapsIdentified,
          nextActions: parsed.nextSuggestedQueries,
        });
      }

      // Update hypothesis statuses
      for (const hu of parsed.hypothesisUpdates) {
        const existing = this.researchState.hypothesisStatuses.find(
          (hs) => hs.statement === hu.statement
        );
        if (existing) {
          existing.verdict = hu.verdict;
          existing.confidenceLevel = hu.verdict === 'supported' ? 'high' :
            hu.verdict === 'refuted' ? 'high' : 'medium';
        }
      }
    } catch (err) {
      if (isResearchCancelledError(err) || this.cancelled || this.localAbortController.signal.aborted) {
        throw err;
      }
      const message = err instanceof Error ? err.message : String(err);
      await this._logActivity('error', '搜索过程遇到问题', message);
      this.emit({ type: 'error', message: `Exploration failed: ${message}` });
    }

    return results;
  }

  // === M2.1: Research Action Dispatch ===

  private async executeResearchActions(
    actions: ResearchAction[]
  ): Promise<ResearchActionResult[]> {
    this.throwIfCancelled();
    const results: ResearchActionResult[] = [];

    const searchActions = actions.filter((a) => a.type === 'search');
    const sourceCheckActions = actions.filter(
      (a) => a.type === 'source_check' || a.type === 'fetch' || a.type === 'claim_verify'
    );
    const compareActions = actions.filter(
      (a) => a.type === 'compare'
    );
    const conflictActions = actions.filter(
      (a) => a.type === 'conflict_resolve' || a.type === 'gap_probe'
    );
    const terminalActions = actions.filter(
      (a) => a.type === 'replan' || a.type === 'terminate'
    );
    const otherActions = actions.filter(
      (a) => a.type === 'backtrack' || a.type === 'stop_question'
    );

    if (searchActions.length > 0) {
      const searchResults = await this.executeSearchActions(searchActions);
      results.push(...searchResults);
    }

    if (sourceCheckActions.length > 0) {
      const checkResults = await this.executeSourceCheck(sourceCheckActions);
      results.push(...checkResults);
    }

    if (compareActions.length > 0) {
      const compareResults = await this.executeCompare(compareActions as unknown as CompareAction[]);
      results.push(...compareResults);
    }

    if (conflictActions.length > 0) {
      for (const action of conflictActions) {
        results.push({
          actionId: action.id,
          action,
          status: 'skipped',
          retryable: false,
          attempts: 1,
        });
      }
    }

    if (terminalActions.length > 0) {
      for (const action of terminalActions) {
        results.push({
          actionId: action.id,
          action,
          status: 'skipped',
          retryable: false,
          attempts: 1,
        });
      }
    }

    for (const action of otherActions) {
      results.push({
        actionId: action.id,
        action,
        status: 'skipped',
        retryable: false,
        attempts: 1,
      });
    }

    return results;
  }

  private async executeSearchActions(
    actions: ResearchAction[]
  ): Promise<ResearchActionResult[]> {
    const results: ResearchActionResult[] = [];
    const iteration = this.currentIteration - 1;

    const validActions = actions.filter((a) => a.params.query);
    if (validActions.length === 0) return results;

    const calls = validActions.map((a) => ({
      name: 'browser',
      input: {
        operation: 'navigate',
        url: buildSearchUrl(a.params.query!),
      },
    }));

    let callIndex = 0;
    for await (const toolResult of this.toolExecuteConcurrent(calls)) {
      const matchedAction = validActions[callIndex] || validActions[0];
      callIndex++;
      const truncated = truncateResult(toolResult.result || '');

      const strategies: SearchStrategy[] = validActions
        .filter((a) => a.params.query === matchedAction.params.query)
        .map((a) => ({
          questionId: a.targetQuestionId,
          question: '',
          tool: 'browser',
          params: { query: a.params.query || '' },
          priority: a.priority,
          queryType: 'en_resources' as const,
        }));

      try {
        const findings = await this.llmExtractFindings(
          toolResult.name,
          truncated,
          strategies.length > 0 ? strategies : [],
          iteration,
        );

        if (findings.length > 0) {
          results.push({
            actionId: matchedAction.id,
            action: matchedAction,
            status: 'success',
            findings,
            retryable: false,
            attempts: 1,
          });
        } else {
          results.push({
            actionId: matchedAction.id,
            action: matchedAction,
            status: 'partial',
            retryable: false,
            attempts: 1,
          });
        }
      } catch (err) {
        results.push({
          actionId: matchedAction.id,
          action: matchedAction,
          status: 'failed',
          error: err instanceof Error ? err.message : String(err),
          retryable: true,
          attempts: 1,
        });
      }
    }

    return results;
  }

  private async executeSourceCheck(
    actions: ResearchAction[]
  ): Promise<ResearchActionResult[]> {
    const results: ResearchActionResult[] = [];

    for (const action of actions) {
      if (!action.params.url) {
        results.push({
          actionId: action.id,
          action,
          status: 'failed',
          error: 'Missing URL for source check',
          retryable: false,
          attempts: 1,
        });
        continue;
      }

      try {
        const toolResult = await this.toolExecute('browser', {
          operation: 'navigate',
          url: action.params.url!,
        });

        const truncated = truncateResult(toolResult.result || '', 4000);
        const prompt = sourceCheck.buildPrompt({
          url: action.params.url,
          contentExcerpt: truncated,
        });

        const response = await this.llmComplete(prompt);
        const parsed = sourceCheck.parseResponse(response);

        const finding: ResearchFinding = {
          id: `f_src_${Date.now()}`,
          questionId: action.targetQuestionId,
          type: 'web',
          claim: parsed.summary || `Source check: ${action.params.url}`,
          evidence: '',
          content: parsed.summary || '',
          source: 'browser',
          sourceId: action.params.sourceId || `src_${Date.now()}`,
          sourceType: 'blog',
          url: action.params.url,
          accessedAt: new Date().toISOString(),
          sourceReliability: (parsed.reliability as ResearchFinding['sourceReliability']) || 'unverified',
          authorityLevel: (parsed.reliability === 'high') ? 'high' : 'medium',
          stance: 'neutral',
          confidence: parsed.relevance || 0.5,
          relevance: parsed.relevance || 0.5,
          relatedQuestionIds: [action.targetQuestionId],
          supports: [],
          contradicts: [],
          limitations: [],
          extractedEntities: [],
          iteration: this.currentIteration - 1,
        };

        results.push({
          actionId: action.id,
          action,
          status: 'success',
          findings: [finding],
          retryable: false,
          attempts: 1,
        });
      } catch (err) {
        results.push({
          actionId: action.id,
          action,
          status: 'failed',
          error: err instanceof Error ? err.message : String(err),
          retryable: true,
          attempts: 1,
        });
      }
    }

    return results;
  }

  private async executeCompare(
    actions: CompareAction[]
  ): Promise<ResearchActionResult[]> {
    const results: ResearchActionResult[] = [];

    for (const action of actions) {
      try {
        const contextText = this.context.toPromptContext();

        const prompt = compare.buildPrompt({
          action,
          contextText,
        });

        const response = await this.llmComplete(prompt);
        const parsed = compare.parseResponse(response);

        const cmpId = `cmp_${Date.now()}`;
        const finding: ResearchFinding = {
          id: `f_${cmpId}`,
          questionId: action.targetQuestionId,
          type: 'concept',
          claim: parsed.synthesis || `Comparison: ${action.comparisonGoal}`,
          evidence: JSON.stringify(parsed || {}),
          content: parsed.synthesis || '',
          source: 'compare_analysis',
          sourceId: cmpId,
          sourceType: 'blog',
          accessedAt: new Date().toISOString(),
          sourceReliability: 'medium',
          authorityLevel: 'medium',
          stance: 'neutral',
          confidence: 0.7,
          relevance: 0.8,
          relatedQuestionIds: [action.targetQuestionId],
          supports: [],
          contradicts: [],
          limitations: [],
          extractedEntities: [],
          iteration: this.currentIteration - 1,
        };

        results.push({
          actionId: cmpId,
          action: {
            id: cmpId,
            type: 'compare',
            targetQuestionId: action.targetQuestionId,
            params: { compareItems: action.sourceIds },
            priority: action.priority,
            reason: action.reason,
            expectedOutcome: action.comparisonGoal,
          },
          status: 'success',
          findings: [finding],
          retryable: false,
          attempts: 1,
        });
      } catch (err) {
        const cmpId = `cmp_${Date.now()}`;
        results.push({
          actionId: cmpId,
          action: {
            id: cmpId,
            type: 'compare',
            targetQuestionId: action.targetQuestionId,
            params: { compareItems: action.sourceIds },
            priority: action.priority,
            reason: action.reason,
            expectedOutcome: action.comparisonGoal,
          },
          status: 'failed',
          error: err instanceof Error ? err.message : String(err),
          retryable: true,
          attempts: 1,
        });
      }
    }

    return results;
  }

  // === M2.1: LLM Action Selection ===

  private async llmSelectResearchActions(
    questions: ResearchQuestion[],
    qualityReport: QualityReport,
  ): Promise<ResearchAction[]> {
    if (questions.length === 0) return [];

    const plan = this.context.getResearchPlan();
    const contextText = this.context.toPromptContext();

    const prompt = selectActions.buildPrompt({
      questions,
      qualityReport,
      plan: plan ?? null,
      contextText,
      concurrencyLimit: this.config.concurrencyLimit,
    });

    try {
      const response = await this.llmComplete(prompt);
      return selectActions.parseResponse(response, questions, this.config.concurrencyLimit);
    } catch {
      // fall through
    }

    return selectActions.parseResponse('', questions, this.config.concurrencyLimit);
  }

  private async llmExtractFindings(
    toolName: string,
    result: string,
    strategies: SearchStrategy[],
    iteration: number,
  ): Promise<ResearchFinding[]> {
    const existingFindings = this.context.getAllFindings().slice(-15);
    const questions = this.context.getQuestions();
    const questionTexts = questions
      .map((q) => `[${q.id}] (${q.status}, ${q.purpose}) ${q.text}`)
      .join('\n');

    const prompt = extractFindings.buildPrompt({
      toolName,
      result,
      strategies,
      iteration,
      existingFindingsSummary: existingFindings.map((f) => `- [${f.id}] ${f.content.slice(0, 100)}`).join('\n') || '(none)',
      questionTexts,
    });

    try {
      const response = await this.llmComplete(prompt);
      return extractFindings.parseResponse(response, strategies, toolName, iteration);
    } catch {
      // fall through
    }

    return [];
  }

  private async evaluateCoverageViaLLM(iterationIndex: number): Promise<void> {
    const plan = this.context.getResearchPlan();
    const questions = this.context.getActiveQuestions();
    const allFindings = this.context.getAllFindings();
    const newFindings = allFindings.filter((f) => f.iteration === iterationIndex);

    const existingQuestions = questions
      .map((q) => `[${q.id}] (${q.status}, layer=${q.questionLayer || 'analytical'}, purpose=${q.purpose}) ${q.text}`)
      .join('\n');

    const newFindingsSummary = newFindings
      .map((f) => `[${f.id}] q=${f.questionId} stance=${f.stance} "${f.claim.slice(0, 120)}"`)
      .join('\n') || '(none)';

    const researchStateSummary = JSON.stringify({
      iteration: this.researchState.iteration,
      overallCoverageScore: this.researchState.overallCoverageScore,
      questionCoverage: this.researchState.questionCoverage.map((qc) => ({
        questionId: qc.questionId,
        status: qc.status,
        coverageScore: qc.coverageScore,
      })),
      hypothesisStatuses: this.researchState.hypothesisStatuses.map((hs) => ({
        statement: hs.statement,
        verdict: hs.verdict,
        confidenceLevel: hs.confidenceLevel,
      })),
      saturationSignals: this.researchState.saturationSignals,
    });

    const prompt = continueResearch.buildPrompt({
      existingQuestions,
      plan: plan ?? null,
      researchStateSummary,
      newFindingsSummary,
      iteration: this.currentIteration,
      maxIterations: this.config.maxIterations,
      isLoopEvaluation: true,
    });

    try {
      const response = await this.llmComplete(prompt);
      const parsed = continueResearch.parseResponse(response);

      this.researchState.questionCoverage = parsed.updatedCoverage.map((uc) => ({
        questionId: uc.questionId,
        questionLayer: (uc.questionLayer as QuestionCoverageStatus['questionLayer']) || 'analytical',
        status: uc.status,
        anchorFindings: uc.anchorFindings || [],
        coverageScore: uc.coverageScore || 0,
        blockedReason: uc.blockedReason,
      }));

      this.researchState.hypothesisStatuses = parsed.updatedHypotheses.map((uh) => ({
        statement: uh.statement,
        verdict: uh.verdict,
        supportingFindings: uh.supportingFindings || [],
        contradictingFindings: uh.contradictingFindings || [],
        confidenceLevel: uh.confidenceLevel,
      }));

      this.researchState.conflicts = parsed.newConflicts.map((nc) => ({
        topic: nc.topic,
        positionA: nc.positionA,
        positionB: nc.positionB,
        findingIds: nc.findingIds || [],
        resolved: nc.resolved || false,
        resolution: nc.resolution,
      }));

      this.researchState.saturationSignals = parsed.saturationSignals || [];
      this.researchState.overallCoverageScore = parsed.overallCoverageScore;

      if (parsed.saturationSignals.length > 0) {
        for (const signal of parsed.saturationSignals.slice(0, 3)) {
          this.emit({
            type: 'research_next_action',
            action: `Saturation: ${signal}`,
            reason: 'Coverage saturation detected',
          });
        }
      }

      if (parsed.newConflicts.length > 0) {
        for (const conflict of parsed.newConflicts.slice(0, 3)) {
          this.emit({
            type: 'research_conflict_detected',
            findingId1: conflict.findingIds[0] || '',
            findingId2: conflict.findingIds[1] || '',
            description: `${conflict.topic}: ${conflict.positionA} vs ${conflict.positionB}`,
          });
        }
      }
    } catch {
      // LLM evaluation is optional, silent failure is acceptable
    }
  }

  // M2.2: PlanDelta-driven replan with goal_change confirmation
  private async replan(
    qualityReport: QualityReport,
    triggerReason?: ReplanInput['triggerReason'],
    refutedHypothesis?: string,
  ): Promise<void> {
    const contextText = this.context.toPromptContext();
    const activeCount = this.context.getActiveQuestions().length;
    const remaining = Math.min(
      Math.max(0, this.config.maxTotalQuestions - activeCount),
      2 // M2.2: max 2 questions per iteration
    );

    if (remaining === 0) return;

    const plan = this.context.getResearchPlan();
    const currentGoal = plan?.intent?.userGoal || this.originalQuery;

    const prompt = replan.buildPrompt({
      contextText,
      qualityReport,
      remaining,
      currentGoal,
      triggerReason,
      refutedHypothesis,
    });

    try {
      const response = await this.llmComplete(prompt);
      const parsed = replan.parseResponse(response);

      const deltaType: PlanDeltaType = parsed.deltaType;
      const obsoletedIds: string[] = [];
      const newQuestions: ResearchQuestion[] = [];
      let goalChange: PlanDelta['goalChange'] | undefined;

      // Process obsolete questions
      if (parsed.obsolete.length > 0) {
        const obsoletedQs: ResearchQuestion[] = [];
        for (const qid of parsed.obsolete) {
          const q = this.context.getQuestion(qid);
          if (q && q.status !== 'obsolete') {
            this.context.markQuestionObsolete(qid);
            obsoletedQs.push(q);
            obsoletedIds.push(qid);
          }
        }
        if (obsoletedQs.length > 0) {
          this.emit({ type: 'questions_obsoleted', questions: obsoletedQs });
        }
      }

      // Process new questions (M2.2: max 2 per iteration)
      if (parsed.add.length > 0) {
        const limited = parsed.add.slice(0, 2);
        let idx = activeCount;
        for (const q of limited) {
          if (q.text) {
            const id = `q_replan_${idx++}`;
            const newQ: ResearchQuestion = {
              id,
              text: q.text,
              purpose: (q.purpose as QuestionPurpose) || 'evidence',
              priority: Math.min(3, Math.max(1, (q.priority || 2) + 1)) as 1 | 2 | 3,
              dependsOn: [],
              searchQueries: [q.text],
              requiredEvidence: {
                sourceTypes: [],
                minSources: 2,
                needsPrimarySource: false,
                needsRecentSource: false,
                needsCounterEvidence: false,
              },
              status: 'pending',
              sources: [],
            };
            newQuestions.push(newQ);
            this.context.addQuestion(newQ);
          }
        }
        if (newQuestions.length > 0) {
          this.emit({ type: 'questions_added', questions: newQuestions });
        }
      }

      // M2.2: Handle goal_change confirmation
      if (deltaType === 'goal_change') {
        const proposedGoal = parsed.goalChangeReason || 'research direction shift';
        goalChange = {
          from: currentGoal,
          to: proposedGoal,
          requiresConfirmation: true,
        };

        const requestId = `goal_change_${Date.now()}`;
        this.emit({
          type: 'research_goal_change_request',
          requestId,
          currentGoal,
          proposedGoal,
          changeType: 'goal_change',
        });

        // Await user confirmation
        try {
          const answers = await this.awaitClarification([
            {
              id: 'goal_confirm',
              question: `Confirm research goal change from "${currentGoal}" to "${proposedGoal}"?`,
              type: 'single_choice',
              options: ['confirm', 'cancel'],
            },
          ], requestId);

          if (answers.goal_confirm === 'cancel') {
            // Revert additions on cancel
            for (const q of newQuestions) {
              this.context.markQuestionObsolete(q.id);
            }
            // Emit cancellation delta
            const revertDelta: PlanDelta = {
              type: 'goal_change',
              addedQuestions: [],
              obsoletedQuestions: newQuestions.map((q) => q.id),
              goalChange,
            };
            this.emit({ type: 'plan_delta', data: revertDelta });
            return;
          }
        } catch {
          // Timeout: treat as cancel
          for (const q of newQuestions) {
            this.context.markQuestionObsolete(q.id);
          }
          return;
        }
      }

      // Emit PlanDelta
      const delta: PlanDelta = {
        type: deltaType,
        addedQuestions: newQuestions,
        obsoletedQuestions: obsoletedIds,
        goalChange,
      };
      this.emit({ type: 'plan_delta', data: delta });
    } catch {
      // replan is optional, silent failure is acceptable
    }
  }

  // M1.3: 停止决策评估
  private evaluateStop(report: QualityReport): StopDecision {
    if (this.currentIteration >= this.config.maxIterations) {
      return {
        shouldStop: true,
        reason: 'max_iterations',
        forced: true,
        unresolvedBlockers: report.criticalBlockers || [],
        qualityScore: report.score,
      };
    }

    if (report.criticalBlockers && report.criticalBlockers.length > 0) {
      return {
        shouldStop: false,
        reason: 'critical_blockers_exist',
        forced: false,
        unresolvedBlockers: [],
        qualityScore: report.score,
      };
    }

    const hasBlockers = report.blockers.length > 0;

    if (report.score >= this.config.coverageThreshold &&
        !hasBlockers &&
        report.readyForSynthesis &&
        this.currentIteration >= Math.max(3, Math.floor(this.config.maxIterations * 0.4))) {
      return {
        shouldStop: true,
        reason: 'coverage_threshold_met',
        forced: false,
        unresolvedBlockers: [],
        qualityScore: report.score,
      };
    }

    return {
      shouldStop: false,
      reason: hasBlockers ? 'blockers_remain' : 'insufficient_coverage',
      forced: false,
      unresolvedBlockers: [],
      qualityScore: report.score,
    };
  }

  private get abortController(): AbortController | undefined {
    return this.localAbortController;
  }

  // === Phase: Synthesis ===

  private async executeSynthesis(): Promise<void> {
    this.throwIfCancelled();
    this.emit({ type: 'synthesis_start' });

    const prompt = this.buildSynthesisPrompt();

    if (this.llmStreamFn) {
      let total = 0;
      try {
        for await (const delta of this.llmStreamFn(
          prompt,
          'You are the synthesis module of a deep research agent. Write using only the collected findings. Do not introduce unsupported facts.',
        )) {
          this.throwIfCancelled();
          this.emit({ type: 'synthesis_chunk', delta, total: total + delta.length });
          total += delta.length;
        }
      } catch {
        this.throwIfCancelled();
        const fallback = await this.llmComplete(prompt);
        this.emit({ type: 'synthesis_chunk', delta: fallback, total: fallback.length });
      }
    } else {
      this.throwIfCancelled();
      const report = await this.llmComplete(prompt);
      this.emit({ type: 'synthesis_chunk', delta: report, total: report.length });
    }

    this.throwIfCancelled();
    const reportId = `report_${Date.now()}`;
    this.emit({
      type: 'report_complete',
      reportId,
      content: 'Report generated via synthesis_chunk events',
      contextSnapshot: this.context.getStateSummary(),
    });
  }

  private buildSynthesisPrompt(): string {
    const plan = this.context.getResearchPlan();
    const questions = this.context.getQuestions();
    const findings = this.context.getAllFindings();
    const qualityReport = this.context.calculateQualityReport();

    const unresolvedConflicts = this.researchState.conflicts
      .filter((c) => !c.resolved)
      .map((c) => ({
        topic: c.topic,
        positionA: c.positionA,
        positionB: c.positionB,
        findingIds: c.findingIds,
      }));

    const confirmedGaps = this.researchState.questionCoverage
      .filter((qc) => qc.status === 'blocked')
      .map((qc) => `${qc.questionId}: ${qc.blockedReason || 'insufficient evidence'}`);

    const result = synthesize.buildPrompt({
      query: this.originalQuery,
      plan: plan ?? null,
      questions,
      findings,
      qualityReport,
      hypothesisStatuses: this.researchState.hypothesisStatuses.map((hs) => ({
        statement: hs.statement,
        verdict: hs.verdict,
        supportingFindings: hs.supportingFindings,
        contradictingFindings: hs.contradictingFindings,
        confidenceLevel: hs.confidenceLevel,
      })),
      unresolvedConflicts: unresolvedConflicts.length > 0 ? unresolvedConflicts : undefined,
      confirmedGaps: confirmedGaps.length > 0 ? confirmedGaps : undefined,
    });

    return result.prompt;
  }

  // === Utilities ===

  private emit(event: ResearchEvent): void {
    this.emitSSE(event);
  }

  private throwIfCancelled(): void {
    if (this.cancelled || this.localAbortController.signal.aborted) {
      this.cancelled = true;
      throw new ResearchCancelledError('Research cancelled');
    }
  }

  private transitionTo(newPhase: OrchestratorPhase): void {
    const old = this.currentPhase;
    this.currentPhase = newPhase;
    this.emit({ type: 'phase_change', from: old, to: newPhase });
  }

  private buildSummary(): string {
    const coverage = Math.round(this.context.calculateCoverage() * 100);
    const findings = this.context.getFindingCount();
    const questions = this.context.getQuestions().length;
    return `Research complete: ${findings} findings across ${questions} questions, ${coverage}% coverage in ${this.currentIteration} iterations.`;
  }
}

class ResearchCancelledError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ResearchCancelledError';
  }
}

function isResearchCancelledError(err: unknown): boolean {
  return err instanceof Error && err.name === 'ResearchCancelledError';
}
