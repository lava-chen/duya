import type { AIClient } from '@duya/ai';
import type { SSEEvent, Tool } from '../types.js';
import type { ResearchMemoryRuntime } from '../research-memory/types.js';
import type { ToolExecutor } from '../tool/registry.js';
import type { ToolRegistry } from '../tool/registry.js';

export type { SSEEvent };

// ============================================================
// ModeModifier (plan 224) — declarative mode overlay
// ============================================================
//
// A ModeModifier is a declarative description of how a popover "mode"
// (plan-task / research / conductor) adjusts three dimensions of the
// agent run: the tool set, the system prompt, and stream-time behavior.
//
// Unlike the removed BaseMode takeover API, a ModeModifier composes with the
// base profile through ModeModifierRegistry.resolve.

/**
 * A single tool registration pair consumed by
 * {@link ToolRegistry.registerAll}. Lifted to a named type so
 * {@link ModeModifier.tools.inject} can return arrays of these without
 * each mode repeating the shape.
 */
export interface ToolRegistration {
  definition: Tool;
  executor: ToolExecutor;
}

/**
 * Mode-private runtime state. Examples:
 *  - conductor: `{ conductorCanvasId, widgetStyleHistory }`
 *  - research:  `{ runId, currentStage }`
 */
export type ModeModifierState = Record<string, unknown>;

/**
 * Runtime context passed to every {@link ModeModifier} hook. Modes read
 * their private state from `state` and surface tool-injection fields
 * (e.g. `conductorCanvasId`) via {@link toolUseContextPatch}.
 */
export interface ModeModifierContext {
  sessionId: string;
  workingDirectory: string;
  /** Mode-private state. Modes may read/write freely; persisted via {@link ModeModifier.persist}. */
  state: ModeModifierState;
  /**
   * Fields merged into the agent's ToolUseContext before the run starts.
   * Conductor sets `conductorCanvasId` here so every canvas tool sees it
   * without the LLM having to pass it.
   */
  toolUseContextPatch?: Record<string, unknown>;
}

/**
 * Optional stream-level options a mode can override via
 * {@link ModeModifier.hooks.beforeStream}. Merged into the agent's
 * StreamOptions (maxIterations, iteration hooks, etc.).
 */
export interface StreamOptionsPatch {
  maxIterations?: number;
  onIterationComplete?: (iteration: number) => Promise<void>;
  /** Free-form extension bag — modes may add their own hooks here. */
  [key: string]: unknown;
}

/**
 * Prompt builder — receives the current context and the base prompt,
 * returns the modified prompt. Used for prefix/suffix when a mode needs
 * dynamic prompt content (e.g. conductor pulls from widgetStyleHistory).
 */
export type PromptBuilder = (ctx: ModeModifierContext, basePrompt: string) => string;

/**
 * Tool-set adjustments a mode declares. All fields optional; modes only
 * declare what they change.
 *
 *  - `inject`        : add new tools (e.g. 11 canvas tools for conductor)
 *  - `block`         : remove tools by name (e.g. write tools in plan-task)
 *  - `allow`         : whitelist — if set, only listed tools remain
 *  - `overrideFilter`: when true, `inject`-ed tools bypass profile
 *                      filtering (conductor needs this so canvas tools
 *                      survive even under the `code` profile).
 */
export interface ModeModifierTools {
  inject?: ToolRegistration[] | ((ctx: ModeModifierContext) => ToolRegistration[]);
  /** Whitelist. Mutually exclusive with {@link block} in spirit — setting both is a mode bug. */
  allow?: string[];
  /** Blacklist — these tool names are removed from the base set. */
  block?: string[];
  overrideFilter?: boolean;
}

export interface ModeModifierPrompt {
  /** Prepended to the system prompt (multiple modes concatenate in registration order). */
  prefix?: string | PromptBuilder;
  /** Appended to the system prompt. */
  suffix?: string | PromptBuilder;
}

export interface ModeModifierHooks {
  /** Called when the mode becomes active (resolve canvasId, open sidebar, etc.). */
  onEnter?: (ctx: ModeModifierContext) => Promise<void> | void;
  /** Called when the mode is deactivated. Only fires for `kind: 'message'` modes after the run. */
  onExit?: (ctx: ModeModifierContext) => Promise<void> | void;
  /** Called right before streamChat enters the agent loop. Return value is merged into StreamOptions. */
  beforeStream?: (ctx: ModeModifierContext) => StreamOptionsPatch | Promise<StreamOptionsPatch>;
}

export interface ModeModifierPersist {
  serialize: (ctx: ModeModifierContext) => unknown;
  deserialize: (raw: unknown) => ModeModifierState;
}

/**
 * Display metadata — surfaced to the UI for badge / popover rendering.
 * Not consumed by the agent runtime itself.
 */
export interface ModeModifierDisplay {
  label: string;
  icon?: string;
  description?: string;
}

/**
 * Dependencies passed to an orchestrator-mode's `execute` generator.
 * Built by `streamChat` from the agent's runtime state. Orchestrator
 * modes use these to construct their own LLM calls, tool execution,
 * and persistence — they do NOT run through the agent tool loop.
 */
export interface OrchestratorDeps {
  llmClient: AIClient;
  abortController: AbortController;
  sessionId?: string;
  workingDirectory?: string;
  researchMemory?: ResearchMemoryRuntime;
  /**
   * Pre-built tool registry (profile + plugin + MCP tools). The
   * orchestrator may further filter/augment; it is responsible for
   * building its own `toolExecute` / `toolExecuteConcurrent` from
   * this registry.
   */
  toolRegistry: ToolRegistry;
  /** Original ChatOptions, for orchestrators that need to read
   * `conductorMode`, etc. */
  chatOptions?: Record<string, unknown>;
  /** Blocked domains for web tools. */
  blockedDomains?: string[];
}

/**
 * Orchestrator-mode interface: if a {@link ModeModifier} provides this,
 * it takes over the entire stream instead of going through the agent
 * tool loop. The orchestrator owns the SSE flow, tool execution, and
 * multi-stage logic.
 *
 * Canonical example: Research mode (plan → clarification → iteration →
 * synthesis) runs its own `Orchestrator` instance and emits SSE events
 * directly — it cannot be expressed as a modifier on the agent loop.
 *
 * An orchestrator mode should NOT also declare `tools`/`prompt`/`hooks`
 * for agent-loop composition. It manages its own prompt/tools/iterations
 * internally. The `display` and `exclusiveWith` fields still apply
 * (UI metadata and mutual-exclusion rules are shared across both
 * paradigms).
 */
export interface ModeModifierOrchestrator {
  execute: (
    query: string,
    ctx: ModeModifierContext,
    deps: OrchestratorDeps,
  ) => AsyncGenerator<SSEEvent, void, unknown>;
}

/**
 * Declarative mode overlay. One object per popover mode (plan-task,
 * research, conductor). See plan 224 for the design rationale.
 *
 * Two paradigms are supported:
 *  - **Modifier mode**: declares `tools` / `prompt` / `hooks`. Applied
 *    on top of the agent tool loop via `applyModes`. Example: Conductor.
 *  - **Orchestrator mode**: declares `orchestrator`. Takes over the
 *    entire stream with its own multi-stage logic. Example: Research.
 *
 * A mode picks one paradigm — declaring both is a mode bug.
 */
export interface ModeModifier {
  /** Unique id, e.g. `'plan-task'` | `'research'` | `'conductor'`. */
  id: string;
  /** Lifecycle: `'message'` = per-message (cleared after send), `'session'` = persisted across messages. */
  kind: 'message' | 'session';
  /** Other mode ids that cannot be active at the same time as this one. */
  exclusiveWith?: string[];
  /** UI metadata. */
  display?: ModeModifierDisplay;

  // ─── Modifier paradigm (mutually exclusive with `orchestrator`) ───
  tools?: ModeModifierTools;
  prompt?: ModeModifierPrompt;
  hooks?: ModeModifierHooks;
  /** Required for `kind: 'session'` modes; optional for `kind: 'message'`. */
  persist?: ModeModifierPersist;

  // ─── Orchestrator paradigm (mutually exclusive with tools/prompt/hooks) ───
  /** If provided, this mode takes over the entire stream. See {@link ModeModifierOrchestrator}. */
  orchestrator?: ModeModifierOrchestrator;
}

/**
 * The merged result of resolving one or more {@link ModeModifier}s.
 * Produced by {@link ModeModifierRegistry.resolve}; consumed by
 * `applyModes` in `apply-modes.ts`.
 *
 * Note: `tools.injects` preserves the *raw* inject declarations
 * (function-form entries are NOT evaluated here — they have no ctx yet).
 * `applyModes` evaluates them against a real {@link ModeModifierContext}.
 */
export interface ResolvedMode {
  /** Active modifiers in registration order (conflicts already filtered). */
  modes: ModeModifier[];
  tools: {
    /** Raw inject declarations in registration order. Function-form entries are evaluated lazily by applyModes. */
    injects: Array<ToolRegistration[] | ((ctx: ModeModifierContext) => ToolRegistration[])>;
    blocked: string[];
    /** `null` = no whitelist (allow everything). */
    allowed: string[] | null;
    overrideFilter: boolean;
  };
  prompt: {
    prefixes: Array<string | PromptBuilder>;
    suffixes: Array<string | PromptBuilder>;
  };
}
