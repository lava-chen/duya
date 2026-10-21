/**
 * One place that decides what a turn's `runId` is.
 *
 * ## Why this is extracted from `DuyaAgent.streamChat`
 *
 * `streamChat` used to call `crypto.randomUUID()` inline, at the top of a
 * 3,500-line generator, and use it for exactly one thing: the `runId` handed to
 * `mailboxDb.claimBatch` so a claimed notification row is attributed to the run
 * that absorbed it. There was no seam there, so no test could reach the value
 * and no host could supply one.
 *
 * Plan 587 R2.1 puts the canonical run id on the `chat:start` command, minted
 * once by the Control Plane's start entry. A turn that arrives WITH one must
 * use it, or the mailbox attributes claims to a second identity that no
 * `runs` row knows about — which is the exact "competing run identity" problem
 * §B forbids.
 *
 * ## The shim, and when it can go
 *
 * `canonical: false` means "this turn had no run id and one was minted here".
 * It exists only because the non-Desktop producers (automation, the workflow
 * runtime, the sub-agent tool) still issue `chat:start` without one, and they
 * are registered for H8 — out of scope for the Desktop-chat-only first PR.
 *
 * **Removal condition:** when every registered producer in
 * `NON_DESKTOP_CONSUMERS` supplies a canonical `runId`, `canonical` is
 * `false`-free and the fallback can be deleted. Until then it stays a named,
 * reported fallback rather than a silent second identity.
 */

import { randomUUID } from 'node:crypto';

/** The run identity a turn executes under, and where it came from. */
export interface TurnRunIdentity {
  readonly runId: string;
  /**
   * True when the id was the one the Control Plane minted for this turn.
   *
   * Read by tests and by logs, never branched on for behaviour: a turn must run
   * either way. It exists so "the legacy agent minted its own id" is COUNTABLE
   * rather than something a reviewer has to notice.
   */
  readonly canonical: boolean;
}

/**
 * Resolve the run identity for one turn.
 *
 * An empty string is treated as absent, not as an id. A producer that sends
 * `runId: ''` has told us nothing, and minting a real one behind it would be
 * the second identity this function exists to prevent.
 */
export function resolveTurnRunId(canonical: string | undefined): TurnRunIdentity {
  if (typeof canonical === 'string' && canonical !== '') {
    return { runId: canonical, canonical: true };
  }
  return { runId: randomUUID(), canonical: false };
}
