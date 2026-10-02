/**
 * Budget accounting from a run's event stream.
 *
 * ## Why budgets are measured, not declared
 *
 * A budget in `RunManifest` is an intention. What a run actually spent is a
 * fact derivable only from the events it produced — and the two disagree in
 * both directions: a run can spend tokens on a turn that never reported usage
 * before it was cancelled, and it can finish under budget after a retry burned
 * a call the final turn did not report.
 *
 * So the ceiling is never enforced here. This module **measures**, and
 * `isBudgetExhausted` reports the verdict; enforcement belongs to whoever
 * observes the stream in time to act, which is the runtime, not this function.
 *
 * ## Counting rules, and why each one is the conservative choice
 *
 *  - **Turns** count `turn.started`, not `turn.completed`. A turn that started
 *    and died mid-flight consumed the budget; waiting for its completion event
 *    to count it means a crashed turn costs nothing.
 *  - **Tool calls** count `tool.call_started`, not `tool.call_completed`, for
 *    the same reason. The side-effect ledger's `exactly once before dispatch`
 *    rule (`payloads.ts:443`) is what makes the start event the honest count:
 *    a call that crashed mid-execution still happened.
 *  - **Tokens** accumulate `assistant.usage`, summing `totalTokens` per event.
 *    Events with no usage contribute zero rather than being estimated — an
 *    invented token count is a number nobody can trace back to a provider.
 */

import type { RunBudget, RunEvent, TokenUsage } from '@duya/agent-protocol';

export interface RunSpend {
  readonly turns: number;
  readonly toolCalls: number;
  readonly tokens: number;
}

export const ZERO_SPEND: RunSpend = Object.freeze({ turns: 0, toolCalls: 0, tokens: 0 });

/**
 * The subset of a run's events this module reads.
 *
 * Modelled as a structural union rather than `RunEvent` so a caller can hand
 * over a partial stream — a replayed prefix, or a test's hand-built list — and
 * still get a number. A function that only accepted the full union would be
 * unusable on exactly the inputs a budget check most often runs on.
 */
export type SpendEvent =
  | { readonly type: 'turn.started' }
  | { readonly type: 'tool.call_started' }
  | { readonly type: 'assistant.usage'; readonly usage?: TokenUsage }
  | { readonly type: string };

/**
 * Total the spend recorded by a run's events.
 *
 * @param events - Run events in `seq` order. Order does not matter here; this
 *   is a fold over the set, and a replayed prefix yields a smaller number
 *   rather than a different one.
 */
export function totalSpend(events: readonly SpendEvent[]): RunSpend {
  let turns = 0;
  let toolCalls = 0;
  let tokens = 0;

  for (const event of events) {
    switch (event.type) {
      case 'turn.started':
        turns += 1;
        break;
      case 'tool.call_started':
        toolCalls += 1;
        break;
      case 'assistant.usage':
        tokens += usageTotal((event as { readonly usage?: TokenUsage }).usage);
        break;
      default:
        break;
    }
  }

  return { turns, toolCalls, tokens };
}

/**
 * The total a usage event reports.
 *
 * Prefers `totalTokens` because that is the provider's own aggregate. Falls
 * back to input+output only when `totalTokens` is absent, and treats a missing
 * usage object as zero. It does not add cache tokens: providers already
 * include them in their total when they report one, so adding them here would
 * double-count the cache on exactly the providers that bill for it.
 */
function usageTotal(usage: TokenUsage | undefined): number {
  if (usage === undefined) return 0;
  if (typeof usage.totalTokens === 'number' && Number.isFinite(usage.totalTokens)) {
    return usage.totalTokens;
  }
  const input = typeof usage.inputTokens === 'number' ? usage.inputTokens : 0;
  const output = typeof usage.outputTokens === 'number' ? usage.outputTokens : 0;
  return input + output;
}

/** Which ceiling, if any, a run has reached. `null` means "still within budget". */
export type BudgetBreach = 'maxTurns' | 'maxToolCalls' | 'maxTokens' | 'maxWallClockMs';

export interface BudgetVerdict {
  readonly exhausted: boolean;
  /** Every ceiling crossed, not just the first. A run can cross two at once. */
  readonly breaches: readonly BudgetBreach[];
}

/**
 * Compare a run's spend against its budget.
 *
 * A ceiling of `0` is treated as absent rather than as "stop immediately": a
 * budget assembled field-by-field from optional configuration produces `0` for
 * every unset number, and honouring that would refuse to run anything.
 */
export function isBudgetExhausted(
  budget: RunBudget,
  spend: RunSpend,
  wallClockMs?: number,
): BudgetVerdict {
  const breaches: BudgetBreach[] = [];

  if (isPositive(budget.maxTurns) && spend.turns >= budget.maxTurns) breaches.push('maxTurns');
  if (isPositive(budget.maxToolCalls) && spend.toolCalls >= budget.maxToolCalls) {
    breaches.push('maxToolCalls');
  }
  if (isPositive(budget.maxTokens) && spend.tokens >= budget.maxTokens) breaches.push('maxTokens');
  if (
    isPositive(budget.maxWallClockMs) &&
    typeof wallClockMs === 'number' &&
    wallClockMs >= budget.maxWallClockMs
  ) {
    breaches.push('maxWallClockMs');
  }

  return { exhausted: breaches.length > 0, breaches };
}

/** Remaining headroom, or `null` for a ceiling that was never set. */
export function remainingBudget(
  budget: RunBudget,
  spend: RunSpend,
): Readonly<Record<BudgetBreach, number | null>> {
  return {
    maxTurns: remaining(isPositive(budget.maxTurns) ? budget.maxTurns : null, spend.turns),
    maxToolCalls: remaining(
      isPositive(budget.maxToolCalls) ? budget.maxToolCalls : null,
      spend.toolCalls,
    ),
    maxTokens: remaining(isPositive(budget.maxTokens) ? budget.maxTokens : null, spend.tokens),
    maxWallClockMs: null,
  };
}

function remaining(ceiling: number | null, used: number): number | null {
  return ceiling === null ? null : Math.max(0, ceiling - used);
}

function isPositive(value: number | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}
