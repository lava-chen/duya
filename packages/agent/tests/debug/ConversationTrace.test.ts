/**
 * 真实任务场景对话记录
 *
 * 展示真实 coding 场景中的多轮工具调用
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { writeFile, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { SSEEvent, ToolUse, ToolUseContext } from '../../src/types.js';
import { ToolRegistry } from '../../src/tool/registry.js';
import { StreamingToolExecutor } from '../../src/tool/StreamingToolExecutor.js';
import { ReadTool } from '../../src/tool/ReadTool/ReadTool.js';
import { WriteTool } from '../../src/tool/WriteTool/WriteTool.js';
import { EditTool } from '../../src/tool/EditTool/EditTool.js';
import { GrepTool } from '../../src/tool/GrepTool/GrepTool.js';
import { GlobTool } from '../../src/tool/GlobTool/GlobTool.js';

/**
 * 打印工具执行流程
 */
function printToolExecution(
  executor: StreamingToolExecutor,
  context: ToolUseContext
) {
  const tools = executor.getTools();
  console.log('\n  📋 工具队列状态:');
  for (const tool of tools) {
    const input = tool.block.input as Record<string, unknown>;
    const inputStr = Object.entries(input)
      .map(([k, v]) => `${k}=${String(v).slice(0, 30)}`)
      .join(', ');
    console.log(`     [${tool.status.toUpperCase()}] ${tool.block.name}(${inputStr})`);
  }
}

describe('真实任务场景对话记录', () => {
  let tempDir: string;
  let registry: ToolRegistry;

  beforeEach(async () => {
    vi.clearAllMocks();
    const testId = `trace-${Date.now()}`;
    tempDir = join(tmpdir(), testId);
    await mkdir(tempDir, { recursive: true });

    registry = new ToolRegistry();
    registry.register(new ReadTool() as any, new ReadTool() as any);
    registry.register(new WriteTool() as any, new WriteTool() as any);
    registry.register(new EditTool() as any, new EditTool() as any);
    registry.register(new GrepTool() as any, new GrepTool() as any);
    registry.register(new GlobTool() as any, new GlobTool() as any);
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  /**
   * 场景 1: 直接读取文件
   * 展示：用户请求 → LLM 决定调用工具 → 工具执行 → 结果返回
   */
  it('场景1: 单工具调用 - 读取文件', async () => {
    console.log('\n' + '='.repeat(60));
    console.log('📋 场景1: 单工具调用 - 读取文件');
    console.log('='.repeat(60));

    // 准备测试文件
    const testFile = join(tempDir, 'hello.txt');
    await writeFile(testFile, 'Hello, World!');

    console.log('\n👤 用户: "Read the file hello.txt"');
    console.log('\n🔄 对话流程:\n');

    // 创建工具执行上下文
    const context: ToolUseContext = {
      toolUseId: 'ctx-1',
      abortController: new AbortController(),
      getAppState: () => ({}),
      setAppState: () => {},
      options: {
        tools: registry.getAllTools(),
        commands: [],
        mainLoopModel: 'test',
        mcpClients: [],
      },
    };

    const executor = new StreamingToolExecutor(
      registry,
      async () => true,
      context
    );

    // 模拟 LLM 返回 tool_use
    console.log('  📡 Turn 1: LLM 分析请求');
    console.log('     → 决定调用 read 工具\n');

    const toolUse: ToolUse = {
      id: 'tool-1',
      name: 'read',
      input: { file_path: testFile },
    };

    // 添加工具
    console.log('  🔧 添加工具到执行队列:');
    console.log(`     read(file_path="${testFile}")`);
    executor.addTool(toolUse);

    printToolExecution(executor, context);

    // 获取执行结果
    console.log('\n  ⏳ 等待工具执行完成...\n');
    const results: string[] = [];
    for await (const update of executor.getRemainingResults()) {
      if (update.message) {
        const content = update.message.content;
        if (Array.isArray(content) && content[0]?.type === 'tool_result') {
          results.push(String(content[0].content));
        }
      }
    }

    console.log('  ✅ 工具执行完成!');
    console.log('\n  📤 执行结果:');
    for (const r of results) {
      console.log(`     "${r.slice(0, 80)}..."`);
    }

    printToolExecution(executor, context);

    console.log('\n' + '='.repeat(60));
    console.log('📊 总结:');
    console.log('   - 工具调用: 1 (read)');
    console.log('   - 执行状态: completed');
    console.log('   - 结果: 文件内容被读取\n');

    expect(results.length).toBe(1);
  });

  /**
   * 场景 2: 读取 + 编辑
   * 展示：两轮工具调用
   */
  it('场景2: 两轮工具调用 - 读取 + 编辑', async () => {
    console.log('\n' + '='.repeat(60));
    console.log('📋 场景2: 两轮工具调用 - 读取 + 编辑');
    console.log('='.repeat(60));

    // 准备测试文件
    const testFile = join(tempDir, 'config.txt');
    await writeFile(testFile, 'DEBUG=false');

    console.log('\n👤 用户: "Change DEBUG to true in config.txt"');
    console.log('\n🔄 对话流程:\n');

    // Turn 1: Read
    console.log('  📡 Turn 1: LLM 分析任务');
    console.log('     → 需要先读取文件内容\n');

    const context: ToolUseContext = {
      toolUseId: 'ctx-1',
      abortController: new AbortController(),
      getAppState: () => ({}),
      setAppState: () => {},
      options: {
        tools: registry.getAllTools(),
        commands: [],
        mainLoopModel: 'test',
        mcpClients: [],
      },
    };

    const executor1 = new StreamingToolExecutor(registry, async () => true, context);

    console.log('  🔧 Turn 1: 添加工具 read');
    executor1.addTool({ id: 't1', name: 'read', input: { file_path: testFile } });

    console.log('\n  ⏳ 执行 read...\n');
    let results: string[] = [];
    for await (const update of executor1.getRemainingResults()) {
      if (update.message) {
        const content = update.message.content;
        if (Array.isArray(content) && content[0]?.type === 'tool_result') {
          results.push(String(content[0].content));
        }
      }
    }

    console.log('  📊 Turn 1 结果:', results[0]?.slice(0, 50));

    // Turn 2: Edit (基于 Turn 1 的结果)
    console.log('\n  📡 Turn 2: LLM 看到文件内容，决定编辑');
    console.log('     → 将 "DEBUG=false" 改为 "DEBUG=true"\n');

    const executor2 = new StreamingToolExecutor(registry, async () => true, context);

    console.log('  🔧 Turn 2: 添加工具 edit');
    executor2.addTool({
      id: 't2',
      name: 'edit',
      input: {
        file_path: testFile,
        old_string: 'DEBUG=false',
        new_string: 'DEBUG=true',
      },
    });

    console.log('\n  ⏳ 执行 edit...\n');
    results = [];
    for await (const update of executor2.getRemainingResults()) {
      if (update.message) {
        const content = update.message.content;
        if (Array.isArray(content) && content[0]?.type === 'tool_result') {
          results.push(String(content[0].content));
        }
      }
    }

    console.log('  📊 Turn 2 结果:', results[0]?.slice(0, 50));

    console.log('\n' + '='.repeat(60));
    console.log('📊 完整流程:');
    console.log('   Turn 1: read(config.txt) → "DEBUG=false"');
    console.log('           ↓');
    console.log('   Turn 2: edit(DEBUG=false → DEBUG=true)');
    console.log('           ↓');
    console.log('   ✅ 文件已修改\n');

    expect(results.length).toBe(1);
  });

  /**
   * 场景 3: 搜索 + 批量读取
   */
  it('场景3: 搜索 + 批量读取', async () => {
    console.log('\n' + '='.repeat(60));
    console.log('📋 场景3: 搜索 + 批量读取');
    console.log('='.repeat(60));

    // 创建多个测试文件
    await writeFile(join(tempDir, 'a.ts'), 'export const A = 1;');
    await writeFile(join(tempDir, 'b.ts'), 'export const B = 2;');
    await writeFile(join(tempDir, 'c.ts'), 'export const C = 3;');

    console.log('\n👤 用户: "Find all .ts files and read their contents"');
    console.log('\n🔄 对话流程:\n');

    const context: ToolUseContext = {
      toolUseId: 'ctx-1',
      abortController: new AbortController(),
      getAppState: () => ({}),
      setAppState: () => {},
      options: {
        tools: registry.getAllTools(),
        commands: [],
        mainLoopModel: 'test',
        mcpClients: [],
      },
    };

    // Turn 1: Glob
    console.log('  📡 Turn 1: LLM 使用 glob 查找文件');
    const executor1 = new StreamingToolExecutor(registry, async () => true, context);
    executor1.addTool({ id: 'g1', name: 'glob', input: { pattern: '*.ts' } });

    let results: string[] = [];
    for await (const update of executor1.getRemainingResults()) {
      if (update.message) {
        const content = update.message.content;
        if (Array.isArray(content) && content[0]?.type === 'tool_result') {
          results.push(String(content[0].content));
        }
      }
    }

    console.log('  📊 glob 结果:', results[0]?.slice(0, 80));

    // Turn 2: 并行读取多个文件
    console.log('\n  📡 Turn 2: LLM 并行读取所有找到的文件');
    console.log('     → read(a.ts), read(b.ts), read(c.ts) 并行执行\n');

    const executor2 = new StreamingToolExecutor(registry, async () => true, context);
    executor2.addTool({ id: 'r1', name: 'read', input: { file_path: join(tempDir, 'a.ts') } });
    executor2.addTool({ id: 'r2', name: 'read', input: { file_path: join(tempDir, 'b.ts') } });
    executor2.addTool({ id: 'r3', name: 'read', input: { file_path: join(tempDir, 'c.ts') } });

    console.log('  ⏳ 并行执行多个 read...\n');
    results = [];
    for await (const update of executor2.getRemainingResults()) {
      if (update.message) {
        const content = update.message.content;
        if (Array.isArray(content) && content[0]?.type === 'tool_result') {
          results.push(String(content[0].content));
        }
      }
    }

    console.log('  📊 读取结果:');
    for (const r of results) {
      console.log(`     - ${r}`);
    }

    console.log('\n' + '='.repeat(60));
    console.log('📊 流程总结:');
    console.log('   Turn 1: glob(*.ts) → 找到 3 个文件');
    console.log('           ↓');
    console.log('   Turn 2: read(a.ts) // read(b.ts) // read(c.ts) (并行)');
    console.log('           ↓');
    console.log('   ✅ 所有文件内容已读取\n');

    expect(results.length).toBe(3);
  });

  /**
   * 场景 4: 错误恢复
   */
  it('场景4: 错误恢复 - 文件不存在', async () => {
    console.log('\n' + '='.repeat(60));
    console.log('📋 场景4: 错误恢复 - 文件不存在');
    console.log('='.repeat(60));

    const missingFile = join(tempDir, 'missing.txt');

    console.log('\n👤 用户: "Read the missing.txt file"');
    console.log('\n🔄 对话流程:\n');

    const context: ToolUseContext = {
      toolUseId: 'ctx-1',
      abortController: new AbortController(),
      getAppState: () => ({}),
      setAppState: () => {},
      options: {
        tools: registry.getAllTools(),
        commands: [],
        mainLoopModel: 'test',
        mcpClients: [],
      },
    };

    const executor = new StreamingToolExecutor(registry, async () => true, context);

    console.log('  📡 Turn 1: LLM 尝试读取不存在的文件');
    executor.addTool({ id: 't1', name: 'read', input: { file_path: missingFile } });

    console.log('\n  ⏳ 执行 read...\n');
    const results: string[] = [];
    for await (const update of executor.getRemainingResults()) {
      if (update.message) {
        const content = update.message.content;
        if (Array.isArray(content) && content[0]?.type === 'tool_result') {
          results.push(String(content[0].content));
        }
      }
    }

    console.log('  📊 工具执行结果:');
    console.log(`     "${results[0]}"`);

    console.log('\n' + '='.repeat(60));
    console.log('📊 错误处理:');
    console.log('   - 工具返回错误信息');
    console.log('   - LLM 可以根据错误决定下一步操作');
    console.log('   - 例如：创建文件、或告知用户文件不存在\n');

    expect(results.length).toBe(1);
    expect(results[0].toLowerCase()).toMatch(/not found|error/i);
  });
});
