/**
 * TurnAssembler — Plan 550 step 2a-2.
 *
 * `duyaAgent.streamChat` currently tracks 60+ private fields just to
 * build one turn. `TurnAssembler.build(agent, options, prompt)` is the
 * constructor that consolidates every per-turn local into a single
 * frozen `TurnContext` value (see `TurnContext.ts`).
 *
 * In this commit the assembler does **not** wire into
 * `duyaAgent.streamChat`. Its only responsibility is to translate the
 * `AgentOptions` and the current `duyaAgent` state into a populated
 * `TurnContextShape`. Wiring is the next commit's job.
 *
 * @see docs/exec-plans/active/550-prompt-hbs-and-agent-decomposition.md
 */

import type { ChatOptions, MessageContent } from '../types.js';
import type { AgentRuntime } from './AgentRuntime.js';
import {
  NO_APPROVAL_LEDGER,
  NO_MENTIONS,
  TurnContext,
  type ApprovalLedger,
  type MentionInjections,
  type TurnContextShape,
} from './TurnContext.js';

/**
 * Flatten a `string | MessageContent[]` prompt into the plain-text
 * payload the assembler hands to the model. Matches the legacy
 * `streamChat` behaviour (`typeof prompt === 'string' ? prompt : ''`)
 * — multi-block prompts are treated as empty for now because the rest
 * of the agent loop still consumes the legacy single-string path.
 */
function flattenPrompt(prompt: string | MessageContent[]): string {
  return typeof prompt === 'string' ? prompt : '';
}

/**
 * Read the agent's current `nextTurnSequence()` and synthesise a
 * per-turn id. The actual sequence counter lives on the agent; this
 * accessor exists so the assembler never has to reach inside the
 * private state of `duyaAgent`.
 */
function readTurnSequence(agent: AgentRuntime): number {
  return agent.readTurnSequence();
}

/**
 * Build a `TurnContext` from the current agent state plus a
 * `ChatOptions`. The agent parameter is typed as `AgentRuntime` (a
 * structural interface implemented by `duyaAgent`) so this module
 * does not pull in the 4473-line DuyaAgent.ts at module-load time.
 *
 * Every field is read once and frozen; downstream code can rely on
 * the `TurnContext` being immutable.
 */
export class TurnAssembler {
  /**
   * Build a `TurnContext` for one `streamChat` invocation.
   *
   * @param agent     Live agent instance whose state the assembler reads.
   * @param options   ChatOptions the caller passed to `streamChat`.
   * @param prompt    Raw prompt the caller passed to `streamChat`.
   */
  static build(
    agent: AgentRuntime,
    options: ChatOptions | undefined,
    prompt: string | MessageContent[],
  ): TurnContext {
    const shape: TurnContextShape = {
      turnId: options?.turnId
        ? { sequence: readTurnSequence(agent), id: options.turnId }
        : null,
      sessionId: agent.readSessionId() ?? null,
      workingDirectory: agent.readWorkingDirectory() ?? null,
      ...(agent.readCommunicationPlatform() !== undefined
        ? { communicationPlatform: agent.readCommunicationPlatform() }
        : {}),
      ...(agent.readLanguage() !== undefined ? { language: agent.readLanguage() } : {}),
      permissionMode: agent.readPermissionMode(),
      ...(agent.readHostToolPermission() !== undefined
        ? { hostToolPermission: agent.readHostToolPermission() }
        : {}),
      additionalWorkingDirectories: agent.readAdditionalWorkingDirectories(),
      approval: buildApprovalLedger(options, agent),
      mentions: buildMentions(options, agent),
      promptText: flattenPrompt(prompt),
    };
    return new TurnContext(shape);
  }
}

/**
 * Translate the per-turn approval ledger. The legacy agent uses two
 * instance fields (`_consumeApprovedEffect`, `_turnAlwaysAllowTools`)
 * that get reset at the top of every `streamChat`. The assembler
 * captures both into a frozen record so the loop body never reaches
 * back into the agent for them.
 */
function buildApprovalLedger(
  options: ChatOptions | undefined,
  agent: AgentRuntime,
) {
  const alwaysAllowTools = new Set<string>(
    options?.approvedAlwaysAllowTools ?? agent.readTurnAlwaysAllowTools(),
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
 * not in scope yet; for now the assembler records `provider` /
 * `skills` / `plugins` requested by the user and leaves `contexts`
 * empty. The follow-up commit that introduces the mention pipeline
 * will populate `contexts` here.
 */
function buildMentions(
  options: ChatOptions | undefined,
  _agent: AgentRuntime,
): MentionInjections {
  if (
    !options?.mentionedProviders &&
    !options?.mentionedSkills &&
    !options?.mentionedPlugins
  ) {
    return NO_MENTIONS;
  }
  // `mentionedPlugins` carries structured objects (plan 450); the
  // `TurnContext` only needs the bare names so the assembler flattens
  // them down. MentionResolver (later commit) populates `contexts`
  // with the rendered `<plugin-activation>` blocks.
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