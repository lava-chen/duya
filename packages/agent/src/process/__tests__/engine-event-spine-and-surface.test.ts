/**
 * Plan 610 D1 + D2 -- the event spine supplied for real, and the ONE `chat:*`
 * projection.
 *
 * ## What is under test, and why the harness is this shape
 *
 * Both deliverables are only meaningful bound together, so this drives the
 * PRODUCTION ASSEMBLY PATH end to end:
 *
 *   `createRunEventSpine` (D1) supplies `host.emitter` / `host.proposeTerminal`
 *   / `host.seqIndex` -> `composeLegacyRunPorts(agent, host)` (the one assembly
 *   path, unchanged) -> a real `RunEngineImpl` -> the spine's own emitter mints
 *   `seq` -> `createWorkerAdapterSurface` (D2) projects what was minted.
 *
 * The alternative -- calling the spine and the surface directly -- would prove
 * two functions return plausible values. This proves the seam production would
 * cross, with a real agent, a real manifest and a real tool-free turn.
 *
 * ## Why the oracles are sources that CAN disagree
 *
 * An earlier class of defect in this plan was a test named after a BEHAVIOUR
 * that asserted only a CONSEQUENCE which could not disagree with the code under
 * test. So, deliberately:
 *
 *  - Token accounting is checked against `parseUsageCall`
 *    (`packages/agent/src/process/call-usage.ts:30`) -- the ENTRY'S OWN parser,
 *    the code the billing ledger actually runs. If the engine published usage
 *    the entry cannot parse, these disagree and the test is red.
 *  - The projected frame's `type` is checked against `LEGACY_SSE_TYPES`, the
 *    contract the renderer reads, not against the projector's own output.
 *  - `seq` is read off the spine's ANNOUNCED envelopes. It is minted by
 *    `RunSession`, which is a different class from the engine that published
 *    the event, so a publisher that forgot to route through the emitter shows
 *    up as a missing sequence number rather than as a missing event.
 */

/**
 * The scripted provider. Emits ONE `result` frame carrying a real per-call
 * usage block, because the D3 measurement turns on what the engine does with
 * it and a provider that reported nothing would make every usage assertion
 * vacuously true.
 */
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import type { Message, SSEEvent } from '../../types.js';

/**
 * Captured BEFORE the dynamic imports below, and that order IS the fix.
 *
 * `initDbClient` registers its `message` listener as a side effect of loading
 * `db-client.js`. Snapshot the baseline after that load and the listener looks
 * pre-existing, so the filter below discards it and the fake IPC never gets a
 * responder. Snapshot first, and the db listener is correctly identified as the
 * one NEW listener.
 */
const PRE_EXISTING = new Set(process.listeners('message'));

/** The usage the scripted provider reports, and therefore what must survive. */
const PROVIDER_USAGE = { input_tokens: 120, output_tokens: 45, total_tokens: 165 };

const DONE: SSEEvent = { type: 'done', reason: 'end_turn' };

vi.mock('@duya/ai', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const delegating = {
    streamChat(_messages: Message[], options?: Record<string, unknown>) {
      const signal = options?.signal as AbortSignal | undefined;
      return (async function* () {
        for (const event of [
          { type: 'text', data: 'the model answered conversationally' },
          { type: 'result', data: { ...PROVIDER_USAGE } },
          DONE,
        ]) {
          if (signal?.aborted) {
            const err = new Error('The operation was aborted');
            err.name = 'AbortError';
            throw err;
          }
          yield event as SSEEvent;
        }
      })();
    },
  };
  return { ...actual, createAIClient: () => delegating, createAIClientWithRetry: () => delegating };
});

// The dynamic-import ORDER is load-bearing, copied from the proven harness in
// `engine-before-commit-phase.test.ts`: the agent module must be loaded AFTER
// the `@duya/ai` mock is installed.
const { duyaAgent } = await import('../../agent/DuyaAgent.js');
const { TurnPipelinePublisher } = await import('../../tool/turn-pipeline-publisher.js');
const { initDbClient } = await import('../../ipc/db-client.js');
const { composeLegacyRunPorts, createLegacyAssembleTurn, buildLegacyRunManifest, buildLegacyRunInput } =
  await import('../run-composition.js');
const { createRunEventSpine } = await import('../run-event-spine.js');
const { parseUsageCall } = await import('../call-usage.js');
const { convertSSEToAgentMessage } = await import('../sse-frame-codec.js');
import {
  LEGACY_SSE_TYPES,
  RunEngineImpl,
  createWorkerAdapterSurface,
  type RunEnginePorts,
  type RunInputSnapshot,
} from '@duya/agent-runtime';
import type { RunEventEnvelope, RunManifest } from '@duya/agent-protocol';
import type { LegacyRunFacts, LegacyRunHost } from '../run-composition.js';

const RUN_ID = 'run-610-d1d2' as never;
const SESSION_ID = 'sess-610-d1d2';
const AGENT_TEXT = 'the model answered conversationally';

// ── the offline DB host ──────────────────────────────────────────────────

let dbListener: ((m: unknown) => void) | null = null;
const originalEnv = { ...process.env };
let realSend: typeof process.send | undefined;

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
      throw new Error(`unexpected db action in the d1/d2 proof: ${req.action}`);
    }
    const result = req.action === 'mailbox:claimBatch' ? { rows: [], claimTokens: [] } : null;
    setImmediate(() => dbListener?.({ type: 'db:response', id: req.id, success: true, result }));
    return true;
  }) as unknown as typeof process.send;
}

beforeEach(() => {
  process.env.DUYA_E2E_DISABLE_LLM = '1';
  process.env.DUYA_SESSIONS_ROOT = '';
  process.env.DUYA_MEMORY_ROOT = '';
});

afterEach(() => {
  process.env = { ...originalEnv };
  process.send = realSend;
  vi.restoreAllMocks();
});

/** What one production-shaped run produced. */
interface Proof {
  /** Every envelope the SPINE announced, in mint order. */
  readonly announced: readonly RunEventEnvelope[];
  /** The candidate the engine proposed, as the SPINE recorded it. */
  readonly proposed: ReturnType<ReturnType<typeof createRunEventSpine>['proposedTerminal']>;
  /** The ports the engine actually ran on. */
  readonly ports: RunEnginePorts;
  /** The surface, bound to the same emitter the run published through. */
  readonly surface: ReturnType<typeof createWorkerAdapterSurface>;
}

/**
 * Drive a real `RunEngineImpl` over `composeLegacyRunPorts`, with the event
 * spine supplying the three host members a production run would have to supply.
 */
async function runOnce(): Promise<Proof> {
  installFakeDbIpc();
  const agent = new duyaAgent({
    apiKey: 'test-key',
    model: 'claude-test',
    provider: 'anthropic',
    sessionId: SESSION_ID,
    workingDirectory: process.cwd(),
    permissionMode: 'bypassPermissions',
  });
  (agent as unknown as { abortController: AbortController }).abortController = new AbortController();

  const promptText = 'do the thing';
  const turnContext = agent.assembleTurnContext({ sessionId: SESSION_ID } as never, promptText);
  agent.setMessages([
    ...agent.getMessages(),
    { id: 'p1', role: 'user', content: promptText, timestamp: Date.now(), seq_index: 0 } as never,
  ]);

  // D1. The spine is the run's ledger + stream + emitter, and the composition
  // reads its members exactly as it reads a hand-built host's.
  const announced: RunEventEnvelope[] = [];
  const spine = createRunEventSpine({
    runId: RUN_ID,
    sessionId: SESSION_ID,
    seqIndex: 1_700_000_000_000,
    now: () => 1_000,
    clock: () => 0,
    onAnnounce: (envelope) => announced.push(envelope as RunEventEnvelope),
  });

  const turnPipelines = new TurnPipelinePublisher();
  const handle = await agent.beginTurnAssembly({
    options: { sessionId: SESSION_ID } as never,
    prompt: promptText,
    appliedProfile: undefined,
    turnContext,
    publisher: turnPipelines,
  });

  const host: LegacyRunHost = {
    turnPipelines,
    assembleTurn: createLegacyAssembleTurn(handle),
    askApproval: async () => ({ allowed: true, scope: 'once' }),
    // The three members this slice supplies for real.
    emitter: spine.emitter,
    proposeTerminal: spine.proposeTerminal,
    seqIndex: spine.seqIndex,
    compaction: {
      decide: () => Promise.resolve({ kind: 'skip', reason: 'not under test' } as const),
      compact: () => Promise.resolve({ kind: 'declined', reason: 'not under test' } as const),
      nextCompactionId: () => 'cmp-d1d2',
    },
    wakeRun: false,
    sessionId: SESSION_ID,
    workingDirectory: process.cwd(),
  };

  // THE production assembly path. Unchanged by this slice, and reached through
  // exactly the arguments a production caller would pass.
  const composed: RunEnginePorts = composeLegacyRunPorts(agent, host);

  // D2. Bound to the SAME emitter the run published through, so the projection
  // is of this run's events rather than of a hand-made envelope.
  const surface = createWorkerAdapterSurface({
    emitter: spine.emitter,
    legacyFrameCodec: convertSSEToAgentMessage,
  });

  const facts: LegacyRunFacts = {
    runId: RUN_ID,
    cwd: process.cwd(),
    model: 'claude-test',
    providerId: 'anthropic',
    sessionId: SESSION_ID,
    projectId: null,
    revision: 'rev-d1d2',
    catalogRevision: agent.activeMCPRegistry.getCatalogRevision(),
    permissionMode: 'default',
  };
  const manifest: RunManifest = buildLegacyRunManifest(facts);
  const input: RunInputSnapshot = {
    ...buildLegacyRunInput(facts, { role: 'user', id: 'p1', content: promptText }, []),
    history: { kind: 'by_ref', digest: 'hist-d1d2', locator: 'agent://transcript' },
  } as unknown as RunInputSnapshot;

  const engine = new RunEngineImpl({ now: () => 1_000, defaultMaxTurns: 4 });
  await engine.execute({ manifest, input, signal: new AbortController().signal, ports: composed }).completed();
  turnPipelines.close();

  return { announced, proposed: spine.proposedTerminal(), ports: composed, surface };
}

describe('plan 610 D1+D2: the event spine and the chat:* projection', () => {
  it('mints a strictly increasing seq on every event the run published', async () => {
    const { announced } = await runOnce();

    // POSITIVE COUNT, read off the spine's own announcement path. Zero here
    // would mean the engine published nothing at all, which is why this is a
    // count and not a "contains" assertion.
    expect(announced.length).toBeGreaterThan(0);

    const seqs = announced.map((envelope) => envelope.seq);
    // Minted by `RunSession` -- a different class from the publisher, so a
    // route that bypassed the emitter shows up as a hole here.
    for (const seq of seqs) expect(typeof seq).toBe('number');
    for (let i = 1; i < seqs.length; i += 1) {
      expect(seqs[i]).toBeGreaterThan(seqs[i - 1] as number);
    }
  });

  it('records the engine\'s terminal proposal on the spine, and does not settle it', async () => {
    const { proposed, announced } = await runOnce();

    // The terminal PROPOSER reached the spine...
    expect(proposed).not.toBeNull();
    expect(typeof (proposed as { reason: string }).reason).toBe('string');

    // ...and it was ADVISORY: a proposal is not a terminal event. If the spine
    // settled on propose, the run would carry two endings.
    const terminals = announced.filter((e) => e.payload.type === 'run.completed' || e.payload.type === 'run.failed');
    expect(terminals).toHaveLength(0);
  });

  it('projects a published text event onto a frame the renderer\'s contract names', async () => {
    const { announced, surface } = await runOnce();

    const textEnvelope = announced.find((e) => e.payload.type === 'assistant.text_block' || e.payload.type === 'assistant.text_delta');
    expect(textEnvelope).toBeDefined();

    const frame = surface.surface.projectToLegacyFrame(textEnvelope as RunEventEnvelope) as {
      type: string;
      data?: { content?: string };
    };
    // The contract the renderer reads, not the projector's own output.
    expect(LEGACY_SSE_TYPES as readonly string[]).toContain(frame.type);
    // `data.content`, NOT `data` -- the documented wire lie
    // (`legacy-sse-contract.ts:22-27`).
    expect(frame.data?.content).toContain(AGENT_TEXT);
  });

  it('emits the `result` frame the entry\'s billing ledger reads, and it parses', async () => {
    const { announced, surface } = await runOnce();

    const usageEvent = announced.find((e) => e.payload.type === 'assistant.usage');
    expect(usageEvent).toBeDefined();

    // The premise of D2, asserted rather than assumed: the projector the
    // surface REACHES has no `result` arm, which is why the surface owns it.
    const sseFrame = surface.surface.projectToLegacyFrame(usageEvent as RunEventEnvelope) as { type: string } | null;
    expect(sseFrame?.type).toBe('token_usage');
    expect(sseFrame?.type).not.toBe('result');

    const results = surface.projectUsageResults((usageEvent as RunEventEnvelope).payload);
    expect(results).toHaveLength(1);

    // THE ORACLE: the entry's own parser. It is the code the billing ledger
    // actually runs (`agent-process-entry.ts:3166`), and it can disagree with
    // the engine -- a frame it returns null for is a frame that bills nothing.
    const parsed = parseUsageCall(results[0]!.data as unknown as Record<string, unknown>);
    expect(parsed).not.toBeNull();
    expect(parsed!.input_tokens).toBe(PROVIDER_USAGE.input_tokens);
    expect(parsed!.output_tokens).toBe(PROVIDER_USAGE.output_tokens);
    expect(parsed!.total_tokens).toBe(PROVIDER_USAGE.total_tokens);
  });

  it('binds the engine\'s store to the spine without dropping the host\'s progress mapper', async () => {
    const { ports, announced, surface } = await runOnce();

    const projectSubagentProgress = vi.fn(() => null);
    const before = announced.length;
    const bound = surface.surface.bindEmitter({ ...ports.events, projectSubagentProgress });

    // The inner store's optional method survives the binding. A store rebuilt
    // from the emitter instead of wrapping one would drop it, and the
    // consequence is named in `ports.ts:1054-1062`: an invisible dropped frame.
    bound.publish({
      type: 'assistant.status',
      message: 'spine-bound',
    } as never);

    expect(announced.length).toBeGreaterThan(before);
    expect(bound.projectSubagentProgress).toBe(projectSubagentProgress);
  });
});
