# CLI TUI 忙碌期消息：steer / 排队 / 打断发送

状态：active · 负责人：agent · 更新：2026-10-24
分支：codex/tui-queue-steer · worktree：.claude/worktrees/tui-queue-steer · base：686f3c81 · owner：agent

## 目标与边界

用户能观察到的变化：

1. run 进行中按 Enter（编辑器非空）= **steer**：草稿立即作为 runtime guidance 送进当前 run，在下一次
   `before_model_turn` 注入；transcript 里立刻回显这条用户消息。
2. run 进行中按 Tab = **排队**：草稿留到本轮结束后再作为新 turn 发出。
3. run 进行中按 Esc（编辑器非空）= **打断发送**：取消当前 run，并把草稿插到队首，取消落定后立刻发送；
   编辑器为空时 Esc 仍然只是打断。
4. `/queue` 打开管理面板，逐条支持 **撤回编辑**（回填 composer）、**立即插入**（转 steer）、**删除**；
   原有的 `resume` / `clear` 保留。
5. 队列预览从「只显示最后一条」改为逐条显示，并标出 steer / queued。

允许修改：`packages/cli/src/tui/{turn-queue.ts,TUIApp.ts,dev/preview.ts}`、`packages/cli/src/chat.ts`
及其测试与 `packages/cli/src/__tests__/` 下受影响的接线测试。

本次不做：

- Desktop / Web UI 改动（Desktop 已有相同能力）。
- 启动时从 mailbox 恢复上一进程遗留的 pending 行（后续切片；本次 queued 仍只存在于本进程）。
- 把 steer 正文写进 durable timeline（当前 Host 只在模型上下文注入，transcript 只做本地回显）。
- 新增 `agent.busy_message_mode` 的 TUI 开关：本 TUI 固定 Enter=steer / Tab=queue。

关联参考（只读）：

- `E:\cloned-projects\codex`：`codex-rs/tui/src/keymap.rs`（`composer.submit`=Enter、`composer.queue`=Tab、
  `chat.interrupt_turn`=Esc）、`bottom_pane/pending_input_preview.rs`（steer / queued 分段预览）。
- `E:\cloned-projects\minimax-code`：`shell/keybindings.ts`（`run.submit-guidance` / `run.queue-draft` /
  `run.restore-waiting`）、`features/queue/panel.ts`、`controller/run/queue-flow.ts`（管理面板与队列流转）。

## 验收

- `node node_modules/vitest/vitest.mjs run packages/cli/src/tui/__tests__/turn-queue.test.ts packages/cli/src/tui/__tests__/tui-key-routing.test.ts packages/cli/src/tui/__tests__/tui-permission-picker.test.ts packages/cli/src/__tests__/chat-tui-foundation.test.ts`
- `npm run typecheck:all` 退出码 0
- `npm run architecture:check` 退出码 0
- 新增用例覆盖：busy+Enter 走 steer、busy+Tab 走 queue、busy+Esc 有草稿时置队首并恢复排空、
  `/queue` 删除 / 撤回 / 立即插入作用于指定条目、steer 未被认领时下一次排空跳过或补投。

## 进度

- [x] 考古与对比：duya 已有 Host mailbox `guide`/claim 通道，CLI 从未使用；`SteerAgentRunInput` 无 Host 实现
- [x] 分配 worktree、junction 依赖、记录 base
- [x] `turn-queue.ts`：草稿身份（key / mailboxId / mode / echoed）、`front` 提交、`remove`、`reclassify`、`skipped` 结果
- [x] `TUIApp.ts`：键路由与逐条预览、新回调、状态栏提示、`/`/`!` 命令行豁免
- [x] `chat.ts`：steer 入 mailbox、`/queue` 管理面板、drain 前校正 mailbox 行
- [x] 定向测试 + architecture:check
- [x] `npm run typecheck:all` 全绿（退出码 0）
- [x] commit + PR #454（不合并）

## 发现与决策

- **不需要新的 steer 协议**：`packages/agent-protocol/src/run-api.ts` 的 `steerAgentRun` 至今没有 Host
  实现；真正可用的通道是 mailbox —— `guide()` 把行改成 `kind='followup'`，worker 在
  `before_model_turn` 认领并作为 runtime guidance 注入（`worker-session-runtime.ts` 的
  `_claimMailboxAtCheckpoint`）。`HostSessionHttpClient` 已经暴露 `enqueue/guide/promoteQueued/cancel/edit`。
- **steer 直接以 `kind='followup'` 入队**，不走 `guide()`：`promoteQueued` 拒绝
  `apply_mode='runtime_instruction'` 的行，而 `claimBatch` 只看 `kind`。kind 即 followup 时行可在本轮被
  认领；若本轮结束前没被认领，行仍是 pending，客户端还能 promote 成下一 turn。
- **`before_final_answer` 不认领用户消息**（plan 570 的显式规则），所以「run 结束后仍在 pending 的 steer」
  是正常竞态，不是异常。客户端在下一次排空时把仍 pending 的行投递为新 turn，而不是像 codex 那样留到下次
  用户提交（理由：消息悬空比多一轮更糟，且 duya 没有「pending steer 重投」UI）。
- **queued 仍由客户端 `TurnQueue` 持有**：mailbox 行只在 steer 时创建，避免遗留 pending 行与启动恢复
  问题，也保持现有「草稿只在进入 Host turn 时进 transcript」的语义。
- **Esc 打断发送复用现有状态机**：`interrupt()` 已 `queue.pause()`；再 `resume()` 置 `resumeAfterActive`，
  把草稿放到队首。`run()` 在 outcome=`cancelled` 且 `resumeAfterActive` 时继续排空，正是「取消后立刻发」。
  代价：Esc-and-send 会恢复整个队列，打断前已排队的旧草稿也会跟着发出。接受，因为「停止并发送」本身
  就是一次显式的继续；纯 Ctrl+C / Esc（无草稿）仍保持 paused 语义。
- **Tab 冲突**：Tab 同时是补全接受键与缩进键。只是 busy + 编辑器非空 + 补全弹窗未消费时才排队，其余不变。
- **`/`、`!` 行不是草稿**：`isControllerLine()` 让 `/queue` 在 run 期间仍打开面板、`!cmd` 仍在本终端执行；
  Enter 走 `onSubmit`，Esc 只停止、把命令行留在 composer，Tab 仍是缩进。否则 `/queue` 会被当成 steer
  喂给模型。
- **`/queue` 面板逐条操作**：Send now（busy 时转 steer，空闲时提到队首并排空）、Edit（steer 改 mailbox 行
  内容，queued 改本地草稿）、Recall to composer（移出队列并取消 mailbox 行）、Delete/Withdraw；
  `/queue clear` 先收集 steer 行再清空，逐行 `cancel`。`TurnQueue.reclassify` 原地改写，保持队内位置。
- **steer 回显一次**：提交时 `tui.printUser` 并置 `echoed`，runTurn 不再重复打印；若该行没被认领、后来
  作为新 turn 投递，用通知说明「上一条 steer 未被吸收，已作为新一轮发送」。
- **预览固定 3 行**：inline 模式每多一行都会把 composer 往下推，所以只显示最后 3 条并在前面汇总
  `… N earlier`；steer 行用 `↳ steer` 与 queued 的 `⧗ queued` 区分。
- **drain 前校正失败不静默**：`getItem` / `cancel` 抛错时打印错误并返回 `failed`（暂停队列），
  不吞掉一条可能已丢失的消息。

## 验证记录

| SHA / dirty 范围 | 环境 | 命令或操作 | 退出码 / 结果 | 证据 |
| --- | --- | --- | --- | --- |
| 686f3c81（base，worktree 干净） | Windows 10 / Node 24.18.0 | 读代码核对 mailbox / worker claim / TUI 键路由 | — | 见「发现与决策」 |
| 686f3c81 + 未提交改动 | Windows 10 / Node 24.18.0 | `CODEBUDDY_SAFE_DELETE_ENABLED=0 node scripts/build-packages.mjs --profile unit-suite` | 0（19 包） | 新 worktree 无 `dist/`，vitest 无法解析 `@duya/ai/context` |
| 同上 | 同上 | `node node_modules/vitest/vitest.mjs run packages/cli/src/tui/__tests__ packages/cli/src/tui/slash/__tests__` | 0（66 文件 / 838 用例） | 含新增 `turn-queue.test.ts`（12）与 `tui-busy-draft-keys.test.ts`（11） |
| 同上 | 同上 | `node node_modules/vitest/vitest.mjs run packages/cli/src/__tests__` | 0（9 文件 / 55 用例） | 含 `chat-tui-foundation.test.ts`（13，新增 5 条接线用例） |
| 同上 | 同上 | `node node_modules/vitest/vitest.mjs run --pool=threads --maxWorkers=2 packages/cli/src/tui/__tests__ packages/cli/src/__tests__` | 0（73 文件 / 817 用例） | 移除 `queuedPrompts`、新增 inline 队列预览用例、review 修复后的最终合并跑 |
| 同上 | 同上 | `node scripts/architecture/architecture-check.mjs` | 0 | 2721 条全部为既有 baseline，无新增违规 |
| 同上 | 同上 | `npm run typecheck:all` | 0 | 构建 21/21；electron gate「no new type errors（206 known）」 |
| 同上 | 同上 | `cd packages/cli && node ../../node_modules/typescript/bin/tsc --noEmit` | 0 | 移除 `queuedPrompts` 后再确认 CLI 段 |

## 接续 / 结果

已实现：TurnQueue 草稿身份与 `skipped`/`reclassify`；TUIApp 的 Enter=steer / Tab=queue / Esc=打断发送、
逐条预览、命令行豁免；chat.ts 的 mailbox steer、`/queue` 管理面板、drain 前校正与单次回显。
已验证：上述测试、architecture:check（退出码 0）与 `npm run typecheck:all`（退出码 0，见验证记录）。
PR：#454（`feat(cli): steer, queue, or stop-and-send while a turn runs`，未合并）。
回收：worktree `.claude/worktrees/tui-queue-steer` 保留，未回收。
下一步：等 PR #454 的必需检查与 review；未获合并授权前不合并。
