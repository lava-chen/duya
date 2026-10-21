# D7 — Checkpoint、恢复与长期目标

前置：T3、C6。Next：**D7.2 lease/fence 与恢复 attempt**。executionresume始终unsupported直到故障矩阵通过；eventreplay不等于续执行。
>
> **阶段状态（2026-10-04 对 `55384c55` 核对）**：D7.1 已合并（#177 `5dc45fcf`，52 个新测试全绿），**仍是 In progress**——D7.2 / D7.3 / D7.4 与下方故障注入矩阵**一条未开始**。`checkpoint/unsupported.ts` + `control-plane-census.ts:255` 把 resume / determinism / pause **显式声明为 unsupported**，所以本阶段没有任何能力被误开放。

## D7.1 Checkpoint 与副作用模型

> 已合并，PR #177（`5dc45fcf`）。52 个新测试全通过；fails-before 已示（移除 `checkpoint.ts` 后 `checkpoint-side-effects.test.ts` exit 1 无法解析 import；还原后 22/22）。

- [x] 定义版本化checkpoint：manifest/inputrevision、context/transcript位置、loop/mode状态、预算、mailboxwatermark、pendingapproval、toolattempt/outbox、artifactrefs、modelcontinuation能力。
  `RecoveryCheckpoint`（`packages/agent-protocol/src/checkpoint.ts:1`）：`schemaVersion`、runId/sessionId/generation/epoch/fence、`manifestFingerprint`、`inputRevision`、transcript `{throughSeq, messageCount}`、model `{providerId, model, turnIndex, continuation}`、loop `{profileId, modeIds}`、budget `{limit, spent}`、mailbox watermark、带 deadline 的 pendingApprovals、`toolAttempts`、`artifactRefs`、`envRef`、`capabilities`。`checkpoint-side-effects.test.ts`（22）。
- [x] checkpointpayload本体有digest，index和committedcursor同事务/确定barrier；不记录尚未确认事件为可恢复边界。
  `agent-runtime/src/checkpoint/checkpoint-store.ts:1`（fence + store 规则）；`checkpoint-store.test.ts`（12）。`manifestFingerprint` 与单调 `fence` 同 payload 保存。
- [x] 复用现有filepreimage与ResearchStore等机制但保持责任区分：rewind恢复文件、Research业务进度、runexecutioncheckpoint不能互当替代。
  **#177 刻意拒绝把 file pre-image 内容放进 checkpoint**——只存引用，因为 §G 说 rewind 是另一个功能，两者不能互相当替。同一原则下**拒绝 secret 值**（`envRef` 是 `{ref, hash}`：durable checkpoint 比任何 key rotation 活得都久，值在里面就是长尾泄漏）、拒绝无界文本、拒绝 provider KV 状态（`model.continuation` 记录 adapter 是否支持；不支持时恢复重构为**新 attempt** 并在 `limits` 里说明）。
- [x] 可恢复安全点为没有unknownsideeffect的loop/toolbarrier。旧序列落在toolstarted/finished之间需查账本，不仅按seq猜。
  toolattempt 状态机与 `parentRunId` 分支（`checkpoint/branch-plan.ts:1`，`checkpoint-branch.test.ts` 8）。**kill 证据是真的**：fork 出的 `node` 子进程跑 `plan → dispatch → 真实副作用`（真写一个文件）然后永远等待；父进程用 `taskkill /F /T` 杀它——不可捕获、无清理、**刻意不是**协作式 stop，因为干净停止正是恢复不存在的那个情形。然后**第二个进程**打开同一个 SQLite 文件，把该 attempt 读成 `unknown` 且 `retry: false, code: 'non_retryable'`；**第三个进程**在陈旧 fence 处被拒。
  **未支持已显式声明**（`checkpoint/unsupported.ts:1` + `control-plane-census.ts:255`，`checkpoint-unsupported.test.ts` 8）：resume / determinism / pause。

toolattempt状态建议：planned → dispatched → succeeded/failed/unknown → reconciled；key关联run/attempt/toolcall与输入digest。每tool声明read-only、idempotent-with-key、reconcilable或non-retryable。无声明保守unknown，禁止自动重复。

## D7.2 Lease、fence 与恢复 attempt

> **未开始。** 这是本阶段的下一任务。#177 已经把单调 `fence` 放进 checkpoint payload 并证明陈旧 fence 处会被拒（第三个进程），但 **CP 侧还没有 claim/renew/lease**——`leaseExpiresAt`、renewal CAS、失去 lease 后阻止新 action 与写 commit 都还不存在。下一动作：在 `control-plane/repository-port.ts` 之上加 claim/renew（owner + `leaseExpiresAt` + 单调 fence），并让 `recover` 铸造新 attempt/epoch；D7.1 的 `d71-kill-recovery.test.ts` 已经提供了"真进程 + 真 kill + 第二进程读出 `unknown`"的现成夹具。

toolattempt状态建议：planned → dispatched → succeeded/failed/unknown → reconciled；key关联run/attempt/toolcall与输入digest。每tool声明read-only、idempotent-with-key、reconcilable或non-retryable。无声明保守unknown，禁止自动重复。

## D7.2 Lease、fence 与恢复 attempt

- [ ] CPclaimrun具有owner/leaseExpiresAt/monotonicfence；renewal CAS，失去lease阻止新action与后续写commit。
- [ ] recover创建新attempt/epoch，同runcontinuation按合同关联；从message分支是新run+parent。旧worker迟到ack/terminal不覆盖新attempt。
- [ ] retrystart/checkpoint/complete均有idempotency，lease不是仅定时器标签；DB写入校验fence。
- [ ] arbitrary外部系统不能检查fence时使用broker/idempotency/reconciliation；不能承诺staleexecutor外部副作用绝对不存在。
- [ ] 进程reaper只停止本owner可证明属于该attempt的进程，不按裸PID杀重用后的无关进程。

## D7.3 恢复执行与审批

- [ ] 校验checkpoint/schema/hash与当前root/env/tool版本；不可兼容返回typedreason，不静默改manifest继续。
- [ ] hostrevocation重新求值，不能恢复旧的无限授权。pendingapproval带原deadline；过期拒绝、已resolved不重新问，sessiongrant符合scope。
- [ ] 安全tool可用idempotency重试；unknowntool需要查询外部结果/产物或人工确认，提供reconciliation入口和明确用户状态。
- [ ] mailboxwatermark和backgroundnotification幂等读取；恢复不重复插入附件/已消费用户消息。
- [ ] budget累计跨attempt，不能靠restart清零。模型仅在实际adapter支持的continuation边界恢复；没有确定模型状态时用新attempt对话重构并记录限制。
- [ ] result/artifacts读取可终端查询；暂停仅在已保存安全点支持，pauseaccepted不等于立刻冻结一切IO。

## D7.4 Goal / Task 长期闭环

- [ ] CP记录objective、tasklink、产物/验证证据与下一行动；完成由已验证artifact/invariant支撑，不只依赖modelfinish工具。
- [ ] transientretry、blocked等待、cancelled与complete分明；wake重启使用durableintent，不反复新建重复run。
- [ ] profile/Memory隔离与Projectscope沿C6，contextprogressfile/handoff具有来源，不将speculation写为已验证memory。
- [ ] 长任务token/contextcompaction保持未决tool/approval和重要输入；eval比较恢复前后任务结果。

## 故障注入矩阵

| 断点 | 必须观察 |
| --- | --- |
| started写前/写后、dispatchack前/后 | 不重复dispatch，无法证明未执行时unknown而非盲重试 |
| tool外部成功、本地ack前 | unknown/reconciliation；安全key重试不会双副作用 |
| append中、checkpointtransaction中、terminalCAS前后 | reopen一致，terminal唯一、未提交checkpoint不使用 |
| worker/server/main任意被杀 | 能读取现状，恢复或明确拒绝理由，旧attempt不覆盖 |
| lease失效旧worker仍发帧 | rejectstalecommit，metric/diagnostic可追溯 |
| approval过期/撤销、root迁移 | failclosed，grant不复活 |
| mailbox/background重复 | 消费一次，附件身份/产物不丢 |

真实SQLite与真实worker运行上述断点，不能只用内存fake。每种tool能力至少一用例，nonretryable必须证明阻止重发。

## PR、gate 与回退

D7-Acheckpoint/index事务；D7-Btoolledger/fence；D7-Cresume/reconciliation；D7-Dapproval/mailbox及Goal长任务；D7-Efaultsuite+capability开启。

每PRtypecheck/architecture、DB/恢复定向回归与完整失败setdiff；bridge/module变化electronbuild；用户可见恢复状态UIPlaywright+Electron。回退关闭resume，保留ledger/checkpoint可读和reconciliation，不能清空unknown动作以假造安全。出口：故障矩阵通过，只有已支持工具/场景开放resume。
