/**
 * Plan 408b — nested AGENTS.md loop wiring test.
 *
 * Verifies the DuyaAgent PostToolUse wiring end to end (with a scripted LLM):
 * a scripted `read` of a file under a subtree containing AGENTS.md must
 * surface a one-shot `<system-reminder>` user-role injection on the next
 * round, and a repeat read must NOT re-inject (session-level dedup).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { SSEEvent } from '../../../src/types.js';

// --- Scripted LLM client ----------------------------------------------------

const streamState = vi.hoisted(() => ({
  current: { responses: [] as SSEEvent[][] },
  callCount: 0,
  seenMessages: [] as unknown[][],
}));

vi.mock('@duya/ai', async (importOriginal) => {
  const mod = await importOriginal<typeof import('@duya/ai')>();
  const mockClient = (): unknown => ({
    streamChat: vi.fn(async function* (messages: unknown[]) {
      streamState.callCount += 1;
      streamState.seenMessages.push(messages);
      const scripted =
        streamState.current.responses[streamState.callCount - 1] ?? [
          { type: 'text', data: 'ok' },
          { type: 'done' },
        ];
      for (const event of scripted) {
        yield event as SSEEvent;
      }
    }),
  });
  return {
    ...mod,
    createAIClient: vi.fn(() => mockClient()),
    createAIClientWithRetry: vi.fn(() => mockClient()),
    inferProvider: vi.fn(() => 'anthropic'),
  };
});

vi.mock('../../../src/ipc/db-client.js', () => ({
  mailboxDb: {
    claimBatch: vi.fn(async () => ({ rows: [], claimTokens: [] })),
    apply: vi.fn(async () => ({})),
    markObserved: vi.fn(async () => ({})),
  },
  pluginDb: { list: vi.fn(async () => []) },
  // The run driver settles through the agent's `Journal`, which imports
  // `messageDb` at module load. `streamChat` never reached one.
  messageDb: {
    append: vi.fn(async (_sessionId: string, messages: unknown[]) => ({
      success: true,
      count: messages.length,
    })),
  },
}));

// --- Real nested-loader behind the manager mock -----------------------------
// The repo dir is filled by beforeEach; the manager facade delegates to the
// REAL collectNestedMemoryFiles so this test covers discovery + wiring.

const nestedState = vi.hoisted(() => ({
  repoDir: '',
  loadedPaths: new Set<string>(),
}));

vi.mock('../../../src/agentsmd/index.js', () => ({
  getAgentsMdManager: vi.fn(() => ({
    refreshForTask: vi.fn(async () => false),
    buildAgentsMdPrompt: vi.fn(() => ''),
    buildAgentsMdSection: vi.fn(() => ''),
    getLoadedFiles: vi.fn(() => []),
    getFilesByType: vi.fn(() => []),
    getLargeFiles: vi.fn(() => []),
    hasFiles: vi.fn(() => false),
    getFileCount: vi.fn(() => 0),
    async collectNestedMemory(triggerPaths: string[]) {
      const { collectNestedMemoryFiles } = await import(
        '../../../src/agentsmd/nested-loader.js'
      );
      return collectNestedMemoryFiles({
        cwd: nestedState.repoDir,
        triggerPaths,
        loadedPaths: nestedState.loadedPaths,
      });
    },
    renderNestedMemoryBlock(files: Array<{ path: string; content: string }>) {
      if (files.length === 0) return '';
      const memories = files.map(
        (f) =>
          `Contents of ${f.path} (project instructions, nested directory):\n\n${f.content}`,
      );
      // Plan 567 §B: inner body only — DuyaAgent wraps the outer envelope
      // via renderSystemReminder(inner, 'nested_agents_md').
      return `<project_instructions_spec>\n${memories.join('\n\n')}\n</project_instructions_spec>`;
    },
  })),
}));

// ---------------------------------------------------------------------------

import { duyaAgent } from '../../../src/agent/DuyaAgent.js';
import { clearCommandQueue } from '../../../src/queue/index.js';
import { ToolRegistry } from '../../../src/tool/registry.js';
import {
  cleanupEngineTurnDirs,
  driveTurn,
  installEngineTurnIpc,
  restoreEngineTurnIpc,
} from '../../helpers/engineTurnHarness.js';

function makeRepo(): string {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'duya-nested-wire-'));
  const target = path.join(repo, 'pkg', 'a.ts');
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, 'export {};\n', 'utf-8');
  fs.writeFileSync(path.join(repo, 'pkg', 'AGENTS.md'), 'Use barrels sparingly.\n', 'utf-8');
  return repo;
}

/**
 * Drive one real turn through the run driver.
 *
 * `DuyaAgent.streamChat` no longer exists (plan 610 A3 / S4c-d3); the turn loop
 * is `driveRunWithEngine`'s. The claim under test -- a `read` below cwd injects
 * a one-shot nested-AGENTS.md reminder into the NEXT round, and a repeat read
 * does not -- lives in the PostToolUse wiring, which the driver reaches through
 * the same `beginTurnAssembly` the legacy did. `maxTurns` is raised because the
 * injection only becomes visible on the round after the tool runs.
 *
 * The stub tool goes on the agent's own catalog rather than in
 * `options.toolRegistry`: `_resolveTools` still reads that field to build the
 * DECLARED surface, but the engine DISPATCHES through
 * `composeLegacyRunPorts`' `lookup`, which is derived from
 * `agent.activeMCPRegistry` (`run-composition.ts:716-727`). A tool advertised
 * from one registry and dispatched out of the other is refused before it can run,
 * which would leave this file proving nothing about nested memory.
 */
async function drainStream(agent: duyaAgent, prompt: string): Promise<void> {
  agent.activeMCPRegistry.register(
    { name: 'read', description: 'read stub', input_schema: {} },
    {
      execute: async (input: Record<string, unknown>) => ({
        id: `result-${crypto.randomUUID()}`,
        name: 'read',
        result: `(stubbed contents of ${String(input.file_path)})`,
      }),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any,
  );
  await driveTurn(agent, prompt, { maxTurns: 4 });
}

const registry = new ToolRegistry();
registry.register(
  { name: 'read', description: 'read stub', input_schema: {} },
  {
    // eslint-disable-next-line @typescript-eslint/require-await
    execute: async (input: Record<string, unknown>) => ({
      id: `result-${crypto.randomUUID()}`,
      name: 'read',
      result: `(stubbed contents of ${String(input.file_path)})`,
    }),
  },
);

describe('Plan 408b — nested AGENTS.md injection wiring', () => {
  beforeEach(async () => {
    streamState.current = { responses: [] };
    streamState.callCount = 0;
    streamState.seenMessages = [];
    clearCommandQueue();
    await installEngineTurnIpc();
  });

  afterEach(() => {
    clearCommandQueue();
    restoreEngineTurnIpc();
    cleanupEngineTurnDirs();
    vi.restoreAllMocks();
  });

  it('injects a nested AGENTS.md reminder after a read below cwd', async () => {
    const repo = makeRepo();
    nestedState.repoDir = repo;
    nestedState.loadedPaths = new Set();

    try {
      const agent = new duyaAgent({
        apiKey: 'test-key',
        provider: 'anthropic',
        model: 'test-model',
        enableRetry: false,
        workingDirectory: repo,
      });
      streamState.current = {
        responses: [
          [
            {
              type: 'tool_use',
              data: {
                id: 'tu-1',
                name: 'read',
                input: { file_path: path.join(repo, 'pkg', 'a.ts') },
              },
            },
            { type: 'done' },
          ],
          [{ type: 'text', data: 'done reading' }, { type: 'done' }],
        ],
      };

      await drainStream(agent, 'read the file');

      // The turn really ran a tool and really took a second round, so the
      // absence below is the injection and not a turn that stopped early.
      expect(streamState.callCount).toBe(2);

      const round2 = streamState.seenMessages[1] as Array<{
        role: string;
        content: unknown;
        metadata?: Record<string, unknown>;
      }>;
      const injected = round2.find(
        (m) =>
          m.role === 'user' &&
          typeof m.content === 'string' &&
          m.content.includes('nested-agents-md') === false &&
          m.content.includes('<system-reminder>') &&
          m.content.includes('nested directory') &&
          m.content.includes('Use barrels sparingly.'),
      );
      // KNOWN PRODUCTION DEFECT, not a harness artifact. This assertion was
      // green against `streamChat` and is red against the run driver, and it is
      // left red here on purpose rather than deleted or weakened.
      //
      // The nested-AGENTS.md injection had NO producer on the PostToolUse path
      // the driver reaches. It lived inside `streamChat`'s tool-result block
      // (deleted in `539b97f0`) as a `collectNestedMemory(triggerPaths)` call
      // feeding `renderNestedMemoryBlock` into `applyHookInjection`. The
      // vocabulary survives -- `agent/reminder-sources.ts:46` still names
      // `nested_agents_md` and `agentsmd/manager.ts:279` still exposes the
      // collector -- but `grep -r "collectNestedMemory" packages/agent/src`
      // now matches only the loader itself and its manager, with no caller in
      // the turn path. So a feature-flagged capability
      // (`config/feature-flags.ts:29`, `duya_nested_agents_md`) is live and
      // unwired.
      //
      // The fix is to lift that block onto the driver's tool-result seam the
      // way plan 610 lifted `claimInterTurn` and `forkTurn`, which is
      // production source and outside this migration's scope.
      expect(injected, 'the nested AGENTS.md injection has no engine-path producer').toBeDefined();
      expect(injected?.metadata?.source).toBe('nested-agents-md');
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it('does not re-inject on a second read of the same subtree', async () => {
    const repo = makeRepo();
    nestedState.repoDir = repo;
    nestedState.loadedPaths = new Set();

    try {
      const script = {
        responses: [
          [
            {
              type: 'tool_use' as const,
              data: {
                id: 'tu-1',
                name: 'read',
                input: { file_path: path.join(repo, 'pkg', 'a.ts') },
              },
            },
            { type: 'done' as const },
          ],
          [{ type: 'text' as const, data: 'ok' }, { type: 'done' as const }],
        ],
      };

      const firstAgent = new duyaAgent({
        apiKey: 'test-key',
        provider: 'anthropic',
        model: 'test-model',
        enableRetry: false,
        workingDirectory: repo,
      });
      streamState.current = script;
      await drainStream(firstAgent, 'read once');

      // Shared session state (nestedState.loadedPaths) simulates the same
      // session continuing: a second read must produce no new injection.
      streamState.callCount = 0;
      streamState.seenMessages = [];
      const secondAgent = new duyaAgent({
        apiKey: 'test-key',
        provider: 'anthropic',
        model: 'test-model',
        enableRetry: false,
        workingDirectory: repo,
      });
      await drainStream(secondAgent, 'read again');

      const round2 = streamState.seenMessages[1] as Array<{ role: string; content: unknown }>;
      expect(
        round2.some(
          (m) =>
            m.role === 'user' &&
            typeof m.content === 'string' &&
            m.content.includes('Use barrels sparingly.'),
        ),
      ).toBe(false);
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });
});
