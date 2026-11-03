# TUI 反馈修复（2026-11-03）

用户在一次集中反馈里报了四件事，第 5 条当时是空的（原消息截断），随后补了一张截图
（steer 回显后底部仍有提示），一并纳入。本计划逐条对应。

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

### 5. steer 已经发出去了，输入框下面还在提示它

按下 Enter 之后 steer 的文字已经在转录里回显了一行，但 composer 上方的队列预览还会为它画一行
`↳ sent · <text>`，一直画到这一轮结束。用户看到的是"我发的东西还悬在输入框上面"，因此判断它
没发出去。

根因是这行状态没有主人：`PendingDraft.mode` 同时被当成"投递方式"和"投递状态"用，预览据此
分叉成 `↳ sent` / `⧗ queued`。可是这个区块紧贴 composer，里面的一切都在说"你还在等它"——一条
已经交付的 steer 出现在这里，重复的是转录里已有的那一行。

处置：让"是否还在等"只有一个来源。`TurnQueue.waiting` 只返回 `mode: 'queue'` 的草稿；
steer 仍留在 `pending` 里，因为下一轮还要问 Host 那行 mailbox 是否被 claim 过，但那是记账，
不是要画的东西（没被 claim 时 `runTurn` 会打印 notice）。随之 `QueuedDraftView` 去掉 `mode`：
一个能表达"已经发出去"的视图，正是这个区块先后两次出错的来源（第一次是把 steer 画成排队）。

参照：codex 的 `bottom_pane/pending_input_preview.rs` 把待发 steer 放在
`Messages to be submitted after next tool call` 标题下，服务端一提交就把它从列表里摘掉；
duya 在回显那一刻就算提交了，所以这个预览里根本不该有 steer。

验证：`turn-queue.test.ts` 新增 `waiting` 用例（steer 留在 `drafts`、不在 `waiting`）；
`tui-inline-mode.test.ts` 的预览用例改为只喂等待中的草稿。

## 验收

- `node node_modules/vitest/vitest.mjs run packages/cli/src/tui/__tests__/ packages/command-catalog` — 77 文件 / 948 通过（另 1 个 expected fail）
- `node node_modules/vitest/vitest.mjs run packages/host/tests/worker-manager-*.test.ts` — 12 用例通过（这些会真的 fork 子进程）
- `npm run typecheck:all` — exit 0
- `npm run architecture:check` — exit 0，无新增违规（删除的两个文件留下 18 条失配指纹；`--write` 顺带会把 523 条聚合条目重新记一遍，不属于本次范围，未做）
- `npm run bundle:verify` — exit 0，bundle 提交后 0/1029 输入变更
- 真机：`duya chat` 起会话不弹窗；`/` 列表无 `/capabilities`、`/read-file`；bash 命令有颜色

PR：[#589](https://github.com/lava-chen/duya/pull/589)（base `04f7645f`，已并入 `203d7d51` 的 master）。

窗口本身没有自动化断言（Windows 控制台分配在 JS 内不可观测），需要真机确认。

## 追记：worker bundle 必须同一次改动里重建

`windowsHide` 落在 `worker-manager.ts` / `worker-tool-pool.ts` / `worker-hooks/executor.ts`，
三个都是 `bundle:verify` 眼里的 bundle 输入，所以第一次推上去 architecture job 直接红在
`bundle-verify` 上（3 个输入比 bundle 提交新）。

重建时踩到的坑：本机 `core.autocrlf=true` 让工作树全是 CRLF，而 esbuild 按字节读，metafile
里每个输入的 `bytes` 都被撑大 +2/行（`487 → 497`）。做法是先把工作树转成 LF 再构建，构建完
把 blob 本身是 CRLF 的那 21 个文件 restore 回 HEAD（`git restore --source=HEAD --staged
--worktree --pathspec-from-file`），否则 `git status` 里会挂着 5000 个假改——而 `bundle-verify`
的"未提交输入"判据正是 `git status --porcelain`。

## 遗留

- `docs/development/test-inventory.{md,json}` 仍列出已删的两个测试文件：`--write` 在没有
  `--report` 时拒绝执行（会丢掉所有已测时长），`--no-measurements` 代价更大。
- 架构 baseline 里 18 条指纹因文件删除而失配，收缩留到一次专门的 `--write`。

## 未纳入

- TUI 其余英文 chrome（footer 提示、启动 banner）的中文化：这是独立的、体量更大的一片，
  与本次"slash 描述"不是同一件事，需要单独立项。
- "steer 是否已被这一轮读到"没有实时反馈：预览不画它，是靠"已回显即已交付"这条契约成立的；
  若要让底部显示 `picked up`（Desktop 的 `mailbox.bubble.pickedUp` 那种），需要一个 mailbox
  状态事件或轮询，属于协议侧改动。
