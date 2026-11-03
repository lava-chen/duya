# TUI 反馈修复（2026-11-03）

用户在一次集中反馈里报了四件事，本计划逐条对应。第 5 条反馈为空（原消息截断），未纳入。

## 记录

- task / owner：主 agent 会话，owner=`tui-feedback`
- worktree：`.claude/worktrees/tui-feedback`
- 分支：`codex/tui-feedback`
- base：`04f7645f`（origin/master）
- 独占路径：`packages/cli/src/tui/**`、`packages/command-catalog/src/index.ts`、
  `packages/host/src/{worker-manager,worker-tool-pool}.ts`、`packages/host/src/worker-hooks/executor.ts`、
  `apps/desktop/src/main/agents/**`

## 反馈与处置

### 1. 每次对话弹出一个终端窗口

不是"后台服务"本身，而是 Host 为每个会话 `fork` 的 worker：TUI 启动的 Host 是
detached（`packages/cli/src/tui/background-host.ts`，`DETACHED_PROCESS`）因此**没有控制台**；
Windows 下由无控制台进程启动的 console 子系统子进程会被分配一个新控制台，也就是一个窗口。
`packages/host/src/worker-manager.ts#spawnWorker` 与 `worker-tool-pool.ts#createWorker` 都没传
`windowsHide`，所以每开一个会话就弹一个窗口，并跟着会话一直存在。

处置：所有"父进程可能无控制台"的 spawn 补 `windowsHide: true`——Host 的 worker fork / 工具池 /
hook 执行器，以及 Desktop 侧 agent server 与进程池的三处 spawn。`duya serve` 本身与 gateway
已有该参数，bash 工具走 `managed-shell` 也已有。

验证：本机 `duya chat` 起会话不再弹窗（需真机确认）；无自动化断言（Windows 控制台分配无法在
JS 内观测）。

### 2. slash 命令里有一批"看着就不该存在"的内部命令

`/capabilities`（Plan 610 T15 的能力握手自检）与 `/read-file`（证明 `workspace_filesystem`
真的可消费的探针）是开发期诊断入口，对使用者没有价值，且是"Host / CLI"字样的来源。

处置：从共享目录与 TUI 处理器表里整条删除（命令、实现、两个测试文件），保留
`host-capability-gate.ts` 的握手逻辑本身——它仍被 CLI 启动路径使用。

### 3. slash 描述的中英文混排与翻译腔

中文描述里混着 `Worktree 操作`、`Pull Request`、`bash 任务`、`token`，同一术语在不同条目里
叫法也不统一（`转录` / `会话记录`）。

处置：统一术语（transcript → 会话记录），中文里该有中文词的地方换掉（工作副本 / 拉取请求 /
后台命令任务），去掉 `该 Host 提供的能力，以及本 CLI 可以依赖的能力` 这类翻译腔；`token`、
`MCP`、`AGENTS.md`、`git diff` 等专有名词保留。

### 4. bash / 工具指令的渲染向 codex 靠拢

原来一条 `bash` 调用整行都是 `{gray-fg}`：命令和它的输出同色，读者要用眼睛解析哪一行是命令。

处置：新增 `packages/cli/src/tui/bash-highlight.ts`（单趟分词器，角色而不是颜色）：
`program` / `flag` / `string` / `operator` / `variable` / `comment` / `plain`。
`transcript-view.ts` 把角色映射到主题 token（accent+bold / warning / success / thinking /
heading / muted），走已有的 span → tag 管线，因此浅色主题同样正确。
另外 `[Exit code: N]` 改用 error 色（它是关于这次运行的事实，不是运行的输出）。

## 验收

- `node node_modules/vitest/vitest.mjs run packages/cli/src/tui/__tests__/ packages/command-catalog` — 77 文件 / 964 用例通过
- `node node_modules/vitest/vitest.mjs run packages/host/tests/worker-manager-*.test.ts` — 12 用例通过（这些会真的 fork 子进程）
- `npm run typecheck:all` — exit 0
- `npm run architecture:check` — exit 0，无新增违规（删除的两个文件留下 18 条失配指纹，未 `--write` 收缩）
- 真机：`duya chat` 起会话不弹窗；`/` 列表无 `/capabilities`、`/read-file`；bash 命令有颜色

PR：[#589](https://github.com/lava-chen/duya/pull/589)（base `04f7645f`，HEAD `386f74e3`）。

窗口本身没有自动化断言（Windows 控制台分配在 JS 内不可观测），需要真机确认。

## 遗留

- `docs/development/test-inventory.{md,json}` 仍列出已删的两个测试文件：`--write` 在没有
  `--report` 时拒绝执行（会丢掉所有已测时长），`--no-measurements` 代价更大。
- 架构 baseline 里 18 条指纹因文件删除而失配，收缩留到一次专门的 `--write`。

## 未纳入

- 反馈第 5 条（原消息为空）。
- TUI 其余英文 chrome（footer 提示、启动 banner）的中文化：这是独立的、体量更大的一片，
  与本次"slash 描述"不是同一件事，需要单独立项。
