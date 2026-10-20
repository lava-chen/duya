# 610 — 架构收口系列

> **把 600(分层落地)、601(控制平面倒置)、602(持久层)合并成一条可执行的主线。**
> 本文件是这三者的**唯一状态源**。600/601/602 各自的 README 保留为契约与推导过程,
> 但"现在做到哪、下一步做什么"只在这里回答,且只回答一次。

## 本轮交接（2026-10-17）

**执行队列的唯一入口是 [19 — 快速执行队列](./19-fast-track-queue.md)。**
它把 17 的 S0–S9 成果级切片切成 PR 级 T 卡，每卡带独占路径、首个失败证据、验收命令。
排期只从 19 的 §11 追踪表读取。

Wave 3 的首轮独占路径与细化合同见 [22 — Wave 3 首轮执行](22-wave3-dispatch.md)。
T30 先落 App 声明；T31a 是 bridge kernel，T40a 是本机 Web BFF。
两者仍需要后续的生产调用与浏览器验收，不以这一轮代表完整 T31/T40 完成。

T31b 的 Host→worker 调用后端切片见 [25 — Wave 3 App invocation](25-wave3-app-invocation.md)：
Host 拥有 binding、授权复查与 worker 命令通道，但 Desktop 可信 resolver、
iframe→Main 边界与双实例样例仍未接线，T31/T32 不因此完成。

共享 Agent 平台的架构裁决（职责边界、Rust 取舍、唯一执行事件序列）见
[17 — 共享 Agent 平台执行计划](17-shared-agent-platform-execution.md)。
**17 §5 的切片状态已过期**：S0 已收口、S1 基本落地（`15fa4850` / `cdee21d5` /
`a935741f` / `ac1f5183`），文档仍标 `Ready` / `Waiting`。不要再从 17 取“下一步”。
既有退役工作继续按消费者和验收条件收尾，不因 19 的队列重排而暂停。

用户反馈“工具调用或多步执行中途停下”，诊断派工见
[18 — Runtime Harness 能力退化排查](18-runtime-harness-diagnostic-plan.md)。
先执行 H0/H1，定位工具结果到下一轮模型请求之间首次偏离；与 S1 安全收口分开取证，
不在根因未明时增加自动继续或扩大重构。

三端（TUI / agent 执行层 / Desktop）的当前实测红绿基线与缺陷分类见
[20 — 三端深度排查](./20-three-surface-bug-sweep.md)。**读红绿数字只从它读**：
实测 124 条红里只有 10 条指向真实产品缺陷（D1 legacy-only run 以 `completed` 结算且
台账为空 / D2 `worker-frames.ts` 重复死分支 / D3 `live-ring-refresh-frame` 守卫失去
分辨力 / D4 skill 优先级 plugin 与 plain bundled 同分、胜负看发现顺序 / D8 被拒绝的
工具调用在 TUI 转录本里不留任何痕迹 / **D9 [HIGH] 被拒调用的「报告」是协议非法的
孤立事件，`RunLedger` 判 `tool_completed_without_start` 抛异常，`#mint` 转成 refuse
返回值，而 `RunEventStorePort.publish` 的签名是 `void` —— 流、转录本、`danglingToolCalls()`
三处全都没有任何记录，且引擎原则上无从得知这次丢弃** / **D10 [MED] census 里
`permission.resolved` 的生产者是幽灵 `RunController.respondPermission`（真方法叫
`respondToPermission`），而「每行都指向存在的代码」那条守卫只验文件路径、丢掉符号** /
**D11 [MED] `normalizeWorkerEvent` 两份独立实现，其中一份的注释声称它们是同一个** /
**D12 [MED-HIGH] `createIsolatedWorktree` 两份实现，生产跑的那份零测试，
测试守的是已不可达的另一份**），
外加一条**曾被实现搬家掏空的覆盖（D6，已闭合）**：Desktop `run-orchestrator.ts` 变成
`@duya/host` 垫片后，「run 行先于派发落地」与「并发会话互不串 run」两条保证全仓失去
唯一用例，现已在新文件
`packages/host/tests/worker-product-runtime/run-open-durability-and-isolation.test.ts`
按新机制重述并做双向变异证明。**D7 是它的推广版且更严重**：Desktop 主进程 9 个测试文件里
`new RunOrchestrator(` 出现 19 处，只有 `terminal-publication-barrier.test.ts` 一处接了
`nativeWriter`；其余 8 个推的全是 legacy `chat:*` 帧并断言它们会落成 durable log ——
**那正是权限翻转刻意删掉的契约，接线也救不回来**。于是「Reference Run, closed」与
「run-create-ack real bridge」这两份**仅有的真桥接闭环证明**守的是一个已废除的主题，
**Desktop 侧原生路径闭环从未被证明过**。已新增
`apps/desktop/src/main/__tests__/desktop-native-run-closed-loop.test.ts` 补上
（首次运行 2/2 绿，即生产接线本身是通的），并用「拿掉 `nativeWriter`」这个 D7 缺陷本身
做变异证明。桌面端 ~70 条同源于 IPC 转发层迁移后**覆盖归零**，不是 70 个 bug。

**D9 是本轮证据最硬的一条，且是唯一做了双向证明的缺陷。** 它的目标合同以
`it.fails` 承载（本仓库首次使用该记法），只断言三个候选修法**共同**的性质，不钉具体
事件形状；因为 `it.fails` 的 body 对任何抛错都算通过，所以额外验了「今天因目标断言
失败而通过」与「临时修好生产分支后报 `Expect test to fail`」两个方向，变异后
`run-engine.ts` 按 SHA-256 逐字节还原。**过程中被一个对照组救下来的错误结论**：
第一次测到该 run settle 成 `runtime_crash`，差点报成「拒绝会把整轮跑崩」的 HIGH，
但允许的对照组 settle 成完全一样 —— 那是 harness 固有形状，与拒绝无关。

**D10 是 D9 的结构性成因。** 协议里那条为「记录一次拒绝」而设计的 durable 事件
`permission.resolved` **没有生产者**，引擎才被迫退用协议非法的 `tool.timed_out`。
`run-session.ts:337-344` 与 `control-plane-census.ts:171` 为此互相打脸，且都自称权威。
它的成因是一条**只验一半的门禁**：`splitRef` 返回 `{path, symbol}`，`symbol` 半只在
`schema` 字段上被验，`producer`/`handler`/`consumer` 点名的代码改名了也不会红。
70 条引用中 27 条是严格 `path:Class.method`（可机械校验），**恰好 2 条失败、25 条通过**；
另 43 条混散文，从哪截断附注属作者约定，本轮不动。
**§D10 已闭合（2026-10-18，本系列第一条真正改生产代码的闭合）**：两行幽灵指针已修
（`git diff --stat` = 2 增 2 删）。执行顺序是**先等信号再删 `.fails`**——修完跑测试拿到
`Error: Expect test to fail` 才动手删，因为 `it.fails` 不会因碰巧通过而失效，
所以「合同成立了」是被**宣告**的而不是被假定的。变异证明（本系列第一次对生产代码做）：
改回幽灵名 → 2 failed 变 **3 failed**，新增那条的失败信息**逐字点名两条幽灵引用**；
改回后哈希 `9FA215EE…A81A` 逐字一致。闭合后该文件 2 failed / 73 passed，
那 2 条正是进来前就红的 `workflow_run` / `research_updated`（另一条独立守卫，无关）；
`packages/agent-runtime` 全量 2 files / 3 tests / 1067 passed，红数与基线一致。

**这条闭合的意义不在那两行，在守卫**：守它们的 `every row points at code that exists`
**名字比它做的事强**——它只验文件路径存在，指针可以指向任何东西而它照样绿，
这正是幽灵能同时出现在两行、而守卫两次放过的原因。**今天起它会验符号了。**

**§D9.4 查实了 D9 最后一个未决项，并修正了我自己 §D9.3 的断言重点。**
⚠️ **本节的结论已被 §D9.7 更正适用范围**——逐跳接线仍成立，但那条路挂在 orchestrator 腿
而它在生产里不可达，所以「生产里 request 会入账」不成立。
legacy `chat:permission` 帧逐跳走到 `RunController.observeFrame` 并落进**同一个 ledger**
（`sendToMain` 同时 `process.send` 和 `sendEvent` → router `normalizeAndObserve:782`
→ `observe` → `observeFrame`），所以修法**不必**让引擎补发 `permission.requested`
（那反而会撞 `permission_requested_twice`）。
但生产帧里**没有 `toolCallId`**——`createPermissionHandler` 发的是 `{id, toolName, …}`
且 `id` 就是 `approval.callId`，所以那条链接走 **`requestId`**。
已把用例改成生产真实帧形并把 `toolCallId` 缺席钉住，免得后来的人照可选字段实现。

**§D9.5 补上了第二个验收点，「记录」与「用户看见」分开坏。**
ledger 侧整条拒绝被丢（D9）；投影侧就算 ledger 修好也会在**下一层**再丢一次——
`projectHostEvent` 有 `permission.requested` 的 case、没有 `permission.resolved` 的 case，
`default:` 返回 `null`。契约**只断言「投影器为它产出一个 frame」**，不钉转录本长什么样
（关 overlay / 加一行 / 标工具行都合法，钉一种就是预判还没做的决定），
事件形状取自协议自己的 fixture，双向证明已做。
**两个验收点都要过**，只修 ledger 会得到「有记录但看不见」。

同轮踩到一个还原陷阱：`host-event-stream.ts` 当时是**脏的**（并行 session 在加 `effort`），
`git checkout --` 会把别人的在途改动一起回退；改用**反向替换 + SHA-256 比对**，
还原后并行 session 的改动完好无损。**共享检出上，脏文件一律不走 `git checkout`。**

**D11 [MED]（追接线时撞上）**：`normalizeWorkerEvent` 有两份独立实现
（`packages/host/src/worker-frames.ts:28` 与 `apps/desktop/.../router.ts:505`），
各自被不同调用方使用，而 `run-execution.ts:24` 的注释写着「**the SAME normalizer** the
Desktop router uses」——**它不是同一个**。实测 host 39 臂 / router 35 臂，
`chat:text_delta` + `chat:thinking_delta` 只在 host 那份有（正是 D2 记的那段重复死分支）。

**D12 [MED-HIGH]** 是本轮收尾定性那批桌面红时撞上的：
`createIsolatedWorktree` 有**两份实现**——生产跑 `packages/host/worker-subagents/worktree.ts`
（`service.ts:53` 导入），而**唯一的 worktree 测试跑的是 `packages/agent` 那份**（已不可达，
其 `SubagentTool.ts` 已是 "Compatibility exports" 垫片），**Host 侧零测试**。
194 / 197 行，常见路径落到同一数据根，但 `DUYA_DATA_ROOT` 与 `DUYA_APP_DATA_PATH`
**同时**设置时优先级相反——**用户撞到的是活的那份，被测的是死的那份**。
先否掉过一个更严重的结论（以为两份会把 worktree 建在不同目录、隔离承诺不一致）。
**调用点普查把它从推断变成已证**：全仓 `createIsolatedWorktree(` 的生产调用点**只有**
`service.ts:434`，其余全是那个测试文件自己的调用 ⇒ 「agent 那份生产不可达」是事实。
`h8-2-consumer-inventory` 里那条名为「worktree … **consumed not reimplemented**」的红
正是**因为它的前提变成了假的**——它报警报对了。

**那批 10 条红本轮全部定性完毕**（此前我记成「3 条未定性」，数字错了）：
`automation-fire-persistence` ×3 是**过期 mock**（生产调 `wakes.listPendingWakes()`，
mock 里只有 `listAll`）；`h8-2-worker-run-channel-seam` ×2 是**过期测试**（生产加了
attempt 围栏，用例的 `run:complete` 没带 `epoch`，实测拒绝原文明写
「a run write with no attempt is refused rather than made unfenced」）；
`h8-2-consumer-inventory` ×4 是漂移的普查表，其中一条指向 D12。
**但那两条过期测试留下一个覆盖空档**：名为「takes the child to a durable terminal that the
run layer will answer for」的耐久性保证在失败处就停住，**今天实际无人验证**
（**该空档已在 §D13 闭合**：按 D6 的做法用活的机制重述，首跑即绿 + 变异证明）。

**§D13 补上了第三条被掏空的保证**：child 走到 durable terminal、且**父 run 不被连带结算**。
新用例复用 D6 那套真装置（真 `RunOrchestrator` + 真 `RunController` + 真 SQLite `RunStore`），
从数据库读回 `parent_run_id` 证明链路持久，父行按**正面主张**断言（仍 `running`、
`finished_at` 为 `null`）——结算子 run 时顺手结算父 run，会让「子代理跑完一轮」
看起来像「整段对话结束了」。变异（在 harness 里让结算连父一起结算）→ 只有这一条转红。
同目录合跑 19 files / 117 tests / 5 红，与进来前**逐字相同**（116→117 即新增那条）。

同轮踩到一个关于**哈希校验本身**的坑：还原脚本的基线哈希是每次调用重算的，
而 `restore` 那次记的是变异后的值，于是正确的还原被报成 `HASH MISMATCH`。
**基线必须一次捕获并持久化**——否则「不一致」这个信号同时表示「还原破坏了文件」
和「我的记账错了」，两者不可区分。这次靠三条旁证（无残留文本 / `settleRun(` 只 1 处 /
CRLF 计数一致）确认还原是对的。

**一条带过六轮的错误结论，已更正。** 我从第一轮起反复写「adapter 的 `__binaryResponse`
传输路径**零覆盖**」，还把它挂成待办六轮——**它错了，而我从没验证过**。
`tool-protocol-adaptation.test.ts` 有真 `new Response(sseBody)` 夹具，`:311`/`:346`
两条专门针对 Plan 418（畸形帧被跳过、可修复帧被修复），实测 4 passed。
真正缺的只是**真 HTTP 传输**（自建服务器、真实分块与背压），响应体处理**是有覆盖的**。
**教训：看一个既有结论值不值得信，看它被复述了多少次，而不是被验证了多少次。**

**D12 补记**：那份守死副本的 worktree 测试**实测 6 passed**（907ms 的真实
`git worktree` 操作）——它们守着一份生产从不执行的副本，绿得毫无意义。

**§D12 已闭合（2026-10-18）：6 条已搬到你用户跑的那份实现上，并补了一条死版写不出的。**
新位置 `packages/host/tests/worker-subagents/worktree-isolation.test.ts`，**7/7 绿**。
逐行对齐也做完了（上一节欠的）：两份各 194/197 行，**190 行逐字相同**，
只差 2 处 import 和 `worktreeBaseDir` 末行——所以**隔离承诺本身没有分叉**。
「同时设置时优先级相反」这条**核实为准确**，机制是死版那个 `getDuyaRoot` 是个 re-export
→ `getManagedShellDataRoot`（`managed-shell/paths.ts:6-12`），条件是
`!DUYA_DATA_ROOT && DUYA_APP_DATA_PATH`；活版则是 `DUYA_APP_DATA_PATH || resolveDataRoot()`。

新增那条**只有活版写得出来**（死版的行为就是相反方向本身，表现不出差异）：
两个变量都设置时活版服从 `DUYA_APP_DATA_PATH`。顺带查清一个真实后果——
设了 `DUYA_DATA_ROOT` 的用户若同时残留 `DUYA_APP_DATA_PATH`，**worktree 落旧根而数据库落新根，
「一份数据」分两处**。这是有意的（注释明写「Keep the historical application data override」），
所以**记录不报缺陷**，但此前两边都没测过。

变异证明**故意做成精确形状**（反转优先级但保留后备）→ **7 变 1 failed**，
唯一红的就是新那条，**前 6 条两个方向都绿**（同时证明迁移等价、测试没因搬家变弱）。
保留后备还有个安全理由：worktree 始终落在临时目录；直接改成 `resolveDataRoot()`
会让变异态往用户真实 `~/.duya/worktrees` 写 worktree——**变异不该给用户机器留垃圾。**
还原按字节校验 `BAA8A9E2…F9F72` 一致。**生产代码零改动。**

**仍未做**：死副本 `packages/agent/.../worktree.ts` 还在，它那 6 条测试也还在跑。
删它属退役动作、且在 `packages/agent`（并行 session 可能涉及），本轮只报告不删。

**§D9.1 / §D9.2 把 D9 的修法从「三个候选待选」收敛成了一条，并把它验穿了。**
协议自己在 `legacy/sse-event.ts` 里写明了 `permission.resolved` 的存在理由：
「The legacy surface had permission_request and no resolution event, so an
answered or timed-out permission **left no audit trail**」——**缺口早被识别，事件早被声明，
ledger 早强制了配对，只是没人发**。词典（`LEGACY_PERMISSION_ACTION_MAP`）与 Desktop 侧
`recordPermissionDecision` 都已现成，**缺的只是「发成一条 run 事件」**。而归属问题也不再是
口径问题：Control Plane 那条路只覆盖 Desktop 两个 surface，**TUI 完全不走它**。
三方向实测：只发 `permission.resolved` → **仍被 ledger 拒**（`permission_resolved_without_request`，
和现在的 `tool.timed_out` 撞同一个坑）；**成对发布** → 合同翻绿 ✅。
另外查出 TUI 投影器没有 `permission.resolved` 的 case（`default: return null` 静默丢弃），
所以**光发事件 = 有记录但看不见**，投影侧必须一并改，否则用户仍无感。

**§D9.3 用真实 `RunController` 查实了那个未验证项，并抬高了一条约束的等级。**
好消息：legacy 的 `chat:permission` 帧**确实**经 `observeFrame → translateFrame →
active.emitter` 落进**同一个 `RunLedger`**（`controller.ts:537/554/832`），且 `toolCallId`
在翻译中存活——**所以引擎不必自己发 `permission.requested`**。
坏消息（变异实测出来的）：若在 request 缺失时发 `permission.resolved`，返回的不是 `null`
而是 **`run.failed`**——**不是丢事件，是把整个 run 判死**。
因此实现顺序必须是「确认 request 已入账 → 才发 resolved」，而不是反过来。
这比今天静默丢弃更糟，所以它现在是**硬约束**而不是注意事项。

**§D9.6 把上面那条「好消息」推翻了一半，而推翻它的是实测。** 追「生产里谁真的发那条
`chat:permission` 帧」时撞到 `gateRunApproval`（`worker-run-composition.ts:207-215`，
由 `worker-engine-driver.ts:202` 绑成 `ports.approval.authorize`）：

```ts
void askApproval;   // ← host 那个会发 chat:permission、会 await 人回答的 approver
void signal;
return { allowed: true, scope: 'once' } as const;
```

内层 approver 被**显式 `void` 掉**，不是恰好没被用到；而闸门只拦 `behavior === 'deny'`，
`buildPermissions` 用来表示「这个要问人」的 `'ask'` 正好落在放行那一支。

新增 `packages/host/tests/worker-product-runtime/gate-run-approval-reachability.test.ts`
（4/4 绿 + 双向变异 2 failed/2 passed + 按字节还原 `6D8510DF…13B6`，**生产源码零改动**）：
① `ask` → `allowed: true`；② `ask`/`allow`/`deny` 三档下内层 approver **0 次**被调；
③ 只差一个变量的 `deny` 对照组确实走到另一条分支。

**净推论：engine 腿上经由 `ports.approval.authorize` 的用户询问根本不会发生**，
于是不会有 `permission.requested` 入账——§D9.2 那个修法在真实生产路径上会撞
`permission_resolved_without_request` 并**判死整个 run**，而不是修好它。
所以 **D9 的修法暂缓实施，先定口径**：engine 腿到底该不该有用户询问？
若本就不该有，那要记录的是一次**策略拒绝**，而 `permission.resolved` 按定义是
**用户决策**的审计事件，用它记策略拒绝是语义错配。`gateRunApproval` 的注释
（「the port is present because it is required, not because it decides」）说明现状是
**有意的**，所以这是口径问题不是待修 bug——**动 `run-engine.ts` 有把 HIGH 修成更坏的风险。**

**未验证**：legacy 腿（`StreamingToolExecutor` / `ToolExecutionPipeline` 同样拿
`canUseTool`）是否仍然问用户，本轮**没查**。所以「用户的审批意见被忽略」这句话
本轮**不成立**，不记成已验证。这条是下一步的第一优先。

**方法论，同族复发第二次**：这条用例第一版用返回 **allow** 的 approver spy，
变异后它**依然绿**——因为「gate 自己放行」和「gate 转发给一个同意的 approver」
产出完全相同的返回值。把 spy 改成**拒绝**后才有牙齿。
**守卫的强度取决于它给对照组留了多少空间，而不是它断言得多具体**
（第一次是 §D9.2 的谓词只收 `tool.` 前缀）。

同目录合跑 **20 files / 121 tests / 5 红**，与进来前的 19/117/5 **逐字相同**
（差值恰为新增这一文件 +4 条全绿）。

**§D9.7 把上面再推进一步，并更正了 §D9.3 / §D9.4 的适用范围。** 追「生产里谁真的发
`chat:permission` 帧」的结论是**没有任何生产者**，三条互相独立的证据同向：

1. engine 腿不调用用户的 approver（§D9.6，实测 + 双向变异）；
2. `packages/agent-protocol/GAPS.md:110-112` **仓库自己**写着「permission 流程是断的，
   **这是有意的，好过发一个假的**」，`worker-adapter.ts:192-196` 与之一致；
3. 唯一会把它翻译成 `permission.requested` 的 `observeFrame` 挂在 orchestrator 腿上，
   而生产注册的 **6 个模式零个带 `orchestrator`**（`modifiers/index.ts:15-20`）。

第 3 条不用 grep 服人：新增
`packages/host/tests/worker-product-runtime/orchestrator-leg-reachability.test.ts`
（**4/4 绿**）import 真实 `modifiers/index.js` 触发注册后**直接问注册表本身**，
配 3 条判别性对照（先断言注册表非空 / 注册一个带 orchestrator 的探针后同段代码能读出 /
   该字段确实让 `selectRunDriverLeg` 选中 orchestrator 腿）。
**未做生产变异**（要改在途车道文件），判别性靠同文件对照组，证据等级如实标注。

**被更正的是适用范围，不是实测**：§D9.3/D9.4 那两条 `RunController` 用例仍然是对的，
但 `observeFrame` 那条腿生产不可达，所以「修法可以依赖 request 已入账」作废。

**净结论与定位调整**：engine 腿**本就不该有人问**，D9 要记的是一次**策略拒绝**
而不是**用户决策**，所以补 `permission.resolved` 生产者这个候选**可以划掉**
（语义错配 + 会判死 run）。剩下的是选型问题（为策略拒绝另选事件，`diagnostic` 是候选），
仍需人拍板，但问题已从「怎么补生产者」变成「这类拒绝该记成什么」。
**同时要下调本条的紧迫性**：GAPS.md 与本报告两处独立记录同一事实，
说明这是**当初被有意切断、尚未接上的中间态**，不是本轮新破的管道。

## 当前状态（2026-10-13，退役协同工作树）

**610 仍为 Active，尚未完成。** A3 的生产轮次循环迁移已由 `4444c7cf` 落地并随 PR #262 合并；当前 `DuyaAgent.ts` 已没有 `streamChat` 方法。索引里“A3 是当前 next action”的说法过时。

**A4 前置清理已完成（2026-10-10）：3 个测试文件里 16 处旧 `duyaAgent.streamChat` 调用归零**（处置：`streaming-lifecycle.test.ts` 与 `AgentLoop.test.ts` 整文件删除，`DuyaAgent.test.ts` 剥离为纯状态用例；逐文件依据见 [90 执行日志](90-execution-log.md)）。六场景 runtime 层验收 **17/17** 同 HEAD 实测记录在同一日志。

**当前执行目标是用户明确要求的旧 Agent 全面退役**，由 [12 协同切片](12-agent-retirement-coordination.md) 记录有限迁移清单、文件所有权和验收证据。Host 已接管 worker 入口与产品装配，CLI 提供命令工具服务；新产物位于 `packages/host/bundle/worker-entry.js`。在旧目录临时移走的条件下，已重新构建 CLI/worker，并通过本机 OpenAI 协议夹具完成真实 CLI→Host→worker 的工具发现、文件读取和结果回传。Desktop 实际执行、完整门禁/回归、剩余旧测试及构建引用清理、最终删除仍未完成。A4 的 eval 及产品级失败变体仍需验收，不能因拆包或 stub worker 通过而勾选。新客户端、远端注册和非必要 schema 改造不进入本轮。

---
## 0. 为什么需要这一份

三份计划各自声明了**一个**"唯一 next action",而它们之间没有共同的编号空间:

| 计划 | 编号空间 | 声明的 next action | 文档在哪 |
| --- | --- | --- | --- |
| 600 | `S0`–`S7` | S2 循环迁出 | **只在 `docs/600-plan-archive` 分支上** |
| 601 | `A` / `B` / `C` | 写门禁 A1 并证明它现在红 | master |
| 602 | `Phase 0`–`3` | 写探针 `sqlite-compat-probe.mjs` | master |

三个后果,都是实测出来的,不是推演:

1. **`docs/exec-plans/README.md` 与 601 §8.2 里那句「600 的 11 份计划文档不在任何分支上」是错的。**
   它们在 `docs/600-plan-archive` 上,一直好好的。**一条关于"资料是否存在"的假事实,
   在索引里被引用了三轮计划。** 本系列把 600 文档落回 master,就是为了消灭这个单点。
2. **三份计划互相看不见对方的顺序约束。** 600 的 S6 被 602 的 Phase 2 卡住,
   而 601 声称 Phase B/C 要等 600 的分层 —— 但没有任何一处列出三者合起来后的**全局**顺序。
3. **602 的立论前提已经不成立**(见 §3),但它对 S6 的阻塞仍然编码在 600 的阶段表里。

---

## 1. 实测基线(2026-10-05,`origin/master @ 0967b2ee`)

> ⚠️ **本节整体已过期,勿直接引用(2026-10-06 标注)。** 它标的是 `0967b2ee`,已落后数轮合并,
> A1(#219 / `205a4cd4`)与 A2(#222 / `a046cdf6`)都已落地。保留原文是为了留下当时的判断依据,
> **不是当前基线**。当前可复跑的已核实事实见下方 §1.2。

所有数字都带 scope,都是本次现测,不是从对话记忆或旧工作树抄的。

| 断言 | 实测值 | 怎么测的 |
| --- | --- | --- |
| 分层门禁 | `932/932` tolerated,`architecture:self-test` OK | `npm run architecture:check` / `architecture:self-test` |
| 边界门禁单测 | **4 条红**(`boundary-gates.test.ts` G4/G7) | `npx vitest run scripts/architecture/boundary-gates.test.ts` |
| 切片分类 | **1 条红**(`compaction-seam.test.ts` 未分类) | `npx vitest run scripts/architecture/slice-classification.test.ts` |
| S2 引擎已落地 | `run-engine-model.ts` 36 KB + `run-engine-ports.ts` 27 KB 在 master | 文件实测 |
| S2 循环**未**迁出 | `DuyaAgent.ts` **255 KB**,仍在 `packages/agent/src/agent/` | 文件实测 |
| S1a 接缝 | `run-routing.ts` **不在 master**,在 PR #214 | 文件实测 |
| S5 六个新包 | `capabilities/connectors/memory/tooling/data/ui` **六个都不存在** | 目录实测 |
| better-sqlite3 | **N-API 插件**,非 V8-ABI;同一 prebuild 跨 Node/Electron 通用 | `package.json` + 双 runtime 实跑 |
| 600 计划文档 | 在 `docs/600-plan-archive`(1 ahead / 0 behind) | `git ls-tree` |

### 1.2 当前已核实的事实(2026-10-06,在 `205a4cd4` 上现测)

> 每个数字都带 scope,这是本系列 §4 第 1 条。

| 命令 / 断言 | 实测值 | scope | 备注 |
| --- | --- | --- | --- |
| `node scripts/architecture/boundary-gates.mjs` | `G7 NEW` —— known 0 / **new 1** / stale 0 | 整仓门禁,`205a4cd4` | finding = `DuyaAgent.ts` 被 `agent-process-entry.ts` 直达 |
| `node scripts/architecture/mutation-proof-a1.mjs` | **5/5** | A1 变异证明,`205a4cd4` | 含反向:撤掉链 → 门禁不报 |
| `node scripts/architecture/architecture-check.mjs` | `module-dependency-permitted` **370** | `architecture-policy.yaml:1182` 期望值,`205a4cd4` | `origin/master` 为 **375** |
| `npx vitest run scripts/` | **281/284 in scripts(14 文件)** | `scripts/`,`205a4cd4` | 3 条红:2 条 `boundary-gates` + 1 条切片分类 |
| `isTurnLoopModule` 去注释后逐子句 | `DuyaAgent.ts` = **3/3** | 单模块,`205a4cd4` | `ports.ts` = **1/3**(见 [90 日志](90-execution-log.md)) |

> ⚠️ **本次没跑成、因此不要当基线用的:** `npm run architecture:check` 的「无新增」在无
> `node_modules` 的检出上**测不出来** —— `core-io` 扫描会报 `vite-node not found` 并自造一条
> 未基线化 finding(`205a4cd4` 上:total 931 / tolerated 930 / new 1,new 的就是这条环境产物)。
> **门禁数字离开它自己的工具链就没有意义**,这和 `640/647` 那类数字是同一个病。

> ⚠️ **S2 两个文件的真实位置此前写错(2026-10-06 实测)。** 原文说它们「在 master」,
> 但没说清在哪个包。实测:**在 `packages/agent/src/process/`**,不在 `packages/agent-runtime`。
> - `run-engine-model.ts` —— **729 行 / 36122 字节(35.3 KiB)**
> - `run-engine-ports.ts` —— **556 行 / 26986 字节(26.4 KiB)**
> - 同目录还有 `model-leg.ts`、`TurnStreamRunner.ts`。
>
> `packages/agent-runtime/src/engine/` 里实际是:`run-engine.ts`、`ports.ts`、`port-guards.ts`、
> `compaction.ts`、`request-scope.ts`。怎么测的:目录列举 + 逐文件行数/字节数;
> 并用 `git log --all --diff-filter=A -- packages/agent-runtime/src/engine/run-engine-{model,ports}.ts`
> 确认**没有任何 ref 上它们曾在 `agent-runtime/src/engine/` 下存在过**(新增提交为空)。

> ⚠️ **`DuyaAgent.ts` 的体量此前两处不一致(2026-10-06 实测)。** 现测:**5295 行 / 255371 字节**
> (= 249.4 KiB,按 1000 进制是 255.4 kB)。原文「255 KB」在 1000 进制下成立,
> [90 日志](90-execution-log.md) 里的「5011 行」是更早一轮的旧值。

### 1.1 真正的瓶颈:门禁 G7 指错了方向

> ⚠️ **本小节描述的故障已由 A1 修好(2026-10-06)。** `isTurnLoopModule` 现在能认出
> `DuyaAgent.ts`(去注释后 3/3 合取)。下面保留的是**故障现场**,用于说明 A1 的依据;
> **不要再拿它当现状** —— 现状见 §1.2 与 §5.1 的 A3 更正。

`boundary-gates.test.ts` 里 G7 的两条红**不是"S2 还没做完所以红"**,是**门禁本身坏了**。
`reachability catches the loop behind the adapter` 是用合成 fixture 测检测器自身的用例,它也红。

直接调用检测器得到的实况:

```
输入:fixture 的 entry.ts -> adapter.ts -> packages/agent/src/agent/DuyaAgent.ts
可达闭包: 含有 DuyaAgent.ts(确实可达)
findWorkerLoopReach() 的 finding:
    packages/agent/src/process/agent-process-entry.ts   <-- 入口自己
    via packages/agent/src/tool/MessageSessionTool/MessageSessionTool.ts
```

两件事同时成立:

- **`isTurnLoopModule` 认不出真正的循环**(`DuyaAgent.ts` 可达却不是 finding);
- **它反而认出了 `agent-process-entry.ts`**,而那正是门禁要保护的那个入口。

于是 S2 的完成定义挂在 G7 上,等于挂在一个**指错方向的判据**上:
G7 既不能证明循环迁出了,也会把入口报成违规。这个状态下继续堆 S2 的代码,产出的"完成"不可信。

---

## 2. 唯一 Next action

> ⚠️ **本节已过期(2026-10-06)。** 原文的唯一 next action 是 A1,**A1 已合并**
> (PR #219 / `908b5baf` / `205a4cd4`),A2 也已落地(PR #222 / `a046cdf6`)。
> **当前每片的 next action 见 §5.1**,不要再从本节取。保留原文是为了说明当初为什么先做 A1。

> **A1 — 修 `isTurnLoopModule`,让 G7 能真正识别 turn loop 且不误报 worker 入口。**

选它的理由不是它最简单,而是**其余每一片的验收都依赖它的可信度**:

- S2 完成的定义是 G7 转绿;G7 现在指错方向,这一定义不成立。
- 它无前置,改动面小,可变异证明。
- 本系列自己在 §4 立了"门禁必须能变红也必须能变绿"的规矩,第一片就得先让自己合规。

**完成标志(全部可复跑):**

```bash
npx vitest run scripts/architecture/                 # 4+1 现有红全部转绿
npm run architecture:check                          # 932/932 tolerated,无新增
npm run architecture:self-test                      # OK
```

**必须做的变异证明:** 造一个"真循环藏在三层 adapter 后面"的 fixture,确认 G7 变红;
撤掉后确认恢复绿。只证明"当前 fixture 变绿"不算数。

---

## 3. 对三份输入计划的更正

### 3.1 三份计划已收成本系列的三章

**2026-10-05 起,600 / 601 / 602 不再是独立计划。** 它们此前各有编号空间
(`S0–S7` / `A–C` / `Phase 0–3`)、各声明一个"唯一 next action"、且互不引用对方的顺序约束。
那不是三份计划,是**三个互相不知情的真相源** —— 索引里并排列了三行,
任何人读索引都会拿到三个互相矛盾的"下一步"。

现在的结构:

```
docs/exec-plans/active/610-architecture-series/
  README.md                        ← 唯一入口,唯一 next action
  01-layered-architecture/         ← 原 600,11 份。README §4 已冻结为历史契约
  02-headless-control-plane/       ← 原 601,6 份
  03-sqlite-driver/                ← 原 602,4 份
  10-slice-a1-g7-loop-detection.md
  11-slice-a0-client-runtime-axis.md
  90-execution-log.md
```

章节内的相对链接全部保持有效(同目录兄弟文件互相引用),跨章引用已逐条重写并**实测零断链**。

`docs/600-plan-archive` 分支保留,不再是任何东西的"唯一存在处"。

### 3.2 602 退出关键路径,S6 解封

600 原文有一条「S6 排在 602 Phase 2 之后」,理由是:602 Phase 2 要把 **177 个文件**
改成从兼容层 import(纯机械),而 S6 要改同一批文件的业务逻辑(语义),
机械在前语义在后,S6 改的每行才不会被 602 再动一次。

**该约束的唯一目的就是这个。** 而 602 的前提已被实测推翻:

| 602 的前提 | 实测 |
| --- | --- |
| `better-sqlite3` 是 V8-ABI 原生模块 | **它是 N-API 插件**(依赖 `node-addon-api`) |
| Node 与 Electron 需要两份不同的 `.node` | 同一个 `prebuilds/win32-x64.node` 在 Node 24.16.0(ABI 137)与 Electron 44.2.0(ABI 149)下**都加载成功**,SQLite 3.53.4 |
| 需要 `ensure-sqlite-abi.mjs` 来回换二进制 | `lib/binding.js` 先读 `prebuilds/`,而 `build/Release` 在标准 `npm ci` 后**根本不存在** |

**结论:602 剩下的价值只是"删掉一个原生依赖",不再是"逃出 ABI 牢笼"。**
约束失去了存在理由,**S6 不再被 602 阻塞**。600 README 已就地标注撤销。

602 本身**不取消**,降级为可选旁支 C1(见 §5)。它是"值得做",不是"挡着别人"。

### 3.3 索引里的过期论断

`docs/exec-plans/README.md` 表格里「587 — **唯一架构重构入口:G0.1**」一句已过期。
600 的门禁 S0 与 S2 栈都已合并,该入口说法连同"600 文档不在任何分支上"一并更正。

---

## 4. 本系列自己的门禁规矩

从 587/600 一路踩下来的,写在这里对本系列生效:

1. **门禁数字必须带 scope**,格式 `<通过>/<总数> in <scope>`。裸数字不可判读。
2. **每条门禁必须做变异证明**:制造它要防的那种回归 → 确认变红 → 完全回退 → 确认树干净。
   没做变异证明的门禁**不算存在**。
3. **拒绝恒等式断言**。断言里出现 `a === a` 形状的比较(拿测量值比测量值)就是红旗。
4. **绿不得等于"没检查到"**。`ok=0 bad=0` 往往意味着没检查到任何东西,不是全部通过。
5. **门禁必须能变红也必须能变绿**。只会红的门禁挡不住绕过;只会绿的门禁没有意义。
   ~~G7 现在违反的是第 5 条的后半段(它红,但红在错误的文件上)。~~
   **这条在本系列被违反过三次,每一次都不是"门禁太严",而是"断言写错了":**

   | 症状 | 真实问题 |
   | --- | --- |
   | G7 红在 `agent-process-entry.ts` 而不是循环上 | 判据从"按职责"漂成了"按拼写" |
   | 把循环搬去 `packages/agent` 或 `agent-runtime`,G7 从 1 变 2 | 判据不可满足(worker 入口是进程根),该改判据 |
   | `boundary-gates.test.ts` 用 `toBeGreaterThan(0)` 把 G7 钉死为红 | **断言锁死了"当前结论"而不是"判据本身",于是任何正确修复都会让测试失败** |

   第三条是这三条里最贵的:它让门禁无法被修好,而不只是报错了地方。
   **写门禁测试时,断言判据(每条 finding 都有文件与来源、有界深度必须找得到东西),
   不要断言当前结论(现在恰好是红的)。**

6. **判据必须抗改名。** **这条是本系列自己踩出来的,代价是连续两轮返工。**

   G7 曾经是三个**名字**子句的合取(`repetition` ∧ `modelStream` ∧ `toolExecution`)。
   合取可以被**删除**满足 —— 实测:只删掉 model-leg 的名字标记
   (`buildTurnModelLeg` / `TurnModelLeg` / `ModelPort`),`isTurnLoop` 就变 false,
   **而 1476 行循环原封不动**。那个 model leg 本来就是死代码
   (`agent-process-entry.ts:3032-3036` 记录没有活跃调用方传 `modelLegs`),
   所以那次删除是行为保持的 —— 也就是说,门禁被一行改名骗过了。

   这与 `ports.ts:12-15` 记录的假绿是**同一个东西**:
   "passes the old acceptance gate while the loop has not moved at all"。

   **判据一旦由名字构成,它的强度上限就是"对方不去改那个名字"。**
   所以:能结构性判定就不要用名字判定。
   现在的 G7 判据是**一个循环体里至少驱动两条 async 流到耗尽**
   (同一个 `{}` 内 ≥2 个 `for await`),**不含任何标识符** ——
   只读 `for` / `await` / `{` / `}`。选择度 2250 个源文件里命中 1 个。

   **写完门禁必须做的一件事:把它的标识符全改掉,确认它仍然报。**
   这一步跳过,门禁就只是"看起来在检查"。

   **已消解(2026-10-06):A1 修好判据后,G7 红的文件是对的** —— 它现在红在真正的轮次循环
   `DuyaAgent.ts` 上。那条 finding 属 A3,且**不应该用 `--write` 吞掉**(§4 第 4 条)。

---

## 5. 切片表

`A` 线是主线(执行归属),`B` 线是控制平面倒置,`C` 线是可选旁支。

| 切片 | 内容 | 前置 | 门禁 / 验收 |
| --- | --- | --- | --- |
| **A1** | ~~修 `isTurnLoopModule`,G7 双向可信~~ **已完成(PR #219)** | 达成:`mutation-proof-a1` 5/5;G7 判据可信 |
| **A0** | **客户端运行时轴**:`@duya/ai` 去掉 `node:crypto`、`@duya/plugin-core` 二分为 schema/loader、`conductor` 开 `./renderer` 子路径 + 门禁 **G10** | 无(可与 A1 并行) | 从浏览器入口出发的 import 闭包不含 Node 内建;须能变红 |
| **A2** | ~~合 PR #214~~ **已完成(PR #222)**,含一个 TS2393 修复 | — | 达成:计数 370 → 375,5 条全部 declared |
| **A3** | S2 循环迁出:迁走 `streamChat` 轮次循环,使 `isTurnLoopModule(DuyaAgent.ts)` 变 false(**不是**只搬 `ToolExecutionPipeline`,见 §5.1 A3 更正) | A1, A2 | **G7 在 live tree 上转绿**,且 finding 指向迁出后的真实归属 |
| **A4** | S4 同引擎接 CLI / eval | A3 | 多轮、工具报错、取消、存储拒绝、worker 退出、慢消费者 |
| **A5** | S5 六包逐切片迁移(L3 宿主) | A4, **A0** | 每迁一块切断旧依赖并验证真实消费者 |
| **A6** | S6 Session data contract | A5(**不再等 602**) | 回填 / 恢复 / 兼容证据齐备后才删旧关系 |
| **A7** | S7 facade 退役 | A6 | `packages/agent` 消费者归零后删除 |
| **A8** | **客户端轴**(2026-10-16 新增):新建 `packages/client-core`,把 `SurfaceModel` 从 `agent-runtime` 移进去 + 定义 **L1.5 客户端状态层** + 门禁 **G11** 客户端反向依赖 | A0;**A7 落地前必须先合 A8.1** | G11-1 闭包不含 `@duya/agent-runtime`(三向变异);G11-2 事件词汇数 == 1 —— 见 [15 切片 A8](./15-slice-a8-client-core.md) |
| **B1** | 601-A 门禁:6 个 handler 的模块加载期 Electron 依赖 | 无(可与 A 线并行) | 门禁 A1 先证明现在是红的 |
| **B2** | 601-B 控制平面倒置成纯 Node 进程 | A5, B1, **A0** | Electron / CLI / Web / 小程序全部降级为它的客户端;CLI 与 main 进程内加载 L3,Web 走 HTTP |
| **B3** | 601-C agent runtime 注册到远端 | B2 | — |
| **C1** | 602 Phase 0 探针(可选) | 无 | 9 项能力边界;`close()` 语义与回滚路径任一不过就停下 |

**关键路径:A1 → A2 → A3 → A4 → A5 → A6 → A7。**
**A0 是唯一不做架构改造也能做的一片**,产出是让 Web 从"被耦合卡住"变成"差一个 `apps/web` 骨架",
建议与 A1 并行启动 —— 见 [02 客户端与运行时轴](11-slice-a0-client-runtime-axis.md)。
B 线在 B1 之后才与 A5 交汇;C 线全程可并行且不阻塞任何人。
**A8 不在关键路径上**,可与 A5 并行;但它与 **A7 有硬耦合**(见 §5.1 A8 行)。

### 5.1 每片的唯一 next action

> 上表只有名字与依赖,**这张表才回答"从哪下手"**。
> 一片只有一个入口动作,做完才有下一句 —— 写成清单会让人同时开工四片,四片都半途。

| 片 | 唯一 next action | 完成标志 |
| --- | --- | --- |
| **A1** | ✅ **已合并**(PR #219 / `908b5baf`)。原 open 项已答:新增 finding 是**真违规**,不是 `ports.ts` 过读(实测该文件只满足 1/3 子句,两处正则命中都在注释里) | `mutation-proof-a1.mjs` **5/5**;`architecture:check` 无新增 |
| **A0** | ✅ §3.1 + §3.3 + 门禁 **G10** 已落。§3.2 plugin-core 二分**未做**:实测它对 renderer 闭包贡献 21 文件、**0** Node 内建,barrel 已排除真正碰 Node 的三个模块 —— 是独立切片不是本片尾巴 | 浏览器入口闭包 **0/789** Node 内建;G10 变异证明 `FAIL 2/790` → 回退 `PASS 0/789` |
| **A2** | ✅ **已合并**(PR #222 / `a046cdf6`)。顺带修掉 #214 的 `TS2393` 重复 `publish` | `935/935 tolerated`(baseline 930 未动);`644/652 in packages/agent-runtime` 与 master 同一失败集;`typecheck:all` exit 0 |
| **A3** | ✅ **已完成**：S4c-d3 删除 `DuyaAgent.streamChat` 生产轮次循环并接入 RunEngine（commit `4444c7cf`，PR #262 / merge `2baa95df`）。2026-10-10 静态核对确认生产类已无该方法；迁移后遗留测试另列为 A4 前置清理 | 生产 `DuyaAgent.ts` 无 `streamChat` 声明/调用；此前门禁与迁移证据见 [90 执行日志](./90-execution-log.md)
| **A4** | ✅ **前置清理已完成**（2026-10-10）：16 处旧 `duyaAgent.streamChat` 调用归零，处置以删除为主（`packages/agent` 是 A7 待退役 facade，不做迁移式投资）；六场景 runtime 层验收 17/17 同 HEAD 实测。**下一步：A4 主体**——同引擎接 CLI / eval + 存储拒绝/worker 退出的产品级变体 | 旧调用归零 ✅；多轮、工具报错、取消、存储拒绝、worker 退出、慢消费者各有可复跑测试 ✅（runtime + 产品轮次层；CLI/eval 与产品级存储/worker 变体待 A4 主体） |
| **A5** | 先迁 `data`(纯 I/O、无业务决策),再 `capabilities`,最后 `memory` | 每迁一块:旧依赖归零 + 真实消费者仍绿 |
| **A6** | 先产出回填/恢复脚本,再改 schema | 三份证据齐备才删旧关系 |
| **A7** | `packages/agent` 消费者归零检查 | `architecture:check` 的 module-dependency 降到预期值 |
| **A8** | **新建 `packages/client-core`,把 `surface-model.ts` + `legacy-projection.ts` 移进去**,加过渡 re-export,并在 `architecture-policy.yaml` 加 `managed: true` 模块声明 | 实测该文件 `import` 命中 1 且为 `import type`,运行时依赖 0;`typecheck:all` exit 0;`architecture:check` 无新增 —— **门禁 G11 在第 2 步才上线,见下行** |
| **B1** | ✅ 门禁(静态 A1a + 行为 A1b)已红→绿,6 个 handler 已改软 require。**A1b-full 仍红且故意保留**:45 个层外模块仍硬 import electron(`window-manager` / `ipc/*` / `boot-config` / `db/connection` 等),已逐次打印在门禁输出里 | 图层内 `GREEN`;变异证明双向;层外清单是**下一步的输入**,不是已完成 |
| **B2** | 先把控制平面搬成独立进程,**不改客户端** | Electron main 不再拥有控制平面;CLI 与 main 进程内加载 L3 |
| **B3** | 远端注册表 + 认证 | — |
| **C1** | 写探针,两个 runtime 各跑一次 | 9 项能力边界;`close()` 与回滚路径任一不过就停 |

**A0 与 A1 已完成；原并行约束是历史记录，不再是当前排期条件。**

> ⚠️ **A8 与 A7 的顺序是硬耦合,不是排期偏好(2026-10-16)。**
> `SurfaceModel` 唯一的生产消费者在 `packages/agent/src/cli/ui/index.ts`,
> 而 `packages/agent` 由 A7 退役(`agent-retirement-gate.mjs` 至今仍有 `blocking`)。
> **若 A7 先合,唯一消费者消失,`SurfaceModel` 会变成「有测试、零生产消费者」。**
> 反向若 A8.1 先合,今天平移是纯移动(实测零运行时依赖);等 TUI 接上之后再搬,
> 成本会从「移动文件」变成「先拆依赖、再移动、再修 bundle」。**两片必须同分支可见。**

> ⚠️ **A3 最高风险项,此前没写下来(2026-10-06 补记):`discarded` 是一次性闩。**
>
> `StreamingToolExecutor.ts:479` 的 `private discarded = false` **没有任何地方把它清回 false**,
> 而 `discard()` 会连带 abort 掉 `siblingAbortController`(字段 `:481`,`abort` 调用在 `:758`),
> drain 循环因此自己就断了。类内 `:729-732` 写明了这个理由,`:739` 补了一句更要命的:
> **被 discard 掉的执行器是「静默失败」** —— `addTool` 照样收,什么都不排干,也**不报任何错**。
>
> **后果:任何跨轮持有同一个 pipeline 实例的端口改法,会让它在第一次 retry 之后永久变哑。**
> 这种改法**能过所有测试** —— 因为「什么都不做」和「干完了」在断言上无法区分 —— **而它仍然是错的。**
> `DuyaAgent.ts` 在 `:2407`/`:2746`/`:3368` 三处调 `discard()`。
>
> 现有防线是 `packages/agent/src/tool/turn-pipeline-publisher.ts:18-31`(逐 turn 构造、只发布不持有)。
> **A3 搬代码时不得把这个形状改回「持有」**,也不得在 `discarded` 旁边加一个
> `resetDiscarded()` 冒充修复 —— 那会把一个已 abort 的管线复活,正是
> `tool-pipeline-turn-lifetime.test.ts` 存在的意义。
> 怎么定位的:`Select-String 'siblingAbortController|discarded'` 逐行数 + 读 `discard()` 调用点。

### 5.2 放弃条件

没有放弃条件的计划序列会无限膨胀。以下任一条成立时,**停下并重新裁决**,不要继续往下做:

| # | 触发条件 | 为什么该停 |
| --- | --- | --- |
| 1 | **A3 连做两片仍不能把 G7 弄绿** | 说明"循环"这个目标本身定义错了 ~~(可能是 S2 的 `run-engine-model.ts` 已经是循环)~~ **该猜测已于 2026-10-06 实测排除**:两个 S2 文件都不是轮次循环(`repetition` 子句 0 命中) |
| 2 | **A5 迁完一个包,门禁新增违规 > 3 条** | 迁移方式有问题,不是包有问题。继续迁只会放大 |
| 3 | **任何一片无法做变异证明** | 该片不算完成(§4 第 2 条)。做不出变异证明的守卫等于没有守卫 |
| 4 | ~~**A2 合并 #214 后 `architecture:check` 新增 > 5 条**~~ **已消解**:A2 合并(PR #222)后新增恰好 **5** 条,全部 declared,未触发该条 | — |
| 5 | **连续两片的关键路径净变更 < 20 行** | 说明在做重构姿势而不是推进,应该回到"哪条边界还红"这个问题 |

> ⚠️ **第 1 条里的 S2 文件位置写错过。** `run-engine-model.ts` / `run-engine-ports.ts` 在
> **`packages/agent/src/process/`**,不在 `packages/agent-runtime`(见 §1.2)。
> 怎么测的:去注释后逐子句计数 —— `run-engine-model.ts` rep=0 / modelStream=6 / toolExecution=0;
> `run-engine-ports.ts` rep=0 / modelStream=2 / toolExecution=0。**两者都不是 G7 意义上的轮次循环。**

> 第 5 条是刻意的粗糙判据。**它的作用不是精确,而是阻止"看起来一直在忙"的假进度。**

---

## 6. 边界

- 本系列**不改** 600/601/602 的目标架构裁决,只重排顺序、更正被实测推翻的前提。
- 本系列**不取消** 602,只把它移出关键路径。
- 本系列**不接管** `packages/agent-runtime` 等已完成切片的历史记录,那些在各自执行日志里。
- 本系列自己也要遵守 §4;若某片做不到变异证明,**该片不完成**。

---

## 7. 本系列的全部文件

**这就是架构工作的全部。`docs/exec-plans/active/` 下另有 587,其合同已被第 01 章接管,不再单独排期。**

| 文件 | 作用 |
| --- | --- |
| [01-layered-architecture/](./01-layered-architecture/README.md) | 分层落地契约(原 600,11 份)。§4 已冻结为历史契约 |
| [02-headless-control-plane/](./02-headless-control-plane/README.md) | 控制平面倒置(原 601,6 份)= B 线 |
| [03-sqlite-driver/](./03-sqlite-driver/README.md) | SQLite 驱动(原 602,4 份)= C 线可选旁支,前提已更正见其 §0 |
| [10-slice-a1-g7-loop-detection.md](./10-slice-a1-g7-loop-detection.md) | 切片 A1 契约 —— **已完成(PR #219)**,其 §4 的未决问题已有答案 |
| [11-slice-a0-client-runtime-axis.md](./11-slice-a0-client-runtime-axis.md) | 切片 A0 契约 —— 客户端运行时轴 |
| [90-execution-log.md](./90-execution-log.md) | 执行日志与未决项 |
