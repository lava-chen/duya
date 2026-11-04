# 子代理回传链路加固与类型收紧

状态：已合并 · 负责人：本会话 · 更新：2026-11-04
分支：subagent-delivery-fix · worktree：`.claude/worktrees/subagent-delivery-fix` · base：`9b8da5e8` · owner：本会话

集成记录：PR #607 以 merge commit `de54c719c41fbe7c629c0cd1fa728167181bbe2e` 合入 master。CI 的 typecheck/build/architecture/test-scope 与 worker bundle freshness 通过；整仓测试仍有两项已核对的既有失败（`packages/ai/test/tool-protocol-adaptation.test.ts` 未被本 PR 修改；`packages/cli/tests/integration/host-child-sessions.test.ts` 在本地干净 master 基线同样因 budget_exhausted 失败）。

## 目标与边界

背景（2026-11-03 晚 TUI session 507bb717 / sub 85258bb1 / task 4f606add 实测）：
spawn 回执只给 `subagent_id`（session id）不给 `task_id`，主 agent 拿唯一 id 调
`get_task_output` 得 `not_found`，误判丢失后重做 7 分钟；`<task-notification>` 经 mailbox
吸收进 prompt 不落 rollout、TUI 无渲染，用户全程不可见；Host 后台任务索引结构性排除
subagent 任务；`get_task_output`/`kill_task` 每次调用触发 "Unknown tool" WARN 噪音。
对照 codex（multi_agents：单一 agent id + wait_agent 阻塞工具 + spawn 回执含 id）与
claude-code（Agent 类型清单进工具描述）。

本次改变的行为：

1. spawn 回执同时给出 `task_id`，并说明两个 id 各自的消费工具（resume_from vs
   get_task_output/kill_task）。
2. `get_task_output` 支持按 `subAgentSessionId` 别名解析（回退匹配），消除 not_found 误判。
3. `classify.ts` 补 `get_task_output`（READ）与 `kill_task`（SYSTEM），消除噪音 WARN。
4. 后台子代理任务进入 Host 后台任务索引：协议 `BackgroundTaskSummaryV1` 增加
   `kind?: 'bash' | 'subagent'`、`label?`，`command` 改可选；worker 快照合并
   `BackgroundAgentLifecycle` 任务；Host narrow 校验按 kind 分支；CLI/Desktop 消费端按
   kind/label 渲染。
5. 子代理终态（completed/failed/killed）补发一条 `subagent.completed` 形态的
   `chat:agent_progress` 帧，让活着的 SSE 消费者（TUI 卡片）立即翻状态。
6. 类型收紧：`subagent_type` 解析收敛到 agent-core 单一注册表模块（别名表 + 大小写
   归一 + 可用类型清单文案）；`task` 工具描述动态列出当前活动类型与 whenToUse
   （codex/claude-code 风格，用描述不用 enum，避免用户自定义 agent 使 schema 过期）。

不处理（记录为后续）：父会话 idle 时由通知自动拉起新 turn（需要与 run orchestrator 的
one-live-run-per-session 不变量协同，单独切片）；spawn 回执文本改为"允许一次性 poll"，
idle 唤醒语义在文本中如实描述为"下一轮开始时送达"。

允许修改路径：`packages/agent-protocol/src/background-tasks.ts`、
`packages/agent-core/src/subagents/*`、`packages/capabilities/src/SubagentTool/*`、
`packages/capabilities/src/background-task-tool.ts`、
`packages/host/src/worker-subagents/*`、`packages/host/src/worker-process-entry.ts`、
`packages/host/src/background-task-index.ts`、`packages/agent-runtime/src/tools/execution/orchestration/classify.ts`、
`packages/cli/src/tui/background-tasks.ts`、`packages/ui` 后台任务消费点，及相应测试。

关联：TUI 后台任务视图（2026-10-24-tui-background-tasks.md，已合并）、PR 591（subagent
视图，已合并）、2026-10-23-multi-agent-orchestrator.md（Phase 1 子 agent 状态机补测与本计划互补）。

## 验收

- `npm run typecheck:all`（本机需 `CODEBUDDY_SAFE_DELETE_ENABLED=0`）0 退出。
- `npm run architecture:check` 0 退出（不加指纹）。
- 相关 vitest 套件全绿：capabilities（background-task-tool、SubagentTool）、agent-core
  （新注册表单测：别名/大小写/未知类型清单）、host（worker-subagents service 回执文本含
  task_id、快照合并、narrowBackgroundTask kind 分支）、cli（background-tasks 渲染 subagent
  行）。
- `npm run bundle:worker` + `bundle:verify`（`CODEBUDDY_SAFE_DELETE_ENABLED=0`）FRESH。
- 基线：改动前先跑上述套件记录基线失败（如有），按文件/用例/错误签名比较。

## 进度

- [x] 调研 codex agent-roles/multi_agents 与 claude-code Agent 工具描述模式
- [x] 根因定位（详见「发现与决策」）
- [x] S1 回执 task_id + get_task_output 别名解析
- [x] S2 classify 补工具名
- [x] S3 协议 kind/label + worker 快照合并 + Host narrow + 消费端渲染
- [x] S4 终态 subagent.completed 帧 + wire 补 subagentId 字段
- [x] S5 agent-core 类型注册表 + task 工具描述动态化
- [x] 门禁全绿 + bundle FRESH（见验证记录）
- [ ] commit + PR

## 发现与决策（补充，实施期）

- **真根因（比预想更深）**：wire 上从来没有 `subagentId` 字段。worker 原始
  `chat:agent_progress` 帧只带 `agentId`，host 侧无任何改名，而 TUI
  `BackgroundTaskModel.applyFrame` / `ActivityTracker` 只读 `subagentId` ⇒ **所有后台
  spawn 的实时帧被 TUI 静默丢弃**。PR 591 的 TUI 视图代码正确但永远收不到帧。
  修在源头 `buildChatAgentProgressPayload`（补 `subagentId`，终态补 `status` +
  `durationMs`），translator 侧兼容 `agentId` 回退。
- `agentTasks` 保留路径不得把已窄化的 IndexedTask 再过一遍 narrow（无顶层 id，全灭）。
- Host index 保留语义：`agentTasks` 缺省（旧 worker）保留上一帧的 subagent 分区，与
  "wholesale replace" 只作用于各自的写入方。
- git 依赖测试（worktree-isolation / subagentParams 的 9 例）在 base master 同样失败
  （`spawnSync git ENOENT`，沙箱 PATH），与本次改动无关，基线已记录。

## 发现与决策

- 回执不给 task_id 是有意设计（service.ts:148-161 注释：防 double-receive），但与
  "模型仍会 poll" 的现实冲突；codex 的 spawn 返回值声明 "Returns the spawned agent id
  plus nickname"，即回执必须携带可操作 id。决策：回执同时给两个 id，措辞从"不要 poll"
  改为"可以 get_task_output 快照一次，终态通知会自动送达"。
- Host 索引排除 subagent 是双层原因：worker 只推 BashTaskRegistry
  （worker-process-entry.ts:522-528）；即使推了，narrowBackgroundTask 要求 command 必填
  （background-task-index.ts:52-61）。决策：协议加 `kind` 而不是给 subagent 伪造 command。
- 类型收紧选 codex 的 description 注入而非 JSON schema enum：用户/项目自定义 agent 使
  enum 会在会话间变化，schema 是 worker 启动期固化的；描述文本每会话构建即可。
- rollout 看不到 `<task-notification>` 是已知行为（mailbox absorbed 的运行时注入行不落
  journal），不在本计划修；S3/S4 解决的是"用户可见性"而非"持久化"。

## 验证记录

| SHA / dirty 范围 | 环境 | 命令或操作 | 退出码 / 结果 | 证据 |
| --- | --- | --- | --- | --- |
| `d070c94d`（源码+bundle）+ `0810f65a`（bundle 按提交树重建） | Win11 / Node 22.22.2 / worktree `.claude/worktrees/subagent-delivery-fix` | `npm run typecheck:all`（`env -u CODEBUDDY_SAFE_DELETE_BULK_STATE_DIR CODEBUDDY_SAFE_DELETE_ENABLED=0`） | 4 pass / 0 fail | 本文档 |
| 同上 | 同上 | `npm run architecture:check` | OK，无新增违规（48 条 baseline 失配指纹未 `--write`） | 本文档 |
| 同上 | 同上 | vitest：agent-core + capabilities + host + cli/tui + agent-runtime（267 文件） | 2924 passed；9 个 git 依赖用例在 base master 同样失败（`spawnSync git ENOENT`，沙箱 PATH），签名一致，非本次引入 | 本文档 |
| 同上 | 同上 | `npm run bundle:worker` + `bundle:verify` | FRESH 0/1112 | 本文档 |

## 接续 / 结果

- 2026-11-04 集成前重放：从原 base `9b8da5e8` 重放到最新 `master` `9f0f8b05`。源码改动无冲突；旧 worker bundle 与新主线及源改动冲突，因此跳过旧 bundle commits，按合并后的源码重新构建。更新后验证：定向 5 套件 89/89；`typecheck:all` 退出 0（164 条既有基线错误，无新增）；`architecture:check` 退出 0（无新增违规）。全量相关路径 591 文件、5941 测试中 590 文件通过；`packages/cli/tests/integration/host-child-sessions.test.ts` 失败，经最新 master `9f0f8b05` 独立复现同一 `budget_exhausted` 失败，属现有基线。环境 Node 24.22.1；待重新构建 bundle、提交后检查 freshness，并以最新 PR head CI 复核。
- 已实现并验证：S1–S5 全部落地，commit `d070c94d` + `0810f65a`，分支
  `subagent-delivery-fix`，**PR https://github.com/lava-chen/duya/pull/607**（待 CI 与授权集成）。
- 未提交路径：无（`packages/capabilities/src/ModuleTool/inline-content.ts` 的行尾假 M 按
  已知处置 restore 回 HEAD，不入提交）。
- 副作用：无外部副作用；worker bundle 随源码同 commit。
- 阻塞：无。集成须等待必需 CI 通过并获用户授权（未经授权不合并）。
- 下一步（后续计划，不在本 PR）：父会话 idle 时的通知自动唤醒（auto-resume turn）需要与
  run orchestrator 的 one-live-run-per-session 不变量协同，单独切片设计；本 PR 的回执
  文案已把通知语义如实描述为"下一轮开始时送达"。
