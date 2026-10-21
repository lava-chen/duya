import { describe, expect, it } from 'vitest';
import { MCPManager } from '@duya/capabilities/MCP/MCPManager';
import type { MCPExecutorPorts } from '@duya/agent-runtime/tools/mcp-executor';
import {
  createWorkerMCPApplyRuntime,
  type WorkerMCPApplyTarget,
} from '../../src/connector-services/worker-session-binding.js';

describe('worker MCP apply binding', () => {
  it('constructs the Host manager and forwards session-owned state ports', () => {
    const activeManager = new MCPManager();
    const target: WorkerMCPApplyTarget<object> = {
      getActiveMCPManager: () => activeManager,
      getNonMCPModelVisibleToolNames: () => new Set(['Read', 'bash']),
      async setActiveMCPRuntime() {
        return { removedKeys: [], addedKeys: [], keptKeys: [] };
      },
    };
    const executorPorts: MCPExecutorPorts<object> = {
      getToolUseId: () => undefined,
      getPermissionMode: () => undefined,
      getAppState: () => undefined,
    };

    const runtime = createWorkerMCPApplyRuntime(target, executorPorts);

    expect(runtime.createManager()).toBeInstanceOf(MCPManager);
    expect(runtime.getActiveMCPManager()).toBe(activeManager);
    expect(runtime.getNonMCPModelVisibleToolNames()).toEqual(new Set(['Read', 'bash']));
    expect(runtime.createMCPToolExecutor).toBeTypeOf('function');
  });
});
