# D7 — Checkpoint、恢复与长期目标

前置：T3、C6。Next：D7.1。executionresume始终unsupported直到故障矩阵通过；eventreplay不等于续执行。

## D7.1 Checkpoint 与副作用模型

- [ ] 定义版本化checkpoint：manifest/inputrevision、context/transcript位置、loop/mode状态、预算、mailboxwatermark、pendingapproval、toolattempt/outbox、artifactrefs、modelcontinuation能力。
- [ ] checkpointpayload本体有digest，index和committedcursor同事务/确定barrier；不记录尚未确认事件为可恢复边界。
- [ ] 复用现有filepreimage与ResearchStore等机制但保持责任区分：rewind恢复文件、Research业务进度、runexecutioncheckpoint不能互当替代。
- [ ] 可恢复安全点为没有unknownsideeffect的loop/toolbarrier。旧序列落在toolstarted/finished之间需查账本，不仅按seq猜。

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
