# 476 — Agent Wake Bus（三车道唤醒调度 + 来源注册表 + 持久化 Rearm + 抢占/Redrive）

> **Status**: Implementation mostly_complete · **Priority**: P0 · **Owner**: TBD
> **总纲**: [473-grok-bot-framework-overview](./473-grok-bot-framework-overview.md)
> **参考源码**：grok-bot `source/host/extensions/transcript/`：`background-wakes.ts`、`completion-revivals.ts`、`pending-wake-rearm.ts`、`sand-pending-wake-store.ts`、`send-turn-dispatch.ts`、`run-scheduler.ts`（三车道）、`roster-projection.ts`、`async-task-union.ts`；`sand-quiet-work-origin.ts`、`sand-multitask.ts`
>
> **目标**：把 duya 目前各自为政的唤醒路径（task-notification、cron fire、renderer 消息、未来的 DM/connector inbound/broadcast）收敛到**单一 Wake Bus**：统一来源注册、车道优先级、pending 持久化与重启 rearm、优先级抢占与 redrive、quiet-work 语义。**这是 477/478 的地基。**

---

## 1. duya 现状盘点（不重造的部分）

| 已有 | 位置 | 处置 |
|---|---|---|
| 后台任务完成通知 | `lifecycle/mailboxBackgroundNotification.ts:34` → `<task-notification>` 写 `agent_mailbox`（kind=background_notification，taskId 幂等） | 收编为 WakeSource `task.completion` |
| Mailbox checkpoint 认领 | `agent/session/mailbox.ts:49` `MailboxClaimer.claim()`（before_model_turn / before_final_answer，claimBatch limit 10） | **保留为投递层**；wake bus 决定"何时唤醒 + 用什么 lane" |
| 空闲唤醒广播 | `electron/messaging/mailbox-broadcaster.ts` `mail:created` → `src/stores/mailbox-store.ts` | 保留，作为 wake 的 UI 通知面 |
| 三优先级 FIFO | `packages/agent/src/queue/index.ts`（now/next/later） | 扩展 lane 语义（见 §2.2），不推翻 |
| cron fire | `electron/automation/agent-run.ts:264` `runCronInSession()`（HTTP POST /sessions/:id/chat，'cron' profile 禁交互工具，skip/replace 并发） | 收编为 WakeSource `automation.fire`（quiet-origin 可选） |
| 外部入站 | gateway inbound + `channel_bindings` | 收编为 WakeSource `connector.inbound` |
| session 串行 | queue FIFO + `session_runtime_locks` | **保持**；抢占 = 中断当前 run 后按 lane 重排，非并行 |

## 2. 设计

### 2.1 统一类型（新文件 `packages/agent/src/wake/types.ts`）

```ts
type WakeLane = 'user' | 'agent' | 'background'          // grok run-scheduler 三车道
interface WakeItem {
  id: string                       // 去重键（source 提供的 dedupeKey）
  source: WakeSourceKind           // 见 §2.3
  lane: WakeLane
  agentId: string
  enqueuedAtMs: number
  turnEpoch?: number               // E3 回合代数（见 §2.6）：user/agent lane 派发时由 main 侧 currentTurnEpoch 赋值；background 可空
  quietOrigin?: QuietWakeOrigin    // { automation?: {id, name} } — 全部完成项均 quiet 时用静默指令
  payload: WakePayload             // 按 source 的判别联合（envelope/completion/automation/event…）
}
```

### 2.2 WakeQueue（每 agent/bot 一条）

- 三条 FIFO：`pendingUser` / `pendingAgent` / `pendingBackground`，严格 `user > agent > background`（对齐 grok run-scheduler）。
- agent 串行执行：`enqueueExclusiveRun` 语义——同一 agent 同时只有一个 run；队头 lane 决定下一个 run。
- 与现有 queue/index.ts 关系：`now/next/later` 三档映射到 lane（user→now、agent→now|next、background→later），或在 queue 之上加薄 lane 排序层——**实施时二选一并记录决策**。
- 抢占（对齐 agent-to-agent-messaging.ts:112-147 + send-turn-dispatch.ts:123-141）：
  - `user` 或 `priority=true` 的 `agent` wake 到达时，若当前 run 非用户发起 → interrupt 当前 run（复用既有 DELETE /chat / steer 通道）。
  - 被中断 run 的在途 wake 标记 `isRedriven=true` 回队重放（redrive），不丢失。
  - **抢占即推进 turnEpoch**（见 §2.6）：新 user/priority wake 派发时 `turnEpoch+1`，旧 run 的收尾副作用（nudge/错误上报）以 epoch 不匹配被抑制。

### 2.6 turn_epoch 回合活性语义（2026-09-02 审计补，对齐总纲 473 §2.5.1 E3）⭐

> 476 原设计只有"排队 + 抢占"，缺 grok 的核心安全语义：**被新消息 supersede 的旧回合不得再打扰用户**。本系列凡 agent 单 run 生命周期相关（nudge、错误上报、审批时效）都依赖此纪元，必须随 wake bus 一起建立。

**维护者**：main 侧 WakeQueue（`Map<sessionId, number>`，进程内存、重启清零，对齐 grok `SendPipeline.turnEpochs`）。
**推进时机**：`user.message` 或 `priority=true` 的 `agent.dm` 派发时 +1（`dispatchUserTurn` 对等）；普通 background 唤醒**不推进**。
**判定规则**（消费方为 run 生命周期，对齐 grok `turn-runtime.ts:332-573`）：

| 场景 | 判定 | grok 行为 | duya 落点 |
|---|---|---|---|
| 旧回合收尾 | run 启动后 `currentTurnEpoch` 已变 | 该 run 视为 superseded：不 prepend-recovery、不 nudge、错误不上报 UI、deliveryOwed 不上报 | 476 P1 状态机纯函数 + P2 接线；475 的 reminder 判定也用它 |
| nudge / 追问 | `epoch === current` 才允许 | ensureUserReply 只在最新回合触发，避免旧回合重复追问 | 476 Phase 3 |
| 群聊轮次 | group turn 以 `epoch === current` 判 isCurrent | 过期即中断该 group turn（group-chat-glue.ts:270-279） | 478 落地时复用本纪元 |
| 审批时效 | 审批签发记 userMessageEpoch（E4） | 新回合 = 旧审批作废（sand-auto-review.ts:97-160） | 419/审批链复用同纪元（可加列或内存 map） |

**压缩与 turn_epoch 正交**：压缩发生在单 run 内**不**推进 turn_epoch；它推进的是 summary epoch（E1，见 474/475）。二者不可互相替代——476 只管回合活性，压缩纪元归 474/475/479。

**reply-nudge 正面移植决策点（2026-09-02 完整性审计并入：C3）**：grok 有完整的 reply-nudge 循环（`ensureUserReply` 最多 3 次追问 + closing-send nudge，`turn-runtime.ts:534-603`）——run 结束未交付回复时在回合内主动追问 bot。审计结论：**nudge 与 484 的 ack redrive 功能重叠**（都是"run 没回用户 → 系统催 bot 回"），差别只在 nudge 是回合内即时追问（最多 3 次、紧贴 run）、ack redrive 是 5s idle 后的隐藏 run。**倾向不重复移植 nudge**：用 484 的 ack redrive 统一覆盖"未交付"场景（时机稍晚但机制更简单、跨回合安全）；若实现后发现 ack redrive 的 5s 延迟体感过慢，再回补 nudge 为"回合内先行版"。此决策在 484 Phase 3 e2e 后复核。

### 2.3 WakeSource 注册表（第一阶段 6 个）

| SourceKind | lane | 触发点（duya 现有代码） | dedupeKey | 对应 grok |
|---|---|---|---|---|
| `task.completion` | background | mailboxBackgroundNotification | taskId | completion-revivals（subagent/shell） |
| `automation.fire` | background（quiet 可选） | Scheduler tick → fireAutomation 等价 | jobKey+fireKey | automation-run-path |
| `connector.inbound` | background | gateway inbound（channel_bindings 映射 session） | envelope id | wakeForInbound |
| `broadcast` | background | 预留（管理面 API） | broadcast id | broadcastToAgents |
| `agent.dm` | agent（可 priority） | 477 SendToAgent 投递 | clientMsgId | sendToAgent |
| `user.message` | user | renderer/gateway chat 入口 | — | dispatchUserTurn |

- automation 事件合批：750ms 防抖 + 单次 wake 事件批 ≤25（对齐 automation-event-fires.ts:8-9）。
- 广播文本 clamp 8000 字符（对齐 background-wakes.ts:309-353）。

### 2.3.1 automation.fire 前置：cron→bot 绑定（2026-09-02 用户质询补）⭐

> 用户质询："automation 也就是 duya 已实现的 cronjob 并未直接和 bot id 绑定，这个需要解决"。核实双方代码后确认这是 **P2.3 的前置缺口**——不解决，bot 的例行任务（grok routine）无处安放，476 P2.3 也没有真实语义。

**现状证据（duya）**：`~/.duya/cronjob.toml`（`cron-file.ts:78-93`）job schema 含 `id/name/prompt/schedule/working_directory/model/concurrency/max_retries`——**无 agent/bot 字段**；Scheduler fire 每次生成一次性 session `cron:${job.id}:${Date.now()}:${runId}`（`Scheduler.ts:126`）+ `createCronSessionRow`（`agent-run.ts:69-105`）→ `runPromptInSession(agentProfileId:'cron', effort:'off')` 直跑即归档。cron 是无状态触发器，与任何 bot 身份/记忆无关。

**目标模型（grok）**：automation 属于 agent——`agents/<agentId>/automations/<autoId>/automation.json`（config）+ `runs.json`（历史）；fire = `fireAutomation({agentId, automation, trigger})` 在**该 agent 自己的运行上下文**执行 routine（automation-runtime.ts:458；wake cue "your own standing order firing"）；agent prompt 内嵌 automation status/reminder（475 §2.2 已规划 duya 侧对等物）。

**绑定方案（duya 务实版）**：
1. **绑定字段**：`cronjob.toml` job 增加可选 `agent = "<bot-slug>"`（复用 485 `isSafeBotId` 约束）。语义：该例行任务属于 bot X，fire 时以 X 的身份执行。
2. **fire 分流**（Scheduler/`runCronNow` 判断 `job.agent`）：
   - **无 `agent`** → 现状不变：一次性 cron session 直跑（存量 job 零影响，UI/定时任务页不动）。
   - **有 `agent`** → 解析 X 的常驻会话（477 §2.4 dedicated session：botId 幂等键建行/复用）→ 以 `agentProfileId = X`、正常 effort 在该会话跑 `job.prompt` + automation-trigger 上下文（475 P4.4 durable block），产出经 SendMessage 汇报——bot 用自己的身份、记忆、通讯对象执行例行任务。
3. **与 476 wake 的关系**：常驻会话忙（用户在跟 bot 聊）→ 该 fire 转 wake 入队（P2.3 的 `automation.fire` item：lane=background、agentId=bot 常驻 session、dedupe=jobKey+fireKey）；空闲则直接跑。**476 P2.3 的真正语义 = "bot 绑定的 cron 在目标会话忙时排队"，不是给现有一次性 cron 排队**（后者独立 session 直跑不需要队列）。
4. **存储归属（D1 已定案 2026-09-02：只走 cronjob.toml 字段）**：job 加可选 `agent` 字段即唯一方案——duya 单一文件权威源哲学、UI 定时任务页零迁移、bot 例行任务与全局 cron 同源同管理。**不做 bot 目录 `automations/` 形态**（grok 的 per-agent 目录是它"模型自建 routine"的产物；duya 无此需求前不引入第二套存储）。
5. **依赖排序**：bot 绑定的 cron 真正能跑依赖 **477 P3.1**（常驻会话建行）+ **475 P4.4**（automation-trigger 注入）。故 **P2.3 拆两步**：P2.3a（随 476）只落 `job.agent` 字段 + 解析/校验 + fire 分流骨架（无 agent 分支全通、agent 分支打桩等 477）；P2.3b（477 后）接通常驻会话执行 + 忙时入队。

### 2.4 Pending 持久化 + 重启 Rearm

- 新表 `pending_wakes`（core-db）：`{agentId, kind, workId, markedAtMs, title, quietOrigin, lane}`，原子写对齐 grok `.part`+rename（duya 用 SQLite 事务即可）。
- 写入时机：后台工作**启动**时 persist；wake 消费时 clear。
- 重启 rearm（对齐 pending-wake-rearm.ts:95-129）：
  1. `pruneStale`（48h 上限）；
  2. 已删 agent 的 marker 清理；
  3. 仍在进行的外部工作（cron/长任务）重新挂 watch；
  4. 无法恢复的（如中断的 subagent）合成一条"宿主重启打断"错误 completion 唤醒所属 bot。
- Roster 投影：live 任务（BackgroundAgentLifecycle）+ 持久化 marker 按 `kind\0id` 去重合并（对齐 async-task-union.ts:45-57），供 UI 异步任务视图与 475 压缩摘要使用。

### 2.5 Wake Prompt 组装

- 每类 source 提供确定性 `buildWakePrompt(payload)`（纯函数，单测覆盖）。
- quiet 规则（对齐 QUIET_REVIVAL_INSTRUCTION）：wake 的全部完成项 `quietOrigin` 时，prompt 注入静默指令——无真正新结果则不得发消息/唤醒用户，静默结束。
- 用户发起 run 与 wake run 的区分：`runOrigin: 'user' | 'wake'`，抢判断依据。

## 3. 分阶段实施

### Phase 0 — 后台通知唤醒自闭环（**可独立交付的最小切片**）

> 只做 `task.completion` 一类来源 + 空闲自唤醒，先把"后台任务完成后能唤醒会话"从 renderer 依赖里解放出来。其余车道/来源/抢占/持久化全部不在本切片。

- [x] **P0-A 忙闲判定接线（唯一共享改动）**：在 agent-server 的 chat 路径接线 `session_runtime_locks`——`handlePostChat` 开始时 `acquire`，chat 终态（完成/中断/错误）`release`；锁带 `expires_at` TTL 防泄漏。Store 现成（`electron/db/core/stores.ts:450-517`），已暴露给 worker（`db-bridge.ts:535`）与 main IPC（`db-handlers.ts:567`），当前**零生产 acquire 调用**。main 侧即可用 `isLocked(sessionId)` 判定忙闲——agent-server 是独立 fork 子进程（`agent-server-lifecycle.ts` 拉起，port 0 + IPC），其内存 sessionManager 不可直读。
- [x] **P0-B main 侧空闲唤醒**：订阅 `mail:created`（background_notification）→ `isLocked` 为假 → 走 cron 同款 `runPromptInSession` 发一次 hidden wake run；wake prompt = 通知摘要（本切片先不做 quiet 语义）。
- [x] **P0-C 双路互斥**：新增 main 唤醒路径后必须与 renderer 的 `resumeBackgroundTask`（`src/lib/stream-session-manager.ts:1078-1100`）互斥，否则同一通知唤醒两次。方案：配置项 `wake.idleDispatch: 'renderer' | 'main'`（默认 renderer 保持现状），二者共用 taskId/clientMsgId 幂等去重作为第二道保险。
- [x] **P0-D 幂等去重**：唤醒意图按 `taskId` 去重（同一后台任务只唤醒一次），为 Phase 3 的 `pending_wakes` 留接口，本切片不落表。
- [x] **P0-G 验收**：① CLI/无 renderer 模式下后台 bash 完成能唤醒会话（当前必然失败，是本切片的价值点）；② 开着 renderer 且开关为 main 时不出现双唤醒；③ run 中进行中的会话行为逐字不变（checkpoint 认领路径零改动）。

**切片边界（影响面声明）**：
- 零改动：agent-core 的 checkpoint 认领链路、`agent_mailbox` schema、mailbox 认领语义、renderer 默认路径（开关后）。
- 新增/改动：`electron/agents/server/*` 的锁 acquire/release（共享改动，但 TTL 幂等、其他 plan 也需要，属提前还债）、新增 `electron/wake/` 模块、renderer 侧读取开关。
- 明确不含：三车道（此时只有 background 一类）、抢占/redrive、quiet-work、pending_wakes 落表与 rearm、DM/群聊、475 压缩重注入。

### Phase 1 — 类型与纯函数
- [x] **P1.1** `wake/types.ts` + WakeQueue 纯数据结构（三 lane FIFO、enqueue/dedupe/merge、队头选取）+ 单测。
- [x] **P1.2** 抢占/redrive 状态机纯函数 + 单测。
- [x] **P1.3** turn_epoch 纯逻辑（§2.6）：`nextTurnEpoch` / `currentTurnEpoch` / supersede 判定纯函数（epoch 不匹配 → 抑制 nudge/error/recovery）+ 单测（含压缩不推进、user/priority 才推进、background 不推进的用例）。

### Phase 2 — 接线（先两个 source 走通）
- [x] **P2.1** `task.completion` 与 `user.message` 接入 WakeQueue（改造 mailboxBackgroundNotification 与 chat 入口的调用顺序，行为保持等价）。
- [x] **P2.2** queue/index.ts lane 映射决策落地；agent 串行 + lane 排序 e2e。实现：wake-dispatcher 单飞 drain（严格串行）+ dispatcher 级集成测试（user lane 优先于 background、同 lane FIFO、busy park/release 续跑）——§6.1 作废子进程 lane 映射后以 main 派发循环语义落地。
- [x] **P2.3a** `automation.fire` 前置（§2.3.1）：cronjob.toml job 加可选 `agent` 字段（复用 485 isSafeBotId）+ 解析/校验 + Scheduler `runCronNow` fire 分流骨架（无 `agent` 分支全通=现状不变；`agent` 分支先打桩，等 477 P3.1 常驻会话）。单测：无 agent 存量 job 逐字不变。
- [x] **P2.3b**（依赖 477 P3.1）`automation.fire` 真接入：`job.agent` → bot 常驻会话（botId 幂等键建行/复用）→ `agentProfileId=X` + automation-trigger 上下文执行；常驻会话忙 → 转 `automation.fire` wake（lane=background、agentId=常驻 session、dedupe=jobKey+fireKey、quiet 可选）入队 + 750ms 合批 ≤25。
- [x] **P2.3c** `connector.inbound`（gateway → wake）接入——**dispatcher 层完成**（`enqueueInboundWake`：lane=background、dedupe=envelope id、prompt 分支含渠道文本；单测含 merge）。**gateway 侧接线评估**：现状 `gateway:inbound`（message-bus.ts）内联 SSE run（chat:text 回传渠道），无 statusCode 处理——busy 时 SSE 空 → fallback chat:error。完整接线需把该内联 run 提取为可重入执行器供 dispatcher 注入（回复链依赖 SSE 转发，hidden runWake 无渠道回传），**留待 gateway 专项/482**。
- [x] **P2.4** `broadcast` 最小实现：`enqueueBroadcastWake`（内部 API，多目标 session 入 background lane、文本 clamp 8000、dedupe=broadcastId merge）+ prompt 分支；单测（多播/clamp/merge）。
- [x] **P2.5** turn_epoch 接线（§2.6）：main 侧维护 Map，`user.message`/priority DM 派发时 +1；run 收尾副作用（nudge/错误上报/prepend-recovery）接 supersede 判定。e2e：A 回合进行中用户发新消息 → 旧回合收尾不 nudge 不上报错误。

### Phase 3 — 持久化与恢复
- [x] **P3.1** `pending_wakes` 表 + persist/clear 接线。
- [x] **P3.2** 启动 rearm 流程（pruneStale / 重新挂 watch / 合成中断 completion）+ 单测。
- [x] **P3.3** Roster 投影合并 + UI 异步任务视图消费。

### Phase 4 — Quiet-work 与收口
- [x] **P4.1** quietOrigin 标记贯通（cron quiet 配置、subagent quiet 链）+ QUIET_REVIVAL 指令注入。
- [x] **P4.2** wake 可观测性：每个 wake 的 lane/source/等待时长日志与 trace。
- [x] **G1** `npm run typecheck:all` ✅ + wake 单测全绿 ✅；人工 e2e：后台任务完成后 bot 被唤醒且 quiet 语义正确（待人工验证）。

## 4. 非目标

- 不实现 DM/群聊本体（477/478）；本 plan 只预留 `agent.dm` source 与投递接口。
- 不做并行 run；**Phase 0 会给 `session_runtime_locks` 补上真实 acquire/release（改的是"从未接线"的现状，不是改既有语义）**，Phase 2 之后不再动它。
- grok 的 cloud-agent watch（云端沙箱）无对应物，rearm 只处理 duya 存在的工作类型。

## 5. 风险

- **mailbox 语义扩容**：agent_mailbox 最初为 in-run instruction 设计；wake 总线若复用其 claim 通道，需扩 kind 并保证旧行为回归（原 in-run mailbox 消息不受 lane 影响）。若冲突过大，回退方案：wake 走独立队列 + 只把"唤醒通知"写 mailbox。
- **抢占打断用户可见 run**：仅允许 user/priority-DM 抢占，且被抢占 run 必须 redrive，防止任务静默丢失。
- **rearm 误唤醒**：48h prune + dedupeKey 幂等 + marker 与 live 任务合并去重三重防护。

---

## 6. 可行性审计修正（2026-09-02 逐行核实代码后）

### 6.1 重大修正：WakeQueue 权威实现必须在 electron main
- **证据**：agent 子进程对 main 只有 chat/db/journal 类事件，**无任何反向请求 run 的通道**（`electron/agents/db-bridge.ts` 仅处理 `db:request`）；所有 run 发起方（renderer/cron `agent-run.ts:148-167`/gateway `message-bus.ts:590`/interagent-router）都收敛到 HTTP POST `/sessions/:id/chat`。
- **修正**：§2.2 的"queue/index.ts lane 映射决策（P2.2）"**作废**——子进程命令队列不动。WakeQueue 的派发循环住 main，复用 cron 的 `runPromptInSession` 模式投递（HTTP chat）；`packages/agent/src/wake/` 只保留纯类型与纯函数（排序/合并/去重，供测试），不承载运行时。

### 6.2 空闲自唤醒必须自带，现有链路在无 renderer 时断裂
- **证据**：空闲唤醒判定在 renderer（`src/lib/stream-session-manager.ts:1078-1100`，`pendingBackgroundResumes` 等终态）；mailbox-broadcaster 消费端是 `window.webContents`。CLI/无窗口模式下无人触发唤醒。
- **修正**：新增前置任务 **P0.0 空闲判定接线**：main 侧可靠查询"session 是否有 run 进行中"。两个候选：① agent-server HTTP 状态查询（main 无法直读其内存 sessionManager，agent-server 是独立 fork）；② 真正接线 `session_runtime_locks`——注意该表当前**无任何生产 acquire 调用**（仅测试引用），真实互斥是 router 的 STREAMING 状态 409（`router.ts:331-343`）。实施时二选一并记录决策。

### 6.3 checkpoint 认领的引用更正 + 持久化决策
- 生产路径是 DuyaAgent 内联 `_claimMailboxAtCheckpoint`（`DuyaAgent.ts:1414-1419` before_model_turn、`:2212-2217` before_final_answer、实现 `:2619`）；`agent/session/mailbox.ts` 的 MailboxClaimer 类**未被生产接线**（仅测试引用）。plan 中相关引用以此为准。
- 认领消息是 transient runtime_context，**不落 rollout**（`mailbox.ts:11-13` 契约；走非 durable 路径 `DuyaAgent.ts:2588-2590`）。**决策点**：wake run 是否需要可审计的历史？若需要，由 475 的摘要与 441 journal 承载（wake run 的最终输出本身会落盘），mailbox 便条保持 transient——倾向后者，P4.2 可观测性改以 wake 生命周期事件（lane/等待时长）落 logger/journal，不落消息体。

### 6.4 抢占与队列回放的交互
- **证据**：DELETE /chat（`router.ts:2029-2036` → `workerManager.interruptWorker` → stdin `chat:interrupt` → `agent.interrupt()`）只 abort 当前 chat；子进程 commandQueue 中排队的 `chat:start` **仍会在 turn 结束后回放**（`agent-process-entry.ts:3639-3644`）。
- **修正**：抢占实现必须考虑回放残留——抢占前 main 需先感知"子进程队列是否有排队命令"（否则新 run 插入后旧命令回放造成乱序）。最小方案：抢占 wake 直接以排队的 `chat:start` 形态入子进程队列头（复用队列优先级），而非 interrupt+新 run；redrive 语义相应调整为"被中断 run 的收尾由 interrupt 后的 followup 机制处理"。P1.2 状态机设计时定稿。
- **与 §2.6 turn_epoch 的关系（2026-09-02 补充）**：排队命令回放是"乱序执行"问题（机制层），turn_epoch supersede 是"副作用归属"问题（语义层）——即使回放无法完全避免，旧 run 因 epoch 不匹配也不会产生 nudge/错误上报/deliveryOwed；两层各自成立，P2.5 接线时用 epoch 兜底抑制，与 6.4 的入队策略互补。

### 6.5 落点修正汇总
| 原 plan 内容 | 修正 |
|---|---|
| §2.2 queue/index.ts now/next/later 映射 lane | 作废；main 侧 WakeQueue + HTTP 投递 |
| §3 P2.2 | 改为 main 派发循环 + cron 式投递 e2e |
| §1 中 "MailboxClaimer.claim()（agent/session/mailbox.ts:49）" | 引用改为 DuyaAgent 内联实现 |
| 空闲唤醒（未提及依赖 renderer） | 新增 P0.0 空闲判定接线（§6.2） |
