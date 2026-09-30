# Plan 501 — Bot 稳定增进四层（冻结纪律 / epoch×轮转 / 失败语义 / 兜底收口）

> **Status**: In progress · **Priority**: P1 · **Owner**: 501 session (2026-09-06)
>
> **来源**: 2026-09-06 对 grok-bot 0.18 的架构层差距分析（prompt 稳定性纪律 / 机械兜底 /
> 失败语义 / epoch 模型），用户确认做四层。用户锚点：session 数据就是为 epoch 设计的——
> 每压缩一次 epoch+1，产生一个新 session，以压缩文本为第一条数据（plan 493 Phase B）。

## 0. 现状 audit（2026-09-06 摸底结论）

| 层 | 现状 | 缺口 |
|---|---|---|
| 冻结双键 | `prompts/bot/epoch.ts` + `framework.ts` 已落地（474），DuyaAgent:3277 传 `summaryEpoch = countTimelineCompactions(timeline)` | `computeBotContentHash` 把 memory/automations/channels/mcpServers 揉进 contentHash——memory 每 turn 都被 extractor 改写 → contentHash 每轮变 → **全部 section 每轮重渲染，冻结纪律失效**（grok `resolveFrozenMemoryPrompt` 是按 compaction epoch 冻结 memory 的） |
| 代际轮转 | `MessageLog.rotateArchive`（493 Phase B）+ read path + `message-log-rotation.test.ts` 已落地 | **无生产触发点**：`appendBatch` 未检测 compaction payload → 永不轮转，`chat_sessions.generation` 恒 0，493 的"每压缩一次新 session"只是存储层空转 |
| 机械兜底 | plan 496 已落地：`send-message-reminder.ts`（mid-turn silence/early-result，ack≠delivery）+ `send-message-delivery.ts`（PreTurn reply reminder + PreFinalize delivery veto + closing-send nudge），DuyaAgent:1166 注册，bot 门控正确 | 群成员的 voice 是 `post_to_room` 而非 SendMessage——delivery 计数 helper 只认 SendMessage，群 turn 的 delivery 判定失真 |
| 失败语义 | 495 G3：preemption→redrive（`isRedriven` 回队）+ 收尾 epoch 护栏 + watchdog interrupt（500 P5.1） | ① redrive 回队**无叙事**（模型不知道自己被打断过）；② redrive **无上限**（grok 每成员最多 3 次）；③ 群成员被用户插话打断后**房间无叙事**（grok 贴 redelivery note）；④ watchdog 只 interrupt 不逃逸——runWake 永不返回时 drain 死等（grok 有 grace period 后 resolve promise + park zombie + pump queue） |

## 1. L1 — Prompt 冻结边界纪律（`packages/agent/src/prompts/bot/`）

双键拆分：**稳定段**（identity/roster/promptConfig）继续 contentHash 键；**易变段**（memory×3 /
automations / channels / spotlight / mcpServers 槽位）只按 `summaryEpoch` 键。

- `framework.ts`：`BotSectionDef` 加 `volatile?: boolean`；`renderSection` 对 volatile 段用
  `bot:<id>:v:<epoch>:<section>` 缓存键（epoch 变才重渲染；epoch 内 memory 变更不再打断任何 section）。
- `epoch.ts`：`computeBotContentHash` 指纹移除 `channels/memory/memoryRoots/automations/mcpServers`
  （它们不再是稳定键的一部分；identity 中途变更仍走 474 P3.1 profileUpdate 通告 + 压缩折叠路径）。
- `catalog.ts`：memoryOwn/memoryUser/memoryProject/botAutomations/botChannels/spotlight 标 `volatile: true`。
- 语义 = grok：memory 镜像按 compaction epoch 冻结，"model re-meets its environment"只在压缩后发生。
- 测试：`epoch.test.ts` 指纹不含 memory 变更；`framework.test.ts` volatile 段 epoch 内字节级稳定、
  epoch 变更重渲染、稳定段不受 memory 变更影响。

## 2. L4 — compaction → rotateArchive 触发接线（`electron/db/core/message-log.ts`）

- `appendBatch` per-session 循环：freshEvents 含 `payload.type === 'compaction'` 且为 bot session
  （`parseAgentIdFromBotSession`）→ 在 `getOrCreateRolloutPath` **之前**调 `rotateArchive(sessionId,'compaction')`
  → 压缩条目落在新 active.jsonl 的 rotation event 之后 = "新 session 第一条数据是压缩文本"。
  非bot session 不轮转（rotateArchive 自带守卫）。
- rotateArchive 抛错（archive 碰撞等 crash 中间态）→ catch + WARN + 照常追加（fail-open，消息写入
  永不因轮转失败而丢）。
- 对齐断言：bot session 压缩一次 → `chat_sessions.generation` = 1 且
  `countTimelineCompactions`（agent 侧）读到该 compaction 条目 → summaryEpoch == generation。
- 测试：`message-log-rotation.test.ts` 增补"appendBatch 带 compaction payload 自动轮转" +
  "轮转后 compaction 行 generation == 新 generation" + "非 bot session 不轮转" + "rotate 抛错不影响追加"。

## 3. L3 — 失败语义收口（`electron/wake/wake-dispatcher.ts` + `group-turn-dispatcher.ts` + `wake/types.ts`）

1. **redrive 叙事**：drain 派发 `item.isRedriven` 项时 prompt 头部注入隐藏
   `[redriven]` 说明（被打断过、续做未竟工作）；`user.message`（renderer 路径）与
   `connector.inbound`（reviveForInbound 自建 prompt）除外。
2. **redrive 上限**：`WakeItem.redriveCount?: number`；回队时 +1；`> MAX_WAKE_REDRIVES (=3)`
   → 丢弃 + WARN + 对 group.turn 项经注入回调 `onGroupTurnDropped` 在房间贴系统叙事。
3. **群中断房间叙事**：`scheduleGroupTurn` user-interrupt 分支 `appendRoomEntry` 系统行
   （"用户消息打断了 <member> 的发言"）。
4. **watchdog 逃逸**：interrupt 后再起 grace timer（默认 30s，`_set…ForTest` 可调）；到期
   runningItem 未变且仍持锁 → 僵尸逃逸：`drainGeneration++` → resolve waiters（空 outcome）→
   redrive 回队 → `state.draining=false` + kick 起新 drain。旧 drain 的 `await runWake` 返回后
   发现 generation 不匹配 → 原地退出（不再 dequeue、不再碰 runningItem）。锁仍被僵尸持有 →
   新 drain 对 isLocked 走 park；lock TTL 仍是最终兜底。
- 测试：`wake-preemption.test.ts` 增补 redrive 叙事/上限/逃逸三组；group-turn-dispatcher 测试增补中断叙事。

## 4. L2 — 兜底收口（`packages/agent/src/hooks/send-message-reminder.ts`）

- `hasSendMessageCall` / `countNonSendMessageToolCalls` / `hasSendMessageSinceRealTurnStart` /
  `countToolCallsSinceLastSendMessage` 把 `post_to_room` 与 SendMessage 同等计为一次 delivery
  （群 turn 发过言即不欠投）。
- 测试：helper 单测增补 post_to_room 用例。

## 5. 不做（明确）

- 群成员 turn 强制 `silenceAllowed=false`——grok 群聊语义是"发言或 `(pass)`"，静默=pass 是合法结局，
  不引入强制 veto。
- 每成员每轮消息数上限 / 房间历史窗口裁剪（478 域，另立项）。
- 存储预算 GC / model catalog（501 范围外）。

## 6. 任务

- [x] T1 L1 双键拆分（epoch.ts / framework.ts / catalog.ts + memory/sections.ts + 单测）。（✅ 2026-09-06；`BotSectionDef.volatile` — volatile 段缓存键 `bot:<id>:v:<epoch>:<section>`；contentHash 指纹移除 channels/memory/memoryRoots/automations/mcpServers；epoch.test.ts 21/21）
- [x] T2 L4 appendBatch 轮转触发 + 测试。（✅ 2026-09-06；compaction payload 落 bot session → rotateArchive → 压缩文本为新 generation 第一条数据，`chat_sessions.generation` 与 summaryEpoch 对齐；fail-open；message-log-rotation.test.ts 11/11）
- [x] T3 L3 redrive 叙事 + redriveCount 上限 + types。（✅ 2026-09-06；`[redriven]` 隐藏前言；`asRedriven` 递增计数；>3 丢弃 + `notifyGroupTurnDropped` 房间叙事（动态 import 防环））
- [x] T4 L3 群中断房间叙事。（✅ 2026-09-06；scheduleGroupTurn user-interrupt 分支 appendRoomEntry 系统行 + appendGroupTurnDroppedNotice）
- [x] T5 L3 watchdog 僵尸逃逸（drainGeneration）。（✅ 2026-09-06；escape grace `DUYA_BOT_WATCHDOG_ESCAPE_MS` 默认 30s；drainGeneration 防僵尸 drain 双跑；wake-preemption.test.ts 9/9）
- [x] T6 L2 post_to_room 计入 delivery 计数。（✅ 2026-09-06；send-message-reminder.ts isDeliveryCall；496 体系其余项 audit 确认已落地）
- [x] T7 验证。（✅ 2026-09-06；相关簇 532/537 绿；`npx tsc -p packages/agent --noEmit` 仅 ManageRoutineTool.ts:274 预存红；electron tsc 本簇文件干净）

### 预存失败归因（非本 plan 引入，HEAD 上即红）

- `wake-dispatcher.test.ts` 2 项（inbound 直派 / FIFO）— plan 495 §3.1 已归因 488 Plan B（reviveForInbound），归 488/497 修。
- `SessionMemoryCompactStrategy.test.ts` 3 项（getFileOperations 不存在）— compact 目录零未提交改动，HEAD 源码无该方法；测试期待被重构掉的 API，归 compact 收口任务。

### 验证环境备注

Electron dev 实例运行中锁死了 `better-sqlite3` 的 .node（ABI 无法换），DB 类测试经
`vitest.config.501.mts`（临时配置，alias 到 node-ABI 副本 `node_modules/.bs3-node`）运行；
Electron 关闭后可删除该配置与副本目录，恢复正常 pretest 自愈路径。

## 7. 提交边界

工作区存在并行 bot-model 簇 WIP（wake/types.ts、preemption.ts、SendToAgentTool 等已被改）——
本 plan 改动不单独提交，落工作区随并行簇一起收口；typecheck 归因按文件过滤。
