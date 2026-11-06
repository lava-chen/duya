# 后台任务重复轮询硬停止

状态：active · 负责人：本会话 · 更新：2026-11-04
分支：`codex/task-poll-loop` · worktree：`D:/codex/worktrees/task-poll-loop/duya` · base：`7ef8cbd053b5c751729fa8a5ba28f85e3bc48508` · owner：本会话

## 目标与边界

生产 RunEngine 必须接收 Host 已解析的 `antiDeadLoop` 配置；`get_task_output` 要求等待通知的轮询使用更低的专用硬停止阈值，避免模型忽略提醒后仍持续重复查询。

范围：Host 的 engine request 组装、RunExecutionRequest 契约注释、生产 driver 回归测试。后台任务通知 mailbox 的投递语义不改。

## 验收

- driver 将 `ChatOptions.antiDeadLoop` 配置传入 `repeatedCallStop`，字段缺省时保持未配置语义。
- 普通工具遵循 `hardStopAt`；重复 `get_task_output` 在 `hardNudgeAt + 1` 停止，除非 `hardStopAt` 更低。
- 集成回归证明生产 driver 在阈值处以 `repeated_tool_calls` 结束，并保留已提交工具结果。
- 相关测试、`npm run typecheck:all`、`npm run architecture:check`。

## 进度

- [x] 复核 session JSONL `rollout-2026-11-04T06-13-43-952Z-58b66080-4291-4f09-927d-aa32e739dbe0`：截图里的 task ID 共被轮询 45 次，其中 44 次仍为 `running`，最后一次才为 `completed`；最长连续同参调用是 24 次（更正先前的 15 次统计）。`~/.duya/config.toml` 的 `hard_nudge_at=12`、`hard_stop_at=16`，只接线通用阈值仍不足以阻止这段循环。
- [x] 对照 `duya-core.db`：截图 task ID 对应唯一一条 `background_notification` row，状态 `applied`，在 `before_model_turn` 由 run `506ca791-b40d-48cf-bcb6-6e647e370305` 吸收一次（`claim_attempts=0`）。JSONL 不持久化这段隐藏 runtime context 的原始 XML；三个 `<task-notification>` 字面命中来自系统提示和工具读出的文档/启动回执。
- [x] 复核后台任务通知完整链路并对比 `E:\cloned-projects\codex`：Duya 发送端只发一次 mailbox 请求、不做 ack 超时重试；DB 用 `(session_id, task_id)` 幂等，消费端按设计最多注入一次。Codex 的 `wait_agent` 则订阅 mailbox 活动并阻塞等待子任务完成消息。
- [x] 根因定位：生产 `driveRunWithEngine` 漏映射 `options.antiDeadLoop`，`executeRunEngine` 包装层也未转发策略；同时通用阈值高于该会话最长轮询连续段。
- [x] 补 Host 配置接线、执行包装层转发与 `get_task_output` 专用阈值（硬提醒阈值 + 1）及生产 driver 回归。
- [x] 定向 Vitest（16/16）、`@duya/agent-runtime` 与 `@duya/host` 类型检查、架构门禁通过。
- [ ] 全量 `typecheck:all` 完成：在 `@duya/web` 的 Vite 临时配置写入处因共享 `apps/web/node_modules/.vite-temp` 返回 `EPERM`；变更包已在之前的 package build 中编译通过。
- [x] 初始接线提交 `93e4275933ac3d08eb5227cddc31bb592b686bda`，复核后的专用停止策略提交 `bebe2afa616449c6838d6e49b8be298f9537c8db` 并推送到 draft PR [#617](https://github.com/lava-chen/duya/pull/617)。

## 发现与决策

- `RunExecutionRequest.repeatedCallStop` 是可选安全策略；先前生产链路未连通配置。仅启用通用阈值 16 仍不足以阻止该会话最长 24 次的轮询段，所以 Host 为 `get_task_output` 提供 `min(hardStopAt, hardNudgeAt + 1)` 专用阈值。
- 通知发送端的 `mailboxDb.send` 等待 DB bridge 响应，失败时记录并返回，不会因“没有 agent 收件确认”而重发；`BackgroundAgentLifecycle` 还会用进程内 `notified` 集合挡住同一任务的重复终态回调。Mailbox 的唯一幂等索引进一步防止同一任务产生多个 row。
- 接收端 `claimBatch` 为通知写入 `injected_run_id`，后续 run 不会再次注入；没有端到端的“模型已收到”确认，因此异常窗口的风险是通知丢失，不是本次看到的重复发送。Desktop 会额外调度 idle wake；standalone Host/TUI 依赖运行中 turn 的下一个 checkpoint，TUI 的一秒任务快照轮询只更新任务视图，不是 agent 的 `get_task_output` 调用。
- Codex 对应实现通过子 agent 终态回调向父 thread 排入 inter-agent completion message，`wait_agent` 订阅 `InputQueueActivity::Mailbox` 并等待/超时；这是事件等待而非重复取状态快照。其完成消息投递仍是 best-effort，不能据此推断它提供了 agent 端到端确认。
- 该会话的实际 mailbox 只有一条完成通知且被应用一次；45 次 `get_task_output` 中前 44 次任务仍运行，最后一次返回完成。助手的重复状态文本出现在通知 row 创建之前，后续调用转向其他任务，没有重复拉取该任务。可观察到的是模型在任务完成前反复查询快照，不是 mailbox 多次投递。

## 验证记录

| SHA / dirty 范围 | 环境 | 命令或操作 | 退出码 / 结果 | 证据 |
| --- | --- | --- | --- | --- |
| `7ef8cbd053b5c751729fa8a5ba28f85e3bc48508` + task source/test/docs | Windows / Node / worktree | `node scripts/build-packages.mjs --target @duya/host`; focused Vitest: engine hard-stop + production Host driver; `npm.cmd --workspace @duya/agent-runtime run typecheck`; `npm.cmd --workspace @duya/host run typecheck`; `npm.cmd run architecture:check`; `npm.cmd run typecheck:all` | Host dependency build passed; focused suites 16/16 passed; both package typechecks passed; architecture passed with no new violations (3195 total, 49 stale fingerprints); full check previously failed at `@duya/web` Vite config temp write (`EPERM` in shared `apps/web/node_modules/.vite-temp`) after changed packages compiled | integration regression stops the real `get_task_output` call after 13 requests with hardNudgeAt=12 and hardStopAt=16; source JSONL measured max identical streak 15; no notification replay event found |

## 接续 / 结果

下一步：安全解决共享 Vite 临时目录 `EPERM` 后重跑 `typecheck:all` 并更新 PR #617；未经授权不合并。
