/**
 * duya Agent 核心类型定义
 */

// Import AgentDefinition from loadAgentsDir for unified access
import type { AgentDefinition } from './tool/SubagentTool/loadAgentsDir.js';
import type { PermissionMode, LocalToolPermission } from './permissions/types.js';

// Re-export shared types from @duya/ai (spec §6.1).
// The definitions have been migrated to packages/ai/src/types.ts
// to break the circular dependency between packages/agent and packages/ai.
// @duya/ai versions are supersets: all original fields preserved + new
// signature fields (textSignature, thinkingSignature, thoughtSignature, etc.)
import type {
  MessageRole,
  TextContent,
  ImageContent,
  ToolUseContent,
  ToolResultContent,
  ThinkingContent,
  MessageContent,
  Message,
  AssistantMessage,
  ToolUse,
  ToolResult,
  ToolResultMetadata,
  SSEEvent,
  PermissionRequestEvent,
  TokenUsage,
  UsageCall,
  AgentProgressEvent,
  StopReason,
  ProviderRuntimeConfig,
  LLMProvider,
} from '@duya/ai';

export type {
  MessageRole,
  TextContent,
  ImageContent,
  ToolUseContent,
  ToolResultContent,
  ThinkingContent,
  MessageContent,
  Message,
  AssistantMessage,
  ToolUse,
  ToolResult,
  ToolResultMetadata,
  SSEEvent,
  PermissionRequestEvent,
  TokenUsage,
  UsageCall,
  AgentProgressEvent,
  StopReason,
};

/**
 * Runtime agent mode controlled by SwitchModeTool / EnterPlanModeTool /
 * ExitPlanModeTool. Orthogonal to ModeModifierId (popover plan-task) and
 * AgentProfile (main/code/plan sub-agent). Mirrors `AgentMode` in
 * `tool/SwitchModeTool/constants.ts` — kept here as a top-level type so
 * the SSEEvent union can reference it without a circular import.
 */
export type AgentRuntimeMode = 'general' | 'plan' | 'explore' | 'verify' | 'code-review';

// 工具定义
export interface Tool {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
  /**
   * MCP tool annotations (https://modelcontextprotocol.io/specification).
   * Only MCP tools carry these; builtin tools leave the field undefined.
   * Propagated from `tools/list` to the `mcp:status:snapshot` SSE event
   * so the settings UI can warn about destructive / open-world tools
   * before the model invokes them.
   */
  annotations?: {
    readOnly?: boolean;
    destructive?: boolean;
    openWorld?: boolean;
    [key: string]: unknown;
  };
  /**
   * ToolRegistry internal index key. Optional. Only MCP tools set
   * this; builtin tools have `key === name` and leave the field
   * undefined. Format: `mcp__<scopedServerName>__<toolName>`.
   *
   * Phase 2A Batch A: field declared but not yet consumed. Batch B
   * will wire `MCPClient.getAllTools` and `ToolRegistry.register`
   * to use it.
   */
  internalKey?: string;
  /**
   * Explicit provider-visible name. Optional. Only MCP tools set
   * this; equals `name` in practice. Kept as a separate field to
   * express intent. The provider payload sends `tool.name`, which
   * for MCP equals this `providerName`.
   *
   * Phase 2A Batch A: field declared but not yet consumed.
   */
  providerName?: string;
  /**
   * Future UI display name. Phase 2A does NOT consume it; the
   * field is declared so Phase 4 (renderer) can rely on it
   * without re-shaping the type.
   */
  displayName?: string;
  /**
   * MCP dispatch metadata. Only MCP tools set this. Used by the
   * `executor` closure to call
   * `mcpManager.callTool(mcpInfo.serverName, mcpInfo.toolName, input)`
   * and by the runtime permission gate (`permissions.ts` /
   * `decideMcpSource`) to classify the tool's provenance.
   *
   * `source` is the gate's `McpToolSource` bucket:
   *   - 'bundled'  : first-party / bootstrap fallback
   *   - 'plugin'   : installed from marketplace
   *   - 'settings' : user-configured in settings / agentSettings / kv
   *   - 'local'    : reserved for manually-installed-from-path
   *                  (not emitted by the current resolution engine)
   *   - 'unknown'  : defensive default for any tool missing the field
   */
  mcpInfo?: { serverName: string; toolName: string; source: 'bundled' | 'plugin' | 'local' | 'settings' | 'unknown' };
}

// Vision model configuration
export interface VisionConfig {
  provider: string;
  model: string;
  baseURL: string;
  apiKey: string;
  enabled: boolean;
}

// Dedicated compaction model configuration (grok `compact_model`).
// When enabled, compaction summaries run on this model instead of the main
// model; otherwise the main client is used.
export interface CompactModelConfig {
  provider: string;
  model: string;
  baseURL: string;
  apiKey: string;
  enabled: boolean;
}

// Agent 配置选项
export interface AgentOptions {
  apiKey: string;
  baseURL?: string;
  model?: string;
  workingDirectory?: string;
  systemPrompt?: string;
  maxTokens?: number;
  temperature?: number;
  /** Authentication style: 'api_key' uses X-Api-Key, 'auth_token' uses Bearer token */
  authStyle?: 'api_key' | 'auth_token';
  /** LLM provider protocol: 'anthropic' or 'openai' (OpenAI-compatible) */
  provider?: LLMProvider;
  /** Session ID for task tracking and persistence */
  sessionId?: string;
  /** Permission mode for tool execution: 'default', 'bypass', 'dontAsk', 'plan' */
  permissionMode?: PermissionMode;
  /**
   * Plan 487: host-level standing permission switch (default 'ask').
   * Injected from electron main on every agent process spawn / reinit.
   */
  hostToolPermission?: LocalToolPermission;
  /** Communication platform type for prompt injection */
  communicationPlatform?: import('./prompts/types.js').CommunicationPlatform;
  /** Skip the first-turn AGENTS.md user-message injection entirely. Used by
   *  read-only sub-agents whose agent definition sets omitClaudeMd: true. */
  omitAgentsMd?: boolean;
  /** Enable automatic retry with exponential backoff for API failures */
  enableRetry?: boolean;
  /** Retry configuration (only used when enableRetry is true) */
  retryConfig?: import('@duya/ai').RetryConfig;
  /** Vision model configuration for image understanding */
  visionConfig?: VisionConfig;
  /** Dedicated compaction model configuration. When enabled, compaction uses
   *  this model instead of the main model. */
  compactModelConfig?: CompactModelConfig;
  /** Blocked domains for browser tool */
  blockedDomains?: string[];
  /** Browser backend mode: 'auto' | 'extension' | 'built-in' | 'human-like' */
  browserBackendMode?: 'auto' | 'extension' | 'built-in' | 'human-like';
  /** Language preference for agent responses (e.g. 'Chinese', 'English') */
  language?: string;
  /** Default workspace directory for permission checking. Defaults to ~/.duya/workspace */
  defaultWorkspaceDirectory?: string;
  /**
   * Optional user-defined permission rules (allow/deny/ask/additional directories).
   * Mirrors the shape expected by `permissionsLoader.settingsJsonToRules`.
   * Currently only consumed by CLI / headless callers; the renderer does not
   * yet expose a UI for editing these rules.
   */
  permissionRules?: {
    permissions?: {
      allow?: string[];
      deny?: string[];
      ask?: string[];
      additionalDirectories?: string[];
    };
  };
  /**
   * Phase 2: optional ProviderRuntimeConfig. When present, the agent
   * SHOULD prefer `apiFormat` / `headers` from this object over the
   * legacy `provider` discriminator. New code paths should treat
   * this as the authoritative source.
   */
  runtimeConfig?: ProviderRuntimeConfig;
}

// 对话选项
export interface ChatOptions {
  systemPrompt?: string;
  /**
   * Observes the fully assembled prompt immediately before a provider request.
   * Observers must not throw or affect the agent execution path.
   */
  onSystemPromptReady?: (snapshot: {
    systemPrompt: string;
    /**
     * Provider-facing tool definitions for this exact request. This can change
     * between turns after `tool_search` discovers an on-demand tool.
     */
    tools: Array<Pick<Tool, 'name' | 'description' | 'input_schema'>>;
    turn: number;
    /**
     * Cache plan fingerprint for this exact request. Stable across turns
     * when the stable prefix (system prompt + tool surface) is unchanged,
     * so observers can detect a reachable provider cache breakpoint.
     */
    cachePlan: { fingerprint: string };
  }) => void;
  tools?: Tool[];
  toolRegistry?: import('./tool/registry.js').ToolRegistry;
  maxTokens?: number;
  temperature?: number;
  parentMessageId?: string;
  /**
   * Plan 486: thread/fork branched-layer reference. When set on a streamChat
   * user turn, the new user message is marked as a reply to the referenced
   * message (which must already exist in this session's timeline — an unknown
   * target is silently stripped, mirroring grok `stripReplyTo`). Combined with
   * `branched: true` this starts/continues a thread: the message enters the
   * branched layer and is excluded from the main timeline and main model
   * context. `branched` without a valid `replyToId` is ignored.
   */
  replyToId?: string;
  /**
   * Plan 486: true = the reply starts a fork / belongs to a thread's branched
   * layer. Only meaningful together with `replyToId`.
   */
  branched?: boolean;
  /** Maximum number of agent turns (LLM calls) before stopping. Default: 100 */
  maxTurns?: number;
  /**
   * Plan 441: turn id for the per-event journal. Propagated to every
   * `_pushDurable` boundary so the rollout events that the journal emits
   * (`user_msg_added`, `assistant_message_finalized`, `tool_result_added`)
   * carry the same turn id as the messages themselves. Optional — when
   * omitted, journal events are emitted with `turnId: null` and the storage
   * layer's `message_index.turn_id` column is left null for that row.
   */
  turnId?: string | null;
  /**
   * Anti-dead-loop guard. Tracks consecutive identical tool calls across
   * turns (signature = tool name + serialized input). At `nudgeAt` a steering
   * message is injected to steer the model; at `hardStopAt` the loop stops
   * with `done.reason = 'repeated_tool_calls'`. Enabled by default.
   */
  antiDeadLoop?: {
    enabled?: boolean;
    /** Consecutive identical calls before a steering message is injected. Default: 8. */
    nudgeAt?: number;
    /** Consecutive identical calls before a stronger "change approach" nudge is injected. Default: 12. */
    hardNudgeAt?: number;
    /** Consecutive identical calls before the loop hard-stops. Default: 16. */
    hardStopAt?: number;
  };
  /**
   * Todo gate. When the agent would otherwise finish but pending/in-progress
   * tasks remain, inject a steering message asking the model to continue
   * instead of stopping. Only triggers when pending tasks exist. Enabled by
   * default.
   */
  todoGate?: {
    enabled?: boolean;
  };
  /**
   * Plan 418 L2: tool-intent / action-consistency guard. When the model ends
   * a turn with a tool-intent statement but emitted no tool_use, a steering
   * message is injected so the turn continues instead of finalizing. Capped
   * per streamChat call. Default: 2.
   */
  toolIntentNudgeMax?: number;
  /**
   * Plan 426: ids of builtin loop hooks to skip for this run (e.g.
   * "builtin.premature-stop", "builtin.todo-gate"). Disabled hooks are not
   * registered, so they cannot fire. Default: none.
   */
  disabledLoopHooks?: string[];
  /** Message history for context. If provided, uses this instead of internal messages */
  messages?: Message[];
  /**
   * Callback for requesting user permission.
   * Returns a Promise that resolves with 'allow', 'deny', or 'paused'
   * (plan 498: the request was persisted as an approval card and the turn
   * must end with a neutral tool result instead of blocking).
   */
  requestPermission?: (request: PermissionRequestEvent) => Promise<'allow' | 'deny' | 'paused'>;
  /**
   * Plan 498: one-shot approval ledger. Called at the top of `canUseTool`;
   * when it returns true the pending tool call was pre-approved through a
   * persisted approval card (approved → consumed CAS) and must run without
   * further permission checks.
   */
  consumeApprovedEffect?: (
    toolName: string,
    toolInput?: Record<string, unknown>,
  ) => Promise<boolean>;
  /**
   * Plan 498: tool names granted via "Always allow this tool" on a persisted
   * approval card. Scoped per bot/session by the caller; applied verbatim
   * (tool-level allow) for the turns of this run.
   */
  approvedAlwaysAllowTools?: string[];
  /** Agent profile ID to use for this chat turn */
  agentProfileId?: string | null;
  /**
   * Plan 477/497: true for hidden wake runs (background notification / bot→bot
   * DM). The wake prompt is model context only — the persisted user row is
   * tagged source 'system' so it never surfaces in the bot-direct chat (the
   * visible row is the agent_dm marker written by the dispatcher).
   */
  wakeRun?: boolean;
  /**
   * Plan 450: providers the user @-mentioned in the composer for this run.
   * Connector tools of these providers skip tool_search discovery (exposure
   * promotion) and a one-shot connector-activation reminder is injected into
   * the first model turn. Cleared implicitly per streamChat call.
   */
  mentionedProviders?: string[];
  /**
   * Plan 450 Phase H: skills whose `/name` command the user submitted this
   * run. Resolved against the skill registry and injected as `<skill>`
   * fragments (SKILL.md body) into the first model turn — codex
   * `UserInput::Skill` parity. Never trust paths from the renderer; the
   * registry owns the lookup.
   */
  mentionedSkills?: string[];
  /**
   * Plugins the user @-mentioned in the composer for this run (the `@`
   * popover lists installed plugins). The renderer resolves each plugin's
   * declared app connectors / MCP servers / skills and transports them as
   * structured data; the agent injects a one-shot `<plugin-activation>`
   * block telling the model to prefer those capabilities for the turn.
   * Connected app connectors of mentioned plugins ALSO flow into
   * `mentionedProviders` (renderer side), so their tools get exposure
   * promotion through the existing connector pipeline.
   */
  mentionedPlugins?: Array<{
    pluginId: string;
    name: string;
    description?: string;
    appConnections: string[];
    mcpServers: string[];
    skillNames: string[];
  }>;
  /** Mode modifier ID for this chat turn (for example, 'research'). */
  mode?: string;
  /**
   * Mark this chat turn's session transcript as excluded from Stage 1
   * memory extraction. Used by the Phase 2 curator agent (design §7.4)
   * so the curator's own tool calls and reasoning do not get fed back
   * into Stage 1 as new memory — a self-referential loop. The Stage 1
   * extractor filters out sessions whose row carries this flag.
   */
  excludeFromStage1?: boolean;
  /** Output style configuration for this chat turn */
  outputStyleConfig?: { name: string; prompt: string; keepCodingInstructions?: boolean };
  /**
   * User-facing content to store in DB instead of `prompt`.
   * When set, `prompt` is sent to the LLM (may include synthetic context like parsed docs),
   * while `displayContent` is stored as the user message in the database for rendering.
   */
  displayContent?: string;
  /** File attachments to store on the user message in DB */
  attachments?: FileAttachment[];
  /** IPC functions for conductor executor communication */
  conductorIpc?: {
    sendToMain: (msg: Record<string, unknown>) => void;
    ipcRequest: <T = unknown>(
      channel: string,
      payload: unknown,
      options?: { timeout?: number }
    ) => Promise<{ success: boolean; data?: T; error?: { code: string; message: string } }>;
  };
  /** List of tool names to disable for this chat turn */
  disabledTools?: string[];
  /**
   * Caller-supplied allowlist of tool names permitted for this chat turn.
   * When set, only tools whose `name` is in this list are exposed to the LLM.
   * Applied as Layer 0 (before `disabledTools` and agent profile policy),
   * so it is the most restrictive filter. Used by interagent `minimal` mode
   * to lock the target agent down to Read/Grep/Glob.
   */
  allowedTools?: string[];
  /** If true, skip system prompt entirely (use empty string) */
  disableSystemPrompt?: boolean;
  /** Prefix to prepend to the system prompt */
  systemPromptPrefix?: string;
  /** Optional research intent for research prompt assembly */
  researchIntent?: import('./prompts/research/types.js').ResearchTaskIntent;
  /** Optional research project ID for context selection */
  researchProjectId?: string;
  /**
   * Anthropic thinking effort level (Low/Medium/High/Max).
   * undefined/Auto omits the `thinking` field in the request.
   * Mapped to `thinking.budget_tokens` by the Anthropic LLM client.
   */
  effort?: string;
  /**
   * Conductor mode — per-turn trusted override. When true, the agent
   * registers the 5 canvas conductor tools (canvas_move_element /
   * canvas_resize_element / canvas_fill_content /
   * canvas_style_element / canvas_capture) and injects the conductor
   * prompt overlay into the system prompt. The canvasId is bound
   * separately via conductorCanvasId.
   */
  conductorMode?: boolean;
  /**
   * Conductor canvas ID — durable binding from the session row.
   * Injected into ToolUseContext.conductorCanvasId so canvas tools
   * know which canvas to operate on. Only effective when
   * conductorMode is true.
   */
  conductorCanvasId?: string;
  /**
   * Internal follow-up turn triggered when a background sub-agent reaches a
   * terminal state. It consumes queued task notifications without adding an
   * empty synthetic user message to the conversation history.
   */
  backgroundTaskResume?: boolean;
  /**
   * Wall-clock timeout (ms) for a single LLM request in this chat turn.
   * When set, each streamChat LLM call is aborted after this duration even
   * while the stream is still producing data (e.g. a long-running thinking
   * stream), so a hung call fails the turn fast instead of burning the run
   * budget. Optional; absent = no per-request cap.
   */
  llmRequestTimeoutMs?: number;
  /**
   * Renderer-minted id of this user send. The persisted user row reuses this
   * id so the renderer can dedupe its optimistic bubble by id regardless of
   * timestamp drift (e.g. a queued bot turn). Absent for CLI / agent-spawned
   * runs — those fall back to a fresh server UUID.
   */
  clientMsgId?: string;
  /**
   * Plan 445: mutable reference the agent loop READS at the `done` event
   * boundary to know the cumulative tokenUsage block (with `last_call`
   * sub-block) it should attach to the final assistant message before
   * journal.assistantMsgFinalized fires. The caller (typically
   * agent-process-entry) updates this reference inside its own for-await
   * loop on every `result` event; the agent loop yields `done` AFTER every
   * `result` for the final call, so the reference is guaranteed to hold
   * the per-turn sum by the time the agent reads it.
   *
   * Why this exists: without it, the journal persisted the SINGLE-call
   * `usageBlock` derived from `roundResultUsage` (the largest prompt of
   * the turn) — losing the turn-cumulative sum and the `last_call` sub-
   * block. On reload, the persisted scan had to fall back to the
   * single-call value, undershooting session-level cumulative metrics and
   * breaking the persisted anchor (which prefers `last_call`).
   */
  cumulativeTokenUsageRef?: { current: TokenUsage | null };
}

// 会话信息
export interface SessionInfo {
  id: string;
  createdAt: number;
  updatedAt: number;
  messageCount: number;
}

// MCP 服务器配置
export interface MCPServerConfig {
  name: string;
  /**
   * Local stdio transport command. Required when `transport` is omitted or
   * set to `stdio`; forbidden for remote transports.
   */
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  /**
   * MCP transport. Stdio remains the backwards-compatible default.
   * Streamable HTTP is the current remote MCP transport standard.
   */
  transport?: 'stdio' | 'streamable-http';
  /** HTTPS endpoint for a `streamable-http` server. */
  url?: string;
  /**
   * Request headers supplied by the credential broker at runtime. Plugin
   * manifests must never contain literal credentials in this field.
   */
  headers?: Record<string, string>;
  allowedAgentIds?: string[];
  /**
   * Source bucket for the runtime permission gate. Set by
   * `applyMCPConfiguration` from the `ResolvedMCPServerConfig.source`
   * (`'bundled'` | `'plugin'` | `'settings'`). `'local'` is reserved
   * for manually-installed-from-path servers (not emitted by the
   * current resolution engine). When absent, the gate treats the
   * tool as `unknown` and prompts.
   */
  source?: 'bundled' | 'plugin' | 'local' | 'settings' | 'unknown';
  /**
   * Env passthrough mode for stdio subprocesses.
   *
   * - `'allowlist'` (default): only safe baseline env vars (PATH, HOME,
   *   USER, etc.) plus user-configured `env` are passed to the subprocess.
   *   Prevents accidental secret leakage to untrusted MCP servers.
   * - `'inherit'`: legacy mode, passes the full `process.env` plus
   *   user-configured `env`. Reserved for trusted bundled servers that
   *   depend on inherited env vars. Not recommended for plugin/local sources.
   *
   * See `buildSafeEnv` in `mcp/security.ts`.
   */
  envPassthrough?: 'allowlist' | 'inherit';
  /**
   * Short, stable prefix used for model-visible tool names. When set,
   * provider names become `mcp_<nameOverride>_<toolName>` instead of the
   * longer `mcp_<scopedServerName>_<toolName>`. Keeps tool names short and
   * stable even for deeply-scoped plugin servers.
   */
  nameOverride?: string;
  /** Startup (spawn + handshake + listTools) timeout in seconds. */
  startupTimeoutSec?: number;
  /** Default per-tool-call timeout in seconds for this server. */
  toolTimeoutSec?: number;
  /** Per-tool-call timeout overrides, keyed by tool name, in seconds. */
  toolTimeouts?: Record<string, number>;
  /**
   * When true, spawn the stdio subprocess through a shell
   * (`cmd.exe /c` on Windows, `sh -c` on Unix) so the command string is
   * parsed like a shell invocation. Only honored when `transport` is
   * `stdio`. Set this if your command uses shell features (pipes,
   * globs, variable expansion); leave it false for plain argv-style
   * commands.
   */
  useShell?: boolean;
  /**
   * Sampling rate limit config. Applied when an MCP server requests
   * `sampling/createMessage` (reverse LLM call). Defaults are conservative
   * (10 rpm, 4096 maxTokens, 5 tool rounds) to bound the blast radius of a
   * malicious or buggy server.
   *
   * See `SamplingRateLimiter` in `mcp/security.ts`.
   */
  sampling?: SamplingRateLimitConfig;
}

/**
 * Sampling rate limit configuration for a single MCP server.
 * See `mcp/security.ts` for the full semantics.
 */
export interface SamplingRateLimitConfig {
  /** Max sampling requests per minute (sliding window). Default 10. */
  maxRpm?: number;
  /** Hard cap on maxTokens per sampling request. Default 4096. */
  maxTokensCap?: number;
  /**
   * Max tool-use rounds within a single sampling request. 0 disables tool
   * loops entirely. Default 5.
   */
  maxToolRounds?: number;
}

// MCP 连接状态
export type MCPConnectionStatus = 'disconnected' | 'connecting' | 'connected' | 'error';

// 文件附件
export interface FileAttachment {
  id: string;
  /**
   * Discriminator carried through from the renderer (e.g. 'pasted-text',
   * 'terminal-ref', 'browser-ref', 'file-tree-ref', 'file', 'image').
   * Optional for backward compat; absent kinds default to 'file'.
   */
  kind?: string;
  name: string;
  type: string;
  url: string; // data URL, blob URL, or file path
  size: number;
  /** Absolute file path for document files (pdf, docx, etc.) */
  path?: string;
  /** Parsed text content for document files */
  text?: string;
  /** Extraction method for parsed documents */
  extractMethod?: 'text' | 'vision' | 'hybrid';
  /** Image chunks from OCR/vision extraction */
  imageChunks?: Array<{ base64: string; mediaType: string }>;
  /** Thumbnail preview for document files (base64 data URL) */
  thumbnail?: string;
}

// 会话选项扩展
export interface ChatRequestBody {
  sessionId: string;
  content?: string;
  files?: FileAttachment[];
  effort?: string;
  badge?: string;
  model?: string;
  systemPrompt?: string;
}

// ToolUseContext - context passed to tools when executing
export interface ToolUseContext {
  toolUseId: string;
  getAppState: () => AppState;
  setAppState: (f: (prev: AppState) => AppState) => void;
  abortController: AbortController;
  options: ToolUseContextOptions;
  pushApiMetricsEntry?: (ttftMs: number) => void;
  /**
   * Called when a tool requires user permission.
   * Returns a Promise that resolves with 'allow', 'deny', or 'paused'
   * (plan 498 — persisted approval card; see ChatOptions.requestPermission).
   */
  requestPermission?: (request: PermissionRequestEvent) => Promise<'allow' | 'deny' | 'paused'>;
  /** Plan 498: one-shot approval ledger consume (see ChatOptions). */
  consumeApprovedEffect?: (
    toolName: string,
    toolInput?: Record<string, unknown>,
  ) => Promise<boolean>;
  /** Plan 498: "Always allow this tool" grants for this run (see ChatOptions). */
  approvedAlwaysAllowTools?: string[];
  /**
   * Called by the Agent tool to report sub-agent execution progress in real-time.
   * This allows the UI to show what the sub-agent is doing while it runs.
   */
  reportAgentProgress?: (event: AgentProgressEvent) => void;
  /**
   * @deprecated 向主进程发起单向消息。新代码应使用 ipcRequest 获得响应。
   */
  sendToMain?: (msg: Record<string, unknown>) => void;
  /**
   * 向主进程发起 IPC 请求并等待响应。
   * 用于 executor 需要获取实时数据（如 snapshot）或提交操作并获取结果。
   */
  ipcRequest?: <T = unknown>(
    channel: string,
    payload: unknown,
    options?: { timeout?: number }
  ) => Promise<{ success: boolean; data?: T; error?: { code: string; message: string } }>;
  /**
   * Conductor mode: bound canvas ID. Injected when ChatOptions.conductorMode
   * is true. Canvas tools read this instead of receiving canvasId from LLM
   * input, so the model never needs to track canvas state.
   */
  conductorCanvasId?: string;
  /**
   * Mutable target shared by every canvas tool call in the current turn.
   * `canvas_manage` updates this object after a successful switch so later
   * calls immediately operate on the new canvas despite context spreading.
   */
  canvasTarget?: CanvasTargetState;
  /**
   * Optional callback for canvas tools to propagate a canvasId change back
   * to the owning mode modifier's persistent state. Used by canvas_manage
   * after a successful switch/create-with-switchTo so the next turn's
   * toolUseContextPatch.conductorCanvasId reflects the new target.
   */
  updateModeCanvasId?: (canvasId: string) => void;
  /**
   * Mutable, per-session canvas state shared across tool calls within a turn
   * and across turns. MUST be a stable reference object: StreamingToolExecutor
   * spreads ToolUseContext per call (creating a shallow copy with a new
   * toolUseId), so any field written directly on the context (e.g.
   * `context.lastListElementsTime = ...`) would land on the throwaway copy
   * and be lost on the next call. Concentrating the mutable state inside a
   * single referenced object lets every spread copy observe and mutate the
   * same underlying state.
   */
  canvasFreshness?: CanvasFreshnessState;
  /**
   * Recent widget/dynamic style signatures used for anti-slop diversity.
   * Canvas tools append to this history so the conductor prompt can nudge
   * the model toward different color palettes, fonts, and layouts.
   */
  widgetStyleHistory?: WidgetStyleSignature[];
  /**
   * Plan 536: project entity resolved from the session's workingDirectory.
   * Injected by session bootstrap from `projects.paths` reverse lookup.
   * Tools whose primary key is a projectId (e.g. the plan tool) read this
   * as a fallback when the model omits the projectId from its input.
   * null when the session is not bound to any known project.
   */
  currentProjectId?: string | null;
}

/**
 * Shared mutable canvas state. Stored as a reference on ToolUseContext so
 * StreamingToolExecutor's per-call shallow spread does not lose writes.
 */
export interface CanvasFreshnessState {
  /** Timestamp (ms) of the last successful canvas_list_elements call. */
  lastListElementsTime?: number;
  /**
   * Element IDs created by the agent in this session. Populated by
   * canvas_create_element. Used by the freshness
   * check so the agent can fill/style/move an element it just created
   * without re-calling canvas_list_elements.
   */
  recentlyCreatedElementIds: Set<string>;
}

export interface CanvasTargetState {
  canvasId?: string;
  canvasName?: string;
}

/** Style signature captured from a widget/dynamic element's sourceCode. */
export interface WidgetStyleSignature {
  backgroundColor?: string;
  textColor?: string;
  fontFamily?: string;
  layoutType?: string;
}

export interface ToolUseContextOptions {
  recentImageAttachments?: Array<{
    name: string;
    path?: string;
    url?: string;
    type: string;
  }>;
  tools: Tool[];
  commands: Command[];
  debug?: boolean;
  verbose?: boolean;
  mainLoopModel: string;
  mcpClients: MCPServerConnection[];
  mcpResources?: MCPResource[];
  agentDefinitions?: {
    activeAgents: AgentDefinition[]
    allAgents: AgentDefinition[]
  };
  isNonInteractiveSession?: boolean;
  appendSystemPrompt?: string;
  // Session context
  sessionId?: string;
  /**
   * Plan 481: the bot identity bound to this run (ChatOptions.agentProfileId).
   * Tools that act on behalf of the bot's identity (e.g. update_state memory
   * shards) read it from here; undefined/null for plain user sessions.
   */
  agentProfileId?: string | null;
  // Working directory for tool execution (e.g., BashTool)
  workingDirectory?: string;
  // Language preference for agent responses (propagated to sub-agents)
  language?: string;
  // API configuration for sub-agent execution
  apiKey?: string;
  baseURL?: string;
  authStyle?: 'api_key' | 'auth_token';
  provider?: 'anthropic' | 'openai' | 'ollama';
  // Vision model callback for image analysis
  analyzeImage?: (base64Data: string, mimeType: string, prompt?: string) => Promise<string>;
  /**
   * Phase 2A worker closure: providerName -> internalKey
   * resolver used by StreamingToolExecutor dispatch. When set,
   * every model-returned providerName is first looked up here
   * before the ToolRegistry lookup. When unset, StreamingToolExecutor
   * falls back to the direct tool.name lookup (legacy behavior).
   */
  resolveMCPProviderToolName?: (providerName: string) => string;
  /**
   * Executors for the parent's already-connected MCP tools, keyed by the
   * tool's model-visible `name`. Injected by the parent agent so sub-agents
   * that opt in via `mcpTools` can reuse the live MCP runtime (clients are
   * captured in the executor closures) instead of reconnecting servers.
   */
  mcpToolExecutors?: ReadonlyMap<string, import('./tool/registry.js').ToolExecutor>;
}

export interface AppState {
  // Basic app state - simplified for duya
  [key: string]: unknown;
}

export interface Command {
  name: string;
  description: string;
  type: 'prompt' | 'other';
}

export interface MCPServerConnection {
  name: string;
  type: 'connected' | 'disconnected' | 'connecting' | 'error';
  cleanup?: () => Promise<void>;
}

export interface MCPResource {
  uri: string;
  name?: string;
  description?: string;
  mimeType?: string;
}

// Default max output tokens for LLM responses
export const DEFAULT_MAX_OUTPUT_TOKENS = 8192;
