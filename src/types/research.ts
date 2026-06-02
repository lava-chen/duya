export type ResearchPanelStage =
  | 'idle'
  | 'planning'
  | 'awaiting_plan_approval'
  | 'clarifying'
  | 'researching'
  | 'synthesizing'
  | 'complete'
  | 'error'
  | 'aborted';

export type ResearchRunStatus =
  | 'classifying'
  | 'planning'
  | 'awaiting_clarification'
  | 'awaiting_approval'
  | 'running'
  | 'paused'
  | 'synthesizing'
  | 'completed'
  | 'failed'
  | 'aborted';

export interface ResearchPlanStep {
  id: string;
  order: number;
  label: string;
  status: 'pending' | 'active' | 'completed' | 'skipped' | 'failed';
  startedAt: number | null;
  completedAt: number | null;
}

export interface ResearchPanelQuestion {
  id: string;
  text: string;
  status: 'pending' | 'active' | 'done' | 'obsolete';
  purpose?: string;
  priority?: 1 | 2 | 3;
  dependsOn?: string[];
  requiredEvidence?: {
    sourceTypes: string[];
    minSources: number;
    needsPrimarySource: boolean;
    needsRecentSource: boolean;
    needsCounterEvidence: boolean;
  };
}

export interface ResearchPanelFinding {
  id: string;
  content: string;
  source: string;
  sourceReliability: string;
  stance: string;
  confidence: number;
  citationId?: string;
  title?: string;
  url?: string;
  iteration: number;
  relatedQuestionIds: string[];
}

export type ResearchActivityKind =
  | 'search'
  | 'browse'
  | 'source_found'
  | 'finding'
  | 'question_answered'
  | 'milestone'
  | 'phase'
  | 'synthesis'
  | 'error';

export type ResearchActivityIconType =
  | 'search'
  | 'globe'
  | 'file-text'
  | 'check'
  | 'link'
  | 'brain'
  | 'download'
  | 'alert';

export interface ResearchActivitySource {
  url: string;
  title: string;
}

export interface ResearchActivityItem {
  id: string;
  title: string;
  detail?: string;
  timestamp: number;
  tone?: 'neutral' | 'success' | 'warning';
  kind: ResearchActivityKind;
  iconType?: ResearchActivityIconType;
  sources?: ResearchActivitySource[];
}

export interface ResearchPersistedEvent {
  id: string;
  sequence: number;
  event_type: string;
  payload_json: string;
  visibility: 'user' | 'debug';
  created_at: number;
}

export interface ResearchPersistedSource {
  id: string;
  title: string;
  url: string | null;
  canonical_url: string | null;
  source_type: string;
  allowed_by_policy: number;
  reliability_json: string | null;
  rejected_reason: string | null;
}

export interface ResearchPersistedCitation {
  id: string;
  report_id: string | null;
  source_id: string;
  finding_id: string | null;
  claim: string;
  locator_json: string | null;
  quoted_evidence: string | null;
}

export interface ResearchReportArtifact {
  id: string;
  title: string | null;
  markdown: string;
  outline_json: string | null;
  source_ids_json: string;
  citation_ids_json: string;
  export_metadata_json: string | null;
  updated_at: number;
}

export interface ResearchPendingRequest {
  kind: 'clarification' | 'plan_approval';
  requestId: string;
  questions: Array<{
    id: string;
    text: string;
    type: 'text' | 'choice';
    required: boolean;
    options?: string[];
  }>;
  allowSkip: boolean;
}

export interface ResearchPlanIntent {
  taskType: 'factual' | 'conceptual' | 'comparative' | 'analytical' | 'literature_review' | 'technical_design' | 'decision_support';
  userGoal: string;
  expectedOutput: 'brief_answer' | 'structured_report' | 'literature_map' | 'implementation_plan' | 'comparison_table' | 'reading_list';
  audienceLevel: 'beginner' | 'intermediate' | 'expert';
}

export interface ResearchPlanScope {
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

export interface ResearchPlanEvidenceStrategy {
  sourceTypes: Array<'official' | 'paper' | 'review' | 'dataset' | 'code' | 'news' | 'blog' | 'forum' | 'book'>;
  authorityRules: string[];
  freshnessRequirement: 'stable' | 'recent' | 'latest';
  minIndependentSources: number;
  mustFindPrimarySources: boolean;
  mustFindCounterEvidence: boolean;
}

export interface ResearchPlanSearchStrategy {
  seedQueries: string[];
  queryExpansionRules: string[];
  priorityOrder: string[];
}

export interface ResearchPlanQualityGates {
  coverageThreshold: number;
  requiredFindings: string[];
  stopConditions: string[];
  failureConditions: string[];
}

export interface ResearchPlanSynthesisPlan {
  recommendedStructure: string[];
  comparisonDimensions?: string[];
  expectedCaveats: string[];
}

export interface ResearchPlanQuestion {
  id: string;
  text: string;
  purpose: string;
  priority: 1 | 2 | 3;
  dependsOn: string[];
  searchQueries: string[];
  requiredEvidence: {
    sourceTypes: string[];
    minSources: number;
    needsPrimarySource: boolean;
    needsRecentSource: boolean;
    needsCounterEvidence: boolean;
  };
}

export interface ResearchPlanDetail {
  intent: ResearchPlanIntent;
  scope: ResearchPlanScope;
  researchQuestions: ResearchPlanQuestion[];
  evidenceStrategy: ResearchPlanEvidenceStrategy;
  searchStrategy: ResearchPlanSearchStrategy;
  qualityGates: ResearchPlanQualityGates;
  synthesisPlan: ResearchPlanSynthesisPlan;
}

export interface ResearchSessionSnapshot {
  sessionId: string;
  mode: 'research' | null;
  active: boolean;
  stage: ResearchPanelStage;
  originalQuery: string;
  complexity?: string;
  complexityDescription?: string;
  phase?: string;
  maxIterations: number;
  currentIteration: number;
  coverage: number;
  findingsCount: number;
  questionCount: number;
  planQuestions: ResearchPanelQuestion[];
  plan: ResearchPlanDetail | null;
  findings: ResearchPanelFinding[];
  reportText: string;
  summary?: string;
  error?: string | null;
  pendingRequest: ResearchPendingRequest | null;
  activities: ResearchActivityItem[];
  startedAt: number | null;
  completedAt: number | null;
  // v2 fields
  runId: string | null;
  runStatus: ResearchRunStatus | null;
  planSteps: ResearchPlanStep[];
  progressSummary: string | null;
  visitedPagesCount: number;
  persistedEvents: ResearchPersistedEvent[];
  persistedSources: ResearchPersistedSource[];
  persistedCitations: ResearchPersistedCitation[];
  reportArtifact: ResearchReportArtifact | null;
}
