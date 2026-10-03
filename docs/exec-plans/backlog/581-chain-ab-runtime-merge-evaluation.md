# 581 — 链 A/B Runtime 合并评估（plan 580 Phase 6 决策门）

> 状态：**评估完成，建议通过**。本文档只做决策，不含实现。若采纳，另开执行 plan（编号顺延 582+）。
> 前置：plan 580 Phase 2–2.5 已完成 —— 两链的 Core 语义（discovery / alias / deadline / 错误分类 / 结果保真 / ledger）已全部收敛到 `packages/plugin-core/src/mcp/core/`，这正是本评估的全部前置。

## 1. 问题定义

plan 580 完成后，两条 MCP 链仍各自持有一个"SDK Client 生命周期管理器"：

| | 链 A | 链 B |
|---|---|---|
| 位置 | worker 进程，`packages/agent/src/mcp/index.ts` | Main 进程，`electron/services/app-connections/connectors/remote-mcp.ts` |
| 类 | `MCPClient`（每 server 一个，`MCPManager` 托管） | `RemoteMcpConnector`（每 connection 一个 `RemoteSession`） |
| transport | stdio / streamable-http | streamable-http（+ OAuth `authProvider`） |
| 语义实现 | Core（listAllTools / D5 deadline / D9 分类 / D8 last-mile / ledger） | 同一份 Core |

两链的行为契约已由 plan 580 对齐（D1–D10）；**剩余差异只在 transport 生命周期托管代码本身**。这份文档评估：把链 B 收敛为"Main 进程内复用同一 `MCPClient` 构造 + Core 语义、仅保留 OAuth adapter"的成本与收益。

## 2. 现状盘点：两链各自的独有面

**链 A 独有（合并时必须保留或解耦）：**

- stdio transport 构造 + env 安全层（`buildSafeEnv`）；
- `CircuitBreaker` / `CircuitBreakerManager`（D9 disposition 已解耦，breaker 只在 transport/protocol 类触发）；
- 描述注入扫描 `scanMcpDescription`；
- `MCPManager` 多 server 托管 + `apply.ts` 的 registry replace-set 接线（`setOnToolsChanged`）。

**链 B 独有（合并时必须嫁接或保留在 Main 侧）：**

- OAuth：`createStoredRemoteMcpOAuthProvider`（vault 持久化，token 永不过 IPC —— 架构红线，见 `remote-mcp.ts:115-118` 注释）；
- catalog cache：磁盘 verbatim 缓存（D4）+ 冷启动 `hydrateFromCache` 快路径 + truncated 不写缓存；
- 状态推送面：`markTransportDead` → `AppConnectionService` → renderer 通知 + 连接状态 DTO（含 optional `ledger`）；
- IPC 合同：`AppConnectionTool` ↔ `ConnectorService`（`deadlineAt` + 30s IPC buffer、五类稳定错误码、`connector_auth_required` 卡片）。

**两链重复实现（合并的直接收益来源）：**

`connect` 编排（transport.onclose/onerror 挂接、initialize、能力保存、list_changed handler 注册、首 discovery）、debounce rediscovery（链 A 500ms / 链 B 同构 coalesce）、D6 失败保 last-known、`toTool`/descriptor 边界转换。这些在两链各约 150–250 行，语义一致但代码分叉——plan 580 靠 Core 收敛了算法，没收敛编排。

## 3. 合并方案（若采纳）

目标形态：`MCPClient` 成为唯一编排器，两链只提供配置与适配器。

1. **`MCPClient` 下沉到共享包**（plugin-core 或新 `packages/mcp-client`），解耦 agent 内部依赖：
   - `logger` / `scanMcpDescription` / `CircuitBreaker` 改为可选注入（hooks 对象），默认 no-op；
   - `Tool` 形状保留在边界（`toTool` 已是 descriptor→Tool 的单点）。
2. **transport 注入升级为正式能力**：Phase 2.5 已引入 `protected buildTransport()` 缝（`mcp/index.ts`，为 lifecycle 测试而加）——合并方案将其参数化：`buildTransport(config)` 支持 stdio / streamable-http / streamable-http+authProvider 三种。
3. **链 B 变成 `MCPClient` 的一个配置面**：`RemoteMcpConnector` 收缩为 OAuth adapter + cache adapter + 状态推送桥（约剩 150 行以内），`RemoteSession` 删除，改持 `MCPClient` 实例。
4. **IPC 合同不动**：`AppConnectionTool` ↔ `ConnectorService` 的 payload/错误码/卡片语义原样保留，合并只影响 Main 进程内部。
5. **cache-first 冷启动**：链 B 的 `hydrateFromCache` 需要在 `MCPClient` 上开一个可选模式（connect 时预填 `tools` + ledger、延后/跳过首 discovery）；链 A 不启用。这是唯一的行为级新增点。

## 4. 迁移成本清单

| # | 项 | 成本 | 风险 |
|---|---|---|---|
| 1 | `MCPClient` 位置迁移 + 依赖解耦（logger/breaker/scan 注入） | 中 | 低（纯搬移，测试锁行为） |
| 2 | `buildTransport` 参数化（含 authProvider 透传给 `StreamableHTTPClientTransport`） | 小 | 低（OAuth provider 选项 SDK 原生支持） |
| 3 | cache-first 冷启动模式（hydrate + 延后 discovery） | 中 | 中（与 connect 必 discovery 的现行语义相悖，需显式模式开关 + stale 强制重拉语义保真） |
| 4 | 状态推送统一（链 A `getAllStatus` / 链 B fireReload + DTO） | 中 | 低（两套消费面都保留，仅数据源合一） |
| 5 | 链 B circuit breaker 语义引入（现在没有显式 breaker） | 小 | 中（D9 disposition 已定，但"何时计数/何时恢复"需要与链 A 对齐并真机验证） |
| 6 | 测试迁移（链 B electron 侧集成测试重建指向新结构；conformance L1–L9 不动） | 中 | 低 |
| 7 | **alias 字节稳定性**（已发出 prompt 中的 `remote_*` 别名与 `provider:<slug>` 命名空间不得因合并改变） | — | **高（红线）**——D7 已锁定派生规则，合并 PR 必须带字节快照对照测试 |
| 8 | 真机 OAuth 回归（Notion 等代表连接重跑五层基线） | 小 | 中（Phase 5 的"待用户真机执行"项正好搭车） |

总体量级：**1 个中等 plan（约等于 plan 580 Phase 2 的体量）**，无 schema/迁移、无 IPC 破坏、无 prompt-visible 字节变化（第 7 项是唯一硬约束）。

## 5. resources / prompts / elicitation 扩展时的维护成本对比

这是决策的决定性输入：MCP 规范明确向 resources / prompts / elicitation 演进，每个能力都意味着一整套"handler 注册 + 通知订阅 + 缓存 + 模型面注入 + 错误分类"。

| 场景 | 双链现状 | 合并后 |
|---|---|---|
| 新增 1 个 capability（如 resources） | 两链各实现一遍：链 A ~x 行 + 链 B ~x 行 + 状态推送 + 两份测试（≈2×） | `MCPClient` 一处实现，两链自动获得（≈1×）；OAuth/cache 适配层各自小改 |
| 通知类协议扩展（`resources/list_changed` 等） | 每链各挂一套 debounce + 事务性 refresh（plan 580 刚在两链各写过一遍 tools 版本） | 一套 debounce + refresh 骨架复用 |
| 行为漂移风险 | 每个修复需双写双验（580 的教训：D8 last-mile 不共享时两链结果面分叉） | 单点修复 |
| 链 B 附加面 | 每能力都要 Main 侧缓存 + 状态推送决策 | 缓存/推送留在 adapter 层，不随能力数增长 |

结论：**能力扩展次数 N≥1 时合并即开始赚，N=3（resources/prompts/elicitation）时双链维护约为合并后的 2.5–3×**。与现状正相关的事实：elicitation 已在 SDK 1.30 类型面出现，扩展是时间问题。

## 6. 反对意见（如实记录）

- 链 A 在 worker、链 B 在 Main —— 合并后 `MCPClient` 所在包会被两个进程各自打包（agent bundle + electron main），包边界与 `better-sqlite3` ABI 问题无关（Core 无原生依赖），但构建脚本（`bundle:agent`）需确认无副作用。
- "每链一份 ledger/编排"也提供了故障域隔离：合并后 Main 内的 client 缺陷会同时影响两条链。580 的 D9/disposition 语义与 conformance harness 使该风险可控。
- 近期无 resources/prompts 落地 plan 的话，合并可延后到第一个此类 plan 立项时（合并成为该 plan 的 Phase 0）。

## 7. 建议

**通过，但不立即执行**：触发条件取其一 —— (a) 第一个 resources/prompts/elicitation plan 立项；(b) 链 B 出现需要双写编排的缺陷修复。届时以本文档 §3 方案 + §4 清单为蓝本开执行 plan（编号顺延），验收门槛直接引用 AGENTS.md Gates 的 conformance L1–L9 行 + alias 字节快照对照 + Notion 真机基线。

## 8. 若通过的执行 plan 骨架（供顺延参考）

1. `MCPClient` 下沉 + 依赖注入化（行为不变，链 A 测试全绿为门）；
2. `buildTransport(config)` 参数化 + authProvider（链 B 换内核，IPC 合同不变）；
3. cache-first 模式（hydrate 语义测试 + stale 强制重拉）；
4. 状态推送合一（DTO optional 字段全兼容）；
5. conformance L1–L9 + alias 字节快照 + Notion 真机五层基线。
