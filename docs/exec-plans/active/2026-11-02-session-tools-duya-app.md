# 2026-11-02 — Session tools as a `duya_app` MCP capability group

状态：active · 负责人：Codex · 更新：2026-11-02 · PR：[ #579 draft](https://github.com/lava-chen/duya/pull/579)
分支：`codex/issue-576-duya-app-session` · worktree：`.claude/worktrees/issue-576-duya-app-session` · base：`56d42535` · owner：current session

## 目标与边界

把 Duya 面向模型的 Session 搜索、读取、异步投递和管理动作统一为宿主内置 MCP server `duya_app` 下的一组独立工具；工具定义可由 Session capability contributor 扩展。Desktop、TUI、Bot 继续走 Host Session API，MCP executor 只做薄投影，不直接访问 DB 或 Worker。

本次迁移当前已有的 Session 操作到 `duya_app`：独立暴露 list/spawn/get/reply/cancel/rename/search/read/fork/send/status/control。迁移后不再向模型单独注册 `SessionSearch`、`session`、同步阻塞式 `MessageSession`。保留旧会话 transcript 与历史工具调用兼容；`send_to_agent` 的 Bot inbox/outbox 语义单独盘点，不把它伪装成普通 Session 输入。

约束：复用 `@duya/agent-protocol/session-input` 和已合入的 Runtime Session service；Host 派生 actor；投递使用 `requestId` 幂等并检查 `expectedRunId` / `expectedTurnId`；忙碌时返回持久 receipt，不在 MCP 调用里等待目标模型结束。不得引入第二份 Session/Run/receipt 状态账本。

关联：GitHub [#576](https://github.com/lava-chen/duya/issues/576)、[R1 计划 #562](https://github.com/lava-chen/duya/pull/562)、[#573](https://github.com/lava-chen/duya/pull/573)、[#574](https://github.com/lava-chen/duya/pull/574)、[616 `duya_app`](616-duya-app-mcp-layer.md)。

## 验收

- Session 工具仅从 `duya_app` MCP server 注册，稳定 namespace 为 `mcp_duya_app_session_*`；模型的实际工具目录与可调用 registry 一致。
- `list/get/read/search/status` 走 Host Session API，支持分页、归档与 scope 规则，不启动 Run。
- `send` 产生持久、可查询、可幂等重试的 receipt；actor 由 Host 认证上下文派生；过期 Run/Turn、权限不足和忙碌状态有明确结果。
- `spawn/reply/cancel/rename/fork` 逐项复用 Host service 与授权；所有写动作都带 Host 侧所有权和执行栅栏。
- `MessageSession` 的同步等待路径不再可被模型调用；目标输出通过 Session read/status 查询，不以 timeout/unknown 冒充成功。
- Bot 的 `send_to_agent` / inbox/outbox 语义有独立归属结论，不改变其回执、意图和唤醒行为。
- 更新 #616 / #576 接续记录；类型、架构、MCP conformance 与 Host/worker 闭环验证通过。

## 进度

- [x] 核对远端 base、现有 `duya_app` MCP runtime、Session API DTO、#576 依赖与本地过期基线。
- [x] 完成 #576 D0/D1 的调用方、actor、权限与 scope 决策；见下方工具映射表。调用者是运行中的 worker Session，Host 从可信 IPC attempt 派生 identity 并检查访问范围。
- [x] 提供 `AppServerCapabilityContributor` 聚合接口和重复 ID/工具名检查；Session 是首个 contributor，未来能力可传入 `createDuyaAppMcpServerConfig()`。
- [x] 从 builtin / bot builtin 的独立工具 registry 移出 Session 工具；旧同步 `MessageSession` 不再进入模型 registry，Bot `send_to_agent` 保持原语义。
- [x] Session read/fork 使用 Host Session API 分页及 `forkAt`; list/spawn/get/reply/cancel/rename 复用现有 Host session service；send/status 复用 Host mailbox 提供幂等 receipt。
- [x] 写输入时由 Host 派生 actor、校验权限、绑定活动 Run/Turn 与 control lease 快照；Worker 在 mailbox checkpoint 二次校验后才注入。
- [x] 更新工具可见名称、权限/只读模式、Bot 工具集、模型提示和 MCP batch 分类。
- [x] 在独立 Host MCP 集成测试中发现完整 Session 工具目录，并通过 `session_list` 完成真实 in-process MCP call；按 #576 D5 顺序随后移除旧同步 `MessageSession` invoke/router/pending-call 路径。
- [x] 全量类型、架构、MCP conformance 与迁移/权限回归验证通过；重建 Host worker bundle。
- [ ] 真实双会话 Worker 闭环、重启恢复、取消、权限差分与 lease/mailbox 并发验证；Session 输入 lease 与 mailbox apply 仍跨两个 Host API 调用，存在需并发验证的窗口。

## 发现与决策

- 原工作区落后于 issue 依赖；已通过只读 fetch 确认 `origin/master` 包含 #573/#574，并在干净的 linked worktree 上 fast-forward 作为实现 base。
- 在本分支 base 上，主线已有 `createInProcessAppServer`、ALS 上下文、`source: 'app'` 和命名空间/权限基础设施，但没有把 Session 工具注入该 server；当前分支新增 Host-owned `duya_app` 装配和 Session contributor，并由集成测试证明目录发现及 Host 端 `session_list` 调用。
- #574 提供 Runtime service 与 Host 转发层的首片；当前分支复用 Host mailbox 行实现 durable input receipt、control lease 与非阻塞投递，没有包装旧同步 `MessageSession`。双会话、恢复、取消与租约并发仍待真实 Worker 验证。
- `send_to_agent` 使用 Bot inbox/outbox，不等同 Session input；迁移到 `duya_app` 也不能改变其 Bot delivery semantics。
- Session 输入复用 mailbox 行作为唯一持久 receipt，不另建输入账本；control lease 存在 Host Session extensions，通过 `updatedAt` CAS 更新。
- `SessionSearch` 保留现有 Host-owned 搜索与摘要服务：按调用 Session 排除当前 lineage，按用户选择的 project scope 筛选；会话标题、片段、摘要和 transcript 都作为不可信数据处理。工具 schema 与执行入口拒绝未知字段。
- 旧 `MessageSession` 能力实现、Host binding、worker pending-call registry、协议事件和 Desktop router 已按 D5 退役。UI 中的 `MessageSessionToolRow` 与分类仍保留，专门呈现历史 transcript。
- mailbox claim 与 Host Session lease extension 分属不同 API；checkpoint 校验能拒绝已过期的 Run/Turn/lease 快照，但两次 API 调用之间仍存在并发窗口，需通过真实并发集成验证评估是否要把校验收进同一 Host mailbox transaction。

## Codex 对照与未决语义

- Codex `codex_app` 是 first-party thread/task 工具族（list/read/wait/create/send/fork/title/archive）；`codex_apps` 是第三方远端 connector 汇聚层，两者不是同一能力。本地 Duya Session 应借用 `codex_app` 的任务工具形状与边界，不应把 `616` 中关于 `codex_apps` 的 connector 结论当作 Session 语义。
- Codex 当前 TUI 的 `codex_tui` dynamic tools 与 Desktop 的 `codex_app` 不是同一实现；前者可对照 typed App Server RPC、strict schema、输出边界和 untrusted-content 约束，`codex_apps` 则管理远端 connector，不是此处的同类能力。Duya 的模型工具仍统一由本地 `duya_app` 暴露，具体映射如下：

| Codex 工具语义 | Duya 工具 / 决策 | Host 边界 |
| --- | --- | --- |
| `list_threads` / `list_archived_threads` | `session_list(scope=children\|workspace, includeArchived, cursor, limit)` | workspace ID 由 Host 从调用 Session 派生；旧的未绑定 Workspace Session 只能列直接子级。归档查询只读。 |
| `read_thread` | `session_read` | 同 Workspace 或同 Session lineage 授权；每页最多 10 条，每条默认 2,000 字符、硬上限 20,000，省略大 binary 字段；transcript 明示为不可信数据。 |
| `create_thread` | `session_spawn` | 复用现有 Host spawn service，明确指定 `workingDirectory`，异步启动。 |
| `send_message_to_thread` | `session_send` + `session_status` | durable mailbox receipt、`requestId` 幂等、Host 派生 actor；调用立即返回，不等待目标模型。 |
| `fork_thread` | `session_fork` | 由 Host Session API 复制到指定已持久化消息，不自动启动 Run。 |
| `set_thread_title` | `session_rename` | 沿用现有 child ownership 规则。 |
| `wait_threads` | 暂不提供同步 wait | `session_get` 查询 Run 快照，`session_status` 查询投递 receipt；不把 worker/MCP 调用挂起等待目标模型。 |
| `set_thread_archived` / `handoff_thread` | 暂不提供 | Archive 会影响整条后代树，ownership、运行中任务和唤醒语义未定义；`handoff_thread` 也没有相同的 Duya 执行模型。 |

- Duya 的 read/tool output 与 Codex 一样把标题、摘要和 transcript 当作 untrusted input；工具 schema 拒绝未知字段。所有 page/read/fork/send/control 操作通过 Host API 或 Host mailbox，不建立第二份 Session/Run/receipt 状态。
- `session_status` 查的是 `session_send` receipt，不等价于 Codex `wait_threads`；这个命名和异步约定会在描述中保持明确。旧 `MessageSession` 调用链已在 `duya_app` discovery + successful call 验证通过后退役，历史 transcript UI renderer 单独保留。

## 验证记录

| SHA / dirty 范围 | 环境 | 命令或操作 | 退出码 / 结果 | 证据 |
| --- | --- | --- | --- | --- |
| `56d42535` / clean | Linux / Node 未读取 | GitHub issue、依赖 PR 与本地 Host/API/MCP 源码只读核对 | 完成 | 当前计划与 issue #576 |
| working tree / dirty | Linux worktree | `npm run build:packages` | 失败于 `packages/capabilities/src/GlobTool/GlobTool.ts:7`：父工作区缺少 `picomatch` 类型声明；前 16/22 包完成 | Host/capabilities 全量类型链未完成 |
| working tree / dirty | Linux worktree | `npx vitest run packages/capabilities/tests/mcp/in-process-app-server.test.ts packages/capabilities/tests/mcp/app-tool-namespace.test.ts` | 通过，2 文件 / 14 tests | 验证 MCP 骨架与 namespace；未覆盖 Session contributor 或 Host 装配 |
| working tree / dirty | Linux worktree | `npx vitest run packages/host/tests/worker-product-runtime/tool-surface-w0-census.test.ts` | 通过，1 文件 / 8 tests；修正 fixture 断言，明确该 census 没有装配 Host-owned MCP server | app server 的生产发现/调用路径仍无覆盖 |
| working tree / dirty | Linux / Node 24.19 | Session MCP、Session API、W0 与 MCP conformance 目标集 | 通过，8 文件 / 44 tests | 包含 Host-owned `duya_app` 完整目录发现和 `session_list` 成功调用 |
| working tree / dirty | Linux / Node 24.19 | 架构退役记录、IPC census、权限解析与 Session 工具目标集 | 通过，6 文件 / 79 tests | 包含旧同步调用链移除后的切片损失与剩余 IPC 结构检查 |
| working tree / dirty | Linux / Node 24.19 | `npm run typecheck:all` | 0 | 22 个包构建、Electron/CLI/Web/Voice/eval 类型门禁通过；Electron 基线仍有 178 条既存错误 |
| working tree / dirty | Linux / Node 24.19 | `npm run architecture:check` | 0 | 无新增边界违规；20 条基线指纹已不再触发 |
| working tree / dirty | Linux / Node 24.19 | `npm run plan:sync` | 0 | 16 done rows、28 file refs、14 test-name refs 一致 |
| working tree / dirty | Linux / Node 24.19 | 12 个迁移、权限、架构与 MCP 目标测试文件 | 通过，12 文件 / 118 tests | 包含 Host `duya_app` 完整工具发现与 `session_list` in-process 成功调用；Host 输入服务 5 项测试覆盖持久化/幂等、访问范围和 lease 变更 |
| working tree / dirty | Linux / Node 24.19 | `npm run bundle:worker` | 0 | 重建跟踪的 Host worker bundle 与提示词资源；提交后需运行 `npm run bundle:verify` |
| working tree / dirty | Linux | 真实 Worker 双会话、重启恢复、取消、权限差分 | 未运行 | #576 的 Host/Worker 闭环验收待补 |

## 接续 / 结果

实现已完成 Host-owned `duya_app` Session 工具迁移、Codex 语义对照，并在 D5 成功发现及调用后退役旧同步路径。全量类型/架构门禁与 118 项目标回归通过。Draft PR [#579](https://github.com/lava-chen/duya/pull/579) 已创建；真实 Worker 双会话和 lease/mailbox 并发闭环尚未验证，已在 PR 中标注为待验收项。
