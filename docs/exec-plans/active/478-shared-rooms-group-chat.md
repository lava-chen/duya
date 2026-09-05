# 478 — Shared Rooms 群聊（Group 模型 + 轮次编排 + @Mention + 群 Transcript）

> **Status**: Planning · **Priority**: P1 · **Owner**: TBD
> **总纲**: [473-grok-bot-framework-overview](./473-grok-bot-framework-overview.md)
> **前置**: plan 476（Wake Bus）、477（DM 与 per-bot 常驻绑定）
> **参考源码**：grok-bot `source/host/groups/`（group-store.ts、group-chat.ts）、`source/host/extensions/transcript/shared-rooms.ts`
>
> **目标**：实现多 bot 群聊（共享房间）：若干 bot（≤6）+ 用户在同一房间讨论；bot 发言权由**轮次编排器**控制（不是自由抢话），支持 @mention 定向唤醒与 `(pass)` 沉默；群消息驱动成员依次 wake。**这是通讯系列工作量最大的一块，放最后做。**

---

## 1. grok 机制精读（移植蓝本）

| 机制 | grok 实现 | 移植要点 |
|---|---|---|
| 群定义 | `SandGroupConfig{memberIds(≤6), remoteMembers?, sharedRoomId?}`（group-store.ts 持久化 group.json） | duya 用 `~/.duya/config.toml` `[groups.<id>]` 或独立 `groups.toml`（**仅配置侧**，不另起 session） |
| 发言权 | **轮次编排**：`GROUP_MAX_ROUNDS=3`、`GROUP_MAX_MEMBER_TURNS=10`、每轮 `orderRoundSpeakers` 轮转、`(pass)` 表示沉默（group-chat.ts） | 核心纯函数，重点单测 |
| @mention | `memberMentionHandles` 支持按 handle 定向唤醒成员 | handle = agent id 或 toml 别名 |
| 群消息驱动 | `shared-rooms.ts:51-114` `postToGroup` → `runGroupTurn`：成员按轮次被依次唤醒为 group-member runner；automation 也能给群播种（automation-run-path.ts:68-107） | 群 turn 编排跑在 agent-server 侧，复用 cron 的 HTTP chat 链路模式 |
| 群 transcript | 共享房间消息流独立于成员私有会话 | duya **复用 MessageLog** + `group_id` 列（plan 2026-08-31 §6.3 envelope 字段复用）|

## 2. 设计

### 2.1 群模型 — **2026-09-02 修正：复用 MessageLog + group_id 列，不起 group_room_messages 独立表**

> 修正理由与 plan 2026-08-31 §6 一致（envelope 折进 transcript）：duya MessageLog（plan 333/441）已是 session transcript 唯一来源，再起 `group_room_messages` 表会让群消息落两处（mailbox envelope + 群表），且与 DM envelope 字段（plan 2026-08-31 §6.3 / 477 §2.1.1）的存储模型分裂。**决定**：群 transcript = MessageLog 同一张表，加 `group_id` 列区分；群 room 本身仅作"逻辑房间"——成员列表 / 编排配置（`groups.toml`）落在 config 侧，不为群另起 session。

```toml
# ~/.duya/groups.toml
[groups.<id>]
name = "产品讨论组"
members = ["frontend-expert", "backend-expert", "reviewer"]   # ≤6，引用 [agents.*]
max_rounds = 3
max_member_turns = 10
```

- **群消息落点**：`MessageLog` 同一表，通过 `group_id` 列区分（plan 2026-08-31 §7.3 migration `NNN_add_envelope_indexes_to_message_index` 一并加列）。
- **群 entry envelope schema**（复用 plan 2026-08-31 §6.3 字段）：
  - 真人/用户在群内发言：`{role:'user', groupId, fromUser:{name, avatarUrl?}, ...}`
  - bot 在群内发言：`{role:'assistant', groupId, toAgent:{id, name, kind:'group'}, ...}`
- **成员私有会话与群隔离**：bot 在群里"听到的"只有群 transcript 注入（plan 408b runtime-context-adapters 注入群 transcript 尾部窗口），不泄露私有会话内容。
- **侧栏入口**（483）：群作为 `meta.toAgentId = 'group:<roomId>'` 的 partner 行 — `mailbox.queryBotPartners(sessionId)` GROUP BY 自动把群 turn 算入同一 partner 列表（plan 2026-08-31 §6.5 B / 477 §2.6 投影修正）。**群 turn 落 mailbox 即可**（`meta.toAgentId='group:<roomId>'`），不需要额外 upsert。

### 2.2 轮次编排器（纯函数 `packages/agent/src/wake/groupTurn.ts`）

- 输入：群配置 + 当前 transcript 增量 + 触发者。
- 输出：本轮发言计划 `[{agentId, round}]`。
- 规则（对齐 grok）：
  1. @mention 的成员优先进入下一轮；未提及成员由编排器决定是否轮转参与。
  2. 每轮 `orderRoundSpeakers` 轮转排序；成员可回 `(pass)` 沉默（连续 2 次 pass 的成员本轮后续轮跳过）。
  3. 硬上限：`max_rounds` / `max_member_turns` 到达即强制收束（注入收束指令：请给结论）。
- 每个成员 turn = 该成员 bot 的一次 wake run（476 的 agent lane），prompt = 群 transcript 尾部窗口 + 群规则 + 个人视角指令。

### 2.3 群 turn 执行链

```
触发（用户发言 / bot postToGroup / automation 播种 / connector inbound）
  → 编排器产出发言计划
  → 逐成员：enqueueExclusiveRun（group-member runner，hidden wake）
  → 成员群内发言（专用 PostToRoom 工具，唯一发言通道）写群 transcript
  → 编排器根据 (pass)/上限决定继续或收束
  → 群摘要（可选）经 DM/通知告知用户
```

- 群预算：每群 turn 总 token 预算（ConfigStore `[groups].budget`），超限即收束——对应 473 风险项。
- 群内防乒乓：PostToRoom 只进群 transcript，不触发对方私有会话；成员互 DM 才走 477。

### 2.4 用户在群里的位置

- 用户消息进群 transcript，优先级高于任何轮次（等效 476 user lane）。
- 用户可随时打断群 turn（interrupt + 剩余发言计划作废）。

## 3. 分阶段实施

### Phase 1 — 模型与编排器
- [ ] **P1.1** groups.toml schema + 读写 + 校验（成员存在、≤6）+ 单测。
- [ ] **P1.2** MessageLog `group_id` 列 + envelope 群字段（`fromUser/toAgent.kind:'group'`）扩展（**复用 plan 2026-08-31 §7.3 同名 migration，不另起 `group_room_messages` 表**）+ core-db store 群 query API + 单测。
- [ ] **P1.3** 轮次编排器纯函数（mention 优先/轮转/pass/上限/预算）+ 单测（重点覆盖 grok 对齐用例）。

### Phase 2 — 执行链
- [ ] **P2.1** group-member runner（hidden wake，群 transcript 窗口注入）+ PostToRoom 工具。
- [ ] **P2.2** `runGroupTurn` 编排循环（逐成员执行、收束、预算熔断）+ e2e（2 bot + 用户三方对话）。
- [ ] **P2.3** automation 群播种（cron 可定向群房间）。

### Phase 3 — UI 与收口
- [ ] **P3.1** 前端群房间视图（房间列表 + 群流 + 成员状态：等待发言/发言中/pass）。
- [ ] **P3.2** 群管理 UI（建群/改成员/预算）。
- [ ] **G1** `npm run typecheck:all` 全绿；e2e：3 bot 群完成受控轮转讨论并正确收束；用户打断生效。

## 4. 非目标

- remoteMembers（跨设备成员）。
- 群内富媒体协作（canvas/文件共享）后续另立项。
- 语音房间。

## 5. 风险

- **token 成本失控**：轮次上限 + 群预算熔断 + pass 机制三重控制；默认 max_rounds=3。
- **编排死循环**：所有成员 pass → 立即收束并通知用户，不允许空转轮。
- **群/私上下文串扰**：群 wake prompt 只注入群 transcript 窗口，成员私有记忆不自动带入（可显式让 bot 自查）。
- **顺序执行延迟**：逐成员串行 wake 可能耗时 → 单轮并发视 worker-limits 余量决定（先串行，性能问题再优化）。

---

## 6. 可行性审计修正（2026-09-02 逐行核实代码后）

1. **并发上限不是约束，冷启动才是**。证据：worker 上限 `min(floor(CPU/2), memCap(<8GB→2、<16GB→4、否则16), 16)`（`worker-limits.ts:42-55`）；worker **每 session 一个、按需 fork 并复用**（`worker-manager.ts:71-98`），空闲 10 分钟回收（`worker-limits.ts:80,112-121`）。串行编排时并发峰值恒为 1，不触上限；真实成本是成员 worker 已被回收时每次 wake 吃一次 fork + 冷启动。**修正**：原风险项"视余量决定并发"收窄为——**固定串行**，并给群成员 session 打 keepAlive（复用 `worker-manager.ts:414,419` 的豁免机制）以消除冷启动抖动。
2. **单 run 互斥的真实机制**：由 agent-server 的 STREAMING 状态机保证（`router.ts:331-343` 冲突返回 409），**不是** `session_runtime_locks`（该表无任何生产 acquire 调用）。编排器在 main 侧判断"成员这一轮是否结束"要靠 HTTP 状态或（接线后的）锁，**不能直读 agent-server 进程内存**（agent-server 是独立 fork）。此点与 476 §6.2 的空闲判定共用同一解法，两 plan 必须同期决策。
3. **编排器位置明确**：`runGroupTurn` 住 electron main（与 476 WakeQueue 同侧），用 cron 式 HTTP 投递逐成员 wake；成员发言经 `PostToRoom` 工具写群 transcript（`group_room_messages`）。
4. **成本模型补充**：群 turn 预算必须同时限 ① 轮数与发言数（max_rounds/max_member_turns）② 总 token ③ **worker 冷启动次数**（keepAlive 命中率）。三者缺一不可，否则 6 人群聊在 worker 反复回收时体验劣化。
