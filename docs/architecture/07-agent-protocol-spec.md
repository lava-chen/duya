# 07 — `@duya/agent-protocol` 接口规格

> 状态：**设计规格，未实现**。本文是 `04-agent-harness-design.md` §3（Run API 草案）和
> `05-architecture-governance.md` §2（边界规则）的完整化。
> 证据基线：`master` @ `7c5bf050`。
> 所有 file:line 引用均可在该 commit 复现。

---

## 0. 先修正三个前提

调查过程中发现三条与初始设想不符的事实，直接改变抽取策略。

### 0.1 那 17 个 deep import 大部分不是 protocol 材料

`grep "from '@duya/agent/message'"` = 18 个 specifier / 17 个文件，导入的是
`MessageEntry`、`AgentMessage`、`CompactionEntry`、`ingestMessage`、
`THREAD_METADATA_KEY`、`ROOM_HISTORY_SOURCES` 等
（如 `electron/db/core/message-log.ts:33`、`electron/db/core/rollout-events.ts:18`）。

**这是 durable message-log / storage 模型，不是 wire contract。**
另有 2 处相对路径穿透到实现内部（`electron/wake/group-turn-dispatcher.ts:35`、
`electron/ipc/group-handlers.ts:29`，都指向 `packages/agent/src/message/message-source`）。

> **裁决**：把 17 个 import 全部改指 `@duya/agent-protocol` 是**范畴错误**。
> protocol 吸收 `Message` / `MessageContent`；log 模型有独立归宿（迁移步骤 M11）。

### 0.2 `SSEEvent` union 今天已经不是事实来源

`normalizeWorkerEvent`（`electron/agents/server/router.ts:450-569`）至少发出 10 种
union 里没有的事件类型：`status`、`permission`（不是 `permission_request`）、
`token_usage`、`checkpoint`、`ready`、`title_generated`、`workflow_run`、
`research_continue`、`research_evidence`、`research_report`。

更糟：union 声明 `{ type: 'text'; data: string }`（`packages/ai/src/types.ts:351`），
router 实际发 `{ data: { content } }`（`router.ts:461-465`），renderer 读
`event.data.content`（`router.ts:444-446`）——**声明的类型今天是假的**。

### 0.3 三套不兼容的 permission 词汇

| 位置 | 动作集合 |
|---|---|
| 回调返回（`packages/agent/src/types.ts:337`） | `'allow' \| 'deny' \| 'paused'` |
| HTTP 接收（`router.ts:1785`） | `allow \| deny \| allow_once \| allow_for_session` |
| worker 接收（`agent-process-entry.ts:4413`） | 同上四种 |

`expiresAt` 存在两个独立时钟：agent 侧 `packages/ai/src/types.ts:303`，
worker 侧硬编码 `300000`（`agent-process-entry.ts:2240`）。

---

## 1. 模块布局

`packages/agent-protocol/` —— ESM，`type: module`，`composite: true`，
**从第一天起** `requires: []`、`managed: true`（依 `05-architecture-governance.md:333-336`）。

```
src/
  index.ts          barrel，唯一公开入口（策略要求，见 05:86）
  version.ts        PROTOCOL_VERSION / isCompatible()
  primitives.ts     JsonValue, Millis, ids, TraceContext
  manifest.ts       RunManifest (Readonly) + manifestFingerprint()
  envelope.ts       RunEventEnvelope, seq 契约, ControlFrame
  events/
    specs.ts        EventSpec[] —— 唯一事实来源
    registry.ts     defineEventUnion()：派生 union 类型 + ALL + 查表
    payloads.ts     每种事件一个 payload interface
  permission.ts     PermissionAction / Request / Decision / Scope / Audit
  run.ts            RunRequest, RunHandle, AgentRuntimeApi, RunResult, RunBudget
  resume.ts         ResumeRequest, ResumeBoundary, ResumeSupport
  capabilities.ts   RuntimeCapabilities, ProbeOptions, assertSatisfies()
  errors.ts         ERROR_CODES, isRetryable(), ProtocolError, WireResult
  transport.ts      EventSink / EventSource / ControlChannel / RuntimeBinding（纯 port）
  codecs.ts         toEnvelope/fromEnvelope, SSE↔envelope, NDJSON↔envelope
  legacy/
    sse-event.ts    已废弃的 SSEEvent 视图 + 映射表（带删除期限）
  testing/
    fixtures.ts     每种事件的最小合法 payload（drift test 输入）
schema/             测试期生成的 JSON Schema（入库）
```

**为什么这样切**：`specs.ts` 与 `registry.ts` 分开，是因为 registry 只应 import payload
**类型**（编译期擦除）——独立成文件让 drift test #1 能断言 registry **没有任何运行时 import**。
`transport.ts` 只放 **port，零 adapter**，adapter 全部落在
`packages/agent-runtime/transport/*`。`legacy/` 是隔离子路径
（`@duya/agent-protocol/legacy`）并带删除期限，让 `SSEEvent` 能在迁移期再导出，
但不会成为主入口的永久 export。`testing/fixtures.ts` 进 `dist`，
好让**其他包**的 drift test 复用同一份 payload 集。

---

## 2. Version / Envelope / Primitives

```ts
// version.ts
export const PROTOCOL_MAJOR = 1;
export const PROTOCOL_MINOR = 0;
export const PROTOCOL_VERSION = `${PROTOCOL_MAJOR}.${PROTOCOL_MINOR}` as const;

// envelope.ts
export interface RunEventEnvelope<T extends RunEvent = RunEvent> {
  runId: string;
  sessionId: string;
  seq: number;          // per-run，从 1 起，严格 +1，由 RUNTIME 铸造
  timestamp: number;    // epoch ms；manifest.deterministic 时为虚拟时钟
  traceId: string;
  spanId?: string;
  parentRunId?: string; // 仅当本次 run 是 resume/fork 时出现
  payload: T;
}

/** Control-plane 帧。不属于事件流、不编号、不持久化。 */
export type ControlFrame =
  | { kind: 'hello'; protocol: {major;minor}; host: {name;version} }
  | { kind: 'ready'; runtime: {name;version;pid?}; capabilities: RuntimeCapabilities }
  | { kind: 'error'; error: ProtocolErrorInfo };
```

### 2.1 `seq` 所有权从 router 移到 runtime

今天的 `seqNum` 是**每连接**计数器（`router.ts:1329`，赋值于 `:1568`），
而 `handleGetChat` 重放事件时**用新计数器重新编号**（`:2479`），
同时写入的 `id:` 却来自 ring 的原始 `eventId`（`:2423`）——
**重放事件的 id 与原始流对不上**。

把 `seq` 铸到 runtime，`id:` 就恒等于 `seq`，`Last-Event-ID` 续传由构造成立。

---

## 3. RunManifest

```ts
export interface RunManifest {
  readonly version: 1;
  readonly runId: string;
  readonly projectId: string | null;
  readonly workspaceId: string;
  readonly goalId?: string;
  readonly taskId?: string;
  readonly roots: readonly string[];   // 绝对路径，已由 Control Plane 校验
  readonly cwd: string;
  readonly permissionPolicy: {
    mode: PermissionModeName;
    hostSwitch: 'ask' | 'always' | 'never';   // permissions/types.ts:63
    defaultTimeoutMs: number;                 // 默认 300_000，对齐 agent-process-entry.ts:2240
    rules?: Readonly<Record<PermissionRuleSource, readonly string[]>>;  // Map 展平为 Record
  };
  readonly capabilities: { profiles; modes; tools };
  readonly connectorBindings: readonly { provider; connectionId; pluginId? }[];
  readonly env: { ref: string; hash: string };  // ★ 无密钥，见 §11
  readonly agent?: { profileId: string | null; model; providerId; effort? };
  readonly checkpoint?: { generation: number; messageCount: number };
  readonly budget: RunBudget;
  readonly deterministic: boolean;
  readonly parentRunId?: string;
  readonly resumeFrom?: ResumeBoundary;
}
export function manifestFingerprint(m: RunManifest): string;  // 规范化 JSON 的 sha256
```

### 3.1 现有代码支撑不了的字段（明说）

- **`permissionPolicy.rules` 不能是 `ToolPermissionRulesBySource`** ——
  它含 `ReadonlyMap`（`permissions/types.ts:427-434`），**过不了 JSON**。协议边界必须是 `Record`。
- **`env: { ref, hash }` 与今天的 wire 矛盾** ——
  密钥现在内联在两处：`packages/agent/src/process/worker-protocol.ts:7`
  （`InitCommand.providerConfig.apiKey`）和 `packages/agent/src/types.ts:158`
  （`AgentOptions.apiKey`），外加 `visionConfig.apiKey`（`:141`）与
  `compactModelConfig.apiKey`（`:152`）两份副本。
  **Control Plane 必须先获得 secret resolver，否则该字段只是愿景**（阻塞 M6）。
- **chat 路径没有 `runId` 先例** —— worker 事件只带 `sessionId`（`worker-protocol.ts:258`）。
  `WorkflowRunCommand.runId`（`:218`）是**另一个概念**（workflow run ≠ agent run），
  绝不能混为一谈。
- **`budget` 无对应物**，最接近的是 `maxTurns`（`types.ts:289`）+ `agent.max_turns` 配置。

---

## 4. Event union —— 闭合注册表

TS 版的 grok `define_methods!`：**一个 `EventSpec[]` 数组是唯一事实来源，
union 类型是*派生*的，不是手写的。** 这从结构上排除了
"手写 union + 手写 registry"必然产生的漂移。

```ts
// events/specs.ts
export type Durability = 'durable' | 'volatile' | 'ephemeral';
export type EventCategory =
  'run'|'turn'|'assistant'|'tool'|'permission'|'compaction'|'subagent'|'diagnostic'|'extension';

export interface EventSpec<TType extends string, TPayload, TDur extends Durability> {
  readonly type: TType;
  readonly durability: TDur;
  readonly category: EventCategory;
  /** 引入该类型的协议版本 */
  readonly since: `${number}.${number}`;
  readonly payload: TPayload;
}

export const EVENT_SPECS = [
  { type: 'run.started', durability: 'durable', category: 'run', since: '1.0', payload: null! },
  // 见 §4.1 表
] as const satisfies readonly EventSpec<string, unknown, Durability>[];

// events/registry.ts —— 整个"宏"
type UnionFrom<S extends readonly EventSpec<string, unknown, Durability>[]> =
  { [K in S[number] as K['type']]: K['payload'] }[S[number]];

export interface EventRegistry<S extends readonly EventSpec<string, unknown, Durability>[]> {
  readonly all: readonly UnionFrom<S>['type'][];
  readonly byCategory: ReadonlyMap<EventCategory, readonly UnionFrom<S>['type'][]>;
  readonly durable: readonly UnionFrom<S>['type'][];
  readonly specOf: (t: string) => EventSpec | undefined;
  isKnown(t: string): t is UnionFrom<S>['type'];
}
export function defineEventUnion<S extends ...>(specs: S): EventRegistry<S>;
export type RunEvent = UnionFrom<typeof EVENT_SPECS>;   // ★ 派生，不可能漂移
```

因为 `RunEvent = UnionFrom<typeof EVENT_SPECS>`，往数组里加一条 spec 会
**自动撑宽 union**，编译器随即强制每个穷尽 `switch` 处理新类型。
这正是 `define_methods!` 靠 codegen 拿到的性质，这里用 mapped type 达成。

### 4.1 完整事件表

**D = durable（持久化，参与 transcript 重建）· V = volatile（内存 replay ring，不落盘）·
E = ephemeral（不存储，仅流内）**

| `type` | 类别 | Dur | Payload 要点 |
|---|---|---|---|
| `run.started` | run | **D** | `{ manifestHash; protocol; runtime; resumedFrom? }` |
| `run.paused` | run | V | `{ at: PausePoint }` |
| `run.completed` | run | **D** | `{ status:'completed'\|'cancelled'\|'budget_exhausted'; stopReason?; usage?; cancelRequested? }` |
| `run.failed` | run | **D** | `{ error: ProtocolErrorInfo }` |
| `turn.started` | turn | **D** | `{ turnId; index; model; providerId; apiFormat; effort? }` |
| `turn.retry_scheduled` | turn | V | `{ attempt; maxAttempts; delayMs; reason; errorClass }` —— `system.metadata.retry*`（`ai/types.ts:376`）的超集 |
| `turn.completed` | turn | **D** | `{ turnId; index; stopReason; usage; durationMs }` |
| `assistant.text_block` | assistant | **D** | `{ messageId; index; text; textSignature?; phase? }` —— 源自 `TextContent`（`ai/types.ts:36-49`） |
| `assistant.text_delta` | assistant | E | `{ messageId; index; delta }` |
| `assistant.thinking_block` | assistant | **D** | `{ messageId; index; thinking; thinkingSignature?; redacted?; encrypted? }` —— 源自 `ThinkingContent`（`:82-95`） |
| `assistant.thinking_delta` | assistant | E | `{ messageId; index; delta }` |
| `assistant.message_finalized` | assistant | **D** | `{ messageId; content; stopReason; usage?; providerMeta? }` —— 源自 `AssistantMessage`（`:506-520`） |
| `assistant.usage` | assistant | **D** | `{ usage: TokenUsage }` —— 含 `calls: UsageCall[]` 与 `last_call`（`:208-244`） |
| `assistant.mode_changed` | assistant | V | `{ mode; source:'agent'\|'user'; reason? }` —— **从 `string` 变为具名类型**（今天 `ai/types.ts:379`） |
| `assistant.goal_updated` | assistant | **D** | `{ state; phase; objective; tokensUsed; tokenBudget; consecutiveNotAchieved; gapsSummary?; strategyProposal?; pauseReason?; planFile?; history? }` —— 源自 `GoalUpdatedEvent`（`worker-protocol.ts:368-394`） |
| `assistant.status` | assistant | V | `{ message }` —— 今天的 `chat:status`（`worker-protocol.ts:341-345`） |
| `tool.call_started` | tool | V | `{ toolCallId; toolName; arguments; annotations?; attempt; groupId?; progressTitle?; progressSource?; mcp? }` —— `annotations` 源自 `Tool.annotations`（`types.ts:79-84`），`mcp` 源自 `:125-133` |
| `tool.arguments_delta` | tool | E | `{ toolCallId; delta }` —— 源自 `chat:tool_use_delta`（`worker-protocol.ts:291-297`） |
| `tool.progress` | tool | V | `{ toolCallId; title?; elapsedMs; percent?; stage? }` |
| `tool.group_progress` | tool | V | `{ groupId?; title; source }` |
| `tool.timed_out` | tool | V | `{ toolCallId; toolName; elapsedMs }` |
| `tool.call_completed` | tool | **D** | `{ toolCallId; result; isError; durationMs; errorClass?; metadata?; blocks?; structured?; images? }` —— **`isError` 是协议强制字段**，直接补上 plan-428 记录的"1666 条 tool_results、0 条 `is_error:true`" |
| `permission.requested` | permission | **D** | `{ requestId; kind; toolCallId?; toolName; toolInput; mode:'generic'\|'ask_user_question'\|'exit_plan_mode'; reason?; suggestions?; metadata?; blockedPath?; expiresAt }` —— `mode`/`metadata` 源自 `PermissionRequestEvent`（`ai/types.ts:302-310`），`toolParamsDisplay` 源自 `permissions/types.ts:204-208` |
| `permission.resolved` | permission | **D** | `{ requestId; action; source:'host'\|'policy'\|'default'\|'timeout'\|'cancelled'; latencyMs; scope?; reason? }` |
| `permission.expired` | permission | **D** | `{ requestId; afterMs }` |
| `compaction.started` | compaction | **D** | `{ compactionId; trigger:'auto'\|'manual'\|'threshold' }` |
| `compaction.step` | compaction | V | `{ compactionId; step; phase; messageCount?; tokensBefore?; tokensEstimated?; filesCached? }` —— 逐字来自 `compact:step`（`ai/types.ts:415-425`） |
| `compaction.completed` | compaction | **D** | `{ compactionId; strategy?; tokensRemoved?; tokensRetained?; removedCount?; boundaryId; compactedMessageIds }` |
| `compaction.failed` | compaction | **D** | `{ compactionId; error }` |
| `compaction.over_threshold` | compaction | V | `{ tokensRetained; available }` |
| `subagent.started` | subagent | **D** | `{ subagentId; parentToolCallId; sessionId?; agentType; agentName; agentDescription? }` |
| `subagent.completed` | subagent | **D** | `{ subagentId; status; durationMs; summary? }` |
| `hook.invoked` | subagent | **D** | `{ hookEventName; hookType; hookName; matcher?; additionalContext?; exitCode?; async; backgroundTaskId?; durationMs; status; errorMessage?; toolName?; toolUseId? }` —— 逐字来自 `AgentProgressEvent.hookEvent`（`ai/types.ts:332-347`）。**注意该 payload 自带 `seq` 字段（`:344`），是第三个 seq 命名空间；协议丢弃它，统一用 envelope 的** |
| `diagnostic` | diagnostic | E | `{ level; message; data? }` |
| `diagnostic.trace` | diagnostic | E | `{ traceId; spanId?; parentSpanId?; name; attributes? }` |
| `extension.custom` | extension | V | `{ namespace; name; data }` —— 前向兼容逃生口；host **必须**忽略未知 namespace |

`diagnostic` 单列通道，正是为了让 evaluator 能消费它而产品 UI 无视它
（`04-agent-harness-design.md:220`）。

### 4.2 需要诚实说明的缺口

- **`checkpoint` 事件**（`router.ts:1520-1526`）没有对应协议事件 ——
  它被 `compaction.completed` + `run.started{resumedFrom}` 吸收；
  `{messages, generation}` payload（`worker-protocol.ts:248-255`）是**存储形状，不该跨协议边界**。
- **`title_generated`**（`router.ts:1497-1507`）是 renderer 视图层关注点（标题生成）→ 留在 host 侧。
- **`clipboard_write`**（`ai/types.ts:394`）是 UI 命令不是 agent 状态 → 留在 host 侧。
  （worker 根本没有 clipboard。）

---

## 5. 现有 SSE 形状如何映射

`legacy/sse-event.ts` 持有 `SSE_EVENT_TO_PROTOCOL: Record<SSEEvent['type'], EventType>` 映射表。
迁移是表驱动的，drift test #9 断言该表**对 `SSEEvent` 是全覆盖的**，
且**`normalizeWorkerEvent` 能产出的每一种类型都在注册表里**。

| 今天（`@duya/ai`） | 协议事件 | 备注 |
|---|---|---|
| `text`（`:351`） | `assistant.text_block` | 今天类型声明 `data: string`，router 发 `data.content` |
| `text_delta`（`:377`） | `assistant.text_delta` | |
| `thinking`（`:364`） | `assistant.thinking_block` | 今天 `signature`/`redacted`/`encrypted` 在顶层；移入 payload |
| `thinking_delta`（`:378`） | `assistant.thinking_delta` | |
| `tool_use`（`:359`） | `tool.call_started` + `tool.call_completed` | **一个 legacy 事件 → 两个**；`is_error` 正是在这里丢的 |
| `tool_use_started`（`:352`） | `tool.call_started` | |
| `tool_use_delta`（`:358`） | `tool.arguments_delta` | |
| `tool_result`（`:361`） | `tool.call_completed` | |
| `tool_progress`（`:362`）/ `tool_timeout`（`:363`） | `tool.progress` / `tool.timed_out` | |
| `tool_group_progress`（`:360`） | `tool.group_progress` | |
| `permission_request`（`:369`） | `permission.requested` | **router 实际发的是 `permission`**（`:513-517`） |
| `turn_start`（`:368`） | `turn.started` | |
| `done`（`:365`） | `run.completed` | `reason` → `stopReason` |
| `error`（`:366`） | `run.failed` | `metadata.isRetryable` → `error.code` |
| `result`（`:367`） | `assistant.usage` | |
| `system`（`:376`） | `turn.retry_scheduled` | retry 元数据升为一等公民 |
| `mode_changed`（`:379`） | `assistant.mode_changed` | `mode: string` → 具名 |
| `goal_updated`（`:380`） | `assistant.goal_updated` | |
| `clipboard_write`（`:394`） | — **host-only** | |
| `compact:start/done/error/step/over_threshold` | `compaction.*` | 冒号 → 点 |
| `agent_progress`（`:370`） | `subagent.started`/`subagent.completed`/`hook.invoked` | 今天是一个带 8 个 `type` 值的臃肿 union（`ai/types.ts:314`） |
| `status`, `token_usage`, `checkpoint`, `ready`, `title_generated`, `workflow_run`, `research_*` | `assistant.status`, `assistant.usage`, —, `ControlFrame`, —, host-only, host-only | **从未在 `SSEEvent` 里声明过** |

### 5.1 四项必须做的改动

1. **删除 `normalizeWorkerEvent`**（`router.ts:450-569`），
   换成由注册表驱动的 `codecs.toEnvelope(workerFrame)`，
   其 `default` 分支发 `extension.custom` + 一条 `diagnostic`，**而不是静默转发未知帧**。
2. **router 停止重编号 `seq`**（`:1329`、`:1568`），**停止维护自己的 event ring**（`:2411`），
   退化为纯字节泵。重放移交 `Last-Event-ID` + runtime 的 ring。
3. **删除 `multiLineBuffer` 的 JSON 累加 hack**（`router.ts:1334-1386`，100 KB 上限）。
   它存在只因为 `sendEvent` 可能发多行 JSON；协议规定每行一次 `JSON.stringify`，
   永远不会产出裸换行。
4. **`CORS: Access-Control-Allow-Origin: *`**（`router.ts:1319`、`:2914`）
   **不得**存活到 cloud host。标记为 Bot/Cloud consumer 的阻塞项（本轮范围外）。

---

## 6. 核心 Runtime API

```ts
// transport.ts —— 纯 port，零 adapter
export interface EventSink {
  emit(e: RunEventEnvelope): void;
  close(frame?: ControlFrame): void;
  readonly closed: boolean;
}
export interface EventSource extends AsyncIterable<RunEventEnvelope> { close(): void; }
export interface ControlChannel {
  request<M extends ControlMethod>(m: M, p: MethodParams<M>): Promise<MethodResult<M>>;
  notify<M extends ControlMethod>(m: M, p: MethodParams<M>): Promise<void>;
  readonly signal: AbortSignal;
}
export type ControlMethod =
  | 'run.start' | 'run.cancel' | 'run.pause' | 'run.resume'
  | 'permission.respond' | 'permission.setMode'
  | 'runtime.probe' | 'runtime.ping';

// run.ts
export interface RunHandle {
  readonly runId: string;
  readonly sessionId: string;
  readonly manifest: RunManifest;
  readonly terminal: Promise<RunTerminalState>;   // 恰好 resolve 一次
  events(): EventSource;                          // ★ 唯一的状态传播通道
  respondToPermission(requestId: string, d: PermissionDecision): Promise<PermissionAck>;
  cancel(reason?: CancelReason, opts?: { graceMs?: number }): Promise<CancelOutcome>;
  pause(at?: PausePoint): Promise<void>;
  result(): Promise<RunResult>;
}
export interface AgentRuntimeApi {
  start(manifest: RunManifest, input: RunInput, opts?: StartOptions): Promise<RunHandle>;
  resume(manifest: RunManifest, r: ResumeRequest, input?: RunInput): Promise<RunHandle>;
  probe(opts?: ProbeOptions): Promise<RuntimeCapabilities>;
  readonly capabilities: RuntimeCapabilities;    // 同步，来自 hello/ready 帧
}
export interface RuntimeBinding {   // 每种 host 模型一个；三者完全可互换
  readonly transport: 'in-process' | 'subprocess' | 'http-sse';
  probe(opts?: ProbeOptions): Promise<RuntimeCapabilities>;
  start(manifest: RunManifest, input: RunInput, opts?: StartOptions): Promise<RunHandle>;
  resume(manifest: RunManifest, r: ResumeRequest, input?: RunInput): Promise<RunHandle>;
  close(): Promise<void>;
}
```

`RunResult` = `{ runId, sessionId, status, stopReason?, error?, metrics, trace,
permissionAudit, budgetUsed }`（`04-agent-harness-design.md:283-313`）。

> **`trace` 只含 durable + volatile 子集**；ephemeral 事件只在 metrics 里计数、不保留。
> 否则一次 `text_delta` 风暴就会吃掉整个内存。

---

## 7. Permission：请求 / 响应 / 超时 / 沉默

```ts
export type PermissionAction = 'allow' | 'allow_always' | 'deny' | 'defer';
export type PermissionScope =
  | { kind: 'tool'; toolName: string }
  | { kind: 'session' }
  | { kind: 'rule'; ruleContent: string };
export type PermissionDecision =
  | { action: 'allow'; updatedInput?: Record<string, JsonValue>; userModified?: boolean }
  | { action: 'allow_always'; scope: PermissionScope }
  | { action: 'deny'; reason?: string }
  | { action: 'defer' };
export type PermissionAck =
  | { accepted: true }
  | { accepted: false;
      reason: 'permission_expired'|'permission_unknown_request'|'run_terminal'|'not_permission_action' };
```

### 7.1 唯一权威时钟

`expiresAt = startedAt + manifest.permissionPolicy.defaultTimeoutMs`
（默认 `300_000`，对齐 `agent-process-entry.ts:2240`）。
legacy 的 `PermissionRequestEvent.expiresAt`（`ai/types.ts:303`）由 agent 铸造，
计时器由 worker 设置——**两个会打架的时钟**。协议在一处铸造两者。
in-process 下计时器 `unref`（保留 `agent-process-entry.ts:2244-2246` 的行为），
HTTP 下无需对应物。

### 7.2 如果 host 永不回答（这就是问题本身）

1. 到 `expiresAt` 时，runtime 先发 `permission.expired`，
   **再**发 `permission.resolved{ action:'deny', source:'timeout', latencyMs }` ——
   **决策被持久记录，离线 host 重连后能看到发生了什么**。
2. 工具调用以 `tool.call_completed{ isError: **false** }` 收束，返回中性结果。
   **超时拒绝是策略结果，不是失败**；标成 `isError: true` 会污染 transcript 和所有成本指标。
3. 之后才到达的 `permission:resolve` **不是抛异常的路径** ——
   `respondToPermission` resolve `{accepted:false, reason:'permission_expired'}`，
   runtime 不发任何东西。对应 `agent-process-entry.ts:4409-4412` 的 `clearTimeout` 先行纪律。
4. **带未决 permission 被 cancel 时**：所有未决请求以 `deny` + `source:'cancelled'` 收束，
   计时器清除，**每个都发 `permission.resolved`**，保证审计链完整。
5. 重复 `requestId` 是 runtime bug（id 由 runtime 铸造、per-run 唯一）：
   发 `diagnostic{level:'error'}` 并**丢弃**，绝不覆盖 ——
   保留 `agent-process-entry.ts:2225-2232` 注释所防守的不变量。

### 7.3 legacy 词汇映射（一个 release 后删除）

| legacy | 协议 |
|---|---|
| `allow_once` | `allow` |
| `allow_for_session` | `allow_always{ scope:{kind:'session'} }` |
| `paused`（`types.ts:337`） | `deny` + `source:'timeout'` —— 这正是 bot 审批卡片路径的实际含义（`types.ts:334-336`） |
| `HUB_ERROR` 类未知串 | `defer` + 一条 `diagnostic` |

---

## 8. 取消语义

```ts
export type CancelReason =
  'user'|'budget'|'tool_error'|'permission_denied'|'host_shutdown'|'harness_abort';
export type RunTerminalState = {
  status: 'completed'|'cancelled'|'budget_exhausted'|'failed';
  error?: ProtocolErrorInfo;
};
export interface CancelOutcome { readonly applied: boolean; readonly terminal: RunTerminalState; }
```

**优先级 —— 终态的首次写入者胜。** run 状态机为
`pending → running → completing → terminal`，终态迁移是一次性执行的 CAS。推论：

- 任何终态之后调 `cancel()` 返回 `{applied:false}` 且**无任何效果**。不抛错、不重发。
- `run.completed` / `run.failed` 中**恰好一个**是流的最后一个 envelope。
  `run.completed{status:'cancelled', stopReason:'aborted'}` 复用既有 `StopReason: 'aborted'`（`ai/types.ts:271`）。
- **取消不是失败**，它发 `run.completed` 而非 `run.failed`。
- 预算耗尽、工具错误停止、自然完成、取消**争夺同一个 CAS** ——
  它们之间没有优先级排序，只有到达顺序。
  **这是刻意的**：任何优先级方案都需要一个 host 可能尚未观察到的全序。
- `graceMs` 默认取 capability 通告值（今天 `2000`，`worker-manager.ts:304`）。
  若 transport 不得不升级为硬杀，该 run 是
  `run.failed{ code:'runtime_crash', details:{escalated:true} }` ——
  **硬杀意味着干净取消路径没被遵守，报 `cancelled` 就是撒谎。**
- `applied` 是相对 `handleDeleteChat`（`router.ts:1697`）的改进：
  后者在 worker ack **之前**就在 DB 里硬迁移 `STREAMING → COMPLETED`（`:1681-1683`），
  返回 `{ok:true, interrupted:boolean}`。
  **host 今天无法区分"是我取消的"和"它本来就已经结束了"。**

---

## 9. Resume

```ts
export type ResumeBoundary =
  | { kind: 'turn_boundary'; turnIndex: number }        // 最干净；transcript 一致
  | { kind: 'event_seq'; seq: number }                 // 需要 replay window
  | { kind: 'message_index'; atMessageIndex: number }  // fork；复用前缀
  | { kind: 'checkpoint_generation'; generation: number };  // 唯一能跨进程死亡的
export interface ResumeRequest {
  readonly from: ResumeBoundary;
  readonly additionalInput?: RunInput;
}
export interface ResumeSupport {
  turnBoundary: boolean; eventSeq: boolean;
  messageIndex: boolean; checkpointGeneration: boolean;
  replayWindow: number;            // 保留的 envelope 数；今天 500（electron/agents/server/types.ts:39）
  /** 从未闭合 tool call 内部恢复一律 REJECT */
  rejectsMidToolResume: true;
}
```

- `event_seq` 超出 `replayWindow` → `replay_unavailable`。
- **seq 严格落在 `tool.call_started` 与其终态事件之间的恢复被拒绝**，
  返回 `invalid_resume_point`。
  工具副作用**不是事务性的**，mid-tool 恢复会静默重复执行。
  今天的 500 事件 ring（`server/types.ts:39`）有损且无类型，**没有任何机制阻止这件事** —— 协议必须阻止。
- `message_index` 是**新 run**，带新 `runId` 与 `parentRunId`，不是延续。
  背后是 `session-fork.ts` + `ChatOptions.replyToId/branched`（`types.ts:282-287`）。
- `checkpoint_generation` 是唯一能跨 runtime 进程死亡存活的边界，
  背后是 `CheckpointEvent{messages, generation}`（`worker-protocol.ts:248-255`），
  **本质上是一次存储读取**。协议里声明，由 Control Plane 实现。
- 被恢复的 run **重新校验 `manifestFingerprint`**；
  manifest 变了就是 `invalid_manifest`，而不是一次静默的行为漂移。

---

## 10. Capabilities —— 探测，不是版本协商

**建议 capability 探测，major 版本是唯一硬门。**
semver 协商**失败开放**：minor 升了以后 runtime 静默地行为不同，没有任何东西会抱怨。
四个 host 独立部署（Desktop app、CLI npm 包、eval harness、未来 cloud），
host 必须能说"我需要 replay + pause"并得到**响亮的** `capability_unsupported`，
而不是一次降级的 run。对齐 `04-agent-harness-design.md:406-408` 与 grok 的 `--capabilities`。

```ts
export interface RuntimeCapabilities {
  protocol: { major: number; minor: number };
  runtime: { name: string; version: string };
  run: {
    resume: ResumeSupport;
    cancel: 'cooperative' | 'immediate';
    graceMs: number;
    pause: boolean; deterministic: boolean; maxEventBytes: number;
  };
  events: { replayWindow: number; durable: readonly EventType[]; ephemeral: readonly EventType[] };
  permissions: { actions: readonly PermissionAction[]; defaultTimeoutMs: number; maxTimeoutMs: number };
  catalog: { profiles; modes; tools; connectors };
  transports: readonly TransportKind[];
  limits: { maxTurns; maxWallClockMs; maxToolCalls; maxTokens };
}
export interface ProbeOptions {
  readonly require?: readonly CapabilityRequirement[];
  readonly timeoutMs?: number;
}
export function assertSatisfies(c: RuntimeCapabilities, req: readonly CapabilityRequirement[]): void;
```

`require` 是关键能力：harness 声明 `{ needsReplayWindow: 1000 }`，
subprocess binding 把它映射到 `GET /sessions/{id}/status`
（今天返回 `status, sessionId, createdAt, turnCount, lastEventId, hasWorker` —— `router.ts:2705-2735`；
**新增 `replayWindow` + `protocol`**）。

**没有任何 host 需要解析版本号来决定行为。**

---

## 11. Error taxonomy

**可重试性是这个包里的一个 wire code** —— grok 的 `TURN_ACTIVE` / `is_turn_active()`
教训（`02-reference-repo-boundaries.md:293-301`）：
客户端分类可重试失败时，**不需要 import 服务端的错误枚举**。

```ts
export const ERROR_CODES = [
  // 请求 / 协商
  'invalid_request','invalid_manifest','invalid_resume_point','replay_unavailable',
  'unsupported_protocol_version','unknown_method','invalid_event_frame','unknown_event_type',
  // 生命周期
  'run_not_found','session_not_found','run_active','run_terminal','cancel_conflict',
  // 权限
  'permission_unknown_request','permission_expired','permission_denied_by_policy',
  // 能力
  'capability_unsupported','capability_not_ready','manifest_mismatch',
  // transport / runtime
  'transport_closed','transport_backpressure_timeout','runtime_unavailable','runtime_crash',
  'worker_spawn_failed',
  // 预算
  'budget_exhausted','deadline_exceeded',
  // provider（映射自今天的 metadata.errorType/statusCode，ai/types.ts:366）
  'provider_rate_limited','provider_auth','provider_quota','provider_overloaded',
  'provider_bad_request','provider_timeout','provider_unavailable',
  // 执行
  'tool_failed','tool_timeout','tool_crash','compaction_failed','checkpoint_failed',
  'persistence_failed',
  'internal',
] as const;
export type ErrorCode = typeof ERROR_CODES[number];

export const RETRYABLE_ERROR_CODES: ReadonlySet<ErrorCode> = new Set([
  'provider_rate_limited','provider_overloaded','provider_timeout','provider_unavailable',
  'transport_closed','runtime_unavailable','deadline_exceeded',
]);
export function isRetryable(code: string): boolean;   // 未知 code → false，失败关闭
export function isKnownCode(code: string): code is ErrorCode;
export interface ProtocolErrorInfo {
  code: ErrorCode; message: string; details?: JsonValue; retryAfterMs?: number;
}
export type WireResult<T> = { ok: T } | { err: ProtocolErrorInfo };
```

**未知 code → `isRetryable` 返回 `false`、`isKnownCode` 返回 `false`。**
host 记一条 `diagnostic` 并**不重试**。
失败关闭是对的默认，因为另一种选择是**对一个从未见过的 code 无限重试**。
`retryAfterMs` 是一等字段，不是从 `message` 里正则解析出来的
（今天它根本没有被表达）。

**这替换掉两个已经在跨边界泄漏的布尔值**：

- `SSEEvent.error.metadata.isRetryable`（`ai/types.ts:366`）
- `Session.errorRetryable`（`electron/agents/server/types.ts:22`，暴露于 `router.ts:2733`）

两者都是由**写入方**计算的布尔值 —— 这恰恰是它们在版本偏移下不可信的原因。
**活体例证**：router 今天在每条错误路径上硬编码 `failSession(..., true)`（retryable）
（`router.ts:1559`、`:2495`）。

---

## 12. Transport 绑定规则

**协议定义 port，不定义 socket。**
`EventSink`/`EventSource`/`ControlChannel` 在三种 transport 下完全相同，
每个 adapter 只在 framing、背压、错误映射上不同。

| 关注点 | in-process | subprocess | HTTP+SSE |
|---|---|---|---|
| **Framing** | 直接传对象引用 | NDJSON：每行一个 `JSON.stringify(envelope)`；`stdin` 每行一个 `ControlFrame`/`ControlCommand` | `id: <seq>\nevent: <type>\ndata: <envelope JSON>\n\n`。顺序是 `id:` → `event:` → `data:`。`id` == envelope `seq` |
| **Ordering** | 原生 | stdout 有序；runtime 是唯一写方 | 每连接内有序；跨重连以 runtime 的 ring 为准 |
| **背压** | 有界队列，`maxBufferedBytes`（默认 8 MB）。溢出时**只丢 ephemeral**，发 `diagnostic{level:'warn',data:{dropped:n}}`；若 **durable** 事件排不进去，**runtime 暂停模型循环，绝不丢** | 尊重 `child.stdout.write()` 返回 `false` + `drain`；同样的丢弃策略 | 尊重 `res.write()` 返回 `false` + `'drain'`；同样策略。**SSE 没有流控信号，所以 adapter 是背压唯一可能存在的地方** |
| **错误** | 抛 `ProtocolError`（携带 `ProtocolErrorInfo`） | `ControlFrame{kind:'error'}`；进程退出码 ≠ 0 → `runtime_crash`（尊重 `intentionalKills`，`worker-manager.ts:152`） | 请求阶段：400→`invalid_request`，404→`run_not_found`，409→`run_active`，503→`runtime_unavailable`；流阶段：`event: error` → `run.failed` |
| **Resume** | 不适用（无断连） | `start` 命令里携带 `Last-Event-ID` 等价物 | `Last-Event-ID: <seq>` header（已在 CORS allow-list，`router.ts:2915`） |
| **存活** | `AbortSignal` | `ping`/`pong`（见 `agent-process-entry.ts:16` 文档） | 15s SSE keep-alive 注释（`router.ts:1323-1325`）—— **transport 层，不是协议事件** |

**同一协议，三个 host**：`02-reference-repo-boundaries.md:220` 警告过
"两个 SDK 跑在两个 transport 上"是负面教训。具体做法：
**drift test #8 用同一段脚本分别跑 in-process 与内存版 HTTP+SSE server，
断言 `EventType` 序列与终态 `RunResult` 完全一致。这个测试本身就是 parity 保证。**

---

## 13. Versioning 与兼容性

- 单一 `PROTOCOL_VERSION` 于 `version.ts`，semver。
  **MAJOR** = 现有字段的 wire 语义变更、删除、重命名，或 `seq`/envelope 语义变更。
  **MINOR** = 新增事件类型，或在既有 payload 上新增**可选**字段。
- **兼容门**：`runtime.protocol.major === host.protocol.major`。
  **minor 不匹配不致命**，由 capability probe（`require`）解决，
  **绝不靠解析版本字符串**。
- `isCompatible(host, runtime)` 返回 `{ ok, reason }`，**只在 probe 时调用一次**。
- **未知事件类型的前向兼容**（老 host 遇到新 runtime）：
  1. `payload.type` 是 wire **字符串**，绝不用 TS symbol。
  2. `fromEnvelope` 对未知 `type` **不得抛异常**，返回
     `{ kind:'unknown', type, raw }`，作为独立的 `UnknownRunEvent`。
  3. host 的 default 分支：什么都不渲染，记 `diagnostic{level:'debug'}`，**不持久化**。
     **未知事件永远不是 durable。**
  4. 已知 payload 内的未知**字段**被**忽略** —— 解码路径上没有 `additionalProperties: false`。
     严格性是**校验**（`codecs.validate`）的职责，与解码分离。
  5. probe 响应里的 `runtime.eventTypes` 让 host 能枚举自己实际会看到什么，
     **让不匹配可诊断，而不是神秘**。
- 删除或重命名字段 → bump MAJOR，并需要一个 MINOR 周期的 `deprecatedSince` 标记。

---

## 14. 禁止进入 protocol 包的内容

| 排除项 | 理由 / 归宿 |
|---|---|
| **任何 IO** —— `node:fs`/`node:net`/`node:http`/`child_process`/`fetch(`/`setTimeout(` | `domain-io` 规则（`05:140`）为此存在。类型里放超时**数值**可以，调用 `setTimeout` 不行。这就是 grok `sampling-types` 的失败：文档声称 "no I/O"，而 `Cargo.toml` 拉进了 `reqwest` + 16 个内部 crate（`02:271-280`） |
| **密钥** —— `apiKey`、bearer token、connector 凭据 | 今天存在于 `worker-protocol.ts:7`、`types.ts:141,152,158`。`RunManifest.env = {ref, hash}` 是替代方案 |
| **携带 Promise 的字段** | `ToolResult.pendingExtraResult` / `pendingContext`（`ai/types.ts:165,173`）是延迟句柄，必须在协议边界**之前**解析，绝不序列化 |
| **`Map` / `Set`** | `PermissionDecisionReason.subcommandResults` 持 `Map<string, PermissionResult>`（`permissions/types.ts:311-313`）；`ToolPermissionContext` 用三个 `ReadonlyMap`（`:427-434`）。都不是 JSON，必须在边界展平为 `Record` —— 这是"直接搬 `permissions/types.ts`"的**具体阻塞点** |
| **回调** | `ChatOptions.requestPermission`（`types.ts:337`）、`onSystemPromptReady`（`:253`）、`conductorIpc`（`:417-424`）都是函数。变成 `ControlChannel` 方法或 `diagnostic` 事件，**绝不作为 payload 字段** |
| **工具实现** | `ChatOptions.toolRegistry: ToolRegistry`（`types.ts:269`）与 `Tool.mcpInfo` 的 dispatch 闭包。只有**描述符形状**能搬 |
| **内联 `import()` 类型引用** | `types.ts:200`（`./prompts/types.js`）、`:440`（`./prompts/research/types.js`）把实现拖进协议的类型图。protocol 自带最小 enum |
| **存储模型** | `MessageEntry`、`AgentMessage`、`CompactionEntry`、`ingestMessage`、`THREAD_METADATA_KEY` —— 即 §0.1 的 17 文件 import 集。是 storage 模块，不是 wire |
| **UI / renderer 视图模型** | `WorkflowRunSse` 自述为 "renderer-facing snapshot"（`worker-protocol.ts:504`）、`clipboard_write`、`title_generated`、`displayContent`（`types.ts:413`） |
| **DB schema、conductor canvas、workflow engine** | 按指示范围外 |
| **zod/ajv 作为运行时依赖** | 类型才是事实来源；JSON Schema 在**测试期**生成（drift test #10），对齐 codex 的"build-time no-op derive, test-time generate"（`02:207-212`） |

---

## 15. Drift tests

全部位于 `packages/agent-protocol/tests/`，由 `npm run typecheck:all` 与一个阻塞式 CI 检查运行。

| # | 测试 | 断言 |
|---|---|---|
| 1 | `import-graph.test.ts` | 遍历 `src/**/*.ts`，解析**全部** specifier（相对、tsconfig paths、**以及 `@duya/*` workspace 名** —— 这正是让 ZCode 的治理变成一纸空文的解析器缺口，`05:184-205`），断言对 `packages/agent`、`packages/ai`、`packages/cli`、`electron/`、`src/` **零边**；零 `node:*`/`fs`/`net`/`http`/`child_process`/`fetch(`/`setTimeout(`。**这个测试必须第一天就存在** —— 文档字符串不是强制力 |
| 2 | `cycle-budget.test.ts` | `packages/agent` 的 SCC 数必须**始终 ≤ 18**（基线 `05:327`），且 protocol 贡献 0。守护 M2–M11 不把 42 文件 SCC 重新缠回去 |
| 3 | `event-union-closed.test.ts` | 每个 `EventSpec`：取 `fixtures.ts` 的 payload → `JSON.stringify` → `fromEnvelope` → 深度相等；断言解码 `type` 是精确字符串；断言未知 type 解码为 `UnknownRunEvent` 且不抛 |
| 4 | `event-exhaustive-switch.test.ts` | 编译期 `switch (e.payload.type) { … default: const _x: never = e.payload }`；加运行时覆盖图断言注册表里每种类型都被处理 |
| 5 | `event-type-snapshot.test.ts` | `registry.all` 排序后等于 `__snapshots__/event-types.json`。新增事件必须**刻意**更新快照，且 diff 可 review |
| 6 | `error-code-snapshot.test.ts` | `ERROR_CODES` 等于入库 JSON 快照；`RETRYABLE ∪ TERMINAL == ERROR_CODES` 且两集合不相交；`isRetryable` 全覆盖；`isRetryable('never_seen_code') === false` |
| 7 | `permission-vocabulary.test.ts` | 断言唯一的 `PERMISSION_ACTIONS` 集被 `router.ts`、`agent-process-entry.ts` 与 runtime 回调共同使用；扫描这三个文件里任何竞争性的字符串字面量 union。直接守住 §7.3 映射 |
| 8 | `envelope-seq.test.ts` | 假 runtime 发 N 个事件；断言 `seq` 为 `1..N`、无空洞无重复，且**穿过三种 adapter 各自**往返后仍然成立 |
| 9 | `sse-legacy-bridge.test.ts` | `SSE_EVENT_TO_PROTOCOL` 对 `SSEEvent['type']` 全覆盖；且当前 `normalizeWorkerEvent` 能产出的**每一种**类型都在注册表里。**这是抓住 `permission` vs `permission_request`、`status`、`token_usage` 漂移的测试** |
| 10 | `json-schema-freshness.test.ts` | 测试期从类型重新生成 `schema/*.json`，与入库版本 diff，漂移即失败。对齐 codex 的 `typescript_schema_fixtures_match_generated`（`02:212`） |
| 11 | `manifest-immutability.test.ts` | 类型级：每个 `RunManifest` 字段都 `readonly`；运行时：`start` 时取指纹、`resume` 时重校验；被改写的 manifest → `manifest_mismatch` |
| 12 | `no-secret-in-manifest.test.ts` | 构造 manifest，遍历查找匹配 `/api[-_]?key\|secret\|token\|password\|credential\|bearer/i` 的键，命中即失败。针对重新引入 `InitCommand.providerConfig.apiKey`（`worker-protocol.ts:7`）的具体护栏 |
| 13 | `transport-parity.test.ts` | 同一段脚本分别跑 in-process 与内存版 HTTP+SSE；断言 `EventType` 序列与 `RunResult.status` 一致。"一套协议、三种 transport" 的真实证明 |
| 14 | `capability-probe.test.ts` | `assertSatisfies` 对 fixture runtime 正确通过/抛出，含 major 版本不匹配与无法满足的 `require` |

---

## 16. 迁移顺序

`packages/agent` 有 **18 个循环 SCC、669 个非测试文件、157k LOC**（`05:325-331`）。
**`types.ts` 本身在环内**：它 import `./tool/SubagentTool/loadAgentsDir.js` 与
`./permissions/types.js`（`types.ts:6-7`）。
因此抽取方向是固定的：**protocol ← ai ← agent**，
且 `types.ts` 退化为 re-export shim —— **先例已存在**：`types.ts:14-56` 已经从 `@duya/ai` 再导出。

每一步都可独立发布，且**先加它的 drift test，再加它守护的代码**。

| # | 步骤 | drift test | 风险 |
|---|---|---|---|
| **M0** | 建 `scripts/architecture/architecture-check.mjs`，用**正确**的解析器，加 `--self-test` 断言基线（18 SCC / 117 deep / 161 escapes） | — | **闸门。没有它，"不新增边"无法强制。别跳过** —— `05:300-331` |
| **M1** | 建空壳 `packages/agent-protocol`：`primitives`、`version`、`errors`、`events/{specs,registry,payloads}`、`testing/fixtures`。`managed: true`，`requires: []`。**尚未搬任何代码** | 1,2,3,4,5,6,10,12 | 无 |
| **M2** | 把纯数据从 `@duya/ai` 搬进 protocol：`Message`/`MessageContent`/`TextContent`/`ThinkingContent`/`ToolUse`/`ToolResult`（去 Promise）/`TokenUsage`/`UsageCall`/`StopReason`/`PermissionRequestEvent`/`AgentProgressEvent` + **新增** `RunEvent`。`@duya/ai` 改为从 protocol 再导出并把它列为依赖（**该决策已定**）。`SSEEvent` 移入 `legacy/` | 1,3,4,9 | **最高**。`SSEEvent` 有 40+ 个 import 点。先做**整整一个 release 的纯类型再导出**，再动任何行为 |
| **M3** | Bridge + router 切换：`legacy/sse-event.ts` 映射表；删除 `normalizeWorkerEvent`；**把 `seq` 铸造从 router 移到 runtime**；删除 `multiLineBuffer` hack | 8,9 | 行为性改动。去掉 `seq` 重编号会影响重放 |
| **M4** | `RunManifest` + `AgentRuntimeApi` **只有接口，无实现**。probe 落地；`POST /sessions` 响应与 `GET /sessions/{id}/status`（`router.ts:2705-2735`）新增 `protocol` + `replayWindow` | 11,14 | 无 —— 纯增量 |
| **M5** | Permission 词汇统一：单一 `PERMISSION_ACTIONS`；单一 `expiresAt`；legacy 映射 | 7 | 中。触及 `types.ts:337`、`router.ts:1785`、`agent-process-entry.ts:4413` |
| **M6** | Manifest 成为唯一 run-start 路径。`InitCommand`（`worker-protocol.ts:3-35`）+ `ChatStartCommand`（`:37-138`）改写为 `{manifest, input}`；`agent-process-entry.ts` 保留一个 release 的翻译 shim。**密钥离开 wire** —— 需要 Control Plane 的 secret resolver | 12 | 高。**被一个尚未做出的决策阻塞**（密钥如何解析） |
| **M7** | `ControlChannel` 的 cancel/pause/resume；`interruptWorker`（`worker-manager.ts:304`）变成带 reason + `graceMs`（取自 capabilities）的 `cancel` | 8 | 中 |
| **M8** | subprocess adapter。`chat:interrupt` / `permission:resolve` 按 `ControlMethod` 重新定型 | 8,13 | 低 |
| **M9** | HTTP+SSE adapter → envelope；`Last-Event-ID` 续传；500 事件 ring（`server/types.ts:39`）成为 capabilities 里的 `replayWindow` | 8,13 | 中 |
| **M10** | CLI + harness 的 in-process adapter。**到这一步，边界才真正对第 4 个 consumer 成立** | 13 | 低 |
| **M11** | 重新定型那 17 个 `@duya/agent/message` import。**拆开目标**：`Message`/`MessageContent` → `@duya/agent-protocol`；`MessageEntry`/`CompactionEntry`/`AgentMessage`/`ingestMessage`/`THREAD_METADATA_KEY` → 新的 storage 模块。修掉 2 处相对路径穿透（`electron/wake/group-turn-dispatcher.ts:35`、`electron/ipc/group-handlers.ts:29`） | 1,2 | diff 最大（17 文件）；**最后做**，等 protocol 已被信任 |

### 16.1 为什么是这个顺序

- **M0 守住一切。**
- **M1 在包还很小的时候就把"假叶子"探测器落地**，
  这样 grok `sampling-types` 的失败模式在**第一天**就被抓住，而不是抽取之后。
- **M2 是单步风险最高的一步**，给它整整一个 release 的纯类型再导出。
- **M3–M5 在 HTTP 表面都是增量的。**
- **M6 是唯一需要"没人做过的决策"的步骤**（密钥解析）。
- **M11 放最后，因为它 diff 最大，且依赖 protocol 已被信任。**

### 16.2 打包注意（M1）

新增 workspace 成员 ⇒ 依 `AGENTS.md` Worktree setup 第 2 步，
需要 `packages/agent-protocol` 里有 `node_modules` junction（以及每个 worktree 里都要），
否则 tsc 会报假的 TS2307。把该包加入 `typecheck:all`，
并在 tsconfig project-reference 图里**先构建它** ——
**project reference 里的环是 SCC 问题的构建期孪生兄弟。**

---

## 17. 未知数与风险

- **`RunManifest.env` 的密钥解析方案未定，阻塞 M6。**
  Control Plane 必须拥有一个 `ref → credential` 的解析器，且它**永不跨越协议边界**。
- **500 事件的 replay ring**（`server/types.ts:39`）有损且无类型
  （`SessionEventRecord.data: unknown`，`server/types.ts:32-37`）。
  `event_seq` 续传只有在 ring 有持久化支撑、或其窗口被诚实通告时才算诚实。
  **未核实长 run 中 durable 事件密度超过 500 的频率。**
- **`normalizeWorkerEvent` 在 `:569` 之后还有约 120 行**（research/workflow 分支）
  被抽样但未完整枚举。
  **删除该函数前 M3 必须补完这份清单** —— drift test #9 会暴露剩余部分，
  但映射表应该先写。
- **`allow_for_session` 在实践中是进程作用域的**（`agent-process-entry.ts:4414-4416`），
  **只是因为一个 worker 今天恰好服务一个 session**。
  协议的 `allow_always{scope:{kind:'session'}}` **不得继承这个巧合**。
- **harness 本身**（`harness/`，见 `04-agent-harness-design.md:47-83`）
  刻意位于 workspace 之外；它的边界检查独立于 `architecture-check.mjs`（`05:48`）。
