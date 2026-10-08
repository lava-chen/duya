/**
 * Plan 610 S4c-d2a: the flipped worker entry's `chat:start`, end to end.
 *
 * ## What this file is
 *
 * The sibling engine proofs each bind ONE seam by hand. This one binds none: it
 * calls `driveRunWithEngine` -- the exact function `agent-process-entry.ts` calls
 * -- with the exact arguments the entry's handler builds. So the spine
 * (`createRunEventSpine`), the composition (`composeLegacyRunPorts`), the engine
 * (`RunEngineImpl`), the `chat:*` projection (`createWorkerAdapterSurface`) and
 * the settle/close obligation are all the production ones, reached by production
 * wiring rather than reassembled here.
 *
 * The entry's own `handleChatStart` is unreachable by construction: the module
 * calls `main()` at import time, so a test cannot import it. Driving the driver
 * it calls is the closest honest substitute, and it is why this file claims
 * nothing about the frames the entry's billing and persistence blocks do with
 * what arrives -- `live-turn-single-driver.test.ts` is what covers the entry's own
 * shape.
 *
 * ## Why one run answers five questions
 *
 * The five claims below are not independent, and splitting them into five runs
 * would have made the file slower without making any claim stronger. What keeps
 * it honest is not the number of runs but the rule applied to EVERY assertion:
 * the two sides of each comparison are produced by DIFFERENT code, so no
 * comparison can be satisfied by a value agreeing with itself.
 *
 *  - TOOL RAN: the probe's own body writes a FILE. The evidence is read back off
 *    the filesystem. Not the model wire, not the journal, not a spy -- a broken
 *    build that merely *believed* it dispatched a tool writes nothing.
 *  - PROMPT ROW DURABLE: the driver's own return value (`promptRowId`) is
 *    compared against the row `Journal.fire` handed `messageDb.append`. One is
 *    the seam reporting on itself; the other is the durable sink's DTO. A seam
 *    that returned a confident id without writing a row fails the second half.
 *  - TURN 2 CARRIES THE TOOL RESULT ROW: asserted as a ROW (`role === 'tool'`
 *    carrying the probe's own answer) on turn index 1, AND as the ABSENCE of any
 *    `tool` row on turn index 0. The two sides are two separate provider calls,
 *    so this is not one value compared with itself.
 *  - SKILL / PLUGIN / MENTION: each expected marker is the product's OWN -- the
 *    skill body the registry holds, the plugin id the producer renders, the
 *    roster line the mention builder formats -- against what the scripted
 *    provider received at the real `createAIClient` the agent resolves.
 *  - DRAIN TERMINATED: the run reaching its own assertions at all is the first
 *    half; a settled `completed` terminal and a `chat:done` frame are the second.
 *
 * ## The contamination this file is written against
 *
 * The inter-turn rail quotes the last tool result into a `user` REMINDER row. So
 * a substring search for the probe's output passes on a build whose tool result
 * never made it into the conversation as a tool row. That is why the turn-2
 * claim asserts a `role: 'tool'` ROW and not a substring, and why turn 1 is
 * asserted to have no such row: the reminder row is a `user` row and cannot
 * satisfy either half.
 *
 * ## What this file does NOT prove
 *
 * It does not prove the turn renders in Electron -- a browser-only renderer
 * cannot exercise the preload path, and the frames are asserted as the projected
 * shapes rather than as pixels. It does not prove `chat:done` reaches the
 * renderer AFTER the entry's post-flush persistence barrier; that barrier is the
 * entry's, and this file stops where the driver stops.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { TokenUsage } from '@duya/ai';
import type { RunId } from '@duya/agent-protocol';
import type { EngineRunOutcome } from '../engine-run-driver.js';
import type { ChatOptions, Message, SSEEvent } from '../../types.js';

// ============================================================================
// The markers. Each is produced by PRODUCT code, never by this file.
//
// Declared BEFORE the scripted provider, which names `PROBE_TOOL` while
// building `SCRIPTS` at module-evaluation time: a `const` below that point would
// be in its TDZ there and throw on import rather than fail an assertion.
// ============================================================================

/** The tool the run calls. It writes a file; that file is the evidence. */
const PROBE_TOOL = 'chatstart_probe';
/** Written by the probe's own body and returned as its result. */
const PROBE_ANSWER = 'CHATSTART-PROBE-ANSWER';
/** The body a registered skill holds, so only the skill producer can emit it. */
const SKILL_MARKER = 'CHATSTART-SKILL-BODY';
const SKILL_NAME = 'chatstart-skill';
/** `collectPluginInjections` renders `pluginId`, so only that producer emits it. */
const PLUGIN_MARKER = 'chatstart-plugin-id';
/** The config roster entry the mention producer parses `@chatstart-mention`. */
const MENTION_ID = 'chatstart-mention';
/** The id the entry's `clientMsgId` carries, so the prompt row's id is known. */
const CLIENT_MSG_ID = 'chatstart-msg-1';
const PROMPT = 'use the skill and ask @chatstart-mention to review';
const SESSION_ID = 's-chatstart-assembly';

/** Isolates `readConfigAgents` and the hooks runner from the real `~/.duya`. */
const TEST_NS = 'chatstart-assembly-proof';

function namespaceRoot(): string {
  return path.join(os.homedir(), '.duya', 'test-namespaces', TEST_NS);
}

// ============================================================================
// The scripted PROVIDER -- the only fake, and it stands in for nothing under
// test. It records what crossed the provider boundary and NOTHING here asserts
// on what it was asked to do beyond what the provider itself would have sent.
// ============================================================================

/** One provider request, as the scripted client received it. */
interface ProviderRequest {
  readonly rows: readonly { readonly role: string; readonly content: string }[];
}

let requests: ProviderRequest[] = [];

const DONE: SSEEvent = { type: 'done', reason: 'end_turn' };

/**
 * The two calls' usage, as the provider reports them.
 *
 * The numbers are chosen so a double-count cannot hide: turn 2's
 * `input_tokens` is DOUBLE turn 1's, so a ledger that also billed the
 * turn-level projection would accumulate 6000 where the correct sum is 3000
 * -- not a rounding difference. See the "bills ONE `result` per provider call"
 * case below.
 */
const CALL_ONE: TokenUsage = {
  input_tokens: 1000,
  output_tokens: 50,
  total_tokens: 1050,
  cache_hit_tokens: 400,
  cache_creation_tokens: 100,
};
const CALL_TWO: TokenUsage = {
  input_tokens: 2000,
  output_tokens: 60,
  total_tokens: 2060,
  cache_hit_tokens: 900,
  cache_creation_tokens: 0,
};
/**
 * Turn 1 asks for the probe; turn 2 reports and stops.
 *
 * Two turns is the minimum that can distinguish "the tool ran" from "the tool
 * ran AND its result came back into the conversation": a one-turn run has no
 * second request to inspect.
 */
const SCRIPTS: readonly (readonly SSEEvent[])[] = [
  [
    { type: 'result', data: CALL_ONE },
    { type: 'text', data: 'calling the probe' },
    { type: 'tool_use', data: { id: 'cs-t1', name: PROBE_TOOL, input: { value: 'alpha' } } },
    DONE,
  ],
  [{ type: 'result', data: CALL_TWO }, { type: 'text', data: 'the probe reported' }, DONE],
];

vi.mock('@duya/ai', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const delegating = {
    streamChat(messages: Message[], options?: Record<string, unknown>) {
      requests.push({
        rows: messages.map((m) => ({
          role: m.role,
          content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
        })),
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

// ============================================================================
// The DURABLE SINK
//
// `messageDb.append` is where "in memory" and "durable" part company: the
// `chat:db_persisted` acknowledgement the entry waits on is emitted only after
// `Journal.flush`, and that flush covers exactly these writes. Captured here
// rather than read off the in-memory timeline, which would be a weaker claim
// wearing the same name.
// ============================================================================

interface JournalRow {
  readonly sessionId: string;
  readonly turnId: string | null;
  readonly dto: Record<string, unknown>;
}

let journalRows: JournalRow[] = [];

vi.mock('../../ipc/db-client.js', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const messageDb = actual.messageDb as Record<string, unknown>;
  return {
    ...actual,
    messageDb: {
      ...messageDb,
      append: (sessionId: string, messages: unknown[], turnId: string | null) => {
        for (const dto of messages as Record<string, unknown>[]) {
          journalRows.push({ sessionId, turnId, dto });
        }
        return Promise.resolve({ success: true, count: messages.length });
      },
    },
  };
});

// ============================================================================
// The offline host: worker IPC + the agent + the driver under test
// ============================================================================

const PRE_EXISTING = new Set(process.listeners('message'));
const { duyaAgent } = await import('../../agent/DuyaAgent.js');
const { TurnPipelinePublisher } = await import('../../tool/turn-pipeline-publisher.js');
const { initDbClient } = await import('../../ipc/db-client.js');
const { Journal } = await import('../../journal/Journal.js');
const { getSkillRegistry, resetSkillRegistry } = await import('../../skills/registry.js');
const { driveRunWithEngine } = await import('../engine-run-driver.js');
const { resolveTurnRunId } = await import('../../agent/run-identity.js');
const { convertSSEToAgentMessage } = await import('../sse-frame-codec.js');
const { isTurnLevelUsageFrame } = (await import('../agent-process-entry.js')) as unknown as {
  isTurnLevelUsageFrame: (frame: { readonly type: string }) => boolean;
};

let dbListener: ((m: unknown) => void) | null = null;
const originalEnv = { ...process.env };
let realSend: typeof process.send | undefined;
let workspaceDir = '';
const ledgerDirs: string[] = [];

/**
 * Answer the two DB actions a turn reaches for.
 *
 * Under a Vitest pool worker `process.send` is the POOL's channel, so it is
 * replaced and the db-client's own listener is called directly. The journal does
 * not come through here -- its `messageDb.append` is captured by the module mock
 * above.
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

/**
 * A config roster with exactly one agent, so the mention producer has something
 * to match.
 *
 * `name` equals the id on purpose: `parseAgentMentions` matches against handles
 * derived from the NAME, so a display name would make the fixture's own marker
 * unmatchable and the assertion vacuous.
 */
function writeAgentRoster(root: string): void {
  mkdirSync(root, { recursive: true });
  writeFileSync(
    path.join(root, 'config.toml'),
    ['[agents.' + MENTION_ID + ']', 'name = "' + MENTION_ID + '"', ''].join('\n'),
    'utf-8',
  );
}

beforeEach(() => {
  vi.stubEnv('DUYA_TEST', '1');
  vi.stubEnv('DUYA_TEST_NAMESPACE', TEST_NS);
  process.env.DUYA_E2E_DISABLE_LLM = '1';
  process.env.DUYA_SESSIONS_ROOT = '';
  process.env.DUYA_MEMORY_ROOT = '';
  requests = [];
  journalRows = [];
});

afterEach(() => {
  vi.unstubAllEnvs();
  process.env = { ...originalEnv };
  process.send = realSend;
  resetSkillRegistry();
  vi.restoreAllMocks();
  for (const dir of ledgerDirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // A temp dir nobody claimed is not a test failure.
    }
  }
  try {
    rmSync(namespaceRoot(), { recursive: true, force: true });
  } catch {
    // The namespace lives under the user's home, not a temp dir. Removed here so
    // no roster survives into a later run.
  }
});

// ============================================================================
// The run
// ============================================================================

interface Proof {
  readonly outcome: EngineRunOutcome;
  /** Every `chat:*` frame the surface projected, in projection order. */
  readonly frames: readonly { readonly type: string }[];
  readonly probeFile: string;
  readonly providerRequests: readonly ProviderRequest[];
  readonly journalled: readonly JournalRow[];
  /** What the entry's billing arm accumulated: the tap's blocks, nothing else. */
  readonly usageCalls: readonly TokenUsage[];
}

async function runChatStart(): Promise<Proof> {
  installFakeDbIpc();

  workspaceDir = mkdtempSync(path.join(os.tmpdir(), 'duya-chatstart-ws-'));
  ledgerDirs.push(workspaceDir);
  writeAgentRoster(namespaceRoot());

  const ledgerDir = mkdtempSync(path.join(os.tmpdir(), 'duya-chatstart-ledger-'));
  ledgerDirs.push(ledgerDir);

  const probeFile = path.join(workspaceDir, 'probe-ran.txt');

  const agent = new duyaAgent({
    apiKey: 'test-key',
    model: 'claude-test',
    provider: 'anthropic',
    sessionId: SESSION_ID,
    workingDirectory: workspaceDir,
    permissionMode: 'bypassPermissions',
  });
  agent.journal = new Journal({ sessionId: SESSION_ID });

  // The probe's OWN side effect. It is the tool body, not a spy on the tool
  // body, so nothing this file does can make the file appear.
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

  // A real skill in the product's real registry. `getPromptForCommand` is the
  // same source the Skill tool reads, so the injected body is the product's.
  getSkillRegistry().register({
    type: 'prompt',
    name: SKILL_NAME,
    description: 'the chat:start assembly proof skill',
    source: 'project',
    skillRoot: path.join(workspaceDir, SKILL_NAME),
    getPromptForCommand: async () => SKILL_MARKER,
  } as never);

  const turnPipelines = new TurnPipelinePublisher();
  const options = {
    sessionId: SESSION_ID,
    clientMsgId: CLIENT_MSG_ID,
    mentionedSkills: [SKILL_NAME],
    mentionedPlugins: [
      {
        pluginId: PLUGIN_MARKER,
        name: 'chatstart plugin',
        appConnections: [],
        mcpServers: [],
        skillNames: [],
      },
    ],
  } as unknown as ChatOptions;

  const usageCalls: TokenUsage[] = [];
  const frames: { readonly type: string }[] = [];

  const outcome = await driveRunWithEngine(
    {
      agent,
      sessionId: SESSION_ID,
      // The entry's own identity resolution, so the run id under test is the
      // product's rather than a literal this file invented.
      runId: resolveTurnRunId(undefined).runId as RunId,
      seqIndex: Date.now(),
      options,
      prompt: PROMPT,
      model: 'claude-test',
      providerId: 'anthropic',
      workingDirectory: workspaceDir,
      permissionMode: 'acceptEdits',
      maxTurns: 4,
      wakeRun: false,
      imageInputSupported: false,
      turnPipelines,
      askApproval: async () => ({ allowed: true, scope: 'once' }) as const,
      legacyFrameCodec: convertSSEToAgentMessage,
      onPerCallUsage: (usage) => usageCalls.push(usage),
      ledgerDir,
    },
      // The entry's drain binding, verbatim in shape: every frame is recorded
      // raw, and the turn-level usage duplicate is DECLINED rather than billed.
      (frame) => {
        frames.push(frame as { type: string });
        if (isTurnLevelUsageFrame(frame as { type: string })) return;
      },
  );

  turnPipelines.close();
  // The journal's emits are fire-and-forget and the terminal handoff waits on
  // `flush`; so does this file, or it would race the write it asserts.
  await agent.journal.flush();

  return { outcome, frames, probeFile, providerRequests: requests, journalled: journalRows, usageCalls };
}

/** The wire of one provider call, as a single searchable string. */
function wireOf(request: ProviderRequest): string {
  return request.rows.map((r) => r.content).join('\n');
}

/** The `role: 'tool'` rows of one provider call. */
function toolRowsOf(request: ProviderRequest): readonly { role: string; content: string }[] {
  return request.rows.filter((r) => r.role === 'tool');
}

describe('a chat:start turn, assembled by the driver the entry calls', () => {
  it('runs the tool, and the tool left evidence on disk', async () => {
    const proof = await runChatStart();

    // Read back off the FILESYSTEM -- the probe's own write, not a counter the
    // harness kept, not a frame, not the journal. A build that dispatched the
    // tool and lost the result would still pass a frame-based assertion; this
    // one cannot be satisfied by anything but the tool body having run.
    expect(existsSync(proof.probeFile)).toBe(true);
    expect(readFileSync(proof.probeFile, 'utf-8')).toBe(PROBE_ANSWER);
  });

  it('commits the prompt user row durably, and reports the id the journal stored', async () => {
    const proof = await runChatStart();

    // The driver's own return value: what `commitTurnPromptUserRow` said it
    // wrote.
    expect(proof.outcome.promptRowId).toBe(CLIENT_MSG_ID);

    // The durable sink's own record. A different producer: `Journal.fire` built
    // this DTO from the committed row, and never read the seam's return value.
    // `user_msg_added` is `Journal`'s own event name, not a role -- the role is
    // carried on the DTO and asserted separately below.
    const userRows = proof.journalled.filter((r) => r.dto.kind === 'user_msg_added');
    expect(userRows).toHaveLength(1);
    expect(userRows[0]?.dto.role).toBe('user');
    expect(userRows[0]?.dto.content).toBe(PROMPT);
    expect(userRows[0]?.sessionId).toBe(SESSION_ID);

    // The two sides agree, and neither could satisfy the other alone.
    //
    // The DTO's own `id` is `Journal`'s DETERMINISTIC EVENT id -- built by
    // `deterministicEventId(msg.id, kind)` from the SOURCE MESSAGE id -- and the
    // message id is deliberately not a flat field of its own. So the linkage
    // between the two producers is the event id's own construction: the journal
    // derived it from the row it committed, and never read the seam's return
    // value. A seam that reported an id it had not written would fail here.
    expect(userRows[0]?.dto.id).toBe(`journal:${proof.outcome.promptRowId}:user_msg_added`);
  });

  it('carries the tool result back as a tool ROW on turn 2, and not on turn 1', async () => {
    const proof = await runChatStart();

    // Two provider calls, so this is a comparison between two genuinely
    // different requests rather than one value against itself.
    expect(proof.providerRequests).toHaveLength(2);
    const [first, second] = proof.providerRequests;

    // Turn 1 asked for the tool, so it cannot already carry a result. Asserted
    // positively as an ABSENCE of a tool row: the inter-turn reminder quotes the
    // tool output into a `user` row, so a substring search would pass here on a
    // build where the result never became a tool row at all.
    expect(toolRowsOf(first!)).toHaveLength(0);

    // Turn 2 carries it as a ROW, not as quoted text.
    const toolRows = toolRowsOf(second!);
    expect(toolRows).toHaveLength(1);
    expect(toolRows[0]?.content).toContain(PROBE_ANSWER);
  });

  it('delivers the skill, plugin and mention contexts to the provider request', async () => {
    const proof = await runChatStart();

    const wire = wireOf(proof.providerRequests[0]!);

    // Each marker is the PRODUCT's own: the registered skill's body, the plugin
    // id `collectPluginInjections` renders, and the roster line
    // `buildMentionedAgentsContext` formats. The observed side is what crossed
    // the real `createAIClient` boundary. Nothing here compares the seam with a
    // copy of itself.
    expect(wire).toContain(SKILL_MARKER);
    expect(wire).toContain(PLUGIN_MARKER);
    expect(wire).toContain(`- ${MENTION_ID} (id: ${MENTION_ID})`);
  });

  it('bills ONE `result` per provider call, not one per channel', async () => {
    // The premise, measured on THIS run: the two `result` frames the scripted
    // provider emitted below reached the tap, and the drain separately emitted
    // the turn-level `assistant.usage` projection. Without both counts a
    // green sum could mean "the duplicate never arrived".
    const proof = await runChatStart();

    const resultFrames = proof.frames.filter((f) => f.type === 'result');
    expect(resultFrames).toHaveLength(1);
    expect(proof.usageCalls).toHaveLength(2);

    // The turn really was two calls: the probe tool ran, so the engine
    // re-entered. Read off the FILESYSTEM, not off a counter.
    expect(existsSync(proof.probeFile)).toBe(true);
    expect(proof.providerRequests).toHaveLength(2);

    // `usageCalls` is the TAP's own collection, filled by the binding the
    // entry writes verbatim, and the turn-level frame is the one the entry
    // now declines to bill from. So the ledger's `calls` is the tap's length:
    // 2. Before the entry dropped the duplicate it was 3, and `input_tokens`
    // accumulated 1000 + 2000 + 2000 instead of 1000 + 2000.
    const sum = proof.usageCalls.reduce(
      (n, c) => n + c.input_tokens,
      0,
    );
    // From the providers' own constants -- a DIFFERENT source than the frames.
    expect(sum).toBe(CALL_ONE.input_tokens + CALL_TWO.input_tokens);
  });

  it('settles the run and terminates the drain', async () => {
    const proof = await runChatStart();

    // Reaching this line at all is the first half: `driveRunWithEngine` parks
    // the drain until the stream is CLOSED, so a driver that forgot to settle
    // would hang here rather than fail on an assertion. The 10s `testTimeout` is
    // what a missing settle looks like.
    // `RunTerminalState` carries `status` directly; `.state` is the shape of a
    // `TerminalCandidate`, which is the ADVISORY record below and a different
    // type.
    expect(proof.outcome.terminal?.status).toBe('completed');

    // The proposal the engine made and the terminal the session committed are
    // two different records -- one advisory, one written -- and both are present.
    expect(proof.outcome.proposed?.state.status).toBe('completed');

    // And the drain really projected the `chat:*` frames, ending at `chat:done`,
    // which is the frame the entry's handler turns into a turn boundary.
    const types = proof.frames.map((f) => f.type);
    expect(types).toContain('chat:done');
    // Positively, not "no crash": the run announced its own start on the spine.
    expect(proof.outcome.announced.length).toBeGreaterThan(0);
  });
});