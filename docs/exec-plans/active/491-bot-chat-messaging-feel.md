# 491 — Bot 聊天"发消息感"体感与流畅度对齐（相位机 / 渲染节流 / entry 账本衔接）

> **Status**: Implementation · **Priority**: P0（P0 组快赢）/ P1（结构项） · **Owner**: TBD
> **当前进度（2026-09-05）**:P1.1 发送路径解耦 ✅（`send/` 模块 + `handleBotDirectSend` + `session:ensureBot`，见 §Phase 1 P1.1）;P0.x 相位机 / 流式节流 / 会话状态机待做（依赖 489 P0.3 订阅底座的干净消费侧）。
> **立项动机（2026-09-04）**: 483 P2.1 + P2.1b 已把 bot 聊天窗口的**静态样式**对齐 grok（气泡/composer/header/日期分隔），489 已立项 SendMessage-only **数据流硬保证**（source 列 + 订阅切换）。但"发消息感"——真实聊天应用那种**瞬时回声、相位可见、流式不抖、恢复无感**的体感——在 duya 还没有对应机制。本 plan 对标 grok-bot 0.18 的 `ComposerSubmissionQueue`（相位机）/ `SendPipeline`（acceptance ledger）/ transcript entry 账本（appended/updated）/ roster 状态家族（typing/working），给出 duya 的分阶段落地方案。
>
> **总纲**: [473-grok-bot-framework-overview](./473-grok-bot-framework-overview.md)
> **上游/平行**: [483-multi-bot-chat-ui](./483-multi-bot-chat-ui.md)（UI 面）、[489-bot-chat-dataflow-and-complete-cards](./489-bot-chat-dataflow-and-complete-cards.md)（数据流硬保证 + 卡族）、[484-bot-reliability-ack-and-resume](./484-bot-reliability-ack-and-resume.md)（ack 义务）、[447-streaming-durable-dedup](./447-streaming-durable-dedup.md)（流式/持久去重）、[441-event-granularity-journal](../../active/441-event-granularity-journal.md)（per-event journal，文件暂缺、机制已在 `_pushDurable` 落地）
> **证据基线**: 2026-09-04 对 grok-bot 0.18 reconstructed 源码通读（`frontend/src/production/coordinator-client.ts`、`source/host/extensions/transcript/{send-pipeline,send-turn-dispatch,turn-runtime,session-runtime,roster-emit}.ts`、`transcript-feed-source.ts`）与 duya 全链路通读（`App.tsx:319-460`、`src/lib/stream-session-manager.ts:1241-1700`、`src/lib/agent-sse-client.ts:185-230`、`electron/agents/server/router.ts:106-200`、`packages/agent/src/agent/DuyaAgent.ts` streamChat）。

---

## 0. 现状盘点（2026-09-04 实测）

| 体感保证 | grok-bot 0.18 机制 | duya 现状 | 缺口 |
|---|---|---|---|
| 瞬时回声 | SendPipeline 生成 echo entry，`transcript:appended` 先于 LLM 启动上屏 | 乐观 user 消息（`metadata.optimistic`）✅ | 回声有了，但**无相位显示**——sending/sent/failed 用户不可见 |
| 相位可见 | `ComposerSubmissionQueue`：pending → queued → sent/failed/cancelled，离线自动 queued、重连 flush、失败可重发 | `enqueueMessage` mailbox + `canSend` 门控；`db_persisted` ack 事件**已存在**但未接到任何 UI | 无每条消息的相位状态机；失败静默 |
| 流式不抖 | entry 粒度 `updated` 事件 + outline 250ms 聚合 + sand-virtual-transcript 虚拟列表 | SSE `text/thinking` **每 delta 直灌 store** → 整列表 re-render；无虚拟化；行未 memo | token 级重渲染风暴；长列表 O(n) diff |
| 状态指示 | `agents`/`agent-upserted` 独立家族（roster emitAgentUpdate：状态+预览文本） | `isStreaming` 布尔 + 混在内容流里的 `status`/`agent_progress` | typing 药丸与 header working 共用单布尔；思考/工具/等待审批不可区分；状态抖动连带内容重渲染 |
| 恢复无感 | seq 账本 + `getAgentTranscriptWindow(nextBeforeSeq)` 翻页 + 重连 `emitWindowedCatchUp` | 历史走 `db:*` IPC、流走 SSE **两条通道**；重连 `attachToExistingStream` + `stream:end` 兜底 | 无统一 seq 游标；断线补发靠整页重载 |
| 工具过程可见 | client-side-tool-v2 专用家族，实时 widget 投影 | `tool_use_started/delta` 已有（461 已做实时参数流式），bot-direct 视图被 `isBubbleMessage()` 过滤掉 | bot 视图看不到工具行（489 P0.3 后才进入订阅） |

**结论**: 样式已对齐（483 P2.1b），数据流硬保证在 489 Phase 0，**体感层（相位/节流/状态机/游标）无人认领** —— 本 plan 补这一层。

---

## 1. 设计原则

1. **相位是渲染端事实，持久化是 DB 事实** —— 相位机只活在 renderer（内存态），DB 侧不新增表；两态在 `db_persisted` ack 处汇合（同 grok：queue phase + acceptance ledger 分离）。
2. **渲染端不发明协议** —— entry 账本的 seq/事件契约由 489 P0.3 的订阅切换定义，本 plan 只约定**消费侧形状**（seq 游标 + appended/updated 分发），不新增 SSE 通道名。
3. **节流不改语义** —— 聚合只发生在渲染缓冲层，store 里的最终文本保持完整；丢帧不丢字。
4. **一切状态切片化** —— 状态/用量类与内容 delta 类路由进不同 store 切片，互不触发 selector 失效（对齐 grok 事件家族的隔离思想，不照搬 15 个 family）。

---

## 2. 分阶段实施

### Phase 0 — 快赢四件套（纯前端，无架构变更，1-2 天）

- [ ] **P0.1 消息相位状态机**
  - 本地消息扩展 `delivery: 'sending' | 'sent' | 'failed' | 'queued'`（`conversation-store` 内存态，随 `db_persisted` ack / `stream:end` 无 ack 翻转）
  - 气泡视觉：sending 降透明度 + 小钟角标；failed 红角标 + 点击重发（复用乐观消息 UUID 去重窗口）
  - 落点: `conversation-store.ts`（delivery map）+ `BotBubbleRow.tsx`（角标）+ `bot.css`（相位样式，token 化）
  - 测试: 相位翻转 3 例（ack / 超时无 ack / enqueue→queued→sent）
- [ ] **P0.2 流式渲染节流**
  - `stream-session-manager.createStreamEventHandler` 的 `text/thinking` delta 进 ref 缓冲，rAF 或 64ms 定时合帧 flush（对齐 grok outline 250ms 聚合的思路，内容流用更短窗口）
  - `StreamingMessage` 单独订阅自身 streamId；MessageItem 行 `React.memo` + 稳定 key 审计
  - 落点: `stream-session-manager.ts`（缓冲层）+ `MessageList.tsx` / `StreamingMessage.tsx`
  - 验收: 长回复流式期间 MessageList 渲染次数从 O(delta) 降到 O(帧)，React Profiler 记录对比数据
- [ ] **P0.3 Bot 会话状态机（typing/working 的真数据源）**
  - 收敛 SSE `status`/`agent_progress`/`tool_use_started` 为小状态机: `idle → thinking → tool(name) → streaming → waiting_approval → error`
  - typing 药丸按状态变形：thinking=三点；tool=复用 `BotToolCallRow`（shimmer + 工具名）；首段文本到达时药丸原地过渡为气泡
  - header working 徽章吃同一状态机（不再独立 `isStreaming`）
  - 落点: 新 `src/components/chat/bot/useBotSessionPhase.ts` + `BotDirectChatView.tsx` + `BotTypingIndicator.tsx`
- [ ] **P0.4 滚动锚定 + 跳转最新**
  - 向上滚动冻结跟随；底部浮出"跳转最新"胶囊（未读计数）；流式高度增长用 `overflow-anchor` + 手动锚底双保险（git 历史修过 scroll jump，此处脆弱）
  - 长列表行级 `content-visibility: auto`（一行 CSS 的跳过渲染）
  - 落点: `BotDirectChatView.tsx`（transcript 滚动逻辑）+ `bot.css`

### Phase 1 — 结构项（与 489 P0.3 / 483 P2.5 合并设计，2-4 天）

- [x] **P1.1 bot-direct 发送路径解耦（483 P2.5 本体）**
  - 新 `botDirectSend(botId, content, opts)`: 自持相位机（P0.1）、nonce 去重（content hash + 时间窗，对标 acceptance ledger）、忙时策略可配（**排队** vs **抢占**——`DmPreemptionTracker` 已在，缺 bot 会话维度的选择权暴露）
  - `BotDirectChatView` 摘除 `onSend` 对 workspace `handleSendMessage` 的复用（App.tsx:523）
  - 与 489 P0.3 的边界: 489 管**写入侧 source 标记**，本项管**渲染端发送管线**；接口汇合点是 `botDirectTranscript` hook
  - **2026-09-05 完成**：`send/` 模块（botDirectSend + nonce + preemption + useBotSendPhase）接入 App.tsx `handleBotDirectSend`；busy→`enqueueMessage` 复用 workspace 队列自动 flush；composer 启用条件从 3 段 boundThreadId 改为 contact 存在（2 段占位 id 现可由服务端 `session:ensureBot` 懒创建）；server 端配套：router 懒建 bot 会话行 + 强制 agentProfileId 注入 + worker keepAlive（db-bridge `session:ensureBot` action，与 agent-dm-dispatcher 建行形状一致）
- [ ] **P1.2 entry 账本消费侧（衔接 489 P0.3 订阅切换）**
  - 消费侧契约（不新增协议，只约定形状）: entry 带 `seq`；事件 `appended(seq, entry)` / `updated(seq, entry, before?)`；hook 内维护 `lastSeq` 游标
  - 断线重连: `botDirectGetTranscript(sessionId, { afterSeq })` 窗口补发，替代整页重载（对标 `emitWindowedCatchUp`）
  - 气泡/工具行/卡片按 entry kind 装配（483 P2.2 卡族挂此装配点）
  - 前置: **等 489 P0.3 合入**（另一会话在途，`use-bot-direct-transcript.ts` 尚有未完成 IPC）；本 plan 只做消费侧预留接口 + 单测
- [ ] **P1.3 状态/用量微切片（对标事件家族隔离）**
  - `status`/`agent_progress`/`token_usage` 路由进独立 `sessionPhaseStore`；内容 delta 走现有 streaming 状态
  - header 徽章、ContextUsageRing 订阅微切片；MessageList 的 selector 不再被状态抖动连带失效
  - 落点: 新 `src/stores/session-phase-store.ts` + `stream-session-manager.ts` 事件路由

### Phase 2 — 打磨（挂在 483 P2.2 卡片族里顺手做）

- [ ] **P2.1** composer 草稿按 bot 持久化（对标 grok `draft-state.ts`；localStorage per botId）
- [ ] **P2.2** 失败/compact/模式切换渲染为 notice 卡片（对标 grok notice-card，可回溯不 toast）
- [ ] **P2.3** 气泡 hover 时间戳 + 相位角标整合（呼应 P0.1）
- [ ] **P2.4** 未读分隔线（对标 grok unread-divider；accent token 化，不用青柠硬编码）

### Phase 2.5 — Bot 新建后跳转回归修复（bugfix，独立于 P2 打磨）

> 范围最小、与 489 P0.3 / 483 P2.5 发送管线解耦、纯前端、~1 小时。
> 触发：新建 bot 后侧栏有 bot 但点击不跳到 BotDirectChatView（白屏/退回 welcome 视感）。

**根因**：新建 bot 只有 `agents/<id>/profile.json`，没有 `chat_sessions` 行。
点 bot 后 `resolveBotOpenThreadId` 退到 `deriveBotPlaceholderThreadId(agentId) = "bot:<agentId>"`
。然后 `setActiveThread("bot:<agentId>")` 内部 `set(updates)` 同步设了 `activeThreadId`，
但 `await loadFromDatabase()` 命中 **orphan cleanup**（plan 224 / commit ddfccf12 引入的
"`activeThreadId` 不在 DB 就清" 保护），把 `activeThreadId` 清回 `null`。视图先 render 一次
BotDirectChatView 再被切回 WelcomeView，看上去"像没跳转"。另一条隐藏路径：placeholder 一旦
被选中就进 localStorage（`partialize` 不区分 placeholder vs 真 session），下次启动 hydrate 后
再次被同一清理逻辑清掉——重启体验丢失。

**修复（两处 store + 一处 sidebar）**：

- **D1 partialize**（`src/stores/conversation-store.ts`）：
  新增 export `isPlaceholderBotThreadId(id)` 与 `partializeConversationState(state)` 纯函数。
  `partializeConversationState` 把 placeholder `bot:<agentId>`（恰好一个冒号）映射成
  `activeThreadId: null`、其余字段原样返回。persist middleware 的 `partialize` 现在委托给
  它。判断逻辑：占位是 `bot:` 前缀 + `split(':').length === 2`；真 session
  `bot:<agentId>:<sessionId>` 是 3 段；其它 kind（room/cron/gw-/wakeless/UUID 主 agent）一律不动。
- **D2 loadFromDatabase cleanup**（同上文件 line ~1103）：
  orphan cleanup 分支增加白名单：命中 placeholder 时**不清**，仅 `console.warn` 级别。
  原因：占位本就不该出现在 `chat_sessions`（plan 483 P1.3 设计意图），它是 in-memory UI 状态，
  清它反而违反 plan 230 第三点"对不存在线程降级为空聊天壳、不写库不建会话"的意图。
- **C fast-path**（`src/components/layout/app-sidebar.tsx`）：
  新增 `handleOpenBotById(agentId)` 不依赖 `botContacts` 闭包——直接读
  `useConversationStore.getState().threads` 计算 bound/placeholder id，避免 `onCreated`
  里等 `reloadBots` 完成才跳转。`CreateBotDialog.onCreated` 改成接 `agentId`，
  `await reloadBots()` 之前先 `handleOpenBotById(agentId)`，再用 `setIsCreateBotDialogOpen(false)` 收尾。

**为什么不选 B（仅 loadFromDatabase 加白名单）/ A（提前 createThread）/ 单纯 C**：

- B：修运行时清理，但 placeholder 仍进 localStorage——重启路径仍丢上下文。
- A：写空 session 污染 `chat_sessions`，违反"用户未发消息就不留行"的 plan 483 意图。
- 单纯 C：用户体验修，但 `setActiveThread` 内部仍会清 activeThreadId，逻辑 bug 不变。
  C 必须配合 D1 + D2 才生效。

**验收**：

- `vitest run src/stores/__tests__/conversation-store.placeholder.test.ts` 全绿（11 个用例）
- `vitest run src/components/layout/sidebar/bot-contacts.test.ts` 全绿（20 个用例）
- `vitest run src/components/chat/BotDirectChatView.test.tsx` 全绿（10 个用例）
- `npm run typecheck:web` 仅遗留 P0.3 / MarketplacePage 三个预先 error（与本次无关）
- 手动：新建 bot → 点 sidebar → 进 BotDirectChatView 空壳、composer 禁用；关 app 重启不丢该 bot

**接入规划**：

- 不发单独 plan，挂在 491 上当作 bugfix 条目；PR 标题 `fix(conversation-store): keep placeholder bot ids out of persist + orphan cleanup (491 P2.5)`
- 与 483 P2.5（bot-direct 发送路径解耦）无冲突：D1/D2 仅影响"未发消息的 bot 占位"，第一条真消息走 483 P2.5 的 `createThread + 替换 id 再发` 路径时，placeholder 已自然消失

---

## 3. 验收标准

- **Phase 0**: 断网发送 → 气泡 failed + 重发可用；发送后 ack 前 sending 角标可见；流式期间 React Profiler 中 MessageList 渲染次数 ≤ 帧率上限；typing 药丸在 thinking/tool/streaming 三态可区分；滚动冻结 + 跳转胶囊可用
- **Phase 1**: bot 忙时发送可配置排队/抢占且 UI 相位正确；断线重连后 transcript 按 seq 补发无重复无丢失（对照 447 的去重断言）；状态抖动不再触发 MessageList 重渲染
- **Phase 2**: 打磨项逐条手动验收
- 全程: `npm run typecheck:all` 绿（并行会话阻塞解除后补跑）、触碰组件 vitest 绿、UI 变更 Playwright MCP 验证

## 4. 依赖与风险

| 依赖/风险 | 说明 | 对策 |
|---|---|---|
| 489 P0.3 在途 | `use-bot-direct-transcript` 另一会话开发中，树上尚有 IPC 类型错误 | P1.2 只做消费侧接口预留；合入前不动订阅切换 |
| 447 去重边界 | entry 账本上线后流式重放去重逻辑要跨迁移 | P1.1 实现前重读 447 决策日志，补发窗口必须复用其 durable-prefix 扣除逻辑 |
| typecheck:all 全仓红 | 并行会话在途改动（message-framework 等） | 各 Phase 提交前跑**触碰文件级** tsc；全仓绿后统一补跑 |
| 441 journal plan 文件缺失 | README 引用 `441-event-granularity-journal.md` 但磁盘无此文件（机制已落地） | 本 plan 按机制名（`_pushDurable`）引用；顺带在 README 修正该行链接 |

## 5. 决策日志

### 2026-09-04 — 立项
- 体感四保证（回声/相位/流畅/恢复）对照 grok 逐项打分，duya 均为半成品；样式层（483 P2.1b）与数据层（489 Phase 0）已有归属，本 plan 认领体感层。
- 分层依据: P0 四件套全部纯前端可独立验收；P1 三项触及发送管线与订阅协议，必须与 489/483 P2.5 的接口汇合点对齐后再动手；P2 顺挂卡片族。
- 明确不做: 渲染端虚拟列表全量接入（先 `content-visibility` 过渡，grok 式 virtual-transcript 待 entry 账本后有真实行高数据再评估）；语音听写按钮（依赖 plan 410 voice，另有归属）。

### 2026-09-04 — P2.5 新建 bot 跳转 bugfix 补登
- 现象：用户新建 bot 后侧栏出现该 bot，但点击不跳转到 BotDirectChatView（视图瞬间闪回 WelcomeView，看上去"无反应"）。
- 根因：`setActiveThread("bot:<agentId>")` → `await loadFromDatabase()` 命中 plan 224 / ddfccf12 引入的 orphan cleanup（"activeThreadId 不在 chat_sessions 就清"），把刚设的 placeholder 立即清回 null。`partialize` 又把 placeholder 原样写进 localStorage，下一次启动 hydrate 后被同一清理再清一次——重启丢失上下文。
- 取舍：选了 D1（partialize 过滤 placeholder）+ D2（cleanup 加白名单）+ C（sidebar onCreated fast-path）三件套。否决 B（仅白名单 cleanup——漏修持久化路径）、A（提前 createThread——污染 chat_sessions 表）、单独 C（修 UX 不修 bug）。理由：placeholder 是 in-memory UI 状态而非 DB 实体，承认这一点比给它单独写一条"例外 row"更清晰。
- 设计哲学：承认 placeholder session id 是合法的"in-memory active state"。partialize 与 cleanup 都在它的边界处过滤，而不是让两者各自解释它。`isPlaceholderBotThreadId` 是单一真理来源，partializeConversationState 委托它、cleanup 分支也用它。
