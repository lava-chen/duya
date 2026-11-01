# 616 — duya_app 内置 MCP 层（产品能力从基础工具集剥离）

> **状态**：进行中（2026-10-20：T610a / T610b / T610n / T610e 权限层已交付，PR #318）
> **归属**：独立计划（与 [610 架构收口系列](./610-architecture-series/README.md) 正交）
> **前置**：[580 MCP 能力核收敛](./580-mcp-capability-core-convergence.md)（catalog/exposure/tool_invoke 机制）、[452 MCP Direct 暴露](./452-mcp-direct-and-plugin-unification.md)（暴露开关）
> **用户决策**（2026-10-19）：canvas 系列 + bot 系列 + browser 系列工具，从常规注册工具改为 **内置 MCP server `duya_app`** 的工具；只保留基础工具在常规工具集。
> **用户决策**（2026-10-20）：**canvas 系列不再由 616 迁移**——即将从 app 内部剥离、改为对外提供服务，由他人负责。616 保留的是**共享面**（命名空间反解 + 权限 + profile 规则），不是某一类工具的注册面。
> **决策修订（2026-10-22）**：Browser、Computer Use、Conductor Canvas 均改由独立计划 [外置能力迁移](./2026-10-22-external-capability-migration.md) 推进；不要执行本文中将 Browser / Computer Use 注册到 `duya_app` 的旧 T610d / T610d2 描述。616 的 MCP 基础设施、bot 和其余产品能力范围按各自验收继续。

## 0. 一句话

今天 duya 把「文件系统 + shell」和「画布 + bot 通道 + 浏览器」放在**同一层**注册，模型看到的
是一坨 48 个工具的扁平列表；产品能力越多，基础工具集的边界越糊。Codex 的答案是
**app = 一个 host-owned MCP server**，工具进 `codex_apps__` 命名空间，走 deferred 暴露 +
`tool_search` 发现。本期把 duya 的产品能力收进一个同构的 `duya_app` 内置 MCP server。

## 1. Codex 参照（已核实源码，非转述）

参照源：`E:\cloned-projects\codex\codex-rs`（本地克隆，commit `2df6705423`，2026-08-24）。

| # | 事实 | 位置 |
|---|---|---|
| R1 | **app 就是一组 MCP 工具**。提示词原文：`An app is equivalent to a set of MCP tools within the codex_apps MCP.` | `core/src/context/apps_instructions.rs:32` |
| R2 | `codex_apps` 是 **host-owned** MCP server，由 core 注册（不是用户配置），指向 ChatGPT 后端 HTTP 端点 | `core/src/mcp.rs:249` → `codex-mcp/src/mcp/mod.rs:524` |
| R3 | 工具命名 `codex_apps__<connector>.<tool>`（namespace 形式），connector 前缀从 callable name 上剥掉 | `codex-mcp/src/codex_apps.rs:61` / `:31` |
| R4 | **真正的分层是 trusted vs external，不是「有无 MCP」**。`register_trusted` 重名 panic；`register_external` 重名**跳过不覆盖**；`exec_command`/`shell_command` 保留名直接拒绝 | `core/src/tools/registry.rs:302` / `:336` / `:472` |
| R5 | 外部工具重名**不覆盖**内置，且 `is_third_party_tool` 注释明说：*A built-in stays false even if a client's tool has the same name.* | `core/src/tools/registry.rs:91` / `:365` |
| R6 | 暴露分档 `ToolExposure`：Direct / Deferred / DeferredModelOnly / DirectModelOnly / CodeModeOnly / Hidden。Direct 进 `tools[]`，Deferred 要靠 `tool_search`(BM25) 加载 | `tools/src/tool_executor.rs:51` / `core/src/tools/handlers/tool_search_spec.rs:97` |
| R7 | app 策略 `AppToolPolicy { enabled, approval }` 按 **config layer stack** 解（System→Enterprise→User→Project），`apps_config_from_layer_stack` 读 `effective_config()["apps"]` | `connectors/src/app_tool_policy.rs:11` / `:40` / `:96` |
| R8 | **Codex 的 app 全是远程的**。本地能力（computer_use / browser_use）是独立子系统 + 独立 feature flag，**不走 app/connector 层** | `codex-rs/features/src/lib.rs:1684-1740`；`config/src/computer_use.rs:9` |
| R9 | `connector_tool_is_synthetic`：宿主合成的「账号链接」伪工具，排除在 app 列表和 runtime 投影之外 | `connectors/src/runtime_projection.rs:93` / `:47` |

### 1.1 与用户预期的偏差（已与用户对齐）

用户原话是「像 codex 那样，把桌面端特殊能力做成 app 工具提供」。**Codex 没有这个形态**：
它的 app 层是纯远程的（ChatGPT 后端），本地能力走另一套 feature-flag 子系统。

Codex **可借鉴**的部分是它的**形状**，不是它的位置：
- 一个 **host-owned** 的 MCP server（不是用户配置、不是插件声明）
- 工具进**独立命名空间**，与基础工具集物理隔离
- 走 **deferred 暴露 + 发现** 而不是常驻 `tools[]`
- 与基础工具**重名不覆盖**（trusted 优先）

Codex **不可直接照搬**的部分：app 是远程的。duya 的 canvas/bot/browser 是**本地进程内**能力，
所以 `duya_app` 必须是**进程内** MCP server，不能起子进程。

## 2. duya 现状（2026-10-19 实测）

### 2.1 注册面

真注册表在 `packages/host/src/worker-tools/builtin.ts:46`（`packages/agent/src/tool/builtin.ts`
只是 36 行转交 shim）。bot 侧另有一份 `packages/host/src/worker-tools/bot-builtin.ts:57`。

当前注册的 48 个工具里，**基础工具**只有 6 个文件系统 + shell + todo + task 等十来个，
**产品能力**占了大半：canvas 16 个（经 conductor mode 注入，见 §2.3）、bot 系列 8 个、
browser / computer_use / vision / image_generate / widget / module / duya_cli 等。

### 2.2 已有的 MCP 管道（可复用，不必新造）

| 能力 | 位置 | 状态 |
|---|---|---|
| MCP client + manager | `packages/capabilities/src/MCP/MCPManager.ts` | 可用，transport 仅 `stdio` / `streamable-http` |
| transport 注入点 | `MCPManager.ts:330` `protected buildTransport()` | **已是 protected 注入点**，测试已用 `InMemoryTransport`（`packages/capabilities/tests/mcp/lifecycle-inmemory.test.ts`） |
| 内部键 / 模型可见名 | `MCPManager.ts:838` `mcp__<server>__<tool>` → `computeProviderName` | 现成 |
| 延迟暴露 | `packages/agent-runtime/src/tools/catalog/catalog-types.ts:3` `eager\|deferred\|hidden` | 现成 |
| 工具发现 | `packages/agent-runtime/src/tools/discovery/ToolCatalogTool.ts` | 现成（query / namespace / tool_id 三模式） |
| 延迟调用 | `packages/agent-runtime/src/tools/discovery/ToolInvokeTool.ts` | 现成 |
| 稳定 tool_id | `packages/agent-runtime/src/tools/catalog/catalog-identity.ts:20` | 现成 |
| 权限门（bundled 免审批） | `packages/agent-runtime/src/authorization/permissions/permissions.ts:243` | 现成 |
| 8KB schema 预算 | `packages/agent-runtime/src/tools/catalog/spec-budget.ts:19` | 现成 |
| 原子替换 | `registry.ts:411` `replaceByOwner` | 现成，owner 三态 `'non-mcp' \| 'mcp' \| connector:<id>` |

### 2.3 真实约束（读出来的，不是猜的）

**C1 — 上下文穿透。** MCP `tools/call` 只带 `name` + `arguments`，而 canvas/bot 工具需要活的
`ToolUseContext`：`ipcRequest`（函数）、`options.sessionId`、`conductorCanvasId`、
`canvasTarget`（可变状态）、`abortController`。
**已实测可行**：`tools/call` 的 `params._meta` 可以携带**任意活对象**（SDK 的
`CallToolRequestSchema` 允许 `_meta` 且为 `z.core.$loose`；`InMemoryTransport` 是同进程
内存队列，不做 JSON 序列化）。实测服务端拿到 `live.ipcRequest` 是 `function`、
`live.sessionId` 是 `'sess-42'`。

**C2 — renderer 认不出改名后的 canvas 工具。**
`apps/desktop/src/renderer/components/chat/tools/rows/ToolActionRow.tsx:201` 与
`tools/registry.ts:360` 都靠 `name.startsWith('canvas_')` 匹配；改名成
`mcp_duya_app_canvas_manage` 后全部落进通用 MCP 行，`CanvasConductorToolRow.tsx:48-74`
那套中文动词映射（`正在绘制画布元素` 等）全废。

**C3 — profile 的 allow/deny 规则失配。**
`packages/host/src/worker-profiles/types.ts:91` 写的是 `'canvas:*'` / `'duya:*'`。
`matchToolPattern`（`packages/agent-runtime/src/authorization/tool-filter.ts:13`）只支持
前缀/后缀通配，新名 `mcp_duya_app_canvas_manage` 不匹配任何 pattern → 该禁的没禁。

**C4 — canvas 的权限短路失效。**
`permissions.ts:198` `isCanvasTool` 认 `canvas_` 前缀，新名不匹配 → canvas 工具从
「无条件 allow」掉进通用审批路径。

**C5 — bot 工具的无条件放行失效。**
`permissions.ts:66` `GLOBAL_ALWAYS_ALLOWED_TOOLS` 含 `'SendMessage'` / `'MessageSession'`
（注意：`'SendMessage'` 与实际 wire name `send_message` **大小写本来就不一致**，这条规则
今天对 `send_message` 就已经失效）。改名后这批放行会彻底失效。

**C6 — canvas 工具不在 builtin registry 里。** 它们由 conductor mode 通过
`overrideFilter: true` 注入（`packages/host/src/worker-modes/modifiers/conductor-mode.ts:59`），
走的是 mode 注入路径而非 MCP 注册路径。

**C7 — 渲染层拿不到 `mcpInfo`。** `ToolAction`（`tools/types.ts:22`）只有
`name` / `input` / `result` / `metadata`；`mcpInfo` 不进 renderer 载荷
（`packages/host/src/worker-session-runtime.ts:2050` 只在 worker 内部用）。
→ 路由匹配不能依赖 `mcpInfo`，得靠一个**可从工具名反解**的稳定标识。

**C7b — 但模型可见名是【可逆】的，这解掉了 C2–C5 的全部匹配问题。**（2026-10-20 实测）

用生产分配器 `computeProviderName` 实测，`duya_app` 的工具名是**纯前缀拼接**、无截断无
哈希无去重后缀：

```
canvas_manage  => mcp_duya_app_canvas_manage
send_message   => mcp_duya_app_send_message
browser        => mcp_duya_app_browser
computer_cua   => mcp_duya_app_computer_cua
manage_routine => mcp_duya_app_manage_routine
```

（`duya_app` 的 scoped server name 无 `:`，不触发 `plugin:` 命名空间分支；工具名本身不含
`__`，不触发 `__2` 去重后缀；`mcp_duya_app_` 前缀 13 字符 + 最长工具名，远低于 64 上限，
不触发哈希截断。）

**因此 C2–C5 有一个统一解法**：加一个纯函数
`resolveAppToolBaseName(modelVisibleName): string | undefined`
——命中 `mcp_duya_app_` 前缀就剥掉返回原名，否则返回 `undefined`。renderer 路由、
profile allow/deny 匹配、`isCanvasTool` 权限短路三处**共用这一个函数**，而不是各写一遍
前缀判断。

**这个函数必须放在 `packages/capabilities`（或更低的共享包）**：renderer（`apps/desktop`）
与权限（`packages/agent-runtime`）都要用，而 `apps/desktop` 不依赖 `packages/agent-runtime`。

**C8 — 上下文穿透：AsyncLocalStorage 可行，且优于 `_meta` 走私。**（2026-10-19 实测）

MCP `tools/call` 只带 `name` + `arguments`，而 canvas/bot/browser 工具需要活的
`ToolUseContext`（`ipcRequest` 函数、`options.sessionId`、`conductorCanvasId`、
`canvasTarget` 可变状态、`abortController`）。两条路都实测过：

| 方案 | 实测结果 | 判定 |
|---|---|---|
| `params._meta` 带活对象 | 服务端拿到的 `live.ipcRequest` 是 `function`、`live.sessionId` 是 `'sess-42'` | 可行，但把宿主上下文塞进协议字段，绕过 schema 校验，且 `_meta` 是 JSON-RPC 规范里的公开字段——外部 server 也会看到它 |
| **AsyncLocalStorage** | 服务端 `als.getStore()` 拿到完整 store；**5 个并发调用各带各的 context，穿过 `await` 无泄漏**（`before=X after=X` 五路全对） | **采纳** |

ALS 的关键性质：store 随 async 上下文自动传播，**并发调用天然隔离**（每个调用各自
`als.run()`），不需要任何显式传参，也不污染 MCP 协议。`duya_app` 与 worker 同进程，
ALS 天然成立——这正是「进程内 MCP」相对「spawn 子进程」的决定性优势。

配套约束：ALS 只能穿透**同进程**。若将来 `duya_app` 改为子进程，ALS 失效，必须回退到
显式传参。T610a 的验收命令里要钉住这一点。

## 3. 目标形态

```
duya_app  ← host-owned 进程内 MCP server（不 spawn 子进程；ALS 穿透上下文）
  ├─ canvas_*        16 个   （从 conductor mode 注入改为 MCP 工具）
  ├─ bot 系列         8 个   （send_message / send_to_agent / post_to_room /
  │                          ReactToMessage / create_agent / update_agent /
  │                          manage_routine / list_app_connectors+connect_app）
  ├─ browser          1 个   （30 个 operation，走 action registry）
  └─ 其余产品能力     17 个   （见 §3.1「其余产品能力」的归属决议）

基础工具（留在常规注册层，wire name 一字不改）
  bash / powershell / read / write / edit / apply_patch / glob / grep
  todo / task / get_task_output / kill_task
  EnterPlanMode / ExitPlanMode / SwitchMode / AskUserQuestion / Skill
  tool_catalog / tool_invoke
```

### 3.1 「其余产品能力」的归属决议（补 617 §1 的归属缺口）

[617 — 基础工具接口 v2](./617-basic-tool-interface-v2.md) §1 指出：616 §3 的基础工具清单
只列了 17 个，**另有一批工具既没进 `duya_app`、也没留在基础清单**，616 落地后会悬空。
那批工具是（`packages/host/src/worker-tools/builtin.ts:64-139` 的实际注册面）：

| 工具 | 现状 | 决议 | 理由 |
|---|---|---|---|
| `computer_use` `computer_cua` | builtin 注册 | **进 `duya_app`** | OS 控制 = 桌面端产品能力，与 browser 同性质 |
| `vision_analyze` `image_generate` | builtin 注册 | **进 `duya_app`** | 多模态产品能力 |
| `show_widget` `read_module` | builtin 注册 | **进 `duya_app`** | UI 渲染面 |
| `duya_cli` | builtin 注册 | **进 `duya_app`** | duya 产品控制面（插件/skill/session/MCP 管理） |
| `session` `MessageSession` `SessionSearch` | builtin 注册 | **进 `duya_app`** | 会话面 = 产品能力 |
| `Brief` | builtin 注册 | **进 `duya_app`** | 项目简报 = 产品能力 |
| `memory_write` `write_stage1_policy` | builtin 注册 | **进 `duya_app`** | 记忆面 = 产品能力（616 §6 不改记忆机制，只改暴露位置） |
| `plan` | builtin 注册 | **进 `duya_app`** | 计划面 = 产品能力 |
| `update_state` | builtin 注册 | **进 `duya_app`** | 产品状态写入 = 产品能力 |
| `send_artifact` | builtin 注册 | **进 `duya_app`** | 产物投递 = 通道能力 |
| `wait_tasks` | **今天未注册**（`worker-tool-bindings/wait-tasks.ts` 有实现但 `builtin.ts` 没注册） | **保持未注册**，但**归入 `duya_app` 命名空间**（一旦注册就是 `mcp_duya_app_wait_tasks`） | 617 §1 已点名；不借 616 顺手注册新工具（那是 617 的范围） |

**判据**：工具的作用对象决定归属。
**作用在文件系统/shell/会话内的 → 基础工具**（模型每轮都要用，进 `tools[]`）；
**作用在 duya 自身产品面上（画布/消息通道/OS/多模态/UI/记忆/计划/CLI/会话）的 → `duya_app`**
（产品能力，按需发现）。

**分界线不是「危险」而是「是不是每轮都要用」**——这是与 Codex 的差别：Codex 把 app
（远程第三方）整体划出基础层；duya 的产品能力是本地的，但同样不该每轮占着 `tools[]` 的预算。

**617 依赖本决议**：617 改的是基础工具的界面形状（schema、命名、暴露），
616 改的是产品能力的位置。两者正交，但 617 的「基础工具」清单以本节为准。

| 维度 | 值 |
|---|---|
| 内部键 | `mcp__duya_app__<tool>` |
| 模型可见名 | `mcp_duya_app_<tool>` |
| 稳定 tool_id | `mcp:duya_app:<tool>`（`catalog-identity.ts:20` 既有形状） |
| 发现 | `tool_catalog` 的 `namespace: 'duya_app'` 模式列出全部；`query` 模式按标签搜 |
| 暴露 | 走**既有** `[tools] exposure` 开关（`worker-config/tool-exposure.ts`）：默认 `hint`→eager，开 `search`→deferred。与普通 MCP 工具同一套开关，不新增配置面 |
| 权限 | **不用 `source: 'bundled'`**——见 C9。`duya_app` 走一个**新的 source 维度**，保留灾难检查与宿主开关 |
| 上下文 | AsyncLocalStorage（见 C8），不污染 MCP 协议 |
| 路由匹配 | 从 `mcp_duya_app_` 前缀反解原名，**不依赖 `mcpInfo`**（C7） |

## 3.1 权限：`duya_app` 不能用 `source: 'bundled'`

**C9 — `source: 'bundled'` 会短路掉两道安全检查。**（2026-10-19 实测代码路径）

`hasPermissionsToUseTool`（`packages/agent-runtime/src/authorization/permissions/permissions.ts:293`）
的 step 0 是：

```ts
const source = context.source
if (source) {
  return decideMcpSource(source, appState.toolPermissionContext.mode, toolName)
}
```

`decideMcpSource` 对 `bundled` 直接返回 `allow`（`permissions.ts:243`）。**短路发生在 step 0**，
意味着后面这些**全部不执行**：

| 被跳过的检查 | 位置 | 对 `duya_app` 的后果 |
|---|---|---|
| 灾难安全边界 | step 4.7 `isCatastrophicToolCall` | browser 的 `evaluate`（任意 JS）、canvas 的 `delete` 都可能命中灾难模式 |
| 宿主常驻权限开关 | step 4.8 `hostToolPermission`（`ask`/`always`/`never`） | 用户在设置里按「永不询问」或「永不」时，`duya_app` 工具**不受约束** |
| 风险档位门 | step 4.5 `riskTier` | `manage_routine`（定时任务）、`send_message`（对外发消息）失去档位约束 |

而 `duya_app` 里的 bot 工具**能对外发消息**（`send_message` 直发飞书/Telegram、
`post_to_room` 发房间、`manage_routine` 建定时任务）——比 canvas 危险得多。
今天这些工具在**普通工具**路径上，是过完整权限链的（`GLOBAL_ALWAYS_ALLOWED_TOOLS` 只放行
`SendMessage`/`MessageSession` 这几个明确项，`manage_routine` 等走完整链）。

**结论**：`duya_app` 需要一个**新的 source 值**，语义是「自家 app 能力，但仍受灾难检查与
宿主开关约束」——即在 `decideMcpSource` 里新增一个分支，**不**在 step 0 短路，而是
**继续往下走完整条链**。

| source | 语义 | step 0 行为 |
|---|---|---|
| `bundled` | 打包的外部 MCP server（Codex 语义：第一方可信） | 短路 allow |
| `settings` | 用户显式配置的 MCP server | 短路 allow |
| `plugin` / `local` / `unknown` | 第三方 | 短路 ask |
| **`app`（新增）** | **duya 自己的 app 能力** | **不短路**——继续走灾难检查 / 宿主开关 / 风险档位 / 分类器 |

`app` 落在链条的哪一档，由 T610e 逐个工具定：canvas 走 `isCanvasTool` 的无条件 allow
（现状不变），bot/browser 走完整链（现状不变）。**换句话说：`app` 这个 source 的作用是
「不因变成 MCP 就丢掉安全检查」，不是「给一批新工具开后门」。**

## 4. 分期（每期独立可交付、独立可回滚、≤400 行生产改动）

| 卡 | 交付 | 独占路径 | 首个失败证据 |
|---|---|---|---|
| **T610a** ✅ | `duya_app` 进程内 MCP server 骨架：`MCPManager` 支持 `transport: 'in-process'`，`duya_app` server 起来、`tools/list` 返回工具、连接成功 | `packages/capabilities/src/MCP/**`、`packages/capabilities/src/AppServer/**` | `packages/capabilities/tests/mcp/in-process-app-server.test.ts`：「in-process transport 能 connect 并列出工具」— 今天 `MCPServerConfig.transport` 只有 `'stdio' \| 'streamable-http'`，编译期即红 |
| **T610b** ✅ | 上下文穿透管道：ALS 承载活 `ToolUseContext`；`duya_app` 工具能读到 `ipcRequest` / `sessionId`，并发调用不串 | `packages/capabilities/src/AppServer/**`、`packages/capabilities/src/MCP/MCPManager.ts`、`packages/agent-runtime/src/tools/mcp-executor.ts` | `packages/capabilities/tests/mcp/in-process-app-context.test.ts`：「canvas 风格工具在 server 侧能拿到 ipcRequest 函数」+「5 个并发调用各自拿到自己的 context」— 今天无任何通道 |
| **T610n** ✅ | `duya_app` 工具命名空间：从模型可见名反解原名的**共享纯函数**（C7b）——renderer 路由 / profile 规则 / 权限短路三处共用一个判定，不各写一遍前缀判断 | `packages/capabilities/src/AppServer/app-tool-namespace.ts` | `packages/capabilities/tests/mcp/app-tool-namespace.test.ts`：「`mcp_duya_app_canvas_manage` 反解回 `canvas_manage`」+「用户自建 server `duya_app_lit` 的同名族不被误认」 |
| **T610c** ⛔ | canvas 16 工具迁入 `duya_app`。**2026-10-20 用户决策：canvas 系列不再由 616 承担**——即将从 app 内部剥离、改为对外提供服务，由他人负责。616 只保留命名空间 / 权限 / profile 规则这套**共享面**，不承担 canvas 的注册面迁移与 renderer 路由 | — | — |
| **T610d** | bot 8 工具 + browser 迁入 `duya_app` | `packages/host/src/worker-tool-bindings/**`、`packages/host/src/worker-tools/**`、`packages/capabilities/src/BrowserTool/**` | registry 快照断言：bot/browser 工具的 owner 是 `mcp` 且内部键前缀是 `mcp__duya_app__` |
| **T610d2** | §3.1 的其余 17 个产品能力迁入 `duya_app`（computer_use/cua、vision、image_generate、widget、module、duya_cli、session、MessageSession、SessionSearch、Brief、memory_write、write_stage1_policy、plan、update_state、send_artifact） | 同 T610d | 同 T610d；断言「基础工具清单之外的注册工具全部落在 `mcp__duya_app__` 前缀下」 |
| **T610e** ✅ | 权限 / profile 规则改用**反解后的原名**匹配（C2–C5 收口）+ 新增 `source: 'app'` 分支（C9）。**已交付**（PR #318，§4.5）：`source: 'app'` 不短路灾难检查；无条件放行改由**宿主注册身份**授权而不是从名字推断；规则对**三种拼写**匹配（原名 / 模型可见名 / registry 内部键）。**剩 renderer 那半**（新名 → 专属行路由） | `packages/agent-runtime/src/authorization/**`、`packages/capabilities/src/permissions/**`、`packages/host/src/worker-profiles/types.ts` | profile 规则 `'canvas:*'` 在新名下仍能 deny；`isCanvasTool` 对新名仍返回 true；`source: 'app'` 不短路灾难检查 |

**C2–C5 必须落在 T610c/e，不能拖到最后**——否则 T610c 一改名，renderer 和权限立刻回归，
中间态比改造前更糟。

### 4.1 T610b 交付记录（2026-10-20）

**生产改动**（3 个文件，~120 行）：

| 文件 | 改动 |
|---|---|
| `packages/capabilities/src/AppServer/app-tool-context.ts` | 新建。ALS 存取对：`withAppToolContext(value, fn)` / `currentAppToolContext<T>()`。**按引用存，不拷贝**——canvas 工具会原地改写 context（`context.canvasTarget = {}`），拷贝会静默丢这些改动；并发隔离由 ALS 自身提供，不靠拷贝 |
| `packages/capabilities/src/AppServer/in-process-app-server.ts` | 加 `tools/call` 处理器：查表 → 读 ALS context → 执行 capability 工具 → 回 MCP 结果。工具定义从「只广告」升级为「可执行」（`AppServerTool.execute`） |
| `packages/agent-runtime/src/tools/mcp-executor.ts` | **生产接线点**：`invoke(input)` 被包进 `withAppToolContext(context, …)`。选这里是因为**每一次 MCP 工具调用都经过这个 executor**——eager 直调与 deferred（`tool_invoke` → dispatcher → executor）两条路都覆盖到，且只有一处。（合入 master 后 master 新增了 `guardedInvoke`——调用前的授权复核——ALS 包装因此落在 `guardedInvoke` **内部**：`beforeInvoke` 是宿主侧的授权检查，发生在工具存在之前，不该看到工具的 ambient context） |
| `packages/capabilities/src/MCP/MCPManager.ts` | `MCPClient.callTool` 重建 `ToolResult` 时补回 `result.metadata`（见下 C10） |

**测试**（8 用例，跨两个包）：
- `packages/capabilities/tests/mcp/in-process-app-context.test.ts`（6）：机制层——server 侧读到活 context / 5 个并发调用各自隔离 / 无 context 时优雅降级 / 穿过 `await` 不丢 / app server 真的执行 capability 工具 / metadata 往返保真。
- `packages/agent-runtime/test/tools/execution/mcp-executor-app-context.test.ts`（2）：**生产接线层**——经由真正的 `createMCPToolExecutor` 建立的 scope 能被 server 侧读到，且并发不串。

### 4.2 T610b 的两个实测结论

**C10 — `ToolResult.metadata` 原本不穿 MCP 往返（已修）。**

`MCPClient.callTool` 从 MCP 结果重建 `ToolResult` 时，只搬了 `content` / `structuredContent`，
**丢掉了 `metadata`**。而 renderer 的富行（browser 的 `browserResults`、CUA 的 `cuaApp`、
vision 预览）正是从 `tool.metadata` 读的——**任何工具迁进 `duya_app` 都会掉渲染**。

实测：MCP 结果 schema 是宽松的（`metadata` 能过线），所以**丢的是重建那一步，不是协议**。
修法：`MCPClient.callTool` 重建时把 `result.metadata` 抄回 `ToolResult.metadata`。

**C11 — `duya_app` 的工具结果不能只回文本。**

capability 工具的 `ToolResult` 有 `result`（文本）/ `metadata` / `structured` / `error` 四个面。
app server 的 `tools/call` 必须逐个映射，不能只回 `content[].text`：
`metadata` → 结果的 `metadata`（配合 C10 的修法往返保真）、`structured` → `structuredContent`、
`error` → `isError`。

### 4.3 T610n 交付记录（2026-10-20）

**生产改动**（1 个文件，~110 行）：

| 文件 | 改动 |
|---|---|
| `packages/capabilities/src/AppServer/app-tool-namespace.ts` | 新建。`DUYA_APP_SERVER_NAME` / `DUYA_APP_TOOL_PREFIX`（`mcp_duya_app_`）/ `DUYA_APP_TOOL_NAMES`（42 条封闭清单）/ `resolveAppToolBaseName(modelVisibleName): string \| undefined` / `isAppToolName(name)` |

**测试**（`packages/capabilities/tests/mcp/app-tool-namespace.test.ts`，5 用例）：前缀反解 → 非
`duya_app` 名返回 `undefined` → **`duya_app_lit` 这类用户自建 server 不被误认**（前缀相同但
base name 不在封闭清单里）→ 清单内 42 个名字逐个可反解 → 边界（`mcp_duya_app_` 本身不命中）。

**C12 — 为什么判定用「封闭清单」而不是「只看前缀」。**
前缀 `mcp_duya_app_` 本身是**歧义**的：用户自建的 MCP server 叫 `duya_app_lit` 时，它的工具
同样以 `mcp_duya_app_lit_` 开头，也就同样以 `mcp_duya_app_` 开头。只看前缀会把外部工具
误认成我们的 app 工具——而这个误认的后果是**权限短路**（`isCanvasTool` 命中就无条件放行）。
所以判定必须落在**我们自己服务的那批工具名**上。

**C13 — 42 条清单对着实际注册面逐条核过。**
清单不是照抄 plan §3 的表格，而是对着真实注册面核出来的：canvas 16 = `packages/capabilities/src/canvas/`
的 16 个 `TOOL_NAME`（含 `database_manage`——`isCanvasTool` 把它算作 canvas 家族）；bot 8 =
`agent-management-tool.ts` / `AppConnectorManageTool` / `SendMessageTool` 等的 `*_TOOL_NAME`
常量；其余 17 = `packages/host/src/worker-tools/builtin.ts:64-139` 的实际注册面。
**注意 `send_message` 是小写**（`SEND_MESSAGE_TOOL_NAME`），而 `BOT_TOOLSET` 里那个
`SendMessage` 是另一个更早的名字——按注册面写，不按记忆写。

**未做**（留给后续卡，按设计如此）：本卡只交付**判定的共享面**。谁调用它——renderer 路由
（T610c）、profile 规则与权限短路（T610e）——留给那些卡。

### 4.4 权限层按原名匹配（2026-10-20，C3–C5 的前半）

`resolveAppToolBaseName` 的第一个消费者：**权限层与 profile 规则**改成按**原名**匹配，
而不是按模型可见名。

| 文件 | 改动 |
|---|---|
| `packages/capabilities/src/AppServer/app-tool-namespace.ts` | 加 `appToolOriginalName(name)`：是 app 工具就返回原名，不是就返回自己。调用方可以无条件用它 |
| `packages/agent-runtime/src/authorization/permissions/permissions.ts` | `isCanvasTool` 先反解（canvas 的无条件 allow 才不失效）；`GLOBAL_ALWAYS_ALLOWED_TOOLS` 先反解；`toolMatchesRule` 按原名比对精确规则 |
| `packages/agent-runtime/src/authorization/tool-filter.ts` | `anyPatternMatches` 先按可见名、再按原名匹配通配 pattern；deferred 工具的「精确名提升」与 allowlist 门也认原名 |

**为什么这一步不能等**：命名空间如果只在渲染层被认出来、权限层不认，那它就不是命名，
是**绕过**——一条写给 `canvas_manage` 的 deny 规则会在工具搬到 `mcp_duya_app_` 后面
的那一刻失效。所以反解必须先于任何工具迁移落地。

**C14 — profile 里写的 `'canvas:*'` 今天就是个 no-op。**
`matchToolPattern` 的 `:*` 分支取前缀 `canvas:`，而画布工具的真名是 `canvas_manage`
（下划线）。`'canvas:*'` 既不匹配旧名也不匹配新名——**今天如此，改名之后也如此**。
这不是本次改动引入的，但它意味着 plan §C3 举的那个例子并不成立；真正生效的是
`'canvas_*'` 这类 pattern，以及按原名写的精确规则。**记在这里，是为了让 T610e 改
profile 规则时不要以为 `'canvas:*'` 今天在生效。**

**C15 — `'SendMessage'` 与 wire name `'send_message'` 大小写不一致，这条放行今天就失效。**
`GLOBAL_ALWAYS_ALLOWED_TOOLS` 写的是 `'SendMessage'`，实际注册名是 `send_message`
（`SEND_MESSAGE_TOOL_NAME`），`LEGACY_TOOL_NAME_ALIASES` 也没有这一条映射。
本次改动**不动它**：反解只让「原名在集合里」的工具继续放行，`'SendMessage'` 与
`'send_message'` 大小写不同这件事和命名空间无关，是既有的独立缺陷。修它等于给一个
能对外发消息的工具开 unconditional allow，属于要单独裁定的权限变更，不该顺手带上。

**测试**（`packages/agent-runtime/test/authorization/app-tool-rule-resolution.test.ts`，
11 用例）：画布短路在命名空间名下仍然 allow / always-allowed 集合仍然 allow / 精确 deny
规则按原名仍然 deny / 画布短路仍然**先于**用户规则（既有次序没被挪动）/ profile 的
`canvas_manage` 与 `canvas_*` 通配对新名生效 / deferred 工具按原名提升 / 调用方 denylist
按原名生效 / 非 app 工具不受影响。

### 4.5 T610e 交付记录（2026-10-20，PR #318）

权限层这半已交付。审查中查出一个**真实漏网路径**，同卡修掉（见 C17）。

**生产改动**：

| 文件 | 改动 |
|---|---|
| `packages/capabilities/src/AppServer/app-tool-namespace.ts` | 加 `AppToolRegistration` / `isTrustedAppToolRegistration` / `APP_TOOL_SOURCE = 'app'`。**授权读注册身份，不读名字** |
| `packages/capabilities/src/MCP/ports.ts`、`MCP/MCPManager.ts`、`packages/host/src/worker-run-contracts.ts`、`packages/agent-runtime/src/tools/catalog/registry.ts` | `source` 维度加 `'app'` |
| `packages/agent-runtime/src/authorization/permissions/permissions.ts` | 规则双向匹配；`canUseAppNameShortcut` / `isCanvasTool` 改按注册身份授权；`decideMcpSource('app')` 返回 `undefined`（不短路，继续走完整链） |
| `packages/agent-runtime/src/authorization/permission-gate.ts` | `makeAppToolRegistrationLookup(registry)`：从 registry 的 `mcpInfo` 读出注册身份，注入权限上下文 |
| `packages/agent-runtime/src/tools/mcp-executor.ts` | `decision?.behavior === 'deny' / 'ask'`——`undefined` = 无裁决，**不二次弹窗也不绕过** |

**C16 — 模型可见名不是唯一键，授权不能从名字推断。**
分配器把 `__` 折叠成 `_`，所以 `server=duya_app, tool=canvas_manage` 与
`server=duya, tool=app_canvas_manage` **分配到字节相同的 `mcp_duya_app_canvas_manage`**。
第三方 server 因此能「冒名」我们的名字——按名字放行，等于把 app 层的无条件 allow 送给它。

解法分两层，缺一不可：
- **名字**只用于**规则匹配**（用户写 `canvas_manage`，规则必须继续指认 canvas 工具）；
- **授权**（无条件 allow、always-allowed 集合）读**宿主注册的身份**
  （`mcpInfo.serverName === 'duya_app' && mcpInfo.source === 'app'`）。

注册身份怎么到权限链：`applyMCPConfiguration` 用 `capturedMcpInfo.source` 建
`createMCPToolExecutor`，并以 `internalKey` 注册进 registry（definition 带 `mcpInfo`）；
`worker-session-runtime` 把同一个 registry 交给 `buildPermissions`；`ToolRegistry.findEntry`
内部键与模型可见名都能命中。

**实测事实（别照抄旧结论）**：统一权限链的 step 0（`context.source`）在生产路径
**从未被赋值**——宿主 `buildPermissions` 注入的 context 没有 `source` 字段，那段是死代码。
**生产里真正生效的 source 闸是 MCP executor**（`tools/mcp-executor.ts`），它按 `mcpInfo.source` 裁决。
PR #318 的测试把这个事实钉住了。

**C17 — deferred 路径按内部键走权限链，规则与短路双双失效（本卡修掉）。**
`tool_invoke` → `dispatcherFromRegistry.ts` 用 `current.internalName`（registry 内部键
`mcp__duya_app__canvas_manage`）调 `checkPermission`，而反解只认模型可见名
`mcp_duya_app_canvas_manage`。结果：**按原名写的 deny 规则静默失效**（规则还在设置里，
但不保护任何东西），无条件放行也退化成 ask。

修法：命名空间模块认识**第三种拼写**（registry 内部键），`appToolOriginalName` 对三种拼写
一律反解回原名，规则匹配再加上模型可见名这一拼。**授权仍然只认注册身份**——内部键自称
命名空间而没有可信注册，照样拿不到无条件放行。

**测试**（`npx vitest run`，5 文件 / 91 用例，2026-10-20 实测全绿）：
`app-tool-rule-resolution`（20）/ `app-tool-source-gate`（19）/
`app-tool-internal-key-resolution`（13，本卡新增）/ `app-tool-namespace`（9）/
`packages/agent/tests/permissions/permissions.test.ts`（30）。

**反向证明**：把生产改动 stash 掉再跑，`app-tool-internal-key-resolution` 13 例里 **8 例报红**
（always-allowed / canvas 短路 / deny（原名）/ deny（可见名）/ ask / allow / 内容规则 /
registry 双拼写查找），另外 5 例是「不给无条件放行」的反向守卫，两态都该绿。

## 5. 验收证据（必须是正面的）

- `npm run typecheck:all` exit 0。**T610a 已达成**（`typecheck:all` exit 0；electron ratchet 231 known / 0 new）。
- `npx vitest run packages/capabilities/tests/mcp/` 全绿。**T610a 已达成**（6 文件 / 36 测试）。
- `npx vitest run packages/host/tests/connector-services/` 全绿。**T610a 已达成**（4 文件 / 27 测试）——
  这是 `applyMCPConfiguration` / `configSignature` 复用路径的回归面。
- `packages/capabilities` 整包测试：615 用例中 3 红（`powershell-tool` / `shell-providers` /
  `vision-tool`）——**stash 基线对比确认是既有红，与本卡无关**（2026-10-20 实测）。
- `npx vitest run packages/capabilities/tests/mcp/app-tool-namespace.test.ts` 全绿。
  **T610n 已达成**（9 用例，含内部键拼写 4 例）。
- `npm run bundle:verify` exit 0。**T610n 已达成**（2026-10-20 实测）——`packages/host/bundle/`
  是入库的构建产物，架构门禁按 git 历史判定它是否 stale；改了它的输入就必须同卡重建并提交。
- renderer：`apps/desktop/src/renderer/components/chat/tools/` 现有测试全绿 + 新增 canvas
  新名路由测试（T610c —— **2026-10-20 起 canvas 迁出 616，renderer 路由随剩余产品能力走**）。
- **反向证明（必须做）**：把 T610c 的「反解原名」改回「直接用模型可见名」，renderer 与权限
  测试必须报红——证明门禁真的在守，而不是恒绿。
- T610d 落地后，模型可见工具名列表里 `mcp_duya_app_*` 出现且基础工具名**一字未改**
  （基础工具的 wire name 是外部契约，不能动）。

### 5.1 T610a 交付记录（2026-10-20）

**生产改动**（4 个文件，~150 行）：

| 文件 | 改动 |
|---|---|
| `packages/capabilities/src/MCP/ports.ts` | `MCPServerConfig.transport` 加 `'in-process'`；新增 `inProcessServer?: InProcessMcpServer`（`connect`/`close` 两个方法，与 SDK `Server` 同形） |
| `packages/capabilities/src/MCP/MCPManager.ts` | `buildTransport()` 增加 in-process 分支：用 `InMemoryTransport.createLinkedPair()` 建对，client 半边返回、server 半边存字段；`connect()` 在 client 握手**之前**先 `await server.connect(serverTransport)`（server 必须先 listening，否则 client 的 `initialize` 无人应答）；`disconnect()` 显式关 server（它持有 client 侧不持有的资源：自己的 transport 端、handler 注册）；`configSignature()` 对 in-process 用 **per-instance 身份**（WeakMap 分配 id），否则两个不同 server 实例签名相同，reload 会复用旧 client 指向已丢弃的 server |
| `packages/capabilities/src/AppServer/in-process-app-server.ts` | 新建。`createInProcessAppServer({name, tools})` → 一个会讲 `tools/list` 的 SDK `Server` + `InProcessMcpServer` 适配 |
| `packages/capabilities/src/index.ts` + `package.json` | 导出 `createInProcessAppServer` 及其类型；`./AppServer` export 子路径 |

**测试**（`packages/capabilities/tests/mcp/in-process-app-server.test.ts`，5 用例）：类型层断言
`'in-process'` 合法 → connect + 列工具 → **内部键 `mcp__duya_app__canvas_manage` + 模型可见名
`mcp_duya_app_canvas_manage`**（用**生产分配器** `computeProviderName` + `AnthropicToolNamePolicy`，
不是手搓近似）→ `createInProcessAppServer` 的 schema 原样透传 → 两个不同 server 签名不同。

**未做**（留给后续卡，按设计如此）：`tools/call` 处理器（T610b）、任何工具迁入（T610c/d）、
`source: 'app'` 权限分支（T610e）。本卡只交付骨架。

**发现的真问题**（已写进 §C9）：`source: 'bundled'` 在权限链 step 0 短路，会跳过灾难检查、
宿主常驻开关、风险档位——对能对外发消息的 bot 工具是安全回退。`duya_app` 必须用新的
`source: 'app'`，不能直接用 `bundled`。

## 6. 非目标

- **不改基础工具的 wire name**（`read` / `write` / `bash` …）。它们是模型提示词和用户配置
  里的既有契约。
- 不把 `duya_app` 做成子进程 MCP server。duya 的产品能力在 worker 进程内，跨进程会打断
  `ipcRequest` 活上下文（C1）。
- 不改 `tool_catalog` / `tool_invoke` 的协议形状。只多一个 namespace。
- 不动远端 MCP server、不动 App Connector（`connector:*` owner）那条链。
- 不在这一期做 Codex 式的 `AppToolPolicy` config layer 体系（`apps.toml` 的
  enabled/approval/omit_tools_from）。本期只做「分层 + 命名空间 + 暴露」；
  per-app 策略是后续增量。

## 7. 与既有计划的关系

- **正交于 610**：610 收的是「旧 Agent 退役 + 执行事件唯一化」，本期收的是「工具面分层」。
  本期不依赖 610 的任何 T 卡落地，可并行；但**必须在 610 退役 `packages/agent` 之前完成**，
  否则 `packages/agent/src/tool/` 里的 canvas/bot 旧副本会和 `packages/capabilities/`
  的新副本并存两套（今天已经是这个状态）。
- **承接 452 Phase B/C**：452 已把 MCP 工具的暴露开关与 `@` 弹层插件化铺好；本期新增的
  `duya_app` 走同一套 `[tools] exposure` 开关。
- **与 580 的关系**：580 建的 catalog / exposure / tool_invoke / 稳定 tool_id 是本期的地基，
  本期不改 580 的任何机制形状。

## 8. 2026-10-31 工具精简审计接续

状态：评估完成，迁移未实施。owner：Codex chat `01a19109-6a8c-7e00-b8b6-90b42e4de19e`。
分支：`codex/tool-surface-audit`；managed worktree：`D:/codex/worktrees/tool-surface-audit/duya`；base：`a33bbb0542f5effeb8484a64f8ca2cf217272e87`。
独占路径：本节与 [工具面精简评估](../../references/tool-surface-audit.md)。workspace 工具未提供 `workspace_get_context`，本轮以版本化计划、当前 Git 和生产源码对账。

- [x] 核对本机 session 结构、本地 Codex 源码、Duya 注册与 discovery、CLI 和 SessionSearch 能力差异。
- [x] 提出工具去留、MCP/CLI/skill 边界和分期验收；没有修改工具实现或运行配置。
- [ ] 后续实现：先取 provider/profile 实际工具基线，再补 CLI 检索与 worker 版本/身份/权限传递，最后撤销重复专用入口。

建议调整 §3.1 的后续实施方向：`duya_cli` 不必再多迁一次 MCP，可在等价验收后改为 CLI skill；`SessionSearch` 补齐 CLI 能力后移除独立暴露。两项仍是建议，旧能力在验收前保留。基础编辑工具暂不删除；`apply_patch` 的部分失败反馈应先改善，再以模型评测选择默认暴露。

验证环境：Windows / PowerShell / Node v24.16.0；验证 SHA 为上述 base，dirty 范围仅本计划与评估文档。`git diff --check` 与 Python Markdown 本地目标存在性检查均退出 0。按 testing.md 的纯文档检查范围未运行类型、架构、runtime/E2E 测试；不将文档检查描述成运行链通过。当前源码基线与本地 Codex SHA 见评估证据范围。

交付：评估提交 `8ed652d6`，Draft PR [#553](https://github.com/lava-chen/duya/pull/553)。未合并；没有工具删除、运行配置变更或迁移验收。外部副作用仅任务分支 push 与创建 Draft PR。PR 未集成，保留检出与分支。

接续入口：[工具暴露与 Harness 调用链收敛计划](2026-10-31-tool-surface-and-harness-convergence.md)。本次用户要求的跨工具面、provider、CLI/skill、运行调用链与恢复兼容统一在该计划维护；616 继续负责产品 MCP 的专题实现，不将旧目标清单视为全部完成。

下一步：执行新计划 W0，请求级基线与 direct/invoke 差分；验收必须包含 CLI 与 SessionSearch 语义差异，不自动接手无关的 616 迁移卡。
