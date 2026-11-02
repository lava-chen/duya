/**
 * The id a sub-agent hands back must be the id a resume accepts.
 *
 * ## What was broken
 *
 * The background spawn notice told the model `subagent_id: <taskId>`. The
 * resume lookup reads `sessions.id`. Those are two different UUIDs minted a
 * few lines apart, and the task id is never written to `sessions` — so the
 * model copied the id it was given into `resume_from` and the lookup answered
 * `unknown_session`.
 *
 * The tool's own schema says the value is "a subagent_id returned by a
 * previous task call", and the FOREGROUND receipt already honoured that by
 * printing the session id. Only the background notice disagreed with its own
 * contract.
 *
 * ## Why this is an END-TO-END assertion and not a string check
 *
 * A test that reads the notice and compares it to the payload's `sessionId`
 * proves the formatter prints what it was handed. It does not prove the
 * formatter was handed the SESSION id rather than the task id — that is
 * decided at the call site, one layer up, and a formatter-level test cannot
 * see it.
 *
 * So this drives the real tool, takes the id out of the notice the MODEL
 * would see, and feeds it straight back into `resume_from`. The mocked
 * `sessionDb.create` records the row it was asked to create, so the lookup
 * can only succeed if the notice named that same id.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import * as os from 'node:os';
import { useIsolatedDataRoot } from '../workspace/fixtures.js';
import type { ToolUseContext } from '../../src/worker-run-contracts.js';

const mocks = vi.hoisted(() => ({
  runAgentParams: [] as unknown[],
  runAgentSyncParams: [] as unknown[],
  registerCalls: [] as Array<Record<string, unknown>>,
  sessionRows: new Map<string, Record<string, unknown>>(),
  createdRows: [] as Array<Record<string, unknown>>,
  historyRows: [] as unknown[],
}));

vi.mock('@duya/host/worker-db-client', () => ({
  sessionDb: {
    // The row a spawn creates is the row a resume reads. Recording it here is
    // what makes the round trip below real rather than arranged.
    create: vi.fn(async (input: Record<string, unknown>) => {
      mocks.createdRows.push(input);
      const id = input?.id;
      if (typeof id === 'string') {
        mocks.sessionRows.set(id, {
          id,
          agent_type: 'sub-agent',
          parent_session_id: 'parent-1',
          working_directory: '',
        });
      }
    }),
    update: vi.fn(async () => undefined),
    get: vi.fn(async (id: string) => mocks.sessionRows.get(id) ?? null),
    setExtension: vi.fn(async () => undefined),
  },
  messageDb: {
    getBySession: vi.fn(async () => []),
    getCount: vi.fn(async () => 0),
    loadMessages: vi.fn(async () => ({ messages: mocks.historyRows })),
  },
}));

vi.mock('@duya/host/worker-transport', () => ({
  sendEvent: vi.fn(),
}));

vi.mock('../../src/worker-subagents/run-agent.js', () => ({
  runAgent: (params: unknown) => {
    mocks.runAgentParams.push(params);
    return (async function* () { /* never iterated in these tests */ })();
  },
  runAgentSync: async (params: unknown) => {
    mocks.runAgentSyncParams.push(params);
    return {
      id: 'msg-1',
      role: 'assistant',
      content: [{ type: 'text', text: 'child done' }],
      timestamp: Date.now(),
      metadata: {},
    };
  },
}));

vi.mock('@duya/host/worker-subagents/background-lifecycle', () => ({
  backgroundAgentLifecycle: {
    register: (input: Record<string, unknown>) => {
      mocks.registerCalls.push(input);
      return { outputFilePath: 'C:/duya/subagent-transcripts/t-1.jsonl' };
    },
    run: async () => undefined,
    getSnapshot: () => ({ status: 'completed' }),
    markDrained: () => undefined,
  },
}));

vi.mock('../../src/worker-subagents/task-verification.js', () => ({
  VERDICT_CONTRACT: '',
  wantsVerdictContract: () => false,
  parseModelVerdict: () => undefined,
  captureGitFileChanges: async () => undefined,
  diffFileChanges: () => undefined,
  buildSubagentParentReport: () => '',
}));

const { SubagentTool } = await import('../../src/worker-subagents/bound-tool.js');
const subagentTool = new SubagentTool({
  createSubAgent: () => { throw new Error('not used by the identity suite'); },
  createToolRegistry: () => { throw new Error('not used by the identity suite'); },
});

let restoreDataRoot: () => void;
beforeAll(() => { restoreDataRoot = useIsolatedDataRoot(); });
afterAll(() => { restoreDataRoot(); });

function makeContext(): ToolUseContext {
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
      sessionId: 'parent-1',
      workingDirectory: os.tmpdir(),
      agentDefinitions: {
        activeAgents: [],
        allAgents: [
          {
            agentType: 'general-purpose',
            whenToUse: 'Anything',
            tools: ['*'],
            source: 'built-in',
            baseDir: 'built-in',
            getSystemPrompt: () => 'role prompt',
          },
        ],
      },
    },
  } as unknown as ToolUseContext;
}

/** The id the MODEL reads out of the spawn notice. */
function noticeSubagentId(content: string): string | undefined {
  return /^subagent_id:\s*(\S+)$/m.exec(content)?.[1];
}

describe('the id a background spawn hands back is the id a resume accepts', () => {
  beforeEach(() => {
    mocks.runAgentParams.length = 0;
    mocks.runAgentSyncParams.length = 0;
    mocks.registerCalls.length = 0;
    mocks.createdRows.length = 0;
    mocks.sessionRows.clear();
    mocks.historyRows = [];
  });

  it('names the session the spawn created, not the task id', async () => {
    const result = await subagentTool.execute(
      { prompt: 'background please' },
      undefined,
      makeContext(),
    );

    const receipt = JSON.parse(result.result) as { content: string; sessionId: string; taskId: string };
    const createdId = mocks.createdRows[0]?.id;

    expect(createdId).toBe(receipt.sessionId);
    expect(noticeSubagentId(receipt.content)).toBe(receipt.sessionId);
    // The task id is a different thing and belongs to get_task_output, not to
    // resume_from. Naming it as the subagent_id is what broke the round trip.
    expect(receipt.taskId).not.toBe(receipt.sessionId);
    expect(noticeSubagentId(receipt.content)).not.toBe(receipt.taskId);
  });

  it('round-trips: the id in the notice resumes the sub-agent', async () => {
    const spawned = await subagentTool.execute(
      { prompt: 'background please' },
      undefined,
      makeContext(),
    );
    const receipt = JSON.parse(spawned.result) as { content: string };
    const subagentId = noticeSubagentId(receipt.content);
    expect(subagentId).toBeTruthy();

    // The history a resume needs. Without it the lookup would answer
    // `no_history` — a different failure, and one the child session's own
    // persistence is what prevents.
    mocks.historyRows = [{ id: 'old-1', role: 'user', content: 'previous task', timestamp: 1 }];

    const resumed = await subagentTool.execute(
      { prompt: 'continue', subagent_type: 'general-purpose', resume_from: subagentId },
      undefined,
      makeContext(),
    );

    const payload = JSON.parse(resumed.result) as { error?: string };
    expect(payload.error).toBeUndefined();
  });

  it('still names the task id where get_task_output needs it', async () => {
    const result = await subagentTool.execute(
      { prompt: 'background please', auto_wake: false },
      undefined,
      makeContext(),
    );

    const receipt = JSON.parse(result.result) as { content: string; taskId: string };
    expect(receipt.content).toContain(`get_task_output using task_id "${receipt.taskId}"`);
  });
});
