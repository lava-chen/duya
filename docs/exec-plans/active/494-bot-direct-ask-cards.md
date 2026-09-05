# 494 — Bot-direct 问问题卡片（AskUserQuestion 接入聊天流 + 卡族视觉对齐 rakazo）

> **Status**: Implementation · **Priority**: P0 · **Owner**: bot-direct UI
> **立项（2026-09-05）**: 参考 `E:/cloned-projects/rakazo` 的交互卡族（AskCard / ChoiceCard），把 bot-direct 聊天里 agent 调用 `AskUserQuestion` 工具的提问渲染成**消息流内的问问题卡片**。

## 0. 现状与问题

- `AskUserQuestion` 工具（`packages/agent/src/tool/AskUserQuestionTool/`）Phase 1 抛 `PermissionRequiredError` → SSE `permission_request` 事件进入 stream-session-manager（`handlePermissionEvent`，`pendingPermissionRequest` 存储 + listener 通知）。
- workspace 模式：`ChatView` 订阅 `subscribeToPermissions` 并在 `isAskUserQuestionPending` 时用 `PermissionPrompt.tsx` 的 `AskUserQuestionUI`（底部悬浮 sheet，Codex 风格）渲染。
- **bot-direct 模式的缺口**：`App.tsx` 的 `renderView()` 把 `BotDirectChatView` 挂成 `ChatView` 的**兄弟节点**（483 P2.1 分支隔离），`ChatView` 不挂载 → 没有任何组件订阅 `subscribeToPermissions` → bot 调 `AskUserQuestion` 时**提问事件无人渲染，流卡在 `awaiting_permission` 直到超时**。`startStream` 是共用的（bot-direct 发送走 `App.handleBotDirectSend` → `startStream`），所以事件已经到了 stream-session-manager，只缺订阅 + 渲染 + 应答。
- 通用工具权限请求（generic permission）在 bot-direct 同样无人渲染，存在同样的卡流问题。

## 1. 方案

bot-direct 会话内自行接 `usePermissions`（与 ChatView 同一 hook、同一应答通道），把提问渲染为聊天流内卡片（rakazo 视觉），替代 workspace 的底部 sheet：

1. **BotAskCard**（新组件，`src/components/chat/bot/BotAskCard.tsx`）
   - 1-4 个问题纵向堆叠（不用 sheet 的 pager —— 聊天卡片一次看全）。
   - 每题：`header` 标签 pill + 问题文本 + 选项行（A/B/C 字母徽章，rakazo ChoiceCard 风格）+ `(Recommended)` 自动预选 + description 展开（info 按钮）+ 多选 checkbox / 单选 radio + 自由反馈行（`User feedback: …` 约定与 AskUserQuestionUI 一致）。
   - 全部题目可提交后 footer 启用：取消（`_dismissed: true`）/ 提交。
   - 应答契约与 workspace sheet 完全一致：`respondToPermission('allow', { questions, answers })` → `permission:resolve` → agent 侧 `storePendingAnswer` → Phase 2。**agent 包零改动**。
   - 无全局键盘劫持（ESC/Enter 留给 composer，卡片用按钮）。
2. **BotPermissionCard**（新组件）：generic 工具权限的紧凑卡（tool 名 + Deny / Allow once / Allow for session），避免 bot 会话因权限事件无人应答而卡死。
3. **BotDirectChatView 集成**：
   - `usePermissions({ sessionId, permissionProfile: 'auto' })` + `subscribeToPermissions(sessionId, handlePermissionRequest)`。
   - pending ask → 聊天流末尾渲染 BotAskCard（assistant 侧）；pending generic → BotPermissionCard。
   - 已回答的提问卡以静态 answered 态保留在会话内（内存态，session 切换即清）——回答后提问不至于凭空消失（tool_use 行被 source 过滤，转录里本来无痕）。持久化列为后续项（需 SendMessage/消息侧表支撑）。
4. **视觉**：`bot.css` 新增 `.bot-ask-card` / `.bot-permission-card` 块，rakazo 语言（20px 圆角卡、字母徽章、pill 标签、语义色、answered 态）。workspace 的 `PermissionPrompt` / `AskUserQuestionUI` 不动。

## 2. 任务

- [x] T1 plan 文件 + README 注册
- [x] T2 `BotAskCard.tsx` + `BotPermissionCard.tsx`
- [x] T3 `BotDirectChatView.tsx` 接线（订阅 + 渲染 + answered 保留）
- [x] T4 `bot.css` 卡片样式（rakazo 对齐）
- [x] T5 单测：`BotAskCard.test.tsx`（选择/多选/反馈/提交/取消）+ `BotDirectChatView.test.tsx`（mock usePermissions 注入 pendingPermission → 卡片渲染 + 提交走 respondToPermission）；另修复共享 test harness 的 icons mock 缺口（panels/registry 4 图标）与 usePanel stub（另一 session 在途改动引入）
- [x] T6 `npm run typecheck:all` + vitest 通过（2026-09-05，含恢复验证后复跑 exit=0 / 22 passed）
- [ ] T7 Electron 真机冒烟：跑一轮 bot AskUserQuestion，确认卡片渲染、应答后 agent 继续、answered 态保留（better-sqlite3 ABI 被 Electron 进程锁定，待 Electron 空闲时执行）

## 3. 非目标

- 不改 agent 包（AskUserQuestionTool / permission 管线零改动）。
- 不动 workspace 的 `PermissionPrompt` sheet。
- answered 卡片不持久化（内存态）；后续随 489 P2.5 卡宿主闭环一并考虑。
- widget / secret-request / cursor-agent 卡的完整交互闭环仍在 489 P2.5 范围。

## 4. 决策日志

### 2026-09-05 — 立项

- bot-direct 权限事件缺口是 483 P2.1 分支隔离的已知副作用，489 P2.5 只规划了"提问卡未答补问"，没有覆盖"提问本身无人渲染"。本 plan 补上渲染 + 应答这半环。
- 视觉参考 rakazo（`AskCard.tsx` / `message-cards.tsx`）：字母徽章选项、header pill、answered 固化态。答题逻辑复用 AskUserQuestionUI 的成熟约定（` || ` 多选连接、`User feedback: ` 前缀、`_dismissed`），保证 agent 侧解析兼容。
