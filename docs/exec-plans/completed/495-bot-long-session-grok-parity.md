# 495 — Bot 长会话 grok 对齐补差（后台预压缩 + 图片阈值 + 重试阶梯 + 抢占/Redrive 收口）

> **Status**: In progress · **Priority**: P1 · **Owner**: 495 session (2026-09-05)
>
> **前置**: 422（压缩收口，已归档）、474（epoch 双键，已落地）、475（bot 压缩增量，Phase 1/2/4 完成）、476（wake bus，P0–P2 已接线）。
>
> **来源**: 2026-09-05 对 `E:\cloned-projects\grok-bot-0.18-reconstructed` 的长 bot session 压缩与
> epoch 系统逐文件调研（summarization-orchestrator / self-summary / send-pipeline turnEpoch /
> turn-runtime 收尾护栏），对照 duya 当前实现后识别出四项差距。本 plan 逐项补齐。

## 1. 差距清单（调研结论）

| # | 差距 | grok 证据 | duya 现状 | 本 plan 动作 |
|---|------|-----------|-----------|--------------|
| G1 | 后台预压缩（pass1）+ 收割 + 前缀有效性校验 | `summarization-orchestrator.ts`：接近阈值即后台起摘要，`BackgroundAndPersistIfCompleted` 收割；前缀失效丢弃重算 | `SessionMemoryCompactStrategy.summarizeConversation()`（后台 pass1 钩子）与 `CompactOptions.previousSummary` 基建存在但**无任何驱动方**；压缩为同步阻塞式 | 新增 `BackgroundPrefire` 控制器（CompactionManager 方法 + controller 收割 + DuyaAgent 点火） |
| G2 | 图片数量阈值触发压缩 | `IMAGE_SUMMARIZATION_TRIGGER_COUNT = 85`（abstract-user-message-action-handler.ts:69） | 无 | DuyaAgent 检查点计数 image parts ≥ 85 → 强制压缩 |
| G3 | 抢占/Redrive 接线（476 §2.2/§6.4 P2 收口）+ run 收尾 epoch 护栏 | `turn-runtime.ts:368-404` superseded 取消；`:493/:556` 收尾副作用 epoch 护栏 | `decidePreemption`/`markRedriven` 纯函数已导出但无生产调用方；drain 对 busy 会话一律 park；runWake 收尾无 epoch 判定 | drain 接入抢占决策（interrupt 在途 wake run + displaced run 标记 isRedriven 回队）；runWake 返回后 epoch 不匹配 → 跳过 auto-return/收尾副作用 |
| G4 | 摘要重试阶梯（shorter-output 指令 + 输入缩减 + 3 次上限） | `self-summary-handler.ts`：MAX_SELF_SUMMARY_RETRIES=3、TOOL_MESSAGE_DROP_THRESHOLD=0.25、`reduceSelfSummaryInputMessages` | 单次 degenerate 重试，无错误分类、无输入缩减 | 新增 `summaryRetry.ts` 纯函数 + strategy 接线。双 summarizer 层（self=同模型 / external=compact_model 专用客户端）duya 已有，不重做 |

非差距（调研确认已覆盖，不重做）：

- **summaryArchives 留档**：duya 追加式 timeline + `CompactionEntry`（422/441）保留全部原始消息，
  可追溯性优于 grok 的 blob archive；475 P3.4 已有 won't-fix 决策记录。
- **turn_epoch E3 纯逻辑**：`packages/agent/src/wake/epoch.ts` 与 grok `SendPipeline.turnEpochs` 对齐，
  queue 级 superseded 丢弃已在 drain（wake-dispatcher.ts:302-315）。

## 2. 设计

### 2.1 G1 — BackgroundPrefire

- **触发**：DuyaAgent 每轮 LLM 调用前的 proactive 检查点（与 `shouldCompact` 同位），投影当前消息后调
  `compactionManager.maybeStartPrefire(projectedMessages)`。
  阈值：`usedTokens ≥ prefireStartFraction × (maxTokens - reserveTokens)`，默认 `0.75`（对齐 422 的
  75% prefire 起点；`0` 关闭）。已有 in-flight 或已有新鲜未消费结果时不重复启动。
- **指纹**：启动时记录投影消息 id 列表（timeline id 直通投影）。收割时校验「存储指纹是当前投影 id
  列表的前缀」——timeline 只追加，前缀成立即中间无压缩/无重写；不成立（prefix_invalid）丢弃。
- **收割**：`MessageCompactionController.compactProactive` 在调用 manager.compact 前，若存在已完成的
  新鲜 pass1 结果，作为 `options.previousSummary` 注入 → 主摘要变成对 pass1 的迭代更新（grok 两遍
  语义），而非全量重总结。
- **生命周期**：压缩成功 / `clearCache()` / 会话重置时清空；pass1 失败静默清空（best-effort，不进
  suppression）。

### 2.2 G2 — 图片阈值

- `IMAGE_COMPACTION_TRIGGER_COUNT = 85`（grok 对齐），计数实现为纯函数
  `countImagePartsInMessages(messages)`（user/assistant 消息 content blocks 中 `type === 'image'`，
  兼容 string content = 0）。
- DuyaAgent 两处检查点接入：turn 开始的 proactive 检查点（:1535 旁）与 preflight overflow 检查点
  （:2216 旁）。触发时 `compactProactive({ trigger: 'auto', force: true })`。

### 2.3 G4 — summaryRetry

- 纯函数模块 `packages/agent/src/compact/summaryRetry.ts`：
  - `classifySummaryError(err)`：`output_length`（max_tokens/length/输出截断类）| `input_length`
    （context_length/input too large 类）| `transient`（5xx/timeout）| `fatal`。
  - `appendShorterOutputInstruction(prompt)`：一次性的“输出减半”追加指令。
  - `reduceSummaryInputs(messages)`：输入缩减——中间消息 tool 消息占比 ≥ 0.25 时剔除 tool 相关块，
    否则砍掉中间段前半（保留系统前缀与末尾 prompt）；对齐 grok `reduceSelfSummaryInputMessages`。
  - `summarizeWithRetryLadder(run, ctx)`：最多 3 次；output_length → 加 shorter-output 指令重试；
    input_length → 缩减输入重试；transient → 原样重试；fatal → 直接抛。空/退化结果按一次重试处理。
- `SessionMemoryCompactStrategy` 主摘要调用改走 ladder（wall-clock budget 包裹保留在 strategy 内）。

### 2.4 G3 — 抢占/Redrive 收口（476 §6.4 修正后的形态）

- `WakeDispatcherDeps` 增加可选 `interruptRun(sessionId)`；生产接线 `interruptCronSession`
  （DELETE /sessions/:id/chat，best-effort）。
- drain 状态扩展：`runningItem?: WakeItem`（在途项）、`redrivePending?: WakeItem`（被抢占待回队项）。
- drain 遇 `isLocked` 时：runningItem 缺失（锁被 renderer chat 等外部持有）→ 维持 park；
  `decidePreemption(head, runOriginOf(runningItem))` 为 preempt → 记 `redrivePending = runningItem`、
  调 `interruptRun`、break。runWake 返回后发现自己是被抢占项 → 以 `isRedriven: true` 重新入队
  （turnEpoch 清空由 enqueue 重盖当前值）。
- **收尾 epoch 护栏（P2.5 补全）**：runWake 返回后 `!turnEpochs.isCurrent(sessionId, item.turnEpoch)`
  → 跳过 DM auto-return 与错误上报（grok “旧回合收尾不 nudge 不上报”）。
- `runOriginOf(item)`：user lane → `user`；agent lane DM → `bot`；其余 → `background`。

## 3. 任务

- [x] **T1** `summaryRetry.ts` 纯函数 + 单测（错误分类 / shorter-output 追加 / tool 占比缩减 / 3 次上限 / fatal 直抛）。（✅ 2026-09-05；契约修正：空/退化结果耗尽后返回 ''（走 strategy 占位符），只有错误才抛——保持 loop-guards 既有测试的"空摘要不失败压缩"契约）
- [x] **T2** strategy 接线 ladder + `CompactOptions.force`（跳过 maxMessagesToKeep 早退，仍尊重无可压缩段）+ 单测。（✅ 2026-09-05）
- [x] **T3** `BackgroundPrefire` + CompactionManager（maybeStartPrefire / takePrefireSummary / 生命周期）+ controller 收割注入 + 单测（阈值触发 / 前缀有效收割 / prefix_invalid 丢弃 / in-flight 不重启 / 关闭开关）。（✅ 2026-09-05；收割 duck-type 可选调用，无 prefire 能力的 manager 兼容）
- [x] **T4** DuyaAgent 点火（proactive 检查点）+ 图片阈值两检查点（turn 开始 + mid-loop preflight）+ 计数纯函数单测。（✅ 2026-09-05 实现，**随 DuyaAgent.ts 待提交**，见下）
- [x] **T5** wake-dispatcher：deps.interruptRun + 抢占/redrive + 收尾 epoch 护栏 + 集成测试。（✅ 2026-09-05 实现，**随 wake-dispatcher.ts / wake-preemption.test.ts 待提交**，见下。语义决策：① 抢占判定在 **enqueue 时**触发（drain 阻塞在 await runWake 上等不到）；② 派发 user-lane wake **不**推进 epoch——保持 476/477 既有契约（P2.2 lane-order 测试），epoch 只在 lock:acquire userTurn=true 与抢占时推进；③ 收尾护栏比较"派发时 epoch vs 收尾时 epoch"（mid-run supersede 判定），排队期陈旧不影响 DM auto-return；④ redrive 项豁免 epoch 陈旧丢弃与 recently-dispatched 去重）
- [x] **T6** electron deps 接线（interruptRun → interruptCronSession，默认 deps 内）。（✅ 2026-09-05）
- [x] **T7** 验证：compact 全套 153/153 绿 + message/bot-prompt/journal 113/113 绿；`npx tsc -p packages/agent --noEmit` 干净；electron tsc 按触碰文件过滤无错误。ARCHITECTURE.md 更新见下。

## 3.1 提交状态（并行会话 WIP 隔离）

- **已提交**：`a20c0941 feat(agent): add background prefire, image trigger and summary retry ladder`
  （compact 模块 11 文件：summaryRetry / BackgroundPrefire / imageParts + 单测、strategy、
  types、index、CompactionManager、message-compaction-controller）。该子集自洽：
  HEAD 的 DuyaAgent 不引用新导出，master 上 typecheck/测试均绿。
- **工作区待提交**（与并行 Plan 497 WIP 同文件，不可单独提交）：
  `packages/agent/src/agent/DuyaAgent.ts`（prefire 点火 + 图片阈值两检查点），
  `electron/wake/wake-dispatcher.ts`（抢占/redrive/护栏 + interruptRun 接线），
  `electron/wake/__tests__/wake-preemption.test.ts`（4 项集成测试）。497 WIP 落地后随同提交。
- **预存失败（非本 plan 引入，HEAD 上即红）**：wake-dispatcher.test.ts 的 2 项 inbound 测试
  （"enqueues a channel inbound…" / "runs two same-lane items in FIFO order"）——HEAD 实现已将
  connector.inbound 改走 reviveForInbound（488 Plan B），测试仍期待 runWake 直派。归 488/497 修。

## 3.2 ARCHITECTURE.md

- [ ] 在 "Context Compaction (Plan 422)" 节补一段 Plan 495（prefire / image trigger / retry ladder）。
  ARCHITECTURE.md 当前有并行 WIP，随 497 落地一并提交。

## 4. 风险与边界

- 抢占只允许打断**本 dispatcher 启动的 wake run**（runningItem 归因）；renderer/用户 chat 持锁时永不抢占。
- prefire 为 best-effort：失败/指纹失效均静默清空，绝不阻塞主 turn。
- 工作区内 wake/ 与 DuyaAgent 有并行会话 WIP（489 handoff）：改动收敛在 drain 函数与既有检查点旁，
  提交用显式 pathspec，不触碰 untracked 文件。
