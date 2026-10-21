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
 *  1. **`permissionPolicy.rules`** — the wire form is a flat
 *     `Record<PermissionRuleSource, readonly string[]>`, and the factory
 *     SUPPORTS carrying it: a caller that has one gets it on the manifest,
 *     copied so the caller's arrays are not shared by reference.
 *
 *     No Desktop call site supplies one yet, and that is a finding rather than
 *     an oversight. The router's `effectivePermissionRules` is the LEGACY
 *     permission-context shape (`{ permissions: { additionalDirectories, … } }`),
 *     not a `PermissionRulesWire`; converting one to the other behind a cast
 *     would put a value in the run row that no reader could interpret, which is
 *     the silent substitution this slice exists to prevent. So until a real
 *     wire-form source exists, a Desktop run's `permissionPolicy` is recorded
 *     as `synthesised: true` — see `buildProvenance`.
 *  2. **`env`** — still a reference plus a hash. The protocol header says "a
 *     Control Plane secret resolver must exist before this field means
 *     anything", and it does not. So the factory emits a stable reference and
 *     the hash of that reference, and the manifest now RECORDS that as
 *     `provenance.env = { source: 'unsupported', synthesised: true }` rather
 *     than leaving it to a comment.
 *  3. **`budget`** — the nearest real thing is the agent's `max_turns`. The
 *     factory maps it and leaves the other ceilings unset rather than
 *     inventing wall-clock and token limits that nothing measures.
 *
 * ## Provenance moved out of this header and into the manifest (R2.2)
 *
 * Every comment above used to be the only record of which values were real.
 * That is fine for a reader of this file and useless for a reader of a run
 * row, which is where the question "what was this run configured with, and
 * how do I know?" is actually asked. So the distinction is now DATA:
 * `RunManifest.provenance` carries, for every configuration field, where the
 * value came from, the version of that source when it has one, and whether
 * the Control Plane supplied the value itself.
 *
 * The two consequences worth naming:
 *
 *  - `modes: ['general']` is gone. `general` is not a mode id in this
 *    product's registry, and writing it presented a fabricated value as a
 *    resolved one. An empty list plus `source: 'unsupported'` says what is
 *    actually true.
 *  - The fingerprint now covers provenance, so two runs resolved against
 *    different source versions are two different runs and cannot collide.
 *
 * ## Immutability
 *
 * The returned object is deep-frozen. Not for discipline — for the fingerprint:
 * `manifestFingerprint` hashes the canonical JSON of whatever it is handed, so
 * a manifest mutated after the hash was recorded would no longer match its own
 * stored digest, and `verifyManifest` would report a corrupted row for a run
 * that behaved perfectly.
 *
 * Deep-freezing also means the manifest cannot be a view onto the host's live
 * configuration object: the arrays and records are copied on the way in, so a
 * configuration change after the run was frozen cannot reach it.
 */

import { randomUUID } from 'node:crypto';
import {
  DEFAULT_PERMISSION_TIMEOUT_MS,
  manifestFingerprint,
  type ManifestField,
  type ManifestProvenance,
  type ManifestSource,
  type PermissionPolicyMode,
  type PermissionRulesWire,
  type RunManifest,
} from '@duya/agent-protocol';

/** Where a chat turn came from. Recorded so an executor's attribution is real. */
export type RunOrigin = 'user' | 'bot' | 'wake' | 'automation' | 'workflow' | 'subagent' | 'wakeless';

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
  /**
   * The real permission rules, in WIRE form.
   *
   * Carried when supplied, and copied — never forwarded by reference. No
   * Desktop call site supplies this yet: the router's merged object is the
   * legacy permission-context shape, not a `PermissionRulesWire`, and casting
   * between them would be a silent substitution. See header note 1.
   */
  readonly permissionRules?: PermissionRulesWire;
  /**
   * Who asked for this turn.
   *
   * Recorded because the router already computes it for the runtime lock and
   * was discarding it: an executor's attribution that is not on the manifest is
   * an attribution nobody can check.
   */
  readonly runOrigin?: RunOrigin;
  /**
   * Capabilities the run cannot proceed without.
   *
   * Distinct from `tools`/`modes`, which are a snapshot of what the Control
   * Plane believes exists. Naming a requirement here is what turns "this build
   * lacks a tool" from a refusal into a recorded degradation.
   */
  readonly requiredCapabilities?: readonly string[];
  /**
   * Versions of the versioned configuration sources this run resolved against.
   *
   * Only supplied for sources that genuinely have a version. An absent version
   * means "this source is not versioned" — the factory never invents one, and
   * an invented version would be exactly the self-certified fact the manifest
   * exists to prevent.
   */
  readonly sourceVersions?: Partial<Record<ManifestField, string>>;
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

  // Everything the host resolved, and nothing it did not. Each flag below
  // answers one question: was this value READ from configuration, or did the
  // Control Plane have to supply it? The answer is recorded per field, so a
  // reader of the run row does not have to guess which is which.
  const hasProfile = intent.agentProfileId != null;
  const hasModes = intent.modes !== undefined && intent.modes.length > 0;
  const hasTools = intent.tools !== undefined && intent.tools.length > 0;
  const hasRules = intent.permissionRules !== undefined;
  const hasAgent = intent.model !== undefined && intent.model !== '';
  // `providerId ?? 'env'` is a real fallback the product applies, but it is
  // still a default — so the whole agent selection is marked synthesised when
  // it fires, rather than being reported as a resolved provider.
  const providerFallback = intent.providerId === undefined || intent.providerId === '';
  const hasBudget = intent.maxTurns !== undefined;

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
      // Carried, not omitted. See header note 1: the rules arrive at the router
      // as a plain record, so there is no conversion left to skip and no `Map`
      // left to accidentally serialise into `{}`.
      ...(hasRules ? { rules: copyRules(intent.permissionRules as PermissionRulesWire) } : {}),
    },
    capabilities: {
      // An absent profile is `[]`, which is TRUE (no profile was selected),
      // rather than a fabricated name. The provenance entry is what says
      // whether the emptiness came from configuration or from there being no
      // source at all.
      profiles: hasProfile ? [intent.agentProfileId as string] : [],
      // `['general']` used to be written here. `general` is not a mode id in
      // this product's registry, so it was a plausible-looking value with no
      // referent — the manifest claiming a mode the executor cannot resolve.
      modes: hasModes ? [...(intent.modes as readonly string[])] : [],
      tools: hasTools ? [...(intent.tools as readonly string[])] : [],
    },
    ...(intent.requiredCapabilities === undefined
      ? {}
      : { requiredCapabilities: [...intent.requiredCapabilities] }),
    // No connector binding is emitted. The current product has a single global
    // connector store with no scope dimension (RFC §0), so there is nothing
    // truthful to name here, and a binding with a fabricated scope would be an
    // authorisation claim the Control Plane cannot back.
    connectorBindings: [],
    env: {
      // See header note 2. A reference, never a value. The hash covers the
      // reference so drift is detectable; it is NOT a hash of any resolved
      // secret, because no resolver exists to resolve one — and
      // `provenance.env` now says so on the manifest rather than only here.
      ref: `env:${intent.sessionId}`,
      hash: 'sha256:unresolved',
    },
    ...(hasAgent
      ? {
          agent: {
            profileId: intent.agentProfileId ?? null,
            model: intent.model as string,
            providerId: intent.providerId ?? 'env',
            ...(intent.effort === undefined ? {} : { effort: intent.effort }),
          },
        }
      : {}),
    // See header note 3: only the ceiling something actually measures today.
    budget: hasBudget ? { maxTurns: intent.maxTurns as number } : {},
    // False: the current run carries a wall clock, a live worker pid, and no
    // determinism switch. Claiming `true` would make timestamps virtual and
    // nothing here supports reproducing that.
    deterministic: false,
    ...(intent.parentRunId === undefined ? {} : { parentRunId: intent.parentRunId }),
    provenance: buildProvenance(intent, {
      hasProfile,
      hasModes,
      hasTools,
      hasRules,
      hasAgent,
      providerFallback,
      hasBudget,
    }),
  };

  const frozen = deepFreeze(manifest);
  return { runId, manifest: frozen, manifestHash: manifestFingerprint(frozen), traceId };
}

interface ResolvedFlags {
  readonly hasProfile: boolean;
  readonly hasModes: boolean;
  readonly hasTools: boolean;
  readonly hasRules: boolean;
  readonly hasAgent: boolean;
  readonly providerFallback: boolean;
  readonly hasBudget: boolean;
}

/**
 * Attribute every configuration field the manifest carries.
 *
 * The rule, applied uniformly: a value the host resolved is
 * `host_chat_request` and not synthesised; a value the Control Plane computed
 * is `derived` and synthesised; a value for which no configuration source
 * exists at all is `unsupported` and synthesised.
 *
 * `unsupported` is not a euphemism for "empty". It is the assertion that the
 * Control Plane had nothing to read — a fact a reader needs, and one an empty
 * array cannot express on its own, because an empty array produced by a real
 * "nothing configured" answer and one produced by "there is no catalog" are
 * the same bytes.
 */
function buildProvenance(intent: RunIntent, flags: ResolvedFlags): RunManifest['provenance'] {
  const attributed = (
    field: ManifestField,
    source: ManifestSource,
    synthesised: boolean,
  ): ManifestProvenance => {
    const sourceVersion = intent.sourceVersions?.[field];
    return { source, synthesised, ...(sourceVersion === undefined ? {} : { sourceVersion }) };
  };

  // Mode, host switch and timeout are the host's standing configuration. What
  // genuinely comes from the session is the RULES, so a run that supplied no
  // rules is the one whose permission policy is a Control Plane default.
  const anyResolvedCapabilities = flags.hasProfile || flags.hasModes || flags.hasTools;

  return {
    // `roots` and `cwd` come from the same resolution — the session's working
    // directory plus the project's additional writable roots — so they share a
    // source and an answer. The host resolves; the protocol only carries the
    // decision, and this factory deliberately does not re-resolve.
    roots: attributed('roots', 'host_chat_request', false),
    cwd: attributed('cwd', 'host_chat_request', false),
    permissionPolicy: attributed('permissionPolicy', 'host_chat_request', !flags.hasRules),
    capabilities: attributed(
      'capabilities',
      anyResolvedCapabilities ? 'host_chat_request' : 'unsupported',
      !anyResolvedCapabilities,
    ),
    connectorBindings: attributed('connectorBindings', 'unsupported', true),
    env: attributed('env', 'unsupported', true),
    agent: attributed(
      'agent',
      flags.hasAgent ? 'host_chat_request' : 'unsupported',
      !flags.hasAgent || flags.providerFallback,
    ),
    budget: attributed('budget', flags.hasBudget ? 'host_chat_request' : 'unsupported', !flags.hasBudget),
    // A namespace derived from the session id, not a discovered workspace
    // entity. Said here so nobody reads `ws-1f4a` as a device-local id.
    workspaceId: attributed('workspaceId', 'derived', true),
    // Not configuration at all: a fact about what this runtime can do.
    deterministic: attributed('deterministic', 'runtime_fact', false),
  };
}

/**
 * Copy a permission rule table out of the caller's object.
 *
 * Freezing the manifest would protect the manifest, but the copy happens
 * FIRST, so the caller's arrays are not shared by reference: a host that later
 * pushes onto the array it passed in must not be able to reach a frozen
 * manifest through it. On a copy there is nothing to throw at, which is the
 * point.
 */
function copyRules(rules: PermissionRulesWire): PermissionRulesWire {
  const out: Record<string, readonly string[]> = {};
  for (const [source, tools] of Object.entries(rules)) {
    out[source] = [...tools];
  }
  // The cast restores the CLOSED key union that `Object.entries` widens away.
  // It cannot introduce a key the input did not have — the loop only copies
  // keys that were present — so this recovers the type without weakening the
  // guarantee that the manifest's keys are `PermissionRuleSource` values.
  return out as PermissionRulesWire;
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
