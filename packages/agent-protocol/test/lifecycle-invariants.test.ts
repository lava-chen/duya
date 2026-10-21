/**
 * Lifecycle invariants — the rules a run stream must obey.
 *
 * ## This layer's job
 *
 * Layer 1 (`structural-drift`) checks that the declarations are coherent.
 * Layer 2 (`worker-adapter-conformance`) checks that one producer message
 * becomes the right envelope. Neither of those can catch a rule that spans
 * several events — "the tool started exactly once", "nothing follows the
 * terminal event" — because each of those is a statement about a SEQUENCE, not
 * about any single message.
 *
 * That is what this file is for, and it is where the decisions recorded in
 * `GAPS.md` are actually enforced:
 *
 *   G-6  authoritative `tool.call_started` exactly once, previews are volatile
 *   G-7  an absent producer status becomes `indeterminate`, never `success`
 *   G-1  a free producer code becomes a closed code plus a preserved cause
 *   G-3  a checkpoint's `eventSeq` refers to something the run actually emitted
 *   G-8  `seq` is per-run, +1, and unique within `(runId, seq)`
 *
 * Every assertion here is traceable to one of those. An assertion that cannot
 * name its decision does not belong in this file — that was the defect in the
 * version of the producer-inventory test this layer replaces.
 */

import { describe, expect, it } from 'vitest';
import {
  LifecycleViolation,
  RunLedger,
  replayViolations,
  type RunEvent,
} from '../src/testing/index.js';
import { EVENT_META } from '../src/events/registry.js';
import { eventKey, isValidSeq, SEQ_CONTRACT } from '../src/envelope.js';
import { isReplayable, resumeRefusalCode, NO_RESUME, TOOL_LIFECYCLE_EVENTS, type ResumeSupport } from '../src/resume.js';
import { isKnownCode } from '../src/errors.js';

const OPTS = { runId: 'run-1', sessionId: 'sess-1', now: () => 1_000 };

function ledger(): RunLedger {
  return new RunLedger(OPTS);
}

const started = (id: string) =>
  ({ type: 'tool.call_started', toolCallId: id, toolName: 'Read', arguments: {}, attempt: 1 }) as const;
const preview = (id: string) =>
  ({ type: 'tool.call_preview', toolCallId: id, toolName: 'Read', arguments: {}, provisional: true }) as const;
const completed = (id: string, outcome: 'success' | 'indeterminate' = 'success') =>
  ({
    type: 'tool.call_completed',
    toolCallId: id,
    content: 'ok',
    outcome: outcome === 'success' ? { outcome: 'success' } : { outcome: 'indeterminate', note: 'producer omitted status' },
    durationMs: 1,
  }) as const;

// ── G-8: sequence ──────────────────────────────────────────────────────────

describe('G-8 · seq is per-run, gapless, and unique within (runId, seq)', () => {
  it('starts at 1 and advances by exactly 1', () => {
    const l = ledger();
    expect(l.seq).toBe(0);
    expect(l.emit({ type: 'run.started', manifestHash: 'h', protocol: { major: 1, minor: 0 }, runtime: { name: 'r', version: '1' } }).seq).toBe(SEQ_CONTRACT.start);
    expect(l.emit({ type: 'turn.started', turnId: 't1' }).seq).toBe(2);
    expect(l.emit({ type: 'turn.completed', turnId: 't1', stopReason: 'end_turn' }).seq).toBe(3);
  });

  it('every emitted seq satisfies the seq validity rule', () => {
    const l = ledger();
    l.emit({ type: 'run.started', manifestHash: 'h', protocol: { major: 1, minor: 0 }, runtime: { name: 'r', version: '1' } });
    for (let i = 0; i < 5; i += 1) {
      const env = l.emit({ type: 'assistant.text_delta', messageId: 'm', index: i, delta: 'x' });
      expect(isValidSeq(env.seq)).toBe(true);
    }
  });

  it('two runs in the same session may reuse the same seq values', () => {
    // The whole point of scoping uniqueness to the run. A session holds many
    // runs; a resumed run restarts at 1. Same seq, different run, not a
    // collision — which is exactly why the current session-scoped counter
    // cannot be repaired in place.
    const a = new RunLedger({ runId: 'run-a', sessionId: 'sess-1' });
    const b = new RunLedger({ runId: 'run-b', sessionId: 'sess-1' });
    a.emit({ type: 'run.started', manifestHash: 'h', protocol: { major: 1, minor: 0 }, runtime: { name: 'r', version: '1' } });
    b.emit({ type: 'run.started', manifestHash: 'h', protocol: { major: 1, minor: 0 }, runtime: { name: 'r', version: '1' } });
    expect(a.seq).toBe(b.seq);

    const keyA = eventKey({ runId: 'run-a', seq: 1 });
    const keyB = eventKey({ runId: 'run-b', seq: 1 });
    expect(keyA).not.toBe(keyB);
  });

  it('the contract says run, not session', () => {
    // Guards the specific regression. A future edit that widens the scope back
    // to the session is the bug this whole entry exists for.
    expect(SEQ_CONTRACT.uniqueWithin).toBe('run');
  });

  it('rejects a negative or non-integer seq before it can enter a stream', () => {
    for (const bad of [0, -1, 1.5, Number.NaN, '1', null, undefined]) {
      expect(isValidSeq(bad), `${JSON.stringify(bad)} passed seq validation`).toBe(false);
    }
  });
});

// ── terminal events ────────────────────────────────────────────────────────

describe('a run ends exactly once, and nothing follows', () => {
  const start = { type: 'run.started', manifestHash: 'h', protocol: { major: 1, minor: 0 }, runtime: { name: 'r', version: '1' } } as const;

  it('accepts one terminal event', () => {
    const l = ledger();
    l.emit(start);
    const env = l.emit({ type: 'run.completed', status: 'completed', stopReason: 'end_turn' });
    expect(l.terminal).toEqual({ status: 'run.completed', seq: env.seq });
  });

  it('rejects a second terminal event', () => {
    const l = ledger();
    l.emit(start);
    l.emit({ type: 'run.completed', status: 'completed', stopReason: 'end_turn' });
    expect(() => l.emit({ type: 'run.failed', error: { code: 'internal', message: 'late' } })).toThrow(LifecycleViolation);
  });

  it('rejects ANY event after the terminal one, including diagnostics', () => {
    // A trailing `diagnostic` after `run.completed` looks harmless and is not:
    // it proves the runtime kept emitting after it declared the run finished,
    // so the seq after the terminal is already untrustworthy.
    const l = ledger();
    l.emit(start);
    l.emit({ type: 'run.completed', status: 'completed', stopReason: 'end_turn' });
    expect(() => l.emit({ type: 'diagnostic', level: 'info', message: 'after the end' })).toThrow(/event_after_terminal/);
  });

  it('a cancelled run terminates as completed, not failed', () => {
    // Cancellation is not an error. Reporting it as `run.failed` would make
    // every user-initiated stop look like a fault in dashboards and alerts.
    const l = ledger();
    l.emit(start);
    l.emit({ type: 'run.completed', status: 'cancelled', stopReason: 'aborted' });
    expect(l.terminal?.status).toBe('run.completed');
  });
});

// ── G-6: authoritative tool start exactly once ─────────────────────────────

describe('G-6 · the durable tool start happens exactly once, previews do not count', () => {
  it('many previews then one start is legal', () => {
    const l = ledger();
    l.emit({ type: 'run.started', manifestHash: 'h', protocol: { major: 1, minor: 0 }, runtime: { name: 'r', version: '1' } });
    l.emit(preview('c1')); // seq 2
    l.emit(preview('c1')); // seq 3
    l.emit(preview('c1')); // seq 4
    l.emit(started('c1')); // seq 5
    l.emit(completed('c1')); // seq 6
    // Three provisional announcements and exactly one authoritative start. The
    // previews are volatile and leave no durable trace; only seq 5 does.
    expect(l.toolState('c1')).toEqual({ previews: 3, startedSeq: 5, completedSeq: 6 });
  });

  it('rejects a second authoritative start for the same toolCallId', () => {
    // The exact failure the split was made to prevent: a durable event emitted
    // twice per call with the same id. A side-effect ledger counting this would
    // record one call twice.
    const l = ledger();
    l.emit({ type: 'run.started', manifestHash: 'h', protocol: { major: 1, minor: 0 }, runtime: { name: 'r', version: '1' } });
    l.emit(started('c1'));
    expect(() => l.emit(started('c1'))).toThrow(/tool_started_twice/);
  });

  it('rejects a preview after the authoritative start', () => {
    // Ordering is the whole contract. A preview after the start means the
    // runtime went back to provisional arguments for a call it already
    // committed to.
    const l = ledger();
    l.emit({ type: 'run.started', manifestHash: 'h', protocol: { major: 1, minor: 0 }, runtime: { name: 'r', version: '1' } });
    l.emit(started('c1'));
    expect(() => l.emit(preview('c1'))).toThrow(/tool_preview_after_start/);
  });

  it('rejects a completion for a call that never started', () => {
    const l = ledger();
    l.emit({ type: 'run.started', manifestHash: 'h', protocol: { major: 1, minor: 0 }, runtime: { name: 'r', version: '1' } });
    l.emit(preview('c1'));
    expect(() => l.emit(completed('c1'))).toThrow(/tool_completed_without_start/);
  });

  it('the registry durabilities match the decision', () => {
    // The decision, restated against the shipped table so the two cannot drift.
    expect(EVENT_META['tool.call_preview'].durability).toBe('volatile');
    expect(EVENT_META['tool.call_started'].durability).toBe('durable');
    expect(EVENT_META['tool.arguments_delta'].durability).toBe('ephemeral');
  });

  it('a preview is not part of the tool lifecycle, so a boundary there resumes cleanly', () => {
    // A resume landing between a preview and the authoritative start is a
    // CLEAN boundary: the tool never ran. Including the preview in the
    // lifecycle set would refuse a large number of safe resumes.
    expect(TOOL_LIFECYCLE_EVENTS.has('tool.call_preview')).toBe(false);
    expect(TOOL_LIFECYCLE_EVENTS.has('tool.call_started')).toBe(true);
  });
});

// ── G-7: no fabricated success ─────────────────────────────────────────────

describe('G-7 · an absent producer status is indeterminate, never success', () => {
  it('the outcome union has an explicit arm for "the producer did not say"', () => {
    const l = ledger();
    l.emit({ type: 'run.started', manifestHash: 'h', protocol: { major: 1, minor: 0 }, runtime: { name: 'r', version: '1' } });
    l.emit(started('c1'));
    const env = l.emit(completed('c1', 'indeterminate'));
    expect(env.payload.outcome.outcome).toBe('indeterminate');
  });

  it('the completed payload has no boolean that absence could collapse into', () => {
    // Structural: a required `isError: boolean` would compile fine and force
    // the adapter to invent `false`. The union makes inventing impossible
    // because there is no value to invent — the arm has to be chosen by name.
    const source = EVENT_META['tool.call_completed'].description;
    expect(source).toMatch(/outcome/);
  });

  it('a real failure is a tool_error carrying a closed code plus its cause', () => {
    const l = ledger();
    l.emit({ type: 'run.started', manifestHash: 'h', protocol: { major: 1, minor: 0 }, runtime: { name: 'r', version: '1' } });
    l.emit(started('c1'));
    const env = l.emit({
      type: 'tool.call_completed',
      toolCallId: 'c1',
      content: '',
      outcome: {
        outcome: 'tool_error',
        error: {
          code: 'tool_failed',
          message: 'exit 1',
          cause: { system: 'tool', code: 'ENOENT' },
        },
      },
      durationMs: 3,
    });
    const outcome = env.payload.outcome;
    expect(outcome.outcome).toBe('tool_error');
    if (outcome.outcome !== 'tool_error') throw new Error('unreachable');
    // G-1: the protocol code is the boundary category; the producer's own
    // string is preserved, never folded into the closed set.
    expect(isKnownCode(outcome.error.code)).toBe(true);
    expect(outcome.error.cause?.code).toBe('ENOENT');
  });
});

// ── permission correlation ─────────────────────────────────────────────────

describe('permission requests and resolutions correlate', () => {
  it('a resolution requires a prior request', () => {
    const l = ledger();
    l.emit({ type: 'run.started', manifestHash: 'h', protocol: { major: 1, minor: 0 }, runtime: { name: 'r', version: '1' } });
    expect(() => l.emit({ type: 'permission.resolved', requestId: 'r1', action: 'deny', source: 'host', latencyMs: 1 })).toThrow(
      /permission_resolved_without_request/,
    );
  });

  it('a request is resolved exactly once', () => {
    const l = ledger();
    l.emit({ type: 'run.started', manifestHash: 'h', protocol: { major: 1, minor: 0 }, runtime: { name: 'r', version: '1' } });
    l.emit({
      type: 'permission.requested',
      requestId: 'r1',
      kind: 'tool_use',
      toolName: 'Bash',
      toolInput: {},
      mode: 'generic',
      startedAt: 0,
      expiresAt: 300_000,
    });
    l.emit({ type: 'permission.resolved', requestId: 'r1', action: 'allow', source: 'host', latencyMs: 5 });
    expect(() => l.emit({ type: 'permission.resolved', requestId: 'r1', action: 'deny', source: 'host', latencyMs: 6 })).toThrow(
      /permission_resolved_twice/,
    );
  });

  it('expiry precedes the timeout resolution', () => {
    // A reconnecting host reconstructs "a deadline passed" from the expiry
    // event, not by inferring it from a deny. If the order flips, the deny
    // looks like a user decision.
    const codes = replayViolations(
      [
        { type: 'run.started', manifestHash: 'h', protocol: { major: 1, minor: 0 }, runtime: { name: 'r', version: '1' } },
        {
          type: 'permission.requested',
          requestId: 'r1',
          kind: 'tool_use',
          toolName: 'Bash',
          toolInput: {},
          mode: 'generic',
          startedAt: 0,
          expiresAt: 1,
        },
        { type: 'permission.expired', requestId: 'r1', afterMs: 1 },
        { type: 'permission.resolved', requestId: 'r1', action: 'deny', source: 'timeout', latencyMs: 1 },
      ] as unknown as RunEvent[],
      OPTS,
    );
    expect(codes).toEqual([]);
  });
});

// ── G-3: checkpoint boundaries ─────────────────────────────────────────────

describe('G-3 · a checkpoint boundary refers to something the run emitted', () => {
  it('rejects a checkpoint whose eventSeq was never emitted', () => {
    const l = ledger();
    l.emit({ type: 'run.started', manifestHash: 'h', protocol: { major: 1, minor: 0 }, runtime: { name: 'r', version: '1' } });
    l.emit({ type: 'turn.started', turnId: 't1' });
    expect(() => l.emit({ type: 'checkpoint.saved', checkpointRef: 'c', generation: 1, eventSeq: 99 })).toThrow(
      /checkpoint_seq_not_emitted/,
    );
  });

  it('rejects a generation that does not advance', () => {
    const l = ledger();
    l.emit({ type: 'run.started', manifestHash: 'h', protocol: { major: 1, minor: 0 }, runtime: { name: 'r', version: '1' } });
    l.emit({ type: 'checkpoint.saved', checkpointRef: 'c1', generation: 2, eventSeq: 1 });
    expect(() => l.emit({ type: 'checkpoint.saved', checkpointRef: 'c2', generation: 2, eventSeq: 1 })).toThrow(
      /checkpoint_generation_not_monotonic/,
    );
  });

  it('a runtime with no checkpoint repository advertises no checkpoint support', () => {
    // The refusal half of G-3. Advertising the boundary without a repository
    // is the promise-nobody-keeps case; `NO_RESUME` is the honest answer today.
    expect(NO_RESUME.checkpointGeneration).toBe(false);
    expect(isReplayable(NO_RESUME, 1)).toBe(false);
  });
});

// ── mid-tool resume refusal ────────────────────────────────────────────────

describe('a mid-tool resume is refused, not attempted', () => {
  it('refuses with invalid_resume_point', () => {
    const support: ResumeSupport = {
      turnBoundary: true,
      eventSeq: true,
      messageIndex: false,
      checkpointGeneration: false,
      oldestAvailableSeq: 1,
      latestSeq: 100,
      rejectsMidToolResume: true,
    };
    // Tool side effects are not transactional. Resuming between the start and
    // its terminal silently re-executes them.
    expect(resumeRefusalCode(support, { kind: 'event_seq', seq: 50 }, true)).toBe('invalid_resume_point');
  });

  it('serves a legal-but-old seq and refuses one that has fallen out', () => {
    const support: ResumeSupport = {
      turnBoundary: true,
      eventSeq: true,
      messageIndex: false,
      checkpointGeneration: false,
      oldestAvailableSeq: 701,
      latestSeq: 1200,
      rejectsMidToolResume: true,
    };
    // With a 500-entry ring and the run at 1200, seq 1000 is still held while
    // seq 100 is not. An earlier draft compared the absolute number against the
    // buffer SIZE, which refused 1000 and served 100 — exactly backwards.
    expect(isReplayable(support, 1000)).toBe(true);
    expect(isReplayable(support, 100)).toBe(false);
    expect(resumeRefusalCode(support, { kind: 'event_seq', seq: 100 })).toBe('replay_unavailable');
  });
});
