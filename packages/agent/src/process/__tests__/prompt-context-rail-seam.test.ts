/**
 * Plan 610 P6: the prompt-context rail's PRODUCERS are reachable without the
 * legacy generator, and what they produce reaches the MODEL REQUEST.
 *
 * ## What this file is for
 *
 * Before this slice an engine-driven `chat:start` silently dropped skill,
 * plugin, mention and hook-context injection. The rail (`promptContexts` /
 * `promptContextBlocks` / `injectedSkillParts`) had SEVEN producers, every one
 * of them inside `streamChat`'s prologue, and `beginRun` resets all three
 * without lifting one. Measured consequence on a real run with a
 * registry-free producer: the legacy path put 1 plugin-activation row on the
 * provider boundary and the engine path put 0 (`1 agent messages -> 2 model
 * messages` against `1 -> 1`).
 *
 * `producePromptContextRail` is the seam that closes it. This file is the
 * evidence that the seam FILLS the rail and that the ALREADY-PUBLIC drain
 * (`beginTurnAssembly`'s `injectHookContexts: true` projection) DELIVERS it.
 *
 * ## This file NEVER calls `streamChat`
 *
 * Every arm goes `beginRun` -> `producePromptContextRail` ->
 * `beginTurnAssembly` -> a real `RunEngineImpl` over `composeLegacyRunPorts`,
 * which is the route a driver takes. Driving `streamChat` instead would
 * exercise the generator's own prologue and could not tell a working seam from
 * a working generator. It also means this file adds NOTHING to the
 * `legacy-driver-surface.test.ts` census -- see that file's `EXPECTED` table.
 *
 * ## Both producer shapes are covered, because they differ
 *
 * `UserPromptSubmit` ASSIGNS the whole rail; the other six PUSH to it. A test
 * covering only a PUSH producer cannot see an ordering regression: if the ASSIGN
 * ran after a PUSH it would silently discard it and the push-only assertion
 * would still pass. So one run produces BOTH and the assertion requires both
 * markers on the wire -- which is the only assertion that pins the order.
 *
 * Both producers are deliberately registry-free, so both fire on a clean
 * machine:
 *
 *  - the PUSH one is plugin activation (`collectPluginInjections` needs only a
 *    non-empty `pluginId`),
 *  - the ASSIGN one is `UserPromptSubmit`, driven by a REAL hook subprocess so
 *    the seam's own `ConfigHooksRunner`, its `${VAR}` expansion and its
 *    fail-open handling are the product's.
 *
 * The skill and mention producers are NOT used as markers: they depend on
 * installed skills and on a config agent roster, so neither can pin a marker
 * on a machine that has none.
 *
 * ## Both sides of every comparison come from DIFFERENT sources
 *
 * The expected values are the PRODUCT'S OWN markers -- the plugin id the seam's
 * `collectPluginInjections` renders, and the string a real hook subprocess
 * wrote to stdout. The observed side is what the scripted PROVIDER received,
 * captured at the real `createAIClient` the agent resolves. Nothing here
 * compares the seam against a copy of itself.
 *
 * ## Positive presence only
 *
 * Every assertion is "the marker IS on the provider boundary", plus a positive
 * count of requests so the claim cannot be satisfied vacuously. No assertion is
 * "no error was raised" or "the block is absent elsewhere" -- both pass for a
 * seam that produces nothing.
 */

import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RunEngineImpl, RunEventEmitter, RunSession } from '@duya/agent-runtime';
import { FIRST_EPOCH, GROUND_FENCE } from '@duya/agent-protocol';
import type { Message, SSEEvent } from '../../types.js';

// ============================================================================
// The scripted PROVIDER -- the boundary this file asserts on
// ============================================================================

/**
 * One provider request, as the mock observed it.
 *
 * `contents` is stringified rather than left as `MessageContent[]` because the
 * rail rides the request as structured `runtime_context` rows, not as plain
 * strings.
 */
interface SeenRequest {
  readonly roles: string[];
  readonly contents: readonly string[];
}

let seenRequests: SeenRequest[] = [];

const DONE: SSEEvent = { type: 'done', reason: 'end_turn' };

vi.mock('@duya/ai', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const delegating = {
    streamChat(messages: Message[]) {
      seenRequests.push({
        roles: messages.map((m) => m.role),
        contents: messages.map((m) =>
          typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
        ),
      });
      return (async function* () {
        // One turn, ending immediately: this file is about the REQUEST's
        // contents, and a tool-dispatching script would add a second request
        // whose contents this file has no claim about.
        for (const event of [{ type: 'text', data: 'ok' }, DONE]) yield event as SSEEvent;
      })();
    },
  };
  return { ...actual, createAIClient: () => delegating, createAIClientWithRetry: () => delegating };
});

const PRE_EXISTING = new Set(process.listeners('message'));
const { duyaAgent } = await import('../../agent/DuyaAgent.js');
const { ToolRegistry } = await import('../../tool/registry.js');
const { initDbClient } = await import('../../ipc/db-client.js');
const { TurnPipelinePublisher } = await import('../../tool/turn-pipeline-publisher.js');
const { createToolSideEffectLedger } = await import('../tool-side-effect-ledger.js');
const {
  composeLegacyRunPorts,
  createLegacyAssembleTurn,
  buildLegacyRunManifest,
  buildLegacyRunInput,
} = await import('../run-composition.js');

// ============================================================================
// Isolation
// ============================================================================

/** Distinct per file, so a stale namespace cannot leak in or out. */
const TEST_NS = 'prompt-context-rail-seam-proof';

/**
 * The agent's config ROOT, which `readHooksConfig` resolves through `DUYA_TEST`
 * + `DUYA_TEST_NAMESPACE`.
 *
 * Mirrors `engine-post-tool-use-failure.test.ts` rather than importing it,
 * because `resolveConfigRoot` is a private helper of `hooks/config.ts` and a
 * test that guessed its layout would fail on any change to that derivation.
 * Spelled out because the alternative -- reading the developer's real
 * `~/.duya/config.toml` -- is not an option in a test.
 */
function namespaceRoot(): string {
  return path.join(os.homedir(), '.duya', 'test-namespaces', TEST_NS);
}

/** The marker only the hook subprocess contributes. */
const HOOK_MARKER = 'P6-HOOK-CONTEXT-MARKER';

/**
 * The marker only the plugin producer contributes.
 *
 * `collectPluginInjections` renders `pluginId` into the block body, so this
 * string cannot appear on the wire unless that producer ran.
 */
const PLUGIN_MARKER = 'p6-plugin-marker';

/**
 * A real `UserPromptSubmit` hook, as a real `command` hook.
 *
 * A SUBPROCESS rather than a stubbed `ConfigHooksRunner`, so the seam's own
 * runner construction, `${VAR}` expansion and fail-open handling are the
 * product's. Plain stdout becomes `additionalContext` verbatim
 * (`executor.ts`'s `parseCommandOutput`), which is why the script writes the
 * bare marker. Single quotes inside so the double-quoted `-e` argument
 * survives the platform shell on both Windows and POSIX.
 */
function writeHooksConfig(): void {
  const root = namespaceRoot();
  mkdirSync(root, { recursive: true });
  const command = `node -e "process.stdout.write('${HOOK_MARKER}')"`;
  writeFileSync(
    path.join(root, 'hooks.json'),
    JSON.stringify({
      hooks: {
        UserPromptSubmit: [{ hooks: [{ type: 'command', command }] }],
      },
    }),
    'utf-8',
  );
  writeFileSync(
    path.join(root, 'config.toml'),
    ['[hooks]', 'files = ["hooks.json"]', ''].join('\n'),
    'utf-8',
  );
}

const cleanupDirs: string[] = [];
const configRoot = namespaceRoot();

let dbListener: ((m: unknown) => void) | null = null;
let realSend: typeof process.send | undefined;

/**
 * Fake the worker DB IPC the agent opens on construction.
 *
 * Identical in shape to `turn-assembly-seam.test.ts`'s helper, including the
 * `process.listeners('message')` diff against the pre-import baseline: the
 * listener has to be the one `initDbClient` registered, not some other
 * listener that happened to be there first.
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
  vi.stubEnv('DUYA_TEST_NAMESPACE', TEST_NS);
  process.env.DUYA_E2E_DISABLE_LLM = '1';
  process.env.DUYA_SESSIONS_ROOT = '';
  process.env.DUYA_MEMORY_ROOT = '';
  seenRequests = [];
  const dir = mkdtempSync(path.join(os.tmpdir(), 'duya-p6-rail-'));
  cleanupDirs.push(dir);
  writeHooksConfig();
});

afterEach(() => {
  vi.unstubAllEnvs();
  process.send = realSend;
  vi.restoreAllMocks();
  for (const dir of cleanupDirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // A temp dir nobody claimed must not mask the real assertion failure.
    }
  }
  try {
    rmSync(configRoot, { recursive: true, force: true });
  } catch {
    // Same reasoning as above.
  }
});

// ============================================================================
// Fixtures
// ============================================================================

let sessionSeq = 0;
function makeAgent(): InstanceType<typeof duyaAgent> {
  sessionSeq += 1;
  return new duyaAgent({
    apiKey: 'test-key',
    model: 'claude-test',
    provider: 'anthropic',
    sessionId: `s-p6-rail-${sessionSeq}`,
    workingDirectory: process.cwd(),
    permissionMode: 'bypassPermissions',
  });
}

interface RailRun {
  /** What the provider was handed, per request. */
  readonly seen: readonly SeenRequest[];
  /** The `agent_progress` frames the seam RETURNED for a caller to route. */
  readonly railFrames: readonly SSEEvent[];
  readonly terminals: readonly string[];
}

/**
 * Drive one run through the SEAM, the public drain, and a real engine.
 *
 * The three agent-level calls are the whole point of this slice, in the order a
 * driver performs them:
 *
 *   1. `beginRun` -- resets the rail (and `handle.close` releases it).
 *   2. `producePromptContextRail` -- the seven producers, NEW seam. Nothing
 *      else fills the rail, so a driver that skipped this call is the exact
 *      regression this slice fixes.
 *   3. `beginTurnAssembly` -- projects with `injectHookContexts: true`, the
 *      consumptive drain that moves `promptContexts` into
 *      `promptContextBlocks` and injects them as `<system-reminder>` rows.
 *
 * The engine then makes the model call, so the assertion reads what a MODEL
 * receives rather than what a seam claims to have produced.
 */
async function runThroughSeam(): Promise<RailRun> {
  installFakeDbIpc();
  const registry = new ToolRegistry();
  const agent = makeAgent();

  // `streamChat` normally owns installing this; a host driving the engine does
  // it instead, exactly as the existing engine harnesses do.
  (agent as unknown as { abortController: AbortController }).abortController = new AbortController();

  const prompt = 'run the probe';
  const sessionId = `s-p6-rail-${sessionSeq}`;
  const chatOptions = {
    sessionId,
    toolRegistry: registry,
    mentionedPlugins: [
      { pluginId: PLUGIN_MARKER, name: 'p6 plugin', appConnections: [], mcpServers: [], skillNames: [] },
    ],
  };

  const handle = await agent.beginRun({ options: chatOptions as never, prompt });
  const railFrames = await agent.producePromptContextRail(handle);

  agent.setMessages([
    ...agent.getMessages(),
    { id: 'p1', role: 'user', content: prompt, timestamp: Date.now(), seq_index: 0 } as never,
  ]);

  const turnPipelines = new TurnPipelinePublisher();
  const assembly = await agent.beginTurnAssembly({
    options: chatOptions as never,
    prompt,
    appliedProfile: handle.appliedProfile,
    turnContext: handle.turnContext,
    publisher: turnPipelines,
  });

  const runId = 'run-p6-rail' as never;
  const session = new RunSession({
    runId,
    sessionId,
    now: () => 1_000,
    startedAt: 0,
    clock: () => 0,
    persistence: { append: async () => undefined, complete: async () => undefined },
    flushEvery: 1_000,
  });
  const terminals: { state: { status: string } }[] = [];
  const emitter = new RunEventEmitter({ runId, session, stream: { push: () => undefined } });
  emitter.emit({
    type: 'run.started',
    manifestHash: 'hash-p6',
    protocol: { major: 1, minor: 0 },
    runtime: { name: 'prompt-context-rail-seam', version: '0.0.0' },
  });

  // The real production ledger, because the engine REFUSES every dispatch
  // without one and a refused dispatch would still let the run complete -- the
  // mute-pipeline trap `turn-pipeline-producer.test.ts` documents.
  const ledger = createToolSideEffectLedger({
    dir: cleanupDirs[cleanupDirs.length - 1] as string,
    runId,
    runEpoch: FIRST_EPOCH,
    fence: { runId, runEpoch: FIRST_EPOCH, token: GROUND_FENCE.token } as never,
  });

  const host = {
    turnPipelines,
    assembleTurn: createLegacyAssembleTurn(assembly),
    refreshDeclaredTools: () => assembly.refreshDeclaredTools(),
    askApproval: async () => ({ allowed: true, scope: 'once' }),
    emitter,
    proposeTerminal: (candidate: { state: { status: string } }) => terminals.push(candidate),
    compaction: {
      decide: () => Promise.resolve({ kind: 'skip', reason: 'not under test' } as const),
      compact: () => Promise.resolve({ kind: 'declined', reason: 'not under test' } as const),
      nextCompactionId: () => 'cmp-p6',
    },
    seqIndex: 0,
    wakeRun: false,
    sessionId,
    workingDirectory: process.cwd(),
    beginTicket: (call: never) => ledger.begin(call),
    settleTicket: (input: never) => ledger.settle(input),
  } as never;

  const composed = composeLegacyRunPorts(agent, host);
  const facts = {
    runId,
    cwd: process.cwd(),
    model: 'claude-test',
    providerId: 'anthropic',
    sessionId,
    projectId: null,
    revision: 'rev-p6',
    catalogRevision: agent.activeMCPRegistry.getCatalogRevision(),
    permissionMode: 'default',
  } as never;
  const input = {
    ...buildLegacyRunInput(facts, { role: 'user', id: 'p1', content: prompt }, []),
    history: { kind: 'by_ref', digest: 'hist-p6', locator: 'agent://transcript' },
  } as never;

  const engine = new RunEngineImpl({ now: () => 1_000, defaultMaxTurns: 2 });
  await engine.execute({
    manifest: buildLegacyRunManifest(facts),
    input,
    signal: new AbortController().signal,
    ports: composed,
  }).completed();
  turnPipelines.close();
  handle.close();

  return {
    seen: [...seenRequests],
    railFrames,
    terminals: terminals.map((candidate) => candidate.state.status),
  };
}

// ============================================================================
// The proof
// ============================================================================

describe('the prompt-context rail seam reaches the model request', () => {
  it('carries BOTH producer shapes to the provider boundary', async () => {
    const run = await runThroughSeam();

    // Non-vacuity FIRST: the run really reached the model and really completed,
    // so a missing marker below is a missing marker rather than a dead run.
    expect(run.seen.length).toBeGreaterThan(0);
    expect(run.terminals).toEqual(['completed']);

    const wire = run.seen.flatMap((r) => r.contents).join('\n');

    // The PUSH producer (plugin activation).
    expect(wire).toContain(PLUGIN_MARKER);
    // The ASSIGN producer (UserPromptSubmit), through a real hook subprocess.
    expect(wire).toContain(HOOK_MARKER);
  });

  it('returns the hook frames it produced instead of dropping them', async () => {
    // A POSITIVE COUNT, so a seam that silently discarded the
    // `agent_progress` / `hook_invoked` frames cannot satisfy it. A driver
    // cannot consume a `yield`, which is why these are RETURNED at all.
    const run = await runThroughSeam();

    const hookFrames = run.railFrames.filter((f) => f.type === 'agent_progress');
    expect(hookFrames.length).toBeGreaterThan(0);
  });
});