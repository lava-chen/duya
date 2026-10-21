# 多模型 API 推理能力适配架构

> 状态：DRAFT
> 日期：2026-07-29
> 范围：P0（核心）+ P1（增强）+ P2（扩展）
> 路线：参考 pi 项目的正交分离 + thinkingLevelMap + 三 signature 字段 + isSameModel 守卫，结合 Duya 现有基础设施（SSEEvent / ApiFormat / ProviderStore / messages 追加式存储）

## 1. 背景与问题

当前 Duya 的多模型适配存在以下问题（详见用户输入的调研报告）：

- **单一 `effort` 开关**：`'' | 'low' | 'medium' | 'high' | 'max'` 字符串，在 `anthropic-client.ts` 内硬编码 `BUDGET_BY_EFFORT` 映射，无法表达"模型默认开启/关闭"、"无法关闭"、"推理强度由 effort/level/budget 控制"等差异。
- **MiniMax 走 URL 改写**：`LLMClientWrapper` 把 baseURL 改成 `/anthropic` 或 `/v1`，但 OpenAI/Anthropic 两套接口的默认 thinking 行为相反（OpenAI 默认开，Anthropic 默认关），目前没有区分。
- **没有 capability registry**：靠 `isMiniMaxURL` / `isMiniMaxEndpoint` 域名正则做补丁式分支。
- **signature 不专门保存**：`handleThinkingBlocks` 在内存里保留 signature 用于当轮回传，但落库时只存到 content JSON 里，没有独立保护，压缩/摘要/编辑可能破坏。
- **流式事件直通**：SSE → `chat:thinking` / `chat:delta` 直接转发给 Renderer，没有统一语义事件层。
- **`<think>` 标签解析不健壮**：用流式缓冲 + 正则拆分，跨 chunk 不安全。
- **扩展字段无统一发送机制**：`enable_thinking` / `thinking_budget` / `reasoning_split` / `clear_thinking` 等字段没有标准发送路径，容易被通用白名单清洗误删。

## 2. 设计目标

- **正交分离**：协议实现层（api/）与服务商配置层（providers/）解耦，provider 文件极薄。
- **capability 驱动**：推理开关、强度、返回形式、续轮回传由 `Model` + `ModelCompat` 描述，不靠域名正则。
- **opaque state 保护**：Anthropic signature / OpenAI reasoning item / Gemini thought signature / reasoning_content 字段名 作为不可修改状态保存，不经过 Markdown 序列化、消息摘要、上下文压缩、文本去重、字符清洗、用户编辑。
- **最小侵入**：packages/ai 内部用 AssistantMessage 累积状态，但 yield 时降级为现有 SSEEvent，agent 包和前端零改动。
- **简洁第一**：不引入 routeId / KnownApi / DuyaReasoningSettings（P0 阶段）/ VisibleMessageRecord 等新概念，复用现有 ApiFormat + effort + messages 表。

## 3. 不可破坏的契约清单

重构必须保持以下契约不变（基于代码契约研究，70+ 条，此处列关键项）：

### 3.1 LLMClient 接口契约

| 契约 | 文件:行号 | 破坏后果 |
|---|---|---|
| `LLMClient.streamChat` 返回 `AsyncGenerator<SSEEvent, void, unknown>` | `packages/agent/src/llm/base.ts:11-33` | DuyaAgent 流式循环中断 |
| `streamChat` options 必须包含 `effort?: string` | `packages/agent/src/llm/base.ts:24` | effort 透传链断裂 |
| `streamChat` options 必须包含 `maxOutputTokens?: number` | `packages/agent/src/llm/base.ts:31` | MiniMax 输出上限失效 |
| `chat` 是可选方法 | `packages/agent/src/llm/base.ts:39-47` | 分类器/标题生成调用失败 |
| `LLMClientOptions` 字段：`apiKey`, `baseURL`, `model`, `authStyle?` | `packages/agent/src/llm/base.ts:50-55` | 所有客户端构造失败 |
| `LazyLLMClientProxy` 必须透明代理 | `packages/agent/src/llm/base.ts:67-121` | 延迟加载失效 |
| `LLMProvider` 类型为 `'anthropic' \| 'openai' \| 'ollama'` | `packages/agent/src/types.ts:248` | 工厂 switch 失效 |
| `createLLMClient` / `createRetryableLLMClient` 签名 | `packages/agent/src/llm/index.ts:77-127` | DuyaAgent 构造失败 |
| `inferProvider` 优先级 | `packages/agent/src/llm/index.ts:147-209` | provider 误判 |
| `isMiniMaxURL` 导出 | `packages/agent/src/llm/index.ts:65-68` | DuyaAgent 构造分支失效 |

**本设计的调整**：`streamChat` 的 return 值从 `void` 改为 `AssistantMessage`（`AsyncGenerator<SSEEvent, AssistantMessage, unknown>`）。这是唯一的新增契约，不影响现有 `for await` 循环（现有代码忽略 return 值）。

### 3.2 SSEEvent 事件类型契约

`SSEEvent` 的 17 个 type 字面量（`packages/agent/src/types.ts:207-224`）不可变更，包括：`text` / `thinking` / `text_delta` / `thinking_delta` / `tool_use_started` / `tool_use` / `tool_result` / `done` / `error` / `mode_changed` / `system` / `result` / `turn_start` / `permission_request` / `agent_progress` / `tool_progress` / `tool_timeout`。

`convertSSEToAgentMessage`（`agent-process-entry.ts:1127-1256`）的 type 映射不可变更。

### 3.3 Worker 事件契约

`chat:text` / `chat:thinking` / `chat:done` / `chat:error` / `chat:tool_use_started` / `chat:tool_use` / `chat:tool_result` / `chat:mode_changed` 的字段（`worker-protocol.ts:152-238`）不可变更。`ChatStartCommand.options.effort`（`worker-protocol.ts:74`）不可变更。

### 3.4 Provider 配置契约

`ApiFormat` 的 7 种值（`src/lib/providers/types.ts:31-38`）、`LlmProvider` 领域实体字段、`ProviderRuntimeConfig` 字段、`toRuntimeConfig` 函数签名、`buildHeaders` 按 apiFormat 构造认证头、`getActiveProviderRuntimeConfig` 返回值形状——均不可变更。

### 3.5 数据库 messages 表契约

- messages 表所有列名与类型（`electron/db/schema.ts:80-102`）不可变更，本设计只新增列。
- `status` 字段的 `'superseded'` / `'purged'` / `'done'` 语义不可变更。
- `INSERT OR IGNORE` 幂等写入不可变更。
- `role='tool'` 自动设 `msg_type='tool_result'`、`tool_call_id → parent_tool_call_id` 不可变更。
- `show_widget` 的 `tool_use` 识别为 `msg_type='viz'` 不可变更。
- 软删除（`truncateMessagesAfter` / `truncateMessagesFromInclusive`）不可变更。
- FTS5 触发器仅对 `msg_type IN ('text','tool_result')` 不可变更。

### 3.6 effort 透传契约

`ChatRequestBody.effort` → `ChatStartCommand.options.effort` → `ChatStartMessage.options.effort` → `ChatOptions.effort` → `LLMClient.streamChat options.effort` → `BUDGET_BY_EFFORT` 映射——整条链路的字段名和类型不可变更。

### 3.7 工具调用状态管理契约

`Tool` / `ToolUse` / `ToolResult` / `ToolExecutor` / `ToolRegistry` / `StreamingToolExecutor` / `ToolUseContext` 的字段和签名不可变更。`pendingExtraResult`（show_widget 视觉自审）、`resolveToolKey`（MCP 名字解析）、`PermissionRequiredError` 两阶段流程不可变更。

## 4. 总体架构

### 4.1 三层分离

```
┌─────────────────────────────────────────────────────────┐
│  用户设置层 (effort?: string, P1 引入 DuyaReasoningSettings) │
└───────────────────────┬─────────────────────────────────┘
                        │ capability resolver
┌───────────────────────▼─────────────────────────────────┐
│  packages/ai  协议实现层 (api/)                          │
│  ┌──────────────┐ ┌──────────────┐ ┌──────────────────┐ │
│  │ anthropic-   │ │ openai-      │ │ gemini-          │ │
│  │ messages.ts  │ │ completions  │ │ generative-ai.ts │ │
│  └──────────────┘ └──────────────┘ └──────────────────┘ │
│  每个 api 模块: buildParams() + streamSimple() +         │
│                convertMessages() + parseStream()         │
│  yield SSEEvent, return AssistantMessage                 │
└───────────────────────┬─────────────────────────────────┘
                        │ provider-native HTTP
┌───────────────────────▼─────────────────────────────────┐
│  packages/ai  服务商配置层 (providers/)                  │
│  minimax-openai.ts / minimax-anthropic.ts /             │
│  deepseek.ts / qwen.ts / glm.ts / anthropic.ts / ...    │
│  每个 provider 文件极薄: baseUrl + auth + models + api   │
└─────────────────────────────────────────────────────────┘
```

### 4.2 核心设计原则

- **不引入 routeId**：用 `(providerId, modelId)` + `model.api` 表达"MiniMax M3 走 Anthropic 协议"。MiniMax 拆成 `minimax-openai` 和 `minimax-anthropic` 两个 providerId。
- **复用 ApiFormat**：不新增 KnownApi 类型，packages/ai 直接接受 `ApiFormat`，避免两层映射。实际支持的协议子集：`'anthropic' | 'openai-chat' | 'openai-responses' | 'gemini'`。`'ollama' | 'bedrock' | 'vertex'` 走现有 packages/agent/src/llm 路径，不迁移。
- **保留 effort?: string**（P0）：P1 再引入 `DuyaReasoningSettings` 作为 effort 的超集（向后兼容）。
- **单一 AssistantMessage 存储**：不拆 VisibleMessageRecord + ProviderTurnRecord，opaque state 直接存进 content block 的 signature 字段。
- **thinkingLevelMap + null 语义**：替代显式的 `unsupported-always-on` / `unsupported-always-off` 三态。`thinkingLevelMap.off === null` 表示"无法关闭"；`thinkingLevelMap` 缺失 `off` key 表示"用 provider 默认"。
- **compat 标志位**：`forceAdaptiveThinking` / `openAIThinkingFormat` / `ignoredParameters` 等扁平标志位，比嵌套类型系统更简洁。
- **OpenAIThinkingFormat 精简到 5 种**：`openai-standard` / `reasoning-content` / `qwen-style` / `glm-style` / `think-tag-fallback`。

## 5. packages/ai 包结构

```
packages/ai/
├── package.json              # @duya/ai, workspace 包
├── tsconfig.json
├── src/
│   ├── types.ts              # 核心类型: ApiFormat, Model, AssistantMessage, SSEEvent (re-export)
│   ├── models.ts             # getSupportedThinkingLevels, clampThinkingLevel
│   ├── index.ts              # createAIClient factory
│   ├── api/                  # 协议实现层
│   │   ├── anthropic-messages.ts
│   │   ├── openai-completions.ts
│   │   ├── openai-responses.ts      # P1
│   │   ├── gemini-generative-ai.ts  # P2
│   │   ├── simple-options.ts        # 共享: buildBaseOptions, clampReasoning
│   │   ├── transform-messages.ts    # 跨供应商消息转换 + isSameModel 守卫
│   │   └── emit-sse.ts              # AssistantMessageEvent → SSEEvent 降级
│   ├── providers/            # 服务商配置层
│   │   ├── all.ts            # builtinProviders() 注册表
│   │   ├── anthropic.ts
│   │   ├── openai.ts
│   │   ├── minimax-openai.ts
│   │   ├── minimax-anthropic.ts
│   │   ├── deepseek.ts
│   │   ├── qwen.ts
│   │   ├── glm.ts
│   │   ├── kimi.ts
│   │   ├── openrouter.ts     # P2
│   │   ├── generic-openai.ts
│   │   └── generic-anthropic.ts
│   └── utils/
│       ├── event-stream.ts   # AssistantMessageEventStream (内部用)
│       ├── think-tag-parser.ts  # <think> 状态机 (仅 think-tag-fallback 启用)
│       └── diagnostics.ts    # ParameterDiagnostic (P1)
├── test/
│   ├── anthropic-thinking.test.ts
│   ├── minimax-dual-protocol.test.ts
│   ├── cross-provider-handoff.test.ts
│   ├── think-tag-parser.test.ts
│   └── openai-completions-reasoning.test.ts
└── dist/                     # tsc 输出, packages/agent 依赖
```

### 5.1 与现有代码的关系

- `packages/agent/src/llm/anthropic-client.ts` 和 `openai-client.ts` 的协议解析逻辑**迁移**到 `packages/ai/src/api/`。
- `packages/agent/src/llm/` 保留 `index.ts`（factory，委托 packages/ai）、`base.ts`（LazyLLMClientProxy）、`ollama-client.ts`（不迁移）。
- `packages/agent/src/llm/wrapper.ts`（LLMClientWrapper）**删除**，MiniMax URL 改写由 provider 配置的 baseUrl 承载。
- `packages/agent/src/llm/Retryable*.ts` 保留，包装 packages/ai 的 AIClient。
- `DuyaAgent.ts` 改为依赖 `@duya/ai` 的 `createAIClient()` 入口，约 10 行改动。

## 6. 核心类型系统

### 6.1 共享类型（从 packages/agent 迁移到 packages/ai）

为避免循环依赖，`SSEEvent`、`Message`、`ToolUse`、`ToolResult`、`TokenUsage` 等共享类型从 `packages/agent/src/types.ts` 迁移到 `packages/ai/src/types.ts`，packages/agent 反向 re-export：

```typescript
// packages/agent/src/types.ts 改造
export type { SSEEvent, Message, ToolUse, ToolResult, TokenUsage } from '@duya/ai';
```

依赖方向：`packages/agent` → `packages/ai` → （无下游依赖）。单向，无循环。

### 6.2 推理级别与 thinkingLevelMap

```typescript
// packages/ai/src/types.ts

export type ThinkingLevel = 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
export type ModelThinkingLevel = 'off' | ThinkingLevel;
// key = Duya 统一级别, value = provider 原生级别字符串, null = 不支持
export type ThinkingLevelMap = Partial<Record<ModelThinkingLevel, string | null>>;
```

`thinkingLevelMap` 语义：
- 缺失的 key 使用 provider 默认值。
- `null` 标记该级别不支持。
- 字符串值表示映射到 provider 原生的级别名。

### 6.3 OpenAI 兼容协议的 thinking 变体

```typescript
export type OpenAIThinkingFormat =
  | 'openai-standard'    // reasoning_effort (OpenAI / xAI / Mistral)
  | 'reasoning-content'  // delta.reasoning_content (DeepSeek / Kimi / GLM / SiliconFlow / MiniMax OpenAI)
  | 'qwen-style'         // enable_thinking + thinking_budget (DashScope)
  | 'glm-style'          // thinking.type + clear_thinking + tool_stream
  | 'think-tag-fallback'; // <think> 标签状态机 (generic preset 兜底)
```

### 6.4 Model 能力描述

```typescript
export interface Model<TApi extends ApiFormat = ApiFormat> {
  id: string;
  name: string;
  api: TApi;
  providerId: string;
  baseUrl: string;
  reasoning: boolean;
  thinkingLevelMap?: ThinkingLevelMap;
  input: ('text' | 'image')[];
  contextWindow: number;
  maxTokens: number;
  compat?: ModelCompat;
}

export interface ModelCompat {
  // OpenAI 兼容协议专用
  openAIThinkingFormat?: OpenAIThinkingFormat;
  // Anthropic 协议专用
  forceAdaptiveThinking?: boolean;   // MiniMax M3 Anthropic / Claude 新模型
  // 通用
  fixedTemperature?: number;          // Kimi 某些模型固定温度
  ignoredParameters?: string[];       // DeepSeek 思考模式忽略 temperature/top_p
  rejectedParameters?: string[];      // xAI 拒绝 stop/penalty
  streamOnly?: boolean;
}
```

### 6.5 AssistantMessage（单一存储结构，含 opaque signature）

```typescript
export interface AssistantMessage {
  role: 'assistant';
  content: (TextContent | ThinkingContent | ToolCall)[];
  api: ApiFormat;
  providerId: string;
  model: string;
  responseId?: string;
  usage: Usage;
  stopReason: StopReason;
  timestamp: number;
}

export interface TextContent {
  type: 'text';
  text: string;
  textSignature?: string;        // OpenAI Responses message id / Gemini text part signature
}

export interface ThinkingContent {
  type: 'thinking';
  thinking: string;
  thinkingSignature?: string;    // Anthropic signature / OpenAI reasoning item JSON / reasoning_content 字段名
  redacted?: boolean;
}

export interface ToolCall {
  type: 'tool_use';
  id: string;
  name: string;
  input: unknown;
  thoughtSignature?: string;     // Gemini functionCall signature / MiniMax reasoning_details
}
```

### 6.6 内部事件（不对外暴露）

packages/ai 内部用 `AssistantMessageEvent` 累积状态，但对外 yield `SSEEvent`：

```typescript
// packages/ai 内部事件，仅用于状态累积，不对外暴露
type AssistantMessageEvent =
  | { type: 'start'; partial: AssistantMessage }
  | { type: 'text_start'; contentIndex: number; partial: AssistantMessage }
  | { type: 'text_delta'; contentIndex: number; delta: string; partial: AssistantMessage }
  | { type: 'text_end'; contentIndex: number; content: string; partial: AssistantMessage }
  | { type: 'thinking_start'; contentIndex: number; partial: AssistantMessage }
  | { type: 'thinking_delta'; contentIndex: number; delta: string; partial: AssistantMessage }
  | { type: 'thinking_end'; contentIndex: number; content: string; partial: AssistantMessage }
  | { type: 'toolcall_start'; contentIndex: number; partial: AssistantMessage }
  | { type: 'toolcall_delta'; contentIndex: number; delta: string; partial: AssistantMessage }
  | { type: 'toolcall_end'; contentIndex: number; toolCall: ToolCall; partial: AssistantMessage }
  | { type: 'done'; reason: StopReason; message: AssistantMessage }
  | { type: 'error'; reason: string; error: AssistantMessage };
```

### 6.7 SSEEvent 降级映射

```typescript
// packages/ai/src/api/emit-sse.ts
function emitSSE(internalEvent: AssistantMessageEvent): SSEEvent | null {
  switch (internalEvent.type) {
    case 'text_delta':  return { type: 'text_delta', data: internalEvent.delta };
    case 'text_end':    return { type: 'text', data: internalEvent.content };
    case 'thinking_delta': return { type: 'thinking_delta', data: internalEvent.delta };
    case 'thinking_end':   return { type: 'thinking', data: internalEvent.content };
    case 'toolcall_start': return { type: 'tool_use_started', data: { id: internalEvent.partial.content[internalEvent.contentIndex].id, name: internalEvent.partial.content[internalEvent.contentIndex].name, input: {} } };
    case 'toolcall_end':   return { type: 'tool_use', data: internalEvent.toolCall };
    case 'done':  return { type: 'done', reason: internalEvent.reason };
    case 'error': return { type: 'error', data: internalEvent.reason, code: undefined };
    // text_start / thinking_start / start → 不产出 SSEEvent（内部状态用）
    default: return null;
  }
}
```

## 7. 对外接口（契合 LLMClient 契约）

### 7.1 AIClient 接口

```typescript
// packages/ai/src/index.ts

export interface AIClientOptions {
  apiKey: string;
  baseURL: string;
  model: string;
  authStyle?: 'api_key' | 'auth_token';
  // 从 ProviderRuntimeConfig 传入
  apiFormat: ApiFormat;
  headers?: Record<string, string>;
  providerId: string;
  modelCapabilities?: ModelCompat;
}

export interface AIClient {
  streamChat(
    messages: Message[],
    options?: {
      systemPrompt?: string;
      tools?: Array<{ name: string; description: string; input_schema: Record<string, unknown> }>;
      maxTokens?: number;
      temperature?: number;
      disableThinking?: boolean;
      signal?: AbortSignal;
      effort?: string;           // 保留现有契约
      maxOutputTokens?: number;
    }
  ): AsyncGenerator<SSEEvent, AssistantMessage, unknown>;

  chat?(messages: Message[], options?: ...): Promise<{ content: string; usage?: TokenUsage }>;
}
```

`AIClient` 兼容现有 `LLMClient` 接口（`streamChat` 签名一致，return 值从 `void` 扩展为 `AssistantMessage`）。

### 7.2 createAIClient factory

```typescript
export function createAIClient(options: AIClientOptions): AIClient {
  switch (options.apiFormat) {
    case 'anthropic':
      return createAnthropicClient(options);
    case 'openai-chat':
      return createOpenAICompletionsClient(options);
    case 'openai-responses':  // P1
      return createOpenAIResponsesClient(options);
    case 'gemini':            // P2
      return createGeminiClient(options);
    default:
      throw new Error(`Unsupported apiFormat: ${options.apiFormat}`);
  }
}
```

## 8. 协议实现层

### 8.1 anthropic-messages.ts

从 `packages/agent/src/llm/anthropic-client.ts` 迁移，关键改造：

- `BUDGET_BY_EFFORT` 从硬编码移到 `Model.thinkingLevelMap`（由 capability 配置驱动）。
- `isMiniMax` 判断从 URL 正则改为 `model.compat?.forceAdaptiveThinking` 标志位。
- thinking block 的 `signature` 字段存入 `ThinkingContent.thinkingSignature`，落库时保留。
- `<think>` 标签解析逻辑保留（作为 MiniMax OpenAI 接口的兜底）。

```typescript
export function streamSimple(
  model: Model<'anthropic'>,
  options: AIClientOptions,
  messages: Message[],
  chatOptions: ChatOptions,
): AsyncGenerator<SSEEvent, AssistantMessage, unknown> {
  // 1. capability resolver: effort → thinking 参数
  const thinking = resolveAnthropicThinking(model, chatOptions.effort);
  //    - forceAdaptiveThinking (MiniMax M3) → { type: 'adaptive' }
  //    - 标准 Anthropic → { type: 'enabled', budget_tokens }
  //    - effort 空 → 省略 thinking 字段

  // 2. 构建请求体（直接构造，不经白名单清洗）
  const params = {
    model: model.id,
    messages: convertMessages(messages),
    system: chatOptions.systemPrompt,
    tools: chatOptions.tools,
    max_tokens: chatOptions.maxOutputTokens ?? chatOptions.maxTokens ?? 4096,
    thinking,
  };

  // 3. 流式解析（内部用 AssistantMessage 累积）
  const assistantMsg: AssistantMessage = { role: 'assistant', content: [], api: 'anthropic', ... };
  for await (const event of anthropicSDK.messages.stream(params)) {
    const internal = parseAnthropicEvent(event, assistantMsg);
    const sse = emitSSE(internal);
    if (sse) yield sse;
  }
  return assistantMsg;
}
```

### 8.2 openai-completions.ts

从 `packages/agent/src/llm/openai-client.ts` 迁移，关键改造：

```typescript
export function streamSimple(
  model: Model<'openai-chat'>,
  options: AIClientOptions,
  messages: Message[],
  chatOptions: ChatOptions,
): AsyncGenerator<SSEEvent, AssistantMessage, unknown> {
  // 1. capability resolver: 按 model.compat.openAIThinkingFormat 分支
  const thinkingParams = resolveOpenAIThinking(model, chatOptions.effort);
  //    - 'openai-standard'  → { reasoning_effort: 'low'|'medium'|'high' }
  //    - 'reasoning-content' → 不发参数，靠 delta.reasoning_content 解析
  //    - 'qwen-style'        → { enable_thinking: true, thinking_budget }
  //    - 'glm-style'         → { thinking: { type }, clear_thinking: false, tool_stream: true }
  //    - 'think-tag-fallback' → 不发参数，靠 <think> 标签状态机解析

  // 2. 构建请求体（直接构造，扩展字段直接挂载）
  const params = {
    model: model.id,
    messages: convertMessages(messages),
    tools: chatOptions.tools,
    max_tokens: chatOptions.maxOutputTokens,
    ...thinkingParams,
  };

  // 3. 流式解析
  for await (const event of openaiSDK.chat.completions.stream(params)) {
    const internal = parseOpenAIEvent(event, assistantMsg, model.compat);
    // reasoning_content → thinking_delta
    // <think> 标签 → thinkTagParser.feed(delta.content) → thinking_delta / text_delta
    const sse = emitSSE(internal);
    if (sse) yield sse;
  }
  return assistantMsg;
}
```

### 8.3 `<think>` 标签状态机

```typescript
// packages/ai/src/utils/think-tag-parser.ts

type ThinkTagState = 'outside' | 'opening-tag' | 'inside' | 'closing-tag';

export class ThinkTagParser {
  private state: ThinkTagState = 'outside';
  private buffer = '';
  private tagBuffer = '';

  feed(chunk: string): { thinking: string[]; text: string[] } {
    // 状态机: outside → opening-tag (<th) → inside → closing-tag (</th) → outside
    // 跨 chunk 健壮: tagBuffer 累积不完整标签
    const thinking: string[] = [];
    const text: string[] = [];
    // ... 状态机实现
    return { thinking, text };
  }
}
```

启用条件：仅当 `model.compat.openAIThinkingFormat === 'think-tag-fallback'` 时启用。`generic-openai` preset 默认用此 format，其他 preset 用原生 reasoning 字段。

### 8.4 跨供应商消息转换（isSameModel 守卫）

```typescript
// packages/ai/src/api/transform-messages.ts

export function transformMessages(
  messages: Message[],
  targetModel: Model,
): Message[] {
  return messages.map(msg => {
    if (msg.role !== 'assistant' || !msg.content) return msg;

    const isSameModel = msg.providerId === targetModel.providerId
                     && msg.model === targetModel.id
                     && msg.api === targetModel.api;

    return {
      ...msg,
      content: msg.content.map(block => {
        if (block.type === 'thinking') {
          if (isSameModel) {
            return block;  // 保留 thinking + signature，供续轮回传
          }
          return { type: 'text', text: block.thinking };  // 跨模型: 降级为纯文本，丢弃 signature
        }
        return block;
      }),
    };
  });
}
```

替代现有 `handleThinkingBlocks` 的硬编码过滤逻辑。

## 9. Provider 配置层

每个 provider 文件极薄，只声明 baseUrl + auth + models + apiFormat：

```typescript
// packages/ai/src/providers/minimax-anthropic.ts
export const minimaxAnthropicProvider = {
  id: 'minimax-anthropic',
  name: 'MiniMax (Anthropic)',
  apiFormat: 'anthropic' as const,
  baseUrl: 'https://api.minimaxi.com/anthropic',
  authStyle: 'api_key' as const,
  models: [
    {
      id: 'MiniMax-M3',
      name: 'MiniMax M3 (Anthropic)',
      api: 'anthropic',
      reasoning: true,
      thinkingLevelMap: { off: null, low: 'low', medium: 'medium', high: 'high', max: 'max' },
      compat: { forceAdaptiveThinking: true },
      contextWindow: 200000,
      maxTokens: 8192,
      input: ['text', 'image'],
    },
  ],
};

// packages/ai/src/providers/minimax-openai.ts
export const minimaxOpenAIProvider = {
  id: 'minimax-openai',
  name: 'MiniMax (OpenAI)',
  apiFormat: 'openai-chat' as const,
  baseUrl: 'https://api.minimaxi.com/v1',
  authStyle: 'api_key' as const,
  models: [
    {
      id: 'MiniMax-M3',
      name: 'MiniMax M3 (OpenAI)',
      api: 'openai-chat',
      reasoning: true,
      thinkingLevelMap: { off: 'off', low: 'low', medium: 'medium', high: 'high', max: 'max' },
      compat: { openAIThinkingFormat: 'reasoning-content' },
      contextWindow: 200000,
      maxTokens: 8192,
      input: ['text', 'image'],
    },
  ],
};
```

### 9.1 与现有 ProviderStore 的关系

- `ProviderStore` 仍管理用户配置的 provider 列表（`apiProviders` 配置项）。
- packages/ai 的 `providers/` 目录是**内置 preset 库**，用户添加 provider 时选择一个 preset 作为模板，然后填 apiKey。
- 用户自定义的 provider（自定义 baseUrl）选择 `generic-openai` 或 `generic-anthropic` preset。

## 10. 存储改造

### 10.1 新增 4 列

```sql
-- migration N
ALTER TABLE messages ADD COLUMN provider_state TEXT;       -- JSON: { api, providerId, model, responseId }
ALTER TABLE messages ADD COLUMN thinking_signature TEXT;   -- Anthropic signature / OpenAI reasoning item JSON
ALTER TABLE messages ADD COLUMN tool_signature TEXT;       -- Gemini functionCall signature / MiniMax reasoning_details
ALTER TABLE messages ADD COLUMN text_signature TEXT;       -- OpenAI Responses message id / Gemini text part signature
```

为什么是 4 个独立列而不是 1 个 JSON 列：
- FTS5 触发器仅对 `msg_type IN ('text', 'tool_result')` 建索引，signature 列不会被索引，独立列查询更快。
- 独立列可以直接用 `SELECT thinking_signature FROM messages WHERE id = ?`，不用解析 JSON。
- 追加式契约：`INSERT OR IGNORE` 幂等写入不受影响，新列默认 NULL。

### 10.2 appendMessages 改造

现有 `appendMessages` 在写入时从 content array 提取 thinking block 到 `thinking` 列。新增逻辑：同时提取 signature 字段到独立列（约 +15 行）。

```typescript
function extractSignatures(content: MessageContent[]) {
  let thinkingSignature: string | undefined;
  let toolSignature: string | undefined;
  let textSignature: string | undefined;

  for (const block of content) {
    if (block.type === 'thinking' && block.thinkingSignature) {
      thinkingSignature = block.thinkingSignature;
    } else if (block.type === 'tool_use' && block.thoughtSignature) {
      toolSignature = block.thoughtSignature;
    } else if (block.type === 'text' && block.textSignature) {
      textSignature = block.textSignature;
    }
  }
  return { thinkingSignature, toolSignature, textSignature };
}
```

`provider_state` 列：由 agent 在 `done` 事件后写入，记录 `{ api, providerId, model, responseId }`，用于续轮时判断 `isSameModel`。

### 10.3 messageRowToMessage 改造

现有 `messageRowToMessage` 重建消息时，从 `thinking` 列还原 thinking block。新增逻辑：把 signature 列还原回 content block（约 +10 行）。

```typescript
if (row.thinking_signature) {
  const thinkingBlock = content.find(b => b.type === 'thinking');
  if (thinkingBlock) thinkingBlock.thinkingSignature = row.thinking_signature;
}
// tool_signature / text_signature 同理
```

### 10.4 软删除契约不变

- `truncateMessagesAfter` 和 `truncateMessagesFromInclusive` 仍用 `status = 'superseded'`。
- `replaceMessages` 仍通过 `generation` 乐观锁保护。
- 新增的 4 列随消息行一起软删除，无额外逻辑。

### 10.5 压缩保护

- 压缩边界（`firstKeptEntryId`）之后的消息**原样保留**，包括 signature 列。
- 压缩摘要本身**不携带 signature**（纯文本）。
- 压缩只能在完整工具回合结束后执行，不能在 `tool_use` 和 `tool_result` 之间压缩。

### 10.6 旧消息迁移

旧消息的 signature 列为 NULL。`isSameModel` 判断时检查 signature 是否存在，NULL 时按 `isSameModel=false` 降级处理（thinking 降级为纯文本）。

## 11. 设置面板改造

### 11.1 P0：effort 选择保持现有 UI，新增 provider preset 选择

现有 `MessageInput.tsx` 的 effort 下拉（`'' | 'low' | 'medium' | 'high' | 'max'`）保留。改动在 `ProvidersSection.tsx` 的 provider 添加流程：

```typescript
const PRESETS = [
  { id: 'anthropic', label: 'Anthropic', apiFormat: 'anthropic' },
  { id: 'minimax-anthropic', label: 'MiniMax (Anthropic)', apiFormat: 'anthropic' },
  { id: 'minimax-openai', label: 'MiniMax (OpenAI)', apiFormat: 'openai-chat' },
  { id: 'deepseek', label: 'DeepSeek', apiFormat: 'openai-chat' },
  { id: 'qwen', label: 'Qwen (DashScope)', apiFormat: 'openai-chat' },
  { id: 'glm', label: 'GLM (智谱)', apiFormat: 'openai-chat' },
  { id: 'kimi', label: 'Kimi (Moonshot)', apiFormat: 'openai-chat' },
  { id: 'openai', label: 'OpenAI', apiFormat: 'openai-chat' },
  { id: 'generic-openai', label: '自定义 (OpenAI 兼容)', apiFormat: 'openai-chat' },
  { id: 'generic-anthropic', label: '自定义 (Anthropic 兼容)', apiFormat: 'anthropic' },
];
```

preset 选择写入 `LlmProvider.options.preset` 字段，运行时由 `toRuntimeConfig` 读取并传给 agent。

### 11.2 P1：capability 驱动的设置面板

effort 选项由 `Model.thinkingLevelMap` 动态生成：

```typescript
function getEffortOptions(model: Model) {
  if (!model.reasoning) return [];
  const levels = getSupportedThinkingLevels(model);
  return [
    { value: '', label: 'auto' },
    ...levels.map(l => ({ value: l, label: l })),
  ];
}
```

例如 MiniMax M3 Anthropic: `['low', 'medium', 'high', 'max']`（`off: null` → 不显示关闭）。DeepSeek-R1: `['low', 'medium', 'high']`（不支持 max）。普通 GPT-4o: `[]`（`reasoning: false` → 完全隐藏）。

### 11.3 P1：reasoning budget 与 output budget 分离

```typescript
interface ChatOptions {
  effort?: string;              // 保留
  reasoningBudget?: number;     // 新增：推理预算
  totalOutputBudget?: number;   // 新增：总输出预算
  // maxOutputTokens 保留作为 totalOutputBudget 的别名
}

if (reasoningBudget !== undefined && totalOutputBudget !== undefined
    && reasoningBudget >= totalOutputBudget) {
  throw new Error('推理预算必须为最终回答预留空间');
}
```

UI 显示规则：无法分别限制两者的模型显示"推理和正文共享此预算"。

## 12. 参数诊断（P1）

```typescript
// packages/ai/src/utils/diagnostics.ts

export interface ParameterDiagnostic {
  code: 'PARAMETER_IGNORED' | 'PARAMETER_UNSUPPORTED' | 'PARAMETER_REJECTED';
  parameter: string;
  routeId: string;  // `${providerId}:${modelId}:${apiFormat}`
  message: string;
}
```

诊断信息通过 `SSEEvent.system` 事件传递给前端：

```typescript
yield { type: 'system', data: '参数 temperature 在思考模式下被忽略', metadata: { diagnostic: { code: 'PARAMETER_IGNORED', parameter: 'temperature' } } };
```

最终请求体查看器（P1）：在设置面板新增"调试"tab，展示最后一次请求的完整 JSON。通过 `onPayload` 回调收集，存入 `provider_state` 列。

## 13. packages/agent 改造点

### 13.1 createLLMClient 委托 packages/ai

```typescript
// packages/agent/src/llm/index.ts（改造后）
import { createAIClient } from '@duya/ai';

export function createLLMClient(
  provider: LLMProvider,
  options: LLMClientOptions & {
    apiFormat?: ApiFormat;
    providerId?: string;
    modelCapabilities?: ModelCompat;
  }
): LLMClient {
  if (provider === 'ollama') return new LazyLLMClientProxy(...OllamaClient);

  return createAIClient({
    apiKey: options.apiKey,
    baseURL: options.baseURL,
    model: options.model,
    authStyle: options.authStyle,
    apiFormat: options.apiFormat ?? (provider === 'anthropic' ? 'anthropic' : 'openai-chat'),
    providerId: options.providerId ?? provider,
    modelCapabilities: options.modelCapabilities,
  }) as LLMClient;
}
```

### 13.2 LLMClientWrapper 移除

`packages/agent/src/llm/wrapper.ts` 删除。MiniMax URL 改写逻辑移到 provider 配置的 `baseUrl` 字段（用户配置时填完整 URL，如 `https://api.minimaxi.com/anthropic`）。

### 13.3 inferProvider 降级为兜底

`inferProvider` 保留但仅在 `apiFormat` 未传入时作为兜底推断。优先级：
1. `AgentOptions.runtimeConfig.apiFormat`（Phase 2 配置，最高优先级）
2. `options.apiFormat` 参数（createLLMClient 调用方显式传入）
3. `inferProvider(baseURL)`（兜底，仅在前两者均缺失时使用）

兜底触发场景：旧版 provider 配置未带 apiFormat 字段、或测试代码直接调用 createLLMClient。生产路径应始终走 1 或 2。

### 13.4 DuyaAgent 改动

构造函数里把 `runtimeConfig.apiFormat` / `runtimeConfig.providerId` 传给 `createLLMClient`。约 10 行改动。

### 13.5 SSEEvent 类型迁移

`SSEEvent`、`Message`、`ToolUse`、`ToolResult`、`TokenUsage` 从 `packages/agent/src/types.ts` 迁移到 `packages/ai/src/types.ts`，packages/agent re-export。

## 14. 实施计划

### 阶段 0：基础设施（P0 核心）

| # | 任务 | 涉及文件 | 依赖 |
|---|---|---|---|
| 0.1 | 创建 packages/ai workspace 包 | `packages/ai/package.json`, `tsconfig.json` | - |
| 0.2 | 定义核心类型 | `packages/ai/src/types.ts` | 0.1 |
| 0.3 | SSEEvent 等共享类型迁移 | `packages/agent/src/types.ts` → `packages/ai/src/types.ts` | 0.2 |
| 0.4 | 实现 simple-options + capability resolver | `packages/ai/src/api/simple-options.ts` | 0.2 |
| 0.5 | 实现 transform-messages + isSameModel 守卫 | `packages/ai/src/api/transform-messages.ts` | 0.2 |
| 0.6 | 实现 emit-sse 降级映射 | `packages/ai/src/api/emit-sse.ts` | 0.2 |

### 阶段 1：协议迁移（P0 核心）

| # | 任务 | 涉及文件 | 依赖 |
|---|---|---|---|
| 1.1 | 迁移 anthropic-messages.ts | `packages/ai/src/api/anthropic-messages.ts` ← `packages/agent/src/llm/anthropic-client.ts` | 0.4, 0.5, 0.6 |
| 1.2 | 迁移 openai-completions.ts | `packages/ai/src/api/openai-completions.ts` ← `packages/agent/src/llm/openai-client.ts` | 0.4, 0.5, 0.6 |
| 1.3 | 实现 think-tag-parser 状态机 | `packages/ai/src/utils/think-tag-parser.ts` | 0.2 |
| 1.4 | 实现 createAIClient factory | `packages/ai/src/index.ts` | 1.1, 1.2 |

### 阶段 2：Provider 配置（P0 核心）

| # | 任务 | 涉及文件 | 依赖 |
|---|---|---|---|
| 2.1 | 实现 minimax-anthropic preset | `packages/ai/src/providers/minimax-anthropic.ts` | 1.1 |
| 2.2 | 实现 minimax-openai preset | `packages/ai/src/providers/minimax-openai.ts` | 1.2 |
| 2.3 | 实现 deepseek / qwen / glm / kimi preset | `packages/ai/src/providers/*.ts` | 1.2 |
| 2.4 | 实现 anthropic / openai preset | `packages/ai/src/providers/anthropic.ts`, `openai.ts` | 1.1, 1.2 |
| 2.5 | 实现 generic-openai / generic-anthropic preset | `packages/ai/src/providers/generic-*.ts` | 1.1, 1.2 |
| 2.6 | 实现 all.ts 注册表 | `packages/ai/src/providers/all.ts` | 2.1-2.5 |

### 阶段 3：Agent 集成（P0 核心）

| # | 任务 | 涉及文件 | 依赖 |
|---|---|---|---|
| 3.1 | createLLMClient 委托 packages/ai | `packages/agent/src/llm/index.ts` | 1.4 |
| 3.2 | DuyaAgent 传 runtimeConfig | `packages/agent/src/agent/DuyaAgent.ts` | 3.1 |
| 3.3 | 移除 LLMClientWrapper | `packages/agent/src/llm/wrapper.ts` (删除) | 3.1 |
| 3.4 | Retryable client 适配 | `packages/agent/src/llm/Retryable*.ts` | 3.1 |
| 3.5 | DB migration N（4 列） | `electron/db/schema.ts` | - |
| 3.6 | appendMessages 提取 signature | `packages/agent/src/session/db.ts` | 0.2, 3.5 |
| 3.7 | messageRowToMessage 还原 signature | `packages/agent/src/session/db.ts` | 3.6 |

### 阶段 4：Provider 选择 UI（P0 核心）

| # | 任务 | 涉及文件 | 依赖 |
|---|---|---|---|
| 4.1 | LlmProvider.options.preset 字段 | `src/lib/providers/types.ts` | - |
| 4.2 | toRuntimeConfig 传 preset + modelCapabilities | `src/lib/providers/domain/ProviderRuntimeAdapter.ts` | 4.1 |
| 4.3 | provider preset 选择器 UI | `src/components/settings/ProvidersSection.tsx` | 2.6, 4.1 |
| 4.4 | MiniMax baseUrl 自动补全 migration | `electron/services/providers/provider-store.ts` | 4.1 |

### 阶段 5：测试与验证（P0 核心）

| # | 任务 | 涉及文件 | 依赖 |
|---|---|---|---|
| 5.1 | anthropic-thinking 单元测试 | `packages/ai/test/anthropic-thinking.test.ts` | 1.1 |
| 5.2 | openai-completions-reasoning 单元测试 | `packages/ai/test/openai-completions-reasoning.test.ts` | 1.2 |
| 5.3 | minimax-dual-protocol 契约测试 | `packages/ai/test/minimax-dual-protocol.test.ts` | 2.1, 2.2 |
| 5.4 | cross-provider-handoff 测试 | `packages/ai/test/cross-provider-handoff.test.ts` | 0.5 |
| 5.5 | think-tag-parser 测试 | `packages/ai/test/think-tag-parser.test.ts` | 1.3 |
| 5.6 | signature 持久化测试 | `packages/agent/src/session/__tests__/db-signature.test.ts` | 3.6, 3.7 |
| 5.7 | 现有 e2e 回归测试 | `e2e/` | 3.7 |
| 5.8 | typecheck:all + electron:build | - | 全部 |

### 阶段 6：P1 增强

| # | 任务 |
|---|---|
| 6.1 | capability 驱动的 effort 选项（动态生成） |
| 6.2 | reasoningBudget / totalOutputBudget 分离 |
| 6.3 | ParameterDiagnostic 三态诊断 |
| 6.4 | 最终请求体查看器 |
| 6.5 | 迁移 openai-responses.ts（OpenAI Responses API） |
| 6.6 | DuyaReasoningSettings 作为 effort 超集 |

### 阶段 7：P2 扩展

| # | 任务 |
|---|---|
| 7.1 | 迁移 gemini-generative-ai.ts | |
| 7.2 | 网关上游识别（OpenRouter upstreamProvider） |
| 7.3 | 用户自定义 capability preset override |
| 7.4 | 自动协议探测 |
| 7.5 | 文档版本与能力配置版本管理 |
| 7.6 | 定期运行供应商契约测试矩阵 |

## 阶段 8（Plan 451）：Wrapper 层 + 多协议扩展

Plan 451 在本文档设计的基础上把 wire-protocol 从 4 个扩到 6 个（+ Bedrock / + Gemini），并且加了一层 **family wrapper**:

```
┌─────────────────────────────────────────────────────────────────┐
│ Provider catalog  (providers/<name>.ts)          ← 13 行极薄 │
└─────────────────────────────────────────────────────────────────┘
                              ↓ pipe(base, ...explicit, ...auto)
┌─────────────────────────────────────────────────────────────────┐
│ Family wrappers  (providers/wrappers/<family>-<aspect>.ts)         │
│   (ProviderStreams) → ProviderStreams                              │
│   家族级 payload 处理(thinking / cache_control / signature / 修复) │
└─────────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────────┐
│ Wire protocol  (api/<protocol>.ts)                                │
│   纯协议级逻辑，不感知家族差异                                   │
└─────────────────────────────────────────────────────────────────┘
```

### 8.1 plan 451 阶段进展

| 阶段 | 状态 | 交付 |
|---|---|---|
| Phase 0 | ✅ | `providers/wrappers/compose.ts` + `Provider.wrappers` 字段 + `createProvider` 接受 wrappers + `autoWrappersForCompat()`（Phase 2） |
| Phase 1 | ✅ | 2 个 anthropic-family wrapper + 1 utility（cache-control 留 Phase 3+） |
| Phase 2 | ✅ | `model.compat` 字段自动 inject wrapper 的映射表 |
| Phase 3 | ✅ | Bedrock Converse 协议（手写 SigV4，不依赖 AWS SDK）|
| Phase 4 | ✅ | Gemini GenerativeLanguage 协议（直接 fetch，不依赖 @google/genai）|
| Phase 5 | ⏳ | Vertex Express（复用 Gemini payload + OAuth access token）|
| Phase 6 | ✅ | bedrock + google 模型目录（Claude 4 / 3.5 Haiku / Nova Pro / Gemini 2.5 / 2.0 Flash）|
| Phase 7 | ✅ | ARCHITECTURE.md + packages/ai/README.md 同步 |
| Phase 8 | ⏳ | typecheck:all + 全量 test + Electron e2e 验收 |

### 8.2 `pipe()` 组合语义

```ts
 pipe(base, w1, w2, w3) === w3(w2(w1(base)))
```

最后一个 wrapper 是最外层(标准 middleware 顺序)。Provider 可显式传 `wrappers`；`model.compat` 字段决定的自动 inject 永远在显式 wrappers 之后(更外层)。

### 8.3 谎言桥拆除

阶段 3-4 同时拆除了 `runtime-adapter.ts:131-148` 的谎言桥：bedrock / vertex / google / gemini-image 不再假装 anthropic / openai-chat。配置这些 legacy 类型的 provider 现在：

- bedrock → 走 `bedrock-converse.ts`（✅ 可用）
- google / gemini-image → 走 `google-generative-ai.ts`（✅ 可用）
- vertex → 抛清晰错误（⏳ Phase 5 实现）
- 而不是 silently 拿 anthropic SDK 去打 Google / Bedrock。

### 8.4 自动 compat → wrapper 映射表（Plan 451 Phase 2 落地版）

| `model.compat` 字段 | Wrapper |
|---|---|
| `toolResultTransport: 'text-user-message' \| 'none'` | `anthropicFamilyToolPayloadCompat` |
| `forceAdaptiveThinking: true` | `anthropicFamilyThinkingReplay`(响应侧 observer) |

待 P3+（需要 `onPayload` hook）：`supportsToolReferences`、`supportsThinkingTokenBudget`、`openAIThinkingFormat`。

### 8.5 三类 wrapper 形态

| 类型 | 例子 | 何时用 |
|---|---|---|
| 真 wrapper（Stream）| `anthropicFamilyToolPayloadCompat` | 转换在 `Message[]` 或 `SSEEvent` 层 |
| Wrapper（响应侧 observer）| `anthropicFamilyThinkingReplay` | 只观测不改事件，给 telemetry 用 |
| Utility（re-export only）| `anthropicFamilyCacheControl` | 决策逻辑可测，application 在 wire payload 层 |

Plan 451 故意把 cache-control 留作 utility 而非 wrapper——`applyCacheControl` 跑在 Anthropic MessageParam[]（wire-format）上，ProviderStream 接口摸不到。等 `onPayload` hook 落地（Phase 3+）再升级。

## 15. 契约测试矩阵

每个 route 至少覆盖以下场景：

| # | 场景 | 断言 |
|---|---|---|
| T1 | 普通流式文本回答 | text_delta + text 事件正确 |
| T2 | 推理开启 + 关闭 | thinking 事件按 capability 出现/不出现 |
| T3 | 推理强度最低 + 最高 | thinkingLevelMap 钳制正确 |
| T4 | 单次工具调用 | tool_use_started + tool_use + tool_result |
| T5 | 连续两次工具调用 | signature 不丢失，续轮回传正确 |
| T6 | 工具返回后继续推理 | thinking block + signature 完整 |
| T7 | 会话落库后重新加载 | signature 列还原回 content block |
| T8 | 累计 delta 去重 | MiniMax reasoning_details 不重复 |
| T9 | `<think>` 标签跨 chunk | 状态机正确解析 |
| T10 | 跨 provider handoff | isSameModel=false 时 thinking 降级为纯文本 |
| T11 | 参数 ignored 诊断（P1） | system 事件携带 diagnostic metadata |
| T12 | 低输出预算 | 验证预算分配逻辑 |
| T13 | 并行工具调用 | 多个 tool_use 同时处理 |
| T14 | 中断流后重新连接 | signature 不丢失 |
| T15 | 结构化输出与推理同时开启（P1） | 不冲突 |

关键断言：
- 无重复 reasoning 文本。
- 最终正文不混入 `<think>` 标签。
- 工具参数 JSON 可以完整重组。
- 要求回传的签名没有丢失或变化。
- 关闭 UI 展示不会删除供应商状态。
- 无效参数会产生明确诊断。
- 数据库重放结果与实时工具链一致。

## 16. 风险与缓解

| 风险 | 缓解 |
|---|---|
| packages/ai 与 packages/agent 循环依赖（SSEEvent 类型） | SSEEvent 等共享类型迁移到 packages/ai/src/types.ts，packages/agent re-export。依赖方向：agent → ai，单向。 |
| 现有 e2e 测试回归 | 阶段 3 完成后立即跑 `npm run test:e2e:smoke`，发现问题回滚。 |
| MiniMax 用户现有配置 baseUrl 不带 `/anthropic` 后缀 | migration 自动补全：检测到 minimaxi.com 域名时追加 `/anthropic`。 |
| signature 列 NULL（旧消息） | isSameModel 判断时检查 signature 是否存在，NULL 时按 isSameModel=false 降级。 |
| Agent bundle 构建变化 | `scripts/build-electron.mjs` 新增 packages/ai 为 workspace 依赖，bundle 时包含。 |
| Retryable client 包装失效 | Retryable client 改为包装 AIClient 接口，保持 streamChat 签名一致。 |
| ProviderStore preset 字段未持久化 | LlmProvider.options.preset 写入现有 options JSON 列，无需新表。 |

## 17. 关键决策总结

1. **不引入 routeId**：用 `(providerId, modelId)` + `model.api` 表达路由。
2. **复用 ApiFormat**：不新增 KnownApi 类型，避免两层映射。
3. **保留 effort?: string**（P0）：P1 再引入 DuyaReasoningSettings。
4. **单一 AssistantMessage 存储**：不拆 VisibleMessageRecord + ProviderTurnRecord。
5. **thinkingLevelMap + null 语义 + compat 标志位**：替代完整类型系统。
6. **OpenAIThinkingFormat 精简到 5 种**：含 think-tag-fallback 兜底。
7. **packages/ai 直接 yield SSEEvent**：不引入新事件类型，agent 包和前端零改动。
8. **streamChat return 值从 void 改为 AssistantMessage**：唯一新增契约，携带 signature 落库。
9. **createLLMClient 委托 packages/ai**：OllamaClient 保留不迁移。
10. **LLMClientWrapper 移除**：MiniMax URL 由 provider 配置的 baseUrl 承载。
11. **MiniMax 拆成 minimax-anthropic + minimax-openai 两个 provider preset**。
12. **`<think>` 标签状态机仅 think-tag-fallback format 启用**。
13. **isSameModel 守卫替代 handleThinkingBlocks 的硬编码过滤**。
14. **新增 4 列存 signature**：thinking_signature / tool_signature / text_signature / provider_state。
15. **SSEEvent 等共享类型迁移到 packages/ai**：解决循环依赖。

## 18. 参考资料

- pi 项目（`e:\cloned-projects\pi`）：正交分离、thinkingLevelMap、三 signature 字段、isSameModel 守卫、capability resolver。
- Duya 现有代码契约（70+ 条不可破坏契约，详见第 3 节）。
- 用户输入的调研报告：多模型 API 推理能力与特殊参数适配报告。
