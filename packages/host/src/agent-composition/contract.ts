/**
 * Plan 624 — agent composition contract.
 *
 * The control layer (session, bot, TUI, coordinator, desktop, gateway) only
 * declares what kind of agent it needs; this module is the vocabulary of that
 * declaration and of the frozen plan the composition layer hands back to the
 * execution layer.
 *
 * Everything here is pure data: no IO, no imports beyond the profile contract,
 * so the same types can later move to `@duya/agent-core` without dragging a
 * dependency direction along.
 */
import type { AgentProfile } from '@duya/agent-core';

/**
 * Which composition a profile resolves to.
 *
 * Derived from `profile.kind` plus the profile id — never set freely by a
 * caller. A freely settable scope would become an eighteenth branch point,
 * which is exactly what this plan removes.
 */
export type CompositionScope =
  | 'main-session'
  | 'coordinator'
  | 'subagent'
  | 'bot'
  | 'special';

/** Where a resolved value came from. */
export type CompositionSource =
  | 'profile'
  | 'config'
  | 'host-default'
  | 'turn-override'
  | 'fallback';

/** One resolved decision, with its origin. */
export interface CompositionDecision {
  /** Dotted field path, e.g. `prompt.system` or `scope`. */
  readonly field: string;
  readonly value: string;
  readonly source: CompositionSource;
  readonly note?: string;
}

/** Scope resolution result. */
export interface ScopeResolution {
  readonly scope: CompositionScope;
  readonly decisions: readonly CompositionDecision[];
}

/**
 * The prompt half of a composition.
 *
 * `requestedSystem` keeps the profile's declaration visible even when the
 * effective system differs, so a reader can tell "asked for X, ran Y, because Z"
 * without re-deriving the branch.
 */
export interface PromptSelection {
  /** Prompt system actually used by the renderer. */
  readonly promptSystem: string;
  /** Prompt system declared by the profile, before fallback. */
  readonly requestedSystem?: string;
  /** True when the profile skips the runtime's generic identity block. */
  readonly suppressIdentityBlock: boolean;
  /**
   * True when prompt text also comes from the bot assembly
   * (`getBotAssembly().renderSections()`), which is appended as a host block.
   * Until both paths are merged this flag is the single place that says so.
   */
  readonly usesBotAssembly: boolean;
  readonly disableSections: readonly string[];
  readonly enableSections: readonly string[];
  readonly decisions: readonly CompositionDecision[];
}

/** Input to composition: who, what, where. */
export interface AgentCompositionRequest {
  readonly profile: AgentProfile;
  /** Injected clock-free environment facts; no IO ports live here. */
  readonly environment?: {
    readonly sessionId?: string;
    readonly workingDirectory?: string | null;
  };
}

/** Turn-level tool narrowing, as declared by the caller. */
export interface ToolSelectionInput {
  readonly allowedTools?: readonly string[];
  readonly disabledTools?: readonly string[];
}

/**
 * Which constraints apply to the tool surface, and where each came from.
 *
 * The resolver deliberately does NOT re-implement `isToolVisible`: duplicating
 * the filter would create a second source of truth for what the model sees.
 * It only names the four inputs the existing filter consumes.
 */
export interface ToolSelection {
  readonly profileAllowedPatterns: readonly string[];
  readonly profileDisallowedPatterns: readonly string[];
  readonly turnAllowedTools: readonly string[];
  readonly turnDisabledTools: readonly string[];
  readonly decisions: readonly CompositionDecision[];
}

/** Mode modifiers declared for this turn. */
export interface ModeSelectionInput {
  readonly mode?: string;
}

export interface ModeSelection {
  readonly activeModeIds: readonly string[];
  /** Set only when the requested mode resolves to an orchestrator modifier. */
  readonly orchestratorModeId?: string;
  readonly decisions: readonly CompositionDecision[];
}

/** Permission mode for this turn. */
export interface PermissionSelectionInput {
  readonly permissionMode?: string;
}

export interface PermissionSelection {
  readonly permissionMode: string;
  readonly decisions: readonly CompositionDecision[];
}

/** Provider cache family. Determined by wire protocol, never by provider name. */
export type ProviderCacheFamily =
  | 'anthropic-messages'
  | 'openai-responses'
  | 'openai-chat'
  | 'none';

export interface CacheSelectionInput {
  readonly protocol: 'anthropic' | 'openai' | 'other';
  /** OpenAI API flavour; only meaningful when `protocol` is `openai`. */
  readonly api?: 'responses' | 'chat' | 'completions';
  readonly provider?: string;
  readonly model?: string;
  readonly baseUrl?: string;
  readonly sessionId?: string;
}

export interface CacheSelection {
  readonly family: ProviderCacheFamily;
  /** OpenAI-family cache key, derived from the session id and clamped to 64 chars. */
  readonly promptCacheKey?: string;
  /** Breakpoint budget for the Anthropic-family cache-control path. */
  readonly cacheControlBreakpoints: number;
  readonly decisions: readonly CompositionDecision[];
}

