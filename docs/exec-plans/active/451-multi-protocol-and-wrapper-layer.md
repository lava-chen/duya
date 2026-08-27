# Plan 451: Multi-protocol expansion + family-level wrapper layer (openclaw/pi 对齐)

> **Goal**: 把 `@duya/ai` 从「4 个 wire-protocol + 0 个 wrapper」对齐到 openclaw / pi 的「~10 个 wire-protocol + 家族级 wrapper 层」。第一阶段补 Bedrock / Gemini / Vertex 三个最痛的谎言桥协议,并把散落在 `api/` 内部的家族差异(if/else 块)抽到 `providers/wrappers/` 显式 compose。

---

## Context

`packages/ai` 由 plan 310 落地后,当前形态是「4 个 wire-protocol + 15 个极薄 provider 目录项」:

```
api/  anthropic-messages.ts (2154) / openai-completions.ts (972) /
      openai-responses.ts (841) / ollama-chat.ts (640)
providers/  anthropic / openai / openai-responses / ollama / openrouter /
            deepseek / qwen / glm / kimi / xai / stepfun / volcengine /
            bailian / minimax / minimax-cn   ← 每个 12-13 行
utils/  14 个共享工具(retry/errors/json-repair/prompt-cache/usage/...)
```

### 三个真实问题

1. **`runtime-adapter.ts:131-148` 的谎言桥**:
   ```ts
   case 'bedrock': case 'vertex': return 'anthropic';     // Bedrock / Vertex 不是 Anthropic
   case 'google': case 'gemini-image': return 'openai-chat'; // Gemini 不是 OpenAI
   ```
   配置成 bedrock / vertex / google 的用户今天拿到的是裸 Anthropic SDK 打 Bedrock / Vertex,**协议级差异(认证、tool-call shape、stream event 命名)完全没处理**。

2. **家族差异散落在 wire-protocol 文件内部**(没有"wrapper"概念):
   - `anthropic-messages.ts:1638-1715` — MiniMax adaptive thinking 逻辑
   - `anthropic-messages.ts:412` — `isMiniMaxEndpoint(model.baseUrl)` 域名正则判断
   - `openai-completions.ts:155-180` — `switch(format)` 的 5 个分支(openai-standard/reasoning-content/qwen-style/glm-style/think-tag-fallback)
   - `openai-completions.ts:225-280` — `repairToolPairing` OpenAI 专用修复
   - `anthropic-messages.ts:185-220` — `resolveToolResultTransport`(text-user-message / tool-result-block / none)
   - `prompt-caching.ts` — Anthropic cache_control 放置策略
   这些都是**wrapper 候选**——应该在 `providers/wrappers/` 下独立可测。

3. **`ModelCompat` 字段无对应 wrapper**:`types.ts:414-470` 已经定义了 11 个 compat 字段(`forceAdaptiveThinking` / `openAIThinkingFormat` / `toolResultTransport` / `supportsToolReferences` / `supportsFinishReason` / `supportsThinkingTokenBudget` / `fixedTemperature` / `ignoredParameters` / `rejectedParameters` / `streamOnly`),但每个字段都在 `api/*.ts` 内部硬编码 `if (model.compat?.xxx)`,没有"compat 字段 → wrapper 名字"的统一映射。

### 参考实现

| 项目 | wire-protocol 数 | wrapper 层 | 派发机制 |
|---|---|---|---|
| openclaw | 8 | `src/llm/providers/stream-wrappers/{anthropic,google,moonshot,zai,minimax,proxy,openai}.ts` | `ApiRegistry` + `LlmRuntime` |
| pi | ~10 | `compat.ts` 聚合 + per-protocol `.lazy.ts` | `apiProviderRegistry: Map` + `wrapStream`/`wrapStreamSimple` |
| hermes | 6+ adapter | 无显式 wrapper,adapters 双向翻译成 OpenAI chat.completions 形状 | `resolve_provider_client()` 单函数 |
| duya(现在) | 4 | 无 | `createProvider` 工厂 + `model.api` |

duya 现在最像 **pi** 的简化版(都是「map[string] provider,内部按 `model.api` 路由」)。本 plan 的目标是把 duya 推进到 **openclaw** 那个量级(三层分明 + wrapper 可插拔),但保留 pi 风格的 `compat.ts` 兼容入口。

---

## Architecture

### 目标三层

```
┌──────────────────────────────────────────────────────────────┐
│ Provider catalog (providers/<name>.ts)                        │
│   - id, name, baseUrl, auth, model[]                          │
│   - 新增: wrappers: Wrapper[] (显式 compose)                   │
└──────────────────────────────────────────────────────────────┘
                          ↓ (pipe)
┌──────────────────────────────────────────────────────────────┐
│ Family wrappers (providers/wrappers/<family>-<aspect>.ts)     │
│   - (ProviderStreams) → ProviderStreams                      │
│   - 家族级 payload 处理(thinking 字段名 / cache_control /      │
│     tool_result transport / signature replay / 工具对修复)      │
└──────────────────────────────────────────────────────────────┘
                          ↓
┌──────────────────────────────────────────────────────────────┐
│ Wire protocol (api/<protocol>.ts)                             │
│   - HTTP/SSE/JSON/auth/认证/标准 tool-call shape               │
│   - 不感知家族差异,只懂"协议级"差异                             │
│   - 输出标准 ProviderStreams                                  │
└──────────────────────────────────────────────────────────────┘
                          ↓
┌──────────────────────────────────────────────────────────────┐
│ Shared utilities (utils/)                                      │
│   - errors / retry / json-repair / usage / think-tag-parser    │
└──────────────────────────────────────────────────────────────┘
```

### Wrapper 显式 compose

```ts
// packages/ai/src/providers/wrappers/compose.ts (新)
export type Wrapper = (inner: ProviderStreams) => ProviderStreams;
export const pipe = (base: ProviderStreams, ...wrappers: Wrapper[]): ProviderStreams =>
  wrappers.reduce((acc, w) => w(acc), base);

// 使用样例 (providers/minimax.ts)
export const minimax = createProvider({
  id: 'minimax',
  api: pipe(
    anthropicStreams({ ..., providerId: 'minimax' }),
    anthropicFamilyThinkingReplay(),                  // signature 续轮
    anthropicFamilyToolPayloadCompat('text-user-message'), // MiniMax 不收 tool_result block
    anthropicFamilyCacheControl({ strategy: 'auto' }),
  ),
});
```

### Compat 字段 → Wrapper 名字的固定映射(便于 findModelCompat 自动 apply)

| ModelCompat 字段 | 对应 wrapper |
|---|---|
| `forceAdaptiveThinking` | `anthropicFamilyThinkingReplay({ mode: 'adaptive' })` |
| `toolResultTransport: 'text-user-message'` | `anthropicFamilyToolPayloadCompat('text-user-message')` |
| `toolResultTransport: 'tool-result-block'` | `anthropicFamilyToolPayloadCompat('tool-result-block')`(默认) |
| `openAIThinkingFormat: 'qwen-style'` | `openAIFamilyThinkingFormat('qwen-style')` |
| `openAIThinkingFormat: 'glm-style'` | `openAIFamilyThinkingFormat('glm-style')` |
| `openAIThinkingFormat: 'reasoning-content'` | `openAIFamilyThinkingFormat('reasoning-content')` |
| `openAIThinkingFormat: 'think-tag-fallback'` | `openAIFamilyThinkingFormat('think-tag-fallback')` |
| `supportsToolReferences` | `anthropicFamilyToolReferences()` |
| `supportsThinkingTokenBudget` | `anthropicFamilyThinkingBudget()` |
| (openai 通用) | `openAIFamilyToolPairingRepair()` |

`createProvider` 默认根据 `model.compat` 自动 inject 这些 wrapper(provider 写自己的 `wrappers` 时显式 override 或追加)。

---

## File Structure

### 新建

| 文件 | 职责 |
|---|---|
| `packages/ai/src/providers/wrappers/compose.ts` | `Wrapper` 类型 + `pipe()` reduce |
| `packages/ai/src/providers/wrappers/anthropic-family-thinking-replay.ts` | 上一轮 signature 注入请求,本轮 signature 累积 |
| `packages/ai/src/providers/wrappers/anthropic-family-tool-payload-compat.ts` | tool_result 形态转换(text-user-message / tool-result-block / none) |
| `packages/ai/src/providers/wrappers/anthropic-family-cache-control.ts` | cache_control 放置策略(system block / tools / messages) |
| `packages/ai/src/providers/wrappers/anthropic-family-tool-references.ts` | tool_reference 支持标记 |
| `packages/ai/src/providers/wrappers/anthropic-family-thinking-budget.ts` | `thinking_token_budget` 预算注入 |
| `packages/ai/src/providers/wrappers/openai-family-thinking-format.ts` | 5 种 thinking 字段名 switch |
| `packages/ai/src/providers/wrappers/openai-family-tool-pairing-repair.ts` | 孤儿 tool_use / tool_result 修复 |
| `packages/ai/src/providers/wrappers/openai-family-usage.ts` | OpenAI usage → 标准化 usage(可选;当前已在 utils/usage) |
| `packages/ai/src/providers/wrappers/index.ts` | barrel |
| `packages/ai/src/api/bedrock-converse.ts` | AWS Bedrock Converse Stream API |
| `packages/ai/src/api/google-generative-ai.ts` | Gemini GenerativeLanguage API |
| `packages/ai/src/api/google-vertex.ts` | Vertex AI Express mode |
| `packages/ai/src/providers/bedrock.ts` | Bedrock preset(providerId, auth, models, api) |
| `packages/ai/src/providers/google.ts` | Google GenerativeLanguage preset |
| `packages/ai/src/providers/vertex.ts` | Vertex AI preset |
| `packages/ai/test/wrappers/compose.test.ts` | pipe 顺序保证 / 短路 / 类型 |
| `packages/ai/test/wrappers/anthropic-family-thinking-replay.test.ts` | signature 注入 / 累积 |
| `packages/ai/test/wrappers/anthropic-family-tool-payload-compat.test.ts` | 形态转换正确性 |
| `packages/ai/test/wrappers/anthropic-family-cache-control.test.ts` | 缓存放置 |
| `packages/ai/test/wrappers/openai-family-thinking-format.test.ts` | 5 种格式 switch |
| `packages/ai/test/wrappers/openai-family-tool-pairing-repair.test.ts` | 孤儿修复 |
| `packages/ai/test/api/bedrock-converse.test.ts` | Bedrock mock fetch 测流式事件 |
| `packages/ai/test/api/google-generative-ai.test.ts` | Gemini mock fetch 测流式事件 |
| `packages/ai/test/api/google-vertex.test.ts` | Vertex mock fetch 测流式事件 |

### 修改

| 文件 | 改动 |
|---|---|
| `packages/ai/src/types.ts` | `ApiFormat` union 加 `'bedrock' \| 'vertex' \| 'gemini'` |
| `packages/ai/src/runtime-adapter.ts` | `inferApiFormatFromLegacyProviderType` 改为返回真实协议(bedrock/vertex/gemini 不再撒谎) |
| `packages/ai/src/providers/all.ts` | 注册新 provider |
| `packages/ai/src/providers/create-provider.ts` | 支持 `wrappers: Wrapper[]`,默认按 `model.compat` 自动 inject |
| `packages/ai/src/api/anthropic-messages.ts` | 删除 MiniMax 域名正则 / adaptive thinking 内嵌逻辑(`isMiniMaxEndpoint` 等)——改由 wrapper 处理 |
| `packages/ai/src/api/openai-completions.ts` | 删除 5-case `thinkingFormat` switch ——改由 wrapper 处理 |
| `packages/ai/src/providers/anthropic.ts` / `glm.ts` / `kimi.ts` / `minimax.ts` / `qwen.ts` 等 | 显式声明需要的 wrapper(可选,不声明走默认 compat → wrapper 映射) |
| `docs/design-docs/2026-07-29-multi-model-reasoning-architecture.md` | 增补「Phase 8 wrapper 层」章节(可选,可放在 plan body 内) |
| `docs/exec-plans/README.md` | 把 451 加到 Infrastructure & Research 表 |

### 不改

- `packages/ai/src/api/emit-sse.ts` — 已经是对的位置,继续作为内部 → 公开 SSE 的归一化边界
- `packages/ai/src/utils/*` — 共享 util 不动,只是 wrapper 会引用它们
- `packages/agent/src/llm/*` — agent 侧只通过 `createAIClient` 工厂消费 `ProviderRuntimeConfig`,不变
- `SSEEvent` 17 个 type 字面量契约(plan 310 §3.2 不可破坏)
- `LLMClient.streamChat` 接口契约(plan 310 §3.1 不可破坏)

---

## Phases

### Phase 0: Wrapper 基础设施 (P0 基础设施先行)

- [ ] 新建 `packages/ai/src/providers/wrappers/compose.ts`(`Wrapper` 类型 + `pipe()`)
- [ ] 新建 `packages/ai/src/providers/wrappers/index.ts`(barrel,re-export 所有 wrapper)
- [ ] 扩 `packages/ai/src/providers/types.ts` 的 `Provider` 接口:加可选 `wrappers: Wrapper[]`
- [ ] 扩 `create-provider.ts`:`createProvider({ wrappers })` 在内部把 `pipe(api, ...wrappers)` 组合
- [ ] 写 `compose.test.ts`:验证 `pipe` 顺序、短路、类型
- [ ] 验证:`npm run build:agent && npm run typecheck:all` 通过,既有 provider(不传 wrappers)行为不变

### Phase 1: 家族级 wrapper 抽取 (P0)

> 从 `api/*.ts` 把家族差异抽到 wrapper。这是 plan 的"清理债务"段,不增加新功能,只移动代码。

- [ ] **anthropic-family-thinking-replay** — 从 `anthropic-messages.ts` 抽 `isMiniMaxEndpoint` + `resolveAnthropicThinking` + signature 累积逻辑
- [ ] **anthropic-family-tool-payload-compat** — 抽 `resolveToolResultTransport` + 相关形态修复
- [ ] **anthropic-family-cache-control** — 抽 `prompt-caching.ts` 的 `applyCacheControl` / `applyCacheControlToSystem`(注意:保留 utils,只把"apply 时机策略"挪到 wrapper)
- [ ] **anthropic-family-tool-references** — 抽 `supportsToolReferences` 处理路径
- [ ] **anthropic-family-thinking-budget** — 抽 `supportsThinkingTokenBudget` 预算注入
- [ ] **openai-family-thinking-format** — 抽 `openai-completions.ts:130-180` 的 `switch(format)`
- [ ] **openai-family-tool-pairing-repair** — 抽 `repairToolPairing` 整段(目前嵌在 openai-completions.ts 头部)
- [ ] **openai-family-usage** — 抽 OpenAI usage → 标准 usage 的归一(目前散在 utils/usage.ts)
- [ ] 每个 wrapper 至少 1 个单元测试(签名 / 形态 / 短路)
- [ ] 验证:既有 14+ provider 测试 0 改动通过(`npm run test -- @duya/ai`)

### Phase 2: 默认 compat → wrapper 映射 (P0)

- [ ] 在 `create-provider.ts` 加默认规则:`model.compat` 字段若未在 provider 显式 `wrappers` 里 override,自动 inject 对应 wrapper
- [ ] 验证:既有 minimax / glm / kimi 行为不变(`compat: { forceAdaptiveThinking: true }` 自动获得 `anthropicFamilyThinkingReplay`)
- [ ] 加测试:provider 不声明 wrappers,仅靠 compat 字段,行为与之前等价

### Phase 3: Bedrock Converse 协议 (P1)

- [ ] 新建 `packages/ai/src/api/bedrock-converse.ts`(参考 openclaw `bedrock-converse-stream.ts` / pi 同名)
  - AWS SigV4 签名(`@aws-sdk/signature-v4`)
  - `InvokeModelWithResponseStream` 与 `ConverseStream` 二选一 — 推荐 ConverseStream(协议级统一)
  - 流式事件:`messageStart` / `contentBlockStart` / `contentBlockDelta` / `contentBlockStop` / `messageStop` / `metadata`
  - thinking / tool_use / signature 全部映射到 AssistantMessageEvent
- [ ] 新建 `packages/ai/src/providers/bedrock.ts`(providerId, region, model list, auth: AWS_ACCESS_KEY_ID + SECRET)
- [ ] 写单元测试:mock fetch,验证流式事件映射 / 错误分类
- [ ] 更新 `runtime-adapter.ts:131-148`:`case 'bedrock': return 'bedrock'`
- [ ] 更新 `types.ts:ApiFormat` union 加 `'bedrock'`
- [ ] 验证:`npm run typecheck:all && npm run test` 通过

### Phase 4: Gemini GenerativeLanguage 协议 (P1)

- [ ] 新建 `packages/ai/src/api/google-generative-ai.ts`
  - `streamGenerateContent?alt=sse` 端点
  - 鉴权:`x-goog-api-key` header(已在 runtime-adapter.ts:233 有 Gemini 分支)
  - 流式事件:`candidates[].content.parts[].text` / `functionCall` / `thought` / `usageMetadata`
  - thought signature 通过 `parts[].thoughtSignature` 透传
- [ ] 新建 `packages/ai/src/providers/google.ts`
- [ ] 单元测试
- [ ] 更新 `runtime-adapter.ts`:`case 'google': case 'gemini-image': return 'gemini'`
- [ ] 更新 `ApiFormat`

### Phase 5: Vertex AI Express 协议 (P1)

- [ ] 新建 `packages/ai/src/api/google-vertex.ts`
  - 复用 `google-shared` payload 转换(参考 openclaw `google-shared.ts` / pi `google-shared.ts`)
  - 鉴权:OAuth2 access token / service account ADC(暂用 access token,ADC 留 follow-up)
  - 端点:`<region>-aiplatform.googleapis.com` / `aiplatform.googleapis.com`
- [ ] 新建 `packages/ai/src/providers/vertex.ts`
- [ ] 单元测试
- [ ] 更新 `runtime-adapter.ts`:`case 'vertex': return 'vertex'`
- [ ] 更新 `ApiFormat`

### Phase 6: 注册表 + Provider Catalog (P1)

- [ ] 在 `packages/ai/src/providers/all.ts` 把新三个 provider 加入 `builtinProviders()` / `builtinModels`
- [ ] 在 `packages/ai/src/providers/index.ts` re-export 新文件
- [ ] 写 `packages/ai/test/providers-catalog.test.ts`:每个 provider 都能 `createProvider` 成功,`getModels()` 非空

### Phase 7: 文档 + ARCHITECTURE 同步 (P2)

- [ ] 更新 `ARCHITECTURE.md`「三层 wire-protocol」章节,加入 wrapper 层
- [ ] 更新 `docs/design-docs/2026-07-29-multi-model-reasoning-architecture.md` 加 Phase 8 章节(Wrapper 层),并标注 plan 451 实施
- [ ] 在 `packages/ai/README.md` 写「新增 provider 的 5 步流程」(决定协议 → 写/选 wrapper → 写 preset → 注册 → 测试)

### Phase 8: 测试 + 验收 (P2)

- [ ] `npm run typecheck:all` 通过
- [ ] `npm run test` 全部通过
- [ ] `npm run electron:build` 通过
- [ ] 手动 e2e 跑通(在 Electron renderer 里):
  - bedrock 模型列表可见、能 stream
  - google gemini 模型能 stream
  - vertex 模型能 stream
  - 既有 minimax / glm / kimi 行为不变(compat 字段自动 apply)

---

## 不可破坏的契约(沿用 plan 310 §3)

- `LLMClient.streamChat` 返回 `AsyncGenerator<SSEEvent, AssistantMessage, unknown>`
- `streamChat` options 必含 `effort?` / `maxOutputTokens?`
- `SSEEvent` 17 个 type 字面量(plan 310 §3.2)不变
- Worker 事件契约(`worker-protocol.ts`)不变
- `inferApiFormatFromLegacyProviderType` 签名不变,但**返回值的真实性提升**(bedrock/vertex/gemini 不再撒谎)

## 与既有 plan 的关系

- **plan 310**(多模型推理架构)— 已落地 `packages/ai` 基础 + 4 个 wire-protocol。451 是其 Phase 7/8 的实体化。
- **plan 418**(工具协议适配)— 抽 `toolResultTransport` / `supportsToolReferences` 是 plan 418 的产物,451 把它们搬进 wrapper。
- **plan 440**(Provider 流解析覆盖度)Phase 3(bedrock/vertex/gemini 接入)— **合并到 plan 451 Phase 3-5**。440 后续只关心"协议内的 unknown block 怎么处理"(degrade 策略);协议本身的实现由 451 负责。440 README 状态行加引用「P3 由 plan 451 接管」。
- **plan 444**(Token 计量 / cache health)— 不重叠。
- **plan 441**(事件级 journal)— 不重叠。

---

## 验收门槛

| 阶段 | 验收 |
|---|---|
| Phase 0 完成 | `pipe()` 工作,有测试;既有 provider 行为不变 |
| Phase 1 完成 | 所有 wrapper 抽出,`api/*.ts` 体积下降 ≥ 20%(原 2154 行 anthropic 应降到 1500-1700 行,因为家族逻辑外移) |
| Phase 2 完成 | `findModelCompat` + 自动 inject wrapper 替代手动 if/else,既有测试无回归 |
| Phase 3 完成 | Bedrock 能 stream,带 thinking / tool_use,签名正确累积 |
| Phase 4 完成 | Gemini 能 stream,thought signature 持久化 |
| Phase 5 完成 | Vertex 能 stream,OAuth access token 模式可用 |
| Phase 6 完成 | `builtinProviders()` 包含新三家,`getModels()` 非空 |
| Phase 7 完成 | ARCHITECTURE.md / design-doc 同步,README 五步流程存在 |
| Phase 8 完成 | typecheck/test/build 全过,Electron 手动 e2e 三家至少各跑 1 个 round-trip 成功 |

---

## Out of Scope(后续 plan 跟进)

- **Azure OpenAI Responses**(plan 440 优先级 P3) — Phase 3 之后
- **OpenAI Codex Responses / ChatGPT-Responses** — Phase 4 之后
- **Mistral Conversations** — Phase 5 之后
- **Cloudflare AI Gateway binding** — Phase 6 之后
- **OpenRouter 图片生成**(`openrouter-images`) — 暂不在范围
- **provider-specific wrapper**:MiniMax 高速度模型 max_tokens 截断、Moonshot `<think>` 标签状态机、z.ai reasoning-effort 形状 — 这些是 Phase 1 家族 wrapper 落地后,各家**逐个**添加 wrapper 的工作(不在本 plan 主线)
- **API registry 多实例隔离**(openclaw `default-runtime.ts` Symbol.for 模式)— duya 当前是单实例,暂不需要