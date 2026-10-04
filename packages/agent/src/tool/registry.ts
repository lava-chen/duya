/**
 * Input keys whose string values are file/directory paths operated on by the
 * tool. Used to drive conditional-skill activation (paths-gated skills).
 */
const PATH_BEARING_INPUT_KEYS = ['file_path', 'notebook_path', 'path'] as const;

/**
 * Extract file paths touched by a tool call so path-gated skills can react.
 * Relative paths are resolved against the tool's working directory.
 */
function extractTouchedFilePaths(
  input: Record<string, unknown>,
  workingDirectory?: string,
): string[] {
  const paths = new Set<string>();
  for (const key of PATH_BEARING_INPUT_KEYS) {
    const value = input[key];
    if (typeof value !== 'string' || value.trim() === '') continue;
    const resolved = workingDirectory && !path.isAbsolute(value)
      ? path.resolve(workingDirectory, value)
      : value;
    paths.add(resolved);
  }
  return Array.from(paths);
}

/**
 * ToolRegistry - 工具注册与管理
 * 管理工具的注册、查找、执行
 */

import type { Tool, ToolResult, ToolUseContext } from '../types.js';
import { PermissionRequiredError } from './BaseTool.js';
import { activateConditionalSkills, getPendingConditionalSkillCount } from '../skills/conditionalSkills.js';
import path from 'node:path';
import type { ToolSnapshot } from './snapshot.js';
import type { ToolCatalogEntry, ToolCatalogSource, ToolExposure } from './catalog-types.js';
import { createToolId, getSchemaRevision, normalizeToolInputSchema } from './catalog-identity.js';

/**
 * 工具执行器接口
 */
export interface ToolExecutor {
  execute(
    input: Record<string, unknown>,
    workingDirectory?: string,
    context?: ToolUseContext
  ): Promise<ToolResult>;
  /** Optional tool-specific usage guide injected after on-demand discovery. */
  getPrompt?(): string;
  /**
   * Optional Plan 550 step 3a dependency declaration. The
   * `ToolExecutionPipeline` reads this to build a per-batch execution
   * plan via `DependencyGraphOrchestrator.planExecution`. Tools that
   * omit the declaration fall back to the legacy READ/WRITE/SYSTEM
   * batch semantics — kept so the dependency feature is opt-in per
   * tool and never silently changes existing behaviour.
   */
  dependencies?: import('./dependencies.js').ToolDependencyDeclaration;
  /**
   * Optional Plan 550 step 3c input-to-path resolver. Tools that
   * mutate the filesystem can expose the concrete path set so the
   * orchestrator serialises against other writers touching the same
   * path, instead of falling back to the conservative
   * batch-wide serialisation.
   */
  extractWritePaths?: (input: Record<string, unknown>) => readonly string[];
  /**
   * Optional Plan 550 step 3c input-to-path resolver. Mirrors
   * `extractWritePaths` for read paths; lets the orchestrator
   * parallelise reads with non-overlapping writes.
   */
  extractReadPaths?: (input: Record<string, unknown>) => readonly string[];
}

export type { ToolExposure } from './catalog-types.js';

/**
 * Plan 580 D6: ownership tags for replace-set semantics.
 *   - `'non-mcp'` — default for `register()` (builtin / mode / agent tools);
 *     never participates in replace-set.
 *   - `'mcp'` — chain A config-MCP tools, keyed by internalKey.
 *   - `` `connector:${connectionId}` `` — chain B App-Connection tools,
 *     one bucket per connection (plan 580 Phase 2C).
 */
export type ToolOwner = 'non-mcp' | 'mcp' | `connector:${string}`;

/** Owners that `replaceByOwner` may target (replace-set semantics). */
export type ReplaceableOwner = Exclude<ToolOwner, 'non-mcp'>;

function exposureFromMeta(meta: ToolMetaInput | undefined): ToolExposure {
  return meta?.exposure ?? 'eager';
}

function sourceForTool(
  definition: Tool,
  owner: ToolOwner,
  meta: ToolMetaInput | undefined,
  internalName: string,
): ToolCatalogSource {
  if (meta?.source) return { ...meta.source };
  if (owner === 'mcp' && definition.mcpInfo) {
    const pluginOwned = definition.mcpInfo.source === 'plugin';
    const stableConnection = definition.mcpInfo.connectionId ?? definition.mcpInfo.serverName;
    return {
      kind: pluginOwned ? 'plugin' : 'mcp',
      id: pluginOwned && definition.mcpInfo.pluginId
        ? `${definition.mcpInfo.pluginId}:${stableConnection}`
        : stableConnection,
    };
  }
  return { kind: 'builtin', id: internalName };
}

function conciseHint(definition: Tool, meta: ToolMetaInput | undefined): string {
  const text = (meta?.discovery?.conciseHint ?? meta?.inputSchemaSummary ?? definition.description)
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
  return text.length > 180 ? `${text.slice(0, 177)}...` : text;
}

function freezeJson<T>(value: T): T {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value as Record<string, unknown>)) freezeJson(child);
  return Object.freeze(value);
}

/**
 * Plan 241: persisted registration metadata. Forwarded to the
 * third argument of `ToolRegistry.register`. All fields optional.
 */
export interface ToolMetaInput {
  /** Canonical loading policy. */
  exposure?: ToolExposure;
  inputSchemaSummary?: string;
  /** Full catalog contract when the provider-facing definition is budget-downgraded. */
  catalogInputSchema?: Record<string, unknown>;
  catalogDescription?: string;
  /** Short, non-authoritative catalog description and search metadata. */
  discovery?: {
    namespace?: string;
    conciseHint?: string;
    tags?: string[];
  };
  /** Stable source identity, distinct from model-visible and display names. */
  source?: ToolCatalogSource;
  /**
   * Plan 312 Phase 4: risk tier for connector tools. When present,
   * the permission gate applies tier-based gating before the
   * mode-based bypass check. See `riskTierPermissions.ts`.
   */
  riskTier?: import('../permissions/policy.js').RiskTier;
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
   * and to `connector:${connectionId}` by the App-Connection bucket
   * registration; used by `replaceByOwner` to scope cleanup.
   */
  owner: ToolOwner;
  /** Catalog metadata captured with the definition and executor. */
  meta?: ToolMetaInput;
}

/**
 * Tool metadata for search results (Plan 241: minimal shape — name + description only).
 */
export interface ToolMeta {
  name: string;
  description: string;
}

/** Internal metadata stored in a registry snapshot. */
export interface ToolHintMeta {
  exposure: ToolExposure;
  discovery?: ToolMetaInput['discovery'];
  source?: ToolCatalogSource;
  inputSchemaSummary?: string;
  riskTier?: import('../permissions/policy.js').RiskTier;
}

/**
 * 工具注册表
 */
export class ToolRegistry {
  private tools: Map<string, RegisteredTool> = new Map();

  /**
   * Plan 580 D10: monotonic catalog revision, bumped on every catalog
   * mutation. Snapshots capture it so `tool_catalog` list-mode cursors
   * can detect an inventory refresh that happened mid-pagination
   * (`CATALOG_CURSOR_STALE`).
   */
  private catalogRevisionCounter = 1;

  private bumpCatalogRevision(): void {
    this.catalogRevisionCounter++;
  }

  /** Current catalog revision (monotonic; increments on every mutation). */
  getCatalogRevision(): number {
    return this.catalogRevisionCounter;
  }

  /** Register a tool and its catalog metadata. */
  register(
    definition: Tool,
    executor: ToolExecutor,
    meta?: ToolMetaInput,
  ): void {
    this.tools.set(definition.name, {
      definition,
      executor,
      owner: 'non-mcp',
      meta: meta ? cloneToolMeta(meta) : undefined,
    });
    this.bumpCatalogRevision();
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
    owner: ToolOwner = 'mcp',
    meta?: ToolMetaInput,
  ): void {
    if (this.tools.has(key)) {
      throw new Error(
        `ToolRegistry: duplicate registration for key "${key}". ` +
        `If two MCP tools from the same server expose the same name, ` +
        `fix the upstream server; otherwise this is a registry bug.`,
      );
    }
    this.tools.set(key, { definition, executor, owner, meta: meta ? cloneToolMeta(meta) : undefined });
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
   * Refresh a registered tool's definition by calling `toTool()` on
   * its executor. Used when a tool's description or schema changes
   * after initial registration (e.g. browser tool mode switch).
   */
  refreshDefinition(name: string): boolean {
    const entry = this.tools.get(name);
    if (!entry) return false;
    const executor = entry.executor as ToolExecutor & { toTool?: () => Tool };
    if (typeof executor.toTool === 'function') {
      entry.definition = executor.toTool();
      return true;
    }
    return false;
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
    if (removed > 0) this.bumpCatalogRevision();
    return removed;
  }

  /**
   * Phase 2A Batch A: atomic replace of all entries owned by
   * `ownerId`. Plan 580 Phase 2C: accepts `'mcp'` (chain A) and
   * `` `connector:${connectionId}` `` (chain B buckets); non-MCP
   * entries (owner === 'non-mcp', i.e. builtin / mode-specific /
   * agent / conductor / etc.) are NEVER touched by this method.
   * This is the single commit point for an MCP apply (Batch C) and
   * for connector replace-sets; failure here means the registry is
   * unchanged.
   *
   * The operation is strictly validate-then-commit:
   *
   *   Phase 1 (validate, no mutation):
   *     1a) Reject if `ownerId === 'non-mcp'`.
   *     1b) Reject if `preparedEntries` has duplicate keys.
   *     1c) Reject if any prepared key would overwrite an existing
   *         entry owned by a different owner.
   *
   *   Phase 2 (compute, no mutation):
   *     2) removedKeys = current owner keys not in prepared
   *        addedKeys   = prepared keys not currently owner-owned
   *        keptKeys    = current owner keys that survive in prepared
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
    ownerId: ReplaceableOwner,
    preparedEntries: ReadonlyArray<{
      key: string;
      definition: Tool;
      executor: ToolExecutor;
      meta?: ToolMetaInput;
    }>,
  ): {
    removedKeys: string[];
    addedKeys: string[];
    keptKeys: string[];
  } {
    // ---- Snapshot for rollback (taken before any mutation) ----
    const snapshot = new Map(this.tools);

    // ---- Phase 1: validate (no mutation) ----
    // ReplaceableOwner already excludes 'non-mcp' at the type level; this
    // runtime guard covers callers that bypass the static type (e.g. JS
    // callers or untyped IPC payloads).
    //
    // It validates the FULL owner union ('mcp' | `connector:${string}`), not
    // just the 'non-mcp' case. Rejecting only 'non-mcp' left the documented
    // constraint unenforced: an unrecognised owner sailed through validation
    // and then, in Phase 3, committed its prepared entries under an owner
    // string no replace-set can ever target again — permanently orphaning
    // them in the catalog. A typo'd bucket name ('connectr:slack') was worse,
    // because the removal it was asked to perform silently did nothing.
    if (ownerId !== 'mcp' && !ownerId.startsWith('connector:')) {
      throw new MCPRegistryReplaceError(
        `replaceByOwner: ownerId must be 'mcp' or 'connector:<connectionId>' (got '${ownerId}')`,
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
    // Re-seed the map: keep every entry NOT owned by the target owner
    // as-is (non-mcp, mcp, and other connector buckets), then set the
    // prepared entries. One Map mutation block — no partial state is
    // observable from outside.
    try {
      this.tools.clear();
      // Restore foreign-owner entries from the snapshot (byte-equivalent).
      for (const [key, entry] of snapshot) {
        if (entry.owner !== ownerId) {
          this.tools.set(key, entry);
        }
      }
      // Add the prepared entries under the target owner.
      for (const e of preparedEntries) {
        this.tools.set(e.key, {
          definition: e.definition,
          executor: e.executor,
          owner: ownerId,
          meta: e.meta ? cloneToolMeta(e.meta) : undefined,
        });
      }
    } catch (err) {
      // Restore the entire registry on any in-Phase-3 failure.
      this.tools = snapshot;
      throw new MCPRegistryReplaceError(
        `replaceByOwner: commit failed, registry restored: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    this.bumpCatalogRevision();
    return { removedKeys, addedKeys, keptKeys };
  }

  /**
   * 获取工具定义
   */
  getTool(name: string): Tool | undefined {
    return this.findEntry(name)?.definition;
  }

  /**
   * 获取所有工具定义
   */
  getAllTools(): Tool[] {
    return Array.from(this.tools.values()).map((t) => t.definition);
  }

  /**
   * Plan 314: build an immutable per-turn snapshot of the catalog.
   *
   * The snapshot captures tools, executors, metadata, and the
   * providerName→internalKey alias map at a single point in time.
   * Lookup helpers key on `definition.name` (the model-visible
   * name), which is correct for both builtin tools (registry key
   * === name) and MCP tools (registry key === internalKey, name
   * === providerName).
   *
   * The returned `tools` array is frozen; callers must not mutate.
   * The catalog may continue to mutate after the snapshot is taken
   * (e.g. `tools/list_changed`); the snapshot remains stable for
   * the duration of the turn that requested it.
   */
  snapshot(
    providerNameToInternalKey: ReadonlyMap<string, string>,
  ): ToolSnapshot {
    const tools: Tool[] = [];
    const exposureMap = new Map<string, ToolExposure>();
    const executorMap = new Map<string, ToolExecutor>();
    const metaMap = new Map<string, ToolHintMeta>();
    const catalogEntries: ToolCatalogEntry[] = [];
    const catalogById = new Map<string, ToolCatalogEntry>();
    for (const [internalName, rt] of this.tools) {
      const name = rt.definition.name;
      tools.push(rt.definition);
      const exposure = exposureFromMeta(rt.meta);
      exposureMap.set(name, exposure);
      executorMap.set(name, rt.executor);
      metaMap.set(name, {
        exposure,
        discovery: rt.meta?.discovery ? { ...rt.meta.discovery, tags: [...(rt.meta.discovery.tags ?? [])] } : undefined,
        source: rt.meta?.source ? { ...rt.meta.source } : undefined,
        inputSchemaSummary: rt.meta?.inputSchemaSummary,
        riskTier: rt.meta?.riskTier,
      });

      const source = sourceForTool(rt.definition, rt.owner, rt.meta, internalName);
      const info = rt.definition.mcpInfo;
      const namespace = rt.meta?.discovery?.namespace ?? (info?.serverName ?? (source.kind === 'connector' ? source.id : 'builtin'));
      const inputSchema = normalizeToolInputSchema(rt.meta?.catalogInputSchema ?? rt.definition.input_schema);
      const description = rt.meta?.catalogDescription ?? rt.definition.description;
      const entry: ToolCatalogEntry = Object.freeze({
        toolId: createToolId(source, info?.toolName ?? rt.definition.name),
        internalName,
        definition: rt.definition,
        executor: rt.executor,
        exposure,
        discovery: Object.freeze({
          namespace,
          conciseHint: conciseHint(rt.definition, rt.meta),
          tags: Object.freeze([...(rt.meta?.discovery?.tags ?? [])]),
        }),
        source: Object.freeze(source),
        description,
        schemaRevision: getSchemaRevision(inputSchema),
        inputSchema: freezeJson(inputSchema),
      });
      if (catalogById.has(entry.toolId)) {
        throw new Error(`ToolRegistry: duplicate stable tool ID "${entry.toolId}"`);
      }
      catalogById.set(entry.toolId, entry);
      if (exposure !== 'hidden') catalogEntries.push(entry);
    }
    return {
      tools: Object.freeze(tools) as readonly Tool[],
      providerNameToInternalKey,
      // Plan 580 D10: revision captured at snapshot time for cursor binding.
      catalogRevision: this.catalogRevisionCounter,
      getExposure: (n: string) => exposureMap.get(n) ?? 'eager',
      getExecutor: (n: string) => executorMap.get(n),
      getMeta: (n: string) => metaMap.get(n),
      catalogEntries: Object.freeze(catalogEntries),
      getCatalogEntry: (id: string) => catalogById.get(id),
      createdAt: Date.now(),
    };
  }

  /** Resolve the current live catalog row by stable identity. */
  getCatalogEntryById(toolId: string): ToolCatalogEntry | undefined {
    return this.snapshot(new Map()).getCatalogEntry(toolId);
  }

  /**
   * 获取工具执行器实例
   */
  getExecutor(name: string): ToolExecutor | undefined {
    return this.findEntry(name)?.executor;
  }

  /**
   * Plan 241: get persisted registration metadata. Returns the
   * shape stored via the third `meta` argument of `register`, or
   * `undefined` for tools registered without explicit metadata.
   */
  getMeta(name: string): ToolMetaInput | undefined {
    return this.findEntry(name)?.meta;
  }

  getExposure(name: string): ToolExposure {
    return exposureFromMeta(this.findEntry(name)?.meta);
  }

  /**
   * Resolve either the storage key or the model-visible tool name. MCP tools
   * are stored under their internal key while catalog entries expose the latter.
   */
  private findEntry(name: string): RegisteredTool | undefined {
    const direct = this.tools.get(name);
    if (direct) return direct;
    for (const entry of this.tools.values()) {
      if (entry.definition.name === name) return entry;
    }
    return undefined;
  }

  /**
   * Plan 314: look up the ownership tag of a tool by its
   * model-visible `definition.name`. Builtin / plugin /
   * app-connection tools are keyed by `definition.name` (fast
   * path); MCP tools are keyed by `internalKey`, so a miss on the
   * fast path falls through to a linear scan over
   * `definition.name`. Returns `undefined` for unknown names.
   *
   * Used by `DuyaAgent.getNonMCPModelVisibleToolNames` to derive
   * the providerName allocator seed from the live catalog instead
   * of a hardcoded builtin list.
   */
  getOwner(name: string): ToolOwner | undefined {
    const direct = this.tools.get(name);
    if (direct) return direct.owner;
    for (const [, entry] of this.tools) {
      if (entry.definition.name === name) return entry.owner;
    }
    return undefined;
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
      const result = await tool.executor.execute(input, workingDirectory, context);
      return this.maybeActivateConditionalSkills(result, input, workingDirectory);
    } catch (error) {
      if (error instanceof PermissionRequiredError) {
        throw error;
      }
      return {
        id: '',
        name,
        result: error instanceof Error ? error.message : 'Unknown error',
        error: true,
      };
    }
  }

  /**
   * After a successful tool execution, feed touched file paths to the
   * conditional-skill activation loop. When skills activate, surface a
   * transient `pendingContext` note (next provider turn) so the model learns
   * they are now in the catalog. Never overwrites a tool's own pendingContext.
   */
  private maybeActivateConditionalSkills(
    result: ToolResult,
    input: Record<string, unknown>,
    workingDirectory?: string,
  ): ToolResult {
    if (result?.error || getPendingConditionalSkillCount() === 0) {
      return result;
    }

    const filePaths = extractTouchedFilePaths(input, workingDirectory);
    if (filePaths.length === 0) {
      return result;
    }

    let activated: string[] = [];
    try {
      activated = activateConditionalSkills(filePaths, workingDirectory);
    } catch {
      // Activation is best-effort; never fail the tool result over it.
      return result;
    }

    if (activated.length > 0 && !result.pendingContext) {
      const names = activated.join(', ');
      result.pendingContext = Promise.resolve(
        `Conditionally-available skill(s) just activated because a matching file was operated on: ${names}. ` +
        'They now appear in the Skills catalog; load one via its <location> with the read tool or the Skill tool when relevant to the task.',
      );
    }

    return result;
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

function cloneToolMeta(meta: ToolMetaInput): ToolMetaInput {
  return {
    ...meta,
    ...(meta.catalogInputSchema ? { catalogInputSchema: normalizeToolInputSchema(meta.catalogInputSchema) } : {}),
    ...(meta.discovery ? { discovery: { ...meta.discovery, tags: meta.discovery.tags ? [...meta.discovery.tags] : undefined } } : {}),
    ...(meta.source ? { source: { ...meta.source } } : {}),
  };
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
