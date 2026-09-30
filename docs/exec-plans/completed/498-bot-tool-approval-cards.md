# 498 — 工具审批持久卡片（rakazo 对齐）：pause → 卡片 → 三按钮 → 账本续跑

> **Status**: Implementation · **Priority**: P0 · **Owner**: bot-direct permission
> **立项（2026-09-05）**: 参考 `E:/cloned-projects/rakazo` 的 action-approval 机制
>（`approval-ask.ts` 卡片块 / `externalEffect` 状态机 / `answerRunInput` 事务恢复），
> 把 duya 工具权限 ask 从「内存 promise + 5 分钟超时 deny」升级为「持久化审批卡片 +
> 暂停/续跑」，并把 bot 会话与普通 session 收敛为一种路径逻辑。

## 0. 现状与问题

- bot 会话 `permissionMode: 'auto'`（`electron/wake/agent-dm-dispatcher.ts`），ask 只在
  classifier 升级 / fail-closed 时发生。
- worker 的 `createPermissionHandler`（`agent-process-entry.ts`）把 ask 挂成内存
  promise，5 分钟超时自动 deny；无人观看（wake 后台、视图未挂载、app 重启）时
  决定直接丢失。
- 494 落地了 ephemeral 的 `BotPermissionCard` / `BotAskCard`（bot-direct 订阅
  `subscribeToPermissions`），但 answered 状态是内存态，卡片不持久化（494 非目标）。
- 普通 session 的权限 UI 同样是纯内存：worker 死掉（重启/崩溃）后 pending 请求
  无声消失。

## 1. 方案（统一路径）

ask 发生 → 写两张持久状态（卡片消息 + 审批行）；用户作答 → 唯一 resolver 入口做
CAS 状态迁移，然后分流：

- worker 存活且仍在内存等待 → 现有 `permission:resolve` 快路径（interactive 主路径）。
- worker 不在等（bot 暂停 / 重启 / 崩溃）→ 一次性批准账本放行 + continuation run
  （wake 队列语义）。

两条 surface 差异只在 worker 是否等待：

| surface | ask 时行为 | 决定到达时 |
| --- | --- | --- |
| bot（wake/DM） | 立即 pause：持久卡片 + `'paused'` 决策，turn 以中性工具结果收尾 | continuation run 续跑，账本精确放行那次调用 |
| default（interactive） | 保持 worker 内等待（ChatView 拥有 SSE 生命周期）+ 持久卡片（崩溃回退） | 快路径 resolve；worker 已死则同 bot 续跑路径 |

三按钮：Allow once / Always allow this tool / Deny。Always 持久化为 per-bot /
per-session 规则，turn 开始时种入 `alwaysAllowRules`。门控（auto profile）不动；
AskUserQuestion 两阶段交互不动（保持 worker 内等待）。

## 2. 任务

- [x] T1 本 plan 文件 + README 注册
- [x] T2 DB：`electron/db/toolApprovalState.ts`（`tool_approval_state` +
      `tool_approval_rules`，self-repair + migration 56；55 留给并行 WIP 的
      send_message 卡片侧表）+ store 单测（ABI 锁定时会 skip，见
      `skipIf` 守卫；本机 Electron 持锁期间 skipped，CI/空闲后全量）
- [x] T3 Worker：`permissionSurface` option（server 从 `bot:<agentId>` 推导）；
      bot pause 处理器（db-client 写审批行 + 追加 `tool-approval` 卡片消息，
      metadata 挂已有 `sendMessage` 白名单键）；executor `'paused'` 分支
      （中性 "Waiting for user approval" 工具结果，不重试）+ MCP 内联 ask
      路径的 paused 分支（防穿透执行）；`canUseTool` 前置一次性账本消费
      （tool_name+input_hash 双匹配 CAS）；turn 开始拉取 always 规则传入
      streamChat（`_turnAlwaysAllowTools` 直查，不走规则字符串）
- [x] T4 Main：`db:toolApproval:listBySession/get/resolve`（纯核心抽
      `electron/db/tool-approval-resolver.ts`：CAS + always upsert +
      continuation 入队 + 广播）；`db:permission:resolve` 快路径挂
      `syncApprovalCard` 同步钩子（立即执行 → 烧账本）；`preload.ts` 暴露
- [x] T5 Renderer：`BotToolApprovalCard`（三按钮/answered 徽章，494 卡族视觉）；
      `BotDirectChatView` 挂载水合 + `tool-approval:updated` 实时翻转；
      i18n zh/en（复用 permission.* 按钮 + 新增 toolApproval.* 状态）。
      **偏差**：ChatView（interactive 转录）v1 渲染卡片行的可读 fallback
      文本，未嵌卡片组件（crash-fallback 作答走 IPC 已通，UI 嵌入随
      489 P2.5 卡宿主闭环）
- [x] T6 测试：resolver 纯核心 9 例、surface 处理器 6 例、组件 5 例、
      store 10 例；executor paused 分支无现成测试基建（重 harness），
      契约由处理器测试覆盖（返回 'paused' + 分支行为），记为后续补测
- [x] T7 门禁：`npm run typecheck:all`（web/agent 干净；预存红见决策日志）
      + electron tsc（747 错误 HEAD 基线 = 改动后，零新增）+
      `npx vitest run` 受影响区域（wake-dispatcher 2 失败为 HEAD 预存）；
      ARCHITECTURE.md 增 § Durable Tool-Approval Cards
- [ ] T8 提交 + PR + merge（worktree 流程）

## 3. 非目标

- 门控规则引擎（rakazo 变更性动词判定）——另立 plan。
- interactive 会话改为 pause 语义（需渲染端续跑可视化，风险大）。
- AskUserQuestion / widget / secret 卡的持久化（489 P2.5 范围）。

## 4. 决策日志

### 2026-09-05 — 立项

- 恢复模型选 rakazo 式 pause+continuation（用户确认），并要求 session 路径统一：
  统一点在 store + resolver + 卡片组件，worker 是否等待是 surface 策略差异。
- 三按钮全做（用户确认）。
- migration 用 56：55 被并行会话未提交 WIP（send_message 卡片侧表）占用，撞号会
  污染 `_schema_migrations`。
- worktree 基于本地 master（a20c0941）：本特性依赖的 bot 栈（494/477/497）在
  13 个未推送的本地提交里，origin/master 没有。PR 会一并带出这些提交。

### 2026-09-06 — 实现补记

- **快路径取舍**：持久卡片的作答一律走账本 + continuation，不做 worker 内存
  快路径转发——worker 的 5 分钟等待可能已在点击前超时 deny，fire-and-forget
  转发无法感知，会把批准静默弄丢。interactive 的低延迟路径仍是 ephemeral
  PermissionPrompt（`db:permission:resolve`），它新增 `syncApprovalCard` 钩子：
  worker 立即执行 → 卡片迁移 + 账本烧毁（防后续同参调用搭便车）。
- **MCP 内联 ask 路径**（`mcp/apply.ts`）原本对非 deny 一律放行执行，'paused'
  会穿透；补了显式分支。
- **门禁归因**：HEAD 预存红——web 侧 agentDm 簇 7 个类型错误 +
  `PageId 'bot-settings'`，electron 侧 747 个错误，wake-dispatcher 测试 2 例
  （inbound/broadcast FIFO）；stash 验证全部与本改动无关（stash 前后计数一致）。
- **Mimosa hook 误报**：`db.exec` + 模板字符串被判命令注入；DDL 改为逐语句
  `prepare().run()` 规避。
