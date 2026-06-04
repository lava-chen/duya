import { ModeRegistry } from '../index.js';
import { BaseMode, type ModeContext, type SSEEvent, type ClarificationQuestion } from '../types.js';
import { Orchestrator } from './Orchestrator.js';
import { convertToSSEEvent } from './SSEProtocol.js';
import type { ExtendedResearchSSEEvent } from './SSEProtocol.js';
import type { Message, MessageContent, ToolUseContent, ToolResultContent } from '../../types.js';

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
  type ToolSpec,
  type ToolCallRequest,
  type ToolCallResult,
  type AgentCallInput,
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

  /**
   * Most recent clarification requestId registered for this mode instance.
   * Used so a fresh `clarification_questions` event auto-rejects the prior
   * pending one — without this, the orchestrator can deadlock on a request
   * the renderer has already stopped tracking.
   */
  private latestClarificationRequestId: string | undefined;

  resolveClarification(requestId: string, answers: Record<string, string>): boolean {
    const entry = this.pendingClarifications.get(requestId);
    if (!entry) return false;
    entry.resolve(answers);
    this.pendingClarifications.delete(requestId);
    if (this.latestClarificationRequestId === requestId) {
      this.latestClarificationRequestId = undefined;
    }
    return true;
  }

  rejectClarification(requestId: string, error: Error): boolean {
    const entry = this.pendingClarifications.get(requestId);
    if (!entry) return false;
    entry.reject(error);
    this.pendingClarifications.delete(requestId);
    if (this.latestClarificationRequestId === requestId) {
      this.latestClarificationRequestId = undefined;
    }
    return true;
  }

  /**
   * Register a new clarification request and supersede any prior
   * still-pending one. Returns true if a prior request was superseded,
   * false otherwise.
   *
   * The research orchestrator may emit a fresh `clarification_questions`
   * event after a plan approval round-trip or a replan. The renderer can
   * drop the previous prompt on the floor, leaving the orchestrator's
   * `await` hanging on a requestId the user no longer sees. Resolving the
   * prior request with an empty answer map (rather than rejecting) keeps
   * the orchestrator moving; subsequent `setUserAnswers({})` is a no-op
   * because no user input was collected.
   */
  registerClarificationRequest(requestId: string): boolean {
    const previous = this.latestClarificationRequestId;
    this.latestClarificationRequestId = requestId;
    if (previous && previous !== requestId) {
      const prior = this.pendingClarifications.get(previous);
      if (prior) {
        this.pendingClarifications.delete(previous);
        // Empty answers = "user opted not to answer" — orchestrator continues
        // with whatever defaults were already in context.
        prior.resolve({});
      }
      return true;
    }
    return false;
  }

  async *execute(
    query: string,
    ctx: ModeContext
  ): AsyncGenerator<SSEEvent, void, unknown> {
    const eventQueue: ExtendedResearchSSEEvent[] = [];
    let resolveNext: (() => void) | null = null;
    let eventSeq = await loadInitialResearchEventSequence(ctx);
    let reportMarkdown = '';
    const reportSourceIds = new Set<string>();
    const reportCitationIds = new Set<string>();
    let persistTail: Promise<void> = Promise.resolve();
    let persistenceFailed = false;
    let orchestrator: Orchestrator | null = null;

    const enqueuePersistedEvent = (event: ExtendedResearchSSEEvent): void => {
      eventQueue.push(event);
      if (resolveNext) {
        resolveNext();
        resolveNext = null;
      }
    };

    const enqueuePersistenceError = (error: unknown): void => {
      if (persistenceFailed) return;
      persistenceFailed = true;
      const timestamp = Date.now();
      const message = error instanceof Error ? error.message : String(error);
      if (!ctx.abortController.signal.aborted) {
        ctx.abortController.abort(new Error(`research_persistence_failed:${message}`));
      }
      orchestrator?.abort();
      if (ctx._researchRunId && ctx.runDB?.updateRun) {
        void ctx.runDB.updateRun(ctx._researchRunId, {
          run_status: 'failed',
          current_phase: 'aborted',
          error_json: JSON.stringify({ message, kind: 'research_event_persistence_failed' }),
          completed_at: timestamp,
        });
      }
      enqueuePersistedEvent({
        type: 'research_error',
        data: {
          message: `Research event persistence failed: ${message}`,
          timestamp,
        },
      });
    };

    // Bridge: Orchestrator emitSSE -> durable event log -> queue -> AsyncGenerator yield
    const queueEvent = (event: ResearchEvent): void => {
      persistTail = persistTail
        .then(async () => {
          if (persistenceFailed) return;

          const sseEvent = convertToSSEEvent(event);
          if (!sseEvent) return;

          const persistedAt = Date.now();
          const sequence = eventSeq + 1;
          attachResearchEventMetadata(sseEvent, {
            eventSeq: sequence,
            runId: ctx._researchRunId || undefined,
            persistedAt,
          });

          await persistResearchArtifactsForEvent({
            event,
            sseEvent,
            ctx,
            query,
            persistedAt,
            reportMarkdown,
            reportSourceIds,
            reportCitationIds,
          });

          await persistResearchSSEEvent(ctx, sseEvent, sequence);
          eventSeq = sequence;

          if (sseEvent.type === 'research_synthesis_chunk') {
            reportMarkdown += sseEvent.data.delta;
          }

          enqueuePersistedEvent(sseEvent);
        })
        .catch((error) => {
          enqueuePersistenceError(error);
        });
    };

    // Build llmComplete from llmClient (text-only, no tools)
    const llmComplete = async (prompt: string, systemPrompt?: string): Promise<string> => {
      const messages = [{ role: 'user' as const, content: prompt }];
      const stream = ctx.llmClient.streamChat(messages, {
        systemPrompt,
        maxTokens: 4096,
      });
      return collectSSEEvents(filterTextDeltas(stream));
    };

    // Build llmAgentCall: multi-turn LLM with tool use
    const llmAgentCall = async (
      input: import('./types.js').AgentCallInput
    ): Promise<{ content: string; toolCalls: import('./types.js').ToolCallResult[] }> => {
      throwIfAborted(ctx.abortController.signal);
      const messages: Message[] = [
        { role: 'user', content: input.userPrompt },
      ];
      const toolResults: Array<{ name: string; content: string; error?: boolean }> = [];
      const toolExec = input.toolExecute || deps.toolExecute;

      for (let turn = 0; turn < input.maxToolCalls; turn++) {
        throwIfAborted(ctx.abortController.signal);
        const stream = ctx.llmClient.streamChat(messages, {
          systemPrompt: input.systemPrompt,
          tools: input.tools.map((t) => ({
            name: t.name,
            description: t.description,
            input_schema: t.input_schema,
          })),
          maxTokens: 16384,
        });

        let textBuffer = '';
        const toolUses: Array<{ id: string; name: string; input: Record<string, unknown> }> = [];

        for await (const event of stream) {
          throwIfAborted(ctx.abortController.signal);
          if (event.type === 'text_delta' || event.type === 'text') {
            textBuffer += event.data as string;
          } else if (event.type === 'tool_use') {
            const tu = event.data as { id: string; name: string; input: Record<string, unknown> };
            toolUses.push({ id: tu.id, name: tu.name, input: tu.input });
          }
        }

        if (toolUses.length === 0) {
          return { content: textBuffer, toolCalls: toolResults };
        }

        // Build assistant message with tool_use blocks
        const assistantContent: MessageContent[] = toolUses.map((tu) => ({
          type: 'tool_use' as const,
          id: tu.id,
          name: tu.name,
          input: tu.input,
        }));
        messages.push({ role: 'assistant', content: assistantContent });

        // Execute tools and add results
        const toolResultContents: MessageContent[] = [];
        for (const tu of toolUses) {
          throwIfAborted(ctx.abortController.signal);
          try {
            const result = await toolExec(tu.name, tu.input);
            const resultContent = typeof result.result === 'string' ? result.result : JSON.stringify(result.result);
            toolResults.push({
              name: tu.name,
              content: resultContent.slice(0, 4000),
              error: result.error,
            });
            toolResultContents.push({
              type: 'tool_result',
              tool_use_id: tu.id,
              content: resultContent.slice(0, 4000),
              is_error: result.error || false,
            });
          } catch (err) {
            const errMsg = err instanceof Error ? err.message : String(err);
            toolResults.push({ name: tu.name, content: errMsg, error: true });
            toolResultContents.push({
              type: 'tool_result',
              tool_use_id: tu.id,
              content: errMsg,
              is_error: true,
            });
          }
        }
        messages.push({ role: 'user', content: toolResultContents });
      }

      // Final turn: get text response without tools
      const finalStream = ctx.llmClient.streamChat(messages, {
        systemPrompt: input.systemPrompt,
        maxTokens: 16384,
      });
      let finalText = '';
      for await (const event of finalStream) {
        throwIfAborted(ctx.abortController.signal);
        if (event.type === 'text_delta' || event.type === 'text') {
          finalText += event.data as string;
        }
      }
      return { content: finalText, toolCalls: toolResults };
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
      // Register with the ResearchMode so a subsequent clarification request
      // (e.g. after plan approval) auto-rejects this one. Without this the
      // orchestrator can deadlock on a requestId the renderer no longer
      // surfaces.
      this.registerClarificationRequest(requestId);
      return new Promise((resolve, reject) => {
        const entry: {
          resolve: (answers: Record<string, string>) => void;
          reject: (err: Error) => void;
        } = { resolve, reject };
        this.pendingClarifications.set(requestId, entry);
        const timeout = setTimeout(() => {
          if (this.pendingClarifications.get(requestId) === entry) {
            this.pendingClarifications.delete(requestId);
            reject(new Error('Clarification timeout after 5 minutes'));
          }
        }, 300_000);
        // Always clear the timer once the promise settles, otherwise the
        // un-fired timer keeps a reference to `entry` and Node emits
        // UnhandledPromiseRejection whenever the user beats the timeout.
        const settle = (fn: () => void): void => {
          clearTimeout(timeout);
          if (this.pendingClarifications.get(requestId) === entry) {
            this.pendingClarifications.delete(requestId);
          }
          fn();
        };
        entry.resolve = (answers) => settle(() => resolve(answers));
        entry.reject = (err) => settle(() => reject(err));
      });
    };

    // Build deps
    const deps: OrchestratorDependencies = {
      sessionId: ctx.sessionId,
      abortSignal: ctx.abortController.signal,
      llmComplete,
      llmStreamFn,
      llmAgentCall,
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
      runDB: ctx.runDB
        ? {
            runId: ctx._researchRunId || '',
            updateRun: async (data) => {
              await ctx.runDB!.updateRun(ctx._researchRunId || '', data as Record<string, unknown>);
            },
            createPlanSteps: async (steps) => {
              await ctx.runDB!.createPlanSteps(ctx._researchRunId || '', steps as Array<Record<string, unknown>>);
            },
            updatePlanStep: async (stepId, data) => {
              await ctx.runDB!.updatePlanStep(stepId, data as Record<string, unknown>);
            },
            logActivity: async (activity) => {
              await ctx.runDB!.logActivity({
                ...activity,
                run_id: ctx._researchRunId || '',
              });
            },
            logEvent: ctx.runDB.logEvent
              ? async (event) => {
                  await ctx.runDB!.logEvent!({
                    ...event,
                    run_id: ctx._researchRunId || '',
                  });
                }
              : undefined,
            getEventMaxSequence: ctx.runDB.getEventMaxSequence
              ? async () => ctx.runDB!.getEventMaxSequence!(ctx._researchRunId || '')
              : undefined,
            upsertSource: ctx.runDB.upsertSource
              ? async (source) => {
                  await ctx.runDB!.upsertSource!({
                    ...source,
                    run_id: ctx._researchRunId || '',
                  });
                }
              : undefined,
            createCitation: ctx.runDB.createCitation
              ? async (citation) => {
                  await ctx.runDB!.createCitation!({
                    ...citation,
                    run_id: ctx._researchRunId || '',
                  });
                }
              : undefined,
            upsertReport: ctx.runDB.upsertReport
              ? async (report) => {
                  await ctx.runDB!.upsertReport!({
                    ...report,
                    run_id: ctx._researchRunId || '',
                  });
                }
              : undefined,
          }
        : undefined,
    };

    orchestrator = new Orchestrator(query, deps);

    // Run orchestrator in background
    const orchestratorPromise = orchestrator.execute();

    // Yield events from queue as they arrive
    while (true) {
      if (eventQueue.length > 0) {
        const event = eventQueue.shift()!;
        yield sseEventToSSEEvent(event);
        continue;
      }

      if (persistenceFailed) {
        await Promise.race([orchestratorPromise, new Promise((resolve) => setTimeout(resolve, 1000))]);
        break;
      }

      // Check if orchestrator finished
      if ((await Promise.race([orchestratorPromise.then(() => 'done'), new Promise((r) => setTimeout(r, 0))])) === 'done') {
        await persistTail;
        // Drain remaining events
        while (eventQueue.length > 0) {
          yield sseEventToSSEEvent(eventQueue.shift()!);
        }
        break;
      }

      // Wait for next event
      await new Promise<void>((resolve) => {
        resolveNext = resolve;
        setTimeout(resolve, 100);
      });
    }
  }
}

function sseEventToSSEEvent(event: ExtendedResearchSSEEvent): SSEEvent {
  return event as unknown as SSEEvent;
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    const reason = signal.reason instanceof Error ? signal.reason.message : 'aborted';
    throw new Error(`ResearchMode aborted: ${reason}`);
  }
}

async function loadInitialResearchEventSequence(ctx: ModeContext): Promise<number> {
  const runId = ctx._researchRunId;
  if (!runId || !ctx.runDB?.getEventMaxSequence) {
    return 0;
  }
  return ctx.runDB.getEventMaxSequence(runId);
}

async function persistResearchSSEEvent(
  ctx: ModeContext,
  event: ExtendedResearchSSEEvent,
  sequence: number,
): Promise<void> {
  if (!ctx._researchRunId || !ctx.runDB?.logEvent) {
    throw new Error('research event persistence is unavailable for this run');
  }

  await ctx.runDB.logEvent({
    run_id: ctx._researchRunId,
    sequence,
    event_type: event.type,
    payload_json: JSON.stringify(event),
    visibility: isUserFacingResearchEvent(event.type) ? 'user' : 'debug',
  });
}

async function persistResearchArtifactsForEvent(args: {
  event: ResearchEvent;
  sseEvent: ExtendedResearchSSEEvent;
  ctx: ModeContext;
  query: string;
  persistedAt: number;
  reportMarkdown: string;
  reportSourceIds: Set<string>;
  reportCitationIds: Set<string>;
}): Promise<void> {
  const { event, ctx, query, persistedAt, reportMarkdown, reportSourceIds, reportCitationIds } = args;
  const runId = ctx._researchRunId;

  if (event.type === 'finding_added') {
    if (!runId || !ctx.runDB?.upsertSource) {
      throw new Error('research source persistence is unavailable for finding event');
    }

    const finding = event.finding;
    const sourceKey = finding.url || finding.source || finding.id;
    const sourceId = `src_${stableResearchId(sourceKey)}`;
    const citationId = finding.citationId || `cite_${stableResearchId(finding.id)}`;

    await ctx.runDB.upsertSource({
      run_id: runId,
      id: sourceId,
      title: finding.title || finding.source || 'Untitled source',
      url: finding.url || finding.source || null,
      canonical_url: finding.canonicalUrl || finding.url || finding.source || null,
      source_type: finding.type || 'web',
      allowed_by_policy: true,
      reliability_json: JSON.stringify({
        sourceReliability: finding.sourceReliability,
        authorityLevel: finding.authorityLevel,
        confidence: finding.confidence,
      }),
      metadata_json: JSON.stringify({
        stance: finding.stance,
        relatedQuestionIds: finding.relatedQuestionIds || [],
      }),
    });

    if (ctx.runDB.createCitation) {
      await ctx.runDB.createCitation({
        run_id: runId,
        id: citationId,
        report_id: null,
        source_id: sourceId,
        finding_id: finding.id,
        claim: finding.claim || finding.content,
        locator_json: finding.locator ? JSON.stringify(finding.locator) : null,
        quoted_evidence: finding.quotedEvidence || null,
      });
    }

    reportSourceIds.add(sourceId);
    reportCitationIds.add(citationId);
  }

  if (event.type === 'report_complete') {
    if (!runId || !ctx.runDB?.upsertReport) {
      throw new Error('research report persistence is unavailable for report event');
    }

    const markdown = reportMarkdown.trim() || event.content;
    await ctx.runDB.upsertReport({
      run_id: runId,
      id: event.reportId,
      title: query.slice(0, 120),
      markdown,
      source_ids_json: JSON.stringify(Array.from(reportSourceIds)),
      citation_ids_json: JSON.stringify(Array.from(reportCitationIds)),
      activity_summary_json: JSON.stringify(event.contextSnapshot),
      export_metadata_json: JSON.stringify({ format: 'markdown', generatedAt: persistedAt }),
    });
  }
}

function attachResearchEventMetadata(
  event: ExtendedResearchSSEEvent,
  metadata: { eventSeq: number; runId?: string; persistedAt: number },
): void {
  const target = event as ExtendedResearchSSEEvent & {
    eventSeq?: number;
    runId?: string;
    persistedAt?: number;
    data?: Record<string, unknown>;
  };
  target.eventSeq = metadata.eventSeq;
  target.runId = metadata.runId;
  target.persistedAt = metadata.persistedAt;
  if (target.data && typeof target.data === 'object') {
    target.data.eventSeq = metadata.eventSeq;
    target.data.runId = metadata.runId;
    target.data.persistedAt = metadata.persistedAt;
  }
}

function stableResearchId(value: string): string {
  let hash = 0;
  for (let i = 0; i < value.length; i++) {
    hash = ((hash << 5) - hash + value.charCodeAt(i)) | 0;
  }
  return Math.abs(hash).toString(36);
}

function isUserFacingResearchEvent(type: string): boolean {
  return ![
    'research_quality_snapshot',
    'query_deduplicated',
    'finding_deduplicated',
    'action_executed',
  ].includes(type);
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
