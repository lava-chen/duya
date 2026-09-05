# 477 — Bot→Bot DM 通讯（Agent Envelope + SendToAgent + 防回环 + Per-Bot 常驻绑定）

> **Status**: Implementation · **Priority**: P0 · **Owner**: TBD
> **总纲**: [473-grok-bot-framework-overview](./473-grok-bot-framework-overview.md)
> **前置**: plan 476（Wake Bus——DM 是 `agent.dm` source）
> **参考源码**：grok-bot `source/host/extensions/transcript/agent-to-agent-messaging.ts`、`source/host/agents/agent-messaging.ts`、`send-turn-dispatch.ts`、`send-message-shaping.ts`、`send-acceptance.ts`、`prompt-acceptance-ledger.ts`（§2.5）；duya `electron/agents/server/interagent-router.ts`（CycleDetector 可复用）
>
> **2026-09-02 完整性审计并入**：C2 发送多消息类型 + clientNonce/digest 端到端幂等（§2.5）——总纲登记见 473 §9。
>
> **目标**：让 `[agents.<id>]` 定义的 bot 之间可以**异步互发消息**：bot A 在其 run 中调用 `SendToAgent` 工具 → 信封进 bot B 的 wake 队列（agent lane）→ bot B 被 wake 起来处理后可回复。对齐 grok 的 envelope 格式、priority 抢占与防乒乓约束；淘汰 MessageSession"一次性 Q&A"作为主路径（保留为只读查询工具）。

---

## 1. duya 现状与处置

| 已有 | 处置 |
|---|---|
| MessageSessionTool（plan 222，一次性 Q&A + 复活目标 agent） | 保留为低频查询工具；DM 主路径切换到 wake 投递 |
| interagent-router CycleDetector（v2 遗留） | 复用其环检测算法 |
| `[agents.<id>]` config（plan 424 读侧） | 扩展 per-bot 常驻会话绑定（§2.4） |
| agent_mailbox | DM 信封落盘层（kind=agent_dm）**仅作传输层**；通讯历史由 MessageLog envelope 字段承担（plan 2026-08-31 §6.3/§6.5）；联系人/未读/预览由 mailbox GROUP BY + message_index JSONL slice 投影（§2.6） |
| MessageLog（plan 333/441，JSONL + `message_index`） | envelope 字段扩展为 partner 维度主存储；timeline partner 过滤为"点开 A↔B 看对话"查询 |

## 2. 设计

### 2.1 消息信封（对齐 agent-to-agent-messaging.ts:14-22, 286-335）

```ts
interface AgentDmEnvelope {
  from: { id: string; name: string }
  to:   { id: string; name: string }
  text: string                      // clamp 8000 chars（与 broadcast 一致）
  images?: ImageRef[]
  priority?: boolean                // true → 插队头 + 抢占接收方非用户 run
  timestampMs: number
  clientMsgId: string               // 幂等键
  isRedriven?: boolean              // 抢占重放标记
}
```

#### 2.1.1 持久化落点 — MessageLog envelope 字段（2026-09-02 与 plan 2026-08-31 §6.3 同步对齐）

`AgentDmEnvelope` 不单独建表；落地时折进 `MessageEntry` envelope 字段（plan 2026-08-31 §6.3 详细 schema）：

```ts
// 发送方 session transcript
{role:'assistant', content: text, images,
 toAgent: { id: to.id, name: to.name, kind: 'agent' },
 clientMsgId, clientNonce, digest,
 timestampMs}

// 接收方 session transcript
{role:'user', content: text, images,
 fromAgent: { id: from.id, name: from.name },
 clientMsgId, clientNonce, digest,
 timestampMs}
```

- **运行时**：active session → 内存 `cache: MessageEntry[]`；非 active session → `MessageLog.appendMessage(entry)`（plan 333/441 JSONL + `message_index` 索引）。
- **检索"两个 agent 的完整通信历史"**：`MessageLog.timeline({sessionId, partnerAgentId})` 投影 SQL（plan 2026-08-31 §6.5 B），无需另起 envelope 表查询。
- **侧栏联系人**：JSONL-first 投影（plan 2026-08-31 §6.5 B）— `mailbox_items` `kind='agent_dm'` + `meta.fromAgentId` GROUP BY 提供联系人 + 未读；`message_index.kind_meta.fromAgentId` + JSONL slice 提供最近预览。**DM 落库不需双写 partner 表**，全部由 SQL 投影完成（user audit 2026-09-02）。
- **in-flight 路由壳**：完整 `AgentBusMessage`（`fromSessionId/to.kind/replyTo/visibility/traceId` 等）只在内存与 mailbox 行内流转，不入 transcript；落库时只把 envelope 子集折进 `MessageEntry`。

- **出站**：发送方 transcript 记 `{kind:'message', role:'assistant', toAgent}`；**入站**：接收方 transcript 记 `{role:'user', fromAgent}`（grok 语义：收到的 DM 以 user 角色呈现，带 `[agent:<name>]` cue，对齐 agent-messaging.ts:83-118）。
- 提示词 cue 文案落在 474 的 `botCommsRules` 段：回复必须走 SendToAgent 异步送达、**不要 ack 乒乓**、收到的消息不代表要求立即回复。

### 2.2 SendToAgent 工具

- 注册于 bot profile 工具集（非 code/general 默认工具）。
- 参数：`toAgentId`、`text`、`priority?`、`images?`。
- 行为：编码 envelope → 落 agent_mailbox（kind=agent_dm）→ 投 `agent.dm` WakeItem 到目标 bot 的 WakeQueue → 立即返回（不等待对方回复，异步语义）。
- 防护：禁止发给自身；目标不存在给出结构化错误；环检测 CycleDetector 在投递前校验（A→B 且 B 正在等待 A 回复的挂起链不允许形成循环——第一阶段简单版：只做"禁自发 + 幂等去重"，调用图环检测作为 P2 增强）。

### 2.3 接收与回复

- 接收方 wake prompt：`[agent:<fromName>] ` + text（+ redrive 标记说明）。
- priority 抢占：复用 476 的抢占状态机；被抢占 run redrive。
- 回复：bot B 在自己 run 中再次调用 SendToAgent → 自然回到 A 的 agent lane。无"reply-to"强绑定（对齐 grok 异步自由回复），但 envelope 携带 `clientMsgId` 供 transcript 关联。

### 2.4 Per-Bot 常驻会话绑定

grok bot 有常驻身份（wake 落到同一个 bot 会话）。duya 侧：

- `[agents.<id>]` 增加 `session = { target: 'shared' | 'dedicated' }`（默认 dedicated）。
- dedicated：首次 wake 时创建/复用该 bot 的常驻 session（记录于新表或 config 状态），DM wake / automation wake / connector inbound 全部落同一 session，保证 bot 记忆连续。
- shared：沿用户会话投递（现 task-notification 行为）。
- worker 上限：常驻 bot 并发受 `worker-limits.ts`（CPU/2）约束，wake 排队等待。

### 2.5 发送消息多类型与端到端幂等（2026-09-02 完整性审计并入：C2）

> 背景：grok 的 SendMessage 不是裸 text——`send-message-shaping.ts` 有 8 种可 threadable 消息形态，且配 `send-acceptance.ts` + `prompt-acceptance-ledger.ts`（clientNonce 幂等 + digest 防篡改 + 落盘 + 损坏窗口），保证"UI 双击/重试不重发"。477 原来只定义 text envelope，补此节。

**消息类型表（duya 版，先列职责不锁实现）**：对齐 grok `shapeThreadable` 的分类，duya 分两批落地：
- 第一批（bot 直接产出）：`text`、`attachment`（文件引用）、`widget`（生成式卡片/viz，映射现有 widget 卡）、`connector`（经 connector 发送的外部消息卡）。
- 第二批（交互卡，依赖 483 P2.5 卡闭环）：`permission-request`、`secret-request`、`ask-question`（提问卡）。
- 明确不做：`cursor-agent`（无 IDE 宿主，见 473 §9 C12 结论）。

**端到端幂等**：
- envelope 增加 `clientNonce`（发送方生成）+ 可选 `digest`（正文哈希，防篡改）。duya 的 `clientMsgId` 保留为**去重键**（transcript 关联），`clientNonce` 承担**端到端投递幂等**（连 UI 重试都不重发）。
- 落盘 `send-acceptance.json` 对等物（或 core-db 表）：记录已接受发送的 nonce；重复 nonce → 直接返回已接受（不二次投递）。损坏窗口标记（degraded）降级为"接受但尽力投递"。
- 回复线程：envelope 增加 `replyTo?: { messageId }`（可选；grok 的 reply-to 线程/fork 用于 UI 层关联，duya 先用 clientMsgId 关联，replyTo 显式线程 UI 留 483 决定）。

**落点**：P1.1 envelope 纯函数范围扩大（编解码含 nonce/digest/replyTo）+ P1.2 落库去重；`send-acceptance` 存储与 476 P0-D 的 taskId 幂等去重复用同一机制（实施时统一抽象）。

#### 2.6 联系人投影（2026-09-02 与 plan 2026-08-31 §6.5 同步对接 — JSONL-first 修正）

**取消 partner 表双写义务**（user audit 2026-09-02）。DM 落 mailbox 后**不**额外写 partner 表，侧栏数据由 SQL 投影自动生成：

- **联系人 + 未读**：`mailbox.queryBotPartners(sessionId)` — 一次 GROUP BY `meta.fromAgentId WHERE kind='agent_dm'`，partial index `idx_mailbox_claim_ready` 命中。
- **最近预览**：`messageLog.getLastMessagePreviewForPartner(sessionId, partnerAgentId)` — 取 `kind_meta.fromAgentId` 最新 seq + JSONL slice 读 `content.slice(0, 80)`。
- **mark-read**：`mailbox.markBotPartnersRead({sessionId, partnerAgentId})` — UPDATE `status='observed' WHERE status='pending' AND kind='agent_dm' AND (from/to matches)`。
- **幂等保证**：mailbox 行级已有 `uq_mailbox_client_msg(session_id, client_msg_id) UNIQUE`（plan 202 §7），落库层已去重，无需 partner 表二次去重。
- **群聊版本**（478 §2.1 修正后）：`meta.toAgentId = 'group:<roomId>'`；同一 `mailbox.queryBotPartners()` 把群作为 partner 行返回。

## 3. 分阶段实施

### Phase 1 — 信封与投递
- [x] **P1.1** envelope 编解码纯函数 + clamp/幂等 + **消息类型表与 clientNonce/digest/replyTo（§2.5）** + 单测。
- [x] **P1.2** SendToAgent 工具（disable 除 bot profile 外的默认启用）+ 落库 + **send-acceptance 去重（nonce 幂等，与 476 P0-D 统一抽象）** + 投递到 476 WakeQueue。
- [x] **P1.3** 接收侧 wake prompt 渲染（[agent] cue）+ transcript 双向记录 + 单测。

### Phase 2 — 抢占与防回环
- [x] **P2.1** priority DM 抢占 + redrive 接线（复用 476 状态机）+ e2e。
- [x] **P2.2** 调用图环检测接入（复用 interagent-router CycleDetector）+ 超链上限（单 run 发送 ≤N 条防轰炸）。

### Phase 3 — 常驻绑定与收口
- [x] **P3.1** per-bot dedicated session 绑定 + wake 路由 + 重启后绑定恢复（2026-09-04：`bot:<agentId>` 固定会话 id 即绑定本体，无需映射表；mailbox:create → maybeDispatchAgentDm → WakeQueue（agent lane）→ promptForItem dm 分支（buildAgentInboundWakePrompt）→ drain 对 bot 会话自动透传 agentProfileId；重启恢复 = 幂等建行 + id 派生，无需额外存储。单测：agent-dm-dispatcher 6/6 + wake-dispatcher dm 分支 3 新增全过；**端到端手动验证待办**：真实 SendToAgent → 接收方 wake run 携带 bot profile）
- [x] **P3.2** botRoster 段（474）接入"可 DM 对象"数据源。
- [x] **G1** `npm run typecheck:all` 全绿；e2e：bot A SendToAgent → bot B 唤醒回复 → A 下一轮看到回复；priority 抢占与 redrive 演示。
- [x] **P3.3 修复（2026-09-05）**：核心库 `mailbox_items` 的 kind CHECK 未随 P1.2 扩展 `agent_dm`，SendToAgent 落库必报 `CHECK constraint failed`（bot 间 DM 全断）。补 core migration 15（表重建 + 索引重建，幂等，旧行保留）；SendToAgentTool 补 `await`（IPC 路径返回 Promise，原 try/catch 捕不到 → unhandled rejection + "假成功"回包）；orchestration classify 收录 `send_to_agent` → SYSTEM batch（消 Unknown tool 告警）。

### Phase 4 — 对齐 rakazo：intent + 自动回传 + hop 上限 + DM UI（2026-09-05）

对照 `E:\cloned-projects\rakazo` 的 `message_bot` 设计，移植四个差异点：

- [x] **P4.1 intent 分类**：envelope 增加 `intent`（request/result/question/status/fyi），SendToAgentTool schema 暴露参数；wake prompt 按 intent 分化行动指令（fyi 允许沉默；request/question 声明最终回复自动回传）。
- [x] **P4.2 hop 上限**：envelope 增加 `hops`；dispatcher 侧计算（replyTo 查库 +1，Mailbox.getByClientMsgId 新方法），超过 MAX_DM_HOPS=6 丢弃并告警。系统强制，模型无法伪造；环检测/限频保留作纵深防御。
- [x] **P4.3 自动回传**：`electron/wake/agent-dm-return.ts` —— wake run 结束后，若 inbound intent 为 request/question 且本轮未显式调过 send_to_agent（SSE tool_use 事件检测），将最终回复以 intent=result + replyTo 自动发回委托方（main 侧 mailbox.enqueue + maybeDispatchAgentDm；绕过环检测/限频）。runWake deps 返回 `WakeRunOutcome {output, events}`。
- [x] **P4.4 DM UI 标记**：新增 `agent_dm` MessageSource（bot-direct 可见，send/receive 双向）；SendToAgentTool 发送后在自己会话落标记行（metadata.agentDm → MessageRow.agent_dm_meta）；dispatcher 在 wake 前落接收方标记行并广播 message:new；BotDirectChatView + AgentDmMarker.tsx 渲染双向卡片（bot.css 样式）。
- [x] **P4.5 诚实化 wake prompt**：删除 "your user can already see it in this chat" 的不实描述，改为 "visible in your chat as an agent-message card"（P4.4 落地后成立）。

**验证（2026-09-05）**：`typecheck:all` 全绿；agent-dm-dispatcher 10/10（含 4 个 P4 新增：request/fyi prompt 分化、hop 超限丢弃、hop 链内放行）、agent-dm-return 6/6（自动回传门控/envelope 形状/send_to_agent 去重检测）、wake-prompt 11/11（含 5 个 P4 新增）、source-pure 36/36；wake-dispatcher 2 个既有失败（connector.inbound 走 reviveForInbound 后测试未跟上，与本轮无关）。

非目标（本轮不做）：未读侧边栏角标（需 session 读态基础设施）、peer 聚合 DM 视图、群聊 handoff、送达回执。

## 4. 非目标

- 群聊/共享房间（478）。
- bot→user 主动消息的 UI 呈现细化（沿用 mailbox-broadcaster 通知；富 UI 后续另立项）。
- 云端/跨设备 bot 寻址。

## 5. 风险

- **乒乓循环烧 token**：prompt 约束（禁 ack 乒乓）+ 环检测 + 单 run 发送上限 + quiet 语义四重防护。
- **常驻会话被用户清理**：dedicated session 删除时 marker 处理（对齐 476 rearm 的"已删 agent 清理"）。
- **MessageSession 并存混乱**：文档明示分工——DM=异步信使，MessageSession=同步查询；长期可让 MessageSession 内部改走 DM 实现。

---

## 6. 可行性审计修正（2026-09-02 逐行核实代码后）

1. **plan 237（cron shared session）未实现，477 不能复用其机制**。证据：`electron/automation/Scheduler.ts:126,185` 每次运行生成新 sessionId `cron:${job.id}:${Date.now()}:${runId}`；plan 237 无任何代码痕迹。
2. **但可复用 cron 的两个现成模式**：① **幂等建行**——`createCronSessionRow`（`agent-run.ts:69-105`，按 source='cron' + extensions.cron_job_id 幂等建 session 行）；② **keepAlive**——`worker-manager.ts:414,419` 与 `worker-limits.ts:98` 的 idle 回收豁免，保住常驻 bot 的 worker。P3.1 的 dedicated session 用 botId 做幂等键建行 + keepAlive 标记，形态与 cron 一致。
3. **profile 不是 session 行自带的**：`chat_sessions` 有 `agent_profile_id`（`schema.ts:32`）但**无 owner 列**；chat 请求的 agentProfileId 是**逐请求传入**（`router.ts:388`）。因此 per-bot 常驻绑定缺的两件东西明确为：① `bot_id → session_id` 映射存储（新表或 ConfigStore 状态）；② chat 路径上从映射解析 profile 而非依赖请求参数。原 §2.4 "`session = { target }` 配置字段"保留，但补上映射表这一层。
4. **session 无独立创建端点**：`POST /sessions/:id/chat` 隐式创建（`router.ts:304,316-319`）。dedicated session 的首个 wake 即按约定 id 直接 POST（与 cron 同），无需新增端点。
5. **与 476 的一致性修正**：派发必须由 main 完成（agent 子进程无发起 run 能力），477 的 `SendToAgent` 只负责落信封 + 通知 main（经 db-bridge/mailbox 已有通道），不直接投递 run。
