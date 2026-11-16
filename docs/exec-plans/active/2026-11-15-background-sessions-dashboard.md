# CLI 后台会话工作台

状态：draft PR #639 · owner：本会话 · 更新：2026-11-16
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
- Review 发现：实现只覆盖了 inline 布局，而 `displayMode` 默认已是 `fullscreen`（plan 2026-11-11-tui-fullscreen-framework S4）。工作台改为两种模式都渲染：inline 走 composer 上方的 chrome 带，full-screen 走 transcript 区域（会话列表取代对话视图，Esc 后复原）。
- Review 发现：F6 task 视图在 full-screen 同样不可见（`taskViewLines()` 在 `inlineSurface === null` 时返回空），属上游既有缺陷，不在本 PR 范围内，已在 review 记录。

## Review（PR #639，2026-11-16）

Reviewer 以 PR head `e47faf3eb` 为基线复核，发现并修复：

| 级别 | 问题 | 处理 |
| --- | --- | --- |
| 阻断 | CI `test` 失败：chat 测试里的 TUIApp stub 没有 `isSessionsDashboardOpen`，2 秒轮询定时器在 stub 上抛未捕获异常 | 7 个 stub 补齐 `isSessionsDashboardOpen` / `setSessionDashboardEntries` / `openSessionsDashboard` / `closeSessionsDashboard` |
| 阻断 | 默认 full-screen 模式下工作台不渲染：`taskViewLines()` 只在 inline 出图，`/sessions` 只改 footer | full-screen 下把工作台画进 transcript 区域，并补齐该区域的点击区域 |
| 重大 | 工作台聚焦时 composer 光标被隐藏（inline caret 与 `placeCursor` 都要求 focus=`input`），但工作台的 composer 正是输入新任务的地方 | 两种模式的 caret 在 `focus === 'sessions'` 时都留在 composer |
| 中 | 工作台打开时输入 `/model` 等命令会被当成后台会话 prompt（`submitText` 在 sessions 分支直接截走） | 命令行按 `isControllerLine` 走原有命令路径，只有普通文本才进后台会话 |
| 中 | 轮询失败每 2 秒打印一次同样的错误 | 同一失败连续只打印一行，恢复后重置 |
| 小 | `/sessions <id>` 的直接恢复被工作台吞掉 | 带参数仍走 `resumeSession(args)`，裸 `/sessions` 才开工作台 |
| 小 | `ask_user_question` 的待决项也标成 “waiting for approval”，但它只能回到发起它的客户端回答 | 该模式改标 “question waiting” |
| 小 | 工作台聚焦时按 Tab 走 `toggleFocus()`，把用户带去 task 视图而不是离开工作台 | composer 为空时 Tab 关闭工作台；有文本时仍缩进 |

未修（记录待办）：工作台每次刷新对每个 session 各查一次 run ledger（N+1 请求，Host 没有批量接口）；inline 模式下为支持点击而开启 mouse reporting，会在该视图内吃掉滚轮（终端 scrollback 不再滚动），关闭工作台即恢复。

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
| review 修复后（PR #639 head + review 提交） | Linux x64 / Node v26.13.0 | `npx vitest run packages/cli/src` | 0 | 147 files / 1787 tests pass（1 expected fail）；新增 full-screen 渲染、full-screen 点击与命令路由用例 |
| 同上 | 同上 | `npm run typecheck:all` | 0 | 全仓类型检查通过（首轮 `taskViewLines` 只读数组赋给可变数组报错，已改为拷贝） |
| 同上 | 同上 | `npm run architecture:check` | 0 | 无新增边界违规；baseline 收缩仅提示 |
| 同上 | 同上 | CI `test` job（PR #639 上一版 head） | 1 | 失败于 `tui.isSessionsDashboardOpen is not a function`；本轮修复后需重跑确认 |
| review 全部修复后（PR #639 head `39c5ae3cf`） | 同上 | `npx vitest run packages/cli/src` · `npm run typecheck:all` · `npm run architecture:check` | 0 · 0 · 0 | 147 files / 1788 tests pass（1 expected fail）；全仓类型检查与架构门禁通过 |

## 接续 / 结果

实现和本地验证已完成；分支 `codex/background-sessions-dashboard`，base `53c9537ba`，当前 SHA 以 PR #639 head 为准；代码与计划已推送到 draft PR #639。Review 修复（CI stub、full-screen 渲染、caret、命令路由、错误去重、`/sessions <id>`）已追加提交到同一分支。
新检出依赖 junction 是未跟踪的 `node_modules` symlink，属于 worktree 环境，不要暂存。没有真实 Provider run 验收。`Needs input` 中的普通批准请求可从打开的会话作一次/按会话批准/拒绝；AskUserQuestion 仍需回到启动它的客户端回答。
回收：PR 集成前保留 managed worktree；不合并。
下一步：等 CI 在修复后的 head 上重跑；由获授权的集成者评估集成。
