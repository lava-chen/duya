# 后台任务重复轮询硬停止

状态：active · 负责人：本会话 · 更新：2026-11-04
分支：`codex/task-poll-loop` · worktree：`D:/codex/worktrees/task-poll-loop/duya` · base：`7ef8cbd053b5c751729fa8a5ba28f85e3bc48508` · owner：本会话

## 目标与边界

生产 RunEngine 必须接收 Host 已解析的 `antiDeadLoop` 配置；重复调用硬停止在连续相同工具调用达到阈值时结束本轮，避免 `get_task_output` 明确要求等待通知后仍被模型连续轮询。

范围：Host 的 engine request 组装、RunExecutionRequest 契约注释、生产 driver 回归测试。后台任务通知 mailbox 的投递语义不改。

## 验收

- driver 将 `ChatOptions.antiDeadLoop.enabled/hardStopAt` 传入 `repeatedCallStop`，字段缺省时保持未配置语义。
- 集成回归证明重复调用达到配置阈值即以 `repeated_tool_calls` 结束，并保留已提交工具结果。
- 相关测试、`npm run typecheck:all`、`npm run architecture:check`。

## 进度

- [x] 核对 session JSONL：同一运行中的轮询间隔有其他工具操作，连续查询段仍重复出现；工具返回已明确要求等待自动通知。
- [x] 根因定位：生产 `driveRunWithEngine` 漏映射已有 `options.antiDeadLoop`；同时 `executeRunEngine` 包装层未声明或转发 `repeatedCallStop`。最终 RunEngine 收到 undefined，硬停止未启用。
- [x] 补 Host 配置接线、执行包装层转发与 driver 回归用例。
- [x] 定向 Vitest（14/14）、`@duya/agent-runtime` 与 `@duya/host` 类型检查、架构门禁通过。
- [ ] 全量 `typecheck:all` 完成：在 `@duya/web` 的 Vite 临时配置写入处因共享 `apps/web/node_modules/.vite-temp` 返回 `EPERM`；变更包已在之前的 package build 中编译通过。
- [x] 已提交 `93e4275933ac3d08eb5227cddc31bb592b686bda` 并创建 draft PR [#617](https://github.com/lava-chen/duya/pull/617)；保持 draft，等待全量类型检查限制解决后评估。

## 发现与决策

- `RunExecutionRequest.repeatedCallStop` 是可选的安全策略。RunEngine 有终止逻辑和引擎单测，但 Host driver 与 `executeRunEngine` 包装层都未连通现有 `antiDeadLoop` 配置。
- 该会话的 “completed notifications are replays” 是助手重复的进度文本；实际待修问题是重复轮询缺少生产硬停止，不是 mailbox 多次投递完成通知。

## 验证记录

| SHA / dirty 范围 | 环境 | 命令或操作 | 退出码 / 结果 | 证据 |
| --- | --- | --- | --- | --- |
| `7ef8cbd053b5c751729fa8a5ba28f85e3bc48508` + task source/test/docs | Windows / Node / worktree | focused Vitest: engine hard-stop + production Host driver; `npm.cmd --workspace @duya/agent-runtime run typecheck`; `npm.cmd --workspace @duya/host run typecheck`; `npm.cmd run architecture:check`; `npm.cmd run typecheck:all` | focused suites 14/14 passed; both package typechecks passed; architecture passed with no new violations; full check failed at `@duya/web` Vite config temp write (`EPERM` in shared `apps/web/node_modules/.vite-temp`) after changed packages compiled | regression proves request 2 is the repeated-call cutoff and terminal proposed reason is repeated calls; generated inline-content hash matches HEAD; no generated artifact staged |

## 接续 / 结果

下一步：处理全量类型检查在共享 Vite 临时目录的 `EPERM` 限制，更新 PR 验证结果；保留 worktree 直至 PR 集成与获授权的合并后验证。
