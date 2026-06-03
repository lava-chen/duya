import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ToolRegistry } from '../../src/tool/registry.js';
import type { Tool, ToolResult, ToolExecutor } from '../../src/types.js';

describe('ToolRegistry', () => {
  let registry: ToolRegistry;

  beforeEach(() => {
    registry = new ToolRegistry();
  });

  describe('register', () => {
    it('should register a tool with executor', () => {
      const tool: Tool = {
        name: 'test',
        description: 'A test tool',
        input_schema: { type: 'object' },
      };

      const executor: ToolExecutor = {
        execute: async () => ({ id: '1', name: 'test', result: 'ok' }),
      };

      registry.register(tool, executor);

      expect(registry.has('test')).toBe(true);
      expect(registry.getTool('test')).toEqual(tool);
    });

    it('should overwrite existing tool with same name', () => {
      const tool1: Tool = { name: 'test', description: 'Tool 1', input_schema: {} };
      const tool2: Tool = { name: 'test', description: 'Tool 2', input_schema: {} };

      registry.register(tool1, { execute: async () => ({ id: '1', name: 'test', result: '1' }) });
      registry.register(tool2, { execute: async () => ({ id: '2', name: 'test', result: '2' }) });

      expect(registry.getTool('test')).toEqual(tool2);
    });
  });

  describe('registerAll', () => {
    it('should register multiple tools', () => {
      const tools = [
        {
          definition: { name: 'tool1', description: 'Tool 1', input_schema: {} },
          executor: { execute: async () => ({ id: '1', name: 'tool1', result: '1' }) },
        },
        {
          definition: { name: 'tool2', description: 'Tool 2', input_schema: {} },
          executor: { execute: async () => ({ id: '2', name: 'tool2', result: '2' }) },
        },
      ];

      registry.registerAll(tools);

      expect(registry.size).toBe(2);
      expect(registry.has('tool1')).toBe(true);
      expect(registry.has('tool2')).toBe(true);
    });
  });

  describe('execute', () => {
    it('should execute a registered tool', async () => {
      const executor: ToolExecutor = {
        execute: async (input) => ({ id: '1', name: 'test', result: `Got: ${input.value}` }),
      };

      registry.register(
        { name: 'test', description: 'Test', input_schema: {} },
        executor
      );

      const result = await registry.execute('test', { value: 'hello' });

      expect(result).not.toBeNull();
      expect(result!.result).toBe('Got: hello');
    });

    it('should return null for non-existent tool', async () => {
      const result = await registry.execute('nonExistent', {});
      expect(result).toBeNull();
    });

    it('should catch and return errors from executor', async () => {
      const executor: ToolExecutor = {
        execute: async () => {
          throw new Error('Executor failed');
        },
      };

      registry.register(
        { name: 'failing', description: 'Failing', input_schema: {} },
        executor
      );

      const result = await registry.execute('failing', {});

      expect(result).not.toBeNull();
      expect(result!.error).toBe(true);
      expect(result!.result).toContain('Executor failed');
    });
  });

  describe('getAllTools', () => {
    it('should return all registered tool definitions', () => {
      const tools = [
        { name: 'a', description: 'A', input_schema: {} },
        { name: 'b', description: 'B', input_schema: {} },
        { name: 'c', description: 'C', input_schema: {} },
      ];

      for (const tool of tools) {
        registry.register(tool, { execute: async () => ({ id: '1', name: tool.name, result: '' }) });
      }

      const allTools = registry.getAllTools();
      expect(allTools).toHaveLength(3);
      expect(allTools.map((t) => t.name)).toEqual(['a', 'b', 'c']);
    });
  });
});
