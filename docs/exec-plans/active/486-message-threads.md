# 486 — 消息 Thread/Fork 分支层（Message Threads：超长 session 内的独立讨论线）

> **Status**: Implementation · **Priority**: P1 · **Owner**: TBD
> **总纲**: [473-grok-bot-framework-overview](./473-grok-bot-framework-overview.md)
> **立项**: 2026-09-02（用户发现 grok 可在 bot 超长 session 内对单条消息开独立 thread——消息三点菜单 "Start a thread"——认为可融入 duya 现有 session 管理；全链路源码核实后**单独立项**，因横跨 message 模型/投影/压缩/UI，放 477 会超载）
> **参考源码**：grok-bot `shared/transcript-threads.ts`（thread 纯函数）、`host/extensions/transcript/send-thread-stamping.ts`、`send-pipeline.ts`（branched 落盘）、`host/extensions/session/agent-db-schema.ts`（branched 过滤 SQL）、`agent-db.ts`（getThread）、`host/runner/system-prompt.ts:48`（quote 注入）、前端 `workspace/conversation-workspace-controller.ts:184`（fork 提交）、`transcript-card/message-actions.tsx:277`（Start a thread）
> **前置**: plan 315（append-only MessageTimeline + `parentId` 字段基座——**已存在且未消费**）、424/485（bot 存储）、441（journal）

---

## 0. 实施决策记录（2026-09-02 Phase 1-3 落地）

- **字段承载**：ThreadMeta（`{ replyToId?, branched? }`）落在 `message.metadata[THREAD_METADATA_KEY='threadMeta']`（消息外层 metadata，**非 content**）——provider Message 纯净由模型投影剥离保证；持久化闭环经 metadata 白名单穿透（相比 timeline entry 层，metadata 是 agent↔electron↔DB 天然穿透载体）。
- **过滤点**（§2.2 实施选型）：`projectModelMessages`（模型边界，滤 branched + 剥离 threadMeta）与 `projectTranscriptMessages`（转录边界，滤 branched；`includeBranched: true` 供 thread 视图）各自过滤；`buildAgentContext` / `projectPersistenceMessages` / `projectTimelinePersistenceMessages` **不过滤**（branched 全量保留，getThread 可读）。
- **压缩豁免**（§2.4 关键点）：除输入过滤外，`MessageCompactionController.applyCompactionResult` 的 `realInputAgentMessages` 显式排除 branched——否则折叠区的分支会进 `compactedMessageIds` → `onCompacted` supersede 其 DB 行 → 分支丢失。另修正 `projectTimelinePersistenceMessages`：折叠前缀内的 branched 条目在压缩 marker 后补出，reload 后分支仍可解析（getThread 链匹配兜底 root 缺失）。
- **quote 注入**（§2.3）：在**每次 LLM 请求边界**（`DuyaAgent._applyProviderThreadBoundary`，位于 llmMessages 组装点）对带 `replyToId` 的 user 消息注入 `[In reply to <id>: "<quote>"]`（引用文本截断 500 字；幂等——已含前缀不重复注入；历史消息到达时已被投影剥离 meta，天然只命中当前轮）。注入后再统一剥离 threadMeta，保证 provider payload 纯净。
- **fork turn 轮级语义**（补充 §2.3 实施判定）：fork turn 是同一 session 的普通 run；`DuyaAgent.forkTurn` 标记在该轮开启，`_pushDurable` 把本轮的 assistant/tool 消息一并标记 branched（replyToId 指向 fork user 消息）——**整轮交换都归分支层**。持久化后主转录（projectTranscriptMessages）过滤、后续轮次主投影（projectModelMessages）过滤、压缩豁免，分支不污染主时间线/后续主上下文/压缩窗口。**当轮 provider 请求仍包含分支内容**（模型必须回答它），这是一次性上下文，不落盘不投影；grok 式的 thread 专用上下文组装（仅 root+descendants）由 483 的 thread 打开视图通道承接。
- **476 supersede 豁免 fork**：476 未实施，无处挂代码；实施 476 时须在其 §2.6 判定表为 fork turn 补「不可 prepend 恢复」行（本 plan §2.3 已定语义）。
- **顺带修复（plan486 会话中发现的仓库断点）**：`BackgroundTaskTool/GetTaskOutputTool.ts` 缺失 `DEFAULT_WAIT_TIMEOUT_MS`（WaitTasksTool 引用但全仓未定义，typecheck 红）→ 补 `= 120_000` 并注释意图；另确认 `tool/ToolSchemaTool`、`tool/ToolInvokeTool` 的 .ts 源在会话期间出现文件系统视图漂移（一度误判丢失，已恢复，非源码问题）。

## 1. 背景与差距

### 1.1 grok 机制（已逐文件核实，一句话版）

grok 的 "Start a thread" **不是新会话**——是同一 transcript 里的**分支层（branched layer）**：

```
消息三点菜单 "Start a thread"（非 thread-root 消息上可见）
  → projectForkSubmission(submission, rootId)          # 前端
       { ...submission, replyToId: rootId, isFork: true }
  → resolveSendReplyThreading(replyToId, isFork, …)     # host 校验 replyToId 存在
       isFork = isForkOption && replyToId != null
  → user 消息落盘带 replyTo + branched:true             # send-pipeline.ts:267,301
  → 主时间线 SQL 过滤 branched 条目                      # agent-db-schema.ts:2-28
  → getThread(rootId) = root + threadDescendants        # 沿 replyTo 链上溯求 root
  → quote 注入模型输入：`[In reply to <targetId>: "<quote>"]`   # system-prompt.ts:48
```

**关键结论（移植价值）**：thread = **同一 append-only timeline 内的分支投影**，bot 的超长 session 不分裂；主上下文不受分支污染（branched 不进主投影 → 不进主模型上下文）；压缩照常作用在主线上，分支独立成可折叠视图。这与 duya 的 315 架构（MessageEntry + parentId + 投影层）**天然同构**。

### 1.2 duya 现状 vs 差距

| 维度 | duya 现状 | 差距 |
|---|---|---|
| Timeline 基座 | 315：`MessageEntry { id, parentId, createdAt, message }` append-only（message-framework.ts:118-125）——**parentId 已有定义，全为 null 未被消费** | 干净地基，直接启用 |
| 投影 | `message-projectors.ts`（timeline → provider 消息），有过滤先例（hidden runtime_context 等） | 无 branched 过滤规则 |
| 压缩 | 422/475 `SessionMemoryCompactStrategy` 按 timeline 切分（findCutPoint / findSafeCompactionBoundary） | 分支消息的压缩语义未定（grok：branched 不进主投影 → 不占主窗口） |
| UI | 无 thread 视图概念（483 卡片族规划中） | 缺 "N replies" affordance + thread 打开视图 |
| 群聊 reply | 477 §2.5 消息类型表已预留 replyTo（可选） | 未定义 host 语义 |
| 持久化 | 441 journal 全量保留 | 分支条目落盘无特殊处理需求（同普通消息） |

---

## 2. 设计

### 2.1 消息字段（对齐 grok，收口到 477 §2.5 的 SendMessage 类型）

`AgentMessage` 增加两个**可选元数据**（放 message 外层 metadata 或专用字段——实施时定，倾向 timeline entry 层而非 content 层，保持 provider Message 纯净）：

```ts
interface ThreadMeta {
  replyToId?: string    // 被引用消息 id（thread root 或 thread 内消息）
  branched?: boolean    // true = 本条属分支层，不进主时间线/主上下文
}
```

- **创建规则**（对齐 grok resolveSendReplyThreading）：
  - 普通发送：无字段。
  - 回复（reply-to 引用，非 thread）：replyToId 有值、branched=false——UI 只显示引用预览，不折叠。
  - **fork / start-thread**：replyToId=rootId、branched=true——进入分支层。
  - 校验：replyToId 必须指向已存在 entry，否则静默丢弃（对齐 grok `validateAiReplyTarget`：目标不存在/指向 in-flight → stripReplyTo）。

### 2.2 投影规则（message-projectors.ts 扩展）

主投影（timeline → provider / 渲染时间线）增加规则：**过滤 `branched:true` 的条目**（对齐 grok agent-db-schema SQL 的 `json_extract(...branched) != 1`）。hidden runtime_context 的过滤先例可复用（message-projectors.ts 已处理非 durable/transient）。

**thread 读聚合**（新纯函数 `packages/agent/src/message/threads.ts`，对齐 grok `shared/transcript-threads.ts`）：
- `resolveBranchRoot(entry, byId)`：沿 replyTo 链上溯——遇到链上不存在于 branchedById 的祖先即返回该祖先 id（即 root = 最近的非分支祖先）；环/缺失 → undefined。
- `branchThreadDescendants(rootId, entries)`：所有 resolveBranchRoot === rootId 的条目。
- `branchReplyCounts(entries)`：Map<rootId, count>，供 UI "N replies" 徽标。
- 全部纯函数 + 单测（含环、孤儿、嵌套 fork 用例——grok 未覆盖嵌套 fork 的子级计数语义，duya 需补测：branch 的 branch 仍归同一 root）。

### 2.3 run 侧（fork turn 语义）

- fork turn 仍是**同一 session 的一次普通 run**（走既有 chat 链路），仅 user 消息带 branched。
- **turn_epoch（E3）**：fork turn 正常推进 epoch（它是新用户回合）；但 supersede 的 prepend-recovery **豁免 fork**（对齐 grok turn-runtime.ts:379 `isFork !== true` 分支——fork 消息不允许被当作可 prepend 恢复的普通消息）。476 §2.6 判定表补一行。
- **reply quote 注入**：fork/reply 的 user 消息进模型前，前缀注入 `[In reply to <targetId>: "<quote>"]`（quote 取被引用消息文本截断）——复用 422 重建序列的 user_prefix 渲染通道，加可选 `replyContext` 钩子。普通会话不注入（quote 仅在有 replyToId 时）。

### 2.4 压缩兼容（关键决策，对齐 grok 分支不占主窗口）

- **主压缩窗口只含非 branched 消息**：SessionMemoryCompactStrategy 的输入/切分在投影层已过滤 branched（§2.2），天然不占主上下文——与 grok 行为一致（branched 不进主投影即不进压缩）。
- **压缩后 thread 数据不丢**：branched 条目是 timeline 的普通 entry（只是不进主投影），压缩的 CompactionEntry 折叠的是主投影消息；分支消息若在压缩点之后仍原样保留（对齐 grok：branched 独立于主 transcript 分页，`getThread` 直接查 DB 不经压缩窗口）。
- 475 Phase 4 的 A4（tokenDetails stale）不受影响（分支不进 token 测量主链）。

### 2.5 UI（483 承接，本 plan 定数据契约）

483 的卡片族扩展（由 483 实施，本 plan 只定契约）：
- 消息上 "N replies" affordance（分支计数徽标，对齐 grok thread-affordance）。
- 三点菜单 "Start a thread"（仅非 branched 消息可见）。
- thread 打开视图：以 root 消息 + threadDescendants 渲染独立讨论流（复用 ChatView 模式；branched 消息**不**出现在主时间线）。
- thread 视图内的新发送 = replyToId 指向 thread 内消息 + branched=true（形成链）。

### 2.6 与 477 DM / 478 群聊的关系

- 477 envelope 的 `replyTo` 字段语义与本 plan 的 replyToId 同源；DM 消息也可 fork（bot 对自己 transcript 内消息开 thread）——477 实施时引用本 plan 字段，不另造。
- 478 群 transcript（group_room_messages 表独立）暂不引入 branched（群消息是平铺轮次）；群内引用用 `@mention`/quote 即可。后续如需群内 thread 再扩展。

## 3. 分阶段实施

### Phase 1 — 纯函数与字段
- [x] **P1.1** message 类型加 replyToId/branched（`threads.ts` ThreadMeta + metadata 命名空间 key）+ 单测（`tests/unit/threads.test.ts`：无字段旧消息 readThreadMeta=undefined、形状防御）。
- [x] **P1.2** `message/threads.ts` 纯函数（resolveBranchRoot/threadDescendants/branchReplyCounts/getThread/threadChainContains）+ 单测（环/孤儿/断链/嵌套 fork/多层 fork 计数归 root/root 缺失链匹配）。

### Phase 2 — 投影与发送
- [x] **P2.1** 主投影过滤 branched：`projectModelMessages`（模型）与 `projectTranscriptMessages`（转录，`includeBranched` 开关注入 thread 视图）+ 回归（`message-projectors.test.ts`：普通会话逐字不变、persistence 保留分支）。
- [x] **P2.2** fork/reply 创建规则接入发送路径：`ChatOptions.replyToId/branched` + `resolveReplyMeta`（replyToId 必须指向 timeline 已存在消息，否则静默 strip）+ 单测。
- [x] **P2.3** reply quote 注入：`applyReplyQuoteContext`/`messageToQuoteText`/`renderReplyQuotePrefix`（幂等、500 字截断）+ **每次 LLM 请求边界接入**（`DuyaAgent._applyProviderThreadBoundary`，llmMessages 组装点）+ 单测（有 replyToId 才注入、重复 turn 不 stack、数组/字符串 content、provider payload 无 threadMeta；`DuyaAgent.plan486.test.ts` 5 用例覆盖 fork turn/quote reply/strip/reload 全链）。

### Phase 3 — 压缩兼容 + 持久化核对
- [x] **P3.1** 压缩窗口只含非 branched：输入投影过滤 + `applyCompactionResult` realInput 显式排除 branched + `projectTimelinePersistenceMessages` 折叠前缀分支补出。集成测试（`message-compaction-controller.test.ts` plan 486 describe）：压缩后 compactedMessageIds/onCompacted 不含分支、timeline/DB 投影保留分支、reload 后 threadMeta 完整。
- [x] **P3.2** 441 journal/rollout 对 branched 落盘核对：branched 走普通 user_msg_added 事件（无新类型）；`Journal.fire()` 透传 `metadata.threadMeta` + electron `PERSISTED_METADATA_KEYS` 白名单加 `threadMeta` + 读回 `MessageRow.reply_to_id/branched` 两列（agent `messageRowToMessage` 还原）——单测见 `journal/__tests__/journal.test.ts`。

### Phase 4 — UI 与收口（483 联动）
- [ ] **P4.1** 483 侧 thread affordance + "Start a thread" 菜单 + thread 打开视图（数据契约已定：`projectTranscriptMessages(…, { includeBranched: true })` 渲染分支流、`branchReplyCounts` 供徽标、`THREAD_METADATA_KEY` 供引用渲染；MessageRow 已带 `reply_to_id/branched` 列）——**由 483 实施**。
- [ ] **G1** `npm run typecheck:all`（agent typecheck 已绿 ✅；electron 基线 700+ 错为 pre-existing 与本次无关，且未被 electron 常规构建门覆盖）+ 相关单测全绿 ✅（threads 34 / projectors 48 / compaction 17 / journal 13 / DuyaAgent.plan486 5 / DuyaAgent.plan315 16 / db-round-trip 8 / factories 19 / framework 18 共 **178 测试 0 失败**）；e2e（超长 session 开 thread → 分支不污染主时间线 → thread 视图可读 → 压缩后分支仍在）待 483 UI 就绪后执行。

## 4. 非目标

- 不做 grok 的 UI fork 出**新会话**（grok 实际也不做——本 plan 澄清此点）。
- 不做嵌套线程的复杂 UI 树（thread 内继续 fork 只延长链，不建子线程视图）。
- 不引入 thread 独立 token 预算/隔离模型（分支不占主窗口即够；若未来 thread 内也要压缩再评估）。
- 478 群 transcript 不接 branched（§2.6）。

## 5. 风险

- **branch 孤儿/环**：校验 replyToId 存在 + resolveBranchRoot 环检测双保险；孤儿分支（root 被压缩折叠）仍可经 getThread 读到（root 缺失时返回 descendants，对齐 grok agent-db.ts:245）。
- **压缩边界误含分支**：投影过滤在压缩输入前生效即可免疫；P3.1 集成测试兜底。
- **UI 主时间线被分支污染**：过滤规则单测 + 483 渲染断言（branched 绝不出现）。
- **回滚**：纯增量字段 + 投影过滤开关；字段恒 false/undefined 时行为与今天逐字一致。

---

## 6. 完整性审计定位（2026-09-02）

本 plan 源自 473 系列完整性审计第四轮——用户发现 grok 的 thread/fork 能力并判断可融入 duya session 管理。全链路核实（UI 入口 message-actions.tsx:277 → fork 提交 conversation-workspace-controller.ts:184 → host 落盘 send-pipeline.ts:267,301 → 过滤 SQL agent-db-schema.ts → 聚合 transcript-threads.ts → quote 注入 system-prompt.ts:48）后确认：duya 的 315 parentId 基座未消费，是**低成本的直接移植**；且 grok 的"分支层而非新会话"模型天然契合 duya session 串行架构。故单独立项（跨 message/投影/压缩/UI 四面）。
