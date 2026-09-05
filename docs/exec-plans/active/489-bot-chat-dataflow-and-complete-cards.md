# 489 — Bot 聊天界面数据流硬保证 + 全部卡片与交互落地

> **Status**: Implementation · **Priority**: P0 → P1 · **Owner**: TBD
> **当前进度（2026-09-05）**:P0.1 / P0.3（数据层 source 投影 + bot-direct 订阅切换）+ P2.2 **最小版**（SendMessage 5 kind 可读卡片）✅ 已落地并提交（`d6df19c1`）;P0.2 侧表 / 完整交互卡族 / room 卡 / P2.5 / P2.6 / P3 待做。
> **立项动机（2026-09-03）**:483 P2.1 的 Telegram 式 1:1 聊天壳已落（`BotDirectChatView.tsx`），但 **"bot 只能通过 SendMessage 看到" 这一核心约束** 现在只在 **UI 层 + 工具白名单 + system prompt 描述** 三处浅层防御,数据层并没有真正隔离 ——
> bot 的 tool_use / thinking / 普通 assistant text **依旧以 `role: assistant` 落进 messages 表**,DB 层完全无法区分 "这是 SendMessage 产物" 与 "这是 bot 思考过程"。
>
> 同时 483 计划里 **Phase 0（roster 增量订阅）+ Phase 2 后续（P2.2 卡族 / P2.3 折叠 / P2.4 typing / P2.5 闭环 / P2.6 生命周期）+ Phase 3（资料卡 / 设置）** 全部还没做。本 plan 把"先保证 SendMessage-only 可行 + 把 483 后续全部 Phase 一次性写清楚 + 给出落地顺序"。
>
> **总纲**: [473-grok-bot-framework-overview](./473-grok-bot-framework-overview.md)
> **前置 / 平行**: 476（Wake Bus）+ 477（per-bot 常驻会话）+ 478（群聊）+ 481（工具集统一建档）+ 484（ack 与续跑）+ 486（消息 thread 分支）+ 488（Channel 接入）
> **承接**: [483-multi-bot-chat-ui](./483-multi-bot-chat-ui.md) Phase 0/2/3 未落地部分
> **参考源码**: `E:/cloned-projects/grok-bot-0.18-reconstructed/frontend/src/recovered/features/conversation/workspace/transcript.tsx` + `chat-header.tsx` + `composer.tsx` + `cards/transcript-card/*`（卡族）+ `reaction-actions.ts`（reactToMessage）+ `widget-responses.ts`（host 闭环）+ `workflow-commands.ts`（@mention 展开）+ `roster-emit.ts`/`roster-projection.ts`/`replica-writer.ts`（roster 增量）

---

## 0. 现状盘点（写 plan 当天的真实状态）

| 层 | 落点 | 当前状态 | 缺口 |
|---|---|---|---|
| **工具白名单** | `packages/agent/src/agent-profile/bot-toolset.ts:26` `BOT_TOOLSET = ['send_to_agent', 'update_state', 'SendMessage']` | ✅ bot 不持有 raw "text 气泡" 工具 | — |
| **SendMessageTool 注册** | `packages/agent/src/tool/builtin.ts:313` `registry.register(sendMessageTool.toTool(), …, { exposeMode: 'discoverable' })` | ✅ 已注册 | — |
| **SendMessageTool description** | `SendMessageTool.ts:81` `SEND_MESSAGE_DESCRIPTION` 明确 "your plain assistant text is invisible" | ✅ 提示词层防御 | — |
| **SendMessageTool.execute 实现** | `SendMessageTool.ts:230` 之后 | ⚠️ **只实现了 `type:text` 的 content 路径**。schema 里的 `type:attachment / widget / cursor-agent / secret-request` 全部在 `validateInput` 通过后直接落到 `messageDb.append(sessionId, [message], null)`,但 `message` 对象只构造了 `content`(input.content),其他类型所需字段(url / widget / bcId / secret)被**直接丢弃** | **真 bug**:这 4 种 type 现在发不出来 |
| **messages 表 schema** | `electron/db/schema.ts:84` 列:id, session_id, role, content, display_content, name, tool_call_id, token_usage, msg_type, thinking, tool_name, tool_input, parent_tool_call_id, viz_spec, status, seq_index, duration_ms, sub_agent_id, created_at | ❌ **无 `source` 列**,无法区分 "SendMessage 产物" vs "bot 自己思考过程" | **数据层无防御**:tool_use / thinking 落 messages 表后,任何 DB 读侧都能看到 |
| **写入路径** | `messageDb.append` (IPC `message:append`) → `electron/agents/db-bridge.ts:433` → `MessageLog.appendBatch(events)` | ❌ 同上,bot 自己的 tool / thinking 通过 `ipcMessageToNewEvent` 落 messages,无 source 标记 | 同上 |
| **SSE 广播** | `db-bridge.ts:456` `getSessionManager().broadcastSessionEvent('message:new', …)` | ⚠️ 推到 renderer 的事件**没区分来源** | renderer 收到的是 mixed stream |
| **BotDirectChatView 渲染** | `src/components/chat/BotDirectChatView.tsx:67` `isBubbleMessage()` 严格过滤 `role in {user, assistant} AND (msgType == null OR msgType === 'text')` | ✅ UI 层假装过滤;tool/thinking 压成单行 chip | 仅 UI,数据层没挡住 |
| **BotContactListItem 实时性** | 静态读 `[agents.*]` config + `subscribeToPhase` 拿运行状态 | ⚠️ 头像/名字/在线状态是**配置时快照**,bot 改名后不会自动更新 | 483 P0.1-P0.3 未做 |
| **卡族** | 现有 `MessageItem` 分派按 role+msgType,支持文本/工具行/附件卡/viz widget/研究卡/`MailboxBubble` | ❌ 483 列的 4 个 bot 专用卡 `BotDirectCard / RoomRoundMark / RoomPassNote / BotBroadcastCard` 仓库里**0 行代码** | 483 P2.2 未做 |
| **@mention / reactToMessage / secret / permission 卡闭环** | — | ❌ 0 | 483 P2.5 未做 |
| **bot lifecycle 切换 / successor / kickstart** | — | ❌ 0 | 483 P2.6 未做 |
| **Bot 资料卡 / Bots 设置 / 群组管理** | — | ❌ 0 | 483 P3.1 / P3.2 未做 |

**结论**:SendMessage-only 现在是 **"三层浅防 + 数据层裸奔"**。要"先保证可行",Phase 0 必须把数据层硬保证做掉,然后再谈后面的卡族/闭环/生命周期。

---

## 1. 用户设计意图与目标

```
侧栏 Bots 分组（已落 483 P1）
└── 点开联系人
    ▼
BotDirectChatView（已落 483 P2.1） = 一个 Telegram 式聊天
├── 用户看到的消息：user 自己发的 + bot 经 SendMessage 发出的
├── 用户看不到的：bot 的 tool_use / thinking / 普通 assistant text
│                 （这些留在 bot 自己的工作台 session,资料卡可跳转）
├── 多种卡片：BotDirectCard / RoomRoundMark / RoomPassNote / BotBroadcastCard
│             + 复用的图片/附件卡 / viz widget 卡
├── 可点击卡片 → 看到 bot 间通讯细节（@mention / reply thread / 群回合跳转）
├── reactToMessage（点 emoji）→ bot 感知一次 hidden run
├── @agentHandle 展开 → 定向唤醒目标 bot
└── typing/busy 状态条（来自 StreamPhase 订阅）
                  + roster 实时增量（改名/头像/忙闲）
```

---

## 2. 总体设计

### 2.1 核心原则

1. **数据层硬保证** > UI 层防御:`messages.source` 列是真理之源,UI 只是它的镜像。
2. **不破坏 1:1 ↔ workspace 共享 messages 表的事实**:两模式共用同一张表,但**渲染过滤** vs **写入过滤**分离 ——
   - **写入时**:bot 会话里 tool_use / thinking 通过 `source='tool_use'|'thinking'|'system'` 入库,但**默认不入 bot-direct 视图的 projection**(由 projection 视图过滤);
   - **workspace 视图**(同 bot 工作台 session):可见全部;
   - **bot-direct 视图**:只显示 `source in {'send_message', 'user'}`,tool/thinking 不显示。
3. **复用为主,新建为辅**:多卡片种类复用现有 `MessageItem` 分派管线 + 437 hook row 通道,不另起 UI 引擎。
4. **Phase 顺序锁**:Phase 0 必须先完成(数据层 + SendMessageTool 完整实现),否则后续卡族都没有"明确知道是哪类消息"的基础。

### 2.2 写入路径改造(scope = agent 全局,workspace 与 bot-direct 共用)

```
agent runtime
  ├─ user message              → source='user'
  ├─ SendMessage tool_result   → source='send_message'  (P0 改造)
  ├─ tool_use   (Read/Bash…)   → source='tool_use'      (P0 改造)
  ├─ thinking   (LLM 思考)     → source='thinking'      (P0 改造)
  ├─ system / hook_invocation  → source='system'        (P0 改造)
  └─ 普通 assistant text       → source='scratchpad'    (P0 改造,bot-direct 不显示)
```

### 2.3 bot-direct 视图订阅

```
BotDirectChatView
  ├─ 主订阅：MessageLog.project(sessionId, filter={source: ['send_message','user']})
  └─ 旁路：useStreamPhase() 拿 typing/busy（不订阅内容,只看 stream 生命周期）
```

`MessageLog.project` 已是 326/441 的稳定接口(见 `electron/db/core/message-log.ts:1131` `MessageLog.timeline` / `MessageLog.project`),只需在 schema 加列 + ipcMessageToNewEvent 透传 source + projection 加 filter 三处。

---

## 3. 文件清单（新建 + 改动）

### 3.1 新建

| 文件 | 用途 | Phase |
|---|---|---|
| `electron/db/migrations/0049_add_message_source.sql` | `ALTER TABLE messages ADD COLUMN source TEXT NOT NULL DEFAULT 'scratchpad'; CREATE INDEX idx_messages_session_source ON messages(session_id, source)` | P0.1 |
| `packages/agent/src/tool/SendMessageTool/types.ts` | `SendMessageRecord` 联合类型(text / attachment / widget / cursor-agent / secret-request),含序列化到 messages.content 的策略 | P0.2 |
| `packages/agent/src/tool/SendMessageTool/__tests__/SendMessageTool-full.test.ts` | 覆盖 5 种 type 各自的执行 / 序列化 / 边界 case | P0.2 |
| `electron/agents/roster-emit.ts` | roster 增量事件协议(`agents.upserted/removed/activity/profile_changed` + ordered seq)+ 单测 | P1.1 |
| `electron/agents/roster-projection.ts` | main 侧 roster 投影(live + 持久化 marker + SSE 广播)对齐 grok `async-task-union.ts` + `replica-writer.ts` | P1.2 |
| `electron/agents/__tests__/roster-emit.test.ts` + `roster-projection.test.ts` | 协议/订阅/重连补洞 | P1.1-P1.3 |
| `src/components/layout/sidebar/use-bot-roster.ts` | 前端订阅 hook,`BotContactListItem` 消费 | P1.3 |
| `src/components/chat/cards/bot-direct/BotDirectCard.tsx` | agent DM 信封渲染([agent] cue / priority / time) | P2.2 |
| `src/components/chat/cards/bot-direct/RoomRoundMark.tsx` | 群回合分隔条(Round N / 发言人轮转摘要) | P2.2 |
| `src/components/chat/cards/bot-direct/RoomPassNote.tsx` | 群静默成员灰化小字 | P2.2 |
| `src/components/chat/cards/bot-direct/BotBroadcastCard.tsx` | broadcast 消息(476 预留通道) | P2.2 |
| `src/components/chat/cards/bot-direct/MessageItem-bot-direct.tsx` | bot-direct 分派表(挂到现有 MessageItem 分派链) | P2.2 |
| `src/components/chat/cards/bot-direct/StatusChip.tsx` | tool/thinking 折叠胶囊(P2.3 入口) | P2.3 |
| `src/components/chat/cards/bot-direct/ProcessViewer.tsx` | "查看过程"展开:折叠的 tool_use / thinking 流 | P2.3 |
| `src/components/chat/bot/typing-indicator.tsx` | 三点 typing 胶囊 + 多个 bot 时显示"成员 X 发言中"(room 场景) | P2.4 |
| `src/components/chat/bot/host-responses/` | 提问卡未答补问 / secret 回写 / 权限卡过期 / reactToMessage 入口 | P2.5 |
| `electron/agents/bot-host/collect-unanswered-questions.ts` | 下次 wake 时收集未答提问卡的回传 | P2.5 |
| `electron/agents/bot-host/secret-store-router.ts` | secret 提交路由到 connector credential store | P2.5 |
| `electron/agents/bot-host/permission-expiry-sweep.ts` | pending approval 超时清场 + 状态回写(对齐 419 userMessageEpoch) | P2.5 |
| `electron/agents/bot-host/expand-mentions.ts` | `@agentHandle` 展开 + 定向唤醒(对齐 478 P1.3 衔接) | P2.5 |
| `electron/agents/bot-host/react-to-message.ts` | emoji → 隐藏 run 让 agent 感知 | P2.5 |
| `src/components/chat/cards/bot-direct/ReactionBar.tsx` | 点 emoji 入口(reactToMessage) | P2.5 |
| `src/components/chat/cards/bot-direct/MentionExpander.tsx` | @mention chip 解析与可视化 | P2.5 |
| `electron/agents/bot-lifecycle.ts` | successor 选择 / kickstart / clone / rename / avatar 变更落地 | P2.6 |
| `electron/agents/bot-lifecycle-prompt.ts` | kickstart hidden run 的 `SAND_ONBOARDING_KICKSTART_PROMPT` 汉化移植 + 三分支 | P2.6 |
| `src/components/layout/bot/BotProfileCard.tsx` | 五 tab 子页壳 | P3.1 |
| `src/components/layout/bot/BotProfileOverview.tsx` + `ActivityTab.tsx` + `MemoryTab.tsx` + `AutomationTab.tsx` + `BindingsTab.tsx` | 五 tab 内容 | P3.1 |
| `src/components/layout/settings/BotsManagement.tsx` | Bots 管理 tab(bot 化开关 / 外观 / 唤醒偏好) | P3.2 |
| `src/components/layout/settings/GroupsManagement.tsx` | 群组管理 tab(建群 / 成员 / 删除) | P3.2 |

### 3.2 改动

| 文件 | 改动 |
|---|---|
| `electron/db/schema.ts` | `messages` 表加 `source` 列 + 索引(迁移 0049);`chat_sessions` 加 `introduction_pending INTEGER NOT NULL DEFAULT 1`(P2.6 kickstart 用) |
| `electron/agents/db-bridge.ts` | `message:append` 路径把 `source` 透传到 `ipcMessageToNewEvent`(P0.1) |
| `electron/ipc/core-db-adapters.ts` | `ipcMessageToNewEvent` 接收 `data.source` 并写入 `MessageLog`(P0.1) |
| `electron/db/core/message-log.ts` | `MessageLog.project(sessionId, filter)` 支持 source filter(P0.1) |
| `packages/agent/src/tool/builtin.ts` | 注释里写明 SendMessage 是 bot 唯一发声通道 |
| `packages/agent/src/ipc/db-client.ts` | `messageDb.append` / `messageDb.add` 透传 `source` 字段 |
| `packages/agent/src/permissions/permissions.ts` | permission 表里 SendMessage 不再加额外 gate(已是白名单,确认无副作用) |
| `packages/agent/src/tool/SendMessageTool/SendMessageTool.ts` | 重构:5 种 type 分支各自构造 `source='send_message'` 的消息,触发关联 hook(attachment → 建 message_attachments;widget → 落 widget_response_pending;secret → 走 secret-store-router;cursor-agent → 落 cursor_cloud_agent_run 关联) |
| `src/components/chat/BotDirectChatView.tsx` | 订阅源从 `messages: Message[]` 改为 `useBotDirectTranscript(sessionId)` hook(只取 source in {send_message,user});新增 typing/busy header 接线 + 反应条入口 |
| `src/components/chat/ChatView.tsx` | BotDirectChatView 早期 return 处不变;新增 `'message:new'` SSE 监听 source filter 后只更新对应 store |
| `src/components/layout/sidebar/BotContactListItem.tsx` | 接入 `use-bot-roster` 订阅;支持未读角标 / 改名即时反映 / 在线忙闲点 |
| `src/components/layout/sidebar/app-sidebar.tsx` | sidebarStructure Bots section 已常显(483 决策日志二轮已落),保持 |
| `src/stores/conversation-store.ts` | 新增 `botDirectTranscript` 状态(按 sessionId 索引 source 过滤后的消息) |
| `src/types/message.ts` | `MsgType` 不变;`Message` 加可选 `source?: 'user' \| 'send_message' \| 'tool_use' \| 'thinking' \| 'scratchpad' \| 'system'`(renderer-only metadata,DB schema 单独列) |
| `src/lib/ipc-bindings.ts`(或对应通道) | 加 `agent:roster:subscribe` IPC 类型 |
| `electron/preload.ts` + `electron/ipc/*-handlers.ts` | 暴露 roster 订阅 + bot-direct transcript 投影 |
| `src/components/chat/MessageList.tsx` | 在分派表加 `source === 'tool_use' \| 'thinking' \| 'system' \| 'scratchpad'` → 默认折叠(StatusChip);仅在 bot-direct 视图(由 chatMode 判断)折叠;workspace 视图保持原行为 |
| `packages/agent/src/prompts/bot/index.ts` | bot system prompt 里"你是如何对用户说话的"段落加 source 字段说明(对齐 483 P2.1 决策:在 description 已写,这里再强化) |
| `electron/agents/automation.ts`(或 cron 旁) | cron / automation 触发的 bot run,**禁止**通过 source='scratchpad' 的普通 assistant text 与用户对话(强化:每条 run 必须至少一次 SendMessage 才算 deliver) |
| `docs/exec-plans/README.md` | 加入 489 active 项;补充交叉引用 |

---

## 4. 分阶段实施

> **Phase 顺序锁**:
> - P0.1 → P0.2 → P0.3 是数据层三步,P0.1 是 schema 改造 + IPC 透传,P0.2 是 SendMessageTool 完整实现,P0.3 是投影 filter + BotDirectChatView 订阅切换。
> - **不写 P0 任何子项就开始 P1/P2** = 重新做一遍。
> - P1 (roster 增量) 与 P2.2-P2.6 (卡族 + 闭环) **可平行**(不同文件集)。
> - P3.x (资料卡 + 设置) 全部依赖 P2 落地后才会有真数据可显示。

### Phase 0 — SendMessage-only 数据流硬保证（本 plan P0,先做这个）

> **目标**:任何读侧(UI / DB query / backup / inspector / backup-restore / tests)都拿不到 bot-direct 视图不该看的内容。数据层是真理之源。

- [x] **P0.1** messages 表加 `source` 列 + 索引 + IPC 透传（**实现偏离**：走 rollout entry 级 source，非 `ALTER TABLE`——见 §8 决策日志 2026-09-05）
  - 迁移:`electron/db/migrations/0049_add_message_source.sql`
    ```sql
    ALTER TABLE messages ADD COLUMN source TEXT NOT NULL DEFAULT 'scratchpad';
    CREATE INDEX idx_messages_session_source ON messages(session_id, source, created_at);
    -- chat_sessions 加 introduction_pending(P2.6 kickstart 用,提前合一个迁移文件 0049)
    ALTER TABLE chat_sessions ADD COLUMN introduction_pending INTEGER NOT NULL DEFAULT 1;
    ```
  - `electron/db/schema.ts`:CREATE TABLE messages 加 `source TEXT NOT NULL DEFAULT 'scratchpad'`;CREATE TABLE chat_sessions 加 `introduction_pending INTEGER NOT NULL DEFAULT 1`
  - `electron/ipc/core-db-adapters.ts:ipcMessageToNewEvent` 接收 `data.source`(默认 `'scratchpad'`),写入 `MessageEntry.message.metadata.source` 或 `MessageLog` 直接落列(看 MessageLog 的 NewEvent 是否已有对应字段 — `electron/db/core/message-log.ts` 核)
  - `electron/agents/db-bridge.ts:message:append` 把 source 从 `p.messages[i].source` 取出传入 `ipcMessageToNewEvent`
  - `packages/agent/src/ipc/db-client.ts:messageDb.add` / `messageDb.append` 类型签名加 `source?: MessageSource`
  - **赋值点扫描**(必须改,否则全是 `'scratchpad'`):
    - `packages/agent/src/tool/SendMessageTool/SendMessageTool.ts:execute()` → `'send_message'`
    - `packages/agent/src/agent-message/ingest.ts`(或其他 ingestMessage 调用点) → user message → `'user'`;tool_use → `'tool_use'`;tool_result → `'tool_use'`(或独立 `'tool_result'`,先复用 `'tool_use'` 等 441 reviewer 决定);thinking → `'thinking'`;系统提示 / hook → `'system'`
    - `packages/agent/src/permissions/permission-requests.ts` → `'system'`
    - `packages/agent/src/tool/TaskTool/index.ts` → `'system'`(task notification)
  - 单测:`electron/db/__tests__/messages-source.test.ts`(migration 跑通老 DB + 索引命中 + 默认值 + ALTER TABLE on existing DB)

- [ ] **P0.2** SendMessageTool 完整实现（5 种 type）
  - 重构 `SendMessageTool.execute` 为 type-dispatch:
    ```ts
    switch (type) {
      case 'text':           // 现状,保留
      case 'attachment':     // 新:建 message_attachments 行,message.content 存 {kind:'attachment', url, alt}
      case 'widget':         // 新:落 widget_response_pending 表(question id),content 存 {kind:'widget', prompt, options}
      case 'cursor-agent':   // 新:建 cursor_cloud_agent_run 关联,content 存 {kind:'cursor-agent', bcId, status:'pending'}
      case 'secret-request': // 新:走 secret-store-router(落 host-pending-secret 表),content 存 {kind:'secret-request', label, connector, field}
    }
    ```
  - 全部以 `source='send_message'` 入库
  - 配套:`attachments`(P0.2-attachment)、`widget_response_pending`(P0.2-widget)、`cursor_cloud_agent_run`(P0.2-cursor)、`host_pending_secret`(P0.2-secret)四张表;新建 0050 迁移一次性建
  - 单测:`SendMessageTool-full.test.ts` 覆盖 5 种 type 的 validate/execute/round-trip;`secret-store-router.test.ts` / `cursor-cloud-agent.test.ts`(借用 plan 482 已有的 stub)
  - 验证:Bot 调 SendMessage(type=widget) 在 messages 表 source='send_message' 且 content JSON 含 `{kind:'widget', prompt, options}`;UI 渲染提问卡;用户回答走 host-responses 链路(P2.5)

- [x] **P0.3** bot-direct 视图订阅切换 + projection filter（**实现偏离**：IPC 名为 `db:message:botDirectGetTranscript`；`MessageLog.project/listBySession` 通过 rollout entry 级 `applySourceFilter` 过滤，均见 §8 决策日志 2026-09-05）
  - `electron/db/core/message-log.ts:MessageLog.project(sessionId, opts?: {source?: MessageSource[]})` 加 filter 参数;`timeline()` 不变(供 audit / workspace 用)
  - `electron/ipc/db-handlers.ts:427`:新增 IPC `db:message:botDirectGetTranscript` {sessionId},内部 `source ∈ {send_message, user}`,renderer 端走独立通道
  - `src/components/chat/BotDirectChatView.tsx`:
    - 移除直接订阅 `messages: Message[]`
    - 引入 `useBotDirectTranscript(sessionId)` hook → 首屏拉取 + `message:new` 双侧 source 过滤(jsdom/web 无 IPC 时回退 props 保证测试可用)
    - `mergeInFlightOptimisticMessages`(conversation-store 纯函数)合并 worker 回合末乐观 user 气泡,避免发送瞬间气泡消失
    - 只显示 `source ∈ {send_message, user}`,tool/thinking 在数据层即被过滤,UI 不再"假装过滤"
  - **断言层**(强制):✅ `src/components/chat/BotDirectChatView.test.tsx` 加 wired 路径测试:注入 tool_use → 断言 UI **不显示**;注入 send_message → 断言显示
  - **DB 断言层**:✅ `electron/db/core/__tests__/message-log-source-filter.test.ts` 验证 project/listBySession 严格过滤 tool_use/thinking
  - **hook 过滤层**:✅ `src/components/chat/bot/__tests__/use-bot-direct-transcript.test.ts` 首屏 fetch 二次过滤初始化结果
  - **G0** `npx tsc --noEmit` 绿 + 相关单测全绿

### Phase 1 — Roster 增量订阅协议（483 P0 立项）

> **目标**:联系人列表真的会"呼吸" —— bot 改名/头像变更/忙闲切换 ≤1s 反映,重连后按序号补洞。

- [ ] **P1.1** roster 增量事件协议(`agents.upserted/removed/activity/profile_changed` + ordered seq)
  - 文件:`electron/agents/roster-emit.ts`
  - 类型:
    ```ts
    export type RosterEvent =
      | { seq: number; ts: number; type: 'agents.upserted'; agent: RosterEntry }
      | { seq: number; ts: number; type: 'agents.removed'; agentId: string }
      | { seq: number; ts: number; type: 'agents.activity'; agentId: string; activity: 'typing' | 'composing' | 'idle' }
      | { seq: number; ts: number; type: 'agents.profile_changed'; agentId: string; profile: Partial<RosterProfile> };
    ```
  - 单调序号:进程级 `seq` 计数器,持久化到 `roster_event_seq` 表(单行),重启后从 last seq + 1 起
  - 单测:`roster-emit.test.ts` — 序号单调 / 持久化 / 重启续号 / 顺序保证
- [ ] **P1.2** main 侧 roster 投影(live + 持久化 marker)
  - 文件:`electron/agents/roster-projection.ts`
  - 数据源合并:`[agents.*]` config + `agents/<id>/profile.json`(plan 485 身份层) + 来自 476 wake bus 的 activity 事件
  - SSE 广播通道:`agents:roster:event`
  - 订阅者:每个 renderer window 一个 session,按 seq 记录 last seen,断线重连时 IPC `agents:roster:subscribe {sinceSeq}` 拉缺失事件
  - 单测:`roster-projection.test.ts` — 合并优先级(profile wins per 485 §2.4)/ 序号对齐 / activity 事件来源接入
- [ ] **P1.3** 前端订阅 hook + BotContactListItem 接入
  - 文件:`src/components/layout/sidebar/use-bot-roster.ts`
  - 暴露:`{ contacts, lastSeq, subscribe, status }`
  - `BotContactListItem`:消费 events,改名/头像/忙闲即时反映;未读角标接 plan 202 mailbox 计数;reaction 触发的 hidden run 显示"thinking"点
  - 单测:`use-bot-roster.test.tsx` — mock SSE 推 events / 断线补洞 / unmount 清理
- [ ] **G1** typecheck + 单测 + Playwright 手动冒烟(改 `[agents.*].description`,刷新前 1s 内反映)

### Phase 2 — 聊天视图与卡片（483 P2 后续）

> **目标**:BotDirectChatView 不再只是壳,而是 Telegram 式完整聊天 —— 多卡片、折叠过程、typing、卡闭环、bot 生命周期。

- [x] **P2.1** chatMode 分支 + 角色气泡渲染容器（483 已落）
- [x] **P2.2** 卡片族:BotDirectCard / RoomRoundMark / RoomPassNote / BotBroadcastCard（**仅最小版落**：`src/components/chat/BotSendCard.tsx` 分派 5 种 kind 为可读卡片;4 张命名 bot 卡 + `MessageItem-bot-direct.tsx` 依赖 478,作为后续项。数据契约见 §8 决策日志 2026-09-05）
  - `src/components/chat/BotSendCard.tsx`:在 `BotDirectChatView` 行渲染按 `msgType` 分派——text → `BotBubbleRow`,其余(`attachment` / `widget` / `cursor-agent` / `secret-request`) → `BotSendCard`,均走 `Message.sendMessageMeta` / `metadata.sendMessage`
    ```ts
    message.msgType === 'text' ? <BotBubbleRow/> : <BotSendCard message={message} onOptionClick={...}/>
    ```
  - 5 种 kind 各自渲染:text + images 图条 / attachment 芯片 / widget 选项按钮(点击 = 复用 onSend 以 user 消息回传)/ cursor-agent 徽章(截断 bcId)/ secret-request 静态描述
  - 复用底座:`metadata.sendMessage` 命名空间载荷由写侧白名单放行、读侧投影为 `send_message_meta` 列,再透传 `sendMessageMeta`,不经渲染层猜结构
  - 单测:✅ `src/components/chat/__tests__/BotSendCard.test.tsx`(5 项)+ `electron/ipc/__tests__/send-message-meta-roundtrip.test.ts`(3 项,纯函数不碰 better-sqlite3)全绿
  - **后续项(依赖 478)**:`MessageItem-bot-direct.tsx` 分派表 + `BotDirectCard`(agent DM 信封)/ `RoomRoundMark`(群回合分隔)/ `RoomPassNote`(静默成员)/ `BotBroadcastCard`(broadcast)——— 见 §T5
- [ ] **P2.3** bot-direct 的工具/思考折叠（"查看过程"展开）
  - 注意:**在 P0.3 之后,bot-direct 视图底层就不会有 tool_use / thinking 消息进入 subscription**,所以严格说"折叠"是 workspace 视图的事
  - 此项的实际含义是:BotDirectChatView 顶部加 "查看此 bot 在 workspace 的最近运行" 跳转（用资料卡的 Activity tab 作锚点,见 P3.1）
  - workspace 视图（原 ChatView 默认）的折叠行为保持 437 现状不动
- [ ] **P2.4** typing/busy 状态条
  - `useStreamPhase(sessionId)` 已存在,BotDirectChatView header 已在用（483 P2.1 已落）
  - 扩展:room 场景（478 落地后）在 header 显示"成员 X 发言中";多人并行显示多行
  - 单测:typing 显隐切换 / session 切换正确 reset
- [ ] **P2.5** 卡宿主侧处理闭环（483 P2.5 全量落地）
  - 提问卡未答补问:`electron/agents/bot-host/collect-unanswered-questions.ts`,agent 下次 wake 时 prepend 一段 `<unanswered_questions>` cue
  - secret 回写:`electron/agents/bot-host/secret-store-router.ts`,用户提交 → 写 connector credential store → 删除 host-pending-secret → 触发对应 bot resume run 一次
  - 权限卡过期:`electron/agents/bot-host/permission-expiry-sweep.ts`,pending approval 超时清场 + 状态回写 + 与 419 userMessageEpoch 衔接（新回合即旧审批作废）
  - reactToMessage:`electron/agents/bot-host/react-to-message.ts`,emoji → IPC 走 476 wake bus 派发 hidden run（source: 'react',不显式入 transcript）
  - @mention 展开:`electron/agents/bot-host/expand-mentions.ts`,host 侧消息解析把 `@agentHandle` 展开成提及上下文,定向唤醒目标 agent（478 P1.3 的 mention 在此获得 host 侧实现）
  - 前端 `ReactionBar.tsx` + `MentionExpander.tsx` 接线
  - 单测:`widget-responses.test.ts` / `secret-store-router.test.ts` / `permission-expiry-sweep.test.ts` / `expand-mentions.test.ts` / `react-to-message.test.ts`
- [ ] **P2.6** bot 生命周期切换（483 P2.6 全量落地）
  - 文件:`electron/agents/bot-lifecycle.ts` + `bot-lifecycle-prompt.ts`
  - 删除当前 bot → successor 选择（对齐 grok deleteAgents successor 语义）:UI 落到剩余 bot 或 Projects
  - kickstart onboarding（对齐 SAND_ONBOARDING_KICKSTART_PROMPT 三分支 + introduction_pending 门禁）:
    - 创建时 `introduction_pending=1`
    - hidden run（走 476 wake bus,source='kickstart',lane='user' 但 invisible）
    - 判定:首条 SendMessage 抵达即 set `introduction_pending=0`
    - 作废:用户首条消息即作废（对齐 send-pipeline.ts:228）
    - 三分支:有 concrete assignment → 跳过寒暄直接开工;无任务 → 探询;需 connector → 就地发 connector 卡
  - avatar 变更即时反映（P1.3 profile_changed 消费）
  - clone bot（连同 automations / avatar）列为 P3 后置
  - 单测:`bot-lifecycle.test.ts` 覆盖三分支 + 作废条件;`bot-lifecycle-prompt.test.ts` 静态 prompt 模板

### Phase 3 — 资料卡与设置（483 P3）

- [ ] **P3.1** Bot 资料卡五 tab 子页
  - `BotProfileCard.tsx`（壳）+ 五 tab:`Overview / Activity / Memory / Automation / Bindings`
  - 复用 PageFrame + PageHeader + PageNavButtons（483 决策）
  - 活动 tab 依赖 476 P4.2 wake 生命周期日志 IPC;记忆 tab 依赖 479 读侧;绑定 tab 依赖 477 映射;**未就绪先占位**
- [ ] **P3.2** 设置 tab:Bots 管理 + 群组管理
  - `BotsManagement.tsx`:bot 化开关（绑定常驻会话 / 允许被唤醒 / 允许 DM / 群邀请 / SendMessage 唯一通道声明）/ 外观（头像 / 名字色 / 介绍,落 `[agents.<id>]` 与 `profile.json`）/ 唤醒偏好（wake.idleDispatch / 静音时段 / quiet 默认）
  - `GroupsManagement.tsx`:建群（选成员 ≤6、max_rounds、预算）/ 成员管理 / 删除群;落 `~/.duya/groups.toml`（478 写侧）
- [ ] **G1** `npm run typecheck:all` + 前端单测;Playwright 手动验收（按 AGENTS.md UI 门禁）

---

## 5. 验收标准（分阶段）

### Phase 0 验收（本 plan 第一道门）

- [ ] messages 表 `source` 列存在且非空（迁移 0049 跑通老 DB）
- [ ] `SendMessageTool(type='widget')` 真实入库一条 `source='send_message'` + `content.kind='widget'` 的消息
- [ ] DB 直查:bot-direct 会话的 `messages` 表里同时存在 `source='tool_use'` 和 `source='send_message'` 两种行
- [ ] `MessageLog.project({source:['send_message','user']})` 严格只返回这两种 source
- [ ] BotDirectChatView 渲染时 mock agent 注入 `source='tool_use'` → 断言 UI 不显示;注入 `source='send_message'` → 显示
- [ ] `npm run typecheck:all` 绿;`packages/agent` 单测全过;新增 `SendMessageTool-full.test.ts` 覆盖 5 种 type
- [ ] 端到端:e2e Playwright 一个 chat turn 里 bot 发 `SendMessage(type=widget)` → 渲染提问卡 → 用户点击 option → bot 收到回复（resume run）

### Phase 1 验收

- [ ] roster 实时性:bot 改名 / 头像变更 / 忙闲切换 ≤1s 反映到联系人列表
- [ ] 重连补洞:renderer disconnect 期间产生的 events,reconnect 时按 seq 顺序补齐（测试:模拟 seq 5-10 丢失,断言 reconnect 后顺序补齐）
- [ ] 序号单调性:进程重启后 seq 从持久化的 last_seq + 1 起

### Phase 2 验收

- [ ] bot-direct:user 发消息 → bot 常驻会话 wake → bot 回复以气泡出现在聊天里;bot 的工具/思考默认不可见（P0 数据层硬保证已落,UI 不再需要装作过滤）
- [ ] room:3 人讨论按回合渲染（RoundMark/PassNote/@mention）,实时更新（依赖 478）
- [ ] 卡闭环（P2.5）:提问卡未答在下次 wake 补问;secret 提交到达 connector credential store;reactToMessage 触发 agent 感知 run;@mention 定向唤醒目标 agent
- [ ] 删除当前 bot 后 UI 落到 successor（P2.6）;新建 bot 出现 onboarding 引导

### Phase 3 验收

- [ ] Bot 资料卡、Bots/群组设置可用;唤醒偏好开关生效（双路互斥开关 476 P0-C 联动）
- [ ] Playwright 全部 UI 走通:typecheck + 端到端冒烟 + 截图回归

---

## 6. 非目标

- 不做 bot 的头像生成器 / 富 Profile 编辑器（占位即可,后置）。
- 不做消息搜索 / 归档 UI（bot 历史搜索可复用全局 search plan 243 后续）。
- 不动现有 ChatView 在 workspace 模式下的任何行为（模式分支隔离）。
- SendMessageTool 的 type 扩展到 5 种全覆盖是 P0.2 的硬要求;但这 5 类型的**视觉卡**在 P2.2 才落地,P0.2 只保证数据落库正确,UI 临时复用现有 text bubble 渲染文本。
- 群聊细节（RoomRoundMark / RoomPassNote 完整语义）依赖 478 落地;在 478 落地前,BotDirectChatView 默认走 1:1 路径,room 占位不显示。
- P2.6 clone bot 不在本 plan（P3 后置）。
- P3 资料卡的 Activity / Memory tab 数据源若 476/479 未落地,以"加载中"占位,不影响整体上线。

---

## 7. 风险

- **数据迁移风险**:老 DB 跑 0049 迁移时 `ALTER TABLE messages ADD COLUMN source` 默认值 `'scratchpad'` — 老数据全是 LLM 自己的 tool_use / thinking / 普通 text,会被标为 `'scratchpad'`,**对老会话来说全部"不可见"**(bot-direct 视图只显示 send_message/user)。这是**已知破坏性**:从迁移生效那一刻起,所有历史 bot-direct 视图都看不到老内容(只剩新产生的 SendMessage)。需要在迁移前发个 1.0 → 1.1 changelog + 在 BotDirectChatView 加"历史记录正在迁移"提示,3 个版本后移除。
- **写入路径扫描不全**:`source` 字段是新增的,任何不显式赋值的写入点都会变成 `'scratchpad'`,导致 bot 真实产物不可见。P0.1 必须做完整的 ingest 端到端扫描,加 e2e 测试覆盖每条 agent run。
- **P0.3 切换订阅源后,BotDirectChatView 与现有 store 的同步**:`conversation-store.botDirectTranscript` 需要与现有 `messages` store 解耦;两个 store 都监听同源 SSE 但 filter 不同,需要小心避免重复渲染。
- **roster seq 持久化**:replica-writer 风格的 seq 持久化若做不严密,renderer 重连后会"跳号"或"丢事件",联系人列表回到静态。P1.1-P1.2 必须做严格测试。
- **Phase 0 工期风险**:P0 三步涉及 schema 迁移 + 写入路径改造 + 视图订阅切换,加 5 种 type 完整实现,约 **7-10 个工作日**。若并行 session 涉及 agent typecheck 报错（如 plan 475 在途改动）,工期可能 +3 天。
- **chatMode 分支污染**:P2.2 卡族接入 MessageItem 分派时,极易把 workspace 模式行为带进 bot-direct。分派条件必须以 `chatMode === 'bot-direct'` 为前提,验收含 workspace 模式回归。
- **P2.5 闭环依赖深**:reactToMessage / @mention 唤醒都依赖 476 wake bus 派发 hidden run;若 476 未稳定落地,P2.5 必须做降级(只入 audit log,不真触发 run)。

---

## 8. 决策日志

### 2026-09-03 — 489 立项:SendMessage-only 数据层硬保证 + 483 后续一次性写清

**背景**:483 P2.1 Telegram 式聊天壳已落,但用户正确指出"bot 只能通过 SendMessage 看到"这条核心约束现在**只在 UI 层 + 工具白名单 + system prompt description 三处浅层防御**,数据层并没有真正隔离 —— `messages` 表无 `source` 列,bot 的 tool_use / thinking / 普通 assistant text 都以 `role: assistant` 入库。同时 483 Phase 0 + Phase 2 后续 + Phase 3 全未做。

**关键发现**(代码审计,2026-09-03):
1. `SendMessageTool.execute()` **只实现了 type:text**。schema 里 `attachment / widget / cursor-agent / secret-request` 4 种 type 在 validateInput 通过后直接落 type:text 路径,具体字段(url / widget / bcId / secret)**被硬编码丢了** —— 这是 SendMessage 工具当前的**真 bug**,任何 widget / attachment / secret 请求现在发不出来。
2. messages 表 schema (`electron/db/schema.ts:84`) **没有 `source` 列**,只有 role + msg_type —— DB 层完全无法区分"这是 SendMessage 产物"与"这是 bot 思考过程"。任何 DB query / backup / inspector 都能看到 bot 的 tool_use 完整内容。
3. BotDirectChatView 现在的 `isBubbleMessage()` 严格过滤 (`role in {user,assistant} AND msgType=='text'`),看似只在 UI 层防御 —— 但**因为 tool_use 的 msgType 是 `'tool_use'` 不是 `'text'`**,UI 过滤其实是有效的;**真正的问题是 DB 层落库时不分流**,一旦谁绕过 UI 直读 DB 就裸奔。
4. SendMessageTool 的 `BOT_TOOLSET` 白名单 (`packages/agent/src/agent-profile/bot-toolset.ts:26`) 已经正确,bot 没有 raw text bubble 工具 —— 这层防御是对的。
5. SendMessage description 写得很明确 ("your plain assistant text is invisible to them") —— 提示词层防御也对。

**决策**:
1. **Phase 0 优先于一切**:数据层硬保证必须在 P0 三步内完成,不写 P0 就开 P1/P2 等于重复做工。
2. **不破坏 workspace ↔ bot-direct 共享 messages 表的事实**:两模式共用同一张表,通过 `source` 列区分 + projection filter 渲染过滤。这是 grok-bot 的实际做法(同一 transcript,但发送方通过 SendMessage 才被用户看到),不是新建分离表。
3. **P0.2 把 SendMessageTool 5 种 type 全部实现**:这是修复当前的真 bug,不是新功能 —— 489 立项时这个 bug 必须修。
4. **483 全部 Phase 0/2/3 一次性纳入 489**:489 是 483 的执行细分 plan,不再让 483 计划里的未落地 checkbox 散落。
5. **chatMode 分支隔离硬约束**:BotDirectChatView 的逻辑全部收敛在自己文件内,不允许散落到 MessageList / MessageItem;P2.2 卡族接入通过新的 `MessageItem-bot-direct.tsx` 包装器,而非改 MessageItem 主体(对齐 483 §6 约束)。
6. **P0 老数据迁移策略**:迁移 0049 默认值 `'scratchpad'` 对老数据意味着"bot-direct 视图看不到老内容"。这是已知破坏性,必须配 changelog + 3 版本过渡提示。
7. **Phase 顺序锁**:P0 → P1 ∥ (P2.2-P2.6) → P3。P1 与 P2 可平行(P1 是 contacts roster,P2 是 transcript 卡族,文件集不重叠)。

**验证**:已审计 6 个关键文件(`bot-toolset.ts`、`SendMessageTool.ts`、`builtin.ts`、`schema.ts`、`db-bridge.ts`、`BotDirectChatView.tsx`),现有事实依据充分。Phase 0 实施时仍需补一次全 agent runtime 写入点扫描(在 P0.1 任务内)。

### 2026-09-05 — P0.1/P0.3 实现偏离 + P2.2 卡片数据契约（交接会话回写）

**背景**:依 489-bot-direct-handoff-2026-09-05 的 T7,把 2026-09-05 会话落地的 P0.1 / P0.3 / P2.2 最小版回写进 checkbox 与决策日志。

**P0.1 实现偏离（选择不补 messages `source` 列）**:
- 计划原文写的是 `ALTER TABLE messages ADD COLUMN source` + 0050/0049 迁移。实际实现改为 **rollout entry 级 source**:
  - `packages/agent/src/message/message-source.ts`:`MessageSource` 类型 + `BOT_DIRECT_VISIBLE_SOURCES = ['send_message','user']`;
  - `MessageLog.project/listBySession` 走 entry.source + metadata 镜像 + `applySourceFilter`,是权威读路径;
  - `electron/ipc/core-db-adapters.ts` source 透传 + `db-handlers` `db:message:botDirectGetTranscript` IPC。
- 理由:source 信息天然随 rollout entry 落盘且已被持久化链路覆盖,无需在 `messages` 关系表上再加冗余列 + 迁移;`message_attachments` 等侧表本就走外键,source 属于日志语义而非行语义。**接手者不要强行补列**,以 `MessageLog.project/listBySession` 的 source filter 为权威。

**P0.3 实现偏离（IPC 命名 + 过滤位置）**:
- IPC 名为 `db:message:botDirectGetTranscript`(`electron/ipc/db-handlers.ts:427`),不是计划里的 `message:getBotDirectTranscript`;source allowlist 在主进程只返回 `{send_message, user}`。
- 前端 `useBotDirectTranscript`(src/components/chat/bot/use-bot-direct-transcript.ts)在首屏 fetch **二次过滤**初始化结果(纵深防御):即便服务端误返非可见 source 也丢弃。
- live `BotDirectChatView.tsx` 已切到 hook(wired 路径),`mergeInFlightOptimisticMessages` 合并 worker 回合末乐观 user 气泡;无 IPC(jsdom/web)时回退 props 保测试可用。

**P2.2 卡片数据契约（不要在渲染层猜 payload 结构）**:
- SendMessageTool 的 5 种 kind 载荷统一收进 `metadata.sendMessage`(`SendMessageTool.ts:321-445`),写侧白名单放行(`core-db-adapters.ts:368` 新增 `'sendMessage'` key),读侧投影成 `send_message_meta` JSON 列(`core-db-adapters.ts:98` MessageRow + `:644`),wire 层解析为 `sendMessageMeta`(`src/lib/ipc-client.ts`),三处映射(`conversation-store.ts:464` / `src/App.tsx:286` / `use-bot-direct-transcript.ts:73`)透传。
- 渲染:`src/components/chat/BotSendCard.tsx` 按 `msgType` 分派 attachment/widget/cursor-agent/secret-request,text + images 走图条。
- 单测:✅ `BotSendCard.test.tsx`(5)+ `electron/ipc/__tests__/send-message-meta-roundtrip.test.ts`(3)全绿。
- 新增类型:`src/types/message.ts`(新建 `SendMessageCardMeta`,MsgType 扩 4 kind)。
- 顺手修:`packages/conductor/.../CanvasThumbnail.tsx` 的 `vbW/vbH` const→let(TS2588,只有根 tsc 报)。

**提交**:`3effce42`、`5e5175e5`、`d6df19c1`(master 干净)。未做(T2 起):Electron 真机 Playwright 冒烟、P0.2 四张侧表、完整交互卡族、群聊/Room 卡、P2.5/P2.6/P3。

---

## 9. 工作量估算（粗）

| Phase | 子项数 | 估时(人日) | 备注 |
|---|---|---|---|
| P0.2 SendMessageTool 5 type | 1 重构 + 4 张新表 + 5 type 单测 | 3-4 | widget / secret 涉及 host 链路 |
| P0.3 投影 filter + 订阅切换 | 1 IPC + 1 hook + 视图改造 + 集成测试 | 2-3 | 涉及 chatMode store 解耦 |
| P1.1-P1.3 roster | 3 文件 + 单测 + Playwright | 3-4 | replica-writer 风格的 seq 持久化要稳 |
| P2.2 卡族 | 5 文件 + 分派表 + 单测 | 2-3 | 复用为主,新建为辅 |
| P2.3-P2.4 折叠 + typing | 2 增强 + 单测 | 1 | P0 后折叠其实主要是 workspace 视图 |
| P2.5 host 闭环 | 5 文件 + 单测 + e2e | 5-6 | 依赖 476/419/478,若平行的 plan 拖期会顺延 |
| P2.6 lifecycle | 3 文件 + 单测 | 3-4 | kickstart 三分支 + introduction_pending 门禁 |
| P3.1 资料卡 | 6 文件 | 3-4 | 数据源若 476/479 未就绪,以占位符先上 |
| P3.2 设置 | 2 文件 | 2-3 | 群组管理依赖 478 |
| **总计** | | **27-34 人日** | 约 5-7 周（1 人） / 3-4 周（2 人） |

**里程碑**:
- M1（Phase 0 全部完成） ≈ **8-11 人日** → "bot 只能通过 SendMessage 看到" 数据层硬保证 + 5 type 完整实现 ✅
- M2（Phase 1 + Phase 2 P2.2 卡族） ≈ **13-18 人日** → 联系人会呼吸 + 多种卡片
- M3（Phase 2 P2.3-P2.6 + Phase 3） ≈ **19-29 人日** → 完整 Telegram 式 + 资料卡 + 设置

---

## 10. 交叉引用

- **总纲**:[473-grok-bot-framework-overview](./473-grok-bot-framework-overview.md)
- **承接**:[483-multi-bot-chat-ui](./483-multi-bot-chat-ui.md) Phase 0/2/3
- **平行的 bot 系列**:
  - [476-agent-wake-bus](./476-agent-wake-bus.md)(P2.5 派发 hidden run 依赖)
  - [477-agent-dm-messaging](./477-agent-dm-messaging.md)(P3.1 Bindings tab 数据源)
  - [478-shared-rooms-group-chat](./478-shared-rooms-group-chat.md)(RoomRoundMark / RoomPassNote / @mention 数据源)
  - [479-bot-memory-isolation-tiers](./479-bot-memory-isolation-tiers.md)(P3.1 Memory tab 数据源)
  - [481-bot-toolset-unified-foundation](./481-bot-toolset-unified-foundation.md)(SendMessage 已在白名单)
  - [484-bot-reliability-ack-and-resume](./484-bot-reliability-ack-and-resume.md)(SendMessage ack 与续跑判定)
  - [485-bot-storage-layout](./485-bot-storage-layout.md)(profile.json 身份层 + P3.2 外观写)
  - [486-message-threads](./486-message-threads.md)(P2.2 reply_to 字段已支持)
  - [487-host-persistent-tool-permission](./487-host-persistent-tool-permission.md)(P2.5 secret 卡 + permission 卡复用)
  - [488-bot-channel-integration](./488-bot-channel-integration.md)(P2.5 outbound channel 走 channelDb.deliver 已就)
- **平行的非 bot 系列**:
  - [419-permission-decision-bus](./419-permission-decision-bus.md)(P2.5 permission 卡过期 + userMessageEpoch 衔接)
  - [437-hook-row-in-message-flow](./437-hook-row-in-message-flow.md)(P2.2 复用 hook row 通道)
  - [441-event-granularity-journal](./441-event-granularity-journal.md)(journal 与 message 边界)
  - [326-core-db-rollout-foundation](./326-core-db-rollout-foundation.md) / [328-core-db-electron-wiring](./328-core-db-electron-wiring.md)(MessageLog.project 接口稳定)
  - [314-tool-catalog-snapshot](./314-tool-catalog-snapshot.md)(SendMessage tool_schema 文档化)
  - [202-agent-mailbox](./202-agent-mailbox.md)(P1.3 未读角标数据源)
  - [309-button-unification](./309-button-unification.md)(P3.2 设置页 Button 统一)
  - [308-turn-review-history](./308-turn-review-history.md)(BotProfileCard Activity tab 可借用 turn review DTO)
  - [471-sidebar-section-refactor](./471-sidebar-section-refactor.md)(Bots section 复用机制)
  - [2026-08-14-custom-agent-creation](../superpowers/plans/2026-08-14-custom-agent-creation.md)(P2.6 创建时挂 `isKickstartRequested=true`)
- **原始源码参考**:`E:/cloned-projects/grok-bot-0.18-reconstructed/frontend/src/recovered/features/conversation/workspace/transcript.tsx` + `chat-header.tsx` + `composer.tsx` + `cards/transcript-card/*` + `reaction-actions.ts` + `widget-responses.ts` + `workflow-commands.ts` + `roster-emit.ts` + `roster-projection.ts` + `replica-writer.ts`
