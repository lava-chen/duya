/**
 * Stateless streaming agent loop (Plan 334, Phase 2).
 *
 * Extracts the while-loop body of `duyaAgent.streamChat` into a pure
 * function `runAgentLoop`. The function holds NO instance state: every
 * side effect is injected through the `deps` (ports: llmClient, registry,
 * compactionController, mailbox, modeRefresh, permission, canvasState) and
 * `config` (callback contract) parameters, and the cross-turn mutable state
 * lives entirely in the injected `LoopState`.
 *
 * The outer `AsyncGenerator<SSEEvent>` surface is preserved by the caller
 * (DuyaAgent) which adapts the `LoopEvent` stream emitted here back into
 * SSE events. This module never touches `this.*` and never imports concrete
 * session classes, so it can be unit-tested with stub ports.
 */

import type {
  AgentProgressEvent,
  AgentRuntimeMode,
  Message,
  MessageContent,
  ToolResultContent,
  ToolUseContext,
  TokenUsage,
} from '../types.js';
import type { ToolRegistry } from '../tool/registry.js';
import type { CanUseToolFn, MessageUpdate } from '../tool/StreamingToolExecutor.js';
import { StreamingToolExecutor } from '../tool/StreamingToolExecutor.js';
import type {
  AgentDeps,
  AgentLoopConfig,
  LoopEvent,
  LoopState,
} from './types.js';
import { getDiscoveredToolPrompts, harvestDiscoveredTools } from './tool-search-discovery.js';
import { microCleanupMessages } from '../compact/microCompactCleanup.js';
import { compressHistoricalCanvasToolCalls } from '../compact/canvasHistoryCompress.js';
import { getAgentsMdManager } from '../agentsmd/index.js';
import { collectRecentImageAttachments } from './utils/agent-helpers.js';
import { isToolVisible } from '../agent-profile/ToolFilter.js';
import { logger } from '../utils/logger.js';

/** Minimal shape of a compaction entry for logging (port returns `unknown`). */
interface CompactEntryLike {
  strategy?: string;
  tokensBefore?: number;
  tokensAfter?: number;
}

const MODE_SWITCH_TOOLS = new Set(['EnterPlanMode', 'ExitPlanMode', 'SwitchMode']);

/**
 * Run the streaming agent loop until completion, abort, or the max-turn
 * boundary. Emits `LoopEvent`s via `emit` and returns the final (mutated)
 * `LoopState`. Stateless: all external behaviour is injected via `deps` and
 * `config`.
 */
export async function runAgentLoop(
  state: LoopState,
  deps: AgentDeps,
  config: AgentLoopConfig,
  emit: (event: LoopEvent) => void | Promise<void>,
  signal: AbortSignal | undefined,
): Promise<LoopState> {
  const abortSignal = signal ?? config.abortSignal;
  const maxTurns = config.maxTurns ?? 100;
  const seqIndex = Date.now();
  const streamStartTime = Date.now();

  // Per-run executor controller. Mirrors `this.abortController` in the
  // legacy loop: the executor (and its streaming tools) observe this.
  const abortController = new AbortController();
  if (abortSignal && !abortSignal.aborted) {
    abortSignal.addEventListener('abort', () => abortController.abort(), { once: true });
  }

  // The tool-search prompt suffix is per-invocation local (mirrors the local
  // variable in the legacy streamChat, not instance state). It is stripped
  // from the system prompt at the start of each turn to avoid duplication.
  let discoveredToolPromptSuffix = '';

  while (!abortSignal.aborted) {
    // Strip the prior turn's dynamic discovered-tool guide.
    if (
      discoveredToolPromptSuffix &&
      state.systemPromptContent.endsWith(discoveredToolPromptSuffix)
    ) {
      state.systemPromptContent = state.systemPromptContent.slice(
        0,
        -discoveredToolPromptSuffix.length,
      );
    }
    discoveredToolPromptSuffix = '';

    state.turnCount++;

    // Allow the session layer to override the next turn's runtime state
    // (model / thinking level / tools / system prompt) before we build it.
    const update = await config.prepareNextTurn?.(state);
    if (update) {
      if (update.systemPromptContent !== undefined) {
        state.systemPromptContent = update.systemPromptContent;
      }
      if (update.tools !== undefined) {
        state.tools = update.tools;
      }
      if (update.turnCount !== undefined) {
        state.turnCount = update.turnCount;
      }
    }

    // Surface tools discovered via tool_search in previous turns.
    if (state.discoveredTools.size > 0) {
      const visible = new Set(state.tools.map((t) => t.name));
      let added = 0;
      for (const name of state.discoveredTools) {
        if (visible.has(name)) continue;
        const exposeMode = deps.registry.getExposeMode(name) as
          | 'always'
          | 'discoverable'
          | 'internal'
          | undefined;
        if (!isToolVisible(name, exposeMode ?? 'internal', state.discoveredTools, {})) {
          continue;
        }
        const def = deps.registry.getTool(name);
        if (!def) {
          logger.warn(
            `[Agent] discovered tool '${name}' no longer registered, skipping`,
          );
          continue;
        }
        state.tools = [...state.tools, def];
        visible.add(name);
        added++;
      }
      if (added > 0) {
        logger.info(
          `[Agent] Turn ${state.turnCount}: added ${added} discovered tools to LLM request`,
        );
      }
    }

    // Re-evaluate mode-modifier prompt prefixes against the latest mode state
    // (e.g. conductor's rolling widget-style history).
    state.systemPromptContent = await deps.modeRefresh.refresh(
      state.systemPromptContent,
      state.turnCount,
    );

    // Append on-demand tool usage guides for discoverable tools. The helper
    // only reads `getExecutor`; the port's narrower surface is widened to the
    // concrete registry type for the call.
    const discoveredPrompts = getDiscoveredToolPrompts(
      deps.registry as unknown as ToolRegistry,
      state.discoveredTools,
    );
    if (discoveredPrompts.length > 0) {
      discoveredToolPromptSuffix = [
        '',
        '',
        '## On-Demand Tool Guides',
        '',
        ...discoveredPrompts,
      ].join('\n');
      state.systemPromptContent += discoveredToolPromptSuffix;
    }

    // First turn: the user message is expected to be pre-persisted in
    // `state.messages` by the session layer (the frontend writes it to the
    // append-only history before invoking the loop). Track its id so the
    // model-facing content can be substituted on the provider payload.
    if (state.turnCount === 1) {
      const lastMessage = state.messages[state.messages.length - 1];
      if (lastMessage?.role === 'user' && typeof lastMessage.id === 'string') {
        state.runtimePromptMessageId = lastMessage.id;
      }
    }

    // Build the executor for this turn.
    const toolUseContext: ToolUseContext = {
      toolUseId: crypto.randomUUID(),
      abortController,
      getAppState: () => ({}),
      setAppState: () => {},
      widgetStyleHistory: deps.canvasState.widgetStyleHistory,
      canvasFreshness: deps.canvasState.canvasFreshness,
      options: {
        recentImageAttachments: collectRecentImageAttachments(state.messages),
        tools: state.tools,
        commands: [],
        mainLoopModel: '',
        mcpClients: [],
      },
    };

    const canUseTool: CanUseToolFn = async (toolName, toolInput) => {
      const decision = await deps.permission.canUseTool(toolName, toolInput);
      return decision.allowed;
    };

    // The injected port is a subset of the concrete ToolRegistry; the real
    // registry (with execute/snapshot/isToolConcurrencySafe) is supplied by
    // the session layer at runtime.
    const executor = new StreamingToolExecutor(
      deps.registry as unknown as ToolRegistry,
      canUseTool,
      toolUseContext,
    );

    // Per-turn state.
    const assistantContent: MessageContent[] = [];
    let needsFollowUp = false;
    let thinkingContent = '';
    let hasThinkingContent = false;
    let thinkingSignature: string | undefined;
    let doneEventHandled = false;
    state.modeSwitchToolIds.clear();

    await emit({ type: 'turn_start', data: { turnCount: state.turnCount } });

    // Lightweight tool-result cleanup before each turn.
    state.messages = microCleanupMessages(state.messages);

    // Proactive context compaction before the LLM call.
    if (deps.compactionController.shouldCompact()) {
      logger.info(`[Agent] Turn ${state.turnCount}: Proactive compaction triggered`);
      try {
        const compactEntry = (await deps.compactionController.compactProactive()) as
          | CompactEntryLike
          | null
          | undefined;
        if (compactEntry) {
          logger.info(
            `[Agent] Turn ${state.turnCount}: Compacted with strategy=${compactEntry.strategy}, removed=${compactEntry.tokensBefore} tokens, retained=${compactEntry.tokensAfter ?? 0} tokens`,
          );
          state.messages = await config.convertToLlm(state.messages);
        }
      } catch (compactError) {
        const compactErrorMsg =
          compactError instanceof Error ? compactError.message : String(compactError);
        logger.error(
          `[Agent] Turn ${state.turnCount}: Proactive compaction failed: ${compactErrorMsg}`,
        );
      }
    }

    // Steering messages (mailbox instructions / background notifications)
    // absorbed at the before_model_turn checkpoint.
    const steering = await config.getSteeringMessages?.();
    if (steering && steering.length > 0) {
      for (const m of steering) {
        state.messages.push(m);
      }
    }

    try {
      logger.info(
        `[Agent] Turn ${state.turnCount}: Starting LLM stream, messages=${state.messages.length}`,
      );

      // Build the model-facing payload, then compress historical canvas tool
      // calls (canvas tools are not model-visible). The spread copies the
      // array so the AGENTS.md unshift and deferred-context pushes below do
      // not leak into the durable `state.messages` timeline.
      const llmMessages = [...compressHistoricalCanvasToolCalls(state.messages)];

      // Codex-compatible: inject AGENTS.md as the first user message on the
      // first turn. Ephemeral — sent to the LLM but never persisted.
      if (state.turnCount === 1) {
        const agentsMdText = getAgentsMdManager().buildAgentsMdPrompt();
        if (agentsMdText) {
          llmMessages.unshift({
            id: crypto.randomUUID(),
            role: 'user',
            content: agentsMdText,
            timestamp: Date.now(),
            metadata: { isAgentsMdContext: true },
          });
        }
      }

      // Inject transient deferred tool contexts into the provider payload.
      await injectDeferredContexts(llmMessages, state);

      const streamGenerator = config.streamFunction(llmMessages, {
        systemPrompt: state.systemPromptContent,
        tools: state.tools,
        signal: abortSignal,
      });
      logger.info(
        `[Agent] Turn ${state.turnCount}: Stream generator created, starting iteration...`,
      );
      for await (const event of streamGenerator) {
        if (event.type === 'tool_use') {
          // Add tool to executor for background execution.
          executor.addTool(event.data);
          needsFollowUp = true;

          assistantContent.push({
            type: 'tool_use',
            id: event.data.id,
            name: event.data.name,
            input: event.data.input,
          });

          if (MODE_SWITCH_TOOLS.has(event.data.name)) {
            state.modeSwitchToolIds.set(event.data.id, event.data.name);
          }

          await emit(event);

        } else if (event.type === 'text') {
          // Merge consecutive text blocks to prevent markdown fragmentation.
          const lastBlock = assistantContent[assistantContent.length - 1];
          if (lastBlock && lastBlock.type === 'text') {
            lastBlock.text += event.data;
          } else {
            assistantContent.push({ type: 'text', text: event.data });
          }
          await emit(event);

        } else if (event.type === 'done') {
          // Ignore duplicate `done` events from the same LLM stream.
          if (doneEventHandled) {
            logger.warn(
              `[Agent] Turn ${state.turnCount}: Ignoring duplicate done event from LLM stream`,
            );
            continue;
          }
          doneEventHandled = true;

          // Build the final assistant content (thinking block first).
          const finalAssistantContent: MessageContent[] = [];
          if (hasThinkingContent && thinkingContent) {
            finalAssistantContent.push({
              type: 'thinking',
              thinking: thinkingContent,
              ...(thinkingSignature ? { thinkingSignature } : {}),
            });
          }
          finalAssistantContent.push(...assistantContent);

          if (finalAssistantContent.length > 0 || needsFollowUp) {
            state.messages.push({
              id: crypto.randomUUID(),
              role: 'assistant',
              content:
                finalAssistantContent.length > 0
                  ? finalAssistantContent
                  : assistantContent,
              timestamp: Date.now(),
              duration_ms: Date.now() - streamStartTime,
              seq_index: seqIndex,
            });
          }

          // Drain tool results after the assistant message (OpenAI requires
          // assistant(tool_calls) -> tool(result) message order).
          let toolResultMessageCount = 0;
          for await (const result of executor.getRemainingResults()) {
            if (result.deferredContext) {
              state.deferredContexts.push(result.deferredContext);
              continue;
            }
            if (!result.message) continue;

            const isAgentProgress =
              result.message.metadata?.type === 'agent_progress';
            if (isAgentProgress) {
              const agentEvent = result.message.metadata
                ?.agentEvent as AgentProgressEvent | undefined;
              if (agentEvent) {
                await emit({ type: 'agent_progress', data: agentEvent });
              }
              continue;
            }

            const messageContent = result.message.content;
            const isToolResult =
              result.message.role === 'tool' ||
              (Array.isArray(messageContent) &&
                messageContent.length > 0 &&
                messageContent[0]?.type === 'tool_result');

            if (isToolResult) {
              toolResultMessageCount++;
              result.message.seq_index = seqIndex;
              if (!result.message.id) {
                result.message.id = crypto.randomUUID();
              }
              state.messages.push(result.message);
              const modeSwitchToolName = state.modeSwitchToolIds.get(
                result.message.tool_call_id ?? '',
              );
              await emitToolResult(emit, result, modeSwitchToolName);
              if (modeSwitchToolName) {
                state.modeSwitchToolIds.delete(result.message.tool_call_id ?? '');
              }
            }
          }

          // Surface tool_search-discovered tool names for the next turn.
          if (toolResultMessageCount > 0) {
            const newToolResults = state.messages.slice(-toolResultMessageCount);
            const addedCount = harvestDiscoveredTools(
              newToolResults,
              state.discoveredTools,
            );
            if (addedCount > 0) {
              logger.info(
                `[Agent] Turn ${state.turnCount}: harvested ${addedCount} tool name(s) from tool_search results; will surface in next turn`,
              );
            }
          }

        } else if (event.type === 'error') {
          await emit(event);

        } else if (event.type === 'thinking') {
          const thinkingData =
            typeof event.data === 'string'
              ? event.data
              : JSON.stringify(event.data);
          if (thinkingData) {
            thinkingContent += thinkingData;
          }
          if (event.signature) {
            thinkingSignature = event.signature;
          }
          hasThinkingContent = true;
          await emit(event);

        } else if (event.type === 'tool_progress') {
          await emit(event);

        } else if (event.type === 'tool_timeout') {
          await emit(event);

        } else if (event.type === 'result') {
          await emit(event);
        }
      }

      // Max-turns boundary.
      if (state.turnCount >= maxTurns) {
        await emit({ type: 'done', reason: 'max_turns' });
        return state;
      }

      // No tool calls requested -> the agent is done unless follow-up
      // guidance arrived while the model produced its final answer.
      if (!needsFollowUp) {
        const followUp = await config.getFollowUpMessages?.();
        if (followUp && followUp.length > 0) {
          for (const m of followUp) {
            state.messages.push(m);
          }
          continue;
        }
        await emit({ type: 'done', reason: 'completed' });
        return state;
      }

      // The model requested more tool calls; allow the session layer to stop
      // even so (e.g. a hard turn budget).
      if (await config.shouldStopAfterTurn?.(state)) {
        await emit({ type: 'done', reason: 'completed' });
        return state;
      }

      // Loop continues — the next LLM call includes the tool results pushed
      // above.

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error(
        `[Agent] Turn ${state.turnCount}: Error in LLM stream`,
        error instanceof Error ? error : new Error(errorMessage),
      );

      const isContextLengthError =
        errorMessage.includes('context_length_exceeded') ||
        errorMessage.includes('context window exceeds limit') ||
        errorMessage.includes('prompt_too_long') ||
        errorMessage.includes('exceeds limit');

      if (isContextLengthError) {
        logger.warn(
          `[Agent] Turn ${state.turnCount}: Context length exceeded, attempting reactive compaction`,
        );
        try {
          const triggerError = errorMessage.includes('prompt_too_long')
            ? ('prompt_too_long' as const)
            : ('context_length_exceeded' as const);
          const compactEntry = (await deps.compactionController.compactReactive(
            triggerError,
          )) as CompactEntryLike | null | undefined;
          if (compactEntry) {
            logger.info(
              `[Agent] Turn ${state.turnCount}: Reactive compaction succeeded, strategy=${compactEntry.strategy}, retained=${compactEntry.tokensAfter ?? 0} tokens`,
            );
            state.messages = await config.convertToLlm(state.messages);
            executor.discard();
            state.turnCount--; // Retry with the same turn number.
            continue;
          }
        } catch (reactiveError) {
          const reactiveErrorMsg =
            reactiveError instanceof Error ? reactiveError.message : String(reactiveError);
          logger.error(
            `[Agent] Turn ${state.turnCount}: Reactive compaction failed: ${reactiveErrorMsg}`,
          );
        }
      }

      executor.discard();

      // Clean up incomplete tool_use/tool_result pairs before the next turn.
      const lastAssistantIdx = state.messages
        .map((m, i) => (m.role === 'assistant' ? i : -1))
        .filter((i) => i >= 0)
        .pop();
      if (lastAssistantIdx !== undefined && lastAssistantIdx >= 0) {
        const lastAssistant = state.messages[lastAssistantIdx];
        if (Array.isArray(lastAssistant.content)) {
          const hasUnmatchedToolUse = lastAssistant.content.some(
            (block) => block.type === 'tool_use' && 'id' in block,
          );
          if (hasUnmatchedToolUse) {
            state.messages.splice(lastAssistantIdx, 1);
          }
        }
      }

      if (error instanceof Error && error.name === 'AbortError') {
        // Synthesize tool_results for any pending tool_use blocks so the next
        // request does not 400 with a missing result.
        const lastAssistantMsg = state.messages.at(-1);
        if (
          lastAssistantMsg &&
          lastAssistantMsg.role === 'assistant' &&
          Array.isArray(lastAssistantMsg.content)
        ) {
          for (const block of lastAssistantMsg.content) {
            if (
              block.type === 'tool_use' &&
              'id' in block &&
              typeof block.id === 'string'
            ) {
              const toolId = block.id;
              const hasResult = state.messages.some(
                (m) =>
                  (m.role === 'tool' && m.tool_call_id === toolId) ||
                  (Array.isArray(m.content) &&
                    m.content.some(
                      (c: MessageContent) =>
                        c.type === 'tool_result' &&
                        'tool_use_id' in c &&
                        (c as { tool_use_id: string }).tool_use_id === toolId,
                    )),
              );
              if (!hasResult) {
                state.messages.push({
                  id: crypto.randomUUID(),
                  role: 'user',
                  content: [
                    {
                      type: 'tool_result',
                      tool_use_id: toolId,
                      content: 'Interrupted by user',
                      is_error: true,
                    },
                  ],
                  timestamp: Date.now(),
                });
              }
            }
          }
        }
        await emit({ type: 'done', reason: 'aborted' });
      } else {
        await emit({ type: 'error', data: errorMessage });
        await emit({ type: 'done', reason: 'error' });
      }
      return state;
    }
  }

  // User interrupted — the executor was already discarded per-turn.
  await emit({ type: 'done', reason: 'aborted' });
  return state;
}

/**
 * Emit the `tool_result` SSE event for a yielded tool-result message, and —
 * when the result belongs to a mode-switch tool (EnterPlanMode / ExitPlanMode
 * / SwitchMode, identified by `modeSwitchToolName`) — derive and emit the
 * accompanying `mode_changed` event so the renderer can sync its mode chip.
 */
async function emitToolResult(
  emit: (event: LoopEvent) => void | Promise<void>,
  result: MessageUpdate,
  modeSwitchToolName: string | undefined,
): Promise<void> {
  const message = result.message;
  if (!message) return;
  const messageContent = message.content;

  let toolResultId = '';
  let toolResultContent = '';
  let toolResultError = false;

  if (message.role === 'tool') {
    toolResultId = message.tool_call_id || '';
    toolResultContent =
      typeof messageContent === 'string'
        ? messageContent
        : JSON.stringify(messageContent);
    toolResultError = toolResultContent.includes('<tool_error>');
  } else {
    const contentBlock = (messageContent as MessageContent[])[0] as
      | ToolResultContent
      | undefined;
    toolResultId = contentBlock?.tool_use_id ?? '';
    toolResultContent =
      typeof contentBlock?.content === 'string'
        ? contentBlock.content
        : JSON.stringify(contentBlock?.content);
    toolResultError = contentBlock?.is_error ?? false;
  }

  await emit({
    type: 'tool_result',
    data: {
      id: toolResultId,
      name: '',
      result: toolResultContent,
      error: toolResultError,
      duration_ms: message.duration_ms,
      metadata: message.metadata,
    },
  });

  // Derive and emit `mode_changed` for a successful mode-switch tool result.
  // Failed switches leave the mode unchanged.
  const modeChanged = deriveModeChanged(
    modeSwitchToolName,
    toolResultContent,
    toolResultError,
  );
  if (modeChanged) {
    await emit({
      type: 'mode_changed',
      data: { mode: modeChanged.mode, source: 'agent', reason: modeChanged.reason },
    });
  }
}

/**
 * Derive the `mode_changed` event (if any) for a successful mode-switch tool
 * result. Pure: given the tool name and the JSON result text, it returns the
 * next runtime mode. Returns `null` when no switch applies.
 */
function deriveModeChanged(
  modeSwitchToolName: string | undefined,
  toolResultContent: string,
  toolResultError: boolean,
): { mode: AgentRuntimeMode; reason?: string } | null {
  if (!modeSwitchToolName || toolResultError) return null;
  let nextMode: AgentRuntimeMode | undefined;
  let reason: string | undefined;
  try {
    const parsed = JSON.parse(toolResultContent) as Record<string, unknown>;
    if (modeSwitchToolName === 'SwitchMode') {
      nextMode = parsed.currentMode as AgentRuntimeMode | undefined;
      reason = parsed.reason as string | undefined;
    } else if (
      modeSwitchToolName === 'EnterPlanMode' ||
      modeSwitchToolName === 'ExitPlanMode'
    ) {
      const planMode = parsed.planMode;
      nextMode = planMode ? 'plan' : 'general';
    }
  } catch {
    // Malformed JSON result — leave nextMode undefined.
  }
  if (!nextMode) return null;
  return { mode: nextMode, reason };
}

/**
 * Inject transient deferred tool contexts (collected from tool results) into
 * the model-facing payload. Mutates `llmMessages` in place; never persisted.
 */
async function injectDeferredContexts(
  llmMessages: Message[],
  state: LoopState,
): Promise<void> {
  if (state.deferredContexts.length === 0) return;
  const pending = state.deferredContexts.splice(0);
  const settled = await Promise.allSettled(
    pending.map(async (deferred) => {
      const value = await deferred.promise;
      const content =
        typeof value === 'string' ? value : JSON.stringify(value);
      return `<deferred-tool-context>\n${content}\n</deferred-tool-context>`;
    }),
  );
  for (const item of settled) {
    if (item.status !== 'fulfilled') continue;
    llmMessages.push({
      id: crypto.randomUUID(),
      role: 'user',
      content: item.value,
      timestamp: Date.now(),
      metadata: { runtimeContext: true, isDeferredToolContext: true },
    });
  }
}

/**
 * Guard: a tracked runtime-prompt message is always substituted with its own
 * content (identity replacement). Kept as a helper so the substitution map
 * stays readable; a message with no content is left untouched.
 */
function hasRuntimePromptContent(msg: Message): boolean {
  return msg.content !== undefined && msg.content !== null;
}

// Re-export for downstream consumers that want the loop's public shape.
export type { LoopEvent, LoopState, TokenUsage };