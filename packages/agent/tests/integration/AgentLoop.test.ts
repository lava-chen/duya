/**
 * Agent 工具循环端到端测试
 *
 * 验证 Agent 自己调用工具的完整流程
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { SSEEvent } from '../../src/types.js';

describe('Agent 工具循环端到端测试', () => {
  let tempDir: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    const testId = `agent-loop-${Date.now()}`;
    tempDir = join(tmpdir(), testId);
    await mkdir(tempDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  /**
   * 这个测试展示 Agent 的完整工具循环：
   * 1. Agent 收到用户请求
   * 2. 调用 LLM (第1轮) - LLM 返回 tool_use
   * 3. Agent 执行工具
   * 4. 再次调用 LLM (第2轮) - LLM 看到结果，决定完成
   */
  it('Agent 工具循环: write → done', async () => {
    console.log('\n' + '='.repeat(60));
    console.log('🧪 Agent 工具循环测试 - 完整流程');
    console.log('='.repeat(60));

    // 模拟 LLM 决定调用 write 工具
    let llmCallCount = 0;
    const mockStreamChat = vi.fn().mockImplementation(async function* () {
      llmCallCount++;
      console.log(`\n  📡 LLM 调用 #${llmCallCount}`);

      if (llmCallCount === 1) {
        // 第一轮：LLM 决定调用 write
        yield { type: 'text', data: '我将创建文件' };
        yield {
          type: 'tool_use',
          data: {
            id: 'tool-1',
            name: 'write',
            input: { file_path: 'test.txt', content: 'Hello from Agent!' },
          },
        };
        yield { type: 'done' };
      } else {
        // 第二轮：LLM 看到工具结果，决定完成
        yield { type: 'text', data: '文件已创建完成！' };
        yield { type: 'done' };
      }
    });

    vi.doMock('../../src/llm/index.js', () => ({
      createLLMClient: vi.fn(() => ({
        streamChat: mockStreamChat,
      })),
      inferProvider: vi.fn(() => 'anthropic'),
    }));

    // 动态 import 以获取新的 agent 实例
    const { duyaAgent } = await import('../../src/index.js');
    const { ToolRegistry } = await import('../../src/tool/registry.js');
    const { WriteTool } = await import('../../src/tool/WriteTool/WriteTool.js');

    const registry = new ToolRegistry();
    registry.register(new WriteTool() as any, new WriteTool() as any);

    const agent = new duyaAgent({
      apiKey: 'test-key',
      provider: 'anthropic',
      workingDirectory: tempDir,
    });

    console.log('\n👤 用户: "帮我创建一个 test.txt 文件"\n');

    const events: SSEEvent[] = [];
    const toolCalls: string[] = [];
    let turnCount = 0;

    console.log('📥 开始 streamChat...\n');

    for await (const event of agent.streamChat('创建一个 test.txt 文件', { toolRegistry: registry })) {
      events.push(event);

      if (event.type === 'turn_start') {
        turnCount++;
        console.log(`\n  ── Turn ${turnCount} ──`);
      }
      if (event.type === 'text') {
        console.log(`  💬 LLM: "${event.data.slice(0, 50)}..."`);
      }
      if (event.type === 'tool_use') {
        toolCalls.push(event.data.name);
        console.log(`  🔧 工具: ${event.data.name}`);
        console.log(`     参数: file_path="${(event.data.input as any).file_path}"`);
      }
      if (event.type === 'tool_result') {
        console.log(`  ✅ 结果: 已返回`);
      }
      if (event.type === 'done') {
        console.log(`  🏁 完成: ${event.reason || 'completed'}`);
      }
    }

    console.log('\n' + '='.repeat(60));
    console.log('📊 验证结果:');
    console.log(`   ✓ LLM 被调用 ${llmCallCount} 次`);
    console.log(`   ✓ 工具被调用 ${toolCalls.length} 次: ${toolCalls.join(' → ')}`);
    console.log(`   ✓ 总事件数: ${events.length}`);
    console.log('='.repeat(60) + '\n');

    // 核心验证
    expect(llmCallCount).toBe(2);  // LLM 被调用 2 次
    expect(toolCalls).toContain('write');
    expect(toolCalls.length).toBe(1);
    expect(turnCount).toBe(2);  // 2 轮对话
  });

  /**
   * 展示 Agent 多轮循环的能力
   */
  it('Agent 多轮循环: write → read → done', async () => {
    console.log('\n' + '='.repeat(60));
    console.log('🧪 Agent 多轮工具循环 - write + read');
    console.log('='.repeat(60));

    let llmCallCount = 0;
    const mockStreamChat = vi.fn().mockImplementation(async function* () {
      llmCallCount++;
      console.log(`\n  📡 LLM 调用 #${llmCallCount}`);

      if (llmCallCount === 1) {
        yield { type: 'text', data: '创建文件' };
        yield { type: 'tool_use', data: { id: 't1', name: 'write', input: { file_path: 'config.json', content: '{"debug": true}' } } };
        yield { type: 'done' };
      } else if (llmCallCount === 2) {
        yield { type: 'text', data: '验证文件内容' };
        yield { type: 'tool_use', data: { id: 't2', name: 'read', input: { file_path: 'config.json' } } };
        yield { type: 'done' };
      } else {
        yield { type: 'text', data: '完成！' };
        yield { type: 'done' };
      }
    });

    vi.doMock('../../src/llm/index.js', () => ({
      createLLMClient: vi.fn(() => ({
        streamChat: mockStreamChat,
      })),
      inferProvider: vi.fn(() => 'anthropic'),
    }));

    const { duyaAgent } = await import('../../src/index.js');
    const { ToolRegistry } = await import('../../src/tool/registry.js');
    const { WriteTool } = await import('../../src/tool/WriteTool/WriteTool.js');
    const { ReadTool } = await import('../../src/tool/ReadTool/ReadTool.js');

    const registry = new ToolRegistry();
    registry.register(new WriteTool() as any, new WriteTool() as any);
    registry.register(new ReadTool() as any, new ReadTool() as any);

    const agent = new duyaAgent({
      apiKey: 'test-key',
      provider: 'anthropic',
      workingDirectory: tempDir,
    });

    const toolCalls: string[] = [];

    console.log('\n👤 用户: "创建 config.json 然后验证"\n');

    for await (const event of agent.streamChat('创建并验证', { toolRegistry: registry })) {
      if (event.type === 'tool_use') {
        toolCalls.push(event.data.name);
        console.log(`  🔧 ${event.data.name}`);
      }
      if (event.type === 'done') {
        console.log(`  🏁`);
      }
    }

    console.log('\n' + '='.repeat(60));
    console.log('📊 流程:');
    console.log(`   LLM 调用 #1 → tool_use(write)`);
    console.log(`   LLM 调用 #2 → tool_use(read)  ← 看到了 write 的结果`);
    console.log(`   LLM 调用 #3 → 完成`);
    console.log('\n📋 工具调用: ' + toolCalls.join(' → '));
    console.log('='.repeat(60) + '\n');

    expect(llmCallCount).toBe(3);
    expect(toolCalls[0]).toBe('write');
    expect(toolCalls[1]).toBe('read');
  });
});
