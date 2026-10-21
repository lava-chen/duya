import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PlanTool } from '../src/PlanTool/PlanTool.js';
import type { PlanStoragePort } from '../src/PlanTool/ports.js';

const storage = {
  planStatus: vi.fn<PlanStoragePort['planStatus']>(),
  planSearch: vi.fn<PlanStoragePort['planSearch']>(),
  planComplete: vi.fn<PlanStoragePort['planComplete']>(),
  getPlansDirectory: vi.fn((projectId: string) => `~/.duya/projects/${projectId}/plans`),
};

const tool = new PlanTool(storage);

function makeContext(currentProjectId?: string | null) {
  return {
    toolUseId: 'test',
    currentProjectId,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  storage.planStatus.mockReturnValue({ projectId: 'auto-filled', plans: [] });
  storage.planComplete.mockReturnValue({ ok: true, newFile: 'completed/1-test.md' });
  storage.planSearch.mockReturnValue({ results: [] });
});

describe('PlanTool project fallback and presentation', () => {
  it('uses explicit projectId before the current project', async () => {
    const result = await tool.execute(
      { action: 'status', projectId: 'explicit-id' },
      undefined,
      makeContext('context-id'),
    );
    expect(result.error).toBeFalsy();
    expect(storage.planStatus).toHaveBeenCalledWith({ projectId: 'explicit-id', status: undefined });
  });

  it('uses currentProjectId for status and complete when omitted', async () => {
    await tool.execute({ action: 'status' }, undefined, makeContext('context-id'));
    await tool.execute({ action: 'complete', planId: 7 }, undefined, makeContext('context-id'));

    expect(storage.planStatus).toHaveBeenCalledWith({ projectId: 'context-id', status: undefined });
    expect(storage.planComplete).toHaveBeenCalledWith({ projectId: 'context-id', planId: 7 });
  });

  it.each(['status', 'complete'] as const)('requires a project for %s', async (action) => {
    const result = await tool.execute(
      action === 'status' ? { action } : { action, planId: 1 },
      undefined,
      makeContext(null),
    );
    expect(result.error).toBe(true);
    expect(result.result).toContain('projectId');
    expect(storage.planStatus).not.toHaveBeenCalled();
    expect(storage.planComplete).not.toHaveBeenCalled();
  });

  it('allows projectless search and prints Host-provided directories', async () => {
    storage.planSearch.mockReturnValue({
      results: [{ projectId: 'p1', id: 4, slug: 'plan', title: 'Test plan', status: 'active', file: 'active/4-plan.md', snippet: 'Test plan' }],
    });
    const result = await tool.execute({ action: 'search', query: 'test' }, undefined, makeContext(null));
    expect(result.error).toBeFalsy();
    expect(storage.planSearch).toHaveBeenCalledWith({ query: 'test', scope: undefined, projectId: undefined });
    expect(result.result).toContain('~/.duya/projects/p1/plans');
  });

  it('preserves the wire schema requirements', () => {
    expect(tool.input_schema.required).toEqual(['action']);
    const schema = tool.input_schema as { allOf: Array<{ if: { properties: { action: { const: string } } }; then: { required?: string[] } }> };
    expect(schema.allOf.find((branch) => branch.if.properties.action.const === 'status')?.then.required ?? []).not.toContain('projectId');
    expect(schema.allOf.find((branch) => branch.if.properties.action.const === 'complete')?.then.required).toContain('planId');
  });
});
