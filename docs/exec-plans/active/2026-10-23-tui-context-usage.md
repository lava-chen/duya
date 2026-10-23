# TUI 上下文占用率:占用 ≠ 花费

状态：active · 负责人：mavis · 更新：2026-10-23
分支：codex/tui-context-usage · worktree：.claude/worktrees/tui-context-usage · base：c81ed169 · owner：mavis

## 目标与边界

用户能观察到的变化：状态栏与 Ctrl+P 窗口里的「上下文占用」不再等于「本会话累计花费」。
占用率按**下一次请求会带多少 token** 计算,累计花费仍单独一行。

允许修改：`packages/cli/src/tui/blocks.ts`（上下文字符计数）、`TUIApp.ts`（占用率计算与展示）
及其测试。
本次不做:pi 的「保留额度」阈值(`contextWindow - reserveTokens`,默认 16384)—— 那是压缩触发条件,
不是展示量;duya 的压缩策略另有一套。
关联参考:`E:\cloned-projects\pi` → `packages/ai/src/utils/estimate.ts:14-19, 89-103`、
`packages/coding-agent/src/core/agent-session.ts:3335-3342`、
`packages/coding-agent/src/modes/interactive/components/footer.ts:147-161`。

## 验收

- `npx vitest run packages/cli/src/tui/` 全绿
- `npm run typecheck:all` 与 `npm run architecture:check` 退出码 0
- 用例证明「两次计费调用后,占用率不翻倍」
- 变异证据:把占用率改回会话累计,新用例必须转红

## 进度

- [x] 读 pi 的 context 估算与展示
- [x] `TranscriptModel` 维护上下文字符计数(`contextChars`)
- [x] `TUIApp` 新增 `contextTokens()` / `usageCharBaseline`,`contextPercent()` 改用占用
- [x] footer、状态栏、Ctrl+P 窗口三处展示改用占用语义
- [x] 单元测试(字符计数)+ 行为测试(占用 ≠ 花费)
- [x] 变异验证
- [ ] 门禁 + commit + PR

## 发现与决策

- **根因**:`contextPercent()` 用的是 `sessionTokens / budget`,而 `sessionTokens` 是
  「本会话所有计费调用之和」。这是**花费**,不是**占用**。长会话里它一路涨到 100%,
  而窗口其实还很空 —— 状态栏在说「装满了」,模型却还有整段上下文可用。
- **pi 的算法**(`packages/ai/src/utils/estimate.ts:89-103`):取**最后一条有 usage 的
  assistant 消息**的 `usage.totalTokens` 作基线,再对它之后的消息按 chars/4 估算,
  相加除以 `contextWindow`。关键是「最后一条 usage」而不是「所有 usage 之和」。
- **duya 的对应**:每次模型请求都携带完整历史,所以 `lastUsage.total` 已经≈当时的窗口占用;
  之后新增的内容(下一轮用户输入 + assistant 输出 + 工具结果)按 chars/4 补上。
  估算锚点记在 `usageCharBaseline`,收到 `token_usage` 帧时重置。
- **字符计数放在模型层**(`TranscriptModel.contextChars`):footer 每帧都要问这个数,
  走一遍上万块就是每帧 O(n)。所以在文本变更点增量维护:用户输入、assistant 文本、
  reasoning、工具入参(建块时计一次)、工具结果。整块帧是**替换** deltas,计数跟着替换走,
  不重复累加。
- **工具结果要算**:它会随下一次请求回到模型,常常是窗口里最大的一块。
- **展示**:pi 把「累计计费」与「上下文占用」分成两组(footer 第一行是
  `↑in ↓out RcacheRead WcacheWrite CHhit% $cost`,占用另算)。duya 原本就在
  Ctrl+P 窗口分了两行(`session` / `context`),这次只是把 `context` 那行的数字换对,
  并补上绝对值。footer 的 `Σ` 累计与占用条保持分开。

## 验证记录

| SHA / dirty 范围 | 环境 | 命令或操作 | 退出码 / 结果 | 证据 |
| --- | --- | --- | --- | --- |
| 工作区（占用改造） | Windows / Node | `npm run -w @duya/cli typecheck` | 1（2 处 `Duplicate identifier` / 私有字段冲突） | 字段名与 getter 撞名,已改名 `contextCharCount` |
| 工作区（占用改造） | Windows / Node | `npx vitest run packages/cli/src/tui/` | 0（71 files / 903 passed） | 含 6 个 `contextChars` 用例 |
| 工作区（+变异） | Windows / Node | 把 `contextPercent` 改回用 `sessionTokens` | 1（新用例转红） | 证明用例有牙齿,非恒绿 |

## 接续 / 结果

未提交。worktree `.claude/worktrees/tui-context-usage` 独占
`packages/cli/src/tui/{blocks.ts,TUIApp.ts}` 与相关测试 —— 与 `tui-todo-list` 分支
(改 `blocks.ts` 的 todo 字段)同文件不同位置,合并时需注意 `blocks.ts` 的冲突。
下一步:跑 `npm run typecheck:all` 与 `npm run architecture:check`,提交并开 PR。
