# Plan 571 — mailbox 投递回执（at-most-once / at-least-once 分级 + 双通道去重）

状态：In Progress（2026-09-26；Phase 1-4 完成 + 测试全绿；Phase 5 面板文案裁定为无需新增——渲染层当前无 applied_summary 消费者；真机验证 §8.3/8.4 待办）
前置调研：`.workbuddy/reports/notification-injection-investigation-2026-09-26.md`
关联：plan 202（mailbox 状态机）、plan 476（wake bus）、plan 569/570（先行落地）
对照实现：minimax-code `packages/local-runtime-v2/src/service/steer-session.service.ts:65-83,124-139,153-158`（先 reserve 回执后投递、失败补偿 release、跨重启去重）；`conversation-delivery.ts:66-86`（producer 确定性 idempotencyKey）

---

## 1. 一句话目标

给 mailbox 行增加持久化「已注入回执」（reserve-first），使系统通知在 claim→apply 崩溃窗口内**不重复注入**（at-most-once），用户内容维持**宁重复不丢失**（at-least-once），并消灭 `wake.idleDispatch='main'` 下 run 内 claim 与 dispatcher wake run 的双通道重复投递——直接对应用户报告的「同一通知重复插入 → 上下文污染 → 能力下降」。

## 2. 实证基线（2026-09-26 核对）

| # | 断言 | 证据 |
|---|---|---|
| F1 | 行级幂等已有：`uq_mailbox_client_msg` 唯一索引 + enqueue 幂等 → 同一 taskId 的行不会写两次 | `electron/db/core/mailbox.ts:247-249` |
| F2 | claim 是 CAS：`status='pending' OR (observed AND claim_expires_at < now)`，重领时 `claim_attempts+1` | `mailbox.ts:586-589, 654-686` |
| F3 | **重复注入窗口**：claim（observed，lease 30s）→ 进程崩溃/IPC 断 → lease 过期 → 行重回可领 → 下一 run 再 claim 再注入。无「已注入过」的持久标记 | `mailbox.ts:190, 588, 665`；`MailboxItem` 接口无 delivered 类字段（`:50-79`） |
| F4 | claim 失败上限：`DEFAULT_MAX_CLAIM_ATTEMPTS=5`，超限自动 cancel（`system:max_claim_attempts`） | `mailbox.ts:193, 599-611, 640-651` |
| F5 | `dedupeRuntimeContextMessages` 只去重 durable timeline 的重载投影，transient 注入不经过它 | `runtime-context-adapters.ts:421`；`DuyaAgent._claimMailboxAtCheckpoint` 直推 messages |
| F6 | 双通道：`wake.idleDispatch='main'` 时，`maybeDispatchIdleWake` 收到 `mail:created` 即入 WakeQueue，不检查行是否已被 run 内 claim；dispatcher 的 wake prompt 是**有损摘要**（剥掉 XML 信封） | `electron/wake/idle-dispatcher.ts:50-89`、`mailbox-store.ts:409-415`（renderer 模式的 stand-down 仅是配置分流） |
| F7 | core-db 迁移收集点 `collectMigrations()`（16 个 store 聚合），当前最大迁移 id = 32（workflow-store） | `electron/db/core-connection.ts:116-134`；实现时以实际最大 id+1 为准（本计划写作时 = 33） |
| F8 | renderer 侧已有快速路径守卫（2026-09-26）：`resumeBackgroundTask` 开 run 前查 pending 行 | `src/lib/stream-session-manager.ts:1326-1352` |

## 3. Scope

### In

| 项 | 说明 |
|---|---|
| `mailbox_items` 增加 `injected_run_id` 列 | 持久回执载体（migration 33） |
| claimBatch reserve-first | background_notification 行 claim 时同步写回执；重领时已 reserve 的行 skip 并收尾为 applied |
| 分级投递语义 | 通知 = at-most-once；followup/queued（用户内容）= at-least-once（现状不动） |
| main 模式双通道守卫 | dispatcher 入队 WakeItem 前检查行状态，已 claim/applied 则不开 wake run |
| 测试 | crash 模拟（claim 后不 apply → 重领 skip）、双通道竞速 |

### Out（不做，含理由）

| 项 | 理由 |
|---|---|
| followup/queued 的回执 | 用户内容重复的代价（丢消息）高于重复；minimax-code 同款取舍（「duplicate on the fallback lane, never a lost user message」）。现状 at-least-once 保留 |
| 独立的 delivery_receipts 表 | 一列即可表达 reserve 语义；新表引入 join 与两份真相（工作记忆明确警示：新表前确认没有既存载体） |
| producer 侧 idempotencyKey 哈希（批量 sha256 等） | duya 的行级幂等（F1 唯一索引 + clientMsgId=taskId）已覆盖 producer 重试；minimax-code 的批量键解决的是它自己的批量投递形态，duya 无此形态 |
| renderer `pendingBackgroundResumes` 守卫下线 | 回执是权威，renderer 检查是零成本的快速路径（省一次无谓的 run 启动）；两者互补不冲突 |
| bot lane（wake-dispatcher 主链路）改动 | bot 侧已有 60s 去重窗口 + item.id 合并 + watchdog，重复问题集中在 session 侧 |

## 4. 设计决策

### D1 — 回执 = 一列 `injected_run_id TEXT NULL`，reserve-first

**写入时机（reserve）**：`claimBatch` 的 CAS UPDATE（`mailbox.ts:655-680`）中，对 `kind='background_notification'` 的候选行追加 `injected_run_id = @runId`（与 status/claim_token 同事务写入）。语义：**claim 即视为投递意图确立**。

**重领检查（skip）**：claimBatch 锚点/候选查询发现某行 `status='observed' AND claim_expires_at < now`（过期重领候选）且 `injected_run_id IS NOT NULL AND injected_run_id != @runId` → 不再注入：直接 UPDATE 为 `applied`（`applied_summary='receipt:reserved-by-earlier-run-crash'`，`applied_at_checkpoint=本次 checkpoint`），该行移出本次 claim 结果。

**正常收尾**：apply（`mailbox.ts:701-734`）照旧把行置 applied；`injected_run_id` 保留作为审计字段（哪条 run 注入的）。

为什么一列够：状态机里 `applied` 本来就是「投递完成」终态；缺的只是「claim 过但没 apply 完成」时的判定依据。`injected_run_id` 非空 = 曾被某 run 认领投递 → 重领时 skip，即 at-most-once。不需要 'reserved'/'delivered' 两态——crash 后我们**不需要恢复投递**（通知宁可丢不可重），所以不需要补偿 release。

**备选与裁定**：
- *备选 A*：完整 reserve/补偿（minimax-code 原样：reserve → 投递 → confirm，失败补偿 release）。否——那是为**用户消息**（at-least-once 且要精确 turn 绑定）设计的；通知场景补偿逻辑是死代码。
- *备选 B*：不落库，进程内 Set 记已注入 taskId。否——crash 后内存蒸发，恰好看不到的那个窗口才是要修的。

### D2 — 分级语义落点

| kind | 注入保证 | 机制 |
|---|---|---|
| `background_notification` | at-most-once | `injected_run_id` reserve-first（D1） |
| `followup` / `queued` | at-least-once（宁重复不丢） | 现状：无回执，lease 过期重投 |
| `agent_dm` | 不经 claim（现状） | 不变 |

`claimBatch` 的 skip 逻辑按 kind 条件执行（SQL 加 `AND kind = 'background_notification'` 或在事务内分支），用户行完全不受影响。

### D3 — main 模式双通道守卫

`idle-dispatcher.ts` 的 `maybeDispatchIdleWake`（`:63-89`）在入 WakeQueue 前查行状态：

- 行 `status='pending'` → 维持现状入队（尽快 wake）；
- 行 `status='observed'`（已被某 run claim，569 的 final poll / 下一 checkpoint 会处理）→ **不入队**，只登记一个延迟复查（如 10s 后重查：observed 持续且未 applied → lease 过期孤儿，此时才入队；applied → 放弃）；
- 行 `status='applied'/'cancelled'` → 不入队。

与 569 的关系：final poll absorb 竞速中 claim 原子性（F2）保证只有一方拿到行；本守卫把 dispatcher 从「必然双投」改为「让位 + 孤儿兜底」。

**备选与裁定**：
- *备选*：main 模式完全不走 run 内 claim（dispatcher 独占）。否——改动波及 agent loop 主干，且 569 的收益（同 run 及时吸收）会被作废。

### D4 — 与既有守卫的分工（三层防线）

1. renderer pending 查重（F8，已有）：零成本拦截 99% 的重复 resume；
2. `injected_run_id` 回执（本计划）：权威的 at-most-once，覆盖 crash 窗口；
3. dispatcher 延迟复查（D3）：main 模式双通道收口。

## 5. DDL / 契约

```sql
-- migration 33（实现时以 collectMigrations 实际最大 id+1 为准；收集点 core-connection.ts:116-134）
ALTER TABLE mailbox_items ADD COLUMN injected_run_id TEXT;
-- 无索引需求：重领查询按主键定位，不按 injected_run_id 检索
```

类型同步：
- `MailboxItem`（`mailbox.ts:50-79`）加 `injectedRunId: string | null`；
- IPC 行映射 `coreMailboxToIpcRow`（`electron/agents/db-bridge.ts`）与 `dbRowToMailboxRow`（`src/stores/mailbox-store.ts`）透传该字段（渲染层不消费，仅审计可读）；
- `packages/agent/src/session/db.ts:2492` 侧 MailboxKind 不变（行结构字段按需透传）。

apply 矩阵（`mailbox.ts:135-170`）不变——skip 收尾用的 `applied` 状态与现有 checkpoint:mode 组合兼容（收尾 UPDATE 不走 apply 校验，直接 SQL 置 applied，与 max_claim_attempts 的 cancel 写法同型，`:601-609`）。

## 6. UI 规格

无新 UI。mailbox 面板行详情（若展示 applied_summary）会出现 `receipt:reserved-by-earlier-run-crash` 文案——补充一条 i18n/面板文案映射，归入「系统收尾」类，不作为用户可操作状态。

## 7. Phases

- [x] **Phase 1 — 列 + 类型**：migration 33 + `MailboxItem.injectedRunId` + IPC/row 映射透传。✅ 2026-09-26（migration 落 `Mailbox.migrations` id=33 带幂等守卫；IPC 映射在 `electron/ipc/core-db-adapters.ts` 的 `coreMailboxToIpcRow`（plan 写作时误记为 db-bridge.ts，实际定义在此）；renderer `mailbox-store.ts` MailboxRow 透传；agent 侧 `session/db.ts` MailboxRow 透传。`mailbox.test.ts` 90/90 绿 + agent typecheck 除既有 DuyaAgent.ts 并行改动错误外 0 新增）

- [x] **Phase 2 — claimBatch reserve + skip**：CAS UPDATE 写回执；重领 skip 收尾。✅ 2026-09-26（测试 4 条：crash 模拟 skip+receipt summary、followup 仍重领（at-least-once 锁定）、同 runId 重入放行、pending claim 写回执；全绿）

- [x] **Phase 3 — agent 侧回归**：plan315/plan486/nestedInjection 定向复跑。✅ 2026-09-26（nestedInjection 2/2 + plan315 的 mailbox claim 用例绿；plan315/486 各有 2 条失败，经回退本计划 agent 侧改动复跑确认与本计划无关——由并行会话 DuyaAgent.ts 未提交改动引入，plan571 agent 侧改动为纯类型透传）

- [x] **Phase 4 — dispatcher 双通道守卫**：✅ 2026-09-26（`idle-dispatcher.ts`：入队前读行状态——pending/读不到 fail-open 入队；observed 收 stand-down + 10s 一次性复查（applied/仍持有效 lease → 放弃，lease 过期孤儿 → 兜底入队）；applied/cancelled 不入队。deps 注入 seam `_setIdleDispatcherDeps`（默认 core-store 读取）；idle-dispatcher.test.ts 17/17，wake 全目录 94/94 绿；electron tsc 0 新增错误）

- [x] **Phase 5 — 面板文案 + README**：裁定——渲染层（MailboxPanel/MailboxBubble）当前不展示 applied_summary，无消费者，无需新增映射；receipt 标记仅存审计字段。README 表格已更新。

## 8. Verification（编号断言）

1. crash 模拟（测试 + 真机 dev 库）：通知行被 run A claim 后进程被杀 → run B 重领 → **不重复注入**，DB 中该行 applied 且 `injected_run_id = runA`（**存在理由**：本列不存在则本计划无意义）。
2. 用户行（followup）crash 后重投成功（at-least-once 保持，测试断言）。
3. main 模式真机：后台任务完成 → run 内 claim 吸收 → dispatcher 日志显示「observed, defer wake」且 10s 后行 applied → 不开 wake run、无第二份摘要 prompt。
4. renderer 模式真机：同一通知全链路只出现一次模型调用增量（对照 `run-log.ts` 文本日志的 journal 投影，工作记忆：`~/.duya/workflow-logs` 仅 workflow；session 用 dev 工具看 provider messages）。
5. 迁移幂等：旧库升级路径（migration 33 只 ADD COLUMN 一次）+ 全新库直建。

## 9. 依赖与风险

| 依赖/风险 | 说明与缓解 |
|---|---|
| 依赖 569/570 先后落地（可选） | 回执独立于两者成立；但 570 收窄后 exit claim 集合更小，双通道竞速面也缩小——顺序 569 → 570 → 571 冲突最小 |
| mailbox.ts / db-bridge.ts 为多会话共处文件 | 只 add 本计划路径；`git diff --numstat` 复核；行尾混合仓库，改前 `git cat-file blob HEAD:<path> | tr -dc '\r' | wc -c` 对比 |
| at-most-once 的丢失窗口 | crash 在 claim 后 → 该通知永久丢失。量化：仅进程崩溃场景；通知丢一条的代价 ≪ 重复注入对上下文的污染（用户报告的能力下降）。文案上不做用户可见提示（Out） |
| better-sqlite3 ABI | vitest 用 Node22(127)、electron 用 119（工作记忆）；mailbox.test.ts 跑法先看既有 suite 的 runner 配置 |
| 10s 孤儿复查的时序 | 复查用一次性 timer（不入 WakeQueue 主链），失败即放弃（下一条通知或用户输入会再触发收敛）；不引入重试循环 |

## 10. 待裁定

1. crash-skip 的通知要不要在 mailbox 面板给用户一个「已跳过（系统收尾）」的可见标记？（默认：仅 applied_summary 审计字段，不加 UI）
2. `injected_run_id` 是否未来要推广到 followup（可切换 at-most-once 档）？（默认：不做，列语义留白即可）
