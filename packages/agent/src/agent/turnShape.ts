/**
 * Turn shape — the data algorithm behind `TurnAssembler` (Plan 587 M5.4).
 *
 * The 550 assembler mixed two different jobs in one function body:
 *
 *   - **IO assembly** — calling `AgentRuntime` accessors on a live agent
 *     to pull per-turn state out of the god class;
 *   - **the data algorithm** — deciding which fields exist, flattening
 *     the prompt, collapsing the approval ledger, reducing mention
 *     descriptors to bare names, freezing the result.
 *
 * Only the second half is a rule. Rules are worth testing directly and
 * are worth being able to run without an agent, so they live here, as a
 * pure function of data. `TurnAssembler` keeps the IO and delegates.
 *
 * Two properties this split buys, beyond testability:
 *
 *   - **Turn consistency.** The assembler used to call
 *     `readCommunicationPlatform()` and `readLanguage()` twice each, and
 *     call the whole accessor set in expression order. Any state that
 *     moved between those calls produced a context that was internally
 *     inconsistent — a `language` that did not match the platform it was
 *     read beside. The IO layer now reads each value exactly once into a
 *     `TurnStateSnapshot`, so everything in one turn is derived from one
 *     observation of the agent.
 *   - **No god-class dependency.** This module has no reference to
 *     `AgentRuntime` and no runtime imports at all, so it stays
 *     placeable in `agent-core` once `ChatOptions` is protocolised. That
 *     move is still blocked on the shared type living in
 *     `packages/agent/src/types.ts`.
 *
 * @see docs/exec-plans/active/587-agent-harness-monorepo/06-package-and-host-migration.md
 */

import type { ChatOptions, MessageContent } from '../types.js';
import type { LocalToolPermission, PermissionMode } from '../permissions/types.js';
import type { CommunicationPlatform } from '../prompts/types.js';
import {
  NO_APPROVAL_LEDGER,
  NO_MENTIONS,
  type ApprovalLedger,
  type MentionInjections,
  type TurnContextShape,
} from './TurnContext.js';

/**
 * One consistent observation of the agent's per-turn state.
 *
 * Every field is `readonly` and every optional field keeps `undefined`
 * rather than being coerced, so the data algorithm can decide presence
 * instead of having presence decided for it by a getter that returned
 * `null`.
 */
export interface TurnStateSnapshot {
  readonly turnSequence: number;
  readonly sessionId: string | undefined;
  readonly workingDirectory: string | undefined;
  readonly communicationPlatform: CommunicationPlatform | undefined;
  readonly language: string | undefined;
  readonly permissionMode: PermissionMode;
  readonly hostToolPermission: LocalToolPermission | undefined;
  readonly additionalWorkingDirectories: ReadonlyMap<string, unknown>;
  /** Per-turn always-allow grants, reset by every `streamChat`. */
  readonly alwaysAllowTools: readonly string[];
}

/**
 * Flatten a `string | MessageContent[]` prompt into the plain-text
 * payload the turn hands to the model. Matches the legacy `streamChat`
 * behaviour (`typeof prompt === 'string' ? prompt : ''`) — multi-block
 * prompts are treated as empty for now because the rest of the agent
 * loop still consumes the legacy single-string path.
 */
export function flattenPrompt(prompt: string | MessageContent[]): string {
  return typeof prompt === 'string' ? prompt : '';
}

/**
 * Translate the per-turn approval ledger. The legacy agent uses two
 * instance fields (`_consumeApprovedEffect`, `_turnAlwaysAllowTools`)
 * that get reset at the top of every `streamChat`. The shape captures
 * both into a frozen record so the loop body never reaches back into the
 * agent for them.
 */
function buildApprovalLedger(
  options: ChatOptions | undefined,
  snapshot: TurnStateSnapshot,
): ApprovalLedger {
  const alwaysAllowTools = new Set<string>(
    options?.approvedAlwaysAllowTools ?? snapshot.alwaysAllowTools,
  );
  if (alwaysAllowTools.size === 0 && !options?.consumeApprovedEffect) {
    return NO_APPROVAL_LEDGER;
  }
  const ledger: ApprovalLedger = {
    alwaysAllowTools,
    ...(options?.consumeApprovedEffect
      ? { consumeApprovedEffect: options.consumeApprovedEffect }
      : {}),
  };
  return Object.freeze(ledger);
}

/**
 * Translate the per-turn mention injection list. `MentionResolver` is
 * not in scope yet; for now the shape records `provider` / `skills` /
 * `plugins` requested by the user and leaves `contexts` empty. The
 * follow-up that introduces the mention pipeline will populate
 * `contexts` here.
 */
function buildMentions(options: ChatOptions | undefined): MentionInjections {
  if (
    !options?.mentionedProviders &&
    !options?.mentionedSkills &&
    !options?.mentionedPlugins
  ) {
    return NO_MENTIONS;
  }
  // `mentionedPlugins` carries structured objects (plan 450); the shape
  // only needs the bare names so the algorithm flattens them down.
  const plugins = options.mentionedPlugins
    ? options.mentionedPlugins.map((p) => p.name)
    : [];
  const mentions: MentionInjections = {
    skills: options.mentionedSkills ? [...options.mentionedSkills] : [],
    plugins,
    contexts: [],
    ...(options.mentionedProviders ? { provider: options.mentionedProviders } : {}),
  };
  return Object.freeze(mentions);
}

/**
 * Derive the `TurnContextShape` from one snapshot, the caller's
 * `ChatOptions` and the raw prompt. Pure: no agent, no clock, no IO.
 *
 * Presence rules, which are the whole point of the split:
 *
 *   - `sessionId` / `workingDirectory` normalise `undefined` to `null`,
 *     because "no value" is a state the loop branches on;
 *   - `communicationPlatform`, `language` and `hostToolPermission` are
 *     **omitted** rather than set to `undefined`, so the frozen shape
 *     does not carry keys the loop would have to test for anyway;
 *   - `turnId` is only built when the caller supplied a `turnId`, and
 *     pairs it with the sequence read from the same snapshot.
 */
export function buildTurnShape(
  snapshot: TurnStateSnapshot,
  options: ChatOptions | undefined,
  prompt: string | MessageContent[],
): TurnContextShape {
  return {
    turnId: options?.turnId
      ? { sequence: snapshot.turnSequence, id: options.turnId }
      : null,
    sessionId: snapshot.sessionId ?? null,
    workingDirectory: snapshot.workingDirectory ?? null,
    ...(snapshot.communicationPlatform !== undefined
      ? { communicationPlatform: snapshot.communicationPlatform }
      : {}),
    ...(snapshot.language !== undefined ? { language: snapshot.language } : {}),
    permissionMode: snapshot.permissionMode,
    ...(snapshot.hostToolPermission !== undefined
      ? { hostToolPermission: snapshot.hostToolPermission }
      : {}),
    additionalWorkingDirectories: snapshot.additionalWorkingDirectories,
    approval: buildApprovalLedger(options, snapshot),
    mentions: buildMentions(options),
    promptText: flattenPrompt(prompt),
  };
}
