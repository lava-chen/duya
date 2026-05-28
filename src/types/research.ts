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

export interface ResearchActivityItem {
  id: string;
  title: string;
  detail?: string;
  timestamp: number;
  tone?: 'neutral' | 'success' | 'warning';
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
}
