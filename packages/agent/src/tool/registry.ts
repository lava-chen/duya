/**
 * ToolRegistry - 工具注册与管理
 * 管理工具的注册、查找、执行
 */

import type { Tool, ToolResult, ToolUseContext } from '../types.js';

/**
 * 工具执行器接口
 */
export interface ToolExecutor {
  execute(
    input: Record<string, unknown>,
    workingDirectory?: string,
    context?: ToolUseContext
  ): Promise<ToolResult>;
}

/**
 * 注册的工具项
 */
interface RegisteredTool {
  definition: Tool;
  executor: ToolExecutor;
}

/**
 * 工具注册表
 */
export class ToolRegistry {
  private tools: Map<string, RegisteredTool> = new Map();

  /**
   * 注册一个工具
   */
  register(definition: Tool, executor: ToolExecutor): void {
    this.tools.set(definition.name, { definition, executor });
  }

  /**
   * 注册多个工具
   */
  registerAll(tools: Array<{ definition: Tool; executor: ToolExecutor }>): void {
    for (const { definition, executor } of tools) {
      this.register(definition, executor);
    }
  }

  /**
   * 获取工具定义
   */
  getTool(name: string): Tool | undefined {
    return this.tools.get(name)?.definition;
  }

  /**
   * 获取所有工具定义
   */
  getAllTools(): Tool[] {
    return Array.from(this.tools.values()).map((t) => t.definition);
  }

  /**
   * 获取工具执行器实例
   */
  getExecutor(name: string): ToolExecutor | undefined {
    return this.tools.get(name)?.executor;
  }

  /**
   * Check if a tool supports concurrent execution
   */
  isToolConcurrencySafe(name: string): boolean {
    const executor = this.tools.get(name)?.executor;
    if (executor && 'isConcurrencySafe' in executor && typeof (executor as Record<string, unknown>).isConcurrencySafe === 'function') {
      return (executor as { isConcurrencySafe(): boolean }).isConcurrencySafe();
    }
    return false;
  }

  /**
   * 执行工具
   */
  async execute(
    name: string,
    input: Record<string, unknown>,
    workingDirectory?: string,
    context?: ToolUseContext
  ): Promise<ToolResult | null> {
    const tool = this.tools.get(name);
    if (!tool) {
      return null;
    }

    try {
      return await tool.executor.execute(input, workingDirectory, context);
    } catch (error) {
      return {
        id: '',
        name,
        result: error instanceof Error ? error.message : 'Unknown error',
        error: true,
      };
    }
  }

  /**
   * 检查工具是否存在
   */
  has(name: string): boolean {
    return this.tools.has(name);
  }

  /**
   * 获取已注册工具数量
   */
  get size(): number {
    return this.tools.size;
  }
}

export default ToolRegistry;
