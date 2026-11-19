# <任务：Project Coordinator 工具面收窄（P0）>

状态：active · 负责人：claude-code/session-project-coordinator-p0 · 更新：2026-11-19
分支：codex/project-coordinator-p0-tool-surface · worktree：/home/lavachen/Projects/duya/.claude/worktrees/project-coordinator-p0 · base：2a37f8fe6 · owner：claude-code/session-project-coordinator-p0

## 目标与边界

按 [设计 §14](https://github.com/lava-chen/duya/pull/643) 的 P0 阶段，收窄 Project Coordinator 的工具面：

- `project` 工具删除 `context` / `update_state` / `record_decision` / `record_memory` 四个 action，只留 `get`。
- `project get` 只返回 Activity + Task 投影，不再返回 decisions / memories / state；activity cursor 保留可用。
- canonical `session` 工具删除 `rename` action。
- Coordinator 白名单显式排除 `todo` / `session_fork` / `session_rename` / `set_session_title`；`tool_catalog` / `tool_invoke` 继续禁用。
- 提示词正文不再出现已删 action（`project context/update_state/record_decision/record_memory`、`rename`、`todo`）。

用户裁定（2026-11-19）：

1. 本次只做「仅收窄工具面」，作为独立 PR；文件化知识改写留到 P2。
2. §14.7 第 1 项（write/edit 的 Host 边界机制）裁定为「按调用注入可信项目根」，属 P2，本次不实现。

已知代价：P0 到 P2 之间 Coordinator 没有知识写入面，提示词按此如实描述。

不在本次范围：P1（read/glob/grep）、P2（write/edit + 文件化知识）、P3（bash 观察）、P4（canonical `session` 增加 `read`/`send`）、P5（`send_message`）；Host 侧项目连续性 API 与 HTTP 投影保持不变，UI 仍读 HTTP，不因工具收窄丢数据（§14.7 第 4 项）。

关联：设计 [PR #643](https://github.com/lava-chen/duya/pull/643)（§14）；上游主线 [2026-11-02 Project Coordinator](2026-11-02-project-coordinator.md)；提示词设计 [2026-11-06 提示词系统](2026-11-06-project-coordinator-prompts.md)。

## 验收

- `npm run typecheck:all` 退出码 0。
- `npm run architecture:check` 退出码 0，且未新增 baseline 指纹。
- T18：Coordinator 工具表没有 `todo` / `rename` / `fork` / `set_session_title` / `tool_catalog` / `tool_invoke` 与 project 写 action（新增断言）。
- T19：`project get` 只返回 Activity + Task 投影；不再返回 decisions / memories / state；activity cursor 可用。
- 相关测试：`packages/capabilities/tests/ProjectTool.test.ts`、`packages/capabilities/tests/unit/worker-session-tools.test.ts`、`packages/host/tests/project-tool-service.test.ts`、`packages/host/tests/worker-profiles/types.test.ts`、`packages/host/tests/worker-product-runtime/project-prompt-context.test.ts`、`packages/host/tests/worker-product-runtime/session-app-mcp.test.ts` 全绿。
- UI / 运行时改动：无。本 PR 不改 UI 与 IPC 形态，只改工具面与提示词文本。

## 进度

- [x] `project` 能力面收窄（ports / tool / Host tool-service）
- [x] canonical `session` 删除 `rename`；`duya_app` 保留 `session_rename`
- [x] Coordinator 白名单与显式禁用项
- [x] 提示词正文清理 + `project/context.ts` 陈旧提示
- [x] 测试改写与门禁

## 发现与决策

1. 四个 project action 只存在于 `packages/capabilities/src/project/{tool,ports}.ts`、`packages/host/src/project/tool-service.ts`、`packages/host/src/worker-tools/builtin.ts` 的摘要串，改动面收敛（grep 全仓确认；其他 `update_state` 是 bot 记忆工具，不动）。
2. `session` canonical 工具与 `duya_app` 的 `session_rename` 共用同一个 capability 实例（`session-app.ts` 用 `adaptTool(sessionTool, 'session_rename', …)` 包装）。直接删 canonical 的 `rename` 会连带打掉 bot 侧的 `session_rename`。因此把 rename 拆成独立 capability `SessionRenameTool`（沿用 `SessionForkTool` 模式），`duya_app` 继续以 `session_rename` 名义暴露，bot 工具集与名字清单（`BOT_TOOLSET`、`DUYA_APP_TOOL_NAMES`、curator denylist、`READONLY_MODE_BANNED_TOOLS`）全部保持有效。
3. `set_session_title` 在 master 不存在任何注册名（全仓 grep 无命中），不写成禁用项，避免为不存在的工具加指纹；改为在测试里断言 Coordinator 工具表不含该名字。
4. `packages/host/src/project/context.ts` 的「use expectedRevision=0 for the first state write」在 `update_state` 删除后成为假提示，必须改掉；该文件的 Host 侧连续性注入（state/decision/memory 证据）保留，读面不受影响。
5. `project get` 只回 Activity + Task 后，decisions / memories / state 仍由 Host 注入提示词上下文，模型仍能读到证据，但不能再写——这是 P0 到 P2 的既定中间态。
6. `project get` 的输出按 T19 收紧为 Task + Activity 两块，投影里连 project 标识一起去掉（项目身份由 Host 注入的上下文提供）；`ProjectToolSnapshot` 因此只剩 `tasks` / `activity` / `nextCursor`。
7. Host 的 `updateProjectState` / `updateProjectDecision` / `updateProjectMemory` 保留（控制面与 UI 仍在用），只是模型侧不再有对应 action；测试用 mock 断言工具永远不碰这些 API。
8. `packages/host/tests/worker-prompts/project-prompt.test.ts` 断言过提示词正文内容，按 P0 收窄同步更新，并新增一条「渲染结果不含已删 action 名」的断言。

## 验证记录

| SHA / dirty 范围 | 环境 | 命令或操作 | 退出码 / 结果 | 证据 |
| --- | --- | --- | --- | --- |
| 2a37f8fe6（干净） | Linux 7.2.15 / Node 26.13 | `node scripts/junction-worktree.mjs . --primary /home/lavachen/.codex/worktrees/project-coordinator-tool-picker/duya` | 0 | worktree 内 61 条 junction，无穿越共享链接安装 |
| 2a37f8fe6 + 本次改动（dirty，未提交） | 同上 | `npm run build:packages` | 0 | 22 个包构建通过 |
| 2a37f8fe6 + 本次改动（dirty，未提交） | 同上 | `npm run typecheck:all` | 0 | 全量类型门禁通过 |
| 2a37f8fe6 + 本次改动（dirty，未提交） | 同上 | `npm run architecture:check` | 0 | `OK — no new boundary violations`；baseline 文件未改动，未用 `--write` 掩盖 |
| 2a37f8fe6 + 本次改动（dirty，未提交） | 同上 | `npx vitest run packages/capabilities packages/host` | 0 | 334 个测试文件、2885 个用例通过（2 skipped） |
| 2a37f8fe6 + 本次改动（dirty，未提交） | 同上 | `npm run check:encoding` | 0 | `no new violations (11 known)` |
| 2a37f8fe6 + 本次改动（dirty，未提交） | 同上 | `git diff --check` | 0 | 无空白错误 |
| 46d257655 / 236c6f183 | 同上 | CI `architecture`（首跑） | 1 | `bundle:verify` 判 STALE：12 个 bundle 输入在 bundle 提交后变更，需重建并提交 worker bundle |
| f67a5ec08 | 同上 | `npm run bundle:worker` + `npm run bundle:verify` | 0 | bundle 重建后 `FRESH 0/1121 bundle inputs changed` |

## 接续 / 结果

已实现：P0 工具面收窄（`project` 只剩 `get`，canonical `session` 去掉 `rename`，Coordinator 显式禁用 todo/fork/rename/catalog/invoke，提示词去掉已删 action 引用）。
已验证：类型门禁、架构门禁、capabilities + host 全部测试通过。
已交付：提交 `46d257655`，分支 `codex/project-coordinator-p0-tool-surface` 已推送，Draft PR [#644](https://github.com/lava-chen/duya/pull/644)（base `master`，CI 待跑）。
未提交路径：无。
副作用：P0 到 P2 之间 Coordinator 没有知识写入面；`duya_app` 的 `session_rename` 保留给 bot。
回收：未回收（worktree 与分支保留用于本次任务）。
下一步：等 PR #644 的 review 与 CI；合并需用户授权，合并后同步、重验并按 `scripts/remove-worktree.sh` 回收。
