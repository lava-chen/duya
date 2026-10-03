/**
 * evals/agent/cases/format.ts — the case format, its version, and the rule
 * that keeps an old case's meaning.
 *
 * ## Why a case is JSON on disk
 *
 * A case is DATA: an input, a mock scenario, a permission policy, a budget, and
 * the invariants it must hold. Two properties decided the format:
 *
 *  1. A case must survive a refactor of the code that RUNS it. If the case were
 *     a typed module it would be refactored alongside the runner, and a
 *     `git blame` on a red eval could no longer tell you whether the meaning
 *     changed or the wiring did. As JSON, the case is inert: the runner can be
 *     rewritten under it, and the diff shows whether the MEANING moved.
 *  2. A case must be reviewable as a semantic diff. A reviewer asks "did this
 *     PR weaken an expectation?" — the answer has to be legible in a diff, and
 *     re-indenting a typed module is not legible.
 *
 * The cost of JSON is that nothing checks the shape at author-time. That is paid
 * back here instead: `parseCase` is the single gate every case passes through
 * before it can run, it is strict, and it names every field it rejects.
 *
 * ## How a case keeps its meaning across a run-layer change
 *
 * Three mechanisms, in increasing order of strength:
 *
 *  1. `formatVersion` + a migration table. A loader that has no migration for a
 *     case's version REFUSES to run it, and the case is reported as `skipped`
 *     with the missing version named. An old case therefore never silently runs
 *     under a changed interpretation — the failure mode is a named skip, not a
 *     false pass. This is the hard guarantee.
 *  2. `pinnedContract`. Every case names the run-layer contract its expectations
 *     were written against. When the run layer changes, the report shows the
 *     case's pin next to the current contract, so a reviewer sees "this
 *     expectation predates contract X" instead of a bare red. A pin that is
 *     behind the current contract is NOT a failure — it is a prompt to re-read
 *     the expectation and decide whether it still holds.
 *  3. A closed vocabulary of invariant kinds (below). Expectations are declared
 *     against named facts (terminal status, tool name + outcome, usage equal to
 *     what the fixture declared, a real file's bytes on disk) rather than
 *     against a recorded frame trace. A refactor that renames an internal frame
 *     does not touch a case; a refactor that changes what `completed` MEANS
 *     does, and that is a change worth a case edit. Frame-level exactness is
 *     available, but only as an explicit opt-in, for the cases whose point IS
 *     the frame sequence.
 *
 * ## The failing-layer vocabulary
 *
 * A check that fails says WHICH layer failed, because "the eval went red" does
 * not tell a reader who to go and look. The seven layers are closed and each one
 * is derived from evidence, never chosen by feel — see `./layer.ts`.
 */

/** The current case format version. Bump when a field's MEANING changes. */
export const CASE_FORMAT_VERSION = 1;

/**
 * The run-layer contract the CURRENT expectations are pinned to.
 *
 * A case records the contract it was written against. When this string changes,
 * every case pinned to an older value is surfaced in the report as `stalePin`
 * so the expectations can be re-read deliberately rather than drifted past.
 */
export const CURRENT_RUN_CONTRACT = 'run-layer/r2-manifest-cas@f63cb0e9';

export type CaseMode = 'offline' | 'live';

export type PermissionPolicyMode = 'default' | 'acceptEdits' | 'plan' | 'bypassPermissions' | 'dontAsk';

/** One content block the offline provider will emit (mirrors the harness). */
export type ScenarioBlock =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'thinking'; readonly thinking: string; readonly signature?: string }
  | {
      readonly kind: 'tool_use';
      readonly id: string;
      readonly name: string;
      readonly input: Record<string, unknown>;
    };

export interface ScenarioTurn {
  readonly blocks: readonly ScenarioBlock[];
  readonly stopReason?: 'end_turn' | 'tool_use' | 'max_tokens';
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly error?: { readonly type: string; readonly message: string };
}

export interface CaseScenario {
  /**
   * `offline-anthropic-sse` is the E4.1 loopback provider: a real HTTP server
   * speaking the real Anthropic Messages SSE protocol. There is deliberately no
   * `live` value here — a live run is not a scenario, it is a different MODE
   * (`case.mode`), and it uses a real provider rather than a script.
   */
  readonly kind: 'offline-anthropic-sse';
  readonly seed: string;
  readonly turns: readonly ScenarioTurn[];
  /**
   * Corrupt the `manifestHash` the execution channel puts on `chat:start`,
   * after the Control Plane pinned the real one on the run row. This is the
   * R2.2 refusal path made reachable from data instead of from code.
   */
  readonly tamperManifestHash?: boolean;
}

/** The four evaluator families. Also the four report sections. */
export const EVAL_FAMILIES = ['structure', 'safety', 'task-artefact', 'cost-performance'] as const;
export type EvalFamily = (typeof EVAL_FAMILIES)[number];

// ── the closed invariant vocabulary ───────────────────────────────────────────

/** Structure family: what the run layer did. */
export type StructureInvariant =
  | { readonly family: 'structure'; readonly kind: 'terminalStatus'; readonly value: 'completed' | 'cancelled' | 'failed' | 'budget_exhausted' }
  | { readonly family: 'structure'; readonly kind: 'terminalErrorCode'; readonly value: string }
  | { readonly family: 'structure'; readonly kind: 'runRowDurable'; readonly value: true }
  | { readonly family: 'structure'; readonly kind: 'runEventsRecorded'; readonly min: number }
  | { readonly family: 'structure'; readonly kind: 'manifestBound'; readonly value: true };

/**
 * There is deliberately NO `runControlEngaged` invariant — the first version of
 * this vocabulary had one, asserting that the real worker issued a `run:*`
 * control action, and a real run of the fixed set failed it.
 *
 * The finding was that the EXPECTATION was wrong, not the system. The run layer
 * is entered from the HOST side (`RunOrchestrator.openRun` in the desktop main
 * process), not through the worker's db bridge, so the worker's own db actions
 * are unchanged from before R2 — which is exactly what E4.1's baseline
 * comparison asserts when it pins `workerDbActions` to the pre-R2 list.
 *
 * "The run layer is in the executor's path" is therefore expressed by
 * `runEventsRecorded` (the run layer appended durable events) and
 * `manifestBound` (the executor was given and checked a frozen manifest). A
 * permanently-failing invariant kind is a landmine: it trains a reader to
 * ignore red, so the wrong expectation was removed rather than the finding.
 */

/** Safety family: what must NOT have happened, and what must not have leaked. */
export type SafetyInvariant =
  | { readonly family: 'safety'; readonly kind: 'providerNotReached'; readonly value: true }
  | { readonly family: 'safety'; readonly kind: 'redactionHolds'; readonly value: true }
  | { readonly family: 'safety'; readonly kind: 'workspaceContained'; readonly value: true }
  | { readonly family: 'safety'; readonly kind: 'permissionAuditResolved'; readonly value: true };

/** Cost/performance family: the budget the run was held to. */
export type CostInvariant =
  | { readonly family: 'cost-performance'; readonly kind: 'usageMatchesFixture'; readonly value: true }
  | { readonly family: 'cost-performance'; readonly kind: 'providerRequestsWithin'; readonly max: number }
  | { readonly family: 'cost-performance'; readonly kind: 'wallClockUnder'; readonly maxMs: number };

export type ExpectInvariant = StructureInvariant | SafetyInvariant | CostInvariant;

/**
 * A task artefact: something on disk or an executable result.
 *
 * There is deliberately NO `transcript` artefact kind. A model that says "I have
 * written the file" is a claim, not an artefact, and a task-completion check
 * that accepts it passes whenever the model is fluent. `file` reads the REAL
 * bytes off the temp workspace; `executableResult` asserts on the REAL result a
 * real tool returned. Both are things that exist whether or not the model
 * described them.
 */
export type ExpectArtefact =
  | {
      readonly family: 'task-artefact';
      readonly kind: 'file';
      /** Workspace-relative. Never absolute: a case may not name a host path. */
      readonly path: string;
      readonly assertion:
        | { readonly form: 'equals'; readonly value: string }
        | { readonly form: 'contains'; readonly value: string }
        | { readonly form: 'matches'; readonly pattern: string };
    }
  | {
      readonly family: 'task-artefact';
      readonly kind: 'executableResult';
      readonly tool: string;
      readonly assertion:
        | { readonly form: 'succeeded' }
        | { readonly form: 'contains'; readonly value: string };
    };

export interface EvalCase {
  readonly formatVersion: number;
  readonly id: string;
  readonly title: string;
  /** What the run-layer looked like when these expectations were written. */
  readonly pinnedContract: string;
  readonly mode: CaseMode;
  readonly input: {
    readonly prompt: string;
    readonly workspaceFiles?: Readonly<Record<string, string>>;
  };
  readonly scenario: CaseScenario;
  readonly policy: { readonly permissionMode: PermissionPolicyMode };
  readonly budget: {
    readonly maxTurns: number;
    readonly timeoutMs: number;
  };
  /**
   * Live-only parameters, fixed on purpose. A live run reports a SAMPLE and its
   * spread; it does not claim per-token determinism, so it pins everything it
   * can and reports the rest. See `./live.ts`.
   */
  readonly live?: {
    readonly model: string;
    readonly temperature: number;
    readonly maxTokens: number;
    readonly measurements: number;
  };
  readonly expect: {
    readonly invariants: readonly ExpectInvariant[];
    readonly artefacts: readonly ExpectArtefact[];
  };
  /** Cases that need a capability this environment may not have. */
  readonly requires?: readonly ('live-provider-credentials' | 'network' | 'packaged-electron')[];
}

// ── validation ───────────────────────────────────────────────────────────────

export class CaseFormatError extends Error {
  constructor(readonly problems: readonly string[]) {
    super(`invalid eval case:\n  - ${problems.join('\n  - ')}`);
    this.name = 'CaseFormatError';
  }
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const isNonEmptyString = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0;

const TERMINAL_STATUSES = ['completed', 'cancelled', 'failed', 'budget_exhausted'] as const;
// The real `PermissionPolicyMode` set, spelled out here rather than imported from
// `@duya/agent-protocol` because the case format is DATA: a case file must be
// checkable without a type-level dependency on a product package. The
// `permissionModesAreTheRealOnes` test compares this list against the protocol's
// own type so the copy cannot drift.
export const PERMISSION_MODES: readonly PermissionPolicyMode[] = [
  'default', 'acceptEdits', 'plan', 'bypassPermissions', 'dontAsk',
];
const MATCH_FORMS = ['equals', 'contains', 'matches'] as const;

function checkArtefact(value: unknown, at: string, problems: string[]): void {
  if (!isRecord(value)) {
    problems.push(`${at}: expected an object`);
    return;
  }
  if (value['family'] !== 'task-artefact') problems.push(`${at}.family: must be "task-artefact"`);
  const kind = value['kind'];
  if (kind !== 'file' && kind !== 'executableResult') {
    problems.push(`${at}.kind: must be "file" or "executableResult"`);
    return;
  }
  if (kind === 'file') {
    const p = value['path'];
    if (!isNonEmptyString(p)) problems.push(`${at}.path: must be a non-empty string`);
    else if (pathIsAbsolute(p) || p.includes('..')) {
      // A case names a workspace-relative path. An absolute or traversing path
      // would make the case's meaning depend on the machine it ran on, which is
      // exactly what the versioned format exists to prevent.
      problems.push(`${at}.path: must be workspace-relative (no absolute path, no "..")`);
    }
  } else if (!isNonEmptyString(value['tool'])) {
    problems.push(`${at}.tool: must be a non-empty string`);
  }
  const assertion = value['assertion'];
  if (!isRecord(assertion)) {
    problems.push(`${at}.assertion: expected an object`);
    return;
  }
  if (kind === 'executableResult' && assertion['form'] === 'succeeded') return;
  const form = assertion['form'];
  if (typeof form !== 'string' || !(MATCH_FORMS as readonly string[]).includes(form)) {
    problems.push(`${at}.assertion.form: must be one of ${MATCH_FORMS.join(' | ')}`);
    return;
  }
  if (form === 'matches') {
    if (!isNonEmptyString(assertion['pattern'])) {
      problems.push(`${at}.assertion.pattern: must be a non-empty string`);
    }
  } else if (typeof assertion['value'] !== 'string') {
    problems.push(`${at}.assertion.value: must be a string`);
  }
}

function pathIsAbsolute(p: string): boolean {
  return p.startsWith('/') || p.startsWith('\\') || /^[A-Za-z]:[\\/]/.test(p);
}

function checkInvariant(value: unknown, at: string, problems: string[]): void {
  if (!isRecord(value)) {
    problems.push(`${at}: expected an object`);
    return;
  }
  const family = value['family'];
  if (family !== 'structure' && family !== 'safety' && family !== 'cost-performance') {
    problems.push(`${at}.family: must be one of ${EVAL_FAMILIES.join(' | ')}`);
    return;
  }
  const kind = value['kind'];
  if (typeof kind !== 'string' || kind.length === 0) {
    problems.push(`${at}.kind: must be a non-empty string`);
    return;
  }
  if (family === 'structure' && kind === 'terminalStatus') {
    const v = value['value'];
    if (typeof v !== 'string' || !(TERMINAL_STATUSES as readonly string[]).includes(v)) {
      problems.push(`${at}.value: must be one of ${TERMINAL_STATUSES.join(' | ')}`);
    }
  }
  if ((family === 'structure' || family === 'safety' || family === 'cost-performance')
    && (kind === 'runRowDurable' || kind === 'manifestBound'
      || kind === 'providerNotReached' || kind === 'redactionHolds' || kind === 'workspaceContained'
      || kind === 'permissionAuditResolved' || kind === 'usageMatchesFixture')) {
    if (value['value'] !== true) problems.push(`${at}.value: must be true (the negative is expressed by omitting the invariant)`);
  }
  if (kind === 'terminalErrorCode' && !isNonEmptyString(value['value'])) {
    problems.push(`${at}.value: must be a non-empty string`);
  }
  if (kind === 'runEventsRecorded') {
    if (typeof value['min'] !== 'number' || !Number.isInteger(value['min']) || value['min'] < 0) {
      problems.push(`${at}.min: must be a non-negative integer`);
    }
  }
  if ((kind === 'providerRequestsWithin' || kind === 'wallClockUnder')) {
    const bound = kind === 'wallClockUnder' ? value['maxMs'] : value['max'];
    if (typeof bound !== 'number' || !Number.isFinite(bound) || bound <= 0) {
      problems.push(`${at}.${kind === 'wallClockUnder' ? 'maxMs' : 'max'}: must be a positive number`);
    }
  }
}

function checkScenario(value: unknown, at: string, problems: string[]): void {
  if (!isRecord(value)) {
    problems.push(`${at}: expected an object`);
    return;
  }
  if (value['kind'] !== 'offline-anthropic-sse') {
    problems.push(`${at}.kind: must be "offline-anthropic-sse"`);
  }
  if (!isNonEmptyString(value['seed'])) problems.push(`${at}.seed: must be a non-empty string`);
  const turns = value['turns'];
  if (!Array.isArray(turns) || turns.length === 0) {
    problems.push(`${at}.turns: must be a non-empty array`);
    return;
  }
  turns.forEach((turn, i) => {
    const at2 = `${at}.turns[${i}]`;
    if (!isRecord(turn)) {
      problems.push(`${at2}: expected an object`);
      return;
    }
    const blocks = turn['blocks'];
    if (!Array.isArray(blocks) || blocks.length === 0) {
      problems.push(`${at2}.blocks: must be a non-empty array`);
      return;
    }
    blocks.forEach((block, j) => {
      const at3 = `${at2}.blocks[${j}]`;
      if (!isRecord(block)) {
        problems.push(`${at3}: expected an object`);
        return;
      }
      const kind = block['kind'];
      if (kind === 'text' || kind === 'thinking') {
        if (typeof block[kind] !== 'string') problems.push(`${at3}.${kind}: must be a string`);
        return;
      }
      if (kind === 'tool_use') {
        if (!isNonEmptyString(block['id'])) problems.push(`${at3}.id: must be a non-empty string`);
        if (!isNonEmptyString(block['name'])) problems.push(`${at3}.name: must be a non-empty string`);
        if (!isRecord(block['input'])) problems.push(`${at3}.input: must be an object`);
        return;
      }
      problems.push(`${at3}.kind: must be text | thinking | tool_use`);
    });
  });
}

/**
 * Parse and validate a case. Throws `CaseFormatError` naming every problem.
 *
 * Validation is strict on purpose: a case that loads is a case whose every
 * field was understood, so an evaluator can rely on the shape instead of
 * re-checking it. A case that does not load is `skipped` in the report, never
 * run under a guessed interpretation.
 */
export function parseCase(raw: unknown): EvalCase {
  const problems: string[] = [];
  if (!isRecord(raw)) throw new CaseFormatError(['case: expected a JSON object']);

  if (raw['formatVersion'] !== CASE_FORMAT_VERSION) {
    problems.push(`formatVersion: expected ${CASE_FORMAT_VERSION}, got ${JSON.stringify(raw['formatVersion'])}`);
  }
  if (!isNonEmptyString(raw['id'])) problems.push('id: must be a non-empty string');
  else if (!/^[a-z0-9][a-z0-9-]*$/.test(raw['id'])) {
    problems.push('id: must be lowercase kebab-case (it names a file and a report row)');
  }
  if (!isNonEmptyString(raw['title'])) problems.push('title: must be a non-empty string');
  if (!isNonEmptyString(raw['pinnedContract'])) problems.push('pinnedContract: must be a non-empty string');
  if (raw['mode'] !== 'offline' && raw['mode'] !== 'live') problems.push('mode: must be "offline" or "live"');

  const input = raw['input'];
  if (!isRecord(input)) problems.push('input: expected an object');
  else {
    if (!isNonEmptyString(input['prompt'])) problems.push('input.prompt: must be a non-empty string');
    if (input['workspaceFiles'] !== undefined) {
      if (!isRecord(input['workspaceFiles'])) problems.push('input.workspaceFiles: must be an object');
      else {
        for (const [name, content] of Object.entries(input['workspaceFiles'])) {
          if (pathIsAbsolute(name) || name.includes('..')) {
            problems.push(`input.workspaceFiles.${name}: must be workspace-relative`);
          }
          if (typeof content !== 'string') problems.push(`input.workspaceFiles.${name}: must be a string`);
        }
      }
    }
  }

  checkScenario(raw['scenario'], 'scenario', problems);

  const policy = raw['policy'];
  if (!isRecord(policy)) problems.push('policy: expected an object');
  else if (!(PERMISSION_MODES as readonly string[]).includes(String(policy['permissionMode']))) {
    problems.push(`policy.permissionMode: must be one of ${PERMISSION_MODES.join(' | ')}`);
  }

  const budget = raw['budget'];
  if (!isRecord(budget)) problems.push('budget: expected an object');
  else {
    if (typeof budget['maxTurns'] !== 'number' || !Number.isInteger(budget['maxTurns']) || budget['maxTurns'] < 1) {
      problems.push('budget.maxTurns: must be a positive integer');
    }
    if (typeof budget['timeoutMs'] !== 'number' || !Number.isFinite(budget['timeoutMs']) || budget['timeoutMs'] <= 0) {
      problems.push('budget.timeoutMs: must be a positive number');
    }
  }

  if (raw['live'] !== undefined) {
    if (!isRecord(raw['live'])) problems.push('live: expected an object');
    else {
      if (!isNonEmptyString(raw['live']['model'])) problems.push('live.model: must be a non-empty string');
      if (typeof raw['live']['temperature'] !== 'number') problems.push('live.temperature: must be a number');
      if (typeof raw['live']['maxTokens'] !== 'number') problems.push('live.maxTokens: must be a number');
      if (typeof raw['live']['measurements'] !== 'number' || !Number.isInteger(raw['live']['measurements'])) {
        problems.push('live.measurements: must be an integer');
      } else if ((raw['live']['measurements'] as number) < 2) {
        // One measurement has no spread, and a "variance" of zero from a single
        // sample is a claim, not a measurement. A live case must sample at
        // least twice or it is not a stochastic evaluation.
        problems.push('live.measurements: must be >= 2 (a single sample has no spread)');
      }
    }
  }
  if (raw['mode'] === 'live' && raw['live'] === undefined) {
    problems.push('live: a live case must pin its live parameters (model, temperature, maxTokens, measurements)');
  }

  const expect = raw['expect'];
  if (!isRecord(expect)) problems.push('expect: expected an object');
  else {
    const invariants = expect['invariants'];
    if (!Array.isArray(invariants) || invariants.length === 0) {
      problems.push('expect.invariants: must be a non-empty array (a case with no expectations cannot fail)');
    } else {
      invariants.forEach((inv, i) => checkInvariant(inv, `expect.invariants[${i}]`, problems));
    }
    const artefacts = expect['artefacts'];
    if (!Array.isArray(artefacts)) problems.push('expect.artefacts: must be an array (it may be empty)');
    else artefacts.forEach((art, i) => checkArtefact(art, `expect.artefacts[${i}]`, problems));
  }

  if (raw['requires'] !== undefined) {
    if (!Array.isArray(raw['requires'])) problems.push('requires: must be an array');
    else {
      for (const r of raw['requires']) {
        if (r !== 'live-provider-credentials' && r !== 'network' && r !== 'packaged-electron') {
          problems.push(`requires: unknown capability ${JSON.stringify(r)}`);
        }
      }
    }
  }

  if (problems.length > 0) throw new CaseFormatError(problems);
  return raw as unknown as EvalCase;
}

/**
 * Migrations from an older format version to the current one.
 *
 * The absence of a migration is the point: `migrate` returns `null` and the
 * caller reports the case as `skipped` naming the version it cannot read. That
 * is the difference between "an old case keeps its meaning" and "an old case
 * quietly means whatever today's loader thinks".
 */
const MIGRATIONS: Readonly<Record<number, (raw: unknown) => unknown>> = {
  // 0: (raw) => ({ ...(raw as object), formatVersion: 1 }),
};

export interface MigrationOutcome {
  readonly migrated: EvalCase | null;
  /** Set when no migration exists. The case is `skipped`, never run. */
  readonly unsupportedFrom?: number;
}

export function migrate(raw: unknown): MigrationOutcome {
  if (!isRecord(raw)) throw new CaseFormatError(['case: expected a JSON object']);
  const version = raw['formatVersion'];
  if (version === CASE_FORMAT_VERSION) return { migrated: raw as unknown as EvalCase };

  let current: unknown = raw;
  for (let v = typeof version === 'number' ? version : CASE_FORMAT_VERSION; v < CASE_FORMAT_VERSION; v++) {
    const step = MIGRATIONS[v];
    if (!step) return { migrated: null, unsupportedFrom: v };
    current = step(current);
  }
  return { migrated: parseCase(current) };
}
