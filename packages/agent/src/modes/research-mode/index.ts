import { ModeRegistry } from '../index.js';
import { BaseMode, type ModeContext, type SSEEvent, type ClarificationQuestion } from '../types.js';
import { Orchestrator } from './Orchestrator.js';
import { convertToSSEEvent } from './SSEProtocol.js';
import type { ExtendedResearchSSEEvent } from './SSEProtocol.js';

import {
  OrchestratorPhase,
  type QueryComplexity,
  type ResearchClassification,
  type SearchQueryType,
  type SearchStrategy,
  type AnswerQuality,
  type QuestionStatus,
  type QuestionPurpose,
  type RequiredEvidence,
  type ResearchQuestion,
  type FindingContradiction,
  type ResearchFinding,
  type ResearchEntity,
  type ResearchStateSummary,
  type CoverageScore,
  type QualityReport,
  type ResearchIntent,
  type ResearchScope,
  type SourceType,
  type SourceQuality,
  type SourceLocator,
  type ResearchSource,
  type EvidenceStrategy,
  type ResearchSearchStrategy,
  type QualityGates,
  type SynthesisPlan,
  type ResearchPlan,
  type IterationAction,
  type IterationPlan,
  type PlanApprovalAction,
  type OrchestratorConfig,
  type OrchestratorDependencies,
  type EvidenceChain,
  type EvidenceNode,
  type DiffAnalysis,
  type DiffPoint,
  type ExportResult,
  type ShareLink,
  type ContinueResearchResult,
  type ResearchEvent,
  type StopDecision,
  type PlanDelta,
  type PlanDeltaType,
  type ResearchAction,
  type ResearchActionType,
  type ResearchActionResult,
  type CompareAction,
} from './types.js';

export { ResearchContext } from './ResearchContext.js';
export { Orchestrator } from './Orchestrator.js';
export { convertToSSEEvent } from './SSEProtocol.js';
export { SourceEvaluator } from './SourceEvaluator.js';
export { SourceRegistry } from './SourceRegistry.js';
export { DeduplicationService } from './DeduplicationService.js';
export type { ExtendedResearchSSEEvent } from './SSEProtocol.js';
export type { SourceEvaluationResult } from './SourceEvaluator.js';

export {
  OrchestratorPhase,
  type QueryComplexity,
  type ResearchClassification,
  type SearchQueryType,
  type SearchStrategy,
  type AnswerQuality,
  type QuestionStatus,
  type QuestionPurpose,
  type RequiredEvidence,
  type ResearchQuestion,
  type FindingContradiction,
  type ResearchFinding,
  type ResearchEntity,
  type ResearchStateSummary,
  type CoverageScore,
  type QualityReport,
  type ResearchIntent,
  type ResearchScope,
  type SourceType,
  type SourceQuality,
  type SourceLocator,
  type ResearchSource,
  type EvidenceStrategy,
  type ResearchSearchStrategy,
  type QualityGates,
  type SynthesisPlan,
  type ResearchPlan,
  type IterationAction,
  type IterationPlan,
  type PlanApprovalAction,
  type OrchestratorConfig,
  type OrchestratorDependencies,
  type EvidenceChain,
  type EvidenceNode,
  type DiffAnalysis,
  type DiffPoint,
  type ExportResult,
  type ShareLink,
  type ContinueResearchResult,
  type ResearchEvent,
  type StopDecision,
  type PlanDelta,
  type PlanDeltaType,
  type ResearchAction,
  type ResearchActionType,
  type ResearchActionResult,
  type CompareAction,
};

function collectSSEEvents(
  generator: AsyncIterable<string>
): Promise<string> {
  let result = '';
  return (async () => {
    for await (const chunk of generator) {
      result += chunk;
    }
    return result;
  })();
}

export class ResearchMode extends BaseMode {
  name = 'ResearchMode';
  modeId = 'research';

  private pendingClarifications = new Map<
    string,
    {
      resolve: (answers: Record<string, string>) => void;
      reject: (err: Error) => void;
    }
  >();

  resolveClarification(requestId: string, answers: Record<string, string>): boolean {
    const entry = this.pendingClarifications.get(requestId);
    if (!entry) return false;
    entry.resolve(answers);
    this.pendingClarifications.delete(requestId);
    return true;
  }

  rejectClarification(requestId: string, error: Error): boolean {
    const entry = this.pendingClarifications.get(requestId);
    if (!entry) return false;
    entry.reject(error);
    this.pendingClarifications.delete(requestId);
    return true;
  }

  async *execute(
    query: string,
    ctx: ModeContext
  ): AsyncGenerator<SSEEvent, void, unknown> {
    const eventQueue: ExtendedResearchSSEEvent[] = [];
    let resolveNext: (() => void) | null = null;

    // Bridge: Orchestrator emitSSE → queue → AsyncGenerator yield
    const queueEvent = (event: ResearchEvent): void => {
      const sseEvent = convertToSSEEvent(event);
      if (sseEvent) {
        eventQueue.push(sseEvent);
        if (resolveNext) {
          resolveNext();
          resolveNext = null;
        }
      }
    };

    // Build llmComplete from llmClient
    const llmComplete = async (prompt: string, systemPrompt?: string): Promise<string> => {
      const messages = [{ role: 'user' as const, content: prompt }];
      const stream = ctx.llmClient.streamChat(messages, {
        systemPrompt,
        maxTokens: 4096,
      });
      return collectSSEEvents(filterTextDeltas(stream));
    };

    // Build llmStreamFn
    const llmStreamFn = ctx.llmClient.streamChat
      ? async function* (prompt: string, systemPrompt?: string): AsyncIterable<string> {
          const messages = [{ role: 'user' as const, content: prompt }];
          const stream = ctx.llmClient.streamChat(messages, {
            systemPrompt,
            maxTokens: 16384,
          });
          yield* filterTextDeltas(stream);
        }
      : undefined;

    // Build awaitClarification (方案 B: HTTP + pending Promise map)
    const awaitClarification = async (
      questions: ClarificationQuestion[],
      requestId: string
    ): Promise<Record<string, string>> => {
      return new Promise((resolve, reject) => {
        this.pendingClarifications.set(requestId, { resolve, reject });
        const timeout = setTimeout(() => {
          if (this.pendingClarifications.has(requestId)) {
            this.pendingClarifications.delete(requestId);
            reject(new Error('Clarification timeout after 5 minutes'));
          }
        }, 300_000);
      });
    };

    // Build deps
    const deps: OrchestratorDependencies = {
      llmComplete,
      llmStreamFn,
      toolExecute: ctx.toolExecute || ((_name, _input) => {
        throw new Error('toolExecute not available');
      }),
      toolExecuteConcurrent: ctx.toolExecuteConcurrent || (async function* () {
        throw new Error('toolExecuteConcurrent not available');
      }),
      emitSSE: queueEvent,
      awaitClarification,
      persistState: ctx.persistState
        ? async (contextJSON: string) => {
            await ctx.persistState!({ context: contextJSON });
          }
        : undefined,
    };

    const orchestrator = new Orchestrator(query, deps);

    // Run orchestrator in background
    const orchestratorPromise = orchestrator.execute();

    // Yield events from queue as they arrive
    while (true) {
      if (eventQueue.length > 0) {
        const event = eventQueue.shift()!;
        yield sseEventToSSEEvent(event);
        continue;
      }

      // Check if orchestrator finished
      if ((await Promise.race([orchestratorPromise.then(() => 'done'), new Promise((r) => setTimeout(r, 0))])) === 'done') {
        // Drain remaining events
        while (eventQueue.length > 0) {
          yield sseEventToSSEEvent(eventQueue.shift()!);
        }
        break;
      }

      // Wait for next event
      await new Promise<void>((resolve) => {
        resolveNext = resolve;
      });
    }
  }
}

function sseEventToSSEEvent(event: ExtendedResearchSSEEvent): SSEEvent {
  return event as unknown as SSEEvent;
}

async function* filterTextDeltas(
  stream: AsyncGenerator<SSEEvent, void, unknown>
): AsyncGenerator<string, void, unknown> {
  for await (const event of stream) {
    if (event.type === 'text_delta' || event.type === 'text') {
      yield event.data as string;
    }
  }
}

ModeRegistry.register('research', ResearchMode);