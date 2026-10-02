/**
 * The Control Plane: it decides what a run IS, and it is the only place that
 * decides.
 *
 * ## Why the manifest is assembled here and not in the runtime
 *
 * A manifest is a run's factual snapshot — which roots, which policy, which
 * connectors, which budget. Assembling it in the runtime would make the
 * fingerprint that proves "this run got what it was given" self-certified: the
 * same component would both choose the inputs and attest to them. So the
 * Control Plane assembles it, freezes it, persists it, and the runtime
 * receives it as a fact.
 *
 * ## Three fields the protocol flags as not yet backed by real data
 *
 * `manifest.ts:8-22` names them, and this factory treats each honestly rather
 * than papering over it:
 *
 *  1. **`permissionPolicy.rules`** — the wire form is a flat `Record`. The
 *     in-repo `ToolPermissionContext` holds a `ReadonlyMap`, and a `Map`
 *     serialises to `{}`. So the rules are omitted here rather than forwarded
 *     in a shape that would silently become empty. An absent `rules` says
 *     "no source-specific rules were supplied", which is true; a serialised
 *     `{}` would claim the same thing while hiding that the conversion never
 *     happened.
 *  2. **`env`** — still a reference plus a hash. The protocol header says "a
 *     Control Plane secret resolver must exist before this field means
 *     anything", and it does not. So the factory emits a stable reference and
 *     the hash of that reference, and a comment says why. This is the one place
 *     a reviewer should be most suspicious, which is why the comment is here
 *     rather than in a doc nobody reads at the call site.
 *  3. **`budget`** — the nearest real thing is the agent's `max_turns`. The
 *     factory maps it and leaves the other ceilings unset rather than
 *     inventing wall-clock and token limits that nothing measures.
 *
 * ## Immutability
 *
 * The returned object is deep-frozen. Not for discipline — for the fingerprint:
 * `manifestFingerprint` hashes the canonical JSON of whatever it is handed, so
 * a manifest mutated after the hash was recorded would no longer match its own
 * stored digest, and `verifyManifest` would report a corrupted row for a run
 * that behaved perfectly.
 */

import { randomUUID } from 'node:crypto';
import {
  DEFAULT_PERMISSION_TIMEOUT_MS,
  manifestFingerprint,
  type PermissionPolicyMode,
  type RunManifest,
} from '@duya/agent-protocol';

/** What the Control Plane knows when it opens a run. */
export interface RunIntent {
  readonly sessionId: string;
  /** The session's working directory; becomes the run's `cwd`. */
  readonly workingDirectory: string;
  /**
   * Extra roots the host has already validated. Absolute, and expected to
   * contain `cwd` — the protocol says the Control Plane resolves and checks
   * paths and the protocol only carries the decision.
   */
  readonly additionalRoots?: readonly string[];
  readonly projectId?: string | null;
  readonly workspaceId?: string;
  readonly permissionMode?: PermissionPolicyMode;
  /** The host's standing permission switch, from the persisted session row. */
  readonly hostSwitch?: 'ask' | 'always' | 'never';
  readonly model?: string;
  readonly providerId?: string;
  readonly effort?: string;
  readonly agentProfileId?: string | null;
  readonly modes?: readonly string[];
  readonly tools?: readonly string[];
  /** Nearest real ceiling: the agent's `max_turns`. */
  readonly maxTurns?: number;
  readonly traceId?: string;
  readonly parentRunId?: string;
  readonly goalId?: string;
  readonly taskId?: string;
  /** Caller-minted run id, so a caller can correlate before the row exists. */
  readonly runId?: string;
}

export interface BuiltRun {
  readonly runId: string;
  readonly manifest: RunManifest;
  /** Pinned by the Control Plane BEFORE the run starts. */
  readonly manifestHash: string;
  readonly traceId: string;
}

/**
 * Assemble and freeze a run manifest.
 *
 * @param intent - What the host knows. Every field is optional because the
 *   Control Plane supplies the defaults that the CURRENT product actually
 *   applies — a manifest full of invented policy would be worse than an honest
 *   minimal one.
 */
export function buildRunManifest(intent: RunIntent): BuiltRun {
  const runId = intent.runId ?? randomUUID();
  const traceId = intent.traceId ?? `trace-${runId}`;

  // Deduplicated, cwd first, order preserved. Duplicates in `roots` would make
  // two structurally different manifests describe the same execution, and the
  // fingerprint is only useful if it is a function of the VALUE.
  const roots = uniqueRoots([intent.workingDirectory, ...(intent.additionalRoots ?? [])]);

  const manifest: RunManifest = {
    version: 1,
    runId,
    projectId: intent.projectId ?? null,
    workspaceId: intent.workspaceId ?? `ws-${hashless(intent.sessionId)}`,
    ...(intent.goalId === undefined ? {} : { goalId: intent.goalId }),
    ...(intent.taskId === undefined ? {} : { taskId: intent.taskId }),
    roots,
    cwd: intent.workingDirectory,
    permissionPolicy: {
      mode: intent.permissionMode ?? 'default',
      hostSwitch: intent.hostSwitch ?? 'ask',
      defaultTimeoutMs: DEFAULT_PERMISSION_TIMEOUT_MS,
      // See header note 1: omitted on purpose. A serialised `Map` is `{}`, and
      // a `{}` that reads like "no rules" hides that no conversion happened.
    },
    capabilities: {
      profiles: intent.agentProfileId == null ? [] : [intent.agentProfileId],
      modes: intent.modes ?? ['general'],
      tools: intent.tools ?? [],
    },
    // No connector binding is emitted. The current product has a single global
    // connector store with no scope dimension (RFC §0), so there is nothing
    // truthful to name here, and a binding with a fabricated scope would be an
    // authorisation claim the Control Plane cannot back.
    connectorBindings: [],
    env: {
      // See header note 2. A reference, never a value. The hash covers the
      // reference so drift is detectable; it is NOT a hash of any resolved
      // secret, because no resolver exists to resolve one.
      ref: `env:${intent.sessionId}`,
      hash: 'sha256:unresolved',
    },
    ...(intent.model === undefined
      ? {}
      : {
          agent: {
            profileId: intent.agentProfileId ?? null,
            model: intent.model,
            providerId: intent.providerId ?? 'env',
            ...(intent.effort === undefined ? {} : { effort: intent.effort }),
          },
        }),
    // See header note 3: only the ceiling something actually measures today.
    budget: intent.maxTurns === undefined ? {} : { maxTurns: intent.maxTurns },
    // False: the current run carries a wall clock, a live worker pid, and no
    // determinism switch. Claiming `true` would make timestamps virtual and
    // nothing here supports reproducing that.
    deterministic: false,
    ...(intent.parentRunId === undefined ? {} : { parentRunId: intent.parentRunId }),
  };

  const frozen = deepFreeze(manifest);
  return { runId, manifest: frozen, manifestHash: manifestFingerprint(frozen), traceId };
}

/**
 * Freeze an object graph in place.
 *
 * `Object.freeze` on the top level only would leave `capabilities` and
 * `permissionPolicy` mutable, and a nested mutation after the fingerprint was
 * recorded is exactly the failure `verifyManifest` is built to catch — better
 * caught by throwing at the mutation than by finding it in a log later.
 */
function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value;
  for (const nested of Object.values(value as Record<string, unknown>)) {
    deepFreeze(nested);
  }
  return Object.freeze(value);
}

/**
 * Stable, filesystem-free id for a session.
 *
 * `workspaceId` is a new concept (RFC §1.1: `workspaceId` appears ZERO times in
 * the codebase today), so the Control Plane has to mint one. Deriving it from
 * the session id is the only choice that is honest about what it is: a
 * NAMESPACE for this session's execution, not a discovered workspace entity. A
 * content hash of the roots would be more meaningful and would also make the id
 * change when a root is added, which would silently re-key a session's runs.
 */
function hashless(sessionId: string): string {
  let hash = 0;
  for (let i = 0; i < sessionId.length; i += 1) {
    hash = (hash * 31 + sessionId.charCodeAt(i)) | 0;
  }
  return Math.abs(hash).toString(36);
}

function uniqueRoots(roots: readonly string[]): readonly string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const root of roots) {
    if (typeof root !== 'string' || root === '') continue;
    // Normalised comparison only. This is NOT path resolution — the protocol
    // says the Control Plane validates paths, and duplicating resolution logic
    // here is the boundary violation `03-target-structure.md` §5.1 warns
    // about (two escape checks with different semantics already exist in the
    // repo; a third would make three).
    const key = root.replace(/[\\/]+$/, '');
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(root);
  }
  return out;
}
