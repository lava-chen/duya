/**
 * The resource ceilings a run is held to, and the ledger that counts them.
 *
 * ## Why the marking came first
 *
 * The protocol's `budget` field carries `max_turns` and nothing else, and the
 * host's own `BudgetLedger` only counts workflow agent invocations. So the
 * product had ceilings it did not measure (tokens, file writes, external
 * effects), ceilings it measured somewhere else entirely (the worker pool's
 * concurrency cap, the worker's V8 heap cap), and no way to tell a reader
 * which was which.
 *
 * A limit that is not counted is not a limit. It is a number in a config
 * file. So this module does two things, in this order:
 *
 *  1. **Say which ceilings are real.** Every ceiling carries `measured` or
 *     `unmeasured`, and `unmeasured` carries the reason. A ceiling that is
 *     neither is not representable.
 *  2. **Count the ones that can be counted.** {@link TaskResourceBudget} is a
 *     per-task ledger: it counts, and it refuses. A limit with a counter
 *     behind it is a limit.
 *
 * ## Why the "measured" set is derived, not declared
 *
 * A ceiling is `measured` only when there is a live policy behind it — a
 * number the product actually applies. The set of measured ceilings is
 * therefore DERIVED from the policy that was handed in, and
 * {@link resolveBudgetCeilings} is the only place that decides. A flag that
 * somebody can flip by hand is a flag that will be flipped by hand.
 */

/** The ceilings a run can be held to. */
export const BUDGET_CEILINGS = [
  'turns',
  'toolCalls',
  'shellCommands',
  'tokens',
  'concurrency',
  'fileWrites',
  'externalEffects',
  'cpuMemory',
] as const;

export type BudgetCeiling = (typeof BUDGET_CEILINGS)[number];

/**
 * The limits a run is held to.
 *
 * Every field is optional and an absent field means "no ceiling", never "an
 * unlimited ceiling that happens to be spelled differently". The manifest
 * records an absent limit as `unmeasured`, so the two are told apart.
 */
export interface ResourceBudgetLimits {
  /** The agent's turn ceiling. */
  readonly maxTurns?: number;
  /** Tool invocations per task. */
  readonly maxToolCalls?: number;
  /** Shell commands per task. */
  readonly maxShellCommands?: number;
  /** File-writing tool calls per task. */
  readonly maxFileWrites?: number;
  /** External side effects per task. */
  readonly maxExternalEffects?: number;
  /** The worker's heap cap, in MB. */
  readonly maxWorkerMemoryMb?: number;
  /** The host's concurrent worker cap. */
  readonly maxConcurrentWorkers?: number;
}

/** The live host policy the run is measured against. */
export interface ResourceBudgetPolicy {
  readonly limits: ResourceBudgetLimits;
  /** What enforces each measured ceiling, in words. */
  readonly enforcement: Partial<Record<BudgetCeiling, string>>;
}

/** Raised when a task exhausts one of its ceilings. */
export class ResourceBudgetExceededError extends Error {
  readonly ceiling: BudgetCeiling;
  readonly limit: number;
  readonly observed: number;

  constructor(ceiling: BudgetCeiling, limit: number, observed: number) {
    super(
      `resource budget exceeded: ${ceiling} is capped at ${limit}, and ${observed} were used`,
    );
    this.name = 'ResourceBudgetExceededError';
    this.ceiling = ceiling;
    this.limit = limit;
    this.observed = observed;
  }
}

function positive(value: number | undefined): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
}

/**
 * Derive the per-ceiling status from the policy that is actually in force.
 *
 * The mapping is deliberately mechanical: a ceiling is `measured` if and only
 * if the policy carries a limit for it. There is no place to add a "measured"
 * without a number behind it.
 */
export function resolveBudgetCeilings(policy: ResourceBudgetPolicy): BudgetCeilings {
  const { limits, enforcement } = policy;
  const measured = (
    ceiling: BudgetCeiling,
    limit: number | undefined,
    fallbackReason: string,
  ): BudgetCeilingRecord => {
    const value = positive(limit);
    if (value === undefined) {
      return { status: 'unmeasured', reason: fallbackReason };
    }
    const reason = enforcement[ceiling];
    return reason === undefined
      ? { status: 'measured', limit: value }
      : { status: 'measured', limit: value, reason };
  };

  return {
    turns: measured(
      'turns',
      limits.maxTurns,
      'the agent configuration supplies no turn ceiling for this run',
    ),
    toolCalls: measured(
      'toolCalls',
      limits.maxToolCalls,
      'no per-run tool-call ceiling is configured for this run',
    ),
    shellCommands: measured(
      'shellCommands',
      limits.maxShellCommands,
      'no per-run shell-command ceiling is configured for this run',
    ),
    tokens: measured(
      'tokens',
      undefined,
      'token usage is metered per request, but no per-run token ceiling is enforced',
    ),
    concurrency: measured(
      'concurrency',
      limits.maxConcurrentWorkers,
      'no worker concurrency cap is in force for this host',
    ),
    fileWrites: measured(
      'fileWrites',
      limits.maxFileWrites,
      'no per-run counter for file-writing tool calls is configured',
    ),
    externalEffects: measured(
      'externalEffects',
      limits.maxExternalEffects,
      'external side effects are reconciled after the fact, but not counted against a per-run ceiling',
    ),
    cpuMemory: measured(
      'cpuMemory',
      limits.maxWorkerMemoryMb,
      'no worker heap cap is applied for this host',
    ),
  };
}

/** What a task has used so far. */
export interface TaskResourceUsage {
  readonly toolCalls: number;
  readonly shellCommands: number;
  readonly fileWrites: number;
  readonly externalEffects: number;
}

/**
 * A per-task counter that refuses past the limit.
 *
 * The ledger is the enforcement: a ceiling with a ledger behind it is
 * enforced at the point of use, not merely reported afterwards. Each `count`
 * method increments and then checks, so the refusal happens on the call that
 * crosses the line rather than on the next one.
 */
export class TaskResourceBudget {
  readonly limits: ResourceBudgetLimits;
  #toolCalls = 0;
  #shellCommands = 0;
  #fileWrites = 0;
  #externalEffects = 0;

  constructor(limits: ResourceBudgetLimits = {}) {
    this.limits = limits;
  }

  get usage(): TaskResourceUsage {
    return {
      toolCalls: this.#toolCalls,
      shellCommands: this.#shellCommands,
      fileWrites: this.#fileWrites,
      externalEffects: this.#externalEffects,
    };
  }

  /** Count one tool invocation, and refuse past the tool-call ceiling. */
  countToolCall(): void {
    this.#toolCalls += 1;
    this.#assertWithin('toolCalls', this.limits.maxToolCalls, this.#toolCalls);
  }

  /** Count one shell command, and refuse past the shell-command ceiling. */
  countShellCommand(): void {
    this.#shellCommands += 1;
    this.#assertWithin('shellCommands', this.limits.maxShellCommands, this.#shellCommands);
  }

  /** Count one file write, and refuse past the file-write ceiling. */
  countFileWrite(): void {
    this.#fileWrites += 1;
    this.#assertWithin('fileWrites', this.limits.maxFileWrites, this.#fileWrites);
  }

  /** Count one external side effect, and refuse past the effect ceiling. */
  countExternalEffect(): void {
    this.#externalEffects += 1;
    this.#assertWithin('externalEffects', this.limits.maxExternalEffects, this.#externalEffects);
  }

  #assertWithin(ceiling: BudgetCeiling, limit: number | undefined, observed: number): void {
    const value = positive(limit);
    if (value === undefined) return;
    if (observed > value) {
      throw new ResourceBudgetExceededError(ceiling, value, observed);
    }
  }
}
