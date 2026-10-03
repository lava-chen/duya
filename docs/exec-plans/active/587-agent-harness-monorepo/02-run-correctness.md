# R1 — Run 结果、事件与存储正确性

前置：G0。目标：result可信，不因读取或未完成写入制造终态。Next：R1.1。完整验收前不扩展能力。

## 文件范围

`packages/agent-runtime/src/{controller,run-session}.ts`、`transport/execution-channel.ts`、Desktop `agents/server/run-orchestrator.ts`、`control-plane/run-control-plane.ts`、`db/core/run-store.ts`及其现有tests。新类型需公开正常入口，不能从protocol/testing导入生产ledger。

## R1.1 固定四个失败接缝

- [ ] manifest maxTurns=1，executor仍活跃：会触发预算判定，不再无条件completed。
- [ ] executor未结束时调用result，Promise保持pending，executor没有被settle/stop副作用。
- [ ] append延迟未ack时settle，不得先complete或resolvepublicterminal；append失败同样不能返回成功。
- [ ] append/complete返回negativeack、CAS未applied或抛错，明确错误/降级receipt，不能被await吞掉。

原评审的隔离探针仅是2026-10-03历史证据；先核对最新源码和已有修复，以新增必要测试接管，不重复改已修代码。

## R1.2 持久化序列与生命周期

- [ ] 每run保存串行writequeue/in-flightPromise；flush等待之前batch和当前batch。失败batch不先永久丢弃，采用有界retry或failclosed/degraded，不无限积压。
- [ ] terminaldecision与commitPromise分离；重复settle/result共享Promise。terminal事件先append确认再complete，或在同SQLitetransaction写terminalevent+CAS；两种实现选一种说明，禁止跨adapter暗自不同。
- [ ] 新run durable started确认后才dispatch；失败返回start_failed，不让实际executor悄悄运行。
- [ ] executor结束无done/error、dispatch同步throw、进程断开均产生明确terminal；不要用“未知run默认completed”掩盖缺记录。
- [ ] lateframe terminal后拒绝或diagnostic；清理controller/sessionmap、timer、subscription，保留按契约可查询的resultreceipt。
- [ ] cancellationrace共用00合同arbiter；本阶段不另造workerstop路径。

## R1.3 Ack、CAS 与幂等

- [ ] dbRequest adapter逐项验证ok/payload/applied；统一typedreceipt，跨IPC服务不throw的结果不能当成功。
- [ ] 相同runId+manifest/inputhash复用；不同内容拒绝，活跃map不被覆盖。
- [ ] event相同(run,seq)payload重试幂等；不同payload拒绝。`INSERT OR IGNORE`不应隐藏内容冲突。
- [ ] terminalCAS失败读取已提交terminal验证一致；不一致返回conflict，不覆盖。
- [ ] SQLtransaction失败、busy、worker退出时的state明确。聊天fallback仅保留显式观察层降级，durablerun不返回虚假成功。

## R1.4 结果与生产 ledger

- [ ] RunLedger/lifecycle状态归core或runtime生产入口；testing只留fixture/断言。
- [ ] result的transcript/permissionAudit依当前能力返回真实引用/读回；若暂不支持，capability明确unsupported，不能用空数组表示没有发生。
- [ ] budget传入session，usage字段缺失标unknown；运行期stop在R2实现。本阶段测试不得只改最终标签假称预算执行完成。

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
