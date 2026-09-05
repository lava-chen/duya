# 484 — Bot 可靠性兜底（ack 义务投递确认 + Run 级中断续跑）

> **Status**: Planning · **Priority**: P0 · **Owner**: TBD
> **总纲**: [473-grok-bot-framework-overview](./473-grok-bot-framework-overview.md)
> **立项**: 2026-09-02（473 系列完整性审计新增——全量对照 grok-bot host 侧 13 功能簇后，确认两块**可靠性底线**空白：C4 ack 义务、C6 断点交接/升级恢复）
> **前置**: plan 476（WakeQueue + 锁接线 + quiet 语义）、441（事件级 journal，若复用其落盘）
> **参考源码**：grok-bot `source/host/extensions/transcript/ack-obligations.ts`、`sand-ack-obligation-store.ts`、`channel-delivery-unregistered-error.ts`；`source/host/extensions/transcript/upgrade-recreate-resume.ts`、`sand-upgrade-resume-store.ts`、`box-handoff-resume.ts`

---

## 1. 背景与差距

### 1.1 ack 义务（C4）——"用户消息必须被可见确认"

grok 语义：**用户发出的每条消息都欠一条可见回复**（ack obligation）。run 结束时若该 run **没有产出任何 SendMessage / reaction**，则视为"静默吞回复"——宿主在 idle 5s 后发一条**隐藏 redrive run**，强制要求 bot 真正回复；最多 3 次，仍失败则标记 lost 并（按配置）通知。

| 维度 | grok 实现 | duya 现状 |
|---|---|---|
| 义务登记 | `recordAckObligationSend`（`ack-obligations.ts`）每次用户发送即写持久化义务（agentId/sessionId/coalescedCount/redriveAttempts/lastInterruptAtMs） | 无——wake/cron run 结束若无输出即静默，无兜底 |
| 判定"欠回复" | run 结束结算：`0 send & 0 react` → `scheduleAckRedriveAfterIdle` | 无"该 run 是否真的回了用户"的结算 |
| redrive | idle 5s → 隐藏 run，prompt 强制 SendMessage（`buildAckRedrivePrompt`）；`MAX_ACK_REDRIVES=3` | 476 的 "redrive" 是 wake 回队重放，**非投递确认** |
| 归属防串扰 | `ackRunTokens`：redrive run mint token，只有携带该 token 的 SendMessage 才 fulfill，防旧 run 误冲账 | 无 |
| 失败处理 | 超 3 次 → markAckObligationLost；删除 agent → 清义务 | 无 |

**为什么必须有**：bot 场景（477/478/482 全部依赖 wake run）里，run 可以因模型空回复、工具循环未收敛、被抢占后收尾不全等原因**结束但没回用户**。没有 ack 义务，用户看到的只有"运行了但没回复"，且无任何系统补救。

### 1.2 run 级中断续跑（C6）——升级/崩溃/换机不丢回合

grok 语义分两种：

| 场景 | grok 实现 | duya 现状 |
|---|---|---|
| **宿主升级** | `requestQuiesceForUpgrade`（静默所有 runner）→ 落 `upgrade-resume.json` marker（含 automation runId 以便续跑）→ 重启后 `resumeInterruptedUpgradeTurns` 发 hidden prompt 续跑；source 决定措辞（automation / background-revival / 默认） | worker 进程随宿主退出被杀，**正在跑的 chat run 直接丢**；476 P3 只 rearm pending wake（"还有后台工作要唤醒"），不含"正在跑的回合续跑" |
| **崩溃/异常退出** | 同 marker 机制，重启后恢复 | 同上 |
| **等待用户操作时交接**（box-handoff） | `handBackForeverBox` 举手 → 用户处理完（MCP auth/secret/密码/连接）→ `resumeWithHiddenPrompt` 续跑 | duya 无 box 概念，但**等价语义** = pending 审批卡/secret 卡等待用户响应时的 run 生命周期（与 483 卡闭环衔接） |

**边界声明**（与既有 plan 的分工）：
- **476 P3 pending_wakes rearm** = "后台工作 marker（subagent/shell/cron 在宿主挂了时仍在跑）重启后重新挂 watch / 合成错误 completion"。**484 不管这个**。
- **484 = "正在执行的 agent run 被中断后 resume"**——宿主退出瞬间在跑的回合（含其已产生的部分输出与上下文状态）。
- **441 journal** 提供事件级持久化；484 的 marker 是"run 意图"级（轻量 JSON 而非消息流）。

## 2. 设计

### 2.1 ack 义务（对齐 grok ack-obligations.ts + sand-ack-obligation-store.ts）

**数据**（新表 `ack_obligations`，core-db）：
```ts
interface AckObligation {
  agentId: string
  sessionId: string
  userMessageId: string          // 义务来源消息（幂等键）
  coalescedCount: number         // 同窗口多条用户消息合并计数
  redriveAttempts: number        // 0..3
  lastInterruptAtMs?: number
  status: 'open' | 'fulfilled' | 'lost'
  fulfilledByRunId?: string
}
```

**流程**：
1. **登记**：用户消息投递（476 `user.message` 派发）时 upsert 义务（同 session 未决 → coalescedCount+1）。
2. **结算**：run 结束（476 turn 收尾，含 epoch supersede 路径）检查该 session 是否有 open 义务且本轮 `sendCount === 0 && reactCount === 0` → `scheduleAckRedriveAfterIdle`（5s）。
3. **redrive**：idle 后发隐藏 wake run（background lane），prompt = `buildAckRedrivePrompt`（"用户在上一条消息等待你的回复，请立即回复；若确无新内容则明确告知"）。redrive run mint `ackRunToken`；模型经 SendMessage 工具回时携带 → fulfill。
4. **上限**：redriveAttempts ≥ 3 → status='lost'，logger + 可选 UI 提示（mailbox-broadcaster 通知）。不无限烧 token。
5. **清理**：删除 bot / 清 session → 清义务（对齐 grok delete agent 时 markAckObligationLost）。

**与 turn_epoch 的关系**：supersede 后旧 run 不 fulfill（epoch 不匹配）——新回合重新结算。ack 义务挂在 **session** 而非单个 run 上，天然跨回合。

### 2.2 run 级中断续跑（对齐 grok upgrade-recreate-resume.ts + sand-upgrade-resume-store.ts）

**数据**（新文件 `run-resume-markers.json`，随 476 pending_wakes 同目录；或 core-db 表，实施时二选一并记录决策）：
```ts
interface RunResumeMarker {
  runId: string                  // 幂等键
  agentId: string
  sessionId: string
  source: 'user' | 'automation' | 'background-revival' | 'interrupted'
  automationRunId?: string       // source=automation 时用于续跑原任务
  interruptedAtMs: number
  lastUserMessageId?: string
  partialSummary?: string        // 中断时已知上下文摘要（可选）
}
```

**流程**：
1. **静默（quiesce）**：宿主收到升级/退出信号 → 通知 agent-server 停止接受新 run（现有 shutdown 链路扩展），给在跑 run 短宽限（如 2s）→ 逐个落 marker（只落**确实在跑**的，不落排队 wake——排队 wake 归 476 rearm）。
2. **恢复**：重启后扫描 marker → 对每个 marker 向对应 session 发**隐藏 wake run**（复用 476 投递路径 / cron 的 `runPromptInSession`）：
   - source=user → prompt：告知"上一回合在宿主重启时被打断，请基于已有进展继续或收尾"（hidden，产出仍走 SendMessage）；
   - source=automation → 携带 automationRunId，续跑原任务（对齐 grok 的 markAgentResumePending(source=automation)）；
   - source=background-revival → 静默续跑（QUIET_REVIVAL 语义，无新结果即静默结束，复用 476 quiet-work）。
3. **清理**：resume 完成或超时（48h）→ 清 marker（对齐 476 P3 pruneStale 同节奏）。

**box-handoff 等价项（可选并入）**：duya 的"run 在等待用户处理审批卡/secret 卡时被中断"——marker source='interrupted' + 卡状态（483 落地时若需要可追加）。**本 plan 只做 run 中断 resume 骨架，卡状态恢复归 483 卡闭环。**

### 2.3 与 476/441 的接线

- 484 消费 476 的投递通道（`runPromptInSession` + lane）与 quiet 语义；**不新开 IPC**。
- ack redrive run 与 476 background lane 走同一队列——**不加队头**（低优先级、防打扰）。
- 441 journal 事件已覆盖消息层；484 marker 落盘用同一 `.part`+rename 原子写约定（或 SQLite 事务）。

## 3. 分阶段实施

### Phase 1 — ack 义务
- [ ] **P1.1** `ack_obligations` 表 + store（upsert/结算/fulfill/lost/清理）+ 单测。
- [ ] **P1.2** 登记 + run 结束结算纯函数（sendCount/reactCount/epoch 判定）+ 单测（含 supersede 不 fulfill 用例）。
- [ ] **P1.3** redrive 调度（5s idle、≤3 次、ackRunToken mint/校验）+ 单测。

### Phase 2 — run 级中断续跑
- [ ] **P2.1** `RunResumeMarker` 落盘/读取/清理 + 单测（原子写）。
- [ ] **P2.2** quiesce 接线（shutdown 链路 + 在跑 run 宽限 + marker 落盘）。
- [ ] **P2.3** 重启 resume（按 source 组装 hidden prompt：user/automation/background-revival）+ 单测。
- [ ] **P2.4** 与 476 rearm 的边界验证（排队 wake 归 476，在跑 run 归 484，无重叠无遗漏）。

### Phase 3 — 收口
- [ ] **G1** 集成 e2e：① 模拟 bot run 空回复 → 5s 后 redrive → 收到可见回复；3 次仍空 → lost 标记；② 宿主升级中断 user run → 重启后 hidden run 续跑并产出；③ automation run 中断 → 重启后按 runId 续跑。
- [ ] **G2** `npm run typecheck:all` + 相关单测全绿；ARCHITECTURE.md 增补"ack 义务 + run 恢复"小节。

## 4. 非目标

- 不做 476 的 pending_wakes rearm（本 plan 边界：在跑 run vs 排队 wake）。
- 不做 483 的卡状态恢复（只做 run 中断 resume 骨架）。
- 不做 UI 层的"重试/继续"按钮（后续 483 或专项；ack lost 只走通知）。
- 不做云端/跨设备续跑。

## 5. 风险

- **redrive 反复打扰用户**：idle 5s + 最多 3 次 + background lane 低优先级 + quiet 语义；超限即 lost 停手。
- **重启风暴误 resume**：marker 只落"确实在跑"的 run（quiesce 时逐个核对），48h prune + runId 幂等双保险。
- **与 476 rearm 职责重叠**：§2.3 边界明示 + P2.4 专项验证，避免同一 run 被 rearm + resume 双唤醒。
- **回滚**：`ack_obligations`/marker 均为新增表/文件，开关关停即可退回现状（无兜底，同今天行为）。

---

## 6. 完整性审计定位（2026-09-02）

本 plan 源自 473 系列完整性审计：grok-bot host 侧 13 功能簇中 C4（ack 义务）与 C6（断点交接/升级恢复）为**完全空白**项，与"bot 静默丢回复、宿主升级丢回合"两个可靠性底线直接相关，故单独立项。审计全量矩阵见 473 §9（若已登记）。
