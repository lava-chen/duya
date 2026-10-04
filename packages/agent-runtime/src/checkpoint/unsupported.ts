/**
 * What D7.1 did NOT build, named in code.
 *
 * ## Why this file exists
 *
 * Contract §G: `默认pause/resume/determinism unsupported直到D7验收`. D7.1 is a
 * slice of D7, not D7. The slice added the state machine a recovery reads and
 * the rules it must apply — and proved a real process really can be killed and
 * really does leave a recoverable, honest record behind.
 *
 * None of that is the capability. Execution resume is still refused by
 * `probeRuntimeCapabilities` (it returns the protocol's own `NO_RESUME`), and
 * nothing in this slice changed that. The risk this file addresses is the one a
 * green test run creates: a reader — or a later commit — seeing a checkpoint
 * store, a fence, a `parentRunId` branch and a passing kill-recovery test, and
 * concluding the product can resume a run.
 *
 * It cannot. So the gap is enumerated here, where a test can read it, rather
 * than only in a report nobody opens before enabling the feature.
 *
 * ## The test that holds this honest
 *
 * `checkpoint-unsupported.test.ts` asserts each entry below is still refused
 * by the real probe. Flipping `resume.checkpointGeneration` to `true` — one
 * word — fails that test, which is the point. Turning the capability on has to
 * delete a name here and say why in the commit that does it, not happen as a
 * side effect of somebody tidying a type.
 */

/**
 * Capabilities that remain UNSUPPORTED after D7.1, each with the reason it is
 * still refused and what would have to be true to change that.
 *
 * `blocks` names the exact probe field or requirement a host would use, so a
 * reader can check the refusal rather than take this file's word for it.
 */
export interface UnsupportedCapability {
  readonly name: string;
  /** The probe field that reads `false`, or the requirement it refuses. */
  readonly blocks: string;
  /** Why it is still refused. */
  readonly reason: string;
  /** What would have to be proved. */
  readonly unblockedBy: string;
}

export const UNSUPPORTED_AFTER_D71: readonly UnsupportedCapability[] = [
  {
    name: 'execution_resume',
    blocks: 'run.resume.* (all four boundaries) / CapabilityRequirement.needsCheckpointResume',
    reason:
      'D7.1 built the checkpoint SCHEMA, the side-effect ledger and the fence, and proved a real kill leaves a recoverable record. ' +
      'It did not build the thing that reads that record and continues execution: no provider adapter can resume mid-generation, ' +
      'no approval is re-evaluated on resume, and no budget accounting carries across an attempt yet. ' +
      'The probe still returns the protocol own NO_RESUME, so a host requiring resume gets capability_unsupported rather than a resume that quietly does nothing.',
    unblockedBy:
      'D7.3: resume must re-validate schema/hash/roots/tool versions and return a typed reason on mismatch; ' +
      'host revocations must be re-evaluated rather than restored; budget must accumulate across attempts; ' +
      'and unknown tool outcomes must have a reconciliation entry point. The fault-injection matrix must pass for every supported tool class.',
  },
  {
    name: 'pause',
    blocks: 'run.pause / CapabilityRequirement.needsPause',
    reason:
      'Pause needs a safe point to stop at, and D7.1 is what makes one identifiable (isSafeCheckpointPoint: no dispatched or unknown attempt). ' +
      'Identifying the point is not the same as being able to freeze there — no executor suspend path exists, and a pause that accepted a request ' +
      'while a tool was in flight would be a promise the run cannot keep.',
    unblockedBy:
      'A cooperative suspend in the executor that halts at a declared safe point, plus the fault-matrix row proving a paused run resumes to the same point.',
  },
  {
    name: 'determinism',
    blocks: 'run.deterministic',
    reason:
      'A model provider is outside this code control, so determinism is not a capability this side of the boundary can honestly claim. ' +
      'A checkpoint makes a run REPEATABLE in its bookkeeping, which is a different and much weaker claim than reproducing the same tokens.',
    unblockedBy:
      'Nothing in this codebase. It would require a provider-side guarantee, and a capability that says true would be a claim about a system this code does not govern.',
  },
  {
    name: 'file_pre_image_rewind',
    blocks: 'not a capability — deliberately not reachable through a checkpoint',
    reason:
      'Contract §G: 文件pre-image rewind是另一功能，不能代替它. A checkpoint carries what a run needs to CONTINUE (model, context, transcript position, ' +
      'mailbox watermark, tool state, permission index) and points AT artefacts by reference. It does not embed file contents, and adding that ' +
      'would make two mechanisms unable to disagree about the same file.',
    unblockedBy:
      'The pre-image mechanism, which already exists. This is a statement that the two stay separate, not a gap in either.',
  },
  {
    name: 'exactly_once_external_api',
    blocks: 'not a capability — never to be advertised as one',
    reason:
      'Contract §G: 任意外部API不承诺exactly-once. D7.1 makes an unknown outcome VISIBLE and blocks the automatic retry that would double it. ' +
      'That is the honest limit: a recovery can decline to act, and can ask an idempotency key to collapse a repeat, but it cannot make a third-party ' +
      'effect happen exactly once.',
    unblockedBy:
      'Nothing available. A broker or reconciler narrows the window; it does not close it. This row exists so a future change cannot quietly imply otherwise.',
  },
];

/**
 * What D7.1 DID build, so the two lists are read together.
 *
 * Present because a reader who sees only the unsupported list would
 * under-estimate the slice, and one who sees only this list would
 * over-estimate the product. Both are wrong; the pair is the truth.
 */
export const SUPPORTED_AFTER_D71: readonly string[] = [
  'a versioned, digested checkpoint payload (schemaVersion 1) covering manifest/input revision, transcript position, model+loop state, budget, mailbox watermark, pending approvals, the tool-attempt ledger, artefact REFERENCES, and an env REFERENCE',
  'the side-effect ledger: planned -> dispatched -> succeeded|failed|unknown -> reconciled, with a per-tool side-effect class and a machine-readable retry verdict',
  'unknown as a distinct outcome from failed, blocking automatic retry',
  'a monotonic fence, checked at the store on every write, refusing a stale attempt',
  'kill-and-restart recovery proved by fault injection against a real killed process and a real SQLite file',
  'a user branch as a NEW run carrying a parentRunId, renumbered into its own seq space, leaving the original byte-identical',
];

/** For a host that wants the short form: what to render when a resume is refused. */
export function unsupportedSummary(): string {
  return UNSUPPORTED_AFTER_D71.map((u) => `${u.name}: ${u.reason}`).join('\n');
}
