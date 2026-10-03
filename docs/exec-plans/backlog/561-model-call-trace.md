# 561 — 模型调用轨迹（Model Call Trace）：统一落盘路径 + ZCode 内容对齐

> **Status**: Planning · **Priority**: P0 · **Owner**: TBD
> **立项**: 2026-09-21（复盘：duya 的 rollout 记的是「会话时间线」，ZCode 的 model-io 记的是「请求线」。前者回答"这次会话发生了什么"，后者回答"这一次 HTTP 请求到底发了什么"——duya 完全缺失后者，且已有 4 处手工补丁在替代它）
> **前置基座**: 326（MessageLog 两层存储）、441（event journal + rebase）、333（rollout 过程事件）、493/506（旋转归档 + 可移植）
> **分界**: 444/533/546 管**用量与 ring 的正确性**；本 plan 管**每次调用的可观测性**，并把它们的读取路径收编到同一份数据上。

---

## 0. 一句话目标

把「每一次 LLM 调用」变成 rollout JSONL 里的一等行：与消息、压缩、rebase **同文件、同索引、同轮转**；`visible` 属性区分「回灌给模型的」与「只供审计的」；duya 目前缺失的 ZCode 字段以 `availability: 'not-recorded'` **显式占位并 hidden 呈现**，不静默省略。

---

## 1. 背景与差距

### 1.1 与 ZCode model-io 的字段差距（逐文件核实）

| ZCode 记录项 | duya 现状 | 目标 Phase |
|---|---|---|
| 调用边界 `requestId / attempt / turnId / traceId` | ❌ 无。`token_usage` 是 **turn 累积**（`agent-process-entry.ts:336` 注释明说 "sums EVERY LLM call of the turn"） | 3 |
| 每次调用的 model / providerId | ⚠️ 只在最终 assistant 消息上挂一份 | 3 |
| 每次调用 `startedAt / completedAt / durationMs` | ⚠️ 只有 turn 级 `duration_ms` | 3 |
| per-call usage（input/output/**cacheRead/cacheWrite/reasoning**） | ❌ 累积值 + 一个寄生的 `last_call` 子块 | 3 |
| `error{name,message,stack}` | ❌ 无结构化错误 | 3 |
| response：`finishReason / reasoningText / toolCalls / responseId` | ⚠️ text + thinking 进消息，其余丢弃 | 3 |
| **system prompt 终态** | ❌ **不落盘**。终态是 `opts.systemPrompt`，且 `api/anthropic-messages.ts:1495` 是 `if (msg.role === 'system') continue;`。落盘的 `chat_sessions.system_prompt` 只是**配置值** | 4 |
| tools 名单 / 定义 | ⚠️ 只在 wire payload 里，无落盘 | 4 |
| 最终 HTTP body / headers / providerMetadata | ❌ | 4 |
| 后台调用统一入流 | ❌ 8 个创建点全部旁路 | 2 |
| 请求侧 delta 压缩 | ❌（ZCode 靠 delta/tail/五点指纹把长 session 压住） | 4 |

### 1.2 duya 已有的四处「半成品」（本 plan 统一清掉）

| 位置 | 现状 | 处置 |
|---|---|---|
| `packages/agent/src/observability/cache-monitor.ts` | 每次调用都算 `cacheHitRate` + `cacheBreakReason`（model/system/tool/provider change），**纯内存 LRU 512，不落盘** | 3：observation 变成 call 行的子结构；5：收编 |
| `token_usage.last_call`（plan 533/546） | 单次调用子块寄生在最后一条 assistant 消息上，无调用边界 | 3：call 行成为权威；5：ring 改读 call 行 |
| `agent-process-entry.ts` 的 `RING_TRACE_FILE`（`context-ring.log`） | `appendFileSync` 绕开 logger 的临时调试文件，注释自带 "Remove once ring behavior is verified" | 5：删除 |
| `api/anthropic-messages.ts:1968` `console.warn('[duya-ai] anthropic request system prompt', { length, hasMemorySection, preview })` | 手工确认 system 有没有被静默丢弃 | 4：删除，由 call 行的 systemPrompt 终态取代 |

**结论**：四处补丁的成因是同一个——「每次调用」是可观测性的最小单位，但 duya 没有它的持久化载体。

### 1.3 必须先修的路径分歧：RolloutEvent 有两份权威定义，且已分叉

| 位置 | 内容 |
|---|---|
| 存储侧（自称权威）`electron/db/core/rollout-events.ts` | `reasoning \| tool_call \| turn_started \| system_context \| rebase \| rotation` |
| agent 侧镜像 `packages/agent/src/journal/types.ts` | `rebase \| hook_invoked` |

后果：`hook_invoked` 被 agent 定义、可经 `journal:emit` 发出，但存储侧 `isRolloutEvent()` 不认它 → `deriveKind()` 落到 `payload.message.role`（`message-log.ts:2297`）**抛异常** → `db-bridge` 只回 `{success:false, reason:'transaction_failed'}`。

当前未爆，是因为 `Journal.hookInvoked()` **没有生产调用者**：`DuyaAgent.ts:943` 的 `onHookInvoked` 只推 SSE + `buildHookMessage` 消息行，从未接 journal。即 hook 事件今天有**三套并行表示**（SSE 事件 / 消息行 / 死掉的 rollout 事件）。

**统一决定**：`MessageEntry` / `CompactionEntry` 的权威定义本来就在 `@duya/agent/message`（`message-log.ts:33` 就是这么 import 的），所以把 `RolloutEvent` 一并搬过去（与 `ModelChangeEntry` / `BranchEntry` 同处），`electron/db/core/rollout-events.ts` 退化为 re-export + guards，`journal/types.ts` 的镜像删除。**并加一条 union 覆盖单测**：agent 侧能发出的每种 `type`，存储侧 `isRolloutEvent()` 必须为真。这类分叉以后在测试期就挡掉——否则本 plan 新增的 `model_call` 会踩同一个坑。

---

## 2. 设计

### 2.1 一条流：所有调用经同一收口（对齐 ZCode「全进一条流」）

- `@duya/ai` 新增 `ModelCallTap`（纯接口 + 模块级注册）：`setModelCallTap(tap | null)`；`createAIClient`（`index.ts:248`）与 `createAIClientWithRetry`（`retry-client.ts`）在入口包一层 recorder。
- **为什么这样就够**：全仓只有 8 个 client 创建点，全部经这两个工厂（已核实无例外），因此 **8 个调用点一行都不用改**：

  | 用途 | 位置 |
  |---|---|
  | 主链路 | `packages/agent/src/agent/DuyaAgent.ts:580/586` |
  | 压缩专用模型 | `DuyaAgent.ts:4578` `buildCompactClient` |
  | 标题生成 | `packages/agent/src/process/agent-process-entry.ts:3297` |
  | 视觉分析 | `packages/agent/src/agent/visual-analysis.ts:39` |
  | 会话语义检索 | `packages/agent/src/tool/SessionSearchTool/SessionSearchTool.ts:848` |
  | 记忆抽取 | `electron/main.ts:758` |
  | RAG embedding | `electron/memory/rag_embedding_client.ts:47` |

- 分类（对齐 ZCode `querySource`）：
  - 静态：`AIClientOptions.callOrigin`（`main | compact | title | vision | session_search | memory | embedding`）——创建 client 时定。
  - 动态：每次调用的 `options.trace = { sessionId, turnId, callSource, querySource }`——必须放在**调用参数**而不是 client options，因为 `electron/main.ts` 的记忆 worker 是长驻 client 跨 session 复用（plan 533 的 `cumulativeTokenUsageRef` 已经是"per-call 上下文走 options"的先例）。
- 落盘旁路：tap 实现**不写文件**，走既有 `messageDb.emit()` → `journal:emit` → `MessageLog.appendBatch`。`db-bridge.ts:998` 已经是通用的「带 `type` 判别的 typed event 写入本 session rollout」通道，`rebase` / `hook_invoked` 是它的先例——本 plan 不新建通道、不新建文件。
- 子进程边界：agent 在自己的进程里装 tap，写自己 session 的 rollout（与现有 subagent transcript 落盘一致）；call 行带 `parentSessionId`，UI 侧聚合。

### 2.2 一个文件 + `visible` 属性

- 新 rollout 行 `ModelCallEntry`（`type: 'model_call'`），加入 `RolloutLine` union。
- **`visible` 提升为所有 rollout 行的一等字段**（不只新行）：

  | 行类型 | 语义 |
  |---|---|
  | `message` | `true`（进 `project()` 投影） |
  | `compaction` | `true`（摘要会进投影） |
  | `model_call` / `turn_started` / `reasoning` / `system_context` / `rotation` / `rebase` | `false`（审计行） |

  - 过去「是否投影」是读侧靠 `isRolloutEvent()` **硬编码判断的隐式知识**；现在成为数据自描述字段。收益正是需求原文要的：**日志与回灌数据同文件共存**——`timeline()` 取全部（含 `visible:false` 的日志），`project()` 只取 `visible:true` 的回灌集。
  - 写侧归一：在 `MessageLog.appendBatch` 落盘前补 `visible`（缺失时按类型派生），**单一落点覆盖全部 producer**，不要求每个写入方改造。
  - 老文件兼容：无该字段 → 读侧 `visible ?? deriveVisibility(type)` 兜底。不迁移、不改老文件。
  - **重要语义边界**：落盘的 `visible` 是**写入期种子**。消息行仍可能被后续 `rebase` 取代 → 读侧 `applyRebases` 把被取代的行翻成 `visible:false` 并附 `supersededBy`。渲染端拿到的永远是「当前生效」值，而不是写入期快照。

- **ZCode 差距的显式占位**（需求「duya 比 ZCode 差的内容 hidden 标注即可」的直接落地）：
  ```ts
  availability: Record<ModelCallField, 'recorded' | 'redacted' | 'truncated' | 'not-recorded'>
  ```
  - Phase 3 完成的字段 = `recorded`；Phase 4 之前 `systemPrompt` / `requestBody` / `headers` / `tools` = `not-recorded` → 渲染端**一律 hidden 呈现（灰行 + 原因），不假装有**。
  - Phase 4 填上后该字段自动翻为 `recorded`，**渲染代码一行不改**。
  - 字段全集 = §1.1 的 ZCode 清单，作为 `MODEL_CALL_FIELD_PARITY` 常量冻结（Phase 0），配单测断言每个 key 都有 availability 值——清单本身成为可执行的门禁。

- 索引与检索：`message_index.kind` 加 `model_call`；`extractSearchableText` 对新行返回 `''`（`message-log.ts:2305` 对 rollout event 已是这个姿态），避免工具内部与调用元数据污染会话搜索；导入校验（`message-log.ts:2555` 的 `unknown rollout line type`）与 `validateImportLines` 必须放行新类型。

### 2.3 体积：请求侧 delta + tail（照搬 ZCode 已验证形态）

- 同 session 相邻调用的 messages 高度重合 → `messagesKind: 'delta' | 'tail' | 'full'` + `messageOffset` + `messageCount`，读侧 `expandModelCallDelta()` 还原。
- delta 可用性校验用**五点指纹**（首 / 25% / 50% / 75% / 尾），避免为判定把整段历史 `stringify`。
- 进程内 compaction-state 缓存以**文件路径**为键（ZCode `modelIOCompactionStates` 的形态），避免 append 前重读整个 JSONL；文件超限时重置为 bounded baseline（`MAX_CALL_BASELINE_MESSAGES`）。
- **三态开关**让「默认安全」与「排障全量」共存：
  | 值 | 记录内容 |
  |---|---|
  | `off` | 不记录（等价今天） |
  | `metadata`（默认） | 调用边界 + 模型 + 用时 + per-call usage + 错误。**不记 payload** |
  | `full` | 追加 systemPrompt 终态 / tools / request body / response 全文，走 delta 压缩 |
- 复用既有配额：同一文件天然继承 493/506 的 `rotateArchive`（非 bot 4MB 阈值）+ `scan()` 对账 + 导出/导入。

### 2.4 消费端收编（不新增第二份真相）

- ring / context 估算：`last_call` 继续写（保 plan 533/546 读取路径不断），但 `normalizePromptTokens` 改为**优先读最近一条 call 行**。
- `cache-waste.ts`（`electron/ipc/cache-waste.ts`）与 `usage-aggregator.ts`：从「扫 messages 反推」改为「读 call 行聚合」——它们今天能算的东西正是 call 行的直接投影，反推是精度损失的来源。

### 2.5 渲染端

- 侧边栏新面板：`src/components/layout/panels/registry.ts` 加 `PageId: "trace"`（对齐 `CodeReviewPanel` 的 lazy 注册 + `PanelZone` 传 session 上下文），三处同步：`registry.ts` ↔ `preload.ts` ↔ `src/lib/*-ipc.ts`。
- 每行按 `visible` 分两组：**回灌（visible:true）** / **审计（visible:false）**。
- `visible:false` 组内按 `availability` 四态渲染：`recorded` 正常 / `redacted` 显示锁 / `truncated` 显示截断 / `not-recorded` 显示「未记录（duya 尚未采集）」。
- 入口：会话头部菜单 + 消息右键菜单（对齐 workspace 现有入口习惯）。
- 复用 UI 套件与设计 token（`Button` / `Badge` / `bg-chip` / `text-foreground-subtle`），不引入新组件库。

---

## 3. 分阶段实施

### Phase 0 — 契约冻结
- [ ] `MODEL_CALL_FIELD_PARITY`（§1.1 清单 → 字段全集）+ `availability` 枚举 + `callOrigin` 枚举，落在 `@duya/ai` 的可导入常量
- [ ] 冻结 `visible` 语义表（§2.2）+ `model_call` 行 schema（含 delta 元数据字段名）
- [ ] 单测：parity 清单每个 key 必须出现在 `availability` 类型里（缺一个即编译/测试失败）

### Phase 1 — 统一 rollout 事件权威定义（先修分歧，再加新行）
- [ ] `RolloutEvent` 权威定义迁到 `@duya/agent/message`（与 `MessageEntry`/`CompactionEntry`/`ModelChangeEntry` 同处）；`electron/db/core/rollout-events.ts` 退化为 re-export + `isRolloutEvent`/`rolloutLineTimestamp` 等 guards
- [ ] 删除 `packages/agent/src/journal/types.ts` 的重复 union；补 `hook_invoked`（修掉 `deriveKind` 抛异常的隐患）
- [ ] 统一决定 `Journal.hookInvoked()` 的去留：接线（并修正 3 套并行表示）或删除（当前是死代码）——二选一必须留注释说明
- [ ] 新增 union 覆盖单测：agent 侧每种 event type → 存储侧 `isRolloutEvent` 必须为真
- [ ] 回归：`electron/db/core/__tests__`（rollout-events / apply-rebases / message-log）+ `packages/agent/src/journal` 全绿

### Phase 2 — `@duya/ai` 侧收口（一条流地基）
- [ ] `ModelCallTap` 接口 + `setModelCallTap`；`createAIClient` / `createAIClientWithRetry` 内插桩（覆盖 8 个创建点，不改调用点）
- [ ] `AIClientOptions.callOrigin` + `streamChat/chat` 的 `options.trace`（per-call 上下文，长驻 client 安全）
- [ ] tap 记录器：边界 + attempt + 模型 + 用时 + per-call usage + 结构化错误（`metadata` 档的全部字段）
- [ ] 单测：tap 被调次数 = 调用次数（含 `withRetry` 的每次 attempt）；未装 tap 时**零行为变化**、零开销路径
- [ ] `@duya/ai` 不新增对 session/DB/fs 的依赖（分层红线，用接口反转）

### Phase 3 — 落盘：同文件 + 索引 + 可见性
- [ ] `ModelCallEntry` + 加入 `RolloutLine`；`EventKind` 加 `model_call`
- [ ] `appendBatch` 落盘前归一补 `visible`（单一落点）；`deriveVisibility(type)` + 老文件兜底
- [ ] `availability` 初始化为 `not-recorded` 占位（Phase 4 的字段留在清单里，不省略）
- [ ] tap → `messageDb.emit()` → `journal:emit` 接线（复用既有通用通道，`db-bridge.ts:998`）
- [ ] 索引/导入/轮转兼容：`message_index.kind`、`validateImportLines` 放行新类型、`extractSearchableText` 返回 `''`、`scan()` 对账不误判 orphan
- [ ] 读取 IPC `db:rollout:calls`（sessionId + limit + 尾读），返回行 + 生效 `visible` + `availability`
- [ ] 单测：落盘/回读往返；`project()` 不因新行漂移（**回归红线**：投影结果与今天逐字一致）；rebase 后 `visible` 翻转；导入导出往返；多分代文件读取

### Phase 4 — payload 终态（ZCode 的 `request/response` 全量）
- [ ] 在 `packages/ai/src/api/*.ts` 构造最终 params 处 dump（system prompt 终态 / tools / body / headers）——**必须在 api 层**，因为 `applyCacheControlToSystem` 与 family wrapper 都在那一层改写 payload，`createAIClient` 层拿到的不是终态
- [ ] 脱敏边界：复用既有 redaction（provider key / Authorization / JWT / ticket），**单一收口**，不可分散到各 provider
- [ ] delta / tail / full + 五点指纹 + 进程内 compaction-state 缓存（§2.3）
- [ ] 删除 `api/anthropic-messages.ts:1968` 的 `console.warn` 临时诊断
- [ ] `availability` 对应字段翻 `recorded` / `redacted` / `truncated`
- [ ] 单测：delta 还原正确性（含 `tail` 不得回拼更早历史）；五点指纹误判 case；脱敏后不含密钥；`full` 档体积上限

### Phase 5 — 消费端收编 + 清半成品
- [ ] `normalizePromptTokens` 优先读 call 行；`last_call` 保留为回退（不破坏 533/546）
- [ ] `cache-monitor.ts` 的 observation 落进 call 行（内存 LRU 保留为热路径缓存）
- [ ] `cache-waste.ts` / `usage-aggregator.ts` 改读 call 行聚合
- [ ] 删除 `RING_TRACE_FILE` / `context-ring.log` 写路径
- [ ] 单测：ring 数值与今天一致（回归）；usage 聚合数值与今天一致

### Phase 6 — 渲染端
- [ ] `PageId: "trace"` 注册 + 面板组件（lazy）+ `PanelZone` 接线
- [ ] `visible` 双分组 + `availability` 四态呈现 + 调用卡片头（模型 / 用时 / IN-OUT / finishReason / 错误）
- [ ] 入口：会话头部菜单 + 消息右键
- [ ] Playwright 手动验证（AGENTS.md 门禁：UI 改动必须实测）

### Phase 7 — 验证与对齐审计
- [ ] `npm run typecheck:all` 通过
- [ ] 手动 Electron 全链路：主链路 + 标题生成 + 记忆抽取 + 压缩 四类调用在同一文件可见，且分类标签正确
- [ ] 按 `MODEL_CALL_FIELD_PARITY` 逐项核对：`recorded` 项可查、`not-recorded` 项在 UI 上明确标注（**这是需求「差的内容 hidden 标注」的验收口径**）
- [ ] `npm run electron:build`（涉及 `packages/ai` 分层边界变更）
- [ ] README 计划状态更新；ARCHITECTURE.md 增补「rollout 行类型 + 可见性」小节

---

## 4. 非目标

- 不做跨 session 的全局调用检索/分析面板（先保证单 session 一条流；聚合留后续）。
- 不做实时流式 token 级 trace（只在调用边界记录，不逐 SSE 帧落盘）。
- 不重构 plan 533/546 确立的 ring 数学与 `cumulativeTokenUsageRef`，只换读取来源。
- 不改 `chat_sessions.system_prompt` 的语义（仍配置值），组装后终态只进 call 行。
- 不做自动上传/遥测（与 ZCode 的 telemetry 无关；这是本地诊断数据）。
- 不把 `model_call` 行纳入会话搜索或 LLM 投影。

## 5. 风险

- **投影回归（最高）**：新行进入 `RolloutLine` 后，`project()` / `applyRebases()` / `rebase` 的 `supersededUpToSeq` 语义都可能被无意影响。门禁：Phase 3 加一条「投影结果与今天逐字一致」的对照测试（同输入 → 同输出），并在 Phase 1 就把 `deriveKind` 的兜底路径改成显式报错而非落到 `payload.message.role`。
- **体积失控**：`full` 档在长 session 上会显著放大文件。门禁：默认 `metadata`；delta + five-point fingerprint；`MAX_CALL_BASELINE_MESSAGES` 重置；沿用 4MB 旋转阈值。
- **密钥落盘**：request body / headers 含 JWT、Coding Plan key、ticket。门禁：脱敏在**单一收口**且先于 append；单测断言产出串不含密钥模式；`redacted` 在 `availability` 上可见。
- **分层污染**：`@duya/ai` 必须不知道 session/DB/fs。门禁：接口反转（tap 由装配层注入），`@duya/ai` 的 import 白名单审查。
- **双写路径漂移**：`last_call`（旧）与 call 行（新）并存期可能给出不同数。门禁：Phase 5 加一致性测试；并存期以 call 行为准并在注释中写明。
- **隐藏语义被误读**：`not-recorded` 若渲染成"空值"会被读成"模型没发 system prompt"。门禁：四态必须文案区分，`not-recorded` 明确写「未采集」。
- **回滚**：开关默认 `metadata`（不含 payload）；`off` 时行为与今天逐字一致；`model_call` 行对老读侧不可见（`isRolloutEvent` 返回 false 前必须先具备 Phase 1 的统一）。**回滚顺序必须与上线顺序相反**（先回滚读侧消费者，再回滚落盘）。

## 6. 为什么按这个顺序

需求三件事有硬依赖：**先统一事件定义（Phase 1）**才能安全加新行类型，否则 `model_call` 会重演 `hook_invoked` 的分叉；**先收口（Phase 2）**才能谈"一条流"，否则要把 8 个调用点各改一遍且以后新增调用点会漏；**先落盘与可见性（Phase 3）**才能让「差的内容 hidden 标注」有地方标注——`availability` 机制本身在 Phase 3 就位，Phase 4 只是把字段从 `not-recorded` 翻成 `recorded`，UI 无需二次改动。Phase 5 才允许删半成品，因为替代品必须先经过 Phase 3/4 的实测（否则就是拿没验证的新路径换掉在用的旧路径）。
