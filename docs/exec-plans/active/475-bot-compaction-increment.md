# 475 — 压缩策略增量（422 收口 + Bot 场景重注入 + Per-Bot Compact 配置）

> **Status**: Phase 1 ✅（2026-09-03）· Phase 2–4 待做 · **Priority**: P1 · **Owner**: TBD
> **总纲**: [473-grok-bot-framework-overview](./473-grok-bot-framework-overview.md)
> **前置**: plan 422（压缩全面对齐 grok）P1–P3 已基本完成；本 plan **不重做 422**，只做 bot 机制移植带来的增量 + 收口 422 尾巴 + **补齐压缩后处理链（2026-09-02 审计新增 Phase 4，术语锚点见 473 §2.5）**。
> **参考源码**：grok-bot `prompt-collector-glue.ts:147-161`（automation reminder 变化重注入）、`summarization-orchestrator.ts:726-768`（归档/自文档刷新/回执）、`user-message-action-handler.ts:215-296`（user_info 纪元重渲）、`agent-summarization/durable-blocks.ts`、`compaction_utils.rs`（grok-build 重建顺序）、`host/extensions/session/`（会话大小治理）

---

## 1. 背景

plan 422 已把 duya 压缩收敛为单一 grok 式策略：85% 阈值 + 75% prefire 两遍、重建顺序 `system→prefix→AGENTS.md→last_query→summary→reminder`、9 段总结 prompt、tool-call sanitize、错误分类抑制、input 阶梯、墙钟预算、独立 compact_model、内存冲刷。

bot 机制移植（473–478）引入三类新上下文，压缩后**必须重注入**，否则 bot 压缩后会"失忆自己是谁、找谁说话、有什么例行任务"：

1. bot 身份（474 的 identity/envelope 语义）
2. 通讯上下文（roster、未读 DM、群房间）
3. automation reminder（grok：仅内容变化或 epoch 推进时重注入）

## 2. 设计

### 2.1 压缩重建的 bot 段扩展

`SessionMemoryCompactStrategy` 重建序列在 422 版本之上扩展：

```
system → user_prefix → AGENTS.md → last_user_query → summary → system_reminder
                                                          ↑ bot 层插入：
   botIdentity（冻结快照渲染，含最新 profile update 状态摘要）
   botCommsRules（对齐 474 section）
   botRoster + 未处理 wake/DM 摘要（来自 476 pending queue 的存活项）
   botAutomations（当前绑定清单）
```

实现方式：`buildRebuiltContext` 增加可注入的 `postSummarySections: () => string[]` 钩子；普通会话返回 `[]`，bot 会话返回上述四段（渲染复用 474 的 section 模块与预算，保证压缩后与正常运行时提示词一致）。

### 2.2 automation reminder 变化检测

对齐 grok `prompt-collector-glue.ts:147-161`：

- 维护 `automationReminderFingerprint`（清单哈希）。
- 每轮比对：内容未变且 epoch 未推进 → 不重注入（省 token + 保 cache）；变化 → 重注入最新清单。
- 落点：agent-core 的 turn 准备阶段（与 476 的 wake prompt 组装同处）。

### 2.3 per-bot compact 配置

`[agents.<id>.compact]`：

```toml
[agents.<id>.compact]
model = "..."            # 独立 compact model（422 已有全局，这里 per-bot 覆盖）
retain_recent_tail = 0   # grok 默认丢弃 recent tail；bot 常驻会话可选保留
```

CompactionManager 读取顺序：session 覆盖 → bot 覆盖 → 全局。

### 2.4 422 收口（独立前置项）

- [x] **P3.4** segment/transcript 落盘恢复评估：duya 已有 rollout 全量保留（plan 441），结论预期是 **won't-fix（rollout 已覆盖）**，写决策记录即可。（✅ 2026-09-03：won't-fix 决策已记录于 [422 P3.4](../completed/422-compaction-strategy-consolidation.md)——rollout 441 全量保留 + CompactionEntry 已覆盖恢复路径，segment 双写冗余）
- [x] **G2** ARCHITECTURE.md 压缩章节更新 + 422 移入 `completed/`。（✅ 2026-09-03：ARCHITECTURE.md 新增 "Context Compaction (Plan 422)" 节；README completed 表登记；422 已归档）

### 2.5 压缩后处理链增量（2026-09-02 审计补，对齐总纲 473 §2.5.2 A2–A6）

> grok 压缩 persist 后还有一串「只在压缩后做一次」的动作，422 只对齐了重建顺序，本 plan 补齐其余。以下 A 编号对应总纲 473 §2.5.2 清单，属本 plan 的项在此给设计，跨 plan 的标注归属。

**A6 · user_info 整块重渲（最高优先级缺失项）**
- grok：压缩纪元推进（E1，`summaryArchives.length`）→ 下回合判定 `shouldRerenderUserInfoAfterSummarization`（旧纪元存在且新纪元更大）→ 整条 `<user_info>`（rules/MCP/git/self-document/AGENTS 等全部环境上下文）重生成替换旧 user_info 消息（`user-message-action-handler.ts:215-296`；execute-plan 路径同源 `:152-227`）。
- duya 落地：以压缩纪元（E1 计数，接线见 474 双键 `summaryEpoch`）为触发；在**普通回合与 wake run 的 turn 准备阶段**检查 epoch 推进 → 触发既有 user_info 渲染函数重跑一次并替换历史承载消息（duya 的 user_info 渲染现成，只需"纪元推进才重渲"的判定 + 替换动作）。
- 默认 feature flag `rerenderUserInfoOnSummarization` 开（对齐 grok 默认开启），per-bot 可关。

**A2 · named-agent 自文档刷新（`refreshNamedAgentSelfDocumentInMessages`）**
- grok：压缩 persist 时若存在 named-agent 自文档（`NAMED_AGENT_STORE_SELF_PATH` 的 `<agent_self_document>` 块），把最新版本重注入到 replacement 消息里的 user-info 承载者（`summarization-orchestrator.ts:754-765`）。
- duya 落地：bot 的 `[agents.<id>]` 若有自文档（identity 源文件），压缩重建后调既有注入函数刷新一次，失败保留陈旧副本。

**A3 · durable blocks 补齐**
- grok 七类块：mode-prompt / project-root / plan / transcript / automation-trigger / todos / skills（`durable-blocks.ts:20-41`）。
- duya 现状：422 重建序列只重注 system_reminder 一类。补齐优先级：`automation-trigger`（475 本来就要做）> `todos`（现有 todo 状态，计划 416 同源）> `plan`（execute-plan 场景）> `mode-prompt`（474/413 同源）> 其余按需。落在重建序列的 `postSummarySections` 或 system_reminder 扩展，实现时定。

**A4 · tokenDetails 置 stale**
- grok：turn-settle 检测 checkpoint 的 summaryArchives 计数增加 → tokenDetails 标 stale 剔出 checkpoint，直到下轮真实测量（`turn-settle.ts:197-229`）。
- duya 落地：duya 压缩已走 `applyCompactionResult` 落 CompactionEntry；检查落盘路径是否会把压缩前 token 计数写入，是则补"压缩后 tokenDetails stale"标记。**若 duya 压缩后必重新测量/不落 token 计数，判 won't-fix 写决策记录即可。**

**A5 · ask-question 回执保留**：duya 无 grok 的 ask-question 工具对等物 → **skip**（决策记录）。

> A1（SummaryArchive 归档）与 A7/A8/A9 的归属：A1 走 422 P3.4 决策；A7 在 474（压缩后折叠已补 §2.2）；A8 在 479；A9 已由本 plan §2.2 覆盖。

## 3. 分阶段实施

### Phase 1 — 前置收口
- [x] **P1.1** 422 P3.4 决策记录 + G2 文档 + 422 归档。（✅ 2026-09-03）

### Phase 2 — bot 重注入
- [x] **P2.1** `postSummarySections` 钩子 + 单测（普通会话空数组回归）。（✅ 2026-09-03。**实现位置修正**：422 现实架构无 `buildRebuiltContext`——重建/重注入落在 `MessageCompactionController.applyCompactionResult` 的 `reinjectedSystemMessages` 组装处（plan 315/422 timeline 桥接层），钩子以此为落点：`MessageCompactionControllerOptions.postSummarySections?: () => string[] | Promise<string[]>`，仅在真正产生 CompactionEntry 时调用，异常 WARN 隔离、空数组 no-op，结果追加进 `entry.reinjectedSystemMessages`（经 `extractLegacySystemSegments` 进 history-prefix 系统段）。单测 6 项：legacy 后追加 / async 钩子 / 无钩子回归 / 空数组 / 异常隔离 / 无压缩不调用，23/23 绿）
- [ ] **P2.2** 四个 bot 段渲染接入 → **审计降级（2026-09-03）**：474 §7.6 已把 bot identity/roster 段挂进 `_buildSystemPrompt` 尾部**每轮重建**，压缩后 system prompt 天然含这些段，再注入会重复。原目标"压缩后不失忆身份/可通讯对象"已被 474 接线覆盖，本项无需实现；history 层真正丢失的 bot 状态只剩 wake/DM pending（P2.3）与 automation reminder（P3.1）。
- [ ] **P2.3** 未处理 wake/DM 摘要（依赖 476 pending queue 的只读快照接口；落点 = P2.1 钩子的 bot 会话实现，经 `postSummarySections` 返回）。

### Phase 3 — reminder 指纹 + per-bot 配置
- [ ] **P3.1** automationReminderFingerprint + 单测（不变不注入 / 变化注入 / epoch 推进注入）。
- [ ] **P3.2** `[agents.<id>.compact]` toml + CompactionManager 读取链 + 单测。

### Phase 4 — 压缩后处理链（2026-09-02 审计补）
- [ ] **P4.1** 压缩纪元接线：E1 计数（summaryArchives 对等物）贯通到 474 `summaryEpoch`，压缩 persist 处 +1 + 单测。
- [ ] **P4.2** user_info 整块重渲（A6）：纪元推进判定 + 重渲替换历史承载消息 + `rerenderUserInfoOnSummarization` flag；单测（不推进不重渲 / 推进重渲 / flag 关不重渲）。
- [ ] **P4.3** named-agent 自文档刷新（A2）+ 单测（有自文档刷新 / 缺失保陈旧）。
- [ ] **P4.4** durable blocks 补齐（A3）：automation-trigger/todos 先落地 + 单测；plan/mode-prompt 视依赖排期。
- [ ] **P4.5** tokenDetails stale 决策（A4）+ 决策记录（won't-fix 或实现）；A5 skip 决策记录。

> **A4 决策记录（2026-09-03）：won't-fix**。grok 的问题是 checkpoint 携带压缩前 tokenDetails 并被复用为当前上下文大小；duya 无此路径：① `CompactionEntry.tokensBefore/tokensAfter` 在压缩时**新鲜计算**（`estimateMessagesTokens(inputMessages)`，message-compaction-controller.ts:303），非沿用旧 checkpoint；② API 锚点 `observedPromptTokens` 在压缩成功后立即 `clearObservedPromptTokens()`（CompactionManager.ts:377），旧锚点不污染压缩后阈值判定；③ 这两个计数的全部消费方均为日志/UI 统计（DuyaAgent.ts:1506/1521/2196/2451/4153），不参与 `shouldCompact` 预算判定（实时投影估算）。压缩后"必重新测量"语义由锚点清零 + 实时估算天然保证。
>
> **A5 决策记录（2026-09-03）：skip**。duya 无 grok 的 ask-question 工具对等物（工具目录无 ask-question/AskQuestion；forkSubagent 中的匹配为子代理 fork 语义，非用户回执机制），无回执可保留。
- [ ] **P4.6** checkpoint↔transcript 事务边界核对（2026-09-02 完整性审计并入：C13）——对齐 grok `turn-settle.ts` 的 prepare→abort→commit（append 失败抛 `TranscriptAppendAfterCheckpointError`，杜绝"checkpoint 已存但 UI 无消息"）。duya 侧核对 441 journal 与 CompactionEntry 落盘的先后与失败语义：压缩 checkpoint 提交与消息持久化是否在同一事务边界内、失败如何回滚。**预期结论是 duya 的 441 事件 journal 已覆盖消息层**——本任务做核对 + 写决策记录（won't-fix 或补 abort 语义），不默认新做一套。

### 验收
- [ ] bot 会话压缩后首轮回复仍能正确自述身份、列出可通讯对象与例行任务（人工 e2e）。
- [ ] reminder 未变化时无重复注入（rollout 事件审计）。
- [ ] 压缩推进纪元后，下回合 user_info 被重渲一次（rollout 事件审计：新 user_info 消息替换旧承载者）；未压缩时无重渲。
- [ ] `npm run typecheck:all` + compact 相关单测全绿。

## 4. 风险

- **风险**：压缩后 bot 段与 474 正常渲染漂移 → 单一渲染函数复用 + 快照 diff 工具（474 G2）核对。
- **风险**：wake/DM 摘要过长挤占预算 → 摘要走 SectionBudget，只保留 top-N 待处理项。
- **回滚**：`postSummarySections` 返回空数组即回到 422 行为。
