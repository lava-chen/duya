/**
 * TurnAssembler — Plan 550 step 2a-2, IO half only since Plan 587 M5.4.
 *
 * `duyaAgent.streamChat` tracks 60+ private fields just to build one
 * turn. `TurnAssembler.build(agent, options, prompt)` reads a consistent
 * snapshot of the agent's per-turn state and hands it to the pure
 * derivation in `turnShape.ts`, which returns a `TurnContextShape`
 * (see `TurnContext.ts`).
 *
 * The split is deliberate and is not a relocation. Everything that is a
 * *rule* — which fields are present, how a prompt flattens, when the
 * approval ledger collapses to its empty value, how mention descriptors
 * reduce to names — moved to `turnShape.ts`, where it is a pure function
 * of data and can be tested without constructing an agent. What remains
 * here is the part that genuinely needs the agent: reading it.
 *
 * Reading each accessor exactly once is the second reason for the
 * snapshot. The previous body called `readCommunicationPlatform()` and
 * `readLanguage()` twice each, in expression order, so any state that
 * moved mid-assembly could produce a context whose fields disagreed with
 * each other. One read per value makes a turn internally consistent.
 *
 * The agent parameter is typed as `AgentRuntime` (a structural interface
 * implemented by `duyaAgent`) so this module does not pull in the
 * 5000-line DuyaAgent.ts at module-load time.
 *
 * @see docs/exec-plans/active/587-agent-harness-monorepo/06-package-and-host-migration.md
 */

import type { ChatOptions, MessageContent } from '../types.js';
import type { AgentRuntime } from './AgentRuntime.js';
import { TurnContext, type TurnContextShape } from './TurnContext.js';
import { buildTurnShape, type TurnStateSnapshot } from './turnShape.js';

export type { TurnStateSnapshot } from './turnShape.js';
export { buildTurnShape, flattenPrompt } from './turnShape.js';

/**
 * Read the agent exactly once per field.
 *
 * This is the only place `TurnAssembler` talks to the agent. Returning a
 * plain value (rather than letting the derivation call back in) is what
 * guarantees every field in a turn comes from the same observation.
 */
export function readAgentSnapshot(agent: AgentRuntime): TurnStateSnapshot {
  return {
    turnSequence: agent.readTurnSequence(),
    sessionId: agent.readSessionId(),
    workingDirectory: agent.readWorkingDirectory(),
    communicationPlatform: agent.readCommunicationPlatform(),
    language: agent.readLanguage(),
    permissionMode: agent.readPermissionMode(),
    hostToolPermission: agent.readHostToolPermission(),
    additionalWorkingDirectories: agent.readAdditionalWorkingDirectories(),
    alwaysAllowTools: agent.readTurnAlwaysAllowTools(),
  };
}

/**
 * Build a `TurnContext` for one `streamChat` invocation.
 *
 * @param agent     Live agent instance whose state the assembler reads.
 * @param options   ChatOptions the caller passed to `streamChat`.
 * @param prompt    Raw prompt the caller passed to `streamChat`.
 */
export class TurnAssembler {
  /**
   * Read the agent, derive the shape, freeze it.
   */
  static build(
    agent: AgentRuntime,
    options: ChatOptions | undefined,
    prompt: string | MessageContent[],
  ): TurnContext {
    const shape: TurnContextShape = buildTurnShape(
      readAgentSnapshot(agent),
      options,
      prompt,
    );
    return new TurnContext(shape);
  }
}
