/**
 * read-roots.test.ts — the Coordinator's read scope reaches the tool.
 *
 * The scope is resolved per call from the Host's own binding, so the test
 * pins three things: a Coordinator session reads inside the bound project
 * root, another session keeps the unrestricted behaviour, and a Host that
 * cannot answer trusts no root at all.
 */

import { describe, expect, it, vi } from 'vitest';

const bindingRoot = vi.hoisted(() => vi.fn());

vi.mock('../../src/worker-db-client.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/worker-db-client.js')>();
  return {
    ...actual,
    projectDb: { ...actual.projectDb, bindingRoot },
  };
});

const [{ ToolRegistry }, { PROJECT_COORDINATOR_PROFILE_ID }] = await Promise.all([
  import('../../src/worker-tool-registry.js'),
  import('../../src/project/identity.js'),
]);

import { BaseTool } from '@duya/capabilities';
import type { ToolUseContext } from '../../src/worker-run-contracts.js';

class CapturingReadTool extends BaseTool {
  readonly name = 'read';
  readonly description = 'Capture the context the registry passes down.';
  readonly input_schema = { type: 'object', properties: {}, required: [] };
  seen: ToolUseContext | undefined;

  async execute(_input: Record<string, unknown>, _workingDirectory?: string, context?: ToolUseContext) {
    this.seen = context;
    return { id: 'read-1', name: this.name, result: 'captured' };
  }
}

function coordinatorContext(): ToolUseContext {
  return {
    toolUseId: 'coordinator-turn',
    getAppState: () => ({}),
    setAppState: () => {},
    abortController: new AbortController(),
    options: {
      tools: [],
      commands: [],
      mainLoopModel: 'test-model',
      mcpClients: [],
      sessionId: 'coordinator-session',
      agentProfileId: PROJECT_COORDINATOR_PROFILE_ID,
    },
  };
}

describe('coordinator read roots', () => {
  it('binds the bound project root to a Coordinator read', async () => {
    bindingRoot.mockResolvedValue({ canonicalRoot: '/workspace/project' });
    const registry = new ToolRegistry();
    const tool = new CapturingReadTool();
    registry.register(tool.toTool(), tool, { exposure: 'eager' });

    await registry.execute('read', {}, '/workspace/project', coordinatorContext());

    expect(tool.seen?.options.allowedRoots).toEqual(['/workspace/project']);
  });

  it('trusts no root when the Host has no Coordinator binding', async () => {
    bindingRoot.mockResolvedValue({ canonicalRoot: null });
    const registry = new ToolRegistry();
    const tool = new CapturingReadTool();
    registry.register(tool.toTool(), tool, { exposure: 'eager' });

    await registry.execute('read', {}, '/workspace/project', coordinatorContext());

    expect(tool.seen?.options.allowedRoots).toEqual([]);
  });

  it('trusts no root when the Host cannot answer', async () => {
    bindingRoot.mockRejectedValue(new Error('bridge unavailable'));
    const registry = new ToolRegistry();
    const tool = new CapturingReadTool();
    registry.register(tool.toTool(), tool, { exposure: 'eager' });

    await registry.execute('read', {}, '/workspace/project', coordinatorContext());

    expect(tool.seen?.options.allowedRoots).toEqual([]);
  });

  it('leaves another session unrestricted', async () => {
    bindingRoot.mockResolvedValue({ canonicalRoot: '/workspace/project' });
    const registry = new ToolRegistry();
    const tool = new CapturingReadTool();
    registry.register(tool.toTool(), tool, { exposure: 'eager' });
    const context = coordinatorContext();
    context.options.agentProfileId = 'code-expert';

    await registry.execute('read', {}, '/workspace/project', context);

    expect(tool.seen?.options.allowedRoots).toBeUndefined();
    expect(bindingRoot).not.toHaveBeenCalled();
  });

  it('leaves a tool that cannot read the workspace alone', async () => {
    bindingRoot.mockResolvedValue({ canonicalRoot: '/workspace/project' });
    const registry = new ToolRegistry();
    const tool = new CapturingReadTool();
    registry.register(tool.toTool(), tool, { exposure: 'eager' });

    await registry.execute('project', {}, '/workspace/project', coordinatorContext());

    expect(tool.seen?.options.allowedRoots).toBeUndefined();
    expect(bindingRoot).not.toHaveBeenCalled();
  });
});
