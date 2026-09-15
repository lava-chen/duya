/**
 * PlanTool — plan 536 fallback behavior.
 *
 * Verifies that PlanTool.execute() reads `projectId` from
 * `ToolUseContext.currentProjectId` when the model omits it from input,
 * and surfaces a clear error when neither is available.
 *
 * The real PlanTool.storage layer is mocked (vi.mock + vi.hoisted
 * singleton per AGENTS.md test pattern) so the test stays unit-level and
 * does not touch ~/.duya/projects/.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ToolUseContext } from '../../../types.js';

const mocks = vi.hoisted(() => ({
  planStatus: vi.fn(),
  planComplete: vi.fn(),
  planSearch: vi.fn(),
}));

vi.mock('../storage.js', () => ({
  planStatus: mocks.planStatus,
  planSearch: mocks.planSearch,
  planComplete: mocks.planComplete,
  PlansError: class PlansError extends Error {
    constructor(message: string, public code: string) {
      super(message);
      this.name = 'PlansError';
    }
  },
}));

import { PlanTool } from '../PlanTool.js';

const tool = new PlanTool();

function makeContext(currentProjectId?: string | null): ToolUseContext {
  return {
    toolUseId: 'test',
    getAppState: () => ({}) as never,
    setAppState: () => {},
    abortController: new AbortController(),
    options: { tools: [], commands: [], mainLoopModel: 'test', mcpClients: [] },
    currentProjectId,
  };
}

const statusResultFixture = {
  projectId: 'auto-filled',
  plans: [],
  idHealth: undefined,
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.planStatus.mockReturnValue(statusResultFixture);
  mocks.planComplete.mockReturnValue({
    planId: 1,
    newFile: '~/.duya/projects/auto-filled/plans/completed/1-test.md',
  });
  mocks.planSearch.mockReturnValue({ results: [] });
});

describe('PlanTool — plan 536 projectId fallback', () => {
  it('uses explicit projectId when provided', async () => {
    const result = await tool.execute(
      { action: 'status', projectId: 'e4e2b217' },
      '/tmp',
      makeContext('from-context'),
    );
    expect(result.error).toBeFalsy();
    expect(mocks.planStatus).toHaveBeenCalledWith({
      projectId: 'e4e2b217',
      status: undefined,
    });
  });

  it('falls back to context.currentProjectId when input omits projectId', async () => {
    const result = await tool.execute(
      { action: 'status' },
      '/tmp',
      makeContext('95bd37a5-9f83-4caa-bd2e-8205fedc77d1'),
    );
    expect(result.error).toBeFalsy();
    expect(mocks.planStatus).toHaveBeenCalledWith({
      projectId: '95bd37a5-9f83-4caa-bd2e-8205fedc77d1',
      status: undefined,
    });
  });

  it('uses explicit input over context (explicit wins)', async () => {
    const result = await tool.execute(
      { action: 'status', projectId: 'explicit-id' },
      '/tmp',
      makeContext('context-id'),
    );
    expect(mocks.planStatus).toHaveBeenCalledWith({
      projectId: 'explicit-id',
      status: undefined,
    });
  });

  it('returns clear error when no projectId and no context project (status)', async () => {
    const result = await tool.execute(
      { action: 'status' },
      '/tmp',
      makeContext(null),
    );
    expect(result.error).toBe(true);
    expect(result.result).toContain('projectId');
    expect(result.result).toContain('required');
    expect(result.result).toContain('currentProjectId is null');
    expect(mocks.planStatus).not.toHaveBeenCalled();
  });

  it('returns clear error when no projectId and no context project (complete)', async () => {
    const result = await tool.execute(
      { action: 'complete', planId: 1 },
      '/tmp',
      makeContext(undefined),
    );
    expect(result.error).toBe(true);
    expect(result.result).toContain('projectId');
    expect(result.result).toContain('required');
    expect(mocks.planComplete).not.toHaveBeenCalled();
  });

  it('falls back to context for complete action too', async () => {
    const result = await tool.execute(
      { action: 'complete', planId: 7 },
      '/tmp',
      makeContext('ctx-proj-id'),
    );
    expect(result.error).toBeFalsy();
    expect(mocks.planComplete).toHaveBeenCalledWith({
      projectId: 'ctx-proj-id',
      planId: 7,
    });
  });

  it('does not require projectId for search action (search runs without one)', async () => {
    const result = await tool.execute(
      { action: 'search', query: 'foo' },
      '/tmp',
      makeContext(null),
    );
    // Search uses the mocked planSearch which returns undefined; result is
    // still produced (not an error). The point: search does not gate on
    // currentProjectId.
    expect(result.error).toBeFalsy();
  });

  it('schema does not require projectId (top-level required is just action)', () => {
    expect(tool.input_schema.required).toEqual(['action']);
  });

  it('allOf status branch no longer hard-requires projectId', () => {
    const statusBranch = (tool.input_schema.allOf as Array<{
      if: { properties: { action: { const: string } } };
      then: { required?: string[] };
    }>).find((b) => b.if.properties.action.const === 'status');
    expect(statusBranch).toBeDefined();
    expect(statusBranch?.then.required ?? []).not.toContain('projectId');
  });

  it('allOf complete branch still hard-requires planId', () => {
    const completeBranch = (tool.input_schema.allOf as Array<{
      if: { properties: { action: { const: string } } };
      then: { required?: string[] };
    }>).find((b) => b.if.properties.action.const === 'complete');
    expect(completeBranch).toBeDefined();
    expect(completeBranch?.then.required ?? []).toContain('planId');
    expect(completeBranch?.then.required ?? []).not.toContain('projectId');
  });
});