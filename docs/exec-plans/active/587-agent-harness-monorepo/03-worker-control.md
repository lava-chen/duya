# R2 — 单一 Run 入口接管真实 worker

前置：R1。Next：R2.2。接入旧DuyaAgent，不重写模型循环。runtime主控制、host负责执行transport。

> **R2.1 已完成**（PR #150）。R2.2 开工中；R2.3（cancel与预算）、R2.4（审批真实回传）仍开放。
> 入口普查已完成并作为 R2.1 第一项交付物记录在 `run-orchestrator.ts:679-763`（`NON_DESKTOP_CONSUMERS` / `RUN_ENTRY_DIVERGENCES`），且有测试断言**每条登记路径在磁盘上真实存在**——首版三处路径写错，是该测试抓出来的。
> **与计划描述不符之处**：`packages/cli` 当前**根本不启动 agent run**，全是 HTTP CRUD；真正在跑的是 `packages/agent/src/cli/index.ts` 直接构造 `DuyaAgent`。计划把 CLI 列为 consumer 与代码不符，已按实际登记给 H8，未臆造工作。

## 文件与入口

Desktop `agents/server/{router,index,run-orchestrator}.ts`、worker-manager/process-pool、`control-plane/manifest-factory.ts`；legacy `packages/agent/src/process/{worker-protocol,agent-process-entry}.ts`及真实当前命名；runtimeexecutionchannel/controller。先CodeGraph定位实际文件/调用，旧历史行号不作精确定位。

> 普查更正：旧历史文档里的 `electron/` 与根 `src/` 路径**在本分支不存在**，真实路径是 `apps/desktop/src/{main,preload,renderer}`。行号可用，路径不可用。

## R2.1 Adapter 与切换清单

- [x] 列出chatPOST/nonSSE、CLI、automation、workflowagent、subagent当前start/stop/permission路径。第一PR仅Desktopchat，其他consumer登记H8接管。
  登记于 `run-orchestrator.ts:679-763`，测试 `run-entry-single-dispatch.test.ts:196-227` 断言每条路径存在。**CLI 实际不启动 run**（见上）。
- [x] 实现ExecutionChannel.start(manifest,input,sink/control)到旧worker命令的adapter；router只调用一个入口，不再controllerstart+独立send。
  `execution-channel.ts:96-128`、`controller.ts:389-425`、`router.ts:1217-1295`（独立的 `sendCommand` 已删）。测试断言**恰好一个** `chat:start`。
- [x] 初始化可仍复用旧privateworkerconfig；每次chatstart携带canonicalrunId与manifestref/inputrevision，旧agent不再另造对应runId。
  `run-orchestrator.ts:801-849`（`ChatStartCommand`）、`types.ts:299-312`、`DuyaAgent.ts:1761-1767` **穿线**用 `options.runId`（非别名），因此 mailbox 归属到的就是 Control Plane 记录终态时用的那个值。shim 退出条件：当 `NON_DESKTOP_CONSUMERS` 每行都提供 `runId`、`canonical: false` 不再出现时，`resolveTurnRunId` 的 fallback 可删。
  run 身份五处铸造的处理：**统一** openRun 与 `DuyaAgent:1761`；**重分类** `router.ts:1250` 的 `id` 为 **turn id**（`ChatOptions.turnId`、journal、`message_index.turn_id`），按设计每轮铸造，与 run 身份是两个概念；**不动** `seqIndex = Date.now()`（UI 轮次）与 `m-${runId}`/`turn-N`（本就从规范 id 派生）。
- [x] 消息SSEtee只observe一次；reconnectGET不重复observe/persist。非SSE路径有真实RunResult，不能绕新边界。
  `router.ts:1745-1866`、`run-orchestrator.ts:405-419` `resultFor`。non-SSE 原本**完全不建 run**（`openRun` 被 `wantsSSE` 挡在 `:1234`，断连直接回 `status:'interrupted'` 却不停止 worker，注释还写成"有意为之"）。现在返回 `{ events, status:'interrupted', run }` 并 settle **`cancelled`**、worker 继续跑——因为原来的静默让 run 读作 `runtime_crash`，等于让运行时为这个 handler 做的事背锅。`events`/`status` 逐字节未变，只增加 `run`。不选择停 worker 是因为 §D 区分 disconnect 与 cancel 并要求保持 Desktop 既有 adapter 行为。
  "只observe一次"实测**本就**结构成立（每请求一个 POST 分支，GET 重连视图从不 observe），因此用测试钉住而未改代码；单入口新依赖的"dispatch 与 session 绑定之间到达的帧"则通过 `onDispatchReady` 变成**结构性**保证，不靠微任务时序。
- [x] worker没ready/dispatch失败不留下运行中的假run；startack必须能判别已接受与未接受。
  `run-orchestrator.ts:288-403` `RunStartAcceptance`、`execution-channel.ts:130-141`。测试同时断言确实落了一条 `run:complete` 终态。

**R2.1 的测试抓到自己代码里两个真 bug**：non-SSE handler 在 `chat:done` 上**先返回后 observe**，run 看不到终态、把正常完成的轮次判成 `runtime_crash`；`#pendingSessionByRun` 在 `run_not_created` 提前返回路径上泄漏（已改 `finally`）。

**测试证明的边界**：adapter、次序、接受契约、non-SSE 边界均为**离线**证明（无 worker、无 provider key、无 Electron）。**不**证明真实 `DuyaAgent` 消费了规范 id——最后一跳在 `resolveTurnRunId` 接缝上覆盖，不是端到端。未声称任何宿主边界能力。

**有意未做**：`handleDeleteChat` 仍然中断 worker 而不 settle run（R2.3）；worker **携带** `manifestHash`/`inputRevision` 但**不校验**（R2.2，代码里如实标注而非假装已强制）。

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
