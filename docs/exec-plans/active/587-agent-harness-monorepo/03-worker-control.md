# R2 — 单一 Run 入口接管真实 worker

前置：R1。Next：**R2.2 第4项（运行期 catalog 刷新以 revision 事件记录）、R2.3 第3a/4项、R2.4 第5项**——这四条是交付 PR 自己标注 partial 的余项。接入旧DuyaAgent，不重写模型循环。runtime主控制、host负责执行transport。
>
> **阶段状态（2026-10-04 对 `55384c55` 核对）**：R2.1–R2.4 **全部合并**（#150、#153、#154、#155），但**不是 Done**——四个 PR 各留下一条自评 partial（下文逐条标出）。本阶段未合并的**没有**一项是靠"没时间"留开的，每一条都是交付方给出的精确阻塞。
>
> **R2.1 已完成**（PR #150）。R2.2/#153、R2.3/#154、R2.4/#155 已合并。
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

> 已合并，PR #153（`af8b0eb0`）。5 项中 4 项 done、第 2 项"proved already fixed"、**第 4 项自评 partial**。

- [x] 从当前配置拿真实profile/modes/model/effort、budget、permission、roots、toolsnapshot与connectorbindings，记录版本来源。
  `manifest-factory.ts:166` + `router.ts:1260` + `agent-protocol/src/manifest.ts:104`；`run-manifest-config.test.ts`（14）。provenance 记在 `RunManifest.provenance`（逐字段 `source`/`sourceVersion?`/`synthesised`），**键集是封闭的**——未归因的 manifest 字段是编译错误而不是静默遗漏，且 `unsupported ⇒ synthesised: true` 是测试断言的不变量。
- [x] 输入包含真实prompt及attachment引用，移除controller收到空prompt而由旁路传真实input的双事实源。
  **#153 判定为"proved already fixed"**（不是本切片改的）：`run-manifest-verification.ts:246`；`run-manifest-config.test.ts:159` 钉住单事实源。
- [x] worker校验manifesthash/version及inputbinding；拒绝未知requiredcapability、非法cwd，不能静默替换配置。
  `run-manifest-verification.ts`（新增）+ `agent-process-entry.ts:2477`；`run-manifest-verification.test.ts`（16）。这正是 R2.1 交接里"worker 携带但不校验"的那一跳。
- [ ] 配置变化仅作用于未来run或显式动态policyrevocation；运行期catalog刷新以revision事件记录，不能暗改snapshot。
  **#153 自评 partial**：`manifest-factory.ts:346` 只做到了"配置变化不改动正在运行的 run"（`run-manifest-config.test.ts:181,190`），**运行期 catalog 刷新要以 revision 事件记录**这一半没做。下一动作：在 T3.2 已建的 control-plane census（21 行，`control-plane-census.ts:118`）里为 catalog 刷新补一条 producer/sink 行，让刷新成为可观察事件而不是快照差异。
- [x] publicmanifest不带secret；当前privateproviderdelivery保证受控且脱敏。未完成secretbroker不假称全局无凭证跨进程。
  `run-orchestrator.ts:851` + `agent-process-entry.ts:216`；`12-no-secret-in-manifest.test.ts`（8）。#153 明确"未完成 secret broker"这件事本身要如实陈述，不假装跨进程无凭证。

## R2.3 Cancel 与预算

> 已合并，PR #154（`9803b5fd`）。5 项中 1/2/5 done、3b done，**3a 与 4 自评 partial**。

- [x] ExecutionHandle.stop连接真实interrupt，清理timer，grace后平台processadapter执行kill/fence；等待有界，不await永不resolve句柄。
  `worker-manager.ts:324-405` + `execution-channel.ts:104-124` + `controller.ts:836-889`；`run-cancel-budget.test.ts:281`——一个永不答的 stop 仍然 resolve 并报 `escalated`。
- [x] 控制路由和worker终态同arbiter；cancel确认描述requested/applied/terminal，已结束返回appliedfalse。
  `controller.ts:718-790` + `run.ts:71-104` + `router.ts:1956-2040` + `run-orchestrator.ts:615-651`；`run-cancel-budget.test.ts:258`、`run-cancel-stop-path.test.ts:224,242`。
- [ ] turn/tool启动前检查预算，usage后检查tokens/cost，wallclocktimer可触发stop。maxTurns=1不启动第2次模型请求。
  **#154 把本条拆成 3a/3b，3b done、3a partial。** 3b wallclock timer 已落地（`controller.ts:519-546`，在 `settle` 的 `controller.ts:702-706` 清除；`run-cancel-budget.test.ts:363,409` 断言 run 结束后不泄漏 stop）。3a 的阻塞是结构性的：**runtime 只在帧**返回**时才得知 `turn.started`，即在 provider 调用之后**，因此无法撤回已发出的第 2 次请求。下一动作：预算判定要下沉到发出请求**之前**的那一跳（ModelClient 入口），并为"预算在请求发出瞬间被耗尽"补一条断言。
- [ ] cancel阻断排队tool；在跑tool正确完成或标unknown；sideeffect账本恢复在D7，不能把kill等于撤销工具。
  **#154 自评 partial（runtime 侧）**：`run-ledger.ts:127-146` + `run-session.ts:583-617`；`run-cancel-budget.test.ts:438,475`。在跑工具的 `unknown` 记账在 D7.1 落地（#177 的 toolattempt 状态机 + `retry:false, code:'non_retryable'`），本条剩余的是"cancel 阻断**排队** tool"这一跳。
- [x] 请求连接关闭保持明确旧行为；backgroundcontinueopt-in，断线与用户stop分别测试。
  `router.ts:1523-1543` 未改；`run-cancel-budget.test.ts:509` 与 `run-entry-non-sse.test.ts:217` 分别测断线与 stop。

## R2.4 审批真实回传

> 已合并，PR #155（`9a37112c`）。6 个子项中 1/2/3/4/6 done，**第 5 项自评 partial**。

- [x] controllerrespondToPermission接入现有审批路径；CP写durabledecision再投递worker，requestId/runId一致。
  `controller.ts:1029` + `control-plane/permission-coordinator.ts:432`；`run-permission-respond.test.ts`（9），含"records the decision, and the recorded row exists by the time the worker is told"。
- [x] 统一一次/会话grant、timeout/defer/deny；更新input重新校验。迟到/重复应答返回receipt不重复执行。
  `permission-vocabulary.ts:130-190` + `permission-decision-record.ts:52-66`（未知动词返回 null，**由调用方 fail closed**；旧动词上错 surface 被拒）+ `router.ts:2205-2240` + `permission-decision-record.ts:74-92`；`permission-router-decision.test.ts`（16）。会话 grant 不靠进程巧合：`agent-process-entry.ts:4595-4626` + `db-bridge.ts:888-902` + `approvals.ts:1-40`；`toolApprovalState-grant-scope.test.ts`（7，真实 SQLite）、`sessionGrantScope.test.ts`（9）。`defer` 可达：decided nothing、delivered nothing、请求保持打开（`permission-coordinator.ts:392-405`）。
- [ ] cancel关闭所有pendingrequests并audit；privateapproval引用不携secret到SSE。
  **#155 第5项自评 partial**。已做的一半在 `controller.ts:857-862` 与 `permission-coordinator.ts:120-137,470-492`（每个打开的请求以 cancelled 原因被拒、且只在该值上装**一个** timer）；"private approval 引用不携 secret 到 SSE"没有对应断言。下一动作：为 private approval 引用补一条"序列化后的 SSE 帧不含 secret 值"的断言，并核对 cancel 时 audit 记录对**每一个**打开请求都落行。
- [ ] timerownership仅一个权威deadline；workerrecycle/session变化不会继承不该存在的grant。
  未完成：#155 证明了"只装一个 timer"与"会话 grant 不因进程巧合生效"，但**worker recycle / session 变化时的 grant 继承**没有独立断言。下一动作：补一条"worker recycle 后新请求不得看到上一个进程的 grant"的真实 SQLite 用例。

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
