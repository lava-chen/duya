# TUI busy 期 slash 命令：catalog 单一驱动 + 排队档

状态：active · 负责人：agent · 更新：2026-10-29
分支：codex/tui-busy-slash-catalog · worktree：.claude/worktrees/tui-busy-slash-catalog · base：49800ec5 · owner：agent

## 目标与边界

用户能观察到的变化：

1. **busy 时弹窗只列可用的命令**：回合运行时，`/` 弹窗不再出现该回合里跑不了的命令
   （`/model`、`/compact`、`/fork`、`/archive`、`/delete`、`/project`、`/worktree`、`/init`），
   只留下只读 / 配置 / 面板类命令。
2. **拒绝文案出自 catalog**：命令在 busy 时被拒，不再由每个命令各写各的一句话，
   而是走 `commandAvailability(spec, {hasSession, busy})` 拿到的统一原因
   （`packages/command-catalog/src/index.ts:856`）。
3. **排队档**：busy 时提交一条「改状态」的 slash 命令，不再直接被拒，
   而是排进本回合之后的队列；本轮结束后自动执行。执行结果按命令自身的
   成功 / 失败语义回显，不静默。

允许修改：

- `packages/command-catalog/src/index.ts`（补 `availableWhileBusy` 声明）
- `packages/cli/src/tui/slash/registry.ts`（弹窗按 busy 过滤）
- `packages/cli/src/tui/slash/*.ts`（去掉各自散落的 busy 判定，改用 catalog）
- `packages/cli/src/chat.ts`（dispatch 处统一闸门 + 排队执行）
- `packages/cli/src/tui/TUIApp.ts`（必要时暴露队列状态给 UI）
- 上述路径的测试；`docs/exec-plans/` 下本计划

本次不做：

- Desktop / Web UI 改动（Desktop 已在 `packages/ui/src/lib/commands/executors/registry.ts:119`
  走 catalog 闸门；本切片让 CLI 与它对齐）。
- 切片 B（左箭头全局会话总览面板）——独立计划与 PR。
- 改状态的命令在 busy 时的**立即**执行（仍要排队）：codex 的 `available_during_task()`
  允许一部分命令在 task 进行中立即 dispatch，但那些命令是纯本地副作用
  （`/model`、`/title`、`/statusline`）。duya 的 `/model` 要写 Host 会话记录，
  在本轮跑到一半时改模型会让「本轮用哪个模型」变成不确定的，
  所以本切片对所有 busy 不可用的命令一律排队，不引入立即执行的第三档。

关联参考（只读）：

- `E:\cloned-projects\codex\codex-rs\tui\src\slash_command.rs:249`
  `available_during_task()`：逐命令声明能否在 task 进行中运行。
- `E:\cloned-projects\codex\codex-rs\tui\src\chatwidget\slash_dispatch.rs:137`
  `slash_command_blocked_by_active_task()`：不可用的命令被拦下并报
  "'/x' is disabled while a task is in progress."
- `E:\cloned-projects\codex\codex-rs\tui\src\bottom_pane\chat_composer\slash_input.rs:198`
  `queued_input_action()`：`defer_slash_validation` 时 slash 输入被标成
  `QueuedInputAction::ParseSlash`。
- `E:\cloned-projects\codex\codex-rs\tui\src\chatwidget\input_flow.rs:324`
  `maybe_send_next_queued_input()` 排空 `ParseSlash` 项 → `submit_queued_slash_prompt()`。
- `E:\cloned-projects\codex\codex-rs\tui\src\chatwidget\slash_dispatch.rs:1142`
  `submit_queued_slash_prompt()`：排空时按当时的 busy 状态重新判定命令是否可用。

## 验收

- `node node_modules/vitest/vitest.mjs run packages/command-catalog/tests packages/cli/src/tui/slash/__tests__ packages/cli/src/tui/__tests__`
- `node node_modules/vitest/vitest.mjs run packages/cli/src/__tests__`
- `npm run typecheck:all` 退出码 0
- `npm run architecture:check` 退出码 0
- 新增用例覆盖：
  - busy 时弹窗不含 `availableWhileBusy !== true` 的命令；空闲时含。
  - busy 时提交 `/compact` 被排进队列而非被拒；本轮结束后自动执行。
  - busy 时提交 `/status` 立即执行（`availableWhileBusy: true`）。
  - 排队中的 slash 在本轮结束前不执行，本轮结束后执行一次。
  - 排队的 slash 若在排空时仍不可用（turn 尚未真正结束），不被丢弃。

## 进度

- [x] 考古与对比：codex 的 `available_during_task` / `ParseSlash` 队列 / `submit_queued_slash_prompt`
- [x] 分配 worktree、junction 依赖、记录 base
- [ ] catalog 补齐 `availableWhileBusy` 声明（逐命令核对）
- [ ] CLI 弹窗按 busy 过滤
- [ ] CLI dispatch 统一走 `commandAvailability`，去掉各命令散落的 busy 判定
- [ ] busy 期 slash 排队档：入队 → 排空执行
- [ ] 定向测试 + architecture:check + typecheck:all
- [ ] commit + PR

## 发现与决策

- **busy 时 slash 已经能到达 dispatch**：`packages/cli/src/tui/TUIApp.ts:3937` 的
  `isControllerLine(text)` 豁免让 `/` 开头的行走 `onSubmit` 而不是 steer，
  所以问题不是「够不到」，是「够到之后行为不一致」。
- **弹窗没按 busy 过滤**：`packages/cli/src/chat.ts:784` 调 `buildSlashCompletionRows({ locale })`
  时没传 `busy`，`advertisedSpecs` 的 `options.busy ?? false` 于是永远按空闲过滤。
- **拒绝文案散落**：`/model`（`slash/model.ts:288`）、`/compact`（`slash/compact.ts:114`）、
  `/project`（`slash/project.ts:171`）、`/worktree`（`slash/worktree.ts:41`）、
  `/fork` `/archive` `/delete`（`slash/session-ops.ts:48` 的 `refuseWhileBusy`）
  各写各的一句话措辞。Desktop 侧已经走 catalog 的 `commandAvailability`，
  CLI 与它不一致。
- **catalog 缺声明**：多数命令没写 `availableWhileBusy`，按 `availableWhileBusy !== true`
  的判定规则即「busy 时不可用」——这个默认是对的（缺声明 = 不许在 busy 跑），
  但少数确实安全的命令（`/model` 之外的那些已声明为 true 的）需要核对，
  以及 `/compact`、`/fork` 等的**新**语义是「排队」而不是「拒绝」，
  闸门本身仍应拒绝立即执行。
- **排队档落点**：CLI 已有 `TurnQueue`（`packages/cli/src/tui/turn-queue.ts`）
  持有 steer / queued 草稿，且已有 `/queue` 面板管理它们。
  排队的 slash 命令应当复用这条队列而不是另起一条，
  这样 `/queue` 面板能同时看到「草稿」与「待执行的命令」，
  用户也能撤回一条还没执行的命令。
- **排空时机**：`packages/cli/src/chat.ts` 的 `TurnQueue.execute` 回调是
  `runTurn(text, draft)`；排空发生在本轮结束后。codex 的 `submit_queued_slash_prompt`
  在排空时**重新判定**命令是否可用——本切片照做，
  否则一条排队命令在排空时 turn 还没真正结束就会被误执行。
- **不引入 codex 的立即执行第三档**：见「本次不做」。

## 验证记录

| SHA / dirty 范围 | 环境 | 命令或操作 | 退出码 / 结果 | 证据 |
| --- | --- | --- | --- | --- |
| 49800ec5（base，worktree 干净） | Windows 11 / Node 24 | 读 codex 与 duya 源码核对上述文件行号 | — | 见「发现与决策」 |

## 接续 / 结果

已实现：无。
已验证：无。
PR：未开。
回收：未回收。
下一步：核对 catalog 里每个 CLI 命令的 `availableWhileBusy` 声明，
补齐 / 修正后写 `packages/command-catalog/tests` 的断言。
