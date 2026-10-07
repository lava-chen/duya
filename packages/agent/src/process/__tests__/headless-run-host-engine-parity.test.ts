/**
 * Plan 610 S4c-d2b: the headless / CLI path runs on the ENGINE.
 *
 * ## What this file is
 *
 * The flip's own proof. `createAgentExecutionChannel` used to call
 * `agent.streamChat(...)`, which drove `DuyaAgent`'s legacy turn generator; it
 * now calls `driveRunWithEngine`, the same driver `agent-process-entry.ts`
 * calls. That change is invisible to every existing headless test, because both
 * paths produce the same `chat:*` frames through the same codec and the same run
 * layer -- which is the point of the design and also why it needs its own proof.
 *
 * So this file does not assert that a run happened. It asserts three things that
 * ONLY the engine path can produce, and it asserts them against evidence the
 * legacy path provably could not have left behind.
 *
 * ## The three discriminators, and why each one cannot be faked
 *
 *  1. **`assistant.usage` in the caller's ledger.** `convertSSEToAgentMessage`
 *     returns `null` for the provider's `result` event (`sse-frame-codec.ts:242`),
 *     so on the legacy path the headless host DROPPED every usage frame and the
 *     CLI's `token_usage` display had nothing to read. On the engine path the
 *     driver's `surface.projectUsageResults` emits the `result` frame itself, and
 *     the translator maps it to `assistant.usage`. No legacy build can record
 *     this event, because the codec that would have carried it refuses the type.
 *  2. **A tool-side-effect journal on disk.** `RunEngineImpl.#ticket` refuses to
 *     dispatch anything it cannot ticket, so the ledger is required rather than
 *     optional. The legacy loop has no such artifact at all. Read off the
 *     FILESYSTEM, so it cannot be satisfied by a counter the harness kept.
 *  3. **The driver's `driveRunWithEngine` call, counted.** Comment-stripped and
 *     call-shaped, so the prose in this module's own header -- which names both
 *     symbols constantly -- cannot satisfy the count on its own.
 *
 * ## Why the doubles are gone, and what replaced them
 *
 * `HeadlessAgent` used to be a two-method port (`streamChat` + `interrupt`),
 * which let these tests hand the host a scripted agent and exercise the run layer
 * with no provider. The engine needs the run LIFECYCLE instead, so the port is
 * now the real `duyaAgent` and the substitute moved DOWN a level: `@duya/ai`'s
 * `createAIClient` is scripted, which is where the other engine proofs in this
 * directory put their double too. The agent, the journal, the registry, the
 * composition, the engine and the ledger are all production ones.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FIRST_EPOCH, type PermissionPolicyMode, type RunId } from '@duya/agent-protocol';
import { projectToLegacyFrame } from '@duya/agent-runtime';
import type { SSEEvent } from '../../types.js';
import { ledgerFile } from '../tool-side-effect-ledger.js';
import { stripComments } from '../../../../../scripts/architecture/strip-comments.mjs';

// ============================================================================
// The markers. Each is produced by PRODUCT code, never by this file.
//
// Declared BEFORE the scripted provider, whose hoisted factory names
// `PROBE_TOOL` while building `SCRIPTS` at module-evaluation time: a `const`
// below that point would be in its TDZ there and throw on import rather than
// fail an assertion.
// ============================================================================

/** The tool the run calls. It writes a file; that file is the evidence. */
const PROBE_TOOL = 'headless_probe';
const PROBE_ANSWER = 'HEADLESS-PROBE-ANSWER';
/** A tool reachable ONLY through `intent.toolRegistry`, so its presence at the
 *  provider is evidence that the run layer's option bag survived the flip. */
const REGISTRY_ONLY_TOOL = 'registry_only_tool';
const PROMPT = 'call the probe and report what it says';
const SESSION_ID = 's-headless-engine-parity';
const RUN_ID = 'run-headless-engine-parity-1';
const TEST_NS = 'headless-engine-parity';

// ============================================================================
// The scripted PROVIDER. The only fake, and it stands in for nothing under test.
// ============================================================================

/** One provider call: the messages it was asked about and the tools it was offered. */
interface ProviderRequest {
  readonly toolNames: readonly string[];
  readonly wire: string;
}

let requests: ProviderRequest[] = [];

const DONE: SSEEvent = { type: 'done', reason: 'end_turn' };
const USAGE = { input_tokens: 11, output_tokens: 7, total_tokens: 18 };

/**
 * Turn 1 calls the probe; turn 2 reports and stops.
 *
 * Two turns is the minimum that can tell "the tool ran" from "the tool ran AND
 * its result came back into the conversation".
 */
const SCRIPTS: readonly (readonly SSEEvent[])[] = [
  [
    { type: 'text', data: 'calling the probe' },
    { type: 'tool_use', data: { id: 'hp-t1', name: PROBE_TOOL, input: { value: 'alpha' } } },
    { type: 'result', data: USAGE },
    { type: 'done', reason: 'tool_use' },
  ],
  [{ type: 'text', data: 'the probe reported' }, { type: 'result', data: USAGE }, DONE],
];

vi.mock('@duya/ai', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const delegating = {
    streamChat(messages: unknown[], options?: Record<string, unknown>) {
      const rows = messages as { role?: string; content?: unknown }[];
      requests.push({
        toolNames: ((options?.tools ?? []) as { name?: string }[]).map((t) => t?.name ?? ''),
        wire: rows.map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content))).join('\n'),
      });
      const script = SCRIPTS[Math.min(requests.length - 1, SCRIPTS.length - 1)];
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

vi.mock('../../ipc/db-client.js', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const messageDb = actual.messageDb as Record<string, unknown>;
  return {
    ...actual,
    messageDb: {
      ...messageDb,
      append: () => Promise.resolve({ success: true, count: 1 }),
    },
  };
});

// ============================================================================
// Source-level helpers. The gate's own stripper, so the counts below cannot
// disagree with CI's.
// ============================================================================

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HOST_SOURCE = path.join(HERE, '..', 'headless-run-host.ts');

function code(file: string): string {
  return stripComments(readFileSync(file, 'utf8')).text;
}

function occurrences(pattern: RegExp, text: string): number {
  return (text.match(new RegExp(pattern.source, 'g')) ?? []).length;
}

// ============================================================================
// The offline host
// ============================================================================

const PRE_EXISTING = new Set(process.listeners('message'));
const { duyaAgent } = await import('../../agent/DuyaAgent.js');
const { Journal } = await import('../../journal/Journal.js');
const { initDbClient } = await import('../../ipc/db-client.js');
const { ToolRegistry } = await import('../../tool/registry.js');
const { createHeadlessRunHost, createAgentExecutionChannel, buildHeadlessManifest } = await import(
  '../headless-run-host.js'
);

let dbListener: ((m: unknown) => void) | null = null;
let realSend: typeof process.send | undefined;
const originalEnv = { ...process.env };
const tempDirs: string[] = [];

function tempDir(prefix: string): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

/** Answer the DB actions a turn reaches for, through the pool's own channel. */
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
    const result = req.action === 'mailbox:claimBatch' ? { rows: [], claimTokens: [] } : null;
    setImmediate(() => dbListener?.({ type: 'db:response', id: req.id, success: true, result }));
    return true;
  }) as unknown as typeof process.send;
}

beforeEach(() => {
  vi.stubEnv('DUYA_TEST', '1');
  vi.stubEnv('DUYA_TEST_NAMESPACE', TEST_NS);
  process.env.DUYA_E2E_DISABLE_LLM = '1';
  process.env.DUYA_SESSIONS_ROOT = '';
  process.env.DUYA_MEMORY_ROOT = '';
  requests = [];
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
// One run
// ============================================================================

interface Proof {
  readonly events: readonly { seq: number; payload: { type: string } }[];
  readonly frames: readonly { type: string }[];
  readonly terminal: { status: string; error?: { message: string } };
  readonly ledgerDir: string;
  readonly ledgerJournals: readonly string[];
  readonly probeFile: string;
  readonly providerRequests: readonly ProviderRequest[];
  readonly enforcedMode: string;
  readonly recordedMode: PermissionPolicyMode;
  readonly journalExists: boolean;
}

async function runHeadless(
  options: {
    readonly permissionMode?: PermissionPolicyMode;
    /**
     * The mode the AGENT is constructed with, when it must differ from the mode
     * the intent records. That divergence is the measurement in the last block.
     */
    readonly agentMode?: PermissionPolicyMode;
  } = {},
): Promise<Proof> {
  installFakeDbIpc();

  const workspaceDir = tempDir('duya-headless-ws-');
  const ledgerDir = tempDir('duya-headless-ledger-');
  const probeFile = path.join(workspaceDir, 'probe-ran.txt');
  const runId = RUN_ID as RunId;

  const agent = new duyaAgent({
    apiKey: 'test-key',
    model: 'claude-test',
    provider: 'anthropic',
    sessionId: SESSION_ID,
    workingDirectory: workspaceDir,
    permissionMode: options.agentMode ?? options.permissionMode ?? 'default',
  });
  agent.journal = new Journal({ sessionId: SESSION_ID });

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

  // The registry the run layer carries as an OPAQUE option is NOT built here:
  // `RunController.start` canonicalises `RunStartInput.options` to compute the
  // run's input revision, and `runInputRevision` refuses any non-plain object, so
  // a real `ToolRegistry` on that field stops the run before the channel is ever
  // reached. That refusal is pre-existing and is pinned by its own test below;
  // the channel's own forwarding of the bag is proven against the channel
  // directly, which is the layer that owns the forward.
  void ToolRegistry;

  const host = createHeadlessRunHost({
    agent,
    mintRunId: () => runId,
    now: () => 1_700_000_000_000,
    ledgerDir,
  });

  const run = await host.start({
    prompt: PROMPT,
    sessionId: SESSION_ID,
    cwd: workspaceDir,
    model: 'claude-test',
    providerId: 'anthropic',
    maxTurns: 4,
    ...(options.permissionMode === undefined ? {} : { permissionMode: options.permissionMode }),
  });

  const events: { seq: number; payload: { type: string } }[] = [];
  for await (const envelope of run.events()) events.push(envelope);
  const terminal = await run.terminal;

  await agent.journal.flush();

  // The frames, projected by the runtime's OWN projector -- the same
  // `projectToLegacyFrame` `run.frames()` calls. Reached rather than
  // reimplemented, and read off the envelopes already collected rather than by
  // draining `run.frames()` as well: `handle.events()` is one stream, so a
  // second pass over it yields nothing and a test that called both would be
  // asserting against an empty generator.
  const frames = events
    .map((envelope) => projectToLegacyFrame(envelope))
    .filter((frame): frame is { type: string } => frame !== null);

  const journal = ledgerFile({ dir: ledgerDir, runId, runEpoch: FIRST_EPOCH });
  return {
    events,
    frames,
    terminal,
    ledgerDir,
    ledgerJournals: existsSync(ledgerDir) ? readdirSync(ledgerDir) : [],
    probeFile,
    providerRequests: requests,
    // The mode the PERMISSION GATE reads, which is the agent's own live field.
    enforcedMode: agent.getPermissionMode(),
    recordedMode: run.manifest.permissionPolicy.mode,
    journalExists: existsSync(journal),
  };
}

/**
 * Build a real agent plus the one registry that exists nowhere but an option bag.
 *
 * Used by the tests that exercise the CHANNEL directly, because the controller
 * will not accept a `ToolRegistry` on `RunStartInput.options` at all (see the
 * pinned refusal below).
 */
async function agentWithCanaryRegistry(
  ledgerDir: string,
  cwd: string,
): Promise<{ agent: InstanceType<typeof duyaAgent>; registry: InstanceType<typeof ToolRegistry> }> {
  const agent = new duyaAgent({
    apiKey: 'test-key',
    model: 'claude-test',
    provider: 'anthropic',
    sessionId: SESSION_ID,
    workingDirectory: cwd,
    permissionMode: 'default',
  });
  agent.journal = new Journal({ sessionId: SESSION_ID });
  void ledgerDir;

  const registry = new ToolRegistry();
  registry.register(
    {
      name: REGISTRY_ONLY_TOOL,
      description: 'reachable only through the run input option bag',
      input_schema: { type: 'object', properties: {} },
    } as never,
    { execute: async () => ({ ok: true, result: 'unused' }) } as never,
  );
  return { agent, registry };
}

// ============================================================================
// 1. The driver, counted
// ============================================================================

describe('S4c-d2b — the headless channel drives the engine, not the legacy loop', () => {
  it('calls the engine driver and no longer reaches the turn loop', () => {
    const src = code(HOST_SOURCE);

    // Zero `agent.streamChat(`. This is the exact literal the consumer census
    // registers against this file, so it is the thing the flip removes.
    expect(occurrences(/\bagent\.streamChat\s*\(/g, src)).toBe(0);
    // Exactly one driver call. Counted call-shaped so the import line -- which
    // carries the name but no `(` -- cannot satisfy it.
    expect(occurrences(/\bdriveRunWithEngine\s*\(/g, src)).toBe(1);
  });

  it('keeps the legacy loop reachable from the host module for no other reason', () => {
    // A guard against the failure mode where the flip "passes" because the
    // executor vanished: the module still names the real agent and still drives
    // it, just through the engine.
    const src = code(HOST_SOURCE);
    expect(occurrences(/\bdriveRunWithEngine\b/g, src)).toBeGreaterThan(0);
    expect(occurrences(/\bagent\.interrupt\s*\(/g, src)).toBe(1);
  });
});

// ============================================================================
// 2. What only the engine path can produce
// ============================================================================

describe('S4c-d2b — evidence the legacy path could not have left', () => {
  it('records assistant.usage, the frame the legacy codec provably dropped', async () => {
    const proof = await runHeadless();
    const types = proof.events.map((e) => e.payload.type);

    // `convertSSEToAgentMessage` returns null for `result`, so the legacy host
    // forwarded no usage at all and this event was unreachable on this path. It
    // arrives now because the driver's surface emits the `result` frame itself.
    expect(types).toContain('assistant.usage');

    // And it survives the round trip to the caller's own frame vocabulary, which
    // is what `cli/index.ts`'s `--print`/`--format json` paths read.
    expect(proof.frames.map((f) => f.type)).toContain('token_usage');
  });

  it('writes a tool-side-effect journal, because the engine refuses unticketed calls', async () => {
    const proof = await runHeadless();

    // The artifact is on the FILESYSTEM, named by the run id and the first epoch.
    // The legacy loop has no such file, so this is not satisfiable by the
    // pre-flip build.
    expect(proof.ledgerJournals).toHaveLength(1);
    expect(proof.ledgerJournals[0]).toBe(`${RUN_ID}.${FIRST_EPOCH}.jsonl`);
    const journal = readFileSync(
      ledgerFile({ dir: proof.ledgerDir, runId: RUN_ID as RunId, runEpoch: FIRST_EPOCH }),
      'utf-8',
    );
    // The tool really was ticketed, so this is a record of a dispatch and not an
    // empty file the harness happened to create.
    expect(journal).toContain(PROBE_TOOL);
  });

  it('runs the tool, and the tool left evidence on disk', async () => {
    const proof = await runHeadless();

    // The probe's own write. Not a frame, not a counter, not the journal.
    expect(existsSync(proof.probeFile)).toBe(true);
    expect(readFileSync(proof.probeFile, 'utf-8')).toBe(PROBE_ANSWER);

    // The tool leg is LIVE. `RunEngineImpl` reports `completed` for a run that
    // dispatched nothing at all (the mute-pipeline trap), so the two event types
    // are what distinguish "the engine executed the call" from "the engine
    // completed a pipeline with no calls in it".
    const types = proof.events.map((e) => e.payload.type);
    expect(types).toContain('tool.call_started');
    expect(types).toContain('tool.call_completed');
  });

  it('carries the run input option bag through to the engine tool surface', async () => {
    // The P10 guarantee has to survive the flip: `input.options.toolRegistry`
    // crosses the channel and `beginTurnAssembly` resolves it into the turn's
    // declared tools. `REGISTRY_ONLY_TOOL` exists on no catalog but that
    // registry, so finding it in the provider's own tool list is the claim.
    //
    // Driven against the CHANNEL rather than through `HeadlessRunHost.start`,
    // because the controller refuses this option entirely -- see the pinned
    // refusal in the next test. Testing it here is the honest split: the forward
    // is the channel's, the refusal is the controller's.
    installFakeDbIpc();
    const workspaceDir = tempDir('duya-headless-bag-ws-');
    const ledgerDir = tempDir('duya-headless-bag-ledger-');
    const { agent, registry } = await agentWithCanaryRegistry(ledgerDir, workspaceDir);

    const channel = createAgentExecutionChannel(agent, {
      now: () => 1_700_000_000_000,
      ledgerDir,
    });
    const runId = 'run-headless-bag-1' as RunId;
    const manifest = buildHeadlessManifest(
      {
        prompt: PROMPT,
        sessionId: SESSION_ID,
        cwd: workspaceDir,
        model: 'claude-test',
        providerId: 'anthropic',
        maxTurns: 4,
      },
      runId,
    );
    const frames: Record<string, unknown>[] = [];
    let ended = false;
    await channel.start(
      manifest,
      {
        prompt: PROMPT,
        sessionId: SESSION_ID,
        options: { toolRegistry: registry },
        revision: 'headless-bag-1',
      },
      {
        frame: (raw) => frames.push(raw),
        end: () => {
          ended = true;
        },
      },
    );
    // `start` returns the handle before the turn ends, so the pump is awaited
    // through the frames themselves rather than through the returned promise.
    await vi.waitFor(() => expect(ended).toBe(true), { timeout: 10_000 });

    const offered = requests[0]?.toolNames ?? [];
    expect(offered).toContain(REGISTRY_ONLY_TOOL);
    await agent.journal.flush();
  });

  it('keeps a caller-supplied registry OFF the canonical-JSON boundary', async () => {
    // This refusal used to be pinned HERE, deliberately, as a defect someone
    // else owned: `RunController.start` hashes the run's input with
    // `runInputRevision`, whose `asJson` rejects any non-plain object, so a real
    // `ToolRegistry` on `RunStartInput.options` stopped the run BEFORE the
    // channel was reached and `cli/index.ts`'s `runTask` — which passes exactly
    // that — could not start a run at all.
    //
    // It is FIXED, and the fix is that a registry is no longer a run INPUT: the
    // host freezes `options: {}` and carries the registry on its own wiring
    // member. So a caller that still puts one in the intent cannot smuggle it
    // onto the boundary, and the executor is left with the AGENT's own registry
    // — which is what the offered tool names below show.
    installFakeDbIpc();
    const workspaceDir = tempDir('duya-headless-refusal-ws-');
    const ledgerDir = tempDir('duya-headless-refusal-ledger-');
    const { agent, registry } = await agentWithCanaryRegistry(ledgerDir, workspaceDir);
    const host = createHeadlessRunHost({
      agent,
      mintRunId: () => 'run-headless-refusal-1' as RunId,
      now: () => 1_700_000_000_000,
      ledgerDir,
    });

    const run = await host.start({
      prompt: PROMPT,
      sessionId: SESSION_ID,
      cwd: workspaceDir,
      model: 'claude-test',
      providerId: 'anthropic',
      toolRegistry: registry,
    });

    // The refusal is gone: the run opens.
    await vi.waitFor(() => expect(requests.length).toBeGreaterThan(0), { timeout: 10_000 });
    expect((await run.terminal).status).toBe('completed');
    // And the executor kept the AGENT's own registry -- observed the way every
    // other row in this file observes the executor, off the tools the provider
    // was actually offered. The canary tool exists only in the CALLER's
    // registry, so its absence is what "did not cross" looks like from here,
    // and the agent's own tools being offered is what "the turn ran on the
    // agent's registry" looks like.
    expect(requests[0]?.toolNames ?? []).not.toContain(REGISTRY_ONLY_TOOL);
    expect(requests[0]?.toolNames ?? []).toContain('tool_invoke');
    await agent.journal.flush();
  });
});

// ============================================================================
// 3. The obligations the channel still owns above the driver
// ============================================================================

describe('S4c-d2b — the channel keeps the frame obligations the driver does not own', () => {
  it('finalises the assistant message BEFORE the terminal, by holding done', async () => {
    const proof = await runHeadless();
    const types = proof.events.map((e) => e.payload.type);

    // The engine does not produce `chat:message_finalized` and the projector has
    // no arm for it; the CHANNEL builds it after the drive. The ordering is the
    // whole point: forward `done` inline and the run terminates before the
    // message it finalises arrives, so the run layer drops it as late.
    expect(types).toContain('assistant.message_finalized');
    expect(types.indexOf('assistant.message_finalized')).toBeGreaterThan(
      types.lastIndexOf('assistant.text_block'),
    );
    expect(types.indexOf('assistant.message_finalized')).toBeLessThan(types.indexOf('run.completed'));
    expect(types[types.length - 1]).toBe('run.completed');
    expect(proof.terminal.status).toBe('completed');
  });

  it('numbers the run densely with a runtime-minted seq', async () => {
    const proof = await runHeadless();
    const seqs = proof.events.map((e) => e.seq);
    expect(seqs).toEqual(seqs.map((_, i) => i + 1));
    expect(new Set(seqs).size).toBe(seqs.length);
  });
});

// ============================================================================
// 4. The permission mode, measured per mode
// ============================================================================

describe('S4c-d2b — which permission mode the engine actually enforces here', () => {
  const MODES: readonly PermissionPolicyMode[] = [
    'default',
    'acceptEdits',
    'bypassPermissions',
    'plan',
    'dontAsk',
  ];

  it.each(MODES)('records %s in the manifest', async (mode) => {
    const proof = await runHeadless({ permissionMode: mode });
    // The channel reads the mode off the frozen manifest, so the record the run
    // carries is the intent's own value rather than a re-derivation.
    expect(proof.recordedMode).toBe(mode);
  });

  it.each(MODES)('enforces %s through the agent session mode, not the manifest', async (mode) => {
    const proof = await runHeadless({ permissionMode: mode });

    // THE measurement. `RunEngineImpl.#permissionMode` stamps the manifest's mode
    // onto `ApprovalRequest` (a LABEL -- `run-engine.ts:2309` says so outright),
    // while the DECISION is `ports.approval.authorize` -> `gateRunApproval` ->
    // `assembly.canUseTool`, and that closure reads `agent.getPermissionMode()`.
    //
    // So there are two accounts of the mode on this path and they are two
    // different things. This host wires only the first: it records the intent's
    // mode on the manifest, and the gate consults the agent's field, which
    // `duyaAgent`'s constructor set. They AGREE here only because this run
    // constructs the agent with the same mode it records -- which is exactly the
    // condition under which the agreement means anything.
    //
    // Stated as a measurement rather than a passing assertion so the next reader
    // does not mistake it for "the host enforces its recorded mode": it does not,
    // and nothing on this path calls `setPermissionMode` to make it.
    expect(proof.enforcedMode).toBe(mode);
    expect(proof.recordedMode).toBe(proof.enforcedMode);
  });

  it('MEASURED: the intent mode alone does NOT change what is enforced', async () => {
    // THE measurement the previous rows set up, and the one a reader must not
    // mistake for the opposite claim.
    //
    // An agent constructed in `default` whose INTENT records `plan` enforces
    // `default`. The recorded mode and the enforced mode are therefore two
    // DIFFERENT accounts, and this host wires only the first.
    //
    // Nothing on the headless path calls `agent.setPermissionMode`: the engine
    // asks `ports.approval.authorize`, `gateRunApproval` turns that into
    // `assembly.canUseTool`, and that closure reads the AGENT's own live field.
    // So `intent.permissionMode` reaches the manifest (the record) and the run
    // INPUT (the label the engine stamps on `ApprovalRequest`) and stops there.
    //
    // Consequence for a caller: `HeadlessRunIntent.permissionMode` does not
    // narrow what the headless run may do. That is the PRE-EXISTING shape -- the
    // legacy path forwarded a mode nowhere either -- so this is not a regression
    // introduced by the flip, but it IS the thing that has to be fixed before
    // the mode can be trusted on this host, and it is fixed in
    // `packages/agent/src/cli/index.ts` (where the agent is constructed) rather
    // than in this slice's owned files.
    const proof = await runHeadless({ permissionMode: 'plan', agentMode: 'default' });

    expect(proof.recordedMode).toBe('plan');
    expect(proof.enforcedMode).toBe('default');
  });

  it('MEASURED: the run INPUT carries the mode, so the engine never falls back to default', async () => {
    // The other half. The label the engine stamps is read off
    // `input.options.permissionMode` (`RunEngineImpl.#permissionMode`), and
    // `buildLegacyRunInput` fills it from `facts.permissionMode` -- which this
    // channel supplies from `manifest.permissionPolicy.mode`. Asserted on the
    // composition directly because nothing on the run path exposes the engine's
    // internal input, and a claim about it deserves the direct measurement
    // rather than an inference from the manifest agreeing with itself.
    const { buildLegacyRunInput } = await import('../run-composition.js');

    for (const mode of MODES) {
      const input = buildLegacyRunInput(
        {
          runId: RUN_ID as RunId,
          cwd: process.cwd(),
          model: 'claude-test',
          providerId: 'anthropic',
          sessionId: SESSION_ID,
          projectId: null,
          revision: 'r',
          catalogRevision: 'c',
          permissionMode: mode,
        },
        { role: 'user', id: 'p1', content: 'x' },
        [],
      );
      const options = (input as unknown as { options: Record<string, unknown> }).options;
      expect(options['permissionMode']).toBe(mode);
    }
  });
});