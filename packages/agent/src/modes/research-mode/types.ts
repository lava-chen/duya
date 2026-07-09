import type { ModeContext, ClarificationQuestion } from '../types.js';
import type { ResearchContext } from './ResearchContext.js';
import type { ToolResult } from '../../tool/types.js';

export enum OrchestratorPhase {
  IDLE = 'idle',
  CLARIFICATION = 'clarification',
  PLANNING = 'planning',
  RESEARCH_LOOP = 'research_loop',
  SYNTHESIS = 'synthesis',
  INTERACTIVE_REPORT = 'interactive_report',
  COMPLETE = 'complete',
  ABORTED = 'aborted',
}

export type QueryComplexity =
  | 'factual'
  | 'conceptual'
  | 'comparative'
  | 'analytical'
  | 'literature_review'
  | 'technical_design'
  | 'unknown';

export interface ResearchClassification {
  complexity: QueryComplexity;
  maxIterations: number;
  coverageThreshold: number;
  freshness: 'stable' | 'recent' | 'latest';
  sourceDepth: 'light' | 'standard' | 'deep';
  riskLevel: 'low' | 'medium' | 'high';
  needsCitations: boolean;
  needsTools: string[];
}

export type SearchQueryType =
  | 'official_doc'
  | 'paper'
  | 'news'
  | 'oss'
  | 'cn_resources'
  | 'en_resources'
  | 'counter_view';

export interface SearchStrategy {
  questionId: string;
  question: string;
  tool: string;
  params: Record<string, unknown>;
  priority: number;
  queryType: SearchQueryType;
}

export type QuestionStatus =
  | 'pending'
  | 'searching'
  | 'partial'
  | 'answered'
  | 'blocked'
  | 'obsolete';

export type QuestionLayer =
  | 'foundational'
  | 'analytical'
  | 'critical'
  | 'synthetic';

export type QuestionPurpose =
  | 'definition'
  | 'mechanism'
  | 'evidence'
  | 'comparison'
  | 'critique'
  | 'trend'
  | 'implementation'
  | 'decision';

export interface RequiredEvidence {
  sourceTypes: string[];
  minSources: number;
  needsPrimarySource: boolean;
  needsRecentSource: boolean;
  needsCounterEvidence: boolean;
}

export interface AnswerQuality {
  hasSource: boolean;
  sourceCount: number;
  hasAuthoritativeSource: boolean;
  hasRecentSource: boolean;
  hasPrimarySource: boolean;
  hasCounterEvidence: boolean;
  hasContradictingSource: boolean;
  confidence: 'low' | 'medium' | 'high';
  gaps: string[];
  minSourcesRequired: number;
  evaluationTimestamp: number;
}

export interface ResearchQuestion {
  id: string;
  text: string;
  purpose: QuestionPurpose;
  questionLayer?: QuestionLayer;
  hypothesisLink?: string;
  priority: 1 | 2 | 3;
  dependsOn: string[];
  searchQueries: string[];
  requiredEvidence: RequiredEvidence;
  answerQuality?: AnswerQuality;
  status: QuestionStatus;
  sources: string[];
  parentId?: string;
}

export interface QuestionCoverageStatus {
  questionId: string;
  questionLayer: QuestionLayer;
  status: 'pending' | 'partial' | 'covered' | 'saturated' | 'blocked';
  anchorFindings: string[];
  coverageScore: number;
  blockedReason?: string;
}

export interface HypothesisStatus {
  statement: string;
  verdict: 'unexamined' | 'supported' | 'refuted' | 'inconclusive' | 'partially-supported';
  supportingFindings: string[];
  contradictingFindings: string[];
  confidenceLevel: 'high' | 'medium' | 'low' | 'insufficient-evidence';
}

export interface EvidenceConflict {
  topic: string;
  positionA: string;
  positionB: string;
  findingIds: string[];
  resolved: boolean;
  resolution?: string;
}

export interface ResearchState {
  iteration: number;
  questionCoverage: QuestionCoverageStatus[];
  hypothesisStatuses: HypothesisStatus[];
  conflicts: EvidenceConflict[];
  gapFindings: string[];
  saturationSignals: string[];
  overallCoverageScore: number;
}

export interface FindingContradiction {
  contradictingFindingId: string;
  description: string;
  recommendedResolution: 'needs_further_research' | 'source_preferred' | 'context_dependent' | 'irreconcilable';
}

export interface ResearchFinding {
  id: string;
  questionId: string;
  type: 'web' | 'code' | 'doc' | 'concept';
  claim: string;
  evidence: string;
  content: string;
  source: string;
  sourceId: string;
  sourceType: SourceType;
  url?: string;
  title?: string;
  author?: string;
  publishedAt?: string;
  accessedAt: string;
  snippet?: string;
  rawExcerpt?: string;
  sourceReliability: 'high' | 'medium' | 'low' | 'unverified';
  authorityLevel: 'high' | 'medium' | 'low';
  citationId?: string;
  stance: 'supports' | 'contradicts' | 'neutral';
  confidence: number;
  relevance: number;
  relatedQuestionIds: string[];
  supports: string[];
  contradicts: string[];
  limitations: string[];
  extractedEntities: string[];
  iteration: number;
  contradictions?: FindingContradiction[];

  // --- M1.2: Schema Extensions ---
  locator?: SourceLocator;
  quotedEvidence?: string;
  claimKey?: string;           // 语义级冲突检测键（需 normalize）
  claimQuestionId?: string;   // claimKey 的作用域（避免跨问题误合并）
  doi?: string;
  arxivId?: string;
  canonicalUrl?: string;

  // --- v2: Structured binding ---
  evidenceType?: 'empirical' | 'theoretical' | 'anecdotal' | 'expert-opinion';
  replicationStatus?: 'replicated' | 'single-study' | 'preprint-only' | 'unknown';
  conflictsWith?: string[];
  hypothesisLink?: string;
}

export interface ResearchEntity {
  name: string;
  normalizedName: string;
  aliases: string[];
  occurrences: number;
}

export interface ResearchStateSummary {
  questionCount: number;
  findingCount: number;
  coverage: number;
  entities: string[];
}

export interface CoverageScore {
  questionCoverage: number;
  evidenceCoverage: number;
  sourceAuthority: number;
  sourceDiversity: number;
  recencyCoverage: number;
  counterEvidenceCoverage: number;
  synthesisReadiness: number;
}

export interface QualityReport {
  score: number;
  readyForSynthesis: boolean;
  blockers: string[];
  criticalBlockers: string[];         // M1.2: 关键阻塞项
  nextActions: string[];
  dimensions: CoverageScore;
  requiredQuestionsAnswered: boolean; // M1.2: 必要问题是否已回答
}

// M1.3: 停止决策
export interface StopDecision {
  shouldStop: boolean;
  reason: 'max_iterations' | 'ready_for_synthesis' | 'coverage_threshold_met' | 'no_more_actions' | 'user_cancelled' | 'critical_blockers_exist' | 'blockers_remain' | 'insufficient_coverage';
  forced: boolean;                     // 是否被预算强制停止
  unresolvedBlockers: string[];        // 未解决的阻塞项（报告用）
  qualityScore: number;
}

export interface ResearchIntent {
  taskType: 'factual' | 'conceptual' | 'comparative' | 'analytical' | 'literature_review' | 'technical_design' | 'decision_support';
  userGoal: string;
  expectedOutput: 'brief_answer' | 'structured_report' | 'literature_map' | 'implementation_plan' | 'comparison_table' | 'reading_list';
  audienceLevel: 'beginner' | 'intermediate' | 'expert';
}

export interface ResearchScope {
  included: string[];
  excluded: string[];
  timeRange?: string;
  geography?: string;
  domains: string[];
  assumptions: string[];
  clarificationNeeded: boolean;
  blockingQuestions: string[];
  nonBlockingSuggestions: string[];
}

// ============================================================================
// Core Data Models
// ============================================================================

export type SourceType = 'official' | 'paper' | 'review' | 'dataset' | 'code' | 'news' | 'blog' | 'forum' | 'book';

export interface SourceLocator {
  page?: number;
  section?: string;
  paragraph?: number;
  line?: number;
  url?: string;
}

export interface SourceQuality {
  authority: number;      // 0-1: 权威性
  relevance: number;      // 0-1: 与研究目标相关性
  freshness: number;       // 0-1: 时效性
  independence: number;   // 0-1: 独立性
  primaryness: number;    // 0-1: 是否为第一手来源
  citationValue: number;  // 0-1: 引用价值
}

export interface ResearchSource {
  id: string;
  title: string;
  url?: string;
  canonicalUrl?: string;
  sourceType: SourceType;
  authors?: string[];
  publishedAt?: string;
  accessedAt: string;
  doi?: string;
  arxivId?: string;
  reliability?: SourceQuality;
  rawMetadata?: Record<string, unknown>;
}

export interface EvidenceStrategy {
  sourceTypes: SourceType[];
  authorityRules: string[];
  freshnessRequirement: 'stable' | 'recent' | 'latest';
  minIndependentSources: number;
  mustFindPrimarySources: boolean;
  mustFindCounterEvidence: boolean;
}

export interface ResearchSearchStrategy {
  seedQueries: string[];
  queryExpansionRules: string[];
  priorityOrder: string[];
}

export interface QualityGates {
  coverageThreshold: number;
  requiredFindings: string[];
  stopConditions: string[];
  failureConditions: string[];
}

export interface SynthesisPlan {
  recommendedStructure: string[];
  comparisonDimensions?: string[];
  expectedCaveats: string[];
}

export interface Hypothesis {
  statement: string;
  type: 'central' | 'subsidiary' | 'null';
  verificationApproach: string;
  expectedEvidence: string;
  falsificationCriteria: string;
}

export interface ResearchPlan {
  intent: ResearchIntent;
  scope: ResearchScope;
  hypotheses?: Hypothesis[];
  researchQuestions: ResearchQuestion[];
  evidenceStrategy: EvidenceStrategy;
  searchStrategy: ResearchSearchStrategy;
  qualityGates: QualityGates;
  synthesisPlan: SynthesisPlan;
}

export interface IterationAction {
  type: 'search' | 'fetch' | 'analyze' | 'compare' | 'stop';
  query: string;
  reason: string;
  expectedEvidence: string;
  priority: number;
}

export interface IterationPlan {
  iterationGoal: string;
  targetQuestions: string[];
  actions: IterationAction[];
  stopReason: string | null;
}

export type PlanApprovalAction =
  | 'start'
  | 'edit_scope'
  | 'add_question'
  | 'remove_question'
  | 'increase_depth'
  | 'decrease_depth'
  | 'change_sources'
  | 'cancel';

export interface OrchestratorConfig {
  maxIterations?: number;
  concurrencyLimit?: number;
  coverageThreshold?: number;
  requireClarification?: boolean;
  maxClarificationQuestions?: number;
  maxQuestionsPerIteration?: number;
  maxTotalQuestions?: number;

  // M1.1: 动态问题排序权重
  questionRankingWeights?: {
    missingPrimarySource?: number;    // 默认 30
    missingCounterEvidence?: number;  // 默认 25
    blockingStatus?: number;          // 默认 20
    sourceGap?: number;              // 默认 5
    alreadyAnswered?: number;         // 默认 -40
    dependencyUnsatisfied?: number;  // 默认 -50
    staleness?: number;               // 默认 2
  };

  // M1.5: 并发控制
  maxToolCallsPerIteration?: number;     // 默认 8
  maxSearchResultsPerQuery?: number;    // 默认 10
  enableUrlDeduplication?: boolean;      // 默认 true
  enableQueryDeduplication?: boolean;    // 默认 true
}

export interface ToolSpec {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

export interface ToolCallRequest {
  name: string;
  input: Record<string, unknown>;
}

export interface ToolCallResult {
  name: string;
  content: string;
  error?: boolean;
}

export interface AgentCallInput {
  systemPrompt: string;
  userPrompt: string;
  tools: ToolSpec[];
  maxToolCalls: number;
  toolExecute?: (name: string, input: Record<string, unknown>) => Promise<ToolResult>;
}

export interface OrchestratorDependencies {
  config?: Partial<OrchestratorConfig>;
  sessionId?: string;
  abortSignal?: AbortSignal;
  // C1: signal parameter allows Orchestrator to propagate abort to LLM calls
  llmComplete: (prompt: string, systemPrompt?: string, signal?: AbortSignal) => Promise<string>;
  llmStreamFn?: (prompt: string, systemPrompt?: string, signal?: AbortSignal) => AsyncIterable<string>;
  llmAgentCall?: (input: AgentCallInput, signal?: AbortSignal) => Promise<{ content: string; toolCalls: ToolCallResult[] }>;
  toolExecute: (name: string, input: Record<string, unknown>) => Promise<ToolResult>;
  toolExecuteConcurrent: (
    calls: Array<{ name: string; input: Record<string, unknown> }>
  ) => AsyncGenerator<ToolResult>;
  emitSSE: (event: ResearchEvent) => void;
  awaitClarification: (questions: ClarificationQuestion[], requestId: string) => Promise<Record<string, string>>;
  persistState?: (contextJSON: string) => Promise<void>;
  runDB?: ResearchRunDB;
  traceEvidence?: (conclusion: string, context: ResearchContext) => Promise<EvidenceChain>;
  compareTexts?: (text1: string, text2: string, context: ResearchContext) => Promise<DiffAnalysis>;
  exportReport?: (format: 'markdown' | 'pdf' | 'obsidian', content: string) => Promise<ExportResult>;
  generateShareLink?: (sessionId: string, expiresIn?: number) => Promise<ShareLink>;
  continueResearch?: (additionalQuery: string, context: ResearchContext) => Promise<ContinueResearchResult>;
}

export interface ResearchRunDB {
  runId: string;
  updateRun: (data: {
    run_status?: string;
    title?: string;
    current_phase?: string;
    active_step_id?: string | null;
    progress_summary?: string | null;
    error_json?: string | null;
    completed_at?: number | null;
  }) => Promise<void>;
  createPlanSteps: (steps: Array<{
    id: string;
    order_num: number;
    user_facing_label: string;
    internal_question_ids: string[];
  }>) => Promise<void>;
  updatePlanStep: (stepId: string, data: {
    status?: 'pending' | 'active' | 'completed' | 'skipped' | 'failed';
    started_at?: number | null;
    completed_at?: number | null;
  }) => Promise<void>;
  logActivity: (activity: {
    kind: string;
    title: string;
    detail?: string;
    visibility?: 'user' | 'debug';
    sources?: Array<{ url: string; title: string }>;
  }) => Promise<void>;
  getEventMaxSequence?: () => Promise<number>;
  logEvent?: (event: {
    sequence: number;
    event_type: string;
    payload_json: string;
    visibility?: 'user' | 'debug';
  }) => Promise<void>;
  upsertSource?: (source: {
    id: string;
    title: string;
    url?: string | null;
    canonical_url?: string | null;
    source_type?: string;
    allowed_by_policy?: boolean;
    reliability_json?: string | null;
    dedupe_key?: string | null;
    rejected_reason?: string | null;
    metadata_json?: string | null;
  }) => Promise<void>;
  createCitation?: (citation: {
    id: string;
    report_id?: string | null;
    source_id: string;
    finding_id?: string | null;
    claim: string;
    locator_json?: string | null;
    quoted_evidence?: string | null;
  }) => Promise<void>;
  upsertReport?: (report: {
    id: string;
    title?: string | null;
    markdown: string;
    outline_json?: string | null;
    source_ids_json?: string;
    citation_ids_json?: string;
    activity_summary_json?: string | null;
    export_metadata_json?: string | null;
  }) => Promise<void>;
}

export interface EvidenceChain {
  conclusion: string;
  evidenceNodes: EvidenceNode[];
  confidence: number;
  reasoning: string;
}

export interface EvidenceNode {
  id: string;
  type: 'finding' | 'question' | 'inference';
  content: string;
  source?: string;
  supports: boolean;
  depth: number;
  children?: EvidenceNode[];
}

export interface DiffAnalysis {
  text1: string;
  text2: string;
  agreement: 'agree' | 'disagree' | 'complement' | 'unrelated';
  commonPoints: string[];
  differingPoints: DiffPoint[];
  synthesis?: string;
}

export interface DiffPoint {
  aspect: string;
  view1: string;
  view2: string;
  verdict: 'text1_preferred' | 'text2_preferred' | 'both_valid' | 'needs_clarification';
}

export interface ExportResult {
  format: 'markdown' | 'pdf' | 'obsidian';
  filename: string;
  content: string;
  size: number;
  url?: string;
}

export interface ShareLink {
  url: string;
  token: string;
  expiresAt: number;
  createdAt: number;
}

export interface ContinueResearchResult {
  addedQuestions: ResearchQuestion[];
  coverageBefore: number;
  coverageAfter: number;
  skippedQuestions: string[];
}

// M2.1: 研究动作类型
export type ResearchActionType =
  | 'search'
  | 'source_check'
  | 'claim_verify'
  | 'fetch'
  | 'compare'
  | 'backtrack'
  | 'stop_question'
  | 'conflict_resolve'
  | 'gap_probe'
  | 'replan'
  | 'terminate';

// M1.6: 研究动作结果
export interface ResearchAction {
  id: string;
  type: ResearchActionType;
  targetQuestionId: string;
  params: {
    query?: string;
    url?: string;
    sourceId?: string;
    compareItems?: string[];
  };
  priority: number;
  reason: string;
  expectedOutcome: string;
}

// M2.1: 比较动作
export interface CompareAction {
  type: 'compare';
  targetQuestionId: string;
  comparisonType: 'definition' | 'method' | 'benchmark' | 'claim' | 'timeline' | 'route';
  sourceIds: string[];
  comparisonGoal: string;
  priority: number;
  reason: string;
}

export interface ResearchActionResult {
  actionId: string;
  action: ResearchAction;
  status: 'success' | 'partial' | 'failed' | 'timeout' | 'skipped';
  findings?: ResearchFinding[];
  error?: string;
  retryable: boolean;
  attempts: number;
}

// M2.2: Plan Delta
export type PlanDeltaType = 'minor' | 'major' | 'goal_change';

export interface PlanDelta {
  type: PlanDeltaType;
  addedQuestions: ResearchQuestion[];
  obsoletedQuestions: string[];
  goalChange?: {
    from: string;
    to: string;
    requiresConfirmation: boolean;
  };
}

// M2.3: Event Layering
// User-facing events: frontend MUST display these
// Internal events: debug panel only

export type ResearchEvent =
  // === User-facing ===
  | { type: 'phase_change'; from: OrchestratorPhase; to: OrchestratorPhase }
  | { type: 'clarification_questions'; requestId: string; questions: ClarificationQuestion[]; isHardBlock: boolean }
  | { type: 'clarification_answers_received'; answers: Record<string, string> }
  | { type: 'planning_start' }
  | {
      type: 'planning_complete';
      requestId: string;
      plan: ResearchPlan;
      approvalRequired: boolean;
      complexity?: QueryComplexity;
      maxIterations?: number;
    }
  | { type: 'complexity_classified'; classification: ResearchClassification }
  | { type: 'iteration_start'; iteration: number; maxIterations: number; questions: string[] }
  | { type: 'iteration_complete'; iteration: number; maxIterations: number; findingsCount: number; coverage: number; qualityReport: QualityReport }
  | { type: 'early_stop'; reason: string; coverage: number; iteration: number; maxIterations: number; qualityReport: QualityReport }
  | { type: 'questions_added'; questions: ResearchQuestion[] }
  | { type: 'questions_obsoleted'; questions: ResearchQuestion[] }
  | { type: 'finding_added'; finding: ResearchFinding }
  | { type: 'research_source_found'; url: string; title: string; sourceType: string; reason: string }
  | { type: 'research_source_rejected'; url: string; reason: string }
  | { type: 'research_gap_detected'; gaps: string[]; nextActions: string[]; questionId?: string }
  | { type: 'research_next_action'; action: string; reason: string; targetQuestionId?: string }
  | { type: 'research_conflict_detected'; findingId1: string; findingId2: string; description: string }
  | { type: 'synthesis_start' }
  | { type: 'synthesis_chunk'; delta: string; total: number }
  | { type: 'complete'; summary: string; iterations: number; coverage: number; findingsCount: number }
  | { type: 'report_complete'; reportId: string; content: string; contextSnapshot: ResearchStateSummary }
  | { type: 'evidence_chain_response'; requestId: string; chain: EvidenceChain }
  | { type: 'continue_research_start'; addedQuestions: ResearchQuestion[]; coverageBefore: number }
  | { type: 'error'; message: string }
  | { type: 'research_warning'; message: string; consecutiveErrors: number; recoverable: boolean }
  | { type: 'research_stop_decision'; decision: StopDecision }
  | { type: 'research_goal_change_request'; requestId: string; currentGoal: string; proposedGoal: string; changeType: PlanDeltaType }
  // === v2: Run status & activity ===
  | { type: 'run_status'; status: string; phase: OrchestratorPhase }
  | { type: 'activity'; kind: string; title: string; detail?: string; sequence: number; sources?: Array<{ url: string; title: string }> }
  | { type: 'plan_steps_created'; steps: Array<{ id: string; order: number; label: string }> }
  // === Internal (debug panel) ===
  | { type: 'research_quality_snapshot'; qualityReport: QualityReport }
  | { type: 'plan_delta'; data: PlanDelta }
  | { type: 'query_deduplicated'; original: string; duplicateOf: string }
  | { type: 'finding_deduplicated'; findingId: string; reason: string }
  | { type: 'action_executed'; result: ResearchActionResult };
