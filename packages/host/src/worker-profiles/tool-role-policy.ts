/**
 * tool-role-policy.ts — per-turn role scoping for product toolsets.
 *
 * ## Why this lives here and not in the registry
 *
 * The builtin registry is process-wide: `worker-process-assembly.ts` builds
 * one registry per worker process, and `_resolveTools` falls back to the
 * shared `activeMCPRegistry` (`worker-session-runtime.ts`). A registration
 * time role split would therefore give every Session in that process the
 * same inventory. Role isolation has to be a per-turn decision.
 *
 * `createBuiltinRegistry` registers the Coordinator's `project` tool and the
 * whole bot collaboration toolset unconditionally. Before this policy that
 * was harmless for the DIRECT `tools[]` array — deferred tools need an exact
 * allowlist entry to be promoted (plan 496) — but NOT for the catalog: the
 * eligible set is computed with `isToolVisible(..., 'eager', ...)`, which
 * skips promotion but still honours allow/deny. A preset with
 * `allowedTools: ['*']` (general-purpose, code-expert, research, gateway,
 * cron) makes every allow check vacuously true, so all deferred product
 * tools became discoverable AND invocable from an ordinary Session.
 * `tool_invoke`'s dispatcher is wired to `eligibleToolIds`, so catalog
 * visibility and reachability are the same set.
 *
 * Injecting the deny list into `ToolVisibilityConstraints` fixes all three
 * surfaces at once, because deny is evaluated before the catalog-router
 * shortcut and before the allowlist in `isToolVisible`.
 *
 * ## Two restricted families
 *
 * - COORDINATOR_ONLY: `project`. The Host service resolves the project from
 *   the caller's durable Coordinator binding and refuses every other caller
 *   (`project/tool-service.ts`), so exposing it to a normal Session is pure
 *   catalog noise at best and a confusing dead end at worst.
 * - BOT_ONLY: the collaboration channels declared in
 *   `agent-core/profiles/bot-toolset.ts` ("the bot's only voice", "a
 *   member's only voice into a shared room"). These are registered in the
 *   ordinary builtin registry (`worker-tools/builtin.ts`) even though
 *   `worker-tools/bot-builtin.ts` exists as the intended home.
 *
 * An EXACT name in the profile allowlist is an explicit authorization and
 * always wins — `applyBotToolset` adds exactly these names for bot profiles.
 * A wildcard (`*`) deliberately does NOT authorize a restricted tool: this
 * is the plan 496 promotion rule applied to catalog eligibility as well.
 *
 * `duya_app` `session_*` tools are intentionally NOT in either list. They
 * are general Session-management capabilities (plan 616 §3.1), not bot
 * channels; whether they should be role-scoped is a product decision, not a
 * boundary bug. See the handoff note in the exec plan.
 */

import type { AgentProfile } from '@duya/agent-core';
import { isProjectCoordinatorProfile } from '../project/identity.js';

export type ToolRole = 'coordinator' | 'bot' | 'session';

/** Tools whose only legitimate caller is the Project Coordinator. */
export const COORDINATOR_ONLY_TOOL_NAMES: readonly string[] = [
  'project',
];

/**
 * Bot collaboration tools registered by `createBuiltinRegistry`. Both the
 * registered builtin names and the `duya_app` original names are listed:
 * `anyPatternMatches` tries the model-visible name first and then
 * `appToolOriginalName`, and the two registries do not agree on spelling
 * (`react_to_message` vs `ReactToMessage`).
 */
export const BOT_ONLY_TOOL_NAMES: readonly string[] = [
  'update_state',
  'send_message',
  'send_to_agent',
  'post_to_room',
  'react_to_message',
  'ReactToMessage',
  'create_agent',
  'update_agent',
  'manage_routine',
  'list_app_connectors',
  'connect_app',
];

/**
 * Resolve the active Session's product role.
 *
 * `isBot` is supplied by the caller because the canonical predicate
 * (`isBotAgentProfile` in `worker-prompts/bot/loader.ts`) lives in a module
 * with heavy memory/bot imports; keeping it as a parameter keeps this policy
 * a pure, cheap, dependency-light decision that the turn assembly can call
 * on every turn without pulling the bot prompt graph into the tool path.
 */
export function resolveToolRole(
  profile: AgentProfile | undefined,
  isBot: boolean,
): ToolRole {
  if (isProjectCoordinatorProfile(profile?.id)) return 'coordinator';
  return isBot ? 'bot' : 'session';
}

/**
 * Restricted tool names this role must not see, in either the direct tool
 * array or the tool catalog. Returns exact names suitable for
 * `ToolVisibilityConstraints.profileDisallowedPatterns`.
 */
export function resolveRoleRestrictedToolDeny(
  role: ToolRole,
  allowedTools: readonly string[] | undefined,
): string[] {
  const explicitlyAllowed = new Set(allowedTools ?? []);
  const deny: string[] = [];
  for (const name of COORDINATOR_ONLY_TOOL_NAMES) {
    if (role !== 'coordinator' && !explicitlyAllowed.has(name)) {
      deny.push(name);
    }
  }
  for (const name of BOT_ONLY_TOOL_NAMES) {
    if (role !== 'bot' && !explicitlyAllowed.has(name)) {
      deny.push(name);
    }
  }
  return deny;
}
