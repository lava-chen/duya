# @duya/ai

多协议 LLM 适配层。拥有 provider 目录与模型目录、wire-shape 翻译、鉴权、重试/退避、上下文估算。

## 1. 负责 / 不负责

**负责**

- provider 工厂与 17 个内置 provider、模型目录数据。
- 各家 API 的请求/响应形状翻译（Anthropic / OpenAI chat / OpenAI responses / Ollama / Gemini / Bedrock）。
- 重试、退避、错误分类、idle 超时、密钥脱敏。

**不负责**

- 模型目录的**数据**就在本包，别去别处找（见下方边界约束）。
- 工具的运行时注册与执行 → `@duya/agent-runtime`（`packages/agent-runtime/src/tools/catalog/registry.ts:247`）。
- 消息/事件的协议类型 → `@duya/agent-protocol`（`ApiFormat` 定义在 `packages/agent-protocol/src/transcript/content.ts:63`）。
- 供应商密钥的存储与 UI 配置 → `@duya/host`（`packages/host/src/worker-process-entry.ts:2511` 是调用点）。

## 2. 关键文件

| 文件 | 作用 |
| --- | --- |
| `packages/ai/src/index.ts:272` | `createAIClient(options)`：按 `apiFormat` 懒加载动态 import；`apiFormat: 'gemini'` 在 `:291` 直接抛错。 |
| `packages/ai/src/providers/create-provider.ts:44` | `createProvider`：wrapper 链 `pipe(base, ...wrappers)` 在 `:75`，兼容层自动注入 `:73`。 |
| `packages/ai/src/providers/all.ts:23` | 17 个内置 provider 工厂（anthropic / deepseek / qwen / glm / kimi / openai / openaiResponses / openrouter / ollama / xai / stepfun / volcengine / bailian / minimax / minimaxCn / bedrock / google）。 |
| `packages/ai/src/providers/catalog-data.ts:40` | **内置模型目录数据** `BUILTIN_CATALOG_ENTRIES`；访问器 `packages/ai/src/providers/catalog.ts:82`（`BUILTIN_CATALOG`）；每厂商模型在 `packages/ai/src/providers/anthropic.models.ts` 等文件（每厂商一个）。 |
| `packages/ai/src/api/anthropic-messages.ts:1782` | `createAnthropicClient`（用官方 SDK）；tool-result 传输降级阶梯 `:1829`（L0 block → L1 text → L2 none）；cache breakpoint `:1868`。 |
| `packages/ai/src/utils/retry.ts:63` | `DEFAULT_RETRY_CONFIG`：maxRetries 10、base 500 ms、max 32 s、multiplier 2、jitter 0.25、persistent 上限 6 h。 |
| `packages/ai/src/runtime-adapter.ts` | `toRuntimeConfig` / `buildHeaders` / `redactSecrets` 等，统一导出在 `packages/ai/src/index.ts:99`。 |

公共面：`packages/ai/src/index.ts`（barrel）+ `packages/ai/src/context.ts`；另有 `packages/ai/src/retry-client.ts:23` 的 `createAIClientWithRetry`。

## 3. 排障入口

| 症状 | 先看这里 | 为什么 |
| --- | --- | --- |
| 选错了 provider / model | `packages/ai/src/runtime-adapter.ts` → `packages/ai/src/providers/create-provider.ts:44` → `packages/ai/src/providers/all.ts:23` | 运行时配置 → 工厂 → 具体 provider 三段分离。 |
| 新模型没出现在列表里 | `packages/ai/src/providers/catalog-data.ts:40` + `packages/ai/src/providers/anthropic.models.ts` | 目录数据只有这一个来源。 |
| 流式响应中途卡住 | `packages/ai/src/api/anthropic-messages.ts:1829` + `packages/ai/src/utils/partial-json.ts:20` | 前者是传输降级阶梯，后者是残缺 JSON 解析。 |
| 重试 / 超时行为不符合预期 | `packages/ai/src/utils/retry.ts:63` + `packages/ai/src/utils/errors.ts:368` | `classifyError` 决定哪些错可重试，`isRetryableError` 在 `:505`。 |
| `apiFormat: 'gemini'` 抛 "not yet implemented" | `packages/ai/src/index.ts:291` | `createAIClient` 不支持 gemini；但 `createProvider` 路径可用（`packages/ai/src/providers/adapters.ts:97`）。**两个入口行为不同**。 |
| 一直重试不放弃 | `packages/ai/src/utils/backoff.ts:52` + `packages/ai/src/utils/idle-timeout.ts:17` | `calculateBackoffDelay` 是纯算法，`withIdleTimeout` 是 host timer 竞速。 |

## 4. 边界约束

- `architecture-policy.yaml:80` 把 `ai` 声明为 **core 层**模块；模块条目 `legacy-ai` 在 `architecture-policy.yaml:789-793`（`managed: false`）。
- **IO 是白名单而非例外**：`scripts/architecture/layer-purity.ts:303-337` 精确列出允许做 IO 的 6 个文件（`api/ollama-chat.ts`、`auth/oauth/device-code.ts`、`utils/backoff.ts`、`utils/idle-timeout.ts`、`system-one/client.ts`）。往本包任何**其它**文件加一个 `fetch(` 都会让架构门禁变红。
- **内置 provider / 模型目录只在本包**：`packages/ai/src/providers/catalog-data.ts:40`。agent-protocol 侧**没有** provider 目录文件；`packages/agent-protocol/src/model-capabilities.ts` 只是能力记录的类型，不是模型目录。
