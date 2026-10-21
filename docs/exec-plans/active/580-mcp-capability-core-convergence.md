# 580 — MCP Capability Core：链 A/B 收敛与状态真实性修复

> **Status:** Planning（v2）· **Priority:** P0 · **Date:** 2026-09-29（v2 同日修订）· **Scope:** `packages/plugin-core/src/mcp/core/`（新增）、`packages/agent/src/mcp/`、`packages/agent/src/tool/`、`packages/agent/src/agent/`、`electron/services/app-connections/`、`electron/db/schema.ts`
> **来源:** 2026-09-29 MCP 协议链完整审计（`output/2026-09-29-mcp-connector-chain-audit.md`，8 范围逐文件实证，SDK 1.30.0）+ 两轮复审收敛（v2 按 10 条设计层复审意见重写，见 §0）。
> **关系:**
> - **部分实现并前置** [2026-09-tool-catalog-unification](../completed/2026-09-tool-catalog-unification.md)：本计划落地其"简短能力提示常驻 + schema 按需加载"在 connector 侧的部分，并为 `tool_catalog` 增加 list 模式；该计划的 `eager|deferred|hidden` exposure 模型、provider native tool-search 策略**不在本计划范围**，实现前逐项对照其 §4/§5 避免两套路径。
> - 不改变 plan 449/450 的 riskTier 审批语义与 plan 419 权限总线决策点；本计划只在 executor 层接入 deadline。
> - 依赖 plan 314 的长驻 `ToolRegistry`（owner 语义扩展，见 Phase 2C，兼容性演进）。
> - plan 418 的协议能力判断（ModelCompat）继续作为 native 路径判据，本计划不触碰。

---

## 0. 修订说明（v1 → v2）

v2 按第二轮复审逐条修订。**开工前必须先落地的四项修正为 D1/D2/D4/D5**（复审标注的 Core 层级边界、lifecycle 漏项、deadline 禁关共享 transport、canonical 不做 object 包裹）。

| # | v1 写法 | 复审修正 | 本版处理 |
| --- | --- | --- | --- |
| R1 | Core 六模块含 `inventory-ledger`；conformance 放 `plugin-core/__tests__/` | plugin-core 只保留协议纯能力；ledger 跨到 Registry/Catalog/Exposure 层、conformance 依赖 ToolRegistry/ToolCatalogTool/AppConnectionTool，放 Core 会反转依赖 | **D1**：Core 仅 list-tools/descriptor/alias/error-taxonomy/deadline/projection + 纯类型 `ledger-types.ts`；ledger 状态管理分别落在 agent runtime 与 electron service；conformance harness 移 `packages/agent/tests/integration/`；`riskTier` 用 plugin-core 本地 zod enum（`app-schema.ts:107`），不引 agent 侧类型；`getSchemaRevision` 下沉 Core、agent 侧 re-export（byte-equal 测试保存量 hash） |
| R2 | L9 要求 `list_changed` 刷新可见，但 Phase 2–5 无任何 notification phase | 两链 `capabilities:{}`（`mcp/index.ts:188`、`remote-mcp.ts:183`），全仓库无 `setNotificationHandler`/`onclose`/`onerror`——"进程死了 UI 还显示 connected" | **D2 + Phase 2.5 Lifecycle Truth**：声明 `tools.listChanged`、注册 notification handler（debounce/coalesce → transactional rediscovery）、transport `onclose/onerror` → `degraded` 状态同步；自动重连 Out |
| R3 | "一直跟 `nextCursor`"、指标用 `advertised` | 缺事务性与防御；分页 server 不一定"声明总数" | **D3**：临时 inventory 聚合 + cursor 正常耗尽才一次性 commit；`seenCursors` 防环、重名检测、maxPages/maxTools guard、`discoveryGeneration` 防旧覆新；`advertised` 全文改名 **`discoveredTotal`**；ledger 状态扩为 `discoveryStatus = complete\|refreshing\|failed\|stale` + `pagesFetched` + `discoveredTotal` + `inventoryRevision` |
| R4 | 不变量"schema 不得裁剪/重解释" vs Phase 2B 保留 `type:'object'` 包裹 | `buildToolDefinition` 是**无条件覆盖**（`AppConnectionTool/index.ts:75-79`），发生在 canonical 进 registry 之前（`registry.ts:472` 据此算 revision），本身已改变语义 | **D4**：严格两份——`canonicalInputSchema` 永远逐字段 verbatim（Ajv/catalog detail/revision 全用它）；`projectForProvider` 纯函数只在进模型 `tools[]` 前一刻生成 projection（缺 type 根包 `{type:'object', anyOf:[canonical]}`、8KB budget 在此层） |
| R5 | "signal 不支持则 race + abort 时主动 `transport.close()` 兜底" | transport/session 同时服务多个 request，为取消 A 关掉 transport 会杀掉 B/C、session 失效、额外 breaker failure | **D5**：已实证 SDK 1.30.0 `RequestOptions.signal?: AbortSignal`（`protocol.d.ts:71`）且 abort 自动发 per-request cancel（`protocol.js:709-710`）——**per-request abort，永不因单个调用 close 共享 transport**；v1 该兜底与风险表行作废 |
| R6 | replace-set：连接移除 → 空集 replace | 缺 "refresh 失败 ≠ authoritative empty"：一次网络错误会把 46 工具真实库存清空 | **D6**：三种事件区分——`connection:removed` → authoritative empty；`discovery:succeeded` → authoritative replace；`discovery:failed` → **不 replace**，inventory 标 `stale`；inventory 与 connectionHealth 拆成两个状态维度 |
| R7 | 多账号 namespace：单连接 `provider`，多连接 `provider:<connectionId>` | 第二账号接入时第一账号 namespace 变名 → cache/历史 session/schema promotion 全失效；完整 UUID 不该给模型 | **D7**：`app_connections` 加持久化 `connection_slug` 列（migration 58），fnv1a(connectionId) 4-hex 派生、创建时定终身；首个连接持有裸 namespace 且终身不变，后续连接 `provider:<slug>`；展示名走既有 `account_label` |
| R8 | 非 text 块"以确定性 JSON envelope 追加进 result 文本" | image/audio 巨大 base64 stringify 进文本可能吃掉几十万 token；"无损保存"≠"无损塞进上下文" | **D8**：删除 envelope；`ToolResult.blocks/structured` 原样保存（保存层无损）；进模型上下文只给**有界单行 metadata/attachment handle**（≤200 chars）；provider 投影留后续 plan |
| R9 | `transport/timeout/protocol` 三类都计熔断 | 生成工具 120s 超时≠server 不健康；JSON-RPC 合法 error response≠协议损坏 | **D9**：`classifyMcpError` 只描述；`breakerDisposition` 单独裁定——transport/unreachable/malformed → connection 计数；timeout → tool-scoped 计数（connection+tool 键）；auth/business/RPC error → ignore |
| R10 | list cursor 无 revision 绑定；六层指标含 `searchReturned` | 翻页中 inventory 刷新会重复/漏项；searchReturned 取决于每次 query，不是 inventory 层 | **D10**：opaque cursor 内部编码 `{catalogRevision, namespace, lastToolId}`，不匹配报 `CATALOG_CURSOR_STALE`；稳定指标链改五层 `discovered → descriptors → aliases → registered → discoverable`；`lastSearchReturned/queryId` 降为诊断事件 |
| T1 | Phase 0 "写脚本直连 Notion 抓基线" | 另起客户端可能拿到另一个 OAuth grant 的数字 | Phase 0 改为在 `RemoteMcpConnector`/`MCPClient` discovery 前后加 **env-gated debug instrumentation**（同一 connection/scopes/auth context） |
| T2 | conformance "随机抽样 invoke" | CI 不应真随机 | 改 deterministic sample：排序后按 stride 取 5 个（首/尾必含） |
| — | Phase 0/1/2/3/4/5/6 | 复审压缩实施顺序 | 重排为 **0 契约冻结 → 1 protocol-pure Core → 2 atomic discovery/schema/owner/alias → 2.5 lifecycle truth → 3 awareness/catalog → 4 deadline/result/error → 5 顶层 conformance + observability → 6 runtime merge decision** |

---

## 1. 一句话目标

把"Remote MCP 是 authoritative capability source、Registry 是完整镜像、Catalog 只是检索层、Exposure 只影响可见性"从口号变成两链共享的 Core 原语 + 可断言的 lifecycle 状态，消除四个状态不真实 P0 与 lifecycle 假象。

## 2. Scope

**In**：
- 链 A（config-MCP，worker `packages/agent/src/mcp/index.ts`）与链 B（App-Connection Remote MCP，Main `electron/services/app-connections/connectors/remote-mcp.ts`）接入统一 Core 原语
- 事务性分页发现、canonical/projection schema 双份、per-owner replace-set（三事件语义）、统一 alias/slug allocator、单一 deadline（per-request abort）、错误分类与熔断解耦、lifecycle truth（list_changed/onclose）、`tool_catalog` list 模式、结果 blocks 保存、五层 inventory 指标
- 主 db migration 58：`app_connections.connection_slug`

**Out**（每项含理由）：
- 链 A/B client 进程级合并——Phase 6 只做评估决策；两链进程边界承载 OAuth token 安全模型（token 不跨进程），合并属结构性重构
- 自动重连——与 OAuth refresh、退避策略、session 生命周期交织，单独 plan；本计划只做到 `degraded/disconnected` 真实呈现
- resources/prompts/tasks/elicitation 全量实现——当前两链均只用 tools 面；扩展时按 Phase 6 评估结论走
- provider native tool-search（OpenAI/Claude）——plan 2026-09-tool-catalog-unification 范围
- 非 text 块的 provider native 多模态渲染——需 provider adapter 评估，本计划只做保存无损 + 有界 metadata
- UI debug 面板——本计划只暴露数据（`mcp:status:snapshot` + 连接 DTO），面板另行规划

## 3. 设计决策

### D1 — Core 层级边界（protocol-pure only）

`packages/plugin-core/src/mcp/core/` 只放**无外部依赖的协议纯能力**：

```
core/
  list-tools.ts        # listAllTools(client, opts)：事务性分页聚合原语（§D3）
  descriptor.ts        # McpToolDescriptor 纯类型 + computeSchemaRevision（自 catalog-identity.ts:6-29 下沉，canonicalize+sha256 逐行等价）
  alias.ts             # 分配器纯函数：slug 派生 + base 生成 + 64-char/碰撞后缀（复用 provider-tool-name.ts:233-277 FNV-1a 基础）
  error-taxonomy.ts    # classifyMcpError + breakerDisposition 两个纯函数（§D9）
  deadline.ts          # DeadlineClock 纯时钟：deadlineAt/remainingMs()/AbortController 桥接
  projection.ts        # projectForProvider(canonical, budget)：纯 JSON→JSON 变换（§D4）
  ledger-types.ts      # InventoryLedgerSnapshot 纯类型 + 确定性序列化（§D3），无状态管理
```

**不上 Core 的**（复审 R1）：
- `inventory-ledger` 状态管理：链 A 落 `packages/agent/src/mcp/inventory-ledger.ts`，链 B 落 `electron/services/app-connections/inventory-ledger.ts`——各自消费 Core 的 `ledger-types.ts`，被 registry/catalog/连接服务写入，Core 不知道这些层的存在。
- conformance harness：依赖 `ToolRegistry`/`ToolCatalogTool`/`AppConnectionTool`，落 `packages/agent/tests/integration/mcp-conformance.spec.ts`。Core 自身只测 primitives（分页循环/分类矩阵/deadline/allocator/projection/revision）。

**依赖方向核对结论**（实证）：`riskTier` 类型用 plugin-core 本地 `connectors/app-schema.ts:107` 的 zod enum（`'read'|'draft'|'write'|'modify'|'destructive'`）；agent 侧 `policy.ts:1192` 是同值 mirror、electron 侧同——Core 不 import agent。`computeSchemaRevision` 下沉后，agent `catalog-identity.ts:26` 改为 `export { computeSchemaRevision as getSchemaRevision }`——算法逐行相同，存量 registry entry hash 不变（Phase 1 加 byte-equal 对照测试锁死）。

### D2 — Lifecycle Truth（list_changed / onclose / onerror）

实证：两链 Client 均以 `capabilities: {}` 构造（`mcp/index.ts:188`、`remote-mcp.ts:183`），全仓库无 `setNotificationHandler`、无 transport `onclose/onerror` 钩子；链 A 状态机仅 `disconnected|connecting|connected|error`（`mcp/index.ts:49`），transport 死后 status 仍是 `'connected'`，`callTool` 会挂在 SDK 60s 默认超时上。

- 连接成功（initialize 完成）后：读取并保存 `serverCapabilities`（进 ledger 快照）。**勘误（实施期发现）：`tools.listChanged` 是 ServerCapabilities 字段（server 声明将推送 list_changed）；MCP 规范的 ClientCapabilities 无 `tools` 键，SDK 1.30.0 `ClientCapabilitiesSchema` 为 `$strip` 模式且类型拒绝——两链 Client capabilities 保持 `{}`，client 侧订阅 = `setNotificationHandler(ToolListChangedNotificationSchema)`（即下行），无需 capability 协商。**
- 注册 `client.setNotificationHandler(ToolListChangedNotificationSchema, ...)` → **debounce 500ms / coalesce**（连续通知只触发一次）→ **transactional rediscovery**：`listAllTools` 完整分页（§D3）→ 成功才 replace-set commit + `inventoryRevision++`；rediscovery 失败按 §D6 处理（不 replace、标 stale）。
- `transport.onclose` / `onerror`：链 A `MCPConnectionStatus` 增加 `degraded`（区别于主动 disconnect 的 `disconnected` 与连接期失败的 `error`）；链 B 同步 connectionHealth 并经既有状态推送面通知 renderer——**UI 不再为死进程显示 connected**。
- 不做自动重连（Out）；`degraded` 下 `callTool` 直接返回 `MCP_TRANSPORT` 错误而不是挂起。

### D3 — 事务性分页（listAllTools 契约）

```ts
interface ListAllToolsOptions {
  deadline: DeadlineClock;          // 分页全程共享一个 deadline
  maxPages?: number;                // 默认 50
  maxTools?: number;                // 默认 5000
  generation: number;               // discoveryGeneration，monotonic
}
interface ListAllToolsResult {
  tools: McpToolDescriptor[];       // 仅在 cursor 正常耗尽后返回；中途任何失败抛出
  pagesFetched: number;
  discoveredTotal: number;          // 命名弃用 advertised：分页 server 不"声明总数"，这是本次发现的实测数
  truncated: false | 'maxPages' | 'maxTools' | 'deadline';
}
```

防御条件（全部单测覆盖）：
- **事务性**：逐页聚合进**临时 inventory**；`nextCursor === null`（或 `undefined`）才允许调用方 commit；第 3 页失败绝不能把前两页写进 Registry/cache。
- `seenCursors: Set<string>`：重复 cursor → `MCP_PROTOCOL`（防服务端分页环）。
- 跨页重复 tool name → `MCP_PROTOCOL`（spec 要求唯一；宁可失败也不静默去重掩盖 server bug）。
- `maxPages`/`maxTools` 触顶 → 返回 `truncated` 标记（连接标记 `stale`，不得标记 complete）。
- deadline 触发 → `MCP_TIMEOUT`，临时 inventory 丢弃。
- 调用方在 commit 前核对 `generation` 未变——防止旧 discovery 的迟到 commit 覆盖新 discovery（并发 rediscovery / 重连竞态）。

Ledger 核心状态（Core 纯类型，两链各自实例化状态机）：

```ts
interface InventoryLedgerSnapshot {
  discoveryStatus: 'complete' | 'refreshing' | 'failed' | 'stale';
  pagesFetched: number;
  discoveredTotal: number;
  inventoryRevision: number;        // 每次成功 commit +1，monotonic
  layers: { discovered: number; descriptors: number; aliases: number; registered: number; discoverable: number };
  serverCapabilities?: Record<string, unknown>;
  lastSearchReturned?: { count: number; queryId: string; at: number };  // 诊断事件，非库存层（§D10）
  fetchedAt: number;
}
```

### D4 — canonical / projection 双份 schema

实证矛盾点：`buildToolDefinition`（`AppConnectionTool/index.ts:75-79`）对 `input_schema` **无条件覆盖** `type:'object'`（远端根是 `{oneOf:[...]}` 时语义被改；远端声明其他 type 也被覆盖），且该结果直接进 registry（`registry.ts:472` 据此算 `schemaRevision`）——canonical 在入口处已被污染。

- **`canonicalInputSchema`**：远端 `inputSchema` 逐字段 verbatim（含 `$defs/oneOf/anyOf/allOf/additionalProperties/default`）。registry entry、Ajv 校验（`dispatcherFromRegistry.ts:50-63`——Ajv 原生支持组合器根）、catalog detail、`computeSchemaRevision` **全部只用 canonical**。
- **`projectForProvider(canonical, budget)`**（Core 纯函数）：仅在对模型组装 `tools[]` 的最后一刻调用。规则：根缺 `type` → 包 `{type:'object', anyOf:[canonical]}`（保语义的最小包裹，不覆盖远端已声明的任何字段）；根已有 `type` → 原样透传；8KB spec budget 裁剪只发生在此层；返回 `{schema, downgraded: boolean}`。
- `AppConnectionTool/index.ts:75-79` 的覆盖删除；链 A eager 工具进模型前同样经 projection（链 A 现 verbatim 直传，遇 oneOf 根会被 provider API 拒，projection 是两链共用的 last-mile）。
- `normalizeInputSchema`（`remote-mcp.ts:263-274`）与其类型 `ConnectorInputSchema`（`connector-types.ts:19-23`）删除/放宽为 `Record<string, unknown>`；`hydrateTools`（`remote-mcp.ts:55-66`）cache 快路径同样改 verbatim。

### D5 — 单一 deadline，per-request abort，永不关共享 transport

实证：SDK 1.30.0 `RequestOptions` 明确支持 `signal?: AbortSignal`（`node_modules/@modelcontextprotocol/sdk/dist/esm/shared/protocol.d.ts:71`）与 `timeout?: number`（`:77`）；`protocol.js:709-710` 显示 signal abort 时 SDK 自动向 server 发 per-request cancellation——**取消单个请求不需要、也不允许 close transport**（一个 transport/session 同时服务多个 tool request；v1 的"abort 时主动 `transport.close()` 兜底"作废）。

- 每次工具调用：`deadlineAt = Date.now() + effectiveTimeoutMs`（effective = `toolTimeouts[tool] ?? toolTimeoutSec ?? 120s`）；`DeadlineClock` 产出 `AbortController`。
- 两链 `callTool` 统一：`{ timeout: remainingMs, signal: controller.signal }`——SDK 内部处理超时与取消；迟到响应被 SDK 拒绝，无僵尸调用，transport 与并行请求 B/C 不受影响。
- 链 B：IPC payload 加 `deadlineAt`（worker 生成）→ `ConnectorService.invoke` → `remoteMcp.invoke` 透传剩余时间，Main 侧同样走 `options.timeout/signal`；`AppConnectionTool/index.ts:118` 的固定 `{timeout: 60_000}` 改 deadline 感知。
- `transport.close()` 只允许出现在：主动 disconnect（`mcp/index.ts:246`、`remote-mcp.ts:158`）、connect 失败清理、lifecycle 阶段确认 transport 已死亡（onclose 已触发）后的资源回收。
- 三重真相收敛：外层 `withTimeout`（`mcp/index.ts:274` 对 callTool 已是死代码）删除；SDK `DEFAULT_REQUEST_TIMEOUT_MSEC=60000` 被 `options.timeout` 显式覆盖，不再抢跑。

### D6 — replace-set 三事件（refresh 失败 ≠ authoritative empty）

owner 扩展不变：`ToolRegistry.owner` → `'non-mcp' | 'mcp' | `connector:${connectionId}` `，`replaceByOwner` 泛化（validate-then-commit 语义不变，`registry.ts:314-400`）；`sourceForTool`（`registry.ts:82-100`）走 `meta.source` 优先，owner 标签不影响 visibility/snapshot（v1 已审计确认）。

三种事件的语义严格区分：

| 事件 | 触发点 | Registry 动作 | Ledger/health |
| --- | --- | --- | --- |
| `connection:removed` | 连接被用户删除；兜底：owner bucket 存在而连接列表 diff 无此 id | `replaceByOwner(owner, [])` —— authoritative empty，stale 全清 | inventory 清零；health = disconnected |
| `discovery:succeeded(tools N)` | `listAllTools` cursor 耗尽正常返回 | `replaceByOwner(owner, N 条)` —— authoritative replace（46→45 也照做） | `discoveryStatus=complete`；`inventoryRevision++` |
| `discovery:failed(err)` | 分页抛出 / deadline / maxPages 截断 | **不调用 replace** —— last-known inventory 保持 | `discoveryStatus=failed`（有成功历史）/`stale`（truncated）；health 降级 |

**inventory 与 connectionHealth 是两个维度**：registry owner bucket 回答"系统拥有什么"；health（`healthy|degraded|disconnected`）回答"现在能不能用"。`remote-mcp.ts:158` 的 `disconnect(connectionId)` 是 `connection:removed` 的现成入口，在此追加 registry 空集 replace；连接列表 diff 兜底保留（沿用现网前缀清理的触发时机，`AppConnectionTool/index.ts:248-281`），但判定单位从"前缀匹配"改为"per-owner bucket 存在性"。前缀表（`:258`）删除。

### D7 — 稳定 alias / namespace（连接集变化时 identity 不变）

实证：`app_connections` 表（`electron/db/schema.ts:439-451`）列 = id/provider/account_label/account_id/scopes/status/expires_at/last_error/created_at/updated_at，**无 slug 列**；链 B `toolAlias`（`remote-mcp.ts:68-70`）同 provider 多账号完全同名，`unregister+register` 后者静默覆盖前者（F4）。

- **migration 58**（`electron/db/schema.ts` 迁移数组，现最大 id 57 `:2643`，Phase 0 核对顺延）：`ALTER TABLE app_connections ADD COLUMN connection_slug TEXT NOT NULL DEFAULT ''`。
- slug 派生：`fnv1aHex(connectionId, 4)`（复用 `provider-tool-name.ts:233-277` 的 FNV-1a 基础）；同 provider 内 4-hex 碰撞 → 扩展 6-hex。**连接创建时计算并持久化，终身不变**——不随"当前有几个账号"变化。
- namespace 分配：该 provider **首个**连接 slug 存 `''`（持有裸 namespace `notion`，终身持有，后续连接加入也不改名）；后续连接 slug 存派生值，namespace = `notion:a31f`。裸名持有人被删除后，其余连接**不升格**占用裸名（namespace 稳定性优先于美观）。模型可见 namespace 永不含完整 UUID；用户展示用既有 `account_label`（`Notion · rain@example.com`）。
- 工具 alias 统一走 Core allocator：`remote_<namespace>_<tool>`（单连接维持现网 `remote_notion_<tool>` 字节不变；多连接 `remote_notion_a31f_<tool>`），64-char 上限 + hash 后缀 + `__N` 碰撞规则沿用 `computeProviderName`。链 A base 形态 `mcp_<...>` 不变。

### D8 — 结果保真：保存层无损，上下文层有界

实证：链 A 只拼 text content，`image/audio/resource/resource_link` 块丢弃、`structuredContent` 未读取（`mcp/index.ts:289-293`）。

- `ToolResult` 增加可选 `blocks?: McpContentBlock[]` 与 `structured?: unknown`；链 A `callTool` 全类型保留，dispatcher 透传（`dispatcherFromRegistry.ts:193-209` 的 toText 改结构保留）；持久化随现有 ToolResult 存储路径落库。
- **删除 v1 的"JSON envelope 追加进 result 文本"**（复审 R8）：image/audio 的 base64 JSON stringify 进上下文既无多模态收益又可能吃掉几十万 token。
- 进模型上下文：text 块原样；非 text 块生成**有界单行 metadata**（≤200 chars，确定性格式：`[image 1024x768 png ~245KB — attachment:att_x]`）；attachment handle / resource reference 的落地走后续 plan（provider adapter 投影）。
- `canonical truth + last-mile projection` 原则同样适用：`blocks/structured` 是 canonical 保存；进上下文的 metadata 是 last-mile。

### D9 — 错误分类与熔断解耦

实证：`MCPClient` catch 一切都 `recordFailure`（`mcp/index.ts:305` + `circuit-breaker.ts:94-106`），业务 4xx 连续 3 次即断整个 server（F6）。

```ts
classifyMcpError(err): 'transport' | 'timeout' | 'protocol' | 'auth' | 'business'   // 只描述
breakerDisposition(class): 'connection' | 'tool-scoped' | 'ignore'                  // 单独裁定可用性影响
```

| class | 判据 | 稳定错误码 | disposition |
| --- | --- | --- | --- |
| transport | connection reset / transport closed / server unreachable | `MCP_TRANSPORT` | **connection**（现 breaker，3 次 open 30s） |
| timeout | DeadlineClock 触发 | `MCP_TIMEOUT` | **tool-scoped**（`connection+tool` 键独立计数，避免"生成工具 120s 慢"熔断整个 server） |
| protocol | **malformed response**（result 结构解析失败、分页环） | `MCP_PROTOCOL` | **connection** |
| auth | UnauthorizedError | `MCP_AUTH_REQUIRED` | ignore（走既有 reauth 卡片流，`remote-mcp.ts:134-143`） |
| business | `result.isError` / provider 4xx 语义 / **JSON-RPC 合法 error response** | `MCP_TOOL_ERROR` | ignore（原样带 code/message 回模型） |

注：JSON-RPC 合法 error response 不再归 protocol（v1 混同）——它是 server 的**正常应答**，不构成可用性信号；只有 response 结构损坏（malformed）才是。tool-scoped 计数器与 connection breaker 同参数（3 次/30s/half-open），键为 `${connectionId}:${toolName}`，随 inventory commit 重置。

### D10 — Catalog 枚举：opaque cursor + 五层指标链

- `tool_catalog` 互斥三模式 `query | tool_id | namespace`；`list(namespace, cursor?)`：page size 20，按 `toolId` 字典序稳定分页。
- **cursor 为 opaque**：base64(JSON `{catalogRevision, namespace, lastToolId}`)；翻页校验——revision 或 namespace 不匹配 → `CATALOG_CURSOR_STALE` 错误，模型从首页重新枚举（杜绝翻页中 inventory 刷新导致的重复/漏项）。`next_cursor` 仅在还有下一页时返回。
- 稳定指标链（持久，§D3 ledger `layers`）：**discovered → descriptors → aliases → registered → discoverable** 五层。`searchReturned` 移出持久指标——改为 `lastSearchReturned {count, queryId, at}` 诊断事件（进 snapshot 的 diagnostics 区）。四组数字可观察性目标不变（46 → 46 → 46 → 10，最后一位是单次 query 的诊断值）。
- hidden 永不出现；`suggested_namespaces` 与 list 模式并存；`INVALID_CATALOG_QUERY` 兼容旧错误码。

### Awareness 常驻（不变，v1 §3.5 保留）

`buildAppsSystemSection` 与 connector 提示移出 `exposure==='search'` 门（`DuyaAgent.ts:3790-3814` 的 if 拆分）：connector 节无条件渲染（无连接时维持 null 不改 prompt 字节）；MCP capability directory 维持现状。节内固定指引：`Use tool_catalog with list(namespace=...) to enumerate an app's tools when a search misses them.` 渲染确定性：provider id 排序，仅连接集变化时字节变化。

### Conformance 准入合同（落点按 D1 调整）

`packages/agent/tests/integration/mcp-conformance.spec.ts`：基于 MCP SDK `InMemoryTransport` 成对端点跑 L1–L9（discoveredTotal 计数 → descriptor diff → alias 去重 → registry 计数含 stale 清理与 `discovery:failed` 不清空断言 → catalog 可检索含 cursor stale → detail schema deep-equal（canonical 逐字段）→ **deterministic sample** invoke 参数 diff（排序后 stride 取 5，首尾必含，禁真随机）→ auth/业务错误分类矩阵 → `list_changed` debounce 后刷新可见 + `discovery:failed` 保持 last-known）。链 A/B 各加薄集成层：链 A stdio fixture（packages/agent 测试），链 B streamable-http fixture + mock OAuth（electron `app-connections/__tests__`）。**任何新 connector 接入必须通过 conformance 才能合入**——写入 AGENTS.md Gates。

---

## 4. 交付阶段

### Phase 0 — 契约冻结与冲突审计

- [ ] 核对 plan 314 / 418 / 449 / 450 / 2026-09-tool-catalog-unification 在当前 checkout 的最新状态，确认无并行改动冲突（尤其 `registry.ts` owner 语义、`ToolCatalogTool` 输入 schema、`app_connections` 表结构）。
- [x] 核对主 db 迁移数组现最大 id（本计划实证 57，`schema.ts:2643`）；确认 58 未被并行 plan 占用后，migration 58 定号。
- [x] 在 `RemoteMcpConnector.ensureSession`（`remote-mcp.ts:170`）与链 A `MCPClient.connect`（`mcp/index.ts:140`）加 **env-gated debug instrumentation**（`DUYA_MCP_DISCOVERY_DEBUG=1`：逐页 `cursor/pages/total` 日志）——**用 Duya 自己的连接/同一 OAuth grant 抓基线**，不用外部脚本（复审 T1：另起客户端可能拿到另一个 grant 的 46 vs Duya 的 42）。（实施注记：instrumentation 落 Core `list-tools.ts` 的 `discoveryDebugEnabled`/`debugLog` sink；链 A/B 均已接线，Phase 2A 转正为 `formatDiscoveryLogLine` 连接日志。）
- [ ] 真机跑一次 Notion 连接，记录基线到 §6 基线表（instrumentation 代码保留，Phase 2A 直接复用为 `pages=N, total=M` 连接日志）。**待用户真机执行。**

### Phase 1 — protocol-pure Core（纯新增，无行为变化）

- [x] 新建 `packages/plugin-core/src/mcp/core/` 七模块（§D1 清单，**不含** ledger 状态管理）；单测全覆盖：分页防御矩阵（seenCursors/重名/maxPages/maxTools/deadline/generation）、分类-disposition 矩阵、deadline 剩余时间、allocator（slug 派生/碰撞/64-char/`__N`）、projection（oneOf 根包裹/已有 type 透传/budget 裁剪）、`computeSchemaRevision` 与 `catalog-identity.getSchemaRevision` **byte-equal 对照**。（46 Core tests + agent 3 byte-equal tests 全绿）
- [x] `catalog-identity.ts:26` 改 re-export Core 实现（存量 hash 不变的测试锁死）。
- [x] 门禁：`npm run typecheck:all`；`packages/plugin-core` vitest 绿。

### Phase 2 — atomic discovery / schema / owner / alias（两链接入 Core）

- [x] **2A 事务性分页**：`mcp/index.ts:200-204` 与 `remote-mcp.ts:204` 换用 `listAllTools`；cursor 耗尽才 commit；catalog-cache 写入点（`remote-mcp.ts` cache 保存路径）同样只收完整 inventory；连接日志 `pages=N, total=M`（Phase 0 instrumentation 转正）。（链 A：`mcp/index.ts` 重写；链 B：`discoverNow` 事务性 commit + truncated 不写 cache。）
- [x] **2B canonical/projection 拆分**：删 `normalizeInputSchema`（`remote-mcp.ts:263-274`）与 `ConnectorInputSchema` 收窄类型（`connector-types.ts:19-23`）；删 `buildToolDefinition` 的 `type:'object'` 覆盖（`AppConnectionTool/index.ts:75-79`）；`_resolveTools` 组装 `tools[]` 处接入 `projectForProvider`（链 A eager 路径同样接入）；catalog detail / Ajv 全链路确认拿到 canonical。（另删 registration 期 `downgradeForByteBudget`——budget 裁剪只留在 projection 层。）
- [x] **2C owner replace-set**：owner 类型扩展 + `replaceByOwner` 泛化（§D6）；按 connectionId 分桶；三事件语义（removed→空集 / succeeded→replace / **failed→不 replace 标 stale**）；删除前缀表（`AppConnectionTool/index.ts:258`）；回归测试：46 → 删 1 → reload → 45 无幽灵键；**46 → discovery 网络错误 → 仍 46 + status=failed**。（实施注记：`ToolOwner`/`ReplaceableOwner` 在 `registry.ts`，运行时护栏保留（`as ToolOwner` 断言绕过 TS2367）；三事件可区分性靠 IPC 第三字段 `discoveryFailedConnectionIds`（`connector-service.listDescriptorsForConnected` 收集 token 无效/connector 未注册/discovery 抛错三类失败 → lifecycle → `agent-process-entry` → `setCachedAppConnectionDescriptors` 第三参）；`setCached` 无 connected set 时回退 legacy 全量对账（旧 Main 兼容）；connected 且缺 descriptor 且不在 failed 集 = succeeded-empty → authoritative empty。回归测试 `replace-set.test.ts` 8 条 + `connector-service.test.ts` 签名适配。）
- [x] **2D slug allocator**：migration 58 加列；连接创建路径写入 slug；链 B `toolAlias` 换 Core allocator（§D7）；单连接 alias 字节不变回归 + 两连接并存 46+46 全存活测试。（实施注记：migration 58 建表加列 + 回填（per provider 最旧行持 `''` 裸名，余者 `deriveConnectionSlug`，taken 含防御性已派生 slug）；slug 分配集中在 `ConnectionStore.upsert`（新行：无同 provider siblings → `''`，否则 derive；重连保留原 slug，终身不变）；`AppConnection.connectionSlug?` + `AppConnectionStatusDTO.connectionSlug?` + `toStatusDTO` 透传；descriptor stamping 在 `listDescriptorsForConnected` 统一打（覆盖 remote/rest/custom 三 binding）；`remote-mcp.listDescriptors` 第 4 参 slug → `toolAlias(provider, name, slug)`。测试：`connection-store.test.ts` +5（首连接裸名/重连不变/provider 内唯一/裸名持有人删除不升格/alias 字节回归）、`connection-slug-migration.test.ts` 3 条（回填/幂等/空表）；`migrations` 数组改为 export 供测试。注：D7"裸名不升格"语义 = 存量派生连接终身不变；provider 全空后新首连接重新持裸名（不影响任何存量连接）。）
- [x] 缓存兼容：`catalog-cache.ts` 读写 verbatim schema（体积增大）；旧文件缺字段 → stale 强制重拉。（`schemaVerbatim: true` 标记；旧格式读取返回 null；新增拒绝测试。）
- [x] 门禁：`npm run typecheck:all`；`npm run test`（对照 HEAD 存量红基线）；`tsc -p electron/tsconfig.json`。（typecheck:all 全绿；electron tsc 改动文件 0 新增错误；app-connections 测试经 HEAD 对照实验确认仅存量红 7 条，新增 0 失败；agent 侧 163 tests 全绿。）

### Phase 2.5 — Lifecycle Truth

- [x] ~~两链 Client capabilities `{tools:{listChanged:true}}`~~（勘误：该字段属 ServerCapabilities，Client 保持 `{}`）——initialize 后保存 `serverCapabilities` 进 ledger。（两链 `getServerCapabilities()` 已保存进 session/ledger 快照。）
- [x] `setNotificationHandler(ToolListChangedNotificationSchema)`：debounce 500ms coalesce → transactional rediscovery → replace-set commit + `inventoryRevision++`（§D2）。（链 A `mcp/index.ts` + 链 B `scheduleRediscovery`/`discoverNow`；失败保持 last-known + `failed`/`stale`。）
- [x] `transport.onclose/onerror` → 链 A `MCPConnectionStatus` 加 `degraded`；链 B connectionHealth 同步 + 既有状态推送面通知 renderer；`degraded` 下 `callTool` 立即返回 `MCP_TRANSPORT`。（链 B：`markTransportDead`（closing 豁免）→ `ConnectorService` 接线 → `AppConnectionService.markTransportDead`（connected→error + fireReload）；恢复 = 下次 ensureSession 重连。）
- [x] 测试：InMemoryTransport 模拟 server 侧增删工具 → 通知后 registry 计数变化；transport 强断 → 状态 degraded、UI 数据源不再 connected。（`packages/agent/src/mcp/__tests__/lifecycle-inmemory.test.ts` 3 tests：真实 `MCPClient` 经 `buildTransport` 缝注入 InMemoryTransport pair 对打真实 SDK fixture server——①server 侧加工具+list_changed→500ms debounce→rediscovery 替换工具集+`onToolsChanged` 触发 ②client 侧 transport 强断→`degraded`→`callTool` 立即 `MCP_TRANSPORT` fail-fast ③D6：list 失败保 last-known、恢复后 replace-set。conformance L9 另覆盖 registry 计数层。）
- [x] 门禁：typecheck；MCP 相关 vitest。（runtime-closure 23 tests 绿——stub 补 `setOnToolsChanged`。）

### Phase 3 — Awareness 常驻 + Catalog 枚举

- [x] 拆 `DuyaAgent.ts:3790` exposure 门：connector Apps 节无条件渲染；`DUYA_DUMP_PROMPT` 断言两种 exposure 配置下节均存在且字节确定（同连接集两次 dump 相等）。（Apps 节移出 exposure 门无条件渲染；mentions 测试新增 byte-deterministic 用例锁死。）
- [x] `ToolCatalogTool` list 模式 + opaque cursor（§D10：revision/namespace 绑定 + `CATALOG_CURSOR_STALE`）+ 稳定序分页单测（翻页中 inventory 刷新场景）。（cursor = base64(JSON `{catalogRevision, namespace, lastToolId}`)，keyset 分页 `toolId > lastToolId`，LIST_PAGE_SIZE=20；cursor 校验用 live registry revision；`list-mode.test.ts` 10 tests 绿。）
- [x] namespace/slug 多账号规则落地（§D7）；`providerLabel` 展示带 `account_label` 区分。（migration 58 已于 Phase 2 落地；descriptor stamping 多账号 `providerLabel = baseLabel · accountLabel`。）
- [x] 更新 `tool_catalog` 描述文本：search 与 list 职责分离。（DESCRIPTION 重写为三模式；Apps 节新增固定指引行 `Use tool_catalog with list(namespace=...) ...`。）
- [x] 门禁：typecheck + 相关 vitest；按 AGENTS.md 用真实 Electron renderer 冒烟（browser-only Vite 不能验证 preload 路径）。（typecheck:all 全绿；23 tests 绿。Phase 3 改动均在 packages/agent prompt/catalog 路径，不涉 electron preload；真机 renderer 冒烟并入"待用户真机执行"清单。）

### Phase 4 — deadline / result / error

- [x] **4A deadline**：`DeadlineClock` 接入两链 `callTool`（`options.timeout` + `options.signal`，§D5——**无任何 close-transport 兜底**）；链 B IPC 加 `deadlineAt`；`AppConnectionTool/index.ts:118` 固定 60s 改 deadline 感知；外层 `withTimeout` 死代码删除。（链 A `createDeadlineClock` → SDK `{timeout, signal}`；链 B `ConnectorInvokePayload.deadlineAt` + `deadlineClockFromIpc`；AppConnectionTool `CHAIN_B_TOOL_TIMEOUT_MS=120s` + `CHAIN_B_IPC_BUFFER_MS=30s`；`executor-deadline-result.test.ts` 5 tests。）
- [x] **4B 熔断解耦**：全部 catch 走 `classifyMcpError` + `breakerDisposition`（§D9）；tool-scoped 计数器落地；矩阵测试（业务 4xx×N 不开闸；timeout×N 只熔该 tool；malformed×3 开闸）。（链 A `${name}:${tool}` tool-scoped breaker；`breaker-decoupling.test.ts` 5 tests 矩阵 + conformance L8。）
- [x] **4C 结果保真**：`ToolResult.blocks/structured` 扩展 + 链 A 全类型保留；**无 envelope**；非 text 块有界 metadata（≤200 chars 确定性格式）；dispatcher 结构保留透传；持久化 round-trip 测试。（`result-blocks.ts` 共享 last-mile `composeResultFromBlocks`；`ToolResult.blocks/structured`（`packages/ai/src/types.ts`）；StreamingToolExecutor 持久化桥 `mcpBlocks`/`mcpStructured` metadata；5+5 tests。）
- [x] **4D 错误码**：五类稳定码贯穿链 A catch（`mcp/index.ts:304-321`）与链 B executor 翻译层（`AppConnectionTool/index.ts:121-157`），保留既有 auth 卡片合同（`connector_auth_required` SSE 语义不变）。（`AppConnectionErrorCode` 增 `MCP_TRANSPORT/MCP_TIMEOUT/MCP_PROTOCOL/MCP_AUTH_REQUIRED/MCP_TOOL_ERROR`；mcp-remote binding 包 `classifyMcpError` + `errorCodeForClass`。）
- [x] 门禁：typecheck；`tsc -p electron/tsconfig.json`；MCP 相关 vitest。（typecheck:all 全绿（含 electron tsc）；26 tests 跨 5 文件绿。）

### Phase 5 — 顶层 conformance + observability + 文档

- [x] conformance harness L1–L9 落 `packages/agent/tests/integration/`（含 `discovery:failed` 不清空、cursor stale、deterministic sample）；链 A/B 集成层各接一次；CI（`npm run test`）纳入。（`mcp-conformance.test.ts` 9 tests 全绿：真 SDK `Server` + `InMemoryTransport.createLinkedPair`，PAGE_SIZE=3 强制多页。链 A 集成层另接 `lifecycle-inmemory.test.ts` 3 tests（真实 `MCPClient` 对打 fixture server）；链 B 的 discovery/alias/deadline/错误分类均为同一 Core 代码（harness 已覆盖），其 HTTP/OAuth/cache 集成测试并入 581 合并 plan。）
- [x] inventory-ledger 状态机落地两链（agent `mcp/inventory-ledger.ts` + electron `app-connections/inventory-ledger.ts`，消费 Core `ledger-types.ts`）；并入 `mcp:status:snapshot`（`agent-process-entry.ts:3708`）与链 B 连接状态 DTO（新字段全部 optional 追加）。（两链 ledger 接 discovery begin/commit/fail + cache hydrate；`collectMcpStatusByServer` 增 `degraded` + optional `ledger` 块；`AppConnectionStatusDTO.ledger` optional。）
- [x] 文档：`AGENTS.md` Gates 增加 conformance 准入行 + 架构原则一句；`docs/design-docs/core-beliefs.md` 收录；`ARCHITECTURE.md` MCP 章节重写为"Core/Registry/Catalog/Exposure 四层 + 两链 transport 差异 + lifecycle truth"。（AGENTS.md Gates 第 2 行；core-beliefs.md 新增 "MCP Integration Principles (plan 580)" 六条；ARCHITECTURE.md Tool Catalog and Exposure 后新增 "MCP Capability Core (plan 580)" 四层小节。）
- [ ] 回归：真实 Notion 连接重跑基线，五层指标逐层相等 + `discoveredTotal` 与远端一致。**待用户真机执行**（与新 lifecycle/degraded 状态观察一并验证）。

### Phase 6 — 链 A/B runtime 合并评估（决策门，不在本计划实现）

- [x] 产出评估文档：链 B `RemoteMcpConnector` 收敛为"Main 进程内、复用同一 MCPClient 构造 + Core 语义、仅保留 OAuth adapter"的迁移成本；resources/prompts/elicitation 扩展时两链维护成本对比。（`docs/exec-plans/active/581-chain-ab-runtime-merge-evaluation.md`：8 项成本清单、扩展 N≥1 即赚、建议通过但延后触发。）
- [ ] 若通过，另开 plan（编号顺延）执行合并；本计划 Phase 2–2.5 的 Core 接入即为其全部前置。（581 评估建议**通过、不立即执行**——触发条件：(a) 第一个 resources/prompts/elicitation plan 立项；(b) 链 B 出现需双写编排的缺陷修复。执行 plan 届时顺延 582+，骨架见 581 §8。）

---

## 5. 验证与门禁汇总

- 每阶段：`npm run typecheck:all`；改动 electron 时另跑 `tsc -p electron/tsconfig.json`；测试按 HEAD 存量红基线（~188 条环境性失败）对照，只要求新增/相关用例绿。
- 行为门禁：conformance L1–L9 全绿；stale 清理回归绿；**discovery:failed 不清空回归绿**；多账号 alias/slug 唯一性与稳定性绿；`computeSchemaRevision` byte-equal 绿；`DUYA_DUMP_PROMPT` 字节确定性绿；lifecycle（list_changed 刷新 / onclose→degraded）绿。
- UI 门禁：Phase 2.5/3 涉及连接状态呈现与系统提示，按 AGENTS.md 用真实 Electron renderer 冒烟。

## 6. 基线表（Phase 0 用同一 connection/scopes/auth 抓取）

| 指标 | discovered | descriptors | aliases | registered | discoverable | lastSearchReturned（诊断） |
| --- | --- | --- | --- | --- | --- | --- |
| Notion（修复前，Phase 0 实测） | | | | | | |
| Notion（修复后目标） | N | N | N | N | N | ≤10（search）/ N（list） |

## 7. 风险与回滚

| 风险 | 缓解 |
| --- | --- |
| Apps 节常驻改变所有会话 system prompt 字节，短期影响 prompt cache 命中 | 渲染确定性（仅连接集变化时字节变化）；节体预算上限；缓存收益按真实用量验证 |
| `owner` 类型扩展波及 `snapshot()/sourceForTool/replaceByOwner` | owner 标签不影响 visibility（审计已确认 `meta.source` 优先路径）；三种 owner 的 snapshot 输出 byte-equal 单测 |
| schema verbatim 后 catalog-cache 体积增长 | TTL 不变；旧格式缺字段即 stale 重拉；8KB budget 仍在 projection 层兜底 |
| migration 58 加列与并行 plan 冲突 | Phase 0 核对现最大 id 后定号；加列 `DEFAULT ''` 向后兼容，回滚即弃列 |
| slug 碰撞极小概率改变派生结果 | slug 创建时持久化（非每次重算），终身不变；碰撞只在新连接创建时裁决 |
| `tool_catalog` 参数 schema 变更影响既有调用习惯 | 三选一互斥校验 + `INVALID_CATALOG_QUERY` 兼容旧错误码；cursor 新错误码 `CATALOG_CURSOR_STALE` 单列 |
| lifecycle 通知风暴（server 频繁 list_changed） | debounce 500ms coalesce；rediscovery 共享 deadline + generation 防竞态 |
| `degraded` 状态误报（transport 短暂重连中） | `degraded` 只由 `onclose/onerror` 触发，不做推测性判定；恢复路径 = 下次成功 rediscovery（Phase 2A 逻辑复用） |
| catalog-cache / status DTO 字段变更破坏旧 UI | 新字段全部 optional 追加；旧渲染路径不读新字段 |

## 8. 待裁定（≤3 条）

1. **tool-scoped breaker 的计数阈值**：与 connection breaker 同参（3 次/30s）还是更宽松（如 5 次）？默认同参，Phase 4B 真机数据出来后可调。
2. **`maxTools=5000` 上限**：对超大 server（>5000 工具）是硬截断还是可配置？默认硬截断 + `stale` 标记，等真实 server 出现再议。
3. **attachment handle 的持久化位置**：`blocks` 随 ToolResult 落库（跟随现有保留策略）还是独立 attachment 存储？Phase 4C 先随 ToolResult 落库，独立存储等 provider 投影 plan 再定。
