/**
 * Agent loop type contract (Plan 334, Phase 1).
 *
 * This module defines the PURE types shared across the four-layer agent
 * architecture (DuyaAgent -> agent-loop -> session -> agents). It contains
 * ONLY type declarations — no implementation logic and no imports of
 * concrete classes — so it can be imported by every layer without creating
 * a dependency cycle.
 *
 * The "ports" (AgentDeps, AgentLoopConfig callbacks, LoopState fields) are
 * contracts that the concrete session / agent-loop layers implement and
 * inject; DuyaAgent only knows these shapes.
 */

import type {
  AgentProgressEvent,
  AgentRuntimeMode,
  CanvasFreshnessState,
  Message,
  MessageContent,
  SSEEvent,
  Tool,
  TokenUsage,
  ToolResult,
  ToolUse,
  WidgetStyleSignature,
} from '../types.js';

/**
 * Events yielded by the streaming agent loop. Refined from {@link SSEEvent}
 * to the variants the loop itself produces (the low-level provider events the
 * loop passes through, plus the loop's own `turn_start` / `mode_changed` /
 * `done` events). `mode_changed.mode` is narrowed to {@link AgentRuntimeMode}
 * (SSEEvent leaves it as `string`).
 */
export type LoopEvent =
  | Extract<SSEEvent, { type: 'turn_start' }>
  | Extract<SSEEvent, { type: 'text' }>
  | Extract<SSEEvent, { type: 'thinking' }>
  | Extract<SSEEvent, { type: 'tool_use'; data: ToolUse }>
  | Extract<SSEEvent, { type: 'tool_result'; data: ToolResult }>
  | Extract<SSEEvent, { type: 'agent_progress'; data: AgentProgressEvent }>
  | Extract<SSEEvent, { type: 'tool_progress' }>
  | Extract<SSEEvent, { type: 'tool_timeout' }>
  | Extract<SSEEvent, { type: 'result'; data: TokenUsage }>
  | Extract<SSEEvent, { type: 'error' }>
  | Extract<SSEEvent, { type: 'done' }>
  | {
      type: 'mode_changed';
      data: { mode: AgentRuntimeMode; source: 'agent' | 'user'; reason?: string };
    };

/**
 * Mutable per-round state the streaming loop carries across turns. Mirrors the
 * local variables of the current `streamChat` while-loop so the refactored
 * loop can be a pure function of (state, event) rather than a closure over
 * DuyaAgent's private fields.
 */
export interface LoopState {
  /** Durable provider-shaped message history (user/assistant/tool roles). */
  messages: Message[];
  /** System prompt for the current turn (may grow across turns). */
  systemPromptContent: string;
  /** Model-visible tool definitions for the current turn. */
  tools: Tool[];
  /** Tool names discovered via `tool_search` and surfaced next turn. */
  discoveredTools: Set<string>;
  /** Deferred tool contexts collected from tool results, injected next turn. */
  deferredContexts: Array<{
    toolUseId: string;
    toolName: string;
    promise: Promise<unknown>;
  }>;
  /** 1-based turn counter for the current streamChat call. */
  turnCount: number;
  /** True when the current turn produced tool_use blocks (loop continues). */
  needsFollowUp: boolean;
  /** Message id of the runtime prompt (used to substitute model-facing content). */
  runtimePromptMessageId: string | null;
  /** tool_use ids of mode-switch tools, emitted as `mode_changed` on result. */
  modeSwitchToolIds: Map<string, string>;
}

/**
 * Result returned by `AgentLoopConfig.prepareNextTurn` to override the next
 * turn's runtime state. All fields are optional; omitted fields keep the
 * current values.
 */
export interface TurnUpdate {
  /** Replacement system prompt for the next turn. */
  systemPromptContent?: string;
  /** Replacement tool list for the next turn. */
  tools?: Tool[];
  /** Replacement model id for the next turn. */
  model?: string;
  /** Replacement thinking/effort level for the next turn. */
  thinkingLevel?: string;
  /** Replacement turn counter for the next turn. */
  turnCount?: number;
}

/**
 * Port: the streaming LLM call. Modeled on `llmClient.streamChat` so the
 * concrete session layer can supply the real client (or a stub in tests).
 */
export interface LoopStreamFunction {
  (
    messages: Message[],
    options?: {
      systemPrompt?: string;
      tools?: Tool[];
      maxTokens?: number;
      temperature?: number;
      signal?: AbortSignal;
      effort?: string;
    },
  ): AsyncGenerator<LoopEvent, void, unknown>;
}

/**
 * Callback contract for the streaming agent loop (Phase 1 type contract;
 * concrete implementations are injected by the agent-loop/session layer).
 *
 * Modeled on pi's `AgentLoopConfig` and adapted to duya's SSE-based stream
 * model. Every callback is a "port" — the loop only knows these signatures.
 */
export interface AgentLoopConfig {
  /**
   * Converts `Message[]` to the LLM-compatible `Message[]` before each
   * provider call. Must not throw; return a safe fallback instead.
   */
  convertToLlm: (messages: Message[]) => Message[] | Promise<Message[]>;
  /**
   * Optional transform applied before `convertToLlm` (context-window
   * pruning, external context injection). Must not throw.
   */
  transformContext?: (messages: Message[], signal?: AbortSignal) => Promise<Message[]>;
  /**
   * The streaming LLM call. Returns an async generator of {@link LoopEvent}.
   */
  streamFunction: LoopStreamFunction;
  /**
   * Optional pre-execution hook for a tool call. Return `{ block: true }`
   * to prevent execution; `reason` becomes the text of the error result.
   */
  beforeToolCall?: (
    tool: ToolUse,
    signal?: AbortSignal,
  ) => Promise<{ block?: boolean; reason?: string } | undefined>;
  /**
   * Returns steering messages to inject mid-run after the current turn's tool
   * calls finish. Return `[]` when none are available.
   */
  getSteeringMessages?: () => Promise<Message[]>;
  /**
   * Returns follow-up messages to process after the agent would otherwise
   * stop. Return `[]` when none are available.
   */
  getFollowUpMessages?: () => Promise<Message[]>;
  /**
   * Called after each turn completes. Return a {@link TurnUpdate} to override
   * the next turn's runtime state, or `undefined` to keep the current state.
   */
  prepareNextTurn?: (
    state: LoopState,
  ) => TurnUpdate | undefined | Promise<TurnUpdate | undefined>;
  /**
   * Called after each turn; when true the loop stops before another provider
   * request, even if the model requested more tool calls.
   */
  shouldStopAfterTurn?: (state: LoopState) => boolean | Promise<boolean>;
  /** Maximum number of turns before the loop stops. Default: 100. */
  maxTurns?: number;
  /** Abort signal that cancels the whole run when aborted. */
  abortSignal: AbortSignal;
}

// ─── Agent ports (injected by the session layer, never implemented here) ───

/**
 * Port: tool registry. Minimal surface the loop needs to resolve tool
 * definitions, executors, and visibility.
 */
export interface LoopRegistryPort {
  getTool(name: string): Tool | undefined;
  getExecutor(name: string): unknown;
  getExposeMode(name: string): unknown;
  has(name: string): boolean;
  getOwner?(name: string): 'non-mcp' | 'mcp' | undefined;
  getMeta?(name: string): { exposeMode?: unknown; riskTier?: unknown } | undefined;
  register?(tool: Tool, executor?: unknown): void;
}

/**
 * Port: compaction controller. Bridges proactive/reactive context compaction
 * into the loop.
 */
export interface LoopCompactionControllerPort {
  shouldCompact(): boolean;
  compactProactive(options?: { strategy?: string }): Promise<unknown>;
  compactReactive(
    triggerError?: 'prompt_too_long' | 'context_length_exceeded' | 'manual_trigger',
  ): Promise<unknown>;
}

/**
 * Port: mailbox (background-task / user-guidance queue). Consumed at the loop
 * checkpoints so queued rows are absorbed into the message history.
 */
export interface LoopMailboxPort {
  claimBatch(input: {
    sessionId: string;
    runId: string;
    checkpoint: 'before_model_turn' | 'before_final_answer';
    limit: number;
  }): Promise<{ rows: unknown[]; claimTokens: unknown[] }>;
  apply(input: {
    id: string;
    claimToken: unknown;
    mode: string;
    checkpoint: 'before_model_turn' | 'before_final_answer';
    summary: string;
  }): Promise<unknown>;
}

/**
 * Port: mode-modifier prompt refresh. Rebuilds the current turn's system
 * prompt against the latest mode state (e.g. conductor's rolling
 * widget-style history) without re-running mode `onEnter` hooks.
 */
export interface LoopModeRefreshPort {
  refresh(systemPromptContent: string, turnCount: number): Promise<string>;
}

/**
 * Port: tool permission gate. Fail-closed: an unknown/errored state must not
 * let a tool execute.
 */
export interface LoopPermissionPort {
  canUseTool(
    toolName: string,
    toolInput?: Record<string, unknown>,
  ): Promise<{ allowed: boolean; behavior: string }>;
}

/**
 * Port: per-session mutable canvas state shared across tool calls and turns.
 * Held as a stable reference so Executor per-call shallow copies share state.
 */
export interface LoopCanvasStatePort {
  widgetStyleHistory: WidgetStyleSignature[];
  canvasFreshness: CanvasFreshnessState;
}

/**
 * The set of dependencies the streaming loop depends on, all interface-ized so
 * the concrete session layer can inject real implementations (or test doubles).
 * Contains no concrete classes — only ports.
 */
export interface AgentDeps {
  /** The streaming LLM client. */
  llmClient: LoopStreamFunction | { streamChat: LoopStreamFunction };
  /** Tool registry resolving definitions / executors / visibility. */
  registry: LoopRegistryPort;
  /** Compaction controller for proactive/reactive context compaction. */
  compactionController: LoopCompactionControllerPort;
  /** Mailbox queue for background tasks and user guidance. */
  mailbox: LoopMailboxPort;
  /** Mode-modifier prompt refresh. */
  modeRefresh: LoopModeRefreshPort;
  /** Tool permission gate. */
  permission: LoopPermissionPort;
  /** Per-session mutable canvas state. */
  canvasState: LoopCanvasStatePort;
}

/**
 * Re-export the concrete message-content type for convenience so consumers of
 * this contract module do not need to reach into `../types.js` for the loop's
 * message payload shape.
 */
export type { MessageContent };