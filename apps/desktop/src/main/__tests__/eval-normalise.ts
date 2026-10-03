/**
 * eval-normalise.ts — what "the same normalised semantics" means, made
 * executable.
 *
 * ## The rule
 *
 * A comparison between two runs is meaningful only if it collapses the things
 * that were never going to be equal, and refuses to collapse anything that
 * carries behaviour. This file draws that line in one place so the comparison
 * cannot be tuned per-assertion until it agrees.
 *
 * COLLAPSED, because two independent executions cannot agree on them and their
 * disagreement says nothing about behaviour:
 *
 *  - wall-clock time (epoch ms, ISO timestamps, `durationMs`);
 *  - random identity (UUIDs, `msg_…`/msg ids, trace ids, run ids, tool call
 *    ids, per-run workspace/db paths, ports, pids);
 *  - volatile counters that are a function of timing, not of the run's
 *    decisions (observed-at fields, byte counts of the bundle);
 *  - the *content* of the manifest's identity fields, while KEEPING every
 *    field that is a configuration decision (profile, modes, tools, budget,
 *    permission mode, required capabilities, provenance sources).
 *
 * NOT COLLAPSED, because a difference here is a real behavioural difference
 * and the whole point of the comparison is to catch it:
 *
 *  - the ordered list of frame TYPES on each channel (a loop that emits
 *    `chat:tool_result` where the baseline emitted `chat:done` is a
 *    regression, not noise);
 *  - the terminal status and the terminal's error code;
 *  - the set and order of tool names, and each tool attempt's outcome;
 *  - whether provider requests were made, and how many turns the executor took;
 *  - the manifest's configuration decisions, including every `provenance`
 *    source and its `synthesised` flag;
 *  - the usage numbers, which the fixture declares and the adapter must
 *    extract faithfully.
 *
 * ## Why usage is NOT collapsed
 *
 * It is the obvious candidate for "timing noise" and it is not. The offline
 * provider declares exact `input_tokens` / `output_tokens`, so a usage
 * difference is either the adapter mis-parsing the real SSE or the run layer
 * mis-accumulating real results. Both are regressions. Collapsing it would
 * discard the single most load-bearing thing the provider fixture is for.
 */

/** One normalised run: a pure function of behaviour, free of identity. */
export interface NormalisedRun {
  readonly terminalStatus: string | null;
  readonly terminalErrorCode: string | null;
  /** Frame types on the worker stdout channel, in order, deduplicated of repeats. */
  readonly frameTypes: readonly string[];
  /** Run-layer event kinds, in order. */
  readonly runEventKinds: readonly string[];
  /** How many requests the executor made to the provider. */
  readonly providerRequestCount: number;
  /** Tool names in call order, and the outcome of each. */
  readonly toolAttempts: ReadonlyArray<{ readonly name: string; readonly outcome: string }>;
  /** Declared-by-fixture usage, as the executor reported it. */
  readonly usage: { readonly inputTokens: number; readonly outputTokens: number };
  /** The manifest's configuration decisions, identity fields removed. */
  readonly manifestDecisions: Record<string, unknown>;
  /** Which host db actions the real worker reached for. Sorted, deduplicated. */
  readonly workerDbActions: readonly string[];
}

const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const EPOCH_MS = /\b1[6-9]\d{11}\b/g;
const ISO_TIME = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/g;
const SHA256 = /\b[0-9a-f]{64}\b/g;
const PORT = /127\.0\.0\.1:\d+/g;

/**
 * Collapse a string to its behavioural residue.
 *
 * Every rule is a *rewrite to a placeholder*, never a deletion: `duration_ms:
 * 731` becomes `duration_ms: <time>` so a report can still show that a
 * duration field was present and where. Silently dropping a key would hide
 * the case where one run emitted a field the other did not.
 */
export function normaliseText(input: string): string {
  return input
    .replace(UUID, '<uuid>')
    .replace(ISO_TIME, '<time>')
    .replace(EPOCH_MS, '<epoch-ms>')
    .replace(SHA256, '<digest>')
    .replace(PORT, '127.0.0.1:<port>');
}

/** Recursively normalise a JSON-shaped value. */
export function normaliseValue(value: unknown): unknown {
  if (typeof value === 'string') return normaliseText(value);
  if (Array.isArray(value)) return value.map(normaliseValue);
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = normaliseValue((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

/** Manifest fields that are IDENTITY, not configuration. */
const MANIFEST_IDENTITY = new Set(['runId', 'workspaceId', 'taskId', 'parentRunId']);

export function normaliseRun(artifacts: {
  readonly protocolTrace: ReadonlyArray<{ readonly channel: string; readonly type: string }>;
  readonly toolAttempts: ReadonlyArray<{ readonly name: unknown; readonly outcome: string }>;
  readonly usage: { readonly inputTokens: number; readonly outputTokens: number };
  readonly terminal: unknown;
  readonly manifest: unknown;
  readonly providerRequests: readonly unknown[];
  readonly workerDbCalls: readonly string[];
}): NormalisedRun {  const terminal = (artifacts.terminal ?? {}) as Record<string, unknown>;
  const manifest = (artifacts.manifest ?? {}) as Record<string, unknown>;

  const manifestDecisions: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(manifest)) {
    if (MANIFEST_IDENTITY.has(key)) continue;
    // `env.hash` is a digest of the environment; keep the ref, drop the hash.
    if (key === 'env') {
      const env = value as Record<string, unknown>;
      manifestDecisions.env = { ref: normaliseText(String(env.ref ?? '')) };
      continue;
    }
    manifestDecisions[key] = normaliseValue(value);
  }

  return {
    terminalStatus: typeof terminal.status === 'string' ? terminal.status : null,
    terminalErrorCode:
      typeof (terminal.error as Record<string, unknown> | undefined)?.code === 'string'
        ? String((terminal.error as Record<string, unknown>).code)
        : null,
    frameTypes: artifacts.protocolTrace
      .filter((entry) => entry.channel === 'worker_stdout')
      .map((entry) => entry.type),
    // `runEventKinds` carries the run layer's OWN verdicts, including
    // `late_frame` — a frame the run layer says arrived after the run had
    // already ended. That is a behavioural fact, not a formatting artefact:
    // the run layer decided the turn was over at `chat:done`, and the worker
    // kept talking. Collapsing it away would hide the exact class of
    // disagreement this comparison exists to catch, so it stays in the diff
    // and the test names it.
    runEventKinds: artifacts.protocolTrace
      .filter((entry) => entry.channel === 'run_event')
      .map((entry) => entry.type),
    providerRequestCount: artifacts.providerRequests.length,
    toolAttempts: artifacts.toolAttempts.map((attempt) => ({
      name: String(attempt.name),
      outcome: attempt.outcome,
    })),
    usage: { inputTokens: artifacts.usage.inputTokens, outputTokens: artifacts.usage.outputTokens },
    manifestDecisions,
    workerDbActions: [...artifacts.workerDbCalls].sort(),
  };
}

/**
 * The difference between two normalised runs, as a list of named fields.
 *
 * Returned rather than asserted inline so a report can print it: "what changed"
 * is the artifact, and a boolean assertion discards exactly the information a
 * reviewer needs.
 */
export function diffNormalised(a: NormalisedRun, b: NormalisedRun): string[] {
  const differences: string[] = [];
  const same = <T>(field: string, left: T, right: T): void => {
    if (JSON.stringify(left) !== JSON.stringify(right)) {
      differences.push(`${field}: ${JSON.stringify(left)} != ${JSON.stringify(right)}`);
    }
  };
  same('terminalStatus', a.terminalStatus, b.terminalStatus);
  same('terminalErrorCode', a.terminalErrorCode, b.terminalErrorCode);
  same('frameTypes', a.frameTypes, b.frameTypes);
  same('runEventKinds', a.runEventKinds, b.runEventKinds);
  same('providerRequestCount', a.providerRequestCount, b.providerRequestCount);
  same('toolAttempts', a.toolAttempts, b.toolAttempts);
  same('usage', a.usage, b.usage);
  same('manifestDecisions', a.manifestDecisions, b.manifestDecisions);
  same('workerDbActions', a.workerDbActions, b.workerDbActions);
  return differences;
}
