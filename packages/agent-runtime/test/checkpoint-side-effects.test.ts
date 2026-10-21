/**
 * D7.1 — the side-effect state machine, and the rule that `unknown` is a third
 * outcome.
 *
 * ## What is being pinned
 *
 * R1.2 already leaned on `danglingToolCalls()`: a tool that started and never
 * reported is left OPEN rather than closed as cancelled, because "nobody knows
 * whether the side effect landed" and "the call did nothing" are different
 * claims. This file takes that one step further and makes the distinction
 * MECHANICAL rather than a comment:
 *
 *  - `unknown` is a member of `ToolAttemptState`, so a value of it typechecks.
 *  - an `unknown` attempt is refused an automatic retry, per the side-effect
 *    class, and the refusal is machine-readable.
 *  - the ONE exception — `idempotent_with_key`, and only once reconciled — is
 *    asserted positively, so a later edit that blocks everything is a failing
 *    test rather than a silently useless recovery.
 *
 * Every test drives the REAL exported functions. There is no stub anywhere in
 * this file, because the rule IS the exported behaviour and a mock of it would
 * prove nothing about the rule.
 */

import { describe, expect, it } from 'vitest';
import {
  CHECKPOINT_SCHEMA_VERSION,
  TERMINAL_ATTEMPT_STATES,
  canAutoRetry,
  checkpointDigest,
  isFenceCurrent,
  isSafeCheckpointPoint,
  nextFence,
  verifyCheckpoint,
  type RecoveryCheckpoint,
  type ToolAttempt,
  type ToolAttemptState,
  type ToolSideEffectClass,
} from '@duya/agent-protocol';

function attempt(over: Partial<ToolAttempt> = {}): ToolAttempt {
  return {
    attemptKey: 'run-1/e2/tc-7',
    runId: 'run-1',
    runEpoch: 2,
    toolCallId: 'tc-7',
    toolName: 'Bash',
    inputDigest: 'sha256:aaaa',
    state: 'unknown',
    sideEffect: 'undeclared',
    ...over,
  };
}

function checkpoint(over: Partial<RecoveryCheckpoint> = {}): RecoveryCheckpoint {
  return {
    schemaVersion: CHECKPOINT_SCHEMA_VERSION,
    runId: 'run-1',
    sessionId: 'sess-1',
    generation: 3,
    runEpoch: 1,
    fence: 1,
    manifestFingerprint: 'fp-1',
    inputRevision: 'rev-1',
    transcript: { throughSeq: 12, messageCount: 4 },
    model: { providerId: 'anthropic', model: 'claude', turnIndex: 2, continuation: 'reconstruct_by_new_attempt' },
    loop: { profileId: null, modeIds: [] },
    budget: { limit: { maxTurns: 8 }, spent: { turns: 2, toolCalls: 1, tokens: 900 } },
    mailbox: { watermark: 0, pending: 0 },
    pendingApprovals: [],
    toolAttempts: [],
    artifactRefs: [],
    envRef: { ref: 'env:session-1', hash: 'sha256:env' },
    capabilities: { deterministic: false },
    ...over,
  };
}

describe('`unknown` is a distinct outcome, not a synonym for `failed`', () => {
  it('is a member of the attempt state machine, and is NOT terminal', () => {
    // The distinction, as a type-level fact. If `unknown` were folded into
    // `failed`, this assignment would still compile — so the load-bearing
    // assertion is the TERMINAL set below, not this one.
    const state: ToolAttemptState = 'unknown';
    expect(state).toBe('unknown');
    expect(TERMINAL_ATTEMPT_STATES.has(state)).toBe(false);
    expect(TERMINAL_ATTEMPT_STATES.has('failed')).toBe(true);
    expect(TERMINAL_ATTEMPT_STATES.has('succeeded')).toBe(true);
  });

  it('an in-flight attempt killed before its outcome is recorded is `unknown`, and the ledger would leave it open', () => {
    // The shape R1.2's `danglingToolCalls` produces: started, never completed.
    // The ledger does not invent `failed` for it, and neither does this.
    const killed = attempt({ state: 'dispatched', sideEffect: 'non_retryable' });
    expect(TERMINAL_ATTEMPT_STATES.has(killed.state)).toBe(false);
    const asUnknown: ToolAttempt = { ...killed, state: 'unknown' };
    expect(asUnknown.state).toBe('unknown');
    expect(canAutoRetry(asUnknown).retry).toBe(false);
  });

  it('refuses an automatic retry for an unknown, with a machine-readable code', () => {
    const verdict = canAutoRetry(attempt({ state: 'unknown', sideEffect: 'non_retryable' }));
    expect(verdict.retry).toBe(false);
    if (verdict.retry) throw new Error('expected a refusal');
    expect(verdict.code).toBe('non_retryable');
  });
});

describe('the retry gate follows the side-effect class, and nothing else', () => {
  const cases: readonly { readonly sideEffect: ToolSideEffectClass; readonly expectRetry: boolean; readonly code: string }[] = [
    // An undeclared tool is treated as unknown and blocked. The SAFE-looking
    // default is deliberately not `read_only`: a field whose job is to prevent
    // a duplicated side effect must fail towards blocking.
    { sideEffect: 'undeclared', expectRetry: false, code: 'undeclared_side_effect' },
    // The author knows their tool; overriding them is the failure D7.1 exists
    // to prevent.
    { sideEffect: 'non_retryable', expectRetry: false, code: 'non_retryable' },
    // Reconcilable is a licence to ASK, not to re-run. Asking the external
    // system is strictly better than repeating the call.
    { sideEffect: 'reconcilable', expectRetry: false, code: 'reconciliation_required' },
    // An unkeyed retry of an idempotent tool is a second effect.
    { sideEffect: 'idempotent_with_key', expectRetry: false, code: 'unknown_side_effect' },
  ];

  it.each(cases)('an unknown $sideEffect attempt is blocked ($code)', (c) => {
    const verdict = canAutoRetry(attempt({ state: 'unknown', sideEffect: c.sideEffect }));
    expect(verdict.retry).toBe(c.expectRetry);
    if (verdict.retry) throw new Error('expected a refusal');
    expect(verdict.code).toBe(c.code);
  });

  it('permits a retry for an idempotent-with-key attempt ONLY once reconciled, and only with a key', () => {
    // The ONE exception, asserted positively. A recovery that cannot use the
    // mechanism designed for this case will be worked around; that workaround
    // has to show up as a red test here instead.
    const reconciled = canAutoRetry(
      attempt({
        state: 'reconciled',
        sideEffect: 'idempotent_with_key',
        idempotencyKey: 'key-abc',
        reconciledBy: 'GET /charges?id=key-abc -> 404',
        detail: 'not-landed',
      }),
    );
    expect(reconciled.retry).toBe(true);
    if (!reconciled.retry) throw new Error('expected a permission');
    expect(reconciled.reason).toMatch(/reconciled/i);
  });

  it('refuses a settled attempt and says so, rather than treating it as fresh work', () => {
    for (const state of ['succeeded', 'failed'] as const) {
      const verdict = canAutoRetry(attempt({ state, sideEffect: 'read_only' }));
      expect(verdict.retry).toBe(false);
      if (verdict.retry) throw new Error('expected a refusal');
      expect(verdict.code).toBe('already_settled');
    }
  });

  it('permits a planned attempt, because a call that never left cannot have had an effect', () => {
    const verdict = canAutoRetry(attempt({ state: 'planned', sideEffect: 'non_retryable' }));
    expect(verdict.retry).toBe(true);
  });

  it('refuses an attempt still in flight — it is not finished, it is concurrent', () => {
    const verdict = canAutoRetry(attempt({ state: 'dispatched', sideEffect: 'read_only' }));
    expect(verdict.retry).toBe(false);
    if (verdict.retry) throw new Error('expected a refusal');
    expect(verdict.code).toBe('not_dispatched');
  });
});

describe('a safe checkpoint point has no unknown side effect in it', () => {
  it('accepts a barrier where every attempt has settled', () => {
    expect(
      isSafeCheckpointPoint([
        attempt({ attemptKey: 'a', state: 'succeeded' }),
        attempt({ attemptKey: 'b', state: 'failed' }),
      ]),
    ).toBe(true);
  });

  it('refuses a boundary that contains an in-flight or unknown attempt', () => {
    // D7.1: `可恢复安全点为没有unknownsideeffect的loop/toolbarrier`. A boundary
    // that includes one of these is not a point the run can be continued from
    // without consulting the ledger, which is the failure this names.
    expect(isSafeCheckpointPoint([attempt({ attemptKey: 'a', state: 'dispatched' })])).toBe(false);
    expect(isSafeCheckpointPoint([attempt({ attemptKey: 'a', state: 'unknown' })])).toBe(false);
  });
});

describe('the checkpoint digest covers the whole payload', () => {
  it('is stable across two structurally identical payloads', () => {
    expect(checkpointDigest(checkpoint())).toBe(checkpointDigest(checkpoint()));
    expect(checkpointDigest(checkpoint())).toMatch(/^[0-9a-f]{64}$/);
  });

  it('changes when the fence changes — a stale token cannot be swapped in under a valid digest', () => {
    const original = checkpoint();
    const tampered = checkpoint({ fence: original.fence + 1 });
    expect(checkpointDigest(tampered)).not.toBe(checkpointDigest(original));
  });

  it('changes when an attempt moves out of `unknown` — the edit that would double an effect', () => {
    const unknown = checkpoint({
      toolAttempts: [attempt({ state: 'unknown', sideEffect: 'non_retryable' })],
    });
    const settled = checkpoint({
      toolAttempts: [attempt({ state: 'succeeded', sideEffect: 'non_retryable' })],
    });
    expect(checkpointDigest(settled)).not.toBe(checkpointDigest(unknown));
  });

  it('changes when the schema version changes, so an old payload cannot validate against a new reader', () => {
    // The digest deliberately includes the version. A reader that skipped it
    // would accept a payload whose fields it does not understand.
    const current = checkpoint();
    const future = { ...current, schemaVersion: 2 as unknown as typeof CHECKPOINT_SCHEMA_VERSION };
    expect(checkpointDigest(future)).not.toBe(checkpointDigest(current));
  });

  it('verifyCheckpoint accepts the honest bytes and refuses edited ones', () => {
    const original = checkpoint();
    const digest = checkpointDigest(original);
    expect(verifyCheckpoint(original, digest)).toEqual({ ok: true });
    const edited = { ...original, fence: 99 };
    const verdict = verifyCheckpoint(edited, digest);
    expect(verdict.ok).toBe(false);
  });

  it('does not change when an undefined-valued optional key is added', () => {
    // Otherwise a round-trip through JSON — which drops undefined — would
    // invalidate every checkpoint, and a store that did that would refuse its
    // own writes.
    const withUndefined = { ...checkpoint(), goalId: undefined };
    expect(checkpointDigest(withUndefined as RecoveryCheckpoint)).toBe(checkpointDigest(checkpoint()));
  });
});

describe('the fence is monotonic, and equality is not staleness', () => {
  it('starts at 1 for a run with no history', () => {
    expect(nextFence([])).toBe(1);
  });

  it('advances past the highest token it has seen, not past the last one', () => {
    // A caller resuming from a STALE local copy would otherwise mint a token
    // that collides with one already committed.
    expect(nextFence([1, 5, 3])).toBe(6);
    expect(nextFence([4])).toBe(5);
  });

  it('accepts a write at the current token, and refuses one below it', () => {
    const incoming = { runId: 'run-1', runEpoch: 2, token: 3 };
    // One attempt writing many times at its own token is the normal case.
    expect(isFenceCurrent(incoming, 3)).toBe(true);
    // A stale attempt is refused, whatever it is trying to write.
    expect(isFenceCurrent({ ...incoming, token: 2 }, 3)).toBe(false);
  });
});
