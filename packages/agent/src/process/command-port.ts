/**
 * Plan 610 D1: bind the engine's `RunCommandPort` to the PRODUCT's command
 * surface, so a recognised control command is answered by the product and ends
 * the run before any model call.
 *
 * ## Why this file exists at all, and what it is NOT
 *
 * Without it, the cutover sends `/goal` to the model as literal text and the
 * model answers it conversationally. That is a silent, obvious regression: the
 * command still "works" from a user's point of view except that it burns a
 * model call, hallucinates a tool call the product should have made, and can
 * report a goal state the tracker never entered.
 *
 * This is a BINDING and not a second implementation, which is the whole point
 * and the reason it is worth a separate file. The command surface already
 * exists and already has TWO callers -- the CLI registry
 * (`cli/slash-commands.ts`) and, before the engine cutover,
 * `DuyaAgent.streamChat` -- and both of them reach the same two modules:
 *
 * - `modes/goal/goal-commands.ts` -- `isGoalControlCommand` / `handleGoalCommand`
 * - `session/transcript-commands.ts` -- `isTranscriptControlCommand` /
 *   `handleTranscriptCommand`
 *
 * So the engine path became the THIRD caller of the same functions, and the
 * `/goal` half is reached through `LegacyCommandContext.runGoalCommand` --
 * `duyaAgent`'s own method, which dispatches with the same two functions. A
 * second `isGoalCommand` here would be a third definition of what
 * `/goal status` means, and the three could disagree without any test failing
 * -- which is exactly the double-execution / double-tagging failure class the
 * previous two slices of this plan existed to avoid.
 *
 * ## Why `/goal` is INJECTED while the transcript family is imported
 *
 * Measured, not preferred: `transcript-commands.ts` is not in a module cycle,
 * and `goal-commands.ts` is, because `goal-tools -> goal-summarizer ->
 * runAgent` reaches the driver that composes this very port. Importing it here
 * grew the SCC containing `hooks/builtin.ts` from 17 to 21 members.
 * `agent/DuyaAgent.ts`'s `runGoalCommand` is the injection point that keeps it
 * at 17 -- see that method's own header for the alternatives and their
 * measurements.
 *
 * ## The order is the legacy's, and it is load-bearing
 *
 * `DuyaAgent.streamChat` tested `/goal` FIRST and the transcript family second
 * (`DuyaAgent.ts:2411` then `:2423`). The two sets do not overlap today, so
 * swapping them would be invisible -- but the order is copied rather than
 * invented so that a future command added to both families resolves the way the
 * product already resolves it, instead of the way this file happened to write.
 *
 * ## What `null` means, and why the transcript family must be able to return it
 *
 * `null` means "not a control command; run the model". Both recognisers are
 * consulted, and BOTH must decline:
 *
 * - `isGoalControlCommand('/goal ship the release')` is `false` on purpose --
 *   an OBJECTIVE starts a goal through the model, which calls `goal_start`
 *   (`goal-commands.ts`, module header). Treating it as a command would answer
 *   a goal with usage text and never start anything.
 * - `isTranscriptControlCommand('/exports')` is `false`: the verb set is an
 *   exact match, so a near-miss goes to the model.
 *
 * An unregistered `/`-prefixed prompt therefore returns `null` and reaches the
 * provider verbatim, which is what the legacy does -- both recognisers fail,
 * `streamChat` falls through, and the prompt is sent. A gate that answered
 * every `/`-prefixed prompt would swallow every unregistered command, and a
 * user could observe the difference immediately.
 *
 * ## `/copy` and the clipboard: the HOST's channel, performed here
 *
 * `handleTranscriptCommand` returns `clipboardText` for `/copy`, and the
 * legacy turns it into a `chat:clipboard_write` event
 * (`DuyaAgent.ts:2430`). That event belongs to the worker's own frame protocol,
 * which the runtime knows nothing about, so the write happens HERE -- inside
 * the host's `resolve`, which is the only layer that owns that channel. The
 * engine receives the reply text alone and publishes it as the run's assistant
 * message; it never learns a clipboard existed.
 *
 * Guarded on `sessionId` exactly as the legacy guards it
 * (`DuyaAgent.ts:2429`): with no session there is no renderer to write for, and
 * the legacy sends nothing.
 */

import type { RunCommandOutcome, RunCommandPort } from '@duya/agent-runtime';
import type { ModelMessage } from '@duya/agent-runtime';
import type { Message } from '../types.js';
import {
  handleTranscriptCommand,
  isTranscriptControlCommand,
} from '../session/transcript-commands.js';
import { buildClipboardWriteEvent, sendEvent } from './worker-protocol.js';

/** What the host knows about the run a command would act on. */
export interface LegacyCommandContext {
  /** `turnContext.sessionId`. Undefined is a legitimate state, not an error. */
  readonly sessionId?: string;
  /** `turnContext.workingDirectory`. `/export` resolves its target against it. */
  readonly workingDirectory?: string;
  /** `agent.getMessages()`. The transcript family reads it; `/goal` does not. */
  readonly messages: readonly Message[];
  /**
   * Where `/goal` is answered. Plan 610: INJECTED, not imported.
   *
   * Declared structurally so this port names the BEHAVIOUR rather than a mode's
   * implementation -- the same reason `LegacyRunHost.runFork` is declared
   * structurally. `duyaAgent.runGoalCommand` satisfies it, and the port can no
   * longer reach `modes/goal` even by accident, which is what keeps
   * `command-port -> goal-commands` out of the module cycle.
   *
   * `null` means "not a `/goal` control verb", which is the answer an objective
   * (`/goal ship the release`) gets so it can reach the model.
   */
  readonly runGoalCommand: (
    prompt: string,
    context: { readonly sessionId?: string; readonly workingDirectory?: string },
  ) => Promise<string | null>;
}

/**
 * The prompt as text, or `null` when it is not a plain string.
 *
 * ## Why a block-structured prompt can never be a command
 *
 * `ModelMessage.content` is `string | readonly ModelContentBlock[]`, and the
 * block arm is what an image attachment arrives as. The legacy's own guard is
 * `typeof prompt === 'string' ? prompt : ''` (`DuyaAgent.ts:2406`), so a
 * multi-part prompt yields the empty string, which matches nothing and falls
 * through to the model. Reproduced rather than improved: widening this to
 * "search the text blocks for `/goal`" would make an image-plus-caption turn
 * answer a command the legacy sends to the model, and the engine has no way to
 * cancel the attachment that made the run.
 */
function promptText(prompt: ModelMessage): string | null {
  return typeof prompt.content === 'string' ? prompt.content : null;
}

/**
 * Build the engine's `RunCommandPort` over the product's own command surface.
 *
 * Exported as a factory rather than a constant because the context is
 * per-RUN: `messages` is the live transcript and `sessionId` is this run's, so
 * a module-level singleton would either capture the first run's session or read
 * a mutable "current run" cell -- the second authority the composition layer
 * exists to prevent. `composeLegacyRunPorts` builds one per run.
 */
export function createLegacyCommandPort(context: LegacyCommandContext): RunCommandPort {
  return {
    async resolve({ prompt }): Promise<RunCommandOutcome | null> {
      const text = promptText(prompt);
      if (text === null) return null;

      // ── `/goal` FIRST, in the legacy's order ──────────────────────────────
      // The recogniser AND the handler are the agent's, reached through the
      // injected collaborator: one definition of the verb table, and no import
      // from this port into a specific mode's implementation.
      const goalReply = await context.runGoalCommand(text, {
        ...(context.sessionId === undefined ? {} : { sessionId: context.sessionId }),
        ...(context.workingDirectory === undefined
          ? {}
          : { workingDirectory: context.workingDirectory }),
      });
      if (goalReply !== null) return { reply: goalReply };

      // ── the transcript family, SECOND ─────────────────────────────────────
      if (isTranscriptControlCommand(text)) {
        const result = handleTranscriptCommand(text, {
          messages: context.messages,
          ...(context.sessionId === undefined ? {} : { sessionId: context.sessionId }),
          ...(context.workingDirectory === undefined
            ? {}
            : { workingDirectory: context.workingDirectory }),
        });
        // The HOST's clipboard channel, performed here rather than returned.
        // Same guard as the legacy's: no session, no renderer, no event.
        if (result.clipboardText !== undefined && context.sessionId !== undefined) {
          sendEvent(
            buildClipboardWriteEvent(context.sessionId, result.clipboardText) as unknown as Record<
              string,
              unknown
            >,
          );
        }
        return { reply: result.reply };
      }

      // Neither recogniser claimed it. The model answers, exactly as the
      // legacy does after both of its `if`s fall through.
      return null;
    },
  };
}