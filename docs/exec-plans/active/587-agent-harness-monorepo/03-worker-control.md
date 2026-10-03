# R2 — 单一 Run 入口接管真实 worker

前置：R1。Next：R2.1。接入旧DuyaAgent，不重写模型循环。runtime主控制、host负责执行transport。

## 文件与入口

Desktop `agents/server/{router,index,run-orchestrator}.ts`、worker-manager/process-pool、`control-plane/manifest-factory.ts`；legacy `packages/agent/src/process/{worker-protocol,agent-process-entry}.ts`及真实当前命名；runtimeexecutionchannel/controller。先CodeGraph定位实际文件/调用，旧历史行号不作精确定位。

## R2.1 Adapter 与切换清单

- [ ] 列出chatPOST/nonSSE、CLI、automation、workflowagent、subagent当前start/stop/permission路径。第一PR仅Desktopchat，其他consumer登记H8接管。
- [ ] 实现ExecutionChannel.start(manifest,input,sink/control)到旧worker命令的adapter；router只调用一个入口，不再controllerstart+独立send。
- [ ] 初始化可仍复用旧privateworkerconfig；每次chatstart携带canonicalrunId与manifestref/inputrevision，旧agent不再另造对应runId。
- [ ] 消息SSEtee只observe一次；reconnectGET不重复observe/persist。非SSE路径有真实RunResult，不能绕新边界。
- [ ] worker没ready/dispatch失败不留下运行中的假run；startack必须能判别已接受与未接受。

## R2.2 Manifest 实际生效

- [ ] 从当前配置拿真实profile/modes/model/effort、budget、permission、roots、toolsnapshot与connectorbindings，记录版本来源。
- [ ] 输入包含真实prompt及attachment引用，移除controller收到空prompt而由旁路传真实input的双事实源。
- [ ] worker校验manifesthash/version及inputbinding；拒绝未知requiredcapability、非法cwd，不能静默替换配置。
- [ ] 配置变化仅作用于未来run或显式动态policyrevocation；运行期catalog刷新以revision事件记录，不能暗改snapshot。
- [ ] publicmanifest不带secret；当前privateproviderdelivery保证受控且脱敏。未完成secretbroker不假称全局无凭证跨进程。

## R2.3 Cancel 与预算

- [ ] ExecutionHandle.stop连接真实interrupt，清理timer，grace后平台processadapter执行kill/fence；等待有界，不await永不resolve句柄。
- [ ] 控制路由和worker终态同arbiter；cancel确认描述requested/applied/terminal，已结束返回appliedfalse。
- [ ] turn/tool启动前检查预算，usage后检查tokens/cost，wallclocktimer可触发stop。maxTurns=1不启动第2次模型请求。
- [ ] cancel阻断排队tool；在跑tool正确完成或标unknown；sideeffect账本恢复在D7，不能把kill等于撤销工具。
- [ ] 请求连接关闭保持明确旧行为；backgroundcontinueopt-in，断线与用户stop分别测试。

## R2.4 审批真实回传

- [ ] controllerrespondToPermission接入现有审批路径；CP写durabledecision再投递worker，requestId/runId一致。
- [ ] 统一一次/会话grant、timeout/defer/deny；更新input重新校验。迟到/重复应答返回receipt不重复执行。
- [ ] cancel关闭所有pendingrequests并audit；privateapproval引用不携secret到SSE。
- [ ] timerownership仅一个权威deadline；workerrecycle/session变化不会继承不该存在的grant。

## 验收矩阵

| 场景 | 要求 |
| --- | --- |
| realworker+offlinestream正常turn | manifest/input/runId贯穿；启动计数1；持久terminal1 |
| maxTurns=1/token/wallclock | 不开始超限新操作；stopReason/budgetUsed真实 |
| 中途cancel/cooperative/hungworker | stops实际触达；deadline后终止；hardkill不冒充干净取消 |
| cancel同时done、断线同时done | arbiter结果稳定；terminal唯一；disconnect策略可解释 |
| approvalaccept/deny/defer/timeout/late | 与CPaudit一致；未授权tool执行计数0 |
| 同名附件、中途mailbox、profile/mode | 数据身份保留；已有行为无迁移回归 |
| failurestart/privatecredential | 不执行假run；artifact/日志无secret |

## 推荐 PR、gate、回退

R2-A ID/input+真实dispatch；R2-B stop/budget；R2-C approvaladapter；R2-D nonSSE和Desktop真实smoke。每PR现有worker/router/run测试+typecheck+architecture；buildagent/bundle与electronbuild，最后真实Electronprovider录runrow/eventlog/terminal。

新path开关默认受控；回退只能保留一个executor。旧privatecommandshim记录release/消费者退出要求，不能绕审批或双写业务状态。出口：真实worker矩阵通过，capabilities仅声明实际验收能力。
