/**
 * D3 -- does `PostToolUseFailure` reach an ENGINE-driven run?
 *
 * ## The claim under test, and where it is WRONG in the obvious place
 *
 * `PostToolUseFailure` is a `ConfigHooksRunner` event (`hooks/types.ts`), NOT a
 * member of `LoopHookEvent` (`hooks/loop.ts`), so it never passes through the
 * loop bus. The obvious reading is "therefore it is missing from the engine
 * path, because `hook-source.ts`'s `PHASE_EVENTS` does not list it."
 *
 * That reading is wrong, and this file is the proof. The engine path already
 * fires it, through a DIFFERENT seam:
 *
 *   engine `#drainOutcomes` -> `TurnOutputPort.recordToolResult`
 *     -> the composition's `turnOutput.onToolResult`
 *     -> `DuyaAgent.recordTurnToolResult`
 *     -> `DuyaAgent.dispatchPostToolUseFailure`
 *     -> `runner.run('PostToolUseFailure', ...)`
 *
 * `PHASE_EVENTS` maps the ENGINE PHASES onto config events for the host's
 * `ExtensionPort`. `PostToolUseFailure` arrives through `turnOutput` instead --
 * a different port, with its own dispatch. Adding it to `PHASE_EVENTS` would
 * therefore fire every user's `PostToolUseFailure` hook TWICE per failed tool,
 * which is why this file asserts the count is exactly one and says so.
 *
 * ## Why this is a POSITIVE proof and not a spy assertion
 *
 * The hook here is a real `node` subprocess (`ConfigHooksRunner` executes command
 * hooks as children), and it records its own dispatch by APPENDING A LINE to a
 * file. So the count below is written by the hook process itself, reached through
 * the real agent, through the real composition, driven by a real `RunEngineImpl`.
 * A run that never reached the failure arm appends nothing and fails here; so
 * does one that fires the event twice.
 *
 * `onHookInvoked` is deliberately NOT the instrument: the agent builds its own
 * `ConfigHooksRunner` inside `dispatchPostToolUseFailure` and does not forward a
 * callback, so observing through it would have required changing the file this
 * slice must not touch. The child process's own output is the observable that
 * needs no production change.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import os from 'os';
import path from 'path';
import { RunEngineImpl } from '@duya/agent-runtime';
import type {
  ApprovalVerdict,
  AssembledTurn,
  ModelFrame,
  ModelPort,
  ModelRequest,
  RunEnginePorts,
  RunExecutionRequest,
  RunInputSnapshot,
  ToolCallRequest,
  ToolDescriptor,
  ToolDrainItem,
  TransientContextFragment,
} from '@duya/agent-runtime';
import type { RunEvent, RunId, RunManifest } from '@duya/agent-protocol';
import type { Message } from '@duya/agent-protocol/transcript';

// ============================================================================
// Isolation
// ============================================================================

/** Distinct per test file, so a stale namespace cannot leak in or out. */
const TEST_NS = 'engine-post-tool-use-failure-proof';

/**
 * The hooks config lives in the agent's config ROOT, which `readHooksConfig`
 * resolves through `DUYA_TEST` + `DUYA_TEST_NAMESPACE`. Without this the run
 * would read the developer's real `~/.duya/config.toml`.
 */
/**
 * The config root `resolveConfigRoot` derives from `DUYA_TEST=1` plus
 * `DUYA_TEST_NAMESPACE`, which is `~/.duya/test-namespaces/<ns>` -- NOT a temp
 * dir. `readHooksConfig` reads `<root>/config.toml` and resolves the `files`
 * entries relative to that same root, so the hook file has to live there for the
 * agent's own `ConfigHooksRunner` to find it without any production change.
 *
 * Spelled out rather than imported: `resolveConfigRoot` is a private helper of
 * `hooks/config.ts`, and a test that guessed its layout would fail on any change
 * to that derivation. This mirrors it, and the ENOENT it produces when wrong is
 * a loud failure rather than a silently-skipped hook.
 */
function namespaceRoot(): string {
  return path.join(os.homedir(), '.duya', 'test-namespaces', TEST_NS);
}

function writeHooksConfig(logFile: string): void {
  const root = namespaceRoot();
  mkdirSync(root, { recursive: true });
  // The hook APPENDS its payload to `logFile`. One line per dispatch, so the
  // line count IS the dispatch count, written by the child process itself.
  const hookFile = path.join(root, 'hooks.json');
  // The log path is passed as ARGV and never embedded in the `-e` source. A
  // Windows path contains a colon, and a bare `C:/...` inside `appendFileSync()`
  // is a syntax error in the evaluated script; quoting it instead fights the
  // shell the runner spawns the child through. argv avoids both, and the failure
  // it replaces was a hook that silently exited 1 and logged nothing.
  const hookScript =
    "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const i=JSON.parse(d);" +
    "require('fs').appendFileSync(process.argv[1]," +
    "[i.hook_event_name,i.tool_name,i.tool_use_id,String(i.error)].join('|')+'\\n')})";
  writeFileSync(
    hookFile,
    JSON.stringify({
      hooks: {
        PostToolUseFailure: [
          {
            hooks: [
              {
                type: 'command',
                command: `node -e "${hookScript}" ${logFile}`,
              },
            ],
          },
        ],
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
/** The config root this file writes into, removed so no state outlives the run. */
const configRoot = path.join(os.homedir(), '.duya', 'test-namespaces', TEST_NS);

/**
 * The file the hook subprocess appends to, for the CURRENT test.
 *
 * Module-level rather than passed around, because three separate places have to
 * agree on it -- the hook config that embeds it as argv, the assertion that reads
 * it, and the cleanup that deletes it. A per-call local would let two of them
 * drift, and the drift is invisible: the count simply reads zero.
 */
let currentLogFile = '';

beforeEach(() => {
  vi.stubEnv('DUYA_TEST', '1');
  vi.stubEnv('DUYA_TEST_NAMESPACE', TEST_NS);
  const dir = mkdtempSync(path.join(os.tmpdir(), 'duya-failure-hook-'));
  cleanupDirs.push(dir);
  currentLogFile = path.join(dir, 'dispatches.log');
  writeHooksConfig(currentLogFile);
});

afterEach(() => {
  vi.unstubAllEnvs();
  for (const dir of cleanupDirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // A temp dir nobody claimed must not mask the real assertion failure.
    }
  }
  // The namespace under the user's home, not the temp dir: removed here so a
  // later test run cannot read this file's hooks config as its own.
  try {
    rmSync(configRoot, { recursive: true, force: true });
  } catch {
    // Same reasoning as above -- cleanup must not mask an assertion failure.
  }
});

// ============================================================================
// Fixtures
// ============================================================================

const RUN_ID = 'run-failure-hook' as RunId;

/** The tool the run calls. It fails; that is the whole point of the file. */
const FAILING_TOOL = 'probe_fails';
const ERROR_MARKER = 'PROBE-FAILURE-TEXT';
const CALL_ID = 'call-fail-1';

const TOOL: ToolDescriptor = {
  name: FAILING_TOOL,
  description: 'a probe that always fails',
  inputSchema: {},
};

function manifestFor(): RunManifest {
  return {
    version: 1,
    runId: RUN_ID,
    projectId: null,
    workspaceId: 'ws',
    roots: [namespaceRoot()],
    cwd: namespaceRoot(),
    permissionPolicy: { mode: 'default', hostSwitch: 'ask', defaultTimeoutMs: 1000 },
    capabilities: { profiles: [], modes: [], tools: [] },
    connectorBindings: [],
    env: { ref: 'env:test', hash: 'e3b0c44298fc1c149afbf4c8996fb924' },
    agent: { profileId: null, model: 'test-model', providerId: 'test-provider' },
    budget: {},
    deterministic: false,
    provenance: {
      roots: { source: 'unsupported', synthesised: true },
      cwd: { source: 'unsupported', synthesised: true },
      permissionPolicy: { source: 'unsupported', synthesised: true },
      capabilities: { source: 'unsupported', synthesised: true },
      connectorBindings: { source: 'unsupported', synthesised: true },
      env: { source: 'unsupported', synthesised: true },
      agent: { source: 'unsupported', synthesised: true },
      budget: { source: 'unsupported', synthesised: true },
      workspaceId: { source: 'unsupported', synthesised: true },
      deterministic: { source: 'unsupported', synthesised: true },
    },
  } as RunManifest;
}

function inputFor(): RunInputSnapshot {
  return {
    revision: 'rev-1',
    prompt: { role: 'user', id: 'p1', content: 'run the failing probe' },
    history: { kind: 'inline', value: [] },
    attachments: { kind: 'inline', value: [] },
    catalog: { kind: 'by_ref', digest: 'd1', locator: 'catalog://1' },
    steering: [],
    options: {},
  } as RunInputSnapshot;
}

/**
 * One turn: dispatch the tool, then drain ONE result carrying the legacy's
 * error marker.
 *
 * The marker is `<tool_error>`, because `DuyaAgent._readToolResultOutcome`
 * INFERS error-ness from the content of a `role: 'tool'` row rather than reading
 * a flag. That inference is the legacy's own reader, so a result without the
 * marker reads as a SUCCESS -- which is the negative case below.
 */
function resultMessage(content: string): ToolDrainItem {
  return {
    kind: 'tool_result',
    callId: CALL_ID,
    content,
    isError: true,
    durationMs: 1,
  };
}

/** How many times the hook subprocess actually ran, and what it was handed. */
function dispatches(logFile: string): string[] {
  if (!existsSync(logFile)) return [];
  return readFileSync(logFile, 'utf-8').split('\n').filter((line) => line.length > 0);
}

// ============================================================================
// The run
// ============================================================================

/**
 * Drive a REAL `RunEngineImpl` whose `turnOutput` port is the REAL production
 * binding -- `agent.recordTurnToolResult`, exactly as `run-composition.ts`
 * wires it.
 *
 * The agent is constructed with `workingDirectory` at the test namespace so the
 * `ConfigHooksRunner` it builds inside `dispatchPostToolUseFailure` resolves the
 * hooks config written by `beforeEach`.
 */
async function runEngineWithFailingTool(content: string): Promise<string[]> {
  // The SAME path `beforeEach` handed to the hook config. Read from a second
  // source than the one that wrote it and the count would be a silent zero, which
  // is the exact failure this file exists to rule out.
  const logFile = currentLogFile;

  const { duyaAgent } = await import('../../agent/DuyaAgent.js');
  const agent = new duyaAgent({
    apiKey: 'test-key',
    model: 'claude-test',
    provider: 'anthropic',
    sessionId: 's-failure-hook-proof',
    workingDirectory: namespaceRoot(),
    permissionMode: 'bypassPermissions',
  });

  let turn = 0;
  const queued: ToolDrainItem[] = [];
  const model: ModelPort = {
    async *stream(_request: ModelRequest): AsyncIterable<ModelFrame> {
      turn += 1;
      // Turn 1 asks for the tool; turn 2 answers and stops. The run therefore
      // REACHES the failure arm and then completes normally, so a run that never
      // got there and a run that hung are distinguishable from a clean pass.
      if (turn === 1) {
        const call: ToolCallRequest = {
          callId: CALL_ID,
          name: FAILING_TOOL,
          input: { value: 'x' },
          sideEffect: 'read_only',
        };
        yield { type: 'tool_use', call };
      }
      yield { type: 'turn_stopped', reason: 'end_turn' };
    },
  };

  const recorded: { toolName: string; isError: boolean }[] = [];
  let agentErrors = 0;

  const ports: RunEnginePorts = {
    interTurn: {
      sweep: () =>
        Promise.resolve({ decision: { action: 'continue', absorbed: false }, injected: [] }),
    },
    model,
    tools: {
      dispatch(): void {
        queued.push(resultMessage(content));
      },
      async *drain(): AsyncIterable<ToolDrainItem> {
        for (const item of queued.splice(0, queued.length)) yield item;
      },
      discard(): void {
        queued.length = 0;
      },
      describe: (): readonly ToolDescriptor[] => [TOOL],
    },
    context: {
      assemble: (): Promise<AssembledTurn> =>
        Promise.resolve({
          systemPrompt: 'test',
          messages: [],
          tools: [TOOL],
          catalogRevision: 'cat-1',
          revision: 'rev-1',
        }),
      defer(_fragment: TransientContextFragment): void {},
    },
    approval: {
      authorize: (): Promise<ApprovalVerdict> =>
        Promise.resolve({ allowed: true, scope: 'once' }),
    },
    events: {
      publish(_event: RunEvent): void {},
      proposeTerminal(): void {},
    },
    // THE PRODUCTION BINDING, reproduced rather than imported:
    // `composeLegacyRunSources` reads `duyaAgent.recordTurnToolResult` through
    // `host.turnOutput.onToolResult` and hands it the projected `role: 'tool'`
    // row (`toToolResultMessage`). Reproducing those two lines keeps the test
    // free of the whole agent-composition fixture -- the assembly handle, the
    // pipeline publisher and the side-effect ledger -- none of which this claim
    // depends on. What IS real: the engine, the method under test, the error-bit
    // inference inside it, the `ConfigHooksRunner` it builds, and the hook
    // subprocess the runner spawns.
    turnOutput: {
      async recordToolResult(record): Promise<void> {
        const row = {
          role: 'tool',
          tool_call_id: record.outcome.callId,
          content: record.outcome.content,
          timestamp: Date.now(),
        } as unknown as Message;
        recorded.push({ toolName: record.toolName, isError: record.outcome.isError === true });
        try {
          await agent.recordTurnToolResult({
            message: row,
            toolName: record.toolName,
            seqIndex: 0,
          });
        } catch (error) {
          // Surfaced rather than swallowed: an exception inside the seam would
          // otherwise present as "the hook never fired", which reads as a missing
          // dispatch when it is a broken fixture.
          agentErrors += 1;
          throw error;
        }
      },
      async recordAssistantMessage(): Promise<void> {},
      async finishTurn(): Promise<void> {},
    },
  };

  const engine = new RunEngineImpl({ now: () => 1_000, defaultMaxTurns: 5 });
  const controller = new AbortController();
  const request: RunExecutionRequest = {
    manifest: manifestFor(),
    input: inputFor(),
    signal: controller.signal,
    ports,
  };
  await engine.execute(request).completed();
  // The engine's own reachability checks, asserted rather than assumed: if the
  // drain never produced a result, or the seam threw, the count below would read
  // zero and look like a hook that was never dispatched.
  expect(recorded).toHaveLength(1);
  expect(recorded[0]?.isError).toBe(true);
  expect(agentErrors).toBe(0);
  return dispatches(logFile);
}

// ============================================================================
// The proof
// ============================================================================

describe('PostToolUseFailure on an engine-driven run', () => {
  it('fires the configured hook EXACTLY once for a failed tool result', async () => {
    const lines = await runEngineWithFailingTool(`<tool_error>${ERROR_MARKER}</tool_error>`);

    // EXACTLY ONE. This is the load-bearing assertion of the whole file: it is
    // what makes "add PostToolUseFailure to PHASE_EVENTS" a DEFECT rather than a
    // missing feature. A second mechanism for one event would show up here as a
    // second line with the same payload.
    expect(lines).toHaveLength(1);
    // And the payload is the one a real configured hook reads: the event name,
    // the tool name the engine carried, the call id, and the error text.
    //
    // The `<tool_error>` wrapper SURVIVES into `error`, and that is asserted
    // rather than trimmed away: `DuyaAgent._readToolResultOutcome` infers the
    // error bit from the marker in the row's content and then hands the SAME
    // string to the hook, so a hook that greps `error` for the marker sees it.
    // Trimming it here would have hidden a difference between what the legacy
    // passes and what this seam passes.
    expect(lines[0]).toBe(
      `PostToolUseFailure|${FAILING_TOOL}|${CALL_ID}|<tool_error>${ERROR_MARKER}</tool_error>`,
    );
  });

  it('does NOT fire for a result the legacy reader calls a success', async () => {
    // The negative half, and the one that makes the positive meaningful: the
    // agent INFERS error-ness from the `<tool_error>` marker in a `role: 'tool'`
    // row (`DuyaAgent._readToolResultOutcome`), so a plain result is a success
    // and the hook must stay silent. A source that fired the event on every
    // `after_tool` regardless of the error bit would fail here.
    const lines = await runEngineWithFailingTool('everything went fine');

    expect(lines).toEqual([]);
  });
});
