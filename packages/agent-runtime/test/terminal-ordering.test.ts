/**
 * The order of the last two writes in a run: the close of an unanswered tool
 * call, and the run's terminal.
 *
 * ## What this file exists to pin
 *
 * A run that DECLARES its ending -- the engine proposing `run.completed` and the
 * host publishing it through the emitter -- used to deadlock. The engine had to
 * publish a terminal, because `resolveRunOutcome` reads terminal EVENTS and a
 * run with none is `IMPLICIT_CRASH` (`run-outcome.ts:90`), so a clean run was
 * recorded `failed`/`runtime_crash`. And it could not publish one, because
 * `RunSession.observe` closed dangling tool calls ahead of the verdict and that
 * close writes through the ledger, which refuses every write after a terminal:
 * the throw escaped `settle`, so `RunController.settle` never reached
 * `publishCommittedTerminal` and the run's ending was never announced at all.
 *
 * The fix is an ordering, not a relaxation: `observe` closes whatever is open
 * BEFORE it mints a terminal, so the close lands at the seq below the terminal
 * and the terminal then takes effect. These tests drive that ordering end to
 * end and check the three things it must not cost:
 *
 *  1. the terminal is still HELD -- persisted, numbered, and announced to
 *     nobody -- until the durable barrier answers;
 *  2. a barrier that DISAGREES still discards it, and announces nothing;
 *  3. a run that declared no terminal at all still synthesises one, at settle,
 *     which is the arm nothing here changed.
 *
 * ## Declaring is a separate step, and it has to be
 *
 * The engine only PROPOSES; publishing its candidate is the host adapter's job
 * (`run-engine-ports.ts`). The harness keeps those two apart so a test can read
 * the run's state on either side of the declaration -- and the interesting
 * assertion here is exactly that: the same call is open before the terminal is
 * published and answered after it.
 *
 * ## The two sides are read separately throughout
 *
 * ANNOUNCED is what a consumer iterating the stream received. RECORDED is what
 * persistence was handed. "Held" is the difference between the two, so an
 * assertion that compared one side against the other would prove nothing.
 *
 * ## What no test here proves
 *
 * No provider key and no Electron renderer exist in this environment, so
 * nothing here shows a real socket dying mid-tool-call. What is measured is
 * that a run whose executor never answered still closes its transcript
 * honestly, and still announces its ending exactly once.
 */

import { describe, expect, it } from 'vitest';
import { RunEngineImpl } from '../src/engine/run-engine.js';
import type {
  ApprovalVerdict,
  AssembledTurn,
  ModelFrame,
  ModelRequest,
  RunEnginePorts,
  RunEventStorePort,
  TerminalCandidate,
  ToolCallRequest,
  ToolDrainItem,
} from '../src/engine/ports.js';
import { RunEventEmitter } from '../src/events/event-emitter.js';
import type { EmitResult } from '../src/events/event-emitter.js';
import { RunSession } from '../src/run-session.js';
import type { RunEvent, RunEventEnvelope, RunMetrics, RunTerminalState } from '@duya/agent-protocol';

const RUN_ID = 'run-order-1';

const MANIFEST = {
  runId: RUN_ID,
  workspace: '/tmp',
  tools: [],
  systemPrompt: 'test',
  model: 'test-model',
  providerId: 'test-provider',
  apiFormat: 'anthropic',
} as unknown as Parameters<RunEngineImpl['execute']>[0]['manifest'];

const INPUT = {
  revision: 'rev-1',
  prompt: { role: 'user', id: 'p1', content: 'go' },
  history: { kind: 'inline', value: [] },
  attachments: { kind: 'inline', value: [] },
  catalog: { kind: 'by_ref', digest: 'd1', locator: 'catalog://1' },
  steering: [],
  options: {},
} as unknown as Parameters<RunEngineImpl['execute']>[0]['input'];

const READ_CALL: ToolCallRequest = {
  callId: 'call-order-1',
  name: 'Read',
  input: { path: 'a.txt' },
  sideEffect: 'read_only',
} as unknown as ToolCallRequest;

interface HarnessOptions {
  /** Turn 1 dispatches `READ_CALL`; this is what the drain answers with. */
  readonly batch?: readonly ToolDrainItem[];
  /** Refuse every `persistence.complete`, so the barrier answers differently. */
  readonly failBarrier?: boolean;
}

interface Harness {
  /**
   * Every envelope handed to durable persistence, in write order.
   *
   * Awaited, because a durable event is queued by `observe` and written by the
   * flush behind it: reading `appended` straight after an emit is reading a
   * race, not a transcript.
   */
  durable(): Promise<readonly RunEventEnvelope[]>;
  /** Every envelope that reached the run's STREAM, i.e. was announced. */
  readonly announced: readonly RunEventEnvelope[];
  /** What the engine proposed. Never invented here. */
  readonly candidate: TerminalCandidate | null;
  /** Publish what the engine proposed, and report the emitter's receipt. */
  declare(): EmitResult;
  readonly emitter: RunEventEmitter;
  readonly session: RunSession;
  readonly completed: Promise<void>;
}

/**
 * The terminal an engine candidate projects to.
 *
 * The projection itself is the host adapter's job, and it is spelled out here
 * rather than imported so this file measures the ORDERING rather than a binding
 * somebody else owns. The engine's own candidate is the only input: no verdict
 * in this file is written by hand.
 */
function declaredEventOf(candidate: TerminalCandidate): RunEvent {
  const state = candidate.state;
  if (state.status === 'failed') return { type: 'run.failed', error: state.error };
  return {
    type: 'run.completed',
    status: state.status,
    ...(state.stopReason === undefined ? {} : { stopReason: state.stopReason }),
    ...(state.status === 'cancelled' ? { cancelRequested: true } : {}),
  };
}

function harness(options: HarnessOptions = {}): Harness {
  const appended: RunEventEnvelope[] = [];
  const announced: RunEventEnvelope[] = [];

  let candidate: TerminalCandidate | null = null;
  let declared: EmitResult | null = null;

  const persistence = {
    append: async (batch: readonly RunEventEnvelope[]): Promise<void> => {
      appended.push(...batch);
    },
    complete:
      options.failBarrier === true
        ? async (): Promise<void> => {
            throw new Error('the durable row could not be written');
          }
        : async (_t: RunTerminalState, _m: RunMetrics): Promise<void> => undefined,
  };
  const session = new RunSession({
    runId: RUN_ID,
    sessionId: 'sess-order-1',
    now: () => 1_000,
    startedAt: 0,
    clock: () => 0,
    persistence,
    flushEvery: 1,
  });
  const emitter = new RunEventEmitter({
    runId: RUN_ID,
    session,
    stream: {
      push: (envelope: RunEventEnvelope): void => {
        announced.push(envelope);
      },
    },
  });
  emitter.emit({
    type: 'run.started',
    manifestHash: 'hash-1',
    protocol: { major: 1, minor: 0 },
    runtime: { name: 'test', version: '0.0.0' },
  });

  let turn = 0;
  const events: RunEventStorePort = {
    publish(event: RunEvent): void {
      // Through the emitter, which is the binding the host adapter uses and the
      // only thing that holds a terminal.
      const verdict = emitter.emit(event);
      if (event.type === 'run.completed' || event.type === 'run.failed') declared = verdict;
    },
    proposeTerminal(proposed): void {
      // Advisory, and recorded as advice. Nothing is published from here.
      candidate = proposed;
    },
  };

  const ports: RunEnginePorts = {
    // Required since A3-1. A host with nothing queued SAYS so rather
    // than leaving the port out, which is a compile error -- the
    // engine would otherwise skip the sweep and drop mid-run steering
    // with nothing reporting the loss.
    interTurn: { sweep: () => Promise.resolve({ decision: { action: 'continue', absorbed: false }, injected: [] }) },
    // The three ports the legacy-still-drives window closed (plan 610 D4, then
    // D1 for `modeExit`). ORDER is this file's subject, so each is bound to the
    // smallest honest answer: a bound turn-output sink or mode exit here would
    // add entries to the very sequence these tests assert.
    turnOutput: {
      recordToolResult: () => Promise.resolve(),
      recordAssistantMessage: () => Promise.resolve(),
      finishTurn: () => Promise.resolve(),
      recordInjectedMessage: () => Promise.resolve(),
    },
    compaction: {
      decide: () => Promise.resolve({ kind: 'skip' as const, reason: 'not under test' }),
      run: () => Promise.resolve({ kind: 'declined' as const, reason: 'not under test' }),
      nextCompactionId: () => 'cmp-terminal',
    },
    modeExit: { onRunExit: () => Promise.resolve() },
    model: {
      async *stream(_request: ModelRequest): AsyncIterable<ModelFrame> {
        turn += 1;
        if (turn === 1) {
          yield { type: 'text', text: 'reading' };
          yield { type: 'tool_use', call: READ_CALL };
        } else {
          yield { type: 'text', text: 'done' };
        }
        yield { type: 'turn_stopped', reason: 'end_turn' };
      },
    },
    tools: {
      dispatch(): void {},
      async *drain(): AsyncIterable<ToolDrainItem> {
        if (turn === 1) {
          for (const item of options.batch ?? []) yield item;
        }
      },
      discard(): void {},
      describe: () => [],
    },
    context: {
      async assemble(): Promise<AssembledTurn> {
        return {
          systemPrompt: 'test',
          messages: [],
          tools: [],
          catalogRevision: 'cat-1',
          revision: 'rev-1',
        };
      },
      defer(): void {},
    },
    approval: {
      async authorize(): Promise<ApprovalVerdict> {
        return { allowed: true, scope: 'once' };
      },
    },
    events,
  };

  const engine = new RunEngineImpl({ now: () => 1_000, defaultMaxTurns: 3 });
  const handle = engine.execute({
    manifest: MANIFEST,
    input: INPUT,
    signal: new AbortController().signal,
    ports,
  });

  return {
    async durable(): Promise<readonly RunEventEnvelope[]> {
      await session.flush();
      return appended;
    },
    announced,
    // Read through a getter, not captured: `execute` has only been kicked off
    // by the time this returns, so the proposal lands later.
    get candidate(): TerminalCandidate | null {
      return candidate;
    },
    declare(): EmitResult {
      if (candidate === null) throw new Error('the engine proposed no terminal');
      declared ??= emitter.emit(declaredEventOf(candidate));
      return declared;
    },
    emitter,
    session,
    completed: handle.completed(),
  };
}

const announcedTerminals = (seen: readonly RunEventEnvelope[]): RunEventEnvelope[] =>
  seen.filter((e) => e.payload.type === 'run.completed' || e.payload.type === 'run.failed');

const recordedTerminal = (stored: readonly RunEventEnvelope[]): RunEventEnvelope | null =>
  stored.find((e) => e.payload.type === 'run.completed' || e.payload.type === 'run.failed') ?? null;

const closesOf = (stored: readonly RunEventEnvelope[], toolCallId: string): RunEventEnvelope[] =>
  stored.filter(
    (e) =>
      (e.payload.type === 'tool.call_completed' || e.payload.type === 'tool.timed_out') &&
      e.payload.toolCallId === toolCallId,
  );

/**
 * Every call the durable log starts and never answers, read off the log.
 *
 * Deliberately not `session.danglingToolCalls()`: that is the ledger's own
 * answer, and asserting it against itself would prove nothing. This walks what
 * was actually persisted.
 */
function openCalls(stored: readonly RunEventEnvelope[]): string[] {
  const answered = new Set<string>();
  for (const envelope of stored) {
    const payload = envelope.payload;
    if (payload.type === 'tool.call_completed' || payload.type === 'tool.timed_out') {
      answered.add(payload.toolCallId);
    }
  }
  const started: string[] = [];
  for (const envelope of stored) {
    const payload = envelope.payload;
    if (payload.type === 'tool.call_started' && !answered.has(payload.toolCallId)) {
      started.push(payload.toolCallId);
    }
  }
  return started;
}

describe('a declared terminal closes the transcript before it closes the run', () => {
  it('is HELD through settle and announced exactly once after the barrier agrees', async () => {
    const h = harness();
    await h.completed;

    // The premise, measured: the engine declared an ending. Nothing here
    // invents a verdict.
    expect(h.candidate?.state.status).toBe('completed');

    // Published the way a host adapter publishes it.
    expect(h.declare().ok).toBe(true);

    // HELD, not announced. The barrier has not answered, and a consumer that
    // saw this terminal now would be told the run finished before storage knows
    // whether it did.
    expect(h.emitter.hasHeldTerminal).toBe(true);
    expect(announcedTerminals(h.announced)).toEqual([]);
    // RECORDED already: this is the state the hold exists for -- persisted and
    // numbered, visible to nobody.
    const stored = recordedTerminal(await h.durable());
    if (stored === null) throw new Error('expected a recorded terminal');

    const committed = await h.session.settle();
    expect(committed.status).toBe('completed');

    // Still nothing announced while the release has not run.
    expect(announcedTerminals(h.announced)).toEqual([]);

    const release = await h.emitter.publishCommittedTerminal(committed);
    expect(release.outcome).toBe('published');
    if (release.outcome !== 'published') throw new Error('expected a publication');
    // EXACTLY one, and it is the envelope storage already holds rather than a
    // second mint of the same verdict.
    expect(release.envelope.seq).toBe(stored.seq);
    const announced = announcedTerminals(h.announced);
    expect(announced).toHaveLength(1);
    expect(announced[0]?.seq).toBe(stored.seq);
    expect(announced[0]?.payload).toEqual({ type: 'run.completed', status: 'completed' });
  });

  it('closes the unanswered call at a LOWER seq than the terminal, and answers it as unknown', async () => {
    // The property the ordering exists to preserve: a transcript nobody can
    // trust is one whose terminal precedes a `tool.call_started` still waiting
    // for an answer.
    const h = harness();
    await h.completed;

    // The premise, on both sides of the ledger and of storage: the call really
    // is open, and the durable log really does leave it unanswered.
    expect(h.session.danglingToolCalls()).toEqual([READ_CALL.callId]);
    expect(openCalls(await h.durable())).toEqual([READ_CALL.callId]);

    expect(h.declare().ok).toBe(true);

    // Publishing the terminal is what closed it, so nothing is open now -- and
    // the durable log, not the session's own answer, is what says so.
    expect(h.session.danglingToolCalls()).toEqual([]);
    expect(openCalls(await h.durable())).toEqual([]);

    const closes = closesOf(await h.durable(), READ_CALL.callId);
    expect(closes).toHaveLength(1);
    const close = closes[0];
    if (close?.payload.type !== 'tool.call_completed') throw new Error('expected a close');
    // `indeterminate`, never a success or a cancellation nobody observed.
    expect(close.payload.outcome.outcome).toBe('indeterminate');
    // And the note carries the call's own id, so a log line alone can be joined.
    expect(close.payload.outcome.note).toContain(READ_CALL.callId);

    const terminal = recordedTerminal(await h.durable());
    if (terminal === null) throw new Error('expected a terminal');
    // The seq comparison IS the invariant: the close precedes the terminal in
    // the durable log, not merely in some array this test built.
    expect(close.seq).toBeLessThan(terminal.seq);

    // Settle still completes, and the run reads as what it was.
    const committed = await h.session.settle();
    expect(committed.status).toBe('completed');
  });

  it('DISCARDS the terminal when the barrier commits a different verdict, announcing none', async () => {
    // The mutation proof for the whole slice: a hold that can be bypassed is
    // worse than the deadlock it was meant to avoid, because it announces an
    // ending the durable barrier contradicted.
    const h = harness({ failBarrier: true });
    await h.completed;

    expect(h.declare().ok).toBe(true);
    expect(h.emitter.hasHeldTerminal).toBe(true);
    expect(announcedTerminals(h.announced)).toEqual([]);

    const committed = await h.session.settle();
    expect(committed.status).toBe('failed');
    if (committed.status !== 'failed') throw new Error('expected a failure');
    expect(committed.error.code).toBe('persistence_failed');

    const release = await h.emitter.publishCommittedTerminal(committed);
    expect(release.outcome).toBe('discarded');
    if (release.outcome !== 'discarded') throw new Error('expected a discard');
    // Both sides named: what the run announced, and what the barrier answered.
    expect(release.declared.status).toBe('completed');
    expect(release.committed.error.code).toBe('persistence_failed');

    // ZERO announced, and nothing published in the held terminal's place.
    expect(announcedTerminals(h.announced)).toEqual([]);
    // The durable log is not rewritten by a discard -- nothing is erased, it is
    // simply not announced.
    expect(recordedTerminal(await h.durable())?.payload.type).toBe('run.completed');
  });

  it('leaves a run that declared NOTHING behaving as it did: synthesised, and a crash', async () => {
    // The arm this change must not touch. With no terminal event from the
    // engine there is nothing to hold, `#synthesizeTerminalEvent` writes one at
    // settle, and `resolveRunOutcome` has already decided `IMPLICIT_CRASH` from
    // the absence.
    const h = harness();
    await h.completed;

    expect(h.candidate).not.toBeNull();
    expect(h.emitter.hasHeldTerminal).toBe(false);
    expect(recordedTerminal(await h.durable())).toBeNull();

    const committed = await h.session.settle();
    expect(committed.status).toBe('failed');
    if (committed.status !== 'failed') throw new Error('expected a failure');
    expect(committed.error.code).toBe('runtime_crash');
    expect(committed.error.message).toBe('the run stream ended with no terminal event');

    // The synthesised terminal is written at settle, AFTER the close -- the
    // ordering the eager close preserves rather than replaces.
    const closes = closesOf(await h.durable(), READ_CALL.callId);
    const terminal = recordedTerminal(await h.durable());
    if (terminal === null) throw new Error('expected a synthesised terminal');
    expect(terminal.payload.type).toBe('run.failed');
    expect(closes).toHaveLength(1);
    expect(closes[0]?.seq ?? Number.MAX_SAFE_INTEGER).toBeLessThan(terminal.seq);
    expect(openCalls(await h.durable())).toEqual([]);

    // Nothing was held, so the release says so rather than inventing a frame.
    const release = await h.emitter.publishCommittedTerminal(committed);
    expect(release.outcome).toBe('none');
  });
});
