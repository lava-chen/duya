# Gap register — `@duya/agent-protocol`

协议里所有**曾经未决**的架构问题。每一条现在只能是两种状态之一：

| 状态 | 含义 |
|---|---|
| **UNRESOLVED** | 没人裁决。**任何测试都不得固定它的答案。** |
| **DECIDED** | 已裁决，并写明**代价**与**强制它的那个测试**。 |

## 唯一规则

> **未 DECIDED 的问题不能被测试偷偷固定。**

这条规则是本文件存在的理由。它不是形式主义——本轮开始时它已经被违反了两次:

- `worker-event-coverage.test.ts` 断言 `tool.call_started = durable`,而 G-6 说未决;
- 同一文件把 worker 的 `error` 映射成 `isError`,等于把「缺失 = 成功」焊死,
  而 G-7 说未决。

两条断言都是**绿的**。任何检查「这个问题定了吗」的人——包括三个月后的
维护者——看到绿灯就会停止查找。**回答开放问题的测试比没有测试更糟**,
因为它和检查既定问题的测试长得一模一样。

现在两条都已裁决,并被移进 `lifecycle-invariants.test.ts`——
那里才是决策的语义所在。

### 状态词是强制的

每条 DECIDED 必须能回答三个问题:

1. **裁决是什么**——一句话,不含糊
2. **代价是什么**——具体到字段/文件/迁移成本,不是「有一些工作量」
3. **哪个测试强制它**——文件名必须真实存在(`14-producer-inventory-drift.test.ts`
   里有一条断言专门检查这一点)

**不许出现「GAPS 说未决、测试已经固定某个答案」的状态。** 如果你发现某条
UNRESOLVED 有测试在断言它的答案,那是 bug,不是覆盖。

---

## G-1 · 错误分类的边界

**状态** DECIDED · **裁决** 2026-10-01

### 决策

**不**把 `ErrorCode` 扩成整个仓库所有错误串的注册表。`ErrorCode` 是
**protocol/run 边界**的闭合分类;producer 自己的 code 原样进
`ProtocolErrorInfo.cause.code`,保留、不翻译、**永不被分支判断**。

```
ProtocolErrorInfo {
  code: ErrorCode            ← 边界类别,闭合集,host 可以据此分支
  cause?: { system, code }   ← producer 原始串,自由字符串,仅供诊断
}
```

理由:本仓至少 30 个自由 code(`connector_auth_required` / `http_503` /
`slack_error` / `cron_not_found` / ...)。收进闭合集意味着每加一个 connector
的错误就要扩一次,而 host 必须升级才能读懂某次失败为什么发生。分类和
**收据**分开,边界才守得住。

**代价**

- `ErrorCause` 新类型(约 20 行)
- 映射表 `PRODUCER_CODE_CATEGORY` 覆盖不到全部真实 code,未覆盖的落到
  `internal` + 保留原串。**这个映射是有损的,而且诚实地有损**:host 能知道
  「provider 认证失败」,但不知道是哪个 connector 的凭证过期了(除非去读
  cause,而它被明令禁止分支)
- drift test 从「每个 code 都要进闭合集」改成「每个分类结果都必须在闭合集内」

**强制它的测试**
- `worker-adapter-conformance.test.ts` › `error classification (G-1)`
- `lifecycle-invariants.test.ts` › `a real failure is a tool_error carrying a closed code plus its cause`

> 实施中真抓到一个:`PRODUCER_CODE_CATEGORY` 里我写了
> `'provider_error' as ErrorCode`,而 `provider_error` **不在 `ERROR_CODES` 里**。
> 那个 `as` 恰好静音了唯一能抓到它的检查。现在表上有一条编译期断言
> (`_everyCategoryCodeIsReal`)取代它。

---

## G-2 · permission 的分类与时钟归谁

**状态** DECIDED · **裁决** 2026-10-01

### 决策

1. **时钟由 Runtime 的 permission coordinator 拥有。** `expiresAt = startedAt +
   manifest.permissionPolicy.defaultTimeoutMs`,一个数字、一处铸造、一处执行。
   没有 coordinator 的 runtime 广播
   `run.permissionExpiryClock: 'absent'`,并且**不发出** `permission.requested`
   ——而不是编一个 `expiresAt`。
2. **adapter 不得从 `toolName` 猜 `kind` / `mode`。** 这两个字段是 producer
   fact。推导出的 kind 是一串猜测,写进 durable 审计链之后**读起来和事实
   一模一样**。`Read` 既是 `read_path`,对某些参数又是 `connector`——没有
   合法推导。
3. `PermissionPolicyMode` / `PermissionRequestMode` / `PermissionResponse` /
   `PermissionResolution` 四个命名保持现状;`PermissionDecision` 继续**故意
   不导出**(留给 policy engine 的评估结果)。

**代价**

- `RuntimeCapabilities.run.permissionExpiryClock` 新字段
- `RuntimeCapability` 闭合集新增 `permission_coordinator`
- `assertCapabilityConsistency` 强制两者一致
- `PermissionRequest` 新增 `startedAt`(此前 `expiresAt` 的文档引用了一个
  **类型里根本不存在的字段**,而 `PermissionResolution.latencyMs` 没有它就
  无法被 host 验算)
- adapter 对 `chat:permission` 返回 `unmapped`。**这是行为变更**:当前代码
  会发出 `permission_request`,迁移后不会。runtime coordinator 落地前
  permission 流程是断的——这是有意的,好过发一个假的

**强制它的测试**
- `worker-adapter-conformance.test.ts` › `G-2 · permission is NOT adapted`
- `compatibility-gating.test.ts`(经 `permission_expiry` 能力门禁)
- `14-producer-inventory-drift.test.ts` › `AgentPermissionEvent` 记录为 DECIDED

---

## G-3 · checkpoint 事件

**状态** DECIDED · **裁决** 2026-10-01

### 决策

新增 `checkpoint.saved`,payload 是 `{ checkpointRef, generation, eventSeq }`:

- **绝不放完整 `messages`。** worker 的 `checkpoint` 事件带的是
  `{ messages, generation }`——那是 transcript 本身,无界,而且正是让
  checkpoint 载荷变成凭据和体积风险的那种形状。`checkpointRef` 由 Control
  Plane 解析。
- `eventSeq` 是取检查点时那条事件的 envelope `seq`,让 host 不必比时间戳就能
  判断边界在自己已重放内容的前还是后。
- **durable checkpoint 仓库落地前,`RuntimeCapabilities` 必须广播
  `checkpointGeneration: false`。** 由 `assertCapabilityConsistency` 强制。

**代价**

- 新事件 + 新 payload
- 事件挂在 `run` 类别(它是 run 的边界,不是独立子系统)
- 门禁 `requiresCapability: 'checkpoint_resume'`,所以**没有该能力的 host
  收不到 checkpoint 引用**,而不是收到后用不了
- legacy `checkpoint` 映射为**空**并登记进 `NEW_PROTOCOL_EVENTS`

**强制它的测试**
- `lifecycle-invariants.test.ts` › `G-3 · a checkpoint boundary refers to something the run emitted`
- `compatibility-gating.test.ts` › `refuses a host missing the required capability`

---

## G-4 · 四个产品事件不进 agent-protocol

**状态** DECIDED · **裁决** 2026-10-01

### 决策

**不把所有 Duya 产品事件塞进 agent-protocol。** 逐条定归属:

| worker 事件 | 归属 | 理由 |
|---|---|---|
| `chat:title_generated` | **host/view concern** | 会话标题是 UI 关注点,agent run 不生产它 |
| `chat:research_updated` | **Research domain projection** | research 是一个有真实进度的 mode;router 已经把它拆成 3 个 SSE 事件,再塞进 run 事件流是第二次投影 |
| `chat:workflow_run` | **Control Plane / Workflow domain** | workflow run 有自己的协议(`workflow-runtime-manager.ts` 854 行) |
| `chat:db_persisted`(成功) | **不是 agent 事件** | 成功不需要通知 |
| `chat:db_persisted`(失败) | `run.failed` 的 `persistence_failed` | 写库失败影响 run 正确性,不是日志行 |

**代价**

- 这四个事件在 adapter 里返回 `unmapped`,由
  `worker-adapter-conformance.test.ts` 显式断言——**是决策,不是遗漏**
- research 域需要自己的投影层,那是另一个包的事
- G-4 原记录说 research「无 protocol 对应物」;实际更严重——router 已经拆成
  3 个事件。本条按后者记录

**强制它的测试**
- `14-producer-inventory-drift.test.ts` › `UNMAPPED` 四条 DECIDED 记录
- `worker-adapter-conformance.test.ts` › `the G-4 domain events are unmapped by decision, not by omission`

---

## G-5 · `chat:done` 没有字段

**状态** DECIDED · **裁决** 2026-10-01

### 决策

legacy completion adapter **可以是 stateful aggregator**,但只能从
**实际观察到的**来源合成 `run.completed`:

- `cancel state` — runtime 的终态 CAS
- `usage` / `stop reason` — 实际产生它们的链(`DuyaAgent.ts:3154` 经 hook)

**不得填造无来源字段。** 拿不到 `usage` 就没有 `usage`——不是 `usage: {}`。

**代价**

- adapter 必须是有状态的,不是纯函数。这意味着 conformance 测试要用一个
  跨事件的 ledger,不能一条消息一条断言——已如此
- `chat:done` 当前完全无字段,所以 adapter 只能填 `{ status: 'completed' }`。
  **`stopReason` / `usage` 目前不填**——填了就是编造。那部分单列为 G-5b

**强制它的测试**
- `worker-adapter-conformance.test.ts` › `chat:done becomes run.completed`
- `lifecycle-invariants.test.ts` › `a cancelled run terminates as completed, not failed`

> **未完全兑现的部分单列在下面 `G-5b`,状态 UNRESOLVED。**

---

## G-5b · `run.completed` 的 `stopReason` 目前是默认值

**状态** ⚠️ **UNRESOLVED** · **无测试固定它的答案**

### 问题

G-5 裁决了「只从观察到的来源合成」,但 `chat:done` 在代码里不带任何字段。
`stopReason` 真实存在于 `DuyaAgent.ts:3154` 的 `turnStopReason`,**但它不走
`chat:done`**。所以 adapter 现在的 `end_turn` 是**默认值,不是观察结果**——
这正是 G-5 禁止的那类填充。

`RunCompletedPayload` 的 `usage` 同理,来源未确认。

### 为什么标记 UNRESOLVED 而不是顺手修

改它需要决定**哪条链把 stop reason 汇到 run 终态**:worker 事件加字段,还是
adapter 从 turn.completed 事件里累计。两条路代价不同,且都会动
`worker-protocol.ts`——那是 PP-2 的范围,不是类型能解决的。

### 关闭条件

1. 决定 stop reason / usage 的汇入路径(worker 事件扩字段,还是 adapter 累计)
2. 实现后 `worker-adapter-conformance.test.ts` 的 `chat:done` 断言改为断言
   **观察到的值**,并加一条反例:来源缺失时字段必须缺席
3. **在此之前,不得有任何测试断言 `chat:done` 产出的具体 `stopReason` 值。**
   本条建立时 conformance 测试正 pin 着 `end_turn`——那正是自己违反的规则,
   已在同一次改动里改成只断言可观察部分(`type` / `status`)

---

## G-6 · 一个 durable 事件发两次

**状态** DECIDED · **裁决** 2026-10-01

### 决策

**不加 `revision` 字段。** 按真实 producer 语义拆开:

| worker 事件 | protocol 事件 | durability | 语义 |
|---|---|---|---|
| `chat:tool_use_started` | `tool.call_preview` | **volatile** | 参数仍在流式生成,临时播报 |
| `chat:tool_use_delta` | `tool.arguments_delta` | ephemeral | 参数增量 |
| `chat:tool_use` | `tool.call_started` | **durable** | 权威意图,**executor dispatch 前恰好一次** |
| `chat:tool_result` | `tool.call_completed` | durable | 终态 |

durable start 表达**副作用意图**:崩溃在工具执行中途时,留下一条
`tool.call_started` 而没有 `tool.call_completed`,这个不对称就是 side-effect
账本要对账的证据。preview 不进 durable log,因为它描述的调用可能根本不会按
那样发生。

**代价**

- 新事件 `tool.call_preview`(事件总数 36 → 38)
- `ToolCallPreviewPayload` 新类型,带 `provisional: true` 字面量
- legacy 映射表改一行,并加一条断言:**恰好一个** legacy 事件映射到 durable start
- `TOOL_LIFECYCLE_EVENTS` **刻意不含** preview——落在 preview 和 start 之间的
  恢复是**干净边界**(工具没跑过),含进去会拒绝大量合法恢复
- `RunLedger` 拒绝同 id 第二次 `tool.call_started`,以及 start 之后的 preview

**强制它的测试**
- `lifecycle-invariants.test.ts` › `G-6 · the durable tool start happens exactly once`
- `09-sse-legacy-bridge.test.ts` › `exactly one legacy event maps to the durable tool start`
- `14-producer-inventory-drift.test.ts` › `the two tool announcements map to DIFFERENT payloads`

---

## G-7 · 失败位有三个名字

**状态** DECIDED · **裁决** 2026-10-01（与 G-1 同一决策的两面）

### 决策

`tool.call_completed.outcome` 改成**明确 outcome 的 discriminated union**:

```ts
type ToolCallOutcome =
  | { outcome: 'success' }
  | { outcome: 'tool_error'; error: ProtocolErrorInfo }
  | { outcome: 'timeout'; afterMs: number }
  | { outcome: 'cancelled'; reason: string }
  | { outcome: 'indeterminate'; note: string }   ← 关键
```

**legacy 缺失 failure bit 时,必须产出 `indeterminate`,不得默认为 success。**

把字段改成**必填 boolean 并不解决问题**——只是把谎换了个位置:adapter 仍然
得为每个 producer 没标 bit 的调用编一个 `false`,而编出来的 success 和真
的 success 无法区分。union 让「不知道」成为一个必须**按名字选**的分支。

`ToolResult` 内容块(不是事件 payload)同步改——否则同一个歧义留在
transcript 里。

**代价**

- `isError: boolean` 从两个类型上删除
- `indeterminate` 是新分支,host 必须处理。**它意味着「UI 上要显示未知,
  而不是显示成功」**——这是产品侧要接受的行为变化
- `errorClass?: string` 一并删除(它的来源同样没有生产者证据)

**强制它的测试**
- `worker-adapter-conformance.test.ts` › `an ABSENT status becomes indeterminate, never success`
- `lifecycle-invariants.test.ts` › `G-7 · an absent producer status is indeterminate`

---

## G-8 · id 空间与计数器

**状态** DECIDED · **裁决** 2026-10-01

### 决策

`RunEventEnvelope.seq` = **per-run, runtime-minted**。唯一性作用域是
**`(runId, seq)`**,**不是 `(sessionId, seq)`**。

- session 比 run 活得久;resumed run 是**新 runId**,`seq` 从 1 重来
- 所以同一 session 里两个 run 会有相同 `seq` 值,**那不是冲突**
- **replay ring / durable event repository 归 Run**,以 `(runId, seq)` 为键
- 跨 run 的 session 流是合法产品需求(转录视图跨 resumed run),但它需要
  **自己的 stream cursor**,**不得复用 Run seq**。session 级 cursor 是
  另一个数、另一个生命周期;从 per-run seq 推导可以,但推导必须显式,
  因为「我在 session 哪里」和「我在这 run 哪里」两种 resume 请求的拒绝
  原因不同

**代价**

- 现有实现方向相反,必须改:计数器 per-turn(`router.ts:1329` 每次 POST 归零)
  而 `session.lastEventId` 和 ring 是 per-session 且从不重置
  (`:1569-1570`)。**第二轮会重铸第一轮的 id**,
  `getEventsSince` 的 `eventId > lastEventId` 过滤随之失效(`:2411`)
- 把两个作用域合成一个 session 级计数器是**不可就地修复**的:没有办法说明
  一个 id 属于哪个 run。必须把计数器移进 ring
- `SEQ_CONTRACT.uniqueWithin: 'run'` 成为类型上的断言
- 新增 `eventKey(runId, seq)` 作为规范键

**强制它的测试**
- `lifecycle-invariants.test.ts` › `G-8 · seq is per-run, gapless, and unique within (runId, seq)`
- `20-framing-malformed.test.ts` › seq 的负数/非整数/零拒绝

---

## G-9 · `since` 是装饰性的

**状态** DECIDED · **裁决** 2026-10-01

### 决策

在消费者迁移前设计**可执行的 compatibility model**:

1. **独立 `schemaRevision`**,与 `PROTOCOL_MAJOR.MINOR` 正交。载荷形状变化
   bump schema revision,**不动 protocol version**;只有 wire 契约不兼容才动
2. **Host 和 Runtime 都声明 capabilities。** `RuntimeCapabilities` 说 runtime
   能做什么;`HostDeclaration` 说 host 能**消费**什么。**两个方向都要**:
   runtime 给不能渲染 preview 的 host 推 preview = 坏 UI;host 对没有
   checkpoint 仓库的 runtime 要 checkpoint resume = 没人兑现的承诺
3. **`EventMeta` 内嵌 `MessageGate`**,含 `minProtocol` / `minSchemaRevision` /
   `requiresCapability`。**装饰性 `since` 删除。** 内嵌而非可选字段是为了让
   「声明事件却不声明门禁」在类型上不可能
4. **控制面方法走同一张门禁表。** 一个 host 无法实现的控制方法,比不送达
   更糟——它变成 host 会兑现的承诺
5. **拒绝是合法结果。** runtime 可以**要求** host 具备某能力;不满足就
   **拒绝连接**,不降级。参考集里 20 个 harness 只有 1 个 (prime-agent)
   建模了这条路径
6. **真正调用门禁的行为测试**,不是断言门禁存在

**代价**

- 新模块 `compatibility.ts`(`admitMessage` / `negotiate` / `defineGateTable`)
- `Since` 类型删除;`EventMeta` 从 4 字段变 7 字段,38 个事件全部重写
  (用 `G1_0` 共享常量收敛)
- `CONTROL_GATE` 新表 + `MESSAGE_GATES` 合并视图
- `ProtocolCapability` 闭合集 6 项,**每一项都由某个消息或控制方法 require**
  ——有消费者无声明是死字段,有声明无消费者是对 host 的假承诺
- 快照格式变化(加了 3 个门禁字段)

**强制它的测试**
- `compatibility-gating.test.ts`(18 断言,全部**调用**门禁函数读裁决)
- `05-event-type-snapshot.test.ts` › `every event declares a well-formed gate, and it is a real one`

> 实施中真抓到两个:门禁原本复用 `isCompatible`,而它**只比 MAJOR**,
> 于是 `minProtocol: '1.3'` 对 `1.0` 的 host **静默放行**——正是这整个模块
> 要防的 fail-open。已改为完整版本比较,并有专门断言。

---

## 维护规则

- **新发现一条就加一条**,不要塞进模块注释
- 每条只能写 `UNRESOLVED` 或 `DECIDED`;DECIDED 必须带 **cost** 和
  **enforcing test 文件名**
- 文件名必须真实存在——`14-producer-inventory-drift.test.ts` 里有一条断言
  专门检查 `classified` 字段引用的测试文件存在。没有这条,「决定在别处」
  会变成任何人不愿决定之事的默认回答
- **UNRESOLVED 条目旁边不许有测试断言它的答案。** 发现即是 bug
- 关闭时在条目末尾加 `关闭于:<commit>`
