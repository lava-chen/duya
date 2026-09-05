# 480 — 追加式 Tool Schema 目录（Grok 式：tools 数组恒定，schema 走侧信道 + Meta 工具调用）

> **Status**: Planning · **Priority**: P1 · **Owner**: TBD
> **总纲**: [473-grok-bot-framework-overview](./473-grok-bot-framework-overview.md)
> **关联**: plan 241（tool_search 元工具，已完成——但其"动态 schema 注入下一轮全量注入"正是本 plan 要替换的形态）、plan 418（Deferred Tools / tool_reference，Phase 1-5 完成——传输层能力，与本 plan 正交）
> **参考源码**：grok-bot `source/host/runner/tools/mcp-meta-tools.ts`、`source/packages/agent/tools/mcp/builtin-tools.ts`（`DynamicToolRegistry`）、`turn-toolset.ts:1306-1531`
>
> **目标**：动态工具（MCP / 插件 / connector / 运行中新增工具）**永不进入请求的 tools 数组**——tools 数组逐字节稳定以保 KV cache 与计费；schema 改为**稳定排序的追加目录**（catalog），模型通过**固定不变的 meta 工具**完成"读 schema → 调用"。适用于一切动态来源，不止 bot。

---

## 1. 问题

现状两条路径都会在工具集变化时**修改 tools 数组**：

| 路径 | 现状 | 代价 |
|---|---|---|
| plan 241 tool_search | 搜索命中后"下一轮全量注入"命中工具的 schema 到 tools 数组 | 每次命中改变 tools 数组 → 整个前缀 KV cache 失效 + 重复计费 |
| MCP/插件启停 | 工具直接进出 tools 数组 | 同上；多 server 时数组频繁抖动 |
| 418 deferred tools | `tool_reference` 依赖端点能力（Anthropic 系），OpenAI 兼容端点无此形态 | 覆盖不全，需要 fallback |

grok 的答案（已核实）：**tools 数组只含固定基座工具**；动态工具 schema 装进 `McpDescriptor` 目录（`DynamicToolRegistry.replaceTools`，按名称稳定排序），随请求作为侧信道目录下发；模型先通过说明强制"读 schema"，再调用**名字恒定**的 invocation meta-tool，参数携带 `{namespace/server, toolName, args}`，registry 解析真实工具执行（`resolveToolName`）。

## 2. 设计

### 2.1 ToolSchemaCatalog（agent-core 新模块）

```ts
interface CatalogTool { name: string; description: string; inputSchema: JsonSchema }
interface CatalogNamespace { namespace: string; source: 'mcp' | 'plugin' | 'connector' | 'runtime'; tools: CatalogTool[] }
```

- **稳定序列化**：namespace 与 tool 均按名称排序、字段顺序确定——目录内容不变时序列化逐字节一致（cache 稳定的前提，单测覆盖）。
- 目录随请求下发（按 provider 选通道，见 2.3）；配额：目录总量字符预算（默认 16k），超预算按 server 优先级裁剪并告警。
- `resolve(namespace, toolName) → executor`；目录与执行器同源注册，杜绝 schema/执行漂移（注册即绑定）。

### 2.2 两个恒定 meta 工具

| 工具 | 参数 | 行为 |
|---|---|---|
| `tool_schema` | `{namespace?, tool?}` | 返回目录条目的完整 JSON Schema（省略参数返回目录概览）；prompt 明示"调用前必须先读 schema"（对齐 grok `You MUST read the tool schemas before calling them`） |
| `tool_invoke` | `{namespace, tool, arguments}` | 解析真实工具 → 权限检查（按真实工具的 permission 规则走 419 决策总线）→ 执行 → 结果按该工具的渲染形态回传 |

- meta 工具**永远**在基座 tools 数组里（两个名字恒定、schema 恒定）——动态性全部收敛到参数层。
- 错误面：namespace/tool 不存在、schema 校验失败、目标工具被禁用 → 结构化错误（含可用项列表），不静默。

### 2.3 目录下发通道（按 provider 能力选择）

1. **Anthropic 系**：优先 418 `tool_reference`（若端点支持）；
2. **通用（grok 式）**：目录渲染为独立的 budgeted **system section**（复用 474 section 框架与 `SectionBudget`，位置固定在工具说明区之后）——不碰 tools 数组、不碰消息历史，cache 只受目录自身变化影响；
3. **fallback**：目录为空或端点异常时退回现行为（全量数组），行为等价今天。

模式选择进 `ModelCompat` 能力声明（对齐 418 的能力驱动哲学）。

### 2.4 与 241/418 的关系（收敛，不并存三套）

- 241 的 `tool_search` **保留为发现入口**，但命中后不再"下一轮注入 tools 数组"，改为把命中工具**挂入目录**（下一轮模型经 `tool_schema` 读取）。
- 418 保留为传输层形态（tool_reference 回传/降级）；480 的目录是**工具暴露层**。两者关系记录决策：暴露层决定"schema 在哪"，传输层决定"tool_use/result 怎么序列化"。
- MCP/插件/connector 的动态工具默认走目录；仅白名单高频工具（各 PromptSystem 显式声明）进基座数组。

## 3. 分阶段实施

### Phase 1 — 目录核心
- [ ] **P1.1** `ToolSchemaCatalog` 数据结构 + 稳定序列化（逐字节 diff 单测）+ resolve/注册绑定 + 单测。
- [ ] **P1.2** 预算裁剪 + 溢出告警 + 单测。

### Phase 2 — Meta 工具
- [ ] **P2.1** `tool_schema` / `tool_invoke` 实现（含 schema 校验、不存在/禁用结构化错误）+ 单测。
- [ ] **P2.2** 权限接线：invoke 前按真实工具规则走 419 决策总线（e2e：禁用工具的 invoke 被拒）。

### Phase 3 — Provider 接线
- [ ] **P3.1** 目录 system section 渲染（通道 2）+ ModelCompat 模式选择 + 418 tool_reference 优先分支。
- [ ] **P3.2** 241 收编：tool_search 命中 → 挂目录；删除"下一轮全量注入"路径。
- [ ] **P3.3** MCP/插件/connector 动态工具迁移到目录 + 高频白名单机制。

### 验收
- [ ] e2e：会话中途启用一个 MCP server——tools 数组逐字节不变，`tool_schema` 可读到新工具，`tool_invoke` 成功执行且权限生效。
- [ ] cache 验证：多轮对话 usage 中 cache read 命中率不因目录工具启停下降（对照 444 的 cache-stats）。
- [ ] `npm run typecheck:all` 全绿。

## 4. 非目标 / 风险

- 非目标：不改变静态基座工具的注册方式；不做服务端原生工具目录（Anthropic server tools 仍走 440）。
- 风险：模型不读 schema 直接 invoke → prompt 硬约束 + invoke 时 schema 校验失败给可恢复错误（附 schema 摘要）。
- 风险：目录变大后 system section 挤占预算 → 总预算 + 裁剪 + 高频白名单三重控制。
- 风险：权限旁路（以为在调 meta 工具）→ 权限检查按**解析后的真实工具**执行（P2.2 e2e 覆盖）。

---

## 6. 可行性审计修正（2026-09-02 逐行核实代码后）

1. **已有目录原型，P1 从扩展开始而非从零建**：`packages/agent/src/mcp/capability-catalog.ts` 的 `buildMCPCapabilityCatalog` 已存在，挂在 `_buildSystemPrompt`（`DuyaAgent.ts:2934-2944`）每次重拼。P1.1 的"稳定序列化"直接在该函数上补确定性排序与逐字节 diff 测试。
2. **最大风险修正：system 尾部追加 catalog 会令全部 cache 断点失效**。证据：system 为单拼接字符串，cache_control 打第一块（`packages/ai/src/utils/prompt-caching.ts:356-389`，`anthropic-messages.ts:1866-1871`）；messages 断点打最后 3 条、MESSAGE_BREAKPOINT_BUDGET=3 为 system 预留 1 槽（`prompt-caching.ts:49,291-338`）。Anthropic 缓存是前缀式——catalog 变化 → system 字符串变 → **system + 全部 messages 断点连带 miss**（不是断点数量问题，是前缀失效问题）。**前置任务 P0.0**：`applyCacheControlToSystem` 改为多 block 数组方案（稳定前缀 block 打标记，catalog 放后续不打标记的 block；该函数 :380-386 只标记 first block 的实现恰好可平滑扩展）。P3.1 依赖 P0.0。
3. **241 收编的精确改动点**（替换原 §2.4 的笼统描述）：`discoveredTools` Set（`DuyaAgent.ts:1069`）→ turn 循环合并块 `tools = [...tools, def]`（:1124-1147）→ `harvestDiscoveredTools`（:1961）。收编 = 命中后写入 catalog registry 而非并入 tools。
4. **tools 数组稳定性已证实**：`sortToolsByName`（`packages/ai/src/utils/tool-order.ts:17-19`，字节序）在 `anthropic-messages.ts:1842` 应用；同 registry snapshot（`DuyaAgent.ts:2817`）+ 排序 → 无变化时逐字节一致。**tools 数组当前无 cache_control**（:1842-1846）——P3.1 可选为其加断点（tools 是所有请求的最长公共前缀，收益大）。
5. **ModelCompat 扩展点更正**：`packages/ai/src/types.ts:424-461`（非 302）；新增 `toolExposureMode: 'full' | 'deferred' | 'catalog'`，参照 `supportsToolReferences`（:442）的接线方式。
6. **执行侧事实**：MCP schema 与执行都在 agent-core（`activeMCPRegistry`，`DuyaAgent.ts:2753-2867`；agent-process-entry 只做 replaceByOwner 注入）——`tool_invoke` 的 resolve→权限→执行全部可留 agent-core，无需跨进程。

---

## 7. Grok 源码核实与方案修正（2026-09-02 二次审计）

逐行读了 grok-bot 三处真源：`source/host/runner/tools/mcp-meta-tools.ts`、`source/packages/agent/tools/mcp/builtin-tools.ts`、`source/host/runner/tools/turn-toolset.ts`（812-848 / 1306-1320）、`source/packages/agent/prompts/user-info-mcp-catalog.ts`、`user-info-mcp-meta-instructions.ts`、`prompts/shared.ts:188-205`。**原 §2 三处假设与 grok 实际不符，一处 duya 既有资产被漏掉。修正如下。**

### 7.1 grok 侧核实结论

| # | 结论 | 证据 |
|---|---|---|
| G1 | **目录下发的是「名字清单」，不是 schema**。`McpMetaToolServerList` 只渲染 `<mcp_meta_tool_server name="x" tools="a, b, c" />`；完整 schema 由 discovery 工具按需返回 | `user-info-mcp-catalog.ts:23-55`；`McpMetaToolInstructions` 只吃 `McpMetaToolServerList` 的输出（`user-info-mcp-meta-instructions.ts:90-100`） |
| G2 | descriptor **对象**带 `inputSchema`（内存），但**渲染**只取名字 → 「内存有 schema、提示词只有名字」是刻意的二层设计 | `turn-toolset.ts:833-839`（塞 schema）、`builtin-tools.ts:92-99` |
| G3 | meta 工具真名 `GetMcpTools` / `CallMcpTool`（+ `FetchMcpResource` / `ListMcpResources`）；discovery **4 模式**：`{server}` / `{server,toolName}` / `{pattern}`（RE2，无 backreference/lookahead）/ 无参全目录 | `user-info-mcp-meta-instructions.ts:71-76`；`user-info-component.ts:175-176` |
| G4 | **截断契约**：pattern 与全目录结果截断长描述，尾部固定 `"... [truncated]"`；server / 单工具查询返回完整描述 | `user-info-mcp-meta-instructions.ts:5,51,78` |
| G5 | 「必须先读 schema」的硬约束挂在**命名空间**的 `serverUseInstructions` 上，不是全局一句 | `builtin-tools.ts:32-41`（`You MUST read the tool schemas before calling them.`） |
| G6 | **缓存守卫**：`userInfoMatchesDynamicToolSnapshot(content, opts)` 拿本次渲染结果与上次 system content 做**字符串比对**，一致则视为快照未变 | `prompts/shared.ts:188-205` |
| G7 | **warming 态**：`mcpInfoComplete === false` 时目录段加一句"可能不完整"，而非留空或阻塞 | `user-info-mcp-catalog.ts:101-105` |
| G8 | **目录层过滤**：`filterProjectWorkspaceMutationMcpDescriptors` 在渲染前按模式/权限剔除条目（权限是双保险，不是只靠 invoke 时拦） | `user-info-mcp-catalog.ts:65-75`；接线在 `user-info-component.ts:170` |
| G9 | 超时按**解析后的真实工具名**计算；`directToolRecovery` 保留静态工具名集合作为动态工具失效时的恢复路径 | `mcp-meta-tools.ts:77-89`；`builtin-tools.ts:58-61,74` |

### 7.2 duya 侧补充发现（原 §6 未覆盖，但决定实现方式）

| # | 发现 | 位置 |
|---|---|---|
| D1 | **已有暴露模型** `ExposeMode = 'always' \| 'discoverable' \| 'internal'`，`isToolVisible(name, exposeMode, discovered, constraints)` 已按模式决定是否进 tools 数组。plan 全文未提——收编 241 的本质是动这个枚举 | `tool/registry.ts:57`；`agent-profile/ToolFilter.ts:67-86` |
| D2 | **`ToolSnapshot` 已经是 grok 的 `DynamicToolRegistry`**：同时打包 `tools[]`（含完整 `input_schema`）、`getExecutor`、`getExposeMode`、`getMeta`。**不需要新建 registry**——schema 与执行器本就同源，§2.1 第 3 点「杜绝 schema/执行漂移」天然满足 | `tool/registry.ts:382-410` |
| D3 | **namespace 现成**：`Tool.mcpInfo = { serverName, toolName, source: 'bundled'\|'plugin'\|'local'\|'settings'\|'unknown' }`，即 grok 的 `serverIdentifier` + `source` | `types.ts:111-123` |
| D4 | **现有目录形态已与 grok 一致**：`buildMCPCapabilityCatalog` 只输出「server 名 + 工具名」，带 `MAX_SERVERS=12` / `MAX_TOOL_NAMES_PER_SERVER=4` 上限——它已经是 G1 的正确形态 | `mcp/capability-catalog.ts:41-83` |
| D5 | **现状矛盾（本 plan 真正要解决的痛点）**：MCP 工具 `exposeMode` 默认 `always` → schema **全量进 tools 数组**；同时 system prompt 里还挂着 D4 的名字目录。**既付了数组代价又付了目录代价，重复。** 收编的收益正是去掉这一半 | `registry.ts:435-438` 注释明确保留 MCP 的 `always` 行为；`DuyaAgent.ts:2935-2944` 挂目录 |
| D6 | 权限入口现成：`hasPermissionsToUseTool(toolName, input, ctx)`，前面还有 riskTier gate（fail-closed）。`tool_invoke` 直接传解析后真名调用即可 | `DuyaAgent.ts:3065-3085` |
| D7 | `applyCacheControlToSystem` 在数组形态下只标记 `first`（`:380-386`），确认可平滑扩为多 block | 已复核，与 §6.2 一致 |

### 7.3 对 §2 / §3 的修正

**修正 1（最重要）—— 目录不装 `inputSchema`，预算从 16k 降到 2–4k。**
原 §2.1 的 `CatalogTool { name, description, inputSchema }` + 16k 预算 = 把全量 schema 塞进 system，与 G1/G2 相反，也与 D4 相反，且 16k 打在缓存前缀上代价极高。改为：

> 目录 = **namespace + 工具名**（+ 可截断的短描述），稳定排序，预算 2–4k；完整 `input_schema` 只在 `tool_schema` 调用时返回。

这条同时**大幅缓解 §6.2 的 X2**：目录体积与变化频率都降一个量级。P0.0（system 多 block）仍然要做，但不再是 P3.1 的硬阻塞，可并行。

**修正 2 —— `ToolSchemaCatalog` 从「registry」降级为「渲染器」。**
不新建注册中心。它是 `ToolSnapshot` → 稳定字符串 的**纯函数模块**（扩展 D4 的 `buildMCPCapabilityCatalog`），`resolve(namespace, tool)` 直接调 `snapshot.getExecutor(name)`（D2）。注册/执行同源由现有 snapshot 保证，不需要额外机制。

**修正 3 —— namespace 复用 `mcpInfo`。**
不另起 `source: 'mcp'|'plugin'|'connector'|'runtime'`，直接用 `mcpInfo.serverName`；`mcpInfo.source` 扩展（补 `connector`）。无 `mcpInfo` 的 discoverable 内置工具归入保留命名空间 `builtin`（对应 grok 的 `cursor` 保留命名空间，`builtin-tools.ts:101,108-110`）。

**修正 4 —— `tool_schema` 补 pattern 模式，与 241 合而非并存。**
原 §2.2 的 `{namespace?, tool?}` 缺 G3 的模式 3/4。改为四模式（namespace / namespace+tool / pattern / 无参），pattern 能力直接吃 241 `ToolSearchTool` 的 `searchFn`（`ToolSearchTool.ts:32-34`），241 的 `tool_search` 收编为 `tool_schema` 的 pattern 别称，最终只留一个发现入口。

**修正 5 —— 补上 grok 有而本 plan 缺的四个机制。**
- G4 截断契约：定义 `TRUNCATED_DESCRIPTION_SUFFIX = '... [truncated]'`，让模型知道"看到截断就要再取一次完整 schema"（否则它拿截断描述去 invoke）。
- G5 强制读 schema 挂在 namespace 的 `useInstructions` 上，而非全局一句。
- G7 warming 态：MCP 异步连接期间目录标注"可能不完整"（duya MCP 连接本就异步，此态必现）。
- G8 目录层过滤：渲染前按 profile/mode/权限剔除，与 invoke 时的 419 决策总线构成双保险。
- G9 超时按解析后的真实工具名计算。

**修正 6 —— `ExposeMode` 增 `'catalog'`，走四态过渡而非直接改 `discoverable`。**
`discoverable` 已有既有使用方（`ImageGenerateTool/__tests__/discoverability.test.ts`）。新增 `'catalog'` 与旧路径并存 → Phase 3 迁移 → Phase 4 删除 `discoverable` 收回三态（`always` / `catalog` / `internal`）。满足 §2.4「收敛，不并存三套」的最终态，同时可灰度。

### 7.4 修订后的实施顺序

> 依赖变化：P0.0 由「P3.1 的硬前置」降为「并行项」（修正 1 的结果）。

| 阶段 | 任务 |
|---|---|
| **P0.0**（并行） | `applyCacheControlToSystem` 改多 block 数组：稳定前缀 block 打标记，catalog 放后续不打标记的 block（`prompt-caching.ts:380-386`）。顺带给 tools 数组加断点——tools 是所有请求的最长公共前缀，收益最大 |
| **P1 目录渲染**（纯函数 + 单测） | P1.1 `buildToolCatalog(snapshot)`：按 `mcpInfo.serverName` 分组、namespace 与工具名双重稳定排序、只出名字、2–4k 预算裁剪；**与现有 `buildMCPCapabilityCatalog` 合并而非并存**（两处调用：`DuyaAgent.ts:2935`、`agent-shell.ts:183`）<br>P1.2 逐字节稳定单测：同 snapshot 两次渲染严格相等；插入顺序打乱不影响输出<br>P1.3 warming 态 + 目录层过滤钩子（修正 5 的 G7/G8） |
| **P2 meta 工具** | P2.1 `tool_schema` 四模式 + 截断后缀契约（G3/G4）<br>P2.2 `tool_invoke`：resolve → `hasPermissionsToUseTool(真名, args)`（D6）→ 执行 → 超时按真名（G9）；不存在/禁用/校验失败给结构化错误含可用项<br>P2.3 收编 241：`discoveredTools` → 写 catalog 视图而非并入 tools；删除 turn 循环注入块（`DuyaAgent.ts:1124-1147`）与相关 `harvestDiscoveredTools` 语义 |
| **P3 暴露接线** | P3.1 `ExposeMode` 加 `'catalog'` + `isToolVisible` 适配（`ToolFilter.ts:74-75`）<br>P3.2 MCP/插件/connector 默认改 `catalog`（去掉 D5 的重复计费）；高频白名单显式保留 `always`<br>P3.3 `ModelCompat.toolExposureMode: 'full'\|'deferred'\|'catalog'`（`types.ts:424-461`，仿 `supportsToolReferences`）+ 418 tool_reference 优先分支 + fallback |
| **P4 收敛** | 删除 `discoverable` 模式与旧注入路径，收回三态 |

### 7.5 验收补充

- [ ] 目录字符串在 MCP 未启停的多轮之间**逐字节一致**（新增，对应修正 1 的核心主张）。
- [ ] MCP 中途启用：tools 数组逐字节不变、`tool_schema` 可读到新工具、`tool_invoke` 成功且权限生效（原验收保留）。
- [ ] e2e：`discoverable` 内置工具（如 `image_generate`）走 `builtin` 命名空间可被发现并调用（覆盖修正 3）。
- [ ] 权限 e2e：被 profile 过滤的工具**不出现在目录里**，且直接 `tool_invoke` 也被拒（双保险，覆盖 G8）。
- [ ] `npm run typecheck:all` 全绿；`capability-catalog.test.ts` 迁移覆盖新模块。

---

## 8. 对抗性自查与工程补强（2026-09-02 第三次追加，开工前最后一块拼图）

对照 grok 真源与 duya 执行链逐行核实，**§7 修正仍缺一块决定成败的地基**：duya 的执行 harness 与 grok 有根本差异——grok 的强约束靠**自家端点拒绝未声明工具**，duya 没有这道墙，必须自建。以下五条差距全部落档，其中缺口 1 是本 plan 从「机制正确」到「效果与 grok 相当」的必要条件。

### 8.1 grok 的 per-tool 精简提示（用户点名的那"一行 hint"）

grok 每个工具有两层精简提示，辅助模型**决定该读谁的 schema**（不进目录渲染，`GetMcpTools` 返回时可见）：

| grok 机制 | 内容 | 证据 |
|---|---|---|
| `descriptionGenerator(props, { promptVisible: false })` | 按当前工具集动态生成的精简描述（可引用其他工具名）；塞进 `McpDescriptor.tools[].description` | `builtin-tools.ts:90-99`（`resolveToolDescription`）；实例见 `shell/create-shell-tool.ts:688`、`core/web-search.ts:320` |
| `contextType.conciseStaticContext` | 仅 `type: 'dynamic'` 工具，一行静态提示；渲染为 `- 工具名: 一句话` | `tools/core.ts:29-32`；`builtin-tools.ts:34-40` |

duya 对应物 `inputSchemaSummary` 现状**两极分化**：
- `image_generate` 有真 hint：`'prompt (required), size, quality, reference_image, output_path'`（`tool/builtin.ts:169`）——**这是目标形态**。
- MCP 工具是占位废句：`'Input schema from the connected MCP server.'`（`mcp/apply.ts:567`）——**必须替换**，否则模型面对目录几十个名字无从判断，要么全读（discovery 开销爆炸）要么不读（瞎编参数）。

现成可复用的生成先例（不用发明）：`AppConnectionTool` 的预算截断 + hint 组合（`tool/AppConnectionTool/index.ts:226` 的 `[Schema truncated: ... use <hint>]`）+ `spec-budget.ts` 的 `downgradeToolSchemaForBudget`。

### 8.2 五条差距清单

| # | 差距 | 严重度 | 证据 | 对策 |
|---|---|---|---|---|
| GAP-1 | **执行层无可见性守卫**：目录式后模型直调真名仍会执行成功，绕过 `tool_schema` | 🔴 决定成败 | `DuyaAgent.ts:3189` `toolRegistry = this.activeMCPRegistry`（常驻全量，注释 :317 "long-lived ToolCatalog"）；executor 宽容执行任何注册工具，找不到才回 "Tool not found"（`StreamingToolExecutor.ts:1649-1653`）；ai 层无 tool_use name 声明校验 | §8.3 自建守卫，灰度两段式 |
| GAP-2 | MCP per-tool hint 缺失（§8.1） | 🟠 效果 | `mcp/apply.ts:567` 废句 | hint 生成器：从 `input_schema` 的 `required + properties` 键提取参数名列表（对齐 `builtin.ts:169` 形态）；超预算走 `spec-budget` 截断（对齐 AppConnectionTool） |
| GAP-3 | UI/审批全显示 `tool_invoke` 一张脸 | 🟠 体验/审批 | renderer 工具卡片、tool approval、审计以 tool_use name 为主键 | 前端/日志按 grok `agent-adapters.ts:46` `resolveToolName(phase, callId, fallback)` 模式，解析 `tool_invoke` 参数回真名再渲染；解析器可复用 `StreamingToolExecutor.ts:581` `resolveMCPProviderToolName` 同款 |
| GAP-4 | discovery 多一轮 RTT；压缩后 schema 被摘要 → 周期性重新 discovery | 🟠 成本 | grok 自述 "Aim to minimize round-trips: ideally one discovery followed by one invocation"（`user-info-mcp-meta-instructions.ts:39,67`） | 接受 + 明确测试场景（§8.5 加长会话 e2e）；不设会话内 schema 缓存层（与 grok 同策略：schema 可再生，靠上下文复用） |
| GAP-5 | `'catalog'` 与既有 `on_demand_discovery` 开关并存，两套配置语义 | 🟡 收编 | `config/tool-exposure.ts:35` 默认 `false`；`mcp/apply.ts:566` | §8.4 合并演进：开关改为三值，不另起配置项 |

### 8.3 GAP-1 对策：执行层可见性守卫（本 plan 新增硬需求）

**目标**：模拟 grok 自家端点的"未声明工具即失败"，把模型行为钳到 `tool_schema → tool_invoke` 通道上。

**位置**：`StreamingToolExecutor` 执行入口（`DuyaAgent` turn 循环取到 tool_use 后的 dispatch 点，~`DuyaAgent.ts:1961` `harvestDiscoveredTools` 同层）。

**规则**：对本轮 `tool_use` 名做三段判定——

1. `meta 工具`（`tool_schema` / `tool_invoke` / `tool_search`）：放行。
2. `本轮 tools 数组已声明`（即 `always` 或白名单）：按现路径执行，零变化。
3. 其余（`catalog` / `discoverable` 工具被直调）：**结构化拒绝**，返回：
   `工具 <真名> 未在本轮工具列表中。请先调用 tool_schema({namespace, tool}) 读取其 schema，再经 tool_invoke 调用。`
   拒绝内容进 tool_result 回给模型（不吞、不静默），模型据此自纠——这同时覆盖 §4「模型不读 schema 直接 invoke」风险的一条新路径。

**灰度两段式**（避免一次性收紧打断现有 `discoverable` 用户）：
- Phase 2 附带：`warn-only`（执行并记日志，统计直调率/遵从率，不拦截）——量化 GAP-4 与模型遵从基线。
- Phase 3：切 `enforce`（拦截）。开关随 `ModelCompat.toolExposureMode` 联动：`'full'` 模式（未启用目录）永远不拦截（兼容现状）。

**边界**：`resolveMCPProviderToolName` 解析后的内部名参与判定（对齐 `StreamingToolExecutor.ts:574-583`）；`internal` 工具维持现行为（registry 层已挡）。守卫只挡"存在但本轮未声明"的工具，不改变 registry 注册本身。

### 8.4 GAP-5 对策：`ExposeMode` 与 `on_demand_discovery` 合并演进

现状配置是布尔 `[tools] on_demand_discovery`（`config/tool-exposure.ts`）。480 的 `'catalog'` **不另起新配置**，把布尔升级为三值（保持向后兼容，`true` ≈ `catalog` 旧称）：

```toml
# config.toml — 合并后的工具暴露配置（默认 full）
[tools]
# exposure = "full"    # MCP schema 全量进 tools 数组（今天的行为）
# exposure = "catalog" # MCP 走目录 + tool_schema/tool_invoke（本 plan 目标态）
# exposure = "search"  # 旧 on_demand_discovery=true 的 discoverable 行为（过渡期）
exposure = "full"
```

映射：`always` ⊂ `full`；`'catalog'` = 目录式；`discoverable` 过渡期保留在 `search`。P4 收敛后 `search` 删除、配置收回 `full | catalog` 两值。`DUYA_TOOLS_ON_DEMAND_DISCOVERY` env 与代码内 `onDemandDiscovery` 字段一并迁移，避免两套语义并存。

### 8.5 对 §7.4 阶段的增补

| 阶段 | 新增任务 |
|---|---|
| **P1** | P1.4 MCP per-tool hint 生成器：`input_schema → 参数名列表`（对齐 `builtin.ts:169`），替换 `apply.ts:567` 废句；超预算走 `spec-budget`（GAP-2） |
| **P2** | P2.4 可见性守卫 `warn-only` 版 + 直调率统计日志（GAP-1 灰度前半）；P2.5 守卫 `enforce` 版 + 结构化拒绝消息 + 单测（含：catalog 工具直调被拒、always 工具不受影响） |
| **P3** | P3.4 `exposure` 三值配置替换 `on_demand_discovery`（§8.4）；P3.5 UI/日志真名解析：`tool_invoke` 参数回显真实工具名（GAP-3，前端 + 审计双处） |
| **P4** | P4.2 删除 `discoverable`/`search` 路径（含 `isToolVisible` 中 `discovered.has` 分支），配置收回两值 |

### 8.6 验收补充（§7.5 之外）

- [ ] **守卫 e2e（新）**：MCP 工具切 `catalog` 后，模型直调真名 → 收到结构化拒绝（含"先 tool_schema 后 tool_invoke"指引）而非执行；经 `tool_invoke` 调用则成功。切换 `warn-only` 时直调可执行且日志有计数。
- [ ] **hint e2e（新）**：`tool_schema({namespace})` 返回的每工具条目带非空 hint（参数名列表形态），不是 `'Input schema from the connected MCP server.'` 废句。
- [ ] **长会话（新，GAP-4）**：30+ 轮对话经历一次压缩后，模型仍能经 `tool_schema` 重新取到 schema 并成功 `tool_invoke`（验证"可再生、无需持久化"的压缩无关性主张）。
- [ ] UI：MCP 工具调用卡片显示真实工具名（如 `mcp_github__create_issue`），非 `tool_invoke`（GAP-3）。
- [ ] 兼容回归：`exposure = "full"`（默认）下全量注入行为与今天逐字节一致，守卫不拦截（P2.5 边界）。
- [ ] `npm run typecheck:all` 全绿。

### 8.7 效果结论（对齐用户的"能否与 bot 同效"提问）

- **高缓存命中**：结构性保证（tools 恒定 + P0.0 多 block），可信。
- **强 harness**：等价 grok 的前提是 **§8.3 守卫落地**。grok 的强约束来自自家端点拒绝；duya 无此墙，守卫即替代品。灰度期数据（P2.4 直调率）是判断"提示词约束是否足够"的量化依据——若遵从率高可维持 warn-only 减复杂度；否则 enforce 必须上。
- 五条差距全部有现成落点，无架构性阻碍；开工顺序建议：**P0.0 ∥ P1（含 P1.4 hint）→ P2（含守卫）→ P3 → P4**。

### 8.8 P0.1 完成记录（2026-09-02，tools 断点 + 预算联动）

**侦察修正**：P0.0 原假设"ai 层改 `applyCacheControlToSystem` 即可"被推翻——该函数数组分支**本就正确**（只标 first = 稳定主体断点），ai 层真正的缺口是 **tools 数组无断点**；而"上游把 system 拼成数组"（稳定块 + catalog 动态块分离）依赖 474 的 section 化产出，无法在 ai 层独立完成。故 P0 拆为：**P0.1（本次完成，ai 层独立可测）** + **P0.2（挂 474，agent 侧 system 数组化）**。

**已落地（P0.1）**：
- `packages/ai/src/utils/prompt-caching.ts`：新增 `applyCacheControlToTools<T>()`（deep clone，**最后一个 tool** 打 `cache_control`；ineligible/空数组返回原样）；`applyCacheControl` 增加可选 `CacheBudgetOptions { toolsBreakpoint?: boolean }`——reservedSlots = system(1) + tools(条件 1)，messages 预算 = `max(0, maxBreakpoints - reserved)`；默认（不传 options）与旧行为逐字节一致。
- `packages/ai/src/api/anthropic-messages.ts`：主路径判定 `toolsCacheBreakpoint = eligible && nativeLayout && toolsPresent && transport !== 'none'`（**MiniMax 等兼容端点 nativeLayout=false 自动排除**）；`applyCacheControl` 传 `{ toolsBreakpoint }`；`splitDeferredTools` 后构造 `toolsForRequest = applyCacheControlToTools(requestTools)`，替换 params/retryParams 两处 `tools` 字段。
- `providers/wrappers/anthropic-family-cache-control.ts`：re-export 新增两符号。
- 测试：`prompt-caching.test.ts` 20 项全绿（新增 14 项：tools 末位打标/不 mutate/ineligible/空数组/1h TTL；预算联动 messages≤2、默认 3 不变）；anthropic-robustness(49) + cache-control wrapper(7) + tool-payload-compat(14) 共 70 项回归全绿；`tsc --noEmit` 通过。

**缓存语义依据**（落档防回归）：Anthropic 前缀缓存断点 = "内容块末尾"；tools 定义支持 `cache_control`（SDK `Tool.cache_control`，已核实）。布局 = system(1) + tools(1) + messages(≤2) ≤ 4。tools 数组同 registry 快照 + `sortToolsByName` → 跨轮逐字节一致 → 断点稳定。**注意**：catalog 若留在 system 尾部，其变化会击穿其后（tools/messages）断点；多 block 数组化（P0.2）后 system 稳定主体断点仍命中——这是 P0.2 必须与 480 目录落地配对的原因。

**待办（P0.2，依赖 474）**：agent 侧把 system 从单字符串升级为"稳定主体 + 尾部动态段"的有序数组，贯穿 `_buildSystemPrompt → applyModes → llmClient`，使 catalog/apps/discovered 后缀可放独立无标 block。

### 8.9 P1 完成记录（2026-09-02，目录渲染纯函数 + per-tool hint）

**已落地**：
- `packages/agent/src/mcp/capability-catalog.ts` 重构（保持导出名 `buildMCPCapabilityCatalog(tools, opts?)` 兼容两处调用点 `DuyaAgent.ts:2935` / `agent-shell.ts:183`）：
  - **确定性修复**：server 内工具名现在按字节序排序（此前按注册序 push，Map 插入序会泄漏进渲染串 → 违反逐字节稳定，正是 P1.2 要抓的缺陷）。
  - 新 `ToolCatalogOptions`：`maxServers`(12)/`maxToolsPerServer`(4)/`maxTotalChars`(4096 默认)/`incomplete`(warming 标注，grok `mcpInfoComplete` 对应物)。
  - 字符预算按**行间**截断（绝不断行内），被截 server 计入 omitted 行；"每 server 工具名超限"时附加一行 `tool_schema` 使用指引占位（P2 落地后生效）。
  - 尾行指引在 P1 保持 `tool_search`（`tool_schema` 未实现前不让模型调用不存在的工具）。
- `packages/agent/src/mcp/tool-hint.ts`（新模块）：`buildToolHintFromSchema(schema, maxArgs=8)` —— 从 JSON Schema 提取 `properties` 键 + `required` 标注，输出与内置 `image_generate` hint 同形态（`prompt (required), size, output_path`）；无 properties/裸型/空 → `''`；标签清洗换行反引号制表符。
- `packages/agent/src/mcp/apply.ts`：MCP 注册 `meta.inputSchemaSummary` 与 `downgradeToolSchemaForBudget` 的 summary 由废句替换为 hint（schema 降级**前**提取，截断后仍保留原参数列表）。tool_search 结果（`ToolSearchTool.ts:74` 的 `**Input summary:**`）随即免费受益。

**验证**：`capability-catalog.test.ts` 13 项全绿（原 2 项 + 新增：乱序输入逐字节一致 / server 内排序 / per-server cap / 字符预算截断含 omitted / warming 标注 / maxServers / hint 5 项）；MCP 目录测试 5 文件 70 项通过；`tsc --noEmit`（packages/agent）通过。`cli-control-plane/mcp.test.ts` 失败为 seed-db 环境问题（需 electron 运行时），与本次无关。
**测试迁移**：原"按注册序输出"断言（pin 缺陷行为）已更新为排序后顺序，符合 §8.6"capability-catalog.test.ts 迁移覆盖新模块"。
**未做（留给后续阶段）**：调用点传 `incomplete`/预算参数（等 474 section 挂载 + MCP 连接状态可观测后接线）；hint 接 `tool_schema` 返回体（P2.1）。

### 8.10 P2.1 完成记录（2026-09-02，tool_schema / tool_invoke meta 工具）

**已落地**：
- `packages/agent/src/tool/ToolSchemaTool/ToolSchemaTool.ts`（新）：`tool_schema` 四模式——`{namespace}` 全量 / `{namespace,tool}` 单工具 / `{pattern}` 跨 namespace+工具名正则搜索（RE2 提示，非法正则结构化错误）/ 无参全目录。截断契约落档：概览与 pattern 结果长描述截断至 200 字符 + `TRUNCATED_DESCRIPTION_SUFFIX = '... [truncated]'`；schema JSON 单工具上限 24k + `'... [schema truncated]'`。结构化错误面：未知 namespace 含可用列表、未知 tool 含该 ns 可用列表、pattern 无匹配（非错误）、参数冲突、tool 无 namespace。
- `packages/agent/src/tool/ToolInvokeTool/ToolInvokeTool.ts`（新）：`tool_invoke` `{namespace, tool, arguments}`，参数校验（缺一即错）、未接 dispatcher → not configured、dispatcher 异常捕获为结构化错误、error 结果透传（成功不带 error 字段，对齐 tool_search）。
- 契约即注入点：`ToolSchemaCatalogProvider` / `ToolInvokeDispatcher` 都是注入接口——工具体零 registry 耦合，单测用 fake 注入；权限/执行接线留 P2.2。
- `packages/agent/src/tool/ToolSchemaTool/catalogFromRegistry.ts`（新）：`createToolSchemaProviderFromRegistry(registry)` —— 从 ToolRegistry 过滤 `owner==='mcp'`，按 `mcpInfo.serverName` 分组，namespace 与 tools 双重字节序排序（发现面逐字节稳定）；schema 用注册 definition 的 input_schema（与请求序列化同源，含 spec-budget 降级语义，诚实）。
- `packages/agent/src/tool/builtin.ts`：注册两个 meta 工具（`exposeMode: 'always'`，恒在 tools 数组——名字/签名恒定）。**行为变化提示**：每轮请求 tools 数组自本次起新增这两个工具。
- 注入三处（对齐 `toolSearchTool.setSearchFn`）：`DuyaAgent.streamChat` / `DuyaAgent._dispatchOrchestratorMode` / `agent-shell.dispatchOrchestratorMode`。`tool_invoke` dispatcher 未注入（P2.2 权限接线后接），现调返回 not configured（tool_search 同款先例，无害）。

**验证**：`plan480-meta-tools.test.ts` 16 项全绿（tool_schema：未配置/四模式/未知 ns 含列表/未知 tool 含列表/无效 pattern/无匹配非错/参数冲突/截断契约/概览不泄 schema；tool_invoke：参数校验/未配置/委托透传/error 透传/异常捕获）；`discoverability.test.ts` 5 项、`registry-unregister.test.ts` 24 项回归过；`tsc --noEmit`（packages/agent）通过。`computer-use-mode.test.ts` 1 项失败为**预存断言漂移**（prompt 已改 markdown 标题 `# Computer Use Mode`，测试仍断言旧文案 `'Computer Use Mode Active'`），该文件不在本次改动集，与本 plan 无关。
**未做**：`tool_invoke` 的 resolve→权限（419 决策总线）→执行接线（P2.2，含守卫 §8.3 的 warn-only 起点）；`tool_schema` 目录追加 builtin 命名空间（P3，`ExposeMode` 迁移时）；241 收编（P2.3 后续）。

### 8.11 P2.2 完成记录（2026-09-02，tool_invoke 权限接线）

**已落地**：
- `packages/agent/src/tool/ToolInvokeTool/dispatcherFromRegistry.ts`（新）：`createToolInvokeDispatcherFromRegistry({ registry, checkPermission, workingDirectory })`。三段：① resolve（registry MCP 工具按 `mcpInfo.serverName/toolName` 匹配，与 tool_schema 同源——发现/执行零漂移）；② 权限（对**解析后真名**调注入的 checkPermission：allow 执行 / deny 结构化错误带 message / **ask 不执行**——交互式审批走 StreamingToolExecutor 通道，dispatcher 不伪造，模型收到明确"需用户批准"提示）；③ execute（`registry.getExecutor(真名)` 直接执行，与直调同一实现路径）。错误面：无 MCP 连接 / 未知 namespace 含可用列表 / 未知 tool 含该 ns 可用列表 / executor 异常。已知限制（落档）：permissionContext 未携带 MCP source 维度（gate 0 的 source 门不触发），MCP 工具经 tool_invoke 按通用链判定——source 上下文接线留 P2.5 守卫联动。
- `DuyaAgent.streamChat` 主路径注入（`permissionContext` 构造之后）：checkPermission 包装 `this.hasPermissionsToUseTool(真名, args, permissionContext)`（plan 487 host 门自然生效）。orchestrator / agent-shell 路径**暂不注入**（保持 not configured，P2.2 验收走主路径，减少破坏面）。
- 测试：`plan480-meta-tools.test.ts` 新增 7 项 → 共 23 项全绿（resolve+执行真 executor / deny 带 message / ask 不执行 / 未知 namespace 含列表 / 未知 tool 含列表 / 无 MCP 连接 / executor 异常）。**测试陷阱落档**：`ToolRegistry.register()` 强制 owner 'non-mcp'，MCP 工具必须 `registerWithKey(key, ...)`（默认 owner 'mcp'），否则 resolve 的 owner 过滤直接跳过。

**验证**：23 项测试全绿；我的代码零 tsc 错误。⚠️ agent 包 `tsc --noEmit` 当前因**用户并行重构中断**报红（`BackgroundTaskTool/WaitTasksTool.ts` 被删、`GetTaskOutputTool.ts` 导出 `DEFAULT_WAIT_TIMEOUT_MS` 被移除、`builtin.ts:320` 引用断裂）——与 P2.2 无关，等 plan 476/482 收尾恢复。（**2026-09-02 更新**：wait_tasks 回退已完整落地——`WaitTasksTool.ts` 删除、`GetTaskOutputTool` 快照化、`builtin.ts` 引用修复，agent 包 `tsc --incremental` 已恢复通过，dist 产物已同步。）
**至此 tool_schema → tool_invoke 闭环打通**：模型可经目录发现 MCP 工具 schema（只读）并经权限门执行；`exposure=full` 现状下与直调并存。
**未做**：P2.4 可见性守卫 warn-only（§8.3，直调率统计）；P2.3 收编 241（discoveredTools → catalog）；P3（ExposeMode 'catalog' 迁移 + builtin 命名空间 + exposure 三值配置 + UI 真名解析 + ModelCompat 通道选择）。

### 8.12 价值闭环切片 A+B 完成记录（2026-09-02，可灰度切换 exposure）

**A. exposure 三值配置（§8.4 落地）**：`config/tool-exposure.ts` 重写——`MCPExposureMode = 'full'|'search'|'catalog'` 主字段 + 旧 `onDemandDiscovery` 兼容镜像（=search）；解析优先级：`[tools] exposure` > 旧布尔 > env（`DUYA_TOOLS_EXPOSURE` 新键 > `DUYA_TOOLS_ON_DEMAND_DISCOVERY` 旧键）；`mcpExposureToExposeMode()` 映射 full→always / search→discoverable / catalog→catalog。`mcp/apply.ts:574` 接线。
**B. ExposeMode 'catalog'**：`registry.ts` 类型加 `'catalog'`；`ToolFilter.isToolVisible`：catalog **恒不进 tools 数组**（即使 discovered——schema 经 tool_schema 读、经 tool_invoke 调；discoverable 保留 241 旧行为至收编）。**目录引导**：`buildMCPCapabilityCatalog` 新增 `entryPoint: 'tool_search'|'tool_invoke'` 选项（catalog 模式尾行改为"call tool_schema … invoke with tool_invoke … never fabricate arguments"）；两处调用点（`DuyaAgent._buildSystemPrompt` / `agent-shell`）按 `readToolExposureConfig().exposure === 'catalog'` 传参。
**验证**：tool-exposure 测试 4 旧 + 8 新 = 12 全绿；capability-catalog 14（+1 entryPoint）全绿；discoverability 5 / ToolRegistry / ToolSearchTool / ToolSearchTool 全绿。
**至此用户可亲手灰度**：`config.toml [tools] exposure = "catalog"` → MCP schema 全部退出 tools 数组（tools 数组只剩恒定基座 + tool_schema/tool_invoke），目录引导模型走 tool_schema→tool_invoke。默认 full 行为逐字节不变。
**下一批（切片 C/D）**：C = P2.4 可见性守卫 warn-only（直调计数日志）；D = P2.3 收编 241（discoverable 内置工具挂 builtin 命名空间 + tool_invoke resolve 扩展非 MCP 工具 + 删 turn 注入路径）。

### 8.13 切片 C 完成记录（2026-09-02，P2.4 warn-only 可见性守卫）

**落地**：
- `packages/agent/src/tool/visibility-guard.ts`（新）：进程内计数 `recordUndeclaredCall(name)` → `logger.warn`（含 count，提示"应走 tool_schema→tool_invoke"）+ `readUndeclaredCallStats()`/`resetUndeclaredCallStats()`。warn-only：不拦截。
- `DuyaAgent.streamChat`：`declaredToolsForRequest` 外层 Set——`openLLMStream` 每请求前快照 `tools.map(name)`（跨轮随 discovered 追加变化）；`guardedCanUseTool` wrap `canUseTool`：`exposure==='catalog'` 时对不在声明集的 tool 名记一次直调（meta 工具恒在数组不误报；full 模式不启用）。executor（:1417）改用 guardedCanUseTool。
- 测试：`visibility-guard.test.ts` 3 项（空初始/累计/重置）全绿。

**数据产出**：catalog 灰度期间直调率 = `readUndeclaredCallStats()` / 总 tool_use——P2.5 enforce 决策依据（§8.3）。若遵从率高可维持 warn-only 减复杂度；否则 enforce。
**未做**：P2.5 enforce（拦截 + 结构化拒绝回模型）；切片 D（P2.3 收编 241）。

### 8.14 切片 D-1 完成记录（2026-09-02，builtin 命名空间能力闭环）

**落地**：
- `catalogFromRegistry.ts`：provider 增加 `BUILTIN_TOOLS_NAMESPACE = 'builtin'`——non-MCP `discoverable` 内置工具（image_generate 等 ~15 个）按 definition.name 挂入 builtin 命名空间（source 'builtin'）；`always` 工具不进目录（已在数组，发现冗余）、`internal` 全排除。tool_schema 现可发现内置 discoverable 工具。
- `dispatcherFromRegistry.ts`：resolve 扩展 builtin 分支（namespace==='builtin' → owner!=='mcp' && discoverable && name 匹配）；listNamespaces/listToolsInNamespace 同步支持 builtin；新增可选 `contextProvider` deps（builtin 工具 execute 时取 turn ToolUseContext——内置工具可能依赖；MCP 忽略）。错误面统一（"No tools are reachable through tool_invoke" 文案含 builtin 语义）。
- 测试：`plan480-meta-tools.test.ts` 26 项全绿（新增 3：provider 列 builtin / dispatcher 执行 builtin 工具 / 未知 builtin 工具含列表；P2.2 旧文案断言更新）。
- **双通道并存**：discoverable 工具仍可经旧 tool_search 命中→下一轮注入路径调用（未删除），同时可经 tool_schema(builtin,·) + tool_invoke 调用——零回归。

**D-2 未做（删除 241 注入路径，行为迁移需单独轮）**：删 turn 循环注入块（DuyaAgent 1124-1147 区）+ harvestDiscoveredTools 语义 + ToolSearchTool 结果文案改指 tool_invoke + default 模式 e2e 验证。风险：default 模式下模型对 discoverable 工具完全改走 meta 通道（多一轮 discovery），须在 catalog 灰度数据达标后与全量迁移一起做。保留 241 注入路径作为 fallback 直到 D-2 完成（与 §2.4"收敛不并存"的最终态差一截，属有意的灰度中间态）。

### 8.15 P4 收尾完成记录（2026-09-03，catalog 终态 + plan 480 收口）

**已落地**：
- **catalog 模式 tools 数组冻结（P4 核心）**：`DuyaAgent` turn 循环的 241 下一轮注入块与 on-demand tool guide 附加（`discoveredToolPromptSuffix`）在 `exposure='catalog'` 下整体禁用——动态工具（MCP + discoverable 内置）唯一入口 = `tool_schema`（MCP 按 server 名 / 内置走 `builtin` 命名空间）+ `tool_invoke`。含 tool_search 命中后也不再注入 → tools 数组在会话全程逐字节恒定（§2.4 收敛目标在 catalog 模式达成）。default（full/search）路径行为零变化。
- `ToolSearchTool` 描述更新：说明两种暴露路径（direct 下一轮注入 vs catalog 走 tool_schema/tool_invoke）。
- 提交：`2bf7621a`（P4 冻结）+ `4f13d7a3`（P2.5 enforce）+ 恢复提交（recover480 分支）。

**收口判断（未做项与归属）**：
- **P3.3（ModelCompat toolExposureMode + 目录 section 渲染通道）**：判定由 **474 section 框架承载**——catalog 暴露的 system 侧引导已在 capability-catalog 完成（`entryPoint: 'tool_invoke'`），工具执行走消息通道（tool_result）与 418 tool_reference 无新增交叉，480 无需向 @duya/ai ModelCompat 新增字段。依赖 474 开工后验证目录 section 挂载。
- **connector（AppConnectionTool，plan 450）**：保留 `discoverable` + @-mention 提升机制——480 迁移范围不含 plan 450 的 connector 动态工具（§7 界定），其收编归 plan 450/后续。
- **default 模式 discoverable 工具**：保留 241 注入（未删除）——全量删路径属行为迁移，等 catalog 灰度直调率数据达标 + connector 收编后执行（届时 ExposeMode 可收回 always/catalog/internal 三态、exposure 收回 full/catalog）。
- **e2e/灰度**：需真机验证 `exposure='catalog'`：MCP 断连场景 tool_schema 发现与 tool_invoke 超时（G9）、守卫 enforce 拒绝路径（P2.5）。

**plan 480 状态：机制侧全部完成（P0.1/P1/P2.1/P2.2/P2.3-D1/P2.4/P2.5/P3 前置/P4-catalog），剩余均为数据驱动迁移与 474 挂载，无独立可推进的代码项。**

### 8.16 灰度验证闸门（T6，2026-09-05）

**目标**：把"e2e/灰度需真机验证"转化为可重复、可量化的闸门，解锁 T1–T3 删除。

**已落地**：
- `visibility-guard.ts` 抽取纯函数 `evaluateCatalogVisibilityGuard({exposure, catalogGuard, declaredTools, toolName}) → {undeclared, reject, message}` + 常量 `CATALOG_VISIBILITY_DENIAL_MESSAGE`。`DuyaAgent.guardedCanUseTool` 改为复用该纯函数（行为逐字节不变，拒绝文案同一来源），守卫判定从此可单测、可回放。
- 新增 `packages/agent/src/tool/__tests__/catalog-grayscale-harness.test.ts`（14 项，全绿）：
  1. **P2.5 enforce 决策矩阵**：`catalog`+`enforce`+未声明真名 → `reject:true` 且消息与 `CATALOG_VISIBILITY_DENIAL_MESSAGE` 逐字节一致；`catalog`+`warn` → `undeclared` 但 `reject:false`（仅遥测）；`full`/`search` → 守卫禁用；`tool_schema`/`tool_invoke` 声明在数组永不误报。
  2. **meta 工具闭环**：`tool_schema({namespace:'fakeserver'})` 列出 MCP 工具 → `tool_invoke({namespace,tool,arguments})` 经真名权限门执行成功；未知工具 / MCP 断连（未知 namespace）/ 执行器失败（G9 超时形态）/ 权限 deny 均走结构化错误。
  3. **灰度采集钩子**：`simulateSession(toolUses, {exposure, catalogGuard})` 复刻 agent 循环每 tool_use 的判定，输出 `undeclared` 计数 + `readUndeclaredCallStats()` + `rate = undeclared/total`。

**门控与解锁口径（T1–T3 删除前置）**：
- 真机跑 `exposure='catalog'`（建议先 `catalogGuard='warn'` 采集基线，再切 `enforce`），周期性读 `readUndeclaredCallStats()`。
- **遵从率 = 1 − (直调率)**。`直调率 ≤ 阈值（建议首版 ≤ 5%）` 且 connector（plan 450）收编完成 → 可执行 T1（`discoverable`→三态）、T2（`exposure` 三值→两值）、T3（删 `DuyaAgent.ts:1165-1252` 的 241 注入 + `ToolFilter.ts:74-79` 的 `discovered.has` 分支 + 旧 `onDemandDiscovery` 镜像 / `DUYA_TOOLS_ON_DEMAND_DISCOVERY`）。
- 直调率偏高 → 维持 `warn-only` 或回查 catalog 引导文案，不删双通道。

**仍外部依赖**：P3.3 目录 section 挂载待 plan 474 框架；connector 收编待 plan 450。
