/**
 * Plan 610 plan-17 S0: the production-chain loss of native Runtime events.
 *
 * ## The claim under test
 *
 * The shared `RunEngine` DOES mint durable lifecycle events — `run.started` and
 * `assistant.message_finalized` both are `durability: 'durable'` in
 * `events/registry.ts` — and the Host spine DOES have a durable sink shape for
 * them (`RunPersistence`, `run-session.ts:56-61`). Neither is reachable from the
 * production worker turn. Two INDEPENDENT seams drop the events, and this file
 * separates them because S1 has to fix them differently:
 *
 *   1. **No durable binding on the worker's spine.** `worker-process-entry.ts:2279`
 *      calls `driveRunWithEngine` without `persistence`; the driver forwards it
 *      only when supplied (`worker-engine-driver.ts:169`); the spine then falls
 *      back to a no-op sink (`run-event-spine.ts:100-103`). The worker's own copy
 *      of every envelope reaches `EngineRunOutcome.announced` and is used for a
 *      log line COUNT (`worker-process-entry.ts:2337`). Nothing durable is written,
 *      and nothing durable is even REQUESTED — there is no `RunPersistence`
 *      implementation on the worker path at all.
 *   2. **The worker→Host channel is the lossy legacy vocabulary.**
 *      `worker-engine-driver.ts:235` projects each native envelope through
 *      `projectToLegacyFrame`, which returns `null` for eleven event types
 *      (`legacy-sse-projector.ts:299-310`), and `RunOrchestrator.observe` rebuilds
 *      the Host ledger from those frames via `controller.observeFrame` →
 *      `chat-event-translator.ts:222-426`. An event the projection drops cannot be
 *      reconstructed from what remains.
 *
 * ## The plan's headline example does not reproduce
 *
 * Plan 610 file 17 §2 nominates `turn.completed` as the event that "reaches the
 * engine but is missing from the Host ledger". Measured on this path it does not
 * reach the engine: `run-engine.ts` has no `turn.completed` emit site, and every
 * occurrence of the string in the tree is a projector drop arm, a surface
 * mapping, or a synthetic envelope in a test. Layer A2 pins that as executable
 * truth, because a plan that reads "the projector drops it" as "deliver it"
 * would build a channel for an event with no producer.
 *
 * ## Why the fixture cannot pass vacuously *
 * The two sides compared below are produced by DIFFERENT code: the native set is
 * the spine emitter's own publication, read off `outcome.announced`; the outbound
 * set is what the production drain callback received. Neither is derived from the
 * other, so agreement cannot be manufactured by a bug in one comparator.
 *
 * And the fixture is a real multi-turn tool run, not a projection unit test: the
 * probe tool's body WRITES A FILE, the provider is called twice, and the turn
 * count is asserted as a POSITIVE COUNT. A run that quietly stopped calling the
 * model leg, or never dispatched the tool, cannot produce `turn.completed` twice.
 *
 * ## What the CONTROL run adds
 *
 * The same real driver is driven a second time with a recording `RunPersistence`
 * bound. It receives `turn.completed` envelopes with real `seq` / `runId`. So the
 * engine and the spine are NOT the bottleneck and must not be "fixed" — the loss
 * is entirely in the binding and the channel. Without this control, "the engine
 * never emits it" and "the Host never receives it" are indistinguishable, and the
 * first reading is the tempting one.
 *
 * ## Reading the result
 *
 * Layers A–C are green and are the standing record: they pin the numbers so a
 * later change to either side is visible as a diff.
 *
 * Layer D is the CONTRACT, written with `it.fails`. It is expected to FAIL on the
 * current path. That is deliberate and it is the only red-by-design pattern in
 * this tree: `it.fails` passes when the inner assertion throws, so the suite stays
 * green while the defect is on record — and the moment S1 closes the seam, the
 * inner assertion STOPS throwing, `it.fails` turns the suite RED, and the fix is to
 * delete the `it.fails` wrapper and restate it as a plain assertion. A silent green
 * here would be indistinguishable from the defect being gone.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { RunEventEnvelope } from '@duya/agent-protocol';
import type { RunPersistence, RunTerminalState } from '@duya/agent-runtime';
import type { Message, SSEEvent } from '@duya/host/worker-run-contracts';

// ============================================================================
// The scripted PROVIDER — the only fake, and it stands in for nothing under test.
// Two turns: the first asks for the probe, the second reports and stops. Two is
// the minimum that can distinguish "a turn happened" from "a turn boundary was
// crossed and closed".
// ============================================================================

const PROBE_TOOL = 'authority_probe';
/** Written by the probe's own body. Its presence on disk is the tool-leg proof. */
const PROBE_ANSWER = 'AUTHORITY-PROBE-RAN';
const SESSION_ID = 's-authority-loss';
const PROMPT = 'run the probe and report back';
const DONE: SSEEvent = { type: 'done', reason: 'end_turn' };

const SCRIPTS: readonly (readonly SSEEvent[])[] = [
  [
    { type: 'text', data: 'calling the probe' },
    { type: 'tool_use', data: { id: 'auth-t1', name: PROBE_TOOL, input: { value: 'alpha' } } },
    DONE,
  ],
  [{ type: 'text', data: 'the probe reported' }, DONE],
];

let providerCalls = 0;

/**
 * The pool's own `'message'` listeners, captured BEFORE anything below is
 * imported.
 *
 * The db-client registers its listener as an import side effect, so a snapshot
 * taken after the dynamic imports would already contain the one listener worth
 * calling and the diff would come back empty. The pool's listener is the one
 * that must NOT be called directly — it runs `Buffer.from` on a plain object.
 */
const POOL_LISTENERS = new Set(process.listeners('message'));

vi.mock('@duya/ai', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const delegating = {
    streamChat(_messages: Message[], options?: Record<string, unknown>) {
      providerCalls += 1;
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
// The offline host. `engine-turn-harness` boots the REAL driver: real spine,
// real `composeLegacyRunPorts`, real `RunEngineImpl`, real worker codec.
// ============================================================================

const { makeWorkerSession, driveTurn, cleanupEngineTurnDirs } = await import('./engine-turn-harness.js');
const { Journal } = await import('@duya/host/worker-journal/Journal');
const { initDbClient } = await import('@duya/host/worker-db-client');

const originalEnv = { ...process.env };
let workspaceDir = '';

// ---------------------------------------------------------------------------
// Worker IPC.
//
// Under a Vitest pool worker `process.send` is the POOL's channel, so it is
// replaced and the real db-client's own listener is called directly. The three
// actions answered here are the ones this run reaches for: mode state, the
// mailbox claim, and the Journal's message append. Anything else THROWS rather
// than hanging, so an unanticipated request is a visible failure instead of a
// 10s timeout — which is what an unanswered `claimBatch` looks like.
// ---------------------------------------------------------------------------

let realSend: typeof process.send | undefined;
let cachedDbListener: ((m: unknown) => void) | null = null;

function installDbIpc(): void {
  if (cachedDbListener === null) {
    initDbClient();
    cachedDbListener = (process
      .listeners('message')
      .filter((l) => !POOL_LISTENERS.has(l))[0] ?? null) as ((m: unknown) => void) | null;
    if (cachedDbListener === null) throw new Error('db-client registered no message listener');
  }
  const dbListener = cachedDbListener;

  realSend = process.send;
  process.send = ((msg: unknown) => {
    const req = msg as { type?: string; action?: string; id?: string };
    if (req?.type !== 'db:request') return true;
    const result =
      req.action === 'mailbox:claimBatch'
        ? { rows: [], claimTokens: [] }
        : req.action === 'message:append'
          ? { success: true, count: (req as unknown as { payload: { messages: unknown[] } }).payload.messages.length }
          : null;
    if (
      req.action !== 'mailbox:claimBatch' &&
      req.action !== 'message:append' &&
      req.action !== 'modeState:get'
    ) {
      throw new Error(`unexpected db action in S0: ${req.action}`);
    }
    setImmediate(() => dbListener({ type: 'db:response', id: req.id, success: true, result }));
    return true;
  }) as unknown as typeof process.send;
}

beforeEach(() => {
  vi.stubEnv('DUYA_TEST', '1');
  process.env.DUYA_E2E_DISABLE_LLM = '1';
  process.env.DUYA_SESSIONS_ROOT = '';
  process.env.DUYA_MEMORY_ROOT = '';
  providerCalls = 0;
});

afterEach(async () => {
  process.send = realSend;
  cleanupEngineTurnDirs();
  vi.unstubAllEnvs();
  process.env = { ...originalEnv };
  vi.restoreAllMocks();
  if (workspaceDir !== '') {
    try {
      rmSync(workspaceDir, { recursive: true, force: true });
    } catch {
      // A temp dir nobody claimed is not a test failure.
    }
    workspaceDir = '';
  }
});

// ============================================================================
// One real production-shaped run
// ============================================================================

interface Run {
  /** The native envelopes the spine's emitter published, in order. */
  readonly native: readonly RunEventEnvelope[];
  /** The `chat:*` frames the production drain callback received, in order. */
  readonly frames: readonly Record<string, unknown>[];
  readonly terminal: RunTerminalState | null;
  /** Whatever a bound `RunPersistence` was handed. Empty for the production shape. */
  readonly durableAppends: readonly RunEventEnvelope[][];
  readonly durableCompletes: readonly RunTerminalState[];
  readonly probeFile: string;
  readonly providerCalls: () => number;
}

async function runOnce(bindPersistence: boolean): Promise<Run> {
  installDbIpc();
  workspaceDir = mkdtempSync(path.join(os.tmpdir(), 'duya-authority-ws-'));
  const probeFile = path.join(workspaceDir, 'probe-ran.txt');

  const agent = makeWorkerSession({
    apiKey: 'test-key',
    model: 'claude-test',
    provider: 'anthropic',
    sessionId: SESSION_ID,
    workingDirectory: workspaceDir,
    permissionMode: 'bypassPermissions',
  });
  agent.journal = new Journal({ sessionId: SESSION_ID });

  // Registered into the AGENT'S OWN registry, because the engine's side-effect
  // lookup is derived from `agent.activeMCPRegistry` (`engine-real-agent-proof`
  // found that a probe in a separate `options.toolRegistry` resolves `undeclared`
  // and the engine then REFUSES the call).
  agent.activeMCPRegistry.register(
    {
      name: PROBE_TOOL,
      description: 'a probe that records its own execution on disk',
      input_schema: { type: 'object', properties: { value: { type: 'string' } } },
    } as never,
    {
      execute: async () => {
        writeFileSync(probeFile, PROBE_ANSWER, 'utf-8');
        return { ok: true, result: PROBE_ANSWER };
      },
    } as never,
  );

  const durableAppends: RunEventEnvelope[][] = [];
  const durableCompletes: RunTerminalState[] = [];
  const recorder: RunPersistence = {
    append: async (envelopes) => {
      durableAppends.push([...envelopes]);
    },
    complete: async (terminal) => {
      durableCompletes.push(terminal);
    },
  };

  const callsBefore = providerCalls;
  const result = await driveTurn(
    agent as never,
    PROMPT,
    bindPersistence ? { persistence: recorder } : {},
  );

  return {
    native: result.outcome.announced,
    frames: result.frames,
    terminal: result.outcome.terminal,
    durableAppends,
    durableCompletes,
    probeFile,
    providerCalls: () => providerCalls - callsBefore,
  };
}

/** Count of native envelopes of one payload type. */
function nativeCount(native: readonly RunEventEnvelope[], type: string): number {
  return native.filter((envelope) => envelope.payload.type === type).length;
}

/**
 * The frame types the drain received, in the LEGACY vocabulary.
 *
 * `chat:` is stripped so a claim about a turn boundary is written once and does
 * not have to be restated in the codec's spelling.
 */
function drainedFrameTypes(frames: readonly Record<string, unknown>[]): readonly string[] {
  return frames.map((frame) => {
    const type = typeof frame['type'] === 'string' ? (frame['type'] as string) : '';
    return type.startsWith('chat:') ? type.slice('chat:'.length) : type;
  });
}

/**
 * The eleven protocol events the projector has no legacy frame for.
 *
 * Named here rather than derived from `projectToLegacyFrame`, because deriving
 * them would make the expectation track the defect: a future commit that ADDED a
 * frame for one of these would silently widen the allow-list and the assertion
 * below would keep passing while the loss it measures disappeared. This list is
 * the claim; the projector's `null` arms are the thing under test.
 */
const NO_LEGACY_FRAME: readonly string[] = [
  'run.started',
  'run.paused',
  'turn.completed',
  'assistant.message_finalized',
  'permission.resolved',
  'permission.expired',
  'checkpoint.saved',
  'tool.timed_out',
  'diagnostic',
  'diagnostic.trace',
  'extension.custom',
];

describe('plan-610 S0 — native Runtime events on the production worker path', () => {
  // ==========================================================================
  // Layer A — the run is real. Every claim here is a POSITIVE COUNT.
  // ==========================================================================

  it('drives a real two-turn turn with a real tool call', async () => {
    const run = await runOnce(false);

    // The model leg really ran twice. One provider call cannot open two turns.
    expect(run.providerCalls()).toBe(2);
    // The tool leg really dispatched, proven off the FILESYSTEM rather than off
    // a spy: a build that merely believed it dispatched writes nothing.
    expect(existsSync(run.probeFile)).toBe(true);
    expect(readFileSync(run.probeFile, 'utf-8')).toBe(PROBE_ANSWER);
    // Two turn boundaries really opened, and the run really opened and closed.
    expect(nativeCount(run.native, 'turn.started')).toBe(2);
    expect(nativeCount(run.native, 'run.started')).toBe(1);
    expect(nativeCount(run.native, 'run.completed')).toBe(1);
    expect(run.terminal?.status).toBe('completed');
  });

  // ==========================================================================
  // Layer A2 — a CORRECTION to the plan's premise, pinned as executable truth.
  // ==========================================================================

  it('never mints turn.completed: the engine has no emit site for it', async () => {
    const run = await runOnce(false);

    // Plan 610 file 17 §2 nominates `turn.completed` as the event that "reaches
    // the engine but is missing from the Host ledger". Measured on the real
    // production path, it is not: `run-engine.ts` contains no `turn.completed`
    // emit site at all. Every occurrence in the tree is either a projector drop
    // arm, a surface mapping, or a synthetic test envelope.
    //
    // This matters for S1 in the worst direction — `turn.completed` is a PHANTOM
    // the Host can never receive and the engine can never produce, so a plan that
    // reads "the projector drops it" as "deliver it" would build a channel for an
    // event with no producer. The genuine losses are measured below instead.
    expect(nativeCount(run.native, 'turn.completed')).toBe(0);
    // The turn OPEN is present, so the count above is a real absence and not a
    // run that silently skipped turn boundaries.
    expect(nativeCount(run.native, 'turn.started')).toBe(2);
  });

  it('shows the frames the drain DOES receive, so the missing ones are a difference', async () => {
    const run = await runOnce(false);
    const drained = drainedFrameTypes(run.frames);

    // The lossy projection is working for everything it covers: the text, the
    // tool result and the terminal all crossed. Without this, "X is absent"
    // could be satisfied by a drain that dropped EVERYTHING.
    expect(drained).toContain('text');
    expect(drained).toContain('tool_result');
    expect(drained).toContain('done');
    // Exactly two turn openings reached the Host, one per model turn.
    expect(drained.filter((t) => t === 'turn_start')).toHaveLength(2);
  });

  // ==========================================================================
  // Layer B — the loss, measured. Standing record of the defect's shape.
  // ==========================================================================

  it('mints the run lifecycle in the engine and drops it before the Host', async () => {
    const run = await runOnce(false);
    const drained = new Set(drainedFrameTypes(run.frames));

    // `run.started` carries the manifest hash and runtime identity — the facts a
    // Host needs to decide whether a resumed run is the same run — and
    // `assistant.message_finalized` is the authoritative assistant message.
    // Both are `durability: 'durable'`. Both are minted here. Neither has a
    // legacy frame, so neither left the worker.
    expect(nativeCount(run.native, 'run.started')).toBe(1);
    expect(nativeCount(run.native, 'assistant.message_finalized')).toBe(1);
    for (const type of ['run.started', 'assistant.message_finalized']) {
      expect(drained.has(type)).toBe(false);
    }
  });

  it('drops every minted protocol event that has no legacy frame', async () => {
    const run = await runOnce(false);
    const drained = new Set(drainedFrameTypes(run.frames));

    // Not all eleven appear in every run, so the assertion is over the MINTED
    // subset: for each minted member, no drained frame corresponds to it. The
    // minted subset is checked against the observed run rather than assumed, so
    // a producer that started emitting one of these would be caught here rather
    // than silently entering the allow-list.
    const minted = NO_LEGACY_FRAME.filter((type) => nativeCount(run.native, type) > 0);
    expect(minted).toContain('run.started');
    expect(minted).toContain('assistant.message_finalized');
    for (const type of minted) {
      expect(drained.has(type)).toBe(false);
    }
  });

  // ==========================================================================
  // Layer C — the CONTROL. The engine and the spine are not the bottleneck.
  // ==========================================================================

  it('hands a bound persistence the very events the production path discards', async () => {
    const run = await runOnce(true);
    const appended = run.durableAppends.flat();

    // Same real driver, same real engine, same real spine — one bound sink.
    expect(nativeCount(appended, 'run.started')).toBe(1);
    expect(nativeCount(appended, 'assistant.message_finalized')).toBe(1);
    expect(nativeCount(appended, 'run.completed')).toBe(1);
    // Identity is intact on the way to the sink, which is what lets a Host
    // reject a foreign run rather than trust the label on it.
    for (const envelope of appended) {
      expect(envelope.runId).toBe(run.native[0]?.runId);
      expect(typeof envelope.seq).toBe('number');
    }
    // And the terminal reached the sink too — which is precisely why S0 has to
    // freeze WHO settles, not merely whether the event arrives.
    expect(run.durableCompletes).toHaveLength(1);

    // The production shape writes nothing durable at all.
    const production = await runOnce(false);
    expect(production.durableAppends).toHaveLength(0);
    expect(production.durableCompletes).toHaveLength(0);
  });

  // ==========================================================================
  // Layer D — the CONTRACT for S1. Expected to FAIL today.
  // See the file header: delete `it.fails` when S1 lands.
  // ==========================================================================

  it.fails('CONTRACT (S1): every durable event the engine mints reaches the Host ledger', async () => {
    const run = await runOnce(false);

    // The Host's authoritative record for a run is derived from what the worker
    // sent it. Today that is the drained frame set, so a durable event with no
    // legacy frame is durable only inside a process that is about to exit.
    const durableNoFrame = NO_LEGACY_FRAME.filter((type) => nativeCount(run.native, type) > 0);
    expect(durableNoFrame).toEqual([]);
  });

  it.fails('CONTRACT (S1): a production-shaped run commits its terminal exactly once', async () => {
    const run = await runOnce(false);

    // Today the run reaches a terminal in the worker (the spine settled it) AND
    // the Host independently settles from the drained `done` frame, with the
    // store's CAS picking the durable winner. `run:complete` reaches the Host's
    // ledger only when the Host settles it; the worker's own settle never does.
    expect(run.terminal).not.toBeNull();
    expect(run.durableCompletes).toHaveLength(1);
  });
});
