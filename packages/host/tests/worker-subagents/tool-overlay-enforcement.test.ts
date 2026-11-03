/**
 * The per-call `tools: { allow?, deny? }` overlay must reach the EXECUTION layer.
 *
 * ## What this pins, and what it would have caught
 *
 * The overlay was applied to the tool list the sub-agent's PROMPT described
 * (`options.tools`), and to nothing else. The engine neither advertises nor
 * dispatches from that list: it advertises from
 * `agent.activeMCPRegistry.getAllTools()` and dispatches from the same
 * registry (`worker-run-composition.ts:151-154`). So a denied tool was still
 * visible to the model and still ran.
 *
 * A second defect rode along: the overlay's names were compared
 * case-SENSITIVELY against the registry's lowercase names, so the names a
 * model actually writes (`Read`, `Grep`, `Bash`) matched nothing at all.
 *
 * The third is the fallback: an overlay that narrowed the set to EMPTY fell
 * back to "all tools". An `allow` list that named no real tool therefore meant
 * "allow everything", which is the opposite of what it says.
 *
 * ## Why the existing test could not see any of this
 *
 * `subagentParams.test.ts:192` asserts the overlay is FORWARDED verbatim
 * (`['Read','Grep']` in, `['Read','Grep']` out). That is the second link of
 * the chain. The failure is in the third: what the host does with the names
 * once they arrive. A forwarding assertion is green on both sides of this
 * bug.
 *
 * ## Why the real classes run here
 *
 * `runAgent` builds its own session and its own registry, so a test cannot
 * hand it a double: the registry the engine dispatches from IS the thing under
 * test. Only `@duya/ai`'s client factory is replaced, the same construction
 * `engine-run.test.ts` uses.
 */

import { describe, expect, it, beforeEach, afterEach, afterAll, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ToolUseContext, Message, SSEEvent } from '../../src/worker-run-contracts.js';
import type { AgentProgressEvent, SubagentRunDeps } from '../../src/worker-subagents/run-agent.js';
import type { SubagentToolOverlay } from '@duya/capabilities/SubagentTool';
import { createWorkerSessionFactory } from '../../src/worker-tools/assembly.js';
import { createBuiltinRegistry } from '../../src/worker-tools/builtin.js';
import type { BuiltinRegistryServices } from '../../src/worker-tools/services.js';

const services = {
  duyaCliTool: Object.assign(async () => ({ success: true }), {
    toTool: () => ({ name: 'duya_cli', description: 'test stub', input_schema: { type: 'object' } }),
  }),
} as unknown as BuiltinRegistryServices;
const createSession = createWorkerSessionFactory(services);
const subagentDeps: SubagentRunDeps = {
  createSubAgent: (options) => createSession(options),
  createToolRegistry: () => createBuiltinRegistry(services, subagentDeps),
};

// ── the scripted provider ────────────────────────────────────────────────────

let script: SSEEvent[][] = [];
const providerState = vi.hoisted(() => ({ call: 0 }));

vi.mock('@duya/ai', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const delegating = {
    streamChat(_messages: unknown[], options?: Record<string, unknown>) {
      const signal = options?.signal as AbortSignal | undefined;
      const batch = script[Math.min(providerState.call, script.length - 1)] ?? [];
      providerState.call += 1;
      return (async function* () {
        for (const event of batch) {
          if (signal?.aborted) {
            throw Object.assign(new Error('aborted'), { name: 'AbortError' });
          }
          yield event;
        }
      })();
    },
  };
  return {
    ...actual,
    createAIClient: () => delegating,
    createAIClientWithRetry: () => delegating,
  };
});

vi.mock('@duya/host/worker-db-client', () => ({
  sessionDb: {
    create: vi.fn(async () => undefined),
    update: vi.fn(async () => undefined),
    get: vi.fn(async () => null),
  },
  messageDb: {
    getBySession: vi.fn(async () => []),
    getCount: vi.fn(async () => 0),
    loadMessages: vi.fn(async () => ({ messages: [] })),
    append: vi.fn(async () => ({ success: true, count: 1 })),
  },
}));

const { runAgent } = await import('../../src/worker-subagents/run-agent.js');

// Hoisted out of every timed body: the first run pays the whole builtin tool
// graph, and paying it inside a test's budget is a flake, not a finding.
await import('../../src/worker-tools/builtin.js');

// ── workspace ────────────────────────────────────────────────────────────────

const TMP_ROOT = mkdtempSync(join(tmpdir(), 'duya-subagent-overlay-'));
const WORKSPACE = join(TMP_ROOT, 'ws');
mkdirSync(WORKSPACE, { recursive: true });
const TARGET = join(WORKSPACE, 'target.txt');
writeFileSync(TARGET, 'SUBAGENT-OVERLAY-CANARY', 'utf8');

afterAll(() => {
  rmSync(TMP_ROOT, { recursive: true, force: true });
});

let seq = 0;

function agentDefinition(): never {
  return {
    agentType: 'general-purpose',
    whenToUse: 'test',
    tools: ['*'],
    source: 'custom',
    baseDir: 'custom',
    getSystemPrompt: () => 'role prompt',
  } as never;
}

function context(): ToolUseContext {
  return {
    toolUseId: 'tool-use-1',
    abortController: new AbortController(),
    getAppState: () => ({}),
    setAppState: () => {},
    options: {
      tools: [],
      commands: [],
      mainLoopModel: 'test-model',
      mcpClients: [],
      apiKey: 'test-key',
      baseURL: 'https://api.anthropic.com',
      provider: 'anthropic',
      sessionId: 'parent-1',
      workingDirectory: WORKSPACE,
      language: 'en',
      agentDefinitions: { activeAgents: [], allAgents: [agentDefinition()] },
    },
  } as unknown as ToolUseContext;
}

/**
 * Run one sub-agent under an overlay and hand back what a caller can see.
 *
 * The signal that a tool RAN is the canary: the `read` tool returns the file's
 * contents, so a tool_result carrying the canary is a tool that executed
 * against the real filesystem. An absent or empty tool_result is a tool the
 * engine never dispatched.
 */
async function drive(options: {
  script: SSEEvent[][];
  toolOverlay?: SubagentToolOverlay;
}): Promise<{ progress: AgentProgressEvent[]; message: Message }> {
  providerState.call = 0;
  script = options.script;
  const progress: AgentProgressEvent[] = [];
  const messages: Message[] = [];
  for await (const message of runAgent({
    agentDefinition: agentDefinition(),
    promptMessages: [{ id: 'p-1', role: 'user', content: 'read the file', timestamp: 0 }],
    toolUseContext: context(),
    isAsync: false,
    availableTools: [],
    agentId: `agent-${(seq += 1)}`,
    createSubAgent: subagentDeps.createSubAgent,
    createToolRegistry: subagentDeps.createToolRegistry,
    ...(options.toolOverlay === undefined ? {} : { toolOverlay: options.toolOverlay }),
    onProgress: (event) => progress.push(event),
  })) {
    messages.push(message);
  }
  const message = messages[messages.length - 1];
  if (message === undefined) throw new Error('runAgent yielded no message');
  return { progress, message };
}

/** The `read` call the scripted model makes. */
const READ_CALL: SSEEvent = {
  type: 'tool_use',
  data: { id: 'call-1', name: 'read', input: { file_path: TARGET } },
} as SSEEvent;

/** A second tool the model could ask for. `glob` is a distinct builtin. */
const GLOB_CALL: SSEEvent = {
  type: 'tool_use',
  data: { id: 'call-2', name: 'glob', input: { pattern: '**/*.txt', path: WORKSPACE } },
} as SSEEvent;

/** The script that asks for one tool, then ends the turn. */
function scriptCalling(tool: SSEEvent): SSEEvent[][] {
  return [
    [
      tool,
      { type: 'result', data: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } as SSEEvent,
      { type: 'done', reason: 'tool_use' } as SSEEvent,
    ],
    [{ type: 'text', data: 'done' } as SSEEvent, { type: 'done', reason: 'end_turn' } as SSEEvent],
  ];
}

/** Every tool_result body the run produced, concatenated. */
function toolResults(progress: AgentProgressEvent[]): string {
  return progress
    .filter((e) => e.type === 'tool_result')
    .map((e) => String(e.toolResult ?? ''))
    .join('\n');
}

describe('the per-call tool overlay reaches the execution layer', () => {
  beforeEach(() => {
    providerState.call = 0;
  });

  afterEach(() => {
    script = [];
  });

  it('runs the tool when the overlay permits it', async () => {
    // The control. Without it, "the tool never ran" would pass for any reason
    // at all — a broken harness reads exactly like a working restriction.
    const { progress } = await drive({
      script: scriptCalling(READ_CALL),
      toolOverlay: { allow: ['read'] },
    });

    expect(toolResults(progress)).toContain('SUBAGENT-OVERLAY-CANARY');
  });

  it('does not run a denied tool', async () => {
    const { progress } = await drive({
      script: scriptCalling(READ_CALL),
      toolOverlay: { deny: ['read'] },
    });

    // The canary is the file's CONTENTS, so its absence is the proof that no
    // read reached the filesystem. A tool_result that merely reported an
    // error would still be a dispatch.
    expect(toolResults(progress)).not.toContain('SUBAGENT-OVERLAY-CANARY');
  });

  it('does not run a tool the allow list does not name', async () => {
    const { progress } = await drive({
      script: scriptCalling(GLOB_CALL),
      toolOverlay: { allow: ['read'] },
    });

    expect(toolResults(progress)).not.toContain('SUBAGENT-OVERLAY-CANARY');
  });

  it('runs nothing when the allow list names no tool that exists', async () => {
    // The fallback this replaces: an overlay that narrowed the set to EMPTY
    // used to fall back to "all tools". An allow list that names nothing real
    // means "allow nothing", and the only way to say that is to run nothing.
    const { progress } = await drive({
      script: scriptCalling(READ_CALL),
      toolOverlay: { allow: ['no_such_tool_anywhere'] },
    });

    expect(toolResults(progress)).not.toContain('SUBAGENT-OVERLAY-CANARY');
  });

  it('matches the overlay names case-insensitively', async () => {
    // `Read` is the name a model writes. The registry's name is `read`. A
    // case-sensitive comparison silently matched nothing, which under the
    // old fallback read as "allow everything".
    const { progress } = await drive({
      script: scriptCalling(READ_CALL),
      toolOverlay: { allow: ['Read'] },
    });

    expect(toolResults(progress)).toContain('SUBAGENT-OVERLAY-CANARY');
  });
});
