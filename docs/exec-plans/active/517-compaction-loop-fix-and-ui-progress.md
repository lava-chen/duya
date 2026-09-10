# 517 — Compaction Loop Fix + UI Progress

> **Author**: 2026-09-10 · **Status**: Planning · **Priority**: P0

## 1. Problem

用户报告两类问题：

1. **阈值错位**：1M 上下文模型在使用到 ~200k 时就开始自动压缩 → 阈值被夹到 200k 量级。
2. **压缩循环**：compaction 完成后，仅 2 次工具调用 + 1 段思考后又触发自动压缩 → token 浪费 + 有效信息越压越少 + 循环死锁。
3. **UI 黑盒**：自动压缩 UI 只显示 "Compacting context..."，用户看不到正在执行 projection / cut / summarize / reinject / trim / journal 等子步骤。

第二个问题最严重 — 一旦进入循环，每次 compaction 都会消耗 summary 模型调用 token + 改写 CompactionEntry + 推 journal rebase event（plan 441），但上下文实际并没有按比例缩小，agent 完全卡死。重复报告后用户最终得到一个"只剩 summary"的 session，根本无法推进工作。

## 2. Root Causes（证据链）

### R1. `DEFAULT_CONTEXT_WINDOW = 200_000` fallback 在运行时被错误命中

证据链：

- `packages/agent/src/compact/types.ts:54` `DEFAULT_CONTEXT_WINDOW = 200_000`
- `packages/agent/src/agent/DuyaAgent.ts:494-505` 构造函数：
  ```ts
  const capabilityContextWindow = options.runtimeConfig?.modelCapabilities?.contextWindow;
  this.compactionManager = createCompactionManager({
    maxTokens: typeof capabilityContextWindow === 'number' && capabilityContextWindow > 0
      ? capabilityContextWindow
      : undefined,   // ← fallback 到 DEFAULT_CONTEXT_WINDOW = 200_000
    ...
  });
  ```
- `packages/agent/src/agent/DuyaAgent.ts:984-1006` streamChat 模型切换时通过 `updateMaxTokens(contextWindow)` 重设，但仅在 `previousContextWindow !== contextWindow` 时触发
- `electron/services/providers/provider-store.ts:672-722` `resolveRuntimeCapability()` 三层兜底（config marker → DB override → `allProviderModels`），任何一层 miss → capability = undefined → fallback 200K
- 第三方中转或自定义 id（如 `anthropic/claude-sonnet-4-5` 经 OpenRouter）不在 `packages/ai/src/models.ts` 的 `allProviderModels` 里精确匹配 → baselineCap = undefined → fallback 200K

**症状**：1M 模型实际阈值 `200_000 - 16_384 = 183_616 tokens`，与用户报告的"200k 触发"完全吻合。

### R2. `setObservedPromptTokens` + `clearObservedPromptTokens` 的接缝

证据链：

- `CompactionManager.compact()` 成功后调 `clearObservedPromptTokens()`（line 396）→ 下次 `contextSize()` 走 `computeContextEstimate` fallback
- `packages/ai/src/utils/context-estimate.ts:319-325` projection 含 `isCompactBoundary` 标记 + boundary 后无 anchor → 返回 `usedTokens: null`
- `contextSize()` line 485：`return est.usedTokens ?? 0` → 0
- 下一轮 LLM 调用前 `shouldCompact()`：`0 > 184_000` → false → 安全（这条本身 OK）

但问题在 **R3**。

### R3. compact 完成后再次 shouldCompact 立即触发（loop root cause）

证据链：

- `packages/agent/src/agent/DuyaAgent.ts:1594`：
  ```ts
  if (imageTriggered || this.compactionController.shouldCompact()) {
  ```
  这条 **没有 turn-based cooldown / min-turns-since-last-compact 保护**
- `packages/agent/src/agent/DuyaAgent.ts:1576-1632` 是 loop 的 turn-start checkpoint，每次 turn 开始都重新评估
- `CompactionManager.compact()` 完成后 `lastCompactionAt` 被 `onCompactionSuccess()` 更新（line 252），但 **`lastCompactionAt` 在 `getStats()` 里只 readout，agent 端没有任何消费方**（grep 全仓零引用）
- `overThresholdAfterCompact` flag 在 `EnhancedCompactionResult` 算出来（line 448）但**没有任何消费方**（grep 全仓零引用除自指）— dead code
- 真正的 loop 触发条件：
  1. LLM 第 1 轮（compaction 完成后）— system + summary + retained + tool prompt + reinject + 1-2k 新增 user msg → `observedPromptTokens` ~150-180K
  2. LLM 第 2 轮（工具调用）+ 1 段思考 → 加 tool_use + cache_miss 重写 → `observedPromptTokens` 攀升到 ~200K
  3. LLM 第 3 轮（tool_result 后）→ 再加 tool_result + reasoning → `observedPromptTokens` 越线 → `shouldCompact() = true`
- 加上 R1（maxTokens=200K），阈值是 ~184K，所以 **2-3 轮内必再触发**

### R4. `keepRecentTokens` 默认 20K + reinject 总量仍超阈值

证据链：

- `packages/agent/src/compact/tokenBudgetCut.ts:35` `DEFAULT_CUT_CONFIG.keepRecentTokens = 20_000`
- Compaction 后 `[summary + retained(20K) + system_prompt + reinject(files/skills/tools) + runtime_context(hooks)]` 的实际 LLM 请求 token（不是 messages estimate），可能轻易超过 `maxTokens - reserveTokens`
- 特别在 R1 200K 阈值场景：system prompt (30-60K) + tools (10-30K) + summary (1-3K) + retained (20K) + reinject (10-50K) + 新增 (5-20K) → **150-200K**，循环边缘

### R5. UI 进度只有 4 类事件、5 个状态

证据链：

- `packages/agent/src/compact/CompactionManager.ts:121-126`：
  ```ts
  export type CompactionManagerEvent =
    | { type: 'compaction_start'; strategy: string }
    | { type: 'compaction_complete'; result: CompactionResult }
    | { type: 'compaction_error'; error: string; suppressed?: boolean }
    | { type: 'reinject_complete'; files: number; skills: number }
  ```
- `packages/agent/src/process/worker-protocol.ts:523-530` SSE 转发：`compact:start | compact:done | compact:error` 三种
- `src/stores/compaction-store.ts:22` `CompactionPhase = 'idle' | 'compacting' | 'done' | 'error' | 'degraded'` — 5 个粗粒度状态
- `src/i18n/en.ts:354` 文案：`'streaming.toolAction.compact.inProgress': 'Compacting context...'` — 一行盖全场

## 3. 设计目标

- **修 R1**：200K fallback 必须可观测 + 必须有显式 override（config / DB / 启动 warning 三路兜底）
- **修 R3**：compaction 成功后必须有最小间隔（turn 数 / 观察到的 token 实际下降量），保证不会再下一轮立即再次触发
- **修 R5**：UI 显示 6-8 个具体步骤 + 各自进度数字（消息数 / token 数 / 文件数）
- **副作用保护**：保留 plan 422 已经落地的 fail-closed 抑制（auth/size/other）和 panic fall-back trim
- **不引入**：新持久化表 / 新协议字段 / 新 IPC；只在既有通道内增强

## 4. 分阶段实施

### Phase 1 — 修 R1（maxTokens 兜底）— **必做，1-2 commit**

#### P1.1 启动期 capability 解析审计日志
- 文件：`electron/agents/agent-communicator.ts:170-200`、`electron/services/providers/provider-store.ts:672-722`
- 在 `resolveRuntimeCapability()` 解析后、注入 `runtimeConfig.modelCapabilities` 前加一行 `logger.warn` 或 `logger.info`（取决于 fallback 命中）：
  - 命中（1M 实际填上去）：`info` 级别，写明 `{ modelId, baseline, contextWindow, source: 'config' | 'db' | 'preset' }`
  - 兜底（命中 200K fallback）：`warn` 级别，写明 `{ modelId, resolved: undefined, fallbackTo: 200_000 }`
- 验证：用户在 app.log 看到 `compaction contextWindow fallback to 200000 for modelId=...` 警告立刻就能定位

#### P1.2 config.toml override 路径增强
- 文件：`electron/services/providers/provider-store.ts:696-703`
- 现有 config marker `[options.model_context]` 已有，但路径不直观。在 `electron/README` / 用户文档 / `Provider` 设置面板 tooltip 三个位置明示：
  - 兜底优先级：`config.options.model_context` > DB override > 内置 `allProviderModels`
  - 写法示例：
    ```toml
    [options]
    model_context = { "anthropic/claude-sonnet-4-5" = 1000000 }
    ```
- 范围仅文档 / tooltip，不改 store 逻辑

#### P1.3 测试覆盖
- 新增 `electron/services/providers/__tests__/provider-store.test.ts` 单测覆盖 fallback 三层（preset / DB / config）
- 验证：1M 自定义 modelId 在没有 override 时，`warn` 日志被触发 + cap 落 200K
- 验证：1M 自定义 modelId + config override 时 cap 落 1M

### Phase 2 — 修 R3（compaction loop 最小间隔）— **必做，1-2 commit**

#### P2.1 `lastCompactionAt` 真正落地为冷却闸
- 文件：`packages/agent/src/agent/DuyaAgent.ts:1594-1632`
- 在 proactive compaction 检查点前加 gate：
  ```ts
  const turnsSinceLastCompact = turnCount - this.lastCompactionTurn;
  if (turnsSinceLastCompact < MIN_TURNS_SINCE_COMPACT) {
    logger.debug(`[Agent] Skipping proactive compaction: only ${turnsSinceLastCompact} turns since last compact (min=${MIN_TURNS_SINCE_COMPACT})`);
  } else if (imageTriggered || this.compactionController.shouldCompact()) {
    // 现有触发逻辑
  }
  ```
- 默认 `MIN_TURNS_SINCE_COMPACT = 3`（Pi 风格：让 compact 后 agent 至少跑 3 轮 tool-use 再评估）
- 通过 `CompactionManagerConfig.minTurnsSinceLastCompact` 可配；首条 config default = 3
- `lastCompactionTurn` 在 `streamChat` 入口初始化为 `turnCount`，每次 compact 成功后更新

#### P2.2 `overThresholdAfterCompact` 真正成为 loop brake
- 文件：
  - `packages/agent/src/compact/CompactionManager.ts:130-135`（加 event 类型）
  - `packages/agent/src/agent/DuyaAgent.ts:1594-1632`（消费 event）
- 在 `EnhancedCompactionResult.overThresholdAfterCompact = true` 时，emit 额外事件 `{ type: 'compaction_over_threshold'; tokensRetained; available }`
- agent 收到后：
  1. 调 `compactionManager.suppress('size')` 直到下一次 successful compact 把 retained 降下来（已有 suppression 机制，复用）
  2. emit SSE `compact:over_threshold` 给前端，前端可显示 "Retained tokens still over budget — auto-suppressing further auto-compaction until next drop"
- 这是 **plan 422 设计了但未消费**的 dead code，本次闭环

#### P2.3 `lastCompactionAt` token-based 补充保护
- 文件：`packages/agent/src/agent/DuyaAgent.ts`
- 在 P2.1 的 turn-based gate 之上加 token-based 补充：
  ```ts
  const tokensSinceCompact = currentObservedPrompt - tokensAtLastCompact;
  if (tokensSinceCompact < MIN_TOKENS_GROWTH_SINCE_COMPACT) {
    return skip; // 至少新长出 30k tokens 才考虑再次 compact
  }
  ```
- 默认 `MIN_TOKENS_GROWTH_SINCE_COMPACT = 30_000`
- 二者取 OR（满足任一即可放行），保持原有的 over-budget 紧急 trigger 仍能工作

#### P2.4 测试
- `packages/agent/src/compact/__tests__/CompactionManager.cooldown.test.ts`：
  - turn-based gate：3 turns 内连续 shouldCompact() → false
  - token-based gate：增长 < 30k → false
  - 二者满足其一 → true
  - imageTriggered 紧急触发绕过 gate（grok 风格）
- `packages/agent/src/agent/__tests__/DuyaAgent.compaction-gate.test.ts`：mock streamChat 跑 6 turns，验证 compaction 只触发一次

### Phase 3 — 修 R5（UI step-by-step 进度）— **必做，2-3 commit**

#### P3.1 CompactionManager 新增 step events
- 文件：`packages/agent/src/compact/CompactionManager.ts:121-126`
- 新增 5 个 step event 类型：
  ```ts
  | { type: 'compaction_step'; step: 'project' | 'cut' | 'summarize' | 'rebuild' | 'reinject' | 'trim'; messageCount?: number; tokensBefore?: number; tokensAfter?: number }
  | { type: 'compaction_progress'; step: 'summarize'; tokensProcessed: number; tokensEstimated: number }
  | { type: 'compaction_over_threshold'; tokensRetained: number; available: number }  // P2.2 引用
  ```
- `compact()` 内每个阶段前后都 emit step：
  - 进入：`project`（开始投影）+ 输入消息数 + 估算 token
  - 进入：`cut`（找切割点）+ 切割点位置
  - 进入：`summarize`（调 summary 模型）— **进度可更新**
  - 进入：`rebuild`（重建 messages）
  - 进入：`reinject`（文件/技能/工具回注）
  - 进入：`trim`（panic fall-back trim，仅 over budget 时）

#### P3.2 SSE 转发 + worker-protocol
- 文件：`packages/agent/src/process/worker-protocol.ts:523-530`
- 新增：`compact:step` / `compact:progress` / `compact:over_threshold`
- `CompactStreamEvent` union 扩展

#### P3.3 前端 store 扩展
- 文件：`src/stores/compaction-store.ts:22`
- 新增 `CompactionPhase` 枚举：
  ```ts
  export type CompactionPhase =
    | 'idle' | 'projecting' | 'cutting' | 'summarizing'
    | 'rebuilding' | 'reinjecting' | 'trimming'
    | 'done' | 'error' | 'degraded' | 'over_threshold';
  ```
- 新增 step 字段：`currentStep: CompactionPhase`、`progress?: { tokensProcessed; tokensEstimated }`、`messageCount?: number`

#### P3.4 前端 i18n 文案
- 文件：`src/i18n/en.ts`、`src/i18n/zh-CN.ts`
- 每 step 独立文案：
  - `'streaming.toolAction.compact.inProgress.projecting'`: '正在投影上下文...'
  - `'streaming.toolAction.compact.inProgress.cutting'`: '正在定位安全切割点...'
  - `'streaming.toolAction.compact.inProgress.summarizing'`: '正在压缩总结（{tokensProcessed}/{tokensEstimated} tokens）...'
  - `'streaming.toolAction.compact.inProgress.rebuilding'`: '正在重建消息结构...'
  - `'streaming.toolAction.compact.inProgress.reinjecting'`: '正在重新注入文件、技能与工具上下文...'
  - `'streaming.toolAction.compact.inProgress.trimming'`: '仍超阈值，正在裁剪...'
  - `'streaming.toolAction.compact.overThreshold'`: '压缩后仍超阈值，已暂停自动压缩直至下次收缩'
  - `'streaming.toolAction.compact.doneWithStats'`: '已压缩：{tokensBefore} → {tokensRetained} tokens（{strategy}）'

#### P3.5 MessageList 渲染 step 行
- 文件：`src/components/chat/MessageList.tsx`（搜索现有 compact 行渲染）
- 把单行 `'Compacting context...'` 替换为带 step icon + 当前 step 文案 + 进度数字的复合行
- 数字实时更新（progress 事件驱动）
- 进度条：可选 Phase 3.5a 阶段加，未在主计划范围

#### P3.6 测试
- `packages/agent/src/compact/__tests__/CompactionManager.steps.test.ts`：mock summarizer 验证每个 step event 在正确时机被 emit
- `src/stores/__tests__/compaction-store.test.ts`：step 事件 → phase 转换正确
- `e2e/playwright` 验证 UI 显示 step（手动验证步骤列出）

### Phase 4 — 验证 + 文档 — **1 commit**

#### P4.1 端到端验证
- `npm run typecheck:all`
- `npx vitest run packages/agent/src/compact packages/agent/src/agent packages/agent/src/message`
- `npx vitest run src/stores`
- e2e smoke：`npm run test:e2e:ipc`（如果覆盖到 compaction 路径）

#### P4.2 ARCHITECTURE.md 更新
- 章节：Context Compaction（plan 422 已立）
- 补充：capability 解析失败兜底警告 + turn/token-based cooldown + step 进度事件
- 章节末尾加 "Common pitfalls"：compaction loop / 200K fallback / observe vs estimate 不一致

#### P4.3 plan 移到 completed/
- 完成最后一条 commit 后，把本文件移到 `docs/exec-plans/completed/517-compaction-loop-fix-and-ui-progress.md`
- 更新 `docs/exec-plans/README.md`：active 表删除 + completed 表登记

## 5. 验收标准

- [ ] **R1 修**：1M 自定义 modelId 在 config override 缺失时启动期 app.log 出现 `compaction contextWindow fallback to 200000` 警告
- [ ] **R1 修**：补 config override 后下次 streamChat 阈值升到 1M - 16K
- [ ] **R3 修**：compaction 完成后 3 turns 内连续 tool-use 不再触发 auto-compaction
- [ ] **R3 修**：即使 token 仍超阈值，compaction 完成后 3 turns 内不再触发（P2.2 over_threshold suppression）
- [ ] **R3 修**：超过 3 turns 且 token 增长 ≥ 30k，恢复正常 trigger
- [ ] **R3 修**：imageTriggered 紧急 trigger 仍能绕过 gate（grok 兼容性）
- [ ] **R5 修**：UI 压缩行显示当前 step + 进度数字（summarize 阶段显示 `tokensProcessed/tokensEstimated`）
- [ ] **R5 修**：overThresholdAfterCompact=true 时 UI 显示"已暂停自动压缩"特殊文案
- [ ] 单元测试全绿；typecheck:all 全绿
- [ ] 真实 1M 模型跑 30-turn 长 session 无 compaction loop（手动 e2e 记录）

## 6. 风险与回滚

- **风险**：P2.1 cooldown 太激进，紧急场景（用户 prompt 极大）3 turns 内不会被压缩
  - 缓解：紧急 trigger（imageTriggered）走 `force: true` 路径绕过 gate
  - 缓解：`MIN_TURNS_SINCE_COMPACT` 通过 config 可调，默认 3 较保守
- **风险**：P2.2 over_threshold suppression 让 user 看不到"卡住"的 hint
  - 缓解：UI 显式显示 `over_threshold` 状态文案（"已暂停自动压缩"）
- **风险**：P3.x step events 增加 IPC 流量
  - 缓解：step event payload < 200 bytes；不增加持久化
- **回滚**：每个 Phase 单独 commit + 单独 revert 安全；plan 422 基础未动
- **不动**：plan 422 已落地的 fail-closed 抑制、panic trim、reinjector、memory flush、prefire

## 7. 跨 plan 协调

- **plan 475（Bot 压缩增量）**：P2.x cooldown 默认值适合 bot 场景；bot 长会话场景默认 3 turns 偏小，可能想 5，但 bot 单独 plan 里建议调，不要在本 plan 引入 bot 特殊路径
- **plan 508（Bot 主动压缩报 Agent not initialized）**：独立修复，不与本 plan 冲突
- **plan 441（事件粒度 journal）**：P3.x step events 不引入新的持久化事件类型，仅在 SSE 上走
- **plan 315（agent-message-domain-framework）**：timeline / compaction entry 链路不变

## 8. 决策记录

- **2026-09-10 立 plan**：用户报告 compaction loop + 1M 阈值 fallback + UI 黑盒三个问题合并处理
- **2026-09-10 设计决策**：cooldown 选 turn-based + token-based 双闸 imageTriggered 紧急绕过（参考 Pi / grok 都用 turn 数而非纯 token 阈值，避免 cache_miss 抖动误触发）
- **2026-09-10 设计决策**：UI 进度不引入进度条组件，仅替换文案 + 加 step icon，避免引入新依赖
- **2026-09-10 设计决策**：P2.2 让 `overThresholdAfterCompact` 从 dead code 变 active loop brake，而不是新增字段，避免 schema 变更