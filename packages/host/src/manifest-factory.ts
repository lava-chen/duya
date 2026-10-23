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
 *     **Resolved (card 09).** There are now TWO sources, and they are told
 *     apart by inspection rather than by a cast:
 *
 *     - `RunIntent.permissionRules` is the wire form itself. It is read
 *       through `readPermissionRulesWire`, which CHECKS the shape — a rule
 *       table that is a `Map` serialises to `{}`, and a manifest whose rules
 *       are `{}` says "no rule allows anything" while looking like "the rules
 *       were lost".
 *     - `RunIntent.legacyPermissionContext` is the legacy blob
 *       (`{ permissions: { allow, deny, ask, additionalDirectories } }`). It
 *       is converted by `convertLegacyPermissionContext`, at this boundary,
 *       and the conversion keeps the allow / deny / ask split in
 *       `permissionPolicy.ruleTables` — because the wire form has no
 *       dimension for behaviour, and merging the three buckets would put a
 *       value in the run row that no reader could interpret.
 *
 *     The converted case is attributed to `source: 'legacy_context_converted'`
 *     with `synthesised: false`: the value is derived from a real source by
 *     a real, named conversion, and saying which of those two facts it is
 *     lets a reader trust it. The conversion happens BEFORE the value reaches
 *     the manifest — there is no cast to convert behind.
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
 *     **Extended (card 09), not changed.** `RunManifest.budgetCeilings`
 *     records, for every ceiling, whether it is `measured` or `unmeasured`,
 *     and `provenance.budget.items` carries the same per-ceiling status. The
 *     rule is mechanical: a ceiling is `measured` only when a live policy
 *     carries a limit for it, so no ceiling can be both uncounted and
 *     unmarked. The ceilings the product does not count today are marked
 *     `unmeasured` with the reason, which is the honest answer — and it is a
 *     FACT on the run row rather than a sentence in a file header.
 *
 * ## The sandbox is a fact about the run, not a configuration
 *
 * `RunManifest.sandbox` records the isolation level the run's commands
 * actually got. The reason it is on the manifest at all: the sandbox
 * adapter's `wrapCommand` and `executeIsolated` had NO production consumer,
 * so the worker announced a sandbox and then ran every command without one.
 * A run row that says "no OS isolation" is worth more than a comment that
 * says the same thing, because the run row is what a reader of the run can
 * see.
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
  type BudgetCeilings,
  type ManifestField,
  type ManifestProvenance,
  type ManifestSource,
  type PermissionPolicyMode,
  type PermissionRulesWire,
  type PermissionRuleTablesWire,
  type RunManifest,
  type SandboxIsolationRecord,
} from '@duya/agent-protocol';
import { resolveShellIsolationSync } from '@duya/sandbox';
import {
  convertLegacyPermissionContext,
  readPermissionRulesWire,
} from './authorization/permission-rules-source.js';
import {
  resolveBudgetCeilings,
  type ResourceBudgetLimits,
} from './authorization/resource-budget.js';
import { calculateMaxConcurrentWorkers, getWorkerMaxMemoryMB } from './worker-limits.js';

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
   * Carried when supplied, and copied — never forwarded by reference. The
   * shape is CHECKED, not cast: a rule table that is a `Map` serialises to
   * `{}`, and a manifest whose `rules` are `{}` says "no rule allows
   * anything" while looking like "the rules were lost".
   */
  readonly permissionRules?: PermissionRulesWire;
  /**
   * The permission rules in the LEGACY permission-context shape.
   *
   * `{ permissions: { allow, deny, ask, additionalDirectories } }` — the blob
   * the Desktop router and the worker handshake carry. It is converted at
   * THIS boundary by `convertLegacyPermissionContext`, and the result is
   * attributed to `source: 'legacy_context_converted'`.
   *
   * The conversion keeps the allow / deny / ask split in
   * `permissionPolicy.ruleTables`, because the wire form has no dimension for
   * behaviour. `permissions.additionalDirectories` become ROOTS, because that
   * is what they are — a directory is not a rule string.
   */
  readonly legacyPermissionContext?: unknown;
  /**
   * The resource limits this run is held to.
   *
   * Every limit here is one the product actually applies, so the manifest can
   * mark the matching ceilings as `measured`. A limit that is not enforced
   * must not be declared here: the manifest would then record a ceiling the
   * run was never held to.
   */
  readonly resourceLimits?: ResourceBudgetLimits;
  /**
   * The isolation level in force for this run's commands.
   *
   * When absent, the factory resolves the host's own level — the level the
   * commands this run spawns will actually get — rather than leaving the
   * field off and letting a reader assume the best.
   */
  readonly sandbox?: SandboxIsolationRecord;
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

  // The permission rules, resolved ONCE and at the boundary.
  //
  // Two shapes reach the Control Plane, and they mean different things: the
  // protocol's wire form (source to rule strings) and the legacy
  // permission-context blob (allow / deny / ask plus directories). They are
  // told apart by inspection here, and the legacy one is CONVERTED here — not
  // after a cast, and not by a caller that hopes it got the shape right.
  const rules = resolvePermissionRules(intent);

  // Deduplicated, cwd first, order preserved. Duplicates in `roots` would make
  // two structurally different manifests describe the same execution, and the
  // fingerprint is only useful if it is a function of the VALUE.
  // The legacy blob's `additionalDirectories` are ROOTS, and they join the
  // roots the host resolved — they are not rule strings.
  const roots = uniqueRoots([
    intent.workingDirectory,
    ...(intent.additionalRoots ?? []),
    ...rules.additionalRoots,
  ]);

  // Everything the host resolved, and nothing it did not. Each flag below
  // answers one question: was this value READ from configuration, or did the
  // Control Plane have to supply it? The answer is recorded per field, so a
  // reader of the run row does not have to guess which is which.
  const hasProfile = intent.agentProfileId != null;
  const hasModes = intent.modes !== undefined && intent.modes.length > 0;
  const hasTools = intent.tools !== undefined && intent.tools.length > 0;
  const hasRules = rules.rules !== undefined;
  const hasAgent = intent.model !== undefined && intent.model !== '';
  // `providerId ?? 'env'` is a real fallback the product applies, but it is
  // still a default — so the whole agent selection is marked synthesised when
  // it fires, rather than being reported as a resolved provider.
  const providerFallback = intent.providerId === undefined || intent.providerId === '';
  const hasBudget = intent.maxTurns !== undefined;

  // The ceilings, and whether each one is measured. Derived from the live
  // host policy, so a ceiling cannot be marked `measured` without a limit
  // behind it.
  const budgetCeilings = resolveBudgetCeilings({
    limits: {
      ...(intent.maxTurns === undefined ? {} : { maxTurns: intent.maxTurns }),
      ...(intent.resourceLimits ?? {}),
      maxWorkerMemoryMb: getWorkerMaxMemoryMB(),
      maxConcurrentWorkers: calculateMaxConcurrentWorkers(),
    },
    enforcement: {
      turns: 'the agent configuration stops the run at this turn',
      cpuMemory: 'the worker process runs with --max-old-space-size set to this cap',
      concurrency: 'the host refuses to start more workers than this',
    },
  });

  // The isolation the run's commands will actually get. A fact about the
  // host, resolved by the same adapter the shell path uses — so the manifest
  // cannot claim an isolation the commands do not get.
  const sandbox = intent.sandbox ?? resolveHostSandboxIsolation();

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
      // Carried, not omitted, and copied so the caller's arrays are not
      // shared by reference. See header note 1.
      ...(rules.rules === undefined ? {} : { rules: copyRules(rules.rules) }),
      // The behaviour split, when the rules came from a source that has one.
      ...(rules.ruleTables === undefined ? {} : { ruleTables: rules.ruleTables }),
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
    // The per-ceiling accounting, so a reader can tell a counted ceiling from
    // an uncounted one without reading this file.
    budgetCeilings,
    // The isolation the run's commands get. See the header section on the
    // sandbox: this is a fact, not a promise.
    sandbox,
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
      rulesSource: rules.source,
      rootsSource: rules.additionalRoots.length > 0 ? 'legacy_context_converted' : 'host_chat_request',
      hasAgent,
      providerFallback,
      hasBudget,
      budgetCeilings,
    }),
  };

  const frozen = deepFreeze(manifest);
  return { runId, manifest: frozen, manifestHash: manifestFingerprint(frozen), traceId };
}

/** The rules, and where they came from. */
interface ResolvedPermissionRules {
  /** The wire form, when there are rules at all. */
  readonly rules?: PermissionRulesWire;
  /** The behaviour split, when the source carried one. */
  readonly ruleTables?: PermissionRuleTablesWire;
  /** The writable roots the legacy blob carried. */
  readonly additionalRoots: readonly string[];
  /** Where the rules came from, for the provenance entry. */
  readonly source: ManifestSource;
}

/**
 * Resolve the run's permission rules at the Control Plane boundary.
 *
 * The wire form is CHECKED, not cast: a rule table that is a `Map` serialises
 * to `{}`, and a manifest whose `rules` are `{}` says "no rule allows
 * anything" while looking like "the rules were lost".
 *
 * The legacy blob is CONVERTED, here, by a named conversion — not by a cast
 * and not by a caller that hopes it got the shape right. The converted value
 * is attributed to `legacy_context_converted`, so a reader can tell a
 * resolved rule table from a converted one.
 */
function resolvePermissionRules(intent: RunIntent): ResolvedPermissionRules {
  if (intent.permissionRules !== undefined) {
    const wire = readPermissionRulesWire(intent.permissionRules);
    // `readPermissionRulesWire` refuses a table that is not the wire shape
    // by returning null, so the check is for null and not for undefined.
    if (wire !== null) {
      return { rules: wire, additionalRoots: [], source: 'host_chat_request' };
    }
    // A wire form that does not check out is treated as no rules at all. The
    // provenance then says the policy has no source, which is true — a table
    // nobody can read is not a table.
    return { additionalRoots: [], source: 'unsupported' };
  }

  if (intent.legacyPermissionContext !== undefined) {
    const conversion = convertLegacyPermissionContext(intent.legacyPermissionContext);
    const hasAnyRule = Object.keys(conversion.rules).length > 0;
    return {
      ...(hasAnyRule ? { rules: conversion.rules } : {}),
      ...(Object.keys(conversion.ruleTables).length > 0 ? { ruleTables: conversion.ruleTables } : {}),
      additionalRoots: conversion.additionalRoots,
      // A converted value is not a value the host resolved, and it is not
      // fabricated either. `legacy_context_converted` says exactly which of
      // those it is, and `synthesised: false` says the Control Plane did not
      // invent it.
      source: hasAnyRule ? 'legacy_context_converted' : 'unsupported',
    };
  }

  return { additionalRoots: [], source: 'unsupported' };
}

/**
 * The isolation level this host's commands get.
 *
 * Resolved by the same adapter the shell path uses, so the manifest cannot
 * claim an isolation the commands do not get. `unresolved` is not a value
 * here: the resolver always answers, and a host with no provider answers
 * `none` with the reason.
 */
function resolveHostSandboxIsolation(): SandboxIsolationRecord {
  const isolation = resolveShellIsolationSync();
  return {
    provider: isolation.provider,
    isolated: isolation.isolated,
    reason: isolation.reason,
    source: 'sandbox_adapter',
  };
}

interface ResolvedFlags {
  readonly hasProfile: boolean;
  readonly hasModes: boolean;
  readonly hasTools: boolean;
  readonly hasRules: boolean;
  readonly rulesSource: ManifestSource;
  readonly rootsSource: ManifestSource;
  readonly hasAgent: boolean;
  readonly providerFallback: boolean;
  readonly hasBudget: boolean;
  readonly budgetCeilings: BudgetCeilings;
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

  // The per-ceiling status, so the budget's provenance says which ceilings
  // are counted and which are not. The map is derived from the ceilings
  // themselves, so the two cannot drift.
  const budgetItems: Record<string, 'measured' | 'unmeasured'> = {};
  for (const [ceiling, record] of Object.entries(flags.budgetCeilings)) {
    budgetItems[ceiling] = record.status;
  }

  return {
    // `roots` and `cwd` come from the same resolution — the session's working
    // directory plus the project's additional writable roots — so they share a
    // source and an answer. The host resolves; the protocol only carries the
    // decision, and this factory deliberately does not re-resolve.
    // The roots come from the session's working directory plus the
    // project's additional writable roots. When the legacy permission blob
    // contributed directories, they came through the conversion, and the
    // provenance says so rather than crediting the chat request for them.
    roots: attributed('roots', flags.rootsSource, false),
    cwd: attributed('cwd', 'host_chat_request', false),
    // The rules decide the source: a wire table the host resolved, a legacy
    // blob the Control Plane converted, or nothing at all. `synthesised` is
    // false for the converted case on purpose — the value came from a real
    // source and the conversion is named in `source`.
    permissionPolicy: attributed('permissionPolicy', flags.rulesSource, !flags.hasRules),
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
    budget: {
      ...attributed('budget', flags.hasBudget ? 'host_chat_request' : 'unsupported', !flags.hasBudget),
      items: budgetItems,
    },
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
