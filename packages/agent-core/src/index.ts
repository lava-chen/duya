/**
 * `@duya/agent-core` — pure reasoning about a run.
 *
 * ## What belongs here
 *
 * Logic that is a **function of a run's events and configuration** and nothing
 * else: no filesystem, no network, no database, no clock of its own. Every
 * function in this package can be exercised with a literal array and gets the
 * same answer every time.
 *
 * ## What deliberately does not belong here yet
 *
 * `docs/architecture/03-target-structure.md` §5.1 records the measured reason:
 * `packages/agent` has 18 circular SCCs, the largest spanning 42 files, and
 * that SCC straddles the intended `agent-core` / `agent-runtime` cut. Until C1
 * (`06-migration-plan.md`) unwinds it, `modes/`, `prompts/`, `compact/` and
 * `context/` cannot move without producing a tree that does not compile.
 *
 * Claiming that cut exists when it does not would be a boundary that enforces
 * nothing. So this package holds the run semantics that are genuinely
 * separable today, and the rest arrives when the cycle is gone.
 */

export {
  isTerminalEventType,
  resolveRunOutcome,
  isTerminal,
  type RunTerminationIntent,
  type ResolveRunOutcomeOptions,
} from './run-outcome.js';

export {
  totalSpend,
  isBudgetExhausted,
  remainingBudget,
  ZERO_SPEND,
  type RunSpend,
  type SpendEvent,
  type BudgetBreach,
  type BudgetVerdict,
} from './run-budget.js';

export {
  dispositionOf,
  isRetainable,
  countEvent,
  durableOnly,
  dispositionTable,
  emptyCounters,
  type Disposition,
  type RunEventCounters,
} from './durability-policy.js';

export {
  negotiate,
  capabilitiesRequiredBy,
  unsendableEvents,
  type HostCapabilities,
  type NegotiationVerdict,
  type RequiredCapability,
  type UnmetRequirement,
} from './capability-negotiation.js';
