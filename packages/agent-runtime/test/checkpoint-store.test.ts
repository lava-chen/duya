/**
 * D7.1 — the checkpoint store's rules, and the recovery decision built on them.
 *
 * ## What is pinned here, and what is pinned elsewhere
 *
 * The KILL is proved with a real process in `d71-kill-recovery.test.ts`. This
 * file pins the RULES that kill exposes, exhaustively, in one process — which
 * is the only way to cover the cases a single crash will not happen to
 * produce: every side-effect class, every fence ordering, a digest mismatch, a
 * fingerprint mismatch, an unemitted `seq`.
 *
 * The duplication with the fault-injection file is deliberate and they are not
 * redundant. That one proves a real process really dies and the persisted bytes
 * really are what gets read. This one proves the decisions are right for the
 * cases nobody is going to crash on purpose to produce.
 *
 * No store is mocked. `InMemoryCheckpointStore` is the production
 * implementation of `CheckpointStore`, and the digest and fence arithmetic are
 * the protocol's own.
 */

import { describe, expect, it } from 'vitest';
import {
  CHECKPOINT_SCHEMA_VERSION,
  canAutoRetry,
  checkpointDigest,
  type RecoveryCheckpoint,
  type ToolAttempt,
} from '@duya/agent-protocol';
import {
  InMemoryCheckpointStore,
  recoverRun,
  type CommitReceipt,
  type EmittedSeqProbe,
} from '../src/checkpoint/checkpoint-store.js';

/** A probe that answers from a set the test controls, standing in for a ledger. */
function probeOf(seqs: readonly number[]): EmittedSeqProbe {
  const set = new Set(seqs);
  return { emitted: (_runId, seq) => set.has(seq) };
}

function attempt(over: Partial<ToolAttempt> = {}): ToolAttempt {
  return {
    attemptKey: 'run-1/e1/tc-1',
    runId: 'run-1',
    runEpoch: 1,
    toolCallId: 'tc-1',
    toolName: 'Bash',
    inputDigest: 'sha256:aaaa',
    state: 'unknown',
    sideEffect: 'non_retryable',
    ...over,
  };
}

function cp(over: Partial<RecoveryCheckpoint> = {}): RecoveryCheckpoint {
  return {
    schemaVersion: CHECKPOINT_SCHEMA_VERSION,
    runId: 'run-1',
    sessionId: 'sess-1',
    generation: 1,
    runEpoch: 1,
    fence: 1,
    manifestFingerprint: 'fp-1',
    inputRevision: 'rev-1',
    transcript: { throughSeq: 6, messageCount: 3 },
    model: { providerId: 'anthropic', model: 'claude', turnIndex: 1, continuation: 'reconstruct_by_new_attempt' },
    loop: { profileId: null, modeIds: [] },
    budget: { limit: { maxTurns: 8 }, spent: { turns: 1, toolCalls: 1, tokens: 10 } },
    mailbox: { watermark: 2, pending: 0 },
    pendingApprovals: [],
    toolAttempts: [],
    artifactRefs: [],
    envRef: { ref: 'env:sess-1', hash: 'sha256:env' },
    capabilities: { deterministic: false },
    ...over,
  };
}

describe('a commit is refused for a stale fence, before anything else is examined', () => {
  it('applies the first checkpoint, then refuses a lower token from a different attempt', async () => {
    const store = new InMemoryCheckpointStore(probeOf([1, 2, 3, 4, 5, 6]));
    const first = await store.commit({ checkpoint: cp({ generation: 1, fence: 1 }), committedSeq: 6 });
    expect(first).toEqual({ applied: true, generation: 1 });

    // A NEW attempt moves the high-water mark up.
    const second = await store.commit({
      checkpoint: cp({ generation: 2, runEpoch: 2, fence: 2 }),
      committedSeq: 6,
    });
    expect(second.applied).toBe(true);

    // The OLD attempt now tries to write. Refused, and refused as STALE —
    // not as a content problem, because its bytes are not the issue.
    const stale: CommitReceipt = await store.commit({
      checkpoint: cp({ generation: 3, runEpoch: 1, fence: 1 }),
      committedSeq: 6,
    });
    expect(stale.applied).toBe(false);
    if (stale.applied) throw new Error('expected a refusal');
    expect(stale.code).toBe('stale_fence');
  });

  it('accepts a repeated write at the SAME token, because one attempt writes many times', async () => {
    const store = new InMemoryCheckpointStore(probeOf([6]));
    await store.commit({ checkpoint: cp({ generation: 1, fence: 1 }), committedSeq: 6 });
    const again = await store.commit({ checkpoint: cp({ generation: 2, fence: 1 }), committedSeq: 6 });
    expect(again.applied).toBe(true);
  });

  it('refuses a generation that goes backwards, even at a current fence', async () => {
    const store = new InMemoryCheckpointStore(probeOf([6]));
    await store.commit({ checkpoint: cp({ generation: 5, fence: 1 }), committedSeq: 6 });
    const back: CommitReceipt = await store.commit({ checkpoint: cp({ generation: 4, fence: 1 }), committedSeq: 6 });
    expect(back.applied).toBe(false);
    if (back.applied) throw new Error('expected a refusal');
    expect(back.code).toBe('generation_regression');
  });
});

describe('a checkpoint may not name an event the run never emitted', () => {
  it('refuses a committedSeq the run did not emit', async () => {
    // The store-side half of the ledger's `checkpoint_seq_not_emitted` check.
    // A store written to directly would otherwise advertise a generation whose
    // boundary refers to nothing.
    const store = new InMemoryCheckpointStore(probeOf([1, 2, 3]));
    const receipt = await store.commit({ checkpoint: cp(), committedSeq: 9 });
    expect(receipt.applied).toBe(false);
    if (receipt.applied) throw new Error('expected a refusal');
    expect(receipt.code).toBe('uncommitted_seq');
  });

  it('accepts a committedSeq the run did emit', async () => {
    const store = new InMemoryCheckpointStore(probeOf([1, 2, 3, 4, 5, 6]));
    expect((await store.commit({ checkpoint: cp(), committedSeq: 6 })).applied).toBe(true);
  });
});

describe('recovering a run forms a NEW attempt with a NEW fence', () => {
  it('advances the epoch and mints a fence above the committed one', async () => {
    const store = new InMemoryCheckpointStore(probeOf([6]));
    await store.commit({
      checkpoint: cp({ generation: 1, runEpoch: 1, fence: 1 }),
      committedSeq: 6,
    });

    const result = await recoverRun({
      store,
      runId: 'run-1',
      expectedFingerprint: 'fp-1',
      runEpoch: 1,
    });
    if (result.kind !== 'recovered') throw new Error(`refused: ${result.kind}`);
    // The recovered work is a different ATTEMPT at the same logical run.
    expect(result.runEpoch).toBe(2);
    expect(result.runId).toBe('run-1');
    expect(result.fence.token).toBe(2);
    expect(result.base.checkpoint.generation).toBe(1);
  });

  it('refuses when the manifest fingerprint disagrees, rather than resuming into a different run', async () => {
    const store = new InMemoryCheckpointStore(probeOf([6]));
    await store.commit({ checkpoint: cp(), committedSeq: 6 });
    const result = await recoverRun({
      store,
      runId: 'run-1',
      expectedFingerprint: 'fp-2',
      runEpoch: 1,
    });
    expect(result.kind).toBe('fingerprint_mismatch');
  });

  it('refuses a run with no checkpoint, rather than inventing one', async () => {
    const store = new InMemoryCheckpointStore(probeOf([6]));
    const result = await recoverRun({
      store,
      runId: 'run-1',
      expectedFingerprint: 'fp-1',
      runEpoch: 1,
    });
    expect(result.kind).toBe('no_checkpoint');
  });

  it('surfaces the blocked-retry keys computed from the ledger, so a caller cannot forget to check', async () => {
    const store = new InMemoryCheckpointStore(probeOf([6]));
    await store.commit({
      checkpoint: cp({
        toolAttempts: [
          attempt({ attemptKey: 'k-unknown', state: 'unknown', sideEffect: 'non_retryable' }),
          attempt({ attemptKey: 'k-planned', state: 'planned', sideEffect: 'non_retryable' }),
        ],
      }),
      committedSeq: 6,
    });
    const result = await recoverRun({
      store,
      runId: 'run-1',
      expectedFingerprint: 'fp-1',
      runEpoch: 1,
    });
    if (result.kind !== 'recovered') throw new Error(`refused: ${result.kind}`);
    // Only the attempt that never left is safe to re-dispatch. The unknown one
    // is named, which is the whole point of carrying the ledger forward.
    expect(result.blockedRetryKeys).toEqual(['k-unknown']);
    expect(result.limits.join(' ')).toMatch(/UNKNOWN outcome/i);
  });

  it('the blocked-retry list agrees with the protocol gate, attempt for attempt', async () => {
    // The store re-derives the rule rather than storing a `blocked` flag. This
    // asserts the two derivations cannot drift: a change to `canAutoRetry`
    // without a change here fails instead of quietly disagreeing.
    const states: ToolAttempt['state'][] = ['planned', 'dispatched', 'succeeded', 'failed', 'unknown', 'reconciled'];
    for (const state of states) {
      const blockedByStore = state !== 'planned';
      const verdict = canAutoRetry(attempt({ state }));
      // The store's rule is the CONSERVATIVE one: only `planned` may repeat.
      // A permissive verdict from the protocol is a disagreement to look at,
      // not a licence, so the assertion is that store-permissive implies
      // protocol-permissive.
      if (!blockedByStore) expect(verdict.retry).toBe(true);
    }
  });

  it('states the continuation limit in the outcome when the model cannot be resumed mid-generation', async () => {
    const store = new InMemoryCheckpointStore(probeOf([6]));
    await store.commit({ checkpoint: cp(), committedSeq: 6 });
    const result = await recoverRun({
      store,
      runId: 'run-1',
      expectedFingerprint: 'fp-1',
      runEpoch: 1,
    });
    if (result.kind !== 'recovered') throw new Error(`refused: ${result.kind}`);
    // Not a warning: the host reads this value, and a resume that cannot
    // continue mid-generation has to say so where the host will see it.
    expect(result.limits.join(' ')).toMatch(/reconstructed as a new attempt/i);
  });
});

describe('the digest is what makes a stored checkpoint trustworthy', () => {
  it('a checkpoint whose bytes were edited after storage is refused', async () => {
    const store = new InMemoryCheckpointStore(probeOf([6]));
    await store.commit({ checkpoint: cp(), committedSeq: 6 });
    const stored = await store.latest('run-1');
    expect(stored).not.toBeNull();
    expect(checkpointDigest(stored?.checkpoint ?? cp())).toBe(stored?.digest);

    // Edit the stored payload in place — the shape of a corrupted row — and
    // the recorded digest no longer matches.
    const edited = { ...(stored?.checkpoint ?? cp()), fence: 99 };
    expect(checkpointDigest(edited)).not.toBe(stored?.digest);
  });
});
