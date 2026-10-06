/**
 * Plan 610 A3-2b10 (S4a): the host's hook source, on the engine's extension port.
 *
 * ## What this is
 *
 * The thing `ExtensionPort` was declared for and had no producer. Until now
 * `RunEnginePorts.extensions` was never bound by anything -- `buildEnginePorts`
 * has no member for it and `LegacyRunHost` had no hook member -- so
 * `#contribute` read `?? []` at all five call sites and the engine dispatched
 * ZERO hook events. A run driven by the engine therefore ran no `PreToolUse`
 * and no `SessionStart`, while the legacy cycle ran both, and the only symptom
 * was a hook's output quietly missing.
 *
 * So this is a TRANSLATION, in the same sense `createLegacyAssembleTurn` is
 * (`run-composition.ts`): the legacy's `ConfigHooksRunner` already executes real
 * hooks, and this file does not re-implement matching, execution, fail-open
 * handling or `${VAR}` expansion. It decides only WHICH event fires at WHICH
 * engine phase, and translates the two contexts into each other's vocabulary.
 *
 * ## The map, and it is a MEASURED one
 *
 * | engine phase | hook events | legacy dispatch site |
 * | --- | --- | --- |
 * | `on_start` | `UserPromptSubmit`, `SessionStart` | `DuyaAgent.ts:2130`, `:2144` |
 * | `before_tool` | `PreToolUse` | `DuyaAgent.ts:3349` |
 * | `after_tool` | `PostToolUse` | see "the one difference" below |
 * | `after_finalize` | `Stop`, `SessionEnd` | `SessionFinalizer.ts:268`, `:248`, `:274` |
 *
 * The three phases NOT in this table are not forgotten. `before_turn`,
 * `before_model` and `before_finalize` are the engine's own phases, and the
 * legacy's `PreTurn` / `PreFinalize` / `PostTurn` run on the mode
 * coordinator's LOOP BUS (`hooks/loop.ts`), not on the config runner. Wiring
 * that is the orchestrator slice, and a contributor registered for those three
 * phases today is called and has nothing to fire.
 *
 * `after_finalize` is the only phase with per-EVENT conditions. What it fires
 * is narrower than the conditions imply, and the reason is the `signal.aborted`
 * guard in `contributorsFor` rather than anything about exit reasons: the legacy
 * dispatches `SessionEnd` from `finalizeSuccess` and from `finalizeAbort`, and
 * dispatches NOTHING from `finalizeStreamError` -- including when that method
 * maps an `AbortError` onto the same `done('aborted')` terminal `finalizeAbort`
 * uses. It also dispatches nothing at all from `streamChat`'s two ceiling exits
 * and its four early `done('completed')` exits, none of which call a finalizer.
 * A contributor that cannot read `ExtensionContext.exit` has to guess between
 * those, and guessing wrong on a failed run announces a clean session end for a
 * run that crashed. Measured on both paths by
 * `engine-session-end-parity.test.ts`.
 *
 * ## The ONE difference from the legacy, stated rather than buried
 *
 * `PostToolUse` is fired here PER TOOL RESULT, with the full config-hook
 * payload (`tool_name`, `tool_input`, `tool_response`, `tool_use_id`).
 *
 * The legacy does not do that. Its `PostToolUse` goes through the loop bus
 * (`DuyaAgent.ts:3729`) as `BaseHookInput` plus a `turnCount` and a
 * dead-loop streak, and `config-loop.ts:199-215` documents the consequence
 * outright: "PostToolUse is dispatched per turn here, not per tool call". A
 * turn that dispatches three tools fires one `PostToolUse` there and three
 * here.
 *
 * Per-result is what the `PostToolUseHookInputSchema` describes and what
 * `ConfigHooksRunner`'s `toolName` matcher target filters on, so it is the
 * faithful reading of the EVENT; it is not the faithful reading of the current
 * dispatch. Reconciling the two means owning the loop bus, which is why it is
 * named here and not shipped silently. `hook-source-post-tool-use` in the S4a
 * proof pins the per-result count so the difference cannot drift unnoticed in
 * either direction.
 *
 * ## `PostToolUseFailure` is DELIBERATELY absent from the table above
 *
 * It is absent because it is ALREADY WIRED on the engine path, through a
 * different seam -- and adding it here would fire every user's failure hook
 * twice per failed tool.
 *
 * The chain, which is the part worth knowing:
 *
 *   engine `#drainOutcomes` -> `TurnOutputPort.recordToolResult`
 *     -> `turnOutput.onToolResult` (the binding below)
 *     -> `DuyaAgent.recordTurnToolResult`
 *     -> `DuyaAgent.dispatchPostToolUseFailure`
 *     -> `ConfigHooksRunner.run('PostToolUseFailure', ...)`
 *
 * That is a `ConfigHooksRunner` event and NOT a `LoopHookEvent` member, so it
 * never passes through the loop bus -- but it does not need to, because the
 * engine's drain already visits the same moment the legacy's dispatch did. The
 * error bit and the tool name both arrive on the record
 * (`ToolResultRecord.outcome` / `.toolName`), which is why the payload a
 * configured hook receives is complete.
 *
 * `packages/agent/src/process/__tests__/engine-post-tool-use-failure.test.ts`
 * is the proof: a real `RunEngineImpl`, the real agent seam, and a real hook
 * subprocess that counts its own dispatches. It asserts EXACTLY ONE, so a future
 * implementer who adds this event to `PHASE_EVENTS` sees two and is corrected
 * by a test rather than by this comment.
 *
 * ## What this file does NOT do: adopt the contexts
 *
 * Every contribution returned below is a real `additionalContext` string from a
 * real hook, and the engine currently DISCARDS the return value of `#contribute`
 * at every phase except `before_finalize`, which reads only its veto. So a hook
 * that returns context is executed and its output is dropped.
 *
 * That is a pre-existing property of the other five phases, not something this
 * file introduces, and it is why `on_start` / `after_finalize` are shipped as
 * plain dispatches rather than as a new adoption rule that applies to only two
 * of seven phases. Adoption is a separate change that has to answer where a
 * `before_tool` context goes when the turn's drain has already run -- one rail,
 * all seven phases.
 */

import type {
  ExtensionContext,
  ExtensionContribution,
  ExtensionContributor,
  ExtensionPhase,
  ExtensionPort,
} from '@duya/agent-runtime';
import { ConfigHooksRunner } from '../hooks/events.js';
import type { EventHookInput, EventHookMatcherTargets } from '../hooks/events.js';
import type { HookInvokedEvent, HooksSettings } from '../hooks/types.js';

export interface LegacyHookSourceOptions {
  /** Working directory for hook subprocesses. The run's cwd, not the process's. */
  readonly cwd: string;
  /** Correlates `session_id` across every event this source raises. */
  readonly sessionId: string;
  /** The user prompt, for `UserPromptSubmit`. Empty when the host has none. */
  readonly prompt?: string;
  /** Injected settings; defaults to a fresh `readHooksConfig()` in the runner. */
  readonly settings?: HooksSettings;
  /**
   * Surfaces every matched hook, as the legacy does (`DuyaAgent.ts:2069`).
   *
   * Forwarded rather than reimplemented, and it is the ONLY way a host can
   * observe a dispatch today: the engine discards `#contribute`'s return value
   * at every phase but `before_finalize`, so the `additionalContext` a hook
   * produced is not yet readable from the engine side. A hook that ran is
   * visible here whether or not anything adopted what it said.
   */
  readonly onHookInvoked?: (event: HookInvokedEvent) => void;
}

/**
 * The engine-enforced cap on one contributor, from `ExtensionContributor`.
 *
 * NOT the hooks' own budget: `executor.ts` clamps a single command hook to
 * 1-300s and a process hook to 1-300s (`COMMAND_TIMEOUT_RANGE`,
 * `PROCESS_TIMEOUT_RANGE`). A contributor here runs N of them in sequence, so
 * the engine's ceiling is one hook's own ceiling rather than N of it -- the
 * point is that the engine must not cut short a hook that the executor was
 * willing to let run, and a per-contributor cap below 300s would do exactly
 * that on a slow third hook in a list.
 */
const CONTRIBUTOR_TIMEOUT_MS = 300_000;

/** What a `before_tool` dispatch has to remember so `after_tool` can name it. */
interface SeenCall {
  readonly name: string;
  readonly input: Readonly<Record<string, unknown>>;
}

/**
 * The events this source can raise, derived from the map below.
 *
 * `payloadFor` takes THIS rather than the whole `HookEvent` union, which turns
 * "an event was added to the table with no payload" from a runtime `never`
 * assertion into a compile error at the table -- the failure lands where the
 * mistake was made rather than at the first dispatch that reaches it.
 */
type MappedHookEvent = 'UserPromptSubmit' | 'SessionStart' | 'PreToolUse' | 'PostToolUse' | 'Stop' | 'SessionEnd';

/**
 * The phase -> events map, as DATA rather than as a `switch`.
 *
 * A `Partial<Record<ExtensionPhase, ...>>` is the honest encoding: the three
 * absent keys are the three phases this source has nothing to fire, and a
 * `Record` that forced them to name a filler event would make "unmapped" and
 * "mapped to a no-op" indistinguishable at every call site.
 *
 * `PostToolUseFailure` is absent FROM THIS TABLE but is NOT missing from the
 * engine path -- it arrives through the `turnOutput` port instead, and adding it
 * here would double-dispatch it. See the header, "PostToolUseFailure is
 * DELIBERATELY absent from the table above", for the chain and the proof.
 */
const PHASE_EVENTS: Readonly<Partial<Record<ExtensionPhase, readonly MappedHookEvent[]>>> = Object.freeze({
  on_start: ['UserPromptSubmit', 'SessionStart'],
  before_tool: ['PreToolUse'],
  after_tool: ['PostToolUse'],
  after_finalize: ['Stop', 'SessionEnd'],
});

/**
 * The one event that fires on a condition rather than always.
 *
 * `SessionEnd` on everything except a failure. Read off the exit rather than off
 * the signal, because `signal.aborted` is ALSO true for a run that failed after
 * the user had already stopped it.
 *
 * ## The `Stop` arm is reachable, and it was unreachable by ORDER rather than
 * by mapping
 *
 * It used to read "`Stop` on a cancelled run, `SessionEnd` on everything except
 * a failure", and to justify itself by saying `SessionFinalizer` "keys its two
 * dispatches off the same three-way split the engine's `EngineExitReason` is".
 * That justification was false -- `SessionFinalizer` has THREE methods and
 * chooses between them by control flow -- but the arm's INTENT matched the
 * legacy on one of its two abort routes, and the intent was unreachable for a
 * reason that had nothing to do with this function: `contributorsFor` tested
 * `signal.aborted` and returned BEFORE calling it, so on a cancelled run every
 * contributor was already empty.
 *
 * Plan 610 D2 CLOSED that, by testing the exit reason FIRST. A cancelled run
 * now reaches this function, `Stop` fires, and `SessionEnd` fires after it --
 * which is what `SessionFinalizer.finalizeAbort` dispatches, and in that order.
 * Measured on BOTH paths through one `ConfigHooksRunner` dispatch spy in
 * `engine-session-end-parity.test.ts`; the legacy's second abort route, which
 * reaches `finalizeStreamError` and dispatches nothing, is recorded there
 * rather than reproduced, because the engine has one `cancelled` reason and
 * cannot observe which route it took.
 */
function firesOnExit(event: MappedHookEvent, reason: string | undefined): boolean {
  if (reason === 'failed') return false;
  if (event === 'Stop') return reason === 'cancelled';
  return true;
}

/** The `${KEY}` expansion values the runner is given, matching `DuyaAgent.ts:2062-2068`. */
function expansionVars(options: LegacyHookSourceOptions): Record<string, string> {
  return { sessionId: options.sessionId, cwd: options.cwd, prompt: options.prompt ?? '' };
}

/**
 * Build the one run's hook source.
 *
 * One source per RUN, and that is what rule 5 asks for: extensions are
 * unloaded between runs, never during one, so a source shared across two runs
 * would be the mechanism by which one run's frames become attributable to
 * another's code.
 */
export function createLegacyHookSource(options: LegacyHookSourceOptions): ExtensionPort {
  const runner = new ConfigHooksRunner({
    cwd: options.cwd,
    vars: expansionVars(options),
    ...(options.settings === undefined ? {} : { settings: options.settings }),
    ...(options.onHookInvoked === undefined ? {} : { onHookInvoked: options.onHookInvoked }),
  });

  // The `PostToolUse` correlation. Per SOURCE rather than per contributor
  // because the record and the read happen at two different phases, and a
  // per-contributor map would be rebuilt from empty at each phase.
  //
  // Bounded by the run's own tool-call ceiling: entries are deleted when
  // `after_tool` consumes them, so only calls that were dispatched and then
  // never drained (denied, discarded mid-run) survive, one small object each.
  const seenCalls = new Map<string, SeenCall>();

  /** The engine's `call`, or the `throw` that a bad contributor deserves. */
  function requireCall(ctx: ExtensionContext): NonNullable<ExtensionContext['call']> {
    if (ctx.call === undefined) {
      throw new Error('the engine called before_tool with no call in its context');
    }
    return ctx.call;
  }

  function requireOutcome(ctx: ExtensionContext): NonNullable<ExtensionContext['outcome']> {
    if (ctx.outcome === undefined) {
      throw new Error('the engine called after_tool with no outcome in its context');
    }
    return ctx.outcome;
  }

  /**
   * The event's own payload, in the legacy's own field names.
   *
   * `base()` is the three fields every `BaseHookInputSchema` requires
   * (`types.ts:65-71`), built the way `buildHookCtx()` builds them, so a hook
   * that reads `session_id` off stdin sees what it saw before the cutover.
   */
  function base(event: MappedHookEvent): EventHookInput {
    return {
      session_id: options.sessionId,
      cwd: options.cwd,
      hook_event_name: event,
    };
  }

  function payloadFor(
    event: MappedHookEvent,
    ctx: ExtensionContext,
  ): { input: EventHookInput; targets: EventHookMatcherTargets | undefined } {
    switch (event) {
      case 'UserPromptSubmit':
        return { input: { ...base(event), prompt: options.prompt ?? '' }, targets: undefined };
      case 'SessionStart':
        // `source` is a REQUIRED field of `SessionStartHookInputSchema` and its
        // union has no member meaning "an engine-driven run", so the legacy's
        // own `'startup'` is the honest value: a run that begins is a run that
        // started. Inventing a member for the engine's benefit would change
        // what an existing hook matches.
        return { input: { ...base(event), source: 'startup' }, targets: undefined };
      case 'PreToolUse': {
        const call = requireCall(ctx);
        // Recorded HERE, because this is the only phase the engine reports a
        // call's name and arguments at. `PostToolUseHookInputSchema` needs both
        // and `after_tool` carries neither -- `ExtensionContext.outcome` is a
        // result, deliberately, because the drain is where a deferred context
        // is not a result. The legacy correlates the same way, with its own
        // `turnToolCallIds` map (`DuyaAgent.ts:3650`).
        seenCalls.set(call.callId, { name: call.name, input: call.input });
        return {
          input: {
            ...base(event),
            tool_name: call.name,
            tool_input: call.input,
            tool_use_id: call.callId,
          },
          targets: { toolName: call.name },
        };
      }
      case 'PostToolUse': {
        const outcome = requireOutcome(ctx);
        const seen = seenCalls.get(outcome.callId);
        seenCalls.delete(outcome.callId);
        return {
          input: {
            ...base(event),
            // `''` and `{}` rather than a throw when the call is unknown: a
            // `PostToolUse` with no recorded call is a result the drain
            // produced for a call the engine never announced, and failing the
            // whole phase over it would lose every other hook on this event.
            // Same fallback the legacy takes for a tool name it cannot
            // attribute (`DuyaAgent.ts:3650`).
            tool_name: seen?.name ?? '',
            tool_input: seen?.input ?? {},
            tool_response: outcome.content,
            tool_use_id: outcome.callId,
          },
          targets: seen === undefined ? undefined : { toolName: seen.name },
        };
      }
      case 'Stop':
        return { input: { ...base(event), reason: 'user_request' }, targets: undefined };
      case 'SessionEnd':
        return { input: { ...base(event), reason: 'user_exit' }, targets: undefined };
    }
  }

  /**
   * One contributor per (phase, event), so rule 1's ordering is data.
   *
   * `order` is the event's index within its phase, times a step wide enough to
   * leave room for a host's own contributors at the same phase without
   * colliding. `UserPromptSubmit` before `SessionStart` is the legacy's order
   * (`DuyaAgent.ts:2130` then `:2144`) and it matters: both feed the same
   * first-turn context rail, so a session that starts before the prompt is
   * submitted inverts the provenance the envelopes carry.
   */
  function contributorsFor(phase: ExtensionPhase): readonly ExtensionContributor[] {
    const events = PHASE_EVENTS[phase];
    if (events === undefined) return [];
    return events.map((event, index) => ({
      id: `hook:${event}@${phase}`,
      phase,
      order: index * 10,
      timeoutMs: CONTRIBUTOR_TIMEOUT_MS,
      async contribute(ctx: ExtensionContext, signal: AbortSignal): Promise<readonly ExtensionContribution[]> {
        // Plan 610 D2: the exit-reason test comes FIRST, so a run that ends on
        // `cancelled` still reaches its teardown hooks. It used to come second,
        // which made `firesOnExit`'s `Stop` arm unreachable rather than merely
        // unused: `signal.aborted` is necessarily true on every cancelled run,
        // so the contributor returned empty and dispatched NOTHING.
        //
        // The legacy dispatches `Stop` then `SessionEnd` from
        // `SessionFinalizer.finalizeAbort`, and a user who stops a run still
        // expects its cleanup hooks to run. Measured on both paths in
        // `engine-session-end-parity.test.ts`.
        //
        // The signal guard is NOT removed, only narrowed to the phases where a
        // stop actually means "stop working": the four in-turn phases. A
        // `before_tool` hook must not start new work after a stop, and this is
        // the only place a contributor can check -- the config runner spawns its
        // own subprocesses and takes no signal, so a stop cannot be pushed INTO
        // a running hook. A hook that is mid-flight at a stop runs to the
        // engine's `withDeadline` timeout; stated rather than implied.
        if (ctx.exit === undefined && signal.aborted) return [];
        if (ctx.exit !== undefined && !firesOnExit(event, ctx.exit.reason)) return [];

        const { input, targets } = payloadFor(event, ctx);
        const result =
          targets === undefined
            ? await runner.run(event, input)
            : await runner.run(event, input, targets);

        // `contexts` are the hooks' `additionalContext` lines. The KEY is what
        // makes a repeated fragment REPLACE rather than stack
        // (`TransientFragmentBase.key`), and it is keyed per call so two
        // PreToolUse advisories for the same tool do not overwrite each other
        // -- which is the behaviour the legacy gets from
        // `applyHookInjection(..., 'PreToolUse:<name>', ...)`
        // (`DuyaAgent.ts:3375-3378`).
        return result.contexts.map((text, seq): ExtensionContribution => ({
          key: `hook:${event}:${ctx.call?.callId ?? ctx.turn}:${seq}`,
          content: { kind: 'hook_context', key: `hook:${event}:${ctx.call?.callId ?? ctx.turn}:${seq}`, text },
          binding: false,
        }));
      },
    }));
  }

  return {
    list: contributorsFor,
    // Rule 5: the runner holds no registered extension state -- it reads its
    // settings at CONSTRUCTION and dispatches from them -- so there is nothing
    // to release between runs. Saying so is the point; a `resolve` that
    // silently did nothing would look identical to a real unload.
    unload: () => Promise.resolve(),
  };
}

/**
 * The phases this source maps, for a host that wants to assert on it.
 *
 * Exported so a test can pin the MAP rather than infer it from what happened to
 * fire, which is the difference between "this source is configured for these
 * phases" and "these phases happened to have a hook".
 */
export const MAPPED_PHASES: readonly ExtensionPhase[] = Object.freeze(
  (Object.keys(PHASE_EVENTS) as ExtensionPhase[]).filter((phase) => PHASE_EVENTS[phase] !== undefined),
);
