/**
 * evals/agent/evaluators/layer.ts — the failing-layer vocabulary, and the
 * result types every evaluator returns.
 *
 * ## Why a layer at all
 *
 * "The eval went red" does not tell a reader where to look. Seven layers do,
 * and each one names a different owner and a different next action:
 *
 *   contract       the protocol/manifest/schema contract was violated
 *   host-adapter   the platform adapter (worker process, transport, dispatch)
 *   model-decision the model's own trajectory was wrong
 *   tool           a real tool failed on its own terms
 *   storage        durability, the run row, the event ledger
 *   policy         permission / approval / budget / redaction policy
 *   environment    the evaluation could not run here (no key, no network, ...)
 *
 * ## The layer is DERIVED, never chosen
 *
 * A layer that a human picks is a layer that reflects the author's belief about
 * the system under test, which is precisely the belief the eval exists to check.
 * So every layer here is a function of observed evidence, and the derivation is
 * table-driven off the protocol's own closed `ErrorCode` set (read from
 * `@duya/agent-protocol`, not re-declared — a copy would pass while the real
 * list drifted).
 *
 * Three outcomes that are easy to get wrong, and are handled explicitly:
 *
 *  - A code that is real but that this table does not cover is `unknown`. It is
 *    NOT guessed from the code's name.
 *  - A code that is not in the protocol's closed set at all is `contract`: an
 *    emitter produced vocabulary the contract does not define. That is a
 *    contract violation by definition, and it is the one case where an
 *    unrecognised string is attributed rather than left unknown.
 *  - A failed terminal that names no code is `unknown`. "It failed" is not
 *    "the tool failed", and collapsing the two is how a tool-layer bug gets
 *    filed against the model.
 *
 * ## unknown and skipped are results, not holes
 *
 * `unknown` and `skipped` are recorded, counted separately, and never
 * aggregated into success. `./suite.ts` holds the aggregation rule and the exit
 * code policy; the short form is: a report is a pass only if every check passed.
 */

import { ERROR_CODES, isKnownCode } from '@duya/agent-protocol';

export const FAILING_LAYERS = [
  'contract',
  'host-adapter',
  'model-decision',
  'tool',
  'storage',
  'policy',
  'environment',
] as const;
export type FailingLayer = (typeof FAILING_LAYERS)[number];

/** `unknown` is a first-class attribution, not a member of the seven. */
export const ATTRIBUTED_LAYERS = [...FAILING_LAYERS, 'unknown'] as const;
export type AttributedLayer = (typeof ATTRIBUTED_LAYERS)[number];

export function isAttributedLayer(value: unknown): value is AttributedLayer {
  return typeof value === 'string' && (ATTRIBUTED_LAYERS as readonly string[]).includes(value);
}

/**
 * Every real protocol error code, mapped to the layer that OWNS it.
 *
 * Read off `ERROR_CODES` so this table cannot drift from the closed set: the
 * `codeCoverage` test asserts every code is either mapped here or deliberately
 * listed in `UNATTRIBUTED_CODES`. A new code that nobody has classified fails
 * that test, which is the intended pressure — a new code should arrive with a
 * layer, not without one.
 */
const LAYER_BY_CODE: Readonly<Record<string, FailingLayer>> = {
  // contract — negotiation, framing, and the manifest binding
  invalid_request: 'contract',
  invalid_manifest: 'contract',
  invalid_resume_point: 'contract',
  replay_unavailable: 'contract',
  unsupported_protocol_version: 'contract',
  unknown_method: 'contract',
  invalid_event_frame: 'contract',
  unknown_event_type: 'contract',
  manifest_mismatch: 'contract',

  // host-adapter — the platform under the agent
  transport_closed: 'host-adapter',
  transport_backpressure_timeout: 'host-adapter',
  runtime_unavailable: 'host-adapter',
  runtime_crash: 'host-adapter',
  worker_spawn_failed: 'host-adapter',

  // model-decision — the trajectory the model chose, and the budget it ran into
  budget_exhausted: 'model-decision',
  deadline_exceeded: 'model-decision',
  compaction_failed: 'model-decision',
  provider_rate_limited: 'model-decision',
  provider_auth: 'model-decision',
  provider_quota: 'model-decision',
  provider_overloaded: 'model-decision',
  provider_bad_request: 'model-decision',
  provider_timeout: 'model-decision',
  provider_unavailable: 'model-decision',

  // tool — a real tool failing on its own terms
  tool_failed: 'tool',
  tool_timeout: 'tool',
  tool_crash: 'tool',

  // storage — durability
  persistence_failed: 'storage',
  checkpoint_failed: 'storage',
  run_not_found: 'storage',
  session_not_found: 'storage',

  // policy — authorisation, approval, and lifecycle conflicts
  permission_unknown_request: 'policy',
  permission_expired: 'policy',
  permission_denied_by_policy: 'policy',
  cancel_conflict: 'policy',
  run_terminal: 'policy',
  run_active: 'policy',

  // `internal` is deliberately absent. It is the code that means "nobody
  // classified this", and mapping it to any layer would be a guess wearing a
  // layer's name. It resolves to `unknown` below.
};

/**
 * Codes deliberately left unattributed, with the reason. Keep this list short
 * and justify every entry: it is a list of things nobody has decided yet.
 */
export const UNATTRIBUTED_CODES: Readonly<Record<string, string>> = {
  internal: 'the catch-all: attributing it to a layer would restate "unknown" as a guess',
  capability_unsupported: 'the run layer refused a capability; who should own that is a design question, not an eval finding',
  capability_not_ready: 'same as capability_unsupported: a lifecycle ordering fact, not a defect attribution',
};

/** Observed evidence an evaluator can hand to the attribution rule. */
export interface AttributionFacts {
  /** The terminal's error code, as the real store recorded it. */
  readonly terminalErrorCode?: string | null;
  /** `failed` with no code at all is `unknown`, never a guessed layer. */
  readonly terminalStatus?: string | null;
  /** A real tool call that came back with `error: true`. */
  readonly toolErrorObserved?: boolean;
  /** A `chat:tool_use` with no matching `chat:tool_result`. */
  readonly toolResultAbsent?: boolean;
  /** A terminal claimed while no run row / no events are on disk. */
  readonly storageGapObserved?: boolean;
  /** A value the redaction policy covers reached an artefact. */
  readonly redactionBreach?: boolean;
  /** The harness itself could not run this case here. */
  readonly environmentBlock?: string;
}

export interface Attribution {
  readonly layer: AttributedLayer;
  /** Which rule fired, so a reader can check the derivation. */
  readonly rule: string;
}

/**
 * Derive the failing layer from observed evidence.
 *
 * Precedence is deliberate: an environment block outranks everything (nothing
 * was observed if the case never ran), then the terminal's own code (the
 * system already named its failure), then artefact signals, then `unknown`.
 */
export function attribute(facts: AttributionFacts): Attribution {
  if (facts.environmentBlock !== undefined) {
    return { layer: 'environment', rule: `the case could not run here: ${facts.environmentBlock}` };
  }

  const code = facts.terminalErrorCode;
  if (typeof code === 'string' && code.length > 0) {
    const mapped = LAYER_BY_CODE[code];
    if (mapped !== undefined) return { layer: mapped, rule: `protocol error code "${code}" is owned by ${mapped}` };
    if (isKnownCode(code)) {
      return {
        layer: 'unknown',
        rule: `protocol error code "${code}" is real but unclassified (${UNATTRIBUTED_CODES[code] ?? 'no owner recorded'})`,
      };
    }
    return {
      layer: 'contract',
      rule: `"${code}" is outside the protocol's closed ErrorCode set: the emitter used vocabulary the contract does not define`,
    };
  }

  if (facts.redactionBreach === true) {
    return { layer: 'policy', rule: 'a value the redaction policy covers reached an artefact' };
  }
  if (facts.storageGapObserved === true) {
    return { layer: 'storage', rule: 'a terminal was reported with no durable run row or no run events behind it' };
  }
  if (facts.toolErrorObserved === true) {
    return { layer: 'tool', rule: 'a real tool call returned error: true' };
  }
  if (facts.toolResultAbsent === true) {
    return {
      layer: 'host-adapter',
      rule: 'a chat:tool_use never received its chat:tool_result: the channel lost the answer',
    };
  }
  if (facts.terminalStatus === 'failed') {
    return { layer: 'unknown', rule: 'the run failed and named no error code, so no layer can be attributed' };
  }
  return { layer: 'unknown', rule: 'no failing evidence was observed' };
}

/** Every protocol code this table has an opinion about, mapped or explicitly not. */
export function codeCoverage(): {
  readonly classified: Readonly<Record<string, FailingLayer>>;
  readonly unclassified: Readonly<Record<string, string>>;
  readonly unmapped: readonly string[];
} {
  const unmapped = ERROR_CODES.filter(
    (code) => LAYER_BY_CODE[code] === undefined && UNATTRIBUTED_CODES[code] === undefined,
  );
  return { classified: LAYER_BY_CODE, unclassified: UNATTRIBUTED_CODES, unmapped };
}

// ── result types ─────────────────────────────────────────────────────────────

/**
 * `unknown` and `skipped` are separate on purpose:
 *
 *  - `unknown` — the check RAN and could not decide. Evidence was insufficient
 *    or unattributable. This is a result about the system's observability.
 *  - `skipped` — the check did NOT run. A missing credential, a case format
 *    version with no migration, an unsupported capability. This is a result
 *    about the evaluation's reach.
 *
 * Collapsing them would hide the difference between "the system would not tell
 * me" and "I could not ask".
 */
export const CHECK_STATUSES = ['pass', 'fail', 'unknown', 'skipped'] as const;
export type CheckStatus = (typeof CHECK_STATUSES)[number];

export type EvalFamily = 'structure' | 'safety' | 'task-artefact' | 'cost-performance';

export interface CheckResult {
  /** `<family>/<kind>`, stable and greppable in a report. */
  readonly checkId: string;
  readonly family: EvalFamily;
  readonly status: CheckStatus;
  /** One line a reviewer can act on. Never a bare boolean. */
  readonly detail: string;
  /** Only meaningful when the status is `fail` or `unknown`. */
  readonly layer: AttributedLayer;
  /** The rule or the observed value the verdict came from. */
  readonly evidence: string;
}

export function pass(checkId: string, family: EvalFamily, detail: string, evidence: string): CheckResult {
  return { checkId, family, status: 'pass', detail, layer: 'unknown', evidence };
}

export function fail(
  checkId: string,
  family: EvalFamily,
  detail: string,
  facts: AttributionFacts,
  evidence: string,
): CheckResult {
  return { checkId, family, status: 'fail', detail, layer: attribute(facts).layer, evidence };
}

export function unknown(
  checkId: string,
  family: EvalFamily,
  detail: string,
  facts: AttributionFacts,
  evidence: string,
): CheckResult {
  return { checkId, family, status: 'unknown', detail, layer: attribute(facts).layer, evidence };
}

export function skipped(checkId: string, family: EvalFamily, reason: string, evidence: string): CheckResult {
  // A skipped check is attributed to `environment` when the reason is a missing
  // capability, because that is where the gap actually is. It is NOT a pass.
  return { checkId, family, status: 'skipped', detail: reason, layer: 'environment', evidence };
}
