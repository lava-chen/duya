/**
 * The worker checks what it was given, before it executes anything (plan 587
 * R2.2).
 *
 * ## Why the worker is the one that checks
 *
 * R2.1 put `manifestHash` and `inputRevision` on the `chat:start` command and
 * the worker LOGGED them. Carrying a digest is not checking it: a hash nobody
 * compares is a comment with hex in it, and the run proceeds exactly as it
 * would have if the manifest had been wrong. The whole point of freezing a
 * manifest is that someone downstream can say "this is not what I was given"
 * — and the worker is the only party that knows what it actually received.
 *
 * ## Five refusals, and why they are five
 *
 * They are not one error with five messages. Each names a different party
 * being wrong, a different fix, and a different question a host asks next.
 *
 *  1. **`manifest_version_unsupported`** — *I cannot read this contract.*
 *     Checked FIRST, and deliberately so: a manifest this build does not
 *     understand may carry fields the digest covers and the reader does not,
 *     so a hash comparison here would be meaningless. Blaming the Control
 *     Plane for a mismatch we cannot even evaluate would be a false
 *     accusation, and the accurate statement is "I do not speak this version".
 *     REFUSED: there is no partial reading of a configuration.
 *
 *  2. **`manifest_hash_mismatch`** — *this is not the manifest that was
 *     frozen.* Either the manifest was rewritten after the Control Plane
 *     pinned the hash, or the command was assembled from two different
 *     manifests. Either way the run row's recorded configuration is not the
 *     one about to execute, which is precisely the "thinks it is running
 *     under profile A while running under profile B" failure. REFUSED: there
 *     is no "mostly correct" manifest, and choosing the nearer of two
 *     contradictory instructions is a silent substitution.
 *
 *  3. **`cwd_illegal`** — *the manifest is intact and its CONTENT is not
 *     permitted.* Checked only after the digest matched, so the claim being
 *     examined is known to be a real Control Plane decision rather than
 *     something invented in transit. This is a boundary check and not a
 *     consistency check: `roots`/`cwd` are exactly the fields a caller could
 *     most usefully lie about. REFUSED, and it is the one refusal with no
 *     conceivable degrade — every legal `cwd` is a value the Control Plane
 *     never chose, so picking one is substitution by another name.
 *
 *  4. **`required_capability_unavailable`** — *the Control Plane said this
 *     run cannot do its job without something I do not have.* REFUSED, because
 *     the demand was explicit and named. See the boundary below.
 *
 *  5. **`input_binding_mismatch`** — *the turn that arrived is not the turn
 *     that was pinned.* A different CLASS from the other four: it says nothing
 *     about the manifest at all, and it is the check that makes the removal of
 *     the old dual input source falsifiable rather than merely asserted. If a
 *     side channel ever delivers a prompt beside the resolved one again, the
 *     worker sees the two disagree and stops. REFUSED: executing a turn that
 *     was not the one recorded is unrecoverable after the first tool call.
 *
 * ## Required and absent are not the same thing
 *
 * The boundary, stated once:
 *
 *  - A capability in `manifest.requiredCapabilities` is a DEMAND. The Control
 *    Plane decided this run has no meaning without it. Missing ⇒ refuse.
 *  - A capability named in `manifest.capabilities` (profiles / modes / tools)
 *    is a SNAPSHOT OF WHAT THE CONTROL PLANE BELIEVES EXISTS. It is not a
 *    demand, so a name this build has never heard of is version skew. Missing
 *    ⇒ record it in `unsatisfiedOptional` and continue. Refusing here would
 *    turn every ordinary release skew — one build ships a new tool, an older
 *    worker is still alive — into a total outage for turns that do not use it.
 *
 * The asymmetry is deliberate and it is the whole design: refusing too little
 * produces a run that lies about itself, and refusing too much produces a
 * product that is down because a worker was recycled a version early. Only an
 * EXPLICIT demand is worth an outage.
 *
 * ## A frozen snapshot is not re-frozen against a newer catalog
 *
 * `catalogRevision` is REPORTED, never adopted. The run keeps executing
 * against the configuration it was frozen with, and the difference between the
 * two is handed back to the host as a revision record. Adopting the newer
 * catalog mid-run would be a quiet mutation of the snapshot — the run would
 * quietly gain or lose tools after it started, and the manifest would no
 * longer describe it.
 *
 * ## What is NOT here yet, stated rather than implied
 *
 * The revision is reported to the host and logged by the worker, and the
 * snapshot itself is provably not mutated. It is NOT yet a DURABLE run event,
 * and nothing in this file should be read as claiming it is. The protocol has
 * no catalog/config revision event type, and adding one is a deliberate act
 * with a reviewable diff: it means a new entry in `EVENT_META`, a new
 * `RunEventPayloads` member, and an update to
 * `test/__snapshots__/event-types.json` (drift test #5 exists precisely so
 * that cannot happen as a side effect) plus the exhaustive-switch accounting
 * in drift test #4. That is the next slice, not this one, and until it lands
 * the revision is an in-memory record plus a log line — real, and honestly
 * scoped.
 */


import {
  manifestFingerprint,
  runInputRevision,
  type RunManifest,
} from '@duya/agent-protocol';

/** What this worker build can actually do, and what revision it is. */
export interface WorkerCapabilitySet {
  /** Capability ids this build implements. */
  readonly available: readonly string[];
  /**
   * The tool / profile / mode catalog revision this process is running.
   *
   * Compared against nothing today — the manifest has no catalog revision to
   * compare it to — but it is already REPORTED, so a host can see that a run
   * froze against a different catalog than the process that is executing it.
   * See the file header on why it is never adopted.
   */
  readonly catalogRevision: string;
  /** The manifest version this build can interpret. */
  readonly manifestVersion: 1;
}

export interface ManifestVerificationRequest {
  /** The manifest as it arrived on the command. */
  readonly manifest: RunManifest;
  /** The hash the Control Plane pinned BEFORE the run. */
  readonly manifestHash: string;
  /** The digest of the input the Control Plane resolved. */
  readonly inputRevision: string;
  /** The input this process actually received. */
  readonly received: {
    readonly sessionId: string;
    readonly prompt: string;
    readonly options: Readonly<Record<string, unknown>>;
  };
  readonly worker: WorkerCapabilitySet;
}

/** The refusal codes, one per incident. A caller branches on these. */
export type ManifestRejectionCode =
  | 'manifest_version_unsupported'
  | 'manifest_hash_mismatch'
  | 'cwd_illegal'
  | 'required_capability_unavailable'
  | 'input_binding_mismatch';

export interface ManifestRejection {
  readonly ok: false;
  readonly code: ManifestRejectionCode;
  /** One sentence, for a log line. Never the only thing a caller reads. */
  readonly detail: string;
  /** `manifest_version_unsupported` — what each side speaks. */
  readonly supported?: number;
  readonly received?: number;
  /** `manifest_hash_mismatch` — the two digests, so the host can log both. */
  readonly expected?: string;
  readonly actual?: string;
  /** `required_capability_unavailable` / `cwd_illegal` — the subject. */
  readonly capability?: string;
  readonly cwd?: string;
  readonly roots?: readonly string[];
}

/** The revision record. Reported, never applied. */
export interface CatalogRevisionRecord {
  /** The catalog revision the run was frozen against, when one is known. */
  readonly manifest: string | null;
  /** The catalog revision this process is running. */
  readonly worker: string;
  /**
   * Always `false`, and asserted by the tests.
   *
   * Present as a FIELD rather than left implicit so that a future change which
   * does adopt a newer catalog has to flip a boolean a reviewer can see, rather
   * than quietly start mutating a run's snapshot.
   */
  readonly adopted: false;
}

export interface ManifestAccepted {
  readonly ok: true;
  /** Required capabilities this build has. */
  readonly satisfied: readonly string[];
  /** Optional capabilities this build does not have. Recorded, not fatal. */
  readonly unsatisfiedOptional: readonly string[];
  readonly catalogRevision: CatalogRevisionRecord;
}

export type ManifestVerification = ManifestAccepted | ManifestRejection;

/**
 * Verify one turn's binding to its manifest.
 *
 * Pure and total in the sense that matters: it returns a decision rather than
 * throwing, because every rejection here is a fact about the turn that the
 * caller has to be able to RECORD, and a throw would put a decision the run
 * layer must persist into an exception path that usually cannot.
 */
export function verifyRunManifestBinding(
  request: ManifestVerificationRequest,
): ManifestVerification {
  const { manifest, manifestHash, inputRevision, received, worker } = request;

  // 1. Version first. Everything below is meaningless until we know we are
  //    reading the same shape the digest was taken over.
  if (manifest.version !== worker.manifestVersion) {
    return {
      ok: false,
      code: 'manifest_version_unsupported',
      detail: `this worker reads manifest version ${worker.manifestVersion}; the Control Plane sent ${manifest.version}`,
      supported: worker.manifestVersion,
      received: manifest.version,
    };
  }

  // 2. Then the digest, so every content check below reads a manifest known
  //    to be the one the Control Plane froze.
  const actual = manifestFingerprint(manifest);
  if (actual !== manifestHash) {
    return {
      ok: false,
      code: 'manifest_hash_mismatch',
      detail: 'the manifest on the command is not the manifest the Control Plane pinned',
      expected: manifestHash,
      actual,
    };
  }

  // 3. Then the boundary. A path is compared as a PATH, not as a string
  //    prefix: `/repo/../etc` and `/repo/application` both start with a legal
  //    root and both are outside it.
  const cwdVerdict = checkCwd(manifest);
  if (cwdVerdict !== null) return cwdVerdict;

  // 4. Then the demands. A named requirement missing refuses; an unnamed
  //    capability missing is skew and is recorded.
  const required = manifest.requiredCapabilities ?? [];
  const missingRequired = required.filter((capability) => !worker.available.includes(capability));
  if (missingRequired.length > 0) {
    const capability = missingRequired[0];
    if (capability === undefined) throw new Error('unreachable: a non-empty filter cannot yield nothing');
    return {
      ok: false,
      code: 'required_capability_unavailable',
      detail: `the manifest requires "${capability}", which this worker does not implement`,
      capability,
    };
  }

  // 5. And last, the input. It is the only check that concerns the TURN rather
  //    than the configuration, so it is the one whose failure means the two
  //    halves of the dispatch disagreed rather than that the manifest was bad.
  const derived = runInputRevision({
    sessionId: received.sessionId,
    prompt: received.prompt,
    options: received.options,
  });
  if (derived !== inputRevision) {
    return {
      ok: false,
      code: 'input_binding_mismatch',
      detail: 'the prompt and options that arrived do not match the input the Control Plane pinned',
      expected: inputRevision,
      actual: derived,
    };
  }

  const optional = [
    ...manifest.capabilities.profiles,
    ...manifest.capabilities.modes,
    ...manifest.capabilities.tools,
  ];
  return {
    ok: true,
    satisfied: [...required],
    unsatisfiedOptional: optional.filter((name) => !worker.available.includes(name)),
    catalogRevision: {
      manifest: null,
      worker: worker.catalogRevision,
      adopted: false,
    },
  };
}

/**
 * `null` when the cwd is acceptable, or the refusal to return.
 *
 * Three separate ways to be illegal, all refusals: a cwd that is not absolute
 * cannot be resolved at all, a cwd outside every root is outside the
 * permission boundary, and a cwd that is not among the roots at all is a claim
 * the manifest makes about itself that nothing else would catch.
 */
function checkCwd(manifest: RunManifest): ManifestRejection | null {
  const cwd = manifest.cwd;
  const roots = manifest.roots;

  const reject = (detail: string): ManifestRejection => ({
    ok: false,
    code: 'cwd_illegal',
    detail,
    cwd,
    roots: [...roots],
  });

  if (typeof cwd !== 'string' || cwd === '') {
    return reject('the manifest has no cwd');
  }
  if (!isAbsolutePath(cwd)) {
    return reject(`cwd "${cwd}" is not an absolute path`);
  }
  if (roots.length === 0) {
    return reject('the manifest declares no roots, so no cwd is permitted');
  }
  // The cwd must BE one of the roots, not merely sit inside one. A run's
  // working directory is a root in the current product (router.ts sends the
  // session cwd as the primary workspace root), and accepting an arbitrary
  // subdirectory would let a manifest claim a narrower root than the one it
  // declared.
  const normalisedCwd = normalise(cwd);
  const matched = roots.some((root) => normalise(root) === normalisedCwd);
  if (!matched) {
    return reject(`cwd "${cwd}" is not one of the declared roots`);
  }
  return null;
}

/**
 * Absolute on the host's own terms.
 *
 * Both separators, because a manifest that names `C:\repo` is legal on the
 * platform that produced it and a POSIX check would refuse it — which would be
 * a refusal for the wrong reason.
 */
function isAbsolutePath(value: string): boolean {
  return value.startsWith('/') || /^[A-Za-z]:[\\/]/.test(value) || value.startsWith('\\\\');
}

/**
 * Resolve `.` and `..` textually and drop the trailing separator.
 *
 * Deliberately NOT a filesystem call. This runs in the worker before any
 * execution, on a manifest that has not been shown to describe this machine,
 * and the question being answered is whether the STRING is inside the
 * boundary. A symlink-aware resolution would answer a different question —
 * whether the path exists here — and would make the check depend on the
 * executor's own filesystem, which is the thing under suspicion.
 */
function normalise(value: string): string {
  const isWindowsAbsolute = /^[A-Za-z]:[\\/]/.test(value);
  const unc = value.startsWith('\\\\');
  const segments = value.split(/[\\/]+/).filter((segment) => segment !== '' && segment !== '.');
  const out: string[] = [];
  for (const segment of segments) {
    if (segment === '..') {
      if (out.length > 0 && out[out.length - 1] !== '..') out.pop();
      else if (!isWindowsAbsolute && !unc) out.push('..');
      continue;
    }
    out.push(segment);
  }
  const joined = out.join('/');
  if (unc) return `//${joined}`;
  if (isWindowsAbsolute) {
    const drive = value.slice(0, 2);
    return `${drive}/${joined}`;
  }
  return `/${joined}`;
}
