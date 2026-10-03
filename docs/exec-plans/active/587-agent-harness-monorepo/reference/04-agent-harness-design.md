> Historical / superseded for execution. 原位置：`docs/architecture/04-agent-harness-design.md`。
> 唯一执行入口：[587 主计划](../README.md)；设计冲突以 [00 合同](../00-contracts.md) 为准。旧 Status / checkbox / 行号保留为历史证据。

# Agent Harness 设计

> 阶段一交付物 4/5 · 生成日期 2026-10-01
> 目标：让 **Desktop / CLI / Harness / Bot-Cloud** 成为 `agent-runtime` 的**平级 consumer**。
> 核心约束：Harness **不得**依赖 agent 内部实现，只通过正式 protocol/runtime API 驱动。

---

## 0. 现状基线（实测）

| 事实 | 证据 |
|---|---|
| 全仓 **0 个** harness / eval script | `package.json` 无 `harness` 相关 script |
| `e2e/` 仅 **14** 个测试文件 | `e2e/playwright.config.ts`，只有 smoke + ipc 两个 project |
| 已有可复用的 agent 测试基建 | `packages/agent/tests/vitest.config.ts` + 520 个 packages 测试文件 |
| 事件类型已存在 | `SSEEvent` / `PermissionRequestEvent` / `AgentProgressEvent` 定义在 `@duya/ai`（`packages/ai/src/types.ts`） |
| 进程边界已存在 | `AgentProcessPool` + `agent-process-entry.ts`（子进程）· `electron/agents/server`（HTTP+SSE） |
| 已有 `ready` 握手 | 打包冒烟检查"首轮 chat 到达 agent `ready`"（`AGENTS.md` Pre-release checks） |
| **但** protocol 未成形 | `SSEEvent` 在 `@duya/ai`（provider 层），不在独立 protocol 包；electron 深导入 agent 142 条 |

**三家参考仓库都没有真正的 harness**：

| 仓库 | 现状 |
|---|---|
| ZCode | 全仓 **4 个**测试文件 / 30 包；`harness/` 目录只有 3 个 Docker 文件（远程沙箱，非 eval） |
| codex | 三个 test-support workspace 成员 + `insta` snapshot；**无 evaluator、无打分、无跨 run 比较**；"eval" = snapshot 相等 |
| grok-build | `xai-grok-test-support`（`MockInferenceServer` 在 wire 层、byte-exact SSE、`TestSandbox` 隔离 HOME）+ PTY harness；**无评分** |

> **结论**：Agent Harness 不是"抄来的"，是 Duya 需要**新建**的能力。
> 但三个仓库各自的**局部机制**都可直接借用（见 §6）。

---

## 1. 核心设计原则

1. **Harness 是 consumer，不是 peer。** 它与 Desktop 平级，都只依赖 `agent-protocol` + `agent-runtime` 的公共面。
2. **一切经过协议。** Harness 看不到 `DuyaAgent` 实例、看不到 `tool/` 内部、看不到 DB。
3. **Wire-level mock。** 参考 grok-build 的 `MockInferenceServer`：mock 打在 LLM provider 的**网络边界**，
   不是打在 `LLMProvider` interface 上。否则测不到 SSE 转换、token 计数、重试这些真实行为。
4. **默认离线。** Harness 跑 CI，不能依赖真实 API key。
5. **可复现。** 相同 fixture + 相同 mock 响应 → 相同轨迹。
6. **具名逃生舱。** 任何"harness 需要访问内部"的诉求，先在 protocol 上加正式能力，
   实在不行则开一个**具名**模块（codex 的 `legacy_core` 模式），禁止 grep-ignore。

---

## 2. Harness 物理布局

**关键决策：harness 不是 workspace member。**

理由（对照准则 7「降低 build / ownership complexity」）：

- 若 harness 是 workspace member，它会进入 `npm run typecheck:all` 与 `npm run build:agent` 的关键路径
- harness 需要 fixture（可能含大文件、录制响应），这些不应进 npm 发布产物
- harness 演进频率远高于产品代码（每日跑 eval），不该拖慢 `typecheck:all`

```
harness/                          # 独立 npm project，自带 package.json + node_modules
  agent/
    tasks/                        # 任务定义（YAML/TS），每个 task = 一个场景
      smoke/                      #   基础连通性
      tool-contract/              #   工具语义契约
      memory-lifecycle/           #   记忆生命周期
      multi-agent/                #   subagent 编排
    runners/                      # 执行器
      local-runner.ts             #   进程内（最快，调试用）
      subprocess-runner.ts        #   走 AgentProcessPool（最真实）
      http-runner.ts              #   走 electron/agents/server HTTP+SSE
    evaluators/                   # 断言
      trajectory.ts               #   轨迹断言（工具序列）
      outcome.ts                  #   结果断言（文件/DB 状态）
      cost.ts                     #   token / 时延 / 重试次数
      policy.ts                   #   权限合规（是否请求了不该请求的权限）
    fixtures/                     # 输入
      workspaces/                 #   临时工作区模板
      transcripts/                #   预录会话
    reports/                      # 输出（gitignored）
      latest.json
      history/
  mock-provider/                  # wire-level LLM mock（grok-build 式）
    server.ts                     #   127.0.0.1:0，按请求指纹确定性重放
    corpus/                       #   录制响应 + 期望
```

---

## 3. Run API —— Harness 与 Agent 的唯一契约

这是整个设计最重要的部分。**Run API 必须在 `packages/agent-protocol` 中定义，
由 `agent-runtime` 实现，Harness 只依赖前者。**

### 3.1 核心类型

```typescript
// packages/agent-protocol/src/run.ts

export interface RunRequest {
  /** 稳定标识，用于 trace 关联与幂等 */
  runId: string;
  /** 隔离的运行上下文 —— Harness 每次 run 都是全新世界 */
  context: RunContext;
  /** 初始输入 */
  input: RunInput;
  /** 覆盖默认 agent 能力配置（不传则用 AgentProfile 默认） */
  agent?: AgentProfileRef;
  /** 覆盖 mode（plan-task / research / conductor） */
  mode?: ModeId;
  /** 运行预算 —— Harness 依赖它保证 CI 不挂死 */
  budget?: RunBudget;
  /** 确定性开关：关闭时间戳/随机 ID/并发，保证可复现 */
  deterministic?: boolean;
}

export interface RunContext {
  /** 隔离的工作区目录。Harness 每次提供全新临时目录。 */
  workspace: string;
  /** 隔离的数据目录（覆盖 %APPDATA%/DUYA） */
  dataDir?: string;
  /** 环境变量白名单（grok TestSandbox 模式：env_clear + allowlist） */
  env?: Record<string, string>;
  /** 禁止的外部网络目标。默认全部禁止。 */
  network?: NetworkPolicy;
  /** 可用的工具名白名单。默认全部。 */
  tools?: string[];
}

export interface RunBudget {
  maxTurns?: number;          // 默认 50
  maxToolCalls?: number;      // 默认 200
  maxTokens?: number;         // 默认 2_000_000
  maxWallClockMs?: number;    // 默认 300_000（CI 保险）
}

export interface RunInput {
  /** 用户消息 */
  message: string;
  /** 附件（对应 renderer 的 attachment 路径） */
  attachments?: RunAttachment[];
  /** 工作区初始文件（fixture 落盘用） */
  seedFiles?: Record<string, string>;
}
```

### 3.2 生命周期与句柄

```typescript
// packages/agent-protocol/src/run.ts

export interface RunHandle {
  readonly runId: string;
  readonly sessionId: string;

  /** 事件流 —— 唯一的状态传播方式，Harness 不轮询 */
  events(): AsyncIterable<RunEvent>;

  /** 请求权限。返回决策后 run 继续。 */
  respondToPermission(requestId: string, decision: PermissionDecision): Promise<void>;

  /** 主动取消 —— 必须幂等 */
  cancel(reason?: CancelReason): Promise<void>;

  /** 在指定事件边界暂停（便于确定性断言） */
  pause(at?: PausePoint): Promise<void>;

  /** 最终结果。run 结束后 resolve。 */
  result(): Promise<RunResult>;
}

export interface AgentRuntimeApi {
  start(request: RunRequest): Promise<RunHandle>;
  /** 恢复一个已存在的 session（见 §5） */
  resume(sessionId: string, request: ResumeRequest): Promise<RunHandle>;
  /** 能力探测 —— 比版本协商更稳（grok-build `--capabilities` 模式） */
  capabilities(): Promise<RuntimeCapabilities>;
}
```

### 3.3 事件模型

```typescript
// packages/agent-protocol/src/events.ts

export type RunEvent =
  | RunStarted
  | TurnStarted
  | AssistantMessageDelta      // 流式文本
  | ToolCallStarted            // ★ ToolEvent
  | ToolCallProgress
  | ToolCallCompleted          // ★ ToolEvent
  | ToolCallFailed             // ★ ToolEvent
  | PermissionRequested        // ★ 需外部响应
  | PermissionResolved
  | ContextCompacted
  | SubagentStarted
  | SubagentCompleted
  | TurnCompleted
  | RunCompleted
  | RunFailed
  | Diagnostic;                // trace / 日志

/** 所有事件共享的信封 —— trace 从协议层就内建（codex W3cTraceContext 的做法） */
export interface RunEventEnvelope<T extends RunEvent = RunEvent> {
  runId: string;
  sessionId: string;
  seq: number;                 // 严格单调递增 —— Harness 断言顺序用
  timestamp: number;
  traceId: string;
  spanId?: string;
  payload: T;
}
```

**关键设计决策**：

| 决策 | 理由 |
|---|---|
| `seq` 严格单调 | Harness 的轨迹断言需要确定性顺序；`deterministic: true` 时可完全复现 |
| `traceId`/`spanId` 内建 | codex 在 RPC envelope 上带 `W3cTraceContext`（`rpc.rs:55`）。**trace 不应是事后补丁** |
| Tool 事件三态分离 | `Started`/`Progress`/`Completed`/`Failed` —— 现有 `tool_result` 的 `is_error` 曾恒为 false（plan 428 契约 1）。协议层必须能表达失败 |
| `Diagnostic` 通道独立 | 不污染业务事件流；Harness 的 evaluator 消费它，产品 UI 可以忽略 |

### 3.4 ToolEvent 与可断言性

```typescript
export interface ToolCallStarted {
  toolCallId: string;
  toolName: string;
  arguments: unknown;
  /** 来自 Tool.annotations —— 让 evaluator 断言"是否用了危险工具" */
  annotations?: { readOnly?: boolean; destructive?: boolean; openWorld?: boolean };
  attempt: number;            // 重试计数（codex/plan 428 的工具失败恢复）
}

export interface ToolCallCompleted {
  toolCallId: string;
  result: unknown;
  durationMs: number;
  isError: boolean;           // ★ 协议层强制，堵住 plan 428 契约 1 的洞
  errorClass?: ErrorClass;    // 供 evaluator 分类统计
}
```

> `isError` 放在**协议的 completed 事件**里，而不是依赖下游 adapter 正确传递 ——
> 这正是 plan 428 发现"1666 个 tool_result 中结构化 `is_error` 0 次为 true"的结构性原因。

### 3.5 权限请求 / 响应

```typescript
export interface PermissionRequested {
  requestId: string;
  kind: 'read' | 'write' | 'execute' | 'network' | 'mcp' | 'computer-use';
  target: string;             // 路径 / 命令 / host
  rationale?: string;
  toolAnnotations?: ToolAnnotations;
  /** 决策截止时间。Harness 必须在此之前响应，否则视为 deny。 */
  expiresAt: number;
}

export type PermissionDecision =
  | { action: 'allow' }
  | { action: 'allow-always'; scope: PermissionScope }
  | { action: 'deny'; reason?: string }
  | { action: 'defer' };      // 交回上层（如 AskUserQuestionTool）

/** Evaluator 断言：run 是否请求了不该请求的权限 */
export interface PermissionAuditEntry {
  requestId: string;
  kind: PermissionRequested['kind'];
  target: string;
  decision: PermissionDecision['action'];
  /** 自动策略（PermissionMode）还是显式响应 */
  source: 'policy' | 'host' | 'default';
}
```

**Harness 默认使用 `PermissionMode`**（`AGENTS.md` 提到 plan 224 的三层正交），
并可选开启"**全部显式响应**"模式 —— 后者能测出"策略层本该拦截却没拦截"的漏洞
（plan 428 契约 3：apply_patch 曾绕过权限体系恒放行）。

### 3.6 结果

```typescript
export interface RunResult {
  runId: string;
  sessionId: string;
  status: 'completed' | 'failed' | 'cancelled' | 'budget-exhausted';
  stopReason?: StopReason;
  finalMessage?: string;
  metrics: RunMetrics;        // 见 §3.7
  /** 完整事件轨迹 —— evaluator 的输入 */
  trace: RunEventEnvelope[];
  /** 权限审计 */
  permissionAudit: PermissionAuditEntry[];
  /** 预算消耗 */
  budgetUsed: Required<RunBudget>;
  error?: { class: ErrorClass; message: string; stack?: string };
}

export interface RunMetrics {
  turns: number;
  toolCalls: number;
  toolCallsByName: Record<string, number>;
  toolErrors: number;
  retries: number;
  inputTokens: number;
  outputTokens: number;
  cachedTokens?: number;
  wallClockMs: number;
  compactions: number;
  subagentRuns: number;
  /** 每个工具的 p50/p95 —— 性能回归检测 */
  toolLatencyMs?: Record<string, { p50: number; p95: number }>;
}
```

---

## 4. Evaluator 设计

Evaluator 是 Harness 区别于"integration test"的地方。参考 codex 的教训：
**"integration tests" 不是 harness**（codex 没有 evaluator、没有跨 run 比较）。

```typescript
// harness/agent/evaluators/types.ts

export interface Evaluator {
  name: string;
  /** 纯函数：输入轨迹，输出判定。不允许有 IO。 */
  evaluate(ctx: EvalContext): Promise<EvalResult>;
}

export interface EvalContext {
  result: RunResult;
  workspace: string;          // 用于检查文件产出
  task: TaskDefinition;
}

export type EvalResult =
  | { pass: true; assertions: Assertion[] }
  | { pass: false; assertions: Assertion[]; reason: string };

export interface Assertion {
  kind: 'trajectory' | 'outcome' | 'cost' | 'policy' | 'no-error';
  description: string;
  expected: unknown;
  actual: unknown;
  passed: boolean;
}
```

**四种内建 evaluator**：

| evaluator | 断言内容 | 对应真实缺陷 |
|---|---|---|
| `trajectory` | 工具调用序列、参数、次数 | 工具选择错误、无效重试（plan 10 的 CLI 17 分钟失败） |
| `outcome` | 工作区文件内容、DB 状态 | 任务未真正完成 |
| `cost` | token / 时延 / 重试 / 压缩次数 | 成本回归、压缩失效 |
| `policy` | 权限审计：是否请求越权、失败工具是否被正确标记 | plan 428 契约 1/3 |

**跨 run 比较**（codex 明确缺失的能力）：`reports/history/` 保存每次 run 的
`RunResult.metrics` + assertion 摘要，支持 diff 与阈值告警。

---

## 5. 取消 / 恢复 / 确定性

### 5.1 取消

```typescript
export type CancelReason =
  | 'user' | 'budget' | 'tool-error' | 'permission-denied' | 'harness-abort' | 'shutdown';
```

要求：
- **幂等** —— 多次 `cancel()` 等价于一次
- **协作式** —— 通过 `AbortSignal` 传播到 tool 执行、provider 请求、子进程
- **有终态** —— 取消后必然产生 `RunCompleted` 或 `RunFailed`，不产生悬挂

子进程场景：grok-build 用 `xai_tty_utils::ProcessScope` 保证子进程不存活超过 session
（其 `clippy.toml` **禁止**裸 `Command::spawn`）。Duya 应对齐 —— 见交付物 4/5 的 ProcessScope 规则。

### 5.2 恢复

```typescript
export interface ResumeRequest {
  runId: string;              // 原 run
  /** 从哪个事件边界继续 */
  from: { kind: 'turn-boundary'; turnIndex: number }
       | { kind: 'event-seq'; seq: number }
       | { kind: 'fork'; atMessageIndex: number };
  /** 恢复后追加的输入（例如用户补充说明） */
  additionalInput?: RunInput;
}

export interface RuntimeCapabilities {
  protocolVersion: string;
  agents: string[];              // 可用 AgentProfile
  modes: string[];               // 可用 ModeId
  tools: string[];               // 注册的工具全集
  supportsResume: boolean;
  supportsPause: boolean;
  supportsTraceExport: boolean;
}
```

> `capabilities()` 优于版本协商（grok-build 的 `--capabilities` 模式）：
> 老二进制对未知 flag 大声失败，比静默的 semver 协商更安全。
> Desktop / CLI / Harness / Cloud 四类 host 独立部署时尤其重要。

### 5.3 确定性

`deterministic: true` 时必须固定：
- 时间戳（单调递增的虚拟时钟）
- 随机 ID（sessionId / toolCallId / runId 用可预测种子）
- 并发顺序（tool 调用串行化或显式排序）
- provider 响应（由 mock corpus 按请求指纹决定）

`RunEventEnvelope.seq` 在两种模式下都必须严格单调 —— 这是 evaluator 断言顺序的前提。

---

## 6. 从参考仓库借来的具体机制

| 机制 | 来源 | Duya 的实现 |
|---|---|---|
| **wire-level mock provider** | grok `MockInferenceServer`（`127.0.0.1:0`，8 endpoint，三种 byte-exact SSE 格式，按请求指纹重放） | `harness/mock-provider/`。**mock 打在网络边界，不打在 `LLMProvider` interface** |
| **测试环境隔离** | grok `TestSandbox`（独立 temp root、`env_clear()` + allowlist、隔离 `HOME`/`TMPDIR`） | `RunContext.env` 白名单 + 临时 `dataDir` |
| **具名逃生舱** | codex `codex_app_server_client::legacy_core`（"临时嵌入式启动缺口应放在这里"） | `agent-protocol` 上开正式能力优先；确实需要时开 `runtime/internal-harness` 具名模块 |
| **trace 内建于协议** | codex `W3cTraceContext` on every RPC request（`rpc.rs:55`） | `RunEventEnvelope.traceId/spanId` |
| **单一生成的方法目录 + round-trip 测试** | grok `define_methods!`（37 方法，生成 enum + serde + 双向转换 + `ALL`，测试全量 round-trip） | protocol 的 `RunEvent.type` / `PermissionKind` 用同源生成，测试断言全集闭合 |
| **可重试性是 wire code** | grok `TURN_ACTIVE` const + `is_turn_active()`，客户端不依赖服务端 error enum | `ErrorClass` 定义在 protocol，host 侧可独立分类 |
| **harness README 与 src 同 PR** | grok `xai-grok-test-support` README 明写"reviewer 应把只有 src diff 的 PR 视为不完整" | `harness/agent/README.md` |
| **config 优先级 fail-closed** | grok `sandbox/profiles.rs:113-118`（项目内配置只能新增 profile，不能重定义） | 仓库内 `AGENTS.md` / settings 不能削弱用户级安全配置 |

---

## 7. 四个 consumer 的对等性验证

| consumer | 如何启动 run | 依赖 protocol | 依赖 runtime 内部 |
|---|---|---|---|
| **Desktop** | `AgentProcessPool` → 子进程 HTTP+SSE | ✅ | ❌（迁移后） |
| **CLI** | `packages/cli` 进程内 | ✅ | ❌ |
| **Harness** | 三种 runner（进程内/子进程/HTTP） | ✅ | ❌ |
| **Bot / Cloud** | `electron/agents/server` HTTP+SSE | ✅ | ❌ |

**验收标准**：把 Desktop 的 chat 面板换成 Harness 驱动，行为差异应**只**体现在 UI 上。
若 Harness 需要 import `packages/agent/src/tool/*` 才能跑起来，说明边界没守住。

---

## 8. 与现有机制的衔接（不重复造轮子）

| 已有机制 | Harness 如何复用 |
|---|---|
| `ModeModifier` / `applyModes`（plan 224） | `RunRequest.mode` 直接映射，不新增 mode 概念 |
| `AgentProfile` | `RunRequest.agent` |
| `PermissionMode` | `RunContext` 的权限策略来源（`source: 'policy'`） |
| `AgentProcessPool` | `subprocess-runner` 复用，不新建进程管理 |
| `electron/agents/server` HTTP+SSE | `http-runner` 复用，验证"同一 runtime 多 host" |
| `packages/ai` provider layer | mock 注入点在此层之下（网络边界） |
| `SSEEvent`（现定义于 `@duya/ai`） | **迁移**到 `agent-protocol`，`@duya/ai` 反向依赖它 |

---

## 9. 落地顺序（Harness 部分的最小路径）

| 阶段 | 交付 | 前置 |
|---|---|---|
| H1 | `agent-protocol` 包 + `RunEvent` 闭合性测试 | 无（可立即开始） |
| H2 | `AgentRuntimeApi` 在 `agent-runtime` 中实现，`local-runner` 可跑通单次 run | H1 |
| H3 | `mock-provider`（wire-level）+ 3 个 smoke task | H2 |
| H4 | `subprocess-runner` / `http-runner`，证明三个 runner 行为一致 | H2, H3 |
| H5 | 4 个 evaluator + `reports/` 历史与跨 run 比较 | H3 |
| H6 | 取消/恢复/确定性开关全覆盖 | H2 |
| H7 | 接入 CI（PR 上跑 smoke 套件） | H4, H5 |

**H1–H3 不需要任何目录搬迁**，可以在 `packages/agent` 内部先跑通，
验证协议设计是否足够，再执行交付物 5/5 的物理拆分。**这是降低返工风险的关键。**
