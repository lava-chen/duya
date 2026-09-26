/**
 * Loop-level hook bus (plan 426): the engine-internal event spine of the
 * agent loop.
 *
 * Distinct from the config-level hook vocabulary in ./types.ts (plan 87,
 * user-configurable command/prompt/http/agent hooks): loop hooks are
 * in-process callbacks registered per run by the harness itself and, later,
 * by first-party modes. They receive rich loop context (the working message
 * array, turn counters, stop reasons) that external hooks never see.
 *
 * Contract:
 * - Engine invariants (dead-loop hard stop, max-turns stop, mailbox
 *   checkpoints, consecutive-call counting) stay in the loop and are never
 *   removable. Loop hooks carry steering *policy* only.
 * - Single injection channel: hooks never push to `messages` directly. They
 *   return effects; {@link applyLoopHookEffect} wraps them in
 *   `<system-reminder>` (plan 408), adapts them through the
 *   RuntimeContextMessage framework, and projects a provider user turn.
 * - Failure isolation: a throwing handler is logged and skipped. Steering
 *   hooks fail open (allow finalize) — a broken nudge must never brick the
 *   loop.
 */

import type { Message } from '../types.js';
import type { RuntimeContextSource } from '../message/message-framework.js';
import { renderSystemReminder } from '../agent/reminders.js';
import { adaptLoopNudgeContext } from '../message/runtime-context-adapters.js';
import { projectRuntimeContextToProviderMessage } from '../message/message-projectors.js';
import { logger } from '../utils/logger.js';
import { applyHookInjection, type InjectableMessage } from './injection.js';

// ============================================================================
// Events & context
// ============================================================================

/**
 * Loop events dispatched by the agent loop. `PreFinalize` is the
 * veto-capable point: the model ended its turn naturally and the engine is
 * about to finalize when the bus is consulted.
 */
export type LoopHookEvent = 'PreTurn' | 'PostToolUse' | 'PreFinalize' | 'PostTurn';

/**
 * Consecutive identical tool-call statistics tracked by the engine (the
 * counting itself is an engine invariant). Passed on PostToolUse so the
 * dead-loop nudge hook can decide soft/hard/no nudge.
 */
export interface ConsecutiveToolCallStats {
  /** Current streak length of identical calls (name + serialized input). */
  count: number;
  /** Name of the tool in the current streak. */
  toolName: string;
  /** Threshold where the soft "change approach" nudge fires. */
  nudgeAt: number;
  /** Threshold where the stronger "stop repeating" nudge fires. */
  hardNudgeAt: number;
}

/** Context handed to every loop hook dispatch. */
export interface LoopHookDispatchContext {
  /** Which event fired this dispatch. */
  event: LoopHookEvent;
  sessionId?: string;
  turnCount: number;
  seqIndex: number;
  /** Read-only view of the working message array (provider turns). */
  messages: readonly Message[];
  /** Original run prompt, string form when available. */
  prompt?: string;
  /** The LLM's native stop reason for the just-finished turn (PreFinalize). */
  stopReason?: string;
  /** Present on PostToolUse when an identical-call streak is being tracked. */
  consecutiveIdenticalToolCalls?: ConsecutiveToolCallStats;
  /** Tool calls the assistant emitted this turn (PostToolUse only). Lets
   * configured hooks (plan 426 Phase 4) match on tool name via `matcher`. */
  toolCalls?: ReadonlyArray<{ name: string; input: unknown }>;
}

// ============================================================================
// Effects
// ============================================================================

/** `inject`: transient `<system-reminder>` push. Valid at PreTurn / PostToolUse / PostTurn. */
export interface LoopHookInjectEffect {
  type: 'inject';
  /** Inner text of the system-reminder block (no wrapper). */
  injection: string;
  source: RuntimeContextSource;
  /**
   * Context-injection governance key (hooks/config-loop only). When set,
   * {@link applyLoopHookEffect} routes the push through the dedup /
   * replace-last chokepoint instead of blind append: identical content
   * already in the run is skipped; a newer block with the same key replaces
   * the previous one in place (verifier "latest state" semantics).
   */
  dedupKey?: string;
}

/** `block_finalize`: veto the finalize, inject, continue the loop. PreFinalize only. */
export interface LoopHookBlockFinalizeEffect {
  type: 'block_finalize';
  injection: string;
  source: RuntimeContextSource;
}

export type LoopHookEffect = LoopHookInjectEffect | LoopHookBlockFinalizeEffect;

// ============================================================================
// Registration & bus
// ============================================================================

export interface LoopHookRegistration {
  /** Stable identifier; unregister removes every registration sharing it. */
  id: string;
  events: readonly LoopHookEvent[];
  /** Lower runs earlier within an event. Default 100. */
  priority?: number;
  handler: (
    ctx: LoopHookDispatchContext,
  ) => Promise<LoopHookEffect | void> | LoopHookEffect | void;
}

/** Effects honored per event: injects everywhere, one veto at PreFinalize. */
const VALID_EFFECTS: Record<LoopHookEvent, LoopHookEffect['type'][]> = {
  PreTurn: ['inject'],
  PostToolUse: ['inject'],
  PreFinalize: ['block_finalize'],
  PostTurn: ['inject'],
};

export class LoopHookBus {
  private registrations: LoopHookRegistration[] = [];

  register(registration: LoopHookRegistration): void {
    this.registrations.push(registration);
    this.registrations.sort((a, b) => (a.priority ?? 100) - (b.priority ?? 100));
  }

  unregister(id: string): void {
    this.registrations = this.registrations.filter((r) => r.id !== id);
  }

  list(): readonly LoopHookRegistration[] {
    return this.registrations;
  }

  /**
   * Dispatch an event in priority order. Collects `inject` effects; at
   * PreFinalize the first `block_finalize` wins and short-circuits the
   * remaining handlers (veto exclusivity mirrors the fixed
   * premature-stop → goal-continuation → todo-gate ordering the loop had
   * before plan 426). Throws inside a handler are isolated (fail-open).
   */
  async dispatch(event: LoopHookEvent, ctx: Omit<LoopHookDispatchContext, 'event'>): Promise<LoopHookEffect[]> {
    const valid = VALID_EFFECTS[event];
    const effects: LoopHookEffect[] = [];
    for (const registration of this.registrations) {
      if (!registration.events.includes(event)) continue;
      let effect: LoopHookEffect | void;
      try {
        effect = await registration.handler({ ...ctx, event });
      } catch (err) {
        logger.warn(
          `[LoopHook] '${registration.id}' threw at ${event}; skipping (${err instanceof Error ? err.message : String(err)})`,
        );
        continue;
      }
      if (!effect) continue;
      if (!valid.includes(effect.type)) {
        logger.warn(
          `[LoopHook] '${registration.id}' returned ${effect.type} at ${event}; only ${valid.join('/')} is honored`,
        );
        continue;
      }
      effects.push(effect);
      if (effect.type === 'block_finalize') break;
    }
    return effects;
  }
}

// ============================================================================
// Single injection channel
// ============================================================================

/**
 * Apply a hook effect to the working message array: wrap in
 * `<system-reminder>`, adapt through the RuntimeContextMessage framework
 * (source metadata + hidden visibility + transient persistence), and project
 * a provider user turn. Every loop-hook nudge enters the conversation here
 * and only here.
 */
export function applyLoopHookEffect(
  messages: Message[],
  effect: LoopHookEffect,
  seqIndex: number,
): void {
  const projected = projectRuntimeContextToProviderMessage(
    adaptLoopNudgeContext(renderSystemReminder(effect.injection, 'loop_nudge'), effect.source, {
      seqIndex,
    }),
  );

  // Governed path (hook-context injections): dedup / replace-last by key.
  if (effect.type === 'inject' && effect.dedupKey) {
    const content = projected.content;
    if (typeof content !== 'string') {
      logger.warn('[LoopHook] inject effect projected to non-string content; skipping');
      return;
    }
    applyHookInjection(
      messages as unknown as InjectableMessage[],
      effect.dedupKey,
      content,
      effect.source,
      { id: projected.id, now: Date.now() },
    );
    return;
  }

  messages.push(projected);
}
