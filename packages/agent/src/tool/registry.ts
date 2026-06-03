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
  /**
   * Ownership tag. Phase 2A Batch A: defaults to 'non-mcp' for the
   * existing `register(definition, executor)` path (which is used
   * for builtin, mode-specific, agent, conductor, and any other
   * non-MCP tools — the old path is intentionally NOT scoped to a
   * specific source). Explicitly set to 'mcp' by `registerWithKey`
   * and used by `replaceByOwner` to scope MCP cleanup.
   */
  owner: 'non-mcp' | 'mcp';
}

/**
 * Tool metadata for search results
 */
export interface ToolMeta {
  name: string;
  description: string;
  category: string;
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
    this.tools.set(definition.name, { definition, executor, owner: 'non-mcp' });
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
   * Phase 2A Batch A: register a tool with an explicit internal
   * index key. The visible `definition.name` is preserved on the
   * Tool object as-is; only the registry lookup key differs.
   *
   * Use this for MCP tools whose `internalKey` (e.g.
   * `mcp__plugin:foo:server__tool`) is distinct from the
   * provider-visible `definition.name`. Builtin / mode-specific /
   * agent / conductor / any non-MCP tool continues to use
   * `register(definition, executor)`.
   *
   * Defaults `owner` to 'mcp' so `replaceByOwner('mcp', …)` can
   * scope its operation.
   */
  registerWithKey(
    key: string,
    definition: Tool,
    executor: ToolExecutor,
    owner: 'non-mcp' | 'mcp' = 'mcp',
  ): void {
    if (this.tools.has(key)) {
      throw new Error(
        `ToolRegistry: duplicate registration for key "${key}". ` +
        `If two MCP tools from the same server expose the same name, ` +
        `fix the upstream server; otherwise this is a registry bug.`,
      );
    }
    this.tools.set(key, { definition, executor, owner });
  }

  /**
   * Phase 2A Batch A: remove a tool by its registry key. Returns
   * true if a tool was removed, false if no entry existed for the
   * given key. The key is the internal index (builtin: `name`;
   * MCP: `internalKey`).
   */
  unregister(key: string): boolean {
    return this.tools.delete(key);
  }

  /**
   * Phase 2A Batch A: remove all tools whose (key, definition) pair
   * matches the predicate. Returns the number of entries removed.
   * Used by `DuyaAgent.unregisterMCPTools()` (Batch C) and by
   * `replaceByOwner` internally.
   */
  unregisterAll(predicate: (key: string, definition: Tool) => boolean): number {
    let removed = 0;
    for (const [key, entry] of this.tools) {
      if (predicate(key, entry.definition)) {
        this.tools.delete(key);
        removed++;
      }
    }
    return removed;
  }

  /**
   * Phase 2A Batch A: atomic replace of all entries owned by
   * `ownerId`. Only `'mcp'` is currently supported; non-MCP
   * entries (owner === 'non-mcp', i.e. builtin / mode-specific /
   * agent / conductor / etc.) are NEVER touched by this method.
   * This is the single commit point for an MCP apply (Batch C);
   * failure here means the registry is unchanged.
   *
   * The operation is strictly validate-then-commit:
   *
   *   Phase 1 (validate, no mutation):
   *     1a) Reject if `ownerId !== 'mcp'`.
   *     1b) Reject if `preparedEntries` has duplicate keys.
   *     1c) Reject if any prepared key would overwrite an existing
   *         non-mcp entry.
   *
   *   Phase 2 (compute, no mutation):
   *     2) removedKeys = current mcp keys not in prepared
   *        addedKeys   = prepared keys not currently mcp-owned
   *        keptKeys    = current mcp keys that survive in prepared
   *
   *   Phase 3 (commit, single mutation block):
   *     3) Apply the prepared set; the map is mutated exactly once
   *        via `clear()` followed by re-seeding from the previous
   *        non-mcp entries plus the prepared mcp entries. The
   *        non-mcp entries are byte-equivalent before and after.
   *
   *   On any failure (Phase 1 or any in-Phase-3 error), throw
   *   `MCPRegistryReplaceError`. The registry state is guaranteed
   *   to be unchanged on throw — non-mcp entries are restored
   *   bit-for-bit from the snapshot taken at entry.
   */
  replaceByOwner(
    ownerId: 'mcp',
    preparedEntries: ReadonlyArray<{
      key: string;
      definition: Tool;
      executor: ToolExecutor;
    }>,
  ): {
    removedKeys: string[];
    addedKeys: string[];
    keptKeys: string[];
  } {
    // ---- Snapshot for rollback (taken before any mutation) ----
    const snapshot = new Map(this.tools);

    // ---- Phase 1: validate (no mutation) ----
    if (ownerId !== 'mcp') {
      throw new MCPRegistryReplaceError(
        `replaceByOwner: ownerId must be 'mcp' (got '${ownerId}')`,
      );
    }

    const seen = new Set<string>();
    for (const e of preparedEntries) {
      if (seen.has(e.key)) {
        throw new MCPRegistryReplaceError(
          `replaceByOwner: prepared entries contain duplicate key "${e.key}"`,
        );
      }
      seen.add(e.key);
      const existing = this.tools.get(e.key);
      if (existing && existing.owner !== ownerId) {
        throw new MCPRegistryReplaceError(
          `replaceByOwner: prepared key "${e.key}" collides with an existing ${existing.owner} entry`,
        );
      }
    }

    // ---- Phase 2: compute mutation plan (no mutation) ----
    const currentOwnerKeys = new Set<string>();
    for (const [key, entry] of this.tools) {
      if (entry.owner === ownerId) currentOwnerKeys.add(key);
    }
    const preparedKeySet = new Set(preparedEntries.map((e) => e.key));
    const removedKeys: string[] = [];
    const addedKeys: string[] = [];
    const keptKeys: string[] = [];
    for (const k of currentOwnerKeys) {
      if (!preparedKeySet.has(k)) removedKeys.push(k);
      else keptKeys.push(k);
    }
    for (const e of preparedEntries) {
      if (!currentOwnerKeys.has(e.key)) addedKeys.push(e.key);
    }

    // ---- Phase 3: commit (single mutation block) ----
    // Re-seed the map: keep every non-mcp entry as-is, then set
    // every prepared mcp entry. This is one Map mutation block —
    // no partial state is observable from outside.
    try {
      this.tools.clear();
      // Restore non-mcp entries from the snapshot (byte-equivalent).
      for (const [key, entry] of snapshot) {
        if (entry.owner !== 'mcp') {
          this.tools.set(key, entry);
        }
      }
      // Add the prepared mcp entries.
      for (const e of preparedEntries) {
        this.tools.set(e.key, {
          definition: e.definition,
          executor: e.executor,
          owner: 'mcp',
        });
      }
    } catch (err) {
      // Restore the entire registry on any in-Phase-3 failure.
      this.tools = snapshot;
      throw new MCPRegistryReplaceError(
        `replaceByOwner: commit failed, registry restored: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    return { removedKeys, addedKeys, keptKeys };
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

/**
 * Phase 2A Batch A: error thrown by `ToolRegistry.replaceByOwner`
 * when validation or mutation fails. The registry is guaranteed
 * to be unchanged on throw.
 */
export class MCPRegistryReplaceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MCPRegistryReplaceError';
  }
}
