/**
 * Plan 610 S4c-d3 regression: the desktop chat streams ONE codec pass.
 *
 * ## The defect this file exists for
 *
 * `driveRunWithEngine`'s drain runs `request.legacyFrameCodec` over the
 * projector's output BEFORE it calls `onFrame` (`engine-run-driver.ts:689-691`),
 * and the entry's `handleStreamEvent` ran the SAME codec again over what it was
 * handed. `convertSSEToAgentMessage` has no `chat:*` arm, so the second pass
 * sent every already-converted frame to its `default:` WARN and returned `null`.
 *
 * Two things died at once, and the second is the sharper one:
 *
 *  - the frame never reached `sendToMain` (`sendToMain` sits inside
 *    `if (agentMsg)`), so a turn streamed no text, no thinking and no tool cards;
 *  - `deferredDone` was set inside that same `if (agentMsg)`, so the post-flush
 *    barrier never ran and the terminal `chat:done` -- and the
 *    `assistant.message_finalized` ahead of it -- were never emitted at all.
 *    Turn termination rode entirely on the renderer's `chat:db_persisted`
 *    fallback.
 *
 * ## Why the seam is exercised HERE and not at the router
 *
 * Every pre-existing desktop `chat:text` test injects the frame at the
 * router/normalise boundary, so none of them ever saw this: they hand-write a
 * `chat:*` frame to the consumer and assert the consumer routes it. That is
 * precisely the assertion a double codec cannot fail -- by the time the frame
 * is at the router it has already survived, or not, and the test supplies it
 * either way.
 *
 * So nothing here is hand-written. The chain is the real one, end to end:
 *
 *   scripted provider -> real `duyaAgent` -> real `RunEngineImpl` -> real
 *   spine -> real `createWorkerAdapterSurface` -> REAL `projectToLegacyFrame`
 *   -> REAL `convertSSEToAgentMessage` (the driver's own codec) -> the entry's
 *   REAL `onFrame` binding shape -> REAL `admitChatFrame` + REAL
 *   `createTurnDoneLatch`.
 *
 * The only fake is the LLM provider, which stands in for nothing under test.
 *
 * ## What the entry's binding shape is, and what is left out of it
 *
 * `handleStreamEvent` does frame handling (admission, the `chat:done` hold,
 * forwarding) and per-frame accounting on the PRE-codec vocabulary
 * (`event.type === 'result'` / `'tool_result'` / `'done'`). The frame-handling
 * half is reproduced here because it is the half that decided survival, and it
 * is reproduced by CALLING the entry's own exported functions rather than by
 * re-expressing them -- so this file cannot drift from the entry's behaviour,
 * which is the way the original gap opened. The accounting half and the
 * persistence/`sendToMain` plumbing are NOT exercised here; they are the entry's
 * and are out of this file's reach.
 *
 * ## What this file does NOT prove
 *
 * It does not prove the frames render in Electron. It proves they SURVIVE the
 * production seam with the right values, which is what the double codec broke.
 * It also does not address the payload shape of `chat:text`, which is a
 * separate defect in `sse-frame-codec.ts` and is reported separately.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { RunEvent, RunEventEnvelope, RunId } from '@duya/agent-protocol';
import { projectToLegacyFrame } from '@duya/agent-runtime';
import type { AgentStreamEvent } from '../sse-frame-codec.js';
import type { ChatOptions, Message, SSEEvent } from '../../types.js';

/** One protocol envelope, as the drain's projection receives it. */
function envelope(payload: RunEvent): RunEventEnvelope {
  return {
    runId: 'run-desktop-codec-once' as RunEventEnvelope['runId'],
    sessionId: SESSION_ID as RunEventEnvelope['sessionId'],
    seq: 1,
    timestamp: 1_700_000_000_000,
    traceId: 'trace-desktop-codec-once' as RunEventEnvelope['traceId'],
    payload,
  };
}

// ============================================================================
// The scripted PROVIDER -- the only fake in this file.
// ============================================================================

/** The text the model "streams". Only the real model port can turn this into a block. */
const STREAMED_TEXT = 'DESKTOP-STREAMED-TEXT';
const DONE: SSEEvent = { type: 'done', reason: 'end_turn' };
const SESSION_ID = 's-desktop-codec-once';

const SCRIPTS: readonly (readonly SSEEvent[])[] = [
  [{ type: 'text', data: STREAMED_TEXT }, DONE],
];

let providerCalls = 0;

vi.mock('@duya/ai', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const delegating = {
    streamChat(messages: Message[], options?: Record<string, unknown>) {
      // The tool surface must be non-empty or the model leg refuses the turn.
      void messages;
      providerCalls++;
      const script = SCRIPTS[Math.min(providerCalls - 1, SCRIPTS.length - 1)];
      const signal = options?.signal as AbortSignal | undefined;
      return (async function* () {
        for (const event of script) {
          if (signal?.aborted) {
            const err = new Error('The operation was aborted');
            err.name = 'AbortError';
            throw err;
          }
          yield event;
        }
      })();
    },
  };
  return { ...actual, createAIClient: () => delegating, createAIClientWithRetry: () => delegating };
});

// ============================================================================
// The DURABLE SINK -- captured, because the turn commits real rows.
// ============================================================================

vi.mock('../../ipc/db-client.js', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const messageDb = actual.messageDb as Record<string, unknown>;
  return {
    ...actual,
    messageDb: {
      ...messageDb,
      append: (_sessionId: string, messages: unknown[], _turnId: string | null) =>
        Promise.resolve({ success: true, count: (messages as unknown[]).length }),
    },
  };
});

// ============================================================================
// The production modules under test.
// ============================================================================

const PRE_EXISTING = new Set(process.listeners('message'));
const { duyaAgent } = await import('../../agent/DuyaAgent.js');
const { TurnPipelinePublisher } = await import('../../tool/turn-pipeline-publisher.js');
const { initDbClient } = await import('../../ipc/db-client.js');
const { Journal } = await import('../../journal/Journal.js');
const { driveRunWithEngine } = await import('../engine-run-driver.js');
const { resolveTurnRunId } = await import('../../agent/run-identity.js');
const { convertSSEToAgentMessage } = await import('../sse-frame-codec.js');
// The ENTRY's own exported frame-handling functions. Not a copy of them: the
// point of this file is that it exercises the entry's real admission gate and
// its real turn-end hold rather than a test-local stand-in.
const { admitChatFrame, createTurnDoneLatch } = await import('../agent-process-entry.js');

let dbListener: ((m: unknown) => void) | null = null;
let realSend: typeof process.send | undefined;
let workspaceDir = '';
const tempDirs: string[] = [];
const originalEnv = { ...process.env };

/**
 * Answer the two DB actions a turn reaches for. Under a Vitest pool worker
 * `process.send` is the POOL's channel, so it is replaced and the db-client's
 * own listener is called directly.
 */
function installFakeDbIpc(): void {
  if (!dbListener) {
    initDbClient();
    dbListener = (process
      .listeners('message')
      .filter((l) => !PRE_EXISTING.has(l))[0] ?? null) as ((m: unknown) => void) | null;
    if (!dbListener) throw new Error('db-client registered no message listener');
  }
  realSend = process.send;
  process.send = ((msg: unknown) => {
    const req = msg as { type?: string; action?: string; id?: string };
    if (req?.type !== 'db:request') return true;
    if (req.action !== 'modeState:get' && req.action !== 'mailbox:claimBatch') {
      throw new Error(`unexpected db action: ${req.action}`);
    }
    const result = req.action === 'mailbox:claimBatch' ? { rows: [], claimTokens: [] } : null;
    setImmediate(() => dbListener?.({ type: 'db:response', id: req.id, success: true, result }));
    return true;
  }) as unknown as typeof process.send;
}

beforeEach(() => {
  vi.stubEnv('DUYA_TEST', '1');
  vi.stubEnv('DUYA_TEST_NAMESPACE', 'desktop-codec-once');
  process.env.DUYA_E2E_DISABLE_LLM = '1';
  process.env.DUYA_SESSIONS_ROOT = '';
  process.env.DUYA_MEMORY_ROOT = '';
  providerCalls = 0;
});

afterEach(() => {
  vi.unstubAllEnvs();
  process.env = { ...originalEnv };
  process.send = realSend;
  vi.restoreAllMocks();
  for (const dir of tempDirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // A temp dir nobody claimed is not a test failure.
    }
  }
});

// ============================================================================
// The run, through the entry's real binding shape.
// ============================================================================

interface Turn {
  /** What the driver handed `onFrame`, verbatim. */
  readonly driverFrames: readonly Record<string, unknown>[];
  /** What the entry's consumer received AFTER admission and the done hold. */
  readonly delivered: readonly Record<string, unknown>[];
  readonly turnDone: ReturnType<typeof createTurnDoneLatch>;
  readonly terminal: string | undefined;
}

async function runTurn(): Promise<Turn> {
  installFakeDbIpc();

  workspaceDir = mkdtempSync(path.join(os.tmpdir(), 'duya-codec-once-ws-'));
  tempDirs.push(workspaceDir);
  const ledgerDir = mkdtempSync(path.join(os.tmpdir(), 'duya-codec-once-ledger-'));
  tempDirs.push(ledgerDir);

  const agent = new duyaAgent({
    apiKey: 'test-key',
    model: 'claude-test',
    provider: 'anthropic',
    sessionId: SESSION_ID,
    workingDirectory: workspaceDir,
    permissionMode: 'bypassPermissions',
  });
  agent.journal = new Journal({ sessionId: SESSION_ID });

  const turnPipelines = new TurnPipelinePublisher();
  const options = { sessionId: SESSION_ID } as unknown as ChatOptions;

  const driverFrames: Record<string, unknown>[] = [];
  const delivered: Record<string, unknown>[] = [];
  const turnDone = createTurnDoneLatch();

  const outcome = await driveRunWithEngine(
    {
      agent,
      sessionId: SESSION_ID,
      runId: resolveTurnRunId(undefined).runId as RunId,
      seqIndex: Date.now(),
      options,
      prompt: 'say the streamed text',
      model: 'claude-test',
      providerId: 'anthropic',
      workingDirectory: workspaceDir,
      permissionMode: 'acceptEdits',
      maxTurns: 2,
      wakeRun: false,
      imageInputSupported: false,
      turnPipelines,
      askApproval: async () => ({ allowed: true, scope: 'once' }) as const,
      legacyFrameCodec: convertSSEToAgentMessage,
      onPerCallUsage: () => {},
      ledgerDir,
    },
    // ── THE ENTRY'S `onFrame` BINDING SHAPE ──────────────────────────────
    // `agent-process-entry.ts` binds `(frame) => handleStreamEvent(frame)`.
    // Admission and the `chat:done` hold are the entry's own exported
    // functions; what is reproduced is only the three lines of glue that route
    // the result, and every decision among them is production code.
    (frame) => {
      driverFrames.push(frame);
      // The same cast the entry's own binding makes at
      // `agent-process-entry.ts:3458`: the driver declares `onFrame` as
      // `(frame: Record<string, unknown>)`, and the entry narrows it to a
      // frame carrying a string `type`. Reproduced rather than widened in
      // `admitChatFrame` so this file cannot drift from the real binding.
      const agentMsg = admitChatFrame(frame as { type: string });
      if (agentMsg === null) return;
      if (turnDone.latch(agentMsg)) return;
      delivered.push(agentMsg);
    },
  );

  turnPipelines.close();
  await agent.journal.flush();

  return {
    driverFrames,
    delivered,
    turnDone,
    terminal: outcome.terminal?.status,
  };
}

// ============================================================================
// 1. The frame survives.
// ============================================================================

describe('a desktop chat turn survives the codec exactly once', () => {
  it('delivers the assistant text the model streamed, to the consumer', async () => {
    const turn = await runTurn();

    // The run actually executed -- otherwise "no text" would be trivially true.
    expect(turn.terminal).toBe('completed');
    expect(providerCalls).toBeGreaterThan(0);

    const textFrames = turn.delivered.filter((f) => f['type'] === 'chat:text');

    // THE assertion. Before the fix this list was EMPTY: the driver had
    // already codec'd the frame to `chat:text`, the entry codec'd it AGAIN,
    // and the second pass returned null.
    expect(textFrames.length, 'no chat:text reached the consumer').toBeGreaterThan(0);

    // And it is the model's own text, not an empty or re-wrapped row. The
    // block the real engine published is what the real projector carried.
    const contents = textFrames.map((f) => f['content']);
    expect(contents.some((c) => JSON.stringify(c).includes(STREAMED_TEXT))).toBe(true);
  }, 120_000);

  it('delivers a frame for every frame the driver produced except the held done', async () => {
    const turn = await runTurn();

    // The driver ran its codec and emitted `chat:*` frames. This is the half
    // that was already correct before the fix, and it is asserted so the
    // regression above cannot be satisfied by a driver that emitted nothing.
    expect(turn.driverFrames.length).toBeGreaterThan(0);
    expect(turn.driverFrames.every((f) => typeof f['type'] === 'string')).toBe(true);

    // One `chat:done` is HELD, not delivered. Everything else the driver
    // produced was admitted and forwarded.
    const heldDone = turn.driverFrames.filter((f) => f['type'] === 'chat:done');
    expect(heldDone).toHaveLength(1);
    expect(turn.delivered.some((f) => f['type'] === 'chat:done')).toBe(false);
    expect(turn.driverFrames.length - heldDone.length).toBe(turn.delivered.length);
  }, 120_000);

  it('admits every frame the real pipeline emits, so the gate has no blind spot', async () => {
    const turn = await runTurn();

    // The admission gate is a prefix test, so it is only correct if EVERY
    // frame the driver can emit is either `chat:*` (admitted verbatim) or one
    // of the codec's idempotent `compact:*` arms (re-encoding returns it
    // unchanged). Rather than trust that inventory, measure it over the frames
    // the REAL pipeline produced: re-admitting each must not change it.
    for (const frame of turn.driverFrames) {
      const readmitted = admitChatFrame(frame as { type: string });
      expect(readmitted, `admission dropped the driver's own ${String(frame['type'])} frame`).not.toBeNull();
      expect(readmitted, `admission mutated ${String(frame['type'])}`).toEqual(frame);
    }
  }, 120_000);
});

// ============================================================================
// 2. The latch.
// ============================================================================

describe('the turn-end done latch, driven by a real completed run', () => {
  it('latches on the run\'s own chat:done, and carries the real stop reason', async () => {
    const turn = await runTurn();

    // THE assertion. `deferredDone` was set inside `if (agentMsg)`, so a turn
    // whose done frame was dropped by the second codec pass left the post-flush
    // barrier permanently unsatisfied -- no `chat:done`, no
    // `assistant.message_finalized`, and no terminal for the renderer.
    expect(turn.turnDone.latched, 'the completed run never latched its chat:done').toBe(true);

    // And it latched the run's OWN frame rather than a value of its own: the
    // reason is read off the frame the REAL projector produced for
    // `run.completed`. This engine configuration publishes no `stopReason`, so
    // both sides are `undefined` -- which is a real state the sibling
    // `sse-frame-codec-terminal-frames.test.ts` explicitly blesses ("leaves the
    // reason undefined when the run stated none"). The comparison is the claim:
    // a latch that invented a reason, or latched some other frame, fails it.
    const doneFrame = turn.driverFrames.find((f) => f['type'] === 'chat:done');
    expect(doneFrame).toBeDefined();
    expect(turn.turnDone.reason).toBe(doneFrame?.['reason']);
  }, 120_000);

  it('carries a stated stop reason through the latch, from the real producer', async () => {
    // The other direction, and the one that would let a latch which only ever
    // evered `undefined` pass: when the run DOES state a reason, the latch must
    // carry it. The frame is built by the REAL projector from a REAL protocol
    // envelope and converted by the REAL codec -- the same seam the sibling
    // terminal-frames file builds -- so the value under test is production's.
    const frame = projectToLegacyFrame(
      envelope({ type: 'run.completed', status: 'completed', stopReason: 'end_turn' }),
    );
    expect(frame).not.toBeNull();
    const chatFrame = convertSSEToAgentMessage(frame as unknown as AgentStreamEvent);
    expect(chatFrame?.['type']).toBe('chat:done');

    const latch = createTurnDoneLatch();
    expect(latch.latch(chatFrame)).toBe(true);
    expect(latch.reason).toBe('end_turn');

    const released = latch.release(SESSION_ID, null);
    expect(released).toHaveLength(1);
    expect(released[0]?.['reason']).toBe('end_turn');
  });

  it('releases the finalized message ahead of chat:done, and in that order', async () => {
    const turn = await runTurn();

    // The post-flush barrier's own output, in the order the entry sends it. The
    // renderer only swaps the live stream view for durable rows when a
    // successful `db_persisted` ack PRECEDES `done`, so `done` must not lead.
    const released = turn.turnDone.release(
      SESSION_ID,
      { type: 'assistant.message_finalized', sessionId: SESSION_ID },
    );

    expect(released.map((f) => f['type'])).toEqual([
      'assistant.message_finalized',
      'chat:done',
    ]);
    const done = released[released.length - 1] as Record<string, unknown>;
    expect(done['sessionId']).toBe(SESSION_ID);
    expect(done['reason']).toBe(turn.turnDone.reason);
  }, 120_000);

  it('releases nothing at all for a turn that produced no done', async () => {
    // The other half of the contract, and the one that would be lost by a
    // latch that reports a reason instead of remembering whether it latched:
    // an unlatched hold must NOT invent a `chat:done`, or a turn that never
    // finished would be reported as though it had.
    const latch = createTurnDoneLatch();

    expect(latch.latched).toBe(false);
    expect(latch.release(SESSION_ID, null)).toEqual([]);

    // A non-done frame does not latch it either.
    expect(latch.latch({ type: 'chat:text', content: 'not done' })).toBe(false);
    expect(latch.latched).toBe(false);
  });
});