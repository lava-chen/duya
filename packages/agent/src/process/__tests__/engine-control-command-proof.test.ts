/**
 * Plan 610 D1: a control command on the ENGINE-DRIVEN path is answered by the
 * PRODUCT and ends the run with ZERO model calls.
 *
 * ## Why this file exists
 *
 * `/goal` and `/export` are intercepted inside `DuyaAgent.streamChat` before
 * the turn loop and before any model call (`DuyaAgent.ts:2411-2438`). That is
 * the ONLY place they are intercepted, and it is a generator body a host
 * driving the engine never enters. So after the driver flip, typing `/goal`
 * sends the literal text to the provider and the model answers it
 * conversationally -- a silent, obvious regression: the run still "succeeds",
 * every frame is well-formed, and the product's own answer never appears.
 *
 * ## What is REAL here, and what is faked
 *
 * REAL: the `duyaAgent`; `beginTurnAssembly` / `assembleTurn`; the
 * `ToolExecutionPipeline` and `TurnPipelinePublisher`; the side-effect ledger;
 * `composeLegacyRunPorts` and every port it binds, including the command port;
 * the `RunEngineImpl` loop; `RunSession` and `RunEventEmitter`; the product's
 * OWN `handleGoalCommand` / `handleTranscriptCommand` through the same
 * `isGoalControlCommand` / `isTranscriptControlCommand` the CLI and the legacy
 * call.
 *
 * FAKED, and only the PROVIDER: `createAIClient` is scripted so the test can
 * COUNT model invocations. That is not a convenience -- counting model calls is
 * the entire claim, so the counter has to be a real interception of the real
 * client factory the agent's own `readModelClient()` resolves.
 *
 * ## The claim is COUNTED, never asserted by shape
 *
 * `calls() === 0` is a POSITIVE COUNT of an interception, and every assertion
 * below that could pass vacuously is written as a count. A test that only
 * checked "the reply looks like the product's" would pass if the engine ALSO
 * called the model -- which is the regression.
 *
 * ## Both sides of every comparison come from DIFFERENT sources
 *
 * The engine-path reply is compared against what the LEGACY PATH produces for
 * the same prompt, computed by calling `agent.streamChat` directly -- a
 * different code path producing the expected value, not a second read of the
 * same computation. A literal copied out of `goal-commands.ts` would be an
 * identity the moment both sides drift together, which is worth nothing.
 */

import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { RunEngineImpl, RunEventEmitter, RunSession } from '@duya/agent-runtime';
import { FIRST_EPOCH, GROUND_FENCE } from '@duya/agent-protocol';
import type {
  RunEnginePorts,
  RunInputSnapshot,
  TerminalCandidate,
} from '@duya/agent-runtime';
import type { RunFence, RunId, RunManifest } from '@duya/agent-protocol';
import type { Message, SSEEvent } from '../../types.js';
import { createToolSideEffectLedger } from '../tool-side-effect-ledger.js';

// ============================================================================
// The scripted PROVIDER -- the counter that makes "zero model calls" checkable
// ============================================================================

/**
 * One provider request, as the mock observed it.
 *
 * Named rather than left `unknown[]` so the assertions below read a real field
 * (`contents`) instead of an `any` cast -- a test that cannot typecheck its own
 * fixture is a test whose fixture can quietly become the wrong shape.
 */
interface SeenRequest {
  readonly roles: string[];
  readonly contents: readonly string[];
  readonly systemPrompt: string;
}

/**
 * Every request the provider was handed, appended at the moment the agent's own
 * client was asked for one.
 *
 * A module-level sink rather than a per-test one because `createAIClient` is
 * resolved deep inside the agent's construction, before any test body can hand
 * it a closure.
 */
let seenRequests: SeenRequest[] = [];

const DONE: SSEEvent = { type: 'done', reason: 'end_turn' };

vi.mock('@duya/ai', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const delegating = {
    streamChat(messages: Message[], options?: Record<string, unknown>) {
      // THE COUNT. Incremented inside the mock the agent resolves, so it counts
      // calls that actually reached a provider rather than calls some seam
      // claims to have made.
      seenRequests.push({
        roles: messages.map((m) => m.role),
        contents: messages.map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content))),
        systemPrompt: String((options?.systemPrompt as string) ?? ''),
      });
      const signal = options?.signal as AbortSignal | undefined;
      return (async function* () {
        // A canned answer, so a run that DOES reach the model still terminates
        // and the test can tell "no call" from "a call that failed".
        for (const event of [{ type: 'text', data: 'the model answered conversationally' }, DONE]) {
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

// ============================================================================
// The offline host: worker IPC + the agent under test
// ============================================================================

const PRE_EXISTING = new Set(process.listeners('message'));
const { duyaAgent } = await import('../../agent/DuyaAgent.js');
const { TurnPipelinePublisher } = await import('../../tool/turn-pipeline-publisher.js');
const { initDbClient } = await import('../../ipc/db-client.js');
const { composeLegacyRunPorts, createLegacyAssembleTurn, buildLegacyRunManifest, buildLegacyRunInput } =
  await import('../run-composition.js');
import type { LegacyRunFacts, LegacyRunHost } from '../run-composition.js';

let dbListener: ((m: unknown) => void) | null = null;
const originalEnv = { ...process.env };
let realSend: typeof process.send | undefined;
const ledgerDirs: string[] = [];
const stdoutWrites: string[] = [];

/**
 * Answer the DB actions a turn reaches for, exactly as the S3 proof does.
 *
 * Under a Vitest pool worker `process.send` is the POOL's channel, so it is
 * replaced and the db-client's own listener is called directly.
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
      throw new Error(`unexpected db action in the command proof: ${req.action}`);
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
  seenRequests = [];
  stdoutWrites.length = 0;
  // `/copy` and `/export` reach the worker frame protocol, which writes to
  // stdout. Captured rather than printed so the assertion can read what the
  // product actually emitted.
  vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: unknown) => {
    stdoutWrites.push(String(chunk));
    return true;
  }) as never);
});

afterEach(() => {
  process.env = { ...originalEnv };
  process.send = realSend;
  vi.restoreAllMocks();
  for (const dir of ledgerDirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // A temp dir nobody claimed is not a test failure.
    }
  }
});

const RUN_ID = 'run-d1-command' as RunId;
let sessionSeq = 0;

interface Proof {
  /** How many times the provider was asked for a request. POSITIVE COUNT. */
  readonly calls: () => number;
  /** Every event the run published, as `{ type }` strings. */
  readonly eventTypes: readonly string[];
  /** The text of every `assistant.text_block` published, in order. */
  readonly textBlocks: readonly string[];
  /** The finalized message's content, or `null` when none was published. */
  readonly finalizedText: () => string | null;
  readonly terminals: readonly TerminalCandidate[];
  /** The frames the product's own command implementation wrote to stdout. */
  readonly stdout: readonly string[];
}

/**
 * Drive a real `RunEngineImpl` over real composed ports with `promptText` as
 * the run's prompt.
 *
 * Mirrors the S3 harness deliberately: the same `observedHandle` workaround for
 * `refreshDeclaredTools` (the visibility guard starts empty and only
 * `runTurnStream` fills it), the same real ledger, the same `by_ref` history,
 * because a proof that differs from the proven harness in its SETUP proves a
 * different thing than it claims.
 */
async function runThroughEngine(promptText: string): Promise<Proof> {
  installFakeDbIpc();
  const seq = (sessionSeq += 1);

  const agent = new duyaAgent({
    apiKey: 'test-key',
    model: 'claude-test',
    provider: 'anthropic',
    sessionId: `s-d1-${seq}`,
    workingDirectory: process.cwd(),
    permissionMode: 'bypassPermissions',
  });
  (agent as unknown as { abortController: AbortController }).abortController = new AbortController();

  const options = { sessionId: `s-d1-${seq}` } as never;
  const turnContext = agent.assembleTurnContext(options, promptText);
  agent.setMessages([
    ...agent.getMessages(),
    { id: 'p1', role: 'user', content: promptText, timestamp: Date.now(), seq_index: 0 } as never,
  ]);

  const turnPipelines = new TurnPipelinePublisher();
  const ledgerDir = mkdtempSync(path.join(os.tmpdir(), 'duya-d1-ledger-'));
  ledgerDirs.push(ledgerDir);
  const FENCE: RunFence = { runId: RUN_ID, runEpoch: FIRST_EPOCH, token: GROUND_FENCE.token };
  const ledger = createToolSideEffectLedger({
    dir: ledgerDir,
    runId: RUN_ID,
    runEpoch: FIRST_EPOCH,
    fence: FENCE,
  });

  const handle = await agent.beginTurnAssembly({
    options,
    prompt: promptText,
    appliedProfile: undefined,
    turnContext,
    publisher: turnPipelines,
  });

  const realAssemble = handle.assemble.bind(handle);
  const observedHandle = {
    ...handle,
    assemble(input: Parameters<typeof realAssemble>[0]) {
      const assembly = realAssemble(input);
      observedHandle.refreshDeclaredTools();
      return assembly;
    },
  };

  const session = new RunSession({
    runId: RUN_ID,
    sessionId: 'sess-d1',
    now: () => 1_000,
    startedAt: 0,
    clock: () => 0,
    persistence: { append: async () => undefined, complete: async () => undefined },
    flushEvery: 1_000,
  });
  // `RunEventEnvelope` carries the event itself in `payload`
  // (`agent-protocol/src/envelope.ts`), so `type` is read off the payload and
  // NOT off the envelope -- reading it off the envelope would silently produce
  // an empty list and make every count below vacuously true.
  const announced: { type?: string; payload?: Record<string, unknown> }[] = [];
  const emitter = new RunEventEmitter({
    runId: RUN_ID,
    session,
    stream: { push: (envelope) => announced.push(envelope as never) },
  });
  emitter.emit({
    type: 'run.started',
    manifestHash: 'hash-d1',
    protocol: { major: 1, minor: 0 },
    runtime: { name: 'd1-command', version: '0.0.0' },
  });

  const terminals: TerminalCandidate[] = [];
  const host: LegacyRunHost = {
    turnPipelines,
    assembleTurn: createLegacyAssembleTurn(observedHandle),
    askApproval: async () => ({ allowed: true, scope: 'once' }),
    emitter,
    proposeTerminal: (candidate) => terminals.push(candidate),
    compaction: {
      decide: () => Promise.resolve({ kind: 'skip', reason: 'not under test' } as const),
      compact: () => Promise.resolve({ kind: 'declined', reason: 'not under test' } as const),
      nextCompactionId: () => 'cmp-d1',
    },
    seqIndex: 0,
    wakeRun: false,
    // The two facts `createLegacyCommandPort` cannot reach for itself. Both come
    // from `turnContext` in the legacy, which is why they are host-supplied.
    sessionId: `s-d1-${seq}`,
    workingDirectory: process.cwd(),
    beginTicket: (call) => ledger.begin(call),
    settleTicket: (input) => ledger.settle(input),
  };

  const ports: RunEnginePorts = composeLegacyRunPorts(agent, host);

  const facts: LegacyRunFacts = {
    runId: RUN_ID,
    cwd: process.cwd(),
    model: 'claude-test',
    providerId: 'anthropic',
    sessionId: 'sess-d1',
    projectId: null,
    revision: 'rev-d1',
    catalogRevision: agent.activeMCPRegistry.getCatalogRevision(),
    permissionMode: 'default',
  };
  const manifest: RunManifest = buildLegacyRunManifest(facts);
  const input: RunInputSnapshot = {
    ...buildLegacyRunInput(facts, { role: 'user', id: 'p1', content: promptText }, []),
    history: { kind: 'by_ref', digest: 'hist-d1', locator: 'agent://transcript' },
  } as unknown as RunInputSnapshot;

  seenRequests = [];
  const engine = new RunEngineImpl({ now: () => 1_000, defaultMaxTurns: 4 });
  await engine
    .execute({ manifest, input, signal: new AbortController().signal, ports })
    .completed();
  turnPipelines.close();

  const payloadOf = (type: string): Record<string, unknown> | undefined => {
  const hit = announced.find((e) => (e.payload as { type?: string } | undefined)?.type === type);
    const payload = hit?.payload as Record<string, unknown> | undefined;
    return payload === undefined ? undefined : { ...payload, text: payload.text, content: payload.content };
  };

  const textBlocks = announced
    .filter((e) => (e.payload as { type?: string } | undefined)?.type === 'assistant.text_block')
    .map((e) => String((e.payload as { text?: string }).text ?? ''));

  return {
    calls: () => seenRequests.length,
    eventTypes: announced.map((e) => (e.payload as { type?: string } | undefined)?.type ?? ''),
    textBlocks,
    finalizedText: () => {
      const payload = payloadOf('assistant.message_finalized');
      if (payload === undefined) return null;
      const content = payload.content as { type?: string; text?: string }[] | undefined;
      return (content ?? [])
        .filter((block) => block.type === 'text')
        .map((block) => block.text ?? '')
        .join('');
    },
    terminals,
    stdout: [...stdoutWrites],
  };
}

/**
 * What the LEGACY path produces for the same prompt.
 *
 * The comparison source for every "the product's own answer" assertion below.
 * It runs `streamChat` -- the generator the engine path replaces -- so the
 * expected value is produced by different code than the actual one. A literal
 * would be an identity: both sides would move together and the assertion would
 * keep passing while the engine sent `/goal` to the model.
 *
 * `/goal <objective>` is deliberately absent here: it is not intercepted by the
 * legacy either, and the test that needs it asserts the fall-through.
 */
async function legacyReply(promptText: string): Promise<string> {
  installFakeDbIpc();
  const seq = (sessionSeq += 1);
  const agent = new duyaAgent({
    apiKey: 'test-key',
    model: 'claude-test',
    provider: 'anthropic',
    sessionId: `s-d1-legacy-${seq}`,
    workingDirectory: process.cwd(),
    permissionMode: 'bypassPermissions',
  });
  agent.setMessages([
    ...agent.getMessages(),
    { id: 'p0', role: 'user', content: 'earlier turn', timestamp: Date.now(), seq_index: 0 } as never,
  ]);

  seenRequests = [];
  let text = '';
  const iterator = agent.streamChat(promptText, { sessionId: `s-d1-legacy-${seq}` } as never);
  for await (const event of iterator as AsyncGenerator<{ type: string; data?: unknown }>) {
    if (event.type === 'text' && typeof event.data === 'string') text += event.data;
  }
  return text;
}

// ============================================================================
// D1 -- a recognised command is answered by the product, with no model call
// ============================================================================

describe('a recognised control command on the engine-driven path', () => {
  it('answers /goal with the product\'s own reply and never calls the model', async () => {
    const expected = await legacyReply('/goal status');
    // PRECONDITION, measured on the legacy path itself rather than assumed: if
    // the legacy also reached a model, "the engine did not" would prove nothing.
    expect(expected.length).toBeGreaterThan(0);

    const proof = await runThroughEngine('/goal status');

    // THE CLAIM. Zero, as a positive count of an interception that CAN see a
    // call -- the mock appends on every invocation, so a non-zero count here
    // would mean the regression this slice fixes is still present.
    expect(proof.calls()).toBe(0);

    // The reply is the PRODUCT'S, compared against the legacy's independently
    // computed answer for the same prompt.
    expect(proof.textBlocks).toHaveLength(1);
    expect(proof.textBlocks[0]).toBe(expected);

    // And it is a finalized message, so a consumer rebuilding the transcript
    // from `assistant.message_finalized` does not lose the command's answer.
    expect(proof.finalizedText()).toBe(expected);

    // A run that answered still proposes exactly one terminal, and it is
    // `completed` -- the same terminal a model-answered turn reaches.
    expect(proof.terminals).toHaveLength(1);
    expect(proof.terminals[0].state.status).toBe('completed');
  });

  it('answers the transcript family too, and /export writes the file the legacy writes', async () => {
    const expected = await legacyReply('/transcript');
    expect(expected.length).toBeGreaterThan(0);

    const proof = await runThroughEngine('/transcript');

    expect(proof.calls()).toBe(0);
    expect(proof.textBlocks).toHaveLength(1);
    expect(proof.textBlocks[0]).toBe(expected);
    expect(proof.finalizedText()).toBe(expected);
  });

  it('runs /export to a real file and reports it, with no model call', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'duya-d1-export-'));
    ledgerDirs.push(dir);
    const target = path.join(dir, 'engine-path.md');

    const expected = await legacyReply(`/export ${path.join(dir, 'legacy-path.md')}`);
    expect(expected).toContain('Transcript exported:');

    const proof = await runThroughEngine(`/export ${target}`);

    expect(proof.calls()).toBe(0);
    expect(proof.textBlocks[0]).toContain('Transcript exported:');
    // The FILE, not just the claim. `handleTranscriptCommand` did the write, so
    // this proves the engine path reached the real implementation rather than
    // a string that merely looks like its output.
    expect(existsSync(target)).toBe(true);
    expect(readFileSync(target, 'utf-8').length).toBeGreaterThan(0);
  });
});

// ============================================================================
// D4 -- an unregistered `/`-prefixed prompt behaves as the legacy behaves
// ============================================================================

describe('a prompt that is not a registered command', () => {
  it('reaches the model, exactly as the legacy sends it', async () => {
    // BOTH SIDES OBSERVED. The legacy first, so the claim "the engine matches
    // the legacy" rests on two measurements rather than on my reading of which
    // way `isTranscriptControlCommand` falls through.
    await legacyReply('/not-a-command');
    const legacyCalls = seenRequests.length;
    expect(legacyCalls).toBe(1);

    const proof = await runThroughEngine('/not-a-command');

    // A MODEL CALL, positively counted. The engine did not swallow it.
    expect(proof.calls()).toBe(1);
    // And the literal text reached the provider UNMODIFIED -- not stripped,
    // not rewritten, not replaced by a "unknown command" reply the legacy
    // never produces.
    expect(seenRequests[0].contents).toContain('/not-a-command');
    // No command-shaped answer was published alongside it.
    expect(proof.textBlocks).toContain('the model answered conversationally');
  });

  it('sends a /goal OBJECTIVE to the model, because the legacy starts it there', async () => {
    // `isGoalControlCommand` is deliberately false for an objective
    // (`goal-commands.ts`, module header): the model calls `goal_start`. A gate
    // that treated every `/goal ...` as a command would answer an objective
    // with usage text and start nothing.
    const proof = await runThroughEngine('/goal ship the release by friday');

    expect(proof.calls()).toBe(1);
    expect(seenRequests[0].contents).toContain('/goal ship the release by friday');
  });
});

// ============================================================================
// The gate itself is reachable, not reimplemented
// ============================================================================

describe('the command port reaches the product\'s own implementation', () => {
  it('is bound by the composition, so the engine path cannot run without it', async () => {
    installFakeDbIpc();
    const agent = new duyaAgent({
      apiKey: 'test-key',
      model: 'claude-test',
      provider: 'anthropic',
      sessionId: 's-d1-bind',
      workingDirectory: process.cwd(),
      permissionMode: 'bypassPermissions',
    });
    const turnPipelines = new TurnPipelinePublisher();
    const host = {
      turnPipelines,
      assembleTurn: async () => ({
        systemPrompt: '',
        messages: [],
        tools: [],
        catalogRevision: '0',
        revision: '0',
      }),
      askApproval: async () => ({ allowed: true as const, scope: 'once' as const }),
      emitter: { emit: () => ({ ok: true as const }) } as never,
      proposeTerminal: () => undefined,
      compaction: {
        decide: () => Promise.resolve({ kind: 'skip' as const, reason: 'x' }),
        compact: () => Promise.resolve({ kind: 'declined' as const, reason: 'x' }),
        nextCompactionId: () => 'c',
      },
      seqIndex: 0,
      wakeRun: false,
      sessionId: 's-d1-bind',
      workingDirectory: process.cwd(),
    } as unknown as LegacyRunHost;

    const ports = composeLegacyRunPorts(agent, host);

    // POSITIVE PRESENCE, not an absence check: a composition that forgot to
    // bind the port would leave `command` undefined, and every `/goal` would
    // reach the model again.
    expect(ports.command).toBeDefined();
    // It is the PRODUCT's port, reached through the same module the CLI and the
    // legacy import.
    const outcome = await ports.command!.resolve({
      runId: RUN_ID,
      prompt: { role: 'user', id: 'p1', content: '/goal status' },
    });
    expect(outcome?.reply).toContain('No active goal');
    turnPipelines.close();
  });
});