# R1 — Run 结果、事件与存储正确性

前置：G0。目标：result可信，不因读取或未完成写入制造终态。Next：**无——R1 已完成**（#168 自评 "closes phase R1"）。完整验收前不扩展能力。
>
> **阶段状态（2026-10-04 对 `55384c55` 核对）**：R1.1–R1.4 全部合并，**Done**。#147（R1.1）、#149（R1.2）、#162（R1.3）、#168（R1.4）。原始证据在 `.tmp-validation/587-r1-2-fix/`。

> **R1.1 与 R1.2 已完成**（PR #147、#149）。R1.3（ack/CAS/幂等与生产ledger）与 R1.4（结果与生产ledger）**也已合并**（#162、#168）——本段是 G0/G0.1 时期的记录，两条子标题下的勾选已按 #162/#168 补齐。原始证据在 `.tmp-validation/587-r1-2-fix/`。
> R1.1 让 `run-session.ts` **先决定、等 durable barrier、再发布**：公共终态与 `result()` 不再越过持久化屏障，`persistence.complete` 被拒时降级为 `{status:'failed', error:{code:'persistence_failed'}}` 而非 reject（因为 `RunHandle.terminal` 是 `Promise<RunTerminalState>`，reject 会让只 await 成功分支的 host 变成 unhandled rejection）。`controller.ts` 穿入 `manifest.budget` 并拆掉硬编码的 `{status:'completed'}`；`run-orchestrator.ts` 校验 `{ok, applied}`。`RunLedger` 从 `agent-protocol/src/testing/` 搬到生产入口。
> R1.2 每 run 一条串行写队列（含 `observe()` 那个 fire-and-forget flush 的静默丢数据路径）、有界重试；terminal 决策与提交 Promise 分离，重复 settle/result 共享同一 Promise；**只选一种实现**——append 确认后再 complete，因为事务形式是 adapter 的属性，选它会让内存测试 adapter 与 Desktop SQLite adapter 按不同规则提交终态，而 R1.2 明令禁止这种分歧；崩溃时前者至少留下已决定的终态可供对账，回滚的事务只留一行 `running`。durable `started` 确认后才 dispatch；每种异常退出都有明确终态；late frame 被拒并清理 controller/session map/timer/subscription；cancel race 走单一 arbiter。
> **R1.2 有意未做**：重试无退避（需要注入时钟，属 R1.3 的 retry 策略）；仅 `complete` 自身失败时行仍停在 `running`，属 R1.3 的 DB 故障状态。

## 文件范围

`packages/agent-runtime/src/{controller,run-session}.ts`、`transport/execution-channel.ts`、Desktop `agents/server/run-orchestrator.ts`、`control-plane/run-control-plane.ts`、`db/core/run-store.ts`及其现有tests。新类型需公开正常入口，不能从protocol/testing导入生产ledger。

## R1.1 固定四个失败接缝

> 已完成，PR #147（修复）与 `58ef5c58`（测试，来自 `c824c771`）。8个测试在修复前真实失败，修复后连同既有测试共 30/30；全量对比 0 个测试被打破。

- [x] manifest maxTurns=1，executor仍活跃：会触发预算判定，不再无条件completed。
  `controller.ts:198` 穿入 `manifest.budget`；`RunSession.#budgetVerdict` 不再恒 false。修复前 `failed`，修复后 `budget_exhausted`。
- [x] executor未结束时调用result，Promise保持pending，executor没有被settle/stop副作用。
  `run-session.ts:335` 只 await 终态 Promise，绝不 settle。修复前会 settle **并写一行**，修复后只读、保持 pending。
- [x] append延迟未ack时settle，不得先complete或resolvepublicterminal；append失败同样不能返回成功。
  `run-session.ts:243,254` 改为决定 → flush → `complete` → 发布；`:394` `degradedTerminal()` 把被拒的 append 降级为 `failed`/`persistence_failed`。修复前提前发布 `completed`。
- [x] append/complete返回negativeack、CAS未applied或抛错，明确错误/降级receipt，不能被await吞掉。
  `run-orchestrator.ts:155,168,346` 逐项校验 `ok`/`applied`；`:119` 报告抛错的通道。Control Plane 侧的诚实报告与真实 CAS 本来就在（`run-control-plane.ts:115,141,147`、`run-store.ts:249`），被丢的是 adapter 里的回复。

原评审的隔离探针仅是2026-10-03历史证据；先核对最新源码和已有修复，以新增必要测试接管，不重复改已修代码。
测绘阶段的地图有4处被后续测试纠正：接缝4的"抛错"子情形**并未**被吞（丢的是 ack 形状的静默）；接缝1的可观测结果是 `failed`/`runtime_crash` 而非 `completed`；`result()` 还有第四个副作用（写 `session.terminal`）；`controller.ts:311`/`:327` 在修复后是**死代码**（`settle()` 变成 `Promise<RunTerminalState>` 后无人能再推导并凭空造出终态），且 `cancel()` 里还有**第四处**硬编码 `completed`。

## R1.2 持久化序列与生命周期

> 已完成，PR #149。新增测试在修复前 **15 failed / 4 passed**，修复后 20/20；连同 R1.1 三个文件共 58/58。collect 1011→1011 文件（+25 测试，无下降）。两个全量新增失败经按**测试名**比对证伪：`RealTasks` 的并发读顺序断言在**没有本分支代码的 base commit 上同样失败**，`bash-taskStore` 是 liveness 探针把 `pid: process.pid` 的任务误判为已死。

- [x] 每run保存串行writequeue/in-flightPromise；flush等待之前batch和当前batch。失败batch不先永久丢弃，采用有界retry或failclosed/degraded，不无限积压。
  `run-session.ts:196` `#queue`、`:468` `#drain`、`:212` `#lostBatch`。测试断言"首次被拒的 batch 最终落地"、"有界放弃（恰好3次投递）"、"不留未发送事件"、"找回被 fire-and-forget flush 丢掉的 batch"。
- [x] terminaldecision与commitPromise分离；重复settle/result共享Promise。terminal事件先append确认再complete，或在同SQLitetransaction写terminalevent+CAS；两种实现选一种说明，禁止跨adapter暗自不同。
  **选了 append 确认后再 complete**（唯一实现，`RunPersistence` 保持两个方法，adapter 无法选另一种）。理由：事务形式是 adapter 的属性，选它会让内存测试 adapter 与 Desktop SQLite adapter 按不同规则提交终态，正是本条禁止的分歧；崩溃时 append-then-complete 至少在日志里留下已决定的终态可供对账，回滚的事务只留一行 `running` 和"它怎么结束的"的零线索。
- [x] 新run durable started确认后才dispatch；失败返回start_failed，不让实际executor悄悄运行。
  `controller.ts:125` `RunStartError`、`:330-350`。测试断言"started 事件存不下时不 dispatch executor"且"不留活着的 run"。
- [x] executor结束无done/error、dispatch同步throw、进程断开均产生明确terminal；不要用“未知run默认completed”掩盖缺记录。
  `run-session.ts:424`、`controller.ts:391` `#failStart`，以及 orchestrator 的断连测试。
- [x] lateframe terminal后拒绝或diagnostic；清理controller/sessionmap、timer、subscription，保留按契约可查询的resultreceipt。
  `controller.ts:437-460,550`；`run-orchestrator.ts:385-431`。测试区分"终态后的帧"与"从未存在的 run 的帧"，并断言 receipt 数量有界。
- [x] cancellationrace共用00合同arbiter；本阶段不另造workerstop路径。
  `controller.ts:578`。测试断言 stop 窗口内落 done 时"只决定一次"（一行终态、一个终态事件、恰好1次 stop），且如实报告 `applied:false` 及 run 实际到达的终态。

**顺带修掉一个既有缺陷**：router 的 `res.on('close')` 兜底会在终态写入仍在飞行时返回；`settleSession` 现在会等在飞的 settle。

**`architecture-policy.yaml` 35→36**：新测试文件在 managed 模块下 import `@duya/agent-protocol`，多出一条 permitted 边。属**测量值**而非门禁放松——`module-dependency-permitted` 在 `MEASUREMENT_RULES` 里从不阻断，而 `module-dependency` 保持 547 不动，即没有边从 permitted 变成 not-permitted，零容忍未被触碰。`.architecture-baseline.json` 未动，`--write` 未跑。

## R1.3 Ack、CAS 与幂等

> 已完成，PR #162（`fe18abb5`）。5 项全部 done。

- [x] dbRequest adapter逐项验证ok/payload/applied；统一typedreceipt，跨IPC服务不throw的结果不能当成功。
  `control-plane/run-receipt.ts:84,295` + `run-control-plane.ts:56` + `run-orchestrator.ts:285,304`；`run-receipt-contract.test.ts`（17），含"degrades a run whose `run:complete` reply cannot be read"。
- [x] 相同runId+manifest/inputhash复用；不同内容拒绝，活跃map不被覆盖。
  `run-store.ts:120,282,564` + migration 37 `:215`；`run-store-idempotency.test.ts`（6），含"refuses a second run for a session that already has a live one"。
- [x] event相同(run,seq)payload重试幂等；不同payload拒绝。`INSERT OR IGNORE`不应隐藏内容冲突。
  **#162 证明这条此前是错的**：`run-store.ts:207` 用 `INSERT OR IGNORE` + `written += changes`，于是重投与**内容矛盾**同样报 `0`，`run:append` 回 `{ok:true, written}`——不同内容重试看起来是干净成功。改为 `ON CONFLICT DO NOTHING` 加 `envelope_json` 读回比较（**绝不**比较 `created_at`），抛 `RunEventConflictError` 并回滚整批。测试"REFUSES the same `(run, seq)` carrying different content"**在 master 上失败**、修复后通过。
- [x] terminalCAS失败读取已提交terminal验证一致；不一致返回conflict，不覆盖。
  `run-store.ts:137,413` + `run-control-plane.ts:206`；"reports `reconciled` when another writer committed the SAME terminal"。
- [x] SQLtransaction失败、busy、worker退出时的state明确。聊天fallback仅保留显式观察层降级，durablerun不返回虚假成功。
  `run-receipt.ts:56,235` + `run-control-plane.ts:98,168`；`classifySqlFailure`；"an unaccepted start dispatches nothing"（5 个 case）。

## R1.4 结果与生产 ledger

> 已完成，PR #168（`4b195fe0`）。自评 "closes phase R1"。

- [x] RunLedger/lifecycle状态归core或runtime生产入口；testing只留fixture/断言。
  `agent-runtime/src/run-ledger.ts` + `src/index.ts:48` + `src/testing/index.ts:24`——**R1.1 已完成**（#147 把 `RunLedger`/`LifecycleViolation` 移出 `/testing` 子路径），`lifecycle-invariants.test.ts`（26）为既有守卫。
- [x] result的transcript/permissionAudit依当前能力返回真实引用/读回；若暂不支持，capability明确unsupported，不能用空数组表示没有发生。
  `RunSurface`（`agent-protocol/src/run.ts:134`）+ `run-session.ts:748`；`run-result-surface.test.ts:189` 断言 transcript 为 `unsupported` 时 `Array.isArray(...)` 为 false。**判据是 run 里的证据，不是标志位**：没问过 → `read`；问了并回答 → `read`；**问了但没人答** → `unsupported`（runtime 里根本没有 `permission.resolved` 发射者，恒 `read` 的审计会是一层更深的谎）。
- [x] budget传入session，usage字段缺失标unknown；运行期stop在R2实现。本阶段测试不得只改最终标签假称预算执行完成。
  `MeasuredTokens`（`run.ts:200`）+ `run-session.ts:795`：未测量时**没有 `total` 键**；测量与未测量是不同的值。budget 穿入 session 属 R1.1（#147）。运行期 stop 在 R2 实现（#154），本阶段未声称。

## 验收场景

1. deferappend → settle两次 → result两次；只有一个CAS，所有Promise同结果且全部在appendack之后。
2. 第2个batch失败，重试不重写不同seqpayload；终态失败/降级清楚，日志无用户内容。
3. cancel与done、error与done、lateframe、duplicateevent、sameID冲突；唯一terminal。
4. realSQLitetransaction rollback与reopen读取；与纯mock结果一致。
5. 100次run后controllermap/timer恢复基线，不保留无界transcript副本。

## 推荐 PR、检查与回退

R1-A regression+writequeue/resultbarrier；R1-B ack/CAS/idempotency及生产ledger；R1-C realDBfault/清理。复用现有runtime/core与Desktoprun测试，完整setdiff和typecheck/architecturecheck；main变动补build:electron。

回退：关闭新durablepath保留旧chatadapter；已写runs/events保持可读，绝不删表或把未确认terminal改completed。schema扩展单独迁移且旧reader兼容。

出口：四接缝的实际失败断言转绿，resultbarrier和realDB故障测试通过，日志明确下一任务R2.1。
