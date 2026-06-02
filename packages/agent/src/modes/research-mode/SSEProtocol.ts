import type {
  ResearchEvent,
  ResearchQuestion,
  ResearchFinding,
  EvidenceChain,
  OrchestratorPhase,
  QueryComplexity,
  QualityReport,
  ResearchPlan,
  CoverageScore,
} from './types.js';

export interface ResearchPhaseEvent {
  from: OrchestratorPhase;
  to: OrchestratorPhase;
  timestamp: number;
}

export interface ResearchQuestionsEvent {
  kind: 'clarification' | 'plan_approval' | 'update';
  questions: Array<{
    id: string;
    text: string;
    type: 'text' | 'choice';
    required: boolean;
    options?: string[];
  }>;
  allowSkip: boolean;
  timestamp: number;
  requestId?: string;
  changeType?: 'added' | 'obsoleted';
  complexity?: string;
  maxIterations?: number;
  approvalRequired?: boolean;
  plan?: ResearchPlan;
  isHardBlock?: boolean;
}

export interface ResearchIterationEvent {
  iteration: number;
  maxIterations: number;
  phase: 'start' | 'complete' | 'early_stop';
  questions: string[];
  findingsCount: number;
  coverage: number;
  timestamp: number;
  qualityReport?: QualityReport;
}

export interface ResearchFindingEvent {
  finding: {
    id: string;
    type: string;
    claim: string;
    content: string;
    source: string;
    sourceReliability: string;
    authorityLevel: string;
    stance: string;
    confidence: number;
    citationId?: string;
    title?: string;
    url?: string;
    iteration: number;
    relatedQuestionIds: string[];
    limitations: string[];
  };
  timestamp: number;
}

export interface ResearchProgressEvent {
  phase: OrchestratorPhase;
  iteration: number;
  maxIterations: number;
  coverage: number;
  findingsCount: number;
  questionCount: number;
  timestamp: number;
}

export interface ResearchSynthesisChunkEvent {
  delta: string;
  total: number;
  timestamp: number;
}

export interface ResearchCompleteEvent {
  summary: string;
  iterations: number;
  coverage: number;
  findingsCount: number;
  timestamp: number;
}

export interface ResearchErrorEvent {
  message: string;
  timestamp: number;
}

export interface ResearchComplexityEvent {
  complexity: QueryComplexity;
  maxIterations: number;
  freshness: string;
  sourceDepth: string;
  riskLevel: string;
  description: string;
  timestamp: number;
}

export interface ResearchInteractiveReportEvent {
  type: 'report_complete';
  reportId: string;
  content: string;
  contextSnapshot: {
    questionCount: number;
    findingCount: number;
    coverage: number;
    entities: string[];
  };
  availableActions: ('evidence' | 'continue')[];
  timestamp: number;
}

export interface ResearchEvidenceChainEvent {
  type: 'evidence_chain_response';
  requestId: string;
  conclusion: string;
  chain: EvidenceChain;
  timestamp: number;
}

export interface ResearchContinueEvent {
  type: 'continue_research_start';
  addedQuestions: ResearchQuestion[];
  coverageBefore: number;
  timestamp: number;
}

export interface ResearchSourceFoundEvent {
  url: string;
  title: string;
  sourceType: string;
  reason: string;
  timestamp: number;
}

export interface ResearchSourceRejectedEvent {
  url: string;
  reason: string;
  timestamp: number;
}

export interface ResearchGapDetectedEvent {
  gaps: string[];
  nextActions: string[];
  questionId?: string;
  timestamp: number;
}

export interface ResearchNextActionEvent {
  action: string;
  reason: string;
  targetQuestionId?: string;
  timestamp: number;
}

export interface ResearchConflictDetectedEvent {
  findingId1: string;
  findingId2: string;
  description: string;
  timestamp: number;
}

export interface ResearchQualitySnapshotEvent {
  qualityReport: QualityReport;
  timestamp: number;
}

// M1.3: 停止决策事件
export interface ResearchStopDecisionEvent {
  decision: {
    shouldStop: boolean;
    reason: string;
    forced: boolean;
    unresolvedBlockers: string[];
    qualityScore: number;
  };
  timestamp: number;
}

// M2.2: Plan Delta 事件
export interface PlanDeltaEvent {
  data: {
    type: 'minor' | 'major' | 'goal_change';
    addedQuestionsCount: number;
    obsoletedQuestionsCount: number;
    goalChange?: {
      from: string;
      to: string;
      requiresConfirmation: boolean;
    };
  };
  timestamp: number;
}

// M1.5: 查询去重事件
export interface QueryDeduplicatedEvent {
  original: string;
  duplicateOf: string;
  timestamp: number;
}

// M1.5: 发现去重事件
export interface FindingDeduplicatedEvent {
  findingId: string;
  reason: string;
  timestamp: number;
}

// M1.6: 动作执行结果事件
export interface ActionExecutedEvent {
  result: {
    actionId: string;
    actionType: string;
    status: string;
    error?: string;
    retryable: boolean;
    attempts: number;
  };
  timestamp: number;
}

// v2: Run status event
export interface ResearchRunStatusEvent {
  runStatus: string;
  phase: string;
  timestamp: number;
}

export interface ResearchActivitySource {
  url: string;
  title: string;
}

// v2: Activity log event
export interface ResearchActivityEvent {
  activityId: string;
  kind: string;
  title: string;
  detail?: string;
  sequence: number;
  timestamp: number;
  sources?: ResearchActivitySource[];
}

// v2: Plan steps event
export interface ResearchPlanStepsEvent {
  steps: Array<{
    id: string;
    order: number;
    label: string;
  }>;
  timestamp: number;
}

export type ResearchSSEEvent =
  | { type: 'research_phase'; data: ResearchPhaseEvent }
  | { type: 'research_questions'; data: ResearchQuestionsEvent }
  | { type: 'research_iteration'; data: ResearchIterationEvent }
  | { type: 'research_finding'; data: ResearchFindingEvent }
  | { type: 'research_progress'; data: ResearchProgressEvent }
  | { type: 'research_synthesis_chunk'; data: ResearchSynthesisChunkEvent }
  | { type: 'research_complete'; data: ResearchCompleteEvent }
  | { type: 'research_error'; data: ResearchErrorEvent }
  | { type: 'research_complexity'; data: ResearchComplexityEvent }
  | { type: 'research_source_found'; data: ResearchSourceFoundEvent }
  | { type: 'research_source_rejected'; data: ResearchSourceRejectedEvent }
  | { type: 'research_gap_detected'; data: ResearchGapDetectedEvent }
  | { type: 'research_next_action'; data: ResearchNextActionEvent }
  | { type: 'research_conflict_detected'; data: ResearchConflictDetectedEvent }
  | { type: 'research_quality_snapshot'; data: ResearchQualitySnapshotEvent }
  // M1.3: 新增事件
  | { type: 'research_stop_decision'; data: ResearchStopDecisionEvent }
  | { type: 'plan_delta'; data: PlanDeltaEvent }
  | { type: 'query_deduplicated'; data: QueryDeduplicatedEvent }
  | { type: 'finding_deduplicated'; data: FindingDeduplicatedEvent }
  | { type: 'action_executed'; data: ActionExecutedEvent }
  // v2 events
  | { type: 'research_run_status'; data: ResearchRunStatusEvent }
  | { type: 'research_activity'; data: ResearchActivityEvent }
  | { type: 'research_plan_steps'; data: ResearchPlanStepsEvent };

export type ExtendedResearchSSEEvent =
  | ResearchSSEEvent
  | ResearchInteractiveReportEvent
  | ResearchEvidenceChainEvent
  | ResearchContinueEvent;

export function convertToSSEEvent(event: ResearchEvent): ExtendedResearchSSEEvent | null {
  const timestamp = Date.now();

  switch (event.type) {
    case 'phase_change':
      return {
        type: 'research_phase',
        data: {
          from: event.from,
          to: event.to,
          timestamp,
        },
      };

    case 'clarification_questions':
      return {
        type: 'research_questions',
        data: {
          kind: 'clarification',
          questions: event.questions.map((q) => ({
            id: q.id,
            text: q.question,
            type: 'text' as const,
            required: true,
          })),
          allowSkip: !event.isHardBlock,
          timestamp,
          requestId: event.requestId,
          isHardBlock: event.isHardBlock,
        },
      };

    case 'clarification_answers_received':
      return null;

    case 'planning_start':
      return {
        type: 'research_progress',
        data: {
          phase: 'planning' as OrchestratorPhase,
          iteration: 0,
          maxIterations: 0,
          coverage: 0,
          findingsCount: 0,
          questionCount: 0,
          timestamp,
        },
      };

    case 'planning_complete':
      return {
        type: 'research_questions',
        data: {
          kind: 'plan_approval',
          questions: event.plan.researchQuestions.map((question) => ({
            id: question.id,
            text: question.text,
            type: 'text' as const,
            required: false,
          })),
          allowSkip: false,
          timestamp,
          requestId: event.requestId,
          complexity: event.complexity,
          maxIterations: event.maxIterations,
          approvalRequired: event.approvalRequired,
          plan: event.plan,
        },
      };

    case 'complexity_classified':
      return {
        type: 'research_complexity',
        data: {
          complexity: event.classification.complexity,
          maxIterations: event.classification.maxIterations,
          freshness: event.classification.freshness,
          sourceDepth: event.classification.sourceDepth,
          riskLevel: event.classification.riskLevel,
          description: COMPLEXITY_LABELS[event.classification.complexity] || 'Unknown',
          timestamp,
        },
      };

    case 'iteration_start':
      return {
        type: 'research_iteration',
        data: {
          iteration: event.iteration,
          maxIterations: event.maxIterations,
          phase: 'start',
          questions: event.questions,
          findingsCount: 0,
          coverage: 0,
          timestamp,
        },
      };

    case 'iteration_complete':
      return {
        type: 'research_iteration',
        data: {
          iteration: event.iteration,
          maxIterations: event.iteration,
          phase: 'complete',
          questions: [],
          findingsCount: event.findingsCount,
          coverage: event.coverage,
          timestamp,
          qualityReport: event.qualityReport,
        },
      };

    case 'early_stop':
      return {
        type: 'research_iteration',
        data: {
          iteration: event.iteration,
          maxIterations: event.maxIterations,
          phase: 'early_stop',
          questions: [],
          findingsCount: 0,
          coverage: event.coverage,
          timestamp,
          qualityReport: event.qualityReport,
        },
      };

    case 'questions_added':
      return {
        type: 'research_questions',
        data: {
          kind: 'update',
          changeType: 'added',
          questions: event.questions.map((question) => ({
            id: question.id,
            text: question.text,
            type: 'text' as const,
            required: false,
          })),
          allowSkip: false,
          timestamp,
        },
      };

    case 'questions_obsoleted':
      return {
        type: 'research_questions',
        data: {
          kind: 'update',
          changeType: 'obsoleted',
          questions: event.questions.map((question) => ({
            id: question.id,
            text: question.text,
            type: 'text' as const,
            required: false,
          })),
          allowSkip: false,
          timestamp,
        },
      };

    case 'finding_added':
      return {
        type: 'research_finding',
        data: {
          finding: {
            id: event.finding.id,
            type: event.finding.type,
            claim: event.finding.claim,
            content: event.finding.content,
            source: event.finding.source,
            sourceReliability: event.finding.sourceReliability,
            authorityLevel: event.finding.authorityLevel,
            stance: event.finding.stance,
            confidence: event.finding.confidence,
            citationId: event.finding.citationId,
            title: event.finding.title,
            url: event.finding.url,
            iteration: event.finding.iteration,
            relatedQuestionIds: event.finding.relatedQuestionIds,
            limitations: event.finding.limitations,
          },
          timestamp,
        },
      };

    case 'research_source_found':
      return {
        type: 'research_source_found',
        data: {
          url: event.url,
          title: event.title,
          sourceType: event.sourceType,
          reason: event.reason,
          timestamp,
        },
      };

    case 'research_source_rejected':
      return {
        type: 'research_source_rejected',
        data: {
          url: event.url,
          reason: event.reason,
          timestamp,
        },
      };

    case 'research_gap_detected':
      return {
        type: 'research_gap_detected',
        data: {
          gaps: event.gaps,
          nextActions: event.nextActions,
          questionId: event.questionId,
          timestamp,
        },
      };

    case 'research_next_action':
      return {
        type: 'research_next_action',
        data: {
          action: event.action,
          reason: event.reason,
          targetQuestionId: event.targetQuestionId,
          timestamp,
        },
      };

    case 'research_conflict_detected':
      return {
        type: 'research_conflict_detected',
        data: {
          findingId1: event.findingId1,
          findingId2: event.findingId2,
          description: event.description,
          timestamp,
        },
      };

    case 'research_quality_snapshot':
      return {
        type: 'research_quality_snapshot',
        data: {
          qualityReport: event.qualityReport,
          timestamp,
        },
      };

    case 'synthesis_start':
      return {
        type: 'research_progress',
        data: {
          phase: 'synthesis' as OrchestratorPhase,
          iteration: 0,
          maxIterations: 0,
          coverage: 0,
          findingsCount: 0,
          questionCount: 0,
          timestamp,
        },
      };

    case 'synthesis_chunk':
      return {
        type: 'research_synthesis_chunk',
        data: {
          delta: event.delta,
          total: event.total,
          timestamp,
        },
      };

    case 'complete':
      return {
        type: 'research_complete',
        data: {
          summary: event.summary,
          iterations: event.iterations,
          coverage: event.coverage,
          findingsCount: event.findingsCount,
          timestamp,
        },
      };

    case 'report_complete':
      return {
        type: 'report_complete',
        reportId: event.reportId,
        content: event.content,
        contextSnapshot: event.contextSnapshot,
        availableActions: ['evidence', 'continue'],
        timestamp,
      } as ResearchInteractiveReportEvent;

    case 'evidence_chain_response':
      return {
        type: 'evidence_chain_response',
        requestId: event.requestId,
        conclusion: event.chain.conclusion,
        chain: event.chain,
        timestamp,
      } as ResearchEvidenceChainEvent;

    case 'continue_research_start':
      return {
        type: 'continue_research_start',
        addedQuestions: event.addedQuestions,
        coverageBefore: event.coverageBefore,
        timestamp,
      } as ResearchContinueEvent;

    case 'error':
      return {
        type: 'research_error',
        data: {
          message: event.message,
          timestamp,
        },
      };

    // M1.3: 停止决策事件
    case 'research_stop_decision':
      return {
        type: 'research_stop_decision',
        data: {
          decision: event.decision,
          timestamp,
        },
      };

    // M2.2: Plan delta 事件
    case 'plan_delta':
      return {
        type: 'plan_delta',
        data: {
          data: {
            type: event.data.type,
            addedQuestionsCount: event.data.addedQuestions.length,
            obsoletedQuestionsCount: event.data.obsoletedQuestions.length,
            goalChange: event.data.goalChange,
          },
          timestamp,
        },
      };

    // M2.2: 目标变更确认请求
    case 'research_goal_change_request':
      return {
        type: 'research_questions',
        data: {
          kind: 'plan_approval' as const,
          questions: [{
            id: 'goal_change',
            text: `Research goal change proposed: "${event.proposedGoal}". Confirm?`,
            type: 'choice' as const,
            required: true,
            options: ['confirm', 'cancel'],
          }],
          allowSkip: false,
          timestamp,
          requestId: event.requestId,
        },
      };

    // M1.5: 查询去重事件
    case 'query_deduplicated':
      return {
        type: 'query_deduplicated',
        data: {
          original: event.original,
          duplicateOf: event.duplicateOf,
          timestamp,
        },
      };

    // M1.5: 发现去重事件
    case 'finding_deduplicated':
      return {
        type: 'finding_deduplicated',
        data: {
          findingId: event.findingId,
          reason: event.reason,
          timestamp,
        },
      };

    // M1.6: 动作执行结果事件
    case 'action_executed':
      return {
        type: 'action_executed',
        data: {
          result: {
            actionId: event.result.actionId,
            actionType: event.result.action.type,
            status: event.result.status,
            error: event.result.error,
            retryable: event.result.retryable,
            attempts: event.result.attempts,
          },
          timestamp,
        },
      };

    // v2: run status event
    case 'run_status':
      return {
        type: 'research_run_status',
        data: {
          runStatus: event.status,
          phase: event.phase,
          timestamp,
        },
      };

    // v2: activity event
    case 'activity':
      return {
        type: 'research_activity',
        data: {
          activityId: `act_${Date.now()}_${event.sequence}`,
          kind: event.kind,
          title: event.title,
          detail: event.detail,
          sequence: event.sequence,
          sources: event.sources,
          timestamp,
        },
      };

    // v2: plan steps created event
    case 'plan_steps_created':
      return {
        type: 'research_plan_steps',
        data: {
          steps: event.steps,
          timestamp,
        },
      };

    default:
      return null;
  }
}

const COMPLEXITY_LABELS: Record<string, string> = {
  factual: 'Factual (quick answer)',
  conceptual: 'Conceptual (moderate depth)',
  comparative: 'Comparative (side-by-side analysis)',
  analytical: 'Analytical (deep research)',
  literature_review: 'Literature Review (comprehensive survey)',
  technical_design: 'Technical Design (implementation-focused)',
  unknown: 'General (default depth)',
};