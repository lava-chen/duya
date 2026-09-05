# Plan 314: ToolCatalog + ToolSnapshot 工具注入简化

> **Goal:** 用一个长驻 ToolCatalog（多 Provider 注册）+ 每轮不可变 ToolSnapshot，替换当前的双层 registry + activeMCPToolEntries 缓存 + per-turn mergeActiveMCPTools，并修复 init 时序竞态，补齐 MCP `tools/list_changed` 动态更新。

**Architecture:**
```
BuiltinProvider ─┐
PluginProvider  ─┼─> ToolCatalog（长驻、可变、多 Provider）
MCPProvider     ─┘   AppConnectionProvider
                          │  catalog.snapshot()
                          ▼
                    ToolSnapshot（单次 streamChat 不可变）
                          │  isToolVisible 过滤
                          ▼
                    tools[] → LLM 请求
```
- ToolCatalog = 现有 `ToolRegistry` 演进（长驻实例，不再每轮新建）
- ToolSnapshot = `catalog.snapshot()` 返回的不可变视图（tools 数组 + alias map + meta 查询）
- mcpReady 门控：init 时 MCP 异步初始化，首批 chat:start 等待 mcpReady Promise（带超时）

**Tech Stack:** TypeScript, @duya/agent, @duya/plugin-core, @modelcontextprotocol/sdk

---

## 当前问题（勘察证据）

1. **时序竞态**：`agent-process-entry.ts:2834-2886` 中 `initializing=false` + `drainQueuedChatStart()` + `sendToMain('ready')` 都发生在 MCP 初始化 IIFE（2870）之前，首批 chat 命中 `mergeActiveMCPTools` 的 `size===0` 早退守卫（DuyaAgent.ts:2239），拿不到 MCP 工具。
2. **双层 registry 复杂度**：per-turn `createBuiltinRegistry()` + 长驻 `activeMCPRegistry` + `activeMCPToolEntries` 缓存 + 每轮 `mergeActiveMCPTools` 合并。
3. **无 list_changed 处理**：MCPClient（mcp/index.ts:99-107）创建 Client 时 `capabilities: {}`，未注册 notification handler；`this.tools` 仅在 connect() 时填充一次。
4. **getNonMCPModelVisibleToolNames 硬编码**（DuyaAgent.ts:2283-2295）：与 builtin.ts 实际注册脱钩，且包含已删除工具（cron, duya_info）。
5. **registerWithKey 不接受 meta**（registry.ts:145-159）：MCP 工具无法标记 discoverable。

## 影响面（勘察证据）

`mergeActiveMCPTools` / `activeMCPToolEntries` / `activeMCPRegistry` 仅在 DuyaAgent 内部使用，无外部消费者。`DuyaAgentLike` 接口（apply.ts:88-124）是 apply.ts 与 DuyaAgent 的唯一契约。重构影响面可控。

---

## Phase 1: ToolSnapshot 基础设施（叠加，不删旧）

在 ToolRegistry 上叠加 `snapshot()` 能力，不破坏现有 API。

**Files:**
- Modify: `packages/agent/src/tool/registry.ts`
- Create: `packages/agent/src/tool/snapshot.ts`

- [ ] **1.1 新建 ToolSnapshot 类型** (`packages/agent/src/tool/snapshot.ts`)

不可变视图，包含本轮 chat 所需的全部信息：
```typescript
export interface ToolSnapshot {
  /** 本轮可见的全部工具定义（含 builtin + mcp + plugin + app-connection） */
  readonly tools: ReadonlyArray<Tool>;
  /** providerName → internalKey 别名表（StreamingToolExecutor 依赖） */
  readonly providerNameToInternalKey: ReadonlyMap<string, string>;
  /** 按 name 查询 exposeMode（isToolVisible 依赖） */
  getExposeMode(name: string): ExposeMode;
  /** 按 name 查询 executor（streamChat 工具调用依赖） */
  getExecutor(name: string): ToolExecutor | undefined;
  /** 按 name 查询 meta（tool_search 依赖） */
  getMeta(name: string): ToolMeta | undefined;
  /** 生成时的时间戳，用于诊断 */
  readonly createdAt: number;
}
```

- [ ] **1.2 ToolRegistry 增加 snapshot() 方法** (`registry.ts`)

在现有 `getAllTools()` 之上叠加，复用内部 `tools` Map：
```typescript
snapshot(providerNameToInternalKey: ReadonlyMap<string, string>): ToolSnapshot {
  // 浅拷贝当前 tools 数组，冻结视图
  const tools = Object.freeze(this.getAllTools()) as readonly Tool[];
  const exposeModeMap = new Map<string, ExposeMode>();
  const executorMap = new Map<string, ToolExecutor>();
  const metaMap = new Map<string, ToolMeta>();
  for (const [key, rt] of this.tools) {
    const name = rt.definition.name;
    exposeModeMap.set(name, rt.meta?.exposeMode ?? 'always');
    executorMap.set(name, rt.executor);
    metaMap.set(name, this.getMeta(name) ?? { name, description: rt.definition.description, category: 'unknown' });
  }
  return {
    tools,
    providerNameToInternalKey,
    getExposeMode: (n) => exposeModeMap.get(n) ?? 'always',
    getExecutor: (n) => executorMap.get(n),
    getMeta: (n) => metaMap.get(n),
    createdAt: Date.now(),
  };
}
```

- [ ] **1.3 typecheck 通过**

Run: `npm run typecheck:all`

---

## Phase 2: DuyaAgent 持有长驻 catalog + builtin 一次注册

把 DuyaAgent 从"每轮 createBuiltinRegistry"改为"init 时注册一次到长驻 catalog"。

**Files:**
- Modify: `packages/agent/src/agent/DuyaAgent.ts`
- Modify: `packages/agent/src/process/agent-process-entry.ts`

- [ ] **2.1 DuyaAgent 新增 toolCatalog 字段**（替换 per-turn registry 思路）

在 DuyaAgent.ts 字段区（约 234-307 行）：
- 新增 `private readonly toolCatalog: ToolRegistry`（长驻，init 时 new 一次）
- 保留 `activeMCPRegistry` 字段但标记 `@deprecated`（Phase 6 删除）
- 新增 `private mcpReady: Promise<void> | null = null`（门控用）

- [ ] **2.2 新增 initToolCatalog() 方法**

在 init 时调用一次，把 builtin 工具注册进长驻 catalog：
```typescript
async initToolCatalog(): Promise<void> {
  const { createBuiltinRegistry } = await import('../tool/builtin.js');
  // 复用现有 createBuiltinRegistry 构造一个临时 registry，再把工具迁移进 toolCatalog
  const temp = createBuiltinRegistry(
    this.blockedDomains.length > 0 ? { blockedDomains: this.blockedDomains } : undefined,
    { browserBackendMode: this.browserBackendMode }
  );
  // 把 temp 的全部工具迁移到 toolCatalog（owner='non-mcp'）
  for (const tool of temp.getAllTools()) {
    const executor = temp.getExecutor(tool.name);
    const meta = temp.getMeta(tool.name);
    if (executor) this.toolCatalog.register(tool, executor, meta);
  }
}
```

注意：enabledPluginIds 的过滤逻辑暂时保留在 createBuiltinRegistry 内（Phase 5 再拆分为独立 PluginProvider）。

- [ ] **2.3 agent-process-entry.ts init 流程调用 initToolCatalog**

在 `await initAgent(...)` 之后（约 2759 行之后）、`loadAgentSkills` 之前调用：
```typescript
await agent.initToolCatalog();
```

- [ ] **2.4 typecheck + 既有测试不回归**

Run: `npm run typecheck:all && npm run test`

---

## Phase 3: _resolveTools 改用 snapshot + 删除 mergeActiveMCPTools

核心简化：每轮 streamChat 不再新建 registry + merge，而是从长驻 catalog 取快照。

**Files:**
- Modify: `packages/agent/src/agent/DuyaAgent.ts`

- [ ] **3.1 _resolveTools 改写**（DuyaAgent.ts:1757-1866）

新逻辑：
1. 不再 `createBuiltinRegistry`（builtin 已在 init 时注册到 catalog）
2. 不再 `mergeActiveMCPTools`（MCP 已通过 applyMCPConfiguration 的 replaceByOwner 注册到 catalog）
3. 直接 `const snapshot = this.toolCatalog.snapshot(this.providerNameToInternalKey)`
4. `const allTools = snapshot.tools`
5. `const tools = allTools.filter(t => isToolVisible(t.name, snapshot.getExposeMode(t.name), EMPTY_DISCOVERED, constraints))`
6. 返回 `{ tools, registry: this.toolCatalog, agentDefinitions, constraints }`（registry 保留供 tool_search/refreshDefinition 用）

注意：`options.toolRegistry` 分支保留（orchestrator 模式 + subagent 仍可传入自定义 registry）。

- [ ] **3.2 删除 mergeActiveMCPTools**（DuyaAgent.ts:2238-2247）

- [ ] **3.3 删除 activeMCPToolEntries 字段**（DuyaAgent.ts:306）

- [ ] **3.4 setActiveMCPRuntime 移除 toolEntries 参数**（DuyaAgent.ts:2309-2353）

新签名只接收 `{ manager, providerNameToInternalKey, preparedRegistryEntries, snapshot }`，不再需要 toolEntries（因为没有 mergeActiveMCPTools 了）。同步修改 apply.ts 的 DuyaAgentLike 接口（apply.ts:113-123）。

- [ ] **3.5 orchestrator 模式（DuyaAgent.ts:2097-2124）同步改用 snapshot**

orchestrator 模式当前也调用 createBuiltinRegistry + mergeActiveMCPTools，改为与主路径一致的 snapshot 逻辑。

- [ ] **3.6 tool_search 接线保留**

`toolSearchTool.setSearchFn((q, l) => searchToolsFromRegistry(this.toolCatalog, q, l))` — searchToolsFromRegistry 已接受 ToolRegistry，长驻 catalog 也是一个 ToolRegistry，无需改动。

- [ ] **3.7 typecheck + test**

Run: `npm run typecheck:all && npm run test`

---

## Phase 4: mcpReady 门控（修复时序竞态）

init 时 MCP 异步初始化，但首批 chat:start 等待 mcpReady Promise（带超时）。

**Files:**
- Modify: `packages/agent/src/process/agent-process-entry.ts`
- Modify: `packages/agent/src/agent/DuyaAgent.ts`

- [ ] **4.1 DuyaAgent 暴露 mcpReady Promise**

```typescript
private mcpReadyResolve: (() => void) | null = null;
private mcpReady: Promise<void> = new Promise((resolve) => { this.mcpReadyResolve = resolve; });

/** 首批 chat 等待此 Promise（带超时），确保 MCP 工具已注入 catalog */
waitForMcpReady(timeoutMs = 8000): Promise<void> {
  return Promise.race([
    this.mcpReady,
    new Promise<void>((_, reject) =>
      setTimeout(() => reject(new Error(`MCP init timeout after ${timeoutMs}ms`)), timeoutMs)
    ),
  ]).catch(() => { /* 超时不阻塞 chat，仅日志 */ });
}

/** applyMCPConfiguration 完成后调用 */
notifyMcpReady(): void {
  this.mcpReadyResolve?.();
}
```

- [ ] **4.2 agent-process-entry.ts init 流程调整**（约 2870-2886 行）

保持 fire-and-forget IIFE，但在 applyMCPConfiguration 完成后调用 `agent.notifyMcpReady()`：
```typescript
(async () => {
  if (!agent) return;
  try {
    agent.setActiveAgentProfileId(undefined);
    const result = await applyMCPConfiguration({ agent, reason: 'initialization' });
    agent.notifyMcpReady();  // ← 通知首批 chat 可以继续
    log(`[Agent-Process] Initialized MCP servers: ${result.action.clientsConnected} connected, ...`);
  } catch (mcpErr) {
    agent.notifyMcpReady();  // ← 失败也通知，避免 chat 永久阻塞
    warn('[Agent-Process] Failed to initialize MCP servers after ready:', mcpErr);
  }
})();
```

- [ ] **4.3 handleChatStart 开头加门控**（约 2500 行附近）

在 handleChatStart 函数开头：
```typescript
async function handleChatStart(msg: ChatStartMessage) {
  if (agent) {
    try { await agent.waitForMcpReady(8000); }
    catch (e) { warn('[Agent-Process] MCP ready timeout, proceeding without MCP tools:', e); }
  }
  // ... 原有逻辑
}
```

注意：超时后不阻塞 chat，仅 warning。首批 chat 在 MCP 慢时会等最多 8 秒；MCP 正常时几乎无感。

- [ ] **4.4 typecheck + 手动验证**

Run: `npm run typecheck:all`
验证：启动 electron:dev，发送一条消息，检查 app.log 中是否出现 `MCP servers: N connected, M tools` 且在 chat 开始之前。

---

## Phase 5: getNonMCPModelVisibleToolNames 改为 catalog 查询

消除硬编码列表，由 catalog 实时查询非 mcp Provider 的工具名。

**Files:**
- Modify: `packages/agent/src/agent/DuyaAgent.ts`
- Modify: `packages/agent/src/mcp/apply.ts`

- [ ] **5.1 getNonMCPModelVisibleToolNames 改写**（DuyaAgent.ts:2283-2295）

```typescript
getNonMCPModelVisibleToolNames(): Set<string> {
  const names = new Set<string>();
  for (const tool of this.toolCatalog.getAllTools()) {
    // owner !== 'mcp' 的工具名（builtin + plugin + app-connection）
    // 注意：toolCatalog 需要新增 getOwner(name) 方法或遍历内部 Map
    if (this.toolCatalog.getOwner(tool.name) !== 'mcp') {
      names.add(tool.name);
    }
  }
  return names;
}
```

- [ ] **5.2 ToolRegistry 新增 getOwner(name) 方法**（registry.ts）

```typescript
getOwner(name: string): 'non-mcp' | 'mcp' | undefined {
  const rt = this.findByName(name);
  return rt?.owner;
}
```

需要内部 `findByName` helper（遍历 tools Map 找 definition.name === name）。

- [ ] **5.3 typecheck**

Run: `npm run typecheck:all`

---

## Phase 6: MCP tools/list_changed 动态更新

MCP 服务器工具列表变化时增量更新 catalog，无需全量 reload。

**Files:**
- Modify: `packages/agent/src/mcp/index.ts`（MCPClient + MCPManager）
- Modify: `packages/agent/src/mcp/apply.ts`（新增 applyMCPToolsChanged 轻量路径）

- [ ] **6.1 MCPClient 注册 notification handler**（mcp/index.ts:99-107）

connect() 时注册 tools/list_changed 回调：
```typescript
this.client = new Client(
  { name: 'duya-mcp-client', version: '0.1.0' },
  { capabilities: {} }
);
// 注册 list_changed 通知
this.client.setNotificationHandler(
  'notifications/tools/list_changed',
  async () => {
    try {
      const result = await this.client.listTools();
      this.tools = result.tools.map(/* 同 connect() 逻辑 */);
      // 通知外部 listener
      this.onToolsChanged?.(this.scopedServerName);
    } catch (err) {
      // log + 忽略，不影响现有连接
    }
  }
);
```

- [ ] **6.2 MCPClient 新增 refreshTools() 方法**

供外部主动刷新单服务器工具列表：
```typescript
async refreshTools(): Promise<Tool[]> {
  const result = await this.client.listTools();
  this.tools = result.tools.map(/* 同 connect() */);
  return this.tools;
}
```

- [ ] **6.3 MCPManager 新增 onToolsChanged 回调注册**

```typescript
private toolsChangedListeners: Array<(serverName: string) => void> = [];

onToolsChanged(cb: (serverName: string) => void): void {
  this.toolsChangedListeners.push(cb);
}

// 内部：当某 client 的 list_changed 触发时，调用所有 listeners
private notifyToolsChanged(serverName: string): void {
  for (const cb of this.toolsChangedListeners) cb(serverName);
}
```

- [ ] **6.4 apply.ts 新增 applyMCPToolsChanged(serverName) 轻量路径**

不全量重建，只刷新单个服务器的工具子集：
```typescript
export async function applyMCPToolsChanged(
  agent: DuyaAgentLike,
  serverName: string,
): Promise<void> {
  // 1. 从 agent.mcpManager 获取该 server 的 client
  // 2. client.refreshTools() 拿新工具列表
  // 3. 用 buildProviderNameAllocator 重新分配 providerName
  //    （seed = catalog 中所有非 mcp 工具名 + 其他 mcp 服务器的工具名）
  // 4. 构建 preparedEntries（仅该服务器的工具）
  // 5. catalog.replaceByServer(serverName, preparedEntries)  ← 新方法
}
```

- [ ] **6.5 ToolRegistry 新增 replaceByServer 方法**（registry.ts）

类似 replaceByOwner，但只替换指定 server 的工具：
```typescript
replaceByServer(serverName: string, entries: PreparedEntry[]): { removedKeys: string[]; addedKeys: string[] } {
  // 1. 找出所有 mcpInfo.serverName === serverName 的条目
  // 2. 删除它们
  // 3. 插入新 entries
  // 4. 返回 diff
}
```

- [ ] **6.6 applyMCPConfiguration 注册 onToolsChanged listener**

在 PHASE B1 创建 nextManager 后注册：
```typescript
nextManager.onToolsChanged((serverName) => {
  void applyMCPToolsChanged(agent, serverName);
});
```

- [ ] **6.7 typecheck + 手动验证**

Run: `npm run typecheck:all`
验证：连接一个支持 list_changed 的 MCP 服务器，触发工具列表变化，检查 app.log 是否出现增量更新。

---

## Phase 7: 清理 + 验证

- [ ] **7.1 删除 activeMCPRegistry 字段**（DuyaAgent.ts:303）

apply.ts 的 DuyaAgentLike 接口中 `activeMCPRegistry` 改为 `toolCatalog`。

- [ ] **7.2 删除 getNonMCPModelVisibleToolNames 硬编码列表**（已在 Phase 5 完成）

- [ ] **7.3 更新 ARCHITECTURE.md**

在 Profile/Mode/Permission 段落补充 ToolCatalog/ToolSnapshot 说明。

- [ ] **7.4 全量 typecheck + test**

Run: `npm run typecheck:all && npm run test`

- [ ] **7.5 Electron 手动验证**

启动 electron:dev，验证：
1. 首条消息能看到 MCP 工具（时序竞态已修复）
2. MCP 服务器 reload 后工具列表更新
3. tool_search 能发现 MCP 工具
4. App Connection 工具正常

---

## 风险与约束

1. **providerName allocation 一致性**：list_changed 增量更新时，必须用与 init 相同的 allocator seed（catalog 中所有非 mcp + 其他 mcp 服务器的工具名），否则 providerName 会漂移。
2. **executor 闭包绑定**：MCP executor 闭包捕获 capturedClient，list_changed 后工具定义变了但 client 不变，需确保新 executor 仍指向同一 client。
3. **原子性**：replaceByServer 必须保留 validate-then-commit 语义。
4. **tool_search 可见性**：catalog 长驻后，tool_search 的 searchFn 必须看到当前 catalog 状态（含 list_changed 后的更新）。
5. **不破坏 orchestrator/subagent 路径**：options.toolRegistry 分支保留，允许传入自定义 registry。
