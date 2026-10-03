/**
 * evals/agent/evaluators/live.ts — the stochastic path, and what it cannot say.
 *
 * ## The split the plan requires
 *
 * The offline path is deterministic: a real loopback provider serves declared
 * bytes, the real adapter parses them, and the report asserts exact traces and
 * artefacts. The live path is NOT that, and the difference is not a matter of
 * degree. A live provider is sampled, not controlled, so the only honest output
 * is a SAMPLE with its spread.
 *
 * What the live path therefore does:
 *  - fixes everything it can (model id, temperature, max tokens, and the
 *    measurement count), so the spread it reports is the model's, not the
 *    configuration's;
 *  - takes N measurements (N >= 2; a single sample has no spread, and a
 *    "variance" of zero computed from one observation is a claim, not a
 *    measurement);
 *  - reports the sample values, the min, the max, the mean, and the spread, and
 *    labels the whole section `determinism: 'not-claimed'`.
 *
 * What it explicitly does NOT do, and a test enforces:
 *  - claim per-token determinism. `assertNotPerTokenDeterministic` is a real
 *    guard called on the live report path, so the forbidden claim is a
 *    compile-and-test-time failure rather than a review-time judgement;
 *  - report a pass/fail on a per-token expectation. Only run-level invariants
 *    (terminal status, tool outcome, budget) are evaluated live; usage is
 *    reported as an observation, never asserted for equality, because a
 *    provider's token accounting is not ours to predict.
 *
 * ## What cannot be run here
 *
 * A live run needs a provider API key. This environment has none, so the live
 * path is implemented, unit-tested against a SYNTHETIC series (explicitly
 * labelled as such in the report), and its execution path refuses to run rather
 * than inventing a result. `liveReadiness` names the missing capability, and the
 * runner turns that into a `skipped` check with the capability named — which is
 * the plan's rule that an unproven capability is reported as unsupported rather
 * than claimed.
 */

export interface LiveParameters {
  readonly model: string;
  readonly temperature: number;
  readonly maxTokens: number;
  readonly measurements: number;
}

/** The statistics a live sample is summarised with. */
export interface SampleStatistics {
  readonly n: number;
  readonly values: readonly number[];
  readonly min: number;
  readonly max: number;
  readonly mean: number;
  /** Sample variance (n-1 denominator). Zero is a measurement, not a promise. */
  readonly variance: number;
  /** max - min: the observed spread, which is what a reader wants. */
  readonly spread: number;
}

export interface LiveObservation {
  readonly determinism: 'not-claimed';
  readonly parameters: LiveParameters;
  /** Per-metric samples, each with its own statistics. */
  readonly metrics: Readonly<Record<string, SampleStatistics>>;
  /**
   * Where the numbers came from. `not-measured` is a real value and not a
   * placeholder: a live case that could not run has taken NO measurement, and
   * labelling it `live-provider` would claim a provider produced numbers that
   * do not exist.
   */
  readonly source: 'live-provider' | 'synthetic-fixture' | 'not-measured';
  /** How the measurements were produced, for the reader who wants to reproduce. */
  readonly method: string;
}

export function summarise(values: readonly number[]): SampleStatistics {
  if (values.length === 0) throw new Error('summarise() needs at least one value');
  if (values.length < 2) {
    throw new Error(
      `summarise() needs at least two measurements: one sample has no spread, so a variance from it is a claim, not a measurement`,
    );
  }
  const min = Math.min(...values);
  const max = Math.max(...values);
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const variance = values.reduce((acc, v) => acc + (v - mean) ** 2, 0) / (values.length - 1);
  return { n: values.length, values: [...values], min, max, mean, variance, spread: max - min };
}

export interface LiveReadiness {
  readonly ready: boolean;
  /** The missing capability, named. Never a bare `false`. */
  readonly blockedBy?: string;
  /** Capabilities a live run would need that this environment has not proven. */
  readonly unsupported: readonly string[];
}

/**
 * Decide whether a live run may proceed.
 *
 * The check is for the credential only. It deliberately does NOT fall back to
 * the offline provider: a live eval that silently runs offline is a live eval
 * that reports a model result it did not get.
 */
export function liveReadiness(env: NodeJS.ProcessEnv): LiveReadiness {
  const unsupported: string[] = [
    'per-token determinism against a live provider (not claimed, and not claimed to be absent)',
    'task-artefact completion against a live model, until a live run is observed',
  ];
  const key = env['DUYA_EVAL_LIVE_KEY'] ?? env['ANTHROPIC_API_KEY'] ?? '';
  if (key.trim().length === 0) {
    return {
      ready: false,
      blockedBy: 'live-provider-credentials: neither DUYA_EVAL_LIVE_KEY nor ANTHROPIC_API_KEY is set',
      unsupported,
    };
  }
  if (env['DUYA_EVAL_ALLOW_NETWORK'] !== '1') {
    return {
      ready: false,
      blockedBy: 'network: a credential is present but DUYA_EVAL_ALLOW_NETWORK is not "1", so this environment is not authorised to make provider calls',
      unsupported,
    };
  }
  return { ready: true, unsupported };
}

/**
 * The forbidden claim, as a value rather than a comment.
 *
 * A live report carries `determinism: 'not-claimed'`. This guard exists so that
 * a future change which flips that to a determinism claim fails a test instead
 * of shipping a promise the system cannot keep.
 */
export const FORBIDDEN_LIVE_CLAIM = 'per-token-deterministic';

export function assertNotPerTokenDeterministic(observation: LiveObservation): void {
  const serialised = JSON.stringify(observation);
  if (observation.determinism !== 'not-claimed') {
    throw new Error(`a live observation must be labelled determinism: 'not-claimed', got ${String(observation.determinism)}`);
  }
  if (serialised.includes(FORBIDDEN_LIVE_CLAIM)) {
    throw new Error(
      `a live observation must not claim ${FORBIDDEN_LIVE_CLAIM}: a sampled provider is not per-token deterministic, and the label is the only place that claim could sneak in`,
    );
  }
  for (const [metric, stats] of Object.entries(observation.metrics)) {
    if (stats.n < 2) {
      throw new Error(`live metric "${metric}" has ${stats.n} measurement(s): a single sample cannot be summarised with a spread`);
    }
  }
}

/**
 * Build a live observation from raw measurement series.
 *
 * `source` is a required argument rather than inferred, so a caller cannot
 * forget to say where the numbers came from — the one field that decides whether
 * a reader is looking at a model result or a test fixture.
 */
export function makeLiveObservation(input: {
  parameters: LiveParameters;
  source: LiveObservation['source'];
  method: string;
  series: Readonly<Record<string, readonly number[]>>;
}): LiveObservation {
  if (input.parameters.measurements < 2) {
    throw new Error(`a live case must take at least 2 measurements, got ${input.parameters.measurements}`);
  }
  const metrics: Record<string, SampleStatistics> = {};
  for (const [name, values] of Object.entries(input.series)) {
    if (values.length !== input.parameters.measurements) {
      throw new Error(
        `live metric "${name}" has ${values.length} values but the case declares ${input.parameters.measurements} measurements; a sample and its declared size must agree`,
      );
    }
    metrics[name] = summarise(values);
  }
  const observation: LiveObservation = {
    determinism: 'not-claimed',
    parameters: input.parameters,
    metrics,
    source: input.source,
    method: input.method,
  };
  assertNotPerTokenDeterministic(observation);
  return observation;
}
