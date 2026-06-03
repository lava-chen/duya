import { describe, it, expect, vi, beforeEach } from 'vitest';
import { StreamingToolExecutor } from '../../src/tool/StreamingToolExecutor.js';
import { ToolRegistry } from '../../src/tool/registry.js';
import type { ToolUseContext, ToolUse, SSEEvent } from '../../src/types.js';

describe('StreamingToolExecutor', () => {
  let registry: ToolRegistry;
  let mockCanUseTool: (name: string) => Promise<boolean>;
  let toolUseContext: ToolUseContext;

  const createToolUseContext = (): ToolUseContext => ({
    toolUseId: 'ctx-1',
    abortController: new AbortController(),
    getAppState: () => ({}),
    setAppState: () => {},
    options: {
      tools: [],
      commands: [],
      mainLoopModel: 'test-model',
      mcpClients: [],
    },
  });

  beforeEach(() => {
    registry = new ToolRegistry();
    mockCanUseTool = vi.fn().mockResolvedValue(true);
    toolUseContext = createToolUseContext();
  });

  describe('addTool', () => {
    it('should queue tool for execution', () => {
      const toolUse: ToolUse = {
        id: 'use-1',
        name: 'echo',
        input: { value: 'test' },
      };

      // Register echo tool
      registry.register(
        { name: 'echo', description: 'Echo input', input_schema: { type: 'object' } },
        {
          execute: async (input) => ({
            id: crypto.randomUUID(),
            name: 'echo',
            result: JSON.stringify(input),
          }),
        }
      );

      const executor = new StreamingToolExecutor(registry, mockCanUseTool, toolUseContext);
      executor.addTool(toolUse);

      const tools = executor.getTools();
      expect(tools).toHaveLength(1);
      expect(tools[0].id).toBe('use-1');
    });

    it('should create error result for non-existent tool', () => {
      const toolUse: ToolUse = {
        id: 'use-2',
        name: 'nonExistent',
        input: {},
      };

      const executor = new StreamingToolExecutor(registry, mockCanUseTool, toolUseContext);
      executor.addTool(toolUse);

      const tools = executor.getTools();
      expect(tools).toHaveLength(1);
      expect(tools[0].status).toBe('completed');
    });

    it('should handle tool execution error', () => {
      // Register a tool that throws
      registry.register(
        { name: 'failing', description: 'Failing tool', input_schema: {} },
        {
          execute: async () => {
            throw new Error('Tool execution failed');
          },
        }
      );

      const executor = new StreamingToolExecutor(registry, mockCanUseTool, toolUseContext);
      const toolUse: ToolUse = { id: 'use-3', name: 'failing', input: {} };
      executor.addTool(toolUse);

      const tools = executor.getTools();
      expect(tools).toHaveLength(1);
    });
  });

  describe('getRemainingResults', () => {
    it('should yield tool results in order', async () => {
      // Register a simple echo tool
      registry.register(
        { name: 'echo', description: 'Echo', input_schema: {} },
        {
          execute: async (input) => ({
            id: crypto.randomUUID(),
            name: 'echo',
            result: `Got: ${JSON.stringify(input)}`,
          }),
        }
      );

      const executor = new StreamingToolExecutor(registry, mockCanUseTool, toolUseContext);
      executor.addTool({ id: 'use-1', name: 'echo', input: { value: 'hello' } });

      const results: string[] = [];
      for await (const update of executor.getRemainingResults()) {
        if (update.message) {
          const content = update.message.content;
          if (Array.isArray(content) && content[0]) {
            if (content[0].type === 'tool_result') {
              results.push(String(content[0].content));
            }
          }
        }
      }

      expect(results.length).toBeGreaterThan(0);
      expect(results[0]).toContain('hello');
    });

    it('should handle multiple concurrent-safe tools', async () => {
      // Register concurrent-safe tools (read is in the safe list)
      registry.register(
        { name: 'read', description: 'Read', input_schema: {} },
        {
          execute: async () => ({
            id: crypto.randomUUID(),
            name: 'read',
            result: 'file content',
          }),
        }
      );

      const executor = new StreamingToolExecutor(registry, mockCanUseTool, toolUseContext);
      executor.addTool({ id: 'r1', name: 'read', input: {} });
      executor.addTool({ id: 'r2', name: 'read', input: {} });

      const results: string[] = [];
      for await (const update of executor.getRemainingResults()) {
        if (update.message) {
          const content = update.message.content;
          if (Array.isArray(content) && content[0]?.type === 'tool_result') {
            results.push(String(content[0].content));
          }
        }
      }

      expect(results.length).toBe(2);
    });

    it('should handle permission denied', async () => {
      registry.register(
        { name: 'restricted', description: 'Restricted', input_schema: {} },
        {
          execute: async () => ({
            id: crypto.randomUUID(),
            name: 'restricted',
            result: 'secret',
          }),
        }
      );

      const denyCanUseTool = vi.fn().mockResolvedValue(false);
      const executor = new StreamingToolExecutor(registry, denyCanUseTool, toolUseContext);
      executor.addTool({ id: 'use-1', name: 'restricted', input: {} });

      const results: string[] = [];
      for await (const update of executor.getRemainingResults()) {
        if (update.message) {
          const content = update.message.content;
          if (Array.isArray(content) && content[0]?.type === 'tool_result') {
            results.push(String(content[0].content));
          }
        }
      }

      expect(results.length).toBe(1);
      expect(results[0]).toContain('Permission denied');
    });
  });

  describe('discard', () => {
    it('should discard pending tools', async () => {
      registry.register(
        { name: 'slow', description: 'Slow tool', input_schema: {} },
        {
          execute: async () => {
            await new Promise(r => setTimeout(r, 1000));
            return { id: crypto.randomUUID(), name: 'slow', result: 'done' };
          },
        }
      );

      const executor = new StreamingToolExecutor(registry, mockCanUseTool, toolUseContext);
      executor.addTool({ id: 'use-1', name: 'slow', input: {} });

      // Discard before completion
      executor.discard();

      const tools = executor.getTools();
      const results = [...executor.getCompletedResults()];

      // Should have no completed results after discard
      expect(results.length).toBe(0);
    });
  });

  describe('concurrency control', () => {
    it('should process concurrent-safe tools', async () => {
      registry.register(
        { name: 'read', description: 'Read file', input_schema: {} },
        {
          execute: async () => ({
            id: crypto.randomUUID(),
            name: 'read',
            result: 'content',
          }),
        }
      );

      const executor = new StreamingToolExecutor(registry, mockCanUseTool, toolUseContext);
      executor.addTool({ id: 't1', name: 'read', input: {} });
      executor.addTool({ id: 't2', name: 'read', input: {} });

      const results: string[] = [];
      for await (const update of executor.getRemainingResults()) {
        if (update.message) {
          const content = update.message.content;
          if (Array.isArray(content) && content[0]?.type === 'tool_result') {
            results.push(String(content[0].content));
          }
        }
      }

      // Both tools should complete
      expect(results.length).toBe(2);
    });

    it('should block non-concurrent tools until safe', async () => {
      // 'bash' is not in the concurrent-safe list
      registry.register(
        { name: 'bash', description: 'Bash', input_schema: {} },
        {
          execute: async () => ({
            id: crypto.randomUUID(),
            name: 'bash',
            result: 'bash done',
          }),
        }
      );

      registry.register(
        { name: 'read', description: 'Read', input_schema: {} },
        {
          execute: async () => ({
            id: crypto.randomUUID(),
            name: 'read',
            result: 'read done',
          }),
        }
      );

      const executor = new StreamingToolExecutor(registry, mockCanUseTool, toolUseContext);

      // Add read first (concurrent-safe), then bash (non-concurrent)
      executor.addTool({ id: 'r1', name: 'read', input: {} });
      executor.addTool({ id: 'b1', name: 'bash', input: {} });

      const results: string[] = [];
      for await (const update of executor.getRemainingResults()) {
        if (update.message) {
          const content = update.message.content;
          if (Array.isArray(content) && content[0]?.type === 'tool_result') {
            results.push(String(content[0].content));
          }
        }
      }

      // Both should complete, bash after read
      expect(results.length).toBe(2);
    });
  });

  describe('abort handling', () => {
    it('should report discarded state', async () => {
      registry.register(
        { name: 'slow', description: 'Slow tool', input_schema: {} },
        {
          execute: async () => {
            await new Promise(r => setTimeout(r, 100));
            return { id: crypto.randomUUID(), name: 'slow', result: 'done' };
          },
        }
      );

      const executor = new StreamingToolExecutor(registry, mockCanUseTool, toolUseContext);
      executor.addTool({ id: 'use-1', name: 'slow', input: {} });

      // Discard before completion
      executor.discard();

      const tools = executor.getTools();
      expect(tools[0].status).toBeDefined();
    });
  });
});

describe('Tool use loop simulation', () => {
  /**
   * Simulates a multi-turn tool loop where:
   * 1. First LLM response returns a tool_use
   * 2. Tool executes and returns result
   * 3. Second LLM response returns text (no more tools)
   */
  it('should complete tool loop with one tool call', async () => {
    const registry = new ToolRegistry();
    const mockCanUseTool = vi.fn().mockResolvedValue(true);

    // Register a tool that will be called
    registry.register(
      { name: 'read', description: 'Read file', input_schema: {} },
      {
        execute: async (input) => ({
          id: crypto.randomUUID(),
          name: 'read',
          result: 'file content here',
        }),
      }
    );

    // Simulate the agent loop:
    // 1. LLM returns tool_use
    const toolUseId = crypto.randomUUID();
    const toolUseEvents: SSEEvent[] = [
      {
        type: 'tool_use',
        data: { id: toolUseId, name: 'read', input: { file_path: '/test.txt' } },
      },
    ];

    // 2. Execute tool
    const toolUseContext: ToolUseContext = {
      toolUseId: 'ctx-1',
      abortController: new AbortController(),
      getAppState: () => ({}),
      setAppState: () => {},
      options: {
        tools: [],
        commands: [],
        mainLoopModel: 'test',
        mcpClients: [],
      },
    };

    const executor = new StreamingToolExecutor(registry, mockCanUseTool, toolUseContext);

    for (const event of toolUseEvents) {
      if (event.type === 'tool_use') {
        executor.addTool(event.data);
      }
    }

    // 3. Collect results
    const toolResults: string[] = [];
    for await (const update of executor.getRemainingResults()) {
      if (update.message) {
        const content = update.message.content;
        if (Array.isArray(content) && content[0]?.type === 'tool_result') {
          toolResults.push(String(content[0].content));
        }
      }
    }

    // Verify tool was executed
    expect(toolResults.length).toBe(1);
    expect(toolResults[0]).toContain('file content');
  });

  /**
   * Simulates a loop with multiple sequential tool calls
   */
  it('should handle multiple sequential tool calls', async () => {
    const registry = new ToolRegistry();
    const mockCanUseTool = vi.fn().mockResolvedValue(true);

    let callCount = 0;
    registry.register(
      { name: 'counter', description: 'Count calls', input_schema: {} },
      {
        execute: async () => {
          callCount++;
          return { id: crypto.randomUUID(), name: 'counter', result: `call ${callCount}` };
        },
      }
    );

    const toolUseContext: ToolUseContext = {
      toolUseId: 'ctx-1',
      abortController: new AbortController(),
      getAppState: () => ({}),
      setAppState: () => {},
      options: { tools: [], commands: [], mainLoopModel: 'test', mcpClients: [] },
    };

    const executor = new StreamingToolExecutor(registry, mockCanUseTool, toolUseContext);

    // Simulate LLM requesting multiple tools
    executor.addTool({ id: 'use-1', name: 'counter', input: {} });
    executor.addTool({ id: 'use-2', name: 'counter', input: {} });
    executor.addTool({ id: 'use-3', name: 'counter', input: {} });

    const results: string[] = [];
    for await (const update of executor.getRemainingResults()) {
      if (update.message) {
        const content = update.message.content;
        if (Array.isArray(content) && content[0]?.type === 'tool_result') {
          results.push(String(content[0].content));
        }
      }
    }

    expect(results.length).toBe(3);
    expect(results).toEqual(['call 1', 'call 2', 'call 3']);
  });

  /**
   * Simulates a loop that encounters a bash error and cancels sibling tools
   */
  it('should cancel sibling tools when bash errors', async () => {
    const registry = new ToolRegistry();
    const mockCanUseTool = vi.fn().mockResolvedValue(true);

    // Register bash (non-concurrent-safe) and a concurrent-safe tool
    registry.register(
      { name: 'bash', description: 'Bash command', input_schema: {} },
      {
        execute: async () => {
          throw new Error('bash failed');
        },
      }
    );

    registry.register(
      { name: 'read', description: 'Read', input_schema: {} },
      {
        execute: async () => {
          return { id: crypto.randomUUID(), name: 'read', result: 'file content' };
        },
      }
    );

    const toolUseContext: ToolUseContext = {
      toolUseId: 'ctx-1',
      abortController: new AbortController(),
      getAppState: () => ({}),
      setAppState: () => {},
      options: { tools: [], commands: [], mainLoopModel: 'test', mcpClients: [] },
    };

    const executor = new StreamingToolExecutor(registry, mockCanUseTool, toolUseContext);

    // Bash errors cancel siblings per the implementation
    executor.addTool({ id: 'use-1', name: 'bash', input: { command: 'ls' } });
    executor.addTool({ id: 'use-2', name: 'read', input: {} });

    const results: string[] = [];
    for await (const update of executor.getRemainingResults()) {
      if (update.message) {
        const content = update.message.content;
        if (Array.isArray(content) && content[0]?.type === 'tool_result') {
          results.push(String(content[0].content));
        }
      }
    }

    // Should have error for bash and error/cancelled for the read
    expect(results.some(r => r.includes('error') || r.includes('Error'))).toBe(true);
  });
});
