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
} from './prompts/replan.js';
import {
  continueResearch,
  CONTINUE_RESEARCH_VERSION,
} from './prompts/continue-research.js';
import {
  synthesize,
  SYNTHESIZE_VERSION,
} from './prompts/synthesize.js';

export const DEFAULT_ORCHESTRATOR_CONFIG: Required<OrchestratorConfig> = {
  maxIterations: 5,
  concurrencyLimit: 8,
  coverageThreshold: 0.9,
  requireClarification: false,
  maxClarificationQuestions: 3,
  maxQuestionsPerIteration: 4,
  maxTotalQuestions: 15,

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
  maxToolCallsPerIteration: 8,
  maxSearchResultsPerQuery: 10,
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
    maxIterations: 2, coverageThreshold: 0.8,
    freshness: 'stable', sourceDepth: 'light', riskLevel: 'low',
    label: 'Factual (quick answer)',
  },
  conceptual: {
    maxIterations: 3, coverageThreshold: 0.8,
    freshness: 'stable', sourceDepth: 'standard', riskLevel: 'low',
    label: 'Conceptual (moderate depth)',
  },
  comparative: {
    maxIterations: 4, coverageThreshold: 0.85,
    freshness: 'recent', sourceDepth: 'standard', riskLevel: 'medium',
    label: 'Comparative (side-by-side analysis)',
  },
  analytical: {
    maxIterations: 5, coverageThreshold: 0.9,
    freshness: 'recent', sourceDepth: 'deep', riskLevel: 'high',
    label: 'Analytical (deep research)',
  },
  literature_review: {
    maxIterations: 6, coverageThreshold: 0.9,
    freshness: 'recent', sourceDepth: 'deep', riskLevel: 'high',
    label: 'Literature Review (comprehensive survey)',
  },
  technical_design: {
    maxIterations: 5, coverageThreshold: 0.85,
    freshness: 'latest', sourceDepth: 'deep', riskLevel: 'medium',
    label: 'Technical Design (implementation-focused)',
  },
  unknown: {
    maxIterations: 4, coverageThreshold: 0.85,
    freshness: 'recent', sourceDepth: 'standard', riskLevel: 'medium',
    label: 'General (default depth)',
  },
};

export class Orchestrator {
  private config: Required<OrchestratorConfig>;
  private context: ResearchContext;
  private currentPhase: OrchestratorPhase;
  private currentIteration: number;
  private currentClassification: ResearchClassification;
  private clarificationAnswers: Record<string, string> = {};
  private readonly originalQuery: string;

  private llmComplete: (prompt: string, systemPrompt?: string) => Promise<string>;
  private llmStreamFn?: (prompt: string, systemPrompt?: string) => AsyncIterable<string>;
  private toolExecute: (name: string, input: Record<string, unknown>) => Promise<ToolResult>;
  private toolExecuteConcurrent: (
    calls: Array<{ name: string; input: Record<string, unknown> }>
  ) => AsyncGenerator<ToolResult>;
  private emitSSE: (event: ResearchEvent) => void;
  private awaitClarification: (questions: ClarificationQuestion[], requestId: string) => Promise<Record<string, string>>;
  private persistState?: (contextJSON: string) => Promise<void>;

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
    this.toolExecute = deps.toolExecute;
    this.toolExecuteConcurrent = deps.toolExecuteConcurrent;
    this.emitSSE = deps.emitSSE;
    this.awaitClarification = deps.awaitClarification;
    this.persistState = deps.persistState;
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
      this.transitionTo(OrchestratorPhase.PLANNING);
      await this.classifyQuery();

      this.transitionTo(OrchestratorPhase.PLANNING);
      await this.executePlanning();

      const plan = this.context.getResearchPlan();
      if (plan && plan.scope.clarificationNeeded && plan.scope.blockingQuestions.length > 0) {
        this.transitionTo(OrchestratorPhase.CLARIFICATION);
        await this.executeClarification();
      }

      this.transitionTo(OrchestratorPhase.PLANNING);
      await this.executePlanApproval();

      this.transitionTo(OrchestratorPhase.RESEARCH_LOOP);
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
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.emit({ type: 'error', message });
      this.transitionTo(OrchestratorPhase.ABORTED);
    }
  }

  async handleClarificationAnswers(answers: Record<string, string>): Promise<void> {
    this.clarificationAnswers = answers;
    this.context.setUserAnswers(answers);
    this.emit({ type: 'clarification_answers_received', answers });
  }

  async continueResearch(additionalQuery: string): Promise<void> {
    const prompt = `
Additional research query: ${additionalQuery}

Existing questions:
${this.context.getQuestions().map((q) => `- [${q.id}] (${q.status}) ${q.text}`).join('\n')}

Generate 1-3 new research questions to extend this research. Return JSON:
{"questions": [{"text": "...", "purpose": "evidence", "priority": 1}, ...]}
`.trim();

    const response = await this.llmComplete(prompt);
    const parsed = this.safeParseJSON(response);
    const newQuestions: ResearchQuestion[] = [];

    if (parsed?.questions && Array.isArray(parsed.questions)) {
      for (const q of parsed.questions as Array<{ text: string; purpose?: string; priority: number }>) {
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
    this.transitionTo(OrchestratorPhase.ABORTED);
  }

  // === Phase: Classify ===

  private async classifyQuery(): Promise<void> {
    const prompt = `
Classify this research query along multiple dimensions.

Query: "${this.originalQuery}"

Categories for complexity:
- factual: Simple fact lookup, quick answer expected
- conceptual: Explaining concepts, moderate depth needed
- comparative: Comparing multiple things, need side-by-side sources
- analytical: Deep analysis, multiple perspectives required
- literature_review: Survey of academic literature or field progress
- technical_design: Implementation, architecture, or engineering approach
- unknown: Cannot determine

Freshness requirements:
- stable: Doesn't change (e.g., math concepts, fundamental physics)
- recent: 1-3 year window (e.g., current best practices, recent research)
- latest: Very time-sensitive (e.g., latest releases, breaking news)

Source depth:
- light: 1-2 searches per question
- standard: 2-4 searches per question
- deep: 4+ searches, must include primary sources

Return JSON:
{
  "complexity": "analytical",
  "freshness": "recent",
  "sourceDepth": "deep",
  "riskLevel": "medium",
  "needsTools": ["browser"],
  "reason": "..."
}
`.trim();

    try {
      const response = await this.llmComplete(prompt);
      const parsed = this.safeParseJSON(response);
      const complexity: QueryComplexity = (parsed?.complexity as QueryComplexity) ?? 'unknown';
      const cfg = COMPLEXITY_CONFIG[complexity];

      this.currentClassification = {
        complexity,
        maxIterations: cfg.maxIterations,
        coverageThreshold: cfg.coverageThreshold,
        freshness: (parsed?.freshness as ResearchClassification['freshness']) ?? cfg.freshness,
        sourceDepth: (parsed?.sourceDepth as ResearchClassification['sourceDepth']) ?? cfg.sourceDepth,
        riskLevel: (parsed?.riskLevel as ResearchClassification['riskLevel']) ?? cfg.riskLevel,
        needsCitations: complexity !== 'factual',
        needsTools: Array.isArray(parsed?.needsTools)
          ? (parsed.needsTools as string[])
          : ['browser'],
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
    const prompt = `
Analyze this research query and generate clarification questions. Only ask questions where the answer would fundamentally change the research direction.

Query: "${this.originalQuery}"

Rules:
- Only generate questions for hard blockers (research cannot continue without the answer)
- Do not ask about scope preferences that can be reasonably assumed
- Maximum 2 questions

Return JSON:
{"questions": [{"id": "q1", "question": "...", "type": "single_choice", "options": ["A", "B", "C"]}, ...]}
`.trim();

    try {
      const response = await this.llmComplete(prompt);
      const parsed = this.safeParseJSON(response);
      if (parsed?.questions && Array.isArray(parsed.questions)) {
        return parsed.questions as ClarificationQuestion[];
      }
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
    } else {
      this.addFallbackQuestion();
    }
  }

  private async llmGenerateResearchPlan(): Promise<ResearchPlan | null> {
    const classification = this.currentClassification;
    const userAnswers = this.clarificationAnswers;

    const prompt = `
You are the planning module of a deep research agent.

Your job is NOT to answer the user directly. Your job is to transform the user's query into an executable research plan that another research agent can follow.

Original user query:
"${this.originalQuery}"

${userAnswers && Object.keys(userAnswers).length > 0 ? 'Clarification answers: ' + JSON.stringify(userAnswers) : ''}

Classified complexity: ${classification.complexity}
Max iterations: ${classification.maxIterations}
Freshness requirement: ${classification.freshness}
Source depth: ${classification.sourceDepth}

You must produce a structured research plan with:
1. The user's likely research intent (taskType, userGoal, expectedOutput, audienceLevel)
2. The expected final output type
3. Scope boundaries: what to include, what to exclude, assumptions, and whether clarification is necessary
4. A set of research questions (3-8). Each question must have a purpose, priority, dependencies, search queries, and evidence requirements
5. A source strategy: what types of sources should be trusted most, what sources are weak, and whether primary sources are required
6. A counter-evidence strategy: what claims need verification, what alternative explanations or objections should be checked
7. Quality gates: what must be true before synthesis can begin
8. A synthesis outline for the final answer

Important rules:
- Do NOT create generic sub-questions like "What is X?" unless a definition is genuinely needed
- Prefer task-specific questions that directly reduce uncertainty
- Avoid generic survey questions that could apply to any AI topic
- Every research question must contain topic-specific concepts, candidate entities, or evaluation dimensions
- For every question, state the uncertainty it resolves and what evidence is required to resolve it
- Separate factual lookup questions from analytical interpretation questions
- Include at least one question that searches for limitations, failures, controversies, or counterexamples when the task is analytical, comparative, or conceptual
- If the query requires recent or fast-changing information, set freshnessRequirement as "latest"
- If the query concerns academic research, prioritize peer-reviewed papers, preprints, official datasets, benchmark repositories, and authoritative survey papers
- If the query concerns implementation, include documentation, source code, issue discussions, and changelogs as source types
- If clarification is necessary (hard blocker), set clarificationNeeded=true and add blockingQuestions
- If clarification would be helpful but NOT necessary, add them to nonBlockingSuggestions instead
- Proceed with explicit assumptions when clarification is not essential

Question purposes:
- definition: Define key terms or concepts
- mechanism: Explain how something works
- evidence: Gather factual evidence or data
- comparison: Compare alternatives or approaches
- critique: Find limitations, failures, or counterarguments
- trend: Identify patterns or trajectory over time
- implementation: Technical details, code, architecture
- decision: Information needed to make a decision

Return ONLY valid JSON matching this schema:
{
  "intent": {
    "taskType": "analytical",
    "userGoal": "Summarize the current state and challenges...",
    "expectedOutput": "structured_report",
    "audienceLevel": "expert"
  },
  "scope": {
    "included": ["key topics to cover"],
    "excluded": ["topics to explicitly avoid"],
    "timeRange": "2020-2025",
    "geography": null,
    "domains": ["domain1", "domain2"],
    "assumptions": ["assumptions made"],
    "clarificationNeeded": false,
    "blockingQuestions": [],
    "nonBlockingSuggestions": []
  },
  "researchQuestions": [
    {
      "text": "question text",
      "purpose": "evidence",
      "uncertaintyResolved": "what unknown this question resolves",
      "requiredEvidenceRationale": "why this evidence is required",
      "priority": 1,
      "dependsOn": [],
      "searchQueries": ["specific search query 1", "specific search query 2"],
      "requiredEvidence": {
        "sourceTypes": ["paper", "official"],
        "minSources": 3,
        "needsPrimarySource": true,
        "needsRecentSource": true,
        "needsCounterEvidence": false
      }
    }
  ],
  "evidenceStrategy": {
    "sourceTypes": ["paper", "review", "official", "code"],
    "authorityRules": ["Prefer peer-reviewed journals", "Official docs > blog posts"],
    "freshnessRequirement": "recent",
    "minIndependentSources": 3,
    "mustFindPrimarySources": true,
    "mustFindCounterEvidence": true
  },
  "searchStrategy": {
    "seedQueries": ["seed query 1", "seed query 2"],
    "queryExpansionRules": ["When finding papers, search related papers by same authors"],
    "priorityOrder": ["official docs first", "then papers", "then news"]
  },
  "qualityGates": {
    "coverageThreshold": ${classification.coverageThreshold},
    "requiredFindings": ["finding description 1"],
    "stopConditions": ["All questions have authoritative sources"],
    "failureConditions": ["No peer-reviewed sources found after 3 iterations"]
  },
  "synthesisPlan": {
    "recommendedStructure": ["Executive Summary", "Background", "Key Findings", "Analysis", "Limitations", "References"],
    "comparisonDimensions": ["dim1", "dim2"],
    "expectedCaveats": ["Some data may be preliminary", "Results may be sensitive to methodology"]
  }
}
`.trim();

    try {
      const response = await this.llmComplete(prompt);
      const parsed = this.safeParseJSON(response);

      if (parsed && typeof parsed === 'object') {
        return this.parseResearchPlan(parsed);
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
      researchQuestions,
      evidenceStrategy,
      searchStrategy,
      qualityGates,
      synthesisPlan,
    };
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
    if (!plan || plan.researchQuestions.length === 0) {
      return;
    }

    const requestId = `plan_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    this.emit({
      type: 'planning_complete',
      requestId,
      plan,
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
      this.config.maxIterations = Math.min(this.config.maxIterations + 2, 10);
    }
    if (action === 'decrease_depth') {
      this.config.maxIterations = Math.max(this.config.maxIterations - 1, 1);
    }
  }

  // === Phase: Research Loop ===

  private async executeResearchLoop(): Promise<void> {
    const maxIter = this.config.maxIterations;

    for (let i = 0; i < maxIter; i++) {
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

      // M2.1: 使用 ResearchAction[] 替代 SearchStrategy[]
      const actions = await this.llmSelectResearchActions(activeQs, qualityReport);

      let findingCount = 0;
      if (actions.length > 0) {
        const results = await this.executeResearchActions(actions);

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

      const updatedReport = this.context.calculateQualityReport();

      this.emit({
        type: 'iteration_complete',
        iteration: this.currentIteration,
        findingsCount: findingCount,
        coverage: this.context.calculateQualityCoverage(),
        qualityReport: updatedReport,
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
        await this.replan(updatedReport);
      }
    }
  }

  // === M2.1: Research Action Dispatch ===

  private async executeResearchActions(
    actions: ResearchAction[]
  ): Promise<ResearchActionResult[]> {
    const results: ResearchActionResult[] = [];

    const searchActions = actions.filter((a) => a.type === 'search');
    const sourceCheckActions = actions.filter(
      (a) => a.type === 'source_check' || a.type === 'fetch' || a.type === 'claim_verify'
    );
    const compareActions = actions.filter(
      (a) => a.type === 'compare'
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
      input: { query: a.params.query, queryType: 'en_resources' },
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
          iteration
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
          query: action.params.url,
          queryType: 'source_check',
        });

        const truncated = truncateResult(toolResult.result || '', 4000);
        const prompt = `
Analyze this source for reliability and relevance:

URL: ${action.params.url}
Content excerpt: ${truncated.slice(0, 3000)}

Evaluate:
1. Authority: Is this an official, peer-reviewed, or well-known source?
2. Relevance: Does this relate to the research question?
3. Freshness: Is the information current?
4. Independence: Is this an original source or a re-report?

Return JSON:
{"reliability": "high"|"medium"|"low"|"unverified", "relevance": 0.0-1.0, "summary": "one-line assessment"}
`.trim();

        const response = await this.llmComplete(prompt);
        const parsed = this.safeParseJSON(response);

        const finding: ResearchFinding = {
          id: `f_src_${Date.now()}`,
          questionId: action.targetQuestionId,
          type: 'web',
          claim: (parsed?.summary as string) || `Source check: ${action.params.url}`,
          evidence: '',
          content: (parsed?.summary as string) || '',
          source: 'browser',
          sourceId: action.params.sourceId || `src_${Date.now()}`,
          sourceType: 'blog',
          url: action.params.url,
          accessedAt: new Date().toISOString(),
          sourceReliability: (parsed?.reliability as ResearchFinding['sourceReliability']) || 'unverified',
          authorityLevel: (parsed?.reliability === 'high') ? 'high' : 'medium',
          stance: 'neutral',
          confidence: (parsed?.relevance as number) || 0.5,
          relevance: (parsed?.relevance as number) || 0.5,
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

        const prompt = `
You are performing a comparison analysis for a deep research agent.

Comparison type: ${action.comparisonType}
Goal: ${action.comparisonGoal}

Compare the following sources:
${action.sourceIds.slice(0, 5).map((sid, i) => `Source ${i + 1}: id=${sid}`).join('\n')}

Research context:
${contextText.slice(0, 3000)}

Identify:
1. Common ground across sources
2. Key differences or disagreements
3. Which source is most reliable for each differing point
4. A synthesized interpretation

Return JSON:
{
  "agreement": "agree"|"disagree"|"complement"|"unrelated",
  "commonPoints": ["point 1", "point 2"],
  "differingPoints": [
    {"aspect": "aspect name", "view1": "...", "view2": "...", "verdict": "text1_preferred"|"text2_preferred"|"both_valid"|"needs_clarification"}
  ],
  "synthesis": "synthesized conclusion"
}
`.trim();

        const response = await this.llmComplete(prompt);
        const parsed = this.safeParseJSON(response);

        const cmpId = `cmp_${Date.now()}`;
        const finding: ResearchFinding = {
          id: `f_${cmpId}`,
          questionId: action.targetQuestionId,
          type: 'concept',
          claim: (parsed?.synthesis as string) || `Comparison: ${action.comparisonGoal}`,
          evidence: JSON.stringify(parsed || {}),
          content: (parsed?.synthesis as string) || '',
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

    const prompt = `
You are the research loop controller for a deep research agent.

You are given:
- The original query
- The approved research plan
- Current findings and quality report
- Remaining iteration budget

Your task is to decide the next best research actions. You can choose from multiple action types:

Action types:
- search: Execute a web search query (most common)
- source_check: Evaluate a specific source's reliability, originality, date, author
- claim_verify: Verify whether a claim is supported by other sources
- fetch: Fetch page content for detailed analysis (provides URL)
- compare: Compare multiple sources on a specific dimension
- backtrack: Revisit a previously skipped question
- stop_question: Mark a question as no longer actionable

Rules:
- Do NOT repeat searches that have already produced sufficient evidence
- Prefer actions that reduce the largest uncertainty or unblock synthesis
- If authoritative sources are missing, search for primary sources first
- If only supporting evidence exists, search for counter-evidence or limitations
- If findings conflict, search for adjudicating sources
- Each question needs at least 2 strategies with different approaches
- For analytical/critique questions, always include counter-view searches
- Limit total actions to ${this.config.concurrencyLimit}

Quality Report:
- Score: ${(qualityReport.score * 100).toFixed(0)}%
- Ready: ${qualityReport.readyForSynthesis}
- Blockers: ${qualityReport.blockers.join('; ') || 'none'}
- Next Actions: ${qualityReport.nextActions.join('; ') || 'none'}

Plan:
${plan ? `- Source strategy: ${JSON.stringify(plan.evidenceStrategy)}
- Must find primary sources: ${plan.evidenceStrategy.mustFindPrimarySources}
- Must find counter evidence: ${plan.evidenceStrategy.mustFindCounterEvidence}
- Seed queries: ${plan.searchStrategy.seedQueries.join(', ')}` : 'No plan available'}

Context:
${contextText}

Questions (max ${this.config.concurrencyLimit} actions total):
${questions.map((q) => `- [${q.id}] (${q.purpose}) ${q.text} → searchQueries: ${q.searchQueries.join('; ') || 'none'}`).join('\n')}

Return JSON:
{"actions": [
  {"type": "search", "targetQuestionId": "q0", "params": {"query": "specific search query"}, "priority": 1, "reason": "need official docs", "expectedOutcome": "find official documentation"},
  {"type": "source_check", "targetQuestionId": "q1", "params": {"url": "https://...", "sourceId": "src_xxx"}, "priority": 2, "reason": "verify source quality", "expectedOutcome": "assess reliability"},
  {"type": "compare", "targetQuestionId": "q2", "params": {"compareItems": ["src_a", "src_b"]}, "priority": 2, "reason": "reconcile conflicting sources", "expectedOutcome": "resolve contradiction"}
]}
`.trim();

    try {
      const response = await this.llmComplete(prompt);
      const parsed = this.safeParseJSON(response);

      if (parsed?.actions && Array.isArray(parsed.actions)) {
        return (parsed.actions as Array<{
          type: string;
          targetQuestionId: string;
          params?: { query?: string; url?: string; sourceId?: string; compareItems?: string[] };
          priority?: number;
          reason?: string;
          expectedOutcome?: string;
        }>).map((a, idx) => ({
          id: `action_${Date.now()}_${idx}`,
          type: (['search', 'source_check', 'claim_verify', 'fetch', 'compare', 'backtrack', 'stop_question'].includes(a.type)
            ? a.type
            : 'search') as ResearchActionType,
          targetQuestionId: a.targetQuestionId || '',
          params: a.params || {},
          priority: a.priority || 2,
          reason: a.reason || '',
          expectedOutcome: a.expectedOutcome || '',
        }));
      }
    } catch {
      // fall through
    }

    return questions.slice(0, this.config.concurrencyLimit).map((q, idx) => ({
      id: `action_fb_${Date.now()}_${idx}`,
      type: 'search' as const,
      targetQuestionId: q.id,
      params: { query: q.searchQueries[0] || q.text },
      priority: q.priority,
      reason: `Research: ${q.text.slice(0, 60)}`,
      expectedOutcome: `Evidence for: ${q.text.slice(0, 60)}`,
    }));
  }

  private async llmExtractFindings(
    toolName: string,
    result: string,
    strategies: SearchStrategy[],
    iteration: number,
  ): Promise<ResearchFinding[]> {
    const existingFindings = this.context.getAllFindings().slice(-15);

    const prompt = `
Extract discrete findings from this search result.

Source: ${toolName}

Result:
${result}

Existing findings to avoid duplication:
${existingFindings.map((f) => `- [${f.id}] ${f.content.slice(0, 100)}`).join('\n') || '(none)'}

For each finding extract:
- claim: A concise factual statement (1-2 sentences)
- evidence: The specific supporting data or quote
- content: Same as claim (for compatibility)
- stance: "supports", "contradicts", or "neutral" relative to the research question
- sourceReliability: "high", "medium", "low", or "unverified"
- confidence: 0.0-1.0
- limitations: Any known limitations of this finding

Return JSON:
{"findings": [
  {
    "claim": "...",
    "evidence": "...",
    "stance": "supports",
    "sourceReliability": "high",
    "confidence": 0.9,
    "title": "...",
    "author": "...",
    "publishedAt": "...",
    "limitations": ["limitation 1"]
  },
  ...
]}
`.trim();

    try {
      const response = await this.llmComplete(prompt);
      const parsed = this.safeParseJSON(response);

      if (parsed?.findings && Array.isArray(parsed.findings)) {
        const findings: ResearchFinding[] = [];
        let idx = 0;

        for (const item of parsed.findings as Array<{
          claim: string;
          evidence: string;
          content?: string;
          stance: string;
          sourceReliability: string;
          confidence: number;
          title?: string;
          author?: string;
          publishedAt?: string;
          limitations?: string[];
        }>) {
          if (!item.claim && !item.content) continue;

          const questionIds = strategies.map((s) => s.questionId);
          const queryType = strategies[0]?.queryType ?? 'en_resources';
          const reliability = (item.sourceReliability as ResearchFinding['sourceReliability'])
            || computeSourceReliability(queryType);

          const claimText = item.claim || item.content || '';
          const evidenceText = item.evidence || claimText;

          findings.push({
            id: `f_${Date.now()}_${idx++}`,
            questionId: strategies[0]?.questionId || '',
            type: 'web',
            claim: claimText,
            evidence: evidenceText,
            content: claimText,
            source: toolName,
            sourceId: `src_${Date.now()}_${idx}`,
            sourceType: sourceTypeFromQueryType(queryType),
            title: item.title,
            author: item.author,
            publishedAt: item.publishedAt,
            accessedAt: new Date().toISOString(),
            snippet: claimText.slice(0, 150),
            rawExcerpt: claimText.slice(0, 500),
            sourceReliability: reliability,
            authorityLevel: authorityLevelFromReliability(reliability),
            citationId: `[${idx}]`,
            stance: (item.stance as ResearchFinding['stance']) || 'neutral',
            confidence: Math.min(1, Math.max(0, item.confidence || 0.7)),
            relevance: 0.7,
            relatedQuestionIds: questionIds,
            supports: [],
            contradicts: [],
            limitations: Array.isArray(item.limitations) ? item.limitations as string[] : [],
            extractedEntities: [],
            iteration,
          });
        }

        return findings;
      }
    } catch {
      // fall through
    }

    return [];
  }

  // M2.2: PlanDelta-driven replan with goal_change confirmation
  private async replan(qualityReport: QualityReport): Promise<void> {
    const contextText = this.context.toPromptContext();
    const activeCount = this.context.getActiveQuestions().length;
    const remaining = Math.min(
      Math.max(0, this.config.maxTotalQuestions - activeCount),
      2 // M2.2: max 2 questions per iteration
    );

    if (remaining === 0) return;

    const plan = this.context.getResearchPlan();
    const currentGoal = plan?.intent?.userGoal || this.originalQuery;

    const prompt = `
Review research progress and quality report. You may add up to ${remaining} new sub-questions or obsolete irrelevant ones.
Only add questions that are genuinely needed for completeness, especially to address blockers.
Also classify the nature of changes: are these minor additions, a major new direction, or a goal change?

Research goal: "${currentGoal}"

${contextText}

Quality Report:
- Score: ${(qualityReport.score * 100).toFixed(0)}%
- Ready: ${qualityReport.readyForSynthesis}
- Blockers: ${qualityReport.blockers.join('; ') || 'none'}
- Next Actions: ${qualityReport.nextActions.join('; ') || 'none'}

Return JSON:
{
  "add": [{"text": "...", "purpose": "evidence", "priority": 2}, ...],
  "obsolete": ["q_id1", "q_id2", ...],
  "deltaType": "minor" | "major" | "goal_change",
  "goalChangeReason": "only if deltaType is goal_change: why the goal should change"
}
`.trim();

    try {
      const response = await this.llmComplete(prompt);
      const parsed = this.safeParseJSON(response);

      const deltaType: PlanDeltaType = (parsed?.deltaType as PlanDeltaType) || 'minor';
      const obsoletedIds: string[] = [];
      const newQuestions: ResearchQuestion[] = [];
      let goalChange: PlanDelta['goalChange'] | undefined;

      // Process obsolete questions
      if (parsed?.obsolete && Array.isArray(parsed.obsolete)) {
        const obsoletedQs: ResearchQuestion[] = [];
        for (const qid of parsed.obsolete as string[]) {
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
      if (parsed?.add && Array.isArray(parsed.add)) {
        const addArr = parsed.add as Array<{ text: string; purpose?: string; priority: number }>;
        const limited = addArr.slice(0, 2);
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
        const proposedGoal = (parsed?.goalChangeReason as string) || 'research direction shift';
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
    // 1. 达到最大迭代 → 强制停止
    if (this.currentIteration >= this.config.maxIterations) {
      return {
        shouldStop: true,
        reason: 'max_iterations',
        forced: true,
        unresolvedBlockers: report.criticalBlockers || [],
        qualityScore: report.score,
      };
    }

    // 2. 存在 critical blocker → 不停止
    if (report.criticalBlockers && report.criticalBlockers.length > 0) {
      return {
        shouldStop: false,
        reason: 'no_more_actions',
        forced: false,
        unresolvedBlockers: [],
        qualityScore: report.score,
      };
    }

    // 3. 覆盖度达标 + 必要问题已回答 + readyForSynthesis
    if (report.score >= this.config.coverageThreshold &&
        (report as { requiredQuestionsAnswered?: boolean }).requiredQuestionsAnswered !== false &&
        report.readyForSynthesis) {
      return {
        shouldStop: true,
        reason: 'coverage_threshold_met',
        forced: false,
        unresolvedBlockers: [],
        qualityScore: report.score,
      };
    }

    // 4. 无阻塞 + 可合成
    if (report.blockers.length === 0 && report.readyForSynthesis) {
      return {
        shouldStop: true,
        reason: 'ready_for_synthesis',
        forced: false,
        unresolvedBlockers: [],
        qualityScore: report.score,
      };
    }

    return {
      shouldStop: false,
      reason: 'no_more_actions',
      forced: false,
      unresolvedBlockers: [],
      qualityScore: report.score,
    };
  }

  private get abortController(): AbortController | undefined {
    return undefined;
  }

  // === Phase: Synthesis ===

  private async executeSynthesis(): Promise<void> {
    this.emit({ type: 'synthesis_start' });

    const prompt = this.buildSynthesisPrompt();

    if (this.llmStreamFn) {
      let total = 0;
      try {
        for await (const delta of this.llmStreamFn(
          prompt,
          'You are the synthesis module of a deep research agent. Write using only the collected findings. Do not introduce unsupported facts.',
        )) {
          this.emit({ type: 'synthesis_chunk', delta, total: total + delta.length });
          total += delta.length;
        }
      } catch {
        const fallback = await this.llmComplete(prompt);
        this.emit({ type: 'synthesis_chunk', delta: fallback, total: fallback.length });
      }
    } else {
      const report = await this.llmComplete(prompt);
      this.emit({ type: 'synthesis_chunk', delta: report, total: report.length });
    }

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

    const questionGroups = new Map<string, ResearchFinding[]>();
    for (const f of findings) {
      for (const qid of f.relatedQuestionIds) {
        if (!questionGroups.has(qid)) questionGroups.set(qid, []);
        questionGroups.get(qid)!.push(f);
      }
    }

    const sections: string[] = [];

    for (const q of questions) {
      const related = questionGroups.get(q.id) || [];
      const supports = related.filter((f) => f.stance === 'supports');
      const contradicts = related.filter((f) => f.stance === 'contradicts');
      const neutrals = related.filter((f) => f.stance === 'neutral');

      let section = `## ${q.text} (purpose: ${q.purpose}, status: ${q.status})\n\n`;

      if (supports.length > 0) {
        section += `### Supporting Evidence\n\n`;
        for (const f of supports) {
          section += `- ${f.citationId || ''} [${f.sourceReliability}, authority: ${f.authorityLevel}] ${f.claim}`;
          if (f.evidence && f.evidence !== f.claim) {
            section += `\n  Evidence: ${f.evidence}`;
          }
          if (f.title) section += `\n  Source: ${f.title}`;
          if (f.limitations.length > 0) {
            section += `\n  Limitations: ${f.limitations.join('; ')}`;
          }
          section += '\n';
        }
      }

      if (contradicts.length > 0) {
        section += `\n### Contradicting Evidence\n\n`;
        for (const f of contradicts) {
          section += `- ${f.citationId || ''} [${f.sourceReliability}] ${f.claim}`;
          if (f.title) section += `\n  Source: ${f.title}`;
          section += '\n';
        }
      }

      if (neutrals.length > 0 && supports.length === 0 && contradicts.length === 0) {
        section += `\n### Findings\n\n`;
        for (const f of neutrals) {
          section += `- ${f.citationId || ''} [${f.sourceReliability}] ${f.claim}`;
          if (f.title) section += `\n  Source: ${f.title}`;
          section += '\n';
        }
      }

      sections.push(section);
    }

    const citations = findings.map(
      (f) => `${f.citationId || ''} ${f.title || 'Untitled'} — ${f.url || f.source} (${f.accessedAt.slice(0, 10)}) [${f.sourceReliability}, ${f.authorityLevel}]`
    );

    const structure = plan?.synthesisPlan.recommendedStructure?.join('\n') ||
      `1. Executive Summary\n2. Key Findings (organized by topic)\n3. Analysis & Synthesis\n4. Contested Points\n5. Gaps & Limitations\n6. Practical Implications\n7. References`;

    const caveats = plan?.synthesisPlan.expectedCaveats || [];
    const caveatLines = caveats.length > 0
      ? `\nKnown caveats from planning:\n${caveats.map((c) => `- ${c}`).join('\n')}`
      : '';

    return `Research Query: ${this.originalQuery}

You are the synthesis module of a deep research agent.

Write the final answer using ONLY the approved research plan and collected findings below.
DO NOT introduce unsupported facts.
For each major claim, use the strongest available evidence.
Separate clearly:
- Established facts (well-supported, authoritative)
- Likely interpretations (moderate support)
- Contested points (conflicting sources)
- Open questions (no or weak evidence)
- Practical implications

Rules:
- If evidence is weak, say so explicitly
- If sources conflict, present the conflict and explain which source is more reliable and why
- Do NOT overstate certainty
- Follow the recommended structure unless a better structure is clearly justified
- Cite sources using the citationId in brackets (e.g. [1], [2])
- Note source reliability level and authority when relevant
- Include a dedicated section for limitations and unresolved questions

Quality Assessment:
- Overall score: ${(qualityReport.score * 100).toFixed(0)}%
- Blockers: ${qualityReport.blockers.length > 0 ? qualityReport.blockers.join('; ') : 'none'}${caveatLines}

Recommended structure:
${structure}

Findings:

${sections.join('\n')}

References:
${citations.map((c) => `- ${c}`).join('\n')}
`.trim();
  }

  // === Utilities ===

  private emit(event: ResearchEvent): void {
    this.emitSSE(event);
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

  private safeParseJSON(response: string): Record<string, unknown> | null {
    let cleaned = response.trim();
    cleaned = cleaned.replace(/^```(?:json)?\s*/im, '');
    cleaned = cleaned.replace(/\s*```\s*$/im, '');
    cleaned = cleaned.replace(/\/\/.*$/gm, '');
    cleaned = cleaned.replace(/,(\s*[}\]])/g, '$1');

    try {
      return JSON.parse(cleaned);
    } catch {
      const match = cleaned.match(/\{[\s\S]*\}/);
      if (match) {
        try {
          return JSON.parse(match[0]);
        } catch {
          return null;
        }
      }
      return null;
    }
  }
}
