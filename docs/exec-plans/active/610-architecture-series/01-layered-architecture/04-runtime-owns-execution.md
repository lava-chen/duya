# 04 — Runtime 拿执行

> Runtime = "一次 Run 的执行器":model loop、tool call、subagent、event emission。
> **它不决定为什么运行、什么时候运行、重试几次、属于哪个 Project。**
>
> **2026-10-04 修正**:原先的验收口是"worker 不再 import `DuyaAgent`、改为实现 `ExecutionChannel`"。**这条太弱** —— 把 `DuyaAgent.streamChat()` 藏进一个 adapter 就能让它变绿,而循环仍在旧包里。本文件已按修正重写。

---

### 0.1 完成判据的重大更正(2026-10-05,实测推翻)

**本节早期版本把验收写成「worker 入口不再调用 `agent.streamChat(`」→ **这是错的,实测推翻了它。**

`scripts/architecture/boundary-gates.mjs:257-264` 的 `TURN_LOOP_SHAPE` 是三个正则,对**模块源文本**求值:

```js
repetition:     /\b(?:while|for)\s*\(/
modelStream:    /\.streamChat\s*\(/
toolExecution:  /\.execute(?:All)?\s*\(|ToolExecutionPipeline|getRemainingResults/
```

`isTurnLoopModule(src)` = 三者全中。**它按文件形状判定,不按调用点判定。**

**所以在 `agent-process-entry.ts` 里删掉 `agent.streamChat(` 的调用不会改变 G7** —— G7 报的是 `DuyaAgent.ts` **这个文件**。实测:调用点移除前后 `G7=1, G8=1` 不变。

**G7/G8 归零的真正条件:把 `DuyaAgent.ts` 拆到不再同时具备那三个形状** —— 即文件级重构(把模型流段、工具执行段从同一文件里分出),**不是接线改动**。

**"执行归属"因此不是"谁调用了 `streamChat`",而是"哪个文件同时具备循环、模型流、工具执行三个形状"。** 计划早期把这个判据写成接线层,是因为读了 finding 数量而没有读**门禁如何产生 finding** —— 与本系列其他几处误判同形态。

### 0.2 第二条更正:drain 的「已绑定」不等于「可达」(2026-10-05)

`#drainOutcomes` 在 `run-engine.ts:392` 被调用,**在 `#streamModel` 返回非空之后**。`openModelStream` 绑 `emptyModelStream()`(`:3245`)时零帧 → `#streamModel` 在 `:490-495` 返回 `failed` → 循环 `break`,**drain 永远到不了**。

**所以"引擎的 drain 已成为消费者"在模型腿绑定之前不可达,无论 `drainTools` 的签名是否正确。** 判据必须区分**类型层面已绑定**与**运行期可达**。

### 0.3 第三条更正:切换不是接线改动(2026-10-05,实测)

前两条更正都还在假设"绑定 `openModelStream` 是可执行的中间步骤"。**实测证明它不是。**

| 调用点 | 同一行代码 |
| --- | --- |
| `model-leg.ts:216` | `open: () => runTurnStream(params.deps)` |
| `DuyaAgent.ts:2431` | `const streamGenerator = runTurnStream(turnStreamDeps)` |

**而 `RunEngineImpl.#run` 是自足的循环:** `for` 在 `run-engine.ts:306`,`#streamModel` 在 `:382` **无条件、在循环顶部**。

**所以绑上模型口不是"借引擎一轮",而是"把整个循环交给引擎",而 legacy 生成器仍在跑同一个循环。**

**实测后果**(`turn-leg-cutover-ordering.test.ts:268`):一次 `chat:start` 向 provider 发**两次**请求(`expect(observed.entered).toBe(2)`)。两次尝试**共享同一套 per-attempt 累加器**,任一次传输死亡都会调 `onRetryReset` → `executor.discard()`,**在另一个底下生效**。

**并且没有中间位置:** `#streamModel` 在循环顶部无条件调用,所以引擎没有"等 legacy 把这一轮交给我"的位置可等 —— 要么 `requireLeg()` 拒绝、run 结束 `failed`;要么请求翻倍。**提前发布 leg 是竞态,不是修复。**

**因此:步骤 1–3 合起来危险、单独做又无意义。** "先接上,再移除"不是一个可用的顺序。

### 0.4 真正的切换与 G7/G8 是同一件事

**切换需要 legacy 生成器停止驱动那一轮。而让 `DuyaAgent.ts` 不再具备三个 `TURN_LOOP_SHAPE` 形状 —— 也就是 G7/G8 归零的条件 —— 做的正是同一件事。**

**所以 S2 的下一步不是又一个接线切片,而是一次以"legacy 停止驱动"为起点的重构,且 `runTurnStream` 的调用点必须从 `DuyaAgent.ts` 移走。**

**⚠️ 上面原本接着的"那一步同时关闭 G7 与 G8"是错的,已被 §0.5 推翻。** 移走 `runTurnStream` 调用点是切换的**必要条件**,但**不是** G7/G8 归零的**充分条件**。

**此前所有切片都在为它铺路**(引擎、drain 契约、终态背压、管线发布、durable ledger、`TurnOutputPort`、模型腿接缝、取消到达 provider)。**最后一步无法被切成更小的安全步骤,因为引擎的循环是自足的,不能被"喂一轮"。**

### 0.5 第四次更正:移走 `runTurnStream` 不足以让 G7/G8 归零(2026-10-05,实测)

**§0.4 的"同一切片一起关 G7/G8"是第三次写错。** 本轮用**真实门禁模块**(`node -e` 直接 import `boundary-gates.mjs` 调用 `isTurnLoopModule`,不用自己抄的正则)重测,得到:

**更正一:`modelStream` 在 turn loop 里根本没有命中。**

`TURN_LOOP_SHAPE.modelStream` = `/\.streamChat\s*\(/`。`DuyaAgent.ts` 里该形状只命中两行:

| 行 | 实际是什么 | 在 turn loop 内? |
| --- | --- | --- |
| `:781` | compaction summarizer | 否 |
| `:4483` | side question | 否 |

**turn loop(`:1794` 起)调的是 `runTurnStream`(`:2431`),不是 `.streamChat(`。** 所以"把 `runTurnStream` 调用点移出 `DuyaAgent.ts`"**动不到 `modelStream` 这一项**。

**证伪实验:** 模拟删除整个 turn loop(`:1795`–`:3300`),再对真实门禁求值 —— **`isTurnLoopModule` 仍为 `true`**。按 §0.4 的判据做完切换,**门禁依然红**。

**更正二:G7/G8 有两个 owner 文件,不是一个。**

用真实门禁模块求值,匹配 `TURN_LOOP_SHAPE` 的文件是:

- `packages/agent/src/agent/DuyaAgent.ts`
- `packages/agent/src/process/agent-process-entry.ts`(经 `agent.streamChat(`,`:3349`)

**第二个 owner 恰好是本轮 `b4154d1f` 刻意保留的唯一真实驱动。** 也就是说:即使 `DuyaAgent.ts` 完全归零,只要 worker 入口还直接调 `agent.streamChat(`,G8 仍红。

**G7/G8 归零的完整条件(取代 §0.4 的说法):**

1. `DuyaAgent.ts` **不再同时具备那三个形状** —— `modelStream` `:781`+`:4483`、`toolExecution` `:76`/`:2037`/`:2734`/`:4397`、`repetition` 37 处(29 处在 turn loop 外)
2. `agent-process-entry.ts` 的 `agent.streamChat(` 移除,改为驱动 runtime 侧入口

> **⚠️ 条件 1 曾被写成"三个形状全灭"并把 29 处 loop 外 `repetition` 列为必须一并迁走的负担。那是过强的表述,已由 §0.7 更正。**

### 0.6 Owner 裁决(2026-10-05,三项,均已定)

**裁决一 —— terminal hold 保留,改测试。**

`8b62fc82` 把终态帧扣在 `event-emitter.ts:563` 的 `#heldTerminal`,等 `RunController.settle` 走 `publishCommittedTerminal`(`:372`)放行。`structural-dispatch.test.ts:130` 失败是因为它用**裸 emitter**(无 controller、无 settle),断言终态已进 `seen`。

**终态没有丢,只是没有放行路径。** 已实测确认 `run.completed` 仍 `admitted`,`hasHeldTerminal` 为真。

**处置:生产代码不动,测试跟上新契约** —— 先断言终态被扣住且不在 `seen`,再显式 `await publishCommittedTerminal({ status: 'ok' })` 断言 `published`,最后才断言 `seen` 出现 `run.completed`。**放行前/后两个断言来自不同状态,这是它保持可判别性的关键。**

**不选"回退 hold"**:终态背压修的是真实缺陷 —— run 曾能宣布 storage 从未接受的 `completed`。

**裁决二 —— 按真实范围做 G7/G8 归零,一个切片。**

范围即 §0.5 列的三项:`turn loop` 迁移 + `:781`/`:4483` 两个 loop 外模型流用途 + worker 入口 `agent.streamChat(` 的驱动方式。**目标是门禁真归零,不是"做完切换但门禁仍红"。**

**不选"先只做 turn loop"**:中间态必然门禁红,且需额外记录"这是已知红",污染回归判断。

**不选"先做纯形状改造"**:搬完形状门禁会绿而 legacy 仍在驱动 —— **门禁绿会被误读成"架构已对"**,这正是本文件反复记录的那类错觉。

**裁决三 —— 先结未结项,再启动 S2 最终重构。**

先把 `structural-dispatch` 与 G7/G8 范围清掉,避免带着红项进入最大的一次重构。

### 0.7 第五次更正:归零只需清掉一个形状,且它同时更正了 §0.6 裁决二的描述

§0.5 条件 1 写成"三个形状全灭",并把 29 处 loop 外 `repetition` 列为必须一并迁走的负担。**那是过强的 —— 且它污染了 §0.6 裁决二的范围描述。**

`isTurnLoopModule`(`boundary-gates.mjs:274`)是**合取**:

```js
return TURN_LOOP_SHAPE.repetition.test(src)
    && TURN_LOOP_SHAPE.modelStream.test(src)
    && TURN_LOOP_SHAPE.toolExecution.test(src)
```

**清掉任意一个形状,该文件就不再匹配。** 那 29 处 loop 外 `repetition` 全部是**无关**循环 —— 工具注册(`:1608`/`:1632`/`:1703`/`:1735`/`:1742`)、时间线快照(`:3497`/`:5005`)、消息格式化(`:4519`/`:5015`/`:5025`)、skill 注入(`:1164`)、MCP 工具枚举(`:4674`/`:4696`/`:4798`)。**它们不是轮次循环,也不必为过门禁而搬家。**

**最省的一条路是 `toolExecution`:** `DuyaAgent.ts` 命中 4 处 —— `:76`(import `ToolExecutionPipeline`)、`:2037`(构造)、`:2734`(`getRemainingResults`)、`:4397`(`orchestrator.execute`)。`:2037`/`:2734` 随 turn loop 迁移自然消失,**`:4397` 在 loop 外,需单独处理**。

**但必须说清代价:** 靠这条过门禁,意味着"该文件不再同时具备三形状",**不是**"该文件不含轮次逻辑"。`DuyaAgent.ts` 仍持有 `:781`/`:4483` 两处 `streamChat`、仍持有 29 个循环。**门禁绿 ≠ 架构已对。**

**因此两个层次必须分开记账,不得互相冒充:**

| 层次 | 判据 | 达成方式 |
| --- | --- | --- |
| **门禁归零** | 任意一个形状不匹配 | 迁 turn loop + 处理 `:4397` |
| **架构到位**(裁决二要求的是这个) | turn loop 真由 runtime 执行;worker 入口不再直连 `agent.streamChat(` | 完整切换 |

**另有一处对范围的补充实测:** `:781` 是 compaction summarizer、`:4483` 是 side question,**两者都是单发、无工具、一次性的文本生成,本就不是 agentic 轮次**。它们**不该塞进引擎的轮次循环**,而应走一个更窄的一次性文本端口。**这既是正确的架构切法,也比"为了过门禁硬塞进引擎"更诚实。**

**这条实测把裁决二的范围收窄了:从"迁走两个 loop 外模型流用途"变成"给它们各自一个窄端口"。** 这不减轻工作量,但避免了把无关逻辑硬塞进轮次循环。

这是本文件最重要的一条。`ExecutionChannel` 是 **controller 调用 executor 的端口**。

```
server 侧                                      worker 侧
RunController                                  ExecutionChannel 实现
  ├─ 铸造 runId / seq                            ├─ 收到 start(manifest, input)
  ├─ 决定终态                                     ├─ ???
  ├─ 投影成 legacy SSE                            └─ ???
  └─ 经 ExecutionChannel ──────────────────▶
```

**worker 实现了这个端口,只证明"入口换了",不证明"执行归 runtime 了"。** 现有 CLI 的 headless 路径已经演示了这个区别:`headless-run-host.ts:26` 写着

```
-> duyaAgent.streamChat      (the real executor)
```

它接的是**真实 `RunController` + 真实 `InProcessTransport` + 真实 `InMemoryRunEventStore`**,但 executor 仍调旧 agent 的 `streamChat()`。**这套组合今天就能通过旧的验收口,而执行权一点没动。**

---

## 1. 当前状态(实测,`master` @ `135901bf`)

### 1.1 已闭合(此前计划写成待修,现已修)

| 缺陷 | 状态 | 证据 |
| --- | --- | --- |
| **F01** DB bridge 破坏 Run receipt | **已修** | `run-receipt.ts:177` `writeRunReceiptOnWire` 与 `:358` `readRunReceipt` 并排,序列化器与读取方同源 |
| **F02** 审批持久化拒绝后仍授权 | **已修** | `router.ts:2313-2352`:`durable.status === 'refused'` 时 defer 分支返回 200 且**明确不通知 worker**;非 defer 返回 503 `permission_decision_not_recorded` + `retryable: true` |
| **F05** native envelope 绕过预算 | **已修** | 定向回归通过 |
| **F06** 公共 terminal 早于 durable barrier | **已修** | 定向回归通过 |

### 1.2 事件流:已改善,但生产背压未闭合

**已做:** `controller.ts:537-541` 声明 stream 为 "ONE production `EventSource`: byte-bounded rather than count-bounded, durable frames retained and the producer paused instead of the oldest event being shed without a word, and a second reader refused"。

**缺口(实测):** `whenWritable()` 在 `backpressure.ts:560` 和 `run-session.ts:1161` 都有定义,`run-session.ts:1136` 的注释明确写着

> awaits {@link RunEventStream.whenWritable}

**但全仓没有任何生产方 await 它。** 匹配到的 6 处全是定义和注释:

```
backpressure.ts:34    文档
backpressure.ts:128   文档
backpressure.ts:560   定义
coalesce-guards.ts:92 文档
run-session.ts:1136   文档
run-session.ts:1161   定义
```

**结论:队列声明 `paused` ≠ 模型循环真的暂停了。** 慢 reader 下 durable 事件仍在积累。G15 的验收必须按此重写(见 §5)。

### 1.3 未完成

| 项目 | 状态 |
| --- | --- |
| runtime 接管模型循环 | **尚未完成** |
| S0 边界门禁 | 在隔离 worktree,未进主检出/CI 链路 |

---

## 2. 验收口(重写)

**"仅把入口改成 `ExecutionChannel` 不能算 runtime 落实"。** 真正的验收是五条:

1. **runtime 拥有 `模型请求 → 工具执行 → 工具结果回填 → 下一轮` 的循环。** 证据:runtime 包内存在该循环的实现,`packages/agent` 不再持有它。
2. **runtime 拥有执行期预算、取消传播、子任务回收和退出清理。** 证据:这些决策在 runtime 内做,`DuyaAgent` 只提供装配。
3. **worker 入口只负责装配端口、接收命令、转发事件。** 证据:`agent-process-entry.ts` 变薄,不再有 turn 循环逻辑。
4. **`DuyaAgent` 成为向新 runtime 委托的兼容 facade。** 证据:它只保留公开类型面与委派,不持有 `ModelClient` / `ToolExecutor` 的实现选择权。
5. **同一个执行引擎被 Desktop worker、CLI 和 eval 使用。** 证据:三处调用同一个 RunEngine,不是三个实现。

### 2.1 对门禁的直接后果

G4(worker 不 import `DuyaAgent`)**单独不足以证明任何一条**。它必须升级为:

- **G4a** worker 入口不 import `DuyaAgent` —— 保留但降级为**必要非充分**条件
- **G4b** runtime 包内存在 `模型→工具→回填→下一轮` 的循环实现
- **G4c** 旧循环的实现从 `packages/agent` 消失(不只是入口不再引用)

**并且:绕过方式必须能被抓到。** 通过中间函数绕回旧循环,当前 G4 看不见(见 §6)。

### 2.2 server 侧监督 vs worker 侧执行

必须明确分工,**避免两边各建一个完整 controller,重复决定 seq、预算和终态**:

| 职责 | server(Control Plane 侧) | worker(runtime 侧) |
| --- | --- | --- |
| `runId` 铸造 | ✅ 唯一 owner | ✗ 只接收 |
| `seq` 铸造 | ✅ 唯一 owner | ✗ 只上报原始帧 |
| 终态决定 | ✅ 唯一 owner | ✗ 上报候选终态 |
| durable barrier / CAS | ✅ | ✗ |
| 模型循环 / 工具执行 / 取消传播 / 子任务 | ✗ | ✅ |
| 执行期预算**判定** | ✗ | ✅ |
| 跨 Run 重试决定 | ✅ | ✗ |

---

## 3. 核心执行契约(评审要求补齐的六项)

| 契约 | 必须回答 | 状态 |
| --- | --- | --- |
| **RunEngine 端口** | 模型、工具、上下文、审批、事件存储分别如何注入? | **待定义** |
| **输入快照** | Manifest 之外,本轮历史、附件、catalog、steering 如何进入执行? | **待定义** |
| **执行 attempt/fence** | worker 重启后,旧 worker 的迟到事件和写入怎样被拒绝? | checkpoint 状态机已有资产,**缺生产接线** |
| **工具副作用恢复** | 调用已发生但结果未保存时,怎样区分可重试与结果未知? | 同上 |
| **子任务生命周期** | 父 Run 取消/失败/预算耗尽时,subagent 和后台命令怎样处理? | **待定义** |
| **扩展执行规则** | contributor 顺序、超时、异常、取消、卸载分别怎样处理? | **待定义**(见 [02](02-tooling-and-extensions.md)) |

**已有可复用资产:** `packages/agent-runtime/src/checkpoint/` 的 `checkpoint-store.ts` / `branch-plan.ts` / `unsupported.ts`。但 600 原先把 lease/fence/recovery 只放进接管表,**缺生产接线步骤与验收场景** —— S3 必须补上。

### 3.1 retry 的两类必须分开

原文"runtime 不知道重试几次"**过宽**:

| 类型 | owner | 说明 |
| --- | --- | --- |
| **跨 Run 重试** | Control Plane | 决定要不要开新 attempt |
| **单 Run 内瞬时重试** | runtime / provider adapter | 网络抖动、限流等,同一次 attempt 内 |

两者不得互相替代。runtime 可以在**单次 Run 内**重试瞬时错误,但不能决定"这次 Run 失败了要不要再来一次"。

### 3.2 `data` 包的约束要纠正

原文"禁止业务状态决策"过严。正确表述:

> `data` 禁止**业务状态决策**(即"这个 Goal 该不该继续"),但**允许认识** Goal / Task / Run 的数据类型与 schema —— 它实现 repository,就得知道记录长什么样。

---

## 4. 实施步骤

### Step 1:定义 RunEngine 端口(先于任何搬移)

不是先搬代码,是先定义注入形状。缺了它,搬移只会把耦合换个位置。

### Step 2:抽出最小完整循环

从 `DuyaAgent` 抽出 `模型请求 → 工具执行 → 回填 → 下一轮`,注入端口,**让 Desktop worker 真正调用它**。不是接线,是真的跑。

### Step 3:闭合执行可靠性

背压(§1.2 的缺口)、真实取消、审批、预算、durable terminal、子任务清理。

### Step 4:同一引擎接 CLI / eval

用同一套 API 验证多轮、工具报错、取消、存储拒绝、worker 退出、慢消费者。

### Step 5:再迁 core / tooling / capabilities

每迁一块,切断旧依赖并验证**真实消费者**。

### Step 6:最后做 Session data contract 和 facade 退役

有回填、恢复、兼容证据后才删旧关系。

---

## 5. 门禁(重写 G15)

**旧写法不够:** 只断言"事件没丢、`paused === true`"。

**新验收必须包含:**

1. 持续产生事件、消费者停读 → **内存仍受约束**(不是无限增长)
2. 随后能够**继续读取**,或通过**可靠 replay** 补齐
3. `whenWritable()` 被**真实生产方** await(当前:零)

断言方式:让生产方在 `whenWritable()` 上真的挂起,断言模型循环随之停止推进 —— 而不是只读队列的 `paused` 标志。

---

## 6. S0 门禁的已知盲区(诚实声明)

| 门禁 | 盲区 |
| --- | --- |
| G4 | 扫入口里的 `DuyaAgent` **名称**,识别不了中间函数绕回旧循环 |
| G6 | 扫 DDL 的 `NOT NULL`,**证明不了生命周期已独立** |
| G1 | 把整个 `@duya/ai` 归 core,与"拆分混合包出口"的要求不一致 |

**变异证明应该制造真实的违规实现**,而不只是"把检测器改坏后测试变红":

- 通过中间函数绕回旧循环 → G4 应红(当前不会)
- 清理 Session 时连带丢 Run → G6 应红(当前不会)
- core 间接调用 provider → G2 应红(当前可能不会)

**当前已完成的变异证明只覆盖了"检测器坏掉会红"这一半**,不覆盖"真实违规会被抓到"。这是 S0 剩下的主要工作。

### 0.8 为 14b 备的实测依据(2026-10-05,owner 裁决二执行前)

**`:781` compaction 与 `:4483` side question 需要新端口,不能复用 `ModelPort`,也不能复用 `createLegacyModelPort`。**

| 候选 | 为什么不合适 |
| --- | --- |
| `ModelPort`(`ports.ts:352`) | `:781` 用 `toolChoice: 'none'`,而 `ModelRequest`(`ports.ts:372-391`)**没有 `toolChoice` 字段**。`tools: []` 语义近似但不等价 —— 计划 523 P4.1 的意图是"明确禁止工具调用",不是"没有工具可用"。 |
| `createLegacyModelPort`(`run-engine-model.ts:365`) | 硬编码 `sources.llmMessages()` 与 `sources.declaredTools()`(`:368`/`:370`),**它服务的是"某一轮"的装配**,不是"一次独立请求"。单发生成没有轮次上下文。 |

**结论:需要一个独立的一次性文本端口(形状:systemPrompt + messages + maxTokens + temperature + signal,无 tools,返回聚合文本)。**

**这不是门禁要求,是架构要求** —— 把单发无工具生成塞进轮次循环,会让引擎误以为存在一个可 drain 的工具回合。§0.7 已说明:门禁绿与架构到位必须分开记账,此处正是"架构到位"的具体含义。

**已复用的接缝(14b 不必新造):** `createLegacyModelPort`、`createTurnLegModelPort`、`TurnPipelinePublisher`、`ModelLegPublisher`、`TurnOutputPort`、`ToolDrainItem` 三路判别联合、`ToolSideEffectLedger`。

### 0.9 14b 切片分解(按 owner 裁决二;顺序有依赖,不得乱序)

**不变量:`packages/agent-runtime` 不得 import `packages/agent`(G1 强制),所以循环体必须转成端口调用,不能"直接搬过去"。**

| 步 | 内容 | 依赖 | 门禁影响 |
| --- | --- | --- | --- |
| b1 | 一次性文本端口(§0.8):`systemPrompt + messages + maxTokens + temperature + signal`,无 tools,返回聚合文本 | 无 | 无 |
| b2 | `:781` compaction 改走 b1;`:4483` side question 改走 b1 | b1 | `modelStream` 少 2 处 |
| b3 | turn loop 体转成端口调用并迁出 `DuyaAgent.ts` | 已就位的 12 条腿 | `repetition` 少 8 处、`toolExecution` 少 `:2037`/`:2734` |
| b4 | `:4397` orchestrator `yield*` 整流委托移出本文件 | b3 | **`toolExecution` 归零 → `isTurnLoopModule` false** |
| b5 | worker 入口 `agent.streamChat(`(`agent-process-entry.ts:3349`)改为驱动 runtime 侧入口 | b3/b4 | G8 第二个 owner 消除 |

**b4 是 G7/G8 在 `DuyaAgent.ts` 上归零的那一步**(合取谓词,清一即可,见 §0.7)。**b5 是 G8 完全归零的那一步。**

**每步都必须独立 mutation-proven,不得合并提交。** 类型移动、行为变更、schema 收缩不得混批。

**b3 的风险点(必须显式证明,不得默认成立):**
- durable transcript 写入不得丢
- tool-result 帧不得丢
- `PostToolUseFailure` 钩子不得丢
- 十一项 drain 消费(`3d00769a` 的穷举)必须由引擎**执行**,不只是"仍在源码中"

**已知不可验证项:** 无真实 provider key、无 Electron renderer。端到端只能用假 provider;真实 undici 请求是否在该 signal 上真断、packaged 路径均未验证。**这个限制必须写进每次交付报告,不得省略。**

### 0.10 b2 之后的状态与 owner 裁决(2026-10-05)

**G7 归零。这是本系列第一次有门禁真正清零。**

`b1531622` 把 `:781` compaction 与 `:4483` side question 迁上 `OneShotTextPort`,`DuyaAgent.ts` 内 `.streamChat(` **命中数为 0** → `isTurnLoopModule` 为 false → baseline 中那一行 G7 被删除(19 → 18 fingerprints)。

**我在派工时预测"G7/G8 仍为 1",worker 实测推翻 —— 理由是我把合取谓词的方向记反了:** 清掉**任意一个**臂即清除 finding(§0.7 已写明),我却在 briefing 里写成"清掉一个不够"。

**G8 仍为 1,但 owner 已不是 `DuyaAgent.ts`**,现为 `packages/agent/src/process/agent-process-entry.ts`(经 `agent.streamChat(`)。**那是 b5 的地盘。**

**b4 因此作废** —— 它原本是为"清掉 `toolExecution` 形状"设计的,如今 `DuyaAgent.ts` 已不匹配,无需再动 `:4397` 才能归零。剩余步为 **b3**(迁 turn loop)与 **b5**(worker 入口)。

#### 裁决一:保留 compaction 的行为变更

端口联合的 `failed` **不携带部分文本**,故 summarizer 旧有的"error 帧后 break 并返回半截摘要、记为 `success`"无法保持。实测 `compact/summaryRetry.ts:199-242` 的影响:

| provider 措辞 | 旧 | 新 |
| --- | --- | --- |
| `context_length_exceeded` | success + 落盘 | **不变**(缩输入重试) |
| 未标记(如 `upstream_error`) | success + 落盘 | **fatal,升级到抑制机制** |

**裁决:保留。** 理由与本计划一贯取向一致 —— **宁可失败,也不落盘一个不完整摘要**。这正是"宣布未落地的成功"那一类缺陷的镜像。

**这是有意的行为变更,不是回归。任何后续切片都不得把它悄悄改回去。**

#### 裁决二:约 118 处失效引文等 b3/b5 后统一重写

b2 使 `DuyaAgent.ts` 位移 +30/+41,22 个文件里约 118 处 `DuyaAgent.ts:NNN` 文档引用失效。worker 已举证其中一处在 **HEAD 就已不准**(声称的 `executor.addTool` 实为 `privateProgressCalls.push`),故机械改号只会产出"换一种错法"的文档。

**裁决:等 b3/b5 完成、行号最终稳定后一次性重写。** b2 已修好本次改动真正涉及的引用(one-shot 块、port-guards、run-engine-model、b1 测试)。

#### 裁决三:推进 b3,b5 随后收 G8

### 0.11 b3 被阻断:引擎会丢掉助手的回复(2026-10-05,三条阻塞,已逐条实测)

**b3 未执行,未提交。** worker 拒绝在会静默丢数据的前提下动手,这个判断经我**逐条独立核实,全部成立**。

#### 阻塞一(承重):引擎完全不产出 assistant 消息

`run-engine.ts:483-486` 把 `text` / `thinking` / `tool_use_delta` 归入 `default: break` —— 注释写着"它们不决定任何事"。实测引擎能产出的 `RunEvent` 全集只有:`diagnostic`、`tool.call_started`、`tool.timed_out`、`turn.started`。

**没有任何端口承载组装好的 assistant 消息:** `TurnOutputPort` 只有 `recordToolResult` / `finishTurn` 两个方法(`ports.ts:672`);`RunEventStorePort`、extension 都没有。

而 `DuyaAgent.ts:2644-2721` 会构建 `finalAssistantContent`(thinking + signature + redacted + text + tool_use 块)并 `_pushDurable`。

**结论:迁移循环 = 从 transcript 里删掉模型真正的答案。这是本切片绝不能做的事。**

> **⚠️ 我修正 worker 的第一条表述:** 它说"没有任何端口"。实测 `chat-event-translator.ts:677` **确实有** `assistant.message_finalized`(带 `content` + `stopReason`),且在 protocol 侧已注册(`payloads.ts:687` / `registry.ts:202` / `required.ts:94`)。
>
> **但方向相反:** `translateFrame` 是**入站**翻译器(legacy `chat:` 帧 → 事件),而引擎需要的是**出站**产出。**更关键:实测 `translateFrame` 在整棵树里零引用** —— 这个接缝存在但**从未接线**。
>
> **所以阻塞依然成立,但准确表述是"接缝存在却在错误的方向上,且完全未接线",而非"不存在"。** 两者对下一步的影响相同:引擎需要一个出站产出口。

#### 阻塞二:模型口是反的

`createTurnLegModelPort`(`run-engine-model.ts:442-450`)调 `publisher.requireLeg()` **拉取** legacy 循环发布的 leg;未发布时抛错。**这就是双请求危险的结构形态** —— 不是竞态,是需要拆掉的方向倒置。

#### 阻塞三:runtime 里没有 per-request 取消

实测 `llmRequestTimeoutMs` 与 `createChildAbortController` 在 `agent-runtime` 中**各 0 次**。取消交接没有落点。

#### 同时修正我 briefing 里的三处数字

`DuyaAgent.ts` 是 **5295** 行不是 5008;turn loop 的 `while (compactionRun === null && …)` 在 **`:2170`**(`:2170` 是 compaction 泵,非轮次本体);`engine-drain-carryover.test.ts` 是 **16** 个 `it()` 不是 18(实测确认),且其表 `:44`/`:45` 两行**已标注 "live wiring NO"**。

#### 最小安全拆分(worker 提议,待裁决)

| 步 | 内容 | 性质 |
| --- | --- | --- |
| **b3a** | 给 `TurnOutputPort` 加 assistant 消息接缝(turn/blocks/signature/redacted/usage),`#streamModel` 累积 | **纯增量** |
| **b3b** | per-request signal,给 `llmRequestTimeoutMs` 一个落点 | 纯增量 |
| **b3c** | 反转模型口,让引擎自己拥有请求,退役 leg | 方向变更 |
| **b3d** | 真正的切换,此时 `entered === 1` 才可证 | 行为变更 |

**b3a–b3c 不动 legacy 是安全的 —— 因为此刻还没有任何东西驱动引擎。** 这与 `b4154d1f` 犯的错正好相反(那次是删了驱动却留了运行)。

**已核实不可行的证明方式:** `agent-process-entry.ts:5200` 在 import 期 `void main()`,**live 路径根本无法在进程内被驱动**。所以 `entered === 1` 只能是源码形状断言,不是行为断言 —— 这一点必须写进交付报告,不得冒充行为证明。

### 0.12 第六次更正:切换不是"建 run 层",而是"换 executor"(2026-10-05,只读核实)

**b4d 报告称 GUI 路径没有 run 层、切换要在 5291 行入口里建一整层。只读核实推翻了这条声明。**

| b4d 的声明 | 核实结论 |
| --- | --- |
| 只有 `headless-run-host.ts` 构造 `RunController` | **错 —— 生产有两处**:`apps/desktop/src/main/agents/server/run-orchestrator.ts:246` 与 `headless-run-host.ts:443`(已实测) |
| `agent-process-entry.ts` 不构造 run 层 | **对,但仅限 worker 子进程**;该文件对三个符号的**全部命中只有一处注释**(`:2999`) |
| 切换 = 在入口建 run 层 | **错** —— run 层已存在于 agent-server 进程且**已在生产接线**(`index.ts:328` 组装、`router.ts:743` 逐帧 observe) |
| `live-turn-single-driver.test.ts:94` 钉着 `engineDrivers === 0` | **部分对** —— `:94` 钉的是 `new RunEngineImpl(` 模式为 0;`engineDrivers` 变量在 `:130`/`:134`;"b5's to close" 注释在 `:294-297` |
| `G8 = 1` 就是那处 `agent.streamChat(` | **部分对** —— owner 正确(`agent-process-entry.ts:3047`),但 **G8 的单位是 package 不是调用**,且 `isTurnLoopModule` 是三形状合取,**该调用是必要非充分条件** |

#### 剩余工作的正确定义(源码自己写着)

`agent-process-entry.ts:3043-3046` **逐字**说明了剩下的是什么:

> "That change is a REFACTOR of `DuyaAgent.streamChat` -- its body has to become port calls, because `packages/agent-runtime` may not import `packages/agent` -- and it is the whole of the remaining cutover."

**所以切换 = 把 `DuyaAgent.streamChat` 的循环体重塑为端口调用,而不是建 run 层。** run 层已经存在(一个进程之外)、可原样复用、所有接缝已注入 —— 换的只是 **executor**。

这与我 §0.4/§0.5 的判断一致:**循环体必须转成端口调用,因为 G1 禁止 runtime import agent。** b4d 把它误读成"在入口建一整层"。

#### 三处 run 层组装的归属(实测)

| 组装 | 位置 | 谁在用 |
| --- | --- | --- |
| `RunOrchestrator` | `apps/desktop/.../run-orchestrator.ts:246` | **Desktop GUI,已在生产**(`index.ts:328` + `router.ts:743`) |
| `HeadlessRunHost` | `packages/agent/src/process/headless-run-host.ts:443` | CLI(`cli/index.ts:479,612,824`) |
| evals | `evals/agent/matrix/rows.ts:1064` | **无 run 层** —— 注释自陈"NOT claimed here" |

**对照计划 600 "同一个执行引擎服务 Desktop worker、CLI 与 eval":CLI 已迁移,Desktop GUI 已有一个,eval 完全没有。**

#### 帧生产者的真实缺口(比 22 小得多)

projector 38 臂中引擎产 16(实测复现,engine 目录级定义)。**但 22 个"无引擎生产者"的臂里,多数已由 `translate/chat-event-translator.ts` 生产(反向:legacy 帧 → 协议事件),覆盖了其中 14 个。全 `packages/agent-runtime/src` 内真正无任何生产者的只有 8 个**:`run.paused`、`turn.completed`、`permission.resolved`、`permission.expired`、`checkpoint.saved`、`diagnostic`、`diagnostic.trace`、`extension.custom`。

**另有一条容易误读的事实:** 三个引擎产出的类型(`assistant.message_finalized`、`tool.timed_out`、`turn.started`)投影为 `null` —— **"引擎产出"不等于"到达 UI"。**

**未决设计问题(本次无法从源码判定):** 那 14 个由 translator 覆盖的臂,是**应当**迁到引擎,还是 translator 本就作为 legacy 入口长期存在?**它决定真实缺口是 14 还是 8。**
