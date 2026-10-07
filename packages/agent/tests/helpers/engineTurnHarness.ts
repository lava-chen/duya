/**
 * The post-flip replacement for `agent.streamChat(prompt, options)` in tests.
 *
 * ## Why this exists
 *
 * Plan 610's A3 slice (S4c-d3) deleted `DuyaAgent.streamChat`. The class surface
 * is now a set of PORTS the run driver calls -- `beginRun`,
 * `beginTurnAssembly`, `commitTurnPromptUserRow`, `assembleTurnContext`,
 * `recordTurnToolResult`, `finishTurnOutput` -- and the turn loop itself belongs
 * to `driveRunWithEngine`.
 *
 * A test that used to write `for await (const e of agent.streamChat(p))` was
 * never asserting on `streamChat`. It was asserting on the turn: which messages
 * reached the provider, what the durable timeline kept, which frames came out.
 * Only the ENTRY POINT was obsolete.
 *
 * ## What this drives
 *
 * The real chain, end to end:
 *
 *   scripted provider -> real `duyaAgent` -> `driveRunWithEngine` -> real spine
 *   -> real `RunEngineImpl` -> real `composeLegacyRunPorts` -> the agent's own
 *   port seams -> the provider.
 *
 * The only fake is the LLM provider, which stands in for nothing under test.
 * This is the same shape as `src/process/__tests__/desktop-chat-codec-once.test.ts`
 * and `engine-chat-start-assembly-proof.test.ts`; those bind the entry's
 * `onFrame` too, and this binds the surface's OWN frames.
 *
 * ## The codec is REAL, and that is the reason the assertions survive
 *
 * `driveRunWithEngine` projects the spine's envelopes to legacy frames and then
 * runs them through the injected `legacyFrameCodec` (`engine-run-driver.ts:690`).
 * This passes the worker's own `convertSSEToAgentMessage`, so the frames handed
 * back are the product's `chat:*` frames rather than a test-shaped vocabulary.
 *
 * The old assertions read `events.map((e) => e.type)` and expected `'done'`,
 * `'text'`, `'tool_use'`, `'tool_result'`. Those are the PROJECTOR's names; the
 * codec renames each one to its `chat:` twin (`sse-frame-codec.ts:109-180`).
 * `eventType()` below accepts BOTH spellings and normalises them, so an
 * assertion written against the legacy vocabulary still states exactly the same
 * claim about the same frame rather than being rewritten to match new names.
 * The alternative -- handing the driver a pass-through codec -- would keep the
 * old strings by removing the production translation step, which is the part
 * under test everywhere else in this tree.
 *
 * ## What this does NOT do
 *
 * It does not install a fake `Journal`, so `agent.journal` stays whatever the
 * caller assigned. `driveTurn` assigns a real one if the caller has not, because
 * the driver's turn-end barrier flushes it and a run without one cannot settle.
 * It does not swallow a thrown run: a failed turn rejects, so a test that wanted
 * an aborted or errored turn reads that from `frames` / `outcome` rather than
 * from a caught exception.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { RunId, PermissionPolicyMode } from '@duya/agent-protocol';
import type { EngineRunOutcome } from '../../src/process/engine-run-driver.js';
import type { duyaAgent } from '../../src/agent/DuyaAgent.js';
import type { ChatOptions, MessageContent } from '../../src/types.js';

export interface DriveTurnOptions {
  /** The turn's `ChatOptions`. Passed straight through, so `toolRegistry`,
   *  `replyToId`, `branched`, `messages` and `imageInputSupported` all behave
   *  exactly as they did through `streamChat`. */
  readonly options?: ChatOptions;
  readonly maxTurns?: number;
  readonly permissionMode?: 'default' | 'acceptEdits' | 'plan' | 'auto' | 'bypassPermissions';
  /** Overrides the session id. Defaults to the agent's own. */
  readonly sessionId?: string;
  /** The model the run's manifest names. Defaults to a test placeholder. */
  readonly model?: string;
  /** The provider the run's manifest names. Defaults to `'anthropic'`. */
  readonly providerId?: string;
}

export interface DriveTurnResult {
  /** The `chat:*` frames the driver produced, in projection order. */
  readonly frames: readonly Record<string, unknown>[];
  /** The driver's own account of how the run ended. */
  readonly outcome: EngineRunOutcome;
}

/**
 * The frame's type, in EITHER vocabulary.
 *
 * The projector writes `'done'` / `'text'` / `'tool_use'`; the worker's codec
 * renames those to `'chat:done'` / `'chat:text'` / `'chat:tool_use'`. A test
 * written before the flip names the former and must keep passing, so this
 * normalises rather than forcing every assertion to be renamed.
 */
export function eventType(frame: Record<string, unknown>): string {
  const type = typeof frame['type'] === 'string' ? frame['type'] : '';
  return type.startsWith('chat:') ? type.slice('chat:'.length) : type;
}

/** The frames whose type matches, in either vocabulary. */
export function framesOfType(
  frames: readonly Record<string, unknown>[],
  type: string,
): readonly Record<string, unknown>[] {
  return frames.filter((frame) => eventType(frame) === type);
}

// ---------------------------------------------------------------------------
// The offline host: worker IPC. Under a Vitest pool worker `process.send` is the
// POOL's channel, so it is replaced and the db-client's own listener is called
// directly. Answering exactly the two actions a turn reaches for keeps the
// fixture explicit: anything else arriving is a test-visible failure rather than
// a hang.
// ---------------------------------------------------------------------------

let realSend: typeof process.send | undefined;

/**
 * Install the IPC a turn needs.
 *
 * PER-CALL state, deliberately. Several test files share one Vitest pool
 * worker, so anything cached at module scope survives into the next file and
 * resolves the wrong listener: `initDbClient` registers a listener the FIRST
 * time this runs, and a later file's install would find the PREVIOUS file's
 * one and answer that instead of its own. The `PRE_EXISTING` snapshot has the
 * same problem in reverse, because the pool's listener is captured before any
 * file's `beforeEach` runs. Both are re-read on every install instead.
 */
export async function installEngineTurnIpc(): Promise<void> {
  const preexisting = new Set(process.listeners('message'));
  let dbListener: ((m: unknown) => void) | null = null;

  const db = (await import('../../src/ipc/db-client.js')) as {
    initDbClient?: () => void;
  };
  // Read the namespace's OWN KEYS rather than touching `db.initDbClient`: Vitest
  // installs a Proxy that THROWS on any property access the mock factory did
  // not return, so `typeof db.initDbClient` raises before it can answer.
  //
  // Several of the suites that use this harness replace `db-client.js`
  // wholesale with a `mailboxDb` / `pluginDb` / `messageDb` stub, which leaves
  // no `initDbClient` to call and registers no listener of its own -- those
  // tables resolve without IPC at all. The replacement below still installs,
  // because the REAL db-client is what the driver reaches when a suite has not
  // stubbed it.
  if ('initDbClient' in db && typeof db.initDbClient === 'function') {
    db.initDbClient();
    dbListener = (process
      .listeners('message')
      .filter((l) => !preexisting.has(l))[0] ?? null) as ((m: unknown) => void) | null;
  }

  realSend = process.send;
  process.send = ((msg: unknown) => {
    const req = msg as { type?: string; action?: string; id?: string };
    if (req?.type !== 'db:request') return true;
    if (req.action !== 'modeState:get' && req.action !== 'mailbox:claimBatch') {
      throw new Error(`unexpected db action: ${req.action}`);
    }
    // An EMPTY claim, not a null: the agent reads `claim.rows`.
    const result = req.action === 'mailbox:claimBatch' ? { rows: [], claimTokens: [] } : null;
    setImmediate(() => {
      const response = { type: 'db:response', id: req.id, success: true, result };
      if (dbListener) {
        dbListener(response);
        return;
      }
      // No db-client listener -- the suite replaced the module with a stub, so
      // `initDbClient` never ran and nothing registered a `'message'` handler
      // of its own. Deliver to whatever listeners the POOL has left rather
      // than through `process.emit`: under Vitest that channel is the pool's,
      // and its handler runs `Buffer.from` on whatever arrives, so emitting a
      // response object there raises an unhandled rejection per request.
      for (const listener of process.listeners('message')) {
        if (preexisting.has(listener)) continue;
        (listener as (m: unknown) => void)(response);
      }
    });
    return true;
  }) as unknown as typeof process.send;
}

/** Put `process.send` back. Call from `afterEach`. */
export function restoreEngineTurnIpc(): void {
  process.send = realSend;
}

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

const tempDirs: string[] = [];

function tempDir(prefix: string): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

/** Remove every temp dir `driveTurn` created. Call from `afterEach`. */
export function cleanupEngineTurnDirs(): void {
  for (const dir of tempDirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // A temp dir nobody claimed is not a test failure.
    }
  }
}

/**
 * Drive one real turn and return what the consumer of that turn would have seen.
 *
 * Replaces `drainStream(agent, prompt, options)` from the pre-flip suites.
 */
export async function driveTurn(
  agent: duyaAgent,
  prompt: string | MessageContent[],
  config: DriveTurnOptions = {},
): Promise<DriveTurnResult> {
  const [{ driveRunWithEngine }, { convertSSEToAgentMessage }, { TurnPipelinePublisher }, { Journal }, { resolveTurnRunId }] =
    await Promise.all([
      import('../../src/process/engine-run-driver.js'),
      import('../../src/process/sse-frame-codec.js'),
      import('../../src/tool/turn-pipeline-publisher.js'),
      import('../../src/journal/Journal.js'),
      import('../../src/agent/run-identity.js'),
    ]);

  // `sessionId` and `workingDirectory` are `private` on `duyaAgent`, so they are
  // read through the one public seam that names both: `assembleTurnContext`,
  // which is the same `TurnContext` `beginRun` builds. Reaching past it with a
  // cast would couple this harness to the field layout instead.
  const context = agent.assembleTurnContext(config.options as ChatOptions, prompt);
  const sessionId = config.sessionId ?? context.sessionId ?? '';
  const workingDirectory = context.workingDirectory ?? process.cwd();
  // `provider` / `model` are private too. The driver's copy of both is
  // provenance -- it names what the run claims to have asked -- and the
  // manifest it builds is hashed from it, so a caller that cares passes them
  // explicitly rather than this harness reaching into the client.
  const providerId = config.providerId ?? 'anthropic';
  const model = config.model ?? 'claude-test';
  // Seed the transcript the way `streamChat`'s caller did. `beginTurnAssembly`
  // honours `options.messages` only on an EMPTY timeline
  // (`DuyaAgent.ts:1601-1603`), so a suite that primed the agent with
  // `agent.setMessages([...])` already carries its history and this is a no-op.
  // Where a suite passed history through `ChatOptions` instead, this is what
  // carries it across.
  let options = (config.options ?? { sessionId }) as ChatOptions;
  if (options.messages === undefined) {
    const seeded = agent.getMessages();
    if (seeded.length > 0) options = { ...options, messages: seeded } as ChatOptions;
  }
  const ledgerDir = tempDir('duya-drive-turn-ledger-');

  // A real Journal when the caller did not assign one: the driver's turn-end
  // barrier flushes it, so a run whose agent has none cannot settle.
  if (!agent.journal) agent.journal = new Journal({ sessionId });

  const turnPipelines = new TurnPipelinePublisher();
  const frames: Record<string, unknown>[] = [];

  const outcome = await driveRunWithEngine(
    {
      agent,
      sessionId,
      runId: resolveTurnRunId(undefined).runId as RunId,
      seqIndex: Date.now(),
      options,
      prompt,
      model,
      providerId,
      workingDirectory,
      permissionMode: (config.permissionMode ?? 'bypassPermissions') as PermissionPolicyMode,
      ...(config.maxTurns === undefined ? {} : { maxTurns: config.maxTurns }),
      wakeRun: false,
      imageInputSupported: options.imageInputSupported ?? false,
      turnPipelines,
      askApproval: async () => ({ allowed: true, scope: 'once' }) as const,
      // The worker's OWN codec, so these are the product's frames.
      legacyFrameCodec: convertSSEToAgentMessage,
      onPerCallUsage: () => {},
      ledgerDir,
    },
    (frame) => {
      frames.push(frame as Record<string, unknown>);
    },
  );

  turnPipelines.close();
  // The journal's emits are fire-and-forget and the terminal handoff waits on
  // `flush`; so does this, or a caller reading the timeline would race it.
  await agent.journal.flush();

  return { frames, outcome };
}