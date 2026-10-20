# @duya/agent-runtime

> 运行执行引擎：run 身份、run 内 `seq`、`RunEvent` 流、终止判定，以及投影回旧的 SSE 词汇。

## 1. 负责 / 不负责

负责：
- `RunController`（`packages/agent-runtime/src/controller.ts:393`）
- `RunSession`（`packages/agent-runtime/src/run-session.ts:250`）、`RunEventStream`（`:1116`）、`RunPersistence` 端口（`:56`）
- `RunEventEmitter`——唯一的 emit 入口（`packages/agent-runtime/src/events/event-emitter.ts:297`）
- 引擎与端口族：`packages/agent-runtime/src/engine/run-engine.ts`、`packages/agent-runtime/src/engine/ports.ts`
- 工具目录 / 注册表（`packages/agent-runtime/src/tools/catalog/registry.ts:247`）、`packages/agent-runtime/src/tools/execution/ToolExecutionPipeline.ts`
- 权限闸门（`packages/agent-runtime/src/authorization/permissions/permissions.ts:283`）、frame→event 翻译（`packages/agent-runtime/src/translate/chat-event-translator.ts`）、旧 SSE 投影（`packages/agent-runtime/src/project/legacy-sse-projector.ts`）

不负责：
- 存储 → `RunPersistence` 由外部注入（`packages/agent-runtime/src/run-session.ts:56`），实现在 `@duya/data`
- manifest 的组装与冻结 → `@duya/host`（`packages/host/src/manifest-factory.ts:171`）
- LLM 客户端 → `@duya/ai` 在此包内被**禁止**导入（`packages/agent-runtime/src/index.ts:477`）；模型端口只有形状
- 终止语义推理 → `@duya/agent-core`（`packages/agent-core/src/run-outcome.ts:101`）
- Electron / 渲染进程 → `apps/desktop`

## 2. 关键文件

| 文件 | 作用 |
| --- | --- |
| `packages/agent-runtime/src/events/event-emitter.ts:297` | 一次 run 的唯一 emit 入口；控制器、翻译路径、执行器共用它（`:290`） |
| `packages/agent-runtime/src/events/event-emitter.ts:37` | **seq 是重铸不是采纳**：外来信封的 seq 被自己的 ledger 重新铸造，分歧记在 `producerSeqDisagreed`（`:502`） |
| `packages/agent-runtime/src/events/event-emitter.ts:563` | 终止事件被"扣住"，直到 durable `run:complete` 落库才放行（`:557`） |
| `packages/agent-runtime/src/run-session.ts:451` | `observe`：唯一把事件交给 ledger 的口；违规抛 `LifecycleViolation`，调用方转成 `run.failed` |
| `packages/agent-runtime/src/authorization/permissions/permissions.ts:283` | 权限判定顺序：MCP 来源闸（`:306`→`decideMcpSource` `:238`）→ canvas 恒放行（`:313`）→ 内部白名单（`:326`）→ deny（`:338`）→ ask（`:351`）→ 风险档（`:370`）→ 灾难性操作（`:436`，任何模式都不可绕过，实现在 `packages/capabilities/src/permissions/policy.ts:1032`） |
| `packages/agent-runtime/src/tools/execution/StreamingToolExecutor.ts:519` | 工具执行超时默认 300000 ms；慢阶段告警 15 s（`:40`） |

## 3. 排障入口

| 症状 | 先看这里 | 为什么 |
| --- | --- | --- |
| 事件顺序错 / seq 跳号 | `packages/agent-runtime/src/events/event-emitter.ts:37` | 生产方自带 seq 会被重铸；ledger 是唯一 seq 权威，违规码在 `packages/agent-protocol/src/run-ledger.ts:43` |
| 终止事件迟迟不到 | `packages/agent-runtime/src/events/event-emitter.ts:563` | 终止被扣住，等 durable `run:complete` 落库 |
| 工具没出现给模型 | `packages/agent-runtime/src/tools/catalog/registry.ts:247` | 注册表 → 可见性过滤在 Host 侧，日志见 `packages/host/src/worker-session-runtime.ts:1506` |
| 权限该问的没问 / 不该问的问了 | `packages/agent-runtime/src/authorization/permissions/permissions.ts:283` | 判定顺序即优先级，顺序即行为 |
| 取消后还在跑 | `packages/agent-runtime/src/controller.ts:983` | 控制器区分"我取消了"和"它已经结束了"（`applied:false`） |
| 上下文压缩不符预期 | `packages/agent-runtime/src/context/compact/CompactionManager.ts` | 三个触发点及其失败语义在 `packages/agent-runtime/src/engine/run-engine.ts:101` |

## 4. 边界约束

- 架构层 `runtime`（`architecture-policy.yaml:118`），模块 `agent-runtime` `managed: true`、`requires: [agent-protocol, client-core, agent-core, capabilities, legacy-plugin-core]`（`:276`）。
- `@duya/ai` 在本包内禁止导入（`packages/agent-runtime/src/index.ts:475`）。`requires` 里**没有** `legacy-ai`——想加这条边会在架构检查里红。
- 同一处注释提到实现在 `packages/agent` 旁边，那是历史适配器路径，不是当前 owner。
