# T3 — 协议、适配器、replay 与背压

前置：R2；从移动纯类型开始，不同时修改消费者行为。Next：T3.1。唯一合同见00，旧PP/M编号见接管表。

## T3.1 Wire 数据的单一来源

- [ ] 盘点ai/types、agent/types、workercommand、SSE、DesktopDTO与真实consumer；逐字段分类JSONwire、内部async、storageview、UIview。
- [ ] 迁Message/Content、TokenUsage、UsageCall、StopReason、公共permission/progress等纯数据到protocol；ToolResult中Promise/pendingcontext/callback保留runtime内部类型，用显式serializer生成wire。
- [ ] ai与agent旧入口re-export，声明deprecated、兼容窗口和删出口任务；packageexports/tsconfig/buildresolver同时验证。
- [ ] 映射所有旧事件字段，包含research/workflow扩展、工具start/completion、mode/Goal历史；不能为了union更小静默丢字段。
- [ ] 迁移纯数据的PR与行为改动PR分开，至少完成可验证的兼容发布窗口再删shim。不能只依赖“类型检查过了”。

目标文件：`packages/agent-protocol/src`、`packages/ai/src/types.ts`、agenttypes/message来源、Desktopcontracts。生产schema/codec保持无IO，引用命名按现有入口，不建立第二份SSE事实源。

## T3.2 EventSink 与结构验证

- [ ] runtime统一emit入口处理nativeenvelope和legacyframe，均经过runId/seq/lifecycle/持久化，sink不能绕ledger。
- [ ] registry是eventtype/durability/since来源；dispatch完整switch及schema对每个消息验证。
- [ ] peerunsupportedrequired/control事件拒绝；合法unknownextension返回typedextension/diagnostic且保持安全终态，不把未知关键事件当自然完成。
- [ ] 生成控制面census：start/cancel、permission、mailbox、status/probe、resume、workflow相关；每项生产者/handler/consumer和schema对应。
- [ ] translator与projector是adapter，不可作为修改真实legacySSE字段的依据。保持losslesslivecompatibility；projection用于明确的replay窗口。

## T3.3 Seq、cursor 与恢复窗口

- [ ] runtime每run铸seq，transport不重编号；durable稀疏seq写SQL；相同事件重放保留eventidentity。
- [ ] HTTPcursor携run/epoch，拒绝跨runcursor。报告oldest/latest/window以及snapshot来源，Last-Event-ID超窗返回replay_unavailable或snapshotresync。
- [ ] replayGET不触发executor、不再observe；新订阅live/replayhandoff无重复和缺口，消费者按identity幂等。
- [ ] 文本/thinking丢delta后读message/blocksnapshot+cursor，最终transcript可重建；不能只存durableterminal就声称所有文本可重放。
- [ ] boundedring仅是缓存，SQLite/history是durable来源；eventreplaycapability不等于executionresume。

保留单一seq，不启动ephemeral独立编号的第二轮契约改造；只有测量证明需要，才新增独立ADR/兼容版本。

## T3.4 Coalescing 与背压

- [ ] 增加batcher或复用现有buffer，key至少runId+messageId+blockId+eventtype；text/thinking分开。时间窗、bytes双阈值，测试用virtualclock。
- [ ] 按因果barrier flush早先delta再发toolstart/terminal；不能把所有durable抢到delta前面。聚合必须发生在最终seq分配/公共发布的明确位置，禁止合并后更换已持久事件ID。
- [ ] bytes有界。可丢/合并ephemeral且报告gap/metrics；durable保留并暂停producer或断开慢consumer让其replay，不删除最旧terminal。
- [ ] 如果stdout无法按type暂停，不能宣称仅暂停ephemeral；分离队列/controlchannel并测cancel/审批仍可送达。
- [ ] single-reader或fanout明确：多handleconsumer不得互抢同queue。host需要UI与persist两个reader时明确tee/broker责任。

压测用固定delta速率/大小/slowconsumer，记录frames、bytes、p95latency、queuehighwater、terminaldelay、RSS。高频syntheticcase目标frames减少≥90%，真实provider报告测量值；原始速率很低时不强求90%。所有场景durableloss=0，内容一致，cancel/approval控制不饿死。

## T3.5 三种 transport 与 capability

- [ ] subprocess：单行JSONframing、chunk边界、stdout断开、privateconfig独立；无多行拼凑hack后验证真实worker输出。
- [ ] HTTP+SSE：auth/origin、boundedSSE、cursor、disconnectpolicy；cloud能力不开启时不顺带部署公网host。
- [ ] in-process：同RunAPI/port，不用第二套fake状态机；为CLI/evals复用。
- [ ] probe准确枚举cancel、permission、eventreplay、executionresume、determinism、expiryclock和limits；since声明实际参与协商。
- [ ] error taxonomy区分protocolinvalid、policydenied、model/toolerror、runtimecrash、persistfailure/replayunavailable；调用端有相应retry策略。

## PR 切片与验收

T3-A纯数据+兼容exports；T3-BEventSink/census/schema；T3-Cseq/cursor/replay；T3-Dbatching/backpressure；T3-E三adapter一致性/permissionvocabulary收尾。

验收：相同offlineexecution经三adapter得到相同规范化语义序列/结果，transport本地diagnostic可单独比较；乱包、未知类型、chunking、重复cursor、500+事件、10分钟slowconsumer、内容block交错。已有protocoltest逐项核对，13-citation-drift的历史失败需归因或修复，不能写全绿。

检查typecheckall/architecture/protocoldrift、runtime/router测试、electronbuild及真实reconnect。回退保留legacyadapter读取已写seq；不要重编号旧库事件。出口：无重复事实源、native和legacy均走同生命周期、慢consumer与重连通过。
