# Plan 552: Compaction Consolidation — 压缩机制收敛（对齐 mcode v2 形态）

> 2026-09-19 立项。来源：duya vs minimax-code（E:\cloned-projects\minimax-code）压缩机制对比审计 +
> 用户指令"压缩机制从触发到续跑完美无瑕，吸收 mcode 等 harness 优点"。
> 侦察阶段全部结论均经主会话逐条亲自核实（grep + 读源），修正了初版对比报告的三处过时判断。

## 背景

压缩相关代码约 15K LOC（compact/ 4.5K + 编排 2.1K + 计量 2.1K + 持久化 6.5K），由
422 → 495 → 517 → 523 → 475 → 315 → 441 → 486 八个 plan 增量叠加而成，从未做过合并收敛。
mcode v2 的参照形态：单一 `beforeLlmCall` hook 探测 → 单一算法 → 单一 `replaceMessages` 决策 →
单一持久化调用；触发线只在一个 50 LOC 的 provider-budget 里算；无 cooldown 机器（失败 skip 下轮重评）。

### 侦察修正（与初版对比报告的差异，避免后续误判）

- **双写已解决**：`DuyaAgent.messages` 已是 timeline 派生 getter（plan 315/319 落地），
  `_pushDurable(messages,msg)` 的 `messages` 参数是 turn 本地工作数组，不是第二个持久化真相。
- **checkpoint 已在 rebase 事件内联**：`projectTimelinePersistenceMessages` 产出的 marker 行
  随 rebase `newMessages` 持久化，`COMPACTION_CHECKPOINT_ID_SUFFIX` 防独立重持久化（plan 441）。
- **session/db.ts 不是死文件**：双模式 shim（IPC 模式转发主进程 / CLI 独立模式直连 sqlite），
  plan 328 刻意设计。真正的死代码在别处（见 Phase 0）。

## 目标

1. 死代码清零；抑制机只剩活的一台且分类只有一处。
2. token 估算单一来源（`@duya/ai` canonical），context-window 解析单一实现（renderer 与 worker 共享）。
3. 触发探测单一函数（软阈值 + 硬上限 + 图片数一个 probe 产出），消除本地 `contextWindow` 漂移面。
4. 重注入单通道：`CompactionEntry.reinjectedSystemMessages` 唯一读者 `extractLegacySystemSegments`。
5. auth 抑制永久卡死 bug 修复（`onAuthRefresh` 零调用方 → auth 抑制加时间窗）。
6. `stripImagesFromMessages` no-op 实修（图片不再进入摘要模型输入）。

## 非目标

- 不改 rollout 存储格式（marker 行 + rebase 内联已是合理形态，迁移不划算）。
- 不删 session/db.ts（CLI 独立模式依赖）。
- 不动 plan 517/523 的 UI/i18n 范围；523 落地时改为扩展活机（CompactionManager.Suppression）而非复活五态机。
- 不引入 mcode 的 BPE tokenizer / 远程 count_tokens（provider 锚点 + canonical 估算已够，属 444 后续）。

## Phase 0 — 死代码与抑制机收敛 ✅

- [x] `compact/compactErrors.ts` 收缩：保留 `SummaryDegenerateError` / `SuppressReason` /
      `classifySuppressReason` / `suppressReasonMessage`；删 `SUPPRESS_*` / `SuppressState` /
      `CompactSuppression` / `classifyCompactFailure` / `isRetryableCompactFailure` /
      `reasonToSuppressState` / `suppressReasonToString` / `suppressStateToString` / `SUPPRESS_WINDOW_MS`
      （408 → ~140 LOC）。同步 barrel + 测试。
- [x] `CompactionManager.compact()` 错误分类改走 `classifySuppressReason`（替换内联
      isSizeError/isAuthError），`compaction_error` 事件附 `reason` + `userMessage`。
- [x] auth 抑制时间窗（`AUTH_SUPPRESS_WINDOW_MS`），修"一次 401 → 本会话自动压缩永久失效"。
- [x] 删 `compact/compact.ts`（`adjustSliceBoundary` 仅被 import 从未调用）；清 strategy 死 import
      与 controller 过时注释。
- [x] 删 `agent/session/compaction.ts`（CompactionStore，零调用方）。
- [x] 删 `session/index.ts` + `session/store.ts`（SessionManager/SessionStoreManager，全仓零引用）。
- [x] `CompactionManager.setSummarizer` 去掉无意义 strategy 分配；删 `onAuthRefresh` 死方法改由
      时间窗语义接管；`CompactionStats` 删恒 0 的 `messageCount`/`toolCallCount`。

## Phase 1 — Token 估算统一 ✅

- [x] `@duya/ai` 新增 `utils/context-window.ts`：`DEFAULT_CONTEXT_WINDOW` + `resolveContextWindow()`
      （capability → catalog → default，带 source），index 导出。
- [x] agent `compact/contextWindow.ts` 改为薄转发（内部 import 路径不变）。
- [x] renderer `useContextUsage.ts` 删本地 resolver/常量，改用共享实现。
- [x] `DuyaAgent._estimateSystemAndToolsTokens` 改委托 `estimateContextTextTokens`。
- [x] `PostCompactReinjector.estimateTokenCount` → `estimateContextTextTokens`（仅报表用途）。
- [x] `hooks/injection.ts estimateTokens` → `estimateContextTextTokens`（保留导出名）。
- [x] `memory-rollout/compactMessages.ts` `CHARS_PER_TOKEN=3` 收敛到 canonical 估算
      （enforceBudget 按实测密度折算 targetChars，CJK/ASCII 混合内容均不再系统性偏差）。
- [x] `os-context/fragment.ts` 常量改 import canonical `ASCII_CHARS_PER_TOKEN`。
- [x] `stripImagesFromMessages` 实修：用户消息图片块剥离 + 占位文本（mcode "[image]" 形态）。

## Phase 2 — 触发探测统一 ✅

- [x] `CompactionManager` 新增 `probeCompaction(messages)`：单函数产出
      `{ tokens, imageCount, imageTriggered, overTriggerLine, overHardLimit }` +
      `getTriggerLine()` / `getHardLimit()`。
- [x] `CompactionCoordinator.runPreTurn` 改用 probe（保留 517 冷却门与抑制语义）。
- [x] DuyaAgent 中环 preflight 改用 probe 的 `overHardLimit`（删本地 `contextWindow` 比较漂移面）。
- [x] 触发拓扑文档化：soft(runPreTurn, 带冷却) / hard(中环, 不带冷却) / emergency / manual /
      model-switch 五种语义触发，共享同一线缆来源。

## Phase 3 — 重注入单通道 ✅

- [x] `PostCompactReinjector.reinject` 返回 `systemSegments`，不再注入 `role:'system'` 到
      result.messages。
- [x] `EnhancedCompactionResult.reinjection.systemMessages` 承载；controller 直接读取，
      删"扫 result.messages 找 system-role"的脆弱启发式。
- [x] 通道契约文档化：producer（reinjector/legacy_system 捕获/bot postSummarySections）→
      `CompactionEntry.reinjectedSystemMessages` → 唯一读者 `extractLegacySystemSegments`；
      over-threshold 会计把恢复段 token 加回，保持 517 loop-brake 语义。

## Phase 4 — 持久化收口

- [x] 核验 `session/db.ts` 附件读路径：parsed-document 三函数已有 IPC 分支；原始附件行
      （getAttachmentsForMessage / getAttachmentsForSession / deleteAttachmentsForSession）
      **刻意保持直连** —— pre-329 数据仍在 legacy `message_attachments` 表（plan 329 迁移
      未落地），改读 core stores 会静默丢失旧会话附件。已在源码加 audit note，
      收口动作归属 plan 329。
- [x] ARCHITECTURE.md 压缩段落纠偏：删除重复的 Plan 517 段落（既有文档 bug）、更新 422
      Robustness 行、新增 Plan 552 收敛章节。
- [x] 过时注释清理（controller adjustSliceBoundary 引用等，Phase 0 已完成）。

## 验收门禁

- [x] `npm run typecheck:all` 绿（web/agent/cli/conductor/voice 全绿）。
- [x] `npx vitest run` 全仓：8099 通过；剩余失败经与 master 基线逐一比对为既有/偶发
      （anthropic-thinking 6、bedrock 1、tests/unit/Compact 旧 API 桩 12、AgentTool/
      agent-profile/plan486/plan315-deferred 等），本分支改动区域 0 失败。
- [x] `npm run build:agent && npm run bundle:agent` 成功（4.99 MB bundle）。
- [x] `npm run electron:build` 完整构建成功（触及 @duya/ai 导出面，按 build gate 要求执行）。
- [x] 触发 → 压缩 → 持久化 → 重启重建 全链路单测覆盖（compact/message/agent 目录
      245+ 测试全绿；coordinator 冷却契约、plan315 checkpoint 重启重建用例更新为新契约）。

## 决策日志

- 2026-09-19: 全部 Phase 0-4 + 门禁完成（7 commits）。执行中发现并修复两处自引入回归：
  coordinator 冷却门内的 shouldCompact 兜底被急切求值（plan 517 契约回归，改回惰性短路）；
  coordinator 测试桩缺 isSuppressed。plan315 checkpoint fixture 按 552 新契约更新。
- 2026-09-19: 全仓 vitest 存在 master 上同样存在的既有失败（anthropic-thinking、bedrock、
  tests/unit/Compact 旧 API 桩、AgentTool/agent-profile 等），经逐一基线比对确认与本分支无关；
  tests/unit/Compact/CompactionManager.test.ts 整体过期（调用 59e9cbd8 重写前的 API），建议另立清理项。
- 2026-09-19: 初版对比报告称"7 个持久化面/双写/5 触发点全活"——侦察证伪双写与 checkpoint 部分，
  计划范围据此收窄；死代码清单（五态机/adjustSliceBoundary/CompactionStore/SessionManager）经 grep 证实。
- 2026-09-19: 采纳 mcode 三点优点：单源触发线、摘要输入图片剥离、失败分类单一函数；
  不采纳：BPE tokenizer（成本/收益不匹配 444 已有锚点方案）、压缩失败无冷却（517 冷却修复过真实
  26 次循环 bug，保留）。
