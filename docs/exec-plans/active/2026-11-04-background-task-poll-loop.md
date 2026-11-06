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

- [x] 复核 session JSONL `rollout-2026-11-04T06-13-43-952Z-58b66080-4291-4f09-927d-aa32e739dbe0`：同一任务被轮询 45 次，最长连续相同调用 15 次；`~/.duya/config.toml` 的通用阈值是 16，因此只接线通用阈值并不能修复这段记录。
- [x] 该 JSONL 没有已投递的完成通知重复事件；“通知全是回放”是助手重复输出的状态文本，两个 `<task-notification>` 字面命中来自工具返回的文档/启动回执。
- [x] 根因定位：生产 `driveRunWithEngine` 漏映射 `options.antiDeadLoop`，`executeRunEngine` 包装层也未转发策略；同时通用阈值高于该会话最长轮询连续段。
- [x] 补 Host 配置接线、执行包装层转发与 `get_task_output` 专用阈值（硬提醒阈值 + 1）及生产 driver 回归。
- [x] 定向 Vitest（16/16）、`@duya/agent-runtime` 与 `@duya/host` 类型检查、架构门禁通过。
- [ ] 全量 `typecheck:all` 完成：在 `@duya/web` 的 Vite 临时配置写入处因共享 `apps/web/node_modules/.vite-temp` 返回 `EPERM`；变更包已在之前的 package build 中编译通过。
- [x] 初始接线提交 `93e4275933ac3d08eb5227cddc31bb592b686bda`，复核后的专用停止策略提交 `bebe2afa616449c6838d6e49b8be298f9537c8db` 并推送到 draft PR [#617](https://github.com/lava-chen/duya/pull/617)。

## 发现与决策

- `RunExecutionRequest.repeatedCallStop` 是可选安全策略；先前生产链路未连通配置。仅启用通用阈值 16 仍不足以阻止该会话最长 15 次的轮询段，所以 Host 为 `get_task_output` 提供 `min(hardStopAt, hardNudgeAt + 1)` 专用阈值。
- 该会话没有重复完成通知的证据；重复的是助手轮询和状态文本，不是 mailbox 多次投递。

## 验证记录

| SHA / dirty 范围 | 环境 | 命令或操作 | 退出码 / 结果 | 证据 |
| --- | --- | --- | --- | --- |
| `7ef8cbd053b5c751729fa8a5ba28f85e3bc48508` + task source/test/docs | Windows / Node / worktree | `node scripts/build-packages.mjs --target @duya/host`; focused Vitest: engine hard-stop + production Host driver; `npm.cmd --workspace @duya/agent-runtime run typecheck`; `npm.cmd --workspace @duya/host run typecheck`; `npm.cmd run architecture:check`; `npm.cmd run typecheck:all` | Host dependency build passed; focused suites 16/16 passed; both package typechecks passed; architecture passed with no new violations (3195 total, 49 stale fingerprints); full check previously failed at `@duya/web` Vite config temp write (`EPERM` in shared `apps/web/node_modules/.vite-temp`) after changed packages compiled | integration regression stops the real `get_task_output` call after 13 requests with hardNudgeAt=12 and hardStopAt=16; source JSONL measured max identical streak 15; no notification replay event found |

## 接续 / 结果

下一步：安全解决共享 Vite 临时目录 `EPERM` 后重跑 `typecheck:all` 并更新 PR #617；未经授权不合并。
