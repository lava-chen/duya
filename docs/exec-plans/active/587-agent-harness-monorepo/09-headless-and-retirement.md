# H8 — 多 Host 共用与旧包退役

前置：M5、C6、D7。Next：**H8.2 的 subagent child run**——automation 的 `RunResult` 读侧已由 #205 闭合，workflow 跟着 subagent 一起动。#198 已把 headless CLI 落地在共享 Run API 上，**H8.1 不再是前置**。已有CLI/automation/workflow入口逐个接管，不新写平行引擎。
>
> **阶段状态（2026-10-04 对 `55384c55` 核对）**：H8 仍是 **In progress，且本阶段没有任何 merged PR**。这一节的记录曾经把 H8 写成"H8.1 已合并"——**那是错的**，现更正：
>
> - **H8.1 未合并。** 工作在 `origin/feat/587-h8-1-headless-run-api`（提交 `1e5e821b`），PR **#178 仍 OPEN**。`git merge-base --is-ancestor 1e5e821b origin/master` 退出码 1——该提交**不在** master 上。#178 自报 5 项中 4 项 done（headless host 组合真实 run 层、单一帧生产者、CLI 成薄 shim 且 **0 个活的 `streamChat` 调用点**、退役登记带真实条件、census 随之更新），**evals runner 共享组合自评 partial**。测试用**五次突变**证明非空转（probe 过度声称、第二个 run id、stop 不触发 interrupt、**第二套帧词汇**、丢 provenance），其中帧词汇突变挂掉三个具名测试。
> - **H8.2 在飞但未推。** 本地分支 `feat/587-h8-2-consumer-takeover` 存在（另一个 worktree 检出中），**远端无对应分支、GitHub 上无 PR**。不得把它记为进展。
> - **H8.3 / H8.4 未开始。**
> - **退役被刻意扣住**：#178 实测 `duyaAgent.streamChat` 作为 CLI turn 入口**还有 7 个 consumer**（由测试从源码重新推导，不是断言），且 **host smoke 无证据**——H8 的退出条件点名了 packaged Electron。shim 保留，`removable: false` 并记 `blockedOn`。
>
> **阶段状态（2026-10-04 对 `2a375c1c` 再次核对）**：上面那一整块**已过期**，逐条更正如下。H8 仍是 **In progress**，但已不是"本阶段没有任何 merged PR"：
>
> - **#178 已 CLOSED（未合并），被 #198 取代。** `gh pr view 178` → `state=CLOSED`、`mergedAt=null`、`closedAt=2026-10-04T12:29:11Z`，紧接在 #198 合并（`12:27:49Z`）之后。原提交 `1e5e821b` **至今仍不是 master 的祖先**（`git merge-base --is-ancestor 1e5e821b origin/master` exit 1）——H8.1 是**以 #198 的重放进入 master 的，不是合并 #178 进入的**。#178 作为设计依据留档，其上已加注释指向 #198。
> - **H8.1 已合并（#198，`7b6c7f38`）**：headless CLI 现走共享 Run API。`packages/agent/src/process/headless-run-host.ts` 在 `origin/master` 上**已存在**。
> - **H8.2 部分交付（#197 `08065a7c` + #199 `2f797c3e` + #205 `46967fa2`），automation 一项已闭合，subagent 与 workflow 未动。** #197 交付可重算的入口普查与 CLI 非交互 approval 安全属性，**明确不迁任何 consumer**；#199 把普查从行号改为符号锚点，并修好退役登记；**#205 把 automation/wake 的读侧从 SSE `done` 帧换成 `RunResult`**（详见本节「H8.2 进度」）。**剩下的 subagent 与 workflow 仍未开始。**
> - **H8.3 / H8.4 未开始。**
> - **退役仍然被扣住，但数字与理由都变了。** 上面的"7 个 consumer"**从来就是错的**：它把 `@duya/ai` 的同名 `AIClient.streamChat` 算了进去，而按该登记自己的定义它们不是 turn entry。#199 把声明数改为**实测 2**，并修好那条**空转断言**（原断言拿 `measured.length` 和 `measured.length` 比，无论声明多少都通过）。


## H8.1 Headless composition

> **在 PR #178，未合并。** 本节四条**一条都不勾**——代码在分支上，验收在 PR 上，计划的状态表只认 master。
>
> **更正（同日，对 `2a375c1c`）**：上面那句"在 PR #178，未合并"**已过期**——**#178 是 CLOSED 未合并，H8.1 由 #198 重放后合并进 master**。计划的状态表只认 master 这条规则不变，因此本节第 1 条**现在可以勾**，其余三条仍然一条都不勾。

- [x] CLI组合相同runtime/core/protocol、CPservices和SQLite/secret/processadapter，运行时import不含Electron/preload/DOM；现有CLIcommand/runner保留产品交互。
  #178 的 `HeadlessRunHost`（`packages/agent/src/process/headless-run-host.ts:1`）组合**真实** `RunController` + **真实** `InProcessTransport` + 真实 `InMemoryRunEventStore`，唯一替换的是 executor：一个调用真实 `duyaAgent.streamChat` 并把帧推过 **worker 自己的 codec** 的 `ExecutionChannel`。CLI 在 `cli/index.ts:572,600,831` 变薄，**0 个活的 `streamChat` 调用点**（`headless-retirement.test.ts:118`）。同层的证据：run id 由 host 侧铸造且等于 `manifest.runId`；`seq` 稠密 `1..N`；`run.started` 先于 dispatch；cancel 到达 `agent.interrupt()`。**未合并即未验收。**
  **（2026-10-04 更新：已合并，故勾选）** #198（`7b6c7f38`）把这些改动重放到当前 master 并合并。计划状态表只认 master，这条现在成立。**本条实测记录**：CLI 的三个 turn entry 已合并进同一个 host 入口，`origin/master` 上 `headless-run-host.ts` 存在；两侧门禁测试 `headless-retirement.test.ts` + `run-entry-single-dispatch.test.ts` 在 `origin/master` 上 **22/22 绿**（本切片亲跑，见执行日志）。**仍未覆盖的边界**：packaged Electron host smoke 依旧无证据，故 shim 不能退役（见 H8.3）。
- [ ] CP是否独立成包用真实CLI/serverconsumer决定。先提供正常公开内部module入口；真正提包后Desktop只留adapter/composition，避免跨apps相对import变成长期接口。
  #178 **未提包**，也未提供公开内部 module 入口——它只在 `packages/agent` 内组合。真实第二 consumer 尚不存在（`packages/cli` 仍全是 HTTP CRUD，见 M5.2-S3）。
- [ ] 需要独立HTTPdaemon时建立apps/agent-server，复用同服务；standalone服务默认受控local接口，auth/origin/资源限制实际验证，部署cloud另行授权。
  未开始。`apps/agent-server` 仍只是 [迁移映射](migration-map.md) 里的目标树条目。
- [ ] package membership/build/publish/CI选择分开；evals不成为生产依赖。
  **#178 自评 partial**——正是"evals runner 共享组合"这一项。`audit-imports.mjs` 可查的包边界对 evals 尚无本阶段的证明。

## H8.2 其他 consumer

- [x] automation/wake将durableintent提交CP并读RunResult，取消和failure与Desktop一致；不会绕permission或预算。
- [ ] workflow `wf.agent`复用同runadapter，workflowRunId/nodeId与agentRunId关联；遵守560的Go/No-Go已验收结果，不复制worker内loop。
- [ ] subagent运行作为parentchildrun关联；profile/workspace隔离和backgroundoutput沿同合同；worktree能力由496拥有其具体Git实现。
- [ ] HTTP/subprocess/in-process同合同回归；CLI非交互approval拒绝/timeout或使用显式policy，不能自动allow。

### H8.2 进度（automation 一项已闭合，2026-10-04，branch `feat/587-h8-2-moves`）

**automation/wake 的读侧已闭合。** 提交侧本就正确：cron/wake POST 的是渲染器同一条
`POST /sessions/:id/chat`，router 走 `openRun`，所以 turn 一直有真实 run 行和 canonical runId。
**身份从来不是缺口，缺口在读侧**——`runPromptInSession` 过去在 worker 的 SSE `done` 帧上收尾，
verdict 是执行器的意见而不是 run 的终态。现在改读 `RunResult`：

- 新增 `GET /sessions/:id/run-result`（`router.ts` 的 `handleGetRunResult`），暴露既有的
  `RunOrchestrator.resultFor`。该方法本就被标注为「只读、永不 settle」，所以路由是**从构造上**
  满足 §C「`result()` 只等待、不得 settle」，而不是靠调用点自律。
- `completed` 之外，`cancelled` / `budget_exhausted` / `failed` 各自映射成**可区分**的失败。
  这正是 `done` 帧表达不了的部分：被取消或撞预算上限的 turn 后面照样可能跟一个 `done` 帧，
  旧收尾会把没成功的 run 记成一次成功唤醒。
- **不会绕 permission 或预算**：这是对「已判定终态」的读取，不携带任何 permission 决策、
  grant 或预算，读它无法让 policy 会拦下的工具跑起来。它的价值恰恰与绕过相反——它是
  automation 得知「闸门说了 no」的途径，也正因为如此 budget/cancelled 两个用例才可断言。
- **拿不到 receipt 就不算成功**：§C 要求 durable consumer 拒绝未确认的成功，所以 null
  `RunResult` 直接 reject，不回退到帧的意见；无 run layer 的 host 回 501 而非 "completed"。
- 顺带修掉一个真实竞态：`done` 之后 SSE 流的 `end` 几乎立刻触发，旧收尾会在读 `RunResult`
  的窗口里 reject 掉每一次正常完成的 run。现在用 `doneSeen` 区分「流结束」与「promise 已有答案」。

证据：`apps/desktop/src/main/__tests__/run-result-read.test.ts`（真 `RunOrchestrator` + 真
`RunController`，断言终态来自 runtime、读活跃 run 不会 settle 它、501 不被洗成成功）；
`apps/desktop/src/main/automation/__tests__/automation-run-result.test.ts`（真 `http.Server`
+ 真 socket 跑生产客户端，断言 budget/cancelled/failed 在 `done` 帧正常到达时仍然 reject）。
非空转用突变验证过：让 verdict 映射信任帧，恰好挂 3 条终态用例；还原旧收尾挂 5 条。

**非CP turn entry 仍是 1，且这是正确结果。** automation 从来不调 `.streamChat(`，因此它从来
不在普查的计数里；这次改的是「读」，不是「入口」。一个因为改了读法就变了的计数，说明它
一直在数错东西。

**subagent 未做**，因为它跨的是**进程边界**而不是代码形状，已实测并记录在
`run-orchestrator.ts` 的 `NON_DESKTOP_CONSUMERS` sub-agent 行：subagent 的 turn 是父 worker
**内部**的嵌套 loop，而 run 生命周期在 main 进程，worker 的 `db-client` 约 230 个 action 里
**一个 `run:*` 都没有**——从 subagent 到 CP 根本没有路。`parentRunId` 在 run 行/manifest/CP
三处都已就位，缺的是一条 worker→CP 的开 run 通道，不是字段。

其余三条**仍未勾**，各自的阻塞与下一动作（按本计划收尾规则，开放项必须给一条可实施动作）：

| 条目 | 阻塞 | 下一动作 |
| --- | --- | --- |
| workflow `wf.agent` | 身份只有自建表的 `workflowRunId`，无 `agentRunId` 关联；560 已判 Go，不得重开。**它与 subagent 共用同一条 `SUBAGENT_TOOL_NAME` 执行器，因此它跟着 subagent 一起动，不能先动** | 等 subagent 那条通道落地后，在 `wf.agent` 复用同一 child run 路径时一并落 `workflowRunId`/`nodeId` ↔ `agentRunId` 关联 |
| subagent | 缺的是**通道**不是字段：`parentRunId` 已端到端就位，worker→CP 没有任何开 run 的动作。且 child run 会跑在**另一个** worker（父 worker 占着 session 的单活 run 绑定），因此三样可观测合同都得改挂到 run id 上：进度投影（今天发的是 worker 本地的 `chat:agent_progress` 帧）、后台续跑（`run_in_background` 是 worker 内的 `BackgroundAgentLifecycle`）、`subagent:kill`（今天停的是子生命周期控制器，不是 run） | 先开 worker→CP 的 run 通道（新增一条 `run:*` 动作，把 child run 的终态交回 CP 结算），再把这三样逐项改挂；**不要只开通道不迁合同**——半套 child run 会把自己吊死，比它替换掉的嵌套 loop 更糟 |
| 同合同回归 + CLI approval | CLI approval 半边已由 #197 证明（10/10 绿）；缺的是三 transport 的同合同回归 | 待 subagent 迁移落地后，用同一组用例分别跑 HTTP/subprocess/in-process 三条路径比对 |

**注意：`duya setup` 的 `permission_profile` 不要顺手接线**——它会新授予一条 bypass 能力，属独立决策（见下方测量记录）。#205 再次复核确认该缺陷仍是既有问题、方向 fail-closed。

### H8.2 测量记录（2026-10-04，未完成迁移）

入口普查已落为可重算的测试 `apps/desktop/src/main/__tests__/h8-2-consumer-inventory.test.ts`：
每个 `.streamChat(` 生产站点要么登记为 turn entry、要么登记为 look-alike，新增未登记站点直接失败。
因此下列数字可被测试复核，不是散文声明。

| 站点 | consumer | 经CP? | 判定 |
| --- | --- | --- | --- |
| `packages/agent/src/process/agent-process-entry.ts:3127` | desktop | 是 | 唯一经 `openRun` 的 turn |
| `packages/agent/src/cli/index.ts:509` | cli (REPL) | 否 | 直接 `new duyaAgent` |
| `packages/agent/src/cli/index.ts:549` | cli (`--task`) | 否 | 同上 |
| `packages/agent/src/cli/index.ts:749` | cli (`--print`) | 否 | 同上 |
| `packages/agent/src/tool/SubagentTool/runAgent.ts:499` | subagent | 否 | worker 内嵌套 loop |

**非CP turn entry = 4**（H8.3 退役闸门的计数对象）；另有 7 个 look-alike（compaction/side-question/
TurnStreamRunner/vision/memory/title/search，同名 `AIClient.streamChat`），刻意不计入。

逐条结论：

- **automation/wake：已经在CP上。** `agent-run.ts` POST 到与渲染器同一个
  `POST /sessions/:id/chat`，router 走 `deps.runOrchestrator.openRun`（`router.ts:1256`），
  cancel 走 `DELETE` → `handleDeleteChat` → `cancelSession`。
  `NON_DESKTOP_CONSUMERS` 里「runId 只活在 session id 字符串里、从不进 runs 表」的记录**已过期**。
  剩余缺口只有一个：它读 SSE `done` 收尾，**没有读 `RunResult`**。
- **workflow `wf.agent`：没有第二条 loop。** 560 的 Go/No-Go 走了 Go（方案 A），
  `workflow-runner.ts` 的 `runAgent` port 绑到 `SUBAGENT_TOOL_NAME`，因此与 subagent **共用同一条私有路径**。
  身份是自建表的 `workflowRunId`，与 `agentRunId` 尚无关联。**未改动。**
- **subagent：`runAgent.ts:499` 在父 worker 内直接 `streamChat`**，是嵌套 loop 而非 child run，
  身份 `taskId`/`subAgentSessionId` 都不是 runId，**无 `parentRunId`**。
  worktree 仍消费 496 的 `SubagentTool/worktree.ts`，未重实现 Git 行为。
- **CLI 非交互 approval：不自动放行。** CLI 不传 `permissionMode`（`DuyaAgent.ts:851` 落回 `'default'`）、
  不接 `requestPermission`，故 `ask` 落到 `resolveAskWithoutUser` → `deny`。
  行为级断言（含「工具未被执行」的 spy）见 `packages/agent/tests/permissions/cli-approval-safety.test.ts`，
  关闭 fail-closed 分支会使其 8 条失败，已验证非空断言。
  遗留产品缺陷：`duya setup` 写 `permission_profile`（含 `bypassPermissions`/`dontAsk`），
  但 CLI 运行期**无人读它**（唯一读取点是 setup 自身的回显），该设置静默无效。
  方向是 fail-closed（更安全，不是越权），但属配置漂移，需独立决策后再接线。

**PR #178（H8.1）截至 2026-10-04 仍为 OPEN / CONFLICTING，未合入 master**：
`packages/agent/src/process/headless-run-host.ts` 在 `origin/master` 上不存在，
CLI 的 3 个 `streamChat` 站点因此仍在树内。H8.2 的 CLI 改造以 #178 落地为前置。

### H8.2 测量记录（2026-10-04 第二次核对，`2a375c1c`）——**取代上面那张行号表**

上面那张表是 #197 合并时的快照，**它的行号锚点已被 #198/#199 作废**。#199 把普查从行号改成符号锚点，正是因为行号在 consumer 一动就红。**现在的事实以本节为准**：

| consumer | turn 入口 | 经CP? | 判定 |
| --- | --- | --- | --- |
| desktop | `agent-process-entry.ts` 的 `handleChatStart` | 是 | 只经 `openRun` 到达 |
| cli | `headless-run-host.ts` 的 `createAgentExecutionChannel` | 是 | #198 起走共享 Run API，**不再是私有 loop** |
| subagent | `runAgent.ts` 的 `runAgent` | **否** | 父 worker 内的嵌套 loop |

**非CP turn entry = 1**（上面那张表写的 4 已作废）：CLI 的三个直接 turn 站点随 #198 消失；剩下的一个是 **subagent 嵌套 loop**，它没有自己的 run 行。
登记的行是符号三件套（`path` + 完整 `receiver` + 外层顶层声明 `symbol`），**不再记录任何行号**，并且**双向一对一**：一个锚点解析到两处即失败，所以新增调用点不可能被一条陈旧记录悄悄吸收。

**本切片亲测（`origin/master`，非引用交付 PR 的自报）**：`npx vitest run` 三个门禁文件 —— `h8-2-consumer-inventory`（7）、`headless-retirement`（7）、`run-entry-single-dispatch`（8）= **22/22 绿**。
退役登记 `LEGACY_RETIREMENT`：`remainingConsumers: 2`（worker `chat:start` + subagent），`removable: false`，`blockedOn` 仍写明 host smoke 无证据。

**上表逐条结论的现状**：

- **automation/wake：已由 #205 闭合。** 上面这段复核是**合并前**的观察，记录在此只为说明它被什么取代了——`agent-run.ts` 现在通过新增的 `GET /sessions/:id/run-result` 读 `RunResult`，把 `completed` 与 `cancelled`/`budget_exhausted`/`failed` 分开，null receipt 判失败而非回退到帧的意见。**权威记录在上面的「H8.2 进度」，本段不再维护该结论。**
- **workflow `wf.agent`：仍未改动。** 仍无 `workflowRunId` ↔ `agentRunId` 关联。
- **subagent：仍是嵌套 loop。** 但阻塞点比"再铺一次 `parentRunId`"更靠下：`parentRunId` **已端到端就位**，缺的是 worker→CP 的开 run 通道；且 child run 会跑在另一个 worker，进度/后台续跑/`subagent:kill` 三样都得改挂。
- **CLI 非交互 approval：不自动放行——已由 #197 变成有门禁的属性。** `cli-approval-safety.test.ts` 在 `origin/master` 上 **10/10 绿**（本切片亲跑），覆盖 `default`/`auto`/`acceptEdits`/`plan`/`bubble`/未定义/无法识别的 mode，只有 `dontAsk` 与 `bypassPermissions`——即**显式声明"不询问任何人"**的两个 mode——才放行。
- **`duya setup` 的 `permission_profile` 漂移：仍未接线（本切片复核属实）。** `packages/agent/src/cli/setup/index.ts` 里 `permission_profile` 只有两处——`:439` 读（setup 自己的回显）、`:450` 写；`packages/agent/src/cli/**` 其余代码一处都不读。方向是 fail-closed（更安全，不是越权），但接线会**新授予一条 bypass 能力**，需独立决策。


## H8.3 清理与兼容窗口

> **状态（2026-10-04 对 `2a375c1c`）：本节未开始，一条都不勾。** 但退役闸门的**阻塞形状已经变了**，记下来免得下一个 agent 重复推导：
>
> - 退役登记的实测计数是 **2**（worker `chat:start` + subagent），**不是零**。
> - 但闸门**不是"计数归零"就算过**。第一条条件是"每个剩余调用者要么是被点名的非 turn 模型调用、要么已被迁走"——而剩下两个**都是真 turn**，不是模型调用。所以计数本身满足不了它：worker 那个本来就只经 `openRun` 到达，是 shim 存在的理由而非遗留者；subagent 那个是嵌套 loop，**归 H8.2 的迁移，不是 H8.3 的删除**。
> - 真正变的是**阻塞的形状**：从"七行、其中五行永远迁不动"变成"一个已知 turn + 一个被许可的组合"。
> - **条件 2（打包与 host smoke）是活的阻塞，且未变**：packaged Electron 到达 agent-server `ready` 在本机产不出来，**也没有产出过**。
> - **条件 3（兼容窗口有证据）同样未满足**；本节自己的措辞就拒绝拿"过了一周"当消费者证据。
> - **本节未退役任何东西。** `removable: false`，且门禁会拦住任何把它改成 `true` 的尝试。

- [ ] 消费者清单逐项归零：agent旧exports、aiwire再导出、CLI旧barrel、legacyworkercommands、main→agent实现、router自有seq/ring/双dispatch。
- [ ] shim保留release版本/使用指标和删除任务；至少一个兼容发布窗口实际过完，不以“经过一周”代替消费者证据。
- [ ] 在legacy读取路径尚可回退时停止新增写；schema收缩另PR，先rehearsal/backup/旧reader退出。
- [ ] 旧agent完全无剩余职责后删除package、buildscript、exports与bundle入口迁移；不能先删包再发现modes/工具仍引用。
- [ ] packageassets/nativeSQLite/BashWorker路径迁移同步build和packaging；不复制node_modules当生产修复。
- [ ] baseline只删除已消除fingerprints；managed新包zero容忍，fullsuite债有单独owner并尽量归零。

## H8.4 最终验收

> **状态（2026-10-04 对 `2a375c1c`）：未开始，一条都不勾。** 表中 **Packaged Desktop 与 CLI 两行仍是 `unsupported`**——本机产不出 packaged Electron（磁盘），E4.4 第2条的 live provider 也无 key。Desktop 行的真实 turn 证据见 [05 阶段文件](05-behavior-and-evals.md) E4.4，Automation/Workflow 行**待 H8.2 迁移完成后**才可能有闭环证据。

| Host | 实际运行证据 |
| --- | --- |
| Desktop | 真实Electron、providerchat、approval/stop/reconnect/recovery、runs/events |
| Packaged Desktop | resourcesbundle/assets/native依赖完整，firstchatready，无modulemissing |
| CLI | 干净环境启动、offline/live已声明范围、非交互policy、恢复后产物 |
| Automation/Workflow | trigger→CP→runtime→terminal/outbox闭环及duplicate-trigger |
| Evals | 同API、无Desktop后端import、固定case/extendedreport、失败可归因 |

- [ ] clean多平台typecheck/build及requiredchecks，完整test无新增失败；capability与host支持范围逐项一致。
- [ ] ARCHITECTURE写实际owner/进程/DB/wire，packageREADME/exports同步；不把target图当current图。
- [ ] 迁移映射、旧任务清单和log全部有完成/显式后续归属，删除重复执行入口。
- [ ] 整个587目录移completed，项目索引移除Active row；rootRFC和docsarchitecture入口更新到completed位置。

## PR 与回退

H8-ACLI/headlessadapter；H8-Bautomation/workflow/subagent接管；H8-C退出旧wire/exports；H8-Dpackaging+deletelegacy；H8-E文档/gates收口。

退役前最后一个稳定兼容版本作为rollback点；数据保留compatible reader，外部副作用不通过gitrevert撤销。不能使用force/reset覆盖共享工作树。最终host能力可以不同，但其supported与限制必须真实且可探测。
