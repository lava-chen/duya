# Plan 462 — Provider 错误上浮与重连提示

## 背景

智谱 GLM 余额不足时返回：

```
429 {"type":"error","error":{"type":"rate_limit_error","code":"1113",
     "message":"[1113][余额不足或无可用资源包,请充值。][20260830103053d5cdf3ab34bf42fc]"}}
```

现状问题：

1. `classifyError` 只按 HTTP 状态分类 → 429 一律判定为 `RATE_LIMIT` → **可重试**。
   于是余额不足也会跑满 10 次指数退避（累计约 5 分钟），用户只能手动中断。
2. 用户看到的最终报错是未解析的原始串：`429 {"type":"error","error":{...}}`。
   `extractNestedProviderErrorMessage` 因为串以 `429 ` 开头、不是 `{`，直接解析失败。
3. 重连过程中 UI 没有任何提示。`withRetry` 会 yield `createRetryEvent`
   → worker 映射成 `chat:retry`，但：
   - `AgentToRendererMessage` 没有该变体；
   - `router.ts#normalizeWorkerEvent` 不认识，原样透传成 SSE 事件名 `chat:retry`；
   - 渲染层 switch 无 `retry` case → 丢弃；
   - `stream-session-manager#notifyRetryListeners` 定义了但**从未被调用**。

## 目标

1. **余额/配额类错误立即停止**：不可重试，直接上抛，前端错误条展示 provider 原文
   （如 `余额不足或无可用资源包，请充值。`），而不是跑满 10 次重试。
2. **重连过程可见**：每次重试前端显示 `原因（重新连接 1/10）`，原因取 provider 原始消息。
3. 可重试错误的终态报错也用清洗后的 provider 消息。

## 改动

### Phase 1 — @duya/ai 错误分类（`packages/ai/src/utils/errors.ts`）

- 新增 `APIErrorType.INSUFFICIENT_BALANCE`。
- 新增 `BILLING_SHORTFALL_PATTERNS`（中英文）：
  `余额不足` / `无可用资源包` / `请充值` / `账户余额` / `欠费` /
  `insufficient balance` / `insufficient_balance` / `out of balance` /
  `no available resource pack` / `balance is not enough`。
- 新增导出 `extractProviderErrorMessage(error)`：
  剥离 `^\d{3}\s+` 前缀 → `JSON.parse` → 下钻 `error.message` / `message` /
  `data.message` → 去掉 `[1113]`、`[20260830...]` 这类方括号噪声 → 返回人类可读文案。
- `classifyError`：在 status 分支**之前**先做账单模式匹配（这样 429/402/403 携带
  余额不足文案时都归到 `INSUFFICIENT_BALANCE`）。
- `isRetryableError`：`INSUFFICIENT_BALANCE` → `false`。
- `formatErrorForDisplay`：该类型直接返回提取出的 provider 文案（带兜底）。
- `createErrorEvent`：该类型 `code = 'insufficient_balance'`。
- `createRetryEvent(attempt, maxAttempts, delayMs, reason?)`：
  `data` 用人类可读原因，metadata 增补 `retryReason` / `errorType` / `statusCode`。

### Phase 2 — @duya/ai 重试事件（`packages/ai/src/utils/retry.ts`）

- 退避前用 `extractProviderErrorMessage(llmError)` 取原因，传给 `createRetryEvent`。
- `packages/ai/src/types.ts`：`system` 事件 metadata 增补 `retryReason?` /
  `errorType?` / `statusCode?`。

### Phase 3 — agent 侧转发

- `packages/agent/src/process/agent-process-entry.ts`：`case 'system'` 映射
  `chat:retry` 时带出 `errorType` / `statusCode` / `retryReason`。
- `packages/agent/src/agent/DuyaAgent.ts` 主循环 catch（约 2349 行）：
  用 `createLLMAPIError` + 提取后的消息与 `code` 构造 error 事件，
  替换裸 `error.message`。

### Phase 4 — electron 归一化

- `electron/types/agent-message-types.ts`：新增 `chat:retry` 变体。
- `electron/agents/server/router.ts#normalizeWorkerEvent`：
  `chat:retry` → `{ type: 'retry', data: { attempt, maxAttempts, delayMs, message, errorType, statusCode } }`。

### Phase 5 — 渲染层

- `src/lib/stream-session-manager.ts`：
  - `case 'retry': case 'chat:retry':` → `handleRetryEvent()`，
    调用 `notifyRetryListeners` 并设置 `statusText`，同时 `resetIdleTimeout`。
  - `normalizeStreamError` 前先剥离 `^\d{3}\s+` 前缀再走嵌套提取。
  - 终态（done/error）清空 retry 监听（`notifyRetryListeners(sessionId, null)`），
    签名改为允许 `null`。
- `src/components/chat/StreamingMessage.tsx`：
  `retryInfo` 存在时显示 `${message}（重新连接 ${attempt}/${maxAttempts}）`。

## 验收

- `npm run typecheck:all` 零错误。*(注：工作区存在与本次无关的存量在途错误——web `ExtensionsPage.tsx` 12 处、electron research 状态字段漂移——均非本计划引入；本计划改动的文件在 web/electron 两侧 tsc 0 错误。)*
- 造一个 429 + `余额不足` 的 provider 响应：不再重试，前端错误条显示
  `余额不足或无可用资源包，请充值。`。
- 造一个可重试的 429（无余额文案）：状态条显示
  `原因（重新连接 1/10）` → `2/10` …，次数用尽后错误条显示清洗后的原因。

## 状态

✅ 全部完成（2026-08-30）。单测：`packages/ai` errors/retry 24 通过（新增
INSUFFICIENT_BALANCE 分类 + provider 消息提取用例）；`src/lib/stream-session-manager`
19 通过（新增 retry 通知链路用例）。`npm run bundle:agent` 已重打 bundle 生效。
手动 e2e（真实 provider 429）待跑。
