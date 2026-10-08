/**
 * The 13 contributor interfaces.
 *
 * Every interface here does exactly one thing and returns data or a decision.
 * None of them owns a loop, a scheduler, or a dispatch order: the runtime
 * keeps the loop and asks the registry at fixed points, which is the same
 * discipline `modes/index.ts` already follows with `applyModes`.
 *
 * The interfaces are derived backwards from extension points that already
 * exist in this repository, not invented ahead of them. Each doc comment names
 * the existing site the shape came from.
 */

import type { ExtensionCapability } from './grants.js';

/**
 * Declared by every contributor: the slots the contributor needs in order to be
 * assembled. `validate` rejects a contributor that declares a capability the
 * host did not grant.
 */
export interface ExtensionContributor {
  /** Stable identity used by assembly-time validation and diagnostics. */
  readonly id: string;
  /** Slots this contributor needs. Must be a subset of the granted set. */
  readonly capabilities: readonly ExtensionCapability[];
}

/* ------------------------------------------------------------------ *
 * 1. modes — from `packages/agent/src/modes/index.ts` (plan 224
 *    `ModeModifier`), whose declarative modifier shape is the positive
 *    example this series keeps.
 * ------------------------------------------------------------------ */

export interface ModePatch {
  /** Tool ids the mode adds on top of the profile toolset. */
  readonly addTools?: readonly string[];
  /** Tool ids the mode removes. */
  readonly removeTools?: readonly string[];
  /** Prompt fragments the mode injects. */
  readonly promptFragments?: readonly string[];
}

export interface ModeApplication {
  readonly modeId: string;
  readonly profileId: string;
  readonly activeToolIds: readonly string[];
}

export interface ModeContributor extends ExtensionContributor {
  readonly modeId: string;
  apply(input: ModeApplication): ModePatch;
}

/* ------------------------------------------------------------------ *
 * 2. tools — from `packages/agent/src/tool/builtin.ts` registration.
 *    Note this is a *description* of a tool, not its execution: an
 *    extension contributes a definition and the host owns the executor.
 * ------------------------------------------------------------------ */

export interface ExtensionToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Readonly<Record<string, unknown>>;
}

export interface ToolContributor extends ExtensionContributor {
  readonly toolId: string;
  readonly definition: ExtensionToolDefinition;
}

/* ------------------------------------------------------------------ *
 * 3. promptSections — from `packages/agent/src/prompts/modules/registry.ts`
 *    (`PromptModuleDef.path` keyed by module name).
 * ------------------------------------------------------------------ */

/**
 * One authored prompt slot. The members mirror the mappers that already exist
 * under `prompts/modules/mappers/` (`project`, `identityCoding`,
 * `systemCoding`, `rules`, `duyaDesktopContextCode`, `researchProfile`).
 */
export type PromptSlot =
  | 'project'
  | 'identity-coding'
  | 'system-coding'
  | 'rules'
  | 'desktop-context'
  | 'research-profile';

export interface PromptRenderInput {
  readonly profileId: string;
}

export interface PromptSectionContributor extends ExtensionContributor {
  readonly sectionName: string;
  /** Globally unique across every prompt section contributor. */
  readonly slots: readonly PromptSlot[];
  render(input: PromptRenderInput): string;
}

/* ------------------------------------------------------------------ *
 * 4. hooks — from `packages/agent/src/hooks/builtin.ts`
 *    (`LoopHookRegistration`: id + events + priority + handler).
 * ------------------------------------------------------------------ */

/** The loop events that already exist in `packages/agent/src/hooks/loop.ts`. */
export type LoopHookEvent = 'PreTurn' | 'PostToolUse' | 'PreFinalize' | 'PostTurn';

export interface HookDispatchInput {
  readonly event: LoopHookEvent;
  readonly sessionId: string;
  readonly messages: readonly unknown[];
}

export interface HookEffect {
  readonly type: 'inject' | 'block_finalize';
  readonly content?: string;
}

export interface HookContributor extends ExtensionContributor {
  readonly events: readonly LoopHookEvent[];
  readonly priority: number;
  handle(input: HookDispatchInput): HookEffect[] | Promise<HookEffect[]>;
}

/* ------------------------------------------------------------------ *
 * 5. context — from `packages/agent/src/agentsmd/manager.ts` instruction
 *    loading (AGENTS.md-style project instructions).
 * ------------------------------------------------------------------ */

export interface ContextLoadInput {
  readonly workingDirectory: string;
}

export interface ContextSection {
  readonly sectionName: string;
  readonly content: string;
}

export interface ContextContributor extends ExtensionContributor {
  load(input: ContextLoadInput): ContextSection[] | Promise<ContextSection[]>;
}

/* ------------------------------------------------------------------ *
 * 6. skills — from `packages/agent/src/skills/` registration.
 * ------------------------------------------------------------------ */

export type SkillActivation =
  | { readonly kind: 'always' }
  | { readonly kind: 'path-gated'; readonly pathKeys: readonly string[] };

export interface SkillContributor extends ExtensionContributor {
  readonly skillId: string;
  readonly description: string;
  readonly activation: SkillActivation;
}

/* ------------------------------------------------------------------ *
 * 7. approvalPolicies — from `packages/agent/src/permissions/policy.ts`
 *    (`PERMISSION_MODE_CONFIG`).
 * ------------------------------------------------------------------ */

export type ApprovalDecision = 'allow' | 'ask' | 'deny';

export interface ApprovalRule {
  readonly ruleId: string;
  readonly toolPattern: string;
  readonly decision: ApprovalDecision;
}

export interface ApprovalPolicyContributor extends ExtensionContributor {
  readonly modeId: string;
  readonly rules: readonly ApprovalRule[];
}

/* ------------------------------------------------------------------ *
 * 8. profiles — from `packages/agent/src/agent-profile/` composition
 *    (section enable/disable lists plus the profile toolset).
 * ------------------------------------------------------------------ */

export interface ProfileContributor extends ExtensionContributor {
  readonly profileId: string;
  readonly enabledSections: readonly string[];
  readonly toolIds: readonly string[];
}

/* ------------------------------------------------------------------ *
 * 9. servers — from `packages/agent/src/mcp/index.ts` (`MCPManager`) and
 *    the App-Connection tools. Both are one slot, discriminated by `kind`,
 *    because the runtime already treats them as one mechanism with two
 *    replaceable buckets (see `ToolOwner` in `tool/registry.ts`:
 *    `'mcp'` and `` `connector:${connectionId}` ``). Implementations live in
 *    capabilities and connectors respectively; this package sees only the
 *    declaration.
 * ------------------------------------------------------------------ */

export type ServerContributorKind = 'mcp' | 'app-connector';

export interface ServerContributor extends ExtensionContributor {
  readonly kind: ServerContributorKind;
  readonly serverId: string;
  readonly transport: 'stdio' | 'http' | 'sse' | 'app-connection';
}

/* ------------------------------------------------------------------ *
 * 10. memoryPolicies — from
 *     `packages/agent/src/memory-rollout/stage1_policy_editor.ts`
 *     (`POLICY_SECTION_IDS`, `PolicySection`, `PolicyRule`).
 * ------------------------------------------------------------------ */

export interface MemoryPolicyRule {
  readonly ruleId: string;
  readonly text: string;
}

export interface MemoryPolicyContributor extends ExtensionContributor {
  readonly sectionId: string;
  readonly rules: readonly MemoryPolicyRule[];
}

/* ------------------------------------------------------------------ *
 * 11. decisions — from `packages/agent/src/decisions/` (`DecisionService`
 *     fallback chain).
 * ------------------------------------------------------------------ */

export interface DecisionInput {
  readonly decisionId: string;
  readonly subject: string;
}

export interface DecisionOutcome {
  readonly decided: boolean;
  readonly confidence: number;
  readonly rationale?: string;
}

export interface DecisionContributor extends ExtensionContributor {
  readonly decisionId: string;
  decide(input: DecisionInput): DecisionOutcome;
}

/* ------------------------------------------------------------------ *
 * 12. lifecycles — from `packages/agent/src/lifecycle/`
 *     (`BackgroundAgentLifecycle`, `CleanupRegistry`).
 *
 * `registers` is the edge that makes an assembly-time cycle check possible:
 * it declares which lifecycle events this contributor itself hooks, so a
 * turn-start contributor that re-registers turn-start is a cycle and is
 * rejected before any run starts.
 * ------------------------------------------------------------------ */

export type LifecycleEvent =
  | 'thread-start'
  | 'thread-stop'
  | 'turn-start'
  | 'turn-stop'
  | 'turn-abort'
  | 'turn-error'
  | 'tool-start'
  | 'tool-finish'
  | 'cleanup';

export interface LifecycleInput {
  readonly event: LifecycleEvent;
  readonly sessionId: string;
}

export interface LifecycleContributor extends ExtensionContributor {
  readonly events: readonly LifecycleEvent[];
  /** Lifecycle events this contributor itself installs a hook on. */
  readonly registers?: readonly LifecycleEvent[];
  handle(input: LifecycleInput): void | Promise<void>;
}

/* ------------------------------------------------------------------ *
 * 13. tokenUsage — from
 *     `packages/agent/src/observability/cache-monitor.ts`
 *     (`NormalizedUsage`, `CacheObservation`).
 * ------------------------------------------------------------------ */

export interface NormalizedUsageInput {
  readonly sessionId: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
}

export interface TokenUsageContributor extends ExtensionContributor {
  observe(input: NormalizedUsageInput): void;
}
