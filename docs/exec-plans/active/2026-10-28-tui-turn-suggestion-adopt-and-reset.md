# TUI 下一步建议：能真正填入输入框，且换会话不留旧建议

状态：active（功能已合并 master；剩真机冒烟待用户） · 负责人：claude-code 会话 · 更新：2026-10-28
分支：`codex/tui-turn-suggestion-landing`（落地记录） · worktree：`E:/Projects/duya/.claude/worktrees/tui-turn-suggestion-fix` · base：`356d0370`（已合并 master） · owner：claude-code 会话 · PR：#532 已合并
提交：`9fd12f60` fix(cli): adopt the turn suggestion on enter · `a5a100b2` fix(cli): retire the turn suggestion at a session boundary · `e52598e9` / `474f513a` 计划记录

## 目标与边界

用户能观察到的变化：

- TUI 里 turn 结束后输入框出现的灰字建议，**按 Enter 会真的填进输入框**（可编辑、可再按 Enter 发送），不再是一行没人能接手的提示。状态行同时给出 `Enter adopt` 的按键提示。
- `/new`、`/resume`、`/fork`、`/project` 之后，旧会话的建议**不再留在输入框**里，也不会被发到新会话。

不在本次范围：建议的生成方式（仍是 worker turn 后单独一次模型调用）、suggestion speculation、Desktop / Web 的呈现形态（Desktop 已按 Enter 采纳，且 `useTurnSuggestion` 已在 sessionId 变化时清空）。

关联：上游计划 [下一步建议下沉到 worker/Host](2026-10-25-next-step-suggestion-host.md)（PR #496 已合并）——该计划的验收写的是「空输入按 Enter 采纳填入」，Desktop 按此实现，TUI 当时只落在 Esc 上。

## 验收

- `npx vitest run packages/cli/src/tui/__tests__/tui-turn-suggestion.test.ts packages/cli/src/__tests__/chat-tui-turn-suggestion.test.ts`：新增用例通过。
- `npx vitest run packages/cli/src/tui packages/cli/src/__tests__`：相关套件无回归（先记录基线失败再比较）。
- `npm run typecheck:all` 与 `npm run architecture:check` 退出码 0。
- 真机：TUI 跑一轮对话，turn 结束后输入框出现灰字建议，按 Enter 建议变成实字填进输入框，再按 Enter 才发送；`/new` 之后输入框不再残留旧建议。

## 进度

- [x] S0 定位：TUI 建议链路 `chat.ts`（`turnSuggestion` / `refreshTurnSuggestion`）→ `TUIApp`（placeholder 渲染 + `onEnter` / Esc 采纳）
- [x] S1 修采纳：空输入按 Enter 采纳建议填入输入框（`TUIApp.onEnter` + `adoptTurnSuggestion`），状态行给按键提示
- [x] S2 修残留：会话边界清空建议（`chat.ts` `clearTurnSuggestion`，`/new` `/resume` `/fork` `/project`）
- [x] S3 回归用例：TUI 层（按键采纳）+ chat 层（会话边界清空）
- [x] S4 门禁与提交：反向验证（修复前会红）、`packages/cli/src` 全量、typecheck:all、architecture:check 全过；两个 fix commit 已落地
- [ ] S5 开 PR + 真机冒烟

## 发现与决策

- **TUI 只把采纳绑在 Esc 上，Enter 什么都不做**：`TUIApp.onEnter` 在空输入时 `submitIfPresent()` 返回 null 就直接返回；建议只是 placeholder（`composer-layout.ts`），用户看到灰字按 Enter 没有任何反应。上游计划的验收写的是 Enter，Desktop（`MessageInput.tsx`）也按 Enter 采纳——三端不一致，本次把 TUI 对齐到 Enter。Esc 的采纳路径保留（它同时承担「召回排队草稿」，是另一条语义）。
- **采纳必须落成实字**：placeholder 不可点、不可编辑，采纳后文本进 `editor`，用户可改可撤可再按 Enter 发送；这正是「能真实填入能让我发送出去」的意思。发送仍要第二次 Enter，不自动发送。
- **Tab 保持原义**：空输入时 Tab 是「切到任务视图」，非空时是缩进 / 排队；抢走 Tab 会破坏既有键位（`tui-busy-draft-keys.test.ts` 已断言），因此采纳键选 Enter，与计划文档、Desktop 一致。
- **会话边界必须连读一起停**：`refreshTurnSuggestion` 是 15 秒短轮询，只清 `turnSuggestion` 不 bump 序号的话，旧会话的读会在切换后落回来，把清掉的建议又放回去。故 `clearTurnSuggestion` 同时 `turnSuggestionSeq += 1`。
- **Desktop 无需同改**：`useTurnSuggestion` 在 `sessionId` 变化时清空建议，且 `MessageInput` 的草稿按 sessionId 存 IPC 草稿、切换会话各取各的。TUI 没有按会话存草稿的机制，切换会话时输入框由 `/new` 的 `clearTranscript` 清空。

## 验证记录

环境：Windows 11 / Node 24.16.0 · 检出根：`E:/Projects/duya/.claude/worktrees/tui-turn-suggestion-fix` · base `220a63ff`

| SHA / dirty 范围 | 环境 | 命令或操作 | 退出码 / 结果 | 证据 |
| --- | --- | --- | --- | --- |
| `220a63ff`（clean） | 同上 | `node scripts/junction-worktree.mjs .` | 0：建 60 条依赖链接（`@duya/*` 指向本检出自己的包） | — |
| 同上 | 同上 | `npm run build:packages` | 0：built 22 package(s)（worktree 首次需先建产物） | — |
| `220a63ff` + 改动 | 同上 | `npx vitest run packages/cli/src/tui/__tests__/tui-turn-suggestion.test.ts packages/cli/src/__tests__/chat-tui-turn-suggestion.test.ts` | 0：2 files / 8 tests passed | — |
| `220a63ff` + 改动（**源码临时还原到 master**） | 同上 | 同上 | **1（预期红）**：4 failed / 4 passed——Enter 不采纳、二次 Enter 不发送、状态行无 `Enter adopt`、`/new` 后建议仍在（`expected 'now run the failing test' to be null`）。用例确实能抓这两个 bug | — |
| `220a63ff` + 改动（还原后恢复） | 同上 | 同上 | 0：8 passed | — |
| `9fd12f60` + `a5a100b2` | 同上 | `npx vitest run packages/cli/src` | 0：119 files / 1389 tests passed，无回归 | — |
| 同上 | 同上 | `npm run typecheck:all` | 0：typecheck-electron-gate 无新增类型错误；末位 `eval:agent:core:check` 4 pass | — |
| 同上 | 同上 | `npm run architecture:check` | 0：无新增边界违规（2985 条均为既有 baseline） | — |
| `356d0370`（合并后的 master tree） | 同上 | `git diff --stat 474f513a 356d0370` | 0：两棵树 blob 哈希同为 `8aef3ec2`，合并结果与上面验证过的 tree 逐字节相同 | — |
| 同上 | 同上 | `npx vitest run packages/cli/src` | 0：119 files / 1389 tests passed（合并后重验） | — |
| 同上 | 同上 | `npm run typecheck:all` | 0 | — |
| 同上 | 同上 | `npm run architecture:check` | 0：无新增边界违规 | — |

已知副作用：`npm run build:packages` 触碰了 `packages/capabilities/src/ModuleTool/inline-content.ts` 的 mtime，git 报 `M`，但 `git diff --exit-code` 为 0、blob 哈希与 HEAD 相同（LF/CRLF 检出噪声），未纳入任何提交。

## 接续 / 结果

- 已实现：S0–S4 完成（实现 + 门禁 + 提交 + 集成）。
- 已验证：新增用例 8 条全过且**反向验证确认修复前会红**；`packages/cli/src` 全量 1389 条无回归；typecheck:all 与 architecture:check 退出码 0；合并后重验同样全过，且合并 tree 与被验证 tree 逐字节相同（`8aef3ec2`）。
- 未验证：真机（TUI 实跑一轮对话看灰字建议 → Enter 采纳 → `/new` 后不残留）未跑，需用户确认。
- PR：[#532 fix(cli): make the TUI turn suggestion adoptable and session-scoped](https://github.com/lava-chen/duya/pull/532) —— **已合并**（用户授权，2026-10-28），merge commit `356d0370`，CI 5 job 全绿。
- 阻塞：无。
- 下一步：真机冒烟由用户补（TUI 实跑一轮对话看灰字建议 → Enter 采纳 → `/new` 后不残留）。功能本身已集成 master，无待办。

回收：worktree `tui-turn-suggestion-fix` 的成果已由 `356d0370` 到达 master；分支保留（`origin/worktree-tui-turn-suggestion-fix`），worktree 待 owner 会话退出后回收。


