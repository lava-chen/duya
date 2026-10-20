# 20 — 三端深度排查（TUI / agent 执行层 / Desktop）

Date: 2026-10-18. Parent: [610](README.md). 与 [18 诊断报告](./18-runtime-harness-diagnostic-report.md)
互补：18 追一个症状（工具中途停），本文做三端的**当前实测红绿基线 + 缺陷分类**。

快照：`master` `a51bb5d8`，领先 `origin/master` 1 个提交，**共享检出带 60 条未提交改动**
（其他 session 在途）。Node v24.16.0 / win32。全部结论只对本快照负责。

---

## 0. 结论先行

- 三端当前红 **124 条 / 90 个文件**，但**只有 10 条指向真实产品缺陷**，另有 **2 处覆盖事故**
  （D6 两条保证失去唯一用例；D7 Desktop 侧 legacy 闭环守的是已废除契约、原生闭环从未写），
  其余是过期断言、构建产物缺失、fixture 缺陷与 2 条 flaky。D6 与 D7 各自的「空档」已由两个
  新测试文件补上（宿主侧 run 行先于派发 + 并发会话隔离；Desktop 侧原生事件闭环）。
  把它们分开本身就是这轮的主要产出——因为最大的那一簇（桌面端 ~70 条）
  **不是 bug，是覆盖归零**。
- **TUI 端查得最晚，也最值得**：从「投影器丢事件」这条线索出发，三个看起来很真的假设
  全部被证伪（§8.1），剩下的是 D8（被拒绝的调用在转录本里不留痕迹），
  以及继续往下追一层才发现的 **D9 [HIGH]**——D8 讨论的那个「报告动作」本身是
  **协议非法的孤立事件**，`RunLedger` 当场判 `tool_completed_without_start` 抛异常，
  被 `#mint` 转成 refuse 返回值，而 `publish` 的签名是 `void`，**引擎对这次丢弃
  原则上完全无知**。净效果：用户点了「拒绝」，流里、转录本里、悬空统计里三处
  全都没有任何记录。修法未定，三条候选见 §5.1。
- **D10 [MED] 是 D9 的结构性成因，也是本轮唯一一条「门禁自己有洞」的发现**：协议里那条
  为记录拒绝而设计的 durable 事件 `permission.resolved` **没有生产者**（census 点名的
  `RunController.respondPermission` 是幽灵，真方法叫 `respondToPermission`），
  引擎才被迫退用一个协议非法的 `tool.timed_out`。而守着「每行都指向存在的代码」的那条
  census 守卫**只验文件路径、丢掉符号**——70 条引用里 27 条是严格 `path:Class.method`，
  **恰好 2 条失败，25 条通过**。**§D10 已闭合**：两行幽灵指针已修（`git diff` 2 增 2 删），
  目标合同在收到 `Error: Expect test to fail` 信号后翻成普通 `it`，并对生产代码做了变异证明
  （改回幽灵名 → 3 failed，失败信息逐字点名两条）。**这条闭合的实际意义是那个守卫从今天起
  会验符号了**——在此之前它的名字比它做的事强，只验文件路径存在。
- **§D10.1 是同一族的第二类漂移，顺带把三端基线净减 2 条红**：进来到现在一直没定性的那
  两条 census 红**不是幽灵**——`packages/agent/src/process/worker-protocol.ts` 今天只剩一行
  `export * from '@duya/host/worker-transport'`，符号经 re-export 链**真的存在**但已迁到
  `packages/agent-protocol/src/worker-protocol.ts`，且**零生产代码**再从那个壳导入。
  于是改了 **4 行**（producer 和 schema 都漂移，而旧守卫只验 `schema`）。
  顺带发现**我为 D10 加的守卫有个形状盲区**：`path:Class.method` 要求两个点号段，
  `path:buildWorkflowRunEvent` 只有一段 → 从未被收集 → 只被文件存在覆盖 → 那个壳存在 → 绿。
  守卫扩到单符号形式后，**立刻又抓到我自己的一个空洞守卫**（单符号按位置解构让 `method`
  变成空串，匹配几乎任何源码，全部报「已声明」）——抓住它的是同一条健康检查里新加的断言。
  变异证明：改回旧路径 → **0 failed 变 3 failed**，其中一条正是新扩展的守卫抓到
  **旧守卫看不到的 producer 漂移**。`control-plane-census.test.ts` 现在 **75/0 全绿**，
  `packages/agent-runtime` 全量降到 **1 红**（D5 那条已知 flaky），**基线净减 2 条**。
- **D12 [MED-HIGH] 是本轮收尾时定性 3 条未解释桌面红时撞上的**：
  `createIsolatedWorktree` 有**两份实现**——生产跑 `packages/host/worker-subagents/worktree.ts`
  （`service.ts:53` 导入它），而**唯一的 worktree 测试跑的是 `packages/agent` 那份**（已不可达），
  **Host 侧零测试**。一段会真实创建 git worktree 的代码，活的副本没有覆盖。
  两份 194 / 197 行，**常见路径落到同一个数据根**，但当 `DUYA_DATA_ROOT` 与
  `DUYA_APP_DATA_PATH` **同时**设置时优先级相反——**用户撞到的是活的那份，被测的是死的那份**。
  先否掉过一个更严重的结论（以为两份会把 worktree 建在不同目录从而隔离承诺不一致）。
  **补充**：那 6 条测试实测**是绿的**（6 passed，907ms 真实 `git worktree` 操作）——
  它们守着一份生产不执行的副本，绿得毫无意义。
  **§D12 已闭合**：6 条已搬到活的那份（`packages/host/tests/worker-subagents/`），**7/7 绿**。
  逐行对齐做完了——两份各 194/197 行，**190 行逐字相同**，只差 2 处 import 和
  `worktreeBaseDir` 末行；「同时设置时优先级相反」核实为**准确**
  （活版 `DUYA_APP_DATA_PATH` > `DUYA_DATA_ROOT`，死版相反）。
  另加**一条只有活版写得出的**测试锁住这个相反优先级——顺带查清一个真实后果：
  同时设两个变量的用户，worktree 落旧根而数据库落新根，**「一份数据」分两处**。
  这是有意的（注释明写），所以**记录不报缺陷**。变异证明故意做成精确形状：
  反转优先级但保留后备 → **7 变 1 failed**，唯一红的就是新那条，
  **前 6 条两个方向都绿**（同时证明迁移等价），且 worktree 始终落在临时目录、不污染用户 home。
- **更正一条我带过六轮的错误结论**：我反复写着「adapter 的 `__binaryResponse` 传输路径
  **零覆盖**」，并把它挂成待办六轮。**它错了，而我从没验证过。**
  `tool-protocol-adaptation.test.ts` 有真 `new Response(sseBody)` 的夹具，
  且 `:311` / `:346` 两条专门针对 Plan 418——畸形帧被跳过、可修复帧被修复，
  **实测 4 passed**。真正缺的只是**真 HTTP 传输**（自建服务器、真实分块与背压），
  响应体处理**是有覆盖的**。教训：**看一个既有结论值不值得信，看它被复述了多少次，
  而不是被验证了多少次。**
  **§D14 已补齐**（见下文闭合节）：新增 `anthropic-streaming-over-http.test.ts`（4/4 绿）
  用**真 SDK** + 真 socket + 跨 chunk 劈帧把缺口补上。删掉 `__binaryResponse` 的变异下
  **实测**：旧文件 **18 passed 全绿**、新文件 **4 failed 全红**——D14 那句「CI 全绿」
  从推测变成实测，现在有守门人了。
- **同一批红里 `automation-fire-persistence` ×3 已定性为过期 mock**（生产调
  `wakes.listPendingWakes()`，测试 mock 里只有 `listAll` 等旧方法），
  **`h8-2-worker-run-channel-seam` ×2 已定性为过期测试**（生产加了 attempt 围栏，
  用例的 `run:complete` 没带 `epoch`）。
  **更正**：我此前把这批写成「共 3 条未定性」，实测是 **10 条**（3 个文件），数字写错了；
  本轮已把 10 条**全部定性**——其中 1 条（`h8-2-consumer-inventory` 的 worktree 那条）
  指向 **D12** 这个真实缺陷，其余 9 条是过期 mock / 过期测试 / 漂移的普查表。
- **但那两条过期测试留下一个覆盖空档**：`takes the child to a durable terminal that the
  run layer will answer for` 在失败处就停住，所以「child 走到 durable terminal、
  run 层会为它答复」这条耐久性保证**今天实际无人验证**。
  **该空档已在 §D13 闭合**：按 D6 的做法用活的机制重述，并做了变异证明。
- **§D9.4 把 D9 最后一个未决项查实了**：legacy 的 `chat:permission` 帧**确实**逐跳走到
  `RunController.observeFrame` 并落进与引擎**同一个** `RunLedger`，所以修法**不必**让引擎
  补发 `permission.requested`（那反而会撞 `permission_requested_twice`）。
  同时**修正了我自己 §D9.3 的断言重点**：生产里那条「权限 ↔ 被拒调用」的链接走的是
  **`requestId`（= callId），不是 `toolCallId`**——legacy 请求帧根本不发 `toolCallId`。
- **§D9.5 补上了第二个验收点**：「记录下来」与「用户看见」是分开的两件事，
  今天分开坏——ledger 侧整条拒绝被丢，投影侧就算修好 ledger 也会因
  `projectHostEvent` **没有 `permission.resolved` 的 case** 而在下一层丢掉。
  契约只断言「投影器为它产出 frame」，**不钉转录本长什么样**（resolution 可能关 overlay、
  可能加一行、可能标工具行），事件形状取自协议自己的 fixture。双向证明已做。
  同时踩到一个还原陷阱：`host-event-stream.ts` 此刻是**脏的**（并行 session 在改），
  `git checkout --` 会连别人的在途改动一起回退，改用反向替换 + 哈希比对，
  确认并行 session 的 `effort` 改动完好无损。
- **§D9.6 推翻了 D9 修法推荐的前提，而且推翻它的是实测不是推理**：我为 D9 推荐「引擎补
  `permission.resolved` 生产者」，并用三方向变异证明了「成对发布 requested + resolved 就不红」。
  但那三方向的夹具里，`permission.requested` 是**我手工喂进去的**。追「谁真的发那条 frame」时
  撞到 `gateRunApproval`（`worker-run-composition.ts:207-215`）——
  ```ts
  void askApproval;   // ← host 那个会发 chat:permission、会等人的 approver
  void signal;
  return { allowed: true, scope: 'once' } as const;
  ```
  **实测 4/4 绿 + 双向变异**：① `canUseTool` 给出 `behavior: 'ask'`（即「这个要问人」）
  时，gate 返回 `allowed: true`；② 三种 behavior 下内层 approver **一次都没被调用**；
  ③ 只差一个变量的 `deny` 对照组确实走到另一条分支。
  净推论：**engine 腿上经由 `ports.approval.authorize` 的用户询问根本不会发生**，
  于是**不会有 `permission.requested` 入账**——D9 那个修法在真实生产路径上会撞
  `permission_resolved_without_request`（`run-ledger.ts:237-245`）**把整个 run 判死**，
  而不是修好它。§5.1 的三条候选因此全部要重排。
- **§D9.7 把上面那条再推进一步，并且更正了 §D9.3 / §D9.4 的适用范围**：
  追「谁真的发 `chat:permission` 帧」的结果是**生产里没有任何生产者**，
  三条互相独立的证据指向同一结论——
  ① engine 腿不调用用户的 approver（§D9.6，实测 + 双向变异）；
  ② `packages/agent-protocol/GAPS.md:110-112` 自己写着「permission 流程是断的，
  **这是有意的，好过发一个假的**」；
  ③ 唯一会把它翻译成 `permission.requested` 的 `observeFrame` 挂在 orchestrator 腿上，
  而生产 6 个模式**零个**带 `orchestrator`（新增实测 4/4 绿，直接问真实注册表，
  配 3 条判别性对照）。
  **净推论：engine 腿本就不该有人问，D9 要记的是一次「策略拒绝」而不是「用户决策」，
  所以「补 `permission.resolved` 生产者」这个候选可以划掉了。**
  同时**降低**了本条的定位：这是**当初被有意切断、尚未接上的中间态**
  （三处独立记录同一事实），不是本轮新破的管道。
- **D11 [MED] 是追接线时撞上的**：`normalizeWorkerEvent` 有**两份独立实现**
  （`packages/host/src/worker-frames.ts:28` 与 `apps/desktop/.../router.ts:505`），
  各自被不同调用方使用，而 `run-execution.ts:24` 的注释却写着「**the SAME normalizer**
  the Desktop router uses」。实测臂集合：host 39 / router 35，
  **`chat:text_delta` + `chat:thinking_delta` 只在 host 那份有**（还是 D2 记的那段重复死分支）。
- **最高价值的一条不是缺陷，是空缺**：Desktop 主进程的 IPC 转发层刚刚整体迁移到
  Host API，而它对应的测试装置没跟上，结果是**整层现在没有任何有效覆盖**。
- **18 号报告点名的「最高价值缺口」已关闭一半**：orchestrator 腿在生产里不可达，
  真实用户任务全部走 engine 腿。所以 18 的「未复现」对得上用户路径（仍受
  adapter / bundle / Desktop 三条边界限制，见 §4）。

---

## 1. 基线（今日实测，非转述）

```bash
npx vitest run packages/cli                      # TUI 端
npx vitest run packages/agent-runtime packages/host   # agent 执行层
npx vitest run apps/desktop                      # Desktop 端
```

| 范围 | 文件 | 用例 | 耗时 |
| --- | --- | --- | --- |
| `packages/cli` | 3 failed / 64 passed (67) | **5 failed** / 861 passed (866) | 33.6s |
| `packages/agent-runtime` + `packages/host` | 8 failed / 223 passed (231) | **13 failed** / 2430 passed (2443) | 33.5s |
| `apps/desktop` | 19 failed / 472 passed / 1 skipped (492) | **106 failed** / 5507 passed / 7 skipped (5620) | 224.8s |

**两次 host 运行不一致**：并跑的第一次是 15 红，单独一次是 13 红，差的正是
`managed-shell/task-store`（retention）与 `worker-os-context/watcher`（debounce）
——这两条按 flaky 归类，不计入缺陷。

---

## 2. 真实缺陷（10 条，都有可复跑证据）

### D1 [HIGH] 只发 legacy 帧的 run：以 `completed` 结算，台账是空的

**事实**（`packages/host/tests/run-execution.test.ts` "starts a real run, persists its
events, and replays them after settle"）：

```
[host-run] Run settled {"runId":"b11a7ef2-…","status":"completed"}
[host-run] this run produced legacy frames but no native run events — its durable
           transcript has no Runtime identity {"translatedEvents":4,"nativeEvents":0}
AssertionError: expected [] to include 'assistant.text_block'
```

**根因在 `packages/host/src/run-orchestrator.ts`，不是测试**：

| 位置 | 事实 |
| --- | --- |
| `:1889 #reportNativeChannel` | 已经**检测到**了这个降级，并且打了 WARN |
| `:544` / `:532` | 结算与 append 的两处裁决**只读** `#nativeLostByRun`（= 被拒绝的原生批次数） |
| — | 「原生事件**缺席**」这一情形没有进任何裁决分支 |

于是：降级被观察、被记录、然后被忽略。同一文件 `:517-527` 的注释写着
「Reporting `completed` over a transcript with a hole in it is the failure this exists
to prevent」——**这条不变量只对「写失败」成立，对「压根没写」不成立**。

**为什么重要**：客户端重连 / 回放读的是台账。一个 `completed` 且零事件的 run，
对读者和一条 `running` 挂死的 run 长得一样。

**可达性**（已核）：生产 worker 今天走原生通道，所以今天的主路径不触发。但
(i) orchestrator 腿产出的就是 legacy 帧；(ii) `nativeWriter` 在
`RunOrchestratorOptions` 里是**可选**的（`:236`，缺省时按注释「degrade」）；
(iii) 任何 stub / 替换执行器都会命中。**这是一个等着被踩的洞，不是死代码。**

**归属**：L-HOST 车道，`packages/host/src/run-orchestrator.ts`。该文件当前 dirty、
由在途 S1 车道持有，**本轮不改**，只登记。

### D2 [MED] `worker-frames.ts` 里一段逐字重复的不可达分支

`packages/host/src/worker-frames.ts:44-53`：

```ts
} else if (msgType === 'chat:text_delta' || msgType === 'chat:thinking_delta') {   // :44 生效
  … data: { content: event.delta, ...contentIdentity },
} else if (msgType === 'chat:text_delta' || msgType === 'chat:thinking_delta') {   // :49 永远到不了
  … data: { content: event.delta },                                                 // 且丢了 contentIdentity
```

条件完全相同 ⇒ `:49-53` 是死代码。它同时说明 delta 支持是被手写补丁**打了两次**：
第二份还漏了 `contentIdentity`。功能上无害（先命中 `:44`），但它是「同一处改动被应用
两次」的地质痕迹，而这一带正是 D3 那条过期守卫声称覆盖的范围。

### D3 [MED] `live-ring-refresh-frame` 的守卫已经失去分辨力

`packages/host/tests/worker-product-runtime/live-ring-refresh-frame.test.ts:82`：
断言 `heads` 必须包含 `chatFrame`，实测 `heads = ['', 'result', '']`。

**不变量其实仍然成立**。driver 的三个 `onFrame` 调用点现在是：

- `worker-engine-driver.ts:246` `onFrame({ type: 'chat:turn_start', … })`
- `:249` `onFrame(result as unknown as …)`
- `:265` `onFrame({ ...chatFrame, ...identity })`

`:251` 先投影、`:265` 再展开 `chatFrame`，即「drain 是 post-codec」依旧为真。

**问题在于判据读的是「表达式的开头」**（`a.match(/^[A-Za-z_$][\w$]*/)`）。第三个调用点
从 `chatFrame` 变成了内联对象展开，开头变成 `{`，于是取到 `''`。

**为什么这条重要**：同一个正则对「把裸投影帧喂给 `onFrame`」这种真回归也只会给出 `''`。
也就是说，**一旦有人把这个断言改回只留 `not.toContain('frame')`，它会对着正确代码和
错误代码一起绿**——它已经不能区分这两者了。这是空洞守卫的一种新形态：不是恒真，
而是**失去分辨率**。

### D4 [MED] skill 优先级：plugin 与 plain bundled 同分，胜负由发现顺序决定

`packages/agent-core/src/skills/resolver.ts`。文件头的规则表与实现**不一致**：

| 候选 | 文档表（`:11-12`） | 实现（`effectivePrecedenceOf`） |
| --- | --- | --- |
| `user` | 4 | **3**（`:59`） |
| `plugin` | **3** | **2**（`:64`） |
| customized-bundled | 4 | **3**（`:66`） |
| plain bundled | 2 | 2（`:69`） |

`pickWinner`（`:82`）用的是严格 `>`，所以**同分永远保留先出现的那个**。
`plugin` 与 plain bundled 都是 2 ⇒ 谁先被发现谁赢。测试
`sync-protection.test.ts` W2 断言「plugin 赢 plain bundled」，实测得到 `bundled`，
**单跑稳定复现**（不是 flaky）。

用户可见后果：一个插件提供的 skill 会被同名的内置 skill 静默遮蔽，且结果随
skill 发现顺序变化。

**为什么本轮不直接改**：修法有两种（把 `plugin` 提到 3，或把 `customized-bundled`
提到 4 并同步 `user`），**都会改变其它组合的胜负**，而 skill 可见性属于产品决策；
且 `user`/`project`/`customized-bundled` 三者同为 3 意味着改哪一档都会牵出新的平局。
需要先定「谁必须压过谁」的产品口径，再改代码 + 补一条「两种候选顺序结果必须一致」
的判别性用例。

**附带**：该文件头写的是 `packages/agent/src/skills/resolver.ts`，而文件实际在
`packages/agent-core/src/skills/resolver.ts` —— 路径注释已过期，会误导 grep。

### D5 [INFO] `coalescing-throughput` 是 wall-clock 超时，不是死锁

单跑实测 **14343ms**，`testTimeout` 是 10000ms。两次运行都红，且**只跑这两个文件**
（无并发负载）时仍然 14.3s。工作做完了，只是比预算慢。归类为测试预算问题，
不是产品缺陷；但它会**永久性地**让这一条红着，污染每次基线读数。

### D6 [MED] 实现搬走后，两条保证的唯一用例跟着失效了

`apps/desktop/src/main/agents/server/run-orchestrator.ts` 现在**只有 2 行**：

```ts
/** @deprecated Import the Host-owned run orchestration contract from @duya/host. */
export * from '@duya/host/run-orchestrator';
```

而 `apps/desktop/src/main/__tests__/run-orchestrator.test.ts`（20 用例 / 8 红）仍按
**旧的 Desktop 本地实现**搭夹具。8 条红的签名全都是同一个：**一次 `run:*` 持久化调用
都没被记录**（`findIndex(...) === -1`、refusals 数组为空）。

把这 8 条逐条对到 Host 侧：

| 桌面端红用例 | Host 侧是否有活覆盖 |
| --- | --- |
| reports a durable append the Control Plane refused | 有 —— `native-channel-faults` CASE 1 |
| reports a terminal write the Control Plane refused | 有 —— CASE 2 |
| reports a lost terminal CAS | 有 —— CASE 3 |
| surfaces a channel that throws mid-append | 有 —— CASE 1/4 |
| does not open a session whose durable start failed | 有 —— `run-attempt-queue-lifecycle:228` |
| leaves no session mapping behind for a run that never opened | 有 —— 同上 |
| **records run.started before the first frame is observed** | **无** |
| **keeps concurrent sessions on separate runs** | **无** |

最后两条全仓只出现在这个已失效的文件里（`grep 'before the first frame\|concurrent session\|
separate runs'` 仅命中 `run-orchestrator.test.ts:151` 与 `:218`）。

**含义**：实现迁移时，这两条保证**静默失去了唯一守护**。前六条被 Host 侧接手，后两条
掉进了空档——而 `run.started` 的持久化顺序正是崩溃后回放正确性的地基。

**处置建议**：把这两条移植到 `packages/host/tests/worker-product-runtime/`（那里已有
`RunOrchestrator` + 真 `RunStore` 的现成 harness），**再**删/改桌面端那 8 条；
顺序反了就是用一个「已无人守护的保证」换另一条。

### D6 已闭合（2026-10-18）：两条保证已在 Host 侧重新被守

新增 `packages/host/tests/worker-product-runtime/run-open-durability-and-isolation.test.ts`
（**只加测试，未碰任何生产代码**）。真 `RunOrchestrator` + 真 SQLite `RunStore`（真迁移）
+ 真 native writer + 真执行通道。

**第 1 条必须重述，不能照抄。** 旧用例断言的是 `run:append` 里那批 `run.started`
先于首帧落地——**这个写入已经不存在了**：Host orchestrator 只发两个持久化动作
（`run:create` `:707` / `run:complete` `:574`），事件全部归原生通道。照抄只会写出一条
永远红的用例。新断言守的是同一句意图（「首帧就崩的 run 仍留下它被交给了什么的记录」），
落在现在承载它的机制上：**durable run 行先于派发落地**。顺序由派发间谍直接回答
（`dispatch` 时 `run:create` 是否已返回），不是看调用日志。

同时断言 `countEvents(runId) === 0`：**行的存在不能被事件的存在架空**。将来谁再把
事件级 `run.started` 加回来，这条会红，逼他回答「现在哪一份才是权威记录」。

**变异证明（两个方向，各自只红自己那条）**：

| 变异 | 结果 |
| --- | --- |
| 派发时 `createDurable` 为 false（= 行还没落就派发） | G1 红 / G2 绿 |
| 把 session B 的帧路由进 run A（= 共享「当前 run」槽位那个 bug） | G1 绿 / G2 红（`expected [ 'turn.started#1' ] to deeply equal [ 'turn.started#1', …(1) ]`） |

恢复后 `sha256 3958802a…fe0ed5` 与原文件一致、无 `MUTATION` 残留、`2 passed (2)`。
同目录合跑 **19 文件 / 116 用例，5 红**——与进来之前逐字相同（`live-ring-refresh-frame` 1
+ `run-lifecycle-seam` 4），新文件未引入跨文件污染。

**证据强度的诚实边界**：这两个变异改的是**测试 harness 里的机制**（派发时机观测值 /
帧的归属 runId），不是生产代码。生产侧变异——让 `openRun` 在 `run:create` resolve 之前
派发、或让 session→run 绑定退化成单一共享槽——**没有做**，因为
`packages/host/src/run-orchestrator.ts` 当前 dirty 且由在途 S1 车道持有，在共享检出上
改它会与他人半成品打架。所以：断言的**承重性**已证，**生产实现的绑定性**未证。

**剩下的动作属于该文件 owner**：桌面端那 8 条现在全部冗余（6 条有 Host 等价、2 条已移植），
可以删/改，但那是 L-DESKTOP 车道的文件，本轮未动。

### D7 [HIGH] Desktop 侧的集成证明停摆：legacy 闭环的对象已不存在，原生闭环从未写

D6 是「两条保证失去唯一用例」。这是它的推广版，而且更严重。

生产是接了的 —— `apps/desktop/src/main/agents/server/index.ts:336`
`nativeWriter: createDesktopNativeRunEventWriter({ request: dbRequest, logger })`。

但 Desktop 主进程里 `new RunOrchestrator(` 出现在 **9 个测试文件、19 处**，其中**只有一处**
接了 `nativeWriter`（`terminal-publication-barrier.test.ts:199`）。而事件持久化现在
**只**走 `nativeWriter`（orchestrator 只发 `run:create` / `run:complete`，没有 `run:append`）。

**关键补充（第一版结论不完整）**：那 8 个文件不只是「没接线」，它们推的全是
**legacy `chat:*` 帧**（全仓只有 `terminal-publication-barrier.test.ts` 推原生 `run:event`），
并断言这些帧会落成 durable log —— **而那正是权限翻转刻意删掉的契约**。
所以它们**接线也救不回来**：主题不存在了。

实测后果（今天现跑）：

| 文件 | 红 | 失败签名 |
| --- | --- | --- |
| `reference-run-closed-loop.test.ts` | 5 | `expected null not to be null` ×3、`expected 0 to be greater than 0`、`expected false to be true` |
| `run-create-ack-real-bridge.test.ts` | 2 | `…reaches a durable terminal with events written` → `expected 0 to be greater than 0`；`leaves a refused dispatch settled` → `expected [] to have a length of 1` |
| `run-result-read.test.ts` | 2 | `expected [] to include 'run.completed'` |
| `run-orchestrator.test.ts` | 8 | 见 D6 |
| `run-entry-single-dispatch` / `run-entry-non-sse` / `run-orchestrator-ack` / `headless-retirement` / `h8-2-*` | 12 | 同一根因或其下游 |

**「Reference Run, closed」和「run-create-ack real bridge」是本仓仅有的两个真桥接闭环证明**，
而它们守的是已经废除的 legacy 契约。结论不是「多了几条红」，而是
**Desktop 侧的原生路径闭环从未被证明过**。

### D7 已补：新增 Desktop 原生闭环证明（2026-10-18）

`apps/desktop/src/main/__tests__/desktop-native-run-closed-loop.test.ts`（只加测试，
未碰生产代码）。真 `normalizeAndObserve`（唯一生产调用 `queueNativeRunEvent` 的 tee）、
真 `RunOrchestrator`、真 `createDesktopNativeRunEventWriter`、真 `handleDbRequest` 桥、
真 `ControlPlaneService` + repository、真 SQLite `RunStore`（真迁移）。

**首次运行即 2/2 绿** —— 也就是说**生产接线本身是通的**，缺的一直是证明。

两条断言都是**读数据库**，不看调用日志：

1. `openRun` 后 runs 行先落地（manifest 可从行本身重算指纹）、`run_events` 为 0 行；
2. 4 条原生帧经真 tee 落库，`['run.started#1','turn.started#2','assistant.text_block#3','run.completed#4']`
   **逐条相等且无洞**；混在中间的 legacy 帧**一个字节都不加**（翻转契约正面写死）；
3. 结算后 `status/terminal = completed`、`error_json` 为 null、`finished_at` 非空；
4. 第二条用例钉住反面：**只说 legacy 的 worker → 台账 0 行，且降级被点名**
   （读 orchestrator 自己的日志，不手写断言）。

**变异证明**：把 `nativeWriter` 整段拿掉（**这正是 D7 描述的缺陷本身**）→
第 1 条红（`toHaveLength(0)` 那侧塌掉）、第 2 条按设计保持绿。恢复后逐字节一致、
无残留、`2 passed (2)`。

> 随后把该文件行尾从 LF 规范化为 CRLF（与同目录两个邻居一致）；规范化后内容逐字相同
> （`replace(/\r\n/g,'\n')` 与原文相等）、无 mojibake、`2 passed (2)` 复跑仍绿。
> 当前字节哈希 `6aca9cba…c9991faf`；**上面那次变异证明是在 LF 状态下做的**，
> 哈希随行尾规范化而变，引用时以本行为准。

**污染检查（逐文件比对，不靠「我绿了就没事」）**：合跑
`apps/desktop/src/main/__tests__/` 后，与加入新文件之前的基线**逐文件红数完全一致**，
**新增红 0、意外转绿 0**。

**仍然没有的**：Electron 真机、真 worker 子进程、真 provider。上面证明的是
**Desktop 接线**（tee → writer → bridge → store），不是端到端。

### D8 [MED] 被拒绝的工具调用，在 CLI TUI 转录本里不留任何痕迹

一次差点报错、最后落到两条真问题上的发现。**过程本身是结论的一部分**，见 §8.1。

被拒的工具调用在 `#dispatchCall`（`run-engine.ts:1591-1602`）里走这一条：

```ts
if (!verdict.allowed) {
  ports.events.publish({ type: 'tool.timed_out', toolCallId: call.callId,
                         toolName: call.name, elapsedMs: 0 });
  return;
}
```

**事件选型本身是有意且有测试钉着的**：`engine-publication.test.ts:559-562` 明写
「`tool.timed_out` at elapsed 0 is how `#dispatchCall` reports an unapproved call,
and it keeps a broken bridge from reading as a user saying no」。所以**不是疏忽**。

**D8a — 注释描述了代码没有做的事。** 紧邻的注释声称
「`unavailable` is kept distinct from `denied` so a broken bridge does not read as a
user saying no」（`:1592-1594`），但代码只有**一个** `if (!verdict.allowed)` 分支：
`denied` 与 `unavailable` 产生**完全相同**的事件、`elapsedMs` 都是编造的 0。
注释里的区分只存在于注释里。这正是本仓反复出现的那一类（注释当成事实引用）。

**D8b — 用户可见的那一半：一个被拒绝的工具，在 TUI 转录本里什么都不留。** 三条事实叠加：

1. 上面那条唯一的事件是 `tool.timed_out`，它在
   `packages/agent-runtime/src/surface/legacy-projection.ts:57` 的
   `LEGACY_UNMAPPED_EVENT_TYPES` 里，且 `packages/cli/src/tui/host-event-stream.ts:24-105`
   的 `projectHostEvent` **没有它的 case** → `default: return null` → 丢弃；
2. `tool.call_started` 在授权闸门**之后**才发（`:1617`），所以被拒的调用**没有工具行**；
3. 权限帧**刻意**不进转录本（`blocks.ts:184`「The frame drives the overlay, not the
   transcript」，`tui-blocks.test.ts:116-124` 用例钉着「A question must not be a
   transcript line」）。

于是：提示框弹出 → 用户拒绝 → 提示框消失 → **转录本里没有任何一行说明发生了什么**。
不是崩溃、不是挂起，是静默。这与「工具调用中途停下」的主诉同形：用户无法把
「我拒绝的那个工具」和「卡住的那个工具」区分开。

**修法方向**（不在本轮）：协议里没有 `tool.call_denied`。两条路——
(a) 让引擎在被拒时也发 `tool.call_completed{outcome:{outcome:'tool_error',
error:{code:'permission_denied'}}}`：不需要改协议，**并且 TUI 现在就能渲染**
（`host-event-stream.ts:84-95` 会把它画成一行 error 工具），同时也补上了
tool_use / tool_result 的配对；(b) 加一个协议事件并给 TUI 加 case。
(a) 的收益明显更大，但它是行为变更，须先写先红的用例。

### 8.1 本轮被证据否掉的三个假设（写下来防止照着旧结论走）

D8 是从「TUI 端投影器会丢事件」这条线索查出来的。查的过程中三个看起来很真的
假设**全部被证伪**，每一个都是在断言之前查的：

| 假设 | 证伪证据 |
| --- | --- |
| 「TUI 显示不出工具超时」 | **假**。`ToolCallOutcome` 有 `timeout` 臂（`payloads.ts:157-166`），超时经 `tool.call_completed{outcome:'timeout'}` → TUI 投影出 `error: true`。真超时**是**画得出来的 |
| 「被拒后 `waitingForPermission` 残留、挡住后续输入」 | **假**。`TUIApp.ts:1989` 在用户作答的回调里用 `this.overlay.isActive` **重算**该标志，不存在陈旧状态 |
| 「权限块永远收不了尾、留在转录本里」 | **假**。权限帧按设计不进转录本，且有用例钉着 |

剩下能站住的那一条（D8），它的成立**不依赖**这三个假设中的任何一个。

### D9 [HIGH] 被拒的工具调用：引擎报告了，**协议边界当场丢弃**，任何消费者都收不到

D8 记的是「用户可见无痕迹」。继续往下追一层，真实情况比那更严重：D8 讨论的那个
「报告动作」本身**在任何真实绑定下都不可能送达**。这不是 TUI 少画一行，是协议层
把事件拒了，而且拒得没有任何人知道。

四步链路，每一步都实测过，不是读代码推断：

1. `#dispatchCall`（`run-engine.ts:1591-1602`）在 `!verdict.allowed` 时发
   `tool.timed_out` 然后 `return`。**这个 `return` 让 `:1618` 的
   `tool.call_started` 永远发不出去** —— 被拒的调用在账本里是孤立的。
2. `RunLedger.#assertPayload`（`run-ledger.ts:221-231`）把「没有权威 start 的
   `tool.timed_out` / `tool.call_completed`」判为不变量破坏
   `tool_completed_without_start` 并 **throw**。
   实测：`LifecycleViolation: tool_completed_without_start: tool.timed_out for c1, which has no authoritative start`
3. `RunEventEmitter.#mint`（`event-emitter.ts:580-595`）catch 住这个
   `LifecycleViolation`，转成一个 **refuse 返回值**，不抛。
4. 生产端口是 `publish: (event) => { void sources.emitter.emit(event); }`
   （`adapters/run-engine-ports.ts:888-890`），而 `RunEventStorePort.publish`
   的签名就是 `(event: RunEvent): void`（`ports.ts:1030`）。
   **引擎原则上就没有任何途径知道自己发的事件被丢了。**

实测的净效果（同一 harness 的对照组）：

| 运行 | `offered` 里的 tool 事件 | 真正送达 `announced` | 落库 `appended` | `danglingToolCalls()` |
| --- | --- | --- | --- | --- |
| **允许**（正常结果） | `call_started`, `call_completed` | `call_started`, `call_completed` | `call_started`, `call_completed` | `[]` |
| **被拒**（D9） | `timed_out` | **无** | **无** | `[]` |

对照组是关键：允许的 run 在**同一个 harness、同一个 emitter、同一个 session**
里能完整送达两条 tool 事件，所以「没有」是被拒造成的，不是 fixture 带不动。

而且 `danglingToolCalls()` 也是空 —— 因为它只统计**已经开始过**的调用
（`run-ledger.ts:143-147`）。所以账本是自洽的，**没有任何一处说「曾有一个调用
被提议过」**。用户点了「拒绝」，结果是：流里没有、转录本里没有、悬空统计里没有。

**被一个对照组救下来的错误结论（写在这里防止重犯）：** 第一次测到该 run 的
`settle()` 返回 `failed / runtime_crash / "the run stream ended with no terminal event"`，
差点直接报成「拒绝工具调用会把整轮跑崩成 runtime crash」的 HIGH。跑完**允许**的
对照组发现它 settle 成**一模一样的** `runtime_crash` —— 那是本 harness 固有的形状
（`:507` 那条用例早就写明了「无 terminal 事件的 run 记为 runtime_crash」），
与拒绝无关。**没有对照组，这就是一个凭空捏造的 HIGH。**

「`unavailable` 与 `denied` 有区分」这句注释（`run-engine.ts:1592-1594`）仍然是
D8a 那条问题（代码只有单个 `if (!verdict.allowed)`），但下面那句「keeps a broken
bridge from reading as a user saying no」现在要改口径了：它连**到达那个可能坏掉的
桥的机会都没有**，更别说区分。

**已落的两条证明**（`packages/agent-runtime/test/engine-publication.test.ts`）：

- 测量用例（绿）：钉住上面那张表的全部四列，含允许/被拒双跑。钉的是**今天的实测
  真相**，不是应该的样子 —— 修好之后它会转红，那时把它翻成目标合同即可。
- 目标合同（`it.fails`，本仓库首次使用该记法）：只断言三个候选修法**共同**的那条
  性质 —— 「无论修法发什么，被拒的调用必须在流或转录本里留下可读的东西」。
  刻意不钉某个具体事件形状，因为形状本身还没定（见 §5）。

`it.fails` 的 body 对**任何**抛错都算通过，是典型的空洞守卫形态，所以做了双向证明：

- 今天：该用例因目标断言失败而通过（红→绿方向正确）；
- 把生产分支临时改成先发 `tool.call_started` 再发拒绝（ledger 于是接受这对事件）
  → 该用例报 `Error: Expect test to fail`，即目标合同**不再失败**；
- 恢复后 `run-engine.ts` 的 SHA-256 与改动前**逐字节相同**
  （`8C7D50B8…49B4FA` → `3F8348AE…BE892C` → `8C7D50B8…49B4FA`），
  `git status` 确认生产文件无残留。

### D9.1 把修法推荐从「推测」升级为「协议原文锚点」（2026-10-18 补测）

上一轮把「D9 的三个候选修法里该选哪个」列为**未验证**。这一轮把它查实了，
结论是**协议自己早就写明了这件事该怎么做**，只是没人执行。

**协议为 `permission.resolved` 写的存在理由**（`agent-protocol/src/legacy/sse-event.ts`
的 legacy-gap 说明段，原文）：

> The legacy surface had permission_request and no resolution event, so an
> answered or timed-out permission **left no audit trail**. Every decision must
> be recorded, including timeout and cancellation.

也就是说：**「请求有记录、答复没有记录」这个缺口是协议早就识别出来的**，
`permission.resolved` 就是为它而设的，而且 ledger 已经强制了它的配对
（`permission_resolved_without_request` / `permission_resolved_twice`，
`run-ledger.ts:236-254`）。全仓搜 `type: 'permission.requested'` 只有**一个**
非测试生产者（`translate/chat-event-translator.ts:460`，把 legacy `chat:permission`
帧翻译过来），而 **`permission.resolved` 一个都没有**。

**这条链现在逐段实测，不是推断：**

| 环节 | 实际实现 | 有无协议级记录 |
| --- | --- | --- |
| 用户被问到 | worker 发 **legacy** `chat:permission` 帧（`worker-process-entry.ts` 的 `createPermissionHandler`） | 由 legacy translator 翻成 `permission.requested`，**含可选 `toolCallId`，所以与工具调用的关联是有的** |
| 引擎侧 | `run-engine-ports.ts:879`：`authorize: (request, signal) => sources.askApproval(request, signal)` —— **纯透传，不发任何事件** | 无 |
| 用户答复 | `askApproval` 返回 `{allowed:false, reason:'unavailable' \| 'cancelled' \| 'denied'}`（`worker-process-entry.ts:2312-2329`） | **无。`permission.resolved` 没有生产者** |
| 引擎补偿 | 被拒时发孤立 `tool.timed_out`（`run-engine.ts:1591-1602`） | **被 ledger 判非法并静默丢弃**（D9） |

**并且关键的词典已经现成**：`LEGACY_PERMISSION_ACTION_MAP`（legacy 动词
`allow_once` → `PermissionAction` `allow`）已实现；Desktop 侧
`recordPermissionDecision`（`apps/desktop/src/main/control-plane/permission-decision-record.ts`）
也已实现且有 13 条用例。**缺的只是「把它发成一条 run 事件」这一步。**

**这直接推翻了我上一轮留的那个未验证项。** 我当时写「要定的口径是：这条记录归运行时
还是 Control Plane decision path，**本轮未验证**」。现在可以给出更准的结论：
**Control Plane 那条路只覆盖 Desktop 的 `worker_http` / `bot_card` 两个 surface，
TUI 完全不走它**（`packages/cli/src` 里没有任何 `askApproval` /
`recordPermissionDecision` 调用；CLI 有自己的 `TUIApp.requestPermissionApproval`）。
所以对 TUI 而言，**运行时那条 run 事件是唯一可能的落点** —— 不是「两种归属里选一个」。

**顺带修掉我自己文件里一处同病指针**：那条用例的注释原本称
「Its owner is the `ApprovalPort` implementation, publishing inside `authorize`
(`run-engine-ports.ts:299-305`)」。那个行号是 `interTurn` 的文档，真实绑定在 `:879`，
且是纯透传。与 D10 同一类（陈旧指针伪装成权威）。已改正，并补了一条此前**无人断言**的事实：

```ts
expect(only(h.offered, 'permission.resolved')).toEqual([]);
```

### D9.2 按推荐修法做双向证明时，逮到我自己那条合同的一个真 bug

修法定了之后，我按 §D5.1 的验收线去验它。**结果第一步就发现我那条 `it.fails` 写错了**。

**Bug 1：合同意外地钉死了形状。** 合同断言的是
`toolEventsOf(h.announced).length > 0`，而谓词只收 `tool.` 前缀。但 §D9.1 定下的推荐
修法发的是 **`permission.resolved`** —— 按正确修法改完，**这条合同仍然会红**。
一条声称「不钉形状」的合同，却因为谓词只认 `tool.` 而事实上钉死了形状。
改成 `refusalEventsOf`（同时收 `tool.` 与 `permission.`）。**这正是 `it.fails` 容易让人
走进去的坑**：它让你以为「断言写得够宽就够了」，而真正的风险在谓词里。

**Bug 2：我的 restore 脚本把文件改坏了。** 第二轮变异用的还原脚本自己写错了
（还原时把 `tool.timed_out` 的发布重复了一次、吃掉了注释块），跑完哈希与变异前**对不上**。
处置：`run-engine.ts` 没有任何属于我的正当改动，**直接 `git checkout --` 还原并验哈希**，
`8C7D50B8…49B4FA` 逐字节一致。
**教训**：哈希校验的价值正在于此——如果我当时只看「脚本说 restored」就收工，会把一个
被改坏的源文件留在共享检出上。

**改好合同后的双向证明（三个方向）：**

| 变异 | 目标合同 | 说明 |
| --- | --- | --- |
| 无（今天） | **红**（`it.fails` 通过） | 拒绝不到达任何消费者 |
| 只发 `permission.resolved` | **仍红** | ledger 判 `permission_resolved_without_request`，**同样被丢弃** |
| 发 `permission.requested` + `permission.resolved` | **不红**（`Expect test to fail`） | 推荐形状成立，合同正确识别 |

中间那一行是这一轮最有用的实测：**光发 `permission.resolved` 是修不好 D9 的**。
它和 `tool.timed_out` 撞的是同一个坑（ledger 要求先有 request），只是抛的异常不同。
所以实现方必须**成对发布**，或者确保生产里那条 legacy `chat:permission`
（→ `permission.requested`）**确实落进了同一个 `RunLedger`**。
**后者我没有验证**——`worker-process-entry.ts:createPermissionHandler` 是先
`sendToMain` 再等答复，时序上像是能赶上，但「落进同一个 ledger」这件事要追到
host 的 drain 绑定才知道，而 host 那两个文件属于在途车道，本轮没动。

### D9.3 用真 RunController 查实：legacy 请求**确实**入账，而违约的代价是 run 被判死

> **⚠️ 本节的实测有效，但适用范围已被 §D9.7 更正。**
> 这里的 `observeFrame` 唯一落在 `RunOrchestrator` 上，而 orchestrator 腿在生产里不可达
> （生产 6 个模式零个带 `orchestrator`，已实测）。所以「会落进同一个 ledger」
> 在**这条腿上**成立，在**生产里**不成立。读本节结论时请带着这个限定。

§D9.2 留的那个「生产里 `permission.requested` 是否落进同一个 `RunLedger`」，这一轮用
**真实 `RunController`** 而不是推理查实了（新增用例在
`packages/agent-runtime/test/run-permission-respond.test.ts`，复用它既有的装置）：

```ts
const outcome = controller.observeFrame('run-perm', { type: 'permission', ... });
expect(outcome.forwardOnly).toBe(false);
expect(outcome.envelope?.payload.type).toBe('permission.requested');
expect(Number.isSafeInteger(outcome.envelope?.seq)).toBe(true);
expect(payload.toolCallId).toBe('call-1');
```

**结论：会落进同一个 ledger。** 走的是 `RunController.observeFrame`（`controller.ts:804`）
→ `translateFrame`（`:821`）→ `active.emitter.emit`（`:832`），而 `active.emitter` 正是
`:537` 创建、`:554` 存入、也是引擎 `events.publish` 闭包捕获的那**同一个** emitter。
`seq` 是整数这条断言是关键——它证明是 **ledger 铸造并编号**的，不是构造出来的空壳。

**并且 `toolCallId` 在翻译中存活**（`chat-event-translator.ts:468`）。这一条决定了
未来的 `permission.resolved` **能不能把一次拒绝归因到具体的工具调用**——没有它，
即使补了事件，记录下来的拒绝仍然指不回它拒绝的那个调用。

**第二个用例把这个不对称钉住了**：喂一个 legacy `permission_resolved` 帧，
`envelope` 为 `null` 且无 violation —— 协议在 `legacy/sse-event.ts` 里写的
「The legacy surface had permission_request and **no resolution event**」这半句，
**今天仍然字面为真**。

**变异证明，而且结果比预想的严重。** 我给 translator 临时加了一条
`permission_resolved → permission.resolved` 的映射（本以为只是让验收用例转红），结果：

```
FAIL … > has no legacy route for a RESOLUTION …
AssertionError: expected { runId: 'run-perm', …(5) } to be null
  "type": "run.failed",
```

返回的不是 `null`，是 **`run.failed`**。也就是说：**如果照着「加一条 resolution 路由」
去修，却没保证 `permission.requested` 先入账，后果不是事件被丢弃，而是整个 run 被判失败**
（`controller.ts:834-839`：ledger 违例被记录为该 run 的终态）。

这把 §D9.2 里那条注意事项从「记得成对发布」升级为**硬约束**：
**先发 `tool.timed_out`（今天，被静默丢弃）远比在 request 缺失时发 `permission.resolved`
（把 run 打死）安全。** 实现顺序必须是「确认 request 已入账 → 才发 resolved」。

变异已按 SHA-256 逐字节还原（`827EEB9A…5AE4C2` 不变），并重建了
`@duya/agent-runtime` 构建产物——因为这份测试 `import ... from '@duya/agent-runtime'`
走的是 **dist 而不是源码**（详见下面「踩到的第三个坑」）。

**踩到的第三个坑（方法论，值一记）**：这次变异改了 `src/` 却测不到变化，我一度以为是
断言没接住。真实原因是**导入路径**：`run-permission-respond.test.ts` 从
`@duya/agent-runtime` 导入（构建产物），而 `engine-publication.test.ts` 从 `../src/` 导入。
**同一仓库里两种导入风格并存，变异「不生效」的第一嫌疑应该是导入路径，而不是断言写错了。**
而且改 `src/` 后必须 `npm run build:runtime`，否则测试跑的是上一版 dist —— 这会让
「变异证明」变成「变异没有发生」的假阴性。

### D9.4 host 侧接线查实：D9 的修法可以依赖「request 已入账」

> **⚠️ 本节标题的前提已被 §D9.7 推翻，请连同 §D9.6 一起读。**
> 逐跳接线本身仍然成立，但「生产里 request 会入账」**不成立**：
> engine 腿不发那条帧（§D9.6），唯一会翻译的 orchestrator 腿不可达（§D9.7）。
> **「修法可以依赖 request 已入账」这个结论作废。**

§D9.3 留的最后一项是「产品里引擎跑的 run 是否真的经 legacy drain 收到那条
`chat:permission` 帧」。逐段追完，**答案是肯定的**，链路每一跳都有落点：

1. `worker-process-entry.ts` 的 `createPermissionHandler` → `sendToMain({type:'chat:permission', …})`；
   而 `sendToMain` 是 `process.send?.(msg); sendEvent(msg);`（`:1575`）——**同时**进主进程与流，
   所以流上确实有这一帧。
2. Desktop 侧 `router.ts` 的 `normalizeAndObserve`（`:1726` SSE 路径 / `:2051` 非 SSE 路径）
   对非 `run:event` 的帧一律 `observe(sessionId, normalized)`（`:782`）。
3. `normalizeWorkerEvent` 有 `chat:permission` 臂，产出 `{type:'permission', data: event.request}`
   （`worker-frames.ts:98-102`；router 自己那份 `:568-572` 完全相同）。
4. `RunOrchestrator.observe` → `RunController.observeFrame` → `translateFrame` → `permission.requested`
   → **与引擎同一个 `RunLedger`**（§D9.3 已实测）。

**所以 D9 的修法可以依赖 request 已入账**，不需要引擎自己补发一条
`permission.requested`（那会与 legacy 帧重复，反而触发 `permission_requested_twice`）。

**但顺带修正了我自己 §D9.3 的一个断言重点。** 那条用例原本喂一个带 `toolCallId` 的合成帧
并断言 `toolCallId === 'call-1'`。追生产帧形后发现：`createPermissionHandler` 发的
`request` 是 `{ id, toolName, toolInput, mode, expiresAt }` —— **没有 `toolCallId`**；
而 translator 读 `requestId = str(data['requestId'] ?? data['id'])`（`:455`），
且 `worker-process-entry.ts:2317` 传的正是 `id: approval.callId`。

**结论：生产里那条「权限 ↔ 被拒调用」的链接是走 `requestId` 的，不是 `toolCallId`。**
所以未来的 `permission.resolved` 必须用 `requestId` 去关联；用 `toolCallId` 会找不到东西。
已把那条用例改成**生产真实帧形**，并把 `toolCallId` 缺席这一点一并钉住
（`expect(payload.toolCallId).toBeUndefined()`），免得后来的人照着可选字段去实现。

### D9.5 第二个验收点：「记录下来」和「用户看见」是两件事，而它们今天是分开坏的

第一个验收点（§D9，在 `packages/agent-runtime`）覆盖的是「拒绝到达了 durable ledger」。
它**不覆盖用户**。而这两件事今天是分开坏的：

- ledger 侧：整条拒绝被丢（D9）；
- TUI 侧：就算 ledger 修好了，`projectHostEvent` 有 `permission.requested` 的 case、
  **没有 `permission.resolved` 的 case**，`default:` 返回 `null`，事件死在这里 ——
  也就是今天它丢失位置的**下一层**。

所以光修 ledger，D9 修完仍然是个用户无感的问题。

**契约刻意只断言「投影器为它产出一个 frame」**，不断言转录本里长什么样。
resolution 之后**可能**关掉 overlay、**可能**加一行转录本、**可能**把工具行标成被拒 ——
钉住其中一种就是在预判一个还没做的决定，而这正是我在 runtime 那边犯过的错
（§D9.2：谓词只收 `tool.` 前缀，把正确的修法判成不合格）。
配套的对照用例断言 `permission.requested` **今天**就能投影出 frame，
否则「`permission.resolved` 投影成 null」和「这个投影器对权限流量一律不发东西」分不开。

事件形状取自协议自己的 fixture（`agent-protocol/src/testing/fixtures.ts:109-114`），
不是编的，避免实现方以「你喂了个不可能的事件」为由拒绝这条合同。

**双向证明同样做了**：临时给 `projectHostEvent` 加一条 `permission.resolved` 分支 →
目标合同报 `Expect test to fail`，**对照用例保持绿**；还原后逐字节一致。

**这一轮踩到一个必须单独记的还原陷阱**：`packages/cli/src/tui/host-event-stream.ts`
此刻**是脏的**（并行 session 正在给 `turn.started` 加 `effort`）。
所以这里**不能**用 `git checkout --` 还原 —— 那会把别人的在途改动一起回退掉。
改用**确定性反向替换 + SHA-256 前后比对**，还原后
`947FA943…B917707` 不变，且**并行 session 的 `effort` 改动完好无损**（已 diff 确认）。
**「共享检出上有人同时在改同一个文件」时，`git checkout --` 是破坏性的；
先看 `git status`，脏文件一律走反向替换 + 哈希校验。**

### D9.6 引擎腿上的用户 approver 是不可达的，而 D9 的修法推荐建立它可达之上

这一节**推翻本报告自己 §D9.2 的修法推荐**，而且是被实测推翻的，不是推理。

#### 我此前错在哪

§D9.2 我做了三方向变异，结论是「成对发布 `permission.requested` + `permission.resolved`
就不红 ✅」。那个结论本身没错——**它的错在于夹具**：`permission.requested` 是我手工
喂进去的。而真正的问题是**生产里谁发那条 frame**，这个问题我三轮都没问。

#### 生产接线：追「谁发 `chat:permission`」

| 跳 | 位置 | 事实 |
| --- | --- | --- |
| 1 | `worker-engine-driver.ts:202` | `askApproval: gateRunApproval(assembly, request.askApproval)` |
| 2 | `worker-run-composition.ts:207-215` | gate **只**看 `assembly.canUseTool` |
| 3 | 同上 `:212` | `void askApproval;` —— **显式丢弃**内层 handler |
| 4 | `worker-process-entry.ts:2312-2329` | 内层 handler 才是**唯一**会发 `chat:permission` 帧并 `await` 人回答的那段 |
| 5 | `worker-process-entry.ts:1795` | `requestPermission` 由 `createSurfaceAwarePermissionHandler(...)` **无条件**构造，返回类型里**没有 `undefined`** |

第 3 跳是关键：**内层 approver 被 `void` 掉，不是恰好没被用到。**

#### `ask` 这一档在 gate 里是什么

`CanUseToolDecision.behavior` 是三值闭集（`packages/agent-runtime/src/tools/execution/contracts.ts:65`），
而 `buildPermissions` 把 `ask` 解析成 `{ allowed: true, behavior: 'ask' }`——
`ask` 就是「这个要问人」那个值。`gateRunApproval` 的闸门只有 `behavior === 'deny'`：

```ts
const { behavior } = normalizeCanUseToolDecision(await assembly.canUseTool(...));
if (behavior === 'deny') return { allowed: false, reason: 'denied' };
return { allowed: true, scope: 'once' };   // 'ask' 落在这里
```

#### 实测（`packages/host/tests/worker-product-runtime/gate-run-approval-reachability.test.ts`，4/4 绿）

| 用例 | 断言 | 为什么要有 |
| --- | --- | --- |
| `treats an ask verdict as allowed, without consulting the approver` | `ask` → `{allowed:true, scope:'once'}`，且**内层 approver 被 rig 成会拒绝** | approver 若同意放行，「gate 自己决定」和「gate 转发给一个同意的 approver」会通过同一条断言 |
| `never calls the host approver, for any verdict the gate can produce` | `ask`/`allow`/`deny` 三档跑完，approver **0 次**被调 | D9 依赖的正是这一点 |
| `CONTROL: a deny verdict does produce a refusal` | `deny` → `{allowed:false, reason:'denied'}` | 只差一个变量的对照组。没有它，「approver 从未被调用」同样与「夹具压根产生不了 verdict」一致 |
| `CONSISTENCY: the port signature is the one the engine calls` | 返回值绑到 `LegacyRunHost['askApproval']` | 防止签名漂移后这些用例还在绿、而测的函数已无人调用 |

**双向变异**：把 `void askApproval; void signal; return {allowed:true,scope:'once'}`
换成 `void signal; return askApproval(request, signal);` →
**2 failed / 2 passed**，红的正是前两条，对照组与 signature 用例仍绿（符合预期）。
还原按字节校验：`6D8510DF…13B6` 逐字一致，`git status` 复检该文件干净。
**生产源码零改动**（`worker-run-composition.ts` 未出现在 `git status` 里，才用 `git checkout --`）。

#### 净推论，以及它对 D9 的意义

**engine 腿上，经由 `ports.approval.authorize` 的用户询问根本不会发生**，
于是不会有 `permission.requested` 入账。因此 §D9.2 那个修法一旦实施，
在真实生产路径上会撞 `permission_resolved_without_request`
（`run-ledger.ts:237-245`，无对应 request 即抛）→ 按 §D9.3 实测，**整个 run 被判 `run.failed`**。

**这是一个升级而不是矛盾**：D9 说「拒绝不留痕」，本条说「在这条腿上压根没人能被问」。
两条合起来才完整。

#### 我不主张什么

`gateRunApproval` 的注释明写「the port is present because it is required, not because it
decides」——**这是设计立场，不是疏忽**。legacy 腿（`StreamingToolExecutor` / `ToolExecutionPipeline`
同样拿 `canUseTool`）是否仍然问用户，我**本轮没有查**。所以：

- 已证实：engine 腿的 `authorize` 端口不会转发给用户的 approver，`ask` 档被当成放行。
- **未证实**：「用户的审批意见在产品里被忽略」。这需要跨腿对比，本轮没做，**不记成已验证**。
  （**§D9.7 后续**：engine 腿这条已经查实了；「legacy 腿是否仍问用户」依然未查，
  但它已不影响结论——因为 legacy 腿在生产里不可达。）

§5.1 的处置因此要重排：**先定口径，再谈修法**——若 engine 腿本就不该有人问，
那 D9 的「记录一条被策略拒绝」根本不该走 `permission.resolved`（它是一个**用户决策**的
审计事件），而该走 `diagnostic`；这个口径必须由人拍板，不该由我在这里替架构做决定。

#### 方法论：这一轮第二次抓到自己的测试没有牙齿

第一版 `treats an ask verdict as allowed` 用例的 approver spy 返回 **allow**，
变异后它**依然绿**——因为「gate 自己放行」和「gate 转发给一个同意放行的 approver」
产出完全相同的返回值。把 spy 改成**拒绝**之后，两条用例才同时具备牙齿。
这是本轮 §D9.2 谓词事故的同族复发：**守卫的强度取决于它给对照组留了多少空间**，
而不是取决于它断言得多具体。

### D9.7 三条独立证据交汇：`permission.requested` 在生产里没有生产者，并**更正 §D9.3 / §D9.4**

这一节把 §5.1 那个悬着的问题答完了，代价是**推翻本报告 §D9.3 / §D9.4 两节的核心事实陈述**。

#### 先说被更正的是什么

§D9.3 / §D9.4 的**实测本身没错**：用真实 `RunController`，`observeFrame` 确实会铸造
`permission.requested` 进同一个 ledger（`seq` 为安全整数）。那两条用例是对的。

**错的是适用范围**：那条路唯一落在 `RunOrchestrator.observeFrame`
（`run-orchestrator.ts:1113`），而 orchestrator 腿**在生产里不可达**。
我三轮都在问「翻译对不对」，从没问过「这条腿跑不跑」。

#### 三条互相独立的证据

**证据一（§D9.6，已实测 + 双向变异）**：engine 腿 `gateRunApproval` 用 `void askApproval;`
显式丢弃用户的 approver → engine 腿**不发** `chat:permission` → `permission.requested` 无来源。

**证据二（读仓，非本轮实测）**：`packages/agent-protocol/GAPS.md:110-112` 已经写明：

> adapter 对 `chat:permission` 返回 `unmapped`。**这是行为变更**：当前代码会发出
> `permission_request`，迁移后不会。runtime coordinator 落地前 **permission 流程是断的
> ——这是有意的，好过发一个假的**

`worker-adapter.ts:192-196` 与之一致（`return { unmapped: true }`）。
**这条独立于我对 host 的任何推断，是仓库自己记下的已知状态。**

**证据三（本轮实测）**：`observeFrame` 要可达，得先有 orchestrator 模式。
`worker-session-runtime.ts:407-412` 的 `_readOrchestratorMode` 只在
`mod?.orchestrator` 为真时返回该模式，`worker-run-composition.ts:224` 据此选腿。
生产一共注册 **6 个**模式（`modifiers/index.ts:15-20`：research / conductor /
plan-task / automation / goal / computer-use）——**零个带 `orchestrator`**。

grep 判定不足以服人，所以直接问注册表本身。新增
`packages/host/tests/worker-product-runtime/orchestrator-leg-reachability.test.ts`
（**4/4 绿**），它 import 真实的 `modifiers/index.js` 以触发生产注册，然后读同一个单例：

| 用例 | 断言 | 作用 |
| --- | --- | --- |
| 正面 | 生产注册的模式下 `orchestrator !== undefined` 的 id 列表 `=== []`；**并先断言 `list().length > 0`** | CONTROL：注册表非空，否则空表也会「通过」 |
| CONTROL 1 | 注册一个带 `orchestrator` 的探针后，同一段过滤读出 `[PROBE_ID]` | 证明字段**可读**，且这段代码不是恒空 |
| CONTROL 2 | 带 `orchestrator` 的模式 → `selectRunDriverLeg` 返回 `kind:'orchestrator'` | 证明字段**真的决定选腿**，不是无关字段 |
| 后果 | `orchestrator: null` → `kind:'engine'`，且 `orchestratorFramesFor` 是会抛的毒药 | 正面陈述生产实际走的那条腿 |

**关于变异证明的诚实说明**：这四条**没有做生产变异**——
给某个生产模式加 `orchestrator` 要改在途车道的生产文件，本轮不做。
替代方案是**同文件内的判别结构**：第 1 条与第 2 条用**同一个真实 registry 对象**、
**同一段过滤代码**，差别只在「注册了什么」；第 2 条与第 3 条只差一个字段传递。
判别性由对照组提供，不靠跨文件变异。**证据等级：实测（对照组自足），非双向变异。**

#### 净结论

**`permission.requested` 在生产里没有任何生产者。** 三条路都不通：
engine 腿不发帧（证据一）、adapter 明写 unmapped（证据二）、
唯一会翻译的 orchestrator 腿不可达（证据三）。

于是 §5.1 的口径问题**有答案了**：engine 腿**本就不该有用户询问**——
这不是疏忽，`gateRunApproval` 的注释与 GAPS.md 的「这是有意的」两处独立声明互相印证。
**D9 要记录的是一次策略拒绝（`canUseTool` 说 deny），不是一次用户决策。**
而 `permission.resolved` 按协议定义是**用户决策**的审计事件
（`source` 闭集是 `host|policy|default|timeout|cancelled`），
用它记录策略拒绝是**语义错配**——尽管 `policy` 确实在闭集里，
但闭集里有它只说明「决议可以来自策略」，不说明「策略拒绝就该发这条」。

**这意味着 §D9.1 建立的那个锚点（「缺口早被识别，事件早被声明，只是没人发」）
需要修正**：不是「没人发」而是「**这条腿上不该有人发**」。
缺口是真的（TUI 侧拒绝确实不留痕），但它要的修法**不是**补一个
`permission.resolved` 生产者，而是为**策略拒绝**另选事件（`diagnostic` 是候选）。
**具体选哪个仍是架构口径，仍需人拍板**——但「候选里还包含
『补 `permission.resolved` 生产者』」这一条现在可以划掉了，
它在真实生产路径上会让 run 判死。

#### 顺带：这一节的定位，比「发现了一个 HIGH 缺陷」要弱

`GAPS.md` 记的「runtime coordinator 落地前 permission 流程是断的」
与本报告 §D9.6 / §D9.7 是**同一个事实的三处独立记录**——
三处各自独立写成，说明这个断裂此前一直是**已知的、被接受的中间态**。
所以 §5.1 现在应该按「**已知的架构中间态待收口**」处理，
而不是按「新发现的高危缺陷」处理。差别会影响优先级：
用户今天看到的现象（TUI 不留痕）是真的，
但它**不是一条新破的管道**，而是一条**当初就被有意切断的管道还没接上**。

### D11 [MED] `normalizeWorkerEvent` 有两份独立实现，其中一份的注释声称它们是同一个

追 D9.4 的接线时撞上的。

- **A 份**：`packages/host/src/worker-frames.ts:28`，使用者是
  `packages/host/src/run-execution.ts:411`。
- **B 份**：`apps/desktop/src/main/agents/server/router.ts:505`，使用者是同文件
  `normalizeAndObserve:777`、`router.ts:2871`、`router.ts:3114`。
- **两份都是活的**，路径不同、各自被各自的调用方使用。

而 `run-execution.ts:24` 的注释写着：

> `-> normalizeWorkerEvent` (**the SAME normalizer** the Desktop router …)

**它不是同一个。** 实测两份的臂集合：

| | 臂出现次数 | 去重后 |
| --- | --- | --- |
| A（host） | 39 | 37 |
| B（router） | 35 | 35 |

**只在 A 里有**：`chat:text_delta`、`chat:thinking_delta`（各出现 2 次 —— 就是 **D2** 记的那段
逐字重复的死分支）；**B 份里 `text_delta` 全文出现 0 次**。

**好消息是不丢数据**：两份的 `let sseEvent = event` 初值都是**原帧本身**，没有 final `else`，
所以未匹配的 `msgType` 原样透传（A 的那两支是「重塑形状」，B 是「原样放过」）。
坏消息是**同一个帧在两条路径上形状不同**：A 会把 `chat:text_delta` 重塑成
`{type:'text_delta', data:{…}}`，B 直接返回 `{type:'chat:text_delta', …}`。
消费者拿到什么 `type`，取决于哪条路先跑。

**为什么值得单列而不是并进 D2**：D2 说的是「A 内部有一段重复死分支」；
这一条说的是「**A 和 B 是同一个职责的两份独立实现，且没有守卫它们同步**」。
两份各自 200+ 行，谁先改谁说了算，而注释还在告诉读者它们是同一个。

**本轮未做**：没有逐臂比对两者的 `data` 字段映射（只比了 `msgType` 臂的集合）；
没有查 `legacy-sse-contract.ts:7` 那条「router.ts:450 的 normalizeWorkerEvent」契约
是否也被 host 那份绕过了。

---

### D10 [MED] census 的 `permission.resolved` 生产者是个幽灵，而守着「每行都指向存在的代码」的那个守卫只验文件不验符号

D9 往下追时顺手撞上的，且它同时解释了 **D9 的结构性成因**。

**先是被自己否掉的一个结论。** 我一度以为「至少权限侧还有一条 durable 记录」——
`permission.resolved` 在协议里是 durable、ledger 强制配对、描述明写
「Every decision is recorded, including timeout and cancellation」。
但 `run-session.ts:337-344` 自己写着：

> Nothing in this runtime emits `permission.resolved` — the Control Plane
> census names a producer that does not exist, and the only permission port
> here (`permissionResponder`) delegates the decision to the host rather than
> recording one — so a run that asks for approval and gets no resolution back
> is the NORMAL case today.

而 `control-plane-census.ts:171` 恰恰写着
`producer: 'packages/agent-runtime/src/controller.ts:RunController.respondPermission'`。
**两份文件互相打脸，而且都自称是权威。**

实测：`RunController.respondPermission` **全仓只出现在 census 文件自身**（两处），
`controller.ts` 里没有这个方法，`controller.ts` 全文也没有发布过任何
`type: 'permission.*'` 事件。真方法叫 **`respondToPermission`**（`controller.ts:1216`）。
所以这是一个**改名后没跟上的陈旧指针**，不是「功能没实现」——那个 control 通道是真的通的
（`structural-dispatch.ts:327`、`control-channel.ts:267` 都列了 `permission.respond`）。

**为什么它能长期绿着：守卫只验了引用的一半。**
`control-plane-census.test.ts` 里那条用例名叫
`every row points at code that exists`，实现却是：

```ts
const { path } = splitRef(ref);          // symbol 被解构出来，然后丢掉
if (path === '') continue;
expect(existsSync(join(REPO_ROOT, path)), ...).toBe(true);
```

`splitRef` 返回 `{ path, symbol }` 两半，**只有 `path` 半被断言**；`symbol` 半只在
`schema` 字段上被验（且还要 `isComplete(row)`）。`producer` / `handler` / `consumer`
三个字段里点名的代码，**改名、移动、删除都不会让任何东西转红**。

量化：70 条带冒号的引用里，27 条是严格 `path:Class.method` 形态（无散文、无附注，
因此可以被机械校验），其余 43 条混着散文（「translateFrame and …」、
「handleChatCommand (worker subprocess), …」），**从哪里截断附注是一个作者约定问题，
不是事实断言，所以本轮不动它们**。27 条严格引用里**恰好 2 条失败**，就是同一个幽灵
方法被点名两次（`permission.respond` 的 handler、`permission.resolved` 的 producer），
**25 条通过**。

**这解释了 D9 的结构性成因。** 协议里那条为「记录一次拒绝」而设计的 durable 事件
（`permission.resolved`）**没有生产者**；于是引擎退而求其次去用
`tool.timed_out`——而那是个协议非法的孤立完成事件（见 D9）。所以 D9 的三个候选修法里，
**最贴协议本意的那一个（给拒绝一个真实的 durable 记录）其实是补上 `permission.resolved`
的生产者**，它既不需要新增事件类型，也不需要给被拒的调用虚增一次 `tool.call_started`
（而后者会让 `accumulate` 把 `budgetUsed.toolCalls` 多计一次，见 `run-session.ts:1092-1093`）。

**已落的两条证明**（`packages/agent-runtime/test/control-plane-census.test.ts`）：

- 对照/健康用例（绿，且**修好 census 后仍然是绿的**）：断言严格子集数量 > 20、
  未解析数 < 总数（证明这个检查**有能力成功**，而不是「全判失败也算通过」）、
  以及已知正确的 `RunSession.observe` 引用未被误报。这三条专门防的是
  「collector 自己坏了 → `it.fails` 因为无关理由通过」这个空洞形态。
- 目标合同（`it.fails`）：每条严格引用都必须指向已声明的成员。

双向证明同样做了：把 census 里两处 `respondPermission` 临时改成 `respondToPermission`
→ 目标合同报 `Error: Expect test to fail`，**而对照用例保持绿**（这正说明它不是缺陷钉子）；
恢复后 `control-plane-census.ts` 的 SHA-256 逐字节还原
（`66F022AB…12EC0` → `9FA215EE…4BA81A` → `66F022AB…12EC0`），`git status` 确认无残留。

**修 census 那两行时要注意的**：`permission.resolved` 的真实落库位置不是
`respondToPermission`——按它自己的注释（`controller.ts:1220-1223`），答复走
Control Plane 的 decision path（Desktop 侧 `recordPermissionDecision`）并在那里持久化，
运行时自身不持有 approval 状态。所以「把它指到 `respondToPermission`」是让这行**指向真实
代码**的最小修正；「`permission.resolved` 到底该不该是一条 run 事件」是另一个更大的问题，
本轮**未做**。

**顺带记一笔我自己写错的度量**：第一版 collector 把 27 条**全部**判成未解析。我独立复现
的脚本只判 2 条，于是回头查了测试内的实际输出，发现解构多跳了一位
（`[, className, method]` → `className` 拿到的是方法名）。修完才是 25/2。
**如果当时直接采信测试里那个 27/27，就会把「守卫坏了」当成「27 个引用全坏了」写进报告。**

#### D10 已闭合（2026-10-18）：两行幽灵指针已修，目标合同已翻成普通 `it`

这是本报告**第一条真正动到生产代码**的闭合（前面 D6/D7/D13 只动测试）。改动是数据表里的
两行指针，各一处：

```
control-plane-census.ts:161  handler: …controller.ts:RunController.respondPermission
                           →          …controller.ts:RunController.respondToPermission
control-plane-census.ts:171  producer: …controller.ts:RunController.respondPermission
                           →          …controller.ts:RunController.respondToPermission
```

真方法在 `controller.ts:1216`（`RunHandle.respondToPermission`），全仓 grep 确认
`respondPermission` 不存在于任何地方。`git diff --stat` = **2 insertions / 2 deletions**，
没有别的改动。

**执行顺序是「先等信号，再删 `.fails`」**，不是反过来：

1. 修两行 → 跑测试 → `TARGET CONTRACT` 报 `Error: Expect test to fail`。
   这**就是**信号：`it.fails` 不会因为「碰巧通过」而失效，所以「合同成立了」是被**宣告**的，
   不是被假定的。
2. 信号到了才删 `.fails`，并把注释改写成「D10 closed on 2026-10-18」+ 为什么
   **必须**删而不是留着（留着会让下一次改名再次静默溜过去）。

**变异证明**（本报告第一次对生产代码做变异）：把两行改回 `respondPermission` →
**2 failed 变 3 failed**，新增那条的失败信息**逐字点名两条幽灵引用**
（`respondPermission is not declared in packages/agent-runtime/src/controller.ts`，
两行都在输出里）。改回修复态后哈希 `9FA215EE…A81A` 逐字一致。

**闭合后的读数**：`control-plane-census.test.ts` 回到 **2 failed / 73 passed**，
那 2 条正是**进来前就红**的 `workflow_run` 与 `research_updated`（另一条独立的 schema-symbol
守卫，与本次改动无关）。`packages/agent-runtime` 全量 **2 files / 3 tests failed /
1067 passed**，红数与基线一致，无连带。`typecheck:runtime` 与三项门禁全过。

**这条修好的实际意义不在于那两行本身**：在于守它们的守卫**从今天起会验符号了**。
在那之前，`every row points at code that exists` 这条**名字听起来比它做的事强**——
它只验文件路径存在。指针可以指向任何东西而它照样绿，这正是幽灵能同时出现在两行、
而守卫两次放过的原因。

### D10.1 同族的**第二类**漂移：不是幽灵，是路径迁移；而我刚加的守卫有个形状盲区

上一节我说「今天起它会验符号了」——**这句话当时是真的，但只对一种形状成立**。

#### 进来时还红着的那两条，我一直没定性；定性后发现不是同一回事

`control-plane-census.test.ts` 除 D10 之外还红两条（`workflow_run` / `research_updated`），
失败信息是 `WorkflowRunEvent is not exported by packages/agent/src/process/worker-protocol.ts`。
按 D10 的结论我会直接去改指针——**这次改指针是对的，但理由完全不同**：

- D10 的 `respondPermission`：**符号在仓库里根本不存在**，是幽灵。
- 这两个：`packages/agent/src/process/worker-protocol.ts` **今天只剩一行**——
  `export * from '@duya/host/worker-transport';`。符号**真的存在**（经 re-export 链），
  但已迁到 `packages/agent-protocol/src/worker-protocol.ts`（`:655` / `:691`），
  而**零生产代码**再从那个壳导入（全仓唯一的引用是一个 `.mjs` 测试夹具，从 `dist` 导入）。

所以它们是**路径迁移漂移**，不是幽灵。区别不是学术的：幽灵要改符号名，迁移要改路径，
而**判据只能来自 grep 全仓 + 读那个文件本身**——`respondPermission` 一次 grep 就出局。

#### 守卫的盲区：`path:Class.method` 匹配不到 `path:buildWorkflowRunEvent`

我为 D10 加的 `STRICT_MEMBER_REF` 要求**两个**点号段。`…:buildWorkflowRunEvent` 只有**一个**，
**不匹配** → 从未被收集 → 只被「文件存在」检查覆盖。
而那个文件存在（是个壳）→ **绿**。

于是 `workflow_run` / `research_updated` 的 **producer 字段同样漂移**，
却**一条红都没报**——因为旧守卫的 symbol 检查只跑 `schema` 字段（`test:101-112`）。

**这是同一个洞的另一种形状**，而且是活的：不是理论风险，就是这两行。

#### 修复

1. **改 4 行**（不是 2 行）——producer 和 schema 一起指向
   `packages/agent-protocol/src/worker-protocol.ts`。
2. **守卫扩到单符号形式**：`STRICT_SYMBOL_REF = /^[\w./@-]+\.tsx?:[A-Za-z_$][\w$]*$/`，
   两种形状都收集；符号检查补上 `interface|type|class|function|const|let|var|enum` 声明形式
   （原来只认 `name(` / `get|set|async name`，而 `export interface X {` 后面跟的是 `{`，
   **两种都不匹配**——不补的话每个单符号类型都会被误报）。
3. **健康检查加了 3 条断言**，见下。

#### 扩展守卫时我立刻犯了一个空洞守卫，被自己刚加的断言抓住

单符号走 `split('.')` 只得到**一个**元素。我沿用了 `[className, method]` 的**位置式解构**：

```ts
const [className, method] = ref.slice(at + 1).split('.');
// 单符号时 className='buildWorkflowRunEvent', method=undefined
className: isMember ? className ?? '' : '',   // → ''
method: method ?? '',                          // → ''
```

`method` 变成空串后，正则 `(^|[^.\w$])\s*[(<]` 匹配几乎任何源码——
**所有单符号引用都被报成「已声明」**，守卫等于没有。

**抓住它的是我在同一条健康检查里加的断言**（而不是我盯着输出看）：
`symbolOnly.length > 0` 通过了（收集到了，method 是空的），
但 `symbolOnly.some(r => r.method === 'buildWorkflowRunEvent')` **失败**——
因为 method 根本不是那个名字。

修法是**按形状索引，不按位置**：`className: isMember ? first : ''`,
`method: isMember ? second : first`。

这与我此前在 census collector 上犯的错**完全同族**（`[, className, method]` 让 `className`
拿到方法名，把 2/25 报成 27/27）。**两次都是「多段解构按位置取，结果取错了一位」。**
教训收敛成一句：**多段解构要么按位置并配一条断言，要么按形状索引。**

#### 变异证明

把 4 行改回 `packages/agent/src/process/worker-protocol.ts` → **0 failed 变 3 failed**：

- `workflow_run: WorkflowRunEvent is not exported by packages/agent/src/process/worker-protocol.ts`
- `research_updated: ResearchUpdatedEvent is not exported by …`
- **`every strict reference names a declared member`（新扩展的那条）**

第三条是关键：**它抓到了 producer 字段的漂移，而旧的两条守卫都看不到那里**。
还原后哈希 `64D3B378…C619` 逐字一致。

#### 读数

`control-plane-census.test.ts` **75 passed / 0 failed**——这个文件**第一次全绿**。
`packages/agent-runtime` 全量从 **2 files / 3 tests failed** 降到
**1 files / 1 test failed / 1069 passed**，剩下那条是 D5 已知的
`coalescing-throughput`（wall-clock 超时）。**三端基线净减 2 条红。**
`typecheck:runtime` 与三项门禁全过。

累计改动仍是**同一个文件**：`git diff --stat` = 6 增 6 删（2 行幽灵指针 + 4 行路径迁移）。

### D12 [MED-HIGH] `createIsolatedWorktree` 有两份实现，**生产跑的那份没有测试，测试守的是另一份**

追 `h8-2-consumer-inventory.test.ts` 的红时撞上的。这不是过期断言，是**结构性的测试倒挂**。

**事实（逐条查证，非推断）：**

| | 路径 | 谁在用 |
| --- | --- | --- |
| **活的那份** | `packages/host/src/worker-subagents/worktree.ts:121` | `packages/host/src/worker-subagents/service.ts:53` **import 它** |
| **死的那份** | `packages/agent/src/tool/SubagentTool/worktree.ts:118` | 唯一直接消费者是**它自己的测试** |
| 唯一的 worktree 测试 | `packages/agent/src/tool/SubagentTool/__tests__/worktree.test.ts:6` | `from '../worktree.js'` → **死的那份** |
| Host 侧 worktree 测试 | 不存在 | — |

也就是说：**生产执行 Host 那份，而全部 worktree 隔离测试跑的是另一份。**
`packages/agent` 那份在生产里已经不可达（`SubagentTool.ts` 本身已成垫片，
首行写着 "Compatibility exports; the bound task tool and execution live in Host"）。

**为什么那条测试会红**：`h8-2-consumer-inventory.test.ts` 里有一条用例叫
`worktree isolation is plan 496 implementation, **consumed not reimplemented**`，
断言 `SubagentTool.ts` 含 `createIsolatedWorktree`。它红了，**因为它的前提变成了假的**——
现在确实有两份实现。这条测试做得对，它说的事情已经不再成立。

**两份有多像**：194 行 vs 197 行；把 import 路径归一后逐行比对得 91 处差异，
但其中大部分是 `worktreeRoot()` 那处插入造成的**行偏移假象**。真正的语义差异只有一处：

```
A（死）: path.join(getDuyaRoot(), 'worktrees', …)            → getManagedShellDataRoot()
B（活）: path.join(dataRoot,  'worktrees', …),  dataRoot = DUYA_APP_DATA_PATH || resolveDataRoot()
```

**先说一个被我自己否掉的更严重的结论**：我本以为这意味着两份把 worktree 建在**不同目录**，
而该模块的整个隔离论证（doc 首段：「worktree 放在 `~/.duya/worktrees` 而不是仓库内，
所以用户的 `.gitignore` 和编辑器文件监听永远看不到它」）就建立在这个根上——
若目录不同，隔离承诺在两份之间是不一致的。查下去发现**两者的常见路径落到同一个根**：
`getManagedShellDataRoot()` 在 `DUYA_DATA_ROOT` 未设时也返回 `resolveDataRoot()`，
而 `resolveDataRoot()` 最终是 `join(homedir(), '.duya')`。

**真正的差异只在一个角落**：当 `DUYA_DATA_ROOT` **与** `DUYA_APP_DATA_PATH` **同时**被设置时——
- 死的那份（经 `getManagedShellDataRoot`）用 `DUYA_DATA_ROOT`；
- 活的那份用 `DUYA_APP_DATA_PATH`。

**用户实际撞到的是活的那份的行为，而被测的是死的那份的行为。** 这就是一个未被测到的
副本所允许发生的事——也正是这个缺陷的实际危险所在。

**定性**：不是当下就在伤害用户的 bug（要两个环境变量同时设才会分叉），
但它是**结构性测试倒挂**——一段会真实创建 git worktree（涉及文件系统写操作）的代码，
其**活的副本零覆盖**，覆盖落在不可达的副本上。

**本轮未做**：没有逐行确认两份除 `worktreeRoot()` 之外真的等价（91 处差异里有偏移噪声，
需要更严谨的对齐算法）。

**调用点普查（后来补做，把核心论断从「推断」升为「已证」）**：全仓搜
`createIsolatedWorktree(` 的**调用点**（不是定义、不是 import），命中只有：

```
packages\host\src\worker-subagents\service.ts:434     ← 唯一的生产调用点
packages\agent\src\tool\SubagentTool\__tests__\worktree.test.ts:69/94/95/109/121  ← 全部是测试自己的
```

**所以「生产跑 Host 那份、agent 那份不可达」是已证事实，不是推断。**
唯一还需要追的是 `packages/agent/src/tool/SubagentTool/index.ts:22` 那条 re-export
是否有人用（`createBuiltinRegistry` 本身被 `DuyaAgent.ts` 使用，但 builtin 注册的是
**垫片** `SubagentTool`，它委托给 Host 的 `bound-tool`——这条链本轮走通了，但没写用例钉住）。

### D14 已补齐：从「推测 CI 会全绿」升级为**实测它会全绿**

§D14 提出 `__binaryResponse`（`anthropic-messages.ts:2127`）是 Plan 418 流式路径的地基、
是 SDK 私有选项，并断言「SDK 若改名/删除，`_iterSSEMessages` 会在每个 Anthropic 调用第一个
token 上抛，流式整体静默失效而 **CI 全绿**」。前半句已查实，**后半句当时是推理**。

新增 `packages/ai/test/anthropic-streaming-over-http.test.ts`（**4/4 绿**，850ms）：
真 `@anthropic-ai/sdk`（**不 mock**）+ 真 `http.Server` on 127.0.0.1 +
`res.write()` 分块发送，且**故意把一个 SSE 帧从中间劈成两次 write**（中间 20ms 延迟），
逼解码器跨 chunk 重组。四条分别覆盖：正常流、跨 TCP 写的单帧重组、
畸形帧被跳过（前后帧仍到达）、可修复帧被**修复而非跳过**（文本含 `line1`/`line2`）。

#### 变异证明 + 一组对照读数

删掉 `__binaryResponse: true`（文件原本干净，`git checkout --` 还原，
哈希 `63E26CE7…5222C` 逐字一致），**两个文件在同一变异下分别跑**：

| 测试文件 | 变异后 | 说明 |
| --- | --- | --- |
| `tool-protocol-adaptation.test.ts`（含 §D9 提到的两条 Plan 418 用例） | **18 passed / 0 failed** | **CI 全绿** |
| `anthropic-streaming-over-http.test.ts`（新增） | **4 failed / 0 passed** | `Error: Attempted to iterate over a response with no body` |

**第二行是第一行的解释**。旧用例把 `new Response(frames)` 直接塞给 **mock 的** SDK，
于是 `__binaryResponse` 只是 mock call 上的一个**没人读的属性**——把它删掉，
那 18 条没有任何一条会察觉。新用例走真 socket，删掉它流式**立刻整体失效**。

所以 D14 的结论从「应该会全绿」变成「**实测会全绿，且有一个用例会红**」。
这条缺口不是理论上的，是**可证的**，现在有守门人了。

#### 顺带

我第一版新测试自己红了一条，原因和断言无关：`console.warn` 的 spy 装在 `beforeAll`、
记录**跨用例累积**，于是第 3 条（畸形帧被跳过）的 warn 被第 4 条
（可修复帧**没有**被跳过）读到了。加 `beforeEach` 的 `mockClear()` 才绿。
两条用例对同一个 warning 断言**相反**，所以清除是必需的，不是洁癖。

### D12 已闭合：6 条测试已搬到你用户跑的那份实现上，另加一条只有活版写得出的

前面 §D12 定性的是「测试守死副本」。这一节把覆盖搬到活的那份，**并且搬的过程中
把上一节没做的逐行对齐做完了**。

#### 逐行对齐的结果：只差 3 处

两份各 194 / 197 行，**190 行逐字相同**。差异只有：

| 处 | `packages/host`（活） | `packages/agent`（死） |
| --- | --- | --- |
| import ×2 | `@duya/data/data-paths` 的 `resolveDataRoot`、`../worker-logger.js` | `../../utils/duyaRoot.js`、`../../utils/logger.js` |
| `worktreeBaseDir` 末行 | `process.env.DUYA_APP_DATA_PATH?.trim() \|\| resolveDataRoot()` | `getDuyaRoot()` |

其余（`git()` / `gitOrNull` / `describeGitFailure` / `slugifyWorktreeName` /
全部四种 `WorktreeError` / 分支名与 worktree 路径的生成 / `mkdirSync` / 日志）**逐字节相同**。
所以上一节否掉的结论继续成立：**隔离承诺本身没有分叉**，两份会建到同一个数据根
（只要不同时设两个环境变量）。

#### 「优先级相反」核实为**准确**，并给出精确机制

我上一轮写的这句话需要证据，现在有了。死版那个 `getDuyaRoot` 是个 re-export
（`utils/duyaRoot.ts:1-4` → `getManagedShellDataRoot`），实现在
`packages/host/src/managed-shell/paths.ts:6-12`：

```ts
const legacyRoot = process.env.DUYA_APP_DATA_PATH?.trim();
if (!process.env.DUYA_DATA_ROOT?.trim() && legacyRoot) return resolve(legacyRoot);
return resolveDataRoot();
```

即 **`DUYA_DATA_ROOT` > `DUYA_APP_DATA_PATH`**；而活版是
**`DUYA_APP_DATA_PATH` > `DUYA_DATA_ROOT`**。两者都设置时确实相反 ✓。
只设其一时两者一致——**这正是 6 条测试之所以在迁移后不用改一行 fixture 的原因**。

#### 迁移：6 条搬到 `packages/host/tests/worker-subagents/worktree-isolation.test.ts`

原测试只设 `DUYA_APP_DATA_PATH`，所以两条路径选出的根相同，**逻辑逐字保留**，
只把 import 指向 `../../src/worker-subagents/worktree.js`。**7/7 绿**
（1246ms，含真实 `git worktree add`）。

#### 新增的一条：只有活版写得出来

死版**无法表现出**那个相反的优先级（它的行为就是相反方向本身），所以这条只能写在这里。
它锁的是：**两个变量都设置时，活版服从 `DUYA_APP_DATA_PATH`**。

顺带查清了一个真实后果：**设了 `DUYA_DATA_ROOT` 的用户（想迁移数据），若同时残留
`DUYA_APP_DATA_PATH`，worktree 会落在旧根而数据库落在新根——「一份数据」分两处。**
这是**有意的**（`worktree.ts:109-110` 明写「Keep the historical application data
override」），所以**记录不报缺陷**；但此前两边都没测过，现在活版这一侧钉住了。

#### 变异证明：故意做**精确**变异

把实现改成
`DUYA_DATA_ROOT?.trim() || DUYA_APP_DATA_PATH?.trim() || resolveDataRoot()`
（反转优先级但保留后备）→ **7 tests 变 1 failed / 6 passed**，**唯一红的就是那条新的**，
失败信息是 `worktree did not follow DUYA_APP_DATA_PATH when DUYA_DATA_ROOT was also set`。

一次变异同时证明两件事，**这才是选这个变异形状的理由**：

1. 新测试**有牙齿**——它精确咬住优先级，不多不少；
2. 前 6 条在**两个方向下都绿** → 迁移是**等价**的，测试没有因为搬家而变弱。

选这个形状还有一个安全理由：保留 `DUYA_APP_DATA_PATH` 作后备意味着
worktree 始终落在临时目录里；直接改成 `resolveDataRoot()` 会让变异态的测试
往用户真实的 `~/.duya/worktrees` 写 worktree。**变异不该给用户机器留垃圾。**

还原按字节校验：`BAA8A9E2…F9F72` 逐字一致（该文件原本干净，用 `git checkout --`）。

#### 读数与仍未做的事

`packages/host/tests/worker-subagents` **3 files / 29 tests 全绿**。
`check:encoding` 与 `check:test-coverage` 全过。**生产代码零改动。**

**没做**：死副本 `packages/agent/src/tool/SubagentTool/worktree.ts` **仍然存在**，
它那 6 条测试也仍然在跑。删它属于退役动作而不是检查，且它在 `packages/agent`
（并行 session 可能涉及的目录），本轮**只报告不删**。建议：确认
`packages/agent` 已无 `SubagentTool` 消费者后一并删两份。

### D13 已闭合：第三条被掏空的保证（「child 走到 durable terminal」）已重新被守

§D6 补的是两条保证；这一轮把**第三条**也补上了——就是上一轮定性
`h8-2-worker-run-channel-seam` 时发现「在失败处停住、今天实际无人验证」的那条。

用例叫 `takes the child to a durable terminal that the run layer will answer for`，
它红在**第一句断言**：生产加了 attempt 围栏，而用例从不发 `epoch`。
**拒绝是对的，代价是这条保证归零**——所以按 D6 的做法，用活的机制重述它：

`packages/host/tests/worker-product-runtime/run-open-durability-and-isolation.test.ts`
新增第三条用例（复用同一套真装置：真 `RunOrchestrator` + 真 `RunController` +
真 SQLite `RunStore` + 真执行通道）：

- 建父 run，再建带 `parentRunId` 的子 run，**从数据库读回 `parent_run_id`** 证明这条链是持久的；
- 给子 run 灌两帧真实原生帧再结算 —— 否则下面「completed」也能被一个什么都没干的 run 满足；
- 子行 `status === 'completed'` 且 `finished_at` 是**数字**（排除「有终态但没时间戳」那种搁浅形状）；
- **父行断言为正面主张**：仍是 `running`、`finished_at` 为 `null`。
  这条才是关键——结算子 run 时顺手把父 run 也结算掉，会让「子代理跑完一轮」看起来像「整段对话结束了」。

**首跑 3/3 绿**，即该保证在当前生产接线上成立。**变异证明**：在 harness 的持久化桥里
让结算子 run 时连父 run 一起结算（**改 harness 而非生产**——`run-orchestrator.ts` 是在途
L-HOST 车道文件，动它会和并行工作打架；这条证明的是**断言抓得住「父被连带结算」**，
不是「生产今天做没这么做」）→ 只有这一条转红
（`expected 'completed' to be 'running'`），另两条不受影响。

同目录合跑 **19 files / 117 tests，5 红**——与本轮进来前**逐字相同**
（116 → 117 正是新增的那条），**新增红 0、意外转绿 0**。

**踩到一个关于「哈希校验」本身的坑，值得单记**：还原脚本里 `BEFORE`（基线哈希）是
**每次调用时重算**的，而 `restore` 那次重算记下的是**变异后**的哈希——于是正确的还原
被报成 `HASH MISMATCH`。**哈希基线必须一次捕获并持久化，不能每次重算**，
否则「不一致」这个信号同时表示「还原破坏了文件」和「我的记账错了」，两者不可区分。
这次靠三条独立的旁证确认还原是对的：无 `parentId` 残留文本、`settleRun(` 只出现 1 次、
CRLF 计数与变异前一致（361 / 0）。

---

### 更正一条我带过六轮的错误结论：adapter 的 `__binaryResponse` 传输路径**不是**零覆盖

从第一轮起，我在待办和 §6 里反复写着「adapter 真 HTTP + 真 SDK 闭环：
`tool-protocol-adaptation` 把 `sdk.post` 全 mock 掉，`__binaryResponse` 传输路径**零覆盖**」，
并把它当成一条待办挂了六轮。

**这句话是错的，而且我从来没验证过它。** 这一轮去查，发现
`packages/ai/test/tool-protocol-adaptation.test.ts` 里有一条

```ts
/** Build a raw fetch Response whose body streams the given SSE frames. */
const sseResponse = (frames: string): Response =>
  new Response(frames, { status: 200, headers: { 'content-type': 'text/event-stream' } });
```

并且有**两条专门针对 Plan 418 的用例**：

| 行 | 用例 | 断言 |
| --- | --- | --- |
| `:311` | `skips malformed SSE frames instead of crashing the stream (Plan 418)` | 中间塞一帧 `event: garbage`，后面的 `message_stop` **必须送达**，并断言日志含 `Skipping malformed SSE event` |
| `:346` | `repairs repairable SSE frames instead of skipping them (Plan 418)` | 可修复的帧**被修复而非跳过**，且**不**打印 skip 日志 |

实测 `-t 'Plan 418'` → **4 passed**。

也就是说：**绕过 SDK、改用 `client.post(..., __binaryResponse)` + `_iterSSEMessages`
的全部理由——「第三方 Anthropic 兼容端点的一个畸形帧不能杀死整轮」——是被测着的**，
而且测的是**真 `Response` + 真 SSE body**，不是 mock 出来的帧。

**为什么这条错误能在我的排查里活六轮**：它符合我的预期（「adapter 边界是已知薄弱区」，
18 号报告也提过真实 adapter 取证），于是**我把它当成了已知事实而非待验证命题**，
后续每轮都在复述它。这和我在 §8.1 里列的三个被证伪假设是同一类错误，
只是方向相反：那些是「假设很真所以去查」，这个是「假设不重要所以没查」——
**而它恰恰重要**：如果它成立，那是一个 HIGH 级覆盖缺口；如果不成立，我就白挂了六轮。
**判断一个既有结论值不值得信，看它被复述了多少次，而不是被验证了多少次。**

去查之后**发现了一个真的缺口，只是不是我说的那个**：

- **D14 [MED]**：`__binaryResponse: true`（`anthropic-messages.ts:2127`）是整条流式路径的
  地基——Plan 418 绕开 SDK 的**全部理由**就是它。它是 SDK 的**私有选项**
  （只声明在 `internal/request-options.d.ts:65`，`core/api-promise.d.ts` 里没有），
  **且从未对着真 SDK 执行过**——`tool-protocol-adaptation` 把整个 SDK mock 掉了。
  SDK 若改名或删掉它，`client.post` 返回已解析的值而非 `Response`，
  `_iterSSEMessages` 会在**每个 Anthropic 调用的第一个 token** 上抛，
  流式能力**整体静默失效而 CI 全绿**。
  **缓解事实**：SDK 自己也用这个选项（`resources/beta/messages/batches.js:198`），
  所以不是纯私货。
  **可低成本关掉**：同包 `embed.test.ts:12,36` 已经在用 `createServer` +
  `listen(0,'127.0.0.1')` 打真 HTTP——**模式现成，只是没用在 Anthropic 这条路上**。

真正的 adapter 缺口**还在**，但**不是**这一条：缺的是**真 HTTP 传输**（自建 `fetch`/`http`
服务器、真实分块边界、真实背压），而 `__binaryResponse` 的**响应体处理**是有覆盖的。

---

### D14 [MED] Plan 418 的整个设计压在一个 SDK 私有选项上，而没有任何测试对着真 SDK 跑过

`packages/ai/src/api/anthropic-messages.ts:2123-2130`：

```ts
return client.post('/v1/messages', {
  body: { ...openParams, stream: true },
  __binaryResponse: true,      // ← 整条流式路径的地基
  timeout: 600000,
  ...
});
```

Plan 418 明写这是为了绕开 SDK 的 `messages.stream()`——后者「对每个 SSE `data:` 行做
JSON.parse，第一帧畸形就崩掉整条流」。所以**「第三方 Anthropic 兼容端点的一帧畸形
不能杀死整轮」这个保证，全靠 `__binaryResponse: true` 成立。**

**查了装着的 SDK（`@anthropic-ai/sdk` 0.80.0），这个选项确实存在且语义如注释所述：**

```
internal/request-options.d.ts:65      __binaryResponse?: boolean | undefined;
internal/parse.js:24-26               if (props.options.__binaryResponse) { return response; }
```

但要注意两件事，一好一坏：

- **好**：SDK **自己也在用**这个选项（`resources/beta/messages/batches.js:198`），
  所以它不是纯私货，被改掉的可能性不高。
- **坏**：它只声明在 `internal/request-options.d.ts`，`core/api-promise.d.ts` 里**没有**
  它——即**不在公开的 options 类型面上**，且下划线前缀本身就是「内部」的约定。
  TypeScript 因此**不会**在 SDK 改掉它时报错（今天能编译，说明该 options 形参是宽松的，
  多半带索引签名）。

**真正的缺口**：`packages/ai/test/tool-protocol-adaptation.test.ts` 把
`@anthropic-ai/sdk` **整体 mock 掉**（`vi.mock('@anthropic-ai/sdk', …)`，
`post` 是一个 `vi.fn()`），所以 **`__binaryResponse` 从未对着真 SDK 执行过**。
一旦 SDK 把它改名或删掉：`client.post` 会返回**已解析的值**而不是 `Response`，
`openStream` 声明的返回类型是 `Promise<Response>` 但运行期拿到的不是 ——
`_iterSSEMessages(rawResponse!, …)` 会在**每一个 Anthropic 调用的第一个 token 上**抛，
**流式能力整体静默失效**，而且 CI 全绿。

**这个缺口是可以低成本关掉的**：同一个包里 `packages/ai/test/embed.test.ts:12,36`
已经在用 `createServer` + `listen(0, '127.0.0.1')` 打真 HTTP 了——**模式是现成的**，
只是没用在 Anthropic 这条路上。

**本轮未做**：没有起真服务器验证（那正是待办）；没有查 `@anthropic-ai/sdk` 的版本升级策略
（是否有 pin、升级时谁复核这条私有契约）。

---

## 3. 不是缺陷的（分类同样重要）

| 簇 | 数量 | 判定 | 依据 |
| --- | --- | --- | --- |
| 桌面端「Desktop Host … API is not running」 | ~70 | **过期 fixture**，且**整层覆盖归零** | `db-handlers.test.ts:400-408` 的 `vi.mock` 只覆盖了 `getDesktopHostLocalAgentProfileApi`，其余 getter 全是 `importActual` 的真身，`sessionApiClient` 为 null 即抛（`desktop-host-api.ts:326/331/501`）。而 `db-handlers.ts` 现在有 100+ 处走 `getDesktopHost*Api()` |
| `sse-frame-codec-silent-drops` | 1 | 过期断言 | codec 现在**故意**转发 delta（`worker-frame-codec.ts:124-127`），`engine-chat-start-assembly-proof.test.ts:614` 正是要求 `chat:text_delta` 出现的。测试仍要求「静默丢弃」 |
| `run-lifecycle-seam` | 4 | fixture 缺陷（已知类） | `db-client registered no message listener`，与 18 号报告 §8 修掉的 `turn-assembly-seam` 同根：`worker-db-client.ts` 在模块加载时自注册，静态 import 把监听器算进了 `PRE_EXISTING` |
| `control-plane-census` ×2 | 2 | ~~过期普查行~~ **已修（§D10.1）** | 不是过期断言：那两个符号经 re-export 链真的存在，只是**路径迁移**了。已改 4 行并把守卫扩到单符号形式，该文件现 75/0 全绿 |
| `worker-interagent-calls` | 1 | 过期源码形状断言 | 断言 entry 从 `./pending-interagent-calls.js` import；该文件已改为 Host 持有。**它声称的实质（同一个 registry）未复核** |
| `sync-protection` W2 | 1 | **真实缺陷，见 D4** | 单跑稳定红；`plugin` 与 plain bundled 同为 2 分 |
| `coalescing-throughput` | 1 | **wall-clock 预算，见 D5** | 单跑 14343ms > 10000ms，工作完成未挂死 |
| `worker-path.test.ts` ×3 | 3 | 测试基建 | `vi.spyOn(fs,'existsSync')` 在 ESM 命名空间上不可用 |
| `program/registry.test.ts` | 1 | 过期期望 | 实际 23 条命令，期望 22；多出的 `model` 是并行车道刚加的 |
| `automation-fire-persistence` ×3 | 3 | **过期 mock**（本轮定性） | `wake-rearm.ts:40` 调的是 `wakes.listPendingWakes()`，而测试的 `vi.mock('../../db/core-connection')` 只提供 `persist` / `clear` / `listAll` / `get` / `pruneStale`。生产路径压根不走那个 mock 里的方法，于是断言拿到 `[]`。与 §3 里 ~70 条同族（mock 没跟上迁移） |
| `h8-2-consumer-inventory` ×4 | 4 | **过期普查表 + 见 D12** | 它报「11 条记录点不再恰好命中一次」与「3 处 `new DuyaAgent(` 未登记」——这是清单漂移，它**正在正确报警**。其中「worktree … consumed not reimplemented」那条红指向 **D12** 的真实缺陷 |
| `h8-2-worker-run-channel-seam` ×2 | 2 | **过期测试：写入围栏**（本轮定性） | 实测拒绝原因为 `run:complete from desktop/host-run-api-adapter requires an attempt epoch (no epoch): **a run write with no attempt is refused rather than made unfenced**`。这是刻意的**attempt 围栏**改动，而这两条用例的 `workerRequest('run:complete', …)` 没带 `epoch`。**不是缺陷**，但它们在失败处就停住，所以那条名为「takes the child to a durable terminal that the run layer will answer for」的**耐久性保证今天实际无人验证** |
| `tui-settings-panel` | 1 | 在途改动中 | per-model effort 行的说明文案与断言不一致 |
| `task-store` retention / `watcher` debounce | 2 | **flaky** | 两次运行一红一绿 |
| `eval-baseline-comparison` (2) + `eval-legacy-loop` (4) | 6 | **构建产物缺失**，不是断言问题 | `agent bundle missing at packages/agent/bundle/agent-process-entry.js — run 'npm run bundle:agent'`。这 6 条是本仓**唯一会真起 worker 子进程**的 eval 闭环，今天根本没跑起来（与 19 §1.2 G8「bundle tracked 但比源码旧」同族） |
| `project-entity-handlers` (5) / `app-connection-handlers` (6) | 11 | 过期 fixture | 与 db-handlers 同根：`getDesktopHost*Api()` 在 `sessionApiClient` 为 null 时抛 |
| `WorkflowPanel.test.tsx` | 12 | 过期测试，**面向一个已被刻意替换的入口** | `WorkflowPanel.tsx:1148` 自标 `// ─── legacy panel entry ───`，`:1157-1171` 现在只渲染一个占位（文案 `workflow.panel.useMainPage` + 按钮跳 `setCurrentView('workflow')`）。真正的双 tab UI 在主页面里，这个文件已不再渲染它。组件与测试**都干净**（不在在途改动里）⇒ 是已提交的设计变更，测试没跟上 |
| `run-orchestrator.test.ts`（desktop） | 8 | **6 条过期 + 2 条覆盖空档，见 D6；同根于 D7** | 实现已搬成 `@duya/host` 垫片，夹具还是旧的 |
| `h8-2-consumer-inventory` (1) / `h8-2-worker-run-channel-seam` (1) / `automation-fire-persistence` (1) | 3 | 未逐条判定 | 签名分别是 `expected [] to have a length of 1`，需单独看 |

---

## 4. 顺带关闭 18 号报告的一条缺口

18 号报告 §4 把「用户失败任务走哪条腿」列为**审查认定的最高价值缺口**。已关闭：

- `selectRunDriverLeg`（`packages/host/src/worker-run-composition.ts:223`）只在
  `run.orchestrator` 非空时走 orchestrator 腿。
- 全仓 `orchestrator: {` 只出现在**两个测试文件**里
  （`packages/agent/src/process/__tests__/orchestrator-run-leg.test.ts:251`、
  `packages/host/tests/worker-modes/modifiers/registry.test.ts`）。
  生产的六个 mode（`packages/host/src/worker-modes/modifiers/index.ts:15-20`）
  **没有一个声明 orchestrator**，`packages/agent/src/modes/**` 下 `orchestrator`
  零命中。

**结论：真实任务 100% 走 engine 腿。** 18 号报告那套 engine 腿全绿测的是用户真正
走过的路径——「未复现」这个负面结论不再悬在「可能测错了腿」这个风险上。

仍然限制 18 结论的三条边界（本轮未动）：真实 provider adapter、重建后的 bundle、
真实 Desktop。

---

## 5. 下一步（按信息量排序）

1. **D9 选修法 —— §D9.1 查实之后，推荐只剩一条**：**给 `permission.resolved` 补上
   真正的生产者，让 `#dispatchCall` 在 `!verdict.allowed` 时发它，并把那发非法的
   孤立 `tool.timed_out` 撤掉。**
   - 为什么是它：它就是协议为「请求有记录、答复没记录」这个缺口而设的事件，
     durable、ledger 已强制配对、词典（`LEGACY_PERMISSION_ACTION_MAP`）已实现；
     D9.1 已逐段实测证明它**今天在所有 surface 上都没有生产者**。
   - 为什么归属问题不再是口径问题：Control Plane 的 `recordPermissionDecision`
     **只覆盖 Desktop 的两个 surface，TUI 完全不走它**，所以运行时那条 run 事件
     是 TUI 唯一可能的落点。
   - 需要一并核对的副作用（**§D9.2 已实测出三条**）：
     1. 撤掉 `tool.timed_out` 后，`run-session.ts:488-492` 的工具计时清理
        （`tool.call_completed || tool.timed_out`）要跟着改。
     2. **必须成对发布（§D9.3 已把这条从注意事项升级为硬约束）**：单发
        `permission.resolved` 会被 ledger 以 `permission_resolved_without_request` 拒掉。
        而在真实 `RunController` 上实测，**这种违例不是丢事件，而是把整个 run 判成
        `run.failed`**——比今天静默丢弃更糟。**已确认好消息**：legacy 的
        `chat:permission` 帧确实经 `observeFrame` 落进**同一个** `RunLedger`
        （§D9.4 逐跳查实）。所以实现顺序必须是
        「确认 request 已入账 → 才发 resolved」，**不是**在 resolved 这边自己补 request。
        **关联字段是 `requestId` 而不是 `toolCallId`**（§D9.4：生产帧不带 `toolCallId`，
        `worker-process-entry.ts:2317` 传的 `id` 就是 `approval.callId`）。
     3. TUI 投影器 `host-event-stream.ts` **没有 `permission.resolved` 的 case**，
        `default: return null` 会静默丢弃它。所以光发事件 = **有记录但看不见**，
        投影侧要一并改，否则 D9 的用户可见症状并没有修好。
   - 验收线有**两个**：§D9 里那条 `it.fails`（不钉事件形状，三种变异已验）
     与 §D9.5 里那条（TUI 投影侧，同样不钉形状）。**两个都要过**——
     只修 ledger 会得到「有记录但看不见」。

   > **⚠️ §D9.6 + §D9.7 实测后，上面的推荐已被推翻，不要按它实施。**
   > `gateRunApproval` 把内层 approver 显式 `void` 掉（`worker-run-composition.ts:212`），
   > 且 `behavior: 'ask'` 被当成放行——**engine 腿上经由 `ports.approval.authorize`
   > 的用户询问根本不会发生**。上面第 2 条那个「好消息」只在 legacy 帧被**手工喂进去**的
   > 夹具里成立；在真实生产路径上，`chat:permission` **没有任何生产者**
   > （§D9.7 的三条独立证据），实施这条修法会撞 `permission_resolved_without_request`
   > 并**判死整个 run**。
   >
   > **口径问题在 §D9.7 已经有答案了**：engine 腿**本就不该有用户询问**
   > （`gateRunApproval` 的注释与 `GAPS.md` 的「这是有意的」两处独立声明互相印证）。
   > 剩下的不是口径，是**选型**：
   > - **已可划掉**：补 `permission.resolved` 生产者——语义错配。那是**用户决策**的
   >   审计事件，而 engine 腿要记的是一次**策略拒绝**（`canUseTool` 说 deny）。
   > - **待选**：为策略拒绝另选事件，`diagnostic` 是候选。选哪个仍需人拍板，
   >   但**问题已经从「怎么补生产者」变成「这类拒绝该记成什么」**。
   > - **验收线要跟着改**：§D9 / §D9.5 那两条 `it.fails` 断言的是
   >   `permission.*` 事件。**若最终选 `diagnostic`，这两条合同的谓词得一起改**
   >   （它们刻意没钉事件形状，所以改起来是收敛而不是重写）——
   >   改之前先确认新谓词**真的覆盖候选形状**，别重演 §D9.2 的谓词事故。
   >
   > 另注：§D9.1 的锚点要修正——不是「事件早被声明、只是没人发」，
   > 而是「**这条腿上不该有人发它**」。缺口是真的，修法方向要换。
2. **D12 把 worktree 测试搬到活的那份**（`packages/host/worker-subagents/worktree.ts`），
   `packages/agent` 那份在确认无活消费者后删掉。这是三份重复实现里**唯一**一份
   「测试守死副本」的——D11 的两份 normalizer 目前都有各自调用方，还没到那一步。
3. ~~**修 census 那两行**~~（D10，**已完成 2026-10-18**，见 §D10 闭合节）：
   `RunController.respondPermission` → `RunController.respondToPermission`，改完把 D10 那条
   `it.fails` 翻成普通 `it`。**注意**：这修的是「指针指向真实代码」，
   **不等于**「`permission.resolved` 该不该是一条 run 事件」——后者已被 §D9.7 重新定性
   （engine 腿不该发它，缺口真实但修法方向要换）。
4. **补 Desktop IPC 转发层的测试装置**（覆盖归零，~70 条红是它的症状）。
   这是当前最大的**未覆盖面**，不是最大的 bug 面。
5. **D1 的裁决补一条分支**：settle 时同时读「原生缺席」。它需要一条先红的测试，
   载体就是 `run-execution.test.ts` 那两条——它们今天正好是红的。
6. **D3 改成断言不变量而不是形状**（在 driver 里给 post-codec 转换点一个可命名的
   符号，让守卫读符号而不是读表达式开头）。
7. D5：`coalescing-throughput` 要么提 `testTimeout`，要么把虚拟时钟场景拆小——它现在
   永久污染基线读数。
8. **D4 需要一个产品口径**（谁必须压过谁），不是代码问题；定了之后再改分数并补
   「两种候选顺序结果一致」的判别性用例。
9. 18 号的下一项区分实验：真实 adapter 边界取证。

---

## 6. 本轮未做的检查（如实列出）

- 没有改任何生产代码（D1 所在的 `run-orchestrator.ts` 属在途车道；D4 需要产品口径；
  D9 的修法本轮仍未实施；D10 只登记 census 那两行指针，未改）。D9 / D10 / D9.5 的生产侧
  「承重性」都只在**临时变异**中验过，三处变异均已按 SHA-256 逐字节还原。
- **未验证 TUI 最终把 `permission.resolved` 画成什么**：§D9.5 只钉住「投影器为它产出
  一个 frame」。overlay 怎么关、转录本加不加行、工具行怎么标，都留给实现方；
  也就是说**「用户看得见」这一半目前只有最弱的那一层被守住**。
- **§D9.7 未做生产变异**：`orchestrator-leg-reachability.test.ts` 的 4 条**没有**做
  跨文件变异（给生产模式加 `orchestrator` 要改在途车道文件）。判别性由**同文件内**的
  3 条对照提供——它们与被测用例共用**同一个真实 registry 对象和同一段过滤代码**。
  证据等级标注为「实测（对照组自足）」，**不是**「双向变异」，不混写。
- **§D9.7 未查 `chat-event-translator.ts` 与 `worker-adapter.ts` 的分工**：
  两者对 `permission` 的处理**相反**（前者映射、后者 `unmapped`）。
  我据 GAPS.md 采信了后者，但**没有查生产走的是哪一条**，只查了「orchestrator 腿不可达」
  这个足以独立成立的事实。哪条是生产路径，**未验证**。
- 未验证 `recordPermissionDecision` 的 13 条用例覆盖的是哪些 surface（只知道它只服务
  Desktop 的两个 surface，未逐条核对覆盖面）。
- **D12 只做了结构层面的查证**：**调用点普查已完成**——全仓 `createIsolatedWorktree(`
  的生产调用点只有 `service.ts:434`，其余全是那个测试文件自己的调用，
  所以「agent 那份在生产不可达」是**已证**而非推断。
  但**没有逐行证明两份除 `worktreeRoot()` 外等价**（91 处行差异里含偏移噪声），
  **也没有跑 worktree 测试确认它确实是绿的**——只确认了它存在且导入的是不可达副本。
- **`h8-2-worker-run-channel-seam` 的 2 条红已定性**（本轮，见 §3）：过期测试，
  生产加了 attempt 围栏而用例没带 `epoch`。它留下的覆盖空档**已在 §D13 补上**
  （新用例首跑即绿 + 变异证明），但旧用例本身属 L-DESKTOP 车道，本轮只登记不修。
- **D9.6 未做跨腿对比**：已证实 engine 腿的 `authorize` 端口不会转发给用户 approver，
  且 `ask` 档被当成放行；但**没有查 legacy 腿**（`StreamingToolExecutor` /
  `ToolExecutionPipeline` 同样拿 `canUseTool`）是否仍然问用户。所以
  **「用户的审批意见在产品里被忽略」这句话本轮不成立**，未验证的不记成已验证。
  这条决定了 §5.1 的口径该怎么定，是下一步的第一优先。
- 没有做变异注入这一条对 D9.6 不适用——D9.6 **做了**双向变异证明
  （2 failed / 2 passed，按字节还原）。各条结论的证据强度分层是：
  - D1：运行期日志 + 断言双重证据（最硬）；
  - D9 / D9.6 / D10：四步链路逐步实测 + **双向变异证明 + 按字节还原**（次硬）；
  - D2/D3/D4：读码定位到具体行与具体机制（D4 另有单跑稳定复现）；
  - §3 里的分类：除标「单跑」的以外，都是「读码 + 批量跑」级，**未逐条单跑复核**。
- 没有跑 `typecheck:all` / `architecture:check`（本轮零生产改动）。
- 没有跑 e2e / 真实 Electron / 真实 provider。
- 桌面端 106 条红已**逐条归属到文件与用例**（按失败签名归因，见 §3 表与 D7 表）；
  **10 条全部定性**（其中 1 条指向 D12）。
