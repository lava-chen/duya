/**
 * Real Tasks Integration Tests
 *
 * Tests realistic multi-turn tool calling scenarios using real filesystem operations.
 * Uses temporary directories to avoid polluting the project.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ToolRegistry } from '../../src/tool/registry.js';
import { ReadTool } from '../../src/tool/ReadTool/ReadTool.js';
import { WriteTool } from '../../src/tool/WriteTool/WriteTool.js';
import { EditTool } from '../../src/tool/EditTool/EditTool.js';
import { GrepTool } from '../../src/tool/GrepTool/GrepTool.js';
import { GlobTool } from '../../src/tool/GlobTool/GlobTool.js';
import { BashTool } from '../../src/tool/BashTool/BashTool.js';
import { StreamingToolExecutor } from '../../src/tool/StreamingToolExecutor.js';
import type { SSEEvent, ToolUse, ToolUseContext } from '../../src/types.js';
import { writeFile, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  cleanupEngineTurnDirs,
  driveTurn,
  installEngineTurnIpc,
  restoreEngineTurnIpc,
} from '../helpers/engineTurnHarness.js';

// Mock LLM client
const mockStreamChat = vi.fn();

vi.mock('@duya/ai', async (importOriginal) => {
  const mod = await importOriginal<typeof import('@duya/ai')>();
  return {
    ...mod,
    createAIClient: vi.fn(() => ({ streamChat: mockStreamChat })),
    createAIClientWithRetry: vi.fn(() => ({ streamChat: mockStreamChat })),
    inferProvider: vi.fn(() => 'anthropic'),
  };
});

import { duyaAgent } from '../../src/index.js';

describe('Real Tasks Integration', () => {
  let tempDir: string;
  let toolRegistry: ToolRegistry;
  let mockCanUseTool: (name: string) => Promise<boolean>;

  beforeEach(async () => {
    vi.clearAllMocks();
    // The engine driver reports through `process.send`; the harness installs
    // that seam for the duration of the turn.
    await installEngineTurnIpc();

    // Create a unique temp directory for each test (cross-platform)
    const testId = `duya-test-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    tempDir = join(tmpdir(), testId);
    await mkdir(tempDir, { recursive: true });

    // Create tool registry with real tools
    toolRegistry = new ToolRegistry();
    mockCanUseTool = vi.fn().mockResolvedValue(true);

    // Register real tools
    const readTool = new ReadTool();
    const writeTool = new WriteTool();
    const editTool = new EditTool();
    const grepTool = new GrepTool();
    const globTool = new GlobTool();
    const bashTool = new BashTool();

    toolRegistry.register(readTool as any, readTool as any);
    toolRegistry.register(writeTool as any, writeTool as any);
    toolRegistry.register(editTool as any, editTool as any);
    toolRegistry.register(grepTool as any, grepTool as any);
    toolRegistry.register(globTool as any, globTool as any);
    toolRegistry.register(bashTool as any, bashTool as any);
  });

  afterEach(async () => {
    restoreEngineTurnIpc();
    cleanupEngineTurnDirs();
    try {
      await rm(tempDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  /**
   * Simulates an LLM that responds with tools
   */
  const simulateLLM = (responses: {
    text?: string;
    tools?: Array<{ name: string; input: Record<string, unknown> }>;
    done?: boolean;
  }) => {
    mockStreamChat.mockImplementationOnce(async function* () {
      if (responses.text) {
        yield { type: 'text', data: responses.text };
      }
      if (responses.tools) {
        for (const tool of responses.tools) {
          yield {
            type: 'tool_use',
            data: {
              id: crypto.randomUUID(),
              name: tool.name,
              input: tool.input,
            } as ToolUse,
          };
        }
      }
      if (responses.done) {
        yield { type: 'done' };
      }
    });
  };

  /**
   * Drive one turn through the production engine and hand back the frames.
   *
   * `duyaAgent.streamChat` no longer exists -- the turn loop moved to
   * `driveRunWithEngine` -- so every case here that used to iterate
   * `agent.streamChat(prompt, { toolRegistry })` now drives the real engine
   * through the shared harness. The assertions below are left reading `.type`
   * and `.data.name`, so the `chat:`-prefixed labels the worker's codec emits
   * are normalised back to the projector vocabulary they were written against.
   * The frames themselves are the product's.
   */
  async function drainStream(
    agent: duyaAgent,
    prompt: string,
    options: Record<string, unknown>,
  ): Promise<SSEEvent[]> {
    const { frames } = await driveTurn(agent, prompt, { options: options as never });
    return frames.map((frame) => {
      const type = typeof frame['type'] === 'string' ? frame['type'] : '';
      const normalized = {
        ...frame,
        type: type.startsWith('chat:') ? type.slice('chat:'.length) : type,
      };
      // The codec FLATTENS the projector payload: `chat:tool_use` carries
      // `id` / `name` / `input` at the top level, where the SSEEvent these
      // assertions were written against nested them under `data`. That one
      // triple is re-nested here so the `data.name` reads below keep checking
      // what they always checked, rather than being restated in a second
      // vocabulary.
      if (typeof normalized['name'] === 'string') {
        return {
          ...normalized,
          data: { id: normalized['id'], name: normalized['name'], input: normalized['input'] },
        };
      }
      return normalized;
    }) as unknown as SSEEvent[];
  }

  describe('File System Operations', () => {
    it('should read a file and return content', async () => {
      // Create a test file
      const testFile = join(tempDir, 'hello.txt');
      await writeFile(testFile, 'Hello, World!');

      // Simulate LLM requesting to read the file
      simulateLLM({
        text: 'I will read the file for you.',
        tools: [{ name: 'read', input: { file_path: testFile } }],
        done: true,
      });

      const agent = new duyaAgent({
        apiKey: 'test-key',
        provider: 'anthropic',
        // `DuyaAgent` refuses to construct without a model ("no hardcoded
        // defaults"), and every construction site here predates that
        // guard, so all 13 cases died inside the constructor before
        // ever reaching the mocked `streamChat`. The LLM client is mocked
        // above, so this string is never used for a real request.
        model: 'test-model',
      });

      const events = await drainStream(agent, 'Read the file', { toolRegistry });

      // Should have received events
      const toolUseEvents = events.filter((e) => e.type === 'tool_use');
      expect(toolUseEvents.length).toBeGreaterThan(0);

      // Verify tool was called with correct path
      const toolUse = toolUseEvents[0] as SSEEvent & { type: 'tool_use' };
      expect(toolUse.data.name).toBe('read');
    });

    it('should write content to a new file', async () => {
      const newFile = join(tempDir, 'created.txt');
      const content = 'This file was created by the agent test.';

      simulateLLM({
        text: 'I will create the file.',
        tools: [{ name: 'write', input: { file_path: newFile, content } }],
        done: true,
      });

      const agent = new duyaAgent({
        apiKey: 'test-key',
        provider: 'anthropic',
        // `DuyaAgent` refuses to construct without a model ("no hardcoded
        // defaults"), and every construction site here predates that
        // guard, so all 13 cases died inside the constructor before
        // ever reaching the mocked `streamChat`. The LLM client is mocked
        // above, so this string is never used for a real request.
        model: 'test-model',
      });

      const events = await drainStream(agent, 'Create a file', { toolRegistry });

      const toolUseEvents = events.filter((e) => e.type === 'tool_use');
      expect(toolUseEvents.length).toBeGreaterThan(0);
    });

    it('should find files using glob pattern', async () => {
      // Create multiple test files
      await writeFile(join(tempDir, 'file1.ts'), 'const a = 1;');
      await writeFile(join(tempDir, 'file2.ts'), 'const b = 2;');
      await writeFile(join(tempDir, 'readme.md'), '# Readme');

      simulateLLM({
        text: 'Finding TypeScript files...',
        tools: [{ name: 'glob', input: { pattern: '*.ts' } }],
        done: true,
      });

      const agent = new duyaAgent({
        apiKey: 'test-key',
        provider: 'anthropic',
        // `DuyaAgent` refuses to construct without a model ("no hardcoded
        // defaults"), and every construction site here predates that
        // guard, so all 13 cases died inside the constructor before
        // ever reaching the mocked `streamChat`. The LLM client is mocked
        // above, so this string is never used for a real request.
        model: 'test-model',
      });

      const events = await drainStream(agent, 'Find all TypeScript files', { toolRegistry });

      const toolUseEvents = events.filter((e) => e.type === 'tool_use');
      expect(toolUseEvents.length).toBeGreaterThan(0);
    });

    it('should search file contents using grep', async () => {
      // Create test files with content
      await writeFile(join(tempDir, 'main.ts'), 'function hello() {\n  console.log("Hello");\n}');
      await writeFile(join(tempDir, 'other.ts'), 'const x = 1;');

      simulateLLM({
        text: 'Searching for console.log...',
        tools: [{ name: 'grep', input: { pattern: 'console.log', paths: [tempDir] } }],
        done: true,
      });

      const agent = new duyaAgent({
        apiKey: 'test-key',
        provider: 'anthropic',
        // `DuyaAgent` refuses to construct without a model ("no hardcoded
        // defaults"), and every construction site here predates that
        // guard, so all 13 cases died inside the constructor before
        // ever reaching the mocked `streamChat`. The LLM client is mocked
        // above, so this string is never used for a real request.
        model: 'test-model',
      });

      const events = await drainStream(agent, 'Find files with console.log', { toolRegistry });

      const toolUseEvents = events.filter((e) => e.type === 'tool_use');
      expect(toolUseEvents.length).toBeGreaterThan(0);
    });

    it('should create and verify file in one workflow', async () => {
      // Create test file
      const testFile = join(tempDir, 'verify-me.txt');
      await writeFile(testFile, 'Original content');

      // Simulate LLM reading then updating
      simulateLLM({
        text: 'I will read and update the file.',
        tools: [
          { name: 'read', input: { file_path: testFile } },
          { name: 'edit', input: { file_path: testFile, old_string: 'Original', new_string: 'Updated' } },
        ],
        done: true,
      });

      const agent = new duyaAgent({
        apiKey: 'test-key',
        provider: 'anthropic',
        // `DuyaAgent` refuses to construct without a model ("no hardcoded
        // defaults"), and every construction site here predates that
        // guard, so all 13 cases died inside the constructor before
        // ever reaching the mocked `streamChat`. The LLM client is mocked
        // above, so this string is never used for a real request.
        model: 'test-model',
      });

      const events = await drainStream(agent, 'Read and update the file', { toolRegistry });

      // Should have multiple tool calls
      const toolUseEvents = events.filter((e) => e.type === 'tool_use');
      expect(toolUseEvents.length).toBeGreaterThanOrEqual(2);

      // Verify tool names
      const toolNames = toolUseEvents.map((e) => (e as any).data.name);
      expect(toolNames).toContain('read');
      expect(toolNames).toContain('edit');
    });
  });

  describe('StreamingToolExecutor Real Scenarios', () => {
    it('should execute multiple tools in sequence', async () => {
      // Create test files
      await writeFile(join(tempDir, 'a.txt'), 'Content A');
      await writeFile(join(tempDir, 'b.txt'), 'Content B');

      const context: ToolUseContext = {
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

      const executor = new StreamingToolExecutor(toolRegistry, mockCanUseTool, context);

      // Add multiple read operations
      executor.addTool({ id: 'r1', name: 'read', input: { file_path: join(tempDir, 'a.txt') } });
      executor.addTool({ id: 'r2', name: 'read', input: { file_path: join(tempDir, 'b.txt') } });

      const results: string[] = [];
      for await (const update of executor.getRemainingResults()) {
        if (update.message) {
          if (update.message.role === 'tool') {
            results.push(String(update.message.content));
          }
        }
      }

      // Both reads should complete, each with its own file's content.
      // The executor yields results AS THEY COMPLETE
      // (`StreamingToolExecutor.getRemainingResults`), and these two reads run
      // concurrently, so completion order is not submission order. Reading
      // `results[0]` as a.txt asserted an ordering the executor never promised
      // and failed whenever b.txt's read happened to land first; the claim that
      // actually matters is that both reads completed and neither lost its
      // content, so that is what is asserted.
      expect(results.length).toBe(2);
      expect(results.some((result) => result.includes('Content A'))).toBe(true);
      expect(results.some((result) => result.includes('Content B'))).toBe(true);
    });

    it('should handle concurrent-safe tools', async () => {
      const context: ToolUseContext = {
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

      const executor = new StreamingToolExecutor(toolRegistry, mockCanUseTool, context);

      // Add glob (safe) operations
      executor.addTool({ id: 'g1', name: 'glob', input: { pattern: '*.txt' } });
      executor.addTool({ id: 'g2', name: 'glob', input: { pattern: '*.md' } });

      const results: string[] = [];
      for await (const update of executor.getRemainingResults()) {
        if (update.message) {
          if (update.message.role === 'tool') {
            results.push(String(update.message.content));
          }
        }
      }

      // Both globs should complete
      expect(results.length).toBe(2);
    });

    it('should track tool execution state', async () => {
      const context: ToolUseContext = {
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

      const executor = new StreamingToolExecutor(toolRegistry, mockCanUseTool, context);

      // Add a tool
      executor.addTool({ id: 'test', name: 'glob', input: { pattern: '*' } });

      // Check state immediately
      const tools = executor.getTools();
      expect(tools).toHaveLength(1);
      expect(tools[0].id).toBe('test');
      expect(['queued', 'starting', 'executing', 'completed']).toContain(tools[0].status);
    });
  });

  describe('Error Recovery', () => {
    it('should handle file not found gracefully', async () => {
      const context: ToolUseContext = {
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

      const executor = new StreamingToolExecutor(toolRegistry, mockCanUseTool, context);

      // Try to read a non-existent file
      executor.addTool({ id: 'missing', name: 'read', input: { file_path: join(tempDir, 'nonexistent-12345.txt') } });

      const results: string[] = [];
      for await (const update of executor.getRemainingResults()) {
        if (update.message) {
          if (update.message.role === 'tool') {
            results.push(String(update.message.content));
          }
        }
      }

      // Should have a result (error message)
      expect(results.length).toBe(1);
      // Result should indicate an error
      expect(results[0].toLowerCase()).toMatch(/error|not found|enoent/i);
    });

    it('should handle invalid input gracefully', async () => {
      const context: ToolUseContext = {
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

      const executor = new StreamingToolExecutor(toolRegistry, mockCanUseTool, context);

      // Try with empty file_path (invalid input)
      executor.addTool({ id: 'invalid', name: 'read', input: { file_path: '' } });

      const results: string[] = [];
      for await (const update of executor.getRemainingResults()) {
        if (update.message) {
          if (update.message.role === 'tool') {
            results.push(String(update.message.content));
          }
        }
      }

      // Should have a result (validation error)
      expect(results.length).toBe(1);
      expect(results[0].toLowerCase()).toMatch(/error|empty|validation/i);
    });
  });

  describe('Agent Session Management', () => {
    it('should have initial empty message state', async () => {
      const agent = new duyaAgent({
        apiKey: 'test-key',
        provider: 'anthropic',
        // `DuyaAgent` refuses to construct without a model ("no hardcoded
        // defaults"), and every construction site here predates that
        // guard, so all 13 cases died inside the constructor before
        // ever reaching the mocked `streamChat`. The LLM client is mocked
        // above, so this string is never used for a real request.
        model: 'test-model',
      });

      // Initially should have no messages
      expect(agent.getMessages().length).toBe(0);
    });

    it('should provide session info', async () => {
      const agent = new duyaAgent({
        apiKey: 'test-key',
        provider: 'anthropic',
        // `DuyaAgent` refuses to construct without a model ("no hardcoded
        // defaults"), and every construction site here predates that
        // guard, so all 13 cases died inside the constructor before
        // ever reaching the mocked `streamChat`. The LLM client is mocked
        // above, so this string is never used for a real request.
        model: 'test-model',
      });

      const info = agent.getSessionInfo();
      expect(info).toHaveProperty('id');
      expect(info).toHaveProperty('createdAt');
      expect(info).toHaveProperty('updatedAt');
      expect(info).toHaveProperty('messageCount');
    });

    it('should clear messages', async () => {
      const agent = new duyaAgent({
        apiKey: 'test-key',
        provider: 'anthropic',
        // `DuyaAgent` refuses to construct without a model ("no hardcoded
        // defaults"), and every construction site here predates that
        // guard, so all 13 cases died inside the constructor before
        // ever reaching the mocked `streamChat`. The LLM client is mocked
        // above, so this string is never used for a real request.
        model: 'test-model',
      });

      agent.clearMessages();
      expect(agent.getMessages().length).toBe(0);
    });
  });
});
