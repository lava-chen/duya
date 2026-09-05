# 413e — plan-task session 化前端

> 父 plan：[413-mode-state-machine-framework](./413-mode-state-machine-framework.md)（总览）
> 状态：Planning
> 优先级：P1
> 依赖：[413b-plan-tracker-state-machine](./413b-plan-tracker-state-machine.md)（agent 侧 plan-task 已改 `kind:'session'`）

---

## 1. 范围

让 `plan-task` mode 在前端成为 **session 级持久化 toggle**（对齐 conductor），跨消息保持、
重启后恢复。没有它，agent 侧 413b 的跨 turn tracker 无法从 UI 触发（前端每次发送后
`clearMessageModes` 清掉 plan-task）。

**决策（§4.8）**：复用 `sessions.extensions` JSON 列的 key `plan_mode_enabled`（对齐
conductor 的 `conductor_mode_enabled`/`conductor_canvas_id`），**不加新表/列**。

**本子 plan 不含**：agent 侧任何改动（413b 已完成 `kind:'session'`）；`mode_state_snapshots`
表（413c，那是状态机快照，与本 toggle 标志互补）。

---

## 2. 设计（严格复刻 conductor 路径）

### 2.1 数据流总览

```
MessageInput 切换 plan-task
  → onPlanModeChange(enabled)  → ChatView.handlePlanModeChange
    → conversation-store.setThreadPlanMode(threadId, enabled)   // 内存 + syncThreadToDatabase
      → preload.session.setPlanMode(sessionId, enabled)         // ipcRenderer.invoke
        → db-handlers 'db:session:set_plan_mode' → setExtension(sessionId, 'plan_mode_enabled', ...)
          → core-db sessions.extensions JSON 列
  发送时：plan-task 仍在 activeModes → pickMessageMode 选中 → options.mode='plan-task' → agent 413b tracker
加载时：session:get → coreSessionToIpcRow 映射 plan_mode_enabled → conversation-store → ChatView state → MessageInput.activeModes
```

### 2.2 逐文件修改

| # | 文件 | 修改 |
|---|---|---|
| 3a | `electron/ipc/core-db-adapters.ts:116` | `SESSION_EXTENSION_KEYS` 加 `'plan_mode_enabled'` |
| 3b | `electron/ipc/db-handlers.ts` | 新增 `db:session:set_plan_mode` handler：`setExtension(sessionId, 'plan_mode_enabled', enabled ? '1' : '0')`（对齐 `set_conductor_mode` :1176-1184）；并在 `coreSessionToIpcRow` 映射 `plan_mode_enabled` 回顶层字段（对齐 `conductor_mode_enabled`） |
| 3c | `electron/preload.ts` | `session` API 加 `setPlanMode(sessionId, enabled): Promise<void>` → `ipcRenderer.invoke('db:session:set_plan_mode', { sessionId, enabled })`（对齐 :1469） |
| 3d | `src/stores/conversation-store.ts` | thread 加 `planModeEnabled?: number` 字段 + `setThreadPlanMode(threadId, enabled)`（对齐 `setThreadConductorBinding` :729；写字段 + `syncThreadToDatabase`） |
| 3e | `src/components/chat/ChatView.tsx` | `planModeEnabled` state + `handlePlanModeChange(enabled)`（对齐 conductor :798-880）；session 加载时从 `data.thread.planModeEnabled` 恢复（对齐 :561-578），恢复后经 props 传给 MessageInput 填回 `activeModes` |
| 3f | `src/components/chat/MessageInput.tsx` | ① `handleToggleMode` 中 plan-task 分支走 `onPlanModeChange(willEnable)`（对齐 conductor :393-397），不再只依赖 `clearMessageModes` 清空；② `pickMessageMode`（:153-158）更新：能选中 session 型的 plan-task（排除 conductor，conductor 走独立标志） |
| 3g | `src/types/mode-id.ts:25` | `MODE_KIND['plan-task']`：'message' → 'session' |

### 2.3 关键行为细节

- **发送时仍带 mode**：`handleSubmit`（:1334-1338）里 `pickMessageMode(activeModes)` 选出的
  `sendMode` 传给 `options.mode`，agent 据此激活 planTracker。plan-task 变 session 后，
  `pickMessageMode` 需排除 conductor（它走 `conductorMode` 标志），其余 message/session 型
  mode 照常选中。research 保持 message 型不变。
- **clearMessageModes**（:165-173）：改为只清 research（message 型），**不清 plan-task**（session 型）。
- **agentPlanMode**（`ChatView.tsx:248`，SSE `mode_changed` 驱动）与 `planModeEnabled`（DB 持久）：
  两者并存——前者反映 agent 运行时当前 mode（如 SwitchModeTool 切到 plan），后者反映用户
  UI toggle 的持久状态。渲染时 `planModeActive = activeModes.has('plan-task') || agentPlanMode`
  （现 :351 逻辑保留）。
- **互斥规则不变**：`MODE_EXCLUSIVE_WITH` 不动；plan-task 变 session 后 toggle 仍会剥掉
  research/conductor（对齐 grok 的 plan 互斥）。

---

## 3. 任务清单

- [ ] 3a `electron/ipc/core-db-adapters.ts`：`SESSION_EXTENSION_KEYS` 加 `plan_mode_enabled`。
- [ ] 3b `electron/ipc/db-handlers.ts`：新增 `db:session:set_plan_mode` + `coreSessionToIpcRow` 映射。
- [ ] 3c `electron/preload.ts`：暴露 `session.setPlanMode`。
- [ ] 3d `src/stores/conversation-store.ts`：thread `planModeEnabled` 字段 + `setThreadPlanMode`。
- [ ] 3e `src/components/chat/ChatView.tsx`：`planModeEnabled` state + 加载恢复 + `handlePlanModeChange`。
- [ ] 3f `src/components/chat/MessageInput.tsx`：plan-task 持久 toggle + `pickMessageMode`/`clearMessageModes` 更新。
- [ ] 3g `src/types/mode-id.ts`：`MODE_KIND['plan-task']` = 'session'。
- [ ] 新增/更新前端单测：`pickMessageMode`、`clearMessageModes`、`handleToggleMode` plan-task 分支（若已存在 MessageInput 测试）。
- [ ] **验证**：`npm run typecheck:all` + `npm run test` + Playwright MCP。

> commit 建议：`feat(ui): persist plan-task mode as session-level toggle (plan 413e)`

---

## 4. 验证

- `npm run typecheck:all` — 通过。
- `npm run test` — 相关单测（mode-id / conversation-store / 若 MessageInput 有测试）。
- **Playwright MCP**（`npm run dev` 起 Vite）：
  1. 开 plan-task → 发消息 → **toggle 保持**（不回弹）→ 再发一条仍带 plan mode。
  2. 切 research（message 型）→ 发送后 research 清、plan-task 若在则留。
  3. 重启 Electron（或重新加载 session）→ plan-task 状态从 DB 恢复。
- 配合 agent 侧 e2e：计划文本在第二、三轮出现 sparse reminder 形态。

---

## 5. 风险

| 风险 | 缓解 |
|---|---|
| `plan_mode_enabled` 与 agent `mode_state_snapshots` 状态不同步 | 两者分工：前者=用户 UI toggle 意图（sessions.extensions），后者=状态机运行时快照（413c 表）；agent 以 `options.mode` 为准触发 tracker，UI 标志只是持久化 toggle |
| `pickMessageMode` 改动影响 research | research 保持 message 型，逻辑分支按 `MODE_KIND` 区分，不动 research 行为 |
| extensions key 白名单漏加 | 3a 必须与 3b 同步（否则 `setExtension` 被白名单拦截）；单测覆盖 `set_plan_mode` 往返 |
| conductor/plan 互斥在 session 化后行为变化 | `MODE_EXCLUSIVE_WITH` 不动；toggle 剥离逻辑由 `toggleModeInSet`（现 :64）保证 |

---

## 6. 参考

- `electron/ipc/core-db-adapters.ts:116-123` — `SESSION_EXTENSION_KEYS`
- `electron/ipc/db-handlers.ts:1176-1184` — `set_conductor_mode`（对齐对象）
- `electron/preload.ts:1469-1470` — `setConductorMode`
- `src/stores/conversation-store.ts:729-743` — `setThreadConductorBinding`
- `src/components/chat/ChatView.tsx:561-578,798-880` — conductor 加载恢复 + handleConductorChange
- `src/components/chat/MessageInput.tsx:153-173,333,380-400,1334-1338` — pickMessageMode / clearMessageModes / activeModes / handleToggleMode / handleSubmit
- `src/types/mode-id.ts:25-29` — `MODE_KIND`
