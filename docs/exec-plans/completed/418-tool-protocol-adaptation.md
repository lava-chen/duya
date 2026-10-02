# 工具协议适配层 + Deferred Tools (Tool Protocol Adaptation)

> **Status**: ✅ Phase 1–5 全部完成 + SSE 容错加固（2026-08-11；待真实端点验证）
> **Priority**: P0
> **Created**: 2026-08-11
> **Depends on**: Plan 241 (应用层 tool_search，已完成), Plan 334 (模型兼容解析 DB 化，已完成)
> **Owner**: TBD

---

## 问题背景

用户配置 DeepSeek Anthropic 兼容端点（`provider=anthropic`, `model=deepseek-v4-flash`,
`baseURL=https://api.deepseek.com/anthropic`）后，带工具调用的对话直接 400：

```
Failed to deserialize the JSON body into the target type:
messages[4].content: unknown variant `tool_result`,
expected one of `text`, `tool_reference`, `image`, `document`
```

**根因**：该端点的 content 块枚举**不接受 Anthropic 标准的 `tool_use`/`tool_result` 内容块**。
而 `@duya/ai` 的 `toAnthropicMessages` 只输出这四种块（text/image/tool_use/tool_result），
没有适配路径。标题生成（纯文本、无工具块）同一端点成功 → 反证问题精确出在工具块序列化。

对照 Claude Code / pi（`packages/ai/src/api/anthropic-messages.ts`）的实现：

- pi 用**能力驱动**：`Model.compat.supportsToolReferences` + `deferredToolsMode`，转换器按能力
  决定输出什么 content 块，**不会把一个端点不接受的块发出去**。
- pi 的 `tool_reference`（deferred tools）是嵌在 `tool_result.content` 内部的块——**不能解决
  本 400**（DeepSeek 连 `tool_result` 顶层块都拒收）。因此本计划做两层：**序列化适配层**
  （直接解决 400）+ **deferred tools**（对齐 pi 框架，token 省，能力完整）。

---

## 现状（2026-08-11 代码扫描确认）

| 项 | 位置 | 现状 |
| --- | --- | --- |
| `ModelCompat` | `packages/ai/src/types.ts:302` | 只有 thinking 相关字段（`openAIThinkingFormat`/`forceAdaptiveThinking`/`fixedTemperature` 等），**无工具协议能力字段** |
| 兼容解析 | `packages/ai/src/models.ts:136` `findModelCompat(apiFormat, modelId, overrides)` | 从内置模型目录查 compat，无匹配 + 无 overrides → `undefined`（自定义 provider + 未知模型名 → 空能力，全部走默认） |
| Anthropic 客户端 | `packages/ai/src/api/anthropic-messages.ts:1510` `createAnthropicClient` | `streamChat` 内：`transformMessages` → `toAnthropicMessages` → 构建 params；`tools` 全量带上；无能力分支 |
| 消息转换 | `packages/ai/src/api/anthropic-messages.ts:1287` `toAnthropicMessages(messages, model, synthesize)` | 只输出 text/image/tool_use/tool_result 四块；**无 tool_reference / 文本回传形态** |
| 跨协议归一化 | `packages/ai/src/api/transform-messages.ts` | isSameModel 守卫 + 非视觉模型图像降级；无工具回传形态处理 |
| 重试层 | `packages/ai/src/retry-client.ts` `createAIClientWithRetry` | `withRetry` 处理瞬时错误（网络/429/5xx）；400 schema 错误走既有分类，**无降级适配** |
| 错误识别 | `packages/ai/src/api/anthropic-messages.ts:200` `isToolResultOrderingError` | 已有"识别端点错误特征"先例（tool_result 排序错误），本计划沿用该模式 |
| 端点推导 | `packages/ai/src/api/anthropic-messages.ts:150` `isMiniMaxEndpoint` / `isThirdPartyEndpoint` | 已有"按 baseURL 特征推导"先例 |
| Agent 请求链 | `packages/agent/src/agent/DuyaAgent.ts:1068` | `llmMessages`（含 tool_result 消息）→ `llmClient.streamChat(llmMessages, { tools, ... })`；`this.llmClient` 是 per-agent 实例（跨 turn 存活，可做会话级能力记忆） |
| 工具结果消息 | `packages/agent/src/agent/DuyaAgent.ts:1180-1240` | `executor.getRemainingResults()` → `result.message`（role:'tool' 或 tool_result 块）→ `_pushDurable`；**无 addedToolNames 概念** |
| 应用层工具发现 | Plan 241（已完成） | `tool_search` 元工具 + 动态 schema 注入（下一轮全量注入）；与传输层 deferred tools 正交 |

---

## 设计总览

三层 + 渐进降级（progressive degradation）：

```
┌─────────────────────────────────────────────────────────────┐
│ L0 标准形态  tool_use + tool_result 内容块（所有现有端点）      │
│   ↓ 400 unknown variant 自动降级                              │
│ L1 文本回传  tool_use 保留 + tool_result → 文本 user 消息       │
│   ↓ 仍 400（assistant 侧 tool_use 也不被接受）→ 由 agent 层提示 │
│ L2 无工具    tools 不传 + 提示模型工具不可用（会话级降级）        │
└─────────────────────────────────────────────────────────────┘
```

**核心原则**：
1. **能力声明优先**（模型目录 + 端点推导 + 配置覆盖），转换器按能力输出端点接受的形态——
   pi 同款哲学："不会把端点不接受的块发出去"。
2. **自动降级兜底**：400 反序列化错误 → 渐进降级重试一次 + 会话级记忆（per-client closure），
   配置没跟上时用户不会每轮都看到 400。
3. **与现有层正交**：`withRetry` 管瞬时错误；本计划管 schema 适配。降级在内层（anthropic
   client）完成，不改变 retry 层行为。
4. **deferred tools 对齐 pi**：`supportsToolReferences` + `splitDeferredTools` +
   `addedToolNames` + `tool_reference` 输出（嵌 tool_result 内部 + sibling text 分离）。

---

## Phase 1 — 能力声明层（先做，地基）

| # | 文件 | 改动 |
| - | --- | --- |
| 1 | `packages/ai/src/types.ts` `ModelCompat` | 新增：`toolResultTransport?: ToolResultTransport`、`supportsToolReferences?: boolean`（Phase 4 用）；`ToolResultTransport = 'tool-result-block' \| 'text-user-message'`（默认 `tool-result-block`） |
| 2 | `packages/ai/src/models.ts` | `findModelCompat` 保持签名不变（compat 字段新增后自动透传）；确认 `allProviderModels` 目录模型可声明新字段 |
| 3 | 内置目录声明 | `packages/ai/src/providers/*.models.ts`：anthropic 兼容端点相关条目（MiniMax 等）如需可声明；`deepseek.models.ts` 仅 openai-chat，无需动 |
| 4 | `packages/ai/src/api/anthropic-messages.ts` | 新增 `isDeepSeekAnthropicEndpoint(baseURL)`（host 含 `deepseek.com` 且路径含 `/anthropic`，仿 `isMiniMaxEndpoint`）；新增 `resolveToolResultTransport(baseURL?, compat?)`：compat 显式 > 端点推导 > 默认 `tool-result-block` |
| 5 | `packages/ai/src/runtime-adapter.ts` | 确认 `modelCompat` 流转路径无需改（`options.runtimeConfig.modelCompat` → `AIClientOptions.modelCapabilities` 已通）；如需要把 `baseUrl` 一并传给客户端做推导 |

**验证**：`npm run typecheck:all`；`findModelCompat` 单测补新字段断言。

## Phase 2 — 序列化适配层（解决 400 的主路径）

| # | 文件 | 改动 |
| - | --- | --- |
| 1 | `packages/ai/src/api/transform-messages.ts`（或新文件 `tool-result-text.ts`） | 新增 `textifyToolResults(messages: Message[]): Message[]`：把 `role:'tool'` 消息（及 tool_result 内容块）转成 `role:'user'` 文本消息，**语义保真**——文本内编码工具名、tool_use_id、is_error、原始内容（参考 OpenAI 工具消息文本化风格） |
| 2 | `packages/ai/src/api/anthropic-messages.ts` `createAnthropicClient` | `streamChat` 内：`const transport = resolveToolResultTransport(options.baseURL, options.modelCapabilities)`；当 `transport === 'text-user-message'` 时 `toAnthropicMessages(textifyToolResults(transformed), model)`（tool_use 保留在 assistant 消息里，仅工具结果文本化） |
| 3 | `packages/ai/src/api/anthropic-messages.ts` | `toAnthropicMessages` 内部对 `text-user-message` 形态的 tool 消息不再生成 `tool_result` 块（由 textifyToolResults 先行处理，双保险：转换器内也加形态守卫） |

**语义保真格式草案**（`textifyToolResults` 输出）：
```
[Tool result: Read (tool_use_id=toolu_01...)]
<file content...>
[Tool result ended]
```
错误结果带 `[Tool error]` 前缀。具体格式写进常量，测试断言。

**验证**：`packages/ai/test/anthropic-robustness.test.ts` 或新测试文件：text-user-message 形态下
输出不含 `tool_result` 块、工具结果文本可达模型、tool_use 保留、图片降级行为不回归。

## Phase 3 — 自动降级重试 + 会话记忆

| # | 文件 | 改动 |
| - | --- | --- |
| 1 | `packages/ai/src/utils/errors.ts` | 新增 `isToolSchemaMismatchError(err)`：400 + message 含 `unknown variant` / `deserializ` / `invalid_request_error`（仿 `isToolResultOrderingError` 模式） |
| 2 | `packages/ai/src/api/anthropic-messages.ts` `createAnthropicClient.streamChat` | 重构：把"构建请求 → 发送 → 解析"抽为内部函数；外层循环：先用当前 transport 构建，若抛 `isToolSchemaMismatchError` 且当前为 `tool-result-block` → 降级 `text-user-message` 重试一次；若 `text-user-message` 仍 schema 错误 → 抛错（由 agent 层决定是否 L2）。**会话级记忆**：transport 存 closure（client 实例跨 turn 存活），成功请求不重置 |
| 3 | `packages/agent/src/agent/DuyaAgent.ts` | （可选，Phase 3 收尾）当捕获"工具协议完全不支持"错误（L2）时，生成可操作错误提示；tools 降级为不传 + 系统提示说明（标记为 Phase 3 可选子项，避免本期过度膨胀） |

**关键约束**：降级只在**尚未 yield 任何内容事件前**发生（与 `withRetry` 的 hasYieldedContent 守卫同语义）；
流已开始后出错不降级，直接抛给上层。

**验证**：单测：schema 错误识别；L0→L1 降级后请求体形态正确；记忆：同 client 第二次调用直接用 L1。
`retry.test.ts` 既有行为不回归。

## Phase 4 — Deferred Tools（对齐 pi）

| # | 文件 | 改动 |
| - | --- | --- |
| 1 | `packages/ai/src/utils/deferred-tools.ts`（新建） | `splitDeferredTools(context, enabled, normalizeName)`：扫历史 `addedToolNames` → 拆 immediate/deferred；`getDeferredToolNames(messages)` |
| 2 | `packages/ai/src/types.ts` | `Message` / tool 消息加 `addedToolNames?: string[]`（对齐 pi `ToolResultMessage.addedToolNames`） |
| 3 | `packages/ai/src/api/anthropic-messages.ts` | `toAnthropicMessages` 加 `deferredToolNames` 参数；`convertToolResult` 输出 `tool_reference` 块（嵌 `tool_result.content`）+ sibling text 分离（Anthropic 拒绝混合）；tools 参数按 `splitDeferredTools` 结果拆分 |
| 4 | `packages/agent/src/agent/DuyaAgent.ts` | 工具执行结果携带 `addedToolNames`（plan 241 动态注入的工具名）；`createBuiltinRegistry` 注入点记录本 turn 新增工具 |
| 5 | `packages/agent/src/tool/registry.ts` / 动态发现 | 命中 `tool_search` 后注入的工具 schema 标记 `addedToolNames`（复用 plan 241 的注入路径） |
| 6 | 模型目录 | `supportsToolReferences` 按 pi 默认推导逻辑（anthropic 4.5+ 才支持；第三方端点默认 false） |

**验证**：`packages/ai/test/deferred-tools.test.ts`（仿 pi 的 deferred-tools.test.ts：tool_reference
块输出、sibling 分离、重复加载去重）；`packages/agent/tests/unit/` 新增 addedToolNames 流向测试。

## Phase 5 — 测试 + 文档收口

- `npm run typecheck:all` 必须通过（esbuild 不查类型）
- `npm run test` 全绿（新增：tool protocol 适配、降级、deferred tools 用例）
- `ARCHITECTURE.md`：Profile/Mode/Permission 或协议适配一节加本计划说明
- `docs/exec-plans/README.md`：Active Plans 表加 418 行；完成后移入 completed/

## SSE 容错解析（响应侧加固，2026-08-11 实测发现）

真实端点验证时发现 DeepSeek `/anthropic` 端点的**下一个**不兼容点：请求层修复后（L1 文本回传生效，无 400，thinking 正常流出），流式响应中某个 SSE 帧的 `data:` 行含非法 JSON，`@anthropic-ai/sdk` 的严格 `JSON.parse`（`core/streaming.js:36`）抛 `Expected double-quoted property name in JSON at position 72`，**整个流崩溃**（已 yield 的 thinking 不可重放，无法降级重试）。

**修复**（`packages/ai/src/api/anthropic-messages.ts` `createAnthropicClient.streamChat` 步骤 7-8）：

- 绕过 SDK 高层 `messages.stream()`（其逐帧严格 parse 不可拦截），改用低层组合：`client.post('/v1/messages', { body, stream: true, __binaryResponse: true })` 拿 raw fetch Response（`internal/parse.js` 中 `stream:true` 会短路 `__binaryResponse`，故 body 带 stream、opts 不带）+ SDK 导出的 `_iterSSEMessages(response, controller)` 解析 SSE 帧。
- 每个帧用 `parseJsonWithRepair`（新建 `packages/ai/src/utils/json-repair.ts`，自 pi 移植）解析：先严格 parse，失败则 `repairJson` 转义字符串内的裸控制字符（换行/tab 等）与非法反斜杠转义后重试；**修得好的帧内容完整保留**，只有修复不了的帧才跳过 + warn，流不崩。
- MiniMax 2013 / tool-ordering recovery 保留，重发同样走低层 open。
- `@anthropic-ai/sdk/internal/utils/values.js` 不在 SDK exports 白名单（`./internal/*` 未映射），`safeJSON` 不可 deep import，故用本地 `parseJsonWithRepair` 替代。

测试：`tool-protocol-adaptation.test.ts` 新增「skips malformed SSE frames instead of crashing the stream」（构造含非法 JSON 帧的 SSE 流，断言 done 事件仍到达 + warn 发出）与「repairs repairable SSE frames」（含裸 tab 的 text_delta 帧被修复、文本完整保留、无跳过 warn）；`json-repair.test.ts`（新建，9 条）覆盖 `repairJson` 控制字符转义/非法转义修复/合法输入原样；降级阶梯集成测试改用 `client.post` mock + raw SSE Response。`@duya/ai` 214 测试全绿，`typecheck:all` 通过。

## L1 传输层 + L2 意图一致性（2026-08-11 实测 DeepSeek 会话后追加）

对 DeepSeek 会话 rollout（`~/.duya/sessions/.../rollout-*562a9dce*.jsonl`）的完整分析发现两个新缺陷：

**现象 A「工具调用参数传丢了」**（模型自述，rollout seq 316/318）：
- 根因：`parseAnthropicEvent` 的 `content_block_start`(tool_use) 硬编码 `input: {}`，忽略事件里可能携带的完整 input——SDK 类型 `ToolUseBlock.input: unknown`（`messages.d.ts:1336`）允许端点直接在 start 事件带参数（DeepSeek /anthropic 兼容层即如此，其 tool_use id 为 OpenAI 风格 `call_00_/call_01_` 前缀）。
- **L1 修复**（`packages/ai/src/api/anthropic-messages.ts`）：start 事件读 `block.input` 作初始 input（再叠加 `input_json_delta`）；`content_block_stop` 时 JSON.parse 失败改用 `partialParse`（新建 `packages/ai/src/utils/partial-json.ts`，复用 SDK `_vendor/partial-json-parser`）恢复截断参数，仍失败才 `{}` + warn。

**现象 B「说到一半停」**（rollout seq 327：模型说"让我读取两个文件"但 0 个 tool_use 后直接结束；用户 328 追问"为什么不继续"）：
- 根因：duya 的 turn 终止判定是二元的（有 tool_use 继续 / 无 tool_use 停），缺「意图-动作一致性」校验；已有 goal premature-stop / todo gate / mailbox nudge 均不覆盖「工具意图声明但未发出 tool_use」的通用场景。
- **L2 修复**（`packages/agent/src/agent/tool-intent-detector.ts` 新建 + `DuyaAgent`）：检测 turn 结束文本最后段落的强工具意图（中英文意图短语 + 动作动词，保守锚定，复用 goal-stop-detector 的段落判定模式）→ 注入 `[System]` 继续 nudge（上限 `toolIntentNudgeMax`，默认 2，防空转）；`max_tokens` 停止时 fail 全部工具调用（对齐 pi `failToolCallsFromTruncatedMessage`，防截断参数执行）。

测试：`tool-protocol-adaptation.test.ts` +2（start 事件 input 保真、partial JSON 恢复）；`tool-intent-detector.test.ts`（新建 8 条：中英文意图/段落边界/误报控制/nudge 文案）。`@duya/ai` 与相关 agent 测试全绿。

---

## 风险

| 风险 | 应对 |
| --- | --- |
| DeepSeek 端点实际协议与假设不符（assistant 侧 tool_use 也可能被拒） | 降级到 L1 后仍 400 → L2（禁用工具 + 明确提示）；框架本身不假设端点细节，只做渐进适配 |
| `text-user-message` 形态下模型工具语义变弱（工具结果无结构化块） | 文本编码保留 tool name/id/error 标记；该形态仅用于兼容端点，标准端点不受影响 |
| 会话级记忆在多 provider 会话中串状态 | closure 状态绑定单一 client 实例；标题生成等辅助请求共用实例（无工具 → 不触发降级） |
| 降级与 `withRetry` 重试叠加导致请求翻倍 | 降级在 client 内部、withRetry 外层；降级只发生一次（L0→L1），不进入 withRetry 循环 |
| `supportsToolReferences` 误判导致 tool_reference 发给不支持端点 | 默认 false（仅显式声明/推导开启）；错误识别兜底 |
| Phase 4 改动面大（agent 层 addedToolNames 注入） | 单独立项推进，Phase 1-3 独立可用；Phase 4 完成后统一验证 |

---

## 不在本计划范围

- OpenAI / OpenAI-Responses 协议的 deferred tools（`deferredToolsMode: 'kimi'` 等）——留给后续计划
- 工具分档 UI / 用户配置界面（沿用 plan 334 的 `compatOverrides` 机制，无新 UI）
- DeepSeek 具体模型目录补全（`deepseek.models.ts` 只有 openai-chat 条目，anthropic 端点模型属自定义 provider，能力靠端点推导 + 降级兜底）

## MCP 工具默认暴露 + 权限门修复（2026-08-11 用户反馈）

用户反馈两个问题（duya 内 MCP codegraph 工具）：

**1. MCP 工具默认不在 tool 列表，agent 必须先 `tool_search` 才能用**

`apply.ts` 里 MCP 注册条目原本固定 `exposeMode: 'discoverable'`（Plan 241 为省 token 的旧设计），
导致所有 MCP 工具被 `isToolVisible` 排除在 base tools 之外。已改为 `exposeMode: 'always'`——
MCP 工具直接进首轮 tool 列表，schema 全量随请求发送（代价是 token 增加；deferred-tools
传输层（Phase 4 `tool_reference`）未来可在支持端点上重新收窄）。

**2. MCP 工具调用报权限错误**（`[MCP permission gate] ... requires explicit user approval. Switch the session to bypassPermissions or dontAsk...`）

两个根因：

- **门读不到真实权限模式**：`apply.ts` 原来读 `agent.activePermissionMode`，但 `DuyaAgent`
  上根本不存在该属性（`permissionMode` 是 private 且无 getter）→ 永远 `undefined` →
  即使 bypassPermissions / dontAsk 会话也被拦。已加 `DuyaAgent.getPermissionMode()` 并在
  executor 里读取。
- **`prompt` 决策被硬编码成报错**：门只有 allow/deny/prompt 三态，`prompt`（第三方工具默认态）
  直接返回错误文本让用户去切模式。现在 executor 在 `prompt` 且存在审批通道时，通过
  `ToolUseContext.requestPermission` 走标准 `chat:permission` → 渲染层 Allow/Deny 弹窗：
  allow 继续执行、deny 返回 `Permission denied by user`。已批准的 `toolUseId` 记录在
  `approvedMcpToolUseIds`（模块级）防重入重复弹窗。无审批通道（headless CLI / sub-agent）
  仍降级为硬错误。

测试：`packages/agent/tests/mcp/runtime-closure.test.ts` Case 12（7 条：默认暴露、bypass 免门、
allow 执行、deny 报错、无通道降级、已批准跳过、bundled 信任）；同时补齐了该文件 mock 的
`getActiveMCPManager` / `configSignature` / `extract` / `adopt` / `getConfig` / `mcpInfo.source`，
修复增量重连未提交代码导致的既有 14 条测试全红。
