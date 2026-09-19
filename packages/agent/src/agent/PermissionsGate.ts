/**
 * PermissionsGate — Plan 550 step 2d.
 *
 * `duyaAgent._buildPermissionContext` (95 lines) was the only place where
 * the agent's permission mode, allow/deny/ask rules, host standing
 * permission, additional working directories, per-turn approval ledger,
 * and plan-mode exact-path gate came together. Pulling the assembly logic
 * into a dedicated module lets:
 *
 *   - tests pin the assembly contract without driving a full `streamChat`
 *   - the future `ToolExecutionPipeline` (2b) consume a built
 *     `permissionContext` + `canUseTool` pair without holding a hard
 *     reference back to `duyaAgent`
 *   - the per-turn approval ledger (`_consumeApprovedEffect` /
 *     `_turnAlwaysAllowTools`) travel through `turnContext.approval`
 *     instead of scattered private fields
 *
 * The module exports a small functional core (`buildPermissions`) plus a
 * thin class facade (`PermissionsGate`) for callers that want a
 * long-lived handle. `duyaAgent` implements `PermissionsGateDeps`
 * structurally so it does not have to extend anything.
 *
 * @see docs/exec-plans/active/550-prompt-hbs-and-agent-decomposition.md
 */

import type { AIClient } from '@duya/ai';
import type { Message } from '../types.js';
import type { CanUseToolFn } from '../tool/StreamingToolExecutor.js';
import type { ToolRegistry } from '../tool/registry.js';
import type { ToolPermissionCheckContext } from '../permissions/permissions.js';
import type {
  AdditionalWorkingDirectory,
  LocalToolPermission,
  PermissionMode,
  ToolPermissionRulesBySource,
} from '../permissions/types.js';
import type { RiskTier } from '../permissions/policy.js';
import type { ModeCoordinator } from '../modes/engine/index.js';
import type { TurnContext } from './TurnContext.js';
import { logger } from '../utils/logger.js';

/**
 * Session-scope dependencies the gate needs at build time. Everything
 * that mutates per-streamChat lives elsewhere — the gate itself is
 * immutable once built.
 *
 * Fields are getters when their underlying value can change mid-session
 * (e.g. `messages` is a timeline-derived getter on `duyaAgent`,
 * `abortController` is reset at the top of every `streamChat`,
 * `modeCoordinator` is rebuilt per streamChat). This keeps the gate
 * stateless and avoids the trap of snapshotting values that have already
 * drifted by the time the executor runs.
 */
export interface PermissionsGateDeps {
  /** Current effective permission mode (per-call accessor; do not snapshot). */
  getPermissionMode(): PermissionMode;
  /** Host-level standing permission switch (plan 487). Undefined → 'ask'. */
  hostToolPermission?: LocalToolPermission;
  /** Pre-loaded allow rules from settings + project + user rules. */
  alwaysAllowRules: ToolPermissionRulesBySource;
  /** Pre-loaded deny rules. */
  alwaysDenyRules: ToolPermissionRulesBySource;
  /** Pre-loaded ask rules. */
  alwaysAskRules: ToolPermissionRulesBySource;
  /** Project working directories registered via permission rules. */
  additionalWorkingDirectories: ReadonlyMap<string, AdditionalWorkingDirectory>;
  /** Default workspace directory for permission checks (path normalisation). */
  defaultWorkspaceDirectory?: string;
  /** Per-streamChat abort controller. Null until the run begins. */
  getAbortController(): AbortController | null;
  /** LLM client used for classifier model prompts (plan 312). */
  llmClient: AIClient;
  /** Classifier model id; some providers special-case the classifier role. */
  model: string;
  /** Live timeline-derived message list (used by tool classifiers). */
  getMessages(): readonly Message[];
  /** Underlying permission-engine entry point built in the constructor. */
  hasPermissionsToUseTool: (
    toolName: string,
    input: Record<string, unknown>,
    ctx: ToolPermissionCheckContext,
  ) => Promise<{ behavior: 'allow' | 'deny' | 'ask'; message?: string }>;
  /** Plan-mode exact-path gate; rebuilt per streamChat. */
  getModeCoordinator(): ModeCoordinator | undefined;
}

/**
 * Result of a gate build: the context classifiers consume and the
 * `canUseTool` function the streaming executor dispatches against. The
 * `permissionContext` captures live state via getters, so the executor
 * never has to re-build it on the next tool call.
 */
export interface BuiltPermissions {
  permissionContext: ToolPermissionCheckContext;
  canUseTool: CanUseToolFn;
}

/**
 * Resolve the risk tier for a tool name against the live registry. The
 * gate keeps this lazy (deferred until the classifier actually reads it)
 * because most prompts never consult the tier and constructing it on
 * every call would otherwise leak registry lookups into the hot path.
 */
function makeRiskTierLookup(
  registry: ToolRegistry | undefined,
): ((toolName: string) => RiskTier | undefined) | undefined {
  if (!registry) return undefined;
  return (toolName: string) => registry.getMeta(toolName)?.riskTier;
}

/**
 * Pure functional core. Tests pin the assembly contract here.
 *
 * Behaviour matches the legacy `_buildPermissionContext` line-for-line:
 *   - the per-turn approval ledger (`consumeApprovedEffect` /
 *     `alwaysAllowTools`) is read from `turn.approval` so the streaming
 *     loop sees the same answer whether the gate was built before or
 *     after the ledger was drained
 *   - the plan-mode exact-path gate consults `getModeCoordinator()`
 *     lazily (the coordinator is rebuilt per streamChat)
 *   - `workingDirectory` for the gate comes from the turn context (the
 *     stream-chat-local cwd), not from the session-scope field
 *   - classifier failures fail-closed (deny) so a broken permission
 *     system never lets a tool run
 */
export function buildPermissions(
  deps: PermissionsGateDeps,
  turn: TurnContext,
  registry: ToolRegistry | undefined,
): BuiltPermissions {
  const riskTierLookup = makeRiskTierLookup(registry);

  const permissionContext: ToolPermissionCheckContext = {
    getAppState: () => ({
      toolPermissionContext: {
        mode: deps.getPermissionMode(),
        additionalWorkingDirectories: deps.additionalWorkingDirectories as ReadonlyMap<
          string,
          AdditionalWorkingDirectory
        >,
        alwaysAllowRules: deps.alwaysAllowRules,
        alwaysDenyRules: deps.alwaysDenyRules,
        alwaysAskRules: deps.alwaysAskRules,
        isBypassPermissionsModeAvailable: true,
        defaultWorkspaceDirectory: deps.defaultWorkspaceDirectory,
        getToolRiskTier: riskTierLookup,
        hostToolPermission: deps.hostToolPermission,
      },
    }),
    abortController: deps.getAbortController() as AbortController,
    llmClient: deps.llmClient,
    classifierModel: deps.model,
    messages: deps.getMessages() as Message[],
  };

  const canUseTool: CanUseToolFn = async (
    toolName: string,
    toolInput?: Record<string, unknown>,
  ) => {
    try {
      // Plan 498 one-shot approval ledger: a persisted approval card that
      // was granted ('approved') and not yet consumed authorizes exactly
      // this (toolName, toolInput) pair. Consume is a CAS — a replay can
      // never double-execute an approval.
      const consumeApproved = turn.approval.consumeApprovedEffect;
      if (consumeApproved) {
        const preApproved = await consumeApproved(toolName, toolInput);
        if (preApproved) {
          return { allowed: true, behavior: 'allow' as const };
        }
      }
      // Plan 498: "Always allow this tool" grants from persisted approval
      // cards (per bot/session scope, seeded by the worker per turn).
      if (turn.approval.alwaysAllowTools.has(toolName)) {
        return { allowed: true, behavior: 'allow' as const };
      }

      // Plan-mode exact-path gating: when a plan tracker is active, write
      // tools are only allowed when they target the session plan file.
      // `'allow'`/`'deny'` are authoritative; `null` falls through to the
      // normal permission flow below.
      const gate = deps.getModeCoordinator()?.gateWriteTool(
        toolName,
        toolInput ?? {},
        turn.workingDirectory ?? '',
      );
      if (gate === 'deny') {
        return { allowed: false, behavior: 'deny' };
      }
      if (gate === 'allow') {
        return { allowed: true, behavior: 'allow' };
      }

      const decision = await deps.hasPermissionsToUseTool(
        toolName,
        toolInput ?? {},
        permissionContext,
      );
      return {
        allowed: decision.behavior !== 'deny',
        behavior: decision.behavior,
      };
    } catch (err) {
      // Fail-closed: if the permission system itself breaks, do not let
      // the tool run. Log the failure so operators can detect it.
      const reason = err instanceof Error ? err.message : String(err);
      logger.warn(
        `[Agent] canUseTool check threw for ${toolName}, fail-closed with deny: ${reason}`,
      );
      return {
        allowed: false,
        behavior: 'deny',
      };
    }
  };

  return { permissionContext, canUseTool };
}

/**
 * Class facade. Callers that want a long-lived handle hold one of these
 * and call `build(turn, registry)` per streamChat. Stateless under the
 * hood — every field lives on `deps` — so the class is purely a
 * convenience over `buildPermissions`.
 */
export class PermissionsGate {
  constructor(private readonly deps: PermissionsGateDeps) {}

  build(turn: TurnContext, registry?: ToolRegistry): BuiltPermissions {
    return buildPermissions(this.deps, turn, registry);
  }
}