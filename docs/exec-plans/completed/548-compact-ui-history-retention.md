# Plan 548: Compact UI — 历史消息保留渲染

> **状态：** Planning（user 拍板：默认反转 compact UI 隐藏历史的行为）。

**Goal:** 让 chat UI 在一次会话经过 `compaction_summary` 之后，仍**正常按时间顺序渲染**被 summary 替代掉的那段历史（user / assistant / tool），仅在切点处插入 `<CompactSummary>` 卡片作为视觉断点。**LLM context 投影完全不变**（仍只看 `[summary, ...保留尾部]`），本次改动是纯 UI 层偏好反转。

**User 偏好（2026-09-18 拍板）：** 默认反转，**不加** user-facing 开关。

## 现状（事实链）

- `SessionMemoryCompactStrategy.compact()` ([SessionMemoryCompactStrategy.ts:673-677](packages/agent/src/compact/strategies/SessionMemoryCompactStrategy.ts:673)) 把 `olderMessages` 内容**从 `messages` 数组里彻底丢**，只保留 `[summaryMessage, ...recentMessages]`；`compactedMessageIds` 只剩 id 字符串。
- `message-compaction-controller.ts:262` 又 `slice(markerIndex + 1)` 一次，只让 marker 后的部分进 LLM。
- 持久化层不是物理删 row，而是发 `rebase` event（`supersededUpToSeq = null` = "supersede ALL prior"，[rollout-events.ts:87-95](electron/db/core/rollout-events.ts:87)）。
- `MessageLog.project()` 返回**完整 raw trace（包括 rebase + 已 superseded 的 row）** ([message-log.ts:830-841](electron/db/core/message-log.ts:830))。
- `MessageLog.listBySession()` 是 `project()` 后接 `applyRebases()` → 折叠 superseded ([message-log.ts:781](electron/db/core/message-log.ts:770))。
- 前端 chat UI 经 `getThreadIPC` → `db:message:listBySession` IPC → `listBySession` → 拿到**已折叠**的消息列表 → 渲染时间线时已看不到被压缩的历史。
- `isCompactSummary` / `isCompactBoundary` / `compactedMessageCount` 三个 marker 已穿过 IPC adapter，commit 60d34ec8 / dfe1c500 已固化 round-trip（[MessageItem.tsx:916-937](src/components/chat/MessageItem.tsx:916)）。

**关键洞察：** LLM 和 UI 走的是不同 projection。LLM 已对（summary 替代），UI 当前反过来折叠了不该折叠的历史。**改动只需要让 UI 端走 raw projection** —— 不要改 strategy，不要改 message-compaction-controller，不要改 DB。

## Architecture

最小、纯加法改动：

1. **`MessageLog.listBySession` 加 `includeSuperseded: boolean` 选项**
   - `true`（默认）→ 当前行为（applyRebases + 折叠）
   - `false` → 跳过 `applyRebases`，返回原始 row（**包括**被压缩标记为 superseded 的消息）
2. **`db:message:listBySession` IPC handler 加 `includeSuperseded` 参数**，调底层透传。
3. **前端 `getThreadIPC` 默认传 `includeSuperseded: true`**（让 UI 看到完整历史）。
4. **不动** `MessageItem.tsx:916-937` 的 CompactSummary 渲染分支 — 现有 marker 已经会渲染成卡片。
5. **不动** LLM projection / 任何 strategy / 持久化层。

## Files

- **Modify**: [electron/db/core/message-log.ts:452](electron/db/core/message-log.ts:452) — `listBySession` 加 `includeSuperseded?: boolean` 选项（`true` 默认保 backward compat）
- **Modify**: [electron/ipc/db-handlers.ts:580](electron/ipc/db-handlers.ts:577) — `db:message:listBySession` IPC handler 接收 `includeSuperseded`，透传给 `listBySession`
- **Modify**: [electron/ipc/core-db-adapters.ts](electron/ipc/core-db-adapters.ts) — `storedEventsToIpcMessages` 验证 rebase event 走 CompactSummary 路径（commit 60d34ec8 已覆盖）
- **Modify**: [src/lib/ipc-client.ts:485](src/lib/ipc-client.ts:485) — `getThreadIPC` 默认 `includeSuperseded: true`
- **Verify**: [src/components/chat/MessageList.tsx](src/components/chat/MessageList.tsx) — 确认 `buildGroupedMessages` 不再把 rebase event 当 round boundary 闭合 assistant round（commit 60d34ec8 已修）

## Tests

- 新增：vitest 单测覆盖 `MessageLog.listBySession({ includeSuperseded: true })` 返回**包括**被 compaction rebase 折叠的原始 row
- 验证：现有 `apply-rebases.test.ts` 不破（默认 false 路径不变）
- e2e：手动起一个长会话，跑过 `/compact` 后 reload，确认 UI 显示完整历史 + 一个 CompactSummary 卡片

## Risk

- **超长会话 UI 渲染 / 内存**：DB row 物理保留（rebase event-sourced），UI 一次性拉到全部消息，N 万行时 roll out 退化。Mitigation：virtualization 已经存在；后续可加 limit，但本期不做。
- **rebase 折叠 + thread (plan 486)**：threading 的 branched 消息也用 rebase 语义。`includeSuperseded: true` 会同时把 branched 历史拉回来。本期只关心 compact，**branched 行为**必须另行验证 — 必要时让 includeSuperseded 只解 compact rebase，不解 branch rebase。
- **bot session (plan 493)**：`projectMultiFile` 路径覆盖 archive segment + active.jsonl。本期确认 includeSuperseded 对多文件 path 同样生效。

## 提交策略

worktree → multi-commit → PR。

## Tasks

- [ ] **Task 1:** worktree 建在 `.claude/worktrees/548-compact-ui-history`
- [ ] **Task 2:** `MessageLog.listBySession` 加 `includeSuperseded?: boolean`，写单测
- [ ] **Task 3:** `db:message:listBySession` IPC handler + adapter 透传
- [ ] **Task 4:** `getThreadIPC` 默认传 true
- [ ] **Task 5:** 跑 `npm run typecheck:all` + 现有 vitest 全绿
- [ ] **Task 6:** 手动 e2e 验证 `/compact` 后 UI 完整渲染
- [ ] **Task 7:** commit / push / PR / merge