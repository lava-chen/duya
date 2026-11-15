# CLI 后台会话工作台

状态：draft PR #639 · owner：本会话 · 更新：2026-11-15
分支：`codex/background-sessions-dashboard` · worktree：`/home/lavachen/.codex/worktrees/backend-sessions-dashboard/duya` · base：`53c9537ba` · owner：本会话

## 目标与边界

让 `duya tui` 有一个后台 session 工作台：按需要输入、运行中、已完成分组展示会话；键盘和鼠标都能打开会话；底部 composer 可直接描述任务并创建新的独立 session，让该任务在后台运行而不切走当前 session。

关联：[TUI 后台任务视图](2026-10-24-tui-background-tasks.md) 已实现 bash/subagent 的任务观察；本计划扩展到可恢复的 session，不更改既有 `F6` task 视图语义。

## 验收

- `/sessions` 打开后台会话工作台，显示“需要输入 / 运行中 / 已完成”分组与可操作的空态。
- 每个会话行支持方向键 + Enter 与鼠标点击；打开后显示对应 session transcript，且只有当前 session 闲置时才允许切换。
- 工作台 composer 提交任务后创建独立 session 并启动 Host run；主 session 不切换，列表及时显示新 session 的状态。
- 新 session 的 run 完成、失败或等待用户决策后，状态分组能更新；关闭/重开工作台保留 Host 中已持久化的会话并恢复可访问性。
- 运行 CLI 相关测试、`npm run typecheck:all`、`npm run architecture:check`；检查真实 TUI/PTY 工作流和构建产物。

## 进度

- [x] 核对既有 `/sessions`、后台任务视图、Host Session API 与 TUI 渲染入口。
- [x] 实现 session 状态分组、内联工作台布局、键盘导航与鼠标打开；保留原 `/tasks` / F6 行为。
- [x] 接入底部 composer、独立 session 创建与 Host run 启动；刷新运行/等待批准/完成状态；点击其他 session 复用现有 transcript 切换流程。
- [x] 基线对照、相关 TUI/Host 用例、全仓类型与架构门禁、CLI 开发构建。
- [x] 创建实现提交并推送到 [draft PR #639](https://github.com/lava-chen/duya/pull/639)；不合并，等待 review/CI。

## 发现与决策

- `/sessions` 当前是一次性 `chooseFiltered` picker；侧栏已有 All sessions 入口，可沿用命令入口。
- `/tasks` 已管理 bash/subagent 的观察视图，不替代 root session 浏览；保留其 `/tasks`、F6 和 `Ctrl+K` 语义。
- Host 已提供 `create` / `startAgentRun` / session transcript / run ledger HTTP 客户端，因此新增任务应建立独立的普通 session；不借用 parent-bound `session_spawn` 权限模型。
- 用户明确选择“后台独立运行”，所以任务提交不切换当前 session。会话行打开时沿用现有闲置期切换保护。

## 验证记录

| SHA / dirty 范围 | 环境 | 命令或操作 | 退出码 / 结果 | 证据 |
| --- | --- | --- | --- | --- |
| base `53c9537ba` | Linux x64 / Node v26.13.0 | 相关测试基线；首次缺 `@duya/plugin-core` dist 后先跑 `npm run build:packages` 并重跑 | 第一次 3 files / 28 tests pass，1 suite 因缺构建产物无法载入；重跑 4 files / 33 tests pass | 新检出初始包产物缺失，构建后基线干净 |
| PR #639 当前 head（base `53c9537ba`）+ 本计划 PR 状态更新 | Linux x64 / Node v26.13.0 | 5 个相关 Vitest 文件（含 dashboard 键盘/提交/鼠标测试） | 36 tests pass | 新增 3 个 dashboard 测试；`git diff --check` 通过 |
| 同上 | 同上 | `npm run typecheck:all` | 0 | 包构建与所有 workspace typecheck 通过 |
| 同上 | 同上 | `npm run architecture:check` | 0 | 无新增边界违规；baseline 收缩仅提示 |
| 同上 | 同上 | `npm run -w @duya/cli typecheck` | 0 | 最终代码的 CLI 类型检查通过 |
| 同上 | 同上 | `npm run build:cli-dev` | 0 | CLI、worker 与 bundle 生成成功；还原了本任务无关的 Host bundle 生成文件 |
| 同上 | 同上 | 实际 TUI 集成 | 未做 | 自动化终端 harness 验证了状态分组、composer 路由和鼠标；未接真实 Provider/Host 完成一轮模型运行 |

## 接续 / 结果

实现和本地验证已完成；分支 `codex/background-sessions-dashboard`，base `53c9537ba`，当前 SHA 以 PR #639 head 为准；代码与计划已推送到 draft PR #639。新检出依赖 junction 是未跟踪的 `node_modules` symlink，属于 worktree 环境，不要暂存。没有真实 Provider run 验收。`Needs input` 中的普通批准请求可从打开的会话作一次/按会话批准/拒绝；AskUserQuestion 仍需回到启动它的客户端回答。
回收：PR 集成前保留 managed worktree；不合并。
下一步：等待 PR review 与 CI；修复必需检查发现的问题，再由获授权的集成者评估集成。
