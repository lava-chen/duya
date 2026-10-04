# T3 — 协议、适配器、replay 与背压

前置：R2；从移动纯类型开始，不同时修改消费者行为。Next：**无——T3 已完成**（T3.1–T3.5 全部合并）。唯一合同见00，旧PP/M编号见接管表。
>
> **阶段状态（2026-10-04 对 `55384c55` 核对）**：T3.1 #156、T3.2 #157、T3.3 #158、T3.4 #159、T3.5 #161 全部合并，**Done**。T3.2–T3.5 的子项由交付 PR 逐条标为 done。**唯一留开的两条都在 T3.1**，且都不是"没做"，而是"对 `private: true` 包不可能做"——见 T3.1 第3/5 条。

## T3.1 Wire 数据的单一来源

> 已合并，PR #156（`62eacb35`）。**类型迁移，行为不变。** 逐字段分类本身是代码（`packages/agent-protocol/src/transcript/classification.ts`），16 个 shape 逐字段分类；`Classified<Shape>` 是对各 shape **自身键**的映射类型，**缺失或陈旧的分类在两个方向上都是编译错误**。

- [x] 盘点ai/types、agent/types、workercommand、SSE、DesktopDTO与真实consumer；逐字段分类JSONwire、内部async、storageview、UIview。
  `FieldClass` = `json-wire | internal-async | storage-view | ui-view`，另有 `CLASS_RATIONALE` 与 `DECLARED_FIELD_DIVERGENCES`。按 surface：`Message` 31、`AssistantMessage` 11、content blocks 5/2/8/4/5/4、`TokenUsage` 8、`UsageCall` 9、`StopReason` 9 成员、`ToolUse` 6、`ToolResultWire` 9、`DeferredToolExtras` 2、`PermissionRequestEvent` 7、`AgentProgressEvent` 12、`HookEventPayload` 15。
- [x] 迁Message/Content、TokenUsage、UsageCall、StopReason、公共permission/progress等纯数据到protocol；ToolResult中Promise/pendingcontext/callback保留runtime内部类型，用显式serializer生成wire。
  迁到 `@duya/agent-protocol/transcript`。两个 `Promise` 字段**留在 runtime 内部**，用逐字段的 `toToolResultWire(runtime): ToolResultWire` 生成 wire，另有 `hasDeferredRuntimeState` 与 `serializeToolResult`。#156 **刻意不合并**已有的两套 `TokenUsage`/`StopReason`/`MessageContent`（protocol 侧 6/4 成员 vs 本包 9/6，且 `ImageContent`、`ProviderBlockContent` 只存在于 `ai`）——合并正是本条禁止的字段丢失。
- [ ] ai与agent旧入口re-export，声明deprecated、兼容窗口和删出口任务；packageexports/tsconfig/buildresolver同时验证。
  **#156 明确"拒绝声称有兼容窗口"**：两个包都是 `private: true`，**不存在消费者能被 pin 的发布产物**，因此"可验证的兼容发布窗口"在本仓库对这两个包**不成立**。#156 实际给出的是替代退出条件——旧入口的删除取决于**消费者归零**，不是"过了一个发布"。旧入口 re-export 与 exports/tsconfig/build 验证已随迁移完成。
- [x] 映射所有旧事件字段，包含research/workflow扩展、工具start/completion、mode/Goal历史；不能为了union更小静默丢字段。
  由上面的 `DECLARED_FIELD_DIVERGENCES` 与封闭键集保证：未归因的字段是编译错误。#156 逐条列出它**没有**合并的差异，而不是悄悄取并集。
- [ ] 迁移纯数据的PR与行为改动PR分开，至少完成可验证的兼容发布窗口再删shim。不能只依赖"类型检查过了"。
  前半（PR 与行为分开）成立：#156 是纯类型迁移。**后半对 `private: true` 包不可满足**，因此本条的退出条件被改写为消费者归零 + 打包/host smoke（与 H8.3 一致）。不得声称已过一个兼容发布窗口。

## T3.2 EventSink 与结构验证

> 已合并，PR #157（`3b121ba2`）。5 项全部 done。

- [x] runtime统一emit入口处理nativeenvelope和legacyframe，均经过runId/seq/lifecycle/持久化，sink不能绕ledger。
  `agent-runtime/src/events/event-emitter.ts:112` + `controller.ts:576,462,772,1079`；`event-sink-ledger.test.ts`（5）、`event-emitter.test.ts`（15）。**绕过是真实存在过的**：`ExecutionSink.envelope` 原本就是 `stream.push(envelope)`——executor 自己的 `seq`，无 ledger、无持久化、无 lifecycle 检查，任何 executor 都能往一个 run 上追加。还原这一臂会让 5 个测试中的 2 个失败。
- [x] registry是eventtype/durability/since来源；dispatch完整switch及schema对每个消息验证。
  `structural-dispatch.ts:160` 的 switch、`:120` 个 kind、schema 即 `REQUIRED_FIELDS`；`structural-dispatch.test.ts`（17）。
- [x] peerunsupportedrequired/control事件拒绝；合法unknownextension返回typedextension/diagnostic且保持安全终态，不把未知关键事件当自然完成。
  `agent-protocol/src/events/criticality.ts:108` + `registry.ts:81`；由 `structural-dispatch`、`event-emitter`、`control-plane-census:136` 共同证明。
- [x] 生成控制面census：start/cancel、permission、mailbox、status/probe、resume、workflow相关；每项生产者/handler/consumer和schema对应。
  `agent-runtime/src/control-plane-census.ts:118`——**21 行**；`control-plane-census.test.ts`（55）。
- [x] translator与projector是adapter，不可作为修改真实legacySSE字段的依据。保持losslesslivecompatibility；projection用于明确的replay窗口。
  census 里 `authority: 'adapter'` 加一条 `since` 规则；`control-plane-census.test.ts:168,176`。

## T3.3 Seq、cursor 与恢复窗口

> 已合并，PR #158（`8582bf25`）。5 项全部 done。

- [x] runtime每run铸seq，transport不重编号；durable稀疏seq写SQL；相同事件重放保留eventidentity。
  `agent-protocol/src/replay.ts:1` + `agent-runtime/src/replay/replay-repository.ts:250`。
- [x] HTTPcursor携run/epoch，拒绝跨runcursor。报告oldest/latest/window以及snapshot来源，Last-Event-ID超窗返回replay_unavailable或snapshotresync。
  `replay.ts:216` + `replay-repository.ts:189`。窗口是**算出来的**不是假设的：`{oldest, latest, mintedLatest, count, sparse}` 由 store 计算，`mintedLatest` 由调用方提供——**只有活的 runtime 知道自己账本走到哪**，而 `mintedLatest - latest` 正是非 durable 尾巴。可服务条件是 `afterSeq + 1 >= oldest && afterSeq <= mintedLatest`。消费者被告知三种 `kind` 之一——`replay`/`snapshot_resync`/`refused`——**永不**被告知"有些事件丢了"。
- [x] replayGET不触发executor、不再observe；新订阅live/replayhandoff无重复和缺口，消费者按identity幂等。
  `replay-subscription.ts:126` + `replay-repository.ts:66`。
- [x] 文本/thinking丢delta后读message/blocksnapshot+cursor，最终transcript可重建；不能只存durableterminal就声称所有文本可重放。
  `transcript-snapshot.ts:186`。
- [x] boundedring仅是缓存，SQLite/history是durable来源；eventreplaycapability不等于executionresume。
  `replay-repository.ts:66`。幂等**只在 store 一处强制**——它是唯一可能看见重复写入的地方；sink 刻意不去重（T3.2 让 emitter 成为铸造权威，sink 去重会与之冲突）。

保留单一seq，不启动ephemeral独立编号的第二轮契约改造；只有测量证明需要，才新增独立ADR/兼容版本。

## T3.4 Coalescing 与背压

> 已合并，PR #159（`6c6fef28`）。6 个子项全部 done。

- [x] 增加batcher或复用现有buffer，key至少runId+messageId+blockId+eventtype；text/thinking分开。时间窗、bytes双阈值，测试用virtualclock。
  `events/coalesce.ts:102,171,387,440`。
- [x] 按因果barrier flush早先delta再发toolstart/terminal；不能把所有durable抢到delta前面。聚合必须发生在最终seq分配/公共发布的明确位置，禁止合并后更换已持久事件ID。
  `events/coalesce.ts:440`。**聚合发生在 seq 分配之前**——§F 只允许 durable store 有空洞、别处没有，所以活的流必须稠密；铸完 seq 再聚合只有两种坏结果：改写 ledger 已经发出去的 seq，或留下烧掉的编号（而烧掉的编号是消费者读成"丢事件"并尝试 replay 的洞）。被合并的 delta 根本不获得 seq。`DeltaBatcher` 是生产者侧过滤器，`RunEventEmitter` 未被触碰且仍是 `session.observe` 的唯一调用者；对真实 ledger 实测 2000 个 delta → seq `1,2,3,4`，无空洞、无重编号。
- [x] bytes有界。可丢/合并ephemeral且报告gap/metrics；durable保留并暂停producer或断开慢consumer让其replay，不删除最旧terminal。
  `events/backpressure.ts:252,359,424,109`。**取舍真的翻转**：在 ephemeral 帧上暂停会让一个模型调用因为一个消费者不读而停住，连带同一 run 的每个消费者都停；对 durable 帧则相反——带洞的 transcript **不可**由 replay 恢复，因为丢掉的正是 replay 会送达的东西。所以 durable 即使超界也被接纳，队列报 `paused`。
- [x] 如果stdout无法按type暂停，不能宣称仅暂停ephemeral；分离队列/controlchannel并测cancel/审批仍可送达。
  `events/control-channel.ts:93,166,194`。
- [x] single-reader或fanout明确：多handleconsumer不得互抢同queue。host需要UI与persist两个reader时明确tee/broker责任。
  `events/backpressure.ts:447` + `events/stream-fanout.ts:68,121`。
- [x] （编译期守卫）`events/coalesce-guards.ts:162`。

压测用固定delta速率/大小/slowconsumer，记录frames、bytes、p95latency、queuehighwater、terminaldelay、RSS。高频syntheticcase目标frames减少≥90%，真实provider报告测量值；原始速率很低时不强求90%。所有场景durableloss=0，内容一致，cancel/approval控制不饿死。**#159 未报告这组压测数字**——上表是结构性交付，吞吐指标未测，不得当作已达标。

## T3.5 三种 transport 与 capability

> 已合并，PR #161（`725a829e`）。5 项全部 done。

- [x] subprocess：单行JSONframing、chunk边界、stdout断开、privateconfig独立；无多行拼凑hack后验证真实worker输出。
  `transport/line-codec.ts:95` + `transport/subprocess-transport.ts:170,141,271`。**对真实 worker 证明**：`packages/agent/tests/process/fixtures/real-worker.mjs` import 仓库自己的 `sendEvent` 并作为真实 `node` 进程被 spawn，`fragment: 1` 让它**一次写一个字节**（常规 coalescing pipe 不会产生的切分）。private config 被断言**在 stdout 字节里缺席**，不只是解码后缺席；截断的尾部被拒为 `framesRefused: 1`，不凭空造帧。
- [x] HTTP+SSE：auth/origin、boundedSSE、cursor、disconnectpolicy；cloud能力不开启时不顺带部署公网host。
  `http-sse-transport.ts:213,404,314,170`。
- [x] in-process：同RunAPI/port，不用第二套fake状态机；为CLI/evals复用。
  `in-process-transport.ts:108`。
- [x] probe准确枚举cancel、permission、eventreplay、executionresume、determinism、expiryclock和limits；since声明实际参与协商。
  `capability-probe.ts:305,172`。
- [x] error taxonomy区分protocolinvalid、policydenied、model/toolerror、runtimecrash、persistfailure/replayunavailable；调用端有相应retry策略。
  `error-taxonomy.ts:29`。
- **决定性测试**：`transport-equivalence.test.ts:215` 通过——in-process vs subprocess vs http-sse 产出**相同事件与相同 result**，每个 `seq` 稠密 `1..N`；归一化只排除 wall-clock 与 `TransportDiagnostics`，对象**键序**被规范化但叶子值不被比较掉。

## PR 切片与验收

T3-A纯数据+兼容exports；T3-BEventSink/census/schema；T3-Cseq/cursor/replay；T3-Dbatching/backpressure；T3-E三adapter一致性/permissionvocabulary收尾。

验收：相同offlineexecution经三adapter得到相同规范化语义序列/结果，transport本地diagnostic可单独比较；乱包、未知类型、chunking、重复cursor、500+事件、10分钟slowconsumer、内容block交错。已有protocoltest逐项核对，13-citation-drift的历史失败需归因或修复，不能写全绿。

检查typecheckall/architecture/protocoldrift、runtime/router测试、electronbuild及真实reconnect。回退保留legacyadapter读取已写seq；不要重编号旧库事件。出口：无重复事实源、native和legacy均走同生命周期、慢consumer与重连通过。
