/**
 * Plan 571 — the `task` tool's parameter surface must be REAL.
 *
 * The defect these tests exist for: `auto_wake`, `resume_from` and
 * `isolation` were advertised in `input_schema` but never read in
 * `execute()`, and `maxTurns` was read but never advertised. A schema test
 * alone cannot catch that class of bug (it only proves the property exists),
 * so every case here drives `execute()` and asserts the value reached the
 * layer that is supposed to consume it.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';
import { mkdtempSync } from 'node:fs';
import type { ToolUseContext, Message } from '../../../types.js';
import type { RunAgentParams } from '../runAgent.js';

const mocks = vi.hoisted(() => ({
  runAgentParams: [] as unknown[],
  runAgentSyncParams: [] as unknown[],
  registerCalls: [] as Array<Record<string, unknown>>,
  sessionRows: new Map<string, Record<string, unknown>>(),
  historyRows: [] as unknown[],
}));

vi.mock('../../../ipc/db-client.js', () => ({
  sessionDb: {
    create: vi.fn(async () => undefined),
    update: vi.fn(async () => undefined),
    get: vi.fn(async (id: string) => mocks.sessionRows.get(id) ?? null),
  },
  messageDb: {
    getBySession: vi.fn(async () => []),
    getCount: vi.fn(async () => 0),
    loadMessages: vi.fn(async () => ({ messages: mocks.historyRows })),
  },
}));

vi.mock('../../../process/worker-protocol.js', () => ({
  sendEvent: vi.fn(),
}));

vi.mock('../runAgent.js', () => ({
  runAgent: (params: RunAgentParams) => {
    mocks.runAgentParams.push(params);
    return (async function* () { /* never iterated in these tests */ })();
  },
  runAgentSync: async (params: RunAgentParams): Promise<Message> => {
    mocks.runAgentSyncParams.push(params);
    return {
      id: 'msg-1',
      role: 'assistant',
      content: [{ type: 'text', text: 'child done' }],
      timestamp: Date.now(),
      metadata: { agentToolCallCount: 3, agentDurationMs: 120 },
    };
  },
}));

vi.mock('../../../lifecycle/BackgroundAgentLifecycle.js', () => ({
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

// Keep the test hermetic: no git subprocess, no verdict parsing.
vi.mock('../../task-verification.js', () => ({
  VERDICT_CONTRACT: '',
  wantsVerdictContract: () => false,
  parseModelVerdict: () => undefined,
  captureGitFileChanges: async () => undefined,
  diffFileChanges: () => undefined,
  buildSubagentParentReport: () => '',
}));

const { subagentTool } = await import('../SubagentTool.js');

function makeContext(overrides: Record<string, unknown> = {}): ToolUseContext {
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
      ...overrides,
    },
  } as unknown as ToolUseContext;
}

function lastSyncParams(): RunAgentParams {
  return mocks.runAgentSyncParams[mocks.runAgentSyncParams.length - 1] as RunAgentParams;
}

describe('SubagentTool parameter surface (plan 571)', () => {
  beforeEach(() => {
    mocks.runAgentParams.length = 0;
    mocks.runAgentSyncParams.length = 0;
    mocks.registerCalls.length = 0;
    mocks.sessionRows.clear();
    mocks.historyRows = [];
  });

  describe('new parameters reach the child run', () => {
    it('forwards max_turns / effort / permission_mode / tools to runAgentSync', async () => {
      await subagentTool.execute(
        {
          prompt: 'do the thing',
          run_in_background: false,
          max_turns: 7,
          effort: 'HIGH',
          permission_mode: 'bypassPermissions',
          tools: { allow: ['Read', 'Grep'], deny: ['Bash'] },
        },
        undefined,
        makeContext(),
      );

      const params = lastSyncParams();
      expect(params.maxTurns).toBe(7);
      expect(params.effort).toBe('high');
      expect(params.permissionMode).toBe('bypassPermissions');
      expect(params.toolOverlay).toEqual({ allow: ['Read', 'Grep'], deny: ['Bash'] });
    });

    it('drops invalid values instead of forwarding them, and warns about each', async () => {
      const result = await subagentTool.execute(
        {
          prompt: 'do the thing',
          run_in_background: false,
          max_turns: 0,
          effort: 'turbo',
          permission_mode: 'yolo',
          tools: { allow: [] },
        },
        undefined,
        makeContext(),
      );

      const params = lastSyncParams();
      expect(params.maxTurns).toBeUndefined();
      expect(params.effort).toBeUndefined();
      expect(params.permissionMode).toBeUndefined();
      expect(params.toolOverlay).toBeUndefined();

      const receipt = JSON.parse(result.result) as { warnings?: string[] };
      expect(receipt.warnings?.length).toBeGreaterThanOrEqual(3);
    });
  });

  describe('auto_wake', () => {
    it('defaults to true and is registered on the lifecycle', async () => {
      await subagentTool.execute(
        { prompt: 'background please' },
        undefined,
        makeContext(),
      );

      expect(mocks.registerCalls[0]?.autoWake).toBe(true);
    });

    it('auto_wake: false is registered and changes the spawn notice', async () => {
      const result = await subagentTool.execute(
        { prompt: 'background please', auto_wake: false },
        undefined,
        makeContext(),
      );

      expect(mocks.registerCalls[0]?.autoWake).toBe(false);
      const receipt = JSON.parse(result.result) as { content: string; outputFilePath?: string };
      expect(receipt.content).toContain('auto_wake is false');
      expect(receipt.content).toContain('get_task_output');
      // The model needs the path to fetch the result itself.
      expect(receipt.outputFilePath).toBe('C:/duya/subagent-transcripts/t-1.jsonl');
    });
  });

  describe('resume_from', () => {
    it('rejects an unknown session id with a structured error and spawns nothing', async () => {
      const result = await subagentTool.execute(
        { prompt: 'continue', resume_from: 'nope' },
        undefined,
        makeContext(),
      );

      expect(result.error).toBe(true);
      const receipt = JSON.parse(result.result) as { error: string };
      expect(receipt.error).toContain('nope');
      expect(mocks.registerCalls).toHaveLength(0);
      expect(mocks.runAgentParams).toHaveLength(0);
    });

    it('rejects a top-level (non sub-agent) session id', async () => {
      mocks.sessionRows.set('top-level', { id: 'top-level', agent_type: 'user' });

      const result = await subagentTool.execute(
        { prompt: 'continue', resume_from: 'top-level' },
        undefined,
        makeContext(),
      );

      expect(result.error).toBe(true);
      expect(JSON.parse(result.result).error).toContain('not a sub-agent session');
    });

    it('rejects a sub-agent owned by a different parent session', async () => {
      mocks.sessionRows.set('other', {
        id: 'other',
        agent_type: 'sub-agent',
        parent_session_id: 'parent-2',
      });

      const result = await subagentTool.execute(
        { prompt: 'continue', resume_from: 'other' },
        undefined,
        makeContext(),
      );

      expect(result.error).toBe(true);
      expect(JSON.parse(result.result).error).toContain('different parent session');
    });

    it('reuses the same sub-agent session id and prepends its history', async () => {
      mocks.sessionRows.set('child-1', {
        id: 'child-1',
        agent_type: 'sub-agent',
        parent_session_id: 'parent-1',
        agent_name: 'reviewer',
      });
      mocks.historyRows = [
        { id: 'm1', role: 'user', content: 'first ask', timestamp: 1 },
        { id: 'm2', role: 'assistant', content: 'first answer', timestamp: 2 },
      ];

      const result = await subagentTool.execute(
        { prompt: 'now check the tests', resume_from: 'child-1', run_in_background: false },
        undefined,
        makeContext(),
      );

      const params = lastSyncParams();
      expect(params.sessionId).toBe('child-1');
      // History first, new prompt last — the transcript continues.
      expect(params.promptMessages).toHaveLength(3);
      expect(params.promptMessages[0]?.content).toBe('first ask');
      expect(params.promptMessages[2]?.content).toContain('now check the tests');

      const receipt = JSON.parse(result.result) as { sessionId: string; status: string };
      expect(receipt.sessionId).toBe('child-1');
      expect(receipt.status).toBe('completed');
    });
  });

  describe('isolation: worktree', () => {
    it('returns a structured error outside a git repository and spawns nothing', async () => {
      const outsideRepo = mkdtempSync(path.join(os.tmpdir(), 'duya-not-a-repo-'));

      const result = await subagentTool.execute(
        { prompt: 'edit some files', isolation: 'worktree', run_in_background: false },
        undefined,
        makeContext({ workingDirectory: outsideRepo }),
      );

      expect(result.error).toBe(true);
      const receipt = JSON.parse(result.result) as { error: string };
      expect(receipt.error).toContain('not inside one');
      expect(lastSyncParams()).toBeUndefined();
    });

    it('refuses to combine worktree isolation with resume_from', async () => {
      mocks.sessionRows.set('child-1', {
        id: 'child-1',
        agent_type: 'sub-agent',
        parent_session_id: 'parent-1',
      });
      mocks.historyRows = [{ id: 'm1', role: 'user', content: 'first', timestamp: 1 }];

      const result = await subagentTool.execute(
        { prompt: 'continue', resume_from: 'child-1', isolation: 'worktree' },
        undefined,
        makeContext(),
      );

      expect(result.error).toBe(true);
      expect(JSON.parse(result.result).error).toContain('cannot be combined with resume_from');
    });
  });

  describe('typed result contract', () => {
    it('foreground completion emits the full contract', async () => {
      const result = await subagentTool.execute(
        { prompt: 'do the thing', run_in_background: false },
        undefined,
        makeContext(),
      );

      const receipt = JSON.parse(result.result) as Record<string, unknown>;
      expect(receipt.status).toBe('completed');
      expect(receipt.agentType).toBe('general-purpose');
      expect(receipt.resolvedAgentType).toBe('general-purpose');
      expect(receipt.content).toContain('child done');
      expect(typeof receipt.sessionId).toBe('string');
      expect(typeof receipt.taskId).toBe('string');
      expect(typeof receipt.agentId).toBe('string');
      expect(receipt.background).toBe(false);
      // Counters come from the child's own metadata, not a hardcoded 0.
      expect(receipt.totalToolUseCount).toBe(3);
      expect(receipt.totalDurationMs).toBe(120);
      expect(receipt.workingDirectory).toBe(os.tmpdir());
    });

    it('background spawn emits a running receipt carrying the output file path', async () => {
      const result = await subagentTool.execute(
        { prompt: 'background please' },
        undefined,
        makeContext(),
      );

      const receipt = JSON.parse(result.result) as Record<string, unknown>;
      expect(receipt.status).toBe('running');
      expect(receipt.background).toBe(true);
      expect(receipt.outputFilePath).toBe('C:/duya/subagent-transcripts/t-1.jsonl');
      // No legacy field names — the renderer parser still reads them, but we
      // must not emit them.
      expect(receipt.childSessionId).toBeUndefined();
      expect(receipt.backgroundTaskId).toBeUndefined();
      expect(receipt.outputFile).toBeUndefined();
      expect(receipt.isAsync).toBeUndefined();
    });
  });
});
